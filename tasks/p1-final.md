# P1 final — vkwebgpu ICD architecture, and the P2 boundary design

**Scope:** P1 evidence in `/tmp/p1work`. No commits, no repo changes. G1 was declared met by the
orchestrator (see `progress.md` §G1, and the P1 result block appended to
`tasks/vulkan-webgpu-spike.md`). This document (a) states what the P1 build actually is, and
(b) designs P2: the same ICD logic running **inside** the Boxedwine guest and reaching the browser's
WebGPU across the WASM boundary.

---

# PART 1 — the P1 architecture as built

## 1.1 Two processes, one filesystem

```
native vkcube (aarch64 ELF)
   │  Vulkan loader 1.3.275        VK_ICD_FILENAMES=icd/vkwebgpu_icd.json
   ▼
icd/libvkwebgpu_icd.so   ← icd/vkwebgpu_icd.c (1764 LOC, 105 vk* exports + 3 vk_icd*)
   │  writes, per submit-with-draw:
   │    icd/vkwgpu_stream/frameNNNN.json          ← the manifest
   │    icd/vkwgpu_stream/frameNNNN_ubo.bin       ← 1216 B uniform block bytes
   │    icd/vkwgpu_stream/frameNNNN_tex.bin       ← 256×256 RGBA8, 262144 B
   │    icd/vkwgpu_stream/shaders/<djb2>.vert.spv ← 1560 B  (deduped)
   │    icd/vkwgpu_stream/shaders/<djb2>.frag.spv ← 1280 B  (deduped)
   │    icd/vkwgpu_stream/present.log             ← present → frame linkage
   ▼
node host driver (host/p1render.mjs)  →  chromium 151 (WebGPU, SwiftShader adapter)  →  PNG
```

Nothing about this is a stub of the plumbing: the loader accepts the ICD, vkcube runs its **full**
guest path (instance → physical device → device → queue → surface → swapchain → command
recording → submit → present) and exits 0. What is stubbed is listed in §1.4.

## 1.2 ICD: what is real

| Area | Real behaviour in `vkwebgpu_icd.c` |
|---|---|
| ICD interface | `vk_icdNegotiateLoaderICDInterfaceVersion` → 5; `vk_icdGetInstanceProcAddr`; `vk_icdGetPhysicalDeviceProcAddr`. Loader never logs "Skipping this driver". |
| Physical device | 1 device, `VKWGPU WebGPU Virtual Device`, apiVersion 1.1.0, `VK_PHYSICAL_DEVICE_TYPE_OTHER`; real limits (`maxPushConstantsSize=256`, `maxTextureDimension2D=16384`, `maxBoundDescriptorSets=4`), features (no geometry/tessellation stages), memory types/heap, format properties, image-format properties, sparse-image properties. |
| Queue | 1 family, `GRAPHICS|COMPUTE|TRANSFER`, 1 queue; `vkGetDeviceQueue` fetches what `vkCreateDevice` created. |
| Surfaces | `VK_KHR_surface` + swapchain advertised; `vkCreateXcbSurfaceKHR`, `vkGetPhysicalDeviceSurface{Capabilities,Formats,PresentModes,Support}KHR` answered; `currentExtent = VK_CURRENT_EXTENT_UNDEFINED` so vkcube's `--width/--height` are honoured. |
| Object tables | Instance, device, queue, command pool/buffers, buffers, images, image views, samplers, device memory, render passes, framebuffers, pipelines (vertex-input state, viewport, rasterisation, multisample, depth-stencil, blend, layout all recorded from the create-info), descriptor set layouts/pools/sets, shader modules, pipeline cache, fences, semaphores, surface, swapchain. Each carries a magic word; submit-time use re-validates it. |
| Command recording | `vkCmdBeginRenderPass` (clear colour + clear depth captured), `vkCmdBindPipeline`, `vkCmdBindDescriptorSets`, `vkCmdSetViewport`, `vkCmdSetScissor`, `vkCmdDraw`, `vkCmdPipelineBarrier` (ordering marker), `vkCmdCopyBufferToImage`; `vkBeginCommandBuffer` / `vkEndCommandBuffer` / `vkResetCommandBuffer` manage the per-command-buffer command array (7 commands for vkcube's frame). |
| Execution at submit | `vkQueueSubmit` first runs `exec_copies()` — the recorded `copyBufferToImage` transfers are performed eagerly — then walks each submitted command buffer, recovers framebuffer/pipeline/viewport/scissor/clear/draw from the recorded stream, resolves the bound descriptor set to (UBO buffer, image view, sampler), and writes the manifest. |
| Memory + mapping | `vkAllocateMemory` is host `malloc`; `vkMapMemory` returns a **direct pointer into that malloc'd block**, so guest-side writes through the map are visible to the dumper with no copy. `vkGetBufferMemoryRequirements` / `vkGetImageMemoryRequirements` / `vkGetImageSubresourceLayout` report consistent numbers. |
| Sync | Immediate. The fence passed to submit is marked signalled; `vkResetFences` clears; `vkWaitForFences` returns success. |
| Diagnostics | `VKWGPU_TRACE=1` per-entry-point trace; `VKWGPU_STREAMDIR` relocates the stream (default `./vkwgpu_stream`). |

Two real bugs were found and fixed by this stage and are worth keeping in mind for P2:
* `sizeof(handle)` (a pointer's size, not the object's) overflowed a heap block in the earlier spike.
* vkcube calls `vkDestroyShaderModule` immediately after pipeline creation — which is legal — so the
  ICD retains the SPIR-V words and treats destroy as a refcount drop (bounded, deliberate leak).

## 1.3 The frame-manifest format

One manifest per `vkQueueSubmit` whose command buffer contains a render pass + a draw. A submit
whose command buffer has no draw is skipped with a trace line (`submit: frame without draw …
skipped`) — visible in a normal vkcube run, and harmless.

`icd/vkwgpu_stream/frameNNNN.json` (verbatim shape, from `vkQueueSubmit`'s writer):

```json
{
  "frame": 2, "width": 400, "height": 400,
  "colorFormat": "B8G8R8A8_UNORM",
  "clearColor": [0.2, 0.2, 0.2, 0.2], "clearDepth": 1.0,
  "viewport": [0, 0, 400, 400, 0, 1], "scissor": [0, 0, 400, 400],
  "cull": 2, "front": 0, "depthTest": 1, "depthWrite": 1, "depthOp": 3,
  "vs": "shaders/59496e6684bf0791.vert.spv",
  "fs": "shaders/88f8a5cebeefd8c1.frag.spv",
  "ubo":     { "file": "frame0002_ubo.bin", "size": 1216 },
  "texture": { "w": 256, "h": 256, "format": "R8G8B8A8_UNORM", "file": "frame0002_tex.bin" },
  "sampler": { "mag": 0, "min": 0, "mipmap": 0, "addrU": 2, "addrV": 2, "maxAniso": 1.0 },
  "draws": [ { "vertexCount": 36, "firstVertex": 0 } ]
}
```

Sidecar rules:
* **UBO `.bin`** — raw bytes of the descriptor-set-0 uniform buffer as bound (`mem->ptr + mem_off`,
  clamped to the allocation). vkcube's MVP block is 1216 B and byte-plausible (a sane model-view
  row). One per frame because vkcube re-uploads the UBO every frame.
* **Texture `.bin`** — raw texel bytes, `w*h*4`. Two sources, selected by the image's `copied` flag:
  * staging path (`vkCmdCopyBufferToImage` → `im->pixels`) — vkcube's case, 256×256 with 256
    distinct byte values;
  * linear path (`vkMapMemory` + row memcpy) — dumped from the bound memory.
* **SPIR-V `.spv`** — deduplicated by a djb2 hash of the module bytes into
  `shaders/<016llx>.{vert,frag}.spv`; the manifest only carries the name. `write-if-absent`
  semantics (`sidecar_bin`), so an unchanged module is dumped once for the whole run.
* **`present.log`** — one line per `vkQueuePresentKHR` recording which frame it presented, so a
  present can be tied back to its manifest without guessing from frame numbering.

## 1.4 ICD: what is stubbed (honest list)

* **Barriers** — recorded as ordering markers only. WebGPU pass encoding makes colour/depth
  transitions implicit, so this is a semantic win for the vkcube workload, but an app that
  interleaves compute→transfer→compute has no representation.
* **Fences / semaphores / waits** — immediate success. Everything is synchronously executed at submit.
* **MSAA, depth/stencil resolve, mipmaps, array layers** — recorded, not specially executed. vkcube
  uses 1 sample and no mips on its render target, so this is untested territory, not tested-and-fine.
* **`vkGetPastPresentationTimingGOOGLE`** — reports 0 timestamps.
* **Swapchain** — an offscreen framebuffer sized from `currentExtent`; acquire hands out a rotating
  image index. There is no windowing system behind it.
* **Everything outside the 85 entry points of `ref/vkcube_core.txt`** — a benign-error tail that
  logs and returns a failure code instead of faulting (this is what turned the original
  `Segmentation fault` into a clean exit 0).

## 1.5 Host side: manifest consumer, SPIR-V→WGSL, render + readback

`host/p1render.mjs` (174 LOC) is the consumer.

* **Driver**: node 22 + `playwright-core` launches `/usr/local/bin/chromium` with
  `headless:false` under Xvfb and the WebGPU flag set
  (`--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --use-vulkan=swiftshader
  --use-webgpu-adapter=swiftshader --disable-vulkan-surface`). The page is served from
  `http://127.0.0.1` because `navigator.gpu` only appears in a secure context — serving from
  `about:blank` silently yields `navigator.gpu === undefined`.
* **Manifest → GPU objects**: UBO bytes → `createBuffer(UNIFORM|COPY_DST)` + `queue.writeBuffer`;
  texture bytes → `createTexture(rgba8unorm, TEXTURE_BINDING|COPY_DST)` + `queue.writeTexture`;
  sampler state translated from the manifest's Vulkan enums (`mag/min/mipmap` 0→`nearest`,
  `addrU/addrV` 2/3→`clamp-to-edge`); bind group layout 0/1/2 = UBO / `texture_2d<f32>` /
  `sampler` (the Vulkan combined image sampler at binding 1 is split, as WebGPU requires).
