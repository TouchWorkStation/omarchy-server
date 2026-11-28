// MODC Connect single sign-on (contract v1, behind Cloudflare Access): omarchyd's side against a
// stand-in website, and the web server's /modc/auth routes against a stand-in omarchyd.
import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import WebSocket from 'ws'

import {challengeFor, createSso, machinePost} from '../omarchyd/connect-sso.mjs'
import {createApp} from '../server/app.mjs'
import {createRemoteGate} from '../server/remote-gate.mjs'
import {createStore} from '../server/store.mjs'
import {HOST, accessTeam, openConfig} from './access-fixture.mjs'
import {startFakeserverd} from './fake-omarchyd.mjs'

const CRED = 'b'.repeat(64)
const DEVICE = '11111111-2222-4333-8444-555555555555'
const CENTER = '66666666-7777-4888-9999-000000000000'
const OWNER_SUB = '0aaaaaaa-1111-4222-8333-444444444444'
const SETTINGS = (over = {}) => ({
	state: 'enabled',
	enabled: true,
	selectedConnector: true,
	configVersion: 3,
	contractVersion: 1,
	protectionMode: 'cloudflare_access',
	hostname: HOST,
	deviceId: DEVICE,
	dataCenterId: CENTER,
	sso: {available: true, contract_version: 1, callback_path: '/modc/auth/callback', authorization_endpoint: 'https://myowndatacenter.com/connect/authorize'},
	...over,
})

function website() {
	const w = {calls: [], subject: OWNER_SUB, active: true, configVersion: 3, over: {}}
	w.post = async (url, {headers, body}) => {
		const path = url.replace('https://myowndatacenter.com/api/public/cloud', '')
		w.calls.push({path, auth: headers.authorization, body})
		if (w.over[path]) return w.over[path](body)
		const exp = new Date(Date.now() + 900_000).toISOString()
		if (path === '/sso/exchange') return {status: 200, body: {session_id: '9aaaaaaa-1111-4222-8333-444444444444', subject: w.subject, data_center_id: CENTER, device_id: DEVICE, hostname: HOST, config_version: w.configVersion, expires_at: exp, token_type: 'modc_remote_session', session_token: 'c'.repeat(64), expires_in: 900, validation_interval: 30, protection_mode: 'cloudflare_access', sso_stage: 'behind_access'}}
		if (path === '/sso/validate') return {status: 200, body: w.active ? {active: true, session_id: '9aaaaaaa-1111-4222-8333-444444444444', subject: w.subject, data_center_id: CENTER, device_id: DEVICE, hostname: HOST, config_version: w.configVersion, expires_at: exp, validation_interval: 30} : {active: false}}
		if (path === '/sso/revoke') return {status: 200, body: {revoked: true}}
		if (path === '/sso/readiness') return {status: 200, body: {accepted: true, readiness: 'reported', expires_at: new Date(Date.now() + 600_000).toISOString(), sso_only_activation_allowed: false}}
		return {status: 404, body: {error: 'not_found'}}
	}
	return w
}

async function sso({settings = SETTINGS(), probe = true} = {}) {
	const dir = await mkdtemp(join(os.tmpdir(), 'sso-'))
	const w = website()
	let t = Date.now()
	let current = settings
	const minted = []
	const loggedOut = []
	const s = createSso({
		dir,
		apiBase: 'https://myowndatacenter.com/api/public/cloud',
		credential: () => CRED,
		device: () => ({deviceId: DEVICE, dataCenterId: CENTER}),
		remote: {settings: () => current},
		accounts: {
			listAccounts: () => [{userId: 'owner', role: 'owner'}],
			loginNativeFor: async (userId) => (minted.push(userId), {accountId: userId, accessToken: `at-${minted.length}`, accessExpiresAt: Date.now() + 60_000, deviceToken: `dt-${minted.length}`}),
			logoutDevice: async (dt) => loggedOut.push(dt),
		},
		post: w.post,
		now: () => t,
		log: () => {},
		probeLocal: async () => probe,
	})
	await s.ready
	return {s, w, dir, minted, loggedOut, advance: (ms) => (t += ms), setSettings: (x) => (current = x), cleanup: () => rm(dir, {recursive: true, force: true})}
}

