import {mkdir, readFile, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {writeAtomic} from './atomic.mjs'

export const NIXOS_CONFIG_MAX = 512 * 1024
export const NIXOS_GUEST_MOUNT = '/modc/nixos-config'

const CACHE_URL = /^https?:\/\/[A-Za-z0-9._:~%/?#@[\]!$&'()*+,;=-]+$/

export function isNixosOs(os = '') {
	return /^nixos$/i.test(String(os).trim())
}

export function validateNixosConfigId(id) {
	const safe = String(id ?? '').trim()
	if (!safe || safe.includes('/') || safe.includes('\\') || safe.includes('..')) {
		throw new Error('That guest id is not valid.')
	}
	return safe
}

export function validateNixosConfig(text) {
	const config = String(text ?? '')
	if (!config.trim()) return {ok: true, config: ''}
	if (config.length > NIXOS_CONFIG_MAX) return {ok: false, error: 'That configuration is too large (512 KB max).'}
	if (config.includes('\0')) return {ok: false, error: 'The configuration can’t contain null bytes.'}
	if (!/\{\s*config\s*,\s*pkgs\s*,/.test(config) && !config.includes('system.stateVersion') && !config.includes('environment.systemPackages')) {
		return {ok: false, error: 'That doesn’t look like a NixOS configuration.nix.'}
	}
	return {ok: true, config}
}

export function configDir(dataDir, id) {
	validateNixosConfigId(id)
	return join(String(dataDir), 'nixos-configs', String(id))
}

export async function ensureConfigDir(dataDir, id) {
	const dir = configDir(dataDir, id)
	await mkdir(dir, {recursive: true})
	return dir
}

export async function writeConfiguration(dataDir, id, config) {
	const checked = validateNixosConfig(config)
	if (!checked.ok) throw new Error(checked.error)
	if (!checked.config.trim()) throw new Error('Paste a NixOS configuration first.')
	const dir = await ensureConfigDir(dataDir, id)
	const body = checked.config.endsWith('\n') ? checked.config : `${checked.config}\n`
	await writeAtomic(join(dir, 'configuration.nix'), body, {mode: 0o644})
	return {path: join(dir, 'configuration.nix')}
}

export async function readConfiguration(dataDir, id) {
	try {
		const config = await readFile(join(configDir(dataDir, id), 'configuration.nix'), 'utf8')
		return {config, present: true}
	} catch (e) {
		if (e?.code === 'ENOENT') return {config: '', present: false}
		throw e
	}
}

export async function writeCacheFragment(dataDir, id, {enabled, substituter}) {
	const dir = await ensureConfigDir(dataDir, id)
	const path = join(dir, 'nix-cache.conf')
	const sub = String(substituter ?? '').trim()
	if (!enabled || !sub) {
		await rm(path, {force: true})
		return
	}
	if (!CACHE_URL.test(sub)) throw new Error('Use an http(s) URL for the binary cache.')
	await writeAtomic(path, `extra-substituters = ${sub}\n`, {mode: 0o644})
}