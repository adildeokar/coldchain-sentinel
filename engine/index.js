/* Loads the simulation engine in Node. Every engine file attaches itself to the
 * shared CS namespace, so load order matters (dependencies first). The browser
 * loads util.js, config.js and rules.js too — those three are shared with the UI. */
const ORDER = [
  'util', 'config', 'physics', 'sensors', 'rules', 'network', 'mqtt',
  'edge', 'baseline', 'azure', 'metrics', 'simulation', 'experiments', 'selftest',
];

global.CS = global.CS || {};
ORDER.forEach((name) => require(`./${name}.js`));

module.exports = global.CS;
module.exports.FILES = ORDER.map((n) => `engine/${n}.js`);
