import {useMemo, useState, type CSSProperties} from 'react'

import {diskAll, type UserApp} from '../api'
import {batteryColor, batteryGaugeItem, combineBatteries} from '../battery'
import {queryProblem, useBrowserOnline} from '../connection'
import {useApps, useBattery, useBootstrap, useCpu, useDisk, useGpus, useMachines, useMemory, useTemp, useUptime, useUser} from '../data'
import {computerSample, fleetRings, samplePercent, serverSample, type FleetRings, type GaugeKind} from '../fleet/aggregate'
import {containerState, useContainers, useContainerStatus} from '../containers/Containers'
import {computerFleetInput, containerFleetInput, fleetList, guestFleetInput, SERVER_FLEET_ID, type FleetMember} from '../fleet/list'
import {openFleetMember} from '../fleet/openMember'
import {usePins} from '../fleet/PinButton'
import {pinKey, type DashboardPin} from '../fleet/pins'
import {gpuGaugeItems} from '../gauges'
import {Icon, type IconName} from '../icons'
import {containerAgent, guestAgent, isContainerAgent, isGuestAgent} from '../swarm/guestLink'
import {useSwarm} from '../swarm/Swarm'
import {useStatView} from '../fleet/StatRegion'
import {formatTemp} from '../fleet/temperatures'
import {GaugeCluster, type GaugeModel} from '../fleet/serverGauges'
import {AppIcon, Ring, Row, Sheet, SheetHeader, appStatus, bytes, duration, greeting, haptic, levelColor, pct, today} from '../ui'

function percentSub(p: number, ready: boolean) {
	return ready ? `${Math.round(p)}%` : '–'
}

export function Gauges({onOpen, fleet}: {onOpen?: (gauge: {title: string; kind: GaugeKind; gpuId?: string}) => void; fleet?: FleetRings | null}) {
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const gpus = useGpus()
	const battery = useBattery()
	const space = disk.data ? diskAll(disk.data) : null
	const diskTotal = space?.total ?? 0
	const items: GaugeModel[] = fleet
		? [
				{k: 'CPU', icon: 'cpu', p: fleet.cpu.percent, sub: percentSub(fleet.cpu.percent, fleet.cpu.ready), ready: fleet.cpu.ready},
				{k: 'Memory', icon: 'memory', p: fleet.memory.percent, sub: fleet.memory.ready ? `${bytes(fleet.memory.used, 1, 1024)} of ${bytes(fleet.memory.total, 0, 1024)}` : '–', ready: fleet.memory.ready},
				{k: 'Storage', icon: 'disk', p: fleet.storage.percent, sub: fleet.storage.ready ? `${bytes(fleet.storage.used, 1)} of ${bytes(fleet.storage.total, 0)}` : '–', ready: fleet.storage.ready},
				...(fleet.gpu ? [{k: 'GPU', icon: 'gpu' as const, p: fleet.gpu.percent, sub: percentSub(fleet.gpu.percent, fleet.gpu.ready), ready: fleet.gpu.ready}] : []),
				...(fleet.battery
					? [{k: 'Battery', icon: 'battery' as const, p: fleet.battery.lowest.percent, sub: percentSub(fleet.battery.lowest.percent, true), ready: true, color: batteryColor(fleet.battery.lowest.percent), battery: fleet.battery}]
					: []),
			]
		: [
				{
					k: 'CPU',
					icon: 'cpu' as const,
					p: cpu.data?.totalUsed ?? 0,
					sub: percentSub(cpu.data?.totalUsed ?? 0, !!cpu.data),
					ready: !!cpu.data,
				},
				{
					k: 'Memory',
					icon: 'memory' as const,
					p: mem.data ? pct(mem.data.totalUsed, mem.data.size) : 0,
					sub: mem.data ? `${bytes(mem.data.totalUsed, 1, 1024)} of ${bytes(mem.data.size, 0, 1024)}` : '–',
					ready: !!mem.data,
				},
				{
					k: 'Storage',
					icon: 'disk' as const,
					p: space && space.total > 0 ? (100 * space.used) / space.total : 0,
					sub: space ? `${bytes(space.used, 1)} of ${bytes(diskTotal, 0)}` : '–',
					ready: !!disk.data,
				},
				...gpuGaugeItems(gpus.data?.gpus ?? []).map((g) => ({...g, sub: percentSub(g.p, g.ready)})),
				...batteryGaugeItem(battery.data?.batteries ?? []).map((g) => ({...g, sub: percentSub(g.p, g.ready)})),
			]
	return <GaugeCluster items={items} interactive onOpen={onOpen} />
}

