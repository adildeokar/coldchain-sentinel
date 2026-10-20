/* Browser-side mirror of the server's simulation.
 *
 * The server streams state over Server-Sent Events (/api/stream). RemoteSim
 * keeps a read-only copy with the same shape the views use (sim.edge.last,
 * sim.cloud.alerts, …), and turns every user action into an HTTP call back to
 * the server. Nothing is simulated in the browser. */
(function (CS) {
  'use strict';

  const api = {
    async get(path) { const r = await fetch(path); if (!r.ok) throw new Error((await r.json()).error || r.statusText); return r.json(); },
    async post(path, body) {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      return data;
    },
  };

  const ACTIONS = ['openDoor', 'closeDoor', 'toggleDoor', 'failCompressor', 'repairCompressor', 'setThermostatStuck', 'humiditySurge', 'sensorFault',
    'ds18b20Glitch', 'networkOutage', 'restoreNetwork', 'degradeNetwork', 'sitePowerFail', 'restorePower', 'rebootPi', 'pressAck'];

  function lowerBound(a, ts) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].ts < ts) lo = m + 1; else hi = m; } return lo; }

  class RemoteSim {
    constructor() {
      this.opts = { baseline: true };
      this.ready = false;
      this.clear();
      ACTIONS.forEach((name) => { this[name] = (...args) => this.act(name, args); });
    }

    clear() {
      const self = this;
      this.t = 0; this.startEpoch = Date.now(); this.speed = 5; this.playing = true; this.recvAt = performance.now();
      this.logs = [];
      this.room = {}; this.ups = { pct: 100, onBattery: false }; this.sensors = {};
      this._link = { params: {}, stats: {} };
      this.link = { get up() { return self._link.up; }, get mode() { return self._link.mode; }, get state() { return self._link.state; }, get routerPowered() { return self._link.routerPowered; }, params: () => self._link.params, get stats() { return self._link.stats; } };
      this._outages = [];
      this._store = {};
      this.edge = {
        history: [], termLines: [], last: null, th: { tMin: 2, tMax: 8, hMin: 35, hMax: 75 }, cfg: { profile: 'pharma', sampleIntervalS: 5 }, out: {}, lcd: ['', ''], gpio: {}, res: { cpu: 0, ramMb: 0, cpuTempC: 0, uptimeS: 0 },
        store: {
          get depth() { return self._store.depth || 0; }, get capacity() { return self._store.capacity; }, get dropped() { return self._store.dropped || 0; },
          get sentRows() { return self._store.sentRows || 0; }, get written() { return self._store.written || 0; }, get pending() { return self._store.tail || []; },
          get alerts() { return { length: self._store.alertsQueued || 0 }; }, dbBytes: () => self._store.dbBytes || 0,
          backlogCount: (since) => (since != null && self.now() - since > 9000 ? self._store.backlog10 : self._store.backlog) || 0,
        },
        engine: { active: () => self.edge.activeAlarms || [] },
        inflight: { size: 0 },
      };
      this.baseline = { stats2: { sent: 0, droppedOffline: 0, droppedTimeout: 0 }, inflight: { size: 0 } };
      this._summary = null;
      const telemetry = {};
      this.cloud = {
        devices: {}, alerts: [], notifications: [], eventGrid: [], methods: [], twinLog: [], monitor: [], fn: {}, routes: {}, quota: { msgs: 0, units: 0, bytes: 0 },
        asa: { events: 0, outputs: 0 }, dash: {}, d2cPerMin: new Map(), telemetry, liveLatencyMean: null, liveLatencyN: 0, aggCount: 0, _agg: [],
        docs(id, from = -Infinity) { const a = (telemetry[id] || { docs: [] }).docs; return from === -Infinity ? a : a.slice(lowerBound(a, from)); },
        aggregates(id, n = 15) { return self.cloud._agg.slice(0, n); },
        updateDesired: (id, patch) => api.post('/api/twin', { deviceId: id, patch }).catch((e) => CS.dom.toast('Twin update failed', e.message, 'err')),
        invokeMethod: (id, name, payload, cb) => api.post('/api/method', { deviceId: id, name, payload }).then((r) => cb && cb(r)).catch((e) => CS.dom.toast('Method failed', e.message, 'err')),
      };
      this.metrics = { summary: () => self._summary || emptySummary(), get episodes() { return (self._summary || { episodes: [] }).episodes; } };
    }

    // ---- apply a server snapshot ------------------------------------------------
    apply(s) {
      this.ready = true;
      this.t = s.t; this.startEpoch = s.startEpoch; this.speed = s.speed; this.playing = s.playing; this.seed = s.seed; this.profile = s.profile; this.clients = s.clients;
      this.recvAt = performance.now();
      this.room = s.room; this.ups = s.ups; this.sensors = s.sensors; this._link = s.link; this._outages = s.outages;
      const e = this.edge, se = s.edge;
      ['id', 'power', 'state', 'connected', 'cfg', 'th', 'out', 'lcd', 'gpio', 'last', 'res', 'sampleCount', 'activeAlarms', 'sync', 'bstats'].forEach((k) => (e[k] = se[k]));
      e.inflight = { size: se.inflight };
      this._store = se.store;
      Object.assign(this.baseline, s.baseline, { inflight: { size: s.baseline.inflight } });
      const c = this.cloud, sc = s.cloud;
      Object.assign(c, { quota: sc.quota, routes: sc.routes, asa: sc.asa, fn: sc.fn, dash: sc.dash, liveLatencyMean: sc.liveLatencyMean, liveLatencyN: sc.liveLatencyN, aggCount: sc.aggCount });
      Object.entries(sc.dupes).forEach(([id, n]) => { (c.telemetry[id] = c.telemetry[id] || { docs: [], dupes: 0 }).dupes = n; });
      ['devices', 'alerts', 'notifications', 'eventGrid', 'methods', 'twinLog', 'monitor'].forEach((k) => { if (s[k]) c[k] = s[k]; });
      if (s.d2cPerMin) c.d2cPerMin = new Map(s.d2cPerMin);
      if (s.agg) c._agg = s.agg;
      if (s.summary) this._summary = s.summary;
      if (s.lastMsg) this.lastMsg = s.lastMsg;
      // append-only streams
      if (s.newLogs.length) { this.logs.push(...s.newLogs); if (this.logs.length > 3000) this.logs.splice(0, this.logs.length - 3000); }
      if (s.newTerm.length) { e.termLines.push(...s.newTerm); if (e.termLines.length > 600) e.termLines.splice(0, e.termLines.length - 600); }
      if (s.newHistory.length) { e.history.push(...s.newHistory); if (e.history.length > 40000) e.history.splice(0, 5000); }
      s.newDocs.forEach((d) => {
        const st = (c.telemetry[d.deviceId] = c.telemetry[d.deviceId] || { docs: [], dupes: 0 });
        const a = st.docs;
        if (!a.length || a[a.length - 1].ts <= d.ts) a.push(d); else a.splice(lowerBound(a, d.ts + 0.5), 0, d);
      });
    }

    // simulated clock, interpolated between snapshots so the header clock runs smoothly
    get tNow() { return this.t + (this.playing ? Math.min(400, performance.now() - this.recvAt) * this.speed : 0); }
    now() { return this.startEpoch + this.tNow; }
    outages() { return this._outages; }

    act(name, args) {
      return api.post('/api/action', { name, args }).catch((e) => CS.dom.toast(`Action ${name} failed`, e.message, 'err'));
    }
  }

  function emptySummary() {
    const st = { n: 0, mean: null };
    const dev = () => ({ gen: 0, del: 0, lost: 0, pending: 0, dupes: 0, dropped: 0, live: st, connected: { gen: 0, del: 0, lost: 0, pending: 0, delay: st }, disconnected: { gen: 0, del: 0, lost: 0, pending: 0, delay: st } });
    const resp = () => ({ episodes: 0, edgeLocal: st, edgeCloud: st, baseCloud: st, edgeMissed: 0, baseMissed: 0, localMissed: 0 });
    return { dev: { edge: dev(), base: dev() }, resp: { connected: resp(), disconnected: resp() }, bw: { edge: { total: 0, securityPct: 0 }, base: { total: 0, securityPct: 0 } }, syncs: [], outages: [], episodes: [] };
  }

  CS.api = api;
  CS.RemoteSim = RemoteSim;
})(window.CS = window.CS || {});
