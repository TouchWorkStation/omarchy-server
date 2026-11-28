// Remote access API v1: Cloudflare Access token checks, the gate, the remote-ingress listener, and
// cutting remote connections when remote access goes off. Uses a stand-in Access team and the fake
// omarchyd; nothing here talks to Cloudflare.
import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import WebSocket from 'ws'

import {createAccessVerifier, validAccessConfig} from '../server/access-jwt.mjs'
import {createApp} from '../server/app.mjs'
import {createRemoteGate} from '../server/remote-gate.mjs'
import {createStore} from '../server/store.mjs'
import {AUD, CERTS, HOST, TEAM, accessTeam, openConfig} from './access-fixture.mjs'
import {startFakeserverd} from './fake-omarchyd.mjs'

const cfg = {issuer: TEAM, audience: AUD, certsUrl: CERTS}

test('Access tokens: only a correctly signed, current token for this team and application passes', async () => {
	const team = accessTeam()
	const v = team.verifier()
	const ok = await v.verify(team.token(), cfg)
	assert.equal(ok.ok, true)
	assert.equal(ok.claims.email, 'chris@example.com')
	const now = Math.floor(Date.now() / 1000)
	const cases = [
		['missing', undefined],
		['missing', ''],
		['malformed', 'not.a.token!'],
		['malformed', 'abc.def'],
		['algorithm', team.token({}, {alg: 'none'})],
		['issuer', team.token({iss: 'https://evil.cloudflareaccess.com'})],
		['audience', team.token({aud: ['b'.repeat(64)]})],
		['expired', team.token({exp: now - 120})],
		['not_yet_valid', team.token({nbf: now + 600})],
		['unknown_key', team.token({}, {kid: 'kid-nope'})],
	]
	for (const [reason, token] of cases) {
		const r = await v.verify(token, cfg)
		assert.equal(r.ok, false, `${reason} passed`)
		assert.equal(r.reason, reason)
	}
	// Signed by someone else's key under our key ID.
	const other = accessTeam()
	const forged = other.token({}, {kid: 'kid-1'})
	assert.equal((await v.verify(forged, cfg)).reason, 'signature')
	// A token for this team's other application.
	assert.equal((await v.verify(team.token({aud: 'c'.repeat(64)}), cfg)).ok, false)
	// The certificate list is fetched from the configured team only, without following redirects.
	assert.equal(team.lastFetch.url, CERTS)
	assert.equal(team.lastFetch.init.redirect, 'error')
})

test('Access settings: only a real Cloudflare Access team, with its own certificate address', () => {
	assert.equal(validAccessConfig(cfg), true)
	assert.equal(validAccessConfig({...cfg, certsUrl: 'https://evil.example/certs'}), false)
	assert.equal(validAccessConfig({...cfg, issuer: 'https://evil.example', certsUrl: 'https://evil.example/cdn-cgi/access/certs'}), false)
	assert.equal(validAccessConfig({...cfg, issuer: 'http://modc-test.cloudflareaccess.com', certsUrl: 'http://modc-test.cloudflareaccess.com/cdn-cgi/access/certs'}), false)
	assert.equal(validAccessConfig({...cfg, certsUrl: `${TEAM}/cdn-cgi/access/certs?x=1`}), false)
	assert.equal(validAccessConfig({...cfg, audience: ''}), false)
})

test('Access keys: a new key ID fetches the list again (rotation), but not more than every 30 s', async () => {
	const team = accessTeam()
	let t = Date.now()
	const v = createAccessVerifier({fetchImpl: team.fetchImpl, now: () => t})
	assert.equal((await v.verify(team.token(), cfg)).ok, true)
	assert.equal(team.fetches, 1)
	const k2 = team.rotate()
	t += 31_000
	assert.equal((await v.verify(team.token({}, {key: k2}), cfg)).ok, true, 'the rotated key is picked up')
	assert.equal(team.fetches, 2)
	// Unknown key IDs again and again don't hammer Cloudflare.
	for (let i = 0; i < 5; i++) await v.verify(team.token({}, {kid: `nope-${i}`}), cfg)
	assert.equal(team.fetches, 2)
})

