// Cloudflare Access: check the token Cloudflare puts on every request it lets through
// (Cf-Access-Jwt-Assertion), ourselves, independently of Cloudflare's own enforcement.
//
// RS256 only. The signing keys come from the configured team's own certificate list
// (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs) and nowhere else: an issuer or a
// certificate address that isn't Cloudflare Access's is refused outright. Keys are cached and fetched
// again for a key ID we haven't seen (rotation), at most every 30 seconds. Issuer, audience, expiry and
// not-before are all checked. A valid token only says Cloudflare Access let this browser through: it
// never signs anyone in to My Own Data Center.
import {createPublicKey, verify as verifySignature} from 'node:crypto'

const TEAM_ISSUER = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/
const LEEWAY_S = 30 // clock difference tolerated on exp and nbf
const KEYS_MAX_AGE_MS = 60 * 60_000
const REFRESH_MIN_MS = 30_000
const MAX_TOKEN = 16 * 1024
const MAX_CERTS = 64 * 1024

// The only certificate address trusted for an issuer.
export const certsUrlFor = (issuer) => `${issuer}/cdn-cgi/access/certs`

// A gate configuration as the website gave it: usable only if it all points at one Access team.
export function validAccessConfig(c) {
	if (!c || typeof c !== 'object') return false
	if (typeof c.issuer !== 'string' || !TEAM_ISSUER.test(c.issuer)) return false
	if (typeof c.audience !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(c.audience)) return false
	if (c.certsUrl !== certsUrlFor(c.issuer)) return false
	return true
}

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const json = (buf) => {
	try {
		const v = JSON.parse(buf.toString('utf8'))
		return v && typeof v === 'object' && !Array.isArray(v) ? v : null
	} catch {
		return null
	}
}

export function createAccessVerifier({fetchImpl = fetch, now = () => Date.now(), log = () => {}} = {}) {
	// certsUrl -> {keys: Map(kid -> KeyObject), fetchedAt, lastTry, pending}
	const cache = new Map()

	async function loadKeys(certsUrl) {
		const entry = cache.get(certsUrl) ?? {keys: new Map(), fetchedAt: 0, lastTry: 0, pending: null}
		cache.set(certsUrl, entry)
		if (entry.pending) return entry.pending
		if (now() - entry.lastTry < REFRESH_MIN_MS) return entry
		entry.lastTry = now()
		entry.pending = (async () => {
			try {
				const res = await fetchImpl(certsUrl, {redirect: 'error', headers: {accept: 'application/json'}, signal: AbortSignal.timeout(10_000)})
				if (!res.ok) throw new Error(`HTTP ${res.status}`)
				const text = await res.text()
				if (text.length > MAX_CERTS) throw new Error('too large')
				const body = JSON.parse(text)
				const keys = new Map()
				for (const k of Array.isArray(body?.keys) ? body.keys : []) {
					if (!k || k.kty !== 'RSA' || typeof k.kid !== 'string' || (k.alg && k.alg !== 'RS256') || (k.use && k.use !== 'sig')) continue
					try {
						keys.set(k.kid, createPublicKey({key: {kty: 'RSA', n: k.n, e: k.e}, format: 'jwk'}))
					} catch {}
				}
				if (!keys.size) throw new Error('no usable keys')
				entry.keys = keys
				entry.fetchedAt = now()
			} catch (e) {
				log(`[remote] couldn’t fetch Cloudflare Access keys: ${e.message}`)
			} finally {
				entry.pending = null
			}
			return entry
		})()
		return entry.pending
	}

	// -> {ok: true, claims} or {ok: false, reason}
	async function verify(token, config) {
		if (!validAccessConfig(config)) return {ok: false, reason: 'config'}
		if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return {ok: false, reason: 'missing'}
		const parts = token.split('.')
		if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return {ok: false, reason: 'malformed'}
		const header = json(b64url(parts[0]))
		const claims = json(b64url(parts[1]))
		if (!header || !claims) return {ok: false, reason: 'malformed'}
		if (header.alg !== 'RS256' || typeof header.kid !== 'string') return {ok: false, reason: 'algorithm'}

		let entry = cache.get(config.certsUrl)
		if (!entry || !entry.keys.has(header.kid) || now() - entry.fetchedAt > KEYS_MAX_AGE_MS) entry = await loadKeys(config.certsUrl)
		const key = entry?.keys.get(header.kid)
		if (!key) return {ok: false, reason: 'unknown_key'}
		const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
		if (!verifySignature('RSA-SHA256', signed, key, b64url(parts[2]))) return {ok: false, reason: 'signature'}

		const t = now() / 1000
		if (claims.iss !== config.issuer) return {ok: false, reason: 'issuer'}
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
		if (!aud.includes(config.audience)) return {ok: false, reason: 'audience'}
		if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < t) return {ok: false, reason: 'expired'}
		if (claims.nbf != null && (typeof claims.nbf !== 'number' || claims.nbf - LEEWAY_S > t)) return {ok: false, reason: 'not_yet_valid'}
		if (claims.iat != null && (typeof claims.iat !== 'number' || claims.iat - LEEWAY_S > t)) return {ok: false, reason: 'not_yet_valid'}
		return {ok: true, claims: {sub: typeof claims.sub === 'string' ? claims.sub : '', email: typeof claims.email === 'string' ? claims.email : '', exp: claims.exp}}
	}

	return {verify}
}
