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
| `omarchyd` | `127.0.0.1:2021` only | The backend: accounts, stats, files, machines |
| `omarchy-server-web` | port `7780` | The web app you open in a browser |

Then open `http://<machine-ip>:7780` and sign in. Run the same command again to update; your account,
sessions and files are kept.

Logs: `journalctl --user -u omarchyd -u omarchy-server-web -f`

## Machines

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

## Status

- [x] Sign-in (scrypt-hashed passwords, rate-limited), system stats, files: browse, view, upload,
      download, rename, copy, move, trash, restore, search, recents, favorites
- [ ] Your real Omarchy desktop in the browser (Hyprland headless + wayvnc + noVNC)
- [ ] Apps and the App Store (Docker Compose behind the sign-in)
- [x] Virtual machines: Ubuntu, Debian and Arch cloud images, checksum-verified, set up with cloud-init,
      run as your user (libvirt session, passt networking), screen in the browser, port forwarding
- [ ] NAS (Btrfs pools, SMB/NFS shares, drive health and sleep)
- [x] One-line installer with systemd user services
- [ ] An AUR package, then an install ISO

## Credits

Omarchy is by DHH and the Omarchy contributors. This project is independent and not affiliated with
Omarchy.
