import { RenderPipeline, BlendMode, NormalBlending } from "three/webgpu";
import {
  pass,
  mrt,
  output,
  emissive,
  vec4,
  mix,
  smoothstep,
  uniform,
  vec3,
  sample,
  normalView,
  packNormalToRGB,
  unpackRGBToNormal,
} from "three/tsl";
import { MaterialBlending, UnsignedByteType } from "three";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { lensflare } from "three/addons/tsl/display/LensflareNode.js";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { createCyberpunkLook } from "./look/cyberpunkLook.js";
import { boxBlurSeparable } from "../tsl/boxBlur.js";
import { applyRainGlass, createRainGlassUniforms } from "../tsl/rainGlass.js";
import { performanceProfile } from "../platform/performanceProfile.js";
import { isSafari } from "../platform/deviceLayout.js";
import { FEATURES } from "../world/features.js";
import { pinPassRenderContexts } from "../runtime/shaderCompile/compileWindow.js";

function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Objects the scene camera draws but the AO camera doesn't (rain, smoke layers) must not touch the
 * AO normal attachment: a per-material MRT entry writes alpha 0 there, which their alpha blending
 * turns into "keep what is there".
 */
function excludeFromAoNormals(scene, sceneCamera, aoCamera) {
  const keepNormal = mrt({ normal: vec4(0) });
  scene.traverse((object) => {
    if (
      !object.material ||
      !object.layers.test(sceneCamera.layers) ||
      object.layers.test(aoCamera.layers)
    ) {
      return;
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material?.isNodeMaterial) {
        continue;
      }
      const keepsBuffer =
        material.transparent &&
        !material.depthWrite &&
        material.blending === NormalBlending &&
        !material.premultipliedAlpha;
      if (!keepsBuffer) {
        console.warn(
          `[post] ${material.name || material.type} on an AO-excluded layer is not a normal-blended, non-depth-writing transparent; AO will see it`,
        );
      }
      material.mrtNode = keepNormal;
    }
  });
}

