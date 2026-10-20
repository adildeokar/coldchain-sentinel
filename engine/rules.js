/* Local alarm engine — line-for-line port of firmware/coldstore/rules.py.
 *
 *   NORMAL --(out of range for N consecutive samples)--> ACTIVE  ⇒ RAISED
 *   ACTIVE --(back inside limit minus hysteresis)------> NORMAL  ⇒ CLEARED */
(function (CS) {
  'use strict';

  const CRITICAL = new Set(['HIGH_TEMP', 'LOW_TEMP', 'SENSOR_FAULT']);
  const CHANNELS = ['HIGH_TEMP', 'LOW_TEMP', 'HIGH_RH', 'LOW_RH', 'DOOR_OPEN', 'SENSOR_FAULT', 'SENSOR_DISAGREE'];
  const LABEL = {
    HIGH_TEMP: 'High temperature', LOW_TEMP: 'Low temperature', HIGH_RH: 'High humidity', LOW_RH: 'Low humidity',
    DOOR_OPEN: 'Door open too long', SENSOR_FAULT: 'Sensor fault', SENSOR_DISAGREE: 'Sensors disagree',
  };

  function fuse(ds, dht) { return ds != null ? ds : dht; }   // probe first, DHT22 as fallback

  class AlarmEngine {
    constructor(th, idFactory) {
      this.th = th;                    // { tMin, tMax, hMin, hMax, tempHystC, rhHystPct, alarmDelaySamples, warnMarginC, doorOpenMaxS, sensorDisagreeC }
      let n = 0;
      this.newId = idFactory || (() => `AL-${String(++n).padStart(5, '0')}`);
      this.reset();
    }

    reset() {
      this.ch = {};
      CHANNELS.forEach((c) => (this.ch[c] = { name: c, count: 0, active: false, firstBreachAt: 0, alertId: null, peak: null }));
    }

    _step(ch, out, cleared, value, threshold, ts, delay, ev) {
      if (!ch.active) {
        if (out) {
          ch.count++;
          if (ch.count === 1) ch.firstBreachAt = ts;
          if (ch.count >= delay) {
            ch.active = true; ch.alertId = this.newId(); ch.peak = value;
            ev.push({ alertId: ch.alertId, alarm: ch.name, state: 'RAISED', severity: CRITICAL.has(ch.name) ? 'critical' : 'warning',
              value, threshold, raisedAt: ts, firstBreachAt: ch.firstBreachAt });
          }
        } else ch.count = 0;
      } else {
        if (value != null && ch.peak != null) ch.peak = ch.name.startsWith('HIGH') ? Math.max(ch.peak, value) : Math.min(ch.peak, value);
        if (cleared) {
          ev.push({ alertId: ch.alertId, alarm: ch.name, state: 'CLEARED', severity: CRITICAL.has(ch.name) ? 'critical' : 'warning',
            value, threshold, raisedAt: ts, firstBreachAt: ch.firstBreachAt, peak: ch.peak });
          ch.active = false; ch.count = 0; ch.alertId = null;
        }
      }
    }

    evaluate(r, doorOpenS) {
      const th = this.th, ev = [], n = th.alarmDelaySamples, c = this.ch;
      const t = r.tempC, h = r.rh;
      if (t != null) {
        this._step(c.HIGH_TEMP, t > th.tMax, t <= th.tMax - th.tempHystC, t, th.tMax, r.ts, n, ev);
        this._step(c.LOW_TEMP, t < th.tMin, t >= th.tMin + th.tempHystC, t, th.tMin, r.ts, n, ev);
      }
      if (h != null) {
        this._step(c.HIGH_RH, h > th.hMax, h <= th.hMax - th.rhHystPct, h, th.hMax, r.ts, n, ev);
        this._step(c.LOW_RH, h < th.hMin, h >= th.hMin + th.rhHystPct, h, th.hMin, r.ts, n, ev);
      }
      this._step(c.DOOR_OPEN, doorOpenS > th.doorOpenMaxS, doorOpenS === 0, Math.round(doorOpenS), th.doorOpenMaxS, r.ts, 1, ev);

      const dead = r.ds18b20C == null && r.dht22C == null;
      this._step(c.SENSOR_FAULT, dead, !dead, null, null, r.ts, n, ev);

      if (r.ds18b20C != null && r.dht22C != null) {
        const d = Math.abs(r.ds18b20C - r.dht22C);
        this._step(c.SENSOR_DISAGREE, d > th.sensorDisagreeC, d <= th.sensorDisagreeC * 0.7, Math.round(d * 100) / 100, th.sensorDisagreeC, r.ts, n * 3, ev);
      }
      r.alarms = this.active();
      r.status = this.status(t);
      return ev;
    }

    active() { return CHANNELS.filter((c) => this.ch[c].active); }

    status(t) {
      const a = this.active();
      if (a.some((x) => CRITICAL.has(x) && x !== 'SENSOR_FAULT')) return 'ALARM';
      if (a.includes('SENSOR_FAULT')) return 'FAULT';
      if (a.length) return 'WARN';
      if (t != null && (t > this.th.tMax - this.th.warnMarginC || t < this.th.tMin + this.th.warnMarginC)) return 'WARN';
      return 'OK';
    }
  }

  CS.rules = { AlarmEngine, fuse, CRITICAL, CHANNELS, LABEL };
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
