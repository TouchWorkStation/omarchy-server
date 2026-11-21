// Files: every path stays inside Home or the Trash, symlinks included; trash and restore round-trip.
import assert from 'node:assert/strict'
import {chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

let root, home, outside, files
const call = (name, input) => files.procedures[name].run(input)
before(async () => {
	root = await realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-files-')))
	home = join(root, 'home')
	outside = join(root, 'outside')
	await mkdir(join(home, 'Documents'), {recursive: true})
	await mkdir(outside, {recursive: true})
	await writeFile(join(home, 'Documents', 'notes.txt'), 'hello')
	await writeFile(join(outside, 'secret.txt'), 'not yours')
	await symlink(outside, join(home, 'escape')) // a folder link pointing out of Home
	await symlink(join(outside, 'secret.txt'), join(home, 'secret-link.txt'))
	await mkdir(join(root, 'data'))
	files = createFiles({home, dataDir: join(root, 'data')})
})
after(() => rm(root, {recursive: true, force: true}))

describe('files: paths', () => {
	test('lists Home', async () => {
		const l = await call('files.list', {path: '/Home/Documents'})
		assert.deepEqual(l.files.map((f) => f.name), ['notes.txt'])
	})

	test('refuses ../, ./, NUL, relative paths and unknown roots', async () => {
		for (const bad of ['/Home/../etc', '/Home/Documents/../../outside', '/Home/./Documents', '/Home/a\0b', 'Home/Documents', '/etc', '/', '']) {
			await assert.rejects(files.resolve(bad), (e) => ['BAD_REQUEST', 'NOT_FOUND'].includes(e.code), bad)
		}
	})

	test('symlinks can’t lead out of Home: not to list, read, write or make folders', async () => {
		await assert.rejects(call('files.list', {path: '/Home/escape'}), (e) => e.code === 'FORBIDDEN')
		await assert.rejects(files.resolve('/Home/secret-link.txt'), (e) => e.code === 'FORBIDDEN')
		await assert.rejects(call('files.createDirectory', {path: '/Home/escape/new'}), (e) => e.code === 'FORBIDDEN')
		await assert.rejects(call('files.copy', {path: '/Home/Documents/notes.txt', toDirectory: '/Home/escape'}), (e) => e.code === 'FORBIDDEN')
		assert.deepEqual(await readdir(outside), ['secret.txt'], 'nothing written outside Home')
	})

	test('names can’t contain a slash or be . or ..', async () => {
		for (const bad of ['a/b', '..', '.', '', 'x'.repeat(256)]) await assert.rejects(call('files.rename', {path: '/Home/Documents/notes.txt', newName: bad}), (e) => e.code === 'BAD_REQUEST', bad)
		await assert.rejects(call('files.createDirectory', {path: '/Home/..'}), (e) => e.code === 'BAD_REQUEST')
	})

	test("replace into the item's own folder leaves the item in place", async () => {
		const copied = await call('files.copy', {path: '/Home/Documents/notes.txt', toDirectory: '/Home/Documents', collision: 'replace'})
		assert.equal(copied, '/Home/Documents/notes.txt')
		assert.equal(await readFile(join(home, 'Documents', 'notes.txt'), 'utf8'), 'hello')
		const moved = await call('files.move', {path: '/Home/Documents/notes.txt', toDirectory: '/Home/Documents', collision: 'replace'})
		assert.equal(moved, '/Home/Documents/notes.txt')
		assert.equal(await readFile(join(home, 'Documents', 'notes.txt'), 'utf8'), 'hello')
		await mkdir(join(home, 'Other'))
		await writeFile(join(home, 'Other', 'notes.txt'), 'old')
		const replaced = await call('files.copy', {path: '/Home/Documents/notes.txt', toDirectory: '/Home/Other', collision: 'replace'})
		assert.equal(replaced, '/Home/Other/notes.txt')
		assert.equal(await readFile(join(home, 'Other', 'notes.txt'), 'utf8'), 'hello')
		assert.equal(await readFile(join(home, 'Documents', 'notes.txt'), 'utf8'), 'hello')
	})

	test("keep-both copy into the item's own folder creates a second file", async () => {
		const copied = await call('files.copy', {path: '/Home/Documents/notes.txt', toDirectory: '/Home/Documents', collision: 'keep-both'})
		assert.match(copied, /\(2\)/)
		const names = await readdir(join(home, 'Documents'))
		assert.ok(names.some((name) => name.includes('(2)')))
		assert.equal(await readFile(join(home, 'Documents', 'notes.txt'), 'utf8'), 'hello')
	})

	test("error into the item's own folder reports a conflict", async () => {
		await assert.rejects(
			call('files.copy', {path: '/Home/Documents/notes.txt', toDirectory: '/Home/Documents', collision: 'error'}),
			(e) => e.code === 'CONFLICT' && e.message === '[already-exists]',
		)
	})

	test('replace through a symlink to the parent leaves the source in place', async () => {
		const linkDir = join(home, 'DocumentsLink')
		await symlink(join(home, 'Documents'), linkDir)
		try {
			await call('files.copy', {path: '/Home/Documents/notes.txt', toDirectory: '/Home/DocumentsLink', collision: 'replace'})
			assert.equal(await readFile(join(home, 'Documents', 'notes.txt'), 'utf8'), 'hello')
		} finally {
			await rm(linkDir, {force: true})
		}
	})

	test('replace overwrites a hard link with the same basename in another folder', async () => {
		const dir = join(home, 'Hard')
		await mkdir(dir)
		const src = join(home, 'Documents', 'notes.txt')
		const dest = join(dir, 'notes.txt')
		await link(src, dest)
		const before = await lstat(src)
		assert.equal((await lstat(dest)).ino, before.ino)
		const replaced = await call('files.copy', {path: '/Home/Documents/notes.txt', toDirectory: '/Home/Hard', collision: 'replace'})
		assert.equal(replaced, '/Home/Hard/notes.txt')
		assert.equal(await readFile(dest, 'utf8'), 'hello')
		assert.equal(await readFile(src, 'utf8'), 'hello')
		const afterSrc = await lstat(src)
		const afterDest = await lstat(dest)
		assert.notEqual(afterDest.ino, afterSrc.ino)
		assert.equal(afterSrc.nlink, before.nlink - 1)
	})

	test('an upload over an existing link replaces the link, never the file it points to', async () => {
		const server = http.createServer((req, res) => files.upload(req, res, new URL(req.url, 'http://x')))
		await new Promise((r) => server.listen(0, '127.0.0.1', r))
		try {
			await symlink(join(outside, 'secret.txt'), join(home, 'Documents', 'trap.txt'))
			const r = await fetch(`http://127.0.0.1:${server.address().port}/?path=${encodeURIComponent('/Home/Documents/trap.txt')}&collision=replace`, {method: 'POST', body: 'uploaded'})
			assert.equal(r.status, 200)
			assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'not yours')
			assert.equal(await readFile(join(home, 'Documents', 'trap.txt'), 'utf8'), 'uploaded')
			assert.ok(!(await lstat(join(home, 'Documents', 'trap.txt'))).isSymbolicLink())
		} finally {
			server.close()
		}
	})
})

