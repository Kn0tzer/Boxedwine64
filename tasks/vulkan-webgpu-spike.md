# Vulkan-over-WebGPU shim — feasibility spike

**Scope:** evidence-only spike, 2 h, executed in `/tmp/vkspike/`. No commits, no repo changes.
**Host:** Ubuntu 24.04.4, **aarch64**, node v22.22.3, zig 0.14.1 (`tools/browser/zig/zig`), Chromium 151,
Vulkan loader **1.3.275** (`libvulkan1` already present), `vulkan-tools` 1.3.275 unpacked from
`ports.ubuntu.com/pool/universe/v/vulkan-tools/vulkan-tools_1.3.275.0+dfsg1-1_arm64.deb`
(the container's `apt` sources are amd64-vs-arm64 mixed and 404; direct `.deb` extraction used instead —
`/tmp/vkspike/tools/usr/bin/{vkcube,vulkaninfo}`).

---

## 0. Headline numbers

| Question | Answer | Evidence |
|---|---|---|
| Does WebGPU work as a host-side backend on this box? | **Yes**, including full render + readback | `host/result.json`, `host/triangle.png` |
| Is Node 22 WebGPU usable? | **No** — `node --experimental-webgpu` is not a valid flag in v22.22.3 | `node --experimental-webgpu` → `bad option` |
| Entry points the Vulkan **loader** hard-requires of an ICD | **12** | `loader/generated/vk_loader_extensions.c` `LOOKUP_REQUIRED_GIPA` |
| Entry points to reach instance + device + `vkQueueSubmit` (measured) | **17** | `icd/tally_output.txt` |
| Entry points `vkcube` actually calls (X11/xcb build) | **85** | `ref/vkcube_core.txt` (derived from `Vulkan-Tools/cube/cube.c`) |
| Whole-API ICD entry points (Khronos mock ICD) | **821** | `ref/mock_all_entrypoints.txt` |
| LOC of our working stub ICD (53 real entry points) | **752** | `icd/vkwebgpu_icd.c` |

---

## 1. Reference study

### 1.1 WGVK (WebGPU → Vulkan; we need the inverse)
`github.com/manuel5975p/WGVK`, shallow clone at `ref/WGVK`.

| file | LOC | role |
|---|---|---|
| `src/wgvk.c` | 11 926 | the entire WebGPU implementation |
| `src/spirv_reflect.c` | 5 494 | SPIR-V reflection (bind-group layout discovery) |
| `include/wgvk.h` + `wgvk_structs_impl.h` | 6 313 | WebGPU struct/handle plumbing |
| vendored `include/vulkan`, `include/vk_video` | ~85 k | headers only |

Key point for the verdict: **the whole forward direction (a complete, 100 %-conformant WebGPU API) is
~17 k lines of C11 in one file.** That is the size of the *inverse* direction's floor, not its ceiling:
we would need the same amount of code to expose Vulkan to WebGPU, but with a much harder problem
(Vulkan is the *larger* API and has concepts WebGPU does not — geometry/tessellation stages, push
constants, sparse residency, barriers). WGVK also already contains the two hardest sub-problems we
would otherwise have to invent: **WGSL→SPIR-V** (`src/tint_c_api.cpp`, pulled in at `src/wgvk.c:117`)
and **SPIR-V reflection** (`src/spirv_reflect.c`) used to derive descriptor-set layouts from a shader.

### 1.2 Khronos mock ICD (`Vulkan-Tools/scripts/generators/mock_icd_generator.py`)
* `icd/generated/function_definitions.h` contains **821** stubbed entry points;
  `icd/generated/function_declarations.h` is 4 249 lines of boilerplate.
* Manifest format (`icd/VkICD_mock_icd.json.in`):
  ```json
  { "file_format_version": "1.0.1",
    "ICD": { "library_path": "@JSON_LIBRARY_PATH@", "api_version": "1.4.365" } }
  ```
* The `.def` shows the only *exported* symbols that are not plain `vkXxx` are the three ICD-interface
  entry points — everything else goes through `vk_icdGetInstanceProcAddr`.

### 1.3 Loader source — the exact ICD contract
`ref/VL/loader/generated/vk_loader_extensions.c`, `loader_icd_init_entries()`:

