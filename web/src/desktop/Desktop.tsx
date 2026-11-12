// Desktop mode: a full desktop in the style of Ubuntu (GNOME) for wide screens with a mouse.
// Top bar (Activities, clock + notifications, system menu), a customizable dock, icons on the
// desktop for folders, apps and machines, freely movable and resizable windows with snapping,
// and an Activities overview. Every window reuses the same screens as the phone layout.
import {createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {logout, mutate, type Bootstrap, type Machine, type UserApp} from '../api'
import {AppSheet} from '../AppSheet'
import {Console} from '../Console'
import {appUrl, useAction, useApps, useBootstrap, useCpu, useMachines, useMemory, useNotifications, useUpdates, useUser} from '../data'
import {Icon, type IconName} from '../icons'
import {Apps} from '../screens/Apps'
import {Files} from '../screens/Files'
import {Machines, osLook} from '../screens/Machines'
import {More} from '../screens/More'
import {Settings} from '../screens/Settings'
import {Store} from '../screens/Store'
import {TerminalScreen} from '../Terminal'
import {AppIcon, InWindow, PortalRoot, StoreIcon, TerminalIcon, customBackgroundUrl, setLayoutPref, useConfirm, useToast, wallpaperUrl, type Prefs} from '../ui'
import {SYSTEM_DOCK, WALLPAPERS, useDeskConfig, wallpaperSrc, type DeskConfig, type DeskIcon} from './config'
import {Personalize} from './Personalize'

// ---- model ---------------------------------------------------------------------------------
type Kind = 'files' | 'apps' | 'store' | 'terminal' | 'machines' | 'system' | 'settings' | 'personalize' | 'console' | 'app'
type Payload = {appId?: string; machineId?: string; path?: string; tab?: string; term?: {id: string; name?: string; icon?: string}}
type Snap = 'max' | 'left' | 'right' | null
type Rect = {x: number; y: number; w: number; h: number}
type Win = Rect & {id: string; kind: Kind; key: string; payload?: Payload; z: number; min: boolean; snap: Snap; born: number}
type SysKind = Exclude<Kind, 'app' | 'console'>

const TOP = 34 // top bar height
const MIN_W = 380
const MIN_H = 260
const CELL_W = 104
const CELL_H = 112

export const SYS: Record<SysKind, {title: string; icon?: IconName; bg?: string; w: number; h: number}> = {
	files: {title: 'Files', icon: 'folder-filled', bg: 'linear-gradient(150deg,#7cb4ff,#2563eb 70%)', w: 960, h: 660},
	apps: {title: 'Apps', icon: 'apps-filled', bg: 'linear-gradient(150deg,#c4b5fd,#7c3aed 70%)', w: 800, h: 680},
	store: {title: 'App Store', w: 1040, h: 720},
	terminal: {title: 'Terminal', w: 860, h: 540},
	machines: {title: 'Machines', icon: 'machine-filled', bg: 'linear-gradient(150deg,#5eead4,#0f766e 70%)', w: 820, h: 640},
	system: {title: 'System Monitor', icon: 'activity-filled', bg: 'linear-gradient(150deg,#fdba74,#c2410c 70%)', w: 820, h: 720},
	settings: {title: 'Settings', icon: 'settings', bg: 'linear-gradient(150deg,#cbd5e1,#475569 70%)', w: 760, h: 720},
	personalize: {title: 'Desktop & Dock', icon: 'palette', bg: 'linear-gradient(150deg,#f9a8d4,#be185d 70%)', w: 880, h: 720},
}
const isSys = (k: string): k is SysKind => Object.hasOwn(SYS, k)
const keyOf = (kind: Kind, p?: Payload) => (kind === 'app' ? `app:${p?.appId}` : kind === 'console' ? `console:${p?.machineId}` : kind)
// Dock/desktop items and windows: machines run as console windows, everything else as itself.
const itemOfWin = (w: Win) => (w.kind === 'console' ? `machine:${w.payload?.machineId}` : w.key)

// The usable area (between the top bar and the dock). Updated as the dock moves or resizes.
let AREA = {t: TOP, l: 74, r: 0, b: 0}
const area = () => ({x: AREA.l, y: AREA.t, w: window.innerWidth - AREA.l - AREA.r, h: window.innerHeight - AREA.t - AREA.b})
const snapRect = (snap: Exclude<Snap, null>): Rect => {
	const a = area()
	if (snap === 'left') return {x: a.x, y: a.y, w: Math.floor(a.w / 2), h: a.h}
	if (snap === 'right') return {x: a.x + Math.floor(a.w / 2), y: a.y, w: Math.ceil(a.w / 2), h: a.h}
	return a
}
const rectOf = (win: Win): Rect => (win.snap ? snapRect(win.snap) : {x: win.x, y: win.y, w: win.w, h: win.h})

const DOCK_ICON = {small: 38, medium: 46, large: 56} as const
const dockThickness = (cfg: DeskConfig) => DOCK_ICON[cfg.dock.size] + 26 + (cfg.dock.floating ? 14 : 0)

export function SysIcon({kind, size = 44}: {kind: string; size?: number}) {
	if (kind === 'store') return <StoreIcon size={size} />
	if (kind === 'terminal') return <TerminalIcon size={size} />
	const s = isSys(kind) ? SYS[kind] : undefined
	return (
		<span className="app-icon" style={{width: size, height: size, background: s?.bg ?? '#555'}}>
			<Icon name={s?.icon ?? 'window'} size={size * 0.52} stroke={1.8} />
		</span>
	)
}
function FolderIcon({path, size}: {path: string; size: number}) {
	const trash = path === '/Trash'
	const home = path === '/Home'
	return (
		<span className="app-icon folder-icon" style={{width: size, height: size, background: trash ? 'linear-gradient(150deg,#a1a1aa,#52525b 70%)' : 'linear-gradient(150deg,#93c5fd,#3b82f6 70%)'}}>
			<Icon name={trash ? 'trash' : home ? 'home' : 'folder-filled'} size={size * 0.52} stroke={1.8} />
		</span>
	)
}
export function MachineIcon({m, size}: {m?: Machine; size: number}) {
	const look = osLook(m?.osId)
	return (
		<span className="app-icon" style={{width: size, height: size, background: look.bg}}>
			<Icon name={look.icon} size={size * 0.52} stroke={1.8} />
		</span>
	)
}

// ---- items: the things a dock slot or a desktop icon can point at ----------------------------------
export type ItemInfo = {key: string; label: string; icon: (size: number) => ReactNode; status?: 'running' | 'stopped' | 'busy'; missing?: boolean}
export function useItems() {
	const apps = useApps()
	const machines = useMachines()
	const user = useUser()
	const owner = user.data?.role !== 'member'
	const appList = useMemo(() => apps.data ?? [], [apps.data])
	const machineList = useMemo(() => machines.data ?? [], [machines.data])
	const info = useCallback(
		(key: string): ItemInfo => {
			if (isSys(key)) return {key, label: SYS[key].title, icon: (s) => <SysIcon kind={key} size={s} />, missing: key === 'terminal' && !owner}
			if (key.startsWith('app:')) {
				const a = appList.find((x) => x.id === key.slice(4))
				const up = !!a && (a.state === 'ready' || a.state === 'running')
				return {
					key,
					label: a?.name ?? key.slice(4),
					icon: (s) => <AppIcon src={a?.icon} name={a?.name ?? key.slice(4)} size={s} dim={!!a && !up} />,
					status: !a ? undefined : up ? 'running' : a.state === 'stopped' ? 'stopped' : 'busy',
					missing: apps.isSuccess && !a,
				}
			}
			if (key.startsWith('machine:')) {
				const m = machineList.find((x) => x.id === key.slice(8))
				return {
					key,
					label: m?.name ?? 'Machine',
					icon: (s) => <MachineIcon m={m} size={s} />,
					status: !m ? undefined : m.state === 'running' ? 'running' : m.state === 'stopped' || m.state === 'error' ? 'stopped' : 'busy',
					missing: machines.isSuccess && !m,
				}
			}
			if (key.startsWith('folder:')) {
				const path = key.slice(7)
				const label = path === '/Home' ? 'Home' : path === '/Trash' ? 'Trash' : path.slice(path.lastIndexOf('/') + 1)
				return {key, label, icon: (s) => <FolderIcon path={path} size={s} />}
			}
			return {key, label: key, icon: (s) => <SysIcon kind="window" size={s} />, missing: true}
		},
		[appList, machineList, owner, apps.isSuccess, machines.isSuccess],
	)
	return {info, appList, machineList, owner}
}

// ---- can an app be shown inside a window? --------------------------------------------------------
export type FrameVerdict = 'window' | 'tab' | 'signin' | 'unknown'
type FrameInfo = {results: Record<string, FrameVerdict>; relay: Record<string, boolean>; sso: boolean; remote: boolean}
export function useAppFrame(ids: string[]) {
	const key = [...ids].sort().join(',')
	return useQuery({
		queryKey: ['app-frame', key],
		queryFn: () =>
			fetch(`/api/app-frame?apps=${encodeURIComponent(key)}`, {credentials: 'same-origin'})
				.then((r) => (r.ok ? r.json() : {}))
				.then((b: Partial<FrameInfo>): FrameInfo => ({results: b?.results ?? {}, relay: b?.relay ?? {}, sso: !!b?.sso, remote: !!b?.remote})),
		enabled: ids.length > 0,
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: true,
	})
}

// ---- context: lets screens open things as windows ----------------------------------------------
type DesktopApi = {
	open: (kind: Kind, payload?: Payload, opts?: {newWindow?: boolean}) => void
	launch: (app: UserApp) => void
	openConsole: (machineId: string) => void
	openTerminal: (app?: {id: string; name?: string; icon?: string}) => void
	openItem: (key: string) => void
	close: (id: string) => void
	addIcon: (key: string, at?: {x: number; y: number}) => void
	removeIcon: (key: string) => void
	pin: (key: string) => void
	unpin: (key: string) => void
}
const DesktopContext = createContext<DesktopApi | null>(null)
export const useDesktop = () => useContext(DesktopContext)

function load<T>(key: string, fallback: T): T {
	try {
		const v = localStorage.getItem(key)
		return v ? (JSON.parse(v) as T) : fallback
	} catch {
		return fallback
	}
}
function save(key: string, v: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(v))
	} catch {
		/* storage full or private mode */
	}
}
const STORE_KEY = 'umbrel-touch:desktop'

