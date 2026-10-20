/* Static design diagrams (SVG): layered architecture, numbered data flow,
 * outage/recovery sequence, and the two state machines. Each function
 * returns a fresh <svg> so the report can embed its own copy. */
(function (CS) {
  'use strict';
  const { s } = CS.dom;

  function mk(w, h, label) {
    const svg = s('svg', { class: 'dg', viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': label });
    const defs = s('defs');
    ['', 'blue', 'red', 'amber', 'green', 'violet'].forEach((c) => {
      defs.appendChild(s('marker', { id: `ah-${c || 'def'}-${label.replace(/\W/g, '')}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { d: 'M0 0L10 5L0 10z', class: 'dg-ah ' + c })));
    });
    svg.appendChild(defs);
    const id = label.replace(/\W/g, '');
    const api = {
      svg,
      box(x, y, w2, h2, cls, t, sub, mono) {
        svg.appendChild(s('rect', { class: 'dg-box ' + (cls || ''), x, y, width: w2, height: h2, rx: 8 }));
        if (t) svg.appendChild(s('text', { class: 'dg-t', x: x + 10, y: y + (sub ? 19 : h2 / 2 + 4) }, t));
        if (sub) (Array.isArray(sub) ? sub : [sub]).forEach((line, i) => svg.appendChild(s('text', { class: mono ? 'dg-m' : 'dg-s', x: x + 10, y: y + 35 + i * 14 }, line)));
      },
      layer(x, y, w2, h2, t) {
        svg.appendChild(s('rect', { class: 'dg-layer', x, y, width: w2, height: h2, rx: 12 }));
        svg.appendChild(s('text', { class: 'dg-lt', x: x + 12, y: y + 20 }, t));
      },
      arrow(pts, c = '', label, opts = {}) {
        const d = 'M' + pts.map((p) => p.join(',')).join(' L');
        svg.appendChild(s('path', { class: `dg-a ${c} ${opts.dash ? 'dash' : ''}`, d, 'marker-end': `url(#ah-${c || 'def'}-${id})`, 'marker-start': opts.both ? `url(#ah-${c || 'def'}-${id})` : null }));
        if (label) {
          const [x, y] = opts.at || [(pts[0][0] + pts[pts.length - 1][0]) / 2, (pts[0][1] + pts[pts.length - 1][1]) / 2 - 5];
          svg.appendChild(s('text', { class: 'dg-m', x, y, 'text-anchor': opts.anchor || 'middle' }, label));
        }
      },
      num(x, y, n) { svg.appendChild(s('circle', { class: 'dg-num', cx: x, cy: y, r: 10 })); svg.appendChild(s('text', { class: 'dg-numt', x, y: y + 0.5 }, String(n))); },
      text(x, y, t, cls = 'dg-s', anchor = 'start') { svg.appendChild(s('text', { class: cls, x, y, 'text-anchor': anchor }, t)); },
      raw(el) { svg.appendChild(el); },
    };
    return api;
  }

  function architecture() {
    const d = mk(1220, 640, 'Layered architecture');
    d.layer(10, 10, 200, 620, '1 · PERCEPTION');
    d.layer(222, 10, 270, 620, '2 · EDGE (Raspberry Pi 4)');
    d.layer(504, 10, 150, 620, '3 · NETWORK');
    d.layer(666, 10, 360, 620, '4 · CLOUD (Azure)');
    d.layer(1038, 10, 172, 620, '5 · APPLICATION');
    // perception
    d.box(24, 44, 172, 54, 'sense', 'DS18B20 probe', ['1-Wire · GPIO4 · ±0.5 °C']);
    d.box(24, 108, 172, 54, 'sense', 'DHT22', ['RH + temp · GPIO17']);
    d.box(24, 172, 172, 54, 'sense', 'Door reed switch', ['GPIO27 · pull-up']);
    d.box(24, 300, 172, 54, 'alarm', 'Buzzer (2N2222)', ['GPIO18 · 85 dB']);
    d.box(24, 364, 172, 54, 'alarm', 'LEDs R / G / A', ['GPIO23 / 24 / 25']);
    d.box(24, 428, 172, 54, 'alarm', '16×2 LCD', ['I²C 0x27 · GPIO2/3']);
    d.box(24, 492, 172, 54, 'alarm', 'ACK button', ['GPIO22']);
    d.text(30, 286, 'local actuators — no network needed', 'dg-s');
    d.box(24, 560, 172, 54, '', 'UPS HAT', ['keeps Pi alive on power cut']);
    // edge
    d.box(236, 44, 242, 46, 'edge', 'Sensor drivers', 'retries · CRC · 85 °C reject');
    d.box(236, 98, 242, 46, 'edge', 'Fusion & validation', 'probe first, DHT22 fallback');
    d.box(236, 152, 242, 58, 'edge', 'Rule engine', ['2-sample debounce · hysteresis', 'HIGH/LOW temp & RH · door · faults']);
    d.box(236, 220, 242, 46, 'alarm', 'Alarm controller', 'buzzer + LED + LCD ≈ 1 ms');
    d.box(236, 276, 242, 58, 'edge', 'SQLite store-and-forward', ['write before send · seq numbers', 'survives outage + reboot']);
    d.box(236, 344, 242, 72, 'edge', 'Uploader', ['MQTT/TLS · QoS 1 · PUBACK', 'priority: alerts > live > backlog', 'batch 50 · exp. backoff 1–32 s']);
    d.box(236, 426, 242, 46, 'edge', 'Twin & direct methods', 'limits from cloud · silence/diag');
    d.box(236, 482, 242, 46, 'edge', 'Health monitor', 'CPU · RAM · SoC temp · queue');
    d.box(236, 538, 242, 46, '', 'systemd service', 'Restart=always · auto-start');
    // network
    d.box(518, 150, 122, 64, 'net', 'Router / 4G', ['site WAN']);
    d.box(518, 250, 122, 80, 'net', 'Internet', ['MQTT 3.1.1', 'TLS 1.2 · 8883', 'SAS token']);
    d.box(518, 380, 122, 74, 'net', 'Outage', ['link down →', 'edge buffers']);
    // cloud
    d.box(680, 44, 160, 120, 'cloud', 'IoT Hub (S1)', ['device registry', 'device twin', 'direct methods', 'message routing', 'built-in events'], false);
    d.box(852, 44, 160, 46, 'cloud', 'Service Bus', 'queue cold-alerts');
    d.box(852, 100, 160, 64, 'cloud', 'Fn AlertProcessor', ['latency calc · notify']);
    d.box(680, 180, 160, 58, 'cloud', 'Fn TelemetryIngest', ['upsert id=dev-seq (dedupe)']);
    d.box(852, 180, 160, 58, 'cloud', 'Stream Analytics', ['1-min aggregates', 'cloud-only rule']);
    d.box(680, 254, 160, 68, 'cloud', 'Cosmos DB', ['telemetry · alerts', 'aggregates · TTL 90 d']);
    d.box(852, 254, 160, 68, 'cloud', 'Event Grid', ['DeviceConnected', 'DeviceDisconnected']);
    d.box(852, 334, 160, 46, 'cloud', 'Fn ConnectionMonitor', 'offline notice');
    d.box(680, 334, 160, 46, 'cloud', 'SignalR (serverless)', 'live push');
    d.box(680, 392, 332, 46, 'cloud', 'Logic App → Communication Services', 'SMS · e-mail · Teams');
    d.box(680, 452, 332, 70, '', 'Security', ['per-device SAS key · TLS everywhere · RBAC', 'secrets in env/Key Vault · no PII in payload']);
    d.box(680, 534, 332, 80, '', 'Ops', ['provision.sh (az CLI) · App Insights', 'monitor-events · invoke-device-method']);
    // application
    d.box(1052, 44, 144, 96, 'app', 'Operator dashboard', ['live status', 'trends + back-fill', 'alerts + ack']);
    d.box(1052, 152, 144, 56, 'app', 'SMS / e-mail', ['on-call staff']);
    d.box(1052, 220, 144, 56, 'app', 'Power BI', ['management KPIs']);
    d.box(1052, 288, 144, 70, 'app', 'Compliance', ['time-in-range', 'MKT · audit trail']);
    // arrows
    d.arrow([[196, 71], [236, 71]], 'green');
    d.arrow([[196, 135], [216, 135], [216, 80], [236, 80]], 'green');
    d.arrow([[196, 199], [222, 199], [222, 90], [236, 86]], 'green');
    d.arrow([[236, 243], [210, 243], [210, 327], [196, 327]], 'red');
    d.arrow([[478, 380], [500, 380], [500, 182], [518, 182]], 'blue');
    d.arrow([[579, 214], [579, 250]], 'blue');
    d.arrow([[640, 290], [660, 290], [660, 104], [680, 104]], 'blue');
    d.arrow([[840, 67], [852, 67]], 'red');
    d.arrow([[932, 90], [932, 100]], 'red');
    d.arrow([[760, 164], [760, 180]], 'blue');
    d.arrow([[760, 238], [760, 254]], 'blue');
    d.arrow([[1012, 132], [1032, 132], [1032, 180], [1052, 180]], 'red');
    d.arrow([[840, 357], [1040, 357], [1040, 92], [1052, 92]], 'violet');
    d.arrow([[518, 417], [500, 417]], 'amber', '', {});
    return d.svg;
  }

  function dataflow() {
    const d = mk(1220, 520, 'Data flow');
    d.text(14, 24, 'CONNECTED OPERATION', 'dg-lt');
    const y = 50;
    const steps = [
      [20, 'Sample', 'every 5 s · 3 sensors'], [180, 'Validate & fuse', 'reject CRC / 85 °C'], [340, 'Rule engine', 'debounce 2 · hysteresis'],
      [500, 'Persist', 'SQLite row PENDING'], [660, 'Publish', 'MQTT QoS 1 → IoT Hub'], [820, 'Route', "alert='true' → SB"], [980, 'Store + push', 'Cosmos upsert · SignalR'],
    ];
    steps.forEach(([x, t, sub], i) => {
      d.box(x, y, 140, 60, i < 4 ? 'edge' : 'cloud', t, sub);
      d.num(x + 4, y + 2, i + 1);
      if (i) d.arrow([[x - 20, y + 30], [x, y + 30]], i < 4 ? 'green' : 'blue');
    });
    d.box(340, 150, 140, 56, 'alarm', 'Local alarm', 'buzzer · LED · LCD ≈ 1 ms');
    d.num(344, 152, 8);
    d.arrow([[410, 110], [410, 150]], 'red');
    d.box(660, 150, 140, 56, 'edge', 'PUBACK', 'row → SENT');
    d.num(664, 152, 9);
    d.arrow([[760, 110], [760, 132], [730, 132], [730, 150]], 'blue');
    d.box(820, 150, 160, 56, 'cloud', 'AlertProcessor', 'SMS / e-mail ≈ 1–2 s');
    d.num(824, 152, 10);
    d.arrow([[890, 110], [890, 150]], 'red');
    d.box(1000, 150, 200, 56, 'app', 'Dashboard', 'live value + alert banner');
    d.num(1004, 152, 11);
    d.arrow([[1050, 110], [1050, 150]], 'violet');
    d.arrow([[980, 178], [1000, 178]], 'red');

    d.text(14, 262, 'DISCONNECTED OPERATION → RECOVERY', 'dg-lt');
    const y2 = 286;
    d.box(20, y2, 170, 66, 'net', 'WAN down', ['PUBACK timeouts ×2', '→ DISCONNECTED (≈9 s)']);
    d.num(24, y2 + 2, 12);
    d.box(214, y2, 190, 66, 'edge', 'Keep sampling', ['rules + local alarm unchanged', 'amber LED solid']);
    d.num(218, y2 + 2, 13);
    d.box(428, y2, 190, 66, 'edge', 'Queue grows', ['SQLite PENDING rows', 'alerts queued with bufferedMs']);
    d.num(432, y2 + 2, 14);
    d.box(642, y2, 190, 66, 'net', 'Backoff reconnect', ['1,2,4…32 s ±20 %', 'TLS + CONNECT + twin GET']);
    d.num(646, y2 + 2, 15);
    d.box(856, y2, 170, 66, 'edge', 'Priority sync', ['alerts → live → backlog', 'batches of 50 (−79 % bytes)']);
    d.num(860, y2 + 2, 16);
    d.box(1046, y2, 160, 66, 'cloud', 'Back-fill', ['TIMESTAMP BY ts', 'gap in chart fills in']);
    d.num(1050, y2 + 2, 17);
    [[190, 214], [404, 428], [618, 642], [832, 856], [1026, 1046]].forEach(([a, b]) => d.arrow([[a, y2 + 33], [b, y2 + 33]], 'amber'));
    d.box(214, 384, 404, 56, 'alarm', 'Local alarm still fires offline', 'same 5.8 s from first breach — independent of the WAN');
    d.arrow([[309, y2 + 66], [309, 384]], 'red');
    d.box(642, 384, 384, 56, '', 'Cloud learns of the outage', 'keep-alive 60 s × 1.5 → Event Grid DeviceDisconnected ≈ 90 s');
    d.box(20, 460, 1186, 46, '', 'Guarantees', 'at-least-once delivery (QoS 1 + persist-before-send) + idempotent storage (id = deviceId-seq)  ⇒  effectively exactly-once data, 0 % loss while the buffer has room');
    return d.svg;
  }

  function sequence() {
    const d = mk(1220, 700, 'Outage sequence');
    const L = [['Sensors', 80], ['Pi rules + GPIO', 250], ['SQLite', 420], ['Uploader (MQTT)', 590], ['IoT Hub', 760], ['Functions', 930], ['Operator', 1100]];
    L.forEach(([n, x]) => {
      d.box(x - 70, 14, 140, 34, ['Pi rules + GPIO', 'SQLite', 'Uploader (MQTT)'].includes(n) ? 'edge' : n === 'Sensors' ? 'sense' : n === 'Operator' ? 'app' : 'cloud', n);
      d.raw(s('line', { class: 'dg-life', x1: x, y1: 48, x2: x, y2: 690 }));
    });
    const X = Object.fromEntries(L.map(([n, x]) => [n, x]));
    const msg = (y, a, b, t, c = '', dash = false) => d.arrow([[X[a], y], [X[b], y]], c, t, { at: [(X[a] + X[b]) / 2, y - 5], dash });
    let y = 76;
    msg(y, 'Sensors', 'Pi rules + GPIO', 'reading 4.6 °C'); y += 26;
    msg(y, 'Pi rules + GPIO', 'SQLite', 'INSERT seq 120 PENDING', 'green'); y += 26;
    msg(y, 'SQLite', 'Uploader (MQTT)', 'live row', 'green'); y += 26;
    msg(y, 'Uploader (MQTT)', 'IoT Hub', 'PUBLISH telemetry QoS 1', 'blue'); y += 26;
    msg(y, 'IoT Hub', 'Uploader (MQTT)', 'PUBACK → mark SENT', 'blue', true); y += 34;
    d.raw(s('rect', { class: 'dg-note', x: 20, y: y - 14, width: 1180, height: 26, rx: 6 }));
    d.text(610, y + 3, '✂  WAN outage begins — router / ISP down', 'dg-t', 'middle'); y += 34;
    msg(y, 'Uploader (MQTT)', 'IoT Hub', 'PUBLISH ×  (lost)', 'red', true); y += 22;
    d.text(X['Uploader (MQTT)'] + 8, y, '4 s PUBACK timeout ×2 → DISCONNECTED, amber LED on, backoff 1→32 s', 'dg-m'); y += 28;
    msg(y, 'Sensors', 'Pi rules + GPIO', '8.3 °C, 8.6 °C (2 samples)'); y += 24;
    d.raw(s('rect', { class: 'dg-act', x: X['Pi rules + GPIO'] - 8, y: y - 10, width: 16, height: 30, rx: 3 }));
    d.text(X['Pi rules + GPIO'] + 14, y + 4, 'HIGH_TEMP RAISED → buzzer + red LED in < 1 ms', 'dg-m'); y += 30;
    msg(y, 'Pi rules + GPIO', 'SQLite', 'alert AL-00007 queued (bufferedMs grows)', 'red'); y += 26;
    msg(y, 'Pi rules + GPIO', 'SQLite', 'readings keep arriving → backlog 180 rows', 'green'); y += 26;
    msg(y, 'IoT Hub', 'Functions', 'keep-alive expired (90 s) → DeviceDisconnected', 'violet'); y += 24;
    msg(y, 'Functions', 'Operator', '"site offline — edge is covering"', 'violet', true); y += 34;
    d.raw(s('rect', { class: 'dg-note', x: 20, y: y - 14, width: 1180, height: 26, rx: 6 }));
    d.text(610, y + 3, '↺  WAN restored', 'dg-t', 'middle'); y += 34;
    msg(y, 'Uploader (MQTT)', 'IoT Hub', 'TLS + CONNECT (SAS) + twin GET', 'blue'); y += 26;
    msg(y, 'Uploader (MQTT)', 'IoT Hub', '① alert AL-00007 (alert=true, bufferedMs = 7 m 40 s)', 'red'); y += 26;
    msg(y, 'IoT Hub', 'Functions', 'alerts-route → Service Bus → AlertProcessor', 'red'); y += 24;
    msg(y, 'Functions', 'Operator', 'SMS "HIGH_TEMP … delivered late — site was offline"', 'red'); y += 28;
    msg(y, 'Uploader (MQTT)', 'IoT Hub', '② live reading   ③ batch #1 (50 rows) … batch #4', 'amber'); y += 26;
    msg(y, 'IoT Hub', 'Functions', 'TelemetryIngest upsert id=dev-seq → back-fill', 'blue'); y += 26;
    msg(y, 'IoT Hub', 'Uploader (MQTT)', 'PUBACK per batch → rows SENT, queue = 0', 'blue', true);
    return d.svg;
  }

  function fsmAlarm() {
    const d = mk(600, 270, 'Alarm channel state machine');
    const st = (x, y, t, sub, c) => { d.raw(s('rect', { class: 'dg-state ' + c, x, y, width: 150, height: 58, rx: 29 })); d.text(x + 75, y + 25, t, 'dg-t', 'middle'); d.text(x + 75, y + 42, sub, 'dg-s', 'middle'); };
    st(20, 100, 'NORMAL', 'count = 0', 'good');
    st(225, 20, 'PENDING', '0 < count < N', 'mid');
    st(430, 100, 'ACTIVE', 'alarm raised', 'bad');
    d.arrow([[150, 108], [240, 70]], 'amber', 'out of range', { at: [165, 78], anchor: 'start' });
    d.arrow([[260, 78], [140, 130]], 'green', 'in range', { at: [205, 125] });
    d.arrow([[375, 60], [480, 104]], 'red', 'count ≥ N  → RAISED', { at: [450, 70] });
    d.arrow([[430, 150], [170, 150]], 'green', 'value inside limit − hysteresis → CLEARED', { at: [300, 168] });
    d.arrow([[490, 158], [490, 200], [560, 200], [560, 158]], 'red', 'still out (peak tracked)', { at: [520, 218] });
    d.text(20, 250, 'N = alarm_delay_samples (2) · hysteresis 0.3 °C / 2 %RH · same code on the Pi (rules.py) and in the simulator (rules.js)', 'dg-s');
    return d.svg;
  }

  function fsmConn() {
    const d = mk(600, 270, 'Uploader connection state machine');
    const st = (x, y, t, sub, c) => { d.raw(s('rect', { class: 'dg-state ' + c, x, y, width: 150, height: 58, rx: 29 })); d.text(x + 75, y + 25, t, 'dg-t', 'middle'); d.text(x + 75, y + 42, sub, 'dg-s', 'middle'); };
    st(20, 30, 'DISCONNECTED', 'buffering', 'bad');
    st(225, 30, 'CONNECTING', 'TLS · CONNECT', 'mid');
    st(430, 30, 'CONNECTED', 'sync + live', 'good');
    st(225, 170, 'BACKOFF', '1→32 s ±20 %', 'mid');
    d.arrow([[170, 59], [225, 59]], 'amber', 'connect()', { at: [198, 52] });
    d.arrow([[375, 59], [430, 59]], 'green', 'CONNACK', { at: [402, 52] });
    d.arrow([[300, 88], [300, 170]], 'red', 'fail', { at: [310, 135], anchor: 'start' });
    d.arrow([[260, 170], [120, 88]], 'amber', 'timer', { at: [170, 140] });
    d.arrow([[505, 88], [505, 120], [95, 120], [95, 88]], 'red', '2× PUBACK timeout / keep-alive fail', { at: [300, 114] });
    d.text(20, 250, 'On CONNECTED: twin GET (apply desired), report props, then alerts → live → backlog batches', 'dg-s');
    return d.svg;
  }

  CS.diagrams = { architecture, dataflow, sequence, fsmAlarm, fsmConn };
})(window.CS = window.CS || {});
