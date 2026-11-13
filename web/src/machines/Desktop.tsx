// The Machines window on the desktop, laid out like Proxmox VE: a resource tree on the left, the
// selected machine's toolbar and its settings panels, and the task log along the bottom.
import {useEffect, useRef, useState} from 'react'

import {SERVER_DESKTOP, type Machine} from '../api'
import {CreateMachine} from '../CreateMachine'
import {useMachines} from '../data'
import {useDesktop} from '../desktop/Desktop'
import {Icon, type IconName} from '../icons'
import {PortForwarding, osLook} from '../screens/Machines'
import {bytes, duration, haptic, useConfirm} from '../ui'
import {mib, useAllTasks, useBackups, useMachineAction, useMachineDetails, useNode, when} from './api'
import {
	BackupsPanel,
	CloudInitPanel,
	HardwarePanel,
	HistoryPanel,
	MonitorPanel,
	OptionsPanel,
	PANELS,
	SnapshotsPanel,
	SummaryPanel,
	TaskTable,
	usePowerActions,
	type PanelId,
} from './panels'

type Sel = {kind: 'node'} | {kind: 'vm'; id: string}

export function MachinesDesktop() {
	const machines = useMachines()
	const list = [...(machines.data ?? [])].sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0))
	const [sel, setSel] = useState<Sel>({kind: 'node'})
	const [panel, setPanel] = useState<PanelId>('summary')
	const [creating, setCreating] = useState(false)
	const [tasksOpen, setTasksOpen] = useState(true)
	const node = useNode()
	const selected = sel.kind === 'vm' ? (list.find((m) => m.id === sel.id) ?? null) : null
	useEffect(() => {
		if (sel.kind === 'vm' && machines.isSuccess && !selected) setSel({kind: 'node'})
	}, [sel, selected, machines.isSuccess])
	const host = node.data?.hostname ?? 'server'
	return (
		<div className="pve">
			<header className="pve-top">
				<span className="pve-brand">
					<Icon name="server" size={17} /> Server view
				</span>
				<span className="pve-spacer" />
				<button type="button" className="btn small primary" onClick={() => (haptic(6), setCreating(true))}>
					<Icon name="plus" size={15} /> Create VM
				</button>
			</header>
			<div className="pve-main">
				<aside className="pve-tree" aria-label="Machines">
					<div className="pve-tree-root">
						<Icon name="all" size={15} /> Datacenter
					</div>
					<button type="button" className={`pve-node${sel.kind === 'node' ? ' on' : ''}`} onClick={() => setSel({kind: 'node'})}>
						<Icon name="server" size={15} />
						<span>{host}</span>
					</button>
					{list.map((m) => (
						<button
							type="button"
							key={m.id}
							className={`pve-leaf${sel.kind === 'vm' && sel.id === m.id ? ' on' : ''}`}
							onClick={() => {
								setSel({kind: 'vm', id: m.id})
								if (panel === 'console' && m.state !== 'running') setPanel('summary')
							}}
						>
							<i className={`pve-dot st-${m.state}`} />
							<span className="mono">{m.vmid ?? '–'}</span>
							<span className="pve-leaf-name">{m.name}</span>
							{m.pending && <Icon name="info" size={13} className="pve-pending" />}
						</button>
					))}
					{machines.isLoading && <div className="pve-tree-note">Loading…</div>}
				</aside>
				<section className="pve-content">
					{sel.kind === 'node' || !selected ? (
						<NodeView onSelect={(id) => setSel({kind: 'vm', id})} onCreate={() => setCreating(true)} />
					) : (
						<VmView key={selected.id} m={selected} host={host} panel={panel} setPanel={setPanel} onGone={() => setSel({kind: 'node'})} />
					)}
				</section>
			</div>
			<footer className={`pve-tasks${tasksOpen ? '' : ' closed'}`}>
				<button type="button" className="pve-tasks-head" onClick={() => setTasksOpen(!tasksOpen)} aria-expanded={tasksOpen}>
					<Icon name="list" size={14} /> Tasks
					<Icon name="chevron-down" size={14} className={tasksOpen ? '' : 'flip'} />
				</button>
				{tasksOpen && <RecentTasks />}
			</footer>
			<CreateMachine open={creating} onClose={() => setCreating(false)} />
		</div>
	)
}

function RecentTasks() {
	const tasks = useAllTasks()
	return (
		<div className="pve-tasks-body">
			<TaskTable tasks={(tasks.data ?? []).slice(0, 30)} showMachine />
		</div>
	)
}

