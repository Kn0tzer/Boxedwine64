import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const fixture = 'test-results/StatFixture';
await mkdir(`${fixture}/assets`, { recursive: true });
await writeFile(`${fixture}/assets/message.txt`, 'stat probe\n');
const server = await serve('dist');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const logs = [], errors = [];
page.on('console', m => logs.push(m.text()));
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.wineLibrary);
  await page.locator('#folderInput').setInputFiles(fixture);
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Imported'));
  await page.click('#start');
  const iframe = await page.locator('iframe').elementHandle();
  const frame = await iframe.contentFrame();
  await frame.waitForFunction(() => {
    try { return window.bwRuntime.fs().readFile('/root/home/username/apps/stat-result.txt').length > 0; } catch { return false; }
  }, {}, { timeout: 180000 });
  const result = await frame.evaluate(() => new TextDecoder().decode(window.bwRuntime.fs().readFile('/root/home/username/apps/stat-result.txt')));
  await writeFile('test-results/stat-result.txt', result);
  console.log(result);
  assert.match(result, /stat32=0 errno=0 size=11 mtime=\d+/);
  assert.match(result, /stat64=0 errno=0 size=11 mtime=\d+/);
  for (const [, value] of result.matchAll(/mtime=(\d+)/g)) assert.ok(Number(value) > 1000000000 && Number(value) < 2200000000);
  assert.deepEqual(errors, []);
  console.log('PASS uploaded Windows CRT stat32/stat64 timestamp units');
} finally {
  await writeFile('test-results/stat-console.log', logs.join('\n'));
  await browser.close();
  server.close();
}
