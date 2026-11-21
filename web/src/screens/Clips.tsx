// One clip book for the signed-in person. A file is a reference until paste streams it.
import {useContext, useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query, type Machine} from '../api'
import {clipItemUrl} from '../clips'
import {useUser} from '../data'
import {Icon, type IconName} from '../icons'
import {type Agent} from '../swarm/Swarm'
import {Field, Group, InWindow, Row, Sheet, SheetHeader, bytes, haptic, useConfirm, useToast} from '../ui'

type ClipRef = {scope: 'server' | 'swarm' | 'machine'; path: string; id?: string; size: number | null; mtime: number | null}
type Clip = {
	id: string
	kind: 'text' | 'image' | 'stats' | 'file'
	at: number
	label: string
	where: string
	name: string
	preview: string
	cut?: true
	bytes?: number
	ref?: ClipRef
}
type Book = {clips: Clip[]; damaged: boolean}
type FleetEntry = {name: string; size: number; mtime: number | null; dir: boolean}
type FleetList = {path: string; entries: FleetEntry[]; truncated: boolean}

const KIND: Record<Clip['kind'], IconName> = {text: 'file-text', image: 'image', stats: 'activity', file: 'folder'}

export function Clips({onBack}: {onBack?: () => void}) {
	const toast = useToast()
	const confirm = useConfirm()
	const qc = useQueryClient()
	const user = useUser()
	const owner = user.data?.role === 'owner'
	const inWindow = useContext(InWindow)
	const book = useQuery({queryKey: ['clips.list'], queryFn: () => query<Book>('clips.list')})
	const machines = useQuery({queryKey: ['machines.list'], queryFn: () => query<Machine[]>('machines.list'), enabled: owner})
	const computers = useQuery({queryKey: ['swarm.list'], queryFn: () => query<Agent[]>('swarm.list'), enabled: owner})
	const [open, setOpen] = useState<Clip | null>(null)
	const [folder, setFolder] = useState('/Home')
	const [computer, setComputer] = useState('')
	const [destPath, setDestPath] = useState('')
	const [machineId, setMachineId] = useState('')
	const [vmPath, setVmPath] = useState('')
	const [statsMachine, setStatsMachine] = useState('')
	const [statsComputer, setStatsComputer] = useState('')
	const [browseId, setBrowseId] = useState('')
	const [browsePath, setBrowsePath] = useState('')
	const [busy, setBusy] = useState(false)
	const fleet = useQuery({
		queryKey: ['clips.fleetList', browseId, browsePath],
		queryFn: () => query<FleetList>('clips.fleetList', {id: browseId, path: browsePath}),
		enabled: owner && !!browseId,
	})

	const refresh = () => qc.invalidateQueries({queryKey: ['clips.list']})
	const run = async (work: () => Promise<void>) => {
		if (busy) return
		setBusy(true)
		try {
			await work()
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(false)
		}
	}

	const remove = async (clip: Clip) => {
		const ok = await confirm({title: 'Remove this clip?', body: 'It’s taken out of your clip book.', confirm: 'Remove', danger: true, icon: 'trash'})
		if (!ok) return
		await run(async () => {
			await mutate('clips.remove', {id: clip.id})
			if (open?.id === clip.id) setOpen(null)
			toast('Removed')
			refresh()
		})
	}
	const pasteText = (clip: Clip) =>
		run(async () => {
			const result = await mutate<{text?: string}>('clips.paste', {id: clip.id, dest: 'text'})
			const text = result.text ?? ''
			if (text && navigator.clipboard?.writeText) await navigator.clipboard.writeText(text).catch(() => {})
			window.dispatchEvent(new CustomEvent('omarchy-clip-paste', {detail: {text}}))
			toast('Pasted')
		})
	const pasteFolder = (clip: Clip) =>
		run(async () => {
			const result = await mutate<{path?: string}>('clips.paste', {id: clip.id, dest: {folder}})
			toast(result.path ? `Saved to ${result.path}` : 'Saved')
		})
	const pasteComputer = (clip: Clip) =>
		run(async () => {
			await mutate('clips.paste', {id: clip.id, dest: {computer, path: destPath}})
			toast('Saved onto that computer')
		})

	const machineList = (machines.data ?? []).filter((m) => m.id && m.id !== 'desktop')
	const computerList = computers.data ?? []
	const clips = book.data?.clips ?? []

	return (
		<div className="stagger">
			<div style={{display: 'flex', alignItems: 'center', gap: 10}}>
				{onBack && !inWindow && (
					<button className="round-btn" aria-label="Back" onClick={onBack}>
						<Icon name="back" size={20} />
					</button>
				)}
				<div>
					<h1 className="title" style={{margin: 0}}>
						Clip book
					</h1>
					<p className="subtitle">Text, screenshots, stats, and files you set aside. A file stays where it is until you paste it.</p>
				</div>
			</div>
			{book.data?.damaged && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					The clip book is damaged and was left unchanged.
				</div>
			)}
			{book.isError && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{(book.error as Error).message}
				</div>
			)}
			<Group title="Add">
				<Row icon="activity" color="var(--peach)" label="Clip this server’s stats" onClick={() => run(async () => { await mutate('clips.addStats', {scope: 'server'}); toast('Saved to the clip book'); refresh() })} />
				{owner && machineList.length > 0 && (
					<div className="row static" style={{minHeight: 56, gap: 8}}>
						<select className="field" aria-label="Machine" value={statsMachine} onChange={(e) => setStatsMachine(e.target.value)}>
							<option value="">A machine</option>
							{machineList.map((m) => (
								<option key={m.id} value={m.id}>{m.name}</option>
							))}
						</select>
						<button className="btn small" disabled={!statsMachine || busy} onClick={() => run(async () => { await mutate('clips.addStats', {scope: 'machine', id: statsMachine}); toast('Saved to the clip book'); refresh() })}>
							Clip stats
						</button>
					</div>
				)}
				{owner && computerList.length > 0 && (
					<div className="row static" style={{minHeight: 56, gap: 8}}>
						<select className="field" aria-label="Computer" value={statsComputer} onChange={(e) => setStatsComputer(e.target.value)}>
							<option value="">A computer</option>
							{computerList.map((a) => (
								<option key={a.id} value={a.id}>{a.name}</option>
							))}
						</select>
						<button className="btn small" disabled={!statsComputer || busy} onClick={() => run(async () => { await mutate('clips.addStats', {scope: 'swarm', id: statsComputer}); toast('Saved to the clip book'); refresh() })}>
							Clip stats
						</button>
					</div>
				)}
			</Group>
			{owner && (
				<Group title="A file on another computer" footer="An already-paired computer needs the connector install again, with Files switched on. A file on a virtual machine stays on that computer.">
					{computerList.length > 0 && (
						<div className="row static" style={{minHeight: 56}}>
							<select className="field" aria-label="Computer to browse" value={browseId} onChange={(e) => { setBrowseId(e.target.value); setBrowsePath('') }}>
								<option value="">Choose a computer</option>
								{computerList.map((a) => (
									<option key={a.id} value={a.id}>{a.name}</option>
								))}
							</select>
						</div>
					)}
					{browseId && (
						<>
							<div className="row static" style={{minHeight: 44}}>
								<button className="btn small" disabled={!browsePath} onClick={() => setBrowsePath(browsePath.split('/').slice(0, -1).join('/'))}>
									Up
								</button>
								<span className="muted">{browsePath || 'Home'}</span>
							</div>
							{fleet.isError && <p className="footer-note">{(fleet.error as Error).message}</p>}
							{(fleet.data?.entries ?? []).map((entry) => (
								<Row
									key={entry.name}
									icon={entry.dir ? 'folder' : 'file-text'}
									label={entry.name}
									sub={entry.dir ? 'Folder' : bytes(entry.size)}
									onClick={() => {
										const next = browsePath ? `${browsePath}/${entry.name}` : entry.name
										if (entry.dir) {
											setBrowsePath(next)
											return
										}
										haptic(6)
										run(async () => {
											await mutate('clips.addFile', {scope: 'swarm', id: browseId, path: next})
											toast('Saved to the clip book')
											refresh()
										})
									}}
								/>
							))}
							{fleet.data?.truncated && <p className="footer-note">This folder has more than the list shows.</p>}
						</>
					)}
					{machineList.length > 0 && (
						<>
							<div className="row static" style={{minHeight: 56, gap: 8, flexWrap: 'wrap'}}>
								<select className="field" aria-label="Virtual machine" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
									<option value="">A virtual machine</option>
									{machineList.map((m) => (
										<option key={m.id} value={m.id}>{m.name}</option>
									))}
								</select>
								<Field label="File on that machine" value={vmPath} onChange={(e) => setVmPath(e.target.value)} placeholder="Documents/notes.txt" />
								<button
									className="btn small"
									disabled={!machineId || !vmPath.trim() || busy}
									onClick={() => run(async () => {
										await mutate('clips.addFile', {scope: 'machine', id: machineId, path: vmPath.trim()})
										toast('Saved to the clip book')
										setVmPath('')
										refresh()
									})}
								>
									Clip that file
								</button>
							</div>
							<p className="footer-note">That file is still on that computer. Paste says so, and the bytes stay there.</p>
						</>
					)}
				</Group>
			)}
			<Group title="Your clips" footer="Copy or cut in a terminal or on a desktop and it lands here. On a desktop, Save a screenshot keeps the picture on this computer, and the clipboard button puts it in the book. Saving into a folder on this server keeps both files if the name is already there. Saving onto another computer refuses a name that’s already there.">
				{book.isPending && <p className="footer-note">Loading…</p>}
				{!book.isPending && clips.length === 0 && <p className="footer-note">Nothing clipped yet.</p>}
				{clips.map((clip) => (
					<Row
						key={clip.id}
						icon={KIND[clip.kind]}
						color={clip.kind === 'image' ? 'var(--mauve)' : clip.kind === 'stats' ? 'var(--peach)' : 'var(--blue)'}
						label={clip.cut ? `${clip.label} · cut` : clip.label}
						sub={clip.preview}
						onClick={() => {
							haptic(6)
							setOpen(clip)
							setFolder('/Home')
						}}
					/>
				))}
			</Group>
			<Sheet open={!!open} onClose={() => setOpen(null)} label={open?.label ?? 'Clip'} tall>
				{open && (
					<>
						<SheetHeader icon={<Icon name={KIND[open.kind]} size={28} />} title={open.label} subtitle={open.preview} onClose={() => setOpen(null)} />
						{open.kind === 'image' && <img src={clipItemUrl(open.id)} alt="" style={{width: '100%', borderRadius: 12, margin: '8px 0'}} />}
						{open.ref?.scope === 'machine' ? (
							<p className="footer-note">That file is still on that computer.</p>
						) : (
							<>
								<div className="primary-row">
									{(open.kind === 'text' || open.kind === 'stats') && (
										<button className="btn primary" disabled={busy} onClick={() => pasteText(open)}>
											Paste as text
										</button>
									)}
									<a className="btn" href={clipItemUrl(open.id)}>
										Save to this computer
									</a>
								</div>
								<Field label="Folder on this server" value={folder} onChange={(e) => setFolder(e.target.value)} />
								<button className="btn" disabled={busy} onClick={() => pasteFolder(open)}>
									Save into that folder
								</button>
								{owner && (
									<>
										<div className="row static" style={{minHeight: 56, gap: 8, flexWrap: 'wrap'}}>
											<select className="field" aria-label="Computer to paste onto" value={computer} onChange={(e) => setComputer(e.target.value)}>
												<option value="">A computer</option>
												{computerList.map((a) => (
													<option key={a.id} value={a.id}>{a.name}</option>
												))}
											</select>
											<Field label="File on that computer" value={destPath} onChange={(e) => setDestPath(e.target.value)} placeholder="Documents/notes.txt" />
										</div>
										<button className="btn" disabled={busy || !computer || !destPath.trim()} onClick={() => pasteComputer(open)}>
											Save onto that computer
										</button>
									</>
								)}
							</>
						)}
						<button className="btn danger" disabled={busy} onClick={() => remove(open)}>
							Remove from the clip book
						</button>
					</>
				)}
			</Sheet>
		</div>
	)
}
