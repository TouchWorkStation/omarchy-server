# Omarchy Server

Your Omarchy machine as a home server you open in a browser: a touch-first web app on every device
(apps, files, NAS, virtual machines, settings), with your real Omarchy desktop one click away.

> Early work in progress: web app, files and virtual machines work; apps and NAS are next.

## How it fits together

| Part | What it is |
| --- | --- |
| **Web app** (`web/`, `server/`) | The Omarchy Server interface and its server: sign-in, sessions, file streaming, app windows. Faces the network. |
| **omarchyd** (`omarchyd/`) | The backend. Runs as your own user (never root), listens on `127.0.0.1` only, and answers the web app with real data: accounts, system stats from `/proc`, and your real home folder. |

Files in the web app are your actual home folder, so the browser and the Omarchy desktop see the same
files. Trash is the freedesktop trash that Omarchy's file manager uses. Hidden files stay hidden, and
nothing outside your home folder can be reached, including through symlinks. The web app's wallpaper
is your current Omarchy background.

## Install on a new computer (ISO)

**[Download the Omarchy Server installer ISO](https://github.com/TouchWorkStation/omarchy-server/releases/latest/download/omarchy-server.iso)**
(checksum: `omarchy-server.iso.sha256` on the same release). Write it to a USB stick (balenaEtcher,
Impression, or `dd`), boot from it, and follow the screen:

1. Arch Linux is installed with Arch's own guided installer, pre-filled for Omarchy Server. You pick
   the drive (it's erased), your user and timezone.
2. On first start you're logged in once on the console: Omarchy Server installs and you create your
   account there.
3. Omarchy itself installs, and the computer restarts into it.

The ISO is Arch's official one plus one setup command (`iso/`), built by GitHub Actions on every
release. It needs an internet connection while installing.

## Install (on the Omarchy machine)

Run this as your normal user, not with sudo:

```sh
curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/omarchy-server/main/install.sh | bash
```

It installs Node.js if needed (the only step that asks for sudo, plus one to keep the server running
while you're logged out), builds the app in `~/.local/share/omarchy-server`, asks you to create your
account **in the terminal** (your password never crosses the network), and starts two systemd user
services:

| Service | Listens on | Does |
| --- | --- | --- |
| `omarchyd` | `127.0.0.1:2021` only, plus each app's port | The backend: accounts, stats, files, machines, apps, storage. App ports admit only signed-in browsers |
| `omarchy-server-web` | port `7780` | The web app you open in a browser |

Then open `http://<machine-ip>:7780` and sign in. Run the same command again to update; your account,
sessions and files are kept.

Logs: `journalctl --user -u omarchyd -u omarchy-server-web -f`

## Machines

Tap an operating system and it installs itself:

| Kind | How it installs |
| --- | --- |
| Ubuntu, Debian, Fedora, Arch, Alpine (Server) | Cloud image + cloud-init: your account, ready in a minute or two |
| Ubuntu, Debian, Fedora (Desktop) | Same image; the first start installs the desktop, then restarts into it |
| Omarchy | Official ISO + a `cidata` drive with its unattended-install files (your account, hashed password) |
| Windows 10/11 (your ISO) | Put Microsoft's ISO in Files; an answer file installs it with your local account (Pro, unactivated) |
| Any other ISO in Files | Boots its installer; finish it in the console |

Virtual machines run under libvirt's **per-user session** (`qemu:///session`), so QEMU runs as you,
not root, and you don't need the `libvirt` group. Each machine:

- starts from a cloud image listed in the [machine catalog](https://github.com/TouchWorkStation/app-store/blob/main/machines/catalog.json)
  (a copy ships with omarchyd as a fallback). Images come from their publishers (Ubuntu, Debian,
  Arch) and must match the publisher's own checksum file, or they're thrown away;
- gets its account from cloud-init on first boot. Only a SHA-512 crypt hash of the password is
  written to disk;
- shares the server's network through passt. To reach a service inside it, add a port forward
  (server ports 40000-49999). The installer lets that range through ufw; nothing listens there
  until you add a forward;
- shows its screen over VNC on a unix socket in its own folder (never a TCP port), bridged to the
  browser only with a single-use, 30-second ticket.

Files live in `~/.local/share/omarchy-server/omarchyd/machines`. Needs an x86-64 server; KVM is used
when `/dev/kvm` is available (otherwise machines still run, slowly).

## Apps

A new server starts with two stores, downloaded from GitHub by your server (nothing from them is
copied into Omarchy Server): the TouchWorkStation store and a large public store of about 400 apps
(shown as "Popular apps"). Add or remove stores under App Store → Stores.
Apps that rely on things Omarchy Server doesn't provide yet (apps that depend on other apps, fixed
internal network addresses, or settings it doesn't supply) are listed with the reason and can't be
installed. An app's own `exports.sh` (extra settings such as ports or derived passwords) runs in a
bubblewrap sandbox with no network, a read-only system and only its own app folder. Store apps
mostly run as user 1000, so each app's folder is handed to that user inside
its container, and it gets access to Downloads through an ACL.
Stores use the community-store layout: a store manifest at the root and a folder per app with its
manifest and compose file. Apps run in **rootless Podman** as you (no root, no docker group, no
Docker socket on the network). Each app's web port is served by omarchyd's gateway, which only lets
in browsers signed in to Omarchy Server, and forwards to the app on `127.0.0.1`.

## Desktop and terminal

- **Omarchy desktop:** Machines → Omarchy desktop shows this server's own desktop, live. `wayvnc`
  shares the signed-in Hyprland session on `127.0.0.1:5900` only; the web app reaches it through
  omarchyd with a single-use ticket, so it's behind your Omarchy Server sign-in. It's available
  while someone is signed in to Omarchy on the server.
- **Terminal:** a login shell in a real pty (via util-linux `script`), or a shell inside an app.
- **On the server:** `omarchy-server` (status, open, restart, logs), "Omarchy Server" in the
  launcher, and a top-bar icon (`omarchy-server widget off` removes it).

## Storage

Settings → Storage shows every drive with its health, and lets you create **Btrfs pools** (combined,
mirrored or RAID 10), import existing Btrfs drives, add drives, run error checks and set hard drives
to sleep. Pools mount at `~/Pools/<name>`, so they're in Files, on the Omarchy desktop and shareable
from Files over SMB.

### ZFS (optional)

```sh
curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/omarchy-server/main/install.sh | bash -s -- --zfs
```

This builds the current OpenZFS release from the AUR (`zfs-utils`, `zfs-dkms`, with yay) for your
exact kernel, after updating the system with `omarchy update` and making sure the kernel headers
match the kernel. Then Storage
offers ZFS pools (Combined, Mirrored, RAID-Z1, RAID-Z2, created on blank drives only) and imports
existing ZFS pools unchanged: a pool from another computer asks before importing, and a pool whose
datasets would mount over a system folder is refused. **Kernel updates rebuild ZFS**, and on a
brand-new kernel that can fail until OpenZFS supports it, leaving pools unavailable until it does.

Root-only work goes through one small helper (`helper/helper.mjs`), installed root-owned at
`/usr/local/libexec/omarchy-server/` and allowed by a single sudoers rule. It checks every request
itself and **never erases a drive that holds anything**: pools are created only on blank drives, and
the app shows the one command (`sudo wipefs -a /dev/sdX`) to clear a drive yourself.

## Status

- [x] Sign-in (scrypt-hashed passwords, rate-limited), system stats, files: browse, view, upload,
      download, rename, copy, move, trash, restore, search, recents, favorites
- [ ] Your real Omarchy desktop in the browser (Hyprland headless + wayvnc + noVNC)
- [x] Apps and the App Store: stores you add (community-store layout), rootless Podman + Compose,
      every app behind the Omarchy Server sign-in
- [x] Virtual machines: one-tap Ubuntu/Debian/Fedora/Arch/Alpine (server and desktop), Omarchy, Windows from
      your ISO, any ISO; checksum-verified, set up with cloud-init,
      run as your user (libvirt session, passt networking), screen in the browser, port forwarding
- [x] NAS: drive health (SMART), drive sleep, Btrfs and ZFS pools (new on blank drives, import,
      error checks) in Home → Pools, SMB shares from Files
- [ ] NFS shares
- [x] One-line installer with systemd user services
- [x] Installer ISO
- [ ] An AUR package

## Credits

Omarchy is by DHH and the Omarchy contributors. This project is independent and not affiliated with
Omarchy.
