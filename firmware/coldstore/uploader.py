"""Uploader thread: connection state machine + priority sync from the SQLite queue.

    DISCONNECTED ──connect()──▶ CONNECTING ──ok──▶ CONNECTED
         ▲   ▲                       │fail              │ send fails / PUBACK timeout
         │   └───── BACKOFF ◀────────┘                  │
         └──────────────────────────────────────────────┘
    backoff: 1, 2, 4, 8, 16, 32, 32 … s with ±20 % jitter (no thundering herd)

Send priority while CONNECTED:
  1. alerts (RAISED / CLEARED), one message each, app property alert=true
  2. live readings (taken in the last two sample periods), one message each
  3. backlog from an outage, packed `batch_size` readings per message

Live-first keeps the dashboard current while the backlog drains behind it.
"""
from __future__ import annotations

import logging
import random
import threading
import time
from datetime import datetime

from .cloud import CloudError
from .config import Config, apply_desired
from .store import Store

log = logging.getLogger("coldstore.uploader")


def _compact(row: dict) -> dict:
    return {"q": row["seq"], "ts": row["ts"], "t": row["tempC"], "h": row["rh"],
            "d": 1 if row["door"] == "open" else 0, "s": row["status"]}


class Uploader(threading.Thread):
    def __init__(self, cfg: Config, store: Store, cloud, outputs, on_config_change=None):
        super().__init__(name="uploader", daemon=True)
        self.cfg, self.store, self.cloud, self.outputs = cfg, store, cloud, outputs
        self.on_config_change = on_config_change
        self.state = "DISCONNECTED"
        self._halt = threading.Event()
        self._backoff = cfg.backoff_initial_s
        self._batch_id = 0
        self._sync_started: float | None = None
        self.outage_started: float | None = time.time()
        self.stats = {"sent_live": 0, "sent_batched": 0, "batches": 0, "alerts": 0, "reconnects": 0,
                      "bytes": 0, "last_sync_s": 0.0}

    def stop(self):
        self._halt.set()

    # ---- connection ------------------------------------------------------------
    def _try_connect(self):
        self.state = "CONNECTING"
        try:
            self.cloud.connect()
        except CloudError as exc:
            self.state = "BACKOFF"
            delay = self._backoff * random.uniform(0.8, 1.2)
            log.warning("connect failed (%s) — retry in %.1f s, %d readings buffered",
                        exc, delay, self.store.pending_count())
            self._backoff = min(self._backoff * 2, self.cfg.backoff_max_s)
            self._halt.wait(delay)
            return
        self.state, self._backoff = "CONNECTED", self.cfg.backoff_initial_s
        self.stats["reconnects"] += 1
        backlog = self.store.pending_count()
        if self.outage_started:
            log.info("connected after %.0f s offline — %d readings to sync", time.time() - self.outage_started, backlog)
        self.outage_started = None
        self._sync_started = time.time() if backlog else None
        # The twin may have changed while we were away: pull the full desired doc.
        try:
            changed = apply_desired(self.cfg, self.cloud.get_desired())
            if changed and self.on_config_change:
                self.on_config_change(changed)
            self.cloud.patch_reported({**self.cfg.as_reported(), "lastBoot": None,
                                       "queueDepth": backlog, "connectivity": "online"})
        except CloudError as exc:
            log.warning("twin sync failed: %s", exc)

    def _lost(self, exc: Exception):
        if self.state == "CONNECTED":
            log.error("connection lost (%s) — buffering locally", exc)
        self.state = "DISCONNECTED"
        self.outage_started = self.outage_started or time.time()
        self.outputs.set_cloud_online(False)

    # ---- sending ----------------------------------------------------------------
    def _send(self, body: dict, props: dict):
        self.cloud.send(body, props)
        self.stats["bytes"] += len(str(body))

    def _send_alerts(self):
        for alert_id, state, msg in self.store.pending_alerts():
            raised = datetime.fromisoformat(msg["raisedAt"].replace("Z", "+00:00")).timestamp()
            msg["bufferedMs"] = int(max(0.0, time.time() - raised) * 1000)
            self._send(msg, {"alert": "true", "type": "alert", "severity": msg["severity"]})
            self.store.mark_alert_sent(alert_id, state)
            self.stats["alerts"] += 1
            log.info("alert %s %s delivered (buffered %d ms)", alert_id, state, msg["bufferedMs"])

    def _send_live(self) -> set[int]:
        since = time.time() - 2 * self.cfg.sample_interval_s
        sent = set()
        for seq, body in self.store.pending_since(since):
            self._send(body, {"type": "telemetry", "alert": "false"})
            self.store.mark_sent([seq])
            sent.add(seq)
            self.stats["sent_live"] += 1
        return sent

    def _send_backlog(self, skip: set[int]) -> int:
        rows = self.store.pending(self.cfg.batch_size, exclude=skip)
        if not rows:
            return 0
        self._batch_id += 1
        seqs = [s for s, _ in rows]
        body = {"type": "batch", "deviceId": self.cfg.device_id, "batchId": self._batch_id,
                "count": len(rows), "fromSeq": seqs[0], "toSeq": seqs[-1],
                "readings": [_compact(r) for _, r in rows]}
        self.store.mark_attempt(seqs)
        self._send(body, {"type": "batch", "alert": "false", "buffered": "true"})
        self.store.mark_sent(seqs)                       # only after PUBACK
        self.stats["sent_batched"] += len(rows)
        self.stats["batches"] += 1
        return len(rows)

    def run(self):
        while not self._halt.is_set():
            if not self.cloud.connected:
                if self.state == "CONNECTED":
                    self._lost(CloudError("transport closed"))
                self.outputs.set_cloud_online(False)
                self._try_connect()
                continue
            try:
                self._send_alerts()
                live = self._send_live()
                self._send_backlog(live)
                backlog = self.store.pending_count()
                self.outputs.set_cloud_online(True, backlog)
                if not backlog and self._sync_started is not None:
                    self.stats["last_sync_s"] = time.time() - self._sync_started
                    log.info("backlog synced in %.1f s after reconnect", self.stats["last_sync_s"])
                    self._sync_started = None
                self._halt.wait(self.cfg.sync_interval_s if backlog else 0.2)
            except CloudError as exc:
                self._lost(exc)
