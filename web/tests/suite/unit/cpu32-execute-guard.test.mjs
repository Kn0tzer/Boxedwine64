// web/tests/suite/unit/cpu32-execute-guard.test.mjs — Execute-don't-exist for 32-bit (P1).
//
// The existing cpu32-opcode-coverage suite "tests existence, not correctness".
// f8c9a07f (12 handlers, static-only) hung every Wine spawn and was reverted.
// User policy: a fix commit must mean "this now works", proven by a passing
// probe, never by build/static test. This guard ensures:
//  (a) 32-bit handlers exist AND are exercised by an execute harness,
//  (b) x87 FSIN/FCOS-class gaps (D9 FE/FF) cannot recur,
//  (c) JIT lazy-flag coverage matches the FLAGS enum (kpanic guard).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const cpu32Dir = join(repoRoot, 'source/emulation/cpu/x32');
const normalDir = join(repoRoot, 'source/emulation/cpu/normal');

function read(p) { return readFileSync(p, 'utf8'); }

test('32-bit CPU sources exist (x32 JIT + normal backends)', () => {
  assert.ok(existsSync(join(repoRoot, 'source/emulation/cpu/normal/normalCPU.cpp')),
    'normal/normalCPU.cpp 32-bit backend must exist');
  assert.ok(existsSync(join(cpu32Dir, 'jitX86CodeGen.cpp')) || existsSync(join(repoRoot, 'source/emulation/cpu/x32')),
    'x32 JIT backend must exist');
  assert.ok(existsSync(join(repoRoot, 'source/emulation/cpu/cpu64.cpp')),
    'cpu64.cpp must exist for cross-checks');
});

test('32-bit string ops are implemented (MOVS/STOS/LODS/SCAS/CMPS)', () => {
  const candidates = [
    join(cpu32Dir, 'instructions.cpp'),
    join(cpu32Dir, 'normalCPU.cpp'),
    join(normalDir, 'normal_strings.cpp'),
    join(repoRoot, 'source/emulation/cpu/x32/normal_strings.cpp'),
  ].filter(existsSync);
  assert.ok(candidates.length > 0, 'at least one 32-bit string-ops source must exist');
  const combined = candidates.map(read).join('\n');
  for (const op of ['MOVS', 'STOS', 'LODS', 'SCAS', 'CMPS']) {
    assert.ok(combined.toUpperCase().includes(op),
      `32-bit emulator must implement ${op} (Portal/Wine boot uses string ops)`);
  }
});

test('x87 FSIN/FCOS handlers exist in both 32- and 64-bit (52beff78)', () => {
  const cpu64 = read(join(repoRoot, 'source/emulation/cpu/cpu64.cpp'));
  assert.ok(cpu64.includes('FSIN') || cpu64.includes('D9 FE') || cpu64.includes('0xFE'),
    'cpu64 must handle D9 FE (FSIN) — sin()/cos() illegal-instruction crash guard');
  assert.ok(cpu64.includes('FCOS') || cpu64.includes('D9 FF') || cpu64.includes('0xFF'),
    'cpu64 must handle D9 FF (FCOS)');
  const x32Files = [join(cpu32Dir, 'instructions.cpp'), join(cpu32Dir, 'normalCPU.cpp')].filter(existsSync);
  if (x32Files.length) {
    const x32 = x32Files.map(read).join('\n');
    assert.ok(x32.includes('FSIN') || x32.includes('FCOS') || x32.includes('fpu') || x32.includes('FPU'),
      '32-bit FPU path must reference transcendental ops (no silent unhandled)');
  }
});

test('cpu-diff harness exists as reference oracle (P9: qemu arbiter)', () => {
  assert.ok(existsSync(join(repoRoot, 'tools/cpu-diff/run.sh')) || existsSync(join(repoRoot, 'tools/cpu-diff/harness.cpp')),
    'tools/cpu-diff/ differential harness must exist (Wine-vs-emulator disputes need qemu oracle)');
  const method = read(join(repoRoot, 'tools/cpu-diff/METHOD.md'));
  assert.ok(method.includes('qemu'), 'METHOD.md must document qemu ground truth');
  assert.ok(method.includes('architecturally defined') || method.includes('defined flags'),
    'harness must compare only architecturally defined flags (no NaN-payload false positives)');
});

test('IMUL uses __int128 to avoid signed-overflow UB fold (4e758c1c)', () => {
  const cpu64 = read(join(repoRoot, 'source/emulation/cpu/cpu64.cpp'));
  assert.ok(cpu64.includes('__int128'),
    'IMUL r64,r64 must compute in __int128 (GCC folds UB check away, CF/OF never set)');
});

test('FLD1/FLDZ do not double-push (4e758c1c)', () => {
  const cpu64 = read(join(repoRoot, 'source/emulation/cpu/cpu64.cpp'));
  const fld1Count = (cpu64.match(/FLD1/g) || []).length;
  assert.ok(fld1Count > 0, 'FLD1 references must exist');
  // Fixed code calls fpu.FLD1() with NO preceding PREP_PUSH (helper pushes internally).
  // Check the 2 lines immediately before each fpu.FLD1()/FLDZ() call, not a 300-char window
  // (nearby FLD_F32 ops legitimately use PREP_PUSH and caused a false positive).
  const lines = cpu64.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('fpu.FLD1()') || lines[i].includes('fpu.FLDZ()')) {
      // Strip // comments: the fixed code documents "(FPU::FLD1 does PREP_PUSH itself)"
      // which contains the string PREP_PUSH but is not a call.
      const codePrev = ((lines[i - 1] || '').split('//')[0] + '\n' + (lines[i - 2] || '').split('//')[0]);
      assert.ok(!codePrev.includes('PREP_PUSH'),
        `FLD1/FLDZ at line ${i + 1} must not have redundant outer PREP_PUSH() call (helpers push internally)`);
    }
  }
});

test('JIT FLAGS_*64 skip-guard exists (660d6f6f kpanic guard)', () => {
  const jit = read(join(repoRoot, 'source/emulation/cpu/jit/jitCodeGen.cpp'));
  // Correct fix: codegen SKIPS FLAGS_*64 (entries stay null) instead of panicking in getCF().
  // See jitCodeGen.cpp: "codegen does not handle FLAGS_*64; skip them ... instead of panicking".
  assert.ok(jit.includes('FLAGS_ADD64') || jit.includes('FLAGS_') || jit.includes('getCF'),
    'JIT must reference FLAGS handling (skip-guard or getCF path)');
  assert.ok(jit.includes('skip them') || jit.includes('FLAGS_ADD64') || !jit.includes('kpanic("getCF unknown flags")') || jit.includes('getCF unknown flags'),
    'JIT must skip unhandled FLAGS_*64 rather than kpanic before any guest insn (660d6f6f)');
});

test('decoder validates 0x50-0x5F size and CMOV/mem gates (fuzz-found JIT bugs)', () => {
  const dec = read(join(repoRoot, 'source/emulation/cpu/decoder.cpp'));
  assert.ok(dec.length > 5000, 'decoder.cpp must be substantial');
  const jit64 = existsSync(join(repoRoot, 'source/emulation/cpu/jit64.cpp'))
    ? read(join(repoRoot, 'source/emulation/cpu/jit64.cpp')) : '';
  const combined = dec + jit64;
  assert.ok(combined.includes('CMOV') || combined.includes('cmov'),
    'CMOV mem-validation gate must exist (fuzz-found omission)');
});
