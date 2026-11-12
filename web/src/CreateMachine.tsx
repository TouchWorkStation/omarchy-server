import {useMemo, useState} from 'react'
import {useQuery} from '@tanstack/react-query'

import {query, type MachineCapabilities, type OsImage} from './api'
import {useAction, useCpu, useMachines, useMemory, useUser} from './data'
import {Icon} from './icons'
import {osLook} from './screens/Machines'
import {Sheet, SheetHeader, bytes, haptic} from './ui'

// Per-OS starting specs and floors, taken from umbrelOS's own create-machine form.
type Spec = {cores: number; memoryGb: number; diskSizeGb: number; minCores: number; minMemoryGb: number; minDiskSizeGb: number}
const spec = (cores: number, memoryGb: number, diskSizeGb: number, minCores: number, minMemoryGb: number, minDiskSizeGb: number): Spec => ({
	cores,
	memoryGb,
	diskSizeGb,
	minCores,
	minMemoryGb,
	minDiskSizeGb,
})
const FALLBACK = spec(2, 4, 40, 1, 1, 1)
const SPECS: Record<string, Spec> = {
	'ubuntu:Desktop': spec(4, 8, 40, 2, 4, 25),
	'ubuntu:Server': spec(2, 2, 20, 1, 1, 5),
	'fedora:Desktop': spec(4, 8, 40, 2, 4, 25),
	'fedora:Server': spec(2, 2, 20, 1, 1, 5),
	'debian:Desktop': spec(2, 4, 25, 1, 1, 10),
	'debian:Server': spec(2, 2, 15, 1, 1, 4),
	alpine: spec(2, 1, 8, 1, 1, 2),
	android: spec(4, 8, 40, 2, 4, 25),
	omarchy: spec(4, 8, 40, 2, 4, 25),
	'windows-11': spec(4, 8, 96, 2, 4, 64),
	'windows-server': spec(4, 8, 80, 2, 4, 32),
	'windows-7': spec(2, 2, 40, 1, 2, 20),
	'windows-xp': spec(1, 1, 20, 1, 1, 2),
	'windows-98': spec(1, 1, 2, 1, 1, 1),
}
const specFor = (os: OsImage) => SPECS[`${os.familyId}:${os.variantName}`] ?? SPECS[os.familyId] ?? FALLBACK

function Stepper({label, value, unit, min, max, step = 1, onChange}: {label: string; value: number; unit: string; min: number; max: number; step?: number; onChange: (v: number) => void}) {
	const set = (v: number) => {
		haptic(4)
		onChange(Math.min(max, Math.max(min, v)))
	}
	return (
		<div className="stepper row static">
			<span className="k">{label}</span>
			<button className="step-btn" aria-label={`Less ${label}`} onClick={() => set(value - step)} disabled={value <= min}>
				−
			</button>
			<span className="step-val num">
				{value} <small>{unit}</small>
			</span>
			<button className="step-btn" aria-label={`More ${label}`} onClick={() => set(value + step)} disabled={value >= max}>
				+
			</button>
		</div>
	)
}