function machineIcon(member: FleetMember): IconName {
	if (member.kind === 'guest') return 'machine'
	if (member.kind === 'container') return 'category'
	if (member.kind === 'server') return 'server'
	return 'devices'
}

export function Home({onOpenApp}: {onOpenApp: (app: UserApp) => void; go: (tab: 'apps' | 'more' | 'store') => void; onTerminal?: () => void; onAssistant?: () => void}) {
	const {tempUnit} = useStatView()
	const user = useUser()
	const apps = useApps()
	const boot = useBootstrap()
	const machines = useMachines()
	const swarm = useSwarm()
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const gpus = useGpus()
	const battery = useBattery()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(apps, browserOnline)
	const temp = useTemp()
	const uptime = useUptime()
	const {pins} = usePins()
	const [gauge, setGauge] = useState<{title: string; kind: GaugeKind; gpuId?: string} | null>(null)
	const swarmList = (swarm.data ?? []).filter((a) => !isGuestAgent(a) && !isContainerAgent(a))
	const containerStatus = useContainerStatus(true)
	const containersQ = useContainers(containerStatus.data?.available === true)
	const containerRows = containersQ.data ?? []
	const list = apps.data ?? []
	const running = list.filter((a) => appStatus(a.state).kind === 'running').length
	const problems = list.filter((a) => a.error || a.state === 'unknown')
	const serverName = boot.server?.device || 'This server'
	const samples = useMemo(
		() => [
			serverSample({
				name: serverName,
				cores: cpu.data?.threads ?? 0,
				cpu: cpu.data ? cpu.data.totalUsed : null,
				memUsed: mem.data?.totalUsed ?? null,
				memTotal: mem.data?.size ?? null,
				diskUsed: disk.data ? diskAll(disk.data).used : null,
				diskTotal: disk.data ? diskAll(disk.data).total : null,
				temp: temp.data?.temperature ?? null,
				gpus: (gpus.data?.gpus ?? []).map((g) => ({id: g.id, used: g.used})),
				battery: combineBatteries(battery.data?.batteries ?? [])?.percent ?? null,
			}),
			// Guests and system containers already show up inside this server's readings.
			...(swarm.data ?? []).filter((a) => !isGuestAgent(a) && !isContainerAgent(a)).map(computerSample),
		],
		[serverName, cpu.data, mem.data, disk.data, temp.data, gpus.data, battery.data, swarm.data],
	)
	const multi = samples.filter((s) => s.online).length >= 2
	const rings = multi ? fleetRings(samples) : null
	const members = useMemo(
		() =>
			fleetList({
				server: {name: serverName},
				computers: (swarm.data ?? [])
					.filter((a) => !isGuestAgent(a) && !isContainerAgent(a))
					.map((a) => computerFleetInput({id: a.id, name: a.name, online: a.online, allowed: a.allowed, on: a.on, libvirt: a.libvirt === true})),
				guests: (machines.data ?? []).map((m) => guestFleetInput({id: m.id, name: m.name, state: m.state, hostId: m.hostId, connector: !!guestAgent(swarm.data ?? [], m.id)})),
				containers: containerRows.map((c) =>
					containerFleetInput({
						id: c.name,
						name: c.name,
						state: containerState(c),
						hostId: c.hostId,
						hostName:
							c.hostId && c.hostId !== SERVER_FLEET_ID
								? (swarm.data ?? []).find((a) => a.id === c.hostId)?.name
								: undefined,
						connector: !!containerAgent(swarm.data ?? [], c.name),
					}),
				),
			}),
		[serverName, swarm.data, machines.data, containerRows],
	)
	const machinePins = pins.filter((p) => p.kind === 'machine' || p.kind === 'vm')
	const appPins = pins.filter((p) => p.kind === 'app')

	const summary = apps.isLoading
		? 'Checking on your apps…'
		: problem && !apps.data
			? 'Can’t reach your server right now.'
			: problems.length
				? `${problems.length} app${problems.length > 1 ? 's need' : ' needs'} attention`
				: list.length
					? 'Everything is running smoothly.'
					: 'Your server is ready for its first app.'

	const openPin = (pin: DashboardPin) => {
		haptic(6)
		if (pin.kind === 'app') {
			const app = list.find((a) => a.id === pin.id)
			if (app) onOpenApp(app)
			return
		}
		const member = members.find((m) => m.id === pin.id && (pin.kind === 'vm' ? m.kind === 'guest' : m.kind !== 'guest'))
		if (!member) return
		openFleetMember({kind: member.kind, id: member.id})
	}

	return (
		<div className="stagger">
			<header className="hero">
				<div className="eyebrow">{today()}</div>
				<h1>
					{greeting()}
					{user.data?.name ? `, ${user.data.name.split(' ')[0]}` : ''}
				</h1>
				<p>{summary}</p>
			</header>

			<div className="home-meters">
				<Gauges fleet={rings} onOpen={setGauge} />
				<div className="facts">
					{rings?.temp ? (
						<span className="fact">
							<Icon name="thermo" size={15} />
							{formatTemp(rings.temp.celsius, tempUnit)}
						</span>
					) : (
						temp.data?.temperature != null && (
							<span className="fact">
								<Icon name="thermo" size={15} />
								{formatTemp(temp.data.temperature, tempUnit)}
							</span>
						)
					)}
					<span className="fact">
						<Icon name="clock" size={15} />
						Up {duration(uptime.data)}
					</span>
					<span className="fact">
						<Icon name="apps" size={15} />
						{running}/{list.length} apps running
					</span>
					{swarmList.length > 0 && (
						<span className="fact">
							<Icon name="devices" size={15} />
							{swarmList.filter((a) => a.online).length}/{swarmList.length} swarm online
						</span>
					)}
				</div>
			</div>

			{machinePins.length === 0 && appPins.length === 0 ? (
				<div className="glass empty">
					<b>Nothing is pinned</b>
					<span>Pin a machine, a guest, or an app and it stays on this page.</span>
				</div>
			) : (
				<>
					{machinePins.length > 0 && (
						<section>
							<div className="section-head">
								<h2>Pinned machines</h2>
							</div>
							<div className="glass group">
								{machinePins.map((pin) => {
									const member = members.find((m) => m.id === pin.id)
									const host = member?.hostId ? (members.find((m) => m.id === member.hostId)?.name ?? serverName) : ''
									return (
										<button key={pinKey(pin)} type="button" className="row" onClick={() => openPin(pin)}>
											<span className="main">
												<b>{member?.name ?? pin.id}</b>
												<span>{pin.kind === 'vm' ? `Pinned virtual machine${host ? ` · ${host}` : ''}${member ? ` · ${member.online ? 'Online' : 'Offline'}` : ''}` : 'Pinned machine'}</span>
											</span>
											<span className="muted">Pinned</span>
										</button>
									)
								})}
							</div>
						</section>
					)}
					{appPins.length > 0 && (
						<section>
							<div className="section-head">
								<h2>Pinned applications</h2>
							</div>
							<div className="glass group" style={{'--inset': '74px'} as CSSProperties}>
								{appPins.map((pin) => {
									const app = list.find((a) => a.id === pin.id)
									const where = pin.computer === 'server' || pin.computer === '' ? serverName : (members.find((m) => m.id === pin.computer)?.name ?? pin.computer)
									return (
										<button key={pinKey(pin)} type="button" className="row" onClick={() => openPin(pin)}>
											<AppIcon src={app?.icon} name={app?.name ?? pin.id} size={46} />
											<span className="main">
												<b>{app?.name ?? pin.id}</b>
												<span>Pinned application · {where}</span>
											</span>
										</button>
									)
								})}
							</div>
						</section>
					)}
				</>
			)}
			{gauge && (
				<Sheet open onClose={() => setGauge(null)} label={gauge.title} tall>
					<SheetHeader title={gauge.title} onClose={() => setGauge(null)} />
					<div className="glass group gauge-machines" style={{marginTop: 12, '--inset': '62px'} as CSSProperties}>
						{members.map((member) => {
							const sample = samples.find((s) => s.id === member.id)
							const value = sample ? samplePercent(sample, gauge.kind, gauge.gpuId) : null
							const color = value == null ? 'var(--muted)' : gauge.kind === 'Battery' ? batteryColor(value) : levelColor(value)
							return (
								<Row
									key={member.id}
									icon={machineIcon(member)}
									label={member.name}
									sub={member.meta}
									trailing={
										<Ring value={value ?? 0} size={52} color={color} label={`${gauge.title} on ${member.name}`}>
											<span className="pct">
												{value == null ? '–' : Math.round(value)}
												{value != null && <small>%</small>}
											</span>
										</Ring>
									}
									onClick={() => {
										setGauge(null)
										openFleetMember({kind: member.kind, id: member.id})
									}}
								/>
							)
						})}
					</div>
				</Sheet>
			)}
		</div>
	)
}
