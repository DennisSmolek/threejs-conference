/**
 * The first WebGPU adapter request in a browser session takes seconds (Chrome brings up WebGPU in
 * its GPU process: ~2–3 s on a Windows laptop), later ones a few milliseconds. index.html starts
 * that request before the app's code has downloaded, with the options three's WebGPUBackend uses,
 * so asset loading can run while it completes.
 */

export const ADAPTER_OPTIONS = {
  powerPreference: "high-performance",
  featureLevel: "compatibility",
};

let adapterPromise = null;

export function getEarlyAdapter() {
  if (adapterPromise) {
    return adapterPromise;
  }

  const early = globalThis.__gpuAdapter;
  if (early) {
    adapterPromise = Promise.resolve(early).catch(() => null);
  } else if (typeof navigator !== "undefined" && navigator.gpu) {
    adapterPromise = navigator.gpu.requestAdapter(ADAPTER_OPTIONS).catch(() => null);
  } else {
    adapterPromise = Promise.resolve(null);
  }

  return adapterPromise;
}

/** Kill switch: localStorage "boot.parallelAssets" = "0" loads assets after the renderer, as before. */
export function isParallelAssetLoadEnabled() {
  try {
    return globalThis.localStorage?.getItem("boot.parallelAssets") !== "0";
  } catch {
    return true;
  }
}

/**
 * What KTX2Loader.detectSupport reads from a WebGPU renderer, answered from the adapter. three's
 * backend requests every feature the adapter has, so the device will report the same formats.
 */
export function adapterFeatureSource(adapter) {
  return {
    isWebGPURenderer: true,
    hasFeature: (name) => adapter.features.has(name),
  };
}
