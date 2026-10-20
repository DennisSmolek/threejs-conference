# Startup and shader-compile benchmarks

Tools used to measure and verify the compile-performance work. They drive system Chrome through
Playwright (`npm i` installs `playwright-core`) and are meant for Windows, where WebGPU shaders go
through DXC and compile cost is highest. Results land in `tmp/` (git-ignored).

Run the dev server on a dedicated port first (`npx vite --port 5291 --strictPort`), or a production
build with `npx vite preview` for timing numbers. The `walk` and `car` stages and `pixels.mjs` need
the dev server's `window.__app` hooks.

| Script | Does |
| ------ | ---- |
| `stages.mjs` | One run through load → intro → ENTER → walk → car. Per stage: shader modules, WGSL size, sync/async pipelines, frame gaps, and with `--trace` the real DXC compiles. `--warm` keeps the shader cache (default clears it), `--storage k=v` sets localStorage switches. |
| `ab.sh` | Interleaved comparison of several builds: `bench/ab.sh -r 3 -s load,intro,enter base=https://localhost:5292/ new=https://localhost:5291/`. `-n` skips the trace (tracing slows rendering; quote absolute times from untraced runs). |
| `summarize.mjs` | Medians per stage across runs (`ab.sh` calls it). |
| `pixels.mjs` | Deterministic screenshots at four poses (clocks frozen, random seeded, rain/smoke/planes hidden) and `--compare dirA dirB` for per-pose difference stats and diff images. Measure two runs of the same build first to know the noise floor. |
| `profile-report.mjs` | Where main-thread time went during load, from a `stages.mjs --cpuprofile` run. |
| `series.sh` | Alternating cold/warm runs of one build. |
| `gpuprobe.js` | Init script that records every WebGPU shader module and pipeline creation (from the webgpu-tsl-compile skill). |

Close other GPU-heavy work while benchmarking, and compare arms within one interleaved series: a
busy or partly covered laptop slows every run several-fold.

## Switches

Each change in the compile work has a localStorage kill switch (set to `"0"` before loading the page)
for A/B tests: `shaderCompile.deterministicWgsl`, `shaderCompile.window`,
`shaderCompile.asyncPipelines`, `post.aoNormalsFromScenePass`, `ground.mirrorSceneContext`,
`boot.parallelAssets`. `ground.reflection=0` switches the mirror off entirely, as a reference.
