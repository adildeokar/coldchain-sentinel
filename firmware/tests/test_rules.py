"""Unit tests for the local rule engine:  python -m unittest discover -s tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coldstore.config import Thresholds, Config, apply_desired
from coldstore.models import Reading
from coldstore.rules import AlarmEngine, fuse


def r(seq, t, h=55.0, ds=None, dht=None):
    ds = t if ds is None else ds
    dht = t if dht is None else dht
    return Reading(seq=seq, ts=1000.0 + seq * 5, temp_c=t, rh_pct=h, ds18b20_c=ds, dht22_c=dht, door_open=False)


class RuleEngineTest(unittest.TestCase):
    def setUp(self):
        self.e = AlarmEngine(Thresholds())

    def test_single_spike_is_filtered(self):
        self.assertEqual(self.e.evaluate(r(1, 8.4), 0), [])
        self.assertEqual(self.e.evaluate(r(2, 7.0), 0), [])
        self.assertNotIn("HIGH_TEMP", self.e.active_alarms())

    def test_raise_after_delay_samples(self):
        self.e.evaluate(r(1, 8.3), 0)
        ev = self.e.evaluate(r(2, 8.5), 0)
        self.assertEqual([(a.alarm, a.state) for a in ev], [("HIGH_TEMP", "RAISED")])
        self.assertEqual(ev[0].first_breach_at, 1005.0)       # first out-of-range sample, not the decision time
        self.assertEqual(ev[0].raised_at, 1010.0)

    def test_hysteresis_prevents_chatter(self):
        for i, t in enumerate([8.3, 8.4, 7.9, 7.8], 1):        # 7.9 / 7.8 are inside limit but not by 0.3
            self.e.evaluate(r(i, t), 0)
        self.assertIn("HIGH_TEMP", self.e.active_alarms())
        ev = self.e.evaluate(r(5, 7.6), 0)
        self.assertEqual([(a.alarm, a.state) for a in ev], [("HIGH_TEMP", "CLEARED")])

    def test_low_temp_and_status(self):
        self.e.evaluate(r(1, 1.5), 0)
        self.e.evaluate(r(2, 1.4), 0)
        self.assertEqual(self.e.status(1.4), "ALARM")

    def test_warn_band(self):
        reading = r(1, 7.7)
        self.e.evaluate(reading, 0)
        self.assertEqual(reading.status, "WARN")

    def test_humidity_is_warning_severity(self):
        self.e.evaluate(r(1, 5, h=80), 0)
        ev = self.e.evaluate(r(2, 5, h=81), 0)
        self.assertEqual(ev[0].alarm, "HIGH_RH")
        self.assertEqual(ev[0].severity, "warning")

    def test_door_open_too_long(self):
        self.assertEqual(self.e.evaluate(r(1, 5), 60), [])
        ev = self.e.evaluate(r(2, 5), 125)
        self.assertEqual(ev[0].alarm, "DOOR_OPEN")
        ev = self.e.evaluate(r(3, 5), 0)
        self.assertEqual(ev[0].state, "CLEARED")

    def test_sensor_fault_and_fallback(self):
        self.assertEqual(fuse(None, 4.2), 4.2)
        self.assertEqual(fuse(4.0, 4.2), 4.0)
        reading = Reading(1, 1005, None, None, None, None, False)
        self.e.evaluate(reading, 0)
        reading = Reading(2, 1010, None, None, None, None, False)
        ev = self.e.evaluate(reading, 0)
        self.assertEqual(ev[0].alarm, "SENSOR_FAULT")
        self.assertEqual(reading.status, "FAULT")

    def test_twin_patch_changes_limits(self):
        cfg = Config()
        changed = apply_desired(cfg, {"thresholds": {"temp_max_c": 6.5}, "sampleIntervalSec": 10})
        self.assertEqual(set(changed), {"thresholds.temp_max_c", "sampleIntervalSec"})
        self.assertEqual(cfg.thresholds.temp_max_c, 6.5)
        apply_desired(cfg, {"profile": "frozen"})
        self.assertEqual(cfg.thresholds.temp_max_c, -15.0)


if __name__ == "__main__":
    unittest.main()
