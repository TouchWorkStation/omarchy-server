// Security settings: the restricted certificate authority, "Always use the secure address", and
// locking the desktop again after a sign-in from the web.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'
import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {authorityInfo, ensureTls, privateAddress, readPolicy, rotateAuthority, tlsContext, wantsUpgrade, writePolicy} from '../omarchyd/tls.mjs'

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
		const req = (headers, method = 'GET', encrypted = false, remoteAddress = '127.0.0.1') => ({method, headers, socket: {encrypted, remoteAddress}})
		const ctx = {}
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate'}), on, ctx), true)
		assert.equal(wantsUpgrade(req({accept: 'text/html,*/*'}), on, ctx), true)
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'cors'}), on, ctx), false, 'an app’s own API calls')
		assert.equal(wantsUpgrade(req({accept: 'application/json'}), on, ctx), false, 'mobile and desktop clients')
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate'}, 'POST'), on, ctx), false)
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate'}, 'GET', true), on, ctx), false, 'already secure')
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate', 'x-forwarded-proto': 'https'}), on, ctx), false, 'behind a remote-access proxy')
		// Only a proxy on this machine is believed: anyone on the network could send the header.
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate', 'x-forwarded-proto': 'https'}, 'GET', false, '192.168.1.50'), on, ctx), true, 'a forged header from the network')
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate', 'x-forwarded-proto': 'https'}, 'GET', false, '::ffff:127.0.0.1'), on, ctx), false)
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate'}), on, null), false, 'no certificate, no redirect')
		assert.equal(wantsUpgrade(req({'sec-fetch-mode': 'navigate'}), {alwaysHttps: false}, ctx), false, 'off by default')
	})
})

