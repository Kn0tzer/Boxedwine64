// baldi-d3d9-prep.mjs — D3D9 bring-up probe for Baldi's Basics (Unity 2020.3.38f1).
//
// Boots Baldi with the d3d9 native override and captures:
//   1. whether d3d9.dll loads at all (WINEDEBUG=+loaddll), and which copy,
//   2. the first D3D9 calls (DXVK's "info: Game:" banner on Direct3DCreate9),
//   3. the first 20 vk64 traps, if DXVK gets that far,
//   4. which graphics API Unity actually selects (player.log device lines).
//
// Override channel (verified 2026-10-05):
// - The launcher's ?p= path cannot carry WINEDLLOVERRIDES (prefixEnv() only
//   maps ?winedbg/?monodebug; no ?overrides param exists).
// - The session + bw64_spawn route CAN carry per-spawn env, but booting a
//   session WITH ?exe= (the runtime page's bwPrepareFilesystem path) crashes
//   reproducibly ("__emscripten_receive_on_main_thread_js: TypeError: func
//   is not a function"), and populating the FS post-boot cannot register
//   directories in the VFS (bw64_register_file is file-nodes only) so wine
//   returns c0000135 for the exe.
// - Working channel: the Wine registry. [HKCU\Software\Wine\DllOverrides]
//   "d3d9"="native" is exactly what WINEDLLOVERRIDES=d3d9=n sets. This probe
//   writes a modified user.reg (with "d3d9"="native" added) into the
//   installation's persisted store BEFORE #start; the runtime restores it
//   into MEMFS at preRun where it shadows prefix64.zip's user.reg, so wine
//   boots with the native override. d3d9.dll itself is staged next to
//   BALDI.exe (/tmp/stage/baldi-d3d9) — first in wine's DLL search order —
//   and also in the prefix (C:\, Z:\home\username) via stage-dxvk.sh.
// - WINEDEBUG=+loaddll rides the ?winedbg param (the scratch-baldi.mjs
//   pattern) to trace module loads.
//
// Env:
//   GAME_DIR   staged game dir (default /tmp/stage/baldi-d3d9)
//   GAME_EXE   exe filename (default BALDI.exe)
//   GAME_ARGS  JSON argv (default 640x480 windowed)
//   TAG        artifact tag (default "d3d9prep")
//   SOAK_SECS  post-map soak (default 90)
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const server = process.env.WINE_URL ? null : await serve('dist');
const url = process.env.WINE_URL || `http://127.0.0.1:${server.address().port}/`;
const GAME_DIR = process.env.GAME_DIR || '/tmp/stage/baldi-d3d9';
const GAME_EXE = process.env.GAME_EXE || 'BALDI.exe';
const GAME_ARGS = JSON.parse(process.env.GAME_ARGS || '["-screen-width","640","-screen-height","480","-screen-fullscreen","0"]');
const TAG = process.env.TAG ? '-' + process.env.TAG : '-d3d9prep';
const art = name => 'test-results/baldi' + TAG + '-' + name;
await mkdir('test-results', { recursive: true });

// ---- build the registry override: user.reg + "d3d9"="native" ----------------
// Read the prefix's user.reg, insert the DllOverrides value. Wine's
// DllOverrides "native" == WINEDLLOVERRIDES=d3d9=n.
function buildUserReg() {
  const zip = new URL('../../dist/runtime/prefix64.zip', import.meta.url).pathname;
  let reg = execSync(`unzip -p ${JSON.stringify(zip)} home/username/.wine/user.reg`).toString('latin1');
  const marker = '[Software\\\\Wine\\\\DllOverrides]';
  const i = reg.indexOf(marker);
  if (i < 0) throw new Error('DllOverrides key not found in user.reg');
  const eol = reg.indexOf('\n', i);
  // insert after the header line (+ its #time line if present)
  let at = eol + 1;
  if (reg.startsWith('#time=', at)) at = reg.indexOf('\n', at) + 1;
  if (!reg.includes('"d3d9"="native"'))
    reg = reg.slice(0, at) + '"d3d9"="native"\n' + reg.slice(at);
  return reg;
}
const userReg = buildUserReg();
console.log('registry override prepared:', /"d3d9"="native"/.test(userReg));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader', '--use-angle=vulkan', '--use-vulkan=swiftshader',
    '--enable-features=Vulkan'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [], logs = [];
