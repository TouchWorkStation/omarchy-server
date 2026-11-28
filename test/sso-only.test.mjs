// Contract v2, SSO only: the 7781 gateway with no Cloudflare Access token. Only the sign-in entry points
// and the sign-in page's files are open; everything else needs a valid MODC website session.
import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import WebSocket from 'ws'

import {createRemoteAccess} from '../omarchyd/connect-remote.mjs'
import {createApp} from '../server/app.mjs'
import {createRemoteGate} from '../server/remote-gate.mjs'
import {createStore} from '../server/store.mjs'
import {HOST, accessTeam} from './access-fixture.mjs'
import {startFakeserverd} from './fake-omarchyd.mjs'

const V2 = (over = {}) => ({enabled: true, verified: true, blocked: false, mode: 'modc_sso', syncedAt: Date.now(), hostname: HOST, configVersion: 5, ...over})

async function stack({config = () => V2()} = {}) {
	const team = accessTeam()
	const fake = await startFakeserverd()
	const dir = await mkdtemp(join(os.tmpdir(), 'sso-only-'))
	const store = await createStore(dir)
	await store.setConfig({backendUrl: fake.url})
	const sso = {active: new Set(), checks: 0, native: null}
	const fetchImpl = async (url, init) => {
		const m = /\/internal\/sso\/(\w+)$/.exec(String(url))
		if (!m) return fetch(url, init)
		const b = JSON.parse(init.body)
		let out = {}
		if (m[1] === 'start') out = {url: 'https://myowndatacenter.com/connect/authorize?x=1', tx: 'TX'}
		if (m[1] === 'finish') {
			const ref = `REF${sso.active.size + 1}`
			sso.active.add(ref)
			out = b.state === 'good' ? {ref, expiresAt: Date.now() + 900_000, native: sso.native} : {error: 'state_mismatch'}
		}
		if (m[1] === 'check') (sso.checks++, (out = {active: sso.active.has(b.ref)}))
		if (m[1] === 'logout') (sso.active.delete(b.ref), (out = {ok: true}))
		return new Response(JSON.stringify(out), {status: 200})
	}
	let current = config
	const gate = createRemoteGate({fetchConfig: async () => current(), verifier: team.verifier(), log: () => {}, refreshMs: 60_000})
	const app = createApp({store, fetchImpl, relayPortBase: 0, relayHost: '127.0.0.1', remoteGate: gate, ssoCheckMs: 100})
	const local = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	app.attachConsole(local)
	const remote = http.createServer(app)
	app.attachRemote(remote)
	await new Promise((r) => remote.listen(0, '127.0.0.1', r))
	const req = (port, {method = 'GET', path = '/', headers = {}, body} = {}) =>
		new Promise((resolve, reject) => {
			const r = http.request({host: '127.0.0.1', port, method, path, headers: {host: HOST, ...headers, ...(body ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)} : {})}}, (res) => {
				let text = ''
				res.on('data', (c) => (text += c))
				res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text}))
			})
			r.on('error', reject)
			r.end(body)
		})
	const signInSso = async () => {
		// A real omarchyd token for the website-linked account (the fake omarchyd's), as finish would hand back.
		const home = await req(local.address().port, {method: 'POST', path: '/api/auth/login', headers: {host: `127.0.0.1:${local.address().port}`, 'x-omarchy-server': '1'}, body: JSON.stringify({username: 'Chris', password: 'correct horse'})})
		const homeSid = [].concat(home.headers['set-cookie']).find((c) => c.startsWith('omarchy_server_sid=')).split(';')[0].split('=')[1]
		const h = store.getSession(homeSid)
		sso.native = {accountId: h.accountId ?? 'owner', accessToken: h.accessToken, accessExpiresAt: h.accessExpiresAt, deviceToken: h.deviceToken}
		const cb = await req(remote.address().port, {path: '/modc/auth/callback?code=c&state=good', headers: {cookie: '__Host-modc_sso=TX'}})
		return [].concat(cb.headers['set-cookie'] ?? []).find((c) => c.startsWith('omarchy_server_sid=')).split(';')[0]
	}
	return {
		team,
		store,
		sso,
		req,
		signInSso,
		setConfig: async (fn) => ((current = fn), gate.refresh()),
		local: local.address().port,
		port: remote.address().port,
		close: async () => {
			app.closeAll()
			app.closeRelays()
			remote.closeAllConnections?.()
			await new Promise((r) => remote.close(r))
			await new Promise((r) => local.close(r))
			await fake.close?.()
			await rm(dir, {recursive: true, force: true})
		},
	}
}
const ws = (port, path, headers) =>
	new Promise((resolve) => {
		const c = new WebSocket(`ws://127.0.0.1:${port}${path}`, {headers: {host: HOST, origin: `https://${HOST}`, ...headers}})
		c.once('open', () => resolve({status: 101, c}))
		c.once('unexpected-response', (_q, r) => resolve({status: r.statusCode}))
		c.once('error', () => resolve({status: 0}))
	})

