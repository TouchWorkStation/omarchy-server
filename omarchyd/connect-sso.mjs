// MODC Connect single sign-on (Lovable handoff, contract v1, stage "behind_access"): sign in to this
// server with the owner's myowndatacenter.com account, through the website's authorization screen.
//
//   browser  GET  https://myowndatacenter.com/connect/authorize?…            (PKCE S256 + state)
//   here     POST /api/public/cloud/sso/exchange   code -> a 15-minute central session token
//   here     POST /api/public/cloud/sso/validate   at most every 30 s, fail closed
//   here     POST /api/public/cloud/sso/revoke     on sign-out
//   here     POST /api/public/cloud/sso/readiness  this server's self-test report (every ~9 minutes)
//
// All with the device credential, from here only: never from a browser (no Origin, no Sec-Fetch-*;
// node's fetch adds Sec-Fetch-Mode, so these go through node:https). The central session token lives
// in memory here and nowhere else; the browser gets an ordinary local session for this server's owner.
// The website account is pinned to the first one that signs in (the server's owner): another account's
// session is refused even if the website issued it. A website session never signs anyone in by itself.
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import {join} from 'node:path'

import {plainObject, readJsonState, writeAtomic} from './atomic.mjs'

// The highest security contract this server implements (v2: SSO only on the 7781 listener).
const SUPPORTED_CONTRACT = 2

export const SSO_SITE = 'https://myowndatacenter.com'
const TX_TTL_MS = 10 * 60_000
const TX_MAX = 20
const READY_EVERY_MS = 9 * 60_000
const HEX64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const b64url = (buf) => buf.toString('base64url')
export const challengeFor = (verifier) => b64url(createHash('sha256').update(verifier, 'ascii').digest())
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// A plain machine-to-machine HTTPS call: no browser headers, no redirects followed, 1 KB bodies.
export function machinePost(url, {headers = {}, body, timeout = 15_000} = {}) {
	return new Promise((resolve, reject) => {
		const u = new URL(url)
		const lib = u.protocol === 'https:' ? https : http
		const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
		const req = lib.request(u, {method: 'POST', headers: {accept: 'application/json', 'content-type': 'application/json', ...(data ? {'content-length': data.length} : {}), ...headers}, timeout}, (res) => {
			const chunks = []
			let size = 0
			res.on('data', (c) => {
				size += c.length
				if (size > 64 * 1024) req.destroy(new Error('too large'))
				else chunks.push(c)
			})
			res.on('end', () => {
				let parsed = null
				try {
					parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
				} catch {}
				resolve({status: res.statusCode, body: plainObject(parsed) ? parsed : null, retryAfter: Number(res.headers['retry-after']) || null})
			})
		})
		req.on('timeout', () => req.destroy(new Error('timeout')))
		req.on('error', reject)
		req.end(data)
	})
}