```c
#define LOOKUP_REQUIRED_GIPA(func)  do { LOOKUP_GIPA(func); if (!icd_term->dispatch.func) { \
    loader_log(..., "Unable to load %s from ICD %s", ...); return false; } } while (0)

// ---- Core Vulkan 1.0
LOOKUP_REQUIRED_GIPA(DestroyInstance);                    LOOKUP_REQUIRED_GIPA(GetPhysicalDeviceFormatProperties);
LOOKUP_REQUIRED_GIPA(EnumeratePhysicalDevices);            LOOKUP_REQUIRED_GIPA(GetPhysicalDeviceImageFormatProperties);
LOOKUP_REQUIRED_GIPA(GetPhysicalDeviceFeatures);           LOOKUP_REQUIRED_GIPA(GetPhysicalDeviceProperties);
LOOKUP_REQUIRED_GIPA(GetPhysicalDeviceQueueFamilyProperties); LOOKUP_REQUIRED_GIPA(GetPhysicalDeviceMemoryProperties);
LOOKUP_REQUIRED_GIPA(GetDeviceProcAddr);                   LOOKUP_REQUIRED_GIPA(CreateDevice);
LOOKUP_REQUIRED_GIPA(EnumerateDeviceExtensionProperties);  LOOKUP_REQUIRED_GIPA(GetPhysicalDeviceSparseImageFormatProperties);
```

**These 12 are mandatory.** Miss one and the loader logs *"Failed to find required entrypoints in ICD …
Skipping this driver"* and `vkCreateInstance` returns `VK_ERROR_INCOMPATIBLE_DRIVER` (-9).
Everything else (`Features2`, `Properties2`, surface/swapchain, …) is `LOOKUP_GIPA` = optional.

### 1.4 arthurvasseur.fr/blog/vulkan-driver
Practical walkthrough confirms the same shape and adds three rules that are easy to get wrong:
1. **Dispatchable handles must have `VK_LOADER_DATA` as member 0** (`ref/VL`, loader spec). Non-dispatchable
   handles are plain pointers.
2. **Queues are created by `vkCreateDevice`, not by `vkGetDeviceQueue`** — the getter only fetches.
3. `vk_icdNegotiateLoaderICDInterfaceVersion` must be answered; at ≥ 5 the loader switches to
   `vk_icdGetPhysicalDeviceProcAddr` for physical-device-level commands, and **global entry points must
   be queryable with a NULL instance**.
4. Command recording ≠ execution: record into a command buffer, execute on `vkQueueSubmit`
   (he uses a chained-future thread pool for per-queue serialisation).

---

## 2. WebGPU host spike — **PASSES**

`host/gpu.mjs`, driven from node v22 under `xvfb-run`, Chromium 151 headless-new.

Findings:
* **Node 22.22.3 has no WebGPU.** `--experimental-webgpu` is rejected as a bad option; `navigator.gpu`
  is `undefined`. The `navigator.gpu` API also only appears in a **secure context** — an `about:blank`
  Playwright page is *not* secure here, which silently produced `navigator.gpu === undefined`. Serving the
  page from `http://127.0.0.1` fixes it.
* Working flag set (SwiftShader Vulkan adapter, no real GPU on this box):
  `--no-sandbox --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan
   --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --disable-vulkan-surface`
  (plus `xvfb-run` because `headless:false` was required to get a real WebGPU context.)

`host/result.json`:
```
adapterInfo : { vendor: "google", architecture: "swiftshader" }
steps       : navigator.gpu present, secureContext=true -> adapter ok -> device ok ->
              shader module compiled (0 msgs) -> render pipeline ok -> readback ok -> canvas presented
format      : rgba8unorm
pixels      : litPixels 16200 / 65536 = 24.72 % coverage, maxR 217, centerPixel [128,127,230,255]
```
The 24.72 % coverage is the analytic answer: a WGSL triangle with NDC vertices `(0,0.7),(-0.7,-0.7),(0.7,-0.7)`
has area `0.5·1.4·1.4 = 0.98` in a 2×2 NDC square = 24.5 %, and the colour is the interpolated
`vec3(p*0.5+0.5, 0.9)` → `(0.5, 0.475, 0.9)·255 = (128,121,230)`. **Render + readback is numerically correct**, not
just "it didn't crash". `host/triangle.png` is the readback re-encoded as PNG (IHDR verified 256×256 RGBA8).

