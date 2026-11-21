// Publishing an app built on this server: a local store (not a git clone), a runtime image, and a
// token that can publish and unpublish but not touch the rest of the server.
import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'
import YAML from 'yaml'

import {createApps, SHARED_NETWORK} from '../omarchyd/apps.mjs'
import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const owner = {auth: {userId: 'owner'}}

function mockRun() {
	const calls = []
	const containerfiles = []
	const networks = new Set()
	const up = new Set()
	const run = async (cmd, args, opts) => {
		calls.push({cmd, args})
		if (cmd === 'podman' && args[0] === 'build') {
			const at = args.indexOf('-f')
			if (at >= 0) containerfiles.push(readFileSync(args[at + 1], 'utf8'))
		}
		if (cmd === 'git') return execFileSync('git', args, {encoding: 'utf8', cwd: opts?.cwd, timeout: opts?.timeout ?? 60_000})
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const verb = args.find((a) => ['up', 'pull', 'down', 'ps', 'stop', 'restart', 'logs'].includes(a))
			const project = args[args.indexOf('-p') + 1]
			if (verb === 'up' || verb === 'restart') up.add(project)
			if (verb === 'stop' || verb === 'down') up.delete(project)
			if (verb === 'ps') return JSON.stringify([{Service: 'web', State: up.has(project) ? 'running' : 'exited'}])
			return ''
		}
		if (cmd === 'podman') {
			if (args[0] === 'network' && args[1] === 'exists' && !networks.has(args[2])) throw new Error('no such network')
			if (args[0] === 'network' && args[1] === 'create') networks.add(args.at(-1))
			if (args[0] === 'ps') return '[]'
			return ''
		}
		if (cmd === 'setfacl' || cmd === 'bwrap') return ''
		throw new Error(`${cmd} not simulated`)
	}
	return {calls, run, containerfiles}
}

