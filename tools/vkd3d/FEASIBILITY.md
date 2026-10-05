# D3D12 via vkd3d — feasibility (lane-vkd3d, 2026-10-05)

Scope: can vkd3d-proton run D3D12 on top of the vk64bridge ICD
(`source/vulkan/vk64bridge.cpp`, read-only this lane), whose page tier renders
through WebGPU via naga spv-in? This doc covers the version pin, the shader
path, the Wine-side wiring, and the ranked blockers to a first D3D12 clear.

## 1. Version pin

**Pin: vkd3d-proton 3.0.1 (the Proton fork), tested at master `31d1f89`
("vkd3d: Add nodxr-on-integrated workaround for Tracing Decay", post-3.0.1).**

Why the proton fork, not upstream vkd3d:

- Upstream vkd3d (winehq, ~1.16) translates shaders with its own
  `vkd3d-shader`: HLSL/DXBC→SPIR-V only. It has **no DXIL frontend**.
  D3D12 apps ship Shader Model 6.x DXIL; without a DXIL→SPIR-V stage those
  shaders cannot become SPIR-V at all.
- vkd3d-proton vendors `subprojects/dxil-spirv` (doitsujin's DXIL→SPIR-V,
  plus dxbc-spirv for legacy DXBC) and statically links both into
  `d3d12core.dll` (`vkd3d_shader_compile_dxil` in `libs/vkd3d-shader/dxil.c`).
  That is the only maintained DXIL→SPIR-V path in the vkd3d family.
- `include/vkd3d.h` pins `VKD3D_MIN_API_VERSION = VKD3D_MAX_API_VERSION =
  VK_API_VERSION_1_3`. The ICD reports `g_icd_api_version = VK_API_VERSION_1_3`
  (`vk64bridge.cpp:828`) and answers `vkEnumerateInstanceVersion` with 1.3, so
  vkd3d's loader-version gate (`loader_version < VKD3D_MIN_API_VERSION` →
  `E_INVALIDARG`, `device.c:672`) passes. An older vkd3d that wanted 1.0/1.1
  would also pass the gate, but would lack the DXIL path — the 1.3
  requirement is not the binding constraint, the shader path is.

Build status: `x86_64-w64-mingw32-gcc-posix` cross-build of this pin is GREEN —
`tools/vkd3d/build.w64` (prior run, 209/209 ninja steps) and the in-progress
rebuild into `tools/vkd3d/build/` produce `d3d12.dll` (exports
`D3D12CreateDevice`) and `d3d12core.dll` (exports `D3D12GetInterface`,
`D3D12SDKVersion`). No build blockers.

## 2. Shader path: DXIL → SPIR-V → naga → WGSL

### Which component does the translation

`dxil-spirv`, at runtime, inside the guest. The chain for a D3D12 app is:

```
app DXIL blob (SM 6.x, produced offline by dxc)
  → d3d12core.dll!vkd3d_shader_compile_dxil
    → dxil-spirv (statically linked, no external dxc/dll needed at runtime)
      → SPIR-V bytes
        → vkCreateShaderModule trap (VK64_fn_vkCreateShaderModule, in the 85)
          → opaque blob in the frame manifest
            → page tier: naga spv-in → WGSL → WebGPU
```

No new translator is needed in-tree. dxil-spirv also handles legacy DXBC via
the bundled dxbc-spirv, so SM 5.x shaders (if an app ships them) are covered
by the same component.

### Can it be prebaked

Yes, two ways; neither is required for the probe:

1. **Offline CLI**: dxil-spirv's own CMake builds a standalone `dxil-spirv`
   executable (`subprojects/dxil-spirv/CMakeLists.txt:140`, from
   `dxil_spirv.cpp`) plus a `dxil-extract` tool. A host (Linux) build of that
   CLI can translate DXIL→SPIR-V ahead of time, and the resulting SPIR-V can
   be fed to the ICD directly (bypassing the guest-side translation).
2. **Runtime (default)**: d3d12core.dll translates on first pipeline creation
   and caches via vkd3d's pipeline cache / Fossilize path. For the minimal
   probe this is the path of least resistance — no extra tooling.

