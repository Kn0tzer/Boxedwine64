// web/vkwebgpu.mjs — the BROWSER PAGE TIER for the vk64 trap boundary: the
// consumer for the FRAME-JSON manifest that source/vulkan/vk64bridge.cpp hops
// into the page at vkQueuePresentKHR (one MAIN_THREAD_EM_ASM per frame, JS body
// `window.bwVkFrame(UTF8ToString(ptr))`).
//
// WHAT IT DOES. parseManifest() decodes the manifest, web/shader.mjs translates
// the inline SPIR-V blobs to WGSL, and one WebGPU render pass replays the frame:
// uniform block @binding(0), combined image sampler split into texture @binding(1)
// + sampler @binding(2), a bgra8unorm offscreen colour target with depth24plus,
// the manifest's viewport / scissor / cull / front / depth state, and each
// vkCmdDraw as draw(vertexCount, 1, firstVertex, 0). The offscreen target is both
// copied to the page canvas and read back for the page-tier counters.
//
// This is host/p1render.mjs — the P1 reference consumer that rendered P1's
// vkcube frames — minus the node/playwright/file-IO half, wired to the live
// bridge's in-memory manifest instead of P1's sidecar .json/.bin/.spv tree.
//
// SPIR-V -> WGSL: the vendored in-page naga (web/vendor/naga = naga-wasm 30.2.0,
// the same wasm P1 used offline through parseSpirv/validate/writeWgsl) reached
// through the existing web/shader.mjs toWGSL('spirv', …) entry point, cached per
// SPIR-V hash so each guest module is translated once per page. web/naga-rt.mjs
// only lifts GLSL *source* (its whole contract is the guest shaderSource wrap),
// so it could not be reused for SPIR-V blobs; what is mirrored from it is the
// mechanism — a lazily imported page-tier module, a hash-keyed translate cache,
// and a translate that records a failure instead of throwing across the bridge's
// MAIN_THREAD_EM_ASM boundary.
//
// LIMITS (each one is counted, never thrown at the guest — see counters below):
//   * naga's SPIR-V front end rejects vkcube's cube.frag (glslang SPIR-V 1.0,
//     OpTypeSampledImage) with `error: InvalidId(40)`. p1render.mjs hit exactly
//     the same wall and shipped a hand-written equivalent instead; that WGSL is
//     vendored below under FS_OVERRIDES, keyed on the host-computed SPIR-V hash
//     (88f8a5cebeefd8c1 at 1280 bytes = cube.frag), so it can only ever be used
//     for that one blob. Any other fragment module must translate or the frame
//     is counted in `rejects` and nothing is drawn.
//   * One descriptor-set layout: binding 0 uniform (vertex), binding 1 sampled 2D
//     texture + binding 2 sampler (fragment). Multiple sets, push constants,
//     storage images, input attachments and compute are not modelled.
//   * The guest may bind a uniform range smaller than the shader's declared block
//     (vkfixture binds 128 bytes against cube.vert's 1216-byte block). WebGPU
//     reports that through an error scope rather than by throwing, so the range is
//     grown in powers of two — zero-padded, since WebGPU buffers start zeroed —
//     until the bind group validates; the working size is cached per vertex hash.
//   * A manifest with `overflow` (100000+ recorded commands) is rejected rather
//     than rendered, the same discipline web/webgpu.mjs applies.
//   * Y orientation: Vulkan and WebGPU viewports share the top-left framebuffer
//     origin, so the manifest's viewport/scissor go to setViewport/setScissorRect
//     verbatim with no flip. That is P1's proven behaviour; do not "fix" it.
//
// Exposed for the page tier (window.bwVkFrame is wired in web/runtime.html, the
// 'vk' message branch in web/app.mjs): installVkPageTier() and createVkRenderer().
import { toWGSL } from './shader.mjs';

export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024; // a frame's JSON + inline payloads
export const MAX_DIMENSION = 8192;
export const MAX_DRAWS = 4096;
export const MAX_UNIFORM_RANGE = 65536;            // guaranteed maxUniformBufferBindingSize

// Vulkan enums, mapped once (the numeric tables are P1's, host/p1render.mjs).
const FILTER = { 0: 'nearest', 1: 'linear' };
const ADDR = { 0: 'repeat', 1: 'mirror-repeat', 2: 'clamp-to-edge', 3: 'clamp-to-edge' };
const DEPTH_OP = { 0: 'never', 1: 'less', 2: 'equal', 3: 'less-equal', 4: 'greater', 5: 'not-equal', 6: 'greater-equal', 7: 'always' };
const CULL = { 0: 'none', 1: 'front', 2: 'back' };
const FRONT = { 0: 'ccw', 1: 'cw' };
const TEX_FORMAT = {
  R8G8B8A8_UNORM: 'rgba8unorm', R8G8B8A8_SRGB: 'rgba8unorm-srgb',
  B8G8R8A8_UNORM: 'bgra8unorm', B8G8R8A8_SRGB: 'bgra8unorm-srgb',
};

// P1's hand-written fragment stage for cube.frag (host/p1render.mjs), vendored so
// the one fragment module naga cannot parse still renders. Keyed on the SPIR-V
// hash the bridge computes over the module bytes PLUS the module size, so a
// different module can never pick this up by hash collision alone.
const FS_OVERRIDES = new Map([['88f8a5cebeefd8c1:1280', `
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct FSIn { @location(0) texcoord: vec4f, @location(1) frag_pos: vec3f };
const lightDir = vec3f(0.424, 0.566, 0.707);
fn linearToSrgb(x: f32) -> f32 {
  if (x <= 0.0031308) { return x * 12.92; }
  return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
@fragment fn main(in: FSIn) -> @location(0) vec4f {
  let dX = dpdx(in.frag_pos);
  let dY = dpdy(in.frag_pos);
  let normal = normalize(cross(dX, dY));
  let light = max(0.0, dot(lightDir, normal));
  let t = textureSample(tex, samp, in.texcoord.xy);
  let lt = light * t;
  return vec4f(linearToSrgb(lt.r), linearToSrgb(lt.g), linearToSrgb(lt.b), lt.a);
}`]]);

// ---------------------------------------------------------------------------
// Manifest decoding. The host's serializer leaves the `vs`/`fs` wrapper objects
// unterminated after their inline `spv` blob (`jsonBlob(...); j += ","`), so the
// manifest arrives one or two braces short of valid JSON today. parseManifest
// repairs exactly those two sites — and only when the brace count says they are
// genuinely open, which makes the repair a no-op the moment the host closes them.
// ---------------------------------------------------------------------------
function openDepthOutsideStrings(text, end) {
  let depth = 0, inString = false, escaped = false;
  for (let i = 0; i < end; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

function closeUnterminatedShaderObjects(text) {
  let out = text;
  for (const key of ['"fs":', '"ubo":']) {
    const at = out.indexOf(key);
    if (at < 0 || out[at - 1] !== ',') continue;   // not a sibling member, nothing to close
    if (openDepthOutsideStrings(out, at - 1) > 1) out = out.slice(0, at - 1) + '}' + out.slice(at - 1);
  }
  return out;
}

export function parseManifest(text) {
  if (typeof text !== 'string') throw new Error('vk64: frame manifest is not a string');
  if (!text.length || text.length > MAX_MANIFEST_BYTES) throw new Error('vk64: frame manifest size out of range');
  let json = text;
  try {
    json = JSON.parse(text);
  } catch (first) {
    json = null;
    const repaired = closeUnterminatedShaderObjects(text);
    if (repaired !== text) { try { json = JSON.parse(repaired); } catch { /* fall through */ } }
    if (!json) throw new Error('vk64: frame manifest is not valid JSON (' + (first.message || first) + ')');
  }
  return decodeManifest(json);
}

const fail = why => { throw new Error('vk64: malformed frame manifest (' + why + ')'); };
const num = (v, why) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(why); return v; };
const int = (v, why) => { num(v, why); if (!Number.isInteger(v)) fail(why); return v; };
const unit = (v, why) => Math.min(1, Math.max(0, num(v, why)));

function decodeManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('not an object');
  if (m.overflow) throw new Error('vk64: frame manifest overflowed the guest command limit');
  const width = int(m.width, 'width'), height = int(m.height, 'height');
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) fail('frame size');
  const clear = Array.isArray(m.clearColor) && m.clearColor.length === 4 ? m.clearColor : null;
  if (!clear) fail('clearColor');
  clear.forEach((c, i) => num(c, 'clearColor[' + i + ']'));
  const viewport = Array.isArray(m.viewport) && m.viewport.length === 6 ? m.viewport.map(Number) : [0, 0, width, height, 0, 1];
  viewport.forEach((v, i) => num(v, 'viewport[' + i + ']'));
  const scissor = Array.isArray(m.scissor) && m.scissor.length === 4
    ? m.scissor.map(v => Math.round(num(v, 'scissor'))) : [0, 0, width, height];
  const [sx, sy, sw, sh] = scissor;
  if (sw < 0 || sh < 0 || sx < 0 || sy < 0 || sx + sw > width || sy + sh > height) fail('scissor out of bounds');
  const draws = Array.isArray(m.draws) ? m.draws : fail('draws');
  if (draws.length > MAX_DRAWS) throw new Error('vk64: frame manifest exceeds the page-tier draw limit');
  const sampler = m.sampler && typeof m.sampler === 'object' ? m.sampler : {};
  const tex = m.texture && typeof m.texture === 'object' ? m.texture : null;
  const tw = tex ? int(tex.w, 'texture.w') : 0, th = tex ? int(tex.h, 'texture.h') : 0;
  if (tw < 0 || th < 0 || tw > MAX_DIMENSION || th > MAX_DIMENSION) fail('texture size');
  return {
    frame: int(m.frame ?? 0, 'frame'),
    width, height,
    colorFormat: typeof m.colorFormat === 'string' ? m.colorFormat : 'UNKNOWN',
    clear: clear.map(unit),
    clearDepth: unit(m.clearDepth ?? 1, 'clearDepth'),
    viewport, scissor,
    cull: CULL[m.cull] || 'none',
    front: FRONT[m.front] || 'ccw',
    depthTest: m.depthTest !== 0,
    depthWrite: !!m.depthWrite && m.depthTest !== 0,   // Vulkan: no depth test => no depth writes
    depthOp: DEPTH_OP[m.depthOp] || 'less-equal',
    vs: decodeShader(m.vs, 'vs'),
    fs: decodeShader(m.fs, 'fs'),
    ubo: decodeBlob(m.ubo, 'ubo'),
    texture: tex ? { w: tw, h: th, format: TEX_FORMAT[tex.format] || 'rgba8unorm', pixels: decodeBlob(tex.pixels, 'texture.pixels') } : null,
    sampler: {
      mag: FILTER[sampler.mag] || 'nearest', min: FILTER[sampler.min] || 'nearest',
      mipmap: FILTER[sampler.mipmap] || 'nearest',
      addrU: ADDR[sampler.addrU] || 'clamp-to-edge', addrV: ADDR[sampler.addrV] || 'clamp-to-edge',
      maxAnisotropy: Math.max(1, Math.min(16, Math.round(Number(sampler.maxAniso) || 1))),
    },
    draws: draws.map(d => {
      const vertexCount = int(d?.vertexCount, 'draw.vertexCount'), firstVertex = int(d?.firstVertex ?? 0, 'draw.firstVertex');
      if (vertexCount < 0 || vertexCount > 1 << 20 || firstVertex < 0) fail('draw range');
      return { vertexCount, firstVertex };
    }),
  };
}

