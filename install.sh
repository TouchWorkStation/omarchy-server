#!/usr/bin/env bash
# Omarchy Server installer: run as your normal user on Omarchy (or any Arch Linux).
#   curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/omarchy-server/main/install.sh | bash
# Installs to ~/.local/share/omarchy-server and runs as two systemd user services:
#   omarchyd            the backend, on 127.0.0.1:2021 only
#   omarchy-server-web  the web app, on port 7780 (OMARCHY_SERVER_PORT to change)
# Re-run it any time to update. Your account, sessions and files are kept.
#
# Add ZFS (optional) with:  curl -fsSL …/install.sh | bash -s -- --zfs
set -euo pipefail

ZFS=0
for arg in "$@"; do
	case "$arg" in
		--zfs) ZFS=1 ;;
		*) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
	esac
done

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

# 1. Packages. Machines: QEMU + libvirt (per-user session), passt for their networking, xorriso
#    (libisoburn) for cloud-init seeds. Apps: rootless Podman driven by docker-compose. NAS: Btrfs,
#    drive health (smartmontools), drive sleep (hdparm) and network shares (samba).
need=()
for pkg in nodejs npm git openssl wayvnc bubblewrap qemu-base libvirt passt libisoburn edk2-ovmf podman docker-compose btrfs-progs smartmontools hdparm samba; do pacman -Qi "$pkg" >/dev/null 2>&1 || need+=("$pkg"); done
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
# Small machines (and ones running many apps) can run out of memory installing packages. With
# under 1.5 GB free, borrow 2 GB of disk as temporary swap for the build; it's removed afterwards.
BUILD_SWAP=""
remove_build_swap() {
	if [ -n "$BUILD_SWAP" ]; then
		sudo swapoff "$BUILD_SWAP" 2>/dev/null || true
		sudo rm -f "$BUILD_SWAP" || true
		BUILD_SWAP=""
	fi
}
trap remove_build_swap EXIT
avail_mb=$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)
if [ "${avail_mb:-0}" -lt 1536 ]; then
	say "Only ${avail_mb} MB of memory free: adding temporary swap for the build (sudo needed)"
	swap=/var/tmp/omarchy-server-build.swap
	sudo rm -f "$swap"
	if [ "$(stat -f -c %T /var/tmp)" = btrfs ]; then
		made=$(sudo btrfs filesystem mkswapfile --size 2g "$swap" >/dev/null 2>&1 && echo yes || echo no)
	else
		made=$(sudo fallocate -l 2G "$swap" && sudo chmod 600 "$swap" && sudo mkswap "$swap" >/dev/null 2>&1 && echo yes || echo no)
	fi
	if [ "$made" = yes ] && sudo swapon "$swap"; then
		BUILD_SWAP="$swap"
	else
		sudo rm -f "$swap" || true
		say "Couldn't add swap; trying the build anyway"
	fi
fi
# Packages are reinstalled only when they changed (most updates change none).
if ! { node scripts/deps.mjs && NODE_OPTIONS=--max-old-space-size=1024 npm run build; } >"$LOG" 2>&1; then
	tail -n 30 "$LOG" >&2
	if grep -q "ran out of memory\|Killed\|heap out of memory" "$LOG"; then
		die "The build ran out of memory. Stop a few apps (or give this computer more memory), then run the installer again. Full log: $LOG"
	fi
	die "The build failed. Full log: $LOG"
fi
remove_build_swap

