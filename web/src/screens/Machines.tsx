import {lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode} from 'react'
import {flushSync} from 'react-dom'

import {mutate, query, SERVER_DESKTOP, type Machine, type UserApp} from '../api'
import {queryProblem, useBrowserOnline} from '../connection'
import {useDesktop} from '../desktop/Desktop'
import {useBootstrap, useMachines, useUser} from '../data'
import {isOwner} from '../isOwner'
import {useMachineAction, useMachineDetails} from '../machines/api'
import {PortForwarding} from '../machines/PortForwarding'
import {VmView} from '../machines/pveDetail'
import {BackupsPanel, CloudInitPanel, HardwarePanel, HistoryPanel, MonitorPanel, OptionsPanel, PANELS, SnapshotsPanel, SummaryPanel, usePowerActions, type PanelId} from '../machines/panels'
import {DevicesPanel} from '../usb'
import {Icon} from '../icons'
import {osLook} from '../osLook'
import {hostedVms} from '../fleet/hostedVms'
import {computerFleetInput, containerFleetInput, fleetList, guestFleetInput, SERVER_FLEET_ID} from '../fleet/list'
import type {ManagerFilter} from '../fleet/machineManagerLogic'
import {OPEN_FLEET, takePendingFleet, type FleetOpen} from '../fleet/openMember'
import {openStore} from '../fleet/openStore'
import {GuestLive} from '../fleet/GuestLive'
import {MachineShell, MachineTabs, type MachineTab} from '../fleet/MachineTabs'
import {NixosConfigPanel} from '../nixos/NixosConfigPanel'
import {PinButton} from '../fleet/PinButton'
import {ServerSheet} from '../fleet/ServerSheet'
import {containerState, ContainerDetail, ContainerSheet, useContainers, useContainerStatus} from '../containers/Containers'
import {containerAgent, guestAgent, isContainerAgent, isGuestAgent} from '../swarm/guestLink'
import {LocalSwarm, useSwarm} from '../swarm/Swarm'
import {StoragePanel} from './Storage'
import {applyPrefsUpdate} from '../photoPrefs'
import {dismissTutorial, type TutorialId} from '../tutorials'
import {SheetHeader, StatusPill, Switch, haptic, machineStatus, type Prefs} from '../ui'
import {MachineManager} from '../fleet/MachineManager'
import {GuestClips} from '../clips/GuestClips'

const COMPACT_KEY = 'omarchy-server:machines-compact'
const LIST_WIDTH_KEY = 'omarchy-server:machines-list-width'
/** Name field plus All, Physical, Unhealthy, and Offline on one line. */
const LIST_WIDTH_MIN = 360
/** Starts at that floor. A wider choice is remembered. */
const LIST_WIDTH_DEFAULT = 360
const LIST_WIDTH_MAX = 640
const LIST_BAR_PX = 10
const DETAIL_MIN = 160

function clampListWidth(n: number, max = LIST_WIDTH_MAX) {
	const cap = Math.max(LIST_WIDTH_MIN, max)
	if (!Number.isFinite(n)) return Math.min(LIST_WIDTH_DEFAULT, cap)
	return Math.round(Math.min(Math.max(n, LIST_WIDTH_MIN), cap))
}

function readListWidth(): number {
	try {
		const raw = localStorage.getItem(LIST_WIDTH_KEY)
		if (raw == null || raw === '') return LIST_WIDTH_DEFAULT
		return clampListWidth(Number(raw))
	} catch {
		return LIST_WIDTH_DEFAULT
	}
}

function writeListWidth(n: number) {
	try {
		localStorage.setItem(LIST_WIDTH_KEY, String(n))
	} catch {
		/* private mode: the width lasts for this visit */
	}
}

function readCompact(): boolean {
	try {
		return localStorage.getItem(COMPACT_KEY) === '1'
	} catch {
		return false
	}
}

/** Swap the Machines window. The desktop shell stays still. */
function transitionMachines(apply: () => void) {
	const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
	const frames = document.querySelectorAll('.machines-frame')
	const root = document as Document & {startViewTransition?: (update: () => void) => {finished: Promise<void>}}
	if (reduce || frames.length !== 1 || !root.startViewTransition) {
		apply()
		return
	}
	const frame = frames[0]
	frame.classList.add('is-vt')
	document.documentElement.classList.add('machines-vt')
	const clear = () => {
		frame.classList.remove('is-vt')
		document.documentElement.classList.remove('machines-vt')
	}
	let transition: {finished: Promise<void>}
	try {
		transition = root.startViewTransition(() => {
			flushSync(apply)
		})
	} catch {
		clear()
		apply()
		return
	}
	transition.finished.finally(clear)
}