// The web server with both listeners, like server/cli.mjs: this network's, and the remote one.
async function stack(config = () => openConfig()) {
	const team = accessTeam()
	const fake = await startFakeserverd()
	const dir = await mkdtemp(join(os.tmpdir(), 'remote-gate-'))
	const store = await createStore(dir)
	await store.setConfig({backendUrl: fake.url})
	let current = config
	const gate = createRemoteGate({fetchConfig: async () => current(), verifier: team.verifier(), log: () => {}, refreshMs: 60_000})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1', remoteGate: gate})
	const local = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	app.attachConsole(local)
	const remote = http.createServer(app)
	app.attachRemote(remote)
	await new Promise((r) => remote.listen(0, '127.0.0.1', r))
	return {
		team,
		gate,
		store,
		app,
		localPort: local.address().port,
		remotePort: remote.address().port,
		setConfig: async (fn) => ((current = fn), gate.refresh()),
		close: async () => {
			app.closeRelays()
			app.closeAll()
			remote.closeAllConnections?.()
			await new Promise((r) => remote.close(r))
			await new Promise((r) => local.close(r))
			await fake.close?.()
			await rm(dir, {recursive: true, force: true})
		},
	}
}

function req(port, {method = 'GET', path = '/', headers = {}, body} = {}) {
	return new Promise((resolve, reject) => {
		const r = http.request({host: '127.0.0.1', port, method, path, headers: {...headers, ...(body ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)} : {})}}, (res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString()}))
		})
		r.on('error', reject)
		r.end(body)
	})
}
const signIn = async (port, headers) => {
	const r = await req(port, {method: 'POST', path: '/api/auth/login', headers: {'x-omarchy-server': '1', ...headers}, body: JSON.stringify({username: 'Chris', password: 'correct horse'})})
	return {status: r.status, cookie: ([].concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith('omarchy_server_sid=')) ?? '').split(';')[0]}
}
function ws(port, path, headers) {
	return new Promise((resolve) => {
		const w = new WebSocket(`ws://127.0.0.1:${port}${path}`, {headers})
		w.once('open', () => resolve({status: 101, w}))
		w.once('unexpected-response', (_q, r) => resolve({status: r.statusCode}))
		w.once('error', () => resolve({status: 0}))
	})
}

test('the remote listener: nothing without a valid Access token, whatever headers are sent', async () => {
	const s = await stack()
	try {
		const base = {host: HOST}
		assert.equal((await req(s.remotePort, {path: '/', headers: base})).status, 403, 'no token')
		assert.equal((await req(s.remotePort, {path: '/api/bootstrap', headers: {...base, 'cf-access-jwt-assertion': 'garbage'}})).status, 403)
		assert.equal((await req(s.remotePort, {path: '/api/bootstrap', headers: {...base, 'cf-access-jwt-assertion': s.team.token({aud: 'x'.repeat(64)})}})).status, 403, 'wrong audience')
		assert.equal((await req(s.remotePort, {path: '/api/bootstrap', headers: {...base, 'cf-access-jwt-assertion': s.team.token({iss: 'https://other.cloudflareaccess.com'})}})).status, 403, 'wrong issuer')
		assert.equal((await req(s.remotePort, {path: '/api/bootstrap', headers: {...base, 'cf-access-jwt-assertion': s.team.token({exp: Math.floor(Date.now() / 1000) - 300})}})).status, 403, 'expired')
		// Headers that would mean "already checked" elsewhere change nothing here.
		const forged = {...base, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'cf-access-authenticated-user-email': 'chris@example.com'}
		assert.equal((await req(s.remotePort, {path: '/api/bootstrap', headers: forged})).status, 403)
		assert.equal((await req(s.remotePort, {path: '/api/bootstrap', headers: {...forged, host: 'evil.example', 'cf-access-jwt-assertion': s.team.token()}})).status, 421, 'another address')
		// A valid token gets as far as the MODC sign-in, and no further.
		const ok = await req(s.remotePort, {path: '/api/bootstrap', headers: {...base, 'cf-access-jwt-assertion': s.team.token()}})
		assert.equal(ok.status, 200)
		const prefs = await req(s.remotePort, {path: '/api/prefs', headers: {...base, 'cf-access-jwt-assertion': s.team.token()}})
		assert.equal(prefs.status, 401, 'an Access token is not a MODC sign-in')
		// WebSockets: the same.
		assert.equal((await ws(s.remotePort, '/api/terminal?cols=80&rows=24', {...base, origin: `https://${HOST}`})).status, 403)
	} finally {
		await s.close()
	}
})

