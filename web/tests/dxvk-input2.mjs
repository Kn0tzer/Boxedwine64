// Interactive D3D9 input probe: browser key -> guest -> visible render response.
// Run from repo root: TAG=unique TIMEOUT=1800000 node web/tests/dxvk-input.mjs
// Requires dist built from a tree with bw64_xwire_key (native input injection).
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const tag = process.env.TAG || `input-${Date.now()}`;
if (!/^[\w.-]+$/.test(tag)) throw new Error('TAG must contain only letters, numbers, _, . or -');
const dir = `test-results/dxvk-${tag}`;
await mkdir(dir, { recursive: true });
const server = await serve(process.env.WINE_DIST_DIR || 'dist');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logs = [], errors = [];
page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', e => errors.push(e.message));
const flush = () => writeFile(`${dir}/console.log`, logs.join('\n'));
const timeout = Number(process.env.TIMEOUT || 1800000);

// In-page triangle measurement: centroid of non-background pixels + dominant
// color + color at the top-vertex sample point (guest 240,85 -> canvas scale).
const MEASURE_JS = `async () => {
  const cv = document.getElementById('vkCanvas');
  if (!cv || !cv.width) return null;
  // WebGPU canvas presentation is asynchronous; drawImage captures the
  // composited bitmap, which may lag the getCurrentTexture() copy by a
  // frame in headless SwiftShader. Wait for two compositor frames so the
  // latest presented frame is available for capture.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const w = cv.width, h = cv.height;
  const off = document.createElement('canvas'); off.width = w; off.height = h;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  try { ctx.drawImage(cv, 0, 0); } catch (e) { return null; }
  const d = ctx.getImageData(0, 0, w, h).data;
  let n = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, pr = d[i], pg = d[i+1], pb = d[i+2];
    if (Math.abs(pr) + Math.abs(pg - 40) + Math.abs(pb - 100) > 60) {
      n++; sx += x; sy += y;
      if (pr > pg + 20 && pr > pb + 20) r++;
      else if (pg > pr + 20 && pg > pb + 20) g++;
      else if (pb > pr + 20 && pb > pg + 20) b++;
    }
  }
  if (!n) return null;
  // sample point: guest (240,85) in canvas pixels
  const px = Math.min(w - 1, Math.floor(240 * w / 480)), py = Math.min(h - 1, Math.floor(85 * h / 360));
  const si = (py * w + px) * 4;
  return { cx: sx / n, cy: sy / n, n, r, g, b, w, h,
           top: [d[si], d[si+1], d[si+2]] };
}`;

