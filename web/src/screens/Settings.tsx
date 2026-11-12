// Full settings, backed by the same umbreld calls the umbrelOS dashboard uses.
import {useContext, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {logout, mutate, query, type ActiveSession, type Wallpaper} from '../api'
import {useBootstrap, useUser} from '../data'
import {Icon, type IconName} from '../icons'
import {InWindow, Segmented, Sheet, SheetHeader, haptic, initials, setLayoutPref, useConfirm, useLayout, useToast, wallpaperUrl, type LayoutPref, type Prefs} from '../ui'
import {Appearance} from './More'
import {StoragePage} from './Storage'
import {WhatsNewSheet, allReleases} from '../WhatsNew'

const WALLPAPER_IDS = Array.from({length: 25}, (_, i) => String(i + 1))

function useQ<T>(path: string, input?: unknown, opts: {enabled?: boolean; refetchInterval?: number | false} = {}) {
	return useQuery({queryKey: [path, input], queryFn: () => query<T>(path, input), retry: false, staleTime: 15_000, ...opts})
}

// A settings change: run it, toast, refresh what it touched.
function useSave() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: (a: {path: string; input?: unknown; done?: string; refresh?: string[]}) => mutate(a.path, a.input),
		onSuccess: (_, a) => {
			if (a.done) toast(a.done)
		},
		onError: (e: Error) => toast(e.message, true),
		onSettled: (_, __, a) => {
			for (const key of a.refresh ?? []) qc.invalidateQueries({queryKey: [key]})
		},
	})
}

function Row({icon, color, label, value, onClick, href, trailing}: {icon: IconName; color: string; label: string; value?: ReactNode; onClick?: () => void; href?: string; trailing?: ReactNode}) {
	const inner = (
		<>
			<span className="row-ico" style={{'--c': color} as CSSProperties}>
				<Icon name={icon} size={19} />
			</span>
			<span className="main">
				<b style={{fontWeight: 550}}>{label}</b>
			</span>
			{value !== undefined && <span className="trail">{value}</span>}
			{trailing ?? (onClick || href ? <Icon name="chevron" size={18} className="chev" /> : null)}
		</>
	)
	if (href)
		return (
			<a className="row" href={href} target="_blank" rel="noopener noreferrer" style={{minHeight: 56}}>
				{inner}
			</a>
		)
	if (onClick)
		return (
			<button className="row" onClick={onClick} style={{minHeight: 56}}>
				{inner}
			</button>
		)
	return (
		<div className="row static" style={{minHeight: 56}}>
			{inner}
		</div>
	)
}

export function Switch({on, onChange, label, disabled}: {on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean}) {
	return (
		<button
			className="switch"
			role="switch"
			aria-checked={on}
			aria-label={label}
			disabled={disabled}
			onClick={() => {
				haptic(6)
				onChange(!on)
			}}
		/>
	)
}

function Group({title, children, footer}: {title: string; children: ReactNode; footer?: ReactNode}) {
	return (
		<section>
			<div className="section-head">
				<h2>{title}</h2>
			</div>
			<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
				{children}
			</div>
			{footer && (
				<p className="footer-note" style={{textAlign: 'left', margin: '10px 6px 0'}}>
					{footer}
				</p>
			)}
		</section>
	)
}

function FormSheet({open, title, subtitle, onClose, onSubmit, busy, submit, danger, children, disabled}: {
	open: boolean
	title: string
	subtitle?: string
	onClose: () => void
	onSubmit: () => void
	busy?: boolean
	submit: string
	danger?: boolean
	disabled?: boolean
	children: ReactNode
}) {
	const go = (e: FormEvent) => {
		e.preventDefault()
		onSubmit()
	}
	return (
		<Sheet open={open} onClose={onClose} label={title}>
			<SheetHeader title={title} subtitle={subtitle} onClose={onClose} />
			<form onSubmit={go}>
				{children}
				<button className={`btn block ${danger ? 'danger solid' : 'primary'}`} disabled={busy || disabled} style={{marginTop: 6}}>
					{busy && <span className="spinner" />}
					{submit}
				</button>
			</form>
		</Sheet>
	)
}

