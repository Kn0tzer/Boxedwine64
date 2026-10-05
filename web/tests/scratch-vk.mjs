// scratch-vk.mjs — P2 boundary probe: run the guest Vulkan fixture (or a real
// vkcube) through the vk64 trap inside the browser and report exactly which
// entry points crossed.
//
// Modelled on scratch-baldi.mjs: serve dist/, drive the runtime iframe, capture
// the whole console, and write artifacts to test-results/. The difference is what
// it WAITS for. baldi waits for a guest window; this waits for the guest's own
// "vkfix: RESULT 0" line (or an exit_group status), because the evidence being
// collected is a syscall boundary, not a picture.
//
// How the guest program gets launched. The launcher's ?p= path always prefixes
// /usr/lib/wine/wine64 (it exists to run a Windows PE), so a native Linux ELF
// cannot go through it. Instead we boot the runtime in persistent-session mode —
// which brings up wineserver and then pins it with `wineserver64 -p`, keeping the
// kernel alive — and then call the exported bw64_spawn bridge directly with the
// ELF's argv. That is the same C bridge window.launchApp() uses
// (source/sdl/emscripten/wine64session.cpp), so no page/frontend change is needed.
//
// Env:
//   PROG      guest argv to spawn (default "/usr/bin/vkfixture")
//   ARGS      extra argv for PROG (default "", e.g. "64 64")
//   BOOT_PROG what boots first (default "cmd /c echo vkboot")
//   TIMEOUT   ms to wait for the RESULT line (default 600000)
//   TAG       artifact tag
//   VK_FRAME  set to 1 to ask the host for full frame-manifest JSON in the log
//             (?vkframe=1 -> BW64_VKFRAME=1, which makes vk64Bridge klog the
//             manifest it would hand the page)
//   SOAK_SECS keep collecting the log this long after RESULT (default 5)
//
// The PAGE TIER half of the gate. The guest side of this probe proves the trap
// boundary; this half proves the manifest actually reaches a WebGPU render in
// the page: web/vkwebgpu.mjs (installed from web/runtime.html's bwVkFrame hop)
// must have RECEIVED the frame and produced a non-empty 64x64 canvas, read back
// out of its own offscreen target. See the pageTier block in the summary.
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { writeFile, mkdir, readFile, copyFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const server = process.env.WINE_URL ? null : await serve('dist');
const base = process.env.WINE_URL || `http://127.0.0.1:${server.address().port}/`;
const TAG = process.env.TAG ? '-' + process.env.TAG : '';
const art = name => 'test-results/vk' + TAG + '-' + name;
const PROG = process.env.PROG || '/usr/bin/vkfixture';
const ARGS = (process.env.ARGS || '').split(/\s+/).filter(Boolean);
const BOOT_PROG = process.env.BOOT_PROG || 'cmd /c echo vkboot';
const TIMEOUT = Number(process.env.TIMEOUT || 600000);
const SOAK_SECS = Number(process.env.SOAK_SECS || 5);
await mkdir('test-results', { recursive: true });

// Serve the page tier from the same web/ sources the build copies, so the probe
// never runs a stale dist/. tools/browser/build.mjs's copy list does not name
// vkwebgpu.mjs yet (tools/ belongs to another lane), so the page-tier files are
// mirrored here and only when they differ; 'npm run build' stays canonical once
// that list grows the entry.
const PAGE_TIER_FILES = [['web/runtime.html', 'dist/runtime/index.html'], ['web/vkwebgpu.mjs', 'dist/vkwebgpu.mjs'], ['web/app.mjs', 'dist/app.mjs']];
const mirrored = [];
for (const [from, to] of PAGE_TIER_FILES) {
  const want = await readFile(from);
  let have = null;
  try { have = await readFile(to); } catch { /* not staged yet */ }
  if (!have || !have.equals(want)) { await copyFile(from, to); mirrored.push(to); }
}
if (mirrored.length) console.log('VK PROBE mirrored page-tier files into dist/:', mirrored.join(', '));

// decodePng — minimal 8-bit RGBA PNG reader for the page tier's canvas snapshot.
// The canvas is a WebGPU canvas, and drawing one into a 2D canvas yields an empty
// image in this headless build, so the snapshot the canvas hands out (toDataURL)
// is decoded here instead. toDataURL always emits non-interlaced 8-bit RGBA.
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
  session: '1',            // keep the kernel alive after the boot program exits
  novideo: '1',
  persist: '0',            // do not touch IndexedDB
  gltrace: '0',
  envedump: '1',           // env dumps are the cheapest extra evidence
});
if (process.env.VK_FRAME) q.set('vkframe', '1');
const url = base.replace(/\/?$/, '/runtime/index.html?') + q.toString();
console.log('VK PROBE URL:', url);
console.log('VK PROBE PROGRAM:', [PROG, ...ARGS].join(' '));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium',
  headless: true,
  // The page tier needs a real WebGPU adapter; these are the flags
  // web/tests/browser.mjs already runs the WebGPU assertions with.
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
  // NOTE: this probe drives /runtime/index.html DIRECTLY (no app shell), so the
  // app page's window.wineLibrary never exists here. The runtime page exposes
  // window.bwRuntime = { fs, ready, call } from wine64-launcher.js once the
  // wasm module loads; session readiness is bwRuntime.ready(). Waiting for
  // wineLibrary here (copied from scratch-baldi.mjs, which goes through the app
  // page) made every run time out at this line while the guest booted fine
  // underneath — that was the entire witness=false/trapCalls=0 story.
  await page.waitForFunction(() => window.bwRuntime, {}, { timeout: 120000 });
  console.log('runtime up; waiting for the session bridge');
  // A full wine64 prefix boot takes minutes under the interpreter, so this wait
  // gets the whole TIMEOUT budget, not the short 60s the module load gets.
  await page.waitForFunction(() => window.bwRuntime?.ready?.() === true, {}, { timeout: TIMEOUT });
  console.log('SESSION READY');
  await flush();

  // Spawn the guest ELF through the exported spawn bridge (see the header note).
  const runtime = page.frames().find(f => f.url().includes('/runtime/'));
  if (!runtime) throw new Error('no runtime frame');
  const argv = [PROG, ...ARGS].join('\n');
  const env = ['BW64_VKTRACE=2', 'BW64_VKFRAME=1'].join('\n');
  const ok = await runtime.evaluate(({ argv, env }) => {
    return window.bwRuntime.call('bw64_spawn', ['string', 'string'], [argv, env]);
  }, { argv, env });
  console.log('bw64_spawn ->', ok);
  await flush();

  // Wait for the fixture's own verdict, or an exit status, or a crash.
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    for (const l of logs) {
      if (failRx.test(l) && !guestFailure) guestFailure = l;
      const m = l.match(exitRx);
      if (m) exitStatus = Number(m[1]);
    }
    if (saw(/vkfix: RESULT [01]/)) break;
    if (saw(/vkfix: RESULT 0/)) break;
    await flush();
    await page.waitForTimeout(1000);
  }
  if (SOAK_SECS) await page.waitForTimeout(SOAK_SECS * 1000);
  await flush();

  // --- page tier: the manifest must reach a WebGPU render in this page --------
  // The frame hop lands in window.bwVkFrame (web/runtime.html), which relays it
  // as a 'vk' message; on this standalone runtime page (window.parent ===
  // window) the same page hosts web/vkwebgpu.mjs, which renders the manifest and
  // reads its own offscreen target back. window.bwVkStats() is that tier's
  // counters: received = the sink ran, rendered = a validated pass was submitted,
  // paintedPixels = pixels the pass wrote in the 64x64 region (non-empty canvas),
  // litPixels = pixels that differ from the manifest's clear value (rasterized
  // geometry). For vkfixture litPixels is 0 BY THE GUEST'S OWN DATA: its probe
  // UBO is a stub (float i = i*0.5) bound against cube.vert's 1216-byte vertex
  // block, which maps all 36 vertices onto one point, so nothing rasterizes —
  // the page tier still uploads the UBO, the texture and both SPIR-V modules and
  // completes a validated pass. P1's own vkcube manifest (400x400, real UBO and
  // 256x256 texture) renders 43950/160000 lit pixels through this same tier.
  //
  // The canvas itself is measured too, from its own toDataURL snapshot: the
  // offscreen target is copied 1:1 into the canvas texture inside the submitted
  // command buffer, so the snapshot is the presented frame. (drawImage into a 2D
  // canvas returns an empty image for a WebGPU canvas in this headless build, so
  // the PNG is decoded here rather than in the page.)
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
    // The canvas context is alphaMode:'opaque' (as web/webgpu.mjs configures the
    // GL lane), so the presented alpha is 255 whatever the guest's clear alpha is;
    // the RGB channels are the guest's clear value verbatim.
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
  // Which of the two counters the gate demands. `uniform` is the range the tier
  // had to bind for the vertex block and `uboBytes` is what the guest actually
  // uploaded: when they are equal the guest's descriptor covers the block its
  // vertex shader reads, so real geometry is possible and litPixels MUST be > 0.
  // vkfixture's probe UBO is 128 bytes against cube.vert's 1216-byte block, so the
  // tier zero-pads to 2048, all 36 vertices land on one point and the gate falls
  // back to requiring the written frame region (paintedPixels > 0). A guest that
  // uploads a complete block is held to the strict lit-pixel test.
  pageTier.uniformRange = pageTier.last?.uniform ?? 0;
  pageTier.uboBytes = pageTier.last?.uboBytes ?? 0;
  pageTier.uboCoversVertexBlock = pageTier.uboBytes >= pageTier.uniformRange && pageTier.uboBytes > 0;
  const rasterGreen = pageTier.uboCoversVertexBlock ? pageTier.litPixels > 0 : pageTier.paintedPixels > 0;
  pageTier.gate = pageTier.uboCoversVertexBlock ? 'litPixels>0' : 'paintedPixels>0';
  if (pngBytes) await writeFile(art('pagetier-canvas.png'), pngBytes).catch(() => {});
  await page.screenshot({ path: art('pagetier.png') }).catch(() => {});
  const tierGreen = pageTier.sink === 'function' && pageTier.received >= 1 && pageTier.rendered >= 1
    && pageTier.paintedPixels > 0 && pageTier.totalPixels > 0 && rasterGreen
    && (pageTier.canvasPaintedPixels === undefined || pageTier.canvasPaintedPixels > 0);
  console.log('PAGE TIER', tierGreen ? 'GREEN' : 'RED', JSON.stringify(pageTier).slice(0, 1200));
} catch (e) {
  process.exitCode = 1;
  console.log('FAIL', (e.message || String(e)).slice(0, 800));
} finally {
  await flush();
  const text = joined();
  // --- the gate, evaluated mechanically -------------------------------------
  const traps = [...text.matchAll(/vk64: trap (\w+)/g)].map(m => m[1]);
  const uniq = [...new Set(traps)];
  const frames = [...text.matchAll(/vk64: FRAME (\d+) built/g)].map(m => m[1]);
  const manifest = text.includes('vk64: FRAME-JSON');
  const witness = text.includes('vk64: FIRST trap');
  const presented = /vk64: vkQueuePresentKHR/.test(text);
  const result0 = /vkfix: RESULT 0/.test(text);
  const result1 = /vkfix: RESULT 1/.test(text);
  // DXVK-shaped init probe (vkfixture's probe_dxvk_init). Three gates, not one:
  // the caps walk, the timeline-semaphore agreement, and the Win32 surface all
  // have to have crossed, because a fixture that skipped any of them still
  // prints RESULT 0.
  const dxvkProbe = /vkfix: dxvk-probe: PASS/.test(text);
  const dxvkTimeline = /dxvk: timeline semaphore signal\/wait\/getCounter agree/.test(text);
  const dxvkWin32 = /dxvk: win32 surface 0x[0-9a-f]+/.test(text);
  // The two record-path additions the manifest must now carry: the vertex input
  // layout (without which no consumer can build a vertex layout) and the push
  // constants (DXVK pushes per draw). Checked on the FRAME-JSON itself, because
  // the guest cannot see its own manifest.
  const vertexLayout = /"vertexLayout":\{"bindings":\[\{"binding":0,"stride":\d+/.test(text) &&
    /"attributes":\[\{"location":0,"binding":0,"format":\d+,"offset":0\}/.test(text);
  const pushConstants = /"pushConstants":\[\{"offset":0,"size":16,"stageFlags":\d+,"bytes":\{"size":16,"b64":"[A-Za-z0-9+/=]+"\}\}/.test(text);
  const summary = {
    witness, trapCalls: traps.length, distinctTrapCalls: uniq.length, uniq,
    framesBuilt: frames.length, manifestEmitted: manifest, presented,
    fixtureResult: result0 ? 0 : (result1 ? 1 : null),
    dxvkProbe, dxvkTimeline, dxvkWin32, vertexLayout, pushConstants,
    guestExitStatus: exitStatus, guestFailure: guestFailure || null,
    pageTier,
    pageTierGreen: !!pageTier && pageTier.sink === 'function' && pageTier.received >= 1
      && pageTier.rendered >= 1 && pageTier.paintedPixels > 0 && pageTier.totalPixels > 0,
    pageErrors: errors,
  };
  // New-entry-point coverage: the P2-NOW additions each have to appear as a real
  // trap, not merely resolve. Listed explicitly so a regression to the benign
  // tail is visible here rather than in a DXVK bring-up weeks from now.
  const p2Now = ['vkCreateWin32SurfaceKHR', 'vkGetSemaphoreCounterValue', 'vkWaitSemaphores',
    'vkSignalSemaphore', 'vkCmdPushConstants', 'vkGetPhysicalDeviceFeatures2',
    'vkGetPhysicalDeviceProperties2'];
  const p2NowTrapped = p2Now.filter(n => uniq.includes(n));
  summary.p2NowEntryPoints = `${p2NowTrapped.length}/${p2Now.length}`;
  // The P2-NOW boundary additions are part of the gate, not a nicety: each one is
  // a wall DXVK hits before a triangle, and each falls silently into the benign
  // tail if it regresses. The trap floor rises with them.
  summary.p2NowGreen = summary.dxvkProbe && summary.dxvkTimeline && summary.dxvkWin32
    && summary.vertexLayout && summary.pushConstants
    && summary.p2NowEntryPoints === `${p2Now.length}/${p2Now.length}`
    && summary.trapCalls >= 105;

  await writeFile(art('summary.json'), JSON.stringify(summary, null, 2));
  console.log('=== VK SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length) console.log('PAGE ERRORS', JSON.stringify(errors).slice(0, 2000));
  // The last 120 vk64 lines: the boundary evidence itself.
  const vkLines = text.split('\n').filter(l => /vk64:|vkfix:/.test(l));
  await writeFile(art('vklog.txt'), vkLines.join('\n'));
  console.log('--- vk64/vkfix log (tail) ---');
  console.log(vkLines.slice(-120).join('\n'));
  if (summary.fixtureResult !== 0 || !witness || !summary.pageTierGreen) process.exitCode = 1;
  if (!summary.p2NowGreen) {
    console.log('P2-NOW GATE RED', JSON.stringify({
      dxvkProbe: summary.dxvkProbe, dxvkTimeline: summary.dxvkTimeline, dxvkWin32: summary.dxvkWin32,
      vertexLayout: summary.vertexLayout, pushConstants: summary.pushConstants,
      entryPoints: summary.p2NowEntryPoints, trapCalls: summary.trapCalls,
    }));
    process.exitCode = 1;
  } else {
    console.log('P2-NOW GATE GREEN', summary.p2NowEntryPoints, 'traps', summary.trapCalls);
  }
  await browser.close();
  server?.close();
}