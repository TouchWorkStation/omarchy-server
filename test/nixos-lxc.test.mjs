import assert from 'node:assert/strict'
import {mkdtemp, readFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {configDir} from '../omarchyd/nixos-config.mjs'
import {createContainers} from '../omarchyd/containers.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const EXAMPLE = `{ config, pkgs, modulesPath, ... }:
{
  imports = [
    "\${modulesPath}/virtualisation/lxc-container.nix"
  ];
  system.stateVersion = "24.11";
  environment.systemPackages = with pkgs; [ vim ];
}
`

const NIXOS_IMAGE = {
	type: 'container',
	architecture: 'x86_64',
	properties: {os: 'nixos', release: '24.11', architecture: 'amd64', variant: 'default', description: 'NixOS 24.11'},
	aliases: [{name: 'nixos/24.11'}],
	size: 2_000_000,
}

const DEBIAN_IMAGE = {
	type: 'container',
	architecture: 'x86_64',
	properties: {os: 'debian', release: '12', architecture: 'amd64', variant: 'default', description: 'Debian 12'},
	aliases: [{name: 'debian/12'}],
	size: 2_000_000,
}

function mockRun(calls, {containers: list = []} = {}) {
	return async (args) => {
		calls.push(args)
		if (args[0] === 'query' && args[1] === '/1.0') return JSON.stringify({environment: {server_version: '6', project: 'default'}})
		if (args[0] === 'image' && args[1] === 'list') return JSON.stringify([NIXOS_IMAGE, DEBIAN_IMAGE])
		if (args[0] === 'list') return JSON.stringify(list)
		if (args[0] === 'launch' || args[0] === 'config') return ''
		if (args[0] === 'restart') return ''
		return ''
	}
}

function nixRow(name) {
	return {
		name,
		type: 'container',
		status: 'Running',
		config: {'image.os': 'nixos', 'image.release': '24.11', 'user.modc.nixos': 'true'},
		devices: {},
		state: {network: {}},
	}
}

async function waitCreate(calls, {name = 'nix1', tries = 80} = {}) {
	for (let i = 0; i < tries; i++) {
		if (calls.some((a) => a[0] === 'config' && a.includes('modc-nixos-config'))) return
		await new Promise((r) => setTimeout(r, 25))
	}
	throw new Error('timed out waiting for NixOS disk device')
}

test('create refuses nixosConfig on non-NixOS', async () => {
	const calls = []
	const dataDir = await mkdtemp(join(os.tmpdir(), 'lxc-nix-refuse-'))
	const p = createContainers({run: mockRun(calls), dataDir}).procedures
	await assert.rejects(
		() => p['containers.create'].run({name: 'deb1', image: 'debian/12', nixosConfig: EXAMPLE}),
		(err) => err instanceof RpcError && err.code === 'BAD_REQUEST',
	)
	assert.ok(!calls.some((a) => a[0] === 'launch'))
})

test('create NixOS writes share and adds disk device', async () => {
	const calls = []
	const dataDir = await mkdtemp(join(os.tmpdir(), 'lxc-nix-create-'))
	const p = createContainers({run: mockRun(calls), dataDir}).procedures
	await p['containers.create'].run({name: 'nix1', image: 'nixos/24.11', nixosConfig: EXAMPLE})
	await waitCreate(calls)
	assert.ok(calls.some((a) => a[0] === 'launch' && a.includes('security.nesting=true') && a.includes('user.modc.nixos=true')))
	assert.ok(calls.some((a) => a[0] === 'config' && a.includes('device') && a.includes('modc-nixos-config')))
	const mount = calls.find((a) => a[0] === 'config' && a.includes('modc-nixos-config'))
	assert.ok(mount?.includes(`path=/modc/nixos-config`))
	assert.ok(mount?.includes('readonly=true'))
	assert.ok(mount?.some((x) => String(x).startsWith(`source=${configDir(dataDir, 'nix1')}`)))
	const cfg = await readFile(join(dataDir, 'nixos-configs', 'nix1', 'configuration.nix'), 'utf8')
	assert.match(cfg, /stateVersion|systemPackages|config/)
	assert.ok(!calls.some((a) => a.some((x) => String(x).includes('nixos-rebuild'))))
})

test('setNixosConfig writes configuration on the host share', async () => {
	const calls = []
	const dataDir = await mkdtemp(join(os.tmpdir(), 'lxc-nix-set-'))
	const run = mockRun(calls, {containers: [nixRow('nix1')]})
	const p = createContainers({run, dataDir}).procedures
	const updated = `{ config, pkgs, ... }:\n{\n  system.stateVersion = "25.05";\n}\n`
	await p['containers.setNixosConfig'].run({name: 'nix1', config: updated})
	const cfg = await readFile(join(configDir(dataDir, 'nix1'), 'configuration.nix'), 'utf8')
	assert.match(cfg, /25\.05/)
	const got = await p['containers.nixosConfig'].run({name: 'nix1'})
	assert.equal(got.config.trim(), updated.trim())
})

test('applyNixosConfig restarts the container, never nixos-rebuild', async () => {
	const calls = []
	const dataDir = await mkdtemp(join(os.tmpdir(), 'lxc-nix-apply-'))
	const run = mockRun(calls, {containers: [nixRow('nix1')]})
	const p = createContainers({run, dataDir}).procedures
	await p['containers.applyNixosConfig'].run({name: 'nix1'})
	assert.ok(calls.some((a) => a[0] === 'restart' && a.includes('nix1')))
	assert.ok(!calls.some((a) => a.some((x) => String(x).includes('nixos-rebuild'))))
})

test('containerFrom exposes nixos from user.modc.nixos or image os', async () => {
	const {containerFrom} = await import('../omarchyd/containers.mjs')
	assert.equal(containerFrom({config: {'user.modc.nixos': 'true', 'image.os': 'debian'}}).nixos, true)
	assert.equal(containerFrom({config: {'image.os': 'nixos'}}).nixos, true)
	assert.equal(containerFrom({config: {'image.os': 'debian'}}).nixos, undefined)
})