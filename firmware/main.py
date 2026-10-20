#!/usr/bin/env python3
"""ColdChain Sentinel — edge application for the Raspberry Pi.

    sudo -E python3 main.py                       # real hardware + Azure IoT Hub
    python main.py --simulate --duration 180      # any PC: simulated sensors + local hub emulator
    python main.py --simulate --scenario outage   # simulated 60 s internet outage with an excursion

Main loop (every `sampling.interval_s`, default 5 s):
  read DS18B20 + DHT22 + door → fuse → rule engine → local alarm (GPIO)
  → write reading (and any alert) to SQLite → LCD.
The uploader thread sends from SQLite whenever IoT Hub is reachable, so the
sampling loop never waits on the network.
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import threading
import time
from pathlib import Path

from coldstore import config as config_mod
from coldstore import health
from coldstore.actuators.alarm import AlarmOutputs
from coldstore.actuators.lcd import LCD, render
from coldstore.models import Reading
from coldstore.rules import AlarmEngine, fuse
from coldstore.store import Store
from coldstore.uploader import Uploader

log = logging.getLogger("coldstore")

SCENARIOS = {
    # name: (room events [(at_s, attr, value)], network outages [(from_s, to_s)])
    "normal":  ([], []),
    "door":    ([(15, "door_open", True), (75, "door_open", False)], []),
    "outage":  ([(30, "compressor_failed", True), (120, "compressor_failed", False)], [(20, 110)]),
    "power":   ([(20, "compressor_failed", True), (140, "compressor_failed", False)], [(20, 140)]),
}


def build(args):
    cfg = config_mod.load(args.config)
    if args.simulate:
        from coldstore.cloud import LocalHubEmulator, NetworkScenario
        from coldstore.sensors.simulated import ColdRoomModel, SimDHT22, SimDS18B20, SimDoor
        room = ColdRoomModel(cfg.profile, time_scale=args.time_scale)
        dht, ds, door = SimDHT22(room, cfg.dht22_retries), SimDS18B20(room), SimDoor(room)
        events, outages = SCENARIOS[args.scenario]
        net = NetworkScenario(outages)
        cloud = LocalHubEmulator(Path(args.data) / "cloud_sink.jsonl", net, cfg.device_id)
        cfg.db_path = str(Path(args.data) / "queue.db")
        threading.Thread(target=_play, args=(room, events), daemon=True).start()
    else:
        from coldstore.cloud import AzureIoTHubCloud
        from coldstore.sensors.dht22 import DHT22
        from coldstore.sensors.door import DoorSensor
        from coldstore.sensors.ds18b20 import DS18B20
        dht, ds, door = DHT22(cfg.gpio["dht22_data"], cfg.dht22_retries), DS18B20(), DoorSensor(cfg.gpio["door_reed"])
        conn = os.environ.get(cfg.connection_string_env)
        if not conn:
            sys.exit(f"Set {cfg.connection_string_env} to the device connection string from IoT Hub")
        cloud = AzureIoTHubCloud(conn, cfg.keep_alive_s)
    return cfg, dht, ds, door, cloud


def _play(room, events):
    t0 = time.monotonic()
    for at, attr, value in sorted(events):
        time.sleep(max(0.0, at - (time.monotonic() - t0)))
        setattr(room, attr, value)
        log.warning("[scenario] t=%ds  room.%s = %s", at, attr, value)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=Path(__file__).with_name("config.yaml"))
    ap.add_argument("--simulate", action="store_true", help="simulated sensors + local IoT Hub emulator")
    ap.add_argument("--scenario", default="outage", choices=SCENARIOS)
    ap.add_argument("--time-scale", type=float, default=10.0, help="room physics speed-up in --simulate")
    ap.add_argument("--duration", type=float, default=0, help="stop after N seconds (0 = run forever)")
    ap.add_argument("--data", default="./data", help="--simulate: where queue.db and cloud_sink.jsonl go")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(name)-20s %(message)s", datefmt="%H:%M:%S")

    cfg, dht, ds, door, cloud = build(args)
    store = Store(cfg.db_path, cfg.capacity_rows)
    outputs = AlarmOutputs(cfg.gpio, simulate=args.simulate)
    lcd = LCD(cfg.gpio["lcd_i2c_address"], simulate=args.simulate)
    engine = AlarmEngine(cfg.thresholds)

    def on_config_change(changed):
        engine.th = cfg.thresholds
        log.info("twin desired properties applied: %s", ", ".join(changed))

    def on_method(name, payload):
        if name == "silenceAlarm":
            outputs.acknowledge()
            return 200, {"silenced": True}
        if name == "testAlarm":
            outputs.raise_alarm(critical=False)
            threading.Timer(float(payload.get("seconds", 3)), outputs.clear_alarm).start()
            return 200, {"ok": True}
        if name == "getDiagnostics":
            return 200, {**health.snapshot(), **store.stats(), "uploader": uploader.state, **uploader.stats}
        if name == "reboot":
            # systemd brings the service back; the SQLite queue survives the reboot
            if args.simulate:
                log.warning("reboot requested — ignored in --simulate (would reboot this PC)")
            else:
                threading.Timer(1.5, lambda: os.system("sudo systemctl reboot")).start()
            return 200, {"rebooting": True, "inSeconds": 1.5}
        return 404, {"error": f"unknown method {name}"}

    def on_desired(patch):
        changed = config_mod.apply_desired(cfg, patch)
        if changed:
            on_config_change(changed)
            cloud.patch_reported(cfg.as_reported())

    cloud.on_method(on_method)
    cloud.on_desired_patch(on_desired)
    uploader = Uploader(cfg, store, cloud, outputs, on_config_change)
    uploader.start()

    running = True

    def stop(*_):
        nonlocal running
        running = False
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    log.info("ColdChain Sentinel %s on %s — profile %s, limits %.1f…%.1f °C / %.0f…%.0f %%RH, every %.0f s",
             cfg.firmware, cfg.device_id, cfg.profile, cfg.thresholds.temp_min_c, cfg.thresholds.temp_max_c,
             cfg.thresholds.rh_min_pct, cfg.thresholds.rh_max_pct, cfg.sample_interval_s)
    started = time.time()
    next_tick = time.monotonic()
    while running and (not args.duration or time.time() - started < args.duration):
        t_sample = time.time()                      # measurement time = start of the read cycle
        ds_c = ds.read()                            # ~750 ms 12-bit conversion
        dht_c, rh = dht.read()                      # 2 s between retries on checksum errors
        reading = Reading(seq=store.next_seq(), ts=t_sample, temp_c=fuse(ds_c, dht_c), rh_pct=rh,
                          ds18b20_c=ds_c, dht22_c=dht_c, door_open=door.is_open)
        for alert in engine.evaluate(reading, door.open_for_s()):
            if alert.state == "RAISED":
                ms = outputs.raise_alarm(critical=alert.severity == "critical")
                alert.local_action_at = time.time()
                log.critical("ALARM %s %s value=%s limit=%s — buzzer+LED on in %.2f ms (cloud: %s)",
                             alert.alert_id, alert.alarm, alert.value, alert.threshold, ms, uploader.state)
            else:
                log.warning("CLEARED %s %s value=%s", alert.alert_id, alert.alarm, alert.value)
                if not engine.active_alarms():
                    outputs.clear_alarm()
            store.add_alert(alert.alert_id, alert.state, alert.to_message(cfg.device_id))
        store.add_reading(reading, cfg.device_id, cfg.firmware)

        alarm = next(iter(reading.alarms), None)
        lcd.show(*render(reading.temp_c, reading.rh_pct, reading.status, uploader.state == "CONNECTED",
                         store.pending_count(), alarm))
        log.info("#%d T=%s°C RH=%s%% door=%s status=%s queue=%d cloud=%s",
                 reading.seq, reading.temp_c, reading.rh_pct, "open" if reading.door_open else "closed",
                 reading.status, store.pending_count(), uploader.state)

        if reading.seq % 720 == 0:
            store.prune()
        next_tick += cfg.sample_interval_s
        time.sleep(max(0.0, next_tick - time.monotonic()))

    uploader.stop()
    uploader.join(timeout=3)
    stats = store.stats()
    log.info("stopped. pending=%d dropped=%d uploader=%s", stats["pending"], stats["dropped"], uploader.stats)
    if args.simulate:
        log.info("emulated hub received %d unique readings, %d duplicates discarded",
                 cloud.received, cloud.duplicates)
    store.close()


if __name__ == "__main__":
    main()