Prebaking is useful later for shader-corpus work (it decouples the naga
question from the guest), not for first light.

### Will naga 30.2 handle the output

Prognosis: **likely yes — better than the DXVK story, but unproven until one
compiled pair is run through it.** Evidence:

- p1-final §2.12 bisected naga 30.0.1's `InvalidId(40)` to a single provenance
  gap: naga's `lookup_sampled_image` is populated only by `OpSampledImage`
  (`front/spv/image.rs:243` ← `front/spv/next_block.rs:1325`). vkcube's
  glslang-produced fragment shader sampled through `OpLoad` of an
  `OpTypeSampledImage`, which naga never registers → `InvalidId`.
- dxil-spirv emits the combined instruction: `dxil_converter.cpp:5876`
  `allocate(spv::OpSampledImage, ...)` — exactly the form naga supports.
  The known naga bug is in a code path dxil-spirv does not emit.
- npm `naga-wasm@30.2.0` reports `nagaVersion = "30.0.1"`; 30.0.1 is the
  newest published naga (cargo confirms). There is no newer spv-in to wait
  for — same conclusion as §2.12.

Residual risk: dxil-spirv may emit other constructs naga 30.0.1 rejects
(capabilities, decorations). The §2.12 decision procedure still applies:
compile one DXIL pair (see probe plan), run it through the vendored naga,
and only then decide whether the maintained spv-in patch is needed. Do not
fork naga before that measurement.

### Comparison with the DXVK SPIR-V story (§2.12)

| | DXVK (D3D9–11) | vkd3d-proton (D3D12) |
|---|---|---|
| SPIR-V producer | dxc, offline at DXVK build time; SPIR-V ships in the binary | dxil-spirv, at runtime in-guest (or prebaked offline) |
| naga input style | dxc's emission — unknown `OpSampledImage` vs loaded-`OpTypeSampledImage` ratio; the §2.12 corpus entry is still missing | dxil-spirv's emission — `OpSampledImage` confirmed in source |
| Known naga gap | `InvalidId(40)` reproduced on vkcube's own frag; dxc corpus unmeasured | same naga, but the failing construct is not emitted |
| Decision state | blocked on the dxc corpus entry | actionable now: one DXIL pair through naga settles it |

Net: the vkd3d shader path is strictly better positioned than DXVK's was at
the §2.12 decision point, because the translator is in-tree (vendored,
auditable) and its output style is the naga-friendly one.

## 3. Wine-side wiring

Guest Wine is Debian bookworm's `wine64` (**Wine 8.0~repack-4**), staged by
`tools/rootfs64/build-wine64-zip.sh` from the
`boxedwine64/wine64-debian:bookworm` Docker image into
`tools/rootfs64/dist/{glibc-rootfs64,wine64}.zip`.

Status on this server (verified 2026-10-05):

- `tools/rootfs64/dist/` is **empty** — the zips were never staged here, and
  the `boxedwine64/wine64-debian:bookworm` image is not present (only
  `debian:bookworm` is). Staging is a `docker build` + script run away, not
  blocked, but not done.
- Wine 8.0 ships both halves of the Vulkan path: `winevulkan`
  (`vulkan-1.dll` + `winevulkan.dll` + `x86_64-unix/winevulkan.so`) and
  `d3d12.dll`. Per Wine's design ("Wine's d3d12.dll is a thin layer on top
  of vkd3d", CodeWeavers vkd3d talk), `d3d12.dll` forwards to
  **vkd3d-proton's `d3d12core.dll`**, which Wine does not ship.
- The intended load chain in the guest is therefore:

```
app.exe → d3d12.dll (Wine 8.0, forwarder)
  → d3d12core.dll (OUR cross-build, installed into the prefix system32)
    → vulkan-1.dll (Wine) → winevulkan → libvk64.so.1 (our shim,
       staged at /lib and /usr/lib by tools/rootfs64/buildvk.sh --stage)
      → vk64 trap → vk64bridge.cpp (host)
```

