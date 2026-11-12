// System facts, read straight from Linux: /proc, /sys and statfs. No root needed.
import {readFile, readdir, statfs} from 'node:fs/promises'
import os from 'node:os'

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

export async function diskUsage(path) {
	const s = await statfs(path)
	const size = s.blocks * s.bsize
	const available = s.bavail * s.bsize
	const used = size - s.bfree * s.bsize
	return {size, totalUsed: used, available, system: used, files: 0, apps: [], machines: []}
}

// The hottest CPU sensor we can find (coretemp, k10temp, zenpower or a thermal zone).
export async function cpuTemperature() {
	let best = null
	for (const hw of await readdir('/sys/class/hwmon').catch(() => [])) {
		const name = (await read(`/sys/class/hwmon/${hw}/name`)).trim()
		if (!/coretemp|k10temp|zenpower|cpu|acpitz/.test(name)) continue
		for (const f of await readdir(`/sys/class/hwmon/${hw}`).catch(() => [])) {
			if (!/^temp\d+_input$/.test(f)) continue
			const t = Number(await read(`/sys/class/hwmon/${hw}/${f}`)) / 1000
			if (Number.isFinite(t) && t > 0 && (best === null || t > best)) best = t
		}
	}
	if (best === null) {
		for (const z of await readdir('/sys/class/thermal').catch(() => [])) {
			if (!z.startsWith('thermal_zone')) continue
			const t = Number(await read(`/sys/class/thermal/${z}/temp`)) / 1000
			if (Number.isFinite(t) && t > 0 && (best === null || t > best)) best = t
		}
	}
	if (best === null) return {warning: 'normal', temperature: null}
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
