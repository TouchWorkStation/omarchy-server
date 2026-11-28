import assert from 'node:assert/strict'
import {mkdtemp, readFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createContainers} from '../omarchyd/containers.mjs'
import {readLxcStatus, remoteHostStatus} from '../omarchyd/remote-containers.mjs'

const DEB_IMG = {
	type: 'container',
	architecture: 'x86_64',
	aliases: [{name: 'debian/12'}],
	properties: {os: 'Debian', release: '12', variant: 'default', architecture: 'amd64'},
}

test('readLxcStatus maps unavailable Incus with setup command', () => {
	const s = readLxcStatus({available: false, reason: 'Incus isn’t installed', setupCommand: 'machines-add-lxc'})
	assert.equal(s.available, false)
	assert.match(s.reason, /Incus/)
	assert.equal(s.setupCommand, 'machines-add-lxc')
})

test('containers.hostStatus on a remote computer surfaces setup when Incus is missing', async () => {
	const hostId = 'abcdabcdabcd'
	const calls = []
	const mod = createContainers({
		run: async () => JSON.stringify({environment: {server_version: '6.8', project: 'user-1000'}}),
		connector: {
			list: async () => [{id: hostId, name: 'Kitchen', online: true}],
			call: async (id, name, args, timeout) => {
				calls.push({id, name, args, timeout})
				if (name === 'lxc-status') return JSON.stringify({available: false, reason: 'Incus isn’t installed on this computer yet.', setupCommand: 'machines-add-lxc'})
				throw new Error('unexpected')
			},
		},
	})
	const s = await mod.procedures['containers.hostStatus'].run({hostId})
	assert.equal(s.available, false)
	assert.equal(s.hostName, 'Kitchen')
	assert.equal(s.setupCommand, 'machines-add-lxc')
	assert.deepEqual(calls.map((c) => c.name), ['lxc-status'])
})

test('create on a remote host refuses when Incus is unavailable', async () => {
	const hostId = 'abcdabcdabcd'
	const mod = createContainers({
		run: async (args) => {
			if (args[0] === 'list') return '[]'
			if (args[0] === 'image') return JSON.stringify([DEB_IMG])
			return ''
		},
		connector: {
			list: async () => [{id: hostId, name: 'Garage', online: true}],
			call: async (id, name) => {
				if (name === 'lxc-status') return JSON.stringify({available: false, reason: 'No Incus', setupCommand: 'machines-add-lxc'})
				if (name === 'lxc-list') return '[]'
				throw new Error('unexpected ' + name)
			},
		},
	})
	await assert.rejects(
		() =>
			mod.procedures['containers.create'].run({
				hostId,
				name: 'web',
				image: 'debian/12',
				diskGiB: 8,
			}),
		(err) => {
			assert.equal(err.code, 'PRECONDITION_FAILED')
			assert.match(err.message, /Garage/)
			assert.match(err.message, /machines-add-lxc/)
			return true
		},
	)
})

test('remote create refuses a root password instead of dropping it', async () => {
	const hostId = 'abcdabcdabcd'
	const calls = []
	const mod = createContainers({
		run: async (args) => {
			if (args[0] === 'list') return '[]'
			if (args[0] === 'image') return JSON.stringify([DEB_IMG])
			return ''
		},
		connector: {
			list: async () => [{id: hostId, name: 'Garage', online: true}],
			call: async (id, name, args) => {
				calls.push(name)
				if (name === 'lxc-status') return JSON.stringify({available: true, version: '6'})
				if (name === 'lxc-list') return '[]'
				if (name === 'lxc-launch') return JSON.stringify({name: args.name})
				throw new Error('unexpected ' + name)
			},
		},
	})
	await assert.rejects(
		() =>
			mod.procedures['containers.create'].run({
				hostId,
				name: 'web',
				image: 'debian/12',
				diskGiB: 8,
				rootPassword: 'correct-horse',
			}),
		(err) => err.code === 'PRECONDITION_FAILED' && /this server/.test(err.message),
	)
	assert.deepEqual(calls.filter((n) => n === 'lxc-launch'), [])
})

