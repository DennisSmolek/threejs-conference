import * as THREE from "three/webgpu";
import { getStaticPixelRatio } from "../platform/performanceProfile.js";
import { isSafari } from "../platform/deviceLayout.js";
import {
  clearInspectorLayout,
  disableRendererTimestamps,
} from "../debug/inspectorControls.js";
import { installDeterministicWgsl } from "../runtime/shaderCompile/deterministicWgsl.js";
import {
  installErrorScopeFix,
  installSlidingCompileWindow,
} from "../runtime/shaderCompile/compileWindow.js";
import { installAsyncRenderPipelines } from "../runtime/shaderCompile/asyncRenderPipelines.js";
import { installNodeBuildProbe } from "../debug/nodeBuildProbe.js";
import { getEarlyAdapter } from "./earlyAdapter.js";

async function getWebGPULimits() {
  if (!navigator.gpu) {
    return {};
  }

  const adapter = await getEarlyAdapter();
  if (!adapter) {
    return {};
  }

  const desired = 64;
  const supported = adapter.limits.maxColorAttachmentBytesPerSample;
  if (supported >= desired) {
    return { maxColorAttachmentBytesPerSample: desired };
  }
  if (supported > 32) {
    return { maxColorAttachmentBytesPerSample: supported };
  }
  return {};
}

export async function createRenderer() {
  const requiredLimits = await getWebGPULimits();

  const renderer = new THREE.WebGPURenderer({
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
    stencil: false,
    requiredLimits,
  });
  renderer.setPixelRatio(getStaticPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  clearInspectorLayout();

  renderer.domElement.style.opacity = "0";
  renderer.domElement.style.zIndex = "14";
  renderer.domElement.style.transition = "opacity 220ms ease";
  document.body.appendChild(renderer.domElement);

  await renderer.init();
  disableRendererTimestamps(renderer);
  if (renderer.backend.isWebGPUBackend) {
    installDeterministicWgsl(renderer);
    installErrorScopeFix(renderer);
    // Safari WebGPU freezes under concurrent compiles + passes: keep it serial there
    installSlidingCompileWindow(renderer, isSafari() ? 1 : undefined);
    installAsyncRenderPipelines(renderer);
  }

  if (import.meta.env.DEV) {
    installNodeBuildProbe(renderer);
    const backend = renderer.backend.isWebGLBackend
      ? "WebGL2 (fallback)"
      : "WebGPU";
    console.info(`[renderer] ${backend}`);
  }

  return { renderer, inspector: null };
}

export function createShadowUpdater({ renderer, getSunLight }) {
  function requestShadowMapUpdate() {
    const sunLight = getSunLight?.();
    if (!sunLight || !renderer) {
      return;
    }

    sunLight.shadow.needsUpdate = true;
    renderer.shadowMap.needsUpdate = true;
  }

  return { requestShadowMapUpdate };
}

export function applyRendererPixelRatio(renderer, pipeline, dpr) {
  const width = window.innerWidth;
  const height = window.innerHeight;

  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height);
  pipeline?.resizePostProcessing?.(width, height);
}

export function resizeRenderer(renderer, pipeline, adaptiveDpr = null) {
  if (adaptiveDpr) {
    adaptiveDpr.onResize();
    return;
  }

  applyRendererPixelRatio(renderer, pipeline, getStaticPixelRatio());
}
