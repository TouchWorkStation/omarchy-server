import {useRef, useState, type CSSProperties} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {diskPct, logout, mutate, query, type BatteryInfo, type DiskUsage, type GpuInfo, type UsageItem, type Wallpaper} from '../api'
import {resetAssistantTurn} from '../assistantTurn'
import {resetDeskConfig} from '../desktop/config'
import {batteryPackSub} from '../battery'
import {useApps, useBattery, useBootstrap, useCpu, useDisk, useGpus, useMemory, useTemp, useUptime, useUser} from '../data'
import {shortGpuName} from '../gauges'
import {Icon} from '../icons'
import {OmarchyBackgrounds} from '../OmarchyBackgrounds'
import {applyPrefsUpdate, prefsAfterPhotoUpload, prefsChoosingYourPhoto} from '../photoPrefs'
import {ACCENTS, AppIcon, Card, CardHead, KV, Row, Segmented, SolidColors, StatCard, THEMES, VersionTag, bytes, customBackgroundUrl, duration, haptic, omarchyBackgroundUrl, preparePhoto, useConfirm, useHistory, useOmarchyThemes, useToast, type Prefs} from '../ui'

const BAR = ['var(--blue)', 'var(--mauve)', 'var(--teal)', 'var(--peach)', 'var(--pink)', 'var(--green)']
const GPU_COLORS = ['var(--green)', 'var(--teal)', 'var(--peach)', 'var(--pink)']
const BATTERY_COLORS = ['var(--green)', 'var(--teal)']

function BatteryCard({bat, stamp, color, title}: {bat: BatteryInfo; stamp: number; color: string; title: string}) {
	const series = useHistory(bat.percent ?? undefined, stamp)
	return (
		<StatCard
			icon="battery"
			label={title}
			ariaLabel={`${bat.name} battery`}
			value={bat.percent != null ? bat.percent.toFixed(0) : '–'}
			unit={bat.percent != null ? '%' : undefined}
			sub={batteryPackSub(bat) || ' '}
			spark={{series, color, label: `${bat.name} charge over the last two minutes`}}
		/>
	)
}

function GpuCard({gpu, stamp, color, title}: {gpu: GpuInfo; stamp: number; color: string; title: string}) {
	const series = useHistory(gpu.used ?? undefined, stamp)
	const vram =
		gpu.memoryUsed != null && gpu.memoryTotal != null
			? `${bytes(gpu.memoryUsed, 1, 1024)} of ${bytes(gpu.memoryTotal, 0, 1024)}`
			: gpu.memoryTotal != null
				? bytes(gpu.memoryTotal, 0, 1024)
				: null
	const bits = [shortGpuName(gpu.name), vram, gpu.temperature != null ? `${Math.round(gpu.temperature)}°C` : null].filter(Boolean)
	return (
		<StatCard
			icon="gpu"
			label={title}
			ariaLabel={`${gpu.name} usage`}
			value={gpu.used != null ? gpu.used.toFixed(0) : '–'}
			unit={gpu.used != null ? '%' : undefined}
			sub={bits.join(' · ') || ' '}
			spark={{series, color, label: `${gpu.name} usage over the last two minutes`}}
		/>
	)
}

