// Software update: comparing versions, release notes, the check against GitHub, and the update steps.
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, test} from 'node:test'

import {compareVersions, createUpdater, releaseNotes} from '../omarchyd/updater.mjs'

let dir
before(async () => (dir = await mkdtemp(join(os.tmpdir(), 'omarchyd-u-'))))
after(() => rm(dir, {recursive: true, force: true}))

const changelog = await readFile(new URL('../web/src/changelog.ts', import.meta.url), 'utf8')
const remote = (version, extra = {}) => async (url) => {
	const path = new URL(url).pathname.split('/').slice(4).join('/')
	const files = {'package.json': JSON.stringify({version}), 'web/src/changelog.ts': changelog, 'helper/helper.mjs': 'helper v2', 'install.sh': 'for pkg in nodejs wayvnc newthing; do x; done', ...extra}
	return files[path] === undefined ? new Response('', {status: 404}) : new Response(files[path])
}

test('versions compare numerically', () => {
	assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
	assert.equal(compareVersions('0.6.1', '0.6.1'), 0)
	assert.equal(compareVersions('0.6.0', '0.6.1'), -1)
})

test('release notes list every version newer than yours', () => {
	const notes = releaseNotes(changelog, '0.5.0')
	assert.match(notes, /\*\*0\.6\.0 · Terminal, desktop and 400 apps\*\*/)
	assert.match(notes, /\*\*0\.6\.1 · Fixes\*\*\n- Fixed: Machines failed to start/)
	assert.ok(!notes.includes('**0.5.0'), 'not the one you have')
})

test('check: up to date, then an update with notes and a note to run the installer when needed', async () => {
	const helperPath = join(dir, 'helper.mjs')
	await writeFile(helperPath, 'helper v1')
	const run = async (cmd, args) => {
		if (cmd === 'pacman' && args[1] === 'newthing') throw new Error('not found')
		return ''
	}
	const same = createUpdater({autoCheck: false, appDir: dir, dataDir: dir, currentVersion: '9.9.9', run, fetchImpl: remote('9.9.9'), helperPath})
	assert.equal((await same.procedures['system.checkUpdate'].run()).available, false)
	assert.equal(same.updateWaiting(), null, 'nothing for the bell')
	const old = createUpdater({autoCheck: false, appDir: dir, dataDir: dir, currentVersion: '0.5.0', run, fetchImpl: remote('0.6.1'), helperPath})
	const c = await old.procedures['system.checkUpdate'].run()
	assert.equal(c.available, true)
	assert.equal(c.name, 'Omarchy Server 0.6.1')
	assert.match(c.releaseNotes, /run the installer.*the storage helper changed; it needs new packages \(newthing\)/)
	assert.match(c.releaseNotes, /0\.6\.1 · Fixes/)
	assert.equal(old.updateWaiting(), '0.6.1', 'the bell lights up for it')
	for (const u of [same, old]) u.stop()
	const offline = createUpdater({autoCheck: false, appDir: dir, dataDir: dir, currentVersion: '0.5.0', run, fetchImpl: async () => new Response('', {status: 503}), helperPath})
	await assert.rejects(offline.procedures['system.checkUpdate'].run(), /Couldn’t check for updates/)
})

const until = async (fn) => {
	for (let i = 0; i < 200; i++) {
		const v = await fn()
		if (v) return v
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error('timed out')
}

test('update: download, build, restart from a separate unit; after the restart it reports done', async () => {
	const calls = []
	const run = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), cmd === 'git' && args[2] === 'rev-parse' ? 'abc123\n' : '')
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.5.0', run, fetchImpl: remote('0.6.1'), helperPath: '/nonexistent'})
	await u.procedures['system.update'].run()
	await until(() => calls.some((c) => c.startsWith('systemd-run')))
	assert.deepEqual(
		calls.filter((c) => !c.startsWith('pacman')).map((c) => c.split(' ').slice(0, 4).join(' ')),
		['git -C /app rev-parse', 'git -C /app rev-parse', 'git -C /app fetch', 'git -C /app reset', `${process.execPath} scripts/deps.mjs`, 'npm run build', 'systemd-run --user --collect --on-active=2s'],
	)
	assert.match(calls.at(-1), /systemctl --user restart omarchyd\.service omarchy-server-web\.service$/)
	assert.equal((await u.procedures['system.updateStatus'].run()).progress, 95)
	// The restarted omarchyd is the new version.
	const after = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.6.1', run, fetchImpl: remote('0.6.1')})
	assert.deepEqual(await after.procedures['system.updateStatus'].run(), {running: false, progress: 100, description: 'Updated to 0.6.1', error: false})
})

test('update: a failed build puts the previous version back', async () => {
	const calls = []
	const run = async (cmd, args) => {
		calls.push([cmd, ...args].join(' '))
		if (cmd === 'git' && args[2] === 'rev-parse') return 'old111\n'
		if (cmd === 'npm' && args[1] === 'build' && !calls.some((c) => c.includes('reset --hard old111'))) throw new Error('vite: syntax error')
		return ''
	}
	const u = createUpdater({autoCheck: false, appDir: '/app', dataDir: dir, currentVersion: '0.5.0', run, fetchImpl: remote('0.6.1'), helperPath: '/nonexistent'})
	await u.procedures['system.update'].run()
	const st = await until(async () => {
		const s = await u.procedures['system.updateStatus'].run()
		return s.error ? s : null
	})
	assert.match(st.error, /failed and nothing changed: .*syntax error/)
	assert.ok(calls.includes('git -C /app reset --hard old111'))
	assert.ok(!calls.some((c) => c.startsWith('systemd-run')))
})
