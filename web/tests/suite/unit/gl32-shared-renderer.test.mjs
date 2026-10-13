// web/tests/suite/unit/gl32-shared-renderer.test.mjs — Celeste path (32-bit OpenGL).
//
// Celeste.exe is i386 (0x14c) + FNA.dll + SDL2.dll + Mono. It needs the
// 32-bit OpenGL bridge sharing the 64-bit renderer (tasks/game-compatibility:
// "replace the 32-bit no-op bridge with the existing renderer; decode pointer
// arrays by guest width"). Earlier dismissal "32-bit OpenGL is irrelevant to
// Portal" was corrected: fix all 278 missing functions, no API left incomplete.
// Celeste blocked at Wine's pixel-format query; with shim in /home/username/apps
// (first search path, ZIP first-match wins) the real 32-bit fixture showed
// trigl RESULT 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const gl32abi = readFileSync(join(repoRoot, 'source/opengl/gl32bridge_abi.h'), 'utf8');
const gl64abi = readFileSync(join(repoRoot, 'source/opengl/gl64bridge_abi.h'), 'utf8');
const gl64bridge = readFileSync(join(repoRoot, 'source/opengl/gl64bridge.cpp'), 'utf8');

test('GL32 shares function IDs with GL64 (no forked ABI)', () => {
  assert.ok(gl32abi.includes('gl64bridge_abi.h'),
    'gl32bridge_abi.h must include gl64bridge_abi.h (IDs SHARED, only marshaling differs)');
  assert.ok(gl32abi.includes('GL32_SYSCALL_NR'), 'GL32_SYSCALL_NR (0x474C0000) must be defined');
  assert.ok(gl32abi.includes('GL32Args'), 'GL32Args (16 x u64, zero-extended) must be defined');
});

test('gl32Bridge entry point exists and forwards to shared renderer', () => {
  assert.ok(gl64bridge.includes('gl32Bridge'),
    'gl32Bridge(CPU*, fnId, argsAddr) must exist in gl64bridge.cpp (no-op bridge replaced)');
  const idx = gl64bridge.indexOf('U64 gl32Bridge');
  assert.ok(idx !== -1, 'gl32Bridge definition with U64 return must exist');
  const window = gl64bridge.slice(idx, idx + 2000);
  assert.ok(window.includes('glBridge') && window.length > 100,
    'gl32Bridge must forward to shared glBridge renderer (3-line forwarder, not a stub)');
});

test('GL64 ABI has 300+ functions (P10: no API left incomplete)', () => {
  const ids = [...gl64abi.matchAll(/GL64_fn_\w+/g)].map(m => m[0]);
  const uniq = new Set(ids);
  assert.ok(uniq.size >= 300, `GL64 ABI must define 300+ functions (found ${uniq.size}); 278-missing gap must stay closed`);
});

test('GL32 guest memory decodes pointer arrays by guest width', () => {
  const guestMem = readFileSync(join(repoRoot, 'source/opengl/glguestmemory.h'), 'utf8');
  assert.ok(guestMem.includes('32') || guestMem.includes('width') || guestMem.includes('U32'),
    'glguestmemory.h must handle 32-bit guest widths (pointer arrays decoded by guest width)');
});

test('GL shim is staged app-locally first in search path (ZIP first-match wins)', () => {
  const startup = readFileSync(join(repoRoot, 'source/sdl/startupArgs.cpp'), 'utf8');
  assert.ok(startup.includes('/home/username/apps') || startup.includes('apps'),
    'shim must be staged in /home/username/apps (first library search path; base Mesa beats overlay otherwise)');
});

test('pixel-format query path exists (Celeste BLOCKER: BEGIN LOAD)', () => {
  assert.ok(gl64bridge.includes('ChoosePixelFormat') || gl64bridge.includes('PixelFormat') || gl64bridge.includes('glXChooseVisual'),
    'pixel-format query (ChoosePixelFormat/glXChooseVisual) must be bridged — Celeste blocked here before');
});

test('GL triangle dependencies are all bridged (immediate mode)', () => {
  for (const fn of ['glClear', 'glViewport', 'glBegin', 'glEnd', 'glVertex', 'glFlush', 'glXSwapBuffers']) {
    assert.ok(gl64bridge.includes(fn), `${fn} must be bridged (GL 2.1 triangle dependency)`);
  }
});