const ago = (t: number) => {
	const s = Math.max(0, (Date.now() - t) / 1000)
	if (s < 90) return 'just now'
	if (s < 3600) return `${Math.round(s / 60)} min ago`
	if (s < 86400) return `${Math.round(s / 3600)} h ago`
	return `${Math.round(s / 86400)} days ago`
}
function describeSession(s: ActiveSession) {
	if (s.client.type === 'native') {
		const name = s.client.id === 'umbrel-touch' ? 'UmbrelOS Touch' : s.client.id === 'umbrel' || !s.client.id ? 'Umbrel app' : s.client.id
		return {icon: 'phone' as IconName, name, detail: [s.client.platform, s.client.appVersion && `v${s.client.appVersion}`].filter(Boolean).join(' · ')}
	}
	const ua = s.client.userAgent ?? ''
	const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
	const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
	return {icon: 'browser' as IconName, name: `${browser}${os ? ` on ${os}` : ''}`, detail: ''}
}

type SheetId = null | 'name' | 'password' | '2fa' | 'wallpaper' | 'hostname' | 'wifi' | 'logs' | 'reset'

export function Settings({prefs, setPrefs, onBack, onSignedOut}: {prefs: Prefs; setPrefs: (p: Prefs) => void; onBack: () => void; onSignedOut: () => void}) {
	const boot = useBootstrap()
	const user = useUser()
	const confirm = useConfirm()
	const save = useSave()
	const qc = useQueryClient()
	const [sheet, setSheet] = useState<SheetId>(null)
	const inWindow = useContext(InWindow)
	const layout = useLayout()
	const [page, setPage] = useState<'main' | 'appearance' | 'storage'>(() => (sessionStorage.getItem('umbrel-touch:settings-page') as 'appearance' | 'storage') || 'main')
	const openPage = (p: 'main' | 'appearance' | 'storage') => {
		haptic(5)
		if (p === 'main') sessionStorage.removeItem('umbrel-touch:settings-page')
		else sessionStorage.setItem('umbrel-touch:settings-page', p)
		setPage(p)
		window.scrollTo({top: 0})
	}
	const close = () => setSheet(null)
	const owner = user.data?.role !== 'member'

	const twoFactor = useQ<boolean>('user.is2faEnabled')
	const sessions = useQ<ActiveSession[]>('user.listSessions')
	const check = useQ<{available: boolean; version: string; name: string; releaseNotes?: string}>('system.checkUpdate', undefined, {enabled: owner})
	const [updating, setUpdating] = useState(false)
	const [updateError, setUpdateError] = useState<string | null>(null)
	const [notes, setNotes] = useState(false)
	const status = useQ<{running: boolean; progress: number; description: string; error: boolean | string}>('system.updateStatus', undefined, {
		enabled: owner && updating,
		refetchInterval: updating ? 1500 : false,
	})
	const channel = useQ<'stable' | 'beta'>('system.getReleaseChannel', undefined, {enabled: owner})
	const hostname = useQ<string>('system.getHostname', undefined, {enabled: owner})
	const ips = useQ<string[]>('system.getIpAddresses')
	const tor = useQ<boolean>('apps.getTorEnabled', undefined, {enabled: owner})
	const dns = useQ<boolean>('system.isExternalDns', undefined, {enabled: owner})
	const wifiSupported = useQ<boolean>('wifi.supported', undefined, {enabled: owner})
	const wifi = useQ<{status: 'connected' | 'disconnected'; ssid?: string}>('wifi.connected', undefined, {enabled: owner && !!wifiSupported.data})

	const startUpdate = async () => {
		const ok = await confirm({
			title: `Update to ${check.data?.name ?? check.data?.version}?`,
			body: 'umbrelOS downloads the update, then restarts. Your apps and machines stop briefly. Keep the Umbrel powered on.',
			confirm: 'Update now',
			icon: 'update',
		})
		if (!ok) return
		setUpdateError(null)
		setUpdating(true)
		mutate('system.update').catch(() => {
			/* the server restarts mid-request; progress comes from updateStatus */
		})
	}
	useEffect(() => {
		if (status.data?.error) {
			setUpdateError(typeof status.data.error === 'string' ? status.data.error : 'The update failed')
			setUpdating(false)
		}
	}, [status.data?.error])

	const revoke = async (s: ActiveSession) => {
		const d = describeSession(s)
		if (!(await confirm({title: `Sign out ${d.name}?`, body: 'That device will need your password to get back in.', confirm: 'Sign out'}))) return
		save.mutate({path: 'user.revokeSession', input: {sessionId: s.id}, done: `${d.name} signed out`, refresh: ['user.listSessions']})
	}
	const revokeOthers = async () => {
		if (!(await confirm({title: 'Sign out all other devices?', body: 'Every browser and app signed in to your Umbrel, except this phone, is signed out.', confirm: 'Sign out others', danger: true})))
			return
		save.mutate({path: 'user.revokeOtherSessions', done: 'Other devices signed out', refresh: ['user.listSessions']})
	}
	const power = async (kind: 'restart' | 'shutdown') => {
		const ok = await confirm({
			title: kind === 'restart' ? 'Restart your Umbrel?' : 'Shut down your Umbrel?',
			body: kind === 'restart' ? 'Apps and machines stop, then come back after the restart.' : 'You’ll need to turn the Umbrel back on yourself (for a VM, from FygoNAS).',
			confirm: kind === 'restart' ? 'Restart' : 'Shut down',
			danger: true,
			icon: kind === 'restart' ? 'restart' : 'power',
		})
		if (ok) save.mutate({path: `system.${kind}`, done: kind === 'restart' ? 'Your Umbrel is restarting' : 'Your Umbrel is shutting down'})
	}

	const settingsUrl = `${boot.umbrel?.url ?? ''}/settings`

	if (page === 'storage') return <StoragePage onBack={() => openPage('main')} />
	if (page === 'appearance')
		return (
			<div className="stagger">
				<div className="page-head" style={{margin: '6px 0 14px'}}>
					<button className="round-btn" aria-label="Back" onClick={() => openPage('main')}>
						<Icon name="back" size={20} />
					</button>
					<h1 className="title">Appearance</h1>
				</div>
				<Appearance prefs={prefs} setPrefs={setPrefs} wallpaper={user.data?.wallpaper} />
				<section>
					<div className="section-head">
						<h2>Layout</h2>
					</div>
					<Segmented<LayoutPref>
						label="Layout"
						value={layout.pref}
						options={[
							{id: 'auto', label: 'Automatic'},
							{id: 'desktop', label: 'Desktop'},
							{id: 'phone', label: 'Phone'},
						]}
						onChange={(v) => {
							haptic(6)
							setLayoutPref(v)
						}}
					/>
					<p className="footer-note" style={{textAlign: 'left', margin: '10px 6px 0'}}>
						Desktop gives you windows, a dock and Activities, like Ubuntu. Automatic uses it on wide screens with a mouse or trackpad. Saved on this device only.
					</p>
				</section>
			</div>
		)

	return (
		<div className="stagger">
			<div style={{display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 0'}}>
				{!inWindow && (
					<button className="round-btn" aria-label="Back" onClick={onBack}>
						<Icon name="back" size={20} />
					</button>
				)}
				<h1 className="title" style={{margin: 0}}>
					Settings
				</h1>
			</div>

			<div>
				<div className="section-head" style={{marginTop: 18}} />
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					<div className="settings-profile">
						<span className="avatar">{initials(user.data?.name)}</span>
						<span style={{flex: 1, minWidth: 0}}>
							<b>{user.data?.name ?? ' '}</b>
							<span>
								{user.data?.role === 'member' ? 'Member' : 'Owner'} · {boot.umbrel?.device ?? 'Umbrel'}
							</span>
						</span>
					</div>
					<Row icon="user" color="var(--blue)" label="Name" value={user.data?.name} onClick={() => setSheet('name')} />
					<Row icon="key" color="#8e8e93" label="Password" onClick={() => setSheet('password')} />
					<Row icon="shield" color="var(--green)" label="Two-factor authentication" value={twoFactor.data === undefined ? '' : twoFactor.data ? 'On' : 'Off'} onClick={() => setSheet('2fa')} />
					<Row icon="wallpaper" color="var(--mauve)" label="umbrelOS wallpaper" onClick={() => setSheet('wallpaper')} />
				</div>
			</div>

			<div>
				<div className="section-head" style={{marginTop: 18}} />
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					<Row icon="palette" color="var(--pink, #ec4899)" label="Appearance" onClick={() => openPage('appearance')} />
					{owner && <Row icon="disk" color="var(--teal)" label="Storage" onClick={() => openPage('storage')} />}
				</div>
			</div>

			<Group title="Signed-in devices" footer="Every browser and app signed in to your Umbrel with your account.">
				{(sessions.data ?? []).map((s) => {
					const d = describeSession(s)
					return (
						<div className="row static" key={s.id} style={{minHeight: 62}}>
							<span className="row-ico" style={{'--c': s.current ? 'var(--green)' : '#8e8e93'} as CSSProperties}>
								<Icon name={d.icon} size={19} />
							</span>
							<span className="main">
								<b style={{fontWeight: 550}}>{d.name}</b>
								<span>{s.current ? 'This phone' : `Active ${ago(s.lastSeenAt)}`}{d.detail ? ` · ${d.detail}` : ''}</span>
							</span>
							{!s.current && (
								<button className="btn get" style={{color: 'var(--red)'}} onClick={() => revoke(s)}>
									Sign out
								</button>
							)}
						</div>
					)
				})}
				{sessions.isLoading && <div className="row static"><span className="spinner" /></div>}
				{(sessions.data?.length ?? 0) > 1 && <Row icon="signout" color="var(--red)" label="Sign out all other devices" onClick={revokeOthers} />}
			</Group>

			{owner && (
				<Group title="Software update">
					<Row icon="sparkle" color="var(--pink)" label="Touch" value={`${boot.touch.version} · What’s new`} onClick={() => setNotes(true)} />
					{notes && <WhatsNewSheet releases={allReleases(boot.touch.version)} version={boot.touch.version} onClose={() => setNotes(false)} />}
					<Row icon="server" color="var(--blue)" label="umbrelOS" value={boot.umbrel?.version} />
					{updateError && !updating && (
						<div className="row static update-error" role="alert">
							<span className="row-ico" style={{'--c': 'var(--red)'} as CSSProperties}>
								<Icon name="alert" size={19} />
							</span>
							<span className="main">
								<b style={{fontWeight: 600}}>The update didn’t install</b>
								<span>{updateError}</span>
							</span>
							<button className="btn small" onClick={() => (check.refetch(), startUpdate())}>
								Try again
							</button>
						</div>
					)}
					{updating ? (
						<div className="row static" style={{flexDirection: 'column', alignItems: 'stretch', gap: 10, minHeight: 80}}>
							<span style={{display: 'flex', justifyContent: 'space-between', fontSize: 14.5}}>
								<b style={{fontWeight: 600}}>{status.data?.description || 'Starting update…'}</b>
								<span className="num muted">{status.data?.progress ?? 0}%</span>
							</span>
							<span className="progress">
								<i style={{width: `${status.data?.progress ?? 2}%`}} />
							</span>
							<span className="muted" style={{fontSize: 12.5}}>Your Umbrel restarts when this finishes. Reopen Touch in a few minutes.</span>
						</div>
					) : check.data?.available ? (
						<Row
							icon="update"
							color="var(--accent)"
							label={`${check.data.name ?? check.data.version} available`}
							trailing={
								<button className="btn primary small" onClick={startUpdate}>
									Update
								</button>
							}
						/>
					) : (
						<Row
							icon="check"
							color="var(--green)"
							label={check.isFetching ? 'Checking…' : check.error ? 'Couldn’t check for updates' : 'Up to date'}
							trailing={
								<button className="btn get" onClick={() => check.refetch()} disabled={check.isFetching}>
									Check
								</button>
							}
						/>
					)}
					<div className="row static" style={{minHeight: 64}}>
						<span className="row-ico" style={{'--c': 'var(--peach)'} as CSSProperties}>
							<Icon name="sparkle" size={19} />
						</span>
						<span className="main">
							<b style={{fontWeight: 550}}>Channel</b>
						</span>
						<div style={{width: 150}}>
							<Segmented
								label="Release channel"
								value={channel.data ?? 'stable'}
								options={[
									{id: 'stable', label: 'Stable'},
									{id: 'beta', label: 'Beta'},
								]}
								onChange={(v) => save.mutate({path: 'system.setReleaseChannel', input: {channel: v}, done: v === 'beta' ? 'You’ll get beta updates' : 'You’ll get stable updates', refresh: ['system.getReleaseChannel', 'system.checkUpdate']})}
							/>
						</div>
					</div>
				</Group>
			)}

			{owner && (
				<Group title="Network & privacy">
					<Row icon="network" color="var(--teal)" label="Device name" value={hostname.data ? `${hostname.data}.local` : ''} onClick={() => setSheet('hostname')} />
					<Row icon="networking" color="var(--blue)" label="IP address" value={(ips.data ?? []).join(', ') || '–'} />
					{wifiSupported.data && <Row icon="wifi" color="var(--blue)" label="Wi-Fi" value={wifi.data?.status === 'connected' ? wifi.data.ssid : 'Off'} onClick={() => setSheet('wifi')} />}
					<Row
						icon="tor"
						color="var(--mauve)"
						label="Remote Tor access"
						trailing={<Switch label="Remote Tor access" on={!!tor.data} disabled={tor.data === undefined || save.isPending} onChange={(v) => save.mutate({path: 'apps.setTorEnabled', input: v, done: v ? 'Tor access is on' : 'Tor access is off', refresh: ['apps.getTorEnabled']})} />}
					/>
					<Row
						icon="shield"
						color="var(--green)"
						label="Public DNS"
						trailing={<Switch label="Public DNS" on={!!dns.data} disabled={dns.data === undefined || save.isPending} onChange={(v) => save.mutate({path: 'system.setExternalDns', input: v, done: v ? 'Using public DNS' : 'Using your router’s DNS', refresh: ['system.isExternalDns']})} />}
					/>
				</Group>
			)}

			<Group title="More" footer="Users, backups, storage, static IP and app-store sources are in the umbrelOS dashboard.">
				{owner && <Row icon="logfile" color="#8e8e93" label="System logs" onClick={() => setSheet('logs')} />}
				<Row icon="open" color="var(--blue)" label="Everything else in umbrelOS" href={settingsUrl} />
				{owner && <Row icon="restart" color="var(--peach)" label="Restart Umbrel" onClick={() => power('restart')} />}
				{owner && <Row icon="power" color="var(--red)" label="Shut down Umbrel" onClick={() => power('shutdown')} />}
				{owner && <Row icon="danger" color="var(--red)" label="Factory reset" onClick={() => setSheet('reset')} />}
			</Group>
			<p className="footer-note">UmbrelOS Touch {boot.touch.version} · Not affiliated with Umbrel</p>

			<NameSheet open={sheet === 'name'} current={user.data?.name ?? ''} onClose={close} />
			<PasswordSheet open={sheet === 'password'} onClose={close} onSignedOut={onSignedOut} />
			<TwoFactorSheet open={sheet === '2fa'} enabled={!!twoFactor.data} onClose={close} />
			<WallpaperSheet open={sheet === 'wallpaper'} current={user.data?.wallpaper} onClose={close} />
			<HostnameSheet open={sheet === 'hostname'} current={hostname.data ?? ''} onClose={close} />
			{sheet === 'wifi' && <WifiSheet onClose={close} connected={wifi.data?.status === 'connected' ? wifi.data.ssid : undefined} />}
			{sheet === 'logs' && <LogsSheet onClose={close} />}
			<ResetSheet
				open={sheet === 'reset'}
				onClose={close}
				onDone={async () => {
					await logout().catch(() => {})
					qc.clear()
					onSignedOut()
				}}
			/>
		</div>
	)
}

// ---- sheets -------------------------------------------------------------------

function Field({id, label, hint, ...input}: {id: string; label: string; hint?: string} & React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			<input id={id} {...input} />
			{hint && <span className="hint">{hint}</span>}
		</div>
	)
}

function NameSheet({open, current, onClose}: {open: boolean; current: string; onClose: () => void}) {
	const save = useSave()
	const [name, setName] = useState(current)
	useEffect(() => setName(current), [current, open])
	return (
		<FormSheet
			open={open}
			title="Name"
			onClose={onClose}
			submit="Save"
			busy={save.isPending}
			disabled={!name.trim() || name.trim() === current}
			onSubmit={() => save.mutate({path: 'user.set', input: {name: name.trim()}, done: 'Name updated', refresh: ['user.get']}, {onSuccess: onClose})}
		>
			<Field id="name" label="Your name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
		</FormSheet>
	)
}

function PasswordSheet({open, onClose, onSignedOut}: {open: boolean; onClose: () => void; onSignedOut: () => void}) {
	const save = useSave()
	const [oldPassword, setOld] = useState('')
	const [newPassword, setNew] = useState('')
	const [repeat, setRepeat] = useState('')
	useEffect(() => {
		setOld('')
		setNew('')
		setRepeat('')
	}, [open])
	const mismatch = repeat !== '' && repeat !== newPassword
	return (
		<FormSheet
			open={open}
			title="Change password"
			subtitle="Used for umbrelOS and UmbrelOS Touch"
			onClose={onClose}
			submit="Change password"
			busy={save.isPending}
			disabled={!oldPassword || newPassword.length < 6 || newPassword !== repeat}
			onSubmit={() =>
				save.mutate(
					{path: 'user.changePassword', input: {oldPassword, newPassword}, done: 'Password changed'},
					{
						onSuccess: async () => {
							onClose()
							// umbrelOS may sign every session out after a password change.
							const still = await fetch('/api/rpc/user.get', {credentials: 'same-origin'}).catch(() => null)
							if (still?.status === 401) onSignedOut()
						},
					},
				)
			}
		>
			<Field id="old" label="Current password" type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoFocus />
			<Field id="new" label="New password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} hint="At least 6 characters." />
			<Field id="repeat" label="Repeat new password" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} hint={mismatch ? 'Passwords don’t match.' : undefined} />
		</FormSheet>
	)
}

