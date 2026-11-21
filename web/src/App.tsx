import {lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {getBootstrap, query, type Bootstrap, type User, type UserApp} from './api'
import {bootstrapPollInterval, useServerReachable} from './connection'
import {AppSheet} from './AppSheet'
import {AppViewer} from './AppViewer'
import {VIEW_APP} from './openApp'
import {OPEN_TERMINAL} from './terminalEvent'
import {BootstrapContext, useAction, useApps, useNotifications, useUpdates, useUser} from './data'
import {Icon, type IconName} from './icons'
import {Apps} from './screens/Apps'
import {Connect, Login} from './screens/Auth'
import {Home} from './screens/Home'
import {Desktop} from './desktop/Desktop'
import {resetDeskConfig} from './desktop/config'
import {ScreenErrorBoundary} from './screenBoundary'
import {Backdrop, Sheet, SheetHeader, haptic, layoutAsked, scrollPhoneToTop, useLayout, usePrefs, type Prefs} from './ui'
import {WhatsNewOnUpdate} from './WhatsNew'
import {LayoutChooser} from './LayoutChooser'
import {InstallerPrompt} from './InstallerPrompt'
import {consumeReopenAssistant} from './assistant'
import {closeAssistantView, openAssistantView, resetAssistantTurn, useAssistantTurn} from './assistantTurn'
import {AssistantLookContext, cleanLook, DEFAULT_LOOK, type AssistantLook} from './character/AssistantCharacter'
import {AssistantCharacterWidget} from './character/widgets'

const Clips = lazy(() => import('./screens/Clips').then((m) => ({default: m.Clips})))
const Files = lazy(() => import('./screens/Files').then((m) => ({default: m.Files})))
const Machines = lazy(() => import('./screens/Machines').then((m) => ({default: m.Machines})))
const More = lazy(() => import('./screens/More').then((m) => ({default: m.More})))
const Settings = lazy(() => import('./screens/Settings').then((m) => ({default: m.Settings})))
const Store = lazy(() => import('./screens/Store').then((m) => ({default: m.Store})))
const TerminalScreen = lazy(() => import('./Terminal').then((m) => ({default: m.TerminalScreen})))
const Assistant = lazy(() => import('./screens/Assistant').then((m) => ({default: m.Assistant})))

function ScreenFallback() {
	return (
		<main className="screen center">
			<span className="spinner" aria-label="Loading" />
		</main>
	)
}

type Tab = 'home' | 'apps' | 'files' | 'machines' | 'more' | 'settings' | 'store' | 'clips'
// `tone`: the palette colour each tab's icon takes in the themed looks (the same as on the desktop).
const TABS: {id: Tab; label: string; icon: IconName; active: IconName; tone: string}[] = [
	{id: 'home', label: 'Home', icon: 'home', active: 'home-filled', tone: 'var(--accent)'},
	{id: 'apps', label: 'Apps', icon: 'apps', active: 'apps-filled', tone: 'var(--mauve)'},
	{id: 'files', label: 'Files', icon: 'folder', active: 'folder-filled', tone: 'var(--blue)'},
	{id: 'machines', label: 'Machines', icon: 'machine', active: 'machine-filled', tone: 'var(--teal)'},
	{id: 'more', label: 'System', icon: 'activity', active: 'activity-filled', tone: 'var(--peach)'},
]
const tabFromHash = (): Tab => {
	const h = location.hash.replace('#/', '') as Tab
	return h === 'settings' || h === 'store' || h === 'clips' || TABS.some((t) => t.id === h) ? h : 'home'
}

export function App() {
	const qc = useQueryClient()
	const boot = useQuery({
		queryKey: ['bootstrap'],
		queryFn: getBootstrap,
		retry: 1,
		refetchInterval: (q) => bootstrapPollInterval(q.state),
		refetchOnWindowFocus: (q) => bootstrapPollInterval(q.state) !== false,
	})
	const signedIn = !!boot.data?.session && !!boot.data?.server?.reachable
	const user = useQuery({queryKey: ['user.get'], queryFn: () => query<User>('user.get'), enabled: signedIn, staleTime: 5 * 60_000})
	const [loginId, setLoginId] = useState<string>()
	const account = boot.data?.accounts.find((a) => a.userId === (signedIn ? boot.data?.session?.accountId : loginId)) ?? boot.data?.accounts[0]
	const wallpaper = (signedIn ? user.data?.wallpaper : null) ?? account?.wallpaper ?? null
	const [prefs, setPrefs] = usePrefs(wallpaper?.brandColorHsl, signedIn)
	// The assistant's look (character, name, motion), saved with this account's preferences.
	const look = useMemo(() => cleanLook(prefs.assistantLook ?? DEFAULT_LOOK), [prefs.assistantLook])
	const lookValue = useMemo(() => ({look, setLook: (next: AssistantLook) => setPrefs({...prefs, assistantLook: next})}), [look, prefs, setPrefs])
	const refresh = useCallback(() => qc.invalidateQueries({queryKey: ['bootstrap']}), [qc])
	const retryBootstrap = useCallback(async () => {
		const res = await boot.refetch()
		if (res.error) throw res.error
		return res.data ?? null
	}, [boot])
	const layout = useLayout()
	// The first time anyone signs in on this device: Desktop or Phone & tablet (then What's New).
	const [askLayout, setAskLayout] = useState(() => !layoutAsked())
	const reopenAssistantRef = useRef<boolean | null>(null)
	if (reopenAssistantRef.current === null) reopenAssistantRef.current = consumeReopenAssistant()
	const reopenAssistant = reopenAssistantRef.current

	useEffect(() => {
		const onOut = () => {
			resetDeskConfig()
			resetAssistantTurn()
			qc.removeQueries({predicate: (q) => q.queryKey[0] !== 'bootstrap'})
			refresh()
		}
		window.addEventListener('touch:signed-out', onOut)
		return () => window.removeEventListener('touch:signed-out', onOut)
	}, [qc, refresh])

	// The installer prompt waits for What's New, so the two don't stack.
	const [whatsNewDone, setWhatsNewDone] = useState(false)
	const b = boot.data
	let content
	if (boot.isLoading) {
		content = (
			<main className="auth center">
				<span className="spinner" style={{width: 30, height: 30, margin: '0 auto', color: 'var(--accent-text)'}} aria-label="Loading" />
			</main>
		)
	} else if (boot.error || !b) {
		content = (
			<main className="auth center screen">
				<h1>Omarchy Server is offline</h1>
				<p className="lead">The Omarchy Server server isn’t answering. Is it still running?</p>
				<button className="btn primary block" onClick={() => void boot.refetch()}>
					Try again
				</button>
			</main>
		)
	} else if (!b.configured) content = <Connect onDone={refresh} />
	else if (!b.server?.reachable) content = <Connect onDone={refresh} onRetry={retryBootstrap} unreachable={b.server} />
	else if (!b.session) content = <Login boot={b} userId={loginId} setUserId={setLoginId} onDone={refresh} />
	else
		content = (
			<BootstrapContext.Provider value={b}>
			<AssistantLookContext.Provider value={lookValue}>
				{layout.desktop ? <Desktop boot={b} prefs={prefs} setPrefs={setPrefs} onSignedOut={refresh} reopenAssistant={reopenAssistant} /> : <Shell boot={b} prefs={prefs} setPrefs={setPrefs} onSignedOut={refresh} reopenAssistant={reopenAssistant} />}
				{askLayout ? <LayoutChooser onDone={() => setAskLayout(false)} /> : <WhatsNewOnUpdate version={b.touch.version} onDone={() => setWhatsNewDone(true)} />}
				<InstallerPrompt ready={whatsNewDone} />
			</AssistantLookContext.Provider>
			</BootstrapContext.Provider>
		)

	return (
		<>
			<Backdrop wallpaper={wallpaper} prefs={prefs} />
			{content}
		</>
	)
}

function Shell({boot, prefs, setPrefs, onSignedOut, reopenAssistant}: {boot: Bootstrap; prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void; reopenAssistant?: boolean}) {
	const [tab, setTab] = useState<Tab>(tabFromHash)
	const [appId, setAppId] = useState<string | null>(null)
	// An app open inside Omarchy Server (full screen, back button returns here).
	const [viewing, setViewing] = useState<UserApp | null>(null)
	useEffect(() => {
		const onView = (e: Event) => (setAppId(null), setViewing((e as CustomEvent<UserApp>).detail))
		window.addEventListener(VIEW_APP, onView)
		return () => window.removeEventListener(VIEW_APP, onView)
	}, [])
	const [bellOpen, setBellOpen] = useState(false)
	const [terminal, setTerminal] = useState<{app?: {id: string; name?: string; icon?: string}; input?: string} | null>(null)
	const [assistantOpen, setAssistantOpen] = useState(() => !!reopenAssistant)
	const turn = useAssistantTurn()
	const keepAssistant = assistantOpen || turn.streaming
	const user = useUser()
	// omarchyd only gives the owner a shell.
	const openTerminal = user.data?.role === 'member' ? undefined : (app?: {id: string; name?: string; icon?: string}, input?: string) => {
		haptic(8)
		setAppId(null)
		setTerminal({app, input})
	}
	// "Open Terminal" buttons elsewhere (e.g. a one-time fix for network shares).
	useEffect(() => {
		const onOpen = (e: Event) => openTerminal?.(undefined, (e as CustomEvent<string>).detail)
		window.addEventListener(OPEN_TERMINAL, onOpen)
		return () => window.removeEventListener(OPEN_TERMINAL, onOpen)
	})
	const apps = useApps()
	const updates = useUpdates()
	const notifications = useNotifications()

	useEffect(() => {
		const onHash = () => setTab(tabFromHash())
		window.addEventListener('hashchange', onHash)
		return () => window.removeEventListener('hashchange', onHash)
	}, [])
	const go = (t: Tab) => {
		haptic(5)
		if (t === tab) scrollPhoneToTop('smooth')
		else {
			history.pushState(null, '', `#/${t}`)
			setTab(t)
			scrollPhoneToTop()
		}
	}

	const app = apps.data?.find((a) => a.id === appId) ?? null
	const update = updates.data?.find((u) => u.id === appId)
	const conn = useServerReachable()
	const online = conn.reachable
	const updateCount = updates.data?.length ?? 0
	const notes = notifications.data ?? []
	const index = TABS.findIndex((t) => t.id === tab)

	return (
		<>
			<div className="shell">
				<header className="topbar">
					<span className="device">
						<span className={`dot ${online ? 'live' : 'down'}`} />
						{boot.server?.device ?? 'server'}
						<span className="mono">{boot.server?.host}</span>
					</span>
					<span className="spacer-x" />
					<button
						className="round-btn"
						aria-label="Settings"
						onClick={() => go('settings')}
					>
						<Icon name="settings" size={20} />
					</button>
					<button
						className={`round-btn bell${notes.length ? ' lit' : ''}${notes.includes('update-available') ? ' ringing' : ''}`}
						aria-label={notes.length ? `${notes.length} notifications` : 'Notifications'}
						onClick={() => {
							haptic(6)
							setBellOpen(true)
						}}
					>
						<Icon name="bell" size={20} />
						{notes.length > 0 && <span className="badge-n">{notes.length}</span>}
					</button>
				</header>
				{!online && (
					<div className="error" role="alert">
						<Icon name="alert" size={18} />
						{conn.message}
					</div>
				)}
				<ScreenErrorBoundary>
				<Suspense fallback={<ScreenFallback />}>
					<main key={tab} className="screen">
						{tab === 'home' && (
							<Home
								onOpenApp={(a) => setAppId(a.id)}
								go={go}
								onTerminal={openTerminal}
								onAssistant={() => {
									haptic(8)
									setAppId(null)
									setAssistantOpen(true)
									openAssistantView()
								}}
							/>
						)}
						{tab === 'apps' && <Apps onOpenApp={(a) => setAppId(a.id)} onTerminal={openTerminal} onStore={() => go('store')} />}
						{tab === 'files' && <Files />}
						{tab === 'store' && <Store onOpenInstalled={(a) => setAppId(a.id)} onBack={() => history.back()} onTerminal={openTerminal && ((input) => openTerminal(undefined, input))} />}
						{tab === 'machines' && <Machines />}
						{tab === 'more' && <More prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} onSettings={() => go('settings')} onClips={() => go('clips')} />}
						{tab === 'clips' && <Clips onBack={() => history.back()} />}
						{tab === 'settings' && <Settings prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} onBack={() => history.back()} />}
					</main>
				</Suspense>
				</ScreenErrorBoundary>
			</div>
			<nav className="dock" aria-label="Main">
				<span className="indicator" style={{transform: `translateX(${Math.max(index, 0) * 100}%)`, opacity: index < 0 ? 0 : 1}} aria-hidden="true" />
				{TABS.map((t) => (
					<button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)} style={{'--tone': t.tone} as CSSProperties}>
						<Icon name={tab === t.id ? t.active : t.icon} size={23} stroke={tab === t.id ? 2 : 1.75} />
						{t.label}
						{t.id === 'apps' && updateCount > 0 && <span className="count">{updateCount}</span>}
					</button>
				))}
			</nav>
			<AppSheet app={app} update={update} onClose={() => setAppId(null)} onTerminal={openTerminal} />
			{viewing && <AppViewer app={viewing} onClose={() => setViewing(null)} />}

			{terminal && (
				<ScreenErrorBoundary>
				<Suspense fallback={<ScreenFallback />}>
					<TerminalScreen app={terminal.app} input={terminal.input} onClose={() => setTerminal(null)} />
				</Suspense>
				</ScreenErrorBoundary>
			)}
			{/* Not over Settings, which has its own preview of the character (and forms it would cover). */}
			{!assistantOpen && !terminal && !viewing && tab !== 'settings' && (
				<AssistantCharacterWidget
					onOpen={() => {
						setAppId(null)
						setAssistantOpen(true)
						openAssistantView()
					}}
				/>
			)}
			{keepAssistant && (
				<ScreenErrorBoundary>
				<Suspense fallback={<ScreenFallback />}>
					<Assistant
						active={assistantOpen}
						onClose={() => {
							closeAssistantView()
							setAssistantOpen(false)
						}}
						onSettings={() => {
							sessionStorage.setItem('omarchy-server:settings-page', 'assistant')
							closeAssistantView()
							setAssistantOpen(false)
							go('settings')
						}}
						prefs={prefs}
						setPrefs={setPrefs}
					/>
				</Suspense>
				</ScreenErrorBoundary>
			)}
			<NotificationsSheet
				open={bellOpen}
				notes={notes}
				onClose={() => setBellOpen(false)}
				onOpen={(n) => {
					setBellOpen(false)
					if (n === 'update-available') {
						sessionStorage.removeItem('omarchy-server:settings-page')
						go('settings')
					}
				}}
			/>
		</>
	)
}

