/**
 * Dev-only: records every node build (TSL graph → WGSL) with its render context and cache key in
 * `window.__nodeBuilds`, so bench/stages.mjs can tell warm-compile builds from render-path builds
 * and find why a warmed material is built again (a different key = a different context or state).
 */
export function installNodeBuildProbe(renderer) {
  const nodes = renderer._nodes;
  if (!nodes || nodes.__buildProbe) {
    return;
  }
  nodes.__buildProbe = true;

  const builds = (window.__nodeBuilds = []);
  const createNodeBuilder = nodes._createNodeBuilder.bind(nodes);

  nodes._createNodeBuilder = (renderObject, material) => {
    const builder = createNodeBuilder(renderObject, material);
    const entry = {
      t: performance.now(),
      mat: material.name || material.type,
      matId: material.id,
      ctx: renderObject.context?.id,
      key: renderObject.initialCacheKey,
      pass: renderObject.passId ?? null,
      cam: renderObject.camera?.name || renderObject.camera?.type,
      side: material.side,
      compiling: renderer.__compiling === true,
    };

    for (const method of ["build", "buildAsync"]) {
      const original = builder[method].bind(builder);
      builder[method] = (...args) => {
        const start = performance.now();
        const result = original(...args);
        const done = () => {
          entry.ms = performance.now() - start;
          entry.sync = method === "build";
          entry.fsKB = Math.round((builder.fragmentShader?.length ?? 0) / 1024);
          builds.push(entry);
        };
        if (result instanceof Promise) {
          return result.then((value) => {
            done();
            return value;
          });
        }
        done();
        return result;
      };
    }

    return builder;
  };
}
