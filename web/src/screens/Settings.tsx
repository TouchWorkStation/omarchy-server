// Full settings, backed by the same omarchyd calls Omarchy Server uses.
import {useContext, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {logout, mutate, query, type ActiveSession, type AssistantApi, type AssistantCheck, type AssistantEffort, type AssistantKey, type AssistantModel, type AssistantProvider, type AssistantVerify} from '../api'
import {resetAssistantTurn} from '../assistantTurn'
import {resetDeskConfig} from '../desktop/config'
import {useBootstrap, useUser} from '../data'
import {checkLiveText} from '../focus'
import {Icon, type IconName} from '../icons'
import {Card, Field, Group, InWindow, Row, Segmented, Sheet, SheetHeader, Switch, VersionTag, haptic, initials, scrollPhoneToTop, setLayoutPref, useConfirm, useLayout, useOmarchyThemes, useToast, type LayoutPref, type Prefs} from '../ui'
import {Appearance} from './More'
import {AssistantAppearanceSettings} from '../character/widgets'
import {OmarchyThemes} from '../OmarchyThemes'
import {StoragePage} from './Storage'
import {BackupsPage} from '../backups'
import {UnraidPage} from '../unraid'
import {WhatsNewSheet, allReleases} from '../WhatsNew'
import {clearTotpSetupQuery} from './twoFactorQuery'
import {PASSWORD_SHEET_SUBTITLE} from './settingsHelpers'

function useQ<T>(path: string, input?: unknown, opts: {enabled?: boolean; refetchInterval?: number | false; staleTime?: number; refetchOnWindowFocus?: boolean; refetchOnReconnect?: boolean} = {}) {
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
		const name = s.client.id === 'omarchy-server' || !s.client.id ? 'Omarchy Server' : s.client.id
		return {icon: 'phone' as IconName, name, detail: [s.client.platform, s.client.appVersion && `v${s.client.appVersion}`].filter(Boolean).join(' · ')}
	}
	const ua = s.client.userAgent ?? ''
	const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
	const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
	return {icon: 'browser' as IconName, name: `${browser}${os ? ` on ${os}` : ''}`, detail: ''}
}

type SheetId = null | 'name' | 'password' | '2fa' | 'hostname' | 'wifi' | 'logs' | 'reset'

