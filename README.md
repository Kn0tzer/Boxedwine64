# Boxedwine64

**Run real 64-bit Windows programs — games included — in a browser tab.** No installs, no plugins, no streaming server. The Windows binary executes on your machine, translated to WebAssembly; its graphics API calls are captured and replayed as WebGPU on the page.

This is a working fork of [andrewnakas/Boxedwine64](https://github.com/andrewnakas/Boxedwine64) (itself a fork of [danoon2/Boxedwine](https://github.com/danoon2/Boxedwine)), focused on one goal: **real gameplay in the browser, with working input.** Everything here is measured against that bar — a mapped window or a successful launch doesn't count.

> ### ▶ [Try the live demo](https://andrewnakas.github.io/Boxedwine64/)
> The upstream demo runs `wine64` in the browser today: a spinning OpenGL cube, interactive Notepad/WordPad, Minesweeper, Snake/Tetris, and DOOM. This fork's work is about getting *modern, GPU-driven* Windows games onto that same stage.

---

## How it works

A Windows `.exe` runs through this pipeline, left to right:

```
 ┌──────────┐   x86-64    ┌──────────────┐   Win32 APIs   ┌─────────────────┐
 │ Windows  │────────────▶│    CPU64     │───────────────▶│  Wine (wine64)  │
 │   .exe   │  interpreter│  + WASM JIT  │                │  userland       │
 └──────────┘   or JIT    └──────────────┘                └────────┬────────┘
                                                                  │ D3D9 / D3D12 / OpenGL
                                                                  ▼
                                                         ┌─────────────────┐   Vulkan    ┌──────────────────┐
                                                         │  DXVK / vkd3d / │────────────▶│  capture bridge  │
                                                         │  GL translation │   calls     │ (vk64bridge)     │
                                                         └─────────────────┘             └────────┬─────────┘
                                                                                                 │ command stream
                                                                                                 ▼
                                                                                        ┌──────────────────┐
                                                                                        │ page-side replay │
                                                                                        │  (WebGPU)        │──▶ <canvas>
                                                                                        └──────────────────┘
```

- **CPU64** emulates the x86-64 processor. Hot code is compiled just-in-time to WebAssembly; the rest runs in the interpreter. Floating-point keeps the interpreter's exact 80-bit semantics — the JIT provably refuses to emit anything that would change a result.
- **Wine (wine64)** provides the Windows userland: real Debian `wine64`, `wineserver64`, `winex11`, FreeType text, and an in-process X11 wire server.
- **Graphics** is where this fork does its heaviest work. Windows games speak Direct3D, browsers speak WebGPU. The bridge:
  1. **DXVK** translates D3D9 (and later D3D10/11) to Vulkan *inside the guest*,
  2. **vkd3d-proton** translates D3D12 to Vulkan *inside the guest*,
  3. the **capture bridge** records the resulting Vulkan command stream,
  4. the **page replays it with WebGPU** and paints to a `<canvas>`.
- **Input** flows the other way: browser keyboard/mouse events are delivered into the guest's message queue, so a click in the page becomes a click in the game.

---

## Status: what's real, what's in flight

Honest accounting. Every claim below was verified by an automated probe, not by reading code and hoping.

### ✅ Proven: pixel-correct D3D9 triangle, end to end

A real D3D9 program (`tri9`) runs under `wine64` in the guest, draws through DXVK, gets captured by the bridge, and is replayed by the page:

- **43,200 lit pixels** — the exact expected triangle area
- orientation and vertex colors verified against ground truth (red top, green bottom-right, blue bottom-left)
- 0 render errors, 0 page errors

Along the way this fixed real bugs at every layer: dropped descriptor offsets in capture, a page-side uniform cache keyed by buffer instead of (buffer, offset), a resize observer destroying in-flight textures, a fragment shader discarding every pixel because of unbound specialization constants, a flipped viewport, and swapped vertex color channels. The probe suite (`web/tests/`) re-verifies all of it.

### 🔨 In flight

| Work | State |
|---|---|
| **Working input** | Browser events traced into the guest; an interactive probe requires *visible pixel change* from scripted input (no change without input, expected change with it) before this is called done |
| **D3D12 via vkd3d-proton** | First probe built and diagnosed: `D3D12CreateDevice` needs 5 Vulkan device features/extensions our bridge doesn't advertise yet. Being implemented now; the Vulkan path underneath already works end-to-end in-guest |
| **CPU JIT, table-driven** | The emitter is being converted from hand-written per-group code to a semantics-table generator (the v86 approach). Each group migrates only when generated output is **byte-identical** to the proven hand-written version |
| **OpenGL / Unity games** | Unity 2020.3 (e.g. Baldi's Basics) fails during graphics init on the GL path; the exact failing call is being isolated |
| **Shader & replay hardening** | Real `VkSpecializationInfo` capture, broader shader translation coverage, tougher replay — sequenced after input lands |

### The bar

A game counts as working when it shows **rendered gameplay AND working input** — verified by probes, with before/after pixel evidence. Anything less is progress, not done.

---

## The CPU JIT

The CPU is a two-tier design: an exact interpreter (the semantic reference)
and a WASM JIT for hot code. The JIT is built on its own development lane and
folded into this fork at snapshot refreshes — what follows is the lane's
current state, which may run ahead of this snapshot's tree:

- **Interpreter** — exact, including 80-bit x87 semantics. It's the reference everything is fuzzed against.
- **WASM JIT** — compiles hot basic blocks to WebAssembly modules, dispatched by table index. Covered so far: integer ALU (8/16/32/64-bit, all forms), shifts, rotates, all `IMUL` forms, `MOVZX`/`MOVSX`, string ops, and memory-operand ALU with interpreter-exact fault ordering.

Two deliberate design decisions:

1. **x87 stays interpreted.** Machine-checked proof: for ordinary inputs, 80-bit-extended addition double-rounds differently than a single 64-bit add, so emitting `f64.add` would silently change results. The JIT refuses these instructions by construction.
2. **Table-driven, not hand-written.** After the first groups proved the approach (every one caught real miscompiles in pre-commit differential fuzzing — swapped shift directions, wrong registers, misdecoded addressing modes), new instructions become *table rows*, not new code. Byte-identical migration is the gate.

Every JIT change must pass: native unit tests, Node WASM tests, the 258-test selftest, a `BW64_JIT=1` smoke run byte-identical to the interpreter, and differential fuzzing.

---

## Repository guide

| Path | What it is |
|---|---|
| `source/emulation/cpu/` | x86-64 interpreter (+ WASM JIT, see above) |
| `source/vulkan/` | Vulkan capture bridge (`vk64bridge.cpp`) — guest Vulkan calls in, command stream out |
| `web/` | Page side: WebGPU replay (`vkwebgpu.mjs`), shader translation, session/input plumbing |
| `web/tests/` | Pixel probes — the verification suite (D3D9 triangle, D3D12 clear, input, …) |
| `tools/dxvk/` | DXVK build used for D3D9→Vulkan in-guest |
| `tools/vkd3d/` | vkd3d-proton build used for D3D12→Vulkan in-guest |
| `tools/spirvfix/` | SPIR-V tooling for the shader pipeline |
| `test-results/` | Captured probe artifacts |

### Branches

`master` is the whole campaign — the working state lives here, not on a side
branch. (Upstream is `andrewnakas/Boxedwine64`; local development lanes are
squashed onto this branch for publication. Full per-commit history is kept
in local development, not on this fork.)

---

## Building & testing

```bash
# native build + full gate suite (JIT lane)
scripts/build-jit-wasm.sh

# browser runtime
node tools/browser/build.mjs

# pixel probes (need a built tree)
node web/tests/dxvk-pixels.mjs        # D3D9 triangle
node web/tests/d3d12-pixels.mjs      # D3D12 clear
```

The full test matrix is documented in `tasks/` alongside the JIT port plan.

---

## Credits & license

- Original Boxedwine by [danoon2](https://github.com/danoon2/Boxedwine) (GPL v2) — including its real, active 32-bit WebAssembly JIT, whose architecture independently converged with this fork's 64-bit design and whose bug catalog is folded into our hardening plan.
- [andrewnakas/Boxedwine64](https://github.com/andrewnakas/Boxedwine64) — the x86-64 port this fork builds on.
- [DXVK](https://github.com/doitsujin/dxvk), [vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton), [v86](https://github.com/copy/v86) — for the translation layers and the table-driven JIT idea.
- Wine — for being Wine.

Boxedwine is released under the GNU General Public License v2. See `license.txt`.
