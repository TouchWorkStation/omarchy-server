// omarchyd machines: catalog, verified downloads, cloud-init seed, libvirt calls, port forwards and
// the VNC console bridge. libvirt, qemu-img and xorriso are simulated; openssl is real.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import {copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'
import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {cloudUserData, isWindowsClientLabel, omarchyConfiguration, windowsAnswerFile} from '../omarchyd/machine-media.mjs'
import {findChecksum} from '../omarchyd/machines.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

test('findChecksum reads GNU and BSD checksum lists', () => {
	const h = 'a'.repeat(64)
	assert.equal(findChecksum(`${'b'.repeat(64)}  other.img\n${h} *disk.img\n`, 'disk.img', 'sha256'), h)
	assert.equal(findChecksum(`SHA256 (disk.img) = ${h}\n`, 'disk.img', 'sha256'), h)
	assert.equal(findChecksum(`${h}  disk.img\n`, 'disk.img', 'sha512'), null) // wrong length for sha512
	assert.equal(findChecksum(`${h}  disk.img.part\n`, 'disk.img', 'sha256'), null)
})

test('install media: desktop cloud-init, Omarchy disk layout, Windows answer file', () => {
	const ud = cloudUserData({host: 'box', username: 'chris', hash: '$6$x', cloudInit: {packages: ['ubuntu-desktop-minimal', 'bad;rm -rf /'], commands: [['systemctl', 'set-default', 'graphical.target']], graphical: true}})
	assert.match(ud, /packages:\n  - 'ubuntu-desktop-minimal'\n/)
	assert.ok(!ud.includes('rm -rf'), 'unsafe package names dropped')
	assert.match(ud, /runcmd:\n  - \["systemctl","set-default","graphical.target"\]/)
	assert.match(ud, /power_state:\n  mode: reboot/)
	const cfg = omarchyConfiguration({host: 'om', diskSizeGb: 40})
	const parts = cfg.disk_config.device_modifications[0].partitions
	assert.equal(cfg.disk_config.device_modifications[0].device, '/dev/vda')
	assert.equal(parts[0].start.value + parts[0].size.value + parts[1].size.value + 1024 ** 2, 40 * 1024 ** 3)
	assert.equal(isWindowsClientLabel('CCCOMA_X64FRE_EN-US_DV9'), true)
	assert.equal(isWindowsClientLabel('ARCH_202611'), false)
	const xml = windowsAnswerFile({computerName: 'MY-PC & stuff', username: 'chris', password: 'hunter2 secret'})
	assert.ok(!xml.includes('hunter2'), 'password not in plain text')
	assert.match(xml, /<ComputerName>MY-PCstuff<\/ComputerName>/)
	assert.match(xml, /BypassTPMCheck/)
	assert.match(xml, /<Name>chris<\/Name>/)
	assert.equal(Buffer.from(/<Value>([^<]+)<\/Value>/.exec(xml)[1], 'base64').toString('utf16le'), 'hunter2 secretPassword')
})

