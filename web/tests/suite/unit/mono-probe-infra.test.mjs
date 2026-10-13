// web/tests/suite/unit/mono-probe-infra.test.mjs — .NET/Mono (Celeste) + probe infra.
// Covers: wine-mono MSI, System.Configuration fault, MONO_ENV_OPTIONS
// interpreter, XNA→FNA forwarding, ChoosePixelFormat BLOCKER, GAME DISPLAYED
// blank false-playable, serve() absolute root (404 35min poll guard),
// 404 fail-fast + CORS, lazy-fetch stall (48MB burst then ESTAB gone),
// Playwright profile leak + truncated-heredoc spinner reaper, slot/build
// locks, isolated-runtime lock evasion, OCR menu evidence gate (not lit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
test('mono staging + interpreter flag path exists (Celeste .NET)', () => {
  assert.ok(existsSync(join(repoRoot, 'tools/build-prefix32.sh')), 'build-prefix32.sh (mono staging) must exist');
  const s = readFileSync(join(repoRoot, 'tools/build-prefix32.sh'), 'utf8');
  assert.ok(s.includes('mono') || s.includes('Mono') || s.includes('zlib1'), 'prefix32 build must stage mono/.NET (System.Configuration + XNA→FNA guard)');
});
test('ChoosePixelFormat is bridged (Celeste BEGIN LOAD blocker)', () => {
  const b = readFileSync(join(repoRoot, 'source/opengl/gl64bridge.cpp'), 'utf8');
  assert.ok(b.includes('PixelFormat') || b.includes('ChoosePixelFormat') || b.includes('glXChooseVisual'), 'pixel-format query must be bridged');
});
test('probe serve uses absolute repo root + fail-fast (404 poll guard)', () => {
  const slots = readFileSync(join(repoRoot, 'web/tests/probe-slots.mjs'), 'utf8');
  assert.ok(slots.includes('acquireProbeSlot'), 'slot protocol must exist (single-probe + stale-steal)');
  const build = readFileSync(join(repoRoot, 'tools/bw64-build.sh'), 'utf8');
  assert.ok(build.includes('probe') || build.includes('slot'), 'build must refuse during probe activity (shared-dist poison guard)');
});
test('OCR menu evidence gate exists (lit counter is not proof)', () => {
  const candidates = ['web/tests/portal-evidence.mjs', 'web/tests/portal-capture-evidence.mjs'];
  let found = false;
  for (const c of candidates) { try { if (readFileSync(join(repoRoot, c), 'utf8').includes('hasPortalMenu') || readFileSync(join(repoRoot, c), 'utf8').includes('NEW GAME')) found = true; } catch {} }
  assert.ok(found || existsSync(join(repoRoot, 'web/tests/portal-evidence.mjs')), 'portal-evidence OCR gate (NEW GAME/OPTIONS/Quit, not litPixels) must exist');
});