* **SPIR-V → WGSL**: `naga-wasm` (`init` → `parseSpirv` → `validate` → `writeWgsl`) on the
  **vertex** module. Verified offline: 390 SPIR-V words in, 1286 chars of WGSL out, with correct
  reflection — `@group(0) @binding(0) var<uniform> ubuf: buf;`, `@location(0/1)` on the outputs.
  So descriptor-set derivation is **not** the blocker the spike feared.
  The **fragment** module is *not* translated: `parseSpirv` on `cube.frag` fails with
  `NagaError: InvalidId(40)`, so the host substitutes a hand-written WGSL fragment stage whose
  semantics match `cube.frag` (normal from `cross(dpdx, dpdy)`, one directional light, texture
  sample, manual linear→sRGB encode). This is the one open shader item, see §2.5.
* **Render**: `bgra8unorm` colour target + `depth24plus`, clear from the manifest, pipeline with
  `cullMode`/`frontFace`/`depthWriteEnabled`/`depthCompare` from the manifest, `setViewport` +
  `setScissorRect` from the manifest, `draw(36, 1, 0, 0)`.
* **Readback**: `copyTextureToBuffer` with a 256-byte-aligned `bytesPerRow`, `mapAsync(READ)`,
  strip row padding, BGRA→RGBA, hand-rolled PNG encode (IHDR/IDAT/IEND + CRC32). Returning pixels
  as base64 across the node→browser hop is what makes the harness robust.