export function Settings({prefs, setPrefs, onBack, onSignedOut}: {prefs: Prefs; setPrefs: (p: Prefs) => void; onBack: () => void; onSignedOut: () => void}) {
	const boot = useBootstrap()
	const user = useUser()
	const confirm = useConfirm()
	const save = useSave()
	const qc = useQueryClient()
	const [sheet, setSheet] = useState<SheetId>(null)
	const inWindow = useContext(InWindow)
	const layout = useLayout()
	type Page = 'main' | 'appearance' | 'storage' | 'backups' | 'unraid' | 'omarchy-themes' | 'assistant'
	const [page, setPage] = useState<Page>(() => (sessionStorage.getItem('omarchy-server:settings-page') as Page) || 'main')
	const openPage = (p: Page) => {
		haptic(5)
		if (p === 'main') sessionStorage.removeItem('omarchy-server:settings-page')
		else sessionStorage.setItem('omarchy-server:settings-page', p)
		setPage(p)
		scrollPhoneToTop()
	}
	const close = () => setSheet(null)
	const owner = user.data?.role !== 'member'
	const omarchyTheme = useOmarchyThemes(page === 'appearance')

	const twoFactor = useQ<boolean>('user.is2faEnabled')
	const sessions = useQ<ActiveSession[]>('user.listSessions')
	const check = useQ<{available: boolean; version: string; name: string; releaseNotes?: string}>('system.checkUpdate', undefined, {enabled: owner})
	const [updating, setUpdating] = useState(false)
	const [updateError, setUpdateError] = useState<string | null>(null)
	const [notes, setNotes] = useState(false)
	const [updateNotes, setUpdateNotes] = useState(false)
	const status = useQ<{running: boolean; progress: number; description: string; error: boolean | string}>('system.updateStatus', undefined, {
		enabled: owner && updating,
		refetchInterval: updating ? 1500 : false,
	})
	const hostname = useQ<string>('system.getHostname', undefined, {enabled: owner})
	const ips = useQ<string[]>('system.getIpAddresses')
	const wifiSupported = useQ<boolean>('wifi.supported', undefined, {enabled: owner})
	const wifi = useQ<{status: 'connected' | 'disconnected'; ssid?: string}>('wifi.connected', undefined, {enabled: owner && !!wifiSupported.data})

	const startUpdate = async () => {
		const ok = await confirm({
			title: `Update to ${check.data?.name ?? check.data?.version}?`,
			body: 'Omarchy Server downloads the update, then restarts. Your apps and machines stop briefly. Keep the server powered on.',
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
		if (!(await confirm({title: 'Sign out all other devices?', body: 'Every browser and app signed in to your server, except this phone, is signed out.', confirm: 'Sign out others', danger: true})))
			return
		save.mutate({path: 'user.revokeOtherSessions', done: 'Other devices signed out', refresh: ['user.listSessions']})
	}
	const power = async (kind: 'restart' | 'shutdown') => {
		const ok = await confirm({
			title: kind === 'restart' ? 'Restart your server?' : 'Shut down your server?',
			body: kind === 'restart' ? 'Apps and machines stop, then come back after the restart.' : 'You’ll need to turn the server back on yourself (for a VM, from its host).',
			confirm: kind === 'restart' ? 'Restart' : 'Shut down',
			danger: true,
			icon: kind === 'restart' ? 'restart' : 'power',
		})
		if (ok) save.mutate({path: `system.${kind}`, done: kind === 'restart' ? 'Your server is restarting' : 'Your server is shutting down'})
	}


	if (page === 'storage') return <StoragePage onBack={() => openPage('main')} target="host" />
	if (page === 'backups' && owner) return <BackupsPage onBack={() => openPage('main')} />
	if (page === 'unraid' && owner) return <UnraidPage onBack={() => openPage('main')} />
	if (page === 'assistant') return <AssistantPage onBack={() => openPage('main')} />
	if (page === 'omarchy-themes')
		return (
			<div className="stagger">
				<div className="page-head" style={{margin: '6px 0 14px'}}>
					<button className="round-btn" aria-label="Back" onClick={() => openPage('appearance')}>
						<Icon name="back" size={20} />
					</button>
					<h1 className="title">Themes</h1>
				</div>
				<OmarchyThemes owner={owner} />
			</div>
		)
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
						<h2>Omarchy</h2>
					</div>
					<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
						<Row icon="palette" color="var(--blue)" label="Themes" value={omarchyTheme.data?.label ?? undefined} onClick={() => openPage('omarchy-themes')} />
					</div>
					<p className="footer-note" style={{textAlign: 'left', margin: '10px 6px 0'}}>
						Your Omarchy desktop’s themes. Switch the whole desktop, or get more from the Omarchy manual.
					</p>
				</section>
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
						Desktop gives you windows, a dock and Activities, like Ubuntu. Automatic uses it on a big screen with a mouse or trackpad (on this screen: {layout.detected ? 'Desktop' : 'Phone'}). Saved on this device only.
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
								{user.data?.role === 'member' ? 'Member' : 'Owner'} · {boot.server?.device ?? 'server'}
							</span>
						</span>
					</div>
					<Row icon="user" color="var(--blue)" label="Name" value={user.data?.name} onClick={() => setSheet('name')} />
					<Row icon="key" color="#8e8e93" label="Password" onClick={() => setSheet('password')} />
					<Row icon="shield" color="var(--green)" label="Two-factor authentication" value={twoFactor.data === undefined ? '' : twoFactor.data ? 'On' : 'Off'} onClick={() => setSheet('2fa')} />
				</div>
			</div>

			<div>
				<div className="section-head" style={{marginTop: 18}} />
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					<Row icon="palette" color="var(--pink, #ec4899)" label="Appearance" onClick={() => openPage('appearance')} />
					{owner && <Row icon="disk" color="var(--teal)" label="Storage" onClick={() => openPage('storage')} />}
					{owner && <Row icon="history" color="var(--green)" label="Backups" onClick={() => openPage('backups')} />}
					{owner && <Row icon="move" color="var(--orange, #f59e0b)" label="Move from Unraid" onClick={() => openPage('unraid')} />}
				</div>
			</div>

			<div>
				<div className="section-head" style={{marginTop: 18}} />
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					<Row icon="sparkle" color="var(--accent)" label="Assistant" onClick={() => openPage('assistant')} />
				</div>
			</div>

			<Group title="Signed-in devices" footer="Every browser and app signed in to your server with your account.">
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
					<Row icon="sparkle" color="var(--pink)" label="What’s new" value={<VersionTag version={boot.touch.version} info={boot.server} />} onClick={() => setNotes(true)} />
					{notes && <WhatsNewSheet releases={allReleases(boot.touch.version)} version={boot.touch.version} onClose={() => setNotes(false)} />}
					<Row icon="server" color="var(--blue)" label="Omarchy Server" value={<VersionTag version={boot.server?.version} info={boot.server} />} />
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
							<span className="muted" style={{fontSize: 12.5}}>Omarchy Server restarts when this finishes, and this page reloads by itself.</span>
						</div>
					) : check.data?.available ? (
						<>
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
							{check.data.releaseNotes && (
								<div className="row static" style={{display: 'block', paddingBlock: 12}}>
									<button className="link-btn" onClick={() => setUpdateNotes((n) => !n)}>
										{updateNotes ? 'Hide what’s new' : `What’s new in ${check.data.version}`}
									</button>
									{updateNotes && <UpdateNotes text={check.data.releaseNotes} />}
								</div>
							)}
						</>
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

				</Group>
			)}

			{owner && (
				<Group title="Network & privacy">
					<Row icon="network" color="var(--teal)" label="Device name" value={hostname.data ? `${hostname.data}.local` : ''} onClick={() => setSheet('hostname')} />
					<Row icon="networking" color="var(--blue)" label="IP address" value={(ips.data ?? []).join(', ') || '–'} />
					{wifiSupported.data && <Row icon="wifi" color="var(--blue)" label="Wi-Fi" value={wifi.data?.status === 'connected' ? wifi.data.ssid : 'Off'} onClick={() => setSheet('wifi')} />}
				</Group>
			)}

			<Group
				title="Secure connection"
				footer={
					<>
						Apps such as Brave (HTTPS), Vaultwarden and Actual only work on https:// pages. Omarchy Server answers https:// on the same address with its own
						certificate. To stop the browser warning, trust it on each device: iPhone and iPad, open the downloaded profile in Settings → General → VPN &
						Device Management, then turn it on in General → About → Certificate Trust Settings. Mac: open it, then in Keychain Access set it to Always Trust.
						Windows: open it and install it under Trusted Root Certification Authorities. Android: Settings → Security → Install a certificate → CA certificate.
					</>
				}
			>
				<Row icon="shield" color="var(--green)" label="This connection" value={location.protocol === 'https:' ? 'Secure (https)' : 'Not secure (http)'} />
				{location.protocol !== 'https:' && <Row icon="key" color="var(--blue)" label="Use the secure address" value={`https://${location.host}`} href={`https://${location.host}${location.pathname}`} />}
				<Row icon="download" color="var(--teal)" label="Trust this server on this device" value="Certificate" href="/api/tls/ca.crt" />
			</Group>

			{owner && <SecurityGroup />}

			<Group title="More">
				{owner && <Row icon="logfile" color="#8e8e93" label="System logs" onClick={() => setSheet('logs')} />}
				{owner && <Row icon="restart" color="var(--peach)" label="Restart server" onClick={() => power('restart')} />}
				{owner && <Row icon="power" color="var(--red)" label="Shut down server" onClick={() => power('shutdown')} />}
				{owner && <Row icon="danger" color="var(--red)" label="Factory reset" onClick={() => setSheet('reset')} />}
			</Group>
			<p className="footer-note">
				<VersionTag prefix="Omarchy Server " version={boot.touch.version} info={boot.server} />
			</p>

			<NameSheet open={sheet === 'name'} current={user.data?.name ?? ''} onClose={close} />
			<PasswordSheet open={sheet === 'password'} onClose={close} />
			<TwoFactorSheet open={sheet === '2fa'} enabled={!!twoFactor.data} onClose={close} />
			<HostnameSheet open={sheet === 'hostname'} current={hostname.data ?? ''} onClose={close} />
			{sheet === 'wifi' && <WifiSheet onClose={close} connected={wifi.data?.status === 'connected' ? wifi.data.ssid : undefined} />}
			{sheet === 'logs' && <LogsSheet onClose={close} />}
			<ResetSheet
				open={sheet === 'reset'}
				onClose={close}
				onDone={async () => {
					await logout().catch(() => {})
					qc.clear()
					resetDeskConfig()
					resetAssistantTurn()
					onSignedOut()
				}}
			/>
		</div>
	)
}

