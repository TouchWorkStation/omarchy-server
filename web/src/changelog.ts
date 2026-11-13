// What's new, newest first. Shown once after an update (everything since the version this device last saw),
// and any time from Settings → Software update. Keep each line short and about what the person can now do.
export type Release = {version: string; date: string; title: string; added?: string[]; fixed?: string[]}

export const CHANGELOG: Release[] = [
	{
		version: '0.6.0',
		date: '2026-11-12',
		title: 'Terminal, desktop and 400 apps',
		added: [
			'Terminal: a real shell on the server from the web app, and a shell inside any installed app.',
			'Omarchy desktop: see and use this server’s own Omarchy desktop from Machines, behind your sign-in.',
			'App Store: about 400 apps, in your TouchWorkStation store and Popular apps, added automatically. Apps that need something Omarchy Server can’t provide yet say why instead of failing.',
			'Top-bar icon, launcher entries and an omarchy-server command to open, check and restart the server.',
		],
	},
	{
		version: '0.5.0',
		date: '2026-11-12',
		title: 'ZFS',
		added: [
			'ZFS pools: choose Btrfs or ZFS for a new pool, with Combined, Mirrored, RAID-Z1 and RAID-Z2 layouts.',
			'Import existing ZFS pools, including ones from another computer, without changing anything on them. They show up in Files under Home → Pools.',
			'ZFS pools show their health, drive errors and last error check, and can be checked or removed from here.',
			'ZFS is optional: add it by running the installer with --zfs.',
		],
		fixed: ['A ZFS pool’s last error check is shown instead of “Never checked”.'],
	},
	{
		version: '0.4.0',
		date: '2026-11-12',
		title: 'One-tap machines',
		added: [
			'Desktops: Ubuntu Desktop, Debian Desktop and Fedora Desktop install with one tap and start into their desktop.',
			'More systems: Ubuntu 26.04, Fedora Server and Alpine Linux.',
			'Omarchy as a machine: it downloads the official ISO and installs itself with your username and password.',
			'Your own ISO: any .iso in Files shows up under New machine. Windows 10 and 11 install by themselves with your account; other ISOs boot their installer in the console.',
		],
	},
	{
		version: '0.3.0',
		date: '2026-11-12',
		title: 'Apps, NAS and an installer',
		added: [
			'App Store: add an app store by its address, then install, open, stop, update and remove apps. Apps run in rootless Podman as your own user.',
			'Every app is behind your Omarchy Server sign-in. Sign in once and every app on the server opens.',
			'Storage: see every drive’s health, temperature and age, and set hard drives to sleep when idle.',
			'Pools: combine blank drives into a pool (mirrored if you like), import existing Btrfs drives, add drives later, and check for errors. Pools show up in Files under Home → Pools.',
			'Share any folder on your network (SMB) from Files.',
			'Installer ISO: one download sets up a new Omarchy Server (Settings → Installer ISO).',
		],
		fixed: ['Settings no longer shows options that don’t apply to Omarchy Server.'],
	},
	{
		version: '0.2.0',
		date: '2026-11-12',
		title: 'Virtual machines',
		added: [
			'Machines: create Ubuntu, Debian or Arch Linux virtual machines from the web app. Each download is checked against its publisher’s checksum before use.',
			'Your machine’s account is set up on first boot. Only a hashed copy of its password is ever written.',
			'Open a machine’s screen in the browser, with the touch keyboard and paste key.',
			'Port forwarding: reach SSH, web or remote desktop inside a machine from your other devices.',
		],
		fixed: ['Omarchy Server now uses its own name everywhere.'],
	},
	{
		version: '0.1.0',
		date: '2026-11-11',
		title: 'First light',
		added: ['Sign in, system stats, and your real home folder as Files: browse, preview, upload, download, organise, trash and restore.', 'One-line installer that runs everything as your own user.'],
	},
]

const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0)
export function newer(a: string, b: string) {
	const x = parse(a)
	const y = parse(b)
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
	return false
}
// Releases a device hasn't seen yet. With no record (first run of this feature), just the newest one.
export function unseen(current: string, lastSeen: string | null): Release[] {
	const upTo = CHANGELOG.filter((r) => !newer(r.version, current))
	if (!lastSeen) return upTo.slice(0, 1)
	return upTo.filter((r) => newer(r.version, lastSeen))
}
