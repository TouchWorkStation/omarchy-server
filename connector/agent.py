#!/usr/bin/env python3
"""My Own Data Center connector: joins this Linux computer to a My Own Data Center's local swarm.

It dials out to the server (wss://, trusting only that server's own certificate authority), so this
computer opens no ports. It runs as you (a systemd user service, or an Alpine OpenRC service), never as root.

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
  files     read and write files in your home folder, for the clip book. Off unless you allow it
            when pairing. It does not follow a path out of your home folder, and it will not read
            or write this connector’s own configuration or data (its key and certificate).

Standard library only, so it runs on any distribution with Python 3.8+.
"""
import ast
import base64
import bz2
import ctypes
import getpass
import http.client
import http.server
import hashlib
import json
import os
import platform
import re
import select
import shutil
import signal
import socket
import ssl
import stat
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# Windows has no pty, pwd, fcntl or termios: the connector runs there with its own shell and readings.
try:
    import fcntl
    import pty
    import pwd
    import termios
except ImportError:
    fcntl = pty = pwd = termios = None

VERSION = "1"
ABILITY_NAMES = ("terminal", "desktop", "manage", "storage", "backup", "services", "files", "vms")
# A file channel sends this much, then waits until the server has that many chunks. The socket
# read loop stays free to take acks, so a large file cannot stall the terminal or the desktop.
FILE_CHUNK = 64 * 1024
FILE_WINDOW = 4
IS_WINDOWS = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"
if IS_WINDOWS:
    CONFIG_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "omarchy-connector")
else:
    CONFIG_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "omarchy-connector")
CONFIG = os.path.join(CONFIG_DIR, "config.json")
CA_FILE = os.path.join(CONFIG_DIR, "server-ca.crt")
RUNTIME = CONFIG_DIR if IS_WINDOWS or IS_MAC else (os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}")
DATA_DIR = CONFIG_DIR if IS_WINDOWS else os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "omarchy-connector")

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


def _ssl_context(cafile=None):
    ctx = ssl.create_default_context(cafile=cafile or CA_FILE)
    # Trust only this server's own certificate authority (pinned when installing). Its
    # certificate names the server's addresses, which can change, so the name isn't checked:
    # the private authority is what proves it's your server. Python 3.13+ enables
    # VERIFY_X509_STRICT by default, which rejects private CAs without an Authority Key
    # Identifier extension; full cryptographic verification against the pinned CA stays on.
    ctx.check_hostname = False
    strict = getattr(ssl, "VERIFY_X509_STRICT", 0)
    if strict and isinstance(getattr(ctx, "verify_flags", None), int):
        ctx.verify_flags &= ~strict
    return ctx


def _keepalive(sock):
    """Probe a quiet connection every 10 s after 30 s, and drop it after three misses. A server that
    disappears without closing it (power cut, a router that forgot the connection) is then noticed
    in about a minute, not after the system's 15 minute retry limit."""
    try:
        if hasattr(sock, "ioctl") and hasattr(socket, "SIO_KEEPALIVE_VALS"):  # Windows
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 30000, 10000))
            return
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        idle = getattr(socket, "TCP_KEEPIDLE", None) or getattr(socket, "TCP_KEEPALIVE", None)
        # TCP_USER_TIMEOUT (Linux) also covers data that is sent but never acknowledged.
        user_timeout = getattr(socket, "TCP_USER_TIMEOUT", 18 if sys.platform.startswith("linux") else None)
        for option, value in ((idle, 30), (getattr(socket, "TCP_KEEPINTVL", None), 10), (getattr(socket, "TCP_KEEPCNT", None), 3), (user_timeout, 60000)):
            if option is not None:
                sock.setsockopt(socket.IPPROTO_TCP, option, value)
    except (OSError, ValueError):
        pass


# ---------------------------------------------------------------------------------------------
# A small WebSocket client (RFC 6455), enough for this: text and binary frames, ping/pong, close.
class WS:
    def __init__(self, url, headers, cafile):
        u = urllib.parse.urlsplit(url)
        if u.scheme != "wss":
            raise ValueError("The server address must start with https://")
        host, port = u.hostname, u.port or 443
        ctx = _ssl_context(cafile)
        raw = socket.create_connection((host, port), timeout=20)
        _keepalive(raw)
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
    if IS_WINDOWS:
        return {"PRETTY_NAME": f"Windows {platform.release()}".strip(), "NAME": "Windows", "ID": "windows"}
    if IS_MAC:
        return {"PRETTY_NAME": f"macOS {platform.mac_ver()[0]}".strip(), "NAME": "macOS", "ID": "macos"}
    out = {}
    for line in read("/etc/os-release").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k] = v.strip().strip('"')
    return out


def package_manager():
    if IS_WINDOWS:
        return "winget" if shutil.which("winget") else ""
    if IS_MAC:
        return "brew" if shutil.which("brew") else "softwareupdate"
    for name in ("apt", "dnf", "pacman", "zypper"):
        if shutil.which(name if name != "apt" else "apt-get"):
            return name
    return ""


def update_command(pkg, omarchy):
    if omarchy:
        return "omarchy update"
    return {"apt": "sudo apt update && sudo apt upgrade", "dnf": "sudo dnf upgrade --refresh", "pacman": "sudo pacman -Syu", "zypper": "sudo zypper update", "winget": "winget upgrade --all", "brew": "softwareupdate -l && brew upgrade", "softwareupdate": "softwareupdate -l"}.get(pkg, "")


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


def _file_sha256(path):
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return ""


def lan_macs(list_dir=os.listdir, read_file=read, root="/sys/class/net"):
    """Non-virtual network adapter MAC addresses for Wake-on-LAN."""
    if IS_WINDOWS and list_dir is os.listdir and read_file is read:
        return _windows_macs()
    if IS_MAC and list_dir is os.listdir and read_file is read:
        return _mac_macs()
    try:
        names = sorted(list_dir(root))
    except OSError:
        return []
    skip_prefix = ("docker", "podman", "veth", "virbr", "br-", "cni", "tailscale", "wg", "tun", "tap")
    seen, out = set(), []
    for name in names:
        if name == "lo" or name.startswith(skip_prefix):
            continue
        mac = read_file(os.path.join(root, name, "address")).strip().lower()
        if not re.fullmatch(r"[0-9a-f]{2}(:[0-9a-f]{2}){5}", mac) or mac == "00:00:00:00:00:00":
            continue
        if mac not in seen:
            seen.add(mac)
            out.append(mac)
    return out[:8]


_VIRTUAL_NIC = re.compile(r"^(lo|docker|podman|veth|virbr|br-|cni|tailscale|wg|tun|tap|dummy|flannel|cali|kube|zt)")


def _mac(raw):
    hexm = re.sub(r"[^0-9a-fA-F]", "", raw or "").lower()
    if len(hexm) != 12 or hexm in ("000000000000", "ffffffffffff"):
        return ""
    return ":".join(hexm[i : i + 2] for i in range(0, 12, 2))


