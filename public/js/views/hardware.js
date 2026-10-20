/* Raspberry Pi & Circuit view: live schematic, component inspector with driver code,
 * GPIO table, LCD, journalctl terminal, SQLite queue and raw sensor output. */
(function (CS) {
  'use strict';
  const { h, esc } = CS.dom;
  const { fmt } = CS.util;

  const ALIAS = { r47k: 'ds18b20', r10k: 'dht22' };

  function snippet(path, anchor, n = 26) {
    const src = (window.CS_SOURCES || {})[path];
    if (!src) return { html: esc('(sources not loaded from the server — GET /api/sources)'), start: 1 };
    const lines = src.split('\n');
    let i = Math.max(0, lines.findIndex((l) => l.includes(anchor)));
    const start = Math.max(0, i - 2);
    const part = lines.slice(start, start + n).join('\n');
    return { html: CS.highlight(part, CS.highlight.langOf(path)), start: start + 1 };
  }

  const hw = {
    init(app, el) {
      this.app = app;
      el.innerHTML = '';
      el.appendChild(h('div', { class: 'view-h' },
        h('div', null, h('h2', null, 'Raspberry Pi edge node · circuit & runtime'),
          h('div', { class: 'desc' }, 'Wiring of every sensor and actuator to the 40-pin header (BCM numbering), drawn live from the simulated GPIO state. On the right is what you would see on the Pi itself: the LCD, journalctl output, the SQLite queue and the raw sensor output.')),
        h('div', { class: 'tools' }, h('button', { class: 'btn', onclick: () => CS.dom.exportSvg(this.circuit.svg, 'coldchain-circuit.svg') }, '⤓ Circuit SVG'))));

      const grid = h('div', { class: 'hw-grid' });
      el.appendChild(grid);
      const left = h('div', { class: 'grid' });
      const right = h('div', { class: 'grid' });
      grid.append(left, right);

      const cc = h('div', { class: 'card-b', style: 'padding:6px' });
      left.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Circuit diagram'), h('span', { class: 'sub' }, 'Raspberry Pi 4 · BCM pin numbers · click a part')), cc));
      this.circuit = new CS.Circuit(cc, (id) => this.pick(id));
      this.info = h('div', { class: 'card-b comp-info' });
      left.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Component inspector'), this.infoSub = h('span', { class: 'sub' }, '')), this.info));
      left.appendChild(this.bomCard());

      // right column
      this.lcd = h('div', { class: 'lcd-big' }, '                \n                ');
      right.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, '16×2 LCD at the cold-room door')), h('div', { class: 'card-b', style: 'text-align:center' }, this.lcd,
        h('div', { class: 'row mt', style: 'justify-content:center' }, h('button', { class: 'btn sm', onclick: () => app.sim.pressAck() }, '🔕 Press ACK button'), h('button', { class: 'btn sm', onclick: () => app.sim.rebootPi() }, '↻ Power-cycle Pi')))));
      this.res = h('div', { class: 'grid g3' });
      right.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'System resources'), h('span', { class: 'sub' }, 'psutil / vcgencmd')), h('div', { class: 'card-b' }, this.res)));
      this.pins = h('tbody');
      right.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'GPIO map · live levels')),
        h('div', { class: 'card-b flush scroll', style: 'max-height:300px' }, h('table', { class: 'tbl compact pin-tbl' }, h('thead', null, h('tr', null, ...['BCM', 'Pin', 'Dir', 'Connected to', 'Level'].map((t) => h('th', null, t)))), this.pins))));
      this.term = h('div', { class: 'term' });
      right.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Terminal'), h('span', { class: 'sub mono' }, 'pi@coldstore-pi-01:~ $ journalctl -u coldstore -f')), h('div', { class: 'card-b', style: 'padding:6px' }, this.term)));
      this.raw = h('pre', { class: 'code', style: 'font-size:11.5px' });
      right.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Raw sensor output')), h('div', { class: 'card-b' }, this.raw)));
      this.q = h('tbody');
      this.qSum = h('span', { class: 'sub' });
      right.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'SQLite queue.db'), this.qSum),
        h('div', { class: 'card-b flush scroll', style: 'max-height:260px' }, h('table', { class: 'tbl compact' }, h('thead', null, h('tr', null, ...['seq', 'ts', 'tempC', 'rh', 'status', 'state', 'tries'].map((t) => h('th', null, t)))), this.q))));
      this.termN = 0;
      this.pick('rpi');
    },

    bomCard() {
      const total = CS.config.BOM.reduce((a, [, q, p]) => a + q * p, 0);
      return h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Bill of materials'), h('span', { class: 'sub' }, `≈ ₹${total.toLocaleString('en-IN')} per cold room`)),
        h('div', { class: 'card-b flush' }, h('table', { class: 'tbl compact' },
          h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Approx. ₹'))),
          h('tbody', null, ...CS.config.BOM.map(([n, q, p]) => h('tr', null, h('td', null, n), h('td', { class: 'num' }, q), h('td', { class: 'num' }, p.toLocaleString('en-IN')))),
            h('tr', null, h('td', null, h('b', null, 'Total')), h('td'), h('td', { class: 'num' }, h('b', null, total.toLocaleString('en-IN'))))))));
    },

    pick(id) {
      id = ALIAS[id] || id;
      const c = CS.config.COMPONENTS[id];
      if (!c) return;
      this.infoSub.textContent = c.file;
      const sn = snippet(c.file, c.anchor);
      const pins = CS.config.GPIO.filter((p) => p.comp === id || (id === 'lcd' && p.comp === 'lcd'));
      this.info.innerHTML = '';
      this.info.append(...[
        h('div', { class: 'row' }, h('h3', null, c.name), h('span', { class: 'sp' }), h('button', { class: 'btn sm primary', onclick: () => this.app.openSource(c.file, c.anchor) }, '{ } Open full source')),
        h('div', { class: 'muted', style: 'margin-top:4px' }, c.role),
        h('div', { class: 'spec' }, c.spec),
        pins.length ? h('div', { class: 'small' }, 'Pins: ', ...pins.map((p) => h('span', { class: 'badge info', style: 'margin-right:4px' }, `BCM${p.bcm} / pin ${p.pin}`))) : null,
        h('div', { class: 'small muted mt' }, `${c.file} — from line ${sn.start}`),
        h('pre', { class: 'code', style: 'max-height:330px', html: sn.html })].filter(Boolean));
    },

    render(app) {
      const sim = app.sim, e = sim.edge;
      this.circuit.update(sim);
      const on = e.power === 'ON';
      this.lcd.textContent = on ? e.lcd.join('\n') : '                \n                ';
      this.lcd.className = 'lcd-big' + (!on ? ' off' : e.out.alarm ? ' alarm' : '');
      const r = e.res;
      const tiles = [
        ['CPU', `${r.cpu.toFixed(1)} %`, '4× Cortex-A72'], ['RAM (process)', `${r.ramMb.toFixed(1)} MB`, 'of 4 GB'], ['SoC temp', `${r.cpuTempC.toFixed(1)} °C`, 'throttle at 80 °C'],
        ['Uptime', fmt.dur(r.uptimeS * 1000), e.power], ['queue.db', fmt.bytes(e.store.dbBytes()), `${e.store.written} rows written`], ['Sensor errors', `${sim.sensors.dhtErrors} / ${sim.sensors.dsErrors}`, 'DHT22 / DS18B20'],
      ];
      this.res.innerHTML = tiles.map(([l, v, s2]) => `<div class="kpi"><div class="k-l">${l}</div><div class="k-v" style="font-size:17px">${esc(v)}</div><div class="k-s">${esc(s2)}</div></div>`).join('');
      const gp = e.gpio;
      this.pins.innerHTML = CS.config.GPIO.map((p) => {
        const lv = gp[p.bcm];
        return `<tr><td class="mono">${p.bcm}</td><td class="mono">${p.pin}</td><td>${p.dir}</td><td>${esc(p.use)}</td><td class="lvl ${lv ? 'h' : 'l'}">${p.dir === 'I2C' ? (on ? 'BUS' : '—') : lv ? 'HIGH' : 'LOW'}</td></tr>`;
      }).join('');
      // terminal (append only)
      const lines = e.termLines;
      if (this.termN > lines.length) this.termN = 0;
      if (lines.length !== this.termN || this._termLast !== lines[lines.length - 1]) {
        const atBottom = this.term.scrollHeight - this.term.scrollTop - this.term.clientHeight < 30;
        this.term.innerHTML = lines.slice(-220).map((l) => `<span class="ts">${fmt.time(l.t)}</span> <span class="lv-${l.level}">${l.level.padEnd(8)}</span> <span class="lg">${esc(l.logger.padEnd(20))}</span> ${esc(l.text)}`).join('\n');
        if (atBottom) this.term.scrollTop = this.term.scrollHeight;
        this.termN = lines.length; this._termLast = lines[lines.length - 1];
      }
      const last = e.last;
      if (last) {
        const dsRaw = sim.sensors.dsRaw || '';
        const crcOk = last.ds18b20C != null || dsRaw === 't=85000';
        this.raw.textContent =
`$ cat /sys/bus/w1/devices/28-0316a2794bff/w1_slave
${crcOk ? `4a 01 4b 46 7f ff 0c 10 1c : crc=1c YES\n4a 01 4b 46 7f ff 0c 10 1c ${dsRaw}` : 'ff ff ff ff ff ff ff ff ff : crc=c9 NO\nff ff ff ff ff ff ff ff ff t=-62'}
→ parse_w1_slave(): ${last.ds18b20C == null ? 'None (rejected)' : last.ds18b20C.toFixed(2) + ' °C'}

$ DHT22 on GPIO17 (adafruit_dht)
attempts=${last.dhtAttempts}  temperature=${last.dht22C ?? 'None'}  humidity=${last.rh ?? 'None'}
→ fused temp_c = ${last.tempC ?? 'None'}  (${last.ds18b20C != null ? 'DS18B20 primary' : last.dht22C != null ? 'DHT22 fallback' : 'no sensor!'})

$ gpioget gpiochip0 27   # door reed
${sim.room.doorOpen ? '1   (open for ' + Math.round(last.doorOpenS) + ' s)' : '0   (closed)'}`;
      }
      // queue
      const rows = e.store.pending.slice(-14).reverse();
      this.qSum.textContent = `${e.store.depth} PENDING · ${e.store.sentRows} SENT · ${e.store.dropped} dropped · ${e.store.alerts.length} alerts queued`;
      this.q.innerHTML = rows.length ? rows.map((r) => `<tr class="${r.cond === 'disconnected' ? 'hl' : ''}"><td class="mono">${r.seq}</td><td class="mono">${fmt.time(r.ts)}</td><td class="num">${r.body.tempC ?? '—'}</td><td class="num">${r.body.rh ?? '—'}</td><td>${r.body.status}</td><td>${r.inflight ? '<span class="badge info">IN-FLIGHT</span>' : '<span class="badge warn">PENDING</span>'}</td><td class="num">${r.attempts}</td></tr>`).join('')
        : '<tr><td colspan="7" class="muted">queue empty — every reading acknowledged by IoT Hub</td></tr>';
    },

    onReset() { this.termN = 0; },
  };

  CS.views.hardware = hw;
})(window.CS = window.CS || {});