// ---- the server ("node") ----------------------------------------------------------------------
function NodeView({onSelect, onCreate}: {onSelect: (id: string) => void; onCreate: () => void}) {
	const node = useNode()
	const machines = useMachines()
	const backups = useBackups(null)
	const desk = useDesktop()
	const action = useMachineAction()
	const confirm = useConfirm()
	const n = node.data
	const memUsed = n ? n.memoryTotalMb - n.memoryFreeMb : 0
	return (
		<div className="pve-scroll">
			<div className="pve-head">
				<b>Node “{n?.hostname ?? '…'}”</b>
			</div>
			<div className="mx-panel">
				{n?.performanceWarning && (
					<div className="error">
						<Icon name="alert" size={18} />
						{n.performanceWarning}
					</div>
				)}
				<div className="mx-summary">
					<div className="mx-card">
						<h4>Status</h4>
						<dl>
							<dt>CPU</dt>
							<dd>{n ? `${n.threads} × ${n.cpuModel}` : '–'}</dd>
							<dt>Load average</dt>
							<dd>{n ? n.loadAverage.map((x) => x.toFixed(2)).join(', ') : '–'}</dd>
							<dt>Memory</dt>
							<dd>{n ? `${mib(memUsed)} of ${mib(n.memoryTotalMb)}` : '–'}</dd>
							<dt>Storage</dt>
							<dd>{n?.storage ? `${n.storage.totalGb - n.storage.freeGb} GB of ${n.storage.totalGb} GB (${n.storage.freeGb} GB free)` : '–'}</dd>
							<dt>Uptime</dt>
							<dd>{n ? duration(n.uptimeSeconds) : '–'}</dd>
							<dt>Virtualization</dt>
							<dd>{n ? `${n.kvmAvailable ? 'KVM' : 'Software only (slow)'} · libvirt ${n.libvirtVersion ?? '?'} · QEMU ${n.qemuVersion ?? '?'}` : '–'}</dd>
							<dt>Machines</dt>
							<dd>{n ? `${n.counts.running} of ${n.counts.total} running` : '–'}</dd>
						</dl>
					</div>
					<div className="mx-card">
						<h4>Consoles</h4>
						<button type="button" className="pve-desktop" onClick={() => (desk ? desk.openConsole('desktop') : null)}>
							<Icon name="terminal" size={20} />
							<span>
								<b>{SERVER_DESKTOP.name}</b>
								<small>This server’s own desktop, live.</small>
							</span>
						</button>
					</div>
				</div>
				<h4 className="mx-h">Virtual machines</h4>
				<div className="mx-table vms" role="table">
					<div className="mx-tr head" role="row">
						<span>ID</span>
						<span>Name</span>
						<span>Status</span>
						<span>CPU</span>
						<span>Memory</span>
						<span>Disk</span>
					</div>
					{(machines.data ?? []).length === 0 && (
						<div className="mx-tr empty">
							No machines yet.{' '}
							<button type="button" className="btn small" onClick={onCreate}>
								Create VM
							</button>
						</div>
					)}
					{[...(machines.data ?? [])]
						.sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0))
						.map((m) => (
							<button type="button" className="mx-tr click" role="row" key={m.id} onClick={() => onSelect(m.id)}>
								<span className="mono">{m.vmid}</span>
								<span className="b">{m.name}</span>
								<span className={`st-${m.state}`}>{m.state}</span>
								<span>{m.cores}</span>
								<span>{m.memoryMb ? mib(m.memoryMb) : `${m.memoryGb} GB`}</span>
								<span>{m.diskSizeGb} GB</span>
							</button>
						))}
				</div>
				<h4 className="mx-h">Backups</h4>
				<div className="mx-table" role="table">
					<div className="mx-tr head" role="row">
						<span>Date</span>
						<span>Machine</span>
						<span>Size</span>
						<span />
					</div>
					{backups.data?.length === 0 && <div className="mx-tr empty">No backups yet. Back up a machine from its Backup panel.</div>}
					{(backups.data ?? []).map((b) => (
						<div className="mx-tr" role="row" key={b.id}>
							<span>{when(b.createdAt)}</span>
							<span className="b">
								{b.vmid} ({b.name})
							</span>
							<span>{bytes(b.sizeBytes)}</span>
							<span className="mx-tr-actions">
								<button
									type="button"
									className="btn small"
									disabled={action.isPending}
									onClick={async () => {
										if (await confirm({title: 'Restore as a new machine?', body: `A new machine is made from this backup of ${b.name}.`, confirm: 'Restore', icon: 'restore'}))
											action.mutate({path: 'machines.restoreBackup', input: {backupId: b.id}, done: 'Restoring as a new machine'})
									}}
								>
									Restore
								</button>
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	)
}

// ---- one machine --------------------------------------------------------------------------------
function VmView({m, host, panel, setPanel, onGone}: {m: Machine; host: string; panel: PanelId; setPanel: (p: PanelId) => void; onGone: () => void}) {
	const details = useMachineDetails(m.id)
	const d = details.data
	const power = usePowerActions({id: m.id, name: m.name, state: m.state, protected: m.protected})!
	const desk = useDesktop()
	const [menu, setMenu] = useState<'shutdown' | 'more' | null>(null)
	const menuRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!menu) return
		const off = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(null)
		window.addEventListener('pointerdown', off)
		return () => window.removeEventListener('pointerdown', off)
	}, [menu])
	const os = osLook(m.osId)
	const busy = !['running', 'stopped', 'suspended', 'hibernated', 'error'].includes(m.state) || power.pending
	const item = (icon: IconName, label: string, onClick: () => void, disabled = false, danger = false) => (
		<button type="button" role="menuitem" className={danger ? 'danger' : ''} disabled={disabled} onClick={() => (setMenu(null), onClick())}>
			<Icon name={icon} size={15} /> {label}
		</button>
	)
	const panels = PANELS.filter((p) => p.id !== 'cloudinit' || d?.cloudInit)
	return (
		<div className="pve-vm">
			<div className="pve-head">
				<span className="pve-os" style={{background: os.bg}}>
					<Icon name={os.icon} size={15} />
				</span>
				<b>
					Virtual Machine {m.vmid} ({m.name}) on node “{host}”
				</b>
				<span className={`pve-state st-${m.state}`}>{m.state}</span>
				{m.state === 'installing' && m.installProgress !== undefined && <span className="muted">{m.installProgress}%</span>}
				<span className="pve-spacer" />
				<div className="pve-toolbar" ref={menuRef}>
					<button type="button" className="btn small" disabled={!power.canStart || busy} onClick={power.paused ? power.resume : power.start}>
						<Icon name="play" size={14} /> {m.state === 'hibernated' ? 'Resume' : 'Start'}
					</button>
					<span className="pve-split">
						<button type="button" className="btn small" disabled={!power.on || busy} onClick={power.shutdown}>
							<Icon name="power" size={14} /> Shutdown
						</button>
						<button type="button" className="btn small" aria-label="More power options" aria-haspopup="menu" disabled={!power.on || busy} onClick={() => setMenu(menu === 'shutdown' ? null : 'shutdown')}>
							<Icon name="chevron-down" size={13} />
						</button>
						{menu === 'shutdown' && (
							<div className="pve-menu" role="menu">
								{item('restart', 'Reboot', power.reboot, m.state !== 'running')}
								{item('stop', 'Stop', power.stop, false, true)}
								{power.paused ? item('play', 'Resume', power.resume) : item('pulse', 'Pause', power.pause, m.state !== 'running')}
								{item('download', 'Hibernate', power.hibernate, m.state !== 'running')}
							</div>
						)}
					</span>
					<button type="button" className="btn small" disabled={m.state !== 'running'} onClick={() => desk?.openConsole(m.id)}>
						<Icon name="terminal" size={14} /> Console
					</button>
					<span className="pve-split">
						<button type="button" className="btn small" aria-haspopup="menu" onClick={() => setMenu(menu === 'more' ? null : 'more')}>
							More <Icon name="chevron-down" size={13} />
						</button>
						{menu === 'more' && (
							<div className="pve-menu right" role="menu">
								{item('copy', 'Clone', power.clone, !power.canStart || m.state === 'error')}
								{item('save', 'Backup now', () => setPanel('backups'))}
								{item('trash', 'Remove', () => power.remove(onGone), busy, true)}
							</div>
						)}
					</span>
				</div>
			</div>
			<div className="pve-body">
				<nav className="pve-nav" aria-label={`${m.name} settings`}>
					{panels.map((p) => (
						<button type="button" key={p.id} className={panel === p.id ? 'on' : ''} aria-current={panel === p.id} onClick={() => setPanel(p.id)}>
							<Icon name={p.icon} size={15} />
							{p.label}
						</button>
					))}
				</nav>
				<div className="pve-panel">
					{!d ? (
						<div className="win-empty">{details.error ? (details.error as Error).message : <span className="spinner" />}</div>
					) : panel === 'summary' ? (
						<SummaryPanel d={d} />
					) : panel === 'console' ? (
						<div className="mx-panel">
							<div className="mx-empty">
								<Icon name="terminal" size={30} />
								<b>{m.state === 'running' ? `${m.name}’s screen` : `${m.name} isn’t running`}</b>
								<span>The console opens in its own window, so you can keep it beside these settings.</span>
								<button type="button" className="btn primary" disabled={m.state !== 'running'} onClick={() => desk?.openConsole(m.id)}>
									<Icon name="open" size={16} /> Open console
								</button>
							</div>
						</div>
					) : panel === 'hardware' ? (
						<HardwarePanel d={d} />
					) : panel === 'cloudinit' ? (
						<CloudInitPanel d={d} />
					) : panel === 'options' ? (
						<OptionsPanel d={d} />
					) : panel === 'network' ? (
						<div className="mx-panel">
							<PortForwarding machine={m} />
						</div>
					) : panel === 'snapshots' ? (
						<SnapshotsPanel d={d} />
					) : panel === 'backups' ? (
						<BackupsPanel d={d} />
					) : panel === 'history' ? (
						<HistoryPanel d={d} />
					) : (
						<MonitorPanel d={d} />
					)}
				</div>
			</div>
		</div>
	)
}
