#!/usr/bin/env node
// Medians per stage across the runs of one or more bench/stages.mjs series.
//
//   node bench/summarize.mjs tmp/shader-bench/base-cold tmp/shader-bench/base-warm [...]
//   node bench/summarize.mjs ... --json

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const dirs = argv.filter((a) => !a.startsWith('--'));
const AS_JSON = argv.includes('--json');

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};

const report = {};
for (const dir of dirs) {
  const runs = fs
    .readdirSync(dir)
    .map((d) => path.join(dir, d, 'summary.json'))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
    .filter((s) => !s.timedOut);
  if (!runs.length) continue;
  const stageNames = [...new Set(runs.flatMap((r) => r.stages.map((s) => s.name)))];
  const rows = stageNames.map((name) => {
    const per = runs.map((r) => r.stages.find((s) => s.name === name)).filter(Boolean);
    const dx = runs.map((r) => r.dxc?.[name]).filter(Boolean);
    return {
      stage: name,
      s: +(median(per.map((s) => s.ms)) / 1000).toFixed(2),
      modules: median(per.map((s) => s.modules)),
      KB: median(per.map((s) => s.wgslKB)),
      sync: median(per.map((s) => s.sync)),
      async: median(per.map((s) => s.async)),
      maxFrame: median(per.map((s) => s.maxFrameMs)),
      '>100ms': median(per.map((s) => s.framesOver100)),
      stallMs: median(per.map((s) => s.stallMs)),
      dxc: dx.length ? median(dx.map((d) => d.compiles)) : '-',
      dxcMs: dx.length ? median(dx.map((d) => d.ms)) : '-',
    };
  });
  const ms = (label) => median(runs.map((r) => r.milestones[label]));
  report[path.basename(dir)] = {
    runs: runs.length,
    source: runs[0].source,
    milestones: {
      assembling: ms('status:ASSEMBLING SECTOR'),
      canvasVisible: ms('canvas-visible'),
      enterReady: ms('enter-ready'),
      enterToReveal: median(runs.map((r) => r.milestones['app-revealed'] - r.milestones['stage:enter'])),
    },
    totals: {
      modules: median(runs.map((r) => r.totals.modules)),
      wgslKB: median(runs.map((r) => r.totals.wgslKB)),
      largestKB: median(runs.map((r) => r.totals.largestKB)),
      pipelines: median(runs.map((r) => r.totals.pipelines)),
      sync: median(runs.map((r) => r.totals.sync)),
      dxc: median(runs.map((r) => r.dxc?.total?.compiles)),
      dxcMs: median(runs.map((r) => r.dxc?.total?.ms)),
    },
    rows,
  };
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const [name, r] of Object.entries(report)) {
    console.log(`\n== ${name}  (${r.runs} runs, ${r.source.rev}${r.source.dirtyDigest ? '+' + r.source.dirtyDigest : ''}, three ${r.source.three})`);
    console.log('milestones (ms, median):', JSON.stringify(r.milestones));
    console.log('totals (median):', JSON.stringify(r.totals));
    console.table(r.rows);
  }
}