* **Comparison harness**: `host/p1sweep.mjs` sweeps cube rotation angles and matches against a
  120-frame lavapipe (`lvp_icd`) reference captured on this same box (`ref/clean/f000..f119.png`),
  reporting best mean-abs-diff. Best result **18.3/255**. `host/p1sil.mjs` computes silhouette IoU
  and was the last forensic lane (parked; the orchestrator's G1 verdict superseded it).
* **Original spike** (still present): `host/gpu.mjs` + `host/result.json` + `host/triangle.png` —
  the analytic check that WebGPU render+readback on this box is numerically correct
  (24.72 % lit coverage vs the analytic 24.5 %, centre pixel `(128,127,230)` vs `(128,121,230)`).

## 1.6 Proof frame

`/tmp/p1work/final-cube.png` — regenerated in this session, not copied: `vkcube --c 4 --width 400
--height 400` through the ICD (`VKWGPU_TRACE=1`, exit 0, 4 manifests) → `host/p1render.mjs
icd/vkwgpu_stream frame0002 final-cube.png`. 400×400 RGBA8 PNG, 300 distinct colours,
43165/160000 = 26.98 % lit pixels (the rotated cube's screen coverage), zero shader-compilation
messages and zero uncaught WebGPU errors.

## 1.7 Known cosmetic deltas (deferred by the G1 verdict, listed so nobody re-litigates them)

1. **Renderer family mismatch.** The reference is lavapipe/llvmpipe (a CPU Vulkan rasteriser);
   the render is Chromium's SwiftShader Vulkan behind ANGLE. Rasterisation-rule, sub-pixel and
   interpolation differences alone account for a double-digit mean-abs-diff. Not an ICD defect.
2. **Winding/`frontFace` was probed, not assumed.** `front: 0` in the manifest means CCW; the
   consumer accepts a `ccw|cw` override, and the good renders are explicitly CCW. Face orientation
   of the cube geometry under a Y-flip between Vulkan NDC and WebGPU NDC was the single largest
   per-pixel delta and is now handled explicitly.
3. **Fragment stage is hand-written, not translated** (§1.5) — it matches semantics, not
   instruction-for-instruction output.
4. **sRGB is done in the shader** (manual `linearToSrgb`) because the manifest's render target is
   `_UNORM`, not `_SRGB`.
5. **No MSAA, no mips, no resolve** on either side of the comparison.
6. **Not claimed:** pixel-identity with lavapipe, GPU timings, or multi-frame pacing. None were
   measured in P1.

---

# PART 2 — P2 design: the ICD inside the guest, across the WASM boundary

## 2.0 The pattern being mirrored (and why it is the right one)

Boxedwine already runs a guest→host GPU trap today, for GL, in production form:

| Piece | Location | Role |
|---|---|---|
| guest ELF shim | `tools/rootfs64/libgl64/libgl64.c` (1393 LOC) + `libgl64_stubs.h` | freestanding x86-64 `.so`; exports `libGL.so.1`; every wrapper packs args and traps |
| shared ABI | `source/opengl/gl64bridge_abi.h` (463 LOC) | syscall number, `GL64Args`, the append-only fn-id enum, marshalling rules in comments |
| kernel dispatch | `source/kernel/syscall64.cpp:2915-2921` | `case GL64_SYSCALL_NR: ret = gl64Bridge(cpu, a1, a2);` |
| host bridge | `source/opengl/gl64bridge.cpp:1192` `U64 gl64Bridge(CPU64* cpu, U64 fnId, U64 argsAddr)` | reads args with `memcpyFromGuest`, one `switch (fnId)`, writes out-params with `memcpyToGuest`/`writed` |
| GPU-side marshalling | `gl64bridge.cpp:143-168` `glOnMain` / `#define GL_MT(stmt)` → `xwireRunOnMainThread` | the trap runs on a guest worker; every GPU call hops to the main thread that owns the context |
| wasm→JS handoff | `source/opengl/gl64webgpu.h` + `web/runtime.html:11` + `web/webgpu.mjs` + `web/app.mjs:122` | one JSON frame per swap, `MAIN_THREAD_EM_ASM` → `window.bwGpuFrame(json)` → page WebGPU renderer |

The trap itself, guest side (`libgl64.c:377-387`):

```c
static inline uint64_t gl64_trap(uint64_t fnId, GL64Args* args) {
    uint64_t ret;
    register uint64_t rdi __asm__("rdi") = fnId;
    register uint64_t rsi __asm__("rsi") = (uint64_t)(uintptr_t)args;
    __asm__ __volatile__("syscall" : "=a"(ret)
        : "a"(GL64_SYSCALL_NR), "r"(rdi), "r"(rsi) : "rcx","r11","memory");
    return ret;
}
```

Four properties make this pattern the right template, and each one has a Vulkan analogue:

1. **No loader, no real driver in the guest.** The guest shim *is* the API surface; the host owns all
   state. So P2 does **not** need the Vulkan loader, an ICD `.so`, `VK_ICD_FILENAMES`, an ICD JSON
   manifest, `VK_LOADER_DATA` member-0 rules, or the 12 `LOOKUP_REQUIRED_GIPA` entry points. That
   whole layer is the single biggest simplification of moving in-guest.
2. **Handles are opaque ids, never host pointers.** `gl64bridge.cpp:178` hands out `++g_nextOpaqueId`.
   The repo's 32-bit Vulkan bridge already does the same thing for Vulkan handles
   (`source/vulkan/vulkancommon.cpp:46` `createVulkanPtr`, plus a guest-mapped table).
3. **Guest pointers are guest VAs; the host copies.** `memcpyFromGuest` for in, `memcpyToGuest` for
   out — with the documented exception that *buffer-relative* pointers are plain integer offsets
   (`gl64bridge_abi.h:139-144`), never dereferenced on the host.
4. **One hop per frame, not per call.** `gl64webgpu.h:19` states it outright; the reason is
   recorded-host-side batching (`RECORD_IMM`/`ImmOp`, `gl64bridge.cpp:219-259`), which only works
   because the trap is cheap and the expensive part happens once.

## 2.1 The three tiers

```
┌─ TIER 0 ─ guest, ELF x86-64, interpreted by CPU64 ────────────────────────────┐
│ tools/rootfs64/libvk64/libvk64.c   → installed as the guest's              │
│                                       libvulkan.so.1 (soname precedent:    │
│                                       tools/vulkan/buildvk.sh)             │
│   • exports the 85 vkXxx of ref/vkcube_core.txt + vkGetInstanceProcAddr +  │
│     vkGetDeviceProcAddr (+ the 3 vk_icd* names aliased for loader-shaped    │
│     callers)                                                              │
│   • ZERO logic. Pack Vk64Args, trap, return RAX.                            │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ syscall: RAX=VK64_SYSCALL_NR
                                │         RDI=fnId, RSI=guest VA of Vk64Args → RAX
┌─ TIER 1 ─ WASM host (the ICD proper) ───────────────────────────────────────┐
│ source/vulkan/vk64bridge.cpp    ← the 1764-LOC ICD body, file-writers out   │
│ source/vulkan/vk64bridge_abi.h  ← syscall nr, Vk64Args, fn-id enum         │
│ source/kernel/syscall64.cpp:2915  ← case VK64_SYSCALL_NR: vk64Bridge(...)  │
│   • real object tables, real command recording, real eager copy execution   │
│   • handles = opaque ids; guest memory via KMemory64                        │
│   • NO WebGPU objects touched here                                        │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ MAIN_THREAD_EM_ASM  (one hop per frame)
                                │ EM_ASM              (one-off queries)
┌─ TIER 2 ─ browser page main thread ─────────────────────────────────────────┐
│ web/runtime.html   window.bwVkFrame(json)  → parent postMessage            │
│ web/vkwebgpu.mjs   renderer: adapter/device/pipelines/queue, canvas present│
│ web/shader.mjs     toWGSL('spirv', bytes, stage) via web/vendor/naga       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 2.2 The ABI: `vk64bridge_abi.h`

Direct mirror of `gl64bridge_abi.h`; the whole delta is the syscall number, the argument-block name,
and the fn-id enum:

```c
#define VK64_SYSCALL_NR ((uint64_t)0x564B0000ULL)   /* 'VK'; GL64 owns 0x474C0000 */
#define VK64_MAX_ARGS   16                          /* same as GL64: see below */
typedef struct VK64Args { uint64_t a[VK64_MAX_ARGS]; } VK64Args;
```

`VK64_MAX_ARGS` stays at 16. The widest call among the 85 is `vkCmdPipelineBarrier` at 10
arguments, then `vkCmdBindDescriptorSets` at 7 and `vkCreateGraphicsPipelines` at 6, so the GL
abi's 16 slots carry over unchanged; Vulkan has nothing wider than `glUniformMatrix4fv`. Where the
two ABIs *do* differ is that there is no 32-bit packing to exploit anywhere: every Vulkan handle,
`VkDeviceSize`, and guest address occupies a full `u64` slot, so the same 16 slots carry less
information than in GL.

The other half of the ABI is the **struct list**, because Vulkan passes nearly everything by
pointer. `VkXxxCreateInfo`, `VkRenderPassBeginInfo`, `VkPipelineViewportStateCreateInfo`,
`VkPhysicalDeviceProperties` (800 B), `VkExtensionProperties` (260 B) and so on are *not*
flattened into slots — Tier 1 `memcpyFromGuest`s the struct out of guest memory once per call and
dereferences it there. Which structs must be read whole (and their sizes) is listed explicitly in
the ABI header, the way `gl64bridge_abi.h` annotates every fn id with its arity and argument
conventions.

Slot conventions (copied verbatim from the GL ABI, they are already right for Vulkan):
* integer/enum/handle/bool → zero- or sign-extended into the `u64` slot;
* pointer args → **guest virtual address** as `u64`;
* float args → bit-cast to `u32` in the low half (relevant only for future `vkCmdSetViewport`-style
  float variants — the current 85 use no float scalars);
* `VkDeviceSize` → plain `u64`, no cast;
* out-params are guest VAs the host writes via `memcpyToGuest` / `writed` / `writeq`.

## 2.3 Which entry points cross the boundary

**All 85 of `ref/vkcube_core.txt` cross**, grouped by how they marshal. The list is spelled out in
full so it can be diffed against `ref/vkcube_core.txt` mechanically.

**A. Shim plumbing — resolved guest-side, never traps (2 + 3 aliases, outside the 85):**
`vkGetInstanceProcAddr`, `vkGetDeviceProcAddr` — implemented in `libvk64.c` with a static
`{name, fnId}` table (exactly `g_procs[]` at `libgl64.c:1250`) and the GL shim's fallback rule:
return our wrapper for names we implement, `gl64_noop`-equivalent for the rest so an unimplemented
call is ignored instead of crashing. Names arrive as guest pointers → the shim `strcmp`s them
(`gl_strcmp`, its own freestanding copy). `vkGetInstanceProcAddr(NULL, "vkEnumerateInstanceVersion")`
must work with a NULL instance (loader-spec rule) — trivially true here. The three ICD-interface
names (`vk_icdGetInstanceProcAddr`, `vk_icdGetPhysicalDeviceProcAddr`,
`vk_icdNegotiateLoaderICDInterfaceVersion`) are exported as aliases in case a guest app probes for
them, but nothing in the guest ever calls them: with no loader in the guest, the loader contract is
vacuous.

**B. Queries and state answers — 25 (host answers from its own tables):**
`vkEnumerateInstanceExtensionProperties`, `vkEnumerateInstanceLayerProperties`,
`vkEnumeratePhysicalDevices`, `vkEnumerateDeviceExtensionProperties`,
`vkGetPhysicalDeviceProperties`, `vkGetPhysicalDeviceFeatures`,
`vkGetPhysicalDeviceMemoryProperties`, `vkGetPhysicalDeviceQueueFamilyProperties`,
`vkGetPhysicalDeviceFormatProperties`, `vkGetPhysicalDeviceSurfaceCapabilitiesKHR`,
`vkGetPhysicalDeviceSurfaceFormatsKHR`, `vkGetPhysicalDeviceSurfacePresentModesKHR`,
`vkGetPhysicalDeviceSurfaceSupportKHR`, `vkGetDeviceQueue`, `vkGetBufferMemoryRequirements`,
`vkGetImageMemoryRequirements`, `vkGetImageSubresourceLayout`, `vkGetSwapchainImagesKHR`,
`vkAcquireNextImageKHR`, `vkGetPastPresentationTimingGOOGLE`, `vkResetFences`,
`vkWaitForFences`, `vkDeviceWaitIdle`, `vkResetCommandBuffer`, `vkFreeCommandBuffers`.

**C1. Creates — 19 (create-info read out of guest memory with `memcpyFromGuest`):**
`vkCreateInstance`, `vkCreateDevice`, `vkCreateXcbSurfaceKHR`, `vkCreateSwapchainKHR`,
`vkCreateCommandPool`, `vkCreateBuffer`, `vkCreateImage`, `vkCreateImageView`, `vkCreateSampler`,
`vkCreateRenderPass`, `vkCreateFramebuffer`, `vkCreateGraphicsPipelines`, `vkCreatePipelineLayout`,
`vkCreateDescriptorSetLayout`, `vkCreateDescriptorPool`, `vkCreateShaderModule`,
`vkCreatePipelineCache`, `vkCreateFence`, `vkCreateSemaphore`.

**C2. Allocation, binding, update, map — 8:**
`vkAllocateMemory`, `vkAllocateCommandBuffers`, `vkAllocateDescriptorSets`,
`vkBindBufferMemory`, `vkBindImageMemory`, `vkUpdateDescriptorSets`, `vkMapMemory`, `vkUnmapMemory`.

**C3. Destroys — 20:**
`vkDestroyInstance`, `vkDestroyDevice`, `vkDestroySurfaceKHR`, `vkDestroySwapchainKHR`,
`vkDestroyCommandPool`, `vkDestroyBuffer`, `vkDestroyImage`, `vkDestroyImageView`,
`vkDestroySampler`, `vkDestroyRenderPass`, `vkDestroyFramebuffer`, `vkDestroyPipeline`,
`vkDestroyPipelineLayout`, `vkDestroyDescriptorSetLayout`, `vkDestroyDescriptorPool`,
`vkDestroyShaderModule`, `vkDestroyPipelineCache`, `vkDestroyFence`, `vkDestroySemaphore`,
`vkFreeMemory`.

**D. Command recording — 11 (into the host-side command array, semantics unchanged from P1):**
`vkBeginCommandBuffer`, `vkEndCommandBuffer`, `vkCmdBeginRenderPass`, `vkCmdBindPipeline`,
`vkCmdBindDescriptorSets`, `vkCmdSetViewport`, `vkCmdSetScissor`, `vkCmdDraw`,
`vkCmdPipelineBarrier`, `vkCmdCopyBufferToImage`, `vkCmdEndRenderPass`.

**E. Frame boundary — 2:**
`vkQueueSubmit` (execute recorded copies, walk the command buffer, build the frame JSON, hop),
`vkQueuePresentKHR` (present through the page's canvas context; record the present→frame link).

**25 + 19 + 8 + 20 + 11 + 2 = 85.** Anything else the guest asks for (e.g.
`vkGetPhysicalDevicePresentRectanglesKHR`, which P1 already answered with a benign error) lands in the
switch default: log, return a failure code, fault nothing. That default is what turned P1's original
`Segmentation fault` into a clean exit 0, and it is what keeps an un-ported entry point harmless in
P2 as well.

## 2.4 `VkImage` / `VkBuffer` memory against WASM guest memory

This is the part where the in-guest design genuinely differs from P1, and it is a **hard
constraint**, not a preference: **`KMemory64` is a soft MMU.** `MMU mmu[K_NUMBER_OF_PAGES]` with a
per-4 KiB `K64Page` backing store (`include/kmemory64.h:164-190`), and the only bulk transfers are
`memcpyFromGuest` / `memcpyToGuest` / `memsetGuest`. `getRamPtr()` — the one API that hands out a
stable host pointer — **returns `nullptr` whenever the range crosses a page boundary**
(`source/kernel/kmemory64.cpp:729-734`). So there is no flat, contiguous guest region to point
WebGPU at.

Consequences, and the design that follows:

* **`vkAllocateMemory` must return guest memory, not a host `malloc`.** P1's `malloc` +
  `mapMemory returns host pointer` trick is not expressible in-guest: the guest's stores go through
  the CPU64 store path into `K64Page` buffers and *cannot* write to a wasm-heap address. So Tier 1
  allocates through the kernel's own mapper — `KMemory64::mmapReserveAndMap(len, K_PROT_READ|WRITE)` —
  and remembers the guest range for the object. P2's `vkMapMemory` therefore returns **that guest
  VA**, and everything downstream reads it through `memcpyFromGuest`.
* **Per-use copies, sized by the workload.** At draw/descriptor time the ICD copies the bytes it
  needs out of guest pages into a wasm-heap staging vector, and ships them to Tier 2. For vkcube
  that is 1216 B (UBO) per frame — negligible; the 256 KiB texture is uploaded once. A
  uniform-heavy DXVK workload pays one `memcpyFromGuest` per descriptor update; that is the honest
  cost of the current MMU, and it is the reason a future phase might want a large-contiguous
  fast path rather than this being quietly assumed away.
* **Readback goes the other way.** `copyTextureToBuffer` + `mapAsync` in Tier 2 → bytes back into
  the wasm heap → `memcpyToGuest` into the guest's destination range (e.g. a
  `vkCmdCopyImageToBuffer` staging buffer, `vkGetImageSubresourceLayout` consumers).
* **`vkGetImageSubresourceLayout` must report the guest address**, `rowPitch` included, because the
  guest then addresses the mapped range directly and its stores land in the page buffers — the copy
  happens later, once, at the point the GPU actually needs the pixels.

## 2.5 SPIR-V blobs, and where SPIR-V→WGSL runs

* **Guest → host**: `vkCreateShaderModule(pCreateInfo)` where `pCreateInfo->pCode` is a guest VA
  and `codeSize` a byte count. Tier 1 does one `memcpyFromGuest` into a wasm-heap `std::vector`,
  dedupes by the same djb2 hash P1 used for the `.spv` filenames, and keeps the words. Destroy
  retains the bytes (the vkcube ordering problem from §1.2).
* **Where the translation runs: in the page, on the JS side, via the naga build the repo already
  ships.** `web/shader.mjs:30` already implements `toWGSL('spirv', Uint8Array, stage)` —
  `translate({from:'spirv', to:'wgsl', source})` over `web/vendor/naga` — the *same* naga instance
  the C1 GLSL observation lane uses. P1 proved the equivalent path offline with `naga-wasm` 30.2:
  the vertex module translates cleanly with correct `@group(0) @binding(0)` reflection. So the
  translation is a single `EM_ASM` hop per new module, result cached forever by hash; it is pure
  compute, so it is safe to call on the guest worker thread (no main-thread hop needed, unlike
  WebGPU object work). Nothing new is required to make this work in-page.
* **Known gap, stated plainly:** `parseSpirv` on vkcube's `cube.frag` (1280 B, SPIR-V 1.0,
  `bound=48`, produced by glslang) fails with `NagaError: InvalidId(40)`. P1 masked this with a
  hand-written fragment stage. P2 cannot: DXVK is frag+vs pairs throughout, so this front-end path
  must be resolved (or replaced by a second translator for that module class) before any real
  guest content renders. This is the single highest-value P2 investigation item.

## 2.6 Frame dispatch to WebGPU

Mirror `gl64webgpu.h` exactly, because it is the proven shape in this codebase:

* Tier 1 accumulates the frame while walking a submitted command buffer — pipeline, bind group
  contents, viewport, scissor, clear values, raster/depth state, draw list — into a
  `std::ostringstream`, with the same cap-and-overflow-flag discipline the GL lane uses
  (`bwGpuCommandCount >= 100000` → `"overflow": true` in the frame JSON, which the consumer
  rejects rather than rendering garbage).
* At the frame boundary (`vkQueuePresentKHR`, or the last submit of a frame) Tier 1 emits **one**
  `MAIN_THREAD_EM_ASM` whose JS body calls `window.bwVkFrame(UTF8ToString(ptr))`.
* `web/runtime.html` grows one line next to the existing `window.bwGpuFrame` (`:11`):
  `window.bwVkFrame = json => send('vk', JSON.parse(json));`
* `web/app.mjs` grows a `'vk'` message branch next to the `'gpu'` one (`:122`), creating
  `web/vkwebgpu.mjs`'s renderer lazily and **falling back to the existing WebGL path on any error**,
  which is the same graceful-degradation contract the GL lane honours today.
* `web/vkwebgpu.mjs` is `web/webgpu.mjs`'s `createRenderer` shape (adapter → device → persistent
  offscreen colour+depth, per-key pipeline cache, `queue.onSubmittedWorkDone()` for buffer
  release) generalised from the fixed-function subset to the Vulkan frame schema.

**The wire format is P1's manifest, unchanged.** That is deliberate: P1's
`vkQueueSubmit` writer already emits exactly the schema a Vulkan-aware WebGPU renderer needs
(`host/p1render.mjs` is that renderer, minus the fs stub and the file reads). P2 deletes the file
I/O and keeps the JSON, so the P1 host code becomes the P2 renderer by construction rather than by
rewriting — and the pixel comparison work stays valid as a reference implementation.

## 2.7 Main-thread marshalling (`GL_MT` analogue)

The `wasm64-mt` build is `-pthread -sPTHREAD_POOL_SIZE=32 -sPROXY_TO_PTHREAD=1`, so a guest thread
that traps may be running on a Web Worker while WebGPU objects live on the page's main thread.
The GL bridge's answer (`gl64bridge.cpp:134-160`) is to wrap every GPU call in
`glOnMain(...)` / `GL_MT(...)` → `xwireRunOnMainThread`, and its optimisation is to record
state-only calls host-side and replay them in one hop. P2 does the same with a `VK_MT(stmt)`
macro and a per-frame single hop: **all 85 trapped entry points run inline on the calling
guest thread (no hop at all), and only the per-frame handoff hops.** For Vulkan this is even more
natural than for GL, because Vulkan already separates recording from submission — the command
buffer *is* the batching boundary that `glBegin..glEnd` batching had to synthesise.

## 2.8 What changes versus the P1 architecture

| | P1 (as built) | P2 (in-guest) |
|---|---|---|
| Guest side | native aarch64 `vkcube` + real Vulkan loader + real ICD `.so` | guest ELF `libvk64` shim installed as guest `libvulkan.so.1`; **no loader, no `.so`, no ICD JSON, no `VK_ICD_FILENAMES`** |
| Loader contract | 12 `LOOKUP_REQUIRED_GIPA` + `negotiate=5` + `VK_LOADER_DATA` member 0 | vacuous — the shim *is* the API; handles are opaque ids |
| Symbols | 105 `vk*` + 3 `vk_icd*` exports in a shared object | 85 `vkXxx` + the 2 `vkGet*ProcAddr` + 3 `vk_icd*` aliases, from a freestanding guest `.so` |
| IPC | files in `VKWGPU_STREAMDIR`, read by a **separate node+chromium process** | the WASM↔JS boundary: one `MAIN_THREAD_EM_ASM` per frame, `EM_ASM` for one-off queries |
| Host renderer | `host/p1render.mjs` driving chromium via playwright, under Xvfb | `web/vkwebgpu.mjs` in the page itself, reusing `web/webgpu.mjs`'s renderer lifecycle |
| Memory | host `malloc`; `vkMapMemory` → direct host pointer | `KMemory64::mmapReserveAndMap`; `vkMapMemory` → **guest VA**; per-use `memcpyFromGuest`/`memcpyToGuest` |
| SPIR-V→WGSL | offline, in node, `naga-wasm` 30.2, per render invocation | in-page, `web/vendor/naga` via `web/shader.mjs`, once per module, cached by hash |
| Presentation | offscreen framebuffer + PNG dump + external comparison | canvas context `getCurrentTexture()` (or the transferred `#gl64canvas` OffscreenCanvas), presented in-page |
| Sync | immediate (everything synchronous at submit) | still immediate for the guest's purposes; `vkWaitForFences` answers from a frame-done counter pushed back from the page — the same `ALREADY_SIGNALED` trick `gl64bridge_abi.h:244-253` uses to unblock wined3d's Present |
| Dead code removed | — | `stream_dir`/`stream_open`/`sidecar_bin`/`dump_shader`/manifest `fprintf` (~120 LOC of `vkwebgpu_icd.c`) replaced by an in-memory frame serializer |

**Net effect on the ICD body: the object tables, the recording walk, the eager copy execution and
the submit-time frame reconstruction are unchanged and move essentially verbatim.** Only the sink
changes — a file tree becomes a single hop into JS — and the handle/memory substrate changes from
host pointers to guest addresses.

## 2.9 Concrete change map

| Path | Action |
|---|---|
| `tools/rootfs64/libvk64/libvk64.c` (new) | guest shim; `vk64_trap`, `VK64Args`, the 85 wrappers, `vkGet{,Device}InstanceProcAddr` table. Port the wrapper-generation shape from `tools/vulkan/vk.c` (176 KB, generated, 32-bit `int $0x9a`) but freestanding, as `libgl64.c` is. |
| `tools/rootfs64/libvk64/buildvk64.sh` (new) | copy `tools/vulkan/buildvk.sh`'s shape; emit `-Wl,-soname,libvulkan.so.1` so it satisfies the existing search path. |
| `source/vulkan/vk64bridge_abi.h` (new) | mirror `gl64bridge_abi.h`: syscall number, `VK64Args`, append-only fn-id enum, per-id marshalling notes. |
| `source/vulkan/vk64bridge.cpp` (new) | `U64 vk64Bridge(CPU64*, U64 fnId, U64 argsAddr)`; recursive mutex; `memcpyFromGuest` of the args; one `switch (fnId)` over the 85; the P1 object tables and frame serializer. |
| `source/kernel/syscall64.cpp:2915` | add `case VK64_SYSCALL_NR: ret = vk64Bridge(cpu, a1, a2); break;` beside the GL case, under a new `-DBOXEDWINE_VULKAN64`. |
| `project/emscripten/makefile:81` | add `-DBOXEDWINE_VULKAN64` to `wasm64-mt`'s `EXTRA_CPP_FLAGS`. No new LD flags needed (no C-level WebGPU binding is used). |
| `web/vkwebgpu.mjs` (new) | renderer; model on `web/webgpu.mjs:80` `createRenderer`. |
| `web/runtime.html:11` | add `window.bwVkFrame`. |
| `web/app.mjs:122` | add the `'vk'` message branch with fallback. |
| `icd/vkwebgpu_icd.c` | stays in `/tmp/p1work` as the P1 reference and the donor of the object tables. |

## 2.10 Load-bearing unknowns (the real P2 risk list)

1. **Where the guest actually looks for the shim.** The guest already searches its unix-library
   path for `libvulkan.so.1` and finds nothing — `test-results/baldi-o2-envdump-console.log:4378-4387`
   shows ten `sys_openat64` attempts, all `ENOENT`, immediately after `wined3d.dll` is mapped:
   `/lib/x86_64-linux-gnu/`, `/usr/lib/x86_64-linux-gnu/`, `/lib/tls/x86_64/lib/`, `/lib/tls/lib/`,
   `/lib/x86_64/lib/`, `/lib/`, `/usr/lib/tls/x86_64/lib/`, `/usr/lib/tls/lib/`, `/usr/lib/x86_64/lib/`,
   `/usr/lib/`. Two things must be confirmed against the guest before anything else: that this
   search is the one that will pick up our shim, and that the `libvulkan.so.1` soname
   (`tools/vulkan/buildvk.sh:3` already emits exactly that) is what it wants. DXVK's own
   `vulkan-1.dll` import resolution has to land on the same place.
2. **The fragment-module translation gap** (§2.5): naga 30.2's SPIR-V front end rejects vkcube's
   `cube.frag` with `InvalidId(40)`. Unblocking that is a prerequisite for DXVK, not a nice-to-have.
3. **Trap volume.** vkcube records ~7 commands and ~40 setup calls per frame, which is nothing.
   DXVK's per-draw volume is the unknown; the mitigation is already designed in — record on the
   calling thread, one hop per frame (§2.7) — but it needs measuring, not assuming.
4. **Copies per use.** With no flat guest region, every descriptor-sourced read is a
   `memcpyFromGuest` (§2.4). Whether that is acceptable for uniform-heavy content is a measurement.
5. **Resize / swapchain recreation** must be driven from the page side and mirrored host-side
   (the analogue of `resizeTarget()`, `gl64bridge.cpp:576`) — a manifest with `currentExtent =
   UNDEFINED` is fine as an ICD, but a live canvas needs the recreate path.
6. **Multi-queue and secondary-queue semantics** collapse to one implicit `GPUQueue`; if DXVK
   creates per-family queues and waits across them, the immediate-sync model has to keep
   answering without lying in a way that deadlocks.

## 2.11 P2 implementation status (2026-10-05 — boundary GREEN)

Everything in the §2.9 change map's host/guest tiers is implemented and verified
in-guest; only the page tier (`web/vkwebgpu.mjs`, `window.bwVkFrame`, the `'vk'`
message branch) remains unwired, which is a different lane:

- ✅ `source/vulkan/vk64bridge_abi.h` — `VK64_SYSCALL_NR 0x564B0000`, `VK64Args`,
  append-only fn-id enum: 85 ids in the §2.3 groups + 9 extras at 700+
  (`vkEnumerateInstanceVersion`, the `*2` physdev queries, `vkGetFenceStatus`,
  `vkResetCommandPool`, `vkQueueWaitIdle`, `vkCreateHeadlessSurfaceEXT`).
- ✅ `source/vulkan/vk64bridge.cpp` — `vk64Bridge()` with the P1 object tables,
  command recording, eager copy execution, and the submit-time frame serializer;
  guest memory via `KMemory64` (`mmapReserveAndMap` for `vkAllocateMemory`,
  `vkMapMemory` returns a guest VA); one `MAIN_THREAD_EM_ASM` hop per frame at
  present; benign-error default. Plus `source/vulkan/vk64_guest.h` (generated by
  `tools/vulkan/gen/gen_vk64_guest.py` from the in-tree Khronos headers with all
  pointer/handle members widened to 64 bits — required because the host builds
  wasm32; layout verified identical to the x86-64 ABI).
- ✅ `source/kernel/syscall64.cpp` — `case VK64_SYSCALL_NR` beside the GL case;
  `project/emscripten/makefile` — `-DBOXEDWINE_VULKAN64` on `wasm64-mt`.
- ✅ `tools/rootfs64/libvk64/libvk64.c` — freestanding guest shim, SONAME
  `libvulkan.so.1`, 249 exports (85 + GIPA/GDPA + 3 `vk_icd*` aliases + benign
  tail), load-time witness constructor; staged into both rootfs zips at both
  `/lib` and `/usr/lib` search paths via `tools/rootfs64/buildvk.sh --stage`.
- ✅ Gate (`web/tests/scratch-vk.mjs` → `test-results/vk-summary.json`):
  fixture `usr/bin/vkfixture` exits 0 with **105 traps / 76 distinct** crossing
  the boundary — full chain instance → device → queue → headless surface →
  swapchain → depth/UBO/staging/texture → vkcube's own SPIR-V → pipeline →
  record(copy/barrier/renderpass/draw 36) → submit (**FRAME 0 built, 64×64**)
  → present (FRAME-JSON hopped) → complete teardown. No page errors.
- ✅ Unknown #1 ANSWERED: the guest finds `libvulkan.so.1` through the normal
  dynamic-linker search and the witness fires (`vk64: FIRST trap`) on mapping.
  Remaining unknowns #2–#6 stand as written.

Two bugs found by the gate itself: the harness waited for the app page's
`window.wineLibrary` on the bare runtime page (every run timed out at that line
while the guest booted fine — the whole `witness=false` story), and the
fixture's `R()` macro stringified the `p`-prefixed variable instead of the `vk*`
entry name. The `memory access out of bounds` worker crash seen in one run is
pre-existing boot/shutdown noise — the identical signature occurs in
`test-results/baldi-a2c-headgl-console.log` (Oct 4, pre-vk64 build).

---

## 2.12 SPIR-V route decision (2026-10-05 — P2-NOW item 7)

**Decision: stay on naga, and — only if the dxc corpus needs it — carry a
maintained naga spv-in patch in-tree. NOT an upstream upgrade (there is nothing
to upgrade to), NOT spirv-webgpu-transform, NOT a new translator.**

### The audit's §(e) diagnosis was wrong on both counts, and the correction changes the answer

§2.10 unknown #2 and the adversarial audit attributed `InvalidId(40)` to
fragment derivatives (`OpDPdx`/`OpDPdy`) plus `OpImageSampleExplicitLod`.
Re-checked offline against the CURRENT UPSTREAM naga source:

| audit claim | check | result |
|---|---|---|
| `OpImageSampleExplicitLod` (opcode 87) | SPIR-V opcode 87 is `OpImageSampleImplicitLod`; ExplicitLod is 88 | wrong opcode (off by one) |
| derivatives block the import | `naga-30.0.1/src/front/spv/next_block.rs:2341` implements `Op::DPdx` (`DPdxFine`/`DPdxCoarse` beside it) | derivatives are **supported** |
| an upstream fix might exist | `cargo add naga` → `Adding naga v30.0.1 (available: v30.0.1)` — 30.0.1 **is** the newest published naga, and it is the version the vendored wasm carries. The repo's "newer" npm dep `naga-wasm@30.2.0` reports `nagaVersion = "30.0.1"` and fails identically | no upstream fix to wait for |

What actually fails is the **provenance of the combined image sampler**:

```
frag: OpTypeImage x1  OpTypeSampledImage x1  OpSampledImage x0
      OpImageSampleImplicitLod x1  OpLoad x8  OpDPdx x1  OpDPdy x1
vert: OpTypeImage x0  OpTypeSampledImage x0  OpSampledImage x0   -> translates clean
```

The fragment samples through `OpLoad %37 %40 %39`, i.e. it loads an
`OpTypeSampledImage` and hands the loaded id straight to the sample instruction.
naga's `lookup_sampled_image` has exactly **one** writer —
`parse_image_couple` (`front/spv/image.rs:243`), reached only from
`Op::SampledImage` (`front/spv/next_block.rs:1325`) — so both the LOD branch
(`image.rs:539`) and the main path (`image.rs:628`) look id 40 up in a table it
was never inserted into, and `LookupHelper::lookup` (`front/spv/mod.rs:169`)
returns `Error::InvalidId(40)`.

Two offline bisects confirm the sampled image is the whole story, not a
co-factor:

| experiment | result |
|---|---|
| build naga 30.0.1 from source, translate P1's pair | `invalid id %40` — the bug is in upstream, not in the vendored wasm build |
| delete the `OpLoad %37 %40 %39`, retarget its uses to the global `%39` | still fails, now `invalid id %39` |
| rewrite opcode 87 → 86 (implicit ⇒ implicit) | still fails, now `invalid id %46` (the implicit-LOD load) |

The vertex shader translates because it contains no image at all. So the trigger
is **"this module samples a texture"**, not "this module uses derivatives" — a
narrow, single-lookup provenance gap, and the reachable question for DXVK is
whether dxc ever emits `OpSampledImage` (in which case dxc shaders may sail
through this path) or the loaded-`OpTypeSampledImage` form.

### Why each route wins or loses

- **Upstream naga fix — dead.** 30.0.1 is the newest release and still fails.
  "Check upstream first" was the cheapest option and it is now closed, with
  evidence rather than a guess.
- **spirv-webgpu-transform — not a translator.** `SPIRVWebGPUTransforms` is an
  **MLIR/LLVM dialect pass** (`lib/Dialect/SPIRV/Transforms/`): it downlevels
  SPIR-V capability constructs (1.3+ → the WebGPU-safe subset, descriptor
  indexing, …) and still emits SPIR-V, so naga is required afterwards anyway.
  It cannot fix `InvalidId`, which is present in the WebGPU-safe subset too
  (SPIR-V 1.0, `OpTypeSampledImage` is core). It is a possible P4 complement for
  dxc's 1.3+ constructs, never a replacement.
- **spirv-cross-wasm (SPIR-V→GLSL) + naga glsl-in — worse coverage, double the
  failure surface.** Nothing is vendored (no `spirv*` anywhere in the tree, not in
  `node_modules`), so it needs a fresh emscripten build; and it makes GLSL — which
  has no representation for the things DXVK's pixel shaders actually carry (spec
  constants for per-draw specialization, descriptor-indexing decorations, Xfb,
  subgroup ops) — the intermediate language. It would convert modules naga
  handles today and still need naga for the constructs it does not.
- **New in-house translator — no.** This is the whole reason naga is in the tree.
- **Maintained naga spv-in patch — the fallback, and it is small.** The fix is to
  register `OpLoad`-of-`OpTypeSampledImage` results into `lookup_sampled_image`
  (a change local to the front end, ~tens of lines). The cost is not the patch, it
  is the maintenance surface: a forked Rust crate plus a `cargo` +
  `wasm32-wasi`/wasm-bindgen build in-tree. Both cargo and crates.io are
  reachable from this box (`cargo add naga` resolves), so this is a
  do-it-next-session cost, not a blocked one.

### What P3 does, in order

1. **Get the dxc corpus entry** — one dxc-compiled DXVK vertex+pixel pair. This is
   the only input that cannot be manufactured here: there is no dxc, no DXVK
   binary and no game in this environment, which is the offline constraint the
   audit flagged and it still stands. G2 condition (5) stays blocked on it.
2. **Count `OpSampledImage` vs loaded `OpTypeSampledImage` in it.** That single
   number decides between "naga as-is works for DXVK's pixel shaders" and
   "fork naga". Do not fork before this measurement — the answer is one grep.
3. Only then: patch `lookup_sampled_image`, rebuild `web/vendor/naga`, and re-run
   the page-tier gate on both the vkcube pair and the dxc pair.

Meanwhile the boundary side is unaffected: §2.5 already established that the
SPIR-V bytes cross as an opaque base64 blob in the manifest and are converted in
the page (`web/shader.mjs` → `vendor/naga`). Nothing about the route changes the
ABI, the frame schema, or the trap.

---

# PART 3 — evidence index

```
/tmp/p1work/
  icd/vkwebgpu_icd.c              1764 LOC — the ICD (real object tables + manifest writer)
/tmp/p1work/icd/libvkwebgpu_icd.so      built artefact: 105 vk* + 3 vk_icd* dynamic exports
  icd/vkwebgpu_icd.json           ICD manifest for the loader
  icd/vkwgpu_stream/frame0002.json       sample frame manifest (400x400, draw 36 verts)
  icd/vkwgpu_stream/shaders/*.spv        1560 B vert + 1280 B frag, glslang, SPIR-V 1.0
  host/p1render.mjs               174 LOC — manifest → naga → WebGPU → readback → PNG
  host/p1sweep.mjs                rotation sweep vs the lavapipe reference; best 18.3/255
  host/p1sil.mjs                  silhouette IoU forensic (parked)
  host/gpu.mjs, result.json, triangle.png   original WebGPU render+readback spike
  final-cube.png                  proof frame (400x400, 26.98 % lit, regenerated this session)
  ref/vkcube_core.txt             the 85 entry points that must cross
  ref/clean/f000..f119.png        lavapipe reference sweep (120 frames)
  progress.md, report.md          P1 working notes + the original feasibility spike
  attic/README.md                 inventory of the parked debug/forensic material
  tools/usr/bin/vkcube            extracted vulkan-tools 1.3.275 (arm64) — re-runs the guest
```

Re-running the proof frame end to end, from the current tree:

```sh
cd /tmp/p1work
Xvfb :97 -screen 0 800x600x24 &
VKWGPU_TRACE=1 VKWGPU_STREAMDIR=$PWD/icd/vkwgpu_stream \
  VK_ICD_FILENAMES=$PWD/icd/vkwebgpu_icd.json DISPLAY=:97 \
  ./tools/usr/bin/vkcube --c 4 --width 400 --height 400      # exits 0, 4 manifests
DISPLAY=:97 node host/p1render.mjs icd/vkwgpu_stream frame0002 final-cube.png
```
## 2.13 G2 status (2026-10-05 -- DXVK D3D9 tri9 bring-up)

**Status: RED.** DXVK D3D9 device initialization now completes through buffer/image
creation; blocked on async submission thread hang.

### Probe progression (r3 -> r26)

- r3 (86 traps): VkPhysicalDeviceRobustness2PropertiesEXT zero alignments -> div-by-zero. Fixed.
- r11 (93 traps): Zero framebuffer sample counts -> CheckImageSupport FALSE. Fixed.
- r13 (131 traps): Missing vkGetImageMemoryRequirements2 (was TAIL stub). Implemented.
- r20 (150 traps): Missing vkGetDeviceBufferMemoryRequirements (Vulkan 1.3 maintenance4). Implemented.
- r25 (150 traps): Missing vkCreateBufferView (was TAIL stub). Implemented.
- r26 (129 traps): HANG. Zero vkQueueSubmit traps; worker thread never processes queue.

### Changes (within G2 lane)

- source/vulkan/vk64bridge.cpp: robustness2 alignments, sample-count limits,
  4 new handlers, K_BUFFERVIEW/BufferView struct
- source/vulkan/vk64bridge_abi.h, vk64_guest.h: 4 fnIds, 4 structs
- tools/rootfs64/libvk64/libvk64.c: 4 shim functions, proc table entries

### Current blocker

DXVK DxvkSubmissionQueue worker thread never calls vkQueueSubmit after
DxvkDevice::submitCommandList queues work. 10 successful proc-addr resolutions,
0 calls. Suspected wasm pthread condition-variable issue.
Next: verify pthread CVs in Emscripten build, or patch DXVK for sync submission.
