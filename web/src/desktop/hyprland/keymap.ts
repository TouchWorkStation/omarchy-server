export type Dir = 'left' | 'right' | 'up' | 'down'
export type Action =
	| {type: 'grab-toggle'}
	| {type: 'terminal'}
	| {type: 'files'}
	| {type: 'apps'}
	| {type: 'launcher'}
	| {type: 'system-menu'}
	| {type: 'cheatsheet'}
	| {type: 'close'}
	| {type: 'fullscreen'}
	| {type: 'float'}
	| {type: 'split'}
	| {type: 'focus'; dir: Dir}
	| {type: 'swap'; dir: Dir}
	| {type: 'workspace'; n: number}
	| {type: 'move-workspace'; n: number}
	| {type: 'workspace-next'}
	| {type: 'workspace-prev'}
	| {type: 'minimize'}
	| {type: 'restore'}

export type KeyLike = {
	code: string
	key: string
	metaKey: boolean
	altKey: boolean
	shiftKey: boolean
	ctrlKey: boolean
}

const ARROW: Record<string, Dir> = {ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down'}

export function isSuper(e: KeyLike): boolean {
	return e.metaKey || e.key === 'Meta' || e.key === 'OS'
}

export function actionOf(e: KeyLike, opts: {consoleFocused: boolean} = {consoleFocused: false}): Action | null {
	if (e.code === 'ScrollLock') return {type: 'grab-toggle'}
	const superHeld = isSuper(e)
	if (superHeld && e.code === 'F12') return {type: 'grab-toggle'}
	if (!superHeld) return null
	if (opts.consoleFocused) return null

	if (e.code === 'Enter' && !e.altKey && !e.shiftKey && !e.ctrlKey) return {type: 'terminal'}
	if (e.code === 'KeyF' && e.shiftKey && !e.altKey) return {type: 'files'}
	if (e.code === 'Space' && e.altKey && !e.shiftKey) return {type: 'apps'}
	if (e.code === 'Space' && !e.altKey && !e.shiftKey) return {type: 'launcher'}
	if (e.code === 'Escape' && !e.shiftKey) return {type: 'system-menu'}
	if (e.code === 'KeyK' && !e.shiftKey && !e.altKey) return {type: 'cheatsheet'}
	if ((e.code === 'KeyQ' || e.code === 'KeyW') && !e.shiftKey && !e.altKey) return {type: 'close'}
	if (e.code === 'KeyF' && !e.shiftKey && !e.altKey) return {type: 'fullscreen'}
	if (e.code === 'KeyT' && !e.shiftKey && !e.altKey) return {type: 'float'}
	if (e.code === 'KeyJ' && !e.shiftKey && !e.altKey) return {type: 'split'}
	if (e.code === 'KeyM' && !e.altKey) return {type: e.shiftKey ? 'restore' : 'minimize'}
	if (e.code === 'Tab') return {type: e.shiftKey ? 'workspace-prev' : 'workspace-next'}

	const dir = ARROW[e.code]
	if (dir) return e.shiftKey ? {type: 'swap', dir} : {type: 'focus', dir}

	const digit = e.code.match(/^Digit([1-9])$/)
	if (digit) {
		const n = Number(digit[1])
		return e.shiftKey ? {type: 'move-workspace', n} : {type: 'workspace', n}
	}
	return null
}

export type HyprKeyResult =
	| {kind: 'grab-toggle'}
	| {kind: 'console-forward'}
	| {kind: 'action'; action: Action}
	| null

// Decide whether a keydown in Hyprland mode runs a shortcut, grabs keys, or forwards to a focused console.
export function resolveHyprKey(e: KeyLike, opts: {consoleFocused: boolean} = {consoleFocused: false}): HyprKeyResult {
	const act = actionOf(e, opts)
	if (act?.type === 'grab-toggle') return {kind: 'grab-toggle'}
	if (opts.consoleFocused && isSuper(e) && !act) return {kind: 'console-forward'}
	if (act) return {kind: 'action', action: act}
	return null
}
