# Baldi's Basics D3D9 prep — staged-build analysis

**Build:** `/tmp/stage/baldi` — Baldi's Basics Classic Remastered, **Unity 2020.3.38f1**
(verified from binary string `2020.3.38f1_8f5fde82e2dc`), Win64 Mono player.
Zip: `/home/ubuntu/kn0tzer/wine/games/baldi.zip` (138 MB). Staged size: 472 MB.

## VERDICT (read first)

**Baldi cannot initialize through D3D9/DXVK — Unity removed the DirectX 9
renderer from Windows Standalone in 2017.3** (Unity release notes, "Backwards
Compatibility Breaking Changes": *"Graphics: Removed DirectX 9 support from
Windows Editor & Standalone"*; deprecation blog 2017-07-10). Binary evidence
below agrees: this UnityPlayer.dll contains **no D3D9 renderer at all**.
The D3D9 lane is a dead end for this game. The DXVK lane that matters for
Baldi is **D3D11** (Unity's first-choice API here), not D3D9. The probe
(`web/tests/baldi-d3d9-prep.mjs`) documents this empirically: `d3d9=n` stages
DXVK's d3d9.dll, Unity never loads it, zero D3D9 calls, zero DXVK-side VK
traps — while Unity's own log shows the real device-selection path.

## 1. Which exe/dlls import d3d9 (binary analysis)

Method: PE import-directory parse + full-binary string scan (objdump on the
server lacks PE support; parsed by hand).

| Binary | Static imports | d3d9 reference |
|---|---|---|
| `BALDI.exe` | `kernel32.dll`, `unityplayer.dll` only (thin launcher stub) | none |
| `UnityPlayer.dll` | **empty import directory** (rva=0, size=16) — loads everything via `LoadLibrary` | `d3d9.dll`, `d3d11.dll`, `d3d12.dll`, `dxgi.dll`, `opengl32.dll` present as *strings only* |
| `UnityCrashHandler64.exe` | kernel32-class only | none |
| `mono-2.0-bdwgc.dll` | n/a (runtime) | none |

String inventory in UnityPlayer.dll (60 MB scanned):

- `Direct3DCreate9Ex`: **0 hits** · `D3DCompile`/`d3dcompiler`: **0 hits** ·
  `IDirect3D9Ex`/`CheckDeviceFormat`/`GetAdapterIdentifier`: **0 hits** ·
  `GfxDeviceD3D9`: **0 hits** · `force-d3d9`: **0 hits**
- The single `d3d9.dll` string is `\d3d9.dll` inside **FMOD's DirectSound
  output** plugin table (audio), not graphics.
- Present: `GfxDeviceD3D11` (1), `GfxDeviceD3D12` (1), `D3D11CreateDevice` (1),
  `force-d3d11` (1), `force-glcore` (1), `force-vulkan` (1). No
  `GfxDeviceOpenGLCore`/`GfxDeviceVulkan` class names (stripped), but the
  force flags prove the renderers ship.

So: **no static d3d9 import anywhere, no dynamic d3d9 load path in the
graphics code** — Unity 2020.3 never calls `Direct3DCreate9[Ex]`.

### Shader payload

DXBC-only confirmed (magic scan): `resources.assets` 14 DXBC / 0 SPIR-V,
`globalgamemanagers.assets` 20 / 0, `sharedassets0.assets` 2 / 0. No
`d3dcompiler_47.dll` needed at runtime (Unity precompiles; the GL path
translates DXBC→GLSL in-player, which is why it works today).

### What D3D9 caps/interfaces a Unity of this era *would* query (for the record)

N/A for this build (no D3D9 renderer), but the D3D9 lane's general Unity
notes: pre-2017.3 Unity used plain `Direct3DCreate9` (not Ex), queried
`GetAdapterIdentifier`/`EnumAdapterModes`, created the device with
`D3DCREATE_HARDWARE_VERTEXPROCESSING`, required VS/PS 3.0 caps
(`D3DVS_VERSION(3,0)`), and never needed `d3dcompiler_47` at runtime.
None of this applies to 2020.3.38f1.

## 2. WINEDLLOVERRIDES + Wine prefix staging (what the D3D9 lane needs)

- **Override value:** `WINEDLLOVERRIDES=d3d9=n` — native DXVK d3d9.dll over
  wine's builtin wined3d-based d3d9.
- **DXVK build:** `tools/dxvk/build.w64/src/d3d9/d3d9.dll` — DXVK **v2.4.1**,
  win64, d3d9-only (`-Denable_d3d9=true`, dxgi/d3d8/d3d10/d3d11 off).
  Imports only ADVAPI32/GDI32/KERNEL32/msvcrt/USER32; `LoadLibrary`s
  `vulkan-1.dll` at runtime (wine's builtin) — no dxgi, no vulkan-1 import.
  See `tools/dxvk/BUILD.md`.
- **Staging (already done by `tools/dxvk/stage-dxvk.sh`):** d3d9.dll at
  `home/username/d3d9.dll` (Z:\home\username\d3d9.dll) and
  `home/username/.wine/drive_c/d3d9.dll` (C:\d3d9.dll) inside
  `dist/runtime/prefix64.zip`. Wine's DLL search checks the **app directory
  first**, so the probe also stages it next to the game:
  `/tmp/stage/baldi-d3d9/d3d9.dll` (= copy of `/tmp/stage/baldi` + DXVK dll).
- **Env plumbing (verified in source):** the launcher `?p=` path builds env
  in `prefixEnv()` (`project/emscripten/wine64-launcher.js`) — it maps only
  `?winedbg`→`WINEDEBUG` and `?monodebug`; **there is no `?overrides` URL
  param**. Two workarounds were evaluated for getting `d3d9=n` into the game:
  - `bw64_spawn` per-spawn env (merges via `mergeSpawnEnv()`,
    `source/sdl/emscripten/wine64session.cpp:171`) — the mechanism works
    (verified: `WINEDLLOVERRIDES=d3d9=n` reached the guest env, `sys_execve64:
    ENV` lines), but booting a session WITH `?exe=` (the runtime page's
    `bwPrepareFilesystem` path) crashes reproducibly:
    `__emscripten_receive_on_main_thread_js: TypeError: func is not a
    function` → "session never became ready". And populating the FS post-boot
    cannot work: `bw64_register_file` creates file nodes only, parent dirs
    stay unregistered → wine returns `c0000135` for the exe.
  - **Registry override (used by the probe):**
    `[HKCU\Software\Wine\DllOverrides] "d3d9"="native"` ≡
    `WINEDLLOVERRIDES=d3d9=n`. The probe writes a modified `user.reg` into
    the installation's persisted store (`bw64persist-wine-<id>`) before
    `#start`; the runtime restores it at preRun (`persist: restored 1
    file(s), 9322 bytes`) where it shadows `prefix64.zip`'s `user.reg`.
    Verified live in the boot log.
- **Detection:** `WINEDEBUG=+loaddll` via `?winedbg` shows every module load
  and which copy (app dir vs system32 vs builtin); DXVK prints its
  `info: Game: …` / `DXVK: v2.4.1` banner on `Direct3DCreate9` — absent here.

## 3. Checklist: what must be true in the vk64 ICD for a D3D9→DXVK init
   (applies to real D3D9 games; Baldi never reaches it)

From `tasks/audit.md` + the tri9 DXVK probe (`/tmp/dxvk-probe2-out.txt`,
G2 gate RED at the surface wall):

- [ ] **Instance extensions:** advertise `VK_KHR_surface` +
      `VK_KHR_win32_surface` (today: surface, xcb, xlib, headless — no win32).
      The tri9 probe died exactly here: DXVK banner printed, then
      `Required Vulkan extension VK_KHR_surface not supported` → DxvkError.
- [ ] **`vkCreateWin32SurfaceKHR`** in shim/bridge (~15 lines, mirrors the
      headless case) — winevulkan needs the Win32 path; without it no
      swapchain, period.
- [ ] **apiVersion ≥ 1.3** reported (today 1.1 → DXVK `isCompatible` fails
      outright for 2.4.x).
- [ ] **Device extensions** beyond `VK_KHR_swapchain`: DXVK 2.4.1 hard-requires
      `VK_EXT_robustness2` (`nullDescriptor` + `robustBufferAccess2` —
      "will not run without"). (maintenance5/6, load_store_op_none,
      depth_clip_enable, transform_feedback are 2.5+/D3D10/11 concerns.)
- [ ] **`VkPhysicalDeviceFeatures2` pNext walker** — robustness2/descriptor
      indexing/shader-int16 features must read TRUE, not stay FALSE.
- [ ] **Timeline semaphores:** DXVK puts a timeline wait/signal fence on every
      flush. `vkCreateSemaphore` must honor `VkSemaphoreTypeCreateInfo`;
      `vkSignalSemaphore` / `vkWaitSemaphores` / `vkGetSemaphoreCounterValue`
      must exist (today absent → first flush dies in the benign tail).
- [ ] **`vkQueuePresentKHR` writes `VK_SUCCESS` per swapchain into pResults**
      (today never written → DXVK reads garbage → phantom device-loss cascade).
- [ ] **Threading:** never hold `g_vkMutex` across the `MAIN_THREAD_EM_ASM`
      hop in present (deadlock: worker holds mutex + blocks; main thread
      needs it).
- [ ] **Trap coverage:** the ~85-entry-point bridge must record
      `pVertexInputState` and push-constant ranges/layouts (DXVK pushes
      constants per draw); `vkCmdPushConstants` in the trap set.
- [ ] **Swapchain basics:** one format (B8G8R8A8_UNORM/SRGB) + FIFO present
      mode is tolerated by DXVK; `oldSwapchain`/resize is P3.

## Bottom line for lane planning

Stop spending D3D9 effort on Baldi. If Baldi-through-DXVK is the goal, the
lane is **D3D11**: Unity tries `D3D11CreateDevice` first (wined3d caps D3D11 at
FL 9_3 → E_FAIL today), which is exactly what DXVK's d3d11.dll fixes — but
that needs the same ICD checklist above plus the D3D11 extension set
(transform_feedback, maintenance5…) and the schema-v2 vertex/index BYTES
wall. The D3D9 lane stays valid for actual D3D9-era games, not this one.

## Probe result (web/tests/baldi-d3d9-prep.mjs, run 2026-10-05)

One boot attempt, `d3d9=native` registry override live
(`persist: restored 1 file(s), 9322 bytes`), DXVK 2.4.1 `d3d9.dll` staged
next to `BALDI.exe`, `WINEDEBUG=+loaddll`:

- **d3d9.dll: never loaded.** Zero `loaddll` lines for `d3d9.dll`; no DXVK
  banner; zero `Direct3DCreate9` calls. The trace itself worked — it shows
  Unity loading **`d3d11.dll` (builtin)** instead:
  `trace:loaddll:build_module Loaded L"C:\windows\system32\d3d11.dll" …
  builtin`, then wined3d init
  (`fixme:d3d:select_card_handler … "Boxedwine64 GL (WebGL2)"`).
- **First 20 VK traps:** 9 total — `vkCreateInstance`,
  `vkEnumeratePhysicalDevices` ×6, `vkDestroyInstance`. These are Unity/wine
  Vulkan capability enumeration (create → enumerate → destroy), **not**
  DXVK: no device creation, no swapchain, no draws.
- **Game booted:** `XWire: first window mapped`; no guest failure; the GL
  path came up (`gl64: host GL up (WebGL2)`), consistent with the known
  "renders only through the GL path" state.

Verdict confirmed empirically: with the native D3D9 override fully armed,
Baldi never touches D3D9 — Unity 2020.3.38f1 has no D3D9 renderer to call it.
