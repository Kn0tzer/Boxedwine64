import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const server = await serve('dist');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-dev-shm-usage', ...JSON.parse(process.env.CHROME_EXTRA_ARGS || '[]')],
});
try {
  const page = await browser.newPage();
  page.on('console', m => console.log(m.type(), m.text()));
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const { createRenderer } = await import('./webgpu.mjs');
    const c = document.createElement('canvas');
    document.body.append(c);
    const r = await createRenderer(c);
    try {
      for (let i = 0; i < 20; i++) {
        r.render({ width: 100, height: 100, commands: [[200, 0, 0, 0, 1], [201, 0x4100], [217, 1, 0, 0], [320, 4], [323, -1, -1, 0], [323, 1, -1, 0], [323, 0, 1, 0], [321]] });
        await new Promise(ok => setTimeout(ok, 50));
      }
      // Read the current canvas before the browser presents and clears it.
      r.render({ width: 100, height: 100, commands: [[201, 0x4100], [320, 4], [323, -1, -1, 0], [323, 1, -1, 0], [323, 0, 1, 0], [321]] });
      const sample = document.createElement('canvas');
      document.body.append(sample);
      sample.width = sample.height = 100;
      const ctx = sample.getContext('2d');
      ctx.drawImage(c, 0, 0);
      return { frames: r.frames, errors: r.errors, pixel: Array.from(ctx.getImageData(50, 50, 1, 1).data) };
    } finally { r.destroy(); }
  });
  console.log(result);
  assert.equal(result.frames, 21);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.pixel, [255, 0, 0, 255]);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/gpu-isolate.png' });
} finally {
  await browser.close();
  server.close();
}
