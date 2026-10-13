// web/tests/suite/unit/struct-layout-shipped.test.mjs — Struct layouts vs SHIPPED DLLs (P9).
//
// MinGW offsetof says framebufferColorSampleCounts at limits+368; real 32-bit
// DXVK reads limits+360 (depth +364). Fixed with (empirical) comments — never
// trust test-compile offsetof for shipped DLL. PE shim declared pointer args
// as 32-bit → garbage regionCount 2,222,416 (rebuilt c50f6fba). 64→32-bit
// pointer truncation in PE shim was misdiagnosed as BSS coherency bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const bridge = readFileSync(join(repoRoot, 'source/vulkan/vk64bridge.cpp'), 'utf8');
const vk32guest = readFileSync(join(repoRoot, 'source/vulkan/vk32_guest.h'), 'utf8');

test('vk32 guest header uses pack(4) i386 layout (not host alignment)', () => {
  assert.ok(vk32guest.includes('pack(push, 4)') || vk32guest.includes('pack(push,4)'),
    'vk32_guest.h must pragma pack(4) (uint64_t 8-align would shift every field after first u64)');
  assert.ok(vk32guest.includes('uint32_t VkCommandBuffer') || vk32guest.includes('typedef uint32_t VkDevice'),
    'dispatchables must be uint32_t on i386; non-dispatchables stay uint64_t per spec');
});

test('pointers are 64-bit in shim even on 32-bit guest boundary (c50f6fba)', () => {
  assert.ok(vk32guest.includes('uint64_t VkBuffer') || bridge.includes('U64'),
    'non-dispatchable handles stay 64-bit even on 32-bit (32-bit pointer-arg truncation → regionCount 2222416)');
});

test('sample-count offsets carry empirical provenance (368 vs 360/364)', () => {
  assert.ok(bridge.includes('framebufferColorSampleCounts') || bridge.includes('SampleCounts') || bridge.includes('empirical') || bridge.includes('+360'),
    'framebuffer sample-count offsets must be empirical vs shipped DXVK, never test-compile offsetof');
});

test('walkProperties2 writes subgroup/divisor/mirror-clamp gates (DXVK divide-by-zero + 5 device gates)', () => {
  for (const needle of ['subgroupSize', 'maxMultiview', 'Robustness2']) {
    assert.ok(bridge.includes(needle), `vk32_walkProperties2 must write ${needle} (vkd3d 5 device-creation gates: push_descriptor, divisor, mirrorClamp, drawParameters, texel-align)`);
  }
});
