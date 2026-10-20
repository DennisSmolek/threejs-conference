#!/usr/bin/env node
// Stage-by-stage shader compile benchmark for Threejs-Punk (Windows / Chrome / D3D12).
//
// Drives the real app through its user-visible stages and attributes every shader module, pipeline,
// frame gap and (with --trace) every real DXC/FXC compile to the stage it happened in:
//
//   load   navigation → ENTER button enabled (loader, critical compileAsync, canvas reveal)
//   intro  ENTER enabled → quiet (deferred compile of rain / smoke / planes behind the glass)
//   enter  click ENTER → app UI revealed → quiet (glass fade, post graph restore)
//   walk   sprint forward, 360° look, walk back (frustum / reflection / collision-pass changes)
//   car    leave the car's wet-paint radius, then come back (car surface rain fade in / out)
//
//   node bench/stages.mjs [--name base] [--warm] [--trace] [--keep-code] [--stacks] [--storage k=v,...]
//       [--url https://localhost:5291/] [--settle-ms 4000] [--headless] [--hold]
//
// Cold (default) clears only the profile's shader caches; --warm keeps them. Output goes to
// tmp/shader-bench/<name>/<timestamp>/ in the same layout as the webgpu-tsl-compile skill's
// cold-warm.mjs (probe-events.json, wgsl/, trace.json), so wgsl-report / trace-dxc / sync-stacks /
// wgsl-diff work on it directly. bench/summarize.mjs tabulates several runs.
//
// Needs the dev server (`npx vite --port 5291 --strictPort`): the walk and car stages use the
// dev-only window.__app hooks.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// WebGPU API probe: the vendored copy in bench/, or a newer one from WEBGPU_TSL_SKILL_SCRIPTS
const PROBE_DIR = process.env.WEBGPU_TSL_SKILL_SCRIPTS || path.join(ROOT, 'bench');

//* Arguments
const VALUE_OPTS = new Set(['url', 'name', 'out', 'profile', 'settle-ms', 'timeout-ms', 'chrome-args', 'stages', 'storage']);
const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  opts[key] = VALUE_OPTS.has(key) ? argv[++i] : true;
}
const URL = opts.url || 'https://localhost:5291/';
const NAME = opts.name || 'run';
const OUT_ROOT = path.resolve(ROOT, opts.out || 'tmp/shader-bench');
const WARM = !!opts.warm;
const SETTLE_MS = Number(opts['settle-ms'] ?? 4000);
const TIMEOUT_MS = Number(opts['timeout-ms'] ?? 240000);
const STAGES = String(opts.stages || 'load,intro,enter,walk,car,idle').split(',');
const CHROME_ARGS = String(opts['chrome-args'] || '').split(/\s+/).filter(Boolean);

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(OUT_ROOT, NAME, runId);
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(`[stages ${NAME}]`, ...a);

//* Profile: cold = shader caches only (HTTP cache stays, so we time compiles, not downloads)
const userDataDir = path.resolve(opts.profile || path.join(OUT_ROOT, 'profile-stages'));
fs.mkdirSync(userDataDir, { recursive: true });
const SHADER_CACHE_DIRS = [
  'GPUPersistentCache',
  'GrShaderCache',
  'ShaderCache',
  'GraphiteDawnCache',
  'Default/DawnWebGPUCache',
  'Default/DawnGraphiteCache',
  'Default/GPUCache',
];
if (!WARM) {
  for (const dir of SHADER_CACHE_DIRS) fs.rmSync(path.join(userDataDir, dir), { recursive: true, force: true });
}
log(`${WARM ? 'warm' : 'cold'} run → ${OUT}`);

//* Source identity: which code was measured
const sh = (cmd) => {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const source = {
  rev: sh('git rev-parse --short HEAD'),
  branch: sh('git rev-parse --abbrev-ref HEAD'),
  dirtyDigest: crypto.createHash('sha1').update(sh('git diff HEAD') || '').digest('hex').slice(0, 10),
  three: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/three/package.json'), 'utf8')).version,
};

//* Launch
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: !!opts.headless,
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true,
  // A covered or unfocused window gets its frames throttled on Windows: keep runs comparable
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    ...CHROME_ARGS,
  ],
  ignoreDefaultArgs: ['--enable-automation'],
});
const page = context.pages()[0] || (await context.newPage());

