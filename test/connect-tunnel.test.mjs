// MODC Connect, Phase 5B: the local Cloudflare connector, against stand-ins for myowndatacenter.com
// (the Phase 5A contract), systemd and cloudflared. Nothing here runs a real cloudflared or systemctl.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createConnect, CONNECT_API} from '../omarchyd/connect.mjs'
import {PROBE_PATHS, UNIT, parseVersion, probeAnswer, unitText, versionAtLeast} from '../omarchyd/connect-tunnel.mjs'

const SECRET = 'a'.repeat(64)
const CRED = 'b'.repeat(64)
const DEVICE = '11111111-2222-4333-8444-555555555555'
const CENTER = '1d6f2bd5-6455-466e-9934-b600e5803ed4'
const TUNNEL = '499d8de7-ce47-492a-9499-3d09c7a2a2e8'
const TOKEN_1 = 'eyJhIjoiMDEyMzQ1Njc4OWFiY2RlZiIsInQiOiI0OTlkOGRlNyIsInMiOiJPTEQifQ=='
const TOKEN_2 = 'eyJhIjoiMDEyMzQ1Njc4OWFiY2RlZiIsInQiOiI0OTlkOGRlNyIsInMiOiJORVcifQ=='
const SECRETS = [SECRET, CRED, TOKEN_1, TOKEN_2]

const json = (status, body, headers = {}) => new Response(body == null ? '' : JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}})

// The website: pairing (Phase 3) and the tunnel (Phase 5A). `over` replaces an answer.
function website() {
	const site = {
		calls: [],
		revoked: false,
		paired: false,
		tunnel: 'active', // 'none' for no tunnel
		health: 'inactive',
		rotatedAt: null,
		token: TOKEN_1,
		over: {},
	}
	site.fetchImpl = async (url, init = {}) => {
		const path = url.replace('https://myowndatacenter.com', '')
		const call = {method: init.method, path, auth: init.headers?.authorization ?? null, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect}
		site.calls.push(call)
		const key = `${init.method} ${path}`
		if (site.over[key]) {
			const r = await site.over[key](call)
			if (r !== undefined) return r
		}
		const p = '/api/public/cloud'
		if (key === `POST ${p}/pair`) return json(201, {code: 'ABCD-EFGH', polling_secret: SECRET, expires_at: new Date(Date.now() + 600_000).toISOString(), expires_in: 600, interval: 5, pair_url: 'https://myowndatacenter.com/data-centers'})
		if (key === `GET ${p}/pair`) return json(200, {status: site.paired ? 'credentials_delivered' : 'authorized', interval: 5})
		if (key === `POST ${p}/pair/credentials`) {
			site.paired = true
			return json(200, {device_id: DEVICE, data_center_id: CENTER, device_credential: CRED, token_type: 'Bearer', scope: 'device:heartbeat', remote_access: false})
		}
		const authed = call.auth === `Bearer ${CRED}`
		if (key === `POST ${p}/heartbeat`) return !authed ? json(401, {error: 'missing_credential'}) : site.revoked ? json(404, {error: 'not_found'}) : json(200, {ok: true})
		if (path.startsWith(`${p}/tunnel/`)) {
			if (!authed) return json(401, {error: 'invalid_credential'})
			if (site.revoked) return json(401, {error: 'device_revoked'})
			if (site.tunnel === 'none') return json(404, {error: 'no_tunnel'})
		}
		if (key === `GET ${p}/tunnel/status`)
			return json(200, {
				data_center_id: CENTER,
				device_id: DEVICE,
				checked_at: new Date().toISOString(),
				provisioning: {status: site.tunnel, hostname: 'nodezero.myowndatacenter.com', provisioned_at: '2026-11-24T04:10:00Z'},
				connector: {health: site.health, connections: site.health === 'healthy' ? 4 : 0, colos: site.health === 'healthy' ? ['dfw01'] : [], client_version: '2026.11.2', connected_since: site.health === 'healthy' ? '2026-11-24T05:39:00Z' : null, error: null},
				remote_access: {enabled: false, ingress: 'deny_all'},
				credentials: {rotation_required: false, secret_rotated_at: site.rotatedAt, last_token_issued_at: null},
			})
		if (key === `POST ${p}/tunnel/token`) {
			if (site.tunnel !== 'active') return json(409, {error: 'tunnel_not_ready'})
			return json(200, {token_type: 'cloudflared_tunnel_token', tunnel_token: site.token, issued_at: new Date(site.clock()).toISOString(), tunnel_id: TUNNEL, tunnel_name: `modc-${CENTER}`, hostname: 'nodezero.myowndatacenter.com', data_center_id: CENTER, device_id: DEVICE, ingress: 'deny_all', remote_access: false})
		}
		return json(404, {error: 'not_found'})
	}
	return site
}

