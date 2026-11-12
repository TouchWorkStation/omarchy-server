#!/usr/bin/env bash
# UmbrelOS Touch installer. Run it ON your Umbrel (Settings > Advanced settings >
# Terminal, or SSH), or on any Linux machine with Docker on the same network:
#
#   curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/Umbrelos/main/install.sh | sudo bash
#
# It builds a small Docker image and runs one container named "umbrel-touch".
# Nothing in umbrelOS is modified. Re-run it any time to update.
#
#   Options (environment variables):
#     TOUCH_PORT=7780           port to open in your phone's browser
#     UMBREL_URL=192.168.1.50   your Umbrel's address (only when NOT installing on the Umbrel)
#     TOUCH_APP_HOSTS='{app}-touch.example.com'
#                               app addresses for remote access (Cloudflare tunnel etc.); saved,
#                               so later re-runs keep it. TOUCH_APP_HOSTS=off removes it.
#   Remove it again:
#     curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/Umbrelos/main/install.sh | sudo bash -s -- uninstall
set -euo pipefail

REPO="TouchWorkStation/Umbrelos"
BRANCH="${TOUCH_BRANCH:-main}"
NAME="umbrel-touch"
PORT="${TOUCH_PORT:-7780}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker isn't installed here. Run this on your Umbrel, or install Docker first."
docker info >/dev/null 2>&1 || die "Can't talk to Docker. Run this with sudo."

if [ "${1:-}" = "uninstall" ]; then
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	docker volume rm "$NAME-data" >/dev/null 2>&1 || true
	docker image rm "$NAME:latest" >/dev/null 2>&1 || true
	say "UmbrelOS Touch has been removed."
	exit 0
fi

# Is umbrelOS answering on this machine? Then talk to it over loopback.
URL="${UMBREL_URL:-}"
if [ -z "$URL" ] && curl -fsS --max-time 5 http://127.0.0.1/trpc/system.version 2>/dev/null | grep -q '"version"'; then
	URL="http://127.0.0.1"
	say "Found umbrelOS on this machine."
fi

# A port clash only matters if something other than a previous install holds it.
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME" && (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
	die "Port $PORT is already in use here. Re-run with another port:  ... | sudo TOUCH_PORT=7790 bash"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "Downloading UmbrelOS Touch…"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$TMP" --strip-components=1

say "Building (takes 1–3 minutes the first time)…"
docker build --quiet -t "$NAME:latest" "$TMP" >/dev/null

docker rm -f "$NAME" >/dev/null 2>&1 || true
# Host networking lets the container reach umbrelOS on 127.0.0.1 and serve the LAN directly.
docker run -d --name "$NAME" --restart unless-stopped --network host \
	-e PORT="$PORT" ${URL:+-e UMBREL_URL="$URL"} ${TOUCH_APP_HOSTS:+-e TOUCH_APP_HOSTS="$TOUCH_APP_HOSTS"} \
	-v "$NAME-data:/data" "$NAME:latest" >/dev/null

for _ in $(seq 1 20); do
	curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && ok=1 && break
	sleep 1
done
[ "${ok:-}" = 1 ] || { docker logs --tail 20 "$NAME" || true; die "UmbrelOS Touch didn't start. The log above says why."; }

IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
[ -n "$IP" ] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "UmbrelOS Touch is running."
echo "  Open on your phone:  http://${IP:-THIS-MACHINES-IP}:$PORT"
[ -n "$URL" ] || echo "  It will ask for your Umbrel's address on first launch."
echo "  Then: Share > Add to Home Screen."
