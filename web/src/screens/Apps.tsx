import {useMemo, useState} from 'react'

import type {UserApp} from '../api'
import {useAction, useApps, useUpdates} from '../data'
import {Icon} from '../icons'
import {AppIcon, Segmented, StatusPill, StoreIcon, TerminalIcon, appStatus, haptic, isAppBusy, useConfirm} from '../ui'

type Filter = 'all' | 'running' | 'stopped' | 'updates'

export function SearchField({value, onChange, placeholder}: {value: string; onChange: (v: string) => void; placeholder: string}) {
	return (
		<label className="search glass">
			<Icon name="search" size={19} />
			<span className="sr-only">{placeholder}</span>
			<input type="search" enterKeyHint="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
			{value && (
				<button type="button" className="clear" aria-label="Clear search" onClick={() => onChange('')}>
					<Icon name="close" size={14} stroke={2.4} />
				</button>
			)}
		</label>
	)
}

export function Apps({onOpenApp, onTerminal, onStore}: {onOpenApp: (app: UserApp) => void; onTerminal?: () => void; onStore?: () => void}) {
	const apps = useApps()
	const updates = useUpdates()
	const action = useAction()
	const confirm = useConfirm()
	const [q, setQ] = useState('')
	const [filter, setFilter] = useState<Filter>('all')
	const updateMap = useMemo(() => new Map((updates.data ?? []).map((u) => [u.id, u.version])), [updates.data])
	const list = apps.data ?? []

	const counts = {
		all: list.length,
		running: list.filter((a) => appStatus(a.state).kind === 'running').length,
		stopped: list.filter((a) => a.state === 'stopped').length,
		updates: list.filter((a) => updateMap.has(a.id)).length,
	}
	const shown = list.filter((a) => {
		if (q && !`${a.name} ${a.id}`.toLowerCase().includes(q.toLowerCase())) return false
		if (filter === 'running') return appStatus(a.state).kind === 'running'
		if (filter === 'stopped') return a.state === 'stopped'
		if (filter === 'updates') return updateMap.has(a.id)
		return true
	})

	const updateAll = async () => {
		const targets = list.filter((a) => updateMap.has(a.id))
		const ok = await confirm({
			title: `Update ${targets.length} apps?`,
			body: `${targets.map((a) => a.name).join(', ')} will update one after another. Each app restarts while it updates.`,
			confirm: 'Update all',
			icon: 'update',
		})
		if (!ok) return
		for (const app of targets) {
			await action
				.mutateAsync({path: 'apps.update', input: {appId: app.id}, optimistic: {appId: app.id, state: 'updating'}, done: `${app.name} updated`})
				.catch(() => {})
		}
	}

	const segments: {id: Filter; label: string; count?: number}[] = [
		{id: 'all', label: 'All', count: counts.all},
		{id: 'running', label: 'Running', count: counts.running},
		{id: 'stopped', label: 'Stopped', count: counts.stopped},
	]
	if (counts.updates) segments.push({id: 'updates', label: 'Updates', count: counts.updates})

	return (
		<div className="stagger">
			<div>
				<h1 className="title">Apps</h1>
				<p className="subtitle">
					{apps.isLoading ? 'Loading…' : `${counts.running} running${counts.stopped ? ` · ${counts.stopped} stopped` : ''}${counts.updates ? ` · ${counts.updates} to update` : ''}`}
				</p>
			</div>
			<div className="system-tiles">
				{onStore && (
					<button className="glass system-tile press" onClick={() => (haptic(6), onStore())}>
						<StoreIcon size={46} />
						<span>
							<b>App Store</b>
							<small>Find new apps</small>
						</span>
					</button>
				)}
				{onTerminal && (
					<button className="glass system-tile press" onClick={() => (haptic(6), onTerminal())}>
						<TerminalIcon size={46} />
						<span>
							<b>Terminal</b>
							<small>Command line</small>
						</span>
					</button>
				)}
			</div>
			<SearchField value={q} onChange={setQ} placeholder={`Search ${list.length} apps`} />
			<Segmented value={filter} options={segments} onChange={setFilter} label="Filter apps" />
			{filter === 'updates' && counts.updates > 1 && (
				<button className="btn primary block" style={{marginBottom: 14}} onClick={updateAll} disabled={action.isPending}>
					<Icon name="update" size={20} />
					Update all {counts.updates}
				</button>
			)}
			{apps.isLoading ? (
				<div className="glass group">
					{Array.from({length: 6}, (_, i) => (
						<div key={i} className="row static">
							<div className="skeleton" style={{width: 46, height: 46, borderRadius: 12}} />
							<div style={{flex: 1}}>
								<div className="skeleton" style={{width: '50%', height: 12, marginBottom: 8}} />
								<div className="skeleton" style={{width: '30%', height: 10}} />
							</div>
						</div>
					))}
				</div>
			) : shown.length === 0 ? (
				<div className="glass empty">
					<span className="big">
						<Icon name={q ? 'search' : 'check'} size={30} />
					</span>
					<b>{q ? 'No matches' : filter === 'updates' ? 'All up to date' : 'Nothing here'}</b>
					{q && <span>No apps match “{q}”.</span>}
				</div>
			) : (
				<div className="glass group" style={{'--inset': '74px'} as React.CSSProperties}>
					{shown.map((app) => {
						const status = appStatus(app.state, updateMap.has(app.id))
						const busy = isAppBusy(app.state)
						return (
							<button
								key={app.id}
								className="row"
								onClick={() => {
									haptic(6)
									onOpenApp(app)
								}}
							>
								<AppIcon src={app.icon} name={app.name ?? app.id} size={46} dim={app.state === 'stopped'} progress={busy ? (app.progress || 'spin') : undefined} />
								<span className="main">
									<b>{app.name ?? app.id}</b>
									<span>
										{app.error
											? app.error
											: updateMap.has(app.id)
												? `${app.version} → ${updateMap.get(app.id)}`
												: `Version ${app.version}${app.port ? ` · port ${app.port}` : ''}`}
									</span>
								</span>
								<StatusPill {...status} />
							</button>
						)
					})}
				</div>
			)}
		</div>
	)
}
