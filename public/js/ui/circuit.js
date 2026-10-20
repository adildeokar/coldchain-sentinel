/* Circuit / wiring schematic of the edge node, drawn live: a wire glows while
 * its GPIO is HIGH, LEDs light, the buzzer vibrates and the LCD mirrors the
 * real text. Click any component to see its spec and the driver code. */
(function (CS) {
  'use strict';
  const { s } = CS.dom;

  const RAIL = { v33: 340, v5: 362, gnd: 384 };
  const COL = { v33: '#ef4444', v5: '#f97316', gnd: '#94a3b8', sig: '#eab308', i2c: '#22d3ee', ow: '#a3e635', out: '#60a5fa', in: '#c084fc' };

  // Pi header rows drawn on the schematic block: [phys pin, label, y, kind]
  const PINS = [
    [1, '3V3', 40, 'v33'], [2, '5V', 56, 'v5'], [6, 'GND', 72, 'gnd'],
    [3, 'GPIO2 SDA', 112, 'i2c'], [5, 'GPIO3 SCL', 126, 'i2c'],
    [7, 'GPIO4 1-Wire', 214, 'ow'], [11, 'GPIO17', 306, 'sig'], [12, 'GPIO18', 404, 'out'],
    [13, 'GPIO27', 488, 'in'], [15, 'GPIO22', 532, 'in'], [16, 'GPIO23', 578, 'out'], [18, 'GPIO24', 616, 'out'], [22, 'GPIO25', 654, 'out'],
  ];

  class Circuit {
    constructor(host, onPick) {
      this.onPick = onPick;
      this.svg = s('svg', { id: 'circuit', viewBox: '0 0 1000 700', role: 'img', 'aria-label': 'Circuit diagram' });
      host.appendChild(this.svg);
      this.w = {};      // wires by key
      this.c = {};      // component groups
      this.flash = {};
      this.build();
    }

    wire(pts, color, key, extra = '') {
      const p = s('path', { class: 'c-wire ' + extra, d: 'M' + pts.map((q) => q.join(',')).join(' L'), stroke: color, style: `color:${color}` });
      this.g.appendChild(p);
      if (key) (this.w[key] = this.w[key] || []).push(p);
      return p;
    }
    dot(x, y, c = '#cbd5e1') { this.g.appendChild(s('circle', { cx: x, cy: y, r: 3.4, fill: c })); }
    text(x, y, t, cls = 'c-label', anchor = 'start') { const e = s('text', { x, y, class: cls, 'text-anchor': anchor }, t); this.g.appendChild(e); return e; }
    comp(id, x, y, w, h) {
      const g = s('g', { class: 'c-comp', 'data-comp': id });
      g.appendChild(s('rect', { class: 'c-hl', x: x - 6, y: y - 6, width: w + 12, height: h + 12, rx: 8 }));
      g.addEventListener('click', () => this.pick(id));
      this.g.appendChild(g);
      this.c[id] = g;
      return g;
    }
    pick(id) {
      Object.values(this.c).forEach((g) => g.classList.toggle('sel', g.dataset.comp === id));
      this.onPick && this.onPick(id);
    }
    resistorH(g, x1, x2, y, label) {
      const m = (x1 + x2) / 2;
      g.appendChild(s('path', { d: `M${x1},${y} L${m - 18},${y} l3,-6 l6,12 l6,-12 l6,12 l6,-12 l6,12 l3,-6 L${x2},${y}`, fill: 'none', stroke: '#d9b98a', 'stroke-width': 2 }));
      g.appendChild(s('text', { x: m, y: y - 9, class: 'c-label sm', 'text-anchor': 'middle' }, label));
    }
    resistorV(g, x, y1, y2, label) {
      const m = (y1 + y2) / 2;
      g.appendChild(s('path', { d: `M${x},${y1} L${x},${m - 9} l-5,1.5 l10,3 l-10,3 l10,3 l-10,3 l5,1.5 L${x},${y2}`, fill: 'none', stroke: '#d9b98a', 'stroke-width': 2 }));
      g.appendChild(s('text', { x: x + 8, y: m + 3, class: 'c-label sm' }, label));
    }

    build() {
      const g = this.g = s('g');
      this.svg.appendChild(g);
      // ---- Pi schematic block ----
      const pi = this.comp('rpi', 120, 20, 170, 660);
      pi.appendChild(s('rect', { x: 120, y: 20, width: 170, height: 660, rx: 10, fill: 'var(--pcb)', stroke: '#0a3a24', 'stroke-width': 2 }));
      pi.appendChild(s('text', { x: 205, y: 350, class: 'c-title', 'text-anchor': 'middle', transform: 'rotate(-90 205 350)', fill: '#d1fae5' }, 'Raspberry Pi 4 Model B · 40-pin header (BCM)'));
      PINS.forEach(([n, label, y, kind]) => {
        pi.appendChild(s('rect', { x: 274, y: y - 5, width: 10, height: 10, class: 'pin', 'data-bcm': label }));
        pi.appendChild(s('text', { x: 268, y: y + 3.5, class: 'c-pinlabel', 'text-anchor': 'end' }, `${label} · ${n}`));
      });
      // physical header thumbnail
      const hdr = s('g', { transform: 'translate(132,40)' });
      for (let i = 0; i < 20; i++) for (let r = 0; r < 2; r++) {
        const phys = i * 2 + r + 1;
        const used = PINS.some((p) => p[0] === phys) || [9, 14, 20, 25, 30, 34, 39].includes(phys) && false;
        hdr.appendChild(s('rect', { x: r * 9, y: i * 9, width: 6, height: 6, fill: used ? '#ffe066' : '#b08d4a', opacity: used ? 1 : 0.6 }));
      }
      pi.appendChild(hdr);
      pi.appendChild(s('text', { x: 132, y: 232, class: 'c-label sm', fill: '#cfe8d5' }, 'pin 1'));

      // ---- UPS + power ----
      const ups = this.comp('ups', 14, 470, 92, 120);
      ups.appendChild(s('rect', { x: 14, y: 470, width: 92, height: 120, rx: 8, fill: 'var(--panel3)', stroke: 'var(--line2)' }));
      ups.appendChild(s('text', { x: 60, y: 490, class: 'c-label', 'text-anchor': 'middle' }, 'UPS HAT'));
      [0, 1].forEach((i) => ups.appendChild(s('rect', { x: 26 + i * 36, y: 500, width: 30, height: 70, rx: 6, fill: '#2563eb', stroke: '#93c5fd' })));
      ups.appendChild(s('text', { x: 60, y: 584, class: 'c-label sm', 'text-anchor': 'middle' }, '2×18650'));
      this.wire([[106, 520], [120, 520]], COL.v5, null);
      this.wire([[106, 540], [120, 540]], COL.gnd, null);
      this.text(14, 610, 'stacked on the header:', 'c-label sm');
      this.text(14, 622, 'feeds 5V + GND (pins 2/4, 6)', 'c-label sm');
      this.text(14, 40, 'USB-C 5 V 3 A', 'c-label sm');
      this.text(14, 52, '→ UPS → Pi', 'c-label sm');
      this.text(14, 140, 'Wi-Fi / Ethernet', 'c-label sm');
      this.text(14, 152, '→ site router', 'c-label sm');
      this.text(14, 164, '→ Azure IoT Hub', 'c-label sm');

      // ---- rails ----
      this.wire([[284, 40], [RAIL.v33, 40], [RAIL.v33, 300]], COL.v33, 'v33');
      this.wire([[284, 56], [RAIL.v5, 56], [RAIL.v5, 380]], COL.v5, 'v5');
      this.wire([[284, 72], [RAIL.gnd, 72], [RAIL.gnd, 676]], COL.gnd, 'gnd');
      this.text(RAIL.v33 - 6, 18, '3V3', 'c-label sm'); this.text(RAIL.v5 - 4, 30, '5V', 'c-label sm'); this.text(RAIL.gnd - 6, 18, 'GND', 'c-label sm');

      // ---- LCD (I2C) ----
      const lcd = this.comp('lcd', 640, 60, 320, 96);
      lcd.appendChild(s('rect', { x: 640, y: 60, width: 320, height: 96, rx: 6, fill: '#1e5a2a', stroke: '#0f3016', 'stroke-width': 2 }));
      lcd.appendChild(s('rect', { x: 600, y: 74, width: 40, height: 66, rx: 3, fill: '#1f2937', stroke: '#4b5563' }));
      lcd.appendChild(s('text', { x: 620, y: 150, class: 'c-label sm', 'text-anchor': 'middle' }, 'PCF8574'));
      this.lcdBg = s('rect', { x: 668, y: 78, width: 270, height: 60, rx: 3, fill: '#9bbc0f' });
      lcd.appendChild(this.lcdBg);
      this.lcd1 = s('text', { x: 680, y: 102, class: 'lcd-t', style: 'font-size:17px' }, '');
      this.lcd2 = s('text', { x: 680, y: 128, class: 'lcd-t', style: 'font-size:17px' }, '');
      lcd.append(this.lcd1, this.lcd2);
      lcd.appendChild(s('text', { x: 800, y: 172, class: 'c-label', 'text-anchor': 'middle' }, '16×2 LCD · I²C 0x27'));
      ['GND', 'VCC', 'SDA', 'SCL'].forEach((l, i) => lcd.appendChild(s('text', { x: 596, y: 84 + i * 14, class: 'c-label sm', 'text-anchor': 'end' }, l)));
      this.wire([[RAIL.gnd, 81], [600, 81]], COL.gnd, null); this.dot(RAIL.gnd, 81);
      this.wire([[RAIL.v5, 95], [600, 95]], COL.v5, null); this.dot(RAIL.v5, 95);
      this.wire([[284, 112], [440, 112], [440, 109], [600, 109]], COL.i2c, 'i2c');
      this.wire([[284, 126], [450, 126], [450, 123], [600, 123]], COL.i2c, 'i2c');

      // ---- DS18B20 ----
      const ds = this.comp('ds18b20', 640, 186, 200, 56);
      ds.appendChild(s('rect', { x: 760, y: 198, width: 70, height: 20, rx: 8, fill: '#c0c7d2', stroke: '#7d8796' }));
      ds.appendChild(s('path', { d: 'M640 196 Q700 196 760 204 M640 212 Q700 212 760 208 M640 228 Q700 228 760 212', fill: 'none', stroke: '#111', 'stroke-width': 1 }));
      ds.appendChild(s('text', { x: 795, y: 236, class: 'c-label', 'text-anchor': 'middle' }, 'DS18B20 probe'));
      ds.appendChild(s('text', { x: 845, y: 212, class: 'c-label sm' }, '→ inside cold room'));
      this.wire([[RAIL.v33, 196], [640, 196]], COL.v33, null); this.dot(RAIL.v33, 196);
      this.wire([[284, 214], [640, 214]], COL.ow, 'gpio4');
      this.wire([[RAIL.gnd, 230], [640, 230]], COL.gnd, null); this.dot(RAIL.gnd, 230);
      const r1 = this.comp('r47k', 540, 190, 30, 30);
      this.resistorV(r1, 560, 196, 214, '4.7 kΩ');
      this.dot(560, 196); this.dot(560, 214);
      ['VDD', 'DQ', 'GND'].forEach((l, i) => this.text(632, 192 + i * 16, l, 'c-label sm', 'end'));

      // ---- DHT22 ----
      const dht = this.comp('dht22', 640, 270, 120, 80);
      dht.appendChild(s('rect', { x: 690, y: 266, width: 60, height: 76, rx: 5, fill: '#f1f3f6', stroke: '#9aa3b2' }));
      for (let i = 0; i < 6; i++) dht.appendChild(s('line', { x1: 698, y1: 276 + i * 10, x2: 742, y2: 276 + i * 10, stroke: '#9aa3b2' }));
      dht.appendChild(s('text', { x: 762, y: 292, class: 'c-label' }, 'DHT22 / AM2302'));
      dht.appendChild(s('text', { x: 762, y: 306, class: 'c-label sm' }, 'RH + temp · in cold room'));
      ['VCC', 'DATA', 'GND'].forEach((l, i) => this.text(686, 294 + i * 18 - 4, l, 'c-label sm', 'end'));
      this.wire([[RAIL.v33, 290], [690, 290]], COL.v33, null); this.dot(RAIL.v33, 290);
      this.wire([[284, 306], [690, 306]], COL.sig, 'gpio17');
      this.wire([[RAIL.gnd, 324], [690, 324]], COL.gnd, null); this.dot(RAIL.gnd, 324);
      const r2 = this.comp('r10k', 540, 284, 30, 30);
      this.resistorV(r2, 590, 290, 306, '10 kΩ');
      this.dot(590, 290); this.dot(590, 306);

      // ---- buzzer driver ----
      const bz = this.comp('buzzer', 560, 360, 290, 90);
      this.wire([[284, 404], [540, 404]], COL.out, 'gpio18');
      this.resistorH(bz, 540, 610, 404, '1 kΩ');
      // 2N2222 NPN
      bz.appendChild(s('circle', { cx: 640, cy: 404, r: 20, fill: 'none', stroke: 'var(--text2)', 'stroke-width': 1.6 }));
      bz.appendChild(s('path', { d: 'M610 404 H630 M630 390 V418 M630 396 L648 384 V372 M630 412 L648 424 V440', fill: 'none', stroke: 'var(--text2)', 'stroke-width': 1.8 }));
      bz.appendChild(s('path', { d: 'M641 418 L648 424 L640 425 z', fill: 'var(--text2)' }));
      bz.appendChild(s('text', { x: 666, y: 410, class: 'c-label sm' }, '2N2222'));
      this.buzz = s('g', { transform: 'translate(760,368)' },
        s('circle', { r: 16, fill: '#1c1f26', stroke: '#454c5a', 'stroke-width': 2 }), s('circle', { r: 4, fill: '#454c5a' }),
        s('path', { class: 'buzz-wave', d: 'M22 -10 q8 10 0 20' }), s('path', { class: 'buzz-wave w2', d: 'M30 -16 q12 16 0 32' }));
      bz.appendChild(this.buzz);
      bz.appendChild(s('text', { x: 812, y: 372, class: 'c-label' }, 'buzzer 5 V'));
      this.wire([[RAIL.v5, 352], [744, 352], [744, 362]], COL.v5, null); this.dot(RAIL.v5, 352);
      this.wire([[648, 372], [700, 372], [700, 380], [760, 380], [760, 384]], '#64748b', 'buzzc');
      this.wire([[648, 440], [648, 446], [RAIL.gnd, 446]], COL.gnd, null); this.dot(RAIL.gnd, 446);
      this.text(752, 348, '+', 'c-label', 'middle');

      // ---- reed switch ----
      const reed = this.comp('reed', 600, 474, 150, 30);
      this.wire([[284, 488], [640, 488]], COL.in, 'gpio27');
      this.reedArm = s('path', { d: 'M640 488 L688 478', stroke: 'var(--text2)', 'stroke-width': 2.4, 'stroke-linecap': 'round' });
      reed.append(s('circle', { cx: 640, cy: 488, r: 3, fill: 'var(--text2)' }), s('circle', { cx: 692, cy: 488, r: 3, fill: 'var(--text2)' }), this.reedArm);
      reed.appendChild(s('text', { x: 720, y: 486, class: 'c-label' }, 'door reed (MC-38)'));
      this.reedText = s('text', { x: 720, y: 500, class: 'c-label sm' }, '');
      reed.appendChild(this.reedText);
      this.wire([[692, 488], [700, 488], [700, 508], [RAIL.gnd, 508]], COL.gnd, null); this.dot(RAIL.gnd, 508);

      // ---- ACK button ----
      const btn = this.comp('button', 600, 518, 150, 30);
      this.wire([[284, 532], [640, 532]], COL.in, 'gpio22');
      this.btnTop = s('path', { d: 'M638 522 H694 M666 522 V512', stroke: 'var(--text2)', 'stroke-width': 2.4 });
      btn.append(s('circle', { cx: 640, cy: 532, r: 3, fill: 'var(--text2)' }), s('circle', { cx: 692, cy: 532, r: 3, fill: 'var(--text2)' }), this.btnTop);
      btn.appendChild(s('text', { x: 720, y: 536, class: 'c-label' }, 'ACK push button'));
      this.wire([[692, 532], [700, 532], [700, 552], [RAIL.gnd, 552]], COL.gnd, null); this.dot(RAIL.gnd, 552);

      // ---- LEDs ----
      this.ledEls = {};
      [['ledRed', 578, '#ff3b3b', 'red · ALARM', 'gpio23'], ['ledGreen', 616, '#2bff7a', 'green · OK', 'gpio24'], ['ledAmber', 654, '#ffb020', 'amber · CLOUD', 'gpio25']].forEach(([id, y, col, label, key]) => {
        const c = this.comp(id, 540, y - 14, 230, 28);
        this.wire([[284, y], [540, y]], COL.out, key);
        this.resistorH(c, 540, 600, y, '330 Ω');
        this.wire([[600, y], [640, y]], COL.out, key);
        const led = s('path', { d: `M640 ${y - 9} L640 ${y + 9} L656 ${y} Z`, fill: '#2a3346', stroke: col, 'stroke-width': 1.5 });
        c.append(led, s('path', { d: `M657 ${y - 9} V${y + 9}`, stroke: col, 'stroke-width': 2 }));
        c.appendChild(s('text', { x: 700, y: y + 4, class: 'c-label' }, label));
        this.ledEls[id] = { el: led, col };
        this.wire([[657, y], [670, y], [670, y + 14], [RAIL.gnd, y + 14]], COL.gnd, null); this.dot(RAIL.gnd, y + 14);
      });

      // legend
      const lg = s('g', { transform: 'translate(820,600)' });
      [['3V3', COL.v33], ['5V', COL.v5], ['GND', COL.gnd], ['I²C', COL.i2c], ['1-Wire', COL.ow], ['GPIO out', COL.out], ['GPIO in', COL.in]].forEach(([l, c], i) => {
        lg.appendChild(s('line', { x1: 0, y1: i * 13, x2: 18, y2: i * 13, stroke: c, 'stroke-width': 3 }));
        lg.appendChild(s('text', { x: 24, y: i * 13 + 4, class: 'c-label sm' }, l));
      });
      g.appendChild(lg);
      this.text(560, 690, 'Glowing wire = line HIGH now · click a part for specs + driver code', 'c-label sm');
    }

    update(sim) {
      const e = sim.edge, gp = e.gpio, on = e.power === 'ON', now = performance.now();
      if (e.sampleCount !== this._lastSample) { this._lastSample = e.sampleCount; this.flash.read = now; }
      const reading = now - (this.flash.read || 0) < 450;
      const hi = { gpio4: on && reading, gpio17: on && reading, i2c: on && reading, gpio18: !!gp[18], gpio23: !!gp[23], gpio24: !!gp[24], gpio25: !!gp[25], gpio27: !!gp[27], gpio22: false, buzzc: !!gp[18], v33: on, v5: true, gnd: false };
      Object.entries(this.w).forEach(([k, arr]) => arr.forEach((p) => p.classList.toggle('hi', !!hi[k])));
      this.lcd1.textContent = on ? e.lcd[0] : '';
      this.lcd2.textContent = on ? e.lcd[1] : '';
      this.lcdBg.setAttribute('fill', !on ? '#36451c' : e.out.alarm ? '#e3a02c' : '#9bbc0f');
      this.buzz.classList.toggle('buzz-on', !!gp[18]);
      const blinkOn = Math.floor(now / 250) % 2 === 0;
      const amberBlink = e.out.amber === 'blink' && Math.floor(now / 110) % 2 === 0;
      Object.entries(this.ledEls).forEach(([id, { el, col }]) => {
        const bcm = { ledRed: 23, ledGreen: 24, ledAmber: 25 }[id];
        let lit = !!gp[bcm];
        if (id === 'ledRed' && e.out.critical && !e.out.silenced) lit = lit && blinkOn;
        if (id === 'ledAmber' && e.out.amber === 'blink') lit = lit && amberBlink;
        el.setAttribute('fill', lit ? col : '#2a3346');
        el.style.filter = lit ? `drop-shadow(0 0 6px ${col})` : '';
      });
      const open = sim.room.doorOpen;
      this.reedArm.setAttribute('d', open ? 'M640 488 L684 470' : 'M640 488 L690 486');
      this.reedText.textContent = open ? 'door OPEN → contact open → GPIO27 HIGH' : 'door closed → magnet closes contact → LOW';
      [...this.svg.querySelectorAll('rect.pin')].forEach((r) => {
        const lbl = r.getAttribute('data-bcm');
        const m = /^GPIO(\d+)/.exec(lbl);
        let h = false;
        if (m) h = !!gp[+m[1]] || ((+m[1] === 4 || +m[1] === 17 || +m[1] === 2 || +m[1] === 3) && reading);
        else h = lbl !== 'GND' && (lbl === '5V' || on);
        r.classList.toggle('hi', h);
      });
    }
  }

  CS.Circuit = Circuit;
})(window.CS = window.CS || {});
