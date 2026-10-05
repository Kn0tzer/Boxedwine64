# ICD work items for vkd3d (lane-vkd3d, 2026-10-05)

**Historical sketches, superseded by [CURRENT_STATUS.md](CURRENT_STATUS.md).**
The five gates require implemented renderer behavior, not just reporting bits.
Do not apply the advertisement-only sketches. These are patch sketches for the `source/vulkan/` lane
(`vk64bridge_abi.h` is the boundary surface; `vk64bridge.cpp` and
`tools/rootfs64/libvk64/libvk64.c` implement it). All references below are to
vkd3d-proton @ `31d1f89` (`tools/vkd3d/src`) and the current bridge.

Method: every `return E_INVALIDARG` gate in vkd3d's device init was checked
against what the bridge advertises; every `VK_CALL(vk*)` on vkd3d's basic
render path was checked against the 85 + extras fn-ids. What follows is the
complete delta, ordered so device creation passes before command recording
matters.

## Part A — device-creation gates (5 items)

vkd3d-proton fails `d3d12_device_init` with `E_INVALIDARG` unless ALL of these
hold. They are pure reporting changes: the bridge already answers these
queries, it just answers them wrong for vkd3d.

### A1. Advertise `VK_KHR_push_descriptor` (device ext) — HARD gate

`device.c:2661`: "Push descriptors are not supported by this implementation.
This is required for correct operation." vkd3d pushes root descriptors with
`vkCmdPushDescriptorSetKHR` (`command.c`, 5 call sites); without the extension
advertised, device creation dies before any command list exists.

```c
// vk64bridge.cpp, g_dev_exts[] (line ~906):
const char* const g_dev_exts[] = {
    "VK_KHR_swapchain",
    "VK_KHR_maintenance5",
    "VK_KHR_maintenance6",
    "VK_KHR_load_store_op_none",
    "VK_KHR_push_descriptor",        // ADD: vkd3d hard requirement (device.c:2661)
    "VK_EXT_robustness2",
    "VK_EXT_transform_feedback",
    "VK_EXT_depth_clip_enable",
};
```

Bridge-side behavior: none needed beyond the advertisement — vkd3d will then
call `vkCmdPushDescriptorSetKHR`, which is work item B4.

### A2. Advertise `VK_EXT_vertex_attribute_divisor` (device ext, spec ≥ 3) — HARD gate

`device.c:2496`: `vertexAttributeInstanceRateDivisor &&
vertexAttributeInstanceRateZeroDivisor` must be TRUE or `E_INVALIDARG`.
vkd3d additionally downgrades the extension if
`get_spec_version(...) < 3` (`device.c:2318`), so the advertised spec version
matters. Note the bridge hardcodes `specVersion = VK_API_VERSION_1_3` for
device extensions today (line ~1361) — that reads as spec 1.3.0, which is ≥ 3
only by accident of the encoding; a per-extension spec version table is the
honest fix, but for this item any value ≥ 3 keeps the extension enabled.

```c
// vk64bridge.cpp, g_dev_exts[]: append
    "VK_EXT_vertex_attribute_divisor", // ADD: vkd3d hard requirement (device.c:2496)
// walkFeatures2: new arm
inline void fillVertexDivisor(VkPhysicalDeviceVertexAttributeDivisorFeaturesEXT& f) {
    f.vertexAttributeInstanceRateDivisor = VK_TRUE;
    f.vertexAttributeInstanceRateZeroDivisor = VK_TRUE;
}
// case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VERTEX_ATTRIBUTE_DIVISOR_FEATURES_EXT:
//     SET_FEATURES(cur, fillVertexDivisor, VkPhysicalDeviceVertexAttributeDivisorFeaturesEXT); break;
```

### A3. `samplerMirrorClampToEdge = TRUE` (Vulkan 1.2 features) — HARD gate

`device.c:2633`: `E_INVALIDARG` without it. The current `fillVulkan12Features`
sets timelineSemaphore, bufferDeviceAddress=FALSE, and the descriptor-indexing
bits, but not this one.

```c
// vk64bridge.cpp, fillVulkan12Features: append
    f.samplerMirrorClampToEdge = VK_TRUE;   // ADD: vkd3d hard requirement (device.c:2633)
```

### A4. `shaderDrawParameters = TRUE` (Vulkan 1.1 features) — HARD gate

`device.c:2655`: `E_INVALIDARG` without it. The current `fillVulkan11Features`
sets storage-16, multiview, variablePointers, but not this one.

```c
// vk64bridge.cpp, fillVulkan11Features: append
    f.shaderDrawParameters = VK_TRUE;       // ADD: vkd3d hard requirement (device.c:2655)
```

