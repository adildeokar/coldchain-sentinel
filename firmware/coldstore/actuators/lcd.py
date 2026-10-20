"""16x2 character LCD with a PCF8574 I2C backpack (address 0x27).

Wiring: SDA → GPIO2 (pin 3), SCL → GPIO3 (pin 5), VCC → 5V (pin 4), GND → pin 6.
Most backpacks pull SDA/SCL up to VCC; remove those pull-ups or use a level
shifter so the Pi's 3.3 V I2C pins never see 5 V.

Shows the reading and the device state so staff at the door can read it with
no phone and no internet:

    +----------------+
    |T: 4.3C H: 55%  |
    |OK  ONLINE  Q:0 |
    +----------------+
"""
from __future__ import annotations

import logging

log = logging.getLogger("coldstore.lcd")


def render(temp_c, rh_pct, status: str, online: bool, backlog: int, alarm: str | None = None) -> tuple[str, str]:
    t = "--.-" if temp_c is None else f"{temp_c:4.1f}"
    h = "--" if rh_pct is None else f"{rh_pct:2.0f}"
    line1 = f"T:{t}C H:{h}%"
    if alarm:
        line2 = f"ALARM {alarm}"
    else:
        line2 = f"{status:<4}{'ONLINE' if online else 'OFFLN'} Q:{backlog}"
    return line1[:16].ljust(16), line2[:16].ljust(16)


class LCD:
    def __init__(self, address: int = 0x27, simulate: bool = False):
        self._lcd = None
        self._last = ("", "")
        if not simulate:
            try:
                from RPLCD.i2c import CharLCD
                self._lcd = CharLCD("PCF8574", address, cols=16, rows=2)
            except Exception as exc:              # LCD is optional; never stop monitoring because of it
                log.warning("LCD unavailable (%s) — continuing without display", exc)

    def show(self, line1: str, line2: str):
        if (line1, line2) == self._last:
            return
        self._last = (line1, line2)
        if self._lcd:
            self._lcd.cursor_pos = (0, 0)
            self._lcd.write_string(line1)
            self._lcd.cursor_pos = (1, 0)
            self._lcd.write_string(line2)
        else:
            log.debug("LCD |%s|%s|", line1, line2)
