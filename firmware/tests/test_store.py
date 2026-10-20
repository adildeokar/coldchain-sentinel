"""Store-and-forward tests: nothing is lost across an outage or a restart."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coldstore.models import Reading
from coldstore.store import Store


def reading(store, ts):
    return Reading(seq=store.next_seq(), ts=ts, temp_c=4.0, rh_pct=55, ds18b20_c=4.0, dht22_c=4.1, door_open=False)


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.path = str(Path(self.dir.name) / "q.db")

    def tearDown(self):
        self.dir.cleanup()

    def test_outage_then_sync_loses_nothing(self):
        s = Store(self.path)
        for i in range(120):                      # 10 minutes offline at 5 s
            s.add_reading(reading(s, 1000 + i * 5), "dev", "1")
        self.assertEqual(s.pending_count(), 120)
        while True:
            rows = s.pending(50)
            if not rows:
                break
            s.mark_sent([q for q, _ in rows])     # as if PUBACK arrived
        self.assertEqual(s.pending_count(), 0)
        self.assertEqual(s.dropped, 0)

    def test_queue_survives_restart(self):
        s = Store(self.path)
        for i in range(10):
            s.add_reading(reading(s, 1000 + i), "dev", "1")
        s.close()
        s2 = Store(self.path)                      # simulated reboot
        self.assertEqual(s2.pending_count(), 10)
        self.assertEqual(s2.next_seq(), 11)        # sequence numbers continue, so the cloud can de-duplicate

    def test_capacity_drops_oldest_pending(self):
        s = Store(self.path, capacity_rows=5)
        for i in range(8):
            s.add_reading(reading(s, 1000 + i), "dev", "1")
        self.assertEqual(s.pending_count(), 5)
        self.assertEqual(s.dropped, 3)
        self.assertEqual(s.pending(1)[0][0], 4)    # seq 1–3 were the ones dropped

    def test_sent_rows_are_evicted_before_pending(self):
        s = Store(self.path, capacity_rows=5)
        for i in range(5):
            s.add_reading(reading(s, 1000 + i), "dev", "1")
        s.mark_sent([1, 2, 3])
        for i in range(3):
            s.add_reading(reading(s, 2000 + i), "dev", "1")
        self.assertEqual(s.dropped, 0)
        self.assertEqual(s.pending_count(), 5)

    def test_alerts_are_queued_once(self):
        s = Store(self.path)
        s.add_alert("AL-1", "RAISED", {"a": 1})
        s.add_alert("AL-1", "RAISED", {"a": 1})
        self.assertEqual(len(s.pending_alerts()), 1)
        s.mark_alert_sent("AL-1", "RAISED")
        self.assertEqual(s.pending_alerts(), [])


if __name__ == "__main__":
    unittest.main()
