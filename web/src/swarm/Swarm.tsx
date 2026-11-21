// Local swarm: other Linux computers that joined this server with the connector (connector/agent.py).
// Watch them, open a terminal or their desktop, and manage them (Omarchy plugins and themes, updates,
// restart), each only as far as that computer allowed when it joined.
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {lazy, memo, Suspense, useEffect, useMemo, useState, type CSSProperties, type ReactNode} from 'react'

import {mutate, query} from '../api'
import {queryProblem, useBrowserOnline} from '../connection'
import {Icon, type IconName} from '../icons'
import {osLook} from '../osLook'
import {extraDisks, swarmGaugeItems, type SwarmBattery} from './gauges'
import {newlyJoined} from './join'
import {sameThemePicker} from './themePicker'
import {storageRowSub} from './storageHint'
import {StoragePage} from '../screens/Storage'
import {Ring, Row, Sheet, SheetHeader, StatChip, StatusPill, Switch, bytes, duration, haptic, levelColor, useConfirm, useToast} from '../ui'

const Console = lazy(() => import('../Console').then((m) => ({default: m.Console})))
const TerminalScreen = lazy(() => import('../Terminal').then((m) => ({default: m.TerminalScreen})))

type Abilities = {terminal: boolean; desktop: boolean; manage: boolean; storage: boolean; backup: boolean}
type Ability = keyof Abilities
export type Agent = {
	id: string
	name: string
	online: boolean
	lastSeen: number | null
	enrolledAt: number
	allowed: Abilities
	on: Abilities
	info: {
		hostname?: string
		os?: string
		osId?: string
		kernel?: string
		arch?: string
		user?: string
		version?: string
		pkg?: string
		updateCommand?: string
		omarchy?: boolean
		plugins?: string[]
		themes?: string[]
		theme?: string
		desktop?: {kind: string; ok: boolean; why: string}
	} | null
	metrics: {
		cpu: number | null
		cores?: number
		load?: number[]
		mem?: {total: number; used: number}
		swap?: {total: number; used: number}
		disks?: {mount: string; total: number; used: number}[]
		gpus?: {id: string; index: number; name: string; used: number | null}[]
		batteries?: SwarmBattery[]
		temp?: number | null
		uptime?: number
		updates?: number | null
	} | null
}
type Pairing = {token: string; ca: string; expiresAt: number; abilities: Abilities; source: string; port: number; addresses: {address: string; tailscale: boolean}[]}

const ABILITY: Record<Ability, {label: string; icon: IconName; what: string}> = {
	terminal: {label: 'Terminal', icon: 'terminal', what: 'A shell on it, as the person who installed the connector'},
	desktop: {label: 'Desktop', icon: 'devices', what: 'See and use its screen (Hyprland, Sway or an X11 desktop)'},
	manage: {label: 'Manage', icon: 'settings', what: 'Omarchy plugins (verified only) and themes, updates, restart'},
	storage: {label: 'Storage', icon: 'disk', what: 'See its drives, format extra disks, and manage pools on that computer'},
	backup: {label: 'Backups', icon: 'history', what: 'Back up folders you choose to this server, on a schedule (Settings › Backups). It can add backups, never delete them.'},
}
const may = (a: Agent, k: Ability) => a.allowed[k] && a.on[k]
const pct = (u?: {total: number; used: number}) => (u && u.total ? Math.round((100 * u.used) / u.total) : null)
const rootDisk = (a: Agent) => a.metrics?.disks?.find((d) => d.mount === '/') ?? a.metrics?.disks?.[0]
const look = (a: Agent) => osLook(a.info?.omarchy ? 'omarchy' : (a.info?.osId ?? ''))
const ago = (t: number | null) => (!t ? 'never' : Date.now() - t < 60_000 ? 'just now' : `${duration((Date.now() - t) / 1000)} ago`)

export const useSwarm = () => useQuery({queryKey: ['swarm.list'], queryFn: () => query<Agent[]>('swarm.list'), refetchInterval: 3000})

function useSwarmAction() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: (a: {path: string; input: unknown; done?: string}) => mutate(a.path, a.input).then(() => a.done),
		onSuccess: (done) => (done && toast(done), qc.invalidateQueries({queryKey: ['swarm.list']})),
		onError: (e) => toast((e as Error).message, true),
	})
}