# 2a. ZFS (only with --zfs). Built from the AUR (zfs-utils + zfs-dkms, the current OpenZFS release)
#     for your exact kernel with DKMS. Every kernel update rebuilds it; on a kernel newer than
#     OpenZFS supports, that build fails and pools stay offline until OpenZFS catches up.
if [ "$ZFS" = 1 ]; then
	command -v yay >/dev/null 2>&1 || die "ZFS is built from the AUR and needs yay (Omarchy includes it). Install yay, then run this again with --zfs."

	# Undo an earlier attempt that used the stale archzfs.com repository (it serves an old ZFS).
	if grep -q '^\[archzfs\]' /etc/pacman.conf; then
		say "Removing the outdated archzfs.com repository from pacman.conf"
		sudo sed -i '/^\[archzfs\]$/,/^Server = .*archzfs.*$/d' /etc/pacman.conf
	fi

	# Bring the system up to date the way it expects: Omarchy refuses a direct `pacman -Syu`.
	if command -v omarchy >/dev/null 2>&1; then
		say "Updating the system with 'omarchy update' first (Omarchy's own way)"
		omarchy update || die "'omarchy update' didn't finish. Run it yourself, then run this installer again with --zfs."
	else
		sudo pacman -Syu --noconfirm || die "Updating the system failed (see above)"
	fi

	# Headers must be the same version as the kernel, or DKMS builds for a kernel you don't have.
	kernel=$(pacman -Qqo "/usr/lib/modules/$(uname -r)/vmlinuz" 2>/dev/null || true)
	[ -n "$kernel" ] || die "Your kernel was updated. Restart the computer, then run this installer again with --zfs."
	kver=$(pacman -Q "$kernel" | awk '{print $2}')
	sudo pacman -S --needed --noconfirm "${kernel}-headers" || die "Couldn't install ${kernel}-headers"
	hver=$(pacman -Q "${kernel}-headers" | awk '{print $2}')
	if [ "$kver" != "$hver" ]; then
		repo_kver=$(pacman -Si "$kernel" 2>/dev/null | awk -F': ' '/^Version/{print $2; exit}')
		if [ "$repo_kver" = "$hver" ]; then
			say "Your kernel ($kver) is older than its headers ($hver): installing kernel $hver to match"
			sudo pacman -S --noconfirm "$kernel" || die "Couldn't update $kernel"
			say "Kernel updated. Restart the computer, then run this installer again with --zfs."
			exit 0
		fi
		die "Kernel $kernel is $kver but its headers are $hver, and no matching pair is available yet. Try again after the next 'omarchy update'."
	fi

	say "Building ZFS from the AUR (zfs-utils, zfs-dkms). This takes several minutes."
	yay -S --needed --noconfirm --answerclean None --answerdiff None --pgpfetch zfs-utils zfs-dkms || die "Building ZFS failed (see above)"
	if ! sudo modprobe zfs 2>/dev/null; then
		dkms status zfs 2>/dev/null || true
		die "ZFS was built, but its module didn't load for kernel $(uname -r). Your kernel may be newer than OpenZFS supports yet; the lines above show what DKMS built."
	fi
	sudo systemctl enable zfs-import-cache.service zfs-mount.service zfs-import.target zfs.target >/dev/null 2>&1 || true
	say "ZFS $(zfs version 2>/dev/null | head -1) is ready"
fi

# 2b. Apps run in rootless Podman as you: give your user its container ID range and a socket.
if ! grep -q "^$USER:" /etc/subuid 2>/dev/null || ! grep -q "^$USER:" /etc/subgid 2>/dev/null; then
	say "Giving your user a container ID range (sudo needed)"
	sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"
	podman system migrate >/dev/null 2>&1 || true
fi
REG="${XDG_CONFIG_HOME:-$HOME/.config}/containers/registries.conf"
if [ ! -f "$REG" ]; then
	mkdir -p "$(dirname "$REG")"
	printf '# Short image names (e.g. nginx) come from Docker Hub, as app stores expect.\nunqualified-search-registries = ["docker.io"]\n' >"$REG"
fi
systemctl --user enable --now podman.socket >/dev/null

# 2c. The storage helper: the one part that runs as root, allowed by a single sudoers rule.
#     It's copied root-owned so nothing running as you can change it.
say "Installing the storage helper (sudo needed)"
sudo install -d -o root -g root -m 0755 /usr/local/libexec/omarchy-server
sudo install -o root -g root -m 0755 "$APP/helper/helper.mjs" /usr/local/libexec/omarchy-server/helper.mjs
rule="$USER ALL=(root) NOPASSWD: /usr/local/libexec/omarchy-server/helper.mjs"
tmp=$(mktemp)
printf '# Omarchy Server: lets %s run the storage helper (and nothing else) without a password.\n%s\n' "$USER" "$rule" >"$tmp"
if sudo visudo -cf "$tmp" >/dev/null; then
	sudo install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/omarchy-server
