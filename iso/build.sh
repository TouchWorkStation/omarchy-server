#!/usr/bin/env bash
# Build the Omarchy Server installer ISO from Arch's own "releng" profile (the official Arch ISO),
# adding one setup command that starts on the first console. Needs Arch Linux with archiso, as root
# (GitHub Actions runs this in an archlinux container). Output: $OUT/omarchy-server.iso (+ .sha256).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=${WORK:-/tmp/omarchy-server-iso}
out=${OUT:-$here/../release}
[ -d /usr/share/archiso/configs/releng ] || { echo "Install archiso first (pacman -S archiso)" >&2; exit 1; }

rm -rf "$work"
mkdir -p "$work" "$out"
P="$work/profile"
cp -r /usr/share/archiso/configs/releng "$P"

sed -i \
	-e 's/^iso_name=.*/iso_name="omarchy-server"/' \
	-e 's/^iso_label=.*/iso_label="OMARCHY_SERVER_$(date --date="@${SOURCE_DATE_EPOCH:-$(date +%s)}" +%Y%m)"/' \
	-e 's|^iso_publisher=.*|iso_publisher="TouchWorkStation <https://github.com/TouchWorkStation/omarchy-server>"|' \
	-e 's/^iso_application=.*/iso_application="Omarchy Server installer"/' \
	"$P/profiledef.sh"
echo 'file_permissions["/usr/local/bin/omarchy-server-setup"]="0:0:755"' >>"$P/profiledef.sh"

install -Dm755 "$here/live/omarchy-server-setup" "$P/airootfs/usr/local/bin/omarchy-server-setup"
install -d "$P/airootfs/etc/omarchy-server"
b64=$(base64 -w0 "$here/target/target-setup.sh")
sed "s|@TARGET_SETUP_B64@|$b64|g" "$here/live/archinstall.json" >"$P/airootfs/etc/omarchy-server/archinstall.json"

# The live system logs root in on tty1 (zsh); start setup there, once.
cat >>"$P/airootfs/root/.zlogin" <<'EOF'

# Omarchy Server
if [[ $(tty) == /dev/tty1 && ! -e /tmp/omarchy-server-setup-started ]]; then
	touch /tmp/omarchy-server-setup-started
	/usr/local/bin/omarchy-server-setup
fi
EOF

mkarchiso -v -r -w "$work/build" -o "$work/out" "$P"
iso=$(ls "$work"/out/*.iso | head -1)
mv "$iso" "$out/omarchy-server.iso"
(cd "$out" && sha256sum omarchy-server.iso >omarchy-server.iso.sha256)
ls -lh "$out"
