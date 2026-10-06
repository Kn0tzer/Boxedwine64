// Copyright (C) 2026 The BoxedWine Team. GPL-2.0-or-later.
#ifndef BOXEDWINE_JIT64_WASM_H
#define BOXEDWINE_JIT64_WASM_H

#include "jit64.h"

// Staging ABI for a wasm32 host with 64-bit guest values. This is separate
// from CPU64's object layout; the bridge below copies state in/out.
struct Jit64WasmState {
    U64 gpr[16];
    U64 rip;
    U32 rflags;
    U32 reserved;
    U64 memScratch; // 8-byte scratch for the memRead import's result
};
static_assert(offsetof(Jit64WasmState, rip) == 128, "wasm guest RIP offset");
static_assert(offsetof(Jit64WasmState, rflags) == 136, "wasm guest flags offset");
static_assert(offsetof(Jit64WasmState, memScratch) == 144, "wasm mem scratch offset");
static_assert(sizeof(Jit64WasmState) == 152, "wasm guest state size");

// State bridge (non-optimizing plumbing): copy a plain GPR/RIP/RFLAGS triple
// into the staging struct before execute(), and back out after. Keeps the
// header dependency-free (no cpu64.h/SDL) so the native harness can test it;
// cpu64.cpp will pass cpu->reg[i].u64 / cpu->rip / cpu->rflags once the
// runtime instantiation glue exists.
void jit64WasmStateInit(Jit64WasmState& state, const U64 gpr[16], U64 rip, U32 rflags);
void jit64WasmStateRead(const Jit64WasmState& state, U64 gpr[16], U64& rip, U32& rflags);

// Emit execute(state_ptr: i32) importing env.memory. Supports register-direct
// 32/64-bit MOV and immediate MOV, plus register-direct ALU (ADD/ADC/SUB/
// SBB/AND/OR/XOR/CMP/TEST, /0../7, r/m-r, r-r/m, r/m-imm and acc-imm forms)
// with eager, interpreter-exact flag computation (CF/PF/AF/ZF/SF/OF; other
// RFLAGS bits preserved), register-direct SHL/SHR/SAR and ROL/ROR/RCL/RCR
// (0xC1 /0../7, interpreter-exact flags; rotates write only CF/OF), and
// register-direct two-operand IMUL (0F AF, CF/OF set iff the signed result
// does not fit). Advances RIP, zero-extends 32-bit destinations (including
// on shift/rotate-by-0, matching the interpreter). Rejects the entire block
// for any unsupported op/operand. On rejection, clears output.
bool jit64EmitWasm(const Jit64Block& block, std::vector<U8>& output);

#ifdef JIT64_GEN_VERIFY
// Byte-identical migration test hooks (defined in jit64wasm.cpp).
// jit64EmitOld emits one op with the hand-written emitter, jit64EmitNew
// with the table-generated one. Return 0xFE when the kind has no emitter
// in that set (the test skips such ops).
U32 jit64EmitOld(std::vector<U8>& body, const Jit64Op& op);
U32 jit64EmitNew(std::vector<U8>& body, const Jit64Op& op);
#endif

// Runtime module instantiation: the table-index glue (cf. PR #151's
// boxedwine_wasm_instantiate_runtime_batch, single-module form; batching and
// merging remain phase-4 work). Instantiates an emitted module against the
// host's WebAssembly.Memory and returns a table index (>= 0), or -1 on
// failure. jit64WasmCall invokes the table entry's execute(statePtr), where
// statePtr is a wasm32 host address of a Jit64WasmState in linear memory.
// jit64WasmRelease frees a table slot (slots are reused). Under
// __EMSCRIPTEN__ these are implemented with synchronous WebAssembly.Module /
// WebAssembly.Instance in source/emulation/cpu/jit64wasm_runtime.cpp; on
// native builds they are inline no-ops (instantiate returns -1) so cpu64.cpp
// links without the runtime TU.
class KMemory64; // forward: the header stays dependency-free

#ifdef __EMSCRIPTEN__
int jit64WasmInstantiate(const U8* bytes, U32 byteCount);
void jit64WasmCall(int tableIndex, U32 statePtr);
void jit64WasmRelease(int tableIndex);
// Routes the emitted module's memRead/memWrite imports at `mem` for the
// duration of the next synchronous jit64WasmCall. tryWasmExec sets this to
// its own address space before the call and clears it after. Thread-local:
// wasm execution never yields, so the import always observes the setter's
// thread.
void jit64WasmSetActiveMem(KMemory64* mem);
inline bool jit64WasmAvailable() { return true; }
#else
inline int jit64WasmInstantiate(const U8*, U32) { return -1; }
inline void jit64WasmCall(int, U32) {}
inline void jit64WasmRelease(int) {}
inline void jit64WasmSetActiveMem(KMemory64*) {}
inline bool jit64WasmAvailable() { return false; }
#endif

#endif
