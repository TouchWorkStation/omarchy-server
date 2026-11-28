import assert from 'node:assert/strict'
import {access, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {readNixCache, writeNixCache} from '../omarchyd/nix-cache.mjs'
import {configDir, validateNixosConfig, writeConfiguration} from '../omarchyd/nixos-config.mjs'
import {createMachines, nixosConfigFilesystemXml} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const EXAMPLE = `{ config, pkgs, ... }:
{
  system.stateVersion = "24.11";
}
`

const DEBIAN = {
	id: 'testos-amd64',
	familyId: 'debian',
	name: 'TestOS',
	version: '1',
	arch: 'amd64',
	kind: 'cloud',
	url: 'https://example.test/os.qcow2',
	checksums: {url: 'https://example.test/SHA256SUMS', algorithm: 'sha256'},
	sizeMb: 1,
	adminGroup: 'sudo',
}

const NIXOS = {
	id: 'modc-nixos-test-amd64',
	familyId: 'nixos',
	nixos: true,
	name: 'NixOS',
	version: '24.11',
	arch: 'amd64',
	kind: 'cloud',
	url: 'https://example.test/nixos.qcow2',
	sha256: '0'.repeat(64),
	sizeMb: 1,
	adminGroup: 'wheel',
}

async function openMachines(dataDir, catalogUrl) {
	await mkdir(dataDir, {recursive: true})
	const kvm = join(dataDir, 'kvm')
	await writeFile(kvm, '')
	const m = createMachines({
		dataDir,
		catalogUrl,
		arch: 'amd64',
		fetchImpl: async () => new Response('image', {status: 200}),
		run: async (cmd, args) => {
			if (cmd === 'virsh' && (args.at(-1) === '--version' || args[0] === '--version')) return '10.0.0\n'
			if (cmd === 'qemu-img' && args[0] === '--version') return '9.0.0\n'
			if (cmd === 'openssl') return '$6$rounds=5000$saltsalt$hash\n'
			if (cmd === 'xorriso') {
				await writeFile(args[args.indexOf('-output') + 1], 'iso')
				return ''
			}
			return ''
		},
		kvmDevice: kvm,
		watchIdleMs: 1,
		statsIntervalMs: 60_000,
	})
	await m.ready
	return m
}

test('domain XML helper mounts host NixOS config share at modc-nixos-config', () => {
	const dataDir = join('/data', 'omarchyd')
	const id = 'abcd1234'
	const source = configDir(dataDir, id)
	const fragment = nixosConfigFilesystemXml(source)
	assert.match(fragment, /virtio-9p/)
	assert.match(fragment, /accessmode='passthrough'/)
	assert.match(fragment, new RegExp(`source dir='${source.replaceAll('/', '\\/')}'`))
	assert.match(fragment, /target dir='modc-nixos-config'/)
	assert.match(fragment, /<readonly\/>/)
})

test('bundled catalog includes NixOS image', async () => {
	const bundled = fileURLToPath(new URL('../omarchyd/machine-catalog.json', import.meta.url))
	const {images} = JSON.parse(await readFile(bundled, 'utf8'))
	const img = images.find((i) => i.id === 'modc-nixos-24.11-amd64')
	assert.ok(img)
	assert.equal(img.familyId, 'nixos')
	assert.equal(img.nixos, true)
	assert.match(img.url, /nixos-v24\.11\.0\/modc-nixos-24\.11-amd64\.qcow2$/)
	assert.match(img.sha256, /^[0-9a-f]{64}$/)
	assert.notEqual(img.sha256, '0'.repeat(64))
})

test('create refuses nixosConfig on non-NixOS image', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'nixos-vm-refuse-'))
	try {
		const dataDir = join(root, 'data')
		const catalogUrl = join(root, 'catalog.json')
		await writeFile(catalogUrl, JSON.stringify({version: 1, images: [DEBIAN]}))
		const m = await openMachines(dataDir, catalogUrl)
		await assert.rejects(
			() =>
				m.procedures['machines.create'].run({
					name: 'Ubuntu-ish',
					osId: 'testos-amd64',
					cores: 1,
					memoryGb: 1,
					diskSizeGb: 10,
					username: 'chris',
					password: 'hunter2',
					nixosConfig: EXAMPLE,
				}),
			(e) => e instanceof RpcError && e.code === 'BAD_REQUEST' && /only for NixOS/i.test(e.message),
		)
	} finally {
		await mkdir(root, {recursive: true}).catch(() => {})
		const {rm} = await import('node:fs/promises')
		await rm(root, {recursive: true, force: true})
	}
})

