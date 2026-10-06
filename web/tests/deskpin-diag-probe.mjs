// Short deskpin diagnostic probe: boot, wait ~100s past vkboot, dump deskpin lines.
import { writeFile, mkdir } from 'fs/promises';
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
const dir = `test-results/dxvk-deskpin-diag`;
await mkdir(dir, { recursive: true });
const server = await serve('dist');
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
const flush = async () => { await writeFile(`${dir}/console.log`, logs.join('\n') + '\n'); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/runtime/index.html?p=cmd%20%2Fc%20echo%20vkboot&session=1&novideo=0&persist=0`);
  await page.waitForFunction(() => window.bwRuntime?.ready?.() === true, null, { timeout: 600000 });
  console.log('READY');
  const bUntil = Date.now() + 300000;
  while (!logs.some(l => /^log: vkboot\s*$/.test(l))) { if (Date.now() > bUntil) throw new Error('boot timeout'); await flush(); await page.waitForTimeout(1000); }
  console.log('BOOT OK - waiting 100s');
  await page.waitForTimeout(100000);
  await flush();
  const diag = logs.filter(l => /deskpin:/.test(l));
  console.log('DESKPIN-LINES:', diag.length);
  for (const l of diag.slice(0, 20)) console.log('  ' + l.slice(0, 160));
  const exits = logs.filter(l => /exit_group.*deskpin\.exe/.test(l)).length;
  console.log('DESKPIN-EXITS:', exits);
} catch (e) { console.log('FAIL', String(e).slice(0, 200)); await flush(); }
finally { await browser.close(); server.close(); }