describe('files: Trash', () => {
	test('trash and restore round-trip, the freedesktop way', async () => {
		const t = await call('files.trash', {path: '/Home/Documents/notes.txt'})
		assert.equal(t, '/Trash/notes.txt')
		const info = await readFile(join(home, '.local/share/Trash/info/notes.txt.trashinfo'), 'utf8')
		assert.match(info, new RegExp(`Path=${join(home, 'Documents', 'notes.txt')}`))
		assert.equal(await call('files.restore', {path: '/Trash/notes.txt'}), '/Home/Documents/notes.txt')
		assert.equal(await readFile(join(home, 'Documents', 'notes.txt'), 'utf8'), 'hello')
	})

	test('a .trashinfo pointing outside Home restores into Home instead', async () => {
		const trash = join(home, '.local/share/Trash')
		await mkdir(join(trash, 'files'), {recursive: true})
		await mkdir(join(trash, 'info'), {recursive: true})
		const cases = [
			['dots.txt', `${home}/../outside/dots.txt`], // starts with Home but climbs out
			['abs.txt', `${outside}/abs.txt`],
			['link.txt', `${home}/escape/link.txt`], // through a folder link
		]
		for (const [name, path] of cases) {
			await writeFile(join(trash, 'files', name), name)
			await writeFile(join(trash, 'info', `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(path)}\nDeletionDate=2026-11-14T10:00:00\n`)
			assert.equal(await call('files.restore', {path: `/Trash/${name}`}), `/Home/${name}`, name)
		}
		assert.deepEqual(await readdir(outside), ['secret.txt'], 'nothing restored outside Home')
	})

	test('only the Trash can be deleted from; Home itself can’t be trashed', async () => {
		await assert.rejects(call('files.delete', {path: '/Home/Documents/notes.txt'}), (e) => e.code === 'BAD_REQUEST')
		await assert.rejects(call('files.trash', {path: '/Home'}), (e) => e.code === 'BAD_REQUEST')
		await call('files.trash', {path: '/Home/Documents/notes.txt'})
		await call('files.delete', {path: '/Trash/notes.txt'})
		assert.deepEqual(await readdir(join(home, '.local/share/Trash/files')), [])
		assert.equal(await readlink(join(home, 'escape')), outside, 'links themselves left alone')
	})

	test('rename and move refuse the Home and Trash folders themselves', async () => {
		const scratch = await mkdtemp(join(os.tmpdir(), 'omarchy-roots-'))
		await mkdir(join(scratch, 'home'))
		const h = await realpath(join(scratch, 'home'))
		await mkdir(join(h, 'Documents'), {recursive: true})
		await mkdir(join(h, '.local/share/Trash/files'), {recursive: true})
		await mkdir(join(scratch, 'data'))
		await writeFile(join(h, 'Documents', 'notes.txt'), 'hello')
		const f = createFiles({home: h, dataDir: join(scratch, 'data')})
		const run = (name, input) => f.procedures[name].run(input)
		try {
			await assert.rejects(run('files.rename', {path: '/Home', newName: 'Renamed'}), (e) => e.code === 'BAD_REQUEST')
			await assert.rejects(run('files.move', {path: '/Home', toDirectory: '/Home/Documents'}), (e) => e.code === 'BAD_REQUEST')
			await assert.rejects(run('files.move', {path: '/Trash', toDirectory: '/Home/Documents'}), (e) => e.code === 'BAD_REQUEST')
			await assert.rejects(run('files.copy', {path: '/Trash', toDirectory: '/Home/Documents'}), (e) => e.code === 'BAD_REQUEST')
			const listed = await run('files.list', {path: '/Home/Documents'})
			assert.ok(listed.files.some((file) => file.name === 'notes.txt'))
			assert.equal(await readFile(join(h, 'Documents', 'notes.txt'), 'utf8'), 'hello')
		} finally {
			await rm(scratch, {recursive: true, force: true})
		}
	})

	test('a file inside a trashed folder does not use another item’s trashinfo', async () => {
		const scratch = await mkdtemp(join(os.tmpdir(), 'omarchy-trashinfo-'))
		await mkdir(join(scratch, 'home'))
		const h = await realpath(join(scratch, 'home'))
		const data = join(scratch, 'data')
		await mkdir(join(h, 'proj'), {recursive: true})
		await mkdir(join(h, 'other'), {recursive: true})
		await mkdir(data)
		await writeFile(join(h, 'proj', 'a.txt'), 'nested')
		await writeFile(join(h, 'other', 'a.txt'), 'top')
		const f = createFiles({home: h, dataDir: data})
		const run = (name, input) => f.procedures[name].run(input)
		const infoDir = join(h, '.local/share/Trash/info')
		try {
			await run('files.trash', {path: '/Home/proj'})
			await run('files.trash', {path: '/Home/other/a.txt'})
			const info = await readFile(join(infoDir, 'a.txt.trashinfo'), 'utf8')
			await run('files.delete', {path: '/Trash/proj/a.txt'})
			assert.equal(await readFile(join(infoDir, 'a.txt.trashinfo'), 'utf8'), info, 'deleting the nested file removed the other trashinfo')
			await writeFile(join(h, '.local/share/Trash/files/proj/b.txt'), 'second')
			const nested = await run('files.restore', {path: '/Trash/proj/b.txt'})
			assert.equal(nested, '/Home/b.txt')
			assert.equal(await readFile(join(h, 'b.txt'), 'utf8'), 'second')
			assert.equal(await readFile(join(infoDir, 'a.txt.trashinfo'), 'utf8'), info, 'restoring the nested file removed the other trashinfo')
			const top = await run('files.restore', {path: '/Trash/a.txt'})
			assert.equal(top, '/Home/other/a.txt')
			assert.equal(await readFile(join(h, 'other', 'a.txt'), 'utf8'), 'top')
		} finally {
			await rm(scratch, {recursive: true, force: true})
		}
	})
})

describe('files: list paging', () => {
	let paged
	before(async () => {
		paged = join(home, 'Paged')
		await mkdir(paged, {recursive: true})
		for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) await writeFile(join(paged, n), n)
	})

	test('limit returns a page after sort, with hasMore and the real total', async () => {
		const l = await call('files.list', {path: '/Home/Paged', limit: 3, sortBy: 'name'})
		assert.equal(l.files.length, 3)
		assert.equal(l.hasMore, true)
		assert.equal(l.totalFiles, 5)
		assert.deepEqual(l.files.map((f) => f.name), ['a.txt', 'b.txt', 'c.txt'])
		assert.ok(l.files.every((f) => f.path.startsWith('/Home/Paged/')))
		assert.ok(l.files.every((f) => !String(f.path).includes(outside) && !String(f.path).includes(root)))
	})

	test('omitted limit still returns everything', async () => {
		const l = await call('files.list', {path: '/Home/Paged', sortBy: 'name'})
		assert.equal(l.files.length, 5)
		assert.equal(l.hasMore, false)
		assert.equal(l.totalFiles, 5)
		assert.deepEqual(l.files.map((f) => f.name), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'])
	})

	test('limit 0 or negative is ignored and lists all', async () => {
		for (const limit of [0, -1, -99]) {
			const l = await call('files.list', {path: '/Home/Paged', limit})
			assert.equal(l.files.length, 5, `limit ${limit}`)
			assert.equal(l.hasMore, false, `limit ${limit}`)
			assert.equal(l.totalFiles, 5, `limit ${limit}`)
		}
	})

	test('limit is applied after the requested sort', async () => {
		const {utimes} = await import('node:fs/promises')
		const t0 = new Date('2026-01-01T00:00:00Z')
		for (const [i, n] of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].entries()) {
			await utimes(join(paged, n), t0, new Date(t0.getTime() + i * 60_000))
		}
		const newest = await call('files.list', {path: '/Home/Paged', sortBy: 'modified', sortOrder: 'descending', limit: 2})
		assert.deepEqual(newest.files.map((f) => f.name), ['e.txt', 'd.txt'])
		assert.equal(newest.hasMore, true)
		assert.equal(newest.totalFiles, 5)
		const first = await call('files.list', {path: '/Home/Paged', sortBy: 'name', sortOrder: 'descending', limit: 2})
		assert.deepEqual(first.files.map((f) => f.name), ['e.txt', 'd.txt'])
	})

	test('a broken symlink does not set hasMore when the whole folder fits the limit', async () => {
		const broken = join(paged, 'gone.txt')
		await symlink(join(paged, 'no-such-file'), broken)
		try {
			const all = await call('files.list', {path: '/Home/Paged', limit: 2000, sortBy: 'name'})
			assert.equal(all.hasMore, false)
			assert.equal(all.totalFiles, 6)
			assert.equal(all.files.length, 5)
			const page = await call('files.list', {path: '/Home/Paged', limit: 3, sortBy: 'name'})
			assert.equal(page.hasMore, true)
			assert.equal(page.totalFiles, 6)
		} finally {
			await rm(broken)
		}
	})

	test('a link to a folder sorts with the folders, as before', async () => {
		await mkdir(join(paged, 'zz-folder'), {recursive: true})
		await symlink(join(paged, 'zz-folder'), join(paged, 'zz-link'))
		try {
			const l = await call('files.list', {path: '/Home/Paged', sortBy: 'name'})
			assert.deepEqual(l.files.slice(0, 2).map((f) => f.name), ['zz-folder', 'zz-link'])
			assert.equal(l.files[1].type, 'directory')
		} finally {
			await rm(join(paged, 'zz-link'))
			await rm(join(paged, 'zz-folder'), {recursive: true})
		}
	})
})

