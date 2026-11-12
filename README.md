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

## Try it (on the Omarchy machine)

```sh
npm install && npm run build
node omarchyd/cli.mjs create-owner          # asks for your password in the terminal
node omarchyd/cli.mjs serve &                # backend on 127.0.0.1:2021
node server/cli.mjs --port 7780 --umbrel http://127.0.0.1:2021
```

Then open `http://<machine-ip>:7780` and sign in with your user name and that password.

## Status

- [x] Sign-in (scrypt-hashed passwords, rate-limited), system stats, files: browse, view, upload,
      download, rename, copy, move, trash, restore, search, recents, favorites
- [ ] Your real Omarchy desktop in the browser (Hyprland headless + wayvnc + noVNC)
- [ ] Apps and the App Store (Docker Compose behind the sign-in)
- [ ] NAS (Btrfs pools, SMB/NFS shares, drive health and sleep) and virtual machines (libvirt)
- [ ] Packaging: systemd services, an AUR package, an installer

## Credits

Omarchy is by DHH and the Omarchy contributors. This project is independent and not affiliated with
Omarchy or Umbrel.