def _broadcast(ip, prefix):
    if prefix is None or prefix >= 31 or prefix < 0:
        return None
    parts = str(ip).split(".")
    if len(parts) != 4:
        return None
    try:
        n = (int(parts[0]) << 24) | (int(parts[1]) << 16) | (int(parts[2]) << 8) | int(parts[3])
    except ValueError:
        return None
    mask = (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF
    b = (n & mask) | (~mask & 0xFFFFFFFF)
    return ".".join(str((b >> s) & 255) for s in (24, 16, 8, 0))


def _physical(name, list_dir):
    if not name or _VIRTUAL_NIC.match(name):
        return False
    try:
        entries = set(list_dir(f"/sys/class/net/{name}"))
    except OSError:
        return False
    if "bridge" in entries:
        return False
    return "device" in entries or "wireless" in entries or "phy80211" in entries


def collect_nics(list_dir=None, read_file=None, ip_json=None):
    list_dir = list_dir or os.listdir
    read_file = read_file or read
    if ip_json is None:
        try:
            ip_json = subprocess.run(["ip", "-4", "-json", "addr"], capture_output=True, text=True, timeout=3).stdout or "[]"
        except (OSError, subprocess.SubprocessError):
            ip_json = "[]"
    addrs = {}
    try:
        parsed = json.loads(ip_json or "[]")
    except ValueError:
        parsed = []
    for iface in parsed:
        for a in iface.get("addr_info") or []:
            if a.get("family") == "inet" and a.get("local") is not None and a.get("prefixlen") is not None:
                addrs.setdefault(iface.get("ifname"), []).append((a["local"], int(a["prefixlen"])))
    out = []
    try:
        names = list_dir("/sys/class/net")
    except OSError:
        names = []
    for name in names:
        if not _physical(name, list_dir):
            continue
        mac = _mac(read_file(f"/sys/class/net/{name}/address"))
        if not mac:
            continue
        broadcasts = [b for ip, prefix in addrs.get(name, []) if (b := _broadcast(ip, prefix))]
        out.append({"name": name, "mac": mac, "broadcasts": broadcasts})
    return out


def magic_packet(mac):
    hexm = re.sub(r"[^0-9a-fA-F]", "", mac or "")
    if len(hexm) != 12:
        return None
    raw = bytes.fromhex(hexm)
    return b"\xff" * 6 + raw * 16


def send_wol(macs, nics, send):
    targets = []
    for n in nics or []:
        targets.extend(n.get("broadcasts") or [])
    if not targets:
        targets = ["255.255.255.255"]
    seen = []
    for dest in targets:
        if dest not in seen:
            seen.append(dest)
    sent = 0
    for mac in macs or []:
        packet = magic_packet(mac)
        if not packet:
            continue
        for dest in seen:
            send(packet, (dest, 9))
            sent += 1
    return sent


def _udp_send(packet, dest):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.sendto(packet, dest)
    finally:
        sock.close()


def wol_action(args, collect=None, send=None):
    macs = [m for m in (args.get("macs") or []) if _mac(m)]
    nics = (collect or collect_nics)()
    sent = send_wol(macs, nics, send or _udp_send)
    if not sent:
        raise RuntimeError("No wake packet sent")
    return {"sent": sent}


# ---- Windows readings (by kdegeek, #868): Win32 calls through ctypes, standard library only. ----
_WIN_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_win_cpu_last = None


def _windows_macs():
    try:
        out = subprocess.run(["getmac", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=5, creationflags=_WIN_NO_WINDOW).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    seen, macs = set(), []
    for line in out.splitlines():
        m = re.search(r"([0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5})", line)
        if not m:
            continue
        mac = m.group(1).replace("-", ":").lower()
        if mac != "00:00:00:00:00:00" and mac not in seen:
            seen.add(mac)
            macs.append(mac)
    return macs[:8]


def _windows_meminfo():
    class _MemStatus(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    try:
        st = _MemStatus()
        st.dwLength = ctypes.sizeof(_MemStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            total, ptotal = int(st.ullTotalPhys), int(st.ullTotalPageFile)
            return {"total": total, "used": max(0, total - int(st.ullAvailPhys))}, {"total": ptotal, "used": max(0, ptotal - int(st.ullAvailPageFile))}
    except Exception:  # noqa: BLE001 - not on Windows, or the call failed
        pass
    return {"total": 0, "used": 0}, {"total": 0, "used": 0}


def _windows_disks():
    rows = []
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        root = f"{letter}:\\"
        if not os.path.exists(root):
            continue
        try:
            u = shutil.disk_usage(root)
            if u.total > 0:
                rows.append({"mount": f"{letter}:", "total": int(u.total), "used": int(u.used)})
        except OSError:
            continue
    return rows[:12]


def _windows_uptime():
    try:
        ctypes.windll.kernel32.GetTickCount64.restype = ctypes.c_ulonglong
        return float(ctypes.windll.kernel32.GetTickCount64()) / 1000.0
    except Exception:  # noqa: BLE001
        return 0.0


def _windows_cpu_percent():
    global _win_cpu_last

    class _FileTime(ctypes.Structure):
        _fields_ = [("dwLowDateTime", ctypes.c_ulong), ("dwHighDateTime", ctypes.c_ulong)]

    try:
        idle_t, kern_t, user_t = _FileTime(), _FileTime(), _FileTime()
        if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle_t), ctypes.byref(kern_t), ctypes.byref(user_t)):
            return None

        def to_int(ft):
            return (ft.dwHighDateTime << 32) | ft.dwLowDateTime

        idle, total = to_int(idle_t), to_int(kern_t) + to_int(user_t)
        prev, _win_cpu_last = _win_cpu_last, (idle, total)
        if not prev or total <= prev[1]:
            return None
        return round(max(0.0, min(100.0, 100.0 * (1.0 - (idle - prev[0]) / (total - prev[1])))), 1)
    except Exception:  # noqa: BLE001
        return None


# ---- macOS: the same readings, from sysctl, vm_stat and the Mach host statistics. ------------
_mac_cpu_last = None


def _mac_out(cmd, timeout=5):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _mac_sysctl(name):
    return _mac_out(["sysctl", "-n", name]).strip()


def _mac_macs(out=None):
    out = _mac_out(["ifconfig"]) if out is None else out
    seen, macs, name = set(), [], ""
    for line in out.splitlines():
        if line and not line[0].isspace():
            name = line.split(":", 1)[0]
            continue
        m = re.match(r"\s+ether ([0-9a-f]{2}(?::[0-9a-f]{2}){5})", line)
        # en* are the real adapters; bridges, VPN and AirDrop (awdl) can't wake the Mac.
        if m and name.startswith("en") and m.group(1) not in seen and m.group(1) != "00:00:00:00:00:00":
            seen.add(m.group(1))
            macs.append(m.group(1))
    return macs[:8]


def _mac_meminfo(vm_stat=None, memsize=None, swap=None):
    try:
        total = int(memsize if memsize is not None else _mac_sysctl("hw.memsize") or 0)
        text = _mac_out(["vm_stat"]) if vm_stat is None else vm_stat
        page = int((re.search(r"page size of (\d+)", text) or [0, 4096])[1])
        pages = {k.strip().lower(): int(v.strip().rstrip(".")) for k, v in re.findall(r"^\"?([A-Za-z -]+)\"?:\s+(\d+)\.?$", text, re.M)}
        # What Activity Monitor calls Memory Used: app memory (active), wired, and compressed.
        used_pages = pages.get("pages active", 0) + pages.get("pages wired down", 0) + pages.get("pages occupied by compressor", 0)
        mem = {"total": total, "used": min(total, used_pages * page) if total else 0}
        sw = _mac_sysctl("vm.swapusage") if swap is None else swap
        unit = {"K": 1024, "M": 1024**2, "G": 1024**3}

        def size(key):
            m = re.search(key + r" = ([\d.]+)([KMG])", sw)
            return int(float(m.group(1)) * unit[m.group(2)]) if m else 0

        return mem, {"total": size("total"), "used": size("used")}
    except (ValueError, TypeError):
        return {"total": 0, "used": 0}, {"total": 0, "used": 0}


def _mac_disks():
    rows, seen = [], set()
    # Everything you save is on the Data volume; "/" is the sealed, read-only system.
    roots = [("/", "/System/Volumes/Data" if os.path.isdir("/System/Volumes/Data") else "/")]
    try:
        roots += [(os.path.join("/Volumes", n), os.path.join("/Volumes", n)) for n in sorted(os.listdir("/Volumes"))]
    except OSError:
        pass
    for mount, path in roots:
        try:
            st = os.stat(path)
            u = shutil.disk_usage(path)
        except OSError:
            continue
        if st.st_dev in seen or u.total <= 0 or (mount != "/" and os.path.realpath(path) == "/"):
            continue
        seen.add(st.st_dev)
        rows.append({"mount": mount, "total": int(u.total), "used": int(u.used)})
    return rows[:12]


def _mac_uptime(boot=None):
    boot = _mac_sysctl("kern.boottime") if boot is None else boot
    m = re.search(r"sec = (\d+)", boot)
    return max(0.0, time.time() - int(m.group(1))) if m else 0.0


def _mac_cpu_ticks():
    """(user, system, idle, nice) ticks since boot, from host_statistics(HOST_CPU_LOAD_INFO)."""
    try:
        libc = ctypes.CDLL("/usr/lib/libSystem.dylib")
        libc.mach_host_self.restype = ctypes.c_uint
        ticks = (ctypes.c_uint * 4)()
        count = ctypes.c_uint(4)
        if libc.host_statistics(libc.mach_host_self(), 3, ctypes.byref(ticks), ctypes.byref(count)) != 0:
            return None
        return tuple(int(t) for t in ticks)
    except (OSError, AttributeError):
        return None


def _mac_cpu_percent(ticks=None):
    global _mac_cpu_last
    t = _mac_cpu_ticks() if ticks is None else ticks
    if not t:
        return None
    idle, total = t[2], sum(t)
    prev, _mac_cpu_last = _mac_cpu_last, (idle, total)
    if not prev or total <= prev[1]:
        return None
    return round(max(0.0, min(100.0, 100.0 * (1.0 - (idle - prev[0]) / (total - prev[1])))), 1)


def _mac_batteries(out=None):
    out = _mac_out(["pmset", "-g", "batt"]) if out is None else out
    rows = []
    for m in re.finditer(r"(\d+)%;\s*([a-zA-Z ]+?);\s*(?:(\d+):(\d+) remaining)?", out):
        state = m.group(2).strip().lower()
        status = {"charging": "charging", "discharging": "discharging", "charged": "full", "finishing charge": "charging", "ac attached": "not-charging"}.get(state, "unknown")
        secs = int(m.group(3)) * 3600 + int(m.group(4)) * 60 if m.group(3) else None
        rows.append({"id": f"battery{len(rows)}", "index": len(rows), "name": "Battery", "percent": min(100, int(m.group(1))), "status": status, "secondsRemaining": secs, "power": None, "energyNow": None, "energyFull": None})
    return rows[:2]


def _user_name():
    if pwd is not None:
        return pwd.getpwuid(os.getuid()).pw_name
    try:
        return getpass.getuser()
    except (OSError, ImportError, KeyError):
        return os.environ.get("USERNAME", "")


def _listening_ports(read_file=read):
    """Non-loopback TCP listening ports from /proc/net/tcp{,6} (zero root, stdlib only)."""
    seen, out = set(), []
    for path, proto in (("/proc/net/tcp", "tcp"), ("/proc/net/tcp6", "tcp6")):
        raw = read_file(path)
        for line in (raw or "").splitlines()[1:]:
            parts = line.split()
            if len(parts) < 4 or parts[3] != "0A":  # 0A = TCP_LISTEN
                continue
            local = parts[1]
            if ":" not in local:
                continue
            hex_ip, hex_port = local.split(":", 1)
            try:
                port = int(hex_port, 16)
            except ValueError:
                continue
            if port <= 0 or port > 65535:
                continue
            if proto == "tcp":
                if hex_ip.endswith("7F"):  # 127.x.x.x in little-endian hex
                    continue
                addr = "0.0.0.0" if hex_ip == "00000000" else "lan"
            else:
                if hex_ip == "00000000000000000000000001000000" or hex_ip == "0000000000000000FFFF00000100007F":
                    continue
                addr = "::" if hex_ip == "0" * 32 else "lan"
            key = (port, proto, addr)
            if key not in seen:
                seen.add(key)
                out.append({"port": port, "proto": proto, "addr": addr})
    out.sort(key=lambda x: (x["port"], x["proto"]))
    return out[:50]


def _reboot_required(read_file=read, list_dir=os.listdir, exists=os.path.exists, kernel=None):
    """Detect whether a kernel/system update requires a reboot (Debian/Ubuntu/Arch/Omarchy)."""
    if exists("/var/run/reboot-required"):
        return True, "System updates require a restart"
    rel = kernel if kernel is not None else os.uname().release
    if rel and exists("/usr/lib/modules"):
        try:
            mods = list_dir("/usr/lib/modules")
        except OSError:
            mods = []
        if mods and rel not in mods:
            return True, f"Kernel updated (running {rel})"
    return False, ""


_failed_units_cache = {"at": 0.0, "count": 0}


def host_posture(read_file=read, list_dir=os.listdir, exists=os.path.exists, kernel=None):
    reboot_needed, reboot_reason = _reboot_required(read_file=read_file, list_dir=list_dir, exists=exists, kernel=kernel)
    failed = 0
    if shutil.which("systemctl") and read_file is read:
        now_m = time.monotonic()
        if now_m - _failed_units_cache["at"] >= 60.0 or _failed_units_cache["at"] == 0.0:
            try:
                r = subprocess.run(["systemctl", "--system", "list-units", "--type=service", "--state=failed", "--no-pager", "--no-legend", "--plain"], capture_output=True, text=True, timeout=2)
                _failed_units_cache["count"] = len(_parse_systemd_units(r.stdout, "system"))
            except (OSError, subprocess.SubprocessError):
                pass
            _failed_units_cache["at"] = now_m
        failed = _failed_units_cache["count"]
    return {
        "rebootRequired": reboot_needed,
        "rebootReason": reboot_reason,
        "securityUpdates": _updates.get("sec"),
        "listeningPorts": _listening_ports(read_file=read_file),
        "failedUnits": failed,
    }


def info(abilities=None, environment=None):
    rel = os_release()
    pkg = package_manager()
    om = omarchy_facts()
    env = environment if environment is not None else ("lxc" if in_lxc() else "")
    out = {
        "hostname": socket.gethostname(),
        "os": rel.get("PRETTY_NAME") or rel.get("NAME") or "Linux",
        "osId": rel.get("ID", ""),
        "kernel": os.uname().release if hasattr(os, "uname") else platform.release(),
        "arch": os.uname().machine if hasattr(os, "uname") else platform.machine(),
        "user": _user_name(),
        "version": VERSION,
        "agentSha": _file_sha256(__file__),
        "helperSha": _file_sha256(HELPER),
        "macs": lan_macs(),
        "nics": [n["mac"] for n in collect_nics()],
        "posture": host_posture(),
        "pkg": pkg,
        "updateCommand": update_command(pkg, om.get("omarchy")),
        "desktop": desktop_kind(),
        **om,
        "libvirt": _info_libvirt(abilities),
    }
    if env:
        out["environment"] = env
    return out


_cpu_last = None


def cpu_percent():
    global _cpu_last
    if IS_WINDOWS:
        return _windows_cpu_percent()
    if IS_MAC:
        return _mac_cpu_percent()
    parts = read("/proc/stat").split("\n", 1)[0].split()[1:]
    vals = [int(x) for x in parts] if parts else []
    if len(vals) < 4:
        return None
    # guest and guest_nice (the 9th and 10th values) are already counted in user and nice.
    idle, total = vals[3] + (vals[4] if len(vals) > 4 else 0), sum(vals[:8])
    last, _cpu_last = _cpu_last, (idle, total)
    if not last or total == last[1]:
        return None
    # iowait is part of idle and may go down between two samples, which would push the result past 100.
    return round(max(0.0, min(100.0, 100 * (1 - (idle - last[0]) / (total - last[1])))), 1)


def meminfo():
    if IS_WINDOWS:
        return _windows_meminfo()
    if IS_MAC:
        return _mac_meminfo()
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
    if IS_WINDOWS:
        return _windows_disks()
    if IS_MAC:
        return _mac_disks()
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
    if IS_MAC and list_dir is os.listdir and read_file is read:
        return _mac_batteries()
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
        out = run("nvidia-smi", ["--query-gpu=index,name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"])
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
        mem_used = _num(parts[4]) if len(parts) > 4 else None
        mem_total = _num(parts[5]) if len(parts) > 5 else None
        temp = _num(parts[6]) if len(parts) > 6 else None
        power = _num(parts[7]) if len(parts) > 7 else None
        row = {"id": parts[2] or f"nvidia-{int(index)}", "index": int(index), "name": name, "used": None if used is None else int(round(used))}
        if mem_used is not None:
            row["vramUsed"] = int(round(mem_used * 1024 * 1024))
        if mem_total is not None:
            row["vramTotal"] = int(round(mem_total * 1024 * 1024))
        if temp is not None:
            row["temp"] = round(temp, 1)
        if power is not None:
            row["power"] = round(power, 1)
        gpus.append(row)
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
        row = {"id": f"drm-{card}", "index": int(card[4:]), "name": name, "used": None if used is None else int(round(used))}
        if vendor == _VENDOR_AMD:
            vused = _num(read_file(f"/sys/class/drm/{card}/device/mem_info_vram_used"))
            vtot = _num(read_file(f"/sys/class/drm/{card}/device/mem_info_vram_total"))
            if vused is not None:
                row["vramUsed"] = int(round(vused))
            if vtot is not None:
                row["vramTotal"] = int(round(vtot))
            try:
                hwmons = sorted(list_dir(f"/sys/class/drm/{card}/device/hwmon"))
            except OSError:
                hwmons = []
            for hm in hwmons:
                t_raw = _num(read_file(f"/sys/class/drm/{card}/device/hwmon/{hm}/temp1_input"))
                if t_raw is not None and "temp" not in row:
                    row["temp"] = round(t_raw / 1000.0, 1)
                p_raw = _num(read_file(f"/sys/class/drm/{card}/device/hwmon/{hm}/power1_average"))
                if p_raw is not None and "power" not in row:
                    row["power"] = round(p_raw / 1e6, 1)
        gpus.append(row)
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


_updates = {"at": 0, "n": None, "sec": None, "busy": False}


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
            rows = [l for l in r.stdout.splitlines() if l.strip() and not l.startswith(("Listing", "Last metadata", "S |", "--+", "Loading", "Repository", "Obsoleting"))]
            _updates["n"] = len(rows)
            if pkg == "apt":
                _updates["sec"] = sum(1 for l in rows if re.search(r"(^|[-/,])security(\s|,|$)", l, re.IGNORECASE))
            elif pkg == "dnf":
                sec_r = subprocess.run(["dnf", "-q", "check-update", "--security"], capture_output=True, text=True, timeout=120, env=dict(os.environ, LC_ALL="C", LANG="C"))
                _updates["sec"] = len([l for l in sec_r.stdout.splitlines() if l.strip() and not l.startswith(("Last metadata", "Obsoleting"))])
            else:
                _updates["sec"] = None
    except (OSError, subprocess.SubprocessError):
        _updates["n"] = None
        _updates["sec"] = None
    finally:
        _updates["busy"] = False


_net_last = None


def net_io(read_file=read, now=time.monotonic):
    """Aggregate bytes/sec across non-virtual interfaces from /proc/net/dev."""
    global _net_last
    raw = read_file("/proc/net/dev")
    if not raw:
        return None
    skip_prefix = ("docker", "podman", "veth", "virbr", "br-", "cni")
    rx_total, tx_total, found = 0, 0, False
    for line in raw.splitlines()[2:]:
        if ":" not in line:
            continue
        iface, rest = line.split(":", 1)
        iface = iface.strip()
        if iface == "lo" or iface.startswith(skip_prefix):
            continue
        cols = rest.split()
        if len(cols) < 9:
            continue
        try:
            rx_total += int(cols[0])
            tx_total += int(cols[8])
            found = True
        except ValueError:
            continue
    if not found:
        return None
    t = now()
    prev, _net_last = _net_last, (t, rx_total, tx_total)
    if not prev or t <= prev[0]:
        return {"rx": 0, "tx": 0}
    dt = t - prev[0]
    return {"rx": max(0, int(round((rx_total - prev[1]) / dt))), "tx": max(0, int(round((tx_total - prev[2]) / dt)))}


DEFAULT_INTERVALS = {
    "cpu": 1,
    "memory": 1,
    "gpu": 1,
    "net": 2,
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
        "net": None,
        "temp": None,
        "uptime": 0,
        "updates": None,
    }


def default_reads():
    return {
        "cpu": cpu_percent,
        "memory": meminfo,
        "gpu": gpus,
        "net": net_io,
        "temp": temperature,
        "battery": batteries,
        "disk": disks,
        "uptime": _windows_uptime if IS_WINDOWS else _mac_uptime if IS_MAC else (lambda: float(read("/proc/uptime", "0").split()[0] or 0)),
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
        self._take("cpu", lambda v: self._snap.update(cpu=v, cores=os.cpu_count(), load=list(os.getloadavg()) if hasattr(os, "getloadavg") else []), t)
        def mem(v):
            if isinstance(v, tuple):
                self._snap["mem"], self._snap["swap"] = v
            else:
                self._snap["mem"] = v
        self._take("memory", mem, t)
        self._take("net", lambda v: self._snap.update(net=v), t)
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
def _live_hypr():
    """The running Hyprland: (signature, its Wayland socket or None). Folders left by an earlier
    session (a restart, a crash) are skipped: Hyprland's lock file names its process, which must be
    alive, and the Wayland socket it made."""
    d = os.path.join(RUNTIME, "hypr")
    try:
        sigs = sorted(os.listdir(d), key=lambda x: os.path.getmtime(os.path.join(d, x)), reverse=True)
    except OSError:
        return None, None
    fallback = None
    for sig in sigs:
        try:
            with open(os.path.join(d, sig, "hyprland.lock"), encoding="utf-8", errors="replace") as f:
                words = f.read().split()
        except OSError:
            # An older Hyprland without the lock file: the newest folder, as before.
            fallback = fallback or sig
            continue
        pid = int(words[0]) if words and words[0].isdigit() else 0
        if pid and not os.path.exists(f"/proc/{pid}"):
            continue
        wl = next((w for w in words[1:] if re.fullmatch(r"wayland-\d+", w)), None)
        return sig, wl
    return fallback, None


def _hypr_signature():
    return _live_hypr()[0]


def _wayland_display():
    """The live session's Wayland socket: the one Hyprland says it made, else the newest one that
    still has its lock (an old wayland-0 left behind isn't picked just for sorting first)."""
    if not os.path.isdir(RUNTIME):
        return None
    _sig, wl = _live_hypr()
    if wl and os.path.exists(os.path.join(RUNTIME, wl)):
        return wl
    socks = [f for f in os.listdir(RUNTIME) if re.fullmatch(r"wayland-\d+", f)]
    locked = [f for f in socks if os.path.exists(os.path.join(RUNTIME, f + ".lock"))] or socks

    def newest(f):
        try:
            return os.path.getmtime(os.path.join(RUNTIME, f))
        except OSError:
            return 0

    return max(locked, key=newest) if locked else None


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
    if IS_WINDOWS:
        return {"kind": "none", "ok": False, "why": "Sharing a Windows computer’s screen isn’t available yet."}
    if IS_MAC:
        return {"kind": "none", "ok": False, "why": "Sharing a Mac’s screen isn’t available yet."}
    wl = _wayland_display()
    wlroots = _hypr_signature() or any(f.startswith("sway-ipc.") for f in (os.listdir(RUNTIME) if os.path.isdir(RUNTIME) else []))
    if wl and wlroots:
        return {"kind": "wlroots", "ok": bool(shutil.which("wayvnc")), "why": "" if shutil.which("wayvnc") else "Screen sharing (wayvnc) isn’t installed on this computer."}
    if wl:
        return {"kind": "wayland", "ok": False, "why": "This desktop (GNOME or KDE on Wayland) can’t be shared yet. Sign in with an X11 session, or use Hyprland or Sway."}
    if _x_display():
        return {"kind": "x11", "ok": bool(shutil.which("x11vnc")), "why": "" if shutil.which("x11vnc") else "Screen sharing (x11vnc) isn’t installed on this computer."}
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
            # Its own control socket (-S): wayvnc won't start while another one holds the default,
            # and MODC's own desktop sharing (or the person's) may be running on this desktop too.
            cmd = ["wayvnc", "--max-fps=30", "-S", os.path.join(os.path.dirname(VNC_SOCK), "wayvncctl"), "--unix-socket", VNC_SOCK]
        else:
            env["DISPLAY"] = _x_display()
            auth = _xauthority()
            cmd = ["x11vnc", "-display", env["DISPLAY"], "-unixsock", VNC_SOCK, "-rfbport", "0", "-forever", "-shared", "-nopw", "-quiet", "-noxdamage"]
            if auth:
                cmd[3:3] = ["-auth", auth]
        # What it says when it fails is kept (a small file), so the person reads why.
        errlog = os.path.join(os.path.dirname(VNC_SOCK), "screen-sharing.log")
        with open(errlog, "wb") as err:
            _vnc["proc"] = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=err, start_new_session=True)
        for _ in range(50):
            if os.path.exists(VNC_SOCK):
                break
            if _vnc["proc"].poll() is not None:
                _vnc["proc"] = None
                said = _last_error_line(errlog)
                raise RuntimeError(f"The screen sharing program ({cmd[0]}) stopped straight away" + (f": {said}" if said else "."))
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


def _last_error_line(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 4096))
            lines = [l.strip() for l in f.read().decode("utf-8", "replace").splitlines() if l.strip()]
    except OSError:
        return ""
    # wayvnc ends with a hint ("Use the '-S' option…"); the line before says what went wrong.
    for line in reversed(lines):
        if "error" in line.lower() or "failed" in line.lower() or "another" in line.lower():
            return re.sub(r"^.*?(?:ERROR|Error|error):?\s*", "", line)[:160]
    return lines[-1][:160] if lines else ""


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


SHELL_SCROLLBACK_MAX = 256 * 1024
MAX_SHELL_SESSIONS = 6
SESSION_NAME = re.compile(r"^[A-Za-z0-9._-]{1,40}$")


def _trim_scrollback(buf, limit=SHELL_SCROLLBACK_MAX):
    """Keep at most `limit` bytes without cutting inside a UTF-8 sequence."""
    if len(buf) <= limit:
        return
    del buf[: len(buf) - limit]
    i = 0
    while i < len(buf) and (buf[i] & 0xC0) == 0x80:
        i += 1
    if i:
        del buf[:i]


# ---- tmux: shells that outlive the connector (restarts, self-updates) ----
# Its own server (-L omarchy) and settings, so the computer's own tmux setup is untouched.
TMUX_CONF = """# My Own Data Center's terminal sessions. Written by the connector; changes here are replaced.
set -g status off
set -g history-limit 50000
set -g default-terminal "screen-256color"
set -s escape-time 0
set -g mouse off
set -g set-clipboard on
set -g window-size latest
set -g aggressive-resize on
set -ga terminal-overrides ',xterm*:smcup@:rmcup@'
"""
TMUX_SOCKET = os.environ.get("OMARCHY_CONNECTOR_TMUX_SOCKET") or "omarchy"
_tmux_ready = None


def _tmux_base():
    return ["tmux", "-L", TMUX_SOCKET, "-f", os.path.join(CONFIG_DIR, "tmux.conf")]


def _tmux_run(args, timeout=10):
    try:
        return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def tmux_available():
    global _tmux_ready
    if _tmux_ready is None:
        if os.environ.get("OMARCHY_CONNECTOR_NO_TMUX") or not shutil.which("tmux"):
            _tmux_ready = False
        else:
            try:
                os.makedirs(CONFIG_DIR, exist_ok=True)
                with open(os.path.join(CONFIG_DIR, "tmux.conf"), "w", encoding="utf-8") as f:
                    f.write(TMUX_CONF)
            except OSError:
                pass
            _tmux_ready = True
    return _tmux_ready


def tmux_has(name):
    return tmux_available() and _tmux_run(_tmux_base() + ["has-session", "-t", f"={name}"])


def tmux_attach_argv(name, cols, rows):
    """The argv that attaches to tmux session `name`, starting it (outside the connector's service) if needed; None without tmux."""
    if not SESSION_NAME.match(name or "") or not tmux_available():
        return None
    if not tmux_has(name):
        create = _tmux_base() + ["new-session", "-d", "-s", name, "-x", str(cols), "-y", str(rows)]
        # Its own scope, so restarting or updating the connector doesn't stop it.
        scoped = shutil.which("systemd-run") and _tmux_run(["systemd-run", "--user", "--scope", "--quiet", "--collect", "--"] + create, 20)
        if not scoped and not tmux_has(name) and not _tmux_run(create):
            return None
    return _tmux_base() + ["attach-session", "-t", f"={name}"]


def tmux_kill(name):
    if SESSION_NAME.match(name or "") and tmux_available():
        _tmux_run(_tmux_base() + ["kill-session", "-t", f"={name}"])


class ShellSession:
    """A persistent PTY session that survives browser disconnect and replays scrollback on reattach.
    With tmux installed the shell itself runs in a tmux session, so it also survives the connector
    restarting or updating; this PTY is then just attached to it."""

    def __init__(self, name, cols, rows, argv=None):
        self.name = name
        self.tmux = bool(argv)
        self.alive = True
        self.cols = min(500, max(10, int(cols or 80)))
        self.rows = min(300, max(4, int(rows or 24)))
        self.scrollback = bytearray()
        self._lock = threading.Lock()
        self.attached = None
        me = pwd.getpwuid(os.getuid())
        shell = me.pw_shell if me.pw_shell and os.path.exists(me.pw_shell) else "/bin/bash"
        pid, fd = pty.fork()
        if pid == 0:
            try:
                signal.signal(signal.SIGPIPE, signal.SIG_DFL)
                signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
                os.chdir(me.pw_dir)
                env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", HOME=me.pw_dir, SHELL=shell, USER=me.pw_name, LANG=os.environ.get("LANG") or "C.UTF-8")
                if argv:
                    os.execvpe(argv[0], argv, env)
                os.execvpe(shell, [shell, "-l"], env)
            except BaseException:  # noqa: BLE001
                pass
            os._exit(127)
        self.pid, self.fd = pid, fd
        flags = fcntl.fcntl(self.fd, fcntl.F_GETFL)
        fcntl.fcntl(self.fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        self._pending = bytearray()
        self._write_cv = threading.Condition()
        self.resize(self.cols, self.rows)
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._write_loop, daemon=True).start()

    def resize(self, cols, rows):
        try:
            c = min(500, max(10, int(cols or 80)))
            r = min(300, max(4, int(rows or 24)))
            self.cols, self.rows = c, r
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        except (OSError, ValueError, TypeError):
            pass

    def attach(self, channel, cols, rows, resumed):
        with self._lock:
            prev = self.attached
            self.attached = channel
            replay = bytes(self.scrollback)
            cur_cols, cur_rows = self.cols, self.rows
        if prev is not None and prev is not channel:
            prev.closed = True
            prev.conn.send({"op": "closed", "ch": prev.ch, "reason": "Opened elsewhere", "code": 1000})
        channel.conn.send({"op": "attached", "ch": channel.ch, "session": self.name, "resumed": bool(resumed), "cols": cur_cols, "rows": cur_rows})
        if replay:
            channel.out(replay)
        self.resize(cols, rows)

    def detach(self, channel):
        with self._lock:
            if self.attached is channel:
                self.attached = None

    def write(self, data):
        if not data or not self.alive:
            return False
        overflow = False
        with self._write_cv:
            if self.alive:
                if len(self._pending) + len(data) > SHELL_IN_MAX:
                    overflow = True
                else:
                    self._pending += data
                    self._write_cv.notify()
        if overflow:
            self.kill("The terminal stopped reading", end_shell=False)
            return False
        return True

    def _pump(self):
        try:
            while self.alive:
                try:
                    r, _, _ = select.select([self.fd], [], [], 1)
                    if r:
                        data = os.read(self.fd, 65536)
                        if not data:
                            break
                        with self._lock:
                            self.scrollback += data
                            _trim_scrollback(self.scrollback)
                            target = self.attached
                        if target is not None and not target.closed:
                            target.out(data)
                except BlockingIOError:
                    continue
                except OSError:
                    break
            self._finish("Shell ended")
        finally:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self._reap()

    def _write_loop(self):
        while self.alive:
            with self._write_cv:
                if not self._pending and self.alive:
                    self._write_cv.wait(0.2)
                if not self.alive or not self._pending:
                    continue
                data = bytes(self._pending)
            try:
                n = os.write(self.fd, data)
            except BlockingIOError:
                try:
                    select.select([], [self.fd], [], 0.2)
                except (OSError, ValueError):
                    self._finish("Shell ended")
                    return
                continue
            except OSError:
                self._finish("Shell ended")
                return
            if n:
                with self._write_cv:
                    del self._pending[:n]

    def _finish(self, reason):
        with self._lock:
            if not self.alive:
                return
            self.alive = False
            target = self.attached
            self.attached = None
        with self._write_cv:
            self._write_cv.notify_all()
        with _shell_sessions_lock:
            if _shell_sessions.get(self.name) is self:
                _shell_sessions.pop(self.name, None)
        if target is not None and not target.closed:
            target.closed = True
            target.conn.send({"op": "closed", "ch": target.ch, "reason": reason, "code": 1000})

    def _reap(self):
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

    def kill(self, reason="Shell ended", end_shell=True):
        self._finish(reason)
        # Ending it on purpose ends the tmux session too; letting go (overflow) leaves it running.
        if self.tmux and end_shell:
            tmux_kill(self.name)
        try:
            os.kill(self.pid, signal.SIGHUP)
        except OSError:
            pass


class WinShellSession:
    """Windows' version of ShellSession: PowerShell in a Windows pseudo console (ConPTY, Windows 10
    1809 and later), so typing, colours and resizing behave like a real terminal. Like ShellSession
    it keeps running when the browser leaves and replays what was on screen when it comes back."""

    def __init__(self, name, cols, rows, argv=None):
        from ctypes import wintypes

        self.name = name
        self.alive = True
        self.tmux = False
        self.fd = -1
        self.pid = 0
        self.cols = min(500, max(10, int(cols or 80)))
        self.rows = min(300, max(4, int(rows or 24)))
        self.scrollback = bytearray()
        self._lock = threading.Lock()
        self.attached = None
        self._pending = bytearray()
        self._write_cv = threading.Condition()
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._k32 = k32
        if not hasattr(k32, "CreatePseudoConsole"):
            raise RuntimeError("The terminal needs Windows 10 (version 1809) or later.")

        class COORD(ctypes.Structure):
            _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]

        class STARTUPINFOW(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR), ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
                        ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD), ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
                        ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD), ("dwFillAttribute", wintypes.DWORD),
                        ("dwFlags", wintypes.DWORD), ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD), ("lpReserved2", ctypes.c_void_p),
                        ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE)]

        class STARTUPINFOEXW(ctypes.Structure):
            _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]

        class PROCESS_INFORMATION(ctypes.Structure):
            _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE), ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]

        self._COORD = COORD
        k32.CreatePipe.argtypes = [ctypes.POINTER(wintypes.HANDLE), ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p, wintypes.DWORD]
        k32.CreatePseudoConsole.argtypes = [COORD, wintypes.HANDLE, wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
        k32.CreatePseudoConsole.restype = ctypes.c_long
        k32.ResizePseudoConsole.argtypes = [ctypes.c_void_p, COORD]
        k32.ResizePseudoConsole.restype = ctypes.c_long
        k32.ClosePseudoConsole.argtypes = [ctypes.c_void_p]
        k32.ClosePseudoConsole.restype = None
        k32.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)]
        k32.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
        k32.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
        k32.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p]
        k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        k32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]

        in_read, in_write, out_read, out_write = wintypes.HANDLE(), wintypes.HANDLE(), wintypes.HANDLE(), wintypes.HANDLE()
        if not k32.CreatePipe(ctypes.byref(in_read), ctypes.byref(in_write), None, 0) or not k32.CreatePipe(ctypes.byref(out_read), ctypes.byref(out_write), None, 0):
            raise RuntimeError("Couldn’t start a terminal on this computer")
        self._hpc = ctypes.c_void_p()
        hr = k32.CreatePseudoConsole(COORD(self.cols, self.rows), in_read, out_write, 0, ctypes.byref(self._hpc))
        # The console has its own copies of these ends now.
        k32.CloseHandle(in_read)
        k32.CloseHandle(out_write)
        if hr != 0:
            k32.CloseHandle(in_write)
            k32.CloseHandle(out_read)
            raise RuntimeError("Couldn’t start a terminal on this computer")
        self._in, self._out = in_write, out_read

        size = ctypes.c_size_t()
        k32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        attrs = ctypes.create_string_buffer(size.value)
        si = STARTUPINFOEXW()
        si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
        # No handles of the connector's own: the shell's only input and output are the console.
        si.StartupInfo.dwFlags = 0x00000100  # STARTF_USESTDHANDLES
        si.lpAttributeList = ctypes.cast(attrs, ctypes.c_void_p)
        pi = PROCESS_INFORMATION()
        try:
            if not k32.InitializeProcThreadAttributeList(attrs, 1, 0, ctypes.byref(size)):
                raise RuntimeError("Couldn’t start a terminal on this computer")
            # PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: the value is the console handle itself.
            if not k32.UpdateProcThreadAttribute(attrs, 0, 0x00020016, self._hpc, ctypes.sizeof(ctypes.c_void_p), None, None):
                raise RuntimeError("Couldn’t start a terminal on this computer")
            shell = shutil.which("pwsh.exe") or shutil.which("powershell.exe") or os.environ.get("COMSPEC") or "cmd.exe"
            cmdline = ctypes.create_unicode_buffer(subprocess.list2cmdline([shell, "-NoLogo"] if "powershell" in shell.lower() or "pwsh" in shell.lower() else [shell]))
            # EXTENDED_STARTUPINFO_PRESENT
            if not k32.CreateProcessW(None, cmdline, None, None, False, 0x00080000, None, os.path.expanduser("~"), ctypes.byref(si), ctypes.byref(pi)):
                raise RuntimeError(f"Couldn’t start {os.path.basename(shell)}")
        except Exception:
            self._close_console()
            raise
        finally:
            k32.DeleteProcThreadAttributeList(attrs)
        k32.CloseHandle(pi.hThread)
        self._proc = pi.hProcess
        self.pid = int(pi.dwProcessId)
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._write_loop, daemon=True).start()
        threading.Thread(target=self._wait, daemon=True).start()

    def _close_console(self):
        hpc, self._hpc = getattr(self, "_hpc", None), None
        if hpc:
            # Ends the console and everything attached to it; the output pipe then ends too.
            self._k32.ClosePseudoConsole(hpc)

    def resize(self, cols, rows):
        try:
            c = min(500, max(10, int(cols or 80)))
            r = min(300, max(4, int(rows or 24)))
            self.cols, self.rows = c, r
            if self._hpc:
                self._k32.ResizePseudoConsole(self._hpc, self._COORD(c, r))
        except (OSError, ValueError, TypeError):
            pass

    attach = ShellSession.attach
    detach = ShellSession.detach
    _finish = ShellSession._finish

    def write(self, data):
        if not data or not self.alive:
            return False
        overflow = False
        with self._write_cv:
            if self.alive:
                if len(self._pending) + len(data) > SHELL_IN_MAX:
                    overflow = True
                else:
                    self._pending += data
                    self._write_cv.notify()
        if overflow:
            self.kill("The terminal stopped reading")
            return False
        return True

    def _write_loop(self):
        from ctypes import wintypes

        while True:
            with self._write_cv:
                while self.alive and not self._pending:
                    self._write_cv.wait()
                if not self.alive:
                    return
                chunk, self._pending = bytes(self._pending), bytearray()
            done = wintypes.DWORD()
            buf = ctypes.create_string_buffer(chunk, len(chunk))
            if not self._k32.WriteFile(self._in, buf, len(chunk), ctypes.byref(done), None):
                return

    def _pump(self):
        from ctypes import wintypes

        buf = ctypes.create_string_buffer(65536)
        got = wintypes.DWORD()
        try:
            while self.alive:
                if not self._k32.ReadFile(self._out, buf, 65536, ctypes.byref(got), None) or got.value == 0:
                    break
                data = buf.raw[: got.value]
                with self._lock:
                    self.scrollback += data
                    _trim_scrollback(self.scrollback)
                    target = self.attached
                if target is not None and not target.closed:
                    target.out(data)
        finally:
            self._finish("Shell ended")
            self._close_console()
            for h in (self._in, self._out):
                self._k32.CloseHandle(h)

    def _wait(self):
        # The console keeps its output pipe open after the shell exits: close it so _pump ends.
        self._k32.WaitForSingleObject(self._proc, 0xFFFFFFFF)
        self._k32.CloseHandle(self._proc)
        self._proc = None
        self._close_console()

    def kill(self, reason="Shell ended", end_shell=True):
        self._finish(reason)
        with self._write_cv:
            self._write_cv.notify_all()
        proc = self._proc
        if proc:
            self._k32.TerminateProcess(proc, 1)
        self._close_console()