function useViewport() {
	const [vp, setVp] = useState({w: window.innerWidth, h: window.innerHeight})
	useEffect(() => {
		const on = () => setVp({w: window.innerWidth, h: window.innerHeight})
		window.addEventListener('resize', on)
		return () => window.removeEventListener('resize', on)
	}, [])
	return vp
}

// Desktop icon grid (column by column from the top-left, like Ubuntu).
const gridOrigin = () => ({x: AREA.l + 14, y: AREA.t + 14})
const gridSize = () => ({cols: Math.max(1, Math.floor((area().w - 28) / CELL_W)), rows: Math.max(1, Math.floor((area().h - 28) / CELL_H))})
function freeCell(icons: DeskIcon[], near?: {col: number; row: number}) {
	const {cols, rows} = gridSize()
	const taken = new Set(icons.map((i) => `${i.col},${i.row}`))
	if (near) {
		let best: {col: number; row: number; d: number} | null = null
		for (let c = 0; c < cols; c++)
			for (let r = 0; r < rows; r++) {
				if (taken.has(`${c},${r}`)) continue
				const d = (c - near.col) ** 2 + (r - near.row) ** 2
				if (!best || d < best.d) best = {col: c, row: r, d}
			}
		if (best) return {col: best.col, row: best.row}
	}
	for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) if (!taken.has(`${c},${r}`)) return {col: c, row: r}
	return {col: 0, row: icons.length}
}
const cellAt = (x: number, y: number) => {
	const o = gridOrigin()
	const {cols, rows} = gridSize()
	return {col: Math.max(0, Math.min(cols - 1, Math.round((x - o.x - CELL_W / 2) / CELL_W))), row: Math.max(0, Math.min(rows - 1, Math.round((y - o.y - CELL_H / 2) / CELL_H)))}
}

type MenuItem = {label: string; icon?: IconName; onClick: () => void; danger?: boolean; disabled?: boolean} | 'sep'
type Menu = {x: number; y: number; title?: string; items: MenuItem[]}

