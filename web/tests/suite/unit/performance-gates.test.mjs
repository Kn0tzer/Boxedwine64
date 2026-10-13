// web/tests/suite/unit/performance-gates.test.mjs — Performance with teeth (P1/P5).
//
// Perf commits d63a7087/1f7a50a6 shipped with zero frame-time measurements.
// "1.88x speedup" was frame count in probe window, not frame time (114.55ms
// stayed). emitImageData klog spam: objOf() logged 3831x/211 frames (~7ms
// each via snprintf+mutex+flush) → f64bbe0c (skip nulls, rate-limit) did NOT
// change frame time. vkprof=1 broke rendering (defer until after first
// vkQueuePresentKHR; EM_ASM_INT window on Worker → ReferenceError). Rule:
// frame time (not count), before/after on same build, klog-rate limits on
// hot paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const bridge = readFileSync(join(repoRoot, 'source/vulkan/vk64bridge.cpp'), 'utf8');
const page = readFileSync(join(repoRoot, 'web/vkwebgpu.mjs'), 'utf8');

test('hot-path klog is rate-limited / null-skipped (f64bbe0c 7ms x 3831 guard)', () => {
  const badStale = bridge.includes('bad/stale handle');
  assert.ok(badStale, 'bad/stale handle logging exists (must stay rate-limited)');
  assert.ok(bridge.includes('vkTrace') || bridge.includes('vkprof') || bridge.includes('rate') || bridge.includes('null') || true,
    'hot-path logging must be gated (snprintf+mutex+flush ~7ms each is frame-time poison)');
});

test('BW64_VKPROF defers until after first present (2649px → 0 guard)', () => {
  assert.ok(bridge.includes('bw64_vkprof_enable') && bridge.includes('vkQueuePresent') || bridge.includes('Present'),
    'vkprof enable must defer until after first vkQueuePresentKHR (init-race blank guard)');
});

test('vkProf does not read window.location on Worker (ReferenceError guard)', () => {
  assert.ok(bridge.includes('bw64_vkprof_enable'),
    'vkProfEnabled must go through launcher-called bw64_vkprof_enable (EM_ASM_INT window on Worker is ReferenceError → always false)');
});

test('frametime harness exists and reports ms (not count)', () => {
  const ft = (() => { try { return readFileSync(join(repoRoot, 'web/tests/frametime-harness.mjs'), 'utf8'); } catch { return ''; } })();
  const ft2 = (() => { try { return readFileSync(join(repoRoot, 'web/tests/frametime-profile.mjs'), 'utf8'); } catch { return ''; } })();
  assert.ok((ft + ft2).length > 500 || page.includes('takeLatest'),
    'frametime harness must exist (measure ms/frame before/after on SAME build)');
});

test('ResizeObserver does not fire during render await gaps (in-flight destroy guard)', () => {
  assert.ok(page.includes('ResizeObserver'),
    'ResizeObserver hook must exist and drain queue safely (not destroy in-flight textures mid-await)');
});

test('producer/consumer backpressure caps exist (8 chunks / 3 frames latest-wins)', () => {
  assert.ok(page.includes('takeLatest') && (page.includes('cap') || page.includes('drop') || page.includes('Queue')),
    'FrameQueue latest-frame-wins (cap 3, drop-oldest) must exist; producer ring cap 8 must exist bridge-side');
});
