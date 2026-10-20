/* Discrete-event simulation kernel + the scenario actions the UI and the
 * experiment runner can inject. Time is virtual (ms since start); `now()`
 * maps it onto wall-clock epoch so timestamps look real. */
(function (CS) {
  'use strict';
  const { Rng, Emitter, PQ, fmt } = CS.util;

  class Simulation {
    constructor(opts = {}) {
      this.opts = { seed: 42, profile: 'pharma', headless: false, baseline: true, ...opts };
      this.t = 0;
      this.startEpoch = opts.startEpoch || Math.floor(Date.now() / 1000) * 1000;
      this.pq = new PQ();
      this.bus = new Emitter();
      this.rng = new Rng(this.opts.seed);
      this.logs = [];
      this.logN = 0;

      this.room = new CS.ColdRoom(this.opts.profile);
      this.sensors = new CS.SensorBus(this);
      this.link = new CS.NetworkLink(this);
      this.metrics = new CS.Metrics(this);
      this.cloud = new CS.AzureCloud(this);
      const over = { profile: this.opts.profile, ...(this.opts.edge || {}) };
      this.edge = new CS.EdgeDevice(this, over);
      this.baseline = new CS.BaselineDevice(this, { profile: this.opts.profile });
      this.ups = { pct: 100, onBattery: false };   // UPS HAT: ~5.5 h at the Pi's ~3 W
      this.started = false;
    }

    now() { return this.startEpoch + this.t; }

    schedule(ms, fn) { const it = { t: this.t + Math.max(0, ms), fn, cancelled: false }; this.pq.push(it); return it; }

    every(ms, fn, first = ms) {
      const h = { cancelled: false, cancel() { this.cancelled = true; } };
      const tick = () => { if (h.cancelled) return; fn(); this.schedule(ms, tick); };
      this.schedule(first, tick);
      return h;
    }

    start() {
      if (this.started) return;
      this.started = true;
      this.every(1000, () => {
        this.room.step(1);
        this.sensors.step(1);
        this.edge.tickResources();
        const u = this.ups;
        u.onBattery = !this.room.powerOk;
        u.pct = u.onBattery ? Math.max(0, u.pct - 100 / (5.5 * 3600)) : Math.min(100, u.pct + 100 / (2 * 3600));
      });
      // reference observer samples on the edge's schedule, before the devices (same instant → same frame)
      const ms = this.edge.cfg.sampleIntervalS * 1000;
      this.every(ms, () => this.metrics.observe(this.sensors.sample()), ms);
      this.edge.start();
      if (this.opts.baseline) this.baseline.start();
      this.cloud.start();
      this.every(5000, () => { this.edge.keepAlive(); this.baseline.keepAlive(); });
      this.log('SIM', 'info', `Simulation started — ${CS.config.PROFILES[this.opts.profile].label} profile, seed ${this.opts.seed}`);
    }

    advance(ms) {
      const end = this.t + ms;
      while (this.pq.size && this.pq.peek().t <= end) {
        const it = this.pq.pop();
        if (it.cancelled) continue;
        this.t = it.t;
        it.fn();
      }
      this.t = end;
    }

    log(src, level, msg, data) {
      const e = { n: ++this.logN, t: this.now(), src, level, msg, data };
      this.logs.push(e);
      if (this.logs.length > 3000) this.logs.splice(0, 500);
      this.bus.emit('log', e);
    }

    packet(p) { if (!this.opts.headless) this.bus.emit('packet', p); }

    // ---- scenario actions ----------------------------------------------------------
    openDoor(seconds) {
      if (!this.room.doorOpen) { this.room.doorOpen = true; this.log('ROOM', 'warn', `Door OPENED${seconds ? ` (closes in ${seconds} s)` : ''} — warm humid air entering`); }
      if (seconds) { if (this._doorTimer) this._doorTimer.cancelled = true; this._doorTimer = this.schedule(seconds * 1000, () => this.closeDoor()); }
    }
    closeDoor() { if (this.room.doorOpen) { this.room.doorOpen = false; this.log('ROOM', 'info', 'Door closed'); } }
    toggleDoor() { this.room.doorOpen ? this.closeDoor() : this.openDoor(); }

    failCompressor() { if (!this.room.compressorFailed) { this.room.compressorFailed = true; this.log('ROOM', 'error', 'Compressor FAILURE — refrigeration stopped, room will warm ~0.6 °C/min'); } }
    repairCompressor() { if (this.room.compressorFailed) { this.room.compressorFailed = false; this.log('ROOM', 'ok', 'Compressor repaired — cooling resumed'); } }
    setThermostatStuck(on) { this.room.thermostatStuck = on; this.log('ROOM', on ? 'error' : 'ok', on ? 'Thermostat relay STUCK ON — compressor runs non-stop, product at risk of freezing' : 'Thermostat relay fixed'); }
    humiditySurge(seconds = 240) { this.room.surgeS = seconds; this.log('ROOM', 'warn', `Humidity surge — wet produce loaded / defrost water (${seconds} s)`); }

    sensorFault(which, mode) {
      if (which === 'dht22') { this.sensors.dhtFault = !!mode; this.log('SENSOR', mode ? 'error' : 'ok', mode ? 'DHT22 data wire disconnected — every read fails checksum' : 'DHT22 reconnected'); }
      else { this.sensors.dsFault = mode || null; this.log('SENSOR', mode ? 'error' : 'ok', mode === 'por' ? 'DS18B20 brown-out — returning 85.000 °C power-on-reset value' : mode ? 'DS18B20 probe unplugged — CRC failures' : 'DS18B20 probe reconnected'); }
    }

    networkOutage(seconds) {
      this.link.setMode('offline');
      if (this._netTimer) this._netTimer.cancelled = true;
      if (seconds) this._netTimer = this.schedule(seconds * 1000, () => this.link.setMode('online'));
    }
    restoreNetwork() { if (this._netTimer) this._netTimer.cancelled = true; this.link.setMode('online'); }
    degradeNetwork() { this.link.setMode('degraded'); }

    sitePowerFail(seconds) {
      if (!this.room.powerOk) return;
      this.room.powerOk = false;
      this.link.setRouterPower(false);
      this.log('POWER', 'error', 'SITE POWER FAILURE — compressor and router down. Raspberry Pi continues on UPS HAT battery');
      if (seconds) this._pwrTimer = this.schedule(seconds * 1000, () => this.restorePower());
    }
    restorePower() {
      if (this._pwrTimer) this._pwrTimer.cancelled = true;
      if (this.room.powerOk) return;
      this.room.powerOk = true;
      this.link.setRouterPower(true);
      this.log('POWER', 'ok', 'Mains power restored — compressor restarting, router booting');
    }

    rebootPi() { this.edge.reboot(); }
    pressAck() { this.edge.acknowledge('button'); }

    // Script: [{ at: seconds-from-now, do: 'networkOutage', args: [300] }, ...]
    runScript(steps) {
      steps.forEach((s) => this.schedule(s.at * 1000, () => this[s.do](...(s.args || []))));
    }

    outages() { return this.link.outages().map((o) => ({ ...o, from: this.startEpoch + o.from, to: this.startEpoch + o.to })); }
    fmtNow() { return fmt.time(this.now()); }
  }

  CS.Simulation = Simulation;
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
