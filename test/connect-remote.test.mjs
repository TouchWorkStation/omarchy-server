// Remote access API v1, omarchyd side: emergency disable, the local block, the gate settings, and
// reading the website's settings once their field names are known.
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createRemoteAccess, parseRemoteAccess, REMOTE_ACCESS_FIELDS} from '../omarchyd/connect-remote.mjs'

const CRED = 'b'.repeat(64)
const DEVICE = '11111111-2222-4333-8444-555555555555'
const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
// Only for these tests: a stand-in for the field names the website's contract will give.
const FIELDS = {state: 'state', configVersion: 'config_version', hostname: 'hostname', deviceId: 'device_id', dataCenterId: 'data_center_id', audience: 'access.aud', issuer: 'access.issuer', certsUrl: 'access.certs_url', connectorValidated: 'connector.validated'}

async function setup(answer, extra = {}) {
	const dir = await mkdtemp(join(os.tmpdir(), 'connect-remote-'))
	const calls = []
	let stopped = 0
	let revoked = 0
	const r = createRemoteAccess({
		dir,
		apiBase: 'https://myowndatacenter.com/api/public/cloud',
		credential: () => CRED,
		deviceId: () => DEVICE,
		onRevoked: () => revoked++,
		stopConnector: async () => stopped++,
		fetchImpl: async (url, init) => {
			calls.push({url, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect})
			return answer(init)
		},
		autoStart: false,
		log: () => {},
		...extra,
	})
	await r.ready
	return {r, dir, calls, stopped: () => stopped, revoked: () => revoked, cleanup: () => (r.close(), rm(dir, {recursive: true, force: true}))}
}

test('emergency disable, confirmed by the website', async () => {
	const t = await setup(() => json(200, {state: 'disabled', verified: true}))
	try {
		assert.deepEqual(await t.r.disable(), {verified: true})
		assert.deepEqual(t.calls[0], {url: 'https://myowndatacenter.com/api/public/cloud/remote-access', method: 'POST', auth: `Bearer ${CRED}`, body: {action: 'disable'}, redirect: 'error'})
		assert.equal(t.stopped(), 0)
		assert.equal(t.r.status().blocked, null)
		assert.equal(t.r.gate().enabled, false)
	} finally {
		await t.cleanup()
	}
})

test('emergency disable not confirmed (502 disable_unverified, or offline): blocked here, connector stopped, warning, retry', async () => {
	for (const answer of [() => json(502, {error: 'disable_unverified'}), () => Promise.reject(new TypeError('fetch failed')), () => json(200, {state: 'disabled', verified: false})]) {
		const t = await setup(answer)
		try {
			assert.deepEqual(await t.r.disable(), {verified: false})
			assert.equal(t.stopped(), 1, 'the connector is stopped')
			const s = t.r.status()
			assert.ok(s.blocked)
			assert.equal(s.warning.kind, 'disable_unverified')
			assert.match(s.warning.message, /blocked remote access itself/)
			assert.equal(t.r.gate().blocked, true)
			// The block survives a restart.
			assert.ok(JSON.parse(await readFile(join(t.dir, 'remote.json'), 'utf8')).blocked)
			const again = createRemoteAccess({dir: t.dir, apiBase: 'https://myowndatacenter.com/api/public/cloud', credential: () => CRED, deviceId: () => DEVICE, autoStart: false, log: () => {}})
			await again.ready
			assert.equal(again.gate().blocked, true)
			// The owner retries the cloud-side switch-off.
			assert.equal(t.calls.filter((c) => c.method === 'POST').length, 1)
		} finally {
			await t.cleanup()
		}
	}
})

// The §10 answer, as the website sends it for an enabled installation.
const BODY = (over = {}) => ({
	api_version: 1, data_center_id: 'd', device_id: DEVICE, selected_connector: true, hostname: 'nodezero.myowndatacenter.com', origin: 'http://127.0.0.1:7780',
	state: 'enabled', mode: 'adopted', enabled: true, config_version: 3, connector_validation: false, error: null,
	access: {audience: 'a'.repeat(64), issuer: 'https://weisguy.cloudflareaccess.com', certs_url: 'https://weisguy.cloudflareaccess.com/cdn-cgi/access/certs', jwt_header: 'Cf-Access-Jwt-Assertion', algorithms: ['RS256']},
	credentials: {rotation_required: false},
	security: {contract_version: 1, protection_mode: 'cloudflare_access', desired_ingress: 'protected_route', observed_ingress: 'unknown', verification: 'not_checked_this_request', config_version: 3, sso_only_activation_allowed: false},
	sso: {enabled: false, available: true, stage: 'behind_access', contract_version: 1, callback_path: '/modc/auth/callback', authorization_endpoint: 'https://myowndatacenter.com/connect/authorize'},
	...over,
})

test('the §10 answer: read, checked and handed to the gate; another device’s ignored; 401 means revoked', async () => {
	assert.ok(REMOTE_ACCESS_FIELDS)
	let answer = () => json(200, BODY())
	const t = await setup(() => answer())
	try {
		await t.r.tick()
		const g = t.r.gate()
		assert.equal(g.enabled, true)
		assert.equal(g.verified, true)
		assert.equal(g.hostname, 'nodezero.myowndatacenter.com')
		assert.equal(g.audience, 'a'.repeat(64))
		assert.equal(g.certsUrl, 'https://weisguy.cloudflareaccess.com/cdn-cgi/access/certs')
		assert.ok(g.syncedAt)
		assert.ok(!JSON.stringify(g).includes(CRED))
		answer = () => json(200, BODY({device_id: '99999999-2222-4333-8444-555555555555', config_version: 4}))
		await t.r.tick()
		assert.equal(t.r.status().problem, 'other_device')
		assert.equal(t.r.status().configVersion, 3, 'kept the last good settings')
		answer = () => json(401, {error: 'invalid_credential'})
		await t.r.tick()
		await new Promise((r) => setTimeout(r, 10))
		assert.equal(t.revoked(), 1)
	} finally {
		await t.cleanup()
	}
})

test('the gate stays shut unless every part agrees', async () => {
	for (const [label, over, key] of [
		['not the selected connector', {selected_connector: false}, 'enabled'],
		['enabled flag off', {enabled: false}, 'enabled'],
		['rotation pending', {credentials: {rotation_required: true}}, 'enabled'],
		['protection not Access', {security: {...BODY().security, protection_mode: 'disabled'}}, 'verified'],
		['another contract', {security: {...BODY().security, contract_version: 2}}, 'verified'],
		['not RS256', {access: {...BODY().access, algorithms: ['HS256']}}, 'verified'],
	]) {
		const t = await setup(() => json(200, BODY(over)))
		try {
			await t.r.tick()
			assert.equal(t.r.gate()[key], false, label)
		} finally {
			await t.cleanup()
		}
	}
	assert.equal(parseRemoteAccess(BODY({api_version: 2})), null)
	assert.equal(parseRemoteAccess(BODY({config_version: '3'})), null)
})
