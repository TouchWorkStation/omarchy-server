// Desktop customization: wallpaper, desktop theme (chrome style + accent), dock layout and the
// icons on the desktop. Saved per device: a PC and a laptop can be set up differently, and the
// phone layout isn't affected at all.
import {useCallback, useEffect, useState} from 'react'

export const WALLPAPERS = [
	{id: 'valley', name: "Yosemite Valley", by: "Aniket Doele", hsl: '197 45% 55%'},
	{id: 'halfdome', name: "Half Dome at Night", by: "Pexels", hsl: '205 45% 55%'},
	{id: 'dolomites', name: "Dolomites", by: "Unsplash", hsl: '23 45% 55%'},
	{id: 'meadow', name: "Alpine Meadow", by: "Peter Thomas", hsl: '198 68% 55%'},
	{id: 'canyon', name: "Slot Canyon", by: "Ashim D'Silva", hsl: '19 71% 55%'},
	{id: 'surf', name: "Surf", by: "Nattu Adnan", hsl: '197 85% 55%'},
	{id: 'pier', name: "Pier at Dusk", by: "Unsplash", hsl: '10 62% 55%'},
	{id: 'fern', name: "Fern", by: "Unsplash", hsl: '139 45% 55%'},
	{id: 'dunes', name: "Dunes", by: "David Emrich", hsl: '32 45% 55%'},
	{id: 'orbit', name: "Orbit", by: "SpaceX", hsl: '200 85% 55%'},
	{id: 'dahlia', name: "Dahlia", by: "Tj Holowaychuk", hsl: '337 72% 55%'},
	{id: 'tower', name: "Tower", by: "Viktor Forgacs", hsl: '189 45% 55%'},
] as const
export type BuiltinWallpaper = (typeof WALLPAPERS)[number]['id']
// 'umbrel' = your umbrelOS wallpaper (what the phone shows); 'photo' = the photo you uploaded.
export type WallpaperId = BuiltinWallpaper | 'umbrel' | 'photo'
export const wallpaperSrc = (id: string, thumb = false) => `/wallpapers/${id}${thumb ? '-thumb' : ''}.jpg`

export type DeskStyle = 'yaru' | 'glass' | 'graphite' | 'daylight'
export const STYLES: {id: DeskStyle; name: string; note: string}[] = [
	{id: 'yaru', name: 'Yaru', note: 'Ubuntu’s look: solid dark panels'},
	{id: 'glass', name: 'Glass', note: 'Frosted, see-through panels'},
	{id: 'graphite', name: 'Graphite', note: 'Flat and crisp, no blur'},
	{id: 'daylight', name: 'Daylight', note: 'Light top bar, dock and menus'},
]
export type DeskAccent = 'app' | 'wallpaper' | 'blue' | 'mauve' | 'teal' | 'peach' | 'green' | 'pink'
export type DockPos = 'left' | 'bottom' | 'right'
export type DockSize = 'small' | 'medium' | 'large'
export type DeskIcon = {key: string; col: number; row: number}

export type DeskConfig = {
	v: 1
	preset: string | null
	wallpaper: WallpaperId
	style: DeskStyle
	accent: DeskAccent
	dock: {position: DockPos; size: DockSize; floating: boolean; autohide: boolean; showRunning: boolean; items: string[]}
	icons: DeskIcon[]
	showIcons: boolean
	// 'auto': a window when the app allows being shown inside one, otherwise a browser tab
	appsOpenIn: 'auto' | 'tab'
}

export const SYSTEM_DOCK = ['files', 'apps', 'store', 'terminal', 'machines', 'system', 'settings'] as const

export const PRESETS: {id: string; name: string; wallpaper: BuiltinWallpaper; style: DeskStyle; accent: DeskAccent}[] = [
	{id: 'ubuntu', name: 'Ubuntu', wallpaper: 'canyon', style: 'yaru', accent: 'peach'},
	{id: 'yosemite', name: 'Yosemite', wallpaper: 'valley', style: 'glass', accent: 'wallpaper'},
	{id: 'midnight', name: 'Midnight', wallpaper: 'halfdome', style: 'graphite', accent: 'blue'},
	{id: 'coast', name: 'Coast', wallpaper: 'surf', style: 'glass', accent: 'teal'},
	{id: 'dusk', name: 'Dusk', wallpaper: 'pier', style: 'glass', accent: 'mauve'},
	{id: 'forest', name: 'Forest', wallpaper: 'fern', style: 'graphite', accent: 'green'},
	{id: 'dolomites', name: 'Dolomites', wallpaper: 'dolomites', style: 'yaru', accent: 'wallpaper'},
	{id: 'alpine', name: 'Alpine', wallpaper: 'meadow', style: 'daylight', accent: 'blue'},
	{id: 'dunes', name: 'Dunes', wallpaper: 'dunes', style: 'daylight', accent: 'peach'},
	{id: 'orbit', name: 'Orbit', wallpaper: 'orbit', style: 'graphite', accent: 'blue'},
	{id: 'bloom', name: 'Bloom', wallpaper: 'dahlia', style: 'glass', accent: 'pink'},
	{id: 'skyline', name: 'Skyline', wallpaper: 'tower', style: 'daylight', accent: 'teal'},
]

