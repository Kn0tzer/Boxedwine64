// web/tests/suite/unit/d3d11-contract.test.mjs — D3D11 (Gang Beasts x64 Unity, tri11 9_3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const bridge = readFileSync(join(repoRoot, 'source/vulkan/vk64bridge.cpp'), 'utf8');
test('D3D11 FL9_3 device path + vkCmdCopyBuffer HIT (LIT=8192 guard)', () => {
  assert.ok(bridge.includes('FL 9_3'), 'FL 9_3 handling must exist');
  const shim = readFileSync(join(repoRoot, 'tools/rootfs64/libvk64/libvk64.c'), 'utf8');
  assert.ok(shim.includes('vkCmdCopyBuffer'), 'vkCmdCopyBuffer must be shim-registered (LIT=0 MISS guard)');
});
test('tri11 9_3 stats probe exists', () => {
  const src = readFileSync(join(repoRoot, 'web/tests/tri11-93-stats.mjs'), 'utf8');
  assert.ok(src.includes('D3D11CreateDevice'), 'tri11-93 stats must check D3D11CreateDevice OK');
});
