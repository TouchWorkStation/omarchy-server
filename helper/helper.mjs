#!/usr/bin/node
// omarchy-server helper: the only part of Omarchy Server that runs as root.
//
// Installed root-owned at /usr/local/libexec/omarchy-server/helper.mjs. A sudoers rule lets the
// owner run it (and nothing else) without a password, so omarchyd can manage storage, network
// shares and the firewall while it runs as the owner. Every argument is treated as hostile and checked
// here, and each verb does one fixed thing:
//
//   ping                              is the helper installed and allowed?
//   smart DEV                         drive health (smartctl JSON)
//   sleep DEV MINUTES                 spin-down time for a hard drive (0 = never), kept across boots
//   pool-create NAME PROFILE DEV...   new Btrfs pool on BLANK drives only, mounted at ~/Pools/NAME
//   pool-add NAME DEV                 add a BLANK drive to a pool, then rebalance in the background
//   pool-import NAME UUID             mount an existing Btrfs filesystem at ~/Pools/NAME (no changes to it)
//   pool-forget NAME                  unmount a pool and stop mounting it at boot (data untouched)
//   pool-scrub NAME                   start an error check
//   pool-status NAME                  profile, per-drive error counters, last error check
//   zfs-available                     is ZFS installed and loaded?
//   zfs-pools                         imported ZFS pools: layout, health, space, last check
//   zfs-importable                    ZFS pools on connected drives that aren't imported yet
//   zfs-create NAME LAYOUT DEV...     new ZFS pool on BLANK drives, mounted at ~/Pools/NAME
//   zfs-import NAME [force]           import an existing pool (unchanged), shown at ~/Pools/NAME
//   zfs-scrub NAME                    start an error check
//   zfs-export NAME                   stop using a pool (data untouched; can be imported again)
//   shares-apply                      network shares from stdin JSON, folders inside the owner's home only
//   smb-password                      set the owner's network-share password from stdin
//   firewall-open PORT | firewall-close PORT   an app's TCP port, 1024-65535
//
// Drives that hold anything (partitions or filesystem signatures) are never erased by this helper.
// Wiping one is left to a person at a terminal (`sudo wipefs -a /dev/sdX`).
import {execFile} from 'node:child_process'
import {chown, mkdir, readdir, readFile, realpath, rename, writeFile} from 'node:fs/promises'
import {join, sep} from 'node:path'

const DEV = /^\/dev\/(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme\d{1,2}n\d{1,2}|hd[a-z])$/
const NAME = /^[a-z][a-z0-9-]{0,31}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SYSTEM_MOUNTS = new Set(['/', '/boot', '/efi', '/boot/efi', '/home', '/var', '/usr', '[SWAP]'])
const FSTAB_MARK = '# omarchy-server pool'
const ZFS_MARK = '# omarchy-server zfs'
// Mountpoints an imported pool must never land on.
const PROTECTED = ['/', '/boot', '/efi', '/etc', '/usr', '/var', '/home', '/root', '/opt', '/srv', '/bin', '/sbin', '/lib', '/lib64', '/dev', '/proc', '/sys', '/run', '/tmp']
const SMB_CONF = '/etc/samba/smb.conf'
const SMB_INCLUDE = '/etc/samba/omarchy-server-shares.conf'
const SMB_MARK = '# Managed by Omarchy Server'
const UDEV_SLEEP = '/etc/udev/rules.d/69-omarchy-server-sleep.rules'
// One-time sign-in to the Omarchy desktop (the same drop-in Omarchy's own first boot writes, removed again
// as soon as the session starts).
const SDDM_ONCE = '/etc/sddm.conf.d/zz-omarchy-server-sign-in.conf'
const SESSIONS = ['/usr/share/wayland-sessions/omarchy.desktop', '/usr/share/wayland-sessions/hyprland-uwsm.desktop', '/usr/share/wayland-sessions/hyprland.desktop']
const SLEEP_MINUTES = {0: 0, 10: 120, 20: 240, 30: 241, 60: 242, 120: 244, 240: 248}

export class HelperError extends Error {}
const fail = (message) => {
	throw new HelperError(message)
}

