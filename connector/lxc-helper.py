#!/usr/bin/env python3
"""Per-user Incus helper for swarm computers. Runs as the connector user: no sudo, no shell."""
import json
import os
import re
import shutil
import subprocess
import sys

VERBS = frozenset(("status", "list", "launch", "start", "stop", "restart", "force-stop", "delete", "write-config", "read-config"))
ARITY = {
    "status": (0, 0),
    "list": (0, 0),
    "launch": (0, 0),
    "start": (1, 1),
    "stop": (1, 1),
    "restart": (1, 1),
    "force-stop": (1, 1),
    "delete": (1, 1),
    "write-config": (0, 0),
    "read-config": (1, 1),
}
NIXOS_GUEST_MOUNT = "/modc/nixos-config"
NAME = re.compile(r"^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$")
SETUP = "machines-add-lxc"


class HelperError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def default_run(cmd, args, input=None, timeout=120):
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    try:
        kw = {"capture_output": True, "text": True, "timeout": timeout, "env": env}
        if input is None:
            kw["stdin"] = subprocess.DEVNULL
        else:
            kw["input"] = input
        r = subprocess.run([cmd, *args], **kw)
    except FileNotFoundError:
        raise HelperError("%s is not installed" % cmd)
    except subprocess.TimeoutExpired:
        raise HelperError("%s took too long" % cmd)
    if r.returncode:
        err = (r.stderr or r.stdout or "%s failed" % cmd).strip().split("\n")[-1]
        raise HelperError(err[:300])
    return r.stdout or ""


def incus_path():
    return shutil.which("incus") or "incus"


def status_report(run=None):
    run = run or default_run
    incus = incus_path()
    try:
        out = run(incus, ["query", "/1.0"], timeout=10)
        info = json.loads(out) if out.strip() else {}
        env = info.get("environment") or {}
        return json.dumps(
            {
                "available": True,
                "version": env.get("server_version"),
                "project": env.get("project"),
            }
        )
    except HelperError as e:
        text = e.message or ""
        if "not installed" in text:
            reason = "Incus isn’t installed on this computer yet."
        elif re.search(r"permission denied", text, re.I):
            reason = "This account can’t reach Incus yet. Run the setup below again."
        elif re.search(r"no such file|connection refused|unix\.socket", text, re.I):
            reason = "Incus is installed but its per-user service isn’t running."
        else:
            reason = text or "Incus isn’t ready on this computer."
        return json.dumps({"available": False, "reason": reason, "setupCommand": SETUP})
    except (json.JSONDecodeError, TypeError, ValueError):
        return json.dumps({"available": True, "version": None, "project": None})


def list_containers(run=None):
    run = run or default_run
    incus = incus_path()
    out = run(incus, ["list", "--format", "json"], timeout=20)
    try:
        rows = json.loads(out)
    except (json.JSONDecodeError, TypeError):
        raise HelperError("Incus gave a list this helper couldn’t read")
    if not isinstance(rows, list):
        rows = []
    return json.dumps([c for c in rows if isinstance(c, dict) and c.get("type") == "container"])


def valid_name(name):
    if not isinstance(name, str) or not NAME.match(name):
        raise HelperError("That container name isn’t valid")


def config_root(name):
    valid_name(name)
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(base, "omarchy-connector", "nixos-configs", name)


def write_nixos_config(run=None, body=None):
    run = run or default_run
    if not isinstance(body, dict):
        raise HelperError("Unknown action")
    name = body.get("name")
    valid_name(name)
    root = config_root(name)
    os.makedirs(root, mode=0o700, exist_ok=True)
    configuration = body.get("configuration")
    if configuration is not None:
        if not isinstance(configuration, str):
            raise HelperError("Unknown action")
        if configuration and not configuration.endswith("\n"):
            configuration += "\n"
        with open(os.path.join(root, "configuration.nix"), "w", encoding="utf-8") as fh:
            fh.write(configuration)
    cache_conf = body.get("cacheConf")
    cache_path = os.path.join(root, "nix-cache.conf")
    if cache_conf is not None:
        if not isinstance(cache_conf, str):
            raise HelperError("Unknown action")
        if cache_conf.strip():
            with open(cache_path, "w", encoding="utf-8") as fh:
                fh.write(cache_conf if cache_conf.endswith("\n") else cache_conf + "\n")
        elif os.path.isfile(cache_path):
            os.remove(cache_path)
    return json.dumps({"ok": True, "path": root})


