"""Simulated cold room and sensors for running the firmware on a PC (--simulate).

The thermal model is the same one the browser simulator uses (js/sim/physics.js),
so a scenario behaves the same way in both. Constants are per second.
"""
from __future__ import annotations

import math
import random
import time
from typing import Optional, Tuple

K_LEAK = 3.6e-4         # heat leak through walls, 1/s
K_DOOR = 3.0e-3         # extra exchange with ambient air while the door is open, 1/s
COOLING_C_PER_S = 0.035 # evaporator capacity when the compressor runs
AMBIENT_C = 32.0
AMBIENT_RH = 80.0

SETPOINTS = {"pharma": (5.0, 55.0), "produce": (2.5, 88.0), "frozen": (-20.0, 70.0)}


class ColdRoomModel:
    def __init__(self, profile: str = "pharma", seed: int = 7, time_scale: float = 1.0):
        self.time_scale = time_scale      # >1 makes the room warm/cool faster for short PC demos
        self.setpoint, self.base_rh = SETPOINTS.get(profile, SETPOINTS["pharma"])
        self.temp = self.setpoint - 0.5
        self.rh = self.base_rh
        self.door_open = False
        self.compressor_on = True
        self.compressor_failed = False
        self.thermostat_stuck = False
        self.humidity_surge = 0.0
        self.rng = random.Random(seed)
        self._last = time.monotonic()

    def step(self, dt: float):
        # Thermostat with ±1 °C hysteresis around the set point
        if self.thermostat_stuck:
            self.compressor_on = True
        elif self.temp > self.setpoint + 1.0:
            self.compressor_on = True
        elif self.temp < self.setpoint - 1.0:
            self.compressor_on = False
        running = self.compressor_on and not self.compressor_failed

        k = K_LEAK + (K_DOOR if self.door_open else 0.0)
        dT = k * (AMBIENT_C - self.temp) - (COOLING_C_PER_S if running else 0.0)
        self.temp += dT * dt

        target = self.base_rh + (-4 if running else 4)
        rate = 0.004
        if self.door_open:
            target, rate = AMBIENT_RH + 8, 0.015
        if self.humidity_surge > 0:
            target, rate = 94, 0.01
            self.humidity_surge -= dt
        self.rh += (target - self.rh) * rate * dt
        self.rh = min(99.0, max(5.0, self.rh))

    def tick(self):
        now = time.monotonic()
        dt, self._last = (now - self._last) * self.time_scale, now
        # integrate in 1 s steps so behaviour does not depend on how often we poll
        while dt > 0:
            self.step(min(1.0, dt))
            dt -= 1.0


class SimDHT22:
    fault = False

    def __init__(self, room: ColdRoomModel, retries: int = 3):
        self.room, self.retries, self.errors = room, retries, 0

    def read(self) -> Tuple[Optional[float], Optional[float]]:
        self.room.tick()
        for _ in range(self.retries):
            if self.fault or self.room.rng.random() < 0.03:     # ~3 % checksum errors, like the real part
                self.errors += 1
                continue
            t = self.room.temp + 0.2 + self.room.rng.gauss(0, 0.15)
            h = self.room.rh + self.room.rng.gauss(0, 0.8)
            return round(t, 1), round(min(100, max(0, h)), 1)
        return None, None


class SimDS18B20:
    fault = False

    def __init__(self, room: ColdRoomModel):
        self.room, self.errors = room, 0

    def read(self) -> Optional[float]:
        self.room.tick()
        if self.fault:
            self.errors += 1
            return None
        raw = self.room.temp + self.room.rng.gauss(0, 0.05)
        return round(math.floor(raw / 0.0625) * 0.0625, 2)      # 12-bit quantisation


class SimDoor:
    def __init__(self, room: ColdRoomModel):
        self.room = room
        self._opened_at: float | None = None

    @property
    def is_open(self) -> bool:
        if self.room.door_open and self._opened_at is None:
            self._opened_at = time.time()
        if not self.room.door_open:
            self._opened_at = None
        return self.room.door_open

    def open_for_s(self) -> float:
        _ = self.is_open
        return 0.0 if self._opened_at is None else time.time() - self._opened_at
