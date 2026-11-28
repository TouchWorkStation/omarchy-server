import importlib.util
import json
import os
import tempfile
import unittest
from unittest.mock import patch

_dir = os.path.dirname(__file__)
_spec = importlib.util.spec_from_file_location("lxc_helper", os.path.join(_dir, "lxc-helper.py"))
lxc_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lxc_helper)


class LxcHelperNixos(unittest.TestCase):
    def test_write_config_creates_share(self):
        calls = []

        def fake_run(cmd, args, input=None, timeout=120):
            calls.append((cmd, args))
            return ""

        with tempfile.TemporaryDirectory() as tmp:
            env = {"XDG_DATA_HOME": tmp}
            with patch.dict(os.environ, env, clear=False):
                out = json.loads(
                    lxc_helper.write_nixos_config(
                        run=fake_run,
                        body={"name": "web", "configuration": "{ }\n", "cacheConf": "extra-substituters = http://x\n"},
                    )
                )
                self.assertTrue(out["ok"])
                root = os.path.join(tmp, "omarchy-connector", "nixos-configs", "web")
                self.assertEqual(out["path"], root)
                self.assertTrue(os.path.isdir(root))
                with open(os.path.join(root, "configuration.nix"), encoding="utf-8") as fh:
                    self.assertEqual(fh.read(), "{ }\n")
                with open(os.path.join(root, "nix-cache.conf"), encoding="utf-8") as fh:
                    self.assertIn("extra-substituters", fh.read())

    def test_read_config_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"XDG_DATA_HOME": tmp}, clear=False):
                out = json.loads(lxc_helper.read_nixos_config("app"))
                self.assertEqual(out, {"config": "", "present": False})

    def test_launch_nixos_share_adds_disk(self):
        calls = []

        def fake_run(cmd, args, input=None, timeout=120):
            calls.append(args)
            return ""

        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"XDG_DATA_HOME": tmp}, clear=False):
                with patch.object(lxc_helper, "incus_path", return_value="/usr/bin/incus"):
                    lxc_helper.launch_containers(
                        run=fake_run,
                        body={
                            "name": "nix1",
                            "source": "images:nixos/24.11",
                            "configs": ["security.nesting=true"],
                            "diskGiB": 8,
                            "nixosShare": True,
                        },
                    )
        self.assertTrue(any(a[0] == "launch" for a in calls))
        mount = next(a for a in calls if a[0] == "config" and "modc-nixos-config" in a)
        self.assertIn("readonly=true", mount)
        self.assertTrue(any(x.startswith("source=") for x in mount))


if __name__ == "__main__":
    unittest.main()