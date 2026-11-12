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
import {findChecksum} from '../omarchyd/machines.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

test('findChecksum reads GNU and BSD checksum lists', () => {
	const h = 'a'.repeat(64)
	assert.equal(findChecksum(`${'b'.repeat(64)}  other.img\n${h} *disk.img\n`, 'disk.img', 'sha256'), h)
	assert.equal(findChecksum(`SHA256 (disk.img) = ${h}\n`, 'disk.img', 'sha256'), h)
	assert.equal(findChecksum(`${h}  disk.img\n`, 'disk.img', 'sha512'), null) // wrong length for sha512
	assert.equal(findChecksum(`${h}  disk.img.part\n`, 'disk.img', 'sha256'), null)
})

describe('omarchyd machines', () => {
	let root, data, d, fixture, fixtureUrl, auth
	const doms = new Map()
	const seen = {userData: '', xml: ''}
	const image = randomBytes(256 * 1024)

	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'virsh') {
			const a = args[0] === '-c' ? args.slice(2) : args
			switch (a[0]) {
				case '--version':
					return '10.0.0\n'
				case 'list':
					return ` Id   Name   State\n------------------\n${[...doms].map(([n, s]) => ` -    ${n}   ${s}`).join('\n')}\n`
				case 'define': {
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
			if (args[0] === 'convert') await copyFile(args[3], args[4])
			return 'qemu-img version 9.0\n'
		}
		if (cmd === 'xorriso') {
			seen.userData = await readFile(join(opts.cwd, 'user-data'), 'utf8')
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
						{id: 'insecure', name: 'Plain HTTP', version: '1', arch: 'amd64', kind: 'cloud', url: 'http://fixture.test/x.img', checksums: {url: 'https://fixture.test/s', algorithm: 'sha256'}},
					],
				}),
				'/img/test.qcow2': image,
				'/img/bad.qcow2': randomBytes(1000),
				'/img/SHA256SUMS': `${sum} *test.qcow2\n${'0'.repeat(64)} *bad.qcow2\n`,
			}
			const body = files[req.url]
			if (body === undefined) return res.writeHead(404).end()
			res.writeHead(200, {'content-length': Buffer.byteLength(body)}).end(body)
		})
		await new Promise((r) => fixture.listen(0, '127.0.0.1', r))
		fixtureUrl = `http://127.0.0.1:${fixture.address().port}`
		const kvm = join(root, 'kvm')
		await writeFile(kvm, '')
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home: root,
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
		assert.deepEqual(imgs.map((i) => [i.id, i.state]), [['testos-amd64', 'available'], ['bados-amd64', 'available']])
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
		await assert.rejects(call('user.createWebSocketTicket', {target: 'terminal'}), /terminal/)
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