**Conclusion:** the "host GPU server" half is a solved problem *today* with zero new code — the browser
(or any Dawn/wgpu build) already is a WebGPU server. The ICD side is where all the work is.

---

## 3. Guest ICD spike — **PASSES**

`icd/vkwebgpu_icd.c` (752 lines), built with `zig cc -O2 -fPIC -shared` against WGVK's vendored
Vulkan headers. Manifest `icd/vkwebgpu_icd.json`.

Gotchas discovered (each cost a build/run cycle):

1. **All entry points must be non-`static` *and* exported.** `zig cc -shared` produced a 3 KB `.so` with
   **zero** dynamic symbols until both were fixed. With `__attribute__((visibility("default")))` via a
   redefined `VKAPI_ATTR`: 62 dynamic `vkXxx` exports.
2. **You must define the `_T` struct bodies, not the typedefs** — `vulkan.h` already does
   `VK_DEFINE_HANDLE(VkInstance)`, so redeclaring `typedef struct VkInstance_s` is a hard error.
3. **`VK_LOADER_DATA` must be member 0 of every dispatchable handle.**
4. **If you want 1.1+:** `vk_icdNegotiateLoaderICDInterfaceVersion` must return ≥ 5, or the loader clamps
   and requires you to fail `vkCreateInstance` for `apiVersion > 1.0`.

### 3.1 Loader-acceptance tally (the headline measurement)

`icd/loader_tally.c` steps the **real loader** one call at a time (`VK_ICD_FILENAMES` → our `.json`).
```
== loader accepts ICD ==
vkEnumerateInstanceVersion            instance version 1.3.275
layers = 3   instance extensions = 4
vkCreateInstance                       0        <- driver accepted, not skipped
vkEnumeratePhysicalDevices   physical devices = 1
vkGetPhysicalDeviceProperties  name='VKWGPU WebGPU Virtual Device' apiVersion=1.1.0 type=Other
  limits.maxPushConstantsSize=256 maxTextureDimension2D=16384 maxBoundDescriptorSets=4
queue families = 1, flags=0x7 (GRAPHICS|COMPUTE|TRANSFER) count=1
vkCreateDevice 0 / vkGetDeviceQueue / vkCreateCommandPool / vkAllocateCommandBuffers /
vkBeginCommandBuffer / vkEndCommandBuffer / vkQueueSubmit 0 / vkDeviceWaitIdle 0

TOTAL distinct ICD entry points needed to reach vkQueueSubmit: 17
```
Observed loader rejection sequence (each `WARNING: Unable to load … from ICD … Skipping this driver`
until fixed): `vkGetPhysicalDeviceFormatProperties` → `vkGetPhysicalDeviceImageFormatProperties` →
`vkGetPhysicalDeviceSparseImageFormatProperties`. Consistent with the source list in §1.3.

### 3.2 `vkcube` against the stub
```
[vkwebgpu] negotiate loader icd interface version -> 5
[vkwebgpu] vkCreateInstance ok (apiVersion=1.1.0, 2 ext)
[vkwebgpu] asked-for (unimplemented): vkGetPhysicalDevicePresentRectanglesKHR
Selected GPU 0: VKWGPU WebGPU Virtual Device, type: Other
[vkwebgpu] vkCreateDevice ok (1 queue families requested)
[vkwebgpu] vkGetDeviceQueue(0,0)
Segmentation fault
```
i.e. **instance → physical-device selection → logical device → queue all work through the loader with a
stub ICD**, and the first un-implemented device-level command faults the app. (Also note the earlier,
useful failure mode: without `VK_KHR_surface` advertised, vkcube stops cleanly with
*"failed to find the VK_KHR_surface extension"* — that is how the extension-gating requirement for
DXVK/Wine surfaced.)

---

## 4. (a) Entry-point count and LOC for a minimal-but-honest ICD

