"""The connector's home-folder file channel: the jail, and the read window."""

import os
import stat
import tempfile
import threading
import time
import unittest

import agent


def wait_until(fn, seconds=2):
    end = time.time() + seconds
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.01)
    return last


class FakeWs:
    def __init__(self):
        self.binary = []
        self.lock = threading.Lock()

    def send_binary(self, data):
        with self.lock:
            self.binary.append(bytes(data))


class FakeConn:
    def __init__(self):
        self.messages = []
        self.ws = FakeWs()
        self.cv = threading.Condition()

    def send(self, msg):
        with self.cv:
            self.messages.append(msg)
            self.cv.notify_all()


class FilesJailTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.join(self.tmp.name, "home")
        self.config = os.path.join(self.home, ".config", "omarchy-connector")
        self.data = os.path.join(self.home, ".local", "share", "omarchy-connector")
        os.makedirs(self.config)
        os.makedirs(self.data)
        with open(os.path.join(self.config, "config.json"), "w", encoding="utf-8") as fh:
            fh.write('{"key":"secret"}')
        self.roots = {"home": self.home, "config": self.config, "data": self.data}

    def tearDown(self):
        self.tmp.cleanup()

    def resolve(self, rel, want):
        return agent.resolve_home(rel, want, **self.roots)

    def test_rejects_escape_and_empty(self):
        for rel in ("../etc/passwd", "/etc/passwd", "~/.ssh/id_rsa", "a/../../etc/passwd", "a\\b", "bad\x00name", "foo/../bar", ".", "..", "a/\x01/b"):
            with self.assertRaises(RuntimeError):
                agent.split_home_path(rel)
        self.assertEqual(agent.split_home_path("", allow_empty=True), [])
        with self.assertRaises(RuntimeError):
            agent.split_home_path("")

    def test_reads_a_file_and_a_symlink_that_stays_inside(self):
        path = os.path.join(self.home, "note.txt")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("hello")
        os.symlink("note.txt", os.path.join(self.home, "link.txt"))
        fd, st, _real, name = self.resolve("link.txt", "file")
        try:
            self.assertEqual(name, "link.txt")
            self.assertTrue(stat.S_ISREG(st.st_mode))
            self.assertEqual(os.read(fd, 20), b"hello")
        finally:
            os.close(fd)

    def test_refuses_a_symlink_that_leaves_home_or_points_at_the_connector(self):
        outside = os.path.join(self.tmp.name, "outside.txt")
        with open(outside, "w", encoding="utf-8") as fh:
            fh.write("nope")
        os.symlink(outside, os.path.join(self.home, "out.txt"))
        os.symlink(os.path.join(self.config, "config.json"), os.path.join(self.home, "pointer"))
        os.symlink(self.data, os.path.join(self.home, "datadir"))
        for rel in ("out.txt", "pointer", "datadir", self.config, "no-such-file"):
            with self.assertRaises(RuntimeError):
                self.resolve(rel if not rel.startswith("/") else "out.txt", "file")
        with self.assertRaises(RuntimeError):
            self.resolve("pointer", "any")

    def test_refuses_directories_fifos_and_the_connector_folders(self):
        os.mkdir(os.path.join(self.home, "docs"))
        os.mkfifo(os.path.join(self.home, "pipe"))
        with self.assertRaises(RuntimeError):
            self.resolve("docs", "file")
        with self.assertRaises(RuntimeError):
            self.resolve("pipe", "file")
        with self.assertRaises(RuntimeError):
            self.resolve(".config/omarchy-connector", "dir")
        with self.assertRaises(RuntimeError):
            self.resolve(".local/share/omarchy-connector/x", "file")

    def test_list_keeps_dotfiles_and_hides_the_connector(self):
        with open(os.path.join(self.home, ".bashrc"), "w", encoding="utf-8") as fh:
            fh.write("alias")
        os.mkdir(os.path.join(self.home, "docs"))
        os.symlink("/etc", os.path.join(self.home, "etc-link"))
        listed = agent.files_list({"path": ""}, **self.roots)
        names = [row["name"] for row in listed["entries"]]
        self.assertIn(".bashrc", names)
        self.assertIn("docs", names)
        self.assertNotIn("etc-link", names)
        nested = agent.files_list({"path": ".config"}, **self.roots)
        self.assertNotIn("omarchy-connector", [row["name"] for row in nested["entries"]])
        self.assertFalse(nested["truncated"])

    def test_list_stops_at_200(self):
        folder = os.path.join(self.home, "many")
        os.mkdir(folder)
        for n in range(205):
            with open(os.path.join(folder, f"f{n:03d}.txt"), "w", encoding="utf-8") as fh:
                fh.write("x")
        listed = agent.files_list({"path": "many"}, **self.roots)
        self.assertEqual(len(listed["entries"]), 200)
        self.assertTrue(listed["truncated"])

    def test_stat_reports_a_directory(self):
        os.mkdir(os.path.join(self.home, "docs"))
        row = agent.files_stat({"path": "docs"}, **self.roots)
        self.assertEqual(row["name"], "docs")
        self.assertTrue(row["dir"])
        self.assertEqual(row["size"], 0)

    def test_write_refuses_an_existing_name_and_links_a_new_one(self):
        taken = os.path.join(self.home, "taken.txt")
        with open(taken, "w", encoding="utf-8") as fh:
            fh.write("keep")
        with self.assertRaises(RuntimeError) as raised:
            agent.prepare_write("taken.txt", 3, **self.roots)
        self.assertIn("already there", str(raised.exception))
        self.assertEqual(open(taken, encoding="utf-8").read(), "keep")

        prep = agent.prepare_write("fresh.txt", 5, **self.roots)
        os.write(prep["fd"], b"hello")
        agent.commit_write(prep)
        path = os.path.join(self.home, "fresh.txt")
        self.assertEqual(open(path, "rb").read(), b"hello")
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertFalse(any(name.startswith(".incoming.") for name in os.listdir(self.home)))

    def test_commit_loses_the_race_and_leaves_the_existing_file(self):
        prep = agent.prepare_write("race.txt", 4, **self.roots)
        os.write(prep["fd"], b"abcd")
        with open(os.path.join(self.home, "race.txt"), "w", encoding="utf-8") as fh:
            fh.write("there")
        with self.assertRaises(RuntimeError) as raised:
            agent.commit_write(prep)
        self.assertIn("already there", str(raised.exception))
        self.assertEqual(open(os.path.join(self.home, "race.txt"), encoding="utf-8").read(), "there")
        self.assertFalse(any(name.startswith(".incoming.") for name in os.listdir(self.home)))

    def test_empty_write_and_abort(self):
        prep = agent.prepare_write("empty.txt", 0, **self.roots)
        agent.commit_write(prep)
        self.assertEqual(os.path.getsize(os.path.join(self.home, "empty.txt")), 0)
        for size in (-1, True, 1.5, "3"):
            with self.assertRaises(RuntimeError):
                agent.prepare_write("nope.txt", size, **self.roots)
        prep = agent.prepare_write("gone.txt", 2, **self.roots)
        agent.abort_write(prep)
        agent.abort_write(prep)
        self.assertFalse(os.path.exists(os.path.join(self.home, "gone.txt")))
        self.assertFalse(any(name.startswith(".incoming.") for name in os.listdir(self.home)))

    def test_write_follows_a_directory_symlink_that_stays_inside(self):
        os.mkdir(os.path.join(self.home, "real"))
        os.symlink("real", os.path.join(self.home, "linkdir"))
        prep = agent.prepare_write("linkdir/a.txt", 3, **self.roots)
        os.write(prep["fd"], b"yes")
        agent.commit_write(prep)
        self.assertEqual(open(os.path.join(self.home, "real", "a.txt"), "rb").read(), b"yes")


class FileChannelTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.join(self.tmp.name, "home")
        self.config = os.path.join(self.tmp.name, "config")
        self.data = os.path.join(self.tmp.name, "data")
        os.makedirs(self.home)
        os.makedirs(self.config)
        os.makedirs(self.data)
        self.roots = {"home": self.home, "config": self.config, "data": self.data}

    def tearDown(self):
        self.tmp.cleanup()

    def test_read_pauses_after_four_chunks_until_acks(self):
        payload = os.urandom(300 * 1024)
        with open(os.path.join(self.home, "big.bin"), "wb") as fh:
            fh.write(payload)
        conn = FakeConn()
        reader = agent.FileRead(conn, 3, "big.bin", **self.roots)
        self.assertTrue(wait_until(lambda: len(conn.ws.binary) >= 4))
        time.sleep(0.2)
        self.assertEqual(len(conn.ws.binary), 4)
        for _ in range(4):
            reader.ack(1)
        self.assertTrue(wait_until(lambda: any(msg.get("op") == "closed" for msg in conn.messages)))
        body = b"".join(frame[4:] for frame in conn.ws.binary)
        self.assertEqual(body, payload)
        closed = [msg for msg in conn.messages if msg.get("op") == "closed"]
        self.assertEqual(closed, [{"op": "closed", "ch": 3, "reason": "", "code": 1000}])
        meta = conn.messages[0]
        self.assertEqual(meta["op"], "file")
        self.assertEqual(meta["size"], len(payload))

    def test_empty_read_closes_without_bytes(self):
        open(os.path.join(self.home, "empty.txt"), "wb").close()
        conn = FakeConn()
        agent.FileRead(conn, 1, "empty.txt", **self.roots)
        self.assertTrue(wait_until(lambda: any(msg.get("op") == "closed" for msg in conn.messages)))
        self.assertEqual(conn.ws.binary, [])
        self.assertEqual(conn.messages[-1]["code"], 1000)

    def test_write_channel_commits_and_a_short_file_is_removed(self):
        conn = FakeConn()
        writer = agent.FileWrite(conn, 8, "out.txt", 5, **self.roots)
        self.assertTrue(any(msg.get("ready") is True for msg in conn.messages))
        writer.write(b"hello")
        self.assertEqual(conn.messages[-1], {"op": "ack", "ch": 8})
        writer.commit()
        self.assertTrue(wait_until(lambda: any(msg.get("op") == "closed" for msg in conn.messages)))
        self.assertEqual(open(os.path.join(self.home, "out.txt"), "rb").read(), b"hello")
        self.assertEqual([msg for msg in conn.messages if msg.get("op") == "closed"][-1]["code"], 1000)

        conn = FakeConn()
        writer = agent.FileWrite(conn, 9, "short.txt", 5, **self.roots)
        writer.write(b"hi")
        writer.commit()
        self.assertTrue(wait_until(lambda: any(msg.get("code") == 1011 for msg in conn.messages)))
        self.assertFalse(os.path.exists(os.path.join(self.home, "short.txt")))
        self.assertFalse(any(name.startswith(".incoming.") for name in os.listdir(self.home)))
        self.assertIn("short", conn.messages[-1]["reason"])

    def test_an_oversized_chunk_and_close_remove_the_temporary_file(self):
        conn = FakeConn()
        writer = agent.FileWrite(conn, 2, "big.txt", 10, **self.roots)
        writer.write(b"x" * (1024 * 1024 + 1))
        self.assertTrue(wait_until(lambda: any(msg.get("code") == 1011 for msg in conn.messages)))
        self.assertIn("larger", conn.messages[-1]["reason"])
        self.assertFalse(any(name.startswith(".incoming.") for name in os.listdir(self.home)))

        conn = FakeConn()
        writer = agent.FileWrite(conn, 4, "partial.txt", 10, **self.roots)
        writer.write(b"abcd")
        writer.close()
        self.assertFalse(os.path.exists(os.path.join(self.home, "partial.txt")))
        self.assertFalse(any(name.startswith(".incoming.") for name in os.listdir(self.home)))

    def test_handle_refuses_files_that_were_not_allowed(self):
        class Stub:
            def __init__(self, allowed):
                self.allowed = allowed
                self.channels = {}
                self.sent = []

            def send(self, msg):
                self.sent.append(msg)

        refused = Stub({})
        agent.Connection.handle(refused, {"op": "open", "ch": 1, "kind": "file", "mode": "read", "path": "note.txt"})
        self.assertEqual(refused.channels, {})
        self.assertEqual(refused.sent[-1]["code"], 1011)
        self.assertIn("doesn’t allow files", refused.sent[-1]["reason"])

        escaped = Stub({"files": True})
        agent.Connection.handle(escaped, {"op": "open", "ch": 2, "kind": "file", "mode": "read", "path": "../etc/passwd"})
        self.assertNotIn(2, escaped.channels)
        self.assertEqual(escaped.sent[-1]["code"], 1011)

        vague = Stub({"files": True})
        agent.Connection.handle(vague, {"op": "open", "ch": 3, "kind": "file", "path": "note.txt"})
        self.assertIn("read or write", vague.sent[-1]["reason"])


if __name__ == "__main__":
    unittest.main()
