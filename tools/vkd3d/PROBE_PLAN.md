# Probe plan: minimal D3D12 clear + triangle (next lane)

No app build is performed in this lane. This is the concrete, ordered plan
the next lane executes — each step names its inputs, the expected observable,
and what to do when the observable is wrong.

## 0. Prerequisites (must be true before the probe starts)

1. `tools/vkd3d/build/` (or `build.w64/`) contains `d3d12.dll` +
   `d3d12core.dll` — DONE this lane (build running; prior 209/209 GREEN).
2. `tools/rootfs64/dist/{glibc-rootfs64,wine64}.zip` staged
   (`build-wine64-zip.sh`; docker image `boxedwine64/wine64-debian:bookworm`
   must be built first — neither exists on this server yet).
3. `d3d12.dll` + `d3d12core.dll` installed into the wine prefix's
   `system32` as native (they shadow Wine 8.0's forwarder `d3d12.dll`;
   alternatively keep Wine's forwarder and install only `d3d12core.dll` —
   it `LoadLibrary`s `d3d12core.dll` by name).
4. ICD work items Part A (A1–A5) applied by the `source/vulkan/` lane, so
   `D3D12CreateDevice` can pass vkd3d's gates. Part B entry points are
   needed for the triangle; the **clear alone** needs A1–A5 + B1 + B2 + B6
   (submit2, begin/end rendering, clear).
5. One DXIL pair (vs_6_0 + ps_6_0, see §2) and its dxil-spirv→naga check
   done (§2.12 procedure).

## 1. The probe app (`tri12.exe`, win64 PE, ~300 lines C)

Deliberately boring: no DXGI swapchain window management beyond what vkd3d
needs, no textures, no depth.

1. `D3D12CreateDevice(NULL, D3D_FEATURE_LEVEL_11_0, &dev)` — 11_0 keeps the
   feature-level requirement minimal (vkd3d grants 11_0 unconditionally once
   the A-gates pass).
2. `CreateCommandQueue` (DIRECT), `CreateCommandAllocator`,
   `CreateCommandList`, `CreateFence`.
3. Descriptor heap (RTV, 2 entries), `CreateCommittedResource` for the
   render target (or a DXGI swapchain via `CreateSwapChainForHwnd` on a
   dummy HWND — Wine provides one headless; the ICD's `vkCreateWin32SurfaceKHR`
   is already implemented).
4. Root signature: empty (`D3D12SerializeRootSignature`, no parameters).
   Pipeline state: vs+ps from the §2 DXIL blobs, triangle input layout,
   `D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE`.
5. Per frame: reset allocator/list → `RSSetViewports/Scissors` →
   `ResourceBarrier` (PRESENT→RENDER_TARGET) → `OMSetRenderTargets` →
   `ClearRenderTargetView` (cornflower blue) → `IASetVertexBuffers` +
   `IASetPrimitiveTopology` → `DrawInstanced(3, 1, 0, 0)` →
   barrier back → `Close` → `ExecuteCommandLists` → `Signal` fence →
   `Present(1, 0)` → `WaitForSingleObject` on the fence event.
6. Exit after N=60 frames with exit code = number of frames presented
   (so a harness can assert "60" without parsing logs).

Vertex data: 3 vertices, positions only, uploaded via an UPLOAD heap —
no staging copies needed for the triangle itself (keeps `vkCmdCopyBuffer`
off the critical path for first light; it stays a B6 item for uploads).

## 2. Shaders: the one offline artifact

Two HLSL sources (~15 lines each):

```hlsl
// vs.hlsl — struct VSIn { float3 pos : POSITION; }; → float4 pos : SV_Position
// ps.hlsl — float4 main() : SV_Target { return float4(1,0,0,1); }
```

Compile with dxc (not on this server; fetch a Linux dxc release or reuse a
known-good pair):
`dxc -T vs_6_0 -E vs_main vs.hlsl -Fo vs.dxil` (same for ps_6_0).
Embed both blobs as byte arrays in the probe (no file I/O in-guest).

