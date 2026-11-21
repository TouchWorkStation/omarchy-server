// A machine on the server's private network can't be reached from your phone or computer directly.
// A forward opens a port on the server (40000-49999, kept apart from apps) that leads into it.
import {useState} from 'react'

import {type Machine, type PortForward} from '../api'
import {useMachines} from '../data'
import {Icon} from '../icons'
import {haptic} from '../ui'
import {useMachineAction} from './api'
import {PendingBanner} from './panels'
import {PORT_MAX, PORT_MIN, forwardAddMessage, forwardRemoveMessage, nextFreePort, takenPorts} from './portForwardingState'

const PRESETS = [
	{label: 'SSH', guestPort: 22, hostPort: 42222},
	{label: 'Web (80)', guestPort: 80, hostPort: 48080},
	{label: 'Web (443)', guestPort: 443, hostPort: 48443},
	{label: 'Remote desktop', guestPort: 3389, hostPort: 43389},
]
export function PortForwarding({machine: m}: {machine: Machine}) {
	const action = useMachineAction()
	const allMachines = useMachines().data ?? []
	const forwards = m.portForwards ?? []
	const [adding, setAdding] = useState(false)
	const [hostPort, setHostPort] = useState('')
	const [guestPort, setGuestPort] = useState('')
	const [protocol, setProtocol] = useState<PortForward['protocol']>('tcp')
	if (m.networkMode === 'bridged') return null
	const taken = takenPorts(allMachines, m)
	const freePort = (wanted: number) => nextFreePort(wanted, taken, 'tcp')
	const save = (next: PortForward[], done: string, onSuccess?: () => void) => {
		haptic(8)
		action.mutate({path: 'machines.updateSettings', input: {id: m.id, portForwards: next}, done}, onSuccess ? {onSuccess} : undefined)
	}
	const host = typeof location !== 'undefined' ? location.hostname : 'your-backend'
	const h = Number(hostPort)
	const g = Number(guestPort)
	const inRange = Number.isInteger(h) && h >= PORT_MIN && h <= PORT_MAX
	const portTaken = inRange && taken.has(`${protocol}:${h}`)
	const valid = inRange && Number.isInteger(g) && g >= 1 && g <= 65_535 && !portTaken
	const isLive = m.state === 'running' || m.state === 'suspended'
	const add = (hp: number, gp: number, proto: PortForward['protocol']) => {
		const id = `fwd-${Date.now().toString(36)}`
		save([...forwards, {id, protocol: proto, hostPort: hp, guestPort: gp}], forwardAddMessage(m.name, host, hp, isLive), () => {
			setAdding(false)
			setHostPort('')
			setGuestPort('')
		})
	}
	return (
		<section className="pf">
			<h4 className="list-head">Port forwarding</h4>
			<PendingBanner d={m} />
			<p className="muted pf-note">
				{m.name} is on the server’s private network{m.ipAddress ? ` (${m.ipAddress})` : ''}. Forward a port to reach a service inside it from your other devices.
			</p>
			{forwards.length > 0 && (
				<div className="glass group">
					{forwards.map((f) => (
						<div key={f.id} className="row static">
							<span className="main">
								<b className="mono">
									{f.hostPort} → {f.guestPort}
								</b>
								<span className="mono">
									{host}:{f.hostPort} · {f.protocol.toUpperCase()}
								</span>
							</span>
							{f.protocol === 'tcp' &&
								(f.pending ? (
									<button type="button" className="btn small" disabled title="Applies the next time the machine starts">
										After restart
									</button>
								) : (
									<a className="btn small" href={`http://${host}:${f.hostPort}`} target="_blank" rel="noreferrer">
										Open
									</a>
								))}
							<button
								className="btn small"
								disabled={action.isPending}
								aria-label={`Remove forward ${f.hostPort}`}
								onClick={() => save(forwards.filter((x) => x.id !== f.id), forwardRemoveMessage(m.name, f.hostPort, isLive))}
							>
								Remove
							</button>
						</div>
					))}
				</div>
			)}
			{adding ? (
				<div className="pf-add glass">
					<div className="pf-presets">
						{PRESETS.filter((p) => !forwards.some((f) => f.guestPort === p.guestPort)).map((p) => (
							<button
								key={p.label}
								className="btn small"
								onClick={() => {
									setGuestPort(String(p.guestPort))
									setHostPort(String(freePort(p.hostPort)))
									setProtocol('tcp')
								}}
							>
								{p.label}
							</button>
						))}
					</div>
					<div className="pf-fields">
						<label>
							<span>server port</span>
							<input className="field" inputMode="numeric" placeholder="42222" value={hostPort} onChange={(e) => setHostPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
						</label>
						<span className="pf-arrow" aria-hidden="true">→</span>
						<label>
							<span>Machine port</span>
							<input className="field" inputMode="numeric" placeholder="7780" value={guestPort} onChange={(e) => setGuestPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
						</label>
						<label>
							<span>Type</span>
							<select className="field" value={protocol} onChange={(e) => setProtocol(e.target.value as PortForward['protocol'])}>
								<option value="tcp">TCP</option>
								<option value="udp">UDP</option>
							</select>
						</label>
					</div>
					{hostPort && !inRange && <p className="muted pf-note">The server port must be between 40000 and 49999.</p>}
					{portTaken && <p className="muted pf-note">Port {h} is already forwarded.</p>}
					<div className="pf-actions">
						<button className="btn small" onClick={() => setAdding(false)}>
							Cancel
						</button>
						<button className="btn small primary" disabled={!valid || action.isPending} onClick={() => add(h, g, protocol)}>
							Add forward
						</button>
					</div>
				</div>
			) : (
				<button className="btn block" onClick={() => setAdding(true)} disabled={action.isPending}>
					<Icon name="plus" size={18} />
					Forward a port
				</button>
			)}
		</section>
	)
}