function decodeShader(s, which) {
  if (s === null || s === undefined) return null;             // a null stage is legal in the schema
  const code = decodeBlob(s.spv, which + '.spv');
  if (!code) return null;
  return { hash: typeof s.hash === 'string' ? s.hash : '', size: code.length, code };
}

function decodeBlob(blob, which) {
  if (!blob || typeof blob !== 'object' || typeof blob.b64 !== 'string') return null;
  if (blob.b64.length > MAX_MANIFEST_BYTES) throw new Error('vk64: frame manifest blob out of range (' + which + ')');
  const bytes = b64ToBytes(blob.b64);
  if (blob.size !== undefined && int(blob.size, which + '.size') !== bytes.length) fail(which + ' size does not match its payload');
  return bytes;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// SPIR-V -> WGSL, cached per module (hash:size). Never throws: a module naga
// rejects without an override is reported and the frame is not drawn, because
// this runs under the bridge's MAIN_THREAD_EM_ASM call.
// ---------------------------------------------------------------------------
/**
 * @param {{translate?: (from: string, source: Uint8Array, stage: string, entryPoint?: string, options?: {rasterTopology?: number}) => Promise<string>, log?: (msg: string) => void}} [options]
 */
export function createShaderCache({ translate = toWGSL, log = defaultLog } = {}) {
  const wgsl = new Map();      // key -> WGSL
  const stats = { translated: 0, overridden: 0, rejected: 0, hits: 0 };
  return {
    stats,
    async get(stage, mod, options = {}) {
      if (!mod) return null;
      // Specialization values are part of the cache key: the same SPIR-V
      // module with different spec constants produces different WGSL.
      const specKey = (options.specOverrides || []).map(e => e.constantID + ':' + Array.from(e.value).join(',')).join(';');
      const key = stage + ':' + mod.hash + ':' + mod.size + ':topology:' + (options.rasterTopology ?? 'unknown') + ':spec:' + specKey;
      if (wgsl.has(key)) { stats.hits++; return wgsl.get(key); }
      const override = FS_OVERRIDES.get(mod.hash + ':' + mod.size);
      if (override) { wgsl.set(key, override); stats.overridden++; return override; }
      try {
        const code = String(await translate('spirv', mod.code, stage, 'main', options) ?? '');
        if (!code) throw new Error('empty translation');
        wgsl.set(key, code); stats.translated++;
        return code;
      } catch (e) {
        stats.rejected++;
        log('vk64: page tier cannot translate the ' + stage + ' SPIR-V module (' + (e.message || e) + ') — frame skipped');
        return null;
      }
    },
  };
}

function defaultLog(msg) {
  try { (globalThis.console && console.warn || (() => {}))(msg); } catch { /* logging must never throw */ }
  try { if (typeof globalThis.bwRuntimeLog === 'function') globalThis.bwRuntimeLog(msg); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// createVkRenderer — web/webgpu.mjs:80 createRenderer's shape (adapter -> device
// -> persistent offscreen colour+depth -> per-key pipeline cache ->
// queue.onSubmittedWorkDone() for buffer release) generalised from the
// fixed-function GL subset to the Vulkan frame schema.
// ---------------------------------------------------------------------------
/**
 * @param {HTMLCanvasElement} canvas
 * @param {{translate?: (from: string, source: Uint8Array, stage: string, entryPoint?: string, options?: {rasterTopology?: number}) => Promise<string>, log?: (msg: string) => void}} [options]
 */
export async function createVkRenderer(canvas, { translate, log = defaultLog } = {}) {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', e => log('vk64: page tier WebGPU error: ' + (e.error?.message || e.error)));
  device.lost.then(info => errors.push('Device lost: ' + info.reason + ' ' + info.message));

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('No WebGPU canvas context');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });

  const shaders = createShaderCache({ translate, log });
  const pipelines = new Map();     // pipeline key -> GPURenderPipeline
  const uniformSize = new Map();   // vs hash -> working uniform range
  const live = [];                 // buffers released after the frame's work is done
  const stats = {
    frames: 0, rendered: 0, skips: 0,
    litPixels: 0, paintedPixels: 0, totalPixels: 0, width: 0, height: 0,
  };
  const snapshot = () => ({ ...stats, ...shaders.stats });
  let color = null, depth = null, w = 0, h = 0, destroyed = false;

  function ensureTargets(width, height) {
    if (width === w && height === h && color) return;
    w = width; h = height;
    canvas.width = w; canvas.height = h;
    color?.destroy(); depth?.destroy();
    color = device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    depth = device.createTexture({ size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  // The guest may bind a uniform range smaller than the block its vertex module
  // declares (vkfixture binds 128 bytes against cube.vert's 1216-byte block).
  // WebGPU reports that mismatch only at Draw-encoding time, through an error
  // scope, and never states the size it wants, so the range is grown in powers of
  // two — zero-padded, since WebGPU buffers start zeroed — until the frame
  // validates. The working size is cached per vertex module, so this costs one
  // retry, once, for a guest whose descriptor stays undersized.
  const UNIFORM_TOO_SMALL = /too small|requires a buffer binding which is at least/i;

  async function encodeFrame(man, pipeline, bgl, uniform, texView, sampler) {
    const buffer = device.createBuffer({ size: uniform, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (man.ubo && man.ubo.length) device.queue.writeBuffer(buffer, 0, man.ubo);
    const group = device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer } },
      { binding: 1, resource: texView },
      { binding: 2, resource: sampler } ] });
    device.pushErrorScope('validation');
    const encoder = device.createCommandEncoder();
    /** @type {GPURenderPassDescriptor} */
    const descriptor = man.depthTest
      ? { colorAttachments: [{ view: color.createView(), clearValue: { r: man.clear[0], g: man.clear[1], b: man.clear[2], a: man.clear[3] }, loadOp: 'clear', storeOp: 'store' }],
          depthStencilAttachment: { view: depth.createView(), depthClearValue: man.clearDepth, depthLoadOp: 'clear', depthStoreOp: 'store' } }
      : { colorAttachments: [{ view: color.createView(), clearValue: { r: man.clear[0], g: man.clear[1], b: man.clear[2], a: man.clear[3] }, loadOp: 'clear', storeOp: 'store' }] };
    const pass = encoder.beginRenderPass(descriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    const [vx, vy, vw, vh, vmin, vmax] = man.viewport;
    const [sx, sy, sw, sh] = man.scissor;
    pass.setViewport(vx, vy, vw, vh, vmin, vmax);
    pass.setScissorRect(sx, sy, sw, sh);
    for (const d of man.draws) if (d.vertexCount > 0) pass.draw(d.vertexCount, 1, d.firstVertex, 0);
    pass.end();
    // Readback of the offscreen target (COPY_SRC), padded to the 256-byte copy row
    // alignment like P1's consumer, then the present copy to the page canvas.
    const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
    const readback = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture: color }, { buffer: readback, bytesPerRow }, [w, h]);
    encoder.copyTextureToTexture({ texture: color }, { texture: context.getCurrentTexture() }, [w, h]);
    device.queue.submit([encoder.finish()]);
    return { invalid: await device.popErrorScope(), buffer, readback, bytesPerRow };
  }

  async function render(text) {
    if (destroyed) throw new Error('page tier destroyed');
    const man = parseManifest(text);
    ensureTargets(man.width, man.height);

    const vsWgsl = await shaders.get('vertex', man.vs);
    const fsWgsl = await shaders.get('fragment', man.fs);
    if (!vsWgsl || !fsWgsl) { stats.skips++; return { rendered: false, reason: 'shader-translation' }; }
    const [vx, vy, vw, vh] = man.viewport;
    if (vw <= 0 || vh <= 0) { stats.skips++; return { rendered: false, reason: 'empty viewport' }; }

    const key = [vsWgsl.length, fsWgsl.length, man.cull, man.front, man.depthTest, man.depthWrite, man.depthOp].join(':');
    let pipeline = null, bgl = null;
    if (!pipelines.has(key)) {
      const vsModule = device.createShaderModule({ code: vsWgsl });
      const fsModule = device.createShaderModule({ code: fsWgsl });
      device.pushErrorScope('validation');
      bgl = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } } ] });
      pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex: { module: vsModule, entryPoint: 'main' },
        fragment: { module: fsModule, entryPoint: 'main', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: man.cull, frontFace: man.front },
        depthStencil: man.depthTest ? { format: 'depth24plus', depthWriteEnabled: man.depthWrite, depthCompare: man.depthOp } : undefined,
      });
      const err = await device.popErrorScope();
      if (err) throw new Error('render pipeline rejected: ' + err.message);
      pipelines.set(key, pipeline);
    } else {
      pipeline = pipelines.get(key);
      bgl = pipeline.getBindGroupLayout(0);
    }

    const sampler = device.createSampler({ magFilter: man.sampler.mag, minFilter: man.sampler.min,
      mipmapFilter: man.sampler.mipmap, addressModeU: man.sampler.addrU, addressModeV: man.sampler.addrV,
      maxAnisotropy: man.sampler.maxAnisotropy });
    const guestTexture = man.texture && man.texture.w > 0 && man.texture.h > 0;
    const tex = device.createTexture({ size: guestTexture ? [man.texture.w, man.texture.h] : [1, 1],
      format: man.texture?.format || 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    if (guestTexture && man.texture.pixels) {
      device.queue.writeTexture({ texture: tex }, man.texture.pixels,
        { bytesPerRow: man.texture.w * 4, rowsPerImage: man.texture.h }, [man.texture.w, man.texture.h]);
    } else if (!guestTexture) {
      // No image for the sampler this frame: a 1x1 transparent texture keeps the
      // bind group layout intact, so the draw still goes through.
      device.queue.writeTexture({ texture: tex }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
    }
    const texView = tex.createView();

    const uniformKey = man.vs?.hash || '';
    let uniform = Math.max(uniformSize.get(uniformKey) || 0, man.ubo ? man.ubo.length : 0, 256);
    let encoded = null;
    for (let tries = 0; tries <= 8; tries++) {
      encoded = await encodeFrame(man, pipeline, bgl, uniform, texView, sampler);
      if (!encoded.invalid) break;
      const grow = UNIFORM_TOO_SMALL.test(encoded.invalid.message) && uniform < MAX_UNIFORM_RANGE;
      encoded.buffer.destroy(); encoded.readback.destroy();
      if (!grow) break;
      uniform *= 2;
      uniformSize.set(uniformKey, uniform);
    }
    if (encoded.invalid) throw new Error('frame encoding rejected: ' + encoded.invalid.message);
    uniformSize.set(uniformKey, uniform);
    live.push(encoded.buffer, tex);

    // Pass encoding, the submit and the copies are validated asynchronously, so
    // the readback can only be trusted once the error scope came back clean.
    const { readback, bytesPerRow } = encoded;
    await readback.mapAsync(GPUMapMode.READ);
    const rows = new Uint8Array(readback.getMappedRange());
    const [r, g, b, a] = man.clear.map(c => Math.round(c * 255));
    const bgra = format.startsWith('bgra');
    // Two counters, because they answer different questions. painted = pixels the
    // pass actually wrote (a cleared frame region is non-empty but proves nothing
    // about rasterization); lit = pixels that differ from the manifest's clear
    // value, i.e. geometry that survived the pipeline.
    let lit = 0, painted = 0;
    for (let y = 0; y < h; y++) {
      const row = y * bytesPerRow;
      for (let x = 0; x < w; x++) {
        const i = row + x * 4;
        const pr = rows[i], pg = rows[i + 1], pb = rows[i + 2], pa = rows[i + 3];
        if (pr || pg || pb || pa) painted++;
        if (pr !== (bgra ? b : r) || pg !== g || pb !== (bgra ? r : b) || pa !== a) lit++;
      }
    }
    readback.unmap();
    readback.destroy();

    const release = () => { for (const b of live.splice(0)) b.destroy?.(); };
    device.queue.onSubmittedWorkDone().then(release, release);

    stats.frames++; stats.rendered++;
    stats.litPixels = lit; stats.paintedPixels = painted;
    stats.totalPixels = w * h; stats.width = w; stats.height = h;
    return { rendered: true, frame: man.frame, litPixels: lit, paintedPixels: painted,
      totalPixels: w * h, uniform, uboBytes: man.ubo ? man.ubo.length : 0, clear: man.clear };
  }

  return {
    render, errors, device, shaders, snapshot,
    stats,
    get frames() { return stats.rendered; },
    destroy() { destroyed = true; context.unconfigure(); color?.destroy(); depth?.destroy(); device.destroy(); },
  };
}

// ---------------------------------------------------------------------------
// installVkPageTier — the page-tier sink the bridge hops into. Serialises frames
// (the SPIR-V translate and the bind-group fit are async, and a guest can present
// again before the previous frame has finished), never throws back at the guest,
// and publishes counters for the gate probe via window.bwVkStats().
// ---------------------------------------------------------------------------
/**
 * @param {{canvas?: HTMLCanvasElement, log?: (msg: string) => void}} [options]
 */
export function installVkPageTier({ canvas, log = defaultLog } = {}) {
  if (globalThis.bwVkTier) return globalThis.bwVkTier;
  const state = { received: 0, rendered: 0, rejected: 0, errors: [], last: null,
    litPixels: 0, paintedPixels: 0, totalPixels: 0 };
  const stats = () => ({ ...state, errors: state.errors.slice(-8), pipeline: renderer?.snapshot() || null,
    v2: { ...v2state, queue: v2queue.size, pipeline2: renderer2?.snapshot() || null } });
  let renderer = null, pending = Promise.resolve(), starting = null;

  // --- schema v2 (binary framed records): streaming queue + render pump ---
  const v2queue = new V2FrameQueue(V2_QUEUE_CAP);
  const v2asm = new V2FrameAssembler();
  const v2state = { chunksReceived: 0, framesReceived: 0, rendered: 0,
    droppedConsumer: 0, chunkGaps: 0, rejected: 0 };
  let renderer2 = null, starting2 = null, pump2 = Promise.resolve();
  // Pump debouncing: the bridge hops every queued frame's chunks on present
  // (intermediate renders + the presented frame) via separate proxied calls
  // that may be interleaved with event-loop turns. A setTimeout(0) is not
  // enough: the timer can fire before the present batch's later chunks arrive
  // (worker postMessage ordering), rendering a stale intermediate frame and
  // thrashing the canvas size every present. Debounce 8ms so takeLatest()
  // sees the full present batch and keeps only the presented frame.
  let pumpTimer = null;
  function queuePump() {
    if (pumpTimer) clearTimeout(pumpTimer);
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump2 = pump2.then(() => pumpChunks());
    }, 8);
  }

  // Canvas-resize hook: frames recorded at the old size would misconfigure
  // the targets, so the queue drains and the targets are invalidated; the
  // next frame re-creates them at the new size.
  function v2Resize() {
    v2queue.clear();
    try { renderer2?.invalidateTargets(); } catch { /* never throw at the observer */ }
  }

  async function frame(json) {
    state.received++;
    try {
      if (!renderer) {
        // WebGPU setup is deferred to the first frame so importing this module (and
        // its naga wasm, which shader.mjs initialises on the first translate) costs
        // nothing for a guest that never presents a frame.
        starting ||= createVkRenderer(canvas || defaultCanvas(), { log }).then(r => {
          renderer = r; globalThis.bwVkRenderer = r;
          return r;
        });
        await starting;
      }
      const result = await renderer.render(typeof json === 'string' ? json : JSON.stringify(json));
      state.last = result?.rendered ? result : { rendered: false, reason: result?.reason || 'skipped' };
      if (result?.rendered) {
        state.rendered++;   // a frame that was skipped (e.g. untranslatable SPIR-V) is not rendered
        state.litPixels = result.litPixels; state.paintedPixels = result.paintedPixels;
        state.totalPixels = result.totalPixels;
      }
      return result;
    } catch (e) {
      state.rejected++;
      state.errors.push(String(e.message || e));
      log('vk64: page tier frame rejected — ' + (e.message || e));
      return { rendered: false, reason: String(e.message || e) };
    }
  }

  async function pumpChunks() {
    if (!renderer2) {
      starting2 ||= createVkRenderer2(canvas || defaultCanvas(), { log, onResize: v2Resize }).then(r => {
        renderer2 = r; globalThis.bwVkRenderer2 = r;
        return r;
      });
      await starting2;
    }
    const f = v2queue.takeLatest(); // latest-frame-wins: the guest presenting
    if (!f) return { rendered: false, reason: 'empty' }; // faster than the page renders never builds a backlog
    try {
      const result = await renderer2.render(f);
      if (result?.rendered) {
        v2state.rendered++;
        state.last = result;
        state.litPixels = result.litPixels; state.paintedPixels = result.paintedPixels;
        state.totalPixels = result.totalPixels;
      } else {
        v2state.rejected++;
      }
      return result;
    } catch (e) {
      v2state.rejected++;
      state.errors.push('v2: ' + String(e.message || e));
      log('vk64: v2 page tier frame rejected \u2014 ' + (e.message || e));
      return { rendered: false, reason: String(e.message || e) };
    }
  }

  // The wasm hop's window.bwVkChunk entry point (one call per chunk). Parsing
  // and queueing are synchronous; the render pump is serialised behind pump2.
  // Never throws back at the guest.
  function chunk(bytes, flags) {
    void flags;
    v2state.chunksReceived++;
    let parsed;
    try { parsed = parseV2Chunk(bytes); }
    catch (e) {
      v2state.rejected++;
      state.errors.push('v2 chunk: ' + String(e.message || e));
      log('vk64: v2 chunk rejected \u2014 ' + (e.message || e));
      return Promise.resolve({ rendered: false, reason: 'bad-chunk' });
    }
    const recs = v2asm.ingest(parsed);
    v2state.chunkGaps = v2asm.gaps;
    if (!recs) return Promise.resolve({ rendered: false, reason: 'assembling' });
    let decoded;
    try { decoded = decodeV2Frame(recs); }
    catch (e) {
      v2state.rejected++;
      state.errors.push('v2 frame: ' + String(e.message || e));
      log('vk64: v2 frame rejected \u2014 ' + (e.message || e));
      return Promise.resolve({ rendered: false, reason: String(e.message || e) });
    }
    v2state.framesReceived++;
    v2queue.push(decoded); // drop-oldest past V2_QUEUE_CAP
    v2state.droppedConsumer = v2queue.dropped;
    queuePump();
    return pump2;
  }

  function defaultCanvas() {
    const el = document.createElement('canvas');
    el.id = 'vkCanvas';
    (document.getElementById('display') || document.body).append(el);
    return el;
  }

  const tier = {
    frame(json) { pending = pending.then(() => frame(json)); return pending; },
    chunk,
    stats,
    get ready() { return !!renderer; },
    get litPixels() { return state.litPixels; },
  };
  globalThis.bwVkTier = tier;
  globalThis.bwVkStats = stats;
  return tier;
}
// ===========================================================================
// Schema v2 — binary framed records (tasks/schema-v2.md §2-3). The v1 JSON
// manifest (parseManifest/createVkRenderer above) is vkcube-shaped: one frame
// per submit, vs+fs only, a single descriptor set, no push constants, no
// MSAA. Real D3D9 apps via DXVK submit continuously with N descriptor sets,
// push constants per draw, indexed draws and multisampled targets; one giant
// JSON per submit cannot keep up, so v2 streams binary records.
//
// WIRE. The wasm side hops one MAIN_THREAD_EM_ASM per CHUNK (1 MiB cap); the
// JS body receives (ptr, len, flags), copies the bytes once, and calls
// window.bwVkChunk(bytes, flags). No UTF-8 decode, no JSON.parse, no base64:
// chunk header (16 B: u32 magic 'VK2F', u16 version=2, u16 flags bit0=MORE,
// u32 seq) followed by records (8 B header: u16 type, u16 rflags, u32 len +
// payload). Records never straddle chunks. BW64_VKSCHEMA=1 keeps the v1 path;
// the page needs no sniffing because v1 arrives at window.bwVkFrame and v2 at
// window.bwVkChunk.
//
// BACKPRESSURE. Neither queue ever blocks the guest. Producer (wasm): a deque
// of complete frames capped at 8 chunks, drop-oldest-complete-frame. Consumer
// (page): V2FrameQueue, cap 3 complete frames, drop-oldest on push; the render
// pump takes the newest via takeLatest() and drops everything older —
// latest-frame-wins. Producer drops are host-side (klog); the page detects
// loss through chunkGaps on the chunk sequence.
//
// DISCIPLINE. Like the v1 tier: malformed input is counted and the frame is
// skipped, never thrown back at the guest (the hop runs on the guest's
// present path).
// ===========================================================================

