// The root helper's checks (with simulated commands and files) and omarchyd's storage module.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {createHelper} from '../helper/helper.mjs'
import {createStorage} from '../omarchyd/storage.mjs'

const user = {name: 'chris', uid: 1000, gid: 1000, home: '/home/chris'}
const lsblk = {
	blockdevices: [
		{name: 'nvme0n1', path: '/dev/nvme0n1', type: 'disk', size: 512e9, rota: false, tran: 'nvme', serial: 'NV1', children: [{name: 'nvme0n1p1', path: '/dev/nvme0n1p1', type: 'part', fstype: 'vfat', mountpoints: ['/boot']}, {name: 'nvme0n1p2', path: '/dev/nvme0n1p2', type: 'part', fstype: 'btrfs', uuid: '11111111-1111-1111-1111-111111111111', mountpoints: ['/', '/home']}]},
		{name: 'sda', path: '/dev/sda', type: 'disk', size: 4e12, rota: true, tran: 'sata', serial: 'WD-A', model: 'WD Red', mountpoints: [null]},
		{name: 'sdb', path: '/dev/sdb', type: 'disk', size: 4e12, rota: '1', tran: 'sata', serial: 'WD-B', mountpoints: [null]},
		{name: 'sdc', path: '/dev/sdc', type: 'disk', size: 2e12, rota: true, tran: 'sata', serial: 'OLD', children: [{name: 'sdc1', path: '/dev/sdc1', type: 'part', fstype: 'ntfs', mountpoints: [null]}]},
		{name: 'sdd', path: '/dev/sdd', type: 'disk', size: 1e12, rota: false, tran: 'sata', serial: 'SSD1', fstype: 'btrfs', uuid: '22222222-2222-2222-2222-222222222222', label: 'media', mountpoints: [null]},
	],
}

function fakeFs(initial = {}) {
	const files = new Map(Object.entries(initial))
	return {
		files,
		readFile: async (p) => {
			if (!files.has(p)) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
			return files.get(p)
		},
		writeFile: async (p, t) => void files.set(p, t),
		rename: async (a, b) => void (files.set(b, files.get(a)), files.delete(a)),
		mkdir: async () => {},
		chown: async () => {},
		realpath: async (p) => {
			if (p.includes('missing')) throw new Error('ENOENT')
			return p.replace('/home/chris/link-out', '/etc')
		},
	}
}
function fakeRun(log, extra = {}) {
	return async (cmd, args, opts) => {
		log.push([cmd, ...args, ...(opts?.input ? [`<stdin:${opts.input.split('\n')[0].length}>`] : [])])
		if (cmd === 'lsblk') return JSON.stringify(lsblk)
		if (cmd === 'wipefs') return JSON.stringify({signatures: []})
		if (cmd === 'blkid') return '33333333-3333-3333-3333-333333333333\n'
		if (cmd === 'ufw') return args[0] === 'status' ? 'Status: active\n' : ''
		if (extra[cmd]) return extra[cmd](args)
		return ''
	}
}

