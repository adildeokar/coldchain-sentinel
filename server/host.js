/* SimulationHost — owns the one live Simulation and runs it in real time.
 *
 *   every  50 ms  advance the discrete-event engine by (elapsed × speed)
 *   every 100 ms  flush animation packets to all browsers   (SSE event "packets")
 *   every 250 ms  send each browser a state snapshot         (SSE event "state")
 *
 * Snapshots are incremental per browser: append-only streams (logs, terminal
 * lines, local history, Cosmos documents) carry only what that browser has not
 * seen yet, and larger collections are re-sent only when they changed. */
const CS = require('../engine');
const log = require('./log');

const LOW_PRIORITY = new Set(['sensor', 'db', 'ack', 'ping', 'agg']);
const ACTIONS = new Set(['openDoor', 'closeDoor', 'toggleDoor', 'failCompressor', 'repairCompressor', 'setThermostatStuck', 'humiditySurge',
  'sensorFault', 'ds18b20Glitch', 'networkOutage', 'restoreNetwork', 'degradeNetwork', 'sitePowerFail', 'restorePower', 'rebootPi', 'pressAck']);

class SimulationHost {
  constructor(opts) {
    this.opts = { seed: null, profile: 'pharma', speed: 5, quiet: false, ...opts };
    this.speed = this.opts.speed;
    this.playing = true;
    this.clients = new Set();
    this.results = null;     // last experiment run (shared by the Results and Report views)
    this.tests = null;
    this.reset({ seed: this.opts.seed, profile: this.opts.profile });
  }

  // ------------------------------------------------------------------ lifecycle
  reset({ seed, profile, script, warm } = {}) {
    this.seed = seed || Math.floor(Math.random() * 1e6);
    this.profile = profile || this.profile || 'pharma';
    this.sim = new CS.Simulation({ seed: this.seed, profile: this.profile, startEpoch: Math.floor(Date.now() / 1000) * 1000 });
    this.packets = [];
    this.events = [];
    this.lastMsg = null;
    this.wire();
    this.sim.start();
    const sc = script && CS.experiments.SCENARIOS.find((x) => x.id === script);
    if (sc) { this.sim.runScript(sc.script); log.info(`scenario ${sc.id} scheduled: ${sc.name}`); }
    if (warm) this.sim.advance(+warm * 1000);
    this.clients.forEach((c) => { c.cur = this.freshCursor(); c.last = {}; this.send(c, 'reset', { seed: this.seed }); });
    log.info(`simulation (re)started — seed ${this.seed}, profile ${this.profile}`);
  }

  wire() {
    const bus = this.sim.bus;
    bus.on('packet', (p) => {
      if (this.packets.length > 300 && LOW_PRIORITY.has(p.kind)) return;
      if (this.packets.length > 500) return;
      this.packets.push(p);
    });
    bus.on('publish', ({ id, msg }) => { if (id === this.sim.edge.id) this.lastMsg = msg; });
    bus.on('edge:alarm', (e) => {
      if (e.state !== 'RAISED') return;
      this.events.push({ type: 'alarm', alarm: e.alarm, value: e.value, threshold: e.threshold, online: this.sim.edge.connected });
    });
    bus.on('cloud:notify', (n) => this.events.push({ type: 'notify', severity: n.severity, title: n.title, channels: n.channels }));
    bus.on('log', (e) => {
      if (e.msg.startsWith('Store-and-forward sync complete')) this.events.push({ type: 'sync', text: e.msg.replace('Store-and-forward sync complete: ', '') });
      if (!this.opts.quiet) log.sim(e);
    });
  }

  start() {
    this.lastStep = Date.now();
    setInterval(() => this.step(), 50);
    setInterval(() => this.flushPackets(), 100);
    setInterval(() => this.broadcast(), 250);
    setInterval(() => log.status(this), 15000);
  }

  step() {
    const now = Date.now();
    const dt = Math.min(250, now - this.lastStep);
    this.lastStep = now;
    if (this.playing) this.sim.advance(dt * this.speed);
  }

  control({ speed, playing }) {
    if (speed != null) this.speed = Math.max(0.25, Math.min(120, +speed));
    if (playing != null) this.playing = !!playing;
    log.info(`control → speed ${this.speed}×, ${this.playing ? 'running' : 'paused'}`);
  }

