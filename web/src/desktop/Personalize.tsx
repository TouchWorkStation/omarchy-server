// "Desktop & Dock": desktop themes, wallpapers, dock layout and desktop icons. Desktop only,
// saved per device; your phone's appearance (Settings → Appearance) isn't changed.
import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react'

import {useUser} from '../data'
import {Icon} from '../icons'
import {Switch} from '../screens/Settings'
import {Segmented, customBackgroundUrl, haptic, preparePhoto, useToast, wallpaperUrl, type Prefs} from '../ui'
import {PRESETS, STYLES, SYSTEM_DOCK, WALLPAPERS, useDeskConfig, wallpaperSrc, type DeskAccent, type DeskConfig, type DockPos, type DockSize} from './config'
import {useDesktop, useItems, type ItemInfo} from './Desktop'

type Tab = 'themes' | 'background' | 'dock' | 'desktop'
const ACCENT_CHOICES: {id: DeskAccent; label: string; swatch: string}[] = [
	{id: 'wallpaper', label: 'From wallpaper', swatch: 'conic-gradient(#f97316,#eab308,#22c55e,#06b6d4,#8b5cf6,#ec4899,#f97316)'},
	{id: 'app', label: 'App theme', swatch: 'var(--accent)'},
	{id: 'blue', label: 'Blue', swatch: 'var(--blue)'},
	{id: 'mauve', label: 'Mauve', swatch: 'var(--mauve)'},
	{id: 'teal', label: 'Teal', swatch: 'var(--teal)'},
	{id: 'green', label: 'Green', swatch: 'var(--green)'},
	{id: 'peach', label: 'Peach', swatch: 'var(--peach)'},
	{id: 'pink', label: 'Pink', swatch: 'var(--pink)'},
]

export function Personalize({tab: initial, prefs, setPrefs}: {tab?: string; prefs: Prefs; setPrefs: (p: Prefs) => void}) {
	const [tab, setTab] = useState<Tab>(((['themes', 'background', 'dock', 'desktop'] as string[]).includes(initial ?? '') ? initial : 'themes') as Tab)
	useEffect(() => {
		if (initial && (['themes', 'background', 'dock', 'desktop'] as string[]).includes(initial)) setTab(initial as Tab)
	}, [initial])
	const [cfg, setCfg] = useDeskConfig()
	return (
		<div className="personalize">
			<h1 className="title" style={{margin: '4px 0 14px'}}>
				Desktop &amp; Dock
			</h1>
			<Segmented<Tab>
				label="Section"
				value={tab}
				options={[
					{id: 'themes', label: 'Themes'},
					{id: 'background', label: 'Background'},
					{id: 'dock', label: 'Dock'},
					{id: 'desktop', label: 'Desktop icons'},
				]}
				onChange={setTab}
			/>
			<div style={{height: 6}} />
			{tab === 'themes' && <Themes cfg={cfg} setCfg={setCfg} />}
			{tab === 'background' && <Background cfg={cfg} setCfg={setCfg} prefs={prefs} setPrefs={setPrefs} />}
			{tab === 'dock' && <DockSettings cfg={cfg} setCfg={setCfg} />}
			{tab === 'desktop' && <DesktopSettings cfg={cfg} setCfg={setCfg} />}
		</div>
	)
}

type P = {cfg: DeskConfig; setCfg: (fn: (c: DeskConfig) => DeskConfig) => void}

function Section({title, note, children}: {title: string; note?: ReactNode; children: ReactNode}) {
	return (
		<section className="pz-section">
			<div className="section-head">
				<h2>{title}</h2>
			</div>
			{children}
			{note && <p className="footer-note pz-note">{note}</p>}
		</section>
	)
}

