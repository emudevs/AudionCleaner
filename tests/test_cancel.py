"""Regression: cancellation interrupts a silent child process on every OS."""
from __future__ import annotations
import sys
import threading
import time
import unittest

from processor import _run, Cancelled


class CancelTests(unittest.TestCase):
    def test_cancels_silent_child(self):
        cancel = threading.Event()
        timer = threading.Timer(.65, cancel.set)
        started = time.monotonic()
        timer.start()
        try:
            with self.assertRaises(Cancelled):
                _run([sys.executable, "-u", "-c", "import time;time.sleep(30)"],
                     lambda line: None, cancel)
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - started, 8.0,
                        "Cancellation failed to interrupt blocked stdout read")


if __name__ == "__main__":
    unittest.main()
