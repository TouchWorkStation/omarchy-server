// NAS for omarchyd: drives and their health, Btrfs pools, drive sleep, and network (SMB) shares.
// Reading drive layout needs no privileges (lsblk, /etc/fstab). Anything that needs root goes through
// the Omarchy Server helper (helper/helper.mjs, installed root-owned, allowed by one sudoers rule),
// which re-checks every request itself.
import {execFile} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {readFile, rename, statfs, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'

import {RpcError} from './rpc.mjs'

export const HELPER = '/usr/local/libexec/omarchy-server/helper.mjs'
const FSTAB_MARK = '# omarchy-server pool'
const NAME = /^[a-z][a-z0-9-]{0,31}$/
const SYSTEM_MOUNTS = new Set(['/', '/boot', '/efi', '/boot/efi', '/home', '/var', '/usr', '[SWAP]'])

function execP(cmd, args, {input, timeout = 10 * 60_000} = {}) {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, {timeout, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
			if (error) {
				const e = new Error((stderr || error.message).toString().trim().split('\n')[0])
				e.code = error.code
				return reject(e)
			}
			resolve(stdout.toString())
		})
		if (input !== undefined) child.stdin.end(input)
	})
}
const flat = (d) => [d, ...(d.children ?? []).flatMap(flat)]
const truthy = (v) => v === true || v === 1 || v === '1'

