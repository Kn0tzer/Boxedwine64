# Port Plan: PR #151 WASM JIT → boxedwine64 `cpu64`

Analysis date: 2026-03-09. Sources: local fork `/home/ubuntu/boxedwine64` @ working tree,
and `danoon2/Boxedwine` PR #151 ("introduce a wasm jit"), head `9c3190ffbaf29b41c08553dc696b94dde9ff26b4`,
base `master`, **closed, merged=no**, 153 commits, 90 files, +62,779 / −1,808.

---

## 0. Correction to the task premise (read first)

Three things differ from how the task is framed:

1. **There is no standalone "WASM JIT interpreter" in PR #151 to port onto `cpu64`.** The PR adds
   `source/emulation/cpu/wasm/jitWasmCodeGen.{h,cpp}` (+14,292 / +1,327) which is a **backend of the
   existing `JitCodeGen` virtual interface**, one class `JitWasmCodeGen : public JitSSE`, sibling to the
   existing `jitX86CodeGen` (x32) and `jitArmV8CodeGen`. The block/decode/call graph is inherited from
   `jit/jit.cpp` + `jit/jitCodeGen.cpp` and is *not* reimplemented.
2. **"Merged" means module-merge, not source-merge.** `wasmModuleMerger.cpp` (+266) concatenates many
   single-function wasm modules into one bounded group; `wasmJitBatchPolicy.cpp` (+220) decides when a
   batch flushes. Both are orthogonal to codegen.
3. **`/home/ubuntu/boxedwine64/patch.diff` (897 lines, 9 files) is already a slice of PR #151's interface
   refactor** — `IfLessThan2` → `IfLessThan(..., bool isSigned)`, plus `IfGreaterThan`/`IfGreaterThanOrEqual`
   signed/unsigned, and `Jit::setImulOverflowFlags`. Part of the prerequisite interface churn is already
   present in this fork. Do not re-apply it.

So the port is: **make `JitCodeGen`/`Jit` express 64-bit guest state, then add `JitWasmCodeGen64`
and hook it into `cpu64`'s block loop.**

---

## 1. Fork `cpu64` interpreter structure (mapped)

`source/emulation/cpu/cpu64.cpp` (5,995 lines) is a **hand-written block interpreter with its own IR**,
*not* a `DecodedOp`/`ops.h` consumer:

| Symbol | Line | Role |
| --- | --- | --- |
| `CPU64::run()` | 5449 | outer loop; env-gated tracer (`BOXEDWINE64_TRACE_FROM/TO`), wild-jump RIP ring (`BW64_WILDJUMP`), `while (!yield)` |
| `CPU64::step()` | 613 | per-insn entry (the slow path the JIT must supersede) |
| `CPU64::decodeModRMRecipe()` | 5580 | decodes ModRM into a re-materializable `BRecipe` |
| `CPU64::buildBlock(U64 startRip, BBlock&)` | 5654 | **the block builder** — fills `BBlock.recs[]` of `BRec` (`BK_*` kinds), capped at `BBLOCK_MAX_RECS`; bails on `lock`/`rep`/`osize16` |
| `CPU64::execBlock(const BBlock&)` | 5792 | **the block executor** — `switch (rec.kind)` over `BK_MOV_RM_R`, `BK_ALU_RM_R`, `BK_ALU_RM_IMM`, … calls `resolveRecipe`/`loadRM`/`storeRM`/`runAlu` |
| `CPU64::tryBlockStep()` | 5914 | block fast-path attempt |
| `CPU64::runBounded(U64)` | 5954 | test harness entry |
| `cpu64DumpOpProfile()` | 546 | **existing op profiler** — free phase-0 baseline data |
| `fetchDword/fetchQword`, `push64/pop64`, `readReg8/writeReg8` | 116–146 | memory model: **64-bit guest addresses**, `U64` |

Memory model: `KMemory64* memory` member; guest memory is **not** shadow-paged onto linear memory the way
`JitCodeGen::readHost` assumes. Register file `reg[]` with `u32`/`u64` accessors (REX.W selects width).
Helpers `flagsAdd/flagsSub/flagsLogic`, `maskFor(U32 width)`, `evalCC(U8)`.

