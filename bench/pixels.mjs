#!/usr/bin/env node
// Deterministic screenshots for pixel A/B of shader / pipeline changes.
//
//   node bench/pixels.mjs --url https://localhost:5291/ --name now [--out tmp/pixels]
//   node bench/pixels.mjs --compare tmp/pixels/base tmp/pixels/now
//
// After ENTER, every clock is frozen (performance.now), the accumulated time uniforms are set to
// fixed values and the parts that can't be made deterministic are hidden (rain particles, smoke,
// planes, video billboards, sky drift). What remains (lit city + car paint with rain drops, wet
// ground + mirror, AO, bloom, lensflare, grade, SMAA, grain) is captured at a few fixed poses.
// Math.random is seeded so per-session random uniforms match. Needs the dev server (__app hooks).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);

const POSES = {
  start: { position: [-138.564, -3.95, 34.181], target: [-120, -3, 30] },
  car: { position: [-133.5, -3.95, 37.5], target: [-128, -4.6, 33] },
  ground: { position: [-136, -3.95, 30], target: [-130, -5.4, 31] },
  street: { position: [-110, -3.95, 32], target: [-80, -2, 28] },
};

//* PNG decode (8-bit RGBA / RGB, non-interlaced: what Chrome writes)
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = cur[x * bpp];
      out[(y * width + x) * 4 + 1] = cur[x * bpp + 1];
      out[(y * width + x) * 4 + 2] = cur[x * bpp + 2];
      out[(y * width + x) * 4 + 3] = 255;
    }
    cur.copy(prev);
  }
  return { width, height, data: out };
}

function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), body])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

//* Compare mode
if (argv.includes('--compare')) {
  const [dirA, dirB] = argv.filter((a) => !a.startsWith('--'));
  for (const file of fs.readdirSync(dirA).filter((f) => f.endsWith('.png') && !f.includes('diff'))) {
    if (!fs.existsSync(path.join(dirB, file))) continue;
    const a = decodePng(fs.readFileSync(path.join(dirA, file)));
    const b = decodePng(fs.readFileSync(path.join(dirB, file)));
    const diff = Buffer.alloc(a.data.length);
    let sum = 0;
    let over8 = 0;
    let over32 = 0;
    let max = 0;
    const n = a.width * a.height;
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]));
      sum += d;
      max = Math.max(max, d);
      if (d > 8) over8++;
      if (d > 32) over32++;
      const v = Math.min(255, d * 8);
      diff[i * 4] = v;
      diff[i * 4 + 1] = v;
      diff[i * 4 + 2] = v;
      diff[i * 4 + 3] = 255;
    }
    fs.writeFileSync(path.join(dirB, file.replace('.png', '.diff.png')), encodePng({ width: a.width, height: a.height, data: diff }));
    console.log(
      `${file.padEnd(12)} mean ${(sum / n).toFixed(3)}  max ${String(max).padStart(3)}  >8: ${((100 * over8) / n).toFixed(3)}%  >32: ${((100 * over32) / n).toFixed(3)}%`,
    );
  }
  process.exit(0);
}

//* Capture mode
const URL = arg('--url', 'https://localhost:5291/');
const NAME = arg('--name', 'run');
const OUT = path.resolve(arg('--out', 'tmp/pixels'), NAME);
fs.mkdirSync(OUT, { recursive: true });

const context = await chromium.launchPersistentContext(path.resolve('tmp/shader-bench/profile-pixels'), {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: true,
  ignoreDefaultArgs: ['--enable-automation'],
});
const page = context.pages()[0] || (await context.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e?.message || e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

// --seed n: another random stream (shows what a shifted stream alone changes)
await page.addInitScript((initialSeed) => {
  // mulberry32: same random stream every load
  let seed = initialSeed;
  Math.random = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}, Number(arg('--seed', 1234567)));

// --storage key=value[,key=value]: localStorage switches set before the app boots
const storage = Object.fromEntries(
  String(arg('--storage', ''))
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
}, storage);

if (argv.includes('--weather'))
  await page.addInitScript(() => {
    window.__benchWeather = true;
  });
