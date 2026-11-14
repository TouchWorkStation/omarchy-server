// Security settings: the restricted certificate authority, "Always use the secure address", and
// locking the desktop again after a sign-in from the web.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'
import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {authorityInfo, ensureTls, privateAddress, readPolicy, rotateAuthority, wantsUpgrade, writePolicy} from '../omarchyd/tls.mjs'

let root
before(async () => (root = await mkdtemp(join(os.tmpdir(), 'omarchy-sec-'))))
after(() => rm(root, {recursive: true, force: true}))

const names = {dns: ['localhost', 'box.local', 'example.com'], ips: ['127.0.0.1', '192.168.25.63', '8.8.8.8', 'fd12::5', '2001:db8::1']}
const sans = (dir) => execFileSync('openssl', ['x509', '-in', join(dir, 'server.crt'), '-noout', '-ext', 'subjectAltName']).toString()

describe('certificate authority', () => {
	test('private addresses', () => {
		for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '127.0.0.1', '::1', 'fd00::1']) assert.ok(privateAddress(ip), ip)
		for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', 'fe80::1']) assert.ok(!privateAddress(ip), ip)
	})

	test('a new authority is restricted to home-network names and private addresses', async () => {
		const dir = join(root, 'new')
		await ensureTls({dir, names})
		assert.deepEqual(await authorityInfo(dir), {exists: true, restricted: true})
		const nc = execFileSync('openssl', ['x509', '-in', join(dir, 'ca.crt'), '-noout', '-ext', 'nameConstraints']).toString()
		assert.match(nc, /critical/)
		assert.match(nc, /DNS:local\b/)
		assert.match(nc, /IP:192\.168\.0\.0\/255\.255\.0\.0/)
		const san = sans(dir)
		assert.match(san, /DNS:box\.local/)
		assert.match(san, /192\.168\.25\.63/)
		assert.doesNotMatch(san, /example\.com|8\.8\.8\.8|2001/, 'only names the authority may sign for')
		execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'server.crt')])
		// It can't vouch for a real website, even with its own key.
		await writeFile(join(dir, 'evil.cnf'), 'subjectAltName=DNS:bank.example.com\n')
		execFileSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'evil.key', '-out', 'evil.csr', '-subj', '/CN=bank.example.com'], {cwd: dir, stdio: 'ignore'})
		execFileSync('openssl', ['x509', '-req', '-in', 'evil.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-out', 'evil.crt', '-days', '2', '-extfile', 'evil.cnf'], {cwd: dir, stdio: 'ignore'})
		assert.throws(() => execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'evil.crt')], {stdio: 'pipe'}))
	})

	test('an authority from before 0.9.4 is kept (devices already trust it) until it is replaced', async () => {
		const dir = join(root, 'old')
		await ensureTls({dir, names})
		// What an older version made: no restriction, no ca.json.
		await rm(join(dir, 'ca.json'))
		execFileSync('openssl', ['req', '-x509', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '30', '-subj', '/CN=old'], {cwd: dir, stdio: 'ignore'})
		await rm(join(dir, 'server.json'))
		const oldCa = await readFile(join(dir, 'ca.crt'), 'utf8')
		await ensureTls({dir, names})
		assert.equal(await readFile(join(dir, 'ca.crt'), 'utf8'), oldCa)
		assert.deepEqual(await authorityInfo(dir), {exists: true, restricted: false})
		assert.match(sans(dir), /example\.com/, 'unchanged behaviour for the old authority')

		const t = await rotateAuthority({dir, names})
		assert.notEqual(t.ca, oldCa)
		assert.deepEqual(await authorityInfo(dir), {exists: true, restricted: true})
		assert.doesNotMatch(sans(dir), /example\.com/)
		const retired = (await readdir(dir)).filter((f) => f.startsWith('retired-'))
		assert.equal(retired.length, 1)
		assert.equal(await readFile(join(dir, retired[0], 'ca.crt'), 'utf8'), oldCa, 'the old files are kept, not deleted')
	})

	test('always-https: only a browser opening a page is sent to https', async () => {
		const dir = join(root, 'policy')
		assert.deepEqual(await readPolicy(dir), {alwaysHttps: false})
		await writePolicy(dir, {alwaysHttps: true})
		const on = await readPolicy(dir)
		const req = (headers, method = 'GET', encrypted = false) => ({method, headers, socket: {encrypted}})
		const ctx = {}
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate'}), on, ctx), true)
		assert.equal(wantsUpgrade(req({accept: 'text/html,*/*'}), on, ctx), true)
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'cors'}), on, ctx), false, 'an app’s own API calls')
		assert.equal(wantsUpgrade(req({accept: 'application/json'}), on, ctx), false, 'mobile and desktop clients')
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate'}, 'POST'), on, ctx), false)
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate'}, 'GET', true), on, ctx), false, 'already secure')
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate', 'x-forwarded-proto': 'https'}), on, ctx), false, 'behind a remote-access proxy')
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate'}), on, null), false, 'no certificate, no redirect')
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate'}), {alwaysHttps: false}, ctx), false, 'off by default')
	})
})