async function fixture() {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-publish-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	const binary = join(home, 'Projects', 'solver')
	await mkdir(join(home, 'Projects'), {recursive: true})
	await writeFile(binary, '#!/bin/sh\nexit 0\n', {mode: 0o755})
	const sock = join(root, 'podman.sock')
	await writeFile(sock, '')
	const prevDockerHost = process.env.DOCKER_HOST
	process.env.DOCKER_HOST = `unix://${sock}`
	const engine = mockRun()
	const apps = createApps({
		dataDir: data,
		home,
		allowFileStores: true,
		gatewayHost: '127.0.0.1',
		defaultStores: [],
		systemApps: null,
		firewall: {open: async () => {}, close: async () => {}},
		run: engine.run,
	})
	const restore = () => {
		if (prevDockerHost === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDockerHost
	}
	return {root, home, data, binary, apps, calls: engine.calls, containerfiles: engine.containerfiles, run: engine.run, restore}
}

test('publish builds a local image, installs it on the shared network, updates it, and unpublishes it', async () => {
	const fx = await fixture()
	try {
		const publish = (input) => fx.apps.procedures['apps.publish'].run(input, owner)
		await assert.rejects(publish({appId: 'field-service', name: 'Field service', port: 7860}), /image or a binary/)
		await assert.rejects(publish({appId: 'field-service', name: 'Field service', port: 7860, binary: '/etc/hostname'}), /home folder/)
		await assert.rejects(publish({appId: 'field-service', name: 'Field service', port: 7860, apiPort: 7860, binary: fx.binary}), /own port/)
		await assert.rejects(publish({appId: 'field-service', name: 'Field service', port: 7860, apiPort: 40000, binary: fx.binary}), /API port/)
		const first = await publish({appId: 'field-service', name: 'Field service', tagline: 'Routes', port: 7860, containerPort: 7860, binary: fx.binary, version: '1'})
		assert.equal(first.image, 'localhost/omarchy-published/field-service:1')
		assert.equal(first.url, 'http://field-service_web_1:7861')
		assert.equal(first.apiPort, 7861)
		assert.match(first.apiToken, /^[A-Za-z0-9_-]{20,}$/)
		assert.equal(first.updated, false)
		assert.equal(first.store, 'local:published')
		const listing = YAML.parse(await readFile(join(fx.apps.publishedStoreDir, 'field-service', 'omarchy-app.yml'), 'utf8'))
		assert.equal(listing.shared, true)
		assert.equal(listing.web.port, 7860)
		assert.deepEqual(listing.openPorts, [7861])
		assert.equal(listing.defaultPassword, first.apiToken)
		const built = YAML.parse(await readFile(join(fx.apps.publishedStoreDir, 'field-service', 'docker-compose.yml'), 'utf8'))
		assert.equal(built.services.web.image, first.image)
		assert.equal(built.services.web.pull_policy, 'never')
		assert.equal(built.services.web.environment.OMARCHY_API_TOKEN, first.apiToken)
		assert.equal(String(built.services.web.environment.CHILD_PORT), '17860')
		assert.equal(fx.containerfiles[0].includes(first.apiToken), false)
		assert.match(fx.containerfiles[0], /ENTRYPOINT \["\/usr\/local\/bin\/api-proxy"\]/)
		assert.match(fx.containerfiles[0], /omarchy-bind-localhost\.so/)
		assert.match(fx.containerfiles[0], /FROM docker.io\/archlinux:base/)
		assert.equal(fx.containerfiles[0].includes('debian'), false)
		assert.match(readFileSync(fileURLToPath(new URL('../omarchyd/omarchy-setup.sh', import.meta.url)), 'utf8'), /stable-mirror\.omarchy\.org/)
		const exports = await readFile(join(fx.apps.publishedStoreDir, 'field-service', 'exports.sh'), 'utf8')
		assert.match(exports, /APP_FIELD_SERVICE_URL=http:\/\/field-service_web_1:7861/)
		assert.match(exports, new RegExp(`APP_FIELD_SERVICE_TOKEN='${first.apiToken}'`))
		assert.match(exports, /APP_FIELD_SERVICE_LAN_PORT=7861/)
		const shown = (await fx.apps.procedures['apps.list'].run()).find((a) => a.id === 'field-service')
		assert.equal(shown.credentials.label, 'API token')
		assert.equal(shown.credentials.defaultPassword, first.apiToken)
		assert.equal(shown.apiPort, 7861)
		const reg = await fx.apps.procedures['appStore.registry'].run()
		const store = reg.find((s) => s.url === 'local:published')
		assert.equal(store.meta.name, 'Published on this server')
		assert.equal(store.apps.find((a) => a.id === 'field-service').shared, true)
		const composed = YAML.parse(await readFile(join(fx.data, 'apps/installed/field-service/compose.omarchy.yml'), 'utf8'))
		assert.equal(composed.networks.default.name, SHARED_NETWORK)
		assert.equal(composed.services.web.image, first.image)
		assert.equal(JSON.stringify(composed).includes('publish.sock'), false)
		assert.ok(composed.services.web.ports.map(String).some((p) => p.startsWith('127.0.0.1:') && p.endsWith(':7860')))
		assert.ok(composed.services.web.ports.map(String).includes('0.0.0.0:7861:7861'))
		assert.equal(composed.services.web.environment.OMARCHY_API_TOKEN, first.apiToken)
		assert.match(composed.services.web.environment.APP_GATEWAY_KEY, /^[0-9a-f]{64}$/)
		assert.equal(fx.calls.some((c) => c.cmd === 'docker-compose' && c.args.includes('pull')), false)
		assert.equal(fx.calls.filter((c) => c.cmd === 'podman' && c.args[0] === 'build').length, 1)
		await assert.rejects(publish({appId: 'field-service', name: 'Field service', port: 7862, binary: fx.binary}), /changing its port/)
		await assert.rejects(publish({appId: 'field-service', name: 'Field service', port: 7860, apiPort: 9000, binary: fx.binary}), /API port/)
		await assert.rejects(publish({appId: 'field-service', name: 'Field service', port: 7860, containerPort: 9000, binary: fx.binary}), /port inside the app/)
		await mkdir(join(fx.home, 'Projects', 'static'), {recursive: true})
		await writeFile(join(fx.home, 'Projects', 'static', 'index.html'), '<p>hi</p>')
		await mkdir(join(fx.home, 'Projects', 'static', '.git'))
		await assert.rejects(publish({appId: 'field-service', name: 'Field service', port: 7860, binary: fx.binary, assets: join(fx.home, 'Projects', 'static')}), /hidden/)
		await rm(join(fx.home, 'Projects', 'static', '.git'), {recursive: true, force: true})
		const second = await publish({appId: 'field-service', name: 'Field service', port: 7860, binary: fx.binary, assets: join(fx.home, 'Projects', 'static'), version: '2'})
		assert.equal(second.updated, true)
		assert.equal(second.apiToken, first.apiToken)
		assert.equal(second.apiPort, 7861)
		assert.equal(second.image, 'localhost/omarchy-published/field-service:2')
		assert.match(fx.containerfiles.at(-1), /COPY static \/opt\/app\/static/)
		const updated = YAML.parse(await readFile(join(fx.data, 'apps/installed/field-service/compose.omarchy.yml'), 'utf8'))
		assert.equal(updated.services.web.image, second.image)
		await fx.apps.procedures['apps.unpublish'].run({appId: 'field-service'}, owner)
		await assert.rejects(readFile(join(fx.apps.publishedStoreDir, 'field-service', 'omarchy-app.yml'), 'utf8'))
		const left = await fx.apps.procedures['apps.list'].run()
		assert.equal(left.some((a) => a.id === 'field-service'), false)
		assert.equal(fx.calls.some((c) => c.cmd === 'docker-compose' && c.args.includes('down')), true)
		const builds = fx.calls.filter((c) => c.cmd === 'podman' && c.args[0] === 'build').length
		const image = await publish({appId: 'pages', name: 'Pages', port: 8088, image: 'docker.io/library/nginx:stable'})
		assert.equal(image.image, 'docker.io/library/nginx:stable')
		assert.equal(image.url, 'http://pages_web_1:7860')
		assert.equal(image.apiToken, undefined)
		const pages = YAML.parse(await readFile(join(fx.apps.publishedStoreDir, 'pages', 'omarchy-app.yml'), 'utf8'))
		assert.equal(pages.openPorts, undefined)
		assert.equal(pages.defaultPassword, undefined)
		assert.equal(fx.calls.filter((c) => c.cmd === 'podman' && c.args[0] === 'build').length, builds)
		assert.equal(fx.calls.some((c) => c.cmd === 'docker-compose' && c.args.includes('pull')), true)
		await assert.rejects(fx.apps.procedures['apps.publish'].run({appId: 'x', name: 'X', port: 8090, image: 'nginx'}, {auth: {userId: 'member'}}), /owner/)
		const paged = await publish({appId: 'pages', name: 'Pages', port: 8088, binary: fx.binary, version: '2'})
		assert.equal(paged.updated, true)
		assert.equal(paged.url, 'http://pages_web_1:7861')
		assert.equal(paged.apiPort, 8089)
		const shownPages = (await fx.apps.procedures['apps.list'].run()).find((a) => a.id === 'pages')
		assert.equal(shownPages.credentials.label, 'API token')
		assert.equal(shownPages.credentials.defaultPassword, paged.apiToken)
		const custom = await publish({appId: 'routed', name: 'Routed', port: 39110, containerPort: 9100, binary: fx.binary, version: '1'})
		assert.equal(custom.url, 'http://routed_web_1:9101')
		assert.equal(custom.apiPort, 39111)
		const kept = await publish({appId: 'routed', name: 'Routed', port: 39110, binary: fx.binary, version: '2'})
		assert.equal(kept.url, custom.url)
		assert.equal(kept.apiPort, custom.apiPort)
		assert.equal(kept.apiToken, custom.apiToken)
		await assert.rejects(publish({appId: 'field-mcp', name: 'Field', port: 39120, apiPort: 39121, binary: fx.binary, mcp: {port: 39121, path: '/mcp', transport: 'http'}}), /MCP port/)
		const withMcp = await publish({appId: 'field-mcp', name: 'Field', port: 39120, binary: fx.binary, mcp: {port: 39121, path: '/mcp', transport: 'http'}})
		assert.equal(withMcp.apiPort, 39122)
		const mcpShown = (await fx.apps.procedures['apps.list'].run()).find((a) => a.id === 'field-mcp')
		assert.equal(mcpShown.apiPort, 39122)
	} finally {
		fx.apps.close()
		fx.restore()
		await rm(fx.root, {recursive: true, force: true})
	}
})

test('the publish token can publish and unpublish, and nothing else', async () => {
	const fx = await fixture()
	let d
	try {
		await fx.apps.ready
		const accounts = await openAccounts(fx.data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		// The token file is already on disk. Close this apps instance before the server opens the same data.
		fx.apps.close()
		d = await startOmarchyd({
			port: 0,
			dataDir: fx.data,
			home: fx.home,
			webPort: 7794,
			appOptions: {run: fx.run, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], systemApps: null, firewall: {open: async () => {}, close: async () => {}}},
		})
		const token = (await readFile(join(fx.data, 'apps/publish.token'), 'utf8')).trim()
		const call = async (path, input, bearer = token) => {
			const res = await fetch(`${d.url}/trpc/${path}`, {method: 'POST', headers: {authorization: `Bearer ${bearer}`, 'content-type': 'application/json'}, body: JSON.stringify(input ?? null)})
			const body = await res.json()
			return {status: res.status, body}
		}
		const published = await call('apps.publish', {appId: 'field-service', name: 'Field service', port: 7860, binary: fx.binary, version: '1'})
		assert.equal(published.status, 200, JSON.stringify(published.body))
		assert.equal(published.body.result.data.image, 'localhost/omarchy-published/field-service:1')
		const restart = await call('system.restart', null)
		assert.equal(restart.status, 401)
		const uninstall = await call('apps.uninstall', {appId: 'field-service'})
		assert.equal(uninstall.status, 401)
		const gone = await call('apps.unpublish', {appId: 'field-service'})
		assert.equal(gone.status, 200)
	} finally {
		fx.apps.close()
		await d?.close()
		fx.restore()
		await rm(fx.root, {recursive: true, force: true})
	}
})

function socketCall(sock, path, token, body) {
	return new Promise((resolve, reject) => {
		const req = http.request({socketPath: sock, path, method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}}, (res) => {
			const chunks = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString()}))
		})
		req.on('error', reject)
		req.end(JSON.stringify(body))
	})
}

