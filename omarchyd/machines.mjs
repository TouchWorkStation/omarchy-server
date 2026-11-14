// Virtual machines for omarchyd, on libvirt's per-user session (qemu:///session).
//
// Why the session and not qemu:///system: QEMU then runs as the owner's own user, like the rest
// of omarchyd, so nothing here needs root or the libvirt group (which is root-equivalent).
// Networking is passt (user-mode): each machine shares the host's address, and port forwards
// open ports on the host that lead into it. The screen is VNC on a unix socket in the machine's
// own folder, never on a TCP port; omarchyd bridges it to the web app's console.
//
// Operating systems come from a catalog (TouchWorkStation/app-store, machines/catalog.json, with
// a bundled copy as fallback). Images are cloud images: downloaded from the publisher, checked
// against the publisher's checksum file, then copied per machine. cloud-init sets up the account
// on first boot; only a SHA-512 crypt hash of the password is written, never the password.
import {execFile} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import {constants, createWriteStream} from 'node:fs'
import {access, copyFile, mkdir, readFile, readdir, rename, rm, statfs, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {basename, join} from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {fileURLToPath} from 'node:url'

import {PUBLIC_KEY, cloudMetaData, cloudUserData, hostnameFor, isWindowsClientLabel, isWindowsLabel, omarchyConfiguration, omarchyCredentials, windowsAnswerFile} from './machine-media.mjs'
import {RpcError} from './rpc.mjs'

export const CATALOG_URL = 'https://raw.githubusercontent.com/TouchWorkStation/app-store/main/machines/catalog.json'
const BUNDLED_CATALOG = fileURLToPath(new URL('./machine-catalog.json', import.meta.url))
const CATALOG_TTL = 6 * 60 * 60 * 1000
export const PORT_MIN = 40_000
export const PORT_MAX = 49_999
const LIBVIRT = 'qemu:///session'
const ID = /^[a-f0-9]{8}$/

function execP(cmd, args, {input, cwd, timeout = 120_000} = {}) {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, {cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: {...process.env, LC_ALL: 'C'}}, (error, stdout, stderr) => {
			if (error) {
				error.message = `${cmd} ${args[0] ?? ''}: ${(stderr || error.message).toString().trim().split('\n').slice(-2).join(' ')}`
				return reject(error)
			}
			resolve(stdout.toString())
		})
		if (input !== undefined) child.stdin.end(input)
	})
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'})[c])
const hostArch = () => (os.arch() === 'arm64' ? 'arm64' : 'amd64')

// Find the expected hash for `file` in a checksum file. Handles GNU (`hash  file`, `hash *file`)
// and BSD (`SHA256 (file) = hash`) layouts.
export function findChecksum(text, file, algorithm) {
	const len = algorithm === 'sha512' ? 128 : 64
	for (const raw of text.split('\n')) {
		const line = raw.trim()
		let m = /^([0-9a-fA-F]+)\s+\*?(.+)$/.exec(line)
		if (m && basename(m[2].trim()) === file && m[1].length === len) return m[1].toLowerCase()
		m = /^SHA\d+\s*\((.+)\)\s*=\s*([0-9a-fA-F]+)$/.exec(line)
		if (m && basename(m[1]) === file && m[2].length === len) return m[2].toLowerCase()
	}
	return null
}