describe('helper', () => {
	test('refuses to run for root or an unknown user, and unknown verbs', async () => {
		assert.throws(() => createHelper({user: {...user, uid: 0}}), /sudo/)
		const h = createHelper({user, run: fakeRun([]), fs: fakeFs()})
		await assert.rejects(h.handle('rm', ['-rf', '/']), /Unknown action/)
	})

	test('pool-create: blank drives only, never the system drive; writes fstab and mounts in ~/Pools', async () => {
		const log = []
		const fs = fakeFs({'/etc/fstab': 'UUID=1111 / btrfs defaults 0 0\n'})
		const h = createHelper({user, run: fakeRun(log), fs})
		await assert.rejects(h.handle('pool-create', ['Bad Name', 'single', '/dev/sda']), /Pool names/)
		await assert.rejects(h.handle('pool-create', ['tank', 'raid5', '/dev/sda', '/dev/sdb']), /single, raid1 or raid10/)
		await assert.rejects(h.handle('pool-create', ['tank', 'raid1', '/dev/sda']), /at least 2/)
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/dev/nvme0n1']), /holds the system/)
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/dev/sdc']), /isn’t blank.*wipefs -a \/dev\/sdc/)
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/dev/sda;reboot']), /Not a drive/)
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/etc/passwd']), /Not a drive/)
		assert.ok(!log.some((l) => l[0] === 'mkfs.btrfs'), 'nothing formatted by refused requests')
		const out = JSON.parse(await h.handle('pool-create', ['tank', 'raid1', '/dev/sda', '/dev/sdb']))
		assert.equal(out.mountpoint, '/home/chris/Pools/tank')
		assert.deepEqual(log.find((l) => l[0] === 'mkfs.btrfs'), ['mkfs.btrfs', '-L', 'omarchy-tank', '-d', 'raid1', '-m', 'raid1', '/dev/sda', '/dev/sdb'])
		const fstab = fs.files.get('/etc/fstab')
		assert.match(fstab, /^UUID=1111 \/ btrfs defaults 0 0$/m, 'existing lines kept')
		assert.match(fstab, /^UUID=33333333-3333-3333-3333-333333333333 \/home\/chris\/Pools\/tank btrfs .*nofail.* # omarchy-server pool tank$/m)
		assert.ok(log.some((l) => l[0] === 'mount' && l[1] === '/home/chris/Pools/tank'))
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/dev/sda']), /already a pool/)
	})

	test('pool-import mounts an existing Btrfs filesystem without changing it', async () => {
		const log = []
		const fs = fakeFs({'/etc/fstab': ''})
		const h = createHelper({user, run: fakeRun(log), fs})
		await assert.rejects(h.handle('pool-import', ['media', 'not-a-uuid']), /Choose a filesystem/)
		await h.handle('pool-import', ['media', '22222222-2222-2222-2222-222222222222'])
		assert.match(fs.files.get('/etc/fstab'), /UUID=22222222-2222-2222-2222-222222222222 \/home\/chris\/Pools\/media btrfs/)
		assert.ok(!log.some((l) => ['mkfs.btrfs', 'wipefs', 'btrfs'].includes(l[0]) && l[1] !== '--no-act'))
	})

	test('pool-status reads profile, error counters and the last check', async () => {
		const fs = fakeFs({'/etc/fstab': 'UUID=x /home/chris/Pools/tank btrfs d 0 0 # omarchy-server pool tank\n'})
		const h = createHelper({
			user,
			fs,
			run: fakeRun([], {
				btrfs: (a) =>
					a[0] === 'filesystem'
						? 'Data, RAID1: total=1000, used=10\nMetadata, RAID1: total=100, used=1\n'
						: a[0] === 'device'
							? '[/dev/sda].write_io_errs    0\n[/dev/sda].corruption_errs  2\n[/dev/sdb].write_io_errs    0\n'
							: 'UUID: x\nScrub started:    Tue Nov 10 03:00:00 2026\nStatus:           finished\nError summary:    no errors found\n',
			}),
		})
		const s = JSON.parse(await h.handle('pool-status', ['tank']))
		assert.equal(s.profile, 'raid1')
		assert.equal(s.devices['/dev/sda'].corruption_errs, 2)
		assert.deepEqual(s.scrub, {state: 'finished', errors: '', started: 'Tue Nov 10 03:00:00 2026'})
		await assert.rejects(h.handle('pool-status', ['nope']), /No pool/)
	})

	test('shares: only folders inside home; a foreign smb.conf is kept and only gets an include', async () => {
		const log = []
		const fs = fakeFs({})
		const h = createHelper({user, run: fakeRun(log), fs})
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'etc', path: '/home/chris/link-out'}]})), /inside your home/)
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'x]\n[evil', path: '/home/chris/Music'}]})), /Bad share name/)
		await h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}]}))
		const conf = fs.files.get('/etc/samba/smb.conf')
		assert.match(conf, /^# Managed by Omarchy Server/)
		assert.match(conf, /\[Music\]\n {3}path = \/home\/chris\/Music\n {3}valid users = chris/)
		assert.match(conf, /map to guest = never/)
		assert.ok(log.some((l) => l.join(' ') === 'ufw allow 445/tcp comment Omarchy Server shares'))
		const fs2 = fakeFs({'/etc/samba/smb.conf': '[global]\n   workgroup = HOME\n'})
		await createHelper({user, run: fakeRun([]), fs: fs2}).handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}]}))
		assert.match(fs2.files.get('/etc/samba/smb.conf'), /^\[global\]\n {3}workgroup = HOME\n[\s\S]*include = \/etc\/samba\/omarchy-server-shares.conf/)
		assert.match(fs2.files.get('/etc/samba/omarchy-server-shares.conf'), /\[Music\]/)
	})

	test('sleep: hard drives only, valid times only, kept by serial', async () => {
		const log = []
		const fs = fakeFs({})
		const h = createHelper({user, run: fakeRun(log), fs})
		await assert.rejects(h.handle('sleep', ['/dev/sdd', '20']), /spinning/)
		await assert.rejects(h.handle('sleep', ['/dev/sda', '7']), /Choose/)
		await h.handle('sleep', ['/dev/sda', '30'])
		assert.ok(log.some((l) => l.join(' ') === 'hdparm -S 241 /dev/sda'))
		assert.match(fs.files.get('/etc/udev/rules.d/69-omarchy-server-sleep.rules'), /ID_SERIAL_SHORT}=="WD-A".*hdparm -S 241/)
		await h.handle('sleep', ['/dev/sda', '0'])
		assert.equal(fs.files.get('/etc/udev/rules.d/69-omarchy-server-sleep.rules'), '')
	})

	test('ZFS: blank drives only, stable drive names, layouts and mountpoint in ~/Pools', async () => {
		const log = []
		const fs = fakeFs({'/etc/fstab': ''})
		fs.readdir = async () => ['ata-WDC_WD80_A', 'ata-WDC_WD80_A-part1', 'wwn-0x5000a', 'ata-WDC_WD80_B']
		fs.realpath = async (p) => ({'/dev/disk/by-id/ata-WDC_WD80_A': '/dev/sda', '/dev/disk/by-id/wwn-0x5000a': '/dev/sda', '/dev/disk/by-id/ata-WDC_WD80_B': '/dev/sdb'})[p] ?? p
		const h = createHelper({user, fs, run: fakeRun(log, {zpool: (a) => (a[0] === 'list' ? '' : '')})})
		await assert.rejects(h.handle('zfs-create', ['tank', 'raidz1', '/dev/sda', '/dev/sdb']), /at least 3/)
		await assert.rejects(h.handle('zfs-create', ['tank', 'raidz9', '/dev/sda']), /Choose/)
		await assert.rejects(h.handle('zfs-create', ['tank', 'mirror', '/dev/sda', '/dev/sdc']), /isn’t blank/)
		await h.handle('zfs-create', ['tank', 'mirror', '/dev/sda', '/dev/sdb'])
		const create = log.find((l) => l[0] === 'zpool' && l[1] === 'create')
		assert.deepEqual(create.slice(-4), ['tank', 'mirror', '/dev/disk/by-id/ata-WDC_WD80_A', '/dev/disk/by-id/ata-WDC_WD80_B'])
		assert.ok(create.includes('mountpoint=/home/chris/Pools/tank'))
		assert.ok(create.includes('ashift=12'))
		assert.ok(log.some((l) => l.join(' ') === 'systemctl enable zfs-import-cache.service'))
	})

	test('ZFS import: unchanged pool, refused if it would mount over a system folder, force only when asked', async () => {
		const log = []
		let mountpoints = 'tank\t/tank\ton\ntank/media\t/tank/media\ton\n'
		const fs = fakeFs({'/etc/fstab': 'UUID=1 / btrfs d 0 0\n'})
		const run = fakeRun(log, {zpool: (a) => (a[0] === 'list' ? '' : ''), zfs: (a) => (a[0] === 'list' ? mountpoints : '')})
		const h = createHelper({user, fs, run})
		await assert.rejects(h.handle('zfs-import', ['tank', 'yes']), /Bad option/)
		await h.handle('zfs-import', ['tank', 'force'])
		assert.ok(log.some((l) => l.join(' ') === 'zpool import -N -f tank'))
		assert.match(fs.files.get('/etc/fstab'), /^\/tank \/home\/chris\/Pools\/tank none bind,nofail.* # omarchy-server zfs tank$/m)
		assert.ok(!log.some((l) => l[0] === 'zfs' && l[1] === 'set'), 'pool properties untouched')
		mountpoints = 'evil\t/evil\ton\nevil/x\t/usr/local\ton\n'
		log.length = 0
		await assert.rejects(h.handle('zfs-import', ['evil']), /system folder/)
		assert.ok(log.some((l) => l.join(' ') === 'zpool export evil'), 'refused pool is exported again')
		assert.ok(!log.some((l) => l.join(' ') === 'zfs mount -a'))
	})

	test('ZFS status and import list are parsed', async () => {
		const status = `  pool: tank
 state: DEGRADED
  scan: scrub repaired 0B in 01:02:03 with 0 errors on Sun Nov  8 03:00:00 2026
config:

	NAME                                STATE     READ WRITE CKSUM
	tank                                DEGRADED     0     0     0
	  raidz1-0                          DEGRADED     0     0     0
	    /dev/disk/by-id/ata-A-part1     ONLINE       0     0     0
	    /dev/disk/by-id/ata-B-part1     FAULTED      3     1     0
	    /dev/disk/by-id/ata-C-part1     ONLINE       0     0     2

errors: No known data errors
`
		const importList = `   pool: oldtank
     id: 1234567890
  state: ONLINE
 status: The pool was last accessed by another system.
 action: The pool can be imported using its name or numeric identifier and
	the '-f' flag.
 config:
`
		const fs = fakeFs({'/etc/fstab': ''})
		const run = fakeRun([], {
			zpool: (a) => (a[0] === 'list' ? 'tank\t8000\t4000\t4000\tDEGRADED\n' : a[0] === 'status' ? status : a[0] === 'import' ? importList : ''),
			zfs: () => '/tank\n',
		})
		const h = createHelper({user, fs, run})
		const [pool] = JSON.parse(await h.handle('zfs-pools'))
		assert.equal(pool.layout, 'raidz1')
		assert.equal(pool.state, 'DEGRADED')
		assert.deepEqual(pool.devices.map((d) => d.errors), [0, 4, 2])
		assert.equal(pool.errors, 'No known data errors')
		assert.match(pool.scan, /with 0 errors/)
		const [imp] = JSON.parse(await h.handle('zfs-importable'))
		assert.deepEqual([imp.name, imp.state, imp.otherSystem], ['oldtank', 'ONLINE', true])
	})

	test('firewall: app ports only', async () => {
		const h = createHelper({user, run: fakeRun([]), fs: fakeFs()})
		for (const p of ['22', '80', '2021', '70000', 'abc']) await assert.rejects(h.handle('firewall-open', [p]), /Bad port/)
		assert.equal(await h.handle('firewall-open', ['38780']), 'ok')
		await assert.rejects(h.handle('firewall-close', ['7780']), /Bad port/)
	})
})

