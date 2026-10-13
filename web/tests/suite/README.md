# Boxedwine64 Test Suite

Programmatically verifiable tests for the ENTIRE Boxedwine64 system.
Every test returns a binary PASS/FAIL. No manual inspection. No "looks right."

## Quick Start

This is the canonical test suite for Boxedwine64. It is wired into `npm test`.

```bash
# Run ALL fast tests (legacy + suite unit) -- this is what `npm test` does
npm test

# Suite unit tests only (fast, no browser, ~2 seconds)
npm run test:suite

# Suite browser tests only (slow, needs Playwright + box)
npm run test:suite:browser

# Legacy tests only (pre-suite, web/tests/*.test.mjs)
npm run test:legacy

# Direct runner invocation (same as npm run test:suite, with more options)
node web/tests/suite/runner.mjs --unit

# Browser tests only (slow, needs Playwright + box)
node web/tests/suite/runner.mjs --browser

# Filter to specific tests
node web/tests/suite/runner.mjs --filter d3d11

# JSON output for CI
node web/tests/suite/runner.mjs --json
```

Exit code 0 = all pass. Non-zero = failures.

## Directory Structure

```
web/tests/suite/
  README.md              # This file
  runner.mjs             # Master runner (discovers + executes all tests)
  lib/
    assert.mjs           # PASS/FAIL assertion helpers (use these!)
    probe-base.mjs       # Base class for browser probe tests
  unit/                  # Fast tests, no browser needed
    *.test.mjs           # Run via node:test
  browser/               # Playwright probe tests (slower)
    *.test.mjs           # Default-export a ProbeTest subclass
  fixtures/              # Shared test data (binaries, expected values)
```

## Test Categories

### Unit Tests (`unit/*.test.mjs`)

Fast, no browser. Use `node:test` + `node:assert/strict` (or `lib/assert.mjs`).

Good for:
- Static analysis of source files (shim registration, API invariants)
- Pure JS logic (cache key functions, shader rewrites)
- Regression guards for fixed bugs