function TwoFactorSheet({open, enabled, onClose}: {open: boolean; enabled: boolean; onClose: () => void}) {
	const save = useSave()
	const toast = useToast()
	const uri = useQ<string>('user.generateTotpUri', undefined, {enabled: open && !enabled})
	const [code, setCode] = useState('')
	useEffect(() => setCode(''), [open])
	const secret = uri.data ? (new URL(uri.data).searchParams.get('secret') ?? '') : ''
	const done = {refresh: ['user.is2faEnabled']}
	return (
		<FormSheet
			open={open}
			title="Two-factor authentication"
			subtitle={enabled ? 'On' : 'Off'}
			onClose={onClose}
			submit={enabled ? 'Turn off' : 'Turn on'}
			danger={enabled}
			busy={save.isPending}
			disabled={code.replace(/\s/g, '').length !== 6 || (!enabled && !uri.data)}
			onSubmit={() =>
				save.mutate(
					enabled
						? {path: 'user.disable2fa', input: {totpToken: code.replace(/\s/g, '')}, done: 'Two-factor is off', ...done}
						: {path: 'user.enable2fa', input: {totpUri: uri.data, totpToken: code.replace(/\s/g, '')}, done: 'Two-factor is on', ...done},
					{onSuccess: onClose},
				)
			}
		>
			{!enabled && (
				<div className="glass card" style={{borderRadius: 18, marginBottom: 16}}>
					<p className="prose" style={{margin: '0 0 12px'}}>
						1. Add your Umbrel to an authenticator app (Google Authenticator, 1Password, Authy…).
					</p>
					{uri.data ? (
						<div className="stack">
							<a className="btn primary" href={uri.data}>
								<Icon name="shield" size={19} />
								Add to authenticator app
							</a>
							<button
								type="button"
								className="btn"
								onClick={() => navigator.clipboard?.writeText(secret).then(() => toast('Setup key copied'), () => toast(secret))}
							>
								<span className="mono" style={{fontSize: 13, letterSpacing: '.08em'}}>
									{secret.match(/.{1,4}/g)?.join(' ')}
								</span>
							</button>
							<span className="hint muted" style={{fontSize: 12.5}}>
								Or type that setup key into the app. Tap it to copy.
							</span>
						</div>
					) : (
						<span className="spinner" />
					)}
					<p className="prose" style={{margin: '14px 0 0'}}>
						2. Enter the 6-digit code it shows.
					</p>
				</div>
			)}
			<Field
				id="code"
				label={enabled ? 'Enter a code from your authenticator to turn it off' : '6-digit code'}
				inputMode="numeric"
				autoComplete="one-time-code"
				maxLength={7}
				value={code}
				onChange={(e) => setCode(e.target.value)}
				style={{textAlign: 'center', letterSpacing: '0.3em', fontSize: 20}}
			/>
		</FormSheet>
	)
}