### A5. Model `VkPhysicalDeviceVulkan13Properties` in `walkProperties2` — HARD gate

`device.c:2507`: `storageTexelBufferOffsetSingleTexelAlignment ||
storageTexelBufferOffsetAlignmentBytes == 1` (and the uniform twin) must hold
or `E_INVALIDARG` ("Lacking support for single texel alignment"). The struct
is not modeled at all today → stays zero → gate fails.

```c
// vk64bridge.cpp, walkProperties2: new arm
case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_PROPERTIES: {
    VkPhysicalDeviceVulkan13Properties p = {};
    g_mem->memcpyFromGuest(&p, cur, sizeof(p));
    p.storageTexelBufferOffsetAlignmentBytes = 1;
    p.uniformTexelBufferOffsetAlignmentBytes = 1;
    p.storageTexelBufferOffsetSingleTexelAlignment = VK_TRUE;
    p.uniformTexelBufferOffsetSingleTexelAlignment = VK_TRUE;
    // (other 1.3 properties left zero: vkd3d only gates on the texel bits;
    //  zeros degrade gracefully per the walker's contract)
    g_mem->memcpyToGuest(cur, &p, sizeof(p));
    break;
}
```

Already-OK (no work): `VK_KHR_surface` + `VK_KHR_win32_surface` instance
exts (vkd3d's `d3d12core` demands both at instance creation;
`libs/d3d12core/main.c:571`), robustness2 trio, maintenance5/6 features,
transform-feedback properties, timeline semaphores, loader version 1.3.

## Part B — entry-point gaps (hot path)

The bridge's command vocabulary (85 ids) was built for vkcube + DXVK-D3D9.
vkd3d-proton's basic path uses dynamic rendering, synchronization2 submits,
and push descriptors throughout. New fn-ids go in an 800+ block
(append-only; 700+ is the P2-NOW extras block).

### B1. `vkQueueSubmit2` — CRITICAL, the frame manifest never fires without it

vkd3d submits exclusively via `vkQueueSubmit2` (`command.c`, 8 call sites;
no `vkQueueSubmit` fallback). The manifest builder hangs off
`VK64_fn_vkQueueSubmit` (fn 600), which vkd3d never calls. The new arm
converts `VkSubmitInfo2` → the same frame serializer: walk
`pWaitSemaphoreInfos` / `pCommandBufferInfos` / `pSignalSemaphoreInfos`
(out of guest memory), reusing the existing per-batch logic; the timeline
`VkSemaphoreSubmitInfo` values feed the same u64-counter emulation the
`VkTimelineSemaphoreSubmitInfo` pNext path uses today.

```c
// vk64bridge_abi.h (new block):
    VK64_fn_vkQueueSubmit2 = 800,   // (queue, nSubmits, pSubmitInfos2*, fence)
// libvk64.c:
API VkResult vkQueueSubmit2(VkQueue q, uint32_t n, const void* infos, VkFence f) {
    VK64Args a = {{0}}; a.a[0] = q; a.a[1] = n; a.a[2] = P(infos); a.a[3] = f;
    return (VkResult)vk64_trap(VK64_fn_vkQueueSubmit2, &a);
}
// + E(vkQueueSubmit2, VK64_fn_vkQueueSubmit2) in g_procs[]
// vk64bridge.cpp: case VK64_fn_vkQueueSubmit2: { /* VkSubmitInfo2 -> manifest */ }
```

### B2. `vkCmdBeginRendering` / `vkCmdEndRendering` — CRITICAL

Dynamic rendering is vkd3d's only render path (10+ call sites in
`command.c`: 4470, 5979, 6054, 10100, 12524…). The bridge records only
render-pass commands (`vkCmdBeginRenderPass` etc.). The arm must capture the
`VkRenderingInfo`: color/depth attachments (image views, load/store ops,
clear values) — the clear values are what the page tier turns into the
WebGPU clear, so this is also where "D3D12 clear" becomes visible.

```c
    VK64_fn_vkCmdBeginRendering = 802,  // (cmdBuf, pRenderingInfo*)
    VK64_fn_vkCmdEndRendering,          // (cmdBuf)
```

### B3. `vkCmdPushDescriptorSetKHR` — CRITICAL for any draw

Root descriptors are pushed per command list (`command.c` 8150, 10091,
10782, 12358, 12557). The arm records `(pipelineBindPoint, layout, set,
descriptorWriteCount, pDescriptorWrites)` into the command stream; the page
tier resolves them the same way it resolves `vkUpdateDescriptorSets` writes
today.

