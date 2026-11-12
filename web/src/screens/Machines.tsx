import {useState} from 'react'

import type {Machine} from '../api'
import {Console} from '../Console'
import {useDesktop} from '../desktop/Desktop'
import {CreateMachine} from '../CreateMachine'
import {useAction, useMachines} from '../data'
import {Icon, type IconName} from '../icons'
import {KV, Sheet, SheetHeader, StatusPill, haptic, machineStatus, useConfirm} from '../ui'

export function osLook(osId = ''): {icon: IconName; bg: string; name: string} {
	const id = osId.toLowerCase()
	if (id.includes('ubuntu')) return {icon: 'ubuntu', bg: 'linear-gradient(140deg,#f2703c,#c7381d)', name: 'Ubuntu'}
	if (id.includes('debian')) return {icon: 'debian', bg: 'linear-gradient(140deg,#d70a53,#8a0636)', name: 'Debian'}
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
	const consoleMachine = list.find((m) => m.id === consoleId) ?? null
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
				<p className="subtitle">{machines.isLoading ? 'Loading…' : list.length ? `${running} of ${list.length} running` : 'Virtual machines on your Umbrel'}</p>
			</div>
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
								<span style={{display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 2}}>{m.ipAddress ?? os.name}</span>
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
					<span>Run Ubuntu, Debian, Windows and more right on your Umbrel.</span>
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
	const action = useAction()
	const confirm = useConfirm()
	const status = machineStatus(m.state)
	const busy = status.kind === 'busy' || action.isPending
	const os = osLook(m.osId)
	const run = (path: string, done: string) => {
		haptic(10)
		action.mutate({path, input: {id: m.id}, done})
	}
	const shutDown = async () => {
		if (await confirm({title: `Shut down ${m.name}?`, body: 'The machine is asked to shut down, like pressing its power button.', confirm: 'Shut down', icon: 'power'}))
			run('machines.stop', `${m.name} is shutting down`)
	}
	const remove = async () => {
		const ok = await confirm({
			title: `Delete ${m.name}?`,
			body: `${m.name} and its virtual disk will be permanently deleted. This can’t be undone.`,
			confirm: `Delete ${m.name}`,
			danger: true,
			icon: 'trash',
		})
		if (ok) {
			run('machines.uninstall', `${m.name} deleted`)
			onClose()
		}
	}
	const forceStop = async () => {
		const ok = await confirm({
			title: `Force stop ${m.name}?`,
			body: 'This cuts power to the machine immediately. Unsaved work inside it will be lost.',
			confirm: 'Force stop',
			danger: true,
		})
		if (ok) run('machines.forceStop', `${m.name} stopped`)
	}

	return (
		<Sheet open onClose={onClose} label={m.name}>
			<SheetHeader
				icon={
					<span className="vm-os" style={{width: 64, height: 64, borderRadius: 19, background: os.bg}}>
						<Icon name={os.icon} size={32} />
					</span>
				}
				title={m.name}
				subtitle={<StatusPill {...status} />}
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
					<button className="btn primary" onClick={() => run('machines.start', `${m.name} is starting`)} disabled={busy || m.state === 'installing'}>
						{busy ? <span className="spinner" /> : <Icon name="play" size={20} />}
						{busy ? 'Working…' : 'Start'}
					</button>
				)}
			</div>
			{m.state === 'running' && (
				<div className="actions" style={{gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'}}>
					<button className="action" onClick={() => run('machines.restart', `${m.name} is restarting`)} disabled={busy}>
						<Icon name="restart" size={22} />
						Restart
					</button>
					<button className="action" onClick={shutDown} disabled={busy}>
						<Icon name="power" size={22} />
						Shut down
					</button>
				</div>
			)}
			<KV
				rows={[
					['System', os.name],
					['CPU', m.cores ? `${m.cores} cores` : '–'],
					['Memory', m.memoryGb ? `${m.memoryGb} GB` : '–'],
					['Disk', m.diskSizeGb ? `${m.diskSizeGb} GB` : '–'],
					['IP address', m.ipAddress ?? '–'],
				]}
			/>
			<div className="stack">
				{m.state !== 'stopped' && (
					<button className="btn danger block" onClick={forceStop} disabled={action.isPending}>
						<Icon name="stop" size={18} />
						Force stop
					</button>
				)}
				<button className="btn danger block" onClick={remove} disabled={action.isPending}>
					<Icon name="trash" size={18} />
					Delete machine
				</button>
			</div>
		</Sheet>
	)
}
