// omarchyd terminal: a single-use ticket opens your shell in a real pty over a WebSocket.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, test} from 'node:test'
import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

let root, d, auth, vnc
before(async () => {
	root = await mkdtemp(join(os.tmpdir(), 'omarchyd-t-'))
	const accounts = await openAccounts(join(root, 'data'))
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	// Stand-in for wayvnc on 127.0.0.1.
	vnc = net.createServer((sock) => sock.end('RFB 003.008\n'))
	await new Promise((r) => vnc.listen(0, '127.0.0.1', r))
	d = await startOmarchyd({port: 0, dataDir: join(root, 'data'), home: root, desktopVncPort: vnc.address().port})
	const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
	auth = {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}
})
after(async () => {
	vnc.close()
	await d.close()
	await rm(root, {recursive: true, force: true})
})
const ticket = async (target) => (await (await fetch(`${d.url}/trpc/user.createWebSocketTicket`, {method: 'POST', headers: auth, body: JSON.stringify({target})})).json()).result.data
const refused = (url) => new Promise((resolve) => new WebSocket(url).once('error', () => resolve(true)).once('open', () => resolve(false)))

test('a terminal ticket opens a sized shell in a pty; it works once', async () => {
	const t = await ticket('terminal')
	const url = `${d.url.replace('http', 'ws')}/terminal?cols=91&rows=27&ticket=${t}`
	const ws = new WebSocket(url)
	let out = ''
	ws.on('message', (m) => (out += m.toString()))
	await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)))
	ws.send('echo sum-$((40+2)) $(tput cols)x$(tput lines)\n')
	const deadline = Date.now() + 5000
	while (!/sum-42 91x27/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
	assert.match(out, /sum-42 91x27/)
	ws.send('exit\n')
	await new Promise((r) => ws.once('close', r))
	assert.equal(await refused(url), true, 'tickets are single-use')
})

test('a machines ticket can’t open a shell; bad sizes are refused', async () => {
	assert.equal(await refused(`${d.url.replace('http', 'ws')}/terminal?cols=80&rows=24&ticket=${await ticket('machines')}`), true)
	assert.equal(await refused(`${d.url.replace('http', 'ws')}/terminal?cols=2&rows=24&ticket=${await ticket('terminal')}`), true)
})

test('the Omarchy desktop opens through the screen viewer with a ticket, never without', async () => {
	const base = `${d.url.replace('http', 'ws')}/machines/console?machineId=desktop`
	assert.equal(await refused(`${base}&ticket=forged`), true)
	const ws = new WebSocket(`${base}&ticket=${await ticket('machines')}`, ['binary'])
	const first = await new Promise((r, j) => (ws.once('message', (m) => r(m.toString())), ws.once('error', j)))
	assert.equal(first, 'RFB 003.008\n')
	ws.close()
})
