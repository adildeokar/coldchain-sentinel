/* Architecture & Data Flow view: diagrams, message contracts, design decisions. */
(function (CS) {
  'use strict';
  const { h, json } = CS.dom;

  const SAMPLES = {
    telemetry: { type: 'telemetry', deviceId: 'coldstore-pi-01', seq: 1842, ts: '2026-10-21T04:12:35.000Z', tempC: 4.62, rh: 54.8, ds18b20C: 4.62, dht22C: 4.8, door: 'closed', status: 'OK', alarms: [], buffered: false, fw: '1.4.2' },
    batch: { type: 'batch', deviceId: 'coldstore-pi-01', batchId: 3, count: 50, fromSeq: 1901, toSeq: 1950, readings: [{ q: 1901, ts: '2026-10-21T04:17:30.000Z', t: 8.44, h: 58.9, d: 0, s: 'ALARM' }, { q: 1902, ts: '2026-10-21T04:17:35.000Z', t: 8.5, h: 59.0, d: 0, s: 'ALARM' }, '… 48 more'] },
    alert: { type: 'alert', deviceId: 'coldstore-pi-01', alertId: 'AL-00007', alarm: 'HIGH_TEMP', state: 'RAISED', severity: 'critical', value: 8.31, threshold: 8, firstBreachAt: '2026-10-21T04:17:25.000Z', raisedAt: '2026-10-21T04:17:30.000Z', localActionAt: '2026-10-21T04:17:30.760Z', localActions: ['buzzer', 'red_led', 'lcd'], bufferedMs: 460212 },
  };

  const DECISIONS = [
    ['Alarm decided on the Pi, not in the cloud', 'The site must alarm with no internet. The local path is sensor → GPIO in < 1 ms of processing. The cloud is used for notification and history only.', 'Rules must be kept in sync (twin desired properties).'],
    ['SQLite store-and-forward, write-before-send', 'Survives outages, process crashes and reboots (WAL, synchronous=FULL). The sequence numbers continue across reboots.', 'SD-card wear (≈ 17 k small writes/day; use an endurance card).'],
    ['MQTT QoS 1 + idempotent cloud writes', 'At-least-once delivery with PUBACK. Cosmos id = deviceId-seq turns duplicates into no-ops, so the data is effectively exactly-once.', 'A lost PUBACK makes the device re-send (it is counted and discarded).'],
    ['Priority sync: alerts → live → backlog', 'After reconnecting, the operator gets the buffered alert first, and the dashboard shows the current value before old history is filled in.', 'Backlog drains a little slower.'],
    ['Batch the backlog (50 readings/message)', 'Compact keys and one MQTT/TLS envelope for 50 rows give ≈ 79 % fewer bytes and 50× fewer metered messages.', 'A larger message to re-send if it fails.'],
    ['Route alerts on an app property to Service Bus', 'Alerts never queue behind telemetry. The queue is durable if the Function restarts. IoT Hub routes without parsing the body.', 'One more Azure resource.'],
    ['Stream Analytics TIMESTAMP BY device time', 'Back-filled readings land in the minute they were measured, so the aggregates and time-in-range stay correct.', 'Late-arrival window (10 min) limits how late data is re-aggregated.'],
    ['Exponential backoff with jitter', 'Backoff of 1→32 s ±20 % avoids hammering the hub when the link returns and many devices reconnect at once.', 'Up to ~32 s extra before reconnecting.'],
    ['Two temperature sensors', 'DS18B20 probe (accurate) is primary; DHT22 gives humidity and a fallback temperature. A disagreement alarm catches a failing sensor.', '≈ ₹350 extra.'],
  ];

  const arch = {
    init(app, el) {
      el.innerHTML = '';
      el.appendChild(h('div', { class: 'view-h' }, h('div', null, h('h2', null, 'Architecture & data flow'),
        h('div', { class: 'desc' }, 'Five layers from perception to application, the numbered data path for connected and disconnected operation, the outage/recovery sequence, the two state machines that drive the behaviour, and the message contracts.'))));
      const card = (title, sub, svg, file) => {
        const c = h('div', { class: 'card mt' }, h('div', { class: 'card-h' }, h('h3', null, title), h('span', { class: 'sub' }, sub), h('div', { class: 'right' }, h('button', { class: 'btn sm', onclick: () => CS.dom.exportSvg(svg, file) }, '⤓ SVG'))), h('div', { class: 'card-b' }, svg));
        return c;
      };
      el.appendChild(card('1 · Layered architecture', 'perception → edge → network → cloud → application', CS.diagrams.architecture(), 'coldchain-architecture.svg'));
      el.appendChild(card('2 · Data-flow diagram', 'numbered steps · connected (top) and disconnected → recovery (bottom)', CS.diagrams.dataflow(), 'coldchain-dataflow.svg'));
      el.appendChild(card('3 · Sequence — outage, local alarm, reconnect, sync', 'what happens message by message', CS.diagrams.sequence(), 'coldchain-sequence.svg'));
      const fsm = h('div', { class: 'grid g2 mt' });
      const a = CS.diagrams.fsmAlarm(), b = CS.diagrams.fsmConn();
      fsm.append(card('4a · Alarm channel FSM', 'rules.py / rules.js', a, 'fsm-alarm.svg'), card('4b · Uploader connection FSM', 'uploader.py / mqtt.js', b, 'fsm-connection.svg'));
      [...fsm.children].forEach((c) => c.classList.remove('mt'));
      el.appendChild(fsm);

      const msgs = h('div', { class: 'grid g3 mt' });
      [['Live telemetry', 'devices/coldstore-pi-01/messages/events/%24.ct=application%2Fjson&%24.ce=utf-8&type=telemetry&alert=false', SAMPLES.telemetry],
        ['Backlog batch (after outage)', '…/messages/events/%24.ct=…&type=batch&alert=false&buffered=true', SAMPLES.batch],
        ['Alert (routed to Service Bus)', '…/messages/events/%24.ct=…&alert=true&type=alert&severity=critical', SAMPLES.alert]].forEach(([t, topic, body]) =>
        msgs.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, t)), h('div', { class: 'card-b' }, h('div', { class: 'small muted mono', style: 'word-break:break-all' }, 'topic: ' + topic), h('pre', { class: 'code mt', html: json(body) })))));
      el.appendChild(h('h3', { class: 'mt', style: 'margin-top:18px' }, 'Message contracts'));
      el.appendChild(msgs);

      el.appendChild(h('div', { class: 'card mt' }, h('div', { class: 'card-h' }, h('h3', null, 'Design decisions')), h('div', { class: 'card-b flush' }, h('table', { class: 'tbl', html: `<thead><tr><th>Decision</th><th>Why</th><th>Trade-off</th></tr></thead><tbody>${DECISIONS.map((d) => `<tr><td><b>${d[0]}</b></td><td>${d[1]}</td><td class="muted">${d[2]}</td></tr>`).join('')}</tbody>` }))));

      el.appendChild(h('div', { class: 'grid g2 mt' },
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Technology stack')), h('div', { class: 'card-b flush' }, h('table', { class: 'tbl', html: `<tbody>
          <tr><td>Edge hardware</td><td>Raspberry Pi 4 (4 GB), DS18B20, DHT22, MC-38 reed, buzzer + 2N2222, LEDs, 16×2 I²C LCD, UPS HAT</td></tr>
          <tr><td>Edge software</td><td>Python 3.11 · azure-iot-device 2.x · adafruit-circuitpython-dht · gpiozero · RPLCD · SQLite (WAL) · systemd</td></tr>
          <tr><td>Protocol</td><td>MQTT 3.1.1 over TLS 1.2 (port 8883), QoS 1, SAS tokens; device twin + direct methods</td></tr>
          <tr><td>Ingestion</td><td>Azure IoT Hub S1 · message routing · Event Grid</td></tr>
          <tr><td>Processing</td><td>Azure Functions (Python v2 model) · Service Bus · Stream Analytics</td></tr>
          <tr><td>Storage</td><td>Cosmos DB serverless (telemetry, alerts, aggregates; TTL 90 days)</td></tr>
          <tr><td>Presentation</td><td>Static Web App + Azure SignalR · Logic App + Communication Services (SMS / e-mail)</td></tr>
          <tr><td>This application</td><td>Node.js server (http + Server-Sent Events, zero dependencies) running the discrete-event engine; vanilla-JS browser UI</td></tr></tbody>` }))),
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Security & privacy')), h('div', { class: 'card-b' }, h('ul', { style: 'margin:0;padding-left:18px;line-height:1.7' },
          h('li', null, 'Per-device identity with its own symmetric key; the SAS token is regenerated hourly. Upgrade path: X.509 + TPM / Device Provisioning Service.'),
          h('li', null, 'TLS 1.2 on every hop (device ↔ hub, functions ↔ Cosmos/Service Bus). Measured TLS overhead is ≈ 14–20 % of wire bytes.'),
          h('li', null, 'The secret lives in /etc/coldstore/iothub.env (chmod 600), never in the repo. Cloud secrets are in app settings or Key Vault.'),
          h('li', null, 'Privacy exposure is minimal: the payload holds temperature, humidity, door state and device id — no personal data, no camera, no location.'),
          h('li', null, 'Least privilege: the device can only publish to its own topic; staff access uses Azure RBAC; Cosmos is reached through managed identity.'),
          h('li', null, 'Limitation: the local SQLite file is not encrypted (future: SQLCipher / LUKS on the SD card).'))))));
    },
    render() {},
  };

  CS.views.architecture = arch;
})(window.CS = window.CS || {});
