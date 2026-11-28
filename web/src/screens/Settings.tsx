// Full settings, backed by the same omarchyd calls My Own Data Center uses.
import {useContext, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query, type ActiveSession, type AssistantApi, type AssistantCheck, type AssistantEffort, type AssistantKey, type AssistantModel, type AssistantProvider, type AssistantVerify} from '../api'
import {patchDeskConfig} from '../desktop/config'
import {useBootstrap, useUser} from '../data'
import {checkLiveText} from '../focus'
import {isOwner} from '../isOwner'
import {Icon, type IconName} from '../icons'
import {Card, Field, Group, InWindow, Row, Segmented, Sheet, SheetHeader, Switch, VersionTag, haptic, initials, scrollPhoneToTop, useConfirm, useToast, type Prefs} from '../ui'
import {agoText} from '../plural'
import {Personalize} from '../desktop/Personalize'
import {AssistantAppearanceSettings} from '../character/widgets'
import {StoragePage} from './Storage'
import {OmarchyThemes} from '../OmarchyThemes'
import {UnraidPage} from '../unraid'
import {OidcSheet} from './Oidc'
import {ConnectPage, connectSummary, useConnectStatus} from './Connect'
import {WhatsNewSheet, allReleases} from '../WhatsNew'
import {clearTotpSetupQuery} from './twoFactorQuery'
import {MIN_PASSWORD_LENGTH, PASSWORD_SHEET_SUBTITLE, browserName, updateFinished, updateStartFailure} from './settingsHelpers'
import {safeSession} from '../safeStorage'


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

const ago = (t: number) => agoText((Date.now() - t) / 1000)
function describeSession(s: ActiveSession) {
	if (s.client.type === 'native') {
		const name = s.client.id === 'omarchy-server' || !s.client.id ? 'MODC' : s.client.id
		return {icon: 'phone' as IconName, name, detail: [s.client.platform, s.client.appVersion && `v${s.client.appVersion}`].filter(Boolean).join(' · ')}
	}
	const ua = s.client.userAgent ?? ''
	const browser = browserName(ua)
	const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
	return {icon: 'browser' as IconName, name: `${browser}${os ? ` on ${os}` : ''}`, detail: ''}
}

type SheetId = null | 'name' | 'password' | '2fa' | 'oidc'

