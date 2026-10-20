/* Canvas charts with no library (the app must work offline, no CDN).
 *   TimeChart  multi-series time plot, safe band, shaded outage regions, alert markers, gaps, hover
 *   BarChart   grouped bars, optional log scale
 *   gauge()    SVG arc gauge with the safe range highlighted */
(function (CS) {
  'use strict';
  const { fmt } = CS.util;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || getComputedStyle(document.body).getPropertyValue(name).trim();
  function alpha(color, a) {
    if (color.startsWith('#')) {
      const n = color.length === 4 ? color.slice(1).split('').map((c) => c + c).join('') : color.slice(1);
      const v = parseInt(n, 16);
      return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
    }
    return color;
  }

  class TimeChart {
    constructor(host, opts = {}) {
      this.host = host;
      this.o = { height: 240, gapMs: 30000, yPad: 0.12, yUnit: '', yFmt: (v) => v.toFixed(1), ...opts };
      host.classList.add('chart');
      this.canvas = document.createElement('canvas');
      this.canvas.style.height = this.o.height + 'px';
      this.tipEl = document.createElement('div');
      this.tipEl.className = 'c-tip';
      this.tipEl.hidden = true;
      host.append(this.canvas, this.tipEl);
      this.data = { series: [] };
      this.hover = null;
      this.canvas.addEventListener('mousemove', (e) => { const r = this.canvas.getBoundingClientRect(); this.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; this.draw(); });
      this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.tipEl.hidden = true; this.draw(); });
      if (window.ResizeObserver) new ResizeObserver(() => this.draw()).observe(host);
    }

    set(data) { this.data = data; this.draw(); }

    draw() {
      const c = this.canvas, dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = this.o.height;
      if (!W) return;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const d = this.data, series = d.series || [];
      const L = 44, R = 12, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
      const line = css('--line'), muted = css('--muted'), faint = css('--faint');
      const x0 = d.x0, x1 = d.x1;
      if (x0 == null || x1 == null || x1 <= x0) return;

      let ymin = Infinity, ymax = -Infinity;
      series.forEach((s) => s.data.forEach((p) => { if (p.x >= x0 && p.x <= x1 && p.y != null) { ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y); } }));
      if (d.band) { ymin = Math.min(ymin, d.band.min); ymax = Math.max(ymax, d.band.max); }
      if (d.yMin != null) ymin = Math.min(ymin, d.yMin);
      if (d.yMax != null) ymax = Math.max(ymax, d.yMax);
      if (!isFinite(ymin)) { ymin = 0; ymax = 1; }
      const pad = (ymax - ymin || 1) * this.o.yPad;
      ymin -= pad; ymax += pad;
      const X = (x) => L + ((x - x0) / (x1 - x0)) * pw;
      const Y = (y) => T + (1 - (y - ymin) / (ymax - ymin)) * ph;
      this._geom = { X, Y, L, R, T, B, pw, ph, x0, x1, ymin, ymax, W, H };

      // regions (outages etc.)
      (d.regions || []).forEach((r) => {
        const a = Math.max(X(r.from), L), b = Math.min(X(r.to), L + pw);
        if (b <= a) return;
        g.fillStyle = r.color; g.fillRect(a, T, b - a, ph);
        if (r.label && b - a > 50) { g.fillStyle = r.text || muted; g.font = '600 10px Inter, Segoe UI, sans-serif'; g.fillText(r.label, a + 4, T + 12); }
      });
      // safe band
      if (d.band) {
        const ok = css('--ok');
        g.fillStyle = alpha(ok, 0.07);
        g.fillRect(L, Y(d.band.max), pw, Y(d.band.min) - Y(d.band.max));
        g.strokeStyle = alpha(css('--err'), 0.75); g.setLineDash([5, 4]); g.lineWidth = 1;
        [d.band.min, d.band.max].forEach((v) => { g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + pw, Y(v)); g.stroke(); });
        g.setLineDash([]);
        g.fillStyle = alpha(css('--err'), 0.9); g.font = '600 9.5px JetBrains Mono, Consolas, monospace';
        g.fillText(`max ${d.band.max}${this.o.yUnit}`, L + pw - 70, Y(d.band.max) - 3);
        g.fillText(`min ${d.band.min}${this.o.yUnit}`, L + pw - 70, Y(d.band.min) + 11);
      }
      // grid + axes
      g.strokeStyle = alpha(line.startsWith('#') ? line : '#233150', 0.9); g.lineWidth = 1;
      g.fillStyle = muted; g.font = '10px JetBrains Mono, Consolas, monospace';
      const yt = niceTicks(ymin, ymax, 5);
      yt.forEach((v) => { const y = Y(v); g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.globalAlpha = 0.5; g.stroke(); g.globalAlpha = 1; g.textAlign = 'right'; g.fillText(this.o.yFmt(v), L - 6, y + 3); });
      const span = x1 - x0;
      const step = [5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5].find((s) => span / s <= Math.max(3, pw / 90)) || 144e5;
      g.textAlign = 'center';
      for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) {
        const x = X(t);
        g.globalAlpha = 0.35; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.globalAlpha = 1;
        g.fillStyle = faint; g.fillText(step < 60000 ? fmt.time(t) : fmt.time(t).slice(0, 5), x, H - 8);
      }
      // series
      series.forEach((s) => {
        const pts = s.data.filter((p) => p.x >= x0 - this.o.gapMs && p.x <= x1 + this.o.gapMs);
        const stride = Math.max(1, Math.floor(pts.length / (pw * 1.5)));
        g.strokeStyle = s.color; g.lineWidth = s.width || 1.8; g.setLineDash(s.dash || []);
        g.beginPath();
        let prev = null;
        for (let i = 0; i < pts.length; i += stride) {
          const p = pts[i];
          if (p.y == null) { prev = null; continue; }
          const x = X(p.x), y = Y(p.y);
          if (!prev || p.x - prev.x > (s.gapMs || this.o.gapMs)) g.moveTo(x, y); else g.lineTo(x, y);
          prev = p;
        }
        g.stroke(); g.setLineDash([]);
        if (s.pointColor) {
          for (let i = 0; i < pts.length; i += stride) {
            const p = pts[i], col = s.pointColor(p);
            if (!col || p.y == null) continue;
            g.fillStyle = col; g.beginPath(); g.arc(X(p.x), Y(p.y), s.pointR || 2.2, 0, 7); g.fill();
          }
        }
      });
      // markers
      (d.markers || []).forEach((m) => {
        if (m.x < x0 || m.x > x1) return;
        const x = X(m.x);
        g.strokeStyle = m.color; g.lineWidth = 1.2; g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.setLineDash([]);
        g.fillStyle = m.color; g.beginPath(); g.moveTo(x - 5, T); g.lineTo(x + 5, T); g.lineTo(x, T + 7); g.fill();
      });
      g.strokeStyle = alpha(muted.startsWith('#') ? muted : '#8193b3', 0.6);
      g.strokeRect(L + 0.5, T + 0.5, pw, ph);

      // hover
      if (this.hover && this.hover.x >= L && this.hover.x <= L + pw) {
        const xt = x0 + ((this.hover.x - L) / pw) * (x1 - x0);
        g.strokeStyle = muted; g.lineWidth = 1; g.beginPath(); g.moveTo(this.hover.x, T); g.lineTo(this.hover.x, T + ph); g.stroke();
        const rows = [`<b>${fmt.time(xt)}</b>`];
        series.forEach((s) => {
          const p = nearest(s.data, xt);
          if (!p || Math.abs(p.x - xt) > (s.gapMs || this.o.gapMs)) return;
          g.fillStyle = s.color; g.beginPath(); g.arc(X(p.x), Y(p.y), 3.5, 0, 7); g.fill();
          rows.push(`<span style="color:${s.color}">●</span> ${s.name}: ${p.y == null ? '—' : this.o.yFmt(p.y)}${this.o.yUnit}${p.tag ? ' <i style="color:' + css('--warn') + '">' + p.tag + '</i>' : ''}`);
        });
        const m = (d.markers || []).find((mk) => Math.abs(X(mk.x) - this.hover.x) < 5);
        if (m) rows.push(`<span style="color:${m.color}">▼</span> ${m.label}`);
        const r = (d.regions || []).find((rg) => xt >= rg.from && xt <= rg.to);
        if (r && r.label) rows.push(`<span style="color:${css('--warn')}">▮</span> ${r.label}`);
        this.tipEl.innerHTML = rows.join('<br>');
        this.tipEl.hidden = false;
        const tw = this.tipEl.offsetWidth;
        this.tipEl.style.left = Math.min(W - tw - 4, this.hover.x + 12) + 'px';
        this.tipEl.style.top = Math.max(0, this.hover.y - 30) + 'px';
      }
    }
  }

  function nearest(arr, x) {
    if (!arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m].x < x) lo = m; else hi = m; }
    return Math.abs(arr[lo].x - x) < Math.abs(arr[hi].x - x) ? arr[lo] : arr[hi];
  }

  function niceTicks(a, b, n) {
    const span = b - a, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  class BarChart {
    constructor(host, opts = {}) {
      this.host = host;
      this.o = { height: 240, log: false, fmt: (v) => v.toFixed(1), unit: '', ...opts };
      host.classList.add('chart');
      this.canvas = document.createElement('canvas');
      this.canvas.style.height = this.o.height + 'px';
      this.tipEl = document.createElement('div'); this.tipEl.className = 'c-tip'; this.tipEl.hidden = true;
      host.append(this.canvas, this.tipEl);
      this.canvas.addEventListener('mousemove', (e) => { const r = this.canvas.getBoundingClientRect(); this.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; this.draw(); });
      this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.tipEl.hidden = true; this.draw(); });
      if (window.ResizeObserver) new ResizeObserver(() => this.draw()).observe(host);
    }
    set(d) { this.d = d; this.draw(); }
    draw() {
      const d = this.d; if (!d) return;
      const c = this.canvas, dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = this.o.height;
      if (!W) return;
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const L = 54, R = 10, T = 14, B = 40, pw = W - L - R, ph = H - T - B;
      const vals = d.series.flatMap((s) => s.values).filter((v) => v != null && isFinite(v));
      let vmax = Math.max(...vals, 1e-9);
      const log = this.o.log;
      const lmin = log ? Math.floor(Math.log10(Math.max(Math.min(...vals.filter((v) => v > 0), vmax), 1e-3))) : 0;
      const lmax = log ? Math.ceil(Math.log10(vmax)) : 0;
      if (!log) vmax *= 1.15;
      const Y = (v) => log ? T + ph - ((Math.log10(Math.max(v, 10 ** lmin)) - lmin) / Math.max(1, lmax - lmin)) * ph : T + ph - (v / vmax) * ph;
      const muted = css('--muted'), faint = css('--faint');
      g.font = '10px JetBrains Mono, Consolas, monospace'; g.fillStyle = faint; g.strokeStyle = css('--line'); g.textAlign = 'right';
      const ticks = log ? Array.from({ length: lmax - lmin + 1 }, (_, i) => 10 ** (lmin + i)) : niceTicks(0, vmax, 4);
      ticks.forEach((v) => { const y = Y(v); g.globalAlpha = 0.5; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.globalAlpha = 1; g.fillText(this.o.fmt(v), L - 6, y + 3); });
      const nc = d.categories.length, ns = d.series.length;
      const cw = pw / nc, bw = Math.min(44, (cw * 0.78) / ns);
      this._hit = [];
      d.categories.forEach((cat, ci) => {
        const cx = L + cw * ci + cw / 2;
        d.series.forEach((s, si) => {
          const v = s.values[ci];
          const x = cx - (ns * bw) / 2 + si * bw;
          if (v == null) {
            g.fillStyle = faint; g.textAlign = 'center'; g.font = '600 9px Inter, sans-serif';
            g.fillText(s.nullLabel || 'n/a', x + bw / 2, T + ph - 6);
            return;
          }
          const y = Y(v);
          g.fillStyle = s.color; g.fillRect(x + 1, y, bw - 2, T + ph - y);
          this._hit.push({ x, w: bw, y, v, s: s.name, cat });
          if (this.o.labels !== false && bw > 22) { g.fillStyle = css('--text2'); g.textAlign = 'center'; g.font = '600 9.5px JetBrains Mono, Consolas, monospace'; g.fillText(this.o.fmt(v), x + bw / 2, y - 4); }
        });
        g.fillStyle = muted; g.textAlign = 'center'; g.font = '600 10.5px Inter, Segoe UI, sans-serif';
        wrap(g, cat, cx, T + ph + 14, cw - 6);
      });
      g.strokeStyle = muted; g.globalAlpha = 0.6; g.beginPath(); g.moveTo(L, T + ph + 0.5); g.lineTo(L + pw, T + ph + 0.5); g.stroke(); g.globalAlpha = 1;
      if (this.hover) {
        const hit = this._hit.find((b) => this.hover.x >= b.x && this.hover.x <= b.x + b.w && this.hover.y >= b.y - 4);
        if (hit) {
          this.tipEl.innerHTML = `<b>${hit.cat}</b><br>${hit.s}: ${this.o.fmtLong ? this.o.fmtLong(hit.v) : this.o.fmt(hit.v)}`;
          this.tipEl.hidden = false;
          this.tipEl.style.left = Math.min(W - this.tipEl.offsetWidth - 4, this.hover.x + 10) + 'px';
          this.tipEl.style.top = Math.max(0, this.hover.y - 36) + 'px';
        } else this.tipEl.hidden = true;
      }
    }
  }

  function wrap(g, text, x, y, w) {
    const words = String(text).split(' ');
    let line = '', ln = 0;
    words.forEach((wd) => {
      const test = line ? line + ' ' + wd : wd;
      if (g.measureText(test).width > w && line) { g.fillText(line, x, y + ln * 12); line = wd; ln++; } else line = test;
    });
    g.fillText(line, x, y + ln * 12);
  }

  // Semi-circular gauge (SVG). Returns the svg element; call again to update.
  function gauge(host, o) {
    const { s } = CS.dom;
    const min = o.min, max = o.max, R = 70, cx = 90, cy = 88;
    const ang = (v) => Math.PI * (1 - (Math.min(max, Math.max(min, v)) - min) / (max - min));
    const pt = (a, r = R) => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
    const arc = (a0, a1) => { const [x0, y0] = pt(a0), [x1, y1] = pt(a1); return `M${x0} ${y0} A${R} ${R} 0 ${Math.abs(a1 - a0) > Math.PI ? 1 : 0} 1 ${x1} ${y1}`; };
    let svg = host.querySelector('svg.gauge');
    if (!svg) {
      svg = s('svg', { class: 'gauge', viewBox: '0 0 180 120' },
        s('path', { class: 'g-track', d: arc(Math.PI, 0) }),
        s('path', { class: 'g-safe', d: arc(ang(o.safeMax), ang(o.safeMin)) }),
        s('path', { class: 'g-val', d: arc(Math.PI, Math.PI - 0.0001) }),
        s('text', { class: 'g-text', x: cx, y: cy - 8 }),
        s('text', { class: 'g-sub', x: cx, y: cy + 12 }),
        s('text', { class: 'g-tick', x: 20, y: cy + 16 }, String(min)),
        s('text', { class: 'g-tick', x: 160, y: cy + 16 }, String(max)));
      host.appendChild(svg);
    }
    const [track, safe, val, txt, sub] = svg.children;
    safe.setAttribute('d', arc(ang(o.safeMax), ang(o.safeMin)));
    track.setAttribute('d', arc(Math.PI, 0));
    if (o.value == null) { val.setAttribute('d', ''); txt.textContent = '—'; }
    else {
      val.setAttribute('d', arc(Math.PI, Math.min(Math.PI - 0.0001, ang(o.value))));
      const bad = o.value > o.safeMax || o.value < o.safeMin;
      const near = !bad && (o.value > o.safeMax - (o.warn || 0) || o.value < o.safeMin + (o.warn || 0));
      val.style.stroke = bad ? css('--err') : near ? css('--warn') : css('--ok');
      txt.textContent = o.value.toFixed(o.digits ?? 1) + o.unit;
    }
    sub.textContent = o.label || '';
    return svg;
  }

  function sparkline(canvas, values, color, band) {
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W) return;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const v = values.filter((x) => x != null);
    if (v.length < 2) return;
    let lo = Math.min(...v), hi = Math.max(...v);
    if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
    const p = (hi - lo || 1) * 0.1; lo -= p; hi += p;
    const Y = (y) => H - ((y - lo) / (hi - lo)) * H;
    if (band) { g.fillStyle = alpha(css('--ok'), 0.08); g.fillRect(0, Y(band[1]), W, Y(band[0]) - Y(band[1])); g.strokeStyle = alpha(css('--err'), 0.6); g.setLineDash([3, 3]); [band[0], band[1]].forEach((b) => { g.beginPath(); g.moveTo(0, Y(b)); g.lineTo(W, Y(b)); g.stroke(); }); g.setLineDash([]); }
    g.strokeStyle = color; g.lineWidth = 1.6; g.beginPath();
    values.forEach((y, i) => { if (y == null) return; const x = (i / (values.length - 1)) * W; i ? g.lineTo(x, Y(y)) : g.moveTo(x, Y(y)); });
    g.stroke();
  }

  CS.charts = { TimeChart, BarChart, gauge, sparkline, css, alpha };
})(window.CS = window.CS || {});
