// Clip book: private per person, outside Home. A file is a reference. A damaged book is left as it is.
import assert from 'node:assert/strict'
import {symlink, utimes} from 'node:fs/promises'
import {mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {once} from 'node:events'
import os from 'node:os'
import {join} from 'node:path'
import {PassThrough} from 'node:stream'
import {test} from 'node:test'

import {CLIP_LIMITS, createClips} from '../omarchyd/clips.mjs'
import {createFiles} from '../omarchyd/files.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const owner = {userId: 'owner', role: 'owner'}
const member = {userId: 'sam', role: 'member'}
const modeOf = async (p) => (await stat(p)).mode & 0o777

function response() {
	const res = new PassThrough()
	const chunks = []
	res.on('data', (c) => chunks.push(Buffer.from(c)))
	const headers = {}
	let status = 0
	res.headersSent = false
	res.setHeader = (k, v) => {
		headers[String(k).toLowerCase()] = v
	}
	res.writeHead = (code, extra) => {
		status = code
		res.headersSent = true
		if (extra) for (const [k, v] of Object.entries(extra)) headers[String(k).toLowerCase()] = v
	}
	const finished = once(res, 'finish')
	return {
		res,
		headers,
		status: () => status,
		bytes: () => Buffer.concat(chunks),
		text: () => Buffer.concat(chunks).toString('utf8'),
		async done() {
			if (!res.writableEnded) await finished
		},
	}
}

function request({body = null, chunks = null, headers = {}, url = 'http://localhost/api/clips/text'} = {}) {
	const req = new PassThrough()
	req.headers = headers
	req.destroyed = false
	const orig = req.destroy.bind(req)
	req.destroy = () => {
		req.destroyed = true
		return orig()
	}
	queueMicrotask(() => {
		if (chunks) {
			for (const c of chunks) req.write(c)
			req.end()
		} else req.end(body ?? Buffer.alloc(0))
	})
	req.loc = new URL(url)
	return req
}

async function boot({limits, homeInside = false} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'clips-'))
	const home = join(root, 'home')
	const data = homeInside ? join(home, 'private-data') : join(root, 'data')
	await mkdir(join(home, 'Documents'), {recursive: true})
	await mkdir(data, {recursive: true})
	const files = createFiles({home, dataDir: data})
	const calls = []
	const stored = new Map()
	const key = (id, path) => `${id}\0${path}`
	const fleet = {
		async stat(id, path) {
			calls.push({op: 'stat', id, path})
			if (typeof path !== 'string' || path.includes('..') || path.startsWith('/') || path.startsWith('~') || path.includes('\\') || path.includes('\0')) {
				throw new RpcError('BAD_REQUEST', 'Use a path inside that computer’s home folder')
			}
			const row = stored.get(key(id, path))
			if (!row) throw new RpcError('NOT_FOUND', 'That file isn’t in your home folder')
			return {name: row.name, size: row.size, mtime: row.mtime, dir: !!row.dir}
		},
		async list(id, path) {
			calls.push({op: 'list', id, path})
			return {path: path ?? '', entries: [{name: 'docs', size: 0, mtime: 1, dir: true}], truncated: false}
		},
		async pull(id, path, writeChunk) {
			calls.push({op: 'pull', id, path})
			const row = stored.get(key(id, path))
			if (!row) throw new RpcError('NOT_FOUND', 'That file isn’t in your home folder')
			await writeChunk(Buffer.from(row.body))
			return {size: row.body.length, mtime: row.mtime}
		},
		async push(id, path, size, readChunk) {
			const parts = []
			for (;;) {
				const c = await readChunk(64 * 1024)
				if (!c?.length) break
				parts.push(Buffer.from(c))
			}
			const body = Buffer.concat(parts)
			calls.push({op: 'push', id, path, size, body})
			if (body.length !== size) throw new RpcError('BAD_GATEWAY', 'The file arrived short')
			stored.set(key(id, path), {name: path.split('/').at(-1), size, mtime: 1, dir: false, body})
			return {size}
		},
	}
	const readers = {
		server: async () => ({cpu: {totalUsed: 12.6, threads: 4}, memory: {totalUsed: 512 * 1048576, size: 1024 * 1048576}}),
		machine: async (id) => (id === 'abcd1234' ? {name: 'Dev', stats: {last: {cpu: 7, memMb: 512}}} : null),
		swarm: async (id) => (id === 'computer0001' ? {name: 'nix', stats: {cpu: 4, mem: {used: 256 * 1048576, total: 1024 * 1048576}}} : null),
	}
	const clips = createClips({
		dataDir: data,
		files,
		fleet,
		readers,
		limits,
		roleOf: (userId) => (userId === 'owner' ? 'owner' : undefined),
		authenticate: (req) => {
			const id = req.headers['x-user']
			if (!id) return null
			const kind = req.headers['x-kind'] || 'browser'
			if (kind !== 'browser') return {userId: id, role: id === 'owner' ? 'owner' : 'member', kind}
			return {userId: id, role: id === 'owner' ? 'owner' : 'member', kind: 'browser'}
		},
		urlUser: (token, req) => {
			if (token !== 'ok') return null
			if (!String(req.headers.cookie ?? '').includes('OMARCHY_BROWSER_SESSION=c')) return null
			const id = req.headers['x-user'] || 'owner'
			return {userId: id, role: id === 'owner' ? 'owner' : 'member'}
		},
		now: () => 1_700_000_000_000,
	})
	const ctx = (auth) => ({auth})
	return {root, home, data, files, fleet, calls, stored, key, readers, clips, ctx}
}