export function Settings({
	prefs,
	setPrefs,
	onBack,
	onSignedOut,
	onOpenAppearance,
}: {
	prefs: Prefs
	setPrefs: (p: Prefs) => void
	onBack: () => void
	onSignedOut: () => void
	/** Desktop: open Appearance in its own window instead of nesting it in Settings. */
	onOpenAppearance?: () => void
}) {
	const boot = useBootstrap()
	const user = useUser()
	const confirm = useConfirm()
	const save = useSave()
	const [sheet, setSheet] = useState<SheetId>(null)
	const inWindow = useContext(InWindow)
	type Page = 'main' | 'appearance' | 'storage' | 'unraid' | 'omarchy-themes' | 'assistant' | 'connect'
	const [page, setPage] = useState<Page>(() => {
		const saved = safeSession.get('omarchy-server:settings-page')
		return saved === 'appearance' || saved === 'storage' || saved === 'unraid' || saved === 'omarchy-themes' || saved === 'assistant' || saved === 'connect' ? saved : 'main'
	})
	const openPage = (p: Page) => {
		haptic(5)
		if (p === 'main') safeSession.remove('omarchy-server:settings-page')
		else safeSession.set('omarchy-server:settings-page', p)
		setPage(p)
		scrollPhoneToTop()
	}
	const close = () => setSheet(null)
	const owner = isOwner(user.data)

	const twoFactor = useQ<boolean>('user.is2faEnabled')
	const oidc = useQ<{clientCount: number}>('oidc.status', undefined, {enabled: owner})
	const connect = useConnectStatus(owner && page === 'main')
	// Starts after a restart or power cut with nobody signed in (headless servers).
	const bootStart = useQ<{startsAtBoot: boolean | null; diskLock?: {encrypted: boolean; unlocksItself: boolean} | null}>('system.bootStart', undefined, {enabled: owner})
	const diskWaits = !!bootStart.data?.diskLock?.encrypted && !bootStart.data.diskLock.unlocksItself
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
	const startUpdate = async () => {
		const ok = await confirm({
			title: `Update to ${check.data?.name ?? check.data?.version}?`,
			body: 'The update downloads, then this server restarts. Your apps and machines stop briefly. Keep the server powered on.',
			confirm: 'Update now',
			icon: 'update',
		})
		if (!ok) return
		setUpdateError(null)
		setUpdating(true)
		mutate('system.update').catch((e) => {
			// A dropped connection is fine (progress comes from updateStatus); a refusal from the server is not.
			const failure = updateStartFailure(e)
			if (failure === null) return
			setUpdateError(failure)
			setUpdating(false)
		})
	}
	useEffect(() => {
		if (status.data?.error) {
			setUpdateError(typeof status.data.error === 'string' ? status.data.error : 'The update failed')
			setUpdating(false)
		}
	}, [status.data?.error])
	// The panel promises "this page reloads by itself": once the server has restarted and says the update is done,
	// load the new build. `sawRunning` keeps an "Updated to X" left by an earlier update from reloading at once.
	const sawRunning = useRef(false)
	useEffect(() => {
		if (!updating) {
			sawRunning.current = false
			return
		}
		if (status.data?.running) sawRunning.current = true
		else if (updateFinished(sawRunning.current, status.data)) location.reload()
	}, [updating, status.data])

	const revoke = async (s: ActiveSession) => {
		const d = describeSession(s)
		if (!(await confirm({title: `Sign out ${d.name}?`, body: 'That device will need your password to get back in.', confirm: 'Sign out'}))) return
		save.mutate({path: 'user.revokeSession', input: {sessionId: s.id}, done: `${d.name} signed out`, refresh: ['user.listSessions']})
	}
	const revokeOthers = async () => {
		if (!(await confirm({title: 'Sign out all other devices?', body: 'Every browser and app signed in to your server, except this device, is signed out.', confirm: 'Sign out others', danger: true})))
			return
		save.mutate({path: 'user.revokeOtherSessions', done: 'Other devices signed out', refresh: ['user.listSessions']})
	}
	if (page === 'unraid' && owner) return <UnraidPage onBack={() => openPage('main')} />
	if (page === 'connect' && owner) return <ConnectPage onBack={() => openPage('main')} />
	if (page === 'assistant') return <AssistantPage onBack={() => openPage('main')} />
	// Drives, pools, drive health and sleep on the host server (also under Machines › the server).
	if (page === 'storage' && owner) return <StoragePage onBack={() => openPage('main')} target="host" />
	if (page === 'omarchy-themes')
		return (
			<div className="stagger">
				<div className="page-head" style={{margin: '6px 0 14px'}}>
					<button className="round-btn" aria-label="Back" onClick={() => openPage('appearance')}>
						<Icon name="back" size={20} />
					</button>
					<h1 className="title">Themes</h1>
				</div>
				<OmarchyThemes
					owner={owner}
					onSwitched={() => {
						setPrefs({...prefs, theme: 'omarchy', pictureTheme: 'omarchy', solidColor: null})
						patchDeskConfig({preset: null, wallpaper: 'omarchy'})
					}}
				/>
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
				<Personalize embedded prefs={prefs} setPrefs={setPrefs} onOpenThemes={() => openPage('omarchy-themes')} />
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
					{owner && <Row icon="link" color="var(--blue)" label="Sign-in for apps" value={oidc.data ? `${oidc.data.clientCount} ${oidc.data.clientCount === 1 ? 'app' : 'apps'}` : ''} onClick={() => setSheet('oidc')} />}
				</div>
			</div>

			<div>
				<div className="section-head" style={{marginTop: 18}} />
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					<Row
						icon="palette"
						color="var(--pink, #ec4899)"
						label="Appearance"
						onClick={() => {
							// Desktop: open Appearance as its own window so Settings stays and the gear can refocus it.
							if (onOpenAppearance) {
								onOpenAppearance()
								return
							}
							openPage('appearance')
						}}
					/>
					<Row icon="info" color="var(--blue)" label="Restore tutorials" sub="Show the notes you have dismissed" onClick={() => setPrefs({...prefs, dismissedTutorials: []})} />
					{owner && <Row icon="disk" color="var(--teal)" label="Storage" sub="Drives, pools, drive health and sleep" onClick={() => openPage('storage')} />}
					{owner && <Row icon="move" color="var(--orange, #f59e0b)" label="Move from Unraid" onClick={() => openPage('unraid')} />}
					{owner && <Row icon="link" color="var(--accent)" label="MODC Connect" sub="Link this server to myowndatacenter.com" value={connectSummary(connect.data)} onClick={() => openPage('connect')} />}
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
								<span>{s.current ? 'This device' : `Active ${ago(s.lastSeenAt)}`}{d.detail ? ` · ${d.detail}` : ''}</span>
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
					<Row icon="server" color="var(--blue)" label="MODC" value={<VersionTag version={boot.server?.version} info={boot.server} />} />
					{diskWaits && (
						<div className="row static update-error" role="alert">
							<span className="row-ico" style={{'--c': 'var(--orange, var(--peach))'} as CSSProperties}>
								<Icon name="key" size={19} />
							</span>
							<span className="main">
								<b style={{fontWeight: 600}}>Waits for the disk password after a restart</b>
								<span>
									This computer’s disk is encrypted. After a restart or power cut it stops at the disk password screen, before this server or remote access can start, so someone has to type it at the computer. To have it start by itself, set the disk to unlock with the computer’s TPM chip (it then unlocks only on this computer, as long as its startup isn’t changed).
								</span>
							</span>
						</div>
					)}
					{bootStart.data?.startsAtBoot === false ? (
						<div className="row static update-error" role="alert">
							<span className="row-ico" style={{'--c': 'var(--orange, var(--peach))'} as CSSProperties}>
								<Icon name="power" size={19} />
							</span>
							<span className="main">
								<b style={{fontWeight: 600}}>Doesn’t start after a restart</b>
								<span>After a restart or power cut, this server stays off until someone signs in on it. Turn this on for a server with no screen.</span>
							</span>
							<button
								className="btn small"
								disabled={save.isPending}
								onClick={() => save.mutate({path: 'system.enableBootStart', done: 'This server now starts after a restart', refresh: ['system.bootStart']})}
							>
								Turn on
							</button>
						</div>
					) : bootStart.data?.startsAtBoot === true ? (
						<Row icon="power" color="var(--green)" label="Starts after a restart" value="On" />
					) : null}
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
							<span className="muted" style={{fontSize: 12.5}}>This server restarts when this finishes, and this page reloads by itself.</span>
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

			<Group
				title="Secure connection"
				footer={
					<>
						Apps such as Brave (HTTPS), Vaultwarden and Actual only work on https:// pages. This server answers https:// on the same address with its own
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

			<p className="footer-note">
				<VersionTag prefix="MODC " version={boot.touch.version} info={boot.server} />
			</p>

			<NameSheet open={sheet === 'name'} current={user.data?.name ?? ''} onClose={close} />
			<PasswordSheet open={sheet === 'password'} onClose={close} />
			<TwoFactorSheet open={sheet === '2fa'} enabled={!!twoFactor.data} onClose={close} />
			{sheet === 'oidc' && <OidcSheet onClose={close} />}
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
	hermes: 'Hermes Agent',
}

const MODEL_PLACEHOLDER: Record<AssistantProvider, string> = {
	spacexai: 'grok-4.7',
	openai: 'gpt-5.5',
	anthropic: 'claude-sonnet-5-5',
	'openai-compatible': 'llama3.2',
	chatgpt: 'gpt-5.5',
	hermes: 'hermes-agent',
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

type HermesStatus = {
	found: boolean
	where?: 'local' | 'remote'
	home: string | null
	cli: boolean
	apiServer: {enabled: boolean; port: number | null; local: boolean; reachable: boolean; baseUrl?: string | null}
	connected: boolean
	mode: 'full' | 'read'
	engine: 'builtin' | 'hermes'
	model: string | null
}

// Which assistant answers in chat: the built-in one, or Hermes Agent if it's already set up on this
// server. Connecting imports that Hermes (its API server, plus this server as tools it can use).
function AssistantEngine({owner}: {owner: boolean}) {
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const st = useQ<HermesStatus>('hermes.status', undefined, {enabled: owner})
	const [busy, setBusy] = useState(false)
	const [remoteForm, setRemoteForm] = useState(false)
	const [setup, setSetup] = useState(false)
	if (!owner || !st.data) return null
	const h = st.data
	const refresh = () => {
		qc.invalidateQueries({queryKey: ['hermes.status']})
		qc.invalidateQueries({queryKey: ['assistant.keys']})
	}
	const run = async (path: string, input: unknown, done: string) => {
		setBusy(true)
		try {
			const r = await mutate<HermesStatus & {needsRestart?: boolean}>(path, input)
			toast(r?.needsRestart ? `${done}. Start Hermes’ gateway (hermes gateway) so it picks up the change.` : done)
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(false)
			refresh()
		}
	}
	const remote = h.where === 'remote'
	const pick = async (engine: 'builtin' | 'hermes') => {
		haptic(6)
		if (engine === 'hermes' && !h.connected) return h.found && !remote ? run('hermes.connect', {}, 'Hermes connected') : setRemoteForm(true)
		return run('assistant.setEngine', {engine}, engine === 'hermes' ? 'Chats now go to Hermes' : 'Chats now go to the built-in assistant')
	}
	const disconnect = async () => {
		const ok = await confirm({title: 'Disconnect Hermes?', body: 'Hermes stops being able to use this server, and chats go back to the built-in assistant. Hermes itself and its settings stay.', confirm: 'Disconnect', danger: true})
		if (ok) run('hermes.disconnect', {}, 'Hermes disconnected')
	}
	return (
		<>
			{(
				<Group
					title="Hermes"
					footer={
						h.connected
							? h.mode === 'read'
								? 'Hermes can look at this server (apps, files, machines, storage, backups) but can’t change anything.'
								: 'Hermes can look after this server from anywhere it runs: here, Telegram, Discord or its CLI. Changes run as you.'
							: h.found
								? `Found on this server at ${h.home}. Connecting turns on Hermes’ API server on this machine only and adds this server to its tools. A copy of each Hermes file is kept first.`
								: 'No Hermes on this server. If it runs on another computer or in the cloud, connect it by its address.'
					}
				>
					{!h.connected ? (
						<>
							{h.found && <Row icon="sparkle" color="var(--mauve)" label={busy ? 'Connecting…' : 'Connect Hermes on this server'} sub="Import it and use it as the assistant" disabled={busy} onClick={() => pick('hermes')} />}
							<Row icon="server" color="var(--blue)" label="Hermes on another computer or in the cloud" sub="Connect by its address and API key" disabled={busy} onClick={() => setRemoteForm(true)} />
						</>
					) : (
						<>
							<Row
								icon="sparkle"
								color="var(--mauve)"
								label="Hermes Agent"
								value={h.apiServer.reachable ? (h.model ?? 'Connected') : 'Not running'}
								sub={h.apiServer.reachable ? (remote ? h.apiServer.baseUrl ?? undefined : undefined) : remote ? `Can’t reach Hermes at ${h.apiServer.baseUrl}` : 'Start Hermes’ gateway on this server: hermes gateway'}
							/>
							{remote && <Row icon="settings" color="var(--blue)" label="Let Hermes use this server" sub="What to add on the Hermes machine" onClick={() => setSetup(true)} />}
							<div className="row static">
								<Segmented<'full' | 'read'>
									label="What Hermes can do"
									value={h.mode}
									options={[
										{id: 'full', label: 'Full control'},
										{id: 'read', label: 'Read only'},
									]}
									onChange={(mode) => !busy && run('hermes.setMode', {mode}, mode === 'read' ? 'Hermes is now read only' : 'Hermes can now make changes')}
								/>
							</div>
							<Row icon="signout" color="var(--red)" label="Disconnect Hermes" disabled={busy} onClick={disconnect} />
						</>
					)}
				</Group>
			)}
			{remoteForm && <HermesRemoteForm onClose={() => setRemoteForm(false)} onDone={() => (setRemoteForm(false), refresh(), setSetup(true))} />}
			{setup && <HermesSetup onClose={() => setSetup(false)} />}
		</>
	)
}

function HermesRemoteForm({onClose, onDone}: {onClose: () => void; onDone: () => void}) {
	const toast = useToast()
	const [baseUrl, setBaseUrl] = useState('')
	const [apiKey, setApiKey] = useState('')
	const [busy, setBusy] = useState(false)
	return (
		<FormSheet
			open
			title="Connect Hermes"
			subtitle="Hermes on another computer or in the cloud"
			onClose={onClose}
			submit="Connect"
			busy={busy}
			disabled={!baseUrl.trim() || apiKey.trim().length < 8}
			onSubmit={async () => {
				setBusy(true)
				try {
					await mutate('hermes.connectRemote', {baseUrl: baseUrl.trim(), apiKey: apiKey.trim()})
					toast('Hermes connected')
					onDone()
				} catch (e) {
					toast((e as Error).message, true)
				} finally {
					setBusy(false)
				}
			}}
		>
			<Field
				id="hermes-url"
				label="Hermes address"
				value={baseUrl}
				onChange={(e) => setBaseUrl(e.target.value)}
				placeholder="http://192.168.1.50:8642"
				hint="Its API server must listen on the network: API_SERVER_HOST=0.0.0.0 (port 8642 unless changed) in that machine’s ~/.hermes/.env."
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				autoFocus
			/>
			<Field id="hermes-key" label="API key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} hint="API_SERVER_KEY from that machine’s ~/.hermes/.env" autoComplete="off" />
		</FormSheet>
	)
}

// What to add on the Hermes machine so it can use this server: the address it should reach this
// server at, and the token. The address is the one this page is open at (a cloud Hermes needs one it
// can reach, such as a Tailscale address).
function HermesSetup({onClose}: {onClose: () => void}) {
	const toast = useToast()
	const qc = useQueryClient()
	const boot = useBootstrap()
	const info = useQ<{token: string; path: string; name: string}>('hermes.remoteSetup')
	const loopback = /^(localhost|127\.|\[::1\])/.test(location.hostname)
	const origin = loopback && boot.server?.host ? `${location.protocol}//${boot.server.host}${location.port ? `:${location.port}` : ''}` : location.origin
	const t = info.data
	const yaml = t ? `mcp_servers:\n  ${t.name}:\n    url: "${origin}${t.path}"\n    headers:\n      Authorization: "Bearer \${MODC_MCP_TOKEN}"\n    timeout: 120` : ''
	const envLine = t ? `MODC_MCP_TOKEN=${t.token}` : ''
	const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => toast('Select and copy it from the box', true))
	return (
		<Sheet open onClose={onClose} label="Let Hermes use this server">
			<SheetHeader title="Let Hermes use this server" subtitle="Add these on the computer Hermes runs on, then restart its gateway" onClose={onClose} />
			<div className="hermes-setup">
				{!t ? (
					<span className="spinner" />
				) : (
					<>
						<p className="footer-note">1. In ~/.hermes/config.yaml (merge into mcp_servers if it’s already there):</p>
						<pre className="hermes-snippet">{yaml}</pre>
						<button className="btn small" onClick={() => copy(yaml, 'Config')}>
							Copy config
						</button>
						<p className="footer-note">2. In ~/.hermes/.env (keep it private: it lets Hermes use this server):</p>
						<pre className="hermes-snippet">{envLine}</pre>
						<button className="btn small" onClick={() => copy(envLine, 'Token')}>
							Copy token line
						</button>
						<p className="footer-note">3. Restart Hermes’ gateway (or run /reload-mcp in a Hermes chat).</p>
						<p className="footer-note">
							Hermes must be able to reach {origin}. On your network that works as is. For a Hermes in the cloud, use an address it can reach, such as this server’s Tailscale address, and open this page from that address before copying.
						</p>
						<button
							className="btn small"
							onClick={async () => {
								try {
									await mutate('hermes.rotateToken')
									qc.invalidateQueries({queryKey: ['hermes.remoteSetup']})
									toast('New token made. Update it on the Hermes machine.')
								} catch (e) {
									toast((e as Error).message, true)
								}
							}}
						>
							Make a new token
						</button>
					</>
				)}
			</div>
		</Sheet>
	)
}

type AddChoice = 'pick' | 'spacexai' | 'openai' | 'anthropic' | 'local' | 'custom'

function providerLine(k: AssistantKey): string {
	const service = PROVIDER_LABEL[k.provider] ?? k.provider
	if (k.provider === 'chatgpt') {
		if (k.signedIn === false) return `${service} · Signed out`
		const bits = [k.account, k.model].filter(Boolean)
		return bits.length ? `${service} · ${bits.join(' · ')}` : service
	}
	return [service, k.model, k.last4 ? `…${k.last4}` : ''].filter(Boolean).join(' · ')
}

function ProviderEase({open, children}: {open: boolean; children: ReactNode}) {
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		ref.current?.toggleAttribute('inert', !open)
	}, [open])
	return (
		<div ref={ref} className={open ? 'mm-ease is-open' : 'mm-ease'}>
			<div className="mm-ease-in">{children}</div>
		</div>
	)
}

