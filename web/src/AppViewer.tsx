import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'

import {mutate, type UserApp} from './api'
import {appUrl, useBootstrap} from './data'
import {AppFrame} from './desktop/Desktop'
import {Icon} from './icons'
import {AppIcon, haptic, usePortalRoot, useToast} from './ui'

// An app opened full screen inside Omarchy Server, in this same tab, the way a phone opens an app.
// The back button (on screen, or the browser's / phone's own) returns to where you were.
export function AppViewer({app, onClose}: {app: UserApp; onClose: () => void}) {
	const portalRoot = usePortalRoot()
	const boot = useBootstrap()
	const [reloads, setReloads] = useState(0)
	// Some apps keep a login of their own inside (set by the app, not Omarchy Server). Their
	// default details are shown here so there's nothing to look up.
	const creds = app.credentials?.defaultPassword ? app.credentials : null
	const seenKey = `omarchy.credsSeen.${app.id}`
	const [showCreds, setShowCreds] = useState(() => {
		try {
			return !!creds && !localStorage.getItem(seenKey)
		} catch {
			return !!creds
		}
	})
	const toast = useToast()
	const copy = async (v: string, what: string) => {
		try {
			await navigator.clipboard.writeText(v)
			toast(`${what} copied`)
		} catch {
			toast(v)
		}
	}
	const hideCreds = () => {
		setShowCreds(false)
		try {
			localStorage.setItem(seenKey, '1')
		} catch {}
	}
	const url = appUrl(app, boot.server!.host)
	const name = app.name ?? app.id
	const closed = useRef(false)
	const close = useRef(onClose)
	close.current = onClose

	// One history entry while the app is open, so the system back gesture closes it instead of leaving.
	useEffect(() => {
		closed.current = false
		history.pushState({omarchyApp: app.id}, '', location.href)
		const onPop = () => {
			closed.current = true
			close.current()
		}
		window.addEventListener('popstate', onPop)
		mutate('apps.trackOpen', {appId: app.id}).catch(() => {})
		return () => window.removeEventListener('popstate', onPop)
	}, [app.id])
	const back = () => {
		haptic(6)
		if (!closed.current && history.state?.omarchyApp === app.id) history.back()
		else onClose()
	}

	return createPortal(
		<div className="console app-viewer" role="dialog" aria-modal aria-label={name}>
			<header className="console-bar">
				<button className="round-btn" aria-label="Back" onClick={back}>
					<Icon name="back" size={20} />
				</button>
				<AppIcon src={app.icon} name={name} size={34} />
				<div className="console-title">
					<b>{name}</b>
					<span>{app.state === 'running' || app.state === 'ready' ? 'Running' : app.state}</span>
				</div>
				{creds && (
					<button className="round-btn" aria-label="Sign-in details" aria-pressed={showCreds} onClick={() => (showCreds ? hideCreds() : setShowCreds(true))}>
						<Icon name="key" size={19} />
					</button>
				)}
				<button className="round-btn" aria-label="Reload" onClick={() => (haptic(5), setReloads((n) => n + 1))}>
					<Icon name="restart" size={19} />
				</button>
				{url && (
					<a className="round-btn" aria-label="Open in a browser tab" title="Open in a browser tab" href={url} target="_blank" rel="noopener noreferrer">
						<Icon name="open" size={19} />
					</a>
				)}
			</header>
			{creds && showCreds && (
				<div className="app-creds">
					<span className="app-creds-note">{name} has its own login inside:</span>
					{creds.defaultUsername && (
						<button className="app-creds-chip" onClick={() => copy(creds.defaultUsername!, 'Username')}>
							<Icon name="user" size={15} />
							{creds.defaultUsername}
						</button>
					)}
					<button className="app-creds-chip" onClick={() => copy(creds.defaultPassword!, 'Password')}>
						<Icon name="key" size={15} />
						{creds.defaultPassword}
					</button>
					<button className="app-creds-close" aria-label="Hide sign-in details" onClick={hideCreds}>
						<Icon name="close" size={16} />
					</button>
				</div>
			)}
			<div className="app-viewer-body">
				<AppFrame key={reloads} app={app} url={url} onClose={back} />
			</div>
		</div>,
		portalRoot,
	)
}