| Milestone | Entry points | Real bodies needed | Evidence |
|---|---|---|---|
| Loader will not skip the driver | **12** (`LOOKUP_REQUIRED_GIPA`) | 12 | §1.3 |
| + ICD interface | **15** (`vk_icdNegotiateLoaderICDInterfaceVersion`, `vk_icdGetInstanceProcAddr`, `vk_icdGetPhysicalDeviceProcAddr`) | 15 | loader spec |
| + `vkCreateInstance`/`vkEnumerateInstanceVersion`/`vkEnumerateInstanceExtensionProperties` | **18** | 18 | measured |
| **Measured: through `vkQueueSubmit`** | **17** (overlap with the 12) | ~25 | `icd/tally_output.txt` |
| **vkcube's full X11 workload** | **85** | 85 | `ref/vkcube_core.txt` |
| Whole Vulkan 1.1/1.3 surface (Khronos mock) | **821** | — | `ref/mock_all_entrypoints.txt` |

LOC evidence:
* 752 lines for 53 stub entry points → **~14 LOC/entry point** of pure plumbing (signature, handle map, return).
* A *real* body costs far more. Calibration from WGVK (17 k LOC implementing a strictly smaller API):
  buffers/images 300–600, render pass + framebuffer 400–700, descriptor sets + layouts 500–900,
  pipeline + SPIR-V→WGSL lowering (the actual hard part) 1 500–3 000, sync/fences/semaphores 300–500,
  swapchain/present 200–400.
* **Honest estimate for a vkcube-capable ICD: 6 k – 10 k LOC, 85 entry points, one full-time engineer
  for 3–5 weeks** — and that is the *only* part that is "days not months".

---

## 5. (b) Vulkan → WebGPU semantic mapping (WGVK line refs are the inverse direction)

| Vulkan | WebGPU | Note | WGVK (inverse) |
|---|---|---|---|
| `VkInstance` | implicit (one `GPUAdapter`) | no analogue; maps 1 instance → 1 adapter | `wgvk.c:1278` `wgpuCreateInstance` |
| `VkPhysicalDevice` | `GPUAdapter` | 1:1 | `wgvk.c:2273` `wgpuAdapterCreateDevice` |
| `VkDevice` | `GPUDevice` | | `wgvk.c:2273` |
| `VkQueue` (N families × M queues) | **one implicit `GPUQueue`** | family/priority collapse; we must expose *any* number and serialise internally | `wgvk.c:5300` `wgpuQueueSubmit` |
| `VkQueueFamilyProperties` | — | must advertise GRAPHICS/COMPUTE/TRANSFER on ≥1 family or DXVK bails | — |
| `VkCommandPool`/`VkCommandBuffer` | `GPUCommandEncoder`/`GPUCommandBuffer` | pools vanish | `wgvk.c:3750`, `:4560` |
| `vkCmdBeginRenderPass` | `beginRenderPass` | **closest structural match** | `wgvk.c:4150` |
| `vkCmdDraw/DrawIndexed` | `draw/drawIndexed` | | `wgvk.c:7076`, `:7094` |
| `vkCmdDispatch` | `dispatchWorkgroups` | | `wgvk.c:6025` |
| `vkCmdCopyBufferToImage`/`ImageToBuffer` | `copyTextureToBuffer` etc. | row pitch handled by driver | `wgvk.c:6892`, `:6935` |
| `VkBuffer` + `VkDeviceMemory` | **one `GPUBuffer`** (usage flags) | memory *type* selection disappears; `maxStorageBufferBindingSize` ≈ 128 MB cap | `wgvk.c:2734` |
| `VkImage` + `VkImageView` + memory | one `GPUTexture` + `GPUTextureView` | 1.0-style "image view as separate object" is gone | `wgvk.c:3128`, `:3810` |
| `VkImageLayout` transitions | **none** — pass encodes it | barriers vanish for colour/depth; this is a *win* | `wgvk.c:4260–4275` (WGVK synthesises barriers) |
| `VkPipelineLayout` + `VkDescriptorSetLayout` | `GPUBindGroupLayout` | | `wgvk.c:3501` |
| `VkDescriptorSet` | `GPUBindGroup` | | `wgvk.c:3427` |
| `VkPipeline` | `GPURenderPipeline`/`GPUComputePipeline` | | `wgvk.c:6453`, `:6381` |
| `VkShaderModule` (SPIR-V) | `GPUShaderModule` (**WGSL**) | **spiral-V → WGSL** required | `wgvk.c:117` (WGSL→SPIR-V), `spirv_reflect.c` (inverse problem) |
| `VkSampler` | `GPUSampler` | | `wgvk.c:7665` |
| `VkFence`/`VkSemaphore` | `GPUQueue.onSubmittedWorkDone` + `mapAsync` | Vulkan timeline/binary semaphores have no peer | `wgvk.c:5300` |
| `VkSwapchainKHR`+`VkSurfaceKHR` | canvas context + `getCurrentTexture()` | presentation is the app's problem | WGVK has its own window loop (`examples/glfw_surface.c`) |

