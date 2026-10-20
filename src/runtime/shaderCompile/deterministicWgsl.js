/**
 * Byte-identical WGSL across reloads and render contexts (three 0.185 WGSLNodeBuilder).
 *
 * three names unnamed uniform buffers `NodeBuffer_<global node id>` and orders shared uniform-group
 * members by graph traversal order. Both change between loads (node ids depend on how many nodes
 * were created first), so the same shader gets new text and Chrome's shader cache misses: a warm
 * reload still ran ~60 real DXC compiles (smoke sprites, bloom, SMAA, car paint).
 *
 * Fix: per-builder buffer names in registration order, and uniform-group members sorted by name
 * once per builder (the CPU-side buffer layout is built from the same arrays, so it stays in step).
 * Install after `renderer.init()` (the WebGL2 fallback swaps the backend there) and before the
 * first node build.
 *
 * Kill switch: localStorage.setItem("shaderCompile.deterministicWgsl", "0").
 */

const PATCHED = Symbol.for("threejsPunk.deterministicWgsl");
const SORTED = Symbol("uniformsSorted");
const BUFFER_COUNT = Symbol("bufferCount");
const STABLE_NAME = Symbol("stableName");
const AUTO_BUFFER_NAME = /^NodeBuffer_\d+$/;

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function isDisabled(key) {
  try {
    return globalThis.localStorage?.getItem(key) === "0";
  } catch {
    return false;
  }
}

export function installDeterministicWgsl(renderer) {
  if (isDisabled("shaderCompile.deterministicWgsl")) {
    return false;
  }

  const backend = renderer.backend;
  if (backend.isWebGPUBackend !== true) {
    return false;
  }
  if (backend.__deterministicWgsl) {
    return true;
  }

  // WGSLNodeBuilder is not exported: reach its prototype through the first builder created.
  const createNodeBuilder = backend.createNodeBuilder.bind(backend);
  backend.createNodeBuilder = (object, nodeRenderer) => {
    const builder = createNodeBuilder(object, nodeRenderer);
    const proto = Object.getPrototypeOf(builder);

    if (proto[PATCHED] !== true && typeof proto.getUniforms === "function") {
      proto[PATCHED] = true;

      const getUniforms = proto.getUniforms;
      proto.getUniforms = function (shaderStage) {
        if (this[SORTED] !== true) {
          this[SORTED] = true;
          for (const groupName in this.uniformGroups) {
            this.uniformGroups[groupName].uniforms.sort(byName);
          }
        }
        return getUniforms.call(this, shaderStage);
      };

      const getUniformFromNode = proto.getUniformFromNode;
      proto.getUniformFromNode = function (node, type, shaderStage, name = null) {
        const uniform = getUniformFromNode.call(this, node, type, shaderStage, name);
        if (
          name === null &&
          uniform[STABLE_NAME] !== true &&
          AUTO_BUFFER_NAME.test(uniform.name)
        ) {
          uniform[STABLE_NAME] = true;
          this[BUFFER_COUNT] = (this[BUFFER_COUNT] ?? 0) + 1;
          uniform.name = `NodeBuffer_s${this[BUFFER_COUNT]}`;
        }
        return uniform;
      };
    }

    return builder;
  };

  backend.__deterministicWgsl = true;
  return true;
}