// systemd --user and cloudflared, as far as this module can see them.
function machine({version = '2026.11.2', others = ['cloudflared.service loaded active running cloudflared'], systemPath = null} = {}) {
	const m = {calls: [], units: {}, version, others}
	m.sh = async (cmd, args) => {
		m.calls.push([cmd, ...args])
		if (cmd === 'systemctl') {
			const a = args[0] === '--user' ? args.slice(1) : args
			const user = args[0] === '--user'
			if (a[0] === 'list-units') return {ok: true, out: user ? '' : m.others.join('\n')}
			if (a[0] === 'show') {
				const u = m.units[a[1]] ?? {active: 'inactive', enabled: false}
				return {ok: true, out: `ActiveState=${u.active}\nSubState=running\nNRestarts=0\nUnitFileState=${u.enabled ? 'enabled' : 'disabled'}\nActiveEnterTimestamp=\n`}
			}
			const unit = a.at(-1)
			const u = (m.units[unit] ??= {active: 'inactive', enabled: false})
			if (a[0] === 'enable') u.enabled = true
			if (a[0] === 'disable') (u.enabled = false), a.includes('--now') && (u.active = 'inactive')
			if (a[0] === 'start' || a[0] === 'restart') u.active = 'active'
			if (a[0] === 'stop') u.active = 'inactive'
			return {ok: true, out: ''}
		}
		if (args[0] === '--version') return m.version ? {ok: true, out: `cloudflared version ${m.version} (built 2026-11-23-13:03 UTC)\n`} : {ok: false, out: ''}
		return {ok: false, out: ''}
	}
	m.systemPath = systemPath
	return m
}

async function setup({mach = machine(), pinned, connectOpts = {}} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'modc-tunnel-'))
	const site = website()
	let clock = Date.parse('2026-11-24T06:00:00Z')
	site.clock = () => clock
	const logs = []
	const bin = join(root, 'usr-bin-cloudflared')
	await writeFile(bin, '#!/bin/sh\n')
	const opts = {
		dataDir: root,
		fetchImpl: site.fetchImpl,
		autoStart: false,
		now: () => clock,
		log: (m) => logs.push(m),
		tunnelOptions: {unitDir: join(root, 'units'), sh: mach.sh, systemPaths: [bin], random: () => 0.5, ...(pinned ? {pinned, arch: 'amd64'} : {})},
		...connectOpts,
	}
	const connect = createConnect(opts)
	await connect.ready
	// Pair it (Phase 3), then the first heartbeat.
	await connect.pair({name: 'omarchy'})
	await connect.tick()
	await connect.tick()
	const t = {
		root,
		site,
		mach,
		logs,
		connect,
		tunnel: connect.tunnel,
		advance: (ms) => (clock += ms),
		reopen: async () => {
			connect.close()
			const again = createConnect(opts)
			await again.ready
			return again
		},
		dir: join(root, 'connect'),
		tokenFile: join(root, 'connect', 'tunnel.token'),
		unitFile: join(root, 'units', UNIT),
		call: (name, input) => connect.procedures[name].run(input),
		cleanup: () => (connect.close(), rm(root, {recursive: true, force: true})),
	}
	assert.equal((await connect.status()).state, 'connected')
	return t
}

const noSecrets = (value, label = 'value') => {
	const text = typeof value === 'string' ? value : JSON.stringify(value)
	for (const s of SECRETS) assert.ok(!text.includes(s), `a secret leaked into ${label}`)
}
const tunnelCalls = (t, what) => t.site.calls.filter((c) => c.path === `/api/public/cloud/tunnel/${what}`)
// Every unit named in a systemctl command that changes or reads one (list-units only reads names).
const systemctlUnits = (t) => t.mach.calls.filter((c) => c[0] === 'systemctl' && !c.includes('list-units')).flatMap((c) => c.filter((x) => /\.service$/.test(x)))

test('versions: --token-file needs cloudflared 2025.4.0 or later', () => {
	assert.deepEqual(parseVersion('cloudflared version 2026.11.2 (built 2026-11-23)'), [2026, 11, 2])
	assert.equal(versionAtLeast([2025, 4, 0]), true)
	assert.equal(versionAtLeast([2025, 3, 9]), false)
	assert.equal(versionAtLeast(null), false)
})

test('the unit: an empty environment, only paths on the command line, its own config, no ingress', () => {
	const u = unitText({bin: '/usr/bin/cloudflared', config: '/d/connect/cloudflared.yml', token: '/d/connect/tunnel.token'})
	assert.match(u, /ExecStart=\/usr\/bin\/env -i HOME=%h PATH=\S+ "\/usr\/bin\/cloudflared" tunnel --no-autoupdate --config "\/d\/connect\/cloudflared\.yml" run --token-file "\/d\/connect\/tunnel\.token"/)
	assert.doesNotMatch(u, /--token |TUNNEL_TOKEN|ingress:|--url|hello-world/)
	assert.match(u, /WantedBy=default\.target/)
	assert.match(u, /Restart=on-failure/)
})

