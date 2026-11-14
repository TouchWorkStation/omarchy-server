// Guessing passwords against omarchyd directly (any program on the server could try) is slowed
// down, without ever locking the owner out; a 2FA code works only once.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts, secretFromUri, totpCode} from '../omarchyd/accounts.mjs'

test('wrong passwords queue up and slow down; the right one still works', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'acct-'))
	try {
		const a = await openAccounts(root)
		await a.createOwner({name: 'Chris', password: 'correct horse'})
		// Six guesses sent at once run one after another, and the sixth waits on top.
		const started = Date.now()
		const guesses = await Promise.allSettled(Array.from({length: 6}, (_, i) => a.loginNative({userId: 'owner', password: `guess ${i}`, client: {id: 't'}})))
		assert.ok(guesses.every((g) => g.status === 'rejected' && /Incorrect password/.test(g.reason.message)))
		assert.ok(Date.now() - started >= 6 * 300 + 1000, 'run one at a time, then slowed')
		const ok = await a.loginNative({userId: 'owner', password: 'correct horse', client: {id: 't'}})
		assert.ok(ok.accessToken)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a 2FA code can’t be used twice', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'acct-'))
	try {
		const a = await openAccounts(root)
		await a.createOwner({name: 'Chris', password: 'correct horse'})
		const totpUri = 'otpauth://totp/Omarchy%20Server:Chris?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Omarchy%20Server'
		const secret = secretFromUri(totpUri)
		await a.enable2fa('owner', {totpUri, totpToken: totpCode(secret)})
		const code = totpCode(secret)
		assert.ok((await a.loginNative({userId: 'owner', password: 'correct horse', totpToken: code, client: {id: 't'}})).accessToken)
		await assert.rejects(a.loginNative({userId: 'owner', password: 'correct horse', totpToken: code, client: {id: 't'}}), /already used/)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('after signing in with a 2FA code, the web app gets its console session without the code again', async () => {
	const {startOmarchyd} = await import('../omarchyd/server.mjs')
	const root = await mkdtemp(join(os.tmpdir(), 'acct-'))
	const a = await openAccounts(join(root, 'data'))
	await a.createOwner({name: 'Chris', password: 'correct horse'})
	const totpUri = 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
	await a.enable2fa('owner', {totpUri, totpToken: totpCode(secretFromUri(totpUri))})
	const d = await startOmarchyd({port: 0, dataDir: join(root, 'data'), home: root})
	try {
		const post = (path, body, headers = {}) => fetch(`${d.url}/trpc/${path}`, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)})
		const code = totpCode(secretFromUri(totpUri))
		const native = (await (await post('user.loginNative', {userId: 'owner', password: 'correct horse', totpToken: code, client: {id: 'w'}})).json()).result.data
		// Signing in again with the same code is refused…
		assert.equal((await post('user.login', {userId: 'owner', password: 'correct horse', totpToken: code})).status, 401)
		// …but the signed-in session can get its browser session.
		const r = await post('user.browserSession', undefined, {authorization: `Bearer ${native.accessToken}`})
		assert.equal(r.status, 200)
		assert.ok(r.headers.getSetCookie().some((c) => c.startsWith('OMARCHY_BROWSER_SESSION=')))
		assert.equal((await post('user.browserSession', undefined, {})).status, 401)
	} finally {
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})
