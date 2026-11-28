// Virtual machines for omarchyd, on libvirt's per-user session (qemu:///session).
//
// Why the session and not qemu:///system: QEMU then runs as the owner's own user, like the rest
// of omarchyd, so nothing here needs root or the libvirt group (which is root-equivalent).
// Networking is passt (user-mode): each machine shares the host's address, and port forwards
// open ports on the host that lead into it. The screen is VNC on a unix socket in the machine's
// own folder, never on a TCP port; omarchyd bridges it to the web app's console.
//
// Operating systems come from a catalog (MyOwnDataCenter/app-store, machines/catalog.json, with
// a bundled copy as fallback). Images are cloud images: downloaded from the publisher, checked
// against the publisher's checksum file, then copied per machine. cloud-init sets up the account
// on first boot; only a SHA-512 crypt hash of the password is written, never the password.
import {writeAtomic} from './atomic.mjs'
import {createKeyedLock} from './locks.mjs'
import {execFile} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import {constants, createWriteStream} from 'node:fs'
import {access, copyFile, mkdir, readFile, readdir, rename, rm, statfs, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {basename, join} from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {fileURLToPath} from 'node:url'

import {fetchErrorMessage, httpDownloadErrorMessage, isNetworkError} from './fetch-error.mjs'
import {connectorAllowList, connectorCloudInit, connectorKind, defaultConnectorAbilities, guestConnectorExec, guestConnectorPrep, guestConnectorReadyCommand, guestDefaultGateway, guestOwnAddresses, guestReachableUrl} from './guest-install.mjs'
import {PUBLIC_KEY, cloudMetaData, cloudUserData, hostnameFor, isWindowsClientLabel, isWindowsLabel, omarchyConfiguration, omarchyCredentials, windowsAnswerFile} from './machine-media.mjs'
import {createQemuAgent} from './qemu-agent.mjs'
import {remoteGuestAgentRun} from './remote-guest-agent.mjs'
import {RpcError} from './rpc.mjs'
import {hostdevXml, parseUsbLive} from './usb.mjs'
import {stoppedMessage} from './exec-error.mjs'
import {checkLink, fileNameFor, listDownloads, startDownload} from './download.mjs'
import {readNixCache} from './nix-cache.mjs'
import {configDir, ensureConfigDir, readConfiguration, validateNixosConfig, writeCacheFragment, writeConfiguration} from './nixos-config.mjs'

export const CATALOG_URL = 'https://raw.githubusercontent.com/MyOwnDataCenter/app-store/main/machines/catalog.json'
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
				error.message = stoppedMessage(`${cmd} ${args[0] ?? ''}`.trim(), error, timeout) ?? `${cmd} ${args[0] ?? ''}: ${(stderr || error.message).toString().trim().split('\n').slice(-2).join(' ')}`
				return reject(error)
			}
			resolve(stdout.toString())
		})
		if (input !== undefined) child.stdin.end(input)
	})
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'})[c])
const NIXOS_CONFIG_SHARE_TARGET = 'modc-nixos-config'
export function nixosConfigFilesystemXml(sourceDir) {
	return `<filesystem type='mount' accessmode='passthrough'>
  <driver type='virtio-9p' wrpolicy='immediate'/>
  <source dir='${xml(sourceDir)}'/>
  <target dir='${NIXOS_CONFIG_SHARE_TARGET}'/>
  <readonly/>
</filesystem>`
}
// XML 1.0 Char. Tab, LF, and CR are allowed; other controls make libvirt reject the domain.
function xmlChars(s) {
	for (const ch of String(s)) {
		const c = ch.codePointAt(0)
		if (c === 0x9 || c === 0xa || c === 0xd) continue
		if (c >= 0x20 && c <= 0xd7ff) continue
		if (c >= 0xe000 && c <= 0xfffd) continue
		if (c >= 0x10000 && c <= 0x10ffff) continue
		return false
	}
	return true
}
// Backup progress (0-90) from `virsh domjobinfo`. virsh prints each figure in its own most readable unit, so convert both to bytes first.
const UNIT_BYTES = {B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4}
export function backupProgress(info) {
	const m = /Data processed:\s+([\d.]+)\s*(\w+)[\s\S]*Data total:\s+([\d.]+)\s*(\w+)/.exec(info)
	if (!m || !UNIT_BYTES[m[2]] || !UNIT_BYTES[m[4]]) return null
	return Math.min(90, Math.round(((Number(m[1]) * UNIT_BYTES[m[2]]) / Math.max(1, Number(m[3]) * UNIT_BYTES[m[4]])) * 90))
}
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
			(i.kind === 'cloud' || (i.kind === 'iso' && (i.install === 'omarchy' || i.install === 'manual'))),
	)
	return ok.length ? ok : null
}

// Omarchy ISOs install from their own cidata files. Any other catalog ISO boots its installer.
function catalogInstallKind(img) {
	if (img?.kind === 'windows') return 'windows'
	if (img?.kind === 'iso') return img.install === 'omarchy' ? 'omarchy' : 'manual'
	return 'cloud'
}

