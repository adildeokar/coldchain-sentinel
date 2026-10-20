/* Azure side, modelled service by service (see cloud/ for the deployable code):
 *
 *   IoT Hub ─┬─ alerts-route   (alert = 'true')  → Service Bus "cold-alerts" → Fn AlertProcessor → Cosmos "alerts"
 *            │                                                                    ├→ Logic App → SMS / e-mail
 *            │                                                                    └→ SignalR → dashboard
 *            ├─ telemetry-route (alert = 'false') → events → Fn TelemetryIngest → Cosmos "telemetry" (id = deviceId-seq)
 *            │                                             └→ Stream Analytics → "aggregates" + cloud-only alert rule
 *            ├─ device twin (desired / reported), direct methods
 *            └─ Event Grid DeviceConnected / DeviceDisconnected → Fn ConnectionMonitor
 *
 * Every hop has a latency drawn from CS.config.CLOUD. */
(function (CS) {
  'use strict';
  const { CLOUD, HUB, DEFAULTS } = CS.config;
  const { fmt } = CS.util;
  const { LABEL } = CS.rules;

  const clone = (o) => JSON.parse(JSON.stringify(o));

  class AzureCloud {
    constructor(sim) {
      this.sim = sim;
      this.devices = {};
      const p = CS.config.PROFILES[sim.opts.profile || 'pharma'];
      this._addDevice(DEFAULTS.deviceId, 'Edge gateway (Raspberry Pi 4)', {
        profile: sim.opts.profile || 'pharma',
        thresholds: { temp_min_c: p.tMin, temp_max_c: p.tMax, rh_min_pct: p.hMin, rh_max_pct: p.hMax, alarm_delay_samples: DEFAULTS.alarmDelaySamples },
        sampleIntervalSec: DEFAULTS.sampleIntervalS,
      });
      this._addDevice(DEFAULTS.baselineId, 'Baseline cloud-only node', { sampleIntervalSec: DEFAULTS.sampleIntervalS });
      this.telemetry = {};
      Object.keys(this.devices).forEach((id) => (this.telemetry[id] = { docs: [], keys: new Set(), dupes: 0 }));
      this.alerts = [];
      this.alertKeys = new Set();
      this.notifications = [];
      this.agg = {};
      this.monitor = [];
      this.d2cPerMin = new Map();
      this.docK = 0;                     // insertion counter, lets the server stream only new documents
      this.docLog = [];
      this.fn = {};
      ['TelemetryIngest', 'AlertProcessor', 'ConnectionMonitor'].forEach((n) => (this.fn[n] = { inv: 0, cold: 0, last: -Infinity, totalMs: 0, maxMs: 0 }));
      this.routes = { 'alerts-route': 0, 'telemetry-route': 0, 'twin-route': 0 };
      this.quota = { msgs: 0, units: 0, bytes: 0 };
      this.asa = { events: 0, outputs: 0, rules: {}, lastWindow: null };
      this.eventGrid = [];
      this.methods = [];
      this.twinLog = [];
      this.liveLatency = [];
      this.dash = {};
      Object.keys(this.devices).forEach((id) => (this.dash[id] = { conn: 'offline', since: 0, last: null }));
    }

    _addDevice(id, label, desired) {
      this.devices[id] = {
        id, label, auth: 'Symmetric key (SAS)', status: 'enabled', conn: 'Disconnected', connSince: 0, lastActivity: 0,
        d2c: 0, c2d: 0, bytes: 0,
        twin: { desired: { ...desired, $version: 1 }, reported: { $version: 1 }, tags: { site: 'warehouse-a', room: 'cold-room-1' } },
      };
    }

    start() { this.sim.every(5000, () => this._watchdog()); }

    _r([a, b]) { return this.sim.rng.range(a, b); }

    // ---- connections ----------------------------------------------------------
    deviceConnected(id) {
      const d = this.devices[id];
      d.lastActivity = this.sim.t;
      if (d.conn !== 'Connected') {
        d.conn = 'Connected'; d.connSince = this.sim.t;
        this.sim.log('HUB', 'ok', `${id} connected (MQTT, SAS auth OK, keep-alive ${DEFAULTS.keepAliveS} s)`);
        this._eventGrid('Microsoft.Devices.DeviceConnected', id);
      }
      return { desired: clone(d.twin.desired), reported: clone(d.twin.reported) };
    }

    ping(id, cb) { const d = this.devices[id]; if (d.conn === 'Connected') { d.lastActivity = this.sim.t; cb(); } }

    _watchdog() {
      const grace = DEFAULTS.keepAliveS * HUB.keepAliveGrace * 1000;
      Object.values(this.devices).forEach((d) => {
        if (d.conn === 'Connected' && this.sim.t - d.lastActivity > grace) {
          d.conn = 'Disconnected'; d.connSince = this.sim.t;
          this.sim.log('HUB', 'warn', `${d.id}: no MQTT traffic for ${grace / 1000} s (1.5 × keep-alive) — session closed`);
          this._eventGrid('Microsoft.Devices.DeviceDisconnected', d.id);
        }
      });
    }

    _eventGrid(type, id) {
      const at = this.sim.now();
      this.sim.packet({ hops: ['hub', 'eventgrid'], kind: 'event', label: '', dur: 300 });
      this.sim.schedule(this._r(CLOUD.eventGrid), () => {
        this.eventGrid.unshift({ t: this.sim.now(), type, id, eventTime: at });
        this.sim.packet({ hops: ['eventgrid', 'fnConn'], kind: 'event', label: '', dur: 120 });
        const inv = this._invoke('ConnectionMonitor');
        this.sim.schedule(inv.ms, () => {
          const offline = type.endsWith('Disconnected');
          this.dash[id] = { ...this.dash[id], conn: offline ? 'offline' : 'online', since: this.sim.t };
          this.sim.packet({ hops: ['fnConn', 'signalr', 'dash'], kind: 'event', label: '', dur: 200 });
          this.sim.log('FUNC', offline ? 'warn' : 'info', `ConnectionMonitor: ${type.split('.').pop()} ${id}${inv.cold ? ' (cold start ' + Math.round(inv.ms) + ' ms)' : ''}`);
          if (offline) {
            this.sim.metrics.cloudOfflineDetected(id);
            if (id === DEFAULTS.deviceId) this._notify('warning', `${id} offline`, `Site lost cloud connectivity. Edge device keeps sampling, alarming locally and buffering — data will back-fill on reconnect.`, null);
          }
          this.sim.bus.emit('cloud:conn', { id, offline });
        });
      });
    }

    _invoke(name) {
      const f = this.fn[name];
      const cold = this.sim.t - f.last > CLOUD.fnIdleColdMs;
      const ms = this._r(cold ? CLOUD.fnCold : CLOUD.fnWarm);
      f.inv++; if (cold) f.cold++;
      f.last = this.sim.t + ms; f.totalMs += ms; f.maxMs = Math.max(f.maxMs, ms);
      return { ms, cold };
    }

    // ---- device-to-cloud ingestion --------------------------------------------
    receive(id, msg, ack) {
      const d = this.devices[id];
      if (d.conn !== 'Connected') { ack(false); return; }     // publish on a session the hub already closed
      d.lastActivity = this.sim.t;
      d.d2c++; d.bytes += msg.payloadBytes;
      this.quota.msgs++;
      this.quota.units += Math.ceil(msg.payloadBytes / HUB.meterBytes);
      this.quota.bytes += msg.payloadBytes;
      const enq = this.sim.now();
      const mk = Math.floor(enq / 60000) * 60000;
      this.d2cPerMin.set(mk, (this.d2cPerMin.get(mk) || 0) + 1);
      const rec = {
        enqueuedTime: enq, deviceId: id, kind: msg.kind, topic: msg.topic, size: msg.payloadBytes,
        properties: msg.props,
        systemProperties: { 'iothub-connection-device-id': id, 'iothub-connection-auth-method': '{"scope":"device","type":"sas"}', 'iothub-enqueuedtime': fmt.iso(enq), 'message-id': msg.msgId, 'content-type': 'application/json', 'content-encoding': 'utf-8' },
        body: msg.body,
      };
      this.monitor.unshift(rec);
      if (this.monitor.length > 250) this.monitor.length = 250;
      this.sim.bus.emit('cloud:message', rec);
      this.sim.schedule(this._r(CLOUD.hubIngest), () => {
        ack(true);
        this._route(id, msg, enq);
      });
    }

    _route(id, msg, enq) {
      const sim = this.sim;
      if (msg.props.alert === 'true') {
        this.routes['alerts-route']++;
        const sb = this._r(CLOUD.serviceBus);
        sim.packet({ hops: ['hub', 'sb'], kind: 'alert', label: '!', dur: sb });
        sim.log('ROUTE', 'alarm', `alerts-route matched (alert = 'true') → Service Bus cold-alerts: ${msg.body.alarm} ${msg.body.state} from ${id}`);
        sim.schedule(sb, () => this._alertProcessor(id, msg.body, enq));
        return;
      }
      this.routes['telemetry-route']++;
      const inv = this._invoke('TelemetryIngest');
      sim.packet({ hops: ['hub', 'fnIngest'], kind: msg.kind, label: msg.kind === 'batch' ? `×${msg.body.count}` : '', dur: inv.ms });
      sim.schedule(inv.ms, () => this._ingest(id, msg, enq, inv));
      const asaMs = this._r(CLOUD.asa);
      sim.packet({ hops: ['hub', 'asa'], kind: msg.kind, label: '', dur: Math.min(asaMs, 900) });
      sim.schedule(asaMs, () => this._asa(id, msg));
    }

    _rows(msg) {
      const b = msg.body;
      if (b.type === 'telemetry') return [{ seq: b.seq, ts: Date.parse(b.ts), tempC: b.tempC, rh: b.rh, door: b.door, status: b.status }];
      if (b.type === 'batch') return b.readings.map((r) => ({ seq: r.q, ts: Date.parse(r.ts), tempC: r.t, rh: r.h, door: r.d ? 'open' : 'closed', status: r.s }));
      return [];
    }

    _ingest(id, msg, enq, inv) {
      const sim = this.sim, store = this.telemetry[id];
      const cw = this._r(CLOUD.cosmosWrite);
      sim.packet({ hops: ['fnIngest', 'cosmos'], kind: msg.kind, label: '', dur: cw });
      const now = sim.now();
      let fresh = 0, dupes = 0;
      this._rows(msg).forEach((r) => {
        const key = `${id}-${r.seq}`;
        if (store.keys.has(key)) { dupes++; store.dupes++; sim.metrics.duplicate(id); return; }   // Cosmos upsert on the same id
        store.keys.add(key);
        const doc = { id: key, deviceId: id, ...r, receivedAt: now, delayMs: now - r.ts, backfilled: msg.kind === 'batch', k: ++this.docK };
        this._insertSorted(store.docs, doc);
        this.docLog.push(doc);
        sim.metrics.delivered(id, r.seq, now);
        fresh++;
      });
      if (msg.kind === 'batch') {
        sim.log('FUNC', 'info', `TelemetryIngest: batch #${msg.body.batchId} from ${id} → ${fresh} readings back-filled into Cosmos${dupes ? `, ${dupes} duplicates discarded` : ''}`);
      } else if (dupes) {
        sim.log('COSMOS', 'warn', `duplicate ${id} seq ${msg.body.seq} (PUBACK was lost, device re-sent) — upsert, no double count`);
      }
      if (inv.cold) sim.log('FUNC', 'warn', `TelemetryIngest cold start: ${Math.round(inv.ms)} ms`);
      if (msg.kind === 'telemetry' && fresh) {
        const sr = this._r(CLOUD.signalR);
        sim.schedule(cw + sr, () => {
          const last = store.docs[store.docs.length - 1];
          this.dash[id] = { ...this.dash[id], last, lastPush: sim.now() };
          if (this.dash[id].conn !== 'online') this.dash[id] = { ...this.dash[id], conn: 'online', since: sim.t };
          this.liveLatency.push(sim.now() - Date.parse(msg.body.ts));
          if (this.liveLatency.length > 2000) this.liveLatency.shift();
          sim.metrics.liveLatency(id, sim.now() - msg.sentAt);
          if (id === DEFAULTS.deviceId) sim.packet({ hops: ['fnIngest', 'signalr', 'dash'], kind: 'telemetry', label: '', dur: sr });
          sim.bus.emit('dash:telemetry', { id, doc: last });
        });
      } else if (fresh) {
        sim.schedule(cw, () => sim.bus.emit('dash:backfill', { id, count: fresh }));
      }
    }

    _insertSorted(arr, doc) {
      if (!arr.length || arr[arr.length - 1].ts <= doc.ts) { arr.push(doc); return; }
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].ts <= doc.ts) lo = mid + 1; else hi = mid; }
      arr.splice(lo, 0, doc);
    }

    // ---- Stream Analytics ---------------------------------------------------------
    _asa(id, msg) {
      const sim = this.sim;
      const rows = this._rows(msg);
      this.asa.events += rows.length;
      const buckets = (this.agg[id] = this.agg[id] || new Map());
      rows.forEach((r) => {
        const k = Math.floor(r.ts / 60000) * 60000;
        const b = buckets.get(k) || { start: k, n: 0, sumT: 0, minT: Infinity, maxT: -Infinity, sumH: 0, inRange: 0, backfilled: 0 };
        b.n++; b.sumT += r.tempC ?? 0; b.minT = Math.min(b.minT, r.tempC ?? Infinity); b.maxT = Math.max(b.maxT, r.tempC ?? -Infinity); b.sumH += r.rh ?? 0;
        const th = sim.edge.th;
        if (r.tempC != null && r.tempC >= th.tMin && r.tempC <= th.tMax) b.inRange++;
        if (msg.kind === 'batch') b.backfilled++;
        buckets.set(k, b);
        this.asa.lastWindow = k;
      });
      sim.packet({ hops: ['asa', 'cosmos'], kind: 'agg', label: '', dur: 200 });
      if (id === DEFAULTS.baselineId) rows.forEach((r) => this._cloudRule(id, r));
    }

    /* Cloud-only alarm logic for the baseline node — same limits, same 2-sample
     * confirmation and hysteresis as the edge, but evaluated only on readings
     * that actually reached Azure. */
    _cloudRule(id, r) {
      const th = this.sim.edge.th;
      const R = (this.asa.rules[id] = this.asa.rules[id] || {});
      const chk = [
        ['HIGH_TEMP', r.tempC, r.tempC != null && r.tempC > th.tMax, r.tempC != null && r.tempC <= th.tMax - th.tempHystC, th.tMax, 'critical'],
        ['LOW_TEMP', r.tempC, r.tempC != null && r.tempC < th.tMin, r.tempC != null && r.tempC >= th.tMin + th.tempHystC, th.tMin, 'critical'],
        ['HIGH_RH', r.rh, r.rh != null && r.rh > th.hMax, r.rh != null && r.rh <= th.hMax - th.rhHystPct, th.hMax, 'warning'],
        ['LOW_RH', r.rh, r.rh != null && r.rh < th.hMin, r.rh != null && r.rh >= th.hMin + th.rhHystPct, th.hMin, 'warning'],
      ];
      chk.forEach(([name, v, out, clear, limit, sev]) => {
        const s = (R[name] = R[name] || { n: 0, first: null, lastTs: 0, active: false, id: null });
        if (!s.active) {
          if (out) {
            if (s.n === 0 || r.ts - s.lastTs > 15000) { s.n = 0; s.first = r.ts; }
            s.n++; s.lastTs = r.ts;
            if (s.n >= th.alarmDelaySamples) {
              s.active = true; s.id = `ASA-${String(++this.asa.outputs).padStart(4, '0')}`;
              this._asaAlert(id, { alertId: s.id, alarm: name, state: 'RAISED', severity: sev, value: v, threshold: limit, firstBreachAt: fmt.iso(s.first) });
            }
          } else s.n = 0;
        } else if (clear) {
          this._asaAlert(id, { alertId: s.id, alarm: name, state: 'CLEARED', severity: sev, value: v, threshold: limit, firstBreachAt: fmt.iso(s.first) });
          s.active = false; s.n = 0;
        }
      });
    }

    _asaAlert(id, a) {
      const sim = this.sim, now = sim.now();
      const body = { type: 'alert', deviceId: id, ...a, raisedAt: fmt.iso(now), localActionAt: null, localActions: [], bufferedMs: 0, source: 'StreamAnalytics' };
      sim.log('ASA', a.state === 'RAISED' ? 'alarm' : 'info', `cloud rule fired for ${id}: ${a.alarm} ${a.state} (value ${a.value}) → cloudalerts output`);
      const sb = this._r(CLOUD.serviceBus);
      sim.packet({ hops: ['asa', 'sb'], kind: 'alert', label: '!', dur: sb });
      sim.schedule(sb, () => this._alertProcessor(id, body, now));
    }

    // ---- alerts -------------------------------------------------------------------
    _alertProcessor(id, a, enq) {
      const sim = this.sim;
      const inv = this._invoke('AlertProcessor');
      sim.packet({ hops: ['sb', 'fnAlert'], kind: 'alert', label: '!', dur: inv.ms });
      sim.schedule(inv.ms, () => {
        const key = `${id}-${a.alertId}-${a.state}`;
        if (this.alertKeys.has(key)) { sim.log('FUNC', 'warn', `AlertProcessor: duplicate ${a.alertId} ${a.state} ignored (idempotent)`); return; }
        this.alertKeys.add(key);
        const now = sim.now(), first = Date.parse(a.firstBreachAt);
        const doc = {
          ...a, deviceId: id, enqueuedAt: enq, processedAt: now, coldStart: inv.cold, fnMs: inv.ms,
          latency: { localAlarmMs: a.localActionAt ? Date.parse(a.localActionAt) - first : null, cloudMs: now - first, bufferedMs: a.bufferedMs || 0 },
          deliveredLate: (a.bufferedMs || 0) > 30000, notifiedAt: null, dashboardAt: null,
        };
        const cw = this._r(CLOUD.cosmosWrite);
        sim.packet({ hops: ['fnAlert', 'cosmos'], kind: 'alert', label: '', dur: cw });
        sim.log('FUNC', a.state === 'RAISED' ? 'alarm' : 'info',
          `AlertProcessor${inv.cold ? ' (cold start ' + Math.round(inv.ms) + ' ms)' : ''}: ${a.alertId} ${a.alarm} ${a.state} from ${id}` +
          (doc.deliveredLate ? ` — arrived ${fmt.dur(a.bufferedMs)} late (buffered while offline)` : ''));
        if (a.state === 'CLEARED') {
          const raised = this.alerts.find((x) => x.deviceId === id && x.alertId === a.alertId && x.state === 'RAISED');
          if (raised) { raised.clearedAt = Date.parse(a.raisedAt); raised.clearedValue = a.value; }
          doc.notifiedAt = now;
        } else {
          // queued RAISED + CLEARED can be processed out of order (parallel function instances)
          const cleared = this.alerts.find((x) => x.deviceId === id && x.alertId === a.alertId && x.state === 'CLEARED');
          if (cleared) { doc.clearedAt = Date.parse(cleared.raisedAt); doc.clearedValue = cleared.value; }
        }
        this.alerts.unshift(doc);
        const sr = this._r(CLOUD.signalR);
        sim.schedule(cw + sr, () => {
          doc.dashboardAt = sim.now();
          sim.packet({ hops: ['fnAlert', 'signalr', 'dash'], kind: 'alert', label: '!', dur: sr });
          sim.bus.emit('dash:alert', doc);
        });
        if (a.state === 'RAISED') {
          const title = `[${a.severity.toUpperCase()}] ${LABEL[a.alarm]} — ${id}`;
          const text = `${a.alarm}: ${a.value} vs limit ${a.threshold}. ` + (a.localActionAt ? `Local buzzer active since ${fmt.time(Date.parse(a.localActionAt))}.` : 'No local alarm on this node.') +
            (doc.deliveredLate ? ` Delivered ${fmt.dur(a.bufferedMs)} late — site was offline.` : '');
          this._notify(a.severity, title, text, doc, cw);
        }
      });
    }

    _notify(severity, title, text, doc, after = 0) {
      const sim = this.sim;
      const ms = this._r(CLOUD.logicApp);
      sim.packet({ hops: [doc ? 'fnAlert' : 'fnConn', 'logic'], kind: 'notify', label: '', dur: after + 150 });
      sim.schedule(after + ms, () => {
        const n = { t: sim.now(), severity, title, text, alertId: doc && doc.alertId, deviceId: doc && doc.deviceId, channels: severity === 'critical' ? ['SMS', 'E-mail', 'Teams'] : ['E-mail', 'Teams'] };
        this.notifications.unshift(n);
        if (this.notifications.length > 200) this.notifications.length = 200;
        sim.packet({ hops: ['logic', 'operator'], kind: 'notify', label: '', dur: 250 });
        if (doc) {
          doc.notifiedAt = n.t;
          doc.latency.notifyMs = n.t - Date.parse(doc.firstBreachAt);
          sim.metrics.cloudAlert(doc.deviceId, doc);
        }
        sim.log('NOTIFY', severity === 'critical' ? 'alarm' : 'info', `${n.channels.join(' + ')} sent: ${title}`);
        sim.bus.emit('cloud:notify', n);
      });
    }

    // ---- twin + direct methods -----------------------------------------------------
    updateDesired(id, patch) {
      const d = this.devices[id], sim = this.sim;
      const des = d.twin.desired;
      Object.entries(patch).forEach(([k, v]) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) des[k] = { ...(des[k] || {}), ...v };
        else des[k] = v;
      });
      des.$version++;
      this.routes['twin-route']++;
      this.twinLog.unshift({ t: sim.now(), side: 'desired', version: des.$version, patch });
      sim.log('HUB', 'info', `twin desired → v${des.$version} for ${id}: ${JSON.stringify(patch)}` + (d.conn === 'Connected' ? ' (pushing to device)' : ' (device offline — will be fetched on reconnect)'));
      if (d.conn === 'Connected' && id === DEFAULTS.deviceId) {
        const dev = sim.edge;
        sim.link.send('down', CS.util.jsonSize(patch) + 150, { hops: dev.downHops, kind: 'c2d', label: '' }, () => {
          if (dev.connected) dev.applyDesired(clone(des), 'desired-property PATCH');
        });
      }
    }

    reportedPatch(id, patch) {
      const d = this.devices[id];
      d.lastActivity = this.sim.t;
      Object.assign(d.twin.reported, clone(patch));
      d.twin.reported.$version++;
      d.twin.reported.$lastUpdated = fmt.iso(this.sim.now());
      this.twinLog.unshift({ t: this.sim.now(), side: 'reported', version: d.twin.reported.$version, patch });
      if (this.twinLog.length > 100) this.twinLog.length = 100;
      this.sim.packet({ hops: ['hub', 'signalr', 'dash'], kind: 'twin', label: '', dur: 150 });
    }

    invokeMethod(id, name, payload, cb) {
      const sim = this.sim, d = this.devices[id], t0 = sim.now();
      const rec = { t: t0, id, name, payload, status: null, result: null, latencyMs: null };
      this.methods.unshift(rec);
      const done = (status, result) => {
        if (rec.status != null) return;
        rec.status = status; rec.result = result; rec.latencyMs = sim.now() - t0;
        sim.log('HUB', status === 200 ? 'ok' : 'error', `direct method ${name} on ${id} → ${status} in ${fmt.dur(rec.latencyMs)}`);
        cb && cb(rec);
        sim.bus.emit('cloud:method', rec);
      };
      if (d.conn !== 'Connected' || id !== DEFAULTS.deviceId) {
        sim.schedule(30, () => done(404, { errorCode: 404103, message: `DeviceNotOnline: Timed out waiting for device ${id} to connect.` }));
        return;
      }
      const dev = sim.edge;
      sim.schedule(30000, () => done(504, { errorCode: 504101, message: 'GatewayTimeout: device did not respond in 30 s' }));
      sim.link.send('down', 220, { hops: dev.downHops, kind: 'c2d', label: '' }, () => {
        if (!dev.connected || dev.power !== 'ON') return;
        const res = dev.handleMethod(name, payload || {});
        sim.link.send('up', CS.util.jsonSize(res.payload) + 150, { hops: dev.upHops, kind: 'c2d', label: '' }, () => done(res.status, res.payload));
      });
    }

    // ---- query helpers for the dashboard ------------------------------------------------
    docs(id, fromMs = -Infinity) {
      const a = this.telemetry[id].docs;
      if (fromMs === -Infinity) return a;
      let lo = 0, hi = a.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].ts < fromMs) lo = m + 1; else hi = m; }
      return a.slice(lo);
    }

    aggregates(id, n = 15) {
      const m = this.agg[id];
      if (!m) return [];
      return [...m.values()].sort((a, b) => b.start - a.start).slice(0, n);
    }
  }

  CS.AzureCloud = AzureCloud;
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
