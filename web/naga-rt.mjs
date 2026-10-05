// C1 naga observation lane (contract /tmp/c1-contract.md): capture the post-bridge
// GLSL ES 3.00 guest shader sources wined3d feeds to ANGLE, lift them to desktop
// GLSL 450 core (the only profile the vendored Naga 30.0.1 parses — probes P1-P8),
// translate to WGSL via web/shader.mjs toWGSL, and shadow-validate on WebGPU.
//
// HARD RULES (contract §1.2.6): this lane is observation + validation only.
//   * ANGLE/WebGL2 keeps rendering — the patched shaderSource always calls the
//     original method, capture results are never fed back into the GL path.
//   * Nothing may throw across the patched boundary; every capture/translate
//     step is try/catch'd, failures land in a 64-slot ring buffer (§3.4).
//   * Flag-gated: `?naga=1` in web/runtime.html imports this module; with the
//     flag absent nothing here loads and the page runs byte-identically.
//
// Module top level is DOM-free (pure lift + injectable pipeline) so node tests
// (web/tests/naga-rt.test.mjs) can import it alongside ../vendor/naga/node.js.
import { toWGSL } from './shader.mjs';

export const NAGA_RING_MAX = 64;      // §3.4: fixed 64-slot FIFO
export const MAX_SHADER_BYTES = 1024 * 1024; // §5.5: mirrors web/shader.mjs guard
const DEDUPE_MAX = 4096;              // cap the seen-set so it can never grow away
const LOG_INTERVAL_MS = 5000;         // §3.4: ≤1 log line / 5 s per failure kind

// ---------------------------------------------------------------------------
// Stage inference — replicates the bridge's own heuristic (gl64bridge.cpp
// GL64_fn_glShaderSource: fragment iff gl_FragData/gl_FragColor/gl_FragDepth,
// or no gl_Position/gl_PointSize) plus the post-bridge bw_* spellings (§2.1).
// ---------------------------------------------------------------------------
export function inferStage(src) {
  const s = String(src ?? '');
  if (/\bgl_FragData\b|\bgl_FragColor\b|\bgl_FragDepth\b|\bbw_FragColor\b|\bbw_FragData\b/.test(s)) return 'fragment';
  return /\bgl_Position\b|\bgl_PointSize\b/.test(s) ? 'vertex' : 'fragment';
}

