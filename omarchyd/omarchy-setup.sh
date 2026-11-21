#!/bin/sh
# Turn an Arch base image into Omarchy's package set. The full omarchy package is a
# desktop (Hyprland, a display manager, a bootloader), so a solver container does not
# install it. It uses Omarchy's mirror, keyring, and os-release instead.
set -eu

printf '%s\n' 'Server = https://stable-mirror.omarchy.org/$repo/os/$arch' > /etc/pacman.d/mirrorlist

pacman-key --init
pacman-key --populate archlinux

db=/tmp/omarchy.db
curl -fsSL -o "$db" https://pkgs.omarchy.org/stable/x86_64/omarchy.db
desc=$(tar -tf "$db" | grep '^omarchy-keyring-.*/desc$')
file=$(tar -xOf "$db" "$desc" | awk 'found { print; exit } $0 == "%FILENAME%" { found = 1 }')
curl -fsSL -o /tmp/omarchy-keyring.pkg "https://pkgs.omarchy.org/stable/x86_64/${file}"
pacman -U --noconfirm /tmp/omarchy-keyring.pkg
pacman-key --populate omarchy
rm -f "$db" /tmp/omarchy-keyring.pkg

cat > /etc/pacman.conf <<'EOF'
[options]
HoldPkg = pacman glibc
Architecture = auto
CheckSpace
ParallelDownloads = 5
SigLevel = Required DatabaseOptional
LocalFileSigLevel = Optional

[omarchy]
Server = https://pkgs.omarchy.org/stable/$arch
[core]
Include = /etc/pacman.d/mirrorlist
[extra]
Include = /etc/pacman.d/mirrorlist
EOF

pacman -Syu --noconfirm
pacman -S --noconfirm --needed python gcc gcc-libs git ca-certificates curl tar

mkdir -p /tmp/omarchy-settings
pacman -Sw --noconfirm --cachedir /tmp/omarchy-settings omarchy-settings
tar -xOf /tmp/omarchy-settings/omarchy-settings-*.pkg.tar.zst usr/share/omarchy/etc-overrides/os-release > /etc/os-release
rm -rf /tmp/omarchy-settings /var/cache/pacman/pkg/*
grep -q '^ID=omarchy$' /etc/os-release