test('signed out: only the sign-in entry points and the sign-in page’s files; the rest is refused by this server’s gate', async () => {
	const s = await stack()
	try {
		for (const path of ['/', '/api/bootstrap', '/assets/index-abc.js', '/modc-logo.png']) {
			const r = await s.req(s.port, {path})
			assert.notEqual(r.status, 401, `${path} should be open`)
		}
		assert.equal((await s.req(s.port, {path: '/modc/auth/start'})).status, 302)
		const boot = JSON.parse((await s.req(s.port, {path: '/api/bootstrap'})).text)
		assert.equal(boot.ssoOnly, true)
		assert.equal(boot.session, null)
		assert.deepEqual(boot.accounts, [])
		assert.equal(boot.server.version, undefined, 'nothing about the server')
		for (const path of ['/api/prefs', '/api/rpc/files.list', '/api/rpc/system.reboot', '/api/files/download?path=/etc/passwd', '/api/desktop', '/api/console/check?target=terminal', '/settings', '/api/health', '/connector/agent.py']) {
			const r = await s.req(s.port, {path})
			assert.equal(r.status, 401, `${path}: ${r.status}`)
			assert.equal(r.headers['x-modc-gate'], 'sso_only')
		}
		// No remote password sign-in, signed in or not.
		const pw = await s.req(s.port, {method: 'POST', path: '/api/auth/login', headers: {'x-omarchy-server': '1', origin: `https://${HOST}`}, body: JSON.stringify({username: 'Chris', password: 'correct horse'})})
		assert.ok([401, 403].includes(pw.status))
		assert.equal((await ws(s.port, '/api/terminal?cols=80&rows=24', {})).status, 401)
	} finally {
		await s.close()
	}
})

test('spoofed headers and the legacy origin get nothing; a valid Access token isn’t a session here', async () => {
	const s = await stack()
	try {
		const spoof = {'cf-access-jwt-assertion': s.team.token(), 'x-forwarded-for': '127.0.0.1', 'cf-connecting-ip': '127.0.0.1', 'x-forwarded-proto': 'https', 'cf-access-authenticated-user-email': 'chris@example.com', 'x-modc-gate': 'ok'}
		assert.equal((await s.req(s.port, {path: '/api/prefs', headers: spoof})).status, 401)
		// The old origin, as cloudflared would reach it: refused outright in this mode.
		assert.equal((await s.req(s.local, {path: '/api/prefs', headers: spoof})).status, 421)
		assert.equal((await s.req(s.local, {path: '/modc/auth/start', headers: spoof})).status, 421)
		// A password session made at home doesn't come along either (different host, and not an SSO session).
		const home = await s.req(s.local, {method: 'POST', path: '/api/auth/login', headers: {host: `127.0.0.1:${s.local}`, 'x-omarchy-server': '1'}, body: JSON.stringify({username: 'Chris', password: 'correct horse'})})
		assert.equal(home.status, 200)
		const homeSid = [].concat(home.headers['set-cookie']).find((c) => c.startsWith('omarchy_server_sid=')).split(';')[0]
		assert.equal((await s.req(s.port, {path: '/api/prefs', headers: {cookie: homeSid}})).status, 401)
		// …and works at home as always.
		assert.equal((await s.req(s.local, {path: '/api/prefs', headers: {host: `127.0.0.1:${s.local}`, cookie: homeSid}})).status, 200)
		// Wrong hostname.
		assert.equal((await s.req(s.port, {path: '/api/bootstrap', headers: {host: 'evil.example'}})).status, 421)
	} finally {
		await s.close()
	}
})

