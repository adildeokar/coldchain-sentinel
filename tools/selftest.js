#!/usr/bin/env node
/* Runs the simulator's test suite and the experiments headless:
 *     node tools/selftest.js
 * Exit code 1 if any test fails. */
const CS = require('../engine');
const { fmt } = CS.util;

const results = CS.selftest.run();
results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(3)} ${r.name}\n        ${r.detail}`));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed\n`);

const all = CS.experiments.runAll();
console.log('Experiment  edge delivered  baseline delivered  local alarm  edge→SMS     baseline→SMS  sync');
all.runs.forEach(({ id, row: w }) => console.log(
  `${id.padEnd(11)} ${fmt.pct(w.edgeDelivery).padEnd(15)} ${fmt.pct(w.baseDelivery).padEnd(19)} ${fmt.dur(w.edgeLocal).padEnd(12)} ${fmt.dur(w.edgeCloud).padEnd(12)} ${(w.baseCloud ? fmt.dur(w.baseCloud) : '—').padEnd(8)} ${String(w.baseMissed ? `(${w.baseMissed} missed)` : '').padEnd(12)} ${fmt.dur(w.syncMs)}`));
process.exit(failed ? 1 : 0);