const consoleLines = [];
page.on('console', (m) => consoleLines.push({ w: Date.now(), type: m.type(), text: m.text() }));
page.on('pageerror', (e) => consoleLines.push({ w: Date.now(), type: 'pageerror', text: String(e?.message || e) }));
page.on('crash', () => consoleLines.push({ w: Date.now(), type: 'crash', text: 'PAGE CRASHED' }));
const cdp = await context.newCDPSession(page);
cdp.on('Log.entryAdded', ({ entry }) =>
  consoleLines.push({ w: Date.now(), type: `log:${entry.level}`, source: entry.source, text: entry.text }),
);
await cdp.send('Log.enable').catch(() => {});

if (opts.stacks)
  await page.addInitScript(() => {
    window.__gpuProbeStacks = true;
  });
await page.addInitScript({ path: path.join(PROBE_DIR, 'gpuprobe.js') });

// --storage key=value[,key=value]: localStorage switches set before the app boots (every navigation)
const STORAGE = Object.fromEntries(
  String(opts.storage || '')
    .split(',')
    .filter(Boolean)
    .map((kv) => kv.split('=')),
);
await page.addInitScript((entries) => {
  // The profile persists localStorage: clear switches left by earlier runs, then set this run's
  if (!sessionStorage.getItem("__benchStorageApplied")) {
    localStorage.clear();
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    sessionStorage.setItem("__benchStorageApplied", "1");
  }
}, STORAGE);

// Milestones from the DOM (no app changes needed) + every frame delta, both on the page clock.
// Marks also go to performance.mark so a trace can be cut at the same instants.
await page.addInitScript(() => {
  const B = (window.__bench = { marks: [], frames: [] });
  const mark = (label) => {
    if (B.marks.some((m) => m.label === label)) return;
    const t = performance.now();
    B.marks.push({ label, t });
    window.__gpuProbe?.events.push({ type: 'mark', label, t });
    performance.mark(`bench:${label}`);
  };
  B.mark = mark;
  const STATUSES = /^[A-Z][A-Z ]{3,}$/;
  const scan = () => {
    const status = document.querySelector('.app-loader__status')?.textContent?.trim();
    if (status && STATUSES.test(status)) mark(`status:${status}`);
    const canvas = document.querySelector('canvas');
    if (canvas && canvas.style.opacity === '1') mark('canvas-visible');
    const enter = document.querySelector('.intro-button');
    if (enter && !enter.disabled) mark('enter-ready');
  };
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  let last = performance.now();
  const tick = (now) => {
    B.frames.push(now - last, now);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

//* Optional trace: Dawn compile events + user timing marks on one clock
const traceChunks = [];
let traceSession = null;
if (opts.trace) {
  traceSession = (await context.browser()?.newBrowserCDPSession?.()) || cdp;
  traceSession.on('Tracing.dataCollected', (e) => traceChunks.push(...e.value));
  await traceSession.send('Tracing.start', {
    traceConfig: {
      // Dawn only: 'gpu' / 'toplevel' add per-frame events and push a 2-minute trace past 512 MB
      includedCategories: [
        'gpu.dawn',
        'dawn',
        'disabled-by-default-gpu.dawn',
        'disabled-by-default-dawn',
        'blink.user_timing',
      ],
      recordMode: 'recordContinuously',
    },
    transferMode: 'ReportEvents',
  });
}

//* Helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => page.evaluate(() => performance.now());
const markStage = (label) => page.evaluate((l) => window.__bench.mark(l), label);
const frames = (n) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
        step(count);
      }),
    n,
  );

/** Waits until nothing has been created and nothing is pending for SETTLE_MS. */
async function settle(deadline = Date.now() + TIMEOUT_MS) {
  let lastCount = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const s = await page
      .evaluate(() => {
        const P = window.__gpuProbe;
        const n = P ? P.events.filter((e) => e.type === 'module' || e.type === 'render' || e.type === 'compute').length : 0;
        return { n, pending: P ? P.pending : 0 };
      })
      .catch(() => null);
    if (s) {
      if (s.n !== lastCount || s.pending > 0) {
        lastCount = s.n;
        quietSince = Date.now();
      }
      if (s.pending === 0 && Date.now() - quietSince >= SETTLE_MS) return true;
    }
    await sleep(200);
  }
  return false;
}

