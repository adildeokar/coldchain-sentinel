/* MQTT 3.1.1 over TLS 1.2 client model — what azure-iot-device does on the Pi.
 *
 *   DISCONNECTED → CONNECTING (TCP + TLS + CONNECT/SAS + SUBSCRIBE + twin GET)
 *        ↑            │ ok → CONNECTED     │ fail → BACKOFF (1,2,4…32 s ±20 %) → CONNECTING
 *        └── 2 consecutive PUBACK timeouts / keep-alive failure ──┘
 *
 * QoS 1: a message counts as delivered only when IoT Hub's PUBACK comes back.
 * Subclasses (EdgeDevice, BaselineDevice) decide what to do on ack / timeout. */
(function (CS) {
  'use strict';
  const { WIRE } = CS.config;
  const { jsonSize } = CS.util;

  let MSG = 0;

  class MqttDevice {
    constructor(sim, id, node, cfg) {
      this.sim = sim;
      this.id = id;
      this.node = node;                       // topology node id ('pi' or 'base')
      this.cfg = cfg;
      this.state = 'DISCONNECTED';
      this.backoff = cfg.backoffInitialS;
      this.inflight = new Map();
      this.timeouts = 0;
      this.gen = 0;                           // bumps on power-off so stale timers do nothing
      this.lastTx = 0;
      this.stateSince = 0;
      this.stats = { msgs: 0, acks: 0, timeouts: 0, payloadBytes: 0, wireUp: 0, wireDown: 0, tlsBytes: 0,
        handshakes: 0, connectAttempts: 0, reconnects: 0, pings: 0 };
    }

    get upHops() { return [this.node, 'router', 'internet', 'hub']; }
    get downHops() { return ['hub', 'internet', 'router', this.node]; }
    get connected() { return this.state === 'CONNECTED'; }

    _setState(s) {
      if (s === this.state) return;
      this.state = s; this.stateSince = this.sim.t;
      this.sim.bus.emit('mqtt', { id: this.id, state: s });
    }

    _later(ms, fn) { const g = this.gen; return this.sim.schedule(ms, () => { if (g === this.gen) fn(); }); }

    connect() {
      if (this.state === 'OFF' || this.state === 'CONNECTING' || this.state === 'CONNECTED') return;
      this._setState('CONNECTING');
      this.stats.connectAttempts++;
      const link = this.sim.link, cfg = this.cfg;
      this.sim.log(this.logSrc, 'info', `MQTT connect → ${CS.config.HUB.host}:8883 (TLS 1.2, SAS token)`);
      if (!link.up) {
        this.sim.packet({ hops: this.upHops, kind: 'tls', label: '', dur: 120, lostAt: 1 });
        this._later(cfg.connectTimeoutS * 1000, () => this._connectFailed(link.routerPowered ? 'DNS lookup timed out (no internet)' : '[Errno 101] Network is unreachable'));
        return;
      }
      // 6 round trips: TCP, TLS ×2, CONNECT, SUBSCRIBE, twin GET
      const up = WIRE.tlsHandshakeUp + WIRE.mqttConnect + WIRE.subscribe + 6 * WIRE.tcpIp;
      const down = WIRE.tlsHandshakeDown + WIRE.twinGet + 6 * WIRE.tcpIp;
      let rtt = 0;
      for (let i = 0; i < 6; i++) rtt += link.oneWay(up / 6) + link.oneWay(down / 6);
      this.sim.packet({ hops: this.upHops, kind: 'tls', label: '', dur: rtt / 2, lostAt: -1 });
      this.stats.tlsBytes += WIRE.tlsHandshakeUp + WIRE.tlsHandshakeDown;
      this.stats.wireUp += up; this.stats.wireDown += down;
      link.stats.up.bytes += up; link.stats.down.bytes += down;
      this._later(rtt, () => {
        if (!link.up || link.sim.rng.chance(link.params().loss * 2)) return this._connectFailed('TLS handshake timed out');
        this.sim.packet({ hops: this.downHops, kind: 'tls', label: '', dur: rtt / 4, lostAt: -1 });
        const twin = this.sim.cloud.deviceConnected(this.id);
        this.stats.handshakes++;
        if (this.everConnected) this.stats.reconnects++;
        this.everConnected = true;
        this.timeouts = 0;
        this.backoff = cfg.backoffInitialS;
        this.lastTx = this.sim.t;
        this._setState('CONNECTED');
        this.sim.log(this.logSrc, 'ok', `CONNACK — connected to IoT Hub (handshake ${Math.round(rtt)} ms, ${CS.util.fmt.bytes(up + down)})`);
        this.onConnected(twin);
      });
    }

    _connectFailed(reason) {
      if (this.state === 'OFF') return;
      this._setState('BACKOFF');
      const delay = this.backoff * this.sim.rng.range(0.8, 1.2);
      this.sim.log(this.logSrc, 'warn', `connect failed: ${reason} — retry in ${delay.toFixed(1)} s`);
      this.backoff = Math.min(this.backoff * 2, this.cfg.backoffMaxS);
      this._later(delay * 1000, () => { this._setState('DISCONNECTED'); this.connect(); });
    }

    connectionLost(reason) {
      if (this.state !== 'CONNECTED') return;
      this._setState('DISCONNECTED');
      this.sim.log(this.logSrc, 'error', `connection lost (${reason})`);
      const pending = [...this.inflight.values()];
      this.inflight.clear();
      pending.forEach((e) => { e.timer.cancelled = true; this.onTimeout(e, true); });
      this.onDisconnected();
      this._later(this.backoff * 1000, () => this.connect());
    }

    static topic(id, props) {
      const p = { '$.ct': 'application%2Fjson', '$.ce': 'utf-8', ...props };
      return `devices/${id}/messages/events/` + Object.entries(p).map(([k, v]) => `${k.replace('$', '%24')}=${v}`).join('&');
    }

    publish(kind, body, props, ctx = {}) {
      if (this.state !== 'CONNECTED') return null;
      const topic = MqttDevice.topic(this.id, props);
      const payloadBytes = jsonSize(body);
      const wire = payloadBytes + topic.length + 2 + WIRE.mqttFixed + WIRE.tlsRecord + WIRE.tcpIp;
      const msg = { msgId: `m${++MSG}`, kind, body, props, topic, payloadBytes, wireBytes: wire, sentAt: this.sim.now(), sentT: this.sim.t };
      const entry = { msg, ctx };
      this.inflight.set(msg.msgId, entry);
      this.stats.msgs++;
      this.stats.payloadBytes += payloadBytes;
      this.stats.wireUp += wire;
      this.stats.tlsBytes += WIRE.tlsRecord;
      this.lastTx = this.sim.t;
      const label = kind === 'batch' ? `×${body.count}` : kind === 'alert' ? '!' : '';
      this.sim.link.send('up', wire, { hops: this.upHops, kind, label, msg }, () => {
        this.sim.cloud.receive(this.id, msg, (accepted) => {
          if (!accepted) return;
          const ack = WIRE.puback + WIRE.tlsRecord + WIRE.tcpIp;
          this.sim.link.send('down', ack, { hops: this.downHops, kind: 'ack', label: '' }, () => {
            this.stats.wireDown += ack; this.stats.tlsBytes += WIRE.tlsRecord;
            this._puback(msg.msgId);
          });
        });
      });
      entry.timer = this._later(this.cfg.pubackTimeoutS * 1000, () => this._timeout(msg.msgId));
      this.sim.bus.emit('publish', { id: this.id, msg });
      return msg;
    }

    _puback(msgId) {
      const e = this.inflight.get(msgId);
      if (!e) return;                          // late PUBACK after we already gave up → the retry will be a duplicate
      e.timer.cancelled = true;
      this.inflight.delete(msgId);
      this.timeouts = 0;
      this.stats.acks++;
      e.rtt = this.sim.now() - e.msg.sentAt;
      this.onAck(e);
    }

    _timeout(msgId) {
      const e = this.inflight.get(msgId);
      if (!e) return;
      this.inflight.delete(msgId);
      this.timeouts++;
      this.stats.timeouts++;
      this.sim.log(this.logSrc, 'warn', `PUBACK timeout for ${e.msg.kind} ${e.msg.msgId} (${this.timeouts} in a row)`);
      this.onTimeout(e, false);
      if (this.timeouts >= 2) this.connectionLost('2 consecutive PUBACK timeouts');
    }

    // MQTT keep-alive: PINGREQ when idle, connection dead if no PINGRESP
    keepAlive() {
      if (this.state !== 'CONNECTED') return;
      if (this.sim.t - this.lastTx < this.cfg.keepAliveS * 1000 * 0.5) return;
      this.stats.pings++;
      this.lastTx = this.sim.t;
      const bytes = 2 + WIRE.tlsRecord + WIRE.tcpIp;
      this.stats.wireUp += bytes;
      let answered = false;
      this.sim.link.send('up', bytes, { hops: this.upHops, kind: 'ping', label: '' }, () => {
        this.sim.cloud.ping(this.id, () => {
          this.sim.link.send('down', bytes, { hops: this.downHops, kind: 'ack', label: '' }, () => { answered = true; });
        });
      });
      this._later(this.cfg.pubackTimeoutS * 1000 * 2, () => { if (!answered) this.connectionLost('keep-alive PINGRESP timeout'); });
    }

    powerOff() {
      this.gen++;
      this.inflight.forEach((e) => (e.timer.cancelled = true));
      const pending = [...this.inflight.values()];
      this.inflight.clear();
      pending.forEach((e) => this.onTimeout(e, true));
      this._setState('OFF');
    }

    powerOn() {
      this.gen++;
      this.backoff = this.cfg.backoffInitialS;
      this.timeouts = 0;
      this._setState('DISCONNECTED');
    }

    // hooks
    onConnected() {}
    onDisconnected() {}
    onAck() {}
    onTimeout() {}
  }

  CS.MqttDevice = MqttDevice;
})(typeof window !== 'undefined' ? (window.CS = window.CS || {}) : (global.CS = global.CS || {}));