test('a studio publishes through its socket, and that socket does nothing else', async () => {
	const fx = await fixture()
	try {
		await fx.apps.ready
		const store = join(fx.root, 'store')
		await mkdir(join(store, 'studio'), {recursive: true})
		await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
		await writeFile(join(store, 'studio/omarchy-app.yml'), 'manifestVersion: 1\nid: studio\nname: Studio\ntagline: Builds\nversion: "1"\nport: 31240\npublish: true\nweb:\n  service: web\n  port: 8080\n')
		await writeFile(join(store, 'studio/docker-compose.yml'), 'services:\n  web:\n    image: example/studio:1\n    volumes:\n      - ${DOCUMENTS_DIR}:/work\n')
		execFileSync('git', ['init', '-q', '-b', 'main'], {cwd: store})
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], {cwd: store})
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'store'], {cwd: store})
		await fx.apps.procedures['appStore.addRepository'].run({url: `file://${store}`})
		await assert.rejects(fx.apps.procedures['apps.install'].run({appId: 'studio'}), /publish/)
		await fx.apps.procedures['apps.install'].run({appId: 'studio', grant: ['publish']})
		const end = Date.now() + 5000
		let studio
		for (;;) {
			studio = (await fx.apps.procedures['apps.list'].run()).find((a) => a.id === 'studio')
			if (studio && studio.state !== 'installing') break
			if (Date.now() > end) throw new Error(`studio did not install: ${JSON.stringify(studio)}`)
			await new Promise((r) => setTimeout(r, 15))
		}
		if (studio.error) throw new Error(studio.error)
		const composed = YAML.parse(await readFile(join(fx.data, 'apps/installed/studio/compose.omarchy.yml'), 'utf8'))
		const vols = composed.services.web.volumes.map(String)
		assert.equal(vols.some((v) => v.endsWith(':/run/omarchy/publish.sock')), true)
		assert.equal(vols.some((v) => v.endsWith(':/run/omarchy/publish.token:ro')), true)
		assert.equal(vols.some((v) => v.endsWith(':/run/omarchy/publish.mounts:ro')), true)
		assert.equal(vols.some((v) => v.endsWith(':/usr/local/bin/omarchy-publish:ro')), true)
		assert.equal(vols.some((v) => /podman\.sock|docker\.sock/.test(v)), false)
		assert.equal(composed.services.web.environment.OMARCHY_PUBLISH_SOCK, '/run/omarchy/publish.sock')
		const mountsPath = join(fx.data, 'apps/installed/studio/publish.mounts')
		const mounts = await readFile(mountsPath, 'utf8')
		assert.ok(mounts.split('\n').includes(`/work\t${join(fx.home, 'Documents')}`))
		await mkdir(join(fx.home, 'Documents'), {recursive: true})
		await writeFile(join(fx.home, 'Documents', 'solver'), '#!/bin/sh\nexit 0\n', {mode: 0o755})
		const cli = fileURLToPath(new URL('../omarchyd/omarchy-publish', import.meta.url))
		const env = {...process.env, OMARCHY_PUBLISH_SOCK: fx.apps.publishSock, OMARCHY_PUBLISH_TOKEN: join(fx.data, 'apps/publish.token'), OMARCHY_PUBLISH_MOUNTS: mountsPath}
		const runCli = (args) => new Promise((resolve, reject) => {
			execFile('python3', [cli, ...args], {env, timeout: 30_000}, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(String(stdout).trim())))
		})
		const published = await runCli(['publish', '--id', 'field-service', '--name', 'Field service', '--binary', '/work/solver', '--port', '31241', '--version', '1'])
		assert.equal(published, 'published field-service localhost/omarchy-published/field-service:1 http://field-service_web_1:7861')
		const job = YAML.parse(await readFile(join(fx.apps.publishedStoreDir, 'field-service', 'omarchy-app.yml'), 'utf8'))
		assert.deepEqual(job.openPorts, [31242])
		assert.match(await readFile(join(fx.apps.publishedStoreDir, 'field-service', 'exports.sh'), 'utf8'), /APP_FIELD_SERVICE_LAN_PORT=31242/)
		const token = (await readFile(join(fx.data, 'apps/publish.token'), 'utf8')).trim()
		const refused = await socketCall(fx.apps.publishSock, '/trpc/apps.uninstall', token, {appId: 'field-service'})
		assert.equal(refused.status, 404)
		assert.equal(await runCli(['unpublish', '--id', 'field-service']), 'unpublished field-service')
	} finally {
		fx.apps.close()
		fx.restore()
		await rm(fx.root, {recursive: true, force: true})
	}
})