// ---------------------------------------------------------------------------
// liftForNaga — ES 3.00 (post-translateGlslToEs300) or raw desktop 120/130
// source  ->  GLSL 450 core that Naga 30.0.1 accepts. Pure; never throws.
//   a. strip every #version line (wined3d duplicate-#version bug, §3.2a)
//   b. split `uniform sampler2D S;` -> texture2D S_bw_t + sampler S_bw_s and
//      rewrite `texture(S, ...)` -> `texture(sampler2D(S_bw_t, S_bw_s), ...)`
//      (probe P4: combined samplers are "Not implemented: variable qualifier")
//   c. synthesize `layout(binding=N)` on every uniform, N++ in source order
//      (probes P5/P6: Naga rejects unbound uniforms)
//   d. synthesize `layout(location=N)` on every in/out from a cross-stage
//      name->N registry (locMap, shared for the vertex+fragment pair so the
//      interfaces match — probe P7); fragment output bw_FragColor pinned to 0
//   e. stamp `#version 450` (the ONLY profile Naga 30.x parses — probe P3)
// locMap namespaces: 'a:<name>' vertex attributes, 'v:<name>' interpolate-stage
// varyings (vertex out == fragment in), 'o:<name>' fragment outputs, '#!<ns>'
// per-namespace counters. Returns {ok:true, code} or {ok:false, reason, ...}.
// ---------------------------------------------------------------------------
export function liftForNaga(srcIn, stage, locMap = new Map()) {
  try {
    if (typeof srcIn !== 'string') return { ok: false, reason: 'non-string-source' };
    if (stage !== 'vertex' && stage !== 'fragment') return { ok: false, reason: 'bad-stage', stage };
    if (srcIn.length === 0) return { ok: false, reason: 'empty-source' };
    if (srcIn.length > MAX_SHADER_BYTES) return { ok: false, reason: 'too-large', rawLen: srcIn.length };

    let src = srcIn.replace(/\r\n?/g, '\n');

    // Dialect detection (§3.2). The bridge always re-stamps `#version 300 es`;
    // raw 120/130 (only reachable if a C2 hook ever feeds the un-translated
    // source) goes through the same token rewrites translateGlslToEs300 uses.
    const vm = /#version[ \t]+(\d+)[ \t]*(es)?\b/.exec(src);
    let mode;
    if (vm) {
      const num = vm[1], es = vm[2] === 'es';
      if (num === '300' && es) mode = 'es300';
      else if (num === '100' || num === '120' || num === '130') mode = 'legacy';
      else return { ok: false, reason: 'unsupported-version', version: num + (es ? ' es' : '') };
    } else {
      mode = LEGACY_TOKEN_RE.test(src) ? 'legacy' : 'es300';
    }

    // a. strip EVERY #version line, then re-stamp exactly one at the end.
    src = src.replace(/^[ \t]*#version[^\n]*\n?/gm, '');

    if (mode === 'legacy') {
      // Standalone replica of the bridge's desktop-GLSL token rewrites
      // (gl64bridge.cpp translateGlslToEs300) so raw sources lift too.
      src = wordReplace(src, 'texture2DProj', 'textureProj');
      src = wordReplace(src, 'texture2DLod', 'textureLod');
      src = wordReplace(src, 'texture2D', 'texture');
      src = wordReplace(src, 'texture3D', 'texture');
      src = wordReplace(src, 'textureCube', 'texture');
      src = wordReplace(src, 'shadow2DProj', 'textureProj');
      src = wordReplace(src, 'shadow2D', 'texture');
      src = wordReplace(src, 'gl_FrontSecondaryColor', 'bw_secondary');
      src = wordReplace(src, 'gl_BackSecondaryColor', 'bw_secondary');
      src = wordReplace(src, 'gl_SecondaryColor', 'bw_secondary');
      src = wordReplace(src, 'gl_FrontColor', 'bw_color');
      src = wordReplace(src, 'gl_BackColor', 'bw_color');
      src = wordReplace(src, 'gl_Color', 'bw_color');
      src = wordReplace(src, 'gl_TexCoord', 'bw_texcoord');
      src = wordReplace(src, 'gl_FogFragCoord', 'bw_fogcoord');
      src = wordReplace(src, 'varying', stage === 'fragment' ? 'in' : 'out');
      if (stage === 'vertex') src = wordReplace(src, 'attribute', 'in');
      if (stage === 'fragment') {
        src = src.split('gl_FragData[0]').join('bw_FragColor');
        src = wordReplace(src, 'gl_FragColor', 'bw_FragColor');
      }
      // Synthesize the declarations the bridge's ES 3.00 header would add for
      // the compatibility built-ins it rewrote (direction follows the stage).
      const side = stage === 'vertex' ? 'out' : 'in';
      const decls = [];
      if (/\bbw_color\b/.test(src)) decls.push(`${side} vec4 bw_color;`);
      if (/\bbw_secondary\b/.test(src)) decls.push(`${side} vec4 bw_secondary;`);
      if (/\bbw_texcoord\b/.test(src)) decls.push(`${side} vec4 bw_texcoord[8];`);
      if (/\bbw_fogcoord\b/.test(src)) decls.push(`${side} float bw_fogcoord;`);
      if (stage === 'fragment' && /\bbw_FragColor\b/.test(src)) decls.push('out vec4 bw_FragColor;');
      src = 'precision highp float;\nprecision highp int;\n' + decls.join('\n') + (decls.length ? '\n' : '') + src;
    }

    // b+c. one source-order pass: split combined sampler2D uniforms into
    // texture2D+sampler pairs and give every uniform a layout(binding=N).
    const samplers = [];
    let binding = 0;
    src = src.replace(/^[ \t]*(layout\s*\([^)]*\)\s*)?uniform[ \t]+([^;{}]+);[ \t]*$/gm, (m, lay, declList) => {
      if (lay) return m; // already carries an explicit layout — keep untouched
      const out = [];
      for (const decl of splitDeclarators(declList.trim())) {
        const sm = /^sampler2D\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?$/.exec(decl);
        if (sm) {
          const [, name, arr] = sm;
          samplers.push(name);
          out.push(`layout(binding=${binding++}) uniform texture2D ${name}_bw_t${arr || ''};`);
          out.push(`layout(binding=${binding++}) uniform sampler ${name}_bw_s${arr || ''};`);
        } else {
          out.push(`layout(binding=${binding++}) uniform ${decl};`);
        }
      }
      return out.join('\n');
    });

    // Rewrite the split samplers' lookup call-sites to combined-sampler form.
    for (const name of samplers) {
      const re = new RegExp('(\\btexture(?:Lod|Proj)?[ \\t]*\\([ \\t]*)' + name + '[ \\t]*(\\[[^\\]]*\\])?[ \\t]*,', 'g');
      src = src.replace(re, (m, head, idx) => `${head}sampler2D(${name}_bw_t${idx || ''}, ${name}_bw_s${idx || ''}),`);
    }

    // d. synthesize layout(location=N) on every interface in/out declaration.
    // Array varyings (e.g. the bridge's bw_texcoord[8]) consume their WHOLE
    // location span N..N+size-1 — Naga rejects a following varying inside that
    // span with "Multiple bindings at location N are present" (measured against
    // the shipped 30.0.1 build), so the registry advances by the array length.
    src = src.replace(/^[ \t]*(layout\s*\([^)]*\)\s*)?((?:flat|smooth|noperspective|invariant)[ \t]+)*(in|out)[ \t]+([^;{}]+);[ \t]*$/gm, (m, lay, quals, dir, declList) => {
      if (lay) return m;
      quals = quals || '';
      const ns = stage === 'vertex' ? (dir === 'in' ? 'a' : 'v') : (dir === 'in' ? 'v' : 'o');
      const out = [];
      for (const decl of splitDeclarators(declList.trim())) {
        const dm = /^(.+?)[ \t]+([A-Za-z_]\w*)[ \t]*(\[[^\]]*\])?$/.exec(decl);
        if (!dm) { out.push(`layout(location=${locationFor(locMap, ns, decl, 1, null)}) ${quals}${dir} ${decl};`); continue; }
        const name = dm[2];
        const span = /^\[(\d+)\]$/.test(dm[3] || '') ? parseInt(dm[3].slice(1, -1), 10) : 1;
        const pinned = stage === 'fragment' && dir === 'out' && name === 'bw_FragColor' ? 0 : null;
        out.push(`layout(location=${locationFor(locMap, ns, name, span, pinned)}) ${quals}${dir} ${decl};`);
      }
      return out.join('\n');
    });

    // e. stamp the one and only #version line (desktop core profile).
    src = src.replace(/^\n+/, '');
    return { ok: true, code: '#version 450\n' + src };
  } catch (e) {
    return { ok: false, reason: 'lift-exception', detail: String((e && e.message) || e) };
  }
}

