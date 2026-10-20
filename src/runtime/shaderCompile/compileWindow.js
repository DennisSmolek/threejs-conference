/**
 * Compile scheduling for three 0.185 WebGPURenderer, without patching three.
 *
 * 1. installErrorScopeFix — three pushes a validation error scope, starts
 *    createRenderPipelineAsync, *awaits it*, then pops. Scopes are a per-device stack, so with
 *    several compiles in flight each pop closes another pipeline's scope, and errors from frames
 *    rendered meanwhile land in a compile's scope: three marks that pipeline failed and silently
 *    never draws it. We pop right after the create call instead (async creation errors arrive as
 *    promise rejections, not through the scope) and turn three's later pop into a no-op.
 *
 * 2. installSlidingCompileWindow — stock compileAsync awaits each object's pipeline before
 *    building the next, so Chrome's async compile pool (≈ cores − 1 threads) runs one compile at a
 *    time. Keep up to `limit` in flight instead (never unbounded: hundreds starve the GPU process).
 *
 * 3. compileInContext — compileAsync uses the renderer's *current* target, MRT and call depth.
 *    Post passes (PassNode) render nested at call depth 1 into their own MRT target, so a bare
 *    compileAsync(scene, camera) warms a variant nobody draws. This binds the real target / MRT /
 *    depth, includes frustum-culled objects, and serializes compiles renderer-wide. Transparent
 *    DoubleSide objects are left to the warm frames (compileAsync would build the wrong side).
 *
 * Kill switch: localStorage.setItem("shaderCompile.window", "0") → stock serial compileAsync.
 */

import { DoubleSide } from "three/webgpu";

function isDisabled(key) {
  try {
    return globalThis.localStorage?.getItem(key) === "0";
  } catch {
    return false;
  }
}

export function installErrorScopeFix(renderer) {
  const device = renderer.backend?.device;
  if (!device || device.__errorScopeFix) {
    return;
  }
  device.__errorScopeFix = true;

  const push = device.pushErrorScope.bind(device);
  const pop = device.popErrorScope.bind(device);
  const createAsync = device.createRenderPipelineAsync.bind(device);

  // Scopes three pushed and has not popped yet. Its sync paths push → create → pop with no await
  // in between, so a pop arriving while none is open must be an async create's deferred pop.
  let open = 0;
  let owed = 0;

  device.pushErrorScope = (filter) => {
    open += 1;
    return push(filter);
  };

  device.popErrorScope = () => {
    if (open === 0 && owed > 0) {
      owed -= 1;
      return Promise.resolve(null);
    }
    open = Math.max(0, open - 1);
    return pop();
  };

  device.createRenderPipelineAsync = (descriptor) => {
    const promise = createAsync(descriptor);
    if (open > 0) {
      open -= 1;
      owed += 1;
      pop()
        .then((error) => {
          if (error) {
            console.error(
              `[shaderCompile] validation error while creating ${descriptor.label}: ${error.message}`,
            );
          }
        })
        .catch(() => {
          // device lost: nothing left to report
        });
    }
    return promise;
  };
}

export const DEFAULT_COMPILE_WINDOW = Math.min(
  8,
  Math.max(3, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1),
);

export function installSlidingCompileWindow(renderer, limit = DEFAULT_COMPILE_WINDOW) {
  if (renderer.__slidingCompileWindow || isDisabled("shaderCompile.window")) {
    return;
  }
  renderer.__slidingCompileWindow = true;

  const original = renderer.compileAsync.bind(renderer);
  let active = false;

  renderer.compileAsync = async (...args) => {
    const pipelines = renderer._pipelines;
    if (!pipelines || active) {
      return original(...args);
    }

    const inflight = new Set();
    const waiters = [];
    const track = (promise) => {
      const tracked = promise
        .catch(() => {})
        .finally(() => {
          inflight.delete(tracked);
          waiters.shift()?.();
        });
      inflight.add(tracked);
    };

    const getForRender = pipelines.getForRender;
    pipelines.getForRender = function (renderObject, promises = null) {
      // Render-path calls (no promise list) stay synchronous and untouched
      if (promises === null) {
        return getForRender.call(this, renderObject, promises);
      }

      const started = [];
      const result = getForRender.call(this, renderObject, started);
      for (const promise of started) {
        track(promise);
      }
      if (started.length > 0) {
        // three's loop awaits this gate instead of the pipeline: it moves on once a slot is free
        promises.push(
          inflight.size < limit
            ? Promise.resolve()
            : new Promise((resolve) => waiters.push(resolve)),
        );
      }
      return result;
    };

    active = true;
    try {
      await original(...args);
      while (inflight.size > 0) {
        await Promise.all(inflight);
      }
    } finally {
      pipelines.getForRender = getForRender;
      active = false;
    }
  };
}

