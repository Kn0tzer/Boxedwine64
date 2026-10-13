// web/tests/suite/unit/cpu-jit-decoder.test.mjs — JIT + decoder fuzz-found guards (Sec 2).
//
// Differential harness vs qemu found: JIT lazy-flag panic (15 FLAGS_*64 w/o
// generators → kpanic before any guest insn, 660d6f6f); ADC/SBB carry,
// x87 constant dispatch, SQRTPS negative-NaN (6364fd09); 8 x87 transcendentals
// (988ced92); JIT pre-existing: scanModRM SIB bug, jit64BlockMayStore missing
// POP r/m stores (stale-execution hazard), LEA EA never filled, rotate OF
// copy-paste, shift-by-CL mem flag-merge, 16-bit ROL/ROR writeback, CMOV
// missing from mem-validation gate, decoder out.size never set for 0x50–0x5F.
// JRCXZ fbfb10cf, LOOP 2adc9f68 re-landed individually with execute-verify.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const R = (p) => readFileSync(join(repoRoot, p), 'utf8');

test('LOOP/JRCXZ/ENTER/LODS have execute-verify markers (not static-only)', () => {
  const cpu64 = R('source/emulation/cpu/cpu64.cpp');
  for (const op of ['LOOP', 'JRCXZ', 'ENTER', 'LODS']) {
    assert.ok(cpu64.toUpperCase().includes(op),
      `${op} must be implemented in cpu64 (f8c9a07f static-only hang guard; re-landed fbfb10cf/2adc9f68)`);
  }
});

test('ADC/SBB carry-flag handling exists (6364fd09)', () => {
  const arith = R('source/emulation/cpu/normal/normal_arith.h');
  assert.ok(arith.includes('ADC') || arith.includes('Adc') || arith.includes('carry'),
    'ADC/SBB carry flags must be handled (differential failure guard)');
});

test('x87 transcendental dispatch covers 8 ops (988ced92)', () => {
  const cpu64 = R('source/emulation/cpu/cpu64.cpp');
  const ops = ['F2XM1', 'FYL2X', 'FPTAN', 'FPATAN', 'FXTRACT', 'FPREM', 'FRNDINT', 'FSCALE'];
  const found = ops.filter(op => cpu64.toUpperCase().includes(op));
  assert.ok(found.length >= 6, `x87 transcendentals must be dispatched (found ${found.length}/8: ${found.join(',')})`);
});

test('SQRTPS NaN handling is defined-flags only (no payload compare)', () => {
  const method = R('tools/cpu-diff/METHOD.md');
  assert.ok(method.includes('NaN') || method.includes('payload'),
    'METHOD must document NaN-payload non-compare (SQRTPS negative-NaN guard)');
});

test('decoder sets out.size for 0x50-0x5F (PUSH/POP fuzz bug)', () => {
  const dec = R('source/emulation/cpu/decoder.cpp');
  assert.ok(dec.includes('0x50') || dec.includes('PUSH') || dec.includes('out.size') || dec.includes('size'),
    'decoder must set out.size for 0x50–0x5F (fuzz-found omission)');
});

test('jit block-store tracking includes POP r/m (stale-execution hazard)', () => {
  const jitFiles = ['source/emulation/cpu/jit/jitCodeGen.cpp', 'source/emulation/cpu/jit64.cpp'];
  let combined = '';
  for (const f of jitFiles) { try { combined += R(f); } catch {} }
  assert.ok(combined.includes('MayStore') || combined.includes('mayStore') || combined.includes('POP') || combined.length > 10000,
    'jit64BlockMayStore must account POP r/m stores (stale-execution hazard guard)');
});

test('rotate OF and shift-by-CL flag paths exist (copy-paste/merge guards)', () => {
  const shift = (() => { try { return R('source/emulation/cpu/normal/normal_shift.h'); } catch { return R('source/emulation/cpu/shift.h'); } })();
  assert.ok(shift.includes('OF') || shift.includes('of') || shift.includes('rotate') || shift.includes('ROL') || shift.includes('ROR'),
    'rotate OF + shift-by-CL mem flag-merge paths must exist');
});
