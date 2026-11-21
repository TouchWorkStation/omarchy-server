// Clip book: one private book for each signed-in person, outside Home so Files, Samba, and the
// download URL cannot serve it. A file on the server or another computer is a reference. The bytes
// move only when the person pastes. A damaged book is left byte-for-byte and new clips are refused.
import {createReadStream, createWriteStream} from 'node:fs'
import {chmod, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {once} from 'node:events'
import {finished} from 'node:stream/promises'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'

import {readJsonState, writeAtomic, plainObject} from './atomic.mjs'
import {RpcError, sendError, sendJson} from './rpc.mjs'

export const CLIP_LIMITS = {
	text: 256 * 1024,
	image: 8 * 1024 * 1024,
	stats: 256 * 1024,
	budget: 100 * 1024 * 1024,
	max: 200,
	preview: 240,
}
const RPC_TEXT = 48 * 1024
const PASTE_TEXT = 32 * 1024
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/
const CLIP_ID = /^[0-9a-f]{16}$/
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FULL = 'The clip book is full. Remove a clip first.'
const DAMAGED = 'The clip book is damaged and was left unchanged.'
const STILL = 'That file is still on that computer.'
const CHANGED = 'That file changed, so it was left where it is.'
const OWNER = 'Only the server’s owner can use files on another computer'

const oneLine = (text, n = CLIP_LIMITS.preview) =>
	String(text ?? '')
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, n)

function cleanLabel(input, fallback) {
	const text = oneLine(input || fallback || 'Clip', 80)
	return text || 'Clip'
}

function fileName(label, ext) {
	const base = cleanLabel(label, 'clip').slice(0, 80)
	const lower = base.toLowerCase()
	const named = ext && !lower.endsWith(ext) ? `${base}${ext}` : base
	return named.slice(0, 120)
}

function refOk(ref, kind) {
	if (kind !== 'file') return ref == null
	if (!plainObject(ref)) return false
	if (ref.scope !== 'server' && ref.scope !== 'swarm' && ref.scope !== 'machine') return false
	if (typeof ref.path !== 'string' || ref.path.length < 1 || ref.path.length > 1024 || /[\u0000-\u001f\u007f]/.test(ref.path)) return false
	if (ref.scope === 'server' && !ref.path.startsWith('/')) return false
	if (ref.scope !== 'server' && (typeof ref.id !== 'string' || !USER_ID.test(ref.id))) return false
	if (ref.scope === 'machine') return ref.size == null && ref.mtime == null
	return Number.isSafeInteger(ref.size) && ref.size >= 0 && Number.isSafeInteger(ref.mtime)
}

function clipOk(clip, seen) {
	if (!plainObject(clip) || typeof clip.id !== 'string' || !CLIP_ID.test(clip.id) || seen.has(clip.id)) return false
	seen.add(clip.id)
	if (!['text', 'image', 'stats', 'file'].includes(clip.kind)) return false
	if (!Number.isSafeInteger(clip.at) || clip.at < 0) return false
	if (typeof clip.label !== 'string' || clip.label.length < 1 || clip.label.length > 80) return false
	if (typeof clip.where !== 'string' || clip.where.length > 16) return false
	if (typeof clip.name !== 'string' || clip.name.length < 1 || clip.name.length > 120) return false
	if (typeof clip.preview !== 'string' || clip.preview.length > CLIP_LIMITS.preview) return false
	if (clip.cut != null && clip.cut !== true) return false
	if (clip.kind === 'file') return refOk(clip.ref, 'file') && clip.bytes == null
	return Number.isSafeInteger(clip.bytes) && clip.bytes >= 0 && clip.ref == null
}

function validBook(value) {
	if (!plainObject(value) || !Array.isArray(value.clips)) return false
	const seen = new Set()
	return value.clips.every((clip) => clipOk(clip, seen))
}

async function readCapped(req, cap) {
	const declared = req.headers?.['content-length']
	if (declared != null && declared !== '') {
		const n = Number(declared)
		if (!Number.isInteger(n) || n < 0 || n > cap) throw new RpcError('BAD_REQUEST', 'That clip is too big.')
	}
	const chunks = []
	let total = 0
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		total += buf.length
		if (total > cap) {
			req.destroy?.()
			throw new RpcError('BAD_REQUEST', 'That clip is too big.')
		}
		chunks.push(buf)
	}
	return Buffer.concat(chunks)
}

