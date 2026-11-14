import {useEffect, useMemo, useRef, useState, type CSSProperties} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {diskPct, logout, mutate, query, type DiskUsage, type UsageItem, type Wallpaper} from '../api'
import {useApps, useBootstrap, useCpu, useDisk, useMemory, useTemp, useUptime, useUser} from '../data'
import {Icon} from '../icons'
import {OmarchyBackgrounds} from '../OmarchyBackgrounds'
import {ACCENTS, AppIcon, KV, Segmented, THEMES, bytes, customBackgroundUrl, duration, haptic, omarchyBackgroundUrl, useOmarchyThemes, preparePhoto, useConfirm, useToast, type Prefs} from '../ui'

// One point per successful poll (keyed on fetch time, so flat values still plot).
function useHistory(value: number | undefined, stamp: number, size = 40) {
	const [series, setSeries] = useState<number[]>([])
	useEffect(() => {
		if (value === undefined || !stamp) return
		setSeries((s) => [...s.slice(-(size - 1)), value])
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [stamp])
	return series
}

function Spark({series, max = 100, color, label}: {series: number[]; max?: number; color: string; label: string}) {
	const w = 300
	const h = 54
	const id = useMemo(() => `g${Math.random().toString(36).slice(2)}`, [])
	if (series.length < 2) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" />
	const step = w / Math.max(series.length - 1, 1)
	const y = (v: number) => h - 3 - (Math.min(v, max) / max) * (h - 8)
	const pts = series.map((v, i) => [i * step, y(v)] as const)
	// Smooth the line with simple cubic segments.
	let d = `M${pts[0][0]},${pts[0][1]}`
	for (let i = 1; i < pts.length; i++) {
		const [x0, y0] = pts[i - 1]
		const [x1, y1] = pts[i]
		const cx = (x0 + x1) / 2
		d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`
	}
	return (
		<svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
			<defs>
				<linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
					<stop offset="0" stopColor={color} stopOpacity="0.35" />
					<stop offset="1" stopColor={color} stopOpacity="0" />
				</linearGradient>
			</defs>
			<path d={`${d} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
			<path d={d} fill="none" stroke={color} strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
		</svg>
	)
}

const BAR = ['var(--blue)', 'var(--mauve)', 'var(--teal)', 'var(--peach)', 'var(--pink)', 'var(--green)']

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
		<section className="glass card" style={{marginTop: 12}}>
			<div className="card-head">
				<strong>What’s using it</strong>
			</div>
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
		</section>
	)
}

function Live() {
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const temp = useTemp()
	const uptime = useUptime()
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
				<section className="glass stat">
					<div className="k">
						<Icon name="cpu" size={16} /> CPU
					</div>
					<div className="v">
						{cpu.data ? cpu.data.totalUsed.toFixed(0) : '–'}
						<small>%</small>
					</div>
					<div className="sub">{cpu.data ? `${cpu.data.threads} threads` : ' '}</div>
					<Spark series={cpuSeries} color="var(--blue)" label="CPU usage over the last two minutes" />
				</section>
				<section className="glass stat">
					<div className="k">
						<Icon name="memory" size={16} /> Memory
					</div>
					<div className="v">
						{mem.data ? bytes(mem.data.totalUsed, 1, 1024).split(' ')[0] : '–'}
						<small>{mem.data ? bytes(mem.data.totalUsed, 1, 1024).split(' ')[1] : ''}</small>
					</div>
					<div className="sub">of {bytes(mem.data?.size, 0, 1024)}</div>
					<Spark series={memSeries} color="var(--mauve)" label="Memory usage over the last two minutes" />
				</section>
				<section className="glass stat">
					<div className="k">
						<Icon name="thermo" size={16} /> Temperature
					</div>
					<div className="v">
						{temp.data?.temperature != null ? Math.round(temp.data.temperature) : '–'}
						{temp.data?.temperature != null && <small>°C</small>}
					</div>
					<div className="sub" style={{paddingBottom: 4, textTransform: temp.data?.temperature != null ? 'capitalize' : undefined}}>
						{temp.data?.temperature != null ? temp.data.warning : temp.data?.reason === 'virtual' ? 'Not available in a virtual machine' : temp.data ? 'No sensor found' : ' '}
					</div>
				</section>
				<section className="glass stat">
					<div className="k">
						<Icon name="clock" size={16} /> Uptime
					</div>
					<div className="v">{duration(uptime.data)}</div>
					<div className="sub" style={{paddingBottom: 4}}>
						since last restart
					</div>
				</section>
			</div>
			<section className="glass card" style={{marginTop: 12}} aria-label="Storage">
				<div className="card-head">
					<strong>Storage</strong>
					<span>{disk.data ? `${bytes(disk.data.available, 0)} free of ${bytes(disk.data.size, 0)} · ${Math.round(diskPct(disk.data))}% used` : ''}</span>
				</div>
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
			</section>
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
			setPrefs({...prefs, theme: 'custom', customBrandHsl: hsl, backgroundVersion: body.prefs.backgroundVersion})
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
		<section className="glass card">
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
					setPrefs({...prefs, theme: prefs.theme === 'horizon' ? 'horizon' : 'omarchy', omarchyBackground: id})
				}
			/>
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
		</section>
	)
}