function AssistantPage({onBack}: {onBack: () => void}) {
	const user = useUser()
	const confirm = useConfirm()
	const save = useSave()
	const owner = isOwner(user.data)
	const keys = useQ<AssistantKey[]>('assistant.keys')
	const [add, setAdd] = useState<AddChoice | null>(null)
	const [edit, setEdit] = useState<AssistantKey | null>(null)
	const [signIn, setSignIn] = useState<{keyId?: string} | null>(null)
	const [modelFor, setModelFor] = useState<AssistantKey | null>(null)
	const [checking, setChecking] = useState<string | null>(null)
	const [hermesOpen, setHermesOpen] = useState(false)
	const [openId, setOpenId] = useState<string | null>(null)
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
			body: chat ? 'The assistant stops using your ChatGPT plan, and access to it is revoked.' : 'The assistant won’t use this key.',
			confirm: chat ? 'Sign out' : 'Delete',
			danger: true,
			icon: 'trash',
		})
		if (ok) save.mutate({path: 'assistant.removeKey', input: {id: k.id}, done: `${k.name} deleted`, refresh: ['assistant.keys']})
	}
	const mine = list.filter((k) => !k.offered)
	const offer = list.find((k) => k.offered)
	const offerable = (k: AssistantKey) => k.provider !== 'chatgpt' && k.provider !== 'hermes'
	const move = (index: number, dir: -1 | 1) => {
		const ids = mine.map((k) => k.id)
		const next = index + dir
		if (next < 0 || next >= ids.length || save.isPending) return
		const order = [...ids]
		const [row] = order.splice(index, 1)
		order.splice(next, 0, row)
		save.mutate({path: 'assistant.reorderKeys', input: {ids: order}, done: 'Order saved', refresh: ['assistant.keys']})
	}
	const pickAdd = (id: string) => {
		haptic(6)
		if (id === 'chatgpt') {
			setAdd(null)
			setSignIn({})
			return
		}
		if (id === 'hermes') {
			setAdd(null)
			setHermesOpen(true)
			return
		}
		setAdd(id as AddChoice)
	}
	const choices = [
		{id: 'chatgpt', label: 'ChatGPT', sub: 'Your Plus or Pro plan. No API key.'},
		{id: 'spacexai', label: 'Grok', sub: 'A SpaceXAI API key.'},
		{id: 'openai', label: 'OpenAI', sub: 'An OpenAI API key, separate from a ChatGPT plan.'},
		{id: 'anthropic', label: 'Anthropic', sub: 'An Anthropic API key.'},
		{id: 'local', label: 'On this server', sub: 'A model on this server, such as Ollama. No key.'},
		...(owner ? [{id: 'custom', label: 'Another address', sub: 'Any OpenAI-compatible address.'}, {id: 'hermes', label: 'Hermes', sub: 'Hermes Agent, on this server or somewhere else.'}] : []),
	]
	return (
		<div className="stagger">
			<div className="page-head" style={{margin: '6px 0 14px'}}>
				<button className="round-btn" aria-label="Back" onClick={onBack}>
					<Icon name="back" size={20} />
				</button>
				<h1 className="title" style={{flex: 1}}>
					Assistant
				</h1>
				<button className="btn small" style={{minHeight: 44}} onClick={() => (haptic(6), setAdd('pick'))}>
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
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{(keys.error as Error).message}
				</div>
			)}
			{keys.isSuccess && (
				<section>
					<div className="section-head">
						<h2>My providers</h2>
					</div>
					<div className="mm-list screen-list glass">
						{mine.map((k, index) => {
							const open = openId === k.id
							const canCheck = k.provider !== 'chatgpt' && k.provider !== 'hermes'
							const toggle = () => (haptic(6), setOpenId(open ? null : k.id))
							return (
								<article key={k.id} className={open ? 'mm-row is-open' : 'mm-row'}>
									<div className="ap-line">
										{owner && offerable(k) && (
											<button
												type="button"
												className="icon-btn"
												role="radio"
												aria-checked={!!k.systemDefault}
												aria-label={`Offer ${k.name} to everyone else`}
												onClick={() => {
													if (k.systemDefault || save.isPending) return
													haptic(6)
													save.mutate({path: 'assistant.updateKey', input: {id: k.id, systemDefault: true}, done: 'Offered to everyone else', refresh: ['assistant.keys']})
												}}
											>
												<Icon name={k.systemDefault ? 'checked' : 'unchecked'} size={22} />
											</button>
										)}
										<button type="button" className="ap-open" aria-expanded={open} onClick={toggle}>
											<b>{k.name}</b>
											<span>{providerLine(k)}</span>
										</button>
										{canCheck && (
											<button
												type="button"
												className="icon-btn"
												aria-label={checking === k.id ? `Checking ${k.name}` : `Check connection for ${k.name}`}
												disabled={!!checking}
												style={{color: k.check?.ok ? 'var(--green)' : k.check && !k.check.ok ? 'var(--red)' : undefined}}
												onClick={() => checking || check(k)}
											>
												{checking === k.id ? <span className="spinner" /> : <Icon name={k.check && !k.check.ok ? 'alert' : 'check'} size={18} />}
											</button>
										)}
										<button type="button" className="icon-btn clip-delete" aria-label={k.provider === 'chatgpt' ? `Sign out of ${k.name}` : `Delete ${k.name}`} onClick={() => remove(k)}>
											<Icon name={k.provider === 'chatgpt' ? 'signout' : 'trash'} size={18} />
										</button>
										<button type="button" className="icon-btn" aria-expanded={open} aria-label={open ? `Close ${k.name}` : `Open ${k.name}`} onClick={toggle}>
											<Icon name={open ? 'chevron-down' : 'chevron'} size={18} className="mm-chev" />
										</button>
									</div>
									<ProviderEase open={open}>
										<div className="mm-panel">
											<div className="ap-order">
												<button type="button" className="btn" disabled={index === 0 || save.isPending} aria-label={`Move ${k.name} up`} onClick={() => move(index, -1)}>
													Up
												</button>
												<button type="button" className="btn" disabled={index === mine.length - 1 || save.isPending} aria-label={`Move ${k.name} down`} onClick={() => move(index, 1)}>
													Down
												</button>
											</div>
											{k.provider === 'hermes' && <p className="footer-note" style={{textAlign: 'left', margin: 0}}>Hermes answers only when it is first. It is not a backup. Providers under it wait until it is moved down.</p>}
											{canCheck && <CheckLine check={k.check ?? null} busy={checking === k.id} />}
											{k.provider === 'chatgpt' && k.signedIn === false && <Row icon="alert" color="var(--red)" label="Signed out of ChatGPT" sub="Sign in again to keep using your plan" onClick={() => setSignIn({keyId: k.id})} />}
											{k.provider === 'chatgpt' && k.signedIn !== false && <Row icon="sparkle" color="var(--accent)" label="Model" value={k.model || 'Choose'} onClick={() => setModelFor(k)} />}
											{k.provider === 'hermes' && <Row icon="sparkle" color="var(--mauve)" label="Hermes setup" sub="Connect, what it can change, or disconnect" onClick={() => setHermesOpen(true)} />}
											{k.provider !== 'chatgpt' && k.provider !== 'hermes' && <Row icon="pencil" color="var(--accent)" label="Edit" value="Name, key, model" onClick={() => setEdit(k)} />}
											{owner && offerable(k) && <p className="footer-note" style={{textAlign: 'left', margin: 0}}>Their questions go to this provider when their own do not answer.</p>}
											{(k.provider === 'chatgpt' || k.provider === 'hermes') && owner && <p className="footer-note" style={{textAlign: 'left', margin: 0}}>{k.provider === 'hermes' ? 'Hermes acts with your rights, so it can’t be offered.' : 'A ChatGPT plan stays with you, so it can’t be offered.'}</p>}
										</div>
									</ProviderEase>
								</article>
							)
						})}
						<article className="mm-row">
							<div className="ap-line">
								{owner ? (
									<>
										<button
											type="button"
											className="icon-btn"
											role="radio"
											aria-checked={!mine.some((k) => k.systemDefault)}
											aria-label="If none of these answer, stop"
											onClick={() => {
												if (!mine.some((k) => k.systemDefault) || save.isPending) return
												save.mutate({path: 'assistant.clearDefault', input: {}, done: 'Nothing is offered to everyone else', refresh: ['assistant.keys']})
											}}
										>
											<Icon name={mine.some((k) => k.systemDefault) ? 'unchecked' : 'checked'} size={22} />
										</button>
										<button
											type="button"
											className="ap-open"
											onClick={() => {
												if (!mine.some((k) => k.systemDefault) || save.isPending) return
												save.mutate({path: 'assistant.clearDefault', input: {}, done: 'Nothing is offered to everyone else', refresh: ['assistant.keys']})
											}}
										>
											<b>If none of these answer, stop.</b>
											<span>This row stays at the bottom. Other people are offered nothing while it is selected.</span>
										</button>
									</>
								) : offer && !offer.declined ? (
									<>
										<div className="ap-label">
											<b>Server default</b>
											<span>
												{PROVIDER_LABEL[offer.provider] ?? offer.provider}
												{offer.model ? ` · ${offer.model}` : ''}. When your providers do not answer, your question goes to this one.
											</span>
										</div>
										<button type="button" className="btn" onClick={() => save.mutate({path: 'assistant.useServerDefault', input: {use: false}, done: 'The server default will not be used', refresh: ['assistant.keys']})}>
											Don’t use this
										</button>
									</>
								) : (
									<>
										<div className="ap-label">
											<b>If none of these answer, stop.</b>
											<span>This row stays at the bottom.</span>
										</div>
										{offer?.declined && (
											<button type="button" className="btn" onClick={() => save.mutate({path: 'assistant.useServerDefault', input: {use: true}, done: 'The server default will be used', refresh: ['assistant.keys']})}>
												Use the server default
											</button>
										)}
									</>
								)}
							</div>
						</article>
					</div>
					<p className="footer-note" style={{textAlign: 'left'}}>
						Chat tries from the top and uses the first one that answers. Open a provider to move it. A new provider is added at the bottom.
					</p>
				</section>
			)}

			<AssistantAppearanceSettings />

			{add === 'pick' && (
				<Sheet open onClose={() => setAdd(null)} label="Add a provider">
					<SheetHeader title="Add a provider" subtitle="It is added at the bottom of your list." onClose={() => setAdd(null)} />
					<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
						{choices.map((c) => (
							<Row key={c.id} icon="sparkle" color="var(--accent)" label={c.label} sub={c.sub} onClick={() => pickAdd(c.id)} />
						))}
					</div>
				</Sheet>
			)}
			<AddKeySheet
				open={add === 'spacexai' || add === 'openai' || add === 'anthropic' || add === 'local' || add === 'custom'}
				owner={owner}
				preset={add === 'spacexai' || add === 'openai' || add === 'anthropic' || add === 'local' || add === 'custom' ? add : null}
				onClose={() => setAdd(null)}
			/>
			<EditKeySheet open={!!edit} keyRow={edit} owner={owner} onClose={() => setEdit(null)} />
			{signIn && <ChatGptSignInSheet keyId={signIn.keyId} onClose={() => setSignIn(null)} />}
			{modelFor && <ChatGptModelSheet keyRow={modelFor} onClose={() => setModelFor(null)} />}
			{hermesOpen && owner && (
				<Sheet open onClose={() => setHermesOpen(false)} label="Hermes">
					<SheetHeader title="Hermes" subtitle="Hermes answers only when its row is first." onClose={() => setHermesOpen(false)} />
					<AssistantEngine owner={owner} />
				</Sheet>
			)}
		</div>
	)
}

