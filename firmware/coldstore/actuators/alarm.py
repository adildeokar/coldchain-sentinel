"""Local alarm outputs. These work with zero network — that is the whole point.

Wiring (BCM):
  GPIO18 → 1 kΩ → 2N2222 base; buzzer (+) → 5V, buzzer (−) → collector, emitter → GND
  GPIO23 → 330 Ω → red LED   → GND   (ALARM)
  GPIO24 → 330 Ω → green LED → GND   (all OK)
  GPIO25 → 330 Ω → amber LED → GND   (cloud offline, readings buffered locally)
  GPIO22 ← push button → GND         (acknowledge / silence buzzer)

The transistor is needed because a 5 V active buzzer draws ~30 mA, above the
16 mA a Pi GPIO pin can safely source.
"""
from __future__ import annotations

import logging
import time

log = logging.getLogger("coldstore.alarm")


class _MockOut:
    """Stand-in for gpiozero outputs on a PC. Logs state changes only."""
    def __init__(self, name):
        self.name, self.is_active = name, False

    def on(self):
        if not self.is_active:
            log.info("GPIO %-6s → HIGH", self.name)
        self.is_active = True

    def off(self):
        if self.is_active:
            log.info("GPIO %-6s → LOW", self.name)
        self.is_active = False

    def beep(self, on_time=0.2, off_time=0.2):
        self.on()

    def blink(self, on_time=0.5, off_time=0.5):
        self.on()


class AlarmOutputs:
    def __init__(self, gpio: dict, simulate: bool = False):
        self.silenced = False
        self.alarm_active = False
        self.on_ack = None
        if simulate:
            self.buzzer = _MockOut("BUZZER")
            self.red, self.green, self.amber = _MockOut("RED"), _MockOut("GREEN"), _MockOut("AMBER")
            self._button = None
        else:
            from gpiozero import Buzzer, LED, Button
            self.buzzer = Buzzer(gpio["buzzer"])
            self.red, self.green, self.amber = LED(gpio["led_red"]), LED(gpio["led_green"]), LED(gpio["led_amber"])
            self._button = Button(gpio["ack_button"], pull_up=True, bounce_time=0.1)
            self._button.when_pressed = self.acknowledge
        self.green.on()

    def raise_alarm(self, critical: bool = True):
        """Called within a few milliseconds of the rule engine deciding ALARM."""
        t0 = time.perf_counter()
        self.alarm_active = True
        self.green.off()
        self.red.blink(0.25, 0.25) if critical else self.red.on()
        if not self.silenced:
            self.buzzer.beep(on_time=0.4, off_time=0.2)
        return (time.perf_counter() - t0) * 1000.0      # actuation time in ms, reported in the alert

    def clear_alarm(self):
        self.alarm_active = False
        self.silenced = False
        self.buzzer.off()
        self.red.off()
        self.green.on()

    def acknowledge(self):
        """Operator pressed the button: silence the buzzer, keep the red LED lit."""
        if self.alarm_active:
            self.silenced = True
            self.buzzer.off()
            self.red.on()
            log.info("Alarm acknowledged locally — buzzer silenced")
            if self.on_ack:
                self.on_ack()

    def set_cloud_online(self, online: bool, backlog: int = 0):
        if online and backlog == 0:
            self.amber.off()
        elif online:
            self.amber.blink(0.1, 0.1)      # fast blink = syncing backlog
        else:
            self.amber.on()                 # solid = offline, buffering
