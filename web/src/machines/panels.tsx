// The settings of one machine, Proxmox-style, shared by the desktop (Machines window) and the touch
// layout (the machine sheet). Each panel edits in place: tap/click a row to change it.
import {useEffect, useMemo, useState, type ReactNode} from 'react'

import {useQuery} from '@tanstack/react-query'

import {query, type OsImage} from '../api'
import {Icon, type IconName} from '../icons'
import {bytes, duration, haptic, useConfirm} from '../ui'
import {
	BUS_LABEL,
	CACHE_LABEL,
	CPU_LABEL,
	NIC_LABEL,
	TASK_LABEL,
	VIDEO_LABEL,
	driveName,
	mib,
	rate,
	useBackups,
	useMachineAction,
	useNode,
	useStats,
	when,
	type Drive,
	type MachineDetails,
	type StatPoint,
	type Task,
} from './api'

export type PanelId = 'summary' | 'console' | 'hardware' | 'cloudinit' | 'options' | 'network' | 'snapshots' | 'backups' | 'history' | 'monitor'
export const PANELS: {id: PanelId; label: string; icon: IconName}[] = [
	{id: 'summary', label: 'Summary', icon: 'activity'},
	{id: 'console', label: 'Console', icon: 'terminal'},
	{id: 'hardware', label: 'Hardware', icon: 'cpu'},
	{id: 'cloudinit', label: 'Cloud-Init', icon: 'key'},
	{id: 'options', label: 'Options', icon: 'settings'},
	{id: 'network', label: 'Port forwarding', icon: 'networking'},
	{id: 'snapshots', label: 'Snapshots', icon: 'history'},
	{id: 'backups', label: 'Backup', icon: 'save'},
	{id: 'history', label: 'Task History', icon: 'list'},
	{id: 'monitor', label: 'Monitor', icon: 'logs'},
]

// ---- small building blocks --------------------------------------------------------------------
function Rows({children}: {children: ReactNode}) {
	return <div className="mx-rows">{children}</div>
}
function Row({icon, label, value, onClick, open, children, note}: {icon?: IconName; label: string; value: ReactNode; onClick?: () => void; open?: boolean; children?: ReactNode; note?: ReactNode}) {
	return (
		<div className={`mx-row${open ? ' open' : ''}`}>
			<button type="button" className="mx-row-head" onClick={onClick} disabled={!onClick} aria-expanded={onClick ? !!open : undefined}>
				{icon && <Icon name={icon} size={17} />}
				<span className="mx-k">{label}</span>
				<span className="mx-v">{value}</span>
				{onClick && <Icon name="chevron" size={15} className="mx-chev" />}
			</button>
			{note && !open && <div className="mx-note">{note}</div>}
			{open && <div className="mx-edit">{children}</div>}
		</div>
	)
}
function Field({label, hint, children}: {label: string; hint?: ReactNode; children: ReactNode}) {
	return (
		<label className="mx-field">
			<span>{label}</span>
			{children}
			{hint && <small>{hint}</small>}
		</label>
	)
}
function Toggle({label, note, on, onChange, disabled}: {label: string; note?: ReactNode; on: boolean; onChange: (v: boolean) => void; disabled?: boolean}) {
	return (
		<div className="mx-toggle">
			<span>
				<b>{label}</b>
				{note && <small>{note}</small>}
			</span>
			<button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} disabled={disabled} onClick={() => (haptic(5), onChange(!on))} />
		</div>
	)
}
function Actions({onCancel, onSave, saving, disabled, label = 'Save', danger}: {onCancel: () => void; onSave: () => void; saving?: boolean; disabled?: boolean; label?: string; danger?: boolean}) {
	return (
		<div className="mx-actions">
			<button type="button" className="btn small" onClick={onCancel}>
				Cancel
			</button>
			<button type="button" className={`btn small ${danger ? 'danger solid' : 'primary'}`} onClick={onSave} disabled={disabled || saving}>
				{saving ? <span className="spinner" /> : label}
			</button>
		</div>
	)
}
export function PendingBanner({d}: {d: MachineDetails}) {
	if (!d.pending) return null
	return (
		<div className="mx-pending">
			<Icon name="info" size={16} />
			Some changes apply the next time {d.name} starts. Reboot it from here to apply them now.
		</div>
	)
}
const stopped = (d: MachineDetails) => d.state === 'stopped' || d.state === 'hibernated' || d.state === 'error'