describe('damaged tls metadata', () => {
	const logged = async (fn) => {
		const lines = []
		const orig = console.error
		console.error = (...parts) => lines.push(parts.map(String).join(' '))
		try {
			return {value: await fn(), lines}
		} finally {
			console.error = orig
		}
	}

	test('a damaged server.json keeps the certificate already on disk', async () => {
		const dir = join(root, 'damaged-server')
		const first = await ensureTls({dir, names})
		const caKey = await readFile(join(dir, 'ca.key'), 'utf8')
		const caCrt = await readFile(join(dir, 'ca.crt'), 'utf8')
		await writeFile(join(dir, 'server.json'), '')
		const again = await logged(() => ensureTls({dir, names}))
		assert.equal(again.value.cert, first.cert)
		assert.equal(again.value.key, first.key)
		assert.equal(again.value.ca, caCrt)
		assert.equal(await readFile(join(dir, 'ca.key'), 'utf8'), caKey)
		assert.equal(await readFile(join(dir, 'ca.crt'), 'utf8'), caCrt)
		assert.equal(await readFile(join(dir, 'server.json'), 'utf8'), '')
		assert.deepEqual(again.lines, ['[omarchy-server] TLS metadata damaged: server.json'])
		// A JSON array is the wrong type, not a missing file: still do not reissue.
		await writeFile(join(dir, 'server.json'), '[]')
		const typed = await ensureTls({dir, names})
		assert.equal(typed.cert, first.cert)
		assert.equal(await readFile(join(dir, 'server.json'), 'utf8'), '[]')
		assert.equal(await readFile(join(dir, 'ca.key'), 'utf8'), caKey)
	})

	test('a damaged ca.json does not replace the authority', async () => {
		const dir = join(root, 'damaged-ca')
		const first = await ensureTls({dir, names})
		const caKey = await readFile(join(dir, 'ca.key'), 'utf8')
		const caCrt = await readFile(join(dir, 'ca.crt'), 'utf8')
		await writeFile(join(dir, 'ca.json'), '')
		const kept = await logged(() => ensureTls({dir, names}))
		assert.equal(kept.value.cert, first.cert)
		assert.equal(await readFile(join(dir, 'ca.key'), 'utf8'), caKey)
		assert.equal(await readFile(join(dir, 'ca.crt'), 'utf8'), caCrt)
		assert.equal(await readFile(join(dir, 'ca.json'), 'utf8'), '')
		assert.deepEqual(kept.lines, ['[omarchy-server] TLS metadata damaged: ca.json'])
		// Renewal is due, and the permitted names cannot be read. Issuing would widen them.
		await rm(join(dir, 'server.json'))
		const due = await ensureTls({dir, names})
		assert.equal(due.cert, first.cert)
		assert.equal(await readFile(join(dir, 'ca.key'), 'utf8'), caKey)
		assert.equal(await readFile(join(dir, 'ca.crt'), 'utf8'), caCrt)
		assert.equal(await readFile(join(dir, 'ca.json'), 'utf8'), '')
		assert.equal(await readFile(join(dir, 'server.json'), 'utf8').catch((error) => error.code), 'ENOENT')
		assert.doesNotMatch(sans(dir), /example\.com/)
		const info = await authorityInfo(dir)
		assert.deepEqual(info, {exists: true, restricted: true})
		assert.equal(await readFile(join(dir, 'ca.json'), 'utf8'), '')
		await writeFile(join(dir, 'ca.json'), 'null')
		const typed = await ensureTls({dir, names})
		assert.equal(typed.cert, first.cert)
		assert.equal(await readFile(join(dir, 'ca.json'), 'utf8'), 'null')
		assert.equal(await readFile(join(dir, 'ca.key'), 'utf8'), caKey)
		assert.equal((await authorityInfo(dir)).restricted, true)
		// The restriction flag is set, but the permitted names are not. Still restricted.
		await writeFile(join(dir, 'ca.json'), '{"restricted":true}')
		assert.deepEqual(await authorityInfo(dir), {exists: true, restricted: true})
		const narrow = await ensureTls({dir, names})
		assert.equal(narrow.cert, first.cert)
		assert.equal(await readFile(join(dir, 'ca.key'), 'utf8'), caKey)
		assert.equal(await readFile(join(dir, 'ca.json'), 'utf8'), '{"restricted":true}')
	})

	test('a damaged ca.json with no certificate is not turned into a new authority', async () => {
		const dir = join(root, 'damaged-ca-empty')
		await mkdir(dir, {recursive: true})
		await writeFile(join(dir, 'ca.json'), '{')
		await assert.rejects(ensureTls({dir, names}), /ca\.json/)
		assert.equal(await readFile(join(dir, 'ca.json'), 'utf8'), '{')
		assert.equal((await readdir(dir)).some((name) => name === 'ca.key' || name === 'ca.crt' || name === 'ca.srl'), false)
	})

	test('a brand-new directory still gets a certificate', async () => {
		const dir = join(root, 'brand-new')
		const made = await ensureTls({dir, names})
		assert.match(made.cert, /BEGIN CERTIFICATE/)
		assert.match(made.key, /BEGIN/)
		assert.match(made.ca, /BEGIN CERTIFICATE/)
		assert.equal(JSON.parse(await readFile(join(dir, 'ca.json'), 'utf8')).restricted, true)
		assert.equal(typeof JSON.parse(await readFile(join(dir, 'server.json'), 'utf8')).expires, 'number')
		assert.equal((await stat(join(dir, 'ca.json'))).mode & 0o777, 0o600)
		assert.equal((await stat(join(dir, 'server.json'))).mode & 0o777, 0o600)
		execFileSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, 'server.crt')], {stdio: 'ignore'})
	})

	test('a damaged policy.json reads as https off and is left in place', async () => {
		const dir = join(root, 'damaged-policy')
		await mkdir(dir, {recursive: true})
		await writeFile(join(dir, 'policy.json'), '')
		const read = await logged(() => readPolicy(dir))
		assert.deepEqual(read.value, {alwaysHttps: false})
		assert.deepEqual(read.lines, ['[omarchy-server] TLS metadata damaged: policy.json'])
		assert.equal(await readFile(join(dir, 'policy.json'), 'utf8'), '')
		await writeFile(join(dir, 'policy.json'), '[]')
		assert.deepEqual(await readPolicy(dir), {alwaysHttps: false})
		assert.equal(await readFile(join(dir, 'policy.json'), 'utf8'), '[]')
		if (process.getuid?.() === 0) return
		await writeFile(join(dir, 'policy.json'), '{"alwaysHttps":true}', {mode: 0o600})
		await chmod(join(dir, 'policy.json'), 0o000)
		try {
			await assert.rejects(readPolicy(dir), {code: 'EACCES'})
		} finally {
			await chmod(join(dir, 'policy.json'), 0o600)
		}
		assert.equal(await readFile(join(dir, 'policy.json'), 'utf8'), '{"alwaysHttps":true}')
	})

	test('an unreadable policy.json does not reject startup and is read once it is allowed', async (t) => {
		if (process.getuid?.() === 0) return t.skip('root ignores file mode')
		const dir = join(root, 'policy-context')
		await mkdir(dir, {recursive: true})
		await writeFile(join(dir, 'policy.json'), '{"alwaysHttps":true}', {mode: 0o600})
		await chmod(join(dir, 'policy.json'), 0o000)
		const lines = []
		const orig = console.error
		console.error = (...parts) => lines.push(parts.map(String).join(' '))
		const secure = tlsContext({dir, lazy: true})
		try {
			const error = await secure.start().then(() => null, (reason) => reason)
			assert.equal(error, null)
			assert.equal(secure.policy().alwaysHttps, false)
			assert.ok(lines.some((line) => line.includes('policy.json') && line.includes('EACCES') && !line.includes(dir) && !line.includes('\n')))
			await chmod(join(dir, 'policy.json'), 0o600)
			const deadline = Date.now() + 8_000
			while (!secure.policy().alwaysHttps && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
			assert.equal(secure.policy().alwaysHttps, true)
		} finally {
			secure.close()
			console.error = orig
			await chmod(join(dir, 'policy.json'), 0o600).catch(() => {})
		}
	})

	test('a write-only CA key is not replaced when its certificate is gone', async (t) => {
		if (process.getuid?.() === 0) return t.skip('root ignores file mode')
		const dir = join(root, 'writeonly-key')
		await ensureTls({dir, names})
		const caKey = await readFile(join(dir, 'ca.key'))
		await chmod(join(dir, 'ca.key'), 0o200)
		await rm(join(dir, 'ca.crt'))
		try {
			await assert.rejects(ensureTls({dir, names}), {code: 'EACCES'})
		} finally {
			await chmod(join(dir, 'ca.key'), 0o600)
		}
		assert.deepEqual(await readFile(join(dir, 'ca.key')), caKey)
	})

	test('a certificate that cannot be read is not replaced', async (t) => {
		if (process.getuid?.() === 0) return t.skip('root ignores file mode')
		const dir = join(root, 'unreadable-ca')
		await ensureTls({dir, names})
		const caKey = await readFile(join(dir, 'ca.key'), 'utf8')
		const mode = (await stat(join(dir, 'ca.crt'))).mode & 0o777
		await chmod(join(dir, 'ca.crt'), 0o000)
		try {
			await assert.rejects(ensureTls({dir, names}), {code: 'EACCES'})
		} finally {
			await chmod(join(dir, 'ca.crt'), mode)
		}
		assert.equal(await readFile(join(dir, 'ca.key'), 'utf8'), caKey)
		assert.equal(await readFile(join(dir, 'ca.crt'), 'utf8').then((text) => text.length > 0), true)
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

describe('one certificate folder for omarchyd and the web server', () => {
	test('settings and certificate replacement land in the shared folder; an older https choice is carried over', async () => {
		const data = join(root, 'shared-d')
		const shared = join(root, 'shared-tls')
		// What a 0.9.4–0.9.12 server had: its own folder with "always https" turned on.
		await writePolicy(join(data, 'tls'), {alwaysHttps: true})
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const d = await startOmarchyd({port: 0, dataDir: data, home: root, tlsDir: shared, machineOptions: {run: async () => ''}})
		try {
			const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
			const h = {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}
			assert.equal((await readPolicy(shared)).alwaysHttps, true, 'carried over')
			await fetch(`${d.url}/trpc/system.setSecurity`, {method: 'POST', headers: h, body: JSON.stringify({alwaysHttps: false})})
			assert.equal((await readPolicy(shared)).alwaysHttps, false, 'the web server reads this folder')
			await ensureTls({dir: shared, names})
			const r = await (await fetch(`${d.url}/trpc/system.replaceCertificate`, {method: 'POST', headers: h, body: 'null'})).json()
			assert.equal(r.result.data.restricted, true)
			assert.ok((await readdir(shared)).some((f) => f.startsWith('retired-')), 'replaced in the shared folder')
		} finally {
			await d.close()
		}
	})

	test('the omarchyd command uses the same folder as the web server', async () => {
		const cli = await readFile(new URL('../omarchyd/cli.mjs', import.meta.url), 'utf8')
		const web = await readFile(new URL('../server/cli.mjs', import.meta.url), 'utf8')
		assert.match(cli, /tlsDir: defaultTlsDir\(\)/)
		assert.match(web, /tlsContext\(\{dir: defaultTlsDir\(\)\}\)/)
	})
})

describe('security.json on startup', () => {
	const startWithSecurity = async (name, bytes) => {
		const data = join(root, name)
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const file = join(data, 'security.json')
		let original = null
		if (bytes !== undefined) {
			await writeFile(file, bytes)
			original = await readFile(file)
		}
		const lines = []
		const orig = console.error
		console.error = (...args) => lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
		try {
			const d = await startOmarchyd({port: 0, dataDir: data, home: root, machineOptions: {run: async () => ''}})
			return {d, data, file, lines, original}
		} finally {
			console.error = orig
		}
	}
	const authed = async (d) => {
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 'sec'}})})).json()
		if (!login.result?.data?.accessToken) throw new Error(JSON.stringify(login))
		const headers = {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}
		return async (path, input, kind = 'mutation') => {
			const res = await (kind === 'query' ? fetch(`${d.url}/trpc/${path}`, {headers}) : fetch(`${d.url}/trpc/${path}`, {method: 'POST', headers, body: JSON.stringify(input ?? null)}))
			const r = await res.json()
			if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error))
			return r.result.data
		}
	}

	test('an empty security.json still starts, with the lock on, and the file is left byte for byte', async () => {
		const {d, file, lines, original} = await startWithSecurity('empty-sec', '')
		try {
			const call = await authed(d)
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, true)
			assert.deepEqual(await readFile(file), original)
			assert.equal(original.length, 0)
			const notes = lines.filter((l) => l.includes('security.json'))
			assert.equal(notes.length, 1)
			assert.match(notes[0], /left unchanged/)
			assert.equal(notes[0].includes(root), false)
		} finally {
			await d?.close()
		}
	})

	test('a truncated security.json still starts and is left unchanged, without logging its contents', async () => {
		const raw = '{"lockAfterRemote":false'
		const {d, file, lines, original} = await startWithSecurity('trunc-sec', raw)
		try {
			const call = await authed(d)
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, true)
			assert.deepEqual(await readFile(file), original)
			const notes = lines.filter((l) => l.includes('security.json'))
			assert.equal(notes.length, 1)
			assert.match(notes[0], /left unchanged/)
			assert.equal(notes[0].includes(root), false)
			assert.equal(notes.some((l) => l.includes(raw) || l.includes('lockAfterRemote')), false)
		} finally {
			await d?.close()
		}
	})

	test('a JSON string or array is not settings: the file stays, the lock stays on, and the log names security.json only', async () => {
		for (const [name, raw] of [
			['str-sec', '"do-not-log-string"'],
			['arr-sec', '["do-not-log-array"]'],
		]) {
			const {d, file, lines, original} = await startWithSecurity(name, raw)
			try {
				const call = await authed(d)
				assert.equal((await call('system.security', null, 'query')).lockAfterRemote, true)
				assert.deepEqual(await readFile(file), original)
				const notes = lines.filter((l) => l.includes('security.json'))
				assert.equal(notes.length, 1)
				assert.equal(notes[0].match(/security\.json/g).length, 1)
				assert.equal(notes[0].includes(root), false)
				assert.equal(lines.some((l) => l.includes(raw) || l.includes('do-not-log')), false)
			} finally {
				await d?.close()
			}
		}
	})

	test('a saved lockAfterRemote of false still loads', async () => {
		const {d, file, lines, original} = await startWithSecurity('off-sec', '{"lockAfterRemote":false}')
		try {
			const call = await authed(d)
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, false)
			assert.deepEqual(await readFile(file), original)
			assert.equal(lines.some((l) => /left unchanged/.test(l)), false)
		} finally {
			await d?.close()
		}
	})

	test('setSecurity still round-trips', async () => {
		const {d, file, data} = await startWithSecurity('round-sec')
		try {
			await assert.rejects(stat(file), {code: 'ENOENT'})
			const call = await authed(d)
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, true)
			await call('system.setSecurity', {lockAfterRemote: false})
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, false)
			assert.equal(JSON.parse(await readFile(file, 'utf8')).lockAfterRemote, false)
			assert.equal((await stat(file)).mode & 0o777, 0o600)
		} finally {
			await d?.close()
		}
		const d2 = await startOmarchyd({port: 0, dataDir: data, home: root, machineOptions: {run: async () => ''}})
		try {
			const call = await authed(d2)
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, false)
			await call('system.setSecurity', {lockAfterRemote: true})
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, true)
			assert.equal(JSON.parse(await readFile(file, 'utf8')).lockAfterRemote, true)
		} finally {
			await d2.close()
		}
	})

	test('a failed lockAfterRemote write leaves the previous lock and the file', async () => {
		const {d, file, data} = await startWithSecurity('lock-write-fail', '{"lockAfterRemote":false}')
		try {
			const call = await authed(d)
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, false)
			const before = await readFile(file)
			await chmod(data, 0o500)
			await assert.rejects(call('system.setSecurity', {lockAfterRemote: true}))
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, false)
			assert.deepEqual(await readFile(file), before)
		} finally {
			await chmod(data, 0o700)
			await d?.close()
		}
	})

	test('a failed write cannot turn the lock off while the file is missing', async () => {
		const {d, file} = await startWithSecurity('lock-write-dir')
		try {
			const call = await authed(d)
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, true)
			await mkdir(file)
			await assert.rejects(call('system.setSecurity', {lockAfterRemote: false}))
			assert.equal((await call('system.security', null, 'query')).lockAfterRemote, true)
			assert.equal((await stat(file)).isDirectory(), true)
		} finally {
			await d?.close()
		}
	})

	test('a security.json that cannot be read still stops startup and is left alone', async () => {
		const data = join(root, 'dir-sec')
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const file = join(data, 'security.json')
		await mkdir(file)
		await assert.rejects(startOmarchyd({port: 0, dataDir: data, home: root, machineOptions: {run: async () => ''}}), {code: 'EISDIR'})
		assert.equal((await stat(file)).isDirectory(), true)
		// Apps used to start writing apps.json before this read error, and that save could
		// finish after the test (or the temp dir) was gone. Wait, then check they never started.
		const until = Date.now() + 400
		while (Date.now() < until) {
			await assert.rejects(stat(join(data, 'apps', 'apps.json')), {code: 'ENOENT'})
			await new Promise((r) => setTimeout(r, 50))
		}
	})
})
