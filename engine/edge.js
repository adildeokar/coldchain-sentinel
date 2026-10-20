/* Raspberry Pi edge device — the system under test. Mirrors firmware/main.py,
 * coldstore/store.py and coldstore/uploader.py:
 *
 *   every 5 s: read DS18B20 + DHT22 + door → fuse → AlarmEngine → GPIO alarm
 *              → write row to SQLite → LCD → kick the uploader
 *   uploader : alerts first, then live readings, then backlog in batches of 50 */
(function (CS) {
  'use strict';
  const { fmt, round } = CS.util;
  const { AlarmEngine, fuse, LABEL } = CS.rules;

  const ROW_BYTES = 188;                      // average SQLite row incl. index overhead (measured on the Pi)

  class EdgeStore {
    constructor(capacity) {
      this.capacity = capacity;
      this.pending = [];                      // rows not yet acknowledged by IoT Hub, oldest first
      this.alerts = [];                       // queued alert messages (RAISED / CLEARED)
      this.nextSeq = 1;
      this.dropped = 0;
      this.sentRows = 0;
      this.written = 0;
      this.peak = 0;
    }
    get depth() { return this.pending.length; }
    add(row) {
      this.pending.push(row);
      this.written++;
      const dropped = [];
      while (this.pending.length > this.capacity) { dropped.push(this.pending.shift()); this.dropped++; }
      this.peak = Math.max(this.peak, this.pending.length);
      return dropped;
    }
    markSent(seqs) {
      const before = this.pending.length;
      this.pending = this.pending.filter((r) => !seqs.has(r.seq));
      this.sentRows += before - this.pending.length;
    }
    live(since) {
      const out = [];
      for (let i = this.pending.length - 1; i >= 0 && this.pending[i].ts >= since; i--) if (!this.pending[i].inflight) out.push(this.pending[i]);
      return out.reverse();
    }
    backlog(n, since) {
      const out = [];
      for (let i = 0; i < this.pending.length && out.length < n; i++) {
        const r = this.pending[i];
        if (r.ts >= since) break;
        if (!r.inflight) out.push(r);
      }
      return out;
    }
    backlogCount(since) { let n = 0; for (const r of this.pending) { if (r.ts >= since) break; n++; } return n; }
    dbBytes() { return 32768 + (this.pending.length + Math.min(this.sentRows, 120960)) * ROW_BYTES + this.alerts.length * 420; }
  }

  class EdgeDevice extends CS.MqttDevice {
    constructor(sim, overrides = {}) {
      const cfg = { ...CS.config.DEFAULTS, ...overrides };
      super(sim, cfg.deviceId, 'pi', cfg);
      this.logSrc = 'EDGE';
      const p = CS.config.PROFILES[cfg.profile];
      this.th = { tMin: p.tMin, tMax: p.tMax, hMin: p.hMin, hMax: p.hMax, tempHystC: cfg.tempHystC, rhHystPct: cfg.rhHystPct,
        alarmDelaySamples: cfg.alarmDelaySamples, warnMarginC: cfg.warnMarginC, doorOpenMaxS: cfg.doorOpenMaxS, sensorDisagreeC: cfg.sensorDisagreeC };
      let alertN = 0;
      this.engine = new AlarmEngine(this.th, () => `AL-${String(++alertN).padStart(5, '0')}`);
      this.store = new EdgeStore(cfg.bufferCapacity);
      this.power = 'ON';
      this.out = { alarm: false, critical: false, silenced: false, buzzer: false, red: false, green: true, amber: 'solid', alarmName: null };
      this.lcd = ['ColdChain v' + cfg.firmware, 'Starting...     '];
      this.last = null;                       // last reading
      this.history = [];                      // every local reading (what the Pi itself knows)
      this.termLines = [];
      this.termN = 0;
      this.doorOpenedAt = null;
      this.batchId = 0;
      this.batchInflight = false;
      this.pumpTimer = null;
      this.sync = null;
      this.desiredVersion = 0;
      this.res = { cpu: 3, ramMb: 61, cpuTempC: 47, uptimeS: 0, msgsLastS: 0, sampledLastS: false };
      this.bstats = { liveSent: 0, batchedRows: 0, batches: 0, batchWire: 0, equivWire: 0, alertsSent: 0, retries: 0 };
      this.sampleCount = 0;
    }

    // ---- logging in the same format as Python's logging module ----------------
    term(level, logger, text) {
      this.termLines.push({ n: ++this.termN, t: this.sim.now(), level, logger, text });
      if (this.termLines.length > 600) this.termLines.splice(0, this.termLines.length - 600);
      this.sim.bus.emit('term', null);
    }

    start() {
      this.term('INFO', 'coldstore', `ColdChain Sentinel ${this.cfg.firmware} on ${this.id} — profile ${this.cfg.profile}, limits ${this.th.tMin}…${this.th.tMax} °C / ${this.th.hMin}…${this.th.hMax} %RH, every ${this.cfg.sampleIntervalS} s`);
      this._startSampler();
      this.connect();
    }

    _startSampler() {
      if (this.sampler) this.sampler.cancel();
      const ms = this.cfg.sampleIntervalS * 1000;
      const g = this.gen;
      this.sampler = this.sim.every(ms, () => { if (g === this.gen) this.sample(); }, ms - (this.sim.t % ms));
    }

    // ---- main loop body (firmware/main.py) -------------------------------------
    sample() {
      if (this.power !== 'ON') return;
      const sim = this.sim, f = sim.sensors.sample();
      const readMs = 750 + f.dhtAttempts * 5.2 + (f.dhtAttempts - 1) * 2000;   // DS18B20 conversion + DHT22 (2 s between retries)
      if (f.dhtAttempts > 1 && f.dht22C != null) this.term('DEBUG', 'coldstore.dht22', `DHT22 checksum error, retry ${f.dhtAttempts - 1}/${this.cfg.dht22Retries} succeeded`);
      if (f.dht22C == null) this.term('WARNING', 'coldstore.dht22', `DHT22: no valid reading after ${f.dhtAttempts} attempts`);
      if (f.ds18b20C == null) this.term('WARNING', 'coldstore.ds18b20', f.dsRaw === 't=85000' ? 'DS18B20 returned 85.000 °C power-on-reset value — rejected' : 'DS18B20 read error: CRC check failed (probe unplugged?)');

      const door = f.door;
      if (door && this.doorOpenedAt == null) this.doorOpenedAt = f.t;
      if (!door) this.doorOpenedAt = null;
      const doorOpenS = this.doorOpenedAt == null ? 0 : (f.t - this.doorOpenedAt) / 1000;

      const r = {
        seq: this.store.nextSeq++, ts: f.ts, tempC: fuse(f.ds18b20C, f.dht22C), rh: f.rh,
        ds18b20C: f.ds18b20C, dht22C: f.dht22C, door, status: 'OK', alarms: [],
      };
      const events = this.engine.evaluate(r, doorOpenS);
      const evalMs = 0.18 + sim.rng.range(0, 0.35);
      events.forEach((e) => this._onAlarmEvent(e, f.ts + readMs + evalMs, evalMs));

      const body = {
        type: 'telemetry', deviceId: this.id, seq: r.seq, ts: fmt.iso(r.ts), tempC: r.tempC, rh: r.rh,
        ds18b20C: r.ds18b20C, dht22C: r.dht22C, door: door ? 'open' : 'closed', status: r.status, alarms: r.alarms, buffered: false, fw: this.cfg.firmware,
      };
      const cond = sim.link.up ? 'connected' : 'disconnected';
      const row = { seq: r.seq, ts: r.ts, body, inflight: false, attempts: 0, cond };
      const dropped = this.store.add(row);
      sim.metrics.generated('edge', r.seq, cond, r.ts);
      if (dropped.length) {
        dropped.forEach((d) => sim.metrics.dropped('edge', d.seq));
        this.term('ERROR', 'coldstore.store', `queue full (${this.store.capacity} rows) — dropped oldest reading #${dropped[0].seq}`);
      }
      this.last = { ...r, readMs, dhtAttempts: f.dhtAttempts, doorOpenS };
      this.history.push({ ts: r.ts, t: r.tempC, h: r.rh, s: r.status, ds: r.ds18b20C, dht: r.dht22C, door });
      if (this.history.length > 40000) this.history.splice(0, 5000);
      this.sampleCount++;
      this.res.sampledLastS = true;

      this._lcd();
      sim.packet({ hops: ['room', 'pi'], kind: 'sensor', label: '', dur: readMs });
      sim.packet({ hops: ['pi', 'sqlite'], kind: 'db', label: '', dur: 6 });
      this.term('INFO', 'coldstore', `#${r.seq} T=${fmt.num(r.tempC, 2)}°C RH=${fmt.num(r.rh, 1)}% door=${door ? 'open' : 'closed'} status=${r.status} queue=${this.store.depth} cloud=${this.state}`);
      sim.bus.emit('edge:reading', this.last);
      this.pump();
    }

    _onAlarmEvent(e, actionAt, evalMs = 0) {
      const sim = this.sim;
      if (e.state === 'RAISED') {
        e.localActionAt = actionAt;
        this.out.alarm = true;
        this.out.critical = this.out.critical || e.severity === 'critical';
        this.out.alarmName = e.alarm;
        this.out.green = false;
        this.out.red = true;
        if (!this.out.silenced) this.out.buzzer = true;
        this.term('CRITICAL', 'coldstore', `ALARM ${e.alertId} ${e.alarm} value=${e.value} limit=${e.threshold} — buzzer+LED on in ${fmt.num(evalMs, 2)} ms (cloud: ${this.state})`);
        sim.log('EDGE', 'alarm', `LOCAL ALARM ${e.alarm} (${LABEL[e.alarm]}) value ${e.value} vs limit ${e.threshold} — buzzer + red LED ON, cloud ${this.connected ? 'online' : 'OFFLINE'}`, { alertId: e.alertId });
        sim.metrics.edgeLocalAlert(e);
        sim.packet({ hops: ['pi', 'alarm'], kind: 'alert', label: '!', dur: 2 });
      } else {
        this.term('WARNING', 'coldstore', `CLEARED ${e.alertId} ${e.alarm} value=${e.value}`);
        sim.log('EDGE', 'ok', `${e.alarm} cleared (value ${e.value})`, { alertId: e.alertId });
        if (!this.engine.active().length) this._clearOutputs();
        else this.out.alarmName = this.engine.active()[0];
      }
      this.store.alerts.push({ ...e, inflight: false, queuedAt: sim.now() });
      sim.bus.emit('edge:alarm', e);
    }

    _clearOutputs() {
      Object.assign(this.out, { alarm: false, critical: false, silenced: false, buzzer: false, red: false, green: true, alarmName: null });
    }

    acknowledge(source = 'button') {
      if (!this.out.alarm || this.power !== 'ON') return false;
      this.out.silenced = true;
      this.out.buzzer = false;
      this.term('INFO', 'coldstore.alarm', `Alarm acknowledged ${source === 'button' ? 'locally (GPIO22 button)' : 'via direct method silenceAlarm'} — buzzer silenced`);
      this.sim.log('EDGE', 'info', `Alarm acknowledged (${source}) — buzzer silenced, red LED stays on`);
      return true;
    }

    _lcd() {
      const r = this.last;
      const t = r.tempC == null ? '--.-' : r.tempC.toFixed(1).padStart(4);
      const h = r.rh == null ? '--' : String(Math.round(r.rh)).padStart(2);
      const l1 = `T:${t}C H:${h}%`;
      const l2 = this.out.alarmName ? `ALARM ${this.out.alarmName}` : `${r.status.padEnd(4)}${this.connected ? 'ONLINE' : 'OFFLN'} Q:${this.store.depth}`;
      this.lcd = [l1.slice(0, 16).padEnd(16), l2.slice(0, 16).padEnd(16)];
    }

    get gpio() {
      const o = this.out, on = this.power === 'ON';
      return {
        4: on ? 1 : 0, 17: on ? 1 : 0, 27: this.sim.room.doorOpen ? 1 : 0, 22: 1,
        18: on && o.buzzer ? 1 : 0, 23: on && o.red ? 1 : 0, 24: on && o.green ? 1 : 0,
        25: on && o.amber !== 'off' ? 1 : 0, 2: on ? 1 : 0, 3: on ? 1 : 0,
      };
    }

    // ---- uploader (firmware/coldstore/uploader.py) ------------------------------
    pump() {
      if (this.power !== 'ON') return;
      const since = this.sim.now() - 2 * this.cfg.sampleIntervalS * 1000;
      this._amber(since);
      if (!this.connected) return;

      // 1) alerts, highest priority
      this.store.alerts.filter((a) => !a.inflight).forEach((a) => {
        const now = this.sim.now();
        const body = {
          type: 'alert', deviceId: this.id, alertId: a.alertId, alarm: a.alarm, state: a.state, severity: a.severity,
          value: a.value, threshold: a.threshold, firstBreachAt: fmt.iso(a.firstBreachAt), raisedAt: fmt.iso(a.raisedAt),
          localActionAt: fmt.iso(a.localActionAt || a.raisedAt), localActions: a.state === 'RAISED' ? ['buzzer', 'red_led', 'lcd'] : [],
          bufferedMs: Math.max(0, Math.round(now - a.queuedAt)),
        };
        const m = this.publish('alert', body, { alert: 'true', type: 'alert', severity: a.severity }, { alert: a });
        if (m) { a.inflight = true; a.attempts = (a.attempts || 0) + 1; if (a.attempts > 1) this.bstats.retries++; }
      });

      // 2) live readings
      this.store.live(since).forEach((row) => {
        const m = this.publish('telemetry', row.body, { type: 'telemetry', alert: 'false' }, { rows: [row] });
        if (m) { row.inflight = true; row.attempts++; if (row.attempts > 1) this.bstats.retries++; this.res.msgsLastS++; }
      });

      // 3) backlog, one batch in flight at a time
      if (!this.batchInflight) {
        const rows = this.store.backlog(this.cfg.batchSize, since);
        if (rows.length) {
          const body = {
            type: 'batch', deviceId: this.id, batchId: ++this.batchId, count: rows.length, fromSeq: rows[0].seq, toSeq: rows[rows.length - 1].seq,
            readings: rows.map((r) => ({ q: r.seq, ts: r.body.ts, t: r.body.tempC, h: r.body.rh, d: r.body.door === 'open' ? 1 : 0, s: r.body.status })),
          };
          const m = this.publish('batch', body, { type: 'batch', alert: 'false', buffered: 'true' }, { rows });
          if (m) {
            this.batchInflight = true;
            rows.forEach((r) => { r.inflight = true; r.attempts++; });
            this.bstats.batchWire += m.wireBytes;
            this.bstats.equivWire += rows.reduce((s, r) => s + CS.util.jsonSize(r.body) + 170, 0);
            this.res.msgsLastS++;
            this.term('INFO', 'coldstore.uploader', `sync batch #${body.batchId}: ${rows.length} readings (#${body.fromSeq}–#${body.toSeq}), ${fmt.bytes(m.wireBytes)}, ${this.store.backlogCount(since) - rows.length} left`);
          }
        }
      }
      if (this.store.backlogCount(since) > 0 && !this.pumpTimer) {
        this.pumpTimer = this._later(this.cfg.syncIntervalS * 1000, () => { this.pumpTimer = null; this.pump(); });
      }
      this._checkSyncDone(since);
    }

    _amber(since) {
      const backlog = this.store.backlogCount(since);
      this.out.amber = !this.connected ? 'solid' : backlog > 0 ? 'blink' : 'off';
    }

    _checkSyncDone(since) {
      if (this.sync && this.store.backlogCount(since) === 0 && !this.batchInflight) {
        const s = this.sync;
        s.drainedT = this.sim.t;
        s.durationMs = s.drainedT - s.startT;
        this.term('INFO', 'coldstore.uploader', `backlog synced in ${(s.durationMs / 1000).toFixed(1)} s after reconnect (${s.backlog} readings, ${s.batches} batches)`);
        this.sim.log('EDGE', 'ok', `Store-and-forward sync complete: ${s.backlog} buffered readings delivered in ${fmt.dur(s.durationMs)}`);
        this.sim.metrics.syncDone(s);
        this.sync = null;
        this._report({ queueDepth: 0 });
      }
    }

    onAck(e) {
      const { msg, ctx } = e;
      if (ctx.alert) {
        this.store.alerts = this.store.alerts.filter((a) => a !== ctx.alert);
        this.bstats.alertsSent++;
        this.term('INFO', 'coldstore.uploader', `alert ${ctx.alert.alertId} ${ctx.alert.state} delivered (buffered ${msg.body.bufferedMs} ms)`);
      }
      if (ctx.rows) {
        this.store.markSent(new Set(ctx.rows.map((r) => r.seq)));
        if (msg.kind === 'batch') {
          this.batchInflight = false;
          this.bstats.batches++;
          this.bstats.batchedRows += ctx.rows.length;
          if (this.sync) this.sync.batches++;
        } else this.bstats.liveSent++;
      }
      this.pump();
    }

    onTimeout(e) {
      const { ctx, msg } = e;
      if (ctx.alert) ctx.alert.inflight = false;
      if (ctx.rows) ctx.rows.forEach((r) => (r.inflight = false));
      if (msg.kind === 'batch') this.batchInflight = false;
    }

    onConnected(twin) {
      const since = this.sim.now() - 2 * this.cfg.sampleIntervalS * 1000;
      const backlog = this.store.backlogCount(since);
      if (this.lostAt != null) {
        this.term('INFO', 'coldstore.uploader', `connected after ${((this.sim.t - this.lostAt) / 1000).toFixed(0)} s offline — ${this.store.depth} readings to sync`);
      }
      if (backlog > 0) this.sync = { startT: this.sim.t, backlog, batches: 0, outageMs: this.lostAt != null ? this.sim.t - this.lostAt : 0, peak: this.store.peak };
      this.lostAt = null;
      this.store.peak = this.store.depth;
      if (twin && twin.desired.$version > this.desiredVersion) this.applyDesired(twin.desired, 'twin GET on reconnect');
      this._report({ connectivity: 'online', queueDepth: this.store.depth });
      this.pump();
    }

    onDisconnected() {
      this.lostAt = this.sim.t;
      this.sim.metrics.edgeLostDetected();
      this.batchInflight = false;
      this.term('ERROR', 'coldstore.uploader', `connection lost — buffering locally (${this.store.depth} pending), alarms continue on GPIO`);
      this._amber(0);
    }

    _report(patch) {
      if (!this.connected) return;
      const body = { ...this.reportedProps(), ...patch };
      const bytes = CS.util.jsonSize(body) + 120;
      this.sim.link.send('up', bytes, { hops: this.upHops, kind: 'twin', label: '' }, () => this.sim.cloud.reportedPatch(this.id, body));
    }

    reportedProps() {
      return {
        profile: this.cfg.profile,
        thresholds: { temp_min_c: this.th.tMin, temp_max_c: this.th.tMax, rh_min_pct: this.th.hMin, rh_max_pct: this.th.hMax, alarm_delay_samples: this.th.alarmDelaySamples },
        sampleIntervalSec: this.cfg.sampleIntervalS, firmware: this.cfg.firmware, queueDepth: this.store.depth,
        connectivity: this.connected ? 'online' : 'offline',
      };
    }

    applyDesired(d, via) {
      const changed = [];
      if (d.profile && d.profile !== this.cfg.profile && CS.config.PROFILES[d.profile]) {
        const p = CS.config.PROFILES[d.profile];
        this.cfg.profile = d.profile;
        Object.assign(this.th, { tMin: p.tMin, tMax: p.tMax, hMin: p.hMin, hMax: p.hMax });
        changed.push('profile');
      }
      const map = { temp_min_c: 'tMin', temp_max_c: 'tMax', rh_min_pct: 'hMin', rh_max_pct: 'hMax', alarm_delay_samples: 'alarmDelaySamples' };
      Object.entries(d.thresholds || {}).forEach(([k, v]) => {
        if (map[k] && v != null && this.th[map[k]] !== Number(v)) { this.th[map[k]] = Number(v); changed.push(`thresholds.${k}`); }
      });
      if (d.sampleIntervalSec && Number(d.sampleIntervalSec) !== this.cfg.sampleIntervalS) {
        this.cfg.sampleIntervalS = Math.max(1, Number(d.sampleIntervalSec));
        this._startSampler();
        changed.push('sampleIntervalSec');
      }
      this.desiredVersion = d.$version || this.desiredVersion;
      if (changed.length) {
        this.term('INFO', 'coldstore', `twin desired properties applied (${via}): ${changed.join(', ')}`);
        this.sim.log('EDGE', 'info', `Twin desired v${d.$version} applied via ${via}: ${changed.join(', ')}`);
        this._report({});
        this.sim.bus.emit('edge:config', this.th);
      }
      return changed;
    }

    handleMethod(name, payload) {
      this.term('INFO', 'coldstore', `direct method ${name}(${JSON.stringify(payload || {})})`);
      if (name === 'silenceAlarm') return { status: 200, payload: { silenced: this.acknowledge('cloud') } };
      if (name === 'testAlarm') {
        const was = { ...this.out };
        Object.assign(this.out, { buzzer: true, red: true, green: false });
        this._later((payload.seconds || 3) * 1000, () => { if (!this.out.alarm) Object.assign(this.out, { buzzer: false, red: false, green: true }); else Object.assign(this.out, { buzzer: was.buzzer }); });
        return { status: 200, payload: { ok: true, seconds: payload.seconds || 3 } };
      }
      if (name === 'getDiagnostics') {
        return { status: 200, payload: {
          uptimeS: Math.round(this.res.uptimeS), cpuPct: round(this.res.cpu, 1), memUsedMb: Math.round(this.res.ramMb), cpuTempC: round(this.res.cpuTempC, 1),
          pending: this.store.depth, dropped: this.store.dropped, dbBytes: this.store.dbBytes(), uploader: this.state,
          dht22Errors: this.sim.sensors.dhtErrors, ds18b20Errors: this.sim.sensors.dsErrors, activeAlarms: this.engine.active(),
        } };
      }
      if (name === 'reboot') {
        this._later(1500, () => this.reboot());
        return { status: 200, payload: { rebooting: true, inSeconds: 1.5 } };
      }
      return { status: 404, payload: { error: `unknown method ${name}` } };
    }

    // ---- power: reboot keeps SQLite, loses RAM state -----------------------------
    reboot(downS = 22) {
      if (this.power !== 'ON') return;
      this.power = 'BOOTING';
      this.powerOff();
      if (this.pumpTimer) { this.pumpTimer.cancelled = true; this.pumpTimer = null; }
      this.batchInflight = false;
      this.store.pending.forEach((r) => (r.inflight = false));
      this.store.alerts.forEach((a) => (a.inflight = false));
      this.lcd = ['                ', '                '];
      this.sim.log('EDGE', 'error', `Raspberry Pi power-cycled — rebooting (${downS} s). SQLite queue (${this.store.depth} rows) persists on SD card`);
      this.sim.metrics.rebootStart();
      this.sim.schedule(downS * 1000, () => {
        this.power = 'ON';
        this.powerOn();
        this.engine.reset();
        this._clearOutputs();
        this.doorOpenedAt = null;
        this.res.uptimeS = 0;
        this.term('INFO', 'systemd', 'Started coldstore.service — ColdChain Sentinel cold-storage edge monitor.');
        this.term('INFO', 'coldstore.store', `opened /var/lib/coldstore/queue.db — ${this.store.depth} pending rows recovered, next seq #${this.store.nextSeq}`);
        this.sim.log('EDGE', 'ok', `Boot complete — recovered ${this.store.depth} pending readings from SQLite, resuming at seq #${this.store.nextSeq}`);
        this.sim.metrics.rebootEnd();
        this.start();
      });
    }

    tickResources() {
      const r = this.res, rng = this.sim.rng;
      if (this.power !== 'ON') { r.cpu = this.power === 'BOOTING' ? 70 + rng.range(-10, 25) : 0; r.msgsLastS = 0; return; }
      r.uptimeS += 1;
      r.cpu = 2.1 + rng.range(0, 1.1) + (r.sampledLastS ? 4.5 : 0) + r.msgsLastS * 1.4 + (this.sync ? 6 : 0) + (this.state === 'CONNECTING' ? 9 : 0);
      r.ramMb = 61.5 + this.store.depth * 0.00016 + this.inflight.size * 0.004 + rng.range(-0.3, 0.3);
      r.cpuTempC += ((45.5 + r.cpu * 0.22) - r.cpuTempC) * 0.05;
      r.msgsLastS = 0;
      r.sampledLastS = false;
    }
  }

  CS.EdgeDevice = EdgeDevice;
  CS.EdgeStore = EdgeStore;
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