test('create writes config share and records nixos flag', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'nixos-vm-create-'))
	try {
		const dataDir = join(root, 'data')
		const catalogUrl = join(root, 'catalog.json')
		await writeFile(catalogUrl, JSON.stringify({version: 1, images: [NIXOS]}))
		await mkdir(dataDir, {recursive: true})
		await writeNixCache(dataDir, {enabled: true, substituter: 'https://cache.example.test'})
		const m = await openMachines(dataDir, catalogUrl)
		const {id} = await m.procedures['machines.create'].run({
			name: 'NixBox',
			osId: NIXOS.id,
			cores: 1,
			memoryGb: 1,
			diskSizeGb: 10,
			username: 'chris',
			password: 'hunter2',
			nixosConfig: EXAMPLE,
		})
		const saved = JSON.parse(await readFile(join(dataDir, 'machines', 'machines.json'), 'utf8'))
		const rec = saved.machines.find((x) => x.id === id)
		assert.equal(rec?.nixos, true)
		const cfg = await readFile(join(configDir(dataDir, id), 'configuration.nix'), 'utf8')
		assert.equal(validateNixosConfig(cfg).ok, true)
		const cache = await readNixCache(dataDir)
		const fragment = await readFile(join(configDir(dataDir, id), 'nix-cache.conf'), 'utf8')
		assert.match(fragment, new RegExp(cache.substituter.replaceAll('/', '\\/')))
		await access(join(dataDir, 'nixos-configs', id, 'configuration.nix'))
		await new Promise((r) => setTimeout(r, 50))
	} finally {
		const {rm} = await import('node:fs/promises')
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}).catch(() => {})
	}
})

test('setNixosConfig writes configuration on the host share', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'nixos-vm-set-'))
	try {
		const dataDir = join(root, 'data')
		const catalogUrl = join(root, 'catalog.json')
		await writeFile(catalogUrl, JSON.stringify({version: 1, images: [NIXOS]}))
		const m = await openMachines(dataDir, catalogUrl)
		const {id} = await m.procedures['machines.create'].run({
			name: 'NixSet',
			osId: NIXOS.id,
			cores: 1,
			memoryGb: 1,
			diskSizeGb: 10,
			username: 'chris',
			password: 'hunter2',
			nixosConfig: EXAMPLE,
		})
		const updated = `{ config, pkgs, ... }:\n{\n  system.stateVersion = "25.05";\n}\n`
		await m.procedures['machines.setNixosConfig'].run({id, config: updated})
		const cfg = await readFile(join(configDir(dataDir, id), 'configuration.nix'), 'utf8')
		assert.match(cfg, /25\.05/)
		const got = await m.procedures['machines.nixosConfig'].run({id})
		assert.equal(got.config.trim(), updated.trim())
		await new Promise((r) => setTimeout(r, 50))
	} finally {
		const {rm} = await import('node:fs/promises')
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}).catch(() => {})
	}
})

test('applyNixosConfig restarts the guest', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'nixos-vm-apply-'))
	try {
		const dataDir = join(root, 'data')
		const catalogUrl = join(root, 'catalog.json')
		await writeFile(catalogUrl, JSON.stringify({version: 1, images: [NIXOS]}))
		const id = 'a1b2c3d4'
		const vmDir = join(dataDir, 'machines', 'vms', id)
		await mkdir(vmDir, {recursive: true})
		await writeFile(join(vmDir, 'disk.qcow2'), '')
		const rebooted = []
		const kvm = join(dataDir, 'kvm')
		await writeFile(kvm, '')
		await writeConfiguration(dataDir, id, EXAMPLE)
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [
					{
						id,
						vmid: 100,
						name: 'NixApply',
						osId: NIXOS.id,
						nixos: true,
						sockets: 1,
						cores: 1,
						memoryMb: 1024,
						memoryGb: 1,
						diskSizeGb: 10,
						mac: '52:54:00:11:22:33',
						portForwards: [],
						createdAt: 1,
						boot: ['disk0'],
						options: {},
						layout: {
							firmware: 'bios',
							machineType: 'q35',
							nic: 'virtio',
							video: 'vga',
							disks: [{id: 'disk0', file: join(vmDir, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}],
						},
					},
				],
			}),
		)
		const m = createMachines({
			dataDir,
			catalogUrl,
			arch: 'amd64',
			fetchImpl: async () => new Response('image', {status: 200}),
			run: async (cmd, args) => {
				if (cmd === 'virsh' && args.includes('reboot')) {
					rebooted.push(args[args.indexOf('reboot') + 1])
					return ''
				}
				if (cmd === 'virsh' && (args.at(-1) === '--version' || args[0] === '--version')) return '10.0.0\n'
				if (cmd === 'virsh' && args.includes('list') && args.includes('--all')) {
					return ` Id   Name                State\n------------------------------\n 1    omarchy-${id}    running\n`
				}
				if (cmd === 'virsh' && args.includes('domstate')) return 'running\n'
				if (cmd === 'qemu-img' && args[0] === '--version') return '9.0.0\n'
				return ''
			},
			kvmDevice: kvm,
			watchIdleMs: 1,
			statsIntervalMs: 60_000,
		})
		await m.ready
		await m.procedures['machines.applyNixosConfig'].run({id})
		assert.ok(rebooted.length >= 1)
		assert.ok(rebooted.some((d) => d.includes(id)))
		await new Promise((r) => setTimeout(r, 50))
	} finally {
		const {rm} = await import('node:fs/promises')
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}).catch(() => {})
	}
})