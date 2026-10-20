/* Reproducible experiments. Each one is a scripted scenario run headless
 * (no animation) on a fixed seed, so the same numbers come out every time —
 * these are the "measured results" in the report. */
(function (CS) {
  'use strict';
  const { mean } = CS.util;

  const SCENARIOS = [
    {
      id: 'E1', name: 'Connected — door left open, compressor fault', cond: 'connected',
      desc: 'Network stays up for 40 min. Door is left open for 200 s at 5 min (temperature, humidity and door alarms), the compressor fails at 15 min and is repaired at 25 min, then a humidity surge.',
      durationS: 2400,
      script: [
        { at: 300, do: 'openDoor', args: [200] },
        { at: 900, do: 'failCompressor' }, { at: 1500, do: 'repairCompressor' },
        { at: 2000, do: 'humiditySurge', args: [240] },
      ],
    },
    {
      id: 'E2', name: 'Disconnected — compressor fails during a 15-min outage', cond: 'disconnected',
      desc: 'Internet is down from 5 to 20 min. The compressor fails at 7 min and is repaired at 16 min, so the whole excursion happens and ends while offline. A connected door event at 25 min gives a contrast in the same run.',
      durationS: 2400,
      script: [
        { at: 300, do: 'networkOutage', args: [900] },
        { at: 420, do: 'failCompressor' }, { at: 960, do: 'repairCompressor' },
        { at: 1500, do: 'openDoor', args: [150] },
      ],
    },
    {
      id: 'E3', name: 'Site power failure — router + compressor down 20 min', cond: 'disconnected',
      desc: 'Mains fails at 5 min for 20 min: the compressor stops and the router loses power. The Pi runs on its UPS HAT, keeps sampling and sounds the alarm with no internet.',
      durationS: 2700,
      script: [{ at: 300, do: 'sitePowerFail', args: [1200] }],
    },
    {
      id: 'E4', name: 'Degraded link — 650 ms latency, 12 % loss', cond: 'connected',
      desc: 'The WAN is up but poor for the whole run (a weak 4G signal). There is a compressor fault and a door event. This tests retries, duplicates and de-duplication.',
      durationS: 2400,
      script: [
        { at: 0, do: 'degradeNetwork' },
        { at: 400, do: 'failCompressor' }, { at: 900, do: 'repairCompressor' },
        { at: 1500, do: 'openDoor', args: [150] },
        { at: 2100, do: 'restoreNetwork' },
      ],
    },
    {
      id: 'E5', name: 'Long outage, small buffer (120 rows)', cond: 'disconnected',
      desc: 'The local queue is deliberately limited to 120 rows (10 min). A 30-min outage overflows it, so the oldest readings are dropped. This shows the buffer-sizing limit.',
      durationS: 2700, edge: { bufferCapacity: 120 },
      script: [{ at: 300, do: 'networkOutage', args: [1800] }, { at: 600, do: 'failCompressor' }, { at: 1100, do: 'repairCompressor' }],
    },
    {
      id: 'E6', name: 'Pi reboot during an outage', cond: 'disconnected',
      desc: 'A 12-min outage starts at 5 min. The Pi is power-cycled at 9 min. The SQLite queue must survive the reboot and sync once the link returns.',
      durationS: 1800,
      script: [{ at: 300, do: 'networkOutage', args: [720] }, { at: 540, do: 'rebootPi' }, { at: 360, do: 'openDoor', args: [180] }],
    },
  ];

  function run(sc, seed = 2026, profile = 'pharma') {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const sim = new CS.Simulation({ seed, profile, headless: true, edge: sc.edge, startEpoch: Date.UTC(2026, 9, 21, 3, 30, 0) });
    sim.start();
    sim.runScript(sc.script);
    sim.advance(sc.durationS * 1000);
    const s = sim.metrics.summary();
    const wall = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    const de = s.dev.edge, db = s.dev.base;
    const outage = sim.link.outages().reduce((a, o) => a + (o.to - o.from), 0);
    return {
      id: sc.id, name: sc.name, desc: sc.desc, cond: sc.cond, durationS: sc.durationS, outageS: outage / 1000, wallMs: wall, summary: s,
      row: {
        edgeGen: de.gen, edgeDel: de.del, edgeLost: de.lost, edgePending: de.pending, edgeDelivery: de.gen ? (de.gen - de.lost) / de.gen : null,
        baseGen: db.gen, baseDel: db.del, baseLost: db.lost, baseDelivery: db.gen ? (db.gen - db.lost) / db.gen : null,
        episodes: s.episodes.length,
        edgeLocal: mean(s.episodes.filter((e) => e.edgeLocalAt).map((e) => e.edgeLocalAt - e.start)),
        edgeCloud: mean(s.episodes.filter((e) => e.edgeCloudAt).map((e) => e.edgeCloudAt - e.start)),
        baseCloud: mean(s.episodes.filter((e) => e.baseCloudAt).map((e) => e.baseCloudAt - e.start)),
        baseMissed: s.episodes.filter((e) => !e.baseCloudAt).length,
        edgeMissed: s.episodes.filter((e) => !e.edgeCloudAt).length,
        syncMs: s.syncs.length ? Math.max(...s.syncs.map((x) => x.durationMs)) : null,
        syncRows: s.syncs.reduce((a, x) => a + x.backlog, 0),
        dupes: de.dupes + db.dupes,
        edgeDupes: de.dupes,
        dropped: de.dropped,
        edgeBytes: s.bw.edge.total, baseBytes: s.bw.base.total,
        securityPct: s.bw.edge.securityPct,
        batchSaving: s.batching.saving,
        cloudDetectS: s.outages.length && s.outages[0].cloudDetectedT != null ? (s.outages[0].cloudDetectedT - s.outages[0].start) / 1000 : null,
        edgeDetectS: s.outages.length && s.outages[0].edgeDetectedT != null ? (s.outages[0].edgeDetectedT - s.outages[0].start) / 1000 : null,
      },
    };
  }

  /* Pool every alert episode and every reading from all runs, grouped by the
   * link state at the moment the excursion began / the reading was taken. */
  function combine(runs) {
    const out = {};
    ['connected', 'disconnected'].forEach((c) => {
      const eps = [], data = { edge: { gen: 0, del: 0, lost: 0, delay: [] }, base: { gen: 0, del: 0, lost: 0, delay: [] } };
      runs.forEach((r) => {
        if (r.id === 'E5') return;            // deliberately undersized buffer — reported separately
        r.summary.episodes.filter((e) => e.cond === c).forEach((e) => eps.push({ ...e, run: r.id }));
        ['edge', 'base'].forEach((k) => {
          const d = r.summary.dev[k][c];
          data[k].gen += d.gen; data[k].del += d.del; data[k].lost += d.lost;
          if (d.delay.mean != null) data[k].delay.push(d.delay.mean);
        });
      });
      const lat = (f) => eps.filter((e) => e[f] != null).map((e) => e[f] - e.start);
      out[c] = {
        episodes: eps.length, eps,
        edgeLocal: lat('edgeLocalAt'), edgeCloud: lat('edgeCloudAt'), baseCloud: lat('baseCloudAt'),
        edgeLocalMissed: eps.filter((e) => e.edgeLocalAt == null).length,
        baseMissed: eps.filter((e) => e.baseCloudAt == null).length,
        edgeCloudMissed: eps.filter((e) => e.edgeCloudAt == null).length,
        data,
      };
    });
    return out;
  }

  function runAll(seed = 2026, profile = 'pharma') {
    const runs = SCENARIOS.map((sc) => run(sc, seed, profile));
    return { seed, profile, at: Date.now(), runs, combined: combine(runs) };
  }

  CS.experiments = { SCENARIOS, run, runAll, combine };
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