async function waitFor(fn, arg, deadline = Date.now() + TIMEOUT_MS) {
  while (Date.now() < deadline) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

async function hold(keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(ms);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
}

//* Stages
const stageWindows = [];
let timedOut = false;
// --cpuprofile: sampled main-thread profile of the load stage (node builds vs pipeline creation)
if (opts.cpuprofile) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
}
const navWall = Date.now();
await page.goto(URL, { waitUntil: 'load', timeout: TIMEOUT_MS }).catch((e) => {
  log('navigation failed', e.message);
  timedOut = true;
});

const runStage = async (name, body) => {
  if (!STAGES.includes(name) || timedOut) return;
  const t0 = name === 'load' ? 0 : await now();
  if (name !== 'load') await markStage(`stage:${name}`);
  const ok = await body();
  const t1 = await now();
  stageWindows.push({ name, t0, t1, ok });
  log(`${name.padEnd(5)} ${ok ? 'done' : 'TIMED OUT'} in ${((t1 - t0) / 1000).toFixed(2)} s`);
  if (!ok) timedOut = true;
};

await runStage('load', () => waitFor(() => window.__bench?.marks.some((m) => m.label === 'enter-ready')));

if (opts.cpuprofile) {
  const { profile } = await cdp.send('Profiler.stop');
  fs.writeFileSync(path.join(OUT, 'load.cpuprofile'), JSON.stringify(profile));
}

await runStage('intro', () => settle());

await runStage('enter', async () => {
  await page.click('.intro-button');
  const revealed = await waitFor(() => document.querySelector('canvas')?.style.pointerEvents === 'auto');
  if (!revealed) return false;
  await markStage('app-revealed');
  return settle();
});

await runStage('walk', async () => {
  const hasHooks = await page.evaluate(() => !!window.__app?.walkControls);
  if (!hasHooks) {
    log('walk: window.__app.walkControls missing (not a dev build?)');
    return false;
  }
  await page.mouse.move(800, 500);
  await hold(['Shift', 'KeyW'], 2500);
  // One full turn, then look down at the wet ground and back up
  for (let i = 0; i < 90; i++) {
    await page.evaluate(() => window.__app.walkControls.applyLookDelta(25, 0));
    await frames(1);
  }
  for (let i = 0; i < 20; i++) {
    await page.evaluate((dy) => window.__app.walkControls.applyLookDelta(0, dy), i < 10 ? 25 : -25);
    await frames(1);
  }
  await hold(['KeyS'], 2000);
  await hold(['KeyA'], 1200);
  return settle();
});

await runStage('car', async () => {
  // Out of the wet-paint radius (fade ends at 32 units), then right next to the car
  const far = await page.evaluate(() => {
    const { camera, quadraCar } = window.__app;
    camera.position.set(quadraCar.position.x - 60, camera.position.y, quadraCar.position.z);
    return camera.position.distanceTo(quadraCar.position);
  });
  await frames(60);
  const near = await page.evaluate(() => {
    const { camera, quadraCar } = window.__app;
    camera.position.set(quadraCar.position.x - 4, camera.position.y, quadraCar.position.z + 3);
    camera.lookAt(quadraCar.position);
    window.__app.walkControls.syncEulerFromCamera();
    return camera.position.distanceTo(quadraCar.position);
  });
  log(`car: far ${far.toFixed(1)} → near ${near.toFixed(1)} units`);
  await frames(120);
  return settle();
});

await runStage('idle', async () => {
  // Late arrivals: planes flying in, video billboards, timers
  await sleep(20000);
  return settle();
});

//* Collect
const probe = await page
  .evaluate(() => {
    const P = window.__gpuProbe;
    if (!P) return null;
    const { code, ...rest } = P;
    return rest;
  })
  .catch(() => null);
const bench = await page.evaluate(() => ({ marks: window.__bench.marks, frames: window.__bench.frames })).catch(() => null);
const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
// Dev builds record every TSL node build (src/debug/nodeBuildProbe.js)
const nodeBuilds = await page.evaluate(() => window.__nodeBuilds ?? null).catch(() => null);
if (nodeBuilds) fs.writeFileSync(path.join(OUT, 'node-builds.json'), JSON.stringify(nodeBuilds));

