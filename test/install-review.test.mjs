import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {folderAllowed} from '../omarchyd/apps.mjs'
import {cardAction} from '../web/src/assistant.ts'
import {folderPathOk, installNeedsReview, reviewInstallInput} from '../web/src/installReview.ts'

const home = '/home/chris'
const perm = (id) => ({id, label: id, detail: '', what: [], appId: 'jellyfin', appName: 'Jellyfin'})

test('a plain install needs no review', () => {
	assert.equal(installNeedsReview(null), false)
	assert.equal(installNeedsReview({requiredFolders: [], gpuAccess: false, alsoInstalls: [{id: 'dep', name: 'Dep'}]}), false)
	assert.equal(installNeedsReview({requiredFolders: [], gpuAccess: false, permissions: [perm('containers')]}), true)
	assert.equal(installNeedsReview({requiredFolders: [], gpuAccess: false, setup: [{appId: 'tailscale', appName: 'Tailscale', command: 'x'}]}), true)
	assert.equal(installNeedsReview({requiredFolders: [], gpuAccess: false, folders: [{appId: 'jellyfin', appName: 'Jellyfin', id: 'media', label: 'Media', detail: '', suggest: null}]}), true)
})

test('the install button sends the access the person allowed', () => {
	const review = {requiredFolders: [], gpuAccess: false, permissions: [perm('containers'), perm('devices')], home}
	assert.equal(reviewInstallInput(review, false, {}), null)
	assert.deepEqual(reviewInstallInput(review, true, {}), {grant: ['containers', 'devices']})
	assert.equal(reviewInstallInput({...review, permissions: [perm('refused')]}, true, {}), null)
	assert.equal(reviewInstallInput({requiredFolders: [], gpuAccess: false, setup: [{appId: 'tailscale', appName: 'Tailscale', command: 'x'}], home}, true, {}), null)
})

test('a folder stays inside the app unless the person picks one in their home', () => {
	const folder = {appId: 'jellyfin', appName: 'Jellyfin', id: 'media', label: 'Media', detail: '', suggest: `${home}/Videos`}
	const review = {requiredFolders: [], gpuAccess: false, folders: [folder], home}
	assert.deepEqual(reviewInstallInput(review, true, {}), {})
	assert.deepEqual(reviewInstallInput(review, true, {'jellyfin/media': `${home}/Videos`}), {folders: [{appId: 'jellyfin', id: 'media', path: `${home}/Videos`}]})
	assert.equal(reviewInstallInput(review, true, {'jellyfin/media': `${home}/.ssh`}), null)
})

test('an install card keeps the app id and drops grant', () => {
	const card = cardAction({
		id: 'a',
		status: 'pending',
		kind: 'rpc',
		toolName: 'apps_install',
		title: 'Install Jellyfin',
		detail: '',
		rpc: {path: 'apps.install', input: {appId: 'jellyfin', grant: ['containers']}},
	})
	assert.equal(card.appId, 'jellyfin')
	assert.equal(JSON.stringify(card).includes('grant'), false)
	assert.equal(JSON.stringify(card).includes('containers'), false)
})

test('an install card keeps the app id when the card is read twice', () => {
	const once = cardAction({
		id: 'a',
		status: 'pending',
		kind: 'rpc',
		toolName: 'apps_install',
		title: 'Install Jellyfin',
		detail: '',
		rpc: {path: 'apps.install', input: {appId: 'jellyfin'}},
	})
	const twice = cardAction(once)
	assert.equal(twice.appId, 'jellyfin')
})

test('the assistant reuses the store review and cancel rejects the install', async () => {
	const assistant = await readFile(new URL('../web/src/screens/Assistant.tsx', import.meta.url), 'utf8')
	const store = await readFile(new URL('../web/src/screens/Store.tsx', import.meta.url), 'utf8')
	const review = await readFile(new URL('../web/src/beforeInstall.tsx', import.meta.url), 'utf8')
	assert.match(assistant, /BeforeInstall/)
	assert.match(assistant, /installNeedsReview/)
	assert.match(assistant, /setInstallGate\(null\)[\s\S]*assistant\.reject/)
	assert.match(store, /<BeforeInstall/)
	assert.match(review, /I understand\. Allow this/)
	assert.doesNotMatch(store, /I understand\. Allow this/)
})

test('folderPathOk rejects home itself, double slashes, and dot segments while allowing dots inside names', () => {
	assert.equal(folderPathOk(null, home), true)
	assert.equal(folderPathOk(undefined, home), true)
	const cases = [
		['/home/chris', false],
		['/home/chris/', false],
		['/home/chris///', false],
		['/home/chris//media', false],
		['/home/chris/Media/', true],
		['/home/chris/my..folder', true],
		['/home/chris/..', false],
		['/home/chris/a/../b', false],
		['/home/chris/.', false],
		['/home/chris/.ssh', false],
		['/home/chris/a/.git', false],
		['/etc', false],
		['', false],
		['   ', false],
	]
	for (const [p, expected] of cases) {
		assert.equal(folderPathOk(p, home), expected, p)
		assert.equal(folderAllowed(p, home), expected, `folderAllowed(${p})`)
	}
	const folder = {appId: 'jellyfin', appName: 'Jellyfin', id: 'media', label: 'Media', detail: '', suggest: null}
	const review = {requiredFolders: [], gpuAccess: false, folders: [folder], home}
	assert.equal(reviewInstallInput(review, true, {'jellyfin/media': '/home/chris/'}), null)
	assert.equal(reviewInstallInput(review, true, {'jellyfin/media': '/home/chris//media'}), null)
	assert.deepEqual(reviewInstallInput(review, true, {'jellyfin/media': '/home/chris/my..folder'}), {folders: [{appId: 'jellyfin', id: 'media', path: '/home/chris/my..folder'}]})
})

test('store install review stays open until the install request succeeds', async () => {
	const store = await readFile(new URL('../web/src/screens/Store.tsx', import.meta.url), 'utf8')
	const block = store.match(/<BeforeInstall[\s\S]*?\/>/)?.[0] ?? ''
	assert.match(block, /onSuccess:\s*\(\)\s*=>\s*setReviewing\(false\)/)
})