Related: `include/cpu64.h` (329 L), `source/emulation/cpu/common/cpu.h` (544 L — the 32-bit `CPU`),
`decoder.h` (1,667 L, `DecodedOp`-based, 32-bit path), `source/emulation/cpu/normal/normalCPU.cpp`
(already carries `BOXEDWINE_DIRECT_NORMAL_DISPATCH` with `MUSTTAIL return` arms explicitly commented
"lets WASM emit direct return_call instructions").

Fork has **no x86-64 codegen backend at all** (`jit/x32/`, `jit/armv8/` only) and only 8 `BOXEDWINE_64`
mentions across `jit/` — the 64-bit JIT interface is essentially unexercised.

---

## 2. PR #151 architecture (what we are porting)

### 2.1 Codegen: `jitWasmCodeGen.h` (+1,327) — the contract

Doc comment (lines 20–30):
> "One WASM module per compiled JIT block. Module imports Emscripten linear memory + C++ helper
> functions. Exports a single `execute` function: `(param cpu_ptr i32)`… The resulting function export
> is added to Emscripten's `wasmTable` and its table index is stored in `DecodedOp::pfnJitCode`.
> Subsequent calls go through `wasmStartJITOp()`."

Local layout (constants, lines 199–225):

```
WASM_CPU_LOCAL       = 0    // param: CPU* as i32 offset into linear memory
WASM_RELOC_LOCAL     = 1    // param: per-activation relocation slot array (nested guest calls safe)
WASM_GP_LOCAL_BASE   = 2    // 8 slots: eax..edi
WASM_SEG_LOCAL_BASE  = 10   // cs,ds,ss,es segment-address slots
WASM_TMP_LOCAL_BASE  = 14,  WASM_TMP_LOCAL_COUNT = 32
WASM_I64_SCRATCH     = 46   // i64 scratch for imulRRI/imulRR overflow only
WASM_F64_LOCAL_BASE  = 47,  count 8 (shared JitFPU)
WASM_V128_LOCAL_BASE = 55,  count 12 (reserved, MMX/SIMD later)
WASM_DIRECT_LOOP_BUDGET_LOCAL = 67
```

**`RegPtr` here is a wasm local index, not a machine register** — that is the key inversion versus asmjit.
Register state is kept in wasm locals for the block's duration, flushed to linear memory via `cpu_ptr`
at block exit / any helper call.

Memory: an **inline TLB fast path** (`emitAligned inline load; else call helper`) backed by page→RAM-offset
arrays living in `KMemoryData`, `BOXEDWINE_WASM_JIT`-gated, ~8 MB total. Slow path imports C++ helpers
through the function table: `m_helperReadMemIdx`, `m_helperWriteMemIdx`,
`m_helperEmulateSingleOpIdx`, `m_helperGetNextOpIdx`, `m_helperSyncToHostIdx` (header lines 1027–1031).

Compilation/instantiation is out-of-process-free but JS-mediated:
`boxedwine_wasm_instantiate_runtime_batch(bytes, size, importFns, importCount, entryCount, outputSlots)`
→ `int* outputSlots` of wasmTable indices; plus a release path to free a block from `wasmTable`.

Flag/state handling is inherited wholesale from `Jit`/`JitSSE` (`lazyFlags`). Unsupported constructs are
explicitly enumerated in the header (xadd mem8/16, cmpxchg mem8/16, cmpxchg8b, bswap32, 16-bit imul, etc.)
— **read lines 84–190 before estimating scope; that list is the real "not implemented" ledger.**

### 2.2 Emitter: `wasmEmitter.{h,cpp}` (+503/+482) — *reusable nearly as-is*

Self-contained wasm binary writer: sections (Custom/Type/Import/Function/Export/Code), value types
incl. `V128`, ~200 opcodes, full SIMD surface (`emitSimdOp`, `emitI8x16Shuffle`, `emitV128Const`),
control flow with **branch hints** (`WASM_BRANCH_HINT` — the `else` opcode the engine reads),
imports (memory/function/global), and `finalize()` → `std::vector<U8>`. **Port cost ≈ 0 LOC** — this file
is architecture-independent.

### 2.3 Cache pipeline (JS/offline, +3,700 LOC) — *deferrable*

- `boxedwine-wasm-jit-module-broker.js` (+1,834), `-cache-pipeline.mjs` (+1,502) with `--flat` and
  "piped" grouping modes, `-cache-analyze.mjs` (+649), `-cache-verify-merged.mjs` (+261)
