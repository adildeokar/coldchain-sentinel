/* App controller (browser). Connects to the server's event stream, keeps the
 * RemoteSim mirror up to date, drives navigation and global UI, and forwards
 * controls (speed, pause, reset) to the server. No simulation runs here. */
(function (CS) {
  'use strict';
  const { $, $$ } = CS.dom;
  const { fmt } = CS.util;

  const store = {
    get(k) { try { return localStorage.getItem('coldchain.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('coldchain.' + k, v); } catch (e) { /* private mode */ } },
  };

  const app = {
    get speed() { return this.sim.speed; },
    get playing() { return this.sim.playing; },
    current: 'live',
    lastMsg: null,
    results: null,
    tests: null,
    sound: false,
    connected: false,

    async init() {
      this.theme = store.get('theme') || 'dark';
      this.applyTheme();
      this.sim = new CS.RemoteSim();
      try { window.CS_SOURCES = await CS.api.get('/api/sources'); } catch (e) { window.CS_SOURCES = {}; }
      // ?script=E2&warm=700 — ask the server to pre-run a scenario (rehearsals, screenshots)
      const qs = new URLSearchParams(location.search);
      if (qs.get('script') || qs.get('warm')) await CS.api.post('/api/reset', { script: qs.get('script'), warm: +qs.get('warm') || 0 }).catch(() => {});
      await this.connect();                       // views are built once the first server snapshot is here
      Object.entries(CS.views).forEach(([k, v]) => { const el = $(`#view-${k}`); if (el) v.init(this, el); });

      $$('#sidenav > button').forEach((b) => b.addEventListener('click', () => this.show(b.dataset.view)));
      $$('#speed button').forEach((b) => b.addEventListener('click', () => this.setSpeed(+b.dataset.speed)));
      $('#btn-play').addEventListener('click', () => this.setPlaying(!this.playing));
      $('#btn-reset').addEventListener('click', () => { this.reset(); this.toast('Simulation restarted on the server', 'New random seed; experiments are unaffected.'); });
      $('#btn-theme').addEventListener('click', () => { this.theme = this.theme === 'dark' ? 'light' : 'dark'; store.set('theme', this.theme); this.applyTheme(); });
      $('#btn-sound').addEventListener('click', () => this.toggleSound());
      $('#btn-autodemo').addEventListener('click', () => CS.views.guide.startDemo());
      document.addEventListener('keydown', (e) => {
        if (e.target.matches('input, textarea, select')) return;
        if (e.code === 'Space') { e.preventDefault(); this.setPlaying(!this.playing); }
      });

      if (qs.get('speed')) this.setSpeed(+qs.get('speed'));
      const startView = (location.hash || '').slice(1);
      if (CS.views[startView]) this.show(startView);
      requestAnimationFrame((t) => this.loop(t));
      setInterval(() => this.tick(), 200);
    },

    // Server-Sent Events: state 4×/s, packets 10×/s, events (toasts), reset
    connect() {
      let first;
      const ready = new Promise((r) => (first = r));
      const es = new EventSource('/api/stream');
      this.es = es;
      es.addEventListener('state', (m) => {
        this.sim.apply(JSON.parse(m.data));
        if (this.sim.lastMsg) this.lastMsg = this.sim.lastMsg;
        if (!this.connected) { this.connected = true; this.serverPill(); }
        first();
      });
      es.addEventListener('packets', (m) => {
        if (this.current !== 'live' || !this.topology) return;
        const { speed, packets } = JSON.parse(m.data);
        packets.forEach((p) => this.topology.addPacket(p, speed));
      });
      es.addEventListener('events', (m) => JSON.parse(m.data).forEach((ev) => this.onEvent(ev)));
      es.addEventListener('reset', () => {
        this.sim.clear();
        this.lastMsg = null;
        Object.values(CS.views).forEach((v) => v.onReset && v.onReset(this));
      });
      es.onerror = () => { this.connected = false; this.serverPill(); };
      return ready;
    },

    onEvent(ev) {
      if (ev.type === 'alarm') this.toast(`LOCAL ALARM · ${CS.rules.LABEL[ev.alarm]}`, `${ev.value} vs limit ${ev.threshold} — buzzer + red LED on at the site${ev.online ? '' : ' (cloud OFFLINE, alert queued)'}`, 'err');
      else if (ev.type === 'notify' && ev.severity === 'critical') this.toast(`📱 ${ev.channels.join(' + ')} to operator`, ev.title, 'warn');
      else if (ev.type === 'sync') this.toast('Backlog synced', ev.text, 'ok');
    },

    serverPill() {
      const p = $('#pill-server');
      p.textContent = this.connected ? `SERVER ● ${this.sim.clients || 1}` : 'SERVER OFFLINE';
      p.className = 'pill ' + (this.connected ? 'ok' : 'err blink');
      p.title = this.connected ? `Connected to the simulation server · ${this.sim.clients || 1} browser(s) · seed ${this.sim.seed}` : 'Lost the server — is "npm start" still running? Reconnecting…';
    },

    reset() { return CS.api.post('/api/reset', {}); },

    loop(t) {
      if (this.current === 'live' && this.topology) this.topology.frame(t);
      if (this.sim.ready) $('#sim-clock').textContent = fmt.time(this.sim.now());
      requestAnimationFrame((x) => this.loop(x));
    },

    tick() {
      const sim = this.sim, e = sim.edge;
      this.serverPill();
      $$('#speed button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === sim.speed));
      $('#btn-play').textContent = sim.playing ? '❚❚ Pause' : '▶ Play';
      if (!sim.ready) return;
      $('#sim-elapsed').textContent = `T+${fmt.clock(sim.tNow)} · ${sim.speed}×`;
      const pr = $('#pill-room');
      const st = e.last ? e.last.status : '—';
      pr.textContent = `ROOM ${st}${e.last && e.last.tempC != null ? ' ' + e.last.tempC.toFixed(1) + '°C' : ''}`;
      pr.className = 'pill ' + ({ OK: 'ok', WARN: 'warn', ALARM: 'err blink', FAULT: 'err' }[st] || '');
      const pn = $('#pill-net');
      pn.textContent = `WAN ${(sim.link.state || '').toUpperCase()}`;
      pn.className = 'pill ' + (!sim.link.up ? 'err' : sim.link.mode === 'degraded' ? 'warn' : 'ok');
      const pm = $('#pill-mqtt');
      pm.textContent = `MQTT ${e.state}`;
      pm.className = 'pill ' + (e.connected ? 'ok' : e.state === 'CONNECTING' ? 'warn' : 'err');
      const pq = $('#pill-queue');
      pq.textContent = `QUEUE ${e.store.depth}`;
      pq.className = 'pill ' + (e.store.depth > 3 ? 'warn' : '');
      const v = CS.views[this.current];
      if (v && v.render) {
        try { v.render(this); } catch (err) { console.error(err); }
      }
      this.beep();
    },

    show(view) {
      if (!CS.views[view]) return;
      this.current = view;
      $$('#sidenav > button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
      $$('.view').forEach((s) => s.classList.toggle('on', s.id === `view-${view}`));
      if (view !== 'live' && this.topology) this.topology.clear();
      const v = CS.views[view];
      if (v.onShow) v.onShow(this);
      if (this.sim.ready) { try { v.render && v.render(this, true); } catch (err) { console.error(err); } }
      try { history.replaceState(null, '', '#' + view); } catch (e) { /* ignore */ }
    },

    setSpeed(s) { this.sim.speed = s; CS.api.post('/api/control', { speed: s }); },
    setPlaying(p) { this.sim.playing = p; CS.api.post('/api/control', { playing: p }); },

    applyTheme() { document.documentElement.setAttribute('data-theme', this.theme); },

    inspect(id) { CS.views.live.inspect(this, id); },
    showMessage(msg) { CS.views.live.w.follow.checked = false; CS.views.live.showMessage(msg); this.toast('Message pinned', 'Shown in "Message on the wire" below the log. Tick "follow latest" to resume.'); },
    openSource(path, anchor) { this.show('source'); CS.views.source.open(path, anchor); },
    toast(t, s, k) { CS.dom.toast(t, s, k); },

    toggleSound() {
      this.sound = !this.sound;
      $('#btn-sound').textContent = this.sound ? '🔊' : '🔇';
      if (this.sound && !this.ac) { try { this.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.sound = false; } }
      if (this.ac && this.ac.state === 'suspended') this.ac.resume();
      this.toast(this.sound ? 'Buzzer sound on' : 'Buzzer sound off', this.sound ? 'You will hear the Pi\'s buzzer while it is active.' : '');
    },

    beep() {
      const o0 = this.sim.edge.out || {};
      if (!this.sound || !this.ac || !o0.buzzer || this.sim.edge.power !== 'ON' || !this.playing) return;
      const now = performance.now();
      if (this._lastBeep && now - this._lastBeep < 600) return;
      this._lastBeep = now;
      const o = this.ac.createOscillator(), g = this.ac.createGain();
      o.frequency.value = 2700; o.type = 'square';
      g.gain.setValueAtTime(0.04, this.ac.currentTime);
      g.gain.setValueAtTime(0, this.ac.currentTime + 0.32);
      o.connect(g).connect(this.ac.destination);
      o.start(); o.stop(this.ac.currentTime + 0.35);
    },
  };

  CS.app = app;
  window.addEventListener('DOMContentLoaded', () => app.init());
})(window.CS = window.CS || {});
