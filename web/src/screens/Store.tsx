import {useMemo, useState, type CSSProperties} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query, type RegistryApp, type UserApp} from '../api'
import {appUrl, useAction, useApps, useBootstrap, useInstallReview, useRegistry} from '../data'
import {useDesktop} from '../desktop/Desktop'
import {openApp} from '../openApp'
import {Icon, hasIcon} from '../icons'
import {AppIcon, Sheet, SheetHeader, StatusPill, appStatus, bytes, haptic, isAppBusy, useToast} from '../ui'
import {SearchField} from './Apps'

type StoreApp = RegistryApp & {compatible?: boolean; repo?: string; unsupported?: string}

const CATEGORY_LABEL: Record<string, string> = {
	files: 'Files & Productivity',
	bitcoin: 'Bitcoin',
	finance: 'Finance',
	media: 'Media',
	networking: 'Networking',
	social: 'Social',
	automation: 'Home & Automation',
	ai: 'AI',
	developer: 'Developer Tools',
	crypto: 'Crypto',
	gaming: 'Gaming',
	photography: 'Photography',
}
const label = (c: string) => CATEGORY_LABEL[c] ?? c.charAt(0).toUpperCase() + c.slice(1)
const catIcon = (c: string) => (hasIcon(c) ? c : 'category')
// Shown first in "Featured" when present in the catalog; otherwise any app with screenshots.
const FEATURED = ['immich', 'nextcloud', 'home-assistant', 'jellyfin', 'plex', 'bitcoin', 'ollama', 'vaultwarden', 'pi-hole', 'tailscale']