export function createStorage({dataDir, home = os.homedir(), files, run = execP, fstabPath = '/etc/fstab', user = os.userInfo().username}) {
	const sharesFile = join(dataDir, 'shares.json')
	const sleepFile = join(dataDir, 'drive-sleep.json')
	const passwordFile = join(dataDir, 'share-password')
	const smartCache = new Map() // path -> {at, value}

	const helper = async (verb, args = [], input) => {
		try {
			return (await run('sudo', ['-n', HELPER, verb, ...args], {input})).trim()
		} catch (error) {
			// The helper's own messages are written for people; pass them on.
			throw new RpcError('PRECONDITION_FAILED', /a password is required|not allowed|no such file|command not found/i.test(error.message) ? 'Storage tools aren’t set up. Run the Omarchy Server installer again.' : error.message)
		}
	}
	const readJson = async (file, fallback) => JSON.parse(await readFile(file, 'utf8').catch(() => JSON.stringify(fallback)))
	const writeJson = async (file, value) => {
		await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), {mode: 0o600})
		await rename(`${file}.tmp`, file)
	}

	async function blockDevices() {
		const j = JSON.parse(await run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,FSTYPE,LABEL,UUID,MOUNTPOINTS,RM,HOTPLUG']))
		return (j.blockdevices ?? []).filter((d) => d.type === 'disk' && !/^(zram|loop|sr|ram)/.test(d.name) && Number(d.size) > 0)
	}
	async function fstabPools() {
		const text = await readFile(fstabPath, 'utf8').catch(() => '')
		return text
			.split('\n')
			.filter((l) => l.includes(FSTAB_MARK))
			.map((l) => ({uuid: /^UUID=(\S+)/.exec(l)?.[1], mountpoint: l.split(/\s+/)[1], name: l.slice(l.indexOf(FSTAB_MARK) + FSTAB_MARK.length).trim()}))
			.filter((p) => p.uuid && NAME.test(p.name))
	}

	// SMART summary, normalised across SATA and NVMe.
	async function health(path) {
		const hit = smartCache.get(path)
		if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value
		let value = null
		try {
			const j = JSON.parse(await helper('smart', [path]))
			const attrs = Object.fromEntries((j.ata_smart_attributes?.table ?? []).map((a) => [a.id, a.raw?.value]))
			const nvme = j.nvme_smart_health_information_log
			value = {
				passed: j.smart_status?.passed ?? null,
				temperature: j.temperature?.current ?? nvme?.temperature ?? null,
				powerOnHours: j.power_on_time?.hours ?? nvme?.power_on_hours ?? null,
				lifetimeUsed: nvme?.percentage_used ?? null,
				reallocated: attrs[5] ?? null,
				pending: attrs[197] ?? null,
			}
		} catch {}
		smartCache.set(path, {at: Date.now(), value})
		return value
	}

	async function disks() {
		const [devs, pools, sleep, helperOk] = await Promise.all([blockDevices(), fstabPools(), readJson(sleepFile, {}), status().then((s) => s.helperAvailable)])
		const poolByUuid = new Map(pools.map((p) => [p.uuid, p.name]))
		return Promise.all(
			devs.map(async (d) => {
				const all = flat(d)
				const mounts = all.flatMap((x) => (x.mountpoints ?? []).filter(Boolean))
				const btrfs = all.find((x) => x.fstype === 'btrfs')
				const pool = btrfs ? (poolByUuid.get(btrfs.uuid) ?? null) : null
				const system = mounts.some((m) => SYSTEM_MOUNTS.has(m))
				const blank = !d.fstype && !(d.children ?? []).length && !mounts.length
				const nvme = d.tran === 'nvme' || d.name.startsWith('nvme')
				return {
					path: d.path,
					name: d.name,
					model: (d.model ?? '').trim() || null,
					serial: d.serial ?? null,
					size: Number(d.size),
					kind: nvme ? 'nvme' : truthy(d.rota) ? 'hdd' : 'ssd',
					transport: d.tran ?? null,
					removable: truthy(d.rm) || truthy(d.hotplug),
					role: system ? 'system' : pool ? 'pool' : blank ? 'blank' : 'data',
					pool,
					btrfs: btrfs && !pool ? {uuid: btrfs.uuid, label: btrfs.label ?? null, mounted: !!(btrfs.mountpoints ?? []).some(Boolean)} : null,
					sleepMinutes: d.serial && sleep[d.serial] !== undefined ? sleep[d.serial] : null,
					health: helperOk ? await health(d.path) : null,
				}
			}),
		)
	}

	async function pools() {
		const [devs, list] = await Promise.all([blockDevices(), fstabPools()])
		return Promise.all(
			list.map(async (p) => {
				const members = devs.filter((d) => flat(d).some((x) => x.uuid === p.uuid)).map((d) => d.path)
				const mounted = devs.flatMap(flat).some((x) => x.uuid === p.uuid && (x.mountpoints ?? []).includes(p.mountpoint))
				let size = null
				let free = null
				if (mounted) {
					const s = await statfs(p.mountpoint).catch(() => null)
					if (s) (size = s.blocks * s.bsize), (free = s.bavail * s.bsize)
				}
				let detail = null
				if (mounted) detail = await helper('pool-status', [p.name]).then((t) => JSON.parse(t), () => null)
				const errors = detail ? Object.values(detail.devices).reduce((n, d) => n + Object.values(d).reduce((a, b) => a + b, 0), 0) : 0
				return {name: p.name, uuid: p.uuid, mountpoint: p.mountpoint, folder: `/Home/Pools/${p.name}`, mounted, devices: members, size, free, profile: detail?.profile ?? null, errors, scrub: detail?.scrub ?? null}
			}),
		)
	}

	async function importable() {
		const [devs, list] = await Promise.all([blockDevices(), fstabPools()])
		const known = new Set(list.map((p) => p.uuid))
		const byUuid = new Map()
		for (const d of devs)
			for (const x of flat(d))
				if (x.fstype === 'btrfs' && x.uuid && !known.has(x.uuid) && !(x.mountpoints ?? []).some(Boolean)) {
					const e = byUuid.get(x.uuid) ?? {uuid: x.uuid, label: x.label ?? null, devices: []}
					e.devices.push(x.path)
					byUuid.set(x.uuid, e)
				}
		return [...byUuid.values()]
	}

	let statusCache = null
	async function status() {
		if (statusCache && Date.now() - statusCache.at < 30_000) return statusCache.value
		const helperAvailable = await run('sudo', ['-n', HELPER, 'ping']).then((t) => t.trim() === 'ok', () => false)
		statusCache = {at: Date.now(), value: {helperAvailable}}
		return statusCache.value
	}

	// ---- shares -----------------------------------------------------------------------------------
	async function shareList() {
		const shares = await readJson(sharesFile, [])
		return Promise.all(
			shares.map(async (s) => ({
				name: s.name,
				path: s.path,
				sharename: s.name,
				available: await files.resolve(s.path).then(() => true, () => false),
			})),
		)
	}
	async function applyShares(shares) {
		const out = []
		for (const s of shares) {
			const r = await files.resolve(s.path).catch(() => null)
			if (r && r.top === 'Home') out.push({name: s.name, path: r.real, readOnly: !!s.readOnly})
		}
		await helper('shares-apply', [], JSON.stringify({shares: out}))
	}
	async function sharePassword() {
		try {
			return (await readFile(passwordFile, 'utf8')).trim()
		} catch {
			const words = Array.from({length: 4}, () => randomBytes(3).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 4))
			const pw = words.join('-')
			await helper('smb-password', [], `${pw}\n`)
			await writeFile(passwordFile, pw, {mode: 0o600})
			return pw
		}
	}

	return {
		procedures: {
			'storage.status': {kind: 'query', run: status},
			'storage.disks': {kind: 'query', run: disks},
			'storage.pools': {kind: 'query', run: pools},
			'storage.importable': {kind: 'query', run: importable},
			'storage.createPool': {
				kind: 'mutation',
				run: async (input) => {
					const name = String(input?.name ?? '')
					const devices = Array.isArray(input?.devices) ? input.devices.map(String) : []
					if (!NAME.test(name)) throw new RpcError('BAD_REQUEST', 'Pool names use a-z, 0-9 and -, starting with a letter')
					await helper('pool-create', [name, String(input?.profile ?? ''), ...devices])
					return true
				},
			},
			'storage.addToPool': {kind: 'mutation', run: async (input) => (await helper('pool-add', [String(input?.name ?? ''), String(input?.device ?? '')]), true)},
			'storage.importPool': {kind: 'mutation', run: async (input) => (await helper('pool-import', [String(input?.name ?? ''), String(input?.uuid ?? '')]), true)},
			'storage.forgetPool': {kind: 'mutation', run: async (input) => (await helper('pool-forget', [String(input?.name ?? '')]), true)},
			'storage.scrub': {kind: 'mutation', run: async (input) => (await helper('pool-scrub', [String(input?.name ?? '')]), true)},
			'storage.setSleep': {
				kind: 'mutation',
				run: async (input) => {
					const device = String(input?.device ?? '')
					const minutes = Number(input?.minutes)
					await helper('sleep', [device, String(minutes)])
					const d = (await blockDevices()).find((x) => x.path === device)
					if (d?.serial) {
						const sleep = await readJson(sleepFile, {})
						sleep[d.serial] = minutes
						await writeJson(sleepFile, sleep)
					}
					return true
				},
			},
			'files.shares': {kind: 'query', run: shareList},
			'files.sharePassword': {kind: 'query', run: sharePassword},
			'files.addShare': {
				kind: 'mutation',
				run: async (input) => {
					const path = String(input?.path ?? '')
					const r = await files.resolve(path)
					if (r.top !== 'Home' || path === '/Home') throw new RpcError('BAD_REQUEST', 'Choose a folder inside Home to share')
					const shares = await readJson(sharesFile, [])
					if (shares.some((s) => s.path === path)) return true
					const base = (path.split('/').pop() || 'Share').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 28) || 'Share'
					let name = base
					for (let n = 2; shares.some((s) => s.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} ${n}`
					const next = [...shares, {name, path}]
					await sharePassword()
					await applyShares(next)
					await writeJson(sharesFile, next)
					return true
				},
			},
			'files.removeShare': {
				kind: 'mutation',
				run: async (input) => {
					const next = (await readJson(sharesFile, [])).filter((s) => s.path !== String(input?.path ?? ''))
					await applyShares(next)
					await writeJson(sharesFile, next)
					return true
				},
			},
		},
		firewall: {
			open: (port) => helper('firewall-open', [String(port)]).catch(() => {}),
			close: (port) => helper('firewall-close', [String(port)]).catch(() => {}),
		},
	}
}
