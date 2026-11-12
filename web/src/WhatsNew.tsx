import {useEffect, useState} from 'react'

import {CHANGELOG, type Release, unseen} from './changelog'
import {Icon} from './icons'
import {Sheet, SheetHeader} from './ui'

const SEEN_KEY = 'touch.seenVersion'
const readSeen = () => {
	try {
		return localStorage.getItem(SEEN_KEY)
	} catch {
		return null
	}
}
const markSeen = (v: string) => {
	try {
		localStorage.setItem(SEEN_KEY, v)
	} catch {}
}

export function WhatsNewSheet({releases, version, onClose}: {releases: Release[]; version: string; onClose: () => void}) {
	return (
		<Sheet open onClose={onClose} label="What’s new">
			<SheetHeader
				icon={
					<span className="sheet-icon" style={{background: 'linear-gradient(135deg, var(--accent), var(--pink))'}}>
						<Icon name="sparkle" size={28} />
					</span>
				}
				title="What’s new"
				subtitle={`UmbrelOS Touch ${version}`}
				onClose={onClose}
			/>
			<div className="screen whats-new">
				{releases.map((r) => (
					<article key={r.version}>
						<h3>
							{r.title}
							<span className="muted num">
								{r.version} · {new Date(`${r.date}T12:00:00`).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}
							</span>
						</h3>
						{r.added?.length ? (
							<ul>
								{r.added.map((t) => (
									<li key={t}>
										<span className="tag new">New</span>
										{t}
									</li>
								))}
							</ul>
						) : null}
						{r.fixed?.length ? (
							<ul>
								{r.fixed.map((t) => (
									<li key={t}>
										<span className="tag fix">Fixed</span>
										{t}
									</li>
								))}
							</ul>
						) : null}
					</article>
				))}
				<button className="btn primary block" onClick={onClose}>
					Got it
				</button>
			</div>
		</Sheet>
	)
}

// Pops up once after Touch updates, with everything since the version this device last saw.
export function WhatsNewOnUpdate({version}: {version: string}) {
	const [releases, setReleases] = useState<Release[] | null>(null)
	useEffect(() => {
		const seen = readSeen()
		if (seen === version) return
		const list = unseen(version, seen)
		if (list.length) {
			const t = window.setTimeout(() => setReleases(list), 900)
			return () => window.clearTimeout(t)
		}
		markSeen(version)
	}, [version])
	if (!releases) return null
	return (
		<WhatsNewSheet
			releases={releases}
			version={version}
			onClose={() => {
				markSeen(version)
				setReleases(null)
			}}
		/>
	)
}

// The full history, for Settings.
export const allReleases = (version: string) => CHANGELOG.filter((r) => unseen(version, '0.0.0').includes(r)).slice(0, 12)