export function Store({onOpenInstalled, onBack}: {onOpenInstalled: (app: UserApp) => void; onOpenApp?: (app: UserApp) => void; onBack?: () => void}) {
	const registry = useRegistry()
	const apps = useApps()
	const [q, setQ] = useState('')
	const [category, setCategory] = useState('all')
	const [selected, setSelected] = useState<{app: StoreApp; install?: boolean} | null>(null)
	const [stores, setStores] = useState(false)

	const all = useMemo(() => {
		const seen = new Map<string, StoreApp>()
		for (const repo of registry.data ?? []) for (const app of repo.apps) if (!seen.has(app.id)) seen.set(app.id, {...app, repo: repo.meta.name})
		return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
	}, [registry.data])
	const categories = useMemo(() => {
		const counts = new Map<string, number>()
		for (const a of all) if (a.category) counts.set(a.category, (counts.get(a.category) ?? 0) + 1)
		return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
	}, [all])
	const featured = useMemo(() => {
		const withShots = all.filter((a) => a.gallery?.length)
		const picked = FEATURED.map((id) => withShots.find((a) => a.id === id)).filter(Boolean) as StoreApp[]
		return (picked.length >= 3 ? picked : [...picked, ...withShots.filter((a) => !picked.includes(a))]).slice(0, 6)
	}, [all])
	const installed = useMemo(() => new Map((apps.data ?? []).map((a) => [a.id, a])), [apps.data])

	const browsing = !q && category === 'all'
	const shown = all
		.filter((a) => (category === 'all' ? true : a.category === category))
		.filter((a) => !q || `${a.name} ${a.tagline} ${a.developer}`.toLowerCase().includes(q.toLowerCase()))

	const pick = (app: StoreApp, install = false) => {
		haptic(6)
		setSelected({app, install})
	}

	const Item = ({app}: {app: StoreApp}) => {
		const inst = installed.get(app.id)
		return (
			<div className="store-item">
				<button className="store-main" onClick={() => pick(app)}>
					<AppIcon src={app.icon} name={app.name} size={58} />
					<span className="t">
						<b>{app.name}</b>
						<span>{app.tagline}</span>
					</span>
				</button>
				<span className="end">
					{inst ? (
						<button className="btn get" onClick={() => onOpenInstalled(inst)} aria-label={`Manage ${app.name}`}>
							{isAppBusy(inst.state) ? <span className="spinner" style={{width: 14, height: 14}} /> : 'Open'}
						</button>
					) : (
						<button className="btn get" onClick={() => pick(app, true)} aria-label={`Get ${app.name}`} disabled={app.compatible === false || !!app.unsupported}>
							Get
						</button>
					)}
				</span>
			</div>
		)
	}

	return (
		<div className="stagger">
			<div className="page-head">
				{onBack && (
					<button className="round-btn" aria-label="Back" onClick={onBack}>
						<Icon name="back" size={20} />
					</button>
				)}
				<div>
					<h1 className="title">App Store</h1>
					<p className="subtitle">{registry.isLoading ? 'Loading the catalog…' : `${all.length} apps for your server`}</p>
				</div>
				<button className="btn small stores-btn" style={{marginLeft: 'auto'}} aria-label="Community app stores" title="Community app stores" onClick={() => (haptic(5), setStores(true))}>
					<Icon name="store" size={17} />
					Stores
				</button>
			</div>
			<SearchField value={q} onChange={setQ} placeholder="Search apps" />
			<div className="chips" role="tablist" aria-label="Categories">
				{['all', ...categories].map((c) => (
					<button
						key={c}
						role="tab"
						aria-selected={category === c}
						className={`chip${category === c ? ' on' : ''}`}
						onClick={() => {
							haptic(5)
							setCategory(c)
						}}
					>
						<Icon name={c === 'all' ? 'all' : catIcon(c)} size={17} />
						{c === 'all' ? 'Discover' : label(c)}
					</button>
				))}
			</div>
			{registry.error && (
				<div className="error">
					<Icon name="alert" size={18} />
					{(registry.error as Error).message}
				</div>
			)}
			{registry.isLoading && (
				<>
					<div className="skeleton" style={{height: 220, borderRadius: 26, marginBottom: 20}} />
					{Array.from({length: 4}, (_, i) => (
						<div key={i} className="skeleton" style={{height: 62, margin: '10px 0'}} />
					))}
				</>
			)}

			{browsing && featured.length > 0 && (
				<div className="featured">
					{featured.map((app) => (
						<button key={app.id} className="feature" onClick={() => pick(app)}>
							<img src={app.gallery![0]} alt="" loading="lazy" decoding="async" />
							<span className="scrim-b" />
							<span className="tag">{label(app.category ?? 'Featured')}</span>
							<span className="meta">
								<AppIcon src={app.icon} name={app.name} size={44} />
								<span className="t">
									<b>{app.name}</b>
									<span>{app.tagline}</span>
								</span>
							</span>
						</button>
					))}
				</div>
			)}

			{browsing
				? categories.slice(0, 8).map((c) => {
						const items = all.filter((a) => a.category === c).slice(0, 9)
						return (
							<section key={c}>
								<div className="section-head">
									<h2>{label(c)}</h2>
									<button className="link-btn" onClick={() => setCategory(c)}>
										See all
									</button>
								</div>
								<div className="shelf">
									{items.map((app) => (
										<Item key={app.id} app={app} />
									))}
								</div>
							</section>
						)
					})
				: !registry.isLoading && (
						<div className="list-store" style={{marginTop: 4}}>
							{shown.map((app) => (
								<Item key={app.id} app={app} />
							))}
							{shown.length === 0 && (
								<div className="glass empty">
									<span className="big">
										<Icon name="search" size={30} />
									</span>
									<b>No apps found</b>
									<span>Try a different search.</span>
								</div>
							)}
						</div>
					)}

			{stores && <CommunityStores onClose={() => setStores(false)} />}

			{selected && (
				<StoreSheet
					key={selected.app.id}
					app={selected.app}
					startInstall={selected.install}
					all={all}
					installed={installed}
					onSelect={(a) => setSelected({app: a})}
					onClose={() => setSelected(null)}
				/>
			)}
		</div>
	)
}

// ---- community app stores ------------------------------------------------------------------------
const SUGGESTED_STORES = [
	{
		url: 'https://github.com/TouchWorkStation/app-store',
		name: 'TouchWorkStation',
		blurb: 'Google Chrome and Brave browsers that run on your server and stream to any device.',
	},
]
type Repo = {url: string; meta: {id: string; name: string}}
const sameRepo = (a: string, b: string) => a.replace(/\.git$|\/$/, '').toLowerCase() === b.replace(/\.git$|\/$/, '').toLowerCase()