const events = probe?.events ?? [];
const modules = events.filter((e) => e.type === 'module');
let savedCode = 0;
{
  const codeDir = path.join(OUT, 'wgsl');
  fs.mkdirSync(codeDir, { recursive: true });
  const ids = opts['keep-code']
    ? modules.map((m) => m.id)
    : [...modules].sort((a, b) => b.len - a.len).slice(0, 12).map((m) => m.id);
  for (const id of ids) {
    const code = await page.evaluate((i) => window.__gpuProbe.code[i], id).catch(() => null);
    if (code) {
      fs.writeFileSync(path.join(codeDir, `m${id}.wgsl`), code);
      savedCode++;
    }
  }
}

let traceEvents = null;
if (traceSession) {
  const done = new Promise((r) => traceSession.once('Tracing.tracingComplete', r));
  await traceSession.send('Tracing.end');
  await done;
  traceEvents = traceChunks;
  const fd = fs.openSync(path.join(OUT, 'trace.json'), 'w');
  fs.writeSync(fd, '{"traceEvents":[');
  traceChunks.forEach((e, i) => fs.writeSync(fd, (i ? ',' : '') + JSON.stringify(e)));
  fs.writeSync(fd, ']}');
  fs.closeSync(fd);
}

//* Real compiles per stage from the trace (CompileShaderDXC/FXC), cut at the bench:stage marks
function traceCompilesByStage(ev) {
  if (!ev) return null;
  const pname = {};
  for (const e of ev) if (e.ph === 'M' && e.name === 'process_name') pname[e.pid] = e.args.name;
  const gpuPids = new Set(Object.entries(pname).filter(([, n]) => /GPU/i.test(n)).map(([p]) => Number(p)));
  const spans = [];
  const open = new Map();
  for (const e of [...ev].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
    if (!gpuPids.has(e.pid)) continue;
    const key = `${e.pid}:${e.tid}`;
    if (e.ph === 'X') spans.push({ name: e.name, ts: e.ts, dur: e.dur || 0, key, label: e.args?.label });
    else if (e.ph === 'B') {
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(e);
    } else if (e.ph === 'E') {
      const s = open.get(key)?.pop();
      if (s) spans.push({ name: s.name, ts: s.ts, dur: e.ts - s.ts, key, label: s.args?.label });
    }
  }
  const compiles = spans.filter((s) => s.name === 'CompileShaderDXC' || s.name === 'CompileShaderFXC');
  // Name each compile by the labelled pipeline span that encloses it on the same thread
  const labelled = spans.filter((s) => s.label);
  for (const c of compiles) {
    const owner = labelled.find((p) => p.key === c.key && p.ts <= c.ts && p.ts + p.dur >= c.ts + c.dur);
    c.owner = owner ? String(owner.label).replace(/_\d+$/, '') : '?';
  }
  // User timing marks carry the page's performance.now() in their name order; map by label
  const userMarks = ev.filter((e) => e.cat?.includes('blink.user_timing') && String(e.name).startsWith('bench:'));
  const markTs = Object.fromEntries(userMarks.map((e) => [e.name.slice(6), e.ts]));
  const cuts = stageWindows.map((w) => ({ name: w.name, ts: w.name === 'load' ? -Infinity : markTs[`stage:${w.name}`] }));
  const out = {};
  for (const [i, c] of cuts.entries()) {
    const end = cuts[i + 1]?.ts ?? Infinity;
    if (c.ts === undefined) continue;
    const inStage = compiles.filter((s) => s.ts >= c.ts && s.ts < end);
    const labels = {};
    for (const x of inStage) labels[x.owner] = (labels[x.owner] ?? 0) + 1;
    out[c.name] = { compiles: inStage.length, ms: Math.round(inStage.reduce((s, x) => s + x.dur, 0) / 1000), labels };
  }
  out.total = { compiles: compiles.length, ms: Math.round(compiles.reduce((s, x) => s + x.dur, 0) / 1000) };
  out.kinds = [...new Set(compiles.map((c) => c.name))];
  return out;
}