class ShellChannel(Channel):
    """Channel adapter attached to a persistent ShellSession (close detaches without SIGHUP)."""

    def __init__(self, conn, ch, session):
        super().__init__(conn, ch)
        self.session = session

    @property
    def fd(self):
        return self.session.fd

    @property
    def pid(self):
        return self.session.pid

    def resize(self, cols, rows):
        self.session.resize(cols, rows)

    def write(self, data):
        if self.closed:
            return
        if not self.session.write(data):
            self.closed = True

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.session.detach(self)


_shell_sessions = {}
_shell_sessions_lock = threading.Lock()


def open_shell_session(conn, ch, cols, rows, name="main", fresh=False):
    sname = name if isinstance(name, str) and SESSION_NAME.match(name) else "main"
    old = None
    with _shell_sessions_lock:
        existing = _shell_sessions.get(sname)
        if existing is not None and (fresh or not existing.alive):
            old = _shell_sessions.pop(sname, None)
            existing = None
        if existing is None:
            if len(_shell_sessions) >= MAX_SHELL_SESSIONS:
                raise RuntimeError(f"At most {MAX_SHELL_SESSIONS} terminal sessions can run at once")
            if old is not None or fresh:
                tmux_kill(sname)
            # A tmux session still running from before the connector restarted is picked up again.
            kept = tmux_has(sname)
            argv = tmux_attach_argv(sname, cols, rows)
            session = (WinShellSession if IS_WINDOWS else ShellSession)(sname, cols, rows, argv)
            _shell_sessions[sname] = session
            resumed = bool(argv) and kept
        else:
            session = existing
            resumed = True
    if old is not None:
        old.kill("Started a new session", end_shell=False)
    channel = ShellChannel(conn, ch, session)
    session.attach(channel, cols, rows, resumed)
    return channel


