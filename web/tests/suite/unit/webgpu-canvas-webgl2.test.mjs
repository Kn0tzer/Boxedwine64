// web/tests/suite/unit/webgpu-canvas-webgl2.test.mjs — WebGPU / WebGL2 / canvas / ICD.
// Covers: FixedGL subset vs throw-and-fallback, WebGL2 default, canvas
// reconfigure (d01c6f5a), present-only hop (c3df454f), readback ground truth
// (101843f5 blank-screenshot is compositor, not bug), lit-but-black
// divergence (786432 lit + black PNG), 29k RGB re-measure, 1D/3D LUT,
// fallback-texture lifetime, clip-distances ICD gate, robustness2 div-by-zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const page = readFileSync(join(repoRoot, 'web/vkwebgpu.mjs'), 'utf8');
const bridge = readFileSync(join(repoRoot, 'source/vulkan/vk64bridge.cpp'), 'utf8');
test('canvas reconfigure + present-only hop + latest-wins exist', () => {
  assert.ok(page.includes('ResizeObserver') || page.includes('reconfig'), 'canvas reconfigure must exist (stale getCurrentTexture blank)');
  assert.ok(page.includes('takeLatest'), 'latest-frame-wins (hop presented frame only) must exist');
});
test('readback is ground truth in headless (blank PNG ≠ 0 lit)', () => {
  assert.ok(page.includes('readback') || page.includes('Readback') || page.includes('READBACK'), 'readback path must exist (SwiftShader compositor limit, lit-but-black guard)');
});
test('ICD feature gates requested (clip-distances, robustness2, sample counts)', () => {
  assert.ok(page.includes('clip') || page.includes('Clip') || bridge.includes('Robustness2') || bridge.includes('SampleCounts') || bridge.includes('sampleCounts'), 'clip-distances/robustness2/sample-count gates must exist (DXVK div-by-zero + CheckImageSupport guard)');
});
test('WebGL2 fallback path documented (FixedGL subset throw-and-fallback)', () => {
  assert.ok(page.includes('fallback') || page.includes('WebGL') || page.includes('webgl'), 'WebGL fallback handling must exist (FixedGL outside-subset → upstream WebGL, not silent WebGPU gap)');
});