test('a website session opens everything; revoking it ends requests and already-open WebSockets', async () => {
	const s = await stack()
	try {
		const sid = await s.signInSso()
		assert.equal((await s.req(s.port, {path: '/api/prefs', headers: {cookie: sid}})).status, 200)
		const boot = JSON.parse((await s.req(s.port, {path: '/api/bootstrap', headers: {cookie: sid}})).text)
		assert.equal(boot.session.accountId, 'owner')
		const open = await ws(s.port, '/api/terminal?cols=80&rows=24', {cookie: sid})
		assert.equal(open.status, 101)
		const closed = new Promise((r) => open.c.once('close', r))
		// Revoked on the website.
		s.sso.active.clear()
		await closed
		assert.equal((await s.req(s.port, {path: '/api/prefs', headers: {cookie: sid}})).status, 401)
		assert.equal((await ws(s.port, '/api/terminal?cols=80&rows=24', {cookie: sid})).status, 401)
	} finally {
		await s.close()
	}
})

test('remote access off, stale settings or a mode change: shut and cut; back to Access mode (rollback) needs Access again', async () => {
	const s = await stack()
	try {
		const sid = await s.signInSso()
		const open = await ws(s.port, '/api/terminal?cols=80&rows=24', {cookie: sid})
		assert.equal(open.status, 101)
		const closed = new Promise((r) => open.c.once('close', r))
		await s.setConfig(() => V2({enabled: false}))
		await closed
		assert.equal((await s.req(s.port, {path: '/api/prefs', headers: {cookie: sid}})).status, 503)
		await s.setConfig(() => V2({syncedAt: Date.now() - 11 * 60_000}))
		assert.equal((await s.req(s.port, {path: '/'})).status, 503)
		// Rollback to Cloudflare Access mode: without an Access token, nothing.
		await s.setConfig(() => ({enabled: true, verified: true, blocked: false, mode: 'cloudflare_access', syncedAt: Date.now(), hostname: HOST, audience: 'a'.repeat(64), issuer: 'https://modc-test.cloudflareaccess.com', certsUrl: 'https://modc-test.cloudflareaccess.com/cdn-cgi/access/certs'}))
		assert.equal((await s.req(s.port, {path: '/'})).status, 403)
	} finally {
		await s.close()
	}
})

