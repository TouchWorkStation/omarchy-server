// Local swarm, end to end: the real omarchyd and web server (https on the same port), and the real
// connector (connector/agent.py, Python) joining with a one-time code, reporting, opening a
// terminal, and leaving again when removed.
import assert from 'node:assert/strict'
import {execFile, execFileSync, spawn} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import {promisify} from 'node:util'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import WebSocket, {WebSocketServer} from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {closeReason, createConnector} from '../omarchyd/connector.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {dualProtocolServer, ensureTls, tlsContext} from '../omarchyd/tls.mjs'
import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

const AGENT = fileURLToPath(new URL('../connector/agent.py', import.meta.url))
const hasPython = (() => {
	try {
		execFileSync('python3', ['--version'])
		return true
	} catch {
		return false
	}
})()

describe('local swarm', {skip: !hasPython && 'python3 is needed'}, () => {
	let root, data, tlsDir, d, web, webPort, auth, secure, agentHome, agentProc, agentLog
	const call = async (path, input, kind = 'mutation') => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...auth}}
		if (kind === 'mutation') Object.assign(init.headers, {'content-type': 'application/json'}), (init.body = JSON.stringify(input ?? null))
		else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const body = await (await fetch(url, init)).json()
		if (body.error) throw new Error(body.error.message)
		return body.result.data
	}
	const q = (p, i) => call(p, i, 'query')
	const until = async (fn, ms = 15_000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn().catch(() => null)
			if (v) return v
			if (Date.now() > end) throw new Error(`timed out\n${agentLog?.join('') ?? ''}`)
			await new Promise((r) => setTimeout(r, 100))
		}
	}
	// The backup test (opt in, like test/backups.test.mjs): a real restic and an SMB share.
	const backupIt = process.env.OMARCHY_BACKUP_IT === '1' && process.env.OMARCHY_BACKUP_RESTIC
	const resticDir = backupIt ? join(os.tmpdir(), `restic-bin-${process.pid}`) : null
	const agentEnv = () => ({...process.env, ...(resticDir ? {PATH: `${resticDir}:${process.env.PATH}`} : {}), HOME: agentHome, XDG_CONFIG_HOME: join(agentHome, '.config'), XDG_DATA_HOME: join(agentHome, '.local/share'), XDG_RUNTIME_DIR: join(agentHome, 'run')})
	// Async: the servers under test run in this process, so a blocking call would stall them.
	const runAgent = async (args) => {
		try {
			return (await promisify(execFile)('python3', [AGENT, ...args], {env: agentEnv(), encoding: 'utf8'})).stdout
		} catch (e) {
			throw new Error(String(e.stderr || e.message))
		}
	}
	const startAgent = () => {
		agentLog = []
		agentProc = spawn('python3', [AGENT], {env: agentEnv()})
		agentProc.stderr.on('data', (c) => agentLog.push(String(c)))
	}
	const pair = (abilities) => call('swarm.pair', abilities)
	const server = () => `https://127.0.0.1:${webPort}`
	// What the installer does before joining: trust the server's CA, after checking its fingerprint.
	const trust = async (ca) => {
		const pem = await (await fetch(`http://127.0.0.1:${webPort}/api/tls/ca.crt`)).text()
		const got = execFileSync('python3', ['-c', 'import ssl,sys,hashlib; print(hashlib.sha256(ssl.PEM_cert_to_DER_cert(sys.stdin.read())).hexdigest())'], {input: pem, encoding: 'utf8'}).trim()
		assert.equal(got, ca, 'the fingerprint in the install command is the CA the server serves')
		await mkdir(join(agentHome, '.config/omarchy-connector'), {recursive: true})
		await writeFile(join(agentHome, '.config/omarchy-connector/server-ca.crt'), pem)
	}
	const browserWs = async (target, params) => {
		const {ticket} = {ticket: await call('user.createWebSocketTicket', {target})}
		const url = new URL(`${d.url.replace('http', 'ws')}/${target === 'terminal' ? 'terminal' : 'machines/console'}`)
		url.search = new URLSearchParams({...params, ticket: typeof ticket === 'string' ? ticket : ticket.ticket}).toString()
		return new WebSocket(url, target === 'machines' ? ['binary'] : [])
	}

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'swarm-'))
		data = join(root, 'data')
		tlsDir = join(root, 'tls')
		agentHome = join(root, 'agent')
		await mkdir(join(agentHome, 'run'), {recursive: true, mode: 0o700})
		await ensureTls({dir: tlsDir})
		const sock = join(root, 'podman.sock')
		await writeFile(sock, '')
		process.env.DOCKER_HOST = `unix://${sock}`
		// The web server first (omarchyd needs its port for nothing here; the connector uses it).
		secure = tlsContext({dir: tlsDir})
		await until(async () => secure.get())
		const store = await createStore(join(root, 'web'))
		const app = createApp({store, tls: secure, relayPortBase: 0, relayHost: '127.0.0.1'})
		const httpServer = http.createServer(app)
		web = dualProtocolServer(httpServer, secure.get)
		await new Promise((r) => web.listen(0, '127.0.0.1', r))
		app.attachConsole(httpServer)
		webPort = web.address().port
		await mkdir(data, {recursive: true})
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		if (resticDir) {
			await mkdir(resticDir, {recursive: true})
			await import('node:fs/promises').then((f) => f.symlink(process.env.OMARCHY_BACKUP_RESTIC, join(resticDir, 'restic')).catch(() => {}))
		}
		d = await startOmarchyd({port: 0, dataDir: data, tlsDir, home: root, webPort, backupOptions: {unshare: false, ...(backupIt ? {resticPath: process.env.OMARCHY_BACKUP_RESTIC} : {})}, appOptions: {run: async () => '', allowFileStores: true, defaultStores: [], systemApps: null}, updaterOptions: {autoCheck: false, raw: 'https://raw.githubusercontent.com/TouchWorkStation/omarchy-server'}})
		await store.setConfig({backendUrl: d.url})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`}
	})
	after(async () => {
		if (resticDir) await rm(resticDir, {recursive: true, force: true})
		agentProc?.kill()
		await d?.close()
		web?.close()
		secure?.close?.()
		await rm(root, {recursive: true, force: true})
	})

	test('pairing gives a one-time code, the server’s fingerprint and how to install', async () => {
		const p = await pair({terminal: true, desktop: true, manage: true})
		assert.match(p.token, /^[A-Za-z0-9_-]{32}$/)
		assert.match(p.ca, /^[0-9a-f]{64}$/)
		assert.equal(p.source, 'https://raw.githubusercontent.com/TouchWorkStation/omarchy-server')
		assert.equal(p.port, webPort)
		assert.ok(Array.isArray(p.addresses))
		assert.ok(p.expiresAt > Date.now() + 14 * 60_000)
	})

	test('pairing can allow storage', async () => {
		const p = await pair({terminal: false, desktop: false, manage: false, storage: true})
		assert.equal(p.abilities.storage, true)
	})

	test('a computer joins with the code (once), with what both sides allow', async () => {
		const p = await pair({terminal: true, desktop: true, manage: true})
		await trust(p.ca)
		// This computer's installer allowed terminal and manage, not the desktop.
		const name = (await runAgent(['enroll', server(), p.token, 'terminal,manage'])).trim()
		assert.equal(name, os.hostname())
		const cfg = JSON.parse(await readFile(join(agentHome, '.config/omarchy-connector/config.json'), 'utf8'))
		assert.equal((await stat(join(agentHome, '.config/omarchy-connector/config.json'))).mode & 0o777, 0o600)
		assert.deepEqual(cfg.abilities, {terminal: true, desktop: false, manage: true, storage: false, backup: false, files: false})
		// The same code again: refused.
		await assert.rejects(runAgent(['enroll', server(), p.token, 'terminal']), /isn’t valid any more|already used|expired/)
		const [a] = await q('swarm.list')
		assert.deepEqual(a.allowed, {terminal: true, desktop: false, manage: true, storage: false, backup: false, files: false})
		assert.equal(a.online, false)
	})

	test('it connects, says what it is, and reports every few seconds', async () => {
		startAgent()
		const a = await until(async () => {
			const [x] = await q('swarm.list')
			return x.online && x.metrics?.mem?.total > 0 && x.info?.os && x
		})
		assert.equal(a.info.hostname, os.hostname())
		assert.ok(a.metrics.disks.length >= 1)
		assert.ok(a.metrics.cores >= 1)
		assert.ok(Array.isArray(a.metrics.gpus))
		assert.ok(Array.isArray(a.metrics.batteries))
	})

	test('a terminal on that computer, through the server', async () => {
		const [a] = await q('swarm.list')
		const ws = await browserWs('terminal', {agentId: a.id, cols: '100', rows: '30'})
		let out = ''
		ws.on('message', (d) => (out += String(d)))
		await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)))
		ws.send('echo swarm-$((40+2)); stty size\n')
		await until(async () => out.includes('swarm-42') && /30 100/.test(out))
		// The window changes size: the connector resizes its shell too.
		ws.send(Buffer.from(JSON.stringify({type: 'resize', cols: 140, rows: 44})), {binary: true})
		await new Promise((r) => setTimeout(r, 300))
		ws.send('stty size\n')
		await until(async () => /44 140/.test(out))
		ws.close()
	})

	test('what wasn’t allowed stays off: the desktop here, and the server can’t switch it on', async () => {
		const [a] = await q('swarm.list')
		const ws = await browserWs('machines', {machineId: `agent-${a.id}`})
		const closed = await new Promise((r) => ws.once('close', (code, reason) => r({code, reason: String(reason)})))
		assert.match(closed.reason, /isn’t switched on/)
		await assert.rejects(call('swarm.setAbilities', {id: a.id, desktop: true}), /wasn’t allowed desktop when it joined/)
		// Switching the terminal off here closes it off too, including one that's already open (#289).
		const open = await browserWs('terminal', {agentId: a.id, cols: '80', rows: '24'})
		await new Promise((r, j) => (open.once('open', r), open.once('error', j)))
		const ended = new Promise((r) => open.once('close', (code, reason) => r(String(reason))))
		await call('swarm.setAbilities', {id: a.id, terminal: false})
		assert.match(await ended, /isn’t switched on/)
		const t = await browserWs('terminal', {agentId: a.id, cols: '80', rows: '24'})
		const tc = await new Promise((r) => t.once('close', (code, reason) => r(String(reason))))
		assert.match(tc, /isn’t switched on/)
		await call('swarm.setAbilities', {id: a.id, terminal: true})
	})

	test('manage: only the fixed actions; unverified plugins refused before it’s asked', async () => {
		const [a] = await q('swarm.list')
		await assert.rejects(call('swarm.action', {id: a.id, name: 'run', args: 'rm -rf /'}), /Unknown action/)
		// A name no machine accepts, so this never switches a real desktop's theme (and holds on Omarchy too).
		await assert.rejects(call('swarm.action', {id: a.id, name: 'theme-set', theme: '../Tokyo Night'}), /can’t be set here|Bad theme|theme/i)
		await call('swarm.rename', {id: a.id, name: 'Study PC'})
		assert.equal((await q('swarm.list'))[0].name, 'Study PC')
	})

	test('strangers get nowhere: a wrong key, or no key', async () => {
		const bad = new WebSocket(`wss://127.0.0.1:${webPort}/connector/ws`, {rejectUnauthorized: false, headers: {authorization: `Bearer 000000000000:${'x'.repeat(43)}`}})
		const status = await new Promise((r) => (bad.once('unexpected-response', (_q, res) => r(res.statusCode)), bad.once('open', () => r(101))))
		assert.equal(status, 401)
		const none = await fetch(`https://127.0.0.1:${webPort}/connector/enroll`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token: 'guess'})}).catch(() => null)
		// (fetch refuses the private CA; plain http reaches the same route)
		const r = none ?? (await fetch(`http://127.0.0.1:${webPort}/connector/enroll`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token: 'guess'})}))
		assert.equal(r.status, 401)
	})

	test('#108 a frame for a channel that is already closed is ignored, not a crash', async () => {
		const cfg = JSON.parse(await readFile(join(agentHome, '.config/omarchy-connector/config.json'), 'utf8'))
		// #288: a terminal on the old connection ends when the computer connects again.
		const [a0] = await q('swarm.list')
		const term = await browserWs('terminal', {agentId: a0.id, cols: '80', rows: '24'})
		await new Promise((r, j) => (term.once('open', r), term.once('error', j)))
		const termEnded = new Promise((r) => term.once('close', (code, reason) => r(String(reason))))
		const ws = new WebSocket(`wss://127.0.0.1:${webPort}/connector/ws`, {rejectUnauthorized: false, headers: {authorization: `Bearer ${cfg.id}:${cfg.key}`, 'user-agent': 'omarchy-connector/test'}})
		await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)))
		assert.match(await termEnded, /reconnected/)
		ws.send(Buffer.from([0, 0, 0, 9, 65, 66]), {binary: true})
		await new Promise((r) => setTimeout(r, 300))
		ws.close()
		// The server is still up and the real connector reconnects.
		await until(async () => (await q('swarm.list'))[0]?.online)
	})

	test('removed from the swarm: it’s cut off, forgets the server and stops', async () => {
		const [a] = await q('swarm.list')
		await call('swarm.remove', {id: a.id})
		await until(async () => agentProc.exitCode !== null || agentProc.signalCode !== null)
		await assert.rejects(stat(join(agentHome, '.config/omarchy-connector/config.json')))
		assert.deepEqual(await q('swarm.list'), [])
	})

	// Needs Xvfb and x11vnc (the CI job installs them).
	const hasX = (() => {
		try {
			execFileSync('sh', ['-c', 'command -v Xvfb && command -v x11vnc'])
			return true
		} catch {
			return false
		}
	})()
	test('desktop: its screen (X11, through x11vnc on a private socket) reaches the browser as VNC', {skip: !hasX && 'Xvfb and x11vnc are needed'}, async (t) => {
		const xvfb = spawn('Xvfb', [':93', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], {stdio: 'ignore'})
		t.after(() => xvfb.kill())
		await until(async () => stat('/tmp/.X11-unix/X93').then(() => true))
		const p = await pair({terminal: false, desktop: true, manage: false})
		await trust(p.ca)
		await runAgent(['enroll', server(), p.token, 'desktop'])
		startAgent()
		t.after(() => agentProc.kill())
		const a = await until(async () => {
			const [x] = await q('swarm.list')
			return x?.online && x.info?.desktop?.kind === 'x11' && x
		})
		assert.equal(a.info.desktop.ok, true)
		// The readable check says yes before the browser opens the screen.
		assert.equal(await q('swarm.desktopCheck', {id: a.id}), true)
		const ws = await browserWs('machines', {machineId: `agent-${a.id}`})
		const first = await new Promise((r, j) => (ws.once('message', (d) => r(Buffer.from(d))), ws.once('close', (c, why) => j(new Error(`closed ${c} ${why}`)))))
		assert.match(first.toString('latin1'), /^RFB 003\.00\d\n/)
		ws.close()
		// The VNC server listens only on a socket in the connector's private runtime folder, no port.
		const sockDir = join(agentHome, 'run/omarchy-connector')
		assert.equal((await stat(sockDir)).mode & 0o777, 0o700)
	})
	test('backups: a computer backs up chosen folders to the server, can’t delete them, and restores into ~/Restored', {skip: !backupIt && 'set OMARCHY_BACKUP_IT=1, OMARCHY_BACKUP_RESTIC and OMARCHY_BACKUP_SMB', timeout: 300_000}, async () => {
		const [hostport, share, username, password] = String(process.env.OMARCHY_BACKUP_SMB).split(' ')
		const folder = `Omarchy Swarm IT ${Date.now()}`
		agentProc?.kill()
		await rm(join(agentHome, '.config/omarchy-connector/config.json'), {force: true})
		await mkdir(join(agentHome, 'Documents', 'Taxes'), {recursive: true})
		await mkdir(join(agentHome, 'Music'), {recursive: true})
		await writeFile(join(agentHome, 'Documents', 'Taxes', '2026.txt'), 'refund: yes\n')
		await writeFile(join(agentHome, 'Music', 'song.txt'), 'not chosen\n')
		const p = await pair({backup: true})
		await trust(p.ca)
		await runAgent(['enroll', server(), p.token, 'backup'])
		startAgent()
		const a = await until(async () => (await q('swarm.list')).find((x) => x.online && x.allowed.backup))
		try {
			// No NAS yet: the server's own backups come first.
			await assert.rejects(call('backups.setComputer', {id: a.id, folders: ['Documents'], enabled: true}), /this server first/)
			await call('backups.configure', {nas: {host: hostport, share, folder, username, password}})
			const list = await call('backups.computerFolders', {id: a.id})
			assert.ok(list.folders.some((f) => f.name === 'Documents'))
			await assert.rejects(call('backups.setComputer', {id: a.id, folders: ['../etc'], enabled: true}), /isn’t a folder/)
			await call('backups.setComputer', {id: a.id, folders: ['Documents'], enabled: true})
			await call('backups.runComputer', {id: a.id})
			const done = await until(async () => {
				const c = (await q('backups.computers')).find((x) => x.id === a.id)
				return c && !c.running && c.last ? c : null
			}, 240_000)
			assert.equal(done.last.ok, true, done.last.error)
			const snaps = await q('backups.computerSnapshots', {id: a.id})
			assert.equal(snaps.length, 1)
			assert.ok(snaps[0].paths.some((x) => x.endsWith('/Documents')))
			assert.ok(!snaps[0].paths.some((x) => x.endsWith('/Music')))

			// Add-only: with its own key, the computer can read and add, but not delete or replace.
			const cfg = JSON.parse(await readFile(join(agentHome, '.config/omarchy-connector/config.json'), 'utf8'))
			const asAgent = (method, path, body) => fetch(`http://127.0.0.1:${webPort}/connector/backup/${path}`, {method, body, headers: {authorization: `Bearer ${cfg.id}:${cfg.key}`}})
			const snapsList = await (await asAgent('GET', 'snapshots/')).json()
			assert.equal(snapsList.length, 1)
			assert.equal((await asAgent('DELETE', `snapshots/${snapsList[0]}`)).status, 403)
			assert.equal((await asAgent('POST', `snapshots/${snapsList[0]}`, 'x')).status, 403)
			assert.equal((await asAgent('POST', '')).status, 403)
			assert.equal((await fetch(`http://127.0.0.1:${webPort}/connector/backup/keys/`)).status, 401)

			// Restore: into a new folder, never over the files that are there.
			await writeFile(join(agentHome, 'Documents', 'Taxes', '2026.txt'), 'changed since\n')
			await call('backups.restoreComputer', {id: a.id, snapshotId: snaps[0].id})
			const restored = await until(async () => (await q('backups.computers')).find((x) => x.id === a.id && x.lastRestore)?.lastRestore, 120_000)
			assert.equal(restored.ok, true, restored.error)
			assert.equal(await readFile(join(restored.folder, 'Documents', 'Taxes', '2026.txt'), 'utf8'), 'refund: yes\n')
			assert.equal(await readFile(join(agentHome, 'Documents', 'Taxes', '2026.txt'), 'utf8'), 'changed since\n')

			// Backups switched off for it here: the server refuses, and so would the computer.
			await call('swarm.setAbilities', {id: a.id, backup: false})
			await assert.rejects(call('backups.runComputer', {id: a.id}), /aren’t switched on/)
		} finally {
			try {
				execFileSync('smbclient', [`//${hostport.split(':')[0]}/${share}`, '-U', `${username}%${password}`, ...(hostport.includes(':') ? ['-p', hostport.split(':')[1]] : []), '-c', `deltree "${folder}"`], {stdio: 'ignore'})
			} catch {
				/* best effort */
			}
		}
	})
})

