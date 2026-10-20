/* Sensor models. Each sensor element has thermal lag (a first-order filter on
 * the room value), noise, quantisation and realistic failure modes.
 *
 *   DS18B20  τ = 25 s (steel probe)  σ = 0.05 °C  12-bit (0.0625 °C)  faults: unplugged → CRC fail, 85 °C POR
 *   DHT22    τ = 12 s                σ = 0.15 °C / 0.8 %RH  ~3 % checksum errors per read
 *   Reed     ideal switch, HIGH when the door is open
 *
 * One SensorBus.sample() per instant is shared by the edge Pi and the baseline
 * node so the comparison runs on identical readings. */
(function (CS) {
  'use strict';
  const { round } = CS.util;

  class SensorBus {
    constructor(sim) {
      this.sim = sim;
      this.dsT = sim.room.temp;
      this.dhtT = sim.room.temp;
      this.dhtH = sim.room.rh;
      this.dhtFault = false;            // unplugged DHT22 → every read fails
      this.dsFault = null;              // null | 'unplugged' | 'por'
      this.dhtOffset = 0.2;             // factory offset vs the probe (within ±0.5 °C spec)
      this.dhtErrors = 0;
      this.dsErrors = 0;
      this._cache = null;
    }

    step(dt) {
      const r = this.sim.room;
      this.dsT += (r.temp - this.dsT) * Math.min(1, dt / 25);
      this.dhtT += (r.temp - this.dhtT) * Math.min(1, dt / 12);
      this.dhtH += (r.rh - this.dhtH) * Math.min(1, dt / 10);
    }

    sample() {
      const now = this.sim.t;
      if (this._cache && this._cache.t === now) return this._cache.frame;
      const rng = this.sim.rng;

      let ds = null, dsRaw = null;
      if (this.dsFault === 'unplugged') { dsRaw = 'CRC=00 NO'; this.dsErrors++; }
      else if (this.dsFault === 'por') { dsRaw = 't=85000'; this.dsErrors++; }
      else {
        const v = Math.floor((this.dsT + rng.gauss(0, 0.05)) / 0.0625) * 0.0625;
        ds = round(v, 2);
        dsRaw = `t=${Math.round(v * 1000)}`;
      }

      let dhtT = null, dhtH = null, attempts = 0;
      const retries = this.sim.edge ? this.sim.edge.cfg.dht22Retries : 3;
      while (attempts < retries) {
        attempts++;
        if (this.dhtFault || rng.chance(0.03)) { this.dhtErrors++; continue; }
        dhtT = round(this.dhtT + this.dhtOffset + rng.gauss(0, 0.15), 1);
        dhtH = round(Math.min(100, Math.max(0, this.dhtH + rng.gauss(0, 0.8))), 1);
        break;
      }

      const frame = {
        t: now, ts: this.sim.now(),
        ds18b20C: ds, dsRaw, dht22C: dhtT, rh: dhtH, dhtAttempts: attempts,
        door: this.sim.room.doorOpen,
        trueT: this.sim.room.temp, trueRh: this.sim.room.rh,
      };
      this._cache = { t: now, frame };
      return frame;
    }
  }

  CS.SensorBus = SensorBus;
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
