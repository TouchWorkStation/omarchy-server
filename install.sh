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
if ! command -v pacman >/dev/null; then
	found=$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-$ID}") || uname -s)
	die "This installer is for Omarchy (Arch Linux), but this machine runs $found. Run it on your Omarchy machine."
fi
command -v systemctl >/dev/null || die "systemd is required."

# 1. Packages (the only step that uses sudo). Machines: QEMU + libvirt (per-user session),
#    passt for their networking, xorriso (libisoburn) for cloud-init seeds.
need=()
for pkg in nodejs npm git openssl qemu-base libvirt passt libisoburn; do pacman -Qi "$pkg" >/dev/null 2>&1 || need+=("$pkg"); done
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
ExecStart=$NODE $APP/server/cli.mjs --port $PORT --data $BASE/web --backend http://127.0.0.1:2021
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable omarchyd.service omarchy-server-web.service >/dev/null
systemctl --user restart omarchyd.service omarchy-server-web.service

# Omarchy turns on a firewall (ufw) that blocks incoming connections: let the web app through.
if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
	if ! sudo ufw status | grep -qE "^$PORT/tcp +ALLOW"; then
		say "Opening port $PORT in the firewall (sudo needed)"
		sudo ufw allow "$PORT/tcp" comment 'Omarchy Server' >/dev/null
	fi
fi

# Machine port forwards live in 40000-49999. Nothing listens there until you add a forward to a
# machine, so opening the range only lets forwards you create be reached from your network.
if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
	if ! sudo ufw status | grep -qE "^40000:49999/tcp +ALLOW"; then
		say "Allowing machine port forwards (40000-49999) through the firewall"
		sudo ufw allow 40000:49999/tcp comment 'Omarchy Server machine forwards' >/dev/null
		sudo ufw allow 40000:49999/udp comment 'Omarchy Server machine forwards' >/dev/null
	fi
fi

# Keep the services running when you're not logged in (needs sudo once).
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
	say "Letting Omarchy Server run while you're logged out (sudo needed)"
	sudo loginctl enable-linger "$USER" || say "Couldn't enable that; the server will run only while you're logged in."
fi

sleep 2
if systemctl --user is-active --quiet omarchy-server-web.service && systemctl --user is-active --quiet omarchyd.service; then
	ips=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -vE '^(172\.(1[6-9]|2[0-9]|3[01])|10\.21)\.' || true)
	say "Omarchy Server is running."
	private_only=yes
	for ip in $ips; do
		printf '    http://%s:%s\n' "$ip" "$PORT"
		case "$ip" in 10.*) ;; *) private_only=no ;; esac
	done
	if [ "$private_only" = yes ] && [ -n "$ips" ]; then
		printf '\n    This machine only has a private address, so it is probably a VM behind NAT. Your other\n'
		printf '    devices cannot open that address directly: on the VM host, forward a port to %s.\n\n' "$PORT"
	fi
	printf '    Logs: journalctl --user -u omarchyd -u omarchy-server-web -f\n'
else
	die "A service didn't start. See: journalctl --user -u omarchyd -u omarchy-server-web -n 50"
fi
