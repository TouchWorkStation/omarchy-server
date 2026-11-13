// omarchyd apps: a real git store (file://), compose preparation, install/uninstall through a
// simulated docker-compose, and the sign-in gateway in front of the app (HTTP and WebSocket).
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
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
	// Hosts given as a container name.
	const named = prepareCompose('searxng', `services:\n  app_proxy:\n    environment:\n      APP_HOST: searxng-web\n      APP_PORT: 8080\n  redis:\n    image: r\n  web:\n    image: x\n    container_name: searxng-web\n`, () => 21000)
	assert.deepEqual(YAML.parse(named.text).services.web.ports, ['127.0.0.1:21000:8080'])
})

describe('omarchyd apps', () => {
	let root, data, d, storeUrl, auth, appPort, upstream, wss
	const calls = []
	const up = new Set()
	const networks = new Set()
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
			if (args[0] === 'network' && args[1] === 'exists' && !networks.has(args[2])) throw new Error('no such network')
			if (args[0] === 'network' && args[1] === 'create') networks.add(args.at(-1))
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

	const runImpl = {current: null}
	before(async () => {
		runImpl.current = run
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
		d = await startOmarchyd({port: 0, dataDir: data, home: join(root, 'home'), webPort: 7799, appOptions: {run: (...a) => runImpl.current(...a), allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: []}})
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
		assert.ok(calls.some((c) => c.podman?.join(' ') === `unshare chown -R 1000:1000 ${join(data, 'apps/installed/demo-app/data')}`), 'data folder handed to the container user')
		assert.ok(!calls.some((c) => c.podman?.join(' ') === `unshare chown -R 1000:1000 ${join(data, 'apps/installed/demo-app')}`), 'the app’s own files stay readable')
		await assert.rejects(call('apps.install', {appId: 'demo-app'}), /already installed/)
		// Stand in for the container: an HTTP + WebSocket server on the internal port.
		upstream = http.createServer((req, res) => {
			res.setHeader('x-frame-options', 'DENY')
			res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'")
			res.end(JSON.stringify({path: req.url, cookie: req.headers.cookie ?? ''}))
		})
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
		const okRes = await fetch(`${gw}/dash`, {headers: {cookie: `${cookie}; theme=dark`}})
		// Only the Omarchy Server web app on this host may show the app inside its page.
		assert.equal(okRes.headers.get('x-frame-options'), null)
		assert.equal(okRes.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'self' http://127.0.0.1:7799 https://127.0.0.1:7799")
		assert.deepEqual(await okRes.json(), {path: '/dash', cookie: 'theme=dark'})
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
		assert.equal(by['needs-vars'].unsupported, undefined, 'unknown settings don’t block installing')
		assert.match(by['needs-vars'].caution, /APP_BITCOIN_NODE_IP/)
		await assert.rejects(call('apps.install', {appId: 'needs-node'}), /needs bitcoin, which isn’t in your stores/)
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

	test('a failed install shows its error, and installing again starts over', async () => {
		const failOnce = {left: 1}
		const original = run
		calls.length = 0
		up.clear()
		const failing = async (cmd, args, opts) => {
			if (cmd === 'docker-compose' && args[4] === 'pull' && failOnce.left-- > 0) throw new Error('docker-compose: pull access denied')
			return original(cmd, args, opts)
		}
		runImpl.current = failing
		await call('apps.uninstall', {appId: 'demo-app'})
		await call('apps.install', {appId: 'demo-app'}).catch(() => {})
		const failed = await until(async () => (await q('apps.list')).find((a) => a.id === 'demo-app' && a.error))
		assert.match(failed.error, /pull access denied/)
		await call('apps.install', {appId: 'demo-app'})
		await until(async () => (await q('apps.list')).find((a) => a.id === 'demo-app' && a.state === 'running'))
		runImpl.current = original
	})

	test('an app installs together with the apps it needs, on a shared network, in order', async () => {
		const store = join(root, 'linked-apps')
		const app = async (id, manifest, compose, exportsSh) => {
			await mkdir(join(store, id), {recursive: true})
			await writeFile(join(store, id, 'umbrel-app.yml'), `manifestVersion: 1\nid: ${id}\nname: ${id}\nport: ${appPort + (id === 'node' ? 7 : 8)}\n${manifest}`)
			await writeFile(join(store, id, 'docker-compose.yml'), compose)
			if (exportsSh) await writeFile(join(store, id, 'exports.sh'), exportsSh)
		}
		await app('node', '', 'services:\n  app_proxy:\n    environment:\n      APP_HOST: $APP_NODE_IP\n      APP_PORT: 3000\n  app:\n    image: x\n    networks:\n      default:\n        ipv4_address: $APP_NODE_IP\n  db:\n    image: y\n', 'export APP_NODE_IP="10.21.21.8"\nexport APP_NODE_RPC_PORT="8332"\n')
		await app('wallet', 'dependencies:\n  - node\n', 'services:\n  web:\n    image: z\n    environment:\n      NODE: ${APP_NODE_IP}:${APP_NODE_RPC_PORT}\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'apps'], store)
		await call('appStore.addRepository', {url: `file://${store}`})
		const reg = (await q('appStore.registry')).find((r) => r.url.endsWith('linked-apps'))
		const wallet = reg.apps.find((a) => a.id === 'wallet')
		assert.equal(wallet.unsupported, undefined, 'variables from the app it needs count as provided')
		assert.deepEqual(wallet.needs, ['node'])
		assert.deepEqual((await q('apps.installReview', {appId: 'wallet'})).alsoInstalls.map((a) => a.id), ['node'])
		calls.length = 0
		await call('apps.install', {appId: 'wallet'})
		assert.deepEqual((await q('apps.list')).filter((a) => ['node', 'wallet'].includes(a.id)).map((a) => a.state), ['installing', 'installing'])
		await until(async () => (await q('apps.list')).filter((a) => ['node', 'wallet'].includes(a.id) && a.state === 'running').length === 2, 8000)
		const ups = calls.filter((c) => c.args?.[4] === 'up').map((c) => c.args[1])
		assert.deepEqual(ups, ['omarchy-node', 'omarchy-wallet'], 'what it needs comes first')
		assert.ok(calls.some((c) => c.podman?.join(' ') === 'network create --subnet 10.21.0.0/16 --gateway 10.21.0.1 omarchy_main_network'))
		const nodeCompose = YAML.parse(await readFile(join(data, 'apps', 'installed', 'node', 'compose.omarchy.yml'), 'utf8'))
		assert.deepEqual(nodeCompose.networks.default, {name: 'omarchy_main_network', external: true})
		assert.equal(nodeCompose.services.db.container_name, 'node_db_1')
		assert.match(nodeCompose.services.app.ports.at(-1), /^127\.0\.0\.1:\d+:3000$/, 'the web service found by its fixed address')
		const walletUp = calls.find((c) => c.args?.[1] === 'omarchy-wallet' && c.args?.[4] === 'up')
		assert.equal(walletUp.env.APP_NODE_IP, '10.21.21.8', 'it gets the variables of the app it needs')
		await assert.rejects(call('apps.uninstall', {appId: 'node'}), /wallet needs node/)
		await call('apps.uninstall', {appId: 'wallet'})
		await call('apps.uninstall', {appId: 'node'})
		await call('appStore.removeRepository', {url: `file://${store}`})
	})

	test('apps holding their own port get a view gateway; a web port can come from exports.sh', async () => {
		const store = join(root, 'own-port-apps')
		const ownPort = appPort + 9
		await mkdir(join(store, 'hostnet'), {recursive: true})
		await writeFile(join(store, 'hostnet', 'umbrel-app.yml'), `manifestVersion: 1\nid: hostnet\nname: Hostnet\nport: ${ownPort}\n`)
		await writeFile(join(store, 'hostnet', 'docker-compose.yml'), 'services:\n  server:\n    image: x\n    network_mode: host\n')
		await mkdir(join(store, 'varport'), {recursive: true})
		await writeFile(join(store, 'varport', 'umbrel-app.yml'), `manifestVersion: 1\nid: varport\nname: Varport\nport: ${appPort + 10}\n`)
		await writeFile(join(store, 'varport', 'docker-compose.yml'), 'services:\n  app_proxy:\n    environment:\n      APP_HOST: varport_web_1\n      APP_PORT: $APP_VARPORT_PORT\n  web:\n    image: x\n')
		await writeFile(join(store, 'varport', 'exports.sh'), 'export APP_VARPORT_PORT="4000"\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'apps'], store)
		await call('appStore.addRepository', {url: `file://${store}`})
		// The app itself, listening on its own port (as a host-network app does).
		const own = http.createServer((req, res) => {
			res.setHeader('x-frame-options', 'SAMEORIGIN')
			res.end(JSON.stringify({forwarded: Object.keys(req.headers).filter((k) => k.startsWith('x-forwarded'))}))
		})
		try {
			await call('apps.install', {appId: 'hostnet'})
			await new Promise((r) => own.listen(ownPort, '127.0.0.1', r))
			await call('apps.install', {appId: 'varport'})
			const host = await until(async () => (await q('apps.list')).find((a) => a.id === 'hostnet' && a.state === 'running'))
			assert.ok(host.viewPort >= 7900 && host.viewPort < 8000, 'a view gateway port')
			const anon = await fetch(`http://127.0.0.1:${host.viewPort}/`, {redirect: 'manual'})
			assert.equal(anon.headers.get('location'), `http://127.0.0.1:7799/api/app-enter?app=hostnet&r=%2F&view=1`)
			const {ticket, port} = await call('apps.accessTicket', {appId: 'hostnet', view: true})
			assert.equal(port, host.viewPort)
			const enter = await fetch(`http://127.0.0.1:${port}/__omarchy/enter?t=${ticket}`, {redirect: 'manual'})
			const cookie = enter.headers.get('set-cookie').split(';')[0]
			const page = await fetch(`http://127.0.0.1:${port}/`, {headers: {cookie}})
			assert.deepEqual(await page.json(), {forwarded: []}, 'no proxy headers reach the app')
			assert.equal(page.headers.get('x-frame-options'), null)
			await until(async () => (await q('apps.list')).find((a) => a.id === 'varport' && a.state === 'running'))
			const vp = YAML.parse(await readFile(join(data, 'apps', 'installed', 'varport', 'compose.omarchy.yml'), 'utf8'))
			assert.match(vp.services.web.ports.at(-1), /^127\.0\.0\.1:\d+:4000$/)
		} finally {
			own.close()
			await call('apps.uninstall', {appId: 'hostnet'}).catch(() => {})
			await call('apps.uninstall', {appId: 'varport'}).catch(() => {})
			await call('appStore.removeRepository', {url: `file://${store}`})
		}
	})

	test('TouchWorkStation listings: plain Docker Compose with a named web service, your folders, extra ports', async () => {
		const store = join(root, 'tws-apps')
		await mkdir(join(store, 'tube'), {recursive: true})
		await writeFile(join(store, 'tube', 'omarchy-app.yml'), `manifestVersion: 1\nid: tube\nname: Tube\nport: ${appPort + 11}\nweb:\n  service: tube\n  port: 8096\nopenPorts: [6881]\n`)
		await writeFile(join(store, 'tube', 'docker-compose.yml'), 'services:\n  tube:\n    image: x\n    volumes:\n      - ${APP_DATA_DIR:-.}/data/config:/config\n      - ${VIDEOS_DIR:-./videos}:/media\n    ports:\n      - "8096:8096"\n      - "6881:6881"\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'apps'], store)
		await call('appStore.addRepository', {url: `file://${store}`})
		const listing = (await q('appStore.registry')).find((r) => r.url.endsWith('tws-apps')).apps[0]
		assert.equal(listing.unsupported, undefined)
		assert.deepEqual(listing.web, {service: 'tube', port: 8096})
		await call('apps.install', {appId: 'tube'})
		await until(async () => (await q('apps.list')).find((a) => a.id === 'tube' && a.state === 'running'))
		const out = YAML.parse(await readFile(join(data, 'apps', 'installed', 'tube', 'compose.omarchy.yml'), 'utf8'))
		const ports = out.services.tube.ports
		assert.ok(!ports.includes('8096:8096'), 'its own published web port gives way to the private one')
		assert.ok(ports.includes('6881:6881'))
		assert.match(ports.at(-1), /^127\.0\.0\.1:\d+:8096$/)
		assert.ok(await stat(join(root, 'home', 'Videos')).then((x) => x.isDirectory()), 'your Videos folder is there for it')
		assert.ok(await stat(join(data, 'apps', 'installed', 'tube', 'data', 'config')).then((x) => x.isDirectory()), '${APP_DATA_DIR:-.} paths are understood')
		await call('apps.uninstall', {appId: 'tube'})
		await call('appStore.removeRepository', {url: `file://${store}`})
	})

	test('extra access: worked out from the compose file, refused until you allow it, socket is your own', async () => {
		const store = join(root, 'perm-apps')
		await mkdir(join(store, 'boss'), {recursive: true})
		await writeFile(join(store, 'boss', 'omarchy-app.yml'), `manifestVersion: 1\nid: boss\nname: Boss\nport: ${appPort + 12}\nweb:\n  service: boss\n  port: 9000\n`)
		await writeFile(join(store, 'boss', 'docker-compose.yml'), 'services:\n  boss:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n    cap_add: [NET_ADMIN]\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'apps'], store)
		await call('appStore.addRepository', {url: `file://${store}`})
		const review = await q('apps.installReview', {appId: 'boss'})
		assert.deepEqual(review.permissions.map((p) => p.id).sort(), ['containers', 'network'])
		assert.ok(review.permissions.every((p) => p.label && p.detail), 'explained in plain words')
		await assert.rejects(call('apps.install', {appId: 'boss'}), /needs your permission: control your containers, change networking/)
		await assert.rejects(call('apps.install', {appId: 'boss', grant: ['containers']}), /needs your permission: change networking/)
		await call('apps.install', {appId: 'boss', grant: ['containers', 'network']})
		const app = await until(async () => (await q('apps.list')).find((a) => a.id === 'boss' && a.state === 'running'))
		assert.ok(app)
		const out = YAML.parse(await readFile(join(data, 'apps', 'installed', 'boss', 'compose.omarchy.yml'), 'utf8'))
		assert.match(out.services.boss.volumes[0], /^\/(?!var\/run).*podman\.sock:\/var\/run\/docker\.sock$/, 'your own rootless socket, never a root one')
		await call('apps.uninstall', {appId: 'boss'})
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