function Usage() {
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const apps = useApps()
	const [tab, setTab] = useState<'cpu' | 'memory' | 'storage'>('cpu')
	const lookup = (id: string) => apps.data?.find((a) => a.id === id)
	const source: {items: UsageItem[]; total: number; fmt: (n: number) => string} =
		tab === 'cpu'
			? {items: [...(cpu.data?.apps ?? []), ...(cpu.data?.machines ?? [])], total: 100, fmt: (n) => `${n.toFixed(1)}%`}
			: tab === 'memory'
				? {items: [...(mem.data?.apps ?? []), ...(mem.data?.machines ?? [])], total: mem.data?.size ?? 1, fmt: (n) => bytes(n, 1, 1024)}
				: {items: [...(disk.data?.apps ?? []), ...(disk.data?.machines ?? [])], total: disk.data?.size ?? 1, fmt: (n) => bytes(n)}
	const top = [...source.items].sort((a, b) => b.used - a.used).slice(0, 6)
	const max = Math.max(...top.map((t) => t.used), 0.0001)
	return (
		<Card style={{marginTop: 12}}>
			<CardHead title="What’s using it" />
			<Segmented
				value={tab}
				onChange={setTab}
				label="Resource"
				options={[
					{id: 'cpu', label: 'CPU'},
					{id: 'memory', label: 'Memory'},
					{id: 'storage', label: 'Storage'},
				]}
			/>
			<div className="toplist">
				{top.length === 0 && <span className="muted" style={{fontSize: 14}}>Nothing measurable right now.</span>}
				{top.map((item, i) => {
					const app = lookup(item.id)
					const name = item.name ?? app?.name ?? (item.id === 'other' ? 'Other' : item.id)
					return (
						<div className="item" key={item.id}>
							<AppIcon src={app?.icon} name={name} size={28} />
							<span className="name">{name}</span>
							<span className="val">{source.fmt(item.used)}</span>
							<span className="bar">
								<i style={{width: `${(item.used / max) * 100}%`, background: BAR[i % BAR.length]}} />
							</span>
						</div>
					)
				})}
			</div>
		</Card>
	)
}

function Live() {
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const temp = useTemp()
	const uptime = useUptime()
	const gpus = useGpus()
	const gpuList = gpus.data?.gpus ?? []
	const battery = useBattery()
	const batteryList = battery.data?.batteries ?? []
	const cpuSeries = useHistory(cpu.data?.totalUsed, cpu.dataUpdatedAt)
	const memSeries = useHistory(mem.data ? (mem.data.totalUsed / mem.data.size) * 100 : undefined, mem.dataUpdatedAt)
	const parts = disk.data
		? [
				{label: 'Apps', value: disk.data.apps.reduce((t, a) => t + a.used, 0), color: 'var(--blue)'},
				{label: 'Files', value: disk.data.files ?? 0, color: 'var(--mauve)'},
				{label: 'Machines', value: disk.data.machines.reduce((t, a) => t + a.used, 0), color: 'var(--teal)'},
				{label: 'System', value: disk.data.system, color: 'var(--peach)'},
			].filter((p) => p.value > 0)
		: []
	return (
		<>
			<div className="split">
				<StatCard
					icon="cpu"
					label="CPU"
					value={cpu.data ? cpu.data.totalUsed.toFixed(0) : '–'}
					unit="%"
					sub={cpu.data ? `${cpu.data.threads} threads` : ' '}
					spark={{series: cpuSeries, color: 'var(--blue)', label: 'CPU usage over the last two minutes'}}
				/>
				<StatCard
					icon="memory"
					label="Memory"
					value={mem.data ? bytes(mem.data.totalUsed, 1, 1024).split(' ')[0] : '–'}
					unit={mem.data ? bytes(mem.data.totalUsed, 1, 1024).split(' ')[1] : ''}
					sub={`of ${bytes(mem.data?.size, 0, 1024)}`}
					spark={{series: memSeries, color: 'var(--mauve)', label: 'Memory usage over the last two minutes'}}
				/>
				<StatCard
					icon="thermo"
					label="Temperature"
					value={temp.data?.temperature != null ? Math.round(temp.data.temperature) : '–'}
					unit={temp.data?.temperature != null ? '°C' : undefined}
					sub={temp.data?.temperature != null ? temp.data.warning : temp.data?.reason === 'virtual' ? 'Not available in a virtual machine' : temp.data ? 'No sensor found' : ' '}
					subStyle={{paddingBottom: 4, textTransform: temp.data?.temperature != null ? 'capitalize' : undefined}}
				/>
				<StatCard icon="clock" label="Uptime" value={duration(uptime.data)} sub="since last restart" subStyle={{paddingBottom: 4}} />
			</div>
			{gpuList.length > 0 && (
				<div className="split" style={{marginTop: 12}}>
					{gpuList.map((gpu, i) => (
						<GpuCard
							key={gpu.id}
							gpu={gpu}
							stamp={gpus.dataUpdatedAt}
							color={GPU_COLORS[i % GPU_COLORS.length]}
							title={gpuList.length > 1 ? `GPU ${gpu.index}` : 'GPU'}
						/>
					))}
				</div>
			)}
			{batteryList.length > 0 && (
				<div className="split" style={{marginTop: 12}}>
					{batteryList.map((bat, i) => (
						<BatteryCard
							key={bat.id}
							bat={bat}
							stamp={battery.dataUpdatedAt}
							color={BATTERY_COLORS[i % BATTERY_COLORS.length]}
							title={batteryList.length > 1 ? `Battery ${bat.index}` : 'Battery'}
						/>
					))}
				</div>
			)}
			<Card style={{marginTop: 12}} label="Storage">
				<CardHead
					title="Storage"
					extra={disk.data ? `${bytes(disk.data.available, 0)} free of ${bytes(disk.data.size, 0)} · ${Math.round(diskPct(disk.data))}% used` : ''}
				/>
				<div className="stacked" aria-hidden="true">
					{parts.map((p) => (
						<i key={p.label} style={{width: `${(p.value / (disk.data?.size || 1)) * 100}%`, background: p.color}} />
					))}
				</div>
				<div className="legend">
					{parts.map((p) => (
						<div key={p.label}>
							<i style={{background: p.color}} />
							<span className="name">{p.label}</span>
							<span className="val">{bytes(p.value)}</span>
						</div>
					))}
				</div>
				{disk.data?.measuring && <p className="muted" style={{fontSize: 12.5, margin: '8px 0 0'}}>Measuring apps, machines and files…</p>}
				{disk.data?.drive && disk.data.drive.notInUse > 0 && <UnusedSpace disk={disk.data} />}
			</Card>
			<PoolsCard />
		</>
	)
}

