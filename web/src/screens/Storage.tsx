// Settings → Storage: Omarchy Server as a NAS. Drives and their health, Btrfs pools (new, imported,
// grown, checked for errors), and drive sleep. Pools appear in Files under Home → Pools, and any folder
// can be shared on the network from Files.
//
// Safety: pools are only ever created on blank drives. A drive that holds anything is shown with the
// one terminal command that erases it, so erasing data is always a deliberate step by a person.
import {useState, type CSSProperties, type ReactNode} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from '../api'
import {Icon} from '../icons'
import {KV, Segmented, Sheet, SheetHeader, bytes, haptic, useConfirm, useToast} from '../ui'

type Health = {passed: boolean | null; temperature: number | null; powerOnHours: number | null; lifetimeUsed: number | null; reallocated: number | null; pending: number | null}
export type Drive = {
	path: string
	name: string
	model: string | null
	serial: string | null
	size: number
	kind: 'hdd' | 'ssd' | 'nvme'
	transport: string | null
	removable: boolean
	role: 'system' | 'pool' | 'blank' | 'data'
	pool: string | null
	btrfs: {uuid: string; label: string | null; mounted: boolean} | null
	sleepMinutes: number | null
	health: Health | null
}
type Pool = {
	name: string
	uuid: string
	mountpoint: string
	folder: string
	mounted: boolean
	devices: string[]
	size: number | null
	free: number | null
	profile: string | null
	errors: number
	scrub: {state: string; errors: string; started: string | null} | null
}
type Importable = {uuid: string; label: string | null; devices: string[]}

const tb = (n?: number | null) => (n == null ? '–' : bytes(n, n >= 1e12 ? 1 : 0))
const PROFILE: Record<string, string> = {single: 'Combined · no copies', raid1: 'Mirrored · every file on 2 drives', raid10: 'RAID 10 · mirrored and striped', dup: 'Single drive'}
const KIND: Record<Drive['kind'], string> = {hdd: 'Hard drive', ssd: 'SSD', nvme: 'NVMe SSD'}

export function driveIssues(d: Drive): string[] {
	const h = d.health
	if (!h) return []
	return [
		h.passed === false && 'Health check failed',
		(h.reallocated ?? 0) > 0 && `${h.reallocated} reallocated sector${h.reallocated === 1 ? '' : 's'}`,
		(h.pending ?? 0) > 0 && `${h.pending} unreadable sector${h.pending === 1 ? '' : 's'}`,
		(h.lifetimeUsed ?? 0) >= 80 && `${h.lifetimeUsed}% of rated life used`,
		(h.temperature ?? 0) >= (d.kind === 'hdd' ? 55 : 70) && 'Running hot',
	].filter(Boolean) as string[]
}

function Section({title, children, footer, right}: {title: string; children: ReactNode; footer?: ReactNode; right?: ReactNode}) {
	return (
		<section>
			<div className="section-head">
				<h2>{title}</h2>
				{right}
			</div>
			<div className="glass group" style={{'--inset': '66px'} as CSSProperties}>
				{children}
			</div>
			{footer && <p className="footer-note storage-note">{footer}</p>}
		</section>
	)
}

function DriveRow({d, onClick, trailing}: {d: Drive; onClick?: () => void; trailing?: ReactNode}) {
	const issues = driveIssues(d)
	const color = issues.length ? 'var(--peach)' : d.role === 'system' ? '#8e8e93' : d.role === 'pool' ? 'var(--teal)' : 'var(--blue)'
	const role = d.role === 'system' ? 'System drive' : d.role === 'pool' ? `In pool “${d.pool}”` : d.role === 'blank' ? 'Blank, ready to use' : d.btrfs ? 'Btrfs, can be imported' : 'Has data'
	const inner = (
		<>
			<span className="row-ico" style={{'--c': color, width: 40, height: 40, borderRadius: 11} as CSSProperties}>
				<Icon name={d.removable ? 'usb' : d.kind === 'hdd' ? 'disc' : 'disk'} size={21} />
			</span>
			<span className="main">
				<b style={{fontWeight: 580}}>{d.model ?? d.name}</b>
				<span>{[KIND[d.kind], tb(d.size), d.health?.temperature != null ? `${d.health.temperature}°C` : null, role].filter(Boolean).join(' · ')}</span>
				{issues.length > 0 && <span className="drive-warn">{issues.join(' · ')}</span>}
			</span>
			{trailing ?? (onClick ? <Icon name="chevron" size={18} className="chev" /> : null)}
		</>
	)
	return onClick ? (
		<button className="row drive-row" onClick={onClick}>
			{inner}
		</button>
	) : (
		<div className="row static drive-row">{inner}</div>
	)
}