export function createMachines({dataDir, catalogUrl = CATALOG_URL, fetchImpl = fetch, run = execP, kvmDevice = '/dev/kvm', bundledCatalog = BUNDLED_CATALOG, files = null, arch = hostArch(), statsIntervalMs = 1_000, seriesIntervalMs = 10_000, watchIdleMs = 15_000, connector, qemuAgent = createQemuAgent, connectorEnrollTimeoutMs = 10 * 60 * 1000, connectorAgentWaitMs = 60 * 60 * 1000, isOwner = () => true, usbReleased = null}) {
	const base = join(dataDir, 'machines')
	const imagesDir = join(base, 'images')
	const vmsDir = join(base, 'vms')
	const stateFile = join(base, 'machines.json')
	const virsh = (...args) => run('virsh', ['-c', LIBVIRT, ...args])
	const domain = (id) => `omarchy-${id}`

	let machines = [] // persisted metadata, never secrets
	// False until a missing file (new install) or a readable registry is loaded. save() must not
	// replace a damaged machines.json with this in-memory list.
	let loaded = false
	const busy = new Map() // id -> {state, progress, settling}
	const lock = createKeyedLock()
	const isBusy = (id) => busy.has(id) && !busy.get(id).settling
	const downloads = new Map() // imageId -> {progress, listeners, promise}
	const failedImages = new Map() // imageId -> message
	let catalog = {at: 0, images: null}

	const ready = (async () => {
		await mkdir(imagesDir, {recursive: true, mode: 0o700})
		await mkdir(vmsDir, {recursive: true, mode: 0o700})
		// Only a missing file is a new install. A damaged or unreadable machines.json must stay
		// byte-for-byte: saving [] here would wipe the registry.
		try {
			const text = await readFile(stateFile, 'utf8')
			let data
			try {
				data = JSON.parse(text)
			} catch {
				data = undefined
			}
			if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.machines)) {
				machines = data.machines
				loaded = true
			} else console.error('[omarchyd] couldn’t load machines.json; leaving it unchanged')
		} catch (error) {
			if (error.code === 'ENOENT') loaded = true
			else console.error('[omarchyd] couldn’t load machines.json; leaving it unchanged')
		}
		if (loaded) {
			// A create that was interrupted by a restart can't resume: show it as failed.
			// Machines from before 0.6.1 asked for a virtio display, which QEMU on Arch only has with an
			// extra package: use the built-in standard VGA instead. Only while this server's QEMU lacks it:
			// where it has virtio-vga, a machine set to VirtIO in the Hardware sheet keeps it.
			if (!(await availableVideo()).includes('virtio')) for (const m of machines) if (m.layout?.video === 'virtio') m.layout.video = 'vga'
			for (const m of machines) normalize(m)
			for (const m of machines) {
				if (m.state !== 'installing') continue
				const interrupted = hostOf(m) === 'server' ? 'Setup was interrupted. Delete this machine and create it again.' : 'Creating it was interrupted. Delete it and create it again.'
				Object.assign(m, {state: 'error', errorMessage: interrupted})
			}
			const interruptedAt = Date.now()
			for (const m of machines) {
				for (const t of m.tasks ?? []) {
					if (t.status === 'running') Object.assign(t, {status: 'error', endedAt: interruptedAt, message: 'Interrupted by a restart'})
				}
			}
			await save().catch(() => {})
		}
		await removeUnfinishedBackups()
		autostart()
	})()
	const save = () => {
		if (!loaded) throw new RpcError('PRECONDITION_FAILED', 'machines.json is damaged and was left unchanged')
		return writeAtomic(stateFile, () => JSON.stringify({machines}, null, 2))
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
			if (/^file:\/\//.test(catalogUrl) || catalogUrl.startsWith('/')) {
				const p = catalogUrl.startsWith('/') ? catalogUrl : fileURLToPath(catalogUrl)
				list = validCatalog(JSON.parse(await readFile(p, 'utf8')))
			} else {
				const res = await fetchImpl(catalogUrl, {signal: AbortSignal.timeout(8000)})
				if (res.ok) list = validCatalog(await res.json())
			}
		} catch {}
		if (!list) list = validCatalog(JSON.parse(await readFile(bundledCatalog, 'utf8')))
		catalog = {at: Date.now(), images: list}
		return list
	}
	const imagePath = (img) => join(imagesDir, `${img.id}.${img.kind === 'iso' ? 'iso' : 'qcow2'}`)
	const exists = (p) => access(p).then(() => true, () => false)

	async function osImages() {
		const out = []
		// The catalog stays this server's, both architectures. The form filters to the host.
		for (const img of await images()) {
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
				requiresCredentials: img.install !== 'manual',
				...(img.install === 'omarchy' ? {manualSetup: false} : {}),
				...(img.install === 'manual' ? {manualSetup: true} : {}),
				state,
				...(dl ? {downloadProgress: dl.progress} : {}),
			})
		}
		return out
	}

	// Download an image once (concurrent callers share it) and verify it against the publisher.
	function ensureImage(img, onProgress = () => {}) {
		const running = downloads.get(img.id)
		if (running) {
			// Joining a download that is already going: follow it from where it is.
			running.listeners.push(onProgress)
			if (running.progress) onProgress(running.progress)
			return running.promise
		}
		const entry = {progress: 0, listeners: [onProgress], promise: null}
		entry.promise = (async () => {
			const target = imagePath(img)
			if (await exists(target)) return target
			// Either a checksum pinned in the catalog, or the publisher's own checksum list.
			let expected = img.sha256?.toLowerCase() ?? null
			const algorithm = expected ? 'sha256' : img.checksums.algorithm
			if (!expected) {
				let sums
				try {
					sums = await fetchImpl(img.checksums.url, {signal: AbortSignal.timeout(30_000)})
				} catch (error) {
					throw new Error(fetchErrorMessage(img.name, error))
				}
				if (!sums.ok) throw new Error(httpDownloadErrorMessage(img.name, sums.status))
				expected = findChecksum(await sums.text(), basename(new URL(img.url).pathname), algorithm)
				if (!expected) throw new Error(`${img.name}’s checksum list doesn’t include this image`)
			}
			let res
			try {
				res = await fetchImpl(img.url)
			} catch (error) {
				throw new Error(fetchErrorMessage(img.name, error))
			}
			if (!res.ok || !res.body) throw new Error(httpDownloadErrorMessage(img.name, res.status))
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
					for (const listener of entry.listeners) listener(entry.progress)
				}
			})
			try {
				await pipeline(body, createWriteStream(part, {mode: 0o600}))
				if (hash.digest('hex') !== expected) throw new Error(`${img.name} didn’t match its publisher’s checksum, so it was discarded. Try again later.`)
				await rename(part, target)
			} catch (error) {
				await rm(part, {force: true})
				if (isNetworkError(error)) throw new Error(fetchErrorMessage(img.name, error))
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
	const kvmWarning = 'Hardware virtualization (KVM) isn’t available, so machines run much slower. Turn on VT-x/AMD-V in the BIOS, or nested virtualization if this is itself a VM.'
	async function hostStatus(hostId, ctx) {
		assertOwner(ctx)
		const agent = (await listedAgents()).find((a) => a.id === hostId)
		if (!agent) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		const hostName = agent.name || 'that computer'
		if (!agent.online) throw new RpcError('PRECONDITION_FAILED', `${hostName} is offline right now`)
		return {status: readVmStatus(await remoteCall(hostId, 'vm-status', {})), hostName, agent}
	}
	async function capabilities(input, ctx) {
		const hostId = String(input?.hostId ?? '').trim()
		if (hostId && hostId !== 'server') {
			if (!/^[0-9a-f]{12}$/.test(hostId)) throw new RpcError('BAD_REQUEST', 'That computer isn’t valid.')
			const {status} = await hostStatus(hostId, ctx)
			const libvirtAvailable = status.libvirt === true
			const kvmAvailable = status.kvm === true
			return {
				hostArchitecture: status.arch === 'arm64' ? 'arm64' : 'amd64',
				libvirtAvailable,
				kvmAvailable,
				threads: Number(status.threads) || 1,
				memoryTotalMb: Number(status.memoryMb) || 0,
				...(libvirtAvailable && !kvmAvailable ? {performanceWarning: kvmWarning} : {}),
			}
		}
		const has = async (cmd, args) => run(cmd, args).then(() => true, () => false)
		const libvirtAvailable = (await has('virsh', ['--version'])) && (await has('qemu-img', ['--version']))
		const kvmAvailable = await access(kvmDevice, constants.R_OK | constants.W_OK).then(() => true, () => false)
		return {
			hostArchitecture: arch,
			libvirtAvailable,
			kvmAvailable,
			...(libvirtAvailable && !kvmAvailable ? {performanceWarning: kvmWarning} : {}),
		}
	}

	async function domainStates() {
		const out = new Map()
		if (!machines.some((m) => hostOf(m) === 'server')) return out
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
		// Windows (set up automatically, or an ISO you install by hand) installs without extra drivers on SATA, e1000e and a standard display.
		if (kind === 'windows') return {firmware: 'efi', machineType: 'q35', nic: 'e1000e', video: 'vga', disks: [{...disk, bus: 'sata'}]}
		return {firmware: 'efi', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [disk]}
	}
	const randomMac = () => `52:54:00:${[...randomBytes(3)].map((b) => b.toString(16).padStart(2, '0')).join(':')}`
	const nextVmid = () => {
		let n = 100
		while (machines.some((x) => x.vmid === n)) n++
		return n
	}
	function hostOf(m) {
		return m?.hostId && m.hostId !== 'server' ? m.hostId : 'server'
	}
	function assertOwner(ctx) {
		if (!isOwner(ctx)) throw new RpcError('FORBIDDEN', 'Only the server’s owner can manage virtual machines on another computer.')
	}
	function assertLocal(m) {
		if (hostOf(m) !== 'server') throw new RpcError('PRECONDITION_FAILED', `${m.name} is on another computer. That action isn’t available there yet.`)
	}
	async function listedAgents() {
		try {
			const listed = await connector?.list?.()
			return Array.isArray(listed) ? listed : []
		} catch {
			return []
		}
	}
	async function hostAgent(m) {
		const hostId = hostOf(m)
		const agent = (await listedAgents()).find((a) => a.id === hostId)
		if (!agent) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		return {hostId, hostName: agent.name || 'that computer', agent}
	}
	async function requireRemote(m, ctx) {
		assertOwner(ctx)
		const info = await hostAgent(m)
		if (!info.agent.online) throw new RpcError('PRECONDITION_FAILED', `${info.hostName} is offline right now`)
		if (!info.agent.allowed?.vms || !info.agent.on?.vms) throw new RpcError('FORBIDDEN', `Pair ${info.hostName} again with Virtual machines switched on.`)
		return info
	}
	function parseVmState(raw) {
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
		try {
			const parsed = JSON.parse(String(raw ?? ''))
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
		} catch {}
		return {}
	}
	async function remoteCall(hostId, name, args = {}) {
		const timeout = name === 'vm-fetch' || name === 'vm-disk-create' ? 30 * 60_000 : name === 'vm-status' ? 30_000 : 120_000
		try {
			return await connector.call(hostId, name, args, timeout)
		} catch (error) {
			if (error instanceof RpcError) throw error
			throw new RpcError('BAD_GATEWAY', String(error?.message ?? error).replace(/\s+/g, ' ').trim().slice(0, 300))
		}
	}
	async function remoteLive(m) {
		try {
			const word = parseVmState(await remoteCall(hostOf(m), 'vm-state', {}))[domain(m.id)]
			if (word == null) return m.hostState ?? 'stopped'
			const live = STATE[word] ?? 'stopped'
			m.hostState = live
			return live
		} catch {
			return m.hostState ?? 'stopped'
		}
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
		m.usbDevices = Array.isArray(m.usbDevices) ? m.usbDevices : []
		// Missing or corrupt hostId stays on this server. Only 'server' or a 12-hex agent id may dispatch.
		m.hostId = m.hostId === 'server' || /^[0-9a-f]{12}$/.test(String(m.hostId ?? '')) ? m.hostId : 'server'
		// Machines saved before 0.4.0 have no layout. Hardware reads m.layout.disks, so give them the cloud wiring.
		if (!m.layout) m.layout = layoutFor('cloud', join(vmsDir, m.id))
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
	// The list carries the start of each machine's notes, so they can be searched; the full text is in its details.
	const LIST_NOTES_MAX = 500
const NICS = ['virtio', 'e1000e', 'e1000', 'rtl8139']
const CACHES = ['default', 'none', 'writeback', 'writethrough', 'directsync', 'unsafe']
const BUSES = ['virtio', 'sata', 'scsi', 'ide']
function domainXml(m, kvm, uuid = '') {
		const dir = join(vmsDir, m.id)
		const layout = m.layout ?? layoutFor('cloud', dir)
		const o = m.options ?? {}
		const useKvm = kvm && o.kvm !== false
		const boot = m.boot ?? [layout.disks.find((x) => x.device === 'disk')?.id]
		const order = (id) => (boot.includes(id) ? `<boot order='${boot.indexOf(id) + 1}'/>` : '')
		// ARM (Omarchy on Apple Silicon, Snapdragon, …): QEMU's "virt" machine, always UEFI, no
		// SATA/IDE (drives that asked for them go on SCSI) and virtio graphics.
		const arm = arch === 'arm64'
		const busOf = (d) => (arm && (d.bus === 'sata' || d.bus === 'ide') ? 'scsi' : d.bus)
		const names = targets({...layout, disks: layout.disks.map((d) => ({...d, bus: busOf(d)}))})
		const forwards = (m.portForwards ?? [])
			.map((f) => `<portForward proto='${f.protocol}'><range start='${f.hostPort}' to='${f.guestPort}'/></portForward>`)
			.join('')
		const disks = layout.disks
			.map((d) => {
				const cdrom = d.device === 'cdrom'
				const cache = d.cache && d.cache !== 'default' ? ` cache='${d.cache}'` : ''
				const discard = !cdrom && d.discard !== false ? " discard='unmap'" : ''
				const source = d.file ? `<source ${cdrom ? "startupPolicy='optional' " : ''}file='${xml(d.file)}'/>` : ''
				// A virtio disk does its I/O on its own thread instead of the main QEMU loop, which also runs the display and the network.
				const iothread = !cdrom && busOf(d) === 'virtio' ? " iothread='1'" : ''
				return `<disk type='file' device='${d.device}'><driver name='qemu' type='${d.format}'${cache}${discard}${iothread}/>${source}<target dev='${names.get(d.id)}' bus='${busOf(d)}'/>${order(d.id)}${cdrom ? '<readonly/>' : ''}</disk>`
			})
			.join('\n    ')
		const scsi = layout.disks.some((d) => busOf(d) === 'scsi') ? "\n    <controller type='scsi' model='virtio-scsi'><driver iothread='1'/></controller>" : ''
		const iothreads = /iothread='1'/.test(disks + scsi) ? "\n  <iothreads>1</iothreads>" : ''
		const machine = arm ? 'virt' : layout.machineType === 'pc' ? 'pc' : 'q35'
		const cpuArch = arm ? 'aarch64' : 'x86_64'
		const bootmenu = o.bootMenu ? "<bootmenu enable='yes' timeout='3000'/>" : ''
		const nvramEl = layout.nvram ? `<nvram>${xml(layout.nvram)}</nvram>` : ''
		const os =
			layout.firmware === 'efi' || arm
				? `<os firmware='efi'><type arch='${cpuArch}' machine='${machine}'>hvm</type><firmware><feature enabled='no' name='secure-boot'/></firmware>${nvramEl}${bootmenu}</os>`
				: `<os><type arch='${cpuArch}' machine='${machine}'>hvm</type>${bootmenu}</os>`
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
  <name>${domain(m.id)}</name>${uuid ? `\n  <uuid>${uuid}</uuid>` : ''}
  <title>${xml(m.name)}</title>${o.notes ? `\n  <description>${xml(o.notes)}</description>` : ''}
  <memory unit='MiB'>${memoryMb}</memory>
  <vcpu>${sockets * m.cores}</vcpu>${iothreads}
  ${os}
  <features>${o.acpi === false ? '' : '<acpi/>'}${arm ? '' : '<apic/>'}</features>
  ${cpu}
  <on_reboot>restart</on_reboot>
  <devices>
    ${disks}${scsi}
    ${nic}
    <serial type='pty'/><console type='pty'/>
    <graphics type='vnc' socket='${xml(join(dir, 'vnc.sock'))}'/>
    <video><model type='${arm && layout.video !== 'none' ? 'virtio' : layout.video}'/></video>${o.tablet === false ? '' : "\n    <input type='tablet' bus='usb'/>"}${o.agent ? "\n    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>" : ''}
    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>
    ${(m.usbDevices ?? []).map((d) => hostdevXml(d)).join('\n    ')}${m.nixos ? `\n    ${nixosConfigFilesystemXml(configDir(dataDir, m.id))}` : ''}
  </devices>
</domain>
`
	}
	// A domain XML with no uuid is a new domain. Defining that name again makes libvirt
	// invent a second uuid and refuse: the name already exists with the first one.
	async function definedUuid(id) {
		try {
			const text = String(await virsh('domuuid', domain(id))).trim()
			return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? text.toLowerCase() : ''
		} catch {
			return ''
		}
	}
	async function define(m) {
		if (m.nixos) await ensureConfigDir(dataDir, m.id)
		if (hostOf(m) !== 'server') {
			const status = readVmStatus(await remoteCall(hostOf(m), 'vm-status', {}))
			await remoteCall(hostOf(m), 'vm-define', {guestId: m.id, spec: defineSpec(m, status)})
			return
		}
		const dir = join(vmsDir, m.id)
		await mkdir(dir, {recursive: true, mode: 0o700})
		const file = join(dir, 'domain.xml')
		const kvm = await access(kvmDevice, constants.R_OK | constants.W_OK).then(() => true, () => false)
		const uuid = await definedUuid(m.id)
		await writeFile(file, domainXml(m, kvm, uuid), {mode: 0o600})
		await virsh('define', file)
	}
	// libvirt and qemu throw plain errors. The RPC layer would otherwise hide them as "Internal error".
	function engineFailure(error, name, action) {
		if (error instanceof RpcError) return error
		const detail = String(error?.message ?? error).replace(/\s+/g, ' ').trim().slice(-300)
		console.error(`[omarchyd] ${action} ${name}:`, error)
		return new RpcError('BAD_GATEWAY', `${name} couldn’t ${action}: ${detail}`)
	}
	const alreadyActive = (error) => /already (?:running|active)/i.test(String(error?.message ?? error))

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
		await mediaIso(m, 'seed', 'cidata', {'user-data': cloudUserData({host, username, hash, cloudInit: connectorCloudInit({...img, username, cloudInit: {adminGroup: img.adminGroup, ...img.cloudInit}})}), 'meta-data': cloudMetaData(host)})
	}

	// Add an ISO from a link: it's saved in Downloads (as .part until complete), where Your ISOs finds it.
	const isoDownloads = new Map()
	async function downloadIso(input = {}) {
		if (!files) throw new RpcError('PRECONDITION_FAILED', 'Server file storage isn’t available')
		const url = await checkLink(input?.url)
		const name = fileNameFor(url, /\.iso$/i)
		if (!name) throw new RpcError('BAD_REQUEST', 'The link has to end in .iso')
		const {real: dir} = await files.resolve('/Home/Downloads', {mustExist: false})
		await mkdir(dir, {recursive: true})
		return startDownload({url, dir, name, jobs: isoDownloads, fetchImpl})
	}

	// Your own ISOs: anything ending in .iso in Home (a few folders deep), with its volume label.
	const labels = new Map() // real path + mtime -> label
	async function isoLabel(real) {
		const st = await stat(real)
		const key = `${real}:${st.mtimeMs}`
		if (!labels.has(key)) {
			const out = await run('xorriso', ['-indev', real, '-pvd_info'], {timeout: 30_000}).catch(() => '')
			labels.set(key, (/Volume Id\s*:\s*(.+?)\s*$/im.exec(out)?.[1] ?? '').replace(/^'(.*)'$/, '$1'))
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
				else if (e.isFile() && /\.iso$/i.test(e.name) && found.length < 50) found.push(full)
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
	const forwardKey = (f) => `${f.protocol}:${f.hostPort}->${f.guestPort}`
	const forwardsFor = (m, state) => (m.portForwards ?? []).map((f) => (state === 'running' && m.pending && Array.isArray(m.liveForwards) && !m.liveForwards.includes(forwardKey(f)) ? {...f, pending: true} : f))
	async function list() {
		await ready
		touchWatch()
		const states = await domainStates()
		const agents = await listedAgents()
		const remoteState = new Map()
		const hosts = [...new Set(machines.map((m) => hostOf(m)).filter((h) => h !== 'server'))]
		let persist = false
		for (const hostId of hosts) {
			if (!agents.find((a) => a.id === hostId)?.online) continue
			try {
				remoteState.set(hostId, parseVmState(await remoteCall(hostId, 'vm-state', {})))
			} catch {}
		}
		const rows = machines.map((m) => {
			const host = hostOf(m)
			const b = busy.get(m.id)
			let live
			if (host === 'server') live = STATE[states.get(domain(m.id))]
			else if (remoteState.has(host)) {
				live = STATE[remoteState.get(host)[domain(m.id)]] ?? 'stopped'
				if (m.hostState !== live) persist = true
				m.hostState = live
			} else live = m.hostState ?? 'stopped'
			const state = b?.state ?? (m.state === 'error' ? 'error' : m.state === 'installing' ? 'installing' : (live ?? 'stopped'))
			return {
				id: m.id,
				vmid: m.vmid,
				name: m.name,
				hostId: m.hostId,
				osId: m.osId,
				cores: m.cores * (m.sockets ?? 1),
				memoryGb: m.memoryGb,
				memoryMb: m.memoryMb,
				diskSizeGb: m.diskSizeGb,
				...(m.options?.notes ? {notes: m.options.notes.slice(0, LIST_NOTES_MAX)} : {}),
				state: host === 'server' && state === 'stopped' && m.hibernated ? 'hibernated' : state,
				...(m.pending && state === 'running' ? {pending: true} : {}),
				...(m.options?.protection ? {protected: true} : {}),
				...(m.options?.onBoot ? {onBoot: true} : {}),
				networkMode: 'nat',
				portForwards: forwardsFor(m, state),
				...(b?.progress !== undefined ? {installProgress: b.progress} : {}),
				...(state === 'error' && m.errorMessage ? {errorMessage: m.errorMessage} : {}),
				...(m.nixos ? {nixos: true} : {}),
			}
		})
		if (persist) await save().catch(() => {})
		return rows
	}

	function readVmStatus(raw) {
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
		try {
			const parsed = JSON.parse(String(raw ?? ''))
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
		} catch {}
		throw new RpcError('BAD_GATEWAY', 'That computer didn’t answer with a valid status')
	}
	function defineSpec(m, status) {
		const layout = m.layout
		const o = m.options ?? {}
		const disks = (layout.disks ?? []).map((d) => {
			const disk = {id: d.id, device: d.device, bus: d.bus, format: d.format}
			if (d.role) disk.role = d.role
			if (d.cache) disk.cache = d.cache
			if (typeof d.discard === 'boolean') disk.discard = d.discard
			if (d.file) disk.file = String(d.file).startsWith('image:') ? d.file : basename(d.file)
			return disk
		})
		return {
			id: m.id,
			name: m.name,
			memoryMb: m.memoryMb,
			sockets: m.sockets ?? 1,
			cores: m.cores,
			cpuType: m.cpuType ?? 'host',
			mac: m.mac,
			linkDown: !!m.linkDown,
			firmware: layout.firmware === 'efi' ? 'efi' : 'bios',
			arch: status.arch === 'arm64' ? 'arm64' : 'amd64',
			machineType: layout.machineType === 'pc' ? 'pc' : 'q35',
			nic: layout.nic,
			video: layout.video,
			kvm: status.kvm === true && o.kvm !== false,
			tablet: o.tablet !== false,
			acpi: o.acpi !== false,
			agent: o.agent === true,
			bootMenu: !!o.bootMenu,
			notes: typeof o.notes === 'string' ? o.notes : '',
			boot: m.boot ?? [layout.disks.find((d) => d.device === 'disk')?.id ?? 'disk0'],
			disks,
			portForwards: (m.portForwards ?? []).map((f) => ({protocol: f.protocol, hostPort: f.hostPort, guestPort: f.guestPort})),
			...(m.nixos
				? {
						filesystems: [{source: configDir(dataDir, m.id), target: NIXOS_CONFIG_SHARE_TARGET, readonly: true}],
					}
				: {}),
		}
	}
	function layoutBasenames(kind, img) {
		const layout = layoutFor(kind, '', img)
		for (const d of layout.disks) if (d.file) d.file = basename(d.file)
		return layout
	}
	async function recordNixosOnCreate(input, img, id) {
		const nixos = img?.nixos === true || img?.familyId === 'nixos'
		if (input.nixosConfig && !nixos) throw new RpcError('BAD_REQUEST', 'NixOS configuration is only for NixOS images.')
		if (nixos && input.nixosConfig) {
			const checked = validateNixosConfig(input.nixosConfig)
			if (!checked.ok) throw new RpcError('BAD_REQUEST', checked.error)
			if (checked.config.trim()) {
				await writeConfiguration(dataDir, id, checked.config)
				const cache = await readNixCache(dataDir)
				await writeCacheFragment(dataDir, id, cache)
			}
		}
		return nixos
	}
	async function hostCall(hostId, guestId, name, args) {
		const timeout = name === 'vm-fetch' || name === 'vm-disk-create' ? 30 * 60_000 : name === 'vm-status' ? 30_000 : 120_000
		const apply = () => {
			if (!guestId) return
			const p = connector?.progress?.(hostId)
			if (p && typeof p.percent === 'number') busy.set(guestId, {state: 'installing', progress: Math.round((p.percent ?? 0) * 100)})
		}
		apply()
		const timer = setInterval(apply, 200)
		timer.unref?.()
		try {
			return await connector.call(hostId, name, args, timeout)
		} finally {
			clearInterval(timer)
			apply()
		}
	}

	async function createOnHost(input, ctx, hostId) {
		assertOwner(ctx)
		await ready
		const nameKey = String(input.name ?? '').trim().toLowerCase()
		const runCreate = async () => {
			let listed = []
			try {
				listed = await connector?.list?.()
			} catch {}
			const agents = Array.isArray(listed) ? listed : []
			const agent = agents.find((a) => a.id === hostId)
			if (!agent) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
			const hostName = agent.name || 'that computer'
			if (!agent.online) throw new RpcError('PRECONDITION_FAILED', `${hostName} is offline right now`)
			if (!agent.allowed?.vms || !agent.on?.vms) throw new RpcError('FORBIDDEN', `Pair ${hostName} again with Virtual machines switched on.`)
			let status
			try {
				status = readVmStatus(await hostCall(hostId, '', 'vm-status', {}))
			} catch (error) {
				if (error instanceof RpcError) throw error
				throw new RpcError('BAD_GATEWAY', String(error.message ?? error))
			}
			if (status.libvirt !== true) throw new RpcError('PRECONDITION_FAILED', `Virtual machines need libvirt and QEMU on ${hostName}. Run the connector install again with Virtual machines switched on.`)
			const osId = String(input.osId ?? '')
			if (osId.startsWith('local:')) throw new RpcError('PRECONDITION_FAILED', 'That ISO is on this server. Create this machine here.')
			const hostArch = status.arch === 'arm64' ? 'arm64' : 'amd64'
			const img = (await images()).find((i) => i.id === osId)
			if (!img || img.arch !== hostArch) throw new RpcError('BAD_REQUEST', `That operating system isn’t available on ${hostName}`)
			const kind = catalogInstallKind(img)
			if (kind === 'windows' && hostArch !== 'amd64') throw new RpcError('PRECONDITION_FAILED', `Installing Windows from its ISO needs an x86-64 computer`)
			const name = String(input.name ?? '').trim()
			if (!name || [...name].length > 64) throw new RpcError('BAD_REQUEST', 'Give the machine a name (up to 64 characters)')
			if (!xmlChars(name)) throw new RpcError('BAD_REQUEST', 'That name can’t be used')
			if (machines.some((m) => m.name.toLowerCase() === name.toLowerCase())) throw new RpcError('CONFLICT', 'A machine with that name already exists')
			const threads = Number(status.threads) || 1
			const totalGb = Math.max(1, Math.floor(Number(status.memoryMb) / 1024) - 1)
			const cores = Number(input.cores)
			const memoryGb = Number(input.memoryGb)
			const diskSizeGb = Number(input.diskSizeGb)
			const minDisk = kind === 'windows' ? 64 : kind === 'omarchy' || img.kind === 'iso' ? 20 : 4
			if (!Number.isInteger(cores) || cores < 1 || cores > threads) throw new RpcError('BAD_REQUEST', `Cores must be between 1 and ${threads}`)
			if (!Number.isInteger(memoryGb) || memoryGb < 1 || memoryGb > totalGb) throw new RpcError('BAD_REQUEST', `Not enough memory on ${hostName} for that`)
			if (!Number.isInteger(diskSizeGb) || diskSizeGb < minDisk || diskSizeGb > 4096) throw new RpcError('BAD_REQUEST', `Disk size must be between ${minDisk} and 4096 GB`)
			const needsAccount = kind !== 'manual'
			const username = String(input.username ?? '').trim()
			const password = String(input.password ?? '')
			if (needsAccount) {
				const userOk = kind === 'windows' ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/.test(username) && !/^(administrator|guest)$/i.test(username) : /^[a-z_][a-z0-9_-]{0,31}$/.test(username) && username !== 'root'
				if (!userOk) throw new RpcError('BAD_REQUEST', kind === 'windows' ? 'Use a username of letters, numbers, - and _ (up to 20)' : 'Use a lower-case username: letters, numbers, - and _ (not root)')
				if (password.length < 1 || password.length > 256 || /[\x00-\x1f\x7f]/.test(password)) throw new RpcError('BAD_REQUEST', 'Enter a password for the machine')
			}
			const freeGb = Number(status.freeGb) || 0
			const needGb = ((Number(img.sizeMb) || 1024) * 3) / 1024 + 2
			if (freeGb < needGb) throw new RpcError('PRECONDITION_FAILED', `Not enough free space: about ${Math.ceil(needGb)} GB is needed to set it up`)

			let id
			do id = randomBytes(4).toString('hex')
			while (machines.some((m) => m.id === id))
			const nixos = await recordNixosOnCreate(input, img, id)
			const layout = layoutBasenames(kind === 'cloud' ? 'cloud' : kind === 'windows' ? 'windows' : 'iso', img)
			if (kind === 'omarchy' || kind === 'windows' || kind === 'manual') {
				layout.disks.splice(1, 0, {id: 'cd0', file: `image:${img.id}`, device: 'cdrom', bus: 'sata', format: 'raw'})
				if (kind === 'omarchy') layout.disks.push({id: 'seed', role: 'seed', file: 'seed.iso', device: 'cdrom', bus: 'sata', format: 'raw'})
				else if (kind === 'windows') layout.disks.push({id: 'answer', role: 'answer', file: 'answer.iso', device: 'cdrom', bus: 'sata', format: 'raw'})
			}
			const m = normalize({
				id,
				name,
				osId,
				hostId,
				cores,
				memoryGb,
				memoryMb: memoryGb * 1024,
				diskSizeGb,
				portForwards: [],
				createdAt: Date.now(),
				state: 'installing',
				options: {agent: true},
				layout,
				...(kind === 'omarchy' || kind === 'windows' || kind === 'manual' ? {boot: ['disk0', 'cd0']} : {}),
			})
			if (nixos) m.nixos = true
			if (kind === 'cloud' || kind === 'omarchy') m.cloudInit = {username, hostname: hostnameFor(name, id), sshKeys: []}
			machines.push(m)
			try {
				await save()
			} catch (error) {
				machines = machines.filter((x) => x.id !== m.id)
				throw error
			}
			busy.set(id, {state: 'installing', progress: 0})
			const step = (progress) => busy.set(id, {state: 'installing', progress})
			const host = hostnameFor(name, id)
			const t = beginTask(m, 'create')

			;(async () => {
				try {
					const hash = kind === 'cloud' || kind === 'omarchy' ? await hashPassword(password) : null
					if (kind === 'cloud') {
						await hostCall(hostId, id, 'vm-seed', {
							guestId: id,
							name: 'seed',
							label: 'cidata',
							files: {
								'user-data': cloudUserData({host, username, hash, cloudInit: connectorCloudInit({...img, username, cloudInit: {adminGroup: img.adminGroup, ...img.cloudInit}})}),
								'meta-data': cloudMetaData(host),
							},
						})
						step(5)
						await hostCall(hostId, id, 'vm-fetch', {imageId: img.id, catalogUrl})
						step(80)
						await hostCall(hostId, id, 'vm-disk-create', {guestId: id, sizeGb: diskSizeGb, imageId: img.id})
					} else if (kind === 'omarchy') {
						await hostCall(hostId, id, 'vm-seed', {
							guestId: id,
							name: 'seed',
							label: 'cidata',
							files: {
								'user_configuration.json': JSON.stringify(omarchyConfiguration({host, diskSizeGb})),
								'user_credentials.json': JSON.stringify(omarchyCredentials({username, hash})),
							},
						})
						step(5)
						await hostCall(hostId, id, 'vm-fetch', {imageId: img.id, catalogUrl})
						step(80)
						await hostCall(hostId, id, 'vm-disk-create', {guestId: id, sizeGb: diskSizeGb})
					} else if (kind === 'manual') {
						await hostCall(hostId, id, 'vm-fetch', {imageId: img.id, catalogUrl})
						step(80)
						await hostCall(hostId, id, 'vm-disk-create', {guestId: id, sizeGb: diskSizeGb})
					} else {
						await hostCall(hostId, id, 'vm-seed', {
							guestId: id,
							name: 'answer',
							label: 'OMARCHY_ANSWER',
							files: {'autounattend.xml': windowsAnswerFile({computerName: host.toUpperCase(), username, password})},
						})
						step(5)
						await hostCall(hostId, id, 'vm-fetch', {imageId: img.id, catalogUrl})
						step(80)
						await hostCall(hostId, id, 'vm-disk-create', {guestId: id, sizeGb: diskSizeGb})
					}
					step(90)
					await hostCall(hostId, id, 'vm-define', {guestId: id, spec: defineSpec(m, status)})
					step(96)
					await hostCall(hostId, id, 'vm-start', {guestId: id})
					step(100)
					m.liveForwards = (m.portForwards ?? []).map(forwardKey)
					delete m.state
					delete m.errorMessage
					m.hostState = 'running'
					endTask(m, t)
				} catch (error) {
					Object.assign(m, {state: 'error', errorMessage: error.message})
					endTask(m, t, error)
				} finally {
					busy.delete(id)
					await save().catch(() => {})
				}
				if (!m.state && username && connectorKind(osId) !== 'unsupported') waitForGuestConnector(id, username)
			})()
			return {id}
		}
		return nameKey ? lock(`create:${nameKey}`, runCreate) : runCreate()
	}

	async function create(input = {}, ctx) {
		const hostId = String(input.hostId ?? '').trim()
		if (hostId && hostId !== 'server') {
			if (!/^[0-9a-f]{12}$/.test(hostId)) throw new RpcError('BAD_REQUEST', 'That computer isn’t valid.')
			return createOnHost(input, ctx, hostId)
		}
		await ready
		const nameKey = String(input.name ?? '').trim().toLowerCase()
		const runCreate = async () => {
			const caps = await capabilities()
			if (!caps.libvirtAvailable) throw new RpcError('PRECONDITION_FAILED', 'Virtual machines need libvirt and QEMU. Run the installer again to add them.')
			// x86-64 and ARM servers both run machines of their own kind (an ARM server runs ARM images).
			if (!['amd64', 'arm64'].includes(caps.hostArchitecture)) throw new RpcError('PRECONDITION_FAILED', 'Machines need an x86-64 or ARM 64-bit server')
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
			const kind = local ? (local.requiresCredentials ? 'windows' : 'manual') : catalogInstallKind(img)
			// Windows set up from its ISO (and its answer file) is the x86 PC kind.
			if (kind === 'windows' && caps.hostArchitecture !== 'amd64') throw new RpcError('PRECONDITION_FAILED', 'Installing Windows from its ISO needs an x86-64 server')
			const name = String(input.name ?? '').trim()
			if (!name || [...name].length > 64) throw new RpcError('BAD_REQUEST', 'Give the machine a name (up to 64 characters)')
			if (!xmlChars(name)) throw new RpcError('BAD_REQUEST', 'That name can’t be used')
			if (machines.some((m) => m.name.toLowerCase() === name.toLowerCase())) throw new RpcError('CONFLICT', 'A machine with that name already exists')
			const threads = os.cpus().length || 1
			const totalGb = Math.floor(os.totalmem() / 1024 ** 3)
			const cores = Number(input.cores)
			const memoryGb = Number(input.memoryGb)
			const diskSizeGb = Number(input.diskSizeGb)
			const minDisk = kind === 'windows' ? 64 : kind === 'omarchy' || (img && img.kind === 'iso') ? 20 : 4
			if (!Number.isInteger(cores) || cores < 1 || cores > threads) throw new RpcError('BAD_REQUEST', `Cores must be between 1 and ${threads}`)
			if (!Number.isInteger(memoryGb) || memoryGb < 1 || memoryGb > Math.max(1, totalGb - 1)) throw new RpcError('BAD_REQUEST', 'Not enough memory on the server for that')
			if (!Number.isInteger(diskSizeGb) || diskSizeGb < minDisk || diskSizeGb > 4096) throw new RpcError('BAD_REQUEST', `Disk size must be between ${minDisk} and 4096 GB`)
			const needsAccount = kind !== 'manual'
			const username = String(input.username ?? '').trim()
			const password = String(input.password ?? '')
			if (needsAccount) {
				const userOk = kind === 'windows' ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/.test(username) && !/^(administrator|guest)$/i.test(username) : /^[a-z_][a-z0-9_-]{0,31}$/.test(username) && username !== 'root'
				if (!userOk) throw new RpcError('BAD_REQUEST', kind === 'windows' ? 'Use a username of letters, numbers, - and _ (up to 20)' : 'Use a lower-case username: letters, numbers, - and _ (not root)')
				if (password.length < 1 || password.length > 256 || /[\x00-\x1f\x7f]/.test(password)) throw new RpcError('BAD_REQUEST', 'Enter a password for the machine')
			}
			const fs = await statfs(base)
			const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3
			const needGb = img ? ((Number(img.sizeMb) || 1024) * 3) / 1024 + 2 : 4
			if (freeGb < needGb) throw new RpcError('PRECONDITION_FAILED', `Not enough free space: about ${Math.ceil(needGb)} GB is needed to set it up`)

			let id
			do id = randomBytes(4).toString('hex')
			while (machines.some((m) => m.id === id))
			const nixos = await recordNixosOnCreate(input, img, id)
			const dir = join(vmsDir, id)
			const m = normalize({id, name, osId, cores, memoryGb, memoryMb: memoryGb * 1024, diskSizeGb, portForwards: [], createdAt: Date.now(), state: 'installing', options: {agent: true}, layout: layoutFor(kind === 'cloud' ? 'cloud' : kind === 'windows' || local?.platform === 'windows' ? 'windows' : 'iso', dir, img)})
			if (nixos) m.nixos = true
			if (kind === 'cloud' || kind === 'omarchy') m.cloudInit = {username, hostname: hostnameFor(name, id), sshKeys: []}
			machines.push(m)
			try {
				await save()
			} catch (error) {
				machines = machines.filter((x) => x.id !== m.id)
				throw error
			}
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
					// Write beside the final name. A crash while qemu-img is writing must not leave a bootable disk.qcow2.
					const part = join(dir, 'disk.qcow2.part')
					const disk = join(dir, 'disk.qcow2')
					if (kind === 'cloud') {
						const src = await ensureImage(img, (p) => step(5 + Math.floor(p * 0.75)))
						step(82)
						await run('qemu-img', ['convert', '-O', 'qcow2', src, part], {timeout: 30 * 60_000})
						await run('qemu-img', ['resize', part, `${diskSizeGb}G`])
						await rename(part, disk)
					} else {
						// Installer ISOs: a blank disk, booted from the installer until something is on it.
						const iso = img ? await ensureImage(img, (p) => step(5 + Math.floor(p * 0.8))) : local.real
						step(88)
						await run('qemu-img', ['create', '-f', 'qcow2', part, `${diskSizeGb}G`])
						await rename(part, disk)
						m.layout.disks.splice(1, 0, {id: 'cd0', file: iso, device: 'cdrom', bus: 'sata', format: 'raw'})
						m.boot = ['disk0', 'cd0']
					}
					step(92)
					await define(m)
					step(97)
					await virsh('start', domain(id))
					m.liveForwards = (m.portForwards ?? []).map(forwardKey)
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
				if (!m.state && username && connectorKind(osId) !== 'unsupported') waitForGuestConnector(id, username)
			})()
			return {id}
		}
		return nameKey ? lock(`create:${nameKey}`, runCreate) : runCreate()
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
	const remotePowerName = (pending, verb, id) => {
		if (pending === 'starting') return 'vm-start'
		if (pending === 'restarting') return 'vm-reboot'
		if (pending === 'pausing') return 'vm-suspend'
		if (pending === 'resuming') return 'vm-resume'
		if (pending === 'stopping') return verb(domain(id))[0] === 'destroy' ? 'vm-destroy' : 'vm-shutdown'
		return null
	}
	async function remotePower(m, pending, verb, ctx) {
		await requireRemote(m, ctx)
		if (isBusy(m.id)) throw new RpcError('CONFLICT', `${m.name} is busy`)
		const callName = remotePowerName(pending, verb, m.id)
		if (!callName) throw new RpcError('PRECONDITION_FAILED', `${m.name} is on another computer. That action isn’t available there yet.`)
		if (m.state === 'error') {
			if (pending !== 'starting') throw new RpcError('PRECONDITION_FAILED', `${m.name} didn’t finish setting up. Delete it and create it again.`)
			let hasDisk = false
			try {
				const inspect = await remoteCall(hostOf(m), 'vm-inspect', {guestId: m.id})
				const parsed = inspect && typeof inspect === 'object' ? inspect : JSON.parse(String(inspect ?? 'null'))
				const disks = Array.isArray(parsed?.disks) ? parsed.disks : []
				hasDisk = disks.some((d) => /(^|\/)disk\.qcow2$/.test(String(d?.file ?? '')))
			} catch {}
			if (!hasDisk) throw new RpcError('PRECONDITION_FAILED', `${m.name} didn’t finish setting up. Delete it and create it again.`)
			try {
				await define(m)
			} catch (error) {
				throw engineFailure(error, m.name, 'start')
			}
			delete m.state
			delete m.errorMessage
			await save()
		}
		const force = callName === 'vm-destroy'
		const action = force ? 'stop' : {starting: 'start', stopping: 'shut down', restarting: 'restart', pausing: 'pause', resuming: 'resume'}[pending] ?? pending
		const t = beginTask(m, force ? 'stop' : VERBS[pending] ?? pending)
		busy.set(m.id, {state: pending})
		try {
			if (pending === 'restarting' && m.pending) {
				await remoteCall(hostOf(m), 'vm-shutdown', {guestId: m.id})
				const end = Date.now() + 180_000
				for (;;) {
					const word = parseVmState(await remoteCall(hostOf(m), 'vm-state', {}))[domain(m.id)]
					if (word === 'shut off' || word == null) break
					if (Date.now() > end) throw new Error(`${m.name} didn’t shut down within 3 minutes; use Stop, then Start`)
					await new Promise((r) => setTimeout(r, 1000))
				}
				await define(m)
				try {
					await remoteCall(hostOf(m), 'vm-start', {guestId: m.id})
				} catch (error) {
					if (!alreadyActive(error)) throw error
				}
			} else if (pending === 'starting') {
				try {
					await remoteCall(hostOf(m), 'vm-start', {guestId: m.id})
				} catch (error) {
					if (!alreadyActive(error)) throw error
				}
			} else {
				await remoteCall(hostOf(m), callName, {guestId: m.id})
			}
			if (pending === 'starting' || pending === 'restarting') {
				delete m.pending
				delete m.hibernated
				m.liveForwards = (m.portForwards ?? []).map(forwardKey)
			}
			if (force) delete m.liveForwards
			endTask(m, t)
		} catch (error) {
			endTask(m, t, error)
			throw engineFailure(error, m.name, action)
		} finally {
			await save().catch(() => {})
			const entry = {...busy.get(m.id), settling: true}
			if (pending === 'pausing' || pending === 'resuming') busy.delete(m.id)
			else busy.set(m.id, entry)
			setTimeout(() => busy.get(m.id) === entry && busy.delete(m.id), pending === 'stopping' ? 0 : 1500)
		}
		return true
	}
	const lifecycle = (verb, pending) => async (input, ctx) => {
		await ready
		const m = find(input?.id)
		if (pending === 'hibernating') assertLocal(m)
		if (hostOf(m) !== 'server') return remotePower(m, pending, verb, ctx)
		if (isBusy(m.id)) throw new RpcError('CONFLICT', `${m.name} is busy`)
		let defined = false
		if (m.state === 'error') {
			// If setup got as far as this machine's own disk, Start finishes it: define again and boot.
			// A failed copy still names the source machine's files, and those must not be booted.
			const own = `${join(vmsDir, m.id)}/`
			const ownDisks = (m.layout?.disks ?? []).every((d) => d.device !== 'disk' || !d.file || d.file.startsWith(own))
			if (pending !== 'starting' || !ownDisks || !(await exists(join(vmsDir, m.id, 'disk.qcow2')))) throw new RpcError('PRECONDITION_FAILED', `${m.name} didn’t finish setting up. Delete it and create it again.`)
			try {
				await define(m)
			} catch (error) {
				throw engineFailure(error, m.name, 'start')
			}
			defined = true
			delete m.state
			delete m.errorMessage
			await save()
		}
		const action = pending === 'stopping' && verb(domain(m.id))[0] === 'destroy' ? 'stop' : {starting: 'start', stopping: 'shut down', restarting: 'restart', pausing: 'pause', resuming: 'resume', hibernating: 'hibernate'}[pending] ?? pending
		const t = beginTask(m, pending === 'stopping' && verb(domain(m.id))[0] === 'destroy' ? 'stop' : VERBS[pending] ?? pending)
		const boot = async (name) => {
			try {
				await virsh('start', name)
			} catch (error) {
				// The list can still say stopped after libvirt has already started the domain.
				if (!alreadyActive(error)) throw error
			}
		}
		busy.set(m.id, {state: pending === 'hibernating' ? 'stopping' : pending})
		try {
			if (pending === 'restarting' && m.pending) {
				// Changed hardware only applies when QEMU starts again: shut down fully, then start.
				await virsh('shutdown', domain(m.id))
				const end = Date.now() + 180_000
				while ((await domainStates()).get(domain(m.id)) !== 'shut off') {
					if (Date.now() > end) throw new Error(`${m.name} didn’t shut down within 3 minutes; use Stop, then Start`)
					await new Promise((r) => setTimeout(r, 1000))
				}
				await define(m)
				await boot(domain(m.id))
			} else {
				if (pending === 'starting' && !defined) await define(m)
				if (pending === 'starting') await boot(domain(m.id))
				else await virsh(...verb(domain(m.id)))
			}
			if (pending === 'starting' || pending === 'restarting') {
				delete m.pending
				delete m.hibernated
				m.liveForwards = (m.portForwards ?? []).map(forwardKey)
			}
			if (pending === 'stopping' && verb(domain(m.id))[0] === 'destroy') delete m.liveForwards
			if (pending === 'hibernating') m.hibernated = true
			if (pending !== 'starting' && pending !== 'pausing' && pending !== 'resuming') await dropAnswerFile(m)
			endTask(m, t)
		} catch (error) {
			endTask(m, t, error)
			throw engineFailure(error, m.name, action)
		} finally {
			await save().catch(() => {})
			// Shown a little longer so the next list reads libvirt's settled state; other actions may go ahead.
			// Pause and Resume are done when virsh returns, so the list reads libvirt's state at once.
			const entry = {...busy.get(m.id), settling: true}
			if (pending === 'pausing' || pending === 'resuming') busy.delete(m.id)
			else busy.set(m.id, entry)
			setTimeout(() => busy.get(m.id) === entry && busy.delete(m.id), pending === 'stopping' ? 0 : 1500)
		}
		return true
	}

	// domainStates() swallows a virsh failure so the machine list still loads. Delete must not
	// treat that empty map as "already off" and remove a disk that is still in use.
	async function readDomainState(m) {
		let text
		try {
			text = await virsh('list', '--all')
		} catch {
			throw new RpcError('BAD_GATEWAY', `${m.name} was not deleted because its state could not be read`)
		}
		const name = domain(m.id)
		for (const line of text.split('\n').slice(2)) {
			const hit = /^\s*(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
			if (hit && hit[2] === name) return hit[3]
		}
		return null
	}
	// Older libvirt rejects --nvram or --managed-save. Try plainer forms before giving up.
	async function undefineDomain(m) {
		const name = domain(m.id)
		const attempts = [
			['undefine', name, '--nvram', '--managed-save'],
			['undefine', name, '--nvram'],
			['undefine', name],
		]
		for (const args of attempts) {
			try {
				await virsh(...args)
				return
			} catch {}
		}
		throw new RpcError('BAD_GATEWAY', `${m.name} was not deleted because it could not be removed from libvirt`)
	}

	async function uninstall(input, ctx) {
		await ready
		const m = find(input?.id)
		if (busy.get(m.id)?.state === 'installing') throw new RpcError('CONFLICT', `${m.name} is still being set up`)
		if (isBusy(m.id)) throw new RpcError('CONFLICT', `${m.name} is busy`)
		if (m.options?.protection && !input?.force) throw new RpcError('PRECONDITION_FAILED', `${m.name} is protected. Turn off Protection in its options to delete it.`)
		if (hostOf(m) !== 'server') {
			assertOwner(ctx)
			// A computer that was removed from the swarm can't be asked to delete anything. Only a swarm list
			// that was read and doesn't have it counts: a list that fails to load keeps the machine.
			let swarm = null
			try {
				swarm = await connector?.list?.()
			} catch {}
			if (Array.isArray(swarm) && !swarm.some((a) => a?.id === hostOf(m))) {
				machines = machines.filter((x) => x.id !== m.id)
				await save()
				return true
			}
			const {hostId, hostName, agent} = await hostAgent(m)
			if (!agent.online) throw new RpcError('PRECONDITION_FAILED', `${hostName} is offline, so ${m.name} was not deleted.`)
			if (!agent.allowed?.vms || !agent.on?.vms) throw new RpcError('FORBIDDEN', `Pair ${hostName} again with Virtual machines switched on.`)
			try {
				await remoteCall(hostId, 'vm-undefine', {guestId: m.id})
			} catch (error) {
				throw engineFailure(error, m.name, 'delete')
			}
			machines = machines.filter((x) => x.id !== m.id)
			await save()
			return true
		}
		const live = await readDomainState(m)
		if (live && live !== 'shut off') {
			try {
				await virsh('destroy', domain(m.id))
			} catch {
				throw new RpcError('BAD_GATEWAY', `${m.name} was not deleted because it could not be shut down`)
			}
		}
		if (live) await undefineDomain(m)
		await rm(join(vmsDir, m.id), {recursive: true, force: true})
		machines = machines.filter((x) => x.id !== m.id)
		await save()
		// The sticks it had attached: their udev rules go too (as when a stick is detached).
		await usbReleased?.(m.usbDevices ?? [])
		return true
	}

	async function updateSettings(input, ctx) {
		await ready
		const m = find(input?.id)
		if (hostOf(m) !== 'server') await requireRemote(m, ctx)
		refuseIfBusy(m)
		if (input.portForwards !== undefined) {
			if (!Array.isArray(input.portForwards) || input.portForwards.length > 32) throw new RpcError('BAD_REQUEST', 'Invalid port forwards')
			const seen = new Set()
			// passt binds the host port on the computer that runs the guest, not across the swarm.
			const used = new Set(machines.filter((x) => x.id !== m.id && hostOf(x) === hostOf(m)).flatMap((x) => (x.portForwards ?? []).map((f) => `${f.protocol}:${f.hostPort}`)))
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
			const running = (await liveState(m)) !== 'stopped'
			if (running && m.liveForwards === undefined) m.liveForwards = (m.portForwards ?? []).map(forwardKey)
			else if (!running) delete m.liveForwards
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

	const liveState = async (m) => (hostOf(m) === 'server' ? (STATE[(await domainStates()).get(domain(m.id))] ?? 'stopped') : remoteLive(m))
	// The guest still holds its disks whenever the domain exists and is not shut off (running, paused, shutting down).
	const domainOpen = async (m) => {
		if (hostOf(m) !== 'server') {
			try {
				const word = parseVmState(await remoteCall(hostOf(m), 'vm-state', {}))[domain(m.id)]
				return word != null && word !== 'shut off'
			} catch {
				return false
			}
		}
		const raw = (await domainStates()).get(domain(m.id))
		return raw != null && raw !== 'shut off'
	}
	const refuseIfBusy = (m) => {
		if (isBusy(m.id)) throw new RpcError('CONFLICT', `${m.name} is busy`)
	}
	async function requireStopped(m, what) {
		if (isBusy(m.id)) throw new RpcError('CONFLICT', `${m.name} is busy`)
		if ((await liveState(m)) !== 'stopped') throw new RpcError('PRECONDITION_FAILED', `Shut down ${m.name} first to ${what}`)
	}
	// A changed definition: libvirt keeps it for the next start. While running, it's pending until then.
	async function markChanged(m, {markPending = true} = {}) {
		if (m.state !== 'error' && !isBusy(m.id)) {
			try {
				await define(m)
			} catch (error) {
				throw engineFailure(error, m.name, 'save that change')
			}
			if (markPending && (await liveState(m)) !== 'stopped') m.pending = true
		}
		await save()
	}
	const writable = (m) => {
		if (m.state === 'error' || busy.get(m.id)?.state === 'installing') throw new RpcError('PRECONDITION_FAILED', `${m.name} isn’t set up yet`)
	}

	function connectorAbilities(os, given) {
		const defaults = defaultConnectorAbilities(os)
		if (!given || typeof given !== 'object' || Array.isArray(given)) return defaults
		return Object.fromEntries(Object.keys(defaults).map((k) => [k, given[k] === true]))
	}

	function qemuAgentFor(m) {
		if (hostOf(m) === 'server') return qemuAgent({run, domain: domain(m.id)})
		return qemuAgent({run: remoteGuestAgentRun({call: (name, args) => remoteCall(hostOf(m), name, args), guestId: m.id}), domain: domain(m.id)})
	}

	// Create returns before cloud-init (and a desktop reboot) can answer guest-ping. The button still pings once.
	const sleepUnref = (ms) => new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		timer.unref?.()
	})
	async function guestExecExit(agent, m, cmd) {
		const tick = Math.min(1_000, Math.max(25, Math.floor(connectorEnrollTimeoutMs / 4)))
		const started = await agent.exec(cmd)
		if (!started?.pid) throw new RpcError('BAD_GATEWAY', `${m.name} didn’t start the connector installer`)
		const until = Date.now() + connectorEnrollTimeoutMs
		let result
		while (Date.now() < until) {
			result = await agent.status(started.pid)
			if (result?.exited) break
			await new Promise((r) => setTimeout(r, tick))
		}
		if (!result?.exited) throw new RpcError('PRECONDITION_FAILED', `${m.name} didn’t finish the connector installer`)
		return result
	}
	function waitForGuestConnector(id, username) {
		const m = machines.find((row) => row.id === id)
		if (!m) return
		const agent = qemuAgentFor(m)
		const deadline = Date.now() + connectorAgentWaitMs
		const gap = Math.min(2_000, Math.max(20, Math.floor(connectorAgentWaitMs / 8) || 20))
		const runWait = async () => {
			const t = beginTask(m, 'connector')
			await save().catch(() => {})
			let lastError = null
			let enrolled = false
			let installed = false
			const pause = async () => {
				const left = deadline - Date.now()
				if (left <= 0) return false
				await sleepUnref(Math.min(gap, left))
				return true
			}
			try {
				while (Date.now() < deadline) {
					const listed = await connector?.list?.().catch(() => [])
					if ((Array.isArray(listed) ? listed : []).some((a) => a?.guestOf === id)) {
						enrolled = true
						return
					}
					let up = false
					try {
						await agent.ping()
						up = true
					} catch {
						up = false
					}
					if (!up) {
						if (!await pause()) return
						continue
					}
					const user = String(username ?? m.cloudInit?.username ?? '').trim()
					if (connectorKind(m.osId) === 'linux' && user) {
						try {
							const ready = await guestExecExit(agent, m, guestConnectorReadyCommand({username: user}))
							if (ready.exitcode !== 0) {
								if (!await pause()) return
								continue
							}
						} catch {
							if (!await pause()) return
							continue
						}
					}
					try {
						const out = await installConnector({id, username: user})
						if (out?.status === 'needs-agent') {
							if (!await pause()) return
							continue
						}
						if (out?.status === 'unsupported') return
						if (out?.status === 'started' || out?.status === 'joined') {
							installed = true
							enrolled = true
							return
						}
					} catch (error) {
						lastError = error
						if (!await pause()) return
					}
				}
			} finally {
				if (t.status === 'running') {
					if (installed) endTask(m, t)
					else if (enrolled) m.tasks = (m.tasks ?? []).filter((row) => row.id !== t.id)
					else endTask(m, t, lastError || new Error('The guest agent didn’t come up in time'))
					await save().catch(() => {})
				}
			}
		}
		runWait().catch(() => {})
	}

	async function installConnector(input = {}) {
		await ready
		const m = find(input?.id)
		// qemu-ga is root: sudoPassword is accepted and discarded, never saved.
		const os = connectorKind(m.osId)
		if (os === 'unsupported') return {status: 'unsupported', os: 'other', message: 'This operating system can’t run the connector.'}
		if (hostOf(m) !== 'server') {
			const info = await hostAgent(m)
			if (!info.agent.online) throw new RpcError('PRECONDITION_FAILED', `${info.hostName} is offline right now`)
			if (!info.agent.allowed?.vms || !info.agent.on?.vms) throw new RpcError('FORBIDDEN', `Pair ${info.hostName} again with Virtual machines switched on.`)
		}
		if ((await liveState(m)) !== 'running') throw new RpcError('PRECONDITION_FAILED', 'Start the machine first.')
		const agent = qemuAgentFor(m)
		try {
			await agent.ping()
		} catch {
			return {status: 'needs-agent', os}
		}
		const username = String(input?.username ?? m.cloudInit?.username ?? '').trim()
		if (os === 'linux' && !username) throw new RpcError('PRECONDITION_FAILED', 'Give the guest account to install as.')
		const tick = Math.min(1_000, Math.max(25, Math.floor(connectorEnrollTimeoutMs / 4)))
		if (os === 'linux') {
			for (const cmd of guestConnectorPrep({username, osId: m.osId})) {
				const prepared = await guestExecExit(agent, m, cmd)
				if (prepared.exitcode !== 0) throw new RpcError('PRECONDITION_FAILED', `${m.name} couldn’t prepare the connector installer.`)
			}
		}
		const abilities = connectorAbilities(os, input?.abilities)
		const pair = await connector.pair({machineId: m.id, ...abilities})
		let exclude = []
		let gateway = ''
		try {
			exclude = guestOwnAddresses(await agent.interfaces?.() ?? [])
		} catch {}
		try {
			gateway = guestDefaultGateway(await agent.routes?.() ?? [])
		} catch {}
		const url = guestReachableUrl({addresses: pair.addresses, port: pair.port, exclude, gateway})
		if (!url) throw new RpcError('PRECONDITION_FAILED', 'This server has no address the guest can reach.')
		const caPem = /^https:\/\//i.test(String(pair.source ?? '')) ? undefined : await connector.caCertificate()
		const result = await guestExecExit(agent, m, guestConnectorExec({os, osId: m.osId, username, source: pair.source, server: url, ca: pair.ca, token: pair.token, allow: connectorAllowList(os, abilities), caPem}))
		if (result.exitcode !== 0) throw new RpcError('PRECONDITION_FAILED', `${m.name} couldn’t install the connector.`)
		const poll = async () => {
			const joinUntil = Date.now() + connectorEnrollTimeoutMs
			while (Date.now() < joinUntil) {
				const agents = await connector.list().catch(() => [])
				if ((Array.isArray(agents) ? agents : []).some((a) => a?.guestOf === m.id)) return
				await new Promise((r) => setTimeout(r, tick))
			}
			throw new Error('The connector didn’t join in time')
		}
		const existing = (m.tasks ?? []).find((row) => row.type === 'connector' && row.status === 'running')
		if (existing) {
			await poll()
			return {status: 'started', os, taskId: existing.id}
		}
		const work = task(m, 'connector', null, poll)
		const taskId = m.tasks[0].id
		work.catch(() => {})
		return {status: 'started', os, taskId}
	}

	// Live usage: sampled often for the last reading; the hour chart keeps a coarser series.
	const series = new Map() // id -> [{t, cpu, memMb, netIn, netOut, diskRead, diskWrite}]
	const seriesAt = new Map() // id -> monotonic time of the newest stored point
	const lastPoint = new Map()
	const lastRaw = new Map() // id -> {t, cpuNs, rx, tx, rd, wr}
	// libvirt states that still have counters. "shut off" and friends do not.
	const COUNTED = new Set(['running', 'paused', 'blocked', 'pmsuspended'])
	let inFlight = false
	function ingestDomstats(text, now, mono) {
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
			const raw = {t: mono, cpuNs: kv['cpu.time'] ?? 0, rx: sum(/^net\.\d+\.rx\.bytes$/), tx: sum(/^net\.\d+\.tx\.bytes$/), rd: sum(/^block\.\d+\.rd\.bytes$/), wr: sum(/^block\.\d+\.wr\.bytes$/)}
			const prev = lastRaw.get(m.id)
			lastRaw.set(m.id, raw)
			if (!prev || raw.cpuNs < prev.cpuNs || raw.t <= prev.t) continue
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
			lastPoint.set(m.id, point)
			const list = series.get(m.id) ?? []
			const keptAt = seriesAt.get(m.id)
			if (keptAt === undefined || !list.length || mono - keptAt >= seriesIntervalMs) {
				seriesAt.set(m.id, mono)
				list.push(point)
				if (list.length > 360) list.splice(0, list.length - 360)
				series.set(m.id, list)
			}
		}
	}
	async function sample() {
		if (inFlight) return
		if (!machines.some((m) => !isBusy(m.id))) return
		inFlight = true
		try {
			const states = await domainStates()
			const texts = []
			// Counters are read when virsh starts. Stamp that moment, not the moment the call returns,
			// or a slow read divides the same counters by too much time and the rate collapses.
			if (machines.some((m) => hostOf(m) === 'server' && !isBusy(m.id) && COUNTED.has(states.get(domain(m.id))))) {
				try {
					const now = Date.now()
					const mono = performance.now()
					const text = await virsh('domstats', '--list-running', '--cpu-total', '--balloon', '--interface', '--block')
					if (text) texts.push({text, now, mono})
				} catch {}
			}
			const agents = await listedAgents()
			for (const hostId of new Set(machines.filter((m) => hostOf(m) !== 'server' && !isBusy(m.id)).map((m) => hostOf(m)))) {
				if (!agents.find((a) => a.id === hostId)?.online) continue
				try {
					const now = Date.now()
					const mono = performance.now()
					const text = await remoteCall(hostId, 'vm-stats', {})
					if (text) texts.push({text: String(text), now, mono})
				} catch {}
			}
			if (!texts.length) return
			for (const row of texts) ingestDomstats(row.text, row.now, row.mono)
		} finally {
			inFlight = false
		}
	}
	let sampler = null
	let watchedAt = 0
	// The interval runs only while someone has listed machines, opened their stats, or
	// looked at system usage. It stops about 15s after the last of those.
	function touchWatch() {
		watchedAt = Date.now()
		if (sampler) return
		void sample().catch(() => {})
		sampler = setInterval(() => {
			if (Date.now() - watchedAt >= watchIdleMs) {
				clearInterval(sampler)
				sampler = null
				return
			}
			void sample().catch(() => {})
		}, statsIntervalMs)
		sampler.unref?.()
	}
	function packStats(m) {
		const points = series.get(m.id) ?? []
		return {memoryMb: m.memoryMb, vcpus: (m.sockets ?? 1) * m.cores, points, last: lastPoint.get(m.id) ?? points.at(-1) ?? null}
	}
	async function statsFor(input) {
		await ready
		touchWatch()
		if (!input?.id) return Object.fromEntries(machines.map((m) => [m.id, packStats(m)]))
		return packStats(find(input.id))
	}

	// Machines set to start with the server, in their start order, with each one's delay.
	async function autostart() {
		const list = machines.filter((m) => hostOf(m) === 'server' && m.options?.onBoot && m.state !== 'error').sort((a, b) => (a.options.startupOrder ?? 999) - (b.options.startupOrder ?? 999) || a.vmid - b.vmid)
		if (!list.length) return
		const states = await domainStates()
		for (const m of list) {
			if (states.get(domain(m.id)) === 'running') continue
			await lifecycle((d) => ['start', d], 'starting')({id: m.id}).catch((e) => console.error('[omarchyd] start on boot', m.name, e.message))
			const wait = Math.min(600, Math.max(0, Number(m.options.startupDelay) || 0))
			if (wait) await new Promise((r) => setTimeout(r, wait * 1000))
		}
	}

	// Remote "start on boot": when that computer comes online, not from this server's virsh.
	const booting = new Set()
	async function bootRemote(hostId) {
		if (!/^[0-9a-f]{12}$/.test(String(hostId ?? ''))) return
		if (booting.has(hostId)) return
		booting.add(hostId)
		try {
			await ready
			const agent = (await listedAgents()).find((a) => a.id === hostId)
			if (!agent?.online || !agent.allowed?.vms || !agent.on?.vms) return
			const list = machines.filter((m) => hostOf(m) === hostId && m.options?.onBoot && m.state !== 'error' && m.state !== 'installing').sort((a, b) => (a.options.startupOrder ?? 999) - (b.options.startupOrder ?? 999) || a.vmid - b.vmid)
			for (const m of list) {
				try {
					await remoteCall(hostId, 'vm-start', {guestId: m.id})
				} catch (error) {
					const message = String(error?.message ?? error)
					if (!/already (?:running|active)/i.test(message)) console.error('[omarchyd] start on boot', m.name, message)
				}
				const wait = Math.min(600, Math.max(0, Number(m.options.startupDelay) || 0))
				if (wait) await new Promise((r) => setTimeout(r, wait * 1000))
			}
		} finally {
			booting.delete(hostId)
		}
	}

	// Display adapters this server's QEMU has (Arch splits some into their own packages).
	let videoModels = null
	async function availableVideo() {
		if (videoModels) return videoModels
		// An ARM machine has no PC display adapters: it always gets virtio graphics.
		if (arch === 'arm64') return (videoModels = ['virtio', 'none'])
		const out = await run('qemu-system-x86_64', ['-device', 'help'], {timeout: 15_000}).catch(() => '')
		const has = (n) => out.includes(`"${n}"`)
		videoModels = ['vga', ...(has('bochs-display') ? ['bochs'] : []), ...(has('virtio-vga') ? ['virtio'] : []), ...(has('qxl-vga') ? ['qxl'] : []), ...(has('cirrus-vga') ? ['cirrus'] : []), 'none']
		return videoModels
	}

	// The server itself (the "node" in Proxmox terms).
	async function node(input, ctx) {
		await ready
		const machineId = String(input?.id ?? '').trim()
		if (machineId) {
			const m = find(machineId)
			if (hostOf(m) !== 'server') {
				const hostId = hostOf(m)
				const {status, hostName} = await hostStatus(hostId, ctx)
				const libvirtAvailable = status.libvirt === true
				const kvmAvailable = status.kvm === true
				const models = Array.isArray(status.videoModels) ? status.videoModels.filter((v) => v === 'vga' || v === 'virtio' || v === 'bochs' || v === 'qxl' || v === 'cirrus' || v === 'none') : []
				const hostMachines = machines.filter((x) => hostOf(x) === hostId)
				return {
					hostname: hostName,
					cpuModel: '',
					threads: Number(status.threads) || 1,
					loadAverage: [],
					memoryTotalMb: Number(status.memoryMb) || 0,
					memoryFreeMb: Math.max(0, Math.round((Number(status.freeGb) || 0) * 1024)),
					uptimeSeconds: 0,
					storage: {totalGb: 0, freeGb: Number(status.freeGb) || 0},
					libvirtVersion: status.libvirtVersion ?? null,
					qemuVersion: status.qemu ?? null,
					hostArchitecture: status.arch === 'arm64' ? 'arm64' : 'amd64',
					libvirtAvailable,
					kvmAvailable,
					...(libvirtAvailable && !kvmAvailable ? {performanceWarning: kvmWarning} : {}),
					videoModels: models.length ? models : status.arch === 'arm64' ? ['virtio', 'none'] : ['vga', 'none'],
					cpuTypes: CPU_TYPES,
					nicModels: NICS,
					diskBuses: BUSES,
					diskCaches: CACHES,
					counts: {total: hostMachines.length, running: hostMachines.filter((x) => (x.hostState ?? x.state) === 'running').length},
				}
			}
		}
		const caps = await capabilities()
		const fs = await statfs(base).catch(() => null)
		const cpus = os.cpus()
		const versions = await run('virsh', ['-c', LIBVIRT, 'version']).catch(() => '')
		const states = await domainStates()
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
			qemuVersion: /Running hypervisor:\s*QEMU\s+([\d.]+)/i.exec(versions)?.[1] ?? null,
			...caps,
			videoModels: await availableVideo(),
			cpuTypes: CPU_TYPES,
			nicModels: NICS,
			diskBuses: BUSES,
			diskCaches: CACHES,
			counts: {total: machines.length, running: machines.filter((m) => states.get(domain(m.id)) === 'running').length},
		}
	}

	// qemu-img info says what the copy actually wrote. A failed probe keeps the disk's previous format.
	async function copiedFormat(file, fallback) {
		const out = await run('qemu-img', ['info', '--output=json', '-U', file], {timeout: 20_000}).catch(() => null)
		try {
			const format = JSON.parse(out)?.format
			if (typeof format === 'string' && format) return format
		} catch {}
		return fallback
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
		const remote = hostOf(m) !== 'server'
		let inspect = null
		if (remote) {
			const agent = (await listedAgents()).find((a) => a.id === hostOf(m))
			if (agent?.online) {
				try {
					inspect = await remoteCall(hostOf(m), 'vm-inspect', {guestId: m.id})
					if (typeof inspect === 'string') {
						try {
							inspect = JSON.parse(inspect)
						} catch {
							inspect = null
						}
					}
				} catch {
					inspect = null
				}
			}
		}
		const live = busy.get(m.id)?.state ?? (m.state === 'error' ? 'error' : remote ? (STATE[inspect?.state] ?? m.hostState ?? 'stopped') : await liveState(m))
		const names = m.layout ? targets(m.layout) : new Map()
		const disks = []
		const inspectDisks = Array.isArray(inspect?.disks) ? inspect.disks : []
		for (const d of m.layout?.disks ?? []) {
			let info = {}
			if (remote) {
				const hit = inspectDisks.find((x) => basename(String(x.file ?? '')) === basename(String(d.file ?? '')))
				if (hit) info = {virtualGb: hit.virtualGb, usedGb: hit.usedGb}
			} else if (d.device === 'disk') {
				info = await diskInfo(d.file)
			}
			const offline = remote && !inspect
			disks.push({id: d.id, device: d.device, bus: d.bus, target: names.get(d.id), format: d.format, role: d.role ?? null, cache: d.cache ?? 'default', discard: d.device === 'disk' ? d.discard !== false : undefined, sizeGb: offline ? null : (info.virtualGb ?? d.sizeGb ?? null), usedGb: offline ? null : (info.usedGb ?? null), media: d.device === 'cdrom' ? (remote ? (d.file ? basename(d.file) : null) : await mediaLabel(d.file)) : null, inMachineFolder: d.file?.startsWith(join(vmsDir, m.id)) ?? false})
		}
		let guestIps = []
		if (!remote && live === 'running' && m.options?.agent) {
			const out = await virsh('domifaddr', domain(m.id), '--source', 'agent').catch(() => '')
			guestIps = [...out.matchAll(/ipv4\s+([\d.]+)\//g)].map((x) => x[1]).filter((ip) => !ip.startsWith('127.'))
		}
		return {
			id: m.id,
			vmid: m.vmid,
			name: m.name,
			osId: m.osId,
			state: !remote && live === 'stopped' && m.hibernated ? 'hibernated' : live,
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
			cloudInit: m.cloudInit ? {username: m.cloudInit.username ?? '', hostname: m.cloudInit.hostname ?? hostnameFor(m.name, m.id), sshKeys: m.cloudInit.sshKeys ?? []} : null,
			portForwards: forwardsFor(m, live),
			snapshots: m.snapshots ?? [],
			tasks: (m.tasks ?? []).slice(0, 50),
			guestIps,
			...(m.nixos ? {nixos: true} : {}),
		}
	}

	async function nixosConfig(input = {}) {
		await ready
		const m = find(input.id)
		if (!m.nixos) throw new RpcError('BAD_REQUEST', 'That machine isn’t a NixOS guest.')
		return readConfiguration(dataDir, m.id)
	}
	async function setNixosConfig(input = {}) {
		await ready
		const m = find(input.id)
		if (!m.nixos) throw new RpcError('BAD_REQUEST', 'That machine isn’t a NixOS guest.')
		const checked = validateNixosConfig(input.config ?? '')
		if (!checked.ok) throw new RpcError('BAD_REQUEST', checked.error)
		try {
			await writeConfiguration(dataDir, m.id, checked.config)
		} catch (error) {
			throw new RpcError('BAD_REQUEST', String(error?.message ?? error))
		}
		const cache = await readNixCache(dataDir)
		await writeCacheFragment(dataDir, m.id, cache)
		return readConfiguration(dataDir, m.id)
	}
	async function applyNixosConfig(input = {}, ctx) {
		if (input.config !== undefined && input.config !== null) {
			await setNixosConfig({id: input.id, config: input.config})
		}
		return lifecycle((d) => ['reboot', d], 'restarting')(input, ctx)
	}

	async function updateHardware(input = {}, ctx) {
		await ready
		const m = find(input.id)
		if (hostOf(m) !== 'server') await requireRemote(m, ctx)
		writable(m)
		refuseIfBusy(m)
		let threads = os.cpus().length || 1
		let totalMb = Math.floor(os.totalmem() / 1024 ** 2)
		let videos = null
		if (hostOf(m) !== 'server') {
			const status = readVmStatus(await remoteCall(hostOf(m), 'vm-status', {}))
			threads = Number(status.threads) || 1
			totalMb = Number(status.memoryMb) || totalMb
			videos = Array.isArray(status.videoModels) ? status.videoModels.filter((v) => typeof v === 'string') : []
		}
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
		if (machineType !== 'pc' && machineType !== m.layout.machineType && m.layout.disks.some((d) => d.bus === 'ide')) throw new RpcError('BAD_REQUEST', 'Move the IDE drives to another bus before switching to q35: it has no IDE controller')
		const firmware = input.firmware ?? m.layout.firmware
		if (!['bios', 'efi'].includes(firmware)) throw new RpcError('BAD_REQUEST', 'Firmware must be SeaBIOS (bios) or OVMF (efi)')
		const video = input.video ?? m.layout.video
		if (!(videos ?? await availableVideo()).includes(video)) throw new RpcError('BAD_REQUEST', 'That display isn’t available on this server')
		const nic = input.nic ?? m.layout.nic
		if (!NICS.includes(nic)) throw new RpcError('BAD_REQUEST', 'Unknown network model')
		if (input.linkDown !== undefined && input.linkDown !== null && typeof input.linkDown !== 'boolean') throw new RpcError('BAD_REQUEST', 'Disconnect must be true or false')
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

	const HARDWARE_OPTION_DEFAULTS = {tablet: true, acpi: true, kvm: true, agent: false, bootMenu: false}
	async function updateOptions(input = {}, ctx) {
		await ready
		const m = find(input.id)
		if (hostOf(m) !== 'server') await requireRemote(m, ctx)
		refuseIfBusy(m)
		const o = {...m.options}
		let nextName
		if (input.name !== undefined) {
			const name = typeof input.name === 'string' ? input.name.trim() : ''
			if (!name || [...name].length > 64) throw new RpcError('BAD_REQUEST', 'Give the machine a name (up to 64 characters)')
			if (!xmlChars(name)) throw new RpcError('BAD_REQUEST', 'That name can’t be used')
			if (machines.some((x) => x.id !== m.id && x.name.toLowerCase() === name.toLowerCase())) throw new RpcError('CONFLICT', 'A machine with that name already exists')
			nextName = name
		}
		for (const k of ['onBoot', 'protection', 'tablet', 'acpi', 'kvm', 'agent', 'bootMenu']) if (input[k] !== undefined) o[k] = !!input[k]
		if (input.startupOrder !== undefined) {
			const n = input.startupOrder === null || input.startupOrder === '' ? null : input.startupOrder
			if (n !== null && (!Number.isInteger(n) || n < 0 || n > 999)) throw new RpcError('BAD_REQUEST', 'Start order must be between 0 and 999')
			o.startupOrder = n
		}
		if (input.startupDelay !== undefined) {
			const n = input.startupDelay
			if (!Number.isInteger(n) || n < 0 || n > 600) throw new RpcError('BAD_REQUEST', 'Start delay must be between 0 and 600 seconds')
			o.startupDelay = n
		}
		if (input.notes !== undefined) {
			const notes = String(input.notes)
			if (notes.length > 8000) throw new RpcError('BAD_REQUEST', 'Notes are limited to 8,000 characters')
			if (!xmlChars(notes)) throw new RpcError('BAD_REQUEST', 'Those notes can’t be used')
			o.notes = notes
		}
		return task(m, 'options', null, async () => {
			const prevName = m.name
			const prevOptions = m.options
			const hardwareChanged = Object.entries(HARDWARE_OPTION_DEFAULTS).some(([k, def]) => {
				const before = prevOptions?.[k] === undefined ? def : !!prevOptions[k]
				const after = o[k] === undefined ? def : !!o[k]
				return before !== after
			})
			const effectiveName = nextName !== undefined ? nextName : prevName
			const xmlChanged = hardwareChanged || effectiveName !== prevName || (o.notes ?? '') !== (prevOptions?.notes ?? '')
			if (nextName !== undefined) m.name = nextName
			m.options = o
			try {
				if (m.state === 'error' || !xmlChanged) await save()
				else await markChanged(m, {markPending: hardwareChanged})
			} catch (error) {
				m.name = prevName
				m.options = prevOptions
				throw error
			}
			return true
		})
	}

	async function setBootOrder(input = {}, ctx) {
		await ready
		const m = find(input.id)
		if (hostOf(m) !== 'server') await requireRemote(m, ctx)
		writable(m)
		refuseIfBusy(m)
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
	// The q35 machine type has no IDE controller, so libvirt refuses to define a domain with an IDE drive.
	const IDE_NEEDS_PC = 'IDE is only available on the i440fx (pc) machine type'
	async function addDisk(input = {}) {
		await ready
		assertLocal(find(input.id))
		const idArg = find(input.id).id
		return lock(`drives:${idArg}`, async () => {
			const m = find(idArg)
			writable(m)
			refuseIfBusy(m)
			const sizeGb = input.sizeGb
			const bus = input.bus ?? 'virtio'
			if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 4096) throw new RpcError('BAD_REQUEST', 'Disk size must be between 1 and 4096 GB')
			if (!BUSES.includes(bus)) throw new RpcError('BAD_REQUEST', 'Unknown disk bus')
			if (bus === 'ide' && m.layout.machineType !== 'pc') throw new RpcError('BAD_REQUEST', IDE_NEEDS_PC)
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
		})
	}
	async function updateDisk(input = {}) {
		await ready
		const m = find(input.id)
		assertLocal(m)
		writable(m)
		refuseIfBusy(m)
		const d = findDisk(m, input.diskId)
		if (input.bus !== undefined && !BUSES.includes(input.bus)) throw new RpcError('BAD_REQUEST', 'Unknown disk bus')
		if (input.bus === 'ide' && m.layout.machineType !== 'pc') throw new RpcError('BAD_REQUEST', IDE_NEEDS_PC)
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
		assertLocal(m)
		writable(m)
		refuseIfBusy(m)
		const d = findDisk(m, input.diskId)
		if (d.device !== 'disk') throw new RpcError('BAD_REQUEST', 'Only disks can be resized')
		const sizeGb = input.sizeGb
		const current = (await diskInfo(d.file)).virtualGb ?? d.sizeGb ?? 0
		if (!Number.isInteger(sizeGb) || sizeGb > 4096) throw new RpcError('BAD_REQUEST', 'Disk size must be a whole number of GB, up to 4096')
		if (sizeGb <= current) throw new RpcError('BAD_REQUEST', `Disks can only grow: enter more than ${current} GB`)
		return task(m, 'resize-disk', `${d.id} to ${sizeGb} GB`, async () => {
			if (await domainOpen(m)) await virsh('blockresize', domain(m.id), targets(m.layout).get(d.id), `${sizeGb}G`)
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
		assertLocal(m)
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
		assertLocal(find(input.id))
		const idArg = find(input.id).id
		return lock(`drives:${idArg}`, async () => {
			const m = find(idArg)
			writable(m)
			await requireStopped(m, 'add a CD/DVD drive')
			const id = nextId(m, 'cd')
			return task(m, 'add-cdrom', id, async () => {
				m.layout.disks.push({id, file: '', device: 'cdrom', bus: input.bus === 'ide' && m.layout.machineType === 'pc' ? 'ide' : 'sata', format: 'raw'})
				await markChanged(m)
				return {diskId: id}
			})
		})
	}
	// Put an ISO in a CD/DVD drive (one of yours from Home, or a downloaded installer), or eject it.
	async function setMedia(input = {}) {
		await ready
		const m = find(input.id)
		assertLocal(m)
		writable(m)
		refuseIfBusy(m)
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
				else if (d.file) await virsh('change-media', domain(m.id), dev, '--eject', '--live')
			}
			const prevFile = d.file
			d.file = file
			try {
				if (m.state !== 'error') await define(m)
			} catch (error) {
				d.file = prevFile
				throw error
			}
			await save()
			return true
		})
	}

	// ---- cloud-init -----------------------------------------------------------------------------
	// A new seed with a new instance id: cloud-init applies it at the machine's next boot. A new
	// password is written only as a hash; SSH keys must be public keys.
	async function updateCloudInit(input = {}, ctx) {
		await ready
		const m = find(input.id)
		if (hostOf(m) !== 'server') await requireRemote(m, ctx)
		writable(m)
		refuseIfBusy(m)
		const seedDisk = m.layout.disks.find((d) => d.role === 'seed')
		// Omarchy keeps username on cloudInit for connector install; its seed is archinstall, not user-data.
		if (!m.cloudInit || !seedDisk || /omarchy/i.test(String(m.osId))) throw new RpcError('PRECONDITION_FAILED', `${m.name} doesn’t use cloud-init`)
		const username = String(input.username ?? m.cloudInit?.username ?? '').trim()
		if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username) || username === 'root') throw new RpcError('BAD_REQUEST', 'Use a lower-case username: letters, numbers, - and _ (not root)')
		const hostname = String(input.hostname ?? m.cloudInit?.hostname ?? hostnameFor(m.name, m.id)).trim().toLowerCase()
		if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw new RpcError('BAD_REQUEST', 'Use a hostname of letters, numbers and - (up to 63)')
		const sshKeys = (Array.isArray(input.sshKeys) ? input.sshKeys : (m.cloudInit?.sshKeys ?? [])).map((k) => String(k).trim()).filter(Boolean)
		if (sshKeys.length > 20) throw new RpcError('BAD_REQUEST', 'Up to 20 SSH keys')
		const bad = sshKeys.find((k) => !PUBLIC_KEY.test(k))
		if (bad) throw new RpcError('BAD_REQUEST', /PRIVATE KEY/.test(bad) ? 'That’s a private key. Paste the public key (the .pub file) instead.' : 'Each line must be an SSH public key, like “ssh-ed25519 AAAA… you@laptop”')
		const password = input.password ? String(input.password) : ''
		if (password && (password.length > 256 || /[\x00-\x1f\x7f]/.test(password))) throw new RpcError('BAD_REQUEST', 'That password can’t be used')
		const img = (await images().catch(() => [])).find((i) => i.id === m.osId)
		return task(m, 'cloud-init', null, async () => {
			const hash = password ? await hashPassword(password) : null
			if (hostOf(m) !== 'server') {
				const userData = cloudUserData({host: hostname, username, hash, sshKeys, changePassword: !!hash})
				await remoteCall(hostOf(m), 'vm-seed', {guestId: m.id, name: 'seed', label: 'cidata', files: {'user-data': userData, 'meta-data': cloudMetaData(hostname)}})
				seedDisk.file = 'seed.iso'
				m.cloudInit = {username, hostname, sshKeys}
				await define(m)
				if ((await liveState(m)) === 'running') m.pending = true
				await save()
				return true
			}
			const userData = cloudUserData({host: hostname, username, hash, sshKeys, changePassword: !!hash, cloudInit: connectorCloudInit({familyId: img?.familyId, cloudInit: {adminGroup: img?.adminGroup}})})
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
		assertLocal(m)
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
			const config = {sockets: m.sockets, cores: m.cores, memoryMb: m.memoryMb, cpuType: m.cpuType, layout: {firmware: m.layout.firmware, machineType: m.layout.machineType, video: m.layout.video, nic: m.layout.nic}, disks: qcowDisks(m).map((d) => d.id), files: qcowDisks(m).map((d) => d.file)}
			m.snapshots = [...(m.snapshots ?? []), {name, description, createdAt: Date.now(), config}]
			await save()
			return true
		})
	}
	async function revertSnapshot(input = {}) {
		await ready
		const m = find(input.id)
		assertLocal(m)
		writable(m)
		const snap = (m.snapshots ?? []).find((x) => x.name === input.name)
		if (!snap) throw new RpcError('NOT_FOUND', 'That snapshot doesn’t exist')
		await requireStopped(m, 'go back to a snapshot')
		return task(m, 'rollback', snap.name, async () => {
			const qcow = qcowDisks(m)
			// Match by image path when the snapshot recorded one. diskN is reused after a drive is removed.
			const targets = Array.isArray(snap.config.files) && snap.config.files.length
				? snap.config.files.map((file) => {
						const d = qcow.find((x) => x.file === file)
						if (!d) throw new RpcError('PRECONDITION_FAILED', `${snap.name} isn’t in every drive, so nothing was rolled back`)
						return d
					})
				: qcow.filter((d) => (snap.config.disks ?? []).includes(d.id))
			for (const d of targets) {
				const listed = await run('qemu-img', ['snapshot', '-l', d.file], {timeout: 10 * 60_000})
				// qemu-img prints "Snapshot list:" even when there are none. A stub that does not simulate -l is not a list.
				if (!/Snapshot list/i.test(listed ?? '')) continue
				const tags = String(listed)
					.split('\n')
					.map((line) => /^\s*\d+\s+(\S+)/.exec(line)?.[1])
					.filter(Boolean)
				if (!tags.includes(snap.name)) throw new RpcError('PRECONDITION_FAILED', `${snap.name} isn’t in every drive, so nothing was rolled back`)
			}
			for (const d of targets) await run('qemu-img', ['snapshot', '-a', snap.name, d.file], {timeout: 10 * 60_000})
			try {
				await virsh('managedsave-remove', domain(m.id))
			} catch (error) {
				// No saved memory is the usual case. Anything else (the domain is gone, libvirt is down) still fails the rollback.
				if (!/managed save/i.test(String(error?.message ?? error))) throw error
			}
			const c = snap.config
			Object.assign(m, {sockets: c.sockets, cores: c.cores, memoryMb: c.memoryMb, memoryGb: Math.max(1, Math.round(c.memoryMb / 1024)), cpuType: c.cpuType})
			Object.assign(m.layout, c.layout)
			// The rollback also restores each image's virtual size, so re-read it instead of keeping a size from before.
			for (const t of targets) {
				const d = m.layout.disks.find((x) => x.id === t.id)
				const {virtualGb} = await diskInfo(t.file)
				if (!d || virtualGb === undefined) continue
				d.sizeGb = virtualGb
				if (d.id === 'disk0') m.diskSizeGb = virtualGb
			}
			m.hibernated = false
			await markChanged(m)
			return true
		})
	}
	async function deleteSnapshot(input = {}) {
		await ready
		const m = find(input.id)
		assertLocal(m)
		const snap = (m.snapshots ?? []).find((x) => x.name === input.name)
		if (!snap) throw new RpcError('NOT_FOUND', 'That snapshot doesn’t exist')
		await requireStopped(m, 'delete a snapshot')
		return task(m, 'delete-snapshot', snap.name, async () => {
			const qcow = qcowDisks(m)
			const targets = Array.isArray(snap.config.files) && snap.config.files.length ? qcow.filter((d) => snap.config.files.includes(d.file)) : qcow.filter((d) => (snap.config.disks ?? []).includes(d.id))
			for (const d of targets) {
				try {
					await run('qemu-img', ['snapshot', '-d', snap.name, d.file], {timeout: 10 * 60_000})
				} catch (error) {
					if (!/snapshot\b.*\bnot found/i.test(String(error?.message ?? error))) throw error
				}
			}
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
		if (input.id) assertLocal(find(input.id))
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
		assertLocal(m)
		writable(m)
		if (isBusy(m.id)) throw new RpcError('CONFLICT', `${m.name} is busy`)
		const notes = String(input.notes ?? '').slice(0, 500)
		const dir = await backupsDir()
		let id = `${m.vmid}-${hostnameFor(m.name, m.id)}-${stamp(Date.now())}`
		for (let n = 2; await exists(join(dir, id)); n++) id = `${m.vmid}-${hostnameFor(m.name, m.id)}-${stamp(Date.now())}-${n}`
		const target = join(dir, id)
		const disks = qcowDisks(m)
		const need = (await Promise.all(disks.map((d) => diskInfo(d.file)))).reduce((a, i) => a + (i.usedGb ?? 1), 0)
		const running = await domainOpen(m)
		const required = running ? need * 2 : need
		const fs = await statfs(dir)
		if ((fs.bavail * fs.bsize) / 1024 ** 3 < required + 1) throw new RpcError('PRECONDITION_FAILED', `Not enough free space for the backup (about ${Math.ceil(required)} GB)`)
		// A folder of its own (never one that's already there, so a failure only removes its own).
		// Before the machine is marked busy: a failed mkdir must not stick until restart.
		await mkdir(target, {mode: 0o700})
		busy.set(m.id, {state: running ? 'running' : 'stopped', progress: 0})
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
					const abortJob = () => virsh('domjobabort', domain(m.id)).catch(() => {})
					for (;;) {
						let info
						try {
							info = await virsh('domjobinfo', domain(m.id))
						} catch (error) {
							await abortJob()
							throw error
						}
						const progress = backupProgress(info)
						if (progress !== null) busy.set(m.id, {state: 'running', progress})
						// A failed query is not "job finished". Only a real reply that the job is idle ends the wait.
						if (!/Job type:\s+(Unbounded|Bounded)/.test(info)) break
						if (Date.now() > end) {
							await abortJob()
							throw new Error('The backup took too long and was stopped')
						}
						await new Promise((r) => setTimeout(r, 1000))
					}
					let done
					try {
						done = await virsh('domjobinfo', domain(m.id), '--completed')
					} catch (error) {
						await abortJob()
						throw error
					}
					if (!/Job type:\s+Completed/.test(done)) {
						await abortJob()
						throw new Error('QEMU couldn’t finish the backup')
					}
					for (const d of disks) {
						const liveFile = join(tmp, `${d.id}.qcow2`)
						await run('qemu-img', ['convert', '-c', '-O', 'qcow2', liveFile, join(target, `${d.id}.qcow2`)], {timeout: 6 * 60 * 60_000})
						await rm(liveFile, {force: true})
					}
					await rm(tmp, {recursive: true, force: true})
				} else {
					let i = 0
					for (const d of disks) {
						busy.set(m.id, {state: 'stopped', progress: Math.round((i++ / disks.length) * 100)})
						await run('qemu-img', ['convert', '-c', '-O', 'qcow2', d.file, join(target, `${d.id}.qcow2`)], {timeout: 6 * 60 * 60_000})
					}
				}
				// The settings, without task history or anything secret (no seed or answer file).
				const machine = {...m, tasks: undefined, snapshots: undefined, answerIso: undefined, state: undefined, errorMessage: undefined, pending: undefined, hibernated: undefined, liveForwards: undefined}
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
		const folder = await stat(dir).catch(() => null)
		// A cut-short backup has a folder and no machine.json. Start already removes those; deleting one that is already gone stays not-found.
		if (!folder?.isDirectory()) throw new RpcError('NOT_FOUND', 'That backup doesn’t exist')
		await rm(dir, {recursive: true, force: true})
		return true
	}
	// A backup that died before machine.json was written is only a folder. Drop those, and nothing else under Home.
	async function removeUnfinishedBackups() {
		if (!files) return
		let home
		try {
			;({real: home} = await files.resolve('/Home'))
		} catch {
			return
		}
		const dir = join(home, 'Backups', 'Machines')
		for (const e of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
			if (!e.isDirectory()) continue
			const folder = join(dir, e.name)
			try {
				await readFile(join(folder, 'machine.json'))
			} catch (error) {
				if (error?.code === 'ENOENT') await rm(folder, {recursive: true, force: true})
			}
		}
	}
	// A new machine from copied disks and settings (used by restore and clone).
	async function adopt(source, {name, copyDisk, keepIds, sourceTask}) {
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
			hostId: 'server',
			createdAt: Date.now(),
			tasks: [],
			snapshots: [],
			state: 'installing',
			portForwards: [],
			usbDevices: [],
			usbLive: undefined,
			lastUsbError: undefined,
			answerIso: undefined,
			pending: undefined,
			hibernated: undefined,
			liveForwards: undefined,
		})
		machines.push(m)
		busy.set(id, {state: 'installing', progress: 0})
		try {
			await save()
		} catch (error) {
			// A refused save leaves no machine behind, and its name stays free.
			machines = machines.filter((x) => x !== m)
			busy.delete(id)
			throw error
		}
		// Hold the live source for the whole copy. A settling entry expires on a short timer, so replace it;
		// a real busy entry (no settling flag) belongs to another operation and is left alone.
		const liveSource = machines.find((x) => x === source)
		const previous = liveSource ? busy.get(liveSource.id) : null
		const sourceHold = liveSource && (!previous || previous.settling) ? {state: 'stopped'} : null
		if (sourceHold) busy.set(liveSource.id, sourceHold)
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
						const copied = {...d, file: dst, format: await copiedFormat(dst, d.format)}
						// A brought-over machine has no recorded size: read it from the converted disk.
						if (copied.sizeGb === undefined) {
							const {virtualGb} = await diskInfo(dst)
							if (virtualGb !== undefined) {
								copied.sizeGb = Math.max(1, Math.round(virtualGb))
								if (copied.id === 'disk0' && m.diskSizeGb === undefined) m.diskSizeGb = copied.sizeGb
							}
						}
						kept.push(copied)
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
				if (m.layout.firmware === 'efi' && source.layout?.nvram && (await exists(source.layout.nvram))) {
					// Only attach copied UEFI NVRAM if its size matches a local OVMF_VARS template (when present),
					// preventing libvirt from failing boot due to mismatched flash geometry.
					const srcSize = (await stat(source.layout.nvram).catch(() => null))?.size ?? 0
					const ovmfCandidates = ['/usr/share/edk2/x64/OVMF_VARS.4m.fd', '/usr/share/edk2-ovmf/x64/OVMF_VARS.4m.fd', '/usr/share/OVMF/OVMF_VARS_4M.fd', '/usr/share/OVMF/OVMF_VARS.fd']
					const localSizes = []
					for (const p of ovmfCandidates) {
						const st = await stat(p).catch(() => null)
						if (st?.size) localSizes.push(st.size)
					}
					if (srcSize > 0 && (!localSizes.length || localSizes.includes(srcSize))) {
						const dstNvram = join(dir, 'VARS.fd')
						await copyFile(source.layout.nvram, dstNvram)
						m.layout.nvram = dstNvram
					} else {
						delete m.layout.nvram
					}
				}
				m.boot = (m.boot ?? []).filter((b) => b === 'net' || kept.some((d) => d.id === b))
				if (!m.boot.length) m.boot = [kept.find((d) => d.device === 'disk')?.id ?? 'disk0']
				await define(m)
				delete m.state
				endTask(m, t)
				if (sourceTask) endTask(sourceTask.m, sourceTask.t)
			} catch (error) {
				Object.assign(m, {state: 'error', errorMessage: error.message})
				endTask(m, t, error)
				if (sourceTask) endTask(sourceTask.m, sourceTask.t, error)
			} finally {
				busy.delete(id)
				if (sourceHold && busy.get(liveSource.id) === sourceHold) busy.delete(liveSource.id)
				await save().catch(() => {})
			}
		})()
		return {id}
	}
	const uniqueName = (wanted) => {
		let name = [...wanted].slice(0, 64).join('')
		for (let n = 2; machines.some((x) => x.name.toLowerCase() === name.toLowerCase()); n++) name = `${[...wanted].slice(0, 58).join('')} (${n})`
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
		if (!name || [...name].length > 64 || machines.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new RpcError('CONFLICT', 'Choose a name no other machine has')
		if (!xmlChars(name)) throw new RpcError('BAD_REQUEST', 'That name can’t be used')
		return adopt(meta.machine, {name, keepIds: true, copyDisk: (d, dst) => run('qemu-img', ['convert', '-O', 'qcow2', join(dir, `${d.id}.qcow2`), dst], {timeout: 6 * 60 * 60_000})})
	}
	// A VM brought over from another server (the Unraid importer): its settings, and disk images
	// already copied to this server (raw or qcow2), each converted into the machine's own qcow2.
	async function importVm(spec = {}) {
		await ready
		const requested = [...String(spec.name ?? 'Imported').trim()].slice(0, 64).join('') || 'Imported'
		const name = uniqueName(requested)
		const disks = (spec.disks ?? []).map((d, i) => ({id: i === 0 ? 'disk0' : `disk${i}`, file: String(d.file), device: 'disk', bus: ['virtio', 'sata', 'scsi'].includes(d.bus) ? (d.bus === 'scsi' ? 'sata' : d.bus) : 'sata', format: d.format === 'qcow2' ? 'qcow2' : 'raw'}))
		if (!disks.length) throw new RpcError('BAD_REQUEST', 'That VM has no disks to bring over')
		const memoryMb = Math.max(256, Math.min(Number(spec.memoryMb) || 2048, 1024 * 1024))
		const source = {
			name,
			importedFrom: requested,
			osId: 'imported',
			hostId: 'server',
			cores: Math.max(1, Math.min(Number(spec.cores) || 2, os.cpus().length || 2)),
			memoryMb,
			memoryGb: Math.max(1, Math.round(memoryMb / 1024)),
			layout: {firmware: spec.firmware === 'efi' ? 'efi' : 'bios', machineType: spec.machineType === 'pc' ? 'pc' : 'q35', nic: spec.nic === 'e1000e' ? 'e1000e' : 'virtio', video: 'vga', ...(spec.nvram ? {nvram: String(spec.nvram)} : {}), disks},
		}
		return adopt(source, {name, keepIds: false, copyDisk: (d, dst) => run('qemu-img', ['convert', '-f', d.format, '-O', 'qcow2', d.file, dst], {timeout: 12 * 60 * 60_000})})
	}
	async function clone(input = {}) {
		await ready
		const m = find(input.id)
		assertLocal(m)
		writable(m)
		await requireStopped(m, 'clone it')
		const name = input.name ? String(input.name).trim() : uniqueName(`${m.name} copy`)
		if (!name || [...name].length > 64 || machines.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new RpcError('CONFLICT', 'Choose a name no other machine has')
		if (!xmlChars(name)) throw new RpcError('BAD_REQUEST', 'That name can’t be used')
		// The source's history entry stays running until the copy ends, then follows its result.
		// No await between the name check above and adopt() adding the machine, or two clones could take one name.
		// adopt() saves the registry, source history included.
		const sourceTask = beginTask(m, 'clone', name)
		try {
			return await adopt(m, {name, keepIds: false, sourceTask: {m, t: sourceTask}, copyDisk: (d, dst) => run('qemu-img', ['convert', '-O', 'qcow2', d.file, dst], {timeout: 6 * 60 * 60_000})})
		} catch (error) {
			endTask(m, sourceTask, error)
			await save().catch(() => {})
			throw error
		}
	}

	// QEMU's own monitor (HMP), for the commands Proxmox's Monitor tab offers ("info status"…).
	const MONITOR_COMMANDS = new Set(['info', 'help', '?', 'system_reset', 'system_powerdown', 'system_wakeup', 'sendkey', 'stop', 'cont', 'c', 'nmi', 'mouse_move', 'mouse_button', 'balloon', 'set_link'])
	async function monitor(input = {}) {
		await ready
		const m = find(input.id)
		assertLocal(m)
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

	// For the console bridge: a local unix path, or the host agent for a remote guest.
	async function vncSocket(id) {
		await ready
		const m = find(id)
		const hostId = hostOf(m)
		if (hostId !== 'server') {
			const listed = await connector.list()
			const agent = (Array.isArray(listed) ? listed : []).find((a) => a.id === hostId)
			const name = agent?.name || 'that computer'
			if (!agent || agent.online !== true) throw new RpcError('PRECONDITION_FAILED', `${name} is offline right now`)
			if (!agent.allowed?.vms || !agent.on?.vms) throw new RpcError('FORBIDDEN', `Pair ${name} again with Virtual machines switched on.`)
			return {agentId: hostId, guest: id}
		}
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
			await uninstall({id: m.id, force: true}).catch((error) => console.error('[omarchyd] uninstall', m.name, error.message))
		}
	}

	// What each running machine uses right now (for the system usage breakdown): the latest sample.
	function usage() {
		touchWatch()
		const out = []
		for (const m of machines) {
			const last = lastPoint.get(m.id) ?? (series.get(m.id) ?? []).at(-1)
			if (!last || Date.now() - last.t > 30_000) continue
			out.push({id: `machine:${m.id}`, name: m.name, cpuShare: (last.cpu / 100) * (m.sockets ?? 1) * m.cores, memBytes: last.memMb * 1024 * 1024})
		}
		return out
	}

	async function usbBindings() {
		await ready
		const states = await domainStates()
		const out = []
		for (const m of machines) {
			if (hostOf(m) !== 'server') continue
			const running = STATE[states.get(domain(m.id))] === 'running'
			let liveIds = m.usbLive ?? []
			if (running) {
				try {
					liveIds = parseUsbLive(await virsh('dumpxml', domain(m.id)), m.usbDevices ?? [])
					if (!liveIds.length && (m.usbLive ?? []).length) liveIds = m.usbLive
				} catch {
					liveIds = m.usbLive ?? []
				}
			}
			out.push({kind: 'machine', id: m.id, name: m.name, devices: m.usbDevices ?? [], running, liveIds})
		}
		return out
	}
	async function bindUsb(id, rec) {
		await ready
		const m = find(id)
		assertLocal(m)
		if (!(m.usbDevices ?? []).some((d) => d.id === rec.id)) m.usbDevices = [...(m.usbDevices ?? []), rec]
		await save()
		await define(m).catch(() => {})
		return m
	}
	async function unbindUsb(id, deviceId) {
		await ready
		const m = find(id)
		assertLocal(m)
		m.usbDevices = (m.usbDevices ?? []).filter((d) => d.id !== deviceId)
		m.usbLive = (m.usbLive ?? []).filter((x) => x !== deviceId)
		await save()
		await define(m).catch(() => {})
		return m
	}
	async function attachHostdev(id, rec) {
		await ready
		const m = find(id)
		assertLocal(m)
		const file = join(vmsDir, m.id, 'usb-hostdev.xml')
		await writeFile(file, hostdevXml(rec), {mode: 0o600})
		try {
			await virsh('attach-device', domain(m.id), file, '--live')
			m.usbLive = [...new Set([...(m.usbLive ?? []), rec.id])]
			delete m.lastUsbError
			await save()
			return true
		} catch (error) {
			m.lastUsbError = error.message
			await save()
			return error.message || false
		}
	}
	async function detachHostdev(id, rec) {
		await ready
		const m = find(id)
		assertLocal(m)
		const file = join(vmsDir, m.id, 'usb-hostdev.xml')
		await writeFile(file, hostdevXml(rec), {mode: 0o600})
		try {
			await virsh('detach-device', domain(m.id), file, '--live')
			m.usbLive = (m.usbLive ?? []).filter((x) => x !== rec.id)
			await save()
			return true
		} catch {
			return false
		}
	}

	return {
		ready,
		usage,
		uninstallAll,
		importVm,
		importedVm(name) {
			const want = String(name ?? '').trim().toLowerCase()
			if (!want) return false
			return machines.some((m) => m.osId === 'imported' && m.state !== 'error' && (String(m.importedFrom ?? m.name).toLowerCase() === want || m.name.toLowerCase() === want))
		},
		// For the importer: whether an imported machine has finished copying, and how it went.
		importState(id) {
			const m = machines.find((x) => x.id === id)
			if (!m) return {done: true, error: 'It was removed'}
			return {done: !busy.has(id) && m.state !== 'installing', error: m.state === 'error' ? m.errorMessage || 'It didn’t work' : null, name: m.name}
		},
		vncSocket,
		bootRemote,
		usbBindings,
		bindUsb,
		unbindUsb,
		attachHostdev,
		detachHostdev,
		procedures: {
			'machines.capabilities': {kind: 'query', run: capabilities},
			'machines.osImages': {kind: 'query', run: osImages},
			'machines.localIsos': {kind: 'query', run: localIsos},
			'machines.isoDownloads': {kind: 'query', run: async () => listDownloads(isoDownloads)},
			'machines.downloadIso': {kind: 'mutation', run: downloadIso},
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
			'machines.installConnector': {kind: 'mutation', run: installConnector},
			'machines.nixosConfig': {kind: 'query', run: nixosConfig},
			'machines.setNixosConfig': {kind: 'mutation', run: setNixosConfig},
			'machines.applyNixosConfig': {kind: 'mutation', run: applyNixosConfig},
		},
	}
}
