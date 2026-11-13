import {useState} from 'react'

import {SERVER_DESKTOP, type Machine, type PortForward} from '../api'
import {Console} from '../Console'
import {useDesktop} from '../desktop/Desktop'
import {CreateMachine} from '../CreateMachine'
import {useAction, useMachines} from '../data'
import {useMachineDetails} from '../machines/api'
import {BackupsPanel, CloudInitPanel, HardwarePanel, HistoryPanel, MonitorPanel, OptionsPanel, PANELS, SnapshotsPanel, SummaryPanel, usePowerActions, type PanelId} from '../machines/panels'
import {Icon, type IconName} from '../icons'
import {Sheet, SheetHeader, StatusPill, haptic, machineStatus} from '../ui'

export function osLook(osId = ''): {icon: IconName; bg: string; name: string} {
	const id = osId.toLowerCase()
	if (id.includes('ubuntu')) return {icon: 'ubuntu', bg: 'linear-gradient(140deg,#f2703c,#c7381d)', name: 'Ubuntu'}
	if (id.includes('debian')) return {icon: 'debian', bg: 'linear-gradient(140deg,#d70a53,#8a0636)', name: 'Debian'}
	if (id.includes('omarchy')) return {icon: 'terminal', bg: 'linear-gradient(140deg,#2b2b2b,#0b0b0b)', name: 'Omarchy'}
	if (id.includes('fedora')) return {icon: 'server', bg: 'linear-gradient(140deg,#3c6eb4,#294172)', name: 'Fedora'}
	if (id.includes('alpine')) return {icon: 'server', bg: 'linear-gradient(140deg,#0d597f,#073449)', name: 'Alpine'}
	if (id.includes('arch')) return {icon: 'server', bg: 'linear-gradient(140deg,#1793d1,#0b5a85)', name: 'Arch Linux'}
	if (id.includes('win')) return {icon: 'windows', bg: 'linear-gradient(140deg,#2b9af3,#0058b0)', name: 'Windows'}
	if (id.includes('mac')) return {icon: 'macos', bg: 'linear-gradient(140deg,#8e8e93,#3a3a3c)', name: 'macOS'}
	return {icon: 'server', bg: 'linear-gradient(140deg, var(--accent), color-mix(in srgb, var(--accent) 45%, #000))', name: osId || 'Linux'}
}

