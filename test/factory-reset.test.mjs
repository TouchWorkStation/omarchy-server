// Factory reset promises a first-time server. The next owner must not inherit the previous
// owner's assistant keys, chats, swarm computers, NAS password, or share password.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createConversations} from '../omarchyd/assistant/conversations.mjs'
import {createKeyStore} from '../omarchyd/assistant/keys.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const exists = (p) => readFile(p).then(() => true, () => false)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('factory reset drops keys, chats, swarm computers, backup secrets and shares', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-reset-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	await mkdir(join(home, 'Documents'), {recursive: true})
	const accounts = await openAccounts(data)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	await mkdir(join(data, 'assistant/conversations'), {recursive: true})
	await writeFile(join(data, 'assistant/keys.json'), JSON.stringify({
		keys: [{
			id: 'k_abcdef123456', ownerUserId: 'owner', name: 'Grok', provider: 'spacexai',
			baseUrl: 'https://api.x.ai/v1', model: 'grok', apiKey: 'sk-secret-9999', last4: '9999',
			sharedWith: [], systemDefault: false, createdAt: 1, updatedAt: 1,
		}],
	}))
	await writeFile(join(data, 'assistant/conversations/c_abcdef123456.json'), JSON.stringify({
		userId: 'owner', title: 'Private chat', messages: [{role: 'user', content: 'secret chat'}], actions: [],
	}))
	await writeFile(join(data, 'swarm.json'), JSON.stringify({
		agents: [{id: 'computer-1', name: 'nixnet', keyHash: 'enrolled-key', allowed: {terminal: true}, on: {terminal: true}, enrolledAt: 1}],
	}))
	await mkdir(join(data, 'backups/computers'), {recursive: true})
	await writeFile(join(data, 'backups/config.json'), JSON.stringify({nas: {host: 'nas.home', share: 'backups', username: 'chris'}}))
	await writeFile(join(data, 'backups/secrets.json'), JSON.stringify({nasPassword: 'nas-secret'}))
	await writeFile(join(data, 'backups/recovery-key'), 'restic-recovery-secret\n')
	await writeFile(join(data, 'backups/history.json'), '[{"id":"keep-history"}]')
	await writeFile(join(data, 'backups/computers/abc.key'), 'computer-restic-password\n')
	await writeFile(join(data, 'backups/computers/notes.txt'), 'keep-me\n')
	await writeFile(join(data, 'backups/smb-auth-test'), 'password=nas-password-file\n')
	await writeFile(join(data, 'backups/keep.txt'), 'not a secret\n')
	await writeFile(join(data, 'shares.json'), JSON.stringify([{name: 'Docs', path: '/Home/Documents'}]))
	await writeFile(join(data, 'share-password'), 'share-secret')
	await mkdir(join(data, 'clips', 'owner'), {recursive: true})
	await writeFile(join(data, 'clips', 'owner', 'book.json'), JSON.stringify({secret: 'clip-book-secret'}))
	await writeFile(join(data, 'clips', 'owner', 'deadbeef.blob'), 'clip-secret-bytes')
	const d = await startOmarchyd({
		port: 0, dataDir: data, home,
		updaterOptions: {autoCheck: false},
		appOptions: {systemApps: null, run: async () => ''},
		machineOptions: {run: async () => ''},
		backupOptions: {timers: false, unshare: false},
	})
	try {
		const call = async (kind, path, input, headers = {}) => {
			const url = new URL(`${d.url}/trpc/${path}`)
			const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...headers}}
			if (kind === 'mutation') {
				init.headers['content-type'] = 'application/json'
				init.body = JSON.stringify(input ?? null)
			}
			const r = await fetch(url, init)
			return {status: r.status, body: await r.json()}
		}
		const login = await call('mutation', 'user.loginNative', {userId: 'owner', password: 'correct horse', client: {id: 't'}})
		const owner = {authorization: `Bearer ${login.body.result.data.accessToken}`}
		const listed = await call('query', 'assistant.keys', undefined, owner)
		assert.equal(listed.body.result.data[0].last4, '9999')
		const reset = await call('mutation', 'system.factoryReset', {password: 'correct horse'}, owner)
		assert.equal(reset.body.result.data, true)
		let users = []
		for (let i = 0; i < 50; i++) {
			users = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8')).users
			if (users.length === 0) break
			await sleep(100)
		}
		assert.equal(users.length, 0, 'accounts are cleared')
		await sleep(300)
		assert.equal(await exists(join(data, 'assistant/keys.json')), false, 'the API key file is gone')
		assert.equal(await exists(join(data, 'assistant/conversations/c_abcdef123456.json')), false, 'the chat is gone')
		const swarm = JSON.parse(await readFile(join(data, 'swarm.json'), 'utf8'))
		assert.deepEqual(swarm.agents, [], 'the enrolled computer is gone')
		assert.equal(JSON.stringify(swarm).includes('enrolled-key'), false)
		assert.equal(await exists(join(data, 'backups/secrets.json')), false, 'the NAS password is gone')
		assert.equal(await exists(join(data, 'backups/config.json')), false, 'the NAS address is gone')
		assert.equal(await exists(join(data, 'backups/recovery-key')), false, 'the recovery key is gone')
		assert.equal(await exists(join(data, 'backups/computers/abc.key')), false, 'the computer restic key is gone')
		assert.equal(await exists(join(data, 'backups/smb-auth-test')), false, 'the NAS auth file is gone')
		assert.equal(await readFile(join(data, 'backups/computers/notes.txt'), 'utf8'), 'keep-me\n', 'a normal file beside the computer key stays')
		assert.equal(await readFile(join(data, 'backups/keep.txt'), 'utf8'), 'not a secret\n', 'a normal file beside the NAS auth file stays')
		assert.equal(await exists(join(data, 'backups/history.json')), false, 'backup history is gone')
		assert.equal(await exists(join(data, 'share-password')), false, 'the share password is gone')
		assert.equal(await exists(join(data, 'shares.json')), false, 'the share list is gone')
		const clipsGone = await stat(join(data, 'clips')).then(() => false, (e) => e.code === 'ENOENT')
		assert.equal(clipsGone, true, 'the clip book is gone')
	} finally {
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

// Pause writeAtomic while it is inside writeFile of the temp path, so reset runs before rename.
function pauseAssistantTemps() {
	const orig = fs.promises.writeFile
	let waiting = []
	let paused = 0
	let hold = true
	const match = (p) => p.endsWith('.tmp') && (p.includes('/assistant/keys.json.') || p.includes('/assistant/conversations/'))
	fs.promises.writeFile = async (p, data, opts) => {
		if (hold && match(String(p))) {
			paused++
			await new Promise((resolve) => waiting.push(resolve))
		}
		return orig(p, data, opts)
	}
	syncBuiltinESMExports()
	return {
		get paused() {
			return paused
		},
		release() {
			hold = false
			const left = waiting
			waiting = []
			for (const resolve of left) resolve()
		},
		restore() {
			hold = false
			const left = waiting
			waiting = []
			for (const resolve of left) resolve()
			fs.promises.writeFile = orig
			syncBuiltinESMExports()
		},
	}
}

test('a key or chat write already in flight does not come back after reset', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-reset-race-'))
	const data = join(root, 'data')
	await mkdir(data, {recursive: true})
	const keys = createKeyStore({dataDir: data})
	const conversations = createConversations({dataDir: data})
	const gate = pauseAssistantTemps()
	const keyFile = join(data, 'assistant/keys.json')
	const convDir = join(data, 'assistant/conversations')
	try {
		const keyWrite = keys.add({userId: 'owner', role: 'owner'}, {provider: 'openai', apiKey: 'sk-inflight-secret', model: 'm', name: 'K'})
		const chatWrite = conversations.create('owner', {title: 'secret-chat-inflight'})
		const blocked = Date.now() + 2000
		while (gate.paused < 2 && Date.now() < blocked) await sleep(10)
		assert.equal(gate.paused >= 2, true, 'the key and chat writes are blocked inside the queue')
		const resets = Promise.all([keys.reset(), conversations.reset()])
		// Give a reset that unlinks outside the queue time to finish while the write is still blocked.
		await Promise.race([resets.then(() => {}), sleep(300)])
		gate.release()
		await resets
		await Promise.allSettled([keyWrite, chatWrite])
		const keyText = await readFile(keyFile, 'utf8').catch(() => '')
		assert.equal(keyText.includes('sk-inflight-secret'), false, 'in-flight key write restored the secret')
		assert.equal(await exists(keyFile), false, 'keys.json is absent after the queued write settles')
		const names = (await readdir(convDir).catch(() => [])).filter((n) => n.endsWith('.json'))
		assert.deepEqual(names, [], 'the chat json is absent after the queued write settles')
	} finally {
		gate.restore()
		await rm(root, {recursive: true, force: true})
	}
})

