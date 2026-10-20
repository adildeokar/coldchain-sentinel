"""Configuration loading and live updates from the device twin.

The YAML file gives safe defaults that work with no network at all. When the
device connects, desired properties from the IoT Hub twin are merged on top,
so an operator can change limits from the cloud without touching the Pi.
"""
from __future__ import annotations

import copy
import logging
from dataclasses import dataclass, field, asdict
from pathlib import Path

try:
    import yaml
except ImportError:  # PyYAML missing: defaults below still let the device run
    yaml = None

log = logging.getLogger("coldstore.config")

PROFILES = {
    # name:     (temp_min, temp_max, rh_min, rh_max)
    "pharma":  (2.0, 8.0, 35.0, 75.0),
    "produce": (0.0, 5.0, 80.0, 95.0),
    "frozen":  (-25.0, -15.0, 40.0, 95.0),
}


@dataclass
class Thresholds:
    temp_min_c: float = 2.0
    temp_max_c: float = 8.0
    rh_min_pct: float = 35.0
    rh_max_pct: float = 75.0
    temp_hysteresis_c: float = 0.3
    rh_hysteresis_pct: float = 2.0
    alarm_delay_samples: int = 2
    warn_margin_c: float = 0.5
    door_open_max_s: float = 120
    sensor_disagree_c: float = 1.5


@dataclass
class Config:
    device_id: str = "coldstore-pi-01"
    site: str = "Warehouse A / Cold Room 1"
    firmware: str = "1.4.2"
    profile: str = "pharma"
    thresholds: Thresholds = field(default_factory=Thresholds)
    sample_interval_s: float = 5
    dht22_retries: int = 3
    gpio: dict = field(default_factory=lambda: {
        "dht22_data": 17, "ds18b20_data": 4, "door_reed": 27, "ack_button": 22,
        "buzzer": 18, "led_red": 23, "led_green": 24, "led_amber": 25,
        "lcd_i2c_address": 0x27,
    })
    db_path: str = "/var/lib/coldstore/queue.db"
    capacity_rows: int = 100_000
    connection_string_env: str = "IOTHUB_DEVICE_CONNECTION_STRING"
    batch_size: int = 50
    sync_interval_s: float = 0.5
    puback_timeout_s: float = 4
    backoff_initial_s: float = 1
    backoff_max_s: float = 32
    keep_alive_s: int = 60

    def as_reported(self) -> dict:
        """Shape sent back to the twin as reported properties."""
        return {
            "profile": self.profile,
            "thresholds": asdict(self.thresholds),
            "sampleIntervalSec": self.sample_interval_s,
            "firmware": self.firmware,
        }


def load(path: str | Path) -> Config:
    cfg = Config()
    path = Path(path)
    if yaml is None or not path.exists():
        log.warning("config %s not loaded (yaml=%s) — using built-in defaults", path, bool(yaml))
        return cfg

    raw = yaml.safe_load(path.read_text()) or {}
    dev = raw.get("device", {})
    cfg.device_id = dev.get("id", cfg.device_id)
    cfg.site = dev.get("site", cfg.site)
    cfg.firmware = dev.get("firmware", cfg.firmware)
    cfg.profile = raw.get("profile", cfg.profile)

    for k, v in (raw.get("thresholds") or {}).items():
        if hasattr(cfg.thresholds, k):
            setattr(cfg.thresholds, k, type(getattr(cfg.thresholds, k))(v))

    samp = raw.get("sampling", {})
    cfg.sample_interval_s = float(samp.get("interval_s", cfg.sample_interval_s))
    cfg.dht22_retries = int(samp.get("dht22_retries", cfg.dht22_retries))
    cfg.gpio.update(raw.get("gpio") or {})

    st = raw.get("storage", {})
    cfg.db_path = st.get("db_path", cfg.db_path)
    cfg.capacity_rows = int(st.get("capacity_rows", cfg.capacity_rows))

    for k, v in (raw.get("cloud") or {}).items():
        if hasattr(cfg, k):
            setattr(cfg, k, type(getattr(cfg, k))(v))
    return cfg


def apply_desired(cfg: Config, desired: dict) -> list[str]:
    """Merge a twin desired-properties patch into the running config.

    Returns the list of changed keys so the caller can log them and report
    the new values back. Unknown keys are ignored rather than rejected so an
    older firmware never crashes on a newer twin.
    """
    changed: list[str] = []
    if "profile" in desired and desired["profile"] in PROFILES:
        tmin, tmax, hmin, hmax = PROFILES[desired["profile"]]
        cfg.profile = desired["profile"]
        cfg.thresholds.temp_min_c, cfg.thresholds.temp_max_c = tmin, tmax
        cfg.thresholds.rh_min_pct, cfg.thresholds.rh_max_pct = hmin, hmax
        changed.append("profile")

    for k, v in (desired.get("thresholds") or {}).items():
        if hasattr(cfg.thresholds, k) and v is not None:
            old = getattr(cfg.thresholds, k)
            new = type(old)(v)
            if new != old:
                setattr(cfg.thresholds, k, new)
                changed.append(f"thresholds.{k}")

    if "sampleIntervalSec" in desired:
        new = max(1.0, float(desired["sampleIntervalSec"]))
        if new != cfg.sample_interval_s:
            cfg.sample_interval_s = new
            changed.append("sampleIntervalSec")
    return changed


def snapshot(cfg: Config) -> Config:
    return copy.deepcopy(cfg)
