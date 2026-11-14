// System facts, read straight from Linux: /proc, /sys and statfs. No root needed.
import {execFile} from 'node:child_process'
import {readFile, readdir, statfs} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'

const sh = (cmd, args, timeout = 10_000) =>
	new Promise((resolve) => execFile(cmd, args, {timeout, maxBuffer: 8 * 1024 * 1024}, (error, stdout) => resolve(error && !stdout ? '' : String(stdout))))

const read = (p) => readFile(p, 'utf8').catch(() => '')

// CPU use between two /proc/stat samples.
let lastCpu = null
async function cpuSample() {
	const line = (await read('/proc/stat')).split('\n')[0]
	const n = line.trim().split(/\s+/).slice(1).map(Number)
	const idle = (n[3] ?? 0) + (n[4] ?? 0)
	const total = n.reduce((a, b) => a + (b || 0), 0)
	return {idle, total}
}
export async function cpuUsage() {
	const now = await cpuSample()
	const prev = lastCpu ?? now
	lastCpu = now
	const dTotal = now.total - prev.total
	const used = dTotal > 0 ? (100 * (dTotal - (now.idle - prev.idle))) / dTotal : 0
	const pct = Math.round(Math.max(0, Math.min(100, used)) * 10) / 10
	return {threads: os.cpus().length, totalUsed: pct, system: pct, apps: [], machines: []}
}
// Prime the first sample so the first answer isn't 0.
void cpuUsage()

export async function memoryUsage() {
	const info = Object.fromEntries(
		(await read('/proc/meminfo'))
			.split('\n')
			.map((l) => /^(\w+):\s+(\d+)/.exec(l))
			.filter(Boolean)
			.map((m) => [m[1], Number(m[2]) * 1024]),
	)
	const size = info.MemTotal ?? os.totalmem()
	const used = size - (info.MemAvailable ?? os.freemem())
	return {size, totalUsed: used, system: used, apps: [], machines: []}
}

// What takes up the drive: apps, machines and your files are measured in the background (du can
// take a while on a big home folder) and refreshed every 10 minutes; "System" is the rest.
let breakdown = {at: 0, running: null, apps: 0, machines: 0, files: 0}
async function duBytes(paths, {unshare = false} = {}) {
	if (!paths.length) return 0
	const args = ['-n', '19', ...(unshare ? ['podman', 'unshare'] : []), 'du', '-s', '-B1', '--one-file-system', '-c', ...paths]
	const out = await sh('nice', args, 10 * 60_000)
	const total = out.trim().split('\n').pop()?.split('\t')[0]
	return Number(total) || 0
}
async function measure(home, dataDir) {
	const present = async (dir) => ((await readdir(dir).catch(() => null)) ? [dir] : [])
	// App containers' files belong to other user ids, so they're measured from inside podman's namespace.
	const containers = await present(join(home, '.local/share/containers/storage'))
	const appData = dataDir ? await present(join(dataDir, 'apps')) : []
	const apps = (containers.length ? (await duBytes(containers, {unshare: true})) || (await duBytes(containers)) : 0) + (await duBytes(appData, {unshare: true}).then((n) => n || duBytes(appData)))
	const machines = dataDir ? await duBytes(await present(join(dataDir, 'machines'))) : 0
	const visible = ((await readdir(home).catch(() => [])) ?? []).filter((n) => !n.startsWith('.')).map((n) => join(home, n))
	const files = await duBytes(visible)
	breakdown = {at: Date.now(), running: null, apps, machines, files}
}

// The drive the home folder lives on, and how much of it no partition uses yet (after a disk was
// made bigger, the partition and filesystem have to be grown before the space can be used).
let driveCache = {at: 0, value: null}
const MB = 1024 * 1024
async function driveOf(path, fsSize) {
	if (Date.now() - driveCache.at < 60_000) return driveCache.value
	let value = null
	try {
		const [source, fstype] = (await sh('findmnt', ['-n', '-o', 'SOURCE,FSTYPE', '-T', path])).trim().split(/\s+/)
		const dev = (source ?? '').replace(/\[.*\]$/, '')
		if (dev.startsWith('/dev/')) {
			// From the filesystem's device up to the physical (or virtual) disk.
			const chain = JSON.parse((await sh('lsblk', ['-J', '-b', '-s', '-o', 'NAME,PATH,SIZE,TYPE', dev])) || '{}').blockdevices?.[0]
			const layers = []
			for (let n = chain; n; n = n.children?.[0]) layers.push(n)
			const disk = layers.find((n) => n.type === 'disk')
			const part = layers.find((n) => n.type === 'part')
			const crypt = layers.find((n) => n.type === 'crypt')
			const fsDevice = layers[0]
			if (disk) {
				const tree = JSON.parse((await sh('lsblk', ['-J', '-b', '-o', 'NAME,PATH,SIZE,TYPE,START', disk.path])) || '{}').blockdevices?.[0]
				const parts = (tree?.children ?? []).filter((c) => c.type === 'part')
				const last = parts.reduce((a, c) => (Number(c.start ?? 0) > Number(a?.start ?? -1) ? c : a), null)
				// Each layer that hasn't caught up with the one below it after a disk was made bigger.
				const steps = []
				const partLag = parts.length ? Number(disk.size) - parts.reduce((t, c) => t + Number(c.size || 0), 0) : 0
				if (part && partLag > 256 * MB) steps.push(last?.name === part.name ? 'partition' : 'partition-not-last')
				if (crypt && part && Number(part.size) - Number(crypt.size) > 256 * MB) steps.push('encryption')
				if (fsSize && Number(fsDevice.size) - fsSize > Math.max(1024 * MB, Number(fsDevice.size) * 0.06)) steps.push('filesystem')
				if (crypt && part && partLag > 256 * MB && !steps.includes('encryption')) steps.push('encryption')
				if (part && partLag > 256 * MB && !steps.includes('filesystem')) steps.push('filesystem')
				const notInUse = steps.length ? Math.max(0, Number(disk.size) - fsSize) : 0
				const partNumber = part ? Number(/(\d+)$/.exec(part.name)?.[1]) : null
				value = {
					name: disk.path,
					size: Number(disk.size),
					notInUse,
					steps: [...new Set(steps)],
					partition: part?.path ?? null,
					partitionNumber: Number.isInteger(partNumber) ? partNumber : null,
					encrypted: crypt ? crypt.name : null,
					filesystem: fstype ?? null,
				}
			}
		}
	} catch {
		value = null
	}
	driveCache = {at: Date.now(), value}
	return value
}

