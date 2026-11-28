// MODC Connect against a stand-in for myowndatacenter.com that follows the Phase 3 contract.
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, stat, writeFile, mkdir, chmod} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createConnect, CONNECT_API} from '../omarchyd/connect.mjs'

const SECRET = 'a'.repeat(64)
const CRED = 'b'.repeat(64)
const DEVICE = '11111111-2222-4333-8444-555555555555'
const CENTER = '66666666-7777-4888-9999-000000000000'

// The website. `script` decides each answer; every request is recorded (secrets included, so tests can
// check where each one went).
function website(script = {}) {
	const calls = []
	const state = {status: 'authorization_pending', delivered: false, revoked: false}
	const json = (status, body, headers = {}) => new Response(body == null ? '' : JSON.stringify(body), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store', ...headers}})
	const fetchImpl = async (url, init = {}) => {
		const path = url.slice(CONNECT_API.length)
		const call = {method: init.method, path, auth: init.headers?.authorization ?? null, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect}
		calls.push(call)
		const key = `${init.method} ${path}`
		if (script[key]) {
			const r = await script[key](call, state)
			if (r !== undefined) return r
		}
		if (key === 'POST /pair') return json(201, {code: 'ABCD-EFGH', polling_secret: SECRET, expires_at: new Date(Date.now() + 600_000).toISOString(), expires_in: 600, interval: 5, pair_url: 'https://myowndatacenter.com/data-centers'})
		if (key === 'GET /pair') return call.auth === `Bearer ${SECRET}` ? json(200, {status: state.status, expires_at: new Date(Date.now() + 600_000).toISOString(), interval: 5}) : json(401, {error: 'invalid_polling_secret'})
		if (key === 'POST /pair/credentials') {
			if (call.auth !== `Bearer ${SECRET}`) return json(401, {error: 'invalid_polling_secret'})
			if (state.status === 'authorization_pending') return json(409, {error: 'authorization_pending'})
			if (state.delivered) return json(409, {error: 'already_delivered'})
			state.delivered = true
			state.status = 'credentials_delivered'
			return json(200, {device_id: DEVICE, data_center_id: CENTER, device_credential: CRED, token_type: 'Bearer', scope: 'device:heartbeat', remote_access: false})
		}
		if (key === 'POST /heartbeat') {
			if (call.auth !== `Bearer ${CRED}`) return json(401, {error: 'unauthorized'})
			return state.revoked ? json(404, {error: 'not_found'}) : json(200, {ok: true})
		}
		return json(404, {error: 'not_found'})
	}
	return {calls, state, fetchImpl, json}
}

async function setup(script, extra = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'modc-connect-'))
	const site = website(script)
	const logs = []
	let clock = Date.now()
	const make = (more = {}) => createConnect({dataDir: root, fetchImpl: site.fetchImpl, autoStart: false, version: '0.9.76', now: () => clock, log: (m) => logs.push(m), tunnelOptions: {unitDir: join(root, 'units'), systemPaths: [], sh: async () => ({ok: false, code: 1, out: '', err: ''})}, ...extra, ...more})
	const connect = make()
	await connect.ready
	return {root, site, logs, connect, make, file: join(root, 'connect', 'connect.json'), advance: (ms) => (clock += ms), cleanup: () => (connect.close(), rm(root, {recursive: true, force: true}))}
}

const noSecrets = (value) => {
	const text = JSON.stringify(value)
	assert.ok(!text.includes(SECRET), 'polling secret leaked')
	assert.ok(!text.includes(CRED), 'device credential leaked')
}

test('pairing: the code, countdown and website link are shown; the polling secret stays in an owner-only file', async () => {
	const t = await setup()
	try {
		const s = await t.connect.pair({name: 'Home server'})
		assert.equal(s.state, 'pairing')
		assert.equal(s.pairing.code, 'ABCD-EFGH')
		assert.equal(s.pairing.pairUrl, 'https://myowndatacenter.com/data-centers')
		assert.ok(s.pairing.expiresAt > Date.now())
		noSecrets(s)
		noSecrets(await t.connect.status())
		assert.deepEqual(t.site.calls[0], {method: 'POST', path: '/pair', auth: null, body: {name: 'Home server'}, redirect: 'error'})
		assert.equal((await stat(t.file)).mode & 0o777, 0o600)
		assert.equal((await stat(join(t.root, 'connect'))).mode & 0o777, 0o700)
		assert.ok((await readFile(t.file, 'utf8')).includes(SECRET))
		// Asking again while the code is still good shows the same code (the website allows five a network).
		await t.connect.pair({name: 'Home server'})
		assert.equal(t.site.calls.filter((c) => c.path === '/pair' && c.method === 'POST').length, 1)
	} finally {
		await t.cleanup()
	}
})