- `binaryen_js.js` (+31,518) vendored Binaryen build for offline optimise/verify
- Emscripten shell UI (+795) with `?jit-record=true` AOT zip export; IndexedDB persistence
- makefile targets `jit`, `multiThreadedJit`; test target `testJit`

### 2.4 Merging

- `wasmModuleMerger.{h,cpp}`: parses Type/Import/Code sections of N single-function modules and emits one
  module with them side by side (shared imports, multiple exports). ULEB/LULEB-aware, bounds-checked.
- `wasmJitBatchPolicy.{h,cpp}`: `WasmJitBatchKey{KMemory*, U32 mappedFileKey}`;
  `WasmJitFlushReason{BlockCount, ByteCount, PendingHits, ProcessBytes}`;
  limits `maxBlocks=64, maxBatchBytes=512KB, urgentPendingHits=8, maxProcessOpenBytes=4MB`;
  `cancelMemory(KMemory*)` is the invalidation hook.

### 2.5 Tests shipped (use as port gates)

`source/test/cpu/testWasmJitModuleBroker.cpp` (+2,616), `testWasmJitBatch.cpp` (+1,718),
`testXchg.cpp` (+1,135 — emuSingleOp path), plus `testCPU.cpp`/`testMain.cpp`/`makefile`/`Jenkinsfile` wiring.

---

## 3. Port surface

### 3.1 What `JitCodeGen` expects vs. what `cpu64` has

