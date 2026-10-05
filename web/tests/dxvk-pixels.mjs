// Actual tri9 -> DXVK -> shim -> v2 -> WebGPU pixel gate. Clear-only fails.
// Run from repo root: TAG=unique TIMEOUT=1800000 node web/tests/dxvk-pixels.mjs
// Uses existing dist artifacts, preserving their provenance. No build/deploy.
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { trianglePixels } from './dxvk-pixel-analysis.mjs';
import { parseV2Chunk, V2FrameAssembler, decodeV2Frame } from '../vkwebgpu.mjs';
import { createHash } from 'node:crypto';

const tag = process.env.TAG || `pixels-${Date.now()}`;
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
const logs = [], errors = [], chunkFiles = [], decodedFrames = [];
const capturedAssembler = new V2FrameAssembler();
page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', e => errors.push(e.message));
const flush = () => writeFile(`${dir}/console.log`, logs.join('\n'));
await page.exposeFunction('saveVkChunk', async b64 => {
  const file = `chunk-${String(chunkFiles.length).padStart(4, '0')}.bin`;
  chunkFiles.push(file);
  const bytes = Buffer.from(b64, 'base64');
  const records = capturedAssembler.ingest(parseV2Chunk(bytes));
  if (records) {
    const frame = decodeV2Frame(records);
    decodedFrames.push({ frame: frame.frameNo, w: frame.width, h: frame.height,
      attachments: frame.passes.flatMap(p => p.attachments).length,
      indexedDraws: frame.passes.flatMap(p => p.ops).filter(o => o.op === 'draw' && o.indexed).length,
      draws: frame.passes.flatMap(p => p.ops).filter(o => o.op === 'draw').length });
  }
  await writeFile(`${dir}/${file}`, bytes);
});
const timeout = Number(process.env.TIMEOUT || 1800000);
let summary = { passed: false }, pixels = null;
const provenance = [];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/runtime/index.html?p=cmd%20%2Fc%20echo%20vkboot&session=1&novideo=1&persist=0&gltrace=0`);
  await page.waitForFunction(() => window.bwRuntime?.ready?.() === true, null, { timeout });
  console.log('SESSION READY');
  // The repository's prefix can be rebuilt independently and omit probe assets.
  // Stage into this disposable guest only; never rewrite the user's zip.
  const assets = [['tri9.exe', process.env.TRI9_PATH || 'tools/dxvk/tri9/tri9.exe'],
    ['d3d9.dll', process.env.D3D9_PATH || 'tools/dxvk/build.w64/src/d3d9/d3d9.dll'],
    ['libvulkan.so.1', process.env.VK_SHIM_PATH || 'tools/rootfs64/libvk64/libvulkan.so.1']];
  for (const [name, path] of assets) {
    const bytes = await readFile(path);
    provenance.push({ name, path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    const b64 = bytes.toString('base64');
    await page.evaluate(({ name, b64 }) => {
      const fs = window.bwRuntime.fs();
      fs.mkdirTree('/root/home/username');
      fs.writeFile('/root/home/username/' + name, Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      // Guest directory nodes are cached separately from MEMFS; use the
      // launcher's queued registration API before queued process spawn.
      const registered = window.bwRuntime.call('bw64_register_file', ['string'], ['/home/username/' + name]);
      if (registered !== 1) throw new Error('Guest VFS registration failed for ' + name);
    }, { name, b64 });
  }
  const bootstrapUntil = Date.now() + timeout;
  while (!logs.some(l => /^log: vkboot\s*$/.test(l))) {
    if (Date.now() > bootstrapUntil) throw new Error('Wine bootstrap sentinel timed out');
    await flush();
    await page.waitForTimeout(500);
  }
  console.log('BOOTSTRAP COMPLETE');
  await page.evaluate(async () => {
    const { installVkPageTier } = await import('../vkwebgpu.mjs');
    window.bwVkTier = installVkPageTier();
    window.bwVkTierReady = Promise.resolve(window.bwVkTier);
    const original = window.bwVkChunk;
    window.bwVkChunk = (bytes, flags) => {
      // Capture actual producer bytes before parent.postMessage transfers them.
      let str = '';
      for (let i = 0; i < bytes.length; i += 8192) str += String.fromCharCode(...bytes.subarray(i, i + 8192));
      window.saveVkChunk(btoa(str));
      return original(bytes, flags);
    };
  });
  const spawn = await page.evaluate(() => window.bwRuntime.call('bw64_spawn', ['string', 'string'],
    ['/usr/lib/wine/wine64\nZ:\\home\\username\\tri9.exe', 'BW64_VKTRACE=2\nBW64_VKFRAME=1\nWINEDLLOVERRIDES=d3d9=n\nLD_LIBRARY_PATH=/home/username']));
  console.log('SPAWN', spawn);
  const until = Date.now() + timeout;
  let lastPrint = 0, lastRendered = 0, shot = null;
  while (Date.now() < until) {
    const stats = await page.evaluate(() => window.bwVkStats?.());
    if (stats?.v2?.rendered > lastRendered) {
      lastRendered = stats.v2.rendered;
      shot = await page.evaluate(() => document.getElementById('vkCanvas')?.toDataURL('image/png'));
      await page.screenshot({ path: `${dir}/page.png` });
    }
    if (Date.now() - lastPrint > 15000) {
      lastPrint = Date.now();
      console.log('PROGRESS', JSON.stringify({ chunks: chunkFiles.length, stats, tail: logs.slice(-2) }));
      await flush();
    }
    if (logs.some(l => /tri9: RESULT [01]/.test(l))) {
      await page.waitForTimeout(3000);
      break;
    }
    if (logs.some(l => /exit_group syscall, status=[1-9]\d*.*cmd=.*tri9\.exe/.test(l))) break;
    if (errors.some(l => /unreachable|memory access out of bounds|Aborted/.test(l))) break;
    await page.waitForTimeout(250);
  }
  const stats = await page.evaluate(() => window.bwVkStats?.());
  if (!shot) shot = await page.evaluate(() => document.getElementById('vkCanvas')?.toDataURL('image/png'));
  if (shot) {
    const bytes = Buffer.from(shot.split(',')[1], 'base64');
    await writeFile(`${dir}/canvas.png`, bytes);
    pixels = trianglePixels(bytes);
  }
  const joined = logs.join('\n');
  const renderErrors = logs.filter(l => /page tier WebGPU error|frame rejected|chunk rejected|cannot translate/.test(l));
  summary = {
    passed: /tri9: RESULT 0/.test(joined) && !errors.length && !renderErrors.length
      && !stats?.errors?.length && stats?.v2?.rendered > 0
      && stats?.litPixels > 0 && !!pixels?.triangle,
    tri9Result: /tri9: RESULT 0/.test(joined) ? 0 : /tri9: RESULT 1/.test(joined) ? 1 : null,
    framesBuilt: (joined.match(/vk64: FRAME \d+ built/g) || []).length,
    drawIndexedLogMatches: (joined.match(/vk64:.*(?:trap vkCmdDrawIndexed|vkCmdDrawIndexed cb=)/g) || []).length,
    guestExitLines: logs.filter(l => /exit_group syscall.*cmd=.*tri9\.exe/.test(l)),
    fallbackLines: logs.filter(l => /fallback|submitted.*cb|vkCmdDrawIndexed cb=|vkQueueSubmit2?.*cb/i.test(l)),
    chunksCaptured: chunkFiles.length, decodedFrames,
    decodedIndexedDraws: decodedFrames.reduce((n, f) => n + f.indexedDraws, 0),
    decodedDraws: decodedFrames.reduce((n, f) => n + f.draws, 0),
    provenance, stats, pixels, errors, renderErrors,
  };
} catch (e) {
  summary.failure = String(e.stack || e);
} finally {
  await flush();
  await page.screenshot({ path: `${dir}/final-page.png` }).catch(() => {});
  await writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 2));
  await writeFile(`${dir}/chunks.json`, JSON.stringify(chunkFiles));
  console.log('PIXEL VERDICT', JSON.stringify(summary));
  await browser.close(); server.close();
  if (!summary.passed) process.exitCode = 1;
}

