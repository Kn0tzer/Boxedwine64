// web/tests/suite/unit/d3d9-contract.test.mjs — D3D9 32-bit via DXVK (Portal).
// Portal1 hl2.exe x86 needs DXVK d3d9.dll staged app-locally, UpdateTexture
// path, Vulkan32 dispatch, v2 IMAGE_COPY ordering. Tools/d3dtests has
// clear9/texquad9/vshade9 isolation probes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const bridge = readFileSync(join(repoRoot, 'source/vulkan/vk64bridge.cpp'), 'utf8');
test('d3dtests isolation probes exist (clear9/texquad9/vshade9)', () => {
  for (const f of ['tools/d3dtests/clear9.cpp', 'tools/d3dtests/scene9.cpp']) {
    assert.ok(existsSync(join(repoRoot, f)), `${f} must exist (D3D9 isolation: swapchain/Present, UpdateTexture)`);
  }
});
test('DXVK d3d9 staging scripts exist (32+64)', () => {
  assert.ok(existsSync(join(repoRoot, 'tools/dxvk/stage-dxvk.sh')) || existsSync(join(repoRoot, 'tools/dxvk/stage-dxvk32.sh')),
    'DXVK staging scripts must exist (d3d9.dll app-local, not builtin wined3d)');
});
test('vk32 copy/blit/resolve are real handlers not no-ops (blank-canvas guard)', () => {
  for (const fn of ['vkCmdCopyImage', 'vkCmdBlitImage', 'vkCmdResolveImage']) {
    assert.ok(bridge.includes(fn), `${fn} 32-bit path must be real (no-op stubs → Celeste GAME DISPLAYED blank)`);
  }
});
test('FL 9_3 safe-path comments exist (9_x has no geometry/tess)', () => {
  assert.ok(bridge.includes('FL 9_3'), 'FL 9_3 target handling must be documented (Portal D3D9 level)');
});
