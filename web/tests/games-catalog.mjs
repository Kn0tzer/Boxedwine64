// Built-in game catalog lane: the launcher card must download the staged
// /games/baldi.zip over range requests, import it through the ordinary ZIP
// pipeline, preselect BALDI.exe in the EXE picker and boot the guest to the
// existing "first window mapped" milestone. Rendered gameplay is out of scope
// (graphics lane); the mapped window is the checkpoint here.
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = process.env.WINE_URL ? null : await serve('dist');
const url = process.env.WINE_URL || `http://127.0.0.1:${server.address().port}/`;
const PROFILE = process.env.WINE_PROFILE || '/tmp/wineprof-games';
const BROWSER_ARGS = ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-dev-shm-usage'];
const IMPORT_TIMEOUT = Number(process.env.IMPORT_TIMEOUT || 1500000);
const IDLE_CARD_TEXT = 'Download and install on this device';
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT || 900000);
const errors = [], consoleErrors = [], logs = [], gameRequests = [];
let context, page, crashed;
await mkdir('test-results', { recursive: true });
await rm(PROFILE, { recursive: true, force: true }); // fresh IndexedDB
context = await chromium.launchPersistentContext(PROFILE, { executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium', viewport: { width: 1440, height: 1000 }, acceptDownloads: true, args: BROWSER_ARGS });
page = context.pages()[0] || await context.newPage();
page.on('pageerror', e => errors.push(e.message));
page.on('crash', () => { crashed = 'page crashed'; });
page.on('console', m => { logs.push(m.type() + ': ' + m.text()); if (m.type() === 'error') consoleErrors.push(m.text()); });
// Every byte of the archive arrives through /games; counting those requests is
// how the reload leg proves the package came back from IndexedDB instead of a
// second download.
page.on('request', r => { if (r.url().includes('/games/')) gameRequests.push(r.url()); });
// Mirror the Baldi probe's guest environment: the GL shim profile and the
// jump/filemap workarounds the Unity boot path is known to reach MAPPED with.
await page.addInitScript(({ glversion, wildjump, filemap, monodebug, diag }) => {
  if (!location.pathname.endsWith('/runtime/index.html')) return;
  const q = new URL(location.href);
  if (glversion) q.searchParams.set('glversion', glversion);
  if (wildjump) q.searchParams.set('wildjump', '1');
  if (filemap) q.searchParams.set('filemap', '1');
  if (monodebug) q.searchParams.set('monodebug', '1');
  if (diag) { q.searchParams.set('dlltrace', '1'); q.searchParams.set('unimpldump', '1'); }
  history.replaceState(null, '', q);
}, { glversion: process.env.GL_VERSION || '3.2', wildjump: true, filemap: true, monodebug: true, diag: process.env.DIAG === '1' });
const progress = [];
async function watchImport() {
  const deadline = Date.now() + IMPORT_TIMEOUT;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const card = document.querySelector('[data-game="baldi"]');
      return { status: document.getElementById('status').textContent, card: card ? { busy: card.getAttribute('aria-busy'), disabled: card.disabled, state: card.querySelector('.gamestate').textContent, width: card.querySelector('.bar>i').style.width } : null, exe: document.getElementById('executable').value, options: Array.from(document.getElementById('executable').options, o => o.value) };
    });
    progress.push(`${new Date().toISOString()} status="${state.status}" card=${JSON.stringify(state.card)}`);
    if (state.status.startsWith('Imported')) return state;
    if (errors.length) throw new Error('page error during import: ' + errors.join(' | '));
    if (crashed) throw new Error(crashed);
    if (state.card && !state.card.busy && state.card.state.startsWith('Import failed')) throw new Error(state.status);
    await page.waitForTimeout(4000);
  }
  throw new Error(`Timed out importing the built-in archive after ${IMPORT_TIMEOUT}ms`);
}
try {
  await page.goto(url);
  await page.waitForFunction(() => window.wineLibrary && window.wineGames, {}, { timeout: 60000 });
  const card = page.locator('[data-game="baldi"]');
  await card.waitFor({ state: 'visible' });
  assert.match(await card.textContent(), /Baldi's Basics/);
  assert.match(await card.textContent(), /Unity 2020\.3/);
  assert.match(await card.textContent(), /MB ZIP/);
  const exes = await page.evaluate(() => window.wineGames.catalog.flatMap(g => [g.exe, g.id, g.archive]));
  assert.ok(exes.includes('BALDI.exe') && exes.includes('games/baldi.zip'), 'catalog metadata');
  await page.screenshot({ path: 'test-results/games-catalog-card.png', fullPage: true });
  console.log('card visible:', (await card.textContent()).replace(/\s+/g, ' ').trim());
  // A double click must not start a second import while one is running.
  await card.click();
  await card.click({ force: true }).catch(() => {});
  const started = Date.now();
  const state = await watchImport();
  console.log(`import OK in ${((Date.now() - started) / 1000).toFixed(1)}s: ${state.status}`);
  assert.ok(state.options.includes('BALDI.exe'), 'BALDI.exe offered in the EXE picker');
  assert.ok(state.options.includes('UnityCrashHandler64.exe'), 'other archive EXEs offered');
  assert.equal(state.exe, 'BALDI.exe'); // preselected on completion
  await page.waitForFunction(() => !document.getElementById('start').disabled, {}, { timeout: 60000 });
  assert.match(await page.locator('#arguments').inputValue(), /-screen-width/);
  const imported = await page.evaluate(async () => { const all = await window.wineLibrary.listPackages(); const p = all[0]; return { count: all.length, name: p.name, files: p.files.length, bytes: p.files.reduce((n, f) => n + f.size, 0) }; });
  assert.equal(imported.count, 1, 'a double click must not import the archive twice');
  assert.match(imported.name, /Baldi's Basics/);
  assert.ok(imported.files > 100 && imported.bytes > 400e6, 'package persisted: ' + JSON.stringify(imported));
  assert.match(await card.textContent(), /Installed/);
  console.log('package:', JSON.stringify(imported));
  const downloadsDuringImport = gameRequests.length;
  assert.ok(downloadsDuringImport > 1, 'range-fetched archive, not one GET: ' + downloadsDuringImport + ' requests');
  // The picker stays authoritative: another EXE can be chosen instead.
  await page.selectOption('#executable', 'UnityCrashHandler64.exe');
  assert.equal(await page.locator('#executable').inputValue(), 'UnityCrashHandler64.exe');
  await page.selectOption('#executable', 'BALDI.exe');
  assert.equal(await page.locator('#executable').inputValue(), 'BALDI.exe');
  await page.screenshot({ path: 'test-results/games-catalog-imported.png', fullPage: true });
  // Reload persistence, mirroring web/tests/upload.mjs:50-63. The package must
  // be listed and playable straight out of IndexedDB - no second 131 MB fetch.
  await page.reload();
  await page.waitForFunction(() => window.wineLibrary && window.wineGames, {}, { timeout: 60000 });
  const persisted = await page.evaluate(async () => {
    const all = await window.wineLibrary.listPackages();
    const p = all[0];
    return { count: all.length, id: p.id, files: p.files.length, bytes: p.files.reduce((n, f) => n + f.size, 0), exes: p.files.filter(f => /\.exe$/i.test(f.path)).map(f => f.path) };
  });
  assert.equal(persisted.count, 1, 'the imported package survived the reload');
  assert.equal(persisted.files, imported.files);
  assert.equal(persisted.bytes, imported.bytes, 'persisted package is byte-identical');
  assert.ok(persisted.exes.includes('BALDI.exe'), 'BALDI.exe stored in the persisted package');
  assert.equal(gameRequests.length, downloadsDuringImport, 'reload must not refetch the archive');
  assert.equal(await page.locator('#library').inputValue(), '', 'nothing preselected before a pick');
  await page.selectOption('#library', persisted.id);
  await page.waitForFunction(() => !document.getElementById('start').disabled, {}, { timeout: 180000 });
  const offered = await page.evaluate(() => Array.from(document.getElementById('executable').options, o => o.value));
  assert.ok(offered.includes('BALDI.exe'), 'BALDI.exe offered after reload: ' + offered.length + ' EXEs');
  assert.ok(offered.includes('UnityCrashHandler64.exe'), 'other archive EXEs offered after reload');
  // A reloaded package has no remembered entry point, so the picker (not the
  // catalog) decides what runs - pick BALDI.exe the way a returning user would.
  await page.selectOption('#executable', 'BALDI.exe');
  assert.equal(await page.locator('#executable').inputValue(), 'BALDI.exe');
  assert.ok((await card.textContent()).includes(IDLE_CARD_TEXT), 'card returns to its idle state after reload');
  await page.screenshot({ path: 'test-results/games-catalog-reloaded.png', fullPage: true });
  console.log('reload persistence OK: IndexedDB package listed, no refetch');
  // Launch arguments are per-session, not persisted with the package.
  await page.locator('#arguments').fill(JSON.stringify(await page.evaluate(() => window.wineGames.catalog[0].args)));
  await page.click('#start');
  const frameElement = page.locator('iframe');
  await frameElement.waitFor({ timeout: 60000 });
  const frame = await frameElement.elementHandle().then(h => h.contentFrame());
  assert.ok(frame, 'runtime iframe content frame');
  console.log('runtime iframe up; waiting for the guest window');
  const deadline = Date.now() + BOOT_TIMEOUT;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => document.getElementById('log').textContent.includes('first window mapped'))) break;
    if (crashed) throw new Error(crashed);
    if (errors.length) throw new Error('page error during boot: ' + errors.join(' | '));
    await writeFile('test-results/games-catalog-console.log', logs.join('\n').slice(-2000000));
    await page.waitForTimeout(2000);
  }
  assert.ok(await page.evaluate(() => document.getElementById('log').textContent.includes('first window mapped')), 'guest window mapped within ' + BOOT_TIMEOUT + 'ms');
  console.log('MAPPED');
  await page.screenshot({ path: 'test-results/games-catalog-mapped.png', fullPage: true }).catch(() => {});
  await frameElement.screenshot({ path: 'test-results/games-catalog-frame.png' }).catch(() => {});
  console.log('STATUS', await page.locator('#status').textContent());
  console.log('RUNTIME', await page.evaluate(() => document.getElementById('runtimeStatus').textContent));
  await page.click('#stop');
  await page.waitForFunction(() => !document.querySelector('iframe'));
  assert.deepEqual(errors, []);
  console.log('PASS built-in catalog card → range fetch → ZIP import → BALDI.exe → guest window mapped');
} catch (error) {
  await writeFile('test-results/games-catalog-progress.log', progress.join('\n'));
  try {
    console.log('STATUS', await page.locator('#status').textContent());
    const card = page.locator('[data-game="baldi"]');
    if (await card.count()) console.log('CARD', (await card.textContent()).replace(/\s+/g, ' ').trim());
    console.log('LOG-TAIL', (await page.locator('#log').textContent()).slice(-1500));
    await page.screenshot({ path: 'test-results/games-catalog-failure.png', fullPage: true }).catch(() => {});
  } catch {}
  throw error;
} finally {
  await writeFile('test-results/games-catalog-console.log', logs.join('\n').slice(-2000000));
  await writeFile('test-results/games-catalog-errors.json', JSON.stringify(errors, null, 2));
  await context.close().catch(() => {});
  server?.close();
}
