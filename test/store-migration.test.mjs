// Servers set up before 0.8.8 had the Umbrel store added; it is removed once, and installed apps stay.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'

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
