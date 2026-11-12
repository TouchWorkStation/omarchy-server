#!/usr/bin/env bash
# Omarchy Server installer: run as your normal user on Omarchy (or any Arch Linux).
#   curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/omarchy-server/main/install.sh | bash
# Installs to ~/.local/share/omarchy-server and runs as two systemd user services:
#   omarchyd            the backend, on 127.0.0.1:2021 only
#   omarchy-server-web  the web app, on port 7780 (OMARCHY_SERVER_PORT to change)
# Re-run it any time to update. Your account, sessions and files are kept.
set -euo pipefail

REPO="${OMARCHY_SERVER_REPO:-https://github.com/TouchWorkStation/omarchy-server.git}"
BRANCH="${OMARCHY_SERVER_BRANCH:-main}"
PORT="${OMARCHY_SERVER_PORT:-7780}"
BASE="${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-server"
APP="$BASE/app"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not with sudo. It asks for sudo only to install packages."
command -v pacman >/dev/null || die "This installer is for Omarchy / Arch Linux (pacman not found)."
command -v systemctl >/dev/null || die "systemd is required."

# 1. Packages (the only step that uses sudo).
need=()
for pkg in nodejs npm git; do pacman -Qi "$pkg" >/dev/null 2>&1 || need+=("$pkg"); done
if [ ${#need[@]} -gt 0 ]; then
	say "Installing ${need[*]} (sudo needed)"
	sudo pacman -S --needed --noconfirm "${need[@]}"
fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "Node.js 20 or newer is required."

# 2. Code: fresh clone, or update in place.
mkdir -p "$BASE"
if [ -d "$APP/.git" ]; then
	say "Updating Omarchy Server"
	git -C "$APP" fetch --depth 1 origin "$BRANCH"
	git -C "$APP" reset --hard "origin/$BRANCH"
else
	say "Downloading Omarchy Server"
	git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP"
fi

say "Building (a minute or two the first time)"
cd "$APP"
LOG="$BASE/install.log"
if ! { npm ci --no-audit --no-fund --loglevel=error && npm run build; } >"$LOG" 2>&1; then
	tail -n 30 "$LOG" >&2
	die "The build failed. Full log: $LOG"
fi

# 3. Your account, created here in the terminal so the password never crosses the network.
if ! node "$APP/omarchyd/cli.mjs" has-owner --data "$BASE/omarchyd" >/dev/null 2>&1; then
	say "Create your Omarchy Server account"
	if [ -r /dev/tty ]; then
		node "$APP/omarchyd/cli.mjs" create-owner --data "$BASE/omarchyd" </dev/tty
	else
		die "No terminal to type a password in. Run: node $APP/omarchyd/cli.mjs create-owner --data $BASE/omarchyd"
	fi
fi

# 4. Services, started now and at every boot.
mkdir -p "$UNITS"
NODE="$(command -v node)"
cat >"$UNITS/omarchyd.service" <<EOF
[Unit]
Description=Omarchy Server backend (localhost only)
After=network-online.target

[Service]
ExecStart=$NODE $APP/omarchyd/cli.mjs serve --port 2021 --data $BASE/omarchyd
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
cat >"$UNITS/omarchy-server-web.service" <<EOF
[Unit]
Description=Omarchy Server web app
After=omarchyd.service
Wants=omarchyd.service

[Service]
ExecStart=$NODE $APP/server/cli.mjs --port $PORT --data $BASE/web --umbrel http://127.0.0.1:2021
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable omarchyd.service omarchy-server-web.service >/dev/null
systemctl --user restart omarchyd.service omarchy-server-web.service

# Keep the services running when you're not logged in (needs sudo once).
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
	say "Letting Omarchy Server run while you're logged out (sudo needed)"
	sudo loginctl enable-linger "$USER" || say "Couldn't enable that; the server will run only while you're logged in."
fi

sleep 2
if systemctl --user is-active --quiet omarchy-server-web.service && systemctl --user is-active --quiet omarchyd.service; then
	ips=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -vE '^(172\.1[6-9]|172\.2|172\.3[01]|10\.21)\.' || true)
	say "Omarchy Server is running."
	for ip in $ips; do printf '    http://%s:%s\n' "$ip" "$PORT"; done
	printf '    Logs: journalctl --user -u omarchyd -u omarchy-server-web -f\n'
else
	die "A service didn't start. See: journalctl --user -u omarchyd -u omarchy-server-web -n 50"
fi
