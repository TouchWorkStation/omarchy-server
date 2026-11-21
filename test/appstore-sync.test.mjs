import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, readdir, realpath, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd, stdio: 'pipe'}).toString()

async function makeStore(root, name, apps) {
	const origin = join(root, `${name}.git`)
	const work = join(root, `${name}-work`)
	git(root, 'init', '-q', '--bare', '-b', 'main', origin)
	git(root, 'clone', '-q', origin, work)
	await writeFile(join(work, 'omarchy-app-store.yml'), `id: ${name}\nname: ${name}\n`)
	for (const {id, port = 31001, version = '1.0'} of apps) {
		await mkdir(join(work, id), {recursive: true})
		await writeFile(join(work, id, 'omarchy-app.yml'), `manifestVersion: 1\nid: ${id}\nname: ${id}\nversion: "${version}"\nport: ${port}\nweb:\n  service: web\n  port: 80\n`)
		await writeFile(join(work, id, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
	}
	git(work, 'add', '-A')
	git(work, 'commit', '-qm', 'init')
	git(work, 'push', '-q', 'origin', 'HEAD:main')
	return {origin, work, url: `file://${origin}`}
}

const storeFolderName = (url) => createHash('sha256').update(url).digest('hex').slice(0, 16)

test('removing a store during a refresh drops it from the registry and rejects installs from it', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'appstore-sync-')))
	t.after(() => rm(root, {recursive: true, force: true}))

	const storeA = await makeStore(root, 'store-a', [{id: 'aa', port: 31001}])
	const storeB = await makeStore(root, 'store-b', [{id: 'bb', port: 31002}])
	const data = join(root, 'data')
	const dirB = join(data, 'apps', 'stores', storeFolderName(storeB.url))

	let pauseFetchB = false
	let onBStarted
	const bStarted = new Promise((r) => (onBStarted = r))
	let releaseB
	const gateB = new Promise((r) => (releaseB = r))

	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') {
			if (pauseFetchB && args[0] === '-C' && args[1] === dirB && args[2] === 'fetch') {
				pauseFetchB = false
				onBStarted()
				await gateB
			}
			return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		}
		if (cmd === 'docker-compose' && args[0] === 'version') return 'Docker Compose version v2.30.0'
		return ''
	}

	const apps = createApps({dataDir: data, home: join(root, 'home'), allowFileStores: true, defaultStores: [], systemApps: null, run})
	t.after(() => apps.close())

	await apps.procedures['appStore.addRepository'].run({url: storeA.url})
	await apps.procedures['appStore.addRepository'].run({url: storeB.url})

	pauseFetchB = true
	const refreshing = apps.procedures['appStore.refresh'].run()
	await bStarted
	await apps.procedures['appStore.removeRepository'].run({url: storeA.url})
	releaseB()
	await refreshing

	const reg = await apps.procedures['appStore.registry'].run()
	assert.deepEqual(reg.map((s) => s.url), [storeB.url])
	await assert.rejects(apps.procedures['apps.install'].run({appId: 'aa'}), (e) => e.code === 'NOT_FOUND' && /isn’t in your stores/.test(e.message))
})

test('removing a store while its own sync is running leaves no leftover store folder', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'appstore-sync-own-')))
	t.after(() => rm(root, {recursive: true, force: true}))

	const storeA = await makeStore(root, 'store-a', [{id: 'aa', port: 31001}])
	const data = join(root, 'data')
	const hashA = storeFolderName(storeA.url)
	const dirA = join(data, 'apps', 'stores', hashA)

	let pauseCloneA = false
	let onCloneStarted
	const cloneStarted = new Promise((r) => (onCloneStarted = r))
	let releaseClone
	const gateClone = new Promise((r) => (releaseClone = r))

	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') {
			if (pauseCloneA && args[0] === 'clone' && args.includes(dirA)) {
				pauseCloneA = false
				onCloneStarted()
				await gateClone
			}
			return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		}
		return ''
	}

	const apps = createApps({dataDir: data, home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: storeA.url}], systemApps: null, run})
	t.after(() => apps.close())

	pauseCloneA = true
	const regPromise = apps.procedures['appStore.registry'].run()
	await cloneStarted
	await apps.procedures['appStore.removeRepository'].run({url: storeA.url})
	releaseClone()

	const reg = await regPromise
	assert.deepEqual(reg, [])
	const entries = await readdir(join(data, 'apps', 'stores'))
	assert.equal(entries.includes(hashA), false)
})
