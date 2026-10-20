/* Experiments & Results: reproducible scenario runs, the connected-vs-disconnected
 * comparison the problem statement asks for, plus bandwidth/security/resource numbers. */
(function (CS) {
  'use strict';
  const { h, esc, badge } = CS.dom;
  const { fmt, mean } = CS.util;

  const res = {
    init(app, el) {
      this.app = app;
      el.innerHTML = '';
      this.seed = h('input', { type: 'number', value: 2026, style: 'width:90px' });
      this.profile = h('select', null, ...Object.entries(CS.config.PROFILES).map(([k, v]) => h('option', { value: k }, v.label)));
      el.appendChild(h('div', { class: 'view-h' }, h('div', null, h('h2', null, 'Experiments & measured results'),
        h('div', { class: 'desc' }, 'Six scripted scenarios run headless on a fixed seed, so the same numbers come out every time. Each run has both architectures, side by side on identical sensor readings: the edge Pi with store-and-forward, and the baseline cloud-only node. Alert response is timed from the first out-of-range sample.')),
        h('div', { class: 'tools' }, h('span', { class: 'small muted' }, 'seed'), this.seed, this.profile,
          h('button', { class: 'btn primary', onclick: () => this.run(false) }, '▶ Run all experiments'),
          h('button', { class: 'btn', onclick: () => this.download('json') }, '⤓ JSON'), h('button', { class: 'btn', onclick: () => this.download('csv') }, '⤓ CSV'))));
      this.out = h('div');
      el.appendChild(this.out);
      this.liveBox = h('div');
      el.appendChild(this.liveBox);
    },

    async run(cached) {
      this.out.innerHTML = '<div class="card card-b muted">Running experiments E1–E6 on the server…</div>';
      try {
        this.app.results = await CS.api.get(`/api/experiments?seed=${+this.seed.value || 2026}&profile=${this.profile.value}${cached ? '&cached=1' : ''}`);
      } catch (e) { this.out.innerHTML = `<div class="card card-b err-t">Server error: ${esc(e.message)}</div>`; return; }
      this.draw();
      if (!cached) this.app.toast('Experiments complete (server)', `6 scenarios · ${Math.round(this.app.results.runs.reduce((a, r) => a + r.durationS, 0) / 60)} simulated minutes in ${Math.round(this.app.results.wallMs)} ms`, 'ok');
    },

    onShow() { if (!this.app.results) this.run(true); else if (!this.drawn) this.draw(); },

    draw() {
      const R = this.app.results;
      this.drawn = true;
      const css = CS.charts.css;
      const C = R.combined, cc = C.connected, cd = C.disconnected;
      const m = (a) => (a.length ? mean(a) : null);
      const pct = (lost, gen) => (gen ? lost / gen : null);
      this.out.innerHTML = '';
      const head = h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('h3', null, 'Headline comparison — connected vs disconnected operation'), h('span', { class: 'sub' }, `pooled over E1–E4, E6 · ${cc.episodes} connected + ${cd.episodes} disconnected excursions · ${cc.data.edge.gen + cd.data.edge.gen} readings per device`)),
        h('div', { class: 'card-b flush' }, h('table', { class: 'tbl', html: `
          <thead><tr><th>Metric</th><th class="num">Edge · connected</th><th class="num">Edge · disconnected</th><th class="num">Cloud-only · connected</th><th class="num">Cloud-only · disconnected</th></tr></thead>
          <tbody>
          <tr><td><b>Local alarm</b> (buzzer + LED) after first breach</td><td class="num ok-t">${fmt.dur(m(cc.edgeLocal))}</td><td class="num ok-t">${fmt.dur(m(cd.edgeLocal))}</td><td class="num faint">no local alarm</td><td class="num faint">no local alarm</td></tr>
          <tr><td><b>Operator alerted</b> (SMS) after first breach</td><td class="num">${fmt.dur(m(cc.edgeCloud))}</td><td class="num warn-t">${fmt.dur(m(cd.edgeCloud))}<div class="small muted">sent after reconnect</div></td><td class="num">${fmt.dur(m(cc.baseCloud))}</td><td class="num err-t">${cd.baseCloud.length ? fmt.dur(m(cd.baseCloud)) : '—'}<div class="small">${cd.baseMissed} of ${cd.episodes} never alerted</div></td></tr>
          <tr><td>Excursions with <b>no alert at all</b></td><td class="num">${cc.edgeLocalMissed}</td><td class="num">${cd.edgeLocalMissed}</td><td class="num">${cc.baseMissed}</td><td class="num err-t">${cd.baseMissed}</td></tr>
          <tr><td><b>Readings lost</b></td><td class="num ok-t">${cc.data.edge.lost} / ${cc.data.edge.gen}</td><td class="num ok-t">${cd.data.edge.lost} / ${cd.data.edge.gen}</td><td class="num">${cc.data.base.lost} / ${cc.data.base.gen}</td><td class="num err-t">${cd.data.base.lost} / ${cd.data.base.gen}</td></tr>
          <tr><td><b>Data loss</b></td><td class="num ok-t">${fmt.pct(pct(cc.data.edge.lost, cc.data.edge.gen), 2)}</td><td class="num ok-t">${fmt.pct(pct(cd.data.edge.lost, cd.data.edge.gen), 2)}</td><td class="num">${fmt.pct(pct(cc.data.base.lost, cc.data.base.gen), 2)}</td><td class="num err-t">${fmt.pct(pct(cd.data.base.lost, cd.data.base.gen), 1)}</td></tr>
          <tr><td>Mean delivery delay of a reading</td><td class="num">${fmt.dur(m(cc.data.edge.delay))}</td><td class="num warn-t">${fmt.dur(m(cd.data.edge.delay))}</td><td class="num">${fmt.dur(m(cc.data.base.delay))}</td><td class="num faint">— (lost)</td></tr>
          </tbody>` })),
        h('div', { class: 'card-b small muted' }, 'Read it like this: while connected, both designs alert staff within seconds. While disconnected, only the edge design still sounds the alarm at the site (same ~5.8 s), and it loses no data. The cloud-only design is blind until the link returns, misses excursions that end during the outage, and permanently loses every reading taken offline.'));
      this.out.appendChild(head);

      const charts = h('div', { class: 'grid g2 mt' });
      this.out.appendChild(charts);
      const c1 = h('div'), c2 = h('div'), c3 = h('div'), c4 = h('div');
      charts.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Alert response time'), h('span', { class: 'sub' }, 'log scale · seconds from first breach')), h('div', { class: 'card-b' }, this.leg([['Edge: local buzzer', css('--ok')], ['Edge: operator SMS', css('--accent')], ['Cloud-only: operator SMS', css('--faint')]]), c1)));
      charts.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Data loss per experiment'), h('span', { class: 'sub' }, '% of readings never stored in Cosmos DB')), h('div', { class: 'card-b' }, this.leg([['Edge + store-and-forward', css('--accent')], ['Cloud-only baseline', css('--err')]]), c2)));
      charts.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Bandwidth per hour (wire bytes)'), h('span', { class: 'sub' }, 'incl. MQTT, TLS and TCP/IP overhead')), h('div', { class: 'card-b' }, this.leg([['Edge', css('--accent')], ['Cloud-only', css('--faint')]]), c3)));
      charts.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Outage detection & recovery'), h('span', { class: 'sub' }, 'seconds')), h('div', { class: 'card-b' }, this.leg([['Edge detects link loss', css('--ok')], ['Cloud detects (keep-alive + Event Grid)', css('--warn')], ['Backlog sync after reconnect', css('--violet')]]), c4)));
      const sec = (v) => (v == null ? null : v / 1000);
      new CS.charts.BarChart(c1, { log: true, height: 250, fmt: (v) => (v >= 60 ? (v / 60).toFixed(v >= 600 ? 0 : 1) + 'm' : v >= 10 ? v.toFixed(0) + 's' : v.toFixed(1) + 's'), fmtLong: (v) => fmt.dur(v * 1000) }).set({
        categories: ['Connected', 'Disconnected'],
        series: [
          { name: 'Edge: local buzzer', color: css('--ok'), values: [sec(m(cc.edgeLocal)), sec(m(cd.edgeLocal))] },
          { name: 'Edge: operator SMS', color: css('--accent'), values: [sec(m(cc.edgeCloud)), sec(m(cd.edgeCloud))] },
          { name: 'Cloud-only: operator SMS', color: css('--faint'), values: [sec(m(cc.baseCloud)), cd.baseCloud.length ? sec(m(cd.baseCloud)) : null], nullLabel: 'never' },
        ],
      });
      new CS.charts.BarChart(c2, { height: 250, fmt: (v) => v.toFixed(0) + '%' }).set({
        categories: R.runs.map((r) => r.id),
        series: [{ name: 'Edge', color: css('--accent'), values: R.runs.map((r) => (r.row.edgeLost / r.row.edgeGen) * 100) }, { name: 'Cloud-only', color: css('--err'), values: R.runs.map((r) => (r.row.baseLost / r.row.baseGen) * 100) }],
      });
      new CS.charts.BarChart(c3, { height: 250, fmt: (v) => (v / 1024).toFixed(0) + 'K', fmtLong: (v) => fmt.bytes(v) + '/h' }).set({
        categories: R.runs.map((r) => r.id),
        series: [{ name: 'Edge', color: css('--accent'), values: R.runs.map((r) => r.summary.bw.edge.perHour) }, { name: 'Cloud-only', color: css('--faint'), values: R.runs.map((r) => r.summary.bw.base.perHour) }],
      });
      const outRuns = R.runs.filter((r) => r.row.edgeDetectS != null);
      new CS.charts.BarChart(c4, { height: 250, log: true, fmt: (v) => v.toFixed(v < 10 ? 1 : 0) + 's' }).set({
        categories: outRuns.map((r) => r.id),
        series: [{ name: 'Edge detects', color: css('--ok'), values: outRuns.map((r) => r.row.edgeDetectS) }, { name: 'Cloud detects', color: css('--warn'), values: outRuns.map((r) => r.row.cloudDetectS) }, { name: 'Sync', color: css('--violet'), values: outRuns.map((r) => (r.row.syncMs != null ? r.row.syncMs / 1000 : null)) }],
      });

      // per-experiment table
      const t = h('div', { class: 'card mt' }, h('div', { class: 'card-h' }, h('h3', null, 'Per-experiment results'), h('span', { class: 'sub' }, `seed ${R.seed} · ${R.profile} profile · computed in ${Math.round(R.wallMs || 0)} ms`)),
        h('div', { class: 'card-b flush scroll' }, h('table', { class: 'tbl', html: `<thead><tr><th>Exp</th><th>Scenario</th><th class="num">Outage</th><th class="num">Edge delivered</th><th class="num">Cloud-only delivered</th><th class="num">Excursions</th><th class="num">Local alarm</th><th class="num">Edge → SMS</th><th class="num">Cloud-only → SMS</th><th class="num">Sync</th><th class="num">Dupes</th><th class="num">TLS overhead</th><th class="num">Batch saving</th></tr></thead><tbody>${R.runs.map((r) => {
          const w = r.row;
          return `<tr class="${r.id === 'E5' ? 'hl' : ''}"><td class="mono"><b>${r.id}</b></td><td><b>${esc(r.name)}</b><div class="small muted">${esc(r.desc)}</div></td><td class="num">${r.outageS ? fmt.dur(r.outageS * 1000) : '—'}</td>
            <td class="num ${w.edgeLost ? 'err-t' : 'ok-t'}">${fmt.pct(w.edgeDelivery)}<div class="small muted">${w.edgeLost} lost</div></td><td class="num ${w.baseLost ? 'err-t' : 'ok-t'}">${fmt.pct(w.baseDelivery)}<div class="small muted">${w.baseLost} lost</div></td>
            <td class="num">${w.episodes}</td><td class="num">${fmt.dur(w.edgeLocal)}</td><td class="num">${fmt.dur(w.edgeCloud)}</td><td class="num">${w.baseCloud != null ? fmt.dur(w.baseCloud) : '—'}${w.baseMissed ? `<div class="small err-t">${w.baseMissed} missed</div>` : ''}</td>
            <td class="num">${w.syncMs != null ? fmt.dur(w.syncMs) + `<div class="small muted">${w.syncRows} rows</div>` : '—'}</td><td class="num">${w.dupes}</td><td class="num">${fmt.pct(w.securityPct)}</td><td class="num">${w.batchSaving != null ? fmt.pct(w.batchSaving, 0) : '—'}</td></tr>`;
        }).join('')}</tbody>` })),
        h('div', { class: 'card-b small muted' }, 'E5 (highlighted) deliberately uses a 120-row buffer to show the design limit: when an outage outlasts the buffer, the oldest readings are dropped (and counted). The default 100 000-row buffer covers about 5.8 days at 5 s sampling.'));
      this.out.appendChild(t);

      // episodes
      const eps = R.runs.flatMap((r) => r.summary.episodes.map((e) => ({ ...e, run: r.id })));
      this.out.appendChild(h('div', { class: 'card mt' }, h('div', { class: 'card-h' }, h('h3', null, 'Every excursion measured'), h('span', { class: 'sub' }, `${eps.length} episodes`)),
        h('div', { class: 'card-b flush scroll', style: 'max-height:420px' }, h('table', { class: 'tbl compact', html: `<thead><tr><th>Exp</th><th>Type</th><th>Link at start</th><th class="num">Peak</th><th class="num">Duration</th><th class="num">Edge buzzer</th><th class="num">Edge → SMS</th><th class="num">Cloud-only → SMS</th></tr></thead><tbody>${eps.map((e) => `<tr class="${e.cond === 'disconnected' ? 'hl' : ''}"><td class="mono">${e.run}</td><td class="mono">${e.type}</td><td>${badge(e.cond, e.cond === 'connected' ? 'ok' : 'err')}</td><td class="num">${e.peak != null ? e.peak.toFixed(1) : '—'}</td><td class="num">${e.end ? fmt.dur(e.end - e.start) : 'ongoing'}</td><td class="num">${e.edgeLocalAt ? fmt.dur(e.edgeLocalAt - e.start) : '—'}</td><td class="num">${e.edgeCloudAt ? fmt.dur(e.edgeCloudAt - e.start) : '—'}</td><td class="num">${e.baseCloudAt ? fmt.dur(e.baseCloudAt - e.start) : '<span class="err-t">never</span>'}</td></tr>`).join('')}</tbody>` }))));

      // other measures
      const e1 = R.runs[0].summary;
      const sp = e1.bw.edge;
      this.out.appendChild(h('div', { class: 'grid g3 mt' },
        this.metricCard('Security overhead (E1)', [['TLS bytes / total wire bytes', fmt.pct(sp.securityPct)], ['TLS handshakes', sp.handshakes], ['Per message TLS record', '29 B (AES-GCM)'], ['Handshake cost', fmt.bytes(CS.config.WIRE.tlsHandshakeUp + CS.config.WIRE.tlsHandshakeDown)], ['Auth', 'per-device SAS token, 60 min TTL']]),
        this.metricCard('Bandwidth (E1, connected)', [['Wire bytes / hour', fmt.bytes(sp.perHour)], ['Payload bytes / hour', fmt.bytes(sp.payload / (R.runs[0].durationS / 3600))], ['Messages / hour', Math.round(sp.msgs / (R.runs[0].durationS / 3600))], ['Per day', fmt.bytes(sp.perHour * 24)], ['Batch saving after outages', fmt.pct(R.runs[1].row.batchSaving, 0)]]),
        this.metricCard('Resource use on the Pi (model)', [['CPU (steady / syncing)', '≈ 3–8 % / ≈ 15 %'], ['RAM (python process)', '≈ 62 MB'], ['SQLite row', '≈ 188 B → 100 k rows ≈ 18 MB'], ['SD writes', '1 row / 5 s (WAL)'], ['Privacy', 'no personal data; temp, RH, door only']])));
    },

    metricCard(title, rows) {
      return h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, title)), h('div', { class: 'card-b' }, h('div', { class: 'kv', html: rows.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('') })));
    },

    leg(items) { return h('div', { class: 'chart-legend' }, ...items.map(([l, c]) => h('span', null, h('i', { class: 'band', style: { background: c } }), l))); },

    render(app) {
      // live session comparison (current simulation)
      if (this._t && performance.now() - this._t < 1000) return;
      this._t = performance.now();
      const s = app.sim.metrics.summary();
      const r = s.resp;
      const cell = (st) => (st.n ? fmt.dur(st.mean) + ` <span class="faint">(n=${st.n})</span>` : '—');
      this.liveBox.innerHTML = `<div class="card mt"><div class="card-h"><h3>This live session (so far)</h3><span class="sub">updates as you inject events · T+${fmt.clock(app.sim.t)}</span></div><div class="card-b flush"><table class="tbl">
        <thead><tr><th>Metric</th><th class="num">Edge · connected</th><th class="num">Edge · disconnected</th><th class="num">Cloud-only · connected</th><th class="num">Cloud-only · disconnected</th></tr></thead><tbody>
        <tr><td>Local alarm latency</td><td class="num">${cell(r.connected.edgeLocal)}</td><td class="num">${cell(r.disconnected.edgeLocal)}</td><td class="num faint">n/a</td><td class="num faint">n/a</td></tr>
        <tr><td>Operator SMS latency</td><td class="num">${cell(r.connected.edgeCloud)}</td><td class="num">${cell(r.disconnected.edgeCloud)}</td><td class="num">${cell(r.connected.baseCloud)}</td><td class="num">${cell(r.disconnected.baseCloud)}${r.disconnected.baseMissed ? ` <span class="err-t">${r.disconnected.baseMissed} missed</span>` : ''}</td></tr>
        <tr><td>Readings lost / taken</td><td class="num">${s.dev.edge.connected.lost} / ${s.dev.edge.connected.gen}</td><td class="num">${s.dev.edge.disconnected.lost} / ${s.dev.edge.disconnected.gen}${s.dev.edge.disconnected.pending ? ` <span class="warn-t">(${s.dev.edge.disconnected.pending} queued)</span>` : ''}</td><td class="num">${s.dev.base.connected.lost} / ${s.dev.base.connected.gen}</td><td class="num">${s.dev.base.disconnected.lost} / ${s.dev.base.disconnected.gen}</td></tr>
        <tr><td>Live end-to-end latency (publish → dashboard)</td><td class="num">${fmt.dur(s.dev.edge.live.mean)}</td><td class="num faint">—</td><td class="num">${fmt.dur(s.dev.base.live.mean)}</td><td class="num faint">—</td></tr>
        <tr><td>Wire bytes (total)</td><td class="num" colspan="2">${fmt.bytes(s.bw.edge.total)} · TLS ${fmt.pct(s.bw.edge.securityPct)}</td><td class="num" colspan="2">${fmt.bytes(s.bw.base.total)} · TLS ${fmt.pct(s.bw.base.securityPct)}</td></tr>
        </tbody></table></div></div>`;
    },

    download(kind) {
      const R = this.app.results;
      if (!R) return this.app.toast('Run the experiments first', '', 'warn');
      if (kind === 'json') {
        const slim = { seed: R.seed, profile: R.profile, combined: Object.fromEntries(Object.entries(R.combined).map(([k, v]) => [k, { ...v, eps: undefined }])), runs: R.runs.map((r) => ({ id: r.id, name: r.name, durationS: r.durationS, outageS: r.outageS, row: r.row, episodes: r.summary.episodes })) };
        CS.dom.download('coldchain-results.json', JSON.stringify(slim, null, 2), 'application/json');
      } else {
        const cols = Object.keys(R.runs[0].row);
        CS.dom.download('coldchain-results.csv', ['id,name,' + cols.join(','), ...R.runs.map((r) => [r.id, `"${r.name}"`, ...cols.map((c) => r.row[c])].join(','))].join('\n'), 'text/csv');
      }
    },
  };

  CS.views.results = res;
})(window.CS = window.CS || {});