// ---- the desktop -------------------------------------------------------------------------------
export function Desktop({boot, prefs, setPrefs, onSignedOut}: {boot: Bootstrap; prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void}) {
	useViewport()
	const user = useUser()
	const [cfg, setCfg] = useDeskConfig()
	const {info, appList, machineList, owner} = useItems()
	const [wins, setWins] = useState<Win[]>(() => load<Win[]>(STORE_KEY, []).filter((w) => w.kind !== 'terminal' && w.kind !== 'console'))
	const [overview, setOverview] = useState<null | 'windows' | 'apps'>(null)
	const [topMenu, setTopMenu] = useState<null | 'clock' | 'system'>(null)
	const [menu, setMenu] = useState<Menu | null>(null)
	const [preview, setPreview] = useState<Rect | null>(null)
	const [dragging, setDragging] = useState(false)
	const [starting, setStarting] = useState<string[]>([])
	const zTop = useRef(Math.max(10, ...wins.map((w) => w.z)))
	const winsRef = useRef(wins)
	winsRef.current = wins
	const toast = useToast()
	const confirm = useConfirm()
	const qc = useQueryClient()

	// Reserve space for the dock (unless it hides itself).
	const thick = dockThickness(cfg)
	const reserve = cfg.dock.autohide ? 0 : thick
	AREA = {t: TOP, l: cfg.dock.position === 'left' ? reserve : 0, r: cfg.dock.position === 'right' ? reserve : 0, b: cfg.dock.position === 'bottom' ? reserve : 0}

	useEffect(() => save(STORE_KEY, wins.filter((w) => w.kind !== 'terminal' && w.kind !== 'console')), [wins])
	useEffect(() => {
		document.documentElement.classList.add('desk-mode')
		return () => document.documentElement.classList.remove('desk-mode')
	}, [])

	const visible = wins.filter((w) => !w.min)
	const active = visible.length ? visible.reduce((a, b) => (b.z > a.z ? b : a)) : null

	// -- window operations --
	const focus = useCallback((id: string) => {
		setWins((ws) => {
			const w = ws.find((x) => x.id === id)
			if (!w) return ws
			const top = ws.every((x) => x.id === id || x.min || x.z < w.z)
			if (top && !w.min) return ws
			zTop.current += 1
			return ws.map((x) => (x.id === id ? {...x, z: zTop.current, min: false} : x))
		})
	}, [])
	const update = useCallback((id: string, patch: Partial<Win>) => setWins((ws) => ws.map((w) => (w.id === id ? {...w, ...patch} : w))), [])
	const close = useCallback((id: string) => setWins((ws) => ws.filter((w) => w.id !== id)), [])
	const minimize = useCallback((id: string) => update(id, {min: true}), [update])

	const open = useCallback<DesktopApi['open']>(
		(kind, payload, opts) => {
			setOverview(null)
			setMenu(null)
			setTopMenu(null)
			const key = keyOf(kind, payload)
			const multi = kind === 'files' || kind === 'terminal'
			const existing = winsRef.current.filter((w) => w.key === key).sort((a, b) => b.z - a.z)[0]
			if (existing && !(multi && opts?.newWindow)) {
				if (kind === 'personalize' && payload?.tab) update(existing.id, {payload})
				focus(existing.id)
				return
			}
			const def = kind === 'app' ? {w: 1140, h: 760} : kind === 'console' ? {w: 1060, h: 720} : SYS[kind]
			const a = area()
			const w = Math.max(MIN_W, Math.min(def.w, a.w - 48))
			const h = Math.max(MIN_H, Math.min(def.h, a.h - 40))
			const n = winsRef.current.filter((x) => !x.min).length
			const off = (n % 6) * 30
			const x = Math.min(a.x + Math.max(16, (a.w - w) / 2) + off - 60, a.x + a.w - w - 8)
			const y = Math.min(a.y + Math.max(12, (a.h - h) / 2) + off - 30, a.y + a.h - h - 8)
			zTop.current += 1
			const win: Win = {id: Math.random().toString(36).slice(2, 10), kind, key, payload, x: Math.max(a.x + 8, x), y: Math.max(a.y + 8, y), w, h, z: zTop.current, min: false, snap: null, born: Date.now()}
			setWins((ws) => [...ws, win])
		},
		[focus, update],
	)

	// Starting a stopped machine from its icon: start it, then open the console once it's running.
	useEffect(() => {
		if (!starting.length) return
		const ready = starting.filter((id) => machineList.find((m) => m.id === id)?.state === 'running')
		if (ready.length) {
			setStarting((s) => s.filter((id) => !ready.includes(id)))
			ready.forEach((id) => open('console', {machineId: id}))
		}
	}, [machineList, starting, open])
	useEffect(() => {
		if (!starting.length) return
		const t = window.setInterval(() => qc.invalidateQueries({queryKey: ['machines.list']}), 3000)
		return () => window.clearInterval(t)
	}, [starting.length, qc])

	// Which apps must open in a browser tab (they refuse to be shown inside a window).
	const runningAppIds = useMemo(() => appList.filter((a) => a.port && (a.state === 'ready' || a.state === 'running')).map((a) => a.id), [appList])
	const frames = useAppFrame(runningAppIds)
	const framesRef = useRef(frames.data)
	framesRef.current = frames.data
	const cfgRef = useRef(cfg)
	cfgRef.current = cfg

	const api = useMemo<DesktopApi>(() => {
		const launch = (app: UserApp) => {
			mutate('apps.trackOpen', {appId: app.id}).catch(() => {})
			const url = appUrl(app, boot.umbrel!.host)
			const verdict = framesRef.current?.results[app.id]
			if (url && (cfgRef.current.appsOpenIn === 'tab' || app.requiresHttps || verdict === 'tab')) {
				// Same as the umbrelOS dashboard: the app gets its own browser tab.
				setOverview(null)
				setMenu(null)
				window.open(url, '_blank', 'noopener')
				return
			}
			open('app', {appId: app.id})
		}
		const openConsole = (machineId: string) => open('console', {machineId})
		return {
			open,
			launch,
			openConsole,
			openTerminal: (term) => open('terminal', term ? {term} : undefined, {newWindow: true}),
			close,
			openItem: (key) => {
				if (isSys(key)) return key === 'terminal' ? open('terminal', undefined, {newWindow: !winsRef.current.some((w) => w.kind === 'terminal')}) : open(key)
				if (key.startsWith('folder:')) return open('files', {path: key.slice(7)}, {newWindow: true})
				if (key.startsWith('app:')) {
					const a = appList.find((x) => x.id === key.slice(4))
					if (a) launch(a)
					else toast('That app is no longer installed', true)
					return
				}
				if (key.startsWith('machine:')) {
					const id = key.slice(8)
					const m = machineList.find((x) => x.id === id)
					if (!m) return void toast('That machine no longer exists', true)
					if (m.state === 'running') return openConsole(id)
					if (m.state === 'stopped' || m.state === 'error' || m.state === 'suspended') {
						mutate('machines.start', {id})
							.then(() => {
								toast(`Starting ${m.name}. Its console opens when it’s ready.`)
								setStarting((s) => [...new Set([...s, id])])
							})
							.catch((e) => toast((e as Error).message, true))
						return
					}
					toast(`${m.name} is ${m.state}. Try again in a moment.`)
				}
			},
			addIcon: (key, at) =>
				setCfg((c) => {
					if (c.icons.some((i) => i.key === key)) return c
					const cell = freeCell(c.icons, at ? cellAt(at.x, at.y) : undefined)
					return {...c, showIcons: true, icons: [...c.icons, {key, ...cell}]}
				}),
			removeIcon: (key) => setCfg((c) => ({...c, icons: c.icons.filter((i) => i.key !== key)})),
			pin: (key) => setCfg((c) => (c.dock.items.includes(key) ? c : {...c, dock: {...c.dock, items: [...c.dock.items, key]}})),
			unpin: (key) => setCfg((c) => ({...c, dock: {...c.dock, items: c.dock.items.filter((k) => k !== key)}})),
		}
	}, [open, close, appList, machineList, setCfg, toast, boot.umbrel])

	// Clicking into an app's iframe doesn't reach our handlers; notice the focus moving to it.
	useEffect(() => {
		const onBlur = () =>
			window.setTimeout(() => {
				const el = document.activeElement
				if (el?.tagName === 'IFRAME') {
					const id = (el.closest('.win') as HTMLElement | null)?.dataset.id
					if (id) focus(id)
				}
			}, 0)
		window.addEventListener('blur', onBlur)
		return () => window.removeEventListener('blur', onBlur)
	}, [focus])

	// Keyboard: Super taps toggle Activities, Ctrl+Alt+T opens a terminal, Escape leaves menus.
	useEffect(() => {
		let superAlone = false
		const down = (e: KeyboardEvent) => {
			superAlone = e.key === 'Meta' || e.key === 'OS'
			if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 't' && owner) {
				e.preventDefault()
				api.openTerminal()
			}
			if (e.key === 'Escape') {
				setMenu(null)
				setTopMenu(null)
				setOverview(null)
			}
		}
		const up = (e: KeyboardEvent) => {
			if ((e.key === 'Meta' || e.key === 'OS') && superAlone) setOverview((o) => (o ? null : 'windows'))
			superAlone = false
		}
		window.addEventListener('keydown', down)
		window.addEventListener('keyup', up)
		return () => {
			window.removeEventListener('keydown', down)
			window.removeEventListener('keyup', up)
		}
	}, [api, owner])

	// -- dock --
	const pinned = cfg.dock.items.filter((k) => !info(k).missing)
	const runningKeys = [...new Set(wins.map(itemOfWin))]
	const dockKeys = [...pinned, ...(cfg.dock.showRunning ? runningKeys.filter((k) => !pinned.includes(k)) : [])]
	const winsOf = (key: string) => wins.filter((w) => itemOfWin(w) === key)
	const dockClick = (key: string) => {
		setMenu(null)
		setOverview(null)
		const mine = winsOf(key)
		if (!mine.length || key.startsWith('folder:')) return api.openItem(key)
		const top = mine.reduce((a, b) => (b.z > a.z ? b : a))
		if (active && itemOfWin(active) === key && !top.min) mine.forEach((w) => minimize(w.id))
		else [...mine].sort((a, b) => a.z - b.z).forEach((w) => focus(w.id))
	}
	const itemMenu = (key: string, x: number, y: number, where: 'dock' | 'desktop' | 'overview') => {
		const it = info(key)
		const app = key.startsWith('app:') ? appList.find((a) => a.id === key.slice(4)) : undefined
		const machine = key.startsWith('machine:') ? machineList.find((m) => m.id === key.slice(8)) : undefined
		const mine = winsOf(key)
		const items: MenuItem[] = [{label: mine.length && where === 'dock' && !key.startsWith('folder:') ? 'Show' : 'Open', icon: 'open', onClick: () => (mine.length && where === 'dock' ? dockClick(key) : api.openItem(key))}]
		if (key === 'files' || key === 'terminal') items.push({label: 'New window', icon: 'plus', onClick: () => (key === 'terminal' ? api.openTerminal() : open('files', undefined, {newWindow: true}))})
		if (app && appUrl(app, boot.umbrel!.host)) items.push({label: 'Open in a browser tab', icon: 'open', onClick: () => window.open(appUrl(app, boot.umbrel!.host)!, '_blank', 'noopener')})
		if (machine && machine.state === 'running')
			items.push({
				label: 'Shut down',
				icon: 'power',
				onClick: async () => {
					if (await confirm({title: `Shut down ${machine.name}?`, body: 'The machine is asked to shut down, like pressing its power button.', confirm: 'Shut down', icon: 'power'}))
						mutate('machines.stop', {id: machine.id}).then(
							() => toast(`${machine.name} is shutting down`),
							(e) => toast((e as Error).message, true),
						)
				},
			})
		items.push('sep')
		items.push(cfg.dock.items.includes(key) ? {label: 'Remove from dock', icon: 'close', onClick: () => api.unpin(key)} : {label: 'Pin to dock', icon: 'star', onClick: () => api.pin(key)})
		items.push(cfg.icons.some((i) => i.key === key) ? {label: 'Remove from desktop', icon: 'close', onClick: () => api.removeIcon(key)} : {label: 'Add to desktop', icon: 'plus', onClick: () => api.addIcon(key)})
		if (mine.length && !key.startsWith('folder:'))
			items.push('sep', {label: mine.length > 1 ? `Close ${mine.length} windows` : 'Close window', icon: 'close', danger: true, onClick: () => mine.forEach((w) => close(w.id))})
		setMenu({x, y, title: it.label, items})
	}

	const power = async (kind: 'restart' | 'shutdown') => {
		setTopMenu(null)
		const ok = await confirm({
			title: kind === 'restart' ? 'Restart your Umbrel?' : 'Shut down your Umbrel?',
			body:
				kind === 'restart'
					? 'All apps and machines stop, then come back once umbrelOS has restarted. This takes a few minutes.'
					: 'All apps and machines stop. You’ll need to turn the Umbrel back on yourself (for a VM, from FygoNAS).',
			confirm: kind === 'restart' ? 'Restart' : 'Shut down',
			danger: true,
			icon: kind === 'restart' ? 'restart' : 'power',
		})
		if (!ok) return
		try {
			await mutate(`system.${kind}`)
			toast(kind === 'restart' ? 'Your Umbrel is restarting' : 'Your Umbrel is shutting down')
		} catch (e) {
			toast((e as Error).message, true)
		}
	}
	const signOut = async () => {
		setTopMenu(null)
		if (!(await confirm({title: 'Sign out?', body: 'This browser is signed out and removed from your Umbrel’s devices.', confirm: 'Sign out', icon: 'signout'}))) return
		await logout().catch(() => {})
		qc.clear()
		onSignedOut()
	}

	// -- wallpaper + accent for the desktop (scoped to the desktop; the phone keeps its own) --
	const wp = WALLPAPERS.find((w) => w.id === cfg.wallpaper)
	const wallUrl = wp ? wallpaperSrc(wp.id) : cfg.wallpaper === 'photo' ? (customBackgroundUrl(prefs.backgroundVersion) ?? wallpaperUrl(user.data?.wallpaper)) : null
	const deskStyle: Record<string, string> = {'--dock-thick': `${thick}px`, '--dock-icon': `${DOCK_ICON[cfg.dock.size]}px`}
	if (cfg.accent === 'wallpaper' && wp) {
		const [h, s] = wp.hsl.split(' ').map((v) => parseFloat(v))
		Object.assign(deskStyle, {'--accent': `hsl(${h} ${s}% 52%)`, '--accent-text': `hsl(${h} ${Math.min(s + 10, 95)}% 68%)`, '--on-accent': '#fff'})
	} else if (cfg.accent !== 'app' && cfg.accent !== 'wallpaper') {
		Object.assign(deskStyle, {'--accent': `var(--${cfg.accent})`, '--accent-text': `var(--${cfg.accent})`, '--on-accent': '#111'})
	}

	const arrangeIcons = () =>
		setCfg((c) => {
			const {rows} = gridSize()
			const sorted = [...c.icons].sort((a, b) => {
				const fa = a.key.startsWith('folder:') ? 0 : 1
				const fb = b.key.startsWith('folder:') ? 0 : 1
				return fa - fb || info(a.key).label.localeCompare(info(b.key).label)
			})
			return {...c, icons: sorted.map((i, n) => ({...i, col: Math.floor(n / rows), row: n % rows}))}
		})
	const desktopMenu = (x: number, y: number) =>
		setMenu({
			x,
			y,
			items: [
				{label: 'Add icons to the desktop…', icon: 'plus', onClick: () => open('personalize', {tab: 'desktop'})},
				{label: 'Arrange icons by name', icon: 'sort', onClick: arrangeIcons},
				{label: cfg.showIcons ? 'Hide desktop icons' : 'Show desktop icons', icon: 'grid', onClick: () => setCfg((c) => ({...c, showIcons: !c.showIcons}))},
				'sep',
				{label: 'Open Home folder', icon: 'folder', onClick: () => api.openItem('folder:/Home')},
				...(owner ? [{label: 'Open Terminal', icon: 'terminal' as IconName, onClick: () => api.openTerminal()}] : []),
				'sep',
				{label: 'Change background…', icon: 'image', onClick: () => open('personalize', {tab: 'background'})},
				{label: 'Desktop themes…', icon: 'palette', onClick: () => open('personalize', {tab: 'themes'})},
				{label: 'Dock settings…', icon: 'apps', onClick: () => open('personalize', {tab: 'dock'})},
			],
		})

	return (
		<DesktopContext.Provider value={api}>
			<div
				className={`desk style-${cfg.style} dock-${cfg.dock.position}${cfg.dock.floating ? ' dock-floating' : ''}${cfg.dock.autohide ? ' dock-autohide' : ''}${dragging ? ' dragging' : ''}${overview ? ` overview-on ov-${overview}` : ''}`}
				style={deskStyle as CSSProperties}
			>
				{wallUrl && <Wall url={wallUrl} />}
				<TopBar
					boot={boot}
					activeTitle={active ? winTitle(active, appList, machineList) : null}
					overview={!!overview}
					menu={topMenu}
					setMenu={setTopMenu}
					toggleOverview={() => setOverview((o) => (o ? null : 'windows'))}
					onPower={power}
					onSignOut={signOut}
					onSettings={() => open('settings')}
					onSystem={() => open('system')}
					onPersonalize={() => open('personalize')}
				/>

				<DesktopIcons
					cfg={cfg}
					setCfg={setCfg}
					info={info}
					onOpen={api.openItem}
					onItemMenu={(key, x, y) => itemMenu(key, x, y, 'desktop')}
					onDesktopMenu={desktopMenu}
					onBackgroundClick={() => {
						setMenu(null)
						setTopMenu(null)
					}}
					empty={wins.length === 0}
					deviceName={boot.umbrel?.device ?? 'Umbrel'}
				/>

				{wins.map((w) => (
					<WindowFrame
						key={w.id}
						win={w}
						active={active?.id === w.id}
						overviewSlot={overview === 'windows' ? overviewSlot(w, visible) : null}
						title={winTitle(w, appList, machineList)}
						appList={appList}
						machineList={machineList}
						onFocus={focus}
						onUpdate={update}
						onClose={close}
						onMinimize={minimize}
						onPreview={setPreview}
						onDragging={setDragging}
						onOverviewPick={(id) => {
							focus(id)
							setOverview(null)
						}}
					>
						<WindowContent win={w} prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} owner={owner} />
					</WindowFrame>
				))}

				{preview && <div className="snap-preview" style={{left: preview.x, top: preview.y, width: preview.w, height: preview.h}} />}

				<Dock
					cfg={cfg}
					keys={dockKeys}
					info={info}
					counts={(k) => winsOf(k).length}
					focusedKey={active ? itemOfWin(active) : null}
					showAppsOn={overview === 'apps'}
					forceShow={!!overview || !!menu || wins.every((w) => w.min)}
					onClick={dockClick}
					onMenu={(k, x, y) => itemMenu(k, x, y, 'dock')}
					onShowApps={() => setOverview((o) => (o === 'apps' ? null : 'apps'))}
					onReorder={(keys) => setCfg((c) => ({...c, dock: {...c.dock, items: keys}}))}
					onDropToDesktop={(k, x, y) => api.addIcon(k, {x, y})}
					onDockMenu={(x, y) =>
						setMenu({
							x,
							y,
							title: 'Dock',
							items: [
								{label: 'Dock settings…', icon: 'settings', onClick: () => open('personalize', {tab: 'dock'})},
								{label: cfg.dock.autohide ? 'Always show the dock' : 'Auto-hide the dock', icon: 'apps', onClick: () => setCfg((c) => ({...c, dock: {...c.dock, autohide: !c.dock.autohide}}))},
							],
						})
					}
				/>

				{overview && (
					<Overview
						mode={overview}
						setMode={setOverview}
						info={info}
						appList={appList}
						machineList={machineList}
						owner={owner}
						hasWindows={visible.length > 0}
						onOpen={(key) => api.openItem(key)}
						onMenu={(k, x, y) => itemMenu(k, x, y, 'overview')}
					/>
				)}

				{menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
			</div>
		</DesktopContext.Provider>
	)
}

