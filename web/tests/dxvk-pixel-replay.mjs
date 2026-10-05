// Replay exact producer chunks in an isolated WebGPU page, without Wine boot.
// REPLAY_DIR=test-results/dxvk-... TAG=unique node web/tests/dxvk-pixel-replay.mjs
// A replay pixel pass is separate evidence from a live guest presentation.
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { trianglePixels } from './dxvk-pixel-analysis.mjs';
import { parseV2Chunk, V2FrameAssembler, decodeV2Frame } from '../vkwebgpu.mjs';
const source = process.env.REPLAY_DIR;
if (!source) throw new Error('REPLAY_DIR must name an existing captured-chunk directory');
const tag = process.env.TAG || `replay-${Date.now()}`;
if (!/^[\w.-]+$/.test(tag)) throw new Error('Invalid TAG');
const dir = `test-results/dxvk-${tag}`;
await mkdir(dir, { recursive: true });
const names = JSON.parse(await readFile(`${source}/chunks.json`, 'utf8'));
if (!names.length || names.some(n => !/^chunk-\d+\.bin$/.test(n))) throw new Error('Invalid or empty captured chunk list');
const server = await serve(process.env.WINE_DIST_DIR || 'dist');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader',
    '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logs = [], errors = [], frames = [], results = [];
page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', e => errors.push(e.message));
let summary = { passed: false, mode: 'exact-chunk-replay', source }, pixels = null;
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const { installVkPageTier } = await import('./vkwebgpu.mjs');
    installVkPageTier();
  });
  const assembler = new V2FrameAssembler();
  for (const name of names) {
    const bytes = new Uint8Array(await readFile(`${source}/${name}`));
    const records = assembler.ingest(parseV2Chunk(bytes));
    if (records) {
      const f = decodeV2Frame(records);
      frames.push({ frame: f.frameNo, w: f.width, h: f.height,
        shaders: [...f.shaders.values()].map(s => s.code.length),
        buffers: [...f.buffers.values()].map(b => b.length),
        passes: f.passes.map(p => ({ rpId: p.rpId, fbId: p.fbId, attachments: p.attachments,
          ops: p.ops.map(o => o.op), pipelines: p.ops.filter(o => o.op === 'bindPipe').map(o => o.pipe) })) });
    }
    const result = await page.evaluate(async b64 => {
      const b = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return window.bwVkTier.chunk(b, 0);
    }, Buffer.from(bytes).toString('base64'));
    results.push(result);
    if (result?.rendered) {
      const png = await page.evaluate(() => document.getElementById('vkCanvas').toDataURL('image/png'));
      const pngBytes = Buffer.from(png.split(',')[1], 'base64');
      pixels = trianglePixels(pngBytes);
      await writeFile(`${dir}/canvas.png`, pngBytes);
      await page.screenshot({ path: `${dir}/page.png` });
      if (pixels.triangle) break;
    }
  }
  const stats = await page.evaluate(() => window.bwVkStats());
  const renderErrors = logs.filter(l => /page tier WebGPU error|frame rejected|chunk rejected|cannot translate/.test(l));
  summary = { ...summary, passed: !!pixels?.triangle && stats.v2.rendered > 0 && !errors.length
    && !renderErrors.length && !stats.errors.length, chunksReplayed: results.length, decodedFrames: frames.length,
    results, stats, pixels, errors, renderErrors };
} catch (e) {
  summary.failure = String(e.stack || e);
} finally {
  await page.screenshot({ path: `${dir}/final-page.png` }).catch(() => {});
  await writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 2));
  await writeFile(`${dir}/frames.json`, JSON.stringify(frames, null, 2));
  await writeFile(`${dir}/console.log`, logs.join('\n'));
  console.log('EXACT CHUNK REPLAY', JSON.stringify({ ...summary, results: undefined }));
  await browser.close(); server.close();
  if (!summary.passed) process.exitCode = 1;
}
