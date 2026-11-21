import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react'

import {scrollSelectedRow, stepLauncherSelection} from './launcherScroll'

export type LaunchItem = {key: string; label: string; icon: (size: number) => ReactNode}

export function Launcher({onClose, onOpen, items}: {onClose: () => void; onOpen: (key: string) => void; items: LaunchItem[]}) {
	const [q, setQ] = useState('')
	const [sel, setSel] = useState(0)
	const input = useRef<HTMLInputElement>(null)
	const list = useRef<HTMLUListElement>(null)
	const rows = useMemo(() => items.filter((r) => !q || r.label.toLowerCase().includes(q.toLowerCase())), [items, q])
	const pick = (key: string) => {
		onOpen(key)
		onClose()
	}
	useEffect(() => {
		input.current?.focus()
	}, [])
	useEffect(() => {
		scrollSelectedRow(list.current, sel, rows.length)
	}, [sel, rows.length])
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault()
				onClose()
			}
			if (e.key === 'ArrowDown') {
				e.preventDefault()
				setSel((s) => stepLauncherSelection(s, 'ArrowDown', rows.length))
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault()
				setSel((s) => stepLauncherSelection(s, 'ArrowUp', rows.length))
			}
			if (e.key === 'Enter' && rows[sel]) {
				e.preventDefault()
				pick(rows[sel].key)
			}
		}
		window.addEventListener('keydown', onKey, true)
		return () => window.removeEventListener('keydown', onKey, true)
	})
	return (
		<div className="hypr-overlay" onClick={onClose}>
			<div className="hypr-launcher" role="dialog" aria-label="Launcher" onClick={(e) => e.stopPropagation()}>
				<input ref={input} value={q} onChange={(e) => (setQ(e.target.value), setSel(0))} placeholder="Open…" aria-label="Filter" />
				<ul ref={list}>
					{rows.map((r, i) => (
						<li key={r.key}>
							<button className={i === sel ? 'on' : ''} onClick={() => pick(r.key)} onMouseEnter={() => setSel(i)}>
								<span className="hypr-launch-ico">{r.icon(22)}</span>
								{r.label}
							</button>
						</li>
					))}
					{!rows.length && <li className="muted">Nothing matches</li>}
				</ul>
			</div>
		</div>
	)
}