describe('files: assistant store', () => {
	test('download and replace of assistant/keys.json are refused', async () => {
		const secretHome = join(root, 'secret-home')
		const dataDir = join(secretHome, '.local/share/omarchy-server/omarchyd')
		const assistant = join(dataDir, 'assistant')
		await mkdir(assistant, {recursive: true})
		const keys = join(assistant, 'keys.json')
		const accounts = join(dataDir, 'accounts.json')
		const secret = '{"keys":[{"apiKey":"super-secret"}]}'
		await writeFile(keys, secret, {mode: 0o600})
		await writeFile(accounts, '{"users":[]}', {mode: 0o600})
		await mkdir(join(secretHome, 'Documents'), {recursive: true})
		await symlink(keys, join(secretHome, 'Documents', 'alias.json'))
		const f = createFiles({home: secretHome, dataDir})
		const virtual = '/Home/.local/share/omarchy-server/omarchyd/assistant/keys.json'
		await assert.rejects(f.resolve(virtual), (e) => e.code === 'FORBIDDEN')
		await assert.rejects(f.resolve('/Home/.local/share/omarchy-server/omarchyd/accounts.json'), (e) => e.code === 'FORBIDDEN')
		await assert.rejects(f.resolve('/Home/Documents/alias.json'), (e) => e.code === 'FORBIDDEN')
		const server = http.createServer((req, res) => {
			const url = new URL(req.url, 'http://x')
			if (req.method === 'POST') return f.upload(req, res, url)
			return f.serveFile(req, res, url, 'download')
		})
		await new Promise((r) => server.listen(0, '127.0.0.1', r))
		try {
			const port = server.address().port
			const down = await fetch(`http://127.0.0.1:${port}/?path=${encodeURIComponent(virtual)}`)
			assert.notEqual(down.status, 200)
			assert.equal((await down.text()).includes('super-secret'), false)
			const up = await fetch(`http://127.0.0.1:${port}/?path=${encodeURIComponent(virtual)}&collision=replace`, {method: 'POST', body: 'pwned'})
			assert.notEqual(up.status, 200)
			assert.equal(await readFile(keys, 'utf8'), secret)
			assert.equal((await readFile(accounts, 'utf8')).includes('pwned'), false)
			assert.deepEqual(await readdir(assistant), ['keys.json'])
		} finally {
			await new Promise((r) => server.close(r))
		}
	})
})

