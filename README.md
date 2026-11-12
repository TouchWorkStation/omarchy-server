# Omarchy Server

Your Omarchy machine as a home server you open in a browser: a touch-first web app on every device
(apps, files, NAS, virtual machines, settings), with your real Omarchy desktop one click away.

> Early work in progress. Step 1 of the plan: the web app running on its own backend.

## How it fits together

| Part | What it is |
| --- | --- |
| **Web app** (`web/`, `server/`) | The UmbrelOS Touch interface and its server: sign-in, sessions, file streaming, app windows. Faces the network. |
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
| `omarchyd` | `127.0.0.1:2021` only | The backend: accounts, stats, files |
| `omarchy-server-web` | port `7780` | The web app you open in a browser |

Then open `http://<machine-ip>:7780` and sign in. Run the same command again to update; your account,
sessions and files are kept.

Logs: `journalctl --user -u omarchyd -u omarchy-server-web -f`

## Status

- [x] Sign-in (scrypt-hashed passwords, rate-limited), system stats, files: browse, view, upload,
      download, rename, copy, move, trash, restore, search, recents, favorites
- [ ] Your real Omarchy desktop in the browser (Hyprland headless + wayvnc + noVNC)
- [ ] Apps and the App Store (Docker Compose behind the sign-in)
- [ ] NAS (Btrfs pools, SMB/NFS shares, drive health and sleep) and virtual machines (libvirt)
- [x] One-line installer with systemd user services
- [ ] An AUR package, then an install ISO

## Credits

Omarchy is by DHH and the Omarchy contributors. This project is independent and not affiliated with
Omarchy or Umbrel.