const LEGACY_TOKEN_RE = /\battribute\b|\bvarying\b|\btexture2D\b|\btexture2DProj\b|\btexture2DLod\b|\btexture3D\b|\btextureCube\b|\bshadow2D\b|\bshadow2DProj\b|\bgl_FragData\b|\bgl_FragColor\b|\bgl_FragDepth\b|\bgl_TexCoord\b|\bgl_FrontColor\b|\bgl_FrontSecondaryColor\b|\bgl_BackColor\b|\bgl_BackSecondaryColor\b|\bgl_SecondaryColor\b|\bgl_Color\b|\bgl_FogFragCoord\b/;

// Whole-word replace (mirrors the bridge's wordReplace helper).
function wordReplace(src, needle, repl) {
  return src.replace(new RegExp('(?<![\\w])' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'g'), repl);
}

// Split a GLSL declarator list on top-level commas (parens/brackets aware).
function splitDeclarators(decl) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of decl) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Cross-stage location registry (§3.2d): stable name->location across the
// vertex+fragment pair. `span` is the array length (arrays occupy consecutive
// locations); a pinned location still advances the counter past its span so
// later unpinned declarations can never collide with it.
function locationFor(locMap, ns, name, span, pinned) {
  const key = ns + ':' + name;
  const existing = locMap.get(key);
  if (existing !== undefined) return existing;
  const n = pinned !== null ? pinned : (locMap.get('#!' + ns) || 0);
  locMap.set(key, n);
  const next = n + Math.max(1, span | 0);
  if ((locMap.get('#!' + ns) || 0) < next) locMap.set('#!' + ns, next);
  return n;
}

function firstMeaningfulLine(src) {
  const line = (src.split('\n').find(l => l.trim()) || '').trim();
  return line.length > 120 ? line.slice(0, 120) : line;
}