test('the label alone opens nothing: every v2 part, and the 7781 origin, must agree', async () => {
	const BODY = (over = {}, sec = {}, sso = {}) => ({
		api_version: 1, data_center_id: 'd', device_id: 'dev', selected_connector: true, hostname: HOST, origin: 'http://127.0.0.1:7781', state: 'enabled', mode: 'adopted', enabled: true, config_version: 5,
		access: null, credentials: {rotation_required: false},
		security: {contract_version: 2, protection_mode: 'modc_sso', ...sec},
		sso: {enabled: true, available: true, stage: 'sso_only', contract_version: 2, callback_path: '/modc/auth/callback', authorization_endpoint: 'https://myowndatacenter.com/connect/authorize', ...sso},
		...over,
	})
	const cases = [
		['all agree', BODY(), 'modc_sso'],
		['origin still 7780', BODY({origin: 'http://127.0.0.1:7780'}), null],
		['contract 1', BODY({}, {contract_version: 1}), null],
		['stage behind_access', BODY({}, {}, {stage: 'behind_access'}), null],
		['sso not enabled', BODY({}, {}, {enabled: false}), null],
	]
	for (const [label, body, mode] of cases) {
		const dir = await mkdtemp(join(os.tmpdir(), 'v2-'))
		const r = createRemoteAccess({dir, apiBase: 'https://myowndatacenter.com/api/public/cloud', credential: () => 'b'.repeat(64), deviceId: () => 'dev', fetchImpl: async () => new Response(JSON.stringify(body), {status: 200}), autoStart: false, log: () => {}})
		await r.tick()
		assert.equal(r.gate().mode, mode, label)
		assert.equal(r.gate().verified, !!mode, label)
		r.close()
		await rm(dir, {recursive: true, force: true})
	}
})

test('v2 self-test while v1 (Access) is active: the probe is judged by SSO-only rules, answers synthetically, and changes nothing', async () => {
	const V1 = () => ({enabled: true, verified: true, blocked: false, mode: 'cloudflare_access', syncedAt: Date.now(), hostname: HOST, audience: 'a'.repeat(64), issuer: 'https://modc-test.cloudflareaccess.com', certsUrl: 'https://modc-test.cloudflareaccess.com/cdn-cgi/access/certs'})
	const s = await stack({config: V1})
	try {
		const P = {'x-modc-probe': 'sso_only'}
		// v1 stays the active protection: without the probe, no Access token → 403 as before.
		assert.equal((await s.req(s.port, {path: '/api/prefs'})).status, 403)
		assert.equal((await s.req(s.port, {path: '/'})).status, 403)
		const gated = (r, status) => (assert.equal(r.status, status), assert.equal(r.headers['x-modc-gate'], 'sso_only'), assert.equal(r.headers['x-modc-probe'], 'sso_only'))
		gated(await s.req(s.port, {path: '/api/prefs', headers: P}), 401)
		gated(await s.req(s.port, {path: '/api/rpc/files.list', headers: {...P, 'cf-access-jwt-assertion': s.team.token(), 'x-forwarded-for': '127.0.0.1'}}), 401)
		gated(await s.req(s.port, {path: '/api/files/download?path=%2F', headers: P}), 401)
		gated(await s.req(s.port, {method: 'POST', path: '/api/auth/login', headers: {...P, 'x-omarchy-server': '1'}, body: JSON.stringify({username: 'Chris', password: 'correct horse'})}), 401)
		// Where the sign-in page would load: 204, no content — the probe never reaches a handler.
		const home = await s.req(s.port, {path: '/', headers: P})
		assert.equal(home.status, 204)
		assert.equal(home.text, '')
		assert.equal((await s.req(s.port, {path: '/modc/auth/start', headers: P})).status, 204)
		assert.equal((await s.req(s.port, {path: '/api/prefs', headers: {...P, host: 'evil.example'}})).status, 421)
		assert.equal((await s.req(s.local, {path: '/api/prefs', headers: {...P, 'cf-connecting-ip': '192.0.2.1'}})).status, 421)
		// A signed-in session doesn't change a probe's answer (a probe never uses a session).
		const sid = await (async () => {
			await s.setConfig(() => V2())
			const x = await s.signInSso()
			await s.setConfig(V1)
			return x
		})()
		gated(await s.req(s.port, {path: '/api/prefs', headers: {...P, cookie: sid, 'cf-access-jwt-assertion': s.team.token()}}), 401)
		// Remote access off: the probe reports it, it doesn't pretend.
		await s.setConfig(() => ({...V1(), enabled: false}))
		assert.equal((await s.req(s.port, {path: '/', headers: P})).status, 503)
	} finally {
		await s.close()
	}
})
