import {
  DataTexture,
  LinearFilter,
  RGBAFormat,
  RGBFormat,
  RGFormat,
  RedFormat,
} from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

const UNCOMPRESSED_FORMATS = new Set([
  RGBAFormat,
  RGBFormat,
  RGFormat,
  RedFormat,
]);

let dracoLoader;
let ktx2Loader;
let gltfLoader;

// KTX2 RGBA fallback still wraps as CompressedTexture; WebGPU needs DataTexture.
// Only runs for uncompressed formats — GPU-compressed (BC/ETC/ASTC) pass through.
function patchKTX2UncompressedTextures() {
  if (patchKTX2UncompressedTextures.applied) {
    return;
  }

  const createTextureFrom = KTX2Loader.prototype._createTextureFrom;

  KTX2Loader.prototype._createTextureFrom = function (
    transcodeResult,
    container,
  ) {
    const texture = createTextureFrom.call(this, transcodeResult, container);

    if (
      !texture.isCompressedTexture ||
      !UNCOMPRESSED_FORMATS.has(texture.format)
    ) {
      return texture;
    }

    const mip = texture.mipmaps[0];
    const dataTexture = new DataTexture(
      mip.data,
      mip.width,
      mip.height,
      texture.format,
      texture.type,
    );

    dataTexture.minFilter = LinearFilter;
    dataTexture.magFilter = LinearFilter;
    dataTexture.colorSpace = texture.colorSpace;
    dataTexture.premultiplyAlpha = texture.premultiplyAlpha;
    dataTexture.wrapS = texture.wrapS;
    dataTexture.wrapT = texture.wrapT;
    dataTexture.needsUpdate = true;

    return dataTexture;
  };

  patchKTX2UncompressedTextures.applied = true;
}

/**
 * `featureSource` is the renderer, or a promise of something KTX2Loader.detectSupport accepts
 * (see bootstrap/earlyAdapter.js). Only the first KTX2 transcode waits for it, so downloads,
 * Draco and image decoding start before the renderer exists.
 */
export function getGltfLoader(featureSource) {
  patchKTX2UncompressedTextures();

  // Avoid disposing mid-flight when city + car load in parallel.
  if (gltfLoader) {
    return gltfLoader;
  }

  dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("/libs/draco/");

  ktx2Loader = new KTX2Loader();
  ktx2Loader.setTranscoderPath("/libs/basis/");
  // Keep hardware compression (BC/ETC2/ASTC). Do NOT force RGBA32 —
  // that was the walk-mode FPS collapse from texture bandwidth.
  const supportDetected = Promise.resolve(featureSource).then((source) => {
    ktx2Loader.detectSupport(source);
  });
  const createTexture = ktx2Loader._createTexture;
  ktx2Loader._createTexture = (...args) =>
    supportDetected.then(() => createTexture.apply(ktx2Loader, args));

  gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);
  gltfLoader.setKTX2Loader(ktx2Loader);

  return gltfLoader;
}