  // ------------------------------------------------------------------ commands
  action(name, args = []) {
    if (!ACTIONS.has(name)) throw new Error(`unknown action ${name}`);
    if (name === 'ds18b20Glitch') {
      this.sim.sensorFault('ds18b20', 'por');
      this.sim.schedule(30000, () => this.sim.sensorFault('ds18b20', null));
    } else this.sim[name](...args);
    log.action(name, args);
  }

  updateTwin(deviceId, patch) {
    this.sim.cloud.updateDesired(deviceId, patch);
    log.action('twin.desired', [patch]);
    return this.sim.cloud.devices[deviceId].twin.desired;
  }

  invokeMethod(deviceId, name, payload) {
    log.action(`method ${name}`, [payload]);
    return new Promise((resolve) => this.sim.cloud.invokeMethod(deviceId, name, payload || {}, (rec) => resolve(rec)));
  }

  runExperiments(seed = 2026, profile = 'pharma') {
    const t0 = Date.now();
    this.results = CS.experiments.runAll(seed, profile);
    this.results.wallMs = Date.now() - t0;
    log.info(`experiments E1–E6 finished in ${this.results.wallMs} ms (seed ${seed}, ${profile})`);
    return this.results;
  }

  runTests() {
    this.tests = CS.selftest.run();
    log.info(`self-tests: ${this.tests.filter((t) => t.pass).length}/${this.tests.length} passed`);
    return this.tests;
  }

  // ------------------------------------------------------------------ streaming
  freshCursor() { return { log: 0, term: 0, histTs: 0, docK: 0 }; }

  addClient(res) {
    const c = { res, cur: this.freshCursor(), last: {} };
    this.clients.add(c);
    res.on('close', () => { this.clients.delete(c); log.info(`browser disconnected (${this.clients.size} connected)`); });
    log.info(`browser connected (${this.clients.size} connected)`);
    this.sendState(c, this.common());
  }

