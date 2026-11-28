import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {readNixCache, writeNixCache} from '../omarchyd/nix-cache.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

test('nix cache defaults off and persists', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'nix-cache-'))
	assert.deepEqual(await readNixCache(dataDir), {enabled: false, substituter: ''})
	await writeNixCache(dataDir, {enabled: true, substituter: 'http://10.0.0.1:5000'})
	assert.deepEqual(await readNixCache(dataDir), {enabled: true, substituter: 'http://10.0.0.1:5000'})
})

test('writeNixCache rejects enabled with empty or invalid substituter URL', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'nix-cache-reject-'))
	const msg = /http\(s\) URL/
	await assert.rejects(
		() => writeNixCache(dataDir, {enabled: true, substituter: ''}),
		err => err instanceof RpcError && err.code === 'BAD_REQUEST' && msg.test(err.message),
	)
	await assert.rejects(
		() => writeNixCache(dataDir, {enabled: true, substituter: 'ftp://cache.example'}),
		err => err instanceof Error && msg.test(err.message),
	)
})

test('writeNixCache accepts enabled with valid http(s) substituter URL', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'nix-cache-accept-'))
	const url = 'https://cache.example/nix-store'
	const state = await writeNixCache(dataDir, {enabled: true, substituter: url})
	assert.deepEqual(state, {enabled: true, substituter: url})
	assert.deepEqual(await readNixCache(dataDir), {enabled: true, substituter: url})
})
