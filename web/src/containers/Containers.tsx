// Containers (LXC, run by Incus in its per-user mode) on this server: the library of Linux systems
// and your own templates, and each container's power, terminal, resources, start-with-server,
// ports, snapshots, backups, files, notes and protection. Owner-only, like the server's terminal.
import {Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from '../api'
import {useUser} from '../data'
import {isOwner} from '../isOwner'
import {Icon} from '../icons'
import {openTerminalWith} from '../terminalEvent'
import {AddFile, type Download} from '../AddFile'
import {SERVER_FLEET_ID} from '../fleet/list'
import {MachineActions} from '../fleet/machineActions'
import {MachineTabs} from '../fleet/MachineTabs'
import {openStore} from '../fleet/openStore'
import {PinButton} from '../fleet/PinButton'
import {containerAgent, isContainerAgent, isGuestAgent, linuxConnectorOs} from '../swarm/guestLink'
import {agentMay, useSwarm} from '../swarm/Swarm'
import {NixosConfigPanel} from '../nixos/NixosConfigPanel'
import {isNixosOs, NIXOS_EXAMPLE_LXC} from '../nixos/example'
import {Group, PortalRoot, Row, Sheet, SheetHeader, Spark, StatusPill, Switch, haptic, useConfirm, useToast} from '../ui'

const MachineFiles = lazy(() => import('../screens/Files').then((m) => ({default: m.Files})))

const TerminalScreen = lazy(() => import('../Terminal').then((m) => ({default: m.TerminalScreen})))

export type ContainerStatus = {available: true; version: string | null} | {available: false; reason: string; setupCommand: string}
export type Container = {
	name: string
	status: string
	os: string
	release: string
	description: string
	cpus: number | null
	cpuAllowance: number | null
	cpuPriority: number | null
	memory: string | null
	swap: boolean
	disk: string | null
	memoryUsedGiB: number | null
	addresses: {family: string; address: string}[]
	ports: {protocol: 'tcp' | 'udp'; hostPort: number; containerPort: number | null}[]
	snapshots: {name: string; createdAt: string | null}[]
	autostart: boolean
	bootOrder: number
	bootDelay: number
	protected: boolean
	notes: string
	tags: string[]
	job: string | null
	error: string | null
	from?: string | null
	// Not in Incus yet: being created, cloned or restored (or that failed).
	pending?: boolean
	progress?: string | null
	startedAt?: string | null
	nixos?: boolean
	hostId?: string
}
type Distro = {os: string; name: string; releases: {alias: string; release: string; description: string}[]}
type Template = {alias: string; name: string; os: string; release: string; size: number; from: string}
type Backup = {file: string; name: string; createdAt: string; size: number}
type Stats = Record<string, {cpu: number[]; rxKBs: number[]; txKBs: number[]}>
type Entry = {name: string; type: 'folder' | 'file' | 'link'; size: number | null}

const OS_COLOR: Record<string, string> = {
	debian: '#d70a53',
	ubuntu: '#e95420',
	alpine: '#0d597f',
	archlinux: '#1793d1',
	fedora: '#3c6eb4',
	rockylinux: '#10b981',
	almalinux: '#0f4266',
	centos: '#a14f8c',
	opensuse: '#73ba25',
	devuan: '#5c5c7a',
	gentoo: '#54487a',
	nixos: '#5277c3',
}
const osColor = (os: string) => OS_COLOR[os] ?? '#4b5563'
const OS_NAME: Record<string, string> = {archlinux: 'Arch Linux', rockylinux: 'Rocky Linux', almalinux: 'AlmaLinux', centos: 'CentOS Stream', opensuse: 'openSUSE', nixos: 'NixOS'}
const osLabel = (c: {os: string; release: string}) => [OS_NAME[c.os] ?? (c.os ? c.os[0].toUpperCase() + c.os.slice(1) : ''), c.release].filter(Boolean).join(' ')
const bytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const plain = (e: Error) => e.message.replace(/^[A-Z_]+: /, '')

/** Machine reach for a system container: Online / Offline / Paused, same words as other machines. */
export function containerPill(c: Pick<Container, 'status' | 'job'>): {kind: 'running' | 'stopped' | 'busy' | 'error'; label: string} {
	if (c.job) return {kind: 'busy', label: c.job}
	const s = c.status
	if (s === 'running') return {kind: 'running', label: 'Online'}
	if (s === 'stopped') return {kind: 'stopped', label: 'Offline'}
	if (['creating', 'cloning', 'restoring', 'starting', 'stopping'].includes(s)) return {kind: 'busy', label: s.charAt(0).toUpperCase() + s.slice(1)}
	if (s === 'frozen') return {kind: 'stopped', label: 'Paused'}
	return {kind: 'error', label: s === 'error' ? 'Failed' : s}
}

export function containerState(c: Pick<Container, 'status'>): string {
	if (c.status === 'frozen') return 'frozen'
	if (c.status === 'running') return 'running'
	if (['creating', 'cloning', 'restoring', 'starting', 'stopping', 'error'].includes(c.status)) return c.status
	return 'stopped'
}

export {osColor}

export function useContainerStatus(enabled = true) {
	return useQuery({
		queryKey: ['containers.status'],
		queryFn: () => query<ContainerStatus>('containers.status'),
		retry: false,
		enabled,
		staleTime: 60_000,
		// While containers aren't set up, check every few seconds so the page moves on by itself
		// as soon as machines-add-lxc finishes.
		refetchInterval: (q) => (q.state.data && !q.state.data.available ? 5000 : false),
	})
}
export function useContainers(enabled: boolean) {
	return useQuery({
		queryKey: ['containers.list'],
		queryFn: () => query<Container[]>('containers.list'),
		enabled,
		refetchInterval: (q) => ((q.state.data ?? []).some((c) => containerPill(c).kind === 'busy') ? 2000 : 8000),
	})
}

export function useContainerAction() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: (a: {path: string; input: unknown; done?: string}) => mutate(a.path, a.input),
		onSuccess: (_r, a) => a.done && toast(a.done),
		onError: (e: Error) => !/STOP_TIMED_OUT/.test(e.message) && toast(plain(e), true),
		onSettled: (_r, _e, a) => {
			qc.invalidateQueries({queryKey: ['containers.list']})
			if (/Template/.test(a.path) || a.path === 'containers.create') qc.invalidateQueries({queryKey: ['containers.templates']})
			if (/ackup/.test(a.path)) qc.invalidateQueries({queryKey: ['containers.backups']})
			if (a.path === 'containers.installConnector') qc.invalidateQueries({queryKey: ['swarm.list']})
		},
	})
}

function ContainerRow({c, onOpen}: {c: Container; onOpen: () => void}) {
	const pill = containerPill(c)
	return (
		<Row
			icon="category"
			color={osColor(c.os)}
			label={c.name}
			sub={c.progress || [osLabel(c) || (c.from ? `from ${c.from}` : ''), c.addresses.find((a) => a.family === 'IPv4')?.address, c.tags.join(', ')].filter(Boolean).join(' · ') || 'Container'}
			trailing={<StatusPill {...pill} />}
			onClick={() => (haptic(6), onOpen())}
		/>
	)
}