test('approved on the website: one credential exchange, saved before the polling secret goes, then heartbeats', async () => {
	const t = await setup()
	try {
		await t.connect.pair({})
		await t.connect.tick()
		assert.equal((await t.connect.status()).state, 'pairing')
		t.site.state.status = 'authorized'
		await t.connect.tick() // poll sees authorized, exchanges once
		const file = await readFile(t.file, 'utf8')
		assert.ok(file.includes(CRED))
		assert.ok(!file.includes(SECRET), 'polling secret kept after the exchange')
		const exchanges = t.site.calls.filter((c) => c.path === '/pair/credentials')
		assert.equal(exchanges.length, 1)
		assert.equal(exchanges[0].auth, `Bearer ${SECRET}`)
		assert.deepEqual(exchanges[0].body, {})
		for (const c of t.site.calls.filter((c) => c.method === 'GET')) assert.equal(c.auth, `Bearer ${SECRET}`)
		await t.connect.tick() // the first heartbeat
		const hb = t.site.calls.filter((c) => c.path === '/heartbeat')
		assert.equal(hb.length, 1)
		assert.equal(hb[0].auth, `Bearer ${CRED}`)
		assert.deepEqual(hb[0].body, {version: '0.9.76'})
		const s = await t.connect.status()
		assert.equal(s.state, 'connected')
		assert.deepEqual(s.device, {deviceId: DEVICE, dataCenterId: CENTER, name: os.hostname().trim().slice(0, 60).trim() || 'My machine', pairedAt: s.device.pairedAt})
		assert.ok(s.lastCheckIn)
		assert.ok(s.nextAttemptAt - s.lastAttemptAt >= 60_000)
		noSecrets(s)
		noSecrets(t.logs)
	} finally {
		await t.cleanup()
	}
})

test('pairing survives a restart, and so does the connection', async () => {
	const t = await setup()
	try {
		await t.connect.pair({name: 'Rack'})
		t.connect.close()
		const again = t.make()
		await again.ready
		assert.equal((await again.status()).pairing.code, 'ABCD-EFGH')
		t.site.state.status = 'authorized'
		await again.tick()
		again.close()
		const third = t.make()
		await third.ready
		assert.equal((await third.status()).device.deviceId, DEVICE)
		await third.tick()
		assert.equal((await third.status()).state, 'connected')
		third.close()
	} finally {
		await t.cleanup()
	}
})

test('an expired code: by the website, or by the clock while the server was off', async () => {
	const t = await setup()
	try {
		await t.connect.pair({})
		t.site.state.status = 'expired'
		await t.connect.tick()
		let s = await t.connect.status()
		assert.equal(s.state, 'none')
		assert.equal(s.notice.kind, 'expired')
		assert.ok(!(await readFile(t.file, 'utf8')).includes(SECRET))

		await t.connect.pair({})
		t.connect.close()
		t.advance(11 * 60_000)
		const later = t.make()
		await later.ready
		s = await later.status()
		assert.equal(s.notice.kind, 'expired')
		assert.equal(s.pairing, undefined)
		later.close()
	} finally {
		await t.cleanup()
	}
})

test('rate limits: polling waits Retry-After; asking for codes too often says when to try again', async () => {
	const t = await setup({'GET /pair': (_c, _s) => new Response('{"error":"rate_limited"}', {status: 429, headers: {'retry-after': '60'}})})
	try {
		await t.connect.pair({})
		await t.connect.tick()
		const s = await t.connect.status()
		assert.equal(s.state, 'pairing')
		assert.equal(s.problem, 'rate_limited')
		assert.ok(s.nextAttemptAt - s.lastAttemptAt >= 60_000)
	} finally {
		await t.cleanup()
	}
	const u = await setup({'POST /pair': () => new Response('{"error":"rate_limited"}', {status: 429, headers: {'retry-after': '300'}})})
	try {
		await assert.rejects(u.connect.pair({}), (e) => e.code === 'TOO_MANY_REQUESTS' && /5 minutes/.test(e.message))
	} finally {
		await u.cleanup()
	}
})

