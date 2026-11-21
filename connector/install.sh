#!/usr/bin/env bash
# Omarchy Server connector: join this Linux computer to your Omarchy Server's local swarm.
#
# Get the exact command (with a one-time pairing code) from your server: Machines → Local swarm →
# Add a computer. It looks like:
#   curl -fsSL <source>/main/connector/install.sh | bash -s -- --server https://<server>:7780 --ca <fingerprint> --token <code> --allow terminal,desktop,manage,backup
#
# Run it as your normal user (it asks for sudo only to install packages and to keep the connector
# running while you're signed out). Works on any Linux with systemd: Debian, Ubuntu, Fedora, Arch,
# Omarchy, openSUSE and their relatives.
#
# Remove it again:  curl -fsSL <source>/main/connector/install.sh | bash -s -- --uninstall
set -euo pipefail

usage() {
	cat <<'EOF'
Omarchy Server connector installer

  connector/install.sh --server <https://...> --ca <fingerprint> --token <code> [--allow <list>] [--source <url>]
  connector/install.sh --uninstall
  connector/install.sh -h|--help

Options:
  --server <url>        Server URL (https://...)
  --ca <fingerprint>    64-char hex SHA-256 fingerprint of the server CA
  --token <code>        One-time pairing token from Machines -> Local swarm
  --allow <abilities>   Comma-separated abilities (terminal,desktop,manage,storage,backup,files)
  --source <url>        Base URL to download connector files from
  --uninstall           Remove the connector from this computer
  -h, --help            Show this help
EOF
}

need_value() {
	if [ "$2" -lt 2 ]; then
		printf 'Missing value for %s\n\n' "$1" >&2
		usage >&2
		exit 2
	fi
}

SOURCE="https://raw.githubusercontent.com/TouchWorkStation/omarchy-server"
SERVER="" CA="" TOKEN="" ALLOW="" UNINSTALL=0
while [ $# -gt 0 ]; do
	case "$1" in
		--server) need_value "$1" "$#"; SERVER="$2"; shift 2 ;;
		--server=*) SERVER="${1#--server=}"; shift ;;
		--ca) need_value "$1" "$#"; CA="$2"; shift 2 ;;
		--ca=*) CA="${1#--ca=}"; shift ;;
		--token) need_value "$1" "$#"; TOKEN="$2"; shift 2 ;;
		--token=*) TOKEN="${1#--token=}"; shift ;;
		--allow) need_value "$1" "$#"; ALLOW="$2"; shift 2 ;;
		--allow=*) ALLOW="${1#--allow=}"; shift ;;
		--source) need_value "$1" "$#"; SOURCE="$2"; shift 2 ;;
		--source=*) SOURCE="${1#--source=}"; shift ;;
		--uninstall) UNINSTALL=1; shift ;;
		-h | --help) usage; exit 0 ;;
		*) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
	esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
# Syntax only. Parsing does not write bytecode beside the download.
python_ok() {
	python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$1"
}

DIR="${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-connector"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy-connector"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/omarchy-connector.service"

[ "$(uname -s)" = Linux ] || die "The connector is for Linux."
[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not with sudo (the connector works as you)."
command -v systemctl >/dev/null || die "systemd is required."

if [ "$UNINSTALL" = 1 ]; then
	say "Removing the Omarchy Server connector"
	systemctl --user disable --now omarchy-connector.service 2>/dev/null || true
	rm -f "$UNIT"
	systemctl --user daemon-reload 2>/dev/null || true
	rm -rf "$DIR" "$CONF" "${XDG_CACHE_HOME:-$HOME/.cache}/omarchy-connector"
	if ! sudo rm -f /usr/local/libexec/omarchy-connector/helper.py /etc/sudoers.d/omarchy-connector /etc/udev/rules.d/69-omarchy-connector-sleep.rules; then
		warn "The helper, its sudoers rule and the sleep udev rule could not be removed. Run this yourself:"
		printf '  sudo rm -f /usr/local/libexec/omarchy-connector/helper.py /etc/sudoers.d/omarchy-connector /etc/udev/rules.d/69-omarchy-connector-sleep.rules\n' >&2
		printf '  sudo udevadm control --reload\n' >&2
		exit 1
	fi
	sudo udevadm control --reload >/dev/null 2>&1 || true
	say "Done. Remove this computer in Machines → Local swarm too, if it's still listed."
	exit 0
fi

[ -n "$SERVER" ] && [ -n "$CA" ] && [ -n "$TOKEN" ] || die "Use the command from your server: Machines → Local swarm → Add a computer."
case "$SERVER" in https://*) ;; *) die "The server address must start with https://" ;; esac
[[ "$CA" =~ ^[0-9a-f]{64}$ ]] || die "That command looks cut off (the server fingerprint is missing). Copy it again."
[[ "$ALLOW" =~ ^[a-z,]*$ ]] || die "Bad --allow list"
has() { [[ ",$ALLOW," == *",$1,"* ]]; }

# 1. What this computer needs: Python 3, git (for plugins) and screen sharing (for the desktop).
pm=""
for p in apt-get dnf pacman zypper; do command -v "$p" >/dev/null && { pm="$p"; break; }; done
pkgs=()
command -v python3 >/dev/null || case "$pm" in pacman) pkgs+=(python) ;; *) pkgs+=(python3) ;; esac
has manage && ! command -v git >/dev/null && pkgs+=(git)
if has desktop; then
	command -v x11vnc >/dev/null || pkgs+=(x11vnc)
	command -v wayvnc >/dev/null || pkgs+=(wayvnc)