function validCatalog(data) {
	if (!data || data.version !== 1 || !Array.isArray(data.images)) return null
	const ok = data.images.filter(
		(i) =>
			i &&
			/^[a-z0-9][a-z0-9.-]{1,63}$/.test(i.id) &&
			typeof i.name === 'string' &&
			/^https:\/\//.test(i.url) &&
			((/^https:\/\//.test(i.checksums?.url ?? '') && ['sha256', 'sha512'].includes(i.checksums?.algorithm)) || /^[0-9a-f]{64}$/i.test(i.sha256 ?? '')) &&
			['amd64', 'arm64'].includes(i.arch) &&
			(i.kind === 'cloud' || (i.kind === 'iso' && i.install === 'omarchy')),
	)
	return ok.length ? ok : null
}

export function createMachines({dataDir, catalogUrl = CATALOG_URL, fetchImpl = fetch, run = execP, kvmDevice = '/dev/kvm', bundledCatalog = BUNDLED_CATALOG, files = null}) {
	const base = join(dataDir, 'machines')
	const imagesDir = join(base, 'images')
	const vmsDir = join(base, 'vms')
	const stateFile = join(base, 'machines.json')
	const virsh = (...args) => run('virsh', ['-c', LIBVIRT, ...args])
	const domain = (id) => `omarchy-${id}`

	let machines = [] // persisted metadata, never secrets
	const busy = new Map() // id -> {state, progress, settling}
	const isBusy = (id) => busy.has(id) && !busy.get(id).settling
	const downloads = new Map() // imageId -> {progress, promise}
	const failedImages = new Map() // imageId -> message
	let catalog = {at: 0, images: null}

	const ready = (async () => {
		await mkdir(imagesDir, {recursive: true, mode: 0o700})
		await mkdir(vmsDir, {recursive: true, mode: 0o700})
		try {
			machines = JSON.parse(await readFile(stateFile, 'utf8')).machines ?? []
		} catch {}
		// A create that was interrupted by a restart can't resume: show it as failed.
		// Machines from before 0.6.1 asked for a virtio display, which QEMU on Arch only has with an
		// extra package: use the built-in standard VGA instead.
		for (const m of machines) if (m.layout?.video === 'virtio') m.layout.video = 'vga'
		for (const m of machines) if (m.state === 'installing') Object.assign(m, {state: 'error', errorMessage: 'Setup was interrupted. Delete this machine and create it again.'})
		for (const m of machines) normalize(m)
		await save().catch(() => {})
		startSampler()
		autostart()
	})()
	const save = async () => {
		const tmp = `${stateFile}.${process.pid}.tmp`
		await writeFile(tmp, JSON.stringify({machines}, null, 2), {mode: 0o600})
		await rename(tmp, stateFile)
	}
	const find = (id) => {
		const m = typeof id === 'string' && ID.test(id) ? machines.find((x) => x.id === id) : null
		if (!m) throw new RpcError('NOT_FOUND', 'That machine doesn’t exist')
		return m
	}

	// ---- catalog --------------------------------------------------------------------------------
	async function images() {
		if (catalog.images && Date.now() - catalog.at < CATALOG_TTL) return catalog.images
		let list = null
		try {
			const res = await fetchImpl(catalogUrl, {signal: AbortSignal.timeout(8000)})
			if (res.ok) list = validCatalog(await res.json())
		} catch {}
		if (!list) list = validCatalog(JSON.parse(await readFile(bundledCatalog, 'utf8')))
		catalog = {at: Date.now(), images: list}
		return list
	}
	const imagePath = (img) => join(imagesDir, `${img.id}.${img.kind === 'iso' ? 'iso' : 'qcow2'}`)
	const exists = (p) => access(p).then(() => true, () => false)

	async function osImages() {
		const out = []
		for (const img of await images()) {
			if (img.arch !== hostArch()) continue // only what this server can run
			const dl = downloads.get(img.id)
			const state = dl ? 'downloading' : (await exists(imagePath(img))) ? 'downloaded' : failedImages.has(img.id) ? 'failed' : 'available'
			out.push({
				id: img.id,
				familyId: img.familyId ?? img.id.split('-')[0],
				name: img.name,
				...(img.variantName ? {variantName: img.variantName} : {}),
				version: String(img.version ?? ''),
				sizeMb: Number(img.sizeMb) || 0,
				arch: img.arch,
				platform: 'linux',
				requiresCredentials: true,
				...(img.install === 'omarchy' ? {manualSetup: false} : {}),
				state,
				...(dl ? {downloadProgress: dl.progress} : {}),
			})
		}
		return out
	}

	// Download an image once (concurrent callers share it) and verify it against the publisher.
	function ensureImage(img, onProgress = () => {}) {
		const running = downloads.get(img.id)
		if (running) return running.promise
		const entry = {progress: 0, promise: null}
		entry.promise = (async () => {
			const target = imagePath(img)
			if (await exists(target)) return target
			// Either a checksum pinned in the catalog, or the publisher's own checksum list.
			let expected = img.sha256?.toLowerCase() ?? null
			const algorithm = expected ? 'sha256' : img.checksums.algorithm
			if (!expected) {
				const sums = await fetchImpl(img.checksums.url, {signal: AbortSignal.timeout(30_000)})
				if (!sums.ok) throw new Error(`Couldn’t get the checksum list for ${img.name} (HTTP ${sums.status})`)
				expected = findChecksum(await sums.text(), basename(new URL(img.url).pathname), algorithm)
				if (!expected) throw new Error(`${img.name}’s checksum list doesn’t include this image`)
			}
			const res = await fetchImpl(img.url)
			if (!res.ok || !res.body) throw new Error(`Couldn’t download ${img.name} (HTTP ${res.status})`)
			const total = Number(res.headers.get('content-length')) || (Number(img.sizeMb) || 0) * 1024 * 1024
			const hash = createHash(algorithm)
			let got = 0
			const part = `${target}.part`
			const body = Readable.fromWeb(res.body)
			body.on('data', (chunk) => {
				hash.update(chunk)
				got += chunk.length
				if (total) {
					entry.progress = Math.min(99, Math.floor((got / total) * 100))
					onProgress(entry.progress)
				}
			})
			try {
				await pipeline(body, createWriteStream(part, {mode: 0o600}))
				if (hash.digest('hex') !== expected) throw new Error(`${img.name} didn’t match its publisher’s checksum, so it was discarded. Try again later.`)
				await rename(part, target)
			} catch (error) {
				await rm(part, {force: true})
				throw error
			}
			return target
		})()
		downloads.set(img.id, entry)
		entry.promise.then(
			() => (downloads.delete(img.id), failedImages.delete(img.id)),
			(e) => (downloads.delete(img.id), failedImages.set(img.id, e.message)),
		)
		return entry.promise
	}

	// ---- libvirt --------------------------------------------------------------------------------
	async function capabilities() {
		const has = async (cmd, args) => run(cmd, args).then(() => true, () => false)
		const libvirtAvailable = (await has('virsh', ['--version'])) && (await has('qemu-img', ['--version']))
		const kvmAvailable = await access(kvmDevice, constants.R_OK | constants.W_OK).then(() => true, () => false)
		return {
			hostArchitecture: hostArch(),
			libvirtAvailable,
			kvmAvailable,
			...(libvirtAvailable && !kvmAvailable ? {performanceWarning: 'Hardware virtualization (KVM) isn’t available, so machines run much slower. Turn on VT-x/AMD-V in the BIOS, or nested virtualization if this is itself a VM.'} : {}),
		}
	}

	async function domainStates() {
		const out = new Map()
		try {
			const text = await virsh('list', '--all')
			for (const line of text.split('\n').slice(2)) {
				const m = /^\s*(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
				if (m) out.set(m[2], m[3])
			}
		} catch {}
		return out
	}
	const STATE = {running: 'running', 'shut off': 'stopped', paused: 'suspended', pmsuspended: 'suspended', 'in shutdown': 'stopping', crashed: 'error', blocked: 'running'}

	// How a machine is wired: firmware, drives and devices. Stored with the machine so a changed
	// setting can rebuild the same definition. Every drive has an id ("disk0", "cd0"…, "seed" for
	// cloud-init, "answer" for Windows Setup); the boot order lists ids (and "net" for network boot).
	function layoutFor(kind, dir, img) {
		const disk = {id: 'disk0', file: join(dir, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2'}
		if (kind === 'cloud') return {firmware: img?.firmware === 'efi' ? 'efi' : 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [disk, {id: 'seed', role: 'seed', file: join(dir, 'seed.iso'), device: 'cdrom', bus: 'sata', format: 'raw'}]}
		// Windows installs without extra drivers on SATA, e1000e and a standard display.
		if (kind === 'windows') return {firmware: 'efi', machineType: 'q35', nic: 'e1000e', video: 'vga', disks: [{...disk, bus: 'sata'}]}
		return {firmware: 'efi', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [disk]}
	}
	const randomMac = () => `52:54:00:${[...randomBytes(3)].map((b) => b.toString(16).padStart(2, '0')).join(':')}`
	const nextVmid = () => {
		let n = 100
		while (machines.some((x) => x.vmid === n)) n++
		return n
	}
	// Machines from earlier versions get the settings newer ones have, unchanged in effect.
	function normalize(m) {
		m.vmid ??= nextVmid()
		m.sockets ??= 1
		m.memoryMb ??= (Number(m.memoryGb) || 1) * 1024
		m.cpuType ??= 'host'
		m.options ??= {}
		m.tasks ??= []
		m.snapshots ??= []
		m.mac ??= randomMac()
		if (m.layout) {
			m.layout.machineType ??= 'q35'
			let disks = 0
			let cds = 0
			for (const d of m.layout.disks) {
				if (d.id) continue
				if (/seed\.iso$/.test(d.file)) Object.assign(d, {id: 'seed', role: 'seed'})
				else if (/answer\.iso$/.test(d.file)) Object.assign(d, {id: 'answer', role: 'answer'})
				else d.id = d.device === 'cdrom' ? `cd${cds++}` : `disk${disks++}`
			}
			if (!m.boot) {
				const ordered = m.layout.disks.filter((d) => d.bootOrder).sort((a, b) => a.bootOrder - b.bootOrder)
				m.boot = ordered.length ? ordered.map((d) => d.id) : [m.layout.disks.find((d) => d.device === 'disk')?.id ?? 'disk0']
			}
			for (const d of m.layout.disks) delete d.bootOrder
			const first = m.layout.disks.find((d) => d.device === 'disk')
			if (first && first.sizeGb === undefined) first.sizeGb = m.diskSizeGb
		}
		m.memoryGb = Math.max(1, Math.round(m.memoryMb / 1024))
		return m
	}
	// Device names inside the machine, the same each time for the same layout.
	function targets(layout) {
		let sd = 0
		let vd = 0
		let hd = 0
		const out = new Map()
		const letter = (n) => String.fromCharCode(97 + n)
		for (const d of layout.disks) out.set(d.id, d.bus === 'virtio' ? `vd${letter(vd++)}` : d.bus === 'ide' ? `hd${letter(hd++)}` : `sd${letter(sd++)}`)
		return out
	}
	const CPU_TYPES = ['host', 'host-model', 'max', 'qemu64']
	const NICS = ['virtio', 'e1000e', 'e1000', 'rtl8139']
	const CACHES = ['default', 'none', 'writeback', 'writethrough', 'directsync', 'unsafe']
	const BUSES = ['virtio', 'sata', 'scsi', 'ide']
	function domainXml(m, kvm) {
		const dir = join(vmsDir, m.id)
		const layout = m.layout ?? layoutFor('cloud', dir)
		const o = m.options ?? {}
		const useKvm = kvm && o.kvm !== false
		const boot = m.boot ?? [layout.disks.find((x) => x.device === 'disk')?.id]
		const order = (id) => (boot.includes(id) ? `<boot order='${boot.indexOf(id) + 1}'/>` : '')
		const names = targets(layout)
		const forwards = (m.portForwards ?? [])
			.map((f) => `<portForward proto='${f.protocol}'><range start='${f.hostPort}' to='${f.guestPort}'/></portForward>`)
			.join('')
		const disks = layout.disks
			.map((d) => {
				const cdrom = d.device === 'cdrom'
				const cache = d.cache && d.cache !== 'default' ? ` cache='${d.cache}'` : ''
				const discard = !cdrom && d.discard !== false ? " discard='unmap'" : ''
				const source = d.file ? `<source file='${xml(d.file)}'/>` : ''
				return `<disk type='file' device='${d.device}'><driver name='qemu' type='${d.format}'${cache}${discard}/>${source}<target dev='${names.get(d.id)}' bus='${d.bus}'/>${order(d.id)}${cdrom ? '<readonly/>' : ''}</disk>`
			})
			.join('\n    ')
		const scsi = layout.disks.some((d) => d.bus === 'scsi') ? "\n    <controller type='scsi' model='virtio-scsi'/>" : ''
		const machine = layout.machineType === 'pc' ? 'pc' : 'q35'
		const bootmenu = o.bootMenu ? "<bootmenu enable='yes' timeout='3000'/>" : ''
		const os =
			layout.firmware === 'efi'
				? `<os firmware='efi'><type arch='x86_64' machine='${machine}'>hvm</type><firmware><feature enabled='no' name='secure-boot'/></firmware>${bootmenu}</os>`
				: `<os><type arch='x86_64' machine='${machine}'>hvm</type>${bootmenu}</os>`
		const sockets = m.sockets ?? 1
		const topology = `<topology sockets='${sockets}' dies='1' cores='${m.cores}' threads='1'/>`
		const cpuType = m.cpuType ?? 'host'
		const cpu =
			useKvm && cpuType === 'host'
				? `<cpu mode='host-passthrough'>${topology}</cpu>`
				: useKvm && cpuType === 'host-model'
					? `<cpu mode='host-model'>${topology}</cpu>`
					: cpuType === 'max'
						? `<cpu mode='maximum'>${topology}</cpu>`
						: cpuType === 'qemu64'
							? `<cpu mode='custom' match='exact'><model fallback='allow'>qemu64</model>${topology}</cpu>`
							: `<cpu>${topology}</cpu>`
		const memoryMb = m.memoryMb ?? (m.memoryGb ?? 1) * 1024
		const nic = `<interface type='user'><backend type='passt'/><mac address='${m.mac}'/><model type='${layout.nic}'/>${m.linkDown ? "<link state='down'/>" : ''}${forwards}${order('net')}</interface>`
		return `<domain type='${useKvm ? 'kvm' : 'qemu'}'>
  <name>${domain(m.id)}</name>
  <title>${xml(m.name)}</title>${o.notes ? `\n  <description>${xml(o.notes)}</description>` : ''}
  <memory unit='MiB'>${memoryMb}</memory>
  <vcpu>${sockets * m.cores}</vcpu>
  ${os}
  <features>${o.acpi === false ? '' : '<acpi/>'}<apic/></features>
  ${cpu}
  <on_reboot>restart</on_reboot>
  <devices>
    ${disks}${scsi}
    ${nic}
    <serial type='pty'/><console type='pty'/>
    <graphics type='vnc' socket='${xml(join(dir, 'vnc.sock'))}'/>
    <video><model type='${layout.video}'/></video>${o.tablet === false ? '' : "\n    <input type='tablet' bus='usb'/>"}${o.agent ? "\n    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>" : ''}
    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>
  </devices>
</domain>
`
	}
	async function define(m) {
		const file = join(vmsDir, m.id, 'domain.xml')
		const kvm = await access(kvmDevice, constants.R_OK | constants.W_OK).then(() => true, () => false)
		await writeFile(file, domainXml(m, kvm), {mode: 0o600})
		await virsh('define', file)
	}

	const hashPassword = async (password) => {
		const hash = (await run('openssl', ['passwd', '-6', '-stdin'], {input: `${password}\n`})).trim()
		if (!/^\$6\$/.test(hash)) throw new Error('Couldn’t hash the password')
		return hash
	}
	// Write `files` into a small ISO labelled `label` in the machine's folder.
	async function mediaIso(m, name, label, files) {
		const dir = join(vmsDir, m.id)
		const work = join(dir, `${name}.d`)
		await rm(work, {recursive: true, force: true})
		await mkdir(work, {recursive: true, mode: 0o700})
		for (const [f, text] of Object.entries(files)) await writeFile(join(work, f), text, {mode: 0o600})
		await run('xorriso', ['-as', 'mkisofs', '-quiet', '-output', join(dir, `${name}.iso`), '-volid', label, '-joliet', '-rock', ...Object.keys(files)], {cwd: work})
		await rm(work, {recursive: true, force: true})
		return join(dir, `${name}.iso`)
	}
	// cloud-init NoCloud seed: account, hostname, and for desktops their packages. Only a hash of
	// the password is written.
	async function seed(m, img, {username, password}) {
		const host = hostnameFor(m.name, m.id)
		const hash = await hashPassword(password)
		await mediaIso(m, 'seed', 'cidata', {'user-data': cloudUserData({host, username, hash, cloudInit: {adminGroup: img.adminGroup, ...img.cloudInit}}), 'meta-data': cloudMetaData(host)})
	}

	// Your own ISOs: anything ending in .iso in Home (a few folders deep), with its volume label.
	const labels = new Map() // real path + mtime -> label
	async function isoLabel(real) {
		const st = await stat(real)
		const key = `${real}:${st.mtimeMs}`
		if (!labels.has(key)) {
			const out = await run('xorriso', ['-indev', real, '-pvd_info'], {timeout: 30_000}).catch(() => '')
			labels.set(key, /Volume Id\s*:\s*(\S+)/i.exec(out)?.[1] ?? '')
		}
		return {label: labels.get(key), size: st.size}
	}
	async function localIsos() {
		if (!files) return []
		const {real: home} = await files.resolve('/Home')
		const found = []
		const walk = async (dir, depth) => {
			if (depth > 4 || found.length >= 50) return
			for (const e of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
				if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'Pools') continue
				const full = join(dir, e.name)
				if (e.isDirectory()) await walk(full, depth + 1)
				else if (e.isFile() && /\.iso$/i.test(e.name)) found.push(full)
			}
		}
		await walk(home, 0)
		const out = []
		for (const real of found) {
			const {label, size} = await isoLabel(real)
			const windowsAuto = isWindowsClientLabel(label)
			const windows = windowsAuto || isWindowsLabel(label) || /win/i.test(basename(real))
			out.push({
				id: `local:/Home${real.slice(home.length)}`,
				familyId: windows ? 'windows-11' : 'custom',
				name: windowsAuto ? 'Windows' : basename(real).replace(/\.iso$/i, ''),
				version: windowsAuto ? basename(real) : label || 'ISO',
				sizeMb: Math.round(size / 1e6),
				arch: 'amd64',
				platform: windows ? 'windows' : 'linux',
				requiresCredentials: windowsAuto,
				manualSetup: !windowsAuto,
				custom: true,
				state: 'downloaded',
			})
		}
		return out
	}

	// ---- procedures -----------------------------------------------------------------------------
	async function list() {
		await ready
		const states = await domainStates()
		return machines.map((m) => {
			const b = busy.get(m.id)
			const live = STATE[states.get(domain(m.id))]
			const state = b?.state ?? (m.state === 'error' ? 'error' : (live ?? 'stopped'))
			return {
				id: m.id,
				vmid: m.vmid,
				name: m.name,
				osId: m.osId,
				cores: m.cores * (m.sockets ?? 1),
				memoryGb: m.memoryGb,
				memoryMb: m.memoryMb,
				diskSizeGb: m.diskSizeGb,
				state: state === 'stopped' && m.hibernated ? 'hibernated' : state,
				...(m.pending && state === 'running' ? {pending: true} : {}),
				...(m.options?.protection ? {protected: true} : {}),
				...(m.options?.onBoot ? {onBoot: true} : {}),
				networkMode: 'nat',
				portForwards: m.portForwards ?? [],
				...(b?.progress !== undefined ? {installProgress: b.progress} : {}),
				...(state === 'error' && m.errorMessage ? {errorMessage: m.errorMessage} : {}),
			}
		})
	}

	async function create(input = {}) {
		await ready
		const caps = await capabilities()
		if (!caps.libvirtAvailable) throw new RpcError('PRECONDITION_FAILED', 'Virtual machines need libvirt and QEMU. Run the Omarchy Server installer again to add them.')
		if (caps.hostArchitecture !== 'amd64') throw new RpcError('PRECONDITION_FAILED', 'Machines currently need an x86-64 server')
		const osId = String(input.osId ?? '')
		// What to install from: a catalog image, or one of your own ISOs.
		let img = null
		let local = null
		if (osId.startsWith('local:')) {
			local = (await localIsos()).find((i) => i.id === osId)
			if (!local) throw new RpcError('NOT_FOUND', 'That ISO isn’t in your Home folder any more')
			local.real = (await files.resolve(osId.slice('local:'.length))).real
		} else {
			img = (await images()).find((i) => i.id === osId)
			if (!img || img.arch !== caps.hostArchitecture) throw new RpcError('BAD_REQUEST', 'That operating system isn’t available here')
		}
		const kind = local ? (local.requiresCredentials ? 'windows' : 'manual') : img.kind === 'iso' ? 'omarchy' : 'cloud'
		const name = String(input.name ?? '').trim()
		if (!name || name.length > 64) throw new RpcError('BAD_REQUEST', 'Give the machine a name (up to 64 characters)')
		if (machines.some((m) => m.name.toLowerCase() === name.toLowerCase())) throw new RpcError('CONFLICT', 'A machine with that name already exists')
		const threads = os.cpus().length || 1
		const totalGb = Math.floor(os.totalmem() / 1024 ** 3)
		const cores = Number(input.cores)
		const memoryGb = Number(input.memoryGb)
		const diskSizeGb = Number(input.diskSizeGb)
		const minDisk = kind === 'windows' ? 64 : kind === 'omarchy' ? 20 : 4
		if (!Number.isInteger(cores) || cores < 1 || cores > threads) throw new RpcError('BAD_REQUEST', `Cores must be between 1 and ${threads}`)
		if (!Number.isInteger(memoryGb) || memoryGb < 1 || memoryGb > Math.max(1, totalGb - 1)) throw new RpcError('BAD_REQUEST', 'Not enough memory on the server for that')
		if (!Number.isInteger(diskSizeGb) || diskSizeGb < minDisk || diskSizeGb > 4096) throw new RpcError('BAD_REQUEST', `Disk size must be between ${minDisk} and 4096 GB`)
		const needsAccount = kind !== 'manual'
		const username = String(input.username ?? '').trim()
		const password = String(input.password ?? '')
		if (needsAccount) {
			const userOk = kind === 'windows' ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/.test(username) && !/^(administrator|guest)$/i.test(username) : /^[a-z_][a-z0-9_-]{0,31}$/.test(username) && username !== 'root'
			if (!userOk) throw new RpcError('BAD_REQUEST', kind === 'windows' ? 'Use a username of letters, numbers, - and _ (up to 20)' : 'Use a lower-case username: letters, numbers, - and _ (not root)')
			if (password.length < 1 || password.length > 256 || /[\r\n]/.test(password)) throw new RpcError('BAD_REQUEST', 'Enter a password for the machine')
		}
		const fs = await statfs(base)
		const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3
		const needGb = img ? ((Number(img.sizeMb) || 1024) * 3) / 1024 + 2 : 4
		if (freeGb < needGb) throw new RpcError('PRECONDITION_FAILED', `Not enough free space: about ${Math.ceil(needGb)} GB is needed to set it up`)

		let id
		do id = randomBytes(4).toString('hex')
		while (machines.some((m) => m.id === id))
		const dir = join(vmsDir, id)
		const m = normalize({id, name, osId, cores, memoryGb, memoryMb: memoryGb * 1024, diskSizeGb, portForwards: [], createdAt: Date.now(), state: 'installing', layout: layoutFor(kind === 'cloud' ? 'cloud' : kind === 'windows' ? 'windows' : 'iso', dir, img)})
		if (kind === 'cloud') m.cloudInit = {username, hostname: hostnameFor(name, id), sshKeys: []}
		machines.push(m)
		await save()
		busy.set(id, {state: 'installing', progress: 0})
		const step = (progress) => busy.set(id, {state: 'installing', progress})
		const host = hostnameFor(name, id)
		const t = beginTask(m, 'create')

		;(async () => {
			try {
				await mkdir(dir, {recursive: true, mode: 0o700})
				// Account first, so the password isn't held while downloading. Only hashes (or, for
				// Windows, its own answer-file encoding) are written.
				if (kind === 'cloud') await seed(m, img, {username, password})
				else if (kind === 'omarchy') {
					const hash = await hashPassword(password)
					const seedIso = await mediaIso(m, 'seed', 'cidata', {
						'user_configuration.json': JSON.stringify(omarchyConfiguration({host, diskSizeGb})),
						'user_credentials.json': JSON.stringify(omarchyCredentials({username, hash})),
					})
					m.layout.disks.push({id: 'seed', role: 'seed', file: seedIso, device: 'cdrom', bus: 'sata', format: 'raw'})
				} else if (kind === 'windows') {
					const answer = await mediaIso(m, 'answer', 'OMARCHY_ANSWER', {'autounattend.xml': windowsAnswerFile({computerName: host.toUpperCase(), username, password})})
					m.layout.disks.push({id: 'answer', role: 'answer', file: answer, device: 'cdrom', bus: 'sata', format: 'raw'})
					m.answerIso = answer
				}
				step(5)
				if (kind === 'cloud') {
					const src = await ensureImage(img, (p) => step(5 + Math.floor(p * 0.75)))
					step(82)
					await run('qemu-img', ['convert', '-O', 'qcow2', src, join(dir, 'disk.qcow2')], {timeout: 30 * 60_000})
					await run('qemu-img', ['resize', join(dir, 'disk.qcow2'), `${diskSizeGb}G`])
				} else {
					// Installer ISOs: a blank disk, booted from the installer until something is on it.
					const iso = kind === 'omarchy' ? await ensureImage(img, (p) => step(5 + Math.floor(p * 0.8))) : local.real
					step(88)
					await run('qemu-img', ['create', '-f', 'qcow2', join(dir, 'disk.qcow2'), `${diskSizeGb}G`])
					m.layout.disks.splice(1, 0, {id: 'cd0', file: iso, device: 'cdrom', bus: 'sata', format: 'raw'})
					m.boot = ['disk0', 'cd0']
				}
				step(92)
				await define(m)
				step(97)
				await virsh('start', domain(id))
				delete m.state
				delete m.errorMessage
				endTask(m, t)
			} catch (error) {
				Object.assign(m, {state: 'error', errorMessage: error.message})
				endTask(m, t, error)
			} finally {
				busy.delete(id)
				await save().catch(() => {})
			}
		})()
		return {id}
	}

	// Windows' answer file is only needed while Setup runs (Setup restarts the machine itself, which
	// keeps it). The first time you stop or restart the machine from here, it's removed.
	async function dropAnswerFile(m) {
		if (!m.answerIso) return
		m.layout.disks = m.layout.disks.filter((d) => d.file !== m.answerIso)
		await rm(m.answerIso, {force: true})
		delete m.answerIso
		await save()
		await define(m).catch(() => {})
	}

	const VERBS = {starting: 'start', stopping: 'shutdown', restarting: 'reboot', killing: 'stop', pausing: 'pause', resuming: 'resume', hibernating: 'hibernate'}
	const lifecycle = (verb, pending) => async (input) => {
		await ready
		const m = find(input?.id)
		if (isBusy(m.id)) throw new RpcError('CONFLICT', `${m.name} is busy`)
		if (m.state === 'error') {
			// If setup got as far as the disk, Start finishes it: define the machine again and boot.
			if (pending !== 'starting' || !(await exists(join(vmsDir, m.id, 'disk.qcow2')))) throw new RpcError('PRECONDITION_FAILED', `${m.name} didn’t finish setting up. Delete it and create it again.`)
			await define(m)
			delete m.state
			delete m.errorMessage
			await save()
		}
		const t = beginTask(m, pending === 'stopping' && verb(domain(m.id))[0] === 'destroy' ? 'stop' : VERBS[pending] ?? pending)
		busy.set(m.id, {state: pending === 'pausing' || pending === 'resuming' || pending === 'hibernating' ? 'stopping' : pending})
		try {
			if (pending === 'restarting' && m.pending) {
				// Changed hardware only applies when QEMU starts again: shut down fully, then start.
				await virsh('shutdown', domain(m.id))
				const end = Date.now() + 180_000
				while ((await domainStates()).get(domain(m.id)) !== 'shut off') {
					if (Date.now() > end) throw new Error(`${m.name} didn’t shut down within 3 minutes; use Stop, then Start`)
					await new Promise((r) => setTimeout(r, 1000))
				}
				await virsh('start', domain(m.id))
			} else await virsh(...verb(domain(m.id)))
			if (pending === 'starting' || pending === 'restarting') {
				delete m.pending
				delete m.hibernated
			}
			if (pending === 'hibernating') m.hibernated = true
			if (pending !== 'starting' && pending !== 'pausing' && pending !== 'resuming') await dropAnswerFile(m)
			endTask(m, t)
		} catch (error) {
			endTask(m, t, error)
			throw error
		} finally {
			await save().catch(() => {})
			// Shown a little longer so the next list reads libvirt's settled state; other actions may go ahead.
			const entry = {...busy.get(m.id), settling: true}
			busy.set(m.id, entry)
			setTimeout(() => busy.get(m.id) === entry && busy.delete(m.id), pending === 'stopping' ? 0 : 1500)
		}
		return true
	}

	async function uninstall(input) {
		await ready
		const m = find(input?.id)
		if (busy.get(m.id)?.state === 'installing') throw new RpcError('CONFLICT', `${m.name} is still being set up`)
		if (m.options?.protection && !input?.force) throw new RpcError('PRECONDITION_FAILED', `${m.name} is protected. Turn off Protection in its options to delete it.`)
		const states = await domainStates()
		const live = states.get(domain(m.id))
		if (live && live !== 'shut off') await virsh('destroy', domain(m.id)).catch(() => {})
		if (live) await virsh('undefine', domain(m.id), '--nvram', '--managed-save').catch(() => virsh('undefine', domain(m.id), '--nvram').catch(() => virsh('undefine', domain(m.id))))
		await rm(join(vmsDir, m.id), {recursive: true, force: true})
		machines = machines.filter((x) => x.id !== m.id)
		await save()
		return true
	}

	async function updateSettings(input) {
		await ready
		const m = find(input?.id)
		if (input.portForwards !== undefined) {
			if (!Array.isArray(input.portForwards) || input.portForwards.length > 32) throw new RpcError('BAD_REQUEST', 'Invalid port forwards')
			const seen = new Set()
			const used = new Set(machines.filter((x) => x.id !== m.id).flatMap((x) => (x.portForwards ?? []).map((f) => `${f.protocol}:${f.hostPort}`)))
			const next = input.portForwards.map((f) => {
				const protocol = f?.protocol === 'udp' ? 'udp' : 'tcp'
				const hostPort = Number(f?.hostPort)
				const guestPort = Number(f?.guestPort)
				if (!Number.isInteger(hostPort) || hostPort < PORT_MIN || hostPort > PORT_MAX) throw new RpcError('BAD_REQUEST', `Server ports must be between ${PORT_MIN} and ${PORT_MAX}`)
				if (!Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535) throw new RpcError('BAD_REQUEST', 'Machine ports must be between 1 and 65535')
				const key = `${protocol}:${hostPort}`
				if (seen.has(key) || used.has(key)) throw new RpcError('CONFLICT', `Port ${hostPort} is already forwarded`)
				seen.add(key)
				return {id: typeof f.id === 'string' && /^[\w-]{1,40}$/.test(f.id) ? f.id : randomBytes(4).toString('hex'), protocol, hostPort, guestPort}
			})
			m.portForwards = next
			await markChanged(m)
		}
		return true
	}

	// ---- administration (the settings a Proxmox user expects) ----------------------------------------
	// Task history: every action on a machine, with when it ran and how it ended.
	function beginTask(m, type, detail) {
		const t = {id: randomBytes(4).toString('hex'), type, ...(detail ? {detail} : {}), status: 'running', startedAt: Date.now()}
		m.tasks = [t, ...(m.tasks ?? [])].slice(0, 100)
		return t
	}
	function endTask(m, t, error) {
		Object.assign(t, {status: error ? 'error' : 'ok', endedAt: Date.now(), ...(error ? {message: String(error.message ?? error).slice(0, 500)} : {})})
	}
	async function task(m, type, detail, fn) {
		const t = beginTask(m, type, detail)
		await save().catch(() => {})
		try {
			const out = await fn()
			endTask(m, t)
			return out
		} catch (error) {
			endTask(m, t, error)
			throw error
		} finally {
			await save().catch(() => {})
		}
	}
	async function allTasks() {
		await ready
		return machines
			.flatMap((m) => (m.tasks ?? []).slice(0, 50).map((t) => ({...t, machineId: m.id, machineName: m.name, vmid: m.vmid})))
			.sort((a, b) => b.startedAt - a.startedAt)
			.slice(0, 100)
	}

	const liveState = async (m) => STATE[(await domainStates()).get(domain(m.id))] ?? 'stopped'
	async function requireStopped(m, what) {
		if (isBusy(m.id)) throw new RpcError('CONFLICT', `${m.name} is busy`)
		if ((await liveState(m)) !== 'stopped') throw new RpcError('PRECONDITION_FAILED', `Shut down ${m.name} first to ${what}`)
	}
	// A changed definition: libvirt keeps it for the next start. While running, it's pending until then.
	async function markChanged(m) {
		if (m.state !== 'error' && !isBusy(m.id)) {
			await define(m)
			if ((await liveState(m)) !== 'stopped') m.pending = true
		}
		await save()
	}
	const writable = (m) => {
		if (m.state === 'error' || busy.get(m.id)?.state === 'installing') throw new RpcError('PRECONDITION_FAILED', `${m.name} isn’t set up yet`)
	}

	// Live usage, sampled every 10 seconds for running machines; the last hour is kept (in memory).
	const series = new Map() // id -> [{t, cpu, memMb, netIn, netOut, diskRead, diskWrite}]
	const lastRaw = new Map() // id -> {t, cpuNs, rx, tx, rd, wr}
	async function sample() {
		const running = machines.filter((m) => !isBusy(m.id))
		if (!running.length) return
		let text = ''
		try {
			text = await virsh('domstats', '--list-running', '--cpu-total', '--balloon', '--interface', '--block')
		} catch {
			return
		}
		const now = Date.now()
		for (const block of text.split(/\n(?=Domain: )/)) {
			const name = /Domain: '([^']+)'/.exec(block)?.[1]
			const m = machines.find((x) => domain(x.id) === name)
			if (!m) continue
			const kv = {}
			for (const line of block.split('\n')) {
				const mm = /^\s*([\w.]+)=(\d+)/.exec(line)
				if (mm) kv[mm[1]] = Number(mm[2])
			}
			const sum = (re) => Object.entries(kv).reduce((a, [k, v]) => (re.test(k) ? a + v : a), 0)
			const raw = {t: now, cpuNs: kv['cpu.time'] ?? 0, rx: sum(/^net\.\d+\.rx\.bytes$/), tx: sum(/^net\.\d+\.tx\.bytes$/), rd: sum(/^block\.\d+\.rd\.bytes$/), wr: sum(/^block\.\d+\.wr\.bytes$/)}
			const prev = lastRaw.get(m.id)
			lastRaw.set(m.id, raw)
			if (!prev || raw.cpuNs < prev.cpuNs) continue
			const secs = (raw.t - prev.t) / 1000
			const vcpus = (m.sockets ?? 1) * m.cores
			const point = {
				t: now,
				cpu: Math.min(100, Math.round(((raw.cpuNs - prev.cpuNs) / (secs * 1e9 * vcpus)) * 1000) / 10),
				// What the machine actually holds in the server's memory.
				memMb: Math.round((kv['balloon.rss'] ?? 0) / 1024),
				netIn: Math.round((raw.rx - prev.rx) / secs),
				netOut: Math.round((raw.tx - prev.tx) / secs),
				diskRead: Math.round((raw.rd - prev.rd) / secs),
				diskWrite: Math.round((raw.wr - prev.wr) / secs),
			}
			const list = series.get(m.id) ?? []
			list.push(point)
			if (list.length > 360) list.splice(0, list.length - 360)
			series.set(m.id, list)
		}
	}
	let sampler = null
	function startSampler() {
		if (sampler) return
		sampler = setInterval(() => sample().catch(() => {}), 10_000)
		sampler.unref?.()
	}
	async function statsFor(input) {
		await ready
		const m = find(input?.id)
		return {memoryMb: m.memoryMb, vcpus: (m.sockets ?? 1) * m.cores, points: series.get(m.id) ?? []}
	}

	// Machines set to start with the server, in their start order, with each one's delay.
	async function autostart() {
		const list = machines.filter((m) => m.options?.onBoot && m.state !== 'error').sort((a, b) => (a.options.startupOrder ?? 999) - (b.options.startupOrder ?? 999) || a.vmid - b.vmid)
		if (!list.length) return
		const states = await domainStates()
		for (const m of list) {
			if (states.get(domain(m.id)) === 'running') continue
			await lifecycle((d) => ['start', d], 'starting')({id: m.id}).catch((e) => console.error('[omarchyd] start on boot', m.name, e.message))
			const wait = Math.min(600, Math.max(0, Number(m.options.startupDelay) || 0))
			if (wait) await new Promise((r) => setTimeout(r, wait * 1000))
		}
	}

	// Display adapters this server's QEMU has (Arch splits some into their own packages).
	let videoModels = null
	async function availableVideo() {
		if (videoModels) return videoModels
		const out = await run('qemu-system-x86_64', ['-device', 'help'], {timeout: 15_000}).catch(() => '')
		const has = (n) => out.includes(`"${n}"`)
		videoModels = ['vga', ...(has('bochs-display') ? ['bochs'] : []), ...(has('virtio-vga') ? ['virtio'] : []), ...(has('qxl-vga') ? ['qxl'] : []), ...(has('cirrus-vga') ? ['cirrus'] : []), 'none']
		return videoModels
	}

	// The server itself (the "node" in Proxmox terms).
	async function node() {
		await ready
		const caps = await capabilities()
		const fs = await statfs(base).catch(() => null)
		const cpus = os.cpus()
		const versions = await run('virsh', ['-c', LIBVIRT, 'version']).catch(() => '')
		return {
			hostname: os.hostname(),
			cpuModel: cpus[0]?.model?.trim() ?? '',
			threads: cpus.length,
			loadAverage: os.loadavg(),
			memoryTotalMb: Math.round(os.totalmem() / 1024 ** 2),
			memoryFreeMb: Math.round(os.freemem() / 1024 ** 2),
			uptimeSeconds: Math.round(os.uptime()),
			storage: fs ? {totalGb: Math.round((fs.blocks * fs.bsize) / 1024 ** 3), freeGb: Math.round((fs.bavail * fs.bsize) / 1024 ** 3)} : null,
			libvirtVersion: /libvirt[^\d]*([\d.]+)/i.exec(versions)?.[1] ?? null,
			qemuVersion: /QEMU[^\d]*([\d.]+)/i.exec(versions)?.[1] ?? null,
			...caps,
			videoModels: await availableVideo(),
			cpuTypes: CPU_TYPES,
			nicModels: NICS,
			diskBuses: BUSES,
			diskCaches: CACHES,
			counts: {total: machines.length, running: [...(await domainStates()).values()].filter((s) => s === 'running').length},
		}
	}

	async function diskInfo(file) {
		const out = await run('qemu-img', ['info', '--output=json', '-U', file], {timeout: 20_000}).catch(() => null)
		try {
			const j = JSON.parse(out)
			return {virtualGb: Math.round((j['virtual-size'] / 1024 ** 3) * 10) / 10, usedGb: Math.round(((j['actual-size'] ?? 0) / 1024 ** 3) * 10) / 10}
		} catch {
			return {}
		}
	}
	// What a disk's file is, for display: a Home path for your own ISOs, a name for catalog ones.
	async function mediaLabel(file) {
		if (!file) return null
		if (file.startsWith(imagesDir)) {
			const img = (await images().catch(() => [])).find((i) => imagePath(i) === file)
			return img ? `${img.name} ${img.version ?? ''}`.trim() : basename(file)
		}
		if (files) {
			const {real: home} = await files.resolve('/Home').catch(() => ({real: null}))
			if (home && file.startsWith(home)) return `Home${file.slice(home.length)}`
		}
		return basename(file)
	}

	async function details(input) {
		await ready
		const m = find(input?.id)
		const live = busy.get(m.id)?.state ?? (m.state === 'error' ? 'error' : await liveState(m))
		const names = m.layout ? targets(m.layout) : new Map()
		const disks = []
		for (const d of m.layout?.disks ?? []) {
			const info = d.device === 'disk' ? await diskInfo(d.file) : {}
			disks.push({id: d.id, device: d.device, bus: d.bus, target: names.get(d.id), format: d.format, role: d.role ?? null, cache: d.cache ?? 'default', discard: d.device === 'disk' ? d.discard !== false : undefined, sizeGb: info.virtualGb ?? d.sizeGb ?? null, usedGb: info.usedGb ?? null, media: d.device === 'cdrom' ? await mediaLabel(d.file) : null, inMachineFolder: d.file?.startsWith(join(vmsDir, m.id)) ?? false})
		}
		let guestIps = []
		if (live === 'running' && m.options?.agent) {
			const out = await virsh('domifaddr', domain(m.id), '--source', 'agent').catch(() => '')
			guestIps = [...out.matchAll(/ipv4\s+([\d.]+)\//g)].map((x) => x[1]).filter((ip) => !ip.startsWith('127.'))
		}
		return {
			id: m.id,
			vmid: m.vmid,
			name: m.name,
			osId: m.osId,
			state: live === 'stopped' && m.hibernated ? 'hibernated' : live,
			pending: !!m.pending && live === 'running',
			createdAt: m.createdAt,
			errorMessage: m.state === 'error' ? m.errorMessage : undefined,
			hardware: {
				sockets: m.sockets ?? 1,
				cores: m.cores,
				cpuType: m.cpuType ?? 'host',
				memoryMb: m.memoryMb,
				firmware: m.layout?.firmware ?? 'bios',
				machineType: m.layout?.machineType ?? 'q35',
				video: m.layout?.video ?? 'vga',
				nic: m.layout?.nic ?? 'virtio',
				mac: m.mac,
				linkDown: !!m.linkDown,
				disks,
			},
			boot: m.boot ?? [],
			options: {
				onBoot: !!m.options?.onBoot,
				startupOrder: m.options?.startupOrder ?? null,
				startupDelay: m.options?.startupDelay ?? 0,
				protection: !!m.options?.protection,
				tablet: m.options?.tablet !== false,
				acpi: m.options?.acpi !== false,
				kvm: m.options?.kvm !== false,
				agent: !!m.options?.agent,
				bootMenu: !!m.options?.bootMenu,
				notes: m.options?.notes ?? '',
			},
			cloudInit: m.layout?.disks?.some((d) => d.role === 'seed') ? {username: m.cloudInit?.username ?? '', hostname: m.cloudInit?.hostname ?? hostnameFor(m.name, m.id), sshKeys: m.cloudInit?.sshKeys ?? []} : null,
			portForwards: m.portForwards ?? [],
			snapshots: m.snapshots ?? [],
			tasks: (m.tasks ?? []).slice(0, 50),
			guestIps,
		}
	}

	async function updateHardware(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		const threads = os.cpus().length || 1
		const totalMb = Math.floor(os.totalmem() / 1024 ** 2)
		const sockets = input.sockets ?? m.sockets ?? 1
		const cores = input.cores ?? m.cores
		if (!Number.isInteger(sockets) || sockets < 1 || sockets > 4) throw new RpcError('BAD_REQUEST', 'Sockets must be between 1 and 4')
		if (!Number.isInteger(cores) || cores < 1 || sockets * cores > threads) throw new RpcError('BAD_REQUEST', `Sockets × cores must be between 1 and ${threads}, the server’s threads`)
		const memoryMb = input.memoryMb ?? m.memoryMb
		if (!Number.isInteger(memoryMb) || memoryMb < 256 || memoryMb > Math.max(512, totalMb - 512)) throw new RpcError('BAD_REQUEST', `Memory must be between 256 and ${Math.max(512, totalMb - 512)} MiB`)
		const cpuType = input.cpuType ?? m.cpuType ?? 'host'
		if (!CPU_TYPES.includes(cpuType)) throw new RpcError('BAD_REQUEST', 'Unknown CPU type')
		const machineType = input.machineType ?? m.layout.machineType
		if (!['q35', 'pc'].includes(machineType)) throw new RpcError('BAD_REQUEST', 'Machine type must be q35 or i440fx (pc)')
		const firmware = input.firmware ?? m.layout.firmware
		if (!['bios', 'efi'].includes(firmware)) throw new RpcError('BAD_REQUEST', 'Firmware must be SeaBIOS (bios) or OVMF (efi)')
		const video = input.video ?? m.layout.video
		if (!(await availableVideo()).includes(video)) throw new RpcError('BAD_REQUEST', 'That display isn’t available on this server')
		const nic = input.nic ?? m.layout.nic
		if (!NICS.includes(nic)) throw new RpcError('BAD_REQUEST', 'Unknown network model')
		const mac = String(input.mac ?? m.mac).toLowerCase()
		if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || parseInt(mac.slice(0, 2), 16) & 1) throw new RpcError('BAD_REQUEST', 'Enter a unicast MAC address like 52:54:00:12:34:56')
		if (machines.some((x) => x.id !== m.id && x.mac === mac)) throw new RpcError('CONFLICT', 'Another machine uses that MAC address')
		const changes = []
		if (sockets !== m.sockets || cores !== m.cores) changes.push(`CPU ${sockets}×${cores}`)
		if (memoryMb !== m.memoryMb) changes.push(`memory ${memoryMb} MiB`)
		return task(m, 'hardware', changes.join(', ') || 'settings', async () => {
			Object.assign(m, {sockets, cores, memoryMb, memoryGb: Math.max(1, Math.round(memoryMb / 1024)), cpuType, mac, linkDown: input.linkDown ?? !!m.linkDown})
			Object.assign(m.layout, {machineType, firmware, video, nic})
			await markChanged(m)
			return true
		})
	}

	async function updateOptions(input = {}) {
		await ready
		const m = find(input.id)
		const o = {...m.options}
		if (input.name !== undefined) {
			const name = String(input.name).trim()
			if (!name || name.length > 64) throw new RpcError('BAD_REQUEST', 'Give the machine a name (up to 64 characters)')
			if (machines.some((x) => x.id !== m.id && x.name.toLowerCase() === name.toLowerCase())) throw new RpcError('CONFLICT', 'A machine with that name already exists')
			m.name = name
		}
		for (const k of ['onBoot', 'protection', 'tablet', 'acpi', 'kvm', 'agent', 'bootMenu']) if (input[k] !== undefined) o[k] = !!input[k]
		if (input.startupOrder !== undefined) {
			const n = input.startupOrder === null || input.startupOrder === '' ? null : Number(input.startupOrder)
			if (n !== null && (!Number.isInteger(n) || n < 0 || n > 999)) throw new RpcError('BAD_REQUEST', 'Start order must be between 0 and 999')
			o.startupOrder = n
		}
		if (input.startupDelay !== undefined) {
			const n = Number(input.startupDelay)
			if (!Number.isInteger(n) || n < 0 || n > 600) throw new RpcError('BAD_REQUEST', 'Start delay must be between 0 and 600 seconds')
			o.startupDelay = n
		}
		if (input.notes !== undefined) {
			if (String(input.notes).length > 8000) throw new RpcError('BAD_REQUEST', 'Notes are limited to 8,000 characters')
			o.notes = String(input.notes)
		}
		return task(m, 'options', null, async () => {
			m.options = o
			if (m.state === 'error') await save()
			else await markChanged(m)
			return true
		})
	}

	async function setBootOrder(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		const ids = new Set([...m.layout.disks.map((d) => d.id), 'net'])
		const order = Array.isArray(input.order) ? input.order.map(String) : []
		if (!order.length || order.some((x) => !ids.has(x)) || new Set(order).size !== order.length) throw new RpcError('BAD_REQUEST', 'Choose at least one boot device')
		return task(m, 'boot', order.join(', '), async () => {
			m.boot = order
			if (input.bootMenu !== undefined) m.options = {...m.options, bootMenu: !!input.bootMenu}
			await markChanged(m)
			return true
		})
	}

	// ---- drives ---------------------------------------------------------------------------------
	const findDisk = (m, diskId) => {
		const d = m.layout.disks.find((x) => x.id === diskId)
		if (!d) throw new RpcError('NOT_FOUND', 'That drive doesn’t exist')
		return d
	}
	const nextId = (m, prefix) => {
		let n = 0
		while (m.layout.disks.some((d) => d.id === `${prefix}${n}`)) n++
		return `${prefix}${n}`
	}
	async function addDisk(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		const sizeGb = Number(input.sizeGb)
		const bus = input.bus ?? 'virtio'
		if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 4096) throw new RpcError('BAD_REQUEST', 'Disk size must be between 1 and 4096 GB')
		if (!BUSES.includes(bus)) throw new RpcError('BAD_REQUEST', 'Unknown disk bus')
		if (input.cache !== undefined && !CACHES.includes(input.cache)) throw new RpcError('BAD_REQUEST', 'Unknown cache mode')
		if (m.layout.disks.length >= 16) throw new RpcError('BAD_REQUEST', 'A machine can have up to 16 drives here')
		const fs = await statfs(base)
		if ((fs.bavail * fs.bsize) / 1024 ** 3 < 1) throw new RpcError('PRECONDITION_FAILED', 'Not enough free space on the server')
		const id = nextId(m, 'disk')
		const file = join(vmsDir, m.id, `${id}.qcow2`)
		return task(m, 'add-disk', `${id} ${sizeGb} GB`, async () => {
			await run('qemu-img', ['create', '-f', 'qcow2', file, `${sizeGb}G`])
			m.layout.disks.push({id, file, device: 'disk', bus, format: 'qcow2', sizeGb, ...(input.cache && input.cache !== 'default' ? {cache: input.cache} : {}), ...(input.discard === false ? {discard: false} : {})})
			await markChanged(m)
			return {diskId: id}
		})
	}
	async function updateDisk(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		const d = findDisk(m, input.diskId)
		if (input.bus !== undefined && !BUSES.includes(input.bus)) throw new RpcError('BAD_REQUEST', 'Unknown disk bus')
		if (input.cache !== undefined && !CACHES.includes(input.cache)) throw new RpcError('BAD_REQUEST', 'Unknown cache mode')
		return task(m, 'edit-disk', d.id, async () => {
			if (input.bus !== undefined) d.bus = input.bus
			if (input.cache !== undefined) d.cache = input.cache
			if (input.discard !== undefined && d.device === 'disk') d.discard = !!input.discard
			await markChanged(m)
			return true
		})
	}
	async function resizeDisk(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		const d = findDisk(m, input.diskId)
		if (d.device !== 'disk') throw new RpcError('BAD_REQUEST', 'Only disks can be resized')
		const sizeGb = Number(input.sizeGb)
		const current = (await diskInfo(d.file)).virtualGb ?? d.sizeGb ?? 0
		if (!Number.isInteger(sizeGb) || sizeGb > 4096) throw new RpcError('BAD_REQUEST', 'Disk size must be a whole number of GB, up to 4096')
		if (sizeGb <= current) throw new RpcError('BAD_REQUEST', `Disks can only grow: enter more than ${current} GB`)
		return task(m, 'resize-disk', `${d.id} to ${sizeGb} GB`, async () => {
			if ((await liveState(m)) === 'running') await virsh('blockresize', domain(m.id), targets(m.layout).get(d.id), `${sizeGb}G`)
			else await run('qemu-img', ['resize', d.file, `${sizeGb}G`])
			d.sizeGb = sizeGb
			if (d.id === 'disk0') m.diskSizeGb = sizeGb
			await save()
			return true
		})
	}
	async function removeDisk(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		const d = findDisk(m, input.diskId)
		await requireStopped(m, 'remove a drive')
		if (d.device === 'disk' && m.layout.disks.filter((x) => x.device === 'disk').length === 1) throw new RpcError('PRECONDITION_FAILED', 'This is the machine’s only disk')
		return task(m, 'remove-drive', d.id, async () => {
			m.layout.disks = m.layout.disks.filter((x) => x !== d)
			m.boot = (m.boot ?? []).filter((x) => x !== d.id)
			if (!m.boot.length) m.boot = [m.layout.disks.find((x) => x.device === 'disk').id]
			// Only files that belong to this machine are deleted (never an ISO from your Home folder).
			if (input.deleteFile && d.file?.startsWith(join(vmsDir, m.id) + '/')) await rm(d.file, {force: true})
			if (d.role === 'answer') delete m.answerIso
			await markChanged(m)
			return true
		})
	}
	async function addCdrom(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		await requireStopped(m, 'add a CD/DVD drive')
		const id = nextId(m, 'cd')
		return task(m, 'add-cdrom', id, async () => {
			m.layout.disks.push({id, file: '', device: 'cdrom', bus: input.bus === 'ide' && m.layout.machineType === 'pc' ? 'ide' : 'sata', format: 'raw'})
			await markChanged(m)
			return {diskId: id}
		})
	}
	// Put an ISO in a CD/DVD drive (one of yours from Home, or a downloaded installer), or eject it.
	async function setMedia(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		const d = findDisk(m, input.diskId)
		if (d.device !== 'cdrom') throw new RpcError('BAD_REQUEST', 'That isn’t a CD/DVD drive')
		let file = ''
		if (input.iso) {
			const iso = String(input.iso)
			if (iso.startsWith('local:')) {
				if (!files) throw new RpcError('PRECONDITION_FAILED', 'Your files aren’t available')
				const {real} = await files.resolve(iso.slice('local:'.length))
				if (!/\.iso$/i.test(real)) throw new RpcError('BAD_REQUEST', 'Choose an .iso file')
				file = real
			} else {
				const img = (await images()).find((i) => i.id === iso && i.kind === 'iso')
				if (!img || !(await exists(imagePath(img)))) throw new RpcError('NOT_FOUND', 'That installer isn’t downloaded')
				file = imagePath(img)
			}
		}
		return task(m, file ? 'insert-media' : 'eject-media', `${d.id}${file ? ` ${basename(file)}` : ''}`, async () => {
			if ((await liveState(m)) === 'running') {
				const dev = targets(m.layout).get(d.id)
				if (file) await virsh('change-media', domain(m.id), dev, file, '--update', '--live')
				else await virsh('change-media', domain(m.id), dev, '--eject', '--live').catch(() => {})
			}
			d.file = file
			if (m.state !== 'error') await define(m)
			await save()
			return true
		})
	}

	// ---- cloud-init -----------------------------------------------------------------------------
	// A new seed with a new instance id: cloud-init applies it at the machine's next boot. A new
	// password is written only as a hash; SSH keys must be public keys.
	async function updateCloudInit(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		const seedDisk = m.layout.disks.find((d) => d.role === 'seed')
		if (!seedDisk) throw new RpcError('PRECONDITION_FAILED', `${m.name} doesn’t use cloud-init`)
		const username = String(input.username ?? m.cloudInit?.username ?? '').trim()
		if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username) || username === 'root') throw new RpcError('BAD_REQUEST', 'Use a lower-case username: letters, numbers, - and _ (not root)')
		const hostname = String(input.hostname ?? m.cloudInit?.hostname ?? hostnameFor(m.name, m.id)).trim().toLowerCase()
		if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw new RpcError('BAD_REQUEST', 'Use a hostname of letters, numbers and - (up to 63)')
		const sshKeys = (Array.isArray(input.sshKeys) ? input.sshKeys : (m.cloudInit?.sshKeys ?? [])).map((k) => String(k).trim()).filter(Boolean)
		if (sshKeys.length > 20) throw new RpcError('BAD_REQUEST', 'Up to 20 SSH keys')
		const bad = sshKeys.find((k) => !PUBLIC_KEY.test(k))
		if (bad) throw new RpcError('BAD_REQUEST', /PRIVATE KEY/.test(bad) ? 'That’s a private key. Paste the public key (the .pub file) instead.' : 'Each line must be an SSH public key, like “ssh-ed25519 AAAA… you@laptop”')
		const password = input.password ? String(input.password) : ''
		if (password && (password.length > 256 || /[\r\n]/.test(password))) throw new RpcError('BAD_REQUEST', 'That password can’t be used')
		const img = (await images().catch(() => [])).find((i) => i.id === m.osId)
		return task(m, 'cloud-init', null, async () => {
			const hash = password ? await hashPassword(password) : null
			const userData = cloudUserData({host: hostname, username, hash, sshKeys, changePassword: !!hash, cloudInit: {adminGroup: img?.adminGroup}})
			const iso = await mediaIso(m, 'seed', 'cidata', {'user-data': userData, 'meta-data': cloudMetaData(hostname)})
			seedDisk.file = iso
			m.cloudInit = {username, hostname, sshKeys}
			await markChanged(m)
			if ((await liveState(m)) === 'running') m.pending = true
			await save()
			return true
		})
	}

	// ---- snapshots ------------------------------------------------------------------------------
	// Internal qcow2 snapshots of every disk, taken while the machine is shut down, with the
	// machine's settings at that moment. (UEFI variables aren't part of a snapshot.)
	const SNAP = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
	const qcowDisks = (m) => m.layout.disks.filter((d) => d.device === 'disk' && d.format === 'qcow2')
	async function snapshot(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		const name = String(input.name ?? '').trim()
		if (!SNAP.test(name)) throw new RpcError('BAD_REQUEST', 'Name the snapshot with letters, numbers, - _ and . (up to 40)')
		if ((m.snapshots ?? []).some((x) => x.name === name)) throw new RpcError('CONFLICT', 'A snapshot with that name already exists')
		if ((m.snapshots ?? []).length >= 32) throw new RpcError('BAD_REQUEST', 'Up to 32 snapshots per machine')
		await requireStopped(m, 'take a snapshot')
		const description = String(input.description ?? '').slice(0, 500)
		return task(m, 'snapshot', name, async () => {
			const done = []
			try {
				for (const d of qcowDisks(m)) {
					await run('qemu-img', ['snapshot', '-c', name, d.file], {timeout: 10 * 60_000})
					done.push(d)
				}
			} catch (error) {
				for (const d of done) await run('qemu-img', ['snapshot', '-d', name, d.file]).catch(() => {})
				throw error
			}
			const config = {sockets: m.sockets, cores: m.cores, memoryMb: m.memoryMb, cpuType: m.cpuType, layout: {firmware: m.layout.firmware, machineType: m.layout.machineType, video: m.layout.video, nic: m.layout.nic}, disks: qcowDisks(m).map((d) => d.id)}
			m.snapshots = [...(m.snapshots ?? []), {name, description, createdAt: Date.now(), config}]
			await save()
			return true
		})
	}
	async function revertSnapshot(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		const snap = (m.snapshots ?? []).find((x) => x.name === input.name)
		if (!snap) throw new RpcError('NOT_FOUND', 'That snapshot doesn’t exist')
		await requireStopped(m, 'go back to a snapshot')
		return task(m, 'rollback', snap.name, async () => {
			for (const d of qcowDisks(m)) if (snap.config.disks.includes(d.id)) await run('qemu-img', ['snapshot', '-a', snap.name, d.file], {timeout: 10 * 60_000})
			const c = snap.config
			Object.assign(m, {sockets: c.sockets, cores: c.cores, memoryMb: c.memoryMb, memoryGb: Math.max(1, Math.round(c.memoryMb / 1024)), cpuType: c.cpuType})
			Object.assign(m.layout, c.layout)
			delete m.hibernated
			await markChanged(m)
			return true
		})
	}
	async function deleteSnapshot(input = {}) {
		await ready
		const m = find(input.id)
		const snap = (m.snapshots ?? []).find((x) => x.name === input.name)
		if (!snap) throw new RpcError('NOT_FOUND', 'That snapshot doesn’t exist')
		await requireStopped(m, 'delete a snapshot')
		return task(m, 'delete-snapshot', snap.name, async () => {
			for (const d of qcowDisks(m)) if (snap.config.disks.includes(d.id)) await run('qemu-img', ['snapshot', '-d', snap.name, d.file], {timeout: 10 * 60_000}).catch(() => {})
			m.snapshots = m.snapshots.filter((x) => x !== snap)
			await save()
			return true
		})
	}

	// ---- backups --------------------------------------------------------------------------------
	// Compressed copies of a machine's disks and settings in Home → Backups → Machines, so they show
	// up in Files and can be copied elsewhere. A running machine is backed up live by QEMU (a
	// consistent point-in-time copy); a stopped one is copied directly.
	async function backupsDir() {
		if (!files) throw new RpcError('PRECONDITION_FAILED', 'Your files aren’t available')
		const {real: home} = await files.resolve('/Home')
		const dir = join(home, 'Backups', 'Machines')
		await mkdir(dir, {recursive: true, mode: 0o700})
		return dir
	}
	const BACKUP_ID = /^[\w][\w.-]{0,150}$/
	async function listBackups(input = {}) {
		await ready
		const dir = await backupsDir()
		const out = []
		for (const e of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
			if (!e.isDirectory() || !BACKUP_ID.test(e.name)) continue
			const meta = await readFile(join(dir, e.name, 'machine.json'), 'utf8').then(JSON.parse, () => null)
			if (!meta?.machine) continue
			if (input.id && meta.sourceId !== input.id) continue
			let bytes = 0
			for (const f of await readdir(join(dir, e.name)).catch(() => [])) bytes += (await stat(join(dir, e.name, f)).catch(() => ({size: 0}))).size
			out.push({id: e.name, name: meta.machine.name, vmid: meta.machine.vmid, sourceId: meta.sourceId, createdAt: meta.createdAt, notes: meta.notes ?? '', live: !!meta.live, sizeBytes: bytes, path: `/Home/Backups/Machines/${e.name}`})
		}
		return out.sort((a, b) => b.createdAt - a.createdAt)
	}
	const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
	async function backup(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		if (isBusy(m.id)) throw new RpcError('CONFLICT', `${m.name} is busy`)
		const notes = String(input.notes ?? '').slice(0, 500)
		const dir = await backupsDir()
		let id = `${m.vmid}-${hostnameFor(m.name, m.id)}-${stamp(Date.now())}`
		for (let n = 2; await exists(join(dir, id)); n++) id = `${m.vmid}-${hostnameFor(m.name, m.id)}-${stamp(Date.now())}-${n}`
		const target = join(dir, id)
		const disks = qcowDisks(m)
		const need = (await Promise.all(disks.map((d) => diskInfo(d.file)))).reduce((a, i) => a + (i.usedGb ?? 1), 0)
		const fs = await statfs(dir)
		if ((fs.bavail * fs.bsize) / 1024 ** 3 < need + 1) throw new RpcError('PRECONDITION_FAILED', `Not enough free space for the backup (about ${Math.ceil(need)} GB)`)
		const running = (await liveState(m)) === 'running'
		busy.set(m.id, {state: running ? 'running' : 'stopped', progress: 0})
		// A folder of its own (never one that's already there, so a failure only removes its own).
		await mkdir(target, {mode: 0o700})
		// Runs in the background (large disks take a while); progress shows on the machine, the
		// result in its task history, and the backup is listed once complete.
		task(m, 'backup', id, async () => {
			try {
				if (running) {
					// QEMU writes a consistent copy of each disk while the machine keeps running.
					const tmp = join(target, '.live')
					await mkdir(tmp)
					const names = targets(m.layout)
					const bxml = `<domainbackup mode='push'><disks>${m.layout.disks
						.map((d) => (disks.includes(d) ? `<disk name='${names.get(d.id)}' backup='yes' type='file'><target file='${xml(join(tmp, `${d.id}.qcow2`))}'/><driver type='qcow2'/></disk>` : `<disk name='${names.get(d.id)}' backup='no'/>`))
						.join('')}</disks></domainbackup>`
					await writeFile(join(tmp, 'backup.xml'), bxml)
					await virsh('backup-begin', domain(m.id), '--backupxml', join(tmp, 'backup.xml'))
					const end = Date.now() + 6 * 60 * 60_000
					for (;;) {
						const info = await virsh('domjobinfo', domain(m.id)).catch(() => '')
						const pct = /Data processed:\s+([\d.]+)\s*(\w+)[\s\S]*Data total:\s+([\d.]+)\s*(\w+)/.exec(info)
						if (pct) busy.set(m.id, {state: 'running', progress: Math.min(90, Math.round((Number(pct[1]) / Math.max(1, Number(pct[3]))) * 90))})
						if (!/Job type:\s+(Unbounded|Bounded)/.test(info)) break
						if (Date.now() > end) throw new Error('The backup took too long and was stopped')
						await new Promise((r) => setTimeout(r, 1000))
					}
					const done = await virsh('domjobinfo', domain(m.id), '--completed').catch(() => '')
					if (/Job type:\s+Failed/.test(done)) throw new Error('QEMU couldn’t finish the backup')
					for (const d of disks) await run('qemu-img', ['convert', '-c', '-O', 'qcow2', join(tmp, `${d.id}.qcow2`), join(target, `${d.id}.qcow2`)], {timeout: 6 * 60 * 60_000})
					await rm(tmp, {recursive: true, force: true})
				} else {
					let i = 0
					for (const d of disks) {
						busy.set(m.id, {state: 'stopped', progress: Math.round((i++ / disks.length) * 100)})
						await run('qemu-img', ['convert', '-c', '-O', 'qcow2', d.file, join(target, `${d.id}.qcow2`)], {timeout: 6 * 60 * 60_000})
					}
				}
				// The settings, without task history or anything secret (no seed or answer file).
				const machine = {...m, tasks: undefined, snapshots: undefined, answerIso: undefined, state: undefined, errorMessage: undefined, pending: undefined, hibernated: undefined}
				await writeFile(join(target, 'machine.json'), JSON.stringify({format: 1, sourceId: m.id, createdAt: Date.now(), notes, live: running, machine, disks: disks.map((d) => d.id)}, null, 2), {mode: 0o600})
			} catch (error) {
				await rm(target, {recursive: true, force: true})
				throw error
			} finally {
				busy.delete(m.id)
			}
		}).catch(() => {})
		return {backupId: id}
	}
	async function deleteBackup(input = {}) {
		await ready
		const id = String(input.backupId ?? '')
		if (!BACKUP_ID.test(id)) throw new RpcError('BAD_REQUEST', 'Bad backup')
		const dir = join(await backupsDir(), id)
		if (!(await exists(join(dir, 'machine.json')))) throw new RpcError('NOT_FOUND', 'That backup doesn’t exist')
		await rm(dir, {recursive: true, force: true})
		return true
	}
	// A new machine from copied disks and settings (used by restore and clone).
	async function adopt(source, {name, copyDisk, keepIds}) {
		let id
		do id = randomBytes(4).toString('hex')
		while (machines.some((x) => x.id === id))
		const dir = join(vmsDir, id)
		const m = normalize({
			...JSON.parse(JSON.stringify(source)),
			id,
			vmid: undefined,
			name,
			mac: undefined,
			createdAt: Date.now(),
			tasks: [],
			snapshots: [],
			state: 'installing',
			portForwards: [],
			answerIso: undefined,
			pending: undefined,
			hibernated: undefined,
		})
		machines.push(m)
		busy.set(id, {state: 'installing', progress: 0})
		await save()
		const t = beginTask(m, keepIds ? 'restore' : 'clone', source.name)
		;(async () => {
			try {
				await mkdir(dir, {recursive: true, mode: 0o700})
				const kept = []
				let i = 0
				for (const d of m.layout.disks) {
					busy.set(id, {state: 'installing', progress: Math.round((i++ / m.layout.disks.length) * 95)})
					if (d.device === 'disk') {
						const dst = join(dir, d.id === 'disk0' ? 'disk.qcow2' : `${d.id}.qcow2`)
						await copyDisk(d, dst)
						kept.push({...d, file: dst})
					} else if (d.role === 'answer') continue
					else if (d.role === 'seed') {
						const src = d.file
						if (src && (await exists(src))) {
							const dst = join(dir, 'seed.iso')
							await copyFile(src, dst)
							kept.push({...d, file: dst})
						}
					} else kept.push({...d, file: d.file && (await exists(d.file)) ? d.file : ''})
				}
				m.layout.disks = kept
				m.boot = (m.boot ?? []).filter((b) => b === 'net' || kept.some((d) => d.id === b))
				if (!m.boot.length) m.boot = [kept.find((d) => d.device === 'disk')?.id ?? 'disk0']
				await define(m)
				delete m.state
				endTask(m, t)
			} catch (error) {
				Object.assign(m, {state: 'error', errorMessage: error.message})
				endTask(m, t, error)
			} finally {
				busy.delete(id)
				await save().catch(() => {})
			}
		})()
		return {id}
	}
	const uniqueName = (wanted) => {
		let name = wanted.slice(0, 64)
		for (let n = 2; machines.some((x) => x.name.toLowerCase() === name.toLowerCase()); n++) name = `${wanted.slice(0, 58)} (${n})`
		return name
	}
	async function restoreBackup(input = {}) {
		await ready
		const id = String(input.backupId ?? '')
		if (!BACKUP_ID.test(id)) throw new RpcError('BAD_REQUEST', 'Bad backup')
		const dir = join(await backupsDir(), id)
		const meta = await readFile(join(dir, 'machine.json'), 'utf8').then(JSON.parse, () => null)
		if (!meta?.machine?.layout) throw new RpcError('NOT_FOUND', 'That backup doesn’t exist')
		const name = input.name ? String(input.name).trim() : uniqueName(meta.machine.name)
		if (!name || name.length > 64 || machines.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new RpcError('CONFLICT', 'Choose a name no other machine has')
		return adopt(meta.machine, {name, keepIds: true, copyDisk: (d, dst) => run('qemu-img', ['convert', '-O', 'qcow2', join(dir, `${d.id}.qcow2`), dst], {timeout: 6 * 60 * 60_000})})
	}
	async function clone(input = {}) {
		await ready
		const m = find(input.id)
		writable(m)
		await requireStopped(m, 'clone it')
		const name = input.name ? String(input.name).trim() : uniqueName(`${m.name} copy`)
		if (!name || name.length > 64 || machines.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new RpcError('CONFLICT', 'Choose a name no other machine has')
		const out = await adopt(m, {name, keepIds: false, copyDisk: (d, dst) => run('qemu-img', ['convert', '-O', 'qcow2', d.file, dst], {timeout: 6 * 60 * 60_000})})
		await task(m, 'clone', name, async () => true)
		return out
	}

	// QEMU's own monitor (HMP), for the commands Proxmox's Monitor tab offers ("info status"…).
	const MONITOR_COMMANDS = new Set(['info', 'help', '?', 'system_reset', 'system_powerdown', 'system_wakeup', 'sendkey', 'stop', 'cont', 'c', 'nmi', 'mouse_move', 'mouse_button', 'balloon', 'set_link'])
	async function monitor(input = {}) {
		await ready
		const m = find(input.id)
		const command = String(input.command ?? '').trim()
		if (!command || command.length > 500 || /[\r\n]/.test(command)) throw new RpcError('BAD_REQUEST', 'Enter one monitor command')
		// Only commands that look at or act on the machine itself: none that read or write files on
		// this server or start programs on it (migrate "exec:…", drive_add, dump-guest-memory,
		// screendump, chardev-add and the like).
		const verb = command.split(/\s+/)[0].toLowerCase()
		if (!MONITOR_COMMANDS.has(verb)) throw new RpcError('FORBIDDEN', `“${verb}” isn’t available here. You can use: ${[...MONITOR_COMMANDS].filter((c) => c.length > 2).join(', ')}.`)
		if ((await liveState(m)) === 'stopped') throw new RpcError('PRECONDITION_FAILED', `${m.name} isn’t running`)
		const out = await virsh('qemu-monitor-command', domain(m.id), '--hmp', command).catch((e) => e.message)
		return {output: String(out).slice(0, 64_000)}
	}

	// For the console bridge: the VNC socket of a running machine.
	async function vncSocket(id) {
		await ready
		const m = find(id)
		const sock = join(vmsDir, m.id, 'vnc.sock')
		const s = await stat(sock).catch(() => null)
		if (!s?.isSocket()) throw new RpcError('PRECONDITION_FAILED', `${m.name} isn’t running`)
		return sock
	}

	// Factory reset: remove every machine and its disks.
	async function uninstallAll() {
		await ready
		for (const m of [...machines]) {
			busy.delete(m.id)
			await uninstall({id: m.id, force: true}).catch(() => {})
		}
	}

	// What each running machine uses right now (for the system usage breakdown): the latest sample.
	function usage() {
		startSampler()
		const out = []
		for (const m of machines) {
			const last = (series.get(m.id) ?? []).at(-1)
			if (!last || Date.now() - last.t > 30_000) continue
			out.push({id: `machine:${m.id}`, name: m.name, cpuShare: (last.cpu / 100) * (m.sockets ?? 1) * m.cores, memBytes: last.memMb * 1024 * 1024})
		}
		return out
	}

	return {
		ready,
		usage,
		uninstallAll,
		vncSocket,
		procedures: {
			'machines.capabilities': {kind: 'query', run: capabilities},
			'machines.osImages': {kind: 'query', run: osImages},
			'machines.localIsos': {kind: 'query', run: localIsos},
			'machines.list': {kind: 'query', run: list},
			'machines.create': {kind: 'mutation', run: create},
			'machines.start': {kind: 'mutation', run: lifecycle((d) => ['start', d], 'starting')},
			'machines.stop': {kind: 'mutation', run: lifecycle((d) => ['shutdown', d], 'stopping')},
			'machines.restart': {kind: 'mutation', run: lifecycle((d) => ['reboot', d], 'restarting')},
			'machines.forceStop': {kind: 'mutation', run: lifecycle((d) => ['destroy', d], 'stopping')},
			'machines.uninstall': {kind: 'mutation', run: uninstall},
			'machines.updateSettings': {kind: 'mutation', run: updateSettings},
			'machines.pause': {kind: 'mutation', run: lifecycle((d) => ['suspend', d], 'pausing')},
			'machines.resume': {kind: 'mutation', run: lifecycle((d) => ['resume', d], 'resuming')},
			'machines.hibernate': {kind: 'mutation', run: lifecycle((d) => ['managedsave', d], 'hibernating')},
			'machines.node': {kind: 'query', run: node},
			'machines.details': {kind: 'query', run: details},
			'machines.stats': {kind: 'query', run: statsFor},
			'machines.tasks': {kind: 'query', run: allTasks},
			'machines.updateHardware': {kind: 'mutation', run: updateHardware},
			'machines.updateOptions': {kind: 'mutation', run: updateOptions},
			'machines.setBootOrder': {kind: 'mutation', run: setBootOrder},
			'machines.addDisk': {kind: 'mutation', run: addDisk},
			'machines.updateDisk': {kind: 'mutation', run: updateDisk},
			'machines.resizeDisk': {kind: 'mutation', run: resizeDisk},
			'machines.removeDisk': {kind: 'mutation', run: removeDisk},
			'machines.addCdrom': {kind: 'mutation', run: addCdrom},
			'machines.setMedia': {kind: 'mutation', run: setMedia},
			'machines.updateCloudInit': {kind: 'mutation', run: updateCloudInit},
			'machines.snapshot': {kind: 'mutation', run: snapshot},
			'machines.revertSnapshot': {kind: 'mutation', run: revertSnapshot},
			'machines.deleteSnapshot': {kind: 'mutation', run: deleteSnapshot},
			'machines.backups': {kind: 'query', run: listBackups},
			'machines.backup': {kind: 'mutation', run: backup},
			'machines.restoreBackup': {kind: 'mutation', run: restoreBackup},
			'machines.deleteBackup': {kind: 'mutation', run: deleteBackup},
			'machines.clone': {kind: 'mutation', run: clone},
			'machines.monitor': {kind: 'mutation', run: monitor},
		},
	}
}
