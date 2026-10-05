# D3D12 first-light probe result — 2026-10-05

## Verdict: D3D12CreateDevice fails at vkd3d's first device-creation gate

**D3D12 LIT PIXELS: NO.** 0 frames built, 0 chunks captured. The break is
precise and deterministic.

## What ran

- Probe: `tools/vkd3d/probe/tri12.c` → `tri12.exe` (win64 PE, mingw-w64,
  clear-only: `D3D12CreateDevice` + 10× `ClearRenderTargetView` cornflower).
- Runner: `web/tests/d3d12-pixels.mjs`
  (`TAG=20261005-d3d12-clear1 TIMEOUT=900000 node web/tests/d3d12-pixels.mjs`).
- vkd3d-proton DLLs: `/home/ubuntu/wt-vkd3d/tools/vkd3d/build.w64/libs/d3d12/d3d12.dll`
  (700635 B) + `d3d12core.dll` (8986250 B), 209/209 build, pin 3.0.1.
- Guest env: `WINEDLLOVERRIDES=d3d12=n,d3d12core=n`,
  `BW64_VKTRACE=2`, `BW64_VKFRAME=1`, `LD_LIBRARY_PATH=/home/username`.
- Capture: `test-results/dxvk-20261005-d3d12-clear1/` (summary.json,
  console.log with 227 vk64 trap lines).

## Exact failure

```
tri12: FAIL D3D12CreateDevice hr=0x80070057   (E_INVALIDARG)
tri12: RESULT 1
```

vkd3d-proton's guest log names the gate:

```
err:vkd3d-proton:vkd3d_init_device_caps: Lacking support for VK_EXT_vertex_attribute_divisor.
```

## Trap sequence (from console.log) — how far the column gets

All of these cross Wine's vulkan-1.dll → winevulkan → our libvulkan.so.1
shim → vk64bridge traps successfully:

- `vkEnumerateInstanceVersion` ×1, `vkEnumerateInstanceExtensionProperties` ×4
- `vkCreateInstance` ×3
- `vkEnumeratePhysicalDevices` ×8, `vkGetPhysicalDeviceProperties` ×3,
  `vkGetPhysicalDeviceProperties2` ×2, `vkGetPhysicalDeviceMemoryProperties` ×3,
  `vkGetPhysicalDeviceQueueFamilyProperties` ×2
- `vkEnumerateDeviceExtensionProperties` ×2, `vkGetPhysicalDeviceFeatures2` ×1

**Never called: `vkCreateDevice`.** vkd3d's `d3d12_device_init` →
`vkd3d_init_device_caps` reads the Features2 chain, finds
`VK_EXT_vertex_attribute_divisor` absent from the advertised device
extensions, and returns `E_INVALIDARG` before any other gate is evaluated.

## Root cause (bridge side, read-only finding — NOT fixed here)

`source/vulkan/vk64bridge.cpp:1724` `g_dev_exts[]` does not list
`VK_EXT_vertex_attribute_divisor` (nor `VK_KHR_push_descriptor`).
`fillVulkan12Features` does not set `samplerMirrorClampToEdge`;
`fillVulkan11Features` does not set `shaderDrawParameters`;
`walkProperties2` has no `VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_PROPERTIES`
arm. These are vkd3d-proton's five hard device-creation gates
(`libs/vkd3d/device.c:2495–2519,2633–2665` @ 31d1f89); the divisor check at
`device.c:2496` fires first. Per `tools/vkd3d/CURRENT_STATUS.md` these need
real behavior, not advertisement-only reporting.

## Positive evidence (column is closer than "unverified")

The entire Vulkan ICD query path works end-to-end in-guest: instance,
physical device, properties, memory, queue families, extension lists, and
the Features2 pNext walk all return through the bridge. The ONLY missing
piece for device creation is the five gates above. The submit path
(`vkQueueSubmit2`) and dynamic-rendering path (`vkCmdBeginRendering`) that
vkd3d needs were never reached — they remain implemented-but-unexercised
for D3D12.

## Repro

```
cd /home/ubuntu/boxedwine64   # branch integrate/schema-v2
TAG=20261005-d3d12-clear2 TIMEOUT=900000 node web/tests/d3d12-pixels.mjs
```

Expect `tri12: RESULT 1` + the divisor gate line until the bridge implements
the five gates. After a bridge fix, re-run: clear-only success = 10 frames,
`stats.v2.rendered > 0`, `pixels.cornflowerPx > 1000`.