export function Appearance({prefs, setPrefs, wallpaper}: {prefs: Prefs; setPrefs: (p: Prefs) => void; wallpaper?: Wallpaper | null}) {
	const toast = useToast()
	const fileRef = useRef<HTMLInputElement>(null)
	const [uploading, setUploading] = useState(false)
	const desktopBg = useOmarchyThemes().data?.current
	const wp = omarchyBackgroundUrl(prefs.omarchyBackground, desktopBg)
	const photo = customBackgroundUrl(prefs.backgroundVersion)
	const brand = wallpaper?.brandColorHsl ? `hsl(${wallpaper.brandColorHsl})` : 'hsl(24 90% 50%)'
	const photoBrand = prefs.customBrandHsl ? `hsl(${prefs.customBrandHsl})` : brand
	const accentPreview = prefs.theme === 'custom' ? photoBrand : brand

	const upload = async (file?: File | null) => {
		if (!file) return
		setUploading(true)
		try {
			const {blob, hsl} = await preparePhoto(file)
			const res = await fetch('/api/background', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'image/jpeg', 'x-omarchy-server': '1'}, body: blob})
			const body = await res.json().catch(() => null)
			if (!res.ok) throw new Error(body?.error?.message ?? 'Upload failed')
			applyPrefsUpdate(setPrefs, (latest) => prefsAfterPhotoUpload(latest, {hsl, backgroundVersion: body.prefs.backgroundVersion ?? null}, {setThemeCustom: true}))
			toast('Background saved')
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setUploading(false)
			if (fileRef.current) fileRef.current.value = ''
		}
	}
	const removePhoto = async () => {
		const res = await fetch('/api/background', {method: 'DELETE', credentials: 'same-origin', headers: {'x-omarchy-server': '1'}}).catch(() => null)
		if (!res?.ok) return toast('Couldn’t remove the photo', true)
		setPrefs({...prefs, theme: prefs.theme === 'custom' ? 'horizon' : prefs.theme, customBrandHsl: null, backgroundVersion: null})
		toast('Photo removed')
	}

	return (
		<Card>
			<input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
			<div className="themes" role="radiogroup" aria-label="Theme">
				{THEMES.map((t) => {
					const on = prefs.theme === t.id
					const isWall = t.id === 'horizon'
					const isPhoto = t.id === 'custom'
					const isOmarchy = t.id === 'omarchy'
					const bg = isOmarchy
						? `linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.5)), url(${omarchyBackgroundUrl(prefs.omarchyBackground, desktopBg)}) center/cover, ${t.bg}`
						: isWall && wp ? `linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.45)), url(${wp}) center/cover` : isPhoto && photo ? `linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.45)), url(${photo}) center/cover` : isPhoto ? 'linear-gradient(140deg, #2a2a33, #15151a)' : t.bg
					return (
						<button
							key={t.id}
							role="radio"
							aria-checked={on}
							className={`theme-card${on ? ' on' : ''}`}
							style={{background: bg, color: t.fg, minHeight: isWall || isPhoto || isOmarchy ? 104 : undefined}}
							onClick={() => {
								haptic(6)
								if (isPhoto && !photo) return fileRef.current?.click()
								if (isPhoto) {
									applyPrefsUpdate(setPrefs, (latest) => prefsChoosingYourPhoto(latest))
									return
								}
								setPrefs({...prefs, theme: t.id})
							}}
						>
							<span className="label">{t.name}</span>
							<span className="dots">
								{isWall ? (
									[brand, '#ffffff'].map((d) => <i key={d} style={{background: d}} />)
								) : isPhoto ? (
									photo ? (
										[photoBrand, '#ffffff'].map((d) => <i key={d} style={{background: d}} />)
									) : (
										<span style={{display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, opacity: 0.85}}>
											{uploading ? <span className="spinner" style={{width: 14, height: 14}} /> : <Icon name="photo-up" size={16} />}
											{uploading ? 'Uploading…' : 'Upload'}
										</span>
									)
								) : (
									t.dots.map((d) => <i key={d} style={{background: d}} />)
								)}
							</span>
							{on && (
								<span className="tick">
									<Icon name="check" size={14} stroke={3} />
								</span>
							)}
						</button>
					)
				})}
			</div>
			<div className="section-head" style={{margin: '18px 0 6px'}}>
				<h2>Wallpaper</h2>
			</div>
			<OmarchyBackgrounds
				selected={prefs.theme === 'omarchy' || prefs.theme === 'horizon' ? (prefs.omarchyBackground ?? null) : undefined}
				onChoose={(id) =>
					// A wallpaper needs a theme that shows one: Horizon keeps its look, anything else becomes Omarchy.
					setPrefs({...prefs, theme: prefs.theme === 'horizon' ? 'horizon' : 'omarchy', omarchyBackground: id, solidColor: null})
				}
			/>
			<div className="section-head" style={{margin: '18px 0 6px'}}>
				<h2>Solid colour</h2>
			</div>
			<SolidColors value={prefs.solidColor ?? null} onChange={(c) => (haptic(6), setPrefs({...prefs, solidColor: c}))} />
						{photo && (
				<div className="photo-actions">
					<button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading}>
						{uploading ? <span className="spinner" /> : <Icon name="photo-up" size={18} />}
						{uploading ? 'Uploading…' : 'Change photo'}
					</button>
					<button className="btn danger" onClick={removePhoto} disabled={uploading}>
						<Icon name="trash" size={18} />
						Remove
					</button>
				</div>
			)}
			<div className="accents" role="radiogroup" aria-label="Accent color">
				{ACCENTS.map((a) => (
					<button
						key={a}
						role="radio"
						aria-checked={prefs.accent === a}
						aria-label={a === 'wallpaper' ? 'Match background' : a}
						className={`accent-btn${prefs.accent === a ? ' on' : ''}`}
						style={{background: a === 'wallpaper' ? accentPreview : `var(--${a})`}}
						onClick={() => {
							haptic(6)
							setPrefs({...prefs, accent: a})
						}}
					>
						{a === 'wallpaper' && <Icon name="wallpaper" size={18} />}
					</button>
				))}
			</div>
			<p className="footer-note" style={{textAlign: 'left', margin: '14px 2px 0'}}>
				Saved to your account, so it follows you to every phone you sign in on.
			</p>
		</Card>
	)
}

