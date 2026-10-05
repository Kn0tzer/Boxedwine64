// Validate the exact SPIR-V captured from DXVK with packaged naga and WebGPU.
// REPLAY_DIR=test-results/dxvk-... TAG=unique node web/tests/dxvk-pixel-shaders.mjs
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseV2Chunk, V2FrameAssembler, decodeV2Frame } from '../vkwebgpu.mjs';
const source = process.env.REPLAY_DIR;
if (!source) throw new Error('REPLAY_DIR required');
const tag = process.env.TAG || `shaders-${Date.now()}`;
if (!/^[\w.-]+$/.test(tag)) throw new Error('Invalid TAG');
const dir = `test-results/dxvk-${tag}`;
await mkdir(dir, { recursive: true });
const shaders = new Map(), assembler = new V2FrameAssembler();
for (const name of JSON.parse(await readFile(`${source}/chunks.json`, 'utf8'))) {
  if (!/^chunk-\d+\.bin$/.test(name)) throw new Error('Invalid chunk name');
  const records = assembler.ingest(parseV2Chunk(new Uint8Array(await readFile(`${source}/${name}`))));
  if (records) for (const [hash, shader] of decodeV2Frame(records).shaders) shaders.set(hash, shader);
}
const server = await serve(process.env.WINE_DIST_DIR || 'dist');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader',
    '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan'] });
const page = await browser.newPage();
const logs = [], errors = [], results = [];
page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', e => errors.push(e.message));
let summary = { passed: false, source, mode: 'exact-captured-shader-validation' };
try {
  // Exercise current shader source while preserving the user's dirty dist.
  for (const [url, path] of [['**/tools/spirvfix/spirvfix.mjs', 'tools/spirvfix/spirvfix.mjs'],
    ['**/shader.mjs', 'web/shader.mjs'], ['**/vkwebgpu.mjs', 'web/vkwebgpu.mjs']])
    await page.route(url, route => route.fulfill({ path, contentType: 'text/javascript' }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => { const adapter = await navigator.gpu.requestAdapter(); window.probeDevice = await adapter.requestDevice(); });
  for (const [hash, shader] of shaders) {
    await writeFile(`${dir}/${hash}.spv`, shader.code);
    const result = await page.evaluate(async ({ hash, b64, stage }) => {
      const { toWGSL } = await import('./shader.mjs');
      const { rewritePushConstantsWGSL } = await import('./vkwebgpu.mjs');
      try {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const wgsl = await toWGSL('spirv', bytes, stage === 0 ? 'vertex' : 'fragment', 'main', { rasterTopology: 3 });
        const rewritten = rewritePushConstantsWGSL(wgsl);
        const module = window.probeDevice.createShaderModule({ code: rewritten.code });
        const info = await module.getCompilationInfo();
        return { hash, translated: true, pushBlocks: rewritten.pushBlocks, wgsl: rewritten.code,
          messages: info.messages.map(m => ({ type: m.type, message: m.message, line: m.lineNum, pos: m.linePos })) };
      } catch (e) { return { hash, translated: false, failure: String(e.stack || e) }; }
    }, { hash, b64: Buffer.from(shader.code).toString('base64'), stage: shader.stage });
    if (result.wgsl) { await writeFile(`${dir}/${hash}.wgsl`, result.wgsl); result.wgslBytes = result.wgsl.length; delete result.wgsl; }
    results.push({ bytes: shader.code.length, stage: shader.stage, ...result });
  }
  summary = { ...summary, passed: results.length > 0 && results.every(r => r.translated && !r.messages.some(m => m.type === 'error'))
    && !errors.length, results, errors };
} catch (e) { summary.failure = String(e.stack || e); }
finally {
  await writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 2));
  await writeFile(`${dir}/console.log`, logs.join('\n'));
  console.log('EXACT SHADER VERDICT', JSON.stringify(summary));
  await browser.close(); server.close();
  if (!summary.passed) process.exitCode = 1;
}
