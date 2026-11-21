import type {Machine, PortForward} from '../api'

export const PORT_MIN = 40_000
export const PORT_MAX = 49_999

export function takenPorts(machines: readonly Pick<Machine, 'id' | 'portForwards'>[], current: Pick<Machine, 'id' | 'portForwards'>): Set<string> {
	const out = new Set<string>()
	let sawCurrent = false
	for (const x of machines) {
		if (x.id === current.id) sawCurrent = true
		for (const f of x.portForwards ?? []) out.add(`${f.protocol}:${f.hostPort}`)
	}
	if (!sawCurrent) {
		for (const f of current.portForwards ?? []) out.add(`${f.protocol}:${f.hostPort}`)
	}
	return out
}

export function nextFreePort(wanted: number, taken: ReadonlySet<string>, protocol: PortForward['protocol'] = 'tcp'): number {
	const start = Math.min(PORT_MAX, Math.max(PORT_MIN, wanted))
	for (let p = start; p <= PORT_MAX; p++) if (!taken.has(`${protocol}:${p}`)) return p
	for (let p = PORT_MIN; p < start; p++) if (!taken.has(`${protocol}:${p}`)) return p
	return PORT_MIN
}

export function forwardAddMessage(machineName: string, host: string, hostPort: number, running: boolean): string {
	return running
		? `Forward added — ${host}:${hostPort} applies the next time ${machineName} starts`
		: `Forward added: ${host}:${hostPort} leads to ${machineName} when it starts`
}

export function forwardRemoveMessage(machineName: string, hostPort: number, running: boolean): string {
	return running ? `Removed port ${hostPort} — applies the next time ${machineName} starts` : `Removed port ${hostPort}`
}