test('enable: token fetched once with the device credential, saved 0600, connector started; nothing secret leaves', async () => {
	const t = await setup()
	try {
		// Before it's turned on: the address and setup state show, nothing runs.
		await t.tunnel.tick()
		let s = (await t.connect.status()).tunnel
		assert.equal(s.enabled, false)
		assert.equal(s.hostname, 'nodezero.myowndatacenter.com')
		assert.equal(s.provisioning, 'active')
		assert.equal(tunnelCalls(t, 'token').length, 0)
		assert.equal(await stat(t.unitFile).catch(() => null), null)

		s = (await t.call('connect.tunnel.enable')).tunnel
		const tokens = tunnelCalls(t, 'token')
		assert.equal(tokens.length, 1)
		assert.equal(tokens[0].method, 'POST')
		assert.equal(tokens[0].auth, `Bearer ${CRED}`)
		assert.deepEqual(tokens[0].body, {})
		assert.equal(tokens[0].redirect, 'error')
		assert.equal(await readFile(t.tokenFile, 'utf8'), TOKEN_1)
		assert.equal((await stat(t.tokenFile)).mode & 0o777, 0o600)
		assert.equal((await stat(t.dir)).mode & 0o777, 0o700)
		const unit = await readFile(t.unitFile, 'utf8')
		noSecrets(unit, 'the unit file')
		noSecrets(await readFile(join(t.dir, 'cloudflared.yml'), 'utf8'), 'the config')
		noSecrets(await readFile(join(t.dir, 'tunnel.json'), 'utf8'), 'tunnel.json')
		assert.equal(t.mach.units[UNIT].active, 'active')
		assert.equal(t.mach.units[UNIT].enabled, true)
		// Every command: no secret in any argument, and only our own unit is ever acted on.
		noSecrets(t.mach.calls, 'a command line')
		for (const u of systemctlUnits(t)) assert.equal(u, UNIT, `touched ${u}`)
		assert.equal(s.enabled, true)
		assert.equal(s.remoteAccess, false)
		assert.equal(s.ingress, 'deny_all')
		assert.deepEqual(s.others, ['system:cloudflared.service'])
		assert.equal(s.cloudflared.version, '2026.11.2')
		noSecrets(await t.connect.status(), 'the status answer')
		noSecrets(t.logs, 'the log')

		// Cloudflare sees it: healthy, and when.
		t.site.health = 'healthy'
		t.advance(30_000)
		await t.tunnel.tick()
		s = (await t.connect.status()).tunnel
		assert.equal(s.health, 'healthy')
		assert.equal(s.connections, 4)
		assert.deepEqual(s.colos, ['dfw01'])
		assert.ok(s.lastHealthyAt)
		assert.equal(tunnelCalls(t, 'token').length, 1, 'the token is never polled')
		assert.ok(s.nextCheckAt - t.site.clock() >= 4 * 60_000)
	} finally {
		await t.cleanup()
	}
})

test('rotation: a newer secret on the website means one new token and a restarted connector', async () => {
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		const restarts = () => t.mach.calls.filter((c) => c[2] === 'restart').length
		const before = restarts()
		t.advance(10 * 60_000)
		t.site.rotatedAt = new Date(t.site.clock()).toISOString()
		t.site.token = TOKEN_2
		t.advance(60_000)
		await t.tunnel.tick()
		assert.equal(await readFile(t.tokenFile, 'utf8'), TOKEN_2, 'the old token is replaced')
		assert.equal(tunnelCalls(t, 'token').length, 2)
		assert.equal(restarts(), before + 1)
		// Next check: nothing more to do.
		await t.tunnel.tick()
		assert.equal(tunnelCalls(t, 'token').length, 2)
	} finally {
		await t.cleanup()
	}
})

test('revoked (the tunnel says device_revoked): connector stopped, token wiped, unit removed, device unpaired', async () => {
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		t.site.revoked = true
		await t.tunnel.tick()
		await new Promise((r) => setTimeout(r, 20))
		assert.equal(t.mach.units[UNIT].active, 'inactive')
		assert.equal(t.mach.units[UNIT].enabled, false)
		assert.equal(await stat(t.tokenFile).catch(() => null), null)
		const s = await t.connect.status()
		assert.equal(s.state, 'revoked')
		assert.equal(s.tunnel, null)
		assert.ok(!(await readFile(join(t.dir, 'connect.json'), 'utf8')).includes(CRED))
		// Nothing more is sent: no heartbeats, no tunnel calls.
		const n = t.site.calls.length
		await t.connect.tick()
		await t.tunnel.tick()
		assert.equal(t.site.calls.length, n)
	} finally {
		await t.cleanup()
	}
})

