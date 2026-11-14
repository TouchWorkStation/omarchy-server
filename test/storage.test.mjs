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
	test('desktop sign-in: once, for the owner only, never over someone’s session, file always removed', async () => {
		const files = {'/usr/lib/systemd/system/sddm.service': '', '/usr/share/wayland-sessions/omarchy.desktop': ''}
		let sessions = [] // [{user, type}]
		const log = []
		const loginctl = (args) =>
			args[0] === 'list-sessions'
				? sessions.map((x, i) => `${i + 1} 1000 ${x.user} seat0 tty1`).join('\n')
				: (({user: u, type}) => `Name=${u}\nType=${type}\nState=active\nClass=user\n`)(sessions[Number(args[1]) - 1])
		const fs = fakeFs(files)
		const h = createHelper({
			user,
			fs,
			run: fakeRun(log, {
				loginctl,
				systemctl: (args) => {
					assert.match(fs.files.get('/etc/sddm.conf.d/zz-omarchy-server-sign-in.conf'), /\[Autologin\]\nUser=chris\nSession=omarchy\.desktop\nRelogin=false/)
					if (args[0] === 'restart') sessions = [{user: 'chris', type: 'wayland'}]
					return ''
				},
				rm: (args) => (fs.files.delete(args.at(-1)), ''),
			}),
		})
		assert.equal(await h.handle('desktop-sign-in'), 'signed-in')
		assert.equal(fs.files.has('/etc/sddm.conf.d/zz-omarchy-server-sign-in.conf'), false, 'the one-time sign-in is gone')
		assert.ok(log.some((l) => l.join(' ') === 'faillock --user chris --reset'), 'a lockout is cleared')
		assert.equal(await h.handle('desktop-sign-in'), 'already', 'signed in already: nothing touched')
		sessions = [{user: 'guest', type: 'wayland'}]
		log.length = 0
		await assert.rejects(h.handle('desktop-sign-in'), /Someone else is signed in/)
		assert.ok(!log.some((l) => l[0] === 'systemctl'), 'another person’s session is never restarted')
	})

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

	test('ZFS import: setuid and devices off, refused if it would mount over a system folder, force only when asked', async () => {
		const log = []
		let mountpoints = 'tank\t/tank\ton\ntank/media\t/tank/media\ton\n'
		const fs = fakeFs({'/etc/fstab': 'UUID=1 / btrfs d 0 0\n'})
		const run = fakeRun(log, {zpool: (a) => (a[0] === 'list' ? '' : ''), zfs: (a) => (a[0] === 'list' ? mountpoints : '')})
		const h = createHelper({user, fs, run})
		await assert.rejects(h.handle('zfs-import', ['tank', 'yes']), /Bad option/)
		await h.handle('zfs-import', ['tank', 'force'])
		assert.ok(log.some((l) => l.join(' ') === 'zpool import -N -f tank'))
		assert.match(fs.files.get('/etc/fstab'), /^\/tank \/home\/chris\/Pools\/tank none bind,nosuid,nodev,nofail.* # omarchy-server zfs tank$/m)
		assert.deepEqual(log.filter((l) => l[0] === 'zfs' && l[1] === 'set').map((l) => l[2]), ['setuid=off', 'devices=off'], 'only setuid and devices are changed')
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
		for (const p of ['22', '2021', '5900', '70000', 'abc']) await assert.rejects(h.handle('firewall-open', [p]), /Bad port/)
		assert.equal(await h.handle('firewall-open', ['38780']), 'ok')
		assert.equal(await h.handle('firewall-open', ['53']), 'ok', 'system ports, for apps you allowed to use them')
		await assert.rejects(h.handle('firewall-close', ['7780']), /Bad port/)
	})
	test('pools never honour setuid programs or device files; older pools get hardened', async () => {
		// New Btrfs pool line
		const log = []
		const fs = fakeFs({
			'/etc/fstab': [
				'UUID=1 / btrfs defaults 0 0',
				'UUID=2 /home/chris/Pools/media btrfs defaults,noatime,compress=zstd:3,nofail,x-systemd.device-timeout=10s 0 0 # omarchy-server pool media',
				'/tank /home/chris/Pools/tank none bind,nofail,x-systemd.requires=zfs-mount.service 0 0 # omarchy-server zfs tank',
				'UUID=3 /home/chris/Pools/done btrfs defaults,nosuid,nodev 0 0 # omarchy-server pool done',
				'',
			].join('\n'),
		})
		const zfsProps = {'tank:setuid': 'on\tdefault', 'tank:devices': 'on\tdefault', 'other:setuid': 'on\tdefault', 'other:devices': 'on\tdefault'}
		const run = fakeRun(log, {
			zpool: (a) => (a[0] === 'list' ? 'tank\nother\n' : ''),
			zfs: (a) => (a[0] === 'get' && a.at(-2) === 'mountpoint' ? (a.at(-1) === 'tank' ? '/tank\n' : '/srv/other\n') : a[0] === 'get' ? zfsProps[`${a.at(-1)}:${a.at(-2)}`] ?? '' : ''),
		})
		const h = createHelper({user, fs, run})
		assert.deepEqual(JSON.parse(await h.handle('harden-pools', [])), {fstab: 2, zfs: 2})
		const tab = fs.files.get('/etc/fstab').split('\n')
		assert.equal(tab[0], 'UUID=1 / btrfs defaults 0 0', 'system mounts untouched')
		assert.match(tab[1], /btrfs defaults,noatime,compress=zstd:3,nofail,x-systemd.device-timeout=10s,nosuid,nodev 0 0 # omarchy-server pool media$/)
		assert.match(tab[2], /none bind,nofail,x-systemd.requires=zfs-mount.service,nosuid,nodev 0 0 # omarchy-server zfs tank$/)
		assert.equal(tab[3], 'UUID=3 /home/chris/Pools/done btrfs defaults,nosuid,nodev 0 0 # omarchy-server pool done')
		assert.ok(log.some((l) => l.join(' ') === 'mount -o remount,nosuid,nodev /home/chris/Pools/media'))
		assert.ok(log.some((l) => l.join(' ') === 'zfs set setuid=off tank'))
		assert.ok(!log.some((l) => l.join(' ').endsWith('off other')), 'a ZFS pool Omarchy Server doesn’t manage is left alone')
		// Running it again changes nothing.
		const before = fs.files.get('/etc/fstab')
		zfsProps['tank:setuid'] = 'off\tlocal'
		zfsProps['tank:devices'] = 'off\tlocal'
		assert.deepEqual(JSON.parse(await h.handle('harden-pools', [])), {fstab: 0, zfs: 0})
		assert.equal(fs.files.get('/etc/fstab'), before)
	})

	test('new and imported pools mount nosuid,nodev', async () => {
		const log = []
		const fs = fakeFs({'/etc/fstab': ''})
		fs.readdir = async () => ['ata-A', 'ata-B']
		fs.realpath = async (p) => ({'/dev/disk/by-id/ata-A': '/dev/sda', '/dev/disk/by-id/ata-B': '/dev/sdb'})[p] ?? p
		const h = createHelper({user, fs, run: fakeRun(log, {zpool: () => '', zfs: (a) => (a[0] === 'list' ? 'tank\t/tank\ton\n' : '')})})
		await h.handle('pool-create', ['media', 'single', '/dev/sda'])
		assert.match(fs.files.get('/etc/fstab'), /btrfs defaults,noatime,nosuid,nodev,/)
		await h.handle('zfs-create', ['vault', 'mirror', '/dev/sda', '/dev/sdb'])
		const create = log.find((l) => l[0] === 'zpool' && l[1] === 'create')
		assert.ok(create.includes('setuid=off') && create.includes('devices=off'))
		await h.handle('zfs-import', ['tank'])
		const i = log.findIndex((l) => l.join(' ') === 'zfs set setuid=off tank')
		assert.ok(i > 0 && i < log.findIndex((l) => l.join(' ') === 'zfs mount -a'), 'set before anything is mounted')
		assert.match(fs.files.get('/etc/fstab'), /none bind,nosuid,nodev,nofail/)
	})

	test('grow the system drive: last partition, then encryption (with the disk password), then the filesystem', async () => {
		const G = 1024 ** 3
		const layout = (lastPart = 'vda2', crypt = true) => ({
			findmnt: () => `${crypt ? '/dev/mapper/root[/@home]' : '/dev/vda2[/@home]'} btrfs /home\n`,
			lsblk: (a) =>
				a.includes('-s')
					? JSON.stringify({blockdevices: [crypt ? {name: 'root', path: '/dev/mapper/root', size: 98 * G, type: 'crypt', children: [{name: 'vda2', path: '/dev/vda2', size: 99 * G, type: 'part', children: [{name: 'vda', path: '/dev/vda', size: 200 * G, type: 'disk'}]}]} : {name: 'vda2', path: '/dev/vda2', size: 99 * G, type: 'part', children: [{name: 'vda', path: '/dev/vda', size: 200 * G, type: 'disk'}]}]})
					: JSON.stringify({blockdevices: [{name: 'vda', path: '/dev/vda', size: 200 * G, type: 'disk', children: [{name: 'vda1', path: '/dev/vda1', size: G, type: 'part', start: 2048}, {name: 'vda2', path: '/dev/vda2', size: 99 * G, type: 'part', start: lastPart === 'vda2' ? 2099200 : 1000}]}]}),
			sfdisk: (a) => (a[0] === '--dump' ? 'label: gpt\n' : ''),
		})
		let log = []
		let cryptOk = (input) => input === 'disk pass'
		const extra = {...layout(), cryptsetup: () => ''}
		const runWith = (ext) => async (cmd, args, opts) => {
			log.push([cmd, ...args, ...(opts?.input !== undefined ? [`<stdin:${opts.input}>`] : [])])
			if (cmd === 'cryptsetup' && !cryptOk(opts?.input)) throw new Error('cryptsetup: No key available with this passphrase.')
			return ext[cmd] ? ext[cmd](args) : ''
		}
		let h = createHelper({user, fs: fakeFs(), run: runWith(extra)})
		await assert.rejects(h.handle('grow-system', [], ''), /NEEDS_PASSWORD/)
		log = []
		const r = JSON.parse(await h.handle('grow-system', [], 'disk pass\n'))
		assert.deepEqual(r.grown, ['partition', 'encryption', 'filesystem'])
		const cmds = log.map((l) => l.join(' '))
		assert.ok(cmds.includes('sfdisk --relocate gpt-bak-std /dev/vda'), 'GPT backup header moved to the new end')
		assert.ok(cmds.includes('sfdisk --no-reread --force -N 2 /dev/vda <stdin:, +\n>'), 'only partition 2, to the end')
		assert.ok(cmds.includes('partx -u -n 2 /dev/vda'))
		assert.ok(cmds.includes('cryptsetup resize root --key-file - <stdin:disk pass>'))
		assert.ok(cmds.includes('btrfs filesystem resize max /home'))
		assert.ok(cmds.indexOf('partx -u -n 2 /dev/vda') < cmds.indexOf('btrfs filesystem resize max /home'), 'in order')
		// Not the last partition: refused, nothing touched.
		log = []
		h = createHelper({user, fs: fakeFs(), run: runWith({...layout('vda1'), cryptsetup: () => ''})})
		await assert.rejects(h.handle('grow-system', [], 'disk pass'), /isn’t the last partition/)
		assert.ok(!log.some((l) => l[0] === 'sfdisk' && l[1] !== '--dump'))
		// Unencrypted: no password needed.
		log = []
		h = createHelper({user, fs: fakeFs(), run: runWith(layout('vda2', false))})
		assert.deepEqual(JSON.parse(await h.handle('grow-system', [], '')).grown, ['partition', 'filesystem'])
		assert.ok(!log.some((l) => l[0] === 'cryptsetup'))
	})

	test('low ports: only ever lowers the limit, and remembers it', async () => {
		const log = []
		let now = 1024
		const fs = fakeFs()
		const h = createHelper({user, fs, run: fakeRun(log, {sysctl: (args) => (args[0] === '-n' ? `${now}\n` : ((now = Number(args[1].split('=')[1])), ''))})})
		await h.handle('low-ports', ['53'])
		assert.equal(now, 53)
		assert.match(fs.files.get('/etc/sysctl.d/60-omarchy-server-ports.conf'), /ip_unprivileged_port_start = 53/)
		await h.handle('low-ports', ['443'])
		assert.equal(now, 53, 'never raised again by another app')
		await assert.rejects(h.handle('low-ports', ['0']), /Bad port/)
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
