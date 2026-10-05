// C1 naga-rt tests (contract /tmp/c1-contract.md §5). Offline matrix mirrors the
// web/tests/shader.test.mjs style: node imports web/naga-rt.mjs (pure lift +
// injectable pipeline, no DOM at module top level) alongside the vendored Naga
// build via ../vendor/naga/node.js — exactly how shader.test.mjs imports it.
//
// Fixture provenance (honest, per contract §5): no real guest-emitted GLSL is
// archived anywhere today (bridge logs carry fnIds/info-logs only), so the
// fixture is the contract §5.1 reconstruction of the wined3d FFP pair in its
// post-translateGlslToEs300 ES 3.00 form — the exact dialect the C1 capture
// sees. Real-source capture is the A2 follow-up; web/tests/naga-rt.test.mjs's
// BROWSER=1 e2e persists a live bwNagaDump() into test-results/ for it.
//
// BROWSER=1 node --test web/tests/naga-rt.test.mjs additionally boots the real
// runtime under ?naga=1 (route-injected into the app's runtime iframe URL, so
// app.mjs stays untouched) and drives the full installed pipeline through a
// real WebGL2 context in the runtime frame; the existing
// `node web/tests/browser.mjs` e2e stays the ?naga-absent regression gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import * as naga from '../vendor/naga/node.js';
import { liftForNaga, inferStage, createNagaPipeline, installNagaCapture, MAX_SHADER_BYTES } from '../naga-rt.mjs';

// node-side translate stand-in for the browser toWGSL path (same vendor build,
// same NagaError semantics — node.js re-exports web/vendor/naga/index.js).
const nodeTranslate = (src, stage) => Promise.resolve(String(naga.translate({ from: 'glsl', to: 'wgsl', source: src, parse: { stage } })));
const makePipeline = () => createNagaPipeline({ translate: nodeTranslate });

// --- contract §5.1 fixture: wined3d FFP pair, post-translateGlslToEs300 ES 3.00 ---
const VERT_ES300 = `#version 300 es
precision highp float;
precision highp int;
in vec4 bw_color;
in vec3 normal;
in vec4 position;
uniform mat4 mvp;
uniform mat3 normal_matrix;
out vec4 bw_texcoord[8];
out vec4 v_color;
void main() {
    gl_Position = mvp * position;
    v_color = bw_color;
    bw_texcoord[0] = vec4(position.xy, 0.0, 1.0);
    bw_texcoord[1] = vec4(normal, 0.0);
}`;
const FRAG_ES300 = `#version 300 es
precision highp float;
precision highp int;
in vec4 v_color;
in vec4 bw_texcoord[8];
uniform sampler2D tex;
out vec4 bw_FragColor;
void main() {
    bw_FragColor = texture(tex, bw_texcoord[0].xy) * v_color;
}`;