test('revoked (a heartbeat says so): the connector stops and its token is wiped too', async () => {
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		t.site.revoked = true
		t.advance(60_000)
		await t.connect.tick()
		await new Promise((r) => setTimeout(r, 50))
		assert.equal((await t.connect.status()).state, 'revoked')
		assert.equal(t.mach.units[UNIT].active, 'inactive')
		assert.equal(await stat(t.tokenFile).catch(() => null), null)
		assert.equal(await stat(t.unitFile).catch(() => null), null)
	} finally {
		await t.cleanup()
	}
})

test('tunnel removed on the website: connector stops, token goes, the device stays paired and keeps checking in', async () => {
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		t.site.tunnel = 'none'
		await t.tunnel.tick()
		assert.equal(t.mach.units[UNIT].active, 'inactive')
		assert.equal(await stat(t.tokenFile).catch(() => null), null)
		let s = await t.connect.status()
		assert.equal(s.state, 'connected')
		assert.equal(s.tunnel.block.code, 'no_tunnel')
		assert.match(s.tunnel.block.recovery, /My Data Centers/)
		const hb = t.site.calls.filter((c) => c.path.endsWith('/heartbeat')).length
		t.advance(60_000)
		await t.connect.tick()
		assert.equal(t.site.calls.filter((c) => c.path.endsWith('/heartbeat')).length, hb + 1)
		assert.equal((await t.connect.status()).state, 'connected')
		// The owner creates it again: still on, so it comes back by itself.
		t.site.tunnel = 'active'
		t.advance(30 * 60_000)
		await t.tunnel.tick()
		s = (await t.connect.status()).tunnel
		assert.equal(s.block, null)
		assert.equal(t.mach.units[UNIT].active, 'active')
		assert.equal(await readFile(t.tokenFile, 'utf8'), TOKEN_1)
	} finally {
		await t.cleanup()
	}
})

test('not the connector / not in the pilot: stops and waits; never retried in a loop', async () => {
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		t.site.over['GET /api/public/cloud/tunnel/status'] = () => json(403, {error: 'not_connector'})
		await t.tunnel.tick()
		let s = (await t.connect.status()).tunnel
		assert.equal(s.block.code, 'not_connector')
		assert.equal(t.mach.units[UNIT].active, 'inactive')
		// The owner fixes this on the website (Turn on moves the tunnel here), so it looks again in about 2 minutes, not sooner.
		assert.ok(s.nextCheckAt - t.site.clock() >= 110_000 && s.nextCheckAt - t.site.clock() <= 130_000)
		assert.match(s.block.recovery, /Turn on remote access/)
		t.site.over['GET /api/public/cloud/tunnel/status'] = () => json(403, {error: 'not_allowed'})
		await t.tunnel.tick()
		s = (await t.connect.status()).tunnel
		assert.equal(s.block.code, 'not_allowed')
		assert.ok(s.nextCheckAt - t.site.clock() >= 5 * 3600_000)
	} finally {
		await t.cleanup()
	}
})

test('a busy tunnel: at most 3 automatic tries with backoff, honouring Retry-After, then Try again', async () => {
	const t = await setup()
	try {
		t.site.over['POST /api/public/cloud/tunnel/token'] = () => json(429, {error: 'rate_limited'}, {'retry-after': '600'})
		await t.call('connect.tunnel.enable')
		let s = (await t.connect.status()).tunnel
		assert.ok(s.nextCheckAt - t.site.clock() >= 600_000, 'Retry-After is honoured')
		t.site.over['POST /api/public/cloud/tunnel/token'] = () => json(409, {error: 'tunnel_busy'})
		for (let i = 0; i < 5; i++) {
			t.advance(20 * 60_000)
			await t.tunnel.tick()
		}
		assert.equal(tunnelCalls(t, 'token').length, 3, 'three automatic tries, no more')
		s = (await t.connect.status()).tunnel
		assert.equal(s.block.code, 'token_failed')
		assert.equal(t.mach.units[UNIT]?.active ?? 'inactive', 'inactive')
		delete t.site.over['POST /api/public/cloud/tunnel/token']
		t.advance(60_000)
		s = (await t.call('connect.tunnel.check')).tunnel
		assert.equal(s.block, null)
		assert.equal(t.mach.units[UNIT].active, 'active')
	} finally {
		await t.cleanup()
	}
})

test('a token answer that isn’t deny-all with remote access off is refused; nothing runs', async () => {
	const t = await setup()
	try {
		t.site.over['POST /api/public/cloud/tunnel/token'] = () =>
			json(200, {token_type: 'cloudflared_tunnel_token', tunnel_token: TOKEN_1, issued_at: new Date().toISOString(), tunnel_id: TUNNEL, tunnel_name: 'x', hostname: 'nodezero.myowndatacenter.com', data_center_id: CENTER, device_id: DEVICE, ingress: 'allow', remote_access: true})
		const s = (await t.call('connect.tunnel.enable')).tunnel
		assert.equal(s.block.code, 'unsafe')
		assert.equal(await stat(t.tokenFile).catch(() => null), null)
		assert.equal(t.mach.units[UNIT]?.active ?? 'inactive', 'inactive')
		assert.equal(s.remoteAccess, false)
	} finally {
		await t.cleanup()
	}
})