export const V2_MAGIC = 0x46324B56; // 'VK2F' little-endian (bytes 56 4B 32 46)
export const V2_VERSION = 2;
export const V2_FLAG_MORE = 0x1;
export const V2_CHUNK_HEADER_LEN = 16;
export const V2_REC_HEADER_LEN = 8;
export const V2_MAX_CHUNK_BYTES = 4 * 1024 * 1024; // ingest sanity cap (writer caps at 1 MiB)
export const V2_MAX_RECORD_BYTES = 256 * 1024 * 1024;
export const V2_MAX_FRAME_RECORDS = 1 << 20;
export const V2_PUSH_GROUP = 3;      // reserved group for the push-constant UBO
export const V2_PUSH_BINDING = 0;
export const V2_PUSH_SIZE = 256;     // == VK64_MAX_PUSH_BYTES on the host
export const V2_QUEUE_CAP = 3;       // consumer frames: latest-frame-wins
export const V2_MAX_SETS = 8;

export const V2_REC = Object.freeze({
  FRAME_BEGIN: 0x01, FRAME_END: 0x02, RP_BEGIN: 0x03, RP_END: 0x04,
  SHADER: 0x05, PIPELINE: 0x06, BIND_SETS: 0x07, DESC_SET: 0x08,
  BUFFER_DATA: 0x09, IMAGE_DATA: 0x0A, SAMPLER: 0x0B, PUSH: 0x0C,
  VIEWPORT: 0x0D, SCISSOR: 0x0E, VERTEX_BIND: 0x0F, INDEX_BIND: 0x10,
  DRAW: 0x11, INLINE_BYTES: 0x12,
});

// Vulkan descriptor types (numeric, as the bridge records them).
const DT_COMBINED_IMAGE_SAMPLER = 1, DT_SAMPLER = 0;