function Wall({url}: {url: string}) {
	const [layers, setLayers] = useState<string[]>([])
	useEffect(() => {
		const img = new Image()
		img.onload = () => setLayers((l) => [...l.filter((x) => x !== url).slice(-1), url])
		img.src = url
	}, [url])
	return (
		<div className="desk-wall" aria-hidden="true">
			{layers.map((u, i) => (
				<div key={u} className={`wall-layer${i === layers.length - 1 ? ' in' : ''}`} style={{backgroundImage: `url(${u})`}} />
			))}
		</div>
	)
}

function ContextMenu({menu, onClose}: {menu: Menu; onClose: () => void}) {
	const ref = useRef<HTMLDivElement>(null)
	const [pos, setPos] = useState({x: menu.x, y: menu.y})
	useEffect(() => {
		const el = ref.current
		if (!el) return
		const r = el.getBoundingClientRect()
		setPos({x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)), y: Math.max(TOP + 4, Math.min(menu.y, window.innerHeight - r.height - 8))})
	}, [menu])
	const items = menu.items.filter((it, i, all) => it !== 'sep' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'sep'))
	return (
		<>
			<button className="menu-scrim" aria-label="Close menu" onClick={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />
			<div ref={ref} className="ctx-menu" style={{left: pos.x, top: pos.y}} role="menu">
				{menu.title && <b className="ctx-title">{menu.title}</b>}
				{items.map((it, i) =>
					it === 'sep' ? (
						<hr key={i} />
					) : (
						<button
							key={i}
							role="menuitem"
							className={it.danger ? 'danger' : undefined}
							disabled={it.disabled}
							onClick={() => {
								onClose()
								it.onClick()
							}}
						>
							{it.icon && <Icon name={it.icon} size={16} />}
							{it.label}
						</button>
					),
				)}
			</div>
		</>
	)
}

// ---- tooltips (rendered at the top level so nothing can clip them) -------------------------------------
function useTooltip() {
	const [tip, setTip] = useState<{label: string; x: number; y: number; side: 'right' | 'left' | 'top'} | null>(null)
	const t = useRef<number>()
	const showing = useRef(false)
	const show = (label: string, el: HTMLElement, side: 'right' | 'left' | 'top') => {
		window.clearTimeout(t.current)
		const r = el.getBoundingClientRect()
		const pos = side === 'right' ? {x: r.right + 10, y: r.top + r.height / 2} : side === 'left' ? {x: r.left - 10, y: r.top + r.height / 2} : {x: r.left + r.width / 2, y: r.top - 8}
		// The first tooltip waits a moment; moving along the dock then switches instantly.
		t.current = window.setTimeout(
			() => {
				showing.current = true
				setTip({label, ...pos, side})
			},
			showing.current ? 0 : 250,
		)
	}
	const hide = () => {
		window.clearTimeout(t.current)
		setTip(null)
		t.current = window.setTimeout(() => (showing.current = false), 300)
	}
	const node = tip
		? createPortal(
				<div className={`dock-tip tip-${tip.side}`} style={{left: tip.x, top: tip.y}} role="tooltip">
					{tip.label}
				</div>,
				document.body,
			)
		: null
	return {show, hide, node}
}

// ---- dock ------------------------------------------------------------------------------------------
function Dock(p: {
	cfg: DeskConfig
	keys: string[]
	info: (k: string) => ItemInfo
	counts: (k: string) => number
	focusedKey: string | null
	showAppsOn: boolean
	forceShow: boolean
	onClick: (k: string) => void
	onMenu: (k: string, x: number, y: number) => void
	onShowApps: () => void
	onReorder: (keys: string[]) => void
	onDropToDesktop: (k: string, x: number, y: number) => void
	onDockMenu: (x: number, y: number) => void
}) {
	const pos = p.cfg.dock.position
	const vertical = pos !== 'bottom'
	const side = pos === 'left' ? 'right' : pos === 'right' ? 'left' : 'top'
	const tip = useTooltip()
	const ref = useRef<HTMLElement>(null)
	const [drag, setDrag] = useState<{key: string; x: number; y: number; order: string[]; outside: boolean} | null>(null)
	const [hover, setHover] = useState(false)
	const suppressClick = useRef(false)
	const size = DOCK_ICON[p.cfg.dock.size]

	const isOutside = (x: number, y: number) => {
		const r = ref.current!.getBoundingClientRect()
		return x < r.left - 40 || x > r.right + 40 || y < r.top - 40 || y > r.bottom + 40
	}
	// Drag to reorder (the dragged item becomes pinned there), or out onto the desktop to add an icon.
	const startDrag = (key: string) => (e: React.PointerEvent) => {
		if (e.button !== 0) return
		const start = {x: e.clientX, y: e.clientY}
		let moved = false
		let order = [...p.keys]
		const move = (ev: PointerEvent) => {
			if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return
			if (!moved) {
				moved = true
				tip.hide()
			}
			const outside = isOutside(ev.clientX, ev.clientY)
			if (!outside) {
				const els = [...ref.current!.querySelectorAll<HTMLElement>('.dock-item[data-key]')].filter((x) => x.dataset.key !== key)
				const along = vertical ? ev.clientY : ev.clientX
				let idx = els.findIndex((x) => {
					const r = x.getBoundingClientRect()
					return along < (vertical ? r.top + r.height / 2 : r.left + r.width / 2)
				})
				if (idx < 0) idx = els.length
				const rest = els.map((x) => x.dataset.key!)
				order = [...rest.slice(0, idx), key, ...rest.slice(idx)]
			}
			setDrag({key, x: ev.clientX, y: ev.clientY, order, outside})
		}
		const up = (ev: PointerEvent) => {
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', up)
			setDrag(null)
			if (!moved) return
			suppressClick.current = true
			window.setTimeout(() => (suppressClick.current = false), 50)
			if (isOutside(ev.clientX, ev.clientY)) {
				const under = document.elementFromPoint(ev.clientX, ev.clientY)
				if (under?.closest('.desk-surface')) p.onDropToDesktop(key, ev.clientX, ev.clientY)
				return
			}
			const pinnedNow = new Set([...p.cfg.dock.items, key])
			p.onReorder(order.filter((k) => pinnedNow.has(k)))
		}
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)
	}

	const keys = drag && !drag.outside ? drag.order : p.keys
	const hidden = p.cfg.dock.autohide && !hover && !p.forceShow && !drag
	return (
		<>
			{p.cfg.dock.autohide && <div className={`dock-hotzone hz-${pos}`} onPointerEnter={() => setHover(true)} />}
			<nav
				ref={ref}
				className={`desk-dock${hidden ? ' hidden' : ''}`}
				aria-label="Dock"
				onPointerEnter={() => setHover(true)}
				onPointerLeave={() => setHover(false)}
				onContextMenu={(e) => {
					if ((e.target as HTMLElement).closest('.dock-item')) return
					e.preventDefault()
					p.onDockMenu(e.clientX + 4, e.clientY)
				}}
			>
				<div className="dock-apps">
					{keys.map((k, i) => {
						const it = p.info(k)
						const pinned = p.cfg.dock.items.includes(k)
						const prevPinned = i > 0 && p.cfg.dock.items.includes(keys[i - 1])
						const count = p.counts(k)
						return (
							<div key={k} className="dock-slot">
								{!pinned && prevPinned && <span className="dock-sep" />}
								<button
									data-key={k}
									className={`dock-item${p.focusedKey === k ? ' focused' : ''}${count ? ' running' : ''}${drag?.key === k ? ' dragging' : ''}`}
									aria-label={it.label}
									onPointerDown={startDrag(k)}
									onClick={() => !suppressClick.current && p.onClick(k)}
									onMouseEnter={(e) => tip.show(it.label + (it.status === 'stopped' ? ' · stopped' : ''), e.currentTarget, side)}
									onMouseLeave={tip.hide}
									onContextMenu={(e) => {
										e.preventDefault()
										tip.hide()
										p.onMenu(k, e.clientX + 6, e.clientY)
									}}
								>
									{count > 0 && (
										<span className="dots" aria-hidden="true">
											{Array.from({length: Math.min(count, 3)}, (_, n) => (
												<i key={n} />
											))}
										</span>
									)}
									<span className="dock-art">
										{it.icon(size)}
										{it.status === 'running' && k.startsWith('machine:') && <span className="state-dot running" />}
									</span>
								</button>
							</div>
						)
					})}
				</div>
				<button
					className={`dock-item show-apps-btn${p.showAppsOn ? ' focused' : ''}`}
					aria-label="Show Applications"
					onClick={p.onShowApps}
					onMouseEnter={(e) => tip.show('Show Applications', e.currentTarget, side)}
					onMouseLeave={tip.hide}
				>
					<span className="show-apps" style={{width: size, height: size}}>
						<Icon name="show-apps" size={size * 0.55} />
					</span>
				</button>
			</nav>
			{drag && (
				<div className={`dock-ghost${drag.outside ? ' out' : ''}`} style={{left: drag.x, top: drag.y}}>
					{p.info(drag.key).icon(size)}
					{drag.outside && <small>Add to desktop</small>}
				</div>
			)}
			{tip.node}
		</>
	)
}

