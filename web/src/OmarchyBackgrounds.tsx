import {useState} from 'react'

import {Icon} from './icons'
import {haptic, omarchyBackgroundUrl, useOmarchyThemes} from './ui'

// The Omarchy desktop's backgrounds, theme by theme, to pick from. `selected`: an id, null for
// "same as the desktop", undefined when none of these is in use.
export function OmarchyBackgrounds({selected, onChoose}: {selected: string | null | undefined; onChoose: (id: string | null) => void}) {
	const themes = useOmarchyThemes()
	const [open, setOpen] = useState<string | null>(null)
	const groups = themes.data?.groups ?? []
	const choose = (id: string | null) => {
		haptic(6)
		onChoose(id)
	}
	if (themes.isLoading) return <div className="omb-note"><span className="spinner" /> Looking for Omarchy’s backgrounds…</div>
	if (!themes.data || !groups.length)
		return <div className="omb-note">No Omarchy backgrounds found on this server. The Omarchy theme uses its colours without a picture.</div>
	const shownTheme = open ?? themes.data.theme ?? groups[0].theme
	const group = groups.find((g) => g.theme === shownTheme) ?? groups[0]
	return (
		<div className="omb">
			<div className="omb-head">
				<b>Omarchy backgrounds</b>
				<select value={group.theme} onChange={(e) => setOpen(e.target.value)} aria-label="Omarchy theme">
					{groups.map((g) => (
						<option key={g.theme} value={g.theme}>
							{g.label}
							{g.theme === themes.data!.theme ? ' (current)' : ''}
						</option>
					))}
				</select>
			</div>
			<div className="omb-grid" role="radiogroup" aria-label="Background">
				<button role="radio" aria-checked={selected === null} className={`omb-tile${selected === null ? ' on' : ''}`} onClick={() => choose(null)} title="Follows the Omarchy desktop">
					<img src={omarchyBackgroundUrl(null)} alt="" loading="lazy" decoding="async" />
					<span className="omb-label">
						<Icon name="sparkle" size={13} /> Same as desktop
					</span>
				</button>
				{group.items.map((it) => {
					const on = selected === it.id
					return (
						<button key={it.id} role="radio" aria-checked={on} className={`omb-tile${on ? ' on' : ''}`} onClick={() => choose(it.id)} title={it.name}>
							<img src={omarchyBackgroundUrl(it.id)} alt={it.name} loading="lazy" decoding="async" />
						</button>
					)
				})}
			</div>
		</div>
	)
}
