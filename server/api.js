/* HTTP layer: REST API, Server-Sent Events stream, and static files.
 * Built on Node's http module only — no npm install needed. */
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const inspect = require('./inspect');
const log = require('./log');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED_ENGINE = new Set(['util.js', 'config.js', 'rules.js']);   // engine files the browser also loads
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const SOURCE_DIRS = ['server', 'engine', 'public', 'firmware', 'cloud', 'tools'];
const SOURCE_FILES = ['package.json', 'start.bat', 'README.md', 'everything.md'];
const SOURCE_EXT = /\.(py|yaml|yml|txt|service|sh|json|asaql|js|css|html|md|bat)$/;
const SKIP = new Set(['__pycache__', 'node_modules', '.git', 'data', '.venv']);

const ENDPOINTS = [
  ['GET', '/api/stream', 'Server-Sent Events: state (4/s), packets (10/s), events, reset'],
  ['GET', '/api/state', 'full one-shot snapshot of the running simulation'],
  ['POST', '/api/control', '{ speed?, playing? }'],
  ['POST', '/api/action', '{ name, args } — inject a fault / outage / operator action'],
  ['POST', '/api/reset', '{ seed?, profile?, script?, warm? } — restart the simulation'],
  ['POST', '/api/twin', '{ deviceId, patch } — update device-twin desired properties'],
  ['POST', '/api/method', '{ deviceId, name, payload } — invoke a direct method (waits for the reply)'],
  ['GET', '/api/inspect/:node', 'live internal state of one topology node'],
  ['GET', '/api/experiments', '?seed&profile&cached=1 — run experiments E1–E6 on the server'],
  ['GET', '/api/selftest', 'run the automated test suite on the server'],
  ['GET', '/api/sources', 'every project source file, read from disk'],
  ['GET', '/api/health', 'liveness'],
];

function json(res, status, body) {
  const data = JSON.stringify(body, (k, v) => (v === Infinity || v === -Infinity ? null : v));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('invalid JSON body')); } });
  });
}

function sources() {
  const out = {};
  const walk = (dir) => {
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).sort((a, b) => (a.isDirectory() - b.isDirectory()) || a.name.localeCompare(b.name)).forEach((e) => {
      if (SKIP.has(e.name)) return;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (SOURCE_EXT.test(e.name)) out[rel] = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
    });
  };
  SOURCE_DIRS.forEach((d) => fs.existsSync(path.join(ROOT, d)) && walk(d));
  SOURCE_FILES.forEach((f) => { if (fs.existsSync(path.join(ROOT, f))) out[f] = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'); });
  return out;
}

function serveStatic(req, res, pathname) {
  let file;
  if (pathname.startsWith('/engine/')) {
    const name = pathname.slice(8);
    if (!SHARED_ENGINE.has(name)) return json(res, 404, { error: 'not a shared engine file' });
    file = path.join(ROOT, 'engine', name);
  } else {
    file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found', path: pathname });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

module.exports = function createRouter(host) {
  return async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    res.on('finish', () => log.http(req.method, p, res.statusCode, Date.now() - t0));
    try {
      if (!p.startsWith('/api/')) return serveStatic(req, res, p);

      if (p === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        return host.addClient(res);
      }
      if (p === '/api/health') return json(res, 200, { ok: true, uptimeS: Math.round(process.uptime()), simT: host.sim.t, browsers: host.clients.size });
      if (p === '/api/state') return json(res, 200, host.snapshot());
      if (p === '/api/endpoints') return json(res, 200, ENDPOINTS.map(([m, u, d]) => ({ method: m, url: u, description: d })));
      if (p === '/api/sources') return json(res, 200, sources());
      if (p.startsWith('/api/inspect/')) {
        const data = inspect(host.sim, p.split('/').pop());
        return data == null ? json(res, 404, { error: 'unknown node' }) : json(res, 200, data);
      }
      if (p === '/api/experiments') {
        if (url.searchParams.get('cached') && host.results) return json(res, 200, host.results);
        return json(res, 200, host.runExperiments(+url.searchParams.get('seed') || 2026, url.searchParams.get('profile') || 'pharma'));
      }
      if (p === '/api/selftest') return json(res, 200, url.searchParams.get('cached') && host.tests ? host.tests : host.runTests());

      if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
      const body = await readBody(req);
      if (p === '/api/control') { host.control(body); return json(res, 200, { speed: host.speed, playing: host.playing }); }
      if (p === '/api/action') { host.action(body.name, body.args || []); return json(res, 200, { ok: true }); }
      if (p === '/api/reset') { host.reset(body); return json(res, 200, { ok: true, seed: host.seed }); }
      if (p === '/api/twin') return json(res, 200, { desired: host.updateTwin(body.deviceId, body.patch || {}) });
      if (p === '/api/method') return json(res, 200, await host.invokeMethod(body.deviceId, body.name, body.payload));
      return json(res, 404, { error: 'unknown endpoint' });
    } catch (err) {
      log.info(`error on ${p}: ${err.message}`);
      return json(res, 400, { error: err.message });
    }
  };
};
module.exports.ENDPOINTS = ENDPOINTS;
