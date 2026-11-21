// The server side of the connector file channel. A browser socket must not be able to open it,
// and file bytes must not be forwarded to a desktop or a terminal.
import assert from 'node:assert/strict'
import {createHash, randomBytes} from 'node:crypto'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import WebSocket from 'ws'

import {createConnector} from '../omarchyd/connector.mjs'

const FILE_CHUNK = 64 * 1024

function fakeBrowser() {
	const listeners = new Map()
	const sent = []
	const closes = []
	const ws = {
		OPEN: 1,
		readyState: 1,
		bufferedAmount: 0,
		send(data, opts) {
			sent.push({data: Buffer.from(data), opts})
		},
		close(code, reason) {
			closes.push({code, reason: String(reason ?? '')})
			this.readyState = 3
			for (const fn of listeners.get('close') ?? []) fn(code, reason)
		},
		on(ev, fn) {
			const list = listeners.get(ev) ?? []
			list.push(fn)
			listeners.set(ev, list)
		},
	}
	return {ws, sent, closes}
}

async function until(fn, ms = 1000) {
	const end = Date.now() + ms
	let last
	while (Date.now() < end) {
		last = await fn()
		if (last) return last
		await new Promise((r) => setTimeout(r, 10))
	}
	return last
}

function framesFor(fromAgent, ch) {
	return fromAgent.filter((m) => m.binary && m.binary.readUInt32BE(0) === ch)
}