export function ContainersPanel({serverName}: {serverName: string}) {
	const status = useContainerStatus()
	const ready = status.data?.available === true
	const list = useContainers(ready)
	const [open, setOpen] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)

	if (status.isLoading) return <div className="skeleton" style={{height: 120, borderRadius: 16}} />
	if (status.data && !status.data.available) return <SetUp status={status.data} onCheck={() => status.refetch()} checking={status.isFetching} />
	if (status.isError) return <p className="quiet">{(status.error as Error).message}</p>

	const rows = list.data ?? []
	const current = open ? rows.find((c) => c.name === open) : null
	if (creating) return <CreateContainer onDone={() => setCreating(false)} existing={rows.map((c) => c.name)} serverName={serverName} />
	return (
		<>
			{list.isLoading ? (
				<div className="skeleton" style={{height: 80, borderRadius: 16}} />
			) : rows.length === 0 ? (
				<p className="quiet">No containers on {serverName}. A container is a lightweight Linux system that shares this server’s kernel: it starts in seconds and uses far less memory than a virtual machine.</p>
			) : (
				rows.map((c) => <ContainerRow key={c.name} c={c} onOpen={() => setOpen(c.name)} />)
			)}
			{open && current && <ContainerSheet c={current} all={rows} onClose={() => setOpen(null)} onOpen={setOpen} />}
			<button type="button" className="btn small" style={{margin: '8px 12px 12px'}} onClick={() => (haptic(6), setCreating(true))}>
				<Icon name="plus" size={15} /> New container
			</button>
		</>
	)
}

/** "Add → Container" on the Machines page: setup first if it's needed, then the library. */
export function NewContainerSheet({onClose}: {onClose: () => void}) {
	const status = useContainerStatus()
	const list = useContainers(status.data?.available === true)
	return (
		<Sheet open onClose={onClose} label="New LXC container" tall>
			<div style={{padding: '4px 16px 24px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0}}>
				{status.isLoading ? (
					<div className="skeleton" style={{height: 160, borderRadius: 16}} />
				) : status.data && !status.data.available ? (
					<>
						<div style={{display: 'flex', alignItems: 'center', gap: 8}}>
							<button type="button" className="btn small" onClick={onClose}>
								<Icon name="close" size={15} /> Close
							</button>
							<b>New LXC container</b>
						</div>
						<SetUp status={status.data} onCheck={() => status.refetch()} checking={status.isFetching} />
					</>
				) : status.isError ? (
					<p className="quiet">{(status.error as Error).message}</p>
				) : (
					<CreateContainer onDone={onClose} existing={(list.data ?? []).map((c) => c.name)} backLabel="Close" serverName={undefined} />
				)}
			</div>
		</Sheet>
	)
}

/** An LXC container's page in a sheet: like a virtual machine's (header, its screen, then its sections). */
export function ContainerSheet({c, all, onClose, onOpen}: {c: Container; all: Container[]; onClose: () => void; onOpen: (name: string) => void}) {
	return (
		<Sheet open onClose={onClose} label={c.name} tall>
			<ContainerDetail c={c} all={all} onBack={onClose} onOpen={onOpen} />
		</Sheet>
	)
}

function SetUp({status, onCheck, checking}: {status: Extract<ContainerStatus, {available: false}>; onCheck: () => void; checking: boolean}) {
	const toast = useToast()
	return (
		<div className="glass" style={{padding: 16, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0}}>
			<b>Set up LXC containers</b>
			<span className="quiet">{status.reason}</span>
			<span className="quiet">
				Run this one command in a terminal on this server. It asks for your password, sets up Incus in its per-user mode (your own walled-off space for containers; nothing is opened to the network until you add a port), and is safe to run again:
			</span>
			<pre className="mono" style={{fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0}}>
				{status.setupCommand}
			</pre>
			<div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
				<button type="button" className="btn small" onClick={() => (haptic(6), openTerminalWith(status.setupCommand))}>
					<Icon name="terminal" size={15} /> Open in Terminal
				</button>
				<button
					type="button"
					className="btn small"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(status.setupCommand)
							toast('Copied')
						} catch {
							toast('Couldn’t copy here. Select the text instead.', true)
						}
					}}
				>
					<Icon name="copy" size={15} /> Copy
				</button>
				<button type="button" className="btn small" disabled={checking} onClick={onCheck}>
					{checking ? <span className="spinner" /> : <Icon name="restart" size={15} />} Check again
				</button>
			</div>
		</div>
	)
}

const NAME = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
const nameProblemOf = (name: string, existing: string[]) => (!name ? 'Give it a name' : !NAME.test(name) ? 'Lowercase letters, numbers and dashes, starting with a letter' : existing.includes(name) ? 'That name is taken' : null)

function TextField({id, label, value, onChange, hint, placeholder, numeric, type, area}: {id: string; label: string; value: string; onChange: (v: string) => void; hint?: ReactNode; placeholder?: string; numeric?: boolean; type?: string; area?: boolean}) {
	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			{area ? (
				<textarea id={id} value={value} placeholder={placeholder} rows={3} onChange={(e) => onChange(e.target.value)} />
			) : (
				<input
					id={id}
					type={type}
					value={value}
					placeholder={placeholder}
					inputMode={numeric ? 'numeric' : undefined}
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
					onChange={(e) => onChange(numeric ? e.target.value.replace(/\D/g, '') : e.target.value)}
				/>
			)}
			{hint ? <span className="hint">{hint}</span> : null}
		</div>
	)
}

function SwitchRow({label, sub, on, onChange, disabled}: {label: string; sub?: ReactNode; on: boolean; onChange: (v: boolean) => void; disabled?: boolean}) {
	return (
		<div className="row static">
			<span className="main">
				<b style={{fontWeight: 550}}>{label}</b>
				{sub ? <span>{sub}</span> : null}
			</span>
			<Switch on={on} onChange={onChange} label={label} disabled={disabled} />
		</div>
	)
}

type CreateHost = {id: string; name: string}

function HostPick({host, online, onPick}: {host: CreateHost; online: boolean; onPick: () => void}) {
	const remote = host.id !== SERVER_FLEET_ID
	const status = useQuery({
		queryKey: ['containers.hostStatus', host.id],
		queryFn: () => query<ContainerStatus>('containers.hostStatus', remote ? {hostId: host.id} : undefined),
		enabled: remote && online,
		staleTime: 60_000,
	})
	const unavailable = remote && status.data && !status.data.available
	const setupReason = status.data && !status.data.available ? status.data.reason : ''
	const sub = !online ? 'Offline right now' : unavailable ? setupReason : remote ? 'Joined computer' : 'This server'
	return (
		<Row
			icon="machine"
			label={host.name}
			sub={sub}
			onClick={() => online && !unavailable && (haptic(6), onPick())}
			trailing={!online || unavailable ? <span className="quiet">Unavailable</span> : undefined}
		/>
	)
}

function HostStatusRow({host, onBack}: {host: CreateHost; onBack: () => void}) {
	const remote = host.id !== SERVER_FLEET_ID
	const status = useQuery({
		queryKey: ['containers.hostStatus', host.id],
		queryFn: () => query<ContainerStatus>('containers.hostStatus', remote ? {hostId: host.id} : undefined),
		enabled: remote,
		staleTime: 60_000,
	})
	if (!remote) return null
	if (status.isLoading) return <div className="skeleton" style={{height: 56, borderRadius: 12}} />
	if (status.isError) return <p className="quiet">{(status.error as Error).message}</p>
	if (status.data && !status.data.available)
		return (
			<>
				<Row icon="back" label={`Back to hosts`} onClick={onBack} />
				<SetUp status={status.data} onCheck={() => status.refetch()} checking={status.isFetching} />
			</>
		)
	return null
}

