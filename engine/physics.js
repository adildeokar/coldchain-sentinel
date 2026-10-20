/* Cold-room thermal + humidity model. Same constants as
 * firmware/coldstore/sensors/simulated.py so both behave the same.
 *
 *   dT/dt = (k_leak + k_door·door) · (T_amb − T) − cooling · compressorRunning
 *
 * with an on/off thermostat (±1 °C around the set point). Integrated in 1 s steps. */
(function (CS) {
  'use strict';

  const K_LEAK = 3.6e-4, K_DOOR = 3.0e-3, COOLING = 0.035;

  class ColdRoom {
    constructor(profile = 'pharma') {
      this.setProfile(profile);
      this.temp = this.setpoint - 0.4;
      this.rh = this.baseRh;
      this.ambientT = 32;
      this.ambientRh = 80;
      this.doorOpen = false;
      this.compressorOn = true;
      this.compressorFailed = false;
      this.thermostatStuck = false;
      this.powerOk = true;
      this.surgeS = 0;
      this.runSeconds = 0;
      this.totalSeconds = 0;
    }

    setProfile(name) {
      const p = CS.config.PROFILES[name];
      this.profile = name;
      this.setpoint = p.setpoint;
      this.baseRh = p.baseRh;
    }

    get running() { return this.compressorOn && !this.compressorFailed && this.powerOk; }
    get dutyCycle() { return this.totalSeconds ? this.runSeconds / this.totalSeconds : 0; }

    step(dt) {
      if (this.thermostatStuck) this.compressorOn = true;
      else if (this.temp > this.setpoint + 1) this.compressorOn = true;
      else if (this.temp < this.setpoint - 1) this.compressorOn = false;

      const run = this.running;
      const k = K_LEAK + (this.doorOpen ? K_DOOR : 0);
      this.temp += (k * (this.ambientT - this.temp) - (run ? COOLING : 0)) * dt;

      let target = this.baseRh + (run ? -4 : 4), rate = 0.004;
      if (this.doorOpen) { target = this.ambientRh + 8; rate = 0.015; }
      if (this.surgeS > 0) { target = 94; rate = 0.01; this.surgeS -= dt; }
      this.rh += (target - this.rh) * rate * dt;
      this.rh = Math.min(99, Math.max(5, this.rh));

      this.totalSeconds += dt;
      if (run) this.runSeconds += dt;
    }
  }

  CS.ColdRoom = ColdRoom;
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