test('offline or the website down: a running connector is left running, and the device stays paired', async () => {
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		const n = t.mach.calls.length
		t.site.over['GET /api/public/cloud/tunnel/status'] = () => Promise.reject(Object.assign(new TypeError('fetch failed'), {cause: {code: 'ENOTFOUND'}}))
		await t.tunnel.tick()
		t.site.over['GET /api/public/cloud/tunnel/status'] = () => json(503, {error: 'unavailable'})
		await t.tunnel.tick()
		assert.ok(!t.mach.calls.slice(n).some((c) => c.includes('disable') || c.includes('stop')))
		assert.equal(t.mach.units[UNIT].active, 'active')
		assert.equal((await t.connect.status()).tunnel.problem, 'unavailable')
	} finally {
		await t.cleanup()
	}
})

test('after a restart it reconnects by itself when it was on, without asking for a new token', async () => {
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		t.mach.units[UNIT].active = 'inactive' // the machine rebooted and the unit hasn't come up
		const again = await t.reopen()
		await again.tunnel.tick()
		assert.equal(t.mach.units[UNIT].active, 'active')
		assert.equal(tunnelCalls(t, 'token').length, 1)
		again.close()
	} finally {
		await t.cleanup()
	}
})

test('turning it off stops and removes only our unit and wipes the token; disconnecting does too', async () => {
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		const s = (await t.call('connect.tunnel.disable')).tunnel
		assert.equal(s.enabled, false)
		assert.equal(await stat(t.tokenFile).catch(() => null), null)
		assert.equal(await stat(t.unitFile).catch(() => null), null)
		assert.equal(t.mach.units[UNIT].active, 'inactive')
		for (const u of systemctlUnits(t)) assert.equal(u, UNIT, `touched ${u}`)
		await t.call('connect.tunnel.enable')
		await t.call('connect.disconnect')
		assert.equal(await stat(t.tokenFile).catch(() => null), null)
		assert.equal(await stat(t.unitFile).catch(() => null), null)
		assert.equal(t.mach.units[UNIT].active, 'inactive')
	} finally {
		await t.cleanup()
	}
})

test('cloudflared too old or missing: turning it on asks for the newer one', async () => {
	const t = await setup({mach: machine({version: '2024.12.0'})})
	try {
		await assert.rejects(t.call('connect.tunnel.enable'), (e) => e.code === 'PRECONDITION_FAILED' && /too old/.test(e.message))
		const s = (await t.connect.status()).tunnel
		assert.equal(s.cloudflared.compatible, false)
		assert.equal(s.cloudflared.installable, true)
	} finally {
		await t.cleanup()
	}
	const u = await setup({mach: machine({version: null})})
	try {
		await assert.rejects(u.call('connect.tunnel.enable'), (e) => /Install cloudflared/.test(e.message))
	} finally {
		await u.cleanup()
	}
})

test('installing cloudflared: Cloudflare’s build, only if its SHA-256 matches', async () => {
	const good = Buffer.from('pretend this is cloudflared')
	const pinned = {version: '2026.11.2', url: (a) => `https://github.com/cloudflare/cloudflared/releases/download/2026.11.2/cloudflared-linux-${a}`, sha256: {amd64: createHash('sha256').update(good).digest('hex')}, maxBytes: 1024}
	const t = await setup({mach: machine({version: null}), pinned})
	try {
		let body = Buffer.from('something else')
		t.site.over[`GET ${pinned.url('amd64')}`] = () => new Response(body, {status: 200})
		const prev = t.site.fetchImpl
		t.mach.version = null
		await assert.rejects(t.call('connect.tunnel.install'), /didn’t match/)
		assert.equal(await stat(join(t.dir, 'bin', 'cloudflared')).catch(() => null), null)
		body = good
		t.mach.version = '2026.11.2'
		const s = (await t.call('connect.tunnel.install')).tunnel
		const st = await stat(join(t.dir, 'bin', 'cloudflared'))
		assert.equal(st.mode & 0o777, 0o755)
		assert.equal(s.cloudflared.source, 'managed')
		assert.equal(s.cloudflared.compatible, true)
		assert.ok(prev)
	} finally {
		await t.cleanup()
	}
})

test('the token is fetched at most 6 times an hour, whatever happens', async () => {
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		for (let i = 0; i < 10; i++) {
			t.site.rotatedAt = new Date(t.site.clock() + 1000).toISOString()
			t.advance(2000)
			await t.tunnel.tick()
		}
		assert.ok(tunnelCalls(t, 'token').length <= 6)
	} finally {
		await t.cleanup()
	}
})

