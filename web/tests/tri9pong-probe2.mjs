// D3D9 Pong game probe: rendered gameplay + working input validation.
// Run from repo root: TAG=unique TIMEOUT=1800000 node /tmp/tri9pong-probe.mjs
// Requires dist built from a tree with bw64_xwire_key (native input injection).
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const tag = process.env.TAG || `pong-${Date.now()}`;
if (!/^[\w.-]+$/.test(tag)) throw new Error('TAG must contain only letters, numbers, _, . or -');
const dir = `test-results/dxvk-${tag}`;
await mkdir(dir, { recursive: true });
const server = await serve(process.env.WINE_DIST_DIR || 'dist');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logs = [], errors = [];
page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', e => errors.push(e.message));
const flush = () => writeFile(`${dir}/console.log`, logs.join('\n'));
const timeout = Number(process.env.TIMEOUT || 1800000);

let summary = { gameSuccess: false };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/runtime/index.html?p=cmd%20%2Fc%20echo%20vkboot&session=1&novideo=1&persist=0&gltrace=0`);
  await page.waitForFunction(() => window.bwRuntime?.ready?.() === true, null, { timeout });
  console.log('SESSION READY');

  const assets = [['tri9pong.exe', process.env.TRI9PONG_PATH || 'tools/dxvk/tri9/tri9pong.exe'],
    ['d3d9.dll', process.env.D3D9_PATH || 'tools/dxvk/build.w64/src/d3d9/d3d9.dll'],
    ['libvulkan.so.1', process.env.VK_SHIM_PATH || 'tools/rootfs64/libvk64/libvulkan.so.1']];
  for (const [name, path] of assets) {
    const bytes = await readFile(path);
    const b64 = bytes.toString('base64');
    await page.evaluate(({ name, b64 }) => {
      const fs = window.bwRuntime.fs();
      fs.mkdirTree('/root/home/username');
      fs.writeFile('/root/home/username/' + name, Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      const registered = window.bwRuntime.call('bw64_register_file', ['string'], ['/home/username/' + name]);
      if (registered !== 1) throw new Error('Guest VFS registration failed for ' + name);
    }, { name, b64 });
  }

  const bootstrapUntil = Date.now() + 90000;
  while (!logs.some(l => /^log: vkboot\s*$/.test(l))) {
    if (Date.now() > bootstrapUntil) { console.log('BOOTSTRAP SENTINEL SKIPPED (timeout)'); break; }
    await flush();
    await page.waitForTimeout(500);
  }
  console.log('BOOTSTRAP COMPLETE');

  // Install vk page tier + key forwarder (Up/Down arrows for Pong paddles).
  await page.evaluate(async () => {
    const { installVkPageTier } = await import('../vkwebgpu.mjs');
    window.bwVkTier = installVkPageTier();
    const SC = { ArrowUp: 82, ArrowDown: 81, Escape: 41 };
    window.bwKeyStats = { down: 0, up: 0 };
    const send = (e, down) => {
      const sc = SC[e.code];
      if (sc === undefined) return;
      e.preventDefault(); e.stopPropagation();
      window.bwKeyStats[down ? 'down' : 'up']++;
      window.bwRuntime.call('bw64_xwire_key', ['number', 'number'], [sc, down ? 1 : 0]);
    };
    window.addEventListener('keydown', e => send(e, true), true);
    window.addEventListener('keyup', e => send(e, false), true);
  });
  const keyFnExists = await page.evaluate(() => {
    try { window.bwRuntime.call('bw64_xwire_key', ['number', 'number'], [0, 0]); return true; }
    catch (e) { return false; }
  });
  console.log('KEYFN', keyFnExists);
  if (!keyFnExists) throw new Error('bw64_xwire_key not exported by this wasm build');

  const spawn = await page.evaluate(() => window.bwRuntime.call('bw64_spawn', ['string', 'string'],
    ['/usr/lib/wine/wine64\nZ:\\\\home\\\\username\\\\tri9pong.exe', 'BW64_VKTRACE=0\nBW64_VKFRAME=0\nWINEDLLOVERRIDES=d3d9=n\nLD_LIBRARY_PATH=/home/username']));
  console.log('SPAWN', spawn);
  const drainUntil = Date.now() + 60000;
  while (Date.now() < drainUntil && !logs.some(l => /spawning.*tri9pong/.test(l))) await page.waitForTimeout(1000);
  console.log('SPAWN-DRAIN', logs.some(l => /spawning.*tri9pong/.test(l)) ? 'YES' : 'NO');

  // Wait for the game to render. Poll tier stats for lit pixels.
  const until = Date.now() + timeout;
  let lit = 0;
  while (Date.now() < until) {
    const st = await page.evaluate(() => {
      try { const s = window.bwVkStats?.(); return s ? (s.litPixels || 0) : -1; }
      catch (e) { return -1; }
    }).catch(() => -2);
    if (st === -2) throw new Error('page died during game wait');
    if (st > 0) lit = st;
    if (lit > 1000) break;  // Pong has fewer pixels than tri9's triangle
    if (logs.some(l => /\bRESULT [01]\b/.test(l))) throw new Error('tri9pong exited before rendering');
    await page.waitForTimeout(1000);
  }
  if (lit <= 1000) throw new Error('no game rendered (litPixels=' + lit + ')');
  console.log('LITPIXELS', lit);

  // --- GAMEPLAY + INPUT VALIDATION ---
  const getStats = () => page.evaluate(() => {
    try {
      const s = window.bwVkStats?.();
      return s ? { lit: s.litPixels || 0, rendered: s.v2?.rendered || 0 } : null;
    } catch (e) { return null; }
  }).catch(() => null);

  const pongLines = () => logs.filter(l => /(tri9pong|9pong|pong|ong|ng|g):/.test(l));
  const keyLines = () => logs.filter(l => /KEYDOWN vk=0x[0-9a-fA-F]+ keys=\d+/.test(l));
  const pointLines = () => logs.filter(l => /point [LR] score \d+-\d+/.test(l));
  const frameLines = () => logs.filter(l => /frame \d+ score \d+-\d+ ball/.test(l));

  const baseline = await getStats();
  const keysBefore = keyLines().length;
  const pointsBefore = pointLines().length;
  console.log('BASELINE', JSON.stringify(baseline), 'keysBefore', keysBefore, 'pointsBefore', pointsBefore);

  // Press Up/Down arrows to move the player paddle. The game logs KEYDOWN.
  // Play for ~60 seconds, pressing keys every 5s (10 presses total).
  const playUntil = Date.now() + 60000;
  let upPressed = 0, downPressed = 0;
  while (Date.now() < playUntil) {
    await page.keyboard.press('ArrowUp');
    upPressed++;
    await page.waitForTimeout(5000);
    await page.keyboard.press('ArrowDown');
    downPressed++;
    await page.waitForTimeout(5000);
    // Check if game ended
    if (logs.some(l => /\bRESULT [01]\b/.test(l))) break;
  }

  const afterPlay = await getStats();
  const keysAfter = keyLines().length;
  const pointsAfter = pointLines().length;
  const frames = frameLines();
  console.log('AFTER-PLAY', JSON.stringify(afterPlay), 'keys', keysAfter, 'points', pointsAfter);

  const keyStats = await page.evaluate(() => window.bwKeyStats).catch(() => null);
  const joined = logs.join('\n');

  // Verdict: gameSuccess if:
  // 1. Game rendered (litPixels > 1000, frames advanced)
  // 2. Input worked (guest logged KEYDOWN for our presses)
  // 3. Gameplay progressed (frames logged, points scored OR game completed)
  const renderedOk = baseline && baseline.lit > 1000 && afterPlay && afterPlay.lit > 1000 &&
                     afterPlay.rendered > baseline.rendered;
  const inputOk = (keysAfter - keysBefore) >= 8;  // at least 8/10 KEYDOWNs for the working-input bar
  const gameplayOk = frames.length > 0 || (pointsAfter > pointsBefore) ||
                     /tri9pong: RESULT 0/.test(joined);
  const result = /tri9pong: RESULT 0/.test(joined) ? 0 : /tri9pong: RESULT 1/.test(joined) ? 1 : null;

  summary = {
    gameSuccess: !!(renderedOk && inputOk && gameplayOk),
    rendered: { baselineLit: baseline?.lit, afterLit: afterPlay?.lit, framesAdvanced: afterPlay?.rendered - baseline?.rendered },
    input: { keysLogged: keysAfter - keysBefore, upPressed, downPressed, keyStats },
    gameplay: { frameLogs: frames.length, pointsScored: pointsAfter - pointsBefore, result },
    guestPongLines: pongLines().slice(-10),
    errors,
  };
} catch (e) {
  summary.failure = String(e.stack || e);
} finally {
  await flush();
  await writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 2));
  console.log('GAME VERDICT', JSON.stringify(summary.gameSuccess));
  await browser.close(); server.close();
  if (!summary.gameSuccess) process.exitCode = 1;
}