describe('files: favorites', () => {
	async function captureErrors(fn) {
		const lines = []
		const orig = console.error
		console.error = (...args) => lines.push(args.map(String).join(' '))
		try {
			return await fn(lines)
		} finally {
			console.error = orig
		}
	}

	function assertSafeFavoritesError(err, dataDir, file) {
		assert.ok(err instanceof RpcError, `expected RpcError, got ${err?.constructor?.name}`)
		assert.equal(err.code, 'PRECONDITION_FAILED')
		assert.match(err.message, /favorites\.json/)
		assert.equal(err.message.includes(dataDir), false)
		assert.equal(err.message.includes(file), false)
		assert.equal(err.message.includes('secret-folder'), false)
	}

	test('missing favorites.json starts empty and round-trips addFavorite/removeFavorite', async () => {
		const dataDir = await mkdtemp(join(root, 'fav-ok-'))
		const f = createFiles({home, dataDir})
		await captureErrors(async (lines) => {
			assert.deepEqual(await f.procedures['files.favorites'].run(), [])
			assert.deepEqual(lines, [])
			await f.procedures['files.addFavorite'].run({path: '/Home/Documents'})
			assert.deepEqual((await f.procedures['files.favorites'].run()).map((e) => e.path), ['/Home/Documents'])
			await f.procedures['files.removeFavorite'].run({path: '/Home/Documents'})
			assert.deepEqual(await f.procedures['files.favorites'].run(), [])
			assert.deepEqual(lines, [])
		})
	})

	test('damaged or wrong-shaped favorites.json logs basename once and refuses overwrites', async () => {
		const cases = [
			['empty', ''],
			['truncated', '["/Home/secret-folder"'],
			['bom', '\uFEFF[]'],
			['null', 'null'],
			['object', '{}'],
			['string', '"hello"'],
			['number', '42'],
			['null item', '[null]'],
			['number item', '[123]'],
		]
		for (const [name, contents] of cases) {
			const dataDir = await mkdtemp(join(root, 'fav-bad-'))
			const file = join(dataDir, 'favorites.json')
			await writeFile(file, contents)
			const before = await readFile(file)
			const f = createFiles({home, dataDir})
			await captureErrors(async (lines) => {
				assert.deepEqual(await f.procedures['files.favorites'].run(), [], name)
				assert.deepEqual(await f.procedures['files.favorites'].run(), [], name)
				const notes = lines.filter((l) => l.includes('favorites.json'))
				assert.equal(notes.length, 1, `${name}: logged once (${JSON.stringify(lines)})`)
				assert.equal(notes[0].includes(dataDir), false, `${name}: no dataDir`)
				assert.equal(notes[0].includes(file), false, `${name}: no file path`)
				if (contents.length > 0) assert.equal(notes[0].includes(contents), false, `${name}: no contents`)
				assert.equal(notes[0].includes('secret-folder'), false, `${name}: no secret`)

				for (const attempt of [
					() => f.procedures['files.addFavorite'].run({path: '/Home/Documents'}),
					() => f.procedures['files.removeFavorite'].run({path: '/Home/Documents'}),
				]) {
					await assert.rejects(attempt, (err) => {
						assertSafeFavoritesError(err, dataDir, file)
						return true
					}, name)
				}
				assert.deepEqual(await readFile(file), before, `${name}: untouched after refused writes`)
			})
		}
	})

	test('EISDIR or EACCES on favorites.json logs basename once and refuses overwrites', async (t) => {
		const dirData = await mkdtemp(join(root, 'fav-dir-'))
		const dirFile = join(dirData, 'favorites.json')
		await mkdir(dirFile)
		const fDir = createFiles({home, dataDir: dirData})
		await captureErrors(async (lines) => {
			assert.deepEqual(await fDir.procedures['files.favorites'].run(), [])
			assert.deepEqual(await fDir.procedures['files.favorites'].run(), [])
			assert.equal(lines.length, 1)
			assert.match(lines[0], /favorites\.json/)
			assert.equal(lines[0].includes(dirData), false)
			await assert.rejects(
				() => fDir.procedures['files.addFavorite'].run({path: '/Home/Documents'}),
				(err) => {
					assertSafeFavoritesError(err, dirData, dirFile)
					return true
				},
			)
			assert.equal((await stat(dirFile)).isDirectory(), true)
		})

		if (process.getuid?.() === 0) return t.skip('root ignores file mode')
		const accData = await mkdtemp(join(root, 'fav-acc-'))
		const accFile = join(accData, 'favorites.json')
		await writeFile(accFile, '["/Home/Documents"]', {mode: 0o600})
		await chmod(accFile, 0o000)
		const fAcc = createFiles({home, dataDir: accData})
		try {
			await captureErrors(async (lines) => {
				assert.deepEqual(await fAcc.procedures['files.favorites'].run(), [])
				assert.equal(lines.length, 1)
				assert.match(lines[0], /favorites\.json/)
				assert.equal(lines[0].includes(accData), false)
				await assert.rejects(
					() => fAcc.procedures['files.addFavorite'].run({path: '/Home/Documents'}),
					(err) => {
						assertSafeFavoritesError(err, accData, accFile)
						return true
					},
				)
			})
		} finally {
			await chmod(accFile, 0o600)
		}
		assert.equal(await readFile(accFile, 'utf8'), '["/Home/Documents"]')
	})

	test('favorites recover automatically after a damaged favorites.json is removed or repaired', async () => {
		const dataDir = await mkdtemp(join(root, 'fav-rec-'))
		const file = join(dataDir, 'favorites.json')
		await writeFile(file, '{broken')
		const f = createFiles({home, dataDir})
		await captureErrors(async (lines) => {
			assert.deepEqual(await f.procedures['files.favorites'].run(), [])
			assert.equal(lines.length, 1)
			await rm(file)
			await f.procedures['files.addFavorite'].run({path: '/Home/Documents'})
			assert.deepEqual((await f.procedures['files.favorites'].run()).map((e) => e.path), ['/Home/Documents'])
			await writeFile(file, 'bad-again')
			assert.deepEqual(await f.procedures['files.favorites'].run(), [])
			assert.equal(lines.length, 2)
			await writeFile(file, '["/Home/Documents"]')
			assert.deepEqual((await f.procedures['files.favorites'].run()).map((e) => e.path), ['/Home/Documents'])
		})
	})
})
