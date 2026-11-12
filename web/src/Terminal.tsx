// Full-screen terminal: a shell on the Umbrel, or inside one app's container.
// umbreld streams a PTY over a WebSocket (bridged by the Touch server). Its size is
// fixed when the shell starts, so on rotate we resize the font, not the shell.
import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {Terminal as XTerm} from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import {Icon} from './icons'
import {AppIcon, haptic, usePortalRoot, useToast} from './ui'

type State = 'connecting' | 'connected' | 'closed' | 'error'
const BASE_FONT = 13
const SEQ = {esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', ctrlC: '\x03'}

// Keep a fixed-position screen inside the area the phone keyboard leaves visible.
export function useVisualViewport(ref: React.RefObject<HTMLElement>, enabled = true) {
	useEffect(() => {
		const vv = window.visualViewport
		const el = ref.current
		if (!vv || !el || !enabled) return
		const apply = () => {
			el.style.top = `${vv.offsetTop}px`
			el.style.height = `${vv.height}px`
			el.style.bottom = 'auto'
			// The on-screen keyboard is up: drop the home-indicator padding under the key row.
			el.classList.toggle('kbd-open', window.innerHeight - vv.height > 120)
			el.dispatchEvent(new Event('viewportchange'))
		}
		apply()
		vv.addEventListener('resize', apply)
		vv.addEventListener('scroll', apply)
		return () => {
			vv.removeEventListener('resize', apply)
			vv.removeEventListener('scroll', apply)
		}
	}, [ref, enabled])
}

// Make a full-screen overlay behave like its own window on iPhone: freeze the page underneath
// (iOS ignores overflow:hidden on body and will scroll it to "reveal" a focused input), and
// stop drags outside the real scroll areas from panning the page while the keyboard is up.
export function useScreenLock(ref: React.RefObject<HTMLElement>, guardTouch = true, enabled = true) {
	useEffect(() => {
		if (!enabled) return
		const html = document.documentElement
		const b = document.body.style
		const y = window.scrollY
		const saved = {position: b.position, top: b.top, left: b.left, right: b.right, width: b.width, overflow: b.overflow}
		Object.assign(b, {position: 'fixed', top: `-${y}px`, left: '0', right: '0', width: '100%', overflow: 'hidden'})
		html.classList.add('screen-locked')
		const el = ref.current
		const scrollers = '.xterm-viewport, .console-keys, .term-paste textarea'
		const onMove = (e: TouchEvent) => {
			if (e.touches.length > 1) return void e.preventDefault() // no pinch-zoom of the page
			const t = e.target as Element | null
			if (t?.closest?.(scrollers)) return
			e.preventDefault()
		}
		if (guardTouch) el?.addEventListener('touchmove', onMove, {passive: false})
		// iOS can still pan the page after the keyboard opens; pull it back.
		const onScroll = () => window.scrollY && window.scrollTo(0, 0)
		window.addEventListener('scroll', onScroll)
		return () => {
			if (guardTouch) el?.removeEventListener('touchmove', onMove)
			window.removeEventListener('scroll', onScroll)
			Object.assign(b, saved)
			html.classList.remove('screen-locked')
			window.scrollTo(0, y)
		}
	}, [ref, guardTouch, enabled])
}

function cssVar(name: string, fallback: string) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export function TerminalScreen({app, onClose, embedded}: {app?: {id: string; name?: string; icon?: string}; onClose: () => void; embedded?: boolean}) {
	const portalRoot = usePortalRoot()
	const root = useRef<HTMLDivElement>(null)
	const host = useRef<HTMLDivElement>(null)
	const termRef = useRef<XTerm>()
	const wsRef = useRef<WebSocket>()
	const size = useRef({cols: 80, rows: 24, cellW: 7.8, font: BASE_FONT, ready: false})
	const [state, setState] = useState<State>('connecting')
	const [message, setMessage] = useState('')
	const [attempt, setAttempt] = useState(0)
	const [ctrl, setCtrl] = useState(false)
	const [alt, setAlt] = useState(false)
	const [kbd, setKbd] = useState(false)
	const [pasteBox, setPasteBox] = useState(false)
	const [pasteText, setPasteText] = useState('')
	const mods = useRef({ctrl: false, alt: false})
	mods.current = {ctrl, alt}
	const toast = useToast()
	useVisualViewport(root, !embedded)
	useScreenLock(root, true, !embedded)

	useEffect(() => {
		const el = host.current
		if (!el) return
		let disposed = false
		const term = new XTerm({
			fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
			fontSize: BASE_FONT,
			lineHeight: 1.15,
			cursorBlink: true,
			scrollback: 5000,
			allowProposedApi: false,
			macOptionIsMeta: true,
			theme: {
				background: '#0b0b0e',
				foreground: '#e6e6ea',
				cursor: cssVar('--accent-text', '#fb923c'),
				cursorAccent: '#0b0b0e',
				selectionBackground: 'rgba(255,255,255,.25)',
				black: '#1c1c22', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#2dd4bf', white: '#d4d4d8',
				brightBlack: '#52525b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#5eead4', brightWhite: '#ffffff',
			},
		})
		termRef.current = term
		term.open(el)

		// Measure a cell, then size the shell to fill the screen.
		const measure = () => {
			const dims = (term as any)._core?._renderService?.dimensions?.css?.cell
			const cellW = dims?.width || BASE_FONT * 0.6
			const cellH = dims?.height || BASE_FONT * 1.15 * 1.2
			const cols = Math.max(20, Math.min(240, Math.floor((el.clientWidth - 12) / cellW)))
			const rows = Math.max(8, Math.min(120, Math.floor((el.clientHeight - 8) / cellH)))
			return {cols, rows, cellW, font: term.options.fontSize ?? BASE_FONT, ready: true}
		}

		const send = (data: string) => {
			const ws = wsRef.current
			if (ws?.readyState === WebSocket.OPEN) ws.send(data)
		}
		term.onData((data) => {
			let out = data
			const m = mods.current
			if (m.ctrl && data.length === 1) {
				const c = data.toUpperCase().charCodeAt(0)
				if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64)
				setCtrl(false)
			}
			if (m.alt && data.length === 1) {
				out = `\x1b${out}`
				setAlt(false)
			}
			send(out)
		})
		const ta = term.textarea
		ta?.setAttribute('autocapitalize', 'off')
		ta?.setAttribute('autocorrect', 'off')
		ta?.setAttribute('spellcheck', 'false')
		const onFocus = () => {
			setKbd(true)
			term.scrollToBottom()
		}
		const onBlur = () => setKbd(false)
		ta?.addEventListener('focus', onFocus)
		ta?.addEventListener('blur', onBlur)

		const connect = async () => {
			setState('connecting')
			const check = await fetch('/api/console/check?target=terminal', {credentials: 'same-origin'}).catch(() => null)
			if (disposed) return
			if (!check?.ok) {
				const body = await check?.json().catch(() => null)
				setMessage(body?.error?.message ?? 'Can’t reach your Umbrel right now.')
				setState('error')
				return
			}
			term.options.fontSize = BASE_FONT
			await new Promise((r) => requestAnimationFrame(() => r(null)))
			if (disposed) return
			const s = measure()
			size.current = s
			term.resize(s.cols, s.rows)
			term.reset()
			const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
			const qs = new URLSearchParams({...(app ? {appId: app.id} : {}), cols: String(s.cols), rows: String(s.rows)})
			const ws = new WebSocket(`${scheme}//${location.host}/api/terminal?${qs}`)
			ws.binaryType = 'arraybuffer'
			wsRef.current = ws
			ws.onopen = () => {
				setState('connected')
				haptic(8)
				term.focus() // types straight away with a hardware keyboard; phones may still need the keyboard button
			}
			ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data))
			ws.onclose = () => {
				if (disposed) return
				setState((st) => (st === 'connecting' ? 'error' : 'closed'))
				setMessage('The shell has ended.')
			}
		}
		connect()

		// The shell's row count is fixed, so when the keyboard shrinks the screen the bottom rows
		// (where you type) would be cut off. Slide the terminal up just enough to keep the cursor
		// line in view; slide it back down when there's room again.
		const frame = el.parentElement!
		let raf = 0
		const follow = () => {
			cancelAnimationFrame(raf)
			raf = requestAnimationFrame(() => {
				const screen = el.querySelector<HTMLElement>('.xterm-screen')
				const buf = term.buffer.active
				if (!screen || !term.rows) return
				const rowH = screen.clientHeight / term.rows
				const atBottom = buf.viewportY === buf.baseY
				const cursorBottom = 6 + (buf.cursorY + 1) * rowH + 4
				const shift = atBottom ? Math.max(0, cursorBottom - frame.clientHeight) : 0
				el.style.transform = shift ? `translateY(${-Math.ceil(shift)}px)` : ''
				// Keep xterm's hidden input inside the visible area so iOS never scrolls to find it.
				el.style.setProperty('--term-shift', `${Math.ceil(shift)}px`)
				el.style.setProperty('--term-frame', `${frame.clientHeight}px`)
			})
		}
		term.onWriteParsed(follow)
		term.onCursorMove(follow)
		term.onScroll(follow)
		term.onRender(follow)

		// On rotate / keyboard, keep the shell's columns and scale the font to fit the width.
		const ro = new ResizeObserver(() => {
			const {cols, cellW, font, ready} = size.current
			if (!ready) return
			const fitted = Math.max(8, Math.min(20, (font * (el.clientWidth - 12)) / (cols * cellW)))
			if (Math.abs(fitted - (term.options.fontSize ?? BASE_FONT)) > 0.3) term.options.fontSize = Math.round(fitted * 2) / 2
			term.scrollToBottom()
			follow()
		})
		ro.observe(el)
		ro.observe(frame)
		const rootEl = root.current
		rootEl?.addEventListener('viewportchange', follow)

		return () => {
			disposed = true
			ro.disconnect()
			cancelAnimationFrame(raf)
			rootEl?.removeEventListener('viewportchange', follow)
			ta?.removeEventListener('focus', onFocus)
			ta?.removeEventListener('blur', onBlur)
			wsRef.current?.close()
			term.dispose()
		}
	}, [app, attempt])

	const sendSeq = (s: string) => {
		haptic(5)
		const ws = wsRef.current
		if (ws?.readyState === WebSocket.OPEN) ws.send(alt && s.length === 1 ? `\x1b${s}` : s)
		if (alt) setAlt(false)
	}
	const toggleKeyboard = () => {
		haptic(8)
		const term = termRef.current
		if (!term) return
		if (document.activeElement === term.textarea) term.blur()
		else term.focus()
	}
	// Reading the clipboard directly only works on HTTPS (and iPhone asks first). Otherwise,
	// open a small box the phone's own long-press → Paste works in, then send that.
	const paste = async () => {
		haptic(6)
		if (window.isSecureContext && navigator.clipboard?.readText) {
			try {
				const text = await navigator.clipboard.readText()
				if (text) {
					termRef.current?.paste(text)
					termRef.current?.focus()
				}
				return
			} catch {
				/* denied or unsupported: fall back to the paste box */
			}
		}
		setPasteText('')
		setPasteBox(true)
	}
	const sendPaste = () => {
		if (pasteText) {
			haptic(8)
			termRef.current?.paste(pasteText.replace(/\r?\n$/, ''))
			toast('Pasted')
		}
		setPasteBox(false)
		window.setTimeout(() => termRef.current?.focus(), 50)
	}
	const live = state === 'connected'
	const title = app ? (app.name ?? app.id) : 'Terminal'

	const keys: {label: string; onClick: () => void; on?: boolean}[] = [
		{label: 'esc', onClick: () => sendSeq(SEQ.esc)},
		{label: 'tab', onClick: () => sendSeq(SEQ.tab)},
		{label: 'ctrl', on: ctrl, onClick: () => (haptic(5), setCtrl((v) => !v))},
		{label: 'alt', on: alt, onClick: () => (haptic(5), setAlt((v) => !v))},
		{label: '^C', onClick: () => sendSeq(SEQ.ctrlC)},
		{label: '←', onClick: () => sendSeq(SEQ.left)},
		{label: '↑', onClick: () => sendSeq(SEQ.up)},
		{label: '↓', onClick: () => sendSeq(SEQ.down)},
		{label: '→', onClick: () => sendSeq(SEQ.right)},
		{label: '|', onClick: () => sendSeq('|')},
		{label: '~', onClick: () => sendSeq('~')},
		{label: '/', onClick: () => sendSeq('/')},
		{label: '-', onClick: () => sendSeq('-')},
		{label: 'home', onClick: () => sendSeq(SEQ.home)},
		{label: 'end', onClick: () => sendSeq(SEQ.end)},
	]

	return createPortal(
		<div ref={root} className={`console terminal${embedded ? ' embedded' : ''}`} role="dialog" aria-modal={!embedded} aria-label={`${title} terminal`}>
			<header className="console-bar">
				<button className="round-btn" aria-label="Close terminal" onClick={onClose}>
					<Icon name="back" size={20} />
				</button>
				{app ? (
					<AppIcon src={app.icon} name={title} size={34} />
				) : (
					<span className="term-badge">
						<Icon name="logs" size={19} />
					</span>
				)}
				<div className="console-title">
					<b>{title}</b>
					<span>
						<i className={`dot ${live ? 'live' : state === 'connecting' ? '' : 'down'}`} />
						{live ? (app ? 'App shell' : 'umbrelOS shell') : state === 'connecting' ? 'Connecting…' : 'Disconnected'}
					</span>
				</div>
				<button className="round-btn" aria-label="Paste" onClick={paste} disabled={!live}>
					<Icon name="clipboard" size={19} />
				</button>
			</header>
			<div className="term-screen" onClick={() => live && !kbd && termRef.current?.focus()}>
				<div ref={host} className="term-host" />
				{state !== 'connected' && state !== 'connecting' && (
					<div className="console-overlay">
						<Icon name={state === 'closed' ? 'logs' : 'alert'} size={34} />
						<b>{state === 'closed' ? 'Session ended' : 'Terminal unavailable'}</b>
						<span>{message}</span>
						<button className="btn primary small" onClick={() => setAttempt((a) => a + 1)}>
							{state === 'closed' ? 'New session' : 'Try again'}
						</button>
					</div>
				)}
			</div>
			{pasteBox && (
				<div className="term-paste" role="dialog" aria-label="Paste into terminal">
					<div className="term-paste-card">
						<div className="term-paste-head">
							<b>Paste</b>
							<span>Long-press in the box, tap Paste, then Send.</span>
						</div>
						<textarea
							autoFocus
							value={pasteText}
							onChange={(e) => setPasteText(e.target.value)}
							onPaste={(e) => {
								const t = e.clipboardData.getData('text')
								if (t) {
									e.preventDefault()
									setPasteText((v) => v + t)
								}
							}}
							placeholder="Paste here"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							rows={4}
						/>
						<div className="term-paste-actions">
							<button className="btn ghost" onClick={() => (setPasteBox(false), termRef.current?.focus())}>
								Cancel
							</button>
							<button className="btn primary" disabled={!pasteText} onClick={sendPaste}>
								Send to terminal
							</button>
						</div>
					</div>
				</div>
			)}
			<div className="console-dock">
				<button className={`kbd-btn${kbd ? ' on' : ''}`} aria-label={kbd ? 'Hide keyboard' : 'Show keyboard'} aria-pressed={kbd} disabled={!live} onClick={toggleKeyboard}>
					<Icon name={kbd ? 'keyboard-hide' : 'keyboard'} size={22} />
				</button>
				<div className="console-keys">
					{keys.map((k) => (
						<button key={k.label} className={k.on ? 'on' : ''} aria-pressed={k.on} disabled={!live} onPointerDown={(e) => e.preventDefault()} onClick={k.onClick}>
							{k.label}
						</button>
					))}
				</div>
			</div>
		</div>,
		portalRoot,
	)
}