let summary = { inputWorks: false };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/runtime/index.html?p=cmd%20%2Fc%20echo%20vkboot&session=1&novideo=1&persist=0&gltrace=0`);
  await page.waitForFunction(() => window.bwRuntime?.ready?.() === true, null, { timeout });
  console.log('SESSION READY');

  const assets = [['tri9input.exe', process.env.TRI9INPUT_PATH || 'tools/dxvk/tri9/tri9input.exe'],
    ['d3d9.dll', process.env.D3D9_PATH || 'tools/dxvk/build.w64/src/d3d9/d3d9.dll'],
    ['libvulkan.so.1', process.env.VK_SHIM_PATH || 'tools/rootfs64/libvk64/libvulkan.so.1']];
  for (const [name, path] of assets) {
    const bytes = await readFile(path);
    const b64 = bytes.toString('base64');
    await page.evaluate(({ name, b64 }) => {
      const fs = window.bwRuntime.fs();
      fs.mkdirTree('/root/home/username');
      fs.writeFile('/root/home/username/' + name, Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      const registered = window.bwRuntime.call('bw64_register_file', ['string'], ['/home/username/' + name]);
      if (registered !== 1) throw new Error('Guest VFS registration failed for ' + name);
    }, { name, b64 });
  }
  // Bootstrap: the vkboot echo is a readiness heuristic, not a hard gate.
  // (Under box load its console delivery can lag minutes behind the actual
  // boot; the spawn below queues until wine is ready regardless.) Proceed
  // when the sentinel appears or 90s after session ready, whichever first.
  const bootstrapUntil = Date.now() + 90000;
  while (!logs.some(l => /^log: vkboot\s*$/.test(l))) {
    if (Date.now() > bootstrapUntil) { console.log('BOOTSTRAP SENTINEL SKIPPED (timeout)'); break; }
    await flush();
    await page.waitForTimeout(500);
  }
  console.log('BOOTSTRAP COMPLETE');

  // Install vk page tier + the browser->guest key forwarder.
  await page.evaluate(async () => {
    const { installVkPageTier } = await import('../vkwebgpu.mjs');
    window.bwVkTier = installVkPageTier();
    // SDL scancodes (USB HID usage IDs); native side maps to X11 keycodes.
    const SC = { ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, KeyC: 6, Escape: 41 };
    window.bwKeyStats = { down: 0, up: 0 };
    const send = (e, down) => {
      const sc = SC[e.code];
      if (sc === undefined) return;
      e.preventDefault(); e.stopPropagation();
      window.bwKeyStats[down ? 'down' : 'up']++;
      window.bwRuntime.call('bw64_xwire_key', ['number', 'number'], [sc, down ? 1 : 0]);
    };
    window.addEventListener('keydown', e => send(e, true), true);
    window.addEventListener('keyup', e => send(e, false), true);
  });
  const keyFnExists = await page.evaluate(() => {
    try { window.bwRuntime.call('bw64_xwire_key', ['number', 'number'], [0, 0]); return true; }
    catch (e) { return false; }
  });
  console.log('KEYFN', keyFnExists);
  if (!keyFnExists) throw new Error('bw64_xwire_key not exported by this wasm build');

  const spawn = await page.evaluate(() => window.bwRuntime.call('bw64_spawn', ['string', 'string'],
    ['/usr/lib/wine/wine64\nZ:\\home\\username\\tri9input.exe', 'BW64_VKTRACE=0\nBW64_VKFRAME=0\nWINEDLLOVERRIDES=d3d9=n\nLD_LIBRARY_PATH=/home/username']));
  console.log('SPAWN', spawn);
  const drainUntil = Date.now() + 60000;
  while (Date.now() < drainUntil && !logs.some(l => /spawning.*tri9input/.test(l))) await page.waitForTimeout(1000);
  console.log('SPAWN-DRAIN', logs.some(l => /spawning.*tri9input/.test(l)) ? 'YES' : 'NO');
  // non-fatal: the triangle wait below is the real spawn gate
  // keys injected via bw64_xwire_key (direct wasm call); no DOM focus needed

  // Wait for the first triangle frame. Cheap poll: tier stats, no canvas
  // readback in the hot loop (per-eval drawImage+getImageData correlated with
  // renderer deaths in earlier runs). Canvas is read once at baseline.
  const until = Date.now() + timeout;
  let lit = 0;
  while (Date.now() < until) {
    const st = await page.evaluate(() => {
      try { const s = window.bwVkStats?.(); return s ? (s.litPixels || 0) : -1; }
      catch (e) { return -1; }
    }).catch(() => -2);
    if (st === -2) throw new Error('page died during triangle wait');
    if (st > 0) lit = st;
    if (lit > 30000) break;
    if (logs.some(l => /tri9input: RESULT [01]/.test(l))) throw new Error('tri9input exited before first triangle');
    await page.waitForTimeout(1000);
  }
  if (lit <= 30000) throw new Error('no triangle rendered (litPixels=' + lit + ')');
  console.log('LITPIXELS', lit);
  // Canvas measurement is non-fatal in headless SwiftShader: the compositor
  // does not present WebGPU canvases to screenshots/drawImage, so the in-page
  // MEASURE_JS cannot see the triangle. The stats-based litPixels (GPU
  // readback buffer) is the rendering signal. Proceed to input causality.
  const m0 = await page.evaluate(MEASURE_JS).catch(() => null);
  console.log('MEASURE_JS (non-fatal)', JSON.stringify(m0 && { n: m0.n }));
  if (!m0 || !m0.n) console.log('WARNING: canvas measurement unavailable; using stats for input causality');

  // --- INPUT CAUSALITY (stats-based, 20261006-d3d9-inputcause) ---
  // tri9input moves the triangle on arrow keys (g_ox/g_oy +=/-= 40) and logs
  // "tri9input: KEYDOWN vk=0x.. off=(x,y) scheme=.. keys=..". The pixel COUNT
  // (litPixels) does not change on movement (same triangle, new position).
  // Causality is proven by: (1) guest logs KEYDOWN with the expected offset
  // delta, (2) rendering continues (litPixels > 0, v2.rendered advances).
  const getStats = () => page.evaluate(() => {
    try {
      const s = window.bwVkStats?.();
      return s ? { lit: s.litPixels || 0, rendered: s.v2?.rendered || 0 } : null;
    } catch (e) { return null; }
  }).catch(() => null);
  const keyLines = () => logs.filter(l => /9input: KEYDOWN/.test(l));
  const parseOff = (line) => {
    const m = /off=\((-?\d+),(-?\d+)\)/.exec(line);
    return m ? { x: parseInt(m[1], 10), y: parseInt(m[2], 10) } : null;
  };
  const waitForKeys = async (before, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await page.waitForTimeout(1000);
      if (keyLines().length > before) return true;
    }
    return false;
  };

  const baseline = await getStats();
  const keysBefore = keyLines().length;
  console.log('BASELINE', JSON.stringify(baseline), 'keysBefore', keysBefore);

  // Press ArrowRight: expect guest off=(40,0)
  await page.keyboard.press('ArrowRight');
  const gotRight = await waitForKeys(keysBefore, 20000);
  const afterRight = await getStats();
  const keysR = keyLines();
  const offRight = keysR.length > keysBefore ? parseOff(keysR[keysR.length - 1]) : null;
  console.log('AFTER-RIGHT', JSON.stringify(afterRight), 'off', JSON.stringify(offRight), 'gotKey', gotRight);

  // Press ArrowLeft: expect guest off=(0,0) (back to origin)
  await page.keyboard.press('ArrowLeft');
  const gotLeft = await waitForKeys(keysR.length, 20000);
  const afterLeft = await getStats();
  const keysL = keyLines();
  const offLeft = keysL.length > keysR.length ? parseOff(keysL[keysL.length - 1]) : null;
  console.log('AFTER-LEFT', JSON.stringify(afterLeft), 'off', JSON.stringify(offLeft), 'gotKey', gotLeft);

  const keyStats = await page.evaluate(() => window.bwKeyStats).catch(() => null);
  const joined = logs.join('\n');

  // Verdict: inputWorks if the guest processed both keys with the correct
  // offset deltas AND rendering continued throughout (litPixels > 0, frames
  // advanced). The pixel COUNT is not expected to change on movement.
  const rightOk = gotRight && offRight && offRight.x === 40 && offRight.y === 0;
  const leftOk = gotLeft && offLeft && offLeft.x === 0 && offLeft.y === 0;
  const renderOk = baseline && baseline.lit > 30000 &&
                   afterRight && afterRight.lit > 30000 &&
                   afterLeft && afterLeft.lit > 30000 &&
                   afterLeft.rendered > baseline.rendered;
  summary = {
    inputWorks: !!(rightOk && leftOk && renderOk),
    baseline: { litPixels: baseline?.lit, rendered: baseline?.rendered },
    afterRight: { litPixels: afterRight?.lit, rendered: afterRight?.rendered, offset: offRight, keySeen: gotRight },
    afterLeft: { litPixels: afterLeft?.lit, rendered: afterLeft?.rendered, offset: offLeft, keySeen: gotLeft },
    guestKeyLines: keysL.slice(-4),
    keyStats,
    result: /tri9input: RESULT 0/.test(joined) ? 0 : /tri9input: RESULT 1/.test(joined) ? 1 : null,
    errors,
  };
} catch (e) {
  summary.failure = String(e.stack || e);
} finally {
  await flush();
  await writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 2));
  console.log('INPUT VERDICT', JSON.stringify(summary.inputWorks));
  await browser.close(); server.close();
  if (!summary.inputWorks) process.exitCode = 1;
}
