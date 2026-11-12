import {useMemo} from 'react'

import type {UserApp} from '../api'
import {useApps, useCpu, useDisk, useMemory, useRecent, useTemp, useUpdates, useUptime, useUser} from '../data'
import {Icon} from '../icons'
import {AppIcon, Ring, StoreIcon, TerminalIcon, appStatus, bytes, duration, greeting, haptic, isAppBusy, levelColor, pct, today} from '../ui'

export function Gauges({onClick}: {onClick?: () => void}) {
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const items = [
		{
			k: 'CPU',
			icon: 'cpu' as const,
			p: cpu.data?.totalUsed ?? 0,
			sub: cpu.data ? `${cpu.data.threads} threads` : '–',
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
			p: disk.data ? pct(disk.data.totalUsed, disk.data.size) : 0,
			sub: disk.data ? `${bytes(disk.data.available, 0)} free` : '–',
			ready: !!disk.data,
		},
	]
	return (
		<button className="glass gauges press" onClick={onClick} aria-label="System usage, open details">
			{items.map((g) => (
				<div className="gauge" key={g.k}>
					<Ring value={g.p} color={levelColor(g.p)} label={`${g.k} ${Math.round(g.p)}%`}>
						<span className="pct">
							{g.ready ? Math.round(g.p) : '–'}
							<small>%</small>
						</span>
					</Ring>
					<span className="k">{g.k}</span>
					<span className="sub">{g.sub}</span>
				</div>
			))}
		</button>
	)
}

export function Home({onOpenApp, go, onTerminal}: {onOpenApp: (app: UserApp) => void; go: (tab: 'apps' | 'more' | 'store') => void; onTerminal?: () => void}) {
	const user = useUser()
	const apps = useApps()
	const updates = useUpdates()
	const recent = useRecent()
	const temp = useTemp()
	const uptime = useUptime()
	const updateIds = useMemo(() => new Set((updates.data ?? []).map((u) => u.id)), [updates.data])
	const list = apps.data ?? []
	const byId = useMemo(() => new Map(list.map((a) => [a.id, a])), [list])
	const running = list.filter((a) => appStatus(a.state).kind === 'running').length
	const problems = list.filter((a) => a.error || a.state === 'unknown')
	const updating = (updates.data ?? []).map((u) => byId.get(u.id)).filter(Boolean) as UserApp[]
	const recentApps = (recent.data ?? []).map((id) => byId.get(id)).filter(Boolean).slice(0, 6) as UserApp[]

	const summary = apps.isLoading
		? 'Checking on your apps…'
		: problems.length
			? `${problems.length} app${problems.length > 1 ? 's need' : ' needs'} attention`
			: list.length
				? 'Everything is running smoothly.'
				: 'Your Umbrel is ready for its first app.'

	const open = (app: UserApp) => {
		haptic(6)
		onOpenApp(app)
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

			<div>
				<Gauges onClick={() => go('more')} />
				<div className="facts">
					{temp.data && (
						<span className="fact">
							<Icon name="thermo" size={15} />
							{Math.round(temp.data.temperature)}°C
						</span>
					)}
					<span className="fact">
						<Icon name="clock" size={15} />
						Up {duration(uptime.data)}
					</span>
					<span className="fact">
						<Icon name="apps" size={15} />
						{running}/{list.length} apps running
					</span>
				</div>
			</div>

			{updating.length > 0 && (
				<button className="glass callout press" onClick={() => go('apps')}>
					<span className="ico">
						<Icon name="update" size={22} />
					</span>
					<span className="txt">
						<b>
							{updating.length} update{updating.length > 1 ? 's' : ''} available
						</b>
						<span>{updating.map((a) => a.name).join(', ')}</span>
					</span>
					<span className="icons">
						{updating.slice(0, 3).map((a) => (
							<AppIcon key={a.id} src={a.icon} name={a.name} size={28} />
						))}
					</span>
					<Icon name="chevron" size={18} className="muted" />
				</button>
			)}

			{recentApps.length > 0 && (
				<section>
					<div className="section-head">
						<h2>Jump back in</h2>
					</div>
					<div className="recent">
						{recentApps.map((a) => (
							<button key={a.id} className="glass recent-card press" onClick={() => open(a)}>
								<AppIcon src={a.icon} name={a.name} size={40} />
								<span style={{minWidth: 0, flex: 1}}>
									<b className="rc-name">{a.name}</b>
									<span className="rc-open">
										Open <Icon name="arrow" size={13} stroke={2.2} />
									</span>
								</span>
							</button>
						))}
					</div>
				</section>
			)}

			<section>
				<div className="section-head">
					<h2>Apps</h2>
					<button className="link-btn" onClick={() => go('apps')}>
						Manage
					</button>
				</div>
				{apps.isLoading ? (
					<div className="app-grid">
						{Array.from({length: 8}, (_, i) => (
							<div key={i} style={{display: 'grid', justifyItems: 'center', gap: 8}}>
								<div className="skeleton" style={{width: 60, height: 60, borderRadius: 14}} />
								<div className="skeleton" style={{width: 48, height: 10}} />
							</div>
						))}
					</div>
				) : list.length === 0 ? (
					<div className="glass empty">
						<span className="big">
							<Icon name="store" size={30} />
						</span>
						<b>No apps yet</b>
						<span>Install your first app from the App Store.</span>
						<button className="btn primary small" onClick={() => go('store')}>
							Browse apps
						</button>
					</div>
				) : (
					<div className="app-grid">
						<button className="app-tile" onClick={() => go('store')} aria-label="App Store">
							<StoreIcon size={60} />
							<span className="name">App Store</span>
						</button>
						{onTerminal && (
							<button className="app-tile" onClick={() => onTerminal()} aria-label="Terminal">
								<TerminalIcon size={60} />
								<span className="name">Terminal</span>
							</button>
						)}
						{list.map((app) => {
							const s = appStatus(app.state, updateIds.has(app.id))
							const busy = isAppBusy(app.state)
							return (
								<button key={app.id} className="app-tile" onClick={() => open(app)} aria-label={`${app.name ?? app.id}, ${s.label}`}>
									<AppIcon
										src={app.icon}
										name={app.name ?? app.id}
										size={60}
										dim={app.state === 'stopped'}
										badge={s.kind === 'update' || s.kind === 'error' ? s.kind : undefined}
										progress={busy ? (app.progress ? app.progress : 'spin') : undefined}
									/>
									<span className="name">{app.name ?? app.id}</span>
								</button>
							)
						})}
					</div>
				)}
			</section>
		</div>
	)
}
