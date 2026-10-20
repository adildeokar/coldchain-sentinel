/* Live Simulation view: topology, scenario injection, live readings, event log, wire inspector. */
(function (CS) {
  'use strict';
  const { h, esc, json, badge, statusKind } = CS.dom;
  const { fmt } = CS.util;
  CS.views = CS.views || {};

  const NODE_INFO = {
    room: ['Cold room', 'Walk-in cold room modelled as a thermal mass: wall heat leak, extra air exchange when the door is open, and an on/off compressor with ±1 °C thermostat hysteresis. Humidity rises toward ambient when the door is open.', 'engine/physics.js'],
    cu: ['Condensing unit', 'Compressor + condenser. Failure stops cooling (+0.6 °C/min). Stuck thermostat runs it non-stop (over-cooling → LOW_TEMP). Site power failure stops it.', 'engine/physics.js'],
    pi: ['Raspberry Pi 4 edge gateway', 'Runs firmware/main.py as a systemd service: samples every 5 s, applies the local rule engine, drives the alarm GPIO, writes every reading to SQLite, and uploads over MQTT/TLS with priority sync.', 'firmware/main.py'],
    alarm: ['Local alarm panel', 'Buzzer (GPIO18 via 2N2222), red/green/amber LEDs (GPIO23/24/25), 16×2 I²C LCD and an ACK button (GPIO22). Works with zero network. Click ACK to silence the buzzer.', 'firmware/coldstore/actuators/alarm.py'],
    sqlite: ['SQLite store-and-forward queue', 'Rows are PENDING until IoT Hub\'s PUBACK, then SENT. Survives outages and reboots; sequence numbers continue so the cloud can de-duplicate.', 'firmware/coldstore/store.py'],
    ups: ['UPS HAT', 'Two 18650 cells keep the Pi, sensors and buzzer running for ~5 h during a site power cut. The compressor and router are on mains, so they stop.', 'firmware/coldstore.service'],
    base: ['Baseline cloud-only node', 'Comparison device on the same sensors and link with NO edge logic: no buffer (offline readings are discarded), no local alarm (alerts come only from Stream Analytics in the cloud).', 'engine/baseline.js'],
    router: ['Site router / 4G', 'The WAN uplink. "Internet outage" cuts it; "Degraded" adds 650 ms latency and 12 % loss; a site power failure turns it off.', 'engine/network.js'],
    internet: ['Internet', 'Path to Azure. Packets that hit a down link are lost (red ✕).', 'engine/network.js'],
    hub: ['Azure IoT Hub', 'Device registry with SAS keys, device twins, direct methods, MQTT endpoint and message routing (alerts-route, telemetry-route). Closes a silent session after 1.5 × keep-alive (90 s).', 'cloud/iot-hub/provision.sh'],
    eventgrid: ['Event Grid', 'Publishes IoT Hub lifecycle events Microsoft.Devices.DeviceConnected / DeviceDisconnected.', 'cloud/iot-hub/provision.sh'],
    fnConn: ['Function: ConnectionMonitor', 'Event Grid trigger. Tells staff the site is offline and that the edge is covering locally.', 'cloud/functions/function_app.py'],
    sb: ['Service Bus queue cold-alerts', 'Durable queue between the alerts route and AlertProcessor, so no alert is lost even if the function is restarting.', 'cloud/iot-hub/message-routes.json'],
    fnAlert: ['Function: AlertProcessor', 'Service Bus trigger. Stores the alert, computes end-to-end latency from firstBreachAt, sends SMS/e-mail via Logic App and pushes to the dashboard. Consumption plan → cold start after ~20 min idle.', 'cloud/functions/function_app.py'],
    logic: ['Logic App + Communication Services', 'Sends SMS, e-mail and a Teams post for each RAISED alert and for offline notices.', 'cloud/functions/function_app.py'],
    operator: ['On-call operator', 'Receives notifications. Compare when the SMS arrives (cloud alert) with when the buzzer went on at the site (local alert).', 'engine/azure.js'],
    fnIngest: ['Function: TelemetryIngest', 'Event Hub trigger on the built-in endpoint. Expands batches and upserts each reading with id = deviceId-seq (re-sent readings overwrite themselves).', 'cloud/functions/function_app.py'],
    asa: ['Stream Analytics coldchain-asa', '1-minute tumbling-window aggregates, TIMESTAMP BY device time (late back-fill lands in the right minute), plus the cloud-only alert rule for the baseline node.', 'cloud/stream-analytics/coldstore-job.asaql'],
    cosmos: ['Cosmos DB (serverless)', 'Containers: telemetry, alerts, aggregates. Partition key /deviceId, TTL 90 days.', 'cloud/iot-hub/provision.sh'],
    signalr: ['Azure SignalR (serverless)', 'Pushes live readings, alerts and connection state to the dashboard over WebSockets.', 'cloud/functions/function_app.py'],
    dash: ['Operator dashboard', 'Built only from cloud data: live status, history with back-filled points, alert table. Open the Dashboard view for the full app.', 'public/js/views/dashboard.js'],
  };

  const live = {
    init(app, el) {
      this.app = app;
      el.innerHTML = '';
      el.appendChild(h('div', { class: 'view-h' },
        h('div', null, h('h2', null, 'Live end-to-end simulation'),
          h('div', { class: 'desc' }, 'Sensors → Raspberry Pi edge logic → MQTT/TLS → Azure IoT Hub → routing → Functions / Stream Analytics → Cosmos DB → SignalR → dashboard and SMS. Hover a link to see its protocol. Click a node for details, or a moving packet to see its payload.')),
        h('div', { class: 'tools' },
          h('label', { class: 'chk' }, this.baseChk = h('input', { type: 'checkbox', checked: true, onchange: (e) => { app.sim.opts.baseline = e.target.checked; app.toast(e.target.checked ? 'Baseline node visible' : 'Baseline node dimmed', 'It keeps running for the comparison numbers.'); } }), 'Show baseline node'))));
      const tw = h('div', { class: 'topo-wrap' });
      el.appendChild(tw);
      this.topo = new CS.Topology(tw, app);
      app.topology = this.topo;
      const C = CS.Topology.COLORS;
      tw.appendChild(h('div', { class: 'legend' }, ...[['telemetry', 'live reading'], ['batch', 'backlog batch'], ['alert', 'alert'], ['ack', 'PUBACK'], ['tls', 'TLS/CONNECT'], ['c2d', 'twin/method'], ['event', 'lifecycle event'], ['notify', 'SMS/e-mail'], ['sensor', 'sensor read']].map(([k, l]) => h('span', null, h('i', { style: { background: C[k] } }), l))));

      const grid = h('div', { class: 'live-grid' });
      el.appendChild(grid);
      grid.appendChild(this.buildActions(app));
      grid.appendChild(this.buildReadings());
      grid.appendChild(this.buildLog());
      el.appendChild(this.buildWire());
      this.logN = 0;
      this.filter = 'all';
    },

    buildActions(app) {
      const sim = () => app.sim;
      const act = (label, fn, cls = '', title = '') => h('button', { class: `btn sm ${cls}`, title, onclick: () => { fn(); this.render(app, true); } }, label);
      const tog = (key, onLabel, offLabel, isOn, fnOn, fnOff, cls = '', title = '') => {
        const b = h('button', { class: `btn sm ${cls}`, title, onclick: () => { isOn() ? fnOff() : fnOn(); this.render(app, true); } }, offLabel);
        this.toggles.push(() => { b.textContent = isOn() ? onLabel : offLabel; b.classList.toggle('active', isOn()); });
        return b;
      };
      this.toggles = [];
      const g = (title, ...btns) => h('div', { class: 'act-group' }, h('h4', null, title), h('div', { class: 'row' }, ...btns));
      return h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('h3', null, 'Inject events'), h('span', { class: 'sub' }, 'faults · outages · operator')),
        h('div', { class: 'card-b' },
          g('Cold room',
            act('🚪 Door open 90 s', () => sim().openDoor(90), 'warn', 'Warm humid air enters: temperature + humidity rise'),
            tog('door', '🚪 Close door', '🚪 Door (hold open)', () => sim().room.doorOpen, () => sim().openDoor(), () => sim().closeDoor(), '', 'Leave the door open until you close it — DOOR_OPEN alarm after 120 s'),
            tog('comp', '🔧 Repair compressor', '⚠ Compressor failure', () => sim().room.compressorFailed, () => sim().failCompressor(), () => sim().repairCompressor(), 'danger', 'Cooling stops; room warms ~0.6 °C/min'),
            tog('stuck', '🔧 Fix thermostat', '❄ Thermostat stuck ON', () => sim().room.thermostatStuck, () => sim().setThermostatStuck(true), () => sim().setThermostatStuck(false), '', 'Over-cooling → LOW_TEMP (freezing damages vaccines)'),
            act('💧 Humidity surge', () => sim().humiditySurge(240), '', 'Wet produce / defrost water → HIGH_RH')),
          g('Sensors',
            tog('ds', '🔌 Reconnect DS18B20', '🔌 Unplug DS18B20', () => sim().sensors.dsFault === 'unplugged', () => sim().sensorFault('ds18b20', 'unplugged'), () => sim().sensorFault('ds18b20', null), '', 'Probe fails CRC → falls back to DHT22 temperature'),
            act('⚡ DS18B20 85 °C glitch', () => sim().ds18b20Glitch(), '', 'Power-on-reset value 85.000 °C must be rejected, not alarmed'),
            tog('dht', '🔌 Reconnect DHT22', '🔌 Unplug DHT22', () => sim().sensors.dhtFault, () => sim().sensorFault('dht22', true), () => sim().sensorFault('dht22', false), '', 'Humidity lost; unplug both sensors → SENSOR_FAULT')),
          g('Network',
            act('📡 Internet outage 5 min', () => sim().networkOutage(300), 'danger', 'WAN down for 5 simulated minutes'),
            tog('net', '✅ Restore internet', '✂ Cut internet', () => sim().link.mode === 'offline', () => sim().networkOutage(), () => sim().restoreNetwork(), 'danger', 'Manual outage until you restore it'),
            tog('deg', '✅ Normal link', '📶 Degraded 4G', () => sim().link.mode === 'degraded', () => sim().degradeNetwork(), () => sim().restoreNetwork(), 'warn', '650 ms latency, 12 % loss → retries + duplicates')),
          g('Power',
            tog('pwr', '🔌 Restore mains', '⚡ Site power failure', () => !sim().room.powerOk, () => sim().sitePowerFail(600), () => sim().restorePower(), 'danger', 'Compressor and router lose power (10 min); Pi continues on UPS'),
            act('↻ Reboot Pi', () => sim().rebootPi(), '', 'Power-cycle the Pi: RAM state lost, SQLite queue survives')),
          g('Operator',
            act('🔕 Press ACK button', () => sim().pressAck(), '', 'Local GPIO22 button silences the buzzer'),
            act('☁ Silence via cloud', () => sim().cloud.invokeMethod(sim().edge.id, 'silenceAlarm', {}, (r) => app.toast(`Direct method silenceAlarm → ${r.status}`, r.status === 200 ? `round trip ${fmt.dur(r.latencyMs)}` : r.result.message, r.status === 200 ? 'ok' : 'err')), '', 'IoT Hub direct method → fails with 404 while the device is offline'),
            tog('twin', '↩ Twin: max back to 8 °C', '☁ Twin: max → 7 °C', () => sim().cloud.devices[sim().edge.id].twin.desired.thresholds.temp_max_c === 7,
              () => sim().cloud.updateDesired(sim().edge.id, { thresholds: { temp_max_c: 7 } }), () => sim().cloud.updateDesired(sim().edge.id, { thresholds: { temp_max_c: CS.config.PROFILES[sim().edge.cfg.profile].tMax } }), '', 'Change desired properties; applied immediately if online, on reconnect if not')),
          h('div', { class: 'small muted' }, 'Tip: try ', h('b', null, 'Cut internet'), ' and then ', h('b', null, 'Compressor failure'), '. The buzzer fires at once, but the SMS waits until you restore the link.')));
    },

    buildReadings() {
      this.r = {};
      const R = this.r;
      return h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('h3', null, 'Cold room · live'), h('span', { class: 'sub' }, 'what the Pi measures vs. what Azure has'), h('div', { class: 'right' }, R.status = h('span', { class: 'badge' }, '—'))),
        h('div', { class: 'card-b' },
          h('div', { class: 'big-reading' },
            h('div', null, h('div', { class: 'small muted' }, 'Temperature (edge)'), h('span', { class: 'v' }, R.t = h('span', null, '—')), h('span', { class: 'u' }, ' °C')),
            h('div', null, h('div', { class: 'small muted' }, 'Humidity'), h('span', { class: 'v', style: 'font-size:28px' }, R.h = h('span', null, '—')), h('span', { class: 'u' }, ' %RH')),
            h('div', { class: 'sp' }),
            h('div', { style: 'text-align:right' }, h('div', { class: 'small muted' }, 'Azure has'), h('div', { class: 'mono', style: 'font-size:18px;font-weight:700' }, R.ct = h('span', null, '—')), R.cage = h('div', { class: 'small muted' }, ''))),
          R.strip = h('div', { class: 'status-strip' }),
          h('div', { class: 'small muted mt' }, 'Temperature: edge (local truth) vs cloud (Cosmos DB), last 10 min'),
          R.spark = h('canvas', { style: 'width:100%;height:80px;display:block;margin-top:4px' }),
          h('div', { class: 'mini-stats' },
            ...[['q', 'SQLite queue'], ['mq', 'MQTT state'], ['al', 'Alerts local / cloud'], ['le', 'Lost: edge'], ['lb', 'Lost: baseline'], ['sy', 'Last sync']].map(([k, l]) => h('div', null, h('div', { class: 'l' }, l), R[k] = h('div', { class: 'v' }, '—'))))));
    },

    buildLog() {
      const filters = [['all', 'All'], ['edge', 'Edge'], ['net', 'Network'], ['cloud', 'Azure'], ['alarm', 'Alarms'], ['base', 'Baseline']];
      this.logEl = h('div', { class: 'log' });
      return h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('h3', null, 'Event log'), h('div', { class: 'right' },
          h('div', { class: 'filters' }, ...filters.map(([k, l]) => h('button', { class: k === 'all' ? 'on' : '', 'data-f': k, onclick: (e) => { this.filter = k; [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target)); this.rebuildLog(); } }, l))))),
        this.logEl);
    },

    buildWire() {
      this.w = {};
      const W = this.w;
      return h('div', { class: 'card mt' },
        h('div', { class: 'card-h' }, h('h3', null, 'Message on the wire'), h('span', { class: 'sub' }, 'latest MQTT PUBLISH from the Pi (click a moving packet to pin one)'),
          h('div', { class: 'right' }, h('label', { class: 'chk' }, W.follow = h('input', { type: 'checkbox', checked: true }), 'follow latest'))),
        h('div', { class: 'card-b wire-msg' },
          W.kv = h('div', { class: 'kv' }),
          W.body = h('pre', { class: 'code', style: 'max-height:260px' }, '')));
    },

    showMessage(msg) {
      const W = this.w;
      if (!msg) return;
      const C = CS.config.WIRE;
      const overhead = msg.wireBytes - msg.payloadBytes;
      const rows = [
        ['Type', `${msg.kind}${msg.body.count ? ` (${msg.body.count} readings)` : ''}`],
        ['From', `${msg.body.deviceId}`],
        ['MQTT topic', msg.topic],
        ['QoS', '1 (at-least-once, waits for PUBACK)'],
        ['App properties', Object.entries(msg.props).map(([k, v]) => `${k}=${v}`).join(' · ')],
        ['Message-Id', msg.msgId],
        ['Sent', fmt.timeMs(msg.sentAt)],
        ['Payload', `${msg.payloadBytes} B JSON (UTF-8)`],
        ['On the wire', `${msg.wireBytes} B = payload + topic ${msg.topic.length + 2} + MQTT ${C.mqttFixed} + TLS ${C.tlsRecord} + TCP/IP ${C.tcpIp}`],
        ['Overhead', `${((overhead / msg.wireBytes) * 100).toFixed(0)} % (TLS record alone ${((C.tlsRecord / msg.wireBytes) * 100).toFixed(1)} %)`],
      ];
      W.kv.innerHTML = rows.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('');
      W.body.innerHTML = json(msg.body);
    },

    rebuildLog() { this.logEl.innerHTML = ''; this.logN = 0; this.appendLogs(true); },

    match(e) {
      const f = this.filter;
      if (f === 'all') return e.level !== 'debug';
      if (f === 'edge') return ['EDGE', 'ROOM', 'SENSOR', 'POWER'].includes(e.src);
      if (f === 'net') return e.src === 'NET' || /MQTT|connect/i.test(e.msg);
      if (f === 'cloud') return ['HUB', 'ROUTE', 'FUNC', 'ASA', 'COSMOS', 'NOTIFY'].includes(e.src);
      if (f === 'alarm') return e.level === 'alarm' || /ALARM|alert/i.test(e.msg);
      if (f === 'base') return e.src === 'BASE' || /baseline-node/.test(e.msg);
      return true;
    },

    appendLogs(all) {
      const logs = this.app.sim.logs;
      const start = all ? 0 : logs.findIndex((e) => e.n > this.logN);
      if (start < 0) return;
      const frag = document.createDocumentFragment();
      const atBottom = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 40;
      for (let i = start; i < logs.length; i++) {
        const e = logs[i];
        this.logN = e.n;
        if (!this.match(e)) continue;
        const row = h('div', { class: `le ${e.level}` }, h('span', { class: 't' }, fmt.time(e.t)), h('span', { class: `s src-${e.src}` }, e.src), h('span', { class: 'm' }, e.msg));
        frag.appendChild(row);
      }
      this.logEl.appendChild(frag);
      while (this.logEl.children.length > 500) this.logEl.firstChild.remove();
      if (atBottom || all) this.logEl.scrollTop = this.logEl.scrollHeight;
    },

    render(app, force) {
      const sim = app.sim, e = sim.edge, R = this.r, last = e.last;
      this.toggles.forEach((f) => f());
      this.topo.update(sim);
      this.appendLogs(false);
      if (last) {
        R.t.textContent = last.tempC == null ? '—' : last.tempC.toFixed(2);
        R.h.textContent = last.rh == null ? '—' : last.rh.toFixed(1);
        R.status.className = 'badge ' + statusKind(last.status);
        R.status.textContent = last.status + (last.alarms.length ? ' · ' + last.alarms.join(', ') : '');
      }
      const cl = sim.cloud.dash[e.id].last;
      R.ct.textContent = cl && cl.tempC != null ? `${cl.tempC.toFixed(2)} °C` : '—';
      R.cage.textContent = cl ? `received ${fmt.dur(sim.now() - cl.receivedAt)} ago` : 'nothing yet';
      R.cage.className = 'small ' + (cl && sim.now() - cl.receivedAt > 20000 ? 'warn-t' : 'muted');
      const st = [];
      st.push(badge(sim.room.doorOpen ? 'DOOR OPEN' : 'door closed', sim.room.doorOpen ? 'warn' : ''));
      st.push(badge(!sim.room.powerOk ? 'NO MAINS' : sim.room.compressorFailed ? 'COMPRESSOR FAILED' : sim.room.running ? 'compressor on' : 'compressor idle', !sim.room.powerOk || sim.room.compressorFailed ? 'err' : sim.room.running ? 'info' : ''));
      st.push(badge(`WAN ${sim.link.state}`, sim.link.up ? (sim.link.mode === 'degraded' ? 'warn' : 'ok') : 'err'));
      if (e.out.buzzer) st.push(badge('🔊 BUZZER', 'err'));
      else if (e.out.alarm) st.push(badge('🔕 silenced', 'warn'));
      if (e.power !== 'ON') st.push(badge('PI BOOTING', 'warn'));
      if (sim.ups.onBattery) st.push(badge(`UPS ${sim.ups.pct.toFixed(0)} %`, 'warn'));
      if (sim.sensors.dsFault) st.push(badge('DS18B20 FAULT', 'err'));
      if (sim.sensors.dhtFault) st.push(badge('DHT22 FAULT', 'err'));
      R.strip.innerHTML = st.join('');
      // sparkline
      const from = sim.now() - 600000;
      const loc = e.history.filter((x) => x.ts >= from).map((x) => x.t);
      CS.charts.sparkline(R.spark, loc, CS.charts.css('--accent'), [e.th.tMin, e.th.tMax]);
      const m = sim.metrics.summary();
      R.q.textContent = `${e.store.depth} rows`;
      R.q.className = 'v ' + (e.store.depth > 3 ? 'warn-t' : '');
      R.mq.textContent = e.state;
      R.mq.className = 'v ' + (e.connected ? 'ok-t' : 'err-t');
      const localN = m.episodes.filter((x) => x.edgeLocalAt).length;
      const cloudN = sim.cloud.alerts.filter((a) => a.deviceId === e.id && a.state === 'RAISED').length;
      R.al.textContent = `${localN} / ${cloudN}`;
      R.le.textContent = `${m.dev.edge.lost} of ${m.dev.edge.gen}`;
      R.le.className = 'v ' + (m.dev.edge.lost ? 'err-t' : 'ok-t');
      R.lb.textContent = `${m.dev.base.lost} of ${m.dev.base.gen}`;
      R.lb.className = 'v ' + (m.dev.base.lost ? 'err-t' : 'ok-t');
      const sy = m.syncs[m.syncs.length - 1];
      R.sy.textContent = e.sync ? `syncing ${e.store.backlogCount(sim.now() - 10000)}…` : sy ? `${sy.backlog} rows · ${fmt.dur(sy.durationMs)}` : '—';
      if (this.w.follow.checked && app.lastMsg && app.lastMsg !== this._shown) { this._shown = app.lastMsg; this.showMessage(app.lastMsg); }
    },

    inspect(app, id) {
      const info = NODE_INFO[id];
      if (!info) return;
      const pre = h('pre', { class: 'code mt' }, 'loading live state from the server…');
      CS.api.get(`/api/inspect/${id}`).then((d) => (pre.innerHTML = json(d))).catch((err) => (pre.textContent = err.message));
      const body = h('div', null,
        h('p', null, info[1]),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { close(); app.openSource(info[2]); } }, `{ } Open ${info[2]}`),
          id === 'dash' ? h('button', { class: 'btn', onclick: () => { close(); app.show('dashboard'); } }, 'Open dashboard view') : null,
          id === 'hub' ? h('button', { class: 'btn', onclick: () => { close(); app.show('cloud'); } }, 'Open IoT Hub view') : null,
          id === 'pi' || id === 'alarm' ? h('button', { class: 'btn', onclick: () => { close(); app.show('hardware'); } }, 'Open circuit view') : null),
        h('h4', { class: 'mt' }, 'Live state (GET /api/inspect/' + id + ')'),
        pre);
      const close = CS.dom.modal(info[0], body);
    },

    onReset(app) { this.topo.clear(); this.rebuildLog(); this._shown = null; this.w.kv.innerHTML = ''; this.w.body.textContent = ''; },
  };

  CS.views.live = live;
})(window.CS = window.CS || {});
