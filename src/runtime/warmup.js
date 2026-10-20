/**
 * Startup shader warmup. Runs behind the loader ("ASSEMBLING SECTOR") before the render loop starts.
 *
 * Every material is compiled asynchronously in each render context that will draw it, so the first
 * visible frames create no pipelines on the render path (a sync pipeline blocks Chrome's GPU
 * process: on Windows each heavy shader is a frozen frame):
 *   - scene passes (post scenePass / aoPrePass): own MRT target, pinned call depth
 *   - ground mirror: half-float target, no MRT, depth 0
 *   - warm frames for every post output variant (steady + intro glass), with every remaining
 *     render-path miss created async (asyncRenderPipelines.js): post quads, shadow map,
 *     collision-height override pass, transparent double-sided back/front passes. ENTER then
 *     only swaps the final quad onto programs that already exist.
 * Rain, smoke and planes are compiled here too (they used to be deferred into the intro, where the
 * deferred compile warmed the wrong context and they compiled synchronously on first draw).
 *
 * Compute kernels stay synchronous (no async compute path in 0.185): three small ones.
 */

import { collectCollisionHideObjects } from "../world/weather/collisionHideObjects.js";
import { compilePassNode } from "./shaderCompile/compileWindow.js";
import { renderUntilPipelinesReady } from "./shaderCompile/asyncRenderPipelines.js";

function renderWarmFrame({ world, pipeline, post, renderer, camera }) {
  world.collisionHeight?.update({
    camera,
    hideObjects: collectCollisionHideObjects(world),
  });
  world.rain?.update(1 / 60, camera);
  world.ground?.update?.(1 / 60);
  const rainEnabled = world.rain?.params?.enabled ?? false;
  world.ground?.setRippleAmount?.(rainEnabled ? 1 : 0);
  const carRainActive = world.carSurfaceRain?.syncProximity({
    camera,
    carRoot: world.car,
    rainEnabled,
  });
  if (carRainActive) {
    world.carSurfaceRain.update(1 / 60);
  }
  world.ground?.updateReflection?.(renderer, camera);
  pipeline.syncCameras?.(camera);
  post.render();
}

export async function finalizeStartupLighting({
  loaderOverlay,
  syncLighting,
  requestShadowMapUpdate,
  renderer,
  pipeline,
  camera,
  world,
  post,
}) {
  loaderOverlay.setProgress(0.88);
  loaderOverlay.setStatus("SYNCING LIGHTS");

  syncLighting();
  requestShadowMapUpdate?.("startup-lighting");

  // Assets are in — show 100% and a phase label while shaders compile (can take seconds).
  loaderOverlay.setProgress(1);
  loaderOverlay.setStatus("ASSEMBLING SECTOR");
  world.ground?.syncReflectionSize?.(renderer);
  pipeline.syncCameras?.(camera);

  // Rain buffers and instance state exist before the rain mesh is compiled
  world.collisionHeight?.update({
    camera,
    hideObjects: collectCollisionHideObjects(world),
  });
  world.rain?.update(0, camera);

  for (const passNode of pipeline.scenePasses ?? []) {
    await compilePassNode(renderer, passNode);
  }
  await world.ground?.warmReflection?.(renderer);

  // Post quads have no compileAsync path: render each output variant until its frame needs no
  // new pipeline, ending on the variant the intro shows.
  const variants = [];
  pipeline.forEachOutputVariant((selectVariant) => variants.push(selectVariant));
  for (const selectVariant of variants) {
    selectVariant();
    requestShadowMapUpdate?.("startup-warm");
    await renderUntilPipelinesReady(() =>
      renderWarmFrame({ world, pipeline, post, renderer, camera }),
    );
  }

  // The sun's shadow map is static (autoUpdate off): its startup render leaves the flying planes
  // out, as before, or a moving plane's shadow would be frozen into it.
  const planesGroup = world.planes?.group ?? null;
  const planesVisible = planesGroup?.visible ?? false;
  if (planesGroup) {
    planesGroup.visible = false;
  }
  requestShadowMapUpdate?.("startup-final");
  await renderUntilPipelinesReady(() =>
    renderWarmFrame({ world, pipeline, post, renderer, camera }),
  );
  if (planesGroup) {
    planesGroup.visible = planesVisible;
  }
}
