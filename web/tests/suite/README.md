# Boxedwine64 Test Suite

Every test returns binary PASS/FAIL and never hangs. No manual inspection.
No "looks right."

## Run

```sh
npm test                                        # legacy + suite unit (fast)
node web/tests/suite/runner.mjs --unit         # 93 unit files, ~25s, no browser
node web/tests/suite/runner.mjs --browser       # 11 Playwright probes, needs the box
node web/tests/suite/runner.mjs --unit --filter d3d11
node web/tests/suite/runner.mjs --json          # CI output
```

Exit 0 = all pass. Anything else = failures listed by name.

## No-stall contract

- Each unit file is killed after 120s and reported FAIL.
- Each browser test gets its own timeout + 60s grace, then FAIL.
- Setup is bounded (server 60s, browser launch 120s); teardown is capped.
- Browser tests wait via `waitForPageFn` with explicit timeouts only.
- Enforced by `harness-no-stall.test.mjs`. A hanging test is a harness bug.

## Layout

```
web/tests/suite/
  runner.mjs             # discovers + runs everything, prints PASS/FAIL
  lib/assert.mjs         # check/checkEqual/checkGreaterThan (use these)
  lib/probe-base.mjs     # ProbeTest: slots, server, browser, console capture
  unit/*.test.mjs        # 93 files, node:test, no browser
  browser/*.test.mjs     # 11 files, ProbeTest subclasses, need the box
```

## Entirety tests (newest, strictest)

These verify whole instruction/API sets to the fullest static extent, with
honest gap lists. A FAIL means a handler was lost or a new class arrived
uncovered:

- `cpu-entirety` — full user-mode ISA: 0F families, x87 D8-DF
  transcendentals, string ops, 167-form qemu differential linkage.
  Known gaps: AVX by design, MMX 0 handlers, privileged/system excluded.
- `vulkan-entirety` — every Vulkan ABI function bridged + shim-handled,
  32-bit `objOf32` parity, no game-breaking TAIL stubs.
- `opengl-entirety` — all 300+ GL ABI functions bridged, GL32 shares GL64
  IDs, GLX present (Celeste pixel-format path).
- `d3d-entirety` — D3D9/10/11/12 against the 55-op conformance matrix
  (13/15, 6/7, 11/13, 18/20) with each broken op pinned by name.

## Capability matrix (the guarantee)

`game-capability-matrix.test.mjs` maps games to required subsystems:

- Celeste (32-bit OpenGL/FNA): cpu32 + gl32 + input + audio + fs + mono
- Portal (32-bit D3D9): cpu32 + vk32 + v2transport + shader + input + audio + fs

If every mapped test is green and the game still fails, that failure is a
new bug with a repro — file it, don't re-chase the "do not chase" list
(`negative-controls.test.mjs`).

## Boundary contracts (where the bugs live)

Bugs cluster at boundaries, so the suite is heaviest there:

- `provenance-artifacts` — wasm/js hashes match `BUILD_INFO.json`,
  dist/web in sync (stale-JS + new-WASM = dead renderer).
- `v2-transport-contract` — chunk magic/header, record registry fails loud,
  16MB cap, present-only hop, `id:offset` cache keys.
- `struct-layout-shipped` — layouts vs shipped DXVK DLLs, never
  test-compile `offsetof`.
- `packaging-prefix`, `vfs-socket-isolation` — zips, prefixes, sockets,
  `/tmp` modes, FsZip LRU/coalescing.
- `probe-harness-integrity` — strict log matching, truncation-tolerant
  parsers, slot protocol, ms-not-count timing.
- `input-keyboard-full`, `audio-audible-output` — verified bytes and
  events, never inferred-from-neighbor.
- `process-gates`, `performance-gates`, `binary-patch-registry` — commit
  means proven-by-probe; builds quarantined; instrumentation gated.

## Adding a test

1. Unit: create `unit/<subsystem>-<what>.test.mjs` with `node:test`.
   Assert on file content or pure logic. Must fail with the bug present,
   pass without it.
2. Browser: create `browser/<name>.test.mjs` extending `ProbeTest`,
   implement `run(ctx)` with `check*` helpers and bounded waits.
3. Run the file, then the whole `--unit` suite. Name it for what's
   verified, reference the bug it guards.

## Status

93 unit files green, 73 legacy cases green (+1 skip), 0 failing.
Browser game probes are ground truth for playability: Portal presents but
black (`lit=0`), Celeste loads content then stalls in OLE — both recorded
in `tasks/game-compatibility.md`, neither claimed playable.