// ---- summary ----------------------------------------------------------------------------------
// A small line chart of the last hour, like Proxmox's RRD graphs.
export function Chart({title, points, series, max, format}: {title: string; points: StatPoint[]; series: {key: keyof StatPoint; label: string; color: string}[]; max?: number; format: (n: number) => string}) {
	const W = 320
	const H = 90
	const top = Math.max(max ?? 0, ...points.flatMap((p) => series.map((s) => Number(p[s.key]) || 0)), 1)
	const t0 = points[0]?.t ?? 0
	const t1 = points.at(-1)?.t ?? 1
	const x = (t: number) => (t1 === t0 ? W : ((t - t0) / (t1 - t0)) * W)
	const y = (v: number) => H - (v / top) * (H - 6) - 3
	return (
		<div className="mx-chart">
			<div className="mx-chart-head">
				<b>{title}</b>
				<span>
					{series.map((s) => (
						<em key={String(s.key)} style={{color: s.color}}>
							{s.label} {points.length ? format(Number(points.at(-1)![s.key]) || 0) : '–'}
						</em>
					))}
				</span>
			</div>
			{points.length > 1 ? (
				<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title}, last hour`}>
					{[0.25, 0.5, 0.75].map((f) => (
						<line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="grid" />
					))}
					{series.map((s) => {
						const line = points.map((p) => `${x(p.t).toFixed(1)},${y(Number(p[s.key]) || 0).toFixed(1)}`).join(' ')
						return (
							<g key={String(s.key)}>
								<polygon points={`0,${H} ${line} ${W},${H}`} fill={s.color} opacity="0.14" />
								<polyline points={line} fill="none" stroke={s.color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
							</g>
						)
					})}
				</svg>
			) : (
				<div className="mx-chart-empty">Collecting… (every 10 seconds while it runs)</div>
			)}
			<div className="mx-chart-foot">
				<span>1 hour</span>
				<span>max {format(top)}</span>
			</div>
		</div>
	)
}

export function SummaryPanel({d}: {d: MachineDetails}) {
	const stats = useStats(d.id, d.state === 'running')
	const pts = stats.data?.points ?? []
	const last = pts.at(-1)
	const action = useMachineAction()
	const [notes, setNotes] = useState<string | null>(null)
	const host = typeof location !== 'undefined' ? location.hostname : ''
	const disk0 = d.hardware.disks.find((x) => x.device === 'disk')
	return (
		<div className="mx-panel">
			<PendingBanner d={d} />
			<div className="mx-summary">
				<div className="mx-card">
					<h4>Status</h4>
					<dl>
						<dt>Status</dt>
						<dd className={`st-${d.state}`}>{d.state}</dd>
						<dt>ID</dt>
						<dd>{d.vmid}</dd>
						<dt>CPU usage</dt>
						<dd>{last ? `${last.cpu}% of ${d.hardware.sockets * d.hardware.cores} CPU${d.hardware.sockets * d.hardware.cores > 1 ? 's' : ''}` : '–'}</dd>
						<dt>Memory</dt>
						<dd>{last ? `${mib(last.memMb)} of ${mib(d.hardware.memoryMb)}` : mib(d.hardware.memoryMb)}</dd>
						<dt>Boot disk</dt>
						<dd>{disk0?.sizeGb ? `${disk0.sizeGb} GB${disk0.usedGb !== null ? ` (${disk0.usedGb} GB used)` : ''}` : '–'}</dd>
						<dt>Address</dt>
						<dd>{d.guestIps.length ? d.guestIps.join(', ') : `${host} (shared with the server; forward ports to reach it)`}</dd>
						{d.createdAt ? (
							<>
								<dt>Created</dt>
								<dd>{when(d.createdAt)}</dd>
							</>
						) : null}
					</dl>
				</div>
				<div className="mx-card">
					<h4>
						Notes
						{notes === null && (
							<button type="button" className="btn small ghost" onClick={() => setNotes(d.options.notes)}>
								<Icon name="pencil" size={14} /> Edit
							</button>
						)}
					</h4>
					{notes === null ? (
						<p className={d.options.notes ? 'mx-notes' : 'muted'}>{d.options.notes || 'No notes yet. Write down what this machine is for, logins, or anything else worth remembering.'}</p>
					) : (
						<>
							<textarea className="field mx-textarea" value={notes} onChange={(e) => setNotes(e.target.value)} rows={6} maxLength={8000} />
							<Actions
								onCancel={() => setNotes(null)}
								saving={action.isPending}
								onSave={() => action.mutate({path: 'machines.updateOptions', input: {id: d.id, notes}, done: 'Notes saved'}, {onSuccess: () => setNotes(null)})}
							/>
						</>
					)}
				</div>
			</div>
			{d.errorMessage && (
				<div className="error">
					<Icon name="alert" size={18} />
					{d.errorMessage}
				</div>
			)}
			<div className="mx-charts">
				<Chart title="CPU usage" points={pts} series={[{key: 'cpu', label: 'CPU', color: 'var(--blue)'}]} max={100} format={(n) => `${n}%`} />
				<Chart title="Memory usage" points={pts} series={[{key: 'memMb', label: 'Used', color: 'var(--green)'}]} max={d.hardware.memoryMb} format={mib} />
				<Chart
					title="Network traffic"
					points={pts}
					series={[
						{key: 'netIn', label: 'In', color: 'var(--teal)'},
						{key: 'netOut', label: 'Out', color: 'var(--mauve, #c084fc)'},
					]}
					format={rate}
				/>
				<Chart
					title="Disk IO"
					points={pts}
					series={[
						{key: 'diskRead', label: 'Read', color: 'var(--peach, #fb923c)'},
						{key: 'diskWrite', label: 'Write', color: 'var(--red)'},
					]}
					format={rate}
				/>
			</div>
		</div>
	)
}

// ---- hardware ---------------------------------------------------------------------------------
const useIsos = () =>
	useQuery({
		queryKey: ['machines.media'],
		queryFn: async () => {
			const [local, images] = await Promise.all([query<OsImage[]>('machines.localIsos').catch(() => []), query<(OsImage & {manualSetup?: boolean})[]>('machines.osImages').catch(() => [])])
			return [...local.map((i) => ({id: i.id, label: `${i.id.slice('local:'.length)}`})), ...images.filter((i) => i.state === 'downloaded' && i.manualSetup === false).map((i) => ({id: i.id, label: `${i.name} ${i.version} (downloaded)`}))]
		},
		staleTime: 30_000,
	})

export function HardwarePanel({d}: {d: MachineDetails}) {
	const node = useNode()
	const action = useMachineAction()
	const [open, setOpen] = useState<string | null>(null)
	const h = d.hardware
	const toggle = (k: string) => (haptic(5), setOpen(open === k ? null : k))
	const save = (path: string, input: Record<string, unknown>, done: string) => action.mutate({path, input: {id: d.id, ...input}, done}, {onSuccess: () => setOpen(null)})
	const threads = node.data?.threads ?? 64
	const maxMem = node.data ? Math.max(512, node.data.memoryTotalMb - 512) : 65536
	return (
		<div className="mx-panel">
			<PendingBanner d={d} />
			<div className="mx-toolbar">
				<button type="button" className="btn small" onClick={() => toggle('add-disk')}>
					<Icon name="plus" size={15} /> Hard disk
				</button>
				<button type="button" className="btn small" onClick={() => toggle('add-cd')}>
					<Icon name="disc" size={15} /> CD/DVD drive
				</button>
			</div>
			{open === 'add-disk' && <AddDisk d={d} onDone={() => setOpen(null)} />}
			{open === 'add-cd' && (
				<div className="mx-edit standalone">
					<p className="muted">Adds an empty CD/DVD drive. {stopped(d) ? '' : `Shut down ${d.name} first.`}</p>
					<Actions onCancel={() => setOpen(null)} label="Add drive" disabled={!stopped(d)} saving={action.isPending} onSave={() => save('machines.addCdrom', {}, 'CD/DVD drive added')} />
				</div>
			)}
			<Rows>
				<Row icon="memory" label="Memory" value={mib(h.memoryMb)} open={open === 'memory'} onClick={() => toggle('memory')}>
					<MemoryEdit value={h.memoryMb} max={maxMem} onCancel={() => setOpen(null)} saving={action.isPending} onSave={(memoryMb) => save('machines.updateHardware', {memoryMb}, `Memory set to ${mib(memoryMb)}`)} />
				</Row>
				<Row icon="cpu" label="Processors" value={`${h.sockets * h.cores} (${h.sockets} socket${h.sockets > 1 ? 's' : ''}, ${h.cores} core${h.cores > 1 ? 's' : ''}) [${h.cpuType}]`} open={open === 'cpu'} onClick={() => toggle('cpu')}>
					<CpuEdit h={h} threads={threads} types={node.data?.cpuTypes ?? ['host', 'host-model', 'max', 'qemu64']} onCancel={() => setOpen(null)} saving={action.isPending} onSave={(v) => save('machines.updateHardware', v, 'Processors updated')} />
				</Row>
				<Row icon="settings" label="BIOS" value={h.firmware === 'efi' ? 'OVMF (UEFI)' : 'SeaBIOS'} open={open === 'bios'} onClick={() => toggle('bios')}>
					<ChoiceEdit
						value={h.firmware}
						options={[
							{id: 'bios', label: 'SeaBIOS (legacy BIOS)'},
							{id: 'efi', label: 'OVMF (UEFI)'},
						]}
						warning="An installed system usually only boots with the firmware it was installed with."
						onCancel={() => setOpen(null)}
						saving={action.isPending}
						onSave={(firmware) => save('machines.updateHardware', {firmware}, 'Firmware changed')}
					/>
				</Row>
				<Row icon="window" label="Display" value={VIDEO_LABEL[h.video] ?? h.video} open={open === 'video'} onClick={() => toggle('video')}>
					<ChoiceEdit
						value={h.video}
						options={(node.data?.videoModels ?? ['vga', 'none']).map((v) => ({id: v, label: VIDEO_LABEL[v] ?? v}))}
						warning="Only adapters this server’s QEMU has are listed. “None” leaves the console blank."
						onCancel={() => setOpen(null)}
						saving={action.isPending}
						onSave={(video) => save('machines.updateHardware', {video}, 'Display changed')}
					/>
				</Row>
				<Row icon="server" label="Machine" value={h.machineType === 'pc' ? 'i440fx' : 'q35'} open={open === 'machine'} onClick={() => toggle('machine')}>
					<ChoiceEdit
						value={h.machineType}
						options={[
							{id: 'q35', label: 'q35 (modern PCIe, the default)'},
							{id: 'pc', label: 'i440fx (older PCI, for old systems)'},
						]}
						warning="Changing the chipset can make an installed system look for different hardware."
						onCancel={() => setOpen(null)}
						saving={action.isPending}
						onSave={(machineType) => save('machines.updateHardware', {machineType}, 'Machine type changed')}
					/>
				</Row>
				{h.disks.map((x) => (
					<Row key={x.id} icon={x.device === 'cdrom' ? 'disc' : 'disk'} label={driveName(x)} value={driveValue(x)} open={open === `drive:${x.id}`} onClick={() => toggle(`drive:${x.id}`)}>
						<DriveEdit d={d} drive={x} onDone={() => setOpen(null)} />
					</Row>
				))}
				<Row icon="network" label="Network device" value={`${NIC_LABEL[h.nic]?.split(' (')[0] ?? h.nic}, ${h.mac}${h.linkDown ? ', disconnected' : ''}`} open={open === 'nic'} onClick={() => toggle('nic')}>
					<NicEdit h={h} models={node.data?.nicModels ?? ['virtio', 'e1000e', 'e1000', 'rtl8139']} onCancel={() => setOpen(null)} saving={action.isPending} onSave={(v) => save('machines.updateHardware', v, 'Network device updated')} />
				</Row>
			</Rows>
			<p className="muted mx-foot">
				Changes made while {d.name} runs apply at its next start (Reboot here applies them). Networking is user-mode (passt): the machine shares the server’s address,
				so use Port forwarding to reach services inside it.
			</p>
		</div>
	)
}
const driveValue = (x: Drive) =>
	x.device === 'cdrom'
		? `${x.media ?? 'empty'} (${x.bus.toUpperCase()})`
		: `${x.sizeGb !== null ? `${x.sizeGb} GB` : '–'}, ${BUS_LABEL[x.bus] ?? x.bus}${x.cache !== 'default' ? `, cache ${x.cache}` : ''}${x.discard === false ? '' : ', discard'}`

function MemoryEdit({value, max, onCancel, onSave, saving}: {value: number; max: number; onCancel: () => void; onSave: (mb: number) => void; saving: boolean}) {
	const [v, setV] = useState(String(value))
	const n = Number(v)
	const ok = Number.isInteger(n) && n >= 256 && n <= max
	return (
		<>
			<Field label="Memory (MiB)" hint={`256 to ${max} MiB. ${ok ? `= ${mib(n)}` : ''}`}>
				<input className="field" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, '').slice(0, 7))} />
			</Field>
			<div className="mx-chips">
				{[512, 1024, 2048, 4096, 8192, 16384].filter((x) => x <= max).map((x) => (
					<button type="button" key={x} className={`chip${n === x ? ' on' : ''}`} onClick={() => setV(String(x))}>
						{mib(x)}
					</button>
				))}
			</div>
			<Actions onCancel={onCancel} onSave={() => onSave(n)} saving={saving} disabled={!ok || n === value} />
		</>
	)
}
function CpuEdit({h, threads, types, onCancel, onSave, saving}: {h: MachineDetails['hardware']; threads: number; types: string[]; onCancel: () => void; onSave: (v: {sockets: number; cores: number; cpuType: string}) => void; saving: boolean}) {
	const [sockets, setSockets] = useState(h.sockets)
	const [cores, setCores] = useState(h.cores)
	const [cpuType, setType] = useState(h.cpuType)
	const ok = sockets * cores <= threads
	return (
		<>
			<div className="mx-grid2">
				<Field label="Sockets">
					<select className="field" value={sockets} onChange={(e) => setSockets(Number(e.target.value))}>
						{[1, 2, 3, 4].map((n) => (
							<option key={n}>{n}</option>
						))}
					</select>
				</Field>
				<Field label="Cores per socket">
					<select className="field" value={cores} onChange={(e) => setCores(Number(e.target.value))}>
						{Array.from({length: threads}, (_, i) => i + 1).map((n) => (
							<option key={n}>{n}</option>
						))}
					</select>
				</Field>
			</div>
			<Field label="Type" hint={`Total: ${sockets * cores} of the server’s ${threads} threads.`}>
				<select className="field" value={cpuType} onChange={(e) => setType(e.target.value)}>
					{types.map((t) => (
						<option key={t} value={t}>
							{CPU_LABEL[t] ?? t}
						</option>
					))}
				</select>
			</Field>
			{!ok && <p className="mx-warn">More than the server has.</p>}
			<Actions onCancel={onCancel} onSave={() => onSave({sockets, cores, cpuType})} saving={saving} disabled={!ok} />
		</>
	)
}
function ChoiceEdit({value, options, warning, onCancel, onSave, saving}: {value: string; options: {id: string; label: string}[]; warning?: string; onCancel: () => void; onSave: (v: string) => void; saving: boolean}) {
	const [v, setV] = useState(value)
	return (
		<>
			<div className="mx-choices" role="radiogroup">
				{options.map((o) => (
					<button type="button" key={o.id} role="radio" aria-checked={v === o.id} className={`mx-choice${v === o.id ? ' on' : ''}`} onClick={() => setV(o.id)}>
						<i />
						{o.label}
					</button>
				))}
			</div>
			{warning && <p className="muted mx-small">{warning}</p>}
			<Actions onCancel={onCancel} onSave={() => onSave(v)} saving={saving} disabled={v === value} />
		</>
	)
}
function NicEdit({h, models, onCancel, onSave, saving}: {h: MachineDetails['hardware']; models: string[]; onCancel: () => void; onSave: (v: {nic: string; mac: string; linkDown: boolean}) => void; saving: boolean}) {
	const [nic, setNic] = useState(h.nic)
	const [mac, setMac] = useState(h.mac)
	const [linkDown, setLinkDown] = useState(h.linkDown)
	const ok = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac) && !(parseInt(mac.slice(0, 2), 16) & 1)
	const random = () => setMac(`52:54:00:${Array.from({length: 3}, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':')}`)
	return (
		<>
			<Field label="Model">
				<select className="field" value={nic} onChange={(e) => setNic(e.target.value)}>
					{models.map((m) => (
						<option key={m} value={m}>
							{NIC_LABEL[m] ?? m}
						</option>
					))}
				</select>
			</Field>
			<Field label="MAC address">
				<span className="mx-inline">
					<input className="field mono" value={mac} onChange={(e) => setMac(e.target.value.toLowerCase().slice(0, 17))} />
					<button type="button" className="btn small" onClick={random}>
						New
					</button>
				</span>
			</Field>
			<Toggle label="Disconnect" note="Like unplugging the network cable." on={linkDown} onChange={setLinkDown} />
			{!ok && <p className="mx-warn">Enter a unicast MAC address like 52:54:00:12:34:56.</p>}
			<Actions onCancel={onCancel} onSave={() => onSave({nic, mac, linkDown})} saving={saving} disabled={!ok} />
		</>
	)
}
function AddDisk({d, onDone}: {d: MachineDetails; onDone: () => void}) {
	const node = useNode()
	const action = useMachineAction()
	const [size, setSize] = useState('32')
	const [bus, setBus] = useState('virtio')
	const [cache, setCache] = useState('default')
	const [discard, setDiscard] = useState(true)
	const n = Number(size)
	const ok = Number.isInteger(n) && n >= 1 && n <= 4096
	return (
		<div className="mx-edit standalone">
			<div className="mx-grid2">
				<Field label="Size (GB)" hint={node.data?.storage ? `${node.data.storage.freeGb} GB free on the server` : undefined}>
					<input className="field" inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value.replace(/\D/g, '').slice(0, 4))} />
				</Field>
				<Field label="Bus">
					<select className="field" value={bus} onChange={(e) => setBus(e.target.value)}>
						{(node.data?.diskBuses ?? ['virtio', 'sata', 'scsi', 'ide']).map((b) => (
							<option key={b} value={b}>
								{BUS_LABEL[b] ?? b}
							</option>
						))}
					</select>
				</Field>
			</div>
			<Field label="Cache">
				<select className="field" value={cache} onChange={(e) => setCache(e.target.value)}>
					{(node.data?.diskCaches ?? Object.keys(CACHE_LABEL)).map((c) => (
						<option key={c} value={c}>
							{CACHE_LABEL[c] ?? c}
						</option>
					))}
				</select>
			</Field>
			<Toggle label="Discard" note="Frees space on the server when files are deleted inside the machine (TRIM)." on={discard} onChange={setDiscard} />
			<p className="muted mx-small">The disk is thin-provisioned: it only takes the space actually written. {stopped(d) ? '' : 'It appears inside the machine after its next start.'}</p>
			<Actions
				onCancel={onDone}
				label="Add disk"
				saving={action.isPending}
				disabled={!ok}
				onSave={() => action.mutate({path: 'machines.addDisk', input: {id: d.id, sizeGb: n, bus, cache, discard}, done: `${n} GB disk added`}, {onSuccess: onDone})}
			/>
		</div>
	)
}
function DriveEdit({d, drive, onDone}: {d: MachineDetails; drive: Drive; onDone: () => void}) {
	const node = useNode()
	const action = useMachineAction()
	const confirm = useConfirm()
	const isos = useIsos()
	const [bus, setBus] = useState(drive.bus)
	const [cache, setCache] = useState(drive.cache)
	const [discard, setDiscard] = useState(drive.discard !== false)
	const [size, setSize] = useState(String(Math.ceil((drive.sizeGb ?? 0) + 1)))
	const [iso, setIso] = useState('')
	const run = (path: string, input: Record<string, unknown>, done: string) => action.mutate({path, input: {id: d.id, diskId: drive.id, ...input}, done}, {onSuccess: onDone})
	const remove = async () => {
		const inside = drive.inMachineFolder && drive.device === 'disk'
		const ok = await confirm({
			title: `Remove ${driveName(drive).toLowerCase()}?`,
			body: inside ? 'The drive is detached and its disk image deleted, with everything on it. This can’t be undone.' : 'The drive is removed from the machine. No file is deleted.',
			confirm: inside ? 'Remove and delete' : 'Remove',
			danger: true,
			icon: 'trash',
		})
		if (ok) run('machines.removeDisk', {deleteFile: inside}, 'Drive removed')
	}
	if (drive.device === 'cdrom')
		return (
			<>
				<p className="muted mx-small">
					{drive.role === 'seed'
						? 'Holds cloud-init’s setup for this machine (edit it under Cloud-Init).'
						: drive.role === 'answer'
							? 'Windows Setup’s answer file; removed automatically after the first shutdown.'
							: `Currently: ${drive.media ?? 'empty'}. Put in one of the .iso files from your Home folder, or a downloaded installer.`}
				</p>
				{!drive.role && (
					<>
						<Field label="Media">
							<select className="field" value={iso} onChange={(e) => setIso(e.target.value)}>
								<option value="">Choose an ISO…</option>
								{(isos.data ?? []).map((i) => (
									<option key={i.id} value={i.id}>
										{i.label}
									</option>
								))}
							</select>
						</Field>
						<div className="mx-actions">
							{drive.media && (
								<button type="button" className="btn small" disabled={action.isPending} onClick={() => run('machines.setMedia', {iso: null}, 'Ejected')}>
									Eject
								</button>
							)}
							<button type="button" className="btn small primary" disabled={!iso || action.isPending} onClick={() => run('machines.setMedia', {iso}, 'Media inserted')}>
								Insert
							</button>
						</div>
					</>
				)}
				<div className="mx-actions left">
					<button type="button" className="btn small danger" disabled={!stopped(d) || action.isPending} onClick={remove} title={stopped(d) ? undefined : `Shut down ${d.name} first`}>
						<Icon name="trash" size={14} /> Remove drive
					</button>
				</div>
			</>
		)
	const n = Number(size)
	return (
		<>
			<div className="mx-grid2">
				<Field label="Bus">
					<select className="field" value={bus} onChange={(e) => setBus(e.target.value as Drive['bus'])}>
						{(node.data?.diskBuses ?? ['virtio', 'sata', 'scsi', 'ide']).map((b) => (
							<option key={b} value={b}>
								{BUS_LABEL[b] ?? b}
							</option>
						))}
					</select>
				</Field>
				<Field label="Cache">
					<select className="field" value={cache} onChange={(e) => setCache(e.target.value)}>
						{(node.data?.diskCaches ?? Object.keys(CACHE_LABEL)).map((c) => (
							<option key={c} value={c}>
								{CACHE_LABEL[c] ?? c}
							</option>
						))}
					</select>
				</Field>
			</div>
			<Toggle label="Discard" note="TRIM: give freed space back to the server." on={discard} onChange={setDiscard} />
			{bus !== drive.bus && <p className="mx-warn">An installed system may not find its disk on a different bus (Windows especially).</p>}
			<Actions onCancel={onDone} saving={action.isPending} disabled={bus === drive.bus && cache === drive.cache && discard === (drive.discard !== false)} onSave={() => run('machines.updateDisk', {bus, cache, discard}, 'Disk updated')} />
			<hr className="mx-hr" />
			<Field label="Resize to (GB)" hint={`Disks only grow. Now ${drive.sizeGb ?? '?'} GB; ${d.state === 'running' ? 'grows live, then extend the partition inside the machine.' : 'extend the partition inside the machine afterwards.'}`}>
				<span className="mx-inline">
					<input className="field" inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value.replace(/\D/g, '').slice(0, 4))} />
					<button type="button" className="btn small" disabled={!(n > (drive.sizeGb ?? 0) && n <= 4096) || action.isPending} onClick={() => run('machines.resizeDisk', {sizeGb: n}, `Disk is now ${n} GB`)}>
						Resize
					</button>
				</span>
			</Field>
			<div className="mx-actions left">
				<button type="button" className="btn small danger" disabled={!stopped(d) || action.isPending} onClick={remove} title={stopped(d) ? undefined : `Shut down ${d.name} first`}>
					<Icon name="trash" size={14} /> Remove disk
				</button>
				{!stopped(d) && <span className="muted mx-small">Shut down to remove.</span>}
			</div>
		</>
	)
}

// ---- options ----------------------------------------------------------------------------------
export function OptionsPanel({d}: {d: MachineDetails}) {
	const action = useMachineAction()
	const [open, setOpen] = useState<string | null>(null)
	const o = d.options
	const toggle = (k: string) => (haptic(5), setOpen(open === k ? null : k))
	const set = (input: Record<string, unknown>, done: string) => action.mutate({path: 'machines.updateOptions', input: {id: d.id, ...input}, done}, {onSuccess: () => setOpen(null)})
	const [name, setName] = useState(d.name)
	const [order, setOrder] = useState(String(o.startupOrder ?? ''))
	const [delay, setDelay] = useState(String(o.startupDelay ?? 0))
	useEffect(() => {
		setName(d.name)
		setOrder(String(o.startupOrder ?? ''))
		setDelay(String(o.startupDelay ?? 0))
	}, [open, d.name, o.startupOrder, o.startupDelay])
	const flag = (k: keyof MachineDetails['options'], label: string, note: string) => (
		<Toggle label={label} note={note} on={!!o[k]} disabled={action.isPending} onChange={(v) => set({[k]: v}, `${label} ${v ? 'on' : 'off'}`)} />
	)
	return (
		<div className="mx-panel">
			<PendingBanner d={d} />
			<Rows>
				<Row icon="pencil" label="Name" value={d.name} open={open === 'name'} onClick={() => toggle('name')}>
					<Field label="Name">
						<input className="field" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
					</Field>
					<Actions onCancel={() => setOpen(null)} saving={action.isPending} disabled={!name.trim() || name === d.name} onSave={() => set({name: name.trim()}, 'Renamed')} />
				</Row>
				<Row icon="restart" label="Start/Shutdown order" value={`order=${o.startupOrder ?? 'any'}, delay=${o.startupDelay}s`} open={open === 'order'} onClick={() => toggle('order')}>
					<div className="mx-grid2">
						<Field label="Start order" hint="Lower starts first; empty for any.">
							<input className="field" inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value.replace(/\D/g, '').slice(0, 3))} />
						</Field>
						<Field label="Delay after (seconds)" hint="Before the next machine starts.">
							<input className="field" inputMode="numeric" value={delay} onChange={(e) => setDelay(e.target.value.replace(/\D/g, '').slice(0, 3))} />
						</Field>
					</div>
					<Actions onCancel={() => setOpen(null)} saving={action.isPending} onSave={() => set({startupOrder: order === '' ? null : Number(order), startupDelay: Number(delay) || 0}, 'Start order saved')} />
				</Row>
				<Row icon="list" label="Boot order" value={d.boot.map((b) => bootName(d, b)).join(', ')} open={open === 'boot'} onClick={() => toggle('boot')}>
					<BootOrder d={d} onDone={() => setOpen(null)} />
				</Row>
			</Rows>
			<div className="mx-flags">
				{flag('onBoot', 'Start at boot', 'Starts with the server, in its start order.')}
				{flag('protection', 'Protection', 'Prevents deleting this machine until it’s turned off.')}
				{flag('agent', 'QEMU Guest Agent', 'Lets the server read the machine’s IP addresses and shut it down cleanly. Install qemu-guest-agent inside it.')}
				{flag('tablet', 'Use tablet for pointer', 'The mouse follows your pointer exactly in the console.')}
				{flag('acpi', 'ACPI support', 'Needed for Shut down to work. Turn off only for very old systems.')}
				{flag('kvm', 'KVM hardware virtualization', 'Much faster. Turn off only to troubleshoot.')}
				{flag('bootMenu', 'Boot menu', 'Shows the firmware’s boot menu for 3 seconds at start (press Esc or F12).')}
			</div>
			<p className="muted mx-foot">Hardware-level options apply at the machine’s next start.</p>
		</div>
	)
}
const bootName = (d: MachineDetails, id: string) => {
	if (id === 'net') return 'Network (PXE)'
	const x = d.hardware.disks.find((y) => y.id === id)
	return x ? `${x.target}${x.device === 'cdrom' ? ' (CD/DVD)' : ''}` : id
}
function BootOrder({d, onDone}: {d: MachineDetails; onDone: () => void}) {
	const action = useMachineAction()
	const all = useMemo(() => [...d.boot, ...d.hardware.disks.map((x) => x.id).filter((x) => !d.boot.includes(x)), ...(d.boot.includes('net') ? [] : ['net'])], [d])
	const [list, setList] = useState(all.map((id) => ({id, on: d.boot.includes(id)})))
	const move = (i: number, by: number) => {
		const next = [...list]
		const [x] = next.splice(i, 1)
		next.splice(Math.max(0, Math.min(next.length, i + by)), 0, x)
		setList(next)
	}
	const order = list.filter((x) => x.on).map((x) => x.id)
	return (
		<>
			<ol className="mx-boot">
				{list.map((x, i) => (
					<li key={x.id} className={x.on ? '' : 'off'}>
						<button type="button" role="checkbox" aria-checked={x.on} className="mx-check" onClick={() => setList(list.map((y) => (y.id === x.id ? {...y, on: !y.on} : y)))}>
							<Icon name={x.on ? 'checked' : 'unchecked'} size={18} />
						</button>
						<span>{bootName(d, x.id)}</span>
						<button type="button" className="btn small ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
							↑
						</button>
						<button type="button" className="btn small ghost" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}>
							↓
						</button>
					</li>
				))}
			</ol>
			<Actions onCancel={onDone} saving={action.isPending} disabled={!order.length} onSave={() => action.mutate({path: 'machines.setBootOrder', input: {id: d.id, order}, done: 'Boot order saved'}, {onSuccess: onDone})} />
		</>
	)
}

// ---- cloud-init -------------------------------------------------------------------------------
export function CloudInitPanel({d}: {d: MachineDetails}) {
	const action = useMachineAction()
	const c = d.cloudInit
	const [username, setUsername] = useState(c?.username ?? '')
	const [hostname, setHostname] = useState(c?.hostname ?? '')
	const [keys, setKeys] = useState((c?.sshKeys ?? []).join('\n'))
	const [password, setPassword] = useState('')
	useEffect(() => {
		setUsername(c?.username ?? '')
		setHostname(c?.hostname ?? '')
		setKeys((c?.sshKeys ?? []).join('\n'))
	}, [c?.username, c?.hostname, c?.sshKeys?.join('\n')])
	if (!c)
		return (
			<div className="mx-panel">
				<div className="mx-empty">
					<Icon name="key" size={28} />
					<b>No cloud-init drive</b>
					<span>Only machines made from a cloud image (Ubuntu, Debian, Fedora…) are set up by cloud-init. This one was installed from an ISO.</span>
				</div>
			</div>
		)
	const keyList = keys.split('\n').map((k) => k.trim()).filter(Boolean)
	const privateKey = /PRIVATE KEY/.test(keys)
	return (
		<div className="mx-panel">
			<PendingBanner d={d} />
			<p className="muted">Applied when {d.name} next starts. Only a hash of a new password is stored, never the password itself.</p>
			<div className="mx-form">
				<div className="mx-grid2">
					<Field label="User">
						<input className="field mono" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().slice(0, 32))} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
					</Field>
					<Field label="Hostname">
						<input className="field mono" value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase().slice(0, 63))} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
					</Field>
				</div>
				<Field label="New password" hint="Leave empty to keep the current one.">
					<input className="field" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
				</Field>
				<Field label="SSH public keys" hint="One per line, from your .pub file (e.g. ~/.ssh/id_ed25519.pub). Never paste a private key.">
					<textarea className="field mono mx-textarea" rows={4} value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="ssh-ed25519 AAAA… you@laptop" spellCheck={false} />
				</Field>
				{privateKey && <p className="mx-warn">That looks like a private key. Paste the public key (the .pub file) instead, and keep the private one to yourself.</p>}
				<div className="mx-actions">
					<button
						type="button"
						className="btn small primary"
						disabled={action.isPending || privateKey || !username}
						onClick={() =>
							action.mutate({path: 'machines.updateCloudInit', input: {id: d.id, username, hostname, sshKeys: keyList, ...(password ? {password} : {})}, done: 'Cloud-init updated for the next start'}, {onSuccess: () => setPassword('')})
						}
					>
						{action.isPending ? <span className="spinner" /> : 'Regenerate image'}
					</button>
				</div>
			</div>
		</div>
	)
}

// ---- snapshots --------------------------------------------------------------------------------
export function SnapshotsPanel({d}: {d: MachineDetails}) {
	const action = useMachineAction()
	const confirm = useConfirm()
	const [taking, setTaking] = useState(false)
	const [name, setName] = useState('')
	const [description, setDescription] = useState('')
	const okName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(name)
	const canAct = stopped(d) && d.state !== 'error'
	const rollback = async (s: string) => {
		if (await confirm({title: `Go back to “${s}”?`, body: `${d.name}’s disks return to how they were then. Everything written since is lost. This can’t be undone.`, confirm: 'Roll back', danger: true, icon: 'history'}))
			action.mutate({path: 'machines.revertSnapshot', input: {id: d.id, name: s}, done: `Back to ${s}`})
	}
	const remove = async (s: string) => {
		if (await confirm({title: `Delete snapshot “${s}”?`, body: 'The machine stays as it is now; you just can’t go back to this point any more.', confirm: 'Delete', danger: true, icon: 'trash'}))
			action.mutate({path: 'machines.deleteSnapshot', input: {id: d.id, name: s}, done: 'Snapshot deleted'})
	}
	return (
		<div className="mx-panel">
			<div className="mx-toolbar">
				<button type="button" className="btn small primary" onClick={() => setTaking(!taking)} disabled={!canAct}>
					<Icon name="camera" size={15} /> Take snapshot
				</button>
				{!canAct && <span className="muted mx-small">Shut down {d.name} to take, restore or delete snapshots.</span>}
			</div>
			{taking && (
				<div className="mx-edit standalone">
					<div className="mx-grid2">
						<Field label="Name" hint="Letters, numbers, - _ .">
							<input className="field" value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder="before-upgrade" />
						</Field>
						<Field label="Description">
							<input className="field" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))} />
						</Field>
					</div>
					<Actions
						onCancel={() => setTaking(false)}
						label="Take snapshot"
						saving={action.isPending}
						disabled={!okName}
						onSave={() =>
							action.mutate(
								{path: 'machines.snapshot', input: {id: d.id, name, description}, done: `Snapshot ${name} taken`},
								{
									onSuccess: () => {
										setTaking(false)
										setName('')
										setDescription('')
									},
								},
							)
						}
					/>
				</div>
			)}
			<div className="mx-table" role="table">
				<div className="mx-tr head" role="row">
					<span>Name</span>
					<span>Date</span>
					<span>Description</span>
					<span />
				</div>
				{d.snapshots.length === 0 && <div className="mx-tr empty">No snapshots yet. Take one before an upgrade or a risky change.</div>}
				{[...d.snapshots].reverse().map((s) => (
					<div className="mx-tr" role="row" key={s.name}>
						<span className="b">{s.name}</span>
						<span>{when(s.createdAt)}</span>
						<span className="muted">{s.description}</span>
						<span className="mx-tr-actions">
							<button type="button" className="btn small" disabled={!canAct || action.isPending} onClick={() => rollback(s.name)}>
								Rollback
							</button>
							<button type="button" className="btn small danger" disabled={!canAct || action.isPending} onClick={() => remove(s.name)} aria-label={`Delete ${s.name}`}>
								<Icon name="trash" size={14} />
							</button>
						</span>
					</div>
				))}
				<div className="mx-tr now">
					<span className="b">NOW</span>
					<span />
					<span className="muted">You are here</span>
					<span />
				</div>
			</div>
			<p className="muted mx-foot">Snapshots are kept inside the machine’s disks (qcow2). UEFI settings aren’t part of a snapshot.</p>
		</div>
	)
}

// ---- backups ----------------------------------------------------------------------------------
export function BackupsPanel({d}: {d: MachineDetails}) {
	const action = useMachineAction()
	const confirm = useConfirm()
	const backups = useBackups(d.id)
	const [notes, setNotes] = useState('')
	const [asking, setAsking] = useState(false)
	const running = d.tasks.find((t) => t.type === 'backup' && t.status === 'running')
	const restore = async (id: string, name: string) => {
		if (await confirm({title: 'Restore as a new machine?', body: `A new machine is made from this backup of ${name}. ${d.name} itself isn’t changed.`, confirm: 'Restore', icon: 'restore'}))
			action.mutate({path: 'machines.restoreBackup', input: {backupId: id}, done: 'Restoring as a new machine'})
	}
	const remove = async (id: string) => {
		if (await confirm({title: 'Delete this backup?', body: 'Its files are deleted from Home → Backups → Machines. This can’t be undone.', confirm: 'Delete backup', danger: true, icon: 'trash'}))
			action.mutate({path: 'machines.deleteBackup', input: {backupId: id}, done: 'Backup deleted'})
	}
	return (
		<div className="mx-panel">
			<div className="mx-toolbar">
				<button type="button" className="btn small primary" disabled={!!running || action.isPending || d.state === 'error'} onClick={() => setAsking(!asking)}>
					<Icon name="save" size={15} /> Backup now
				</button>
				{running && (
					<span className="muted mx-small">
						<span className="spinner" /> Backing up… started {when(running.startedAt)}
					</span>
				)}
			</div>
			{asking && (
				<div className="mx-edit standalone">
					<Field label="Notes" hint={d.state === 'running' ? 'A running machine is backed up live: QEMU copies a consistent point in time while it keeps running.' : 'The disks are copied and compressed.'}>
						<input className="field" value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} placeholder="Before upgrading" />
					</Field>
					<Actions
						onCancel={() => setAsking(false)}
						label="Start backup"
						saving={action.isPending}
						onSave={() => action.mutate({path: 'machines.backup', input: {id: d.id, notes}, done: 'Backup started'}, {onSuccess: () => (setAsking(false), setNotes(''))})}
					/>
				</div>
			)}
			<div className="mx-table" role="table">
				<div className="mx-tr head" role="row">
					<span>Date</span>
					<span>Size</span>
					<span>Notes</span>
					<span />
				</div>
				{backups.isLoading && <div className="mx-tr empty">Loading…</div>}
				{backups.data?.length === 0 && <div className="mx-tr empty">No backups of {d.name} yet.</div>}
				{(backups.data ?? []).map((b) => (
					<div className="mx-tr" role="row" key={b.id}>
						<span className="b">
							{when(b.createdAt)}
							{b.live && <em className="mx-tag">live</em>}
						</span>
						<span>{bytes(b.sizeBytes)}</span>
						<span className="muted">{b.notes}</span>
						<span className="mx-tr-actions">
							<button type="button" className="btn small" disabled={action.isPending} onClick={() => restore(b.id, b.name)}>
								Restore
							</button>
							<button type="button" className="btn small danger" disabled={action.isPending} onClick={() => remove(b.id)} aria-label="Delete backup">
								<Icon name="trash" size={14} />
							</button>
						</span>
					</div>
				))}
			</div>
			<p className="muted mx-foot">Backups are saved in Home → Backups → Machines, so you can see them in Files and copy them to another drive or a pool.</p>
		</div>
	)
}

// ---- task history -----------------------------------------------------------------------------
export function TaskTable({tasks, showMachine}: {tasks: Task[]; showMachine?: boolean}) {
	return (
		<div className={`mx-table tasks${showMachine ? ' with-machine' : ''}`} role="table">
			<div className="mx-tr head" role="row">
				<span>Start time</span>
				<span>End time</span>
				{showMachine && <span>Machine</span>}
				<span>Description</span>
				<span>Status</span>
			</div>
			{tasks.length === 0 && <div className="mx-tr empty">No tasks yet.</div>}
			{tasks.map((t) => (
				<div className={`mx-tr st-${t.status}`} role="row" key={`${t.machineId ?? ''}${t.id}`}>
					<span>{when(t.startedAt)}</span>
					<span>{t.endedAt ? when(t.endedAt) : ''}</span>
					{showMachine && <span>{t.vmid ? `${t.vmid} (${t.machineName})` : t.machineName}</span>}
					<span>
						{TASK_LABEL[t.type] ?? t.type}
						{t.detail ? ` · ${t.detail}` : ''}
					</span>
					<span className="mx-status">{t.status === 'running' ? <span className="spinner" /> : t.status === 'ok' ? 'OK' : (t.message ?? 'Error')}</span>
				</div>
			))}
		</div>
	)
}
export function HistoryPanel({d}: {d: MachineDetails}) {
	return (
		<div className="mx-panel">
			<TaskTable tasks={d.tasks} />
		</div>
	)
}

// ---- monitor ----------------------------------------------------------------------------------
export function MonitorPanel({d}: {d: MachineDetails}) {
	const action = useMachineAction()
	const [cmd, setCmd] = useState('info status')
	const [log, setLog] = useState<string[]>([])
	const send = () => {
		const c = cmd.trim()
		if (!c) return
		action.mutate(
			{path: 'machines.monitor', input: {id: d.id, command: c}},
			{onSuccess: (r) => setLog((l) => [...l.slice(-40), `# ${c}`, String((r as {output: string}).output).trimEnd()])},
		)
	}
	return (
		<div className="mx-panel">
			<p className="muted">
				QEMU’s monitor for {d.name}. Try <code>info status</code>, <code>info block</code>, <code>info network</code>, <code>info cpus</code>. Commands act on the running machine
				directly, so take care.
			</p>
			<pre className="mx-monitor" aria-live="polite">{log.join('\n') || 'Output appears here.'}</pre>
			<form
				className="mx-inline"
				onSubmit={(e) => {
					e.preventDefault()
					send()
				}}
			>
				<input className="field mono" value={cmd} onChange={(e) => setCmd(e.target.value)} disabled={d.state !== 'running'} spellCheck={false} autoCapitalize="none" />
				<button type="submit" className="btn small primary" disabled={d.state !== 'running' || action.isPending}>
					Send
				</button>
			</form>
			{d.state !== 'running' && <p className="muted mx-small">{d.name} isn’t running.</p>}
		</div>
	)
}