fi
# Disk tools live in /usr/sbin on Debian, which isn't on a normal user's PATH; the helper looks there too.
sbin() { PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin" command -v "$1" >/dev/null; }
if has storage; then
	sbin smartctl || pkgs+=(smartmontools)
	sbin mkfs.ext4 || pkgs+=(e2fsprogs)
	sbin mkfs.exfat || pkgs+=(exfatprogs)
	sbin mkfs.btrfs || pkgs+=(btrfs-progs)
	sbin hdparm || pkgs+=(hdparm)
fi
if [ ${#pkgs[@]} -gt 0 ]; then
	say "Installing ${pkgs[*]} (sudo needed)"
	# One package at a time, so one that a distribution doesn't carry doesn't stop the rest.
	for p in "${pkgs[@]}"; do
		case "$pm" in
			apt-get) sudo apt-get install -y "$p" >/dev/null || warn "Couldn't install $p" ;;
			dnf) sudo dnf install -y "$p" >/dev/null || warn "Couldn't install $p" ;;
			pacman) if command -v omarchy >/dev/null; then omarchy pkg add "$p" || warn "Couldn't install $p"; else sudo pacman -S --needed --noconfirm "$p" >/dev/null || warn "Couldn't install $p"; fi ;;
			zypper) sudo zypper --non-interactive install "$p" >/dev/null || warn "Couldn't install $p" ;;
			*) warn "Install $p yourself (no package manager found that I know)" ;;
		esac
	done
fi
command -v python3 >/dev/null || die "Python 3 is needed. Install it, then run this again."

# 2. Trust only your server: fetch its certificate authority and check it against the fingerprint
#    in the command (which came from the server itself, over your own signed-in session).
mkdir -p "$DIR" "$CONF"
chmod 700 "$CONF"
say "Checking your server ($SERVER)"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSk --max-time 20 "${SERVER%/}/api/tls/ca.crt" -o "$tmp" || die "Couldn't reach $SERVER. Is this computer on the same network (or tailnet) as the server?"
got=$(python3 -c 'import ssl,sys,hashlib; print(hashlib.sha256(ssl.PEM_cert_to_DER_cert(open(sys.argv[1]).read())).hexdigest())' "$tmp") || die "The server didn't send a certificate."
[ "$got" = "$CA" ] || die "That isn't your server (its certificate doesn't match the fingerprint in the command). Nothing was installed."
install -m 600 "$tmp" "$CONF/server-ca.crt"

# 3. The connector itself.
say "Downloading the connector"
curl -fsSL --max-time 60 "${SOURCE%/}/main/connector/agent.py" -o "$DIR/agent.py.new" || die "Couldn't download the connector."
python_ok "$DIR/agent.py.new" || die "The downloaded connector didn't check out."
mv "$DIR/agent.py.new" "$DIR/agent.py"
chmod 700 "$DIR/agent.py"

if has storage; then
	say "Installing the storage helper"
	curl -fsSL --max-time 60 "${SOURCE%/}/main/connector/helper.py" -o "$tmp.helper.py" || die "Couldn't download the storage helper."
	python_ok "$tmp.helper.py" || die "The downloaded storage helper didn't check out."
	sudo install -D -m 755 "$tmp.helper.py" /usr/local/libexec/omarchy-connector/helper.py
	rm -f "$tmp.helper.py"
	printf '%s ALL=(root) NOPASSWD: /usr/local/libexec/omarchy-connector/helper.py\n' "$USER" | sudo tee /etc/sudoers.d/omarchy-connector >/dev/null
	sudo chmod 440 /etc/sudoers.d/omarchy-connector
fi

# 4. Join, with this one-time code.
say "Joining your server"
name=$(python3 "$DIR/agent.py" enroll "$SERVER" "$TOKEN" "$ALLOW") || die "Joining didn't work (see above)."

# 5. Keep it running, as you, from now on.
# Storage needs sudo to the helper, so NoNewPrivileges stays off only when Storage was allowed.
nnp=""
has storage || nnp="NoNewPrivileges=yes"
mkdir -p "$UNIT_DIR"
cat >"$UNIT" <<EOF
[Unit]
Description=Omarchy Server connector (local swarm)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env python3 $DIR/agent.py
Restart=always
RestartSec=5
$nnp

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now omarchy-connector.service
systemctl --user restart omarchy-connector.service
# Run even while nobody is signed in (so you can still watch it and open a terminal).
if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
	sudo loginctl enable-linger "$USER" 2>/dev/null || warn "It only runs while you're signed in. To keep it running, run: sudo loginctl enable-linger $USER"
fi

say "Done. \"$name\" is now in your server's Machines → Local swarm."
