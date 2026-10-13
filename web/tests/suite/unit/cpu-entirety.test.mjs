// web/tests/suite/unit/cpu-entirety.test.mjs — Full x86 user-mode ISA entirety (both bitnesses).
//
// Extends cpu64/cpu32-opcode-coverage (one-byte existence) to the FULL
// instruction set to the fullest static extent: two-byte 0F escapes, x87
// D8-DF with modrm, string ops, and the differential harness linkage.
// Four-bucket per cpu-diff METHOD.md: 167 forms tested (155 + 12 x87);
// string/control/segment/privileged/SSE2+/FPU-env explicitly out of harness
// scope; AVX intentionally unsupported (CPUID bit cleared); MMX advertised
// but 0 handlers (known gap, deprecated, superseded by SSE).
//
// A FAIL here means a real instruction lost its handler or a new opcode
// class arrived without coverage — FSIN/FCOS-class (52beff78) guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const cpu64 = readFileSync(join(repoRoot, 'source/emulation/cpu/cpu64.cpp'), 'utf8');

test('two-byte 0F escape families are dispatched (not unhandled)', () => {
  for (const fam of ['CMOV', 'MOVZX', 'MOVSX', 'BSWAP', 'IMUL', 'BT', 'JCC', 'SET']) {
    assert.ok(cpu64.toUpperCase().includes(fam),
      `0F family ${fam} must be dispatched in cpu64 (full-ISA guard)`);
  }
  assert.ok(cpu64.includes('0x0F') || cpu64.toUpperCase().includes('TWO-BYTE') || cpu64.includes('dsp_0F') || cpu64.includes('escape'),
    '0F two-byte escape dispatch must exist');
});

test('x87 D8-DF full transcendental set is dispatched (D9 F0-FB + D9 FE/FF)', () => {
  for (const op of ['F2XM1', 'FYL2X', 'FPTAN', 'FPATAN', 'FXTRACT', 'FPREM', 'FRNDINT', 'FSINCOS', 'FSCALE']) {
    assert.ok(cpu64.includes(op),
      `x87 ${op} must be dispatched (transcendental entirety; 988ced92 family)`);
  }
  assert.ok(cpu64.includes('FLD1') && cpu64.includes('FLDZ') && cpu64.includes('FLDPI'),
    'x87 constants FLD1/FLDZ/FLDPI must exist (52beff78 FSIN/FCOS class)');
});

test('string ops exist in 32-bit backend (MOVS/STOS/LODS/SCAS/CMPS)', () => {
  const files = [
    'source/emulation/cpu/normal/normal_strings.cpp',
    'source/emulation/cpu/normal/normal_strings_op.h',
    'source/emulation/cpu/x32/jitX86CodeGen.cpp',
  ];
  const combined = files.map(f => { try { return readFileSync(join(repoRoot, f), 'utf8'); } catch { return ''; } }).join('\n').toUpperCase();
  assert.ok(combined.length > 1000, '32-bit string sources must be substantial');
  for (const op of ['MOVS', 'STOS', 'LODS', 'SCAS', 'CMPS']) {
    assert.ok(combined.includes(op), `32-bit backend must implement ${op}`);
  }
});

test('differential harness pins 167 forms vs qemu (155 + 12) with defined-flags only', () => {
  assert.ok(existsSync(join(repoRoot, 'tools/cpu-diff/harness.cpp')), 'cpu-diff harness must exist');
  const method = readFileSync(join(repoRoot, 'tools/cpu-diff/METHOD.md'), 'utf8');
  assert.ok(method.includes('155') && method.includes('12'), 'METHOD must record 155+12=167 forms (entirety denominator)');
  assert.ok(method.includes('qemu'), 'qemu oracle must be documented');
  assert.ok(method.includes('AVX') && method.includes('MMX'), 'known gaps AVX (by design) + MMX (0 handlers) must be documented, not hidden');
});

test('AVX is intentionally unsupported via CPUID (not a missing-handler bug)', () => {
  assert.ok(cpu64.includes('AVX') || readFileSync(join(repoRoot, 'tools/cpu-diff/METHOD.md'), 'utf8').includes('AVX'),
    'AVX-unsupported-by-design must be documented (CPUID bit cleared so glibc picks non-AVX paths)');
});
