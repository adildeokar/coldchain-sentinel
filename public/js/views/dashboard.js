/* Operator dashboard — built ONLY from what Azure holds (Cosmos telemetry + alerts
 * + SignalR connection state), exactly as the deployed web app would see it. */
(function (CS) {
  'use strict';
  const { h, esc, badge } = CS.dom;
  const { fmt } = CS.util;

  // Mean kinetic temperature (USP <1079>): ΔH/R = 10 000 K
  function mkt(temps) {
    const v = temps.filter((t) => t != null);
    if (!v.length) return null;
    const k = 10000;
    const s = v.reduce((a, t) => a + Math.exp(-k / (t + 273.15)), 0) / v.length;
    return k / -Math.log(s) - 273.15;
  }

  const dash = {
    init(app, el) {
      this.app = app;
      this.range = 30 * 60000;
      el.innerHTML = '';
      el.appendChild(h('div', { class: 'view-h' }, h('div', null, h('h2', null, 'Operator dashboard'),
        h('div', { class: 'desc' }, 'The web app staff use: Azure Static Web App + SignalR, reading from Cosmos DB. It knows only what reached the cloud. During an outage it shows "device offline" and a gap, and the gap back-fills (amber points) once the Pi syncs its queue.')),
        h('div', { class: 'tools' }, h('button', { class: 'btn', onclick: () => this.exportCsv() }, '⤓ Export CSV'))));
      const br = h('div', { class: 'browser' },
        h('div', { class: 'browser-bar' }, h('span', { class: 'dots' }, h('i', { style: { background: '#ef4444' } }), h('i', { style: { background: '#f59e0b' } }), h('i', { style: { background: '#22c55e' } })),
          h('span', { class: 'url' }, '🔒 https://coldchain-dashboard.azurestaticapps.net/rooms/cold-room-1'), this.live = h('span', { class: 'badge ok' }, '● LIVE')),
        this.body = h('div', { class: 'browser-body' }));
      el.appendChild(br);
      const B = this.body;
      B.appendChild(this.banner = h('div', { class: 'dash-banner' }, h('span', { class: 'dot' }), h('div', null, this.bannerT = h('div', { class: 'big' }, '—'), this.bannerS = h('div', { class: 'muted' }, '')), h('span', { class: 'sp' }), this.bannerR = h('div', { style: 'text-align:right' })));
      const top = h('div', { class: 'grid g4' });
      B.appendChild(top);
      top.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Temperature')), this.gT = h('div', { class: 'card-b', style: 'padding:6px 18px' })));
      top.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Humidity')), this.gH = h('div', { class: 'card-b', style: 'padding:6px 18px' })));
      top.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Device & link')), this.devC = h('div', { class: 'card-b' })));
      top.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Compliance (range)')), this.compC = h('div', { class: 'card-b' })));
      B.appendChild(this.kpi = h('div', { class: 'grid g6 mt' }));

      const rangeBtns = h('div', { class: 'seg' }, ...[['10 min', 6e5], ['30 min', 18e5], ['1 h', 36e5], ['6 h', 216e5], ['All', 0]].map(([l, ms]) =>
        h('button', { class: ms === this.range ? 'on' : '', onclick: (e) => { this.range = ms; [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target)); this.render(app); } }, l)));
      this.showEdge = h('input', { type: 'checkbox' });
      this.showBase = h('input', { type: 'checkbox', checked: true });
      B.appendChild(h('div', { class: 'card mt' },
        h('div', { class: 'card-h' }, h('h3', null, 'Temperature history'), h('span', { class: 'sub' }, 'Cosmos DB · shaded = device offline'),
          h('div', { class: 'right' }, h('label', { class: 'chk' }, this.showBase, 'baseline node'), h('label', { class: 'chk' }, this.showEdge, 'edge local truth (debug)'), rangeBtns)),
        h('div', { class: 'card-b' }, this.legend('t'), this.cT = h('div'), h('div', { class: 'small muted mt' }, 'Humidity'), this.legend('h'), this.cH = h('div'))));
      this.tChart = new CS.charts.TimeChart(this.cT, { height: 260, yUnit: ' °C', yFmt: (v) => v.toFixed(1) });
      this.hChart = new CS.charts.TimeChart(this.cH, { height: 150, yUnit: ' %', yFmt: (v) => v.toFixed(0) });

      const low = h('div', { class: 'grid g2 mt' });
      B.appendChild(low);
      low.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Alerts'), h('span', { class: 'sub' }, 'Cosmos container "alerts" via SignalR')), this.alerts = h('div', { class: 'card-b flush scroll', style: 'max-height:330px' })));
      low.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Data completeness'), h('span', { class: 'sub' }, 'readings in the cloud vs readings taken')), this.compl = h('div', { class: 'card-b' })));
    },

    legend(kind) {
      const c = CS.charts.css;
      const items = kind === 't'
        ? [['line', c('--accent'), 'edge (live)'], ['dot', c('--warn'), 'back-filled after outage'], ['line', c('--faint'), 'baseline (cloud-only)'], ['band', CS.charts.alpha(c('--ok'), 0.25), 'safe range'], ['band', CS.charts.alpha(c('--warn'), 0.3), 'offline'], ['dot', c('--err'), 'alert raised']]
        : [['line', c('--teal'), 'edge RH'], ['dot', c('--warn'), 'back-filled']];
      return h('div', { class: 'chart-legend' }, ...items.map(([t, col, l]) => h('span', null, h('i', { class: t, style: { background: col } }), l)));
    },

    render(app) {
      const sim = app.sim, c = sim.cloud, id = sim.edge.id, th = sim.edge.th, now = sim.now();
      const dd = c.dash[id], last = dd.last;
      const css = CS.charts.css;
      const activeAlerts = c.alerts.filter((a) => a.deviceId === id && a.state === 'RAISED' && !a.clearedAt);
      const critical = activeAlerts.filter((a) => CS.rules.CRITICAL.has(a.alarm));
      const offline = dd.conn === 'offline';
      const stale = last ? now - last.receivedAt > 3 * sim.edge.cfg.sampleIntervalS * 1000 : true;
      let cls = 'safe', title = 'COLD ROOM 1 — SAFE', sub = 'All readings within limits';
      if (critical.length) { cls = 'alarm'; title = `ALARM — ${critical.map((a) => CS.rules.LABEL[a.alarm]).join(', ')}`; sub = `since ${fmt.time(Date.parse(critical[critical.length - 1].firstBreachAt))} · local buzzer active at site`; }
      else if (offline || (stale && last)) { cls = 'offline'; title = 'DEVICE OFFLINE — edge is buffering'; sub = `last data ${last ? fmt.dur(now - last.receivedAt) + ' ago' : '—'} · the Pi keeps alarming locally; history will back-fill on reconnect`; }
      else if (activeAlerts.length || (last && last.status === 'WARN')) { cls = 'warn'; title = activeAlerts.length ? `WARNING — ${activeAlerts.map((a) => CS.rules.LABEL[a.alarm]).join(', ')}` : 'WARNING — near limit'; }
      else if (!last) { cls = ''; title = 'Waiting for first reading…'; sub = ''; }
      this.banner.className = 'dash-banner ' + cls;
      this.bannerT.textContent = title;
      this.bannerS.textContent = sub;
      this.bannerR.innerHTML = `<div class="mono" style="font-size:22px;font-weight:700">${last && last.tempC != null ? last.tempC.toFixed(1) + ' °C' : '—'}</div><div class="small muted">${last ? 'measured ' + fmt.time(last.ts) : ''}</div>`;
      this.live.className = 'badge ' + (offline ? 'err' : 'ok');
      this.live.textContent = offline ? '● OFFLINE' : '● LIVE';

      CS.charts.gauge(this.gT, { min: th.tMin - 6, max: th.tMax + 8, value: last ? last.tempC : null, safeMin: th.tMin, safeMax: th.tMax, unit: '°', label: `safe ${th.tMin}…${th.tMax} °C`, warn: sim.edge.th.warnMarginC });
      CS.charts.gauge(this.gH, { min: 0, max: 100, value: last ? last.rh : null, safeMin: th.hMin, safeMax: th.hMax, unit: '%', label: `safe ${th.hMin}…${th.hMax} %RH`, digits: 0 });
      const rep = c.devices[id].twin.reported;
      this.devC.innerHTML = `<div class="kv">
        <div>Connection</div><div>${badge(offline ? 'OFFLINE' : 'ONLINE', offline ? 'err' : 'ok')} since ${fmt.time(sim.startEpoch + dd.since)}</div>
        <div>Last data</div><div>${last ? fmt.dur(now - last.receivedAt) + ' ago' : '—'}</div>
        <div>Door</div><div>${last ? (last.door === 'open' ? badge('OPEN', 'warn') : 'closed') : '—'}</div>
        <div>Queue (twin)</div><div>${rep.queueDepth ?? '—'} rows</div>
        <div>Firmware</div><div>${rep.firmware || '—'}</div>
        <div>Limits</div><div>${th.tMin}…${th.tMax} °C</div></div>`;

      const from = this.range ? now - this.range : sim.startEpoch;
      const docs = c.docs(id, from);
      const temps = docs.map((d) => d.tempC);
      const inRange = docs.filter((d) => d.tempC != null && d.tempC >= th.tMin && d.tempC <= th.tMax).length;
      const m = mkt(temps);
      this.compC.innerHTML = `<div class="kv"><div>Time in range</div><div style="font-size:18px;font-weight:700;color:${docs.length && inRange / docs.length < 0.98 ? css('--warn') : css('--ok')}">${docs.length ? ((inRange / docs.length) * 100).toFixed(1) + ' %' : '—'}</div>
        <div>MKT</div><div>${m != null ? m.toFixed(2) + ' °C' : '—'}</div>
        <div>Min / max</div><div>${temps.length ? Math.min(...temps.filter((x) => x != null)).toFixed(1) + ' / ' + Math.max(...temps.filter((x) => x != null)).toFixed(1) + ' °C' : '—'}</div>
        <div>Excursions</div><div>${c.alerts.filter((a) => a.deviceId === id && a.state === 'RAISED' && /TEMP/.test(a.alarm) && Date.parse(a.firstBreachAt) >= from).length}</div></div>`;

      const back = docs.filter((d) => d.backfilled).length;
      const valid = temps.filter((x) => x != null);
      const k = [
        ['Avg temp', valid.length ? (valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(2) + ' °C' : '—', 'selected range'],
        ['Readings in cloud', docs.length.toLocaleString(), 'edge device'],
        ['Back-filled', back.toLocaleString(), 'synced after outages', back ? 'warn' : ''],
        ['Active alerts', activeAlerts.length, critical.length ? 'critical!' : 'none critical', critical.length ? 'err' : activeAlerts.length ? 'warn' : 'ok'],
        ['E2E latency', c.liveLatencyN ? fmt.dur(c.liveLatencyMean) : '—', 'sensor → screen (live)'],
        ['Notifications', c.notifications.length, 'SMS / e-mail / Teams'],
      ];
      this.kpi.innerHTML = k.map(([l, v, s2, kd]) => `<div class="kpi ${kd || ''}"><div class="k-l">${l}</div><div class="k-v" style="font-size:19px">${esc(v)}</div><div class="k-s">${esc(s2)}</div></div>`).join('');

      // charts
      const x1 = now, x0 = this.range ? now - this.range : sim.startEpoch;
      const regions = this.offlineRegions(sim);
      const series = [];
      if (this.showBase.checked) series.push({ name: 'baseline', color: css('--faint'), width: 1.2, data: c.docs(sim.baseline.id, x0 - 60000).map((d) => ({ x: d.ts, y: d.tempC })) });
      if (this.showEdge.checked) series.push({ name: 'edge local', color: css('--violet'), width: 1, dash: [3, 3], data: sim.edge.history.filter((x) => x.ts >= x0 - 60000).map((x) => ({ x: x.ts, y: x.t })) });
      series.push({ name: 'edge (cloud)', color: css('--accent'), width: 2, data: c.docs(id, x0 - 60000).map((d) => ({ x: d.ts, y: d.tempC, tag: d.backfilled ? 'back-filled' : '' })), pointColor: (p) => (p.tag ? css('--warn') : null), pointR: 2.4 });
      const markers = c.alerts.filter((a) => a.deviceId === id && a.state === 'RAISED').map((a) => ({ x: Date.parse(a.firstBreachAt), color: css('--err'), label: `${a.alertId} ${a.alarm}` }));
      this.tChart.set({ x0, x1, series, band: { min: th.tMin, max: th.tMax }, regions, markers });
      this.hChart.set({ x0, x1, series: [{ name: 'RH', color: css('--teal'), width: 1.8, data: c.docs(id, x0 - 60000).map((d) => ({ x: d.ts, y: d.rh, tag: d.backfilled ? 'back-filled' : '' })), pointColor: (p) => (p.tag ? css('--warn') : null), pointR: 2 }], band: { min: th.hMin, max: th.hMax }, regions, yMin: Math.max(0, th.hMin - 10), yMax: Math.min(100, th.hMax + 10) });

      // alerts table
      const list = c.alerts.filter((a) => a.state === 'RAISED').slice(0, 30);
      this.alerts.innerHTML = list.length ? `<table class="tbl compact"><thead><tr><th>First breach</th><th>Node</th><th>Alarm</th><th class="num">Value</th><th>Status</th><th class="num">Local buzzer</th><th class="num">SMS sent</th><th></th></tr></thead><tbody>${list.map((a) => {
        const edge = a.deviceId === id;
        return `<tr class="${a.deliveredLate ? 'hl' : ''}"><td class="mono">${fmt.time(Date.parse(a.firstBreachAt))}</td><td class="small">${edge ? 'edge' : 'baseline'}</td><td class="mono">${a.alarm}</td><td class="num">${a.value ?? '—'}</td><td>${a.clearedAt ? badge('cleared ' + fmt.time(a.clearedAt), 'ok') : badge('ACTIVE', 'err')}</td><td class="num">${a.latency.localAlarmMs != null ? '+' + fmt.dur(a.latency.localAlarmMs) : '<span class="faint">none</span>'}</td><td class="num">${a.latency.notifyMs != null ? '+' + fmt.dur(a.latency.notifyMs) : '…'}${a.deliveredLate ? ' ' + badge('late', 'warn') : ''}</td><td>${edge && !a.clearedAt ? `<button class="btn sm" data-ack="${a.alertId}">Silence</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="card-b muted">No alerts. Inject a fault in Live Simulation.</div>';
      this.alerts.querySelectorAll('[data-ack]').forEach((b) => (b.onclick = () => sim.cloud.invokeMethod(id, 'silenceAlarm', {}, (r) => app.toast(`silenceAlarm → ${r.status}`, r.status === 200 ? `buzzer silenced (round trip ${fmt.dur(r.latencyMs)})` : r.result.message, r.status === 200 ? 'ok' : 'err'))));

      const mm = sim.metrics.summary();
      const bar = (lbl, del, gen, col) => `<div style="margin-bottom:10px"><div class="row"><b>${lbl}</b><span class="sp"></span><span class="mono">${del.toLocaleString()} / ${gen.toLocaleString()} (${gen ? ((del / gen) * 100).toFixed(1) : '—'} %)</span></div><div style="height:12px;background:var(--panel3);border-radius:6px;overflow:hidden;margin-top:4px"><div style="height:100%;width:${gen ? (del / gen) * 100 : 0}%;background:${col}"></div></div></div>`;
      this.compl.innerHTML = bar('Edge + store-and-forward', mm.dev.edge.del, mm.dev.edge.gen, css('--accent')) + bar('Baseline cloud-only', mm.dev.base.del, mm.dev.base.gen, css('--faint')) +
        `<div class="small muted">Edge readings still queued on the Pi: <b>${mm.dev.edge.pending}</b> (not lost — they arrive on sync). Baseline readings taken offline are gone: <b>${mm.dev.base.lost}</b>.</div>`;
    },

    offlineRegions(sim) {
      const w = CS.charts.css('--warn');
      return sim.outages().map((o) => ({ from: o.from, to: o.to, color: CS.charts.alpha(w, 0.13), label: o.mode === 'router-off' ? 'power cut' : 'offline' }));
    },

    exportCsv() {
      const sim = this.app.sim;
      const rows = [['deviceId', 'seq', 'ts', 'tempC', 'rh', 'door', 'status', 'receivedAt', 'delayMs', 'backfilled']];
      [sim.edge.id, sim.baseline.id].forEach((id) => sim.cloud.docs(id).forEach((d) => rows.push([id, d.seq, CS.util.fmt.iso(d.ts), d.tempC, d.rh, d.door, d.status, CS.util.fmt.iso(d.receivedAt), Math.round(d.delayMs), d.backfilled])));
      CS.dom.download('coldchain-telemetry.csv', rows.map((r) => r.join(',')).join('\n'), 'text/csv');
    },
  };

  CS.views.dashboard = dash;
  CS.mkt = mkt;
})(window.CS = window.CS || {});
