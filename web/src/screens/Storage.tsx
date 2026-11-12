// Settings → Storage: drives, the RAID pool, and USB drives, through the same umbreld calls
// umbrelOS's own Storage Manager uses (hardware.internalStorage / hardware.raid / files).
//
// What umbrelOS supports, and so what this page offers:
//  - Every Umbrel: list internal drives with health (SMART, temperature, SSD wear) and USB drives.
//  - With a storage pool (created during umbrelOS setup): add a drive, add a mirror pair, add an
//    SSD accelerator, replace a failed drive, turn one SSD into FailSafe, and check for errors.
//  - Without a pool: nothing to combine drives into. umbrelOS only creates pools during setup.
//    hardware.raid.setup exists but is dev-only, and on a running Umbrel the next boot would
//    mount the new, empty pool as your data drive, so this app never calls it.
import {useMemo, useState, type CSSProperties, type ReactNode} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query, type PoolMember, type RaidStatus, type StorageDevice, type UsbDrive} from '../api'
import {useBootstrap, useDisk} from '../data'
import {Icon} from '../icons'
import {Sheet, SheetHeader, bytes, haptic, useConfirm, useToast} from '../ui'

const tb = (n?: number) => (n === undefined ? '–' : bytes(n, n >= 1e12 ? 1 : 0))

export function deviceHealth(d: StorageDevice) {
	const ssd = d.type === 'ssd'
	const tempCritical = ssd && d.temperature !== undefined && d.temperatureCritical !== undefined && d.temperature >= d.temperatureCritical
	const tempWarning = !tempCritical && ssd && d.temperature !== undefined && d.temperatureWarning !== undefined && d.temperature >= d.temperatureWarning
	const lifeWarning = ssd && d.lifetimeUsed !== undefined && d.lifetimeUsed >= 80
	const smartUnhealthy = d.smartStatus === 'unhealthy'
	const issues = [smartUnhealthy && 'SMART reports a problem', tempCritical && 'Critically hot', tempWarning && 'Running hot', lifeWarning && `${d.lifetimeUsed}% of rated life used`].filter(Boolean) as string[]
	return {hasWarning: issues.length > 0, issues}
}

const STATE_LOOK: Record<string, {label: string; color: string}> = {
	ONLINE: {label: 'Healthy', color: 'var(--green)'},
	DEGRADED: {label: 'Degraded', color: 'var(--peach)'},
	FAULTED: {label: 'Failed', color: 'var(--red)'},
	OFFLINE: {label: 'Offline', color: 'var(--red)'},
	UNAVAIL: {label: 'Unavailable', color: 'var(--red)'},
	REMOVED: {label: 'Removed', color: 'var(--red)'},
	CANT_OPEN: {label: 'Unavailable', color: 'var(--red)'},
}

