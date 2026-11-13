import {useEffect, useMemo, useRef, useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from './api'
import {Icon} from './icons'
import {haptic, useConfirm, useToast} from './ui'

type Job = {state: 'installing' | 'switching' | 'removing' | 'error'; error?: string}
type Colors = {background?: string | null; foreground?: string | null; accent?: string | null; dots?: string[]} | null
type Installed = {slug: string; name: string; user: boolean; current: boolean; colors: Colors; preview: boolean; job?: Job}
type More = {slug: string; name: string; url: string; preview: string | null; job?: Job}
type Themes = {available: boolean; current: string | null; installed: Installed[]; more: More[]; source: string}

// Settings → Appearance → Omarchy → Themes: the desktop's own themes, like the Omarchy menu.
// Tap one to switch the whole desktop; get more from the Omarchy manual's theme list.
export function OmarchyThemes({owner}: {owner: boolean}) {
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const [search, setSearch] = useState('')
	const [pending, setPending] = useState<string | null>(null)
	const themes = useQuery({
		queryKey: ['omarchy.themes'],
		queryFn: () => query<Themes>('omarchy.themes'),
		// While something is switching or installing, keep checking.
		refetchInterval: (q) => (pending || q.state.data?.installed.some((t) => t.job && t.job.state !== 'error') || q.state.data?.more.some((t) => t.job && t.job.state !== 'error') ? 1500 : false),
	})
	const data = themes.data
	// When the desktop's theme changes, the web app's Omarchy colours and backgrounds follow.
	const lastCurrent = useRef<string | null | undefined>(undefined)
	useEffect(() => {
		if (!data) return
		if (lastCurrent.current !== undefined && lastCurrent.current !== data.current) {
			qc.invalidateQueries({queryKey: ['omarchy-themes']})
			setPending(null)
			toast(`Desktop theme: ${data.installed.find((t) => t.current)?.name ?? data.current}`)
		}
		lastCurrent.current = data.current
		for (const t of [...data.installed, ...data.more]) if (t.job?.state === 'error' && pending === t.slug) (setPending(null), toast(t.job.error ?? 'That didn’t work', true))
	}, [data])

	const act = async (path: string, slug: string, done?: string) => {
		haptic(8)
		setPending(slug)
		try {
			await mutate(path, {slug})
			if (done) toast(done)
			qc.invalidateQueries({queryKey: ['omarchy.themes']})
		} catch (e) {
			setPending(null)
			toast((e as Error).message, true)
		}
	}
	const more = useMemo(() => {
		const q = search.trim().toLowerCase()
		return (data?.more ?? []).filter((t) => !q || t.name.toLowerCase().includes(q))
	}, [data, search])

	if (themes.isLoading) return <div className="omb-note"><span className="spinner" /> Loading Omarchy’s themes…</div>
	if (themes.error) return <div className="error"><Icon name="alert" size={18} />{(themes.error as Error).message}</div>
	if (!data?.installed.length) return <div className="omb-note">No Omarchy themes found on this server.</div>

	return (
		<div className="omt">
			{!data.available && (
				<div className="error">
					<Icon name="alert" size={18} />
					Omarchy’s theme commands weren’t found, so themes can be shown but not switched here.
				</div>
			)}
			{!owner && <p className="footer-note" style={{textAlign: 'left'}}>Only the server’s owner can change the desktop’s theme.</p>}
			<div className="omt-grid" role="radiogroup" aria-label="Omarchy themes">
				{data.installed.map((t) => {
					const busy = (t.job && t.job.state !== 'error') || (pending === t.slug && !t.current)
					return (
						<div key={t.slug} className={`omt-card${t.current ? ' on' : ''}`} style={{background: t.colors?.background ?? undefined, color: t.colors?.foreground ?? undefined}}>
							<button
								role="radio"
								aria-checked={t.current}
								className="omt-pick"
								disabled={!owner || !data.available || t.current || !!busy}
								onClick={() => act('omarchy.setTheme', t.slug)}
							>
								{t.preview ? <img src={`/api/omarchy/preview/${t.slug}`} alt="" loading="lazy" decoding="async" /> : <span className="omt-noimg" />}
								<span className="omt-name">
									{t.name}
									{t.current && <Icon name="check" size={14} stroke={3} />}
								</span>
								<span className="omt-dots">
									{(t.colors?.dots ?? []).map((d, i) => (
										<i key={i} style={{background: d}} />
									))}
								</span>
								{busy && <span className="omt-busy"><span className="spinner" /></span>}
							</button>
							{t.user && owner && !t.current && (
								<button
									className="omt-remove"
									aria-label={`Remove ${t.name}`}
									onClick={async () => {
										if (await confirm({title: `Remove ${t.name}?`, body: 'It’s deleted from this server’s Omarchy themes. You can get it again later.', confirm: 'Remove', danger: true, icon: 'trash'}))
											act('omarchy.removeTheme', t.slug, `${t.name} removed`)
									}}
								>
									<Icon name="trash" size={14} />
								</button>
							)}
						</div>
					)
				})}
			</div>

			{owner && data.available && (
				<>
					<div className="section-head" style={{margin: '22px 0 8px'}}>
						<h2>Get more themes</h2>
					</div>
					<p className="footer-note" style={{textAlign: 'left', margin: '0 2px 10px'}}>
						Community themes from the Omarchy manual. Getting one downloads it to this server and switches the desktop to it.
					</p>
					<input className="omt-search" type="search" placeholder={`Search ${data.more.length} themes`} value={search} onChange={(e) => setSearch(e.target.value)} />
					<div className="omt-grid">
						{more.map((t) => {
							const busy = (t.job && t.job.state !== 'error') || pending === t.slug
							return (
								<div key={t.slug} className="omt-card more">
									<button className="omt-pick" disabled={!!busy} onClick={() => act('omarchy.installTheme', t.slug, `Getting ${t.name}…`)}>
										{t.preview ? <img src={t.preview} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /> : <span className="omt-noimg" />}
										<span className="omt-name">{t.name}</span>
										<span className="omt-get">{busy ? <span className="spinner" /> : <><Icon name="download" size={14} /> Get</>}</span>
									</button>
								</div>
							)
						})}
					</div>
				</>
			)}
		</div>
	)
}