// ---- sheets -------------------------------------------------------------------

const PROVIDER_LABEL: Record<AssistantProvider, string> = {
	spacexai: 'Grok (SpaceXAI)',
	openai: 'OpenAI API',
	anthropic: 'Anthropic API',
	'openai-compatible': 'Custom endpoint',
	chatgpt: 'ChatGPT plan',
}

const MODEL_PLACEHOLDER: Record<AssistantProvider, string> = {
	spacexai: 'grok-4.7',
	openai: 'gpt-5.5',
	anthropic: 'claude-sonnet-5-5',
	'openai-compatible': 'llama3.2',
	chatgpt: 'gpt-5.5',
}

// The result of a live check, under a key or in Add provider.
function CheckLine({check, busy}: {check: Pick<AssistantCheck, 'ok' | 'message'> | null; busy?: boolean}) {
	const style: CSSProperties = {textAlign: 'left', margin: '2px 6px 8px', display: 'flex', gap: 6, alignItems: 'center'}
	const live = checkLiveText(check, busy)
	return (
		<>
			<div role="status" aria-live="polite" aria-atomic="true">
				{live.status ? (
					<p className="footer-note" style={busy ? style : {...style, color: 'var(--green)'}}>
						{busy ? <span className="spinner" /> : <Icon name="check" size={15} />}
						{live.status}
					</p>
				) : null}
			</div>
			<div role="alert" aria-live="assertive" aria-atomic="true">
				{live.alert ? (
					<p className="footer-note" style={{...style, color: 'var(--red)'}}>
						<Icon name="alert" size={15} />
						{live.alert}
					</p>
				) : null}
			</div>
		</>
	)
}

// Checks the endpoint (and so the key) a moment after the details stop changing, and keeps its model list.
function useEndpointCheck(target: Record<string, unknown> | null, model: string) {
	const [result, setResult] = useState<AssistantVerify | null>(null)
	const [busy, setBusy] = useState(false)
	const sig = target ? JSON.stringify(target) : ''
	useEffect(() => {
		setResult(null)
		if (!sig) return
		let live = true
		const t = setTimeout(async () => {
			setBusy(true)
			try {
				const r = await mutate<AssistantVerify>('assistant.verifyKey', JSON.parse(sig))
				if (live) setResult(r)
			} catch (e) {
				if (live) setResult({ok: false, status: 'error', message: (e as Error).message, at: Date.now(), modelFound: null, models: []})
			} finally {
				if (live) setBusy(false)
			}
		}, 600)
		return () => {
			live = false
			clearTimeout(t)
			setBusy(false)
		}
	}, [sig])
	const models = result?.models ?? []
	const wanted = model.trim()
	let check: Pick<AssistantCheck, 'ok' | 'message'> | null = result
	// The list is already here, so the model being typed is judged without asking the endpoint again.
	if (result && (result.status === 'ok' || result.status === 'no-model') && wanted && models.length) {
		check = models.some((m) => m.id === wanted)
			? {ok: true, message: `Connected · ${models.length} model${models.length === 1 ? '' : 's'} available`}
			: {ok: false, message: `Key works, but ${wanted} isn’t one of the ${models.length} models this endpoint serves`}
	}
	return {busy, check, models}
}

const API_OPTIONS: {id: AssistantApi; label: string}[] = [
	{id: 'chat', label: 'Chat Completions'},
	{id: 'responses', label: 'Responses'},
]
const EFFORT_OPTIONS: {id: AssistantEffort; label: string}[] = [
	{id: '', label: 'Default'},
	{id: 'low', label: 'Low'},
	{id: 'medium', label: 'Medium'},
	{id: 'high', label: 'High'},
]

// OpenAI and most local servers (Ollama, vLLM, LM Studio) serve both.
const pickApi = (provider: AssistantProvider) => provider === 'openai' || provider === 'openai-compatible'
const defaultApi = (provider: AssistantProvider): AssistantApi => (provider === 'openai' ? 'responses' : 'chat')

function ModelField({id, value, onChange, models, provider}: {id: string; value: string; onChange: (v: string) => void; models: AssistantModel[]; provider: AssistantProvider}) {
	const listId = `${id}-models`
	return (
		<>
			<Field
				id={id}
				label="Model"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={MODEL_PLACEHOLDER[provider] ?? models[0]?.id}
				list={models.length ? listId : undefined}
				hint={models.length ? `${models.length} models from the endpoint. Pick one or type an id.` : 'Must match a model id the endpoint serves.'}
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
			/>
			{models.length > 0 && (
				<datalist id={listId}>
					{models.map((m) => (
						<option key={m.id} value={m.id}>
							{m.name ?? ''}
						</option>
					))}
				</datalist>
			)}
		</>
	)
}