// ---- desktop icons ----------------------------------------------------------------------------------
function DesktopIcons(p: {
	cfg: DeskConfig
	setCfg: (fn: (c: DeskConfig) => DeskConfig) => void
	info: (k: string) => ItemInfo
	onOpen: (k: string) => void
	onItemMenu: (k: string, x: number, y: number) => void
	onDesktopMenu: (x: number, y: number) => void
	onBackgroundClick: () => void
	empty: boolean
	deviceName: string
}) {
	const [sel, setSel] = useState<Set<string>>(new Set())
	const [band, setBand] = useState<Rect | null>(null)
	const [move, setMove] = useState<{dx: number; dy: number} | null>(null)
	const icons = p.cfg.showIcons ? p.cfg.icons.filter((i) => !p.info(i.key).missing) : []
	const o = gridOrigin()
	const posOf = (i: DeskIcon) => ({x: o.x + i.col * CELL_W, y: o.y + i.row * CELL_H})

	// Keyboard on the desktop itself (nothing else focused): open, remove, select all.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const ae = document.activeElement
			if (ae && ae !== document.body && !ae.closest('.desk-surface')) return
			if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault()
				setSel(new Set(icons.map((i) => i.key)))
				return
			}
			if (!sel.size) return
			if (e.key === 'Enter') sel.forEach((k) => p.onOpen(k))
			else if (e.key === 'Delete' || e.key === 'Backspace') {
				p.setCfg((c) => ({...c, icons: c.icons.filter((i) => !sel.has(i.key))}))
				setSel(new Set())
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	})

	// Drag on the empty desktop to select icons with a rubber band.
	const startBand = (e: React.PointerEvent) => {
		if (e.button !== 0 || (e.target as HTMLElement).closest('.desk-icon')) return
		p.onBackgroundClick()
		;(e.currentTarget as HTMLElement).focus({preventScroll: true})
		const start = {x: e.clientX, y: e.clientY}
		const base = e.ctrlKey || e.shiftKey ? new Set(sel) : new Set<string>()
		setSel(base)
		const mv = (ev: PointerEvent) => {
			const r = {x: Math.min(start.x, ev.clientX), y: Math.min(start.y, ev.clientY), w: Math.abs(ev.clientX - start.x), h: Math.abs(ev.clientY - start.y)}
			setBand(r)
			const hit = new Set(base)
			for (const i of icons) {
				const q = posOf(i)
				if (q.x + 8 < r.x + r.w && q.x + CELL_W - 8 > r.x && q.y + 4 < r.y + r.h && q.y + CELL_H - 8 > r.y) hit.add(i.key)
			}
			setSel(hit)
		}
		const up = () => {
			window.removeEventListener('pointermove', mv)
			window.removeEventListener('pointerup', up)
			setBand(null)
		}
		window.addEventListener('pointermove', mv)
		window.addEventListener('pointerup', up)
	}

	// Drag icons around; they snap to the grid and never land on each other.
	const startMove = (key: string) => (e: React.PointerEvent) => {
		if (e.button !== 0) return
		e.stopPropagation()
		p.onBackgroundClick()
		;(e.currentTarget.closest('.desk-surface') as HTMLElement | null)?.focus({preventScroll: true})
		if (e.ctrlKey || e.metaKey) {
			const next = new Set(sel)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			setSel(next)
			return
		}
		const group = sel.has(key) ? sel : new Set([key])
		if (!sel.has(key)) setSel(group)
		const start = {x: e.clientX, y: e.clientY}
		let moved = false
		const mv = (ev: PointerEvent) => {
			const dx = ev.clientX - start.x
			const dy = ev.clientY - start.y
			if (!moved && Math.hypot(dx, dy) < 5) return
			moved = true
			setMove({dx, dy})
		}
		const up = (ev: PointerEvent) => {
			window.removeEventListener('pointermove', mv)
			window.removeEventListener('pointerup', up)
			setMove(null)
			if (!moved) return
			const dx = ev.clientX - start.x
			const dy = ev.clientY - start.y
			p.setCfg((c) => {
				const moving = c.icons.filter((i) => group.has(i.key))
				let rest = c.icons.filter((i) => !group.has(i.key))
				for (const i of moving) {
					const q = posOf(i)
					const cell = freeCell(rest, cellAt(q.x + dx + CELL_W / 2, q.y + dy + CELL_H / 2))
					rest = [...rest, {...i, ...cell}]
				}
				return {...c, icons: rest}
			})
		}
		window.addEventListener('pointermove', mv)
		window.addEventListener('pointerup', up)
	}

	return (
		<div
			className="desk-surface"
			tabIndex={-1}
			onPointerDown={startBand}
			onContextMenu={(e) => {
				e.preventDefault()
				if ((e.target as HTMLElement).closest('.desk-icon')) return
				setSel(new Set())
				p.onDesktopMenu(e.clientX, e.clientY)
			}}
		>
			{p.empty && icons.length <= 2 && (
				<div className="desk-hint">
					<Icon name="info" size={16} />
					<span>
						<b>{p.deviceName}</b> · Right-click the desktop to add icons for apps, machines and folders.
					</span>
				</div>
			)}
			{icons.map((i) => {
				const it = p.info(i.key)
				const q = posOf(i)
				const selected = sel.has(i.key)
				const off = move && selected ? move : null
				return (
					<button
						key={i.key}
						className={`desk-icon${selected ? ' selected' : ''}${off ? ' moving' : ''}`}
						style={{left: q.x, top: q.y, transform: off ? `translate(${off.dx}px, ${off.dy}px)` : undefined}}
						onPointerDown={startMove(i.key)}
						onDoubleClick={() => p.onOpen(i.key)}
						onContextMenu={(e) => {
							e.preventDefault()
							e.stopPropagation()
							if (!sel.has(i.key)) setSel(new Set([i.key]))
							p.onItemMenu(i.key, e.clientX, e.clientY)
						}}
						title={it.status ? `${it.label} · ${it.status === 'running' ? 'running' : it.status === 'stopped' ? 'stopped' : 'busy'}` : it.label}
					>
						<span className="desk-icon-art">
							{it.icon(56)}
							{it.status && (i.key.startsWith('machine:') || i.key.startsWith('app:')) && <span className={`state-dot ${it.status}`} />}
						</span>
						<span className="desk-icon-label">{it.label}</span>
					</button>
				)
			})}
			{band && <div className="rubber-band" style={{left: band.x, top: band.y, width: band.w, height: band.h}} />}
		</div>
	)
}

// ---- top bar ----------------------------------------------------------------------------------------
function useClock() {
	const [now, setNow] = useState(() => new Date())
	useEffect(() => {
		const t = window.setInterval(() => setNow(new Date()), 15_000)
		return () => window.clearInterval(t)
	}, [])
	return now
}