else
	say "Skipped the sudoers rule (it didn't validate); storage management will be unavailable."
fi
rm -f "$tmp"
mkdir -p "$HOME/Pools"

# 2d. Everyday controls: the `omarchy-server` command, launcher entries (Super + Space), and the first
#     time only, a status icon in the top bar (`omarchy-server widget off` removes it).
mkdir -p "$HOME/.local/bin" "${XDG_DATA_HOME:-$HOME/.local/share}/applications"
chmod +x "$APP/bin/omarchy-server"
ln -sf "$APP/bin/omarchy-server" "$HOME/.local/bin/omarchy-server"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
cat >"$APPS/omarchy-server.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Omarchy Server
Comment=Open the Omarchy Server web app
Exec=$HOME/.local/bin/omarchy-server open
Icon=network-server
Terminal=false
Categories=System;
EOF
cat >"$APPS/omarchy-server-restart.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Restart Omarchy Server
Comment=Restart the Omarchy Server services
Exec=$HOME/.local/bin/omarchy-server restart
Icon=view-refresh
Terminal=false
Categories=System;
EOF
if [ ! -e "$BASE/.widget-offered" ]; then
	"$HOME/.local/bin/omarchy-server" widget on || true
	touch "$BASE/.widget-offered"
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
ExecStart=$NODE $APP/omarchyd/cli.mjs serve --port 2021 --web-port $PORT --data $BASE/omarchyd
Restart=on-failure
RestartSec=3

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
# Your Omarchy desktop in the web app: wayvnc shares the running Hyprland session on 127.0.0.1 only
# (never on the network). The web app reaches it through omarchyd, behind your sign-in. It runs while
# you're signed in to Omarchy on this machine, and stops when you sign out.
cat >"$UNITS/omarchy-server-desktop.service" <<EOF
[Unit]
Description=Omarchy Server: share this Omarchy desktop with the web app (localhost only)
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStart=/usr/bin/wayvnc --max-fps=30 127.0.0.1 5900
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
EOF
systemctl --user daemon-reload
systemctl --user enable omarchyd.service omarchy-server-web.service omarchy-server-desktop.service >/dev/null
systemctl --user restart omarchyd.service omarchy-server-web.service
# Start sharing now if a desktop session is running (otherwise it starts at the next sign-in).
systemctl --user is-active --quiet graphical-session.target && systemctl --user restart omarchy-server-desktop.service >/dev/null 2>&1 || true

# Omarchy turns on a firewall (ufw) that blocks incoming connections: let the web app through.
# Rules are added even while ufw is off, so they apply as soon as it's turned on.
if command -v ufw >/dev/null 2>&1; then
	say "Allowing Omarchy Server through the firewall (sudo needed)"
	sudo ufw allow "$PORT/tcp" comment 'Omarchy Server' >/dev/null

	# Machine port forwards live in 40000-49999. Nothing listens there until you add a forward to a
	# machine, so this only lets forwards you create be reached from your network.
	sudo ufw allow 40000:49999/tcp comment 'Omarchy Server machine forwards' >/dev/null
	sudo ufw allow 40000:49999/udp comment 'Omarchy Server machine forwards' >/dev/null

	# App windows that can't load straight from the app (rare) go through a relay on 7800-7899.
	sudo ufw allow 7800:7899/tcp comment 'Omarchy Server app windows' >/dev/null
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
		printf '\n    Note: this machine only has a private address (a VM behind NAT), so other devices reach it\n'
		printf '    through a port forward on the VM host to port %s. If you already set one up, it still\n' "$PORT"
		printf '    works after updates and restarts: keep using http://<host-ip>:<forwarded port>.\n\n'
	fi
	printf '    Logs: journalctl --user -u omarchyd -u omarchy-server-web -f\n'
else
	die "A service didn't start. See: journalctl --user -u omarchyd -u omarchy-server-web -n 50"
fi