function AssistantPage({onBack}: {onBack: () => void}) {
	const boot = useBootstrap()
	const user = useUser()
	const confirm = useConfirm()
	const save = useSave()
	const owner = user.data?.role !== 'member'
	const self = user.data?.userId
	const keys = useQ<AssistantKey[]>('assistant.keys')
	const [add, setAdd] = useState(false)
	const [share, setShare] = useState<AssistantKey | null>(null)
	const [edit, setEdit] = useState<AssistantKey | null>(null)
	const [signIn, setSignIn] = useState<{keyId?: string} | null>(null)
	const [modelFor, setModelFor] = useState<AssistantKey | null>(null)
	const [checking, setChecking] = useState<string | null>(null)
	const qc = useQueryClient()
	const toast = useToast()
	const check = async (k: AssistantKey) => {
		setChecking(k.id)
		try {
			const r = await mutate<AssistantVerify>('assistant.verifyKey', {id: k.id})
			toast(r.message, !r.ok)
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setChecking(null)
			qc.invalidateQueries({queryKey: ['assistant.keys']})
		}
	}
	const list = keys.data ?? []
	const remove = async (k: AssistantKey) => {
		const chat = k.provider === 'chatgpt'
		const ok = await confirm({
			title: chat ? 'Sign out of ChatGPT?' : `Delete ${k.name}?`,
			body: chat ? 'The assistant stops using your ChatGPT plan, and Omarchy Server’s access to it is revoked.' : 'The assistant won’t use this key. Anyone you shared it with loses access.',
			confirm: chat ? 'Sign out' : 'Delete',
			danger: true,
			icon: 'trash',
		})
		if (ok) save.mutate({path: 'assistant.removeKey', input: {id: k.id}, done: `${k.name} deleted`, refresh: ['assistant.keys']})
	}
	return (
		<div className="stagger">
			<div className="page-head" style={{margin: '6px 0 14px'}}>
				<button className="round-btn" aria-label="Back" onClick={onBack}>
					<Icon name="back" size={20} />
				</button>
				<h1 className="title" style={{flex: 1}}>
					Assistant
				</h1>
				<button className="btn small" onClick={() => (haptic(6), setAdd(true))}>
					<Icon name="plus" size={16} stroke={2.4} />
					Add
				</button>
			</div>

			{keys.isLoading && (
				<div className="glass group">
					<div className="row static">
						<span className="spinner" />
					</div>
				</div>
			)}
			{keys.error && (
				<div className="error">
					<Icon name="alert" size={18} />
					{(keys.error as Error).message}
				</div>
			)}
			{keys.isSuccess && list.length === 0 && (
				<div className="glass empty">
					<span className="big">
						<Icon name="sparkle" size={30} />
					</span>
					<b>Sign in with ChatGPT, or add an API key, to talk to the assistant.</b>
					<button className="btn primary small" onClick={() => setAdd(true)}>
						Add
					</button>
				</div>
			)}
			{keys.isSuccess && !list.some((k) => k.provider === 'chatgpt' && k.mine) && (
				<div className="glass group" style={{'--inset': '62px', marginBottom: 14} as CSSProperties}>
					<Row icon="sparkle" color="var(--green)" label="Sign in with ChatGPT" sub="Use your ChatGPT Plus or Pro plan. No API key." onClick={() => (haptic(6), setSignIn({}))} />
				</div>
			)}
			{list.map((k) => (
				<Group
					key={k.id}
					title={k.name}
					footer={k.provider === 'chatgpt' ? (k.signedIn === false ? 'Signed out' : 'Only for you') : k.systemDefault ? 'System default' : k.mine ? undefined : 'Shared with you'}
				>
					<div className="row static" style={{minHeight: 62}}>
						<span className="row-ico" style={{'--c': 'var(--accent)'} as CSSProperties}>
							<Icon name="sparkle" size={19} />
						</span>
						<span className="main">
							<b style={{fontWeight: 550}}>{PROVIDER_LABEL[k.provider] ?? k.provider}</b>
							<span>
								{k.provider === 'chatgpt' ? [k.account, k.model].filter(Boolean).join(' · ') || 'ChatGPT plan' : k.model}
								{k.provider !== 'chatgpt' && k.api === 'responses' ? ' · Responses' : ''}
								{k.provider !== 'chatgpt' && k.effort ? ` · ${k.effort} reasoning` : ''}
								{k.last4 ? ` · …${k.last4}` : ''}
							</span>
						</span>
					</div>
					{k.provider !== 'chatgpt' && <CheckLine check={k.check ?? null} />}
					{k.provider !== 'chatgpt' && (
						<Row
							icon="check"
							color="var(--green)"
							label={checking === k.id ? 'Checking…' : 'Check connection'}
							trailing={checking === k.id ? <span className="spinner" /> : undefined}
							onClick={() => checking || check(k)}
						/>
					)}
					{k.provider === 'chatgpt' && k.mine && k.signedIn === false && (
						<Row icon="alert" color="var(--red)" label="Signed out of ChatGPT" sub="Sign in again to keep using your plan" onClick={() => setSignIn({keyId: k.id})} />
					)}
					{k.provider === 'chatgpt' && k.mine && k.signedIn !== false && <Row icon="sparkle" color="var(--accent)" label="Model" value={k.model || 'Choose'} onClick={() => setModelFor(k)} />}
					{k.mine && k.provider !== 'chatgpt' && <Row icon="pencil" color="var(--accent)" label="Edit" value="Name, key, model" onClick={() => setEdit(k)} />}
					{k.mine && k.provider !== 'chatgpt' && (
						<Row
							icon="share"
							color="var(--blue)"
							label="Share"
							value={k.sharedWith.length ? String(k.sharedWith.length) : undefined}
							onClick={() => setShare(k)}
						/>
					)}
					{owner && k.mine && k.provider !== 'chatgpt' && (
						<Row
							icon="star"
							color="var(--peach)"
							label="Use as system default"
							trailing={
								<Switch
									on={k.systemDefault}
									label="Use as system default"
									disabled={save.isPending}
									onChange={(v) =>
										save.mutate({
											path: 'assistant.updateKey',
											input: {id: k.id, systemDefault: v},
											done: v ? 'This key is the system default' : 'No longer the system default',
											refresh: ['assistant.keys'],
										})
									}
								/>
							}
						/>
					)}
					{k.mine && <Row icon="trash" color="var(--red)" label={k.provider === 'chatgpt' ? 'Sign out of ChatGPT' : 'Delete'} onClick={() => remove(k)} />}
				</Group>
			))}
			{!owner && list.length === 0 && keys.isSuccess && (
				<p className="footer-note" style={{textAlign: 'left', margin: '10px 6px 0'}}>
					Sign in with your own ChatGPT, add your own key, or ask the owner to share one.
				</p>
			)}

			<AssistantAppearanceSettings />

			<AddKeySheet open={add} owner={user.data?.role === 'owner'} onClose={() => setAdd(false)} />
			<EditKeySheet open={!!edit} keyRow={edit} owner={user.data?.role === 'owner'} onClose={() => setEdit(null)} />
			{signIn && <ChatGptSignInSheet keyId={signIn.keyId} onClose={() => setSignIn(null)} />}
			{modelFor && <ChatGptModelSheet keyRow={modelFor} onClose={() => setModelFor(null)} />}
			<ShareKeySheet open={!!share} keyRow={share} accounts={boot.accounts} self={self} onClose={() => setShare(null)} />
		</div>
	)
}

