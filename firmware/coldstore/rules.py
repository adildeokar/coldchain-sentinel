"""Local rule engine — decides OK / WARN / ALARM on the Pi with no cloud involved.

Every alarm channel is a tiny state machine:

    NORMAL --(out of range for N consecutive samples)--> ACTIVE   ⇒ emit RAISED
    ACTIVE --(back inside limit minus hysteresis)------> NORMAL   ⇒ emit CLEARED

N (alarm_delay_samples) filters single noisy samples and short door openings;
the hysteresis stops the alarm chattering when the value sits on the limit.
The browser simulator runs the same logic in js/sim/rules.js.
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass
from typing import Callable, Optional

from .config import Thresholds
from .models import Alert, Reading

CRITICAL = {"HIGH_TEMP", "LOW_TEMP", "SENSOR_FAULT"}


@dataclass
class Channel:
    name: str
    count: int = 0
    active: bool = False
    first_breach_at: float = 0.0
    alert_id: Optional[str] = None
    peak: Optional[float] = None


class AlarmEngine:
    def __init__(self, thresholds: Thresholds, id_factory: Callable[[], str] | None = None):
        self.th = thresholds
        counter = itertools.count(1)
        self._new_id = id_factory or (lambda: f"AL-{next(counter):05d}")
        self.channels = {n: Channel(n) for n in
                         ("HIGH_TEMP", "LOW_TEMP", "HIGH_RH", "LOW_RH", "DOOR_OPEN", "SENSOR_FAULT", "SENSOR_DISAGREE")}

    # ---- helpers -----------------------------------------------------------
    def _step(self, ch: Channel, out: bool, cleared: bool, value, threshold, ts: float,
              delay: int, events: list):
        if not ch.active:
            if out:
                ch.count += 1
                if ch.count == 1:
                    ch.first_breach_at = ts
                if ch.count >= delay:
                    ch.active, ch.alert_id, ch.peak = True, self._new_id(), value
                    events.append(Alert(ch.alert_id, ch.name, "RAISED",
                                        "critical" if ch.name in CRITICAL else "warning",
                                        value, threshold, raised_at=ts, first_breach_at=ch.first_breach_at))
            else:
                ch.count = 0
        else:
            if value is not None and ch.peak is not None:
                ch.peak = max(ch.peak, value) if ch.name.startswith("HIGH") else min(ch.peak, value)
            if cleared:
                events.append(Alert(ch.alert_id, ch.name, "CLEARED",
                                    "critical" if ch.name in CRITICAL else "warning",
                                    value, threshold, raised_at=ts, first_breach_at=ch.first_breach_at))
                ch.active, ch.count, ch.alert_id = False, 0, None

    # ---- public API --------------------------------------------------------
    def evaluate(self, r: Reading, door_open_s: float) -> list[Alert]:
        th, ev, n = self.th, [], self.th.alarm_delay_samples
        t, h = r.temp_c, r.rh_pct
        c = self.channels

        if t is not None:
            self._step(c["HIGH_TEMP"], t > th.temp_max_c, t <= th.temp_max_c - th.temp_hysteresis_c,
                       t, th.temp_max_c, r.ts, n, ev)
            self._step(c["LOW_TEMP"], t < th.temp_min_c, t >= th.temp_min_c + th.temp_hysteresis_c,
                       t, th.temp_min_c, r.ts, n, ev)
        if h is not None:
            self._step(c["HIGH_RH"], h > th.rh_max_pct, h <= th.rh_max_pct - th.rh_hysteresis_pct,
                       h, th.rh_max_pct, r.ts, n, ev)
            self._step(c["LOW_RH"], h < th.rh_min_pct, h >= th.rh_min_pct + th.rh_hysteresis_pct,
                       h, th.rh_min_pct, r.ts, n, ev)

        self._step(c["DOOR_OPEN"], door_open_s > th.door_open_max_s, door_open_s == 0,
                   round(door_open_s), th.door_open_max_s, r.ts, 1, ev)

        both_dead = r.ds18b20_c is None and r.dht22_c is None
        self._step(c["SENSOR_FAULT"], both_dead, not both_dead, None, None, r.ts, n, ev)

        if r.ds18b20_c is not None and r.dht22_c is not None:
            diff = abs(r.ds18b20_c - r.dht22_c)
            self._step(c["SENSOR_DISAGREE"], diff > th.sensor_disagree_c, diff <= th.sensor_disagree_c * 0.7,
                       round(diff, 2), th.sensor_disagree_c, r.ts, n * 3, ev)

        r.alarms = [ch.name for ch in c.values() if ch.active]
        r.status = self.status(t)
        return ev

    def status(self, t: Optional[float]) -> str:
        active = [ch.name for ch in self.channels.values() if ch.active]
        if any(a in CRITICAL and a != "SENSOR_FAULT" for a in active):
            return "ALARM"
        if "SENSOR_FAULT" in active:
            return "FAULT"
        if active:
            return "WARN"
        if t is not None and (t > self.th.temp_max_c - self.th.warn_margin_c or
                              t < self.th.temp_min_c + self.th.warn_margin_c):
            return "WARN"
        return "OK"

    def active_alarms(self) -> list[str]:
        return [ch.name for ch in self.channels.values() if ch.active]


def fuse(ds18b20_c: Optional[float], dht22_c: Optional[float]) -> Optional[float]:
    """The DS18B20 probe is the primary sensor (better accuracy, no checksum
    failures). The DHT22 temperature is the fallback if the probe fails."""
    if ds18b20_c is not None:
        return ds18b20_c
    return dht22_c
