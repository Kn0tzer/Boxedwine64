// scratch-dxvk.mjs — G2 bring-up probe: D3D9 clear + indexed triangle through
// DXVK 2.4.x -> wine vulkan-1.dll -> winevulkan -> our vk64 shim -> FRAME-JSON
// -> WebGPU, per the G2 definition (tasks/verdict.md).
//
// Modelled on scratch-vk.mjs: serve dist/, drive the runtime iframe, capture
// the whole console, write artifacts to test-results/. Two differences:
//   1. The guest program is a WINDOWS PE, so it spawns through wine64 exactly
//      like the launcher's ?p= path does: argv = [wine64, tri9.exe] via the
//      bw64_spawn bridge, with WINEDLLOVERRIDES=d3d9=n so wine takes DXVK's
//      native d3d9.dll (staged next to tri9.exe) over its builtin wined3d one.
//   2. The verdict it waits for is the app's own "tri9: RESULT 0" line, and the
//      gate is the CHAIN EVIDENCE, not lit pixels: the manifest schema that
//      could carry vertex/index BYTES (schema v2) does not exist yet, so no
//      page tier can rasterize DXVK's triangle today. What this probe proves is
//      every link up to that wall: shim dlopened by winevulkan (witness),
//      DXVK instance+device creation against our advertised caps, timeline
//      semaphore traffic, win32 surface, submits with draws, presents with
//      pResults, and a manifest carrying DXVK's vertex layout + push constants
//      reaching a WebGPU render (paintedPixels > 0).
//
// Env:
//   PROG      wine64 argv[0] (default "/usr/lib/wine/wine64")
//   ARGS      extra argv (default "tri9.exe")
//   BOOT_PROG what boots first (default "cmd /c echo vkboot")
//   TIMEOUT   ms to wait for the RESULT line (default 1800000 — DXVK compiles
//             its fixed-function/shader corpus on the emulated CPU at device
//             creation, which is slow)
//   TAG       artifact tag (default "dxvk")
//   OVERRIDES WINEDLLOVERRIDES value (default "d3d9=n")
//   SOAK_SECS keep collecting the log this long after RESULT (default 10)
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { writeFile, mkdir, readFile, copyFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const server = process.env.WINE_URL ? null : await serve('dist');
const base = process.env.WINE_URL || `http://127.0.0.1:${server.address().port}/`;
const TAG = process.env.TAG ? '-' + process.env.TAG : '-dxvk';
const art = name => 'test-results/dxvk' + TAG + '-' + name;
const PROG = process.env.PROG || '/usr/lib/wine/wine64';
const ARGS = (process.env.ARGS || 'tri9.exe').split(/\s+/).filter(Boolean);
const BOOT_PROG = process.env.BOOT_PROG || 'cmd /c echo vkboot';
const TIMEOUT = Number(process.env.TIMEOUT || 1800000);
const SOAK_SECS = Number(process.env.SOAK_SECS || 10);
const OVERRIDES = process.env.OVERRIDES || 'd3d9=n';
await mkdir('test-results', { recursive: true });

// Same page-tier mirroring as scratch-vk.mjs (see its comment): never run stale.
const PAGE_TIER_FILES = [['web/runtime.html', 'dist/runtime/index.html'], ['web/vkwebgpu.mjs', 'dist/vkwebgpu.mjs'], ['web/app.mjs', 'dist/app.mjs']];
const mirrored = [];
for (const [from, to] of PAGE_TIER_FILES) {
  const want = await readFile(from);
  let have = null;
  try { have = await readFile(to); } catch { /* not staged yet */ }
  if (!have || !have.equals(want)) { await copyFile(from, to); mirrored.push(to); }
}
if (mirrored.length) console.log('DXVK PROBE mirrored page-tier files into dist/:', mirrored.join(', '));

// decodePng — copied from scratch-vk.mjs (minimal 8-bit RGBA PNG reader).
function decodePng(buf) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  let at = 8, width = 0, height = 0, depth = 0, colour = 0;
  const idat = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; colour = body[9]; }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!width || !height || !idat.length || depth !== 8) return null;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour];
  if (!channels) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0, v = line[x];
      out[x] = (v + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1
        : paeth(a, b, c))) & 0xff;
    }
    prev = out;
  }
  return { width, height, pixels };
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

const q = new URLSearchParams({
  p: BOOT_PROG,
  session: '1',
  novideo: '1',
  persist: '0',
  gltrace: '0',
  envedump: '1',
});
if (process.env.VK_FRAME) q.set('vkframe', '1');
const url = base.replace(/\/?$/, '/runtime/index.html?') + q.toString();
console.log('DXVK PROBE URL:', url);
console.log('DXVK PROBE PROGRAM:', [PROG, ...ARGS].join(' '));
console.log('DXVK PROBE OVERRIDES:', OVERRIDES);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader', '--use-angle=vulkan', '--use-vulkan=swiftshader',
    '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [], logs = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => logs.push(m.type() + ': ' + m.text()));

