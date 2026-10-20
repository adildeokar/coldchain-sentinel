"""Store-and-forward queue in SQLite.

Every reading is written here *before* any attempt to send it. The uploader
marks rows SENT only after IoT Hub acknowledges them (MQTT PUBACK, QoS 1), so
an internet outage, a crashed process or a reboot never loses a reading — at
worst a reading is sent twice, and the cloud de-duplicates on (deviceId, seq).

Schema
  readings(seq PK, ts, payload JSON, state PENDING|SENT, attempts, sent_at)
  alerts(alert_id, state, payload JSON, sent, created_at)   PK (alert_id, state)
  meta(key PK, value)            next_seq, dropped, …
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import Iterable

from .models import Reading

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    seq      INTEGER PRIMARY KEY,
    ts       REAL NOT NULL,
    payload  TEXT NOT NULL,
    state    TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at  REAL
);
CREATE INDEX IF NOT EXISTS ix_readings_state ON readings(state, seq);
CREATE TABLE IF NOT EXISTS alerts (
    alert_id   TEXT NOT NULL,
    state      TEXT NOT NULL,
    payload    TEXT NOT NULL,
    sent       INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    PRIMARY KEY (alert_id, state)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""

SENT_RETENTION_S = 7 * 24 * 3600     # keep a week of delivered rows for local inspection


class Store:
    def __init__(self, path: str, capacity_rows: int = 100_000):
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")      # readers never block the sampler
        self._db.execute("PRAGMA synchronous=FULL")      # survive power loss, not just crashes
        self._db.executescript(SCHEMA)
        self._lock = threading.RLock()         # sampler + uploader threads share one connection
        self.capacity = capacity_rows

    # ---- meta ---------------------------------------------------------------
    def _meta(self, key: str, default: int = 0) -> int:
        row = self._db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return int(row[0]) if row else default

    def _set_meta(self, key: str, value: int):
        self._db.execute("INSERT INTO meta(key,value) VALUES(?,?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))

    def next_seq(self) -> int:
        with self._lock:
            seq = self._meta("next_seq", 1)
            self._set_meta("next_seq", seq + 1)
            return seq

    @property
    def dropped(self) -> int:
        with self._lock:
            return self._meta("dropped")

    # ---- readings -------------------------------------------------------------
    def add_reading(self, r: Reading, device_id: str, firmware: str):
        payload = json.dumps(r.to_live_message(device_id, firmware), separators=(",", ":"))
        with self._lock:
            self._db.execute("INSERT INTO readings(seq, ts, payload) VALUES(?,?,?)", (r.seq, r.ts, payload))
            self._enforce_capacity()

    def _enforce_capacity(self):
        total = self._db.execute("SELECT COUNT(*) FROM readings").fetchone()[0]
        if total <= self.capacity:
            return
        excess = total - self.capacity
        # 1) delivered rows are expendable  2) only then drop the oldest undelivered (real data loss)
        self._db.execute("DELETE FROM readings WHERE seq IN (SELECT seq FROM readings WHERE state='SENT' "
                         "ORDER BY seq LIMIT ?)", (excess,))
        still = self._db.execute("SELECT COUNT(*) FROM readings").fetchone()[0] - self.capacity
        if still > 0:
            self._db.execute("DELETE FROM readings WHERE seq IN (SELECT seq FROM readings WHERE state='PENDING' "
                             "ORDER BY seq LIMIT ?)", (still,))
            self._set_meta("dropped", self._meta("dropped") + still)

    def pending(self, limit: int, exclude: Iterable[int] = ()) -> list[tuple[int, dict]]:
        exclude = set(exclude)
        with self._lock:
            rows = self._db.execute("SELECT seq, payload FROM readings WHERE state='PENDING' ORDER BY seq LIMIT ?",
                                    (limit + len(exclude),)).fetchall()
        return [(s, json.loads(p)) for s, p in rows if s not in exclude][:limit]

    def pending_since(self, ts: float) -> list[tuple[int, dict]]:
        """Undelivered rows taken at or after `ts` — the 'live' readings."""
        with self._lock:
            rows = self._db.execute("SELECT seq, payload FROM readings WHERE state='PENDING' AND ts >= ? "
                                    "ORDER BY seq", (ts,)).fetchall()
        return [(s, json.loads(p)) for s, p in rows]

    def pending_count(self) -> int:
        with self._lock:
            return self._db.execute("SELECT COUNT(*) FROM readings WHERE state='PENDING'").fetchone()[0]

    def mark_sent(self, seqs: Iterable[int]):
        seqs = list(seqs)
        if not seqs:
            return
        now = time.time()
        with self._lock:
            self._db.executemany("UPDATE readings SET state='SENT', sent_at=? WHERE seq=?", [(now, s) for s in seqs])

    def mark_attempt(self, seqs: Iterable[int]):
        with self._lock:
            self._db.executemany("UPDATE readings SET attempts=attempts+1 WHERE seq=?", [(s,) for s in seqs])

    def prune(self):
        with self._lock:
            self._db.execute("DELETE FROM readings WHERE state='SENT' AND sent_at < ?",
                             (time.time() - SENT_RETENTION_S,))

    # ---- alerts ---------------------------------------------------------------
    def add_alert(self, alert_id: str, state: str, message: dict):
        with self._lock:
            self._db.execute("INSERT OR IGNORE INTO alerts(alert_id,state,payload,created_at) VALUES(?,?,?,?)",
                             (alert_id, state, json.dumps(message), time.time()))

    def pending_alerts(self) -> list[tuple[str, str, dict]]:
        with self._lock:
            rows = self._db.execute("SELECT alert_id, state, payload FROM alerts WHERE sent=0 "
                                    "ORDER BY created_at").fetchall()
        return [(a, s, json.loads(p)) for a, s, p in rows]

    def mark_alert_sent(self, alert_id: str, state: str):
        with self._lock:
            self._db.execute("UPDATE alerts SET sent=1 WHERE alert_id=? AND state=?", (alert_id, state))

    def stats(self) -> dict:
        with self._lock:
            size = self._db.execute("SELECT page_count*page_size FROM pragma_page_count(), pragma_page_size()").fetchone()[0]
            return {"pending": self.pending_count(), "dropped": self.dropped, "dbBytes": size,
                    "pendingAlerts": self._db.execute("SELECT COUNT(*) FROM alerts WHERE sent=0").fetchone()[0]}

    def close(self):
        self._db.close()
