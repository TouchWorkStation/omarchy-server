import {useEffect, useRef, useState} from 'react'
import {useQuery} from '@tanstack/react-query'

import {openApp} from './openApp'
import {query, type UserApp} from './api'
import {appUrl, useAction, useBootstrap} from './data'
import {useDesktop} from './desktop/Desktop'
import {Icon, type IconName} from './icons'
import {AppIcon, KV, Sheet, SheetHeader, StatusPill, appStatus, haptic, isAppBusy, useConfirm, useToast} from './ui'

type Props = {app: UserApp | null; update?: {version: string}; onClose: () => void; onOpenApp?: (app: UserApp) => void; onTerminal?: (app: {id: string; name?: string; icon?: string}) => void}
type A = {id: string; label: string; icon: IconName; onClick: () => void; disabled?: boolean}

export function AppSheet({app, update, onClose, onTerminal}: Props) {
	const desk = useDesktop()
	const boot = useBootstrap()
	const action = useAction()
	const confirm = useConfirm()
	const toast = useToast()
	const [logsOpen, setLogsOpen] = useState(false)
	const [waiting, setWaiting] = useState<number | null>(null)
	const waitCtrl = useRef<AbortController | null>(null)
	useEffect(() => () => waitCtrl.current?.abort(), [])
	useEffect(() => (waitCtrl.current?.abort(), setWaiting(null)), [app?.id])
	useEffect(() => setLogsOpen(false), [app?.id])

	if (!app) return null
	const status = appStatus(app.state, !!update)
	const busy = isAppBusy(app.state) || action.isPending
	const stopped = app.state === 'stopped'
	const url = appUrl(app, boot.server!.host)
	const name = app.name ?? app.id

	const run = (path: string, optimisticState: UserApp['state'], done: string) => {
		haptic(10)
		action.mutate({path, input: {appId: app.id}, optimistic: {appId: app.id, state: optimisticState}, done})
	}
	const open = () => {
		if (!url) return
		haptic(6)
		if (desk) {
			onClose()
			desk.launch(app)
			return
		}
		// Straight to the app's own address and port, in this tab (like a container's link in Docker),
		// once it answers. The browser's back button returns to Omarchy Server.
		const ctrl = new AbortController()
		waitCtrl.current?.abort()
		waitCtrl.current = ctrl
		openApp(app, url, {signal: ctrl.signal, onWaiting: (s) => setWaiting(s)}).finally(() => waitCtrl.current === ctrl && setWaiting(null))
	}
	const copy = async () => {
		if (!url) return
		try {
			await navigator.clipboard.writeText(url)
			toast('Address copied')
		} catch {
			toast(url)
		}
	}

	const all: Record<string, A> = {
		open: {id: 'open', label: waiting !== null ? `Starting… ${waiting}s` : 'Open', icon: 'open', onClick: open, disabled: !url || stopped || waiting !== null},
		start: {id: 'start', label: 'Start', icon: 'play', onClick: () => run('apps.start', 'starting', `${name} started`)},
		stop: {id: 'stop', label: 'Stop', icon: 'stop', onClick: () => run('apps.stop', 'stopping', `${name} stopped`)},
		restart: {id: 'restart', label: 'Restart', icon: 'restart', onClick: () => run('apps.restart', 'restarting', `${name} restarted`), disabled: stopped},
		update: {id: 'update', label: `Update to ${update?.version}`, icon: 'update', onClick: () => run('apps.update', 'updating', `${name} updated to ${update?.version}`)},
		logs: {id: 'logs', label: 'Logs', icon: 'logs', onClick: () => setLogsOpen(true)},
		copy: {id: 'copy', label: 'Copy link', icon: 'link', onClick: copy, disabled: !url},
		shell: {id: 'shell', label: 'Terminal', icon: 'terminal', onClick: () => onTerminal?.({id: app.id, name, icon: app.icon}), disabled: stopped},
	}
	const primary = stopped ? all.start : update ? all.update : all.open
	const tiles = stopped
		? [all.logs, all.copy]
		: update
			? [all.open, all.restart, all.stop, all.logs]
			: [all.restart, all.stop, all.logs, ...(onTerminal ? [all.shell] : [all.copy])]

	const uninstall = async () => {
		const ok = await confirm({
			title: `Uninstall ${name}?`,
			body: `${name} and all of its data will be permanently removed from your server. This can’t be undone.`,
			confirm: `Uninstall ${name}`,
			danger: true,
			icon: 'trash',
		})
		if (ok) {
			run('apps.uninstall', 'uninstalling', `${name} uninstalled`)
			onClose()
		}
	}

	const creds = app.credentials
	const rows: [string, React.ReactNode][] = []
	if (creds?.defaultUsername) rows.push(['Username', creds.defaultUsername])
	if (creds?.defaultPassword) rows.push(['Password', creds.defaultPassword])
	rows.push(['Version', update ? `${app.version} → ${update.version}` : (app.version ?? '–')])
	if (url) rows.push(['Address', <a key="addr" href={url} style={{color: 'var(--accent-text)'}}>{new URL(url).host}</a>])

	return (
		<>
			<Sheet
				open={!logsOpen}
				onClose={() => {
					waitCtrl.current?.abort()
					setWaiting(null)
					onClose()
				}}
				label={`${name} actions`}
			>
				{waiting !== null && (
					<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, borderRadius: 16}}>
						<span className="spinner" />
						<span style={{fontSize: 14.5}}>{name} is still starting. It opens as soon as it answers.</span>
					</div>
				)}
				<SheetHeader
					icon={<AppIcon src={app.icon} name={name} size={64} dim={stopped} progress={isAppBusy(app.state) ? (app.progress || 'spin') : undefined} />}
					title={name}
					subtitle={
						<>
							<StatusPill {...status} />
							{isAppBusy(app.state) && app.progress ? <span className="num">{app.progress}%</span> : null}
						</>
					}
					onClose={onClose}
				/>
				{app.error && (
					<div className="error" style={{marginBottom: 14, display: 'block'}}>
						<div style={{display: 'flex', gap: 8, alignItems: 'flex-start'}}>
							<Icon name="alert" size={18} />
							<span style={{wordBreak: 'break-word'}}>{app.error}</span>
						</div>
						<button
							className="btn small"
							style={{marginTop: 10}}
							disabled={busy}
							onClick={() => (haptic(10), action.mutate({path: 'apps.install', input: {appId: app.id}, optimistic: {appId: app.id, state: 'installing'}, done: `${name} installed`}))}
						>
							<Icon name="restart" size={16} /> Try again
						</button>
					</div>
				)}
				<div className="primary-row">
					<button className="btn primary" onClick={primary.onClick} disabled={primary.disabled || busy}>
						{busy ? <span className="spinner" /> : <Icon name={primary.icon} size={20} />}
						{busy ? `${app.state === 'ready' ? 'Working' : (app.state ?? 'Working').replace(/^\w/, (c) => c.toUpperCase())}…` : primary.label}
					</button>
				</div>
				<div className="actions" style={{gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))`}}>
					{tiles.map((a) => (
						<button key={a.id} className="action" onClick={a.onClick} disabled={a.disabled || (busy && a.id !== 'logs' && a.id !== 'copy' && a.id !== 'shell')}>
							<Icon name={a.icon} size={22} />
							{a.label}
						</button>
					))}
				</div>
				<KV rows={rows} />
				<button className="btn danger block" onClick={uninstall} disabled={busy}>
					<Icon name="trash" size={19} />
					Uninstall
				</button>
			</Sheet>
			{logsOpen && <LogsSheet appId={app.id} name={name} icon={app.icon} onClose={() => setLogsOpen(false)} />}
		</>
	)
}

function LogsSheet({appId, name, icon, onClose}: {appId: string; name: string; icon?: string; onClose: () => void}) {
	const logs = useQuery({
		queryKey: ['apps.logs', appId],
		queryFn: () => query<string>('apps.logs', {appId, maxOutputBytes: 200_000}),
		refetchInterval: 5000,
	})
	const [el, setEl] = useState<HTMLPreElement | null>(null)
	useEffect(() => {
		if (el) el.scrollTop = el.scrollHeight
	}, [el, logs.data])
	return (
		<Sheet open onClose={onClose} label={`${name} logs`} tall>
			<SheetHeader
				icon={<AppIcon src={icon} name={name} size={44} />}
				title="Logs"
				subtitle={
					<>
						<span className="dot live" /> {name} · live
					</>
				}
				onClose={onClose}
			/>
			<pre className="logs" ref={setEl}>
				{logs.isLoading ? 'Loading…' : logs.error ? (logs.error as Error).message : logs.data?.trim() || 'No log output yet.'}
			</pre>
		</Sheet>
	)
}