describe('omarchyd security settings', () => {
	let d, auth, vnc, locks
	before(async () => {
		const data = join(root, 'd')
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		vnc = net.createServer((sock) => sock.on('error', () => {}).write('RFB 003.008\n'))
		await new Promise((r) => vnc.listen(0, '127.0.0.1', r))
		locks = 0
		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home: root,
			desktopVncPort: vnc.address().port,
			desktopVncSocket: join(root, 'no-such.sock'),
			machineOptions: {lockGraceMs: 150, lockDesktop: async () => void locks++},
			storageOptions: {run: async (cmd, args) => (cmd === 'sudo' && args[2] === 'desktop-sign-in' ? 'signed-in' : '')},
		})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 's'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}
	})
	after(async () => {
		vnc.close()
		await d?.close()
	})
	const call = async (path, input, kind = 'mutation', headers = auth) => {
		const res = await (kind === 'query' ? fetch(`${d.url}/trpc/${path}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`, {headers}) : fetch(`${d.url}/trpc/${path}`, {method: 'POST', headers, body: JSON.stringify(input ?? null)}))
		const r = await res.json()
		if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error))
		return r.result.data
	}
	const view = async () => {
		const t = await call('user.createWebSocketTicket', {target: 'machines'})
		const ws = new WebSocket(`${d.url.replace('http', 'ws')}/machines/console?machineId=desktop&ticket=${t}`, ['binary'])
		await new Promise((r, j) => (ws.once('message', r), ws.once('error', j)))
		return ws
	}
	const wait = (ms) => new Promise((r) => setTimeout(r, ms))

	test('defaults: https optional, lock on', async () => {
		const s = await call('system.security', null, 'query')
		assert.equal(s.alwaysHttps, false)
		assert.equal(s.lockAfterRemote, true)
	})

	test('after a sign-in from the web, the desktop locks once the last viewer leaves (not on a quick reconnect)', async () => {
		await call('system.desktopSignIn', {password: 'correct horse'})
		const a = await view()
		const b = await view()
		a.close()
		await wait(300)
		assert.equal(locks, 0, 'someone is still watching')
		b.close()
		await wait(50)
		const c = await view() // a page reload
		await wait(300)
		assert.equal(locks, 0)
		c.close()
		await wait(400)
		assert.equal(locks, 1)
		// Viewing again later, without a new sign-in, doesn't lock it again.
		const e = await view()
		e.close()
		await wait(400)
		assert.equal(locks, 1)
	})

	test('the lock can be turned off; only the owner changes these settings', async () => {
		await call('system.setSecurity', {lockAfterRemote: false})
		assert.equal((await call('system.security', null, 'query')).lockAfterRemote, false)
		await call('system.desktopSignIn', {password: 'correct horse'})
		const v = await view()
		v.close()
		await wait(400)
		assert.equal(locks, 1, 'not locked when turned off')
		await call('system.setSecurity', {lockAfterRemote: true, alwaysHttps: true})
		assert.equal((await call('system.security', null, 'query')).alwaysHttps, true)
		await call('system.setSecurity', {alwaysHttps: false})
	})
})