const begin = async (x) => {
	const r = await x.s.start({hostname: HOST})
	const u = new URL(r.url)
	return {...r, u, state: u.searchParams.get('state')}
}

test('start: the exact authorization request, with PKCE S256 and a fresh state', async () => {
	const x = await sso()
	try {
		const r = await begin(x)
		assert.equal(r.u.origin + r.u.pathname, 'https://myowndatacenter.com/connect/authorize')
		assert.deepEqual([...r.u.searchParams.keys()].sort(), ['code_challenge', 'code_challenge_method', 'data_center_id', 'device_id', 'redirect_uri', 'response_type', 'state'])
		assert.equal(r.u.searchParams.get('redirect_uri'), `https://${HOST}/modc/auth/callback`)
		assert.equal(r.u.searchParams.get('code_challenge_method'), 'S256')
		assert.match(r.state, /^[A-Za-z0-9_-]{43,128}$/)
		assert.match(r.u.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/)
		// S256: BASE64URL(SHA256(verifier)), no padding.
		const {createHash} = await import('node:crypto')
		assert.equal(challengeFor('abc'), createHash('sha256').update('abc').digest('base64url'))
		assert.deepEqual(await x.s.start({hostname: 'evil.example'}), {error: 'wrong_host'})
		x.setSettings(SETTINGS({enabled: false}))
		assert.deepEqual(await x.s.start({hostname: HOST}), {error: 'not_available'})
	} finally {
		await x.cleanup()
	}
})

test('callback: state checked, transaction single-use, code exchanged here with the verifier', async () => {
	const x = await sso()
	try {
		const r = await begin(x)
		assert.deepEqual(await x.s.finish({tx: r.tx, code: 'a'.repeat(64), state: 'x'.repeat(43), hostname: HOST}), {error: 'state_mismatch'})
		assert.deepEqual(await x.s.finish({tx: r.tx, code: 'a'.repeat(64), state: r.state, hostname: HOST}), {error: 'no_transaction'}, 'replay of a used transaction')
		const r2 = await begin(x)
		const ok = await x.s.finish({tx: r2.tx, code: 'a'.repeat(64), state: r2.state, hostname: HOST})
		assert.ok(ok.ref)
		assert.equal(ok.native.accountId, 'owner')
		const ex = x.w.calls.find((c) => c.path === '/sso/exchange' && c.body.code_verifier)
		assert.equal(ex.auth, `Bearer ${CRED}`)
		assert.deepEqual(Object.keys(ex.body).sort(), ['code', 'code_verifier', 'grant_type', 'redirect_uri'])
		assert.equal(challengeFor(ex.body.code_verifier), r2.u.searchParams.get('code_challenge'))
		assert.ok(!JSON.stringify(ok).includes('c'.repeat(64)), 'the central token never leaves omarchyd')
		assert.deepEqual(await x.s.finish({tx: r2.tx, code: 'a'.repeat(64), state: r2.state, hostname: HOST}), {error: 'no_transaction'})
	} finally {
		await x.cleanup()
	}
})