describe('omarchyd storage', () => {
	let root, fstab
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-s-'))
		fstab = join(root, 'fstab')
		await writeFile(fstab, 'UUID=22222222-2222-2222-2222-222222222222 /x/Pools/media btrfs d 0 0 # omarchy-server pool media\n')
	})
	after(() => rm(root, {recursive: true, force: true}))

	test('drives get roles and health; shares go through the helper with real paths', async () => {
		const calls = []
		const run = async (cmd, args, opts) => {
			if (cmd === 'lsblk') return JSON.stringify(lsblk)
			calls.push({args, input: opts?.input})
			const verb = args[2]
			if (verb === 'ping') return 'ok\n'
			if (verb === 'smart') return JSON.stringify({smart_status: {passed: true}, temperature: {current: 34}, power_on_time: {hours: 9000}, ata_smart_attributes: {table: [{id: 5, raw: {value: 0}}]}})
			return 'ok\n'
		}
		const files = {resolve: async (p) => ({real: p.replace('/Home', '/home/chris'), top: p.startsWith('/Home') ? 'Home' : 'Trash'})}
		const data = join(root, 'data')
		await mkdir(data)
		const s = createStorage({dataDir: data, home: '/home/chris', files, run, fstabPath: fstab})
		const disks = await s.procedures['storage.disks'].run()
		const role = Object.fromEntries(disks.map((d) => [d.name, d.role]))
		assert.deepEqual(role, {nvme0n1: 'system', sda: 'blank', sdb: 'blank', sdc: 'data', sdd: 'pool'})
		assert.equal(disks.find((d) => d.name === 'sda').health.temperature, 34)
		assert.equal(disks.find((d) => d.name === 'sda').kind, 'hdd')
		const imp = await s.procedures['storage.importable'].run()
		assert.deepEqual(imp, [])
		await s.procedures['files.addShare'].run({path: '/Home/Music'})
		await s.procedures['files.addShare'].run({path: '/Home/Other/Music'})
		const shares = await s.procedures['files.shares'].run()
		assert.deepEqual(shares.map((x) => x.name), ['Music', 'Music 2'])
		const pw = await s.procedures['files.sharePassword'].run()
		assert.match(pw, /^[a-z0-9x]{4}(-[a-z0-9x]{4}){3}$/)
		assert.equal(calls.filter((c) => c.args[2] === 'smb-password').length, 1, 'password set once')
		const last = calls.filter((c) => c.args[2] === 'shares-apply').at(-1)
		assert.deepEqual(JSON.parse(last.input).shares.map((x) => x.path), ['/home/chris/Music', '/home/chris/Other/Music'])
		assert.equal((await readFile(join(data, 'share-password'), 'utf8')).trim(), pw)
		await assert.rejects(s.procedures['files.addShare'].run({path: '/Home'}), /inside Home/)
	})
})
