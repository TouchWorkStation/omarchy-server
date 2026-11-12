import {useCallback, useEffect, useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {getBootstrap, query, type Bootstrap, type User} from './api'
import {AppSheet} from './AppSheet'
import {BootstrapContext, useAction, useApps, useNotifications, useUpdates, useUser} from './data'
import {Icon, type IconName} from './icons'
import {Apps} from './screens/Apps'
import {Files} from './screens/Files'
import {Connect, Login} from './screens/Auth'
import {Home} from './screens/Home'
import {Machines} from './screens/Machines'
import {More} from './screens/More'
import {Settings} from './screens/Settings'
import {Store} from './screens/Store'
import {TerminalScreen} from './Terminal'
import {Desktop} from './desktop/Desktop'
import {Backdrop, Sheet, SheetHeader, haptic, useLayout, usePrefs, type Prefs} from './ui'
import {WhatsNewOnUpdate} from './WhatsNew'

type Tab = 'home' | 'apps' | 'files' | 'machines' | 'more' | 'settings' | 'store'
const TABS: {id: Tab; label: string; icon: IconName; active: IconName}[] = [
	{id: 'home', label: 'Home', icon: 'home', active: 'home-filled'},
	{id: 'apps', label: 'Apps', icon: 'apps', active: 'apps-filled'},
	{id: 'files', label: 'Files', icon: 'folder', active: 'folder-filled'},
	{id: 'machines', label: 'Machines', icon: 'machine', active: 'machine-filled'},
	{id: 'more', label: 'System', icon: 'activity', active: 'activity-filled'},
]
const tabFromHash = (): Tab => {
	const h = location.hash.replace('#/', '') as Tab
	return h === 'settings' || h === 'store' || TABS.some((t) => t.id === h) ? h : 'home'
}

export function App() {
	const qc = useQueryClient()
	const boot = useQuery({queryKey: ['bootstrap'], queryFn: getBootstrap, retry: 1, refetchOnWindowFocus: false})
	const signedIn = !!boot.data?.session && !!boot.data?.umbrel?.reachable
	const user = useQuery({queryKey: ['user.get'], queryFn: () => query<User>('user.get'), enabled: signedIn, staleTime: 5 * 60_000})
	const [loginId, setLoginId] = useState<string>()
	const account = boot.data?.accounts.find((a) => a.userId === (signedIn ? boot.data?.session?.accountId : loginId)) ?? boot.data?.accounts[0]
	const wallpaper = (signedIn ? user.data?.wallpaper : null) ?? account?.wallpaper ?? null
	const [prefs, setPrefs] = usePrefs(wallpaper?.brandColorHsl, signedIn)
	const refresh = useCallback(() => qc.invalidateQueries({queryKey: ['bootstrap']}), [qc])
	const layout = useLayout()

	useEffect(() => {
		const onOut = () => {
			qc.removeQueries({predicate: (q) => q.queryKey[0] !== 'bootstrap'})
			refresh()
		}
		window.addEventListener('touch:signed-out', onOut)
		return () => window.removeEventListener('touch:signed-out', onOut)
	}, [qc, refresh])

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
				<h1>UmbrelOS Touch is offline</h1>
				<p className="lead">The UmbrelOS Touch server isn’t answering. Is it still running?</p>
				<button className="btn primary block" onClick={refresh}>
					Try again
				</button>
			</main>
		)
	} else if (!b.configured) content = <Connect onDone={refresh} />
	else if (!b.umbrel?.reachable) content = <Connect onDone={refresh} unreachable={b.umbrel} />
	else if (!b.session) content = <Login boot={b} userId={loginId} setUserId={setLoginId} onDone={refresh} />
	else
		content = (
			<BootstrapContext.Provider value={b}>
				{layout.desktop ? <Desktop boot={b} prefs={prefs} setPrefs={setPrefs} onSignedOut={refresh} /> : <Shell boot={b} prefs={prefs} setPrefs={setPrefs} onSignedOut={refresh} />}
				<WhatsNewOnUpdate version={b.touch.version} />
			</BootstrapContext.Provider>
		)

	return (
		<>
			<Backdrop wallpaper={wallpaper} prefs={prefs} />
			{content}
		</>
	)
}

