// Full-screen terminal: a shell on the server, or inside one app's container.
// omarchyd streams a PTY over a WebSocket (bridged by the Touch server). The terminal fills its
// window: when the window (or the phone's keyboard) changes its size, the shell is resized to
// match, so programs reflow and full-screen ones redraw, the way a native terminal does.
import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {Terminal as XTerm} from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import {clipText} from './clips'
import {Icon} from './icons'
import {SEQ, applyTerminalModifiers} from './terminalKeys'
import {AppIcon, haptic, useConfirm, usePortalRoot, useScreenLock, useToast} from './ui'

// closed: the shell ended. lost: the connection dropped (the shell is still running on the server).
type State = 'connecting' | 'connected' | 'closed' | 'lost' | 'error'
const BASE_FONT = 13

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

function cssVar(name: string, fallback: string) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export function TerminalScreen({
	app,
	agent,
	onClose,
	embedded,
	input,
}: {
	app?: {id: string; name?: string; icon?: string}
	// A computer in the local swarm (through its connector), instead of this server.
	agent?: {id: string; name: string}
	onClose: () => void
	embedded?: boolean
	input?: string
}) {
	const portalRoot = usePortalRoot()
	const root = useRef<HTMLDivElement>(null)
	const host = useRef<HTMLDivElement>(null)
	const termRef = useRef<XTerm>()
	const wsRef = useRef<WebSocket>()
	// This window's own size in characters (what it asks the shell for); ready once measured.
	const size = useRef({cols: 80, rows: 24, ready: false})
	const [state, setState] = useState<State>('connecting')
	const [message, setMessage] = useState('')
	const [attempt, setAttempt] = useState(0)
	const [ctrl, setCtrl] = useState(false)
	const [alt, setAlt] = useState(false)
	const [kbd, setKbd] = useState(false)
	const [pasteBox, setPasteBox] = useState(false)
	const [pasteText, setPasteText] = useState('')
	const mods = useRef({ctrl: false, alt: false})
	// Your shell keeps running when you close this; reopening resumes it. `fresh` asks for a new one.
	const [resumed, setResumed] = useState(false)
	const fresh = useRef(false)
	const confirm = useConfirm()
	// A command to have ready at the prompt (typed, never run: you press Enter). Only once.
	const pending = useRef(input)
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

		// Right-click, as in most terminals: with text selected it copies it; otherwise it pastes.
		// Reading the clipboard needs https://; on http:// the browser's own menu opens instead,
		// and its Paste works (the terminal puts its input under the pointer for that).
		const copyText = (text: string) => {
			if (window.isSecureContext && navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
			const t = document.createElement('textarea')
			t.value = text
			t.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
			document.body.appendChild(t)
			t.select()
			document.execCommand('copy')
			t.remove()
			return Promise.resolve()
		}
		const onContextMenu = (e: MouseEvent) => {
			// A long-press on a phone keeps its own behaviour.
			if ((e as PointerEvent).pointerType === 'touch' || !matchMedia('(any-pointer: fine)').matches) return
			const selected = term.getSelection()
			if (selected) {
				e.preventDefault()
				copyText(selected).then(
					() => {
						toast('Copied')
						clipText(selected, 'terminal').catch((err: Error) => toast(err.message, true))
					},
					() => toast('Couldn’t copy', true),
				)
				term.clearSelection()
				term.focus()
				return
			}
			if (!window.isSecureContext || !navigator.clipboard?.readText) return
			e.preventDefault()
			navigator.clipboard.readText().then(
				(text) => {
					if (text) term.paste(text)
					term.focus()
				},
				() => toast('Allow clipboard access for this site to paste with a right-click', true),
			)
		}
		el.addEventListener('contextmenu', onContextMenu)
		const onClip = (e: ClipboardEvent) => {
			const selected = term.getSelection()
			const target = e.target
			if (!selected || !(target instanceof Node) || !el.contains(target)) return
			clipText(selected, 'terminal', e.type === 'cut').catch((err: Error) => toast(err.message, true))
		}
		document.addEventListener('copy', onClip)
		document.addEventListener('cut', onClip)

		// -- Size: fill the window at the normal text size --------------------------------------
		// A character cell at the normal text size (measured at whatever size is showing now).
		const cell = () => {
			const dims = (term as any)._core?._renderService?.dimensions?.css?.cell
			const font = term.options.fontSize ?? BASE_FONT
			const k = BASE_FONT / font
			return {w: (dims?.width || font * 0.6) * k, h: (dims?.height || font * 1.15 * 1.2) * k}
		}
		// The room the text has: the window, less padding and (on a computer) the scrollbar.
		const room = () => {
			const cs = getComputedStyle(el)
			const vp = el.querySelector<HTMLElement>('.xterm-viewport')
			const bar = vp ? vp.offsetWidth - vp.clientWidth : 0
			return {
				w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - bar,
				h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
			}
		}
		// How many columns and rows fit this window.
		const fitSize = () => {
			const {w, h} = room()
			const c = cell()
			return {cols: Math.max(20, Math.min(500, Math.floor(w / c.w))), rows: Math.max(4, Math.min(300, Math.floor(h / c.h)))}
		}
		// Draw the terminal at the shell's size. At this window's own size that's the normal text
		// size; if another device viewing the same shell set its size, scale the text to fit here.
		const show = (cols: number, rows: number) => {
			const buf = term.buffer.active
			const atBottom = buf.viewportY >= buf.baseY
			if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)
			const mine = size.current
			let font = BASE_FONT
			if (cols !== mine.cols || rows !== mine.rows) {
				const {w, h} = room()
				const c = cell()
				font = Math.max(7, Math.min(BASE_FONT * 1.5, BASE_FONT * Math.min(w / (cols * c.w), h / (rows * c.h))))
			}
			// Round down to a half point, so the scaled text always fits inside the window.
			if (Math.abs(font - (term.options.fontSize ?? BASE_FONT)) > 0.2) term.options.fontSize = Math.floor(font * 2) / 2
			// Reading back through history stays put; at the bottom it stays at the bottom.
			if (atBottom) term.scrollToBottom()
		}
		// Tell the shell this window's size (a binary frame; what's typed is text). A window being
		// dragged changes size many times: send the last one.
		let sizeTimer = 0
		const sendSize = (now = false) => {
			window.clearTimeout(sizeTimer)
			const go = () => {
				const ws = wsRef.current
				if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(JSON.stringify({type: 'resize', cols: size.current.cols, rows: size.current.rows})))
			}
			if (now) go()
			else sizeTimer = window.setTimeout(go, 90)
		}
		// The window changed size (or the phone's keyboard came or went): fit it, and resize the shell.
		const refit = () => {
			if (!size.current.ready || !el.clientWidth || !el.clientHeight) return // hidden (another workspace)
			const next = fitSize()
			const changed = next.cols !== size.current.cols || next.rows !== size.current.rows
			size.current = {...size.current, ...next}
			if (changed || next.cols !== term.cols || next.rows !== term.rows) {
				show(next.cols, next.rows)
				if (changed || wsRef.current?.readyState === WebSocket.OPEN) sendSize()
			}
		}

		const send = (data: string) => {
			const ws = wsRef.current
			if (ws?.readyState === WebSocket.OPEN) ws.send(data)
		}
		term.onData((data) => {
			// Typing here after another device resized this shell: take it back to this window's size.
			// (Sent now, ahead of what's typed: the server holds the typing until the shell has resized.)
			if (term.cols !== size.current.cols || term.rows !== size.current.rows) {
				show(size.current.cols, size.current.rows)
				sendSize(true)
			}
			const m = mods.current
			const res = applyTerminalModifiers(data, m, {appCursor: term.modes.applicationCursorKeysMode, applyAppCursor: false})
			mods.current = {ctrl: res.ctrl, alt: res.alt}
			if (res.ctrl !== m.ctrl) setCtrl(res.ctrl)
			if (res.alt !== m.alt) setAlt(res.alt)
			send(res.data)
		})
		const ta = term.textarea
		ta?.setAttribute('autocapitalize', 'off')
		ta?.setAttribute('autocorrect', 'off')
		ta?.setAttribute('spellcheck', 'false')
		// (Typing scrolls to the prompt by itself; tapping in to type doesn't throw away your place.)
		const onFocus = () => setKbd(true)
		const onBlur = () => setKbd(false)
		ta?.addEventListener('focus', onFocus)
		ta?.addEventListener('blur', onBlur)

		const connect = async () => {
			setState('connecting')
			const check = await fetch('/api/console/check?target=terminal', {credentials: 'same-origin'}).catch(() => null)
			if (disposed) return
			if (!check?.ok) {
				const body = await check?.json().catch(() => null)
				setMessage(body?.error?.message ?? 'Can’t reach your server right now.')
				setState('error')
				return
			}
			term.options.fontSize = BASE_FONT
			await new Promise((r) => requestAnimationFrame(() => r(null)))
			if (disposed) return
			const s = {...fitSize(), ready: true}
			size.current = s
			term.resize(s.cols, s.rows)
			term.reset()
			const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
			const qs = new URLSearchParams({...(app ? {appId: app.id} : {}), ...(agent ? {agentId: agent.id} : {}), cols: String(s.cols), rows: String(s.rows), ...(fresh.current ? {fresh: '1'} : {})})
			fresh.current = false
			const ws = new WebSocket(`${scheme}//${location.host}/api/terminal?${qs}`)
			ws.binaryType = 'arraybuffer'
			wsRef.current = ws
			ws.onopen = () => {
				setState('connected')
				haptic(8)
				if (pending.current) {
					const text = pending.current
					pending.current = undefined
					setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send(text), 400)
				}
				term.focus() // types straight away with a hardware keyboard; phones may still need the keyboard button
			}
			ws.onmessage = (e) => {
				if (typeof e.data !== 'string') return term.write(new Uint8Array(e.data))
				// Text frames are about the session: resumed (what was on screen follows, drawn at the
				// size it was), and the size it's now at. Resize in order with the output around it.
				let m: {type?: string; resumed?: boolean; cols?: number; rows?: number}
				try {
					m = JSON.parse(e.data)
				} catch {
					return
				}
				if (m.type === 'session') setResumed(!!m.resumed)
				if ((m.type === 'session' || m.type === 'size') && m.cols && m.rows) {
					// In order with the output around it: a resumed screen replays at the size it was
					// drawn, then the shell takes this window's size.
					const {cols, rows} = m
					term.write('', () => show(cols, rows))
				}
			}
			ws.onclose = (e) => {
				if (disposed || wsRef.current !== ws) return
				if (e.code === 1000 && e.reason === 'Shell ended') {
					setState('closed')
					setMessage('The shell has ended.')
				} else {
					setState((st) => (st === 'connecting' ? 'error' : 'lost'))
					// A swarm computer's shell goes through its connector and isn't kept (yet): it ended.
					setMessage(agent ? 'The connection to it dropped. Reconnect for a new shell.' : 'Your shell is still running on the server. Reconnect to pick up where you left off.')
				}
			}
		}
		connect()

		// Fill the window, now and whenever it changes size. (Phones: the keyboard shrinks the
		// window, so the shell gets fewer rows and the prompt stays in view above it.)
		let raf = 0
		const onResize = () => {
			cancelAnimationFrame(raf)
			raf = requestAnimationFrame(() => {
				refit()
				el.style.setProperty('--term-frame', `${el.clientHeight}px`)
			})
		}
		const ro = new ResizeObserver(onResize)
		ro.observe(el)
		const rootEl = root.current
		rootEl?.addEventListener('viewportchange', onResize)

		// -- Touch: scroll like a phone app ---------------------------------------------------
		// A drag moves the text with your finger and keeps going when you let go (momentum). In
		// full-screen programs (less, man, vim) there's no history to scroll, so a drag sends the
		// arrow keys instead, as a mouse wheel would. A tap still opens the keyboard, and a long
		// press still offers Paste.
		const viewport = () => el.querySelector<HTMLElement>('.xterm-viewport')
		let touch: {startY: number; y: number; t: number; v: number; moved: boolean; carry: number} | null = null
		let fling = 0
		const stopFling = () => cancelAnimationFrame(fling)
		// dy > 0: the text moves up (towards newer lines).
		const scrollBy = (dy: number) => {
			if (term.buffer.active.type === 'alternate') {
				if (!touch) return false
				touch.carry += dy
				const rowH = cell().h * ((term.options.fontSize ?? BASE_FONT) / BASE_FONT)
				let out = ''
				while (Math.abs(touch.carry) >= rowH) {
					out += applyTerminalModifiers(touch.carry > 0 ? SEQ.down : SEQ.up, {ctrl: false, alt: false}, {appCursor: term.modes.applicationCursorKeysMode, applyAppCursor: true}).data
					touch.carry -= Math.sign(touch.carry) * rowH
				}
				if (out) send(out)
				return true
			}
			const vp = viewport()
			if (!vp) return false
			const before = vp.scrollTop
			vp.scrollTop = before + dy
			return vp.scrollTop !== before
		}
		const onTouchStart = (e: TouchEvent) => {
			stopFling()
			if (e.touches.length !== 1) return void (touch = null)
			const y = e.touches[0].clientY
			touch = {startY: y, y, t: performance.now(), v: 0, moved: false, carry: 0}
		}
		const onTouchMove = (e: TouchEvent) => {
			if (!touch || e.touches.length !== 1) return
			const y = e.touches[0].clientY
			if (!touch.moved && Math.abs(y - touch.startY) < 6) return // not a drag yet: maybe a tap or a long press
			touch.moved = true
			e.preventDefault() // ours, not the page's (or xterm's own, slower) scrolling
			e.stopPropagation()
			const now = performance.now()
			const dy = touch.y - y
			const dt = Math.max(1, now - touch.t)
			touch.v = 0.75 * (dy / dt) + 0.25 * touch.v
			touch.y = y
			touch.t = now
			scrollBy(dy)
		}
		const onTouchEnd = (e: TouchEvent) => {
			const t = touch
			touch = null
			if (!t?.moved) return
			e.stopPropagation()
			// Let go mid-swipe: keep going and slow down, as a phone does (not in full-screen programs).
			let v = performance.now() - t.t > 80 ? 0 : t.v
			if (term.buffer.active.type === 'alternate' || Math.abs(v) < 0.05) return
			let last = performance.now()
			const step = (now: number) => {
				const dt = now - last
				last = now
				v *= Math.pow(0.9965, dt)
				if (Math.abs(v) < 0.02 || !scrollBy(v * dt)) return
				fling = requestAnimationFrame(step)
			}
			fling = requestAnimationFrame(step)
		}
		el.addEventListener('touchstart', onTouchStart, {capture: true, passive: true})
		el.addEventListener('touchmove', onTouchMove, {capture: true, passive: false})
		el.addEventListener('touchend', onTouchEnd, {capture: true})
		el.addEventListener('touchcancel', onTouchEnd, {capture: true})

		return () => {
			disposed = true
			ro.disconnect()
			cancelAnimationFrame(raf)
			stopFling()
			window.clearTimeout(sizeTimer)
			rootEl?.removeEventListener('viewportchange', onResize)
			el.removeEventListener('touchstart', onTouchStart, {capture: true})
			el.removeEventListener('touchmove', onTouchMove, {capture: true})
			el.removeEventListener('touchend', onTouchEnd, {capture: true})
			el.removeEventListener('touchcancel', onTouchEnd, {capture: true})
			ta?.removeEventListener('focus', onFocus)
			ta?.removeEventListener('blur', onBlur)
			wsRef.current?.close()
			el.removeEventListener('contextmenu', onContextMenu)
			document.removeEventListener('copy', onClip)
			document.removeEventListener('cut', onClip)
			term.dispose()
		}
	}, [app, agent?.id, attempt])

	useEffect(() => {
		const onClipPaste = (e: Event) => {
			const text = (e as CustomEvent<{text?: string}>).detail?.text
			if (text) termRef.current?.paste(text)
		}
		window.addEventListener('omarchy-clip-paste', onClipPaste)
		return () => window.removeEventListener('omarchy-clip-paste', onClipPaste)
	}, [])

	const sendSeq = (seq: string) => {
		haptic(5)
		const ws = wsRef.current
		if (ws?.readyState !== WebSocket.OPEN) return
		const m = mods.current
		const res = applyTerminalModifiers(seq, m, {appCursor: termRef.current?.modes.applicationCursorKeysMode, applyAppCursor: true})
		mods.current = {ctrl: res.ctrl, alt: res.alt}
		if (res.ctrl !== m.ctrl) setCtrl(res.ctrl)
		if (res.alt !== m.alt) setAlt(res.alt)
		ws.send(res.data)
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
	// End the shell that's running (and whatever is running in it) and start a new one.
	const newSession = async () => {
		haptic(6)
		const ok = await confirm({
			title: 'Start a new session?',
			body: 'The shell that’s running now ends, along with anything still running in it. (Closing the terminal doesn’t do this: your shell keeps running until you exit it.)',
			confirm: 'New session',
			icon: 'reset',
		})
		if (!ok) return
		fresh.current = true
		setResumed(false)
		setAttempt((a) => a + 1)
	}
	const title = app ? (app.name ?? app.id) : agent ? agent.name : 'Terminal'

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
						{live ? `${app ? 'App shell' : agent ? 'Shell through its connector' : 'Omarchy Server shell'}${resumed ? ' · resumed' : ''}` : state === 'connecting' ? 'Connecting…' : 'Disconnected'}
					</span>
				</div>
				{!agent && (
					<button className="round-btn" aria-label="New session" title="New session" onClick={newSession} disabled={!live}>
						<Icon name="reset" size={19} />
					</button>
				)}
				<button className="round-btn" aria-label="Paste" onClick={paste} disabled={!live}>
					<Icon name="clipboard" size={19} />
				</button>
			</header>
			<div className="term-screen" onClick={() => live && !kbd && termRef.current?.focus()}>
				<div ref={host} className="term-host" />
				{state !== 'connected' && state !== 'connecting' && (
					<div className="console-overlay">
						<Icon name={state === 'closed' ? 'logs' : state === 'lost' ? 'wifi' : 'alert'} size={34} />
						<b>{state === 'closed' ? 'Session ended' : state === 'lost' ? 'Disconnected' : 'Terminal unavailable'}</b>
						<span>{message}</span>
						<button className="btn primary small" onClick={() => setAttempt((a) => a + 1)}>
							{state === 'closed' ? 'New session' : state === 'lost' ? 'Reconnect' : 'Try again'}
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
