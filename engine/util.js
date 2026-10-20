/* Shared helpers: seeded RNG, event emitter, priority queue, formatters.
 * Every engine file attaches to the global CS namespace, so the same file runs
 * in Node (server) and in the browser (util.js, config.js, rules.js are shared). */
(function (CS) {
  'use strict';

  // ---- seeded RNG (mulberry32) — experiments must be reproducible ----------
  class Rng {
    constructor(seed = 1) { this.s = seed >>> 0; }
    next() {
      let t = (this.s += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(a, b) { return a + (b - a) * this.next(); }
    int(a, b) { return Math.floor(this.range(a, b + 1)); }
    chance(p) { return this.next() < p; }
    gauss(mu = 0, sd = 1) {
      const u = 1 - this.next(), v = this.next();
      return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    hex(n) { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(this.next() * 16).toString(16); return s; }
  }

  // ---- event emitter --------------------------------------------------------
  class Emitter {
    constructor() { this.h = {}; }
    on(evt, fn) { (this.h[evt] = this.h[evt] || []).push(fn); return () => this.off(evt, fn); }
    off(evt, fn) { this.h[evt] = (this.h[evt] || []).filter((f) => f !== fn); }
    emit(evt, data) {
      (this.h[evt] || []).forEach((f) => f(data));
      (this.h['*'] || []).forEach((f) => f(evt, data));
    }
  }

  // ---- binary heap keyed on (time, insertion order) -------------------------
  class PQ {
    constructor() { this.a = []; this.n = 0; }
    get size() { return this.a.length; }
    peek() { return this.a[0]; }
    push(item) {
      item._o = this.n++;
      const a = this.a; a.push(item);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this._lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
      }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && this._lt(a[l], a[m])) m = l;
          if (r < a.length && this._lt(a[r], a[m])) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]]; i = m;
        }
      }
      return top;
    }
    _lt(x, y) { return x.t < y.t || (x.t === y.t && x._o < y._o); }
  }

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  const fmt = {
    time(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; },
    timeMs(ms) { const d = new Date(ms); return `${fmt.time(ms)}.${pad(d.getMilliseconds(), 3)}`; },
    iso(ms) { return new Date(ms).toISOString(); },
    dur(ms) {
      if (ms == null || !isFinite(ms)) return '—';
      if (ms < 1) return `${ms.toFixed(2)} ms`;
      if (ms < 1000) return `${Math.round(ms)} ms`;
      if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
      const total = Math.round(ms / 1000), m = Math.floor(total / 60), s = total % 60;
      return m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)} m` : `${m} m ${pad(s)} s`;
    },
    bytes(n) {
      if (n == null) return '—';
      if (n < 1024) return `${Math.round(n)} B`;
      if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1048576).toFixed(2)} MB`;
    },
    num(v, d = 1) { return v == null || !isFinite(v) ? '—' : Number(v).toFixed(d); },
    pct(v, d = 1) { return v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(d)} %`; },
    clock(ms) { const s = Math.floor(ms / 1000); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; },
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  const utf8Len = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c < 0xdc00) ? (i++, 4) : 3; }
    return n;
  };
  const jsonSize = (obj) => utf8Len(JSON.stringify(obj));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const pctile = (a, p) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };

  CS.util = { Rng, Emitter, PQ, fmt, clamp, round, utf8Len, jsonSize, mean, pctile, pad };
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