describe('swarm close reasons', () => {
	test('closeReason: 50 ideographs stay within 123 bytes and round-trip', () => {
		const reason = closeReason('あ'.repeat(50))
		const buf = Buffer.from(reason)
		assert.ok(buf.length <= 123)
		assert.equal(buf.toString('utf8'), reason)
		assert.equal(reason.includes('\uFFFD'), false)
		assert.equal(reason, 'あ'.repeat(41))
		// A cut that lands inside a character walks back to the start of it.
		const skewed = closeReason(`x${'あ'.repeat(50)}`)
		assert.equal(Buffer.byteLength(skewed) <= 123, true)
		assert.equal(Buffer.from(skewed).toString('utf8'), skewed)
		assert.equal(skewed.includes('\uFFFD'), false)
		assert.equal(skewed, `x${'あ'.repeat(40)}`)
		const emoji = closeReason('😀'.repeat(40))
		assert.equal(Buffer.byteLength(emoji) <= 123, true)
		assert.equal(Buffer.from(emoji).toString('utf8'), emoji)
		assert.equal(emoji.includes('\uFFFD'), false)
		// What already fits is kept, including the real short close text. Controls become spaces.
		const short = 'The desktop isn’t switched on for Study PC'
		assert.equal(closeReason(short), short)
		assert.equal(closeReason('a'.repeat(123)), 'a'.repeat(123))
		assert.equal(closeReason('a'.repeat(124)), 'a'.repeat(123))
		assert.equal(closeReason('a\u0000b\u001fc\u007fd'), 'a b c d')
		assert.equal(closeReason(null), '')
		assert.equal(closeReason(undefined), '')
	})

	const abilities = {terminal: false, desktop: false, manage: false, storage: false, backup: false}
	async function withAgent(agent, run) {
		const dataDir = await mkdtemp(join(os.tmpdir(), 'swarm-close-'))
		const id = 'aabbccddeeff'
		const key = randomBytes(32).toString('base64url')
		await writeFile(
			join(dataDir, 'swarm.json'),
			JSON.stringify({
				agents: [{id, name: agent.name, keyHash: createHash('sha256').update(key).digest('hex'), allowed: agent.allowed, on: agent.on ?? agent.allowed, enrolledAt: 1, lastSeen: null, info: {hostname: 'pc'}}],
			}),
		)
		const c = createConnector({dataDir, tlsDir: dataDir})
		const server = http.createServer()
		server.on('upgrade', (req, socket, head) => {
			c.upgradeAgent(req, socket, head).catch(() => socket.destroy())
		})
		await new Promise((r) => server.listen(0, '127.0.0.1', r))
		const agentWs = new WebSocket(`ws://127.0.0.1:${server.address().port}/`, {headers: {authorization: `Bearer ${id}:${key}`}})
		try {
			await new Promise((resolve, reject) => (agentWs.once('open', resolve), agentWs.once('error', reject)))
			await run({c, id, agentWs})
		} finally {
			agentWs.terminate()
			c.close()
			await new Promise((r) => server.close(r))
			await rm(dataDir, {recursive: true, force: true})
		}
	}
	async function browserSocket() {
		const wss = new WebSocketServer({port: 0, host: '127.0.0.1'})
		await new Promise((r) => (wss.address() ? r() : wss.once('listening', r)))
		const client = new WebSocket(`ws://127.0.0.1:${wss.address().port}`)
		const serverSide = await new Promise((r) => wss.once('connection', r))
		serverSide.on('error', () => {})
		client.on('error', () => {})
		await new Promise((resolve, reject) => (client.once('open', resolve), client.once('error', reject)))
		return {client, serverSide, close: () => new Promise((r) => wss.close(r))}
	}
	const closedAs = (client) => new Promise((r) => client.once('close', (code, reason) => r({code, reason: Buffer.from(reason)})))

	test('a long unicode computer name closes the socket instead of throwing', async () => {
		const name = 'あ'.repeat(48)
		await withAgent({name, allowed: abilities}, async ({c, id}) => {
			const browser = await browserSocket()
			try {
				const closed = closedAs(browser.client)
				c.openChannel(id, 'vnc', browser.serverSide)
				const got = await closed
				const text = got.reason.toString('utf8')
				assert.equal(got.code, 1011)
				assert.ok(got.reason.length <= 123)
				assert.equal(Buffer.from(text).toString('utf8'), text)
				assert.equal(text.includes('\uFFFD'), false)
				assert.match(text, /^The desktop isn’t switched on for あ/)
				// A name that already fits is the whole sentence, not a shortened one.
				await c.procedures['swarm.rename'].run({id, name: 'Study PC'})
				const again = await browserSocket()
				try {
					const full = closedAs(again.client)
					c.openChannel(id, 'vnc', again.serverSide)
					const kept = await full
					assert.equal(kept.code, 1011)
					assert.equal(kept.reason.toString('utf8'), 'The desktop isn’t switched on for Study PC')
				} finally {
					await again.close()
				}
			} finally {
				await browser.close()
			}
		})
	})

	test('a long connector close reason is forwarded without throwing', async () => {
		await withAgent({name: 'pc', allowed: {...abilities, terminal: true}, on: {...abilities, terminal: true}}, async ({c, id, agentWs}) => {
			const browser = await browserSocket()
			try {
				const opened = new Promise((r) => agentWs.on('message', function onOpen(d) {
					const m = JSON.parse(String(d))
					if (m.op === 'open') (agentWs.off('message', onOpen), r(m))
				}))
				c.openChannel(id, 'pty', browser.serverSide, {cols: 80, rows: 24})
				const open = await opened
				assert.equal(open.op, 'open')
				const closed = closedAs(browser.client)
				agentWs.send(JSON.stringify({op: 'closed', ch: open.ch, code: 1011, reason: `\u0000${'あ'.repeat(50)}`}))
				const got = await closed
				const text = got.reason.toString('utf8')
				assert.equal(got.code, 1011)
				assert.ok(got.reason.length <= 123)
				assert.equal(Buffer.from(text).toString('utf8'), text)
				assert.equal(text.includes('\uFFFD'), false)
				assert.equal(text.includes('\u0000'), false)
				assert.match(text, /^ あ/)
			} finally {
				await browser.close()
			}
		})
	})

	test('turning Terminal or Desktop off ends sessions that are already open', async () => {
		const allowed = {...abilities, terminal: true, desktop: true}
		await withAgent({name: 'Study PC', allowed, on: {...allowed}}, async ({c, id, agentWs}) => {
			const pty = await browserSocket()
			const vnc = await browserSocket()
			const closedOrStillOpen = (pending, label) => new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`${label} channel stayed open`)), 1000)
				pending.then((v) => (clearTimeout(timer), resolve(v)), (e) => (clearTimeout(timer), reject(e)))
			})
			try {
				const opens = []
				const opened = new Promise((resolve) => {
					const onMsg = (d, isBinary) => {
						if (isBinary) return
						const msg = JSON.parse(String(d))
						if (msg.op !== 'open') return
						opens.push(msg)
						if (opens.length < 2) return
						agentWs.off('message', onMsg)
						resolve(opens)
					}
					agentWs.on('message', onMsg)
				})
				c.openChannel(id, 'pty', pty.serverSide, {cols: 80, rows: 24})
				c.openChannel(id, 'vnc', vnc.serverSide)
				const openMsgs = await opened
				assert.equal(openMsgs.filter((m) => m.kind === 'pty').length, 1)
				assert.equal(openMsgs.filter((m) => m.kind === 'vnc').length, 1)

				const ptyClosed = closedAs(pty.client)
				await c.procedures['swarm.setAbilities'].run({id, terminal: false})
				const got = await closedOrStillOpen(ptyClosed, 'pty')
				assert.equal(got.code, 1011)
				assert.equal(got.reason.toString('utf8'), 'The terminal isn’t switched on for Study PC')

				const binaries = []
				const onBin = (d, isBinary) => {
					if (isBinary) binaries.push(d)
				}
				agentWs.on('message', onBin)
				try {
					pty.serverSide.send(Buffer.from([1, 2, 3, 4]))
				} catch {}
				await new Promise((r) => setTimeout(r, 50))
				assert.equal(binaries.length, 0)
				agentWs.off('message', onBin)

				assert.equal(vnc.client.readyState, WebSocket.OPEN)

				const vncClosed = closedAs(vnc.client)
				await c.procedures['swarm.setAbilities'].run({id, desktop: false})
				const gotVnc = await closedOrStillOpen(vncClosed, 'vnc')
				assert.equal(gotVnc.code, 1011)
				assert.equal(gotVnc.reason.toString('utf8'), 'The desktop isn’t switched on for Study PC')
			} finally {
				// An open socket keeps the browser's server from finishing close, so the failure never reports.
				pty.client.terminate()
				pty.serverSide.terminate()
				vnc.client.terminate()
				vnc.serverSide.terminate()
				await pty.close()
				await vnc.close()
			}
		})
	})
})
