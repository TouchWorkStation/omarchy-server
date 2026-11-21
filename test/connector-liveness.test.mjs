// Connectors that stop answering WebSocket pings are marked offline instead of hanging calls.
import assert from 'node:assert/strict'
import {createHash, randomBytes} from 'node:crypto'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import WebSocket from 'ws'

import {createConnector} from '../omarchyd/connector.mjs'
import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

const ABILITIES = {terminal: false, desktop: false, manage: false, storage: true, backup: false}

async function until(fn, ms = 2000) {
	const end = Date.now() + ms
	for (;;) {
		const v = await fn().catch(() => null)
		if (v) return v
		if (Date.now() > end) throw new Error('timed out')
		await new Promise((r) => setTimeout(r, 20))
	}
}

function rejectAfter(promise, ms) {
	let timer
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms)
		}),
	])
}

async function setupDirect(t, {pingInterval = 60} = {}) {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'swarm-liveness-'))
	const id = 'aabbccddeeff'
	const key = randomBytes(32).toString('base64url')
	await writeFile(
		join(dataDir, 'swarm.json'),
		JSON.stringify({
			agents: [
				{
					id,
					name: 'laptop',
					keyHash: createHash('sha256').update(key).digest('hex'),
					allowed: ABILITIES,
					on: ABILITIES,
					enrolledAt: 1,
					lastSeen: null,
					info: {hostname: 'laptop'},
				},
			],
		}),
	)
	const c = createConnector({dataDir, tlsDir: dataDir, pingInterval})
	const server = http.createServer((_req, res) => (res.statusCode = 404, res.end()))
	server.on('upgrade', (req, socket, head) => {
		c.upgradeAgent(req, socket, head).catch(() => socket.destroy())
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const sockets = []
	t.after(async () => {
		for (const ws of sockets) ws.terminate()
		c.close()
		await new Promise((r) => server.close(r))
		await rm(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	})
	const connect = async (url, opts = {}) => {
		const ws = new WebSocket(url, {headers: {authorization: `Bearer ${id}:${key}`}, ...opts})
		sockets.push(ws)
		await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)))
		ws.send(JSON.stringify({op: 'hello', info: {hostname: 'laptop'}, abilities: ABILITIES}))
		await until(async () => {
			const [a] = await c.procedures['swarm.list'].run()
			return a?.online && a.lastSeen !== null
		})
		return ws
	}
	return {c, id, key, directUrl: `ws://127.0.0.1:${server.address().port}/connector/ws`, directServer: server, dataDir, connect}
}

test('direct connector that ignores pings is marked offline and fails pending storage calls', async (t) => {
	const {c, id, directUrl, connect} = await setupDirect(t, {pingInterval: 60})
	await connect(directUrl, {autoPong: false})
	const disksCall = c.procedures['swarm.storage.disks'].run({id})
	await assert.rejects(() => rejectAfter(disksCall, 1000), /offline/i)
	const [a] = await c.procedures['swarm.list'].run()
	assert.equal(a.online, false)
})

test('direct connector that answers pings stays online across multiple ping intervals', async (t) => {
	const {c, directUrl, connect} = await setupDirect(t, {pingInterval: 60})
	await connect(directUrl, {autoPong: true})
	await new Promise((r) => setTimeout(r, 300))
	const [a] = await c.procedures['swarm.list'].run()
	assert.equal(a.online, true)
})

test('through gateway /connector/ws, silent connector goes offline and healthy connector stays online', async (t) => {
	const {c, id, directServer, dataDir, connect} = await setupDirect(t, {pingInterval: 60})
	const storeDir = join(dataDir, 'web')
	const store = await createStore(storeDir)
	await store.setConfig({backendUrl: `http://127.0.0.1:${directServer.address().port}`})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1'})
	const webServer = http.createServer(app)
	app.attachConsole(webServer)
	await new Promise((r) => webServer.listen(0, '127.0.0.1', r))
	t.after(async () => {
		app.closeAll()
		await new Promise((r) => webServer.close(r))
	})

	const gwUrl = `ws://127.0.0.1:${webServer.address().port}/connector/ws`

	await connect(gwUrl, {autoPong: false})
	const disksCall = c.procedures['swarm.storage.disks'].run({id})
	await assert.rejects(() => rejectAfter(disksCall, 1000), /offline/i)
	const [offline] = await c.procedures['swarm.list'].run()
	assert.equal(offline.online, false)

	await connect(gwUrl, {autoPong: true})
	await new Promise((r) => setTimeout(r, 300))
	const [online] = await c.procedures['swarm.list'].run()
	assert.equal(online.online, true)
})