`JitCodeGen` (`jit/jitCodeGen.h`, 207 L, **byte-identical to the fork's copy except two hunks**) is
`public Jit` with ~180 pure-virtual backend hooks. `JitWasmCodeGen` implements ~250 of them
(add/ sub/ and/ or/ xor/ shifts/ rotates/ shld/shrd/ mul/div/ string ops/ FPU hooks/ MMX-SSE / direct_*).
It consumes `DecodedOp*` from `decoder.h`.

| Component | `cpu64` today | Needed | Est. LOC |
| --- | --- | --- | --- |
| **Emitter** | — | port `wasmEmitter.*` verbatim | **~1,000 (0 new)** |
| **Block decoder bridge** | `buildBlock` → `BBlock`/`BRec` | *either* emit `BBlock` directly (new backend, smaller) *or* make `cpu64` build `DecodedOp` chains so `jit.cpp` drives it. Bridge both: `BRec → DecodedOp` adapter | **600–1,200** |
| **Codegen backend** | — | `JitWasmCodeGen64` from `JitWasmCodeGen` + 64-bit deltas | **~9,000–11,000** (of 14,292) |
| **Block loop / cache** | `tryBlockStep`, no cache | `jit.cpp` block cache, `pfnJitCode` slot, `wasmTable` free, lazy-flag init/teardown | **~1,200** (mostly reuse) |
| **Merging** | — | `wasmModuleMerger.*` | **290 (0 new)** |
| **Batch policy** | — | `wasmJitBatchPolicy.*` | **282 (0 new)** |
| **Cache pipeline (JS)** | — | optional, phase 5 | **~3,700** |
| **Inline TLB / `KMemoryData`** | `KMemory64`, no shadow TLB | new `KMemoryData`-equivalent, 64-bit page maps | **~500** |
| **Host helpers** | none | ~12 imported C++ helpers (`readMem/writeMem/emulateSingleOp/getNextOp/syncToHost/…`) incl. `#[no_mangle]`/`EM_JS` glue | **~400** |
| **Interface 64-bit lift** | `jit.h` 8 `BOXEDWINE_64` refs | widen `RegPtr`/`DYN_PTR_SIZE`/`U32 value` immediates to 64-bit where required; add missing virt hooks | **~800–1,500** |

### 3.2 The three riskiest 32→64 deltas

1. **Pointer width — the dominant risk.** The wasm backend's entire value model is `WasmType::I32`
   (`cpu_ptr i32`, `RegPtr` = local index, `emitI32Const`). `WASM_I64_SCRATCH` is the *only* i64 in the
   design, used solely for `imul` overflow tracking — 64-bit values are never materialised. `cpu64`'s
   guest state is 64-bit end to end: `U64` regs, `U64` effective addresses, `fetchQword`. Porting means
   `RegPtr`/locals become i64 across ~250 overrides, every `emitI32*` pair becomes `emitI64*`, and the
   8-GP-local model must become 16 GPRs. A genuine *wasm32 memory64* build would fix this at the cost of
   dropping every engine/browser that lacks memory64; the pragmatic route is **wasm32 + i64 value
   semantics + a 64-bit shadow TLB**, which must be proven correct before anything else moves.
2. **Inline TLB vs. shadow paging.** PR #151 inlines a fast path over `KMemoryData` page→RAM-offset
   arrays sized for 32-bit guest space. `cpu64` uses `KMemory64` with real 64-bit guest address spaces and
   a different page representation. Either mirror the array layout (cost: 2× pages, and correctness
   obligations on every mmap/munmap/prot path — the PR already carries a 148/-46 `kmemory.cpp` and
   64/-3 `kprocess.cpp` delta) or fall back to helper-only memory, which forfeits most of the win.
3. **Relocations / re-activation.** The design deliberately uses *parameters* (`WASM_RELOC_LOCAL`)
   rather than a module global, because nested guest execution (signal delivery inside a helper,
   scheduler switch inside a blocking syscall) must not clobber an outer activation. In `cpu64`,
   64-bit guest pointers widen the relocation payload and any `pfnJitCode`-slot bookkeeping; multi-threaded
   emscripten shares one `wasmTable` across workers, so table-index ownership and `cancelMemory`
   invalidation become load-bearing. Getting this wrong is silent memory corruption, not a crash.

Secondary (non-blocking but real): signed/unsigned widening in the already-landed
`IfLessThan(..., isSigned)` interface; SIMD `V128` locals are only *reserved* upstream (MMX/SSE will
fall back to `emulateSingleOp`); branch hints are emitted but explicitly "not actually doing anything
useful yet".

---

## 4. Phased milestones (each with a measurable gate)

**Phase 0 — Baseline & scaffolding (no codegen).** Build with `BOXEDWINE_WASM_JIT` off/on; land
`wasmEmitter.*` + a unit test that emits a module and validates it via the vendored Binaryen.
*Gate:* emitter test passes; `cpu64DumpOpProfile` run on Cinebench records the interpreter baseline
(instructions/sec) written to `docs/` for later speedup claims.

**Phase 1 — 64-bit value model.** Widen `RegPtr`/locals/params to i64, 8→16 GPR locals, add
`emitI64*` load/store/arith; prove correctness with a *non-optimizing* mode where every guest op still
goes through `emulateSingleOp`, so only the state plumbing is new.
*Gate:* full `source/test/cpu/*` suite green **under the WASM build** (an arithmetic fixture:
`testAdd/testSub/testShift/testCmp/testMov/testXchg`), and end-to-end `Wasm64RunElf` on a native fixture
binary reproduces the `cpu64` interpreter's result bit-for-bit.

**Phase 2 — Arithmetic codegen + inline TLB.** Implement the `add/sub/and/or/xor/shl/shr/sar/neg/not/mov`
backend overrides, plus the `KMemoryData`-equivalent inline TLB fast path and the imported read/write
helpers.
*Gate:* **native fixture probe passes** (arithmetic+memory fixture matches interpreter, byte-exact) **AND
measured speedup >1.5× on that same fixture vs. the Phase 0 baseline.** This is the go/no-go for the
whole project — if the inline TLB doesn't pay off, stop here rather than proceeding.

**Phase 3 — Flags, branches, control flow.** Lazy-flag plumbing, `fillFlags`, `getCondition`,
`IfCondition`, `blockNext1/2`, `blockExit`, `jumpEip`; port `getJumpConditionFromOp` 64-bit targets.
*Gate:* `testJmp/testLoop/testSet/testCMov/testCmp` green; control-flow-heavy fixture matches interpreter;
speedup >2× on Phase-2 fixture retained (no regression from flag materialisation).

**Phase 4 — Block cache, invalidation, merging.** `jit.cpp` block cache on `BBlock`, `pfnJitCode` slot,
`wasmTable` alloc/free, `WasmJitBatchPolicy` (start with only `BlockCount`/`ByteCount` reasons) and
`wasmModuleMerger` standalone mode.
*Gate:* long-running fixture shows cache hit ratio >90% after warmup, memory growth flat over 10 min
(no table leak), and `cancelMemory` correctly invalidates across an `mmap`/`munmap` fixture.

**Phase 5 — Full op coverage.** `mul/div/imul/shld/shrd/rcl/rcr`, `setcc`/`cmov`, string ops, `push/pop`,
segments, FPU via shared `JitFPU`, then MMX/SSE (V128 locals — expect `emulateSingleOp` fallback first).
*Gate:* full test suite green; **Cinebench end-to-end speedup ≥3× vs. interpreter**; no op falls back to
`emulateSingleOp` more than 5% of dynamic retired instructions (measured by the existing
`BOXEDWINE_WASM_JIT_PROFILE` per-helper counters).

**Phase 6 — Offline cache pipeline (optional).** `boxedwine-wasm-jit-cache-pipeline.mjs` `--flat` and
piped modes, AOT zip export, IndexedDB persistence, `binaryen_js.js` vendoring, `testWasmJitBatch` +
`testWasmJitModuleBroker`.
*Gate:* recorded zip replayed into a second run reproduces identical output **and** measurably beats the
online-compiled cache; `-cache-verify-merged` passes on a merged zip.

**Phase 7 — Multi-threaded.** Share `wasmTable` across emscripten workers; per-activation relocation
safety under signal/scheduler nesting.
*Gate:* `multiThreadedJit` build passes a threaded fixture with relocation params verified distinct
across concurrent activations (assert via instrumentation, not by inspection).

---

## 5. Open questions for the requester

- Is the target a **wasm32 + i64-semantics** build (portable, more work) or a **wasm memory64** build
  (simpler codegen, narrow browser support)? This decision alone swings Phase 1 by ~1,000 LOC and is the
  precondition for everything else.
- Should we build on `cpu64`'s `BBlock`/`BRec` IR (deviates from `DecodedOp`, smaller backend) or force
  `cpu64` onto `DecodedOp` (maximal PR reuse, larger Phase-1 bridge)? Recommend the former with a thin
  adapter.
- Is `patch.diff` already-applied work intended to stay, or was it staged for a different effort?
- Are the PR's new tests (`testWasmJitBatch`, `testWasmJitModuleBroker`) to be ported as-is, or
  rewritten against `cpu64`?


## 6. Decoder/cache framework status (committed on `lane-jit`)

The earlier lane called this framework "Phase 1". That label is separate
from the original Phase 1 in §4, which requires a wasm 64-bit value model
and its full execution gates. Completing the decoder/cache framework did
not complete that original milestone. See §7 for the current verified state.

**Scope delivered.** JIT decoder/cache framework for `CPU64`: a self-contained
x86-64 decoder + classifier (`Jit64Op` IR), a block cache keyed on
`startRip` + page generations, and a runtime flag — all behind `BW64_JIT=1`,
default behavior unchanged. CPU64 does not dispatch emitted wasm yet: a
"compiled block" in this framework is a validated + ranked copy of the decode plan with a per-record
fast/fallback dispatch plan. `jit64EmitPlanText()` serializes that plan in a
stable text form the phase-2 wasm emitter will consume.

**Files (all in the `lane-jit` worktree):**

| File | Role |
| --- | --- |
| `include/jit64.h` | Public API: `Jit64Op`/`Jit64Block`, `jit64DecodeOne`, `jit64Classify`, `jit64CompileStream`, `Jit64BlockCache`, `jit64Enabled()`, `jit64EmitPlanText` |
| `source/emulation/cpu/jit64.cpp` | Decoder (prefix/REX/ModRM/SIB scan), classifier, stream compiler, 512-slot open-addressed block cache |
| `source/emulation/cpu/tests/jit64_tests.cpp` | Native unit tests (`g++ -std=c++17 -DBOXEDWINE_GUEST_X64=1`); **113 passed, 0 failed** |
| `source/emulation/cpu/tests/profile_opcodes.py` | Profile evidence generator (capstone; 64-bit PEs only) |
| `scripts/build-jit-wasm.sh` | Native, emitted-module, and wasm execution gates; verified with the SDK at `/opt/emsdk` (see §7) |
| `include/cpu64.h` / `source/emulation/cpu/cpu64.cpp` | `CPU64::tryJitStep()` hook wired into `run()`/`runBounded()` ahead of `tryBlockStep()`; `Jit64State` owned per-CPU |
| `project/emscripten/makefile` | `EMULATION_SOURCES` prunes `source/emulation/cpu/tests/` (own `main()`) from the emcc glob; `jit64.cpp` auto-globbed, `BOXEDWINE_GUEST_X64`-gated |

**Design (per §3.1 "recommend the former with a thin adapter").** Built on
`cpu64`'s own `BBlock`/`BRec` IR, not the 32-bit `DecodedOp` pipeline.
`tryJitStep()` compiles the JIT plan for the block at RIP, then **validates it
against the interpreter's `buildBlock`** (record count + every instruction
length must agree — decoder-drift guard) and executes via the interpreter's
`execBlock`, so semantics are bit-identical by construction. **Whole-block
fallback rule:** if any record in the block classifies fallback (LOCK/REP/
`66h` prefixes, 8-bit ALU forms, SYSCALL, unknown opcodes), the entire block
stays on the interpreter path. Cache validity reuses the `BOXEDWINE_BLOCK_EXEC`
page-generation contract (`blockPageRegister`/`blockPageGenOf`).

