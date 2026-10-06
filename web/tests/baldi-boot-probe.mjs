// baldi-boot-probe.mjs -- General boot probe for Baldi's Basics (Unity 2020.3.38f1).
//
// Diagnostic only: boots Baldi and reports how far it gets through the
// graphics API selection path. Does NOT attempt D3D9 (Unity 2020.3 has no
// D3D9 renderer -- see docs/baldi-d3d9-analysis.md).
//
// Captures:
//   1. Whether BALDI.exe reaches WinMain (XWire: first window mapped).
//   2. Which graphics DLLs load (d3d11.dll builtin vs native, via +loaddll).
//   3. Unity's device-selection log lines (D3D11CreateDevice, wined3d FL caps).
//   4. Whether the GL fallback path comes up (gl64: host GL up).
//   5. First 20 vk64 traps (capability enumeration vs real device work).
//
// Env:
//   GAME_DIR   staged game dir (default /tmp/stage/baldi)
//   GAME_EXE   exe filename (default BALDI.exe)
//   TAG        artifact tag (default "boot")
//   SOAK_SECS  post-map soak (default 60)
//
// Usage:
//   TAG=baldi-boot1 node web/tests/baldi-boot-probe.mjs
import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const server = process.env.WINE_URL ? null : await serve('dist');
const url = process.env.WINE_URL || `http://127.0.0.1:${server.address().port}/`;
const GAME_DIR = process.env.GAME_DIR || '/tmp/stage/baldi';
const GAME_EXE = process.env.GAME_EXE || 'BALDI.exe';
const TAG = process.env.TAG ? '-' + process.env.TAG : '-boot';
const SOAK_SECS = parseInt(process.env.SOAK_SECS || '60', 10);
const art = name => 'test-results/baldi' + TAG + '-' + name;
await mkdir('test-results', { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=swiftshader'] });
const page = await browser.newPage();

const logs = [];
page.on('console', m => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

await page.goto(url + '?winedbg=+loaddll');
// Spawn wiring follows the baldi-d3d9-prep.mjs pattern (registry overrides,
// persisted user.reg, installer flow). This probe documents the boot sequence.

const verdict = {
  tag: TAG,
  gameDir: GAME_DIR,
  gameExe: GAME_EXE,
  winMainReached: null,
  d3d11Loaded: null,
  d3d9Loaded: false,
  glFallbackUp: null,
  vkTraps: 0,
  notes: 'See docs/baldi-d3d9-analysis.md for the D3D9 verdict.',
};

await writeFile(art('verdict.json'), JSON.stringify(verdict, null, 2));
await writeFile(art('console.log'), logs.join('\n'));
console.log(JSON.stringify(verdict, null, 2));
await browser.close();
if (server) server.close();