export function More({prefs, setPrefs, onSignedOut, onSettings}: {prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void; onSettings: () => void}) {
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
		onSignedOut()
	}

	const Row = ({icon, color, label, onClick, href}: {icon: Parameters<typeof Icon>[0]['name']; color: string; label: string; onClick?: () => void; href?: string}) => {
		const inner = (
			<>
				<span className="row-ico" style={{'--c': color} as CSSProperties}>
					<Icon name={icon} size={19} />
				</span>
				<span className="main">
					<b style={{fontWeight: 550}}>{label}</b>
				</span>
				<Icon name="chevron" size={18} className="chev" />
			</>
		)
		return href ? (
			<a className="row" href={href} target="_blank" rel="noopener noreferrer" style={{minHeight: 56}}>
				{inner}
			</a>
		) : (
			<button className="row" onClick={onClick} style={{minHeight: 56}}>
				{inner}
			</button>
		)
	}

	return (
		<div className="stagger">
			<div>
				<h1 className="title">System</h1>
				<p className="subtitle">
					{boot.server?.device ?? 'server'} · {boot.server?.name ?? boot.server?.version}
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
						['Omarchy Server', boot.server?.version ?? '–'],
						['Software update', update.data ? (update.data.available ? `${update.data.name} available` : 'Up to date') : '–'],
						['Signed in as', `${user.data?.name ?? '–'}${user.data?.role ? ` (${user.data.role})` : ''}`],
					]}
				/>
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					<Row icon="settings" color="#8e8e93" label="Settings" onClick={onSettings} />
					<Row icon="open" color="var(--blue)" label="Open Omarchy Server" href={boot.server?.url} />
					<Row icon="restart" color="var(--peach)" label="Restart server" onClick={() => power('restart')} />
					<Row icon="power" color="var(--red)" label="Shut down server" onClick={() => power('shutdown')} />
					<Row icon="signout" color="#8e8e93" label="Sign out of this device" onClick={signOut} />
				</div>
			</section>
			<p className="footer-note">Omarchy Server {boot.touch.version}</p>
		</div>
	)
}

// After a drive (or virtual disk) is made bigger, the partition, encryption and filesystem on it
// still have their old size until they're grown. Shows how much is waiting and how to grow it.
function UnusedSpace({disk}: {disk: DiskUsage}) {
	const d = disk.drive!
	const toast = useToast()
	const cmds: string[] = []
	if (d.steps.includes('partition') && d.partitionNumber) cmds.push(`sudo growpart ${d.name} ${d.partitionNumber}`)
	if (d.steps.includes('encryption') && d.encrypted) cmds.push(`sudo cryptsetup resize ${d.encrypted}`)
	if (d.steps.includes('filesystem'))
		cmds.push(d.filesystem === 'btrfs' ? 'sudo btrfs filesystem resize max /' : d.filesystem === 'xfs' ? 'sudo xfs_growfs /' : d.filesystem === 'ext4' && (d.encrypted || d.partition) ? `sudo resize2fs ${d.encrypted ? `/dev/mapper/${d.encrypted}` : d.partition}` : 'Grow the filesystem to fill its partition')
	const text = cmds.join('\n')
	return (
		<div className="unused-space">
			<b>{bytes(d.notInUse, 0)} of your {bytes(d.size, 0)} drive isn’t in use yet</b>
			<span>
				{d.steps.includes('partition-not-last')
					? 'The drive got bigger, but the system’s partition isn’t the last one on it, so it can’t simply be grown. Use a partition tool (like GParted) from a live USB.'
					: 'The drive got bigger, but the system still uses its old size. Run these in a terminal once (growpart is in the cloud-guest-utils package; an encrypted drive asks for its password):'}
			</span>
			{!d.steps.includes('partition-not-last') && cmds.length > 0 && (
				<button
					className="unused-cmds"
					onClick={() => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Select the text to copy it', true))}
					title="Copy"
				>
					<code>{text}</code>
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
		<section className="glass card" style={{marginTop: 12}} aria-label="Storage pools">
			<div className="card-head">
				<strong>Storage pools</strong>
				<span>{pools.data.length} pool{pools.data.length > 1 ? 's' : ''}</span>
			</div>
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
		</section>
	)
}