**Top-20 opcode profile (evidence).** Static disassembly of 83,376
instructions from real x86-64 guest binaries in this repo —
`tools/rootfs64/games/doom.exe` (59.9k), `tetris`/`snake`, the `gltest` suite
(`glcube`/`gltri`/`msgloop`/`sleepprobe`), `tools/dxvk/tri9/tri9.exe` — via
`profile_opcodes.py` (capstone linear sweep; opcode counted *after*
legacy/REX prefixes; NOP padding `90`/`0F1F` — 8,384 insns — excluded from
ranking; PUSH/POP register rows and `MOV r,imm` grouped as classes
`50..57`/`58..5F`/`B8..BF`). `HxD64.exe` was excluded: its `.text` is
dominated by zero padding / non-code patterns a linear sweep cannot
distinguish (26% decoded as opcode `00`). doom.exe alone yields 59.9k insns
vs the 62.4k cited in the original analysis, corroborating the method.
Reproduced 2026-10-05 on the lane host (capstone 5.0.7).

Top-20 opcodes in the JIT fast set (share of all 83,376 instructions):

| # | opcode | share | # | opcode | share |
| --- | --- | --- | --- | --- | --- |
| 1 | `89` MOV r/m,r | 11.2% | 11 | `C1` SHIFT r/m,imm8 | 2.3% |
| 2 | `8B` MOV r,r/m | 10.1% | 12 | `E9` JMP rel32 | 2.2% |
| 3 | `83` ALU r/m,imm8 | 6.7% | 13 | `74` JZ rel8 | 2.0% |
| 4 | `E8` CALL rel32 | 6.0% | 14 | `39` CMP r/m,r | 2.0% |
| 5 | `8D` LEA | 5.4% | 15 | `0FB6` MOVZX r,r/m8 | 1.9% |
| 6 | `58..5F` POP r64 | 3.6% | 16 | `C7` MOV r/m,imm32 | 1.8% |
| 7 | `B8..BF` MOV r,imm | 3.1% | 17 | `75` JNZ rel8 | 1.7% |
| 8 | `85` TEST r/m,r | 3.0% | 18 | `C3` RET | 1.7% |
| 9 | `50..57` PUSH r64 | 2.8% | 19 | `0F84` JZ rel32 | 1.2% |
| 10 | `31` XOR r/m,r | 2.4% | 20 | `01` ADD r/m,r | 1.2% |

