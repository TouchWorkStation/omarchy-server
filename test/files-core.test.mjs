// Files backend fixes: folder-first sort, favorite metadata, empty Trash, and Unicode NFC search.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {describe, test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'

describe('files: #97 folders stay before files in descending sort', () => {
	test('sorting by modified, size, or name descending keeps folders first', async (t) => {
		const scratch = await realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-sort-')))
		t.after(() => rm(scratch, {recursive: true, force: true}))
		const h = join(scratch, 'home')
		const d = join(scratch, 'data')
		await mkdir(join(h, 'Alpha'), {recursive: true})
		await mkdir(join(h, 'Beta'), {recursive: true})
		await mkdir(d, {recursive: true})
		await writeFile(join(h, 'new.txt'), 'a')
		await writeFile(join(h, 'old.txt'), 'abcd')
		const t0 = new Date('2026-01-01T00:00:00Z')
		await utimes(join(h, 'old.txt'), t0, new Date(t0.getTime() + 10_000))
		await utimes(join(h, 'Alpha'), t0, new Date(t0.getTime() + 20_000))
		await utimes(join(h, 'Beta'), t0, new Date(t0.getTime() + 30_000))
		await utimes(join(h, 'new.txt'), t0, new Date(t0.getTime() + 40_000))

		const f = createFiles({home: h, dataDir: d})
		const run = (name, input) => f.procedures[name].run(input)

		const byModifiedDesc = await run('files.list', {path: '/Home', sortBy: 'modified', sortOrder: 'descending'})
		assert.deepEqual(byModifiedDesc.files.map((x) => x.name), ['Beta', 'Alpha', 'new.txt', 'old.txt'])

		const bySizeDesc = await run('files.list', {path: '/Home', sortBy: 'size', sortOrder: 'descending'})
		assert.deepEqual(bySizeDesc.files.map((x) => x.name), ['Alpha', 'Beta', 'old.txt', 'new.txt'])

		const byNameDesc = await run('files.list', {path: '/Home', sortBy: 'name', sortOrder: 'descending'})
		assert.deepEqual(byNameDesc.files.map((x) => x.name), ['Beta', 'Alpha', 'old.txt', 'new.txt'])

		const byNameAsc = await run('files.list', {path: '/Home', sortBy: 'name', sortOrder: 'ascending'})
		assert.deepEqual(byNameAsc.files.map((x) => x.name), ['Alpha', 'Beta', 'new.txt', 'old.txt'])

		const pagedModifiedDesc = await run('files.list', {path: '/Home', sortBy: 'modified', sortOrder: 'descending', limit: 2})
		assert.deepEqual(pagedModifiedDesc.files.map((x) => x.name), ['Beta', 'Alpha'])
	})
})

describe('files: #113 favorites return real entry metadata', () => {
	test('files.favorites returns FileEntry metadata for favorited files and folders', async (t) => {
		const scratch = await realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-favs-')))
		t.after(() => rm(scratch, {recursive: true, force: true}))
		const h = join(scratch, 'home')
		const d = join(scratch, 'data')
		await mkdir(join(h, 'Documents'), {recursive: true})
		await mkdir(d, {recursive: true})
		await writeFile(join(h, 'Documents', 'notes.txt'), 'hello')

		const f = createFiles({home: h, dataDir: d})
		const run = (name, input) => f.procedures[name].run(input)

		await run('files.addFavorite', {path: '/Home/Documents/notes.txt'})
		await run('files.addFavorite', {path: '/Home/Documents'})

		const favs = await run('files.favorites')
		assert.equal(favs.length, 2)
		const fileFav = favs.find((x) => x.path === '/Home/Documents/notes.txt')
		const dirFav = favs.find((x) => x.path === '/Home/Documents')
		assert.equal(fileFav?.name, 'notes.txt')
		assert.equal(fileFav?.type, 'text/plain')
		assert.equal(fileFav?.size, 5)
		assert.ok(fileFav?.operations?.includes('favorite'))
		assert.equal(dirFav?.name, 'Documents')
		assert.equal(dirFav?.type, 'directory')
		assert.equal(dirFav?.size, undefined)

		await rm(join(h, 'Documents', 'notes.txt'))
		const remaining = await run('files.favorites')
		assert.deepEqual(remaining.map((x) => x.path), ['/Home/Documents'])
	})
})

describe('files: #282 opening Trash before anything has been trashed', () => {
	test('files.list on /Trash creates Trash/files and returns an empty listing', async (t) => {
		const scratch = await realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-empty-trash-')))
		t.after(() => rm(scratch, {recursive: true, force: true}))
		const h = join(scratch, 'home')
		const d = join(scratch, 'data')
		await mkdir(h, {recursive: true})
		await mkdir(d, {recursive: true})

		const f = createFiles({home: h, dataDir: d})
		const listed = await f.procedures['files.list'].run({path: '/Trash'})
		assert.equal(listed.path, '/Trash')
		assert.equal(listed.name, 'Trash')
		assert.equal(listed.type, 'directory')
		assert.deepEqual(listed.files, [])
		assert.equal(listed.totalFiles, 0)
	})

	test('files.list on /Trash does not follow or create directories through an outside symlink', async (t) => {
		const scratch = await realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-trash-link-')))
		t.after(() => rm(scratch, {recursive: true, force: true}))
		const h = join(scratch, 'home')
		const d = join(scratch, 'data')
		const extDir = join(scratch, 'outside')
		await mkdir(join(h, '.local/share'), {recursive: true})
		await mkdir(d, {recursive: true})
		await mkdir(extDir, {recursive: true})
		await symlink(extDir, join(h, '.local/share/Trash'))

		const f = createFiles({home: h, dataDir: d})
		await assert.rejects(f.procedures['files.list'].run({path: '/Trash'}), (e) => ['NOT_FOUND', 'FORBIDDEN'].includes(e.code))
		assert.deepEqual(await readdir(extDir), [])
	})
})

describe('files: #488 Unicode NFC normalization in search', () => {
	test('search matches accented names across NFD and NFC forms', async (t) => {
		const scratch = await realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-nfd-')))
		t.after(() => rm(scratch, {recursive: true, force: true}))
		const h = join(scratch, 'home')
		const d = join(scratch, 'data')
		await mkdir(h, {recursive: true})
		await mkdir(d, {recursive: true})
		await writeFile(join(h, 'cafe\u0301.txt'), 'nfd')
		await writeFile(join(h, 'r\u00e9sum\u00e9.txt'), 'nfc')

		const f = createFiles({home: h, dataDir: d})
		const run = (name, input) => f.procedures[name].run(input)

		const byNfc = await run('files.search', {query: 'caf\u00e9'})
		assert.equal(byNfc.length, 1)
		assert.equal(byNfc[0].name.normalize('NFC'), 'caf\u00e9.txt')

		const byUpperNfc = await run('files.search', {query: 'CAF\u00c9'})
		assert.equal(byUpperNfc.length, 1)
		assert.equal(byUpperNfc[0].name.normalize('NFC'), 'caf\u00e9.txt')

		const byNfd = await run('files.search', {query: 're\u0301sume\u0301'})
		assert.equal(byNfd.length, 1)
		assert.equal(byNfd[0].name.normalize('NFC'), 'r\u00e9sum\u00e9.txt')
	})
})
