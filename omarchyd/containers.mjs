// Containers (LXC) for omarchyd, run by Incus in its per-user mode.
//
// Why per-user Incus: the Incus daemon runs as root, but a member of the `incus` group (not
// `incus-admin`) only reaches incus-user's socket, which gives this account its own restricted
// project: its own containers, network and limits, unprivileged containers only, no host devices.
// That matches the virtual machines (QEMU on libvirt's per-user session) and keeps MODC's account
// from becoming root-equivalent. Nothing here listens on the network: Incus is reached through its
// local socket by the `incus` command, and a port is opened to the home network only when the owner
// adds one.
//
// The library is the Linux systems Incus already offers (images.linuxcontainers.org), plus the
// owner's own templates (a container saved as an image). Small app recipes are the App Store's job.

import {spawn} from 'node:child_process'
import {mkdir, mkdtemp, readdir, rm, stat, writeFile as writeFs} from 'node:fs/promises'
import os from 'node:os'
import {basename, join} from 'node:path'

import {readNixCache} from './nix-cache.mjs'
import {checkLink, fileNameFor, listDownloads, startDownload} from './download.mjs'
import {connectorKind} from './guest-install.mjs'
import {installLxcConnector} from './lxc-install.mjs'
import {
	configDir,
	ensureConfigDir,
	isNixosOs,
	NIXOS_GUEST_MOUNT,
	readConfiguration,
	validateNixosConfig,
	writeCacheFragment,
	writeConfiguration,
} from './nixos-config.mjs'
import {RpcError} from './rpc.mjs'
import {
	normalizeHostId,
	parseRemoteContainerList,
	remoteContainerCall,
	remoteHostStatus,
} from './remote-containers.mjs'

const NAME = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
const SNAPSHOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const ALIAS = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/
const TEMPLATE = /^modc\/[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
const PORT_DEVICE = /^port-(tcp|udp)-(\d{1,5})$/
const BACKUP_FILE = /^([a-z]([a-z0-9-]{0,61}[a-z0-9])?)--(\d{8}T\d{6}Z)\.tar\.gz$/
const SSH_KEY = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/
const FILE_LIMIT = 100 * 1024 * 1024

// The systems offered, in this order. Others in Incus's list (and older releases) stay out to keep
// the library short and maintained.
export const DISTROS = [
	{os: 'debian', name: 'Debian'},
	{os: 'ubuntu', name: 'Ubuntu'},
	{os: 'alpine', name: 'Alpine'},
	{os: 'archlinux', name: 'Arch Linux'},
	{os: 'fedora', name: 'Fedora'},
	{os: 'rockylinux', name: 'Rocky Linux'},
	{os: 'almalinux', name: 'AlmaLinux'},
	{os: 'centos', name: 'CentOS Stream'},
	{os: 'opensuse', name: 'openSUSE'},
	{os: 'devuan', name: 'Devuan'},
	{os: 'gentoo', name: 'Gentoo'},
	{os: 'nixos', name: 'NixOS'},
]

const ARCH = {x64: 'x86_64', arm64: 'aarch64'}[process.arch] ?? process.arch
const DEB_ARCH = {amd64: 'x86_64', arm64: 'aarch64', armhf: 'armv7l', i386: 'i686', riscv64: 'riscv64', ppc64el: 'ppc64le', s390x: 's390x'}

/** The one command that sets up containers (bin/machines-add-lxc, linked into ~/.local/bin). It
 * needs sudo, so the owner runs it; MODC never asks for the password. */
export function setupCommand() {
	return 'machines-add-lxc'
}

// Access to Incus's per-user door (/var/lib/incus/unix.socket.user) normally comes with the
// `incus` group, which this server's processes only pick up after the next sign-in or restart.
// machines-add-lxc also gives this account its own permission on that socket, so it works straight
// away; `incus` is always run directly. (An earlier version went through `sg incus`, but Arch
// doesn't ship `sg`, so it failed as if Incus weren't installed.)

/** Group a `incus image list images: --format json` listing into the library: per system, its
 * current releases for this server's architecture, newest first. */
export function libraryFrom(images, arch = ARCH, {all = false} = {}) {
	const byOs = new Map()
	const seen = new Map()
	for (const img of Array.isArray(images) ? images : []) {
		const p = img?.properties ?? {}
		// The image's own architecture is Incus's name (x86_64, aarch64); its properties use the
		// distribution's name (amd64, arm64), so either is accepted.
		const imgArch = String(img?.architecture ?? '') || (DEB_ARCH[p.architecture] ?? String(p.architecture ?? ''))
		if (img?.type !== 'container' || imgArch !== arch || (p.variant && p.variant !== 'default')) continue
		const osId = String(p.os ?? '').toLowerCase()
		// Every system Incus offers, when asked; otherwise the short, maintained list.
		const distro = DISTROS.find((d) => d.os === osId) ?? (all && /^[a-z0-9][a-z0-9._-]*$/.test(osId) ? {os: osId, name: String(p.os)} : null)
		if (!distro) continue
		if (!seen.has(distro.os)) seen.set(distro.os, distro)
		const alias = (img.aliases ?? [])
			.map((a) => a?.name)
			.filter((n) => typeof n === 'string' && ALIAS.test(n) && n.split('/').length === 2 && !n.endsWith('/default'))
			.sort((a, b) => a.length - b.length)[0]
		if (!alias) continue
		const release = String(p.release ?? alias.split('/')[1])
		const list = byOs.get(distro.os) ?? []
		if (!list.some((r) => r.alias === alias)) list.push({alias, release, description: String(p.description ?? `${distro.name} ${release}`), size: Number(img.size) || 0})
		byOs.set(distro.os, list)
	}
	// Rolling releases (current, edge, tumbleweed…) have no number.
	const rolling = (r) => !/\d/.test(r)
	const num = (r) => r.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
	const newer = (a, b) => {
		const [x, y] = [num(a.release), num(b.release)]
		for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
		return 0
	}
	const order = [...DISTROS.filter((d) => byOs.has(d.os)), ...[...seen.values()].filter((d) => !DISTROS.includes(d)).sort((a, b) => a.name.localeCompare(b.name))]
	return order.map((d) => ({
		os: d.os,
		name: d.name,
		// Numbered releases first (newest), then rolling ones; at most four.
		releases: byOs
			.get(d.os)
			.sort((a, b) => Number(rolling(a.release)) - Number(rolling(b.release)) || newer(a, b))
			.slice(0, 4),
	}))
}

const gib = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10
const bool = (v) => v === true || v === 'true'

function nixCacheConfText({enabled, substituter}) {
	const sub = String(substituter ?? '').trim()
	if (!enabled || !sub) return ''
	return `extra-substituters = ${sub}\n`
}

/** One container from `incus list --format json`, in the shape the web app shows. */
export function containerFrom(c) {
	const cfg = c?.config ?? {}
	const state = c?.state ?? {}
	const addresses = []
	for (const [nic, n] of Object.entries(state.network ?? {})) {
		if (nic === 'lo') continue
		for (const a of n?.addresses ?? []) if (a?.scope === 'global') addresses.push({family: a.family === 'inet6' ? 'IPv6' : 'IPv4', address: a.address})
	}
	const ports = []
	for (const [name, dev] of Object.entries(c?.devices ?? {})) {
		const m = PORT_DEVICE.exec(name)
		if (!m || dev?.type !== 'proxy') continue
		const inner = /:(\d+)$/.exec(String(dev.connect ?? ''))
		ports.push({protocol: m[1], hostPort: Number(m[2]), containerPort: inner ? Number(inner[1]) : null})
	}
	const root = c?.expanded_devices?.root ?? c?.devices?.root ?? {}
	const allowance = /^(\d{1,3})%$/.exec(String(cfg['limits.cpu.allowance'] ?? ''))
	return {
		name: String(c?.name ?? ''),
		status: String(c?.status ?? 'Unknown').toLowerCase(),
		os: String(cfg['image.os'] ?? '').toLowerCase(),
		release: String(cfg['image.release'] ?? ''),
		description: String(cfg['image.description'] ?? ''),
		cpus: cfg['limits.cpu'] ? Number(cfg['limits.cpu']) || null : null,
		cpuAllowance: allowance ? Number(allowance[1]) : null,
		cpuPriority: cfg['limits.cpu.priority'] !== undefined ? Number(cfg['limits.cpu.priority']) : null,
		memory: cfg['limits.memory'] ?? null,
		swap: cfg['limits.memory.swap'] === undefined ? true : bool(cfg['limits.memory.swap']),
		disk: root.size ?? null,
		memoryUsedGiB: state.memory?.usage ? gib(state.memory.usage) : null,
		addresses,
		ports: ports.sort((a, b) => a.hostPort - b.hostPort),
		snapshots: (c?.snapshots ?? []).map((s) => ({name: String(s?.name ?? '').split('/').pop(), createdAt: s?.created_at ?? null})),
		autostart: bool(cfg['boot.autostart']),
		bootOrder: cfg['boot.autostart.priority'] !== undefined ? Number(cfg['boot.autostart.priority']) : 0,
		bootDelay: cfg['boot.autostart.delay'] !== undefined ? Number(cfg['boot.autostart.delay']) : 0,
		protected: bool(cfg['security.protection.delete']),
		notes: String(cfg['user.modc.notes'] ?? ''),
		tags: String(cfg['user.modc.tags'] ?? '')
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean),
		createdAt: c?.created_at ?? null,
		...(bool(cfg['user.modc.nixos']) || isNixosOs(cfg['image.os']) ? {nixos: true} : {}),
	}
}

