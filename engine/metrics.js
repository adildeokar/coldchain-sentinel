/* Measurement layer. Nothing here influences the simulation — it only watches.
 *
 * Data loss     : every reading gets (device, seq, link state when taken). A reading
 *                 counts as delivered the first time Cosmos DB stores it.
 * Alert response: a reference observer runs the same rule on the same sensor frames
 *                 and opens an "episode" at the first out-of-range sample. For each
 *                 episode we record when the Pi's buzzer went on, when the operator
 *                 got the SMS for the edge alert, and when the baseline's cloud rule
 *                 got its SMS out — all measured from the same instant. */
(function (CS) {
  'use strict';
  const { mean, pctile } = CS.util;
  const { fuse, CRITICAL } = CS.rules;

  const blank = () => ({
    gen: { connected: 0, disconnected: 0 }, del: { connected: 0, disconnected: 0 },
    delay: { connected: [], disconnected: [] }, dupes: 0, dropped: 0, info: new Map(), delivered: new Set(), live: [],
  });

  class Metrics {
    constructor(sim) {
      this.sim = sim;
      this.d = { edge: blank(), base: blank() };
      this.episodes = [];
      this.pendingEp = {};
      this.outages = [];
      this.syncs = [];
      this.reboots = [];
      this.epN = 0;
    }

    k(id) { return id === CS.config.DEFAULTS.deviceId || id === 'edge' ? 'edge' : 'base'; }

    generated(k, seq, cond, ts) { const d = this.d[k]; d.gen[cond]++; d.info.set(seq, { cond, ts }); }
    dropped(k) { this.d[k].dropped++; }
    duplicate(id) { this.d[this.k(id)].dupes++; }
    liveLatency(id, ms) { const a = this.d[this.k(id)].live; a.push(ms); if (a.length > 3000) a.shift(); }

    delivered(id, seq, at) {
      const d = this.d[this.k(id)];
      const info = d.info.get(seq);
      if (!info || d.delivered.has(seq)) return;
      d.delivered.add(seq);
      d.del[info.cond]++;
      d.delay[info.cond].push(at - info.ts);
    }

    linkChange(up) {
      if (!up) this.outages.push({ start: this.sim.t, end: null, cloudDetectedT: null, edgeDetectedT: null });
      else { const o = this.outages[this.outages.length - 1]; if (o && o.end == null) o.end = this.sim.t; }
    }

    edgeLostDetected() {
      const o = this.outages[this.outages.length - 1];
      if (o && o.edgeDetectedT == null && (o.end == null || o.end >= this.sim.t - 1)) o.edgeDetectedT = this.sim.t;
    }

    cloudOfflineDetected(id) {
      if (this.k(id) !== 'edge') return;
      const o = this.outages[this.outages.length - 1];
      if (o && o.cloudDetectedT == null) o.cloudDetectedT = this.sim.t;
    }

    syncDone(s) { this.syncs.push({ ...s }); }
    rebootStart() { this.reboots.push({ start: this.sim.t, end: null }); }
    rebootEnd() { const r = this.reboots[this.reboots.length - 1]; if (r) r.end = this.sim.t; }

    // ---- reference observer ---------------------------------------------------
    observe(f) {
      const th = this.sim.edge.th, delay = th.alarmDelaySamples;
      const t = fuse(f.ds18b20C, f.dht22C), h = f.rh;
      const checks = [
        ['HIGH_TEMP', t, t != null && t > th.tMax, t != null && t <= th.tMax - th.tempHystC],
        ['LOW_TEMP', t, t != null && t < th.tMin, t != null && t >= th.tMin + th.tempHystC],
        ['HIGH_RH', h, h != null && h > th.hMax, h != null && h <= th.hMax - th.rhHystPct],
        ['LOW_RH', h, h != null && h < th.hMin, h != null && h >= th.hMin + th.rhHystPct],
      ];
      checks.forEach(([type, v, out, clear]) => {
        let ep = this.pendingEp[type];
        if (!ep) {
          if (!out) return;
          ep = this.pendingEp[type] = { id: ++this.epN, type, start: f.ts, startT: f.t, cond: this.sim.link.up ? 'connected' : 'disconnected',
            n: 0, qualified: false, end: null, peak: v, critical: CRITICAL.has(type),
            edgeLocalAt: null, edgeCloudAt: null, edgeDashAt: null, baseCloudAt: null, edgeUp: this.sim.edge.power === 'ON' };
        }
        if (!ep.qualified) {
          if (out) { ep.n++; if (ep.n >= delay) { ep.qualified = true; this.episodes.push(ep); } }
          else { delete this.pendingEp[type]; }       // filtered as a spike — the edge does the same
          return;
        }
        if (v != null) ep.peak = type.startsWith('HIGH') ? Math.max(ep.peak, v) : Math.min(ep.peak, v);
        if (clear) { ep.end = f.ts; delete this.pendingEp[type]; }
      });
    }

    _match(type, first) {
      let best = null;
      const tol = this.sim.edge.cfg.sampleIntervalS * 500;
      this.episodes.forEach((ep) => {
        if (ep.type !== type || ep.start > first + tol) return;
        if (ep.end != null && first > ep.end + tol) return;
        if (!best || ep.start > best.start) best = ep;
      });
      return best;
    }

    edgeLocalAlert(e) {
      const ep = this._match(e.alarm, e.firstBreachAt);
      if (ep && ep.edgeLocalAt == null) ep.edgeLocalAt = e.localActionAt;
    }

    cloudAlert(id, doc) {
      if (doc.state !== 'RAISED') return;
      const ep = this._match(doc.alarm, Date.parse(doc.firstBreachAt));
      if (!ep) return;
      if (this.k(id) === 'edge') { if (ep.edgeCloudAt == null) { ep.edgeCloudAt = doc.notifiedAt; ep.edgeDashAt = doc.dashboardAt; } }
      else if (ep.baseCloudAt == null) ep.baseCloudAt = doc.notifiedAt;
    }

    // ---- summary ------------------------------------------------------------------
    stats(arr) { return { n: arr.length, mean: mean(arr), p50: pctile(arr, 0.5), p95: pctile(arr, 0.95), max: arr.length ? Math.max(...arr) : null, min: arr.length ? Math.min(...arr) : null }; }

    summary() {
      const sim = this.sim, now = sim.now();
      const dev = {};
      ['edge', 'base'].forEach((k) => {
        const d = this.d[k];
        const pending = k === 'edge' ? sim.edge.store.depth : 0;
        const inflight = k === 'edge' ? 0 : sim.baseline.inflight.size;
        const out = { pending };
        ['connected', 'disconnected'].forEach((c) => {
          out[c] = { gen: d.gen[c], del: d.del[c], delay: this.stats(d.delay[c]) };
        });
        out.gen = d.gen.connected + d.gen.disconnected;
        out.del = d.del.connected + d.del.disconnected;
        // readings still waiting on the Pi are not lost; the baseline has nowhere to keep them
        let pendC = 0, pendD = 0;
        if (k === 'edge') sim.edge.store.pending.forEach((r) => (r.cond === 'connected' ? pendC++ : pendD++));
        out.connected.pending = pendC; out.disconnected.pending = pendD;
        out.connected.lost = Math.max(0, d.gen.connected - d.del.connected - pendC - (k === 'base' ? inflight : 0));
        out.disconnected.lost = Math.max(0, d.gen.disconnected - d.del.disconnected - pendD);
        out.lost = out.connected.lost + out.disconnected.lost;
        out.dupes = d.dupes;
        out.dropped = d.dropped;
        out.live = this.stats(d.live);
        dev[k] = out;
      });

      const resp = {};
      ['connected', 'disconnected'].forEach((c) => {
        const eps = this.episodes.filter((e) => e.cond === c);
        const settled = (e, at) => at != null || (e.end != null && now - e.end > 120000);
        resp[c] = {
          episodes: eps.length,
          edgeLocal: this.stats(eps.filter((e) => e.edgeLocalAt != null).map((e) => e.edgeLocalAt - e.start)),
          edgeCloud: this.stats(eps.filter((e) => e.edgeCloudAt != null).map((e) => e.edgeCloudAt - e.start)),
          baseCloud: this.stats(eps.filter((e) => e.baseCloudAt != null).map((e) => e.baseCloudAt - e.start)),
          edgeMissed: eps.filter((e) => e.edgeCloudAt == null && settled(e, null)).length,
          baseMissed: eps.filter((e) => e.baseCloudAt == null && settled(e, null)).length,
          localMissed: eps.filter((e) => e.edgeLocalAt == null && settled(e, null)).length,
        };
      });

      const e = sim.edge, b = sim.baseline;
      const hours = Math.max(sim.t / 3600000, 1 / 3600);
      const bw = (m) => ({
        up: m.stats.wireUp, down: m.stats.wireDown, total: m.stats.wireUp + m.stats.wireDown, payload: m.stats.payloadBytes,
        tls: m.stats.tlsBytes, msgs: m.stats.msgs, perHour: (m.stats.wireUp + m.stats.wireDown) / hours,
        securityPct: (m.stats.tlsBytes) / Math.max(1, m.stats.wireUp + m.stats.wireDown),
        handshakes: m.stats.handshakes, reconnects: m.stats.reconnects, timeouts: m.stats.timeouts,
      });
      return {
        simMs: sim.t, dev, resp,
        bw: { edge: bw(e), base: bw(b) },
        batching: { rows: e.bstats.batchedRows, batches: e.bstats.batches, wire: e.bstats.batchWire, equiv: e.bstats.equivWire,
          saving: e.bstats.equivWire ? 1 - e.bstats.batchWire / e.bstats.equivWire : null },
        syncs: this.syncs, outages: this.outages, reboots: this.reboots,
        episodes: this.episodes,
        hub: { ...sim.cloud.quota },
        edgeRes: { ...e.res, dbBytes: e.store.dbBytes(), peakQueue: Math.max(e.store.peak, ...this.syncs.map((s) => s.backlog || 0), 0), dropped: e.store.dropped },
      };
    }
  }

  CS.Metrics = Metrics;
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