test('remote access off, blocked, unverified or stale: the remote side is shut, this network is not', async () => {
	const s = await stack()
	try {
		const token = s.team.token()
		const remote = () => req(s.remotePort, {path: '/api/bootstrap', headers: {host: HOST, 'cf-access-jwt-assertion': token}})
		for (const [label, fn] of [
			['off', () => openConfig({enabled: false})],
			['not verified', () => openConfig({verified: false})],
			['blocked here', () => openConfig({blocked: true})],
			['stale', () => openConfig({syncedAt: Date.now() - 31 * 60_000})],
			['never read', () => null],
			['a bad issuer', () => openConfig({issuer: 'https://evil.example', certsUrl: 'https://evil.example/cdn-cgi/access/certs'})],
		]) {
			await s.setConfig(fn)
			const r = await remote()
			assert.equal(r.status, 503, `${label}: ${r.status}`)
			assert.match(r.text, /REMOTE_/)
		}
		// Through the main listener too (cloudflared pointed at the current origin, 7780).
		const viaMain = await req(s.localPort, {path: '/api/bootstrap', headers: {host: HOST, 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-proto': 'https', 'cf-access-jwt-assertion': token}})
		assert.equal(viaMain.status, 503)
		// At home: unaffected, signs in and works.
		const home = await signIn(s.localPort, {host: `127.0.0.1:${s.localPort}`})
		assert.equal(home.status, 200)
		assert.equal((await req(s.localPort, {path: '/api/prefs', headers: {host: `127.0.0.1:${s.localPort}`, cookie: home.cookie}})).status, 200)
	} finally {
		await s.close()
	}
})

test('a remote session belongs to the Access identity that made it; switching remote access off signs it out and cuts its connections', async () => {
	const s = await stack()
	try {
		const mine = s.team.token({sub: 'user-1'})
		const signed = await signIn(s.remotePort, {host: HOST, 'cf-access-jwt-assertion': mine, origin: `https://${HOST}`})
		assert.equal(signed.status, 200)
		assert.equal((await req(s.remotePort, {path: '/api/prefs', headers: {host: HOST, 'cf-access-jwt-assertion': mine, cookie: signed.cookie}})).status, 200)
		// The same cookie with someone else's Access token is not signed in.
		const theirs = s.team.token({sub: 'user-2', email: 'someone@example.com'})
		assert.equal((await req(s.remotePort, {path: '/api/prefs', headers: {host: HOST, 'cf-access-jwt-assertion': theirs, cookie: signed.cookie}})).status, 401)
		// A terminal open remotely...
		const t = await ws(s.remotePort, '/api/terminal?cols=80&rows=24', {host: HOST, 'cf-access-jwt-assertion': mine, cookie: signed.cookie, origin: `https://${HOST}`})
		assert.equal(t.status, 101)
		const closed = new Promise((r) => t.w.once('close', r))
		// ...and a session at home.
		const home = await signIn(s.localPort, {host: `127.0.0.1:${s.localPort}`})
		// The owner switches remote access off.
		await s.setConfig(() => openConfig({enabled: false}))
		await closed
		await new Promise((r) => setTimeout(r, 50))
		const remoteSessions = s.store.sessionEntries().filter((e) => e.session.remote)
		assert.equal(remoteSessions.length, 0, 'remote sessions are gone')
		assert.equal((await req(s.localPort, {path: '/api/prefs', headers: {host: `127.0.0.1:${s.localPort}`, cookie: home.cookie}})).status, 200, 'home stays signed in')
		// Back on: the old remote cookie is no use.
		await s.setConfig(() => openConfig())
		assert.equal((await req(s.remotePort, {path: '/api/prefs', headers: {host: HOST, 'cf-access-jwt-assertion': mine, cookie: signed.cookie}})).status, 401)
	} finally {
		await s.close()
	}
})

test('this network: forged Cloudflare headers are ignored, not gated, and nothing breaks', {skip: !Object.values(os.networkInterfaces()).flat().some((a) => a && !a.internal && a.family === 'IPv4') && 'no network address'}, async () => {
	const lan = Object.values(os.networkInterfaces())
		.flat()
		.find((a) => a && !a.internal && a.family === 'IPv4').address
	const team = accessTeam()
	const fake = await startFakeserverd()
	const dir = await mkdtemp(join(os.tmpdir(), 'remote-gate-lan-'))
	const store = await createStore(dir)
	await store.setConfig({backendUrl: fake.url})
	const gate = createRemoteGate({fetchConfig: async () => openConfig({enabled: false}), verifier: team.verifier(), log: () => {}})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1', remoteGate: gate})
	const server = await new Promise((r) => {
		const s = app.listen(0, '0.0.0.0', () => r(s))
	})
	try {
		const port = server.address().port
		const r = await new Promise((resolve) => {
			http
				.get({host: lan, port, path: '/api/bootstrap', headers: {host: `${lan}:${port}`, 'cf-connecting-ip': '1.2.3.4', 'cf-ray': 'x', 'cf-access-jwt-assertion': 'x'}}, (res) => {
					res.resume()
					res.on('end', () => resolve(res.statusCode))
				})
				.on('error', () => resolve(0))
		})
		assert.equal(r, 200, 'treated as this network (remote access is off, yet it works)')
	} finally {
		app.closeRelays()
		app.closeAll()
		await new Promise((r) => server.close(r))
		await fake.close?.()
		await rm(dir, {recursive: true, force: true})
	}
})