function CreateContainer({
	onDone,
	existing,
	backLabel = 'LXC containers',
	serverName = 'This server',
}: {
	onDone: () => void
	existing: string[]
	backLabel?: string
	serverName?: string
}) {
	const swarm = useSwarm()
	const computers = (swarm.data ?? []).filter((a) => !isGuestAgent(a) && !isContainerAgent(a))
	const hosts = useMemo<CreateHost[]>(
		() => [{id: SERVER_FLEET_ID, name: serverName}, ...computers.map((a) => ({id: a.id, name: a.name}))],
		[computers, serverName],
	)
	const [host, setHost] = useState<CreateHost | null>(hosts.length > 1 ? null : hosts[0])
	const [everything, setEverything] = useState(false)
	const library = useQuery({queryKey: ['containers.images', everything], queryFn: () => query<Distro[]>('containers.images', {all: everything}), staleTime: 30 * 60_000, retry: false})
	const mine = useQuery({queryKey: ['containers.templates'], queryFn: () => query<Template[]>('containers.templates'), retry: false})
	const tplFiles = useQuery({
		queryKey: ['containers.templateFiles'],
		queryFn: () => query<{files: {path: string; name: string; size: number}[]; downloads: Download[]; imports: {template: string; file: string; error: string | null}[]}>('containers.templateFiles'),
		retry: false,
		refetchInterval: (q) => (q.state.data && (q.state.data.downloads.some((d) => !d.error) || q.state.data.imports.some((i) => !i.error)) ? 2000 : false),
	})
	const qc = useQueryClient()
	const toast = useToast()
	const importing = tplFiles.data?.imports ?? []
	const wasImporting = useRef(0)
	useEffect(() => {
		const now = importing.filter((i) => !i.error).length
		if (now < wasImporting.current) qc.invalidateQueries({queryKey: ['containers.templates']})
		wasImporting.current = now
	}, [importing, qc])
	const importFile = async (path: string) => {
		try {
			const r = await mutate<{template: string}>('containers.importTemplate', {path})
			toast(`Importing as the template ${r.template}`)
			qc.invalidateQueries({queryKey: ['containers.templateFiles']})
		} catch (e) {
			toast(plain(e as Error), true)
		}
	}
	const action = useContainerAction()
	const [image, setImage] = useState<{id: string; label: string; os: string} | null>(null)
	const [name, setName] = useState('')
	const [cpus, setCpus] = useState('1')
	const [memory, setMemory] = useState('1024')
	const [disk, setDisk] = useState('8')
	const [autostart, setAutostart] = useState(true)
	const [password, setPassword] = useState('')
	const [sshKey, setSshKey] = useState('')
	const [nixosConfig, setNixosConfig] = useState('')
	const nixosImage = image ? isNixosOs(image.os) : false
	const nameProblem = nameProblemOf(name, existing)
	const pick = (id: string, label: string, os: string, suggested: string) => (haptic(6), setImage({id, label, os}), setName(name || suggested))
	const remote = host?.id !== SERVER_FLEET_ID
	const hostReady = useQuery({
		queryKey: ['containers.hostStatus', host?.id ?? SERVER_FLEET_ID],
		queryFn: () => query<ContainerStatus>('containers.hostStatus', remote ? {hostId: host!.id} : undefined),
		enabled: !!host && remote,
		staleTime: 60_000,
	})
	const create = () =>
		action.mutate(
			{
				path: 'containers.create',
				input: {
					name,
					image: image!.id,
					cpus: Number(cpus),
					memoryMiB: Number(memory),
					diskGiB: Number(disk),
					autostart,
					...(remote
						? {}
						: {
								rootPassword: password || undefined,
								sshKey: sshKey.trim() || undefined,
							}),
					...(host && host.id !== SERVER_FLEET_ID ? {hostId: host.id} : {}),
					...(nixosImage && nixosConfig.trim() ? {nixosConfig} : {}),
				},
				done: `Creating ${name}. The first container of a system takes a minute to download.`,
			},
			{onSuccess: onDone},
		)
	if (!host) {
		return (
			<div className="ct-col" style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0}}>
				<div style={{display: 'flex', alignItems: 'center', gap: 8}}>
					<button type="button" className="btn small" onClick={onDone}>
						<Icon name={backLabel === 'Close' ? 'close' : 'back'} size={15} /> {backLabel}
					</button>
					<b>Where should it run?</b>
				</div>
				<Group title="Host">
					{hosts.map((h) => (
						<HostPick key={h.id} host={h} online={h.id === SERVER_FLEET_ID || !!computers.find((a) => a.id === h.id)?.online} onPick={() => setHost(h)} />
					))}
				</Group>
			</div>
		)
	}
	const remoteBlocked = remote && hostReady.data && !hostReady.data.available
	return (
		<div className="ct-col" style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0}}>
			<div style={{display: 'flex', alignItems: 'center', gap: 8}}>
				<button type="button" className="btn small" onClick={hosts.length > 1 ? () => setHost(null) : onDone}>
					<Icon name={hosts.length > 1 ? 'back' : backLabel === 'Close' ? 'close' : 'back'} size={15} /> {hosts.length > 1 ? 'Hosts' : backLabel}
				</button>
				<b>New LXC container{hosts.length > 1 ? ` on ${host.name}` : ''}</b>
			</div>
			{remoteBlocked ? <HostStatusRow host={host} onBack={() => setHost(null)} /> : null}
			{!remoteBlocked && !image ? (
				<>
					{!remote && !!mine.data?.length && (
						<Group title="Your templates">
							{mine.data.map((t) => (
								<Row key={t.alias} icon="save" color={osColor(t.os)} label={t.name} sub={[osLabel(t), t.from && `from ${t.from}`, t.size ? bytes(t.size) : ''].filter(Boolean).join(' · ')} onClick={() => pick(`template:${t.alias}`, t.name, t.os, `${t.name}-1`)} />
							))}
						</Group>
					)}
					{!remote ? (
						<>
							<Group title="Template files on this server" footer="Container templates in your Home folder, like a Proxmox CT template (.tar.zst, .tar.xz, .tar.gz) or an Incus image. Importing one adds it to Your templates. Images made for Incus or LXD work best; a Proxmox template may need its network set up inside.">
								{importing.map((i) => (
									<Row key={i.template} icon="save" label={i.error ? `${i.template}: couldn’t import` : `Importing ${i.template}…`} sub={i.error ?? i.file} />
								))}
								{(tplFiles.data?.files ?? []).map((f) => (
									<Row
										key={f.path}
										icon="zip"
										label={f.name}
										sub={`${bytes(f.size)} · ${f.path.replace(/^\/Home\//, '')}`}
										trailing={
											<button type="button" className="btn small" onClick={() => importFile(f.path)}>
												Import
											</button>
										}
									/>
								))}
								{!tplFiles.isLoading && !tplFiles.data?.files.length && !importing.length && <p className="quiet" style={{padding: '4px 12px'}}>None yet.</p>}
							</Group>
							<AddFile
								what="a template"
								accept=".gz,.xz,.zst,.bz2,.tgz,.txz"
								linkProcedure="containers.downloadTemplate"
								linkPlaceholder="https://…/debian-12-standard_amd64.tar.zst"
								downloads={tplFiles.data?.downloads ?? []}
								onAdded={() => qc.invalidateQueries({queryKey: ['containers.templateFiles']})}
							/>
						</>
					) : null}
					<div className="glass group" style={{padding: '2px 0'}}>
						<SwitchRow label="Show every system" sub="All of Incus’s library, not only the main ones." on={everything} onChange={setEverything} />
					</div>
					{library.isLoading ? (
						<div className="skeleton" style={{height: 200, borderRadius: 16}} />
					) : library.isError ? (
						<p className="quiet">{(library.error as Error).message}</p>
					) : !library.data?.length ? (
						<p className="quiet">The library came back empty. Check that this server can reach images.linuxcontainers.org, then come back.</p>
					) : (
						(library.data ?? []).map((d) => (
							<Group key={d.os} title={d.name}>
								{d.releases.map((r) => (
									<Row key={r.alias} icon="category" color={osColor(d.os)} label={`${d.name} ${r.release}`} sub={r.alias} onClick={() => pick(r.alias, `${d.name} ${r.release}`, d.os, `${d.os === 'archlinux' ? 'arch' : d.os}-1`)} />
								))}
							</Group>
						))
					)}
				</>
			) : !remoteBlocked && image ? (
				<div className="glass group" style={{padding: '12px 14px'}}>
					<Row icon="category" color={osColor(image.os)} label={image.label} sub="Change" onClick={() => setImage(null)} />
					<TextField id="ct-name" label="Name" value={name} onChange={(v) => setName(v.toLowerCase())} hint={name && nameProblem} />
					<TextField id="ct-cpu" label="CPUs" value={cpus} onChange={setCpus} numeric />
					<TextField id="ct-mem" label="Memory (MB)" value={memory} onChange={setMemory} numeric />
					<TextField id="ct-disk" label="Disk (GB)" value={disk} onChange={setDisk} numeric />
					<SwitchRow
						label={remote ? 'Start with the computer' : 'Start with the server'}
						sub={remote ? 'Starts by itself after that computer restarts.' : 'Starts by itself after the server restarts.'}
						on={autostart}
						onChange={setAutostart}
					/>
					{remote ? (
						<p className="hint" style={{margin: '4px 2px 8px', color: 'var(--muted)', fontSize: 13}}>
							Sign-in stays with the image. A root password and an SSH key are set when the container runs on this server.
						</p>
					) : (
						<>
							<TextField id="ct-pw" label="Root password (optional)" type="password" value={password} onChange={setPassword} hint="For signing in on this container or over SSH. It isn’t stored by My Own Data Center." />
							<TextField id="ct-key" label="SSH public key (optional)" value={sshKey} onChange={setSshKey} placeholder="ssh-ed25519 AAAA… you@laptop" area hint="Added for root. Install an SSH server inside to use it." />
						</>
					)}
					{nixosImage ? (
						<TextField
							id="ct-nixos-config"
							label="NixOS configuration"
							value={nixosConfig}
							onChange={setNixosConfig}
							area
							placeholder={NIXOS_EXAMPLE_LXC}
							hint={
								remote
									? 'Optional. Saved on that computer and mounted into the container; the guest applies it on boot.'
									: 'Optional. Saved on this server and mounted into the container; the guest applies it on boot.'
							}
						/>
					) : null}
					<button type="button" className="btn block" style={{marginTop: 8}} disabled={!!nameProblem || action.isPending} onClick={create}>
						{action.isPending ? <span className="spinner" /> : <Icon name="plus" size={18} />} Create container
					</button>
				</div>
			) : null}
		</div>
	)
}