const KEY = 'umbrel-touch:desktop-config'
export const DEFAULT_CONFIG: DeskConfig = {
	v: 1,
	preset: 'yosemite',
	wallpaper: 'valley',
	style: 'glass',
	accent: 'wallpaper',
	dock: {position: 'left', size: 'medium', floating: false, autohide: false, showRunning: true, items: [...SYSTEM_DOCK]},
	icons: [
		{key: 'folder:/Home', col: 0, row: 0},
		{key: 'folder:/Trash', col: 0, row: 1},
	],
	showIcons: true,
	appsOpenIn: 'auto',
}

function clean(raw: unknown): DeskConfig {
	const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<DeskConfig>
	const d = DEFAULT_CONFIG
	const dock = {...d.dock, ...(c.dock ?? {})}
	const okWall = (w: unknown): w is WallpaperId => w === 'umbrel' || w === 'photo' || WALLPAPERS.some((x) => x.id === w)
	// Pins from the first desktop release move into the dock.
	let legacyPins: string[] = []
	try {
		legacyPins = JSON.parse(localStorage.getItem('umbrel-touch:desktop-pins') ?? '[]').map((id: string) => `app:${id}`)
	} catch {
		/* none */
	}
	const items = Array.isArray(dock.items) ? dock.items.filter((k) => typeof k === 'string') : d.dock.items
	return {
		v: 1,
		preset: typeof c.preset === 'string' ? c.preset : null,
		wallpaper: okWall(c.wallpaper) ? c.wallpaper : d.wallpaper,
		style: STYLES.some((s) => s.id === c.style) ? (c.style as DeskStyle) : d.style,
		accent: (['app', 'wallpaper', 'blue', 'mauve', 'teal', 'peach', 'green', 'pink'] as const).includes(c.accent as DeskAccent) ? (c.accent as DeskAccent) : d.accent,
		dock: {
			position: (['left', 'bottom', 'right'] as const).includes(dock.position) ? dock.position : 'left',
			size: (['small', 'medium', 'large'] as const).includes(dock.size) ? dock.size : 'medium',
			floating: !!dock.floating,
			autohide: !!dock.autohide,
			showRunning: dock.showRunning !== false,
			items: [...new Set([...items, ...(c.dock ? [] : legacyPins)])],
		},
		icons: Array.isArray(c.icons) ? c.icons.filter((i) => i && typeof i.key === 'string' && Number.isInteger(i.col) && Number.isInteger(i.row)) : d.icons,
		showIcons: c.showIcons !== false,
		appsOpenIn: c.appsOpenIn === 'tab' ? 'tab' : 'auto',
	}
}

export function loadConfig(): DeskConfig {
	try {
		const raw = localStorage.getItem(KEY)
		return clean(raw ? JSON.parse(raw) : null)
	} catch {
		return DEFAULT_CONFIG
	}
}

// One shared, live config for the whole desktop (dock, icons and the settings window).
let current: DeskConfig | null = null
const listeners = new Set<(c: DeskConfig) => void>()
export function useDeskConfig() {
	const [cfg, setCfg] = useState<DeskConfig>(() => (current ??= loadConfig()))
	useEffect(() => {
		listeners.add(setCfg)
		return () => void listeners.delete(setCfg)
	}, [])
	const update = useCallback((fn: (c: DeskConfig) => DeskConfig) => {
		current = fn(current ?? loadConfig())
		try {
			localStorage.setItem(KEY, JSON.stringify(current))
		} catch {
			/* private mode: this visit only */
		}
		listeners.forEach((l) => l(current!))
	}, [])
	return [cfg, update] as const
}