test('exchange answers that don’t match this server are refused and revoked; only the owner’s account, ever', async () => {
	const x = await sso()
	try {
		for (const bad of [{device_id: '99999999-2222-4333-8444-555555555555'}, {config_version: 2}, {hostname: 'evil.example'}, {sso_stage: 'sso_only'}, {token_type: 'bearer'}]) {
			x.w.over['/sso/exchange'] = () => ({status: 200, body: {session_id: '9aaaaaaa-1111-4222-8333-444444444444', subject: OWNER_SUB, data_center_id: CENTER, device_id: DEVICE, hostname: HOST, config_version: 3, expires_at: new Date(Date.now() + 900_000).toISOString(), token_type: 'modc_remote_session', session_token: 'c'.repeat(64), validation_interval: 30, protection_mode: 'cloudflare_access', sso_stage: 'behind_access', ...bad}})
			const r = await begin(x)
			assert.deepEqual(await x.s.finish({tx: r.tx, code: 'a'.repeat(64), state: r.state, hostname: HOST}), {error: 'mismatch'}, JSON.stringify(bad))
		}
		delete x.w.over['/sso/exchange']
		x.w.over['/sso/exchange'] = () => ({status: 400, body: {error: 'invalid_grant'}})
		let r = await begin(x)
		assert.deepEqual(await x.s.finish({tx: r.tx, code: 'a'.repeat(64), state: r.state, hostname: HOST}), {error: 'invalid_grant'})
		delete x.w.over['/sso/exchange']
		r = await begin(x)
		assert.ok((await x.s.finish({tx: r.tx, code: 'a'.repeat(64), state: r.state, hostname: HOST})).ref)
		// Another website account, even with a website-issued session: refused.
		x.w.subject = '0bbbbbbb-1111-4222-8333-444444444444'
		r = await begin(x)
		assert.deepEqual(await x.s.finish({tx: r.tx, code: 'a'.repeat(64), state: r.state, hostname: HOST}), {error: 'other_account'})
		assert.equal(x.minted.length, 1)
	} finally {
		await x.cleanup()
	}
})

test('validation: cached up to 30 s, then checked; revoked, expired, changed or unreachable all fail closed', async () => {
	const x = await sso()
	try {
		const r = await begin(x)
		const {ref} = await x.s.finish({tx: r.tx, code: 'a'.repeat(64), state: r.state, hostname: HOST})
		assert.equal((await x.s.check({ref})).active, true)
		assert.equal(x.w.calls.filter((c) => c.path === '/sso/validate').length, 0, 'fresh from the exchange')
		x.advance(31_000)
		assert.equal((await x.s.check({ref})).active, true)
		assert.equal(x.w.calls.filter((c) => c.path === '/sso/validate').length, 1)
		// Before a change: fresher than 10 s.
		x.advance(11_000)
		await x.s.check({ref, maxAgeMs: 10_000})
		assert.equal(x.w.calls.filter((c) => c.path === '/sso/validate').length, 2)
		// The website can't be reached: not active now, but not ended.
		x.w.over['/sso/validate'] = () => Promise.reject(new Error('offline'))
		x.advance(31_000)
		assert.deepEqual(await x.s.check({ref}), {active: false, transient: true})
		delete x.w.over['/sso/validate']
		assert.equal((await x.s.check({ref})).active, true)
		// Revoked on the website: ended, and its local session with it.
		x.w.active = false
		x.advance(31_000)
		assert.equal((await x.s.check({ref})).active, false)
		assert.deepEqual(x.loggedOut, ['dt-1'])
		assert.equal((await x.s.check({ref})).active, false)
		// A configuration change ends a session without even asking.
		x.w.active = true
		const r2 = await begin(x)
		const s2 = await x.s.finish({tx: r2.tx, code: 'a'.repeat(64), state: r2.state, hostname: HOST})
		x.setSettings(SETTINGS({configVersion: 4}))
		x.advance(31_000)
		const n = x.w.calls.length
		assert.equal((await x.s.check({ref: s2.ref})).active, false)
		assert.equal(x.w.calls.length, n)
		// Expiry.
		x.setSettings(SETTINGS())
		x.w.configVersion = 3
		const r3 = await begin(x)
		const s3 = await x.s.finish({tx: r3.tx, code: 'a'.repeat(64), state: r3.state, hostname: HOST})
		x.advance(16 * 60_000)
		assert.equal((await x.s.check({ref: s3.ref})).active, false)
	} finally {
		await x.cleanup()
	}
})

