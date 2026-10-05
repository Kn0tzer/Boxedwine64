import { chromium } from '@playwright/test';
const target = process.env.PROBE_URL || 'https://basically-games.itch.io/baldis-basics-classic-remastered';
const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ acceptDownloads: true });
try {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('title:', await page.title());
  const uploads = await page.locator('.upload').all();
  console.log('uploads:', uploads.length);
  for (const u of uploads) {
    const name = await u.locator('.upload-name, .name').first().textContent().catch(() => '(?)');
    const size = await u.locator('.file-size, .upload-size, .size').first().textContent().catch(() => '(?)');
    console.log(JSON.stringify(name?.trim()), '|', JSON.stringify(size?.trim()));
  }
} finally { await browser.close(); }
