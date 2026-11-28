#!/usr/bin/env bash
# MODC Connect diagnosis. Read-only: it changes nothing on this machine, in Cloudflare or on the
# website. It never prints the device credential or the tunnel token: they are read from their
# files by python and handed to curl on stdin (never as an argument), and anything long and
# token-shaped in a log is replaced by [redacted].
#
#   bash modc-diagnose.sh            (run as the user My Own Data Center runs as, not root)
set -u
BASE=${OMARCHY_SERVER_BASE:-$HOME/.local/share/omarchy-server}
APP=$BASE/app
C=$BASE/omarchyd/connect
API=https://myowndatacenter.com/api/public/cloud
UNIT=modc-cloudflared.service
TMP=$(mktemp -d) && chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
h() { printf '\n== %s\n' "$1"; }
redact() { sed -E 's/[A-Za-z0-9+\/=_-]{40,}/[redacted]/g'; }

h "1. Code installed on this server"
git -C "$APP" log --oneline -1 2>/dev/null || echo "no git checkout at $APP"
grep -o "OMARCHYD_VERSION = '[^']*'" "$APP/omarchyd/server.mjs" 2>/dev/null
for f in connect.mjs connect-tunnel.mjs; do
	if [ -f "$APP/omarchyd/$f" ]; then echo "omarchyd/$f: present"; else echo "omarchyd/$f: MISSING"; fi
done
systemctl --user is-active omarchyd.service omarchy-server-web.service 2>/dev/null | paste -sd' ' | sed 's/^/services (omarchyd, web): /'

h "2. Pairing (no secrets printed)"
python3 - "$C/connect.json" <<'PY'
import json, os, sys, time
p = sys.argv[1]
try:
    st = os.stat(p)
except FileNotFoundError:
    print("connect.json: MISSING (this install was never paired)"); sys.exit()
print("connect.json mode:", oct(st.st_mode & 0o777), "| folder mode:", oct(os.stat(os.path.dirname(p)).st_mode & 0o777))
s = json.load(open(p)); d = s.get("device") or {}
t = lambda v: time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(v / 1000)) if v else "never"
print("device name:      ", d.get("name"))
print("device id:        ", d.get("deviceId"))
print("data center id:   ", d.get("dataCenterId"))
print("credential stored:", "yes (64 hex)" if len(d.get("credential") or "") == 64 else "NO")
print("revoked here:     ", t(d.get("revokedAt")) if d.get("revokedAt") else "no")
print("paired at:        ", t(d.get("pairedAt")))
print("last check-in:    ", t(d.get("lastCheckIn")))
print("pairing pending:  ", bool(s.get("pairing")), "| notice:", (s.get("notice") or {}).get("kind"))
PY