const NOTIFICATION_TEXT: Record<string, string> = {
	'update-available': 'A new version of Omarchy Server is available',
	migration: 'Your data migration finished',
}
const noteText = (n: string) => NOTIFICATION_TEXT[n] ?? n.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function NotificationsSheet({open, notes, onClose, onOpen}: {open: boolean; notes: string[]; onClose: () => void; onOpen?: (n: string) => void}) {
	const action = useAction()
	return (
		<Sheet open={open} onClose={onClose} label="Notifications">
			<SheetHeader title="Notifications" subtitle={notes.length ? `${notes.length} from Omarchy Server` : undefined} onClose={onClose} />
			{notes.length === 0 ? (
				<div className="empty" style={{paddingTop: 20}}>
					<span className="big">
						<Icon name="check" size={30} />
					</span>
					<b>You’re all caught up</b>
				</div>
			) : (
				<div className="glass group" style={{borderRadius: 18, '--inset': '62px'} as React.CSSProperties}>
					{notes.map((n) => (
						<div key={n} className="row static">
							<span className="row-ico" style={{'--c': 'var(--yellow)', color: '#1a1300'} as React.CSSProperties}>
								<Icon name="bell" size={18} />
							</span>
							<button className="main" style={{background: 'none', border: 0, color: 'inherit', textAlign: 'left', font: 'inherit', padding: 0, cursor: 'pointer'}} onClick={() => onOpen?.(n)}>
								<b style={{fontWeight: 550, whiteSpace: 'normal'}}>{noteText(n)}</b>
								{n === 'update-available' && <span>Tap to see what’s new and update</span>}
							</button>
							<button className="icon-btn" style={{alignSelf: 'center'}} aria-label="Dismiss" onClick={() => action.mutate({path: 'notifications.clear', input: n})}>
								<Icon name="close" size={16} stroke={2.2} />
							</button>
						</div>
					))}
				</div>
			)}
		</Sheet>
	)
}