async function withAgent(allowed, run) {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'swarm-files-'))
	const id = 'aabbccddeeff'
	const key = randomBytes(32).toString('base64url')
	const keyHash = createHash('sha256').update(key).digest('hex')
	await writeFile(join(dataDir, 'swarm.json'), JSON.stringify({
		agents: [{id, name: 'desk', keyHash, allowed, on: {...allowed}, enrolledAt: 1, lastSeen: null, info: {hostname: 'desk'}}],
	}))
	const c = createConnector({dataDir, tlsDir: dataDir})
	const server = http.createServer()
	server.on('upgrade', (req, socket, head) => {
		c.upgradeAgent(req, socket, head).catch(() => socket.destroy())
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const agentWs = new WebSocket(`ws://127.0.0.1:${server.address().port}/`, {headers: {authorization: `Bearer ${id}:${key}`}})
	const fromAgent = []
	agentWs.on('message', (d, isBinary) => {
		if (isBinary) fromAgent.push({binary: Buffer.from(d)})
		else fromAgent.push(JSON.parse(String(d)))
	})
	try {
		await new Promise((resolve, reject) => (agentWs.once('open', resolve), agentWs.once('error', reject)))
		await run({c, id, agentWs, fromAgent})
	} finally {
		agentWs.terminate()
		c.close()
		await new Promise((r) => server.close(r))
		// The socket close saves swarm.json after the server has closed. Give that write a moment.
		for (let n = 0; n < 10; n++) {
			try {
				await rm(dataDir, {recursive: true, force: true})
				break
			} catch (e) {
				if (e.code !== 'ENOTEMPTY' || n === 9) throw e
				await new Promise((r) => setTimeout(r, 20))
			}
		}
	}
}

const filesOn = {terminal: true, desktop: true, manage: false, storage: false, backup: false, files: true}
const filesOff = {...filesOn, files: false}

test('files stay off until the computer is paired with them', {timeout: 5000}, async () => {
	await withAgent(filesOff, async ({c, id, fromAgent}) => {
		await assert.rejects(c.files.stat(id, 'notes.txt'), /Files switched on/)
		await assert.rejects(c.files.pull(id, 'notes.txt', async () => {}), /Files switched on/)
		await new Promise((r) => setTimeout(r, 30))
		assert.equal(fromAgent.some((m) => m.op === 'open' || m.op === 'call'), false)
	})
})

test('a browser cannot open a file channel', {timeout: 5000}, async () => {
	await withAgent(filesOn, async ({c, id, fromAgent}) => {
		const browser = fakeBrowser()
		c.openChannel(id, 'file', browser.ws)
		assert.equal(browser.closes.length, 1)
		assert.equal(browser.closes[0].code, 1011)
		assert.match(browser.closes[0].reason, /terminal or a desktop/)
		await new Promise((r) => setTimeout(r, 30))
		assert.equal(fromAgent.some((m) => m.op === 'open'), false)
	})
})

test('a path that leaves home is refused before the computer is asked', {timeout: 5000}, async () => {
	await withAgent(filesOn, async ({c, id, fromAgent}) => {
		await assert.rejects(c.files.pull(id, '../etc/passwd', async () => {}), /home folder/)
		await assert.rejects(c.files.push(id, '/etc/passwd', 1, async () => Buffer.from('x')), /home folder/)
		await assert.rejects(c.files.list(id, 'docs/../../secret'), /home folder/)
		await new Promise((r) => setTimeout(r, 30))
		assert.equal(fromAgent.some((m) => m.op === 'open' || m.op === 'call'), false)
	})
})

test('a pull acks each chunk and does not give those bytes to a browser', {timeout: 5000}, async () => {
	await withAgent(filesOn, async ({c, id, agentWs, fromAgent}) => {
		const browser = fakeBrowser()
		c.openChannel(id, 'pty', browser.ws, {cols: 80, rows: 24})
		const pty = await until(() => fromAgent.find((m) => m.op === 'open' && m.kind === 'pty'))
		assert.ok(pty)
		const got = []
		const pull = c.files.pull(id, 'docs/note.txt', async (buf) => {
			got.push(Buffer.from(buf))
		})
		const open = await until(() => fromAgent.find((m) => m.op === 'open' && m.kind === 'file'))
		assert.equal(open.mode, 'read')
		assert.equal(open.path, 'docs/note.txt')
		agentWs.send(JSON.stringify({op: 'file', ch: open.ch, size: 5, mtime: 42}))
		const frame = Buffer.alloc(4 + 5)
		frame.writeUInt32BE(open.ch)
		frame.write('hello', 4)
		agentWs.send(frame)
		const acked = await until(() => fromAgent.some((m) => m.op === 'ack' && m.ch === open.ch))
		assert.equal(acked, true)
		agentWs.send(JSON.stringify({op: 'closed', ch: open.ch, code: 1000, reason: ''}))
		const result = await pull
		assert.equal(Buffer.concat(got).toString(), 'hello')
		assert.deepEqual(result, {size: 5, mtime: 42})
		assert.equal(browser.sent.length, 0)
		const viewer = Buffer.alloc(4 + 3)
		viewer.writeUInt32BE(pty.ch)
		viewer.write('xyz', 4)
		agentWs.send(viewer)
		assert.equal(await until(() => browser.sent.length === 1), true)
		assert.equal(browser.sent[0].data.toString(), 'xyz')
	})
})

test('extra bytes end the pull and the clip is not kept open', {timeout: 5000}, async () => {
	await withAgent(filesOn, async ({c, id, agentWs, fromAgent}) => {
		const pull = c.files.pull(id, 'note.txt', async () => {})
		const open = await until(() => fromAgent.find((m) => m.op === 'open'))
		agentWs.send(JSON.stringify({op: 'file', ch: open.ch, size: 3, mtime: 1}))
		const frame = Buffer.alloc(4 + 4)
		frame.writeUInt32BE(open.ch)
		frame.write('abcd', 4)
		agentWs.send(frame)
		await assert.rejects(pull, /larger than it said/)
		assert.equal(await until(() => fromAgent.some((m) => m.op === 'close' && m.ch === open.ch)), true)
	})
})

test('a push waits for acks, then commits', {timeout: 5000}, async () => {
	await withAgent(filesOn, async ({c, id, agentWs, fromAgent}) => {
		const payload = Buffer.alloc(FILE_CHUNK * 4 + 10, 7)
		let offset = 0
		const push = c.files.push(id, 'out.bin', payload.length, async (n) => {
			const chunk = Buffer.from(payload.subarray(offset, offset + n))
			offset += chunk.length
			return chunk
		})
		const open = await until(() => fromAgent.find((m) => m.op === 'open' && m.mode === 'write'))
		assert.equal(open.path, 'out.bin')
		assert.equal(open.size, payload.length)
		agentWs.send(JSON.stringify({op: 'file', ch: open.ch, ready: true}))
		const first = await until(() => framesFor(fromAgent, open.ch).length >= 4)
		assert.ok(first)
		await new Promise((r) => setTimeout(r, 40))
		assert.equal(framesFor(fromAgent, open.ch).length, 4)
		for (let n = 0; n < 4; n++) agentWs.send(JSON.stringify({op: 'ack', ch: open.ch}))
		assert.equal(await until(() => framesFor(fromAgent, open.ch).length === 5), true)
		agentWs.send(JSON.stringify({op: 'ack', ch: open.ch}))
		const commit = await until(() => fromAgent.find((m) => m.op === 'commit' && m.ch === open.ch))
		assert.ok(commit)
		const body = Buffer.concat(framesFor(fromAgent, open.ch).map((m) => m.binary.subarray(4)))
		assert.deepEqual(body, payload)
		agentWs.send(JSON.stringify({op: 'closed', ch: open.ch, code: 1000, reason: ''}))
		assert.deepEqual(await push, {size: payload.length})
	})
})

test('the computer refusing a name stops the push', {timeout: 5000}, async () => {
	await withAgent(filesOn, async ({c, id, agentWs, fromAgent}) => {
		const push = c.files.push(id, 'taken.txt', 4, async () => Buffer.from('nope'))
		const open = await until(() => fromAgent.find((m) => m.op === 'open'))
		agentWs.send(JSON.stringify({op: 'file', ch: open.ch, ready: true}))
		await until(() => framesFor(fromAgent, open.ch).length === 1)
		agentWs.send(JSON.stringify({op: 'closed', ch: open.ch, code: 1011, reason: 'A file with that name is already there'}))
		await assert.rejects(push, /already there/)
	})
})

test('dropping the computer rejects a transfer that is still open', {timeout: 5000}, async () => {
	await withAgent(filesOn, async ({c, id, agentWs, fromAgent}) => {
		const pull = c.files.pull(id, 'note.txt', async () => {})
		await until(() => fromAgent.find((m) => m.op === 'open'))
		agentWs.close()
		await assert.rejects(pull, /offline|reconnected/)
	})
})

test('switching files off ends a transfer that is already open', {timeout: 5000}, async () => {
	await withAgent(filesOn, async ({c, id, fromAgent}) => {
		const pull = c.files.pull(id, 'note.txt', async () => {})
		const open = await until(() => fromAgent.find((m) => m.op === 'open'))
		await c.procedures['swarm.setAbilities'].run({id, files: false})
		await assert.rejects(pull, /isn’t switched on/)
		assert.equal(await until(() => fromAgent.some((m) => m.op === 'close' && m.ch === open.ch)), true)
	})
})

test('stat and list ask the computer and drop a row that is not a file name', {timeout: 5000}, async () => {
	await withAgent(filesOn, async ({c, id, agentWs, fromAgent}) => {
		const stat = c.files.stat(id, 'docs\\note.txt')
		const call = await until(() => fromAgent.find((m) => m.op === 'call' && m.name === 'files-stat'))
		assert.equal(call.args.path, 'docs/note.txt')
		agentWs.send(JSON.stringify({op: 'result', id: call.id, ok: true, data: {name: 'note.txt', size: 4, mtime: 9, dir: false}}))
		assert.deepEqual(await stat, {name: 'note.txt', size: 4, mtime: 9, dir: false})
		const list = c.files.list(id, '')
		const listed = await until(() => fromAgent.find((m) => m.op === 'call' && m.name === 'files-list'))
		assert.equal(listed.args.path, '')
		agentWs.send(JSON.stringify({
			op: 'result',
			id: listed.id,
			ok: true,
			data: {path: '', truncated: false, entries: [{name: 'ok.txt', size: 1, mtime: 2, dir: false}, {name: '../x', size: 1, mtime: 2, dir: false}, {name: 'dir', size: 9, mtime: 3, dir: true}]},
		}))
		assert.deepEqual(await list, {
			path: '',
			truncated: false,
			entries: [
				{name: 'ok.txt', size: 1, mtime: 2, dir: false},
				{name: 'dir', size: 0, mtime: 3, dir: true},
			],
		})
	})
})
