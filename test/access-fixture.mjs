// A stand-in Cloudflare Access team for tests: its signing key, its certificate list, and tokens.
import {createSign, generateKeyPairSync, randomBytes} from 'node:crypto'

import {createAccessVerifier} from '../server/access-jwt.mjs'

export const TEAM = 'https://modc-test.cloudflareaccess.com'
export const AUD = 'a'.repeat(64)
export const CERTS = `${TEAM}/cdn-cgi/access/certs`
export const HOST = 'nodezero.myowndatacenter.com'

export function accessTeam() {
	const keys = [newKey('kid-1')]
	const team = {
		keys,
		fetches: 0,
		// The team's certificate list, as Cloudflare serves it.
		fetchImpl: async (url, init = {}) => {
			team.fetches++
			team.lastFetch = {url, init}
			if (url !== CERTS) return new Response('not found', {status: 404})
			return new Response(JSON.stringify({keys: team.keys.map((k) => k.jwk)}), {status: 200, headers: {'content-type': 'application/json'}})
		},
		rotate(kid = `kid-${keys.length + 1}`) {
			const k = newKey(kid)
			team.keys.push(k)
			return k
		},
		// A token signed by `key` (default: the first) with these claims over sensible defaults.
		token(claims = {}, {key = team.keys[0], alg = 'RS256', kid} = {}) {
			const t = Math.floor(Date.now() / 1000)
			const header = {alg, kid: kid ?? key.kid, typ: 'JWT'}
			const body = {iss: TEAM, aud: [AUD], sub: 'user-1', email: 'chris@example.com', iat: t - 5, nbf: t - 5, exp: t + 600, type: 'app', ...claims}
			const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
			const data = `${enc(header)}.${enc(body)}`
			if (alg === 'none') return `${data}.AAAA`
			const sig = createSign('RSA-SHA256').update(data).sign(key.privateKey).toString('base64url')
			return `${data}.${sig}`
		},
		verifier: () => createAccessVerifier({fetchImpl: team.fetchImpl}),
	}
	return team
}

function newKey(kid) {
	const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048})
	const jwk = {...publicKey.export({format: 'jwk'}), kid, alg: 'RS256', use: 'sig'}
	return {kid, publicKey, privateKey, jwk}
}

// Gate settings as omarchyd would hand them over.
export const openConfig = (extra = {}) => ({enabled: true, verified: true, blocked: false, syncedAt: Date.now(), hostname: HOST, audience: AUD, issuer: TEAM, certsUrl: CERTS, ...extra})
export const randomSub = () => randomBytes(6).toString('hex')