// ---------------------------------------------------------------------------
// createNagaPipeline — the capture/translate state machine. Injectable so node
// tests drive it with ../vendor/naga/node.js and the browser install wires the
// real toWGSL + WebGPU shadow validator. process() NEVER throws and NEVER
// rejects: every failure is a ring record + counter bump (§1.2.6, §3.3).
// ---------------------------------------------------------------------------
export function createNagaPipeline({ translate = toWGSL, validate = null, log = defaultLog } = {}) {
  const stats = { captured: 0, lifted: 0, translated: 0, wgslOk: 0, wgslFail: 0, nagaFail: 0, devSkipped: 0, broken: 0 };
  const ring = [];
  const seen = new Set();
  const locMap = new Map();
  const lastLog = new Map();
  let broken = false;
  let onBroken = null;

  function pushRing(entry) {
    ring.push(entry);
    if (ring.length > NAGA_RING_MAX) ring.shift();
  }
  function logRateLimited(kind, msg) {
    const now = Date.now();
    if (now - (lastLog.get(kind) || 0) < LOG_INTERVAL_MS) return;
    lastLog.set(kind, now);
    try { log(msg); } catch { /* logging must never throw */ }
  }
  // Sticky-disable (§1.2): broken lanes log once, uninstall via onBroken and
  // never retry this page load. ANGLE keeps rendering regardless.
  function markBroken(msg) {
    if (stats.broken) return;
    stats.broken = 1;
    broken = true;
    logRateLimited('broken', msg);
    try { if (onBroken) onBroken(); } catch { /* never throw from teardown */ }
  }

  async function process(raw, opts = {}) {
    if (broken) return null;
    const src = typeof raw === 'string' ? raw : String(raw ?? '');
    if (!src) return null;
    // §3.4 dedupe: repeat shaders (wined3d recompiles identical sources on
    // context churn) keyed by (rawLen, first meaningful line).
    const key = src.length + ':' + firstMeaningfulLine(src);
    if (seen.has(key)) return null;
    seen.add(key);
    if (seen.size > DEDUPE_MAX) seen.clear();
    stats.captured++;
    const ts = Date.now();
    const stage = opts.stage || inferStage(src);

    const lifted = liftForNaga(src, stage, locMap);
    if (!lifted.ok) {
      const unsupported = lifted.reason === 'unsupported-version';
      if (!unsupported) stats.nagaFail++; // unsupported sources belong to ANGLE; no failure of ours
      pushRing({
        ts, type: unsupported ? 'unsupported' : (lifted.reason === 'too-large' ? 'too-large' : 'lift'),
        stage, rawLen: src.length, reason: lifted.reason, version: lifted.version, src,
      });
      logRateLimited('lift', 'naga: lift failed (' + lifted.reason + ') for ' + stage + ' shader — ANGLE keeps rendering');
      return null;
    }
    stats.lifted++;

    let wgsl;
    try {
      wgsl = String((await (opts.translate !== undefined ? opts.translate : translate)(lifted.code, stage)) ?? '');
    } catch (e) {
      if (e && e.name === 'NagaError') {
        // Per-shader Naga rejection (§3.3): ring record with ≤6 formatted lines.
        stats.nagaFail++;
        pushRing({
          ts, type: 'naga', stage, kind: e.kind,
          firstLines: String(e.formatted || e.message || e).split('\n').slice(0, 6),
          rawLen: src.length, liftedLen: lifted.code.length, src,
        });
        logRateLimited('naga', 'naga: ' + stage + ' shader rejected by Naga (' + e.kind + ') — ANGLE keeps rendering');
      } else {
        // Non-NagaError (wasm/init/guard failure): sticky-disable (§1.2.2).
        pushRing({ ts, type: 'init', stage, rawLen: src.length, message: String((e && e.message) || e), src });
        markBroken('naga: translate pipeline broken — ANGLE fallback active (' + String((e && e.message) || e) + ')');
      }
      return null;
    }
    stats.translated++;

    const validateFn = opts.validate !== undefined ? opts.validate : validate;
    if (validateFn) {
      try {
        const errors = await validateFn(wgsl);
        if (errors == null) stats.devSkipped++; // no device / transform-only mode (§1.2.5)
        else if (errors.length) {
          stats.wgslFail++;
          pushRing({
            ts, type: 'wgsl-validate', stage, rawLen: src.length, liftedLen: lifted.code.length,
            wgslLen: wgsl.length, firstLines: errors.slice(0, 6).map(String), src,
          });
          logRateLimited('wgsl-validate', 'naga: WGSL shadow validation failed (' + stage + ') — ANGLE keeps rendering');
        } else stats.wgslOk++;
      } catch { stats.devSkipped++; }
    }

    pushRing({ ts, type: 'capture', stage, rawLen: src.length, liftedLen: lifted.code.length, wgslLen: wgsl.length, src });
    return { stage, wgsl, lifted: lifted.code };
  }

  return { stats, ring, locMap, seen, process, markBroken, onBroken };
}