function AddKeySheet({open, owner, onClose}: {open: boolean; owner: boolean; onClose: () => void}) {
	const save = useSave()
	const [provider, setProvider] = useState<AssistantProvider>('spacexai')
	const [name, setName] = useState('')
	const [model, setModel] = useState('')
	const [apiKey, setApiKey] = useState('')
	const [baseUrl, setBaseUrl] = useState('')
	useEffect(() => {
		setProvider('spacexai')
		setName('')
		setModel('')
		setApiKey('')
		setBaseUrl('')
	}, [open])
	const qc = useQueryClient()
	const [api, setApi] = useState<AssistantApi>('chat')
	useEffect(() => setApi(defaultApi(provider)), [provider, open])
	const custom = provider === 'openai-compatible'
	const keyOk = custom || apiKey.trim().length >= 4
	const urlOk = !custom || /^https?:\/\/[^\s]+/i.test(baseUrl.trim())
	const ready = keyOk && !!model.trim() && urlOk
	// The key goes to the chosen provider only once it's been entered (the field is left), never while
	// it's being pasted under another provider. A keyless local endpoint is checked straight away.
	const [keyEntered, setKeyEntered] = useState(false)
	useEffect(() => setKeyEntered(false), [open, provider])
	const checkable = open && keyOk && urlOk && (keyEntered || (custom && !apiKey.trim()))
	const live = useEndpointCheck(checkable ? {provider, apiKey: apiKey.trim(), ...(custom ? {baseUrl: baseUrl.trim()} : {})} : null, model)
	// Once the list arrives, fill in a model unless one was typed.
	useEffect(() => {
		if (!model.trim() && live.models.length) setModel((live.models.find((m) => m.id === MODEL_PLACEHOLDER[provider]) ?? live.models[0]).id)
	}, [live.models]) // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<FormSheet
			open={open}
			title="Add provider"
			onClose={onClose}
			submit="Add"
			busy={save.isPending}
			disabled={!ready}
			onSubmit={() =>
				save.mutate(
					{
						path: 'assistant.addKey',
						input: {
							provider,
							name: name.trim(),
							model: model.trim(),
							apiKey: apiKey.trim(),
							...(provider === 'openai-compatible' ? {baseUrl: baseUrl.trim()} : {}),
							...(pickApi(provider) ? {api} : {}),
						},
						done: 'Provider added',
						refresh: ['assistant.keys'],
					},
					{
						// Record a first check on the saved key, so its row shows whether it works.
						onSuccess: (row) => {
							onClose()
							const id = (row as AssistantKey | undefined)?.id
							if (id) mutate('assistant.verifyKey', {id}).catch(() => {}).finally(() => qc.invalidateQueries({queryKey: ['assistant.keys']}))
						},
					},
				)
			}
		>
			<Segmented
				label="Provider"
				value={provider}
				onChange={(v) => {
					setProvider(v)
					setModel('')
					// A key belongs to one provider; don't carry it over to another.
					setApiKey('')
					if (v === 'openai-compatible' && !baseUrl.trim()) setBaseUrl('http://127.0.0.1:11434/v1')
				}}
				options={[
					{id: 'spacexai', label: 'Grok'},
					{id: 'openai', label: 'OpenAI'},
					{id: 'anthropic', label: 'Anthropic'},
					// A custom address makes the server send requests anywhere it can reach: owner only.
					...(owner ? [{id: 'openai-compatible' as const, label: 'Custom'}] : []),
				]}
			/>
			<Field id="ask-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
			{custom && (
				<Field
					id="ask-url"
					label="Base URL"
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder="http://127.0.0.1:11434/v1"
					hint="Include /v1. Local Ollama is http://127.0.0.1:11434/v1."
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
			)}
			<Field
				id="ask-key"
				label="API key"
				type="password"
				autoComplete="off"
				value={apiKey}
				onChange={(e) => setApiKey(e.target.value)}
				onBlur={() => setKeyEntered(true)}
				hint={custom ? 'Leave blank for local Ollama.' : 'Checked with the provider when you move on from this field.'}
			/>
			<CheckLine check={live.check} busy={live.busy} />
			<ModelField id="ask-model" value={model} onChange={setModel} models={live.models} provider={provider} />
			{pickApi(provider) && <Segmented label="API" value={api} onChange={setApi} options={API_OPTIONS} />}
		</FormSheet>
	)
}

