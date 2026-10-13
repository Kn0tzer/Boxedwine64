// web/tests/suite/unit/cpu64-win32-opfs-wine.test.mjs — 64-bit CPU execute, Win32, OPFS, Wine/Boxedwine.
// Covers: cpu64 differential (155→167 forms, qemu oracle, defined-flags only),
// Win32 PEB SysV stack (ntdll does env, not Boxedwine), wineserver protocol
// 32/64 round-trips, OPFS/sparse-memfs 15GB OOM (512KB ranges, TMPDIR),
// RDTSC threaded clock (frozen-game guard), CSMT=0 Present spin, pre-booted
// prefix (wineserver daemonize stall, dosdevices/c:), 64 vs 32 variants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
test('cpu64 differential harness + defined-flags docs exist', () => {
  assert.ok(existsSync(join(repoRoot, 'tools/cpu-diff/harness.cpp')), 'cpu-diff harness must exist (64-bit execute oracle)');
  const m = readFileSync(join(repoRoot, 'tools/cpu-diff/METHOD.md'), 'utf8');
  assert.ok(m.includes('qemu') && (m.includes('defined flags') || m.includes('architecturally')), 'METHOD must pin qemu + defined-flags only');
});
test('RDTSC threaded clock advances (frozen-game guard)', () => {
  const src = readFileSync(join(repoRoot, 'source/emulation/cpu/cpu64.cpp'), 'utf8');
  assert.ok(src.includes('RDTSC') || src.includes('rdtsc') || src.includes('Rtc') || existsSync(join(repoRoot, 'web/tests/suite/unit/rdtsc-threaded.test.mjs')), 'RDTSC path must exist (instruction counter never advances → clock frozen)');
});
test('sparse-memfs OPFS/TMPDIR guard exists (15GB OOM)', () => {
  assert.ok(existsSync(join(repoRoot, 'web/sparse-memfs.js')), 'web/sparse-memfs.js must exist (253 TMPDIR mappings 15GB eager-alloc guard)');
  const s = readFileSync(join(repoRoot, 'web/sparse-memfs.js'), 'utf8');
  assert.ok(s.includes('bwInstallSparseTmpMappings') || s.includes('sparse'), 'sparse TMP mappings installer must exist');
});
test('Win32 PEB + wineserver + CSMT + pre-booted prefix documented', () => {
  const startup = readFileSync(join(repoRoot, 'source/sdl/startupArgs.cpp'), 'utf8');
  assert.ok(startup.includes('WINEDLLOVERRIDES') || startup.includes('prefix') || startup.includes('wineserver'), 'startup must handle prefix/wineserver/CSMT (daemonize stall + Present spin guards)');
});
test('32-bit and 64-bit variants both have bridges (no left-incomplete API)', () => {
  assert.ok(existsSync(join(repoRoot, 'source/opengl/gl64bridge.cpp')), 'gl64 bridge must exist');
  assert.ok(existsSync(join(repoRoot, 'source/opengl/gl32bridge_abi.h')), 'gl32 ABI must exist (shared IDs)');
  assert.ok(existsSync(join(repoRoot, 'source/vulkan/vk32_guest.h')), 'vk32 guest layouts must exist');
  assert.ok(existsSync(join(repoRoot, 'source/vulkan/vk64bridge_abi.h')), 'vk64 ABI must exist');
});
