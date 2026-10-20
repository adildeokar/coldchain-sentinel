# ColdChain Sentinel — Everything About This Project

> **Problem Statement 1 · Azure IoT Hub–Based Cold-Storage Monitoring**
> A Raspberry Pi edge device that detects unsafe cold-room conditions locally, sounds an alarm with no internet, keeps recording through outages, syncs its queue to Azure IoT Hub when the link returns, and feeds a live cloud dashboard. The project compares alert response time and data loss, connected vs disconnected.

This document explains the whole project: what was asked, what was built, how every part works, how to run and demo it, and what the measured results are. It is written so that every group member can explain any part of the system to the judges.

---

## Table of contents

1. [The problem statement](#1-the-problem-statement)
2. [What we built — in one page](#2-what-we-built--in-one-page)
3. [How to run the application](#3-how-to-run-the-application)
4. [Application architecture (server · engine · UI)](#4-application-architecture-server--engine--ui)
5. [The physical system we are modelling](#5-the-physical-system-we-are-modelling)
6. [Hardware: Raspberry Pi, sensors, circuit, BOM](#6-hardware-raspberry-pi-sensors-circuit-bom)
7. [Edge firmware (real Python for the Pi)](#7-edge-firmware-real-python-for-the-pi)
8. [Azure cloud design (real deployable code)](#8-azure-cloud-design-real-deployable-code)
9. [The simulation engine — how everything is processed](#9-the-simulation-engine--how-everything-is-processed)
10. [Key algorithms](#10-key-algorithms)
11. [Message formats and protocols](#11-message-formats-and-protocols)
12. [Features of the application, view by view](#12-features-of-the-application-view-by-view)
13. [REST API and live stream reference](#13-rest-api-and-live-stream-reference)
14. [Experiments and measured results](#14-experiments-and-measured-results)
15. [Testing](#15-testing)
16. [Security and privacy](#16-security-and-privacy)
17. [Limitations](#17-limitations)
18. [Future scope](#18-future-scope)
19. [How each submission guideline is met](#19-how-each-submission-guideline-is-met)
20. [Demo script for the evaluation](#20-demo-script-for-the-evaluation)
21. [Team roles and viva preparation](#21-team-roles-and-viva-preparation)
22. [Complete file map](#22-complete-file-map)
23. [Glossary](#23-glossary)

---

## 1. The problem statement

> Design a cold-storage monitoring system using a Raspberry Pi or simulated edge device, temperature and humidity sensors, and Azure IoT Hub. The edge device should detect unsafe conditions locally, activate an alarm and continue recording readings during internet outages. When connectivity returns, it should sync queued readings to the cloud. Build a dashboard showing live status and historical trends. Compare alert response time and data loss during connected and disconnected operation.

### Why it matters

Vaccines must stay between **2 °C and 8 °C**, and food cold rooms have similar limits. Product is lost when:

- a door is left open,
- the compressor fails,
- the thermostat sticks (over-cooling freezes vaccines), or
- the power fails.

A monitor that relies only on the cloud has one basic weakness. When the site's internet drops (often during the same power cut), the cloud is blind. Nobody at the site is warned, and readings taken during the outage are lost forever, which breaks the compliance record.

### The requirements, broken down

| # | Requirement | How we meet it |
|---|---|---|
| R1 | Raspberry Pi / simulated edge device | Raspberry Pi 4 design + real Python firmware + a full simulation of it |
| R2 | Temperature and humidity sensors | DS18B20 probe (temperature) + DHT22 (humidity and backup temperature) + a door reed switch |
| R3 | Azure IoT Hub | MQTT/TLS to IoT Hub, routing, device twin, direct methods, plus Functions, Service Bus, Stream Analytics, Cosmos DB, Event Grid, SignalR and Logic Apps |
| R4 | Detect unsafe conditions **locally** | A rule engine on the Pi with confirmation delay and hysteresis |
| R5 | Activate an alarm | Buzzer, red/green/amber LEDs and a 16×2 LCD driven from GPIO, with no network involved |
| R6 | Keep recording during outages | SQLite store-and-forward queue: every reading is written before any send |
| R7 | Sync queued readings when the link returns | Reconnect with backoff, then priority sync (alerts → live → backlog in batches); the cloud de-duplicates |
| R8 | Dashboard: live status + history | Operator dashboard fed only by cloud data, with back-filled history |
| R9 | Compare alert response time and data loss, connected vs disconnected | Six reproducible experiments against a cloud-only baseline device |

---

## 2. What we built — in one page

**ColdChain Sentinel** is a complete, running application with five parts:

1. **An application server (Node.js)** runs the entire system live: the cold-room physics, the sensors, the Raspberry Pi's edge logic, the network, Azure IoT Hub and every Azure service behind it, and the measurement layer. It prints every event to its terminal, colour-coded.
2. **A web UI (browser)** shows what the server is doing, through nine views: the animated topology, the live circuit diagram, an Azure portal, the operator dashboard, experiments, architecture diagrams, all source code, the report and a demo guide. User actions (open the door, cut the internet…) are sent back to the server.
3. **Real Raspberry Pi firmware (Python)** in `firmware/` is the same logic, written to run on an actual Pi with real sensors and real Azure IoT Hub. It also runs on a PC with `--simulate`.
4. **Real Azure code** in `cloud/` includes the Azure Functions, the Stream Analytics query, the message routes and an `az` CLI script that provisions everything on a student subscription.
5. **An experiment and test suite** runs six scripted scenarios and fifteen automated tests on the server and reports the measured results.

**The key idea:** the decision that the room is unsafe is made **at the edge**, so the alarm works with or without the internet. The cloud adds remote notification, history and fleet management, but the site never depends on it to sound the alarm.

**Headline results** (seed 2026, pharma profile):

| | Edge · connected | Edge · disconnected | Cloud-only · connected | Cloud-only · disconnected |
|---|---|---|---|---|
| Local alarm after first bad reading | **5.76 s** | **5.76 s** | none | none |
| Operator SMS after first bad reading | 6.57 s | 10 m 05 s (sent after reconnect) | 11.8 s | 13 m 02 s, and **3 of 4 excursions never alerted** |
| Readings lost | **0 / 1776** | **0 / 559** | 128 / 1776 | **564 / 564** |
| Data loss | 0.00 % | 0.00 % | 7.21 % | **100 %** |

---

## 3. How to run the application

### Requirements

- **Node.js 18 or newer.** This was tested on Node 24. The app has no `npm install` step and no dependencies.
- Chrome or Edge to view the UI.
- Optional: Python 3.10+ with `pyyaml` and `psutil`, to run the Pi firmware on a PC.

### Start it

```bash
# from the project folder
npm start
# or double-click start.bat (Windows)
# or: node server/index.js
```

The terminal shows:

```
  ❄  ColdChain Sentinel — Azure IoT cold-storage monitoring
     Raspberry Pi edge · store-and-forward · Azure IoT Hub (simulated services)

     App        http://localhost:3000
     API        http://localhost:3000/api/endpoints
     Engine     seed 26879 · pharma profile · 5× real time
     Stop       Ctrl+C
```

The browser opens automatically. After that, the terminal prints every simulation event as it is processed:

```
21:11:33 HUB    coldstore-pi-01 connected (MQTT, SAS auth OK, keep-alive 60 s)
21:11:33 EDGE   CONNACK — connected to IoT Hub (handshake 624 ms, 7.5 KB)
21:11:39 FUNC   TelemetryIngest cold start: 1086 ms
[browser → server] networkOutage(60)
21:12:34 NET    WAN link DOWN — internet outage at the site
21:12:42 EDGE   PUBACK timeout for telemetry m5868 (1 in a row)
── status T+00:21:07 10× │ room 4.4°C OK │ WAN online │ MQTT CONNECTED │ queue 0 │ cloud docs 322 │ alerts 2 │ browsers 1
```

### Options

| Command | Effect |
|---|---|
| `npm start -- --port 4000` | use another port |
| `npm start -- --speed 10` | start at 10× real time (the UI can change it any time) |
| `npm start -- --seed 42` | reproducible live session |
| `npm start -- --profile frozen` | start with the frozen-food profile (−25…−15 °C) |
| `npm start -- --no-open` | do not open the browser |
| `npm start -- --quiet` | do not print every event to the terminal |
| `npm run dev` | same as `--speed 10` |
| `npm test` | 15 automated tests + experiments E1–E6, headless |
| `npm run test:firmware` | 14 Python unit tests of the Pi firmware |
| `http://localhost:3000/?script=E2&warm=700#live` | pre-run experiment E2's scenario for 700 simulated seconds (useful for rehearsals) |

### Run the Pi firmware on a PC

```bash
cd firmware
pip install pyyaml psutil
python -m unittest discover -s tests                         # 14 tests
python main.py --simulate --scenario outage --duration 150   # simulated sensors + local IoT Hub emulator
```

### Deploy for real

```bash
bash cloud/iot-hub/provision.sh     # creates IoT Hub, Service Bus, Cosmos DB, SignalR, Functions, Event Grid
bash firmware/setup_pi.sh           # on the Raspberry Pi: 1-Wire, I2C, venv, systemd service
# put the device connection string in /etc/coldstore/iothub.env, then:
sudo systemctl start coldstore && journalctl -u coldstore -f
```

---

## 4. Application architecture (server · engine · UI)

```
┌──────────────────────────── Node.js process (npm start) ─────────────────────────────┐
│                                                                                       │
│  server/index.js   bootstraps everything, parses CLI flags, opens the browser         │
│        │                                                                              │
│  server/host.js    SimulationHost — owns the ONE live Simulation                       │
│        │             every  50 ms : sim.advance(elapsed × speed)                       │
│        │             every 100 ms : push animation packets  → all browsers             │
│        │             every 250 ms : push state snapshots    → all browsers             │
│        │             every  15 s  : print a status line to the terminal                │
│        │                                                                              │
│  engine/*.js       the simulation itself (discrete-event):                             │
│        │             physics → sensors → edge Pi (rules, SQLite, uploader)             │
│        │             → network → Azure IoT Hub → routing → Functions / ASA → Cosmos    │
│        │             → SignalR / Logic App ;  metrics ; experiments ; self-tests       │
│        │                                                                              │
│  server/api.js     HTTP: REST endpoints + Server-Sent Events stream + static files     │
│  server/inspect.js live internal state of any topology node                            │
│  server/log.js     colour-coded terminal output                                        │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │  SSE /api/stream  (state, packets, events)
                                            │  REST /api/action, /api/twin, /api/method …
┌───────────────────────────────────────────┴───────────────────────────────────────────┐
│ Browser (public/)                                                                      │
│  js/remote.js   RemoteSim — read-only mirror of the server state, actions → HTTP       │
│  js/app.js      navigation, speed / pause / reset → server, toasts, buzzer sound       │
│  js/ui/*        topology animation, circuit, charts, diagrams, syntax highlighter      │
│  js/views/*     the nine views                                                         │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Why it is built this way

- **All processing happens on the server.** The browser does not simulate anything; it only displays and forwards clicks. When you point to the terminal, the judges can see every packet, timeout, alarm and Function run as it happens.
- **Several browsers can watch the same simulation.** For example, one laptop can drive the demo while a projector shows the dashboard. Every browser sees the same state, and actions from any of them apply to all.
- **Zero dependencies.** The server uses only Node's built-in `http` module, so there is no `npm install`, nothing to download, and nothing that breaks in an exam hall without Wi-Fi.
- **The engine files are dual-use.** `engine/util.js`, `config.js` and `rules.js` are loaded by both the server and the browser (shared formatting, configuration and alarm labels). The full engine also runs headless in `npm test`.

### How state reaches the browser efficiently

`server/host.js` builds one snapshot per tick and sends each browser only what it does not yet have:

- **Append-only streams carry only new items, tracked by a per-browser cursor:**
  - event log entries (by sequence number `n`)
  - Pi terminal lines (by `n`)
  - local reading history (by timestamp)
  - Cosmos DB documents (by an insertion counter `k`; back-filled documents are inserted into the browser's sorted copy)
- **Larger collections are re-sent only when they changed:**
  - alerts, notifications, devices/twins, Event Grid events, method calls, twin log
  - monitor-events, D2C counts, aggregates
  - the metrics summary and the latest MQTT message
- **Small live values are sent every tick:**
  - room, sensors, link, edge state, GPIO, LCD, queue
  - Function stats, quota

The browser's clock is interpolated between snapshots, so the time display runs smoothly.

---

## 5. The physical system we are modelling

```
 ┌──────────── COLD ROOM ────────────┐        ┌───────── Raspberry Pi 4 (outside, IP54 box) ───────┐
 │  DS18B20 probe ─┐                  │ cable  │  sensor drivers → fusion → rule engine              │
 │  DHT22 ─────────┼──────────────────┼─gland──│  → GPIO alarm (buzzer, LEDs, LCD)                   │
 │  door reed ─────┘                  │        │  → SQLite queue → uploader (MQTT/TLS)               │
 │  evaporator / compressor (mains)   │        │  UPS HAT keeps it alive in a power cut              │
 └────────────────────────────────────┘        └──────────────────┬──────────────────────────────────┘
                                                                  │ Wi-Fi / Ethernet
                                                         site router / 4G (mains)
                                                                  │ Internet (TLS 1.2, port 8883)
 ┌──────────────────────────────────── Microsoft Azure (Central India) ───────────────────────────────┐
 │ IoT Hub ─ alerts-route (alert='true') ─→ Service Bus ─→ Fn AlertProcessor ─→ Cosmos "alerts"        │
 │    │                                                         ├─→ Logic App → SMS / e-mail / Teams  │
 │    │                                                         └─→ SignalR → dashboard               │
 │    ├─ telemetry-route ─→ built-in events ─→ Fn TelemetryIngest ─→ Cosmos "telemetry" (dedupe)        │
 │    │                                   └─→ Stream Analytics ─→ 1-min aggregates + cloud-only rule   │
 │    ├─ device twin (limits, profile, interval) · direct methods (diag, silence, test, reboot)         │
 │    └─ Event Grid DeviceConnected/Disconnected ─→ Fn ConnectionMonitor ─→ "site offline" notice      │
 └─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

A **baseline cloud-only node** is simulated alongside the Pi for comparison. It shares the same sensors and the same link, but has no local rules, no buzzer and no buffer: readings taken offline are discarded, and its alarms come only from Stream Analytics in the cloud. This is how many simple IoT prototypes are built, which makes it the right yardstick.

---

## 6. Hardware: Raspberry Pi, sensors, circuit, BOM

### Components

| Component | Role | Key specification |
|---|---|---|
| Raspberry Pi 4 Model B (4 GB) | Edge gateway | BCM2711 4×Cortex-A72 1.5 GHz, Wi-Fi, 40-pin GPIO |
| DS18B20 waterproof probe | **Primary** temperature | 1-Wire, ±0.5 °C, 12-bit (0.0625 °C), 750 ms conversion, 4.7 kΩ pull-up |
| DHT22 / AM2302 | Humidity + fallback temperature | ±2 %RH, ±0.5 °C, single-wire, 10 kΩ pull-up, ~3 % checksum errors |
| MC-38 reed switch | Door open/closed | Contact to GND, internal pull-up, 50 ms debounce |
| 5 V active buzzer + 2N2222 + 1 kΩ | Audible alarm | ~30 mA, too much for a GPIO pin, hence the transistor |
| Red / green / amber LEDs + 330 Ω | ALARM / OK / cloud offline | Amber solid = offline; fast blink = syncing backlog |
| Tactile push button | Acknowledge | Silences the buzzer; the red LED stays on |
| 16×2 LCD + PCF8574 I²C backpack | Local readout at the door | I²C address 0x27 |
| UPS HAT (2×18650) | Power-cut survival | ~5.5 h for the Pi + sensors + buzzer |

### Pin map (BCM numbering)

| BCM | Physical pin | Direction | Connected to |
|---|---|---|---|
| 4 | 7 | IN | DS18B20 1-Wire data (4.7 kΩ to 3V3) |
| 17 | 11 | IN | DHT22 data (10 kΩ to 3V3) |
| 27 | 13 | IN | Door reed switch (HIGH = open) |
| 22 | 15 | IN | Acknowledge button (LOW = pressed) |
| 18 | 12 | OUT | Buzzer driver: 1 kΩ → 2N2222 base |
| 23 | 16 | OUT | Red LED — ALARM |
| 24 | 18 | OUT | Green LED — all OK |
| 25 | 22 | OUT | Amber LED — cloud offline / syncing |
| 2 / 3 | 3 / 5 | I²C | LCD SDA / SCL |
| 3V3, 5V, GND | 1, 2, 6 … | power | Sensor and LCD power, buzzer 5 V |

The **Raspberry Pi & Circuit** view draws this schematic live. Wires glow while their line is HIGH, the LEDs light, the buzzer vibrates and the LCD shows the real text. Click any part to see its specification and its Python driver code.

### Bill of materials (approx., India)

| Item | ₹ |
|---|---|
| Raspberry Pi 4 Model B 4 GB | 5,500 |
| DS18B20 probe | 150 |
| DHT22 module | 350 |
| Reed switch | 80 |
| Buzzer, LEDs, transistor, resistors, button | 85 |
| 16×2 I²C LCD | 250 |
| UPS HAT + cells | 1,800 |
| 32 GB endurance microSD | 450 |
| 5 V 3 A PSU | 600 |
| Enclosure, glands, wires | 450 |
| **Total** | **≈ ₹9,715 per cold room** |

---

## 7. Edge firmware (real Python for the Pi)

Located in `firmware/`. It runs as a systemd service (`coldstore.service`, `Restart=always`).

| File | What it does |
|---|---|
| `main.py` | The 5-second sampling loop: read → fuse → rules → alarm → SQLite → LCD. Also the twin and direct-method handlers and the `--simulate` mode. |
| `config.yaml`, `coldstore/config.py` | Defaults, product profiles (pharma / produce / frozen), merging of twin desired properties |
| `coldstore/sensors/ds18b20.py` | Parses `/sys/bus/w1/devices/28-*/w1_slave`. Rejects CRC failures and the 85.000 °C power-on-reset value. |
| `coldstore/sensors/dht22.py` | adafruit-circuitpython-dht with retries 2 s apart |
| `coldstore/sensors/door.py` | gpiozero `Button` on the reed switch; tracks how long the door has been open |
| `coldstore/sensors/simulated.py` | The same room physics as the engine, for running on a PC |
| `coldstore/rules.py` | Alarm engine (debounce, hysteresis, severity, status) and sensor fusion |
| `coldstore/actuators/alarm.py` | Buzzer and LED patterns, ACK button, amber cloud LED |
| `coldstore/actuators/lcd.py` | 16×2 LCD rendering through RPLCD |
| `coldstore/store.py` | SQLite (WAL, `synchronous=FULL`) store-and-forward queue: readings, alerts, sequence numbers, capacity policy |
| `coldstore/uploader.py` | Connection state machine, exponential backoff, priority sync, batching, twin sync on reconnect |
| `coldstore/cloud.py` | `azure-iot-device` wrapper (MQTT/TLS, QoS 1) and a local IoT Hub emulator |
| `coldstore/health.py` | CPU, RAM, SoC temperature (psutil / vcgencmd) |
| `tests/` | 14 unit tests (rule engine, store-and-forward, twin patch, restart survival) |
| `setup_pi.sh` | Enables 1-Wire and I²C, creates the venv and service user, installs the service |

**Verified:** `python main.py --simulate --scenario outage` raised HIGH_TEMP locally while offline (buzzer on in 0.16 ms), queued 20 readings, reconnected after 98 s, synced everything and **lost nothing**.

---

## 8. Azure cloud design (real deployable code)

Located in `cloud/`.

| Resource | Purpose | Code |
|---|---|---|
| IoT Hub (S1, Central India) | Device identities (SAS), MQTT endpoint, twins, direct methods, routing | `iot-hub/provision.sh` |
| Route `alerts-route` | `alert = 'true'` → Service Bus queue `cold-alerts` | `iot-hub/message-routes.json` |
| Route `telemetry-route` | `alert = 'false'` → built-in events endpoint | same |
| Service Bus queue | Durable buffer for alerts, independent of telemetry volume | provision script |
| Function **TelemetryIngest** | Event Hub trigger; expands batches; upserts into Cosmos with `id = deviceId-seq` (de-duplication); SignalR push | `functions/function_app.py` |
| Function **AlertProcessor** | Service Bus trigger; stores the alert; computes latency from `firstBreachAt`; Logic App notify; SignalR | same |
| Function **ConnectionMonitor** | Event Grid trigger on DeviceConnected/Disconnected; "site offline" notice | same |
| Function **negotiate** | SignalR connection info for the dashboard | same |
| Stream Analytics | Flattens batches (`CROSS APPLY GetArrayElements`), computes 1-min aggregates with `TIMESTAMP BY ts`, and runs the cloud-only alert rule for the baseline | `stream-analytics/coldstore-job.asaql` |
| Cosmos DB (serverless) | Containers `telemetry`, `alerts`, `aggregates`; partition `/deviceId`; TTL 90 days | provision script |
| SignalR (serverless) | Live push to the dashboard | provision script |
| Logic App + Communication Services | SMS, e-mail, Teams | `_notify()` in the Functions |

Guideline 6 allows Azure to be shown "with a student subscription, emulator, or clearly documented local simulation". This project ships **both**: the deployable code above, and a faithful, documented simulation of every one of these services in `engine/azure.js` (used by the running application).

---

## 9. The simulation engine — how everything is processed

All of this lives in `engine/` and runs inside the server.

### 9.1 Discrete-event kernel (`simulation.js`)

- Virtual time `t` in ms, and a binary-heap priority queue of scheduled callbacks (`schedule(ms, fn)`, `every(ms, fn)`).
- `advance(ms)` pops and runs every event due in the window, in time order. The server calls it every 50 ms with `elapsed × speed`.
- A **seeded random generator** (mulberry32) makes every run with the same seed identical, which is what makes the experiments reproducible.
- **Scenario actions:**
  - door: open / close
  - compressor: failure / repair
  - thermostat stuck on
  - humidity surge
  - sensor faults
  - internet: outage / degraded / restore
  - site power failure / restore
  - Pi reboot
  - ACK button press

### 9.2 Cold-room physics (`physics.js`), integrated every 1 s

```
dT/dt = (k_leak + k_door·door_open) · (T_ambient − T) − cooling · compressor_running
k_leak = 3.6×10⁻⁴ s⁻¹   k_door = 3.0×10⁻³ s⁻¹   cooling = 0.035 °C/s   T_ambient = 32 °C
thermostat: compressor ON above set point + 1 °C, OFF below set point − 1 °C
```

| Event | Effect |
|---|---|
| Door open | Fast warming (~0.08 °C/s); humidity rises towards ambient |
| Compressor failure | Room warms ~0.6 °C/min |
| Stuck thermostat | Room over-cools below the minimum |
| Power failure | Compressor and router stop; the Pi continues on the UPS |

The firmware's `simulated.py` uses the same constants.

### 9.3 Sensor models (`sensors.js`)

- **DS18B20:**
  - first-order lag τ = 25 s
  - noise σ = 0.05 °C
  - quantisation to 0.0625 °C
  - faults: unplugged (CRC fail) or 85 °C power-on-reset
- **DHT22:**
  - lag τ = 12 s
  - noise 0.15 °C / 0.8 %RH
  - +0.2 °C factory offset
  - 3 % checksum errors with up to 3 retries (2 s apart)
  - fault: unplugged
- **Shared frames:** one `sample()` per instant is shared by the edge Pi, the baseline node and the reference observer, so the comparison runs on **identical readings**.

### 9.4 Edge device (`edge.js`), a port of `main.py` + `store.py` + `uploader.py`

Every sample interval (5 s) the edge device:

1. reads the sensors (750 ms DS18B20 conversion, plus DHT22 retries);
2. fuses them (probe first, DHT22 as fallback);
3. runs the rule engine;
4. on RAISED, sets the buzzer, red LED and LCD within 0.2–0.5 ms, and queues the alert;
5. writes the row to the SQLite model (PENDING, `seq`, link state at sampling time);
6. updates the LCD and the terminal line;
7. kicks the uploader.

The device also models CPU, RAM, SoC temperature, `queue.db` size, the reboot behaviour (RAM state lost, queue kept) and the twin/method handlers.

### 9.5 MQTT client (`mqtt.js`)

| Behaviour | Model |
|---|---|
| Connect | 6 round trips (TCP, TLS ×2, CONNECT with SAS, SUBSCRIBE, twin GET), about 7.5 KB |
| Delivery | QoS 1 publish; a message counts as delivered only on PUBACK |
| Loss detection | 4 s PUBACK timeout; 2 consecutive timeouts = connection lost |
| Reconnect | Exponential backoff 1, 2, 4 … 32 s with ±20 % jitter |
| Keep-alive | PINGREQ when idle, within the 60 s keep-alive |
| Byte accounting | Payload + topic + MQTT header + 29 B TLS record + 40 B TCP/IP for every message |

### 9.6 Network (`network.js`)

| Mode | One-way latency | Loss | Bandwidth |
|---|---|---|---|
| Online | 42 ms ± 22 ms | 0.1 % | 20 Mbit/s |
| Degraded (weak 4G) | 650 ms ± 450 ms | 12 % | 256 kbit/s |
| Offline / router without power | — | 100 % | — |

A packet that is in flight when the link drops is lost, as a real TCP segment would be.

### 9.7 Azure services (`azure.js`), each hop with a latency range

| Service | Modelled latency / behaviour |
|---|---|
| IoT Hub ingest → PUBACK | 6–22 ms |
| Service Bus | 12–40 ms |
| Function warm / **cold start** (after 20 min idle) | 35–140 ms / **0.9–2.2 s** |
| Cosmos DB write | 6–18 ms |
| Logic App → SMS / e-mail | 350–900 ms |
| SignalR push | 20–65 ms |
| Stream Analytics | 1.2–3.2 s |
| Event Grid lifecycle events | 0.8–2.5 s |
| Session drop on silence | 1.5 × keep-alive = 90 s |

The model also includes quotas (S1, 4 KB metering), device twins with versions, direct methods (404103 when offline, 504 on timeout), de-duplication by id, and out-of-order alert handling.

### 9.8 Baseline device (`baseline.js`)

The same sensors and link, with QoS 1 and no retry. It has no buffer and no local rules. Its alarms come from the cloud rule in Stream Analytics, evaluated only on readings that actually arrived.

### 9.9 Measurement layer (`metrics.js`), which only watches

- **Data loss:** every reading is tagged (device, seq, link state when taken). It is *delivered* the first time Cosmos stores it, and *lost* if it was never stored and is not still waiting on the Pi.
- **Alert response:** a reference observer applies the same rule to the same frames. It opens an **episode** at the first out-of-range sample, and labels it *connected* or *disconnected* by the link state at that moment. For each episode it records:
  - when the Pi's buzzer turned on,
  - when the operator's SMS for the edge alert was sent,
  - when the baseline's SMS was sent.
- **Other measures:**
  - bandwidth (wire bytes, payload, TLS bytes)
  - batching saving
  - sync duration
  - outage detection time (edge vs cloud)
  - live end-to-end latency
  - reboots

---

## 10. Key algorithms

### 10.1 Alarm channel state machine (`rules.py` / `rules.js`)

```
for each channel in HIGH_TEMP, LOW_TEMP, HIGH_RH, LOW_RH, DOOR_OPEN, SENSOR_FAULT, SENSOR_DISAGREE:
    if not active:
        if out_of_range: count += 1 (first sample → firstBreachAt)
            if count ≥ N (2): RAISE → buzzer + LED + LCD, queue alert
        else: count = 0                       # a single spike is filtered
    elif value inside (limit − hysteresis):   # 0.3 °C / 2 %RH
        CLEAR → outputs off when no channel is active
```

- **Severity:**
  - HIGH/LOW_TEMP and SENSOR_FAULT are *critical*: blinking red LED, SMS.
  - Humidity, door and sensor-disagreement alarms are *warnings*.
- **Status:**
  - ALARM — a critical temperature alarm is active
  - FAULT — both sensors have failed
  - WARN — a warning alarm is active, or the temperature is within 0.5 °C of a limit
  - OK — otherwise

### 10.2 Store-and-forward + priority sync (`store.py`, `uploader.py`, `edge.js`)

```
sample → INSERT reading (PENDING, seq++)          # written BEFORE any send
uploader loop:
    if not connected: connect() with backoff; on success: GET twin, report properties
    1. send queued alerts (app property alert=true)       → remove on PUBACK
    2. send live rows (≤ 2 sample periods old), one each  → mark SENT on PUBACK
    3. send backlog: oldest 50 PENDING rows as ONE batch  → mark SENT on PUBACK
    2 consecutive PUBACK timeouts → DISCONNECTED, amber LED solid
```

**Guarantees:**

- **At-least-once delivery:** QoS 1 plus persist-before-send.
- **Idempotent storage:** the cloud stores each reading with `id = deviceId-seq`, so duplicates overwrite themselves.
- **Together these give effectively exactly-once data.**
- **When the buffer is full**, delivered rows are evicted first, then the oldest undelivered rows, and the loss is counted.

### 10.3 Why the local alarm takes 5.76 s

| Component | Time |
|---|---|
| Waiting for the 2nd confirming sample (5 s interval) | 5.00 s |
| DS18B20 12-bit conversion | 0.75 s |
| Rule evaluation + GPIO write | < 1 ms |
| **Total, from the first out-of-range sample** | **≈ 5.76 s** |

The confirmation delay is configurable through the twin (`alarm_delay_samples`). It trades false alarms against speed.

---

## 11. Message formats and protocols

**MQTT topic:** `devices/coldstore-pi-01/messages/events/%24.ct=application%2Fjson&%24.ce=utf-8&type=telemetry&alert=false`

**Live telemetry:**

```json
{ "type": "telemetry", "deviceId": "coldstore-pi-01", "seq": 1842, "ts": "2026-10-21T04:12:35.000Z",
  "tempC": 4.62, "rh": 54.8, "ds18b20C": 4.62, "dht22C": 4.8, "door": "closed",
  "status": "OK", "alarms": [], "buffered": false, "fw": "1.4.2" }
```

**Backlog batch** (compact keys, 50 readings per message):

```json
{ "type": "batch", "deviceId": "coldstore-pi-01", "batchId": 3, "count": 50, "fromSeq": 1901, "toSeq": 1950,
  "readings": [ { "q": 1901, "ts": "2026-10-21T04:17:30.000Z", "t": 8.44, "h": 58.9, "d": 0, "s": "ALARM" } ] }
```

**Alert** (application property `alert=true`, routed to Service Bus):

```json
{ "type": "alert", "alertId": "AL-00007", "alarm": "HIGH_TEMP", "state": "RAISED", "severity": "critical",
  "value": 8.31, "threshold": 8, "firstBreachAt": "…", "raisedAt": "…", "localActionAt": "…",
  "localActions": ["buzzer", "red_led", "lcd"], "bufferedMs": 460212 }
```

**Device twin desired properties:** `profile`, `thresholds.{temp_min_c, temp_max_c, rh_min_pct, rh_max_pct, alarm_delay_samples}`, `sampleIntervalSec`.
**Reported properties:** the same fields plus `firmware`, `queueDepth`, `connectivity`.

**Direct methods:** `getDiagnostics`, `silenceAlarm`, `testAlarm {seconds}`, `reboot`.

---

## 12. Features of the application, view by view

### ◉ Live Simulation

- **Animated topology** of the whole system:
  - cold room (colour follows temperature, door opens, fan spins)
  - condensing unit
  - Raspberry Pi (header pins light up)
  - local alarm panel (real LCD text, LEDs, buzzer waves, clickable ACK button)
  - SQLite queue (fill level)
  - UPS (battery %)
  - baseline node
  - router and Internet (red ✕ when cut)
  - IoT Hub and every Azure service, the operator's phone and the dashboard
- **Moving packets:**
  - colour-coded: live reading, batch (×50), alert, PUBACK, TLS, twin/method, lifecycle event, SMS, sensor read
  - lost packets explode with a ✕
- **Hover any link** to see its protocol. **Click any node** to see its live internal state, fetched from the server. **Click a packet** to see its MQTT topic and payload.
- **Inject events:** door open 90 s / hold open, compressor failure, thermostat stuck, humidity surge, unplug DS18B20 / DHT22, 85 °C glitch, internet outage 5 min / manual cut, degraded 4G, site power failure, reboot Pi, ACK button, silence via cloud (direct method), twin change of the maximum temperature.
- **Live readings card:** what the Pi measures vs what Azure has, status chips, a sparkline, queue depth, MQTT state, local/cloud alert counts, lost readings for edge and baseline, last sync.
- **Event log** with filters (Edge, Network, Azure, Alarms, Baseline).
- **"Message on the wire" inspector:** topic, properties, message id, payload bytes and wire bytes with the overhead broken down.

### ▦ Raspberry Pi & Circuit

- Live schematic with glowing wires, LEDs, buzzer, reed-switch state and the LCD; export to SVG.
- Component inspector: specification, pins and the Python driver code at the relevant function.
- 16×2 LCD replica with ACK and power-cycle buttons.
- System resources: CPU, RAM, SoC temperature, uptime, `queue.db` size, sensor error counts.
- GPIO table with live HIGH/LOW levels.
- `journalctl -u coldstore -f` terminal, in the exact Python logging format.
- Raw sensor output (`w1_slave` contents, DHT22 attempts, `gpioget`).
- SQLite queue table (PENDING / IN-FLIGHT rows, attempts).
- Bill of materials.

### ☁ Azure IoT Hub (portal-style)

| Tab | Shows |
|---|---|
| Overview | KPIs, messages/minute chart, Event Grid events, recent alerts |
| Devices & twin | Registry, full twin JSON, an **editable desired-properties form**, twin change log |
| Direct methods | Invoke getDiagnostics / silenceAlarm / testAlarm / reboot and see status + round trip (404103 when offline) |
| Message routing | Routes with live counts and the ARM fragment |
| Monitor events | Same format as `az iot hub monitor-events --properties all` |
| Functions | Invocations, cold starts, durations; AlertProcessor executions with latencies |
| Stream Analytics | The query and its 1-min aggregate output |
| Cosmos DB | Container counts, back-filled count, duplicates discarded, Data Explorer table, latest document |
| Notifications | A phone with SMS messages, plus an e-mail/Teams list |

### ▤ Operator Dashboard

- Status banner: SAFE / WARNING / ALARM / DEVICE OFFLINE (edge is buffering).
- Temperature and humidity gauges with the safe band.
- Device and link card; compliance card (time in range, **MKT**, min/max, excursions).
- KPI row: average, readings, back-filled, active alerts, end-to-end latency, notifications.
- Temperature and humidity history:
  - offline periods shaded, alert markers
  - **back-filled points in amber**, baseline overlay, optional edge-local truth
  - ranges from 10 min to All
- Alert table with local-buzzer vs SMS latency and a remote **Silence** button.
- Data-completeness bars (edge vs baseline).
- CSV export.

### ⚖ Experiments & Results

- Runs E1–E6 **on the server** (seed and profile selectable).
- Headline table: connected vs disconnected × edge vs cloud-only.
- Charts: alert response time (log scale), data loss per experiment, bandwidth per hour, outage detection and sync time.
- Per-experiment table and every excursion measured.
- Security / bandwidth / resource cards.
- **Live-session comparison** that updates as you inject events.
- JSON and CSV download.

### ⬡ Architecture & Data Flow

- Layered architecture, numbered data-flow diagram, outage/recovery sequence diagram, alarm-channel and connection state machines (all exportable as SVG).
- Message contracts, design decisions with trade-offs, technology stack, security and privacy.

### {} Source Code

- **Every project file (74), read live from disk by the server.** No copy is involved, so what you see is exactly what runs.
- Grouped as: application server → engine → firmware → cloud → web UI → docs.
- Syntax highlighting, line numbers, full-text search, copy and download.
- "Open source" buttons across the app jump straight to the relevant function.

### ▣ Project Report

- The full report: problem definition, objectives, architecture, hardware, software, implementation (with algorithms), testing (live test table), results (live experiment numbers and charts), limitations, future scope, conclusion, references, team roles, reproduction steps.
- **Print → Save as PDF.**

### ? Demo Guide & Viva

- **Guided demo:** about 3 minutes, narrated, auto-advancing through 10 steps.
- A 9-step manual demo script with "Run" buttons.
- A "what is real vs simulated" table.
- 26 viva questions with answers.

### Global controls

- Speed 1× / 5× / 10× / 30× / 60× and pause (Space bar), all applied **on the server**.
- Reset (new seed, on the server).
- Buzzer sound (Web Audio).
- Light/dark theme.
- Status pills: ROOM, WAN, MQTT, QUEUE, **SERVER** (connection and number of browsers).

---

## 13. REST API and live stream reference

All endpoints are served by `server/api.js`. The list is also available at `GET /api/endpoints`.

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/stream` | Server-Sent Events: `state` (4/s), `packets` (10/s), `events` (toasts), `reset` |
| GET | `/api/state` | Full one-shot snapshot of the running simulation |
| POST | `/api/control` | `{ "speed": 10, "playing": true }` |
| POST | `/api/action` | `{ "name": "networkOutage", "args": [300] }` — inject an event |
| POST | `/api/reset` | `{ "seed": 42, "profile": "pharma", "script": "E2", "warm": 600 }` |
| POST | `/api/twin` | `{ "deviceId": "coldstore-pi-01", "patch": { "thresholds": { "temp_max_c": 7 } } }` |
| POST | `/api/method` | `{ "deviceId": "coldstore-pi-01", "name": "getDiagnostics", "payload": {} }` |
| GET | `/api/inspect/:node` | Live internal state of a node (`pi`, `sqlite`, `hub`, `cosmos`, …) |
| GET | `/api/experiments?seed=2026&profile=pharma` | Run E1–E6 on the server (`&cached=1` returns the last run) |
| GET | `/api/selftest` | Run the 15 automated tests on the server |
| GET | `/api/sources` | All project source files |
| GET | `/api/health` | Liveness |

**Allowed actions:** `openDoor, closeDoor, toggleDoor, failCompressor, repairCompressor, setThermostatStuck, humiditySurge, sensorFault, ds18b20Glitch, networkOutage, restoreNetwork, degradeNetwork, sitePowerFail, restorePower, rebootPi, pressAck`.

**Demo with curl** (while the app is open, to show the judges that the server is in control):

```bash
curl -X POST localhost:3000/api/action -H "Content-Type: application/json" -d "{\"name\":\"networkOutage\",\"args\":[120]}"
curl localhost:3000/api/inspect/sqlite
```

---

## 14. Experiments and measured results

### 14.1 Scenarios (each run headless, seed 2026, both architectures side by side)

| Id | Scenario | What happens |
|---|---|---|
| E1 | Connected — door left open, compressor fault | 40 min online; door open 200 s at 5 min; compressor fails 15→25 min; humidity surge |
| E2 | Disconnected — compressor fails during a 15-min outage | Outage 5→20 min; compressor fails at 7 min and is repaired at 16 min, so the excursion ends while offline; a connected door event at 25 min for contrast |
| E3 | Site power failure, 20 min | Compressor and router lose power; the Pi runs on its UPS |
| E4 | Degraded link | 650 ms latency, 12 % loss for 35 min; compressor fault and door event |
| E5 | Long outage, small buffer (120 rows) | A 30-min outage overflows a deliberately small queue (shows the design limit) |
| E6 | Pi reboot during an outage | 12-min outage; Pi power-cycled at 9 min; the queue must survive |

### 14.2 Per-experiment results

| Exp | Edge delivered | Cloud-only delivered | Local alarm | Edge → SMS | Cloud-only → SMS | Backlog sync |
|---|---|---|---|---|---|---|
| E1 | 100 % | 100 % | 5.76 s | 6.49 s | 8.15 s | — |
| E2 | 100 % | 61.0 % | 5.76 s | 2 m 37 s | 8.17 s (1 missed) | 572 ms / 186 rows |
| E3 | 100 % | 55.2 % | 5.76 s | 13 m 00 s | 13 m 02 s | 724 ms / 241 rows |
| E4 | 100 % | 75.4 % | 5.76 s | 7.21 s | 19.0 s | 2.51 s |
| E5 | 55.0 % | 32.0 % | 5.76 s | 17 m 31 s | — (1 missed) | 421 ms |
| E6 | 100 % | 59.7 % | 5.76 s | 9 m 50 s | — (2 missed) | 361 ms |

In E2 the "Edge → SMS" figure of 2 m 37 s is an average over all three of that run's excursions, two of which happened while connected. The excursion during the outage itself was reported after 7 m 40 s.

### 14.3 Connected vs disconnected (pooled over E1–E4 and E6)

| Metric | Edge · connected | Edge · disconnected | Cloud-only · connected | Cloud-only · disconnected |
|---|---|---|---|---|
| Local alarm | 5.76 s | **5.76 s** | none | none |
| Operator SMS | 6.57 s | 10 m 05 s | 11.8 s | 13 m 02 s; **3 of 4 never** |
| Excursions with no alert | 0 | 0 | 0 | **3** |
| Readings lost | 0 / 1776 | **0 / 559** | 128 / 1776 | **564 / 564** |
| Data loss | 0.00 % | **0.00 %** | 7.21 % | **100 %** |
| Mean delivery delay | 635 ms | 8 m 12 s (back-filled) | 319 ms | — (lost) |

### 14.4 Other measured quantities

| Quantity | Value |
|---|---|
| Decision-to-actuation latency on the Pi | < 1 ms |
| Live reading → dashboard (end to end) | ≈ 0.2–0.5 s |
| Outage detection: edge vs cloud | **≈ 9 s vs ≈ 92 s** |
| Bandwidth while connected | ≈ 350 KB/h of wire bytes (≈ 8 MB/day) |
| Batching saving during sync | ≈ 79 % fewer bytes, 50× fewer metered messages |
| Security (TLS) overhead | 14–20 % of wire bytes, + ≈ 6 KB per handshake |
| Reliability on a 12 %-loss link | 100 % delivered; 58 duplicates discarded by idempotent upsert |
| Pi resources | CPU ≈ 3–8 % (≈ 15 % while syncing), RAM ≈ 62 MB, ≈ 188 B per SQLite row |
| Buffer autonomy | 100 000 rows ≈ 5.8 days at 5 s sampling (≈ 18 MB) |
| Privacy exposure | Temperature, humidity, door and device id only; no personal data |

### 14.5 What the results mean

- **The local alarm does not depend on the network:** 5.76 s connected, and the same 5.76 s disconnected.
- **For the cloud-only design, alert latency is bounded by the outage length, and short excursions are missed completely.** If the temperature goes back in range before the link returns, the cloud never knows it happened.
- **Store-and-forward reduces outage data loss from 100 % to 0 %.** The cost is delivery delay: readings arrive minutes late and are marked as back-filled.
- **E5 is the honest limit:** an outage longer than the buffer drops the oldest data, which is why the default buffer covers almost six days.
- **Function cold starts add about 1–2 s** to the first alert after a quiet period.

---

## 15. Testing

| Level | Count | How to run |
|---|---|---|
| Firmware unit tests (Python) | 14 — rule engine, debounce, hysteresis, door, sensor fault, twin patch, outage sync, restart survival, capacity, alert de-dup | `npm run test:firmware` |
| Engine unit + integration tests | 15 — see the table below | `npm test`, or Report view / `GET /api/selftest` |
| Scenario experiments | 6 | Results view or `npm test` |
| End-to-end firmware run | 1 | `python main.py --simulate --scenario outage` |
| UI | All 9 views | Rendered against the running server in headless Chrome, no console errors |

**Engine tests:**

| Id | Test |
|---|---|
| U1 | A single out-of-range sample is filtered |
| U2 | HIGH_TEMP raised on the 2nd sample, firstBreachAt = 1st sample |
| U3 | Hysteresis: clears only at limit − 0.3 °C |
| U4 | Door open > 120 s raises DOOR_OPEN; closing clears it |
| U5 | Probe failure falls back to DHT22; both failed → SENSOR_FAULT |
| U6 | Queue capacity drops the oldest pending rows |
| I1 | Connected excursion: local alarm < 7 s, SMS < 12 s |
| I2 | 10-min outage: edge loses 0, baseline loses the outage window |
| I3 | Excursion during an outage: buzzer offline, alert delivered after reconnect, baseline never alerts |
| I4 | Lossy link: duplicates discarded, each reading stored once |
| I5 | Pi reboot: queue survives, sequence numbers continue, no gaps |
| I6 | A twin change made offline is applied on reconnect |
| I7 | A direct method to an offline device fails with 404103 |
| I8 | Buffer overflow is counted, not silent |
| I9 | The edge detects an outage before the cloud does |

**All pass: 15/15 engine tests and 14/14 firmware tests.**

---

## 16. Security and privacy

- **Identity:** each device has its own identity and symmetric key; the SAS token is regenerated hourly. The upgrade path is X.509 certificates + TPM through the Device Provisioning Service.
- **Transport:** TLS 1.2 on every hop. The measured overhead is 14–20 % of wire bytes, plus about 6 KB per handshake.
- **Secrets:**
  - the device connection string lives in `/etc/coldstore/iothub.env` (chmod 600) and is never in the repository
  - cloud secrets are in app settings or Key Vault
- **Least privilege:** a device can publish only to its own topic; staff use Azure RBAC; Functions use managed identities.
- **Privacy:** only temperature, humidity, door state and a device id leave the site. There is no personal data, camera or location. Data is encrypted in transit and at rest in Cosmos DB.
- **Known gap:** the local SQLite file on the SD card is not encrypted (see limitations).

---

## 17. Limitations

1. **Azure is simulated** with latency ranges typical of each service. Absolute cloud numbers will differ on a real subscription, but the comparison between the two designs still holds.
2. The room model is **lumped** (a single air temperature). Large rooms need several probes.
3. The buffer is finite: an outage longer than about 5.8 days, or E5's deliberately small buffer, drops the oldest data.
4. When the site is offline, remote staff learn of it only after about 90 s, and learn about an excursion only after reconnect. Only people at the site hear the buzzer.
5. The SD card is a single point of failure, and the local database is not encrypted.
6. The DHT22 is a low-cost sensor. Regulated pharma storage needs calibrated, certified sensors and an audit trail (21 CFR Part 11).

---

## 18. Future scope

- A GSM or LoRaWAN fallback so the Pi can send an SMS itself during WAN outages.
- Azure IoT Edge runtime with a local Stream Analytics module and over-the-air firmware updates.
- X.509 + TPM attestation through the Device Provisioning Service.
- Predictive maintenance from compressor duty cycle and pull-down rate.
- Many rooms and sites with Azure Digital Twins; Power BI compliance and MKT reports per product batch.
- Premium Functions (no cold start), geo-redundant Cosmos DB, dual-WAN (fibre + 4G) failover.

---

## 19. How each submission guideline is met

| Guideline | Where |
|---|---|
| Groups of five, one problem statement | Problem Statement 1; team roles in §21 and the report's Appendix A |
| Working prototype / reproducible simulation | `npm start` application (seeded, deterministic experiments); firmware `--simulate` |
| Source code | `server/`, `engine/`, `public/`, `firmware/`, `cloud/`, all viewable in the Source Code view |
| Circuit / setup diagrams | Raspberry Pi & Circuit view (live, exportable SVG), pin map, BOM, `setup_pi.sh` |
| Architecture / data-flow diagram | Architecture & Data Flow view: 5 diagrams, SVG export |
| Report: problem, architecture, hardware/software, implementation, testing, results, limitations, future scope | Project Report view → PDF; this document |
| Measured results: latency, bandwidth, reliability, resource use, privacy, security overhead | Experiments & Results view; §14 |
| Demonstrate; every member can explain | Guided demo, manual script, viva Q&A (§20–21) |
| Azure via student subscription / emulator / documented local simulation | Documented local simulation (`engine/azure.js`) + deployable code (`cloud/`) |

---

## 20. Demo script for the evaluation

Roughly 10 minutes. Start with `npm start`, then keep the terminal and the browser side by side.

1. **Architecture first.** Explain that the server runs the whole system, show the terminal printing every event, and show the browser displaying it.
2. **Live view at 5×.** Walk through each block and hover a link to show its protocol. Click a blue packet to show the real JSON payload and MQTT topic.
3. **Local alarm while connected.** Click *Door open 90 s*. HIGH_TEMP fires: buzzer, red LED, LCD "ALARM". The SMS reaches the phone a little later. Compare the two latencies in the dashboard's alert table.
4. **Outage.** Click *Cut internet*. Point out:
   - the PUBACK timeouts in the terminal
   - MQTT going to BACKOFF and the amber LED turning on
   - the SQLite queue growing
   - the baseline discarding readings
5. **Fault during the outage.** Click *Compressor failure* and set the speed to 30×. The buzzer still fires. On the dashboard, show DEVICE OFFLINE and the gap in the history.
6. **Remote change while offline.** In Azure IoT Hub → Devices & twin, set temp_max_c to 7. Then invoke getDiagnostics and show the 404103 error.
7. **Recovery.** Click *Restore internet* and *Repair compressor*. Show:
   - the reconnect and the twin being applied
   - the alert delivered "late"
   - the orange batches and the queue returning to 0
   - the gap filling with amber points on the dashboard
8. **Robustness.** Unplug the DS18B20 (falls back to DHT22), trigger the 85 °C glitch (rejected), reboot the Pi (queue survives), switch to degraded 4G (duplicates discarded).
9. **Results.** Run all experiments and explain the headline table.
10. **Code.** Show `server/host.js` (the real-time loop), `engine/edge.js` (the edge logic), and `firmware/` and `cloud/` (the deployable code). Finish with the report → PDF.

The **▶ Guided demo** button runs a narrated version of steps 2–9 automatically.

---

## 21. Team roles and viva preparation

| Member | Owns | Should be ready to explain |
|---|---|---|
| 1 | Hardware & sensors | Circuit, pull-ups, transistor driver, DS18B20/DHT22 protocols, faults, BOM, UPS |
| 2 | Edge firmware | Rule engine (debounce, hysteresis), alarm controller, systemd, sensor fusion |
| 3 | Connectivity & sync | MQTT/TLS, QoS 1, PUBACK, backoff, SQLite store-and-forward, batching, de-duplication |
| 4 | Azure cloud & dashboard | IoT Hub routing, twin/methods, Functions, Stream Analytics, Cosmos, SignalR, dashboard, the application server |
| 5 | Testing & results | Experiment design, baseline, metric definitions, results, limitations |

### Most likely questions (short answers; all 26 are in the app's Demo Guide)

- **Why decide on the Pi?** Because the alarm must work when the internet, often together with the power, is gone. The local path has no network in it at all.
- **How is no data lost?** Every reading is written to SQLite before sending, it is marked SENT only after PUBACK, and the queue survives crashes and reboots.
- **Duplicates?** QoS 1 can deliver twice. Cosmos `id = deviceId-seq` makes the second copy a no-op.
- **Why not QoS 2?** IoT Hub supports only QoS 0 and 1.
- **How was response time measured?** From the first out-of-range sample, on identical readings for both designs, labelled by the link state at that moment.
- **Why 5.76 s?** 5 s for the second confirming sample, plus 0.75 s sensor conversion; the actuation itself is under 1 ms.
- **How does the cloud know the Pi is offline?** After 90 s of silence (1.5 × keep-alive) IoT Hub closes the session, Event Grid sends DeviceDisconnected, and the ConnectionMonitor Function notifies staff.
- **What if the outage is longer than the buffer?** The oldest readings are dropped and counted (E5). The default buffer lasts about 5.8 days.
- **Is Azure real?** The simulation is documented, as guideline 6 allows. The deployable Functions, Stream Analytics query and provisioning script are included.
- **Where does the processing happen in this app?** In the Node.js server: `server/host.js` advances the `engine/` simulation every 50 ms and streams state to the browser.

---

## 22. Complete file map

```
APE simulation/
├── package.json              npm start / npm test (no dependencies)
├── start.bat                 double-click launcher (Windows)
├── README.md                 short overview
├── everything.md             this document
│
├── server/                   ── APPLICATION SERVER (Node.js) — runs everything
│   ├── index.js              entry point: CLI flags, HTTP server, banner, open browser
│   ├── host.js               SimulationHost: real-time loop, snapshots, SSE, commands
│   ├── api.js                REST endpoints, SSE stream, static files, sources
│   ├── inspect.js            live state of each topology node
│   └── log.js                colour-coded terminal output + status line
│
├── engine/                   ── SIMULATION ENGINE (runs inside the server)
│   ├── index.js              loads the engine in dependency order
│   ├── util.js               seeded RNG, emitter, priority queue, formatters   (shared with UI)
│   ├── config.js             profiles, defaults, GPIO map, latencies, BOM        (shared with UI)
│   ├── rules.js              alarm engine — port of firmware rules.py            (shared with UI)
│   ├── simulation.js         discrete-event kernel + scenario actions
│   ├── physics.js            cold-room thermal / humidity model
│   ├── sensors.js            DS18B20, DHT22, reed models with faults
│   ├── edge.js               Raspberry Pi: sampling, alarm, SQLite, uploader, twin, reboot
│   ├── mqtt.js               MQTT/TLS client: connect, QoS 1, timeouts, backoff, keep-alive
│   ├── network.js            WAN link: online / degraded / offline / router power
│   ├── baseline.js           cloud-only comparison device
│   ├── azure.js              IoT Hub, routing, Service Bus, Functions, ASA, Cosmos, Event Grid, SignalR, Logic App
│   ├── metrics.js            data-loss and alert-response measurement
│   ├── experiments.js        scenarios E1–E6 and pooling
│   └── selftest.js           15 unit + integration tests
│
├── public/                   ── WEB UI (browser — display only)
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── app.js            controller: SSE connection, navigation, controls
│       ├── remote.js         RemoteSim mirror + API client
│       ├── ui/               dom, charts, highlight, topology, circuit, diagrams
│       └── views/            live, hardware, cloud, dashboard, results, architecture, source, report, guide
│
├── firmware/                 ── RASPBERRY PI EDGE APPLICATION (Python, deployable)
│   ├── main.py · config.yaml · requirements.txt · coldstore.service · setup_pi.sh
│   ├── coldstore/            config, models, rules, store, uploader, cloud, health, sensors/, actuators/
│   └── tests/                test_rules.py, test_store.py
│
├── cloud/                    ── AZURE (deployable)
│   ├── iot-hub/              provision.sh, message-routes.json, device-twin.json
│   ├── functions/            function_app.py, host.json, requirements.txt, local.settings.sample.json
│   └── stream-analytics/     coldstore-job.asaql
│
└── tools/
    └── selftest.js           headless tests + experiments (npm test)
```

The project is about 8,800 lines of code across 74 files.

---

## 23. Glossary

| Term | Meaning |
|---|---|
| **Edge** | Computing at the site (the Raspberry Pi) instead of in the cloud |
| **Store-and-forward** | Save data locally first, send it when possible |
| **MQTT** | Lightweight publish/subscribe protocol used by IoT Hub (port 8883 over TLS) |
| **QoS 1** | "At least once": the sender keeps a message until it receives a PUBACK |
| **PUBACK** | The broker's acknowledgement of a QoS 1 message |
| **SAS token** | Shared Access Signature, a time-limited credential derived from the device key |
| **Device twin** | A JSON document in IoT Hub: *desired* settings from the cloud, *reported* state from the device |
| **Direct method** | A synchronous request/response call from the cloud to an online device |
| **Message routing** | IoT Hub rules that send messages to different endpoints based on a query |
| **Event Grid** | Azure eventing; here it carries DeviceConnected / DeviceDisconnected |
| **Cold start** | Extra delay when a serverless Function runs after being idle |
| **Back-fill** | Late-arriving historical readings filling a gap after an outage |
| **Idempotent** | Doing it twice has the same effect as doing it once (an upsert by id) |
| **Debounce / confirmation delay** | Requiring N consecutive bad samples before alarming |
| **Hysteresis** | Clearing an alarm only a margin inside the limit, to stop flapping |
| **MKT** | Mean kinetic temperature, the single temperature expressing cumulative thermal stress (USP ⟨1079⟩) |
| **SSE** | Server-Sent Events, a one-way live stream from server to browser over HTTP |
| **Discrete-event simulation** | Time jumps from event to event in order, instead of ticking continuously |
| **Seed** | The starting value of the random generator; the same seed gives the same run |
