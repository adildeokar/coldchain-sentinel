#!/usr/bin/env node
/* ColdChain Sentinel — application server.
 *
 *     npm start                       (or: node server/index.js)
 *     node server/index.js --port 3000 --speed 5 --seed 42 --profile pharma --no-open --quiet
 *
 * The server runs the whole system: the cold-room physics, the sensors, the
 * Raspberry Pi edge logic, the network, Azure IoT Hub and its services, and the
 * metrics. The browser only displays the state and sends user actions back. */
const http = require('http');
const { exec } = require('child_process');
const { SimulationHost } = require('./host');
const createRouter = require('./api');
const log = require('./log');

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);

const PORT = +arg('port', process.env.PORT || 3000);
const host = new SimulationHost({ seed: +arg('seed', 0) || null, profile: arg('profile', 'pharma'), speed: +arg('speed', 5), quiet: flag('quiet') });
host.start();

const server = http.createServer(createRouter(host));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is busy — is the app already running? Try: npm start -- --port ${PORT + 1}\n`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  const { C } = log;
  console.log(`
${C.cyan}${C.bold}  ❄  ColdChain Sentinel — Azure IoT cold-storage monitoring${C.reset}
     Raspberry Pi edge · store-and-forward · Azure IoT Hub (simulated services)

     App        ${C.bold}${url}${C.reset}
     API        ${url}/api/endpoints
     Engine     seed ${host.seed} · ${host.profile} profile · ${host.speed}× real time
     Stop       Ctrl+C
`);
  if (!flag('no-open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
    exec(cmd, () => {});
  }
});

process.on('SIGINT', () => { console.log('\nshutting down'); process.exit(0); });
