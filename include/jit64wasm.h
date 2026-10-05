// Copyright (C) 2026 The BoxedWine Team. GPL-2.0-or-later.
#ifndef BOXEDWINE_JIT64_WASM_H
#define BOXEDWINE_JIT64_WASM_H

#include "jit64.h"

// Staging ABI for a wasm32 host with 64-bit guest values. This is separate
// from CPU64's object layout; a future runtime bridge must copy state in/out.
struct Jit64WasmState {
    U64 gpr[16];
    U64 rip;
    U32 rflags;
    U32 reserved;
};
static_assert(offsetof(Jit64WasmState, rip) == 128, "wasm guest RIP offset");
static_assert(offsetof(Jit64WasmState, rflags) == 136, "wasm guest flags offset");
static_assert(sizeof(Jit64WasmState) == 144, "wasm guest state size");

// Emit execute(state_ptr: i32) importing env.memory. Initially supports only
// register-direct 32/64-bit MOV and immediate MOV, with 16 i64 GPR locals.
// Advances RIP, zero-extends 32-bit destinations, and preserves flags.
// Rejects the entire block for any unsupported op/operand. On rejection,
// clears output. No CPU64 dispatch or wasm-table ownership is installed yet.
bool jit64EmitWasm(const Jit64Block& block, std::vector<U8>& output);

#endif
