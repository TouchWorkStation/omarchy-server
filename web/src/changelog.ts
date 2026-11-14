// What's new, newest first. Shown once after an update (everything since the version this device last saw),
// and any time from Settings → Software update. Keep each line short and about what the person can now do.
export type Release = {version: string; date: string; title: string; added?: string[]; fixed?: string[]}

export const CHANGELOG: Release[] = [
	{
		version: '0.9.6',
		date: '2026-11-13',
		title: 'Dock your way',
		added: [
			'Desktop & Dock → Dock: put the dock on the left, bottom, right or top, and set the icon size anywhere from 28 to 80 px with a slider.',
			'Dock animations: icons lift or magnify (macOS-style, with adjustable magnification) under the pointer, and apps bounce while they open. Each can be turned off, and they turn down by themselves when your computer asks for reduced motion.',
		],
		fixed: [
			'Full screen now says why the Windows / Super key isn’t reaching the desktop: browsers only hand it over on the secure (https://) address, in Chrome, Edge or Brave. On a Linux computer, Right Alt now works as Super by default.',
		],
	},
	{
		version: '0.9.5',
		date: '2026-11-13',
		title: 'The Super key reaches your desktop',
		added: [
			'Your Windows / ⌘ / Super key now always reaches the Omarchy desktop and your machines as Super, from any browser that receives it.',
			'Computers that keep Super for themselves (an Omarchy or Windows desktop): in the console’s Keys menu, choose Right Alt or Right Ctrl to work as Super instead. Your choice is remembered on that browser.',
			'A Super button in the console toolbar holds Super down until you click it again, so Super + Enter, Super + Space and the rest work from any keyboard.',
			'Keys menu shortcuts for the Omarchy desktop: app launcher, Omarchy menu, terminal, close window and all shortcuts.',
			'On a phone or tablet, the super key works like ctrl and alt: tap it, then the next key. Double tap it for Super on its own.',
		],
	},
	{
		version: '0.9.4',
		date: '2026-11-13',
		title: 'More security, nothing taken away',
		added: [
			'Settings → Security. “Always use the secure address” (off until you turn it on) sends browsers opening a page over http:// to https://, here and in your apps. App clients and phone apps aren’t redirected.',
			'“Lock after viewing remotely” (on): after you sign in to the server’s screen from here, it locks again a minute after the last viewer leaves, so it isn’t left signed in at the machine. A reload or reconnect within that minute keeps it open.',
			'New servers get a certificate that browsers only accept for your home network (local names and private addresses), never for a real website. Existing servers keep theirs, so your devices keep working; Settings → Security → Replace switches when you’re ready.',
		],
		fixed: [
			'Storage pools never run setuid programs or use device files stored on them. New and imported pools are set up that way, and existing pools are updated automatically once the installer has been run again.',
			'An app’s exports.sh no longer receives the server’s key for app secrets; it gets the same values as before, and apps installed from now on only get their own.',
			'The machine Monitor tab accepts commands that look at or act on the machine (info, sendkey, stop, cont, system_reset…), but not ones that read or write files on the server or start programs.',
			'Only the owner can change which server this web app connects to.',
			'The “Use network ports below 1024” permission now says plainly that it applies to the whole server.',
		],
	},
	{
		version: '0.9.3',
		date: '2026-11-13',
		title: 'Security fixes',
		fixed: [
			'Apps no longer receive your Omarchy Server sign-in. Browsers send a server’s cookies to every port on it; each app’s gateway now removes all of Omarchy Server’s own cookies before a request reaches the app, and stops apps from setting them.',
			'The desktop’s screen is now shared on a private socket only you can open, instead of a local port that other programs and host-network containers could reach. Existing servers are moved over automatically.',
			'Guessing passwords is slowed down everywhere (wrong tries queue up and wait longer each time), without ever locking you out. A 2FA code now works only once.',
			'Installing an app now also asks before giving it the server’s own network, folders on the server, or system access (D-Bus, other programs). Your whole home folder, its hidden folders and system folders are never given to an app. Apps you already installed keep working and updating as before.',
		],
	},
	{
		version: '0.9.2',
		date: '2026-11-13',
		title: 'Brave and other streamed apps open securely',
		fixed: [
			'Apps installed before their listing was marked as needing a secure page (Brave (HTTPS) and others) kept opening over http:// and showed “This application requires a secure connection”. Installed apps now follow their listing without reinstalling.',
			'Chromium, Firefox, Calibre, digiKam, Kdenlive, FileZilla, LibreOffice and Obsidian open over https:// too.',
		],
	},
	{
		version: '0.9.1',
		date: '2026-11-13',
		title: 'Icons that follow your theme',
		added: [
			'The Omarchy theme now takes every colour from the theme your Omarchy desktop is using (backgrounds, text and its full colour palette), so changing the desktop’s theme changes Omarchy Server too.',
			'Dock, desktop and home screen icons follow the theme: flat, Omarchy-style tiles in the Omarchy theme, tinted from the palette in Midnight, Neon, Ember and Daylight, and the colourful originals in Horizon.',
			'The tab bar on phones is tinted the same way.',
		],
	},
	{
		version: '0.9.0',
		date: '2026-11-13',
		title: 'Machines, the Proxmox way',
		added: [
			'On the desktop, Machines looks like Proxmox: a server and machine tree, a toolbar (Start, Shutdown, Reboot, Stop, Pause, Hibernate, Console, Clone, Remove), settings panels and a task log.',
			'Summary with live CPU, memory, network and disk graphs, plus notes for each machine.',
			'Hardware: memory in MiB, sockets and cores, CPU type, BIOS (SeaBIOS or UEFI), display, chipset, network model, MAC address and disconnect; add, grow, tune and remove disks; add CD/DVD drives and insert or eject ISOs from your Home folder.',
			'Options: rename, start at boot with order and delay, boot order (disks, CD/DVD, network), boot menu, protection against deletion, QEMU Guest Agent, tablet pointer, ACPI and KVM.',
			'Cloud-Init: change the user, hostname, SSH public keys and password (only a hash is kept); applied at the next start.',
			'Snapshots (take, roll back, delete), Backups to Home → Backups → Machines (live for running machines) with restore as a new machine, full clones, the QEMU monitor and a task history.',
			'On phones and tablets, the machine sheet has every one of these settings in tabs.',
		],
		fixed: ['The https:// certificate is only made once an app needs it.'],
	},
	{
		version: '0.8.13',
		date: '2026-11-13',
		title: 'Secure connections (https://)',
		added: [
			'Omarchy Server and every app now also answer https:// on the same address and port, with your server’s own certificate.',
			'Apps that need a secure page (Brave (HTTPS), Vaultwarden, Actual) open over https:// automatically, and work inside windows when you use the secure address.',
			'Settings → Secure connection: switch to the secure address, and download the certificate to trust this server on your devices so browsers stop warning.',
		],
	},
	{
		version: '0.8.12',
		date: '2026-11-13',
		title: 'The App Store shows every app',
		fixed: [
			'The App Store kept showing the apps from when the store was first downloaded; it now picks up new apps within the hour, and all 586 appear right after this update.',
		],
	},
	{
		version: '0.8.11',
		date: '2026-11-13',
		title: 'Updates that fit in less memory',
		fixed: [
			'Updating no longer reinstalls every package each time, only when they change, so it needs far less memory and finishes sooner.',
			'On a computer with little free memory, the installer borrows temporary swap for the build and removes it afterwards.',
		],
	},
	{
		version: '0.8.10',
		date: '2026-11-13',
		title: 'About 580 apps',
		added: [
			'The TouchWorkStation store now lists about 580 apps, built from the public self-hosting catalogs and the projects’ own compose files.',
			'Apps that need a 32-character key (BookStack, Firefly III, Invoice Ninja and others) get one generated for your server.',
		],
		fixed: ['Apps that use ports below 1024, such as Pi-hole on port 53, now have those ports opened in the firewall.'],
	},
	{
		version: '0.8.9',
		date: '2026-11-13',
		title: 'Apps that need extra access',
		added: [
			'Container managers (Portainer, Dockge, Dozzle), DNS blockers (Pi-hole, AdGuard Home), VPNs (WireGuard) and reverse proxies can now be installed. The store lists exactly what extra access each one needs and installs only after you tick “Allow”.',
			'Apps that manage containers get your own rootless container engine, never the system one.',
			'Apps can now use ports below 1024 (DNS on 53, web on 80 and 443) and UDP ports, when you allow it.',
		],
		fixed: ['An update that would need new access is refused with a clear message instead of quietly gaining it.'],
	},
	{
		version: '0.8.8',
		date: '2026-11-13',
		title: 'Only the TouchWorkStation store',
		added: ['The TouchWorkStation store now has 150 apps, each packaged from its project’s own official image, with descriptions written for it.'],
		fixed: [
			'The Umbrel store is removed from your server. Apps you already installed from it keep running; to move one to the TouchWorkStation version, uninstall it and install it again from the store.',
		],
	},
	{
		version: '0.8.7',
		date: '2026-11-13',
		title: 'The TouchWorkStation app catalog',
		added: [
			'44 apps in the TouchWorkStation store, each packaged from the project’s own official Docker image with a description written for it: Jellyfin, Plex, Immich, Nextcloud, Home Assistant, Paperless-ngx, Open WebUI, the Sonarr/Radarr family, Gitea and more.',
			'Apps can use your Videos, Music, Pictures, Documents and Downloads folders, and open the extra ports they need (sync, torrents, SSH).',
			'New servers start with the TouchWorkStation store only. Other stores can still be added under App Store → Stores, and an installed app always stays with the store it came from.',
		],
		fixed: ['Folder paths written as ${NAME:-default} in a compose file are now understood.'],
	},
	{
		version: '0.8.6',
		date: '2026-11-13',
		title: 'Every Settings button works',
		fixed: [
			'Home Assistant (and other apps on the server’s own network) spun forever when opened: its port was never let through Omarchy’s firewall. It is now.',
			'Restart server and Shut down server now do what they say.',
			'System logs, Device name, Wi-Fi, Two-factor authentication and Signed-in devices (Sign out, Sign out all other devices) now work. Signing a device out also ends its access to your apps.',
			'Factory reset now resets Omarchy Server: its apps, machines and accounts go, and it starts first-time setup. Your own files, storage pools and the Omarchy desktop are left alone.',
		],
	},
	{
		version: '0.8.5',
		date: '2026-11-13',
		title: 'Sign in the desktop from anywhere',
		added: [
			'When the Omarchy desktop is at its sign-in screen, its console in Machines now offers “Sign in to the desktop”. Confirm your Omarchy Server password and the desktop signs you in once, the same way Omarchy’s own first boot does. It also clears a lockout after too many wrong passwords.',
			'Open waits for an app that’s still starting (Home Assistant often takes a minute), then goes to it, instead of landing on a page that doesn’t load.',
		],
	},
	{
		version: '0.8.4',
		date: '2026-11-13',
		title: 'Open goes to the app’s own link',
		added: [
			'Open now takes this tab straight to the app’s own address and port, like clicking a container’s link in Docker. Nothing is wrapped around the app, so nothing can stop it showing. Your browser’s back button returns to Omarchy Server.',
			'The Address on an app’s page is a link you can tap.',
		],
		fixed: ['In the desktop layout, a window that hasn’t shown its app after 8 seconds offers Open in a tab.'],
	},
	{
		version: '0.8.3',
		date: '2026-11-12',
		title: 'Apps open straight away',
		added: [
			'Open goes straight to the app’s page in its window. No more checks first.',
			'The Omarchy Server icon now sits in Omarchy’s own top bar (current Omarchy has no Waybar). It’s added once by itself; omarchy-server widget off removes it.',
			'The bell lights up when an update is waiting. Omarchy Server checks GitHub on its own every few hours; tap the note to update.',
		],
		fixed: [
			'Apps loaded but stayed hidden behind the spinner. That was a bug in the loading cover, and it’s fixed.',
			'The Omarchy desktop in Machines starts its screen sharing when it isn’t running, or says exactly why it can’t.',
		],
	},
	{
		version: '0.8.2',
		date: '2026-11-12',
		title: 'Omarchy themes',
		added: [
			'Settings → Appearance → Omarchy → Themes: every Omarchy theme with its preview and colours. Tap one to switch your whole desktop, like Takeout.',
			'Get more themes: the community themes from the Omarchy manual, ready to download in one tap. Themes you added can be removed again.',
			'When an app is slow to show, Omarchy Server now checks it and says why: still starting, not listening, or not allowed inside a window.',
		],
		fixed: [
			'The page sometimes stopped scrolling until you reloaded (after closing two sheets in a row). Fixed for good.',
			'Backgrounds and colours now work with current Omarchy, which keeps its theme in ~/.local/state, and follow the desktop when it changes theme.',
		],
	},
	{
		version: '0.8.1',
		date: '2026-11-12',
		title: 'Apps load, wallpapers in Appearance',
		added: ['Wallpaper now lives in Settings → Appearance, with the backgrounds from your Omarchy themes. Picking one sets it right away.'],
		fixed: [
			'Apps that run on their own port (Home Assistant, Plex, Pi-hole, AdGuard and others) spun forever inside Omarchy Server. They now open through a viewer port that lets them show, without proxy headers they reject.',
			'Apps whose web port comes from their settings (like Mempool) now get their web page connected.',
			'An app that takes a long time to show now says so after 15 seconds, with Try again and Open in a tab, instead of spinning forever.',
			'Removed the old wallpaper picker from the main Settings list.',
		],
	},
	{
		version: '0.8.0',
		date: '2026-11-12',
		title: 'One sign-in, every app, Omarchy backgrounds',
		added: [
			'Signing in to Omarchy Server now signs you in to every app too. No app asks for an Omarchy Server sign-in of its own.',
			'Every app in the store can be installed. Apps that need others (like Mempool needing Bitcoin Node and Electrs) list them and install them first, all in one go.',
			'Apps that talk to each other share a network, and apps that use Tor get a shared Tor connection.',
			'The Omarchy theme uses your Omarchy desktop’s backgrounds and colours. Pick any background from any Omarchy theme, or follow whatever the desktop shows.',
			'For apps that have a login of their own inside, the app screen shows its username and password, ready to copy.',
		],
		fixed: [
			'Apps that look up their own parts by name (like Immich’s database) can find them now.',
			'An app that other apps need can’t be uninstalled out from under them.',
		],
	},
	{
		version: '0.7.3',
		date: '2026-11-12',
		title: 'App windows load',
		fixed: [
			'Apps like Home Assistant showed “Couldn’t reach” in their window: they went through extra ports the firewall blocks. They now load straight from their own port, which is already open.',
			'Removed leftover wording from another project in app window messages.',
		],
	},
	{
		version: '0.7.2',
		date: '2026-11-12',
		title: 'Apps open right here',
		added: [
			'Open shows the app full screen inside Omarchy Server, in the same tab, like an app on your phone. Back (on screen or your phone’s own back gesture) returns to where you were.',
			'The app screen has Reload, and a button to open it in its own browser tab if you ever want that.',
		],
		fixed: [
			'Open in the App Store and on an app’s page no longer starts a new browser tab.',
			'Desktop windows sign the browser in to apps by themselves instead of opening a sign-in tab.',
		],
	},
	{
		version: '0.7.1',
		date: '2026-11-12',
		title: 'App installs fixed',
		fixed: [
			'Store apps failed to install and showed “Unknown”: their own files were handed to the container user, so Omarchy Server couldn’t read them anymore. Only their data folders are handed over now.',
			'A failed install shows what went wrong on the app’s page, with a Try again button.',
			'Apps that name their web container differently (like SearXNG) now install.',
		],
	},
	{
		version: '0.7.0',
		date: '2026-11-12',
		title: 'Software update',
		added: [
			'Check for updates now checks GitHub for a newer Omarchy Server and shows what’s new in it.',
			'Update installs it from the web app: download, build and restart, and it rolls back if anything fails.',
			'When an update also needs the installer (new packages or storage changes), Settings says so and shows the command.',
		],
		fixed: ['Removed the Beta channel switch, since there are only stable updates for now.'],
	},
	{
		version: '0.6.1',
		date: '2026-11-12',
		title: 'Fixes',
		fixed: [
			'Machines failed to start with “does not support video model virtio”. They now use the standard display, and Start finishes a machine that failed that way.',
			'Apps like Gitea that need their own settings (from the app’s exports.sh) now install: about 300 apps install, up from about 200.',
		],
	},
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
