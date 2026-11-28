#!/usr/bin/env bash
# Puts the MODC Connect development build on this server for testing, then prints a report to paste
# back. Run it as the user My Own Data Center runs as (not root), in a terminal on the server:
#
#   curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/dev/modc-connect-v3/scripts/modc-connect-test.sh | bash
#
# What it does:
#   1. Holds automatic updates, so the stable release doesn't replace the test build.
#   2. Installs the dev/modc-connect-v3 build with the normal installer (it asks for your sudo password).
#   3. Lets the connector start again if it was switched off by hand. Whether it actually runs is still
#      decided by the website's state and this server's own check of its address.
#   4. Waits a minute, then prints the read-only Connect report (no credentials or tokens in it).
#
# To go back to the stable release: rm ~/.local/share/omarchy-server/omarchyd/update-hold
# and run the normal install command again.
set -euo pipefail
BRANCH=dev/modc-connect-v3
RAW=https://raw.githubusercontent.com/MyOwnDataCenter/server/$BRANCH
BASE=${OMARCHY_SERVER_BASE:-$HOME/.local/share/omarchy-server}
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -ne 0 ] || { echo "Run this as your normal user, not root (it uses sudo itself when needed)."; exit 1; }
[ -d "$BASE" ] || { echo "My Own Data Center isn't installed here ($BASE is missing)."; exit 1; }

say "1/4 Holding automatic updates while the test build is on"
mkdir -p "$BASE/omarchyd"
touch "$BASE/omarchyd/update-hold"

say "2/4 Installing the test build ($BRANCH)"
curl -fsSL "$RAW/install.sh" | OMARCHY_SERVER_BRANCH=$BRANCH bash

say "3/4 Letting the connector start again"
if systemctl --user cat modc-cloudflared.service >/dev/null 2>&1; then
	systemctl --user enable modc-cloudflared.service >/dev/null 2>&1 || true
	echo "connector unit: enabled (omarchyd still decides whether it runs)"
else
	echo "no connector unit yet: it's created when the connector is turned on (pairing does that now)"
fi

say "4/4 Waiting a minute for it to check in, then the report"
sleep 60
echo
echo "----- copy everything below this line -----"
bash "$BASE/app/scripts/modc-diagnose.sh" 2>&1 || true
echo
echo "connector log (last 20 lines):"
journalctl --user -u omarchyd.service --since "-10 min" --no-pager 2>/dev/null | grep '\[connect\]' | tail -20 | sed -E 's/[A-Za-z0-9+\/=_-]{40,}/[redacted]/g' || true
echo "----- copy everything above this line -----"