await page.goto(URL);
await page.waitForFunction(() => document.querySelector('.intro-button') && !document.querySelector('.intro-button').disabled, null, { timeout: 240000 });
// Adaptive DPR reacts to FPS (forced-low drops lensflare + DPR): keep it out of pixel A/B
await page.evaluate(() => window.__app.perf?.set?.('adaptiveDpr', false));
// --perf k=v[,k=v]: perf toggles for both arms (e.g. ao=false to take AO out of a comparison)
for (const kv of String(arg('--perf', '')).split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  await page.evaluate(([key, value]) => window.__app.perf?.set?.(key, value === 'true' ? true : value === 'false' ? false : Number(value)), [k, v]);
}
await page.click('.intro-button');
await page.waitForFunction(() => document.querySelector('canvas')?.style.pointerEvents === 'auto', null, { timeout: 60000 });
// Let ENTER's tweens (glass fade, notice, post restores) finish before the clocks freeze
await page.waitForTimeout(Number(arg('--settle-ms', 3000)));

// The HUD is a CSS animation keyed to page time: keep DOM overlays out of the canvas screenshots
await page.addStyleTag({ content: '* { visibility: hidden !important } canvas { visibility: visible !important }' });

await page.evaluate(() => {
  const { world, renderer } = window.__app;
  const frozen = performance.now();
  performance.now = () => frozen;
  window.__freeze = () => {
    renderer._nodes.nodeFrame.time = 12.5;
    if (world.ground?.uniforms?.time) world.ground.uniforms.time.value = 12.5;
    if (world.carSurfaceRain?.uniforms?.uTime) world.carSurfaceRain.uniforms.uTime.value = 12.5;
  };
  // --weather keeps rain + smoke (for AO / blending checks between arms of the same build):
  // drops respawn from their seeded hash at each pose, then stay frozen
  const weather = window.__benchWeather === true;
  if (world.rain?.group) {
    const update = world.rain.update;
    world.rain.update = () => {};
    window.__resetRain = (camera) => {
      if (!weather || !world.rain.resetParticles) return;
      world.rain.resetParticles(camera);
      update(0, camera);
    };
    world.rain.group.visible = weather;
  }
  if (!weather) for (const e of world.smoke?.emitters ?? []) e.mesh.visible = false;
  // planes.update() re-shows anchors along their path every frame
  if (world.planes?.group) {
    world.planes.group.visible = false;
    world.planes.update = () => {};
  }
  world.billboards?.userData?.billboardMaterials?.billboard?.disable?.();
  // Shadow maps update on demand: re-render with the same visible set in every arm
  window.__app.scene.traverse((o) => {
    if (o.isLight && o.castShadow) o.shadow.needsUpdate = true;
  });
  if (world.sky?.mesh) world.sky.mesh.visible = false;
  if (world.sky?.group) world.sky.group.visible = false;
});

const state = await page.evaluate(() => ({
  pixelRatio: window.__app.renderer.getPixelRatio(),
  canvas: [window.__app.renderer.domElement.width, window.__app.renderer.domElement.height],
}));
console.log(`[pixels ${NAME}] state ${JSON.stringify(state)}`);
fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify(state));

for (const [name, pose] of Object.entries(POSES)) {
  await page.evaluate((p) => {
    const { camera, walkControls } = window.__app;
    camera.position.set(...p.position);
    camera.lookAt(...p.target);
    camera.updateMatrixWorld(true);
    walkControls?.syncEulerFromCamera();
    window.__resetRain?.(camera);
  }, pose);
  // Several frames: shadow map, reflection frame skip and SMAA history settle
  for (let i = 0; i < 20; i++) {
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__freeze();
          requestAnimationFrame(() => resolve());
        }),
    );
  }
  await page.locator('canvas').screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`[pixels ${NAME}] ${name}`);
}

// What was actually drawn at capture time (the app may re-show things the harness hid)
const shown = await page.evaluate(() => {
  const { world, scene, pipeline } = window.__app;
  const visibleChain = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  const onlyScene = [];
  scene.traverse((o) => {
    if ((o.isMesh || o.isSprite || o.isPoints) && pipeline && o.layers.test(pipeline.sceneCamera.layers) && !o.layers.test(pipeline.aoCamera.layers) && visibleChain(o)) onlyScene.push(o.name || o.type);
  });
  return { rain: !!world.rain?.group?.visible, smoke: (world.smoke?.emitters ?? []).filter((e) => visibleChain(e.mesh)).length, sky: world.sky?.mesh?.visible ?? null, onlyScene };
});
console.log(`[pixels ${NAME}] shown ${JSON.stringify(shown)}`);
fs.writeFileSync(path.join(OUT, 'errors.json'), JSON.stringify(errors, null, 1));
if (errors.length) console.log(`[pixels ${NAME}] ${errors.length} page errors (errors.json)`);
await context.close();