/** The container's console inside its page, the way a VM's screen sits in its page. */
function EmbeddedConsole({name, onFull}: {name: string; onFull: () => void}) {
	const [el, setEl] = useState<HTMLDivElement | null>(null)
	const [on, setOn] = useState(true)
	return (
		<div style={{display: 'grid', gap: 8, minWidth: 0}}>
			<div
				ref={setEl}
				className="ct-console"
				style={{position: 'relative', height: 340, borderRadius: 16, overflow: 'hidden', transform: 'translateZ(0)', background: '#000'}}
				aria-label={`${name} Terminal`}
			>
				{el && on && (
					<PortalRoot.Provider value={el}>
						<Suspense fallback={null}>
							{/* Enter brings up the login prompt. */}
							<TerminalScreen embedded container={{name, mode: 'console'}} input={'\r'} onClose={() => setOn(false)} />
						</Suspense>
					</PortalRoot.Provider>
				)}
				{!on && (
					<button type="button" className="btn small" style={{position: 'absolute', inset: 0, margin: 'auto', width: 'fit-content', height: 'fit-content'}} onClick={() => setOn(true)}>
						<Icon name="terminal" size={15} /> Show Terminal
					</button>
				)}
			</div>
			<div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
				<button type="button" className="btn small" onClick={onFull}>
					<Icon name="fullscreen" size={15} /> Full screen
				</button>
			</div>
		</div>
	)
}

function Graphs({c}: {c: Container}) {
	const stats = useQuery({queryKey: ['containers.stats'], queryFn: () => query<Stats>('containers.stats'), refetchInterval: 5000, enabled: c.status === 'running'})
	const s = stats.data?.[c.name]
	if (c.status !== 'running') return null
	const card = (label: string, value: string, series: number[], color: string, max?: number) => (
		<div className="glass" style={{padding: '10px 12px', display: 'grid', gap: 4, minWidth: 0}}>
			<span className="muted" style={{fontSize: 12}}>{label}</span>
			<b>{value}</b>
			<Spark series={series} color={color} label={`${label} over the last few minutes`} max={max} />
		</div>
	)
	const net = s ? s.rxKBs.map((r, i) => r + (s.txKBs[i] ?? 0)) : []
	return (
		<div style={{display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10}}>
			{card('CPU', s?.cpu.length ? `${s.cpu.at(-1)}%` : '…', s?.cpu ?? [], 'var(--blue)', 100)}
			{card('Network', net.length ? `↓ ${s!.rxKBs.at(-1)} · ↑ ${s!.txKBs.at(-1)} KB/s` : '…', net, 'var(--green)', Math.max(64, ...net))}
		</div>
	)
}

