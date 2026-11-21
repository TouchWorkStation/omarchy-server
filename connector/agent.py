#!/usr/bin/env python3
"""Omarchy Server connector: joins this Linux computer to an Omarchy Server's local swarm.

It dials out to the server (wss://, trusting only that server's own certificate authority), so this
computer opens no ports. It runs as you (a systemd user service), never as root.

What it does, each only if allowed when it was installed (see ABILITIES in its config, which the
server can't widen):
  watch     always: CPU, memory, disks, GPU, battery, temperature, uptime, updates waiting
  terminal  a shell, as you
  desktop   your screen (wayvnc on Hyprland/Sway and other wlroots desktops, x11vnc on X11),
            shared only through a private socket in your runtime folder
  manage    a short fixed list: Omarchy plugins (verified, pinned), Omarchy theme, restart
  storage   extra disks: list, mount, unmount, format, pools, sleep (helper)
  backup    back up the folders in your home folder that you choose on the server, on its schedule,
            encrypted (restic), to the server. It can only add backups there, never delete them.
            Restores go into a new ~/Restored folder, never over your files.

Standard library only, so it runs on any distribution with Python 3.8+.
"""
import base64
import bz2
import http.client
import http.server
import fcntl
import hashlib
import json
import os
import pty
import pwd
import re
import select
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1"
CONFIG_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "omarchy-connector")
CONFIG = os.path.join(CONFIG_DIR, "config.json")
CA_FILE = os.path.join(CONFIG_DIR, "server-ca.crt")
RUNTIME = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
DATA_DIR = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "omarchy-connector")

# restic, the backup engine: this computer's own if it's new enough, otherwise its official build,
# downloaded once and checked against these SHA-256s (from restic's SHA256SUMS for 0.18.1).
RESTIC_VERSION = "0.18.1"
RESTIC_SHA256 = {
    "amd64": "680838f19d67151adba227e1570cdd8af12c19cf1735783ed1ba928bc41f363d",
    "arm64": "87f53fddde38764095e9c058a3b31834052c37e5826d2acf34e18923c006bd45",
}
VNC_SOCK = os.path.join(RUNTIME, "omarchy-connector", "vnc.sock")


def log(*a):
    print("[connector]", *a, file=sys.stderr, flush=True)


# HTTP 401 on the handshake only. Not a PermissionError: a local EACCES is that class too, and must retry.
class Rejected(Exception):
    pass


def raise_for_handshake(status):
    if " 101 " not in status + " ":
        raise Rejected(status) if " 401" in status else ConnectionError(status)


def reconnect_action(exc):
    return "forget" if isinstance(exc, Rejected) else "retry"


