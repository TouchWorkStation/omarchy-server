// Servers set up before 0.8.8 had the Umbrel store added; it is removed once, and installed apps stay.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {createApps, DEFAULT_STORES} from '../omarchyd/apps.mjs'

const root = await mkdtemp(join(os.tmpdir(), 'store-migration-'))
after(() => rm(root, {recursive: true, force: true}))

test('the Umbrel store is removed once; TouchWorkStation stays; installed apps are kept', async () => {
	const data = join(root, 'data')
	await mkdir(join(data, 'apps'), {recursive: true})
	const tws = 'https://github.com/TouchWorkStation/app-store'
	await writeFile(join(data, 'apps', 'apps.json'), JSON.stringify({defaultsAdded: true, stores: [{url: tws}, {url: 'https://github.com/getumbrel/umbrel-apps', name: 'Popular apps'}], apps: [{id: 'home-assistant', port: 8123, state: 'error'}]}))
	const apps = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: [{url: tws}]})
	await apps.ready
	const saved = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
	assert.deepEqual(saved.stores.map((s) => s.url), [tws])
	assert.deepEqual(saved.apps.map((a) => a.id), ['home-assistant'])
	assert.equal(saved.umbrelStoreRemoved, true)
	apps.close()
})

test('the GitHub store is replaced by a local clone when that is the default', async () => {
	const data = join(root, 'local-data')
	await mkdir(join(data, 'apps'), {recursive: true})
	const github = 'https://github.com/TouchWorkStation/app-store'
	const local = `file://${join(root, 'app-store')}`
	await writeFile(join(data, 'apps', 'apps.json'), JSON.stringify({defaultsAdded: true, umbrelStoreRemoved: true, stores: [{url: github}], apps: [{id: 'jellyfin', store: github}]}))
	const apps = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: [{url: local}]})
	await apps.ready
	const saved = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
	assert.deepEqual(saved.stores.map((s) => s.url), [local])
	assert.equal(saved.apps[0].store, local)
	apps.close()
})

test('a local default store does not let members add a different file:// store', async () => {
	const data = join(root, 'tight-data')
	await mkdir(join(data, 'apps'), {recursive: true})
	const local = `file://${join(root, 'app-store')}`
	const apps = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: [{url: local}]})
	await apps.ready
	await assert.rejects(apps.procedures['appStore.addRepository'].run({url: `file://${join(root, 'other-store')}`}), /https:\/\//)
	apps.close()
})

test('apps installed before the wider access checks keep their access, so they still run and update', async () => {
	const data = join(root, 'data2')
	await mkdir(join(data, 'apps', 'installed', 'home-assistant'), {recursive: true})
	await writeFile(join(data, 'apps', 'installed', 'home-assistant', 'compose.omarchy.yml'), 'services:\n  web:\n    image: x\n    network_mode: host\n    volumes:\n      - /run/dbus:/run/dbus:ro\n')
	await writeFile(join(data, 'apps', 'apps.json'), JSON.stringify({defaultsAdded: true, umbrelStoreRemoved: true, stores: [], apps: [{id: 'home-assistant', port: 8123, state: 'error', permissions: []}]}))
	const apps = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: []})
	await apps.ready
	const saved = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
	assert.deepEqual(saved.apps[0].permissions.sort(), ['host-network', 'system'])
	assert.equal(saved.permissionsVersion, 2)
	apps.close()
})

test('removing a local store puts the default GitHub store back', async (t) => {
	const data = join(root, 'restore-gh-data')
	await mkdir(join(data, 'apps'), {recursive: true})
	const local = `file://${join(root, 'app-store')}`
	const first = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: [{url: local}]})
	await first.ready
	first.close()

	const savedBefore = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
	savedBefore.apps = [{id: 'jellyfin', store: local}]
	await writeFile(join(data, 'apps', 'apps.json'), JSON.stringify(savedBefore))

	const second = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: DEFAULT_STORES})
	t.after(() => second.close())
	await second.ready

	const repos = await second.procedures['appStore.repositories'].run()
	assert.deepEqual(repos.map((r) => r.url), [DEFAULT_STORES[0].url])
	const savedAfter = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
	assert.deepEqual(savedAfter.stores.map((s) => s.url), [DEFAULT_STORES[0].url])
	assert.equal(savedAfter.stores[0].localDefault, undefined)
	assert.equal(savedAfter.apps[0].store, DEFAULT_STORES[0].url)
})

test('migrates a legacy local-store entry back to GitHub while keeping extra community stores', async (t) => {
	const data = join(root, 'restore-gh-legacy')
	await mkdir(join(data, 'apps'), {recursive: true})
	const local = `file://${join(root, 'app-store')}`
	const extra = 'https://github.com/example/extra-store'
	await writeFile(
		join(data, 'apps', 'apps.json'),
		JSON.stringify({
			defaultsAdded: true,
			umbrelStoreRemoved: true,
			stores: [{url: local}, {url: extra}],
			apps: [{id: 'jellyfin', store: local}],
		}),
	)

	const apps = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: DEFAULT_STORES})
	t.after(() => apps.close())
	await apps.ready

	const saved = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
	assert.deepEqual(saved.stores.map((s) => s.url), [DEFAULT_STORES[0].url, extra])
	assert.equal(saved.apps[0].store, DEFAULT_STORES[0].url)
})

test('appStore.repositories marks a local default store as replacing TouchWorkStation, not manual file stores', async (t) => {
	const dataLocal = join(root, 'repos-local')
	await mkdir(join(dataLocal, 'apps'), {recursive: true})
	const local = `file://${join(root, 'app-store')}`
	const localApps = createApps({dataDir: dataLocal, home: join(root, 'home'), run: async () => '', defaultStores: [{url: local}]})
	t.after(() => localApps.close())
	const localRepos = await localApps.procedures['appStore.repositories'].run()
	assert.equal(localRepos[0].replaces, DEFAULT_STORES[0].url)

	const dataManual = join(root, 'repos-manual')
	await mkdir(join(dataManual, 'apps'), {recursive: true})
	await writeFile(
		join(dataManual, 'apps', 'apps.json'),
		JSON.stringify({defaultsAdded: true, umbrelStoreRemoved: true, stores: [{url: local, meta: {id: 'local', name: 'Local'}}], apps: []}),
	)
	const manualApps = createApps({dataDir: dataManual, home: join(root, 'home'), allowFileStores: true, run: async () => '', defaultStores: []})
	t.after(() => manualApps.close())
	const manualRepos = await manualApps.procedures['appStore.repositories'].run()
	assert.equal('replaces' in manualRepos[0], false)
})
