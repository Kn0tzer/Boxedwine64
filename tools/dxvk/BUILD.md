# tools/dxvk — DXVK bring-up lane (G2: D3D9 clear + indexed triangle)

## Pin

**DXVK v2.4.1** (`doitsujin/dxvk` tag `v2.4.1`, commit `0cf0578`), d3d9-only
win64 build. No newer-meson problem: `meson.build` wants `>= 0.58`, this box
has meson 1.12.1 (pip) + ninja 1.13.2 + glslangValidator 15.1.0 (apt
`glslang-tools`), so **no version pin-down was needed** — 2.4.1 builds as-is.

## Why the stock cross file does not work here

Upstream `src/build-win64.txt` names the bare `x86_64-w64-mingw32-*` tools.
On this box those resolve to the **win32-threads** flavor (`Thread model:
win32`), and DXVK does not build with win32 threads (upstream README "Build
troubleshooting": `std::cv_status has not been declared`). The installed
`-posix` suffixed tools are the same GCC 13 otherwise, so
`cross-win64-posix.txt` (this dir) pins those explicitly.

## Vendored headers (DXVK's own mechanism)

`src/meson.build` checks `./include/vulkan/include` and `./include/spirv/include`
first and only errors when they are absent. This lane vendors them there (shallow
clones, DXVK-2.4.1-era):

- `src/include/vulkan` — KhronosGroup/Vulkan-Headers `v1.3.290`
- `src/include/spirv` — KhronosGroup/SPIRV-Headers `vulkan-sdk-1.3.290.0`

## Build (d3d9 only — G2 needs nothing else)

```sh
# from tools/dxvk/
meson setup --cross-file cross-win64-posix.txt --buildtype release \
  -Denable_dxgi=false -Denable_d3d8=false -Denable_d3d9=true \
  -Denable_d3d10=false -Denable_d3d11=false \
  --prefix / src build.w64
nice -n 19 ninja -C build.w64
# artifact: build.w64/src/d3d9/d3d9.dll  (~6 MB, imports only
# ADVAPI32/GDI32/KERNEL32/msvcrt/USER32 — no dxgi, no vulkan-1 import;
# DXVK LoadLibrary()s vulkan-1.dll at runtime, i.e. wine's builtin)
```

Rebuilds are incremental (`build.w64/` is kept in-tree, gitignored like the
rest of `tools/dxvk/` except the files named here).

## What the guest needs (see stage-dxvk.sh)

- `d3d9.dll` next to the app (`C:\tri9.exe` dir + `Z:\home\username\`), with
  `WINEDLLOVERRIDES=d3d9=n` so wine takes the native one over its builtin
  wined3d-based d3d9.
- `tri9/` — minimal D3D9 app (Clear + DrawIndexedPrimitive, exits 0 after
  70 frames, `tri9: RESULT` on stderr).

## Known ICD-side gaps (all in tasks/audit-patches/, bridge is read-only here)

The D3D9 triangle needs entry points the P2-NOW bridge does not have yet; each
is a separate `.inc` with transplant notes. The probe (`scratch-dxvk.mjs`)
identifies which one the chain actually stops at — read the gate output before
transplanting anything.