function Themes({cfg, setCfg}: P) {
	return (
		<>
			<Section title="Desktop themes" note="A theme sets the wallpaper, the look of the top bar, dock and menus, and the accent colour. Fine-tune any of them below or in Background.">
				<div className="pz-grid themes">
					{PRESETS.map((t) => {
						const on = cfg.preset === t.id && cfg.wallpaper === t.wallpaper && cfg.style === t.style && cfg.accent === t.accent
						return (
							<button
								key={t.id}
								className={`pz-card${on ? ' on' : ''}`}
								onClick={() => {
									haptic(6)
									setCfg((c) => ({...c, preset: t.id, wallpaper: t.wallpaper, style: t.style, accent: t.accent}))
								}}
							>
								<span className={`pz-thumb theme-thumb style-${t.style}`} style={{backgroundImage: `url(${wallpaperSrc(t.wallpaper, true)})`}}>
									<i className="tt-bar" />
									<i className="tt-dock" />
									<i className="tt-win" />
									{on && <Icon name="check" size={16} stroke={3} className="pz-check" />}
								</span>
								<b>{t.name}</b>
								<small>{STYLES.find((s) => s.id === t.style)?.name}</small>
							</button>
						)
					})}
				</div>
			</Section>
			<Section title="Panel style">
				<div className="pz-grid styles">
					{STYLES.map((s) => (
						<button key={s.id} className={`pz-card style-card${cfg.style === s.id ? ' on' : ''}`} onClick={() => setCfg((c) => ({...c, preset: null, style: s.id}))}>
							<span className={`pz-thumb style-swatch style-${s.id}`} style={{backgroundImage: `url(${wallpaperSrc(WALLPAPERS.find((w) => w.id === cfg.wallpaper)?.id ?? 'valley', true)})`}}>
								<i className="tt-bar" />
								<i className="tt-dock" />
								{cfg.style === s.id && <Icon name="check" size={16} stroke={3} className="pz-check" />}
							</span>
							<b>{s.name}</b>
							<small>{s.note}</small>
						</button>
					))}
				</div>
			</Section>
			<Section title="Accent colour" note="“App theme” uses the accent from Settings → Appearance, the same as your phone.">
				<div className="pz-accents">
					{ACCENT_CHOICES.map((a) => (
						<button key={a.id} className={`pz-accent${cfg.accent === a.id ? ' on' : ''}`} onClick={() => setCfg((c) => ({...c, preset: null, accent: a.id}))} aria-pressed={cfg.accent === a.id}>
							<i style={{background: a.swatch}} />
							{a.label}
						</button>
					))}
				</div>
			</Section>
		</>
	)
}

function Background({cfg, setCfg, prefs, setPrefs}: P & {prefs: Prefs; setPrefs: (p: Prefs) => void}) {
	const user = useUser()
	const toast = useToast()
	const fileRef = useRef<HTMLInputElement>(null)
	const [uploading, setUploading] = useState(false)
	const photo = customBackgroundUrl(prefs.backgroundVersion)
	const umbrelWall = wallpaperUrl(user.data?.wallpaper)
	const pick = (id: DeskConfig['wallpaper']) => {
		haptic(6)
		setCfg((c) => ({...c, preset: null, wallpaper: id}))
	}
	const upload = async (file?: File | null) => {
		if (!file) return
		setUploading(true)
		try {
			const {blob, hsl} = await preparePhoto(file)
			const res = await fetch('/api/background', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'image/jpeg', 'x-umbrel-touch': '1'}, body: blob})
			const body = await res.json().catch(() => null)
			if (!res.ok) throw new Error(body?.error?.message ?? 'Upload failed')
			// Only the photo is stored; the phone keeps its own theme unless you choose "Your photo" there.
			setPrefs({...prefs, customBrandHsl: hsl, backgroundVersion: body.prefs.backgroundVersion})
			setCfg((c) => ({...c, preset: null, wallpaper: 'photo'}))
			toast('Background set')
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setUploading(false)
			if (fileRef.current) fileRef.current.value = ''
		}
	}
	return (
		<>
			<Section title="Wallpapers" note="High-resolution photos from the elementary OS collection (CC0, Unsplash and Pexels licences; credits in wallpapers/CREDITS.md).">
				<div className="pz-grid walls">
					{WALLPAPERS.map((w) => (
						<button key={w.id} className={`pz-card wall-card${cfg.wallpaper === w.id ? ' on' : ''}`} onClick={() => pick(w.id)} title={`${w.name} · ${w.by}`}>
							<span className="pz-thumb" style={{backgroundImage: `url(${wallpaperSrc(w.id, true)})`}}>
								{cfg.wallpaper === w.id && <Icon name="check" size={16} stroke={3} className="pz-check" />}
							</span>
							<b>{w.name}</b>
						</button>
					))}
				</div>
			</Section>
			<Section title="Your own">
				<div className="pz-grid walls">
					<button className={`pz-card wall-card${cfg.wallpaper === 'umbrel' ? ' on' : ''}`} onClick={() => pick('umbrel')}>
						<span className="pz-thumb" style={{backgroundImage: umbrelWall ? `url(${umbrelWall})` : undefined}}>
							{cfg.wallpaper === 'umbrel' && <Icon name="check" size={16} stroke={3} className="pz-check" />}
						</span>
						<b>umbrelOS wallpaper</b>
					</button>
					{photo && (
						<button className={`pz-card wall-card${cfg.wallpaper === 'photo' ? ' on' : ''}`} onClick={() => pick('photo')}>
							<span className="pz-thumb" style={{backgroundImage: `url(${photo})`}}>
								{cfg.wallpaper === 'photo' && <Icon name="check" size={16} stroke={3} className="pz-check" />}
							</span>
							<b>Your photo</b>
						</button>
					)}
					<button className="pz-card wall-card add" onClick={() => fileRef.current?.click()} disabled={uploading}>
						<span className="pz-thumb add-thumb">{uploading ? <span className="spinner" /> : <Icon name="upload" size={26} />}</span>
						<b>{photo ? 'Replace photo…' : 'Upload a photo…'}</b>
					</button>
					<input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
				</div>
			</Section>
		</>
	)
}

