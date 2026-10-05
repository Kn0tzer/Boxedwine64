# tools/d3dtests — D3D9 gate probes beyond the one triangle

Three tiny D3D9 apps (each <=150 lines, 640x480 windowed, progress on stdout,
`<app>: RESULT 0` verdict like tri9) that widen the D3D9 bring-up gate. They
run against the native DXVK d3d9.dll (`WINEDLLOVERRIDES=d3d9=n`, dll staged next
to the exe) and drive the same stack tri9 does: DXVK -> Wine vulkan-1.dll ->
our libvulkan.so.1 shim -> vk64 trap -> wasm host -> WebGPU.

## Build

```sh
# from tools/d3dtests/
make          # x86_64-w64-mingw32-g++, builds clear9.exe texquad9.exe vshade9.exe
```

## Stage

```sh
tools/d3dtests/stage.sh [PREFIX_ZIP]   # default dist/runtime/prefix64.zip
```

Mirrors `tools/dxvk/stage-dxvk.sh`: exes (+ `checker.bmp`) go to both
`home/username/` and `home/username/.wine/drive_c/`. d3d9.dll is NOT copied
here — `stage-dxvk.sh` owns it and this script only verifies it is present.
Does not touch `tools/rootfs64/buildvk.sh`.

## The probes

| app | isolates | frames |
|---|---|---|
| `clear9.exe` | swapchain + Present, **no geometry at all** | 30 |
| `texquad9.exe` | texture creation, host->device staging, samplers | 40 |
| `vshade9.exe` | vertex-colored indexed draw + **per-frame** `UpdateTexture` (changing uniform) | 50 |

- **clear9** — Clear with a cycling color + Present, nothing else. If the trap
  log shows the swapchain calls with zero draws, the present path works and a
  failure elsewhere is in draw/state setup.
- **texquad9** — loads `checker.bmp` (24-bit BMP, parsed by hand, no D3DX),
  stages `SYSTEMMEM -> UpdateTexture -> DEFAULT`, draws an indexed textured
  quad with linear filtering and wrapped 4x-tiled UVs.
- **vshade9** — re-fills a 32x32 SYSTEMMEM texture every frame (moving
  gradient) via `UpdateTexture`, then draws a vertex-colored indexed quad
  (texture * vertex color). The per-frame re-upload is the probe for repeated
  staging submits.

## Expected VK trap signatures

"Traps" = the vk* entry points our libvulkan.so.1 shim packs into VK64Args
blocks and fires to the host. All three should first show the bring-up
sequence: `vkCreateInstance`, `vkEnumeratePhysicalDevices`, `vkCreateDevice`,
`vkCreateSwapchainKHR`, `vkGetSwapchainImagesKHR`, then per frame
`vkAcquireNextImageKHR` / `vkQueueSubmit` / `vkQueuePresentKHR`.

- **clear9**: the above plus `vkCreateRenderPass` / `vkCreateFramebuffer` and
  clears (`vkCmdBeginRenderPass` with clear values or `vkCmdClearAttachments`).
  Signature: **zero `vkCmdDraw*`**. Any draw here means DXVK did something
  unexpected.
- **texquad9**: clear9's calls plus, once at startup, `vkCreateImage`,
  `vkAllocateMemory`, `vkBindImageMemory`, `vkCreateImageView`,
  `vkCreateSampler`, a staging `vkCreateBuffer`, `vkCmdCopyBufferToImage`
  with `vkCmdPipelineBarrier`s, descriptor layout/pool/set creation and
  `vkUpdateDescriptorSets`; per frame exactly one `vkCmdDrawIndexed`.
- **vshade9**: texquad9's calls plus, **every frame**, another
  `vkCmdCopyBufferToImage` (+ barriers) for the re-uploaded 32x32 texture and
  one `vkCmdDrawIndexed`. Signature: `vkCmdCopyBufferToImage` count ~= frame
  count, `vkCmdDrawIndexed` count ~= frame count, no new `vkCreateImage`.

If `vkCreateSwapchainKHR` never appears, the gate stops at surface creation
(same first failure tri9 would show); if it appears but `vkQueuePresentKHR`
does not, the gate stops at present. Compare per-app: clear9 passing while
texquad9 fails isolates the failure to texture/staging/sampler entry points;
texquad9 passing while vshade9 fails isolates it to repeated per-frame staging.
