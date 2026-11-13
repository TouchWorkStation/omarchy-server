// omarchyd apps: a real git store (file://), compose preparation, install/uninstall through a
// simulated docker-compose, and the sign-in gateway in front of the app (HTTP and WebSocket).
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'
import WebSocket, {WebSocketServer} from 'ws'
import YAML from 'yaml'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {prepareCompose} from '../omarchyd/apps.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

test('prepareCompose swaps app_proxy for a 127.0.0.1-only port on the named service', () => {
	const text = `version: "3.7"\nservices:\n  app_proxy:\n    environment:\n      APP_HOST: demo_web_1\n      APP_PORT: 3000\n  web:\n    image: x\n    depends_on: [app_proxy, db]\n  db:\n    image: y\n`
	const out = prepareCompose('demo', text, () => 21234)
	const doc = YAML.parse(out.text)
	assert.equal(out.internalPort, 21234)
	assert.equal(doc.services.app_proxy, undefined)
	assert.deepEqual(doc.services.web.ports, ['127.0.0.1:21234:3000'])
	assert.deepEqual(doc.services.web.depends_on, ['db'])
	// Host-network apps bind GATEWAY_IP (127.0.0.1) themselves.
	const host = prepareCompose('demo', `services:\n  app_proxy:\n    environment:\n      APP_HOST: $GATEWAY_IP\n      APP_PORT: 38790\n  web:\n    image: x\n    network_mode: host\n`, () => 1)
	assert.equal(host.internalPort, 38790)
	assert.equal(YAML.parse(host.text).services.web.ports, undefined)
})