def kill_shell_session(name="*"):
    with _shell_sessions_lock:
        if name == "*":
            targets = list(_shell_sessions.values())
            _shell_sessions.clear()
        else:
            s = _shell_sessions.pop(name, None)
            targets = [s] if s is not None else []
    for s in targets:
        s.kill("Shell ended")
    return len(targets)


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


class GuestVnc(Channel):
    def __init__(self, conn, ch, sock):
        super().__init__(conn, ch)
        self.sock = sock
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
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


_GUEST_ID = re.compile(r"^[a-f0-9]{8}$")


def open_guest_vnc(conn, ch, guest, data_dir, run):
    # Guest id is 8 hex. The path comes from the helper, never from the server.
    if not isinstance(guest, str) or not _GUEST_ID.match(guest):
        raise RuntimeError("That virtual machine isn’t valid")
    try:
        err, out = run([sys.executable, VM_HELPER, "vnc-path", guest])
    except (OSError, subprocess.SubprocessError, ValueError, TypeError) as e:
        raise RuntimeError((str(e) or "VM helper failed")[:300])
    err_rest = (err or "").strip()
    if err_rest:
        raise RuntimeError(err_rest.split("\n")[-1][:300])
    printed = (out or "").strip()
    expected = os.path.join(data_dir, "vms", guest, "vnc.sock")
    real = os.path.realpath(printed) if printed else ""
    if real != os.path.realpath(expected):
        raise RuntimeError("That virtual machine isn’t valid")
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(real)
    except OSError:
        sock.close()
        raise RuntimeError("isn’t running")
    return sock


# ---------------------------------------------------------------------------------------------
# Files: a channel for the clip book. Paths stay inside the home folder. The connector's own
# configuration and data (its key and the server certificate) are not part of that folder here,
# even though a terminal could still read them. A symlink is followed only when the target stays
# inside the home folder, and the opened file is checked again so a swapped link cannot leave.
_PART = re.compile(r"^[^\x00-\x1f\\/]{1,200}$")


def _roots(home, config, data):
    return (
        os.path.realpath(home or os.path.expanduser("~")),
        os.path.realpath(config or CONFIG_DIR),
        os.path.realpath(data or DATA_DIR),
    )


def _under(path, root):
    path = os.path.realpath(path)
    if IS_WINDOWS:  # paths aren't case-sensitive there
        path, root = os.path.normcase(path), os.path.normcase(root)
    return path == root or path.startswith(root + os.sep)


def _close_fd(fd):
    if fd is not None and fd >= 0:
        os.close(fd)


def _blocked(path, config, data):
    return _under(path, config) or _under(path, data)


def split_home_path(rel, allow_empty=False):
    """The relative path the server asked for, or a RuntimeError the person can read."""
    rel = str("" if rel is None else rel).strip()
    if rel.startswith("/") or rel.startswith("~") or "\\" in rel or "\x00" in rel:
        raise RuntimeError("Use a path inside your home folder")
    if rel == "":
        if allow_empty:
            return []
        raise RuntimeError("Name the file")
    parts = [p for p in rel.split("/") if p]
    if not parts:
        raise RuntimeError("Name the file")
    for part in parts:
        if part in (".", "..") or not _PART.match(part):
            raise RuntimeError(f"“{part[:60]}” isn’t a path in your home folder")
    if len("/".join(parts)) > 1024:
        raise RuntimeError("That path is too long")
    return parts


def _fd_real(fd):
    if IS_MAC:  # no /proc there: F_GETPATH asks the kernel for the descriptor's path
        import fcntl

        return os.path.realpath(fcntl.fcntl(fd, 50, b"\0" * 1024).split(b"\0", 1)[0].decode())
    return os.path.realpath(f"/proc/self/fd/{fd}")