// Change a saved provider: its name, key, address (custom endpoints), model, API and reasoning.
function EditKeySheet({open, keyRow, owner, onClose}: {open: boolean; keyRow: AssistantKey | null; owner: boolean; onClose: () => void}) {
	const save = useSave()
	const qc = useQueryClient()
	const [name, setName] = useState('')
	const [apiKey, setApiKey] = useState('')
	const [baseUrl, setBaseUrl] = useState('')
	const [model, setModel] = useState('')
	const [api, setApi] = useState<AssistantApi>('chat')
	const [effort, setEffort] = useState<AssistantEffort>('')
	const [keyEntered, setKeyEntered] = useState(false)
	useEffect(() => {
		setName(keyRow?.name ?? '')
		setApiKey('')
		setBaseUrl(keyRow?.baseUrl ?? '')
		setModel(keyRow?.model ?? '')
		setApi(keyRow?.api ?? 'chat')
		setEffort(keyRow?.effort ?? '')
		setKeyEntered(false)
	}, [keyRow, open])
	const custom = keyRow?.provider === 'openai-compatible'
	const canPick = !!keyRow && pickApi(keyRow.provider)
	// Blank keeps the saved key. A new one must look like a key, except on a custom endpoint.
	const newKey = apiKey.trim()
	const keyOk = !newKey || custom || newKey.length >= 4
	const urlChanged = custom && owner && baseUrl.trim() !== keyRow?.baseUrl
	const urlOk = !urlChanged || /^https?:\/\/[^\s]+/i.test(baseUrl.trim())
	// A new key is checked once its field is left, as when adding one; otherwise the saved key is.
	const target = open && keyRow && keyOk && urlOk ? {id: keyRow.id, ...(newKey && keyEntered ? {apiKey: newKey} : {}), ...(urlChanged ? {baseUrl: baseUrl.trim()} : {})} : null
	const live = useEndpointCheck(target, model)
	const changes: Record<string, unknown> = {}
	if (keyRow) {
		if (name.trim() && name.trim() !== keyRow.name) changes.name = name.trim()
		if (newKey) changes.apiKey = newKey
		if (urlChanged) changes.baseUrl = baseUrl.trim()
		if (model.trim() && model.trim() !== keyRow.model) changes.model = model.trim()
		if (canPick && api !== keyRow.api) changes.api = api
		if (effort !== keyRow.effort) changes.effort = effort
	}
	return (
		<FormSheet
			open={open}
			title="Edit provider"
			subtitle={keyRow ? PROVIDER_LABEL[keyRow.provider] : undefined}
			onClose={onClose}
			submit="Save"
			busy={save.isPending}
			disabled={!keyRow || !model.trim() || !keyOk || !urlOk || !Object.keys(changes).length}
			onSubmit={() =>
				keyRow &&
				save.mutate(
					{path: 'assistant.updateKey', input: {id: keyRow.id, ...changes}, done: 'Saved', refresh: ['assistant.keys']},
					{
						onSuccess: () => {
							onClose()
							// A new key or address clears the old check; record a fresh one for the row.
							if (changes.apiKey || changes.baseUrl || changes.model) mutate('assistant.verifyKey', {id: keyRow.id}).catch(() => {}).finally(() => qc.invalidateQueries({queryKey: ['assistant.keys']}))
						},
					},
				)
			}
		>
			<Field id="edit-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} />
			{custom && owner && (
				<Field
					id="edit-url"
					label="Base URL"
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder="http://127.0.0.1:11434/v1"
					hint="Include /v1."
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
			)}
			<Field
				id="edit-key"
				label="API key"
				type="password"
				autoComplete="off"
				value={apiKey}
				onChange={(e) => {
					setApiKey(e.target.value)
					setKeyEntered(false)
				}}
				onBlur={() => setKeyEntered(true)}
				placeholder={keyRow?.last4 ? `Saved key …${keyRow.last4}` : 'No key saved'}
				hint="Leave blank to keep the saved key."
			/>
			<CheckLine check={live.check} busy={live.busy} />
			{keyRow && <ModelField id="edit-model" value={model} onChange={setModel} models={live.models} provider={keyRow.provider} />}
			{canPick && <Segmented label="API" value={api} onChange={setApi} options={API_OPTIONS} />}
			<Segmented label="Reasoning" value={effort} onChange={setEffort} options={EFFORT_OPTIONS} />
			<p className="footer-note" style={{textAlign: 'left', margin: '2px 6px 0'}}>
				How hard a reasoning model thinks before answering. Default leaves it to the model; models that don’t reason may refuse a level.
			</p>
		</FormSheet>
	)
}

function ShareKeySheet({
	open,
	keyRow,
	accounts,
	self,
	onClose,
}: {
	open: boolean
	keyRow: AssistantKey | null
	accounts: {userId: string; name: string}[]
	self?: string
	onClose: () => void
}) {
	const save = useSave()
	const others = accounts.filter((a) => a.userId !== self)
	const [picked, setPicked] = useState<string[]>([])
	useEffect(() => setPicked(keyRow ? [...keyRow.sharedWith] : []), [keyRow, open])
	const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
	return (
		<FormSheet
			open={open}
			title="Share"
			subtitle={keyRow?.name}
			onClose={onClose}
			submit="Save"
			busy={save.isPending}
			onSubmit={() =>
				save.mutate(
					{path: 'assistant.updateKey', input: {id: keyRow?.id, sharedWith: picked}, done: 'Sharing updated', refresh: ['assistant.keys']},
					{onSuccess: onClose},
				)
			}
		>
			{others.length === 0 ? (
				<p className="prose" style={{margin: '0 0 8px'}}>
					No other accounts on this server.
				</p>
			) : (
				<div className="glass group" style={{borderRadius: 18, marginBottom: 12, '--inset': '62px'} as CSSProperties}>
					{others.map((a) => (
						<button type="button" key={a.userId} className="row" style={{minHeight: 56}} onClick={() => toggle(a.userId)}>
							<span className="row-ico" style={{'--c': 'var(--blue)'} as CSSProperties}>
								<Icon name="user" size={19} />
							</span>
							<span className="main">
								<b style={{fontWeight: 550}}>{a.name}</b>
							</span>
							<Icon name={picked.includes(a.userId) ? 'checked' : 'unchecked'} size={22} />
						</button>
					))}
				</div>
			)}
		</FormSheet>
	)
}