function Shell({boot, prefs, setPrefs, onSignedOut}: {boot: Bootstrap; prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void}) {
	const [tab, setTab] = useState<Tab>(tabFromHash)
	const [appId, setAppId] = useState<string | null>(null)
	const [bellOpen, setBellOpen] = useState(false)
	const [terminal, setTerminal] = useState<{app?: {id: string; name?: string; icon?: string}} | null>(null)
	const user = useUser()
	// umbreld only gives the owner a shell.
	const openTerminal = user.data?.role === 'member' ? undefined : (app?: {id: string; name?: string; icon?: string}) => {
		haptic(8)
		setAppId(null)
		setTerminal({app})
	}
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
		if (t === tab) window.scrollTo({top: 0, behavior: 'smooth'})
		else {
			history.pushState(null, '', `#/${t}`)
			setTab(t)
			window.scrollTo({top: 0})
		}
	}

	const app = apps.data?.find((a) => a.id === appId) ?? null
	const update = updates.data?.find((u) => u.id === appId)
	const online = !apps.error
	const updateCount = updates.data?.length ?? 0
	const notes = notifications.data ?? []
	const index = TABS.findIndex((t) => t.id === tab)

	return (
		<>
			<div className="shell">
				<header className="topbar">
					<span className="device">
						<span className={`dot ${online ? 'live' : 'down'}`} />
						{boot.umbrel?.device ?? 'Umbrel'}
						<span className="mono">{boot.umbrel?.host}</span>
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
						className="round-btn"
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
						Lost contact with your Umbrel. Retrying…
					</div>
				)}
				<main key={tab} className="screen">
					{tab === 'home' && <Home onOpenApp={(a) => setAppId(a.id)} go={go} onTerminal={openTerminal} />}
					{tab === 'apps' && <Apps onOpenApp={(a) => setAppId(a.id)} onTerminal={openTerminal} onStore={() => go('store')} />}
					{tab === 'files' && <Files />}
					{tab === 'store' && <Store onOpenInstalled={(a) => setAppId(a.id)} onBack={() => history.back()} />}
					{tab === 'machines' && <Machines />}
					{tab === 'more' && <More prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} onSettings={() => go('settings')} />}
					{tab === 'settings' && <Settings prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} onBack={() => history.back()} />}
				</main>
			</div>
			<nav className="dock" aria-label="Main">
				<span className="indicator" style={{transform: `translateX(${Math.max(index, 0) * 100}%)`, opacity: index < 0 ? 0 : 1}} aria-hidden="true" />
				{TABS.map((t) => (
					<button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
						<Icon name={tab === t.id ? t.active : t.icon} size={23} stroke={tab === t.id ? 2 : 1.75} />
						{t.label}
						{t.id === 'apps' && updateCount > 0 && <span className="count">{updateCount}</span>}
					</button>
				))}
			</nav>
			<AppSheet app={app} update={update} onClose={() => setAppId(null)} onTerminal={openTerminal} />
			{terminal && <TerminalScreen app={terminal.app} onClose={() => setTerminal(null)} />}
			<NotificationsSheet open={bellOpen} notes={notes} onClose={() => setBellOpen(false)} />
		</>
	)
}

const NOTIFICATION_TEXT: Record<string, string> = {
	'update-available': 'A new version of umbrelOS is available',
	migration: 'Your data migration finished',
}
const noteText = (n: string) => NOTIFICATION_TEXT[n] ?? n.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function NotificationsSheet({open, notes, onClose}: {open: boolean; notes: string[]; onClose: () => void}) {
	const action = useAction()
	return (
		<Sheet open={open} onClose={onClose} label="Notifications">
			<SheetHeader title="Notifications" subtitle={notes.length ? `${notes.length} from umbrelOS` : undefined} onClose={onClose} />
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
							<span className="main">
								<b style={{fontWeight: 550, whiteSpace: 'normal'}}>{noteText(n)}</b>
							</span>
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