class V2Reader {
  constructor(payload) {
    this.dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    this.p = 0;
  }
  get left() { return this.dv.byteLength - this.p; }
  need(n, what) { if (this.left < n) throw new Error('vk64: v2 ' + what + ' truncated'); }
  u8() { this.need(1, 'u8'); return this.dv.getUint8(this.p++); }
  u16() { this.need(2, 'u16'); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u32() { this.need(4, 'u32'); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  u64() { this.need(8, 'u64'); const v = this.dv.getBigUint64(this.p, true); this.p += 8; return v; }
  f32() { this.need(4, 'f32'); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  bytes(n) {
    this.need(n, 'bytes(' + n + ')');
    const v = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.p, n);
    this.p += n; return v;
  }
  skip(n) { this.need(n, 'skip'); this.p += n; }
  done(what) {
    if (this.p !== this.dv.byteLength)
      throw new Error('vk64: v2 ' + what + ' has ' + (this.dv.byteLength - this.p) + ' trailing bytes');
  }
}

// The host prints hashes with %016llx; reproduce that exactly so the v1
// FS_OVERRIDES keys and the shader cache keep working for v2 modules.
export const v2Hex64 = h => h.toString(16).padStart(16, '0');

// ---------------------------------------------------------------------------
// Chunk framing: parseV2Chunk validates the header and splits the records.
// Throws (counted by the caller) on bad magic/version, truncation, or an
// unknown record type. Never touches the payloads.
// ---------------------------------------------------------------------------
export function parseV2Chunk(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('vk64: v2 chunk is not bytes');
  if (bytes.length < V2_CHUNK_HEADER_LEN || bytes.length > V2_MAX_CHUNK_BYTES)
    throw new Error('vk64: v2 chunk size out of range (' + bytes.length + ')');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== V2_MAGIC) throw new Error('vk64: v2 chunk bad magic');
  const version = dv.getUint16(4, true);
  if (version !== V2_VERSION) throw new Error('vk64: v2 chunk version ' + version + ' (want 2)');
  const flags = dv.getUint16(6, true);
  const seq = dv.getUint32(8, true);
  const records = [];
  let p = V2_CHUNK_HEADER_LEN;
  while (p < bytes.length) {
    if (p + V2_REC_HEADER_LEN > bytes.length) throw new Error('vk64: v2 chunk truncated record header');
    const type = dv.getUint16(p, true);
    const len = dv.getUint32(p + 4, true);
    if (type < V2_REC.FRAME_BEGIN || type > V2_REC.INLINE_BYTES)
      throw new Error('vk64: v2 unknown record type 0x' + type.toString(16));
    if (len > V2_MAX_RECORD_BYTES || p + V2_REC_HEADER_LEN + len > bytes.length)
      throw new Error('vk64: v2 record 0x' + type.toString(16) + ' truncated (len ' + len + ')');
    records.push({ type, payload: new Uint8Array(bytes.buffer, bytes.byteOffset + p + V2_REC_HEADER_LEN, len) });
    p += V2_REC_HEADER_LEN + len;
  }
  return { flags, seq, more: (flags & V2_FLAG_MORE) !== 0, records };
}

// ---------------------------------------------------------------------------
// V2FrameAssembler — feeds parsed chunks, emits a complete record list when a
// FRAME_END seals a frame. A sequence gap (or a second FRAME_BEGIN) drops the
// partial frame: a half frame is unrenderable, and the guest keeps presenting
// behind us. gaps/droppedPartials feed window.bwVkStats().
// ---------------------------------------------------------------------------
export class V2FrameAssembler {
  constructor() { this.records = []; this.inFrame = false; this.lastSeq = -1; this.gaps = 0; this.droppedPartials = 0; }
  ingest(chunk) {
    if (this.lastSeq >= 0 && chunk.seq !== ((this.lastSeq + 1) >>> 0)) {
      this.gaps++;
      if (this.inFrame) this.droppedPartials++;
      this.records = []; this.inFrame = false;
    }
    this.lastSeq = chunk.seq;
    let frame = null;
    for (const r of chunk.records) {
      if (r.type === V2_REC.FRAME_BEGIN) {
        if (this.inFrame) this.droppedPartials++;
        this.records = [r]; this.inFrame = true;
      } else if (!this.inFrame) {
        continue; // stray record outside a frame (e.g. after a gap) — ignore
      } else {
        this.records.push(r);
        if (this.records.length > V2_MAX_FRAME_RECORDS) {
          this.records = []; this.inFrame = false; this.droppedPartials++;
          break;
        }
        if (r.type === V2_REC.FRAME_END) { frame = this.records; this.records = []; this.inFrame = false; }
      }
    }
    return frame;
  }
}

// ---------------------------------------------------------------------------
// V2FrameQueue — the consumer-side backpressure. Cap 3 complete frames;
// push() drops the oldest past the cap; takeLatest() returns the newest and
// drops everything older (latest-frame-wins); clear() drains (resize hook).
// ---------------------------------------------------------------------------
export class V2FrameQueue {
  constructor(cap = V2_QUEUE_CAP) { this.cap = cap; this.q = []; this.dropped = 0; }
  get size() { return this.q.length; }
  push(frame) {
    this.q.push(frame);
    while (this.q.length > this.cap) { this.q.shift(); this.dropped++; }
  }
  takeLatest() {
    if (!this.q.length) return null;
    const f = this.q[this.q.length - 1];
    this.q.length = 0;
    return f;
  }
  clear() { this.q.length = 0; }
}

// ---------------------------------------------------------------------------
// Format maps. VkFormat numbers are the real ones (source/vulkan/vk64_guest.h);
// an unmapped format falls back to rgba8unorm and is counted, never thrown.
// ---------------------------------------------------------------------------
const V2_TEX_FORMAT = {
  37: 'rgba8unorm', 43: 'rgba8unorm-srgb', 44: 'bgra8unorm', 50: 'bgra8unorm-srgb',
  9: 'r8unorm', 16: 'rg8unorm', 41: 'rgba8uint', 64: 'rgb10a2unorm', 122: 'rg11b10ufloat',
  100: 'r32float', 109: 'rgba32float',
  124: 'depth16unorm', 126: 'depth32float', 129: 'depth24plus-stencil8', 130: 'depth32float-stencil8',
};
export function v2TextureFormat(vkFormat, counters) {
  const f = V2_TEX_FORMAT[vkFormat];
  if (!f && counters) counters.unknownFormats = (counters.unknownFormats || 0) + 1;
  return f || 'rgba8unorm';
}
const V2_VERT_FORMAT = {
  100: 'float32', 103: 'float32x2', 106: 'float32x3', 109: 'float32x4',
  37: 'unorm8x4', 16: 'unorm8x2', 64: 'unorm10-10-10-2',
  83: 'float16x2', 97: 'float16x4', 77: 'unorm16x2', 91: 'unorm16x4',
  // 44 = VK_FORMAT_B8G8R8A8_UNORM. WebGPU has no BGRA vertex format; map to
  // unorm8x4 and swizzle R/B in the uploaded bytes (swizzleBgraVb), so the
  // shader sees Vulkan's component order.
  44: 'unorm8x4',
};
// Byte size of each V2_VERT_FORMAT entry, for minimum-stride computation.
const V2_VERT_FORMAT_SIZE = {
  'float32': 4, 'float32x2': 8, 'float32x3': 12, 'float32x4': 16,
  'unorm8x2': 2, 'unorm8x4': 4, 'unorm10-10-10-2': 4,
  'float16x2': 4, 'float16x4': 8, 'unorm16x2': 4, 'unorm16x4': 8,
};
export function v2VertexFormat(vkFormat) { return V2_VERT_FORMAT[vkFormat] || null; }
const V2_TOPOLOGY = { 0: 'point-list', 1: 'line-list', 2: 'line-strip', 3: 'triangle-list', 4: 'triangle-strip' };

// ---------------------------------------------------------------------------
// decodeV2Frame — validates a sealed record list into the renderable frame
// model. Resources (shaders, pipelines, buffers, images, samplers) are
// frame-level maps; state ops nest inside the render-pass graph
// (RP_BEGIN..RP_END). Throws with a reason on any structural problem.
// ---------------------------------------------------------------------------
export function decodeV2Frame(records, counters = {}) {
  void counters;
  if (!Array.isArray(records) || !records.length || records[0].type !== V2_REC.FRAME_BEGIN)
    throw new Error('vk64: v2 frame does not start with FRAME_BEGIN');
  const last = records[records.length - 1];
  if (last.type !== V2_REC.FRAME_END) throw new Error('vk64: v2 frame does not end with FRAME_END');

  const h0 = new V2Reader(records[0].payload);
  const frameNo = h0.u32(), width = h0.u32(), height = h0.u32(), flags = h0.u32();
  h0.done('FRAME_BEGIN');
  if (flags & 1) throw new Error('vk64: v2 frame overflowed the guest command limit');
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION)
    throw new Error('vk64: v2 frame size out of range');
  const h1 = new V2Reader(last.payload);
  const endNo = h1.u32(); h1.done('FRAME_END');
  if (endNo !== frameNo) throw new Error('vk64: v2 FRAME_BEGIN/FRAME_END number mismatch');

  const frame = {
    frameNo, width, height, passes: [],
    shaders: new Map(), pipelines: new Map(), buffers: new Map(),
    images: new Map(), views: new Map(), samplers: new Map(),
  };
  const implicitPass = () => ({
    rpId: '0', fbId: '0', w: width, h: height, attachments: [],
    clearColor: [0, 0, 0, 1], clearDepth: 1, clearStencil: 0, ops: [],
  });
  let pass = null;
  const needPass = () => pass || (pass = frame.passes[frame.passes.push(implicitPass()) - 1]);
  let draws = 0;

