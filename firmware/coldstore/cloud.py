"""Cloud connection: Azure IoT Hub over MQTT/TLS, or a local emulator for --simulate.

Both classes expose the same small interface so the uploader does not care
which one it talks to:

    connect() / disconnect() / connected
    send(body: dict, properties: dict)       blocks until PUBACK, raises on failure
    get_desired() -> dict                     full desired twin
    patch_reported(dict)
    on_desired_patch(cb) / on_method(cb)

Azure IoT Hub facts this relies on:
  * MQTT 3.1.1 on port 8883 with TLS 1.2, SAS-token authentication
  * D2C topic  devices/{deviceId}/messages/events/{url-encoded app properties}
  * QoS 1 → IoT Hub sends PUBACK once the message is durably stored
  * routing queries can use application properties (alert = 'true') and,
    because we set contentType=application/json + utf-8, the body ($body.tempC)
"""
from __future__ import annotations

import json
import logging
import random
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

log = logging.getLogger("coldstore.cloud")


class CloudError(Exception):
    pass


class AzureIoTHubCloud:
    def __init__(self, connection_string: str, keep_alive: int = 60):
        from azure.iot.device import IoTHubDeviceClient   # pip install azure-iot-device
        # connection_retry=False: the uploader owns reconnect/backoff so it can
        # report the outage, light the amber LED and switch to buffering.
        self._client = IoTHubDeviceClient.create_from_connection_string(
            connection_string, keep_alive=keep_alive, connection_retry=False)
        self._client.on_connection_state_change = self._on_state
        self._connected = False

    def _on_state(self):
        self._connected = self._client.connected
        log.info("IoT Hub connection state → %s", "CONNECTED" if self._connected else "DISCONNECTED")

    @property
    def connected(self) -> bool:
        return self._connected and self._client.connected

    def connect(self):
        try:
            self._client.connect()            # TLS handshake + MQTT CONNECT (SAS token)
            self._connected = True
        except Exception as exc:
            raise CloudError(f"connect failed: {exc}") from exc

    def disconnect(self):
        try:
            self._client.disconnect()
        finally:
            self._connected = False

    def send(self, body: dict, properties: dict | None = None):
        from azure.iot.device import Message
        msg = Message(json.dumps(body, separators=(",", ":")), message_id=str(uuid.uuid4()),
                      content_encoding="utf-8", content_type="application/json")
        for k, v in (properties or {}).items():
            msg.custom_properties[k] = str(v)
        try:
            self._client.send_message(msg)    # returns after PUBACK (QoS 1)
        except Exception as exc:
            self._connected = False
            raise CloudError(f"send failed: {exc}") from exc

    def get_desired(self) -> dict:
        return self._client.get_twin().get("desired", {})

    def patch_reported(self, patch: dict):
        self._client.patch_twin_reported_properties(patch)

    def on_desired_patch(self, cb: Callable[[dict], None]):
        self._client.on_twin_desired_properties_patch_received = cb

    def on_method(self, cb: Callable[[str, dict], tuple[int, dict]]):
        from azure.iot.device import MethodResponse

        def handler(req):
            status, payload = cb(req.name, req.payload or {})
            self._client.send_method_response(MethodResponse.create_from_method_request(req, status, payload))
        self._client.on_method_request_received = handler


class NetworkScenario:
    """Offline windows, in seconds after start, for the local emulator."""
    def __init__(self, outages: list[tuple[float, float]] | None = None, loss: float = 0.002):
        self.t0 = time.monotonic()
        self.outages = outages or []
        self.loss = loss
        self.forced_offline = False

    def online(self) -> bool:
        if self.forced_offline:
            return False
        t = time.monotonic() - self.t0
        return not any(a <= t < b for a, b in self.outages)


class LocalHubEmulator:
    """Behaves like IoT Hub from the device's point of view and writes every
    accepted message to a JSON-lines file, de-duplicating on (deviceId, seq)
    like the cloud TelemetryIngest function does."""

    def __init__(self, sink: str | Path, network: NetworkScenario, device_id: str):
        self.sink = Path(sink)
        self.sink.parent.mkdir(parents=True, exist_ok=True)
        self.net = network
        self.device_id = device_id
        self._connected = False
        self._seen: set[int] = set()
        self.duplicates = 0
        self.received = 0
        self.desired = {"$version": 1}
        self._desired_cb = None
        self._method_cb = None
        self._lock = threading.Lock()

    @property
    def connected(self) -> bool:
        if self._connected and not self.net.online():
            self._connected = False
        return self._connected

    def connect(self):
        time.sleep(0.25)                                   # TLS + CONNECT round trips
        if not self.net.online():
            raise CloudError("connect failed: [Errno 101] Network is unreachable")
        self._connected = True

    def disconnect(self):
        self._connected = False

    def send(self, body: dict, properties: dict | None = None):
        if not self.connected:
            raise CloudError("send failed: no connection")
        time.sleep(random.uniform(0.04, 0.15))             # network RTT + hub store
        if random.random() < self.net.loss or not self.net.online():
            self._connected = False
            raise CloudError("send failed: PUBACK timeout")
        now = time.time()
        rows = body.get("readings") or ([body] if body.get("type") == "telemetry" else [])
        with self._lock, self.sink.open("a") as fh:
            for row in rows:
                seq = row.get("seq", row.get("q"))
                if seq in self._seen:
                    self.duplicates += 1
                    continue
                self._seen.add(seq)
                self.received += 1
            fh.write(json.dumps({"enqueuedTime": now, "properties": properties or {}, "body": body}) + "\n")

    def get_desired(self) -> dict:
        return dict(self.desired)

    def patch_reported(self, patch: dict):
        log.debug("twin reported ← %s", patch)

    def on_desired_patch(self, cb):
        self._desired_cb = cb

    def on_method(self, cb):
        self._method_cb = cb