describe('omarchyd apps', () => {
	let root, data, d, storeUrl, auth, appPort, upstream, wss
	const calls = []
	const up = new Set()
	const git = (args, cwd) => execFileSync('git', args, {cwd, stdio: 'pipe'}).toString()
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') return git(args, opts.cwd)
		if (cmd === 'docker-compose') {
			calls.push({args, env: opts.env})
			const p = args[1]
			const verb = args[4]
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			if (verb === 'up' || verb === 'restart') up.add(p)
			if (verb === 'stop' || verb === 'down') up.delete(p)
			if (verb === 'ps') return JSON.stringify([{Service: 'web', State: up.has(p) ? 'running' : 'exited'}])
			if (verb === 'logs') return 'web-1  | hello from the app\n'
			return ''
		}
		if (cmd === 'podman') {
			calls.push({podman: args})
			if (args[1] === 'rm') execFileSync('rm', args.slice(2))
			return ''
		}
		if (cmd === 'setfacl') return ''
		if (cmd === 'bwrap') {
			// Stand-in for the sandbox: same clean environment, plain bash.
			const env = {}
			for (let i = 0; i < args.length; i++) if (args[i] === '--setenv') (env[args[i + 1]] = args[i + 2]), (i += 2)
			return execFileSync('bash', ['-c', args.at(-1)], {env: {...env, PATH: '/usr/bin:/bin'}}).toString()
		}
		throw new Error(`${cmd} not simulated`)
	}

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-a-'))
		data = join(root, 'data')
		const sock = join(root, 'podman.sock')
		await writeFile(sock, '')
		process.env.DOCKER_HOST = `unix://${sock}`
		appPort = 38000 + Math.floor(Math.random() * 1500)
		// A store: one good app, one folder with a mismatched id (ignored).
		const store = join(root, 'store')
		await mkdir(join(store, 'demo-app'), {recursive: true})
		await mkdir(join(store, 'broken'), {recursive: true})
		await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo Store\n')
		await writeFile(join(store, 'demo-app/omarchy-app.yml'), `manifestVersion: 1\nid: demo-app\nname: Demo App\ntagline: Says hello\nversion: "1.0"\nport: ${appPort}\nicon: https://example.com/i.svg\ndefaultPassword: ""\n`)
		await writeFile(join(store, 'demo-app/docker-compose.yml'), 'version: "3.7"\nservices:\n  app_proxy:\n    environment:\n      APP_HOST: demo-app_web_1\n      APP_PORT: 8080\n  web:\n    image: example/demo:1\n    volumes:\n      - ${APP_DATA_DIR}/data:/data\n')
		await writeFile(join(store, 'broken/omarchy-app.yml'), 'id: not-broken\nname: X\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'store'], store)
		storeUrl = `file://${store}`
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({port: 0, dataDir: data, home: join(root, 'home'), webPort: 7799, appOptions: {run, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: []}})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`}
	})
	after(async () => {
		await d.close()
		upstream?.close()
		wss?.close()
		await rm(root, {recursive: true, force: true})
	})
	const call = async (path, input, kind = 'mutation') => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...auth}}
		if (kind === 'mutation') Object.assign(init.headers, {'content-type': 'application/json'}), (init.body = JSON.stringify(input ?? null))
		else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const body = await (await fetch(url, init)).json()
		if (body.error) throw new Error(body.error.message)
		return body.result.data
	}
	const q = (p, i) => call(p, i, 'query')
	const until = async (fn, ms = 5000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn()
			if (v) return v
			if (Date.now() > end) throw new Error('timed out')
			await new Promise((r) => setTimeout(r, 40))
		}
	}

	test('stores: plain-http refused; a store is added and its valid apps listed', async () => {
		await assert.rejects(call('appStore.addRepository', {url: 'http://example.com/store'}), /https/)
		await call('appStore.addRepository', {url: storeUrl})
		await assert.rejects(call('appStore.addRepository', {url: storeUrl}), /already added/)
		assert.deepEqual(await q('appStore.repositories'), [{url: storeUrl, meta: {id: 'demo', name: 'Demo Store'}}])
		const reg = await q('appStore.registry')
		assert.deepEqual(reg[0].apps.map((a) => [a.id, a.name, a.port]), [['demo-app', 'Demo App', appPort]])
		assert.equal(reg[0].apps[0].folder, undefined, 'server paths stay private')
	})

	test('install: runs compose with the app’s own folder and opens the gateway', async () => {
		await call('apps.install', {appId: 'demo-app'})
		const app = await until(async () => (await q('apps.list')).find((a) => a.id === 'demo-app' && a.state === 'running'))
		assert.equal(app.port, appPort)
		const upCall = calls.find((c) => c.args?.[4] === 'up')
		assert.match(upCall.env.APP_DATA_DIR, /apps\/installed\/demo-app$/)
		assert.equal(upCall.env.GATEWAY_IP, '127.0.0.1')
		const composed = YAML.parse(await readFile(join(data, 'apps/installed/demo-app/compose.omarchy.yml'), 'utf8'))
		assert.equal(composed.services.app_proxy, undefined)
		assert.deepEqual(composed.services.web.ports, [`127.0.0.1:${app.internalPort}:8080`])
		// The app's data folder was created for it.
		await readFile(join(data, 'apps/installed/demo-app/omarchy-app.yml'))
		assert.ok(calls.some((c) => c.podman?.join(' ') === `unshare chown -R 1000:1000 ${join(data, 'apps/installed/demo-app')}`), 'app folder handed to the container user')
		await assert.rejects(call('apps.install', {appId: 'demo-app'}), /already installed/)
		// Stand in for the container: an HTTP + WebSocket server on the internal port.
		upstream = http.createServer((req, res) => res.end(JSON.stringify({path: req.url, cookie: req.headers.cookie ?? ''})))
		wss = new WebSocketServer({server: upstream})
		wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)))
		await new Promise((r) => upstream.listen(app.internalPort, '127.0.0.1', r))
	})

	test('gateway: strangers go to the web app; a hand-over signs the browser in; cookies stay private', async () => {
		const gw = `http://127.0.0.1:${appPort}`
		const anon = await fetch(`${gw}/dash?x=1`, {redirect: 'manual'})
		assert.equal(anon.status, 302)
		assert.equal(anon.headers.get('location'), `http://127.0.0.1:7799/api/app-enter?app=demo-app&r=${encodeURIComponent('/dash?x=1')}`)
		assert.equal((await fetch(`${gw}/__omarchy/enter?t=forged`, {redirect: 'manual'})).status, 403)
		const {ticket} = await call('apps.accessTicket', {appId: 'demo-app'})
		const enter = await fetch(`${gw}/__omarchy/enter?t=${ticket}&r=${encodeURIComponent('/dash')}`, {redirect: 'manual'})
		assert.equal(enter.status, 302)
		assert.equal(enter.headers.get('location'), '/dash')
		const cookie = enter.headers.get('set-cookie').split(';')[0]
		assert.match(cookie, /^OMARCHY_APP_SESSION=v1\./)
		assert.equal((await fetch(`${gw}/__omarchy/enter?t=${ticket}`, {redirect: 'manual'})).status, 403, 'tickets are single-use')
		const ok = await (await fetch(`${gw}/dash`, {headers: {cookie: `${cookie}; theme=dark`}})).json()
		assert.deepEqual(ok, {path: '/dash', cookie: 'theme=dark'})
		// A tampered session is refused.
		const bad = cookie.slice(0, -2) + (cookie.endsWith('A') ? 'BB' : 'AA')
		assert.equal((await fetch(`${gw}/`, {headers: {cookie: bad}, redirect: 'manual'})).status, 302)
		// The web app can ask whether a session is valid.
		assert.equal((await fetch(`${d.url}/app-auth/v1/account/session?app=demo-app`, {headers: {cookie}})).status, 200)
		assert.equal((await fetch(`${d.url}/app-auth/v1/account/session?app=demo-app`)).status, 401)
		// WebSockets: refused without a session, echoed with one.
		const anonWs = new WebSocket(`ws://127.0.0.1:${appPort}/ws`)
		await new Promise((r) => anonWs.on('error', r))
		const ws = new WebSocket(`ws://127.0.0.1:${appPort}/ws`, {headers: {cookie}})
		await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)))
		ws.send('hi')
		assert.equal(await new Promise((r) => ws.once('message', (m) => r(m.toString()))), 'echo:hi')
		ws.close()
	})

	test('browser sign-in also hands out an app session', async () => {
		const r = await fetch(`${d.url}/trpc/user.login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse'})})
		assert.ok(r.headers.getSetCookie().some((c) => /^OMARCHY_APP_SESSION=v1\./.test(c)))
	})

	test('stores without a manifest; apps needing what we lack are listed but refused with a reason', async () => {
		const store = join(root, 'plain-apps')
		const app = async (id, manifest, compose) => {
			await mkdir(join(store, id), {recursive: true})
			await writeFile(join(store, id, 'umbrel-app.yml'), `manifestVersion: 1\nid: ${id}\nname: ${id}\nport: ${appPort + 5}\ndeterministicPassword: true\n${manifest}`)
			await writeFile(join(store, id, 'docker-compose.yml'), compose)
		}
		await app('plain', '', 'services:\n  web:\n    image: x\n    environment:\n      PW: $APP_PASSWORD\n      OPT: ${NOT_SET:-fine}\n')
		await app('needs-node', 'dependencies:\n  - bitcoin\n', 'services:\n  web:\n    image: x\n')
		await app('needs-vars', '', 'services:\n  web:\n    image: x\n    environment:\n      RPC: ${APP_BITCOIN_NODE_IP}\n')
		await app('with-exports', '', 'services:\n  web:\n    image: x\n    environment:\n      SSH: ${APP_GITEA_SSH_PORT}\n      KEY: ${APP_X_KEY}\n      URLS: ${APP_X_URLS}\n      DOMAIN: ${APP_DOMAIN}\n')
		await writeFile(join(store, 'with-exports', 'exports.sh'), 'export APP_GITEA_SSH_PORT="2222"\nexport APP_X_KEY=$(derive_entropy "${app_entropy_identifier}-X")\nips=$(hostname --all-ip-addresses)\nexport APP_X_URLS="${ips}"\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'apps'], store)
		await call('appStore.addRepository', {url: `file://${store}`})
		const reg = (await q('appStore.registry')).find((r) => r.url.endsWith('plain-apps'))
		assert.equal(reg.meta.name, 'Plain Apps')
		const by = Object.fromEntries(reg.apps.map((a) => [a.id, a]))
		assert.equal(by.plain.unsupported, undefined)
		assert.match(by['needs-node'].unsupported, /Needs bitcoin/)
		assert.match(by['needs-vars'].unsupported, /APP_BITCOIN_NODE_IP/)
		await assert.rejects(call('apps.install', {appId: 'needs-node'}), /can’t be installed here yet/)
		await call('apps.install', {appId: 'plain'})
		const plain = await until(async () => (await q('apps.list')).find((a) => a.id === 'plain' && a.state === 'running'))
		assert.match(plain.credentials.defaultPassword, /^[0-9a-f]{64}$/, 'app-generated password is shown')
		await call('apps.uninstall', {appId: 'plain'})
		assert.equal(by['with-exports'].unsupported, undefined, 'variables from exports.sh count as provided')
		calls.length = 0
		await call('apps.install', {appId: 'with-exports'})
		await until(async () => (await q('apps.list')).find((a) => a.id === 'with-exports' && a.state === 'running'))
		const env = calls.find((c) => c.args?.[4] === 'up').env
		assert.equal(env.APP_GITEA_SSH_PORT, '2222')
		assert.match(env.APP_X_KEY, /^[0-9a-f]{64}$/)
		assert.notEqual(env.APP_X_KEY, env.APP_PASSWORD)
		assert.match(env.APP_DOMAIN, /\.local$/)
		assert.equal(env.OMARCHY_ENTROPY_KEY, undefined, 'the entropy key isn’t passed on')
		await call('apps.uninstall', {appId: 'with-exports'})
		await call('appStore.removeRepository', {url: `file://${store}`})
	})

	test('logs, stop, uninstall', async () => {
		assert.match(await q('apps.logs', {appId: 'demo-app'}), /hello from the app/)
		await call('apps.stop', {appId: 'demo-app'})
		assert.equal((await q('apps.list'))[0].state, 'stopped')
		await call('apps.uninstall', {appId: 'demo-app'})
		assert.deepEqual(await q('apps.list'), [])
		assert.ok(calls.some((c) => c.args?.[4] === 'down' && c.args?.includes('--volumes')))
		await assert.rejects(fetch(`http://127.0.0.1:${appPort}/`), 'gateway closed')
		await call('appStore.removeRepository', {url: storeUrl})
		assert.deepEqual(await q('appStore.registry'), [])
	})
})