/**
 * three keys render contexts by attachment format + MRT + *call depth*, and node builds are
 * cached per context. A scene PassNode renders at whatever depth the post chain first reaches it
 * (measured: scenePass at 3, aoPrePass at 2 in one output variant and 4 in another), so a
 * pass's materials were rebuilt per depth, and no warm compile could predict which depth.
 * Each pass here has its own MRT node and renders once per frame, never nested in itself, so
 * one fixed depth for that MRT is safe and lets warm compiles and every frame share a context.
 */
export const PINNED_PASS_DEPTH = 1;

export function pinPassRenderContexts(renderer, passNodes) {
  const mrtNodes = new Set(passNodes.map((passNode) => passNode.getMRT()).filter(Boolean));
  if (mrtNodes.size === 0) {
    return;
  }

  const contexts = renderer._renderContexts;
  const getContext = contexts.get.bind(contexts);
  contexts.get = (renderTarget = null, mrt = null, callDepth = 0) =>
    getContext(renderTarget, mrt, mrtNodes.has(mrt) ? PINNED_PASS_DEPTH : callDepth);
}

let compileChain = Promise.resolve();

function isTwoPassTransparent(material) {
  const materials = Array.isArray(material) ? material : [material];
  return materials.some(
    (m) => m?.transparent === true && m.side === DoubleSide && m.forceSinglePass === false,
  );
}

/**
 * Warm-compiles `scene` exactly as a later `renderer.render(scene, camera)` with this target, MRT
 * and call depth will draw it. Compiles run one at a time renderer-wide: node builds read the
 * bound target / MRT live across their awaits, so nothing else may render meanwhile.
 */
export function compileInContext(
  renderer,
  {
    scene,
    camera,
    renderTarget = null,
    mrt = null,
    callDepth = 0,
    includeCulled = true,
    applyState = null,
  },
) {
  const run = async () => {
    const prevTarget = renderer.getRenderTarget();
    const prevMRT = renderer.getMRT();
    const contexts = renderer._renderContexts;
    const getContext = contexts.get;
    const culled = [];
    const twoPass = [];
    let restoreState = null;

    try {
      renderer.setRenderTarget(renderTarget);
      renderer.setMRT(mrt);
      restoreState = applyState?.() ?? null;
      // Read by asyncRenderPipelines: no shadow-map render in the middle of a warm compile
      renderer.__compiling = true;

      // compileAsync picks its render context and culls before its first await, so these
      // overrides only need to hold for the synchronous prefix of the call
      contexts.get = (target, mrtNode) => getContext.call(contexts, target, mrtNode, callDepth);
      scene.traverseVisible((object) => {
        if (includeCulled && object.frustumCulled) {
          object.frustumCulled = false;
          culled.push(object);
        }
        // Transparent DoubleSide draws as a back pass then a front pass. compileAsync queues both
        // but builds after a yield, when material.side is DoubleSide again, and the render reuses
        // that build (front_facing normals) for both passes: the glass shades wrong. Leave these
        // to the warm frames, which build them on the render path with the right side.
        if (object !== scene && isTwoPassTransparent(scene.overrideMaterial ?? object.material)) {
          object.visible = false;
          twoPass.push(object);
        }
      });

      let pending;
      try {
        pending = renderer.compileAsync(scene, camera);
      } finally {
        contexts.get = getContext;
        for (const object of culled) {
          object.frustumCulled = true;
        }
        for (const object of twoPass) {
          object.visible = true;
        }
      }
      await pending;
    } finally {
      renderer.__compiling = false;
      restoreState?.();
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(prevMRT);
    }
  };

  const result = compileChain.then(run, run);
  compileChain = result.catch(() => {});
  return result;
}

/**
 * Warm-compiles a scene PassNode the way its updateBefore renders it: own target and MRT, at the
 * pinned call depth (pinPassRenderContexts), with the pass's layers / transparency / override
 * material / context node. (Stock PassNode.compileAsync uses depth 0: three #34681.)
 */
export function compilePassNode(renderer, passNode, { callDepth = PINNED_PASS_DEPTH } = {}) {
  const { scene, camera } = passNode;

  return compileInContext(renderer, {
    scene,
    camera,
    renderTarget: passNode.renderTarget,
    mrt: passNode.getMRT(),
    callDepth,
    applyState: () => {
      const prev = {
        transparent: renderer.transparent,
        opaque: renderer.opaque,
        contextNode: renderer.contextNode,
        overrideMaterial: scene.overrideMaterial,
        mask: camera.layers.mask,
      };

      renderer.transparent = passNode.transparent;
      renderer.opaque = passNode.opaque;
      if (passNode.overrideMaterial !== null) {
        scene.overrideMaterial = passNode.overrideMaterial;
      }
      if (passNode._layers) {
        camera.layers.mask = passNode._layers.mask;
      }
      if (passNode.contextNode !== null) {
        console.warn("[shaderCompile] PassNode.contextNode is not warmed; first render compiles it");
      }

      return () => {
        renderer.transparent = prev.transparent;
        renderer.opaque = prev.opaque;
        renderer.contextNode = prev.contextNode;
        scene.overrideMaterial = prev.overrideMaterial;
        camera.layers.mask = prev.mask;
      };
    },
  });
}
