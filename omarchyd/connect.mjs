// MODC Connect: pair this installation with the owner's myowndatacenter.com account, then check in
// about once a minute. Contract: "MODC Connect Phase 3 — local application handoff".
//
//   POST /pair                  → a code to show, and a polling secret that never leaves this file
//   GET  /pair                  → authorization_pending | authorized | expired | credentials_delivered | revoked
//   POST /pair/credentials      → the device credential, delivered exactly once
//   POST /heartbeat             → {"ok":true}, with the device credential
//
// Everything that touches the website happens here, in omarchyd. The browser sees the code, the
// countdown, the website link and the status; never the polling secret or the device credential.
// Both live in one file only the owner's account can read (0600, in a 0700 folder), written whole and
// atomically, so the credential is on disk before the polling secret is gone. Nothing here logs a
// secret, a request body or a response body. Local sign-in and everything else on this server work the
// same whether or not this is paired, online, or the website is down: this module only reports.
//
// Phase 5B: when the owner turns it on, connect-tunnel.mjs runs this server's Cloudflare connector for
// the tunnel set up on the website (deny-all ingress, remote access off). It uses the same device
// credential; a revoked device stops the connector, and a removed tunnel leaves the device paired.
// Nothing here listens or opens a port.
import {chmod, mkdir, stat} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'

import {plainObject, readJsonState, writeAtomic} from './atomic.mjs'
import {createTunnel} from './connect-tunnel.mjs'
import {createRemoteAccess} from './connect-remote.mjs'
import {createSso} from './connect-sso.mjs'
import http from 'node:http'
import {RpcError} from './rpc.mjs'

export const CONNECT_API = 'https://myowndatacenter.com/api/public/cloud'
export const CONNECT_SITE = 'https://myowndatacenter.com/data-centers'
const SITE_ORIGIN = 'https://myowndatacenter.com'

const HEARTBEAT_MS = 60_000
const MIN_POLL_MS = 5_000
const POLL_SLACK_MS = 500 // 12 polls+exchanges a minute per secret: stay just under it
const RETRY_AFTER_DEFAULT_S = 60
const TROUBLE_RETRY_MS = 15_000 // website or network trouble while pairing
const REQUEST_TIMEOUT_MS = 15_000

const HEX64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE = /^[A-Z0-9]{2,12}(?:-[A-Z0-9]{2,12}){0,3}$/
// Connection refused, no route, no DNS: the request never reached the website, so trying again cannot
// issue a second credential. Anything else without an answer (a reset, a timeout) may have been delivered.
const NEVER_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT'])

// What the owner reads when pairing ends without a connection. Shown until they pair again or dismiss.
const NOTICES = {
	expired: 'That pairing code expired before it was approved. Codes last 10 minutes.',
	invalid: 'The website no longer knows that pairing code. Get a new one.',
	revoked_pairing: 'That pairing was revoked on the website.',
	delivery_failed:
		'The website approved this server, but its device key didn’t arrive here. Remove the unfinished device in My Data Centers on myowndatacenter.com, then pair again.',
	rejected: 'The website didn’t accept the pairing. Get a new code and try again.',
}

const cleanName = (v) => String(v ?? '').trim()
const isName = (v) => typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= 60
const defaultName = () => {
	const h = cleanName(os.hostname()).slice(0, 60).trim()
	return h || 'My machine'
}
// Only links to the website itself are shown or put in a QR code.
const siteUrl = (v) => {
	try {
		const u = new URL(String(v))
		return u.origin === SITE_ORIGIN && !u.username && !u.password ? u.href : CONNECT_SITE
	} catch {
		return CONNECT_SITE
	}
}

function validState(v) {
	if (!plainObject(v)) return false
	if (v.device != null) {
		const d = v.device
		if (!plainObject(d) || !UUID.test(String(d.deviceId)) || !UUID.test(String(d.dataCenterId))) return false
		if (d.credential != null && !HEX64.test(String(d.credential))) return false
	}
	if (v.pairing != null) {
		const p = v.pairing
		if (!plainObject(p) || !HEX64.test(String(p.pollingSecret)) || !CODE.test(String(p.code)) || !Number.isFinite(p.expiresAt)) return false
	}
	return true
}

