/* Demo Guide & Viva: a scripted evaluation walkthrough (manual or auto-narrated),
 * likely viva questions with answers, and what is real vs simulated. */
(function (CS) {
  'use strict';
  const { h, esc } = CS.dom;

  // [view, speed, narration, action(sim, app), wait seconds (real time)]
  const DEMO = [
    ['live', 10, 'This is the whole system, end to end. On the left is the cold room with its DS18B20 probe and DHT22 sensor, the Raspberry Pi edge gateway, its local alarm panel and its SQLite queue. On the right are the Azure services. Blue dots are live readings, published over MQTT/TLS every 5 s. Grey dots coming back are IoT Hub PUBACKs.', null, 14],
    ['live', 10, 'Someone leaves the door open. Warm, humid air rushes in. After two consecutive out-of-range samples the Pi raises HIGH_TEMP locally: buzzer, red LED and LCD. The red alert packet goes through alerts-route → Service Bus → AlertProcessor → SMS to the operator.', (sim) => sim.openDoor(90), 26],
    ['live', 10, 'Now the internet at the site fails. The Pi notices two missed PUBACKs, turns on the amber LED and keeps writing every reading to SQLite. Watch the queue grow. The baseline node has no buffer and throws its readings away.', (sim) => sim.networkOutage(), 14],
    ['live', 30, 'During the outage the compressor fails. The room warms about 0.6 °C per minute. The Pi still raises the alarm locally, about 6 s after the first bad sample, with no cloud involved. The alert waits in the queue.', (sim) => sim.failCompressor(), 26],
    ['dashboard', 30, 'This is what the remote operator sees: DEVICE OFFLINE and a gap in the history. The cloud is blind, and the baseline design would never alert on this excursion. The edge Pi is covering the site on its own.', null, 12],
    ['live', 10, 'The internet comes back and the compressor is repaired. The Pi reconnects (TLS + CONNECT + twin GET) and sends the queued alert first, then the live reading, then the backlog in batches of 50 (orange).', (sim) => { sim.restoreNetwork(); sim.repairCompressor(); }, 16],
    ['dashboard', 10, 'The gap fills in with amber, back-filled points. Every reading the edge took during the outage is now in Cosmos DB, with no duplicates. The grey baseline line keeps its hole forever.', null, 14],
    ['results', 10, 'The experiment runner puts numbers on this over six scripted scenarios: local alarm ≈ 5.8 s whether connected or not, 0 % data loss for the edge, and large losses plus missed alerts for the cloud-only design during outages.', null, 14],
    ['hardware', 10, 'Every part has real wiring and real driver code: click a component to see its pins and its Python driver. The terminal shows the firmware log exactly as journalctl would show it on the Pi.', null, 12],
    ['live', 10, 'That is the full demo. You can also explore the IoT Hub view (twin, direct methods, routing, monitor-events), the Source Code view and the generated Project Report.', null, 6],
  ];

  const MANUAL = [
    ['Show the system idle', 'Live view at 5×. Point out each block and hover a link to show its protocol. Click a moving blue packet to show the real JSON payload and MQTT topic.', null],
    ['Local alarm while connected', 'Click "Door open 90 s". Wait for HIGH_TEMP: the buzzer animates, the red LED blinks, the LCD shows ALARM. Then the operator phone shows the SMS. Compare "Local buzzer" and "SMS sent" in the Dashboard alert table.', (s) => s.openDoor(90)],
    ['Internet outage', 'Click "Cut internet". Show the PUBACK timeouts in the log, MQTT → BACKOFF, the amber LED, the queue growing in SQLite, and the baseline discarding readings.', (s) => s.networkOutage()],
    ['Fault during the outage', 'Click "Compressor failure" (switch to 30×). The local alarm still fires. Show the Dashboard: DEVICE OFFLINE and a gap.', (s) => s.failCompressor()],
    ['Remote change while offline', 'In IoT Hub → Devices & twin, set temp_max_c to 7 and save. It stays pending (device offline). In Direct methods, try getDiagnostics → 404103 DeviceNotOnline.', null],
    ['Recovery & sync', 'Click "Restore internet" and "Repair compressor". Show reconnect, the twin applied, the alert delivered "late", the batches (orange) and the queue returning to 0. In the Dashboard the gap fills with amber points.', (s) => { s.restoreNetwork(); s.repairCompressor(); }],
    ['Robustness', 'Unplug DS18B20 (falls back to DHT22). Try the 85 °C glitch (rejected). Use Reboot Pi during an outage (queue survives). Use Degraded 4G (duplicates discarded).', null],
    ['Results', 'Open Experiments & Results and run all experiments. Explain the headline table: connected vs disconnected × edge vs cloud-only.', null],
    ['Report & code', 'Show Source Code (firmware is real Python, cloud code is real Azure Functions/ASA/CLI) and the Project Report (Print → PDF).', null],
  ];

  const QA = [
    ['Why is the alarm decided on the Raspberry Pi and not in Azure?', 'The requirement is that the site alarms during internet outages. If the decision lived in the cloud, an outage, which often comes with a power cut, would silence it. On the Pi the path from sensor to buzzer involves no network: under 1 ms of processing after the reading. The cloud adds remote notification, history and fleet-wide configuration on top.'],
    ['What exactly happens when the internet drops?', 'The next publishes get no PUBACK. After 2 consecutive 4 s timeouts (≈ 9 s in our runs) the uploader declares the connection lost, lights the amber LED and retries with exponential backoff (1, 2, 4 … 32 s, ±20 % jitter). Sampling and the rule engine never stop. Every reading keeps going into SQLite as PENDING.'],
    ['How do you guarantee no data is lost?', 'Write-before-send: each reading is committed to SQLite (WAL, synchronous=FULL) before any send attempt. It is marked SENT only after IoT Hub\'s PUBACK, which IoT Hub sends once it has stored the message (QoS 1). So an outage, a crash or a reboot can only delay data, not lose it, unless the buffer overflows (E5).'],
    ['Then how do you avoid duplicates?', 'At-least-once delivery means a reading can arrive twice if a PUBACK is lost. Every reading carries a sequence number that continues across reboots. TelemetryIngest upserts into Cosmos with id = deviceId-seq, so a duplicate overwrites itself. Alerts are keyed on alertId + state. Test I4 shows duplicates discarded and 0 double counts.'],
    ['Why not MQTT QoS 2?', 'Azure IoT Hub supports QoS 0 and 1 only. QoS 1 plus idempotent storage gives the same "effectively exactly-once" result with less protocol overhead.'],
    ['How did you measure alert response time?', 'A reference observer runs the same rule on the same sensor frames and opens an episode at the first out-of-range sample. From that instant we record (a) when the Pi\'s buzzer turned on, (b) when the operator\'s SMS for the edge alert was sent, and (c) when the cloud-only baseline\'s SMS was sent. Both devices get identical readings, so the comparison is fair. The episode is labelled connected or disconnected by the link state when it began.'],
    ['Why is the local alarm 5.8 s and not instant?', '5 s comes from the 2-sample confirmation, which filters noise and short door openings, and 0.75 s is the DS18B20 conversion. The decision-to-buzzer time is under 1 ms. The delay is configurable through the twin (alarm_delay_samples), trading false alarms against speed.'],
    ['Why does the first cloud alert take longer?', 'Azure Functions on the Consumption plan have a cold start (≈ 1–2 s) after ~20 minutes idle, and AlertProcessor is idle most of the time. TelemetryIngest stays warm because it runs every 5 s. The Premium plan, with always-ready instances, removes this.'],
    ['How does the cloud know the device is offline, and how fast?', 'IoT Hub closes an MQTT session that has been silent for 1.5 × keep-alive (60 s → 90 s) and emits a DeviceDisconnected event through Event Grid. ConnectionMonitor then marks the dashboard OFFLINE and notifies staff. That takes ≈ 92 s, versus ≈ 9 s for the edge to notice. This is exactly why the alarm cannot depend on the cloud.'],
    ['What is sent first after reconnecting?', 'Alerts first, so the operator learns about the excursion immediately, with bufferedMs saying how late it is. Then live readings, so the dashboard is current. Then the backlog in batches of 50 compact readings per message: about 79 % fewer bytes and 50× fewer metered messages.'],
    ['What if the outage outlasts the buffer?', 'The default capacity is 100 000 rows (≈ 5.8 days at 5 s, ≈ 18 MB). When it is full, delivered rows are evicted first and then the oldest undelivered rows, and the loss is counted and reported. E5 shows this with a deliberately tiny 120-row buffer.'],
    ['What survives a reboot or power cut?', 'The SQLite queue and the sequence counter, which are on the SD card. In-memory state is lost: the debounce counters and the door-open timer. systemd (Restart=always) restarts the service, the queue is recovered, and the sequence continues, so the cloud sees no gaps or duplicates (test I5). The UPS HAT keeps the Pi running through mains failures.'],
    ['Twin vs direct method vs C2D message?', 'Twin desired properties hold state the device should converge to (limits, profile, interval). They persist, and an offline device picks them up on reconnect. A direct method is a synchronous call that needs the device online (e.g. getDiagnostics, silenceAlarm) and returns 404103 otherwise. A C2D message is a queued one-way command; we did not need it.'],
    ['How are alerts kept separate from telemetry in IoT Hub?', 'The Pi sets an application property alert=true. The route alerts-route with query alert = \'true\' sends those messages to a Service Bus queue. Everything else goes to the built-in events endpoint. Alerts therefore have their own durable queue and consumer and never wait behind telemetry.'],
    ['What does Stream Analytics do?', 'It flattens backlog batches (CROSS APPLY GetArrayElements) and computes 1-minute aggregates for the trends and time-in-range. It uses TIMESTAMP BY the device timestamp, so late, back-filled readings land in the right window. It also runs the cloud-only alert rule for the baseline node.'],
    ['Why two temperature sensors?', 'The DS18B20 probe is the accurate primary (±0.5 °C, CRC-checked). The DHT22 gives humidity and a fallback temperature. If the probe fails we fall back to the DHT22. If both fail we raise SENSOR_FAULT. If they disagree by more than 1.5 °C we raise SENSOR_DISAGREE. The 85 °C power-on-reset value is rejected, never alarmed.'],
    ['Why debounce and hysteresis?', 'Debounce (2 consecutive samples) removes single noisy readings and very short door openings. Hysteresis (clear only 0.3 °C inside the limit) stops an alarm from toggling on and off when the temperature hovers right at the limit.'],
    ['What is the security model and its overhead?', 'Each device has its own identity and symmetric key, and the SAS token is regenerated hourly. TLS 1.2 is used on every hop. The secret is in a chmod-600 env file. The cloud uses RBAC and managed identities. The measured TLS overhead is ≈ 14–20 % of wire bytes, plus about 6 KB per handshake.'],
    ['What is the privacy exposure?', 'Very low. Only temperature, humidity, door state and a device id leave the site. There is no personal data, camera or location. Data is encrypted in transit (TLS) and at rest (Cosmos DB). The local SQLite file is not encrypted, which we list as a limitation.'],
    ['What are the bandwidth and cost implications?', 'Connected operation uses roughly 0.4–0.5 MB/h including protocol overhead, and one message per 5 s is about 17 k messages/day. That fits the S1 tier (400 k/day). The F1 free tier (8 k/day) needs a 15 s interval or batching.'],
    ['How much of the Pi does this use?', 'Roughly 3–8 % CPU at steady state, peaking during sync, and about 62 MB RAM for the Python process. Each SQLite row is ≈ 188 B. A Pi Zero 2 W would also be enough.'],
    ['What is MKT and why is it on the dashboard?', 'Mean kinetic temperature is a single temperature that expresses the cumulative thermal stress on a product (USP <1079>, ΔH/R = 10 000 K). Pharma QA uses it together with time-in-range to decide whether a batch is still usable after an excursion.'],
    ['Is the Azure part real?', 'Guideline 6 allows a clearly documented local simulation. Every Azure service is modelled here with realistic behaviour and latency. The deployable code is included: cloud/functions/function_app.py, the Stream Analytics query and provision.sh for a student subscription. The firmware runs on a real Pi, or on a PC with --simulate and a local hub emulator.'],
    ['How did you make the simulation realistic?', 'It uses a physical heat-leak/compressor model, sensor lag, noise, quantisation and failure modes, MQTT/TLS behaviour (PUBACK, timeouts, backoff, keep-alive), byte-level wire overhead, and per-service cloud latency including cold starts. A discrete-event engine on a seeded RNG makes every experiment reproducible.'],
    ['What are the main limitations?', 'Azure latencies are modelled, not measured. The room model is a single lumped temperature. Remote staff are not alerted during an outage. The buffer is finite. The SD card is a single point of failure. The DHT22 is not a certified pharma sensor.'],
    ['What would you add next?', 'A GSM or LoRaWAN fallback so the Pi can send an SMS itself during outages, Azure IoT Edge with OTA updates, X.509/TPM via DPS, predictive maintenance from compressor duty cycle, Digital Twins for many rooms, Power BI compliance reports, and Premium Functions.'],
  ];

  const guide = {
    init(app, el) {
      this.app = app;
      el.innerHTML = '';
      el.appendChild(h('div', { class: 'view-h' }, h('div', null, h('h2', null, 'Demo guide & viva preparation'),
        h('div', { class: 'desc' }, 'A ten-minute evaluation script, either narrated automatically or run step by step, followed by the questions examiners are likely to ask, with defensible answers.')),
        h('div', { class: 'tools' }, h('button', { class: 'btn primary', onclick: () => this.startDemo() }, '▶ Start guided demo (≈ 3 min)'))));
      const g = h('div', { class: 'grid g2' });
      el.appendChild(g);
      const steps = h('div', { class: 'steps' });
      MANUAL.forEach(([t, d, fn], i) => steps.appendChild(h('div', { class: 'step' }, h('div', { class: 'no' }, i + 1), h('div', null, h('b', null, t), h('div', { class: 'muted small', style: 'margin-top:3px' }, d)),
        fn ? h('button', { class: 'btn sm', onclick: () => { app.show('live'); fn(app.sim); app.toast(`Step ${i + 1}: ${t}`, '', 'info'); } }, 'Run') : h('span'))));
      g.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Manual demo script'), h('span', { class: 'sub' }, 'for the evaluation')), h('div', { class: 'card-b' }, steps)));
      g.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'What is real and what is simulated')), h('div', { class: 'card-b flush' }, h('table', { class: 'tbl', html: `<thead><tr><th>Part</th><th>Status</th></tr></thead><tbody>
        <tr><td>Raspberry Pi firmware (Python)</td><td><span class="badge ok">REAL</span> runs on a Pi; also on a PC with <code>--simulate</code> (tested: 14 unit tests + end-to-end outage run)</td></tr>
        <tr><td>Azure Functions, ASA query, az CLI provisioning</td><td><span class="badge ok">REAL CODE</span> deployable to a student subscription; not executed here</td></tr>
        <tr><td>Sensors, room physics</td><td><span class="badge warn">SIMULATED</span> physical model + datasheet noise/faults</td></tr>
        <tr><td>Network & MQTT behaviour</td><td><span class="badge warn">SIMULATED</span> latency, loss, PUBACK, backoff, keep-alive, byte overhead</td></tr>
        <tr><td>Azure services</td><td><span class="badge warn">SIMULATED</span> documented local simulation (guideline 6) with per-service latency</td></tr>
        <tr><td>Rule engine & store-and-forward in the simulator</td><td><span class="badge info">PORTED</span> line-for-line from rules.py / store.py / uploader.py</td></tr>
        <tr><td>Measured results</td><td><span class="badge info">REPRODUCIBLE</span> seeded discrete-event experiments (node tools/selftest.js)</td></tr></tbody>` })),
        h('div', { class: 'card-h' }, h('h3', null, 'Run it')),
        h('div', { class: 'card-b' }, h('pre', { class: 'code', html: CS.highlight(`# the application (Node.js 18+, no npm install needed)
npm start                         # or double-click start.bat → http://localhost:3000
npm start -- --speed 10 --seed 42 --port 3000
npm test                          # tests + experiments headless

# firmware on a PC
cd firmware
python -m unittest discover -s tests
python main.py --simulate --scenario outage --duration 150`, 'sh') }))));
      el.appendChild(h('div', { class: 'card mt' }, h('div', { class: 'card-h' }, h('h3', null, 'Viva questions & answers'), h('span', { class: 'sub' }, `${QA.length} questions · every member should be able to answer these`)),
        h('div', { class: 'card-b' }, ...QA.map(([q, a], i) => h('details', { class: 'qa' }, h('summary', null, `${i + 1}. ${q}`), h('div', null, a))))));
    },

    startDemo() {
      const app = this.app;
      this.stopDemo();
      const nar = document.getElementById('narration');
      nar.hidden = false;
      let i = -1, timer = null;
      const bar = h('div', { class: 'n-bar' }, h('i'));
      nar.prepend(bar);
      const next = () => {
        clearInterval(timer);
        i++;
        if (i >= DEMO.length) return this.stopDemo();
        const [view, speed, text, act, wait] = DEMO[i];
        app.show(view);
        app.setSpeed(speed);
        app.setPlaying(true);
        if (act) act(app.sim, app);
        nar.querySelector('.n-step').textContent = `Guided demo · step ${i + 1} of ${DEMO.length}`;
        nar.querySelector('.n-text').textContent = text;
        const t0 = performance.now();
        timer = setInterval(() => {
          const u = (performance.now() - t0) / (wait * 1000);
          bar.firstChild.style.width = Math.min(100, u * 100) + '%';
          if (u >= 1) next();
        }, 100);
      };
      this._stop = () => { clearInterval(timer); bar.remove(); };
      document.getElementById('n-skip').onclick = next;
      document.getElementById('n-stop').onclick = () => this.stopDemo();
      if (app.sim.t > 0) { app.reset(); }
      next();
    },

    stopDemo() {
      if (this._stop) this._stop();
      this._stop = null;
      document.getElementById('narration').hidden = true;
    },

    render() {},
  };

  CS.views.guide = guide;
})(window.CS = window.CS || {});