const NOTIFICATION_TEXT: Record<string, string> = {
	'update-available': 'A new version of umbrelOS is available',
	migration: 'Your data migration finished',
}
const noteText = (n: string) => NOTIFICATION_TEXT[n] ?? n.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function TopBar(p: {
	boot: Bootstrap
	activeTitle: string | null
	overview: boolean
	menu: 'clock' | 'system' | null
	setMenu: (m: 'clock' | 'system' | null) => void
	toggleOverview: () => void
	onPower: (k: 'restart' | 'shutdown') => void
	onSignOut: () => void
	onSettings: () => void
	onSystem: () => void
	onPersonalize: () => void
}) {
	const now = useClock()
	const notes = useNotifications().data ?? []
	const updates = useUpdates().data ?? []
	const cpu = useCpu()
	const mem = useMemory()
	const user = useUser()
	const action = useAction()
	const cpuPct = cpu.data ? Math.round(cpu.data.totalUsed) : null
	const memPct = mem.data ? Math.round((mem.data.totalUsed / mem.data.size) * 100) : null
	return (
		<header className="desk-top">
			<div className="top-left">
				<button className={`activities${p.overview ? ' on' : ''}`} onClick={p.toggleOverview} aria-pressed={p.overview}>
					<span className="act-dots" aria-hidden="true">
						<i />
						<i />
						<i />
					</span>
					Activities
				</button>
				{p.activeTitle && !p.overview && <span className="top-title">{p.activeTitle}</span>}
			</div>
			<button className={`top-clock${p.menu === 'clock' ? ' on' : ''}`} onClick={() => p.setMenu(p.menu === 'clock' ? null : 'clock')}>
				{now.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'})}
				<b>{now.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})}</b>
				{notes.length + updates.length > 0 && <span className="note-dot" />}
			</button>
			<div className="top-right">
				{cpuPct !== null && (
					<span className="top-stat" title="CPU">
						<Icon name="cpu" size={15} />
						{cpuPct}%
					</span>
				)}
				{memPct !== null && (
					<span className="top-stat" title="Memory">
						<Icon name="memory" size={15} />
						{memPct}%
					</span>
				)}
				<button className={`top-sys${p.menu === 'system' ? ' on' : ''}`} onClick={() => p.setMenu(p.menu === 'system' ? null : 'system')} aria-label="System menu">
					<span className="dot live" />
					<Icon name="power" size={16} />
					<Icon name="chevron-down" size={13} />
				</button>
			</div>

			{p.menu && <button className="menu-scrim" aria-label="Close menu" onClick={() => p.setMenu(null)} />}
			{p.menu === 'clock' && (
				<div className="top-pop clock-pop" role="dialog" aria-label="Notifications and calendar">
					<div className="pop-notes">
						<h4>Notifications</h4>
						{notes.length === 0 && updates.length === 0 ? (
							<p className="muted pop-empty">
								<Icon name="bell" size={30} />
								No notifications
							</p>
						) : (
							<>
								{updates.length > 0 && (
									<div className="pop-note">
										<Icon name="download" size={18} />
										<span>
											{updates.length} app update{updates.length > 1 ? 's' : ''} available
										</span>
									</div>
								)}
								{notes.map((n) => (
									<div key={n} className="pop-note">
										<Icon name="bell" size={18} />
										<span>{noteText(n)}</span>
										<button className="icon-btn" aria-label="Dismiss" onClick={() => action.mutate({path: 'notifications.clear', input: n})}>
											<Icon name="close" size={14} stroke={2.2} />
										</button>
									</div>
								))}
							</>
						)}
					</div>
					<MiniCalendar now={now} />
				</div>
			)}
			{p.menu === 'system' && (
				<div className="top-pop sys-pop" role="menu">
					<div className="sys-head">
						<span className="dot live" />
						<span>
							<b>{p.boot.umbrel?.device ?? 'Umbrel'}</b>
							<span className="mono muted">{p.boot.umbrel?.host}</span>
						</span>
					</div>
					<div className="sys-user muted">Signed in as {user.data?.name ?? 'you'}</div>
					<button role="menuitem" onClick={() => (p.setMenu(null), p.onSettings())}>
						<Icon name="settings" size={17} /> Settings
					</button>
					<button role="menuitem" onClick={() => (p.setMenu(null), p.onPersonalize())}>
						<Icon name="palette" size={17} /> Desktop &amp; Dock
					</button>
					<button role="menuitem" onClick={() => (p.setMenu(null), p.onSystem())}>
						<Icon name="activity" size={17} /> System Monitor
					</button>
					<button role="menuitem" onClick={() => (p.setMenu(null), setLayoutPref('phone'))}>
						<Icon name="phone" size={17} /> Switch to phone layout
					</button>
					<hr />
					<button role="menuitem" onClick={p.onSignOut}>
						<Icon name="signout" size={17} /> Sign out
					</button>
					<button role="menuitem" onClick={() => p.onPower('restart')}>
						<Icon name="restart" size={17} /> Restart…
					</button>
					<button role="menuitem" className="danger" onClick={() => p.onPower('shutdown')}>
						<Icon name="power" size={17} /> Shut down…
					</button>
				</div>
			)}
		</header>
	)
}

function MiniCalendar({now}: {now: Date}) {
	const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1))
	const first = new Date(month.getFullYear(), month.getMonth(), 1)
	const start = (first.getDay() + 6) % 7 // weeks start Monday, like GNOME in most locales
	const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
	const cells = Array.from({length: Math.ceil((start + days) / 7) * 7}, (_, i) => i - start + 1)
	const today = (d: number) => d === now.getDate() && month.getMonth() === now.getMonth() && month.getFullYear() === now.getFullYear()
	return (
		<div className="pop-cal">
			<div className="cal-head">
				<b>{now.toLocaleDateString(undefined, {weekday: 'long'})}</b>
				<span>{now.toLocaleDateString(undefined, {month: 'long', day: 'numeric', year: 'numeric'})}</span>
			</div>
			<div className="cal-nav">
				<button className="icon-btn" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
					<Icon name="back" size={15} />
				</button>
				<b>{month.toLocaleDateString(undefined, {month: 'long', year: 'numeric'})}</b>
				<button className="icon-btn" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
					<Icon name="chevron" size={15} />
				</button>
			</div>
			<div className="cal-grid">
				{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
					<span key={i} className="cal-dow">
						{d}
					</span>
				))}
				{cells.map((d, i) => (
					<span key={i} className={`cal-day${d < 1 || d > days ? ' out' : ''}${today(d) ? ' today' : ''}`}>
						{d >= 1 && d <= days ? d : ''}
					</span>
				))}
			</div>
		</div>
	)
}

// ---- overview (Activities / Show Applications) -----------------------------------------------------------
function overviewSlot(w: Win, visible: Win[]) {
	if (w.min) return null
	const list = [...visible].sort((a, b) => a.born - b.born)
	const i = list.findIndex((x) => x.id === w.id)
	const n = list.length
	const a = area()
	const areaX = a.x + 40
	const areaY = a.y + 76
	const areaW = a.w - 80
	const areaH = a.h - 110
	const cols = Math.ceil(Math.sqrt((n * areaW) / areaH / 1.4))
	const rows = Math.ceil(n / cols)
	const cw = areaW / cols
	const ch = areaH / rows
	const r = rectOf(w)
	const s = Math.min(1, (cw - 36) / r.w, (ch - 44) / r.h)
	const col = i % cols
	const row = Math.floor(i / cols)
	const inRow = row === rows - 1 ? n - row * cols : cols
	const rowOffset = ((cols - inRow) * cw) / 2
	const cx = areaX + rowOffset + col * cw + cw / 2
	const cy = areaY + row * ch + ch / 2
	return `translate(${cx - (r.x + r.w / 2)}px, ${cy - (r.y + r.h / 2)}px) scale(${s})`
}

function Overview({
	mode,
	setMode,
	info,
	appList,
	machineList,
	owner,
	hasWindows,
	onOpen,
	onMenu,
}: {
	mode: 'windows' | 'apps'
	setMode: (m: null | 'windows' | 'apps') => void
	info: (k: string) => ItemInfo
	appList: UserApp[]
	machineList: Machine[]
	owner: boolean
	hasWindows: boolean
	onOpen: (key: string) => void
	onMenu: (key: string, x: number, y: number) => void
}) {
	const [q, setQ] = useState('')
	const ref = useRef<HTMLInputElement>(null)
	useEffect(() => ref.current?.focus(), [])
	const showApps = mode === 'apps' || q.trim() !== '' || !hasWindows
	const keys = [
		...SYSTEM_DOCK.filter((k) => k !== 'terminal' || owner),
		'personalize',
		...[...appList].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)).map((a) => `app:${a.id}`),
		...machineList.map((m) => `machine:${m.id}`),
	]
	const items = keys.map(info).filter((x) => !q.trim() || x.label.toLowerCase().includes(q.trim().toLowerCase()))
	return (
		<>
			<div className="ov-backdrop" onClick={() => setMode(null)} />
			<div className={`ov-layer${showApps ? ' apps' : ''}`} onClick={(e) => e.target === e.currentTarget && setMode(null)}>
				<div className="ov-search">
					<Icon name="search" size={18} />
					<input
						ref={ref}
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Type to search"
						aria-label="Search apps"
						onKeyDown={(e) => {
							if (e.key === 'Enter' && items[0]) onOpen(items[0].key)
						}}
					/>
				</div>
				{showApps && (
					<div className="ov-grid" onClick={(e) => e.target === e.currentTarget && setMode(null)}>
						{items.map((x) => (
							<button
								key={x.key}
								className="ov-app"
								onClick={() => onOpen(x.key)}
								onContextMenu={(e) => {
									e.preventDefault()
									onMenu(x.key, e.clientX, e.clientY)
								}}
							>
								<span className="desk-icon-art">
									{x.icon(72)}
									{x.status === 'running' && x.key.startsWith('machine:') && <span className="state-dot running" />}
								</span>
								<span>{x.label}</span>
							</button>
						))}
						{items.length === 0 && <p className="muted">Nothing matches “{q}”</p>}
					</div>
				)}
				{showApps && <p className="ov-tip">Right-click an app to pin it to the dock or add it to the desktop.</p>}
			</div>
		</>
	)
}

