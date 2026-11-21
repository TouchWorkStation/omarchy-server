// Concurrent file operations must keep both uploads and all favorites intact.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'

function delayedUpload(port, path, collision, body, delayMs) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: '127.0.0.1',
				port,
				path: `/?path=${encodeURIComponent(path)}&collision=${encodeURIComponent(collision)}`,
				method: 'POST',
				headers: {'content-length': String(Buffer.byteLength(body))},
			},
			(res) => {
				const chunks = []
				res.on('data', (c) => chunks.push(c))
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8')
					resolve({status: res.statusCode, body: JSON.parse(text)})
				})
			},
		)
		req.on('error', reject)
		req.flushHeaders()
		const timer = setTimeout(() => req.end(body), delayMs)
		req.on('close', () => clearTimeout(timer))
	})
}

async function setupFiles(t) {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-files-conc-')))
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(home, {recursive: true})
	await mkdir(dataDir, {recursive: true})
	const files = createFiles({home, dataDir})
	const server = http.createServer((req, res) => files.upload(req, res, new URL(req.url, 'http://x')))
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	t.after(async () => {
		server.closeAllConnections?.()
		await new Promise((r) => server.close(r))
		await rm(root, {recursive: true, force: true})
	})
	return {root, home, dataDir, files, port: server.address().port}
}

test('concurrent keep-both uploads of the same name keep both files', async (t) => {
	const {home, port} = await setupFiles(t)
	const [a, b] = await Promise.all([
		delayedUpload(port, '/Home/a.txt', 'keep-both', 'FIRST', 40),
		delayedUpload(port, '/Home/a.txt', 'keep-both', 'SECOND', 40),
	])
	assert.equal(a.status, 200)
	assert.equal(b.status, 200)
	assert.deepEqual([a.body.path, b.body.path].sort(), ['/Home/a (2).txt', '/Home/a.txt'])
	const names = (await readdir(home)).sort()
	assert.deepEqual(names, ['a (2).txt', 'a.txt'])
	const contents = (await Promise.all(names.map((n) => readFile(join(home, n), 'utf8')))).sort()
	assert.deepEqual(contents, ['FIRST', 'SECOND'])
})

test('concurrent error uploads of the same name allow one and refuse the other', async (t) => {
	const {home, port} = await setupFiles(t)
	await mkdir(join(home, 'once'), {recursive: true})
	const [a, b] = await Promise.all([
		delayedUpload(port, '/Home/once/once.txt', 'error', 'ONE', 40),
		delayedUpload(port, '/Home/once/once.txt', 'error', 'TWO', 40),
	])
	const pair = [a, b].sort((x, y) => x.status - y.status)
	assert.deepEqual(pair.map((r) => r.status), [200, 409])
	assert.deepEqual(pair[1].body, {error: '[already-exists]'})
	const names = await readdir(join(home, 'once'))
	assert.deepEqual(names, ['once.txt'])
	const saved = await readFile(join(home, 'once', 'once.txt'), 'utf8')
	assert.ok(saved === 'ONE' || saved === 'TWO')
})

test('concurrent keep-both uploads next to an existing file and unrelated names all land', async (t) => {
	const {home, port} = await setupFiles(t)
	await writeFile(join(home, 'exist.txt'), 'ORIG')
	const [a, b, other] = await Promise.all([
		delayedUpload(port, '/Home/exist.txt', 'keep-both', 'COPY1', 40),
		delayedUpload(port, '/Home/exist.txt', 'keep-both', 'COPY2', 40),
		delayedUpload(port, '/Home/other.txt', 'keep-both', 'OTHER', 20),
	])
	assert.equal(a.status, 200)
	assert.equal(b.status, 200)
	assert.equal(other.status, 200)
	assert.equal(other.body.path, '/Home/other.txt')
	assert.deepEqual([a.body.path, b.body.path].sort(), ['/Home/exist (2).txt', '/Home/exist (3).txt'])
	const names = (await readdir(home)).sort()
	assert.deepEqual(names, ['exist (2).txt', 'exist (3).txt', 'exist.txt', 'other.txt'])
	assert.equal(await readFile(join(home, 'exist.txt'), 'utf8'), 'ORIG')
	assert.deepEqual(
		(await Promise.all(['exist (2).txt', 'exist (3).txt'].map((n) => readFile(join(home, n), 'utf8')))).sort(),
		['COPY1', 'COPY2'],
	)
	assert.equal(await readFile(join(home, 'other.txt'), 'utf8'), 'OTHER')
})

test('concurrent favorite updates keep every change without leaving temp files', async (t) => {
	const {home, dataDir, files} = await setupFiles(t)
	await Promise.all(Array.from({length: 10}, (_, i) => mkdir(join(home, `f${i}`))))
	await Promise.all(
		Array.from({length: 8}, (_, i) => files.procedures['files.addFavorite'].run({path: `/Home/f${i}`})),
	)
	assert.deepEqual(
		(await files.procedures['files.favorites'].run()).map((e) => e.path).sort(),
		['/Home/f0', '/Home/f1', '/Home/f2', '/Home/f3', '/Home/f4', '/Home/f5', '/Home/f6', '/Home/f7'],
	)
	await Promise.all([
		files.procedures['files.removeFavorite'].run({path: '/Home/f0'}),
		files.procedures['files.addFavorite'].run({path: '/Home/f8'}),
		files.procedures['files.removeFavorite'].run({path: '/Home/f2'}),
		files.procedures['files.removeFavorite'].run({path: '/Home/f4'}),
		files.procedures['files.addFavorite'].run({path: '/Home/f9'}),
		files.procedures['files.removeFavorite'].run({path: '/Home/f6'}),
	])
	assert.deepEqual(
		(await files.procedures['files.favorites'].run()).map((e) => e.path).sort(),
		['/Home/f1', '/Home/f3', '/Home/f5', '/Home/f7', '/Home/f8', '/Home/f9'],
	)
	assert.deepEqual(await readdir(dataDir), ['favorites.json'])
	assert.equal((await stat(join(dataDir, 'favorites.json'))).mode & 0o777, 0o600)
})
