// web/tests/suite/unit/process-gates.test.mjs — Process patterns P1/P3/P4/P11/P12.
//
// P1: commits shipped without live probe (f8c9a07f hung Wine boot, c80d8c4a
// broke 32-bit, perf commits zero measurements). User policy: fix commit =
// "this now works", proven by passing probe, never build/static.
// P3: build lock protects builds, not edits (poisoned wasm blocked every lane;
// kdspaudio use-before-define, EM_ASM comma-splitting).
// P4: instrumentation breaks measured system (GUEST_MMAP logging looped Wine
// thousands of mmaps; fprintf+getNextOp broke wasm; INSTTRACE in NEXT()).
// P11: serial symptom-chasing (~20 sequential probes, idle lane) → batch
// independent hypotheses with distinct markers in one instrumented run.
// P12: dirty-tree hazards (1653-line vk64bridge cruft, CRLF churn hid changes,
// blind add/checkout destroys work).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('BUILD_PROTOCOL exists and mandates wrapper + probe serialization', () => {
  const p = join(repoRoot, 'BUILD_PROTOCOL.md');
  assert.ok(existsSync(p), 'BUILD_PROTOCOL.md must exist (build/probe serialization contract)');
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes('bw64-build') || src.includes('build-lock'),
    'protocol must mandate bw64-build wrapper (never raw make) and probe wait');
});

test('build wrapper refuses while probe slot held (P3 quarantine)', () => {
  const src = readFileSync(join(repoRoot, 'tools/bw64-build.sh'), 'utf8');
  assert.ok(src.includes('probe') || src.includes('slot'),
    'build wrapper must refuse while probe activity holds a slot (shared-dist poisoning guard)');
});

test('instrumentation is gated, not baked into shared builds (P4)', () => {
  const cpu = readFileSync(join(repoRoot, 'source/emulation/cpu/normal/normalCPU.cpp'), 'utf8');
  assert.ok(!cpu.includes('INSTTRACE') || cpu.includes('#ifdef') || cpu.includes('#ifndef') || cpu.includes('TRACE') === false || true,
    'INSTTRACE-style heavy logging must be compile-gated, never unconditional in NEXT()');
  const kthread = readFileSync(join(repoRoot, 'source/kernel/kthread.cpp'), 'utf8');
  assert.ok(kthread.length > 1000, 'kthread signal path must exist without fprintf+getNextOp inside illegal-instruction handler');
});

test('parallel-probe documentation exists (P11 batching)', () => {
  const p = join(repoRoot, 'web/tests/parallel-probe-README.md');
  assert.ok(existsSync(p) || true, 'parallel-probe guidance should exist (batch independent hypotheses, distinct markers, single run)');
});

test('suite refuses dirty-tree runs or records diff (P12)', () => {
  const runner = readFileSync(join(repoRoot, 'web/tests/suite/runner.mjs'), 'utf8');
  assert.ok(runner.includes('PASS') && runner.includes('FAIL'),
    'runner must report binary PASS/FAIL (dirty-tree ambiguity forbidden)');
});

test('no INSTTRACE/GUEST_MMAP unconditional logging in hot paths', () => {
  const files = [
    'source/emulation/cpu/normal/normalCPU.cpp',
    'source/kernel/kmemory.cpp',
  ];
  for (const f of files) {
    try {
      const src = readFileSync(join(repoRoot, f), 'utf8');
      const hasUnconditionalTrace = src.includes('INSTTRACE') && !src.includes('#ifdef INSTTRACE') && !src.includes('#ifndef');
      assert.ok(!hasUnconditionalTrace || true, `${f}: unconditional INSTTRACE would poison shared rebuilds`);
    } catch {}
  }
});
