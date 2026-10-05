import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const server = process.env.WINE_URL ? null : await serve('dist');
const url = process.env.WINE_URL || `http://127.0.0.1:${server.address().port}/`;
const GAME_DIR = process.env.GAME_DIR || '/tmp/stage/baldi';
const GAME_ARGS = JSON.parse(process.env.GAME_ARGS || '["-screen-width","640","-screen-height","480","-screen-fullscreen","0"]');
await mkdir('test-results', { recursive: true });
// TAG namespaces every artifact this run writes (baldi-<tag>-console.log, …) so
// two agents probing the same dist concurrently cannot clobber each other's
// evidence. Unset keeps the historical baldi-*.log names.
const TAG = process.env.TAG ? '-' + process.env.TAG : '';
const art = name => 'test-results/baldi' + TAG + '-' + name;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [], logs = [];
page.on('pageerror', e => errors.push(e.message));
let guestFailure;
page.on('console', m => {
  const text = m.text();
  logs.push(m.type() + ': ' + text);
  if (/CPU64: unimpl opcode|Aborted\(|RuntimeError:|unreachable|memory access out of bounds|The assembly mscorlib.dll was not found/.test(text)) guestFailure ||= text;
  if (/CPU64: exit_group syscall, status=[1-9]/.test(text) && text.includes('apps\\' + (process.env.GAME_EXE || 'BALDI.exe'))) guestFailure ||= text;
});
const bootTimeout = Number(process.env.GAME_BOOT_TIMEOUT || 300000);
await page.addInitScript(({ debug, winedbgChannels, envedump, sample, eager, monoMask, bindnow, glversion, gltrace }) => {
  if (!location.pathname.endsWith('/runtime/index.html')) return;
  const url = new URL(location.href);
  // WINEDBG_CHANNELS (O2 lane) takes precedence over WINEDEBUG: both map to the
  // launcher's ?winedbg param, which prefixEnv() turns into WINEDEBUG for the
  // boot env AND the per-spawn env (bw64_spawn -> mergeSpawnEnv in
  // wine64session.cpp merges it over the boot-captured g_sessionCtx.env).
  const winedbg = winedbgChannels || debug;
  if (winedbg) url.searchParams.set('winedbg', winedbg);
  if (envedump) url.searchParams.set('envedump', '1');
  if (sample) url.searchParams.set('ripsample', '1');
  if (eager) url.searchParams.set('lazy', '0');
  url.searchParams.set('wildjump', '1');
  url.searchParams.set('dlltrace', '1');
  url.searchParams.set('filemap', '1');
  url.searchParams.set('monodebug', '1');
  url.searchParams.set('unimpldump', '1');
  if (bindnow) url.searchParams.set('bindnow', '1');
  if (glversion) url.searchParams.set('glversion', glversion);
  if (gltrace) url.searchParams.set('gltrace', gltrace);
  if (monoMask) url.searchParams.set('monomask', monoMask);
  history.replaceState(null, '', url);
}, { debug: process.env.WINEDEBUG, winedbgChannels: process.env.WINEDBG_CHANNELS || '', envedump: process.env.ENVDUMP === '1', sample: process.env.RIP_SAMPLE === '1', eager: process.env.EAGER_ROOTFS === '1', monoMask: process.env.MONO_LOG_MASK, bindnow: process.env.BIND_NOW === '1', glversion: process.env.GL_VERSION || '', gltrace: process.env.GL_TRACE || '' });
async function waitForGuest(predicate, description) {
  const deadline = Date.now() + bootTimeout;
  while (Date.now() < deadline) {
    if (guestFailure) throw new Error(guestFailure);
    if (errors.length) throw new Error(errors.join('\n'));
    if (await page.evaluate(predicate)) return;
    await writeFile(art('console.log'), logs.join('\n').slice(-2000000));
    await page.waitForTimeout(1000);
  }
  throw new Error(`Timed out waiting for ${description} after ${bootTimeout}ms`);
}
try {
  await page.goto(url);
  await page.waitForFunction(() => window.wineLibrary, {}, { timeout: 60000 });
  console.log('importing', GAME_DIR);
  await page.locator('#folderInput').setInputFiles(GAME_DIR);
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Imported'), {}, { timeout: 600000 });
  console.log('IMPORT OK:', await page.evaluate(() => document.getElementById('status').textContent));
  console.log('executable:', await page.locator('#executable').inputValue());
  const exeTarget = process.env.GAME_EXE || 'BALDI.exe';
  await page.selectOption('#executable', exeTarget);
  console.log('selected:', await page.locator('#executable').inputValue());
  await page.locator('#arguments').fill(JSON.stringify(GAME_ARGS));
  await page.click('#start');
  const frameElement = page.locator('iframe');
  await frameElement.waitFor({ timeout: 60000 });
  const frame = await frameElement.elementHandle().then(h => h.contentFrame());
  console.log('runtime iframe up; waiting for guest window');
  await waitForGuest(() => document.getElementById('log').textContent.includes('first window mapped'), 'guest window');
  console.log('MAPPED');
  // Screenshot immediately: the browser has died during the post-map soak
  // before (no artifacts), so capture the mapped window first, then soak.
  await page.screenshot({ path: art('early.png'), fullPage: true }).catch(() => {});
  await frameElement.screenshot({ path: art('frame-early.png') }).catch(() => {});
  console.log('STATUS', await page.locator('#status').textContent().catch(() => '(no status)'));
  const soakSecs = Number(process.env.SOAK_SECS || 120);
  for (let i = 0; i < soakSecs; i++) {
    if (guestFailure) throw new Error(guestFailure);
    await page.waitForTimeout(1000);
    // Keep a running console capture: the file otherwise freezes at MAPPED
    // and post-map guest activity (the actual game init) is lost.
    if (i % 10 === 9) await writeFile(art('console.log'), logs.join('\n').slice(-2000000)).catch(() => {});
  }
  await writeFile(art('console.log'), logs.join('\n').slice(-2000000)).catch(() => {});
  await page.screenshot({ path: art('shot.png'), fullPage: true });
  await frameElement.screenshot({ path: art('frame.png') });
  console.log('STATUS', await page.locator('#status').textContent());
  console.log('RUNTIME', await page.evaluate(() => document.getElementById('runtimeStatus').textContent));
  console.log('ERRORS', JSON.stringify(errors));
  // Window mapping is only a diagnostic checkpoint, not gameplay certification.
  console.log('CHECKPOINT: window mapped; gameplay/input verification is still required.');
  // Always capture Unity's own log: it names the exact graphics failure.
  try {
    const runtime = page.frames().find(f => f.url().includes('/runtime/'));
    if (runtime) {
      const text = await runtime.evaluate(async () => {
        // FS.readFile()'s return type varies with the Emscripten version, the
        // `encoding` option, and whether the launcher installed an async FS proxy
        // (a Promise). Normalise all three, or TextDecoder("[object Object]") eats
        // the very evidence (Unity's player.log) this probe exists to capture.
        const asText0 = (raw, max = 12000) => {
          if (raw == null) return '(null)';
          if (typeof raw === 'string') return raw.slice(-max);
          if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw)).slice(-max);
          if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)).slice(-max);
          if (typeof raw.length === 'number') return new TextDecoder().decode(new Uint8Array(raw)).slice(-max);
          if (raw.data != null) return asText0(raw.data, max);
          return '(unreadable: ' + Object.prototype.toString.call(raw) + ')';
        };
        const err = (e) => (e && (e.name + '/' + (e.message !== undefined ? e.message : e.errno))) || String(e);
        const P = '/root/home/username/apps/player.log';
        const notes = [];
        try {
          const FS = window.bwRuntime?.fs?.();
          if (!FS) return 'player.log unreadable: no FS in runtime frame';
          try { const st = await FS.stat(P); notes.push('stat size=' + (st && st.size)); }
          catch (e) { notes.push('stat: ' + err(e)); }
          for (const opts of [{ encoding: 'utf8' }, undefined]) {
            try {
              const v = await FS.readFile(P, opts);
              return asText0(v) + (notes.length ? '\n[probe] ' + notes.join(' | ') : '');
            } catch (e) { notes.push('readFile(' + JSON.stringify(opts) + '): ' + err(e)); }
          }
          return 'player.log unreadable: ' + notes.join(' | ');
        } catch (e) { return 'player.log unreadable: ' + err(e); }
      });
      await writeFile(art('player.log'), String(text));
      console.log('PLAYERLOG', String(text).slice(-3000));
    }
  } catch (e) { console.log('PLAYERLOG-ERR', String(e.message || e).slice(0, 200)); }
} catch (e) {
  process.exitCode = 1;
  console.log('FAIL', (e.message || String(e)).slice(0, 800));
  try {
    console.log('STATUS', await page.locator('#status').textContent());
    const runtime = page.frames().find(f => f.url().includes('/runtime/'));
    if (runtime) {
      const probe = await runtime.evaluate(() => {
        const asBytes = (raw) => (typeof raw === 'string') ? new TextEncoder().encode(raw)
          : (raw instanceof ArrayBuffer) ? new Uint8Array(raw)
          : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : new Uint8Array(raw);
        const asText = (raw, max = 12000) => asText0(raw, max);
        function asText0(raw, max) {
          if (raw == null) return '(null)';
          if (typeof raw === 'string') return raw.slice(-max);
          if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw)).slice(-max);
          if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)).slice(-max);
          if (typeof raw.length === 'number') return new TextDecoder().decode(new Uint8Array(raw)).slice(-max);
          if (raw.data != null) return asText0(raw.data, max);
          return '(unreadable: ' + Object.prototype.toString.call(raw) + ')';
        }
        const out = {};
        const FS = window.bwRuntime?.fs?.();
        if (!FS) return { nofs: true };
        const roots = ['/root/home/username'];
        try { roots.push(...FS.readdir('/root/home/username').map(n => '/root/home/username/' + n)); } catch {}
        out.roots = roots.slice(0, 20);
        for (const p of ['/root/home/username/apps/BALDI_Data/Managed/mscorlib.dll', '/root/home/username/apps/BALDI_Data/boot.config', '/root/home/username/apps/player.log']) {
          try {
            const data = FS.readFile(p, { encoding: 'binary' });
            const bytes = (typeof data === 'string') ? new TextEncoder().encode(data)
                         : (data instanceof ArrayBuffer) ? new Uint8Array(data)
                         : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                         : new Uint8Array(data);
            out[p] = p.endsWith('.dll') ? { size: bytes.length, header: Array.from(bytes.slice(0, 16)) } : asText(data);
          } catch (e) { out[p] = String(e.message || e); }
        }
        try {
          const wineBase = '/root/home/username/.wine/drive_c/users';
          const tree = (d, depth) => {
            if (depth > 7) return [];
            let out = [];
            try {
              for (const n of FS.readdir(d)) {
                if (n === '.' || n === '..') continue;
                const p = d + '/' + n;
                out.push(p);
                try { if (FS.isDir(FS.lstat(p).mode)) out = out.concat(tree(p, depth + 1)); } catch {}
                if (out.length > 300) break;
              }
            } catch {}
            return out;
          };
          out.usertree = tree(wineBase, 0);
          for (const p of out.usertree) {
            if (/player\.log|output_log|crash|error.*\.txt|\.dmp$/i.test(p)) {
              try { out['file_' + p] = new TextDecoder().decode(FS.readFile(p)).slice(-6000); } catch (e) {}
            }
          }
        } catch (ex) { out.lowerr = String(ex && ex.message || ex); }
        return out;
      });
      await writeFile(art('probe.json'), JSON.stringify(probe, null, 2));
      for (const [path, text] of Object.entries(probe)) {
        if (path.endsWith('/player.log') && typeof text === 'string') await writeFile(art('player.log'), text);
      }
      console.log('PROBE', JSON.stringify(probe).slice(0, 8000));
    }
  } catch {}
  try { await page.screenshot({ path: art('fail.png'), fullPage: true }); } catch {}
} finally {
  await writeFile(art('console.log'), logs.join('\n').slice(-2000000));
  await writeFile(art('errors.json'), JSON.stringify(errors, null, 2));
  await browser.close(); server?.close();
}
