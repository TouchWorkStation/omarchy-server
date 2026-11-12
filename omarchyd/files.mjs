// Files: the web app's /Home is the owner's real home folder, and /Trash is the freedesktop trash
// (~/.local/share/Trash) that Omarchy's own file manager uses, so browser and desktop agree.
// Every path is resolved and checked to stay inside those folders, symlinks included.
import {createReadStream, createWriteStream} from 'node:fs'
import {cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises'
import {basename, dirname, extname, join, sep} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {randomBytes} from 'node:crypto'

import {RpcError} from './rpc.mjs'

const MIME = {
	jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
	mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
	mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus',
	pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', iso: 'application/x-iso9660-image',
	txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', sh: 'text/x-shellscript', py: 'text/x-python', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain', conf: 'text/plain', ini: 'text/plain',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers',
	ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
}
const typeFor = (name) => MIME[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'
// Shown inline when viewed; everything else is sent as a download.
const INLINE = /^(image\/(jpeg|png|gif|webp|avif|bmp)|video\/(mp4|webm|quicktime)|audio\/|application\/pdf|text\/plain)/

export function createFiles({home, dataDir}) {
	const trashRoot = join(home, '.local/share/Trash')
	const trashFiles = join(trashRoot, 'files')
	const trashInfo = join(trashRoot, 'info')
	const favoritesFile = join(dataDir, 'favorites.json')
	let homeReal = null
	const roots = async () => (homeReal ??= await realpath(home))

	// Virtual path -> real path, refusing anything outside /Home or /Trash.
	async function resolve(virtual, {mustExist = true} = {}) {
		if (typeof virtual !== 'string' || !virtual.startsWith('/') || virtual.includes('\0')) throw new RpcError('BAD_REQUEST', '[invalid-path]')
		const parts = virtual.split('/').filter(Boolean)
		if (parts.some((p) => p === '..' || p === '.')) throw new RpcError('BAD_REQUEST', '[invalid-path]')
		const [top, ...rest] = parts
		const base = top === 'Home' ? await roots() : top === 'Trash' ? trashFiles : null
		if (!base) throw new RpcError('NOT_FOUND', '[does-not-exist]')
		const real = join(base, ...rest)
		// Follow symlinks for what exists, and make sure we're still inside the base.
		const check = mustExist ? real : dirname(real)
		let resolved
		try {
			resolved = await realpath(check)
		} catch {
			throw new RpcError('NOT_FOUND', '[does-not-exist]')
		}
		const baseReal = top === 'Home' ? base : await realpath(base).catch(() => base)
		if (resolved !== baseReal && !resolved.startsWith(baseReal + sep)) throw new RpcError('FORBIDDEN', '[outside-home]')
		return {real, top, base}
	}
	// Trash lives inside Home, so it's checked first.
	const toVirtual = async (real) => {
		const h = await roots()
		const t = join(h, '.local/share/Trash/files')
		if (real === t || real.startsWith(t + sep)) return `/Trash${real.slice(t.length)}`
		if (real === trashFiles || real.startsWith(trashFiles + sep)) return `/Trash${real.slice(trashFiles.length)}`
		if (real === h || real.startsWith(h + sep)) return `/Home${real.slice(h.length)}`
		return null
	}

	async function entry(virtual, real, st) {
		st ??= await stat(real)
		const dir = st.isDirectory()
		const inTrash = virtual.startsWith('/Trash/')
		const name = virtual === '/Home' ? 'Home' : virtual === '/Trash' ? 'Trash' : basename(virtual)
		const type = dir ? 'directory' : typeFor(name)
		const top = virtual === '/Home' || virtual === '/Trash'
		return {
			name,
			path: virtual,
			type,
			...(dir ? {} : {size: st.size}),
			modified: st.mtimeMs,
			operations: top ? (virtual === '/Home' ? ['writable'] : []) : inTrash ? ['restore', 'delete'] : ['copy', 'move', 'rename', 'trash', 'favorite', 'writable'],
		}
	}
	const visible = (name) => !name.startsWith('.')

	async function list({path, sortBy = 'name', sortOrder = 'ascending'} = {}) {
		const {real} = await resolve(path)
		if (path === '/Trash') await mkdir(trashFiles, {recursive: true})
		const st = await stat(real)
		if (!st.isDirectory()) throw new RpcError('BAD_REQUEST', '[not-a-directory]')
		const names = (await readdir(real)).filter(visible)
		const files = []
		for (const n of names) {
			const r = join(real, n)
			const s = await stat(r).catch(() => null) // broken symlinks are skipped
			if (s) files.push(await entry(`${path}/${n}`, r, s))
		}
		const dirFirst = (a, b) => Number(b.type === 'directory') - Number(a.type === 'directory')
		const key = sortBy === 'modified' ? 'modified' : sortBy === 'size' ? 'size' : sortBy === 'type' ? 'type' : 'name'
		files.sort((a, b) => dirFirst(a, b) || (key === 'name' || key === 'type' ? String(a[key]).localeCompare(String(b[key]), undefined, {numeric: true, sensitivity: 'base'}) : (a[key] ?? 0) - (b[key] ?? 0)))
		if (sortOrder === 'descending') files.reverse()
		return {...(await entry(path, real, st)), files, hasMore: false, totalFiles: files.length}
	}

	// A free name next to the original: "Report (2).pdf".
	async function freeName(dir, name) {
		const ext = extname(name)
		const stem = ext ? name.slice(0, -ext.length) : name
		for (let n = 1; ; n++) {
			const candidate = join(dir, n === 1 ? name : `${stem} (${n})${ext}`)
			try {
				await lstat(candidate)
			} catch {
				return candidate
			}
		}
	}
	const validName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 255 && !n.includes('/') && !n.includes('\0') && n !== '.' && n !== '..'

	async function createDirectory({path}) {
		if (!validName(basename(path))) throw new RpcError('BAD_REQUEST', '[invalid-name]')
		const {real} = await resolve(path, {mustExist: false})
		await mkdir(real).catch((e) => {
			if (e.code === 'EEXIST') throw new RpcError('CONFLICT', '[already-exists]')
			throw e
		})
		return path
	}
	async function renameItem({path, newName}) {
		if (!validName(newName)) throw new RpcError('BAD_REQUEST', '[invalid-name]')
		const {real} = await resolve(path)
		const target = join(dirname(real), newName)
		if (await lstat(target).then(() => true, () => false)) throw new RpcError('CONFLICT', '[already-exists]')
		await rename(real, target)
		return toVirtual(target)
	}
	async function moveOrCopy({path, toDirectory, collision = 'keep-both'}, copy) {
		const {real} = await resolve(path)
		const {real: dest} = await resolve(toDirectory)
		if (dest === real || dest.startsWith(real + sep)) throw new RpcError('BAD_REQUEST', '[subdir-of-self]')
		let target = join(dest, basename(real))
		if (await lstat(target).then(() => true, () => false)) {
			if (collision === 'error') throw new RpcError('CONFLICT', '[already-exists]')
			if (collision === 'replace') await rm(target, {recursive: true, force: true})
			else target = await freeName(dest, basename(real))
		}
		if (copy) await cp(real, target, {recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true})
		else
			await rename(real, target).catch(async (e) => {
				if (e.code !== 'EXDEV') throw e
				await cp(real, target, {recursive: true, verbatimSymlinks: true})
				await rm(real, {recursive: true, force: true})
			})
		return toVirtual(target)
	}

	// Trash the freedesktop way: the item in Trash/files, a .trashinfo with where it came from.
	async function trash({path}) {
		const {real, top} = await resolve(path)
		if (top !== 'Home' || path === '/Home') throw new RpcError('BAD_REQUEST', '[cannot-trash]')
		await mkdir(trashFiles, {recursive: true})
		await mkdir(trashInfo, {recursive: true})
		const target = await freeName(trashFiles, basename(real))
		const info = `[Trash Info]\nPath=${encodeURI(real)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`
		await writeFile(join(trashInfo, `${basename(target)}.trashinfo`), info)
		await rename(real, target).catch(async (e) => {
			if (e.code !== 'EXDEV') throw e
			await cp(real, target, {recursive: true, verbatimSymlinks: true})
			await rm(real, {recursive: true, force: true})
		})
		return toVirtual(target)
	}
	async function restore({path}) {
		const {real, top} = await resolve(path)
		if (top !== 'Trash') throw new RpcError('BAD_REQUEST', '[not-in-trash]')
		const infoFile = join(trashInfo, `${basename(real)}.trashinfo`)
		const original = /^Path=(.*)$/m.exec(await readFile(infoFile, 'utf8').catch(() => ''))?.[1]
		let dest = original ? decodeURI(original) : join(await roots(), basename(real))
		const h = await roots()
		if (!dest.startsWith(h + sep)) dest = join(h, basename(real))
		await mkdir(dirname(dest), {recursive: true})
		if (await lstat(dest).then(() => true, () => false)) dest = await freeName(dirname(dest), basename(dest))
		await rename(real, dest)
		await rm(infoFile, {force: true})
		return toVirtual(dest)
	}
	async function deleteItem({path}) {
		const {real, top} = await resolve(path)
		if (top !== 'Trash' || path === '/Trash') throw new RpcError('BAD_REQUEST', '[only-from-trash]')
		await rm(real, {recursive: true, force: true})
		await rm(join(trashInfo, `${basename(real)}.trashinfo`), {force: true})
		return true
	}
	async function emptyTrash() {
		for (const n of await readdir(trashFiles).catch(() => [])) await rm(join(trashFiles, n), {recursive: true, force: true})
		for (const n of await readdir(trashInfo).catch(() => [])) await rm(join(trashInfo, n), {force: true})
		return true
	}

	// Walk Home (skipping hidden folders) for search and recents, with a hard cap.
	async function walk(visit, {limit = 20000} = {}) {
		const h = await roots()
		const queue = [h]
		let seen = 0
		while (queue.length && seen < limit) {
			const dir = queue.shift()
			const items = await readdir(dir, {withFileTypes: true}).catch(() => [])
			for (const d of items) {
				if (!visible(d.name) || d.name === 'node_modules') continue
				seen++
				const r = join(dir, d.name)
				if (d.isDirectory()) queue.push(r)
				if (d.isDirectory() || d.isFile()) await visit(r, d)
			}
		}
	}
	async function search({query}) {
		const q = String(query ?? '').trim().toLowerCase()
		if (!q) return []
		const out = []
		await walk(async (r, d) => {
			if (out.length < 50 && d.name.toLowerCase().includes(q)) out.push(r)
		})
		return Promise.all(out.map(async (r) => entry(await toVirtual(r), r)))
	}
	async function recents() {
		const found = []
		await walk(async (r, d) => {
			if (!d.isFile()) return
			const s = await stat(r).catch(() => null)
			if (s) found.push({r, s})
		})
		found.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
		return Promise.all(found.slice(0, 30).map(async ({r, s}) => entry(await toVirtual(r), r, s)))
	}

	const readFavorites = async () => JSON.parse(await readFile(favoritesFile, 'utf8').catch(() => '[]'))
	async function favorites() {
		const keep = []
		for (const p of await readFavorites()) if (await resolve(p).then(() => true, () => false)) keep.push(p)
		return keep
	}
	async function setFavorite(path, on) {
		await resolve(path)
		const set = new Set(await readFavorites())
		on ? set.add(path) : set.delete(path)
		await writeFile(favoritesFile, JSON.stringify([...set]), {mode: 0o600})
		return true
	}

	// ---- HTTP: view, download, upload -------------------------------------------------------
	async function serveFile(req, res, url, kind) {
		const paths = url.searchParams.getAll('path')
		if (paths.length !== 1) return endPlain(res, 501, 'Downloading several items or a folder isn’t supported yet')
		let real
		try {
			;({real} = await resolve(paths[0]))
		} catch {
			return endPlain(res, 404, 'Not found')
		}
		const st = await stat(real).catch(() => null)
		if (!st) return endPlain(res, 404, 'Not found')
		if (st.isDirectory()) return endPlain(res, 501, 'Downloading a folder isn’t supported yet')
		const name = basename(real)
		const type = typeFor(name)
		const inline = kind === 'view' && INLINE.test(type)
		const headers = {
			'content-type': kind === 'view' && !INLINE.test(type) && !type.startsWith('image/svg') ? 'application/octet-stream' : type,
			'accept-ranges': 'bytes',
			'last-modified': st.mtime.toUTCString(),
			'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
			'x-content-type-options': 'nosniff',
		}
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
		if (range && (range[1] || range[2])) {
			let start = range[1] ? Number(range[1]) : st.size - Number(range[2])
			let end = range[1] && range[2] ? Number(range[2]) : st.size - 1
			start = Math.max(0, start)
			end = Math.min(st.size - 1, end)
			if (start > end) {
				res.writeHead(416, {'content-range': `bytes */${st.size}`})
				return res.end()
			}
			res.writeHead(206, {...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': String(end - start + 1)})
			return pipeline(createReadStream(real, {start, end}), res).catch(() => res.destroy())
		}
		res.writeHead(200, {...headers, 'content-length': String(st.size)})
		return pipeline(createReadStream(real), res).catch(() => res.destroy())
	}
	async function upload(req, res, url) {
		const path = url.searchParams.get('path')
		const collision = url.searchParams.get('collision') ?? 'keep-both'
		let real
		try {
			if (!validName(basename(path ?? ''))) throw new RpcError('BAD_REQUEST', '[invalid-name]')
			;({real} = await resolve(path, {mustExist: false}))
		} catch (e) {
			return endJson(res, e instanceof RpcError && e.code === 'NOT_FOUND' ? 404 : 400, {error: e.message})
		}
		const exists = await lstat(real).then((s) => s, () => null)
		if (exists?.isDirectory()) return endJson(res, 409, {error: '[is-a-directory]'})
		if (exists && collision === 'error') return endJson(res, 409, {error: '[already-exists]'})
		const target = exists && collision !== 'replace' ? await freeName(dirname(real), basename(real)) : real
		// Write to a temporary file first, so a broken upload never leaves half a file behind.
		const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.uploading`)
		try {
			await pipeline(req, createWriteStream(tmp, {flags: 'wx', mode: 0o644}))
			await rename(tmp, target)
		} catch {
			await rm(tmp, {force: true})
			return endJson(res, 500, {error: 'Upload failed'})
		}
		return endJson(res, 200, {path: await toVirtual(target)})
	}

	return {
		procedures: {
			'files.list': {kind: 'query', run: (i) => list(i)},
			'files.search': {kind: 'query', run: (i) => search(i ?? {})},
			'files.recents': {kind: 'query', run: () => recents()},
			'files.favorites': {kind: 'query', run: () => favorites()},
			'files.addFavorite': {kind: 'mutation', run: ({path}) => setFavorite(path, true)},
			'files.removeFavorite': {kind: 'mutation', run: ({path}) => setFavorite(path, false)},
			'files.createDirectory': {kind: 'mutation', run: (i) => createDirectory(i)},
			'files.rename': {kind: 'mutation', run: (i) => renameItem(i)},
			'files.copy': {kind: 'mutation', run: (i) => moveOrCopy(i, true)},
			'files.move': {kind: 'mutation', run: (i) => moveOrCopy(i, false)},
			'files.trash': {kind: 'mutation', run: (i) => trash(i)},
			'files.restore': {kind: 'mutation', run: (i) => restore(i)},
			'files.delete': {kind: 'mutation', run: (i) => deleteItem(i)},
			'files.emptyTrash': {kind: 'mutation', run: () => emptyTrash()},
			'files.operationProgress': {kind: 'query', run: () => []},
			'files.externalDevices': {kind: 'query', run: () => []},
		},
		serveFile,
		upload,
		resolve,
	}
}

function endPlain(res, status, text) {
	res.writeHead(status, {'content-type': 'text/plain; charset=utf-8'})
	res.end(text)
}
function endJson(res, status, body) {
	res.writeHead(status, {'content-type': 'application/json'})
	res.end(JSON.stringify(body))
}
