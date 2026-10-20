/* Site WAN link between the cold store and Azure.
 * Modes: online · degraded (high latency, 12 % loss) · offline. The router can
 * also lose power (site power failure). A packet that is in flight when the
 * link drops is lost, exactly like a real TCP segment. */
(function (CS) {
  'use strict';
  const { NET } = CS.config;

  class NetworkLink {
    constructor(sim) {
      this.sim = sim;
      this.mode = 'online';
      this.routerPowered = true;
      this.history = [{ t: 0, up: true, mode: 'online' }];
      this.stats = { up: { bytes: 0, packets: 0, lost: 0 }, down: { bytes: 0, packets: 0, lost: 0 } };
    }

    get up() { return this.routerPowered && this.mode !== 'offline'; }
    get state() { return !this.routerPowered ? 'router-off' : this.mode; }
    params() { return NET[this.up ? this.mode : 'offline']; }

    _record() {
      const last = this.history[this.history.length - 1];
      if (last.up !== this.up || last.mode !== this.state) this.history.push({ t: this.sim.t, up: this.up, mode: this.state });
      this.sim.bus.emit('net', { mode: this.state, up: this.up });
    }

    setMode(mode) {
      if (mode === this.mode) return;
      const was = this.up;
      this.mode = mode;
      this.sim.log('NET', mode === 'offline' ? 'error' : mode === 'degraded' ? 'warn' : 'ok',
        mode === 'offline' ? 'WAN link DOWN — internet outage at the site'
          : mode === 'degraded' ? `WAN degraded: ~${NET.degraded.latency} ms latency, ${NET.degraded.loss * 100}% packet loss`
            : 'WAN link restored');
      this._record();
      if (was !== this.up) this.sim.metrics.linkChange(this.up);
    }

    setRouterPower(on) {
      if (on === this.routerPowered) return;
      const was = this.up;
      this.routerPowered = on;
      this.sim.log('NET', on ? 'ok' : 'error', on ? 'Router powered — WAN coming back' : 'Router lost power — no internet');
      this._record();
      if (was !== this.up) this.sim.metrics.linkChange(this.up);
    }

    oneWay(bytes) {
      const p = this.params();
      const rng = this.sim.rng;
      return Math.max(4, p.latency + Math.abs(rng.gauss(0, p.jitter))) + (p.kbps ? (bytes * 8) / p.kbps : 0);
    }

    /* Send `bytes` in direction 'up' (site → Azure) or 'down'. `meta.hops` is the
     * list of topology nodes the packet crosses (used only for animation). */
    send(dir, bytes, meta, onArrive, onLost) {
      const st = this.stats[dir];
      st.packets++; st.bytes += bytes;
      const hops = meta.hops;
      const routerIdx = Math.max(0, hops.indexOf('router'));
      if (!this.up) {
        st.lost++;
        this.sim.packet({ ...meta, dur: 140, lostAt: dir === 'up' ? routerIdx : Math.max(1, routerIdx - 1) });
        if (onLost) this.sim.schedule(1, () => onLost('unreachable'));
        return false;
      }
      const d = this.oneWay(bytes);
      const lost = this.sim.rng.chance(this.params().loss);
      this.sim.packet({ ...meta, dur: d, lostAt: lost ? Math.floor(hops.length / 2) : -1 });
      this.sim.schedule(d, () => {
        if (lost || !this.up) {
          st.lost++;
          if (onLost) onLost(lost ? 'lost' : 'link-down');
          return;
        }
        onArrive();
      });
      return true;
    }

    // Outage intervals as sim-time ranges, for chart shading and metrics
    outages(tEnd = this.sim.t) {
      const out = [];
      let open = null;
      this.history.forEach((h) => {
        if (!h.up && open == null) open = h;
        if (h.up && open) { out.push({ from: open.t, to: h.t, mode: open.mode }); open = null; }
      });
      if (open) out.push({ from: open.t, to: tEnd, mode: open.mode, ongoing: true });
      return out;
    }

    degradedIntervals(tEnd = this.sim.t) {
      const out = [];
      let open = null;
      this.history.forEach((h) => {
        if (h.mode === 'degraded' && !open) open = h;
        else if (h.mode !== 'degraded' && open) { out.push({ from: open.t, to: h.t }); open = null; }
      });
      if (open) out.push({ from: open.t, to: tEnd, ongoing: true });
      return out;
    }
  }

  CS.NetworkLink = NetworkLink;
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