// ---- Remote access through the tunnel ("protected_route"), as production now reports it ----------
const PROD_STATUS = (health = 'down') => ({
	provisioning: {status: 'active', hostname: 'nodezero.myowndatacenter.com'},
	connector: {health, connections: health === 'healthy' ? 4 : 0},
	remote_access: {enabled: true, ingress: 'protected_route', state: 'enabled', mode: 'adopted', config_version: 1},
	credentials: {rotation_required: false, secret_rotated_at: null},
})
const ACCESS_LOGIN = 'https://modc.cloudflareaccess.com/cdn-cgi/access/login/nodezero.myowndatacenter.com?kid=x&redirect_url=%2F'
function protectedRoute(t, probe = () => new Response('', {status: 302, headers: {location: ACCESS_LOGIN}})) {
	t.site.over['GET /api/public/cloud/tunnel/status'] = () => json(200, PROD_STATUS(t.site.health))
	const tokenAnswer = () => json(200, {token_type: 'cloudflared_tunnel_token', tunnel_token: t.site.token, issued_at: new Date(t.site.clock()).toISOString(), tunnel_id: TUNNEL, tunnel_name: `modc-${CENTER}`, hostname: 'nodezero.myowndatacenter.com', data_center_id: CENTER, device_id: DEVICE, ingress: 'protected_route', remote_access: true})
	t.site.over['POST /api/public/cloud/tunnel/token'] = tokenAnswer
	for (const p of PROBE_PATHS) t.site.over[`GET https://nodezero.myowndatacenter.com${p}`] = (c) => probe(p, c)
}

test('production’s protected route: runs once this server sees Cloudflare Access in front of every probed path', async () => {
	const t = await setup()
	try {
		protectedRoute(t)
		const s = (await t.call('connect.tunnel.enable')).tunnel
		assert.equal(s.block, null)
		assert.equal(s.remoteAccess, true)
		assert.equal(s.ingress, 'protected_route')
		assert.equal(s.accessVerified, true)
		assert.equal(await readFile(t.tokenFile, 'utf8'), TOKEN_1)
		assert.equal(t.mach.units[UNIT].active, 'active')
		// The probes carried nothing: no cookie, no credential, no Access token, and didn't follow redirects.
		const probes = t.site.calls.filter((c) => c.path.startsWith('https://nodezero'))
		assert.equal(probes.length, 3)
		for (const p of probes) {
			assert.equal(p.auth, null)
			assert.equal(p.redirect, 'manual')
		}
	} finally {
		await t.cleanup()
	}
})

test('an old “unsafe” block, a wiped token and a stopped service recover by themselves once the setup checks out', async () => {
	const t = await setup()
	try {
		protectedRoute(t)
		// What the server was left with: on, blocked as unsafe, no token, service off.
		await writeFile(join(t.dir, 'tunnel.json'), JSON.stringify({enabled: true, block: {code: 'unsafe', at: 1}, tokenIssuedAt: null}))
		const again = await t.reopen()
		await again.tunnel.tick()
		const s = (await again.status()).tunnel
		assert.equal(s.block, null)
		assert.equal(await readFile(t.tokenFile, 'utf8'), TOKEN_1, 'the missing token was fetched')
		assert.equal(t.mach.units[UNIT].active, 'active')
		assert.equal(t.mach.units[UNIT].enabled, true, 'enabled to start at boot')
		again.close()
	} finally {
		await t.cleanup()
	}
})

test('protected route without Access in front: refused, connector stopped, token wiped, with the reason', async () => {
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		assert.equal(t.mach.units[UNIT].active, 'active')
		protectedRoute(t, (p) => (p === '/api/health' ? new Response('{"ok":true}', {status: 200}) : new Response('', {status: 302, headers: {location: ACCESS_LOGIN}})))
		t.advance(5 * 60_000)
		await t.tunnel.tick()
		const s = (await t.connect.status()).tunnel
		assert.equal(s.block.code, 'unprotected')
		assert.match(s.block.detail, /\/api\/health answered HTTP 200/)
		assert.equal(t.mach.units[UNIT].active, 'inactive')
		assert.equal(await stat(t.tokenFile).catch(() => null), null)
		// A redirect anywhere other than the Access sign-in doesn't count either.
		protectedRoute(t, () => new Response('', {status: 302, headers: {location: 'https://evil.example/cdn-cgi/access/login/x'}}))
		t.advance(5 * 60_000)
		await t.tunnel.tick()
		assert.equal((await t.connect.status()).tunnel.block.code, 'unprotected')
	} finally {
		await t.cleanup()
	}
})