function Resources({c, busy, run}: {c: Container; busy: boolean; run: (path: string, done?: string, extra?: Record<string, unknown>) => void}) {
	const [edit, setEdit] = useState(false)
	const diskNow = /^(\d+)GiB$/.exec(c.disk ?? '')?.[1] ?? ''
	const memNow = /^(\d+)MiB$/.exec(c.memory ?? '')?.[1] ?? ''
	const [f, setF] = useState({cpus: String(c.cpus ?? 1), share: String(c.cpuAllowance ?? ''), priority: String(c.cpuPriority ?? 5), memory: memNow, swap: c.swap, disk: diskNow})
	if (!edit)
		return (
			<Group title="Resources">
				<Row icon="cpu" label="CPUs" value={[c.cpus ?? 'Any', c.cpuAllowance ? `capped at ${c.cpuAllowance}%` : null].filter(Boolean).join(', ')} />
				<Row icon="memory" label="Memory" value={[c.memoryUsedGiB !== null ? `${c.memoryUsedGiB} GB used` : null, c.memory ? `of ${c.memory.replace('MiB', ' MB')}` : null, c.swap ? null : 'no swap'].filter(Boolean).join(' ') || '—'} />
				<Row icon="disk" label="Disk" value={c.disk?.replace('GiB', ' GB') ?? '—'} />
				<Row icon="network" label="Address" value={c.addresses.map((a) => a.address).join(', ') || (c.status === 'running' ? 'Waiting for an address…' : '—')} />
				<Row icon="pencil" label="Change resources" onClick={() => setEdit(true)} />
			</Group>
		)
	return (
		<Group title="Resources" footer="CPU and memory change straight away, even while it runs. A disk can grow but not shrink.">
			<div style={{padding: '4px 12px 12px'}}>
				<TextField id="r-cpu" label="CPUs" value={f.cpus} onChange={(v) => setF({...f, cpus: v})} numeric />
				<TextField id="r-share" label="CPU cap (%)" value={f.share} onChange={(v) => setF({...f, share: v})} numeric placeholder="No cap" hint="The most of its CPUs it may use, like 50 for half." />
				<TextField id="r-prio" label="CPU priority (0–10)" value={f.priority} onChange={(v) => setF({...f, priority: v})} numeric hint="When the server is busy, higher numbers get CPU first." />
				<TextField id="r-mem" label="Memory (MB)" value={f.memory} onChange={(v) => setF({...f, memory: v})} numeric />
				<SwitchRow label="Allow swap" on={f.swap} onChange={(swap) => setF({...f, swap})} />
				<TextField id="r-disk" label="Disk (GB)" value={f.disk} onChange={(v) => setF({...f, disk: v})} numeric />
				<div style={{display: 'flex', gap: 8, marginTop: 8}}>
					<button type="button" className="btn small" onClick={() => setEdit(false)}>
						Cancel
					</button>
					<button
						type="button"
						className="btn small"
						disabled={busy}
						onClick={() => {
							run('containers.setResources', 'Resources changed', {
								cpus: Number(f.cpus),
								cpuAllowance: f.share ? Number(f.share) : c.cpuAllowance ? null : undefined,
								cpuPriority: Number(f.priority),
								...(f.memory ? {memoryMiB: Number(f.memory)} : {}),
								swap: f.swap,
								...(f.disk && f.disk !== diskNow ? {diskGiB: Number(f.disk)} : {}),
							})
							setEdit(false)
						}}
					>
						<Icon name="check" size={14} /> Save
					</button>
				</div>
			</div>
		</Group>
	)
}