  for (let i = 1; i < records.length - 1; i++) {
    const { type, payload } = records[i];
    const r = new V2Reader(payload);
    switch (type) {
      case V2_REC.RP_BEGIN: {
        const rpId = v2Hex64(r.u64()), fbId = v2Hex64(r.u64());
        const w = r.u32(), h = r.u32(), natt = r.u32();
        if (natt > 8) throw new Error('vk64: v2 RP_BEGIN attachment count out of range');
        const attachments = [];
        for (let a = 0; a < natt; a++) {
          attachments.push({ format: r.u32(), loadOp: r.u32(), storeOp: r.u32(), samples: r.u32(), isDepth: r.u32() });
        }
        const clearColor = [r.f32(), r.f32(), r.f32(), r.f32()];
        const clearDepth = r.f32(), clearStencil = r.u32();
        // Attachment identity tail: one {viewId, imageId} u64 pair per
        // attachment, in attachment order. The image identity links render
        // attachments to the sampled-image aliases in frame.views.
        for (let a = 0; a < natt; a++) {
          attachments[a].viewId = v2Hex64(r.u64());
          attachments[a].imageId = v2Hex64(r.u64());
        }
        r.done('RP_BEGIN');
        pass = { rpId, fbId, w, h, attachments, clearColor, clearDepth, clearStencil, ops: [] };
        frame.passes.push(pass);
        break;
      }
      case V2_REC.RP_END: r.done('RP_END'); pass = null; break;
      case V2_REC.SHADER: {
        const stage = r.u8(); r.skip(3);
        const hash = v2Hex64(r.u64());
        const codeLen = r.u32();
        const code = r.bytes(codeLen); r.done('SHADER');
        if (stage > 1) throw new Error('vk64: v2 SHADER bad stage');
        if (!frame.shaders.has(hash)) frame.shaders.set(hash, { stage, code: code.slice() });
        break;
      }
      case V2_REC.PIPELINE: {
        const pipeId = v2Hex64(r.u64());
        const vsHash = v2Hex64(r.u64()), fsHash = v2Hex64(r.u64());
        const topology = r.u32(), cull = r.u32(), front = r.u32();
        const depthTest = r.u32(), depthWrite = r.u32(), depthOp = r.u32(), blend = r.u32();
        const nVb = r.u32(), nVa = r.u32();
        if (nVb > 4 || nVa > 16) throw new Error('vk64: v2 PIPELINE vertex layout out of range');
        const vb = [], va = [];
        for (let k = 0; k < nVb; k++) vb.push({ binding: r.u32(), stride: r.u32(), inputRate: r.u32() });
        for (let k = 0; k < nVa; k++) va.push({ location: r.u32(), binding: r.u32(), format: r.u32(), offset: r.u32() });
        // Append-only specialization tail (2026-10-06): per-stage list of
        // {constantID, size, value bytes}. Absent in frames from older bridges.
        const readSpec = () => {
          const n = r.u32();
          if (n > 16) throw new Error('vk64: v2 PIPELINE spec count out of range');
          const entries = [];
          for (let i = 0; i < n; i++) {
            const constantID = r.u32(), size = r.u32();
            if (size !== 1 && size !== 2 && size !== 4 && size !== 8)
              throw new Error('vk64: v2 PIPELINE spec size out of range');
            const value = r.bytes(size);
            entries.push({ constantID, size, value });
          }
          return entries;
        };
        let vsSpec = [], fsSpec = [];
        if (r.p < r.dv.byteLength) {
          vsSpec = readSpec();
          fsSpec = readSpec();
        }
        r.done('PIPELINE');
        const pipe = { pipeId, vsHash, fsHash, topology, cull, front, depthTest, depthWrite, depthOp, blend, vb, va, vsSpec, fsSpec };
        frame.pipelines.set(pipeId, pipe);
        needPass().ops.push({ op: 'bindPipe', pipe });
        break;
      }
      case V2_REC.BIND_SETS: {
        const firstSet = r.u8(), setCount = r.u8(); r.skip(2);
        if (firstSet + setCount > V2_MAX_SETS) throw new Error('vk64: v2 BIND_SETS out of range');
        const setIds = [];
        for (let k = 0; k < setCount; k++) setIds.push(v2Hex64(r.u64()));
        r.done('BIND_SETS');
        needPass().ops.push({ op: 'bindSets', firstSet, setIds });
        break;
      }
      case V2_REC.DESC_SET: {
        const setIndex = r.u8(), nBind = r.u8(); r.skip(2);
        const layoutId = v2Hex64(r.u64());
        if (setIndex >= V2_MAX_SETS || nBind > 8) throw new Error('vk64: v2 DESC_SET out of range');
        const bindings = [];
        for (let k = 0; k < nBind; k++) {
          bindings.push({
            binding: r.u32(), type: r.u32(), dstArrayElement: r.u32(), count: r.u32(),
            kind: r.u8(), _pad1: r.u8(), _pad2: r.u16(),
            obj: v2Hex64(r.u64()), range: v2Hex64(r.u64()),
            bufOff: r.u64().toString(),
          });
        }
        r.done('DESC_SET');
        needPass().ops.push({ op: 'descSet', setIndex, layoutId, bindings });
        break;
      }
      case V2_REC.BUFFER_DATA: {
        const bufId = v2Hex64(r.u64());
        const memOff = r.u64().toString();
        const len = r.u32();
        if (len > V2_MAX_RECORD_BYTES) throw new Error('vk64: v2 BUFFER_DATA len out of range');
        const bytes = r.bytes(len); r.done('BUFFER_DATA');
        // One VkBuffer may back several bindings at different offsets; key by
        // (id, offset). Keep the bare-id key (first record) for VB/IB lookups.
        const key = bufId + ':' + memOff;
        if (!frame.buffers.has(key)) frame.buffers.set(key, bytes.slice());
        if (!frame.buffers.has(bufId)) frame.buffers.set(bufId, bytes.slice());
        break;
      }
      case V2_REC.IMAGE_DATA: {
        const viewId = v2Hex64(r.u64()), imageId = v2Hex64(r.u64());
        const w = r.u32(), h = r.u32(), format = r.u32(), pixLen = r.u32();
        if (w > MAX_DIMENSION || h > MAX_DIMENSION || pixLen > V2_MAX_RECORD_BYTES)
          throw new Error('vk64: v2 IMAGE_DATA out of range');
        const pixels = r.bytes(pixLen); r.done('IMAGE_DATA');
        frame.views.set(viewId, imageId);
        if (!frame.images.has(imageId)) frame.images.set(imageId, { w, h, format, pixels: pixels.slice() });
        break;
      }
      case V2_REC.SAMPLER: {
        const id = v2Hex64(r.u64());
        const mag = r.u32(), min = r.u32(), mipmap = r.u32(), addrU = r.u32(), addrV = r.u32();
        const maxAniso = r.f32(); r.done('SAMPLER');
        frame.samplers.set(id, {
          mag: FILTER[mag] || 'nearest', min: FILTER[min] || 'nearest', mipmap: FILTER[mipmap] || 'nearest',
          addrU: ADDR[addrU] || 'clamp-to-edge', addrV: ADDR[addrV] || 'clamp-to-edge',
          maxAnisotropy: Math.max(1, Math.min(16, Math.round(maxAniso) || 1)),
        });
        break;
      }
      case V2_REC.PUSH: {
        const offset = r.u32(), size = r.u32();
        r.skip(4); // stageFlags (kept for debugging)
        if (offset + size > V2_PUSH_SIZE) throw new Error('vk64: v2 PUSH out of range');
        const bytes = r.bytes(size); r.done('PUSH');
        needPass().ops.push({ op: 'push', offset, bytes: bytes.slice() });
        break;
      }
      case V2_REC.VIEWPORT: {
        const v = [r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()]; r.done('VIEWPORT');
        needPass().ops.push({ op: 'viewport', v });
        break;
      }
      case V2_REC.SCISSOR: {
        const s = [r.u32(), r.u32(), r.u32(), r.u32()]; r.done('SCISSOR');
        needPass().ops.push({ op: 'scissor', s });
        break;
      }
      case V2_REC.VERTEX_BIND: {
        const nVb = r.u8(); r.skip(3);
        if (nVb > 4) throw new Error('vk64: v2 VERTEX_BIND out of range');
        const binds = [];
        for (let k = 0; k < nVb; k++) binds.push({ binding: r.u32(), buf: v2Hex64(r.u64()), offset: Number(r.u64()) });
        r.done('VERTEX_BIND');
        needPass().ops.push({ op: 'vbind', binds });
        break;
      }
      case V2_REC.INDEX_BIND: {
        const buf = v2Hex64(r.u64()), offset = Number(r.u64()), indexType = r.u32();
        r.done('INDEX_BIND');
        if (indexType > 1) throw new Error('vk64: v2 INDEX_BIND bad index type');
        needPass().ops.push({ op: 'ibind', buf, offset, indexType });
        break;
      }
      case V2_REC.DRAW: {
        const vertexCount = r.u32(), instanceCount = r.u32(), firstVertex = r.u32(), firstInstance = r.u32();
        const indexed = r.u8(); r.skip(3);
        const indexCount = r.u32(), firstIndex = r.u32(), vertexOffset = r.u32() | 0;
        r.done('DRAW');
        if (++draws > MAX_DRAWS) throw new Error('vk64: v2 frame exceeds the page-tier draw limit');
        if (vertexCount > 1 << 24 || indexCount > 1 << 24) throw new Error('vk64: v2 DRAW range out of range');
        needPass().ops.push({ op: 'draw', indexed: indexed !== 0, vertexCount, instanceCount, firstVertex, firstInstance, indexCount, firstIndex, vertexOffset });
        break;
      }
      case V2_REC.INLINE_BYTES: {
        const setIndex = r.u8(); r.skip(3);
        const binding = r.u32(), dstArrayElement = r.u32(), len = r.u32();
        if (len > V2_MAX_RECORD_BYTES) throw new Error('vk64: v2 INLINE_BYTES len out of range');
        const bytes = r.bytes(len); r.done('INLINE_BYTES');
        needPass().ops.push({ op: 'inline', setIndex, binding, dstArrayElement, bytes: bytes.slice() });
        break;
      }
      default:
        throw new Error('vk64: v2 decode hit unhandled record 0x' + type.toString(16));
    }
  }
  return frame;
}

// ---------------------------------------------------------------------------
// Push constants as a small UBO (tasks/schema-v2.md §5). naga's WGSL backend
// emits `var<immediate>` in 30.2.0 (older translations used
// `var<push_constant>`); this rewrites either declaration to a plain
// uniform at the reserved @group(3) @binding(0), and the renderer keeps one
// 256-byte uniform buffer it writeBuffers before each draw group. At most one
// push block per stage is supported — DXVK uses one.
// ---------------------------------------------------------------------------
export function rewritePushConstantsWGSL(wgsl) {
  let pushBlocks = 0;
  let code = String(wgsl).replace(
    /(?:@group\(\d+\)\s*@binding\(\d+\)\s*)?var<\s*(?:push_constant|immediate)\s*>/g,
    () => { pushBlocks++; return '@group(' + V2_PUSH_GROUP + ') @binding(' + V2_PUSH_BINDING + ') var<uniform>'; }
  );
  // DXVK D3D9 shaders use @id(12)/@id(1) overrides for spec_state (alpha-test
  // func, fog, point sprites). The native bridge does not capture
  // VkSpecializationInfo, so overrides default to 0; the unbound spec_state
  // (zero-filled) gives alpha func 0 = NEVER -> all fragments discarded.
  // Hardcode safe defaults: id 12 = 1 (use overrides), id 1 = 0xE00000
  // (dword1 with alpha func 7 = ALWAYS in bits [21:24], other features off).
  // TODO: use real VkSpecializationInfo when the bridge captures it.
  if (code.indexOf('@id(12)') >= 0) {
    // Replace @id overrides with consts, preserving the declared names.
    code = code.replace(/@id\(12\)\s*override\s+(\w+)\s*:\s*u32\s*=\s*0u;/g,
      'const $1: u32 = 1u;');
    code = code.replace(/@id\(1\)\s*override\s+(\w+)\s*:\s*u32\s*=\s*0u;/g,
      'const $1: u32 = 14680064u;');
    code = code.replace(/@id\(2\)\s*override\s+(\w+)\s*:\s*u32\s*=\s*0u;/g,
      'const $1: u32 = 0u;');
  }
  return { code, pushBlocks };
}

// ---------------------------------------------------------------------------
// Naga Y-negation strip and BGR vertex swizzle.
// ---------------------------------------------------------------------------
// Naga's SPIR-V frontend appends `pos.y = -(pos.y)` (via a temp) to every
// translated vertex shader. That negation is the correct Vulkan->WebGPU
// adapter only for positive Vulkan viewport heights: on this stack NDC y=+1
// maps to texture row 0 (top), so the negation reproduces Vulkan's mapping
// for h>0. DXVK's D3D9 path uses negative viewport heights (Y-flip
// convention), which WebGPU cannot express; emulating such a viewport needs
// the UN-negated shader variant, selected per draw (see the viewport case).
export function stripNagaYNegation(wgsl) {
  return String(wgsl)
    .replace(/let\s+(_e\d+)\s*=\s*(\w+)\.y\s*;\s*\2\.y\s*=\s*-\(\1\)\s*;/g, '')
    .replace(/(\w+)\.y\s*=\s*-\(\1\.y\)\s*;/g, '');
}

// B8G8R8A8 vertex attributes arrive as B,G,R,A bytes. WebGPU has no BGRA
// vertex format (mapped to unorm8x4 above), so without a swizzle the shader
// would see R/B swapped vs Vulkan. Swizzle each 4-byte attribute element
// once per (buffer, layout); the GPU cache key is layout-qualified.
export function swizzleBgraVb(bytes, stride, offsets) {
  const out = new Uint8Array(bytes);
  if (!(stride > 0)) return out;
  const count = Math.floor(out.length / stride);
  for (const a of offsets) {
    for (let i = 0; i < count; i++) {
      const o = i * stride + a;
      if (o + 3 >= out.length) break;
      const t = out[o]; out[o] = out[o + 2]; out[o + 2] = t;
    }
  }
  return out;
}