function WallpaperSheet({open, current, onClose}: {open: boolean; current?: Wallpaper | null; onClose: () => void}) {
	const save = useSave()
	const qc = useQueryClient()
	return (
		<Sheet open={open} onClose={onClose} label="umbrelOS wallpaper">
			<SheetHeader title="umbrelOS wallpaper" subtitle="Also used by the Horizon theme" onClose={onClose} />
			<div className="wall-grid" role="radiogroup" aria-label="Wallpaper">
				{WALLPAPER_IDS.map((id) => (
					<button
						key={id}
						role="radio"
						aria-checked={current?.id === id}
						aria-label={`Wallpaper ${id}`}
						style={{backgroundImage: `url(${wallpaperUrl({id, brandColorHsl: null})}?size=thumb)`}}
						onClick={() => {
							haptic(6)
							save.mutate(
								{path: 'user.set', input: {wallpaper: id}, done: 'Wallpaper changed'},
								{onSuccess: () => qc.invalidateQueries({queryKey: ['user.get']})},
							)
						}}
					/>
				))}
			</div>
		</Sheet>
	)
}

function HostnameSheet({open, current, onClose}: {open: boolean; current: string; onClose: () => void}) {
	const save = useSave()
	const [name, setName] = useState(current)
	useEffect(() => setName(current), [current, open])
	const valid = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name.trim().toLowerCase())
	return (
		<FormSheet
			open={open}
			title="Device name"
			subtitle="How your Umbrel appears on your network"
			onClose={onClose}
			submit="Save"
			busy={save.isPending}
			disabled={!valid || name.trim().toLowerCase() === current}
			onSubmit={() => save.mutate({path: 'system.setHostname', input: {hostname: name.trim().toLowerCase()}, done: 'Device name changed', refresh: ['system.getHostname']}, {onSuccess: onClose})}
		>
			<Field
				id="host"
				label="Name"
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				value={name}
				onChange={(e) => setName(e.target.value)}
				hint={valid ? `Reachable at http://${name.trim().toLowerCase()}.local` : 'Letters, numbers and dashes only.'}
				autoFocus
			/>
		</FormSheet>
	)
}