- vkd3d's `d3d12core` creates its Vulkan instance demanding
  `VK_KHR_surface` + `VK_KHR_win32_surface` (`libs/d3d12core/main.c:571`;
  `_WIN32` branch). Both are advertised by the ICD, and
  `vkCreateWin32SurfaceKHR` is implemented (P2-NOW item). The swapchain then
  goes through `VK_KHR_swapchain`, also advertised.
- Wine-side work items (not code, staging): (a) build the docker image and
  run `build-wine64-zip.sh`; (b) install our `d3d12.dll` + `d3d12core.dll`
  into the wine prefix's `system32` (native override, shadowing Wine's
  forwarder `d3d12.dll` — or keep Wine's forwarder and install only
  `d3d12core.dll`; the forwarder `LoadLibrary`s `d3d12core.dll` by name, so
  either placement works); (c) confirm `winevulkan`'s `wine_vk_init` finds
  our `libvulkan.so.1` (the DXVK lane already proved this path with the
  xlib/win32 surface probes).

No Wine source changes are needed. The Wine side is a packaging task, not a
code task.

## 4. Ranked blockers to a D3D12 clear

Ordered by "what kills `D3D12CreateDevice` / first frame first". Items 1–3
are all in `source/vulkan/` (another lane owns it — listed here, not
patched). Item 4 is packaging. Item 5 is the shader question from §2.

1. **ICD feature/extension deltas — device creation fails without them.**
   vkd3d-proton hard-fails (`E_INVALIDARG`) unless the ICD reports:
   `VK_KHR_push_descriptor` (device ext, not advertised),
   `VK_EXT_vertex_attribute_divisor` ≥ spec v3 (not advertised),
   `samplerMirrorClampToEdge` = TRUE (1.2 features, not set),
   `shaderDrawParameters` = TRUE (1.1 features, not set), and
   1.3 `storageTexelBufferOffsetSingleTexelAlignment` /
   `uniformTexelBufferOffsetSingleTexelAlignment` (1.3 properties struct not
   modeled in `walkProperties2`). Already-OK: robustness2 trio, maintenance5/6,
   transform-feedback properties, timeline semaphores, 1.3 loader version.
   Full delta with patch sketches: `tools/vkd3d/ICD_WORK_ITEMS.md`.

2. **The bridge's command vocabulary is vkcube/DXVK-shaped; vkd3d speaks
   dynamic rendering + synchronization2.** vkd3d-proton records exclusively
   with `vkCmdBeginRendering`/`vkCmdEndRendering` (dynamic rendering, core
   in 1.3 — 10+ call sites in `command.c`), submits exclusively with
   `vkQueueSubmit2`, pushes root descriptors with `vkCmdPushDescriptorSetKHR`
   (5 call sites), and binds/draws with `vkCmdBindVertexBuffers`,
   `vkCmdBindIndexBuffer`, `vkCmdDrawIndexed`, `vkCmdSetViewportWithCount` /
   `vkCmdSetScissorWithCount`, `vkCmdPipelineBarrier2`, `vkCmdCopyBuffer(2)`,
   `vkCmdClearColorImage`/`vkCmdClearAttachments`. None of these have fn-ids
   today; the frame manifest builder hangs off `vkQueueSubmit` (fn 600),
   which vkd3d never calls. This is the largest work item by far — roughly
   doubling the entry-point surface — and it is where the next lane lives.

3. **Wine rootfs not yet staged on this server** (`tools/rootfs64/dist/`
   empty, docker image absent). No guest can run until `build-wine64-zip.sh`
   has been run and the vkd3d DLLs placed in the prefix. Mechanical, but it
   gates every in-guest test.

4. **SPIR-V→WGSL for dxil-spirv output is unmeasured.** The source-level
   evidence says naga 30.0.1 handles `OpSampledImage`, but one compiled DXIL
   pair through the vendored naga is the actual gate (§2.12 procedure). Needs
   a dxc binary (or a prebuilt DXIL pair) — not available on this server
   today.

5. **Trap-volume / perf is unmeasured for the D3D12 call pattern** (p1-final
   §2.10 unknowns #3–#4). vkd3d's per-draw descriptor and barrier traffic is
   heavier than DXVK-D3D9's; the one-hop-per-frame design should absorb it,
   but it needs measuring once items 1–2 land. Not a correctness blocker.
