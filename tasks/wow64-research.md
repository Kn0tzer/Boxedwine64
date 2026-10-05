# 32-bit game path (Wine WoW64) — research

## What "32-bit support" means here

A 32-bit Windows game needs **three** independent layers, and Boxedwine64
currently has **none** of them:

| Layer | Today | Needed |
|---|---|---|
| CPU: execute 32-bit x86 code | `cpu64` is x86-64 only (`source/emulation/cpu/cpu64.cpp` + `normal/` + `jit/`). It handles 32-bit *operand sizes* inside 64-bit mode, but there is no 32-bit compatibility-mode execution: no CS.D/CS.L segment handling, no 32-bit address-space semantics, no `int 0x80`/`sysenter` entry, no 32-bit TEB/PEB layout. | A 32-bit decode/execute mode (interpreter first, JIT backend later) |
| Wine: load and run 32-bit PEs | `dist/runtime/wine64.zip` is 64-bit-only: **0 i386 entries**. No 32-bit `wine` loader, no `i386-unix/*.so`, no `i386-windows/*.dll`. | 32-bit Wine build packaged alongside the 64-bit one |
| Rootfs: 32-bit ELF libs | `dist/runtime/glibc-rootfs64.zip` is 64-bit only | 32-bit glibc + dependency libs in the emulated rootfs |

The launcher also hard-gates today: `web/app.mjs` throws
*"This runtime currently requires a 64-bit EXE. 32-bit/WoW64 is not certified."*

## Wine WoW64: which architecture fits

The bundled Wine is **version 7** (`tools/buildWine/version.txt`; file dates
2023-02-18). Wine 7.0 introduced the **new WoW64 architecture**: 32-bit PE
code runs *inside* the 64-bit `ntdll` via `wow64cpu.dll` (CPU backend) +
`wow64.dll` (syscall translation) + `wow64win.dll`. Notably, the 64-bit-side
WoW64 DLLs are **already present** in wine64.zip
(`x86_64-windows/wow64.dll`, `wow64win.dll`, `wow64cpu.dll`) — they ship with
every 64-bit Wine 7 build. What is missing is the entire 32-bit side.

With new WoW64 you do **not** need a second wineserver or a separate 32-bit
prefix — one 64-bit `wine64` + the 32-bit DLL set handles 32-bit PEs. That is
the right target (it is also the direction upstream Wine went; the old
split-wine/wineserver model is obsolete).

Requirements under new WoW64:
1. **32-bit Wine build**: `i386-windows/*.dll` (ntdll, kernel32, …) and
   `i386-unix/*.so`, configured against the same Wine 7 source + the tree's
   patch set (`tools/buildWine/patches/`). The existing `tools/buildWine/`
   script builds 32-bit Wine for the *legacy* 32-bit Boxedwine
   (`-march=pentium4`); it is a starting point, not a drop-in — the 64-bit
   tree's wine64.zip was built differently.
2. **32-bit CPU backend for `wow64cpu.dll`**: on real hardware Wine uses the
   host CPU's compat mode. Here, `wow64cpu` must call into the emulator's
   32-bit execution mode — i.e. layer 1 (CPU) is a hard prerequisite, and the
   two must be wired together (context switch 64↔32, segment state, 32-bit
   stack/TEB).
3. **32-bit syscall translation**: `wow64.dll` handles most of it, but the
   emulator's syscall layer (`source/emulation/...`, `syscall64.cpp`
   analogues) needs the 32-bit ABI surface: 32-bit `int 0x80` numbering,
   32-bit `struct` layouts, address-space clamping to 4 GB (3 GB user).

## CPU layer: the big rock

Options, cheapest first:
- **(a) Port the 32-bit CPU from upstream 32-bit Boxedwine.** This tree was
  forked from it — `cpu64.cpp` even references *"the 32-bit path's lazy-flags
  machinery"*. The original 32-bit interpreter/JIT exists upstream and is
  proven. Port = adapt to this tree's memory/threading/syscall interfaces.
- **(b) Add a compat-mode layer to cpu64.** More surgical but touches the
  hottest code in the tree; risks destabilizing the working 64-bit path.

Either way the JIT (`source/emulation/cpu/jit/`) is 64-bit-guest-oriented
today; plan on the **interpreter** for 32-bit bring-up and a 32-bit JIT
backend as follow-up (32-bit games are the perf-sensitive case — JIT matters
more here, not less).

## Rootfs impact

- A 32-bit glibc + lib set must be added to the emulated rootfs
  (`glibc-rootfs64.zip` is 64-bit-only). Expect the rootfs download to grow
  significantly (a targeted 32-bit lib bundle, not a full second distro —
  only what Wine's i386-unix `.so` files link against plus what 32-bit
  ELF helpers need).
- Prefix: `wineboot --init` with a WoW64-capable wine creates the SysWOW64
  tree and 32-bit registry views; `prefix64.zip` / `build-prefix64.sh` need
  a WoW64-aware regeneration.
- DXVK note: `tools/dxvk/build.w64` is 64-bit-only. A 32-bit game on the
  wined3d path works without DXVK; a 32-bit DXVK path needs separate 32-bit
  DXVK builds (`-m32` mingw) staged per-app.

## Rough effort shape

1. **S — 32-bit CPU execution mode** (port or compat layer), incl. 32-bit
   syscall entry, TEB/PEB, 4 GB address space. The critical path; everything
   else waits on it.
2. **M — 32-bit Wine 7 build + packaging** into wine64.zip (i386-windows,
   i386-unix), reusing the tree's patch set.
3. **M — wow64cpu ↔ emulator wiring** (mode switching, context format).
4. **S — 32-bit rootfs libs** + WoW64 prefix regeneration.
5. **S — validation**: 32-bit hello-world PE → 32-bit test suite →
   real 32-bit game; lift the launcher's x64-only gate.
6. **Later — 32-bit JIT backend** (perf), 32-bit DXVK builds (graphics).

Roughly: one solid CPU-port milestone, then integration milestones that are
each smaller than the CPU work. No fundamental research risk identified —
upstream Boxedwine proved the 32-bit CPU, upstream Wine proved new WoW64 —
but it is a multi-week project, not a patch.

## Current blockers (nothing to do until these move)

1. **No 32-bit CPU mode in the emulator** — architectural, the gating item.
2. **No 32-bit Wine binaries anywhere in the tree** — a build is required
   (no prebuilt i386 Wine 7 set staged).
3. **No 32-bit rootfs libraries.**
4. **Launcher rejects non-x64 EXEs** — UI gate, trivial to lift once the
   substrate works, but it documents the current contract.
5. **32-bit graphics**: DXVK builds here are 64-bit-only; 32-bit games start
   on the wined3d/GL path.
