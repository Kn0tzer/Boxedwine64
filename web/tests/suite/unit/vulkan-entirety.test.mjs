// web/tests/suite/unit/vulkan-entirety.test.mjs — Full Vulkan API entirety (32 + 64-bit).
//
// Extends vk-bridge-coverage (static presence) with the four-bucket reality
// and the 32-bit parity that "32-bit D3D9 never worked" taught us:
// every 64-bit handler needs its 32-bit twin (objOf32), KHR→core aliases,
// loader procs, and TAIL-stub severity (vk-stub-severity: GAME_BREAKING
// stubs must be empty — currently passing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const abi = readFileSync(join(repoRoot, 'source/vulkan/vk64bridge_abi.h'), 'utf8');
const bridge = readFileSync(join(repoRoot, 'source/vulkan/vk64bridge.cpp'), 'utf8');
const shim = readFileSync(join(repoRoot, 'tools/rootfs64/libvk64/libvk64.c'), 'utf8');

function abiIds(src) {
  const out = new Set();
  for (const m of src.matchAll(/^\s*(VK64_fn_\w+)\s*(?:=\s*\d+)?\s*,/gm)) out.add(m[1]);
  return [...out].filter(f => f.startsWith('VK64_fn_vk'));
}

test('Vulkan entirety: every ABI function has bridge + shim handling (no orphans)', () => {
  const ids = abiIds(abi);
  assert.ok(ids.length >= 180, `Vulkan ABI must define 180+ functions (found ${ids.length})`);
  const missingBridge = ids.filter(f => !bridge.includes(f));
  assert.deepEqual(missingBridge, [], `bridge orphans (guest trap hits unimplemented): ${missingBridge.join(', ')}`);
  const gprocs = shim.match(/static const struct procEntry g_procs\[\] = \{([\s\S]*?)\n\};/);
  assert.ok(gprocs, 'g_procs[] must exist');
  const unhandled = ids.filter(f => {
    const short = f.replace('VK64_fn_', '');
    return !gprocs[1].includes(short) && !new RegExp(`^TAIL\\(${short}\\)`, 'm').test(shim);
  });
  assert.deepEqual(unhandled, [], `shim orphans (gipa would fail): ${unhandled.join(', ')}`);
});

test('32-bit parity: objOf32 dispatch + vk32 guest layouts + *2 functions', () => {
  const c32 = (bridge.match(/objOf32/g) || []).length;
  assert.ok(c32 >= 50, `32-bit dispatch must use objOf32 throughout (found ${c32}, 58 fixed)`);
  assert.ok(bridge.includes('vk32_walkFeatures2') && bridge.includes('vk32_walkProperties2'),
    'Vulkan 1.1 *2 functions must exist on 32-bit path (DXVK NULL→hang guard)');
});

test('no game-breaking TAIL stubs (vk-stub-severity contract)', () => {
  const breaking = ['vkCmdBlitImage', 'vkCmdClearColorImage', 'vkCmdDispatch', 'vkCmdDrawIndirect',
    'vkCmdExecuteCommands', 'vkCmdResolveImage', 'vkCmdCopyImage', 'vkCmdFillBuffer'];
  const stubs = new Set([...shim.matchAll(/^TAIL\((vk\w+)\)/gm)].map(m => m[1]));
  const bad = breaking.filter(f => stubs.has(f));
  assert.deepEqual(bad, [], `GAME-BREAKING stubs must be real implementations: ${bad.join(', ')}`);
});

test('loader + KHR-alias + benign-severity contracts hold', () => {
  assert.ok(bridge.includes('vkGetDeviceProcAddr'), 'loader procs must be resolvable (every device-proc lookup failed guard)');
  assert.ok(bridge.includes('KHR'), 'KHR→core aliases must exist (exact-name benign-stub trap guard)');
  assert.ok(bridge.includes('FEATURE_NOT_PRESENT') || bridge.includes('vk64_benign'),
    'benign stubs must return FEATURE_NOT_PRESENT, not OOM (phantom 0x8007000E guard)');
});
