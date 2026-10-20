/* Baseline for the comparison: a "cloud-only" node on the same sensors and the
 * same WAN link, with NO edge intelligence:
 *   • no local rule engine, no buzzer — alarms come only from Stream Analytics in the cloud
 *   • no persistent buffer — a reading taken while offline is dropped
 *   • QoS 1 without retry — a reading whose PUBACK times out is given up
 * This is how many simple IoT prototypes are built, which is what makes it the
 * right yardstick for "alert response time and data loss, connected vs disconnected". */
(function (CS) {
  'use strict';
  const { fmt } = CS.util;
  const { fuse } = CS.rules;

  class BaselineDevice extends CS.MqttDevice {
    constructor(sim, overrides = {}) {
      const cfg = { ...CS.config.DEFAULTS, ...overrides };
      super(sim, cfg.baselineId, 'base', cfg);
      this.logSrc = 'BASE';
      this.seq = 1;
      this.stats2 = { generated: 0, sent: 0, droppedOffline: 0, droppedTimeout: 0 };
      this.last = null;
    }

    start() {
      const ms = this.cfg.sampleIntervalS * 1000;
      this.sampler = this.sim.every(ms, () => this.sample(), ms - (this.sim.t % ms));
      this.connect();
    }

    sample() {
      const sim = this.sim, f = sim.sensors.sample();
      const seq = this.seq++;
      const tempC = fuse(f.ds18b20C, f.dht22C);
      const cond = sim.link.up ? 'connected' : 'disconnected';
      this.stats2.generated++;
      sim.metrics.generated('base', seq, cond, f.ts);
      this.last = { seq, ts: f.ts, tempC, rh: f.rh };
      const body = { type: 'telemetry', deviceId: this.id, seq, ts: fmt.iso(f.ts), tempC, rh: f.rh, door: f.door ? 'open' : 'closed', status: 'RAW' };
      if (!this.connected) {
        this.stats2.droppedOffline++;
        sim.metrics.dropped('base', seq);
        if (this.stats2.droppedOffline % 6 === 1) sim.log('BASE', 'warn', `offline — reading #${seq} discarded (no local buffer), ${this.stats2.droppedOffline} lost so far`);
        return;
      }
      if (this.publish('telemetry', body, { type: 'telemetry', alert: 'false' }, { seq })) this.stats2.sent++;
    }

    onTimeout(e) {
      this.stats2.droppedTimeout++;      // may still have reached the hub if only the PUBACK was lost
    }

    onDisconnected() { this.lostAt = this.sim.t; }
    onConnected() { this.lostAt = null; }
  }

  CS.BaselineDevice = BaselineDevice;
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