export function More({prefs, setPrefs, onSignedOut, onSettings, onClips}: {prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void; onSettings: () => void; onClips?: () => void}) {
	const boot = useBootstrap()
	const user = useUser()
	const confirm = useConfirm()
	const toast = useToast()
	const qc = useQueryClient()
	const update = useQuery({
		queryKey: ['system.checkUpdate'],
		queryFn: () => query<{available: boolean; name: string; version: string}>('system.checkUpdate'),
		staleTime: 30 * 60_000,
		retry: false,
	})

	const power = async (kind: 'restart' | 'shutdown') => {
		const ok = await confirm({
			title: kind === 'restart' ? 'Restart your server?' : 'Shut down your server?',
			body:
				kind === 'restart'
					? 'All apps and machines stop, then come back once Omarchy Server has restarted. This takes a few minutes.'
					: 'All apps and machines stop. You’ll need to turn the server back on yourself (for a VM, from its host).',
			confirm: kind === 'restart' ? 'Restart' : 'Shut down',
			danger: true,
			icon: kind === 'restart' ? 'restart' : 'power',
		})
		if (!ok) return
		try {
			await mutate(`system.${kind}`)
			toast(kind === 'restart' ? 'Your server is restarting' : 'Your server is shutting down')
		} catch (e) {
			toast((e as Error).message, true)
		}
	}
	const signOut = async () => {
		const ok = await confirm({title: 'Sign out?', body: 'This phone is signed out and removed from your server’s devices.', confirm: 'Sign out', icon: 'signout'})
		if (!ok) return
		await logout().catch(() => {})
		qc.clear()
		resetDeskConfig()
		resetAssistantTurn()
		onSignedOut()
	}

	return (
		<div className="stagger">
			<div>
				<h1 className="title">System</h1>
				<p className="subtitle">
					{boot.server?.device ?? 'server'} · <VersionTag version={boot.server?.name ?? boot.server?.version} info={boot.server} />
				</p>
			</div>
			<div>
				<Live />
				<Usage />
			</div>
			<section>
				<div className="section-head">
					<h2>Your server</h2>
				</div>
				<KV
					rows={[
						['Device', boot.server?.device ?? '–'],
						['Address', boot.server?.host ?? '–'],
						['Omarchy Server', <VersionTag version={boot.server?.version} info={boot.server} />],
						['Software update', update.data ? (update.data.available ? `${update.data.name} available` : 'Up to date') : '–'],
						['Signed in as', `${user.data?.name ?? '–'}${user.data?.role ? ` (${user.data.role})` : ''}`],
					]}
				/>
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					{onClips && <Row icon="clipboard" color="var(--teal)" label="Clip book" onClick={onClips} />}
					<Row icon="settings" color="#8e8e93" label="Settings" onClick={onSettings} />
					<Row icon="open" color="var(--blue)" label="Open Omarchy Server" href={boot.server?.url} />
					<Row icon="restart" color="var(--peach)" label="Restart server" onClick={() => power('restart')} />
					<Row icon="power" color="var(--red)" label="Shut down server" onClick={() => power('shutdown')} />
					<Row icon="signout" color="#8e8e93" label="Sign out of this device" onClick={signOut} />
				</div>
			</section>
			<p className="footer-note">
				<VersionTag prefix="Omarchy Server " version={boot.touch.version} info={boot.server} />
			</p>
		</div>
	)
}