// ---- a window ------------------------------------------------------------------------------------
function winTitle(w: Win, appList: UserApp[], machineList: Machine[]) {
	if (w.kind === 'app') {
		const a = appList.find((x) => x.id === w.payload?.appId)
		return a?.name ?? w.payload?.appId ?? 'App'
	}
	if (w.kind === 'console') {
		const m = machineList.find((x) => x.id === w.payload?.machineId)
		return m ? `${m.name} — Console` : 'Console'
	}
	if (w.kind === 'terminal' && w.payload?.term) return `Terminal — ${w.payload.term.name ?? w.payload.term.id}`
	return SYS[w.kind].title
}

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function WindowFrame({
	win,
	overviewSlot,
	active,
	title,
	appList,
	machineList,
	onFocus,
	onUpdate,
	onClose,
	onMinimize,
	onPreview,
	onDragging,
	onOverviewPick,
	children,
}: {
	win: Win
	active: boolean
	overviewSlot: string | null
	title: string
	appList: UserApp[]
	machineList: Machine[]
	onFocus: (id: string) => void
	onUpdate: (id: string, patch: Partial<Win>) => void
	onClose: (id: string) => void
	onMinimize: (id: string) => void
	onPreview: (r: Rect | null) => void
	onDragging: (b: boolean) => void
	onOverviewPick: (id: string) => void
	children: ReactNode
}) {
	const el = useRef<HTMLDivElement>(null)
	const [portal, setPortal] = useState<HTMLDivElement | null>(null)
	const [reload, setReload] = useState(0)
	const r = rectOf(win)
	const app = win.kind === 'app' ? appList.find((a) => a.id === win.payload?.appId) : undefined
	const machine = win.kind === 'console' ? machineList.find((m) => m.id === win.payload?.machineId) : undefined
	const boot = useBootstrap()
	const url = app ? appUrl(app, boot.umbrel!.host) : null

	const toggleMax = () => onUpdate(win.id, {snap: win.snap ? null : 'max'})

	// Move: drag the title bar. Snap to the top edge to maximize, to a side to tile half the screen.
	const startMove = (e: React.PointerEvent) => {
		if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
		e.preventDefault() // no text selection while dragging a window
		window.getSelection()?.removeAllRanges()
		const node = el.current!
		const start = {px: e.clientX, py: e.clientY}
		let rect = {...r}
		let unsnapped = !win.snap
		let moved = false
		let snap: Snap = null
		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - start.px
			const dy = ev.clientY - start.py
			if (!moved && Math.hypot(dx, dy) < 4) return
			if (!moved) {
				moved = true
				onDragging(true)
			}
			if (!unsnapped) {
				// Pull a maximized/tiled window out: restore its size under the pointer.
				const ratio = (start.px - rect.x) / rect.w
				rect = {x: start.px - ratio * win.w, y: rect.y, w: win.w, h: win.h}
				unsnapped = true
				node.style.width = `${rect.w}px`
				node.style.height = `${rect.h}px`
			}
			const a = area()
			const x = rect.x + dx
			const y = Math.min(Math.max(a.y, rect.y + dy), window.innerHeight - 48)
			node.style.left = `${x}px`
			node.style.top = `${y}px`
			snap = ev.clientY <= TOP + 2 ? 'max' : ev.clientX <= a.x + 4 ? 'left' : ev.clientX >= a.x + a.w - 5 ? 'right' : null
			onPreview(snap ? snapRect(snap) : null)
		}
		const up = (ev: PointerEvent) => {
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', up)
			onPreview(null)
			onDragging(false)
			if (!moved) return
			const a = area()
			const x = rect.x + (ev.clientX - start.px)
			const y = Math.min(Math.max(a.y, rect.y + (ev.clientY - start.py)), window.innerHeight - 48)
			onUpdate(win.id, snap ? {snap, x, y, w: rect.w, h: rect.h} : {snap: null, x, y, w: rect.w, h: rect.h})
		}
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)
	}

	// Resize: any edge or corner.
	const startResize = (edge: Edge) => (e: React.PointerEvent) => {
		if (e.button !== 0) return
		e.preventDefault()
		e.stopPropagation()
		onFocus(win.id)
		const node = el.current!
		const start = {px: e.clientX, py: e.clientY, ...r}
		let next = {...r}
		onDragging(true)
		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - start.px
			const dy = ev.clientY - start.py
			let {x, y, w, h} = start
			if (edge.includes('e')) w = Math.max(MIN_W, start.w + dx)
			if (edge.includes('s')) h = Math.max(MIN_H, Math.min(start.h + dy, window.innerHeight - start.y))
			if (edge.includes('w')) {
				w = Math.max(MIN_W, start.w - dx)
				x = start.x + start.w - w
			}
			if (edge.includes('n')) {
				const ny = Math.max(TOP, start.y + dy)
				h = Math.max(MIN_H, start.h + (start.y - ny))
				y = start.y + start.h - h
			}
			next = {x, y, w, h}
			Object.assign(node.style, {left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`})
		}
		const up = () => {
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', up)
			onDragging(false)
			onUpdate(win.id, {snap: null, ...next})
		}
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)
	}

	const style: CSSProperties = {left: r.x, top: r.y, width: r.w, height: r.h, zIndex: win.z, transform: overviewSlot ?? undefined}
	return (
		<div
			ref={el}
			data-id={win.id}
			className={`win${active ? ' active' : ''}${win.snap ? ` snapped snap-${win.snap}` : ''}${win.min ? ' minimized' : ''}${overviewSlot ? ' in-overview' : ''}`}
			style={style}
			role="dialog"
			aria-label={title}
			onPointerDownCapture={() => onFocus(win.id)}
		>
			<div className="win-bar" onPointerDown={startMove} onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && toggleMax()}>
				<span className="win-ico">
					{app ? <AppIcon src={app.icon} name={title} size={20} /> : win.kind === 'console' ? <MachineIcon m={machine} size={20} /> : <SysIcon kind={win.kind} size={20} />}
				</span>
				<span className="win-title">{title}</span>
				<span className="win-tools">
					{win.kind === 'app' && (
						<>
							<button className="win-btn ghost" aria-label="Reload" data-tip="Reload" onClick={() => setReload((n) => n + 1)}>
								<Icon name="restart" size={15} />
							</button>
							{url && (
								<button className="win-btn ghost" aria-label="Open in a browser tab" data-tip="Open in a browser tab" onClick={() => window.open(url, '_blank', 'noopener')}>
									<Icon name="open" size={15} />
								</button>
							)}
						</>
					)}
					<button className="win-btn" aria-label="Minimize" data-tip="Minimize" onClick={() => onMinimize(win.id)}>
						<Icon name="win-min" size={14} stroke={2.4} />
					</button>
					<button className="win-btn" aria-label={win.snap === 'max' ? 'Restore' : 'Maximize'} data-tip={win.snap === 'max' ? 'Restore' : 'Maximize'} onClick={toggleMax}>
						<Icon name={win.snap === 'max' ? 'win-restore' : 'win-max'} size={13} stroke={2.4} />
					</button>
					<button className="win-btn close" aria-label="Close" data-tip="Close" onClick={() => onClose(win.id)}>
						<Icon name="close" size={14} stroke={2.6} />
					</button>
				</span>
			</div>
			<div className="win-body">
				<PortalRoot.Provider value={portal}>
					<InWindow.Provider value={true}>{portal && (win.kind === 'app' ? <AppFrame key={reload} app={app} url={url} onClose={() => onClose(win.id)} /> : children)}</InWindow.Provider>
				</PortalRoot.Provider>
				<div className="win-portal" ref={setPortal} />
			</div>
			{!win.snap && !overviewSlot && EDGES.map((edge) => <span key={edge} className={`win-edge e-${edge}`} onPointerDown={startResize(edge)} />)}
			{overviewSlot && <button className="win-pick" aria-label={`Switch to ${title}`} onClick={() => onOverviewPick(win.id)} />}
		</div>
	)
}

type Access = 'checking' | 'ok' | 'signin' | 'not-shared' | 'unknown'
const checkAccess = (appId: string): Promise<Access> =>
	fetch(`/api/app-access?app=${encodeURIComponent(appId)}`, {credentials: 'same-origin'})
		.then((r) => (r.ok ? r.json() : {state: 'unknown'}))
		.then((b) => (['ok', 'signin', 'not-shared'].includes(b?.state) ? b.state : 'unknown'))
		.catch(() => 'unknown' as const)

// An app through Touch's relay: ask for its address, check it's reachable, then show it.
function RelayedFrame({app}: {app: UserApp}) {
	const [src, setSrc] = useState<string | null>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [loaded, setLoaded] = useState(false)
	const [attempt, setAttempt] = useState(0)
	const name = app.name ?? app.id
	useEffect(() => {
		let alive = true
		setProblem(null)
		setSrc(null)
		fetch(`/api/app-open?app=${encodeURIComponent(app.id)}`, {credentials: 'same-origin'})
			.then(async (r) => {
				const b = await r.json().catch(() => null)
				if (!r.ok) throw new Error(b?.error?.message ?? 'Couldn’t open the app')
				return b as {url: string; ping: string}
			})
			.then(
				(b) =>
					new Promise<string>((resolve, reject) => {
						// Is the relay reachable from this browser (firewall, tunnel routes)?
						const img = new Image()
						const t = window.setTimeout(() => reject(new Error('unreachable')), 6000)
						img.onload = () => (window.clearTimeout(t), resolve(b.url))
						img.onerror = () => (window.clearTimeout(t), reject(new Error('unreachable')))
						img.src = `${b.ping}?${Date.now()}`
					}),
			)
			.then((url) => alive && setSrc(url))
			.catch((e: Error) => alive && setProblem(e.message))
		return () => {
			alive = false
		}
	}, [app.id, attempt])
	if (problem)
		return (
			<div className="win-empty app-gate">
				<AppIcon src={app.icon} name={name} size={64} dim />
				<b>Couldn’t reach {name}</b>
				<span>
					{problem === 'unreachable'
						? location.protocol === 'https:'
							? 'Touch’s address for this app didn’t answer. Check that your tunnel also routes the app addresses (TOUCH_APP_HOSTS) to Touch.'
							: 'Touch opens each app on a port of its own (7800 and up). If a firewall runs on this server, allow those ports.'
						: problem}
				</span>
				<div className="app-gate-actions">
					<button className="btn primary" onClick={() => setAttempt((n) => n + 1)}>
						<Icon name="restart" size={17} />
						Try again
					</button>
				</div>
			</div>
		)
	return (
		<>
			{(!src || !loaded) && (
				<div className="frame-loading">
					<AppIcon src={app.icon} name={name} size={64} />
					<span className="spinner" />
				</div>
			)}
			{src && (
				<iframe
					className="app-frame"
					src={src}
					title={name}
					onLoad={() => setLoaded(true)}
					allow="clipboard-read; clipboard-write; fullscreen; camera; microphone; display-capture"
					allowFullScreen
				/>
			)}
		</>
	)
}

// An Umbrel app in a window. umbrelOS asks each browser to sign in before it opens apps, and its
// sign-in page refuses to load inside another page, so that one step happens in a normal tab.
// The session it creates covers all of this browser's apps (7 days); the window then loads.
function AppFrame({app, url, onClose}: {app?: UserApp; url: string | null; onClose: () => void}) {
	const [loaded, setLoaded] = useState(false)
	const qc = useQueryClient()
	const [access, setAccess] = useState<Access>('checking')
	const [waiting, setWaiting] = useState(false)
	// How this app opens: through Touch's relay (in a window, signed in by Touch) or directly.
	const frame = useAppFrame(app ? [app.id] : [])
	const relayed = !!app && !!frame.data?.relay[app.id]
	const touchSignsIn = relayed && !!frame.data?.sso
	const appId = app?.id
	useEffect(() => {
		if (!appId || frame.isLoading || touchSignsIn) return
		let alive = true
		checkAccess(appId).then((s) => alive && setAccess(s))
		return () => {
			alive = false
		}
	}, [appId, frame.isLoading, touchSignsIn])
	// While the sign-in tab is open: check again every couple of seconds and on returning here.
	useEffect(() => {
		if (!waiting || !appId) return
		let alive = true
		const again = () =>
			checkAccess(appId).then((s) => {
				if (!alive) return
				if (s === 'ok' || s === 'not-shared') {
					setAccess(s)
					setWaiting(false)
				}
			})
		const t = window.setInterval(again, 2000)
		window.addEventListener('focus', again)
		return () => {
			alive = false
			window.clearInterval(t)
			window.removeEventListener('focus', again)
		}
	}, [waiting, appId])

	if (!app) return <div className="win-empty">This app is no longer installed.</div>
	if (!url) return <div className="win-empty">{app.name ?? app.id} doesn’t have a web interface.</div>
	const name = app.name ?? app.id
	if (app.state && app.state !== 'ready' && app.state !== 'running')
		return (
			<div className="win-empty">
				<AppIcon src={app.icon} name={app.name} size={64} dim />
				<b>{name} isn’t running</b>
				<span>Start it from Apps, then reload this window.</span>
			</div>
		)
	if (app.requiresHttps)
		return (
			<div className="win-empty app-gate">
				<AppIcon src={app.icon} name={name} size={64} />
				<b>{name} opens in its own tab</b>
				<span>It needs a secure (HTTPS) connection with its own certificate, which can’t be shown inside a window.</span>
				<button className="btn primary" onClick={() => window.open(url, '_blank', 'noopener')}>
					<Icon name="open" size={17} />
					Open {name}
				</button>
			</div>
		)
	if (frame.isLoading || (!touchSignsIn && access === 'checking'))
		return (
			<div className="frame-loading">
				<AppIcon src={app.icon} name={name} size={64} />
				<span className="spinner" />
			</div>
		)
	if (touchSignsIn) return <RelayedFrame app={app} />
	if (frame.data?.remote && !relayed)
		return (
			<div className="win-empty app-gate">
				<AppIcon src={app.icon} name={name} size={64} />
				<b>Apps need their own addresses for remote access</b>
				<span>
					You’re using Touch over HTTPS (for example through a Cloudflare tunnel), where the app’s own port can’t be reached. Set TOUCH_APP_HOSTS (see the README) so each app
					gets an address like {name.toLowerCase().replace(/[^a-z0-9]+/g, '')}-touch.your-domain.
				</span>
			</div>
		)
	if (access === 'signin')
		return (
			<div className="win-empty app-gate">
				<AppIcon src={app.icon} name={name} size={64} />
				<b>{waiting ? 'Waiting for you to sign in…' : `Sign in to open ${name}`}</b>
				<span>
					{waiting
						? `Sign in to umbrelOS in the tab that opened. ${name} then loads here by itself; you can close that tab.`
						: 'umbrelOS asks each browser to sign in once before it opens your apps. Its sign-in page can’t be shown inside a window, so it opens in a new tab. Afterwards every app opens here for the next 7 days.'}
				</span>
				<div className="app-gate-actions">
					<button
						className="btn primary"
						onClick={() => {
							window.open(url, '_blank', 'noopener')
							setWaiting(true)
						}}
					>
						<Icon name="open" size={17} />
						{waiting ? 'Open sign-in again' : 'Sign in'}
					</button>
					{waiting && (
						<button className="btn" onClick={() => checkAccess(app.id).then((s) => (s === 'signin' ? undefined : (setAccess(s), setWaiting(false))))}>
							I’ve signed in
						</button>
					)}
				</div>
			</div>
		)
	if (relayed && access === 'ok') return <RelayedFrame app={app} />
	const verdict = access === 'ok' ? frame.data?.results[app.id] : undefined
	if (verdict === 'tab')
		return (
			<div className="win-empty app-gate">
				<AppIcon src={app.icon} name={name} size={64} />
				<b>{name} opens in a browser tab</b>
				<span>
					{name} doesn’t allow itself to be shown inside other pages (one of its own security settings), so it opens in its own tab, just like from the umbrelOS
					dashboard. From now on it goes straight there.
				</span>
				<div className="app-gate-actions">
					<button
						className="btn primary"
						onClick={() => {
							window.open(url, '_blank', 'noopener')
							qc.invalidateQueries({queryKey: ['app-frame']})
							onClose()
						}}
					>
						<Icon name="open" size={17} />
						Open {name}
					</button>
				</div>
			</div>
		)
	if (access === 'not-shared')
		return (
			<div className="win-empty app-gate">
				<AppIcon src={app.icon} name={name} size={64} dim />
				<b>{name} isn’t shared with you</b>
				<span>Ask the Umbrel’s owner to share it with your account in umbrelOS.</span>
			</div>
		)
	return (
		<>
			{!loaded && (
				<div className="frame-loading">
					<AppIcon src={app.icon} name={name} size={64} />
					<span className="spinner" />
				</div>
			)}
			<iframe
				className="app-frame"
				src={url}
				title={name}
				onLoad={() => setLoaded(true)}
				allow="clipboard-read; clipboard-write; fullscreen; camera; microphone; display-capture"
				allowFullScreen
			/>
		</>
	)
}

// ---- what goes inside a window ----------------------------------------------------------------------
const WindowContent = memo(
	function WindowContent({win, prefs, setPrefs, onSignedOut, owner}: {win: Win; prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void; owner: boolean}) {
		const desk = useDesktop()!
		const close = () => desk.close(win.id)
		const body = (() => {
			switch (win.kind) {
				case 'files':
					return <Files initialPath={win.payload?.path} />
				case 'apps':
					return <AppsWindow />
				case 'store':
					return <Store onOpenInstalled={(a) => desk.launch(a)} />
				case 'machines':
					return <Machines />
				case 'system':
					return <More prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} onSettings={() => desk.open('settings')} />
				case 'settings':
					return <Settings prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} onBack={close} />
				case 'personalize':
					return <Personalize tab={win.payload?.tab} prefs={prefs} setPrefs={setPrefs} />
				case 'terminal':
					return owner ? <TerminalScreen embedded app={win.payload?.term} onClose={close} /> : <div className="win-empty">Only the Umbrel’s owner can open a terminal.</div>
				case 'console':
					return <ConsoleWindow machineId={win.payload!.machineId!} onClose={close} />
				default:
					return null
			}
		})()
		if (win.kind === 'terminal' || win.kind === 'console') return body
		return (
			<div className="win-scroll">
				<main className="screen win-screen">{body}</main>
			</div>
		)
	},
	(a, b) => a.win.id === b.win.id && a.win.kind === b.win.kind && a.win.payload?.tab === b.win.payload?.tab && a.prefs === b.prefs && a.owner === b.owner,
)

function AppsWindow() {
	const desk = useDesktop()!
	const apps = useApps()
	const updates = useUpdates()
	const [appId, setAppId] = useState<string | null>(null)
	const app = apps.data?.find((a) => a.id === appId) ?? null
	const update = updates.data?.find((u) => u.id === appId)
	return (
		<>
			<Apps onOpenApp={(a) => setAppId(a.id)} onTerminal={() => desk.openTerminal()} onStore={() => desk.open('store')} />
			<AppSheet app={app} update={update} onClose={() => setAppId(null)} onTerminal={(t) => (setAppId(null), desk.openTerminal(t))} />
		</>
	)
}

function ConsoleWindow({machineId, onClose}: {machineId: string; onClose: () => void}) {
	const machines = useMachines()
	const m = machines.data?.find((x) => x.id === machineId)
	if (machines.isLoading)
		return (
			<div className="win-empty">
				<span className="spinner" />
			</div>
		)
	if (!m) return <div className="win-empty">This machine no longer exists.</div>
	if (m.state !== 'running')
		return (
			<div className="win-empty">
				<MachineIcon m={m} size={64} />
				<b>{m.name} isn’t running</b>
				<span>{m.state === 'starting' ? 'It’s starting. The console connects once it’s up.' : 'Start it from its desktop icon or from Machines.'}</span>
			</div>
		)
	return <Console embedded machine={m} onClose={onClose} />
}