export function createSso({dir, apiBase, credential, device, remote, accounts, post = machinePost, now = () => Date.now(), log = (m) => console.error(m), probeLocal = async () => false, appVersion = 'remote-v1'}) {
	const base = String(apiBase).replace(/\/+$/, '')
	const file = join(dir, 'sso.json')
	const txs = new Map() // tx -> {state, verifier, hostname, at}
	const sessions = new Map() // ref -> central session (memory only)
	let pinned = null // {subject}
	let readiness = {at: null, accepted: false, expiresAt: null, error: null, configVersion: null}
	let reporting = null

	const ready = (async () => {
		const got = await readJsonState(file, {validate: plainObject, label: 'connect', log})
		if (got.status === 'ok' && typeof got.value.subject === 'string') pinned = {subject: got.value.subject}
	})()

	const call = (path, body) => post(`${base}${path}`, {headers: {authorization: `Bearer ${credential()}`}, body})

	// What this server needs from the website's settings to run SSO; null if anything is off.
	function config() {
		const s = remote.settings()
		const d = device()
		if (!s || !d || !credential()) return null
		const sso = s.sso
		if (!(s.state === 'enabled' && s.enabled === true && s.selectedConnector === true)) return null
		if (!plainObject(sso) || sso.available !== true || ![1, 2].includes(sso.contract_version) || sso.callback_path !== '/modc/auth/callback') return null
		if (sso.authorization_endpoint !== `${SSO_SITE}/connect/authorize`) return null
		if (s.deviceId !== d.deviceId || s.dataCenterId !== d.dataCenterId || !s.hostname) return null
		// Which stage the exchange must report: SSO only (contract v2) or behind Access (v1).
		const ssoOnly = s.contractVersion === 2 && s.protectionMode === 'modc_sso' && sso.stage === 'sso_only' && sso.enabled === true
		return {hostname: s.hostname.toLowerCase(), configVersion: s.configVersion, contractVersion: s.contractVersion, deviceId: d.deviceId, dataCenterId: d.dataCenterId, authorize: sso.authorization_endpoint, protection: ssoOnly ? 'modc_sso' : 'cloudflare_access', stage: ssoOnly ? 'sso_only' : 'behind_access'}
	}

	// Step 1: a new browser transaction. Returns the website address and the transaction ID for the
	// browser's cookie; the verifier and state stay here.
	async function start({hostname}) {
		await ready
		const c = config()
		if (!c) return {error: 'not_available'}
		if (String(hostname ?? '').toLowerCase() !== c.hostname) return {error: 'wrong_host'}
		for (const [k, t] of txs) if (now() - t.at > TX_TTL_MS) txs.delete(k)
		if (txs.size >= TX_MAX) txs.delete(txs.keys().next().value)
		const verifier = b64url(randomBytes(48)) // 64 characters
		const state = b64url(randomBytes(32)) // 43 characters
		const tx = b64url(randomBytes(32))
		txs.set(tx, {state, verifier, hostname: c.hostname, at: now()})
		const q = new URLSearchParams({
			response_type: 'code',
			data_center_id: c.dataCenterId,
			device_id: c.deviceId,
			redirect_uri: `https://${c.hostname}/modc/auth/callback`,
			code_challenge: challengeFor(verifier),
			code_challenge_method: 'S256',
			state,
		})
		return {url: `${c.authorize}?${q}`, tx}
	}

	// Step 2: the callback. The transaction is used up whatever happens.
	async function finish({tx, code, state, hostname}) {
		await ready
		const t = typeof tx === 'string' ? txs.get(tx) : null
		if (t) txs.delete(tx)
		if (!t || now() - t.at > TX_TTL_MS) return {error: 'no_transaction'}
		if (!same(state, t.state)) return {error: 'state_mismatch'}
		if (String(hostname ?? '').toLowerCase() !== t.hostname) return {error: 'wrong_host'}
		if (typeof code !== 'string' || !HEX64.test(code)) return {error: 'bad_code'}
		const c = config()
		if (!c || c.hostname !== t.hostname) return {error: 'not_available'}
		let r
		try {
			r = await call('/sso/exchange', {grant_type: 'authorization_code', code, redirect_uri: `https://${t.hostname}/modc/auth/callback`, code_verifier: t.verifier})
		} catch {
			return {error: 'unreachable'}
		}
		if (r.status !== 200) return {error: r.body?.error === 'invalid_grant' ? 'invalid_grant' : `http_${r.status}`}
		const b = r.body ?? {}
		const expiresAt = Date.parse(b.expires_at)
		const ok =
			b.token_type === 'modc_remote_session' &&
			HEX64.test(String(b.session_token)) &&
			UUID.test(String(b.session_id)) &&
			UUID.test(String(b.subject)) &&
			b.device_id === c.deviceId &&
			b.data_center_id === c.dataCenterId &&
			String(b.hostname).toLowerCase() === t.hostname &&
			b.config_version === c.configVersion &&
			b.protection_mode === c.protection &&
			b.sso_stage === c.stage &&
			Number.isFinite(expiresAt) &&
			expiresAt > now()
		if (!ok) {
			log('[connect] the website’s sign-in answer didn’t match this server')
			if (HEX64.test(String(b.session_token))) call('/sso/revoke', {session_token: b.session_token}).catch(() => {})
			return {error: 'mismatch'}
		}
		// Only the server owner's website account, ever. The first one is pinned.
		if (pinned && pinned.subject !== b.subject) {
			call('/sso/revoke', {session_token: b.session_token}).catch(() => {})
			return {error: 'other_account'}
		}
		const owner = accounts.listAccounts().find((a) => a.role === 'owner')
		if (!owner) return {error: 'no_owner'}
		if (!pinned) {
			pinned = {subject: b.subject}
			await writeAtomic(file, JSON.stringify(pinned), {mode: 0o600})
		}
		const native = await accounts.loginNativeFor(owner.userId, 'modc-sso')
		const ref = randomUUID()
		const interval = Math.min(30, Number(b.validation_interval) || 30) * 1000
		sessions.set(ref, {token: b.session_token, sessionId: b.session_id, subject: b.subject, hostname: t.hostname, configVersion: b.config_version, expiresAt, validatedAt: now(), interval, deviceToken: native.deviceToken})
		log('[connect] signed in with myowndatacenter.com')
		return {ref, expiresAt, native}
	}

	// Is this session still good? Cached at most 30 s (maxAgeMs can ask for fresher), never past expiry.
	async function check({ref, maxAgeMs = 30_000}) {
		const s = typeof ref === 'string' ? sessions.get(ref) : null
		if (!s) return {active: false}
		if (now() >= s.expiresAt) return end(ref, s)
		if (now() - s.validatedAt <= Math.min(maxAgeMs, s.interval)) return {active: true, expiresAt: s.expiresAt}
		const c = config()
		if (!c || c.configVersion !== s.configVersion || c.hostname !== s.hostname) return end(ref, s)
		let r
		try {
			r = await call('/sso/validate', {session_token: s.token})
		} catch {
			return {active: false, transient: true} // fail closed; may recover on the next check
		}
		if (r.status === 429 || r.status >= 500) return {active: false, transient: true}
		const b = r.body ?? {}
		const exp = Date.parse(b.expires_at)
		if (r.status === 200 && b.active === true && b.session_id === s.sessionId && b.subject === s.subject && b.device_id === c.deviceId && b.data_center_id === c.dataCenterId && String(b.hostname).toLowerCase() === s.hostname && b.config_version === s.configVersion && Number.isFinite(exp)) {
			s.validatedAt = now()
			s.expiresAt = Math.min(s.expiresAt, exp)
			s.interval = Math.min(30, Number(b.validation_interval) || 30) * 1000
			return {active: true, expiresAt: s.expiresAt}
		}
		return end(ref, s)
	}
	async function end(ref, s) {
		sessions.delete(ref)
		accounts.logoutDevice?.(s.deviceToken)?.catch?.(() => {})
		return {active: false}
	}
	async function logout({ref}) {
		const s = sessions.get(ref)
		if (!s) return {ok: true}
		await end(ref, s)
		await call('/sso/revoke', {session_token: s.token}).catch(() => {})
		return {ok: true}
	}
	// Remote access off, device revoked, disconnected: every SSO session ends here and centrally.
	async function revokeAll() {
		for (const [ref, s] of sessions) await end(ref, s)
		txs.clear()
		if (credential()) await call('/sso/revoke', {all: true}).catch(() => {})
	}

	// The self-test report, after every local check passes. Never activation: that stays refused.
	async function report(force = false) {
		const c = config()
		if (!c) return readiness
		if (!force && readiness.accepted && readiness.configVersion === c.configVersion && readiness.contractVersion === SUPPORTED_CONTRACT && readiness.at && now() - readiness.at < READY_EVERY_MS) return readiness
		if (reporting) return reporting
		reporting = (async () => {
			try {
				const probe = await probeLocal(c.hostname, c.protection)
				const isolated = probe === true || probe?.isolated === true
				const ssoOnlyGate = probe === true || probe?.ssoOnlyGate === true
				// Capability, not the active mode: contract 2 is reported once the v2 boundary passes its own
				// self-test, while v1 (Cloudflare Access) may still be the active protection. The active
				// protection's checks (isolated) must pass too. Activation itself stays with the website.
				if (!isolated || !ssoOnlyGate) {
					readiness = {...readiness, accepted: false, error: 'local_checks_failed', at: now()}
					log(`[connect] readiness not sent: local self-test failed (active protection ${isolated ? 'ok' : 'failed'}, v2 boundary ${ssoOnlyGate ? 'ok' : 'failed'})`)
					return readiness
				}
				const r = await call('/sso/readiness', {
					contract_version: SUPPORTED_CONTRACT,
					config_version: c.configVersion,
					origin: 'http://127.0.0.1:7781',
					app_version: appVersion,
					checks: {pkce: true, state: true, session_validation: true, fail_closed: true, host_only_cookie: true, legacy_origin_isolated: true, sso_only_gate: true},
				})
				const ok = r.status === 200 && r.body?.accepted === true
				readiness = {at: now(), accepted: ok, expiresAt: ok ? Date.parse(r.body.expires_at) || null : null, error: ok ? null : r.body?.error || `http_${r.status}`, configVersion: c.configVersion, contractVersion: SUPPORTED_CONTRACT}
				log(`[connect] readiness (contract ${SUPPORTED_CONTRACT}, config ${c.configVersion}): ${ok ? 'accepted' : `refused, ${readiness.error}`}`)
			} catch {
				readiness = {...readiness, accepted: false, error: 'unreachable', at: now()}
			} finally {
				reporting = null
			}
			return readiness
		})()
		return reporting
	}

	return {
		ready,
		start,
		finish,
		check,
		logout,
		revokeAll,
		report,
		status: () => ({available: !!config(), readiness: {...readiness}, sessions: sessions.size, pinned: !!pinned}),
	}
}