// Sign in with ChatGPT. OpenAI sends the browser back to http://127.0.0.1:<port>/auth/callback.
// On this server's own browser, omarchyd catches that by itself; anywhere else that page won't load,
// and its address is pasted here. Access and refresh tokens stay on the server.
function ChatGptSignInSheet({keyId, onClose}: {keyId?: string; onClose: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const [url, setUrl] = useState<string | null>(null)
	const [pasted, setPasted] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const done = (k: AssistantKey) => {
		void qc.invalidateQueries({queryKey: ['assistant.keys']})
		toast(k.account ? `Signed in as ${k.account}` : 'Signed in to ChatGPT')
		onClose()
	}
	const status = useQuery({
		queryKey: ['assistant.chatgptStatus'],
		queryFn: () => query<{pending: boolean; key?: AssistantKey}>('assistant.chatgptStatus'),
		enabled: !!url,
		refetchInterval: 2000,
		gcTime: 0,
	})
	useEffect(() => {
		if (status.data?.key) done(status.data.key)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status.data?.key])
	const open = async () => {
		haptic(6)
		setError(null)
		// Opened in the tap, so it isn't blocked as a pop-up; pointed at ChatGPT once the address is ready.
		const tab = window.open('about:blank', '_blank')
		try {
			const r = await mutate<{url: string}>('assistant.chatgptStart', keyId ? {keyId} : {})
			if (!r.url.startsWith('https://auth.openai.com/')) throw new Error('ChatGPT didn’t finish the sign-in')
			setUrl(r.url)
			if (tab) tab.location.href = r.url
		} catch (e) {
			tab?.close()
			setError((e as Error).message)
		}
	}
	const finish = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			done(await mutate<AssistantKey>('assistant.chatgptFinish', {url: pasted.trim()}))
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet open onClose={onClose} label="Sign in with ChatGPT">
			<SheetHeader
				icon={
					<span className="sheet-icon" style={{background: 'linear-gradient(135deg, var(--green), var(--accent))'}}>
						<Icon name="sparkle" size={28} />
					</span>
				}
				title="Sign in with ChatGPT"
				subtitle="The assistant uses your ChatGPT Plus or Pro plan"
				onClose={onClose}
			/>
			<form className="screen chatgpt-signin" onSubmit={finish}>
				<ol className="chatgpt-steps">
					<li>Open ChatGPT, sign in, and allow Omarchy Server to use your plan.</li>
					<li>On this server’s own browser, that’s it: this finishes by itself.</li>
					<li>Anywhere else, you’ll land on a page that won’t load. Copy its whole address and paste it below.</li>
				</ol>
				<button type="button" className="btn primary block" onClick={open}>
					<Icon name="sparkle" size={18} /> {url ? 'Open ChatGPT again' : 'Open ChatGPT'}
				</button>
				{url && (
					<p className="muted" style={{fontSize: '0.85em', margin: 0}}>
						Didn’t open?{' '}
						<a href={url} target="_blank" rel="noreferrer">
							Open the sign-in page
						</a>
						.
					</p>
				)}
				{url && (
					<>
						<Field
							id="chatgpt-callback"
							label="Address of the page that didn’t load"
							value={pasted}
							onChange={(e) => setPasted(e.target.value)}
							placeholder="http://127.0.0.1:1455/auth/callback?code=…"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							inputMode="url"
						/>
						<button className="btn block" type="submit" disabled={busy || !/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback\?/.test(pasted.trim())}>
							{busy ? <span className="spinner" /> : 'Finish signing in'}
						</button>
					</>
				)}
				{error && (
					<div className="error" role="alert">
						<Icon name="alert" size={18} />
						{error}
					</div>
				)}
				<p className="footer-note" style={{textAlign: 'left', margin: 0}}>
					Your ChatGPT sign-in stays on this server, only for you. Omarchy Server can use your plan for the assistant; it can’t see your ChatGPT chats.
				</p>
			</form>
		</Sheet>
	)
}

function ChatGptModelSheet({keyRow, onClose}: {keyRow: AssistantKey; onClose: () => void}) {
	const save = useSave()
	const models = useQuery({queryKey: ['assistant.models', keyRow.id], queryFn: () => query<{id: string; name: string}[]>('assistant.models', {id: keyRow.id}), retry: false})
	return (
		<Sheet open onClose={onClose} label="Model">
			<SheetHeader title="Model" subtitle="Models your ChatGPT plan can use" onClose={onClose} />
			<div className="screen">
				{models.isLoading && <span className="spinner" />}
				{models.error && (
					<div className="error" role="alert">
						<Icon name="alert" size={18} />
						{(models.error as Error).message}
					</div>
				)}
				{models.data && (
					<div className="glass group">
						{models.data.map((m) => (
							<Row
								key={m.id}
								icon={m.id === keyRow.model ? 'check' : 'sparkle'}
								color={m.id === keyRow.model ? 'var(--green)' : 'var(--accent)'}
								label={m.name}
								value={m.id === keyRow.model ? 'In use' : undefined}
								onClick={() => save.mutate({path: 'assistant.updateKey', input: {id: keyRow.id, model: m.id}, done: `Using ${m.name}`, refresh: ['assistant.keys']}, {onSuccess: onClose})}
							/>
						))}
					</div>
				)}
			</div>
		</Sheet>
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

function PasswordSheet({open, onClose}: {open: boolean; onClose: () => void}) {
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
			subtitle={PASSWORD_SHEET_SUBTITLE}
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
							// Omarchy Server may sign every session out after a password change.
							// This fetch does not go through the client that fires touch:signed-out.
							const still = await fetch('/api/rpc/user.get', {credentials: 'same-origin'}).catch(() => null)
							if (still?.status === 401) window.dispatchEvent(new Event('touch:signed-out'))
						},
					},
				)
			}
		>
			<Field id="old" label="Current password" type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoFocus />
			<Field id="new" label="New password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} hint="At least 6 characters." />
			<Field id="repeat" label="Repeat new password" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} error={mismatch ? 'Passwords don’t match.' : undefined} />
		</FormSheet>
	)
}

