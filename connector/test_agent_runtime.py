import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import agent  # noqa: E402


class ReportHelloInterval(unittest.TestCase):
    # #432: refresh hello once every 5 minutes, not 3-4 times per 10s window.
    def test_hello_sent_once_per_300_seconds(self):
        conn = agent.Connection({"abilities": {}})
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        last_hello = 0.0
        with mock.patch.object(agent, "info", return_value={"hostname": "box"}):
            for step in range(1, 3001):
                t = float(step * 3)
                last_hello = conn._report_step(sampler, last_hello, t)
        hellos = [m for m in sent if m.get("op") == "hello"]
        self.assertEqual(len(hellos), 30)

    def test_no_burst_after_300_second_mark(self):
        conn = agent.Connection({"abilities": {}})
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        last_hello = 0.0
        with mock.patch.object(agent, "info", return_value={"hostname": "box"}):
            for t in (297.0, 300.0, 303.0, 306.0, 309.0):
                last_hello = conn._report_step(sampler, last_hello, t)
        self.assertEqual(len([m for m in sent if m.get("op") == "hello"]), 1)
        self.assertEqual(last_hello, 300.0)


if __name__ == "__main__":
    unittest.main()