  send(c, event, data) { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

  flushPackets() {
    if (!this.packets.length && !this.events.length) return;
    const packets = this.packets.map(({ msg, ...p }) => (msg ? { ...p, msg: slimMsg(msg) } : p));
    const events = this.events;
    this.packets = []; this.events = [];
    this.clients.forEach((c) => {
      if (packets.length) this.send(c, 'packets', { speed: this.speed, packets });
      if (events.length) this.send(c, 'events', events);
    });
  }

  broadcast() {
    if (!this.clients.size) return;
    const common = this.common();
    this.clients.forEach((c) => this.sendState(c, common));
  }

  /* State shared by every browser for this tick. `heavy` entries are compared
   * against what each browser last received and skipped when unchanged. */
  common() {
    const sim = this.sim, e = sim.edge, b = sim.baseline, c = sim.cloud, link = sim.link, r = sim.room;
    const since = sim.now() - 2 * e.cfg.sampleIntervalS * 1000;
    const light = {
      t: sim.t, startEpoch: sim.startEpoch, speed: this.speed, playing: this.playing, seed: this.seed, profile: this.profile, clients: this.clients.size,
      room: { temp: r.temp, rh: r.rh, doorOpen: r.doorOpen, compressorFailed: r.compressorFailed, thermostatStuck: r.thermostatStuck, powerOk: r.powerOk,
        running: r.running, dutyCycle: r.dutyCycle, setpoint: r.setpoint, ambientT: r.ambientT },
      ups: sim.ups,
      sensors: { dsFault: sim.sensors.dsFault, dhtFault: sim.sensors.dhtFault, dhtErrors: sim.sensors.dhtErrors, dsErrors: sim.sensors.dsErrors,
        dsRaw: sim.sensors._cache ? sim.sensors._cache.frame.dsRaw : '' },
      link: { mode: link.mode, state: link.state, up: link.up, routerPowered: link.routerPowered, params: link.params(), stats: link.stats },
      outages: sim.outages(),
      edge: {
        id: e.id, power: e.power, state: e.state, connected: e.connected, cfg: e.cfg, th: e.th, out: e.out, lcd: e.lcd, gpio: e.gpio,
        last: e.last, res: e.res, sampleCount: e.sampleCount, activeAlarms: e.engine.active(), sync: e.sync, inflight: e.inflight.size, bstats: e.bstats,
        store: {
          depth: e.store.depth, capacity: e.store.capacity, dropped: e.store.dropped, sentRows: e.store.sentRows, written: e.store.written, peak: e.store.peak,
          dbBytes: e.store.dbBytes(), alertsQueued: e.store.alerts.length, backlog: e.store.backlogCount(since), backlog10: e.store.backlogCount(sim.now() - 10000),
          tail: e.store.pending.slice(-14).map((x) => ({ seq: x.seq, ts: x.ts, inflight: x.inflight, attempts: x.attempts, cond: x.cond, body: { tempC: x.body.tempC, rh: x.body.rh, status: x.body.status } })),
        },
      },
      baseline: { id: b.id, state: b.state, connected: b.connected, stats2: b.stats2, inflight: b.inflight.size },
      cloud: {
        quota: c.quota, routes: c.routes, asa: { events: c.asa.events, outputs: c.asa.outputs },
        fn: Object.fromEntries(Object.entries(c.fn).map(([k, f]) => [k, { ...f, last: isFinite(f.last) ? f.last : null }])),
        dash: c.dash, liveLatencyMean: CS.util.mean(c.liveLatency.slice(-60)), liveLatencyN: c.liveLatency.length,
        dupes: Object.fromEntries(Object.entries(c.telemetry).map(([k, v]) => [k, v.dupes])),
        aggCount: c.agg[e.id] ? c.agg[e.id].size : 0,
      },
    };
    const heavy = {
      devices: c.devices,
      alerts: c.alerts.slice(0, 200),
      notifications: c.notifications.slice(0, 60),
      eventGrid: c.eventGrid.slice(0, 25),
      methods: c.methods.slice(0, 40),
      twinLog: c.twinLog.slice(0, 30),
      monitor: c.monitor.slice(0, 25),
      d2cPerMin: [...c.d2cPerMin.entries()].slice(-40),
      agg: c.aggregates(e.id, 20),
      summary: sim.metrics.summary(),
      lastMsg: this.lastMsg ? slimMsg(this.lastMsg) : null,
    };
    const heavyJson = Object.fromEntries(Object.entries(heavy).map(([k, v]) => [k, JSON.stringify(v)]));
    return { light, heavy, heavyJson };
  }

  sendState(c, common) {
    const sim = this.sim, cur = c.cur;
    const out = { ...common.light };
    Object.entries(common.heavyJson).forEach(([k, json]) => { if (c.last[k] !== json) { out[k] = common.heavy[k]; c.last[k] = json; } });
    out.newLogs = sim.logs.filter((x) => x.n > cur.log);
    if (out.newLogs.length) cur.log = out.newLogs[out.newLogs.length - 1].n;
    out.newTerm = sim.edge.termLines.filter((x) => x.n > cur.term);
    if (out.newTerm.length) cur.term = out.newTerm[out.newTerm.length - 1].n;
    out.newHistory = sim.edge.history.filter((x) => x.ts > cur.histTs);
    if (out.newHistory.length) cur.histTs = out.newHistory[out.newHistory.length - 1].ts;
    out.newDocs = sim.cloud.docLog.slice(cur.docK);
    cur.docK = sim.cloud.docLog.length;
    this.send(c, 'state', out);
  }

  // Full one-shot snapshot for GET /api/state (handy with curl during the demo)
  snapshot() {
    const common = this.common();
    return { ...common.light, ...common.heavy, cloudDocs: Object.fromEntries(Object.entries(this.sim.cloud.telemetry).map(([k, v]) => [k, v.docs.length])) };
  }
}

// a batch can carry 50 readings — trim it for the wire inspector
function slimMsg(m) {
  const body = m.kind === 'batch' ? { ...m.body, readings: [...m.body.readings.slice(0, 4), `… ${m.body.readings.length - 4} more`] } : m.body;
  return { msgId: m.msgId, kind: m.kind, props: m.props, topic: m.topic, payloadBytes: m.payloadBytes, wireBytes: m.wireBytes, sentAt: m.sentAt, body };
}

module.exports = { SimulationHost, ACTIONS };
