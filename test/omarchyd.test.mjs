// omarchyd: accounts, file safety and the freedesktop trash, against a throwaway home folder.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

describe('omarchyd', () => {
	let root, home, data, d
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-'))
		home = join(root, 'home')
		data = join(root, 'data')
		await mkdir(join(home, 'Documents'), {recursive: true})
		await writeFile(join(home, 'Documents/Notes.txt'), 'hello omarchy')
		await writeFile(join(home, '.secret'), 'hidden')
		await mkdir(join(root, 'outside'))
		await writeFile(join(root, 'outside/passwd'), 'nope')
		await symlink(join(root, 'outside'), join(home, 'escape'))
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({port: 0, dataDir: data, home})
	})
	after(async () => {
		await d.close()
		await rm(root, {recursive: true, force: true})
	})
	const call = async (kind, path, input, headers = {}) => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...headers}}
		if (kind === 'mutation') {
			init.headers['content-type'] = 'application/json'
			init.body = JSON.stringify(input ?? null)
		} else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const r = await fetch(url, init)
		return {status: r.status, body: await r.json(), headers: r.headers}
	}
	let native, browser
	test('accounts: wrong password refused, right one signs in', async () => {
		const bad = await call('mutation', 'user.loginNative', {userId: 'owner', password: 'nope', client: {id: 't'}})
		assert.equal(bad.status, 401)
		const ok = await call('mutation', 'user.loginNative', {userId: 'owner', password: 'correct horse', client: {id: 't'}})
		assert.equal(ok.status, 200)
		native = {authorization: `Bearer ${ok.body.result.data.accessToken}`}
		const login = await call('mutation', 'user.login', {userId: 'owner', password: 'correct horse'})
		const cookie = login.headers.getSetCookie()[0].split(';')[0]
		browser = {authorization: `Bearer ${login.body.result.data}`, cookie}
		assert.equal((await call('query', 'user.get', undefined, native)).body.result.data.name, 'Chris')
		assert.equal((await call('query', 'files.list', {path: '/Home'})).status, 401)
		// A browser bearer without its cookie is refused.
		assert.equal((await call('query', 'user.get', undefined, {authorization: browser.authorization})).status, 401)
	})
	test('files: lists Home without dotfiles; stats are real numbers', async () => {
		const list = (await call('query', 'files.list', {path: '/Home'}, native)).body.result.data
		assert.deepEqual(list.files.map((f) => f.name).sort(), ['Documents', 'escape'])
		const mem = (await call('query', 'system.memoryUsage', undefined, native)).body.result.data
		assert.ok(mem.size > 0 && mem.totalUsed > 0)
	})
	test('files: nothing outside Home, not via .. nor via a symlink', async () => {
		assert.equal((await call('query', 'files.list', {path: '/Home/../..'}, native)).status, 400)
		assert.equal((await call('query', 'files.list', {path: '/Home/escape'}, native)).status, 403)
		assert.equal((await call('mutation', 'files.copy', {path: '/Home/escape/passwd', toDirectory: '/Home'}, native)).status, 403)
		assert.equal((await call('query', 'files.list', {path: '/etc'}, native)).status, 404)
	})
	test('files: view needs a url token and the browser cookie', async () => {
		const t = (await call('query', 'user.getHttpApiToken', undefined, browser)).body.result.data
		assert.equal((await call('query', 'user.getHttpApiToken', undefined, native)).status, 403)
		const path = encodeURIComponent('/Home/Documents/Notes.txt')
		assert.equal((await fetch(`${d.url}/api/files/view?path=${path}&token=${t}`)).status, 401)
		const r = await fetch(`${d.url}/api/files/view?path=${path}&token=${t}`, {headers: {cookie: browser.cookie}})
		assert.equal(await r.text(), 'hello omarchy')
		const part = await fetch(`${d.url}/api/files/view?path=${path}&token=${t}`, {headers: {cookie: browser.cookie, range: 'bytes=6-'}})
		assert.equal(part.status, 206)
		assert.equal(await part.text(), 'omarchy')
	})
	test('files: upload keeps both by default and replaces on request', async () => {
		const up = (collision) =>
			fetch(`${d.url}/api/files/upload?path=${encodeURIComponent('/Home/Documents/Notes.txt')}&collision=${collision}`, {method: 'POST', headers: browser, body: 'v2'})
		assert.equal((await (await up('keep-both')).json()).path, '/Home/Documents/Notes (2).txt')
		await up('replace')
		assert.equal(await readFile(join(home, 'Documents/Notes.txt'), 'utf8'), 'v2')
		const leftovers = (await readdir(join(home, 'Documents'))).filter((n) => n.endsWith('.uploading'))
		assert.deepEqual(leftovers, [])
	})
	test('files: trash and restore use the freedesktop trash', async () => {
		const trashed = (await call('mutation', 'files.trash', {path: '/Home/Documents/Notes (2).txt'}, native)).body.result.data
		assert.equal(trashed, '/Trash/Notes (2).txt')
		const info = await readFile(join(home, '.local/share/Trash/info/Notes (2).txt.trashinfo'), 'utf8')
		assert.match(info, /^Path=.*Documents\/Notes%20\(2\)\.txt$/m)
		assert.equal((await call('mutation', 'files.delete', {path: '/Home/Documents/Notes.txt'}, native)).status, 400)
		const back = (await call('mutation', 'files.restore', {path: '/Trash/Notes (2).txt'}, native)).body.result.data
		assert.equal(back, '/Home/Documents/Notes (2).txt')
	})
})
