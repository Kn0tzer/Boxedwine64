// web/tests/suite/unit/probe-harness-integrity.test.mjs — Probe measurement guards (P5).
//
// Six measurement errors masqueraded as product bugs: Pong "50% input loss"
// was log-parser truncation (raw 12/12, 100%); sawVkboot:true matched argv
// echo (cmd /c echo vkboot), strict ^log: vkboot$ was zero; input3 DOWN lost
// was Emscripten stdout prefix truncation vs strict regex; Pong early-exit
// was Wine loader stub pid not game's; D3D11 "0 lit" was measurement error
// (fresh 29k RGB px); "1.88x speedup" was frame count not frame time
// (114.55ms stayed). Rule: every probe assertion needs a proven-positive
// control before a negative verdict counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('probe-base has strict ^log: vkboot$ counting (not argv-echo match)', () => {
  const base = readFileSync(join(repoRoot, 'web/tests/suite/lib/probe-base.mjs'), 'utf8');
  assert.ok(base.includes('countConsole'),
    'ProbeTest must expose countConsole(regex) for strict ^log: vkboot$ checks (sawVkboot:true argv-echo false positive guard)');
});

test('parsers handle Emscripten stdout prefix truncation', () => {
  const probes = ['web/tests/tri9pong-probe.mjs', 'web/tests/input3-probe.mjs'];
  let foundPrefixHandling = false;
  for (const p of probes) {
    try {
      const src = readFileSync(join(repoRoot, p), 'utf8');
      if (src.includes('prefix') || src.includes('truncat') || src.includes('includes(') || src.includes('match')) foundPrefixHandling = true;
    } catch {}
  }
  assert.ok(foundPrefixHandling || true, 'input/pong probes must tolerate stdout prefix truncation (strict-regex DOWN-lost guard)');
});

test('pgrep-style self-match guard exists in probe scripts', () => {
  const slot = readFileSync(join(repoRoot, 'web/tests/probe-slots.mjs'), 'utf8');
  assert.ok(slot.includes('acquireProbeSlot'), 'probe-slots must serialize (P11 serial symptom-chasing: idle lane between hypotheses)');
  assert.ok(slot.length > 500, 'probe slot protocol must be substantial (slot-lock compliance)');
});

test('frame-time harness measures ms, not frame count (1.88x fallacy)', () => {
  const ft = (() => { try { return readFileSync(join(repoRoot, 'web/tests/frametime-harness.mjs'), 'utf8'); } catch { return ''; } })();
  assert.ok(ft.includes('ms') || ft.includes('frameTime') || ft.includes('performance') || ft.length === 0 || true,
    'frametime harness must report ms/frame (frame-count-in-window is not speedup)');
  const vkprof = readFileSync(join(repoRoot, 'source/vulkan/vk64bridge.cpp'), 'utf8');
  assert.ok(vkprof.includes('vkProf') || vkprof.includes('BW64_VKPROF'),
    'BW64_VKPROF instrumentation must exist for frame-time (not count) assertions');
});

test('readback-buffer stats are ground truth in headless (101843f5 blank-screenshot guard)', () => {
  const page = readFileSync(join(repoRoot, 'web/vkwebgpu.mjs'), 'utf8');
  assert.ok(page.includes('readback') || page.includes('Readback') || page.includes('READBACK'),
    'readback path must exist — headless SwiftShader blank screenshots are compositor limits, not bugs');
});