def resolve_home(rel, want, home=None, config=None, data=None):
    """Open a file or directory under home. want is 'file', 'dir', or 'any'. Caller closes the fd."""
    home, config, data = _roots(home, config, data)
    parts = split_home_path(rel, allow_empty=(want == "dir" and str(rel or "").strip() == ""))
    cur = home
    try:
        for i, part in enumerate(parts):
            last = i == len(parts) - 1
            nxt = os.path.join(cur, part)
            try:
                lst = os.lstat(nxt)
            except OSError as e:
                raise RuntimeError("That file isn’t in your home folder") from e
            if stat.S_ISLNK(lst.st_mode):
                try:
                    target = os.path.realpath(nxt)
                except OSError as e:
                    raise RuntimeError(f"“{part[:60]}” leads outside your home folder") from e
                if not _under(target, home) or _blocked(target, config, data):
                    raise RuntimeError(f"“{part[:60]}” leads outside your home folder")
                cur = target
                if last:
                    break
                if not os.path.isdir(cur):
                    raise RuntimeError(f"“{part[:60]}” isn’t a folder")
                continue
            cur = nxt
            if last:
                break
            if not stat.S_ISDIR(lst.st_mode):
                raise RuntimeError(f"“{part[:60]}” isn’t a folder")
        if not _under(cur, home) or _blocked(cur, config, data):
            raise RuntimeError("That path isn’t in your home folder")
        if IS_WINDOWS:
            # No O_DIRECTORY, O_NOFOLLOW or /proc there: the walk above already checked each step.
            # A folder has no descriptor (-1); a file is opened for reading.
            real = os.path.realpath(cur)
            if not _under(real, home) or _blocked(real, config, data):
                raise RuntimeError("That path isn’t in your home folder")
            st = os.stat(real)
            if stat.S_ISDIR(st.st_mode):
                if want == "file":
                    raise RuntimeError("That isn’t a file")
                return -1, st, real, (parts[-1] if parts else "")
            if want == "dir":
                raise RuntimeError("That isn’t a folder")
            if not stat.S_ISREG(st.st_mode):
                raise RuntimeError("That isn’t a file")
            return os.open(real, os.O_RDONLY | getattr(os, "O_BINARY", 0)), st, real, (parts[-1] if parts else "")
        # O_NONBLOCK so a fifo swapped in after the stat cannot stall this thread.
        if want == "dir" or (want == "any" and os.path.isdir(cur) and not os.path.islink(cur)):
            fd = os.open(cur, os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK)
        else:
            try:
                kind = os.lstat(cur)
            except OSError as e:
                raise RuntimeError("That file isn’t in your home folder") from e
            if not stat.S_ISREG(kind.st_mode):
                raise RuntimeError("That isn’t a file")
            fd = os.open(cur, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            real = _fd_real(fd)
            st = os.fstat(fd)
            if not _under(real, home) or _blocked(real, config, data):
                raise RuntimeError("That path isn’t in your home folder")
            if want == "file" and not stat.S_ISREG(st.st_mode):
                raise RuntimeError("That isn’t a file")
            if want == "dir" and not stat.S_ISDIR(st.st_mode):
                raise RuntimeError("That isn’t a folder")
            if want == "any" and not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
                raise RuntimeError("That isn’t a file")
        except Exception:
            os.close(fd)
            raise
        return fd, st, real, (parts[-1] if parts else "")
    except RuntimeError:
        raise
    except OSError as e:
        raise RuntimeError("That file isn’t in your home folder") from e


def files_stat(args, home=None, config=None, data=None):
    rel = (args or {}).get("path")
    fd, st, _real, name = resolve_home(rel, "any", home, config, data)
    _close_fd(fd)
    return {"name": name, "size": st.st_size if stat.S_ISREG(st.st_mode) else 0, "mtime": int(st.st_mtime * 1000), "dir": stat.S_ISDIR(st.st_mode)}


def clip_files_list(args, home=None, config=None, data=None):
    rel = (args or {}).get("path") or ""
    home_r, config_r, data_r = _roots(home, config, data)
    fd, _st, real, _name = resolve_home(rel, "dir", home, config, data)
    _close_fd(fd)
    entries, truncated = [], False
    try:
        names = sorted(os.listdir(real), key=str.lower)
    except OSError as e:
        raise RuntimeError("That folder isn’t in your home folder") from e
    for name in names:
        if len(entries) >= 200:
            truncated = True
            break
        if not _PART.match(name):
            continue
        full = os.path.join(real, name)
        try:
            target = os.path.realpath(full)
            s = os.stat(full)
        except OSError:
            continue
        if not _under(target, home_r) or _blocked(target, config_r, data_r):
            continue
        entries.append({"name": name, "size": s.st_size if stat.S_ISREG(s.st_mode) else 0, "mtime": int(s.st_mtime * 1000), "dir": stat.S_ISDIR(s.st_mode)})
    shown = rel.strip().strip("/")
    return {"path": shown, "entries": entries, "truncated": truncated}


def prepare_write(rel, size, home=None, config=None, data=None):
    """A temporary file in the destination folder. Nothing is replaced: the name must be free."""
    if type(size) is not int or size < 0 or size > 2**62:
        raise RuntimeError("That file’s size isn’t usable")
    parts = split_home_path(rel)
    parent, name = "/".join(parts[:-1]), parts[-1]
    tmp = ".incoming." + base64.urlsafe_b64encode(os.urandom(9)).decode().rstrip("=")
    if IS_WINDOWS:
        return _prepare_write_windows(parent, name, tmp, size, home, config, data)
    dirfd, _st, _real, _name = resolve_home(parent, "dir", home, config, data)
    fd = None
    try:
        try:
            os.lstat(name, dir_fd=dirfd)
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError("A file with that name is already there")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dirfd)
        os.fchmod(fd, 0o600)
    except Exception:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.unlink(tmp, dir_fd=dirfd)
            except OSError:
                pass
        try:
            os.close(dirfd)
        except OSError:
            pass
        raise
    return {"dirfd": dirfd, "fd": fd, "tmp": tmp, "name": name, "size": size}


def _prepare_write_windows(parent, name, tmp, size, home, config, data):
    # No descriptors for folders there: resolve_home checked every step of the way to the folder,
    # and nothing below follows a link. The upload goes to a hidden temporary file beside the
    # target, then takes its name with a rename, which refuses to replace a file already there.
    _fd, _st, real, _name = resolve_home(parent, "dir", home, config, data)
    target = os.path.join(real, name)
    if os.path.lexists(target):
        raise RuntimeError("A file with that name is already there")
    path = os.path.join(real, tmp)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
    return {"dirfd": None, "dir": real, "fd": fd, "tmp": tmp, "name": name, "size": size}


def commit_write(prep):
    os.fsync(prep["fd"])
    os.close(prep["fd"])
    prep["fd"] = None
    if prep.get("dir") is not None:  # Windows
        try:
            os.rename(os.path.join(prep["dir"], prep["tmp"]), os.path.join(prep["dir"], prep["name"]))
        except OSError as e:
            abort_write(prep)
            if isinstance(e, FileExistsError):
                raise RuntimeError("A file with that name is already there") from e
            raise RuntimeError("Couldn’t save that file") from e
        prep["dir"] = None
        return
    try:
        os.link(prep["tmp"], prep["name"], src_dir_fd=prep["dirfd"], dst_dir_fd=prep["dirfd"])
    except OSError as e:
        abort_write(prep)
        if e.errno == 17:  # EEXIST
            raise RuntimeError("A file with that name is already there") from e
        raise RuntimeError("Couldn’t save that file") from e
    os.unlink(prep["tmp"], dir_fd=prep["dirfd"])
    os.fsync(prep["dirfd"])
    os.close(prep["dirfd"])
    prep["dirfd"] = None


def abort_write(prep):
    if not prep:
        return
    fd, prep["fd"] = prep.get("fd"), None
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass
    if prep.get("dir") is not None and prep.get("tmp"):  # Windows
        try:
            os.unlink(os.path.join(prep["dir"], prep["tmp"]))
        except OSError:
            pass
        prep["dir"] = None
    dirfd = prep.get("dirfd")
    if dirfd is not None and prep.get("tmp"):
        try:
            os.unlink(prep["tmp"], dir_fd=dirfd)
        except OSError:
            pass
    if dirfd is not None:
        prep["dirfd"] = None
        try:
            os.close(dirfd)
        except OSError:
            pass


class FileRead(Channel):
    """Send a home-folder file in chunks, pausing until the server has caught up."""

    def __init__(self, conn, ch, rel, home=None, config=None, data=None):
        super().__init__(conn, ch)
        fd, st, _real, _name = resolve_home(rel, "file", home, config, data)
        self.fd, self.left, self.pending = fd, st.st_size, 0
        self.cv = threading.Condition()
        self.conn.send({"op": "file", "ch": ch, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
        threading.Thread(target=self.pump, daemon=True).start()

    def write(self, _data):
        return

    def ack(self, n=1):
        with self.cv:
            try:
                n = int(n or 1)
            except (TypeError, ValueError):
                n = 1
            self.pending = max(0, self.pending - max(1, n))
            self.cv.notify_all()

    def pump(self):
        try:
            while not self.closed and self.left:
                timed_out = False
                with self.cv:
                    waited = 0
                    while self.pending >= FILE_WINDOW and not self.closed:
                        if not self.cv.wait(timeout=5):
                            waited += 5
                            if waited >= 60:
                                timed_out = True
                                break
                        else:
                            waited = 0
                    if self.closed:
                        return
                    if not timed_out:
                        self.pending += 1
                if timed_out:
                    self.ended("The server stopped reading", 1011)
                    return
                try:
                    data = os.read(self.fd, min(FILE_CHUNK, self.left))
                except OSError:
                    self.ended("Couldn’t read that file", 1011)
                    return
                if not data:
                    break
                self.left -= len(data)
                self.out(data)
            if not self.closed:
                self.ended("" if self.left == 0 else "The file changed while it was being read", 1000 if self.left == 0 else 1011)
        finally:
            if not self.closed:
                self.ended("Couldn’t read that file", 1011)

    def close(self):
        if self.closed:
            return
        self.closed = True
        with self.cv:
            self.cv.notify_all()
        try:
            os.close(self.fd)
        except OSError:
            pass


class FileWrite(Channel):
    """Receive a file into a temporary name, then link it into place. An existing file is left alone."""

    def __init__(self, conn, ch, rel, size, home=None, config=None, data=None):
        super().__init__(conn, ch)
        self.prep = prepare_write(rel, size if type(size) is int else -1, home, config, data)
        self.got, self.expect, self.committing = 0, size, False
        self.lock = threading.Lock()
        try:
            self.conn.send({"op": "file", "ch": ch, "ready": True})
        except Exception:
            abort_write(self.prep)
            self.prep = None
            raise

    def write(self, data):
        if not data:
            return
        with self.lock:
            if self.closed or self.committing or not self.prep:
                return
            if len(data) > 1024 * 1024 or self.got + len(data) > self.expect:
                self._fail("That file is larger than it said")
                return
            try:
                view = memoryview(data)
                while len(view):
                    wrote = os.write(self.prep["fd"], view)
                    if wrote <= 0:
                        raise OSError("short write")
                    view = view[wrote:]
            except OSError:
                self._fail("Couldn’t write that file")
                return
            self.got += len(data)
        self.conn.send({"op": "ack", "ch": self.ch})

    def commit(self):
        threading.Thread(target=self._commit, daemon=True).start()

    def _commit(self):
        with self.lock:
            if self.closed or self.committing or not self.prep:
                return
            self.committing = True
            if self.got != self.expect:
                self._fail("The file arrived short")
                return
            prep, self.prep = self.prep, None
        try:
            commit_write(prep)
        except Exception as e:  # noqa: BLE001 - said back to the person, in plain words
            self.conn.send({"op": "closed", "ch": self.ch, "code": 1011, "reason": str(e)[:200]})
            self.closed = True
            return
        self.ended("")

    def _fail(self, reason):
        # Caller holds self.lock.
        prep, self.prep = self.prep, None
        self.closed = True
        abort_write(prep)
        self.conn.send({"op": "closed", "ch": self.ch, "code": 1011, "reason": reason[:200]})

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            prep, self.prep = self.prep, None
        abort_write(prep)


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
    if IS_WINDOWS:
        run(["shutdown", "/r", "/t", "0"], timeout=30, creationflags=_WIN_NO_WINDOW)
        return True
    if IS_MAC:
        _mac_power("restart")
        return True
    if shutil.which("systemctl"):
        run(["systemctl", "reboot"], timeout=30)
    else:
        run(["reboot"], timeout=30)
    return True


APP_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,64}$")


def app_install(args):
    apps = (args or {}).get("apps")
    if not isinstance(apps, list) or not apps:
        raise RuntimeError("Nothing to install")
    if shutil.which("podman"):
        engine = ["podman", "compose"]
    elif shutil.which("docker"):
        engine = ["docker", "compose"]
    else:
        raise RuntimeError("Podman isn’t on this computer, so this app can’t be installed here.")
    root = os.path.expanduser("~/.local/share/omarchy-connector/apps")
    os.makedirs(root, mode=0o700, exist_ok=True)
    for app in apps:
        app_id = str((app or {}).get("appId", ""))
        compose = (app or {}).get("compose")
        if not APP_ID.match(app_id) or ".." in app_id or not isinstance(compose, str) or not compose or len(compose) > 200_000 or "\0" in compose:
            raise RuntimeError("That app can’t be installed here")
        dest = os.path.join(root, app_id)
        os.makedirs(dest, mode=0o700, exist_ok=True)
        path = os.path.join(dest, "compose.yml")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, compose.encode())
        finally:
            os.close(fd)
        try:
            run(engine + ["-f", "compose.yml", "up", "-d"], cwd=dest, timeout=600)
        except RuntimeError as e:
            raise RuntimeError(str(e) or "Podman isn’t on this computer, so this app can’t be installed here.") from e
    return True



def _mac_power(what):
    # As the signed-in person, the way the Apple menu does it (no sudo). The first time, macOS asks
    # on that Mac whether the connector may control System Events.
    run(["osascript", "-e", f'tell application "System Events" to {what}'], timeout=30)


def shutdown(_args):
    if IS_WINDOWS:
        run(["shutdown", "/s", "/t", "0"], timeout=30, creationflags=_WIN_NO_WINDOW)
        return True
    if IS_MAC:
        _mac_power("shut down")
        return True
    if shutil.which("systemctl"):
        run(["systemctl", "poweroff"], timeout=30)
    else:
        run(["poweroff"], timeout=30)
    return True


def suspend(_args):
    if IS_WINDOWS:
        run(["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"], timeout=30, creationflags=_WIN_NO_WINDOW)
        return True
    if IS_MAC:
        run(["pmset", "sleepnow"], timeout=30)
        return True
    if shutil.which("systemctl"):
        run(["systemctl", "suspend"], timeout=30)
        return True
    raise RuntimeError("This computer can’t sleep from here")