```c
    VK64_fn_vkCmdPushDescriptorSetKHR = 804, // (cmdBuf, bindPoint, layout, set, nWrites, pWrites*)
```

### B4. Draw path: `vkCmdBindVertexBuffers`, `vkCmdBindIndexBuffer`, `vkCmdDrawIndexed`

The 85 have `vkCmdDraw` but no vertex/index binding and no indexed draw —
vkd3d always draws indexed (`vkCmdDrawIndexed`, `command.c`).

```c
    VK64_fn_vkCmdBindVertexBuffers = 805, // (cmdBuf, first, n, pBufs*, pOffsets*)
    VK64_fn_vkCmdBindIndexBuffer,         // (cmdBuf, buffer, offset, indexType)
    VK64_fn_vkCmdDrawIndexed,            // (cmdBuf, indexCount, instanceCount, firstIndex, vertexOffset, firstInstance)
```

### B5. Dynamic state with count: `vkCmdSetViewportWithCount`, `vkCmdSetScissorWithCount`

vkd3d uses the `*WithCount` forms (extended-dynamic-state path). Record like
the existing viewport/scissor arms, with the count-sourced arrays.

```c
    VK64_fn_vkCmdSetViewportWithCount = 808, // (cmdBuf, nViewports, pViewports*)
    VK64_fn_vkCmdSetScissorWithCount,        // (cmdBuf, nScissors, pScissors*)
```

### B6. Barriers and copies: `vkCmdPipelineBarrier2`, `vkCmdCopyBuffer(2)`, `vkCmdClearColorImage`, `vkCmdClearAttachments`

`vkCmdPipelineBarrier2` has 10 call sites — it is vkd3d's barrier, not
`vkCmdPipelineBarrier`. `VkDependencyInfo` needs the same pNext walk the
bridge already does for `VkTimelineSemaphoreSubmitInfo`. Copies drive
uploads; clears drive `ClearRenderTargetView`.

```c
    VK64_fn_vkCmdPipelineBarrier2 = 810, // (cmdBuf, pDependencyInfo*)
    VK64_fn_vkCmdCopyBuffer,             // (cmdBuf, src, dst, nRegions, pRegions*)
    VK64_fn_vkCmdCopyBuffer2,           // (cmdBuf, pCopyInfo2*)
    VK64_fn_vkCmdClearColorImage,        // (cmdBuf, image, layout, pColor*, nRanges, pRanges*)
    VK64_fn_vkCmdClearAttachments,       // (cmdBuf, nAttachments, pAttachments*, nRects, pRects*)
```

### B7. Supporting queries and objects

| fn-id (813+) | why |
|---|---|
| `vkGetPhysicalDeviceImageFormatProperties` | vkd3d queries format features during device init (2 files) |
| `vkGetPhysicalDeviceFormatProperties2` | same, `*2` form |
| `vkGetPhysicalDeviceSurfaceCapabilities2KHR` | swapchain creation path (1 file) |
| `vkCreateBufferView` / `vkDestroyBufferView` | texel-buffer root descriptors |
| `vkFlushMappedMemoryRanges` | vkd3d flushes mapped ranges (2 files); bridge memory is host-coherent so the arm can be a logged no-op returning SUCCESS, but the trap must exist |
| `vkResetDescriptorPool` / `vkFreeDescriptorSets` | descriptor recycling |
| `vkGetDescriptorSetLayoutSupport` | layout validation |
| `vkCreateQueryPool` / `vkDestroyQueryPool` / `vkGetQueryPoolResults` / `vkCmdBeginQuery` / `vkCmdEndQuery` / `vkCmdResetQueryPool` | timestamp/occlusion queries; vkd3d creates query pools eagerly — verify against the probe, stub honestly if unused |
| `vkMergePipelineCaches` / `vkGetPipelineCacheData` | pipeline cache round-trip |

## Part C — explicitly out of scope for first light

Ray tracing (`VK_KHR_ray_tracing_pipeline`, `..._maintenance1`,
`VK_KHR_acceleration_structure`), mesh shaders (`VK_EXT_mesh_shader`),
`VK_EXT_descriptor_buffer`, cooperative matrix, NV/AMD vendor extensions,
`VK_KHR_present_id`/`present_wait`/`present_timing` — all optional in
vkd3d's tables and unused by a clear+triangle. The bridge's benign-error
tail already covers them.

## Delta count

- Part A (device-creation gates): **5**
- Part B (new entry points): **31** (B1–B6: 15; B7: 16)
- **Total: 36 work items**, of which 8 are launch-critical
  (A1–A5, B1–B3).
