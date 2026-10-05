import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const out = process.env.DL_OUT || '/tmp/gamedl';
const pageUrl = process.env.DL_PAGE || 'https://basically-games.itch.io/baldis-basics-classic-remastered';
const want = process.env.DL_WANT || 'Windows';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ acceptDownloads: true });
try {
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const uploads = await page.locator('.upload').all();
  let btn = null;
  for (const u of uploads) {
    const name = ((await u.textContent()) || '').replace(/\s+/g, ' ');
    console.log('row:', name.slice(0, 120));
    if (name.includes(want) && !btn) btn = u.locator('.download_btn');
  }
  if (!btn) throw new Error('no matching upload for ' + want);
  const promise = page.waitForEvent('download', { timeout: 120000 });
  await btn.click();
  const download = await promise;
  console.log('suggested:', download.suggestedFilename());
  await download.saveAs(`${out}/${download.suggestedFilename()}`);
  console.log('SAVED');
} finally { await browser.close(); }