def _exit_for_restart():
    # systemd starts the connector again. Windows' scheduled task doesn't, so start the new one first.
    if IS_WINDOWS:
        try:
            subprocess.Popen([sys.executable, os.path.abspath(__file__)], cwd=CONFIG_DIR, creationflags=_WIN_NO_WINDOW | getattr(subprocess, "DETACHED_PROCESS", 0), close_fds=True)
        except OSError:
            pass
    os._exit(0)


def update_self(args, cfg, cafile=None, target_path=None, on_restart=None, fetch=None):
    expected = str((args or {}).get("sha256", "")).strip().lower()
    if not re.match(r"^[0-9a-f]{64}$", expected):
        raise RuntimeError("Bad connector checksum")
    if fetch is not None:
        body = fetch()
    else:
        server = str((cfg or {}).get("server", "")).rstrip("/")
        u = urllib.parse.urlsplit(server)
        if u.scheme != "https" or not u.hostname:
            raise RuntimeError("Invalid server address")
        ctx = _ssl_context(cafile)
        req = urllib.request.Request(
            server + "/connector/agent.py",
            headers={"Authorization": f"Bearer {cfg['id']}:{cfg['key']}", "User-Agent": f"omarchy-connector/{VERSION}"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
                body = r.read(2 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Couldn’t download connector update (HTTP {e.code})")
        except (urllib.error.URLError, OSError) as e:
            raise RuntimeError(f"Couldn’t download connector update: {e}")
    if not body or len(body) > 2 * 1024 * 1024:
        raise RuntimeError("The connector download was empty or too large")
    actual = hashlib.sha256(body).hexdigest()
    if actual != expected:
        raise RuntimeError("The connector download didn’t match the expected checksum")
    try:
        ast.parse(body.decode("utf-8"))
    except (UnicodeDecodeError, SyntaxError):
        raise RuntimeError("The connector download wasn’t valid Python")
    target = os.path.realpath(target_path or __file__)
    parent = os.path.dirname(target)
    tmp = os.path.join(parent, f".agent.py.{os.getpid()}.{os.urandom(4).hex()}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)
        with os.fdopen(fd, "wb") as f:
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)
    except OSError as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise RuntimeError(f"Couldn’t replace connector script: {e}")
    restart_fn = on_restart or _exit_for_restart
    t = threading.Timer(0.3, restart_fn)
    t.daemon = True
    t.start()
    return {"sha256": actual, "restarting": True}


# What a Windows computer or a Mac can do so far: its terminal, its files and power. The rest
# (screen, disks, backups, services) needs Linux. An LXC system container keeps those, but has
# no desktop, host disks, or nested virtual machines.
WINDOWS_ABILITIES = ("terminal", "files", "manage")
MAC_ABILITIES = ("terminal", "files", "manage")
LXC_ABILITIES = ("terminal", "files", "manage", "backup", "services")
MAC_LABEL = "org.myowndatacenter.connector"  # its LaunchAgent (connector/install.sh)
LXC_MARKERS = ("/dev/incus/sock", "/dev/lxd/sock")


def in_lxc(environ=None, exists=None, data_dir=None):
    """True inside an Incus/LXC system container (or when install left a flag file)."""
    root = data_dir if data_dir is not None else DATA_DIR
    if os.path.isfile(os.path.join(root, "lxc")):
        return True
    check = exists or os.path.exists
    for path in LXC_MARKERS:
        if check(path):
            return True
    if environ is not None:
        raw = environ if isinstance(environ, (bytes, bytearray)) else str(environ).encode("utf-8", "replace")
    elif IS_WINDOWS or IS_MAC:
        raw = b""
    else:
        try:
            with open("/proc/1/environ", "rb") as f:
                raw = f.read()
        except OSError:
            raw = b""
    return b"container=lxc" in raw.split(b"\0")


def supported_abilities(abilities, windows=None, mac=None, lxc=None):
    windows = IS_WINDOWS if windows is None else windows
    mac = IS_MAC if mac is None else mac
    lxc = in_lxc() if lxc is None else lxc
    abilities = dict(abilities or {})
    only = WINDOWS_ABILITIES if windows else MAC_ABILITIES if mac else LXC_ABILITIES if lxc else None
    if only is not None:
        for k in ABILITY_NAMES:
            if k not in only:
                abilities[k] = False
    return abilities


ACTIONS = {"plugin-install": plugin_install, "plugin-remove": plugin_remove, "theme-set": theme_set, "reboot": reboot, "shutdown": shutdown, "suspend": suspend}
HELPER = "/usr/local/libexec/omarchy-connector/helper.py"
VM_HELPER = os.path.join(DATA_DIR, "vm-helper.py")
LXC_HELPER = os.path.join(DATA_DIR, "lxc-helper.py")


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

# Virtual machines (ability "vms"). Session libvirt as this user: no sudo, no shell.
VM_ACTIONS = {
    "vm-status": "status",
    "vm-fetch": "fetch",
    "vm-disk-create": "disk-create",
    "vm-seed": "seed",
    "vm-define": "define",
    "vm-start": "start",
    "vm-shutdown": "shutdown",
    "vm-reboot": "reboot",
    "vm-destroy": "destroy",
    "vm-suspend": "suspend",
    "vm-resume": "resume",
    "vm-undefine": "undefine",
    "vm-state": "state",
    "vm-vnc-path": "vnc-path",
    "vm-inspect": "inspect",
    "vm-stats": "stats",
    "vm-ga-ping": "ga-ping",
    "vm-ga-exec": "ga-exec",
    "vm-ga-status": "ga-status",
}
_VM_POSITIONALS = {
    "status": (),
    "fetch": ("imageId", "catalogUrl"),
    "disk-create": ("guestId", "sizeGb", "imageId?"),
    "seed": ("guestId", "name"),
    "define": ("guestId",),
    "start": ("guestId",),
    "shutdown": ("guestId",),
    "reboot": ("guestId",),
    "destroy": ("guestId",),
    "suspend": ("guestId",),
    "resume": ("guestId",),
    "undefine": ("guestId",),
    "state": (),
    "vnc-path": ("guestId",),
    "inspect": ("guestId",),
    "stats": (),
    "ga-ping": ("guestId",),
    "ga-exec": ("guestId",),
    "ga-status": ("guestId", "pid"),
}
_VM_JSON = frozenset(("seed", "define", "ga-exec"))
_PROGRESS = re.compile(r"^PROGRESS (\d+)$")


def _process_abilities():
    try:
        with open(CONFIG) as f:
            return supported_abilities(json.load(f).get("abilities", {}))
    except (OSError, ValueError, TypeError):
        return {}


def _info_libvirt(abilities=None):
    if abilities is None:
        abilities = _process_abilities()
    if not abilities.get("vms"):
        return False
    try:
        out = vm_call("vm-status", {}, allowed=abilities)
        data = json.loads(out) if isinstance(out, str) else out
        return isinstance(data, dict) and data.get("libvirt") is True
    except Exception:
        return False


def _vm_arg(value):
    if isinstance(value, bool) or value is None:
        raise RuntimeError("Unknown action")
    if isinstance(value, int):
        value = str(value)
    elif not isinstance(value, str):
        raise RuntimeError("Unknown action")
    if len(value) > 500 or any(ch.isspace() for ch in value):
        raise RuntimeError("That argument isn’t valid")
    return value


def _take_progress(text, progress):
    kept = []
    for line in (text or "").splitlines():
        m = _PROGRESS.match(line.strip())
        if m:
            if progress:
                progress(int(m.group(1)) / 100)
        elif line.strip():
            kept.append(line)
    return "\n".join(kept)


def _vm_spawn(argv, stdin=None):
    verb = argv[2] if len(argv) > 2 else ""
    timeout = 30 * 60 if verb in ("fetch", "disk-create") else 2 * 60
    if isinstance(stdin, bytes):
        stdin = stdin.decode("utf-8")
    r = subprocess.run(argv, input="" if stdin is None else stdin, capture_output=True, text=True, timeout=timeout)
    err, out = r.stderr or "", r.stdout or ""
    if r.returncode and not err.strip():
        err = (out.strip() or "VM helper failed")
    return err, out


def vm_call(name, args, allowed, spawn=None, stdin=None, progress=None):
    if not (allowed or {}).get("vms"):
        raise RuntimeError("This computer doesn’t allow virtual machines")
    verb = VM_ACTIONS.get(name)
    if not verb:
        raise RuntimeError("Unknown action")
    args = dict(args or {})
    positionals = []
    for key in _VM_POSITIONALS[verb]:
        optional = key.endswith("?")
        key = key[:-1] if optional else key
        if key not in args or args[key] is None or args[key] == "":
            if optional:
                args.pop(key, None)
                continue
            raise RuntimeError("Unknown action")
        positionals.append(_vm_arg(args.pop(key)))
    body = stdin
    if body is None and verb in _VM_JSON:
        body = args.pop("spec") if verb == "define" and "spec" in args else args
        if not isinstance(body, str):
            body = json.dumps(body)
    argv = [sys.executable, VM_HELPER, verb, *positionals]
    run = spawn or _vm_spawn
    try:
        err, out = run(argv, stdin=body)
    except (OSError, subprocess.SubprocessError, ValueError, TypeError) as e:
        raise RuntimeError((str(e) or "VM helper failed")[:300])
    err_rest = _take_progress(err, progress)
    out_rest = _take_progress(out, progress)
    if err_rest.strip():
        raise RuntimeError(err_rest.strip().split("\n")[-1][:300])
    return (out_rest or "").strip()


# System containers (Incus per-user on this computer). No separate ability flag.
LXC_ACTIONS = {
    "lxc-status": "status",
    "lxc-list": "list",
    "lxc-launch": "launch",
    "lxc-start": "start",
    "lxc-stop": "stop",
    "lxc-restart": "restart",
    "lxc-force-stop": "force-stop",
    "lxc-delete": "delete",
    "lxc-write-config": "write-config",
    "lxc-read-config": "read-config",
}
_LXC_POSITIONALS = {
    "status": (),
    "list": (),
    "launch": (),
    "start": ("name",),
    "stop": ("name",),
    "restart": ("name",),
    "force-stop": ("name",),
    "delete": ("name",),
    "write-config": (),
    "read-config": ("name",),
}
_LXC_JSON = frozenset(("launch", "write-config"))


def _lxc_spawn(argv, stdin=None):
    verb = argv[2] if len(argv) > 2 else ""
    timeout = 30 * 60 if verb == "launch" else 2 * 60
    if isinstance(stdin, bytes):
        stdin = stdin.decode("utf-8")
    r = subprocess.run(argv, input="" if stdin is None else stdin, capture_output=True, text=True, timeout=timeout)
    err, out = r.stderr or "", r.stdout or ""
    if r.returncode and not err.strip():
        err = (out.strip() or "LXC helper failed")
    return err, out


def lxc_call(name, args, spawn=None, stdin=None):
    verb = LXC_ACTIONS.get(name)
    if not verb:
        raise RuntimeError("Unknown action")
    args = dict(args or {})
    positionals = []
    for key in _LXC_POSITIONALS[verb]:
        if key not in args or args[key] is None or args[key] == "":
            raise RuntimeError("Unknown action")
        positionals.append(_vm_arg(args.pop(key)))
    body = stdin
    if body is None and verb in _LXC_JSON:
        body = args
        if not isinstance(body, dict):
            raise RuntimeError("Unknown action")
        body = json.dumps(body)
    argv = [sys.executable, LXC_HELPER, verb, *positionals]
    run = spawn or _lxc_spawn
    try:
        err, out = run(argv, stdin=body)
    except (OSError, subprocess.SubprocessError, ValueError, TypeError) as e:
        raise RuntimeError((str(e) or "LXC helper failed")[:300])
    err_rest = _take_progress(err, None)
    out_rest = _take_progress(out, None)
    if err_rest.strip():
        raise RuntimeError(err_rest.strip().split("\n")[-1][:300])
    return (out_rest or "").strip()


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
    ctx = _ssl_context(CA_FILE)
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


def home_files_mkdir(args, home=None, config=None, data=None):
    rel = (args or {}).get("path") or ""
    parts = split_home_path(rel) if rel else []
    if not parts:
        return True
    home_r, config_r, data_r = _roots(home, config, data)
    cur = home_r
    for part in parts:
        if not _PART.match(part):
            raise RuntimeError("That path isn’t in your home folder")
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            raise RuntimeError("That path isn’t in your home folder")
        if not os.path.isdir(cur):
            os.mkdir(cur, 0o755)
        real = os.path.realpath(cur)
        if not _under(real, home_r) or _blocked(real, config_r, data_r):
            raise RuntimeError("That path isn’t in your home folder")
    return True


def _free_target(directory, name, is_dir):
    target = os.path.join(directory, name)
    if not os.path.lexists(target):
        return target
    stem, ext = os.path.splitext(name)
    for n in range(2, 100):
        candidate = os.path.join(directory, f"{name} {n}" if is_dir else f"{stem} {n}{ext}")
        if not os.path.lexists(candidate):
            return candidate
    raise RuntimeError("That name is already there")


def files_transfer(args, copy, home=None, config=None, data=None):
    src = (args or {}).get("from")
    dest = (args or {}).get("to") or ""
    fd, st, real, name = resolve_home(src, "any", home, config, data)
    _close_fd(fd)
    if not name or os.path.islink(real):
        raise RuntimeError("That path isn’t in your home folder")
    dfd, _dst, dreal, _dname = resolve_home(dest, "dir", home, config, data)
    _close_fd(dfd)
    home_r, config_r, data_r = _roots(home, config, data)
    is_dir = stat.S_ISDIR(st.st_mode)
    target = _free_target(dreal, name, is_dir)
    if not _under(os.path.realpath(dreal), home_r) or _blocked(os.path.realpath(dreal), config_r, data_r):
        raise RuntimeError("That path isn’t in your home folder")
    if os.path.realpath(real) == os.path.realpath(target) or os.path.realpath(target).startswith(os.path.realpath(real) + os.sep):
        raise RuntimeError("That folder is inside itself")
    if not copy:
        try:
            os.rename(real, target)
            return {"path": os.path.relpath(target, home_r)}
        except OSError:
            pass
    if is_dir:
        # A move deletes the original afterwards, so it must copy the hidden files too.
        shutil.copytree(real, target, symlinks=True, ignore=None if not copy else lambda _dir, names: [n for n in names if n.startswith(".")])
        if not copy:
            shutil.rmtree(real)
    else:
        shutil.copy2(real, target)
        if not copy:
            os.remove(real)
    placed = os.path.realpath(target)
    if not _under(placed, home_r) or _blocked(placed, config_r, data_r):
        shutil.rmtree(target, ignore_errors=True) if is_dir else os.remove(target)
        raise RuntimeError("That path isn’t in your home folder")
    return {"path": os.path.relpath(target, home_r)}


def files_delete(args, home=None, config=None, data=None):
    fd, st, real, name = resolve_home((args or {}).get("path"), "any", home, config, data)
    _close_fd(fd)
    if not name or os.path.islink(real):
        raise RuntimeError("That path isn’t in your home folder")
    if stat.S_ISDIR(st.st_mode):
        shutil.rmtree(real)
    else:
        os.remove(real)
    return True


def files_recents(args, home=None, config=None, data=None):
    home_r, config_r, data_r = _roots(home, config, data)
    found = []
    seen = 0
    stack = [home_r]
    while stack and seen < 8000:
        cur = stack.pop()
        try:
            names = os.listdir(cur)
        except OSError:
            continue
        for name in names:
            if name.startswith(".") or name == "node_modules" or not _PART.match(name):
                continue
            full = os.path.join(cur, name)
            try:
                if os.path.islink(full):
                    continue
                st = os.lstat(full)
                real = os.path.realpath(full)
            except OSError:
                continue
            if not _under(real, home_r) or _blocked(real, config_r, data_r):
                continue
            seen += 1
            if stat.S_ISDIR(st.st_mode):
                stack.append(full)
            elif stat.S_ISREG(st.st_mode):
                found.append({"name": name, "path": os.path.relpath(full, home_r), "size": st.st_size, "mtime": int(st.st_mtime * 1000), "dir": False})
    found.sort(key=lambda row: row["mtime"], reverse=True)
    return {"files": found[:40]}

BACKUP_ACTIONS = {"backup-folders": lambda conn, cid, args, cfg: backup_folders(args), "backup-run": backup_run, "backup-restore": backup_restore}


# ---------------------------------------------------------------------------------------------
REPORT_INTERVAL = 3
DESKTOP_CHECK_INTERVAL = 10.0
HELLO_INTERVAL = 300


# Remote services & containers (ability "services").
UNIT_NAME = re.compile(r"^[A-Za-z0-9@._:-]{1,128}$")
CONTAINER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _container_engine():
    for name in ("podman", "docker"):
        if shutil.which(name):
            return name
    return ""


def _parse_systemd_units(stdout, scope):
    out = []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 4)
        if len(parts) < 4:
            continue
        name, load, active, sub = parts[0], parts[1], parts[2], parts[3]
        desc = parts[4].strip() if len(parts) > 4 else ""
        if not UNIT_NAME.match(name):
            continue
        out.append({"name": name, "scope": scope, "load": load, "active": active, "sub": sub, "description": desc[:200]})
    return out


def _parse_containers_json(stdout, engine):
    text = (stdout or "").strip()
    if not text:
        return []
    rows = []
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                rows = parsed
        except ValueError:
            rows = []
    else:
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    rows.append(obj)
            except ValueError:
                continue
    out = []
    for r in rows[:100]:
        if not isinstance(r, dict):
            continue
        names = r.get("Names")
        if isinstance(names, list):
            cname = str(names[0] if names else "").lstrip("/")
        else:
            cname = str(names or r.get("Name") or "").lstrip("/")
        cid = str(r.get("Id") or r.get("ID") or "")[:16]
        if not cname and not cid:
            continue
        out.append(
            {
                "id": cid,
                "name": cname or cid,
                "image": str(r.get("Image") or "")[:160],
                "state": str(r.get("State") or "").lower()[:32],
                "status": str(r.get("Status") or "")[:120],
                "engine": engine,
            }
        )
    return out


def services_list(_args):
    user_units = []
    failed_units = []
    if shutil.which("systemctl"):
        try:
            r = subprocess.run(["systemctl", "--user", "list-units", "--type=service", "--all", "--no-pager", "--no-legend", "--plain"], capture_output=True, text=True, timeout=15)
            user_units = _parse_systemd_units(r.stdout, "user")[:200]
        except (OSError, subprocess.SubprocessError):
            pass
        try:
            r = subprocess.run(["systemctl", "--system", "list-units", "--type=service", "--state=failed", "--no-pager", "--no-legend", "--plain"], capture_output=True, text=True, timeout=15)
            failed_units = _parse_systemd_units(r.stdout, "system")[:50]
        except (OSError, subprocess.SubprocessError):
            pass
    engine = _container_engine()
    containers = []
    if engine:
        try:
            r = subprocess.run([engine, "ps", "-a", "--format", "json"], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                containers = _parse_containers_json(r.stdout, engine)
        except (OSError, subprocess.SubprocessError):
            pass
    return {"systemd": user_units, "systemFailed": failed_units, "containers": containers, "engine": engine}


def services_logs(args):
    kind = str((args or {}).get("kind", ""))
    name = str((args or {}).get("name", ""))
    try:
        lines = max(10, min(1000, int((args or {}).get("lines") or 200)))
    except (TypeError, ValueError):
        lines = 200
    if kind == "user":
        if not UNIT_NAME.match(name):
            raise RuntimeError("Invalid service name")
        r = subprocess.run(["journalctl", "--user", "-u", name, "-n", str(lines), "--no-pager", "-o", "short-iso"], capture_output=True, text=True, timeout=20)
        text = r.stdout or r.stderr or "No log lines."
    elif kind == "system":
        if not UNIT_NAME.match(name):
            raise RuntimeError("Invalid service name")
        r = subprocess.run(["journalctl", "-u", name, "-n", str(lines), "--no-pager", "-o", "short-iso"], capture_output=True, text=True, timeout=20)
        text = r.stdout or r.stderr or "No log lines."
    elif kind == "container":
        if not CONTAINER_NAME.match(name):
            raise RuntimeError("Invalid container name")
        engine = _container_engine()
        if not engine:
            raise RuntimeError("No container runtime (podman or docker) is installed")
        r = subprocess.run([engine, "logs", "--tail", str(lines), name], capture_output=True, text=True, timeout=20)
        text = (r.stdout or "") + (r.stderr or "") or "No log lines."
    else:
        raise RuntimeError("Unknown service kind")
    return {"logs": text[-200_000:]}


def services_control(args):
    kind = str((args or {}).get("kind", ""))
    name = str((args or {}).get("name", ""))
    action = str((args or {}).get("action", ""))
    if action not in ("start", "stop", "restart"):
        raise RuntimeError("Choose start, stop or restart")
    if kind == "user":
        if not UNIT_NAME.match(name):
            raise RuntimeError("Invalid service name")
        run(["systemctl", "--user", action, name], timeout=45)
        return True
    if kind == "container":
        if not CONTAINER_NAME.match(name):
            raise RuntimeError("Invalid container name")
        engine = _container_engine()
        if not engine:
            raise RuntimeError("No container runtime (podman or docker) is installed")
        run([engine, action, name], timeout=45)
        return True
    raise RuntimeError("System services are read-only from the swarm")


SERVICES_ACTIONS = {
    "services-list": services_list,
    "services-logs": services_logs,
    "services-control": services_control,
}


# ---------------------------------------------------------------------------------------------
# Remote file browsing & transfer (ability "files"). Strictly jailed to /Home and /Pools.
FILE_MAX_BYTES = 20 * 1024 * 1024


def _file_roots(home=None):
    h = os.path.realpath(home or os.path.expanduser("~"))
    roots = {"Home": h}
    pools = os.path.join(h, "Pools")
    if os.path.isdir(pools):
        roots["Pools"] = os.path.realpath(pools)
    return roots


def _is_inside(path, root):
    return path == root or path.startswith(root + os.sep)


# Credentials stay out of the file browser, as on the server: keys, keyrings, password stores
# and browser profiles (saved logins and cookies).
PRIVATE_HOME_DIRS = (
    ".ssh", ".gnupg", ".password-store", ".pki", ".aws", ".kube", ".docker",
    ".local/share/keyrings", ".mozilla", ".config/google-chrome", ".config/chromium",
    ".config/BraveSoftware", ".config/omarchy-connector",
)


def _is_private_connector_path(real_path, home=None):
    if _is_inside(real_path, os.path.realpath(CONFIG_DIR)):
        return True
    h = os.path.realpath(home or os.path.expanduser("~"))
    return any(_is_inside(real_path, os.path.join(h, d)) for d in PRIVATE_HOME_DIRS)


def _resolve_file_path(virtual, must_exist=True, home=None):
    if not isinstance(virtual, str) or not virtual.startswith("/") or "\x00" in virtual:
        raise RuntimeError("Invalid path")
    parts = [p for p in virtual.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        raise RuntimeError("Invalid path")
    roots = _file_roots(home)
    root_name = parts[0]
    if root_name not in roots:
        raise RuntimeError("Only /Home and /Pools can be accessed")
    root_real = roots[root_name]
    rel = parts[1:]
    candidate = os.path.join(root_real, *rel) if rel else root_real
    if must_exist:
        real = os.path.realpath(candidate)
        if not _is_inside(real, root_real) or _is_private_connector_path(real, home):
            raise RuntimeError("That path is outside the allowed folders")
        if not os.path.exists(real):
            raise RuntimeError("That file or folder doesn’t exist")
        return real, "/" + "/".join([root_name, *rel])
    parent_real = os.path.realpath(os.path.dirname(candidate))
    if not _is_inside(parent_real, root_real) or _is_private_connector_path(parent_real, home):
        raise RuntimeError("That path is outside the allowed folders")
    if not os.path.isdir(parent_real):
        raise RuntimeError("The parent folder doesn’t exist")
    leaf = parts[-1]
    target = os.path.join(parent_real, leaf)
    target_real = os.path.realpath(target)
    if not _is_inside(target_real, root_real) or _is_private_connector_path(target_real, home):
        raise RuntimeError("That path is outside the allowed folders")
    return target, "/" + "/".join([root_name, *rel])


def _link_itself(src, norm, home=None):
    """A link is renamed or trashed as the link; _resolve_file_path hands back what it points to."""
    parts = norm.strip("/").split("/")
    root_real = _file_roots(home)[parts[0]]
    parent = os.path.realpath(os.path.join(root_real, *parts[1:-1]))
    leaf = os.path.join(parent, parts[-1])
    if not os.path.islink(leaf):
        return src
    if not _is_inside(parent, root_real) or _is_private_connector_path(parent, home):
        raise RuntimeError("That path is outside the allowed folders")
    return leaf


def swarm_files_list(args, home=None):
    virtual = str((args or {}).get("path") or "/")
    if virtual.strip("/") == "":
        roots = _file_roots(home)
        items = [{"name": k, "path": f"/{k}", "isDir": True, "size": 0, "modified": 0} for k in roots]
        return {"path": "/", "items": items}
    real, norm = _resolve_file_path(virtual, must_exist=True, home=home)
    if not os.path.isdir(real):
        raise RuntimeError("That isn’t a folder")
    roots = _file_roots(home)
    root_real = roots[norm.split("/")[1]]
    items = []
    for entry in os.scandir(real):
        try:
            entry_real = os.path.realpath(entry.path)
            if not _is_inside(entry_real, root_real) or _is_private_connector_path(entry_real, home):
                continue
            st = os.stat(entry_real)
            items.append(
                {
                    "name": entry.name,
                    "path": f"{norm}/{entry.name}",
                    "isDir": os.path.isdir(entry_real),
                    "size": 0 if os.path.isdir(entry_real) else int(st.st_size),
                    "modified": int(st.st_mtime * 1000),
                }
            )
        except OSError:
            continue
    items.sort(key=lambda x: (not x["isDir"], x["name"].lower()))
    return {"path": norm, "items": items[:1000]}


def virtual_files_mkdir(args, home=None):
    target, norm = _resolve_file_path(str((args or {}).get("path") or ""), must_exist=False, home=home)
    os.mkdir(target)
    return {"path": norm}


def files_rename(args, home=None):
    src, norm = _resolve_file_path(str((args or {}).get("path") or ""), must_exist=True, home=home)
    new_name = str((args or {}).get("newName") or "").strip()
    if not new_name or "/" in new_name or "\\" in new_name or "\x00" in new_name or new_name in (".", ".."):
        raise RuntimeError("Invalid name")
    parent_virtual = "/" + "/".join(norm.strip("/").split("/")[:-1])
    if parent_virtual == "/":
        raise RuntimeError("Can’t rename a top-level folder")
    src = _link_itself(src, norm, home)
    dst, dst_norm = _resolve_file_path(f"{parent_virtual}/{new_name}", must_exist=False, home=home)
    if os.path.exists(dst):
        raise RuntimeError("Something with that name already exists")
    os.rename(src, dst)
    return {"path": dst_norm}


def files_trash(args, home=None):
    src, norm = _resolve_file_path(str((args or {}).get("path") or ""), must_exist=True, home=home)
    if len(norm.strip("/").split("/")) < 2:
        raise RuntimeError("Can’t trash a top-level folder")
    src = _link_itself(src, norm, home)
    h = os.path.realpath(home or os.path.expanduser("~"))
    trash_files = os.path.join(h, ".local", "share", "Trash", "files")
    trash_info = os.path.join(h, ".local", "share", "Trash", "info")
    os.makedirs(trash_files, mode=0o700, exist_ok=True)
    os.makedirs(trash_info, mode=0o700, exist_ok=True)
    base = os.path.basename(src)
    cand = base
    n = 2
    while os.path.exists(os.path.join(trash_files, cand)):
        cand = f"{base}.{n}"
        n += 1
    shutil.move(src, os.path.join(trash_files, cand))
    info_path = os.path.join(trash_info, f"{cand}.trashinfo")
    with open(info_path, "w", encoding="utf-8") as f:
        f.write(f"[Trash Info]\nPath={urllib.parse.quote(src)}\nDeletionDate={time.strftime('%Y-%m-%dT%H:%M:%S')}\n")
    return True


def files_read(args, home=None):
    src, norm = _resolve_file_path(str((args or {}).get("path") or ""), must_exist=True, home=home)
    if os.path.isdir(src):
        raise RuntimeError("Can’t download a folder")
    st = os.stat(src)
    if st.st_size > FILE_MAX_BYTES:
        raise RuntimeError("Files larger than 20 MB can’t be transferred through the swarm")
    with open(src, "rb") as f:
        raw = f.read(FILE_MAX_BYTES + 1)
    if len(raw) > FILE_MAX_BYTES:
        raise RuntimeError("Files larger than 20 MB can’t be transferred through the swarm")
    return {"path": norm, "name": os.path.basename(src), "size": len(raw), "data": base64.b64encode(raw).decode("ascii")}


def files_write(args, home=None):
    dst, norm = _resolve_file_path(str((args or {}).get("path") or ""), must_exist=False, home=home)
    if os.path.isdir(dst):
        raise RuntimeError("A folder already exists at that path")
    b64 = str((args or {}).get("data") or "")
    try:
        raw = base64.b64decode(b64.encode("ascii"), validate=True)
    except Exception:
        raise RuntimeError("Bad file payload")
    if len(raw) > FILE_MAX_BYTES:
        raise RuntimeError("Files larger than 20 MB can’t be transferred through the swarm")
    parent = os.path.dirname(dst)
    tmp = os.path.join(parent, f".omarchy-upload.{os.getpid()}.{os.urandom(4).hex()}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        os.replace(tmp, dst)
    except OSError as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise RuntimeError(f"Couldn’t save file: {e}")
    return {"path": norm, "size": len(raw)}


def files_list(args, home=None, config=None, data=None):
    raw_path = (args or {}).get("path")
    if isinstance(raw_path, str) and raw_path.startswith("/") and config is None and data is None:
        return swarm_files_list(args, home=home)
    return clip_files_list(args, home=home, config=config, data=data)


def files_mkdir(args, home=None, config=None, data=None):
    rel = (args or {}).get("path") or ""
    if isinstance(rel, str) and rel.startswith("/"):
        return virtual_files_mkdir(args, home=home)
    return home_files_mkdir(args, home=home, config=config, data=data)


FILES_ACTIONS = {
    "files-stat": files_stat,
    "files-list": files_list,
    "files-mkdir": files_mkdir,
    "files-rename": files_rename,
    "files-trash": files_trash,
    "files-read": files_read,
    "files-write": files_write,
    "files-copy": lambda args: files_transfer(args, True),
    "files-move": lambda args: files_transfer(args, False),
    "files-delete": files_delete,
    "files-recents": files_recents,
}


# ---------------------------------------------------------------------------------------------
class Connection:
    def __init__(self, cfg):
        self.cfg = cfg
        self.connected_at = None
        self.allowed = supported_abilities(cfg.get("abilities", {}))
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

    def _open_guest_vnc(self, ch, guest):
        token = object()
        lock, tokens = self._ch_state()
        with lock:
            tokens[ch] = token

        def start():
            sock = None
            try:
                sock = open_guest_vnc(self, ch, guest, DATA_DIR, _vm_spawn)
                obj = GuestVnc(self, ch, sock)
            except Exception as e:  # noqa: BLE001 - said back to the person, in plain words
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass
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
        elif not getattr(self, "_watched", False):
            # A server older than 0.9.52 never sends `watch`. Until one arrives, read and push
            # on the old schedule so a connector newer than its server still reports.
            self.send({"op": "metrics", "metrics": metrics(self.pkg, sampler=live_sampler)})
        # Facts change now and then (plugins, theme, a desktop session starting).
        if now - last_hello >= HELLO_INTERVAL:
            self.send({"op": "hello", "info": info(self.allowed), "abilities": self.allowed})
            self._desk_seen, self._desk_at = desktop_kind(), now
            return now
        # Someone signing in to (or out of) the desktop is told straight away, not up to five
        # minutes later: the server only offers the desktop when the computer says it's there.
        if self.allowed.get("desktop") and now - getattr(self, "_desk_at", 0.0) >= DESKTOP_CHECK_INTERVAL:
            desk = desktop_kind()
            seen = getattr(self, "_desk_seen", None)
            self._desk_seen, self._desk_at = desk, now
            if seen is not None and desk != seen:
                self.send({"op": "hello", "info": info(self.allowed), "abilities": self.allowed})
                return now
        return last_hello

    def run(self):
        self._desk_seen = None
        url = self.cfg["server"].replace("https://", "wss://", 1).rstrip("/") + "/connector/ws"
        self.ws = WS(url, {"Authorization": f"Bearer {self.cfg['id']}:{self.cfg['key']}", "User-Agent": f"omarchy-connector/{VERSION}"}, CA_FILE)
        self.connected_at = time.monotonic()
        log("connected to", self.cfg["server"])
        self.send({"op": "hello", "info": info(self.allowed), "abilities": self.allowed})
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
                # One failed reading (a folder that vanished, a command that errored) must not end
                # the reporting for as long as this connection lasts.
                try:
                    last_hello = self._report_step(live_sampler, last_hello, time.monotonic())
                except Exception as e:  # noqa: BLE001
                    log("report:", e)

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
            if kind == "file":
                if not self.allowed.get("files"):
                    return self.send({"op": "closed", "ch": ch, "code": 1011, "reason": "This computer doesn’t allow files"})
                try:
                    mode = msg.get("mode")
                    if mode == "read":
                        self.channels[ch] = FileRead(self, ch, msg.get("path"))
                    elif mode == "write":
                        self.channels[ch] = FileWrite(self, ch, msg.get("path"), msg.get("size"))
                    else:
                        raise RuntimeError("Say whether to read or write the file")
                except Exception as e:  # noqa: BLE001 - said back to the person, in plain words
                    self.send({"op": "closed", "ch": ch, "code": 1011, "reason": str(e)[:200]})
                return
            # A guest id is that VM's console. Do not start wayvnc or open the desktop socket.
            if kind == "vnc" and "guest" in msg:
                if not self.allowed.get("vms"):
                    return self.send({"op": "closed", "ch": ch, "code": 1011, "reason": "This computer doesn’t allow virtual machines"})
                guest = msg.get("guest")
                if not isinstance(guest, str) or not _GUEST_ID.match(guest):
                    return self.send({"op": "closed", "ch": ch, "code": 1011, "reason": "That virtual machine isn’t valid"})
                self._open_guest_vnc(ch, guest)
                return
            ability = "terminal" if kind == "pty" else "desktop" if kind == "vnc" else None
            if not ability or not self.allowed.get(ability):
                return self.send({"op": "closed", "ch": ch, "code": 1011, "reason": f"This computer doesn’t allow the {ability or 'that'}"})
            if kind == "vnc":
                # vnc_start sleeps until the socket exists. That wait used to sit on this thread.
                self._open_vnc(ch)
                return
            try:
                # Windows' shell is always the persistent one: there's no pty for a throwaway one.
                if msg.get("session") or IS_WINDOWS:
                    self.channels[ch] = open_shell_session(self, ch, msg.get("cols"), msg.get("rows"), name=msg.get("session") or "main", fresh=bool(msg.get("fresh")))
                else:
                    self.channels[ch] = Shell(self, ch, msg.get("cols"), msg.get("rows"))
            except Exception as e:  # noqa: BLE001 - said back to the person, in plain words
                self.send({"op": "closed", "ch": ch, "code": 1011, "reason": str(e)[:200]})
        elif op == "kill":
            if self.allowed.get("terminal"):
                kill_shell_session(str(msg.get("session") or "*"))
        elif op == "resize":
            # The terminal's window changed size: the shell takes it (the kernel tells the programs
            # in it with SIGWINCH, so full-screen ones redraw). Older servers never send this.
            ch = self.channels.get(int(msg.get("ch", 0)))
            if isinstance(ch, (Shell, ShellChannel)):
                ch.resize(msg.get("cols"), msg.get("rows"))
        elif op == "ack":
            ch = self.channels.get(int(msg.get("ch", 0)))
            if isinstance(ch, FileRead):
                ch.ack(msg.get("n"))
        elif op == "commit":
            ch = self.channels.get(int(msg.get("ch", 0)))
            if isinstance(ch, FileWrite):
                ch.commit()
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
            self._watched = True
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
            # Always on, like metrics: any powered-on computer can relay a wake packet.
            if name == "wol":
                data = wol_action(msg.get("args") or {})
                return self.send({"op": "result", "id": msg.get("id"), "ok": True, "data": data})
            if name == "app-install":
                data = app_install(msg.get("args") or {})
                return self.send({"op": "result", "id": msg.get("id"), "ok": True, "data": data})
            if name in FILES_ACTIONS:
                if not self.allowed.get("files"):
                    raise RuntimeError("This computer doesn’t allow files")
                data = FILES_ACTIONS[name](msg.get("args") or {})
                return self.send({"op": "result", "id": msg.get("id"), "ok": True, "data": data})
            if name in BACKUP_ACTIONS:
                if not self.allowed.get("backup"):
                    raise RuntimeError("This computer doesn’t allow backups")
                data = BACKUP_ACTIONS[name](self, msg.get("id"), msg.get("args") or {}, self.cfg)
                return self.send({"op": "result", "id": msg.get("id"), "ok": True, "data": data})
            if name in VM_ACTIONS or str(name).startswith("vm-"):
                data = vm_call(
                    name,
                    msg.get("args") or {},
                    allowed=self.allowed,
                    progress=lambda p: self.send({"op": "progress", "id": msg.get("id"), "percent": p, "step": "download"}),
                )
            elif name in LXC_ACTIONS or str(name).startswith("lxc-"):
                data = lxc_call(name, msg.get("args") or {})
            elif name in STORAGE_ACTIONS or str(name).startswith("storage-"):
                if not self.allowed.get("storage"):
                    raise RuntimeError("This computer doesn’t allow Storage")
                fn = STORAGE_ACTIONS.get(name)
                if not fn:
                    raise RuntimeError("Unknown action")
                data = fn(msg.get("args") or {})
            elif name in SERVICES_ACTIONS or str(name).startswith("services-"):
                if not self.allowed.get("services"):
                    raise RuntimeError("This computer doesn’t allow managing services")
                fn = SERVICES_ACTIONS.get(name)
                if not fn:
                    raise RuntimeError("Unknown action")
                data = fn(msg.get("args") or {})
            elif name in FILES_ACTIONS or str(name).startswith("files-"):
                if not self.allowed.get("files"):
                    raise RuntimeError("This computer doesn’t allow file access")
                fn = FILES_ACTIONS.get(name)
                if not fn:
                    raise RuntimeError("Unknown action")
                data = fn(msg.get("args") or {})
            else:
                if not self.allowed.get("manage"):
                    raise RuntimeError("This computer doesn’t allow managing")
                if name == "update-self":
                    data = update_self(msg.get("args") or {}, self.cfg)
                else:
                    fn = ACTIONS.get(name)
                    if not fn:
                        raise RuntimeError("Unknown action")
                    data = fn(msg.get("args") or {})
            self.send({"op": "result", "id": msg.get("id"), "ok": True, "data": data})
            if name in ("plugin-install", "plugin-remove", "theme-set"):
                self.send({"op": "hello", "info": info(self.allowed), "abilities": self.allowed})
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
        if IS_WINDOWS:
            subprocess.run(["schtasks", "/Delete", "/TN", "OmarchyConnector", "/F"], capture_output=True, timeout=30, creationflags=_WIN_NO_WINDOW)
        elif IS_MAC:
            plist = os.path.expanduser(f"~/Library/LaunchAgents/{MAC_LABEL}.plist")
            try:
                os.unlink(plist)
            except OSError:
                pass
            subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{MAC_LABEL}"], capture_output=True, timeout=30)
        elif shutil.which("systemctl"):
            subprocess.run(["systemctl", "--user", "disable", "--now", "--no-block", "omarchy-connector.service"], capture_output=True, timeout=30)
        elif shutil.which("rc-service"):
            subprocess.run(["rc-service", "omarchy-connector", "stop"], capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        pass  # not run by systemd (or no systemd): stopping is enough
    _backup_password_dir(True)
    os._exit(0)


# ---------------------------------------------------------------------------------------------
USAGE = """MODC connector: joins this Linux computer to a My Own Data Center local swarm.

  agent.py                                run the connector (after enrolling)
  agent.py enroll SERVER TOKEN [ABILITIES]
                                          join using a one-time pairing token
  agent.py info                           print machine facts and metrics as JSON
  agent.py -h | --help | help             show this help"""


def enroll(server, token, abilities):
    u = urllib.parse.urlsplit(server)
    if u.scheme != "https" or not u.hostname:
        raise SystemExit("The server address must start with https://")
    body = json.dumps({"token": token, "info": info(abilities), "abilities": abilities}).encode()
    try:
        ctx = _ssl_context(CA_FILE)
    except FileNotFoundError:
        raise SystemExit(f"Server certificate not found ({CA_FILE}). Run the install command from Machines → Local swarm → Add a computer.")
    except OSError as e:
        raise SystemExit(f"Couldn't read server certificate ({CA_FILE}): {e}")
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
        abilities = supported_abilities({k: k in args[3].split(",") for k in ABILITY_NAMES} if len(args) > 3 else {})
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