export function defaultRun(cmd, args, {input} = {}) {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, {timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, env: {PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin', LC_ALL: 'C'}}, (error, stdout, stderr) => {
			if (error && !(cmd === 'smartctl' && stdout)) return reject(new HelperError(`${cmd}: ${(stderr || error.message).toString().trim().split('\n').slice(-2).join(' ')}`))
			resolve(stdout.toString())
		})
		if (input !== undefined) child.stdin.end(input)
	})
}

// Everything the helper touches comes through ctx, so tests can run it without root.
export function createHelper({run = defaultRun, user, fs = {readFile, writeFile, mkdir, chown, realpath, rename, readdir}}) {
	if (!user?.name || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user.name) || !Number.isInteger(user.uid) || user.uid === 0 || !user.home?.startsWith('/')) fail('Run this through sudo as the Omarchy Server owner')
	const poolsDir = join(user.home, 'Pools')
	const mountOf = (name) => join(poolsDir, name)

	async function blockDevices() {
		const j = JSON.parse(await run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,ROTA,FSTYPE,LABEL,UUID,MOUNTPOINTS,SERIAL']))
		return j.blockdevices ?? []
	}
	const flat = (d) => [d, ...(d.children ?? []).flatMap(flat)]
	const mounts = (d) => flat(d).flatMap((x) => (x.mountpoints ?? []).filter(Boolean))
	async function disk(path) {
		if (!DEV.test(path)) fail(`Not a drive: ${path}`)
		const d = (await blockDevices()).find((x) => x.path === path && x.type === 'disk')
		if (!d) fail(`No drive at ${path}`)
		return d
	}
	// Blank: no partitions, no filesystem or RAID signature, nothing mounted, not the system drive.
	async function blankDisk(path) {
		const d = await disk(path)
		if (mounts(d).some((m) => SYSTEM_MOUNTS.has(m))) fail(`${path} holds the system`)
		if (mounts(d).length) fail(`${path} is in use`)
		if ((d.children ?? []).length || d.fstype) fail(`${path} isn’t blank. To use it, first erase it yourself in a terminal: sudo wipefs -a ${path}`)
		const sig = (await run('wipefs', ['--no-act', '--json', path]).catch(() => '')).trim()
		if (sig && (JSON.parse(sig).signatures ?? []).length) fail(`${path} isn’t blank. To use it, first erase it yourself in a terminal: sudo wipefs -a ${path}`)
		return d
	}

	async function fstab() {
		return (await fs.readFile('/etc/fstab', 'utf8').catch(() => '')).split('\n')
	}
	async function writeAtomic(file, text) {
		const tmp = `${file}.omarchy-server.tmp`
		await fs.writeFile(tmp, text, {mode: 0o644})
		await fs.rename(tmp, file)
	}
	async function addFstab(name, uuid) {
		const lines = (await fstab()).filter((l) => !l.endsWith(`${FSTAB_MARK} ${name}`))
		while (lines.length && lines.at(-1) === '') lines.pop()
		lines.push(`UUID=${uuid} ${mountOf(name)} btrfs defaults,noatime,compress=zstd:3,nofail,x-systemd.device-timeout=10s 0 0 ${FSTAB_MARK} ${name}`, '')
		await writeAtomic('/etc/fstab', lines.join('\n'))
	}
	async function poolMount(name) {
		if (!NAME.test(name)) fail('Pool names use a-z, 0-9 and -')
		if (!(await fstab()).some((l) => l.endsWith(`${FSTAB_MARK} ${name}`))) fail(`No pool called ${name}`)
		return mountOf(name)
	}
	async function mountPool(name, uuid) {
		await fs.mkdir(mountOf(name), {recursive: true})
		await fs.chown(poolsDir, user.uid, user.gid)
		await addFstab(name, uuid)
		await run('systemctl', ['daemon-reload'])
		await run('mount', [mountOf(name)])
		await fs.chown(mountOf(name), user.uid, user.gid)
	}

	async function inHome(path) {
		const home = await fs.realpath(user.home)
		const real = await fs.realpath(path).catch(() => fail(`No folder at ${path}`))
		if (real === home || !real.startsWith(home + sep)) fail('Only folders inside your home can be shared')
		return real
	}
	// Rules are added whenever ufw is installed, even while it's off, so they're in place the
	// moment it's turned on (Omarchy turns it on during its own install).
	async function ufwActive() {
		return run('ufw', ['status']).then(() => true, () => false)
	}

	// ---- ZFS --------------------------------------------------------------------------------------
	const zpool = (...a) => run('zpool', a)
	const zfs = (...a) => run('zfs', a)
	async function zfsPoolNames() {
		return (await zpool('list', '-H', '-o', 'name').catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean)
	}
	// Stable names (/dev/disk/by-id/…) so a pool survives drives being re-lettered.
	async function byId(dev) {
		const dir = '/dev/disk/by-id'
		const names = await fs.readdir(dir).catch(() => [])
		const target = await fs.realpath(dev)
		const matches = []
		for (const n of names) if (!/-part\d+$/.test(n) && (await fs.realpath(join(dir, n)).catch(() => null)) === target) matches.push(n)
		const best = matches.find((n) => /^(nvme|ata|scsi|usb)-/.test(n)) ?? matches.find((n) => !n.startsWith('wwn-')) ?? matches[0]
		return best ? join(dir, best) : dev
	}
	// Parse `zpool status -P NAME` into what the app shows.
	function parseStatus(text) {
		const state = /^\s*state:\s*(\S+)/m.exec(text)?.[1] ?? 'UNKNOWN'
		const scan = /^\s*scan:\s*(.+(?:\n\t.+)*)/m.exec(text)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
		const errors = /^errors:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
		const cfg = text.split(/^\s*config:\s*$/m)[1]?.split(/^errors:/m)[0] ?? ''
		const layout = new Set()
		const devices = []
		for (const line of cfg.split('\n')) {
			const m = /^\s+(\S+)\s+(ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED)\s+(\d+\S*)\s+(\d+\S*)\s+(\d+\S*)/.exec(line)
			if (!m) continue
			if (/^(mirror|raidz[123]?|draid)/.test(m[1])) layout.add(m[1].replace(/-\d+$/, ''))
			else if (m[1].startsWith('/')) devices.push({path: m[1], state: m[2], errors: [m[3], m[4], m[5]].map((x) => Number.parseInt(x, 10) || 0).reduce((a, b) => a + b, 0)})
		}
		return {state, scan, errors, layout: layout.size ? [...layout].join('+') : 'stripe', devices}
	}
	async function zfsPoolMount(name) {
		if (!/^[a-z][a-z0-9_.-]{0,31}$/i.test(name ?? '')) fail('Bad pool name')
		if (!(await zfsPoolNames()).includes(name)) fail(`No ZFS pool called ${name}`)
		return name
	}
	async function ensureZfsServices() {
		for (const unit of ['zfs-import-cache.service', 'zfs-mount.service', 'zfs-import.target', 'zfs.target']) await run('systemctl', ['enable', unit]).catch(() => {})
	}

	// Graphical sessions on this machine: [{user, type, state}].
	async function graphicalSessions() {
		const out = []
		for (const line of (await run('loginctl', ['list-sessions', '--no-legend']).catch(() => '')).split('\n')) {
			const id = line.trim().split(/\s+/)[0]
			if (!id || !/^[\w-]+$/.test(id)) continue
			const props = Object.fromEntries(
				(await run('loginctl', ['show-session', id, '-p', 'Name', '-p', 'Type', '-p', 'State', '-p', 'Class']).catch(() => ''))
					.split('\n')
					.map((l) => l.split('='))
					.filter((kv) => kv.length === 2),
			)
			if ((props.Type === 'wayland' || props.Type === 'x11') && props.Class === 'user') out.push({user: props.Name, type: props.Type, state: props.State})
		}
		return out
	}
	const exists = (p) => fs.readFile(p).then(() => true, () => false)

	const verbs = {
		ping: async () => 'ok',
		// Sign the owner in to the Omarchy desktop when it's sitting at the sign-in screen (or after
		// too many wrong passwords): clear the failed-attempt lockout, then let SDDM start the owner's
		// session once. Only when nobody has a desktop session, so no one's open session is touched.
		'desktop-sign-in': async () => {
			const sessions = await graphicalSessions()
			if (sessions.some((x) => x.user === user.name)) return 'already'
			if (sessions.length) fail('Someone else is signed in to this desktop, so it was left alone.')
			if (!(await exists('/usr/lib/systemd/system/sddm.service'))) fail('This desktop doesn’t use SDDM, so Omarchy Server can’t sign it in.')
			let session = null
			for (const f of SESSIONS) if (await exists(f)) (session ??= f.split('/').pop())
			if (!session) fail('No Omarchy desktop session was found to start.')
			await run('faillock', ['--user', user.name, '--reset']).catch(() => {})
			await fs.mkdir('/etc/sddm.conf.d', {recursive: true})
			await fs.writeFile(SDDM_ONCE, `# Omarchy Server: one-time sign-in, removed once the session starts\n[Autologin]\nUser=${user.name}\nSession=${session}\nRelogin=false\n`, {mode: 0o644})
			try {
				await run('systemctl', ['restart', 'sddm.service'])
				for (let i = 0; i < 40; i++) {
					if ((await graphicalSessions()).some((x) => x.user === user.name)) return 'signed-in'
					await new Promise((r) => setTimeout(r, 500))
				}
				fail('The desktop didn’t start a session. Check the server’s screen.')
			} finally {
				// Never left in place: later sign-ins need the password as usual.
				await run('rm', ['-f', SDDM_ONCE]).catch(() => {})
			}
		},
		// Restart or shut down the server (Settings → Restart server / Shut down server).
		power: async ([what]) => {
			if (what !== 'reboot' && what !== 'poweroff') fail('Use reboot or poweroff')
			await run('systemctl', ['--no-block', what])
			return 'ok'
		},
		// The server's device name on the network (Settings → Device name).
		hostname: async ([name]) => {
			if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name ?? '')) fail('Use letters, numbers and dashes for the device name')
			await run('hostnamectl', ['set-hostname', name])
			return 'ok'
		},
		// Remove a one-time sign-in left behind by an interrupted attempt.
		'desktop-sign-in-cleanup': async () => (await run('rm', ['-f', SDDM_ONCE]), 'ok'),

		smart: async ([dev]) => {
			await disk(dev)
			return run('smartctl', ['-j', '-a', dev])
		},

		sleep: async ([dev, minutes]) => {
			const d = await disk(dev)
			const m = Number(minutes)
			if (!(m in SLEEP_MINUTES)) fail('Choose 0, 10, 20, 30, 60, 120 or 240 minutes')
			if (!(d.rota === true || d.rota === '1' || d.rota === 1)) fail('Only spinning hard drives sleep')
			if (!d.serial || !/^[\w.-]{1,64}$/.test(d.serial)) fail('This drive doesn’t report a serial number, so its setting can’t be kept')
			await run('hdparm', ['-S', String(SLEEP_MINUTES[m]), dev])
			const lines = (await fs.readFile(UDEV_SLEEP, 'utf8').catch(() => '')).split('\n').filter((l) => l && !l.startsWith('#') && !l.includes(`ENV{ID_SERIAL_SHORT}=="${d.serial}"`))
			if (m) lines.push(`ACTION=="add", SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", ENV{ID_SERIAL_SHORT}=="${d.serial}", RUN+="/usr/bin/hdparm -S ${SLEEP_MINUTES[m]} /dev/%k"`)
			await writeAtomic(UDEV_SLEEP, lines.length ? `# Drive sleep, set by Omarchy Server\n${lines.join('\n')}\n` : '')
			return 'ok'
		},

		'pool-create': async ([name, profile, ...devs]) => {
			if (!NAME.test(name ?? '')) fail('Pool names use a-z, 0-9 and -, starting with a letter')
			if (!['single', 'raid1', 'raid10'].includes(profile)) fail('Choose single, raid1 or raid10')
			if (!devs.length || devs.length > 16 || new Set(devs).size !== devs.length) fail('Choose the drives for the pool')
			if (profile === 'raid1' && devs.length < 2) fail('Mirroring needs at least 2 drives')
			if (profile === 'raid10' && devs.length < 4) fail('RAID 10 needs at least 4 drives')
			if ((await fstab()).some((l) => l.endsWith(`${FSTAB_MARK} ${name}`))) fail(`There’s already a pool called ${name}`)
			for (const d of devs) await blankDisk(d)
			const meta = devs.length === 1 ? 'dup' : profile === 'raid10' ? 'raid10' : 'raid1'
			await run('mkfs.btrfs', ['-L', `omarchy-${name}`, '-d', profile, '-m', meta, ...devs])
			await run('udevadm', ['settle']).catch(() => {})
			const uuid = (await run('blkid', ['-s', 'UUID', '-o', 'value', devs[0]])).trim()
			if (!UUID.test(uuid)) fail('The new pool has no UUID')
			await mountPool(name, uuid)
			return JSON.stringify({name, uuid, mountpoint: mountOf(name)})
		},

		'pool-add': async ([name, dev]) => {
			const mnt = await poolMount(name)
			await blankDisk(dev)
			await run('btrfs', ['device', 'add', dev, mnt])
			await run('btrfs', ['balance', 'start', '--bg', '--full-balance', mnt])
			return 'ok'
		},

		'pool-import': async ([name, uuid]) => {
			if (!NAME.test(name ?? '')) fail('Pool names use a-z, 0-9 and -, starting with a letter')
			if (!UUID.test(uuid ?? '')) fail('Choose a filesystem to import')
			const fs0 = (await blockDevices()).flatMap(flat).filter((x) => x.uuid === uuid)
			if (!fs0.length || fs0.some((x) => x.fstype !== 'btrfs')) fail('Only Btrfs filesystems can be imported')
			if (fs0.some((x) => (x.mountpoints ?? []).some(Boolean))) fail('That filesystem is already mounted')
			if ((await fstab()).some((l) => l.endsWith(`${FSTAB_MARK} ${name}`) || l.includes(`UUID=${uuid} `))) fail('That pool or filesystem is already set up')
			await mountPool(name, uuid)
			return 'ok'
		},

		'pool-forget': async ([name]) => {
			const mnt = await poolMount(name)
			await run('umount', [mnt]).catch((e) => {
				if (!/not mounted/.test(e.message)) throw new HelperError(`${name} is in use. Stop apps and shares using it, then try again.`)
			})
			await writeAtomic('/etc/fstab', (await fstab()).filter((l) => !l.endsWith(`${FSTAB_MARK} ${name}`)).join('\n'))
			await run('systemctl', ['daemon-reload'])
			return 'ok'
		},

		'pool-scrub': async ([name]) => {
			await run('btrfs', ['scrub', 'start', await poolMount(name)])
			return 'ok'
		},

		'pool-status': async ([name]) => {
			const mnt = await poolMount(name)
			const df = await run('btrfs', ['filesystem', 'df', '-b', mnt])
			const profile = /^Data,\s*(\w+)/m.exec(df)?.[1]?.toLowerCase() ?? 'unknown'
			const stats = await run('btrfs', ['device', 'stats', mnt])
			const devices = {}
			for (const m of stats.matchAll(/^\[(\/dev\/[^\]]+)\]\.(\w+)\s+(\d+)/gm)) (devices[m[1]] ??= {})[m[2]] = Number(m[3])
			const scrub = await run('btrfs', ['scrub', 'status', mnt]).catch(() => '')
			const scrubState = /Status:\s*(\w+)/.exec(scrub)?.[1] ?? (/no stats available/.test(scrub) ? 'never' : 'unknown')
			const scrubErrors = /Error summary:\s*(.*)/.exec(scrub)?.[1]?.trim() ?? ''
			const started = /Scrub started:\s*(.*)/.exec(scrub)?.[1]?.trim() ?? null
			return JSON.stringify({profile, devices, scrub: {state: scrubState, errors: scrubErrors === 'no errors found' ? '' : scrubErrors, started}})
		},

		'zfs-available': async () => ((await run('zpool', ['version']).then(() => true, () => false)) ? 'yes' : 'no'),

		'zfs-pools': async () => {
			const out = []
			const tab = await fstab()
			for (const line of (await zpool('list', '-H', '-p', '-o', 'name,size,alloc,free,health').catch(() => '')).split('\n')) {
				const [name, size, alloc, free, health] = line.split('\t')
				if (!name) continue
				const st = parseStatus(await zpool('status', '-P', name).catch(() => ''))
				const mountpoint = (await zfs('get', '-H', '-o', 'value', 'mountpoint', name).catch(() => '')).trim()
				const bind = tab.find((l) => l.endsWith(`${ZFS_MARK} ${name}`))
				const folder = bind ? bind.split(/\s+/)[1] : mountpoint.startsWith(`${poolsDir}/`) ? mountpoint : null
				out.push({name, size: Number(size), used: Number(alloc), free: Number(free), health, mountpoint, folder, ...st})
			}
			return JSON.stringify(out)
		},

		'zfs-importable': async () => {
			const text = await zpool('import').catch((e) => (/no pools available/i.test(e.message) ? '' : Promise.reject(e)))
			const pools = []
			for (const block of text.split(/^\s*pool:\s*/m).slice(1)) {
				const name = block.split('\n')[0].trim()
				pools.push({
					name,
					id: /^\s*id:\s*(\d+)/m.exec(block)?.[1] ?? null,
					state: /^\s*state:\s*(\S+)/m.exec(block)?.[1] ?? 'UNKNOWN',
					// "last accessed by another system": importing needs a deliberate "force".
					otherSystem: /another system|was last accessed by|-f flag/i.test(block),
					note: /^\s*status:\s*(.+(?:\n\s{2,}.+)*)/m.exec(block)?.[1]?.replace(/\s+/g, ' ').trim() ?? '',
				})
			}
			return JSON.stringify(pools)
		},

		'zfs-create': async ([name, layout, ...devs]) => {
			if (!NAME.test(name ?? '')) fail('Pool names use a-z, 0-9 and -, starting with a letter')
			const min = {stripe: 1, mirror: 2, raidz1: 3, raidz2: 4}[layout]
			if (!min) fail('Choose combined, mirror, raidz1 or raidz2')
			if (!devs.length || devs.length > 24 || new Set(devs).size !== devs.length) fail('Choose the drives for the pool')
			if (devs.length < min) fail(`That layout needs at least ${min} drives`)
			if ((await zfsPoolNames()).includes(name)) fail(`There’s already a ZFS pool called ${name}`)
			if ((await fstab()).some((l) => l.endsWith(`${FSTAB_MARK} ${name}`) || l.endsWith(`${ZFS_MARK} ${name}`))) fail(`There’s already a pool called ${name}`)
			for (const d of devs) await blankDisk(d)
			const ids = []
			for (const d of devs) ids.push(await byId(d))
			await fs.mkdir(poolsDir, {recursive: true})
			await fs.chown(poolsDir, user.uid, user.gid)
			const vdev = layout === 'stripe' ? ids : [layout, ...ids]
			await zpool('create', '-o', 'ashift=12', '-O', 'compression=lz4', '-O', 'atime=off', '-O', 'xattr=sa', '-O', 'acltype=posixacl', '-O', `mountpoint=${mountOf(name)}`, name, ...vdev)
			await zpool('set', 'cachefile=/etc/zfs/zpool.cache', name)
			await ensureZfsServices()
			await fs.chown(mountOf(name), user.uid, user.gid)
			return JSON.stringify({name, mountpoint: mountOf(name)})
		},

		'zfs-import': async ([name, force]) => {
			if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name ?? '')) fail('Bad pool name')
			if (force !== undefined && force !== 'force') fail('Bad option')
			if ((await zfsPoolNames()).includes(name)) fail(`${name} is already imported`)
			// Import without mounting, check where its datasets would land, then mount.
			await zpool('import', '-N', ...(force ? ['-f'] : []), name)
			const datasets = (await zfs('list', '-H', '-o', 'name,mountpoint,canmount', '-r', name)).split('\n').filter(Boolean).map((l) => l.split('\t'))
			const bad = datasets.find(([, mp, can]) => can !== 'off' && mp.startsWith('/') && PROTECTED.some((p) => mp === p || (p !== '/' && mp.startsWith(`${p}/`) && !mp.startsWith(`${poolsDir}/`))))
			if (bad) {
				await zpool('export', name).catch(() => {})
				fail(`${bad[0]} would be mounted at ${bad[1]}, a system folder, so the pool wasn’t imported. Change its mountpoint on the system it came from, or import it by hand.`)
			}
			await zfs('mount', '-a')
			await zpool('set', 'cachefile=/etc/zfs/zpool.cache', name)
			await ensureZfsServices()
			// Show it at ~/Pools/NAME without changing the pool: a bind mount of its top folder.
			const top = (datasets.find(([n]) => n === name) ?? [])[1]
			const pretty = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, 'p')
			if (top && top.startsWith('/') && top !== mountOf(pretty)) {
				await fs.mkdir(mountOf(pretty), {recursive: true})
				await fs.chown(poolsDir, user.uid, user.gid)
				const lines = (await fstab()).filter((l) => !l.endsWith(`${ZFS_MARK} ${name}`))
				while (lines.length && lines.at(-1) === '') lines.pop()
				lines.push(`${top} ${mountOf(pretty)} none bind,nofail,x-systemd.requires=zfs-mount.service 0 0 ${ZFS_MARK} ${name}`, '')
				await writeAtomic('/etc/fstab', lines.join('\n'))
				await run('systemctl', ['daemon-reload'])
				await run('mount', [mountOf(pretty)])
			}
			return 'ok'
		},

		'zfs-scrub': async ([name]) => {
			await zpool('scrub', await zfsPoolMount(name))
			return 'ok'
		},

		'zfs-export': async ([name]) => {
			await zfsPoolMount(name)
			const bind = (await fstab()).find((l) => l.endsWith(`${ZFS_MARK} ${name}`))
			if (bind) {
				await run('umount', [bind.split(/\s+/)[1]]).catch(() => {})
				await writeAtomic('/etc/fstab', (await fstab()).filter((l) => l !== bind).join('\n'))
				await run('systemctl', ['daemon-reload'])
			}
			await zpool('export', name).catch(() => fail(`${name} is in use. Stop apps and shares using it, then try again.`))
			return 'ok'
		},

		'shares-apply': async (_args, stdin) => {
			let body
			try {
				body = JSON.parse(stdin)
			} catch {
				fail('Bad share list')
			}
			if (!Array.isArray(body?.shares) || body.shares.length > 64) fail('Bad share list')
			const seen = new Set()
			const blocks = []
			for (const s of body.shares) {
				const name = String(s?.name ?? '')
				if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/.test(name) || seen.has(name.toLowerCase())) fail(`Bad share name: ${name}`)
				seen.add(name.toLowerCase())
				const path = await inHome(String(s?.path ?? ''))
				if (/[\n\r]/.test(path)) fail('Bad folder')
				blocks.push(`[${name}]\n   path = ${path}\n   valid users = ${user.name}\n   force user = ${user.name}\n   read only = ${s.readOnly ? 'yes' : 'no'}\n   browseable = yes\n`)
			}
			const shares = `${SMB_MARK}. Edit shares in the Omarchy Server web app.\n\n${blocks.join('\n')}`
			const current = await fs.readFile(SMB_CONF, 'utf8').catch(() => null)
			const globalSection = `[global]\n   server string = Omarchy Server\n   server min protocol = SMB2_10\n   map to guest = never\n   restrict anonymous = 2\n   disable netbios = yes\n   smb ports = 445\n`
			if (current === null || current.startsWith(SMB_MARK)) await writeAtomic(SMB_CONF, `${SMB_MARK}\n${globalSection}\n${blocks.join('\n')}`)
			else {
				await writeAtomic(SMB_INCLUDE, shares)
				if (!current.includes(`include = ${SMB_INCLUDE}`)) await writeAtomic(SMB_CONF, `${current.replace(/\n*$/, '\n')}\n# Added by Omarchy Server\n   include = ${SMB_INCLUDE}\n`)
			}
			if (blocks.length) {
				await run('systemctl', ['enable', '--now', 'smb.service'])
				await run('smbcontrol', ['smbd', 'reload-config']).catch(() => run('systemctl', ['restart', 'smb.service']))
				if (await ufwActive()) await run('ufw', ['allow', '445/tcp', 'comment', 'Omarchy Server shares'])
			} else {
				await run('systemctl', ['disable', '--now', 'smb.service']).catch(() => {})
				if (await ufwActive()) await run('ufw', ['delete', 'allow', '445/tcp']).catch(() => {})
			}
			return 'ok'
		},

		'smb-password': async (_args, stdin) => {
			const pw = String(stdin ?? '').replace(/\n$/, '')
			if (pw.length < 8 || pw.length > 128 || /[\r\n]/.test(pw)) fail('Bad password')
			await run('smbpasswd', ['-s', '-a', user.name], {input: `${pw}\n${pw}\n`})
			return 'ok'
		},

		// An app's port through the firewall (TCP and UDP). Ports below 1024 only for apps you allowed
		// to use them (omarchyd asks you first); never SSH, omarchyd or the desktop share.
		'firewall-open': async ([port]) => {
			const p = Number(port)
			if (!Number.isInteger(p) || p < 1 || p > 65535 || [22, 2021, 5900].includes(p)) fail('Bad port')
			if (await ufwActive()) for (const proto of ['tcp', 'udp']) await run('ufw', ['allow', `${p}/${proto}`, 'comment', 'Omarchy Server app'])
			return 'ok'
		},
		// Let your (rootless) containers listen on ports from N up, for apps you allowed to use
		// system ports such as 53 or 443. Only ever lowers the limit; kept across restarts.
		'low-ports': async ([n]) => {
			const want = Number(n)
			if (!Number.isInteger(want) || want < 1 || want > 1024) fail('Bad port')
			const now = Number((await run('sysctl', ['-n', 'net.ipv4.ip_unprivileged_port_start'])).trim())
			if (Number.isInteger(now) && now <= want) return 'ok'
			await fs.writeFile('/etc/sysctl.d/60-omarchy-server-ports.conf', `# Omarchy Server: apps you allowed to use system ports\nnet.ipv4.ip_unprivileged_port_start = ${want}\n`, {mode: 0o644})
			await run('sysctl', ['-w', `net.ipv4.ip_unprivileged_port_start=${want}`])
			return 'ok'
		},
		'firewall-close': async ([port]) => {
			const p = Number(port)
			if (!Number.isInteger(p) || p < 1 || p > 65535 || [22, 2021, 5900, 7780].includes(p)) fail('Bad port')
			if (await ufwActive()) for (const proto of ['tcp', 'udp']) await run('ufw', ['delete', 'allow', `${p}/${proto}`]).catch(() => {})
			return 'ok'
		},
	}

	return {
		async handle(verb, args = [], stdin = '') {
			if (!Object.hasOwn(verbs, verb)) fail(`Unknown action: ${verb}`)
			return verbs[verb](args, stdin)
		},
	}
}

// ---- run as a program (through sudo) ------------------------------------------------------------
async function main() {
	const [verb, ...args] = process.argv.slice(2)
	try {
		const name = process.env.SUDO_USER
		const uid = Number(process.env.SUDO_UID)
		const gid = Number(process.env.SUDO_GID)
		if (process.getuid() !== 0 || !name || !uid) fail('Run this through sudo as the Omarchy Server owner')
		const passwd = (await readFile('/etc/passwd', 'utf8')).split('\n').map((l) => l.split(':')).find((f) => f[0] === name && Number(f[2]) === uid)
		if (!passwd) fail('Unknown user')
		let stdin = ''
		if (verb === 'shares-apply' || verb === 'smb-password') for await (const c of process.stdin) stdin += c
		const helper = createHelper({user: {name, uid, gid, home: passwd[5]}})
		process.stdout.write(`${await helper.handle(verb, args, stdin)}\n`)
	} catch (error) {
		process.stderr.write(`${error instanceof HelperError ? error.message : 'The helper failed'}\n`)
		if (!(error instanceof HelperError)) process.stderr.write(`${error?.stack ?? error}\n`)
		process.exit(error instanceof HelperError ? 2 : 1)
	}
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