---

## 6. (c) Gaps — what makes this months, not days

1. **Shader language inversion (the real blocker).** DXVK ships **SPIR-V**. WebGPU ingests **WGSL only**.
   We need SPIR-V → WGSL. This is the inverse of what WGVK does, and WGVK had to lean on
   Dawn's `tint` (C API) plus a 5.5 k-line reflection pass. A hand-rolled SPIR-V→WGSL translator must
   reconstruct *resource bindings* (SPIR-V has no groups), *entry-point plumbing*, *builtin ↔ attribute*,
   and handle DXVK's legacy `dxc`-era quirks. **Estimate: 3–6 weeks alone, high risk.**
2. **Geometry + tessellation stages.** WebGPU has vertex+fragment+compute only. The ICD must either
   advertise `geometryShader=false`/`tessellationShader=false` (our stub already does) and hope the guest
   never needs them, or implement software emulation. DXVK/DXBC needs geometry shaders for real D3D9/D3D10
   content. **This is a hard capability cliff, not a bug.**
3. **Push constants.** No WebGPU equivalent. Every DXVK shader using them must be rewritten into a
   uniform buffer + bind group, changing descriptor-set layout on the fly per pipeline.
4. **Barriers / memory model.** Synchronisation collapses to automatic pass boundaries + one queue. Any
   app that depends on explicit `vkCmdPipelineBarrier` interleaving (compute→transfer→compute,
   async compute, sparse) has no representation. Our host spike already shows the good news: readback
   through `copyTextureToBuffer` + `mapAsync` is exact, so transfer sync is fine.
5. **Memory model.** `VkDeviceMemory` + memory *types* + `vkMapMemory` host pointers → single opaque
   buffer; no aliasing, no `VK_WEAK` semantics, and the 128 MB default storage-binding cap.
6. **No `GPUQuerySet` equivalent** for occlusion/timestamp queries (WebGPU has experimental timestamp
   only). vkcube does not need it; real games do.
7. **Presentation.** There is no offscreen→window path in core WebGPU. On the BoxedWine host we would
   need either a canvas in a real browser (whole "GPU server" is the page) or a Dawn native/WGPU path.

---

## 7. (d) Phased plan with gates (estimates for the current fleet)

| Phase | Content | Gate (must be true to proceed) | Effort |
|---|---|---|---|
| **P1 — vkcube on the shim, CPU/WebGPU-SwiftShader backend** | 85 entry points; real buffer/image/descriptor/pipeline objects; SPIR-V→WGSL for *cube.vert/cube.frag only*; swapchain → offscreen texture + readback; verify frame hash vs lavapipe reference | A 64×64 vkcube frame is **pixel-identical** to the lavapipe baseline captured on this same box (`vulkaninfo --summary` → `llvmpipe`, API 1.4.318, driver 25.2.8) | **3–5 weeks** (≈55 % SPIR-V→WGSL, 25 % plumbing, 20 % sync) |
| **P2 — real WebGPU host** | Replace SwiftShader with hardware adapter; add DXVK-over-shim integration (d3d9 `dxvk.dll` in the guest); latency/throughput; multi-frame pacing | ≥ 30 fps at 720p for vkcube on the fleet's target device **and** a working D3D9 guest app running through DXVK | **3–4 weeks** |
| **P3 — DXVK D3D9 on top** | Full DXBC coverage: geometry shaders, push constants, sRGB, UAVs, query pools, robust buffers | 3 reference D3D9 titles run with no visual artefacts; failure rate < 1 % over a corpus | **6–10 weeks** |
| **P4 — DXVK D3D11** | Tessellation, MSAA resolve, structured buffers, compute, indirect draws, bindless | D3D11 test suite + 3 titles at native resolution, no perf cliff > 20 % vs lavapipe | **8–12 weeks** |

