/**
 * Render-path pipelines created asynchronously instead of blocking (three 0.185).
 *
 * On a pipeline-cache miss three calls device.createRenderPipeline() synchronously: Chrome's GPU
 * process compiles while no frame is presented (on Windows, seconds for heavy shaders). Two
 * places can't be warmed with compileAsync, so here a miss goes through
 * createRenderPipelineAsync instead and three skips that draw until the pipeline is ready:
 *
 * - Shadow maps, always: the pass draws every caster with one shared override material that three
 *   mutates per object, so compileAsync can't warm it. A shadow render that skipped a caster is
 *   re-requested and fills in over the next frames.
 * - Warm frames (renderUntilPipelinesReady): post-processing quads, override-material passes and
 *   transparent double-sided materials (drawn back-then-front, which compileAsync warms as one
 *   cullMode:none variant nobody draws). Behind the loader, a frame with skipped draws is never
 *   seen; frames repeat until every pipeline they need exists.
 *
 * 0.185's ShadowNode has no precompile guard either, so compileAsync re-rendered the shadow map in
 * the middle of a warm compile, in the wrong context: `renderer.__compiling` skips that.
 *
 * Needs installErrorScopeFix (several pipeline creations in flight across frames).
 * Kill switch: localStorage.setItem("shaderCompile.asyncPipelines", "0").
 */
import { ShadowNode } from "three/webgpu";

const PATCHED = Symbol.for("threejsPunk.asyncRenderPipelines");

let inShadowRender = false;
let warmFrames = false;
let skipped = 0;
const pending = new Set();
const instrumented = new WeakSet();

function isDisabled() {
  try {
    return globalThis.localStorage?.getItem("shaderCompile.asyncPipelines") === "0";
  } catch {
    return false;
  }
}

// A pipeline whose async creation failed is never ready: three already reported it, and counting
// it as skipped would re-render the shadow map every frame and run every warm frame.
function hasFailed(pipelines, renderObject) {
  const pipeline = pipelines.get(renderObject).pipeline;
  return pipeline !== undefined && pipelines.backend.get(pipeline).error === true;
}

function instrument(pipelines) {
  if (instrumented.has(pipelines)) {
    return;
  }
  instrumented.add(pipelines);

  const updateForRender = pipelines.updateForRender;
  pipelines.updateForRender = function (renderObject) {
    if (!inShadowRender && !warmFrames) {
      return updateForRender.call(this, renderObject);
    }
    // A promise list routes a cache miss through createRenderPipelineAsync. The pipeline then
    // exists but is not ready, so three skips this draw.
    const started = [];
    this.getForRender(renderObject, started);
    for (const promise of started) {
      pending.add(promise);
      promise.finally(() => pending.delete(promise));
    }
  };

  const isReady = pipelines.isReady;
  pipelines.isReady = function (renderObject) {
    const ready = isReady.call(this, renderObject);
    if ((inShadowRender || warmFrames) && !ready && !hasFailed(this, renderObject)) {
      skipped += 1;
    }
    return ready;
  };
}

export function installAsyncRenderPipelines(renderer) {
  if (isDisabled()) {
    return;
  }
  // Per renderer (a second renderer, e.g. after HMR, needs its own Pipelines wrapped)
  instrument(renderer._pipelines);

  const proto = ShadowNode.prototype;
  if (proto[PATCHED]) {
    return;
  }
  proto[PATCHED] = true;

  const updateBefore = proto.updateBefore;
  proto.updateBefore = function (frame) {
    const frameRenderer = frame.renderer;
    if (frameRenderer?.__compiling) {
      return;
    }

    const due = this.shadow.needsUpdate || this.shadow.autoUpdate;
    if (!due || warmFrames) {
      // Warm frames already route every miss async and count skips themselves
      updateBefore.call(this, frame);
      if (warmFrames && skipped > 0) {
        this.shadow.needsUpdate = true;
      }
      return;
    }

    const skippedBefore = skipped;
    inShadowRender = true;
    try {
      updateBefore.call(this, frame);
    } finally {
      inShadowRender = false;
    }

    // three just cleared needsUpdate; a partial map must render again
    if (skipped > skippedBefore) {
      this.shadow.needsUpdate = true;
    }
  };
}

/**
 * Renders `renderFrame` until a frame creates no new pipeline and skips no draw. Every pipeline
 * miss in these frames compiles asynchronously (in parallel on Chrome's compile pool).
 * @returns {Promise<number>} frames rendered
 */
export async function renderUntilPipelinesReady(renderFrame, { maxFrames = 30 } = {}) {
  if (isDisabled()) {
    renderFrame();
    return 1;
  }

  let frames = 0;
  while (frames < maxFrames) {
    skipped = 0;
    warmFrames = true;
    try {
      renderFrame();
    } finally {
      warmFrames = false;
    }
    frames += 1;

    if (skipped === 0 && pending.size === 0) {
      break;
    }
    while (pending.size > 0) {
      await Promise.all(pending);
    }
  }
  return frames;
}
