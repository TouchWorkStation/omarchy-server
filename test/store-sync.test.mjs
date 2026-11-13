import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createApps} from '../omarchyd/apps.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd, stdio: 'pipe'}).toString()
async function addApp(work, id) {
	await mkdir(join(work, id), {recursive: true})
	await writeFile(join(work, id, 'omarchy-app.yml'), `manifestVersion: 1\nid: ${id}\nname: ${id}\ntagline: t\ncategory: files\nport: 9${id.length}00\nweb:\n  service: web\n  port: 80\n`)
	await writeFile(join(work, id, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
}

test('a store that gained apps since it was first downloaded shows them (shallow clones can’t fast-forward)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'store-sync-'))
	try {
		const origin = join(root, 'origin.git'), work = join(root, 'work')
		git(root, 'init', '-q', '--bare', '-b', 'main', origin)
		git(root, 'clone', '-q', origin, work)
		await addApp(work, 'one')
		git(work, 'add', '-A'); git(work, 'commit', '-qm', 'one'); git(work, 'push', '-q', 'origin', 'HEAD:main')
		const run = async (cmd, args, o = {}) => (cmd === 'git' ? execFileSync('git', args, {cwd: o.cwd, stdio: 'pipe'}).toString() : '')
		const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: `file://${origin}`}], run})
		const ids = async () => (await apps.procedures['appStore.registry'].run())[0].apps.map((a) => a.id).sort()
		assert.deepEqual(await ids(), ['one'])
		for (const id of ['two', 'three']) {
			await addApp(work, id)
			git(work, 'add', '-A'); git(work, 'commit', '-qm', id); git(work, 'push', '-q', 'origin', 'HEAD:main')
		}
		const again = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: `file://${origin}`}], run})
		// The next sync (over an hour later) takes the store's latest commit.
		const stateFile = join(root, 'data', 'apps', 'apps.json')
		const {readFile} = await import('node:fs/promises')
		const st = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}'))
		for (const s of st.stores ?? []) s.syncedAt = 0
		if (st.stores) await writeFile(stateFile, JSON.stringify(st))
		assert.deepEqual((await again.procedures['appStore.registry'].run())[0].apps.map((a) => a.id).sort(), ['one', 'three', 'two'])
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
