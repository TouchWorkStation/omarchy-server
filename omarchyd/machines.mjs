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
import {access, mkdir, readFile, readdir, rename, rm, statfs, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {basename, join} from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {fileURLToPath} from 'node:url'

import {cloudMetaData, cloudUserData, hostnameFor, isWindowsClientLabel, isWindowsLabel, omarchyConfiguration, omarchyCredentials, windowsAnswerFile} from './machine-media.mjs'
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
	const busy = new Map() // id -> {state, progress}
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
		for (const m of machines) if (m.state === 'installing') Object.assign(m, {state: 'error', errorMessage: 'Setup was interrupted. Delete this machine and create it again.'})
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
	// setting (port forwards) can rebuild the same definition.
	function layoutFor(kind, dir, img) {
		const disk = {file: join(dir, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2'}
		if (kind === 'cloud') return {firmware: img?.firmware === 'efi' ? 'efi' : 'bios', nic: 'virtio', video: 'virtio', disks: [disk, {file: join(dir, 'seed.iso'), device: 'cdrom', bus: 'sata', format: 'raw'}]}
		// Windows installs without extra drivers on SATA, e1000e and a standard display.
		if (kind === 'windows') return {firmware: 'efi', nic: 'e1000e', video: 'vga', disks: [{...disk, bus: 'sata'}]}
		return {firmware: 'efi', nic: 'virtio', video: 'virtio', disks: [disk]}
	}
	function domainXml(m, kvm) {
		const dir = join(vmsDir, m.id)
		const layout = m.layout ?? layoutFor('cloud', dir)
		const forwards = (m.portForwards ?? [])
			.map((f) => `<portForward proto='${f.protocol}'><range start='${f.hostPort}' to='${f.guestPort}'/></portForward>`)
			.join('')
		let sata = 0
		let virtio = 0
		const disks = layout.disks
			.map((d) => {
				const target = d.bus === 'virtio' ? `vd${String.fromCharCode(97 + virtio++)}` : `sd${String.fromCharCode(97 + sata++)}`
				const ro = d.device === 'cdrom' ? '<readonly/>' : ''
				const boot = d.bootOrder ? `<boot order='${d.bootOrder}'/>` : ''
				return `<disk type='file' device='${d.device}'><driver name='qemu' type='${d.format}'${d.device === 'disk' ? " discard='unmap'" : ''}/><source file='${xml(d.file)}'/><target dev='${target}' bus='${d.bus}'/>${boot}${ro}</disk>`
			})
			.join('\n    ')
		const anyBootOrder = layout.disks.some((d) => d.bootOrder)
		const os =
			layout.firmware === 'efi'
				? `<os firmware='efi'><type arch='x86_64' machine='q35'>hvm</type><firmware><feature enabled='no' name='secure-boot'/></firmware>${anyBootOrder ? '' : "<boot dev='hd'/>"}</os>`
				: `<os><type arch='x86_64' machine='q35'>hvm</type>${anyBootOrder ? '' : "<boot dev='hd'/>"}</os>`
		return `<domain type='${kvm ? 'kvm' : 'qemu'}'>
  <name>${domain(m.id)}</name>
  <title>${xml(m.name)}</title>
  <memory unit='GiB'>${m.memoryGb}</memory>
  <vcpu>${m.cores}</vcpu>
  ${os}
  <features><acpi/><apic/></features>
  ${kvm ? "<cpu mode='host-passthrough'/>" : ''}
  <on_reboot>restart</on_reboot>
  <devices>
    ${disks}
    <interface type='user'><backend type='passt'/><model type='${layout.nic}'/>${forwards}</interface>
    <serial type='pty'/><console type='pty'/>
    <graphics type='vnc' socket='${xml(join(dir, 'vnc.sock'))}'/>
    <video><model type='${layout.video}'/></video>
    <input type='tablet' bus='usb'/>
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
				name: m.name,
				osId: m.osId,
				cores: m.cores,
				memoryGb: m.memoryGb,
				diskSizeGb: m.diskSizeGb,
				state,
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
		const m = {id, name, osId, cores, memoryGb, diskSizeGb, portForwards: [], createdAt: Date.now(), state: 'installing', layout: layoutFor(kind === 'cloud' ? 'cloud' : kind === 'windows' ? 'windows' : 'iso', dir, img)}
		machines.push(m)
		await save()
		busy.set(id, {state: 'installing', progress: 0})
		const step = (progress) => busy.set(id, {state: 'installing', progress})
		const host = hostnameFor(name, id)

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
					m.layout.disks.push({file: seedIso, device: 'cdrom', bus: 'sata', format: 'raw'})
				} else if (kind === 'windows') {
					const answer = await mediaIso(m, 'answer', 'OMARCHY_ANSWER', {'autounattend.xml': windowsAnswerFile({computerName: host.toUpperCase(), username, password})})
					m.layout.disks.push({file: answer, device: 'cdrom', bus: 'sata', format: 'raw'})
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
					m.layout.disks[0].bootOrder = 1
					m.layout.disks.splice(1, 0, {file: iso, device: 'cdrom', bus: 'sata', format: 'raw', bootOrder: 2})
				}
				step(92)
				await define(m)
				step(97)
				await virsh('start', domain(id))
				delete m.state
				delete m.errorMessage
			} catch (error) {
				Object.assign(m, {state: 'error', errorMessage: error.message})
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

	const lifecycle = (verb, pending) => async (input) => {
		await ready
		const m = find(input?.id)
		if (busy.has(m.id)) throw new RpcError('CONFLICT', `${m.name} is busy`)
		if (m.state === 'error') throw new RpcError('PRECONDITION_FAILED', `${m.name} didn’t finish setting up`)
		busy.set(m.id, {state: pending})
		try {
			await virsh(...verb(domain(m.id)))
			if (pending !== 'starting') await dropAnswerFile(m)
		} finally {
			// Let the next list read libvirt's own state.
			setTimeout(() => busy.delete(m.id), pending === 'stopping' ? 0 : 1500)
		}
		return true
	}

	async function uninstall(input) {
		await ready
		const m = find(input?.id)
		if (busy.get(m.id)?.state === 'installing') throw new RpcError('CONFLICT', `${m.name} is still being set up`)
		const states = await domainStates()
		const live = states.get(domain(m.id))
		if (live && live !== 'shut off') await virsh('destroy', domain(m.id)).catch(() => {})
		if (live) await virsh('undefine', domain(m.id), '--nvram').catch(() => virsh('undefine', domain(m.id)))
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
			await save()
			// libvirt applies a changed definition at the next start.
			if (m.state !== 'error' && !busy.has(m.id)) await define(m)
		}
		return true
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

	return {
		ready,
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
		},
	}
}