export async function diskUsage(path, {dataDir} = {}) {
	const s = await statfs(path)
	const size = s.blocks * s.bsize
	const available = s.bavail * s.bsize
	const used = size - s.bfree * s.bsize
	if (!breakdown.running && Date.now() - breakdown.at > 10 * 60_000) breakdown.running = measure(path, dataDir).catch(() => (breakdown.running = null))
	const {apps, machines, files} = breakdown
	const measured = Math.min(used, apps + machines + files)
	return {
		size,
		totalUsed: used,
		available,
		system: used - measured,
		files: breakdown.at ? Math.min(files, used) : 0,
		apps: breakdown.at && apps ? [{id: 'apps', name: 'Apps', used: Math.min(apps, used)}] : [],
		machines: breakdown.at && machines ? [{id: 'machines', name: 'Machines', used: Math.min(machines, used)}] : [],
		measuring: !breakdown.at,
		drive: await driveOf(path, size),
	}
}

// Is this server a virtual machine? (They have no temperature sensors to read.)
let virtual = null
async function isVirtual() {
	if (virtual !== null) return virtual
	const v = (await sh('systemd-detect-virt', ['--vm'])).trim()
	if (v) virtual = v !== 'none'
	else virtual = /qemu|kvm|vmware|virtualbox|innotek|xen|microsoft|parallels|bochs/i.test(`${await read('/sys/class/dmi/id/sys_vendor')} ${await read('/sys/class/dmi/id/product_name')}`)
	return virtual
}

// The hottest CPU sensor we can find (coretemp, k10temp, zenpower or a thermal zone).
export async function cpuTemperature() {
	let best = null
	for (const hw of await readdir('/sys/class/hwmon').catch(() => [])) {
		const dir = `/sys/class/hwmon/${hw}`
		const name = (await read(`${dir}/name`)).trim()
		if (!/coretemp|k10temp|k8temp|zenpower|cpu|acpitz|soc|x86_pkg/.test(name)) continue
		// Older kernels keep the readings one folder down.
		for (const d of [dir, `${dir}/device`]) {
			for (const f of await readdir(d).catch(() => [])) {
				if (!/^temp\d+_input$/.test(f)) continue
				const t = Number(await read(`${d}/${f}`)) / 1000
				if (Number.isFinite(t) && t > 0 && t < 150 && (best === null || t > best)) best = t
			}
		}
	}
	if (best === null) {
		for (const z of await readdir('/sys/class/thermal').catch(() => [])) {
			if (!z.startsWith('thermal_zone')) continue
			const t = Number(await read(`/sys/class/thermal/${z}/temp`)) / 1000
			if (Number.isFinite(t) && t > 0 && t < 150 && (best === null || t > best)) best = t
		}
	}
	if (best === null) return {warning: 'normal', temperature: null, reason: (await isVirtual()) ? 'virtual' : 'no-sensor'}
	const temperature = Math.round(best)
	return {warning: temperature >= 90 ? 'hot' : temperature >= 80 ? 'warm' : 'normal', temperature}
}

export function ipAddresses() {
	const out = []
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		if (/^(lo|docker|br-|veth|virbr)/.test(name)) continue
		for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
	}
	return out
}

// A short, readable name for the machine: the DMI product name, else the hostname.
export async function deviceName() {
	const vendor = (await read('/sys/class/dmi/id/sys_vendor')).trim()
	const product = (await read('/sys/class/dmi/id/product_name')).trim()
	if (product && !/to be filled|system product name|default string/i.test(product)) {
		return /qemu|kvm|virtual|vmware/i.test(`${vendor} ${product}`) ? 'Virtual machine' : product
	}
	return os.hostname()
}

export async function osRelease() {
	const lines = Object.fromEntries(
		(await read('/etc/os-release'))
			.split('\n')
			.map((l) => /^(\w+)=["']?(.*?)["']?$/.exec(l))
			.filter(Boolean)
			.map((m) => [m[1], m[2]]),
	)
	return {id: lines.ID ?? 'linux', pretty: lines.PRETTY_NAME ?? 'Linux'}
}
