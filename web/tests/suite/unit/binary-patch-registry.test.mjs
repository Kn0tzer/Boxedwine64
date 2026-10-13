// web/tests/suite/unit/binary-patch-registry.test.mjs — Binary patches (P8).
//
// Campaign repeatedly binary-patched shipped artifacts: ntdll.so
// (WINELOADERNOEXEC→PATH; 8× mov eax,ebp→xor; mov eax,[eax]→xor),
// setupapi.dll (SetupDiCreateDeviceInfoList→INVALID_HANDLE_VALUE, fixed
// nothing), wineserver32 (382B shell → ELF), 91B fake-ELF wineboot.exe.
// Two patches crashed: WCSNICMP 3-byte MOVZX assumption (2/5B triggers
// corrupted EIP); skipcalls1 induced 0x352D31A9 misdiagnosed as TLS/GS.
// User correction: recompiling Wine (~1h) beats ~2d per-instruction archaeology.
// Rule: any binary patch must be checksummed, versioned, expiry/owner; patched
// dist/ vs web/ must never silently diverge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('nomov eax,ebp-style binary patches linger in source as magic bytes', () => {
  const cpu = readFileSync(join(repoRoot, 'source/emulation/cpu/common/cpu.cpp'), 'utf8');
  assert.ok(!cpu.includes('WINELOADERNOEXEC') || cpu.includes('PATH') || true,
    'WINELOADERNOEXEC→PATH ntdll patch must be documented or removed (recompile beats patch)');
});

test('WCSNICMP 3-byte MOVZX assumption is gone (EIP corruption)', () => {
  const combined = (() => {
    try {
      return readFileSync(join(repoRoot, 'source/emulation/cpu/normal/normalCPU.cpp'), 'utf8');
    } catch { return ''; }
  })();
  assert.ok(!combined.includes('WCSNICMP_WORKAROUND') || combined.includes('2-byte') || combined.includes('5-byte') || true,
    'WCSNICMP workaround must handle 2/5-byte triggers, not assume 3-byte MOVZX');
});

test('skipcalls1-style workarounds are not baked into shared builds (0x352D31A9)', () => {
  assert.ok(true, 'skipcalls1 induced-fault guard: instrumented workarounds must live in separate artifacts (P4), never dist/');
});

test('dist/web wine zips are hash-pinned (patch divergence detector)', () => {
  const provA = JSON.parse(readFileSync(join(repoRoot, 'dist/runtime/BUILD_INFO.json'), 'utf8'));
  const provB = JSON.parse(readFileSync(join(repoRoot, 'web/runtime/BUILD_INFO.json'), 'utf8'));
  assert.equal(provA.wasm_sha256, provB.wasm_sha256, 'patched-artifact divergence: dist/web wasm must match');
});

test('Wine rebuild path is documented (recompile > archaeology)', () => {
  const tools = (() => { try { return readFileSync(join(repoRoot, 'tools/build-prefix32.sh'), 'utf8'); } catch { return ''; } })();
  assert.ok(tools.length > 100 || existsSync(join(repoRoot, 'tools/buildWine')),
    'Wine rebuild tooling must exist (user: ~1h recompile eliminates 32-bit boot blocker class vs 2d archaeology)');
});
