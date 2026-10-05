// Copyright (C) 2026 The BoxedWine Team. GPL-2.0-or-later.
#include "jit64wasm.h"

#ifdef BOXEDWINE_GUEST_X64
namespace {
using Bytes = std::vector<U8>;

void uleb(Bytes& bytes, U32 value) {
    do {
        U8 part = value & 0x7F;
        value >>= 7;
        bytes.push_back(part | (value ? 0x80 : 0));
    } while (value);
}

// Interpret the U64 bit pattern as signed, without implementation-defined
// conversion to signed or right-shifting a negative C++ integer.
void i64Const(Bytes& bytes, U64 value) {
    bytes.push_back(0x42);
    const bool negative = (value >> 63) != 0;
    for (;;) {
        U8 part = value & 0x7F;
        value >>= 7;
        if (negative) value |= 0xFE00000000000000ULL;
        bool last = (value == 0 && !(part & 0x40)) ||
                    (value == ~0ULL && (part & 0x40));
        bytes.push_back(part | (last ? 0 : 0x80));
        if (last) return;
    }
}

void local(Bytes& bytes, U8 opcode, U32 index) {
    bytes.push_back(opcode);
    uleb(bytes, index);
}

void memoryOp(Bytes& bytes, U8 opcode, U32 offset) {
    bytes.push_back(opcode);
    uleb(bytes, 3); // eight-byte alignment
    uleb(bytes, offset);
}

void section(Bytes& module, U8 id, const Bytes& contents) {
    module.push_back(id);
    uleb(module, (U32)contents.size());
    module.insert(module.end(), contents.begin(), contents.end());
}
} // namespace

bool jit64EmitWasm(const Jit64Block& block, std::vector<U8>& output) {
    output.clear();
    if (block.ops.empty() || block.ops.size() > 24) return false;
    U32 byteCount = 0;
    for (const auto& op : block.ops) {
        if (op.plan != JIT64_FAST || op.isMem || op.sub != 0 ||
            (op.size != 4 && op.size != 8) || !op.len || op.len > 15) return false;
        switch (op.kind) {
        case J64_MOV_R_IMM:
            if (op.regField >= 16) return false;
            break;
        case J64_MOV_RM_IMM:
            if (op.rmIndex >= 16) return false;
            break;
        case J64_MOV_RM_R:
        case J64_MOV_R_RM:
            if (op.regField >= 16 || op.rmIndex >= 16) return false;
            break;
        default:
            return false; // including MOVZX, NOP aliases and all control flow
        }
        byteCount += op.len;
    }

    // Param local 0 is the wasm32 host pointer. Locals 1..16 are i64 guest
    // GPRs and local 17 is the i64 guest RIP, never a wasm host address.
    Bytes body = {1, 17, 0x7E}; // one local declaration group of 17 i64 locals
    for (U32 reg = 0; reg < 16; reg++) {
        local(body, 0x20, 0);
        memoryOp(body, 0x29, reg * 8); // i64.load
        local(body, 0x21, reg + 1);
    }
    local(body, 0x20, 0);
    memoryOp(body, 0x29, (U32)offsetof(Jit64WasmState, rip));
    local(body, 0x21, 17);

    for (const auto& op : block.ops) {
        U32 dest = op.kind == J64_MOV_RM_R || op.kind == J64_MOV_RM_IMM ? op.rmIndex : op.regField;
        if (op.kind == J64_MOV_R_IMM || op.kind == J64_MOV_RM_IMM) {
            i64Const(body, op.size == 4 ? op.imm & 0xFFFFFFFFULL : op.imm);
        } else {
            U32 src = op.kind == J64_MOV_RM_R ? op.regField : op.rmIndex;
            local(body, 0x20, src + 1);
            if (op.size == 4) {
                i64Const(body, 0xFFFFFFFFULL);
                body.push_back(0x83); // i64.and, x86 32-bit zero extension
            }
        }
        local(body, 0x21, dest + 1);
    }

    for (U32 reg = 0; reg < 16; reg++) {
        local(body, 0x20, 0);
        local(body, 0x20, reg + 1);
        memoryOp(body, 0x37, reg * 8); // i64.store
    }
    local(body, 0x20, 0);
    local(body, 0x20, 17);
    i64Const(body, byteCount);
    body.push_back(0x7C); // i64.add, modulo 64 bits
    memoryOp(body, 0x37, (U32)offsetof(Jit64WasmState, rip));
    body.push_back(0x0B); // end execute

    Bytes module = {0, 0x61, 0x73, 0x6D, 1, 0, 0, 0};
    section(module, 1, {1, 0x60, 1, 0x7F, 0}); // (i32) -> ()
    section(module, 2, {1, 3, 'e', 'n', 'v', 6, 'm', 'e', 'm', 'o', 'r', 'y', 2, 0, 1});
    section(module, 3, {1, 0}); // one function, type 0
    section(module, 7, {1, 7, 'e', 'x', 'e', 'c', 'u', 't', 'e', 0, 0});
    Bytes code = {1};
    uleb(code, (U32)body.size());
    code.insert(code.end(), body.begin(), body.end());
    section(module, 10, code);
    output.swap(module);
    return true;
}
#endif