export function createConnect({dataDir, apiBase = CONNECT_API, fetchImpl = fetch, now = () => Date.now(), version = '', autoStart = true, autoConnect = autoStart, log = (m) => console.error(m), tunnelOptions = {}, remoteOptions = {}, accounts = null, ssoOptions = {}}) {
	const base = String(apiBase).replace(/\/+$/, '')
	if (!/^https:\/\//.test(base)) throw new Error('MODC Connect needs an https address')
	const dir = join(dataDir, 'connect')
	const file = join(dir, 'connect.json')

	// {device: {deviceId, dataCenterId, name, pairedAt, credential?, revokedAt?, lastCheckIn?},
	//  pairing: {code, pollingSecret, expiresAt, interval, pairUrl, name, startedAt}, notice: {kind, at}}
	let state = {device: null, pairing: null, notice: null}
	// Not saved: how the last attempt went, and when the next one is due.
	let live = {problem: null, lastAttemptAt: null, nextAt: null, checking: false}
	let timer = null
	let closed = false
	let busy = Promise.resolve()

	const serial = (fn) => {
		const run = busy.then(fn, fn)
		busy = run.catch(() => {})
		return run
	}

	// The tunnel connector (Phase 5B). It borrows the device credential for each request.
	const tunnel = createTunnel({
		dir,
		apiBase: base,
		credential: () => state.device?.credential ?? null,
		// The website refused the credential on a tunnel request: same as a revoked heartbeat.
		onRevoked: () => serial(() => markRevoked()),
		fetchImpl,
		now,
		autoStart,
		log,
		...tunnelOptions,
	})
	// Remote access (API v1): the website's settings for the gate, and the emergency switch.
	const remote = createRemoteAccess({
		dir,
		apiBase: base,
		credential: () => state.device?.credential ?? null,
		deviceId: () => state.device?.deviceId ?? null,
		onRevoked: () => serial(() => markRevoked()),
		stopConnector: () => tunnel.disable(),
		fetchImpl,
		now,
		autoStart,
		log,
		...remoteOptions,
	})
	// Single sign-on with the website account (stage "behind_access"): only with remote access on.
	const sso = createSso({
		dir,
		apiBase: base,
		credential: () => state.device?.credential ?? null,
		device: () => (state.device?.credential ? {deviceId: state.device.deviceId, dataCenterId: state.device.dataCenterId} : null),
		remote,
		accounts,
		now,
		log,
		probeLocal: (hostname, protection) => localBoundaryHolds(hostname, protection),
		...ssoOptions,
	})
	// Remote access on: report readiness (when the self-test passes). Off or changed: SSO sessions end.
	remote.onSettings(async (parsed, changed) => {
		const on = parsed.state === 'enabled' && parsed.enabled === true && parsed.selectedConnector === true
		if (!on) return sso.revokeAll()
		await sso.report(changed)
	})
	async function markRevoked() {
		const d = state.device
		if (!d?.credential) return
		delete d.credential
		d.revokedAt = now()
		live.problem = null
		await save()
		log('[connect] this server’s device was revoked on myowndatacenter.com')
		remote.teardown().catch(() => {})
		sso.revokeAll().catch(() => {})
		schedule(0)
	}

	const save = async () => {
		await mkdir(dir, {recursive: true, mode: 0o700})
		await chmod(dir, 0o700)
		const snapshot = JSON.stringify(state, null, '\t')
		await writeAtomic(file, snapshot, {mode: 0o600})
	}

	const ready = (async () => {
		await mkdir(dir, {recursive: true, mode: 0o700}).catch(() => {})
		await chmod(dir, 0o700).catch(() => {})
		const got = await readJsonState(file, {validate: validState, label: 'connect', log: (m) => log(m), preserveCopy: true})
		if (got.status === 'ok') {
			state = {device: got.value.device ?? null, pairing: got.value.pairing ?? null, notice: got.value.notice ?? null}
			// Anyone else able to read it? Put it back to owner-only.
			const st = await stat(file).catch(() => null)
			if (st && (st.mode & 0o077) !== 0) await chmod(file, 0o600).catch(() => {})
		}
		if (state.pairing && state.pairing.expiresAt <= now()) {
			state.pairing = null
			state.notice = {kind: 'expired', at: now()}
			await save().catch(() => {})
		}
		if (autoStart) schedule(5_000)
		await tunnel.begin(autoStart ? 10_000 : 0).catch(() => {})
		if (state.device?.credential) await remote.begin(autoStart ? 8_000 : 0).catch(() => {})
	})()

	function schedule(ms) {
		if (timer) clearTimeout(timer)
		timer = null
		live.nextAt = null
		if (closed) return
		if (!state.pairing && !state.device?.credential) return
		live.nextAt = now() + ms
		if (!autoStart) return // driven by tick() (tests)
		timer = setTimeout(() => {
			timer = null
			serial(step).catch(() => {})
		}, ms)
		timer.unref?.()
	}

	// One HTTPS request. Returns {status, body, retryAfter}, or throws {network, neverSent}. Redirects are
	// refused so a secret is never sent anywhere else.
	async function call(method, path, secret, body) {
		const headers = {accept: 'application/json'}
		if (secret) headers.authorization = `Bearer ${secret}`
		if (body !== undefined) headers['content-type'] = 'application/json'
		let res
		try {
			res = await fetchImpl(`${base}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)})
		} catch (e) {
			const code = e?.cause?.code ?? e?.code
			throw Object.assign(new Error('network'), {network: true, neverSent: NEVER_SENT.has(code)})
		}
		let parsed = null
		try {
			const text = await res.text()
			parsed = text ? JSON.parse(text) : null
		} catch {
			parsed = null
		}
		const ra = Number(res.headers?.get?.('retry-after'))
		return {status: res.status, body: plainObject(parsed) ? parsed : null, retryAfter: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : null}
	}
	const errorCode = (r) => String(r.body?.error ?? r.body?.code ?? '')

	const endPairing = async (kind) => {
		state.pairing = null
		state.notice = kind ? {kind, at: now()} : null
		live.problem = null
		await save()
	}

	async function step() {
		if (closed) return
		if (state.pairing) return pollStep()
		if (state.device?.credential) return heartbeatStep()
	}

	async function pollStep() {
		const p = state.pairing
		if (p.expiresAt <= now()) return endPairing('expired')
		live.lastAttemptAt = now()
		const pace = Math.max(MIN_POLL_MS, (Number(p.interval) || 5) * 1000) + POLL_SLACK_MS
		let r
		try {
			r = await call('GET', '/pair', p.pollingSecret)
		} catch {
			live.problem = 'offline'
			return schedule(Math.max(pace, TROUBLE_RETRY_MS))
		}
		if (r.status === 200) {
			const status = String(r.body?.status ?? '')
			live.problem = null
			if (status === 'authorization_pending') return schedule(pace)
			if (status === 'authorized') return exchangeStep(pace)
			if (status === 'expired') return endPairing('expired')
			if (status === 'credentials_delivered') return endPairing('delivery_failed')
			if (status === 'revoked') return endPairing('revoked_pairing')
			return schedule(pace)
		}
		if (r.status === 401) return endPairing('invalid')
		if (r.status === 429) {
			live.problem = 'rate_limited'
			return schedule((r.retryAfter ?? RETRY_AFTER_DEFAULT_S) * 1000)
		}
		live.problem = r.status >= 500 ? 'unavailable' : 'error'
		return schedule(Math.max(pace, TROUBLE_RETRY_MS))
	}

	// Exactly once: a credential that may have been sent is never asked for again.
	async function exchangeStep(pace) {
		const p = state.pairing
		live.lastAttemptAt = now()
		let r
		try {
			r = await call('POST', '/pair/credentials', p.pollingSecret, {})
		} catch (e) {
			if (e.neverSent) {
				live.problem = 'offline'
				return schedule(Math.max(pace, TROUBLE_RETRY_MS))
			}
			log('[connect] the device key may have been sent but no answer arrived')
			return endPairing('delivery_failed')
		}
		if (r.status === 200) {
			const b = r.body ?? {}
			const ok = UUID.test(String(b.device_id)) && UUID.test(String(b.data_center_id)) && HEX64.test(String(b.device_credential)) && (b.token_type == null || b.token_type === 'Bearer')
			if (!ok) {
				log('[connect] the website’s answer to the key exchange wasn’t usable')
				return endPairing('delivery_failed')
			}
			// One write: the credential is saved and the polling secret is gone, together.
			state.device = {deviceId: b.device_id, dataCenterId: b.data_center_id, name: p.name, pairedAt: now(), credential: b.device_credential, remoteAccess: b.remote_access === true}
			state.pairing = null
			state.notice = null
			live.problem = null
			await save()
			log('[connect] paired with myowndatacenter.com')
			tunnel.begin(5_000).catch(() => {})
			// Pairing is the yes to connecting: the connector turns on by itself (see tunnel.autoEnable).
			if (autoConnect) tunnel.autoEnable().catch(() => {})
			remote.begin(6_000).catch(() => {})
			return schedule(0)
		}
		if (r.status === 409 && errorCode(r) === 'authorization_pending') return schedule(pace)
		if (r.status === 409) return endPairing('delivery_failed')
		if (r.status === 410) return endPairing('expired')
		if (r.status === 403) return endPairing('revoked_pairing')
		if (r.status === 401) return endPairing('invalid')
		if (r.status === 429) {
			live.problem = 'rate_limited'
			return schedule((r.retryAfter ?? RETRY_AFTER_DEFAULT_S) * 1000)
		}
		// An error answer means nothing was issued, so asking again is safe.
		if (r.status >= 500) {
			live.problem = 'unavailable'
			return schedule(Math.max(pace, TROUBLE_RETRY_MS))
		}
		return endPairing('rejected')
	}

	async function heartbeatStep() {
		const d = state.device
		live.lastAttemptAt = now()
		const v = String(version ?? '').trim().slice(0, 40)
		let r
		try {
			r = await call('POST', '/heartbeat', d.credential, v ? {version: v} : {})
		} catch {
			live.problem = 'offline'
			return schedule(HEARTBEAT_MS)
		}
		if (r.status === 200 && r.body?.ok === true) {
			live.problem = null
			d.lastCheckIn = now()
			await save()
			return schedule(HEARTBEAT_MS)
		}
		if (r.status === 401 || r.status === 404) {
			// Revoked (or never valid): stop checking in, forget the key, keep who it was for the record.
			delete d.credential
			d.revokedAt = now()
			live.problem = null
			await save()
			log('[connect] this server’s device was revoked on myowndatacenter.com')
			// Its tunnel connector stops too (not awaited: the tunnel takes its own turn).
			tunnel.teardown().catch(() => {})
			remote.teardown().catch(() => {})
			return schedule(0)
		}
		if (r.status === 429) {
			live.problem = 'rate_limited'
			return schedule(Math.max(HEARTBEAT_MS, (r.retryAfter ?? RETRY_AFTER_DEFAULT_S) * 1000))
		}
		live.problem = r.status >= 500 ? 'unavailable' : 'error'
		return schedule(HEARTBEAT_MS)
	}

	// ---- What the Settings page sees and does. Never a secret. -------------------------------------
	function status() {
		const d = state.device
		const p = state.pairing
		const device = d ? {deviceId: d.deviceId, dataCenterId: d.dataCenterId, name: d.name ?? '', pairedAt: d.pairedAt ?? null} : null
		const common = {problem: live.problem, lastAttemptAt: live.lastAttemptAt, nextAttemptAt: live.nextAt, siteUrl: CONNECT_SITE, defaultName: defaultName()}
		if (p) return {...common, state: 'pairing', pairing: {code: p.code, expiresAt: p.expiresAt, pairUrl: p.pairUrl, name: p.name}, device: null, lastCheckIn: null, notice: null}
		if (d?.credential) {
			const s = d.lastCheckIn ? (live.problem ? 'offline' : 'connected') : live.problem ? 'offline' : 'connecting'
			return {...common, state: s, device, lastCheckIn: d.lastCheckIn ?? null, notice: null}
		}
		if (d?.revokedAt) return {...common, state: 'revoked', device, lastCheckIn: d.lastCheckIn ?? null, revokedAt: d.revokedAt, notice: null}
		const n = state.notice && NOTICES[state.notice.kind] ? {kind: state.notice.kind, message: NOTICES[state.notice.kind], at: state.notice.at} : null
		return {...common, state: 'none', device: null, lastCheckIn: null, notice: n}
	}

	// Everything the page shows: the pairing and, once paired, the tunnel.
	async function full() {
		const s = status()
		const paired = !!state.device?.credential
		return {...s, tunnel: paired ? await tunnel.status().catch(() => null) : null, remote: paired ? {...remote.status(), sso: sso.status()} : null}
	}

	async function pair(input) {
		await ready
		return serial(async () => {
			if (state.device?.credential) throw new RpcError('CONFLICT', 'This server is already connected. Disconnect it first to pair it again.')
			// A code still waiting: show the same one (codes are limited to five per network per 10 minutes).
			if (state.pairing && state.pairing.expiresAt > now() + 15_000) return full()
			const name = input?.name == null || cleanName(input.name) === '' ? defaultName() : cleanName(input.name)
			if (!isName(name)) throw new RpcError('BAD_REQUEST', 'Give this server a name of up to 60 characters')
			let r
			try {
				r = await call('POST', '/pair', null, {name})
			} catch {
				throw new RpcError('BAD_GATEWAY', 'Couldn’t reach myowndatacenter.com. Check this server’s internet connection and try again.')
			}
			if (r.status === 429) {
				const mins = Math.max(1, Math.ceil((r.retryAfter ?? 600) / 60))
				throw new RpcError('TOO_MANY_REQUESTS', `Too many pairing codes were asked for from your network. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`)
			}
			if (r.status === 400) throw new RpcError('BAD_REQUEST', 'The website didn’t accept that name. Use 1 to 60 characters.')
			if (r.status !== 201) throw new RpcError('BAD_GATEWAY', 'MODC Connect is temporarily unavailable. Try again in a few minutes.')
			const b = r.body ?? {}
			const expiresAt = Date.parse(b.expires_at)
			const ttl = Number(b.expires_in)
			const end = Number.isFinite(expiresAt) ? Math.min(expiresAt, now() + 600_000) : now() + (Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 600) : 600) * 1000
			if (!CODE.test(String(b.code)) || !HEX64.test(String(b.polling_secret))) throw new RpcError('BAD_GATEWAY', 'The website’s answer wasn’t usable. Try again in a few minutes.')
			state.pairing = {code: b.code, pollingSecret: b.polling_secret, expiresAt: end, interval: Math.max(5, Number(b.interval) || 5), pairUrl: siteUrl(b.pair_url), name, startedAt: now()}
			state.notice = null
			state.device = null // a revoked record is replaced by the new pairing
			live.problem = null
			await save()
			schedule(Math.max(MIN_POLL_MS, state.pairing.interval * 1000) + POLL_SLACK_MS)
			return full()
		})
	}

	async function cancel() {
		await ready
		return serial(async () => {
			if (state.pairing) await endPairing(null)
			schedule(0)
			return full()
		})
	}

	async function dismiss() {
		await ready
		return serial(async () => {
			state.notice = null
			if (state.device && !state.device.credential) state.device = null
			await save()
			return full()
		})
	}

	// Forget the key here. The website can't be told from here (revoking is the owner's, on the
	// website); the Settings page says so.
	async function disconnect() {
		await ready
		return serial(async () => {
			// The connector goes first: stopped, its token wiped, its unit removed.
			await tunnel.teardown().catch(() => log('[connect] couldn’t stop the tunnel connector'))
			await remote.teardown().catch(() => {})
			state = {device: null, pairing: null, notice: null}
			live = {problem: null, lastAttemptAt: null, nextAt: null, checking: false}
			await save()
			schedule(0)
			return full()
		})
	}

	async function checkNow() {
		await ready
		if (!state.pairing && !state.device?.credential) return full()
		// The website allows six check-ins a minute: a button pressed again and again stays under it.
		if (live.lastAttemptAt && now() - live.lastAttemptAt < 10_000) return full()
		await serial(step)
		return full()
	}

	return {
		ready,
		status: async () => (await ready, full()),
		tunnel,
		remote,
		sso,
		// For the web server's remote-access gate (non-secret settings only).
		remoteGate: () => (state.device?.credential ? remote.gate() : {enabled: false, verified: false, blocked: false, syncedAt: null}),
		pair,
		cancel,
		dismiss,
		disconnect,
		checkNow,
		// For tests: run whatever is due now, as the timer would.
		tick: async () => (await ready, serial(step)),
		reset: disconnect,
		close() {
			closed = true
			tunnel.close()
			remote.close()
			if (timer) clearTimeout(timer)
			timer = null
		},
		procedures: {
			'connect.status': {kind: 'query', run: async () => (await ready, full())},
			'connect.pair': {kind: 'mutation', run: (input) => pair(input)},
			'connect.cancel': {kind: 'mutation', run: () => cancel()},
			'connect.dismiss': {kind: 'mutation', run: () => dismiss()},
			'connect.disconnect': {kind: 'mutation', run: () => disconnect()},
			'connect.checkNow': {kind: 'mutation', run: () => checkNow()},
			// The tunnel connector. Each answers with the whole page's status.
			'connect.tunnel.enable': {kind: 'mutation', run: async () => (await tunnel.enable(), full())},
			'connect.tunnel.disable': {kind: 'mutation', run: async () => (await tunnel.disable(), full())},
			'connect.tunnel.check': {kind: 'mutation', run: async () => (await tunnel.check(), full())},
			'connect.tunnel.install': {kind: 'mutation', run: async () => (await tunnel.install(), full())},
			// Remote access: turning it on is the owner's, on the website; switching it off works from here.
			'connect.remote.disable': {kind: 'mutation', run: async () => (await remote.disable(), await sso.revokeAll().catch(() => {}), full())},
			'connect.remote.allow': {kind: 'mutation', run: async () => (await remote.allowAgain(), full())},
			'connect.remote.check': {kind: 'mutation', run: async () => (await remote.check(), full())},
		},
	}
}

// The self-test behind "legacy_origin_isolated": a request with no Cloudflare Access token must be
// refused on the remote listener (7781) and, as a Cloudflare-forwarded request, on the main one (7780).
const WEB_PORT = Number(process.env.OMARCHY_SERVER_PORT || 7780)
const REMOTE_PORT = Number(process.env.OMARCHY_REMOTE_PORT || 7781)
function localReq(port, {method = 'GET', path = '/api/health', headers}) {
	return new Promise((resolve) => {
		const req = http.request({host: '127.0.0.1', port, method, path, headers, timeout: 5000}, (res) => {
			res.resume()
			resolve({status: res.statusCode, gate: res.headers['x-modc-gate'] ?? null, probe: res.headers['x-modc-probe'] ?? null})
		})
		req.on('timeout', () => req.destroy())
		req.on('error', () => resolve({status: 0, gate: null, probe: null}))
		req.end(method === 'POST' ? '{}' : undefined)
	})
}
// The self-test behind readiness. Without any credential:
//   legacy_origin_isolated: a Cloudflare-forwarded request to 7780 is refused;
//   sso_only_gate: on 7781 a protected page, an API call and a password sign-in are all refused (in
//   SSO-only mode by this server's own gate, marked x-modc-gate: sso_only).
export async function localBoundaryHolds(hostname, protection = 'cloudflare_access') {
	const ssoOnly = protection === 'modc_sso'
	const refused = (r) => (ssoOnly ? (r.status === 401 || r.status === 403) && r.gate === 'sso_only' : r.status === 403 || r.status === 503)
	const legacy = await localReq(WEB_PORT, {headers: {host: hostname, 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-proto': 'https'}})
	const isolated = [403, 421, 503].includes(legacy.status)
	const checks = await Promise.all([
		localReq(REMOTE_PORT, {path: '/api/prefs', headers: {host: hostname}}),
		localReq(REMOTE_PORT, {path: '/api/rpc/files.list', headers: {host: hostname}}),
		localReq(REMOTE_PORT, {method: 'POST', path: '/api/auth/login', headers: {host: hostname, 'content-type': 'application/json', 'x-omarchy-server': '1'}}),
	])
	const active = checks.every(refused)
	// The v2 (SSO-only) boundary, judged independently of the active protection through the synthetic
	// probe: refused without a website session even with spoofed headers, the legacy origin and a wrong
	// hostname refused, and the sign-in page reachable (so the refusals come from a live gate, not an outage).
	const P = {'x-modc-probe': 'sso_only'}
	const spoof = {'cf-access-jwt-assertion': 'x.y.z', 'cf-connecting-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https', 'cf-access-authenticated-user-email': 'owner@localhost', 'x-modc-gate': 'ok'}
	const v2 = await Promise.all([
		localReq(REMOTE_PORT, {path: '/api/prefs', headers: {host: hostname, ...P}}),
		localReq(REMOTE_PORT, {path: '/api/rpc/files.list', headers: {host: hostname, ...P, ...spoof}}),
		localReq(REMOTE_PORT, {path: '/api/files/download?path=%2F', headers: {host: hostname, ...P}}),
		localReq(REMOTE_PORT, {method: 'POST', path: '/api/auth/login', headers: {host: hostname, ...P, 'content-type': 'application/json', 'x-omarchy-server': '1'}}),
		localReq(REMOTE_PORT, {path: '/', headers: {host: hostname, ...P}}),
		localReq(REMOTE_PORT, {path: '/api/prefs', headers: {host: 'not-this-server.invalid', ...P}}),
		localReq(WEB_PORT, {path: '/api/prefs', headers: {host: hostname, ...P, 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-proto': 'https'}}),
	])
	const gated = (r) => (r.status === 401 || r.status === 403) && r.gate === 'sso_only' && r.probe === 'sso_only'
	const [prefs, rpc, download, login, home, wrongHost, legacyV2] = v2
	const ssoOnlyGate = gated(prefs) && gated(rpc) && gated(download) && gated(login) && home.status === 204 && home.probe === 'sso_only' && wrongHost.status === 421 && legacyV2.status === 421 && legacyV2.probe === 'sso_only'
	return {isolated: isolated && active, ssoOnlyGate}
}