//* Per-stage summary
const round = (n) => Math.round(n);
const frameArr = bench?.frames ?? [];
const stages = stageWindows.map((w) => {
  const inW = (e) => e.t >= w.t0 && e.t < w.t1;
  const mods = modules.filter(inW);
  const pipes = events.filter((e) => (e.type === 'render' || e.type === 'compute') && inW(e));
  const asyncP = pipes.filter((p) => !p.sync);
  const nb = (nodeBuilds ?? []).filter(inW);
  const deltas = [];
  for (let i = 0; i < frameArr.length; i += 2) if (frameArr[i + 1] >= w.t0 && frameArr[i + 1] < w.t1) deltas.push(frameArr[i]);
  return {
    name: w.name,
    ok: w.ok,
    ms: round(w.t1 - w.t0),
    modules: mods.length,
    wgslKB: round(mods.reduce((s, m) => s + m.len, 0) / 1024),
    pipelines: pipes.length,
    sync: pipes.filter((p) => p.sync).length,
    async: asyncP.length,
    compute: pipes.filter((p) => p.type === 'compute').length,
    maxInflight: asyncP.reduce((m, p) => Math.max(m, (p.inflight ?? 0) + 1), 0),
    frames: deltas.length,
    maxFrameMs: round(deltas.reduce((m, d) => Math.max(m, d), 0)),
    framesOver50: deltas.filter((d) => d > 50).length,
    framesOver100: deltas.filter((d) => d > 100).length,
    stallMs: round(deltas.filter((d) => d > 50).reduce((s, d) => s + d, 0)),
    syncBuilds: nb.filter((b) => b.sync).length,
    syncBuildMs: round(nb.filter((b) => b.sync).reduce((t, b) => t + b.ms, 0)),
    asyncBuilds: nb.filter((b) => !b.sync).length,
    syncLabels: pipes.filter((p) => p.sync).map((p) => p.label.replace(/_\d+$/, '')),
  };
});

const summary = {
  url: URL,
  finalUrl: page.url(),
  name: NAME,
  runId,
  mode: WARM ? 'warm' : 'cold',
  storage: STORAGE,
  source,
  userAgent,
  adapters: probe?.adapters ?? [],
  timedOut,
  wallMs: Date.now() - navWall,
  milestones: Object.fromEntries((bench?.marks ?? []).map((m) => [m.label, round(m.t)])),
  totals: {
    modules: modules.length,
    wgslKB: round(modules.reduce((s, m) => s + m.len, 0) / 1024),
    largestKB: +((modules.reduce((m, x) => Math.max(m, x.len), 0) / 1024).toFixed(1)),
    pipelines: events.filter((e) => e.type === 'render' || e.type === 'compute').length,
    sync: events.filter((e) => (e.type === 'render' || e.type === 'compute') && e.sync).length,
    savedCode,
  },
  stages,
  dxc: traceCompilesByStage(traceEvents),
  gpuErrors: events.filter((e) => e.type === 'gpuerror').map((e) => e.msg).slice(0, 10),
  deviceLost: events.filter((e) => e.type === 'lost'),
  consoleErrors: consoleLines.filter((l) => /error|crash|log:error/.test(l.type)).map((l) => l.text.slice(0, 300)).slice(0, 20),
};

fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT, 'probe-events.json'), JSON.stringify(events));
fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(bench));
fs.writeFileSync(path.join(OUT, 'console.json'), JSON.stringify(consoleLines, null, 1));

console.table(
  stages.map((s) => ({
    stage: s.name,
    s: +(s.ms / 1000).toFixed(2),
    modules: s.modules,
    KB: s.wgslKB,
    sync: s.sync,
    async: s.async,
    inflight: s.maxInflight,
    maxFrame: s.maxFrameMs,
    '>100ms': s.framesOver100,
    stallMs: s.stallMs,
    dxc: summary.dxc?.[s.name]?.compiles ?? '-',
    dxcMs: summary.dxc?.[s.name]?.ms ?? '-',
    builds: `${s.syncBuilds}s/${s.asyncBuilds}a`,
    buildMs: s.syncBuildMs,
  })),
);
log('milestones', JSON.stringify(summary.milestones));
if (summary.gpuErrors.length || summary.deviceLost.length) log('GPU errors', summary.gpuErrors.length, 'lost', summary.deviceLost.length);
if (!modules.length) log('WARNING: no shader modules created — not a measurement');

if (opts.hold) {
  log('browser left open; close it to exit');
  await new Promise((r) => context.on('close', r));
} else {
  await context.close();
}