// After a drive (or virtual disk) is made bigger, the partition, encryption and filesystem on it
// still have their old size until they're grown. Shows how much is waiting and how to grow it.
function UnusedSpace({disk}: {disk: DiskUsage}) {
	const d = disk.drive!
	const toast = useToast()
	const qc = useQueryClient()
	const [asking, setAsking] = useState(false)
	const [password, setPassword] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const owner = useUser().data?.role !== 'member'
	const notLast = d.steps.includes('partition-not-last')
	const grow = async () => {
		setBusy(true)
		setError('')
		try {
			await mutate('storage.growSystem', password ? {password} : {})
			setAsking(false)
			setPassword('')
			toast(`Done: the system now uses all ${bytes(d.size, 0)}`)
			qc.invalidateQueries({queryKey: ['system.diskUsage']})
		} catch (e) {
			const msg = (e as Error).message
			if (/NEEDS_PASSWORD/.test(msg)) setAsking(true)
			else setError(msg)
		} finally {
			setBusy(false)
		}
	}
	return (
		<div className="unused-space">
			<b>{bytes(d.notInUse, 0)} of your {bytes(d.size, 0)} drive isn’t in use yet</b>
			<span>
				{notLast
					? 'The drive got bigger, but the system’s partition isn’t the last one on it, so it can’t simply be grown. Use a partition tool (like GParted) from a live USB.'
					: 'The drive got bigger, but the system still has its old size. Omarchy Server can grow the partition' + (d.encrypted ? ', its encryption' : '') + ' and the filesystem into the new space while it runs. Only ever grows; nothing is erased.'}
			</span>
			{asking && (
				<input
					type="password"
					className="unused-pw"
					autoFocus
					placeholder="Disk password (the one you type at startup)"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && password && !busy && grow()}
				/>
			)}
			{error && <span className="unused-err">{error}</span>}
			{!notLast && owner && (
				<button className="btn primary small" disabled={busy || (asking && !password)} onClick={grow}>
					{busy ? 'Growing…' : asking ? 'Unlock and grow' : 'Use the extra space'}
				</button>
			)}
		</div>
	)
}