export function CreateMachine({open, onClose}: {open: boolean; onClose: () => void}) {
	const caps = useQuery({queryKey: ['machines.capabilities'], queryFn: () => query<MachineCapabilities>('machines.capabilities'), enabled: open, staleTime: 60_000})
	const images = useQuery({
		queryKey: ['machines.osImages'],
		queryFn: () => query<OsImage[]>('machines.osImages'),
		enabled: open,
		refetchInterval: (q) => ((q.state.data ?? []).some((i) => i.state === 'downloading') ? 2000 : false),
	})
	const [picked, setPicked] = useState<OsImage | null>(null)
	const close = () => {
		setPicked(null)
		onClose()
	}
	const hostArch = caps.data?.hostArchitecture ?? 'amd64'
	const list = useMemo(
		() =>
			(images.data ?? [])
				.filter((i) => !i.custom)
				.sort((a, b) => Number(b.arch === hostArch) - Number(a.arch === hostArch) || a.name.localeCompare(b.name) || (a.variantName ?? '').localeCompare(b.variantName ?? '')),
		[images.data, hostArch],
	)

	return (
		<Sheet open={open} onClose={close} label="New machine" tall>
			{picked ? (
				<Configure os={picked} hostArch={hostArch} onBack={() => setPicked(null)} onDone={close} />
			) : (
				<>
					<SheetHeader title="New machine" subtitle="Choose an operating system" onClose={close} />
					{caps.data?.performanceWarning && (
						<div className="error" style={{marginBottom: 12}}>
							<Icon name="alert" size={18} />
							{caps.data.performanceWarning}
						</div>
					)}
					{caps.data && !caps.data.libvirtAvailable && (
						<div className="error">
							<Icon name="alert" size={18} />
							Virtual machines aren’t available on this Umbrel.
						</div>
					)}
					<div style={{overflowY: 'auto', flex: 1, margin: '0 -20px', padding: '0 20px 20px'}}>
						{images.isLoading && Array.from({length: 5}, (_, i) => <div key={i} className="skeleton" style={{height: 64, margin: '8px 0'}} />)}
						{images.error && (
							<div className="error">
								<Icon name="alert" size={18} />
								{(images.error as Error).message}
							</div>
						)}
						<div className="glass group" style={{borderRadius: 18, '--inset': '74px'} as React.CSSProperties}>
							{list.map((os) => {
								const look = osLook(os.familyId)
								const emulated = os.arch !== hostArch
								return (
									<button
										key={os.id}
										className="row"
										onClick={() => {
											haptic(6)
											setPicked(os)
										}}
									>
										<span className="vm-os" style={{width: 46, height: 46, borderRadius: 13, background: look.bg}}>
											<Icon name={look.icon} size={24} />
										</span>
										<span className="main">
											<b>
												{os.name}
												{os.variantName ? ` ${os.variantName}` : ''}
											</b>
											<span>
												{os.version} · {bytes(os.sizeMb * 1e6, 1)}
												{emulated ? ` · ${os.arch} (emulated, slow)` : ''}
												{os.evaluation ? ' · evaluation' : ''}
											</span>
										</span>
										{os.state === 'downloaded' ? (
											<span className="pill" style={{'--c': 'var(--green)'} as React.CSSProperties}>
												<i />
												ready
											</span>
										) : os.state === 'downloading' ? (
											<span className="pill busy" style={{'--c': 'var(--blue)'} as React.CSSProperties}>
												<i />
												{os.downloadProgress ?? 0}%
											</span>
										) : (
											<Icon name="chevron" size={18} className="chev" />
										)}
									</button>
								)
							})}
						</div>
						<p className="footer-note" style={{textAlign: 'left'}}>
							To install from your own ISO or disk image, use Machines in the umbrelOS dashboard.
						</p>
					</div>
				</>
			)}
		</Sheet>
	)
}