// Scan translated WGSL for resource declarations. The bind-group layouts are
// built from what the shader actually declares — not from the manifest's
// DESC_SET table — so whatever binding assignment naga chose (including a
// texture+sampler pair sharing one binding, which WGSL allows) is honoured.
const WGSL_RES_DECL = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]+)>)?\s*(\w+)\s*:\s*([^;]+);/g;
export function scanWgslResources(wgsl) {
  const out = [];
  WGSL_RES_DECL.lastIndex = 0;
  let m;
  while ((m = WGSL_RES_DECL.exec(wgsl))) {
    const type = m[5].trim();
    const addr = (m[3] || '').trim();
    if (addr === 'private' || addr === 'workgroup' || addr === 'function') continue;
    let arrayCount = 1;
    const ba = /binding_array<\s*([^,]+?)\s*,\s*(\d+)\s*>/.exec(type);
    if (ba) arrayCount = parseInt(ba[2], 10);
    out.push({ group: +m[1], binding: +m[2], addr, name: m[4], type, arrayCount });
  }
  return out;
}
// WGSL uniform-address-space size computation, for padding short buffers.
// wgslUniformSizes returns a Map from "group:binding" to the byte size of the
// uniform struct declared there. Pure and testable.
export function wgslUniformSizes(wgsl) {
  const structs = new Map();
  const structRe = /struct\s+(\w+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = structRe.exec(wgsl))) {
    const fields = [];
    for (const part of m[2].split(",")) {
      const fm = /(\w+)\s*:\s*([^,;@]+)/.exec(part.trim());
      if (fm) fields.push({ name: fm[1], type: fm[2].trim() });
    }
    structs.set(m[1], fields);
  }
  const out = new Map();
  const declRe = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var<uniform>\s*\w+\s*:\s*([^;]+);/g;
  while ((m = declRe.exec(wgsl))) {
    const t = wgslTypeLayout(m[3].trim(), structs);
    if (t) out.set(m[1] + ":" + m[2], t.size);
  }
  return out;
}

// Returns {size, align} for a WGSL type in the uniform address space.
function wgslTypeLayout(type, structs) {
  const scalar = { f32: 4, i32: 4, u32: 4, bool: 4 };
  if (scalar[type]) return { size: 4, align: 4 };
  let vm = /^vec(\d)<\s*(\w+)\s*>$/.exec(type);
  if (vm) {
    const n = +vm[1];
    if (n === 2) return { size: 8, align: 8 };
    return { size: 16, align: 16 }; // vec3/vec4
  }
  let mm = /^mat(\d)x(\d)<\s*\w+\s*>$/.exec(type);
  if (mm) {
    const cols = +mm[1]; // each column is a vec aligned to 16
    return { size: cols * 16, align: 16 };
  }
  let am = /^array<\s*([^,]+?)\s*,\s*(\d+)\s*>$/.exec(type);
  if (am) {
    const el = wgslTypeLayout(am[1].trim(), structs);
    if (!el) return null;
    const stride = Math.ceil(el.size / el.align) * el.align;
    return { size: stride * (+am[2]), align: el.align };
  }
  const fields = structs.get(type);
  if (fields) {
    let offset = 0, maxAlign = 16;
    for (const f of fields) {
      const t = wgslTypeLayout(f.type, structs);
      if (!t) return null;
      maxAlign = Math.max(maxAlign, t.align);
      offset = Math.ceil(offset / t.align) * t.align + t.size;
    }
    const size = Math.ceil(offset / maxAlign) * maxAlign;
    return { size, align: maxAlign };
  }
  return null;
}

// MSAA: WebGPU guarantees sampleCount 1 and 4; a DXVK multisampled target
// resolves through a 4x texture into the single-sample target the readback and
// present path already use. Requested counts above 1 clamp to 4.
export function v2PickSampleCount(requested) { return requested > 1 ? 4 : 1; }

// The RP_BEGIN attachment-identity tail (schema v2) carries the VkImage id
// as a 16-char hex string; all-zero means the native side could not resolve it.
export const V2_UNKNOWN_IMAGE = '0000000000000000';
export function v2ImageKnown(imageId) {
  return typeof imageId === 'string' && imageId !== V2_UNKNOWN_IMAGE;
}
// Render-target cache key for one attachment. A known VkImage identity keys
// by image so a later pass sampling the same image aliases the texture that
// was rendered into (sampled-image alias replay); otherwise the geometry key
// is used, byte-identical to the pre-identity scheme. Guest image ids are
// never recycled (monotonic allocator in vk64bridge.cpp), so identity keys
// stay valid across frames like the geometry keys.
export function v2ImageTargetKey(imageId, isDepth) {
  return (isDepth ? 'imgd:' : 'img:') + imageId;
}
export function v2TargetKey(imageId, w, h, samples, isDepth) {
  if (v2ImageKnown(imageId)) return v2ImageTargetKey(imageId, isDepth);
  return (isDepth ? 'd' : 'c') + w + 'x' + h + 'x' + samples;
}

// ---------------------------------------------------------------------------
// createVkRenderer2 — the schema-v2 page-tier renderer.
//
// Per frame: for each render pass in the graph, MSAA-aware targets are built
// (multisampled colour + resolveTarget, multisampled depth), the pipeline is
// created from the translated WGSL with bind-group layouts scanned from the
// shader declarations, descriptor sets become bind groups (arrays as resource
// arrays), push constants ride the reserved group-3 UBO, and vertex/index
// binds feed draw/drawIndexed. The last pass's first colour target is copied
// to the canvas and read back for the lit/painted counters.
//
// Render targets always use the canvas format (the display format); the
// guest's VkFormat choice is honoured for sampled textures but not for the
// backbuffer — the bridge's job is to show the frame on this canvas.
// Likewise depth is always depth24plus.
//
// Anything the page cannot model (an untranslatable module, an unknown vertex
// format, a second push block) is counted and the frame skipped — the v1
// discipline.
// ---------------------------------------------------------------------------
/**
 * @param {HTMLCanvasElement} canvas
 * @param {{translate?: (from: string, source: Uint8Array, stage: string, entryPoint?: string, options?: {rasterTopology?: number}) => Promise<string>, log?: (msg: string) => void, onResize?: () => void}} [options]
 */