function AddKeySheet({open, owner, preset, onClose}: {open: boolean; owner: boolean; preset: 'spacexai' | 'openai' | 'anthropic' | 'local' | 'custom' | null; onClose: () => void}) {
	const save = useSave()
	const [provider, setProvider] = useState<AssistantProvider>('spacexai')
	const [name, setName] = useState('')
	const [model, setModel] = useState('')
	const [apiKey, setApiKey] = useState('')
	const [baseUrl, setBaseUrl] = useState('')
	useEffect(() => {
		const next: AssistantProvider = preset === 'openai' || preset === 'anthropic' || preset === 'spacexai' ? preset : preset === 'local' || preset === 'custom' ? 'openai-compatible' : 'spacexai'
		setProvider(next)
		setName('')
		setModel('')
		setApiKey('')
		setBaseUrl(preset === 'local' || preset === 'custom' ? 'http://127.0.0.1:11434/v1' : '')
	}, [open, preset])
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
			title={preset === 'local' ? 'On this server' : preset === 'custom' ? 'Another address' : preset === 'openai' ? 'Add OpenAI' : preset === 'anthropic' ? 'Add Anthropic' : 'Add Grok'}
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
			{!preset && (
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
			)}
			<Field id="ask-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
			{preset === 'custom' && (
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
			{preset !== 'local' && (
				<Field
					id="ask-key"
					label="API key"
					type="password"
					autoComplete="off"
					value={apiKey}
					onChange={(e) => setApiKey(e.target.value)}
					onBlur={() => setKeyEntered(true)}
					hint={custom ? 'Leave blank for a server that does not need a key.' : 'Checked with the provider when you move on from this field.'}
				/>
			)}
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
			if (tab) {
				// The sign-in page must not be able to reach back to this one through window.opener.
				tab.opener = null
				tab.location.href = r.url
			}
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
					<li>Open ChatGPT, sign in, and allow My Own Data Center to use your plan.</li>
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
							{busy ? <><span className="spinner" /><span className="sr-only">Finish signing in</span></> : 'Finish signing in'}
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
					Your ChatGPT sign-in stays on this server, only for you. My Own Data Center can use your plan for the assistant; it can’t see your ChatGPT chats.
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
			disabled={!oldPassword || newPassword.length < MIN_PASSWORD_LENGTH || newPassword !== repeat}
			onSubmit={() =>
				save.mutate(
					{path: 'user.changePassword', input: {oldPassword, newPassword}, done: 'Password changed'},
					{
						onSuccess: async () => {
							onClose()
							// My Own Data Center may sign every session out after a password change.
							// This fetch does not go through the client that fires touch:signed-out.
							const still = await fetch('/api/rpc/user.get', {credentials: 'same-origin'}).catch(() => null)
							if (still?.status === 401) window.dispatchEvent(new Event('touch:signed-out'))
						},
					},
				)
			}
		>
			<Field id="old" label="Current password" type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoFocus />
			<Field id="new" label="New password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} />
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
			body: 'A new certificate is made that browsers only accept for your home network (local names and private addresses), never for a real website. Every device that trusted the old one needs the new one: download it again from “Trust this server on this device” and trust it as before. Until then those devices show a warning on https:// pages.',
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
