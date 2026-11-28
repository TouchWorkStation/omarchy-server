import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, readFile, access} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {
	isNixosOs,
	validateNixosConfig,
	validateNixosConfigId,
	writeConfiguration,
	readConfiguration,
	writeCacheFragment,
	configDir,
} from '../omarchyd/nixos-config.mjs'

test('isNixosOs', () => {
	assert.equal(isNixosOs('nixos'), true)
	assert.equal(isNixosOs('NixOS'), true)
	assert.equal(isNixosOs('debian'), false)
})

test('validateNixosConfigId rejects unsafe ids', () => {
	assert.throws(() => validateNixosConfigId(''), /not valid/)
	assert.throws(() => validateNixosConfigId('a/b'), /not valid/)
	assert.throws(() => validateNixosConfigId('..'), /not valid/)
	assert.equal(validateNixosConfigId('vm1'), 'vm1')
})

test('validate rejects null bytes and junk', () => {
	assert.equal(validateNixosConfig('').ok, true)
	assert.equal(validateNixosConfig('not nix').ok, false)
	assert.equal(validateNixosConfig('x\0').ok, false)
})

test('write and read configuration.nix on the share', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'nixos-cfg-'))
	const body = `{ config, pkgs, ... }:\n{\n  system.stateVersion = "24.11";\n}\n`
	assert.equal(validateNixosConfig(body).ok, true)
	await writeConfiguration(dataDir, 'vm1', body)
	const got = await readConfiguration(dataDir, 'vm1')
	assert.equal(got.present, true)
	assert.match(got.config, /stateVersion/)
	assert.equal(configDir(dataDir, 'vm1'), join(dataDir, 'nixos-configs', 'vm1'))
})

test('cache fragment written only when enabled', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'nixos-cfg-'))
	await writeConfiguration(dataDir, 'vm1', `{ config, pkgs, ... }:\n{ system.stateVersion = "24.11"; }\n`)
	await writeCacheFragment(dataDir, 'vm1', {enabled: true, substituter: 'http://10.0.0.1:5000'})
	const conf = await readFile(join(dataDir, 'nixos-configs', 'vm1', 'nix-cache.conf'), 'utf8')
	assert.match(conf, /extra-substituters = http:\/\/10\.0\.0\.1:5000/)
	await writeCacheFragment(dataDir, 'vm1', {enabled: false, substituter: ''})
	await assert.rejects(() => access(join(dataDir, 'nixos-configs', 'vm1', 'nix-cache.conf')))
})