function Boot({c, busy, run}: {c: Container; busy: boolean; run: (path: string, done?: string, extra?: Record<string, unknown>) => void}) {
	const [order, setOrder] = useState(String(c.bootOrder))
	const [delay, setDelay] = useState(String(c.bootDelay))
	return (
		<Group title="Start with the server" footer="Higher numbers start first and shut down last. The delay waits after starting this one, before the next.">
			<SwitchRow label="Start when the server starts" on={c.autostart} disabled={busy} onChange={(autostart) => run('containers.setOptions', autostart ? `${c.name} starts with the server` : `${c.name} stays off after a restart`, {autostart})} />
			{c.autostart && (
				<div style={{display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 12px 12px', alignItems: 'end'}}>
					<div style={{flex: '1 1 120px', minWidth: 0}}>
						<TextField id="b-order" label="Start order" value={order} onChange={setOrder} numeric />
					</div>
					<div style={{flex: '1 1 120px', minWidth: 0}}>
						<TextField id="b-delay" label="Delay (s)" value={delay} onChange={setDelay} numeric />
					</div>
					<button type="button" className="btn small" disabled={busy || (order === String(c.bootOrder) && delay === String(c.bootDelay))} onClick={() => run('containers.setOptions', 'Saved', {bootOrder: Number(order || 0), bootDelay: Number(delay || 0)})}>
						Save
					</button>
				</div>
			)}
		</Group>
	)
}

function Backups({c, busy, all}: {c: Container; busy: boolean; all: Container[]}) {
	const list = useQuery({queryKey: ['containers.backups', c.name], queryFn: () => query<Backup[]>('containers.backups', {name: c.name}), refetchInterval: c.job === 'backing up' ? 3000 : false})
	const action = useContainerAction()
	const confirm = useConfirm()
	const [restoreAs, setRestoreAs] = useState<string | null>(null)
	const [as, setAs] = useState('')
	const taken = all.map((x) => x.name)
	return (
		<Group title="Backups" footer="A backup is a single file with the whole container (without its snapshots), kept in My Own Data Center’s data folder on this server.">
			{(list.data ?? []).map((b) => (
				<div key={b.file}>
					<Row
						icon="restore"
						label={new Date(b.createdAt).toLocaleString()}
						sub={bytes(b.size)}
						trailing={
							<span style={{display: 'inline-flex', gap: 6}}>
								<button type="button" className="btn small" disabled={busy} onClick={() => (setRestoreAs(b.file), setAs(`${c.name}-restored`))}>
									Restore
								</button>
								<button type="button" className="btn small" aria-label="Delete backup" disabled={busy} onClick={async () => (await confirm({title: 'Delete this backup?', body: 'This can’t be undone.', confirm: 'Delete', danger: true, icon: 'alert'})) && action.mutate({path: 'containers.deleteBackup', input: {file: b.file}, done: 'Backup deleted'})}>
									<Icon name="trash" size={14} />
								</button>
							</span>
						}
					/>
					{restoreAs === b.file && (
						<div style={{display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 12px 12px', alignItems: 'end'}}>
							<div style={{flex: '1 1 120px', minWidth: 0}}>
								<TextField id="bk-as" label="Restore as a new container named" value={as} onChange={(v) => setAs(v.toLowerCase())} hint={nameProblemOf(as, taken)} />
							</div>
							<button type="button" className="btn small" disabled={!!nameProblemOf(as, taken) || action.isPending} onClick={() => action.mutate({path: 'containers.restoreBackup', input: {file: b.file, as}, done: `Restoring as ${as}`}, {onSuccess: () => setRestoreAs(null)})}>
								Restore
							</button>
						</div>
					)}
				</div>
			))}
			{!list.isLoading && !list.data?.length && <p className="quiet" style={{padding: '4px 12px'}}>No backups yet.</p>}
			<Row icon="download" label={c.job === 'backing up' ? 'Backing up…' : 'Back up now'} disabled={busy} onClick={() => action.mutate({path: 'containers.backup', input: {name: c.name}, done: `Backing up ${c.name}`})} />
		</Group>
	)
}

function Files({c}: {c: Container}) {
	const [path, setPath] = useState('/root')
	const [show, setShow] = useState(false)
	const toast = useToast()
	const qc = useQueryClient()
	const input = useRef<HTMLInputElement>(null)
	const [uploading, setUploading] = useState(false)
	const dir = useQuery({queryKey: ['containers.files', c.name, path], queryFn: () => query<{path: string; entries: Entry[]}>('containers.files', {name: c.name, path}), enabled: show && c.status === 'running', retry: false})
	const join = (name: string) => `${path === '/' ? '' : path}/${name}`
	const up = () => setPath(path.split('/').slice(0, -1).join('/') || '/')
	if (c.status !== 'running')
		return (
			<Group title="Files">
				<p className="quiet" style={{padding: '4px 12px'}}>Start {c.name} to browse its files.</p>
			</Group>
		)
	if (!show)
		return (
			<Group title="Files">
				<Row icon="folder" label="Browse files" sub="Download from it, upload to it, or copy into the server’s Downloads" onClick={() => setShow(true)} />
			</Group>
		)
	const upload = async (file: File) => {
		setUploading(true)
		try {
			const r = await fetch(`/api/containers/files/upload?${new URLSearchParams({name: c.name, path: join(file.name)})}`, {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/octet-stream'}, body: file})
			if (!r.ok) {
				const err = await r.json().catch(() => null)
				throw new Error(err?.error?.message || err?.error || `Upload failed (${r.status})`)
			}
			toast(`Uploaded ${file.name}`)
			qc.invalidateQueries({queryKey: ['containers.files', c.name, path]})
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setUploading(false)
		}
	}
	const toServer = async (name: string) => {
		try {
			const res = await mutate<{path: string}>('containers.copyToServer', {name: c.name, path: join(name)})
			toast(`Copied to ${res.path.replace(/^\/Home\//, '')}`)
		} catch (e) {
			toast(plain(e as Error), true)
		}
	}
	return (
		<Group title={`Files · ${path}`}>
			{path !== '/' && <Row icon="back" label="Up a folder" onClick={up} />}
			{dir.isLoading && <div className="skeleton" style={{height: 60, margin: 12, borderRadius: 12}} />}
			{dir.isError && <p className="quiet" style={{padding: '4px 12px'}}>{plain(dir.error as Error)}</p>}
			{(dir.data?.entries ?? []).slice(0, 300).map((e) =>
				e.type === 'folder' ? (
					<Row key={e.name} icon="folder" label={e.name} onClick={() => setPath(join(e.name))} />
				) : (
					<Row
						key={e.name}
						icon="file"
						label={e.name}
						sub={e.size !== null ? bytes(e.size) : e.type}
						trailing={
							<span style={{display: 'inline-flex', gap: 6}}>
								<a className="btn small" aria-label={`Download ${e.name}`} href={`/api/containers/files/download?${new URLSearchParams({name: c.name, path: join(e.name)})}`} download={e.name}>
									<Icon name="download" size={14} />
								</a>
								<button type="button" className="btn small" aria-label={`Copy ${e.name} to the server’s Downloads`} onClick={() => toServer(e.name)}>
									<Icon name="copy" size={14} />
								</button>
							</span>
						}
					/>
				),
			)}
			<input ref={input} type="file" hidden onChange={(e) => (e.target.files?.[0] && upload(e.target.files[0]), (e.target.value = ''))} />
			<Row icon="upload" label={uploading ? 'Uploading…' : `Upload into ${path}`} disabled={uploading} onClick={() => input.current?.click()} />
		</Group>
	)
}

function NotesAndTags({c, busy, run}: {c: Container; busy: boolean; run: (path: string, done?: string, extra?: Record<string, unknown>) => void}) {
	const [notes, setNotes] = useState(c.notes)
	const [tags, setTags] = useState(c.tags.join(', '))
	useEffect(() => setNotes(c.notes), [c.notes])
	useEffect(() => setTags(c.tags.join(', ')), [c.tags.join(',')])
	const changed = notes !== c.notes || tags !== c.tags.join(', ')
	return (
		<Group title="Notes and tags">
			<div style={{padding: '4px 12px 12px'}}>
				<TextField id="n-notes" label="Notes" value={notes} onChange={setNotes} area placeholder="What it’s for, how to reach it…" />
				<TextField id="n-tags" label="Tags" value={tags} onChange={setTags} placeholder="dns, home" hint="Short words, separated by commas. The Machines search finds them." />
				<button
					type="button"
					className="btn small"
					disabled={busy || !changed}
					onClick={() =>
						run('containers.setOptions', 'Saved', {
							notes,
							tags: tags
								.split(',')
								.map((t) => t.trim())
								.filter(Boolean),
						})
					}
				>
					<Icon name="check" size={14} /> Save
				</button>
			</div>
		</Group>
	)
}

export function ContainerDetail({c, all, onBack, onOpen}: {c: Container; all: Container[]; onBack: () => void; onOpen: (name: string) => void}) {
	const action = useContainerAction()
	const confirm = useConfirm()
	const toast = useToast()
	const owner = isOwner(useUser().data)
	const swarm = useSwarm()
	const agent = containerAgent(swarm.data ?? [], c.name)
	const linux = linuxConnectorOs(c.os)
	const [term, setTerm] = useState<null | 'console'>(null)
	const [tab, setTab] = useState('summary')
	const [pw, setPw] = useState('')
	const [snap, setSnap] = useState('')
	const [port, setPort] = useState({host: '', inner: '', protocol: 'tcp' as 'tcp' | 'udp'})
	const [copy, setCopy] = useState<null | 'clone' | 'template'>(null)
	const [copyName, setCopyName] = useState('')
	const [askUser, setAskUser] = useState(false)
	const [installUser, setInstallUser] = useState('')
	const [installing, setInstalling] = useState(false)
	const [agentTerm, setAgentTerm] = useState(false)
	const pill = containerPill(c)
	const busy = action.isPending || pill.kind === 'busy' || installing || c.job === 'installing connector'
	const run = (path: string, done?: string, extra: Record<string, unknown> = {}) => action.mutate({path, input: {name: c.name, ...extra}, done})
	const taken = all.map((x) => x.name)
	const canInstall = owner && c.status === 'running' && !agent && linux && swarm.isFetched
	useEffect(() => {
		if (agent) setInstalling(false)
	}, [agent])
	useEffect(() => {
		if (!installing || agent || c.job === 'installing connector') return
		// Job finished without an agent: clear the spinner and show the list error if any.
		if (c.error && /connector/i.test(c.error)) {
			toast(c.error, true)
			setInstalling(false)
		}
	}, [agent, c.error, c.job, installing, toast])
	const runInstall = (username: string) => {
		haptic(6)
		setInstalling(true)
		setAskUser(false)
		void mutate<{status: string; message?: string}>('containers.installConnector', {name: c.name, username})
			.then((out) => {
				if (out.status === 'unsupported') {
					toast(out.message ?? 'This operating system can’t run the connector.', true)
					setInstalling(false)
				}
			})
			.catch((e) => {
				toast(e instanceof Error ? e.message : 'Install failed', true)
				setInstalling(false)
			})
	}

	// Container pages live in sheets, which sit above the usual terminal layer: open it above them.
	const terminal = term ? (
		<Suspense fallback={null}>
			{/* The console starts at the container's login prompt; Enter brings the prompt up. */}
			<TerminalScreen container={{name: c.name, mode: 'console'}} overSheet input={'\r'} onClose={() => setTerm(null)} />
		</Suspense>
	) : null

	const stop = () =>
		action.mutate(
			{path: 'containers.stop', input: {name: c.name}, done: `${c.name} is shut down`},
			{
				onError: async (e) => {
					if (!/STOP_TIMED_OUT/.test(e.message)) return
					if (await confirm({title: `Force stop ${c.name}?`, body: 'It didn’t shut down within a minute. Force stop turns it off straight away, like pulling the plug: unsaved work inside it is lost.', confirm: 'Force stop', danger: true, icon: 'alert'}))
						run('containers.forceStop', `${c.name} is off`)
				},
			},
		)

	// Not in Incus yet (still being created, cloned or restored, or that failed).
	const placeholder = !!c.pending || c.job === 'creating'
	return (
		<div className="ct-col" style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0}}>
			{terminal}
			{/* The same header as a virtual machine's page. */}
			<SheetHeader
				icon={
					<span className="vm-os" style={{width: 64, height: 64, borderRadius: 19, background: osColor(c.os), color: '#fff'}}>
						<Icon name="category" size={32} />
					</span>
				}
				title={c.name}
				subtitle={
					<span style={{display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
						<StatusPill {...pill} />
						<span className="muted">Container · {osLabel(c) || (c.from ? `from ${c.from}` : 'Linux')}</span>
						{c.protected && <Icon name="shield" size={14} />}
					</span>
				}
				onClose={onBack}
			/>
			{c.error && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{c.error}
				</div>
			)}
			{placeholder ? (
				c.status === 'error' ? (
					<button className="btn block" onClick={() => action.mutate({path: 'containers.delete', input: {name: c.name}}, {onSuccess: onBack})}>
						<Icon name="close" size={18} /> Dismiss
					</button>
				) : (
					<div className="glass" style={{padding: 16, display: 'grid', gap: 8, minWidth: 0}}>
						<span style={{display: 'inline-flex', gap: 8, alignItems: 'center'}}>
							<span className="spinner" /> <b>{c.progress || 'Starting…'}</b>
						</span>
						<span className="quiet">
							{c.startedAt ? `Started ${Math.max(0, Math.round((Date.now() - Date.parse(c.startedAt)) / 60_000))} min ago. ` : ''}The first container of a system downloads it (about 100 MB), then it starts by itself. You can leave this page.
						</span>
					</div>
				)
			) : (
				<>
					<div className="actions mx-power">
						{c.status !== 'running' ? (
							<button className="action" disabled={busy} onClick={() => run('containers.start', `${c.name} is starting`)}>
								{busy ? <span className="spinner" /> : <Icon name="play" size={22} />}
								Start
							</button>
						) : null}
						<button className="action" disabled={busy || c.status !== 'running'} onClick={() => run('containers.restart', `${c.name} is restarting`)}>
							<Icon name="restart" size={22} />
							Restart
						</button>
						<button className="action" disabled={busy || c.status !== 'running'} onClick={stop}>
							<Icon name="power" size={22} />
							Shut down
						</button>
						<button
							className="action"
							disabled={busy || c.status !== 'running'}
							onClick={async () => (await confirm({title: `Force stop ${c.name}?`, body: 'Turns it off straight away, like pulling the plug: unsaved work inside it is lost.', confirm: 'Force stop', danger: true, icon: 'alert'})) && run('containers.forceStop', `${c.name} is off`)}
						>
							<Icon name="stop" size={22} />
							Force stop
						</button>
					</div>

					{canInstall && (
						<div className="primary-row">
							<button type="button" className="btn primary" disabled={busy} onClick={() => setAskUser(true)}>
								{busy ? <span className="spinner" /> : <Icon name="plus" size={20} />} Install connector
							</button>
						</div>
					)}
					{owner && c.status === 'running' && !agent && !linux && swarm.isFetched && (
						<p className="quiet">This operating system can’t run the connector. It runs on Linux with systemd or Alpine OpenRC.</p>
					)}
					{agent && (
						<MachineActions
							terminal={!!agent.online && agentMay(agent, 'terminal')}
							desktop={false}
							onTerminal={() => setAgentTerm(true)}
							onDesktop={() => {}}
							pin={<PinButton pin={{kind: 'machine', id: c.name, computer: SERVER_FLEET_ID}} name={c.name} />}
						/>
					)}

					{c.status === 'running' ? (
						<EmbeddedConsole name={c.name} onFull={() => setTerm('console')} />
					) : (
						<div className="glass" style={{padding: 16, minWidth: 0}}>
							<span className="quiet">Start {c.name} to open Terminal.</span>
						</div>
					)}
					{agentTerm && agent && (
						<Suspense fallback={null}>
							<TerminalScreen agent={{id: agent.id, name: c.name}} overSheet onClose={() => setAgentTerm(false)} />
						</Suspense>
					)}
					{askUser && (
						<Sheet open onClose={() => setAskUser(false)} label="Install connector">
							<SheetHeader title="Install connector" subtitle={c.name} onClose={() => setAskUser(false)} />
							<form
								onSubmit={(e) => {
									e.preventDefault()
									const username = installUser.trim()
									if (!username) return
									runInstall(username)
								}}
							>
								<TextField id="ct-install-user" label="Account inside the container" value={installUser} onChange={(v) => setInstallUser(v.toLowerCase())} hint="A lower-case Linux username. Created if it isn’t there yet. Not root." placeholder="joseph" />
								<button type="submit" className="btn primary" disabled={busy || !/^[a-z_][a-z0-9_-]{0,31}$/.test(installUser.trim()) || installUser.trim() === 'root'} style={{width: '100%', marginTop: 12}}>
									{busy ? <><span className="spinner" /><span className="sr-only">Install connector</span></> : 'Install connector'}
								</button>
							</form>
						</Sheet>
					)}
					<MachineTabs
						label={`${c.name} sections`}
						tab={tab}
						onTab={setTab}
						tabs={[
							{id: 'summary', label: 'Summary', body: (<div className="ct-col" style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0}}>
								<Graphs c={c} />
					<Resources key={`${c.cpus}-${c.memory}-${c.disk}-${c.cpuAllowance}-${c.cpuPriority}-${c.swap}`} c={c} busy={busy} run={run} />
							</div>)},
							{id: 'network', label: 'Network', body: (
					<Group title="Open ports" footer="Opens a port on this server to your home network and passes it to the container. Only the ports listed here are reachable from outside the server.">
						{c.ports.map((p) => (
							<Row
								key={`${p.protocol}-${p.hostPort}`}
								icon="link"
								label={`${p.hostPort} → ${p.containerPort ?? '?'}`}
								sub={p.protocol.toUpperCase()}
								trailing={
									<button type="button" className="btn small" disabled={busy} aria-label={`Close port ${p.hostPort}`} onClick={() => run('containers.removePort', `Closed port ${p.hostPort}`, {protocol: p.protocol, hostPort: p.hostPort})}>
										<Icon name="trash" size={14} />
									</button>
								}
							/>
						))}
						<div style={{display: 'flex', gap: 8, padding: '10px 12px', alignItems: 'end', flexWrap: 'wrap'}}>
							<div style={{flex: '1 1 90px', minWidth: 0}}>
								<TextField id="ct-hp" label="Server port" value={port.host} onChange={(v) => setPort({...port, host: v})} numeric placeholder="8080" />
							</div>
							<div style={{flex: '1 1 90px', minWidth: 0}}>
								<TextField id="ct-cp" label="Container port" value={port.inner} onChange={(v) => setPort({...port, inner: v})} numeric placeholder="80" />
							</div>
							<button type="button" className="btn small" onClick={() => setPort({...port, protocol: port.protocol === 'tcp' ? 'udp' : 'tcp'})}>
								{port.protocol.toUpperCase()}
							</button>
							<button
								type="button"
								className="btn small"
								disabled={busy || !port.host || !port.inner}
								onClick={() => action.mutate({path: 'containers.addPort', input: {name: c.name, protocol: port.protocol, hostPort: Number(port.host), containerPort: Number(port.inner)}, done: `Port ${port.host} is open`}, {onSuccess: () => setPort({host: '', inner: '', protocol: port.protocol})})}
							>
								<Icon name="plus" size={14} /> Open
							</button>
						</div>
					</Group>

							)},
							{id: 'snapshots', label: 'Snapshots', body: (
					<Group title="Snapshots">
						{c.snapshots.length === 0 && <p className="quiet" style={{padding: '4px 12px'}}>No snapshots yet.</p>}
						{c.snapshots.map((s) => (
							<Row
								key={s.name}
								icon="history"
								label={s.name}
								sub={s.createdAt ? new Date(s.createdAt).toLocaleString() : undefined}
								trailing={
									<span style={{display: 'inline-flex', gap: 6}}>
										<button
											type="button"
											className="btn small"
											disabled={busy}
											onClick={async () => (await confirm({title: `Go back to ${s.name}?`, body: `${c.name} returns to how it was when this snapshot was taken. Changes since then are lost.`, confirm: 'Restore', danger: true, icon: 'restart'})) && run('containers.restoreSnapshot', `${c.name} is back at ${s.name}`, {snapshot: s.name})}
										>
											Restore
										</button>
										<button type="button" className="btn small" disabled={busy} aria-label={`Delete snapshot ${s.name}`} onClick={async () => (await confirm({title: `Delete snapshot ${s.name}?`, body: 'This can’t be undone.', confirm: 'Delete', danger: true, icon: 'alert'})) && run('containers.deleteSnapshot', 'Snapshot deleted', {snapshot: s.name})}>
											<Icon name="trash" size={14} />
										</button>
									</span>
								}
							/>
						))}
						<div style={{display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 12px', alignItems: 'end'}}>
							<div style={{flex: '1 1 120px', minWidth: 0}}>
								<TextField id="ct-snap" label="New snapshot" value={snap} onChange={(v) => setSnap(v.replace(/[^A-Za-z0-9._-]/g, ''))} placeholder="before-update" />
							</div>
							<button type="button" className="btn small" disabled={busy || !snap} onClick={() => action.mutate({path: 'containers.snapshot', input: {name: c.name, snapshot: snap}, done: `Snapshot ${snap} taken`}, {onSuccess: () => setSnap('')})}>
								<Icon name="camera" size={14} /> Take
							</button>
						</div>
					</Group>

							)},
							{id: 'backup', label: 'Backup', body: (
					<Backups c={c} busy={busy} all={all} />
							)},
							{id: 'files', label: 'Files', body: (
					agent && agent.online && agentMay(agent, 'files') ? (
						<div className="ct-col" style={{display: 'grid', gap: 12, minWidth: 0}}>
							<Suspense fallback={<div className="skeleton" style={{height: 180, borderRadius: 16}} />}>
								<MachineFiles scope={{kind: 'computer', id: agent.id, name: c.name}} windowId={`container:${c.name}`} />
							</Suspense>
							<p className="quiet">Host files (Incus) stay available below while the connector is online.</p>
							<Files c={c} />
						</div>
					) : (
						<Files c={c} />
					)
							)},
							...(agent?.online
								? [{id: 'apps', label: 'Apps', body: (
					<Row icon="store" color="var(--accent)" label="App Store" sub={`Installs on ${c.name}`} onClick={() => (haptic(6), openStore({id: agent.id, kind: 'computer', name: c.name}))} />
								)}]
								: []),
							...(c.nixos
								? [
										{
											id: 'config',
											label: 'Config',
											body: (
												<NixosConfigPanel
													id={c.name}
													kind="lxc"
													busy={busy}
													running={c.status === 'running'}
													onApply={() =>
														action.mutate({
															path: 'containers.applyNixosConfig',
															input: {name: c.name},
															done: 'Restarting so the container picks up the configuration',
														})
													}
													readConfig={() => query<{config: string; present: boolean}>('containers.nixosConfig', {name: c.name})}
													saveConfig={(config) => mutate('containers.setNixosConfig', {name: c.name, config})}
												/>
											),
										},
									]
								: []),
							{id: 'options', label: 'Options', body: (<div className="ct-col" style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0}}>
					<Boot key={`${c.bootOrder}-${c.bootDelay}`} c={c} busy={busy} run={run} />
					<Group title="Signing in" footer="Terminal on this container is its own login. Sign in there as root with the password set here.">
						<div style={{display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 12px', alignItems: 'end'}}>
							<div style={{flex: '1 1 160px', minWidth: 0}}>
								<TextField id="ct-pw2" label="Root password" type="password" value={pw} onChange={setPw} placeholder="8 characters or more" />
							</div>
							<button type="button" className="btn small" disabled={busy || c.status !== 'running' || pw.length < 8} onClick={() => action.mutate({path: 'containers.setRootPassword', input: {name: c.name, password: pw}, done: 'Root password set'}, {onSuccess: () => setPw('')})}>
								<Icon name="key" size={14} /> Set
							</button>
						</div>
					</Group>
					<NotesAndTags c={c} busy={busy} run={run} />
					<Group title="Copies">
						<Row icon="copy" label="Clone" sub="A new container that starts as an exact copy" disabled={busy} onClick={() => (setCopy('clone'), setCopyName(`${c.name}-2`))} />
						<Row icon="save" label="Save as a template" sub="Appears under Your templates when you make a new container" disabled={busy} onClick={() => (setCopy('template'), setCopyName(c.name))} />
						{copy && (
							<div style={{display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 12px 12px', alignItems: 'end'}}>
								<div style={{flex: '1 1 120px', minWidth: 0}}>
									<TextField id="cp-name" label={copy === 'clone' ? 'Name of the copy' : 'Template name'} value={copyName} onChange={(v) => setCopyName(v.toLowerCase())} hint={copy === 'clone' ? nameProblemOf(copyName, taken) : nameProblemOf(copyName, [])} />
								</div>
								<button
									type="button"
									className="btn small"
									disabled={action.isPending || !!(copy === 'clone' ? nameProblemOf(copyName, taken) : nameProblemOf(copyName, []))}
									onClick={() =>
										action.mutate(
											copy === 'clone'
												? {path: 'containers.clone', input: {name: c.name, as: copyName}, done: `Cloning ${c.name} as ${copyName}`}
												: {path: 'containers.saveTemplate', input: {name: c.name, template: copyName}, done: `Saving ${c.name} as the template ${copyName}`},
											{onSuccess: () => (copy === 'clone' && onOpen(copyName), setCopy(null))},
										)
									}
								>
									{copy === 'clone' ? 'Clone' : 'Save'}
								</button>
							</div>
						)}
					</Group>

					<Group title="Protection">
						<SwitchRow label="Protect from deleting" sub="While on, this container can’t be deleted, here or with Incus." on={c.protected} disabled={busy} onChange={(on) => run('containers.setOptions', on ? `${c.name} is protected` : `${c.name} can be deleted again`, {protected: on})} />
					</Group>
					<button
						className="btn danger block"
						disabled={action.isPending || c.protected || !!c.job}
						onClick={async () => {
							if (!(await confirm({title: `Delete ${c.name}?`, body: 'The container, its files and its snapshots are deleted. Backups stay. This can’t be undone.', confirm: 'Delete container', danger: true, icon: 'alert'}))) return
							action.mutate({path: 'containers.delete', input: {name: c.name}, done: `${c.name} deleted`}, {onSuccess: onBack})
						}}
					>
						<Icon name="trash" size={18} /> {c.protected ? 'Protected from deleting' : 'Delete container'}
					</button>
							</div>)},
						]}
					/>
				</>
			)}
		</div>
	)
}