test('factory reset drops a key and a chat whose writes are still in flight', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-reset-live-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	await mkdir(join(home, 'Documents'), {recursive: true})
	const accounts = await openAccounts(data)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	await mkdir(join(data, 'assistant'), {recursive: true})
	await writeFile(join(data, 'assistant/keys.json'), JSON.stringify({
		keys: [{
			id: 'k_abcdef123456', ownerUserId: 'owner', name: 'Grok', provider: 'openai',
			baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-old', last4: 'k-old',
			sharedWith: [], systemDefault: false, createdAt: 1, updatedAt: 1,
		}],
	}))
	const fetchImpl = async () => ({ok: false, status: 401, headers: new Headers(), text: async () => '{"error":{"message":"no"}}'})
	const d = await startOmarchyd({
		port: 0, dataDir: data, home,
		updaterOptions: {autoCheck: false},
		appOptions: {systemApps: null, run: async () => ''},
		machineOptions: {run: async () => ''},
		backupOptions: {timers: false, unshare: false},
		assistantOptions: {fetchImpl},
	})
	const gate = pauseAssistantTemps()
	const keyFile = join(data, 'assistant/keys.json')
	const convDir = join(data, 'assistant/conversations')
	try {
		const call = async (kind, path, input, headers = {}) => {
			const url = new URL(`${d.url}/trpc/${path}`)
			const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...headers}}
			if (kind === 'mutation') {
				init.headers['content-type'] = 'application/json'
				init.body = JSON.stringify(input ?? null)
			}
			const r = await fetch(url, init)
			return {status: r.status, body: await r.json()}
		}
		const login = await call('mutation', 'user.loginNative', {userId: 'owner', password: 'correct horse', client: {id: 't'}})
		const owner = {authorization: `Bearer ${login.body.result.data.accessToken}`}
		const keyWrite = call('mutation', 'assistant.updateKey', {id: 'k_abcdef123456', apiKey: 'sk-inflight-secret'}, owner)
		const chatWrite = fetch(`${d.url}/assistant/stream`, {
			method: 'POST',
			headers: {...owner, 'content-type': 'application/json'},
			body: JSON.stringify({message: 'secret-chat-inflight', keyId: 'k_abcdef123456'}),
		})
		const blocked = Date.now() + 3000
		while (gate.paused < 2 && Date.now() < blocked) await sleep(10)
		assert.equal(gate.paused >= 2, true, 'the key and chat writes are blocked inside the queue')
		const reset = await call('mutation', 'system.factoryReset', {password: 'correct horse'}, owner)
		assert.equal(reset.body.result.data, true)
		const until = Date.now() + 2500
		while (Date.now() < until) {
			const text = await readFile(join(data, 'accounts.json'), 'utf8').catch(() => '')
			if (text && JSON.parse(text).users.length === 0) break
			await sleep(20)
		}
		gate.release()
		for (let i = 0; i < 50; i++) {
			const text = await readFile(join(data, 'accounts.json'), 'utf8').catch(() => '')
			if (text && JSON.parse(text).users.length === 0) break
			await sleep(100)
		}
		await Promise.allSettled([keyWrite, chatWrite.then((r) => r.text())])
		await sleep(50)
		const keyText = await readFile(keyFile, 'utf8').catch(() => '')
		assert.equal(keyText.includes('sk-inflight-secret'), false, 'in-flight key write restored the secret')
		assert.equal(await exists(keyFile), false, 'keys.json is absent after factory reset')
		const chats = (await readdir(convDir).catch(() => [])).filter((n) => n.endsWith('.json'))
		for (const name of chats) {
			const text = await readFile(join(convDir, name), 'utf8')
			assert.equal(text.includes('secret-chat-inflight'), false, 'in-flight chat write restored the secret')
		}
		assert.deepEqual(chats, [], 'the chat json is absent after factory reset')
	} finally {
		gate.restore()
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

const capture = () => {
	const notes = []
	const origErr = console.error
	const origLog = console.log
	const line = (parts) => parts.map((part) => (part instanceof Error ? part.message : String(part))).join(' ')
	console.error = (...parts) => notes.push(line(parts))
	console.log = (...parts) => notes.push(line(parts))
	return {
		notes,
		restore() {
			console.error = origErr
			console.log = origLog
		},
	}
}

async function resetServer(rootName, {app} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), rootName))
	const home = join(root, 'home')
	const data = join(root, 'data')
	await mkdir(join(home, 'Documents'), {recursive: true})
	const accounts = await openAccounts(data)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const run = async (cmd) => {
		if (app && cmd === 'docker-compose') throw new Error('compose down refused')
		return ''
	}
	if (app) {
		await mkdir(join(data, 'apps/installed', app.id), {recursive: true})
		await writeFile(join(data, 'apps/installed', app.id, 'compose.omarchy.yml'), 'services: {}\n')
		await writeFile(join(data, 'apps/apps.json'), JSON.stringify({
			stores: [],
			apps: [app],
			recent: [],
			defaultsAdded: true,
			umbrelStoreRemoved: true,
			permissionsVersion: 2,
		}))
	}
	const d = await startOmarchyd({
		port: 0, dataDir: data, home,
		updaterOptions: {autoCheck: false},
		appOptions: {systemApps: null, run, defaultStores: []},
		machineOptions: {run: async () => ''},
		backupOptions: {timers: false, unshare: false},
	})
	const call = async (kind, path, input, headers = {}) => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...headers}}
		if (kind === 'mutation') {
			init.headers['content-type'] = 'application/json'
			init.body = JSON.stringify(input ?? null)
		}
		const r = await fetch(url, init)
		return {status: r.status, body: await r.json()}
	}
	const login = await call('mutation', 'user.loginNative', {userId: 'owner', password: 'correct horse', client: {id: 't'}})
	const owner = {authorization: `Bearer ${login.body.result.data.accessToken}`}
	return {root, data, d, call, owner}
}