test('failed credential delivery is never retried: a replayed exchange, or an answer lost on the way', async () => {
	const t = await setup({'POST /pair/credentials': () => new Response('{"error":"already_delivered"}', {status: 409})})
	try {
		await t.connect.pair({})
		t.site.state.status = 'authorized'
		await t.connect.tick()
		const s = await t.connect.status()
		assert.equal(s.notice.kind, 'delivery_failed')
		assert.match(s.notice.message, /Remove the unfinished device/)
		await t.connect.tick()
		assert.equal(t.site.calls.filter((c) => c.path === '/pair/credentials').length, 1)
	} finally {
		await t.cleanup()
	}
	const u = await setup({'POST /pair/credentials': () => Promise.reject(Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNRESET'}}))})
	try {
		await u.connect.pair({})
		u.site.state.status = 'authorized'
		await u.connect.tick()
		assert.equal((await u.connect.status()).notice.kind, 'delivery_failed')
		noSecrets(u.logs)
	} finally {
		await u.cleanup()
	}
	// Never sent (no DNS): safe to ask again, and it does.
	let fail = true
	const v = await setup({'POST /pair/credentials': () => (fail ? ((fail = false), Promise.reject(Object.assign(new TypeError('fetch failed'), {cause: {code: 'ENOTFOUND'}}))) : undefined)})
	try {
		await v.connect.pair({})
		v.site.state.status = 'authorized'
		await v.connect.tick()
		assert.equal((await v.connect.status()).problem, 'offline')
		await v.connect.tick()
		assert.equal((await v.connect.status()).state, 'connecting')
	} finally {
		await v.cleanup()
	}
	// The website said the key was already delivered elsewhere.
	const w = await setup()
	try {
		await w.connect.pair({})
		w.site.state.status = 'credentials_delivered'
		await w.connect.tick()
		assert.equal((await w.connect.status()).notice.kind, 'delivery_failed')
	} finally {
		await w.cleanup()
	}
})

async function connected(script) {
	const t = await setup(script)
	await t.connect.pair({})
	t.site.state.status = 'authorized'
	await t.connect.tick()
	return t
}

test('revoked on the website: check-ins stop, the key is forgotten, and pairing again is offered', async () => {
	const t = await connected()
	try {
		await t.connect.tick()
		t.site.state.revoked = true
		await t.connect.tick()
		const s = await t.connect.status()
		assert.equal(s.state, 'revoked')
		assert.equal(s.device.deviceId, DEVICE)
		assert.equal(s.nextAttemptAt, null)
		assert.ok(!(await readFile(t.file, 'utf8')).includes(CRED))
		const before = t.site.calls.length
		await t.connect.tick()
		await t.connect.checkNow()
		assert.equal(t.site.calls.length, before)
		// Pairing again replaces the revoked record.
		t.site.state.status = 'authorization_pending'
		t.site.state.delivered = false
		assert.equal((await t.connect.pair({})).state, 'pairing')
	} finally {
		await t.cleanup()
	}
})

test('offline or the website down: the server keeps its key and keeps trying every minute', async () => {
	let down = 'network'
	const t = await connected({
		'POST /heartbeat': () => (down === 'network' ? Promise.reject(Object.assign(new TypeError('fetch failed'), {cause: {code: 'EAI_AGAIN'}})) : down === '503' ? new Response('', {status: 503}) : undefined),
	})
	try {
		await t.connect.tick()
		let s = await t.connect.status()
		assert.equal(s.state, 'offline')
		assert.equal(s.problem, 'offline')
		assert.ok(s.nextAttemptAt - s.lastAttemptAt >= 60_000)
		assert.ok((await readFile(t.file, 'utf8')).includes(CRED))
		down = '503'
		await t.connect.tick()
		assert.equal((await t.connect.status()).problem, 'unavailable')
		down = ''
		await t.connect.tick()
		s = await t.connect.status()
		assert.equal(s.state, 'connected')
		assert.equal(s.problem, null)
	} finally {
		await t.cleanup()
	}
})

test('heartbeats honour the website’s rate limit, and Check now can’t be hammered', async () => {
	let limited = true
	const t = await connected({'POST /heartbeat': () => (limited ? new Response('', {status: 429, headers: {'retry-after': '120'}}) : undefined)})
	try {
		await t.connect.tick()
		const s = await t.connect.status()
		assert.equal(s.problem, 'rate_limited')
		assert.ok(s.nextAttemptAt - s.lastAttemptAt >= 120_000)
		limited = false
		const n = t.site.calls.length
		await t.connect.checkNow() // within 10 s of the last try: nothing sent
		assert.equal(t.site.calls.length, n)
		t.advance(11_000)
		await t.connect.checkNow()
		assert.equal(t.site.calls.length, n + 1)
	} finally {
		await t.cleanup()
	}
})

test('disconnect forgets the key here; cancel drops a waiting code', async () => {
	const t = await connected()
	try {
		assert.equal((await t.connect.disconnect()).state, 'none')
		const file = await readFile(t.file, 'utf8')
		assert.ok(!file.includes(CRED) && !file.includes(SECRET))
	} finally {
		await t.cleanup()
	}
	const u = await setup()
	try {
		await u.connect.pair({})
		assert.equal((await u.connect.cancel()).state, 'none')
		assert.ok(!(await readFile(u.file, 'utf8')).includes(SECRET))
	} finally {
		await u.cleanup()
	}
})

test('only the website’s own address is shown or put in the QR code; names are checked; https only', async () => {
	const t = await setup({'POST /pair': (_c) => new Response(JSON.stringify({code: 'WXYZ-1234', polling_secret: SECRET, expires_at: new Date(Date.now() + 600_000).toISOString(), expires_in: 600, interval: 5, pair_url: 'https://evil.example/phish'}), {status: 201})})
	try {
		await assert.rejects(t.connect.pair({name: 'x'.repeat(61)}), (e) => e.code === 'BAD_REQUEST')
		assert.equal((await t.connect.pair({name: '  Den  '})).pairing.pairUrl, 'https://myowndatacenter.com/data-centers')
		assert.deepEqual(t.site.calls.at(-1).body, {name: 'Den'})
	} finally {
		await t.cleanup()
	}
	assert.throws(() => createConnect({dataDir: os.tmpdir(), apiBase: 'http://myowndatacenter.com/api/public/cloud', autoStart: false}), /https/)
	// An error answer is never taken for a pairing code.
	const u = await setup({'POST /pair': () => new Response('{"error":"pairing_unavailable"}', {status: 503})})
	try {
		await assert.rejects(u.connect.pair({}), (e) => e.code === 'BAD_GATEWAY')
		assert.equal((await u.connect.status()).state, 'none')
	} finally {
		await u.cleanup()
	}
})

test('a state file others could read is put back to owner-only; a damaged one is left alone', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'modc-connect-perm-'))
	try {
		await mkdir(join(root, 'connect'), {recursive: true})
		const f = join(root, 'connect', 'connect.json')
		await writeFile(f, JSON.stringify({device: {deviceId: DEVICE, dataCenterId: CENTER, name: 'x', pairedAt: 1, credential: CRED}}))
		await chmod(f, 0o644)
		const c = createConnect({dataDir: root, autoStart: false, fetchImpl: async () => new Response('{"ok":true}', {status: 200}), log: () => {}, tunnelOptions: {unitDir: join(root, 'units'), systemPaths: [], sh: async () => ({ok: false, out: ''})}})
		await c.ready
		assert.equal((await stat(f)).mode & 0o777, 0o600)
		assert.equal((await c.status()).state, 'connecting')
		c.close()
		await writeFile(f, '{not json')
		const d = createConnect({dataDir: root, autoStart: false, fetchImpl: async () => new Response('', {status: 500}), log: () => {}, tunnelOptions: {unitDir: join(root, 'units'), systemPaths: [], sh: async () => ({ok: false, out: ''})}})
		await d.ready
		assert.equal((await d.status()).state, 'none')
		d.close()
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('through omarchyd: owner only, never a secret in an answer, and the server works with the website down', async () => {
	const {startOmarchyd} = await import('../omarchyd/server.mjs')
	const {openAccounts} = await import('../omarchyd/accounts.mjs')
	const root = await mkdtemp(join(os.tmpdir(), 'modc-connect-d-'))
	const data = join(root, 'data')
	await mkdir(data, {recursive: true})
	const site = website()
	let d
	try {
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const st = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8'))
		st.users.push({...st.users[0], userId: 'member', name: 'Pat', role: 'member'})
		await writeFile(join(data, 'accounts.json'), JSON.stringify(st, null, '\t'))
		d = await startOmarchyd({port: 0, dataDir: data, home: root, appOptions: {run: async () => '', defaultStores: [], systemApps: null}, updaterOptions: {autoCheck: false}, connectOptions: {fetchImpl: site.fetchImpl, autoStart: false}})
		const login = async (userId) => {
			const r = await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 't'}})})
			return {authorization: `Bearer ${(await r.json()).result.data.accessToken}`}
		}
		const owner = await login('owner')
		const member = await login('member')
		const call = async (kind, path, input, headers) => {
			const r = await fetch(`${d.url}/trpc/${path}`, {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...headers, 'content-type': 'application/json'}, ...(kind === 'mutation' ? {body: JSON.stringify(input ?? null)} : {})})
			return {status: r.status, text: await r.text()}
		}
		const denied = await call('mutation', 'connect.pair', {name: 'x'}, member)
		assert.equal(denied.status, 403)
		assert.equal((await call('query', 'connect.status', undefined, member)).status, 403)
		assert.equal(site.calls.length, 0)
		const paired = await call('mutation', 'connect.pair', {name: 'Home server'}, owner)
		assert.equal(paired.status, 200)
		assert.match(paired.text, /ABCD-EFGH/)
		assert.ok(!paired.text.includes(SECRET))
		const status = await call('query', 'connect.status', undefined, owner)
		assert.ok(!status.text.includes(SECRET))
		// Without the website (never reached, or down), signing in and the rest still work.
		assert.equal((await call('query', 'system.version', undefined, owner)).status, 200)
		assert.equal((await login('owner')).authorization.startsWith('Bearer '), true)
	} finally {
		await d?.close()
		await rm(root, {recursive: true, force: true})
	}
})