test('the label alone isn’t enough: remote access on but not “enabled”, or an unknown ingress, stays unsafe', async () => {
	const t = await setup()
	try {
		t.site.over['GET /api/public/cloud/tunnel/status'] = () => json(200, {...PROD_STATUS(), remote_access: {enabled: true, ingress: 'protected_route', state: 'pending'}})
		assert.equal((await t.call('connect.tunnel.enable')).tunnel.block.code, 'unsafe')
		t.site.over['GET /api/public/cloud/tunnel/status'] = () => json(200, {...PROD_STATUS(), remote_access: {enabled: true, ingress: 'public'}})
		t.advance(60_000)
		await t.tunnel.tick()
		assert.equal((await t.connect.status()).tunnel.block.code, 'unsafe')
		assert.equal(tunnelCalls(t, 'token').length, 0)
		// A token answer claiming a protected route that wasn't checked: refused.
		delete t.site.over['GET /api/public/cloud/tunnel/status']
		t.site.over['POST /api/public/cloud/tunnel/token'] = () => json(200, {token_type: 'cloudflared_tunnel_token', tunnel_token: TOKEN_1, issued_at: new Date().toISOString(), tunnel_id: TUNNEL, hostname: 'nodezero.myowndatacenter.com', ingress: 'protected_route', remote_access: true})
		t.advance(60_000)
		await t.call('connect.tunnel.check')
		assert.equal((await t.connect.status()).tunnel.block.code, 'unsafe')
		assert.equal(await stat(t.tokenFile).catch(() => null), null)
	} finally {
		await t.cleanup()
	}
})

test('Access can’t be confirmed (offline): paused with the token kept, back by itself when it can', async () => {
	const t = await setup()
	try {
		protectedRoute(t)
		await t.call('connect.tunnel.enable')
		protectedRoute(t, () => Promise.reject(new TypeError('fetch failed')))
		t.advance(5 * 60_000)
		await t.tunnel.tick()
		let s = (await t.connect.status()).tunnel
		assert.equal(s.problem, 'protection_unverified')
		assert.equal(t.mach.units[UNIT].active, 'inactive')
		assert.equal(await readFile(t.tokenFile, 'utf8'), TOKEN_1)
		protectedRoute(t)
		t.advance(5 * 60_000)
		await t.tunnel.tick()
		s = (await t.connect.status()).tunnel
		assert.equal(s.problem, null)
		assert.equal(t.mach.units[UNIT].active, 'active')
		assert.equal(tunnelCalls(t, 'token').length, 1, 'no new token needed')
	} finally {
		await t.cleanup()
	}
})

test('no restart loop without a token, and Check now always answers', async () => {
	assert.match(unitText({bin: '/usr/bin/cloudflared', config: '/d/c.yml', token: '/d/connect/tunnel.token'}), /^ConditionFileNotEmpty=\/d\/connect\/tunnel\.token$/m)
	const t = await setup()
	try {
		await t.call('connect.tunnel.enable')
		t.advance(20_000)
		await t.call('connect.tunnel.check')
		await assert.rejects(t.call('connect.tunnel.check'), (e) => e.code === 'TOO_MANY_REQUESTS' && /Try again/.test(e.message))
	} finally {
		await t.cleanup()
	}
})

test('contract v2 (SSO only): runs only when this server’s own sign-in gate answers on the hostname, without Access', async () => {
	const t = await setup()
	try {
		protectedRoute(t)
		const v2 = () => {
			const b = PROD_STATUS(t.site.health)
			b.remote_access.security = {contract_version: 2, protection_mode: 'modc_sso'}
			return json(200, b)
		}
		t.site.over['GET /api/public/cloud/tunnel/status'] = v2
		const gated = () => new Response('{}', {status: 401, headers: {'x-modc-gate': 'sso_only'}})
		for (const p of ['/api/prefs', '/api/rpc/user.get']) t.site.over[`GET https://nodezero.myowndatacenter.com${p}`] = gated
		const s = (await t.call('connect.tunnel.enable')).tunnel
		assert.equal(s.block, null)
		assert.equal(t.mach.units[UNIT].active, 'active')
		// The gate disappears (a plain 401 without it, or an open page): stopped.
		t.site.over['GET https://nodezero.myowndatacenter.com/api/prefs'] = () => new Response('{}', {status: 200})
		t.advance(5 * 60_000)
		await t.tunnel.tick()
		assert.equal((await t.connect.status()).tunnel.block.code, 'unprotected')
		assert.equal(t.mach.units[UNIT].active, 'inactive')
	} finally {
		await t.cleanup()
	}
})