export function createPostProcessing(renderer, scene, camera, { rain, smoke } = {}) {
  const post = new RenderPipeline(renderer);
  const rainLayer = rain?.layer ?? null;
  const smokeLayer = smoke?.layer ?? null;
  const rainUsesDedicatedPass = rain?.useDedicatedPass !== false && rainLayer !== null;

  const aoCamera = camera.clone();
  if (rainLayer !== null) {
    aoCamera.layers.disable(rainLayer);
  }
  if (smokeLayer !== null) {
    aoCamera.layers.disable(smokeLayer);
  }

  const sceneCamera = camera.clone();
  if (rainLayer !== null) {
    if (rainUsesDedicatedPass) {
      sceneCamera.layers.disable(rainLayer);
    } else {
      sceneCamera.layers.enable(rainLayer);
    }
  }
  if (smokeLayer !== null) {
    sceneCamera.layers.enable(smokeLayer);
  }

  const rainCamera =
    rainUsesDedicatedPass && rainLayer !== null
      ? (() => {
          const nextCamera = camera.clone();
          nextCamera.layers.disable(0);
          nextCamera.layers.enable(rainLayer);
          return nextCamera;
        })()
      : null;

  function syncCameras(sourceCamera) {
    aoCamera.copy(sourceCamera, false);
    if (rainLayer !== null) {
      aoCamera.layers.disable(rainLayer);
    }
    if (smokeLayer !== null) {
      aoCamera.layers.disable(smokeLayer);
    }
    aoCamera.updateMatrixWorld(true);

    sceneCamera.copy(sourceCamera, false);
    if (rainLayer !== null) {
      if (rainUsesDedicatedPass) {
        sceneCamera.layers.disable(rainLayer);
      } else {
        sceneCamera.layers.enable(rainLayer);
      }
    }
    if (smokeLayer !== null) {
      sceneCamera.layers.enable(smokeLayer);
    }
    sceneCamera.updateMatrixWorld(true);

    if (rainCamera) {
      rainCamera.copy(sourceCamera, false);
      rainCamera.layers.disable(0);
      rainCamera.layers.enable(rainLayer);
      rainCamera.updateMatrixWorld(true);
    }
  }

  syncCameras(camera);

  // GTAO normals + depth. With AO on (desktop) they come from an extra attachment of the scene
  // pass: a separate normal prepass drew the whole lit scene a second time every frame, and
  // compiled every material in one more render context. Rain and smoke (excluded from AO) don't
  // write depth and keep the normal buffer untouched (excludeFromAoNormals), so depth and
  // normals match the old prepass. AO off at startup (mobile): keep the prepass path, which is
  // only drawn and compiled if AO is switched on later.
  // Kill switch: localStorage.setItem("post.aoNormalsFromScenePass", "0")
  const aoNormalsFromScenePass =
    performanceProfile.ao && readStorage("post.aoNormalsFromScenePass") !== "0";

  const scenePass = pass(scene, sceneCamera);
  scenePass.transparent = true;
  const mrtNode = mrt({
    output,
    emissive: vec4(emissive, output.a),
    ...(aoNormalsFromScenePass ? { normal: vec4(packNormalToRGB(normalView), 1) } : {}),
  });
  mrtNode.setBlendMode("emissive", new BlendMode(NormalBlending));
  if (aoNormalsFromScenePass) {
    // Material blending: opaque materials overwrite (as the old prepass did); transparent ones
    // write alpha 1, which normal blending also turns into an overwrite; rain / smoke write
    // alpha 0 (excludeFromAoNormals), which leaves the buffer as it was. An MRT entry with no
    // blend mode is never blended, so their zeros would land in the buffer.
    mrtNode.setBlendMode("normal", new BlendMode(MaterialBlending));
  }
  scenePass.setMRT(mrtNode);

  let aoPrePass = null;
  let aoInputPass = scenePass;
  let aoNormalTexture = "normal";

  if (aoNormalsFromScenePass) {
    excludeFromAoNormals(scene, sceneCamera, aoCamera);
  } else {
    aoPrePass = pass(scene, aoCamera);
    aoPrePass.transparent = true;
    aoPrePass.setMRT(
      mrt({
        output: packNormalToRGB(normalView),
      }),
    );
    aoInputPass = aoPrePass;
    aoNormalTexture = "output";
  }
  // No type override on "output": PassNode.setup resets it to the renderer's output buffer type
  // (HalfFloat) on the first graph build, and the warm compile must see the final format.

  // Texture nodes created here, not lazily inside sample(): getTextureNode adds the attachment
  // to the pass target, and the render-context key counts attachments. Created at the first
  // graph build, the warm compile saw 2 attachments and every real frame 3 (all rebuilt).
  const aoDepth = aoInputPass.getTextureNode("depth");
  const aoNormalTextureNode = aoInputPass.getTextureNode(aoNormalTexture);
  const aoNormal = sample((uv) => unpackRGBToNormal(aoNormalTextureNode.sample(uv)));

  const scenePassColor = scenePass.getTextureNode("output");
  const scenePassEmissive = scenePass.getTextureNode("emissive");

  scenePass.getTexture("emissive").type = UnsignedByteType;

  // GTAO rebuilds view positions with its camera's projection matrix: give it the camera that drew
  // the depth. three converts a camera's projection to WebGPU's depth range only when it renders,
  // and syncCameras copies the source camera's WebGL-range matrix in every frame, so a camera no
  // pass renders (aoCamera without the prepass) hands GTAO the wrong depth mapping.
  const aoPass = ao(aoDepth, aoNormal, aoInputPass.camera);
  aoPass.resolutionScale = performanceProfile.aoResolutionScale;
  aoPass.samples.value = performanceProfile.aoSamples;
  aoPass.radius.value = performanceProfile.aoRadius;
  aoPass.scale.value = performanceProfile.aoScale;
  aoPass.thickness.value = performanceProfile.aoThickness;
  aoPass.distanceExponent.value = performanceProfile.aoDistanceExponent;
  aoPass.distanceFallOff.value = performanceProfile.aoDistanceFallOff;
  // Temporal filtering needs TRAA; we use SMAA, so keep noise lower via half-res + samples.
  aoPass.useTemporalFiltering = false;

  let rainPass = null;
  let rainPassColor = null;

  if (rainCamera) {
    rainPass = pass(scene, rainCamera);
    rainPassColor = rainPass.getTextureNode("output");
  }

  // One render context per scene pass regardless of how deep the post chain nests it
  pinPassRenderContexts(renderer, [scenePass, aoPrePass, rainPass].filter(Boolean));

  const bloomPass = bloom(scenePassEmissive, 2.5, 0.45);
  bloomPass.setResolutionScale(performanceProfile.bloomResolutionScale);

  const lensflareThreshold = uniform(0.09);
  const lensflareGhostAttenuation = uniform(50);
  const lensflareGhostSpacing = uniform(0.27);
  const lensflareStrength = uniform(0.3);
  const lensflareBlurRadius = uniform(performanceProfile.lensflareBlurRadius);

  const flarePass = lensflare(bloomPass, {
    threshold: lensflareThreshold,
    ghostAttenuationFactor: lensflareGhostAttenuation,
    ghostSpacing: lensflareGhostSpacing,
  });
  const flareBlurred = gaussianBlur(flarePass, lensflareBlurRadius, 4, {
    resolutionScale: performanceProfile.lensflareResolutionScale,
  });

  const look = createCyberpunkLook({ scenePass });

  const blurSize = uniform(3);
  const blurSpread = uniform(2);
  const minDistance = uniform(36);
  const maxDistance = uniform(75);
  const focusPointView = uniform(vec3());

  const scenePassViewZ = scenePass.getViewZNode();

  const blurFactor = smoothstep(
    minDistance,
    maxDistance,
    scenePassViewZ.sub(focusPointView.z).abs(),
  );

  let bloomActive = performanceProfile.bloom;
  let dofActive = performanceProfile.dof;
  let lensflareActive = performanceProfile.lensflare;
  let aoActive = performanceProfile.ao;
  let rainPassActive = rain?.params?.enabled ?? Boolean(rainPassColor);
  const dofEnabled = uniform(dofActive ? 1 : 0);

  let steadyOutput = null;
  let steadyOutputWithSmaa = null;
  let composedOutputRef = null;
  let introOutput = null;
  let introRainGlassActive = FEATURES.intro;
  let introRainGlassRef = null;
  let introRainGlassUniformsRef = null;
  let smaaActive = performanceProfile.smaa;

  if (FEATURES.intro) {
    introRainGlassUniformsRef = createRainGlassUniforms();
    introRainGlassRef = {
      speed: introRainGlassUniformsRef.speed,
      intensity: introRainGlassUniformsRef.intensity,
      distortionStrength: introRainGlassUniformsRef.distortionStrength,
      dropSize: introRainGlassUniformsRef.dropSize,
      blurRadius: introRainGlassUniformsRef.blurRadius,
      amount: introRainGlassUniformsRef.amount,
    };
  }

  function buildBloomContribution() {
    if (bloomActive && lensflareActive) {
      return bloomPass.add(flareBlurred.mul(lensflareStrength));
    }

    if (bloomActive) {
      return bloomPass;
    }

    if (lensflareActive) {
      return flareBlurred.mul(lensflareStrength);
    }

    return null;
  }

  function buildBeautyInput() {
    let beauty = scenePassColor;

    if (aoActive) {
      const aoValue = aoPass.getTextureNode().r;
      // Post-multiply GTAO onto beauty (smoke is in scenePass; excluded from AO normals).
      beauty = beauty.mul(vec4(vec3(aoValue), 1));
    }

    if (rainUsesDedicatedPass && rainPassActive && rainPassColor) {
      beauty = beauty.add(rainPassColor.rgb.mul(rainPassColor.a));
    }

    return beauty;
  }

  function rebuildSteadyOutput() {
    let beauty = buildBeautyInput();

    if (dofActive && !isSafari()) {
      const blurredBeauty = boxBlurSeparable(beauty, {
        size: blurSize,
        separation: blurSpread,
        premultipliedAlpha: true,
      });
      beauty = mix(beauty, blurredBeauty, blurFactor);
    }

    const bloomContribution = buildBloomContribution();
    const preAA = look.buildComposite(beauty, { bloomContribution });
    const aaOutput = smaa(preAA);
    steadyOutput = look.applyFilmGrain(preAA);
    steadyOutputWithSmaa = look.applyFilmGrain(aaOutput);
    composedOutputRef = steadyOutput;

    if (introRainGlassActive && introRainGlassUniformsRef) {
      const rainGlassOut = applyRainGlass(steadyOutput, introRainGlassUniformsRef);
      introOutput = mix(steadyOutput, rainGlassOut, introRainGlassUniformsRef.amount);
    }

    post.outputNode = getActiveOutput();
    post.needsUpdate = true;
  }

  rebuildSteadyOutput();

  function getActiveOutput() {
    if (introRainGlassActive && introOutput) {
      return introOutput;
    }

    return smaaActive ? steadyOutputWithSmaa : steadyOutput;
  }

  post.outputNode = getActiveOutput();

  function disposeIntroRainGlass() {
    if (!introRainGlassActive) {
      return;
    }

    introRainGlassActive = false;
    introRainGlassUniformsRef = null;
    introOutput = null;
    introRainGlassRef = null;
    post.outputNode = getActiveOutput();
    post.needsUpdate = true;
  }

  function setRainPassEnabled(enabled) {
    const nextActive = Boolean(enabled);
    if (nextActive === rainPassActive) {
      return;
    }

    rainPassActive = nextActive;
    rebuildSteadyOutput();
  }

  if (rain?.setEnabled) {
    const originalSetEnabled = rain.setEnabled.bind(rain);
    rain.setEnabled = (value) => {
      originalSetEnabled(value);
      setRainPassEnabled(value);
    };
  }

  function updateFocusPoint(focusPoint, activeCamera) {
    activeCamera.updateMatrixWorld();
    focusPointView.value.copy(focusPoint).applyMatrix4(activeCamera.matrixWorldInverse);
  }

  // Hands warmup a selector per output the app will show (steady, then intro glass if active) so
  // their post shaders exist before the loop starts; the swap at ENTER then reuses them. The last
  // selector is the active output.
  function forEachOutputVariant(visit) {
    const variants = [smaaActive ? steadyOutputWithSmaa : steadyOutput];
    if (introRainGlassActive && introOutput) {
      variants.push(introOutput);
    }

    for (const outputNode of variants) {
      visit(() => {
        post.outputNode = outputNode;
        post.needsUpdate = true;
      });
    }
  }

  function restoreCombinedOutput() {
    post.outputNode = getActiveOutput();
    post.needsUpdate = true;
  }

  // Setters rebuild the post graph only on a real change: every rebuild makes new effect nodes,
  // and the next frame compiles their shaders on the render path.
  function setBloomEnabled(enabled) {
    if (bloomActive === Boolean(enabled)) {
      return;
    }
    bloomActive = Boolean(enabled);
    rebuildSteadyOutput();
  }

  function setBloomResolutionScale(scale) {
    bloomPass.setResolutionScale(scale);
  }

  function setDofEnabled(enabled) {
    if (dofActive === Boolean(enabled)) {
      return;
    }
    dofActive = Boolean(enabled);
    dofEnabled.value = dofActive ? 1 : 0;
    dofEnabled.needsUpdate = true;
    rebuildSteadyOutput();
  }

  function setLensflareEnabled(enabled) {
    if (lensflareActive === Boolean(enabled)) {
      return;
    }
    lensflareActive = Boolean(enabled);
    rebuildSteadyOutput();
  }

  function setLensflareResolutionScale(scale) {
    flareBlurred.resolutionScale = scale;
  }

  function setLensflareBlurRadius(radius) {
    lensflareBlurRadius.value = radius;
    lensflareBlurRadius.needsUpdate = true;
  }

  function setSmaaEnabled(enabled) {
    if (smaaActive === Boolean(enabled)) {
      return;
    }
    smaaActive = Boolean(enabled);
    post.outputNode = getActiveOutput();
    post.needsUpdate = true;
  }

  function setAoEnabled(enabled) {
    if (aoActive === Boolean(enabled)) {
      return;
    }
    aoActive = Boolean(enabled);
    rebuildSteadyOutput();
  }

  function setAoResolutionScale(scale) {
    aoPass.resolutionScale = scale;
  }

  function setAoSamples(samples) {
    aoPass.samples.value = samples;
  }

  function applyLookPreset(id, options = {}) {
    return look.applyPreset(id, {
      bloomPass,
      lensflare: {
        strength: lensflareStrength,
        threshold: lensflareThreshold,
        ghostSpacing: lensflareGhostSpacing,
        ghostAttenuation: lensflareGhostAttenuation,
      },
      ...options,
    });
  }

  function resizePostProcessing() {
    const width = Math.max(1, renderer.domElement.width);
    const height = Math.max(1, renderer.domElement.height);
    aoPrePass?.setSize(width, height);
    scenePass.setSize(width, height);
    rainPass?.setSize(width, height);
  }

  return {
    post,
    beautyCamera: sceneCamera,
    sceneCamera,
    aoCamera,
    rainCamera,
    // Scene-drawing passes, so warmup can compile each in its real render context. (aoPrePass
    // only exists when AO normals don't come from the scene pass.)
    scenePasses: [scenePass, aoActive ? aoPrePass : null, rainPass].filter(Boolean),
    // The ground mirror renders in this pass's context to share its node builds and pipelines
    scenePass,
    syncCameras,
    bloomPass,
    aoPass,
    lensflare: {
      pass: flareBlurred,
      strength: lensflareStrength,
      threshold: lensflareThreshold,
      ghostSpacing: lensflareGhostSpacing,
      ghostAttenuation: lensflareGhostAttenuation,
    },
    look,
    applyLookPreset,
    restoreCombinedOutput,
    forEachOutputVariant,
    resizePostProcessing,
    scenePassColor,
    scenePassEmissive,
    get composedOutput() {
      return composedOutputRef;
    },
    setRainPassEnabled,
    get introRainGlass() {
      return introRainGlassRef;
    },
    disposeIntroRainGlass,
    dof: {
      blurSize,
      blurSpread,
      minDistance,
      maxDistance,
      enabled: dofEnabled,
      focusPointView,
      updateFocusPoint,
    },
    perf: {
      setBloomEnabled,
      setBloomResolutionScale,
      setDofEnabled,
      setLensflareEnabled,
      setLensflareResolutionScale,
      setLensflareBlurRadius,
      setSmaaEnabled,
      setAoEnabled,
      setAoResolutionScale,
      setAoSamples,
    },
  };
}