test('sign-out revokes on the website; switching remote access off revokes everything; readiness only after the local self-test', async () => {
	const x = await sso()
	try {
		const r = await begin(x)
		const {ref} = await x.s.finish({tx: r.tx, code: 'a'.repeat(64), state: r.state, hostname: HOST})
		await x.s.logout({ref})
		assert.deepEqual(x.w.calls.at(-1), {path: '/sso/revoke', auth: `Bearer ${CRED}`, body: {session_token: 'c'.repeat(64)}})
		await x.s.revokeAll()
		assert.deepEqual(x.w.calls.at(-1).body, {all: true})
		const rep = await x.s.report(true)
		assert.equal(rep.accepted, true)
		const body = x.w.calls.find((c) => c.path === '/sso/readiness').body
		assert.deepEqual(body, {contract_version: 2, config_version: 3, origin: 'http://127.0.0.1:7781', app_version: 'remote-v1', checks: {pkce: true, state: true, session_validation: true, fail_closed: true, host_only_cookie: true, legacy_origin_isolated: true, sso_only_gate: true}})
	} finally {
		await x.cleanup()
	}
	const y = await sso({probe: false})
	try {
		assert.equal((await y.s.report(true)).accepted, false)
		assert.equal(y.w.calls.filter((c) => c.path === '/sso/readiness').length, 0, 'never reported when a local check fails')
	} finally {
		await y.cleanup()
	}
})