const flush = () => writeFile(art('console.log'), logs.join('\n').slice(-4000000)).catch(() => {});
const joined = () => logs.join('\n');
const saw = rx => logs.some(l => rx.test(l));

let guestFailure;
let pageTier = null;
const failRx = /unimpl opcode|Aborted\(|RuntimeError:|unreachable|memory access out of bounds/;
const exitRx = /exit_group syscall, status=(\d+)/;
let exitStatus = null;

try {
  await page.goto(url);
  await page.waitForFunction(() => window.bwRuntime, {}, { timeout: 120000 });
  console.log('runtime up; waiting for the session bridge');
  await page.waitForFunction(() => window.bwRuntime?.ready?.() === true, {}, { timeout: TIMEOUT });
  console.log('SESSION READY');
  await flush();

  const runtime = page.frames().find(f => f.url().includes('/runtime/'));
  if (!runtime) throw new Error('no runtime frame');
  const argv = [PROG, ...ARGS].join('\n');
  const envParts = ['BW64_VKTRACE=2', 'BW64_VKFRAME=1', `WINEDLLOVERRIDES=${OVERRIDES}`];
  // WDEBUG: extra guest env, e.g. WDEBUG='WINEDEBUG=+vulkan' to see winevulkan's
  // dlopen/dlsym steps when the chain breaks below DXVK (no code change needed).
  if (process.env.WDEBUG) envParts.push(process.env.WDEBUG);
  const env = envParts.join('\n');
  const ok = await runtime.evaluate(({ argv, env }) => {
    return window.bwRuntime.call('bw64_spawn', ['string', 'string'], [argv, env]);
  }, { argv, env });
  console.log('bw64_spawn ->', ok);
  await flush();

  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    for (const l of logs) {
      if (failRx.test(l) && !guestFailure) guestFailure = l;
      const m = l.match(exitRx);
      if (m) exitStatus = Number(m[1]);
    }
    if (saw(/tri9: RESULT [01]/)) break;
    await flush();
    await page.waitForTimeout(1000);
  }
  if (SOAK_SECS) await page.waitForTimeout(SOAK_SECS * 1000);
  await flush();

  // --- page tier (same block as scratch-vk.mjs) ------------------------------
  pageTier = await page.evaluate(() => {
    const stats = typeof window.bwVkStats === 'function' ? window.bwVkStats() : null;
    const canvas = document.getElementById('vkCanvas');
    return {
      sink: typeof window.bwVkFrame, tier: typeof window.bwVkTier,
      canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
      clear: stats?.last?.clear || null,
      png: canvas ? canvas.toDataURL('image/png') : null,
      received: stats?.received ?? 0, rendered: stats?.rendered ?? 0,
      litPixels: stats?.litPixels ?? 0, paintedPixels: stats?.paintedPixels ?? 0,
      totalPixels: stats?.totalPixels ?? 0, errors: stats?.errors ?? ['page tier never installed'],
      last: stats?.last || null, pipeline: stats?.pipeline || null,
    };
  });
  const pngBytes = pageTier.png ? Buffer.from(pageTier.png.split(',')[1], 'base64') : null;
  delete pageTier.png;
  const shot = pngBytes ? decodePng(pngBytes) : null;
  pageTier.canvas = pageTier.canvas || (shot ? { w: shot.width, h: shot.height } : null);
  pageTier.canvasPngBytes = pngBytes ? pngBytes.length : 0;
  if (shot && pageTier.clear) {
    const want = [...pageTier.clear.slice(0, 3).map(c => Math.round(c * 255)), 255];
    let painted = 0, lit = 0;
    for (let i = 0; i < shot.pixels.length; i += 4) {
      const r = shot.pixels[i], g = shot.pixels[i + 1], b = shot.pixels[i + 2], a = shot.pixels[i + 3];
      if (r || g || b || a) painted++;
      if (r !== want[0] || g !== want[1] || b !== want[2] || a !== want[3]) lit++;
    }
    pageTier.canvasPaintedPixels = painted;
    pageTier.canvasLitPixels = lit;
  }
  if (pngBytes) await writeFile(art('pagetier-canvas.png'), pngBytes).catch(() => {});
  await page.screenshot({ path: art('pagetier.png') }).catch(() => {});
  const tierGreen = pageTier.sink === 'function' && pageTier.received >= 1 && pageTier.rendered >= 1
    && pageTier.paintedPixels > 0 && pageTier.totalPixels > 0
    && (pageTier.canvasPaintedPixels === undefined || pageTier.canvasPaintedPixels > 0);
  console.log('PAGE TIER', tierGreen ? 'GREEN' : 'RED', JSON.stringify(pageTier).slice(0, 1200));
} catch (e) {
  process.exitCode = 1;
  console.log('FAIL', (e.message || String(e)).slice(0, 800));
} finally {
  await flush();
  const text = joined();
  // --- the G2 chain gate, evaluated mechanically -----------------------------
  const traps = [...text.matchAll(/vk64: trap (\w+)/g)].map(m => m[1]);
  const uniq = [...new Set(traps)];
  const frames = [...text.matchAll(/vk64: FRAME (\d+) built/g)].map(m => m[1]);
  const manifest = text.includes('vk64: FRAME-JSON');
  // (1) winevulkan dlopened OUR shim: the load-time witness fires from the
  // shim's constructor the moment the guest maps libvulkan.so.1.
  const witness = text.includes('vk64: FIRST trap');
  const presented = /vk64: vkQueuePresentKHR/.test(text);
  const triResult0 = /tri9: RESULT 0/.test(text);
  const triResult1 = /tri9: RESULT 1/.test(text);
  // DXVK's own voice (stderr through the guest fd pipe): device creation and
  // the "Enabled device extensions" dump prove isCompatible+createDevice.
  const dxvkDevice = /tri9: device created OK/.test(text);
  const dxvkExtDump = /Enabled device extensions:/.test(text);
  const dxvkNoAdapters = /No adapters found/.test(text);
  // (3) per-flush tracking fence: all three quartet members must have crossed.
  const timeline = ['vkGetSemaphoreCounterValue', 'vkWaitSemaphores', 'vkSignalSemaphore']
    .every(n => uniq.includes(n));
  const win32surface = uniq.includes('vkCreateWin32SurfaceKHR');
  // DXVK-shaped manifest: a real vertex layout (FVF -> declarations) and the
  // per-draw push constants DXVK emits for nearly everything.
  const vertexLayout = /"vertexLayout":\{"bindings":\[/.test(text);
  const pushConstants = /"pushConstants":\[/.test(text);
  // The exact failing link, when the chain stops: unimplemented-name reports
  // name the entry point whose absence stopped DXVK (dynamic rendering lands
  // here first), and the bridge's skip reasons name the serializer wall.
  const unimplemented = [...new Set([...text.matchAll(/asked-for \(unimplemented\): (\w+)/g)].map(m => m[1]))];
  const noFramebuffer = (text.match(/has no framebuffer, skipped/g) || []).length;
  const noDraw = (text.match(/without draw/g) || []).length;
  const summary = {
    witness, trapCalls: traps.length, distinctTrapCalls: uniq.length, uniq,
    framesBuilt: frames.length, manifestEmitted: manifest, presented,
    tri9Result: triResult0 ? 0 : (triResult1 ? 1 : null),
    dxvkDevice, dxvkExtDump, dxvkNoAdapters,
    timeline, win32surface, vertexLayout, pushConstants,
    unimplemented, noFramebufferSkips: noFramebuffer, noDrawSkips: noDraw,
    guestExitStatus: exitStatus, guestFailure: guestFailure || null,
    pageTier,
    pageTierGreen: !!pageTier && pageTier.sink === 'function' && pageTier.received >= 1
      && pageTier.rendered >= 1 && pageTier.paintedPixels > 0 && pageTier.totalPixels > 0,
    pageErrors: errors,
  };
  // G2-chain gate: every link up to the schema-v2 wall. litPixels is
  // deliberately NOT gated here (vertex/index BYTES do not cross yet, so no
  // consumer can rasterize the triangle — that is schema v2 + the .inc
  // transplants, not this probe).
  summary.chainGreen = summary.witness && summary.dxvkDevice && summary.timeline
    && summary.win32surface && summary.framesBuilt >= 1 && summary.manifestEmitted
    && summary.presented && summary.vertexLayout && summary.pushConstants
    && summary.pageTierGreen && summary.tri9Result === 0;

  await writeFile(art('summary.json'), JSON.stringify(summary, null, 2));
  console.log('=== DXVK SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length) console.log('PAGE ERRORS', JSON.stringify(errors).slice(0, 2000));
  const vkLines = text.split('\n').filter(l => /vk64:|tri9:|dxvk:|info:|warn:|err:/.test(l));
  await writeFile(art('vklog.txt'), vkLines.join('\n'));
  console.log('--- vk64/tri9/dxvk log (tail) ---');
  console.log(vkLines.slice(-150).join('\n'));
  if (!summary.chainGreen) {
    console.log('G2-CHAIN GATE RED', JSON.stringify({
      witness: summary.witness, dxvkDevice: summary.dxvkDevice, timeline: summary.timeline,
      win32surface: summary.win32surface, frames: summary.framesBuilt,
      manifest: summary.manifestEmitted, presented: summary.presented,
      vertexLayout: summary.vertexLayout, pushConstants: summary.pushConstants,
      pageTierGreen: summary.pageTierGreen, tri9Result: summary.tri9Result,
      unimplemented: summary.unimplemented,
      noFramebufferSkips: summary.noFramebufferSkips, noDrawSkips: summary.noDrawSkips,
    }));
    process.exitCode = 1;
  } else {
    console.log('G2-CHAIN GATE GREEN', `frames=${summary.framesBuilt}`, `traps=${summary.trapCalls}`);
  }
  await browser.close();
  server?.close();
}