function CommunityStores({onClose}: {onClose: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const repos = useQuery({queryKey: ['appStore.repositories'], queryFn: () => query<Repo[]>('appStore.repositories')})
	const [url, setUrl] = useState('')
	const [removing, setRemoving] = useState<string | null>(null)
	const refresh = () => {
		qc.invalidateQueries({queryKey: ['appStore.repositories']})
		qc.invalidateQueries({queryKey: ['appStore.registry']})
	}
	const add = useMutation({
		mutationFn: (u: string) => mutate('appStore.addRepository', {url: u}),
		onSuccess: () => {
			toast('Store added. Its apps are now in the App Store.')
			setUrl('')
			refresh()
		},
		onError: (e) => toast((e as Error).message, true),
	})
	const remove = useMutation({
		mutationFn: (u: string) => mutate('appStore.removeRepository', {url: u}),
		onSuccess: () => {
			toast('Store removed')
			setRemoving(null)
			refresh()
		},
		onError: (e) => toast((e as Error).message, true),
	})
	const community = repos.data ?? []
	const suggestions = SUGGESTED_STORES.filter((s) => !(repos.data ?? []).some((r) => sameRepo(r.url, s.url)))
	const valid = /^https:\/\/[\w.-]+\/[\w.\-/]+$/.test(url.trim())
	return (
		<Sheet open onClose={onClose} label="Community app stores">
			<SheetHeader
				icon={
					<span className="sheet-icon" style={{background: 'var(--accent)'}}>
						<Icon name="store" size={28} />
					</span>
				}
				title="Community stores"
				subtitle="Extra app catalogs from other developers"
				onClose={onClose}
			/>
			<div className="screen">
				<p className="prose" style={{margin: '0 0 14px'}}>
					Community stores aren’t reviewed. Their apps run on your server like any other app, so only add stores from developers you trust.
				</p>
				{repos.isLoading && (
					<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', borderRadius: 18}}>
						<span className="spinner" /> Loading your stores…
					</div>
				)}
				{community.length > 0 && (
					<>
						<h4 className="list-head">Added</h4>
						<div className="glass group">
							{community.map((r) => (
								<div key={r.url} className="row static">
									<span className="row-ico" style={{'--c': 'var(--blue)'} as CSSProperties}>
										<Icon name="store" size={19} />
									</span>
									<span className="main">
										<b>{r.meta.name}</b>
										<span className="mono muted" style={{fontSize: 12, wordBreak: 'break-all'}}>{r.url}</span>
									</span>
									{removing === r.url ? (
										<button className="btn small danger" disabled={remove.isPending} onClick={() => remove.mutate(r.url)}>
											{remove.isPending ? 'Removing…' : 'Remove'}
										</button>
									) : (
										<button className="btn small" onClick={() => setRemoving(r.url)} aria-label={`Remove ${r.meta.name}`}>
											Remove
										</button>
									)}
								</div>
							))}
						</div>
						{removing && <p className="muted" style={{fontSize: 13, margin: '8px 4px 0'}}>Apps you installed from it keep running; they just won’t get updates.</p>}
					</>
				)}
				{suggestions.length > 0 && (
					<>
						<h4 className="list-head">Suggested</h4>
						<div className="glass group">
							{suggestions.map((sg) => (
								<div key={sg.url} className="row static">
									<span className="row-ico" style={{'--c': 'var(--accent)'} as CSSProperties}>
										<Icon name="store" size={19} />
									</span>
									<span className="main">
										<b>{sg.name}</b>
										<span className="muted" style={{fontSize: 13}}>{sg.blurb}</span>
									</span>
									<button className="btn small primary" disabled={add.isPending} onClick={() => add.mutate(sg.url)}>
										{add.isPending && add.variables === sg.url ? 'Adding…' : 'Add'}
									</button>
								</div>
							))}
						</div>
					</>
				)}
				<h4 className="list-head">Add by link</h4>
				<form
					className="store-add"
					onSubmit={(e) => {
						e.preventDefault()
						if (valid) add.mutate(url.trim())
					}}
				>
					<input
						className="field"
						type="url"
						inputMode="url"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						placeholder="https://github.com/someone/app-store"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						aria-label="Community app store link"
					/>
					<button className="btn primary" type="submit" disabled={!valid || add.isPending}>
						{add.isPending && add.variables === url.trim() ? 'Adding…' : 'Add'}
					</button>
				</form>
				{add.isPending && <p className="muted" style={{fontSize: 13, margin: '8px 4px 0'}}>Downloading the store’s catalog. This can take a minute.</p>}
			</div>
		</Sheet>
	)
}

function StoreSheet({
	app,
	startInstall,
	all,
	installed,
	onSelect,
	onClose,
}: {
	app: StoreApp
	startInstall?: boolean
	all: StoreApp[]
	installed: Map<string, UserApp>
	onSelect: (a: StoreApp) => void
	onClose: () => void
	onOpenApp?: (app: UserApp) => void
}) {
	const boot = useBootstrap()
	const desk = useDesktop()
	const toast = useToast()
	const action = useAction()
	const [reviewing, setReviewing] = useState(!!startInstall)
	const [more, setMore] = useState(false)
	const review = useInstallReview(reviewing ? app.id : null)

	const live = installed.get(app.id)
	// What it needs that isn't installed yet (an installed app can stand in, e.g. Bitcoin Knots).
	const covered = (id: string) => installed.has(id) || [...installed.keys()].some((k) => all.find((a) => a.id === k)?.implements?.includes(id))
	const missingDeps = (app.needs ?? app.dependencies ?? []).filter((d) => !covered(d))
	const incompatible = app.compatible === false || !!app.unsupported
	const canInstall = !live && !incompatible
	const showReview = reviewing && canInstall

	const install = () => {
		haptic(12)
		const folderAccess = review.data?.requiredFolders.map((f) => ({id: f.id, sourcePath: f.defaultSourcePath}))
		action.mutate({path: 'apps.install', input: {appId: app.id, ...(folderAccess?.length ? {folderAccess} : {})}, done: `${app.name} installed`})
		setReviewing(false)
	}
	const liveUrl = live ? appUrl(live, boot.server!.host) : null

	return (
		<Sheet open onClose={onClose} label={app.name}>
			<SheetHeader icon={<AppIcon src={app.icon} name={app.name} size={72} />} title={app.name} subtitle={app.developer ?? app.repo} onClose={onClose} />

			{showReview ? (
				<div className="screen">
					<h3 style={{margin: '0 0 6px', fontSize: 18, fontWeight: 680}}>Before you install</h3>
					<p className="prose" style={{margin: '0 0 16px'}}>
						{app.name} will be installed on your server{app.installSize ? ` (${bytes(app.installSize)} download)` : ''}.
					</p>
					{review.isLoading && (
						<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, borderRadius: 18}}>
							<span className="spinner" /> Checking what it needs…
						</div>
					)}
					{review.error && (
						<div className="error">
							<Icon name="alert" size={18} />
							{(review.error as Error).message}
						</div>
					)}
					{(review.data?.alsoInstalls?.length ?? 0) > 0 && (
						<div className="glass" style={{marginBottom: 16, borderRadius: 18, overflow: 'hidden'}}>
							<div style={{padding: '14px 16px 4px', fontSize: 13, fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em'}}>
								Also installs (it needs {review.data!.alsoInstalls!.length > 1 ? 'these' : 'this'})
							</div>
							{review.data!.alsoInstalls!.map((d) => (
								<div className="perm" key={d.id}>
									<AppIcon src={d.icon} name={d.name} size={34} />
									<span className="main">
										<b>{d.name}</b>
										<span>installed first</span>
									</span>
								</div>
							))}
						</div>
					)}
										{review.data && (review.data.requiredFolders.length > 0 || review.data.gpuAccess) && (
						<div className="glass" style={{marginBottom: 16, borderRadius: 18, overflow: 'hidden'}}>
							<div style={{padding: '14px 16px 4px', fontSize: 13, fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em'}}>
								It will have access to
							</div>
							{review.data.requiredFolders.map((f) => (
								<div className="perm" key={f.id}>
									<span className="row-ico" style={{'--c': 'var(--blue)'} as React.CSSProperties}>
										<Icon name="folder" size={18} />
									</span>
									<span className="main">
										<b>
											{f.name}
											{f.readOnly ? ' · read-only' : ''}
										</b>
										<span>{f.defaultSourcePath}</span>
									</span>
								</div>
							))}
							{review.data.gpuAccess && (
								<div className="perm">
									<span className="row-ico" style={{'--c': 'var(--peach)'} as React.CSSProperties}>
										<Icon name="bolt" size={18} />
									</span>
									<span className="main">
										<b>Graphics card</b>
										<span>hardware acceleration</span>
									</span>
								</div>
							)}
						</div>
					)}
					{review.data && !review.data.requiredFolders.length && !review.data.gpuAccess && (
						<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, borderRadius: 18}}>
							<span className="row-ico" style={{'--c': 'var(--green)'} as React.CSSProperties}>
								<Icon name="shield" size={18} />
							</span>
							<span style={{fontSize: 14.5}}>No access to your files or hardware needed.</span>
						</div>
					)}
					<div className="stack">
						<button className="btn primary block" onClick={install} disabled={!review.data || action.isPending}>
							<Icon name="download" size={20} />
							{review.data?.alsoInstalls?.length ? `Install all ${review.data.alsoInstalls.length + 1}` : `Install ${app.name}`}
						</button>
						<button className="btn block ghost" onClick={() => setReviewing(false)}>
							Back
						</button>
					</div>
				</div>
			) : (
				<>
					{live ? (
						<div className="primary-row">
							{isAppBusy(live.state) ? (
								<div className="glass card" style={{flex: 1, display: 'flex', alignItems: 'center', gap: 12, borderRadius: 18}}>
									<span className="spinner" style={{color: 'var(--accent-text)'}} />
									<span style={{flex: 1, fontWeight: 600, textTransform: 'capitalize'}}>
										{live.state}… {live.progress ? `${live.progress}%` : ''}
									</span>
								</div>
							) : (
								<>
									<button
										className="btn primary"
										disabled={!liveUrl}
										onClick={() => {
											haptic(6)
											onClose()
											if (desk) desk.launch(live)
											else if (liveUrl) {
												toast(`Opening ${live.name ?? app.name}…`)
												openApp(live, liveUrl, {onWaiting: (sec) => sec % 10 === 0 && toast(`${live.name ?? app.name} is still starting (${sec}s)…`)})
											}
										}}
									>
										<Icon name="open" size={20} />
										Open
									</button>
									<span style={{display: 'flex', alignItems: 'center'}}>
										<StatusPill {...appStatus(live.state)} />
									</span>
								</>
							)}
						</div>
					) : incompatible ? (
						<div className="error">
							<Icon name="alert" size={18} />
							{app.unsupported ?? 'This app needs a newer version of Omarchy Server.'}
						</div>
					) : (
						<>
							<div className="primary-row">
								<button className="btn primary" onClick={() => setReviewing(true)} disabled={action.isPending}>
									<Icon name="download" size={20} />
									Install
								</button>
							</div>
							{missingDeps.length > 0 && (
								<div className="glass" style={{marginBottom: 16, borderRadius: 18, overflow: 'hidden'}}>
									<div style={{padding: '14px 16px 4px', fontSize: 13, fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em'}}>
										Needs {missingDeps.length > 1 ? 'these apps' : 'this app'} · installed with it
									</div>
									{missingDeps.map((d) => {
										const dep = all.find((a) => a.id === d)
										return (
											<button key={d} className="row" style={{minHeight: 60}} onClick={() => dep && onSelect(dep)} disabled={!dep}>
												<AppIcon src={dep?.icon} name={dep?.name ?? d} size={38} />
												<span className="main">
													<b>{dep?.name ?? d}</b>
													{dep?.tagline && <span>{dep.tagline}</span>}
												</span>
												<Icon name="chevron" size={18} className="chev" />
											</button>
										)
									})}
								</div>
							)}
						</>
					)}
					{app.caution && !live && (
						<div className="glass card" style={{display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, borderRadius: 18}}>
							<span className="row-ico" style={{'--c': 'var(--blue)'} as React.CSSProperties}>
								<Icon name="info" size={18} />
							</span>
							<span style={{fontSize: 14.5}}>{app.caution}</span>
						</div>
					)}

					<div className="store-stats">
						<div>
							<small>Version</small>
							<b>{app.version ?? '–'}</b>
						</div>
						<div>
							<small>Category</small>
							<b>
								<Icon name={catIcon(app.category ?? '')} size={15} />
								{app.category ? label(app.category).split(' ')[0] : '–'}
							</b>
						</div>
						<div>
							<small>Size</small>
							<b>{app.installSize ? bytes(app.installSize, 0) : '–'}</b>
						</div>
					</div>

					{app.tagline && <p style={{margin: '0 0 16px', fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em'}}>{app.tagline}</p>}
					{(app.gallery?.length ?? 0) > 0 && (
						<div className="gallery">
							{app.gallery!.slice(0, 6).map((src) => (
								<img key={src} src={src} alt="" loading="lazy" decoding="async" />
							))}
						</div>
					)}
					{app.description && (
						<>
							<div className={`prose${more ? '' : ' clamp'}`}>{app.description}</div>
							{!more && app.description.length > 280 && (
								<button className="link-btn" style={{paddingLeft: 0}} onClick={() => setMore(true)}>
									More
								</button>
							)}
						</>
					)}
					{app.repo && <p className="footer-note" style={{textAlign: 'left', marginTop: 18}}>From {app.repo}</p>}
				</>
			)}
		</Sheet>
	)
}
