// Phase 6A: the dashboard as it will be reached through MODC Connect (cloudflared on this machine,
// forwarding https://nodezero.myowndatacenter.com to http://127.0.0.1:7780), and the same server
// reached directly from the network. Uses the fake omarchyd; nothing here talks to Cloudflare.
import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import WebSocket from 'ws'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {createUpdater} from '../omarchyd/updater.mjs'
import {startFakeserverd} from './fake-omarchyd.mjs'
import {createRemoteGate} from '../server/remote-gate.mjs'
import {accessTeam, openConfig} from './access-fixture.mjs'

const HOST = 'nodezero.myowndatacenter.com'
// The Cloudflare Access team in front of it, and the token it gives a browser it lets through.
const team = accessTeam()
const ACCESS = team.token()
// What cloudflared adds to every request it hands the dashboard (Access-approved).
const TUNNEL = (ip = '203.0.113.9') => ({host: HOST, 'x-forwarded-proto': 'https', 'x-forwarded-for': ip, 'cf-connecting-ip': ip, 'cf-ray': '8f0000000000-DFW', 'cf-visitor': '{"scheme":"https"}', 'cf-access-jwt-assertion': ACCESS})
const LAN = Object.values(os.networkInterfaces())
	.flat()
	.find((a) => a && !a.internal && a.family === 'IPv4')?.address

async function stack() {
	const fake = await startFakeserverd()
	const dir = await mkdtemp(join(os.tmpdir(), 'remote-access-'))
	const store = await createStore(dir)
	await store.setConfig({backendUrl: fake.url})
	const remoteGate = createRemoteGate({fetchConfig: async () => openConfig(), verifier: team.verifier(), log: () => {}})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1', remoteGate})
	// Listen everywhere, like the real server (0.0.0.0), so the network address can be tried too.
	const server = await new Promise((resolve) => {
		const s = app.listen(0, '0.0.0.0', () => resolve(s))
	})
	app.attachConsole(server)
	const port = server.address().port
	return {
		fake,
		port,
		store,
		close: async () => {
			app.closeRelays()
			app.closeAll()
			await new Promise((r) => server.close(r))
			await fake.close?.()
			await rm(dir, {recursive: true, force: true})
		},
	}
}

function request(port, {method = 'GET', path = '/', headers = {}, body, address = '127.0.0.1'} = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({host: address, port, method, path, headers: {...headers, ...(body ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)} : {})}}, (res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString()}))
		})
		req.on('error', reject)
		req.end(body)
	})
}

async function signIn(port, headers, {password = 'correct horse', username = 'Chris', address} = {}) {
	const r = await request(port, {method: 'POST', path: '/api/auth/login', headers: {'x-omarchy-server': '1', ...headers}, body: JSON.stringify({username, password}), address})
	const set = [].concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith('omarchy_server_sid='))
	return {status: r.status, set, cookie: set?.split(';')[0] ?? ''}
}

function wsOpen(port, path, headers, address = '127.0.0.1') {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://${address}:${port}${path}`, {headers})
		ws.once('open', () => {
			ws.close()
			resolve(101)
		})
		ws.once('unexpected-response', (_q, r) => resolve(r.statusCode))
		ws.once('error', () => resolve(0))
	})
}

test('through the tunnel: sign-in works, the cookie is Secure, links use the public name, never a local address', async () => {
	const s = await stack()
	try {
		const boot = JSON.parse((await request(s.port, {path: '/api/bootstrap', headers: TUNNEL()})).text)
		assert.equal(boot.server.url, `https://${HOST}`)
		assert.ok(!JSON.stringify(boot).match(/127\.0\.0\.1|192\.168\.|10\.\d+\.\d+\.\d+|:7780/), 'no local address before sign-in')
		const signed = await signIn(s.port, TUNNEL())
		assert.equal(signed.status, 200)
		assert.match(signed.set, /; HttpOnly/)
		assert.match(signed.set, /; SameSite=Strict/)
		assert.match(signed.set, /; Secure/)
		const after = JSON.parse((await request(s.port, {path: '/api/bootstrap', headers: {...TUNNEL(), cookie: signed.cookie}})).text)
		assert.equal(after.server.url, `https://${HOST}`)
		// The page loads over the tunnel without being bounced to some other address.
		const page = await request(s.port, {path: '/', headers: {...TUNNEL(), 'sec-fetch-mode': 'navigate'}})
		assert.ok(page.status !== 301 && page.status !== 302 && page.status !== 307 && page.status !== 308, `redirected to ${page.headers.location}`)
		// Apps on their own ports can't be reached through one hostname: a clear refusal, not a LAN link.
		const open = await request(s.port, {path: '/api/app-open?app=nextcloud', headers: {...TUNNEL(), cookie: signed.cookie}})
		assert.equal(open.status, 409)
		assert.match(open.text, /NEEDS_APP_HOSTS/)
		// A signed-in call through the tunnel, from the page itself (CSRF check passes).
		const ok = await request(s.port, {method: 'POST', path: '/api/rpc/user.get', headers: {...TUNNEL(), cookie: signed.cookie, origin: `https://${HOST}`, 'x-omarchy-server': '1'}, body: '{}'})
		assert.notEqual(ok.status, 403)
		const forged = await request(s.port, {method: 'POST', path: '/api/rpc/apps.list', headers: {...TUNNEL(), cookie: signed.cookie, origin: 'https://evil.example', 'x-omarchy-server': '1'}, body: '{}'})
		assert.equal(forged.status, 403)
	} finally {
		await s.close()
	}
})

