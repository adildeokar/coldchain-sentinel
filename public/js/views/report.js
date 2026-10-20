/* Project Report — generated from the live code: numbers come from the experiment
 * runner, test results from the self-test suite, figures from the same SVGs. Print → PDF. */
(function (CS) {
  'use strict';
  const { h, esc } = CS.dom;
  const { fmt, mean } = CS.util;

  const rep = {
    init(app, el) {
      this.app = app;
      this.el = el;
      el.innerHTML = '';
      el.appendChild(h('div', { class: 'view-h no-print' }, h('div', null, h('h2', null, 'Project report'),
        h('div', { class: 'desc' }, 'This report is generated from the running code. The measured results come from the experiment runner, the test table from the automated test suite, and the figures are the same diagrams used in the app. Use Print → "Save as PDF" to submit it.')),
        h('div', { class: 'tools' }, h('button', { class: 'btn', onclick: () => this.build(true) }, '↻ Re-run tests & experiments'), h('button', { class: 'btn primary', onclick: () => { document.documentElement.setAttribute('data-theme', 'light'); setTimeout(() => { window.print(); app.applyTheme(); }, 120); } }, '⎙ Print / Save PDF'))));
      this.doc = h('article', { class: 'report' });
      el.appendChild(this.doc);
    },

    onShow() { if (!this.built) this.build(false); },

    async build(force) {
      const app = this.app;
      this.built = true;
      this.doc.innerHTML = '<p class="muted">Running the test suite and experiments on the server…</p>';
      try {
        if (force || !app.results) app.results = await CS.api.get(`/api/experiments?seed=2026&profile=pharma${force ? '' : '&cached=1'}`);
        if (force || !app.tests) app.tests = await CS.api.get(`/api/selftest${force ? '' : '?cached=1'}`);
      } catch (e) { this.doc.innerHTML = `<p class="err-t">Server error: ${esc(e.message)}</p>`; this.built = false; return; }
      const R = app.results, T = app.tests, C = R.combined, cc = C.connected, cd = C.disconnected;
      const m = (a) => (a.length ? mean(a) : null);
      const pct = (a, b) => (b ? a / b : null);
      const E = Object.fromEntries(R.runs.map((r) => [r.id, r]));
      const pass = T.filter((t) => t.pass).length;
      const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      const bom = CS.config.BOM.reduce((a, [, q, p]) => a + q * p, 0);
      const bwE1 = E.E1.summary.bw.edge;

      const D = this.doc;
      D.innerHTML = `
<div class="cover">
  <div class="small muted">Problem Statement 1 · Edge & IoT Systems Project · Semester 7</div>
  <h1>ColdChain Sentinel</h1>
  <div style="font-size:16px;color:var(--text2)">Azure IoT Hub–based cold-storage monitoring with local alarming and store-and-forward edge buffering</div>
  <table class="tbl" style="margin-top:14px;max-width:640px"><tbody>
    <tr><td>Group members</td><td>1. ____________ &nbsp; 2. ____________ &nbsp; 3. ____________<br>4. ____________ &nbsp; 5. ____________</td></tr>
    <tr><td>Prototype</td><td>Reproducible simulation (this application) + deployable Raspberry Pi firmware and Azure code</td></tr>
    <tr><td>Azure</td><td>Documented local simulation of IoT Hub, Service Bus, Functions, Stream Analytics, Cosmos DB, Event Grid, SignalR and Logic Apps (guideline 6). Provisioning script included.</td></tr>
    <tr><td>Date</td><td>${today}</td></tr>
  </tbody></table>
</div>

<h2>Abstract</h2>
<p>Cold rooms for vaccines and food must stay within a narrow band (2–8 °C for most vaccines). Excursions must be caught within minutes, even when the site's internet link fails. We designed <b>ColdChain Sentinel</b>. A Raspberry Pi 4 reads a DS18B20 probe, a DHT22 temperature/humidity sensor and a door switch every 5 s. It decides <i>locally</i> whether conditions are unsafe and drives a buzzer, LEDs and an LCD on the spot. It stores every reading in SQLite before sending it over MQTT/TLS to Azure IoT Hub, and syncs the queued readings when the connection returns. In the cloud, IoT Hub routes alerts to Service Bus and an Azure Function that notifies staff, while telemetry goes to Cosmos DB and Stream Analytics for a live dashboard with history.</p>
<p>We ran six reproducible experiments and compared this edge design with a cloud-only baseline on identical sensor data. While <b>connected</b>, both designs notify staff in seconds (edge ${fmt.dur(m(cc.edgeCloud))}, baseline ${fmt.dur(m(cc.baseCloud))}). While <b>disconnected</b>, the edge still sounds the local alarm in <b>${fmt.dur(m(cd.edgeLocal))}</b> and loses <b>${cd.data.edge.lost} of ${cd.data.edge.gen}</b> readings. The cloud-only design loses <b>${fmt.pct(pct(cd.data.base.lost, cd.data.base.gen), 1)}</b> of the readings taken offline and raises no alert at all for <b>${cd.baseMissed} of ${cd.episodes}</b> excursions that began during an outage.</p>

<div class="toc"><b>Contents</b><ol>
<li>Problem definition</li><li>System architecture</li><li>Hardware</li><li>Software</li><li>Implementation</li><li>Testing</li><li>Results</li><li>Limitations</li><li>Future scope</li><li>Conclusion</li><li>References · Appendices</li></ol></div>

<h2>1. Problem definition</h2>
<p>Pharmaceutical and food cold chains lose product when the temperature leaves the allowed range. Typical causes are a door left open, a compressor failure, a stuck thermostat (over-cooling, which freezes vaccines) and power cuts. A purely cloud-based monitor has a basic weakness: when the site's internet drops, which often happens together with a power cut, the cloud is blind. Nobody at the site is warned, and readings taken during the outage are lost, breaking the compliance record.</p>
<div class="callout"><b>Problem statement.</b> Design a cold-storage monitoring system using a Raspberry Pi or simulated edge device, temperature and humidity sensors, and Azure IoT Hub. The edge device should detect unsafe conditions locally, activate an alarm and continue recording readings during internet outages. When connectivity returns, it should sync queued readings to the cloud. Build a dashboard showing live status and historical trends. Compare alert response time and data loss during connected and disconnected operation.</div>
<h3>Objectives</h3>
<table class="tbl"><thead><tr><th>#</th><th>Objective</th><th>Where it is met</th></tr></thead><tbody>
<tr><td>O1</td><td>Measure temperature and humidity (plus door state) on an edge device</td><td>DS18B20 + DHT22 + reed switch on a Raspberry Pi 4 (§3, firmware/coldstore/sensors)</td></tr>
<tr><td>O2</td><td>Detect unsafe conditions locally and activate an alarm with no network</td><td>Rule engine + GPIO buzzer/LED/LCD (§5.2, rules.py, alarm.py)</td></tr>
<tr><td>O3</td><td>Keep recording during internet outages</td><td>SQLite store-and-forward, write-before-send (§5.3, store.py)</td></tr>
<tr><td>O4</td><td>Sync queued readings when connectivity returns</td><td>Uploader: backoff reconnect, priority sync, batching, cloud de-duplication (§5.3–5.5)</td></tr>
<tr><td>O5</td><td>Dashboard with live status and historical trends</td><td>Cosmos DB + SignalR dashboard with back-fill, alerts, time-in-range and MKT (§5.6)</td></tr>
<tr><td>O6</td><td>Compare alert response time and data loss, connected vs disconnected</td><td>Experiments E1–E6 against a cloud-only baseline (§7)</td></tr>
</tbody></table>
<h3>Scope and assumptions</h3>
<ul><li>One cold room per Pi. The default profile is pharma (2–8 °C, 35–75 %RH). Produce and frozen profiles can be selected through the device twin.</li>
<li>The Pi and its sensors are on a UPS HAT. The compressor and router are on mains, so a power cut is also an internet outage.</li>
<li>Azure is shown as a documented local simulation (guideline 6). The same logic is provided as deployable Azure Functions, a Stream Analytics query and an az CLI script.</li></ul>

<h2>2. System architecture</h2>
<p>The system has five layers. <b>Perception:</b> sensors and local actuators. <b>Edge:</b> the Pi runs drivers, validation, the rule engine, the alarm controller, the SQLite queue and the uploader. <b>Network:</b> MQTT 3.1.1 over TLS 1.2 through the site router. <b>Cloud:</b> IoT Hub with routing to Service Bus, Functions, Stream Analytics, Cosmos DB, Event Grid, SignalR and a Logic App. <b>Application:</b> the operator dashboard and SMS/e-mail. The key choice is that <b>the safety decision is made at the edge</b>. The cloud adds notification, history and fleet management, but the site never depends on it to sound an alarm.</p>
<figure id="fig-arch"></figure>
<figure id="fig-flow"></figure>
<figure id="fig-seq"></figure>
<div class="grid g2"><figure id="fig-fsm1"></figure><figure id="fig-fsm2"></figure></div>

<h2>3. Hardware</h2>
<p>A Raspberry Pi 4 Model B (4 GB) is mounted outside the cold room in an IP54 enclosure. The probe cables enter through a cable gland. Every part is wired to the 40-pin header as below (BCM numbering). The DS18B20 sits on the 1-Wire bus with a 4.7 kΩ pull-up. The DHT22 has a 10 kΩ pull-up. The 5 V buzzer draws about 30 mA, more than a GPIO pin can source, so a 2N2222 transistor drives it. The LCD uses an I²C PCF8574 backpack at 0x27. A UPS HAT with two 18650 cells keeps the node alive for about 5 h.</p>
<figure id="fig-circuit"></figure>
<table class="tbl"><thead><tr><th>BCM</th><th>Pin</th><th>Dir</th><th>Connection</th></tr></thead><tbody>${CS.config.GPIO.map((p) => `<tr><td>${p.bcm}</td><td>${p.pin}</td><td>${p.dir}</td><td>${esc(p.use)}</td></tr>`).join('')}</tbody></table>
<table class="tbl"><thead><tr><th>Component</th><th>Role</th><th>Key specification</th></tr></thead><tbody>${Object.values(CS.config.COMPONENTS).map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.role)}</td><td class="small">${esc(c.spec)}</td></tr>`).join('')}</tbody></table>
<p>Bill of materials: about <b>₹${bom.toLocaleString('en-IN')}</b> per cold room. The router is the site's existing one. Details are in the Raspberry Pi & Circuit view.</p>

<h2>4. Software</h2>
<table class="tbl"><thead><tr><th>Layer</th><th>Module / resource</th><th>Responsibility</th></tr></thead><tbody>
<tr><td rowspan="9">Edge (Python)</td><td>main.py</td><td>5 s sampling loop, wiring of all modules, direct-method and twin handlers</td></tr>
<tr><td>sensors/ds18b20.py, dht22.py, door.py</td><td>Drivers: w1_slave parsing with CRC and 85 °C rejection, DHT retries (2 s spacing), debounced reed switch</td></tr>
<tr><td>rules.py</td><td>Alarm channels with N-sample confirmation and hysteresis; status OK/WARN/ALARM/FAULT; sensor fusion</td></tr>
<tr><td>actuators/alarm.py, lcd.py</td><td>Buzzer/LED patterns, ACK button, cloud-offline LED, 16×2 LCD</td></tr>
<tr><td>store.py</td><td>SQLite WAL queue: readings, alerts, sequence numbers, capacity policy</td></tr>
<tr><td>uploader.py</td><td>Connection state machine, backoff, priority sync, batching, twin sync on reconnect</td></tr>
<tr><td>cloud.py</td><td>azure-iot-device wrapper (MQTT/TLS, QoS 1); local IoT Hub emulator for --simulate</td></tr>
<tr><td>config.py, config.yaml</td><td>Defaults, product profiles, merging twin desired properties</td></tr>
<tr><td>coldstore.service, setup_pi.sh</td><td>systemd auto-restart; OS setup (1-Wire, I²C, venv, service user)</td></tr>
<tr><td rowspan="4">Azure</td><td>iot-hub/provision.sh</td><td>IoT Hub S1, devices, twin, consumer groups, routes, Service Bus, Cosmos, SignalR, Function App, Event Grid</td></tr>
<tr><td>functions/function_app.py</td><td>TelemetryIngest (Event Hub trigger, de-dup upsert), AlertProcessor (Service Bus trigger, latency, notify), ConnectionMonitor (Event Grid), negotiate</td></tr>
<tr><td>stream-analytics/coldstore-job.asaql</td><td>Flatten batches, 1-min aggregates, cloud-only alert rule for the baseline</td></tr>
<tr><td>iot-hub/message-routes.json, device-twin.json</td><td>Routing and twin contracts</td></tr>
<tr><td rowspan="3">Application</td><td>server/*.js (Node.js)</td><td>HTTP + REST API + Server-Sent Events; runs the engine in real time; terminal log of every event</td></tr><tr><td>engine/*.js</td><td>Discrete-event engine; ports of rules.py/store.py/uploader.py; models of the room, sensors, network and every Azure service; metrics, experiments, tests</td></tr><tr><td>public/*</td><td>Browser UI: mirrors server state over SSE, sends actions via REST</td></tr>
</tbody></table>

<h2>5. Implementation</h2>
<h3>5.1 Sampling and validation</h3>
<p>Every 5 s the Pi reads the DS18B20 (750 ms 12-bit conversion), the DHT22 (up to 3 tries, 2 s apart) and the reed switch. A reading with a CRC error, or the 85.000 °C power-on-reset value, is rejected. The fused temperature uses the probe and falls back to the DHT22. If both sensors fail, a SENSOR_FAULT alarm is raised. If they disagree by more than 1.5 °C, a SENSOR_DISAGREE warning is raised.</p>
<h3>5.2 Local rule engine</h3>
<pre class="code">for each channel in HIGH_TEMP, LOW_TEMP, HIGH_RH, LOW_RH, DOOR_OPEN, SENSOR_FAULT:
    if not channel.active:
        if out_of_range(value):  channel.count += 1          # first sample → firstBreachAt
            if channel.count >= N (=2):  RAISE → buzzer + red LED + LCD (≈ 1 ms), queue alert
        else:                     channel.count = 0           # single spike filtered
    elif value inside (limit − hysteresis):  CLEAR → outputs off when no channel is active</pre>
<p>The confirmation delay (N = 2 samples, 5 s) filters noise and very short door openings. The 0.3 °C / 2 %RH hysteresis stops the alarm from chattering near the limit. Temperature and sensor faults are <i>critical</i> (blinking red LED, SMS); humidity and door are <i>warnings</i>.</p>
<h3>5.3 Store-and-forward and synchronisation</h3>
<pre class="code">sample → INSERT reading (PENDING, seq++) → [uploader thread]
while running:
    if not connected:  connect() with backoff 1,2,4…32 s ±20 %; on success: GET twin, report props
    send pending alerts            (alert=true)            → mark sent on PUBACK
    send live rows (≤ 2 samples old), one message each       → mark SENT on PUBACK
    send backlog: oldest 50 PENDING as one batch (compact keys)→ mark SENT on PUBACK
    2 consecutive PUBACK timeouts (4 s) → DISCONNECTED, amber LED solid</pre>
<p>Because a row becomes SENT only after IoT Hub has durably stored it (QoS 1), no reading is lost to an outage, a crash or a reboot. A reading can arrive twice if a PUBACK is lost, so the cloud stores it with <code>id = deviceId-seq</code> and the duplicate overwrites itself. When the buffer is full the oldest SENT rows go first, then the oldest PENDING rows, and the loss is counted.</p>
<h3>5.4 Device twin and direct methods</h3>
<p>Limits, profile and sampling interval are <b>desired properties</b>. A change pushed while the Pi is offline is fetched with a full twin GET on reconnect (test I6). The Pi reports its firmware, limits, queue depth and connectivity. Direct methods <code>getDiagnostics</code>, <code>silenceAlarm</code>, <code>testAlarm</code> and <code>reboot</code> let the cloud act on the device. They fail at once with 404103 when it is offline.</p>
<h3>5.5 Azure processing</h3>
<p>Messages carry <code>contentType=application/json</code>, UTF-8 and an <code>alert</code> application property. IoT Hub routes <code>alert='true'</code> to the Service Bus queue <i>cold-alerts</i>, so alerts never wait behind telemetry. AlertProcessor stores each alert and computes its latency from <code>firstBreachAt</code>, then sends SMS/e-mail through a Logic App and pushes to SignalR. Telemetry goes through the built-in endpoint to TelemetryIngest, which expands batches and upserts into Cosmos DB. Stream Analytics computes 1-minute aggregates with <code>TIMESTAMP BY ts</code>, so back-filled readings land in the right window. Event Grid DeviceDisconnected tells staff that the site is offline.</p>
<h3>5.6 Dashboard</h3>
<p>The dashboard reads only cloud data. It shows a SAFE / WARNING / ALARM / DEVICE OFFLINE banner, temperature and humidity gauges against the safe band, time-in-range, mean kinetic temperature, and a history chart with outage shading. Back-filled points appear in amber, so an auditor can see which data arrived late. It also has an alert table with local versus cloud latency, a remote "silence" action, and CSV export.</p>
<h3>5.7 Simulation model</h3>
<p>The room follows dT/dt = (k<sub>leak</sub> + k<sub>door</sub>)(T<sub>amb</sub> − T) − c·compressor, with k<sub>leak</sub> = 3.6×10⁻⁴ s⁻¹, k<sub>door</sub> = 3×10⁻³ s⁻¹ and c = 0.035 °C/s, under a ±1 °C thermostat. The sensors add first-order lag (τ = 25 s / 12 s), noise, quantisation and the faults described above. The WAN has latency, jitter, loss and bandwidth for the online and degraded modes. Every Azure hop has a latency range taken from typical service behaviour, including Function cold starts (0.9–2.2 s after 20 min idle) and Stream Analytics delay (1.2–3.2 s). A cloud-only baseline node shares the exact same sensor frames, which makes the comparison fair.</p>

<h2>6. Testing</h2>
<p>Testing is done at three levels. (a) 14 Python unit tests for the rule engine and the SQLite queue (<code>python -m unittest discover -s tests</code>). (b) ${T.length} simulator tests (unit + integration), run below in your browser and by <code>node tools/selftest.js</code>. (c) Six scenario experiments (§7). The firmware was also run end to end with <code>python main.py --simulate --scenario outage</code>: an alarm was raised while offline, 20 buffered readings synced after reconnect, and none were lost.</p>
<table class="tbl"><thead><tr><th>ID</th><th>Level</th><th>Test</th><th>Observed</th><th>Result</th></tr></thead><tbody>${T.map((t) => `<tr class="${t.pass ? '' : 'bad'}"><td class="mono">${t.id}</td><td>${t.kind}</td><td>${esc(t.name)}</td><td class="small">${esc(t.detail)}</td><td>${t.pass ? '<span class="badge ok">PASS</span>' : '<span class="badge err">FAIL</span>'}</td></tr>`).join('')}</tbody></table>
<p><b>${pass} / ${T.length} passed.</b></p>

<h2>7. Results</h2>
<h3>7.1 Connected vs disconnected (pooled over E1–E4, E6)</h3>
<table class="tbl"><thead><tr><th>Metric</th><th>Edge · connected</th><th>Edge · disconnected</th><th>Cloud-only · connected</th><th>Cloud-only · disconnected</th></tr></thead><tbody>
<tr><td>Local alarm after first breach</td><td>${fmt.dur(m(cc.edgeLocal))}</td><td><b>${fmt.dur(m(cd.edgeLocal))}</b></td><td>none</td><td>none</td></tr>
<tr><td>Operator notified (SMS)</td><td>${fmt.dur(m(cc.edgeCloud))}</td><td>${fmt.dur(m(cd.edgeCloud))} (after reconnect)</td><td>${fmt.dur(m(cc.baseCloud))}</td><td>${cd.baseCloud.length ? fmt.dur(m(cd.baseCloud)) : '—'}; <b>${cd.baseMissed}/${cd.episodes} never</b></td></tr>
<tr><td>Readings lost</td><td>${cc.data.edge.lost} / ${cc.data.edge.gen}</td><td><b>${cd.data.edge.lost} / ${cd.data.edge.gen}</b></td><td>${cc.data.base.lost} / ${cc.data.base.gen}</td><td><b>${cd.data.base.lost} / ${cd.data.base.gen} (${fmt.pct(pct(cd.data.base.lost, cd.data.base.gen), 1)})</b></td></tr>
<tr><td>Mean delivery delay</td><td>${fmt.dur(m(cc.data.edge.delay))}</td><td>${fmt.dur(m(cd.data.edge.delay))}</td><td>${fmt.dur(m(cc.data.base.delay))}</td><td>—</td></tr>
</tbody></table>
<div class="grid g2"><figure><div id="rc1"></div><figcaption>Alert response time, log scale (seconds from first breach)</figcaption></figure><figure><div id="rc2"></div><figcaption>Data loss per experiment (%)</figcaption></figure></div>
<h3>7.2 Per-experiment results (seed ${R.seed})</h3>
<table class="tbl"><thead><tr><th>Exp</th><th>Scenario</th><th>Outage</th><th>Edge delivered</th><th>Cloud-only delivered</th><th>Local alarm</th><th>Edge → SMS</th><th>Cloud-only → SMS</th><th>Sync</th></tr></thead><tbody>${R.runs.map((r) => { const w = r.row; return `<tr><td>${r.id}</td><td>${esc(r.name)}</td><td>${r.outageS ? fmt.dur(r.outageS * 1000) : '—'}</td><td>${fmt.pct(w.edgeDelivery)}</td><td>${fmt.pct(w.baseDelivery)}</td><td>${fmt.dur(w.edgeLocal)}</td><td>${fmt.dur(w.edgeCloud)}</td><td>${w.baseCloud != null ? fmt.dur(w.baseCloud) : '—'}${w.baseMissed ? ` (${w.baseMissed} missed)` : ''}</td><td>${w.syncMs != null ? fmt.dur(w.syncMs) + ` / ${w.syncRows} rows` : '—'}</td></tr>`; }).join('')}</tbody></table>
<h3>7.3 Other measured quantities</h3>
<table class="tbl"><thead><tr><th>Quantity</th><th>Value</th><th>Notes</th></tr></thead><tbody>
<tr><td>Latency — local decision to actuation</td><td>&lt; 1 ms</td><td>rule evaluation + GPIO write; 5.8 s from first breach includes the 5 s confirmation and the 0.75 s read</td></tr>
<tr><td>Latency — live reading to dashboard</td><td>${fmt.dur(E.E1.summary.dev.edge.live.mean)}</td><td>MQTT + hub + Function + Cosmos + SignalR (E1)</td></tr>
<tr><td>Outage detection — edge vs cloud</td><td>${fmt.num(E.E2.row.edgeDetectS, 0)} s vs ${fmt.num(E.E2.row.cloudDetectS, 0)} s</td><td>two PUBACK timeouts vs 1.5 × keep-alive + Event Grid</td></tr>
<tr><td>Bandwidth (connected)</td><td>${fmt.bytes(bwE1.perHour)}/h · ${fmt.bytes(bwE1.perHour * 24)}/day</td><td>${Math.round(bwE1.msgs / (E.E1.durationS / 3600))} messages/h incl. protocol overhead</td></tr>
<tr><td>Batching saving during sync</td><td>${fmt.pct(E.E2.row.batchSaving, 0)}</td><td>50 compact readings per message vs one message each</td></tr>
<tr><td>Security overhead</td><td>${fmt.pct(bwE1.securityPct)} of wire bytes</td><td>TLS 1.2 records (29 B each) + ${bwE1.handshakes} handshake(s) of ≈ 6 KB</td></tr>
<tr><td>Reliability</td><td>${fmt.pct(E.E4.row.edgeDelivery)} delivered on a 12 %-loss link</td><td>${E.E4.row.edgeDupes} duplicates discarded by idempotent upsert</td></tr>
<tr><td>Resource use (Pi)</td><td>CPU ≈ 3–8 %, RAM ≈ 62 MB</td><td>SQLite ≈ 188 B/row, 100 k-row buffer ≈ 18 MB, ≈ 5.8 days of autonomy</td></tr>
<tr><td>Privacy exposure</td><td>Minimal</td><td>temperature, humidity, door and device id only; no personal data</td></tr>
</tbody></table>
<h3>7.4 Discussion</h3>
<p>The results answer the problem statement. Local alarm latency does not depend on the network: ${fmt.dur(m(cc.edgeLocal))} connected and ${fmt.dur(m(cd.edgeLocal))} disconnected. For the cloud-only design, alert latency is bounded only by how long the outage lasts, and it misses short excursions completely. On data, store-and-forward cuts loss during outages from ${fmt.pct(pct(cd.data.base.lost, cd.data.base.gen), 1)} to ${fmt.pct(pct(cd.data.edge.lost, cd.data.edge.gen), 1)}. The cost is delivery delay (readings arrive minutes late, marked as back-filled) and a few extra bytes. E5 shows the one way the edge can still lose data: an outage longer than the buffer. The default buffer therefore covers almost six days. Function cold starts add about 1–2 s to the first alert after a quiet period. This is visible in the connected SMS latency and could be removed with a Premium plan.</p>

<h2>8. Limitations</h2>
<ul>
<li>Azure is simulated, using latency ranges typical of each service. Absolute cloud numbers will differ on a real subscription; the relative comparison holds.</li>
<li>The room model is lumped (one air temperature). Real rooms have gradients, so several probes would be better for a large room.</li>
<li>The buffer is finite. An outage longer than about 5.8 days, or E5's deliberately small buffer, drops the oldest data.</li>
<li>When the device is offline, the cloud learns of it only after about 90 s (keep-alive × 1.5 + Event Grid). Remote staff are not told about an excursion until the link returns; only people at the site hear the buzzer.</li>
<li>The SD card is a single point of failure, and the local SQLite file is not encrypted.</li>
<li>The DHT22 is a low-cost sensor (±2 %RH). Regulated pharma use needs calibrated, certified sensors and an audit trail (21 CFR Part 11).</li>
</ul>

<h2>9. Future scope</h2>
<ul>
<li>An out-of-band path for alerts during outages: a GSM/LoRaWAN module that sends an SMS directly from the Pi when the WAN is down.</li>
<li>Azure IoT Edge with a local Stream Analytics module, OTA firmware updates and X.509/TPM attestation through DPS.</li>
<li>Predictive maintenance: detect compressor degradation from duty cycle and pull-down rate before failure (ML on Azure, scored at the edge).</li>
<li>Many rooms and sites with Azure Digital Twins, Power BI compliance reports, and MKT/excursion budgets per product batch.</li>
<li>Premium Functions (no cold start), geo-redundant Cosmos DB, and dual-WAN (fibre + 4G) failover at the site.</li>
</ul>

<h2>10. Conclusion</h2>
<p>ColdChain Sentinel meets every requirement of Problem Statement 1. It detects unsafe conditions on the edge device and raises a local alarm in about ${fmt.dur(m(cd.edgeLocal))}, whether or not the internet is up. It keeps recording through outages, reboots and power cuts. It synchronises the backlog in seconds once the link returns, without duplicates, and presents live status and back-filled history on a cloud dashboard. The experiments put numbers on the benefit over a cloud-only design: no data lost during outages instead of ${fmt.pct(pct(cd.data.base.lost, cd.data.base.gen), 0)}, and no missed excursions instead of ${cd.baseMissed} of ${cd.episodes}. The firmware, Azure Functions, Stream Analytics query and provisioning script included with the simulator form a direct path to a real deployment.</p>

<h2>References</h2>
<ol class="small">
<li>Microsoft Learn — Azure IoT Hub documentation: MQTT support, message routing, device twins, direct methods, quotas and throttling.</li>
<li>Microsoft Learn — Azure Functions triggers and bindings (Event Hubs, Service Bus, Event Grid, Cosmos DB, SignalR), Python v2 programming model.</li>
<li>Microsoft Learn — Azure Stream Analytics: time handling, TIMESTAMP BY, late arrival policy, GetArrayElements.</li>
<li>WHO Technical Report Series 961, Annex 9 — Model guidance for the storage and transport of time- and temperature-sensitive pharmaceutical products.</li>
<li>USP &lt;1079&gt; — Good Storage and Distribution Practices; mean kinetic temperature.</li>
<li>Maxim Integrated — DS18B20 Programmable Resolution 1-Wire Digital Thermometer datasheet.</li>
<li>Aosong — AM2302/DHT22 digital temperature and humidity sensor datasheet.</li>
<li>OASIS — MQTT Version 3.1.1 standard; IETF RFC 5246 (TLS 1.2), RFC 5288 (AES-GCM).</li>
<li>Raspberry Pi Ltd — Raspberry Pi 4 Model B datasheet and GPIO documentation.</li>
</ol>

<h2>Appendix A — Team roles (group of five)</h2>
<table class="tbl"><thead><tr><th>Member</th><th>Owns</th><th>Should be ready to explain</th></tr></thead><tbody>
<tr><td>1</td><td>Hardware & sensors</td><td>Circuit, pull-ups, transistor driver, DS18B20/DHT22 protocols, BOM, UPS</td></tr>
<tr><td>2</td><td>Edge firmware</td><td>Rule engine (debounce, hysteresis), alarm controller, systemd, sensor fusion and faults</td></tr>
<tr><td>3</td><td>Connectivity & sync</td><td>MQTT/TLS, QoS 1, PUBACK, backoff, SQLite store-and-forward, batching, de-duplication</td></tr>
<tr><td>4</td><td>Azure cloud & dashboard</td><td>IoT Hub routing, twin/methods, Functions, Stream Analytics, Cosmos, SignalR, dashboard</td></tr>
<tr><td>5</td><td>Testing & results</td><td>Experiment design, baseline, metrics definitions, results tables, limitations</td></tr>
</tbody></table>

<h2>Appendix B — How to reproduce</h2>
<pre class="code"># 1. The application — Node.js 18+, no npm install needed
npm start                               # or double-click start.bat → opens http://localhost:3000
npm test                                # ${T.length} tests + experiments E1–E6 headless

# 2. Firmware on any PC (simulated sensors + local IoT Hub emulator)
cd firmware && pip install pyyaml psutil
python -m unittest discover -s tests    # 14 unit tests
python main.py --simulate --scenario outage --duration 150

# 3. Real deployment
bash cloud/iot-hub/provision.sh         # Azure for Students subscription
bash firmware/setup_pi.sh               # on the Raspberry Pi, then put the connection string in /etc/coldstore/iothub.env
sudo systemctl start coldstore && journalctl -u coldstore -f</pre>`;

      const put = (id, svg, cap) => { const f = D.querySelector('#' + id); f.appendChild(svg); f.appendChild(h('figcaption', null, cap)); };
      put('fig-arch', CS.diagrams.architecture(), 'Figure 1 — Layered architecture');
      put('fig-flow', CS.diagrams.dataflow(), 'Figure 2 — Data-flow diagram (connected and disconnected operation)');
      put('fig-seq', CS.diagrams.sequence(), 'Figure 3 — Outage, local alarm, reconnect and sync sequence');
      put('fig-fsm1', CS.diagrams.fsmAlarm(), 'Figure 4a — Alarm channel state machine');
      put('fig-fsm2', CS.diagrams.fsmConn(), 'Figure 4b — Uploader connection state machine');
      const cf = D.querySelector('#fig-circuit');
      const circ = new CS.Circuit(cf, null);
      circ.update(app.sim);
      cf.appendChild(h('figcaption', null, 'Figure 5 — Circuit / wiring diagram (BCM numbering)'));
      const css = CS.charts.css;
      const sec = (v) => (v == null ? null : v / 1000);
      requestAnimationFrame(() => {
        new CS.charts.BarChart(D.querySelector('#rc1'), { log: true, height: 230, fmt: (v) => (v >= 60 ? (v / 60).toFixed(1) + 'm' : v.toFixed(1) + 's') }).set({ categories: ['Connected', 'Disconnected'], series: [
          { name: 'Edge local', color: css('--ok'), values: [sec(m(cc.edgeLocal)), sec(m(cd.edgeLocal))] },
          { name: 'Edge SMS', color: css('--accent'), values: [sec(m(cc.edgeCloud)), sec(m(cd.edgeCloud))] },
          { name: 'Cloud-only SMS', color: css('--faint'), values: [sec(m(cc.baseCloud)), cd.baseCloud.length ? sec(m(cd.baseCloud)) : null], nullLabel: 'never' }] });
        new CS.charts.BarChart(D.querySelector('#rc2'), { height: 230, fmt: (v) => v.toFixed(0) + '%' }).set({ categories: R.runs.map((r) => r.id), series: [
          { name: 'Edge', color: css('--accent'), values: R.runs.map((r) => (r.row.edgeLost / r.row.edgeGen) * 100) },
          { name: 'Cloud-only', color: css('--err'), values: R.runs.map((r) => (r.row.baseLost / r.row.baseGen) * 100) }] });
      });
    },
    render() {},
  };

  CS.views.report = rep;
})(window.CS = window.CS || {});