export function StoragePage({onBack}: {onBack: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const [drive, setDrive] = useState<Drive | null>(null)
	const [creating, setCreating] = useState(false)
	const [adding, setAdding] = useState<Pool | null>(null)
	const [importing, setImporting] = useState<Importable | null>(null)
	const [busy, setBusy] = useState(false)

	const status = useQuery({queryKey: ['storage.status'], queryFn: () => query<{helperAvailable: boolean}>('storage.status')})
	const disksQ = useQuery({queryKey: ['storage.disks'], queryFn: () => query<Drive[]>('storage.disks'), refetchInterval: 30_000})
	const poolsQ = useQuery({queryKey: ['storage.pools'], queryFn: () => query<Pool[]>('storage.pools'), refetchInterval: 10_000})
	const importQ = useQuery({queryKey: ['storage.importable'], queryFn: () => query<Importable[]>('storage.importable')})
	const drives = disksQ.data ?? []
	const pools = poolsQ.data ?? []
	const blank = drives.filter((d) => d.role === 'blank')
	const ready = status.data?.helperAvailable

	const refresh = () => {
		for (const k of ['storage.disks', 'storage.pools', 'storage.importable', 'system.diskUsage']) qc.invalidateQueries({queryKey: [k]})
	}
	const act = async (path: string, input: unknown, done: string) => {
		setBusy(true)
		try {
			await mutate(path, input)
			toast(done)
			refresh()
			return true
		} catch (e) {
			toast((e as Error).message, true)
			return false
		} finally {
			setBusy(false)
		}
	}
	const scrub = async (p: Pool) => {
		if (await confirm({title: `Check “${p.name}” for errors?`, body: 'Every block is read and, where there’s a good copy, repaired. It runs in the background and can take hours on big drives. You can keep using the pool.', confirm: 'Start check', icon: 'shield'}))
			act('storage.scrub', {name: p.name}, 'Error check started')
	}
	const forget = async (p: Pool) => {
		if (await confirm({title: `Remove “${p.name}” from Omarchy Server?`, body: 'The pool is unmounted and no longer mounted at startup. Nothing on its drives is erased, and you can import it again later. Stop apps and shares that use it first.', confirm: 'Remove', danger: true}))
			act('storage.forgetPool', {name: p.name}, `${p.name} removed`)
	}

	return (
		<div className="stagger">
			<div className="page-head" style={{margin: '6px 0 14px'}}>
				<button className="round-btn" aria-label="Back" onClick={onBack}>
					<Icon name="back" size={20} />
				</button>
				<h1 className="title" style={{flex: 1}}>
					Storage
				</h1>
				<button className="btn scan-btn" onClick={() => (haptic(6), refresh())}>
					<Icon name="restart" size={17} />
					Refresh
				</button>
			</div>

			{ready === false && (
				<div className="glass card" style={{marginBottom: 18}}>
					<b>Storage tools aren’t set up</b>
					<p className="muted" style={{margin: '6px 0 0', fontSize: 14}}>
						Run the Omarchy Server installer again on the server. It adds the small helper that manages drives, pools and network shares, then come back here.
					</p>
				</div>
			)}

			<Section
				title="Pools"
				right={
					<button className="link-btn" onClick={() => setCreating(true)} disabled={!ready || !blank.length}>
						New pool
					</button>
				}
				footer={
					pools.length
						? 'Pools are in Files under Home → Pools. Share any folder in them from Files.'
						: blank.length
							? 'A pool turns one or more blank drives into space for your files, mirrored if you like. It shows up in Files under Home → Pools.'
							: 'Connect a blank drive to make a pool. Drives that already hold data are listed below with how to free them.'
				}
			>
				{poolsQ.isLoading ? (
					<div className="row static muted">Loading…</div>
				) : pools.length === 0 ? (
					<div className="row static muted">No pools yet</div>
				) : (
					pools.map((p) => {
						const used = p.size && p.free != null ? (p.size - p.free) / p.size : 0
						const warn = !p.mounted || p.errors > 0 || (p.scrub?.errors ?? '') !== ''
						return (
							<div key={p.uuid} className="row static pool-row" style={{display: 'block', paddingBlock: 14}}>
								<div style={{display: 'flex', alignItems: 'center', gap: 12}}>
									<span className="row-ico" style={{'--c': warn ? 'var(--peach)' : 'var(--teal)', width: 40, height: 40, borderRadius: 11} as CSSProperties}>
										<Icon name="shield" size={21} />
									</span>
									<span className="main" style={{flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column'}}>
										<b style={{fontWeight: 600}}>{p.name}</b>
										<span className="muted" style={{fontSize: 13}}>
											{p.mounted ? `${PROFILE[p.profile ?? ''] ?? 'Btrfs'} · ${p.devices.length} drive${p.devices.length === 1 ? '' : 's'}` : 'Not mounted. Check its drives are connected, then restart.'}
										</span>
									</span>
								</div>
								{p.mounted && (
									<>
										<span className="progress" style={{height: 7, marginTop: 12, display: 'block'}}>
											<i style={{width: `${Math.min(100, used * 100)}%`, background: used > 0.9 ? 'var(--red)' : used > 0.75 ? 'var(--yellow)' : 'var(--accent-text)'}} />
										</span>
										<div className="hero-nums" style={{marginTop: 6}}>
											<span>
												<b>{tb(p.size && p.free != null ? p.size - p.free : null)}</b> used
											</span>
											<span>
												<b>{tb(p.free)}</b> free
											</span>
										</div>
										<p className="muted" style={{fontSize: 12.5, margin: '8px 0 0'}}>
											{p.errors > 0
												? `${p.errors} drive error${p.errors === 1 ? '' : 's'} recorded. Run an error check and look at the drives’ health.`
												: p.scrub?.state === 'running'
													? 'Checking for errors now…'
													: p.scrub?.errors
														? `Last check: ${p.scrub.errors}`
														: p.scrub?.started
															? `Last checked ${new Date(p.scrub.started).toLocaleDateString()}, no errors`
															: 'Never checked for errors'}
										</p>
										<div style={{display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap'}}>
											<button className="btn small" disabled={busy || p.scrub?.state === 'running'} onClick={() => scrub(p)}>
												<Icon name="shield" size={16} /> Check for errors
											</button>
											<button className="btn small" disabled={busy || !blank.length} onClick={() => setAdding(p)}>
												<Icon name="plus" size={16} /> Add a drive
											</button>
											<button className="btn small" disabled={busy} onClick={() => forget(p)}>
												Remove
											</button>
										</div>
									</>
								)}
							</div>
						)
					})
				)}
			</Section>

			{(importQ.data ?? []).length > 0 && (
				<Section title="Existing pools found" footer="These drives already hold a Btrfs filesystem. Importing mounts it as a pool without changing anything on it.">
					{importQ.data!.map((i) => (
						<div key={i.uuid} className="row static">
							<span className="row-ico" style={{'--c': 'var(--blue)', width: 40, height: 40, borderRadius: 11} as CSSProperties}>
								<Icon name="download" size={20} />
							</span>
							<span className="main">
								<b style={{fontWeight: 580}}>{i.label ?? 'Unnamed filesystem'}</b>
								<span>{i.devices.join(', ')}</span>
							</span>
							<button className="btn small" disabled={!ready} onClick={() => setImporting(i)}>
								Import
							</button>
						</div>
					))}
				</Section>
			)}

			<Section title="Drives" footer={drives.some((d) => d.role === 'data' && !d.btrfs) ? 'A drive that has data can’t be used for a pool until it’s erased. Open it to see how.' : undefined}>
				{disksQ.isLoading ? <div className="row static muted">Loading…</div> : drives.map((d) => <DriveRow key={d.path} d={d} onClick={() => setDrive(d)} />)}
			</Section>

			<DriveSheet d={drive} onClose={() => setDrive(null)} onChanged={refresh} />
			{creating && <NewPool drives={blank} taken={pools.map((p) => p.name)} onClose={() => setCreating(false)} onDone={refresh} />}
			{adding && <AddDrive pool={adding} drives={blank} onClose={() => setAdding(null)} onDone={refresh} />}
			{importing && <ImportPool fs={importing} taken={pools.map((p) => p.name)} onClose={() => setImporting(null)} onDone={refresh} />}
		</div>
	)
}

const SLEEP = [
	{id: '0', label: 'Never'},
	{id: '20', label: '20 min'},
	{id: '60', label: '1 hr'},
	{id: '240', label: '4 hr'},
] as const

function DriveSheet({d, onClose, onChanged}: {d: Drive | null; onClose: () => void; onChanged: () => void}) {
	const toast = useToast()
	const [sleep, setSleep] = useState<string | null>(null)
	const h = d?.health
	const issues = d ? driveIssues(d) : []
	const current = sleep ?? String(d?.sleepMinutes ?? 0)
	const setSleepTo = async (v: string) => {
		if (!d) return
		setSleep(v)
		try {
			await mutate('storage.setSleep', {device: d.path, minutes: Number(v)})
			toast(v === '0' ? 'This drive won’t sleep' : 'Sleep time saved')
			onChanged()
		} catch (e) {
			setSleep(null)
			toast((e as Error).message, true)
		}
	}
	return (
		<Sheet open={!!d} onClose={() => (setSleep(null), onClose())} label="Drive">
			{d && (
				<>
					<SheetHeader title={d.model ?? d.name} subtitle={`${KIND[d.kind]} · ${tb(d.size)} · ${d.path}`} onClose={() => (setSleep(null), onClose())} />
					{issues.length > 0 && (
						<div className="error" style={{marginBottom: 14}}>
							<Icon name="alert" size={18} />
							{issues.join(' · ')}. Back up what’s on it.
						</div>
					)}
					<KV
						rows={[
							['Health', h ? (h.passed === false ? 'Failed' : issues.length ? 'Needs attention' : h.passed ? 'Good' : 'Unknown') : 'Not available'],
							...(h?.temperature != null ? ([['Temperature', `${h.temperature}°C`]] as [string, ReactNode][]) : []),
							...(h?.powerOnHours != null ? ([['Powered on', `${Math.round(h.powerOnHours / 24).toLocaleString()} days`]] as [string, ReactNode][]) : []),
							...(h?.lifetimeUsed != null ? ([['Life used', `${h.lifetimeUsed}%`]] as [string, ReactNode][]) : []),
							['Serial', d.serial ?? '–'],
							['Used for', d.role === 'system' ? 'Omarchy (system)' : d.role === 'pool' ? `Pool “${d.pool}”` : d.role === 'blank' ? 'Nothing yet' : d.btrfs ? 'A Btrfs filesystem' : 'Existing data'],
						]}
					/>
					{d.kind === 'hdd' && d.role !== 'system' && (
						<div style={{marginTop: 18}}>
							<b style={{fontSize: 14}}>Sleep when idle</b>
							<p className="muted" style={{fontSize: 13, margin: '4px 0 10px'}}>
								Spins the drive down after this long without use. Saves power and noise; the first file you open afterwards takes a few seconds.
							</p>
							<Segmented label="Sleep when idle" value={(SLEEP.some((s) => s.id === current) ? current : '0') as (typeof SLEEP)[number]['id']} options={[...SLEEP]} onChange={setSleepTo} />
						</div>
					)}
					{d.role === 'data' && !d.btrfs && (
						<div className="glass card" style={{marginTop: 18}}>
							<b style={{fontSize: 14}}>Use this drive for a pool</b>
							<p className="muted" style={{fontSize: 13, margin: '6px 0 8px'}}>
								It has data on it. Omarchy Server never erases a drive by itself. If you’re sure nothing on it is needed, erase it in a terminal on the server:
							</p>
							<code className="mono" style={{display: 'block', fontSize: 13, userSelect: 'all'}}>
								sudo wipefs -a {d.path}
							</code>
						</div>
					)}
				</>
			)}
		</Sheet>
	)
}

function NewPool({drives, taken, onClose, onDone}: {drives: Drive[]; taken: string[]; onClose: () => void; onDone: () => void}) {
	const toast = useToast()
	const confirm = useConfirm()
	const [name, setName] = useState(taken.includes('storage') ? '' : 'storage')
	const [picked, setPicked] = useState<string[]>(drives.length === 1 ? [drives[0].path] : [])
	const [profile, setProfile] = useState<'single' | 'raid1' | 'raid10'>('raid1') // mirrored whenever there are 2+ drives
	const [busy, setBusy] = useState(false)
	const sel = drives.filter((d) => picked.includes(d.path))
	const total = sel.reduce((n, d) => n + d.size, 0)
	const effective = profile === 'single' ? 'single' : profile === 'raid1' && sel.length < 2 ? 'single' : profile === 'raid10' && sel.length < 4 ? (sel.length >= 2 ? 'raid1' : 'single') : profile
	const usable = effective === 'single' ? total : effective === 'raid1' ? Math.min(total / 2, total - Math.max(0, ...sel.map((d) => d.size))) : total / 2
	const nameOk = /^[a-z][a-z0-9-]{0,31}$/.test(name) && !taken.includes(name)
	const options = [
		{id: 'single' as const, label: 'Combined'},
		...(sel.length >= 2 ? [{id: 'raid1' as const, label: 'Mirrored'}] : []),
		...(sel.length >= 4 ? [{id: 'raid10' as const, label: 'RAID 10'}] : []),
	]
	const create = async () => {
		const list = sel.map((d) => `${d.model ?? d.name} (${tb(d.size)})`).join(', ')
		if (!(await confirm({title: `Create pool “${name}”?`, body: `${list} will be formatted for the pool. They’re blank now, so nothing is lost.`, confirm: 'Create pool', icon: 'shield'}))) return
		setBusy(true)
		try {
			await mutate('storage.createPool', {name, profile: effective, devices: sel.map((d) => d.path)})
			toast(`Pool ${name} is ready in Files → Home → Pools`)
			onDone()
			onClose()
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet open onClose={onClose} label="New pool">
			<SheetHeader title="New pool" subtitle="Blank drives become one place for your files" onClose={onClose} />
			<label className="field-label" htmlFor="pool-name">
				Name
			</label>
			<input id="pool-name" className="field" style={{width: '100%'}} value={name} autoCapitalize="none" autoCorrect="off" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32))} placeholder="storage" />
			{name && !nameOk && <p className="muted" style={{fontSize: 12.5}}>{taken.includes(name) ? 'That name is taken.' : 'Start with a letter; use a-z, 0-9 and -.'}</p>}
			<div className="section-head" style={{marginTop: 16}}>
				<h2>Drives</h2>
			</div>
			<div className="glass group" style={{'--inset': '66px'} as CSSProperties}>
				{drives.map((d) => (
					<DriveRow
						key={d.path}
						d={d}
						onClick={() => setPicked((p) => (p.includes(d.path) ? p.filter((x) => x !== d.path) : [...p, d.path]))}
						trailing={<Icon name={picked.includes(d.path) ? 'checked' : 'unchecked'} size={22} />}
					/>
				))}
			</div>
			{sel.length > 0 && (
				<>
					<div style={{marginTop: 16}}>
						<Segmented label="Layout" value={effective} options={options} onChange={setProfile} />
					</div>
					<p className="muted" style={{fontSize: 13, marginTop: 10}}>
						{effective === 'single'
							? sel.length > 1
								? 'All drives’ space combined. If one drive fails, files on it are lost: keep backups.'
								: 'One drive. Keep backups of anything important.'
							: effective === 'raid1'
								? 'Every file is kept on two different drives, so the pool survives one drive failing.'
								: 'Mirrored pairs, striped for speed. Survives one drive failing.'}{' '}
						About <b>{tb(usable)}</b> usable.
					</p>
				</>
			)}
			<button className="btn primary block" style={{marginTop: 16}} disabled={busy || !nameOk || !sel.length} onClick={create}>
				{busy ? <span className="spinner" /> : null}
				{busy ? 'Creating…' : 'Create pool'}
			</button>
		</Sheet>
	)
}

function AddDrive({pool, drives, onClose, onDone}: {pool: Pool; drives: Drive[]; onClose: () => void; onDone: () => void}) {
	const toast = useToast()
	const confirm = useConfirm()
	const [busy, setBusy] = useState(false)
	const add = async (d: Drive) => {
		if (!(await confirm({title: `Add ${d.model ?? d.name} to “${pool.name}”?`, body: `It’s formatted into the pool, then your files are rebalanced across all drives in the background. That can take hours; the pool stays usable.`, confirm: 'Add drive', icon: 'plus'}))) return
		setBusy(true)
		try {
			await mutate('storage.addToPool', {name: pool.name, device: d.path})
			toast(`${d.model ?? d.name} added. Rebalancing in the background.`)
			onDone()
			onClose()
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet open onClose={onClose} label="Add a drive">
			<SheetHeader title={`Add a drive to ${pool.name}`} subtitle="Blank drives only" onClose={onClose} />
			<div className="glass group" style={{'--inset': '66px'} as CSSProperties}>
				{drives.map((d) => (
					<DriveRow key={d.path} d={d} onClick={busy ? undefined : () => add(d)} />
				))}
			</div>
		</Sheet>
	)
}

function ImportPool({fs, taken, onClose, onDone}: {fs: Importable; taken: string[]; onClose: () => void; onDone: () => void}) {
	const toast = useToast()
	const suggestion = (fs.label ?? 'imported').toLowerCase().replace(/^omarchy-/, '').replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 32) || 'imported'
	const [name, setName] = useState(taken.includes(suggestion) ? '' : suggestion)
	const [busy, setBusy] = useState(false)
	const ok = /^[a-z][a-z0-9-]{0,31}$/.test(name) && !taken.includes(name)
	const go = async () => {
		setBusy(true)
		try {
			await mutate('storage.importPool', {name, uuid: fs.uuid})
			toast(`Imported. It’s in Files → Home → Pools → ${name}`)
			onDone()
			onClose()
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet open onClose={onClose} label="Import pool">
			<SheetHeader title="Import pool" subtitle={fs.devices.join(', ')} onClose={onClose} />
			<p className="muted" style={{fontSize: 14, marginTop: 0}}>
				Mounts this existing Btrfs filesystem as a pool and at every startup. Nothing on it changes.
			</p>
			<label className="field-label" htmlFor="import-name">
				Name
			</label>
			<input id="import-name" className="field" style={{width: '100%'}} value={name} autoCapitalize="none" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32))} />
			<button className="btn primary block" style={{marginTop: 16}} disabled={busy || !ok} onClick={go}>
				{busy ? 'Importing…' : 'Import'}
			</button>
		</Sheet>
	)
}
