# ColdChain Sentinel — Azure IoT Hub cold-storage monitoring (Problem Statement 1)

A Raspberry Pi edge device detects unsafe cold-room conditions **locally**, sounds an alarm with no internet needed, buffers every reading in SQLite during outages, and syncs the queue to **Azure IoT Hub** when the link returns. A cloud dashboard shows live status and history. The project compares **alert response time and data loss, connected vs disconnected**, against a cloud-only baseline.

**Full documentation: [everything.md](everything.md)**

## Run the application

```bash
npm start            # or double-click start.bat  →  http://localhost:3000 opens automatically
```

Node.js 18+ is required. There are no dependencies and no `npm install`. The **server** runs the whole simulation and prints every event to the terminal. The **browser** only displays the state and sends your actions back.

| Command | What it does |
|---|---|
| `npm start -- --speed 10 --seed 42 --port 3000` | Start with options (`--no-open`, `--quiet`, `--profile frozen`) |
| `npm test` | 15 automated tests + experiments E1–E6, headless |
| `npm run test:firmware` | 14 Python unit tests of the Pi firmware |
| `cd firmware && python main.py --simulate --scenario outage` | Real firmware on a PC with simulated sensors |
| `bash cloud/iot-hub/provision.sh` · `bash firmware/setup_pi.sh` | Real Azure + Raspberry Pi deployment |

## Layout

```
server/     Node.js application server — real-time loop, REST API, Server-Sent Events, terminal log
engine/     simulation engine run by the server (physics, sensors, Pi edge logic, MQTT, network, Azure, metrics)
public/     browser UI (display only): 9 views — live topology, circuit, Azure portal, dashboard, results, …
firmware/   real Raspberry Pi Python application + unit tests
cloud/      real Azure Functions, Stream Analytics query, routes, az CLI provisioning
tools/      selftest.js
```

## Headline results (seed 2026)

| | Edge · connected | Edge · disconnected | Cloud-only · connected | Cloud-only · disconnected |
|---|---|---|---|---|
| Local alarm after first breach | 5.76 s | **5.76 s** | none | none |
| Operator SMS after first breach | 6.57 s | 10 m 05 s (after reconnect) | 11.8 s | 13 m 02 s, **3 of 4 never** |
| Data loss | 0 % | **0 %** | 7.2 % | **100 %** |