**naga gate (do this before writing any ICD code):** build the host
`dxil-spirv` CLI (`subprojects/dxil-spirv/CMakeLists.txt:140`), translate
both blobs, run the SPIR-V through the vendored naga (`web/vendor/naga`).
Pass = WGSL out, no `InvalidId`. Fail = apply the §2.12 maintained-patch
decision. This single measurement retires feasibility blocker #4.

## 3. Expected trap sequence (what "working" looks like)

With `vkTrace()` on, the first frame must show, in order:

1. `vkEnumerateInstanceVersion` → 1.3; `vkCreateInstance` with
   `VK_KHR_surface` + `VK_KHR_win32_surface` enabled.
2. `vkEnumeratePhysicalDevices` → 1; `vkGetPhysicalDeviceFeatures2` with
   vkd3d's chain → walkers answer TRUE for A1–A5 bits
   (log line `vk64: Features2 pNext sType=…` must NOT appear for the
   divisor/1.1/1.2/1.3 structs — they are modeled).
3. `vkCreateDevice` → SUCCESS (this is the A-gate moment; on failure vkd3d
   logs which requirement died — grep the guest log for "is not supported"
   / "Lacking support").
4. `vkCreateWin32SurfaceKHR`, `vkCreateSwapchainKHR`,
   `vkGetSwapchainImagesKHR`.
5. `vkCreateShaderModule` × 2 (dxil-spirv output bytes cross here — log the
   byte sizes; they must be nonzero).
6. `vkCreateGraphicsPipelines`, command pool/buffer allocs.
7. Per frame: `vkBeginCommandBuffer`, `vkCmdBeginRendering` (check the
   logged clear value = cornflower blue), `vkCmdClearAttachments` or the
   rendering-info clear, `vkCmdBindVertexBuffers`, `vkCmdDrawIndexed`/
   `vkCmdDrawInstanced`, `vkCmdEndRendering`, `vkEndCommandBuffer`,
   **`vkQueueSubmit2`** (manifest FRAME N built — this is the heartbeat),
   `vkQueuePresentKHR` (frame hopped).
8. `FRAME-JSON` on the page side → WebGPU renders → readback pixel at the
   triangle centroid is red (±tolerance), background is cornflower blue.

## 4. Staged bring-up (bisect order when something breaks)

1. **Clear only**: comment out the draw (keep PSO creation — it validates
   the shader path). Expect a blue frame. If `vkCreateDevice` fails, the
   guest log names the missing gate (A-items). If the frame is black, the
   clear value didn't survive `vkCmdBeginRendering` recording.
2. **PSO + shaders, no draw**: validates DXIL→SPIR-V→naga for both stages
   without any vertex/index traffic.
3. **Full triangle**: adds B4/B5 traffic. Wrong colors / missing triangle =
   vertex-buffer binding or viewport recording; inspect the manifest's
   vertexBindings + viewports against §2.9's schema.
4. **60-frame soak**: fence/timeline accounting; watch for the
   `g_vkMutex` main-thread hop (p1-final §2.10 #6) and munmap leaks.

## 5. Success criteria (probe GREEN)

- `tri12.exe` exits 60 after presenting 60 frames, no traps in the
  benign-error tail for the B-items (every B-item used must HIT).
- One manifest frame decodes to: clear color ≈ (0.39, 0.58, 0.93), one
  indexed draw of 3 vertices, red centroid pixel on readback.
- No `vk64: … not modeled` log lines for sTypes in vkd3d's device-init
  chain.

## 6. Known unknowns this probe will answer

- Whether vkd3d calls any B7-listed entry point on this minimal path that
  the static analysis missed (the `VK64_fn_unimplemented` trap log is the
  worklist — that is what it was built for).
- Trap volume per frame for the D3D12 pattern (§2.10 #3): count traps
  between two `vkQueueSubmit2`s and compare with the DXVK-D3D9 numbers.
- Whether Wine 8.0's forwarder `d3d12.dll` or our native `d3d12.dll` is the
  smoother install (try forwarder + our `d3d12core.dll` first).