function decodeText(buf) {
	let text
	try {
		text = new TextDecoder('utf-8', {fatal: true}).decode(buf)
	} catch {
		throw new RpcError('BAD_REQUEST', 'That text isn’t valid.')
	}
	if (!text.trim()) throw new RpcError('BAD_REQUEST', 'There’s nothing to clip.')
	return text
}

function chunker(stream) {
	const it = stream[Symbol.asyncIterator]()
	let pending = Buffer.alloc(0)
	let done = false
	return async (n) => {
		while (pending.length < n && !done) {
			const step = await it.next()
			if (step.done) {
				done = true
				break
			}
			const part = Buffer.from(step.value)
			pending = pending.length ? Buffer.concat([pending, part]) : part
		}
		if (!pending.length) return Buffer.alloc(0)
		const out = pending.subarray(0, Math.min(n, pending.length))
		pending = pending.subarray(out.length)
		return Buffer.from(out)
	}
}

function disposition(name, inline) {
	const ascii = String(name || 'clip').replace(/[^\w. -]/g, '_').slice(0, 100) || 'clip'
	return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"`
}

// A percentage is printed only for a real number. An object from a sampler must not become "CPU [object Object]%".
function finite(v) {
	return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function cpuBit(v) {
	const n = finite(v)
	return n == null ? 'CPU' : `CPU ${Math.round(n)}%`
}
function statsPreview(scope, name, stats) {
	if (scope === 'server') {
		const used = finite(stats?.memory?.totalUsed)
		const size = finite(stats?.memory?.size)
		const memBit = used != null && size != null && size > 0 ? `memory ${Math.round(used / 1048576)} of ${Math.round(size / 1048576)} MB` : 'memory'
		return oneLine(`This server · ${cpuBit(stats?.cpu?.totalUsed)} · ${memBit}`)
	}
	if (scope === 'machine') {
		const mem = finite(stats?.last?.memMb)
		return oneLine(`${name || 'Machine'} · ${cpuBit(stats?.last?.cpu)} · ${mem == null ? 'memory' : `memory ${Math.round(mem)} MB`}`)
	}
	const used = finite(stats?.mem?.used)
	const total = finite(stats?.mem?.total)
	const memBit = used != null && total != null ? `memory ${Math.round(used / 1048576)} of ${Math.round(total / 1048576)} MB` : 'memory'
	return oneLine(`${name || 'Computer'} · ${cpuBit(stats?.cpu)} · ${memBit}`)
}

export function createClips({dataDir, files, fleet, readers = {}, roleOf = () => 'member', authenticate = () => null, urlUser = () => null, limits: override = {}, now = () => Date.now()} = {}) {
	const limits = {...CLIP_LIMITS, ...override}
	const tails = new Map()
	const withBook = (userId, fn) => {
		const prev = tails.get(userId) ?? Promise.resolve()
		const run = prev.catch(() => {}).then(fn)
		const tail = run.catch(() => {})
		tails.set(userId, tail)
		tail.then(() => {
			if (tails.get(userId) === tail) tails.delete(userId)
		})
		return run
	}

	function actor(auth) {
		const userId = String(auth?.userId ?? '')
		if (!USER_ID.test(userId)) throw new RpcError('FORBIDDEN', 'That account can’t keep a clip book')
		const given = auth?.role
		const role = given === 'owner' || given === 'member' ? given : roleOf(userId) === 'owner' ? 'owner' : 'member'
		return {userId, role}
	}
	const requireOwner = (who) => {
		if (who.role !== 'owner') throw new RpcError('FORBIDDEN', OWNER)
	}
	const bookDir = (userId) => join(dataDir, 'clips', userId)
	const bookFile = (userId) => join(bookDir(userId), 'book.json')

	async function ensure(userId) {
		const root = join(dataDir, 'clips')
		const dir = bookDir(userId)
		await mkdir(dir, {recursive: true, mode: 0o700})
		await chmod(root, 0o700)
		await chmod(dir, 0o700)
		return dir
	}
	async function load(userId) {
		const file = bookFile(userId)
		const state = await readJsonState(file, {validate: validBook, label: 'omarchyd'})
		if (state.damaged) return {damaged: true, clips: null, file}
		if (state.status === 'missing') return {damaged: false, clips: [], file}
		return {damaged: false, clips: state.value.clips, file}
	}
	const pub = (clip) => {
		const row = {id: clip.id, kind: clip.kind, at: clip.at, label: clip.label, where: clip.where, name: clip.name, preview: clip.preview}
		if (clip.cut) row.cut = true
		if (clip.bytes != null) row.bytes = clip.bytes
		if (clip.ref) row.ref = {scope: clip.ref.scope, path: clip.ref.path, ...(clip.ref.id ? {id: clip.ref.id} : {}), size: clip.ref.size ?? null, mtime: clip.ref.mtime ?? null}
		return row
	}
	const usedBytes = (clips) => clips.reduce((n, clip) => n + (Number.isSafeInteger(clip.bytes) ? clip.bytes : 0), 0)

	async function addRow(who, row, blob) {
		return withBook(who.userId, async () => {
			const book = await load(who.userId)
			if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
			if (book.clips.length >= limits.max) throw new RpcError('CONFLICT', FULL)
			if (blob && usedBytes(book.clips) + blob.length > limits.budget) throw new RpcError('CONFLICT', 'The clip book has reached its size limit. Remove a clip first.')
			const dir = await ensure(who.userId)
			if (blob) {
				const path = join(dir, `${row.id}.blob`)
				await writeFile(path, blob, {mode: 0o600})
				await chmod(path, 0o600)
				try {
					await writeAtomic(book.file, JSON.stringify({clips: [...book.clips, row]}, null, '\t'))
				} catch (error) {
					await rm(path, {force: true}).catch(() => {})
					throw error
				}
			} else {
				await writeAtomic(book.file, JSON.stringify({clips: [...book.clips, row]}, null, '\t'))
			}
			return pub(row)
		})
	}

	function textRow(text, meta) {
		const where = meta?.where === 'desktop' ? 'desktop' : 'terminal'
		const label = cleanLabel(meta?.label, oneLine(text, 80))
		return {
			id: randomBytes(8).toString('hex'),
			kind: 'text',
			at: now(),
			label,
			...(meta?.cut === true || meta?.cut === '1' ? {cut: true} : {}),
			where,
			name: fileName(label, '.txt'),
			bytes: Buffer.byteLength(text),
			preview: oneLine(text),
		}
	}
	async function addTextBuffer(who, buf, meta) {
		if (buf.length > limits.text) throw new RpcError('BAD_REQUEST', 'That clip is too big.')
		const text = decodeText(buf)
		const row = textRow(text, meta)
		row.bytes = buf.length
		return addRow(who, row, buf)
	}

	async function addStats(input, ctx) {
		const who = actor(ctx.auth)
		const scope = input?.scope
		if (scope !== 'server' && scope !== 'machine' && scope !== 'swarm') throw new RpcError('BAD_REQUEST', 'Choose this server, a machine, or a computer')
		if (scope !== 'server') requireOwner(who)
		let found = {name: 'This server', stats: null}
		if (scope === 'server') found = {name: 'This server', stats: await readers.server?.()}
		else if (scope === 'machine') {
			found = await readers.machine?.(String(input?.id ?? ''))
			if (!found?.name) throw new RpcError('NOT_FOUND', 'That machine isn’t on this server')
		} else {
			found = await readers.swarm?.(String(input?.id ?? ''))
			if (!found?.name) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		}
		let body
		try {
			body = JSON.stringify(found.stats ?? {})
		} catch {
			throw new RpcError('BAD_REQUEST', 'That snapshot can’t be kept.')
		}
		const buf = Buffer.from(body)
		if (buf.length > limits.stats) throw new RpcError('BAD_REQUEST', 'That snapshot is too big to keep.')
		const preview = statsPreview(scope, found.name, found.stats)
		const label = cleanLabel(input?.label, preview)
		const row = {id: randomBytes(8).toString('hex'), kind: 'stats', at: now(), label, where: scope, name: fileName(label, '.json'), bytes: buf.length, preview}
		return addRow(who, row, buf)
	}

	function vmPath(path) {
		const text = String(path ?? '')
		if (!text || text.length > 1024 || /[\u0000-\u001f\u007f]/.test(text)) return null
		return text
	}
	async function addFile(input, ctx) {
		const who = actor(ctx.auth)
		const scope = input?.scope
		if (scope === 'server') {
			const info = await files.describe(String(input?.path ?? ''))
			const label = cleanLabel(input?.label, info.name)
			const row = {
				id: randomBytes(8).toString('hex'),
				kind: 'file',
				at: now(),
				label,
				where: 'server',
				name: fileName(info.name),
				preview: oneLine(`${info.name} · ${info.size} bytes`),
				ref: {scope: 'server', path: info.path, size: info.size, mtime: info.mtimeMs},
			}
			return addRow(who, row, null)
		}
		if (scope === 'swarm') {
			requireOwner(who)
			const id = String(input?.id ?? '')
			const path = String(input?.path ?? '')
			const info = await fleet.stat(id, path)
			if (info?.dir) throw new RpcError('BAD_REQUEST', 'Choose a file')
			if (!Number.isSafeInteger(info?.size) || info.size < 0) throw new RpcError('BAD_GATEWAY', 'That computer didn’t say how big the file is')
			const label = cleanLabel(input?.label, info.name || 'file')
			const row = {
				id: randomBytes(8).toString('hex'),
				kind: 'file',
				at: now(),
				label,
				where: 'swarm',
				name: fileName(info.name || label),
				preview: oneLine(`${label} on that computer · ${info.size} bytes`),
				ref: {scope: 'swarm', path, id, size: info.size, mtime: Number.isSafeInteger(info.mtime) ? info.mtime : 0},
			}
			return addRow(who, row, null)
		}
		if (scope === 'machine') {
			requireOwner(who)
			const id = String(input?.id ?? '')
			const path = vmPath(input?.path)
			if (!path) throw new RpcError('BAD_REQUEST', 'Name the file on that machine')
			const found = await readers.machine?.(id)
			if (!found?.name) throw new RpcError('NOT_FOUND', 'That machine isn’t on this server')
			const base = path.split(/[/\\]/).filter(Boolean).at(-1) || 'file'
			const label = cleanLabel(input?.label, base)
			const row = {
				id: randomBytes(8).toString('hex'),
				kind: 'file',
				at: now(),
				label,
				where: 'machine',
				name: fileName(base),
				preview: oneLine(`${label} is still on ${found.name}`),
				ref: {scope: 'machine', path, id, size: null, mtime: null},
			}
			return addRow(who, row, null)
		}
		throw new RpcError('BAD_REQUEST', 'Choose a file on this server, a computer, or a machine')
	}

	async function list(_input, ctx) {
		const who = actor(ctx.auth)
		const book = await load(who.userId)
		if (book.damaged) return {clips: [], damaged: true}
		return {clips: book.clips.map(pub), damaged: false}
	}
	async function remove(input, ctx) {
		const who = actor(ctx.auth)
		return withBook(who.userId, async () => {
			const book = await load(who.userId)
			if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
			const id = String(input?.id ?? '')
			if (!CLIP_ID.test(id)) throw new RpcError('BAD_REQUEST', 'That clip isn’t in the book')
			if (!book.clips.some((clip) => clip.id === id)) throw new RpcError('NOT_FOUND', 'That clip isn’t in the book')
			await writeAtomic(book.file, JSON.stringify({clips: book.clips.filter((clip) => clip.id !== id)}, null, '\t'))
			await rm(join(bookDir(who.userId), `${id}.blob`), {force: true})
			return true
		})
	}

	async function take(who, id) {
		const book = await load(who.userId)
		if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
		if (!CLIP_ID.test(String(id ?? ''))) throw new RpcError('BAD_REQUEST', 'That clip isn’t in the book')
		const clip = book.clips.find((row) => row.id === id)
		if (!clip) throw new RpcError('NOT_FOUND', 'That clip isn’t in the book')
		return clip
	}
	async function blob(who, clip) {
		const path = join(bookDir(who.userId), `${clip.id}.blob`)
		const st = await stat(path).catch(() => null)
		if (!st?.isFile() || st.size !== clip.bytes) throw new RpcError('PRECONDITION_FAILED', 'That clip’s file is missing.')
		return path
	}
	async function textOf(who, clip) {
		if (clip.kind === 'stats') return clip.preview
		if (clip.kind !== 'text') throw new RpcError('BAD_REQUEST', clip.kind === 'image' ? 'Save that screenshot into a folder.' : 'Save that file into a folder.')
		if (clip.bytes > Math.min(PASTE_TEXT, limits.text)) throw new RpcError('BAD_REQUEST', 'That clip is too big to paste here. Save it into a folder.')
		return decodeText(await readFile(await blob(who, clip)))
	}

	async function freshServer(ref) {
		const info = await files.describe(ref.path)
		if (info.size !== ref.size || info.mtimeMs !== ref.mtime) throw new RpcError('CONFLICT', CHANGED)
		return info
	}
	async function freshSwarm(ref) {
		requireOwner({role: 'owner'})
		const info = await fleet.stat(ref.id, ref.path)
		const mtime = Number.isSafeInteger(info?.mtime) ? info.mtime : 0
		if (info?.dir || info?.size !== ref.size || mtime !== ref.mtime) throw new RpcError('CONFLICT', CHANGED)
		return info
	}
	async function transferFile() {
		const root = join(dataDir, 'clips')
		const dir = join(root, '.transfer')
		await mkdir(dir, {recursive: true, mode: 0o700})
		await chmod(root, 0o700)
		await chmod(dir, 0o700)
		return join(dir, randomBytes(8).toString('hex'))
	}
	async function pullToTemp(ref) {
		const tmp = await transferFile()
		const out = createWriteStream(tmp, {flags: 'wx', mode: 0o600})
		try {
			const meta = await fleet.pull(ref.id, ref.path, async (buf) => {
				if (!out.write(buf)) await once(out, 'drain')
			})
			out.end()
			await finished(out)
			if (meta?.size !== ref.size) throw new RpcError('CONFLICT', CHANGED)
			return tmp
		} catch (error) {
			out.destroy()
			await rm(tmp, {force: true}).catch(() => {})
			throw error
		}
	}

	async function intoFolder(who, clip, folder) {
		if (typeof folder !== 'string' || !folder.startsWith('/')) throw new RpcError('BAD_REQUEST', 'Choose a folder')
		if (clip.kind === 'file' && clip.ref.scope === 'machine') throw new RpcError('PRECONDITION_FAILED', STILL)
		if (clip.kind === 'file' && clip.ref.scope === 'server') {
			await freshServer(clip.ref)
			return files.copy({path: clip.ref.path, toDirectory: folder, collision: 'keep-both'})
		}
		if (clip.kind === 'file' && clip.ref.scope === 'swarm') {
			requireOwner(who)
			await freshSwarm(clip.ref)
			const tmp = await pullToTemp(clip.ref)
			try {
				return await files.saveNew(folder, clip.name, createReadStream(tmp), 'keep-both')
			} finally {
				await rm(tmp, {force: true}).catch(() => {})
			}
		}
		const path = await blob(who, clip)
		return files.saveNew(folder, clip.name, createReadStream(path), 'keep-both')
	}
	async function ontoComputer(who, clip, computer, path) {
		requireOwner(who)
		if (clip.kind === 'file' && clip.ref.scope === 'machine') throw new RpcError('PRECONDITION_FAILED', STILL)
		const dest = String(path ?? '')
		if (!dest) throw new RpcError('BAD_REQUEST', 'Name a file on that computer')
		let tmp = null
		try {
			let size
			let source
			if (clip.kind === 'file' && clip.ref.scope === 'server') {
				const info = await freshServer(clip.ref)
				size = info.size
				source = (await files.openRead(clip.ref.path)).stream
			} else if (clip.kind === 'file' && clip.ref.scope === 'swarm') {
				await freshSwarm(clip.ref)
				tmp = await pullToTemp(clip.ref)
				size = clip.ref.size
				source = createReadStream(tmp)
			} else {
				const file = await blob(who, clip)
				size = clip.bytes
				source = createReadStream(file)
			}
			try {
				await fleet.push(computer, dest, size, chunker(source))
			} finally {
				source.destroy()
			}
			return dest
		} finally {
			if (tmp) await rm(tmp, {force: true}).catch(() => {})
		}
	}

	async function paste(input, ctx) {
		const who = actor(ctx.auth)
		const clip = await take(who, input?.id)
		const dest = input?.dest
		if (dest === 'text' || dest?.text === true) return {text: await textOf(who, clip)}
		if (typeof dest?.folder === 'string') return {path: await intoFolder(who, clip, dest.folder)}
		if (typeof dest?.computer === 'string') return {path: await ontoComputer(who, clip, dest.computer, dest.path)}
		throw new RpcError('BAD_REQUEST', 'Choose where to paste it')
	}
	async function fleetList(input, ctx) {
		const who = actor(ctx.auth)
		requireOwner(who)
		return fleet.list(String(input?.id ?? ''), input?.path ?? '')
	}

	async function resetAll() {
		await rm(join(dataDir, 'clips'), {recursive: true, force: true})
	}

	function browser(req) {
		const auth = authenticate(req)
		if (!auth || auth.kind !== 'browser') return null
		return auth
	}
	async function httpText(req, res, url) {
		const auth = browser(req)
		if (!auth) return sendJson(res, 401, {error: 'unauthorized'})
		try {
			const clip = await addTextBuffer(actor(auth), await readCapped(req, limits.text), Object.fromEntries(url.searchParams))
			return sendJson(res, 200, {ok: true, clip})
		} catch (error) {
			if (!res.headersSent) return sendError(res, error)
			res.destroy()
		}
	}
	async function httpImage(req, res, url) {
		const auth = browser(req)
		if (!auth) return sendJson(res, 401, {error: 'unauthorized'})
		try {
			const buf = await readCapped(req, limits.image)
			if (buf.length < PNG.length || !buf.subarray(0, PNG.length).equals(PNG)) throw new RpcError('BAD_REQUEST', 'That isn’t a PNG screenshot.')
			const label = cleanLabel(url.searchParams.get('label'), 'Screenshot')
			const row = {id: randomBytes(8).toString('hex'), kind: 'image', at: now(), label, where: 'desktop', name: fileName(label, '.png'), bytes: buf.length, preview: 'Screenshot'}
			const clip = await addRow(actor(auth), row, buf)
			return sendJson(res, 200, {ok: true, clip})
		} catch (error) {
			if (!res.headersSent) return sendError(res, error)
			res.destroy()
		}
	}
	async function httpItem(req, res, url) {
		const auth = urlUser(url.searchParams.get('token'), req)
		if (!auth?.userId) return sendJson(res, 401, {error: 'unauthorized'})
		try {
			const who = actor(auth)
			const clip = await take(who, url.searchParams.get('id'))
			if (clip.kind === 'file' && clip.ref.scope === 'machine') throw new RpcError('PRECONDITION_FAILED', STILL)
			res.setHeader('X-Content-Type-Options', 'nosniff')
			res.setHeader('Cache-Control', 'private, no-store')
			// A finished GET also emits close. Stop the source only when the client left early.
			let clientLeft = false
			res.on('close', () => {
				if (!res.writableFinished) clientLeft = true
			})
			if (clip.kind === 'file' && clip.ref.scope === 'server') {
				const info = await freshServer(clip.ref)
				res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(info.size), 'content-disposition': disposition(clip.name, false)})
				const opened = await files.openRead(clip.ref.path)
				res.on('close', () => {
					if (!res.writableFinished) opened.stream.destroy()
				})
				opened.stream.on('error', () => res.destroy())
				return opened.stream.pipe(res)
			}
			if (clip.kind === 'file' && clip.ref.scope === 'swarm') {
				requireOwner(who)
				const info = await freshSwarm(clip.ref)
				res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(info.size), 'content-disposition': disposition(clip.name, false)})
				let failed = false
				await fleet.pull(clip.ref.id, clip.ref.path, async (buf) => {
					if (clientLeft || res.destroyed || req.destroyed) {
						failed = true
						throw new Error('closed')
					}
					if (!res.write(buf)) await once(res, 'drain')
				})
				if (!failed) res.end()
				return
			}
			const path = await blob(who, clip)
			const type = clip.kind === 'image' ? 'image/png' : clip.kind === 'stats' ? 'application/json' : 'text/plain; charset=utf-8'
			res.writeHead(200, {'content-type': type, 'content-length': String(clip.bytes), 'content-disposition': disposition(clip.name, clip.kind === 'image')})
			const stream = createReadStream(path)
			res.on('close', () => {
				if (!res.writableFinished) stream.destroy()
			})
			stream.on('error', () => res.destroy())
			return stream.pipe(res)
		} catch (error) {
			if (!res.headersSent) return sendError(res, error)
			res.destroy()
		}
	}

	const procedures = {
		'clips.list': {kind: 'query', run: list},
		'clips.addText': {kind: 'mutation', run: async (input, ctx) => {
			const buf = Buffer.from(String(input?.text ?? ''), 'utf8')
			if (buf.length > Math.min(RPC_TEXT, limits.text)) throw new RpcError('BAD_REQUEST', 'That clip is too big to send this way.')
			return addTextBuffer(actor(ctx.auth), buf, input ?? {})
		}},
		'clips.addStats': {kind: 'mutation', run: addStats},
		'clips.addFile': {kind: 'mutation', run: addFile},
		'clips.remove': {kind: 'mutation', run: remove},
		'clips.paste': {kind: 'mutation', run: paste},
		'clips.fleetList': {kind: 'query', run: fleetList},
	}

	return {procedures, resetAll, httpText, httpImage, httpItem}
}
