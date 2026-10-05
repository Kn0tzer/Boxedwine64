import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const server = await serve('dist');
const url = `http://127.0.0.1:${server.address().port}/`;
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [], logs = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => logs.push(m.type() + ': ' + m.text()));
try {
  await page.goto(url);
  await page.waitForFunction(() => window.wineLibrary, {}, { timeout: 60000 });
  await page.click('button:has-text("D3D9 triangle")');
  await page.waitForFunction(() => document.getElementById('log').textContent.includes('first window mapped'), {}, { timeout: 300000 });
  await page.waitForTimeout(60000);
  const frame = page.locator('iframe');
  await frame.screenshot({ path: 'test-results/d3dtri-frame.png' });
  await page.screenshot({ path: 'test-results/d3dtri.png', fullPage: true });
  console.log('STATUS', await page.locator('#status').textContent());
  console.log('RUNTIME', await page.evaluate(() => document.getElementById('runtimeStatus').textContent));
  console.log('ERRORS', JSON.stringify(errors));
} catch (e) {
  console.log('FAIL', e.message?.slice(0, 500));
  await page.screenshot({ path: 'test-results/d3dtri-fail.png', fullPage: true });
} finally {
  await writeFile('test-results/d3dtri-console.log', logs.join('\n').slice(-20000));
  await browser.close(); server.close();
}