// The section in Machines (phone) and the Local swarm view in the desktop's Machines window.
export function LocalSwarm({heading = true}: {heading?: boolean}) {
	const swarm = useSwarm()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(swarm, browserOnline)
	const list = swarm.data ?? []
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [adding, setAdding] = useState(false)
	const [terminal, setTerminal] = useState<{agent: Agent; input?: string} | null>(null)
	const [screen, setScreen] = useState<Agent | null>(null)
	const [storage, setStorage] = useState<Agent | null>(null)
	const selected = list.find((a) => a.id === selectedId) ?? null
	const online = list.filter((a) => a.online).length
	if (storage) return <StoragePage onBack={() => setStorage(null)} target={{agentId: storage.id, name: storage.name}} />
	return (
		<section className="swarm">
			{heading && (
				<div className="section-head">
					<h2>Local swarm</h2>
					<button className="btn small" onClick={() => (haptic(6), setAdding(true))}>
						<Icon name="plus" size={16} stroke={2.4} /> Add a computer
					</button>
				</div>
			)}
			{!heading && (
				<div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12}}>
					<span className="muted" style={{flex: 1}}>
						{list.length ? `${online} of ${list.length} online` : 'Other Linux computers joined to this server'}
					</span>
					<button className="btn small primary" onClick={() => setAdding(true)}>
						<Icon name="plus" size={15} /> Add a computer
					</button>
				</div>
			)}
			{problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{problem}
				</div>
			)}
			{list.map((a) => (
				<AgentCard key={a.id} a={a} onClick={() => (haptic(6), setSelectedId(a.id))} />
			))}
			{!problem && swarm.isSuccess && list.length === 0 && (
				<div className="glass empty">
					<span className="big">
						<Icon name="devices" size={30} />
					</span>
					<b>No computers yet</b>
					<span>Join your other Linux computers (Omarchy, Ubuntu, Debian, Fedora, Arch, openSUSE…) to watch them, open a terminal or their desktop, and manage them from here.</span>
					<button className="btn primary small" onClick={() => setAdding(true)}>
						Add a computer
					</button>
				</div>
			)}
			{selected && !terminal && !screen && (
				<AgentSheet
					a={selected}
					onClose={() => setSelectedId(null)}
					onTerminal={(input) => setTerminal({agent: selected, input})}
					onDesktop={() => setScreen(selected)}
					onStorage={() => setStorage(selected)}
				/>
			)}
			{adding && <AddComputer before={list.map((a) => a.id)} onClose={() => setAdding(false)} onJoined={(id) => (setAdding(false), setSelectedId(id))} />}
			{terminal && (
				<Suspense
					fallback={
						<main className="screen center">
							<span className="spinner" aria-label="Loading" />
						</main>
					}
				>
					<TerminalScreen agent={{id: terminal.agent.id, name: terminal.agent.name}} input={terminal.input} onClose={() => setTerminal(null)} />
				</Suspense>
			)}
			{screen && (
				<Suspense
					fallback={
						<main className="screen center">
							<span className="spinner" aria-label="Loading" />
						</main>
					}
				>
					<Console machine={{id: `agent-${screen.id}`, name: screen.name, state: 'running'}} onClose={() => setScreen(null)} />
				</Suspense>
			)}
		</section>
	)
}

function Meter({icon, label, value}: {icon: IconName; label: string; value: number | null}) {
	if (value === null) return null
	return (
		<StatChip icon={icon} label={label}>
			{value}%
		</StatChip>
	)
}

function SwarmGauges({metrics}: {metrics: NonNullable<Agent['metrics']>}) {
	const items = swarmGaugeItems(metrics)
	if (!items.length) return null
	return (
		<div className="glass gauges" data-n={items.length} aria-label="System usage" style={{marginTop: 16}}>
			{items.map((g) => (
				<div className="gauge" key={'key' in g ? g.key : g.k}>
					<Ring value={g.p} color={'color' in g ? g.color : levelColor(g.p)} label={`${g.k} ${Math.round(g.p)}%`}>
						<span className="pct">
							{g.ready ? Math.round(g.p) : '–'}
							<small>%</small>
						</span>
					</Ring>
					<span className="k">{g.k}</span>
					<span className="sub">{g.sub}</span>
				</div>
			))}
		</div>
	)
}

