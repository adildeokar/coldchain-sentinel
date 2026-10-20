"""Magnetic reed switch on the cold-room door.

Wiring: one lead → GPIO27 (pin 13), other lead → GND (pin 14). The internal
pull-up holds the pin HIGH; with the door closed the magnet closes the switch
and pulls the pin LOW. So: LOW = closed, HIGH = open.
"""
from __future__ import annotations

import time


class DoorSensor:
    def __init__(self, bcm_pin: int = 27):
        from gpiozero import Button
        # bounce_time filters contact chatter when the door slams
        self._sw = Button(bcm_pin, pull_up=True, bounce_time=0.05)
        self._opened_at: float | None = None
        self._sw.when_released = self._on_open    # switch opens → pin goes HIGH
        self._sw.when_pressed = self._on_close
        if not self._sw.is_pressed:
            self._opened_at = time.time()

    def _on_open(self):
        self._opened_at = time.time()

    def _on_close(self):
        self._opened_at = None

    @property
    def is_open(self) -> bool:
        return not self._sw.is_pressed

    def open_for_s(self) -> float:
        return 0.0 if self._opened_at is None else time.time() - self._opened_at
