/* Terminal output for the server: every simulation event, colour-coded by source,
 * plus a status line every 15 s — this is the "processing" view for the judges. */
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m', bgRed: '\x1b[41m' };

const SRC = { EDGE: C.cyan, BASE: C.gray, NET: C.yellow, HUB: C.blue, ROUTE: C.magenta, FUNC: C.magenta, ASA: C.cyan, COSMOS: C.cyan, NOTIFY: C.magenta, ROOM: C.blue, SENSOR: C.yellow, POWER: C.red, SIM: C.gray };
const LVL = { alarm: C.bgRed + C.bold, error: C.red, warn: C.yellow, ok: C.green, info: '', debug: C.dim };

const pad = (n) => String(n).padStart(2, '0');
const hms = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

module.exports = {
  C,
  sim(e) {
    const col = SRC[e.src] || '';
    const lv = LVL[e.level] || '';
    console.log(`${C.gray}${hms(e.t)}${C.reset} ${col}${e.src.padEnd(6)}${C.reset} ${lv}${e.msg}${C.reset}`);
  },
  info(msg) { console.log(`${C.gray}[server]${C.reset} ${msg}`); },
  action(name, args) { console.log(`${C.green}[browser → server]${C.reset} ${C.bold}${name}${C.reset}(${args.map((a) => JSON.stringify(a)).join(', ')})`); },
  http(method, url, status, ms) { if (process.env.HTTP_LOG) console.log(`${C.dim}${method} ${url} ${status} ${ms}ms${C.reset}`); },
  status(host) {
    const s = host.sim, e = s.edge, l = e.last;
    const docs = Object.values(s.cloud.telemetry).reduce((a, t) => a + t.docs.length, 0);
    const clock = new Date(s.t).toISOString().substr(11, 8);
    console.log(`${C.bold}${C.cyan}── status${C.reset} T+${clock} ${host.speed}×${host.playing ? '' : ' (paused)'} │ room ${l && l.tempC != null ? l.tempC.toFixed(1) + '°C' : '—'} ${l ? l.status : ''} │ WAN ${s.link.state} │ MQTT ${e.state} │ queue ${e.store.depth} │ cloud docs ${docs} │ alerts ${s.cloud.alerts.length} │ browsers ${host.clients.size}`);
  },
};