function TwoFactorSheet({open, enabled, onClose}: {open: boolean; enabled: boolean; onClose: () => void}) {
	const save = useSave()
	const toast = useToast()
	const qc = useQueryClient()
	// One setup key while this sheet is open. Closing it, or turning two-factor on or off,
	// drops that key so the next open asks for a new one.
	const uri = useQ<string>('user.generateTotpUri', undefined, {enabled: open && !enabled, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false})
	const [code, setCode] = useState('')
	useEffect(() => setCode(''), [open])
	const secret = uri.data ? (new URL(uri.data).searchParams.get('secret') ?? '') : ''
	const done = {refresh: ['user.is2faEnabled']}
	return (
		<FormSheet
			open={open}
			title="Two-factor authentication"
			subtitle={enabled ? 'On' : 'Off'}
			onClose={() => {
				clearTotpSetupQuery(qc, 'close')
				onClose()
			}}
			submit={enabled ? 'Turn off' : 'Turn on'}
			danger={enabled}
			busy={save.isPending}
			disabled={code.replace(/\s/g, '').length !== 6 || (!enabled && !uri.data)}
			onSubmit={() =>
				save.mutate(
					enabled
						? {path: 'user.disable2fa', input: {totpToken: code.replace(/\s/g, '')}, done: 'Two-factor is off', ...done}
						: {path: 'user.enable2fa', input: {totpUri: uri.data, totpToken: code.replace(/\s/g, '')}, done: 'Two-factor is on', ...done},
					{onSuccess: () => {
						clearTotpSetupQuery(qc, 'success')
						onClose()
					}},
				)
			}
		>
			{!enabled && (
				<Card style={{borderRadius: 18, marginBottom: 16}}>
					<p className="prose" style={{margin: '0 0 12px'}}>
						1. Add your server to an authenticator app (Google Authenticator, 1Password, Authy…).
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
				</Card>
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

function HostnameSheet({open, current, onClose}: {open: boolean; current: string; onClose: () => void}) {
	const save = useSave()
	const [name, setName] = useState(current)
	useEffect(() => setName(current), [current, open])
	const valid = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name.trim().toLowerCase())
	return (
		<FormSheet
			open={open}
			title="Device name"
			subtitle="How your server appears on your network"
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
				hint={valid ? `Reachable at http://${name.trim().toLowerCase()}.local` : undefined}
				error={!valid ? 'Letters, numbers and dashes only.' : undefined}
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
								if (await confirm({title: 'Turn off Wi-Fi?', body: 'If Wi-Fi is how your server connects, you’ll lose access until it’s wired in.', confirm: 'Disconnect', danger: true}))
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
	const [type, setType] = useState<'server' | 'system'>('server')
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
					{id: 'server', label: 'Omarchy Server'},
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
			subtitle="Erases Omarchy Server’s apps, machines and accounts"
			onClose={onClose}
			submit="Reset Omarchy Server"
			danger
			busy={save.isPending}
			disabled={!password || typed !== 'RESET'}
			onSubmit={() => save.mutate({path: 'system.factoryReset', input: {password}, done: 'Your server is resetting'}, {onSuccess: onDone})}
		>
			<div className="error" style={{marginBottom: 16}}>
				<Icon name="alert" size={18} />
				Every app and its data, every machine and its disks, and all Omarchy Server accounts and settings are permanently deleted, and Omarchy Server goes back to its first-time setup. This can’t be undone. Your own files, storage pools and the Omarchy desktop are left as they are.
			</div>
			<Field id="reset-pw" label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
			<Field id="reset-type" label="Type RESET to confirm" autoCapitalize="characters" autoCorrect="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
		</FormSheet>
	)
}

// Release notes: **bold** headings, "- " bullets, and an indented command line.
function UpdateNotes({text}: {text: string}) {
	return (
		<div className="update-notes" style={{marginTop: 10, fontSize: 13.5, lineHeight: 1.45}}>
			{text.split('\n').map((line, i) => {
				const bold = /^\*\*(.+?)\*\*(.*)$/.exec(line)
				if (bold)
					return (
						<p key={i} style={{margin: '10px 0 4px'}}>
							<b>{bold[1]}</b>
							{bold[2]}
						</p>
					)
				if (line.startsWith('- '))
					return (
						<p key={i} style={{margin: '2px 0 2px 12px', textIndent: -10}}>
							• {line.slice(2)}
						</p>
					)
				if (/^\s{4}/.test(line))
					return (
						<code key={i} className="mono" style={{display: 'block', fontSize: 12, userSelect: 'all', margin: '4px 0', wordBreak: 'break-all'}}>
							{line.trim()}
						</code>
					)
				return line ? <p key={i}>{line}</p> : null
			})}
		</div>
	)
}

type Security = {exists: boolean; restricted: boolean; alwaysHttps: boolean; lockAfterRemote: boolean}

// Security settings: each one is off-by-default or keeps today's behaviour, so nothing changes until
// the owner chooses it.
function SecurityGroup() {
	const sec = useQ<Security>('system.security')
	const save = useSave()
	const confirm = useConfirm()
	const set = (input: Partial<Security>, done: string) => save.mutate({path: 'system.setSecurity', input, done, refresh: ['system.security']})
	const replace = async () => {
		const ok = await confirm({
			title: 'Replace the certificate?',
			body: 'Omarchy Server makes a new certificate that browsers only accept for your home network (local names and private addresses), never for a real website. Every device that trusted the old one needs the new one: download it again from “Trust this server on this device” and trust it as before. Until then those devices show a warning on https:// pages.',
			confirm: 'Replace',
		})
		if (ok) save.mutate({path: 'system.replaceCertificate', done: 'New certificate made. Trust it again on your devices.', refresh: ['system.security']})
	}
	const s = sec.data
	return (
		<Group
			title="Security"
			footer={
				<>
					“Always use the secure address” sends a browser that opens a page over http:// to https:// (here and in your apps). App clients and phone apps that talk to an app directly are not
					redirected. Turn it on once your devices trust the certificate. “Lock after viewing remotely” locks the server’s own screen again a minute after the last remote viewer
					leaves, when you signed in to it from here.
				</>
			}
		>
			<Row
				icon="shield"
				color="var(--green)"
				label="Certificate"
				value={!s ? '' : !s.exists ? 'Not made yet' : s.restricted ? 'Home network only' : 'Older, unrestricted'}
				trailing={
					s?.exists && !s.restricted ? (
						<button className="btn get" onClick={replace} disabled={save.isPending}>
							Replace
						</button>
					) : undefined
				}
			/>
			<Row icon="key" color="var(--blue)" label="Always use the secure address" trailing={<Switch on={!!s?.alwaysHttps} disabled={!s} label="Always use the secure address" onChange={(v) => set({alwaysHttps: v}, v ? 'Pages now open over https://' : 'http:// pages allowed again')} />} />
			<Row icon="clock" color="var(--peach)" label="Lock after viewing remotely" trailing={<Switch on={s?.lockAfterRemote !== false} disabled={!s} label="Lock after viewing remotely" onChange={(v) => set({lockAfterRemote: v}, v ? 'The screen locks after remote viewing' : 'The screen stays signed in')} />} />
		</Group>
	)
}