export function Machines() {
	const desk = useDesktop()
	const machines = useMachines()
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [consoleId, setConsoleId] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const list = machines.data ?? []
	const selected = list.find((m) => m.id === selectedId) ?? null
	const consoleMachine = consoleId === 'desktop' ? SERVER_DESKTOP : (list.find((m) => m.id === consoleId) ?? null)
	const running = list.filter((m) => m.state === 'running').length

	return (
		<div className="stagger">
			<div style={{position: 'relative'}}>
				<button
					className="btn primary small"
					style={{position: 'absolute', right: 4, top: 14}}
					onClick={() => {
						haptic(6)
						setCreating(true)
					}}
				>
					<Icon name="plus" size={18} stroke={2.4} /> New
				</button>
				<h1 className="title">Machines</h1>
				<p className="subtitle">{machines.isLoading ? 'Loading…' : list.length ? `${running} of ${list.length} running` : 'Virtual machines on your server'}</p>
			</div>
			<button
				className="glass vm-card desktop-card"
				onClick={() => {
					haptic(8)
					if (desk) desk.openConsole('desktop')
					else setConsoleId('desktop')
				}}
			>
				<span className="vm-ico" style={{background: 'linear-gradient(140deg,#2b2b2b,#0b0b0b)', width: 52, height: 52, borderRadius: 15, display: 'grid', placeItems: 'center', color: '#fff'}}>
					<Icon name="terminal" size={26} />
				</span>
				<span className="main" style={{display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left', flex: 1, minWidth: 0}}>
					<b style={{fontSize: 17}}>Omarchy desktop</b>
					<span className="muted" style={{fontSize: 13}}>This server’s own desktop, live. Needs someone signed in to Omarchy on the server.</span>
				</span>
				<Icon name="chevron" size={18} className="chev" />
			</button>
			{machines.error && (
				<div className="error">
					<Icon name="alert" size={18} />
					{(machines.error as Error).message}
				</div>
			)}
			{machines.isLoading && Array.from({length: 2}, (_, i) => <div key={i} className="skeleton" style={{height: 130, borderRadius: 26, marginBottom: 12}} />)}
			{list.map((m) => {
				const os = osLook(m.osId)
				return (
					<button
						key={m.id}
						className="glass vm-card press"
						onClick={() => {
							haptic(6)
							setSelectedId(m.id)
						}}
					>
						<span className="top">
							<span className="vm-os" style={{background: os.bg, filter: m.state === 'running' ? undefined : 'saturate(.7) brightness(.9)'}}>
								<Icon name={os.icon} size={26} />
							</span>
							<span className="main" style={{flex: 1, minWidth: 0}}>
								<b style={{display: 'block', fontSize: 16.5, fontWeight: 650}}>{m.name}</b>
								<span style={{display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 2}}>
									{m.vmid !== undefined ? `${m.vmid} · ` : ''}
									{os.name}
									{m.pending ? ' · changes pending' : ''}
								</span>
							</span>
							<StatusPill {...machineStatus(m.state)} />
						</span>
						{m.state === 'installing' && m.installProgress !== undefined ? (
							<span className="progress" aria-label={`Installing ${m.installProgress}%`}>
								<i style={{width: `${m.installProgress}%`}} />
							</span>
						) : (
							<span className="specs">
								{m.cores ? (
									<span className="spec">
										<Icon name="cpu" size={14} /> {m.cores} cores
									</span>
								) : null}
								{m.memoryGb ? (
									<span className="spec">
										<Icon name="memory" size={14} /> {m.memoryGb} GB
									</span>
								) : null}
								{m.diskSizeGb ? (
									<span className="spec">
										<Icon name="disk" size={14} /> {m.diskSizeGb} GB
									</span>
								) : null}
							</span>
						)}
					</button>
				)
			})}
			{!machines.isLoading && !machines.error && list.length === 0 && (
				<div className="glass empty">
					<span className="big">
						<Icon name="machine" size={30} />
					</span>
					<b>No machines yet</b>
					<span>Run Ubuntu, Debian, Windows and more right on your server.</span>
					<button className="btn primary small" onClick={() => setCreating(true)}>
						Create a machine
					</button>
				</div>
			)}
			{selected && !consoleMachine && (
				<MachineSheet
					machine={selected}
					onClose={() => setSelectedId(null)}
					onConsole={() => {
						haptic(8)
						if (desk) {
							setSelectedId(null)
							desk.openConsole(selected.id)
						}						else setConsoleId(selected.id)
					}}
				/>
			)}
			<CreateMachine open={creating} onClose={() => setCreating(false)} />
			{consoleMachine && <Console machine={consoleMachine} onClose={() => setConsoleId(null)} />}
		</div>
	)
}

function MachineSheet({machine: m, onClose, onConsole}: {machine: Machine; onClose: () => void; onConsole: () => void}) {
	const status = machineStatus(m.state)
	const details = useMachineDetails(m.id)
	const d = details.data
	const power = usePowerActions({id: m.id, name: m.name, state: m.state, protected: m.protected})!
	const busy = status.kind === 'busy' || power.pending
	const os = osLook(m.osId)
	const [tab, setTab] = useState<PanelId>('summary')
	const tabs = PANELS.filter((p) => p.id !== 'console' && (p.id !== 'cloudinit' || d?.cloudInit))

	return (
		<Sheet open onClose={onClose} label={m.name} tall>
			<SheetHeader
				icon={
					<span className="vm-os" style={{width: 64, height: 64, borderRadius: 19, background: os.bg}}>
						<Icon name={os.icon} size={32} />
					</span>
				}
				title={m.name}
				subtitle={
					<span style={{display: 'inline-flex', gap: 8, alignItems: 'center'}}>
						<StatusPill {...status} />
						{m.vmid !== undefined && <span className="muted mono">ID {m.vmid}</span>}
					</span>
				}
				onClose={onClose}
			/>
			{m.errorMessage && (
				<div className="error">
					<Icon name="alert" size={18} />
					{m.errorMessage.replace(/^\[|\]$/g, '').replace(/-/g, ' ')}
				</div>
			)}
			<div className="primary-row">
				{m.state === 'running' ? (
					<button className="btn primary" onClick={onConsole}>
						<Icon name="machine" size={20} />
						Open console
					</button>
				) : (
					<button className="btn primary" onClick={power.paused ? power.resume : power.start} disabled={busy || !(power.canStart || power.paused)}>
						{busy ? <span className="spinner" /> : <Icon name="play" size={20} />}
						{busy ? 'Working…' : m.state === 'hibernated' || power.paused ? 'Resume' : 'Start'}
					</button>
				)}
			</div>
			<div className="actions mx-power">
				<button className="action" onClick={power.reboot} disabled={busy || m.state !== 'running'}>
					<Icon name="restart" size={22} />
					Reboot
				</button>
				<button className="action" onClick={power.shutdown} disabled={busy || !power.on}>
					<Icon name="power" size={22} />
					Shut down
				</button>
				<button className="action" onClick={power.paused ? power.resume : power.pause} disabled={busy || !power.on}>
					<Icon name={power.paused ? 'play' : 'pulse'} size={22} />
					{power.paused ? 'Resume' : 'Pause'}
				</button>
				<button className="action" onClick={power.hibernate} disabled={busy || m.state !== 'running'}>
					<Icon name="download" size={22} />
					Hibernate
				</button>
				<button className="action" onClick={power.stop} disabled={busy || !power.on}>
					<Icon name="stop" size={22} />
					Stop
				</button>
				<button className="action" onClick={power.clone} disabled={busy || !power.canStart || m.state === 'error'}>
					<Icon name="copy" size={22} />
					Clone
				</button>
			</div>
			<div className="mx-tabs" role="tablist" aria-label={`${m.name} settings`}>
				{tabs.map((p) => (
					<button key={p.id} role="tab" aria-selected={tab === p.id} className={`chip${tab === p.id ? ' on' : ''}`} onClick={(e) => (haptic(5), setTab(p.id), e.currentTarget.scrollIntoView({behavior: 'smooth', inline: 'center', block: 'nearest'}))}>
						<Icon name={p.icon} size={15} />
						{p.label}
					</button>
				))}
			</div>
			<div className="mx-touch">
				{!d ? (
					<div className="skeleton" style={{height: 160, borderRadius: 20}} />
				) : tab === 'summary' ? (
					<SummaryPanel d={d} />
				) : tab === 'hardware' ? (
					<HardwarePanel d={d} />
				) : tab === 'cloudinit' ? (
					<CloudInitPanel d={d} />
				) : tab === 'options' ? (
					<OptionsPanel d={d} />
				) : tab === 'network' ? (
					<PortForwarding machine={m} />
				) : tab === 'snapshots' ? (
					<SnapshotsPanel d={d} />
				) : tab === 'backups' ? (
					<BackupsPanel d={d} />
				) : tab === 'history' ? (
					<HistoryPanel d={d} />
				) : (
					<MonitorPanel d={d} />
				)}
			</div>
			<div className="stack" style={{marginTop: 18}}>
				<button className="btn danger block" onClick={() => power.remove(onClose)} disabled={busy}>
					<Icon name="trash" size={18} />
					Delete machine
				</button>
			</div>
		</Sheet>
	)
}

// ---- port forwarding ----------------------------------------------------------------------------
// A machine on the server's private network can't be reached from your phone or computer directly.
// A forward opens a port on the server (40000-49999, kept apart from apps) that leads into it.
const PORT_MIN = 40_000
const PORT_MAX = 49_999
const PRESETS = [
	{label: 'SSH', guestPort: 22, hostPort: 42222},
	{label: 'Web (80)', guestPort: 80, hostPort: 48080},
	{label: 'Web (443)', guestPort: 443, hostPort: 48443},
	{label: 'Remote desktop', guestPort: 3389, hostPort: 43389},
]
export function PortForwarding({machine: m}: {machine: Machine}) {
	const action = useAction()
	const forwards = m.portForwards ?? []
	const [adding, setAdding] = useState(false)
	const [hostPort, setHostPort] = useState('')
	const [guestPort, setGuestPort] = useState('')
	const [protocol, setProtocol] = useState<PortForward['protocol']>('tcp')
	if (m.networkMode === 'bridged') return null
	const taken = new Set(forwards.map((f) => `${f.protocol}:${f.hostPort}`))
	const freePort = (wanted: number) => {
		for (let p = wanted; p <= PORT_MAX; p++) if (!taken.has(`tcp:${p}`)) return p
		return PORT_MIN
	}
	const save = (next: PortForward[], done: string) => {
		haptic(8)
		action.mutate({path: 'machines.updateSettings', input: {id: m.id, portForwards: next}, done})
	}
	const host = typeof location !== 'undefined' ? location.hostname : 'your-backend'
	const h = Number(hostPort)
	const g = Number(guestPort)
	const valid = Number.isInteger(h) && h >= PORT_MIN && h <= PORT_MAX && Number.isInteger(g) && g >= 1 && g <= 65_535 && !taken.has(`${protocol}:${h}`)
	const add = (hp: number, gp: number, proto: PortForward['protocol'], label: string) => {
		const id = `fwd-${Date.now().toString(36)}`
		save([...forwards, {id, protocol: proto, hostPort: hp, guestPort: gp}], `${label}: ${host}:${hp} now leads to ${m.name}`)
		setAdding(false)
		setHostPort('')
		setGuestPort('')
	}
	return (
		<section className="pf">
			<h4 className="list-head">Port forwarding</h4>
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
							{f.protocol === 'tcp' && (
								<a className="btn small" href={`http://${host}:${f.hostPort}`} target="_blank" rel="noreferrer">
									Open
								</a>
							)}
							<button
								className="btn small"
								disabled={action.isPending}
								aria-label={`Remove forward ${f.hostPort}`}
								onClick={() => save(forwards.filter((x) => x.id !== f.id), `Removed port ${f.hostPort}`)}
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
					{hostPort && !(h >= PORT_MIN && h <= PORT_MAX) && <p className="muted pf-note">The server port must be between 40000 and 49999.</p>}
					<div className="pf-actions">
						<button className="btn small" onClick={() => setAdding(false)}>
							Cancel
						</button>
						<button className="btn small primary" disabled={!valid || action.isPending} onClick={() => add(h, g, protocol, 'Forward added')}>
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