The phase-1 fast set covers **80.2% of padding-excluded static
instructions** (top-20 rows above: 72.2% of all 83,376 instructions).
By raw byte rank, positions 19–20 are `FF` (INC/DEC/indirect call, 1.7%) and
8-bit `00` (1.4%), which are correctly *not* in the fast set; `0F84` and `01`
are the next-fastest fast opcodes, hence table rows 19/20. `0F85`/`29`
remain fast in the classifier but fell just outside this corpus's top-20, so
they carry no coverage-table row. The authoritative table is
`jit64CoveredOpcodes()` in `source/emulation/cpu/jit64.cpp`; the unit test
asserts its rank order against this profile.

**Verification (all on the lane host):**

```
g++ -std=c++17 -Wall -Wextra -DBOXEDWINE_GUEST_X64=1 -Iinclude \
    source/emulation/cpu/jit64.cpp source/emulation/cpu/tests/jit64_tests.cpp \
    -o /tmp/jit64test/jit64_tests && /tmp/jit64test/jit64_tests
# -> 113 passed, 0 failed, zero warnings
python3 source/emulation/cpu/tests/profile_opcodes.py <64-bit exe>...
```

**Still deferred:** broader wasm opcode emission, runtime module
instantiation/table-index glue, the inline-TLB fast path, and interpreter/JIT
timing gates on the selftest/runelf fixtures. The initial standalone MOV
emitter and verified execution gates are described below.