// ---- power and machine actions ----------------------------------------------------------------
// Everything the Proxmox toolbar offers, with the same confirmations everywhere.
export function usePowerActions(d: {id: string; name: string; state: string; protected?: boolean} | null) {
	const action = useMachineAction()
	const confirm = useConfirm()
	if (!d) return null
	const run = (path: string, done: string, input: Record<string, unknown> = {}) => (haptic(8), action.mutate({path, input: {id: d.id, ...input}, done}))
	const s = d.state
	const on = s === 'running' || s === 'suspended'
	return {
		pending: action.isPending,
		canStart: s === 'stopped' || s === 'hibernated' || s === 'error',
		on,
		paused: s === 'suspended',
		start: () => run('machines.start', `${d.name} is starting`),
		shutdown: async () => {
			if (await confirm({title: `Shut down ${d.name}?`, body: 'The machine is asked to shut down, like pressing its power button.', confirm: 'Shut down', icon: 'power'})) run('machines.stop', `${d.name} is shutting down`)
		},
		stop: async () => {
			if (await confirm({title: `Stop ${d.name}?`, body: 'This cuts power to the machine immediately. Unsaved work inside it is lost.', confirm: 'Stop', danger: true, icon: 'stop'})) run('machines.forceStop', `${d.name} stopped`)
		},
		reboot: async () => {
			if (await confirm({title: `Reboot ${d.name}?`, body: 'The machine is asked to restart. Pending hardware changes are applied.', confirm: 'Reboot', icon: 'restart'})) run('machines.restart', `${d.name} is rebooting`)
		},
		pause: () => run('machines.pause', `${d.name} paused`),
		resume: () => run('machines.resume', `${d.name} resumed`),
		hibernate: async () => {
			if (await confirm({title: `Hibernate ${d.name}?`, body: 'Its memory is saved to disk and it stops. Start continues exactly where it left off.', confirm: 'Hibernate', icon: 'power'})) run('machines.hibernate', `${d.name} hibernated`)
		},
		clone: async () => {
			if (await confirm({title: `Clone ${d.name}?`, body: 'A full copy with its own disks and a new network address. The machine must be shut down.', confirm: 'Clone', icon: 'copy'})) run('machines.clone', 'Cloning…')
		},
		remove: async (after?: () => void) => {
			if (d.protected) {
				await confirm({title: `${d.name} is protected`, body: 'Turn off Protection in its options before deleting it.', confirm: 'OK', icon: 'shield'})
				return
			}
			const ok = await confirm({title: `Delete ${d.name}?`, body: `${d.name}, its disks and its snapshots are permanently deleted. Backups in Home → Backups are kept. This can’t be undone.`, confirm: `Delete ${d.name}`, danger: true, icon: 'trash'})
			if (ok) {
				run('machines.uninstall', `${d.name} deleted`)
				after?.()
			}
		},
	}
}

export {duration}