function DockSettings({cfg, setCfg}: P) {
	const {info, appList, machineList, owner} = useItems()
	const d = cfg.dock
	const set = (patch: Partial<DeskConfig['dock']>) => setCfg((c) => ({...c, dock: {...c.dock, ...patch}}))
	const move = (k: string, dir: -1 | 1) => {
		const items = [...d.items]
		const i = items.indexOf(k)
		const j = i + dir
		if (j < 0 || j >= items.length) return
		;[items[i], items[j]] = [items[j], items[i]]
		set({items})
	}
	const candidates = allKeys(appList, machineList, owner).filter((k) => !d.items.includes(k))
	return (
		<>
			<Section title="Layout">
				<div className="glass group pz-rows">
					<div className="row static">
						<span className="main">
							<b>Position</b>
						</span>
						<Segmented<DockPos>
							label="Dock position"
							value={d.position}
							options={[
								{id: 'left', label: 'Left'},
								{id: 'bottom', label: 'Bottom'},
								{id: 'right', label: 'Right'},
							]}
							onChange={(v) => set({position: v})}
						/>
					</div>
					<div className="row static">
						<span className="main">
							<b>Icon size</b>
						</span>
						<Segmented<DockSize>
							label="Icon size"
							value={d.size}
							options={[
								{id: 'small', label: 'Small'},
								{id: 'medium', label: 'Medium'},
								{id: 'large', label: 'Large'},
							]}
							onChange={(v) => set({size: v})}
						/>
					</div>
					<ToggleRow label="Floating" note="A rounded dock with space around it, instead of a full-height panel" on={d.floating} onChange={(v) => set({floating: v})} />
					<ToggleRow label="Auto-hide" note="Slides away; move the pointer to the screen edge to bring it back" on={d.autohide} onChange={(v) => set({autohide: v})} />
					<ToggleRow label="Show open apps" note="Apps and machines that are open but not pinned appear after a divider" on={d.showRunning} onChange={(v) => set({showRunning: v})} />
				</div>
			</Section>
			<Section title="In the dock" note="Tip: you can also drag icons in the dock to reorder them, drag one onto the desktop to add an icon there, and right-click any app to pin it.">
				<div className="glass group pz-rows" style={{'--inset': '66px'} as CSSProperties}>
					{d.items.map((k, i) => {
						const it = info(k)
						return (
							<div key={k} className="row static pz-item">
								<span className="pz-ico">{it.icon(36)}</span>
								<span className="main">
									<b>{it.label}</b>
									{it.missing && <span>Not available</span>}
								</span>
								<button className="icon-btn" aria-label={`Move ${it.label} up`} disabled={i === 0} onClick={() => move(k, -1)}>
									<Icon name="chevron-down" size={16} style={{transform: 'rotate(180deg)'}} />
								</button>
								<button className="icon-btn" aria-label={`Move ${it.label} down`} disabled={i === d.items.length - 1} onClick={() => move(k, 1)}>
									<Icon name="chevron-down" size={16} />
								</button>
								<button className="icon-btn danger-x" aria-label={`Remove ${it.label} from the dock`} onClick={() => set({items: d.items.filter((x) => x !== k)})}>
									<Icon name="close" size={15} stroke={2.4} />
								</button>
							</div>
						)
					})}
					{d.items.length === 0 && <div className="row static muted">The dock is empty. Add something below.</div>}
				</div>
				<div className="pz-actions">
					<button className="btn" onClick={() => set({items: [...SYSTEM_DOCK]})}>
						<Icon name="restart" size={16} />
						Reset to default
					</button>
				</div>
			</Section>
			<Section title="Add to the dock">
				<ItemPicker keys={candidates} info={info} onPick={(k) => set({items: [...d.items, k]})} actionLabel="Add" />
			</Section>
		</>
	)
}