describe('omarchyd machines', () => {
	let root, data, d, fixture, fixtureUrl, auth
	const doms = new Map()
	const seen = {userData: '', xml: '', media: {}, calls: []}
	const image = randomBytes(256 * 1024)

	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'virsh' || cmd === 'qemu-img') seen.calls.push([cmd, ...(args[0] === '-c' ? args.slice(2) : args)].join(' '))
		if (cmd === 'virsh') {
			const a = args[0] === '-c' ? args.slice(2) : args
			switch (a[0]) {
				case 'suspend':
					doms.set(a[1], 'paused')
					return ''
				case 'resume':
					doms.set(a[1], 'running')
					return ''
				case 'managedsave':
					doms.set(a[1], 'shut off')
					return ''
				case 'blockresize':
				case 'change-media':
				case 'domstats':
				case 'domifaddr':
					return ''
				case 'version':
					return 'Compiled against library: libvirt 10.0.0\nRunning hypervisor: QEMU 9.0.0\n'
				case 'qemu-monitor-command':
					return `VM status: running (${a.at(-1)})\n`
				case 'backup-begin': {
					const bx = await readFile(a[3], 'utf8')
					for (const [, f] of bx.matchAll(/<target file='([^']+)'/g)) await writeFile(f, 'live-copy')
					return 'Backup started\n'
				}
				case 'domjobinfo':
					return a.includes('--completed') ? 'Job type:         Completed\n' : 'Job type:         None\n'
				case '--version':
					return '10.0.0\n'
				case 'list':
					return ` Id   Name   State\n------------------\n${[...doms].map(([n, s]) => ` -    ${n}   ${s}`).join('\n')}\n`
				case 'define': {
					if (seen.failDefine) throw new Error("virsh define: error: unsupported configuration: domain configuration does not support video model 'virtio'")
					seen.xml = await readFile(a[1], 'utf8')
					const name = /<name>(.+?)<\/name>/.exec(seen.xml)[1]
					if (!doms.has(name)) doms.set(name, 'shut off')
					return ''
				}
				case 'start':
					doms.set(a[1], 'running')
					return ''
				case 'shutdown':
				case 'destroy':
					doms.set(a[1], 'shut off')
					return ''
				case 'reboot':
					return ''
				case 'undefine':
					doms.delete(a[1])
					return ''
			}
			throw new Error(`virsh ${a[0]} not simulated`)
		}
		if (cmd === 'qemu-img') {
			if (args[0] === 'convert') await copyFile(args.at(-2), args.at(-1))
			if (args[0] === 'create') await writeFile(args[3], 'blank')
			return 'qemu-img version 9.0\n'
		}
		if (cmd === 'xorriso') {
			if (args.includes('-pvd_info')) return `Volume Id    : ${/Win11/.test(args[1]) ? 'CCCOMA_X64FRE_EN-US_DV9' : 'ARCH_202611'}\n`
			for (const f of args.slice(args.indexOf('-rock') + 1)) seen.media[f] = await readFile(join(opts.cwd, f), 'utf8')
			seen.userData = seen.media['user-data'] ?? seen.userData
			await writeFile(args[args.indexOf('-output') + 1], 'iso')
			return ''
		}
		if (cmd === 'openssl') return execFileSync('openssl', args, {input: opts.input}).toString()
		throw new Error(`${cmd} not simulated`)
	}

	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-m-'))
		data = join(root, 'data')
		const sum = createHash('sha256').update(image).digest('hex')
		fixture = http.createServer((req, res) => {
			const files = {
				'/catalog.json': JSON.stringify({
					version: 1,
					images: [
						{id: 'testos-amd64', familyId: 'debian', name: 'TestOS', variantName: 'Server', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://fixture.test/img/test.qcow2', checksums: {url: 'https://fixture.test/img/SHA256SUMS', algorithm: 'sha256'}, sizeMb: 1, adminGroup: 'sudo'},
						{id: 'bados-amd64', familyId: 'debian', name: 'BadOS', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://fixture.test/img/bad.qcow2', checksums: {url: 'https://fixture.test/img/SHA256SUMS', algorithm: 'sha256'}, sizeMb: 1},
						{id: 'omarchy-9-amd64', familyId: 'omarchy', name: 'Omarchy', version: '9', arch: 'amd64', kind: 'iso', install: 'omarchy', url: 'https://fixture.test/img/omarchy.iso', sha256: createHash('sha256').update(image).digest('hex'), sizeMb: 1},
						{id: 'insecure', name: 'Plain HTTP', version: '1', arch: 'amd64', kind: 'cloud', url: 'http://fixture.test/x.img', checksums: {url: 'https://fixture.test/s', algorithm: 'sha256'}},
					],
				}),
				'/img/test.qcow2': image,
				'/img/omarchy.iso': image,
				'/img/bad.qcow2': randomBytes(1000),
				'/img/SHA256SUMS': `${sum} *test.qcow2\n${'0'.repeat(64)} *bad.qcow2\n`,
			}
			const body = files[req.url]
			if (body === undefined) return res.writeHead(404).end()
			res.writeHead(200, {'content-length': Buffer.byteLength(body)}).end(body)
		})
		await new Promise((r) => fixture.listen(0, '127.0.0.1', r))
		fixtureUrl = `http://127.0.0.1:${fixture.address().port}`
		await mkdir(join(root, 'home/Downloads'), {recursive: true})
		await writeFile(join(root, 'home/Downloads/Win11_25H2_English_x64.iso'), 'win')
		await writeFile(join(root, 'home/Downloads/archlinux.iso'), 'arch')
		const kvm = join(root, 'kvm')
		await writeFile(kvm, '')
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home: join(root, 'home'),
			machineOptions: {run, kvmDevice: kvm, catalogUrl: 'https://fixture.test/catalog.json', fetchImpl: (u, init) => fetch(String(u).replace('https://fixture.test', fixtureUrl), init)},
		})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`}
	})
	after(async () => {
		await d.close()
		fixture.close()
		await rm(root, {recursive: true, force: true})
	})
	const call = async (path, input, kind = 'mutation') => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...auth}}
		if (kind === 'mutation') Object.assign(init.headers, {'content-type': 'application/json'}), (init.body = JSON.stringify(input ?? null))
		else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const r = await fetch(url, init)
		const body = await r.json()
		if (body.error) {
			const e = new Error(body.error.message)
			e.status = r.status
			throw e
		}
		return body.result.data
	}
	const q = (path, input) => call(path, input, 'query')
	const until = async (fn, ms = 5000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn()
			if (v) return v
			if (Date.now() > end) throw new Error('timed out')
			await new Promise((r) => setTimeout(r, 50))
		}
	}
	const spec = {cores: 1, memoryGb: 1, diskSizeGb: 10, arch: 'amd64', username: 'chris', password: 'hunter2 secret'}
	let id

	test('capabilities and catalog (plain-HTTP entries are dropped)', async () => {
		const caps = await q('machines.capabilities')
		assert.equal(caps.libvirtAvailable, true)
		assert.equal(caps.kvmAvailable, true)
		const imgs = await q('machines.osImages')
		assert.deepEqual(imgs.map((i) => [i.id, i.state]), [['testos-amd64', 'available'], ['bados-amd64', 'available'], ['omarchy-9-amd64', 'available']])
	})

	test('create: verifies the download, hashes the password, defines and starts the machine', async () => {
		await assert.rejects(call('machines.create', {...spec, name: 'Box', osId: 'testos-amd64', username: 'root'}), /lower-case username/)
		;({id} = await call('machines.create', {...spec, name: 'Box', osId: 'testos-amd64'}))
		const m = await until(async () => (await q('machines.list')).find((x) => x.id === id && x.state === 'running'))
		assert.equal(m.name, 'Box')
		assert.match(seen.userData, /passwd: '\$6\$/)
		assert.ok(!seen.userData.includes('hunter2'), 'plaintext password never written')
		assert.match(seen.xml, /<backend type='passt'\/>/)
		assert.match(seen.xml, /<graphics type='vnc' socket='[^']+vnc\.sock'\/>/)
		assert.match(seen.xml, /<domain type='kvm'>/)
		assert.equal((await stat(join(data, 'machines/vms', id, 'disk.qcow2'))).size, image.length)
		assert.equal((await q('machines.osImages'))[0].state, 'downloaded')
		await assert.rejects(call('machines.create', {...spec, name: 'box', osId: 'testos-amd64'}), /already exists/)
	})

	test('create: a checksum mismatch fails and keeps nothing', async () => {
		const {id: bad} = await call('machines.create', {...spec, name: 'Bad', osId: 'bados-amd64'})
		const m = await until(async () => (await q('machines.list')).find((x) => x.id === bad && x.state === 'error'))
		assert.match(m.errorMessage, /checksum/)
		assert.equal((await q('machines.osImages')).find((i) => i.id === 'bados-amd64').state, 'failed')
		await call('machines.uninstall', {id: bad})
	})

	test('port forwards: validated, then written into the definition', async () => {
		await assert.rejects(call('machines.updateSettings', {id, portForwards: [{protocol: 'tcp', hostPort: 8080, guestPort: 80}]}), /between 40000/)
		await assert.rejects(call('machines.updateSettings', {id, portForwards: [{protocol: 'tcp', hostPort: 42222, guestPort: 22}, {protocol: 'tcp', hostPort: 42222, guestPort: 23}]}), /already forwarded/)
		await call('machines.updateSettings', {id, portForwards: [{protocol: 'tcp', hostPort: 42222, guestPort: 22}]})
		assert.match(seen.xml, /<portForward proto='tcp'><range start='42222' to='22'\/><\/portForward>/)
		assert.equal((await q('machines.list')).find((x) => x.id === id).portForwards[0].hostPort, 42222)
	})

	test('console: a ticket opens the VNC socket once; no ticket, no screen', async () => {
		const sockPath = join(data, 'machines/vms', id, 'vnc.sock')
		const vnc = net.createServer((s) => {
			s.write('RFB 003.008\n')
			s.on('data', (x) => s.write(x))
		})
		await new Promise((r) => vnc.listen(sockPath, r))
		const wsUrl = `${d.url.replace('http', 'ws')}/machines/console?machineId=${id}`
		const refused = new WebSocket(`${wsUrl}&ticket=nope`, ['binary'])
		await new Promise((r) => refused.on('error', r))
		const termTicket = await call('user.createWebSocketTicket', {target: 'terminal'})
		const wrongKind = new WebSocket(`${wsUrl}&ticket=${termTicket}`, ['binary'])
		await new Promise((r) => wrongKind.on('error', r)) // a terminal ticket can't open a screen
		const ticket = await call('user.createWebSocketTicket', {target: 'machines'})
		const ws = new WebSocket(`${wsUrl}&ticket=${ticket}`, ['binary'])
		const first = await new Promise((r, j) => (ws.once('message', (m) => r(m.toString())), ws.once('error', j)))
		assert.equal(first, 'RFB 003.008\n')
		ws.send(Buffer.from('ping'))
		assert.equal(await new Promise((r) => ws.once('message', (m) => r(m.toString()))), 'ping')
		ws.close()
		const reused = new WebSocket(`${wsUrl}&ticket=${ticket}`, ['binary'])
		await new Promise((r) => reused.on('error', r))
		vnc.close()
	})

	test('Omarchy installs itself from its ISO with a cidata drive (hash only)', async () => {
		const {id: om} = await call('machines.create', {...spec, name: 'Omarchy', osId: 'omarchy-9-amd64', diskSizeGb: 40})
		await until(async () => (await q('machines.list')).find((x) => x.id === om && x.state === 'running'))
		const creds = JSON.parse(seen.media['user_credentials.json'])
		assert.equal(creds.users[0].username, 'chris')
		assert.match(creds.users[0].enc_password, /^\$6\$/)
		assert.ok(!seen.media['user_credentials.json'].includes('hunter2'))
		assert.equal(JSON.parse(seen.media['user_configuration.json']).hostname, 'omarchy')
		assert.match(seen.xml, /<os firmware='efi'>/)
		assert.match(seen.xml, /omarchy-9-amd64\.iso'\/><target dev='sda' bus='sata'\/><boot order='2'\/>/)
		assert.match(seen.xml, /disk\.qcow2'\/><target dev='vda' bus='virtio'\/><boot order='1'\/>/)
		assert.match(seen.xml, /seed\.iso'\/><target dev='sdb' bus='sata'\/><readonly\/>/)
		await call('machines.uninstall', {id: om})
	})

	test('your own ISOs: Windows installs itself with an answer file that is removed after; others boot to install by hand', async () => {
		const isos = await q('machines.localIsos')
		const win = isos.find((i) => /Win11/.test(i.id))
		const arch = isos.find((i) => /archlinux/.test(i.id))
		assert.deepEqual([win.platform, win.requiresCredentials, win.manualSetup], ['windows', true, false])
		assert.deepEqual([arch.platform, arch.requiresCredentials, arch.manualSetup], ['linux', false, true])
		await assert.rejects(call('machines.create', {...spec, name: 'Win', osId: win.id, diskSizeGb: 40}), /between 64/)
		const {id: w} = await call('machines.create', {...spec, name: 'Win', osId: win.id, diskSizeGb: 64})
		await until(async () => (await q('machines.list')).find((x) => x.id === w && x.state === 'running'))
		assert.match(seen.media['autounattend.xml'], /<Name>chris<\/Name>/)
		assert.match(seen.xml, /<model type='e1000e'\/>/)
		assert.match(seen.xml, /<model type='vga'\/>/)
		assert.match(seen.xml, /disk\.qcow2'\/><target dev='sda' bus='sata'\/><boot order='1'\/>/)
		assert.match(seen.xml, /answer\.iso/)
		await call('machines.forceStop', {id: w})
		assert.ok(!seen.xml.includes('answer.iso'), 'answer file detached')
		await assert.rejects(stat(join(data, 'machines/vms', w, 'answer.iso')))
		await call('machines.uninstall', {id: w})
		const {id: a} = await call('machines.create', {name: 'Arch ISO', osId: arch.id, cores: 1, memoryGb: 1, diskSizeGb: 10})
		await until(async () => (await q('machines.list')).find((x) => x.id === a && x.state === 'running'))
		assert.match(seen.xml, /archlinux\.iso'\/><target dev='sda' bus='sata'\/><boot order='2'\/>/)
		assert.ok(!/seed\.iso|answer\.iso/.test(seen.xml))
		await call('machines.uninstall', {id: a})
	})

	test('a setup that failed at the last step is finished by Start; displays use standard VGA', async () => {
		seen.failDefine = true
		const {id: f} = await call('machines.create', {...spec, name: 'Flaky', osId: 'testos-amd64'})
		const m = await until(async () => (await q('machines.list')).find((x) => x.id === f && x.state === 'error'))
		assert.match(m.errorMessage, /video model/)
		seen.failDefine = false
		await call('machines.start', {id: f})
		await until(async () => (await q('machines.list')).find((x) => x.id === f && x.state === 'running'))
		assert.match(seen.xml, /<video><model type='vga'\/><\/video>/)
		await call('machines.uninstall', {id: f})
	})

	test('details: hardware, drives, boot order and options of a machine', async () => {
		const det = await q('machines.details', {id})
		assert.equal(det.vmid >= 100, true)
		assert.deepEqual([det.hardware.sockets, det.hardware.cores, det.hardware.memoryMb, det.hardware.cpuType, det.hardware.machineType], [1, 1, 1024, 'host', 'q35'])
		assert.deepEqual(det.hardware.disks.map((x) => [x.id, x.device, x.bus, x.target, x.role]), [['disk0', 'disk', 'virtio', 'vda', null], ['seed', 'cdrom', 'sata', 'sda', 'seed']])
		assert.deepEqual(det.boot, ['disk0'])
		assert.equal(det.cloudInit.username, 'chris')
		assert.match(det.hardware.mac, /^52:54:00:/)
		const node = await q('machines.node')
		assert.ok(node.threads >= 1 && node.memoryTotalMb > 0)
		assert.equal(node.libvirtVersion, '10.0.0')
		assert.ok(node.videoModels.includes('vga'))
	})

	test('hardware: changes while running are kept for the next start; Restart applies them', async () => {
		await assert.rejects(call('machines.updateHardware', {id, sockets: 1, cores: 9999}), /Sockets × cores/)
		await assert.rejects(call('machines.updateHardware', {id, mac: '01:00:5e:00:00:01'}), /unicast MAC/)
		await call('machines.updateHardware', {id, memoryMb: 1536, cpuType: 'qemu64', nic: 'e1000', linkDown: true, mac: '52:54:00:aa:bb:cc'})
		assert.match(seen.xml, /<memory unit='MiB'>1536<\/memory>/)
		assert.match(seen.xml, /<model fallback='allow'>qemu64<\/model><topology sockets='1' dies='1' cores='1' threads='1'\/>/)
		assert.match(seen.xml, /<mac address='52:54:00:aa:bb:cc'\/><model type='e1000'\/><link state='down'\/>/)
		assert.equal((await q('machines.list')).find((x) => x.id === id).pending, true)
		seen.calls.length = 0
		await call('machines.restart', {id})
		assert.ok(seen.calls.includes(`virsh shutdown omarchy-${id}`) && seen.calls.includes(`virsh start omarchy-${id}`), 'a full stop and start')
		await until(async () => !(await q('machines.list')).find((x) => x.id === id).pending)
		await call('machines.updateHardware', {id, memoryMb: 1024, cpuType: 'host', nic: 'virtio', linkDown: false})
		await call('machines.forceStop', {id})
		await call('machines.start', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'running')
	})

	test('options: notes, protection, guest agent, boot menu', async () => {
		await call('machines.updateOptions', {id, notes: 'Web <server>', protection: true, agent: true, bootMenu: true, onBoot: true, startupOrder: 2, startupDelay: 10})
		assert.match(seen.xml, /<description>Web &lt;server&gt;<\/description>/)
		assert.match(seen.xml, /org\.qemu\.guest_agent\.0/)
		assert.match(seen.xml, /<bootmenu enable='yes'/)
		await assert.rejects(call('machines.uninstall', {id}), /protected/)
		await assert.rejects(call('machines.updateOptions', {id, startupDelay: 9999}), /Start delay/)
		await call('machines.updateOptions', {id, protection: false, agent: false, bootMenu: false, onBoot: false, notes: ''})
		assert.ok(!seen.xml.includes('guest_agent'))
	})

	test('drives: add a SCSI disk, grow it live, CD/DVD media, boot order; removing needs a shut-down machine', async () => {
		const {diskId} = await call('machines.addDisk', {id, sizeGb: 8, bus: 'scsi', cache: 'writeback'})
		assert.equal(diskId, 'disk1')
		assert.match(seen.xml, /<controller type='scsi' model='virtio-scsi'\/>/)
		assert.match(seen.xml, /cache='writeback' discard='unmap'\/><source file='[^']+disk1\.qcow2'\/><target dev='sdb' bus='scsi'\/>/)
		await assert.rejects(call('machines.resizeDisk', {id, diskId, sizeGb: 4}), /only grow/)
		await call('machines.resizeDisk', {id, diskId, sizeGb: 16})
		assert.ok(seen.calls.includes(`virsh blockresize omarchy-${id} sdb 16G`))
		await assert.rejects(call('machines.removeDisk', {id, diskId}), /Shut down/)
		await assert.rejects(call('machines.addCdrom', {id}), /Shut down/)
		await call('machines.forceStop', {id})
		const {diskId: cd} = await call('machines.addCdrom', {id})
		const arch = (await q('machines.localIsos')).find((i) => /archlinux/.test(i.id))
		await call('machines.setMedia', {id, diskId: cd, iso: arch.id})
		assert.match(seen.xml, new RegExp(`archlinux\\.iso'/><target dev='sdc' bus='sata'/><readonly/>`))
		await call('machines.setBootOrder', {id, order: [cd, 'disk0', 'net']})
		assert.match(seen.xml, /archlinux\.iso'\/><target dev='sdc' bus='sata'\/><boot order='1'\/>/)
		assert.match(seen.xml, /<boot order='3'\/><\/interface>/)
		await assert.rejects(call('machines.setBootOrder', {id, order: ['nope']}), /boot device/)
		await call('machines.setMedia', {id, diskId: cd, iso: null})
		assert.ok(!seen.xml.includes('archlinux.iso'))
		await call('machines.removeDisk', {id, diskId, deleteFile: true})
		await assert.rejects(stat(join(data, 'machines/vms', id, 'disk1.qcow2')))
		await call('machines.removeDisk', {id, diskId: cd})
		await assert.rejects(call('machines.removeDisk', {id, diskId: 'disk0'}), /only disk/)
		assert.deepEqual((await q('machines.details', {id})).boot, ['disk0', 'net'])
		await call('machines.setBootOrder', {id, order: ['disk0']})
	})

	test('cloud-init: new SSH keys and password (hash only) for the next boot; private keys refused', async () => {
		await assert.rejects(call('machines.updateCloudInit', {id, sshKeys: ['-----BEGIN OPENSSH PRIVATE KEY-----']}), /private key/)
		const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl chris@laptop'
		await call('machines.updateCloudInit', {id, username: 'chris', hostname: 'web-1', sshKeys: [key], password: 'new secret pw'})
		assert.match(seen.userData, /ssh_authorized_keys:\n {6}- 'ssh-ed25519 AAAAC3/)
		assert.match(seen.userData, /chpasswd:[\s\S]*password: '\$6\$/)
		assert.match(seen.userData, /hostname: web-1/)
		assert.ok(!seen.userData.includes('new secret pw'))
		assert.deepEqual((await q('machines.details', {id})).cloudInit, {username: 'chris', hostname: 'web-1', sshKeys: [key]})
	})

	test('snapshots: taken, restored and deleted while shut down, with the settings of the moment', async () => {
		await call('machines.start', {id})
		await assert.rejects(call('machines.snapshot', {id, name: 'before'}), /Shut down/)
		await call('machines.forceStop', {id})
		await assert.rejects(call('machines.snapshot', {id, name: 'bad name!'}), /Name the snapshot/)
		await call('machines.snapshot', {id, name: 'before', description: 'clean install'})
		assert.ok(seen.calls.some((c) => /^qemu-img snapshot -c before .+disk\.qcow2$/.test(c)))
		await call('machines.updateHardware', {id, memoryMb: 2048})
		await call('machines.revertSnapshot', {id, name: 'before'})
		assert.ok(seen.calls.some((c) => /^qemu-img snapshot -a before /.test(c)))
		assert.equal((await q('machines.details', {id})).hardware.memoryMb, 1024)
		await call('machines.deleteSnapshot', {id, name: 'before'})
		assert.deepEqual((await q('machines.details', {id})).snapshots, [])
	})

	test('backups: to Home → Backups → Machines (stopped and live), restored as a new machine; clone', async () => {
		const {backupId} = await call('machines.backup', {id, notes: 'nightly'})
		await until(async () => (await q('machines.backups', {id})).some((b) => b.id === backupId))
		const dir = join(root, 'home/Backups/Machines', backupId)
		assert.equal(await readFile(join(dir, 'disk0.qcow2')).then((b) => b.length), image.length)
		const meta = JSON.parse(await readFile(join(dir, 'machine.json'), 'utf8'))
		assert.equal(meta.machine.name, 'Box')
		assert.equal(meta.machine.tasks, undefined)
		assert.ok(!JSON.stringify(meta).includes('hunter2'))
		const list = await q('machines.backups', {id})
		assert.equal(list[0].id, backupId)
		assert.equal(list[0].notes, 'nightly')
		const {id: restored} = await call('machines.restoreBackup', {backupId})

		const r = await until(async () => (await q('machines.list')).find((x) => x.id === restored && x.state === 'stopped'))
		assert.equal(r.name, 'Box (2)')
		assert.equal((await stat(join(data, 'machines/vms', restored, 'disk.qcow2'))).size, image.length)
		const {id: copy} = await call('machines.clone', {id, name: 'Box clone'})
		await until(async () => (await q('machines.list')).find((x) => x.id === copy && x.state === 'stopped'))
		assert.notEqual((await q('machines.details', {id: copy})).hardware.mac, (await q('machines.details', {id})).hardware.mac)
		// A live backup: QEMU copies the running machine's disks.
		await call('machines.start', {id})
		const {backupId: live} = await call('machines.backup', {id})
		await until(async () => (await q('machines.backups', {id})).some((b) => b.id === live))
		assert.ok(seen.calls.some((c) => c.startsWith(`virsh backup-begin omarchy-${id} --backupxml`)))
		assert.equal(await readFile(join(root, 'home/Backups/Machines', live, 'disk0.qcow2'), 'utf8'), 'live-copy')
		assert.equal((await q('machines.backups', {id})).find((b) => b.id === live).live, true)
		for (const b of [backupId, live]) await call('machines.deleteBackup', {backupId: b})
		assert.deepEqual(await q('machines.backups', {id}), [])
		await call('machines.uninstall', {id: restored})
		await call('machines.uninstall', {id: copy})
	})

	test('pause, resume, hibernate; monitor; task history', async () => {
		await call('machines.pause', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'suspended')
		await call('machines.resume', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'running')
		assert.match((await call('machines.monitor', {id, command: 'info status'})).output, /VM status: running \(info status\)/)
		await assert.rejects(call('machines.monitor', {id, command: 'migrate "exec:touch /tmp/x"'}), /isn’t available here/)
		await assert.rejects(call('machines.monitor', {id, command: 'drive_add 0 file=/etc/shadow'}), /isn’t available here/)
		await call('machines.hibernate', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'hibernated')
		await call('machines.start', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'running')
		const tasks = (await q('machines.details', {id})).tasks.map((t) => t.type)
		for (const t of ['create', 'hardware', 'snapshot', 'backup', 'pause', 'hibernate']) assert.ok(tasks.includes(t), `task ${t} recorded`)
		assert.ok((await q('machines.tasks')).every((t) => t.machineName))
	})

	test('stop, start, uninstall', async () => {
		await call('machines.forceStop', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'stopped')
		await call('machines.start', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'running')
		await call('machines.uninstall', {id})
		assert.deepEqual(await q('machines.list'), [])
		assert.equal(doms.size, 0)
		await assert.rejects(stat(join(data, 'machines/vms', id)))
	})
})