function modeLabel(r: RaidStatus) {
	if (r.raidType === 'failsafe') return r.topology === 'mirror' ? 'FailSafe · mirrored pairs' : 'FailSafe · RAID-Z'
	return 'Storage · combined capacity'
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

function DriveIcon({d, color}: {d: {type?: string}; color: string}) {
	return (
		<span className="row-ico" style={{'--c': color, width: 40, height: 40, borderRadius: 11} as CSSProperties}>
			<Icon name={d.type === 'hdd' ? 'disc' : d.type === 'usb' ? 'usb' : 'disk'} size={21} />
		</span>
	)
}

function DriveRow({d, member, onClick, action}: {d?: StorageDevice; member?: PoolMember; onClick?: () => void; action?: ReactNode}) {
	const health = d ? deviceHealth(d) : undefined
	const state = member ? STATE_LOOK[member.status] : undefined
	const missing = member && !d
	const bad = missing || (member && member.status !== 'ONLINE') || health?.hasWarning
	const color = bad ? (member && member.status !== 'ONLINE') || missing ? 'var(--red)' : 'var(--peach)' : d?.isSystemDrive ? '#8e8e93' : 'var(--blue)'
	const errors = member ? member.readErrors + member.writeErrors + member.checksumErrors : 0
	const sub = missing
		? `${member!.id} · not detected`
		: [d?.type === 'hdd' ? 'HDD' : 'SSD', d?.transport?.toUpperCase(), tb(d?.size), d?.temperature !== undefined ? `${d.temperature}°C` : null].filter(Boolean).join(' · ')
	const inner = (
		<>
			<DriveIcon d={d ?? {type: 'ssd'}} color={color} />
			<span className="main">
				<b style={{fontWeight: 580}}>{d?.name ?? 'Missing drive'}</b>
				<span>{sub}</span>
				{(state && member!.status !== 'ONLINE') || errors > 0 || health?.hasWarning ? (
					<span className="drive-warn">
						{[state && member!.status !== 'ONLINE' ? state.label : null, errors ? `${errors} error${errors > 1 ? 's' : ''}` : null, ...(health?.issues ?? [])].filter(Boolean).join(' · ')}
					</span>
				) : null}
			</span>
			{action ?? (onClick ? <Icon name="chevron" size={18} className="chev" /> : null)}
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

type Plan = {
	kind: 'add' | 'failsafe' | 'mirror' | 'accelerator' | 'replace'
	title: string
	body: string
	confirm: string
	path: string
	input: unknown
	drives: StorageDevice[]
	restarts?: boolean
}

export function StoragePage({onBack}: {onBack: () => void}) {
	const boot = useBootstrap()
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const disk = useDisk()
	const [detail, setDetail] = useState<{d?: StorageDevice; member?: PoolMember} | null>(null)
	const [picker, setPicker] = useState<{title: string; subtitle: string; options: StorageDevice[]; pick: (d: StorageDevice) => void} | null>(null)
	const [scanning, setScanning] = useState(false)
	const [busy, setBusy] = useState(false)

	const devicesQ = useQuery({queryKey: ['hardware.internalStorage.getDevices'], queryFn: () => query<StorageDevice[]>('hardware.internalStorage.getDevices'), refetchInterval: 15_000, retry: false})
	const raidQ = useQuery({queryKey: ['hardware.raid.getStatus'], queryFn: () => query<RaidStatus>('hardware.raid.getStatus'), refetchInterval: (q) => (busyPool(q.state.data) ? 3_000 : 15_000), retry: false})
	const usbQ = useQuery({queryKey: ['files.externalDevices'], queryFn: () => query<UsbDrive[]>('files.externalDevices'), refetchInterval: 15_000, retry: false})

	const devices = devicesQ.data ?? []
	const raid = raidQ.data
	const pool = raid?.exists ? raid : undefined
	const byId = useMemo(() => new Map(devices.filter((d) => d.id).map((d) => [d.id!, d])), [devices])
	const memberIds = new Set(pool?.devices?.map((m) => m.id) ?? [])
	const accelIds = new Set(pool?.accelerator?.devices?.map((m) => m.id) ?? [])
	const systemDrives = devices.filter((d) => d.isSystemDrive)
	const spare = devices.filter((d) => d.id && !d.isSystemDrive && !memberIds.has(d.id) && !accelIds.has(d.id))
	const poolType = pool?.devices?.map((m) => byId.get(m.id)?.type).find(Boolean)
	const spareSame = spare.filter((d) => d.type === poolType)
	const spareSsd = spare.filter((d) => d.type === 'ssd')
	const failed = (pool?.devices ?? []).filter((m) => m.status !== 'ONLINE' || !byId.has(m.id))
	const op = activeOperation(pool)
	const canChange = !!pool && !op && !busy && (pool.status === 'ONLINE' || pool.status === 'DEGRADED')
	const configuredButMissing = !!raid?.name && !raid.exists
	const unsupported = devicesQ.error && /not found|No "query"|procedure/i.test((devicesQ.error as Error).message)

	const refresh = () => {
		qc.invalidateQueries({queryKey: ['hardware.internalStorage.getDevices']})
		qc.invalidateQueries({queryKey: ['hardware.raid.getStatus']})
		qc.invalidateQueries({queryKey: ['files.externalDevices']})
	}
	const scan = async () => {
		haptic(8)
		setScanning(true)
		const before = new Set(devices.map((d) => d.id ?? d.device))
		try {
			const [fresh, usb] = await Promise.all([
				qc.fetchQuery({queryKey: ['hardware.internalStorage.getDevices'], queryFn: () => query<StorageDevice[]>('hardware.internalStorage.getDevices'), staleTime: 0}),
				qc.fetchQuery({queryKey: ['files.externalDevices'], queryFn: () => query<UsbDrive[]>('files.externalDevices'), staleTime: 0}).catch(() => [] as UsbDrive[]),
				qc.fetchQuery({queryKey: ['hardware.raid.getStatus'], queryFn: () => query<RaidStatus>('hardware.raid.getStatus'), staleTime: 0}).catch(() => undefined),
			])
			const added = fresh.filter((d) => !before.has(d.id ?? d.device)).length
			const unused = fresh.filter((d) => d.id && !d.isSystemDrive && !memberIds.has(d.id) && !accelIds.has(d.id)).length
			toast(
				`${fresh.length} internal drive${fresh.length === 1 ? '' : 's'}${usb.length ? `, ${usb.length} USB` : ''}${added ? ` · ${added} new` : ''} · ${unused} not in use`,
			)
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setScanning(false)
		}
	}

	const run = async (plan: Plan) => {
		const names = plan.drives.map((d) => `${d.name} (${tb(d.size)}, ${d.serial})`).join(' and ')
		const ok = await confirm({
			title: plan.title,
			body: `${plan.body} Everything on ${names} will be erased.${plan.restarts ? ' Your Umbrel restarts during this.' : ''} Keep it powered on until it finishes.`,
			confirm: plan.confirm,
			danger: true,
			icon: 'disk',
		})
		if (!ok) return
		setBusy(true)
		try {
			await mutate(plan.path, plan.input)
			toast(plan.kind === 'replace' ? 'Rebuilding onto the new drive' : plan.kind === 'failsafe' ? 'Turning on FailSafe' : 'Adding to your storage')
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(false)
			setDetail(null)
			setPicker(null)
			refresh()
		}
	}

	// ---- actions offered for a spare drive, following umbrelOS's own rules ----
	const actionsFor = (d: StorageDevice): {label: string; plan?: Plan; pickSecond?: () => void; note?: string}[] => {
		if (!pool || !d.id) return []
		if (!canChange) return [{label: '', note: op ? `Wait for ${op.label.toLowerCase()} to finish.` : 'Your storage needs attention before drives can be added.'}]
		const out: {label: string; plan?: Plan; pickSecond?: () => void; note?: string}[] = []
		const memberSize = Math.min(...(pool.devices ?? []).map((m) => byId.get(m.id)?.roundedSize ?? byId.get(m.id)?.size ?? Infinity))
		if (d.type === poolType) {
			if (pool.raidType === 'storage' && poolType === 'ssd' && pool.devices?.length === 1)
				out.push({
					label: 'Turn on FailSafe with this drive',
					plan: {
						kind: 'failsafe',
						title: `Turn on FailSafe with ${d.name}?`,
						body: 'Your data is copied so it survives one drive failing. You keep the capacity of one drive.',
						confirm: 'Turn on FailSafe',
						path: 'hardware.raid.transitionToFailsafeRaidz',
						input: {newDeviceId: d.id},
						drives: [d],
						restarts: true,
					},
				})
			if (pool.topology === 'mirror') {
				const partners = spareSame.filter((x) => x.id !== d.id)
				out.push(
					partners.length
						? {
								label: 'Add as a mirrored pair…',
								pickSecond: () =>
									setPicker({
										title: 'Pick its mirror',
										subtitle: `${d.name} is paired with a second drive. Each pair adds one drive of space.`,
										options: partners,
										pick: (p) =>
											run({
												kind: 'mirror',
												title: 'Add this mirrored pair?',
												body: `${d.name} and ${p.name} are added as a pair, so either can fail without losing data.`,
												confirm: 'Add pair',
												path: 'hardware.raid.addMirror',
												input: {deviceIds: [d.id!, p.id!]},
												drives: [d, p],
											}),
									}),
							}
						: {label: '', note: 'Mirrored storage adds drives in pairs. Connect a second drive of this kind.'},
				)
			} else {
				out.push({
					label: pool.raidType === 'failsafe' ? 'Add to FailSafe storage' : 'Add to storage',
					plan: {
						kind: 'add',
						title: `Add ${d.name} to your storage?`,
						body:
							pool.raidType === 'failsafe'
								? `The pool expands onto this drive. ${d.roundedSize && d.roundedSize > memberSize ? 'Only as much space as your smallest drive is used. ' : ''}Expansion can take many hours; your Umbrel keeps working meanwhile.`
								: 'Your capacity grows by this drive. In Storage mode, if any drive fails, the data on all of them is lost.',
						confirm: 'Add drive',
						path: 'hardware.raid.addDevice',
						input: {deviceId: d.id},
						drives: [d],
					},
				})
			}
		}
		if (d.type === 'ssd' && poolType === 'hdd' && !pool.accelerator?.exists) {
			const need = pool.raidType === 'failsafe' ? 2 : 1
			const others = spareSsd.filter((x) => x.id !== d.id)
			if (need === 1)
				out.push({
					label: 'Use to speed up HDD storage',
					plan: {
						kind: 'accelerator',
						title: `Use ${d.name} as an accelerator?`,
						body: 'The SSD caches reads and stores small files and metadata, which speeds up your hard drives.',
						confirm: 'Add accelerator',
						path: 'hardware.raid.addAccelerator',
						input: {deviceIds: [d.id]},
						drives: [d],
					},
				})
			else
				out.push(
					others.length
						? {
								label: 'Use to speed up HDD storage…',
								pickSecond: () =>
									setPicker({
										title: 'Pick a second SSD',
										subtitle: 'FailSafe storage uses two SSDs for acceleration, so it survives one failing.',
										options: others,
										pick: (p) =>
											run({
												kind: 'accelerator',
												title: 'Add these SSDs as an accelerator?',
												body: 'They cache reads and store small files and metadata, which speeds up your hard drives.',
												confirm: 'Add accelerator',
												path: 'hardware.raid.addAccelerator',
												input: {deviceIds: [d.id!, p.id!]},
												drives: [d, p],
											}),
									}),
							}
						: {label: '', note: 'FailSafe needs two SSDs to accelerate hard drives.'},
				)
		}
		if (!out.length)
			out.push({
				label: '',
				note:
					d.type === 'hdd' && poolType === 'ssd'
						? 'Your storage uses SSDs, so hard drives can’t join it.'
						: d.type === 'ssd' && poolType === 'hdd' && pool.accelerator?.exists
							? 'SSD acceleration is already on.'
							: 'This drive can’t be added to your storage.',
			})
		return out
	}

	const replaceFor = (m: PoolMember) => {
		const own = byId.get(m.id)
		const need = own?.roundedSize ?? own?.size ?? Math.min(...(pool?.devices ?? []).map((x) => byId.get(x.id)?.roundedSize ?? Infinity))
		const fits = spare.filter((d) => d.type === (own?.type ?? poolType) && (d.roundedSize ?? d.size) >= (Number.isFinite(need) ? need : 0))
		return {fits, start: (n: StorageDevice) => run({
			kind: 'replace',
			title: `Replace ${own?.name ?? 'the failed drive'}?`,
			body: `Your data is rebuilt onto ${n.name}. Rebuilding can take hours; your Umbrel keeps working meanwhile.`,
			confirm: 'Replace drive',
			path: 'hardware.raid.replaceDevice',
			input: {oldDevice: m.id, newDevice: n.id},
			drives: [n],
		})}
	}

	const scrub = async () => {
		if (!(await confirm({title: 'Check your storage for errors?', body: 'umbrelOS reads every block and repairs what it can. It runs in the background and can take hours.', confirm: 'Start check', icon: 'shield'}))) return
		try {
			await mutate('hardware.raid.scrub')
			toast('Checking your storage')
		} catch (e) {
			toast((e as Error).message, true)
		}
		refresh()
	}

	const used = pool ? (pool.usedSpace ?? 0) / Math.max(1, (pool.usableSpace ?? 0) - (pool.accelerator?.specialSize ?? 0)) : disk.data ? disk.data.totalUsed / disk.data.size : 0
	const look = pool?.status ? STATE_LOOK[pool.status] : undefined

	return (
		<div className="stagger">
			<div className="page-head" style={{margin: '6px 0 14px'}}>
				<button className="round-btn" aria-label="Back" onClick={onBack}>
					<Icon name="back" size={20} />
				</button>
				<h1 className="title" style={{flex: 1}}>
					Storage
				</h1>
				<button className="btn scan-btn" onClick={scan} disabled={scanning}>
					{scanning ? <span className="spinner" /> : <Icon name="search" size={17} />}
					{scanning ? 'Scanning' : 'Scan drives'}
				</button>
			</div>

			{unsupported ? (
				<div className="glass card">
					<b>This umbrelOS doesn’t report drives</b>
					<p className="muted" style={{margin: '6px 0 0', fontSize: 14}}>
						Drive and RAID management arrived in umbrelOS 2.0. Update umbrelOS to manage drives here.
					</p>
				</div>
			) : (
				<>
					{/* Summary */}
					<div className="glass card storage-hero">
						<div className="hero-top">
							<span className="row-ico" style={{'--c': look?.color ?? 'var(--blue)', width: 46, height: 46, borderRadius: 14} as CSSProperties}>
								<Icon name={pool ? 'shield' : 'disk'} size={24} />
							</span>
							<span style={{flex: 1, minWidth: 0}}>
								<b className="hero-title">{pool ? modeLabel(pool) : raidQ.isLoading ? 'Loading…' : 'Single drive'}</b>
								<span className="muted" style={{fontSize: 13.5}}>
									{pool
										? `${pool.devices?.length ?? 0} drive${pool.devices?.length === 1 ? '' : 's'}${pool.accelerator?.exists ? ' + SSD acceleration' : ''}`
										: (systemDrives[0]?.name ?? boot.umbrel?.device ?? 'Boot drive')}
								</span>
							</span>
							{look && (
								<span className="pill" style={{'--c': look.color} as CSSProperties}>
									<i />
									{look.label}
								</span>
							)}
						</div>
						<span className="progress" style={{height: 8, marginTop: 14, display: 'block'}}>
							<i style={{width: `${Math.min(100, used * 100)}%`, background: used > 0.9 ? 'var(--red)' : used > 0.75 ? 'var(--yellow)' : 'var(--accent-text)'}} />
						</span>
						<div className="hero-nums">
							<span>
								<b>{pool ? tb(pool.usedSpace) : tb(disk.data?.totalUsed)}</b> used
							</span>
							<span>
								<b>{pool ? tb(Math.max(0, (pool.usableSpace ?? 0) - (pool.accelerator?.specialSize ?? 0))) : tb(disk.data?.size)}</b> total
							</span>
						</div>
						{op && (
							<div className="op-box">
								<span style={{display: 'flex', justifyContent: 'space-between', fontSize: 13.5}}>
									<b style={{fontWeight: 600}}>{op.label}</b>
									<span className="num muted">{Math.round(op.progress)}%</span>
								</span>
								<span className="progress" style={{display: 'block', marginTop: 7}}>
									<i style={{width: `${Math.max(2, op.progress)}%`}} />
								</span>
								<span className="muted" style={{fontSize: 12.5, display: 'block', marginTop: 6}}>
									{op.hint}
								</span>
							</div>
						)}
						{(pool?.dataErrors ?? 0) > 0 && (
							<div className="error" style={{marginTop: 12}}>
								<Icon name="alert" size={18} />
								{pool!.dataErrors} file{pool!.dataErrors === 1 ? ' has' : 's have'} damaged data. Restore them from a backup.
							</div>
						)}
						{configuredButMissing && (
							<div className="error" style={{marginTop: 12}}>
								<Icon name="alert" size={18} />
								umbrelOS is set up for a storage pool it can’t find. Check that every drive is connected, then restart.
							</div>
						)}
					</div>

					{pool && (
						<Section
							title="In your storage"
							footer={
								pool.scrub
									? pool.scrub.state === 'scrubbing'
										? undefined
										: `Last error check ${pool.scrub.state === 'finished' ? 'finished' : 'stopped'}${pool.scrub.errors ? ` and repaired ${pool.scrub.errors} error${pool.scrub.errors > 1 ? 's' : ''}` : ' with no errors'}. umbrelOS checks automatically every month.`
									: 'umbrelOS checks your storage for errors automatically every month.'
							}
						>
							{(pool.topology === 'mirror' && pool.mirrors?.length ? pool.mirrors.flat() : (pool.devices ?? []).map((m) => m.id)).map((id) => {
								const m = pool.devices?.find((x) => x.id === id) ?? {id, status: 'UNAVAIL' as const, readErrors: 0, writeErrors: 0, checksumErrors: 0}
								return <DriveRow key={id} d={byId.get(id)} member={m} onClick={() => setDetail({d: byId.get(id), member: m})} />
							})}
							{(pool.accelerator?.devices ?? []).map((m) => (
								<DriveRow key={`a-${m.id}`} d={byId.get(m.id)} member={m} onClick={() => setDetail({d: byId.get(m.id), member: m})} />
							))}
							<button className="row" onClick={scrub} disabled={!canChange} style={{minHeight: 56}}>
								<span className="row-ico" style={{'--c': 'var(--green)'} as CSSProperties}>
									<Icon name="shield" size={19} />
								</span>
								<span className="main">
									<b style={{fontWeight: 550}}>Check for errors now</b>
								</span>
								<Icon name="chevron" size={18} className="chev" />
							</button>
						</Section>
					)}

					{failed.length > 0 && pool && (
						<div className="glass card replace-card">
							<b>
								<Icon name="alert" size={18} /> {failed.length === 1 ? 'A drive has failed' : `${failed.length} drives have failed`}
							</b>
							<p>
								{pool.raidType === 'failsafe'
									? 'FailSafe is keeping your data available. Replace the drive soon so you’re protected again.'
									: 'In Storage mode a failed drive can mean lost data. Replace it as soon as you can.'}
							</p>
							{failed.map((m) => {
								const r = replaceFor(m)
								return (
									<button
										key={m.id}
										className="btn primary block"
										disabled={!r.fits.length || !!op || busy}
										onClick={() =>
											r.fits.length === 1
												? r.start(r.fits[0])
												: setPicker({title: 'Replace with…', subtitle: 'Pick a drive at least as large as the one it replaces.', options: r.fits, pick: r.start})
										}
									>
										{r.fits.length ? `Replace ${byId.get(m.id)?.name ?? 'missing drive'}` : 'Connect a replacement drive, then scan'}
									</button>
								)
							})}
						</div>
					)}

					<Section
						title={pool ? 'Not in use' : 'Other drives'}
						right={devicesQ.isFetching ? <span className="spinner" style={{width: 14, height: 14}} /> : undefined}
						footer={
							!pool && spare.length > 0
								? 'Your Umbrel uses a single-drive setup, which can’t add drives. umbrelOS only combines drives into RAID during setup: back up, reinstall umbrelOS on a separate boot drive with these drives connected, choose them during setup, then restore your backup.'
								: spare.length === 0
									? 'No unused internal drives. Connect a drive, then tap Scan drives.'
									: undefined
						}
					>
						{spare.map((d) => (
							<DriveRow key={d.id ?? d.device} d={d} onClick={() => setDetail({d})} action={pool && actionsFor(d).some((a) => a.label) ? <span className="add-tag">Add</span> : undefined} />
						))}
						{spare.length === 0 && <div className="row static muted" style={{minHeight: 52}}>None found</div>}
					</Section>

					{systemDrives.length > 0 && (
						<Section title="Boot drive" footer="umbrelOS runs from this drive. It’s never offered for storage.">
							{systemDrives.map((d) => (
								<DriveRow key={d.id ?? d.device} d={d} onClick={() => setDetail({d})} />
							))}
						</Section>
					)}

					{(usbQ.data?.length ?? 0) > 0 && (
						<Section title="USB drives" footer="USB drives appear in Files under External. They can’t join your storage.">
							{usbQ.data!.map((u) => (
								<UsbRow key={u.id} u={u} onEjected={refresh} />
							))}
						</Section>
					)}

					<p className="footer-note storage-note">
						Running umbrelOS in a VM? umbrelOS only lists disks attached as SATA, NVMe or (umbrelOS 2.1) SAS. Disks attached as VirtIO don’t show up here; reattach them as SATA in your hypervisor, then scan.
					</p>
				</>
			)}

			{detail && (
				<DriveSheet
					d={detail.d}
					member={detail.member}
					onClose={() => setDetail(null)}
					actions={detail.d && !detail.member ? actionsFor(detail.d) : []}
					replace={detail.member && failed.some((m) => m.id === detail.member!.id) ? replaceFor(detail.member) : undefined}
					busy={busy || !!op}
					onPlan={run}
					onPickReplacement={(r) => (r.fits.length === 1 ? r.start(r.fits[0]) : setPicker({title: 'Replace with…', subtitle: 'Pick a drive at least as large as the one it replaces.', options: r.fits, pick: r.start}))}
				/>
			)}
			{picker && (
				<Sheet open onClose={() => setPicker(null)} label={picker.title}>
					<SheetHeader title={picker.title} subtitle={picker.subtitle} onClose={() => setPicker(null)} />
					<div className="glass group" style={{borderRadius: 18, '--inset': '66px'} as CSSProperties}>
						{picker.options.map((d) => (
							<DriveRow key={d.id} d={d} onClick={() => picker.pick(d)} />
						))}
					</div>
				</Sheet>
			)}
		</div>
	)
}

function busyPool(r?: RaidStatus) {
	return !!activeOperation(r)
}
function activeOperation(r?: RaidStatus): {label: string; progress: number; hint: string} | undefined {
	if (!r?.exists) return undefined
	const f = r.failsafeTransitionStatus
	if (f && f.state !== 'complete' && f.state !== 'error')
		return {label: f.state === 'rebooting' ? 'Restarting into FailSafe' : 'Turning on FailSafe', progress: f.progress, hint: 'Your Umbrel restarts during this. Keep it powered on.'}
	if (r.replace && (r.replace.state === 'rebuilding' || r.replace.state === 'expanding')) return {label: 'Rebuilding onto the new drive', progress: r.replace.progress, hint: 'Your Umbrel keeps working while this runs.'}
	if (r.rebuild?.state === 'rebuilding') return {label: 'Rebuilding', progress: r.rebuild.progress, hint: 'Your Umbrel keeps working while this runs.'}
	if (r.expansion?.state === 'expanding') return {label: 'Expanding onto the new drive', progress: r.expansion.progress, hint: 'This can take many hours. Your Umbrel keeps working meanwhile.'}
	if (r.scrub?.state === 'scrubbing') return {label: 'Checking for errors', progress: r.scrub.progress, hint: 'Reading every block and repairing what it can.'}
	return undefined
}

function UsbRow({u, onEjected}: {u: UsbDrive; onEjected: () => void}) {
	const toast = useToast()
	const confirm = useConfirm()
	const mounts = u.partitions.flatMap((p) => p.mountpoints)
	const eject = async () => {
		if (!(await confirm({title: `Eject ${u.name}?`, body: 'Files on it close. Unplug it once it’s ejected.', confirm: 'Eject', icon: 'usb'}))) return
		try {
			await mutate('files.unmountExternalDevice', {deviceId: u.id})
			toast(`${u.name} ejected`)
		} catch (e) {
			toast((e as Error).message, true)
		}
		onEjected()
	}
	return (
		<div className="row static drive-row">
			<DriveIcon d={{type: 'usb'}} color="var(--teal)" />
			<span className="main">
				<b style={{fontWeight: 580}}>{u.name}</b>
				<span>{[tb(u.size), mounts.join(', ') || 'Not mounted'].join(' · ')}</span>
			</span>
			<button className="btn get" onClick={eject}>
				Eject
			</button>
		</div>
	)
}

function DriveSheet({
	d,
	member,
	onClose,
	actions,
	replace,
	busy,
	onPlan,
	onPickReplacement,
}: {
	d?: StorageDevice
	member?: PoolMember
	onClose: () => void
	actions: {label: string; plan?: Plan; pickSecond?: () => void; note?: string}[]
	replace?: {fits: StorageDevice[]; start: (n: StorageDevice) => void}
	busy: boolean
	onPlan: (p: Plan) => void
	onPickReplacement: (r: {fits: StorageDevice[]; start: (n: StorageDevice) => void}) => void
}) {
	const health = d ? deviceHealth(d) : undefined
	const rows: [string, ReactNode][] = []
	if (member) rows.push(['Status', <span style={{color: STATE_LOOK[member.status]?.color}}>{STATE_LOOK[member.status]?.label ?? member.status}</span>])
	if (d) {
		rows.push(['Type', `${d.type === 'hdd' ? 'Hard drive' : 'SSD'} · ${d.transport.toUpperCase()}`])
		rows.push(['Capacity', tb(d.size)])
		rows.push(['Health', d.smartStatus === 'unhealthy' ? <span style={{color: 'var(--red)'}}>SMART reports a problem</span> : d.smartStatus === 'healthy' ? 'SMART OK' : 'Not reported'])
		if (d.temperature !== undefined) rows.push(['Temperature', `${d.temperature}°C${d.temperatureWarning ? ` (warns at ${d.temperatureWarning}°C)` : ''}`])
		if (d.lifetimeUsed !== undefined) rows.push(['Life remaining', `${Math.max(0, 100 - d.lifetimeUsed)}%`])
		rows.push(['Model', d.model])
		rows.push(['Serial', d.serial])
		rows.push(['Device', `/dev/${d.device}`])
	}
	if (member && member.readErrors + member.writeErrors + member.checksumErrors > 0) rows.push(['Errors', `${member.readErrors} read · ${member.writeErrors} write · ${member.checksumErrors} checksum`])
	return (
		<Sheet open onClose={onClose} label={d?.name ?? 'Drive'}>
			<SheetHeader
				icon={<DriveIcon d={d ?? {type: 'ssd'}} color={health?.hasWarning || (member && member.status !== 'ONLINE') ? 'var(--red)' : 'var(--blue)'} />}
				title={d?.name ?? 'Missing drive'}
				subtitle={d?.isSystemDrive ? 'Boot drive' : member ? 'In your storage' : 'Not in use'}
				onClose={onClose}
			/>
			{health?.hasWarning && (
				<div className="error" style={{marginBottom: 12}}>
					<Icon name="alert" size={18} />
					{health.issues.join(' · ')}. Back up and plan to replace this drive.
				</div>
			)}
			<div className="kv glass group" style={{borderRadius: 18}}>
				{rows.map(([k, v]) => (
					<div className="row static" key={k}>
						<span className="k">{k}</span>
						<span className="v">{v}</span>
					</div>
				))}
			</div>
			{replace && (
				<button className="btn primary block" style={{marginTop: 12}} disabled={busy || !replace.fits.length} onClick={() => onPickReplacement(replace)}>
					{replace.fits.length ? 'Replace this drive' : 'No suitable replacement connected'}
				</button>
			)}
			{actions.map((a, i) =>
				a.label ? (
					<button key={i} className={`btn ${i === 0 ? 'primary' : 'ghost'} block`} style={{marginTop: 10}} disabled={busy} onClick={() => (a.plan ? onPlan(a.plan) : a.pickSecond?.())}>
						{a.label}
					</button>
				) : (
					<p key={i} className="footer-note storage-note" style={{marginTop: 12}}>
						{a.note}
					</p>
				),
			)}
		</Sheet>
	)
}