function defaultRun(args, opts = {}) {
	return execIncus('incus', args, opts)
}

export function execIncus(bin, args, {timeout = 60_000, input, binary = false, onOutput} = {}) {
	return new Promise((resolve, reject) => {
		// stdin is closed unless there's something to send. `incus launch` reads a config from stdin
		// whenever stdin isn't a terminal, so an open, empty pipe left it waiting forever: a new
		// container sat at "creating". Secrets (a root password) and uploads go in on stdin, never in
		// the arguments.
		const child = spawn(bin, args, {env: {...process.env, LC_ALL: 'C'}, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']})
		const out = []
		let size = 0
		let err = ''
		let killed = false
		const timer = setTimeout(() => ((killed = true), child.kill('SIGKILL')), timeout)
		child.stdout.on('data', (d) => {
			size += d.length
			if (size > FILE_LIMIT + 1024 * 1024) return child.kill('SIGKILL')
			out.push(d)
			if (onOutput) onOutput(String(d))
		})
		child.stderr.on('data', (d) => {
			err = (err + d).slice(-64 * 1024)
			if (onOutput) onOutput(String(d))
		})
		child.on('error', (e) => (clearTimeout(timer), reject(e)))
		child.on('close', (code) => {
			clearTimeout(timer)
			if (code === 0) return resolve(binary ? Buffer.concat(out) : Buffer.concat(out).toString())
			reject(Object.assign(new Error(killed ? `incus ${args[0]} took longer than ${Math.round(timeout / 60_000)} minutes` : `incus exited ${code}`), {code, stderr: killed ? '' : err}))
		})
		if (child.stdin) {
			child.stdin.on('error', () => {})
			child.stdin.end(input)
		}
	})
}

/**
 * @param {object} o
 * @param {(args: string[], opts?: {timeout?: number, input?: string|Buffer, binary?: boolean}) => Promise<string|Buffer>} [o.run] runs `incus`
 * @param {number[]} [o.reservedPorts] this server's own ports, never handed to a container
 * @param {string} [o.backupsDir] where container backups are kept
 * @param {{resolve: (virtual: string, o: {mustExist: boolean}) => Promise<{real: string}>}} [o.files] the server's Files, to copy files in and out
 * @param {{pair?: Function, list?: Function, call?: Function, caCertificate?: Function}} [o.connector] local swarm for connector install and remote Incus
 * @param {string} [o.dataDir] MODC data dir (NixOS config shares live under `{dataDir}/nixos-configs/`)
 */
export function createContainers({run = defaultRun, reservedPorts = [], user = os.userInfo().username, backupsDir = null, files = null, dataDir = null, now = Date.now, connector = null, connectorEnrollTimeoutMs = 10 * 60_000} = {}) {
	// Containers that don't exist yet (being created, cloned or restored), and work on existing ones
	// (backing up, saving as a template, first-time setup). A failure stays visible for 10 minutes.
	const pending = new Map() // name -> {what, from?, error?, at}
	const jobs = new Map() // name -> {what, error?, at}
	let library = null // {at, value}
	const samples = new Map() // name -> [{t, cpu, rx, tx}]
	let lastSample = -Infinity

	const message = (error) => {
		const text = String(error?.stderr || error?.message || error).trim()
		return (text.split('\n').filter(Boolean).pop() ?? 'Incus failed').replace(/^Error:\s*/, '')
	}
	const incus = async (args, opts) => {
		try {
			return await run(args, opts)
		} catch (error) {
			if (error?.code === 'ENOENT') throw new RpcError('PRECONDITION_FAILED', 'CONTAINERS_NOT_SET_UP: Incus isn’t installed on this server yet.')
			throw new RpcError('INTERNAL_SERVER_ERROR', message(error))
		}
	}
	const name = (v) => {
		const n = String(v ?? '')
		if (!NAME.test(n)) throw new RpcError('BAD_REQUEST', 'Use lowercase letters, numbers and dashes for the name (up to 63, starting with a letter).')
		return n
	}
	const expire = (map) => {
		for (const [k, v] of map) if (v.error && now() - v.at > 10 * 60_000) map.delete(k)
	}
	/** Run slow work in the background; the list shows it until it's done. */
	const background = (map, key, what, work, extra = {}) => {
		map.set(key, {what, at: now(), startedAt: new Date(now()).toISOString(), ...extra})
		work().then(
			() => map.delete(key),
			(error) => map.set(key, {what, at: now(), ...extra, error: error?.message ?? String(error)}),
		)
	}
	const notBusy = (n) => {
		const j = jobs.get(n)
		if (j && !j.error) throw new RpcError('CONFLICT', `${n} is busy ${j.what}`)
		jobs.delete(n)
	}

	async function listedAgents() {
		if (!connector?.list) return []
		try {
			return (await connector.list()).filter((a) => a?.id && !a.guestOf && !a.containerOf)
		} catch {
			return []
		}
	}

	async function hostStatus(input = {}) {
		const hostId = normalizeHostId(input.hostId)
		if (hostId === 'server') return status()
		return remoteHostStatus({connector, agents: await listedAgents(), hostId})
	}

	async function status() {
		let out
		try {
			out = await run(['query', '/1.0'], {timeout: 10_000})
		} catch (error) {
			const text = String(error?.stderr || error?.message || '')
			const reason =
				error?.code === 'ENOENT'
					? 'Incus isn’t installed on this server yet.'
					: /permission denied/i.test(text)
						? 'This account can’t reach Incus yet. Run the setup below again; it gives your account access without a restart.'
						: /no such file|connection refused|unix\.socket/i.test(text)
							? 'Incus is installed but its per-user service isn’t running.'
							: message(error)
			return {available: false, reason, setupCommand: setupCommand()}
		}
		let info = {}
		try {
			info = JSON.parse(String(out))
		} catch {
			/* older output */
		}
		return {available: true, version: info?.environment?.server_version ?? null, project: info?.environment?.project ?? null}
	}

	async function raw() {
		const out = await incus(['list', '--format', 'json'], {timeout: 20_000})
		try {
			return JSON.parse(String(out)).filter((c) => c?.type === 'container')
		} catch {
			throw new RpcError('INTERNAL_SERVER_ERROR', 'Incus gave a list this server couldn’t read')
		}
	}

	async function localList() {
		expire(pending)
		expire(jobs)
		const rows = (await raw()).map((c) => {
			const row = containerFrom(c)
			const j = jobs.get(row.name)
			// Incus lists a new container (stopped) before `launch` has started it. Until launch
			// finishes it's still being created: no Start button to race it.
			const p = pending.get(row.name)
			if (p && !p.error) return {...row, hostId: 'server', job: p.what, error: null, progress: p.progress ?? null, startedAt: p.startedAt ?? null}
			return {...row, hostId: 'server', job: j && !j.error ? j.what : null, error: j?.error ?? null}
		})
		for (const [n, p] of pending)
			if (!rows.some((r) => r.name === n))
				rows.push({
					...containerFrom({name: n, status: p.error ? 'error' : p.what}),
					hostId: 'server',
					os: p.os ?? '',
					release: p.release ?? '',
					job: null,
					error: p.error ?? null,
					from: p.from ?? null,
					pending: true,
					progress: p.error ? null : (p.progress ?? null),
					startedAt: p.startedAt ?? null,
				})
		return rows
	}

	async function list() {
		const rows = await localList()
		if (!connector?.call) return rows.sort((a, b) => a.name.localeCompare(b.name))
		for (const agent of await listedAgents()) {
			if (!agent.online) continue
			try {
				const remoteRaw = await remoteContainerCall(connector, agent.id, 'lxc-list', {}, 30_000)
				for (const c of parseRemoteContainerList(remoteRaw))
					rows.push({...containerFrom(c), hostId: agent.id, job: null, error: null})
			} catch {
				/* skip unreachable hosts */
			}
		}
		return rows.sort((a, b) => a.name.localeCompare(b.name))
	}

	async function containerHost(name) {
		if ((await raw()).some((c) => c.name === name)) return 'server'
		if (!connector?.call) return 'server'
		const row = (await list()).find((c) => c.name === name)
		if (!row) throw new RpcError('NOT_FOUND', 'No such container')
		return row.hostId || 'server'
	}

	async function images({refresh = false, all: everything = false} = {}) {
		if (!refresh && library && now() - library.at < 6 * 3600_000) return libraryFrom(library.value, ARCH, {all: !!everything})
		// Filtered here (containers, this architecture), not on the command line.
		const out = await incus(['image', 'list', 'images:', '--format', 'json'], {timeout: 90_000})
		let all = []
		try {
			all = JSON.parse(String(out))
		} catch {
			throw new RpcError('INTERNAL_SERVER_ERROR', 'The container library couldn’t be read')
		}
		library = {at: now(), value: all}
		return libraryFrom(all, ARCH, {all: !!everything})
	}

	/** The owner's own templates: containers saved as images, aliased modc/<name>. */
	async function templates() {
		const out = await incus(['image', 'list', '--format', 'json'], {timeout: 20_000})
		let all = []
		try {
			all = JSON.parse(String(out))
		} catch {
			return []
		}
		const rows = []
		for (const img of all) {
			if (img?.type && img.type !== 'container') continue
			const alias = (img?.aliases ?? []).map((a) => a?.name).find((n) => typeof n === 'string' && TEMPLATE.test(n))
			if (!alias) continue
			rows.push({alias, name: alias.slice(5), os: String(img?.properties?.os ?? '').toLowerCase(), release: String(img?.properties?.release ?? ''), size: Number(img?.size) || 0, createdAt: img?.created_at ?? null, from: String(img?.properties?.['user.modc.from'] ?? img?.properties?.description ?? '')})
		}
		return rows.sort((a, b) => a.name.localeCompare(b.name))
	}

	const intIn = (v, lo, hi, msg) => {
		const n = Number(v)
		if (!Number.isInteger(n) || n < lo || n > hi) throw new RpcError('BAD_REQUEST', msg)
		return n
	}
	const limits = (input) => {
		const cores = os.cpus().length
		const out = []
		if (input.cpus !== undefined) out.push(`limits.cpu=${intIn(input.cpus, 1, cores, `Use 1 to ${cores} CPUs`)}`)
		if (input.cpuAllowance !== undefined && input.cpuAllowance !== null) out.push(`limits.cpu.allowance=${intIn(input.cpuAllowance, 5, 100, 'Use a CPU share of 5 to 100%')}%`)
		if (input.cpuPriority !== undefined) out.push(`limits.cpu.priority=${intIn(input.cpuPriority, 0, 10, 'Use a CPU priority of 0 to 10')}`)
		if (input.memoryMiB !== undefined) out.push(`limits.memory=${intIn(input.memoryMiB, 128, Math.floor(os.totalmem() / 1024 ** 2), 'That’s more memory than this server has')}MiB`)
		if (input.swap !== undefined) out.push(`limits.memory.swap=${input.swap ? 'true' : 'false'}`)
		return out
	}
	const secrets = (input) => {
		const password = input.rootPassword === undefined || input.rootPassword === '' ? null : String(input.rootPassword)
		if (password !== null && (password.length < 8 || password.length > 128 || /[\r\n:]/.test(password)))
			throw new RpcError('BAD_REQUEST', 'Use 8 to 128 characters for the root password, without line breaks or colons')
		const key = input.sshKey === undefined || input.sshKey === '' ? null : String(input.sshKey).trim()
		if (key !== null && !SSH_KEY.test(key)) throw new RpcError('BAD_REQUEST', 'That doesn’t look like an SSH public key (it starts with ssh-ed25519, ssh-rsa or ecdsa-…)')
		return {password, key}
	}
	/** Root password and SSH key, once the container has started. Both go in on stdin. */
	async function firstSetup(n, {password, key}) {
		const execIn = async (script, input) => {
			let last
			// Right after starting, the system inside may still be coming up.
			for (let i = 0; i < 10; i++) {
				try {
					return await run(['exec', n, '--', 'sh', '-c', script], {timeout: 30_000, input})
				} catch (error) {
					last = error
					await new Promise((r) => setTimeout(r, 1500))
				}
			}
			throw new Error(message(last))
		}
		if (password) await execIn('chpasswd', `root:${password}\n`).catch((e) => Promise.reject(new Error(`Couldn’t set the root password: ${e.message}`)))
		if (key) await execIn('umask 077 && mkdir -p /root/.ssh && cat >> /root/.ssh/authorized_keys', `${key}\n`).catch((e) => Promise.reject(new Error(`Couldn’t add the SSH key: ${e.message}`)))
	}

	const nixosShare = () => {
		if (!dataDir) throw new RpcError('PRECONDITION_FAILED', 'Server storage isn’t set up for NixOS configuration shares yet.')
		return dataDir
	}
	const containerIsNixos = (c) => {
		const cfg = c?.config ?? {}
		return bool(cfg['user.modc.nixos']) || isNixosOs(cfg['image.os'])
	}
	async function requireNixosContainer(n) {
		const row = (await list()).find((c) => c.name === n)
		if (!row) throw new RpcError('NOT_FOUND', 'No such container')
		if (!row.nixos) throw new RpcError('BAD_REQUEST', 'That container isn’t a NixOS guest.')
		return row
	}

	async function create(input = {}) {
		const n = name(input.name)
		const hostId = normalizeHostId(input.hostId)
		const image = String(input.image ?? '')
		let source
		let meta = {}
		let osId = ''
		if (image.startsWith('template:')) {
			const alias = image.slice(9)
			const tpl = (await templates()).find((t) => t.alias === alias)
			if (!TEMPLATE.test(alias) || !tpl) throw new RpcError('BAD_REQUEST', 'That template isn’t on this server')
			source = alias
			osId = tpl.os
			meta = {from: alias.slice(5), os: osId, release: tpl.release}
		} else {
			if (!ALIAS.test(image)) throw new RpcError('BAD_REQUEST', 'Pick a system from the library')
			const lib = await images({all: true})
			if (!lib.some((d) => d.releases.some((r) => r.alias === image))) throw new RpcError('BAD_REQUEST', 'That system isn’t in the library')
			source = `images:${image}`
			osId = image.split('/')[0]
			meta = {os: osId, release: image.split('/')[1]}
		}
		const nixos = isNixosOs(osId)
		if (input.nixosConfig && !nixos) throw new RpcError('BAD_REQUEST', 'NixOS configuration is only for NixOS images.')
		const config = limits({cpus: input.cpus ?? 1, memoryMiB: input.memoryMiB ?? 1024, ...(input.cpuAllowance !== undefined ? {cpuAllowance: input.cpuAllowance} : {}), ...(input.swap !== undefined ? {swap: input.swap} : {})})
		const diskGiB = intIn(input.diskGiB ?? 8, 1, 4096, 'Use 1 to 4096 GB of disk')
		if (input.autostart) config.push('boot.autostart=true')
		if (nixos) config.push('security.nesting=true', 'user.modc.nixos=true')
		const cred = secrets(input)
		if (pending.has(n) && !pending.get(n).error) throw new RpcError('CONFLICT', `${n} is already being created`)
		if (hostId !== 'server') {
			if (cred.password || cred.key) throw new RpcError('PRECONDITION_FAILED', 'Set the root password and SSH key on this server. A container on another computer keeps the sign-in that image ships with.')
			if (image.startsWith('template:')) throw new RpcError('BAD_REQUEST', 'Templates on another computer aren’t supported yet. Use a library image.')
			if ((await list()).some((c) => c.name === n)) throw new RpcError('CONFLICT', `There’s already a container named ${n}`)
			const remote = await remoteHostStatus({connector, agents: await listedAgents(), hostId})
			if (!remote.available) {
				const who = remote.hostName || 'That computer'
				throw new RpcError('PRECONDITION_FAILED', `${who} needs Incus set up first. ${remote.reason} Run ${remote.setupCommand ?? setupCommand()} on ${who}.`)
			}
			if (nixos) {
				const writeBody = {name: n}
				if (input.nixosConfig) {
					const checked = validateNixosConfig(input.nixosConfig)
					if (!checked.ok) throw new RpcError('BAD_REQUEST', checked.error)
					writeBody.configuration = checked.config
					const cache = await readNixCache(nixosShare())
					writeBody.cacheConf = nixCacheConfText(cache)
				}
				await remoteContainerCall(connector, hostId, 'lxc-write-config', writeBody, 60_000)
			}
			await remoteContainerCall(
				connector,
				hostId,
				'lxc-launch',
				{name: n, source, configs: config, diskGiB, ...(nixos ? {nixosShare: true} : {})},
				30 * 60_000,
			)
			return {name: n, hostId, ...(nixos ? {nixos: true} : {})}
		}
		if (nixos) {
			const root = nixosShare()
			await ensureConfigDir(root, n)
			if (input.nixosConfig) {
				const checked = validateNixosConfig(input.nixosConfig)
				if (!checked.ok) throw new RpcError('BAD_REQUEST', checked.error)
				try {
					await writeConfiguration(root, n, checked.config)
				} catch (error) {
					throw new RpcError('BAD_REQUEST', String(error?.message ?? error))
				}
				const cache = await readNixCache(root)
				await writeCacheFragment(root, n, cache)
			}
		}
		if ((await raw()).some((c) => c.name === n)) throw new RpcError('CONFLICT', `There’s already a container named ${n}`)
		const shareRoot = nixos ? nixosShare() : null
		// Downloading a system the first time takes a while: the list shows it as being created.
		background(
			pending,
			n,
			'creating',
			async () => {
				// Incus prints its progress ("Retrieving image: rootfs: 45% (12.3MB/s)"); the list shows the latest.
				const onOutput = (text) => {
					const line = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop()
					const p = pending.get(n)
					if (line && p && !p.error) p.progress = line.replace(/^Retrieving image:\s*/i, 'Downloading ').slice(0, 120)
				}
				await incus(['launch', source, n, ...config.flatMap((c) => ['--config', c]), '--device', `root,size=${diskGiB}GiB`], {timeout: 20 * 60_000, onOutput})
				if (nixos && shareRoot) {
					await incus([
						'config', 'device', 'add', n, 'modc-nixos-config', 'disk',
						`source=${configDir(shareRoot, n)}`,
						`path=${NIXOS_GUEST_MOUNT}`,
						'readonly=true',
					])
				}
				if (cred.password || cred.key) background(jobs, n, 'setting up', () => firstSetup(n, cred))
			},
			{...meta, ...(nixos ? {nixos: true} : {})},
		)
		return {name: n}
	}

	const remotePower = {start: 'lxc-start', stop: 'lxc-stop', restart: 'lxc-restart', forceStop: 'lxc-force-stop'}
	const power = (verb) => async (input = {}) => {
		const n = name(input.name)
		const hostId = await containerHost(n)
		if (hostId !== 'server') {
			const call = remotePower[verb]
			if (!call) throw new RpcError('PRECONDITION_FAILED', 'That isn’t available on a remote container yet.')
			try {
				await remoteContainerCall(connector, hostId, call, {name: n}, verb === 'restart' ? 90_000 : 120_000)
			} catch (error) {
				if (verb === 'stop' && error instanceof RpcError) throw new RpcError('PRECONDITION_FAILED', `STOP_TIMED_OUT: ${n} didn’t shut down within a minute. Force stop turns it off straight away.`)
				throw error
			}
			return {ok: true}
		}
		jobs.get(n)?.error && jobs.delete(n)
		if (verb === 'start') await incus(['start', n])
		else if (verb === 'restart') await incus(['restart', n, '--timeout', '60'], {timeout: 90_000})
		else if (verb === 'stop') {
			try {
				await incus(['stop', n, '--timeout', '60'], {timeout: 90_000})
			} catch (error) {
				throw new RpcError('PRECONDITION_FAILED', `STOP_TIMED_OUT: ${n} didn’t shut down within a minute (${error.message}). Force stop turns it off straight away.`)
			}
		} else if (verb === 'forceStop') await incus(['stop', n, '--force'])
		return {ok: true}
	}

	async function remove(input = {}) {
		const n = name(input.name)
		const hostId = await containerHost(n)
		if (pending.get(n)?.error) {
			pending.delete(n)
			return {ok: true}
		}
		notBusy(n)
		// Protection is enforced by Incus too; this gives the reason in plain words.
		if ((await list()).find((c) => c.name === n)?.protected) throw new RpcError('PRECONDITION_FAILED', `${n} is protected. Turn off Protection first.`)
		if (hostId !== 'server') {
			await remoteContainerCall(connector, hostId, 'lxc-delete', {name: n}, 120_000)
			samples.delete(n)
			return {ok: true}
		}
		await incus(['delete', n, '--force'], {timeout: 120_000})
		samples.delete(n)
		return {ok: true}
	}

	const snapshot = (verb) => async (input = {}) => {
		const n = name(input.name)
		const s = String(input.snapshot ?? '')
		if (!SNAPSHOT.test(s)) throw new RpcError('BAD_REQUEST', 'Use letters, numbers, dots, dashes and underscores for the snapshot name')
		await incus(['snapshot', verb, n, s], {timeout: 300_000})
		return {ok: true}
	}

	const portNumber = (v, what) => intIn(v, 1, 65535, `${what} must be 1 to 65535`)
	async function addPort(input = {}) {
		const n = name(input.name)
		const protocol = input.protocol === 'udp' ? 'udp' : 'tcp'
		const hostPort = portNumber(input.hostPort, 'The server’s port')
		const containerPort = portNumber(input.containerPort, 'The container’s port')
		if (hostPort < 1024) throw new RpcError('BAD_REQUEST', 'Use a server port of 1024 or higher; lower ones belong to the server’s own services.')
		if (reservedPorts.includes(hostPort)) throw new RpcError('CONFLICT', `Port ${hostPort} is My Own Data Center’s own`)
		const taken = (await list()).find((c) => c.ports.some((p) => p.hostPort === hostPort && p.protocol === protocol))
		if (taken) throw new RpcError('CONFLICT', `${taken.name} already uses port ${hostPort}`)
		await incus(['config', 'device', 'add', n, `port-${protocol}-${hostPort}`, 'proxy', `listen=${protocol}:0.0.0.0:${hostPort}`, `connect=${protocol}:127.0.0.1:${containerPort}`])
		return {ok: true}
	}
	async function removePort(input = {}) {
		const n = name(input.name)
		const protocol = input.protocol === 'udp' ? 'udp' : 'tcp'
		const hostPort = portNumber(input.hostPort, 'The server’s port')
		await incus(['config', 'device', 'remove', n, `port-${protocol}-${hostPort}`])
		return {ok: true}
	}

	/** CPUs, CPU share and priority, memory and swap (applied live), and growing the disk. */
	async function setResources(input = {}) {
		const n = name(input.name)
		const c = (await list()).find((x) => x.name === n)
		if (!c) throw new RpcError('NOT_FOUND', 'No such container')
		const set = limits(input)
		if (input.cpuAllowance === null) await incus(['config', 'unset', n, 'limits.cpu.allowance'])
		if (set.length) await incus(['config', 'set', n, ...set])
		if (input.diskGiB !== undefined) {
			const want = intIn(input.diskGiB, 1, 4096, 'Use 1 to 4096 GB of disk')
			const have = /^(\d+)GiB$/.exec(String(c.disk ?? ''))
			if (have && want < Number(have[1])) throw new RpcError('BAD_REQUEST', 'A container’s disk can grow but not shrink')
			if (!have || want !== Number(have[1])) {
				// The root disk usually comes from the profile: override it on this container the first time.
				try {
					await run(['config', 'device', 'set', n, 'root', `size=${want}GiB`])
				} catch {
					await incus(['config', 'device', 'override', n, 'root', `size=${want}GiB`])
				}
			}
		}
		return {ok: true}
	}

	/** Start with the server (and in what order), protection, notes and tags. */
	async function setOptions(input = {}) {
		const n = name(input.name)
		const set = []
		const unset = []
		if (input.autostart !== undefined) set.push(`boot.autostart=${input.autostart ? 'true' : 'false'}`)
		if (input.bootOrder !== undefined) set.push(`boot.autostart.priority=${intIn(input.bootOrder, 0, 100, 'Use a start order of 0 to 100')}`)
		if (input.bootDelay !== undefined) set.push(`boot.autostart.delay=${intIn(input.bootDelay, 0, 600, 'Use a delay of 0 to 600 seconds')}`)
		if (input.protected !== undefined) set.push(`security.protection.delete=${input.protected ? 'true' : 'false'}`)
		if (input.notes !== undefined) {
			const notes = String(input.notes)
			if (notes.length > 2000) throw new RpcError('BAD_REQUEST', 'Keep notes under 2000 characters')
			if (notes.trim()) set.push(`user.modc.notes=${notes}`)
			else unset.push('user.modc.notes')
		}
		if (input.tags !== undefined) {
			const tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
			if (tags.length > 12 || tags.some((t) => !TAG.test(t))) throw new RpcError('BAD_REQUEST', 'Tags are short words: lowercase letters, numbers and dashes, up to 12 of them')
			if (tags.length) set.push(`user.modc.tags=${tags.join(',')}`)
			else unset.push('user.modc.tags')
		}
		if (set.length) await incus(['config', 'set', n, ...set])
		for (const key of unset) await incus(['config', 'unset', n, key]).catch(() => {})
		return {ok: true}
	}

	async function clone(input = {}) {
		const from = name(input.name)
		const to = name(input.as)
		if ((await raw()).some((c) => c.name === to) || (pending.has(to) && !pending.get(to).error)) throw new RpcError('CONFLICT', `There’s already a container named ${to}`)
		// A copy gets its own MAC and address; its snapshots stay with the original.
		background(pending, to, 'cloning', () => incus(['copy', from, to, '--instance-only'], {timeout: 30 * 60_000}), {from})
		return {name: to}
	}

	async function saveTemplate(input = {}) {
		const n = name(input.name)
		const t = name(input.template)
		if ((await templates()).some((x) => x.name === t)) throw new RpcError('CONFLICT', `There’s already a template named ${t}`)
		notBusy(n)
		// Published from a snapshot, so a running container keeps running.
		const snap = `modc-template-${now()}`
		background(jobs, n, 'saving as a template', async () => {
			await incus(['snapshot', 'create', n, snap], {timeout: 300_000})
			try {
				await incus(['publish', `${n}/${snap}`, '--alias', `modc/${t}`, `user.modc.from=${n}`], {timeout: 30 * 60_000})
			} finally {
				await run(['snapshot', 'delete', n, snap]).catch(() => {})
			}
		})
		return {ok: true}
	}
	async function deleteTemplate(input = {}) {
		const t = name(input.template)
		if (!(await templates()).some((x) => x.name === t)) throw new RpcError('NOT_FOUND', 'No such template')
		await incus(['image', 'delete', `modc/${t}`])
		return {ok: true}
	}

	// ---- backups -------------------------------------------------------------------------------
	const needBackups = () => {
		if (!backupsDir) throw new RpcError('PRECONDITION_FAILED', 'Container backups aren’t set up on this server')
		return backupsDir
	}
	async function backups(input = {}) {
		const dir = needBackups()
		const only = input?.name ? name(input.name) : null
		const names = await readdir(dir).catch(() => [])
		const rows = []
		for (const file of names) {
			const m = BACKUP_FILE.exec(file)
			if (!m || (only && m[1] !== only)) continue
			const st = await stat(join(dir, file)).catch(() => null)
			if (!st) continue
			const iso = m[3].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z')
			rows.push({file, name: m[1], createdAt: iso, size: st.size})
		}
		return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
	}
	async function backup(input = {}) {
		const n = name(input.name)
		const dir = needBackups()
		notBusy(n)
		await mkdir(dir, {recursive: true, mode: 0o700})
		const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
		const file = `${n}--${stamp}.tar.gz`
		// Like Proxmox's backups: the container as it is now, without its snapshots.
		background(jobs, n, 'backing up', async () => {
			try {
				await incus(['export', n, join(dir, file), '--instance-only'], {timeout: 60 * 60_000})
			} catch (error) {
				await rm(join(dir, file), {force: true})
				throw error
			}
		})
		return {file}
	}
	async function restoreBackup(input = {}) {
		const dir = needBackups()
		const file = String(input.file ?? '')
		const m = BACKUP_FILE.exec(file)
		if (!m) throw new RpcError('BAD_REQUEST', 'No such backup')
		await stat(join(dir, file)).catch(() => Promise.reject(new RpcError('NOT_FOUND', 'No such backup')))
		const as = name(input.as ?? m[1])
		if ((await raw()).some((c) => c.name === as) || (pending.has(as) && !pending.get(as).error))
			throw new RpcError('CONFLICT', `There’s already a container named ${as}. Restore under a new name, or delete it first.`)
		background(pending, as, 'restoring', () => incus(['import', join(dir, file), as], {timeout: 60 * 60_000}), {from: m[1]})
		return {name: as}
	}
	async function deleteBackup(input = {}) {
		const dir = needBackups()
		const file = String(input.file ?? '')
		if (!BACKUP_FILE.test(file)) throw new RpcError('BAD_REQUEST', 'No such backup')
		await rm(join(dir, file), {force: true})
		return {ok: true}
	}

	// ---- live graphs ---------------------------------------------------------------------------
	/** CPU (% of the CPUs it may use) and network (KB/s) over the last few minutes, sampled while
	 * someone is looking (each call takes a sample at most every 4 seconds). */
	async function stats() {
		const t = now()
		if (t - lastSample >= 4000) {
			lastSample = t
			const cores = os.cpus().length
			for (const c of await raw()) {
				if (String(c?.status).toLowerCase() !== 'running') {
					samples.delete(c.name)
					continue
				}
				const cpuNs = Number(c?.state?.cpu?.usage) || 0
				let rx = 0
				let tx = 0
				for (const [nic, net] of Object.entries(c?.state?.network ?? {})) {
					if (nic === 'lo') continue
					rx += Number(net?.counters?.bytes_received) || 0
					tx += Number(net?.counters?.bytes_sent) || 0
				}
				const list = samples.get(c.name) ?? []
				const prev = list.at(-1)
				const cpus = Number(c?.config?.['limits.cpu']) || cores
				const point = {t, cpuNs, rx, tx, cpu: 0, rxKBs: 0, txKBs: 0}
				if (prev && t > prev.t) {
					const secs = (t - prev.t) / 1000
					point.cpu = Math.max(0, Math.min(100, Math.round(((cpuNs - prev.cpuNs) / (secs * 1e9 * cpus)) * 1000) / 10))
					point.rxKBs = Math.max(0, Math.round((rx - prev.rx) / 1024 / secs))
					point.txKBs = Math.max(0, Math.round((tx - prev.tx) / 1024 / secs))
				}
				list.push(point)
				samples.set(c.name, list.slice(-60))
			}
		}
		return Object.fromEntries(
			[...samples].map(([n, list]) => [n, {cpu: list.slice(1).map((p) => p.cpu), rxKBs: list.slice(1).map((p) => p.rxKBs), txKBs: list.slice(1).map((p) => p.txKBs)}]),
		)
	}

	// ---- files ---------------------------------------------------------------------------------
	const insidePath = (v) => {
		const p = String(v ?? '')
		if (!p.startsWith('/') || p.includes('\0') || p.split('/').includes('..')) throw new RpcError('BAD_REQUEST', 'Use a full path inside the container, like /root')
		return p.replace(/\/+$/, '') || '/'
	}
	async function listDir(input = {}) {
		const n = name(input.name)
		const path = insidePath(input.path ?? '/root')
		// The path is passed as an argument to the script, never pasted into it.
		const script = 'cd "$1" || exit 3; for f in * .[!.]* ..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; if [ -d "$f" ]; then t=d; elif [ -L "$f" ]; then t=l; else t=f; fi; s=$(wc -c < "$f" 2>/dev/null || echo 0); printf "%s\\t%s\\t%s\\n" "$t" "$s" "$f"; done'
		let out
		try {
			out = String(await run(['exec', n, '--', 'sh', '-c', script, 'sh', path], {timeout: 30_000}))
		} catch (error) {
			if (error?.code === 3 || /exited 3/.test(String(error?.message))) throw new RpcError('NOT_FOUND', `${path} isn’t a folder in ${n}`)
			throw new RpcError('INTERNAL_SERVER_ERROR', message(error))
		}
		const entries = out
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [t, s, ...rest] = line.split('\t')
				return {name: rest.join('\t'), type: t === 'd' ? 'folder' : t === 'l' ? 'link' : 'file', size: t === 'd' ? null : Number(s.trim()) || 0}
			})
			.sort((a, b) => Number(b.type === 'folder') - Number(a.type === 'folder') || a.name.localeCompare(b.name))
		return {path, entries}
	}
	/** Read a file out of a container (for a download), up to 100 MB. */
	async function readFile(n, path) {
		const data = await incus(['file', 'pull', `${name(n)}${insidePath(path)}`, '-'], {timeout: 120_000, binary: true})
		if (data.length > FILE_LIMIT) throw new RpcError('BAD_REQUEST', 'Files larger than 100 MB can’t be downloaded this way')
		return {name: insidePath(path).split('/').pop() || 'file', data}
	}
	/** Write an uploaded file into a container (as root). */
	async function writeFile(n, path, data) {
		const p = insidePath(path)
		if (data.length > FILE_LIMIT) throw new RpcError('BAD_REQUEST', 'Files larger than 100 MB can’t be uploaded this way')
		await incus(['file', 'push', '-', `${name(n)}${p}`, '--uid', '0', '--gid', '0', '--mode', '0644'], {timeout: 120_000, input: data})
		return {path: p}
	}
	/** Copy a file from a container into one of the server's folders (Files' own paths, like /Home/Downloads). */
	async function copyToServer(input = {}) {
		if (!files?.resolve) throw new RpcError('PRECONDITION_FAILED', 'Server file storage isn’t available')
		const n = name(input.name)
		const file = await readFile(n, input.path)
		const dir = String(input.serverDir || '/Home/Downloads').replace(/\/+$/, '')
		const {real: realDir} = await files.resolve(dir, {mustExist: true})
		if (!(await stat(realDir).catch(() => null))?.isDirectory()) throw new RpcError('BAD_REQUEST', 'Pick a folder on the server')
		const safe = file.name.replace(/[/\\\0]/g, '_')
		const {real} = await files.resolve(`${dir}/${safe}`, {mustExist: false})
		const {writeFile: write} = await import('node:fs/promises')
		await write(real, file.data, {flag: 'wx'}).catch((e) => Promise.reject(e?.code === 'EEXIST' ? new RpcError('CONFLICT', `${safe} is already in ${dir}`) : e))
		return {path: `${dir}/${safe}`}
	}

	// ---- your own templates from a file -----------------------------------------------------------
	// Container templates in your Home folder: an Incus/LXD image (it has a metadata.yaml), or a plain
	// root filesystem tarball such as a Proxmox CT template. Both become one of Your templates.
	const TEMPLATE_FILE = /\.(tar\.(gz|xz|zst|bz2)|tgz|txz|tzst)$/i
	const downloads = new Map()
	const imports = new Map() // template name -> {file, error?, startedAt}
	async function templateFiles() {
		const found = []
		if (files?.resolve) {
			const {real: home} = await files.resolve('/Home', {mustExist: true})
			const walk = async (dir, depth) => {
				if (depth > 4 || found.length >= 100) return
				for (const e of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
					if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'Pools') continue
					const full = join(dir, e.name)
					if (e.isDirectory()) await walk(full, depth + 1)
					else if (e.isFile() && TEMPLATE_FILE.test(e.name)) {
						const st = await stat(full).catch(() => null)
						// Anything this small isn't a system.
						if (st && st.size > 2 * 1024 * 1024) found.push({path: `/Home${full.slice(home.length)}`, name: e.name, size: st.size})
					}
				}
			}
			await walk(home, 0)
		}
		for (const [k, v] of imports) if (v.error && now() - Date.parse(v.startedAt) > 10 * 60_000) imports.delete(k)
		return {
			files: found.sort((a, b) => a.name.localeCompare(b.name)),
			downloads: listDownloads(downloads, now),
			imports: [...imports].map(([template, v]) => ({template, file: v.file, error: v.error ?? null})),
		}
	}
	const tarEntries = (file) =>
		new Promise((resolve) => {
			// The first entries are enough: an Incus image starts with metadata.yaml.
			const child = spawn('tar', ['-tf', file], {stdio: ['ignore', 'pipe', 'ignore']})
			let buf = ''
			const lines = []
			const done = () => (child.kill('SIGKILL'), resolve(lines))
			child.stdout.on('data', (d) => {
				buf += d
				const parts = buf.split('\n')
				buf = parts.pop()
				lines.push(...parts)
				if (lines.length >= 50) done()
			})
			child.on('close', () => resolve(lines))
			child.on('error', () => resolve(lines))
			setTimeout(done, 60_000).unref?.()
		})
	async function importTemplate(input = {}) {
		if (!files?.resolve) throw new RpcError('PRECONDITION_FAILED', 'Server file storage isn’t available')
		const path = String(input.path ?? '')
		if (!path.startsWith('/Home/') || path.split('/').includes('..') || !TEMPLATE_FILE.test(path)) throw new RpcError('BAD_REQUEST', 'Pick a .tar.gz, .tar.xz or .tar.zst template file in your Home folder')
		const {real} = await files.resolve(path, {mustExist: true})
		const t = name(input.template ?? basename(path).toLowerCase().replace(TEMPLATE_FILE, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63))
		if ((await templates()).some((x) => x.name === t) || (imports.has(t) && !imports.get(t).error)) throw new RpcError('CONFLICT', `There’s already a template named ${t}`)
		imports.set(t, {file: basename(path), startedAt: new Date(now()).toISOString()})
		;(async () => {
			const entries = await tarEntries(real)
			if (!entries.length) throw new Error('That file isn’t a tar archive this server can read')
			if (entries.some((e) => e.replace(/^\.\//, '') === 'metadata.yaml')) {
				await incus(['image', 'import', real, '--alias', `modc/${t}`], {timeout: 60 * 60_000})
				return
			}
			// A plain root filesystem: give Incus the small description it needs alongside it.
			const lower = basename(path).toLowerCase()
			const osName = ['debian', 'ubuntu', 'alpine', 'archlinux', 'fedora', 'rockylinux', 'almalinux', 'centos', 'opensuse', 'devuan', 'gentoo'].find((d) => lower.includes(d === 'archlinux' ? 'arch' : d)) ?? 'linux'
			const release = /[-_](\d+(?:\.\d+)?)/.exec(lower)?.[1] ?? ''
			const work = await mkdtemp(join(os.tmpdir(), 'modc-template-'))
			try {
				const yaml = [
					`architecture: ${ARCH}`,
					`creation_date: ${Math.floor(now() / 1000)}`,
					'properties:',
					`  description: ${JSON.stringify(`${t} (from ${basename(path)})`)}`,
					`  os: ${JSON.stringify(osName)}`,
					`  release: ${JSON.stringify(release)}`,
					`  user.modc.from: ${JSON.stringify(basename(path))}`,
					// The container's own name as its host name (a root filesystem copied from somewhere
					// else otherwise keeps that machine's).
					'templates:',
					'  /etc/hostname:',
					'    when: [create, copy]',
					'    template: hostname.tpl',
					'',
				].join('\n')
				await writeFs(join(work, 'metadata.yaml'), yaml)
				await mkdir(join(work, 'templates'))
				await writeFs(join(work, 'templates', 'hostname.tpl'), '{{ instance.name }}\n')
				await new Promise((res, rej) => {
					const c = spawn('tar', ['-czf', join(work, 'meta.tar.gz'), '-C', work, 'metadata.yaml', 'templates'], {stdio: 'ignore'})
					c.on('close', (code) => (code === 0 ? res() : rej(new Error('Couldn’t prepare the template'))))
					c.on('error', rej)
				})
				await incus(['image', 'import', join(work, 'meta.tar.gz'), real, '--alias', `modc/${t}`], {timeout: 60 * 60_000})
			} finally {
				await rm(work, {recursive: true, force: true}).catch(() => {})
			}
		})().then(
			() => imports.delete(t),
			(e) => imports.set(t, {file: basename(path), startedAt: new Date(now()).toISOString(), error: e?.message ?? String(e)}),
		)
		return {template: t}
	}
	async function downloadTemplate(input = {}) {
		if (!files?.resolve) throw new RpcError('PRECONDITION_FAILED', 'Server file storage isn’t available')
		const url = await checkLink(input.url)
		const fileName = fileNameFor(url, TEMPLATE_FILE)
		if (!fileName) throw new RpcError('BAD_REQUEST', 'The link has to end in a template file: .tar.gz, .tar.xz or .tar.zst')
		const {real: dir} = await files.resolve('/Home/Downloads', {mustExist: false})
		await mkdir(dir, {recursive: true})
		return startDownload({url, dir, name: fileName, jobs: downloads, now})
	}

	/** A root shell inside a running container, for the terminal. */
	/** The container's own console (its login prompt, like Proxmox's), or a root shell inside it. */
	async function shellFor(n, mode = 'shell') {
		const c = (await list()).find((x) => x.name === name(n))
		if (!c) throw new RpcError('NOT_FOUND', 'No such container')
		if (c.status !== 'running') throw new RpcError('PRECONDITION_FAILED', `${c.name} isn’t running`)
		if (mode === 'console') return {command: ['incus', 'console', c.name]}
		return {command: ['incus', 'exec', c.name, '--env', 'TERM=xterm-256color', '--', 'su', '-l']}
	}

	/** Set (or change) root's password, for signing in at the console or over SSH. */
	async function setRootPassword(input = {}) {
		const n = name(input.name)
		const {password} = secrets({rootPassword: input.password})
		if (!password) throw new RpcError('BAD_REQUEST', 'Type a password of 8 to 128 characters')
		await firstSetup(n, {password, key: null}).catch((e) => Promise.reject(new RpcError('INTERNAL_SERVER_ERROR', e.message)))
		return {ok: true}
	}

	/** Install the Linux connector inside a running system container (owner; via incus exec). */
	async function installConnector(input = {}) {
		if (!connector?.pair || !connector?.list) throw new RpcError('PRECONDITION_FAILED', 'The local swarm isn’t ready yet.')
		const n = name(input.name)
		const c = (await list()).find((x) => x.name === n)
		if (!c) throw new RpcError('NOT_FOUND', 'No such container')
		if (c.status !== 'running') throw new RpcError('PRECONDITION_FAILED', 'Start the container first.')
		const os = connectorKind(c.os)
		if (os === 'unsupported') return {status: 'unsupported', os: 'other', message: 'This operating system can’t run the connector. It runs on Linux with systemd or Alpine OpenRC.'}
		const username = String(input?.username ?? '').trim()
		if (!username) throw new RpcError('PRECONDITION_FAILED', 'Give the container account to install as.')
		notBusy(n)
		background(jobs, n, 'installing connector', () =>
			installLxcConnector({
				name: n,
				username,
				osId: c.os,
				run,
				pair: (body) => connector.pair(body),
				listAgents: () => connector.list(),
				caCertificate: () => connector.caCertificate(),
				excludeAddresses: (c.addresses ?? []).map((a) => a.address),
				enrollTimeoutMs: connectorEnrollTimeoutMs,
			}),
		)
		return {status: 'started'}
	}

	async function nixosConfig(input = {}) {
		const n = name(input.name)
		await requireNixosContainer(n)
		const hostId = await containerHost(n)
		if (hostId !== 'server') {
			const out = await remoteContainerCall(connector, hostId, 'lxc-read-config', {name: n}, 30_000)
			return JSON.parse(String(out))
		}
		return readConfiguration(nixosShare(), n)
	}
	async function setNixosConfig(input = {}) {
		const n = name(input.name)
		await requireNixosContainer(n)
		const checked = validateNixosConfig(input.config ?? '')
		if (!checked.ok) throw new RpcError('BAD_REQUEST', checked.error)
		const hostId = await containerHost(n)
		if (hostId !== 'server') {
			const cache = await readNixCache(nixosShare())
			await remoteContainerCall(
				connector,
				hostId,
				'lxc-write-config',
				{name: n, configuration: checked.config, cacheConf: nixCacheConfText(cache)},
				60_000,
			)
			return nixosConfig({name: n})
		}
		const root = nixosShare()
		try {
			await writeConfiguration(root, n, checked.config)
		} catch (error) {
			throw new RpcError('BAD_REQUEST', String(error?.message ?? error))
		}
		const cache = await readNixCache(root)
		await writeCacheFragment(root, n, cache)
		return readConfiguration(root, n)
	}
	async function applyNixosConfig(input = {}) {
		const n = name(input.name)
		if (input.config !== undefined && input.config !== null) await setNixosConfig({name: n, config: input.config})
		else await requireNixosContainer(n)
		return power('restart')(input)
	}

	return {
		shellFor,
		readFile,
		writeFile,
		procedures: {
			'containers.status': {kind: 'query', run: status},
			'containers.hostStatus': {kind: 'query', run: hostStatus},
			'containers.list': {kind: 'query', run: list},
			'containers.images': {kind: 'query', run: (input) => images(input ?? {})},
			'containers.templates': {kind: 'query', run: templates},
			'containers.stats': {kind: 'query', run: stats},
			'containers.backups': {kind: 'query', run: (input) => backups(input ?? {})},
			'containers.files': {kind: 'query', run: listDir},
			'containers.create': {kind: 'mutation', run: create},
			'containers.start': {kind: 'mutation', run: power('start')},
			'containers.stop': {kind: 'mutation', run: power('stop')},
			'containers.restart': {kind: 'mutation', run: power('restart')},
			'containers.forceStop': {kind: 'mutation', run: power('forceStop')},
			'containers.delete': {kind: 'mutation', run: remove},
			'containers.snapshot': {kind: 'mutation', run: snapshot('create')},
			'containers.restoreSnapshot': {kind: 'mutation', run: snapshot('restore')},
			'containers.deleteSnapshot': {kind: 'mutation', run: snapshot('delete')},
			'containers.addPort': {kind: 'mutation', run: addPort},
			'containers.removePort': {kind: 'mutation', run: removePort},
			'containers.setResources': {kind: 'mutation', run: setResources},
			'containers.setOptions': {kind: 'mutation', run: setOptions},
			'containers.clone': {kind: 'mutation', run: clone},
			'containers.saveTemplate': {kind: 'mutation', run: saveTemplate},
			'containers.deleteTemplate': {kind: 'mutation', run: deleteTemplate},
			'containers.backup': {kind: 'mutation', run: backup},
			'containers.restoreBackup': {kind: 'mutation', run: restoreBackup},
			'containers.deleteBackup': {kind: 'mutation', run: deleteBackup},
			'containers.copyToServer': {kind: 'mutation', run: copyToServer},
			'containers.setRootPassword': {kind: 'mutation', run: setRootPassword},
			'containers.installConnector': {kind: 'mutation', run: installConnector},
			'containers.templateFiles': {kind: 'query', run: templateFiles},
			'containers.importTemplate': {kind: 'mutation', run: importTemplate},
			'containers.downloadTemplate': {kind: 'mutation', run: downloadTemplate},
			'containers.nixosConfig': {kind: 'query', run: nixosConfig},
			'containers.setNixosConfig': {kind: 'mutation', run: setNixosConfig},
			'containers.applyNixosConfig': {kind: 'mutation', run: applyNixosConfig},
		},
	}
}
