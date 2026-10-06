# Rendering pipeline stack: Boxedwine64 (today) -> modern game in browser (destination)

## Legend
[SOLID]   = exists and works today in the repo
[PARTIAL] = exists, incomplete
[SPIKE]   = spike-proven feasible (/tmp/vkspike report, committed tasks/vulkan-webgpu-spike.md)
[EXTERNAL]= battle-tested third-party we integrate/fork (DXVK, vkd3d, Naga, spirv-webgpu-transform)
[NONE]    = must be built new

## TODAY — the working stack (D3D9-era + GL games, running at kn0tzer.work.gd/wine)

```
Windows game (.exe x64)
  |
  v
[cpu64 interpreter / future JIT]         <-- WASM64, runs Win64 code in browser (SOLID; JIT port planned = perf gate)
  |
  v
[Wine 7 x64] Win32 API, fs, registry      <-- rootfs + prefix in browser VFS (SOLID)
  |
  |--(D3D9 / GL games)------------------>  [wined3d -> guest libGL shim (libgl64, 606 funcs)] (SOLID after 10 hardening cycles)
  |                                            |
  |                                            v
  |                                       [gl64bridge.cpp: GL calls -> browser] (SOLID; fixed-function WebGPU bridge + ANGLE WebGL2 path)
  |                                            |
  |                                            v
  |                                       [WebGL2 (ANGLE in browser)]  <- today's presentation (SOLID)
  |
  |--(shader lab, offline)-------------->  [Naga WASM: GLSL/HLSL/SPIR-V -> WGSL] + Slang (SOLID, not yet in game render path; ?naga=1 capture)
  |
  v
browser canvas + WebAudio
```

Blocked today for modern games: wined3d caps D3D11 at feature level 9_3 (WebGL2 lacks geometry
shaders -> shader model 3). Unity 2020+ requires FL 11_0 -> D3D11CreateDevice E_FAIL. GLCORE path
fails because Windows Unity builds bake DXBC-only shader payloads (4/4 sampled).

## DESTINATION — the Vulkan substrate stack (modern games incl. D3D11)

```
Windows game (.exe x64)
  |
  v
[cpu64 interpreter / JIT]  (UNCHANGED - survives)
  |
  v
[Wine 7 x64]  (UNCHANGED - survives)
  |
  |--(D3D9/D3D10/D3D11)--> [DXVK: D3D -> Vulkan, SPIR-V out]        (EXTERNAL, native 64-bit, in-guest)
  |--(D3D12)-------------> [vkd3d: D3D12 -> Vulkan]                  (EXTERNAL)
  |--(Vulkan games)------> native Vulkan calls                        (EXTERNAL)
  |
  v
[NAGA-CORE: vkwebgpu ICD (Vulkan driver shim in guest)]              (SPIKE-proven: 752-line stub already
  |  - 85 entry points for vkcube-class apps                            loader-accepted; extends to full)
  |  - command recording -> execute on vkQueueSubmit
  |  - advertises GRAPHICS|COMPUTE|TRANSFER queue (DXVK gate)
  |
  v  (serialized command stream, host bridge)
[WebGPU host] = the browser page itself (SPIKE-proven: node22+chromium renders + numerically-validated readback)
  |
  |-- shaders: [DXVK SPIR-V] -> [spirv-webgpu-transform: fix push-constants/combined-samplers/binding-arrays] (EXTERNAL)
  |            -> [Naga spv-in -> wgsl-out] (EXTERNAL; already ships in our runtime) -> WGSL
  |
  v
[WebGPU] -> GPU-computed frames -> canvas
```

GL games keep the EXISTING left column (gl64bridge -> WebGL2) — no regression.
Long-term option: small GL->Vulkan frontend (Zink-pattern mini-driver) to funnel GL through the
same substrate; NOT needed while WebGL2 path works.

## Component sources
- vkwebgpu ICD: fresh C, vendor WGVK's spirv_reflect.c + tint C-API shim; simple_wgsl (46k LOC C99,
  SPIR-V->WGSL decompiler wgsl_raise.c + full SSIR hub, zero deps, WASM-friendly allocators) is a
  stronger alternate/backup shader engine than tint — pure C, embeddable, 8 languages in/out.
- raygpu (same author): reference for headless WebGPU/Vulkan dual-backend patterns + WGSL/GLSL
  parsing; dawn-ray-tracing: reference for WebGPU-native extension surface.

## Milestone gates (artifact-checked, no time estimates)
G1: vkcube one frame through shim == lavapipe reference (pixel-identical or documented-correct)
G2: D3D9 triangle through DXVK->shim->WebGPU
G3: a real D3D9 Unity/dx9 game playable
G4: D3D11 device init through DXVK succeeds in-guest
G5: Baldi (or any Unity 2020+ 3D game) at rendered gameplay