test('lift of the wined3d FFP pair: 450 core + synthesized bindings + sampler split', () => {
  const locMap = new Map();
  const v = liftForNaga(VERT_ES300, 'vertex', locMap);
  const f = liftForNaga(FRAG_ES300, 'fragment', locMap);
  assert.equal(v.ok, true, 'vertex lift: ' + (v.reason || ''));
  assert.equal(f.ok, true, 'fragment lift: ' + (f.reason || ''));
  // contract §5.1 assertions
  assert.match(v.code, /#version 450/);
  assert.match(f.code, /#version 450/);
  assert.match(v.code, /layout\(binding=0\) uniform mat4 mvp;/);
  assert.match(f.code, /layout\(binding=0\) uniform texture2D tex_bw_t;/);
  assert.match(f.code, /layout\(binding=1\) uniform sampler tex_bw_s;/);
  assert.match(f.code, /texture\(sampler2D\(tex_bw_t, tex_bw_s\),/);
  // locations/binding indices stable across the pair via the shared locMap
  const vTex = Number(/layout\(location=(\d+)\) out vec4 bw_texcoord\[8\]/.exec(v.code)[1]);
  const fTex = Number(/layout\(location=(\d+)\) in vec4 bw_texcoord\[8\]/.exec(f.code)[1]);
  const vCol = Number(/layout\(location=(\d+)\) out vec4 v_color/.exec(v.code)[1]);
  const fCol = Number(/layout\(location=(\d+)\) in vec4 v_color/.exec(f.code)[1]);
  assert.equal(vTex, fTex);
  assert.equal(vCol, fCol);
  // array varyings consume their full location span (Naga-measured): the [8]
  // array at 0 occupies 0..7, so the next varying lands at 8 in BOTH stages.
  assert.equal(vTex, 0);
  assert.equal(vCol, 8);
});

test('lifted FFP pair translates end-to-end through Naga to valid WGSL', () => {
  const locMap = new Map();
  const v = liftForNaga(VERT_ES300, 'vertex', locMap);
  const f = liftForNaga(FRAG_ES300, 'fragment', locMap);
  const vWgsl = String(naga.translate({ from: 'glsl', to: 'wgsl', source: v.code, parse: { stage: 'vertex' } }));
  const fWgsl = String(naga.translate({ from: 'glsl', to: 'wgsl', source: f.code, parse: { stage: 'fragment' } }));
  assert.match(vWgsl, /@builtin\(position\)/);
  assert.match(fWgsl, /@group\(0\) @binding\(/);
  assert.match(fWgsl, /@location\(0\)\s+bw_FragColor\s*:/);
});

test('KNOWN GAP parity: raw #version 120 is rejected by Naga directly, lifted instead', () => {
  const RAW = `#version 120
attribute vec4 position;
attribute vec4 colorIn;
varying vec4 colorV;
uniform mat4 mvp;
void main(){ colorV = colorIn; gl_Position = mvp * position; }`;
  assert.throws(() => naga.translate({ from: 'glsl', to: 'wgsl', source: RAW, parse: { stage: 'vertex' } }));
  const lifted = liftForNaga(RAW, 'vertex', new Map());
  assert.equal(lifted.ok, true, 'raw-120 lift: ' + (lifted.reason || ''));
  assert.match(lifted.code, /\bin vec4 position;/);   // attribute -> in
  assert.match(lifted.code, /\bout vec4 colorV;/);    // varying -> out (vertex)
  assert.match(lifted.code, /layout\(binding=0\) uniform mat4 mvp;/);
  const wgsl = String(naga.translate({ from: 'glsl', to: 'wgsl', source: lifted.code, parse: { stage: 'vertex' } }));
  assert.match(wgsl, /@builtin\(position\)/);
});

test('raw-120 fragment: FFP built-ins + texture2D + gl_FragData[0] lift cleanly', () => {
  const RAW = `#version 120
varying vec2 uv;
uniform sampler2D tex;
void main(){ gl_FragData[0] = texture2D(tex, uv); }`;
  const lifted = liftForNaga(RAW, 'fragment', new Map());
  assert.equal(lifted.ok, true, lifted.reason || '');
  assert.match(lifted.code, /\bin vec2 uv;/);                       // varying -> in
  assert.match(lifted.code, /out vec4 bw_FragColor;/);              // gl_FragData[0] -> out
  assert.match(lifted.code, /uniform texture2D tex_bw_t;/);
  assert.match(lifted.code, /texture\(sampler2D\(tex_bw_t, tex_bw_s\),/);
  const wgsl = String(naga.translate({ from: 'glsl', to: 'wgsl', source: lifted.code, parse: { stage: 'fragment' } }));
  assert.match(wgsl, /@location\(0\)\s+bw_FragColor\s*:/);
});

test('duplicate #version lines (wined3d bug) strip to exactly one stamped version', () => {
  const DUP = `#version 120
attribute vec4 position;
#version 120
void main(){ gl_Position = position; }`;
  const lifted = liftForNaga(DUP, 'vertex', new Map());
  assert.equal(lifted.ok, true, lifted.reason || '');
  assert.equal((lifted.code.match(/#version/g) || []).length, 1);
  assert.match(lifted.code, /^#version 450\n/);
});

test('size guard: >1 MiB source rejected before translate (mirrors web/shader.mjs)', () => {
  const big = '#version 300 es\nin float x;\nvoid main(){x=1.0;}\n//' + 'A'.repeat(MAX_SHADER_BYTES);
  assert.ok(big.length > MAX_SHADER_BYTES);
  const lifted = liftForNaga(big, 'fragment', new Map());
  assert.equal(lifted.ok, false);
  assert.equal(lifted.reason, 'too-large');
  assert.ok(!('code' in lifted));
});

test('stage inference parity with the bridge heuristic (both spellings)', () => {
  assert.equal(inferStage('out vec4 bw_FragColor;\nvoid main(){}'), 'fragment');
  assert.equal(inferStage('gl_FragData[0] = vec4(0.0);'), 'fragment');
  assert.equal(inferStage('void main(){ gl_Position = vec4(1.0); }'), 'vertex');
  assert.equal(inferStage('void main(){ gl_PointSize = 1.0; }'), 'vertex');
  assert.equal(inferStage('void main(){ }'), 'fragment'); // neither -> fragment (bridge parity)
});

test('pipeline failure paths: malformed GLSL never throws, ring record shape holds', async () => {
  const pipe = makePipeline();
  const malformed = '#version 120\nattribute vec3 p;\nvoid main(){ gl_Position = vec4(p, ; }';
  const out = await pipe.process(malformed);
  assert.equal(out, null);
  assert.equal(pipe.stats.nagaFail, 1);
  const rec = pipe.ring.find(r => r.type === 'naga');
  assert.ok(rec, 'naga ring record present');
  assert.equal(rec.stage, 'vertex');
  assert.equal(rec.kind, 'parse');
  assert.ok(Array.isArray(rec.firstLines) && rec.firstLines.length <= 6);
  assert.equal(rec.rawLen, malformed.length);
  assert.equal(typeof rec.liftedLen, 'number');
  // repeated processing must stay throw-free and keep counting
  await assert.doesNotReject(() => pipe.process('not even glsl'));
  await assert.doesNotReject(() => pipe.process(null));
  await assert.doesNotReject(() => pipe.process(42));
  await assert.doesNotReject(() => pipe.process(''));
});

test('pipeline: too-large and unsupported-version routes, counters and dedupe', async () => {
  const pipe = makePipeline();
  const big = '#version 300 es\nin float x;\nvoid main(){x=1.0;}\n//' + 'A'.repeat(MAX_SHADER_BYTES);
  assert.equal(await pipe.process(big), null);
  assert.equal(pipe.ring.at(-1).type, 'too-large');
  assert.equal(await pipe.process('#version 450\nlayout(location=0) in vec3 p;\nvoid main(){gl_Position=vec4(p,1.0);}', { stage: 'vertex' }), null);
  assert.equal(pipe.ring.at(-1).type, 'unsupported'); // ANGLE-owned, not a lane failure
  assert.equal(pipe.stats.captured, 2);
  assert.equal(pipe.stats.lifted, 0);
  assert.equal(pipe.stats.nagaFail, 1); // too-large counts; unsupported does not
  // happy path through the pipeline (wgsl validation absent in node)
  const ok = await pipe.process(FRAG_ES300);
  assert.ok(ok && ok.wgsl.length > 100);
  assert.deepEqual(
    { c: pipe.stats.captured, l: pipe.stats.lifted, t: pipe.stats.translated },
    { c: 3, l: 1, t: 1 },
  );
  // §3.4 dedupe: identical source recompile is a no-op
  assert.equal(await pipe.process(FRAG_ES300), null);
  assert.equal(pipe.stats.captured, 3);
  assert.equal(pipe.ring.at(-1).type, 'capture');
});

test('installNagaCapture degrades gracefully without WebGL2 (node smoke)', () => {
  assert.doesNotThrow(() => installNagaCapture());
  assert.equal(globalThis.__bw64NagaInstalled, true);
  assert.equal(typeof globalThis.bwNagaStats, 'function');
  assert.deepEqual(globalThis.bwNagaStats().broken, 1); // sticky-disabled, ANGLE fallback
  assert.doesNotThrow(() => installNagaCapture());      // idempotent re-install
});

// ---------------------------------------------------------------------------
// Browser e2e (opt-in: BROWSER=1) — the real runtime under ?naga=1.
// Boots the launcher app, route-injects naga=1 into the runtime iframe URL
// (app.mjs builds that URL; this lane must not touch it), then exercises the
// installed pipeline through a REAL WebGL2 context in the runtime frame: the
// patched shaderSource must pass through to ANGLE (compile succeeds) AND feed
// the Naga->WGSL shadow pipeline. glcube.exe is the fast boot; note it renders
// via glBegin (immediate mode), so the guest emits no shaders itself here —
// the §5.1 post-bridge fixture is injected through the patched prototype to
// exercise the capture path end-to-end in the page realm (A2 will swap in
// real wined3d sources via bwNagaDump persistence).
// ---------------------------------------------------------------------------
test('browser e2e: ?naga=1 runtime boots, patched shaderSource capture works, zero page errors', { skip: !process.env.BROWSER }, async t => {
  const { chromium } = await import('@playwright/test');
  const { serve } = await import('../../tools/browser/serve.mjs');
  const server = await serve('dist');
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], consoleErrors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240)); });
  page.on('requestfailed', r => consoleErrors.push('REQFAIL ' + r.url().slice(-80) + ' ' + (r.failure()?.errorText || '')));
  // Inject the flag into the runtime iframe URL the app builds (lane-safe).
  await page.route(u => u.pathname.endsWith('/runtime/index.html'), route => {
    const u = new URL(route.request().url());
    u.searchParams.set('naga', '1');
    return route.continue({ url: u.toString() });
  });
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.wineLibrary, {}, { timeout: 60000 });
    await page.click('[data-demo="glcube.exe"]');
    // Boot evidence: the wine session kernel is up (bw64_session_ready). The
    // guest window map additionally depends on the app's own progress — under
    // a loaded box it lags, so it is checked best-effort below.
    const frame = page.frames().find(f => f.url().includes('/runtime/'));
    assert.ok(frame, 'runtime frame present');
    await frame.waitForFunction(() => window.bwRuntime?.ready() === true, {}, { timeout: 300000 });
    // flag lane installed its page-realm exports before the launcher loaded
    assert.equal(await frame.evaluate(() => typeof window.bwNagaStats), 'function');
    assert.equal(await frame.evaluate(() => Array.isArray(window.__bw64NagaRing)), true);
    // Drive the patched prototype with the §5.1 ES 3.00 fixture on a REAL
    // context; the original ANGLE call must still run (shader compiles).
    const compiled = await frame.evaluate(async ([vert, frag]) => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      if (!gl) return { context: false };
      const make = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src); // wrapped: capture fires, ANGLE still gets it
        gl.compileShader(sh);
        return { sh, ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS), log: gl.getShaderInfoLog(sh) };
      };
      const v = make(gl.VERTEX_SHADER, vert);
      const f = make(gl.FRAGMENT_SHADER, frag);
      return { context: true, vOk: v.ok, fOk: f.ok, vLog: v.log, fLog: f.log };
    }, [VERT_ES300, FRAG_ES300]);
    assert.equal(compiled.context, true, 'WebGL2 context in runtime frame');
    assert.equal(compiled.vOk, true, 'vertex still compiled by ANGLE: ' + compiled.vLog);
    assert.equal(compiled.fOk, true, 'fragment still compiled by ANGLE: ' + compiled.fLog);
    // Pipeline drains asynchronously (wasm init + translate + device validate).
    await page.waitForFunction(() => {
      const s = window.bwNagaStats?.();
      return s && s.translated >= 2;
    }, {}, { timeout: 120000 });
    const stats = await frame.evaluate(() => window.bwNagaStats());
    assert.equal(stats.broken, 0);
    assert.ok(stats.captured >= 2, 'captured ' + JSON.stringify(stats));
    assert.ok(stats.lifted >= 2, 'lifted ' + JSON.stringify(stats));
    assert.ok(stats.translated >= 2, 'translated ' + JSON.stringify(stats));
    assert.ok(stats.wgslOk >= 2, 'wgslOk (WebGPU shadow validation) ' + JSON.stringify(stats));
    assert.deepEqual(errors, [], 'zero page errors under ?naga=1');
    // Best-effort ANGLE window evidence (non-fatal: guest-app progress is not
    // this lane's contract; the boot + capture assertions above are).
    let mapped = true;
    try {
      await page.waitForFunction(() => document.getElementById('log').textContent.includes('first window mapped'), {}, { timeout: 150000 });
    } catch { mapped = false; }
    console.log('guest window mapped under ?naga=1: ' + mapped);
    await page.screenshot({ path: 'test-results/naga-e2e.png', fullPage: true });
    // A2 free path: persist the observed sources (here: injected fixtures) for
    // the real-source corpus the contract §5 provenance note asks for.
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/naga-e2e-dump.json', JSON.stringify(await frame.evaluate(() => window.bwNagaDump()), null, 1));
    console.log('PASS ?naga=1 capture pipeline: ' + JSON.stringify(stats));
  } catch (error) {
    const diag = await page.evaluate(() => ({
      status: document.getElementById('status')?.textContent,
      logTail: document.getElementById('log')?.textContent.slice(-600),
    })).catch(() => ({}));
    console.log('DIAG', JSON.stringify(diag), 'consoleErrors:', JSON.stringify(consoleErrors.slice(-8)), 'pageErrors:', JSON.stringify(errors));
    await page.screenshot({ path: 'test-results/naga-e2e-fail.png', fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
    server.close();
  }
});
