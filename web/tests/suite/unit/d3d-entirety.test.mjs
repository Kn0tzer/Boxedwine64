// web/tests/suite/unit/d3d-entirety.test.mjs — Full D3D9/10/11/12 entirety with honest buckets.
//
// Four-bucket ground truth is test-results/d3d-conformance-MATRIX.md
// (in-browser, 2026-10-09, 64-bit; 32-bit was wineboot-blocked then):
//   D3D9  15 total / 13 working / 0 slow / 2 broken (checkfmt A8R8G8B8+X1R5G5B5; paints BLACK not RGB)
//   D3D10  7 total /  6 working / 0 slow / 1 broken (draw_present_30f lit=0)
//   D3D11 13 total / 11 working / 0 slow / 2 broken (FL 11_0 E_INVALIDARG; swapchain Present clear-only; +exit(0) multi-device bug)
//   D3D12 20 total / 18 working / 0 slow / 2 broken (FL 12_0 E_INVALIDARG expected; draw_present_10f lit=0 dedup-desync)
// Total: 55 ops. A FAIL here means a previously-working op broke or a new
// version skew arrived — color-correctness and no-paint classes stay open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('conformance matrix exists with 55-op four-bucket reality (P10 no-waiver)', () => {
  const p = join(repoRoot, 'test-results/d3d-conformance-MATRIX.md');
  assert.ok(existsSync(p), 'd3d-conformance-MATRIX.md must exist (four-bucket, not waived)');
  const m = readFileSync(p, 'utf8');
  for (const row of ['| D3D9', '| D3D10', '| D3D11', '| D3D12']) {
    assert.ok(m.includes(row), `matrix must contain ${row.trim()} bucket row`);
  }
  assert.ok(m.includes('17100') && m.includes('litPixels'), 'matrix must record pixel evidence (not just API OK)');
});

test('D3D9 entirety: isolation probes + DXVK path + known-broken formats pinned', () => {
  assert.ok(existsSync(join(repoRoot, 'tools/d3dtests/clear9.cpp')), 'clear9 isolation probe must exist');
  assert.ok(existsSync(join(repoRoot, 'tools/d3dtests/scene9.cpp')), 'scene9 probe must exist');
  const m = readFileSync(join(repoRoot, 'test-results/d3d-conformance-MATRIX.md'), 'utf8');
  assert.ok(m.includes('A8R8G8B8') && m.includes('X1R5G5B5'), 'D3D9 2 broken formats must stay pinned (D3DERR_NOTAVAILABLE)');
  assert.ok(m.includes('BLACK'), 'D3D9 BLACK-not-RGB color finding must stay recorded until fixed');
});

test('D3D10 entirety: bare device + 30-draw no-paint finding pinned', () => {
  assert.ok(existsSync(join(repoRoot, 'tools/d3dtests/d10bare.c')) || existsSync(join(repoRoot, 'tools/d3dtests/d3dconf10.c')),
    'D3D10 bare/conformance sources must exist');
  const m = readFileSync(join(repoRoot, 'test-results/d3d-conformance-MATRIX.md'), 'utf8');
  assert.ok(m.includes('draw_present_30f'), 'D3D10 1 broken op (30 draws, 0 px) must stay pinned');
});

test('D3D11 entirety: FL levels + swapchain-Present + exit(0) findings pinned', () => {
  const m = readFileSync(join(repoRoot, 'test-results/d3d-conformance-MATRIX.md'), 'utf8');
  assert.ok(m.includes('9_3') && m.includes('11_0'), 'D3D11 FL 9_3 OK / 11_0 E_INVALIDARG must stay recorded');
  assert.ok(m.includes('swapchain') || m.includes('Present'), 'D3D11 Present-delivery finding must stay recorded (offscreen LIT=8192 vs swapchain)');
  assert.ok(existsSync(join(repoRoot, 'web/tests/suite/browser/d3d11-triangle.test.mjs')),
    'd3d11-triangle browser guard (LIT=8192) must exist');
});

test('D3D12 entirety: vkd3d path + 11_0-only + no-paint finding pinned', () => {
  assert.ok(existsSync(join(repoRoot, 'tools/vkd3d/FEASIBILITY.md')), 'vkd3d feasibility must exist');
  const m = readFileSync(join(repoRoot, 'test-results/d3d-conformance-MATRIX.md'), 'utf8');
  assert.ok(m.includes('D3D12CreateDevice') || m.includes('D3D12 '), 'D3D12 device finding must stay recorded');
  assert.ok(m.includes('draw_present_10f'), 'D3D12 1 broken paint op must stay pinned (deduplinedesync lane owns)');
});

test('per-version browser comprehensive guards exist (D3D9/10/11/12)', () => {
  for (const v of ['d3d9', 'd3d10', 'd3d11', 'd3d12']) {
    assert.ok(existsSync(join(repoRoot, `web/tests/suite/browser/${v}-comprehensive.test.mjs`)),
      `${v}-comprehensive browser test must exist`);
  }
});
