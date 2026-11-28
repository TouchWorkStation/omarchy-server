import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'

const CACHE_URL = /^https?:\/\/[A-Za-z0-9._:~%/?#@[\]!$&'()*+,;=-]+$/

function cacheFile(dataDir) {
	return join(String(dataDir), 'nix-cache.json')
}

export async function readNixCache(dataDir) {
	try {
		const parsed = JSON.parse(await readFile(cacheFile(dataDir), 'utf8'))
		return {enabled: Boolean(parsed?.enabled), substituter: String(parsed?.substituter ?? '').trim()}
	} catch {
		return {enabled: false, substituter: ''}
	}
}

export async function writeNixCache(dataDir, {enabled, substituter}) {
	const en = Boolean(enabled)
	const sub = String(substituter ?? '').trim()
	if (en && (!sub || !CACHE_URL.test(sub))) throw new RpcError('BAD_REQUEST', 'Use an http(s) URL for the binary cache.')
	const state = {enabled: en, substituter: sub}
	await writeAtomic(cacheFile(dataDir), JSON.stringify(state))
	return state
}
