// scratch-envprobe.mjs — smallest reliable probe for the O2 env-plumbing fix.
//
// Boots the runtime DIRECTLY (no app shell) with `wine64 cmd /c set` as the boot
// program: cmd's `set` builtin prints the process env to guest stdout, which the
// DevTTY bridge relays to the browser console. Then, with the persistent session
// up, it calls window.launchApp('cmd /c set') — that spawn goes through the
// bw64_spawn C bridge (source/sdl/emscripten/wine64session.cpp), whose doSpawn()
// re-uses the boot-captured g_sessionCtx.env. Comparing the two `set` dumps
// shows exactly which env the boot chain vs the in-session spawn inherit.
//
// Knobs (env):
//   ENVDBG   — value for the ?winedbg launcher param (default +d3d,+wined3d)
//   PROG     — boot program (default "cmd /c set")
//   TAG      — artifact tag
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { writeFile, mkdir } from 'node:fs/promises';

const server = process.env.WINE_URL ? null : await serve('dist');
const base = process.env.WINE_URL || `http://127.0.0.1:${server.address().port}/`;
const TAG = process.env.TAG ? '-' + process.env.TAG : '';
const art = name => 'test-results/envprobe' + TAG + '-' + name;
const PROG = process.env.PROG || 'cmd /c set';
const ENVDBG = process.env.ENVDBG || '+d3d,+wined3d';
await mkdir('test-results', { recursive: true });

const q = new URLSearchParams({
  p: PROG,
  session: '1',            // exercise the persistent-session spawn path
  winedbg: ENVDBG,
  gltrace: '0',
  novideo: '1',
  persist: '0',
});
const url = base.replace(/\/?$/, '/runtime/index.html?') + q.toString();
console.log('PROBE URL:', url);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [], logs = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => logs.push(m.type() + ': ' + m.text()));
const flush = () => writeFile(art('console.log'), logs.join('\n')).catch(() => {});
const seen = rx => logs.some(l => rx.test(l));

try {
  await page.goto(url);
  // Boot done == session context captured (bw64_session_ready()==1).
  await page.waitForFunction(() => window.bwRuntime?.ready?.() === true, {}, { timeout: 300000 });
  console.log('SESSION READY');
  await flush();
  // Give the boot `cmd /c set` output a moment to drain, then snapshot marker.
  await page.waitForTimeout(3000);
  const bootHas = seen(/log: WINEDEBUG=/);
  console.log('BOOT-ENV WINEDEBUG visible:', bootHas);
  await flush();

  // Spawn a SECOND `cmd /c set` through the bw64_spawn bridge.
  console.log('ENVPROBE-MARKER: spawning in-session cmd now');
  const ok = await page.evaluate(() => {
    if (!window.launchApp) return 'no launchApp';
    window.launchApp('cmd /c set');
    return 'spawned';
  });
  console.log('launchApp ->', ok);
  // Wait for the spawned cmd's env dump to appear after the marker.
  await page.waitForFunction(
    () => {
      const el = document.getElementById('output');
      const t = el ? el.value : '';
      const i = t.indexOf('ENVPROBE-MARKER');
      return i >= 0 && t.indexOf('WINEDEBUG=', i) >= 0;
    }, {}, { timeout: 120000 }).catch(() => console.log('no post-marker WINEDEBUG within 120s'));
  await page.waitForTimeout(2000);
  await flush();

  const all = logs.join('\n');
  const markerIdx = all.indexOf('ENVPROBE-MARKER');
  const after = markerIdx >= 0 ? all.slice(markerIdx) : '';
  console.log('SPAWN-ENV WINEDEBUG visible:', /log: WINEDEBUG=/.test(after));
  const m = after.match(/log: (WINEDEBUG=[^\r\n]*)/);
  console.log('SPAWN-ENV value:', m ? m[1] : '(none)');
  console.log('BOOT-ENV value:', (all.match(/log: (WINEDEBUG=[^\r\n]*)/) || [])[1] || '(none)');
  const mBefore = all.slice(0, markerIdx).match(/log: (WINEDEBUG=[^\r\n]*)/);
  console.log('BOOT-ENV value(before marker):', mBefore ? mBefore[1] : '(none)');
  console.log('ERRORS', JSON.stringify(errors));
} catch (e) {
  process.exitCode = 1;
  console.log('FAIL', (e.message || String(e)).slice(0, 500));
} finally {
  await flush();
  await writeFile(art('errors.json'), JSON.stringify(errors, null, 2)).catch(() => {});
  await browser.close(); server?.close();
}