function AgentCard({a, onClick}: {a: Agent; onClick: () => void}) {
	const os = look(a)
	const m = a.metrics
	return (
		<button className="glass vm-card press" onClick={onClick}>
			<span className="top">
				<span className="vm-os" style={{background: os.bg, filter: a.online ? undefined : 'grayscale(.7) brightness(.85)'}}>
					<Icon name={os.icon} size={26} />
				</span>
				<span className="main" style={{flex: 1, minWidth: 0}}>
					<b style={{display: 'block', fontSize: 16.5, fontWeight: 650}}>{a.name}</b>
					<span style={{display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 2}}>
						{a.info?.os ?? 'Linux'}
						{a.online ? '' : ` · seen ${ago(a.lastSeen)}`}
					</span>
				</span>
				<StatusPill kind={a.online ? 'running' : 'stopped'} label={a.online ? 'Online' : 'Offline'} />
			</span>
			{a.online && m && (
				<span className="specs">
					<Meter icon="cpu" label="CPU" value={m.cpu === null ? null : Math.round(m.cpu)} />
					<Meter icon="memory" label="Memory" value={pct(m.mem)} />
					<Meter icon="disk" label="Disk" value={pct(rootDisk(a))} />
					{(m.gpus ?? []).map((g, i, all) => (
						<Meter key={g.id} icon="gpu" label={all.length > 1 ? `GPU ${g.index}` : 'GPU'} value={g.used == null ? null : Math.round(g.used)} />
					))}
					<Meter icon="battery" label="Battery" value={swarmGaugeItems(m).find((g) => g.k === 'Battery' && g.ready)?.p ?? null} />
					{typeof m.temp === 'number' && (
						<StatChip icon="thermo" label="Temperature">
							{Math.round(m.temp)}°C
						</StatChip>
					)}
					{!!m.updates && (
						<StatChip icon="update" label="Updates">
							{m.updates} update{m.updates === 1 ? '' : 's'}
						</StatChip>
					)}
				</span>
			)}
		</button>
	)
}

function Group({title, children}: {title: string; children: ReactNode}) {
	return (
		<>
			<div className="section-head" style={{margin: '20px 4px 8px'}}>
				<h2 style={{fontSize: 16}}>{title}</h2>
			</div>
			<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
				{children}
			</div>
		</>
	)
}