type PoolInfo = {kind: 'btrfs' | 'zfs'; name: string; mounted: boolean; devices: string[]; size: number | null; free: number | null; profile: string | null; errors: number; health?: string}
// Storage pools (your extra drives), each with its own space: the card above is the system drive.
function PoolsCard() {
	const pools = useQuery({queryKey: ['storage.pools'], queryFn: () => query<PoolInfo[]>('storage.pools'), refetchInterval: 30_000, retry: false})
	if (!pools.data?.length) return null
	return (
		<Card style={{marginTop: 12}} label="Storage pools">
			<CardHead title="Storage pools" extra={`${pools.data.length} pool${pools.data.length > 1 ? 's' : ''}`} />
			{pools.data.map((p) => {
				const used = p.size != null && p.free != null ? p.size - p.free : null
				const pct = used != null && p.size ? (100 * used) / p.size : 0
				const trouble = !p.mounted || p.errors > 0 || (p.health && p.health !== 'ONLINE')
				return (
					<div key={p.name} className="pool-row">
						<div className="pool-head">
							<span className="name">{p.name}</span>
							<span className="val">
								{!p.mounted ? 'Not connected' : p.size != null ? `${bytes(p.free ?? 0, 0)} free of ${bytes(p.size, 0)}` : '–'}
							</span>
						</div>
						<div className="stacked" aria-hidden="true">
							<i style={{width: `${pct}%`, background: trouble ? 'var(--red)' : 'var(--teal)'}} />
						</div>
						<div className="pool-sub">
							{p.devices.length} drive{p.devices.length === 1 ? '' : 's'}
							{p.profile ? ` · ${p.profile}` : ''}
							{p.errors > 0 ? ` · ${p.errors} error${p.errors > 1 ? 's' : ''}` : ''}
							{p.health && p.health !== 'ONLINE' ? ` · ${p.health.toLowerCase()}` : ''}
						</div>
					</div>
				)
			})}
		</Card>
	)
}