// The website switches between Cloudflare Access and this server's gate (and a new address answers 404
// until its route goes live). Every one of those keeps strangers out, so the connector keeps running
// through them; before, a v2 server saw Access still in front, called it unprotected and shut down in the
// middle of the website's own checks (the 2026-11-25 failed activation).
function v2Status(t) {
	t.site.over['GET /api/public/cloud/tunnel/status'] = () => {
		const b = PROD_STATUS(t.site.health)
		b.remote_access.security = {contract_version: 2, protection_mode: 'modc_sso'}
		return json(200, b)
	}
}
const accessLogin = () => new Response('', {status: 302, headers: {location: ACCESS_LOGIN}})
const gated = () => new Response('{}', {status: 401, headers: {'x-modc-gate': 'sso_only'}})
for (const [name, probe] of [
	['Cloudflare Access still in front while the website prepares the gate', accessLogin],
	['a new address: the route isn’t live yet (404 catch-all)', () => new Response('', {status: 404})],
	['halfway through the switch: Access on one path, the gate on the others', (p) => (p === '/api/health' ? accessLogin() : gated())],
	['the connector not reaching Cloudflare yet (530)', () => new Response('', {status: 530})],
]) {
	test(`contract v2 keeps running through a safe answer: ${name}`, async () => {
		const t = await setup()
		try {
			protectedRoute(t, probe)
			v2Status(t)
			const s = (await t.call('connect.tunnel.enable')).tunnel
			assert.equal(s.block, null)
			assert.equal(t.mach.units[UNIT].active, 'active')
			t.advance(5 * 60_000)
			await t.tunnel.tick()
			assert.equal((await t.connect.status()).tunnel.block, null)
			assert.equal(t.mach.units[UNIT].active, 'active')
		} finally {
			await t.cleanup()
		}
	})
}
for (const [name, probe] of [
	['the password sign-in answering (401 without the gate)', () => new Response('{}', {status: 401})],
	['an open page', () => new Response('{}', {status: 200})],
	['a redirect that isn’t Cloudflare’s sign-in', () => new Response('', {status: 302, headers: {location: 'https://evil.example/cdn-cgi/access/login/x'}})],
]) {
	test(`contract v1 or v2, anything exposed stops the connector and wipes the token: ${name}`, async () => {
		for (const v2 of [false, true]) {
			const t = await setup()
			try {
				protectedRoute(t)
				if (v2) v2Status(t)
				await t.call('connect.tunnel.enable')
				assert.equal(t.mach.units[UNIT].active, 'active')
				protectedRoute(t, (p) => (p === '/api/prefs' ? probe() : accessLogin()))
				if (v2) v2Status(t)
				t.advance(5 * 60_000)
				await t.tunnel.tick()
				const st = (await t.connect.status()).tunnel
				assert.equal(st.block.code, 'unprotected')
				assert.match(st.block.detail, /\/api\/prefs answered/)
				assert.equal(t.mach.units[UNIT].active, 'inactive')
				assert.equal(await stat(t.tokenFile).catch(() => null), null)
			} finally {
				await t.cleanup()
			}
		}
	})
}
test('probeAnswer speaks the website’s words', () => {
	const r = (status, headers = {}) => ({status, headers: new Headers(headers)})
	assert.equal(probeAnswer(r(302, {location: ACCESS_LOGIN})), 'access')
	assert.equal(probeAnswer(r(401, {'x-modc-gate': 'sso_only'})), 'gate')
	assert.equal(probeAnswer(r(404)), 'blocked')
	assert.equal(probeAnswer(r(530)), 'blocked')
	assert.equal(probeAnswer(r(401)), 'exposed')
	assert.equal(probeAnswer(r(421)), 'exposed')
	assert.equal(probeAnswer(r(200)), 'exposed')
	assert.equal(probeAnswer(r(404, {'x-modc-gate': 'sso_only'})), 'exposed')
})

// Create an account, pair, and it just works: pairing turns the connector on by itself, unless the
// owner turned it off; the website's state and the probe still decide whether it runs.
test('pairing turns the connector on by itself; turned off on purpose, it stays off after pairing again', async () => {
	const t = await setup({connectOpts: {autoConnect: true}})
	try {
		for (let i = 0; i < 80 && !t.logs.some((l) => /turned on by itself/.test(l)); i++) await new Promise((r) => setTimeout(r, 25))
		const s = (await t.connect.status()).tunnel
		assert.equal(s.enabled, true)
		assert.ok(t.logs.some((l) => /turned on by itself after pairing/.test(l)))
		await t.call('connect.tunnel.disable')
		assert.equal(await t.tunnel.autoEnable(), null, 'off on purpose stays off')
		assert.equal((await t.connect.status()).tunnel.enabled, false)
		await t.call('connect.tunnel.enable')
		assert.equal((await t.connect.status()).tunnel.enabled, true, 'the owner can always turn it back on')
	} finally {
		await t.cleanup()
	}
})
test('pairing without autoConnect leaves the connector for the owner to turn on', async () => {
	const t = await setup()
	try {
		assert.equal((await t.connect.status()).tunnel.enabled, false)
	} finally {
		await t.cleanup()
	}
})