test('factory reset still clears accounts when every app uninstalls', async () => {
	const {root, data, d, call, owner} = await resetServer('omarchyd-reset-clear-')
	const logs = capture()
	try {
		const reset = await call('mutation', 'system.factoryReset', {password: 'correct horse'}, owner)
		assert.equal(reset.body.result.data, true)
		let users = [{userId: 'owner'}]
		const until = Date.now() + 3000
		while (Date.now() < until) {
			users = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8')).users
			if (users.length === 0 && logs.notes.some((l) => l.includes('factory reset done'))) break
			await sleep(50)
		}
		assert.equal(users.length, 0, 'accounts are cleared when uninstallAll returns 0')
		assert.equal(logs.notes.some((l) => l.includes('factory reset done')), true)
	} finally {
		logs.restore()
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

test('factory reset does not wipe accounts when an app stays installed', async () => {
	const app = {id: 'stuck', name: 'Stuck', state: 'error'}
	const {root, data, d, call, owner} = await resetServer('omarchyd-reset-stuck-', {app})
	const logs = capture()
	try {
		await mkdir(join(data, 'clips', 'owner'), {recursive: true})
		await writeFile(join(data, 'clips', 'owner', 'book.json'), JSON.stringify({secret: 'clip-book-secret'}))
		const reset = await call('mutation', 'system.factoryReset', {password: 'correct horse'}, owner)
		assert.equal(reset.body.result.data, true)
		const until = Date.now() + 3000
		while (Date.now() < until) {
			if (logs.notes.some((l) => /app remains|apps remain/.test(l))) break
			const users = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8')).users
			if (users.length === 0) break
			await sleep(50)
		}
		await sleep(400)
		const users = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8')).users
		assert.equal(users.length, 1, 'accounts stay when an app remains')
		assert.equal(users[0].name, 'Chris')
		const saved = JSON.parse(await readFile(join(data, 'apps/apps.json'), 'utf8'))
		assert.equal(saved.apps.length, 1)
		assert.equal(saved.apps[0].id, 'stuck')
		assert.match(logs.notes.join('\n'), /1 app remains/)
		assert.equal(logs.notes.some((l) => l.includes('factory reset done')), false)
		let clipsGone = false
		for (let i = 0; i < 40 && !clipsGone; i++) {
			clipsGone = await stat(join(data, 'clips')).then(() => false, (e) => e.code === 'ENOENT')
			if (!clipsGone) await sleep(50)
		}
		assert.equal(clipsGone, true, 'clips are removed even when an account stays')
	} finally {
		logs.restore()
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

// Factory reset does not exit. The same key store and conversation store must accept the next owner's writes.
test('the next owner can save a key and a chat after factory reset', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-reset-again-'))
	const data = join(root, 'data')
	await mkdir(data, {recursive: true})
	const keys = createKeyStore({dataDir: data})
	const conversations = createConversations({dataDir: data})
	const keyFile = join(data, 'assistant/keys.json')
	const convDir = join(data, 'assistant/conversations')
	try {
		await keys.add({userId: 'owner', role: 'owner'}, {provider: 'openai', apiKey: 'sk-old-secret', model: 'm', name: 'Old'})
		const oldChat = await conversations.create('owner', {title: 'old-chat'})
		await keys.reset()
		await keys.add({userId: 'owner', role: 'owner'}, {provider: 'openai', apiKey: 'sk-new-secret', model: 'm', name: 'New'})
		assert.equal(await exists(keyFile), true, 'keys.json exists after the next save')
		const keyText = await readFile(keyFile, 'utf8')
		assert.equal(keyText.includes('sk-new-secret'), true, 'the new secret is saved')
		assert.equal(keyText.includes('sk-old-secret'), false, 'the old secret is not restored')
		await conversations.reset()
		const created = await conversations.create('owner', {title: 'next-chat'})
		assert.notEqual(created.id, oldChat.id)
		const chatFile = join(convDir, `${created.id}.json`)
		assert.equal(await exists(chatFile), true, 'a conversation json exists after reset')
		const chatText = await readFile(chatFile, 'utf8')
		assert.equal(chatText.includes('next-chat'), true, 'the new chat is saved')
		assert.equal(chatText.includes('old-chat'), false, 'the old chat is not restored')
		assert.equal(await exists(join(convDir, `${oldChat.id}.json`)), false, 'the old chat file stays gone')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