function DesktopSettings({cfg, setCfg}: P) {
	const desk = useDesktop()
	const {info, appList, machineList, owner} = useItems()
	const onDesk = new Set(cfg.icons.map((i) => i.key))
	const running = [
		...appList.filter((a) => a.state === 'ready' || a.state === 'running').map((a) => `app:${a.id}`),
		...machineList.filter((m) => m.state === 'running').map((m) => `machine:${m.id}`),
	].filter((k) => !onDesk.has(k))
	return (
		<>
			<Section
				title="Opening Umbrel apps"
				note="Some apps (Forgejo, Nextcloud, Home Assistant and others) don’t allow being shown inside another page. Those always open in their own browser tab, like in the umbrelOS dashboard."
			>
				<div className="glass group pz-rows">
					<div className="row static">
						<span className="main">
							<b>Open apps in</b>
						</span>
						<Segmented<'auto' | 'tab'>
							label="Open apps in"
							value={cfg.appsOpenIn}
							options={[
								{id: 'auto', label: 'Windows'},
								{id: 'tab', label: 'Browser tabs'},
							]}
							onChange={(v) => setCfg((c) => ({...c, appsOpenIn: v}))}
						/>
					</div>
				</div>
			</Section>
			<Section title="Desktop">
				<div className="glass group pz-rows">
					<ToggleRow label="Show icons on the desktop" on={cfg.showIcons} onChange={(v) => setCfg((c) => ({...c, showIcons: v}))} />
				</div>
				<div className="pz-actions">
					<button className="btn primary" disabled={!running.length} onClick={() => running.forEach((k) => desk?.addIcon(k))}>
						<Icon name="plus" size={16} />
						Add all running apps and machines{running.length ? ` (${running.length})` : ''}
					</button>
				</div>
			</Section>
			<Section title="Choose icons" note="Double-click an icon to open it. Drag icons to arrange them, drag across the desktop to select several, and press Delete to remove the selected icons (only the shortcut is removed). A stopped machine starts when you open it.">
				<ItemPicker
					keys={allKeys(appList, machineList, owner, true)}
					info={info}
					selected={onDesk}
					onPick={(k) => (onDesk.has(k) ? desk?.removeIcon(k) : desk?.addIcon(k))}
				/>
			</Section>
		</>
	)
}

function allKeys(appList: {id: string; name?: string}[], machineList: {id: string}[], owner: boolean, folders = false) {
	return [
		...(folders ? ['folder:/Home', 'folder:/Trash'] : []),
		...SYSTEM_DOCK.filter((k) => k !== 'terminal' || owner),
		'personalize',
		...[...appList].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)).map((a) => `app:${a.id}`),
		...machineList.map((m) => `machine:${m.id}`),
	]
}

function ItemPicker({keys, info, selected, onPick, actionLabel}: {keys: string[]; info: (k: string) => ItemInfo; selected?: Set<string>; onPick: (k: string) => void; actionLabel?: string}) {
	const groups: [string, (k: string) => boolean][] = [
		['Folders', (k) => k.startsWith('folder:')],
		['System', (k) => !k.includes(':')],
		['Umbrel apps', (k) => k.startsWith('app:')],
		['Machines', (k) => k.startsWith('machine:')],
	]
	return (
		<>
			{groups.map(([title, test]) => {
				const list = keys.filter(test).map(info)
				if (!list.length) return null
				return (
					<div key={title} className="pz-pick-group">
						<h3>{title}</h3>
						<div className="pz-pick">
							{list.map((it) => {
								const on = selected?.has(it.key)
								return (
									<button key={it.key} className={`pz-pick-item${on ? ' on' : ''}`} onClick={() => (haptic(5), onPick(it.key))} aria-pressed={selected ? on : undefined}>
										<span className="desk-icon-art">
											{it.icon(48)}
											{it.status && it.status !== 'stopped' && (it.key.startsWith('app:') || it.key.startsWith('machine:')) && <span className={`state-dot ${it.status}`} />}
											{selected && <span className={`pick-check${on ? ' on' : ''}`}>{on && <Icon name="check" size={13} stroke={3} />}</span>}
										</span>
										<span className="pz-pick-label">{it.label}</span>
										{actionLabel && <span className="pz-pick-action">{actionLabel}</span>}
									</button>
								)
							})}
						</div>
					</div>
				)
			})}
		</>
	)
}

function ToggleRow({label, note, on, onChange}: {label: string; note?: string; on: boolean; onChange: (v: boolean) => void}) {
	return (
		<div className="row static">
			<span className="main">
				<b>{label}</b>
				{note && <span>{note}</span>}
			</span>
			<Switch on={on} onChange={onChange} label={label} />
		</div>
	)
}