function MachinesSplit({list, detail, preferred, onPreferred}: {list: ReactNode; detail: ReactNode; preferred: number; onPreferred: (n: number, persist: boolean) => void}) {
	const ref = useRef<HTMLDivElement>(null)
	const [limit, setLimit] = useState(LIST_WIDTH_MAX)
	useEffect(() => {
		const el = ref.current
		if (!el) return
		const measure = () => {
			const room = el.getBoundingClientRect().width - LIST_BAR_PX - DETAIL_MIN
			setLimit(Math.max(LIST_WIDTH_MIN, Math.min(LIST_WIDTH_MAX, room)))
		}
		measure()
		const ro = new ResizeObserver(measure)
		ro.observe(el)
		return () => ro.disconnect()
	}, [])
	const width = clampListWidth(preferred, limit)
	const dragging = useRef(false)
	const widthFrom = (clientX: number) => {
		const split = ref.current
		if (!split) return width
		return clampListWidth(clientX - split.getBoundingClientRect().left, limit)
	}
	return (
		<div ref={ref} className="machines-split is-resizable" style={{gridTemplateColumns: `${width}px ${LIST_BAR_PX}px minmax(0, 1fr)`}}>
			<div className="machines-list">{list}</div>
			<div
				className="machines-split-bar"
				role="separator"
				aria-orientation="vertical"
				aria-valuenow={width}
				aria-valuemin={LIST_WIDTH_MIN}
				aria-valuemax={Math.round(limit)}
				aria-label="Machine list width"
				tabIndex={0}
				onPointerDown={(e) => {
					if (e.button !== 0) return
					e.preventDefault()
					dragging.current = true
					e.currentTarget.setPointerCapture(e.pointerId)
				}}
				onPointerMove={(e) => {
					if (!dragging.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return
					onPreferred(widthFrom(e.clientX), false)
				}}
				onPointerUp={(e) => {
					if (!dragging.current) return
					dragging.current = false
					onPreferred(widthFrom(e.clientX), true)
				}}
				onKeyDown={(e) => {
					const step = e.shiftKey ? 48 : 16
					let next: number | null = null
					if (e.key === 'ArrowLeft') next = width - step
					else if (e.key === 'ArrowRight') next = width + step
					else if (e.key === 'Home') next = LIST_WIDTH_MIN
					else if (e.key === 'End') next = limit
					if (next == null) return
					e.preventDefault()
					onPreferred(clampListWidth(next, limit), true)
				}}
			/>
			<div className="machines-detail">{detail}</div>
		</div>
	)
}

const Console = lazy(() => import('../Console').then((m) => ({default: m.Console})))
const CreateMachine = lazy(() => import('../CreateMachine').then((m) => ({default: m.CreateMachine})))
const TerminalScreen = lazy(() => import('../Terminal').then((m) => ({default: m.TerminalScreen})))

export function Machines({onOpenApp, onTerminal, windowId, prefs, setPrefs}: {onOpenApp?: (app: UserApp) => void; onTerminal?: () => void; windowId?: string; prefs?: Prefs; setPrefs?: (next: Prefs) => void} = {}) {
	const desk = useDesktop()
	const boot = useBootstrap()
	const machines = useMachines()
	const swarm = useSwarm()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(machines, browserOnline)
	const swarmProblem = queryProblem(swarm, browserOnline)
	const owner = isOwner(useUser().data)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [computerId, setComputerId] = useState<string | null>(null)
	const [containerId, setContainerId] = useState<string | null>(null)
	const [serverOpen, setServerOpen] = useState(false)
	const [consoleId, setConsoleId] = useState<string | null>(null)
	const [createHost, setCreateHost] = useState<{id: string; name: string} | null>(null)
	const [adding, setAdding] = useState(false)
	const [listPreferred, setListPreferred] = useState(readListWidth)
	const [pvePanel, setPvePanel] = useState<PanelId>('summary')
	const [queryText, setQueryText] = useState('')
	const [filter, setFilter] = useState<ManagerFilter>('all')
	const list = machines.data ?? []
	const containerStatus = useContainerStatus(true)
	const containersQ = useContainers(containerStatus.data?.available === true)
	const containerRows = containersQ.data ?? []
	const serverName = boot.server?.device || 'This server'
	const agents = swarm.data ?? []
	const members = useMemo(
		() =>
			fleetList({
				server: {name: serverName},
				computers: agents
					.filter((a) => !isGuestAgent(a) && !isContainerAgent(a))
					.map((a) => computerFleetInput({id: a.id, name: a.name, online: a.online, allowed: a.allowed, on: a.on, libvirt: a.libvirt === true})),
				guests: list.map((m) => guestFleetInput({id: m.id, name: m.name, state: m.state, hostId: m.hostId, connector: !!guestAgent(agents, m.id)})),
				containers: containerRows.map((c) =>
					containerFleetInput({
						id: c.name,
						name: c.name,
						state: containerState(c),
						hostId: c.hostId,
						hostName: c.hostId && c.hostId !== SERVER_FLEET_ID ? agents.find((a) => a.id === c.hostId)?.name : undefined,
						connector: !!containerAgent(agents, c.name),
					}),
				),
			}),
		[serverName, agents, list, containerRows],
	)
	const selected = list.find((m) => m.id === selectedId) ?? null
	const selectedContainer = containerRows.find((c) => c.name === containerId) ?? null
	const consoleAgent = consoleId?.startsWith('agent-') ? agents.find((a) => `agent-${a.id}` === consoleId) : undefined
	const consoleMachine =
		consoleId === 'desktop' ? SERVER_DESKTOP : consoleAgent ? {id: `agent-${consoleAgent.id}`, name: consoleAgent.name, state: 'running' as const} : (list.find((m) => m.id === consoleId) ?? null)
	const online = members.filter((m) => m.online).length
	useEffect(() => {
		const apply = (member: FleetOpen | null | undefined) => {
			if (!member) return
			setSelectedId(member.kind === 'guest' ? member.id : null)
			setComputerId(member.kind === 'computer' ? member.id : null)
			setContainerId(member.kind === 'container' ? member.id : null)
			setServerOpen(member.kind === 'server')
		}
		apply(takePendingFleet())
		const onOpen = (e: Event) => {
			takePendingFleet()
			apply((e as CustomEvent<FleetOpen>).detail)
		}
		window.addEventListener(OPEN_FLEET, onOpen)
		return () => window.removeEventListener(OPEN_FLEET, onOpen)
	}, [])
	const openMember = (kind: 'server' | 'computer' | 'guest' | 'container', id: string) => {
		setSelectedId(kind === 'guest' ? id : null)
		setComputerId(kind === 'computer' ? id : null)
		setContainerId(kind === 'container' ? id : null)
		setServerOpen(kind === 'server')
	}
	const onListWidth = (n: number, persist: boolean) => {
		setListPreferred(n)
		if (persist) writeListWidth(n)
	}
	const physicalHost = (hostId?: string) => {
		const id = hostId || SERVER_FLEET_ID
		if (id === SERVER_FLEET_ID) return {name: serverName, hostname: undefined as string | undefined}
		const agent = agents.find((a) => a.id === id)
		return {name: agent?.name || 'This computer', hostname: agent?.info?.hostname}
	}
	const openDesktop = () => {
		haptic(8)
		if (!desk) setServerOpen(false)
		if (desk) desk.openConsole('desktop')
		else setConsoleId('desktop')
	}
	// The machine page is a sheet on the phone and a pane in the Machines window on the desktop.
	// Leave it open and the terminal paints behind it. Close it, then open the terminal.
	const openServerTerminal = () => {
		setServerOpen(false)
		if (desk) {
			desk.openTerminal()
			if (windowId) desk.close(windowId)
			return
		}
		onTerminal?.()
	}
	const wide = desk != null
	// The account remembers Compact. A browser that stored it before that is copied up once, then the old key goes away.
	const compact = prefs?.machinesCompact == null ? readCompact() : prefs.machinesCompact
	useEffect(() => {
		if (!setPrefs) return
		if (prefs?.machinesCompact != null) {
			try {
				localStorage.removeItem(COMPACT_KEY)
			} catch {
				/* private mode */
			}
			return
		}
		if (!readCompact()) return
		applyPrefsUpdate(setPrefs, (current) => (current.machinesCompact != null ? current : {...current, machinesCompact: true}))
	}, [prefs?.machinesCompact, setPrefs])
	const showCompact = wide && compact
	const selectedKey = serverOpen
		? `server:${SERVER_FLEET_ID}`
		: computerId
			? `computer:${computerId}`
			: selectedContainer
				? `container:${selectedContainer.name}`
				: selected
					? `guest:${selected.id}`
					: null
	const setCompactMode = (on: boolean) => {
		if (!setPrefs) return
		transitionMachines(() => {
			applyPrefsUpdate(setPrefs, (current) => ({...current, machinesCompact: on}))
		})
	}
	const detail = (
		<>
			{selected && !consoleMachine && (
				<MachineSheet
					bare={wide}
					machine={selected}
					onClose={() => setSelectedId(null)}
					onConsole={() => {
						haptic(8)
						if (desk) desk.openConsole(selected.id)
						else setConsoleId(selected.id)
					}}
				/>
			)}
			{selectedContainer &&
				(wide ? (
					<ContainerDetail c={selectedContainer} all={containerRows} onBack={() => setContainerId(null)} onOpen={(name) => setContainerId(name)} />
				) : (
					<ContainerSheet c={selectedContainer} all={containerRows} onClose={() => setContainerId(null)} onOpen={(name) => setContainerId(name)} />
				))}
			<LocalSwarm
				bare={wide}
				hideList
				selectedId={computerId}
				onSelect={(id) => (id ? openMember('computer', id) : setComputerId(null))}
				adding={adding}
				onAdding={setAdding}
				vms={list}
				onCreateVm={setCreateHost}
				onOpenVm={(id) => openMember('guest', id)}
				onOpenApp={onOpenApp}
			/>
			{serverOpen && (
				<ServerSheet
					bare={wide}
					name={serverName}
					owner={owner}
					vms={hostedVms(list, SERVER_FLEET_ID)}
					onClose={() => setServerOpen(false)}
					onDesktop={openDesktop}
					onTerminal={openServerTerminal}
					onOpenVm={(id) => openMember('guest', id)}
					onCreateVm={() => setCreateHost({id: SERVER_FLEET_ID, name: serverName})}
					onOpenApp={onOpenApp}
				/>
			)}
		</>
	)
	const manager = (lines: boolean) => (
		<MachineManager
			owner={owner}
			serverTerminal={!!onTerminal}
			online={online}
			total={members.length}
			loading={machines.isLoading}
			problem={problem}
			swarmProblem={swarmProblem}
			members={members}
			machines={list}
			containers={containerRows}
			agents={agents}
			lines={lines}
			selectedKey={selectedKey}
			queryValue={wide ? queryText : undefined}
			onQueryText={wide ? setQueryText : undefined}
			filterValue={wide ? filter : undefined}
			onFilter={wide ? setFilter : undefined}
			onManage={openMember}
			onServerTerminal={openServerTerminal}
			onServerDesktop={openDesktop}
			onGuestDesktop={(id) => {
				haptic(8)
				if (desk) desk.openConsole(id)
				else setConsoleId(id)
			}}
			onAddComputer={() => setAdding(true)}
			onCreateVm={() => setCreateHost({id: SERVER_FLEET_ID, name: serverName})}
			dismissedTutorials={prefs?.dismissedTutorials}
			onDismissTutorial={(id: TutorialId) => {
				if (!setPrefs) return
				applyPrefsUpdate(setPrefs, (latest) => ({...latest, dismissedTutorials: dismissTutorial(latest.dismissedTutorials, id)}))
			}}
		/>
	)
	return (
		<div className={wide ? 'machines-frame' : 'stagger'}>
			{wide && (
				<div className={showCompact ? 'machines-compact-bar is-titled' : 'machines-compact-bar'}>
					{showCompact && <h1 className="title">Machines</h1>}
					<div className="machines-compact-switch">
						<span aria-hidden="true">Flat</span>
						<Switch on={compact} label="Flat" onChange={setCompactMode} />
					</div>
				</div>
			)}
			<div className="machines-body">
				{showCompact ? (
					<MachinesSplit
						preferred={listPreferred}
						onPreferred={onListWidth}
						list={manager(true)}
						detail={
							<>
								{computerId ? (
									<LocalSwarm
										hideList
										onlyId={computerId}
										selectedId={computerId}
										layout="nav"
										onSelect={(id) => {
											if (!id) setComputerId(null)
										}}
										bare
										adding={adding}
										onAdding={setAdding}
										vms={hostedVms(list, computerId)}
										onCreateVm={setCreateHost}
										onOpenVm={(id) => openMember('guest', id)}
										onOpenApp={onOpenApp}
									/>
								) : selected ? (
									<VmView
										key={selected.id}
										m={selected}
										physicalName={physicalHost(selected.hostId).name}
										hostname={selected.hostId && selected.hostId !== SERVER_FLEET_ID ? (physicalHost(selected.hostId).hostname ?? null) : undefined}
										panel={pvePanel}
										setPanel={setPvePanel}
										onGone={() => setSelectedId(null)}
										backLabel={`Back to ${physicalHost(selected.hostId).name}`}
										onBack={() => {
											const hostId = selected.hostId || SERVER_FLEET_ID
											if (hostId === SERVER_FLEET_ID) openMember('server', SERVER_FLEET_ID)
											else openMember('computer', hostId)
										}}
									/>
								) : selectedContainer ? (
									<ContainerDetail
										key={selectedContainer.name}
										c={selectedContainer}
										all={containerRows}
										onBack={() => openMember('server', SERVER_FLEET_ID)}
										onOpen={(name) => setContainerId(name)}
									/>
								) : (
									<ServerSheet
										layout="nav"
										bare
										name={serverName}
										owner={owner}
										vms={hostedVms(list, SERVER_FLEET_ID)}
										onClose={() => setServerOpen(false)}
										onDesktop={openDesktop}
										onTerminal={() => desk?.openTerminal()}
										onOpenVm={(id) => openMember('guest', id)}
										onCreateVm={() => setCreateHost({id: SERVER_FLEET_ID, name: serverName})}
										onOpenApp={onOpenApp}
									/>
								)}
								{adding && !computerId && (
									<LocalSwarm hideList bare adding={adding} onAdding={setAdding} selectedId={null} vms={list} onCreateVm={setCreateHost} onOpenVm={(id) => openMember('guest', id)} />
								)}
							</>
						}
					/>
				) : wide && (selected || computerId || selectedContainer || serverOpen) ? (
					<MachinesSplit preferred={listPreferred} onPreferred={onListWidth} list={manager(false)} detail={detail} />
				) : (
					<>
						{manager(false)}
						{detail}
					</>
				)}
			</div>
			{createHost && (
				<Suspense
					fallback={
						<main className="screen center">
							<span className="spinner" role="status" aria-label="Loading" />
						</main>
					}
				>
					<CreateMachine open host={createHost} onClose={() => setCreateHost(null)} />
				</Suspense>
			)}
			{consoleMachine && (
				<Suspense
					fallback={
						<main className="screen center">
							<span className="spinner" role="status" aria-label="Loading" />
						</main>
					}
				>
					<Console machine={consoleMachine} onClose={() => setConsoleId(null)} />
				</Suspense>
			)}
		</div>
	)
}

function MachineSheet({machine: m, onClose, onConsole, bare}: {machine: Machine; onClose: () => void; onConsole: () => void; bare?: boolean}) {
	const status = machineStatus(m.state)
	const details = useMachineDetails(m.id)
	const d = details.data
	const power = usePowerActions({id: m.id, name: m.name, state: m.state, protected: m.protected})!
	const machineAction = useMachineAction()
	const busy = status.kind === 'busy' || power.pending
	const os = osLook(m.osId)
	// A machine that isn't running opens on Power, where Start is.
	const [tab, setTab] = useState(m.state === 'running' ? 'files' : 'power')
	const [storage, setStorage] = useState<{agentId: string; name: string} | null>(null)
	const [guestTerm, setGuestTerm] = useState<{id: string; name: string; input?: string} | null>(null)
	const hostTabs = PANELS.filter((p) => p.id !== 'backups' && (p.id !== 'cloudinit' || d?.cloudInit))
	const panel = (id: PanelId) => {
		if (!d) return <div className="skeleton" style={{height: 160, borderRadius: 20}} />
		if (id === 'summary') return <SummaryPanel d={d} />
		if (id === 'hardware') return <HardwarePanel d={d} />
		if (id === 'cloudinit') return <CloudInitPanel d={d} />
		if (id === 'options') return <OptionsPanel d={d} />
		if (id === 'network') return <PortForwarding machine={m} />
		if (id === 'usb') return <DevicesPanel guest={{kind: 'machine', id: m.id, name: m.name}} />
		if (id === 'clips') return <GuestClips machine={m} />
		if (id === 'snapshots') return <SnapshotsPanel d={d} />
		if (id === 'history') return <HistoryPanel d={d} />
		return <MonitorPanel d={d} />
	}
	const powerBody = (
		<>
			<div className="actions mx-power">
				{m.state !== 'running' && (
					<button className="action" onClick={power.paused ? power.resume : power.start} disabled={busy || !(power.canStart || power.paused)}>
						{busy ? <span className="spinner" /> : <Icon name="play" size={22} />}
						{busy ? 'Working…' : m.state === 'hibernated' || power.paused ? 'Resume' : 'Start'}
					</button>
				)}
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
			<div className="stack" style={{marginTop: 18}}>
				<button className="btn danger block" onClick={() => power.remove(onClose)} disabled={busy}>
					<Icon name="trash" size={18} />
					Delete machine
				</button>
			</div>
		</>
	)

	if (guestTerm) {
		return (
			<Suspense fallback={<div className="skeleton" style={{height: 180, borderRadius: 16}} />}>
				<TerminalScreen agent={{id: guestTerm.id, name: guestTerm.name}} input={guestTerm.input} onClose={() => setGuestTerm(null)} />
			</Suspense>
		)
	}

	if (storage) return <StoragePanel bare={bare} target={storage} onClose={() => setStorage(null)} />

	return (
		<MachineShell bare={bare} label={m.name} onClose={onClose}>
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
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{/^\[[\w-]+\]$/.test(m.errorMessage) ? m.errorMessage.slice(1, -1).replace(/-/g, ' ') : m.errorMessage}
				</div>
			)}
			<GuestLive machine={m} pin={<PinButton pin={{kind: 'vm', id: m.id, computer: SERVER_FLEET_ID}} name={m.name} />} onOpenStore={() => (onClose(), openStore({id: m.id, kind: 'guest', name: m.name}))} onOpenDesktop={onConsole} onOpenStorage={setStorage} onBackups={() => setTab('backups')} onOpenTerminal={(agent, input) => setGuestTerm({id: agent.id, name: agent.name, input})} tabs={(sections) => {
				const rows: MachineTab[] = [
					...(sections.files ? [{id: 'files', label: 'Files', body: sections.files}] : []),
					...(sections.apps ? [{id: 'apps', label: 'Apps', body: sections.apps}] : []),
					...(sections.storage ? [{id: 'storage', label: 'Storage', body: sections.storage}] : []),
					...(sections.backups ? [{id: 'backups', label: 'Backups', body: d ? <BackupsPanel d={d} /> : sections.backups}] : []),
					{id: 'power', label: 'Power', body: powerBody},
					...(m.nixos
						? [
								{
									id: 'config',
									label: 'Config',
									body: (
										<NixosConfigPanel
											id={m.id}
											kind="vm"
											busy={busy || machineAction.isPending}
											running={m.state === 'running'}
											onApply={() =>
												machineAction.mutate({
													path: 'machines.applyNixosConfig',
													input: {id: m.id},
													done: 'Restarting so the guest picks up the configuration',
												})
											}
											readConfig={() => query<{config: string; present: boolean}>('machines.nixosConfig', {id: m.id})}
											saveConfig={(config) => mutate('machines.setNixosConfig', {id: m.id, config})}
										/>
									),
								},
							]
						: []),
					...(sections.manage ? [{id: 'manage', label: 'Manage', body: sections.manage}] : []),
					...hostTabs.map((p) => ({id: p.id, label: p.label, body: panel(p.id)})),
				]
				return <MachineTabs label={`${m.name} sections`} tabs={rows} tab={tab} onTab={setTab} />
			}} />
		</MachineShell>
	)
}