Example:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('vkCmdCopyBuffer is gipa-registered (LIT=0 regression)', () => {
  const src = readFileSync('tools/rootfs64/libvk64/libvk64.c', 'utf8');
  assert.ok(src.includes('E(vkCmdCopyBuffer,'),
    'vkCmdCopyBuffer must be in g_procs[], not a TAIL stub');
});
```

### Browser Tests (`browser/*.test.mjs`)

Playwright probes. Slower, need the box. Extend `ProbeTest`.

Good for:
- End-to-end rendering (D3D11 triangle, D3D12, D3D9)
- Input injection and verification
- Audio pipeline
- 32-bit boot and PE execution
- Anything requiring the wasm runtime

Example:
```js
import { ProbeTest } from '../lib/probe-base.mjs';
import { checkGreaterThan } from '../lib/assert.mjs';

export default class MyTest extends ProbeTest {
  constructor() {
    super({ tag: 'my-test', timeoutMs: 600000 });
  }

  async run(ctx) {
    // ctx.page: Playwright page
    // ctx.console: captured console lines (array of strings)
    // ctx.dir: test-result directory
    // this.countConsole(/pattern/): count matching console lines

    await ctx.page.goto(`${ctx.server.url}/?test=my-test`);
    await this.waitForPageFn(ctx.page, () => window.__done, 300000);

    const lit = await ctx.page.evaluate(() => window.__lit);
    checkGreaterThan(lit, 0, 'Must render non-zero pixels');
  }
}
```

The runner handles: slot acquisition, browser launch, server startup,
console capture, cleanup, and PASS/FAIL reporting.

## Adding a New Test

### For a unit test:

1. Create `web/tests/suite/unit/<name>.test.mjs`
2. Use `node:test` + assertions from `../lib/assert.mjs`
3. Run: `node --test web/tests/suite/unit/<name>.test.mjs`
4. Verify it fails when the bug is present, passes when fixed

### For a browser test:

1. Create `web/tests/suite/browser/<name>.test.mjs`
2. Extend `ProbeTest`, implement `run(ctx)`
3. Use `check*` from `../lib/assert.mjs` for clear failure messages
4. Run: `node web/tests/suite/runner.mjs --filter <name> --browser`
5. Each `check` failure prints the specific assertion that failed

### Test Naming

- `<subsystem>-<what>.test.mjs` (e.g., `d3d11-triangle`, `input-mouse-rel`, `boot32-vkboot`)
- Name should indicate what's being verified, not how

## Design Principles

1. **Binary verdicts only.** Every test prints PASS or FAIL with the specific
   assertion. No "maybe" or "looks okay."

2. **Regression guards.** When you fix a bug, add a test that would have
   caught it. The test name should reference the bug (e.g., "LIT=0 regression").

3. **Fast feedback.** Unit tests run in <1s. Browser tests are slower but
   each tests one thing. Don't combine unrelated checks.

4. **Clear failure messages.** Use `check*` helpers with messages that say:
   - What was expected
   - What was actually found
   - Where to look next (commit hash, file, function)

5. **No production changes.** Tests live in `web/tests/suite/` only.
   Never modify `source/`, `web/`, or `tools/` from a test.

## Current Coverage (2026-10-13: 80 unit green + 73 legacy green)

### Unit (80 files, all passing via `node web/tests/suite/runner.mjs --unit`)
- Boundary contracts (highest value — every major bug was cross-layer):
  `provenance-artifacts` (P2 torn-build/stale-JS guards, BUILD_INFO hashes, dist/web sync),
  `v2-transport-contract` (bwVkChunk, VK2F magic, 16B header, 0x13 loud-fail, 16MB cap, viewId order, present-only hop, id:offset cache),
  `struct-layout-shipped` (pack(4) i386, 64-bit handles on 32-bit, empirical sample offsets),
  `shader-spirv-matrix` (R5/R6/R8, sampler split, SpecConstantOp fold, indexed-as-non-indexed)
- CPU execute-don't-exist (P1):
  `cpu32-execute-guard` (32-bit string/x87/qama oracle, IMUL __int128, FLD no-double-push, JIT skip-guard),
  `cpu-jit-decoder` (LOOP/JRCXZ/ENTER/LODS, ADC/SBB, 8 transcendentals, 0x50-0x5F size, POP r/m stores),
  plus existing `cpu64-opcode-coverage`, `cpu32-opcode-coverage`, `cpu-x87-coverage`
- 32-bit boot chain (each layer pinned independently, P6):
  `elf-loader-mmap` (allocator, 3GB, FIXED_NOREPLACE heap, clone EIP/TLS, fork, e_phnum, 0xB0000000, LDT[4/5], server32-, soft-MMU, Callback, FS:0x1f8)
- Bridges per bitness (four-bucket, P10 — no API left incomplete):
  `vk32-dispatch` (1.1 *2 funcs, objOf32 x58, bufOff, descriptorType, TAIL severity, KHR aliases, loader procs),
  `gl32-shared-renderer` (Celeste path: shared IDs, zero-extend, guest-width pointers, /home/username/apps first, pixel-format query),
  plus existing `vk-bridge-coverage`, `gl-shim-coverage`, `vk32-*`, `gl-guest-memory`
- System integration:
  `packaging-prefix` (zlib1 staging, ELF wineserver, WINEDLLOVERRIDES ;, vulkan-1=n, ?exe=/?p=/?gamezip, 404 fail-fast),
  `vfs-socket-isolation` (resolved chdir, colon decode, 0700/0400, server32-, LRU/coalesce/per-node FsZip),
  `probe-harness-integrity` (P5 strict ^log: vkboot$, prefix-truncation, slot-lock, ms-not-count, readback ground truth),
  `binary-patch-registry` (P8 checksummed/versioned/expiry, dist/web sync, recompile>archaeology),
  `negative-controls` (Sec 8 do-not-chase list), `process-gates` (P1/P3/P4/P11/P12 commit/build/instrumentation/dirty-tree),
  `performance-gates` (frame ms, klog rate-limit, vkprof defer, latest-wins),
  `input-keyboard-full` (virtual-absolute first, recursive mutex, wheel 4-7, X1/X2 8/9, evdev+8 REAL keysyms),
  `audio-audible-output` (bwPump, full ioctl64 not stub, WHDR_DONE open, 441Hz sine ground truth)
- Guarantee matrix:
  `game-capability-matrix` (Celeste i386+FNA+SDL2+Mono profile, Portal D3D9-VK32 profile; verified/inferred/assumed; no phantom coverage)

### Browser (11 tests, need box + Playwright)
- Existing: `d3d11-triangle` (LIT=8192), `boot32-vkboot`, `input-mouse-rel`, `d3d9/10/11/12-comprehensive`
- New guarantee probes: `gl32-triangle` (Celeste GL path, trigl RESULT 0 precedent), `celeste-boot` (wine-10.0 + BEGIN LOAD + provenance),
  `input-keyboard` (keys reach guest, not inferred), `audio-tone` (non-zero 441Hz bytes, not call counts)

### Guarantee contract
- Celeste (32-bit OpenGL) is guaranteed playable iff green: `cpu32*` + `elf-loader-mmap` + `gl32-shared-renderer` + `gl-shim-coverage` +
  `input-keyboard-full` + `xwire-*` + `audio-audible-output` + `vfs-socket-isolation` + `packaging-prefix` + `provenance-artifacts` +
  browser `gl32-triangle` + `celeste-boot` + `input-keyboard` + `audio-tone`.
- Portal (32-bit D3D9) is guaranteed iff green: `cpu32*` + `vk32*` + `v2-transport-contract` + `shader-spirv-matrix` + input/audio/fs + browser D3D9 scene.

## Top 10 Untested Subsystems (by risk)

1. **32-bit PE execution** — No 32-bit PE runs. Blocks Portal entirely.
2. **D3D9 complex scenes** — Only Pong verified. Portal needs 32-bit D3D9.
3. **Audio audible output** — Verified to SDL_QueueAudio, never heard.
4. **Input keyboard** — Assumed fixed, never empirically verified.
5. **D3D10 swapchain** — Device works, presentation never re-verified after R5/R6.
6. **D3D12 complex scenes** — Basic triangle works, scene12 never rendered.
7. **OPFS/filesystem** — Z: drive mapping fixed, but no comprehensive test.
8. **OpenGL bridge** — GL 2.1 triangle works, nothing else tested.
9. **Wineserver protocol** — 32-bit/64-bit round-trips never tested directly.
10. **Shader conversion coverage** — R5/R6 tested, but not every SPIR-V code path.
