// web/tests/suite/unit/d3d10-contract.test.mjs — D3D10 swapchain (device OK, present must re-verify).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
test('d3d10 bare/dev probes exist', () => {
  assert.ok(existsSync(join(repoRoot, 'tools/d3dtests/d10bare.c')) || existsSync(join(repoRoot, 'tools/d3dtests/d3d10dev.cpp')),
    'D3D10 bare/device probes must exist (device works, presentation re-verify after R5/R6)');
});
test('swapchain present path exists in vk bridge', () => {
  const b = readFileSync(join(repoRoot, 'source/vulkan/vk64bridge.cpp'), 'utf8');
  assert.ok(b.includes('vkCreateSwapchainKHR') && b.includes('vkQueuePresentKHR'), 'swapchain create+present must exist (D3D10 presentation)');
});