function AgentSheet({a, onClose, onTerminal, onDesktop, onStorage}: {a: Agent; onClose: () => void; onTerminal: (input?: string) => void; onDesktop: () => void; onStorage: () => void}) {
	const os = look(a)
	const act = useSwarmAction()
	const confirm = useConfirm()
	const [name, setName] = useState(a.name)
	const [plugins, setPlugins] = useState(false)
	const m = a.metrics
	const desk = a.info?.desktop
	const offline = !a.online
	const manage = may(a, 'manage') && a.online
	const action = (input: Record<string, unknown>, done: string) => act.mutate({path: 'swarm.action', input: {id: a.id, ...input}, done})
	return (
		<Sheet open onClose={onClose} label={a.name} tall>
			<SheetHeader
				icon={
					<span className="vm-os" style={{width: 64, height: 64, borderRadius: 19, background: os.bg}}>
						<Icon name={os.icon} size={32} />
					</span>
				}
				title={a.name}
				subtitle={
					<span style={{display: 'inline-flex', gap: 8, alignItems: 'center'}}>
						<StatusPill kind={a.online ? 'running' : 'stopped'} label={a.online ? 'Online' : `Offline · seen ${ago(a.lastSeen)}`} />
					</span>
				}
				onClose={onClose}
			/>
			<div className="primary-row">
				<button className="btn primary" disabled={offline || !may(a, 'terminal')} onClick={() => (haptic(8), onTerminal())}>
					<Icon name="terminal" size={20} /> Terminal
				</button>
				<button className="btn" disabled={offline || !may(a, 'desktop') || desk?.ok === false} onClick={() => (haptic(8), onDesktop())}>
					<Icon name="devices" size={20} /> Desktop
				</button>
			</div>
			{a.online && may(a, 'desktop') && desk && !desk.ok && <p className="muted" style={{fontSize: 13, margin: '8px 4px 0'}}>{desk.why}</p>}

			{a.online && m && <SwarmGauges metrics={m} />}
			<Group title="Disks">
				<Row
					icon="disk"
					color="var(--teal)"
					label="Storage"
					sub={offline ? undefined : storageRowSub(a.allowed.storage, a.on.storage)}
					onClick={a.online && may(a, 'storage') ? () => (haptic(8), onStorage()) : undefined}
					disabled={offline}
				/>
			</Group>
			{a.online && m && (extraDisks(m.disks).length > 0 || typeof m.temp === 'number' || m.uptime !== undefined) && (
				<Group title="Now">
					{extraDisks(m.disks).map((d) => (
						<Row key={d.mount} icon="disk" color="#f0a020" label={d.mount} sub={`${bytes(d.used)} of ${bytes(d.total)}`} trailing={<b>{pct(d)}%</b>} />
					))}
					{typeof m.temp === 'number' && <Row icon="thermo" color="#ef5350" label="Temperature" trailing={<b>{Math.round(m.temp)}°C</b>} />}
					{m.uptime !== undefined && <Row icon="clock" color="#8e8e93" label="Up for" trailing={<b>{duration(m.uptime)}</b>} />}
				</Group>
			)}

			{may(a, 'manage') && (
				<Group title="Manage">
					{a.info?.updateCommand && (
						<Row
							icon="update"
							color="#2fbf71"
							label="Update"
							sub={m?.updates ? `${m.updates} waiting · opens a terminal with ${a.info.updateCommand}` : `Opens a terminal with ${a.info.updateCommand} ready (you press Enter)`}
							onClick={may(a, 'terminal') && a.online ? () => onTerminal(a.info!.updateCommand) : undefined}
							disabled={offline}
						/>
					)}
					{a.info?.omarchy && (
						<>
							<Row icon="palette" color="#a855f7" label="Theme" trailing={<ThemePicker themes={a.info?.themes ?? []} theme={a.info?.theme ?? ''} disabled={!manage || act.isPending} onPick={(theme) => action({name: 'theme-set', theme}, `Setting ${theme} on ${a.name}…`)} />} />
							<Row icon="puzzle" color="var(--accent)" label="Omarchy plugins" sub={`${a.info.plugins?.length ?? 0} installed`} onClick={manage ? () => setPlugins(true) : undefined} />
						</>
					)}
					<Row
						icon="power"
						color="#ef5350"
						label="Restart"
						onClick={
							manage
								? async () => {
										if (await confirm({title: `Restart ${a.name}?`, body: 'Anything open on it closes. It joins again by itself once it’s back up.', confirm: 'Restart', icon: 'power'}))
											action({name: 'reboot'}, `Restarting ${a.name}…`)
									}
								: undefined
						}
					/>
				</Group>
			)}

			<Group title="Allowed here">
				<Row icon="sparkle" color="#2fbf71" label="Watch" sub="Always on: CPU, memory, disks, GPU, battery, temperature, updates" />
				{(Object.keys(ABILITY) as Ability[]).map((k) => (
					<Row
						key={k}
						icon={ABILITY[k].icon}
						label={ABILITY[k].label}
						sub={a.allowed[k] ? ABILITY[k].what : 'Not allowed when it joined. To allow it, remove this computer and add it again with it switched on.'}
						trailing={<Switch on={may(a, k)} disabled={!a.allowed[k] || act.isPending} label={ABILITY[k].label} onChange={(v) => act.mutate({path: 'swarm.setAbilities', input: {id: a.id, [k]: v}})} />}
					/>
				))}
			</Group>

			<Group title="About">
				<div className="row static" style={{minHeight: 56, gap: 10}}>
					<input
						aria-label="Name"
						value={name}
						maxLength={48}
						onChange={(e) => setName(e.target.value)}
						style={{flex: 1, background: 'transparent', border: 0, color: 'inherit', font: 'inherit', fontWeight: 600, padding: '0 6px'}}
					/>
					<button className="btn small" disabled={!name.trim() || name.trim() === a.name} onClick={() => act.mutate({path: 'swarm.rename', input: {id: a.id, name: name.trim()}, done: 'Renamed'})}>
						Rename
					</button>
				</div>
				{a.info && (
					<>
						<Row icon="server" color="#8e8e93" label={a.info.os ?? 'Linux'} sub={`${a.info.kernel ?? ''} · ${a.info.arch ?? ''}`} />
						<Row icon="user" color="#8e8e93" label={`Runs as ${a.info.user ?? '?'}`} sub={`on ${a.info.hostname ?? '?'} · connector ${a.info.version ?? '?'}`} />
					</>
				)}
				<Row icon="history" color="#8e8e93" label="Joined" sub={new Date(a.enrolledAt).toLocaleString()} />
			</Group>

			<button
				className="btn danger"
				style={{width: '100%', marginTop: 20}}
				onClick={async () => {
					if (
						await confirm({
							title: `Remove ${a.name}?`,
							body: 'It’s cut off from this server straight away. If it’s online, its connector forgets this server and stops; if it’s offline, it’s refused when it comes back. To remove the connector from that computer too, run the uninstall command shown in Add a computer.',
							confirm: 'Remove',
							icon: 'trash',
						})
					)
						act.mutate({path: 'swarm.remove', input: {id: a.id}, done: `${a.name} removed`}, {onSuccess: onClose})
				}}
			>
				<Icon name="trash" size={18} /> Remove from swarm
			</button>
			{plugins && <AgentPlugins a={a} onClose={() => setPlugins(false)} />}
		</Sheet>
	)
}

