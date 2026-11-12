#!/usr/bin/env bash
# Runs inside the newly installed system (archinstall custom command, in its chroot). Leaves a
# one-time first-boot step: the owner is logged in on the first console, which installs Omarchy
# Server, then Omarchy. Nothing here stores or handles passwords.
set -eu

owner=$(awk -F: '$3 >= 1000 && $3 < 60000 { print $1; exit }' /etc/passwd)
if [ -z "$owner" ]; then
	echo "omarchy-server: no user account was created, so first-boot setup is skipped" >&2
	exit 0
fi

install -d -m 0755 /var/lib/omarchy-server /etc/profile.d /usr/local/bin
echo "$owner" >/var/lib/omarchy-server/firstboot

# Log the owner in on the first console, only until setup finishes.
install -d /etc/systemd/system/getty@tty1.service.d
cat >/etc/systemd/system/getty@tty1.service.d/omarchy-server-firstboot.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty -o '-p -f -- \\\\u' --noclear --autologin $owner %I \$TERM
EOF

cat >/etc/profile.d/zz-omarchy-server-firstboot.sh <<'EOF'
# Omarchy Server first-boot setup (removes itself when done).
if [ "$(tty)" = /dev/tty1 ] && [ -f /var/lib/omarchy-server/firstboot ] && [ "$(cat /var/lib/omarchy-server/firstboot)" = "$USER" ]; then
	/usr/local/bin/omarchy-server-firstboot
fi
EOF

cat >/usr/local/bin/omarchy-server-firstboot <<'EOF'
#!/usr/bin/env bash
# First start of a new Omarchy Server: install Omarchy Server, then Omarchy.
set -u
b='\033[1m'; r='\033[0m'; o='\033[38;5;208m'
SERVER_INSTALL="${OMARCHY_SERVER_INSTALL_URL:-https://raw.githubusercontent.com/TouchWorkStation/omarchy-server/main/install.sh}"
OMARCHY_INSTALL="${OMARCHY_INSTALL_URL:-https://omarchy.org/install}"

finish_firstboot() {
	sudo rm -f /etc/systemd/system/getty@tty1.service.d/omarchy-server-firstboot.conf /etc/profile.d/zz-omarchy-server-firstboot.sh /var/lib/omarchy-server/firstboot
	sudo systemctl daemon-reload
}

clear
printf "\n  ${o}${b}Omarchy Server${r} first-time setup\n\n"
printf "  You'll be asked for your password (for sudo), then to create your Omarchy Server account.\n\n"
printf "  Waiting for the network…"
nm-online -t 120 >/dev/null 2>&1 || true
printf " ok\n\n"

# Firewall rules first, so they're in place when Omarchy turns the firewall on later.
sudo pacman -S --needed --noconfirm ufw curl git >/dev/null
sudo ufw allow 7780/tcp comment 'Omarchy Server' >/dev/null
sudo ufw allow 40000:49999/tcp comment 'Omarchy Server machine forwards' >/dev/null
sudo ufw allow 40000:49999/udp comment 'Omarchy Server machine forwards' >/dev/null

if ! curl -fsSL "$SERVER_INSTALL" | bash; then
	printf "\n  ${b}Omarchy Server didn't finish installing.${r} Fix the problem above, then run:\n"
	printf "    curl -fsSL %s | bash\n\n" "$SERVER_INSTALL"
	read -rp "  Press Enter for a command line " _
	exec bash -l
fi
finish_firstboot

printf "\n  ${o}${b}Omarchy Server is running.${r} Next: Omarchy, the desktop.\n\n"
if curl -fsSL "$OMARCHY_INSTALL" | bash; then
	exit 0
fi
printf "\n  ${b}Omarchy didn't install.${r} Omarchy Server still works in your browser.\n"
printf "  Install Omarchy later with:  curl -fsSL %s | bash\n\n" "$OMARCHY_INSTALL"
read -rp "  Press Enter for a command line " _
exec bash -l
EOF
chmod 0755 /usr/local/bin/omarchy-server-firstboot
