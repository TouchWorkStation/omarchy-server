import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createApps} from '../omarchyd/apps.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd, stdio: 'pipe'}).toString()

function portAvailable(port) {
	return new Promise((resolve) => {
		const s = net.createServer()
		s.once('error', () => resolve(false))
		s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
	})
}

async function pickPort(start = 30000 + Math.floor(Math.random() * 2000)) {
	for (let p = start; p < start + 200; p++) if (await portAvailable(p)) return p
	throw new Error('no free port found')
}

test('failed app start, stop, and restart return the engine error instead of Internal error', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'app-lifecycle-')))
	const prevDockerHost = process.env.DOCKER_HOST
	t.after(async () => {
		if (prevDockerHost === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDockerHost
		await rm(root, {recursive: true, force: true})
	})

	const data = join(root, 'data')
	const home = join(root, 'home')
	await mkdir(home, {recursive: true})
	const sock = join(root, 'podman.sock')
	await writeFile(sock, '')
	process.env.DOCKER_HOST = `unix://${sock}`

	const appPort = await pickPort()
	const store = join(root, 'store')
	await mkdir(join(store, 'demo-app'), {recursive: true})
	await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo Store\n')
	await writeFile(join(store, 'demo-app', 'omarchy-app.yml'), `manifestVersion: 1\nid: demo-app\nname: Demo App\nversion: "1.0"\nport: ${appPort}\nweb:\n  service: web\n  port: 80\n`)
	await writeFile(join(store, 'demo-app', 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
	git(store, 'init', '-q', '-b', 'main')
	git(store, 'add', '.')
	git(store, 'commit', '-qm', 'init')

	let failCompose = null
	let podmanMissing = false
	const up = new Set()
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const verb = args.find((a) => ['up', 'stop', 'restart', 'pull', 'ps', 'down'].includes(a))
			if (failCompose && (verb === 'up' || verb === 'stop' || verb === 'restart')) throw failCompose()
			if (verb === 'up' || verb === 'restart') up.add(args[1])
			if (verb === 'stop' || verb === 'down') up.delete(args[1])
			if (verb === 'ps') return JSON.stringify([{Service: 'web', State: up.has(args[1]) ? 'running' : 'exited'}])
			return ''
		}
		if (cmd === 'podman') {
			if (args[0] === 'info') {
				if (podmanMissing) throw Object.assign(new Error('spawn podman ENOENT'), {code: 'ENOENT'})
				return '{}'
			}
			if (args[0] === 'ps') return JSON.stringify([...up].map((p) => ({Labels: {'com.docker.compose.project': p}, State: 'running'})))
			if (args[1] === 'rm') execFileSync('rm', args.slice(2))
			return ''
		}
		if (cmd === 'setfacl') return ''
		return ''
	}

	const accounts = await openAccounts(data)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const d = await startOmarchyd({
		port: 0,
		dataDir: data,
		home,
		webPort: 7799,
		updaterOptions: {autoCheck: false},
		appOptions: {run, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], systemApps: null},
	})
	t.after(() => d.close())

	const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {
		method: 'POST',
		headers: {'content-type': 'application/json'},
		body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}}),
	})).json()
	const auth = {authorization: `Bearer ${login.result.data.accessToken}`}

	const rpc = async (path, input, kind = 'mutation') => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...auth}}
		if (kind === 'mutation') {
			init.headers['content-type'] = 'application/json'
			init.body = JSON.stringify(input ?? null)
		} else if (input !== undefined) {
			url.searchParams.set('input', JSON.stringify(input))
		}
		const res = await fetch(url, init)
		return {status: res.status, body: await res.json()}
	}

	await rpc('appStore.addRepository', {url: `file://${store}`})
	await rpc('apps.install', {appId: 'demo-app'})
	for (let i = 0; i < 120; i++) {
		const list = (await rpc('apps.list', undefined, 'query')).body.result.data
		if (list.find((a) => a.id === 'demo-app' && a.state === 'running')) break
		await new Promise((r) => setTimeout(r, 40))
	}

	failCompose = () => new Error('docker-compose: Error response from daemon: failed to bind host port 0.0.0.0:31001/tcp: address already in use')
	for (const [proc, verb] of [['apps.stop', 'stop'], ['apps.start', 'start'], ['apps.restart', 'restart']]) {
		const r = await rpc(proc, {appId: 'demo-app'})
		assert.equal(r.status, 502, proc)
		assert.notEqual(r.body.error.message, 'Internal error')
		assert.match(r.body.error.message, new RegExp(`Demo App couldn’t ${verb}: .*address already in use`))
	}

	podmanMissing = true
	failCompose = () => new Error('docker-compose: Cannot connect to the Docker daemon')
	const down = await rpc('apps.start', {appId: 'demo-app'})
	assert.equal(down.status, 412)
	assert.match(down.body.error.message, /Apps need Podman/)
})