const ThemePicker = memo(function ThemePicker({themes, theme, disabled, onPick}: {themes: string[]; theme: string; disabled: boolean; onPick: (theme: string) => void}) {
	const current = themes.find((t) => t.toLowerCase().replace(/\s+/g, '-') === theme.toLowerCase()) ?? theme
	if (!themes.length) return <span className="muted">{current || '–'}</span>
	return (
		<select aria-label="Theme" value={current} disabled={disabled} onChange={(e) => e.target.value && onPick(e.target.value)} style={{maxWidth: 170}}>
			{!themes.includes(current) && <option value="">{current || 'Choose…'}</option>}
			{themes.map((t) => (
				<option key={t}>{t}</option>
			))}
		</select>
	)
}, (p, n) => sameThemePicker(p, n))

type Plugin = {id: string; name: string; description?: string; author?: string}
function AgentPlugins({a, onClose}: {a: Agent; onClose: () => void}) {
	const [q, setQ] = useState('')
	const act = useSwarmAction()
	const confirm = useConfirm()
	const installed = new Set(a.info?.plugins ?? [])
	// The same verified list as the App Store (plugins.omarchy.org, verified, pinned).
	const page = useQuery({
		queryKey: ['omarchy.plugins', q, '', 'stars', 60],
		queryFn: () => query<{plugins: Plugin[]}>('omarchy.plugins', {q, category: '', sort: 'stars', limit: 60}),
		placeholderData: (prev) => prev,
	})
	const list = page.data?.plugins ?? []
	return (
		<Sheet open onClose={onClose} label={`Plugins on ${a.name}`} tall>
			<SheetHeader icon={<Icon name="puzzle" size={30} />} title="Omarchy plugins" subtitle={`On ${a.name}`} onClose={onClose} />
			<p className="muted" style={{fontSize: 13, margin: '0 4px 10px'}}>
				Only plugins the Omarchy plugin registry verified, installed at the exact version it checked. They run inside that computer’s Omarchy desktop with its user’s permissions.
			</p>
			{installed.size > 0 && (
				<Group title="Installed">
					{[...installed].map((id) => (
						<Row
							key={id}
							icon="puzzle"
							label={list.find((p) => p.id === id)?.name ?? id}
							trailing={
								<button
									className="btn small"
									disabled={act.isPending}
									onClick={async () => {
										if (await confirm({title: `Remove ${id}?`, body: `It’s turned off and removed from ${a.name}.`, confirm: 'Remove', icon: 'trash'}))
											act.mutate({path: 'swarm.action', input: {id: a.id, name: 'plugin-remove', pluginId: id}, done: `Removed from ${a.name}`})
									}}
								>
									Remove
								</button>
							}
						/>
					))}
				</Group>
			)}
			<div className="field" style={{marginTop: 18}}>
				<input placeholder="Search verified plugins" value={q} onChange={(e) => setQ(e.target.value)} />
			</div>
			<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
				{page.isLoading && <Row icon="puzzle" label="Loading…" />}
				{list
					.filter((p) => !installed.has(p.id))
					.map((p) => (
						<Row
							key={p.id}
							icon="puzzle"
							label={p.name}
							sub={p.description}
							trailing={
								<button
									className="btn small primary"
									disabled={act.isPending}
									onClick={async () => {
										if (await confirm({title: `Install ${p.name} on ${a.name}?`, body: `By ${p.author || 'its author'}. Installed at the version the registry verified (an automated check, not a full security review).`, confirm: 'Install', icon: 'puzzle'}))
											act.mutate({path: 'swarm.action', input: {id: a.id, name: 'plugin-install', pluginId: p.id}, done: `${p.name} installed on ${a.name}`})
									}}
								>
									{act.isPending && act.variables?.input && (act.variables.input as {pluginId?: string}).pluginId === p.id ? <span className="spinner" /> : 'Install'}
								</button>
							}
						/>
					))}
			</div>
		</Sheet>
	)
}