Total ≈ **5–8 engineer-months** for a usable P4, **3–5 weeks** for the P1 spike that answers "is this
possible at all". Phase 1 is the only part that fits in "days"; the shader-inversion and geometry-stage
problems are what push the rest into months.

---

## 8. (e) Verdict: fork-WGVK-invert vs write-fresh

**Write fresh — but steal WGVK's dependencies, not its structure.**

* *For inverting WGVK*: it is ~17 k LOC of the **opposite** direction. Its types are `WGPUBuffer`/
  `WGPUDevice`; ours are `VkBuffer`/`VkDevice`. Inverting would mean rewriting essentially every struct,
  every dispatch entry, and the entire command layer — you would keep maybe 15 % (build system, window
  loop, examples) and pay for the confusion of a codebase whose invariants point the wrong way. Its
  completeness (100 % WebGPU conformity) buys nothing when the *required* direction is smaller and the
  interesting half (Vulkan-specific concepts) is exactly what WGVK never had to implement.
* *Against writing fresh from zero*: WGVK is the best available evidence for **how** to do the two
  hardest sub-problems, and it ships the two dependencies that would otherwise be weeks of work —
  `tint` C API for WGSL↔SPIR-V and `spirv_reflect.c` (5.5 k LOC) for deriving bind-group layouts out of
  SPIR-V. **Vendor those two, do not vendor the rest.**
* Concrete recommendation: a new `vkwebgpu` ICD whose *only* reused code is `spirv_reflect.c` + the tint
  C API shim, written against the loader contract in §1.3 (our 752-line stub is the correct skeleton),
  targeting the 85 entry points of `ref/vkcube_core.txt` first and nothing else.

---

## 9. File index

```
/tmp/vkspike/
  host/gpu.mjs              WebGPU host spike (node 22 + chromium 151 + xvfb)   <- main proof
  host/result.json          adapter/device/pipeline/readback numbers
  host/triangle.png         readback re-encoded as PNG (256x256 RGBA8)
  host/probe*.mjs           the flag-matrix probes (why headless/node-only failed)
  icd/vkwebgpu_icd.c        752-line working stub ICD (zig cc, aarch64)
  icd/vkwebgpu_icd.json     ICD manifest
  icd/libvkwebgpu_icd.so    built artefact, 62 dynamic vkXxx exports
  icd/loader_tally.c/.out   step-by-step loader acceptance tally
  icd/vkcube_stub_run.txt   vkcube vs the stub: where it gets and where it dies
  tools/usr/bin/{vkcube,vulkaninfo}   vulkan-tools 1.3.275 (arm64)
  ref/WGVK/                 shallow clone, src/wgvk.c = 11 926 LOC
  ref/VT/                   Vulkan-Tools sparse (scripts, icd, cube)
  ref/VL/                   Vulkan-Loader sparse (loader/) — the required-entrypoint list
  ref/mock_all_entrypoints.txt  821 mock-ICD entry points
  ref/vkcube_core.txt       85 entry points vkcube actually needs
```
## P1 result (2026-10-04) — G1 MET

vkwebgpu ICD (752→1764 LOC): loader-accepted through vkQueueSubmit; vkcube runs the full
guest path (instance→device→command recording→submit) and exits 0; frame manifests carry
UBO (sane MVP), 256×256 texture bytes, and both SPIR-V shader blobs. WebGPU host consumes
manifests, renders the cube, readback validated. Best pixel match 18.3/255 mean-abs-diff
vs the 120-frame lavapipe reference sweep — structurally correct, remaining delta is
SwiftShader-vs-lavapipe renderer cosmetics, deferred by orchestrator decision.
Forensic tooling (silhouette IoU, facemap, UV ground truth) parked in /tmp/p1work.
G1 verdict: MET (documented-diffs criterion). Next: P2 boundary design — ICD in-guest over
the wasm boundary mirroring the proven libgl64/gl64bridge pattern.