test('through the tunnel: every protected endpoint refuses a browser that isn’t signed in', async () => {
	const s = await stack()
	try {
		const GET = [
			'/api/prefs',
			'/api/desktop',
			'/api/background',
			'/api/files/download?path=/etc/passwd',
			'/api/files/view?path=/',
			'/api/files/thumbnail/x.jpg?path=/x.jpg',
			'/api/clips/item?id=1',
			'/api/app-access?app=x',
			'/api/app-frame?apps=x',
			'/api/app-open?app=x',
			'/api/app-enter?app=x',
			'/api/console/check?target=terminal',
			'/api/swarm/files/download?id=000000000000&path=/',
			'/api/hyprland/events',
			'/api/hyprland/app-icon?name=x',
			'/api/omarchy/themes',
			'/api/omarchy/preview/default',
			'/api/omarchy/background/0123456789abcdef',
			'/api/account-avatar?path=/api/accounts/owner/avatar',
			'/api/rpc/apps.list',
			'/api/rpc/files.list?input=%7B%7D',
			'/api/rpc/machines.list',
			'/api/rpc/system.status',
			'/api/rpc/user.get',
			'/api/rpc/connect.status',
		]
		for (const path of GET) {
			const r = await request(s.port, {path, headers: TUNNEL()})
			assert.ok([401, 403, 404, 405].includes(r.status) || (r.status === 302 && r.headers.location === '/'), `${path} answered ${r.status} without sign-in`)
		}
		const POST = ['/api/prefs', '/api/desktop', '/api/files/upload?path=/x', '/api/files/upload-chunk?path=/x', '/api/clips/text', '/api/swarm/files/upload?id=000000000000&path=/x', '/api/assistant/stream', '/api/rpc/apps.install', '/api/rpc/machines.start', '/api/rpc/system.reboot', '/api/rpc/files.delete', '/api/rpc/connect.tunnel.enable', '/api/setup']
		for (const path of POST) {
			const r = await request(s.port, {method: 'POST', path, headers: {...TUNNEL(), 'x-omarchy-server': '1', origin: `https://${HOST}`}, body: '{}'})
			assert.ok([400, 401, 403, 404, 405].includes(r.status), `${path} answered ${r.status} without sign-in`)
		}
		assert.equal(s.fake.calls.filter((c) => /apps\.install|machines\.start|system\.reboot|files\.delete|connect\.tunnel/.test(c.path ?? c)).length, 0)
	} finally {
		await s.close()
	}
})

test('WebSockets (terminal, desktops, live views): signed in, from this page, over the same scheme', async () => {
	const s = await stack()
	try {
		const signed = await signIn(s.port, TUNNEL())
		const term = '/api/terminal?cols=80&rows=24'
		assert.equal(await wsOpen(s.port, term, {...TUNNEL(), origin: `https://${HOST}`}), 401, 'not signed in')
		assert.equal(await wsOpen(s.port, term, {...TUNNEL(), cookie: signed.cookie, origin: 'https://evil.example'}), 403, 'another site')
		assert.equal(await wsOpen(s.port, term, {...TUNNEL(), cookie: signed.cookie, origin: `http://${HOST}`}), 403, 'the wrong scheme')
		assert.equal(await wsOpen(s.port, term, {...TUNNEL(), cookie: signed.cookie}), 403, 'no Origin at all')
		assert.equal(await wsOpen(s.port, term, {...TUNNEL(), cookie: signed.cookie, origin: `https://${HOST}`}), 101, 'the dashboard itself')
		for (const path of ['/api/console?machineId=desktop', '/api/console?machineId=vm1', '/api/hyprland/stream?mode=output']) {
			assert.equal(await wsOpen(s.port, path, {...TUNNEL(), origin: `https://${HOST}`}), 401, `${path} without sign-in`)
			assert.equal(await wsOpen(s.port, path, {...TUNNEL(), cookie: signed.cookie, origin: 'https://evil.example'}), 403, `${path} from another site`)
		}
		assert.equal(await wsOpen(s.port, '/api/whatever', {...TUNNEL(), cookie: signed.cookie, origin: `https://${HOST}`}), 404)
	} finally {
		await s.close()
	}
})