## 7. Verified continuation, 2026-10-05

The build driver now runs the real JIT framework under Emscripten 6.0.9
and Node 22.22.3. Earlier driver settings omitted `BOXEDWINE_BLOCK_EXEC`
and `BOXEDWINE_BLOCK_CACHE_INFRA`; with those settings, `BW64_JIT=1`
could pass an output comparison while the JIT never ran. The corrected
driver uses an isolated build directory, enables both macros, limits make
to two jobs by default, handles the repository's ESM/CommonJS boundary,
and forwards only the two JIT test controls into the guest environment.
The JIT run must report nonzero executed blocks and instructions.

Two execution regressions were demonstrated failing before their fixes:
`runBounded(1)` ran extra records from a decoded block, and a store patching
a later instruction in the same block still ran the old immediate. Block
execution now honors the remaining instruction budget and rechecks page
generations after each record. The full wasm smoke suite passes in both
modes: **258 passed, 0 failed**, with **30 JIT blocks / 76 instructions**
observed in the shared program cases. Test output matches byte-for-byte
after removing the one JIT statistics line. The native decoder/cache suite
also passes **113/113**. This is correctness evidence, not a speedup result.

`include/jit64wasm.h` and `source/emulation/cpu/jit64wasm.cpp` add the first
standalone binary emitter. Its `execute(state_ptr: i32)` imports
`env.memory`; its staging ABI contains sixteen i64 GPRs, an i64 guest RIP,
and preserved flags. The ABI is separate from CPU64's C++ object layout.
The supported subset is register-direct MOV and immediate MOV at 32/64-bit
operand widths. The emitter rejects the entire block for memory operands,
MOVZX, flag-changing operations, unsupported prefixes, and other kinds.
CPU64 still executes through `execBlock`; it does not instantiate or call
these modules yet. No wasm table ownership or threaded imports are installed.

The emitted modules pass **22 Node validation/execution tests**, covering
all sixteen registers, high halves, signed LEB boundary values, both
register MOV encodings, 32-bit zero extension, C7 sign extension, RIP
wraparound, flags preservation, and whole-block rejection. The RED emitter
stub produced 15 positive-case failures; the implemented emitter passes
all 22. The binary encoding uses the baseline instruction forms in the
[WebAssembly instruction specification](https://webassembly.github.io/spec/core/binary/instructions.html).

Run the gates with:

```sh
source /opt/emsdk/emsdk_env.sh
JOBS=2 BUILD_TMP=/tmp/bw64-jit-build bash scripts/build-jit-wasm.sh
# --selftest-only runs native decoder tests and standalone wasm-module tests
# without rebuilding the Emscripten host.
```

Progress against the **original** milestones is estimated by delivered
components, not elapsed time. None of the original milestone gates is
complete yet:

| Original milestone | Estimate | Remaining gate / major missing component |
| --- | ---: | --- |
| 0: baseline and scaffolding | ~50% | Cinebench baseline, original on/off configuration gate, and vendored Binaryen validation |
| 1: 64-bit value model | ~15% | CPU64 runtime state bridge/helper mode, full wasm arithmetic suites and ELF equivalence |
| 2: arithmetic and inline TLB | ~5% | Arithmetic/guest-memory codegen, helpers/TLB and measured >1.5× fixture speedup |
| 3: flags and control flow | 0% | Wasm flags/branches and the original correctness/speed gates |
| 4: cache, invalidation and merging | ~15% | Wasm table ownership, module merging/batch policy and sustained hit/leak/invalidation gates |
| 5: full op coverage | 0% | Wasm coverage beyond register MOV and the Cinebench/dynamic-fallback gates |
| 6: offline cache pipeline | 0% | Recording, persistence, replay and merged-cache validation |
| 7: multithreaded JIT | 0% | Shared table/activation ownership and concurrent relocation fixture |
