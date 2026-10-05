import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const jobs = JSON.parse(process.argv[2]); // [[gameUrl, uploadId, out], ...]
const b = await chromium.launch({ executablePath: '/usr/local/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await Promise.all(jobs.map(async ([gameUrl, uploadId, out]) => {
  const ctx = await b.newContext({ acceptDownloads: true });
  const p = await ctx.newPage();
  try {
    await p.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: 90000 }),
      p.click(`a.download_btn[data-upload_id="${uploadId}"]`),
    ]);
    await dl.saveAs(out);
    console.log('OK', out);
  } catch (e) { console.log('ERR', gameUrl, e.message.slice(0, 120)); }
  await ctx.close();
}));
await b.close();