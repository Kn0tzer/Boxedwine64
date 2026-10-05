import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { writeFile } from 'node:fs/promises';

// Env: PROBE_DIR (folder to import), PROBE_EXE (exe to run),
// PROBE_RESULT (guest output file), PROBE_OUT (local copy path).
const fixture = process.env.PROBE_DIR || '/tmp/stage-unitycase';
const exe = process.env.PROBE_EXE || 'caseprobe.exe';
const guestResult = `/root/home/username/apps/${process.env.PROBE_RESULT || 'caseprobe-result.txt'}`;
const localOut = process.env.PROBE_OUT || 'test-results/caseprobe-result.txt';
const server = await serve('dist');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const logs = [], errors = [];
page.on('console', m => logs.push(m.text()));
page.on('pageerror', e => errors.push(e.message));
let failed = false;
try {
  if (process.env.PROBE_DIAG === '1') {
    // Enable in-guest crash attribution (RIP history + module map + loader
    // traces). Runs in every frame; rewrites the runtime iframe URL like
    // web/tests/scratch-baldi.mjs does.
    await page.addInitScript(({ dumpaddr }) => {
      try {
        if (!location.pathname.endsWith('/runtime/index.html')) return;
        const url = new URL(location.href);
        for (const [k, v] of [['ripsample', '1'], ['wildjump', '1'], ['dlltrace', '1'], ['filemap', '1'], ['unimpldump', '1']]) {
          if (!url.searchParams.get(k)) url.searchParams.set(k, v);
        }
        if (dumpaddr && !url.searchParams.get('dumpaddr')) url.searchParams.set('dumpaddr', dumpaddr);
        history.replaceState(null, '', url);
      } catch {}
    }, { dumpaddr: process.env.PROBE_DUMPADDR || '' });
  }
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.wineLibrary, {}, { timeout: 180000 });
  await page.waitForFunction(() => window.wineLibrary, {}, { timeout: 180000 });
  await page.locator('#folderInput').setInputFiles(fixture);
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Imported'), {}, { timeout: 600000 });
  console.log('IMPORT OK:', await page.evaluate(() => document.getElementById('status').textContent));
  await page.selectOption('#executable', exe);
  await page.click('#start');
  const frameElement = page.locator('iframe');
  await frameElement.waitFor({ timeout: 60000 });
  // Re-resolve the content frame on every poll: the runtime iframe can
  // reload during boot (param init, worker restart), which detaches a
  // cached frame handle and turns the wait into a certain timeout.
  const deadline = Date.now() + Number(process.env.PROBE_TIMEOUT_MS || 300000);
  let result = null, lastList = '(unlisted)';
  while (Date.now() < deadline) {
    const fr = await frameElement.elementHandle().then(h => h.contentFrame()).catch(() => null);
    if (fr) {
      try {
        const probe = await fr.evaluate((p) => {
          const out = { data: null, list: [] };
          try { out.list = window.bwRuntime.fs().readdir('/root/home/username/apps'); } catch (e) { out.list = ['readdir: ' + (e.message || e)]; }
          try {
            const raw = window.bwRuntime.fs().readFile(p);
            if (raw && raw.length > 0) out.data = new TextDecoder().decode(raw);
          } catch (e) { out.readErr = String(e && e.message || e).slice(0, 120); }
          return out;
        }, guestResult).catch(() => null);
        if (probe) {
          lastList = JSON.stringify(probe.list);
          // Completion sentinel: fixtures append "done" as the final line.
          // (A byte-count threshold misfires — a finished cryptprobe result
          // is only 62 bytes.)
          if (probe.data && /done\s*$/.test(probe.data)) { result = probe.data; break; }
          if (probe.data) lastList += ' (partial ' + probe.data.length + 'B, no sentinel yet)';
        }
      } catch {}
    }
    await page.waitForTimeout(2000);
  }
  console.log('APPS-DIR', lastList);
  if (!result) throw new Error(`result file ${guestResult} never appeared`);
  await writeFile(localOut, result);
  console.log('PROBE:', result.trim());
  console.log('PASS probe finished');
} catch (e) {
  failed = true;
  process.exitCode = 1;
  console.log('FAIL', String(e.message || e).slice(0, 300));
  try { console.log('STATUS', await page.evaluate(() => document.getElementById('status').textContent).catch(() => '(no status)')); } catch {}
  console.log('LOGS-TAIL', logs.slice(-15).join('\n').slice(-3000));
} finally {
  await writeFile('test-results/probe-console.log', logs.join('\n'));
  await browser.close();
  server.close();
  if (failed) process.exit(1);
}