test('creating a container is allowed to outlast the short web timeout', async () => {
	const src = await readFile(new URL('../server/app.mjs', import.meta.url), 'utf8')
	const slow = src.match(/export const SLOW = new Set\(\[([\s\S]*?)\]\)/)
	assert.ok(slow, 'SLOW set')
	assert.match(slow[1], /'containers\.create'/)
})

test('list merges local and remote containers with hostId', async () => {
	const hostId = 'abcdabcdabcd'
	const remote = [
		{
			name: 'edge',
			type: 'container',
			status: 'Running',
			config: {'image.os': 'Alpine', 'image.release': '3.21'},
			devices: {},
			state: {network: {}},
		},
	]
	const mod = createContainers({
		run: async (args) => {
			if (args[0] === 'list') return JSON.stringify([{name: 'local', type: 'container', status: 'Running', config: {}, devices: {}, state: {network: {}}}])
			return JSON.stringify({environment: {}})
		},
		connector: {
			list: async () => [{id: hostId, name: 'Loft', online: true}],
			call: async (id, name) => {
				if (name === 'lxc-list') return JSON.stringify(remote)
				return '[]'
			},
		},
	})
	const rows = await mod.procedures['containers.list'].run()
	assert.deepEqual(
		rows.map((r) => [r.name, r.hostId]),
		[
			['edge', hostId],
			['local', 'server'],
		],
	)
})

const NIXOS_IMAGE = {
	type: 'container',
	architecture: 'x86_64',
	aliases: [{name: 'nixos/24.11'}],
	properties: {os: 'nixos', release: '24.11', variant: 'default', architecture: 'amd64'},
}

const NIXOS_CONFIG = `{ config, pkgs, modulesPath, ... }:
{
  imports = [ "\${modulesPath}/virtualisation/lxc-container.nix" ];
  system.stateVersion = "24.11";
}
`

test('remote NixOS create writes config on host then launches with share', async () => {
	const hostId = 'abcdabcdabcd'
	const calls = []
	const dir = await mkdtemp(join(os.tmpdir(), 'remote-nix-'))
	const mod = createContainers({
		dataDir: dir,
		run: async (args) => {
			if (args[0] === 'list') return '[]'
			if (args[0] === 'image') return JSON.stringify([NIXOS_IMAGE, DEB_IMG])
			return ''
		},
		connector: {
			list: async () => [{id: hostId, name: 'Kitchen', online: true}],
			call: async (id, name, args) => {
				calls.push({id, name, args})
				if (name === 'lxc-status') return JSON.stringify({available: true, version: '6', project: 'default'})
				if (name === 'lxc-list') return '[]'
				if (name === 'lxc-write-config') return JSON.stringify({ok: true, path: '/tmp/share'})
				if (name === 'lxc-launch') return JSON.stringify({name: args.name})
				throw new Error('unexpected ' + name)
			},
		},
	})
	await mod.procedures['containers.create'].run({
		hostId,
		name: 'nixedge',
		image: 'nixos/24.11',
		diskGiB: 8,
		nixosConfig: NIXOS_CONFIG,
	})
	const names = calls.map((c) => c.name)
	assert.ok(names.includes('lxc-status'))
	assert.ok(names.includes('lxc-write-config'))
	assert.ok(names.includes('lxc-launch'))
	const write = calls.find((c) => c.name === 'lxc-write-config')
	assert.equal(write.args.name, 'nixedge')
	assert.match(write.args.configuration, /stateVersion/)
	const launch = calls.find((c) => c.name === 'lxc-launch')
	assert.equal(launch.args.nixosShare, true)
	assert.ok(launch.args.configs.some((c) => c === 'security.nesting=true'))
})

test('remoteHostStatus requires an online agent', async () => {
	await assert.rejects(
		() =>
			remoteHostStatus({
				connector: {call: async () => '{}'},
				agents: [{id: 'abcdabcdabcd', name: 'Away', online: false}],
				hostId: 'abcdabcdabcd',
			}),
		(err) => err.code === 'PRECONDITION_FAILED',
	)
})