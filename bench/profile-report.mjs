#!/usr/bin/env node
// Where did the main thread go during the load stage? Reads load.cpuprofile from a
// `bench/stages.mjs --cpuprofile` run and prints self time per function and inclusive time for the
// three.js entry points that decide compile cost (node builds, pipeline creation, renders).
//
//   node bench/profile-report.mjs <runDir | tmp/shader-bench/<name>> [--top 30]

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--'));
const TOP = Number(argv.includes('--top') ? argv[argv.indexOf('--top') + 1] : 30);

function resolveRun(dir) {
  if (fs.existsSync(path.join(dir, 'load.cpuprofile'))) return dir;
  const runs = fs
    .readdirSync(dir)
    .map((d) => path.join(dir, d))
    .filter((d) => fs.existsSync(path.join(d, 'load.cpuprofile')))
    .sort();
  if (!runs.length) throw new Error(`no load.cpuprofile under ${dir}`);
  return runs.pop();
}

const run = resolveRun(path.resolve(target));
const profile = JSON.parse(fs.readFileSync(path.join(run, 'load.cpuprofile'), 'utf8'));
console.log(run);

const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

// Sample durations: timeDeltas[i] is the gap before sample i
const selfUs = new Map();
const deltas = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) {
  const d = deltas[i + 1] ?? 0;
  selfUs.set(profile.samples[i], (selfUs.get(profile.samples[i]) ?? 0) + d);
}

const label = (n) => {
  const f = n.callFrame;
  const file = f.url ? f.url.split('/').pop().split('?')[0] : '';
  return `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`;
};

//* Self time by function
const self = new Map();
let total = 0;
for (const [id, us] of selfUs) {
  const k = label(nodes.get(id));
  self.set(k, (self.get(k) ?? 0) + us);
  total += us;
}
const ms = (us) => (us / 1000).toFixed(0).padStart(7);
console.log(`\nprofiled ${ms(total)} ms`);
console.log('\nSelf time');
for (const [k, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`${ms(us)} ms  ${k}`);

//* Inclusive time for named entry points (counted once per sample even when recursive)
const ENTRY = [
  'buildAsync',
  'build',
  'getForRenderAsync',
  'createRenderPipeline',
  'createRenderPipelineAsync',
  'compileAsync',
  'render',
  '_renderObjectDirect',
  'updateShadow',
  'compute',
  'fromEquirectangular',
  'parse',
  'decodeAsync',
];
const incl = new Map();
for (const [id, us] of selfUs) {
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const name = nodes.get(cur).callFrame.functionName;
    if (ENTRY.includes(name) && !seen.has(name)) {
      seen.add(name);
      incl.set(name, (incl.get(name) ?? 0) + us);
    }
  }
}
console.log('\nInclusive time (entry points)');
for (const [k, us] of [...incl].sort((a, b) => b[1] - a[1])) console.log(`${ms(us)} ms  ${k}`);