export async function createVkRenderer2(canvas, { translate, log = defaultLog, onResize } = {}) {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', e => log('vk64: v2 page tier WebGPU error: ' + (e.error?.message || e.error)));
  device.lost.then(info => errors.push('Device lost: ' + info.reason + ' ' + info.message));

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('No WebGPU canvas context');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });

  const shaders = createShaderCache({ translate, log });
  const pipelines = new Map();   // pipeId:msN -> { pipeline, layouts, decls, hasPush, slotOf, maxGroup, key }
  const targets = new Map();     // targetKey -> GPUTexture (invalidated on resize; img:/imgd: keys alias by VkImage)
  const stats = {
    frames: 0, rendered: 0, skips: 0, unknownFormats: 0, unsupported: 0,
    litPixels: 0, paintedPixels: 0, totalPixels: 0, width: 0, height: 0, aliased: 0,
  };
  const snapshot = () => ({ ...stats, ...shaders.stats });
  let destroyed = false;
  let resizeObs = null;
  // Track the canvas size the observer has seen. render() updates this
  // synchronously when IT resizes the canvas, so the observer's async fire
  // (initial observation or render()'s own resize) is ignored; only a real
  // external resize triggers onResize(). Without this, the observer fires
  // during render()'s awaits and invalidateTargets() destroys in-flight
  // textures ("destroyed texture used in a submit").
  let obsW = canvas.width, obsH = canvas.height;
  if (typeof ResizeObserver !== 'undefined' && onResize) {
    resizeObs = new ResizeObserver(() => { try {
      if (canvas.width !== obsW || canvas.height !== obsH) {
        obsW = canvas.width; obsH = canvas.height;
        onResize();
      }
    } catch { /* never throw at the observer */ } });
    try { resizeObs.observe(canvas); } catch { /* ignore */ }
  }

  function invalidateTargets() {
    for (const t of targets.values()) { try { t.destroy(); } catch { /* ignore */ } }
    targets.clear();
  }

  function target(key, desc) {
    let t = targets.get(key);
    if (!t) { t = device.createTexture(desc); targets.set(key, t); }
    return t;
  }

  // Frame-local resource caches, reset by render().
  const F = {
    shaders: new Map(), images: new Map(), views: new Map(), samplers: new Map(), buffers: new Map(),
    texCache: new Map(), bufCache: new Map(), sampCache: new Map(), live: [],
  };

  function gpuTextureFor(imgHex, img) {
    let t = F.texCache.get(imgHex);
    if (t) return t;
    const w = Math.max(1, img.w), h = Math.max(1, img.h);
    t = device.createTexture({
      size: [w, h], format: v2TextureFormat(img.format, stats),
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    if (img.pixels && img.pixels.length) {
      const bpp = 4; // the mapped colour formats are all 4 bytes/px
      const rowBytes = Math.max(bpp, w * bpp);
      const want = rowBytes * h;
      const src = img.pixels.length >= want ? img.pixels.subarray(0, want) : img.pixels;
      device.queue.writeTexture({ texture: t }, src, { bytesPerRow: rowBytes, rowsPerImage: h }, [w, h]);
    }
    F.texCache.set(imgHex, t); F.live.push(t);
    return t;
  }

  function gpuBufferFor(bufHex, bytes, usage) {
    const ck = bufHex + ':' + usage;
    let b = F.bufCache.get(ck);
    if (b) return b;
    b = device.createBuffer({ size: Math.max(4, bytes.length), usage, mappedAtCreation: true });
    new Uint8Array(b.getMappedRange()).set(bytes.subarray(0, Math.min(bytes.length, b.size)));
    b.unmap();
    F.bufCache.set(ck, b); F.live.push(b);
    return b;
  }

  function gpuSamplerFor(sampHex, s) {
    let sm = F.sampCache.get(sampHex);
    if (sm) return sm;
    sm = device.createSampler({
      magFilter: s.mag, minFilter: s.min, mipmapFilter: s.mipmap,
      addressModeU: s.addrU, addressModeV: s.addrV, maxAnisotropy: s.maxAnisotropy,
    });
    F.sampCache.set(sampHex, sm);
    return sm;
  }

  const blankTex = () => {
    let t = F.texCache.get('\0blank');
    if (!t) {
      t = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: t }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
      F.texCache.set('\0blank', t); F.live.push(t);
    }
    return t;
  };

  /** @returns {GPUBindGroupLayoutEntry | null} */
  function layoutEntryFor(decl) {
    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const t = decl.type;
    if (t.startsWith('texture_') && !t.startsWith('texture_storage')) {
      const elem = /texture_\w+<(\w+)>/.exec(t)?.[1] || 'f32';
      const sampleType = elem === 'i32' ? 'sint' : elem === 'u32' ? 'uint' : elem === 'f32' ? 'float' : 'float';
      const viewDimension = t.startsWith('texture_cube') ? 'cube' : t.includes('_array') ? '2d-array' : t.startsWith('texture_3d') ? '3d' : '2d';
      return { binding: decl.binding, visibility: vis, texture: { sampleType: t.startsWith('texture_depth') ? 'depth' : sampleType, viewDimension, multisampled: false } };
    }
    if (t === 'sampler' || t === 'sampler_comparison')
      return { binding: decl.binding, visibility: vis, sampler: { type: t === 'sampler_comparison' ? 'comparison' : 'filtering' } };
    if (decl.addr === 'uniform')
      return { binding: decl.binding, visibility: vis, buffer: { type: 'uniform' } };
    if (decl.addr.startsWith('storage')) {
      const ro = !decl.addr.includes('read_write');
      return { binding: decl.binding, visibility: vis, buffer: { type: ro ? 'read-only-storage' : 'storage' } };
    }
    const sm = /texture_storage_\w+<\s*([\w-]+)\s*,\s*(\w+)/.exec(t);
    if (sm) return { binding: decl.binding, visibility: vis, storageTexture: { access: sm[2].includes('write') ? 'write-only' : 'read-only', format: /** @type {GPUTextureFormat} */ (sm[1]), viewDimension: '2d' } };
    return null;
  }

  async function getPipelineFor(pipe, sampleCount, unnegated = false) {
    const key = pipe.pipeId + ':ms' + sampleCount + ':topology:' + pipe.topology + ':vb:' + JSON.stringify(pipe.vb) + ':yny' + (unnegated ? '1' : '0');
    if (pipelines.has(key)) return pipelines.get(key);
    const vsm = F.shaders.get(pipe.vsHash), fsm = F.shaders.get(pipe.fsHash);
    if (!vsm || !fsm) return { skip: 'missing-shader' };
    let vsWgsl = await shaders.get('vertex', { hash: pipe.vsHash, size: vsm.code.length, code: vsm.code }, { rasterTopology: pipe.topology, specOverrides: pipe.vsSpec });
    if (unnegated) vsWgsl = stripNagaYNegation(vsWgsl);
    const fsWgsl = await shaders.get('fragment', { hash: pipe.fsHash, size: fsm.code.length, code: fsm.code }, { rasterTopology: pipe.topology, specOverrides: pipe.fsSpec });
    if (!vsWgsl || !fsWgsl) return { skip: 'shader-translation' };
    const vsR = rewritePushConstantsWGSL(vsWgsl), fsR = rewritePushConstantsWGSL(fsWgsl);
    const pushBlocks = vsR.pushBlocks + fsR.pushBlocks;
    if (vsR.pushBlocks > 1 || fsR.pushBlocks > 1) { stats.unsupported++; return { skip: 'multi-push-block' }; }
    const hasPush = pushBlocks > 0;

    const declarations = scanWgslResources(vsR.code).concat(scanWgslResources(fsR.code));
    const uniqueDeclarations = new Map();
    for (const decl of declarations) {
      const key = decl.group + ':' + decl.binding;
      const prior = uniqueDeclarations.get(key);
      if (prior && JSON.stringify(layoutEntryFor(prior)) !== JSON.stringify(layoutEntryFor(decl)))
        return { skip: 'incompatible-shared-binding:' + key };
      if (!prior) uniqueDeclarations.set(key, decl);
    }
    const decls = [...uniqueDeclarations.values()];
    // Uniform block sizes from the WGSL, so short buffers can be padded.
    const uniformSizes = wgslUniformSizes(vsR.code + "\n" + fsR.code);
    for (const d of decls) if (d.addr === "uniform") {
      const s = uniformSizes.get(d.group + ":" + d.binding);
      if (s) d.minSize = s;
    }
    const byGroup = new Map();
    for (const d of decls) {
      if (d.group > 2 && !(d.group === V2_PUSH_GROUP && d.binding === V2_PUSH_BINDING && d.addr === 'uniform')) {
        stats.unsupported++; return { skip: 'group-out-of-range' };
      }
      if (!byGroup.has(d.group)) byGroup.set(d.group, []);
      byGroup.get(d.group).push(d);
    }
    const maxGroup = Math.max(0, ...byGroup.keys(), hasPush ? V2_PUSH_GROUP : 0);
    const layouts = [];
    for (let g = 0; g <= maxGroup; g++) {
      /** @type {GPUBindGroupLayoutEntry[]} */
      const entries = [];
      for (const d of byGroup.get(g) || []) {
        const e = layoutEntryFor(d);
        if (!e) { stats.unsupported++; return { skip: 'decl-kind:' + d.type }; }
        entries.push(e);
      }
      if (g === V2_PUSH_GROUP && hasPush && !entries.some(e => e.binding === V2_PUSH_BINDING))
        entries.push({ binding: V2_PUSH_BINDING, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } });
      layouts.push(device.createBindGroupLayout({ entries }));
    }

    // Vertex input state from the PIPELINE record's layout tables.
    /** @type {GPUVertexBufferLayout[]} */
    const buffers = [];
    const vbWalk = [];
    const slotOf = new Map(); // vulkan binding number -> vertex slot
    for (const vb of pipe.vb) {
      const attributes = [];
      let minStride = 0;
      for (const va of pipe.va) {
        if (va.binding !== vb.binding) continue;
        const vf = v2VertexFormat(va.format);
        if (!vf) { stats.unsupported++; return { skip: 'vertex-format:' + va.format }; }
        attributes.push({ shaderLocation: va.location, offset: va.offset, format: vf });
        minStride = Math.max(minStride, va.offset + (V2_VERT_FORMAT_SIZE[vf] || 4));
      }
      slotOf.set(vb.binding, buffers.length);
      const stride = Math.max(vb.stride, minStride, 4);
      const arrayStride = Math.ceil(stride / 4) * 4;
      buffers.push({ arrayStride, stepMode: vb.inputRate ? 'instance' : 'vertex', attributes });
      const attrs44 = [];
      for (const va of pipe.va) if (va.binding === vb.binding && va.format === 44) attrs44.push(va.offset);
      vbWalk.push({ binding: vb.binding, stride, attrs44 });
    }

    device.pushErrorScope('validation');
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: {
        module: device.createShaderModule({ code: vsR.code }), entryPoint: 'main',
        buffers: buffers.length ? buffers : undefined,
      },
      fragment: {
        module: device.createShaderModule({ code: fsR.code }), entryPoint: 'main',
        targets: [{ format, blend: pipe.blend ? {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } : undefined }],
      },
      primitive: {
        topology: V2_TOPOLOGY[pipe.topology] || 'triangle-list',
        cullMode: CULL[pipe.cull] || 'none', frontFace: FRONT[pipe.front] || 'ccw',
      },
      depthStencil: pipe.depthTest ? {
        format: 'depth24plus', depthWriteEnabled: !!pipe.depthWrite,
        depthCompare: DEPTH_OP[pipe.depthOp] || 'less-equal',
      } : undefined,
      multisample: { count: sampleCount },
    });
    const err = await device.popErrorScope();
    if (err) { stats.unsupported++; return { skip: 'pipeline-rejected:' + err.message }; }
    const rec = { key, pipeline, layouts, decls, hasPush, slotOf, maxGroup, vbWalk };
    pipelines.set(key, rec);
    return rec;
  }

  // Manifest bindings covering one array element (partial descriptor-array
  // writes each carry their own dstArrayElement/count).
  function bindingForElement(bindings, bindingNum, el) {
    let fallback = null;
    for (const b of bindings) {
      if (b.binding !== bindingNum) continue;
      if (!fallback) fallback = b;
      if (el >= b.dstArrayElement && el < b.dstArrayElement + b.count) return b;
    }
    return fallback;
  }

  function bindGroupEntries(prec, sets, inlineMap, group) {
    const entries = [];
    const set = sets.get(group);
    const bindings = set ? set.bindings : [];
    for (const d of prec.decls) {
      if (d.group !== group) continue;
      const t = d.type;
      if (group === V2_PUSH_GROUP) continue; // the push UBO is bound separately
      if (t.startsWith('texture_') && !t.startsWith('texture_storage')) {
        const views = [];
        for (let k = 0; k < d.arrayCount; k++) {
          const b = bindingForElement(bindings, d.binding, k);
          const imgHex = b && b.kind === 2 ? F.views.get(b.obj) : null;
          // Sampled-image alias replay: when this VkImage was a render target
          // earlier in the frame, sample the texture actually rendered into —
          // its IMAGE_DATA record carries the view->image link but no pixels.
          const aliasTex = v2ImageKnown(imgHex)
            ? (targets.get(v2ImageTargetKey(imgHex, false)) || targets.get(v2ImageTargetKey(imgHex, true)))
            : null;
          if (aliasTex) stats.aliased++;
          const img = !aliasTex && imgHex && F.images.get(imgHex);
          views.push(aliasTex ? aliasTex.createView() : (img ? gpuTextureFor(imgHex, img) : blankTex()).createView());
        }
        entries.push({ binding: d.binding, resource: d.arrayCount > 1 ? views : views[0] });
      } else if (t === 'sampler' || t === 'sampler_comparison') {
        const b = bindingForElement(bindings, d.binding, 0);
        let sHex = null;
        if (b && b.kind === DT_SAMPLER) sHex = b.obj;
        else if (b && b.kind === 2) sHex = b.range; // combined image sampler's sampler
        const s = sHex && F.samplers.get(sHex);
        entries.push({ binding: d.binding, resource: s ? gpuSamplerFor(sHex, s) : device.createSampler() });
      } else if (d.addr === 'uniform' || d.addr.startsWith('storage')) {
        const isStorage = d.addr.startsWith('storage');
        const mk = k => {
          const b = bindingForElement(bindings, d.binding, k);
          let bytes = null, bufHex = null;
          if (b && b.kind === 1) {
            bufHex = b.obj;
            // Offset-qualified: one VkBuffer may back several uniform ranges.
            // The GPU buffer cache (gpuBufferFor) is keyed by bufHex, so the
            // qualified key must become the cache key - otherwise a different
            // range of the same VkBuffer poisons the cache for this binding.
            const qkey = bufHex + ':' + (b.bufOff || '0');
            bytes = F.buffers.get(qkey);
            if (bytes) bufHex = qkey;
            else bytes = F.buffers.get(bufHex);
          }
          else if (b && b.kind === 4) { bufHex = 'inline:' + group + ':' + d.binding + ':' + k; bytes = inlineMap.get(group + ':' + d.binding); }
          // Missing uniform data: substitute a zero buffer large enough for any
          // practical uniform block (WebGPU validates against the shader's struct).
          if (!bytes) { bytes = new Uint8Array(4096); bufHex = 'zero:' + group + ':' + d.binding + ':' + k; }
          // Pad short buffers to the shader-declared uniform block size.
          if (d.minSize && bytes.length < d.minSize) {
            const padded = new Uint8Array(d.minSize);
            padded.set(bytes);
            bytes = padded;
            bufHex += ':pad' + d.minSize;
          }
          return { buffer: gpuBufferFor(bufHex, bytes, (isStorage ? GPUBufferUsage.STORAGE : GPUBufferUsage.UNIFORM) | GPUBufferUsage.COPY_DST) };
        };
        if (d.arrayCount > 1) {
          const arr = [];
          for (let k = 0; k < d.arrayCount; k++) arr.push(mk(k));
          entries.push({ binding: d.binding, resource: arr });
        } else {
          entries.push({ binding: d.binding, resource: mk(0) });
        }
      } else if (t.startsWith('texture_storage')) {
        stats.unsupported++; // DXVK's D3D9 path rarely writes storage images
        entries.push({ binding: d.binding, resource: blankTex().createView() });
      }
    }
    return entries;
  }

  async function render(frame) {
    if (destroyed) throw new Error('page tier destroyed');
    F.shaders = frame.shaders; F.images = frame.images;
    F.views = frame.views; F.samplers = frame.samplers; F.buffers = frame.buffers;
    F.texCache.clear(); F.bufCache.clear(); F.sampCache.clear(); F.live.length = 0;
    if (typeof window !== 'undefined' && window.__bwDbgRender)
      console.log('bwDbg render f' + frame.frameNo + ' ' + frame.width + 'x' + frame.height +
        ' canvas ' + canvas.width + 'x' + canvas.height);
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width; canvas.height = frame.height;
      obsW = frame.width; obsH = frame.height;
      // Reconfigure the WebGPU context for the new canvas size; without
      // this getCurrentTexture() may return a stale-sized texture.
      context.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });
    }

    let presentTex = null, presentW = frame.width, presentH = frame.height, lastClear = [0, 0, 0, 1];
    const encoder = device.createCommandEncoder();
    const groupCache = new Map(); // per-frame: pipeKey|setIndex|ver -> GPUBindGroup
    const pushBuf = device.createBuffer({ size: V2_PUSH_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    F.live.push(pushBuf);
    // Dummy vertex buffer for pipeline slots the guest leaves unbound (null buffer).
    const dummyVb = device.createBuffer({ size: 4096, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    F.live.push(dummyVb);

    for (const p of frame.passes) {
      // --- targets for this pass (MSAA-aware) ---
      let passSamples = 1;
      for (const a of p.attachments) passSamples = Math.max(passSamples, v2PickSampleCount(a.samples || 1));
      /** @type {GPURenderPassColorAttachment[]} */
      const colorAttachments = [];
      let depthView = null;
      for (const a of p.attachments) {
        const samples = v2PickSampleCount(a.samples || 1);
        // Known VkImage identity: the single-sample (resolve) target is keyed
        // by image so a later pass sampling it aliases the rendered texture.
        // The multisampled texture itself stays geometry-keyed.
        const knownImage = v2ImageKnown(a.imageId);
        const texBinding = knownImage ? GPUTextureUsage.TEXTURE_BINDING : 0;
        if (a.isDepth) {
          const tex = target(v2TargetKey(a.imageId, p.w, p.h, samples, true), {
            size: [p.w, p.h], sampleCount: samples, format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | texBinding,
          });
          depthView = tex.createView();
        } else {
          const single = target(v2TargetKey(a.imageId, p.w, p.h, 1, false), {
            size: [p.w, p.h], format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | texBinding,
          });
          let view = single.createView(), resolveTarget;
          if (samples > 1) {
            const ms = target(v2TargetKey(null, p.w, p.h, samples, false), {
              size: [p.w, p.h], sampleCount: samples, format, usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
            view = ms.createView(); resolveTarget = single.createView();
          }
          colorAttachments.push({
            view, resolveTarget,
            clearValue: { r: p.clearColor[0], g: p.clearColor[1], b: p.clearColor[2], a: p.clearColor[3] },
            loadOp: a.loadOp === 1 ? 'clear' : 'load',
            storeOp: a.storeOp === 1 ? 'discard' : 'store',
          });
          presentTex = single; presentW = p.w; presentH = p.h; lastClear = p.clearColor;
        }
      }
      if (!colorAttachments.length && !depthView) { stats.skips++; continue; }

      const rpDesc = { colorAttachments };
      if (depthView) rpDesc.depthStencilAttachment = {
        view: depthView, depthClearValue: p.clearDepth,
        depthLoadOp: 'clear', depthStoreOp: 'store',
      };
      const passEnc = encoder.beginRenderPass(rpDesc);

      // --- replay ops ---
      const st = {
        pipeRec: null, pipeDesc: null, pipeNeg: false, sets: new Map(), setVer: new Map(), inlineMap: new Map(),
        pushBlock: new Uint8Array(V2_PUSH_SIZE), pushDirty: false,
        vbinds: [], ibind: null, viewport: null, scissor: null,
        pipeBad: false, badPipes: new Map(),
      };
      const bump = si => st.setVer.set(si, (st.setVer.get(si) || 0) + 1);
      let skipped = null;

      for (const op of p.ops) {
        switch (op.op) {
          case 'bindPipe': {
            let rec;
            try { rec = await getPipelineFor(op.pipe, passSamples); }
            catch (e) { rec = { skip: 'pipeline-threw' }; }
            if (rec.skip) {
              if (!st.badPipes.has(op.pipe.pipeId)) {
                st.badPipes.set(op.pipe.pipeId, rec.skip);
                stats.skippedDraws = (stats.skippedDraws || 0) + 1;
              }
              st.pipeRec = null; st.pipeBad = true;
              break;
            }
            st.pipeRec = rec; st.pipeDesc = op.pipe; st.pipeNeg = false;
            passEnc.setPipeline(rec.pipeline);
            break;
          }
          case 'bindSets': break; // sets resolve from DESC_SET records; ids kept for debugging
          case 'descSet': st.sets.set(op.setIndex, { bindings: op.bindings }); bump(op.setIndex); break;
          case 'inline': st.inlineMap.set(op.setIndex + ':' + op.binding, op.bytes); bump(op.setIndex); break;
          case 'push': st.pushBlock.set(op.bytes, op.offset); st.pushDirty = true; break;
          case 'viewport': st.viewport = op.v; break;
          case 'scissor': st.scissor = op.s; break;
          case 'vbind': st.vbinds = op.binds; break;
          case 'ibind': st.ibind = op; break;
          case 'draw': {
            if (skipped) break;
            if (st.pipeBad || !st.pipeRec) break;
            if (st.viewport) {
              const [x, y, w, h, md, xmd] = st.viewport;
              if (w > 0 && h !== 0) {
                // WebGPU rejects negative viewport heights; Vulkan uses h<0
                // as the Y-flip convention (DXVK D3D9 always does). Emulate
                // exactly: rect (x, y+h, w, -h) plus the un-negated VS variant
                // (see stripNagaYNegation), which together reproduce Vulkan's
                // framebuffer mapping bit-for-bit.
                const negH = h < 0;
                if (negH !== st.pipeNeg && st.pipeDesc) {
                  const rec = await getPipelineFor(st.pipeDesc, passSamples, negH);
                  if (!rec.skip) { st.pipeRec = rec; st.pipeNeg = negH; passEnc.setPipeline(rec.pipeline); }
                }
                passEnc.setViewport(x, negH ? y + h : y, w, Math.abs(h), md, xmd);
              }
            }
            if (st.scissor) {
              const [x, y, w, h] = st.scissor;
              if (w > 0 && h > 0) passEnc.setScissorRect(x | 0, y | 0, w | 0, h | 0);
            }
            for (let g = 0; g <= st.pipeRec.maxGroup; g++) {
              if (g === V2_PUSH_GROUP) continue;
              if (!st.pipeRec.decls.some(d => d.group === g)) continue;
              const ver = st.setVer.get(g) || 0;
              const ck = st.pipeRec.key + '|' + g + '|' + ver;
              let bg = groupCache.get(ck);
              if (!bg) {
                bg = device.createBindGroup({ layout: st.pipeRec.layouts[g], entries: bindGroupEntries(st.pipeRec, st.sets, st.inlineMap, g) });
                groupCache.set(ck, bg);
              }
              passEnc.setBindGroup(g, bg);
            }
            if (st.pipeRec.hasPush) {
              if (st.pushDirty) { device.queue.writeBuffer(pushBuf, 0, st.pushBlock); st.pushDirty = false; }
              const ck = st.pipeRec.key + '|push';
              let pg = groupCache.get(ck);
              if (!pg) {
                pg = device.createBindGroup({
                  layout: st.pipeRec.layouts[V2_PUSH_GROUP],
                  entries: [{ binding: V2_PUSH_BINDING, resource: { buffer: pushBuf } }],
                });
                groupCache.set(ck, pg);
              }
              passEnc.setBindGroup(V2_PUSH_GROUP, pg);
            }
            const vbSet = new Set();
            for (const vb of st.vbinds) {
              const slot = st.pipeRec.slotOf.get(vb.binding);
              if (slot === undefined) continue;
              const bytes = F.buffers.get(vb.buf);
              if (!bytes) continue;
              let vkey = vb.buf, vbytes = bytes;
              const walk = (st.pipeRec.vbWalk || []).find(w => w.binding === vb.binding);
              if (walk && walk.attrs44.length) {
                vkey = vb.buf + '|swz44:' + st.pipeRec.key;
                vbytes = swizzleBgraVb(bytes, walk.stride, walk.attrs44);
              }
              const gpu = gpuBufferFor(vkey, vbytes, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
              passEnc.setVertexBuffer(slot, gpu, Math.min(vb.offset, gpu.size));
              vbSet.add(slot);
            }
            // Slots the guest left unbound (null buffer) still need a buffer.
            for (const slot of st.pipeRec.slotOf.values()) {
              if (!vbSet.has(slot)) passEnc.setVertexBuffer(slot, dummyVb, 0);
            }
            let indexed = op.indexed;
            if (indexed && st.ibind) {
              const bytes = F.buffers.get(st.ibind.buf);
              if (!bytes) indexed = false;
              else {
                const gpu = gpuBufferFor(st.ibind.buf, bytes, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST);
                passEnc.setIndexBuffer(gpu, st.ibind.indexType ? 'uint32' : 'uint16', Math.min(st.ibind.offset, gpu.size));
              }
            } else if (indexed) indexed = false;
            if (indexed) passEnc.drawIndexed(op.indexCount, op.instanceCount, op.firstIndex, op.vertexOffset, op.firstInstance);
            else if (op.vertexCount > 0) passEnc.draw(op.vertexCount, op.instanceCount, op.firstVertex, op.firstInstance);
            break;
          }
          default: break;
        }
        if (skipped) break;
      }
      passEnc.end();
      if (skipped) { stats.skips++; return { rendered: false, reason: skipped }; }
    }

    if (!presentTex) { stats.skips++; return { rendered: false, reason: 'no-colour-target' }; }

    // Readback of the present target (COPY_SRC) plus the present copy to the
    // page canvas, like the v1 tier.
    device.pushErrorScope('validation');
    const bytesPerRow = Math.ceil(presentW * 4 / 256) * 256;
    const readback = device.createBuffer({ size: bytesPerRow * presentH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture: presentTex }, { buffer: readback, bytesPerRow }, [presentW, presentH]);
    encoder.copyTextureToTexture({ texture: presentTex }, { texture: context.getCurrentTexture() }, [presentW, presentH]);
    device.queue.submit([encoder.finish()]);
    const invalid = await device.popErrorScope();
    if (invalid) { readback.destroy(); throw new Error('v2 frame encoding rejected: ' + invalid.message); }

    await readback.mapAsync(GPUMapMode.READ);
    const rows = new Uint8Array(readback.getMappedRange());
    const [r, g, b, a] = lastClear.map(c => Math.round(c * 255));
    const bgra = format.startsWith('bgra');
    let lit = 0, painted = 0;
    for (let y = 0; y < presentH; y++) {
      const row = y * bytesPerRow;
      for (let x = 0; x < presentW; x++) {
        const i = row + x * 4;
        const pr = rows[i], pg = rows[i + 1], pb = rows[i + 2], pa = rows[i + 3];
        if (pr || pg || pb || pa) painted++;
        if (pr !== (bgra ? b : r) || pg !== g || pb !== (bgra ? r : b) || pa !== a) lit++;
      }
    }
    readback.unmap();
    readback.destroy();

    const release = () => { for (const x of F.live.splice(0)) { try { x.destroy(); } catch { /* ignore */ } } };
    device.queue.onSubmittedWorkDone().then(release, release);

    stats.frames++; stats.rendered++;
    stats.litPixels = lit; stats.paintedPixels = painted;
    stats.totalPixels = presentW * presentH; stats.width = presentW; stats.height = presentH;
    return {
      rendered: true, frame: frame.frameNo, litPixels: lit, paintedPixels: painted,
      totalPixels: presentW * presentH, clear: lastClear,
    };
  }

  return {
    render, errors, device, shaders, snapshot, stats, invalidateTargets,
    get frames() { return stats.rendered; },
    destroy() {
      destroyed = true;
      try { resizeObs?.disconnect(); } catch { /* ignore */ }
      context.unconfigure(); invalidateTargets(); device.destroy();
    },
  };
}
