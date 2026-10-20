"""Data shapes shared by the sensor, rule, storage and cloud layers."""
from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional


def iso(ts: float) -> str:
    """Unix seconds → ISO-8601 UTC with milliseconds (what IoT Hub and Cosmos expect)."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class Reading:
    seq: int                      # monotonically increasing, survives reboots (stored in SQLite)
    ts: float                     # unix seconds, taken at the moment of sampling
    temp_c: Optional[float]       # fused temperature used by the rule engine
    rh_pct: Optional[float]
    ds18b20_c: Optional[float]
    dht22_c: Optional[float]
    door_open: bool
    status: str = "OK"            # OK / WARN / ALARM / FAULT
    alarms: list = field(default_factory=list)

    def to_live_message(self, device_id: str, firmware: str) -> dict:
        return {
            "type": "telemetry",
            "deviceId": device_id,
            "seq": self.seq,
            "ts": iso(self.ts),
            "tempC": self.temp_c,
            "rh": self.rh_pct,
            "ds18b20C": self.ds18b20_c,
            "dht22C": self.dht22_c,
            "door": "open" if self.door_open else "closed",
            "status": self.status,
            "alarms": self.alarms,
            "buffered": False,
            "fw": firmware,
        }

    def to_compact(self) -> dict:
        """Short keys used inside backlog batches to save bandwidth (~45 % smaller)."""
        return {"q": self.seq, "ts": iso(self.ts), "t": self.temp_c, "h": self.rh_pct,
                "d": int(self.door_open), "s": self.status}


@dataclass
class Alert:
    alert_id: str
    alarm: str                    # HIGH_TEMP, LOW_TEMP, HIGH_RH, LOW_RH, DOOR_OPEN, SENSOR_FAULT, SENSOR_DISAGREE
    state: str                    # RAISED / CLEARED
    severity: str                 # critical / warning
    value: Optional[float]
    threshold: Optional[float]
    raised_at: float              # time the edge decided (after debounce)
    first_breach_at: float        # time of the first out-of-range sample
    local_action_at: float = field(default_factory=time.time)

    def to_message(self, device_id: str, sent_at: float | None = None) -> dict:
        sent_at = sent_at or time.time()
        d = asdict(self)
        return {
            "type": "alert",
            "deviceId": device_id,
            "alertId": self.alert_id,
            "alarm": self.alarm,
            "state": self.state,
            "severity": self.severity,
            "value": self.value,
            "threshold": self.threshold,
            "firstBreachAt": iso(d["first_breach_at"]),
            "raisedAt": iso(d["raised_at"]),
            "localActionAt": iso(d["local_action_at"]),
            "localActions": ["buzzer", "red_led", "lcd"] if self.state == "RAISED" else [],
            "bufferedMs": int(max(0.0, sent_at - self.raised_at) * 1000),
        }