// ---- Add a computer: what it may do → the command → step by step → it appears. ----------------
function AddComputer({before, onClose, onJoined}: {before: string[]; onClose: () => void; onJoined: (id: string) => void}) {
	const [beforeIds] = useState(before)
	// Storage can format disks there, so it's a choice you make; backups are on by default.
	const [allow, setAllow] = useState<Abilities>({terminal: true, desktop: true, manage: true, storage: false, backup: true})
	const [pairing, setPairing] = useState<Pairing | null>(null)
	const [host, setHost] = useState('')
	const [copied, setCopied] = useState('')
	const [now, setNow] = useState(Date.now())
	const toast = useToast()
	const swarm = useSwarm()
	const pair = useMutation({
		mutationFn: () => mutate<Pairing>('swarm.pair', allow),
		onSuccess: (p) => {
			setPairing(p)
			const here = location.hostname
			const local = here === 'localhost' || here === '127.0.0.1' || here === '::1'
			setHost(local ? (p.addresses[0]?.address ?? here) : here)
		},
		onError: (e) => toast((e as Error).message, true),
	})
	useEffect(() => {
		if (!pairing) return
		const t = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(t)
	}, [pairing])
	// The new computer, once it shows up. beforeIds is frozen at open so a live swarm.list cannot hide it.
	const joined = newlyJoined(swarm.data ?? [], beforeIds)
	const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0
	const list = (Object.keys(allow) as Ability[]).filter((k) => allow[k]).join(',')
	const command = useMemo(() => {
		if (!pairing) return ''
		const server = `https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${pairing.port}`
		const src = pairing.source.replace(/\/+$/, '')
		return `curl -fsSL ${src}/main/connector/install.sh | bash -s -- --server ${server} --ca ${pairing.ca} --token ${pairing.token}${list ? ` --allow ${list}` : ''} --source ${src}`
	}, [pairing, host, list])
	const uninstall = pairing ? `curl -fsSL ${pairing.source.replace(/\/+$/, '')}/main/connector/install.sh | bash -s -- --uninstall` : ''
	const copy = async (text: string, what: string) => {
		try {
			await navigator.clipboard.writeText(text)
			setCopied(what)
			haptic(8)
			setTimeout(() => setCopied(''), 2000)
		} catch {
			toast('Couldn’t copy. Select the text and copy it yourself.', true)
		}
	}
	const hosts = pairing ? [...new Set([location.hostname, ...pairing.addresses.map((x) => x.address)].filter((h) => h && h !== 'localhost' && h !== '127.0.0.1'))] : []

	return (
		<Sheet open onClose={onClose} label="Add a computer" tall>
			<SheetHeader icon={<Icon name="devices" size={30} />} title="Add a computer" subtitle="Any Linux computer with systemd. Not Windows or macOS." onClose={onClose} />
			{!pairing ? (
				<>
					<p className="muted" style={{fontSize: 14, margin: '0 4px 12px'}}>
						Choose what this server may do on the new computer. The connector there enforces it too, and you can switch these off later (but not on again without adding it again).
					</p>
					<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
						<Row icon="sparkle" color="#2fbf71" label="Watch" sub="Always: CPU, memory, disks, temperature, updates waiting" />
						{(Object.keys(ABILITY) as Ability[]).map((k) => (
							<Row key={k} icon={ABILITY[k].icon} label={ABILITY[k].label} sub={ABILITY[k].what} trailing={<Switch on={allow[k]} label={ABILITY[k].label} onChange={(v) => setAllow({...allow, [k]: v})} />} />
						))}
					</div>
					<button className="btn primary" style={{width: '100%', marginTop: 18}} disabled={pair.isPending} onClick={() => pair.mutate()}>
						{pair.isPending ? <span className="spinner" /> : <Icon name="key" size={18} />} Make the install command
					</button>
				</>
			) : joined ? (
				<div className="glass empty">
					<span className="big" style={{color: 'var(--ok, #2fbf71)'}}>
						<Icon name="check" size={30} />
					</span>
					<b>{joined.name} joined</b>
					<span>It’s in your local swarm now.</span>
					<button className="btn primary small" onClick={() => onJoined(joined.id)}>
						Open it
					</button>
				</div>
			) : (
				<>
					<ol className="swarm-steps">
						<li>
							<b>On the other computer, open a terminal</b>
							<span>Signed in as the person who uses it, not root. It needs to reach this server on your network (or your tailnet).</span>
						</li>
						{hosts.length > 1 && (
							<li>
								<b>Pick the address it reaches this server on</b>
								<span className="chips" style={{marginTop: 8}}>
									{hosts.map((h) => (
										<button key={h} className={`chip${h === host ? ' on' : ''}`} aria-pressed={h === host} onClick={() => setHost(h)}>
											{h}
											{pairing.addresses.find((x) => x.address === h)?.tailscale ? ' · Tailscale' : ''}
										</button>
									))}
								</span>
							</li>
						)}
						<li>
							<b>Paste this and press Enter</b>
							<code className="swarm-cmd mono">{left ? command : 'This command has expired.'}</code>
							{left ? (
								<span style={{display: 'flex', alignItems: 'center', gap: 10, marginTop: 8}}>
									<button className="btn small primary" onClick={() => copy(command, 'cmd')}>
										<Icon name={copied === 'cmd' ? 'check' : 'copy'} size={15} /> {copied === 'cmd' ? 'Copied' : 'Copy'}
									</button>
									<span className="muted" style={{fontSize: 12.5}}>
										Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
									</span>
								</span>
							) : (
								<button className="btn small" style={{marginTop: 8}} onClick={() => (setPairing(null), pair.mutate())}>
									Make a new one
								</button>
							)}
						</li>
						<li>
							<b>Enter your password when it asks</b>
							<span>Only so it can install what it needs (Python, git, and screen sharing if Desktop is on) and keep running while you’re signed out. The connector itself runs as you, never as root.</span>
						</li>
						<li>
							<b>Wait here</b>
							<span style={{display: 'flex', alignItems: 'center', gap: 8}}>
								<span className="spinner" /> It appears as soon as it joins.
							</span>
						</li>
					</ol>
					<details className="muted" style={{fontSize: 13, margin: '16px 4px 0'}}>
						<summary>How it stays safe</summary>
						<p>
							The connector dials out to this server; the other computer opens no ports. It checks this server’s certificate against the fingerprint in the command before it sends anything, and the one-time code is
							useless after it’s used or after 15 minutes. It can only do what you allowed above, and there’s no “run any command” from here: the terminal is a shell you type into, and Manage is a short fixed
							list.
						</p>
						<p>
							To remove it from a computer later:
							<code className="swarm-cmd mono">{uninstall}</code>
						</p>
					</details>
				</>
			)}
		</Sheet>
	)
}