test('machine calls carry no browser headers (the website refuses Origin and Sec-Fetch-*)', async () => {
	let seen
	const server = http.createServer((req, res) => {
		seen = req.headers
		res.end('{"ok":true}')
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	try {
		const r = await machinePost(`http://127.0.0.1:${server.address().port}/x`, {headers: {authorization: 'Bearer x'}, body: {}})
		assert.equal(r.status, 200)
		assert.equal(seen.origin, undefined)
		assert.ok(!Object.keys(seen).some((k) => k.startsWith('sec-fetch')))
	} finally {
		server.close()
	}
})

// ---- The web server's /modc/auth routes ------------------------------------------------------------
async function web(ssoAnswers) {
	const team = accessTeam()
	const fake = await startFakeserverd()
	const dir = await mkdtemp(join(os.tmpdir(), 'sso-web-'))
	const store = await createStore(dir)
	await store.setConfig({backendUrl: fake.url})
	const steps = []
	const fetchImpl = async (url, init) => {
		const m = /\/internal\/sso\/(\w+)$/.exec(String(url))
		if (m) {
			const body = JSON.parse(init.body)
			steps.push({step: m[1], body})
			return new Response(JSON.stringify(await ssoAnswers[m[1]](body)), {status: 200})
		}
		return fetch(url, init)
	}
	const gate = createRemoteGate({fetchConfig: async () => openConfig(), verifier: team.verifier(), log: () => {}, refreshMs: 60_000})
	const app = createApp({store, fetchImpl, relayPortBase: 0, relayHost: '127.0.0.1', remoteGate: gate})
	const server = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	app.attachConsole(server)
	const remote = http.createServer(app)
	app.attachRemote(remote)
	await new Promise((r) => remote.listen(0, '127.0.0.1', r))
	const ACCESS = {host: HOST, 'cf-access-jwt-assertion': team.token()}
	const get = (port, path, headers = {}) =>
		new Promise((resolve, reject) => {
			http.get({host: '127.0.0.1', port, path, headers}, (res) => {
				let text = ''
				res.on('data', (c) => (text += c))
				res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text}))
			}).on('error', reject)
		})
	return {
		store,
		steps,
		ACCESS,
		local: server.address().port,
		port: remote.address().port,
		get,
		close: async () => {
			app.closeAll()
			app.closeRelays()
			remote.closeAllConnections?.()
			await new Promise((r) => remote.close(r))
			await new Promise((r) => server.close(r))
			await fake.close?.()
			await rm(dir, {recursive: true, force: true})
		},
	}
}
const cookieOf = (res, name) => [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`))

test('web: start and callback only through the tunnel, behind Access; a new host-only session, never an adopted one', async () => {
	let active = true
	const w = await web({
		start: () => ({url: 'https://myowndatacenter.com/connect/authorize?response_type=code&state=s', tx: 'TX123'}),
		finish: (b) => (b.tx === 'TX123' && b.state === 'good' ? {ref: 'REF1', expiresAt: Date.now() + 900_000, native: {accountId: 'owner', accessToken: 'at', accessExpiresAt: Date.now() + 60_000, deviceToken: 'dt'}} : {error: 'state_mismatch'}),
		check: () => (active ? {active: true} : {active: false}),
		logout: () => ({ok: true}),
	})
	try {
		// Not through the tunnel, or without Access: no.
		assert.equal((await w.get(w.local, '/modc/auth/start', {host: `127.0.0.1:${w.local}`})).status, 404)
		assert.equal((await w.get(w.port, '/modc/auth/start', {host: HOST})).status, 403)
		assert.equal((await w.get(w.local, '/modc/auth/start', {host: HOST, 'cf-connecting-ip': '1.2.3.4'})).status, 403, 'legacy origin, no Access token')
		// Start.
		const s = await w.get(w.port, '/modc/auth/start', w.ACCESS)
		assert.equal(s.status, 302)
		assert.match(s.headers.location, /^https:\/\/myowndatacenter\.com\/connect\/authorize\?/)
		const tx = cookieOf(s, '__Host-modc_sso')
		assert.match(tx, /^__Host-modc_sso=TX123; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/)
		// Callback: bad state, or no browser transaction, signs nothing in.
		assert.equal((await w.get(w.port, '/modc/auth/callback?code=x&state=bad', {...w.ACCESS, cookie: '__Host-modc_sso=TX123'})).status, 400)
		assert.equal((await w.get(w.port, '/modc/auth/callback?code=x&state=good', w.ACCESS)).status, 400, 'no transaction cookie')
		// A session ID planted in the browser is dropped, not adopted.
		const cb = await w.get(w.port, '/modc/auth/callback?code=x&state=good', {...w.ACCESS, cookie: '__Host-modc_sso=TX123; omarchy_server_sid=planted'})
		assert.equal(cb.status, 200)
		const sess = cookieOf(cb, 'omarchy_server_sid')
		assert.ok(sess && !sess.includes('planted'))
		assert.match(sess, /HttpOnly/)
		assert.match(sess, /Secure/)
		assert.doesNotMatch(sess, /Domain=/i, 'host-only')
		const sid = sess.split(';')[0]
		const boot = JSON.parse((await w.get(w.port, '/api/bootstrap', {...w.ACCESS, cookie: sid})).text)
		assert.equal(boot.session.accountId, 'owner')
		assert.equal(boot.sso, true)
		// Revoked or expired on the website: signed out on the next request, and its WebSockets refused.
		active = false
		const after = JSON.parse((await w.get(w.port, '/api/bootstrap', {...w.ACCESS, cookie: sid})).text)
		assert.equal(after.session, null)
		const ws = await new Promise((resolve) => {
			const c = new WebSocket(`ws://127.0.0.1:${w.port}/api/terminal?cols=80&rows=24`, {headers: {...w.ACCESS, cookie: sid, origin: `https://${HOST}`}})
			c.once('unexpected-response', (_q, r) => resolve(r.statusCode))
			c.once('open', () => (c.close(), resolve(101)))
			c.once('error', () => resolve(0))
		})
		assert.equal(ws, 401)
		// The same cookie with another Access identity: not signed in either (cross-account).
		assert.ok(w.steps.some((x) => x.step === 'check'))
	} finally {
		await w.close()
	}
})

test('readiness: nothing is reported when the v2 self-test or the active protection’s checks fail', async () => {
	for (const probe of [{isolated: true, ssoOnlyGate: false}, {isolated: false, ssoOnlyGate: true}, false]) {
		const x = await sso({probe})
		try {
			const r = await x.s.report(true)
			assert.equal(r.accepted, false)
			assert.equal(r.error, 'local_checks_failed')
			assert.equal(x.w.calls.filter((c) => c.path === '/sso/readiness').length, 0)
		} finally {
			await x.cleanup()
		}
	}
})