function Configure({os, hostArch, onBack, onDone}: {os: OsImage; hostArch: string; onBack: () => void; onDone: () => void}) {
	const cpu = useCpu()
	const mem = useMemory()
	const user = useUser()
	const machines = useMachines()
	const action = useAction()
	const profile = specFor(os)
	const threads = cpu.data?.threads ?? 4
	const totalGb = mem.data ? Math.floor(mem.data.size / 1024 ** 3) : 8
	// Leave the larger of 2 GB or what the host is using now, like umbrelOS.
	const maxMemoryGb = Math.max(1, Math.floor((mem.data ? mem.data.size - Math.max(2e9, mem.data.totalUsed) : 6e9) / 1024 ** 3)) || totalGb
	const baseName = `${os.name}${os.variantName ? ` ${os.variantName}` : ''}`
	const taken = new Set((machines.data ?? []).map((m) => m.name.toLowerCase()))
	let suggestion = baseName
	for (let n = 2; taken.has(suggestion.toLowerCase()); n++) suggestion = `${baseName} ${n}`

	const [name, setName] = useState(suggestion)
	const [cores, setCores] = useState(Math.min(Math.max(profile.cores, profile.minCores), Math.max(1, Math.floor(threads / 2)), threads))
	const [memoryGb, setMemoryGb] = useState(Math.min(Math.max(profile.memoryGb, profile.minMemoryGb), maxMemoryGb))
	const [diskSizeGb, setDisk] = useState(profile.diskSizeGb)
	const [username, setUsername] = useState((user.data?.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20))
	const [password, setPassword] = useState('')
	const [licenseKey, setLicenseKey] = useState('')
	const [error, setError] = useState('')

	const needsPassword = os.requiresCredentials && !os.manualSetup
	const windows = os.platform === 'windows'
	const usernameOk = !os.requiresCredentials || (username.trim() !== '' && (!windows || /^[a-z0-9][a-z0-9_.-]{0,19}$/i.test(username.trim())))
	const licenseOk = !os.requiresLicenseKey || /^[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}$/i.test(licenseKey.trim())
	const nameTaken = taken.has(name.trim().toLowerCase())
	const canCreate = !!name.trim() && !nameTaken && usernameOk && (!needsPassword || password !== '') && licenseOk && !action.isPending

	const create = async () => {
		setError('')
		haptic(12)
		try {
			await action.mutateAsync({
				path: 'machines.create',
				input: {
					name: name.trim(),
					osId: os.id,
					cores,
					memoryGb,
					diskSizeGb,
					arch: os.arch,
					...(os.requiresCredentials ? {username: username.trim(), ...(needsPassword ? {password} : {})} : {}),
					...(os.requiresLicenseKey ? {licenseKey: licenseKey.trim().toUpperCase()} : {}),
				},
				done: `${name.trim()} is being created`,
			})
			onDone()
		} catch (e) {
			setError((e as Error).message)
		}
	}
	const look = osLook(os.familyId)

	return (
		<>
			<div className="sheet-head">
				<button className="icon-btn" style={{alignSelf: 'center'}} aria-label="Back" onClick={onBack}>
					<Icon name="back" size={18} stroke={2.2} />
				</button>
				<span className="vm-os" style={{width: 46, height: 46, borderRadius: 13, background: look.bg}}>
					<Icon name={look.icon} size={24} />
				</span>
				<div className="main">
					<h3>{baseName}</h3>
					<p>
						{os.version}
						{os.arch !== hostArch ? ' · emulated' : ''}
					</p>
				</div>
			</div>
			<div style={{overflowY: 'auto', flex: 1, margin: '0 -20px', padding: '0 20px 8px'}}>
				{error && (
					<div className="error shake">
						<Icon name="alert" size={18} />
						{error}
					</div>
				)}
				<div className="field">
					<label htmlFor="vm-name">Name</label>
					<input id="vm-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
					{nameTaken && <span className="hint" style={{color: 'var(--red)'}}>You already have a machine with this name.</span>}
				</div>
				<div className="glass group" style={{borderRadius: 18, marginBottom: 16, '--inset': '16px'} as React.CSSProperties}>
					<Stepper label="CPU cores" value={cores} unit={cores === 1 ? 'core' : 'cores'} min={Math.min(profile.minCores, threads)} max={threads} onChange={setCores} />
					<Stepper label="Memory" value={memoryGb} unit="GB" min={Math.min(profile.minMemoryGb, maxMemoryGb)} max={Math.max(maxMemoryGb, 1)} onChange={setMemoryGb} />
					<Stepper label="Disk" value={diskSizeGb} unit="GB" min={profile.minDiskSizeGb} max={10_000} step={diskSizeGb >= 100 ? 20 : 5} onChange={setDisk} />
				</div>
				{os.requiresCredentials && (
					<>
						<div className="field">
							<label htmlFor="vm-user">Username in the machine</label>
							<input id="vm-user" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
							{!usernameOk && username !== '' && <span className="hint" style={{color: 'var(--red)'}}>Letters, numbers, dots, dashes; up to 20 characters.</span>}
						</div>
						{needsPassword && (
							<div className="field">
								<label htmlFor="vm-pass">Password in the machine</label>
								<input id="vm-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
								<span className="hint">Used to sign in to {os.name}. It isn’t stored by UmbrelOS Touch.</span>
							</div>
						)}
					</>
				)}
				{os.requiresLicenseKey && (
					<div className="field">
						<label htmlFor="vm-key">Product key</label>
						<input id="vm-key" autoCapitalize="characters" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)} />
					</div>
				)}
				{os.state !== 'downloaded' && (
					<p className="hint" style={{margin: '0 4px 14px', color: 'var(--muted)', fontSize: 13}}>
						{os.name} ({bytes(os.sizeMb * 1e6, 1)}) downloads first; the machine appears right away and shows its progress.
					</p>
				)}
			</div>
			<button className="btn primary block" onClick={create} disabled={!canCreate}>
				{action.isPending ? <span className="spinner" /> : <Icon name="sparkle" size={20} />}
				{action.isPending ? 'Creating…' : 'Create machine'}
			</button>
		</>
	)
}
