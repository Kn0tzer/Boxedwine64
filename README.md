# Boxedwine64 — Windows userspace emulator in the browser

Run Windows games and programs in a browser tab. Drop in a folder or ZIP,
pick the EXE, and it runs: CPU emulation, Wine userspace, graphics bridged
to WebGPU/WebGL, input and audio forwarded to the page.

Live demo: `https://kn0tzer.work.gd/wine/` (drop a folder, press Start).

## Honest status (2026-10-13, verified by probes, not assumed)

- 32-bit `wine --version` prints `wine-10.0` in-browser; 32-bit programs run.
- 32-bit OpenGL triangle renders (`trigl: RESULT 0`).
- Portal (32-bit D3D9): boots to window, presents 1024×768, but frames are
  black (`lit=0`, `menuVerified:false`). Not playable yet.
- Celeste (32-bit OpenGL/FNA): passes the old pixel-format blocker, reaches
  `BEGIN LOAD` / `GFX LOAD` / `MTN LOAD`, then stalls in OLE marshaling
  (`0x80004002`). Not playable yet.
- Test suite: **93 unit files green + 73 legacy cases green, 0 failing.**
  Browser game probes are the ground truth for playability — counters are not.

## Build

One writer of `dist/` at a time, always through the wrapper:

```sh
tools/bw64-build.sh          # full build + verify + sync dist/ and web/ + provenance
tools/bw64-build.sh --check  # idle / in-progress / stale lock
```

Never run raw `make wasm64-mt`. Never build while a probe holds a slot
(the wrapper refuses). See `BUILD_PROTOCOL.md`.

## Test

```sh
npm test                                   # everything fast: legacy + suite unit
node web/tests/suite/runner.mjs --unit     # 93 unit files, ~20s, no browser
node web/tests/suite/runner.mjs --browser  # Playwright probes, needs the box
node web/tests/suite/runner.mjs --unit --filter celeste
```

Every test reports binary PASS/FAIL and never hangs (120s kill per unit
file, outer timeout per browser test). Details: `web/tests/suite/README.md`.

## Run a game (repeatable probe)

```sh
GAME=portal node web/tests/game-probe.mjs
GAME=celeste GAME_ZIP=/home/ubuntu/kn0tzer/games/celeste-drmfree.zip GL32=1 MONO32_DIR=/home/ubuntu/scripts/mono32 node web/tests/game-probe.mjs
GAME=gangbeasts node web/tests/game-probe.mjs
```

One probe at a time (`acquireProbeSlot`), wait for build idle, read
`test-results/<tag>/summary.json`. A mapped window is never a pass;
menu evidence (`portal-evidence.mjs` OCR gate) or it didn't happen.

## Guarantee contract

`web/tests/suite/unit/game-capability-matrix.test.mjs` maps each game to
the subsystem tests that must be green before it can work:

- Celeste = cpu32 + gl32 + input + audio + fs + mono + sdl2
- Portal = cpu32 + vk32 + v2transport + shader + input + audio + fs

Green matrix means the path is proven; black frames / stalls after that
are new bugs with repros, not mysteries.

## Known gaps (tracked, not hidden)

- CPU: AVX intentionally unsupported (CPUID cleared); MMX advertised, 0
  handlers (deprecated); string/control/segment/privileged/SSE2+ outside
  the 167-form qemu differential — see `tools/cpu-diff/METHOD.md`.
- D3D: 55 conformance ops — D3D9 13/15 (BLACK-not-RGB), D3D10 6/7,
  D3D11 11/13 (Present clear-only + exit(0) multi-device), D3D12 18/20.
  See `test-results/d3d-conformance-MATRIX.md`.
- Vulkan: 14 entries broken; GL: 110 broken runtime behaviors.
  Static API surface is 100% present (bridged); behavior is not.
- Audio: `/dev/dsp` 441Hz sine verified; Wine waveOut hang open.
- 32-bit `vkMapMemory` dispatch: open (Wine asserts at `loader_thunks.c:6053`).

## Deploy

- GitHub Pages builds `master` on push (paths-gated; test-only changes skip
  the rebuild). Big rootfs zips travel via Release `rootfs-pages`, never in
  git (>100MB is rejected).
- `kn0tzer.work.gd/wine` serves `/home/ubuntu/kn0tzer/wine` (Caddy bind).
  Deploy = `rsync dist/ → kn0tzer/wine/` after a green suite + backup to
  `/home/ubuntu/backups`. Backups live in `/home/ubuntu/backups`.

## Layout

- `source/` — emulator (cpu, kernel, io, vulkan, opengl, x11, sdl)
- `tools/` — shims, probes, harnesses (`cpu-diff`, `d3dtests`, `dxvk`, `vkd3d`, `spirvfix`)
- `web/` — page tier (`vkwebgpu.mjs`, `shader.mjs`) + `tests/suite/` (the suite)
- `dist/`, `web/runtime/` — built matched pair + `BUILD_INFO.json` (never trust a result without it)
- `test-results/` — probe evidence (the ground truth)
- `tasks/game-compatibility.md` — per-game verified status with dates