function defaultLog(msg) {
  try { (globalThis.console && globalThis.console.warn || (() => {}))(msg); } catch { /* ignore */ }
  try { if (typeof globalThis.bwRuntimeLog === 'function') globalThis.bwRuntimeLog(msg); } catch { /* ignore */ }
}

// Browser-only lazy WebGPU shadow validator (§3.3): one adapter/device for the
// page lifetime; any failure flips to transform-only mode (devSkipped), never
// throws. Error-type compilation messages are the WGSL validation result.
function makeWebGpuValidator() {
  let device = null;
  let gpuDead = false;
  return async function validateWgsl(code) {
    const nav = globalThis.navigator;
    if (!nav || !nav.gpu || gpuDead) return null;
    try {
      if (!device) {
        const adapter = await nav.gpu.requestAdapter();
        if (!adapter) { gpuDead = true; return null; }
        device = await adapter.requestDevice();
      }
      const info = await device.createShaderModule({ code }).getCompilationInfo();
      return info.messages.filter(m => m.type === 'error').map(m => (m.lineNum ? 'line ' + m.lineNum + ': ' : '') + m.message);
    } catch (e) {
      gpuDead = true;
      try { if (device && device.destroy) device.destroy(); } catch { /* ignore */ }
      device = null;
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// installNagaCapture — browser entry point (called from web/runtime.html under
// ?naga=1, BEFORE wine64-launcher.js is appended so the wrap is in place long
// before wined3d's first shader). Installs the WebGL2RenderingContext.prototype
// .shaderSource wrap synchronously (§2.1); the wrapped method always calls the
// original in its tail so ANGLE receives the exact source it always did.
// ---------------------------------------------------------------------------
export function installNagaCapture() {
  const g = globalThis;
  if (g.__bw64NagaInstalled) return g.bwNagaStats ? g.bwNagaStats() : undefined;
  g.__bw64NagaInstalled = true;

  const pipeline = createNagaPipeline({ validate: makeWebGpuValidator() });
  // §3.4: ring + counters in the page realm.
  g.__bw64NagaRing = pipeline.ring;
  g.bwNagaStats = () => ({ ...pipeline.stats });
  g.bwNagaDump = () => ({
    stats: { ...pipeline.stats },
    ring: pipeline.ring.map(e => {
      const copy = { ...e };
      if (typeof copy.src === 'string' && copy.src.length > 4096) copy.src = copy.src.slice(0, 4096);
      return copy;
    }),
  });

  const proto = g.WebGL2RenderingContext && g.WebGL2RenderingContext.prototype;
  if (!proto || typeof proto.shaderSource !== 'function') {
    pipeline.markBroken('naga: WebGL2RenderingContext unavailable — ANGLE fallback active');
    return;
  }
  const original = proto.shaderSource;
  const patched = function shaderSource(shader, source) {
    // Observation only: capture runs in a microtask AFTER this call returns;
    // the original ANGLE call below is unconditional (§2.1 hard rule).
    try {
      if (typeof source === 'string' && source) {
        const src = source;
        queueMicrotask(() => { pipeline.process(src).catch(() => { /* never reject unhandled */ }); });
      }
    } catch { /* the render path must never see an exception from this lane */ }
    return original.call(this, shader, source);
  };
  try {
    proto.shaderSource = patched;
  } catch (e) {
    pipeline.markBroken('naga: shaderSource patch failed — ANGLE fallback active');
    return;
  }
  // §1.2.1/§1.2.2: a broken lane uninstalls the patch (restore the original).
  pipeline.onBroken = () => {
    try { if (proto.shaderSource === patched) proto.shaderSource = original; } catch { /* ignore */ }
  };
}
