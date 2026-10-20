/* Azure IoT Hub view — portal-style blades for every simulated Azure resource. */
(function (CS) {
  'use strict';
  const { h, esc, json, badge } = CS.dom;
  const { fmt } = CS.util;

  const TABS = [['overview', 'Overview'], ['devices', 'Devices & twin'], ['methods', 'Direct methods'], ['routing', 'Message routing'], ['monitor', 'Monitor events'],
    ['functions', 'Functions'], ['asa', 'Stream Analytics'], ['cosmos', 'Cosmos DB'], ['notify', 'Notifications']];

  const cloud = {
    init(app, el) {
      this.app = app;
      this.tab = 'overview';
      el.innerHTML = '';
      el.appendChild(h('div', { class: 'portal-crumb' }, 'Home › Resource groups › ', h('b', null, 'rg-coldchain'), ' › ', h('b', null, CS.config.HUB.name)));
      el.appendChild(h('div', { class: 'view-h' }, h('div', null, h('h2', null, `☁ ${CS.config.HUB.name} — IoT Hub`),
        h('div', { class: 'desc' }, `${CS.config.HUB.sku} · ${CS.config.HUB.region} · hostname ${CS.config.HUB.host} · locally simulated (see cloud/ for the deployable Functions, Stream Analytics query and az CLI provisioning)`))));
      const tabs = h('div', { class: 'az-tabs' }, ...TABS.map(([k, l]) => h('button', { class: k === this.tab ? 'on' : '', onclick: (e) => { this.tab = k; [...tabs.children].forEach((b) => b.classList.toggle('on', b === e.target)); this.panes.forEach((p) => p.classList.toggle('on', p.dataset.k === k)); this.render(app, true); } }, l)));
      el.appendChild(tabs);
      this.p = {};
      this.panes = TABS.map(([k]) => { const p = h('div', { class: 'az-pane' + (k === this.tab ? ' on' : ''), 'data-k': k }); this.p[k] = p; el.appendChild(p); return p; });
      this.buildOverview(); this.buildDevices(); this.buildMethods(); this.buildRouting(); this.buildMonitor(); this.buildFunctions(); this.buildAsa(); this.buildCosmos(); this.buildNotify();
    },

    card(title, sub, body, right) { return h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, title), sub ? h('span', { class: 'sub' }, sub) : null, right ? h('div', { class: 'right' }, right) : null), body); },

    buildOverview() {
      const p = this.p.overview;
      p.append(this.kpis = h('div', { class: 'grid g6' }));
      const g = h('div', { class: 'grid g3 mt' });
      p.appendChild(g);
      g.appendChild(this.card('Device-to-cloud messages / minute', 'last 30 min', h('div', { class: 'card-b' }, this.d2cChart = h('div'))));
      g.appendChild(this.card('Event Grid · device lifecycle', 'Microsoft.Devices.*', this.eg = h('div', { class: 'card-b flush scroll', style: 'max-height:250px' })));
      g.appendChild(this.card('Recent alerts (Cosmos container: alerts)', '', this.recentAlerts = h('div', { class: 'card-b flush scroll', style: 'max-height:250px' })));
      this.d2c = new CS.charts.TimeChart(this.d2cChart, { height: 210, yFmt: (v) => v.toFixed(0), gapMs: 120000 });
    },

    buildDevices() {
      const p = this.p.devices;
      p.appendChild(this.card('Device registry', 'IoT devices', h('div', { class: 'card-b flush' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ...['Device ID', 'Description', 'Auth', 'Status', 'Connection', 'Last activity', 'D2C msgs', 'Bytes'].map((t) => h('th', null, t)))), this.reg = h('tbody')))));
      const g = h('div', { class: 'grid g2 mt' });
      p.appendChild(g);
      const f = {};
      const field = (label, el) => h('div', { class: 'field' }, h('label', null, label), el);
      const form = h('div', { class: 'grid g3' },
        field('profile', f.profile = h('select', null, ...Object.entries(CS.config.PROFILES).map(([k, v]) => h('option', { value: k }, `${k} — ${v.label}`)))),
        field('thresholds.temp_min_c', f.tmin = h('input', { type: 'number', step: '0.5' })),
        field('thresholds.temp_max_c', f.tmax = h('input', { type: 'number', step: '0.5' })),
        field('thresholds.rh_max_pct', f.hmax = h('input', { type: 'number', step: '1' })),
        field('thresholds.alarm_delay_samples', f.delay = h('input', { type: 'number', step: '1', min: '1' })),
        field('sampleIntervalSec', f.si = h('input', { type: 'number', step: '1', min: '1' })));
      this.f = f;
      const sync = () => {
        const dev = this.app.sim.cloud.devices[this.app.sim.edge.id];
        if (!dev) return;
        const d = dev.twin.desired;
        f.profile.value = d.profile; f.tmin.value = d.thresholds.temp_min_c; f.tmax.value = d.thresholds.temp_max_c; f.hmax.value = d.thresholds.rh_max_pct;
        f.delay.value = d.thresholds.alarm_delay_samples; f.si.value = d.sampleIntervalSec;
      };
      this.syncForm = sync;
      const submit = () => {
        const sim = this.app.sim, d = sim.cloud.devices[sim.edge.id].twin.desired;
        const patch = {};
        if (f.profile.value !== d.profile) {
          const pr = CS.config.PROFILES[f.profile.value];
          patch.profile = f.profile.value;
          patch.thresholds = { temp_min_c: pr.tMin, temp_max_c: pr.tMax, rh_min_pct: pr.hMin, rh_max_pct: pr.hMax };
        } else {
          const th = {};
          if (+f.tmin.value !== d.thresholds.temp_min_c) th.temp_min_c = +f.tmin.value;
          if (+f.tmax.value !== d.thresholds.temp_max_c) th.temp_max_c = +f.tmax.value;
          if (+f.hmax.value !== d.thresholds.rh_max_pct) th.rh_max_pct = +f.hmax.value;
          if (+f.delay.value !== d.thresholds.alarm_delay_samples) th.alarm_delay_samples = Math.max(1, +f.delay.value);
          if (Object.keys(th).length) patch.thresholds = th;
        }
        if (+f.si.value !== d.sampleIntervalSec) patch.sampleIntervalSec = Math.max(1, +f.si.value);
        if (!Object.keys(patch).length) return this.app.toast('Nothing changed', 'Edit a field first.', 'warn');
        sim.cloud.updateDesired(sim.edge.id, patch);
        const online = sim.cloud.devices[sim.edge.id].conn === 'Connected';
        this.app.toast('Desired properties updated', online ? 'Pushed to the device as a twin PATCH.' : 'Device offline — it will GET the twin on reconnect.', online ? 'ok' : 'warn');
        sync();
      };
      g.appendChild(this.card('Update desired properties', 'coldstore-pi-01', h('div', { class: 'card-b' }, form,
        h('div', { class: 'row mt' }, h('button', { class: 'btn primary', onclick: submit }, 'Save desired properties'), h('button', { class: 'btn', onclick: sync }, 'Reload'),
          h('span', { class: 'small muted' }, 'Same as: az iot hub device-twin update -d coldstore-pi-01 --desired \'{…}\'')),
        h('h4', { class: 'mt' }, 'Twin change log'), this.twinLog = h('div', { class: 'scroll', style: 'max-height:220px' }))));
      g.appendChild(this.card('Device twin (JSON)', 'coldstore-pi-01', this.twin = h('pre', { class: 'code', style: 'margin:12px;max-height:520px' })));
      sync();
    },

    buildMethods() {
      const p = this.p.methods;
      const sel = h('select', null, ...['getDiagnostics', 'silenceAlarm', 'testAlarm', 'reboot'].map((m) => h('option', null, m)));
      const payload = h('textarea', { rows: 4 }, '{ "seconds": 3 }');
      const out = h('pre', { class: 'code', style: 'min-height:120px' }, '// result appears here');
      const invoke = () => {
        let pl = {};
        try { pl = JSON.parse(payload.value || '{}'); } catch (e) { return this.app.toast('Invalid JSON payload', e.message, 'err'); }
        out.textContent = `invoking ${sel.value} on coldstore-pi-01 …`;
        this.app.sim.cloud.invokeMethod(this.app.sim.edge.id, sel.value, pl, (r) => {
          out.innerHTML = json({ status: r.status, latencyMs: Math.round(r.latencyMs), payload: r.result });
        });
      };
      p.appendChild(h('div', { class: 'grid g2' },
        this.card('Invoke direct method', 'cloud → device, synchronous request/response', h('div', { class: 'card-b' },
          h('div', { class: 'grid g2' }, h('div', { class: 'field' }, h('label', null, 'Method name'), sel), h('div', { class: 'field' }, h('label', null, 'Response timeout'), h('input', { type: 'text', value: '30 s', disabled: true }))),
          h('div', { class: 'field mt' }, h('label', null, 'Payload'), payload),
          h('div', { class: 'row mt' }, h('button', { class: 'btn primary', onclick: invoke }, '▶ Invoke method'), h('span', { class: 'small muted' }, 'If the device is offline IoT Hub fails at once with 404103 DeviceNotOnline — the cloud cannot reach a disconnected edge.')),
          h('h4', { class: 'mt' }, 'Result'), out)),
        this.card('Invocation history', '', this.mh = h('div', { class: 'card-b flush scroll', style: 'max-height:460px' }))));
    },

    buildRouting() {
      const p = this.p.routing;
      p.appendChild(this.card('Message routes', 'IoT Hub › Message routing', h('div', { class: 'card-b flush' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ...['Route', 'Data source', 'Routing query', 'Endpoint', 'Messages routed'].map((t) => h('th', null, t)))), this.routes = h('tbody')))));
      p.appendChild(h('div', { class: 'grid g2 mt' },
        this.card('Why route on an application property?', '', h('div', { class: 'card-b' }, h('p', null, 'The Pi sets ', h('code', null, 'alert=true'), ' as an MQTT application property on alert messages. IoT Hub can evaluate it without parsing the body, so alerts go to a separate durable Service Bus queue with its own consumer. Telemetry floods can never delay them.'),
          h('p', null, 'Because messages also carry ', h('code', null, 'contentType=application/json'), ' and ', h('code', null, 'contentEncoding=utf-8'), ', a body query such as ', h('code', null, '$body.tempC > 8'), ' is possible too (used for ad-hoc routes).'))),
        this.card('routes (ARM fragment)', 'cloud/iot-hub/message-routes.json', h('pre', { class: 'code', style: 'margin:12px;max-height:300px', html: CS.highlight((window.CS_SOURCES || {})['cloud/iot-hub/message-routes.json'] || '', 'json') }))));
    },

    buildMonitor() {
      const p = this.p.monitor;
      this.monPause = h('input', { type: 'checkbox' });
      this.monDev = h('select', null, h('option', { value: '' }, 'all devices'), h('option', null, CS.config.DEFAULTS.deviceId), h('option', null, CS.config.DEFAULTS.baselineId));
      p.appendChild(this.card('az iot hub monitor-events --hub-name coldchain-iothub --properties all', 'built-in events endpoint (Event Hub-compatible)', this.mon = h('div', { class: 'card-b', style: 'max-height:640px;overflow:auto' }),
        h('div', { class: 'row' }, this.monDev, h('label', { class: 'chk' }, this.monPause, 'pause'))));
    },

    buildFunctions() {
      const p = this.p.functions;
      p.appendChild(this.card('Function App coldchain-func (Python 3.11, Consumption plan)', 'cloud/functions/function_app.py', h('div', { class: 'card-b flush' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ...['Function', 'Trigger', 'Bindings out', 'Invocations', 'Cold starts', 'Avg duration', 'Max duration', 'Last run'].map((t) => h('th', null, t)))), this.fns = h('tbody')))));
      p.appendChild(this.card('AlertProcessor executions (latency computed in the function)', '', this.fnAlerts = h('div', { class: 'card-b flush scroll', style: 'max-height:380px' })));
      this.p.functions.lastChild.classList.add('mt');
    },

    buildAsa() {
      const p = this.p.asa;
      p.appendChild(h('div', { class: 'grid g2' },
        this.card('Query', 'cloud/stream-analytics/coldstore-job.asaql', h('pre', { class: 'code', style: 'margin:12px;max-height:560px', html: CS.highlight((window.CS_SOURCES || {})['cloud/stream-analytics/coldstore-job.asaql'] || '', 'sql') })),
        h('div', { class: 'grid' }, this.card('Output agg1m → Cosmos "aggregates"', 'coldstore-pi-01, newest first', this.agg = h('div', { class: 'card-b flush scroll', style: 'max-height:330px' })),
          this.card('Job metrics', '', this.asaM = h('div', { class: 'card-b' })))));
    },

    buildCosmos() {
      const p = this.p.cosmos;
      p.appendChild(this.cosmosK = h('div', { class: 'grid g4' }));
      p.appendChild(h('div', { class: 'grid g2 mt' },
        this.card('Data Explorer · coldchain / telemetry', 'SELECT TOP 20 * FROM c WHERE c.deviceId = "coldstore-pi-01" ORDER BY c.ts DESC', this.tele = h('div', { class: 'card-b flush scroll', style: 'max-height:520px' })),
        this.card('Latest document (JSON)', '', this.doc = h('pre', { class: 'code', style: 'margin:12px;max-height:520px' }))));
    },

    buildNotify() {
      const p = this.p.notify;
      p.appendChild(h('div', { class: 'grid', style: 'grid-template-columns: 280px minmax(0,1fr)' },
        this.card('SMS · on-call phone', '+91 98xxx xx210', h('div', { class: 'card-b' }, this.phone = h('div', { class: 'phone' }))),
        this.card('E-mail / Teams (Logic App → Communication Services)', '', this.mails = h('div', { class: 'card-b', style: 'max-height:600px;overflow:auto' }))));
    },

    render(app, force) {
      const sim = app.sim, c = sim.cloud, t = this.tab;
      if (t === 'overview') {
        const dev = c.devices[sim.edge.id];
        const k = [
          ['Messages today', c.quota.msgs.toLocaleString(), `${c.quota.units} metered · quota ${CS.config.HUB.dailyQuota.toLocaleString()}`],
          ['Connected devices', `${Object.values(c.devices).filter((d) => d.conn === 'Connected').length} / 2`, `edge: ${dev.conn}`, dev.conn === 'Connected' ? 'ok' : 'err'],
          ['Routed: alerts', c.routes['alerts-route'], 'alerts-route → Service Bus'],
          ['Routed: telemetry', c.routes['telemetry-route'].toLocaleString(), 'telemetry-route → events'],
          ['Function runs', Object.values(c.fn).reduce((a, f) => a + f.inv, 0).toLocaleString(), `${Object.values(c.fn).reduce((a, f) => a + f.cold, 0)} cold starts`],
          ['Notifications', c.notifications.length, `${c.alerts.filter((a) => a.state === 'RAISED').length} alerts raised`],
        ];
        this.kpis.innerHTML = k.map(([l, v, s2, kind]) => `<div class="kpi ${kind || ''}"><div class="k-l">${l}</div><div class="k-v">${esc(v)}</div><div class="k-s">${esc(s2)}</div></div>`).join('');
        const now = sim.now(), from = now - 1800000;
        const pts = [];
        for (let x = Math.max(Math.floor(from / 60000) * 60000, Math.floor(sim.startEpoch / 60000) * 60000); x <= now; x += 60000) pts.push({ x, y: c.d2cPerMin.get(x) || 0 });
        this.d2c.set({ x0: from, x1: now, series: [{ name: 'msgs/min', color: CS.charts.css('--azure'), data: pts }], regions: this.outRegions(sim), yMin: 0 });
        this.eg.innerHTML = c.eventGrid.length ? `<table class="tbl compact"><tbody>${c.eventGrid.slice(0, 25).map((e) => `<tr><td class="mono">${fmt.time(e.t)}</td><td>${badge(e.type.split('.').pop(), e.type.endsWith('Connected') ? 'ok' : 'err')}</td><td class="mono">${e.id}</td></tr>`).join('')}</tbody></table>` : '<div class="card-b muted">no events yet</div>';
        this.recentAlerts.innerHTML = this.alertTable(c.alerts.slice(0, 20), true);
      } else if (t === 'devices') {
        this.reg.innerHTML = Object.values(c.devices).map((d) => `<tr><td class="mono">${d.id}</td><td>${d.label}</td><td>${d.auth}</td><td>${badge('Enabled', 'ok')}</td><td>${badge(d.conn, d.conn === 'Connected' ? 'ok' : 'err')}</td><td class="mono">${d.lastActivity ? fmt.time(sim.startEpoch + d.lastActivity) : '—'}</td><td class="num">${d.d2c.toLocaleString()}</td><td class="num">${fmt.bytes(d.bytes)}</td></tr>`).join('');
        const dev = c.devices[sim.edge.id];
        this.twin.innerHTML = json({ deviceId: dev.id, etag: 'AAAAAAAAAA' + dev.twin.desired.$version, status: 'enabled', connectionState: dev.conn, tags: dev.twin.tags, properties: { desired: dev.twin.desired, reported: dev.twin.reported } });
        this.twinLog.innerHTML = c.twinLog.length ? `<table class="tbl compact"><tbody>${c.twinLog.slice(0, 30).map((l) => `<tr><td class="mono">${fmt.time(l.t)}</td><td>${badge(l.side, l.side === 'desired' ? 'vio' : 'info')}</td><td class="mono">v${l.version}</td><td class="mono small">${esc(JSON.stringify(l.patch)).slice(0, 140)}</td></tr>`).join('')}</tbody></table>` : '<span class="muted small">no twin changes yet</span>';
      } else if (t === 'methods') {
        this.mh.innerHTML = c.methods.length ? `<table class="tbl compact"><thead><tr><th>Time</th><th>Method</th><th>Status</th><th>Round trip</th><th>Result</th></tr></thead><tbody>${c.methods.slice(0, 40).map((m) => `<tr><td class="mono">${fmt.time(m.t)}</td><td class="mono">${m.name}</td><td>${m.status == null ? badge('pending', 'warn') : badge(m.status, m.status === 200 ? 'ok' : 'err')}</td><td class="num">${m.latencyMs != null ? fmt.dur(m.latencyMs) : '…'}</td><td class="mono small">${esc(JSON.stringify(m.result || '')).slice(0, 90)}</td></tr>`).join('')}</tbody></table>` : '<div class="card-b muted">no invocations yet</div>';
      } else if (t === 'routing') {
        const rows = [['alerts-route', 'Device messages', "alert = 'true'", 'sb-alerts (Service Bus queue cold-alerts)', c.routes['alerts-route']],
          ['telemetry-route', 'Device messages', "alert = 'false'", 'events (built-in) → TelemetryIngest, Stream Analytics', c.routes['telemetry-route']],
          ['twin-route', 'Twin change events', 'true', 'events (built-in)', c.routes['twin-route']]];
        this.routes.innerHTML = rows.map((r) => `<tr><td class="mono">${r[0]}</td><td>${r[1]}</td><td class="mono">${esc(r[2])}</td><td>${r[3]}</td><td class="num">${r[4].toLocaleString()}</td></tr>`).join('');
      } else if (t === 'monitor') {
        if (this.monPause.checked) return;
        const dev = this.monDev.value;
        const list = c.monitor.filter((m) => !dev || m.deviceId === dev).slice(0, 25);
        this.mon.innerHTML = list.map((m) => {
          const body = m.kind === 'batch' ? { ...m.body, readings: [...m.body.readings.slice(0, 2), `… ${m.body.readings.length - 2} more`] } : m.body;
          return `<div class="mon-row"><pre class="code" style="border:0;background:transparent;padding:0">${json({ event: { origin: m.deviceId, module: '', interface: '', component: '', payload: body, annotations: { 'iothub-enqueuedtime': fmt.iso(m.enqueuedTime), 'iothub-message-source': 'Telemetry' }, properties: { system: m.systemProperties, application: m.properties } } })}</pre></div>`;
        }).join('') || '<span class="muted">Starting event monitor… no messages yet.</span>';
      } else if (t === 'functions') {
        const meta = { TelemetryIngest: ['Event Hub (built-in, cg telemetry-fn)', 'Cosmos telemetry · SignalR'], AlertProcessor: ['Service Bus queue cold-alerts', 'Cosmos alerts · SignalR · Logic App'], ConnectionMonitor: ['Event Grid', 'SignalR · Logic App'] };
        this.fns.innerHTML = Object.entries(c.fn).map(([n, f]) => `<tr><td class="mono">${n}</td><td>${meta[n][0]}</td><td>${meta[n][1]}</td><td class="num">${f.inv.toLocaleString()}</td><td class="num">${f.cold}</td><td class="num">${f.inv ? fmt.dur(f.totalMs / f.inv) : '—'}</td><td class="num">${f.inv ? fmt.dur(f.maxMs) : '—'}</td><td class="mono">${f.last != null && isFinite(f.last) ? fmt.time(sim.startEpoch + f.last) : '—'}</td></tr>`).join('');
        this.fnAlerts.innerHTML = this.alertTable(c.alerts.slice(0, 40), false);
      } else if (t === 'asa') {
        const ag = c.aggregates(sim.edge.id, 20);
        this.agg.innerHTML = ag.length ? `<table class="tbl compact"><thead><tr><th>windowEnd</th><th class="num">avg °C</th><th class="num">min</th><th class="num">max</th><th class="num">avg RH</th><th class="num">samples</th><th class="num">in range</th><th class="num">back-filled</th></tr></thead><tbody>${ag.map((b) => `<tr class="${b.maxT > sim.edge.th.tMax ? 'bad' : ''}"><td class="mono">${fmt.time(b.start + 60000)}</td><td class="num">${(b.sumT / b.n).toFixed(2)}</td><td class="num">${b.minT.toFixed(2)}</td><td class="num">${b.maxT.toFixed(2)}</td><td class="num">${(b.sumH / b.n).toFixed(1)}</td><td class="num">${b.n}</td><td class="num">${((b.inRange / b.n) * 100).toFixed(0)} %</td><td class="num">${b.backfilled}</td></tr>`).join('')}</tbody></table>` : '<div class="card-b muted">waiting for the first window…</div>';
        this.asaM.innerHTML = `<div class="kv"><div>Input events</div><div>${c.asa.events.toLocaleString()}</div><div>Cloud-rule alerts (baseline)</div><div>${c.asa.outputs}</div><div>Streaming units</div><div>1 (SU V2)</div><div>Late arrival policy</div><div>10 min, adjust</div><div>Out-of-order policy</div><div>5 s</div><div>Watermark delay</div><div>${fmt.dur(CS.config.CLOUD.asa[0])}–${fmt.dur(CS.config.CLOUD.asa[1])}</div></div>`;
      } else if (t === 'cosmos') {
        const te = c.telemetry[sim.edge.id], tb = c.telemetry[sim.baseline.id];
        const back = te.docs.filter((d) => d.backfilled).length;
        const k = [['telemetry docs', (te.docs.length + tb.docs.length).toLocaleString(), `edge ${te.docs.length} · baseline ${tb.docs.length}`], ['back-filled (edge)', back.toLocaleString(), 'arrived in sync batches'],
          ['duplicates discarded', (te.dupes + tb.dupes).toLocaleString(), 'upsert on id = deviceId-seq'], ['alerts docs', c.alerts.length, 'container: alerts']];
        this.cosmosK.innerHTML = k.map(([l, v, s2]) => `<div class="kpi"><div class="k-l">${l}</div><div class="k-v">${esc(v)}</div><div class="k-s">${esc(s2)}</div></div>`).join('');
        const rows = te.docs.slice(-20).reverse();
        this.tele.innerHTML = `<table class="tbl compact"><thead><tr><th>id</th><th>ts (device)</th><th class="num">tempC</th><th class="num">rh</th><th>status</th><th>receivedAt</th><th class="num">delay</th><th></th></tr></thead><tbody>${rows.map((d) => `<tr class="${d.backfilled ? 'hl' : ''}"><td class="mono">${d.id}</td><td class="mono">${fmt.time(d.ts)}</td><td class="num">${d.tempC ?? '—'}</td><td class="num">${d.rh ?? '—'}</td><td>${d.status}</td><td class="mono">${fmt.time(d.receivedAt)}</td><td class="num">${fmt.dur(d.delayMs)}</td><td>${d.backfilled ? badge('back-filled', 'warn') : ''}</td></tr>`).join('')}</tbody></table>`;
        const last = te.docs[te.docs.length - 1];
        this.doc.innerHTML = last ? json({ ...last, ts: fmt.iso(last.ts), receivedAt: fmt.iso(last.receivedAt), _rid: 'kZ8+AL2mQ' + (last.seq % 997), _ts: Math.floor(last.receivedAt / 1000) }) : '{}';
      } else if (t === 'notify') {
        const ns = c.notifications;
        this.phone.innerHTML = ns.filter((n) => n.channels.includes('SMS')).slice(0, 7).map((n) => `<div class="sms"><div class="st">ColdChain · ${fmt.time(n.t)}</div>${esc(n.title)}<br>${esc(n.text)}</div>`).join('') || '<div class="muted small" style="color:#7d8db0">No SMS yet. Critical alerts (temperature, sensor fault) are sent by SMS.</div>';
        this.mails.innerHTML = ns.slice(0, 40).map((n) => `<div class="notif ${n.severity}"><div class="row"><span class="nt">${esc(n.title)}</span><span class="sp"></span>${n.channels.map((ch) => badge(ch, ch === 'SMS' ? 'err' : 'info')).join(' ')}</div><div class="nm">${fmt.time(n.t)} · ${esc(n.text)}</div></div>`).join('') || '<span class="muted">No notifications yet — inject a fault in the Live view.</span>';
      }
    },

    alertTable(list, short) {
      if (!list.length) return '<div class="card-b muted">no alerts yet</div>';
      return `<table class="tbl compact"><thead><tr><th>Processed</th><th>Device</th><th>Alert</th><th>State</th>${short ? '' : '<th>Cold start</th><th class="num">Fn</th>'}<th class="num">Local alarm</th><th class="num">Cloud (SMS)</th><th class="num">Buffered</th></tr></thead><tbody>${list.map((a) => `<tr class="${a.deliveredLate ? 'hl' : ''}"><td class="mono">${fmt.time(a.processedAt)}</td><td class="mono small">${a.deviceId === CS.config.DEFAULTS.deviceId ? 'edge' : 'baseline'}</td><td class="mono">${a.alarm}</td><td>${badge(a.state, a.state === 'RAISED' ? 'err' : 'ok')}</td>${short ? '' : `<td>${a.coldStart ? badge('cold', 'warn') : ''}</td><td class="num">${fmt.dur(a.fnMs)}</td>`}<td class="num">${a.latency.localAlarmMs != null ? fmt.dur(a.latency.localAlarmMs) : '—'}</td><td class="num">${a.state === 'RAISED' && a.latency.notifyMs != null ? fmt.dur(a.latency.notifyMs) : a.state === 'RAISED' ? '…' : '—'}</td><td class="num">${a.latency.bufferedMs ? fmt.dur(a.latency.bufferedMs) : '0'}</td></tr>`).join('')}</tbody></table>`;
    },

    outRegions(sim) {
      const warn = CS.charts.css('--warn');
      return sim.outages().map((o) => ({ from: o.from, to: o.to, color: CS.charts.alpha(warn, 0.12), label: o.mode === 'router-off' ? 'power cut' : 'outage' }));
    },

    onReset() { setTimeout(() => this.syncForm && this.syncForm(), 800); },
  };

  CS.views.cloud = cloud;
})(window.CS = window.CS || {});