# The credential goes to curl as a header on stdin. Exit 1 when there isn't one.
cred() { python3 -c 'import json,sys
d=json.load(open(sys.argv[1])).get("device") or {}
c=d.get("credential") or ""
sys.exit(1) if len(c)!=64 else print("Authorization: Bearer "+c)' "$C/connect.json" 2>/dev/null; }
call() { # METHOD PATH [json body] -> prints HTTP code; body in $TMP/body
	local m=$1 p=$2 b=${3-}
	rm -f "$TMP/body"
	if [ -n "$b" ]; then cred | curl -sS -m 25 -o "$TMP/body" -w '%{http_code}' -X "$m" -H @- -H 'Content-Type: application/json' --data "$b" "$API$p"
	else cred | curl -sS -m 25 -o "$TMP/body" -w '%{http_code}' -X "$m" -H @- "$API$p"; fi
}

h "3. Production endpoints with this device's credential"
if ! cred >/dev/null; then
	echo "No device credential on this machine: pair it in Settings › MODC Connect first."
else
	code=$(call POST /heartbeat '{}'); echo "heartbeat:     HTTP $code $(head -c 200 "$TMP/body" 2>/dev/null)"
	code=$(call GET /tunnel/status); echo "tunnel status: HTTP $code"
	python3 -m json.tool "$TMP/body" 2>/dev/null || head -c 300 "$TMP/body" 2>/dev/null; echo
	code=$(call POST /tunnel/token '{}'); echo "tunnel token:  HTTP $code"
	python3 - "$TMP/body" "$C/tunnel.token" <<'PY'
import hashlib, json, sys
try:
    b = json.load(open(sys.argv[1]))
except Exception:
    print("  (not JSON)"); sys.exit()
tok = b.pop("tunnel_token", None)
print(" ", json.dumps(b))
if tok:
    print("  token received: yes, length", len(tok))
    try:
        same = hashlib.sha256(open(sys.argv[2], "rb").read()).digest() == hashlib.sha256(tok.encode()).digest()
        print("  same as the stored token file:", "yes" if same else "NO (stored one is stale)")
    except FileNotFoundError:
        print("  stored token file: MISSING")
PY
fi

h "4. Tunnel state on this machine (tunnel.json)"
python3 - "$C/tunnel.json" <<'PY'
import json, sys, time
try:
    s = json.load(open(sys.argv[1]))
except FileNotFoundError:
    print("tunnel.json: MISSING (the connector was never turned on or checked)"); sys.exit()
t = lambda v: time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(v / 1000)) if v else "never"
snap = s.get("snapshot") or {}
print("connector switch on:", s.get("enabled"))
print("blocked:            ", s.get("block"))
print("token issued at:    ", t(s.get("tokenIssuedAt")))
print("last healthy:       ", t(s.get("lastHealthyAt")))
print("website said:       ", {k: snap.get(k) for k in ("provisioning", "hostname", "health", "connections", "connectorError", "remoteAccess", "ingress")})
PY
if [ -f "$C/tunnel.token" ]; then stat -c 'token file: mode %a, owner %U, %s bytes' "$C/tunnel.token"; else echo "token file: MISSING"; fi

h "5. cloudflared"
for b in "$C/bin/cloudflared" /usr/bin/cloudflared /usr/local/bin/cloudflared; do
	[ -x "$b" ] && echo "$b: $("$b" --version 2>&1 | head -1)"
done
command -v cloudflared >/dev/null || echo "cloudflared: not on PATH"

h "6. The MODC service ($UNIT)"
systemctl --user show "$UNIT" -p LoadState -p UnitFileState -p ActiveState -p SubState -p NRestarts -p ExecMainStatus -p FragmentPath 2>&1
systemctl --user cat "$UNIT" 2>/dev/null | grep -E '^(ExecStart|Restart|WantedBy)=' | redact
loginctl show-user "$USER" -p Linger 2>/dev/null | sed 's/^/starts at boot without login: /'
echo "other cloudflared services (left alone):"
{ systemctl list-units --all --no-legend --plain 'cloudflared*' 2>/dev/null; systemctl --user list-units --all --no-legend --plain 'cloudflared*' 2>/dev/null; } | awk '{print "  " $1, $3, $4}'

h "7. Connector log (last 60 lines, redacted)"
journalctl --user -u "$UNIT" -n 60 --no-pager -o short-iso 2>&1 | redact | cut -c1-220

h "8. MODC Connect lines from omarchyd (redacted)"
journalctl --user -u omarchyd.service -n 3000 --no-pager -o short-iso 2>/dev/null | grep -F '[connect]' | tail -25 | redact | cut -c1-220

h "9. Dashboard origin"
ss -ltn 2>/dev/null | awk 'NR==1 || /:7780 /'
echo "http://127.0.0.1:7780  -> HTTP $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:7780/api/tls/status)"
echo "https://127.0.0.1:7780 -> HTTP $(curl -sk -m 5 -o /dev/null -w '%{http_code}' https://127.0.0.1:7780/api/tls/status)"
echo "http://localhost:7780  -> HTTP $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:7780/api/tls/status)"
echo
echo "Done. Nothing was changed."