function WifiSheet({onClose, connected}: {onClose: () => void; connected?: string}) {
	const save = useSave()
	const confirm = useConfirm()
	const networks = useQ<{ssid: string; signal: number; authenticated: boolean; active: boolean}[]>('wifi.networks', undefined, {refetchInterval: 10_000})
	const [target, setTarget] = useState<{ssid: string; authenticated: boolean} | null>(null)
	const [password, setPassword] = useState('')
	const connect = (ssid: string, pw?: string) =>
		save.mutate({path: 'wifi.connect', input: {ssid, ...(pw ? {password: pw} : {})}, done: `Connected to ${ssid}`, refresh: ['wifi.connected', 'wifi.networks']}, {onSuccess: () => setTarget(null)})
	return (
		<Sheet open onClose={onClose} label="Wi-Fi">
			<SheetHeader title="Wi-Fi" subtitle={connected ? `Connected to ${connected}` : 'Not connected'} onClose={onClose} />
			{target ? (
				<form
					onSubmit={(e) => {
						e.preventDefault()
						connect(target.ssid, password)
					}}
				>
					<Field id="wifi-pw" label={`Password for ${target.ssid}`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
					<div className="stack">
						<button className="btn primary block" disabled={save.isPending || !password}>
							{save.isPending && <span className="spinner" />}
							Join
						</button>
						<button type="button" className="btn block ghost" onClick={() => setTarget(null)}>
							Back
						</button>
					</div>
				</form>
			) : (
				<>
					<div className="glass group" style={{borderRadius: 18, '--inset': '62px'} as CSSProperties}>
						{networks.isLoading && <div className="row static"><span className="spinner" /> Looking for networks…</div>}
						{(networks.data ?? []).map((n) => (
							<button
								key={n.ssid}
								className="row"
								style={{minHeight: 56}}
								disabled={n.active || save.isPending}
								onClick={() => (n.authenticated ? (setPassword(''), setTarget(n)) : connect(n.ssid))}
							>
								<span className="row-ico" style={{'--c': n.active ? 'var(--green)' : 'var(--blue)'} as CSSProperties}>
									<Icon name="wifi" size={18} />
								</span>
								<span className="main">
									<b style={{fontWeight: 550}}>{n.ssid}</b>
									<span>{n.active ? 'Connected' : `${n.signal}% signal${n.authenticated ? ' · secured' : ''}`}</span>
								</span>
							</button>
						))}
						{networks.data?.length === 0 && <div className="row static muted">No networks found.</div>}
					</div>
					{connected && (
						<button
							className="btn danger block"
							style={{marginTop: 14}}
							onClick={async () => {
								if (await confirm({title: 'Turn off Wi-Fi?', body: 'If Wi-Fi is how your Umbrel connects, you’ll lose access until it’s wired in.', confirm: 'Disconnect', danger: true}))
									save.mutate({path: 'wifi.disconnect', done: 'Wi-Fi disconnected', refresh: ['wifi.connected']})
							}}
						>
							Disconnect
						</button>
					)}
				</>
			)}
		</Sheet>
	)
}

function LogsSheet({onClose}: {onClose: () => void}) {
	const [type, setType] = useState<'umbrelos' | 'system'>('umbrelos')
	const logs = useQ<string>('system.logs', {type, lines: 1500, maxOutputBytes: 400_000})
	const [el, setEl] = useState<HTMLPreElement | null>(null)
	useEffect(() => {
		if (el) el.scrollTop = el.scrollHeight
	}, [el, logs.data])
	return (
		<Sheet open onClose={onClose} label="System logs" tall>
			<SheetHeader title="System logs" subtitle="Latest 1,500 lines" onClose={onClose} />
			<Segmented
				label="Log"
				value={type}
				onChange={setType}
				options={[
					{id: 'umbrelos', label: 'umbrelOS'},
					{id: 'system', label: 'System'},
				]}
			/>
			<pre className="logs" ref={setEl}>
				{logs.isLoading ? 'Loading…' : logs.error ? (logs.error as Error).message : logs.data?.trim() || 'No log output.'}
			</pre>
		</Sheet>
	)
}

function ResetSheet({open, onClose, onDone}: {open: boolean; onClose: () => void; onDone: () => void}) {
	const save = useSave()
	const [password, setPassword] = useState('')
	const [typed, setTyped] = useState('')
	useEffect(() => {
		setPassword('')
		setTyped('')
	}, [open])
	return (
		<FormSheet
			open={open}
			title="Factory reset"
			subtitle="Erases everything on this Umbrel"
			onClose={onClose}
			submit="Erase everything"
			danger
			busy={save.isPending}
			disabled={!password || typed !== 'RESET'}
			onSubmit={() => save.mutate({path: 'system.factoryReset', input: {password}, done: 'Your Umbrel is resetting'}, {onSuccess: onDone})}
		>
			<div className="error" style={{marginBottom: 16}}>
				<Icon name="alert" size={18} />
				All apps, their data, machines, files and settings are permanently deleted, and umbrelOS goes back to its first-time setup. This can’t be undone.
			</div>
			<Field id="reset-pw" label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
			<Field id="reset-type" label="Type RESET to confirm" autoCapitalize="characters" autoCorrect="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
		</FormSheet>
	)
}
