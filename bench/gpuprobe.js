// Vendored from the webgpu-tsl-compile skill (scripts/gpuprobe.js, MIT, (c) 2026 Dennis Smolek).
// Injected before any page script (Playwright addInitScript). Wraps the WebGPU device API so
// every shader module / pipeline creation is timed and attributed. Read back via window.__gpuProbe.
(() => {
    if (window.__gpuProbe) return;
    const P = (window.__gpuProbe = {
        timeOrigin: performance.timeOrigin,
        events: [],
        code: {},
        adapters: [],
        devices: 0,
        pending: 0,
        gaps: [],
    });
    const now = () => performance.now();
    // bench --stacks: record the JS call stack of every pipeline creation (which code path asked for it)
    const STACKS = !!window.__gpuProbeStacks;
    if (STACKS) Error.stackTraceLimit = 60;
    const stack = () => (STACKS ? new Error().stack.split('\n').slice(3).join('\n') : undefined);
    if (typeof GPUDevice === 'undefined') {
        P.noWebGPU = true;
        return;
    }
    const wrap = (proto, name, fn) => {
        const orig = proto[name];
        if (typeof orig !== 'function') return;
        proto[name] = function (...args) {
            return fn.call(this, orig, args);
        };
    };

    //* Adapter / device
    wrap(GPU.prototype, 'requestAdapter', function (orig, args) {
        const opts = args[0] || {};
        const t = now();
        return orig.apply(this, args).then((a) => {
            const info = a && a.info ? a.info : {};
            P.adapters.push({
                t,
                powerPreference: opts.powerPreference || null,
                vendor: info.vendor,
                architecture: info.architecture,
                device: info.device,
                description: info.description,
                features: a ? [...a.features] : [],
            });
            return a;
        });
    });
    wrap(GPUAdapter.prototype, 'requestDevice', function (orig, args) {
        const t = now();
        return orig.apply(this, args).then((d) => {
            P.devices++;
            P.events.push({ type: 'device', t, d: now() - t });
            d.addEventListener?.('uncapturederror', (e) =>
                P.events.push({
                    type: 'gpuerror',
                    t: now(),
                    msg: String(e.error?.message).slice(0, 500),
                }),
            );
            d.lost?.then((info) =>
                P.events.push({ type: 'lost', t: now(), msg: info?.message, reason: info?.reason }),
            );
            return d;
        });
    });

    //* Shader modules
    let modId = 0;
    wrap(GPUDevice.prototype, 'createShaderModule', function (orig, [desc]) {
        const t = now();
        const m = orig.call(this, desc);
        const d = now() - t;
        const id = ++modId;
        try {
            Object.defineProperty(m, '__probeId', { value: id });
        } catch {}
        const code = desc.code || '';
        P.code[id] = code;
        P.events.push({
            type: 'module',
            id,
            label: desc.label || '',
            len: code.length,
            lines: code.split('\n').length,
            t,
            d,
        });
        return m;
    });

    const stageIds = (desc) => ({
        vs: desc.vertex?.module?.__probeId,
        fs: desc.fragment?.module?.__probeId,
        cs: desc.compute?.module?.__probeId,
        // Descriptor fingerprint: what besides the WGSL makes Dawn compile a new pipeline
        key: desc.compute
            ? undefined
            : [
                  'T:' +
                      (desc.fragment?.targets || [])
                          .map((t) =>
                              t ? t.format + (t.blend ? '+b' : '') + (t.writeMask ?? '') : 'null',
                          )
                          .join(','),
                  'D:' +
                      (desc.depthStencil
                          ? `${desc.depthStencil.format}/${desc.depthStencil.depthCompare}/${desc.depthStencil.depthWriteEnabled}`
                          : 'none'),
                  'S:' + (desc.multisample?.count ?? 1),
                  'P:' +
                      `${desc.primitive?.topology ?? ''}/${desc.primitive?.cullMode ?? ''}/${desc.primitive?.frontFace ?? ''}`,
                  'VB:' +
                      (desc.vertex?.buffers || [])
                          .map((b) =>
                              b ? b.attributes.length + (b.stepMode === 'instance' ? 'i' : '') : 0,
                          )
                          .join(','),
                  'L:' + (desc.layout === 'auto' ? 'auto' : 'explicit'),
              ].join(' '),
    });
    const syncWrap = (kind) =>
        function (orig, [desc]) {
            const t = now();
            const p = orig.call(this, desc);
            P.events.push({
                type: kind,
                sync: true,
                label: desc.label || '',
                ...stageIds(desc),
                t,
                d: now() - t,
                stack: stack(),
            });
            return p;
        };
    const asyncWrap = (kind) =>
        function (orig, [desc]) {
            const t = now();
            const ev = {
                type: kind,
                sync: false,
                label: desc.label || '',
                ...stageIds(desc),
                t,
                inflight: P.pending,
                stack: stack(),
            };
            P.events.push(ev);
            P.pending++;
            return orig.call(this, desc).then(
                (r) => {
                    P.pending--;
                    ev.d = now() - t;
                    return r;
                },
                (e) => {
                    P.pending--;
                    ev.d = now() - t;
                    ev.error = String(e?.message || e).slice(0, 500);
                    throw e;
                },
            );
        };
    wrap(GPUDevice.prototype, 'createRenderPipeline', syncWrap('render'));
    wrap(GPUDevice.prototype, 'createComputePipeline', syncWrap('compute'));
    wrap(GPUDevice.prototype, 'createRenderPipelineAsync', asyncWrap('render'));
    wrap(GPUDevice.prototype, 'createComputePipelineAsync', asyncWrap('compute'));

    //* Queue submits — count + a cheap "GPU-process caught up" probe every 250 ms
    let submits = 0;
    wrap(GPUQueue.prototype, 'submit', function (orig, args) {
        submits++;
        if (!this.__probeArmed) {
            Object.defineProperty(this, '__probeArmed', { value: true });
            const q = this;
            const loop = () => {
                const t = now();
                q.onSubmittedWorkDone().then(() => {
                    const d = now() - t;
                    if (d > 50) P.events.push({ type: 'queueStall', t, d, submits });
                    setTimeout(loop, 250);
                });
            };
            setTimeout(loop, 250);
        }
        return orig.apply(this, args);
    });

    //* Main-thread rAF gaps (> 100 ms)
    let last = now();
    const tick = () => {
        const n = now();
        if (n - last > 100) P.gaps.push({ t: last, d: n - last });
        last = n;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
})();
