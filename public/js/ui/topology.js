/* Live end-to-end topology: cold room → Raspberry Pi → router → Internet → Azure
 * services → operator. Packets emitted by the simulation (sim.packet) are
 * animated along the links; every node shows live state and is clickable. */
(function (CS) {
  'use strict';
  const { s, esc } = CS.dom;
  const { fmt } = CS.util;

  const COLORS = {
    sensor: '#67e8f9', db: '#a5b4fc', telemetry: '#3b82f6', batch: '#f59e0b', alert: '#ef4444', ack: '#94a3b8',
    tls: '#a855f7', twin: '#c084fc', c2d: '#d946ef', event: '#2dd4bf', notify: '#f472b6', agg: '#818cf8', ping: '#64748b',
  };
  const SIZE = { sensor: 4, db: 4, ack: 3.5, ping: 3.5, agg: 4, telemetry: 6, alert: 8, batch: 9, tls: 6, twin: 5.5, c2d: 6.5, event: 5, notify: 6 };
  const LOW = new Set(['sensor', 'db', 'ack', 'ping', 'agg']);

  const N = {
    room: [26, 52, 300, 350], cu: [26, 432, 190, 84], pi: [366, 52, 260, 150], alarm: [366, 226, 260, 140],
    sqlite: [652, 52, 112, 112], ups: [366, 392, 120, 92], base: [366, 520, 260, 88], router: [660, 280, 104, 76],
    internet: [782, 272, 74, 92],
    hub: [878, 230, 176, 176], eventgrid: [1090, 40, 150, 62], fnConn: [1270, 40, 150, 62], sb: [1090, 150, 150, 62],
    fnAlert: [1270, 150, 150, 62], logic: [1452, 40, 128, 62], operator: [1452, 128, 128, 150], fnIngest: [1090, 290, 150, 62],
    asa: [1090, 420, 150, 62], cosmos: [1270, 330, 150, 92], signalr: [1270, 478, 150, 62], dash: [1452, 420, 128, 150],
  };

  const EDGES = [
    ['room', 'r', 0.3, 'pi', 'l', 0.7, 'wire', 'Sensor wiring through a cable gland in the cold-room wall: DS18B20 (1-Wire, GPIO4), DHT22 (GPIO17), door reed switch (GPIO27).'],
    ['pi', 'b', 0.5, 'alarm', 't', 0.5, 'wire', 'GPIO outputs: buzzer GPIO18 via a 2N2222, LEDs GPIO23/24/25, 16×2 LCD over I²C (GPIO2/3), ACK button GPIO22. <b>No network involved.</b>'],
    ['pi', 'r', 0.3, 'sqlite', 'l', 0.4, '', 'Every reading is written to SQLite <b>before</b> any send attempt (store-and-forward). Rows are marked SENT only after IoT Hub\'s PUBACK.'],
    ['pi', 'r', 0.75, 'router', 't', 0.4, 'mqtt', '<b>MQTT 3.1.1 over TLS 1.2</b>, TCP 8883, QoS 1, SAS-token authentication — via Wi-Fi/Ethernet to the site router.'],
    ['base', 'r', 0.5, 'router', 'b', 0.4, 'mqtt', 'Baseline node: the same MQTT/TLS path, but no buffer and no local rules.'],
    ['router', 'r', 0.5, 'internet', 'l', 0.5, 'mqtt', 'Site WAN uplink (fibre / 4G). Use <b>Internet outage</b> to cut it.'],
    ['internet', 'r', 0.5, 'hub', 'l', 0.5, 'mqtt', 'TLS to <b>coldchain-iothub.azure-devices.net:8883</b>. Topic devices/coldstore-pi-01/messages/events/…'],
    ['hub', 't', 0.3, 'eventgrid', 'l', 0.5, '', 'IoT Hub system events → Event Grid: <b>DeviceConnected / DeviceDisconnected</b>.'],
    ['eventgrid', 'r', 0.5, 'fnConn', 'l', 0.5, '', 'Event Grid subscription → Function <b>ConnectionMonitor</b>.'],
    ['fnConn', 'r', 0.5, 'logic', 'l', 0.5, '', 'Offline notification to staff.'],
    ['hub', 'r', 0.15, 'sb', 'l', 0.5, '', 'Message route <b>alerts-route</b>: <code>alert = \'true\'</code> → Service Bus queue <b>cold-alerts</b>.'],
    ['sb', 'r', 0.5, 'fnAlert', 'l', 0.5, '', 'Service Bus trigger → Function <b>AlertProcessor</b> (Consumption plan: cold start after ~20 min idle).'],
    ['fnAlert', 'r', 0.3, 'logic', 'b', 0.3, '', 'HTTP → Logic App → Azure Communication Services: <b>SMS + e-mail + Teams</b>.'],
    ['logic', 'b', 0.75, 'operator', 't', 0.75, '', 'Notification delivered to the on-call operator.'],
    ['fnAlert', 'b', 0.5, 'cosmos', 't', 0.5, '', 'Cosmos DB output binding → container <b>alerts</b> (id = device-alertId-state, idempotent).'],
    ['hub', 'r', 0.5, 'fnIngest', 'l', 0.5, '', 'Message route <b>telemetry-route</b> (<code>alert = \'false\'</code>) → built-in events endpoint → Event Hub trigger <b>TelemetryIngest</b>.'],
    ['fnIngest', 'r', 0.5, 'cosmos', 'l', 0.3, '', 'Upsert into container <b>telemetry</b> with id = deviceId-seq — a re-sent reading overwrites itself (de-duplication).'],
    ['hub', 'r', 0.85, 'asa', 'l', 0.5, '', 'Stream Analytics input (consumer group <b>asa</b>). TIMESTAMP BY device time so back-filled readings land in the right minute.'],
    ['asa', 'r', 0.3, 'cosmos', 'l', 0.75, '', '1-minute tumbling-window aggregates → container <b>aggregates</b>.'],
    ['asa', 'l', 0.25, 'sb', 'l', 0.75, '', 'Cloud-only alert rule for the <b>baseline</b> node → cold-alerts queue.'],
    ['fnIngest', 'r', 0.85, 'signalr', 'l', 0.3, '', 'SignalR output binding → live push to the dashboard.'],
    ['fnAlert', 'r', 0.8, 'signalr', 'r', 0.3, '', 'SignalR output binding → alert pushed to the dashboard.'],
    ['fnConn', 'r', 0.85, 'signalr', 'r', 0.6, '', 'Device online/offline state → dashboard.'],
    ['hub', 'b', 0.7, 'signalr', 'l', 0.75, '', 'Twin reported properties (queue depth, firmware, limits) → dashboard.'],
    ['signalr', 'r', 0.5, 'dash', 'l', 0.55, '', 'WebSocket push to the operator dashboard (Azure Static Web App).'],
    ['hub', 'b', 0.25, 'cosmos', 'b', 0.2, 'none', ''],
  ];

  function anchor(id, side, f) {
    const [x, y, w, h] = N[id];
    return { r: [x + w, y + h * f], l: [x, y + h * f], t: [x + w * f, y], b: [x + w * f, y + h] }[side];
  }
  function pathD(a, as, b, bs) {
    const k = 0.45;
    const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    const tan = (side, p, mag) => ({ r: [p[0] + mag, p[1]], l: [p[0] - mag, p[1]], t: [p[0], p[1] - mag], b: [p[0], p[1] + mag] }[side]);
    const m1 = Math.max(24, (as === 'l' || as === 'r' ? dx : dy) * k), m2 = Math.max(24, (bs === 'l' || bs === 'r' ? dx : dy) * k);
    if (as === bs) { const c1 = tan(as, a, 30), c2 = tan(bs, b, 30); return `M${a} C${c1} ${c2} ${b}`; }
    if ((as === 'r' && bs === 'l' && Math.abs(a[1] - b[1]) < 1) || (as === 'b' && bs === 't' && Math.abs(a[0] - b[0]) < 1)) return `M${a} L${b}`;
    return `M${a} C${tan(as, a, m1)} ${tan(bs, b, m2)} ${b}`;
  }

  class Topology {
    constructor(host, app) {
      this.app = app;
      this.host = host;
      this.packets = [];
      this.svg = s('svg', { id: 'topo', viewBox: '0 0 1600 640', role: 'img', 'aria-label': 'End-to-end topology' });
      host.appendChild(this.svg);
      this.el = {};
      this.edges = {};
      this.build();
    }

    // ------------------------------------------------------------------ build
    build() {
      const g = this.svg;
      const defs = s('defs', null,
        s('linearGradient', { id: 'air', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0', 'stop-color': '#7dd3fc', 'stop-opacity': '0.35', id: 'air-a' }), s('stop', { offset: '1', 'stop-color': '#0ea5e9', 'stop-opacity': '0.12', id: 'air-b' })),
        s('pattern', { id: 'frost', width: 26, height: 26, patternUnits: 'userSpaceOnUse' }, s('path', { class: 'frost', d: 'M13 4v18M5 9l16 8M21 9L5 17' })),
        s('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, s('path', { d: 'M0 0L10 5L0 10z', fill: 'context-stroke' })));
      g.appendChild(defs);

      g.appendChild(s('rect', { class: 'zone-box zone-site', x: 8, y: 8, width: 770, height: 624, rx: 14 }));
      g.appendChild(s('text', { class: 'zone-label', x: 24, y: 34 }, 'COLD-STORAGE SITE · ON-PREMISES'));
      g.appendChild(s('text', { class: 'zone-sub', x: 300, y: 34 }, 'Warehouse A / Cold Room 1'));
      g.appendChild(s('rect', { class: 'zone-box zone-azure', x: 862, y: 8, width: 730, height: 624, rx: 14 }));
      g.appendChild(s('text', { class: 'zone-label', x: 878, y: 34 }, 'MICROSOFT AZURE'));
      g.appendChild(s('text', { class: 'zone-sub', x: 1010, y: 34 }, 'Central India · rg-coldchain'));

      const eg = s('g', { class: 'edges' });
      g.appendChild(eg);
      EDGES.forEach(([a, as, af, b, bs, bf, cls, tip]) => {
        if (cls === 'none') return;
        const d = pathD(anchor(a, as, af), as, anchor(b, bs, bf), bs);
        const p = s('path', { class: 'edge ' + cls, d });
        const hit = s('path', { class: 'edge-hit', d });
        hit.addEventListener('mousemove', (e) => CS.dom.tip.show(e, `<b>${a} → ${b}</b><br>${tip}`));
        hit.addEventListener('mouseleave', () => CS.dom.tip.hide());
        eg.append(p, hit);
        this.edges[`${a}>${b}`] = { p, len: 0, a, b };
      });
      // the cut marker for the WAN
      this.cut = s('g', { opacity: 0 }, s('path', { class: 'cut', d: 'M760 300l18 18M778 300l-18 18' }));
      g.appendChild(this.cut);

      const ng = s('g', { class: 'nodes' });
      g.appendChild(ng);
      this.buildRoom(ng); this.buildCU(ng); this.buildPi(ng); this.buildAlarm(ng); this.buildSqlite(ng); this.buildUps(ng);
      this.buildBase(ng); this.buildRouter(ng); this.buildInternet(ng);
      const az = [
        ['hub', 'IoT Hub', 'coldchain-iothub'], ['eventgrid', 'Event Grid', 'device lifecycle'], ['fnConn', 'ConnectionMonitor', 'Function · EG trigger'],
        ['sb', 'Service Bus', 'queue: cold-alerts'], ['fnAlert', 'AlertProcessor', 'Function · SB trigger'], ['logic', 'Logic App', 'SMS · e-mail'],
        ['fnIngest', 'TelemetryIngest', 'Function · EH trigger'], ['asa', 'Stream Analytics', 'coldchain-asa'], ['cosmos', 'Cosmos DB', '3 containers'],
        ['signalr', 'SignalR Service', 'serverless'],
      ];
      az.forEach(([id, t, sub]) => this.buildAz(ng, id, t, sub));
      this.buildOperator(ng); this.buildDash(ng);
      this.pk = s('g', { class: 'packets' });
      g.appendChild(this.pk);
      requestAnimationFrame(() => Object.values(this.edges).forEach((e) => (e.len = e.p.getTotalLength())));
    }

    node(ng, id, extraCls = '') {
      const [x, y, w, h] = N[id];
      const g = s('g', { class: 'node ' + extraCls, 'data-id': id, transform: `translate(${x},${y})` });
      g.appendChild(s('rect', { class: 'n-box' + (extraCls.includes('az') ? ' az' : ''), width: w, height: h, rx: 9 }));
      g.addEventListener('click', () => this.app.inspect(id));
      ng.appendChild(g);
      this.el[id] = g;
      return g;
    }
    txt(g, x, y, cls, text, key) { const t = s('text', { class: cls, x, y }, text || ''); g.appendChild(t); if (key) this.el[key] = t; return t; }

    buildRoom(ng) {
      const g = this.node(ng, 'room');
      g.appendChild(s('rect', { x: 8, y: 30, width: 284, height: 312, rx: 6, fill: 'url(#air)', class: 'room-air', id: 'room-air' }));
      g.appendChild(s('rect', { x: 8, y: 30, width: 284, height: 312, rx: 6, fill: 'url(#frost)', opacity: 0.6 }));
      this.el.roomAir = g.lastChild.previousSibling;
      this.txt(g, 12, 20, 'n-title', 'Cold room', null);
      this.txt(g, 90, 20, 'n-sub', 'pharma 2–8 °C', 'roomProfile');
      // evaporator
      g.appendChild(s('rect', { x: 70, y: 38, width: 130, height: 26, rx: 4, fill: '#33415c', stroke: '#5b6b8c' }));
      const fan = s('g', { class: 'fan', transform: 'translate(0,0)' });
      const fanC = s('g', { transform: 'translate(92,51)' }, fan);
      fan.appendChild(s('path', { d: 'M0-9 A9 9 0 0 1 0 9 A9 9 0 0 1 0-9 M-9 0 L9 0 M0 -9 L0 9', stroke: '#9fb3d1', 'stroke-width': 2, fill: 'none' }));
      g.appendChild(fanC); this.el.evapFan = fan;
      this.txt(g, 108, 55, 'n-sub', 'evaporator', null);
      // shelves + product
      [150, 225, 300].forEach((y) => {
        g.appendChild(s('rect', { class: 'shelf', x: 20, y, width: 190, height: 4 }));
        for (let i = 0; i < 5; i++) g.appendChild(s('rect', { class: 'box-prod', x: 26 + i * 37, y: y - 24, width: 30, height: 24, rx: 2 }));
      });
      // sensors
      const ds = s('g', { transform: 'translate(232,132)', class: 'sensor-ds' },
        s('line', { x1: 8, y1: -28, x2: 8, y2: 0, stroke: '#111', 'stroke-width': 2 }),
        s('rect', { x: 3, y: 0, width: 10, height: 26, rx: 4, fill: '#c0c7d2', stroke: '#7d8796' }));
      g.appendChild(ds);
      this.txt(g, 222, 175, 'n-sub', 'DS18B20', null);
      this.txt(g, 222, 189, 'n-val', '—', 'dsVal');
      const dht = s('g', { transform: 'translate(226,212)' },
        s('rect', { width: 24, height: 30, rx: 3, fill: '#f1f3f6', stroke: '#9aa3b2' }),
        ...[0, 1, 2, 3].map((i) => s('line', { x1: 4, y1: 6 + i * 6, x2: 20, y2: 6 + i * 6, stroke: '#9aa3b2' })));
      g.appendChild(dht);
      this.txt(g, 222, 258, 'n-sub', 'DHT22', null);
      this.txt(g, 222, 272, 'n-val', '—', 'dhtVal');
      // door
      g.appendChild(s('rect', { x: 292, y: 238, width: 8, height: 104, fill: 'var(--panel)' }));
      this.el.door = s('g', null, s('rect', { class: 'door', x: 276, y: 240, width: 22, height: 100, rx: 2 }), s('circle', { cx: 281, cy: 292, r: 2.4, fill: '#d1d9e6' }));
      g.appendChild(this.el.door);
      this.el.warmAir = s('g', { opacity: 0 }, ...[0, 1, 2].map((i) => s('path', { d: `M330 ${258 + i * 26} q-14 -6 -28 0 t-28 0`, stroke: '#fb923c', 'stroke-width': 2, fill: 'none' })));
      g.appendChild(this.el.warmAir);
      this.txt(g, 230, 330, 'n-sub', 'reed sw.', null);
      // big readout
      g.appendChild(s('rect', { x: 18, y: 72, width: 196, height: 46, rx: 6, fill: 'rgba(5,10,20,0.55)' }));
      this.txt(g, 28, 102, 'n-val', '—', 'roomT').setAttribute('style', 'font-size:22px');
      this.txt(g, 128, 102, 'n-val', '', 'roomH').setAttribute('style', 'font-size:14px');
      this.txt(g, 28, 114, 'n-sub', '', 'roomTrue');
      this.txt(g, 172, 20, 'state-tag', '', 'roomState');
    }

    buildCU(ng) {
      const g = this.node(ng, 'cu');
      this.txt(g, 12, 20, 'n-title', 'Condensing unit');
      const fan = s('g', { class: 'fan' }, s('circle', { r: 20, fill: 'none', stroke: '#5b6b8c', 'stroke-width': 2 }), s('path', { d: 'M0-17 Q8-8 0 0 Q-8 8 0 17 M-17 0 Q-8 8 0 0 Q8-8 17 0', stroke: '#9fb3d1', 'stroke-width': 2.4, fill: 'none' }));
      g.appendChild(s('g', { transform: 'translate(150,50)' }, fan));
      this.el.cuFan = fan;
      this.txt(g, 12, 42, 'state-tag', '', 'cuState');
      this.txt(g, 12, 60, 'n-sub', '', 'cuSub');
      this.txt(g, 12, 75, 'n-sub', 'R-404A · thermostat ±1 °C', null);
      g.appendChild(s('path', { d: 'M95 0 V-30 M110 0 V-30', stroke: '#5b6b8c', 'stroke-width': 3 }));
    }

    buildPi(ng) {
      const g = this.node(ng, 'pi');
      g.appendChild(s('rect', { class: 'pcb', x: 10, y: 26, width: 180, height: 116, rx: 7 }));
      // GPIO header 2×20
      this.el.pins = {};
      const map = {};
      CS.config.GPIO.forEach((p) => (map[p.pin] = p.bcm));
      for (let i = 0; i < 20; i++) {
        for (let r = 0; r < 2; r++) {
          const phys = i * 2 + (r ? 2 : 1);
          const c = s('rect', { class: 'pin', x: 22 + i * 8, y: 31 + r * 7, width: 5, height: 5 });
          g.appendChild(c);
          if (map[phys] != null) this.el.pins[map[phys]] = c;
        }
      }
      g.appendChild(s('rect', { class: 'chip', x: 60, y: 62, width: 44, height: 44, rx: 3 }));
      this.txt(g, 66, 88, 'n-sub', 'BCM2711', null).setAttribute('style', 'font-size:7.5px;fill:#8ea0bf');
      g.appendChild(s('rect', { class: 'chip', x: 114, y: 66, width: 30, height: 36, rx: 2 }));
      g.appendChild(s('rect', { x: 176, y: 56, width: 20, height: 26, fill: '#9aa5b4' }));
      g.appendChild(s('rect', { x: 176, y: 90, width: 20, height: 22, fill: '#9aa5b4' }));
      g.appendChild(s('rect', { x: 176, y: 116, width: 20, height: 22, fill: '#9aa5b4' }));
      g.appendChild(s('circle', { cx: 24, cy: 128, r: 3, fill: '#d33', id: 'pi-pwr' }));
      g.appendChild(s('circle', { cx: 34, cy: 128, r: 3, fill: '#2a3346', id: 'pi-act' }));
      this.el.piAct = g.lastChild;
      this.txt(g, 12, 18, 'n-title', 'Raspberry Pi 4 · edge gateway');
      this.txt(g, 202, 44, 'state-tag', '', 'piState');
      this.txt(g, 202, 62, 'n-sub', '', 'piCpu');
      this.txt(g, 202, 76, 'n-sub', '', 'piRam');
      this.txt(g, 202, 90, 'n-sub', '', 'piUp');

      this.txt(g, 40, 132, 'n-sub', 'coldstore-pi-01', null).setAttribute('style', 'fill:#cfe8d5;font-size:9.5px');
    }

    buildAlarm(ng) {
      const g = this.node(ng, 'alarm');
      this.txt(g, 12, 18, 'n-title', 'Local alarm panel (GPIO)');
      g.appendChild(s('rect', { x: 12, y: 28, width: 150, height: 44, rx: 4, fill: '#24331a' }));
      this.el.lcdBg = s('rect', { class: 'lcd-bg', x: 16, y: 32, width: 142, height: 36, rx: 2 });
      g.appendChild(this.el.lcdBg);
      this.el.lcd1 = this.txt(g, 21, 47, 'lcd-t', '');
      this.el.lcd2 = this.txt(g, 21, 63, 'lcd-t', '');
      const leds = [['red', 'ALARM', 28], ['green', 'OK', 66], ['amber', 'CLOUD', 104]];
      this.el.leds = {};
      leds.forEach(([c, l, x]) => {
        const led = s('circle', { class: 'led-off', cx: x, cy: 96, r: 7 });
        g.appendChild(led);
        this.el.leds[c] = led;
        this.txt(g, x - 14, 118, 'n-sub', l, null).setAttribute('style', 'font-size:9px');
      });
      const bz = s('g', { transform: 'translate(190,46)' },
        s('circle', { r: 15, fill: '#1c1f26', stroke: '#454c5a', 'stroke-width': 2 }), s('circle', { r: 3, fill: '#454c5a' }),
        s('path', { class: 'buzz-wave', d: 'M20 -10 q8 10 0 20' }), s('path', { class: 'buzz-wave w2', d: 'M26 -15 q12 15 0 30' }));
      g.appendChild(bz); this.el.buzzer = bz;
      this.txt(g, 172, 76, 'n-sub', 'buzzer', null);
      const btn = s('g', { transform: 'translate(176,90)', style: 'cursor:pointer' },
        s('rect', { width: 70, height: 30, rx: 6, fill: '#2b3448', stroke: '#56627c' }),
        s('text', { x: 35, y: 19, 'text-anchor': 'middle', class: 'n-sub', style: 'fill:#e5ecf7;font-weight:700' }, 'ACK btn'));
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.app.sim.pressAck(); this.app.toast('ACK button pressed', 'Buzzer silenced locally (GPIO22). Red LED stays on until the condition clears.', 'info'); });
      g.appendChild(btn);
    }

    buildSqlite(ng) {
      const g = this.node(ng, 'sqlite');
      this.txt(g, 10, 18, 'n-title', 'SQLite queue');
      g.appendChild(s('path', { class: 'cyl', d: 'M26 34 v52 a30 9 0 0 0 60 0 v-52' }));
      this.el.cylFill = s('rect', { class: 'cyl-fill', x: 26, y: 86, width: 60, height: 0 });
      g.appendChild(this.el.cylFill);
      g.appendChild(s('ellipse', { class: 'cyl', cx: 56, cy: 34, rx: 30, ry: 9 }));
      this.txt(g, 10, 104, 'n-val', '0', 'qDepth');
      this.txt(g, 56, 104, 'n-sub', '', 'qSize');
    }

    buildUps(ng) {
      const g = this.node(ng, 'ups');
      this.txt(g, 10, 18, 'n-title', 'UPS HAT');
      g.appendChild(s('rect', { x: 12, y: 30, width: 70, height: 30, rx: 4, fill: 'none', stroke: 'var(--muted)', 'stroke-width': 2 }));
      g.appendChild(s('rect', { x: 82, y: 39, width: 5, height: 12, fill: 'var(--muted)' }));
      this.el.upsFill = s('rect', { x: 15, y: 33, width: 64, height: 24, rx: 2, fill: 'var(--ok)' });
      g.appendChild(this.el.upsFill);
      this.txt(g, 12, 76, 'n-val', '100%', 'upsPct');
      this.txt(g, 56, 76, 'state-tag', 'MAINS', 'upsState');
      this.txt(g, 12, 88, 'n-sub', '2×18650 → Pi', null).setAttribute('style', 'font-size:9px');
    }

    buildBase(ng) {
      const g = this.node(ng, 'base');
      this.txt(g, 12, 18, 'n-title', 'Baseline node (cloud-only, for comparison)');
      this.txt(g, 12, 36, 'n-sub', 'same sensors · NO buffer · NO local alarm', null);
      this.txt(g, 12, 56, 'state-tag', '', 'baseState');
      this.txt(g, 12, 74, 'n-sub', '', 'baseStats');
    }

    buildRouter(ng) {
      const g = this.node(ng, 'router');
      g.appendChild(s('rect', { x: 18, y: 30, width: 68, height: 22, rx: 5, fill: '#273049', stroke: '#56627c' }));
      g.appendChild(s('path', { d: 'M30 30 l-6 -16 M74 30 l6 -16', stroke: '#8a96ad', 'stroke-width': 2.4, 'stroke-linecap': 'round' }));
      this.el.routerLeds = [0, 1, 2].map((i) => { const c = s('circle', { cx: 32 + i * 12, cy: 41, r: 3, fill: '#2bff7a' }); g.appendChild(c); return c; });
      this.txt(g, 8, 68, 'state-tag', '', 'routerState');
      this.txt(g, 8, 13, 'n-sub', 'router / 4G', null);
    }

    buildInternet(ng) {
      const g = this.node(ng, 'internet');
      g.firstChild.setAttribute('opacity', 0);
      this.el.inet = s('path', { class: 'inet', d: 'M14 58 a14 14 0 0 1 4 -27 a18 18 0 0 1 34 -6 a14 14 0 0 1 12 24 a10 10 0 0 1 -6 9 z' });
      g.appendChild(this.el.inet);
      this.txt(g, 14, 50, 'n-sub', 'Internet', null).setAttribute('style', 'font-size:10px;fill:var(--text2)');
      this.txt(g, 4, 84, 'state-tag', '', 'inetState');
    }

    buildAz(ng, id, title, sub) {
      const g = this.node(ng, id, 'az');
      const [, , w, h] = N[id];
      const icons = {
        hub: 'M14 12 l10 -6 l10 6 v12 l-10 6 l-10 -6z M24 6 v24 M14 12 l20 12 M34 12 l-20 12',
        eventgrid: 'M12 10h22v22h-22z M12 21h22 M23 10v22', fnConn: 'M26 6 l-10 16 h8 l-4 12 l12 -18 h-8z',
        sb: 'M10 12h26v18h-26z M10 12l13 9l13-9', fnAlert: 'M26 6 l-10 16 h8 l-4 12 l12 -18 h-8z', logic: 'M10 22h8l4-10l6 20l4-10h8',
        fnIngest: 'M26 6 l-10 16 h8 l-4 12 l12 -18 h-8z', asa: 'M10 30 l7-10 l6 5 l7-12 l6 6 M10 32h28', cosmos: 'M23 8a13 13 0 1 0 0.01 0 M10 21h26 M23 8c-6 6 -6 20 0 26 c6-6 6-20 0-26',
        signalr: 'M12 21h6 M28 21h6 M18 14a10 10 0 0 1 10 0 M18 28a10 10 0 0 0 10 0 M23 21m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
      };
      g.appendChild(s('path', { class: 'n-icon az', d: icons[id] || '', transform: id === 'hub' ? 'translate(4,4)' : 'translate(-4,8) scale(0.85)' }));
      const tx = id === 'hub' ? 12 : 38;
      this.txt(g, tx, id === 'hub' ? 58 : 20, 'n-title', title);
      this.txt(g, tx, id === 'hub' ? 74 : 34, 'n-sub', sub);
      this.txt(g, tx, id === 'hub' ? 96 : 52, 'n-val', '', id + 'Val');
      if (id === 'hub') {
        this.txt(g, tx, 114, 'n-sub', '', 'hubDev1');
        this.txt(g, tx, 130, 'n-sub', '', 'hubDev2');
        this.txt(g, tx, 148, 'n-sub', '', 'hubQuota');
        this.txt(g, tx, 164, 'n-sub', 'registry · twin · routing', null);
      }
      if (id === 'cosmos') { this.txt(g, 10, 70, 'n-sub', '', 'cosmos2'); this.txt(g, 10, 84, 'n-sub', '', 'cosmos3'); }
    }

    buildOperator(ng) {
      const g = this.node(ng, 'operator');
      g.appendChild(s('rect', { x: 34, y: 22, width: 60, height: 112, rx: 10, fill: '#0b0f18', stroke: '#3b4458', 'stroke-width': 3 }));
      this.txt(g, 10, 15, 'n-title', 'On-call operator');
      this.el.smsBox = s('rect', { x: 38, y: 34, width: 52, height: 0, rx: 4, fill: '#ef4444', opacity: 0.85 });
      g.appendChild(this.el.smsBox);
      this.el.sms = [0, 1, 2, 3, 4].map((i) => this.txt(g, 41, 46 + i * 11, 'n-sub', '')).map((t) => { t.setAttribute('style', 'font-size:8px;fill:#fff'); return t; });
      this.txt(g, 10, 146, 'n-sub', '', 'opCount');
    }

    buildDash(ng) {
      const g = this.node(ng, 'dash');
      this.txt(g, 10, 18, 'n-title', 'Dashboard');
      g.appendChild(s('rect', { x: 10, y: 26, width: 108, height: 72, rx: 4, fill: '#0b1220', stroke: '#3b4458', 'stroke-width': 2 }));
      g.appendChild(s('rect', { x: 54, y: 98, width: 20, height: 10, fill: '#3b4458' }));
      this.el.dashStatus = s('rect', { x: 14, y: 30, width: 100, height: 14, rx: 2, fill: '#22c55e' });
      g.appendChild(this.el.dashStatus);
      this.el.dashStatusT = this.txt(g, 18, 41, 'n-sub', 'SAFE');
      this.el.dashStatusT.setAttribute('style', 'fill:#03121e;font-weight:800;font-size:9.5px');
      this.txt(g, 16, 66, 'n-val', '—', 'dashT').setAttribute('style', 'font-size:17px;fill:#e7eef9');
      this.el.spark = s('polyline', { points: '', fill: 'none', stroke: '#38bdf8', 'stroke-width': 1.5 });
      g.appendChild(this.el.spark);
      this.txt(g, 10, 124, 'n-sub', 'Static Web App', null);
      this.txt(g, 10, 138, 'n-sub', '', 'dashSeen');
    }

    // --------------------------------------------------------------- packets
    addPacket(p, speed) {
      if (document.hidden) return;
      if (this.packets.length > 110 && LOW.has(p.kind)) return;
      if (this.packets.length > 170) return;
      const segs = [];
      for (let i = 0; i < p.hops.length - 1; i++) {
        const a = p.hops[i], b = p.hops[i + 1];
        const fwd = this.edges[`${a}>${b}`], rev = this.edges[`${b}>${a}`];
        if (fwd) segs.push({ e: fwd, rev: false }); else if (rev) segs.push({ e: rev, rev: true }); else return;
      }
      const lostAt = p.lostAt == null ? -1 : p.lostAt;
      const travel = lostAt >= 0 ? segs.slice(0, Math.max(0, lostAt)) : segs;
      const vis = Math.max(LOW.has(p.kind) ? 320 : 480, Math.min(1500, (p.dur || 100) / speed));
      const r = SIZE[p.kind] || 5, col = COLORS[p.kind] || '#fff';
      const g = s('g', { class: 'pkt' }, s('circle', { r, fill: col }), p.label ? s('text', null, p.label) : null);
      this.pk.appendChild(g);
      const total = travel.reduce((a, sg) => a + (sg.e.len || 50), 0) || 1;
      this.packets.push({ g, segs: travel, total, t0: performance.now(), dur: vis * Math.max(0.35, travel.length / Math.max(1, segs.length)), lost: lostAt >= 0, lostNode: lostAt >= 0 ? p.hops[lostAt] : null, msg: p.msg });
      if (p.msg) { g.style.pointerEvents = 'auto'; g.style.cursor = 'pointer'; g.addEventListener('click', () => this.app.showMessage(p.msg)); }
    }

    frame(now) {
      const keep = [];
      for (const k of this.packets) {
        const u = (now - k.t0) / k.dur;
        if (!k.segs.length) { this._lostMark(k); k.g.remove(); continue; }
        if (u >= 1) {
          if (k.lost) this._lostMark(k);
          k.g.remove();
          continue;
        }
        let d = u * k.total, i = 0;
        while (i < k.segs.length - 1 && d > (k.segs[i].e.len || 50)) { d -= k.segs[i].e.len || 50; i++; }
        const sg = k.segs[i], L = sg.e.len || 50;
        const pt = sg.e.p.getPointAtLength(sg.rev ? Math.max(0, L - d) : Math.min(L, d));
        k.g.setAttribute('transform', `translate(${pt.x},${pt.y})`);
        keep.push(k);
      }
      this.packets = keep;
    }

    _lostMark(k) {
      const id = k.lostNode;
      if (!id || !N[id]) return;
      const [x, y, w, h] = N[id];
      const cx = id === 'router' ? x + w + 8 : id === 'internet' ? x + 10 : x + w / 2, cy = y + h / 2;
      const m = s('g', { class: 'pkt', transform: `translate(${cx},${cy - 10})` }, s('path', { class: 'pkt-x', d: 'M-5-5L5 5M5-5L-5 5' }));
      this.pk.appendChild(m);
      m.animate([{ opacity: 1, transform: `translate(${cx}px,${cy - 10}px) scale(1)` }, { opacity: 0, transform: `translate(${cx}px,${cy - 22}px) scale(1.6)` }], { duration: 700 }).onfinish = () => m.remove();
    }

    clear() { this.packets.forEach((k) => k.g.remove()); this.packets = []; }

    // ---------------------------------------------------------------- update
    update(sim) {
      const E = this.el, room = sim.room, edge = sim.edge, cloud = sim.cloud, link = sim.link;
      const th = edge.th;
      const tc = room.temp;
      // room colour: blue when cold, through amber to red past the limit
      const frac = Math.max(0, Math.min(1, (tc - th.tMin) / Math.max(1, th.tMax - th.tMin)));
      const hot = tc > th.tMax ? Math.min(1, (tc - th.tMax) / 4) : 0;
      const colA = hot > 0 ? `rgb(${200 + 55 * hot},${120 - 60 * hot},${80 - 40 * hot})` : `rgb(${100 + 120 * frac},${200 - 20 * frac},${250 - 120 * frac})`;
      document.getElementById('air-a').setAttribute('stop-color', colA);
      E.roomProfile.textContent = `${CS.config.PROFILES[edge.cfg.profile].label} ${th.tMin}…${th.tMax} °C`;
      const last = edge.last;
      E.roomT.textContent = last && last.tempC != null ? `${last.tempC.toFixed(1)}°C` : '—';
      E.roomT.style.fill = last && (last.tempC > th.tMax || last.tempC < th.tMin) ? 'var(--err)' : '#e7eef9';
      E.roomH.textContent = last && last.rh != null ? `${last.rh.toFixed(0)}%RH` : '';
      E.roomTrue.textContent = `true air ${tc.toFixed(2)} °C · ${room.rh.toFixed(0)} %`;
      E.dsVal.textContent = last ? (last.ds18b20C == null ? 'FAULT' : `${last.ds18b20C.toFixed(2)}°`) : '—';
      E.dsVal.style.fill = last && last.ds18b20C == null ? 'var(--err)' : '';
      E.dhtVal.textContent = last ? (last.dht22C == null ? 'FAULT' : `${last.dht22C.toFixed(1)}° ${last.rh != null ? last.rh.toFixed(0) + '%' : ''}`) : '—';
      E.dhtVal.style.fill = last && last.dht22C == null ? 'var(--err)' : '';
      E.door.setAttribute('transform', room.doorOpen ? 'translate(26,0)' : '');
      E.door.firstChild.setAttribute('opacity', room.doorOpen ? 0.35 : 1);
      E.warmAir.setAttribute('opacity', room.doorOpen ? 1 : 0);
      const st = last ? last.status : '—';
      E.roomState.textContent = room.doorOpen ? 'DOOR OPEN' : '';
      E.roomState.style.fill = 'var(--warn)';
      E.evapFan.classList.toggle('spin', room.running);
      E.cuFan.classList.toggle('spin', room.running);
      E.cuState.textContent = !room.powerOk ? 'NO POWER' : room.compressorFailed ? 'FAILED' : room.thermostatStuck ? 'STUCK ON' : room.running ? 'RUNNING' : 'IDLE (thermostat)';
      E.cuState.style.fill = !room.powerOk || room.compressorFailed || room.thermostatStuck ? 'var(--err)' : room.running ? 'var(--ok)' : 'var(--muted)';
      E.cuSub.textContent = `duty ${(room.dutyCycle * 100).toFixed(0)} % · set ${room.setpoint} °C`;

      // pi
      const on = edge.power === 'ON';
      E.piState.textContent = edge.power === 'ON' ? 'RUNNING' : 'BOOTING…';
      E.piState.style.fill = on ? 'var(--ok)' : 'var(--warn)';
      E.piCpu.textContent = `CPU ${edge.res.cpu.toFixed(0)} %`;
      E.piRam.textContent = `RAM ${edge.res.ramMb.toFixed(0)} MB`;
      E.piUp.textContent = `${edge.res.cpuTempC.toFixed(0)} °C SoC`;
      E.piAct.setAttribute('fill', on && Math.random() < 0.5 ? '#2bff7a' : '#2a3346');
      const gp = edge.gpio;
      Object.entries(E.pins).forEach(([bcm, el]) => el.classList.toggle('hi', !!gp[bcm] && (bcm !== '18' || Math.floor(performance.now() / 300) % 2 === 0)));
      // alarm panel
      E.lcd1.textContent = edge.lcd[0];
      E.lcd2.textContent = edge.lcd[1];
      E.lcdBg.setAttribute('class', 'lcd-bg' + (!on ? ' off' : edge.out.alarm ? ' alarm' : ''));
      const o = edge.out;
      E.leds.red.setAttribute('class', on && o.red ? 'led-red' + (o.critical && !o.silenced ? ' blinking' : '') : 'led-off');
      E.leds.green.setAttribute('class', on && o.green ? 'led-green' : 'led-off');
      E.leds.amber.setAttribute('class', on && o.amber !== 'off' ? 'led-amber' + (o.amber === 'blink' ? ' fastblink' : '') : 'led-off');
      E.buzzer.classList.toggle('buzz-on', on && o.buzzer);
      // sqlite
      const depth = edge.store.depth;
      const fill = depth ? Math.min(52, 6 + Math.log10(depth + 1) * 15) : 0;
      E.cylFill.setAttribute('y', 86 - fill); E.cylFill.setAttribute('height', fill);
      E.qDepth.textContent = String(depth);
      E.qDepth.style.fill = depth > 2 ? 'var(--warn)' : '';
      E.qSize.textContent = `${fmt.bytes(edge.store.dbBytes())}`;
      // ups
      const u = sim.ups;
      E.upsFill.setAttribute('width', 64 * u.pct / 100);
      E.upsFill.setAttribute('fill', u.pct < 25 ? 'var(--err)' : u.onBattery ? 'var(--warn)' : 'var(--ok)');
      E.upsPct.textContent = `${u.pct.toFixed(0)}%`;
      E.upsState.textContent = u.onBattery ? 'ON BATTERY' : 'MAINS';
      E.upsState.style.fill = u.onBattery ? 'var(--warn)' : 'var(--ok)';
      // baseline
      const b = sim.baseline;
      E.baseState.textContent = `MQTT ${b.state}`;
      E.baseState.style.fill = b.connected ? 'var(--ok)' : 'var(--err)';
      E.baseStats.textContent = `sent ${b.stats2.sent} · dropped ${b.stats2.droppedOffline + b.stats2.droppedTimeout}`;
      this.el.base.style.opacity = sim.opts.baseline ? 1 : 0.35;
      // network
      const up = link.up;
      E.routerState.textContent = !link.routerPowered ? 'NO POWER' : link.mode === 'offline' ? 'WAN DOWN' : link.mode === 'degraded' ? 'DEGRADED' : 'WAN UP';
      E.routerState.style.fill = up ? (link.mode === 'degraded' ? 'var(--warn)' : 'var(--ok)') : 'var(--err)';
      E.routerLeds.forEach((l, i) => l.setAttribute('fill', !link.routerPowered ? '#2a3346' : i === 2 && !up ? '#ff3b3b' : link.mode === 'degraded' && i === 2 ? '#ffb020' : '#2bff7a'));
      E.inet.classList.toggle('down', !up);
      E.inetState.textContent = up ? '' : 'UNREACHABLE';
      E.inetState.style.fill = 'var(--err)';
      this.cut.setAttribute('opacity', up ? 0 : 1);
      ['router>internet', 'internet>hub'].forEach((k) => {
        const e = this.edges[k].p;
        e.classList.toggle('dead', !up);
        e.classList.toggle('degraded', up && link.mode === 'degraded');
      });
      ['pi>router'].forEach((k) => this.edges[k].p.classList.toggle('dead', !link.routerPowered || !on));
      // azure
      const devs = Object.values(cloud.devices);
      const conn = devs.filter((d) => d.conn === 'Connected').length;
      E.hubVal.textContent = `${cloud.quota.msgs.toLocaleString()} D2C msgs`;
      E.hubDev1.textContent = `edge Pi: ${cloud.devices[edge.id].conn}`;
      E.hubDev1.style.fill = cloud.devices[edge.id].conn === 'Connected' ? 'var(--ok)' : 'var(--err)';
      E.hubDev2.textContent = `baseline: ${cloud.devices[sim.baseline.id].conn}`;
      E.hubDev2.style.fill = cloud.devices[sim.baseline.id].conn === 'Connected' ? 'var(--ok)' : 'var(--err)';
      E.hubQuota.textContent = `quota used ${((cloud.quota.units / CS.config.HUB.dailyQuota) * 100).toFixed(2)} %`;
      E.eventgridVal.textContent = cloud.eventGrid[0] ? cloud.eventGrid[0].type.split('.').pop().replace('Device', '') : '—';
      E.fnConnVal.textContent = `${cloud.fn.ConnectionMonitor.inv} runs`;
      E.sbVal.textContent = `${cloud.routes['alerts-route']} routed`;
      E.fnAlertVal.textContent = `${cloud.fn.AlertProcessor.inv} runs · ${cloud.fn.AlertProcessor.cold} cold`;
      E.logicVal.textContent = `${cloud.notifications.length} sent`;
      E.fnIngestVal.textContent = `${cloud.fn.TelemetryIngest.inv} runs`;
      E.asaVal.textContent = `${cloud.asa.events.toLocaleString()} events`;
      const tdocs = cloud.telemetry[edge.id].docs.length + cloud.telemetry[sim.baseline.id].docs.length;
      E.cosmosVal.textContent = `telemetry ${tdocs.toLocaleString()}`;
      E.cosmos2.textContent = `alerts ${cloud.alerts.length} · agg ${cloud.aggCount}`;
      E.cosmos3.textContent = `dupes discarded ${cloud.telemetry[edge.id].dupes + cloud.telemetry[sim.baseline.id].dupes}`;
      E.signalrVal.textContent = `${cloud.liveLatencyN ? 'avg ' + fmt.dur(cloud.liveLatencyMean) : '—'} e2e`;
      // operator phone
      const n = cloud.notifications[0];
      const lines = n ? wrapText(`${n.title}`, 13).slice(0, 5) : ['', 'no alerts', '', '', ''];
      E.sms.forEach((t, i) => (t.textContent = lines[i] || ''));
      E.smsBox.setAttribute('height', n ? 58 : 0);
      E.smsBox.setAttribute('fill', n && n.severity === 'critical' ? '#b91c1c' : '#b45309');
      E.opCount.textContent = `${cloud.notifications.length} notifications`;
      // dashboard
      const dd = cloud.dash[edge.id];
      const dl = dd.last;
      const active = cloud.alerts.some((a) => a.deviceId === edge.id && a.state === 'RAISED' && !a.clearedAt && CS.rules.CRITICAL.has(a.alarm));
      const offline = dd.conn === 'offline';
      E.dashStatus.setAttribute('fill', active ? '#ef4444' : offline ? '#f59e0b' : dl && dl.status === 'WARN' ? '#f59e0b' : '#22c55e');
      E.dashStatusT.textContent = active ? 'ALARM' : offline ? 'DEVICE OFFLINE' : dl ? (dl.status === 'WARN' ? 'WARNING' : 'SAFE') : 'WAITING';
      E.dashT.textContent = dl && dl.tempC != null ? `${dl.tempC.toFixed(1)} °C` : '—';
      const docs = cloud.telemetry[edge.id].docs.slice(-40);
      if (docs.length > 1) {
        const ys = docs.map((d) => d.tempC).filter((v) => v != null);
        const lo = Math.min(...ys, th.tMin), hi = Math.max(...ys, th.tMax);
        E.spark.setAttribute('points', docs.map((d, i) => `${16 + (i / (docs.length - 1)) * 96},${94 - ((d.tempC - lo) / (hi - lo || 1)) * 22}`).join(' '));
      }
      E.dashSeen.textContent = dl ? `last data ${fmt.dur(sim.now() - dl.ts)} ago` : '';
    }
  }

  function wrapText(t, n) {
    const out = []; let line = '';
    t.split(' ').forEach((w) => { if ((line + ' ' + w).trim().length > n) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim(); });
    if (line) out.push(line);
    return out;
  }

  CS.Topology = Topology;
  CS.Topology.COLORS = COLORS;
})(window.CS = window.CS || {});
