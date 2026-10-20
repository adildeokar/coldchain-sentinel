/* Automated test suite — runs in the browser (Report → Testing) and in Node
 * (node tools/selftest.js). Unit tests mirror firmware/tests/*.py; integration
 * tests drive a headless simulation and assert on what reached the cloud. */
(function (CS) {
  'use strict';
  const { fmt } = CS.util;

  const TH = () => ({ tMin: 2, tMax: 8, hMin: 35, hMax: 75, tempHystC: 0.3, rhHystPct: 2, alarmDelaySamples: 2, warnMarginC: 0.5, doorOpenMaxS: 120, sensorDisagreeC: 1.5 });
  const R = (seq, t, h = 55, ds = t, dht = t) => ({ seq, ts: 1000 + seq * 5000, tempC: t, rh: h, ds18b20C: ds, dht22C: dht });

  function sim(opts = {}) {
    const s = new CS.Simulation({ seed: 7, headless: true, startEpoch: Date.UTC(2026, 9, 21, 4, 0, 0), ...opts });
    s.start();
    return s;
  }

  const TESTS = [
    // ---- unit: rule engine (firmware/tests/test_rules.py) ----
    ['U1', 'Unit', 'Single out-of-range sample is filtered (debounce)', () => {
      const e = new CS.rules.AlarmEngine(TH());
      const a = e.evaluate(R(1, 8.4), 0), b = e.evaluate(R(2, 7.0), 0);
      return [!a.length && !b.length && !e.active().includes('HIGH_TEMP'), 'spike 8.4 °C → no alarm'];
    }],
    ['U2', 'Unit', 'HIGH_TEMP raised on 2nd consecutive sample, firstBreachAt = 1st sample', () => {
      const e = new CS.rules.AlarmEngine(TH());
      e.evaluate(R(1, 8.3), 0);
      const ev = e.evaluate(R(2, 8.5), 0);
      return [ev.length === 1 && ev[0].alarm === 'HIGH_TEMP' && ev[0].firstBreachAt === 6000 && ev[0].raisedAt === 11000, `${ev.map((x) => x.alarm + ' ' + x.state)}`];
    }],
    ['U3', 'Unit', 'Hysteresis: clears only at limit − 0.3 °C', () => {
      const e = new CS.rules.AlarmEngine(TH());
      [8.3, 8.4, 7.9, 7.8].forEach((t, i) => e.evaluate(R(i + 1, t), 0));
      const still = e.active().includes('HIGH_TEMP');
      const ev = e.evaluate(R(5, 7.6), 0);
      return [still && ev[0] && ev[0].state === 'CLEARED', '7.9/7.8 keep alarm, 7.6 clears'];
    }],
    ['U4', 'Unit', 'Door open > 120 s raises DOOR_OPEN; closing clears it', () => {
      const e = new CS.rules.AlarmEngine(TH());
      const a = e.evaluate(R(1, 5), 60), b = e.evaluate(R(2, 5), 125), c = e.evaluate(R(3, 5), 0);
      return [!a.length && b[0].alarm === 'DOOR_OPEN' && c[0].state === 'CLEARED', 'open 60 s ok, 125 s alarm, closed clears'];
    }],
    ['U5', 'Unit', 'Probe failure falls back to DHT22; both failed → SENSOR_FAULT', () => {
      const e = new CS.rules.AlarmEngine(TH());
      const fb = CS.rules.fuse(null, 4.2) === 4.2 && CS.rules.fuse(4.0, 4.2) === 4.0;
      const r1 = { seq: 1, ts: 1, tempC: null, rh: null, ds18b20C: null, dht22C: null }, r2 = { ...r1, seq: 2, ts: 2 };
      e.evaluate(r1, 0);
      const ev = e.evaluate(r2, 0);
      return [fb && ev[0].alarm === 'SENSOR_FAULT' && r2.status === 'FAULT', 'fuse() + SENSOR_FAULT'];
    }],
    ['U6', 'Unit', 'SQLite queue capacity drops oldest pending rows', () => {
      const st = new CS.EdgeStore(5);
      for (let i = 1; i <= 8; i++) st.add({ seq: i, ts: i });
      return [st.depth === 5 && st.dropped === 3 && st.pending[0].seq === 4, `depth ${st.depth}, dropped ${st.dropped}`];
    }],
    // ---- integration ----
    ['I1', 'Integration', 'Connected excursion: local alarm < 7 s, operator SMS < 12 s', () => {
      const s = sim(); s.runScript([{ at: 120, do: 'failCompressor' }]); s.advance(900 * 1000);
      const ep = s.metrics.episodes.find((e) => e.type === 'HIGH_TEMP');
      const l = ep && ep.edgeLocalAt - ep.start, c = ep && ep.edgeCloudAt - ep.start;
      return [ep && l < 7000 && c < 12000, `local ${fmt.dur(l)}, cloud ${fmt.dur(c)}`];
    }],
    ['I2', 'Integration', '10-min outage: edge loses 0 readings, baseline loses the outage window', () => {
      const s = sim(); s.runScript([{ at: 60, do: 'networkOutage', args: [600] }]); s.advance(1200 * 1000);
      const m = s.metrics.summary();
      return [m.dev.edge.lost === 0 && m.dev.base.disconnected.lost >= 110 && m.syncs.length >= 1,
        `edge lost ${m.dev.edge.lost}, baseline lost ${m.dev.base.lost}, sync ${fmt.dur(m.syncs[0] && m.syncs[0].durationMs)}`];
    }],
    ['I3', 'Integration', 'Excursion during outage: buzzer fires offline, alert reaches cloud after reconnect', () => {
      const s = sim(); s.runScript([{ at: 60, do: 'networkOutage', args: [900] }, { at: 120, do: 'failCompressor' }, { at: 600, do: 'repairCompressor' }]);
      s.advance(1500 * 1000);
      const ep = s.metrics.episodes.find((e) => e.type === 'HIGH_TEMP');
      const doc = s.cloud.alerts.find((a) => a.deviceId === CS.config.DEFAULTS.deviceId && a.alarm === 'HIGH_TEMP' && a.state === 'RAISED');
      return [ep && ep.edgeLocalAt - ep.start < 7000 && doc && doc.deliveredLate && !ep.baseCloudAt,
        `local ${fmt.dur(ep && ep.edgeLocalAt - ep.start)}, cloud after ${fmt.dur(doc && doc.latency.cloudMs)}, baseline ${ep && ep.baseCloudAt ? 'alerted' : 'never alerted'}`];
    }],
    ['I4', 'Integration', 'Lossy link: retries create duplicates, Cosmos stores each reading once', () => {
      const s = sim(); s.degradeNetwork(); s.advance(1500 * 1000); s.restoreNetwork(); s.advance(120 * 1000);
      const id = CS.config.DEFAULTS.deviceId, st = s.cloud.telemetry[id];
      const seqs = st.docs.map((d) => d.seq), uniq = new Set(seqs).size;
      return [uniq === seqs.length && s.metrics.d.edge.dupes > 0 && s.metrics.summary().dev.edge.lost === 0, `${seqs.length} docs, ${s.metrics.d.edge.dupes} duplicates discarded, 0 lost`];
    }],
    ['I5', 'Integration', 'Pi reboot: SQLite queue survives, sequence numbers continue', () => {
      const s = sim(); s.runScript([{ at: 30, do: 'networkOutage', args: [300] }, { at: 120, do: 'rebootPi' }]); s.advance(600 * 1000);
      const docs = s.cloud.telemetry[CS.config.DEFAULTS.deviceId].docs.map((d) => d.seq).sort((a, b) => a - b);
      const contiguous = docs.every((q, i) => i === 0 || q === docs[i - 1] + 1);
      return [contiguous && s.metrics.summary().dev.edge.lost === 0, `${docs.length} readings #${docs[0]}–#${docs[docs.length - 1]}, no gaps`];
    }],
    ['I6', 'Integration', 'Twin desired change made while offline is applied on reconnect', () => {
      const s = sim(); s.advance(30000); s.networkOutage(200); s.advance(100000);
      s.cloud.updateDesired(CS.config.DEFAULTS.deviceId, { thresholds: { temp_max_c: 7 } });
      const before = s.edge.th.tMax; s.advance(200000);
      return [before === 8 && s.edge.th.tMax === 7, `tMax ${before} → ${s.edge.th.tMax}`];
    }],
    ['I7', 'Integration', 'Direct method to an offline device fails fast with 404103', () => {
      const s = sim(); s.advance(20000); let res = null;
      s.cloud.invokeMethod(CS.config.DEFAULTS.deviceId, 'getDiagnostics', {}, (r) => (res = r)); s.advance(5000);
      const ok = res && res.status === 200;
      s.networkOutage(); s.advance(150000);
      let res2 = null; s.cloud.invokeMethod(CS.config.DEFAULTS.deviceId, 'getDiagnostics', {}, (r) => (res2 = r)); s.advance(5000);
      return [ok && res2 && res2.status === 404, `online → ${res.status} in ${fmt.dur(res.latencyMs)}; offline → ${res2 && res2.status} ${res2 && res2.result.errorCode}`];
    }],
    ['I8', 'Integration', 'Buffer overflow is detected and counted (not silent)', () => {
      const s = sim({ edge: { bufferCapacity: 30 } }); s.networkOutage(400); s.advance(600000);
      const m = s.metrics.summary();
      return [m.dev.edge.dropped > 0 && m.dev.edge.lost === m.dev.edge.dropped, `${m.dev.edge.dropped} dropped = ${m.dev.edge.lost} lost`];
    }],
    ['I9', 'Integration', 'Cloud learns of the outage via keep-alive + Event Grid; edge detects it first', () => {
      const s = sim(); s.advance(30000); s.networkOutage(300); s.advance(400000);
      const o = s.metrics.outages[0];
      return [o.edgeDetectedT && o.cloudDetectedT && o.edgeDetectedT < o.cloudDetectedT,
        `edge after ${fmt.dur(o.edgeDetectedT - o.start)}, cloud after ${fmt.dur(o.cloudDetectedT - o.start)}`];
    }],
  ];

  function run() {
    return TESTS.map(([id, kind, name, fn]) => {
      const t0 = Date.now();
      try {
        const [pass, detail] = fn();
        return { id, kind, name, pass: !!pass, detail, ms: Date.now() - t0 };
      } catch (err) {
        return { id, kind, name, pass: false, detail: 'threw: ' + err.message, ms: Date.now() - t0 };
      }
    });
  }

  CS.selftest = { run, TESTS };
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