# ---------------------------------------------------------------------------------------------
# A small WebSocket client (RFC 6455), enough for this: text and binary frames, ping/pong, close.
class WS:
    def __init__(self, url, headers, cafile):
        u = urllib.parse.urlsplit(url)
        if u.scheme != "wss":
            raise ValueError("The server address must start with https://")
        host, port = u.hostname, u.port or 443
        ctx = ssl.create_default_context(cafile=cafile)
        # Trust only this server's own certificate authority (pinned when installing). Its
        # certificate names the server's addresses, which can change, so the name isn't checked:
        # the private authority is what proves it's your server.
        ctx.check_hostname = False
        raw = socket.create_connection((host, port), timeout=20)
        self.sock = ctx.wrap_socket(raw, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        req = [f"GET {path} HTTP/1.1", f"Host: {u.netloc}", "Upgrade: websocket", "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        req += [f"{k}: {v}" for k, v in headers.items()]
        self.sock.sendall(("\r\n".join(req) + "\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("The server closed the connection")
            resp += chunk
        head, self.buf = resp.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        raise_for_handshake(status)
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        if accept.encode() not in head:
            raise ConnectionError("Bad handshake")
        self.sock.settimeout(None)
        self.lock = threading.Lock()

    def _send(self, opcode, data):
        n = len(data)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(data)) if n < 4096 else _xor(data, mask)
        with self.lock:
            self.sock.sendall(head + mask + body)

    def send_text(self, s):
        self._send(0x1, s.encode())

    def send_binary(self, b):
        self._send(0x2, b)

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("Connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        """Returns (opcode, payload) for text (1) and binary (2); handles ping and close."""
        message, first_op = b"", None
        while True:
            b1, b2 = self._read(2)
            fin, op, n = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b2 & 0x80 else None
            data = self._read(n)
            if mask:
                data = _xor(data, mask)
            if op == 0x9:
                self._send(0xA, data)
                continue
            if op == 0xA:
                continue
            if op == 0x8:
                raise ConnectionError("Closed by the server")
            if op in (0x1, 0x2):
                first_op, message = op, data
            elif op == 0x0:
                message += data
            if fin:
                return first_op, message

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def _xor(data, mask):
    # Fast XOR via int arithmetic (no numpy): repeat the mask to the data's length.
    n = len(data)
    m = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big") if n else b""


# ---------------------------------------------------------------------------------------------
# Facts about this computer.
def read(path, default=""):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except (OSError, ValueError):
        return default


def os_release():
    out = {}
    for line in read("/etc/os-release").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k] = v.strip().strip('"')
    return out


def package_manager():
    for name in ("apt", "dnf", "pacman", "zypper"):
        if shutil.which(name if name != "apt" else "apt-get"):
            return name
    return ""


def update_command(pkg, omarchy):
    if omarchy:
        return "omarchy update"
    return {"apt": "sudo apt update && sudo apt upgrade", "dnf": "sudo dnf upgrade --refresh", "pacman": "sudo pacman -Syu", "zypper": "sudo zypper update"}.get(pkg, "")


def omarchy_facts():
    if not shutil.which("omarchy"):
        return {"omarchy": False}
    plugins = []
    pdir = os.path.expanduser("~/.config/omarchy/plugins")
    for name in sorted(os.listdir(pdir)) if os.path.isdir(pdir) else []:
        if name.startswith("."):
            continue
        try:
            with open(os.path.join(pdir, name, "manifest.json")) as f:
                manifest = json.load(f)
            plugins.append(str((manifest.get("id") if isinstance(manifest, dict) else None) or name))
        except (OSError, ValueError):
            plugins.append(name)
    themes = []
    if shutil.which("omarchy-theme-list"):
        try:
            themes = [t for t in subprocess.run(["omarchy-theme-list"], capture_output=True, text=True, timeout=10).stdout.splitlines() if t.strip()]
        except (OSError, subprocess.SubprocessError):
            pass
    theme = read(os.path.expanduser("~/.local/state/omarchy/current/theme.name")).strip()
    return {"omarchy": True, "plugins": plugins, "themes": themes, "theme": theme}


def info():
    rel = os_release()
    pkg = package_manager()
    om = omarchy_facts()
    return {
        "hostname": socket.gethostname(),
        "os": rel.get("PRETTY_NAME") or rel.get("NAME") or "Linux",
        "osId": rel.get("ID", ""),
        "kernel": os.uname().release,
        "arch": os.uname().machine,
        "user": pwd.getpwuid(os.getuid()).pw_name,
        "version": VERSION,
        "pkg": pkg,
        "updateCommand": update_command(pkg, om.get("omarchy")),
        "desktop": desktop_kind(),
        **om,
    }


_cpu_last = None


def cpu_percent():
    global _cpu_last
    parts = read("/proc/stat").split("\n", 1)[0].split()[1:]
    vals = [int(x) for x in parts] if parts else []
    if len(vals) < 4:
        return None
    # guest and guest_nice (the 9th and 10th values) are already counted in user and nice.
    idle, total = vals[3] + (vals[4] if len(vals) > 4 else 0), sum(vals[:8])
    last, _cpu_last = _cpu_last, (idle, total)
    if not last or total == last[1]:
        return None
    return round(100 * (1 - (idle - last[0]) / (total - last[1])), 1)


def meminfo():
    m = {}
    for line in read("/proc/meminfo").splitlines():
        k, _, rest = line.partition(":")
        if rest.strip():
            m[k] = int(rest.split()[0]) * 1024
    total = m.get("MemTotal", 0)
    return {"total": total, "used": total - m.get("MemAvailable", m.get("MemFree", 0))}, {"total": m.get("SwapTotal", 0), "used": m.get("SwapTotal", 0) - m.get("SwapFree", 0)}


REAL_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "bcachefs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "nfs", "nfs4", "cifs"}
# A hard-mounted nfs/cifs (or any other wedged mount) can sit inside statvfs forever.
_STAT_TIMEOUT = 0.75
_stat_lock = threading.Lock()
_stat_busy = {}


def _begin_stat(mount):
    """Start one statvfs. None if this mount is already stuck in an earlier call."""
    with _stat_lock:
        state = _stat_busy.get(mount)
        if state is not None and state["thread"].is_alive():
            return None, None
        box = {}

        def work():
            try:
                box["st"] = os.statvfs(mount)
            except OSError:
                box["err"] = True
            finally:
                with _stat_lock:
                    cur = _stat_busy.get(mount)
                    if cur is not None and cur["thread"] is threading.current_thread():
                        _stat_busy.pop(mount, None)

        thread = threading.Thread(target=work, daemon=True)
        _stat_busy[mount] = {"thread": thread, "box": box}
        thread.start()
        return thread, box


def disks():
    out, seen, mounts = [], set(), []
    for line in read("/proc/mounts").splitlines():
        p = line.split()
        if len(p) < 3 or p[2] not in REAL_FS:
            continue
        # A ZFS dataset's device is its own name, but every dataset in a pool is one disk.
        key = p[0].split("/")[0] if p[2] == "zfs" else p[0]
        if key in seen:
            continue
        mount = p[1].replace("\\040", " ")
        if any(mount == p or mount.startswith(p + "/") for p in ("/boot", "/snap", "/var/lib/docker", "/var/lib/containers")):
            continue
        seen.add(key)
        mounts.append(mount)
    jobs = [(mount, *_begin_stat(mount)) for mount in mounts]
    # One budget for every mount. A stuck share must not add another wait for each one.
    deadline = time.monotonic() + _STAT_TIMEOUT
    for _mount, thread, _box in jobs:
        if thread is None:
            continue
        remaining = deadline - time.monotonic()
        if remaining > 0:
            thread.join(remaining)
    for mount, _thread, box in jobs:
        if not box or box.get("err"):
            continue
        st = box.get("st")
        if not st:
            continue
        total = st.f_blocks * st.f_frsize
        if total:
            out.append({"mount": mount, "total": total, "used": total - st.f_bfree * st.f_frsize})
    return out[:12]


def _num(s):
    t = str(s or "").strip()
    if not t or t.lower() in ("[n/a]", "n/a", "na"):
        return None
    try:
        n = float(t)
    except ValueError:
        return None
    return n


def batteries(list_dir=os.listdir, read_file=read, root="/sys/class/power_supply"):
    """System packs only. HID mouse/keyboard batteries (scope=Device) are skipped."""
    try:
        names = sorted(list_dir(root))
    except OSError:
        return []
    statuses = {"charging": "charging", "discharging": "discharging", "full": "full", "not charging": "not-charging"}
    out = []
    for name in names:
        d = os.path.join(root, name)
        if read_file(os.path.join(d, "type")).strip().lower() != "battery":
            continue
        if read_file(os.path.join(d, "present")).strip() == "0":
            continue
        if read_file(os.path.join(d, "scope")).strip().lower() == "device":
            continue
        status = statuses.get(read_file(os.path.join(d, "status")).strip().lower(), "unknown")
        model = read_file(os.path.join(d, "model_name")).strip() or read_file(os.path.join(d, "manufacturer")).strip() or name
        capacity = _num(read_file(os.path.join(d, "capacity")))
        energy_now = _num(read_file(os.path.join(d, "energy_now")))
        energy_full = _num(read_file(os.path.join(d, "energy_full")))
        power_now = _num(read_file(os.path.join(d, "power_now")))
        charge_now = _num(read_file(os.path.join(d, "charge_now")))
        charge_full = _num(read_file(os.path.join(d, "charge_full")))
        current_now = _num(read_file(os.path.join(d, "current_now")))
        voltage_now = _num(read_file(os.path.join(d, "voltage_now")))
        if energy_now is None and charge_now is not None and voltage_now is not None:
            energy_now = charge_now * voltage_now / 1e6
        if energy_full is None and charge_full is not None and voltage_now is not None:
            energy_full = charge_full * voltage_now / 1e6
        if power_now is None and current_now is not None and voltage_now is not None:
            power_now = current_now * voltage_now / 1e6
        percent = capacity
        if percent is None and energy_now is not None and energy_full and energy_full > 0:
            percent = 100 * energy_now / energy_full
        if percent is not None:
            percent = int(round(min(100, max(0, percent))))
        seconds = None
        if power_now and power_now > 0 and energy_now is not None:
            if status == "discharging":
                seconds = int(round(energy_now / power_now * 3600))
            elif status == "charging" and energy_full and energy_full > energy_now:
                seconds = int(round((energy_full - energy_now) / power_now * 3600))
        out.append(
            {
                "id": name,
                "index": len(out),
                "name": model,
                "percent": percent,
                "status": status,
                "secondsRemaining": seconds,
                "power": None if power_now is None else round(power_now / 1e6, 1),
                "energyNow": None if energy_now is None else int(round(energy_now)),
                "energyFull": None if energy_full is None else int(round(energy_full)),
            }
        )
    return out


def _nvidia_gpus(run):
    try:
        out = run("nvidia-smi", ["--query-gpu=index,name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"])
    except (OSError, subprocess.SubprocessError):
        return []
    gpus = []
    for line in (out or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        index = _num(parts[0])
        name = parts[1]
        if index is None or not name:
            continue
        used = _num(parts[3])
        gpus.append({"id": parts[2] or f"nvidia-{int(index)}", "index": int(index), "name": name, "used": None if used is None else int(round(used))})
    return gpus


_VENDOR_NVIDIA = "0x10de"
_VENDOR_AMD = "0x1002"
_VENDOR_INTEL = "0x8086"


def _drm_fallback_name(vendor, card):
    if vendor == _VENDOR_INTEL:
        return "Intel Graphics"
    if vendor == _VENDOR_AMD:
        return "AMD Graphics"
    if vendor == _VENDOR_NVIDIA:
        return "NVIDIA Graphics"
    return card


_last_engine = {}
_last_rc6 = {}


def _engine_busy_percent(card, list_dir, read_file, now):
    # i915/Xe: each engine's busy file is cumulative nanoseconds. gpu_busy_percent is AMD's.
    engines_dir = f"/sys/class/drm/{card}/engine"
    try:
        names = list_dir(engines_dir)
    except OSError:
        return None
    busy = {}
    for n in names:
        v = _num(read_file(f"{engines_dir}/{n}/busy"))
        if v is not None:
            busy[n] = v
    if not busy:
        return None
    t = now()
    prev = _last_engine.get(card)
    _last_engine[card] = (t, busy)
    if not prev:
        return None
    dt = t - prev[0]
    if dt <= 0:
        return None
    dt_ns = dt * 1e9

    def pct(name):
        if name not in busy or name not in prev[1]:
            return None
        return (busy[name] - prev[1][name]) / dt_ns * 100

    render_compute = [p for p in (pct("rcs0"), pct("ccs0")) if p is not None]
    if render_compute:
        return min(100, max(0, max(render_compute)))
    ps = [p for p in (pct(n) for n in busy) if p is not None]
    return min(100, max(0, max(ps))) if ps else None


def _rc6_busy_percent(card, read_file, now):
    # i915 without engine busy files: RC6 residency is cumulative idle milliseconds.
    enable = _num(read_file(f"/sys/class/drm/{card}/gt/gt0/rc6_enable"))
    raw = read_file(f"/sys/class/drm/{card}/gt/gt0/rc6_residency_ms")
    if not str(raw or "").strip():
        enable = enable if enable is not None else _num(read_file(f"/sys/class/drm/{card}/device/power/rc6_enable"))
        raw = read_file(f"/sys/class/drm/{card}/device/power/rc6_residency_ms")
    if enable == 0:
        return None
    rc6 = _num(raw)
    if rc6 is None:
        return None
    t = now()
    prev = _last_rc6.get(card)
    _last_rc6[card] = (t, rc6)
    if not prev:
        return None
    dt_ms = (t - prev[0]) * 1000
    if dt_ms <= 0:
        return None
    idle = (rc6 - prev[1]) / dt_ms * 100
    return min(100, max(0, 100 - idle))


def _drm_gpus(list_dir, read_file, skip_vendors=None, now=time.monotonic):
    skip_vendors = skip_vendors or set()
    try:
        names = list_dir("/sys/class/drm")
    except OSError:
        return []
    cards = sorted(n for n in names if n.startswith("card") and n[4:].isdigit())
    gpus = []
    for card in cards:
        vendor = (read_file(f"/sys/class/drm/{card}/device/vendor") or "").strip().lower()
        if vendor in skip_vendors:
            continue
        if vendor == _VENDOR_INTEL:
            used = _engine_busy_percent(card, list_dir, read_file, now)
            if used is None:
                used = _rc6_busy_percent(card, read_file, now)
        else:
            used = _num(read_file(f"/sys/class/drm/{card}/device/gpu_busy_percent"))
        product = (read_file(f"/sys/class/drm/{card}/device/product_name") or "").strip()
        name = product or _drm_fallback_name(vendor, card)
        if used is None and vendor != _VENDOR_INTEL:
            continue
        gpus.append({"id": f"drm-{card}", "index": int(card[4:]), "name": name, "used": None if used is None else int(round(used))})
    return gpus


_last_nvidia = None


def nvidia_asleep(list_dir=os.listdir, read_file=read, root="/sys/bus/pci/devices"):
    """True when every NVIDIA display device is runtime-suspended (nvidia-smi would wake it)."""
    try:
        names = list_dir(root)
    except OSError:
        return False
    found = False
    for d in names:
        if read_file(os.path.join(root, d, "vendor")).strip().lower() != "0x10de":
            continue
        if not read_file(os.path.join(root, d, "class")).strip().startswith("0x03"):
            continue
        found = True
        if read_file(os.path.join(root, d, "power", "runtime_status")).strip() != "suspended":
            return False
    return found


def _with_indexes(rows):
    for i, g in enumerate(rows):
        g["index"] = i
    return rows


def gpus(run=None, list_dir=os.listdir, read_file=read, now=time.monotonic):
    def _run(cmd, args):
        try:
            return subprocess.run([cmd, *args], capture_output=True, text=True, timeout=8).stdout or ""
        except (OSError, subprocess.SubprocessError):
            return ""

    global _last_nvidia
    if _last_nvidia and nvidia_asleep(list_dir, read_file):
        idle = [dict(g, used=0) for g in _last_nvidia]
        return _with_indexes(idle + _drm_gpus(list_dir, read_file, skip_vendors={_VENDOR_NVIDIA}, now=now))
    nvidia = _nvidia_gpus(run or _run)
    _last_nvidia = nvidia or None
    skip = {_VENDOR_NVIDIA} if nvidia else set()
    return _with_indexes(nvidia + _drm_gpus(list_dir, read_file, skip_vendors=skip, now=now))


def temperature():
    best = None
    for base in ("/sys/class/hwmon", "/sys/class/thermal"):
        for d in os.listdir(base) if os.path.isdir(base) else []:
            path = os.path.join(base, d)
            for f in os.listdir(path) if os.path.isdir(path) else []:
                if re.fullmatch(r"temp\d*_input|temp", f):
                    try:
                        v = int(read(os.path.join(path, f)).strip()) / 1000
                    except ValueError:
                        continue
                    if 0 < v < 130:
                        best = v if best is None else max(best, v)
    return None if best is None else round(best, 1)


_updates = {"at": 0, "n": None, "busy": False}


def updates_waiting(pkg):
    """How many updates are waiting: checked in the background at most every 30 minutes (without
    root; some package managers take a minute or two), so reporting never waits for it."""
    if not _updates["busy"] and time.time() - _updates["at"] >= 1800:
        _updates["busy"], _updates["at"] = True, time.time()
        threading.Thread(target=_check_updates, args=(pkg,), daemon=True).start()
    return _updates["n"]


def _check_updates(pkg):
    cmd = {"apt": ["apt", "list", "--upgradable"], "dnf": ["dnf", "-q", "check-update"], "pacman": ["checkupdates"] if shutil.which("checkupdates") else ["pacman", "-Qu"], "zypper": ["zypper", "-q", "lu"]}.get(pkg)
    try:
        if cmd:
            # English output, so the header lines below are recognised whatever the system language.
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=dict(os.environ, LC_ALL="C", LANG="C"))
            _updates["n"] = len([l for l in r.stdout.splitlines() if l.strip() and not l.startswith(("Listing", "Last metadata", "S |", "--+", "Loading", "Repository", "Obsoleting"))])
    except (OSError, subprocess.SubprocessError):
        _updates["n"] = None
    finally:
        _updates["busy"] = False


DEFAULT_INTERVALS = {
    "cpu": 1,
    "memory": 1,
    "gpu": 1,
    "temp": 5,
    "battery": 5,
    "disk": 30,
    "uptime": 60,
}
_TICK = 0.25
IDLE_S = 15


def empty_snapshot():
    return {
        "cpu": None,
        "cores": os.cpu_count(),
        "load": [],
        "mem": {},
        "swap": {},
        "disks": [],
        "gpus": [],
        "batteries": [],
        "temp": None,
        "uptime": 0,
        "updates": None,
    }


def default_reads():
    return {
        "cpu": cpu_percent,
        "memory": meminfo,
        "gpu": gpus,
        "temp": temperature,
        "battery": batteries,
        "disk": disks,
        "uptime": lambda: float(read("/proc/uptime", "0").split()[0] or 0),
    }


class Sampler:
    def __init__(self, now=None, intervals=None, read=None, spawn=None):
        # Scheduling follows a monotonic clock. A wall clock that steps backward
        # would otherwise freeze every reading until it caught up.
        self._now = time.monotonic if now is None else now
        self._intervals = {**DEFAULT_INTERVALS, **(intervals or {})}
        self._read = read or default_reads()
        self._last = {}
        self._snap = empty_snapshot()
        self._stopped = False
        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._tick_lock = threading.Lock()
        self._last_read = 0
        self._primed = False
        self._gpu_running = False
        if spawn is not None:
            self._spawn = spawn

    def _due(self, key):
        last = self._last.get(key)
        if last is None:
            return True
        elapsed = self._now() - last
        return elapsed < 0 or elapsed >= self._intervals.get(key, DEFAULT_INTERVALS[key])

    def _take(self, key, apply, t):
        if not self._due(key) or key not in self._read:
            return
        # Record the attempt first, so a failure waits out the interval.
        self._last[key] = t
        try:
            apply(self._read[key]())
        except Exception:
            pass

    def tick(self, wait_gpu=True):
        if self._stopped:
            return self._snap
        # A sample is already running on the timer. Don't publish an empty disk list over it.
        if not self._tick_lock.acquire(blocking=False):
            return self._snap
        try:
            return self._tick(wait_gpu)
        finally:
            self._tick_lock.release()

    def _tick(self, wait_gpu=True):
        t = self._now()
        # Read disks before publishing memory. A list that sees memory also sees this sample's disks.
        take_disk = self._due("disk") and "disk" in self._read
        disk_rows = None
        if take_disk:
            self._last["disk"] = t
            try:
                disk_rows = self._read["disk"]()
            except Exception:
                disk_rows = None
        if take_disk and disk_rows is not None:
            self._snap["disks"] = disk_rows
        self._take("cpu", lambda v: self._snap.update(cpu=v, cores=os.cpu_count(), load=list(os.getloadavg())), t)
        def mem(v):
            if isinstance(v, tuple):
                self._snap["mem"], self._snap["swap"] = v
            else:
                self._snap["mem"] = v
        self._take("memory", mem, t)
        self._take("temp", lambda v: self._snap.update(temp=v), t)
        self._take("battery", lambda v: self._snap.update(batteries=v), t)
        self._take("uptime", lambda v: self._snap.update(uptime=v), t)
        if self._due("gpu") and "gpu" in self._read and not self._gpu_running:
            self._last["gpu"] = t
            self._gpu_running = True

            def run_gpu():
                try:
                    self._snap["gpus"] = self._read["gpu"]()
                except Exception:
                    pass
                finally:
                    self._gpu_running = False

            if wait_gpu:
                run_gpu()
            else:
                threading.Thread(target=run_gpu, daemon=True).start()
        return self._snap

    def _spawn(self, target):
        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        return thread

    def _prime_cpu(self):
        # cpu percent needs one throwaway read before the first real sample.
        if self._primed or "cpu" not in self._read:
            return
        self._primed = True
        try:
            self._read["cpu"]()
        except Exception:
            pass

    def _ensure(self):
        with self._lock:
            if self._stopped or self._thread is not None:
                return
            self._stop.clear()
            self._thread = self._spawn(self._loop)

    def _loop(self):
        while not self._stop.wait(_TICK):
            if not self.service():
                return

    def service(self):
        """One timer tick. False means nobody has read lately, so the timer stops."""
        if self._stopped:
            with self._lock:
                self._thread = None
            self._stop.set()
            return False
        elapsed = self._now() - self._last_read
        if elapsed < 0:
            self._last_read = self._now()
        elif elapsed >= IDLE_S:
            with self._lock:
                self._thread = None
            self._stop.set()
            return False
        self.tick(wait_gpu=False)
        return True

    def _note(self, refresh):
        self._last_read = self._now()
        if self._stopped:
            return
        was_idle = self._thread is None
        self._ensure()
        if was_idle and refresh and self._last.get("cpu") is not None:
            self._spawn(lambda: self.tick(wait_gpu=False))

    def active(self):
        return self._thread is not None and not self._stopped

    def peek(self):
        return self._snap

    def snapshot(self):
        self._note(True)
        return self._snap

    def get(self):
        if self._stopped:
            return self._snap
        cold = self._last.get("cpu") is None
        if cold:
            # The priming read and a real sample in the same call are microseconds
            # apart, so the first percent is noise. Leave cpu empty until the next tick.
            self._prime_cpu()
            self._last["cpu"] = self._now()
        # Don't tick here. metrics() calls get() from the receive loop, and the first
        # sample used to run on that caller. A stuck mount would freeze the connector.
        self._note(True)
        return self._snap

    def start(self):
        # A connection coming back may sample again. A read is what starts the timer.
        self._stopped = False

    def stop(self):
        self._stopped = True
        self._stop.set()
        with self._lock:
            self._thread = None


def create_sampler(now=None, intervals=None, read=None, spawn=None):
    return Sampler(now=now, intervals=intervals, read=read, spawn=spawn)


_process_sampler = None


def metrics(pkg, sampler=None):
    global _process_sampler
    s = sampler
    if s is None:
        if _process_sampler is None:
            _process_sampler = create_sampler()
        s = _process_sampler
    snap = s.get()
    snap["updates"] = updates_waiting(pkg)
    return snap


# ---------------------------------------------------------------------------------------------
# Desktop: which kind this computer has, and a VNC server on a private socket when one is shown.
def _hypr_signature():
    d = os.path.join(RUNTIME, "hypr")
    sigs = sorted(os.listdir(d), key=lambda s: os.path.getmtime(os.path.join(d, s)), reverse=True) if os.path.isdir(d) else []
    return sigs[0] if sigs else None


def _wayland_display():
    socks = sorted(f for f in os.listdir(RUNTIME) if re.fullmatch(r"wayland-\d+", f)) if os.path.isdir(RUNTIME) else []
    return socks[0] if socks else None


def _x_display():
    xs = sorted(f for f in os.listdir("/tmp/.X11-unix") if re.fullmatch(r"X\d+", f)) if os.path.isdir("/tmp/.X11-unix") else []
    for x in xs:
        try:
            if os.stat(os.path.join("/tmp/.X11-unix", x)).st_uid in (os.getuid(), 0):
                return ":" + x[1:]
        except OSError:
            pass
    return None


def _xauthority():
    for p in [os.environ.get("XAUTHORITY"), os.path.expanduser("~/.Xauthority"), os.path.join(RUNTIME, "gdm", "Xauthority")]:
        if p and os.path.exists(p):
            return p
    for f in os.listdir(RUNTIME) if os.path.isdir(RUNTIME) else []:
        if f.startswith("xauth_"):
            return os.path.join(RUNTIME, f)
    return None


def desktop_kind():
    wl = _wayland_display()
    wlroots = _hypr_signature() or any(f.startswith("sway-ipc.") for f in (os.listdir(RUNTIME) if os.path.isdir(RUNTIME) else []))
    if wl and wlroots:
        return {"kind": "wlroots", "ok": bool(shutil.which("wayvnc")), "why": "" if shutil.which("wayvnc") else "wayvnc isn’t installed. Run the connector installer again with the desktop switched on."}
    if wl:
        return {"kind": "wayland", "ok": False, "why": "This desktop (GNOME or KDE on Wayland) can’t be shared yet. Sign in with an X11 session, or use Hyprland or Sway."}
    if _x_display():
        return {"kind": "x11", "ok": bool(shutil.which("x11vnc")), "why": "" if shutil.which("x11vnc") else "x11vnc isn’t installed. Run the connector installer again with the desktop switched on."}
    return {"kind": "none", "ok": False, "why": "Nobody is signed in to a desktop on this computer."}


_vnc = {"proc": None, "users": 0, "stop_at": None}
_vnc_lock = threading.Lock()


def vnc_start():
    with _vnc_lock:
        if _vnc["proc"] and _vnc["proc"].poll() is None and os.path.exists(VNC_SOCK):
            _vnc["users"] += 1
            return
        d = desktop_kind()
        if not d["ok"]:
            raise RuntimeError(d["why"])
        os.makedirs(os.path.dirname(VNC_SOCK), mode=0o700, exist_ok=True)
        os.chmod(os.path.dirname(VNC_SOCK), 0o700)
        if os.path.exists(VNC_SOCK):
            os.unlink(VNC_SOCK)
        env = dict(os.environ, XDG_RUNTIME_DIR=RUNTIME)
        if d["kind"] == "wlroots":
            env["WAYLAND_DISPLAY"] = _wayland_display()
            sig = _hypr_signature()
            if sig:
                env["HYPRLAND_INSTANCE_SIGNATURE"] = sig
            cmd = ["wayvnc", "--max-fps=30", "--unix-socket", VNC_SOCK]
        else:
            env["DISPLAY"] = _x_display()
            auth = _xauthority()
            cmd = ["x11vnc", "-display", env["DISPLAY"], "-unixsock", VNC_SOCK, "-rfbport", "0", "-forever", "-shared", "-nopw", "-quiet", "-noxdamage"]
            if auth:
                cmd[3:3] = ["-auth", auth]
        _vnc["proc"] = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(50):
            if os.path.exists(VNC_SOCK):
                break
            if _vnc["proc"].poll() is not None:
                _vnc["proc"] = None
                raise RuntimeError("The screen sharing program stopped straight away.")
            time.sleep(0.1)
        else:
            # Still running but no socket: stop it, so a retry doesn't leave another one behind.
            p, _vnc["proc"] = _vnc["proc"], None
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except OSError:
                pass
            raise RuntimeError("The screen sharing program didn’t start.")
        _vnc["users"] = 1


def vnc_release():
    with _vnc_lock:
        _vnc["users"] = max(0, _vnc["users"] - 1)
        if _vnc["users"] == 0 and _vnc["proc"]:
            p, _vnc["proc"] = _vnc["proc"], None
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except OSError:
                pass


# ---------------------------------------------------------------------------------------------
# Channels: a shell or the screen, joined to the server by a channel number.
class Channel:
    def __init__(self, conn, ch):
        self.conn, self.ch, self.closed = conn, ch, False
        self.head = struct.pack(">I", ch)

    def out(self, data):
        try:
            self.conn.ws.send_binary(self.head + data)
        except OSError:
            self.close()

    def ended(self, reason="", code=1000):
        if not self.closed:
            self.close()
            self.conn.send({"op": "closed", "ch": self.ch, "reason": reason, "code": code})


# Past this much unread terminal input the program isn't reading. Close it so the
# receive loop never blocks inside os.write on a full pty.
SHELL_IN_MAX = 1 << 20


class Shell(Channel):
    def __init__(self, conn, ch, cols, rows):
        super().__init__(conn, ch)
        me = pwd.getpwuid(os.getuid())
        shell = me.pw_shell if me.pw_shell and os.path.exists(me.pw_shell) else "/bin/bash"
        pid, fd = pty.fork()
        if pid == 0:
            # The child must never fall back into the connector's own code.
            # Python ignores SIGPIPE and SIGXFSZ, and exec keeps an ignored signal.
            try:
                signal.signal(signal.SIGPIPE, signal.SIG_DFL)
                signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
                os.chdir(me.pw_dir)
                env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", HOME=me.pw_dir, SHELL=shell, USER=me.pw_name, LANG=os.environ.get("LANG") or "C.UTF-8")
                os.execvpe(shell, [shell, "-l"], env)
            except BaseException:  # noqa: BLE001
                pass
            os._exit(127)
        self.pid, self.fd = pid, fd
        flags = fcntl.fcntl(self.fd, fcntl.F_GETFL)
        fcntl.fcntl(self.fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        self._pending = bytearray()
        self._write_cv = threading.Condition()
        self.resize(cols, rows)
        threading.Thread(target=self.pump, daemon=True).start()
        threading.Thread(target=self._write_loop, daemon=True).start()

    def resize(self, cols, rows):
        try:
            cols = min(500, max(10, int(cols or 80)))
            rows = min(300, max(4, int(rows or 24)))
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except (OSError, ValueError, TypeError):
            pass

    def pump(self):
        # This thread owns the pty: it alone closes it, so its number can't be reused by a new
        # terminal while this loop still reads from it.
        try:
            while not self.closed:
                try:
                    r, _, _ = select.select([self.fd], [], [], 1)
                    if r:
                        data = os.read(self.fd, 65536)
                        if not data:
                            break
                        self.out(data)
                except BlockingIOError:
                    continue
                except OSError:
                    break
            self.ended("Shell ended")
        finally:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.reap()

    def reap(self):
        # Wait for the shell so it doesn't stay behind as a zombie; one that ignores SIGHUP is killed.
        for _ in range(30):
            try:
                if os.waitpid(self.pid, os.WNOHANG)[0]:
                    return
            except OSError:
                return
            time.sleep(0.1)
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except OSError:
            pass

    def write(self, data):
        # Connection.run calls this on its only receive thread. Queue the bytes and return;
        # a pty whose program is not reading must not stall that thread.
        if not data or self.closed:
            return
        overflow = False
        with self._write_cv:
            if not self.closed:
                if len(self._pending) + len(data) > SHELL_IN_MAX:
                    overflow = True
                else:
                    self._pending += data
                    self._write_cv.notify()
        if overflow:
            self.ended("The terminal stopped reading")

    def _write_loop(self):
        while not self.closed:
            with self._write_cv:
                if not self._pending and not self.closed:
                    self._write_cv.wait(0.2)
                if self.closed or not self._pending:
                    continue
                data = bytes(self._pending)
            try:
                n = os.write(self.fd, data)
            except BlockingIOError:
                try:
                    select.select([], [self.fd], [], 0.2)
                except (OSError, ValueError):
                    self.ended("Shell ended")
                    return
                continue
            except OSError:
                self.ended("Shell ended")
                return
            if n:
                with self._write_cv:
                    del self._pending[:n]

    def close(self):
        if self.closed:
            return
        self.closed = True
        cv = getattr(self, "_write_cv", None)
        if cv is not None:
            with cv:
                cv.notify_all()
        try:
            os.kill(self.pid, signal.SIGHUP)
        except OSError:
            pass
        # The pump thread closes the pty and reaps the shell when it sees this.


class Screen(Channel):
    def __init__(self, conn, ch):
        super().__init__(conn, ch)
        vnc_start()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.sock.connect(VNC_SOCK)
        except OSError:
            vnc_release()
            raise
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        while not self.closed:
            try:
                data = self.sock.recv(65536)
            except OSError:
                break
            if not data:
                break
            self.out(data)
        self.ended("The screen sharing ended")

    def write(self, data):
        try:
            self.sock.sendall(data)
        except OSError:
            self.ended("The screen sharing ended")

    def close(self):
        if self.closed:
            return
        self.closed = True
        # shutdown() wakes the pump's blocked recv(); close() alone leaves the VNC connection open.
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass
        vnc_release()


# ---------------------------------------------------------------------------------------------
# Manage: the only things the server can ask for (there is no "run this command").
PLUGIN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
REPO = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SHA = re.compile(r"^[0-9a-f]{40}$")
THEME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,79}$")


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=kw.pop("timeout", 300), **kw)
    if r.returncode != 0:
        lines = ((r.stderr or "").strip() or (r.stdout or "").strip()).splitlines()
        raise RuntimeError((lines[-1] if lines else f"{cmd[0]} failed")[:300])
    return r.stdout


def plugin_install(args):
    pid, repo, commit = str(args.get("id", "")), str(args.get("repo", "")), str(args.get("commit", ""))
    if not (PLUGIN_ID.match(pid) and ".." not in pid and REPO.match(repo) and SHA.match(commit)):
        raise RuntimeError("That plugin’s details don’t look right")
    if not shutil.which("omarchy-plugin-validate"):
        raise RuntimeError("This computer’s Omarchy doesn’t support plugins yet. Update Omarchy first.")
    pdir = os.path.expanduser("~/.config/omarchy/plugins")
    os.makedirs(pdir, exist_ok=True)
    target = os.path.join(pdir, pid)
    if os.path.exists(target):
        raise RuntimeError("That plugin is already installed")
    stage = os.path.join(pdir, f".add.tmp.{os.urandom(6).hex()}")
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        if shutil.which("omarchy-git-url-check"):
            run(["omarchy-git-url-check", repo + ".git"])
        os.mkdir(stage)
        run(["git", "init", "-q"], cwd=stage, env=env)
        run(["git", "fetch", "-q", "--depth", "1", "--", repo + ".git", commit], cwd=stage, env=env)
        run(["git", "-c", "advice.detachedHead=false", "checkout", "-q", commit], cwd=stage, env=env)
        if run(["git", "rev-parse", "HEAD"], cwd=stage).strip() != commit:
            raise RuntimeError("The plugin’s code didn’t match the verified version")
        run(["omarchy-plugin-validate", stage])
        with open(os.path.join(stage, "manifest.json")) as f:
            if json.load(f).get("id") != pid:
                raise RuntimeError("The plugin’s manifest doesn’t match its listing")
        os.rename(stage, target)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    subprocess.run(["omarchy-shell", "shell", "rescanPlugins"], capture_output=True, timeout=30)
    for _ in range(20):
        if subprocess.run(["omarchy-plugin-enable", pid], capture_output=True, timeout=30).returncode == 0:
            return True
        time.sleep(0.25)
    raise RuntimeError("Added, but it couldn’t be turned on. Turn it on from the Omarchy menu → Plugins.")


def plugin_remove(args):
    pid = str(args.get("id", ""))
    if not (PLUGIN_ID.match(pid) and ".." not in pid):
        raise RuntimeError("Unknown plugin")
    if not os.path.isdir(os.path.expanduser(f"~/.config/omarchy/plugins/{pid}")):
        raise RuntimeError("That plugin isn’t installed")
    run(["omarchy-plugin-remove", pid, "--yes"])
    return True


def theme_set(args):
    name = str(args.get("name", ""))
    if not THEME.match(name) or not shutil.which("omarchy-theme-set"):
        raise RuntimeError("That theme can’t be set here")
    run(["omarchy-theme-set", name], timeout=120)
    return True


def reboot(_args):
    run(["systemctl", "reboot"], timeout=30)
    return True


ACTIONS = {"plugin-install": plugin_install, "plugin-remove": plugin_remove, "theme-set": theme_set, "reboot": reboot}

HELPER = "/usr/local/libexec/omarchy-connector/helper.py"


def helper(verb, *args):
    r = subprocess.run(["sudo", "-n", HELPER, verb, *args], capture_output=True, text=True, timeout=600)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout or "Storage helper failed").strip().split("\n")[-1][:300])
    return r.stdout.strip()


def storage_status(_args):
    try:
        ok = helper("ping") == "ok"
    except Exception:
        ok = False
    zfs = False
    if ok:
        try:
            zfs = helper("zfs-available") == "yes"
        except Exception:
            zfs = False
    return {"helperAvailable": ok, "zfsAvailable": zfs}


def storage_disks(_args):
    return json.loads(helper("disks"))


def storage_unmount(args):
    helper("umount", args["device"])
    return True


def storage_mount(args):
    helper("mount", args["device"])
    return True


def storage_format(args):
    fs = args.get("filesystem")
    if fs not in ("blank", "ext4", "exfat"):
        raise RuntimeError("Choose blank, ext4 or exfat")
    helper("format", args["device"], fs)
    return True


def storage_pools(_args):
    return json.loads(helper("pools"))


def storage_importable(_args):
    return json.loads(helper("importable"))


def storage_create_pool(args):
    name = args.get("name")
    profile = args.get("profile")
    devices = args.get("devices") or []
    if args.get("fs") == "zfs":
        helper("zfs-create", name, profile, *devices)
    else:
        helper("pool-create", name, profile, *devices)
    return True


def storage_add_to_pool(args):
    helper("pool-add", args.get("name"), args.get("device"))
    return True


def storage_import_pool(args):
    uuid = str(args.get("uuid") or "")
    if uuid.startswith("zfs:"):
        extra = ["force"] if args.get("force") is True else []
        helper("zfs-import", uuid[4:], *extra)
    else:
        helper("pool-import", args.get("name"), uuid)
    return True


def storage_forget_pool(args):
    if args.get("kind") == "zfs":
        helper("zfs-export", args.get("name"))
    else:
        helper("pool-forget", args.get("name"))
    return True


def storage_scrub(args):
    if args.get("kind") == "zfs":
        helper("zfs-scrub", args.get("name"))
    else:
        helper("pool-scrub", args.get("name"))
    return True


def storage_set_sleep(args):
    helper("sleep", args.get("device"), str(args.get("minutes")))
    return True


STORAGE_ACTIONS = {
    "storage-status": storage_status,
    "storage-disks": storage_disks,
    "storage-unmount": storage_unmount,
    "storage-mount": storage_mount,
    "storage-format": storage_format,
    "storage-pools": storage_pools,
    "storage-importable": storage_importable,
    "storage-createPool": storage_create_pool,
    "storage-addToPool": storage_add_to_pool,
    "storage-importPool": storage_import_pool,
    "storage-forgetPool": storage_forget_pool,
    "storage-scrub": storage_scrub,
    "storage-setSleep": storage_set_sleep,
}


# ---------------------------------------------------------------------------------------------
# Backups (ability "backup"). The server says which folders and sends the store's password for each
# run (it's never kept here). restic talks to a small relay on 127.0.0.1, reachable only under a
# random path for this run, which forwards to the server over the same pinned connection the
# connector uses, signed with this computer's key.
def _restic_arch():
    m = os.uname().machine
    return {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(m)


def _restic_version(path):
    try:
        out = subprocess.run([path, "version"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"restic (\d+)\.(\d+)\.(\d+)", out)
    return (int(m.group(1)), int(m.group(2))) if m else None


def restic_path(fetch=None):
    system = shutil.which("restic")
    if system and (_restic_version(system) or (0, 0)) >= (0, 14):
        return system
    mine = os.path.join(DATA_DIR, f"restic-{RESTIC_VERSION}")
    if _restic_version(mine):
        return mine
    arch = _restic_arch()
    if not arch:
        raise RuntimeError("Install restic on this computer (its package is called restic), then try again")
    url = f"https://github.com/restic/restic/releases/download/v{RESTIC_VERSION}/restic_{RESTIC_VERSION}_linux_{arch}.bz2"
    packed = fetch(url) if fetch else urllib.request.urlopen(url, timeout=120).read()
    if hashlib.sha256(packed).hexdigest() != RESTIC_SHA256[arch]:
        raise RuntimeError("The downloaded backup engine didn’t match its published checksum, so it wasn’t used")
    os.makedirs(DATA_DIR, mode=0o700, exist_ok=True)
    tmp = f"{mine}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)
    with os.fdopen(fd, "wb") as f:
        f.write(bz2.decompress(packed))
    os.replace(tmp, mine)
    if not _restic_version(mine):
        raise RuntimeError("The backup engine (restic) didn’t start on this computer")
    return mine


FOLDER = re.compile(r"^[^\x00-\x1f/][^\x00-\x1f]{0,199}\Z")


def home_folder(rel):
    """A folder in the home folder, by its relative name; refuses anything that leads outside it."""
    # rstrip only "/", so a listed name like "Photos " still resolves to that directory.
    rel = str(rel).rstrip("/")
    if not rel.strip() or not FOLDER.match(rel) or any(p in ("..", ".") for p in rel.split("/")):
        raise RuntimeError(f"“{rel[:60]}” isn’t a folder in your home folder")
    home = os.path.realpath(os.path.expanduser("~"))
    full = os.path.realpath(os.path.join(home, rel))
    if full != home and not full.startswith(home + os.sep):
        raise RuntimeError(f"“{rel[:60]}” leads outside your home folder")
    return full


def backup_folders(_args):
    home = os.path.expanduser("~")
    out = []
    for name in sorted(os.listdir(home), key=str.lower):
        if name.startswith(".") or not os.path.isdir(os.path.join(home, name)):
            continue
        # A folder that is a link to somewhere outside the home folder can't be backed up from here.
        try:
            home_folder(name)
        except RuntimeError:
            continue
        out.append({"name": name})
    return {"home": home, "folders": out[:200]}


class _Relay(http.server.ThreadingHTTPServer):
    daemon_threads = True


def start_relay(cfg):
    u = urllib.parse.urlsplit(cfg["server"])
    ctx = ssl.create_default_context(cafile=CA_FILE)
    ctx.check_hostname = False  # pinned to the server's own authority, as for the WebSocket
    secret = base64.urlsafe_b64encode(os.urandom(18)).decode().rstrip("=")
    auth = f"Bearer {cfg['id']}:{cfg['key']}"

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _forward(self):
            prefix = f"/{secret}/"
            if not self.path.startswith(prefix):
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            rest = self.path[len(prefix):]
            headers = {"Authorization": auth}
            for h in ("Content-Type", "Content-Length", "Range", "Accept"):
                if self.headers.get(h):
                    headers[h] = self.headers[h]
            length = int(self.headers.get("Content-Length") or 0)
            conn = http.client.HTTPSConnection(u.hostname, u.port or 443, context=ctx, timeout=600)
            headers_sent = False
            try:
                conn.putrequest(self.command, "/connector/backup/" + rest, skip_accept_encoding=True)
                for k, v in headers.items():
                    conn.putheader(k, v)
                conn.endheaders()
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk:
                        break
                    conn.send(chunk)
                    left -= len(chunk)
                # The server was told the full Content-Length. Closing here is the failure
                # it can see; waiting in getresponse() holds the upload open for the timeout.
                if left > 0:
                    conn.close()
                    return
                r = conn.getresponse()
                self.send_response(r.status)
                body_len = r.getheader("Content-Length")
                for h in ("Content-Type", "Content-Length", "Content-Range"):
                    if r.getheader(h):
                        self.send_header(h, r.getheader(h))
                if body_len is None:
                    data = r.read()
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    headers_sent = True
                    self.wfile.write(data)
                    return
                self.end_headers()
                headers_sent = True
                sent = 0
                need = int(body_len)
                while sent < need:
                    chunk = r.read(min(1 << 20, need - sent))
                    if not chunk:
                        # HEAD has no body even when Content-Length names the entity.
                        if self.command == "HEAD":
                            break
                        self.close_connection = True
                        try:
                            self.connection.close()
                        except OSError:
                            pass
                        return
                    self.wfile.write(chunk)
                    sent += len(chunk)
            except OSError:
                if headers_sent:
                    self.close_connection = True
                    try:
                        self.connection.close()
                    except OSError:
                        pass
                else:
                    try:
                        self.send_response(502)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                    except OSError:
                        pass
            finally:
                conn.close()

        do_GET = do_HEAD = do_POST = do_DELETE = _forward

    server = _Relay(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"rest:http://127.0.0.1:{server.server_address[1]}/{secret}/"


# A restic run lives on a worker thread. SIGTERM is delivered on the main thread, so the
# handler below has to delete the password file itself; _run_restic also catches it when
# that call is on the main thread, and its finally removes the file either way.
_restic_running = False
_restic_proc = None


def _backup_password_dir(sweep):
    runtime = os.path.join(RUNTIME, "omarchy-connector") if os.path.isdir(RUNTIME) else DATA_DIR
    if sweep:
        try:
            names = os.listdir(runtime)
        except OSError:
            names = []
        for name in names:
            if name.startswith("backup-"):
                try:
                    os.unlink(os.path.join(runtime, name))
                except OSError:
                    pass
    return runtime


def _on_connector_stop(signum, frame):
    if _restic_running:
        proc = _restic_proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass
        _backup_password_dir(True)
        raise SystemExit
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


def _restic_env(repo, password):
    runtime = _backup_password_dir(False)
    os.makedirs(runtime, mode=0o700, exist_ok=True)
    pw = os.path.join(runtime, f"backup-{os.urandom(6).hex()}")
    fd = os.open(pw, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(password)
    keep = ("PATH", "HOME", "USER", "LANG", "TMPDIR")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    cache = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "omarchy-connector", "restic")
    env.update(RESTIC_REPOSITORY=repo, RESTIC_PASSWORD_FILE=pw, RESTIC_CACHE_DIR=cache, RESTIC_PROGRESS_FPS="0.5")
    return env, pw


def _run_restic(conn, call_id, args, repo, password, step):
    global _restic_running, _restic_proc
    env, pw = _restic_env(repo, password)
    last = [0.0]
    summary = {}
    errors = []
    previous = None
    _restic_running = True

    def _on_term(signum, frame):
        raise SystemExit

    try:
        # Only the main thread may install a handler. SystemExit is a BaseException, so the
        # broad `except Exception` around a backup does not swallow the stop.
        if threading.current_thread() is threading.main_thread():
            previous = signal.signal(signal.SIGTERM, _on_term)
        p = subprocess.Popen([restic_path()] + args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        _restic_proc = p
        def drain_err():
            for line in p.stderr:
                errors.append(line.strip())
                del errors[:-20]
        err_thread = threading.Thread(target=drain_err, daemon=True)
        err_thread.start()
        for line in p.stdout:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            kind = m.get("message_type")
            if kind == "status" and time.time() - last[0] > 2:
                last[0] = time.time()
                conn.send({"op": "progress", "id": call_id, "percent": m.get("percent_done", 0), "step": step})
            elif kind == "summary":
                summary = m
        code = p.wait()
        # The fatal line is often written as restic exits. Wait until it has been read.
        err_thread.join()
    finally:
        try:
            os.unlink(pw)
        except OSError:
            pass
        proc = _restic_proc
        _restic_proc = None
        _restic_running = False
        if previous is not None:
            signal.signal(signal.SIGTERM, previous)
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass
    # restic: 3 means some files couldn't be read (the rest is saved).
    if code not in (0, 3):
        raise RuntimeError(next((e for e in reversed(errors) if e), f"restic stopped ({code})")[:300])
    return summary, code, errors


def backup_run(conn, call_id, args, cfg):
    password = str(args.get("password", ""))
    if not password or "\n" in password:
        raise RuntimeError("No password for the backup store")
    folders, skipped = [], []
    for rel in args.get("folders") or []:
        # One folder that can't be backed up is skipped and reported; the others still are.
        try:
            full = home_folder(rel)
        except RuntimeError:
            skipped.append(str(rel)[:200])
            continue
        (folders if os.path.isdir(full) else skipped).append(full if os.path.isdir(full) else rel)
    if not folders:
        raise RuntimeError("None of the chosen folders are on this computer")
    restic_path()
    server, repo = start_relay(cfg)
    try:
        host = socket.gethostname() or "computer"
        cache_excludes = ["--exclude-caches", "--exclude", "**/.cache", "--exclude", "**/.Trash-*", "--exclude", "**/node_modules/.cache"]
        summary, code, errors = _run_restic(conn, call_id, ["backup", "--json", "--host", host, "--tag", "computer"] + cache_excludes + folders, repo, password, "Backing up")
    finally:
        server.shutdown()
    return {"added": summary.get("data_added", 0), "files": summary.get("total_files_processed", 0), "skipped": skipped, "unreadable": code == 3}


def backup_restore(conn, call_id, args, cfg):
    password = str(args.get("password", ""))
    snap = str(args.get("snapshot", ""))
    if not re.match(r"^[0-9a-f]{8,64}$", snap) or not password:
        raise RuntimeError("Bad restore")
    home = os.path.realpath(os.path.expanduser("~"))
    target = os.path.join(home, "Restored", time.strftime("%Y-%m-%d %H%M"))
    n = 2
    while os.path.exists(target):
        target = os.path.join(home, "Restored", time.strftime("%Y-%m-%d %H%M") + f" ({n})")
        n += 1
    restic_path()
    os.makedirs(target, mode=0o700)
    try:
        server, repo = start_relay(cfg)
        try:
            # Only what was under the home folder, laid out as it was there (Restored/<date>/Documents…).
            _run_restic(conn, call_id, ["restore", f"{snap}:{home}", "--target", target, "--json"], repo, password, "Restoring")
        finally:
            server.shutdown()
    except BaseException:
        # A restore that failed leaves no empty folder that looks like a finished one.
        try:
            os.rmdir(target)
        except OSError:
            pass
        raise
    return {"folder": target}


BACKUP_ACTIONS = {"backup-folders": lambda conn, cid, args, cfg: backup_folders(args), "backup-run": backup_run, "backup-restore": backup_restore}


# ---------------------------------------------------------------------------------------------
REPORT_INTERVAL = 3
HELLO_INTERVAL = 300


class Connection:
    def __init__(self, cfg):
        self.cfg = cfg
        self.connected_at = None
        self.allowed = cfg.get("abilities", {})
        self.channels = {}
        self._ch_lock = threading.Lock()
        self._ch_token = {}
        self.ws = None
        self.pkg = package_manager()

    def send(self, msg):
        try:
            self.ws.send_text(json.dumps(msg))
        except (OSError, AttributeError):
            pass

    def _ch_state(self):
        # Connection.__new__ tests call handle() without __init__.
        if not hasattr(self, "_ch_lock"):
            self._ch_lock = threading.Lock()
            self._ch_token = {}
        return self._ch_lock, self._ch_token

    def _open_vnc(self, ch):
        token = object()
        lock, tokens = self._ch_state()
        with lock:
            tokens[ch] = token

        def start():
            try:
                obj = Screen(self, ch)
            except Exception as e:  # noqa: BLE001 - said back to the person, in plain words
                self.send({"op": "closed", "ch": ch, "code": 1011, "reason": str(e)[:200]})
                return
            with lock:
                if tokens.get(ch) is not token:
                    drop = True
                else:
                    self.channels[ch] = obj
                    drop = False
            if drop:
                obj.close()

        threading.Thread(target=start, daemon=True).start()

    def _report_step(self, live_sampler, last_hello, now):
        # Push the last snapshot only while someone is reading. Calling metrics()
        # here would count as a read and the sampler would never go idle.
        if live_sampler.active():
            snap = dict(live_sampler.peek())
            snap["updates"] = updates_waiting(self.pkg)
            self.send({"op": "metrics", "metrics": snap})
        # Facts change now and then (plugins, theme, a desktop session starting).
        if now - last_hello >= HELLO_INTERVAL:
            self.send({"op": "hello", "info": info(), "abilities": self.allowed})
            return now
        return last_hello

    def run(self):
        url = self.cfg["server"].replace("https://", "wss://", 1).rstrip("/") + "/connector/ws"
        self.ws = WS(url, {"Authorization": f"Bearer {self.cfg['id']}:{self.cfg['key']}", "User-Agent": f"omarchy-connector/{VERSION}"}, CA_FILE)
        self.connected_at = time.monotonic()
        log("connected to", self.cfg["server"])
        self.send({"op": "hello", "info": info(), "abilities": self.allowed})
        stop = threading.Event()

        global _process_sampler
        if _process_sampler is None:
            _process_sampler = create_sampler()
        live_sampler = _process_sampler
        live_sampler.start()
        self.sampler = live_sampler

        def report():
            last_hello = time.monotonic()
            while not stop.wait(REPORT_INTERVAL):
                last_hello = self._report_step(live_sampler, last_hello, time.monotonic())

        threading.Thread(target=report, daemon=True).start()
        try:
            while True:
                op, data = self.ws.recv()
                if op == 0x2:
                    if len(data) >= 4:
                        ch = self.channels.get(struct.unpack(">I", data[:4])[0])
                        if ch:
                            ch.write(data[4:])
                    continue
                self.handle(json.loads(data))
        finally:
            stop.set()
            live_sampler.stop()
            for ch in list(self.channels.values()):
                ch.close()
            self.channels.clear()
            self.ws.close()

    def handle(self, msg):
        op = msg.get("op")
        if op == "open":
            ch = int(msg.get("ch", 0))
            kind = msg.get("kind")
            ability = "terminal" if kind == "pty" else "desktop" if kind == "vnc" else None
            if not ability or not self.allowed.get(ability):
                return self.send({"op": "closed", "ch": ch, "code": 1011, "reason": f"This computer doesn’t allow the {ability or 'that'}"})
            if kind == "vnc":
                # vnc_start sleeps until the socket exists. That wait used to sit on this thread.
                self._open_vnc(ch)
                return
            try:
                self.channels[ch] = Shell(self, ch, msg.get("cols"), msg.get("rows"))
            except Exception as e:  # noqa: BLE001 - said back to the person, in plain words
                self.send({"op": "closed", "ch": ch, "code": 1011, "reason": str(e)[:200]})
        elif op == "resize":
            # The terminal's window changed size: the shell takes it (the kernel tells the programs
            # in it with SIGWINCH, so full-screen ones redraw). Older servers never send this.
            ch = self.channels.get(int(msg.get("ch", 0)))
            if isinstance(ch, Shell):
                ch.resize(msg.get("cols"), msg.get("rows"))
        elif op == "close":
            ch_id = int(msg.get("ch", 0))
            lock, tokens = self._ch_state()
            with lock:
                existing = self.channels.pop(ch_id, None)
                # An open still running on the VNC thread must not publish into this channel.
                if existing is None:
                    tokens[ch_id] = None
                else:
                    tokens.pop(ch_id, None)
            if existing:
                existing.close()
        elif op == "watch":
            # The server asks while a screen is open. Return the last snapshot now and refresh.
            if getattr(self, "sampler", None) is not None:
                self.send({"op": "metrics", "metrics": metrics(self.pkg, sampler=self.sampler)})
        elif op == "call":
            threading.Thread(target=self.call, args=(msg,), daemon=True).start()
        elif op == "removed":
            log("removed from the server's swarm: stopping for good")
            forget()

    def call(self, msg):
        name = msg.get("name")
        try:
            if name in BACKUP_ACTIONS:
                if not self.allowed.get("backup"):
                    raise RuntimeError("This computer doesn’t allow backups")
                data = BACKUP_ACTIONS[name](self, msg.get("id"), msg.get("args") or {}, self.cfg)
                return self.send({"op": "result", "id": msg.get("id"), "ok": True, "data": data})
            if name in STORAGE_ACTIONS or str(name).startswith("storage-"):
                if not self.allowed.get("storage"):
                    raise RuntimeError("This computer doesn’t allow Storage")
                fn = STORAGE_ACTIONS.get(name)
                if not fn:
                    raise RuntimeError("Unknown action")
                data = fn(msg.get("args") or {})
            else:
                if not self.allowed.get("manage"):
                    raise RuntimeError("This computer doesn’t allow managing")
                fn = ACTIONS.get(name)
                if not fn:
                    raise RuntimeError("Unknown action")
                data = fn(msg.get("args") or {})
            self.send({"op": "result", "id": msg.get("id"), "ok": True, "data": data})
            if name in ("plugin-install", "plugin-remove", "theme-set"):
                self.send({"op": "hello", "info": info(), "abilities": self.allowed})
        except Exception as e:  # noqa: BLE001
            self.send({"op": "result", "id": msg.get("id"), "ok": False, "error": str(e)[:300]})


def forget():
    try:
        os.unlink(CONFIG)
    except OSError:
        pass
    try:
        # --now so systemd stops the unit instead of restarting it (Restart=always) every 5 seconds;
        # --no-block so this process isn't waiting on its own stop.
        subprocess.run(["systemctl", "--user", "disable", "--now", "--no-block", "omarchy-connector.service"], capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        pass  # not run by systemd (or no systemd): stopping is enough
    _backup_password_dir(True)
    os._exit(0)


# ---------------------------------------------------------------------------------------------
USAGE = """Omarchy Server connector: joins this Linux computer to an Omarchy Server's local swarm.

  agent.py                                run the connector (after enrolling)
  agent.py enroll SERVER TOKEN [ABILITIES]
                                          join using a one-time pairing token
  agent.py info                           print machine facts and metrics as JSON
  agent.py -h | --help | help             show this help"""


def enroll(server, token, abilities):
    u = urllib.parse.urlsplit(server)
    if u.scheme != "https" or not u.hostname:
        raise SystemExit("The server address must start with https://")
    body = json.dumps({"token": token, "info": info(), "abilities": abilities}).encode()
    try:
        ctx = ssl.create_default_context(cafile=CA_FILE)
    except FileNotFoundError:
        raise SystemExit(f"Server certificate not found ({CA_FILE}). Run the install command from Machines → Local swarm → Add a computer.")
    except OSError as e:
        raise SystemExit(f"Couldn't read server certificate ({CA_FILE}): {e}")
    ctx.check_hostname = False
    req = urllib.request.Request(server.rstrip("/") + "/connector/enroll", data=body, headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            raise SystemExit(json.load(e).get("error") or f"The server said {e.code}")
        except ValueError:
            raise SystemExit(f"The server said {e.code}")
    except urllib.error.URLError as e:
        raise SystemExit(f"Couldn't reach {server}: {e.reason}")
    except (OSError, ValueError) as e:
        raise SystemExit(f"Couldn't reach {server}: {e}")


def main(argv=None):
    args = sys.argv[1:] if argv is None else list(argv)
    if args in (["-h"], ["--help"], ["help"], ["help", "enroll"], ["help", "info"]):
        print(USAGE)
        return
    if args[:1] == ["enroll"]:
        if "-h" in args[1:] or "--help" in args[1:]:
            print(USAGE)
            return
        # A pairing token is base64url, so it can start with "-". That is still the token.
        if len(args) not in (3, 4) or args[1].startswith("-") or (len(args) == 4 and args[3].startswith("-")):
            print("Use: agent.py enroll SERVER TOKEN [ABILITIES]", file=sys.stderr)
            raise SystemExit(2)
        server, token = args[1], args[2]
        abilities = {k: k in args[3].split(",") for k in ("terminal", "desktop", "manage", "storage", "backup")} if len(args) > 3 else {}
        r = enroll(server, token, abilities)
        os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
        cfg = {"server": server, "id": r["id"], "key": r["key"], "abilities": abilities}
        fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f)
        print(r.get("name", ""))
        return
    if args[:1] == ["info"]:
        if "-h" in args[1:] or "--help" in args[1:]:
            print(USAGE)
            return
        if len(args) != 1:
            print("Use: agent.py info", file=sys.stderr)
            raise SystemExit(2)
        print(json.dumps({"info": info(), "metrics": metrics(package_manager())}, indent=2))
        return
    if args:
        print(f"Unknown option or command: {args[0]}\nUse: agent.py [enroll SERVER TOKEN [ABILITIES] | info | --help]", file=sys.stderr)
        raise SystemExit(2)
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        sys.exit("Not joined to a server yet. Run the install command from Machines → Local swarm → Add a computer.")
    _backup_password_dir(True)
    signal.signal(signal.SIGTERM, _on_connector_stop)
    delay = 2
    while True:
        conn = Connection(cfg)
        try:
            conn.run()
        except Exception as e:  # noqa: BLE001
            if reconnect_action(e) == "forget":
                log("the server refused this computer's key; it was removed from the swarm")
                forget()
            else:
                log("connection:", e)
        # run() only ever ends with an error. If it had been connected a while, start over at 2 s.
        if conn.connected_at and time.monotonic() - conn.connected_at > 30:
            delay = 2
        time.sleep(delay)
        delay = min(60, delay * 2)


if __name__ == "__main__":
    main()
