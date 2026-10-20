"""DS18B20 waterproof temperature probe on the 1-Wire bus.

Wiring: red → 3V3, black → GND, yellow (DATA) → GPIO4 (pin 7) with a 4.7 kΩ
pull-up to 3V3. Enable the bus with `dtoverlay=w1-gpio,gpiopin=4` in
/boot/firmware/config.txt. Accuracy ±0.5 °C from −10 to +85 °C, 12-bit
resolution (0.0625 °C), 750 ms conversion time.

The kernel exposes each probe at /sys/bus/w1/devices/28-xxxxxxxxxxxx/w1_slave:

    72 01 4b 46 7f ff 0e 10 57 : crc=57 YES
    72 01 4b 46 7f ff 0e 10 57 t=23125
"""
from __future__ import annotations

import glob
import logging
from typing import Optional

log = logging.getLogger("coldstore.ds18b20")

W1_GLOB = "/sys/bus/w1/devices/28-*/w1_slave"
POWER_ON_RESET_C = 85.0   # value the chip reports if it was read before a conversion finished


def parse_w1_slave(text: str) -> Optional[float]:
    """Parse the two-line sysfs output. Returns None on CRC failure or reset value."""
    lines = text.strip().splitlines()
    if len(lines) < 2 or not lines[0].endswith("YES"):
        return None                                    # CRC mismatch: wiring or pull-up problem
    pos = lines[1].find("t=")
    if pos < 0:
        return None
    temp = int(lines[1][pos + 2:]) / 1000.0
    if temp == POWER_ON_RESET_C or temp <= -127:       # -127 = device not responding
        return None
    return round(temp, 2)


class DS18B20:
    def __init__(self, device_file: str | None = None):
        if device_file is None:
            found = glob.glob(W1_GLOB)
            if not found:
                raise RuntimeError("No DS18B20 found — is dtoverlay=w1-gpio enabled and the probe wired?")
            device_file = found[0]
        self.device_file = device_file
        self.errors = 0

    def read(self) -> Optional[float]:
        try:
            with open(self.device_file) as fh:
                value = parse_w1_slave(fh.read())
        except OSError as exc:                          # probe unplugged → file disappears
            log.warning("DS18B20 read error: %s", exc)
            value = None
        if value is None:
            self.errors += 1
        return value
