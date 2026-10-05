import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { makeZip } from '../files.mjs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = process.env.WINE_URL ? null : await serve('dist');
const url = process.env.WINE_URL || `http://127.0.0.1:${server.address().port}/`;
const PROFILE = process.env.WINE_PROFILE || '/tmp/wineprof-test';
const BROWSER_ARGS = ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-dev-shm-usage'];
const errors = [], logs = [];
let context, page;
async function startBrowser(fresh) {
  if (fresh) await rm(PROFILE, { recursive: true, force: true });
  context = await chromium.launchPersistentContext(PROFILE, { executablePath: '/usr/local/bin/chromium', viewport: { width: 1440, height: 1000 }, acceptDownloads: true, args: BROWSER_ARGS });
  page = context.pages()[0] || await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => logs.push(m.type() + ': ' + m.text()));
}
await startBrowser(true);
const asset = 'Sibling asset loaded from the uploaded folder.\n';
async function run(expected, message) {
  await page.click('#start');
  const frameElement = page.locator('iframe');
  await frameElement.waitFor();
  const frame = await (await frameElement.elementHandle()).contentFrame();
  await frame.waitForFunction(expected => {
    try { return new TextDecoder().decode(window.bwRuntime.fs().readFile('/root/home/username/apps/save.txt')) === String(expected); } catch { return false; }
  }, expected, { timeout: 180000 });
  assert.equal(await frame.evaluate(() => new TextDecoder().decode(window.bwRuntime.fs().readFile('/root/home/username/apps/observed.txt'))), message);
  await page.waitForFunction(() => document.getElementById('log').textContent.includes('first window mapped'), {}, { timeout: 60000 });
  await page.waitForTimeout(2000);
  await frame.locator('#canvas').click({ position: { x: 100, y: 100 } });
  await page.keyboard.type('hello');
  await frame.waitForFunction(() => { try { return new TextDecoder().decode(window.bwRuntime.fs().readFile('/root/home/username/apps/input.txt')).includes('hello'); } catch { return false; } }, {}, { timeout: 10000 });
  await page.screenshot({ path: `test-results/upload-${expected}.png`, fullPage: true });
  await page.click('#stop');
  await page.waitForFunction(() => !document.querySelector('iframe'));
  console.log(`PASS real uploaded Windows GUI, sibling asset, keyboard and save count ${expected}`);
}
try {
  await mkdir('test-results', { recursive: true });
  await page.goto(url);
  await page.waitForFunction(() => window.wineLibrary);
  await page.locator('#folderInput').setInputFiles('test-results/Fixture');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Imported'));
  assert.equal(await page.locator('#executable').inputValue(), 'Folder Probe.exe');
  await run(1, asset);
  await page.reload();
  await page.waitForFunction(() => window.wineLibrary);
  const id = await page.evaluate(async () => (await window.wineLibrary.listPackages())[0].id);
  await page.selectOption('#library', id);
  await page.waitForFunction(() => !document.getElementById('start').disabled);
  await run(2, asset);
  const downloadPromise = page.waitForEvent('download');
  await page.click('#export');
  const download = await downloadPromise;
  await download.saveAs('test-results/upload-backup.zip');
  const patchText = 'Patched sibling asset.\n';
  const blob = new Blob([patchText]);
  const zip = await makeZip([{ path: 'assets/message.txt', size: blob.size, blob }]);
  await writeFile('test-results/upload-patch.zip', new Uint8Array(await zip.arrayBuffer()));
  await page.locator('#patchInput').setInputFiles('test-results/upload-patch.zip');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Applied'));
  await run(3, patchText);
  // Restore mirrors a returning session: restart the browser with the same
  // profile (fresh renderer/workers, persisted IndexedDB), then restore.
  await context.close();
  await startBrowser(false);
  await page.goto(url);
  await page.waitForFunction(() => window.wineLibrary);
  const rid = await page.evaluate(async () => (await window.wineLibrary.listPackages())[0].id);
  await page.selectOption('#library', rid);
  await page.waitForFunction(() => !document.getElementById('start').disabled);
  await page.locator('#restoreInput').setInputFiles('test-results/upload-backup.zip');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Backup restored'));
  await run(3, asset);
  assert.deepEqual(errors, []);
  console.log('PASS folder import → persisted restart → patch → full backup restore');
} catch (error) {
  console.log('STATUS', await page.locator('#status').textContent());
  const runtime=page.frames().find(f=>f.url().includes('/runtime/'));
  if(runtime)console.log('FILES',await runtime.evaluate(()=>{const result={};for(const name of ['save.txt','observed.txt','assets/message.txt','input.txt'])try{result[name]=new TextDecoder().decode(window.bwRuntime.fs().readFile('/root/home/username/apps/'+name));}catch(e){result[name]=e.message;}return result;}));
  await page.screenshot({ path: 'test-results/upload-failure.png', fullPage: true });
  throw error;
} finally {
  await writeFile('test-results/upload-console.log', logs.join('\n'));
  await writeFile('test-results/upload-errors.json', JSON.stringify(errors, null, 2));
  await context.close().catch(() => {});
  server?.close();
}