test('from the network, forwarding headers are ignored: no fake https, no fake address, no fake host', {skip: LAN ? false : 'no network address here'}, async () => {
	const s = await stack()
	try {
		const host = `${LAN}:${s.port}`
		// A browser on the network pretending, via X-Forwarded-Proto, that it came through the tunnel.
		const signed = await signIn(s.port, {host, 'x-forwarded-proto': 'https'}, {address: LAN})
		assert.equal(signed.status, 200)
		assert.doesNotMatch(signed.set, /; Secure/, 'plain http stays plain http')
		const term = '/api/terminal?cols=80&rows=24'
		assert.equal(await wsOpen(s.port, term, {host, cookie: signed.cookie, origin: `https://${host}`, 'x-forwarded-proto': 'https'}, LAN), 403, 'a forged https Origin is refused')
		assert.equal(await wsOpen(s.port, term, {host, cookie: signed.cookie, origin: `http://${host}`, 'x-forwarded-proto': 'https'}, LAN), 101, 'the real one works')
		const boot = JSON.parse((await request(s.port, {path: '/api/bootstrap', headers: {host, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example'}, address: LAN})).text)
		assert.equal(boot.server.url, `http://${host}`)
		// A new X-Forwarded-For each try doesn't reset the per-address sign-in limit.
		let last
		for (let i = 0; i < 12; i++) last = await signIn(s.port, {host, 'x-forwarded-for': `198.51.100.${i}`, 'cf-connecting-ip': `198.51.100.${i}`}, {address: LAN, password: 'wrong'})
		assert.equal(last.status, 429)
	} finally {
		await s.close()
	}
})

test('sign-in limits through the tunnel: per address, per account, and they don’t lock the owner out at home', async () => {
	const s = await stack()
	try {
		// The same address: 10 tries in 5 minutes.
		let r
		for (let i = 0; i < 11; i++) r = await signIn(s.port, TUNNEL('203.0.113.50'), {username: 'someone', password: 'wrong'})
		assert.equal(r.status, 429)
		// Many addresses, one account: refused after 10 wrong passwords in 15 minutes.
		for (let i = 0; i < 10; i++) r = await signIn(s.port, TUNNEL(`198.51.100.${i}`), {password: 'wrong'})
		assert.equal(r.status, 401)
		r = await signIn(s.port, TUNNEL('198.51.100.200'), {password: 'correct horse'})
		assert.equal(r.status, 429, 'even the right password, from the internet, waits')
		// At home (no proxy in between), the owner still signs in.
		r = await signIn(s.port, {host: `127.0.0.1:${s.port}`})
		assert.equal(r.status, 200)
	} finally {
		await s.close()
	}
})

test('through the tunnel only: no swarm joins or connector scripts, HSTS on, no app-port redirects', async () => {
	const s = await stack()
	try {
		for (const [method, path] of [['POST', '/connector/enroll'], ['GET', '/connector/agent.py'], ['GET', '/connector/backup/x'], ['GET', '/api/connector/install.sh']]) {
			const remote = await request(s.port, {method, path, headers: TUNNEL(), ...(method === 'POST' ? {body: '{}'} : {})})
			assert.equal(remote.status, 404, `${path} through the tunnel`)
		}
		// At home they're still there.
		// At home the request goes on to omarchyd (its JSON answer), instead of the tunnel's plain "Not found".
		const home = await request(s.port, {method: 'POST', path: '/connector/enroll', headers: {host: `127.0.0.1:${s.port}`}, body: '{}'})
		assert.match(home.headers['content-type'], /application\/json/)
		assert.equal(await wsOpen(s.port, '/connector/ws', {...TUNNEL(), origin: `https://${HOST}`}), 404)
		const page = await request(s.port, {path: '/api/health', headers: TUNNEL()})
		assert.equal(page.headers['strict-transport-security'], 'max-age=31536000')
		assert.equal((await request(s.port, {path: '/api/health', headers: {host: `127.0.0.1:${s.port}`}})).headers['strict-transport-security'], undefined, 'not at home')
		const signed = await signIn(s.port, TUNNEL())
		const enter = await request(s.port, {path: '/api/app-enter?app=nextcloud', headers: {...TUNNEL(), cookie: signed.cookie}})
		assert.equal(enter.status, 409)
		assert.equal(enter.headers.location, undefined)
	} finally {
		await s.close()
	}
})

test('an update-hold file keeps a development build from being replaced', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'update-hold-'))
	try {
		const fetchImpl = async (url) => new Response(String(url).includes('package.json') ? JSON.stringify({version: '9.9.9'}) : '', {status: 200})
		const make = () => createUpdater({autoCheck: false, appDir: dir, dataDir: dir, currentVersion: '0.9.76', raw: 'https://raw.example/x', fetchImpl, run: async () => '', installerCheck: false})
		assert.equal((await make().procedures['system.checkUpdate'].run()).available, true)
		await writeFile(join(dir, 'update-hold'), '')
		const held = make()
		const c = await held.procedures['system.checkUpdate'].run()
		assert.equal(c.available, false)
		assert.equal(c.held, true)
		await assert.rejects(held.procedures['system.update'].run(), /Updates are paused/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
