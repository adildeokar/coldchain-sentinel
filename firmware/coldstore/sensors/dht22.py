"""DHT22 / AM2302 temperature + relative-humidity sensor.

Wiring: VCC → 3V3 (pin 1), DATA → GPIO17 (pin 11) with a 10 kΩ pull-up to 3V3,
GND → pin 9. Accuracy ±0.5 °C, ±2 %RH. Range −40…80 °C, 0…100 %RH.

The single-wire protocol is timing critical and Linux is not real-time, so a
few percent of reads fail with a checksum error. The driver retries, and the
datasheet requires at least 2 s between reads.
"""
from __future__ import annotations

import logging
import time
from typing import Optional, Tuple

log = logging.getLogger("coldstore.dht22")

MIN_READ_INTERVAL_S = 2.0


class DHT22:
    def __init__(self, bcm_pin: int = 17, retries: int = 3):
        import adafruit_dht  # pip install adafruit-circuitpython-dht
        import board
        self._dev = adafruit_dht.DHT22(getattr(board, f"D{bcm_pin}"), use_pulseio=False)
        self._retries = retries
        self._last_read = 0.0
        self.errors = 0

    def read(self) -> Tuple[Optional[float], Optional[float]]:
        """Return (temp_c, rh_pct); (None, None) after all retries fail."""
        for attempt in range(1, self._retries + 1):
            wait = MIN_READ_INTERVAL_S - (time.monotonic() - self._last_read)
            if wait > 0 and attempt > 1:
                time.sleep(wait)
            self._last_read = time.monotonic()
            try:
                t, h = self._dev.temperature, self._dev.humidity
                if t is not None and h is not None and -40 <= t <= 80 and 0 <= h <= 100:
                    return round(t, 1), round(h, 1)
            except RuntimeError as exc:  # checksum / timing errors are normal for DHT sensors
                self.errors += 1
                log.debug("DHT22 read failed (%s), retry %d/%d", exc, attempt, self._retries)
        log.warning("DHT22: no valid reading after %d attempts", self._retries)
        return None, None

    def close(self):
        self._dev.exit()