page.on('pageerror', e => errors.push(e.message));
let guestFailure;
page.on('console', m => {
  const text = m.type() + ': ' + m.text();
  logs.push(text);
  if (/unimpl opcode|Aborted\(|RuntimeError:|unreachable|memory access out of bounds/.test(text)) guestFailure ||= text;
  if (/exit_group syscall, status=[1-9]/.test(text) && text.includes('apps\\' + GAME_EXE)) guestFailure ||= text;
});
const joined = () => logs.join('\n');
const flush = () => writeFile(art('console.log'), joined().slice(-2000000)).catch(() => {});

// +loaddll via ?winedbg (the launcher's only env channel).
await page.addInitScript(() => {
  if (!location.pathname.endsWith('/runtime/index.html')) return;
  const u = new URL(location.href);
  u.searchParams.set('winedbg', '+loaddll');
  u.searchParams.set('dlltrace', '1');
  history.replaceState(null, '', u);
});

const bootTimeout = Number(process.env.GAME_BOOT_TIMEOUT || 900000);
async function waitForGuest(predicate, description) {
  const deadline = Date.now() + bootTimeout;
  while (Date.now() < deadline) {
    if (guestFailure) throw new Error(guestFailure);
    if (errors.length) throw new Error(errors.join('\n'));
    if (await page.evaluate(predicate)) return;
    await flush();
    await page.waitForTimeout(2000);
  }
  throw new Error(`Timed out waiting for ${description} after ${bootTimeout}ms`);
}

try {
  await page.goto(url);
  await page.waitForFunction(() => window.wineLibrary, {}, { timeout: 60000 });
  console.log('importing', GAME_DIR);
  await page.locator('#folderInput').setInputFiles(GAME_DIR);
  await page.waitForFunction(
    () => document.getElementById('status').textContent.startsWith('Imported'),
    {}, { timeout: 600000 });
  console.log('IMPORT OK:', await page.evaluate(() => document.getElementById('status').textContent));
  const installation = await page.evaluate(() => document.getElementById('library').value);
  if (!installation) throw new Error('no installation id after import');

  // ---- write the registry override into the persisted store -----------------
  // Key must be the guest MEMFS path; record format mirrors writeStored().
  const regWrite = await page.evaluate(async ({ id, reg }) => {
    try {
      const dbName = 'bw64persist-wine-' + id;
      const open = () => new Promise((resolve, reject) => {
        const r = indexedDB.open(dbName, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('files');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const db = await open();
      const data = new TextEncoder().encode(reg);
      await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put({ data, sig: Date.now() + ':' + data.length }, '/root/home/username/.wine/user.reg');
        tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
      });
      db.close();
      return { ok: true, bytes: data.length };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }, { id: installation, reg: userReg });
  console.log('REGWRITE', JSON.stringify(regWrite));
  if (!regWrite.ok) throw new Error('registry override write failed: ' + regWrite.error);

  await page.selectOption('#executable', GAME_EXE);
  console.log('selected:', await page.locator('#executable').inputValue());
  await page.locator('#arguments').fill(JSON.stringify(GAME_ARGS));
  await page.click('#start');
  console.log('started with d3d9=native registry override; waiting for guest window');
  const frameElement = page.locator('iframe');
  await frameElement.waitFor({ timeout: 120000 });
  await waitForGuest(() => document.getElementById('log').textContent.includes('first window mapped'), 'guest window');
  console.log('MAPPED');
  await page.screenshot({ path: art('early.png'), fullPage: true }).catch(() => {});

  const soakSecs = Number(process.env.SOAK_SECS || 90);
  for (let i = 0; i < soakSecs; i++) {
    if (guestFailure) throw new Error(guestFailure);
    await page.waitForTimeout(1000);
    if (i % 15 === 14) await flush();
  }
  await flush();
  await page.screenshot({ path: art('shot.png'), fullPage: true }).catch(() => {});

  // Unity's own log: which graphics API did it select?
  let playerLog = '(not captured)';
  try {
    const runtime = page.frames().find(f => f.url().includes('/runtime/'));
    if (runtime) {
      playerLog = await runtime.evaluate(async () => {
        const asText = (raw, max = 12000) => {
          if (raw == null) return '(null)';
          if (typeof raw === 'string') return raw.slice(-max);
          if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw)).slice(-max);
          if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)).slice(-max);
          return '(unreadable)';
        };
        try {
          const FS = window.bwRuntime?.fs?.();
          const raw = await FS.readFile('/root/home/username/apps/player.log', { encoding: 'utf8' });
          const s = asText(raw, 60000);
          return s.split('\n').filter(l =>
            /d3d|D3D|Direct3D|GfxDevice|graphics|Vulkan|OpenGL|GL_|ANGLE|renderer/i.test(l)
          ).slice(0, 60).join('\n') || '(no graphics lines in player.log)';
        } catch (e) { return 'player.log unreadable: ' + (e && e.message || e); }
      });
    }
  } catch (e) { playerLog = 'probe failed: ' + String(e.message || e).slice(0, 200); }
  await writeFile(art('player-graphics.log'), String(playerLog));
  console.log('--- player.log graphics lines ---\n' + String(playerLog).slice(0, 2500));

  const text = joined();
  const loaddll = text.split('\n').filter(l => /d3d9\.dll/i.test(l)).slice(0, 10);
  const dxvkBanner = text.split('\n').filter(l => /DXVK:|info:\s+Game:/i.test(l)).slice(0, 6);
  const traps = [...text.matchAll(/vk64: trap (\w+)/g)].map(m => m[1]);
  const d3d9Calls = text.split('\n').filter(l => /Direct3DCreate9|IDirect3D/i.test(l)).slice(0, 10);
  const regApplied = /"d3d9"="native"|d3d9.*native/i.test(text);
  const summary = {
    tag: TAG,
    gameDir: GAME_DIR,
    overrideChannel: 'registry HKCU\\Software\\Wine\\DllOverrides "d3d9"="native" via persisted user.reg (== WINEDLLOVERRIDES=d3d9=n)',
    registryOverrideWritten: regWrite,
    d3d9DllLoadLines: loaddll,
    d3d9Loaded: loaddll.length > 0,
    dxvkBanner,
    dxvkReached: dxvkBanner.length > 0,
    firstD3D9Calls: d3d9Calls,
    vkTrapsTotal: traps.length,
    first20VkTraps: traps.slice(0, 20),
    distinctVkTraps: [...new Set(traps)].length,
    guestFailure: guestFailure || null,
    pageErrors: errors.slice(0, 8),
  };
  await writeFile(art('summary.json'), JSON.stringify(summary, null, 2));
  console.log('=== BALDI D3D9 SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.d3d9Loaded) {
    console.log('D3D9 GATE RED: d3d9.dll never loaded by the game (expected: Unity 2020.3 has no D3D9 renderer)');
    process.exitCode = 1;
  } else {
    console.log('D3D9 GATE: d3d9.dll loaded');
  }
} catch (e) {
  process.exitCode = 1;
  console.log('FAIL', (e.message || String(e)).slice(0, 800));
} finally {
  await flush();
  await writeFile(art('errors.json'), JSON.stringify(errors, null, 2)).catch(() => {});
  await browser.close();
  server?.close();
}
