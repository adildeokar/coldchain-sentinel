/* GET /api/inspect/:node — live internal state of one block in the topology,
 * read straight from the engine objects on the server. */
const CS = require('../engine');
const { fmt } = CS.util;

module.exports = function inspect(sim, id) {
  const e = sim.edge, c = sim.cloud;
  const map = {
    room: () => ({ trueTempC: +sim.room.temp.toFixed(3), trueRh: +sim.room.rh.toFixed(2), doorOpen: sim.room.doorOpen, compressorRunning: sim.room.running, compressorFailed: sim.room.compressorFailed, thermostatStuck: sim.room.thermostatStuck, dutyCycle: +sim.room.dutyCycle.toFixed(3), setpoint: sim.room.setpoint, ambientC: sim.room.ambientT }),
    cu: () => ({ running: sim.room.running, failed: sim.room.compressorFailed, mains: sim.room.powerOk, dutyCycle: +sim.room.dutyCycle.toFixed(3) }),
    pi: () => ({ power: e.power, mqtt: e.state, resources: e.res, thresholds: e.th, sampleIntervalS: e.cfg.sampleIntervalS, activeAlarms: e.engine.active(), last: e.last, uploader: e.bstats }),
    alarm: () => ({ outputs: e.out, lcd: e.lcd, gpio: e.gpio }),
    sqlite: () => ({ pending: e.store.depth, capacity: e.store.capacity, dropped: e.store.dropped, sentRows: e.store.sentRows, alertsQueued: e.store.alerts.length, dbBytes: e.store.dbBytes(), oldestPending: e.store.pending[0] ? fmt.iso(e.store.pending[0].ts) : null }),
    ups: () => sim.ups,
    base: () => ({ mqtt: sim.baseline.state, ...sim.baseline.stats2 }),
    router: () => ({ mode: sim.link.state, up: sim.link.up, params: sim.link.params(), stats: sim.link.stats }),
    internet: () => ({ up: sim.link.up, outages: sim.outages().map((o) => ({ from: fmt.time(o.from), to: o.ongoing ? 'ongoing' : fmt.time(o.to) })) }),
    hub: () => ({ devices: Object.values(c.devices).map((d) => ({ id: d.id, conn: d.conn, d2c: d.d2c, lastActivity: fmt.time(sim.startEpoch + d.lastActivity) })), quota: c.quota, routes: c.routes }),
    eventgrid: () => c.eventGrid.slice(0, 8).map((x) => ({ ...x, t: fmt.time(x.t), eventTime: fmt.time(x.eventTime) })),
    fnConn: () => c.fn.ConnectionMonitor, fnAlert: () => c.fn.AlertProcessor, fnIngest: () => c.fn.TelemetryIngest,
    sb: () => ({ routed: c.routes['alerts-route'] }),
    logic: () => c.notifications.slice(0, 5).map((n) => ({ ...n, t: fmt.time(n.t) })),
    operator: () => c.notifications.slice(0, 5).map((n) => `${fmt.time(n.t)} [${n.channels.join('+')}] ${n.title}`),
    asa: () => ({ events: c.asa.events, cloudRuleOutputs: c.asa.outputs, last1mWindows: c.aggregates(e.id, 3) }),
    cosmos: () => ({ telemetry: Object.fromEntries(Object.entries(c.telemetry).map(([k, v]) => [k, { docs: v.docs.length, dupesDiscarded: v.dupes }])), alerts: c.alerts.length, latestDoc: c.telemetry[e.id].docs.slice(-1)[0] }),
    signalr: () => ({ pushes: c.liveLatency.length, avgEndToEndMs: Math.round(CS.util.mean(c.liveLatency.slice(-100)) || 0) }),
    dash: () => c.dash,
  };
  const fn = map[id];
  if (!fn) return null;
  return JSON.parse(JSON.stringify(fn(), (k, v) => (v === Infinity || v === -Infinity ? null : v)));
};