async function http(clips, method, req) {
	const res = response()
	await method(req, res.res, req.loc)
	await res.done()
	return res
}

test('production clip limits stay at the agreed caps', () => {
	assert.equal(CLIP_LIMITS.text, 256 * 1024)
	assert.equal(CLIP_LIMITS.image, 8 * 1024 * 1024)
	assert.equal(CLIP_LIMITS.stats, 256 * 1024)
	assert.equal(CLIP_LIMITS.budget, 100 * 1024 * 1024)
	assert.equal(CLIP_LIMITS.max, 200)
	assert.equal(CLIP_LIMITS.preview, 240)
})

test('a book starts empty, keeps text private, and refuses a bad account', async () => {
	const b = await boot()
	try {
		const empty = await b.clips.procedures['clips.list'].run(null, b.ctx(owner))
		assert.deepEqual(empty, {clips: [], damaged: false})
		const added = await b.clips.procedures['clips.addText'].run({text: 'hello clip', where: 'desktop', cut: true}, b.ctx(owner))
		assert.equal(added.kind, 'text')
		assert.equal(added.where, 'desktop')
		assert.equal(added.cut, true)
		assert.equal(added.preview, 'hello clip')
		assert.equal(Object.hasOwn(added, 'text'), false)
		assert.equal(JSON.stringify(added).includes('.blob'), false)
		const blob = join(b.data, 'clips', 'owner', `${added.id}.blob`)
		assert.equal(await readFile(blob, 'utf8'), 'hello clip')
		assert.equal(await modeOf(join(b.data, 'clips')), 0o700)
		assert.equal(await modeOf(join(b.data, 'clips', 'owner')), 0o700)
		assert.equal(await modeOf(blob), 0o600)
		assert.equal(await modeOf(join(b.data, 'clips', 'owner', 'book.json')), 0o600)
		const names = await readdir(join(b.data, 'clips', 'owner'))
		assert.deepEqual(names.filter((n) => n.endsWith('.blob')), [`${added.id}.blob`])
		await assert.rejects(() => b.clips.procedures['clips.addText'].run({text: '   '}, b.ctx(owner)), /nothing to clip/)
		await assert.rejects(() => b.clips.procedures['clips.addText'].run({text: 'x'}, b.ctx({userId: '../owner', role: 'owner'})), /account/)
		await assert.rejects(() => b.clips.procedures['clips.addText'].run({text: 'x'}, b.ctx({userId: 'a'.repeat(65), role: 'owner'})), /account/)
		const memberBook = await b.clips.procedures['clips.list'].run(null, b.ctx(member))
		assert.deepEqual(memberBook.clips, [])
		await assert.rejects(() => b.clips.procedures['clips.remove'].run({id: added.id}, b.ctx(member)), /isn’t in the book/)
		assert.equal(await readFile(blob, 'utf8'), 'hello clip')
		const noRole = await b.clips.procedures['clips.list'].run(null, {auth: {userId: 'owner'}})
		assert.equal(noRole.clips.length, 1)
		await b.clips.procedures['clips.remove'].run({id: added.id}, b.ctx(owner))
		assert.equal(await stat(blob).then(() => true, (e) => e.code !== 'ENOENT'), false)
		assert.deepEqual((await b.clips.procedures['clips.list'].run(null, b.ctx(owner))).clips, [])
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('parallel adds all land, and a full book is refused', async () => {
	const b = await boot({limits: {max: 2, budget: 100, text: 100}})
	try {
		await Promise.all(['one', 'two'].map((text) => b.clips.procedures['clips.addText'].run({text}, b.ctx(owner))))
		const listed = await b.clips.procedures['clips.list'].run(null, b.ctx(owner))
		assert.deepEqual(listed.clips.map((c) => c.preview).sort(), ['one', 'two'])
		await assert.rejects(() => b.clips.procedures['clips.addText'].run({text: 'three'}, b.ctx(owner)), (e) => {
			assert.equal(e.code, 'CONFLICT')
			assert.match(e.message, /full/)
			return true
		})
		assert.equal((await b.clips.procedures['clips.list'].run(null, b.ctx(owner))).clips.length, 2)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('the size budget counts inline clips and ignores a file reference', async () => {
	const b = await boot({limits: {budget: 10, text: 100, max: 10}})
	try {
		await writeFile(join(b.home, 'Documents', 'notes.txt'), 'this file is larger than the budget')
		await b.clips.procedures['clips.addText'].run({text: '12345678'}, b.ctx(owner))
		const file = await b.clips.procedures['clips.addFile'].run({scope: 'server', path: '/Home/Documents/notes.txt'}, b.ctx(owner))
		assert.equal(file.kind, 'file')
		assert.equal(file.bytes, undefined)
		assert.equal(file.ref.size, Buffer.byteLength('this file is larger than the budget'))
		const names = await readdir(join(b.data, 'clips', 'owner'))
		assert.equal(names.filter((n) => n.endsWith('.blob')).length, 1)
		await assert.rejects(() => b.clips.procedures['clips.addText'].run({text: '12345678'}, b.ctx(owner)), /size limit/)
		assert.equal((await b.clips.procedures['clips.list'].run(null, b.ctx(owner))).clips.length, 2)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a damaged book is left byte-for-byte and new clips are refused', async () => {
	const b = await boot()
	try {
		const dir = join(b.data, 'clips', 'owner')
		await mkdir(dir, {recursive: true})
		const raw = Buffer.from('{"secret":"clip-book-secret"')
		const file = join(dir, 'book.json')
		await writeFile(file, raw)
		const listed = await b.clips.procedures['clips.list'].run(null, b.ctx(owner))
		assert.equal(listed.damaged, true)
		assert.deepEqual(listed.clips, [])
		await assert.rejects(() => b.clips.procedures['clips.addText'].run({text: 'nope'}, b.ctx(owner)), (e) => {
			assert.equal(e.code, 'PRECONDITION_FAILED')
			assert.match(e.message, /damaged/)
			return true
		})
		await assert.rejects(() => b.clips.procedures['clips.remove'].run({id: '0123456789abcdef'}, b.ctx(owner)), /damaged/)
		assert.deepEqual(await readFile(file), raw)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('text and screenshots arrive over HTTP with a hard cap', async () => {
	const b = await boot({limits: {text: 8, image: 16, stats: 40, budget: 1000, max: 10}})
	try {
		const headers = {'x-user': 'owner', 'content-type': 'application/octet-stream'}
		const denied = await http(b.clips, b.clips.httpText, request({body: Buffer.from('hello'), headers: {}}))
		assert.equal(denied.status(), 401)
		const native = await http(b.clips, b.clips.httpText, request({body: Buffer.from('hello'), headers: {...headers, 'x-kind': 'native'}}))
		assert.equal(native.status(), 401)
		const bad = await http(b.clips, b.clips.httpText, request({body: Buffer.from([0xff, 0xfe]), headers}))
		assert.equal(bad.status(), 400)
		assert.match(bad.text(), /isn’t valid/)
		const over = await http(b.clips, b.clips.httpText, request({chunks: [Buffer.from('12345'), Buffer.from('67890')], headers}))
		assert.equal(over.status(), 400)
		assert.match(over.text(), /too big/)
		assert.equal(await stat(join(b.data, 'clips', 'owner', 'book.json')).then(() => true, () => false), false)
		const declared = await http(b.clips, b.clips.httpText, request({body: Buffer.from('123456789'), headers: {...headers, 'content-length': '9'}}))
		assert.equal(declared.status(), 400)
		const saved = await http(
			b.clips,
			b.clips.httpText,
			request({body: Buffer.from('desktop'), headers, url: 'http://localhost/api/clips/text?where=desktop&cut=1'}),
		)
		assert.equal(saved.status(), 200)
		const row = JSON.parse(saved.text()).clip
		assert.equal(row.where, 'desktop')
		assert.equal(row.cut, true)
		const png = Buffer.concat([PNG, Buffer.from('xx')])
		const image = await http(b.clips, b.clips.httpImage, request({body: png, headers, url: 'http://localhost/api/clips/image'}))
		assert.equal(image.status(), 200)
		const shot = JSON.parse(image.text()).clip
		assert.equal(shot.kind, 'image')
		assert.equal(shot.preview, 'Screenshot')
		const notPng = await http(b.clips, b.clips.httpImage, request({body: Buffer.from('GIF89a'), headers, url: 'http://localhost/api/clips/image'}))
		assert.equal(notPng.status(), 400)
		assert.match(notPng.text(), /isn’t a PNG/)
		const huge = Buffer.concat([PNG, Buffer.alloc(20)])
		const tooBig = await http(b.clips, b.clips.httpImage, request({body: huge, headers, url: 'http://localhost/api/clips/image'}))
		assert.equal(tooBig.status(), 400)
		const item = await http(
			b.clips,
			b.clips.httpItem,
			request({
				url: `http://localhost/api/clips/item?id=${shot.id}&token=ok`,
				headers: {cookie: 'OMARCHY_BROWSER_SESSION=c', 'x-user': 'owner'},
			}),
		)
		assert.equal(item.status(), 200)
		assert.match(String(item.headers['content-type']), /^image\/png/)
		assert.match(String(item.headers['content-disposition']), /inline/)
		assert.equal(item.headers['x-content-type-options'], 'nosniff')
		assert.deepEqual(item.bytes(), png)
		const stranger = await http(
			b.clips,
			b.clips.httpItem,
			request({
				url: `http://localhost/api/clips/item?id=${shot.id}&token=ok`,
				headers: {cookie: 'OMARCHY_BROWSER_SESSION=c', 'x-user': 'sam'},
			}),
		)
		assert.equal(stranger.status(), 404)
		assert.equal(stranger.text().includes(png.toString('utf8')), false)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a large text clip uses the raw route, and paste into a terminal stops at the short cap', async () => {
	const b = await boot()
	try {
		const big = 'x'.repeat(48 * 1024 + 1)
		await assert.rejects(() => b.clips.procedures['clips.addText'].run({text: big}, b.ctx(owner)), /too big to send this way/)
		const headers = {'x-user': 'owner', 'content-type': 'application/octet-stream', 'content-length': String(40 * 1024)}
		const body = Buffer.from('y'.repeat(40 * 1024))
		const saved = await http(b.clips, b.clips.httpText, request({body, headers}))
		assert.equal(saved.status(), 200)
		const row = JSON.parse(saved.text()).clip
		assert.equal(row.preview.length <= 240, true)
		assert.equal((await readFile(join(b.data, 'clips', 'owner', `${row.id}.blob`))).length, 40 * 1024)
		await assert.rejects(() => b.clips.procedures['clips.paste'].run({id: row.id, dest: 'text'}, b.ctx(owner)), /too big to paste/)
		const folder = await b.clips.procedures['clips.paste'].run({id: row.id, dest: {folder: '/Home/Documents'}}, b.ctx(owner))
		assert.match(folder.path, /^\/Home\/Documents\//)
		assert.equal((await readFile(join(b.home, 'Documents', folder.path.split('/').at(-1)))).length, 40 * 1024)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('stats paste is the one-line summary, and a member cannot clip another computer', async () => {
	const b = await boot()
	try {
		const server = await b.clips.procedures['clips.addStats'].run({scope: 'server'}, b.ctx(member))
		assert.match(server.preview, /^This server · CPU 13% · memory 512 of 1024 MB$/)
		const pasted = await b.clips.procedures['clips.paste'].run({id: server.id, dest: 'text'}, b.ctx(member))
		assert.equal(pasted.text, server.preview)
		assert.equal(pasted.text.includes('{'), false)
		const odd = await b.clips.procedures['clips.addStats'].run({scope: 'machine', id: 'abcd1234'}, b.ctx(owner))
		assert.match(odd.preview, /Dev · CPU 7% · memory 512 MB/)
		let machineReads = 0
		b.readers.machine = async () => {
			machineReads++
			return {name: 'Dev', stats: {last: {cpu: {total: 1}, memMb: 128}}}
		}
		await assert.rejects(() => b.clips.procedures['clips.addStats'].run({scope: 'machine', id: 'abcd1234'}, b.ctx(member)), /owner/)
		assert.equal(machineReads, 0)
		await assert.rejects(() => b.clips.procedures['clips.addFile'].run({scope: 'swarm', id: 'computer0001', path: 'docs/a.txt'}, b.ctx(member)), /owner/)
		assert.equal(b.calls.some((c) => c.op === 'stat'), false)
		const objectCpu = await b.clips.procedures['clips.addStats'].run({scope: 'machine', id: 'abcd1234'}, b.ctx(owner))
		assert.match(objectCpu.preview, /Dev · CPU · memory 128 MB/)
		assert.equal(objectCpu.preview.includes('[object'), false)
		assert.equal(objectCpu.preview.includes('%'), false)
		const computer = await b.clips.procedures['clips.addStats'].run({scope: 'swarm', id: 'computer0001'}, b.ctx(owner))
		assert.match(computer.preview, /nix · CPU 4% · memory 256 of 1024 MB/)
		await assert.rejects(() => b.clips.procedures['clips.fleetList'].run({id: 'computer0001', path: ''}, b.ctx(member)), /owner/)
		assert.equal(b.calls.some((c) => c.op === 'list'), false)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a server file is a reference, paste copies it, and a change stops the paste', async () => {
	const b = await boot()
	try {
		const file = join(b.home, 'Documents', 'notes.txt')
		await writeFile(file, 'alpha')
		await assert.rejects(() => b.clips.procedures['clips.addFile'].run({scope: 'server', path: '/Home/Documents'}, b.ctx(owner)), /Choose a file/)
		await assert.rejects(() => b.clips.procedures['clips.addFile'].run({scope: 'server', path: '/Home/../etc/passwd'}, b.ctx(owner)), /invalid-path|outside/)
		const clip = await b.clips.procedures['clips.addFile'].run({scope: 'server', path: '/Home/Documents/notes.txt'}, b.ctx(owner))
		assert.equal(clip.ref.scope, 'server')
		assert.equal(clip.ref.path, '/Home/Documents/notes.txt')
		assert.equal(await stat(join(b.data, 'clips', 'owner', `${clip.id}.blob`)).then(() => true, () => false), false)
		const copied = await b.clips.procedures['clips.paste'].run({id: clip.id, dest: {folder: '/Home'}}, b.ctx(owner))
		assert.equal(await readFile(join(b.home, 'notes.txt'), 'utf8'), 'alpha')
		assert.match(copied.path, /^\/Home\/notes\.txt$/)
		await utimes(file, new Date(), new Date(Date.now() + 120_000))
		await mkdir(join(b.home, 'Documents', 'Inbox'))
		await assert.rejects(() => b.clips.procedures['clips.paste'].run({id: clip.id, dest: {folder: '/Home/Documents/Inbox'}}, b.ctx(owner)), (e) => {
			assert.equal(e.code, 'CONFLICT')
			assert.match(e.message, /changed/)
			return true
		})
		assert.deepEqual(await readdir(join(b.home, 'Documents', 'Inbox')), [])
		assert.equal((await b.clips.procedures['clips.list'].run(null, b.ctx(owner))).clips.some((c) => c.id === clip.id), true)
		await writeFile(file, 'alpha')
		const grown = join(b.home, 'Documents', 'grown.txt')
		await writeFile(grown, 'beta')
		const second = await b.clips.procedures['clips.addFile'].run({scope: 'server', path: '/Home/Documents/grown.txt'}, b.ctx(owner))
		await writeFile(grown, 'beta!')
		await assert.rejects(() => b.clips.procedures['clips.paste'].run({id: second.id, dest: {folder: '/Home/Documents/Inbox'}}, b.ctx(owner)), /changed/)
		assert.deepEqual(await readdir(join(b.home, 'Documents', 'Inbox')), [])
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('the book is not served through Files, including by a symlink', async () => {
	const b = await boot({homeInside: true})
	try {
		const added = await b.clips.procedures['clips.addText'].run({text: 'secret-in-book'}, b.ctx(owner))
		const virtual = `/Home/private-data/clips/owner/${added.id}.blob`
		await assert.rejects(() => b.files.describe(virtual), (e) => {
			assert.equal(e.code, 'FORBIDDEN')
			return true
		})
		await symlink(join(b.data, 'clips', 'owner', `${added.id}.blob`), join(b.home, 'Documents', 'leak'))
		await assert.rejects(() => b.files.describe('/Home/Documents/leak'), (e) => {
			assert.equal(e.code, 'FORBIDDEN')
			return true
		})
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a virtual machine file stays a reference and is not read', async () => {
	const b = await boot()
	try {
		const clip = await b.clips.procedures['clips.addFile'].run({scope: 'machine', id: 'abcd1234', path: 'Documents/secret.txt'}, b.ctx(owner))
		assert.equal(clip.ref.size, null)
		assert.equal(clip.ref.mtime, null)
		assert.match(clip.preview, /still on Dev/)
		await assert.rejects(() => b.clips.procedures['clips.paste'].run({id: clip.id, dest: {folder: '/Home/Documents'}}, b.ctx(owner)), (e) => {
			assert.equal(e.code, 'PRECONDITION_FAILED')
			assert.match(e.message, /still on that computer/)
			return true
		})
		await assert.rejects(() => b.clips.procedures['clips.paste'].run({id: clip.id, dest: {computer: 'computer0001', path: 'out.txt'}}, b.ctx(owner)), /still on that computer/)
		assert.equal(b.calls.length, 0)
		const item = await http(
			b.clips,
			b.clips.httpItem,
			request({
				url: `http://localhost/api/clips/item?id=${clip.id}&token=ok`,
				headers: {cookie: 'OMARCHY_BROWSER_SESSION=c', 'x-user': 'owner'},
			}),
		)
		assert.equal(item.status(), 412)
		assert.match(item.text(), /still on that computer/)
		await assert.rejects(() => b.clips.procedures['clips.addFile'].run({scope: 'machine', id: 'missing', path: 'a'}, b.ctx(owner)), /isn’t on this server/)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a fleet file is streamed from the computer and a changed file is left there', async () => {
	const b = await boot()
	try {
		b.stored.set(b.key('computer0001', 'docs/note.txt'), {name: 'note.txt', size: 5, mtime: 10, dir: false, body: Buffer.from('hello')})
		await assert.rejects(() => b.clips.procedures['clips.addFile'].run({scope: 'swarm', id: 'computer0001', path: '../etc/passwd'}, b.ctx(owner)), /home folder/)
		assert.equal(b.calls.some((c) => c.op === 'pull'), false)
		const clip = await b.clips.procedures['clips.addFile'].run({scope: 'swarm', id: 'computer0001', path: 'docs/note.txt'}, b.ctx(owner))
		assert.equal(clip.ref.path, 'docs/note.txt')
		assert.equal(clip.ref.size, 5)
		const saved = await b.clips.procedures['clips.paste'].run({id: clip.id, dest: {folder: '/Home/Documents'}}, b.ctx(owner))
		assert.equal(await readFile(join(b.home, 'Documents', saved.path.split('/').at(-1)), 'utf8'), 'hello')
		assert.equal(b.calls.filter((c) => c.op === 'pull').at(-1).path, 'docs/note.txt')
		const pushed = await b.clips.procedures['clips.paste'].run({id: clip.id, dest: {computer: 'otherbox', path: 'out/note.txt'}}, b.ctx(owner))
		assert.equal(pushed.path, 'out/note.txt')
		const push = b.calls.filter((c) => c.op === 'push').at(-1)
		assert.equal(push.path, 'out/note.txt')
		assert.equal(push.size, 5)
		assert.equal(push.body.toString(), 'hello')
		b.stored.set(b.key('computer0001', 'docs/note.txt'), {name: 'note.txt', size: 6, mtime: 10, dir: false, body: Buffer.from('hello!')})
		const pulls = b.calls.filter((c) => c.op === 'pull').length
		await assert.rejects(() => b.clips.procedures['clips.paste'].run({id: clip.id, dest: {folder: '/Home'}}, b.ctx(owner)), /changed/)
		assert.equal(b.calls.filter((c) => c.op === 'pull').length, pulls)
		const serverFile = join(b.home, 'Documents', 'notes.txt')
		await writeFile(serverFile, 'from-server')
		const local = await b.clips.procedures['clips.addFile'].run({scope: 'server', path: '/Home/Documents/notes.txt'}, b.ctx(owner))
		await b.clips.procedures['clips.paste'].run({id: local.id, dest: {computer: 'computer0001', path: 'inbox/notes.txt'}}, b.ctx(owner))
		const onto = b.calls.filter((c) => c.op === 'push').at(-1)
		assert.equal(onto.path, 'inbox/notes.txt')
		assert.equal(onto.body.toString(), 'from-server')
		assert.equal(b.calls.filter((c) => c.op === 'pull' && c.path === 'inbox/notes.txt').length, 0)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a member book cannot be given a fleet file by writing the row', async () => {
	const b = await boot()
	try {
		const dir = join(b.data, 'clips', 'sam')
		await mkdir(dir, {recursive: true})
		await writeFile(join(dir, 'book.json'), JSON.stringify({
			clips: [{
				id: '0123456789abcdef',
				kind: 'file',
				at: 1,
				label: 'secret',
				where: 'swarm',
				name: 'secret.txt',
				preview: 'secret',
				ref: {scope: 'swarm', path: 'docs/secret.txt', id: 'computer0001', size: 4, mtime: 1},
			}],
		}))
		b.stored.set(b.key('computer0001', 'docs/secret.txt'), {name: 'secret.txt', size: 4, mtime: 1, dir: false, body: Buffer.from('nope')})
		await assert.rejects(() => b.clips.procedures['clips.paste'].run({id: '0123456789abcdef', dest: {folder: '/Home/Documents'}}, b.ctx(member)), /owner/)
		assert.equal(b.calls.some((c) => c.op === 'pull'), false)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('factory reset’s clip hook removes every book', async () => {
	const b = await boot()
	try {
		await b.clips.procedures['clips.addText'].run({text: 'secret-in-book'}, b.ctx(owner))
		await b.clips.procedures['clips.addText'].run({text: 'member secret'}, b.ctx(member))
		await b.clips.resetAll()
		assert.equal(await stat(join(b.data, 'clips')).then(() => false, (e) => e.code === 'ENOENT'), true)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})