def read_nixos_config(name=None):
    valid_name(name)
    root = config_root(name)
    cfg_path = os.path.join(root, "configuration.nix")
    if not os.path.isfile(cfg_path):
        return json.dumps({"config": "", "present": False})
    with open(cfg_path, encoding="utf-8") as fh:
        return json.dumps({"config": fh.read(), "present": True})


def launch_containers(run=None, body=None):
    run = run or default_run
    incus = incus_path()
    if not isinstance(body, dict):
        raise HelperError("Unknown action")
    name = body.get("name")
    source = body.get("source")
    configs = body.get("configs") or []
    disk = body.get("diskGiB", 8)
    valid_name(name)
    if not isinstance(source, str) or not source or len(source) > 200:
        raise HelperError("Pick a system from the library")
    if not isinstance(configs, list):
        raise HelperError("Unknown action")
    try:
        disk_gib = int(disk)
    except (TypeError, ValueError):
        raise HelperError("Use 1 to 4096 GB of disk")
    if disk_gib < 1 or disk_gib > 4096:
        raise HelperError("Use 1 to 4096 GB of disk")
    args = ["launch", source, name]
    for cfg in configs:
        if not isinstance(cfg, str) or not cfg or len(cfg) > 200:
            raise HelperError("Unknown action")
        args.extend(["--config", cfg])
    args.extend(["--device", "root,size=%dGiB" % disk_gib])
    run(incus, args, timeout=20 * 60)
    if body.get("nixosShare"):
        share_dir = config_root(name)
        os.makedirs(share_dir, mode=0o700, exist_ok=True)
        run(
            incus,
            [
                "config",
                "device",
                "add",
                name,
                "modc-nixos-config",
                "disk",
                "source=" + share_dir,
                "path=" + NIXOS_GUEST_MOUNT,
                "readonly=true",
            ],
            timeout=120,
        )
    return json.dumps({"name": name})


def power_verb(run, verb, name):
    valid_name(name)
    incus = incus_path()
    if verb == "force-stop":
        run(incus, ["stop", name, "--force"], timeout=120)
        return json.dumps({"ok": True})
    timeout = 90 if verb == "restart" else 120
    extra = ["--timeout", "60"] if verb in ("stop", "restart") else []
    run(incus, [verb, name, *extra], timeout=timeout)
    return json.dumps({"ok": True})


def delete_container(run=None, name=None):
    run = run or default_run
    valid_name(name)
    run(incus_path(), ["delete", name, "--force"], timeout=120)
    return json.dumps({"ok": True})


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in VERBS:
        sys.stderr.write("Unknown action\n")
        return 2
    verb = sys.argv[1]
    lo, hi = ARITY[verb]
    pos = sys.argv[2 : 2 + hi]
    if len(pos) < lo:
        sys.stderr.write("Unknown action\n")
        return 2
    body = None
    if verb in ("launch", "write-config"):
        raw = sys.stdin.read()
        try:
            body = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            sys.stderr.write("Unknown action\n")
            return 2
    try:
        if verb == "status":
            sys.stdout.write(status_report())
        elif verb == "list":
            sys.stdout.write(list_containers())
        elif verb == "launch":
            sys.stdout.write(launch_containers(body=body))
        elif verb == "write-config":
            sys.stdout.write(write_nixos_config(body=body))
        elif verb == "read-config":
            sys.stdout.write(read_nixos_config(name=pos[0]))
        elif verb == "delete":
            sys.stdout.write(delete_container(name=pos[0]))
        else:
            sys.stdout.write(power_verb(default_run, verb, pos[0]))
    except HelperError as e:
        sys.stderr.write(e.message + "\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())