test('uninstall keeps protecting a dependency after the dependent app’s store is removed', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'app-deps-596-')))
	const prevDockerHost = process.env.DOCKER_HOST
	t.after(async () => {
		if (prevDockerHost === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDockerHost
		await rm(root, {recursive: true, force: true})
	})

	const sock = join(root, 'podman.sock')
	await writeFile(sock, '')
	process.env.DOCKER_HOST = `unix://${sock}`

	const portA = await pickPort()
	const portB = await pickPort(portA + 1)
	const store = join(root, 'store')
	await mkdir(join(store, 'aa'), {recursive: true})
	await mkdir(join(store, 'bb'), {recursive: true})
	await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
	await writeFile(join(store, 'aa', 'omarchy-app.yml'), `manifestVersion: 1\nid: aa\nname: aa\nversion: "1.0"\nport: ${portA}\nweb:\n  service: web\n  port: 80\n`)
	await writeFile(join(store, 'aa', 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
	await writeFile(join(store, 'bb', 'omarchy-app.yml'), `manifestVersion: 1\nid: bb\nname: bb\nversion: "1.0"\nport: ${portB}\ndependencies:\n  - aa\nweb:\n  service: web\n  port: 80\n`)
	await writeFile(join(store, 'bb', 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
	git(store, 'init', '-q', '-b', 'main')
	git(store, 'add', '.')
	git(store, 'commit', '-qm', 'init')

	const up = new Set()
	const networks = new Set()
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const verb = args.find((a) => ['up', 'stop', 'restart', 'pull', 'ps', 'down'].includes(a))
			if (verb === 'up' || verb === 'restart') up.add(args[1])
			if (verb === 'stop' || verb === 'down') up.delete(args[1])
			if (verb === 'ps') return JSON.stringify([{Service: 'web', State: up.has(args[1]) ? 'running' : 'exited'}])
			return ''
		}
		if (cmd === 'podman') {
			if (args[0] === 'info') return '{}'
			if (args[0] === 'ps') return JSON.stringify([...up].map((p) => ({Labels: {'com.docker.compose.project': p}, State: 'running'})))
			if (args[1] === 'rm') execFileSync('rm', args.slice(2))
			if (args[0] === 'network' && args[1] === 'exists' && !networks.has(args[2])) throw new Error('no such network')
			if (args[0] === 'network' && args[1] === 'create') networks.add(args.at(-1))
			return ''
		}
		if (cmd === 'setfacl') return ''
		return ''
	}

	const storeUrl = `file://${store}`
	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], systemApps: null, run})
	t.after(() => apps.close())

	await apps.procedures['appStore.addRepository'].run({url: storeUrl})
	await apps.procedures['apps.install'].run({appId: 'bb'})
	for (let i = 0; i < 120; i++) {
		const list = await apps.procedures['apps.list'].run()
		if (list.filter((a) => ['aa', 'bb'].includes(a.id) && a.state === 'running').length === 2) break
		await new Promise((r) => setTimeout(r, 40))
	}

	await assert.rejects(apps.procedures['apps.uninstall'].run({appId: 'aa'}), /bb needs aa/)
	await apps.procedures['appStore.removeRepository'].run({url: storeUrl})
	await assert.rejects(apps.procedures['apps.uninstall'].run({appId: 'aa'}), /bb needs aa/)

	await apps.procedures['apps.uninstall'].run({appId: 'bb'})
	await apps.procedures['apps.uninstall'].run({appId: 'aa'})
	assert.deepEqual(await apps.procedures['apps.list'].run(), [])
})
