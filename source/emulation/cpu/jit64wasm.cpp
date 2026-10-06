// Copyright (C) 2026 The BoxedWine Team. GPL-2.0-or-later.
#include "jit64wasm.h"

#ifdef BOXEDWINE_GUEST_X64
// Forward declarations for the global memory helpers, defined after the
// anonymous namespace below (they wrap the env.memRead/memWrite imports).
// The anonymous-namespace ALU emitter calls them for memory-operand ALU.
void emitMemRead(std::vector<U8>& body, U32 addrLocal, U32 size);
void emitMemWrite(std::vector<U8>& body, U32 addrLocal, U32 valLocal, U32 size);

namespace {
using Bytes = std::vector<U8>;

void uleb(Bytes& bytes, U32 value) {
    do {
        U8 part = value & 0x7F;
        value >>= 7;
        bytes.push_back(part | (value ? 0x80 : 0));
    } while (value);
}

void i32Const(Bytes& bytes, U32 value) {
    bytes.push_back(0x41); // i32.const (signed LEB128)
    const bool negative = (value >> 31) != 0;
    for (;;) {
        U8 part = value & 0x7F;
        value >>= 7;
        if (negative) value |= 0xFE000000u;
        bool last = (value == 0 && !(part & 0x40)) ||
                    (value == ~0u && (part & 0x40));
        bytes.push_back(part | (last ? 0 : 0x80));
        if (last) return;
    }
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

void memoryOp(Bytes& bytes, U8 opcode, U32 align, U32 offset) {
    bytes.push_back(opcode);
    uleb(bytes, align);
    uleb(bytes, offset);
}

void section(Bytes& module, U8 id, const Bytes& contents) {
    module.push_back(id);
    uleb(module, (U32)contents.size());
    module.insert(module.end(), contents.begin(), contents.end());
}

// RFLAGS bits written by ALU ops (same numeric layout as X64_* in cpu64.h).
constexpr U32 F_CF = 0, F_PF = 2, F_AF = 4, F_ZF = 6, F_SF = 7, F_OF = 11;
constexpr U32 F_ALU_MASK = (1u << F_CF) | (1u << F_PF) | (1u << F_AF) |
                          (1u << F_ZF) | (1u << F_SF) | (1u << F_OF); // 0x8D5
// Shift flag bits written by SHL/SHR/SAR: CF/PF/ZF/SF/OF. AF is NOT touched
// by shifts (unlike ALU ops), so it stays out of the merge mask.
constexpr U32 F_SHIFT_MASK = (1u << F_CF) | (1u << F_PF) |
                             (1u << F_ZF) | (1u << F_SF) | (1u << F_OF); // 0x8C5
// Rotates and IMUL write only CF and OF. The interpreter clears just those
// two (doShift for sub <= 3 skips setSZP; IMUL leaves SZP/AF undefined), so
// PF/ZF/SF/AF and every other RFLAGS bit are preserved.
constexpr U32 F_CFOF_MASK = (1u << F_CF) | (1u << F_OF); // 0x801

// Module locals: 0 = state ptr param, 1..16 = i64 GPRs, 17 = i64 RIP,
// 18 = i32 RFLAGS, 19..25 = i64 scratch (A, B, R, flag bits, parity/carry
// temp, plus T1/T2 for the 64-bit IMUL 128-bit product limbs), 26..27 =
// i64 string-op scratch (STEP: DF-selected +/-size; CNT: REP counter).
constexpr U32 L_RFLAGS = 18, L_A = 19, L_B = 20, L_R = 21, L_F = 22, L_P = 23;
constexpr U32 L_T1 = 24, L_T2 = 25, L_STEP = 26, L_CNT = 27;
// Function indices in the emitted module: the two mem imports first, then
// the defined execute().
constexpr U32 F_MEMREAD = 0, F_MEMWRITE = 1;

// Operand-width helpers (1/2/4/8 bytes).
U64 widthMask(U8 size) {
    return size == 1 ? 0xFFULL : size == 2 ? 0xFFFFULL :
           size == 4 ? 0xFFFFFFFFULL : 0xFFFFFFFFFFFFFFFFULL;
}
U64 widthSB(U8 size) {
    return (U64)1 << (size * 8 - 1);
}

// Resolve an 8-bit register index to (physical GPR, shift) per the x86-64
// high-byte rule: without any REX prefix, indices 4..7 name AH/CH/DH/BH
// (bits 8-15 of regs 0..3); with any REX they name SPL/BPL/SIL/DIL (the
// low bytes of regs 4..7). Mirrors CPU64::readReg8/writeReg8.
void byteRegParts(const Jit64Op& op, U32 idx, U32& physReg, U32& shift) {
    if (!op.rexPresent && idx >= 4 && idx <= 7) {
        physReg = idx - 4; shift = 8;
    } else {
        physReg = idx; shift = 0;
    }
}

// Read an 8-bit register into destLocal as i64 0..255.
void emitReadByte(Bytes& body, const Jit64Op& op, U32 idx, U32 destLocal) {
    U32 phys, sh;
    byteRegParts(op, idx, phys, sh);
    local(body, 0x20, phys + 1);
    if (sh) {
        i64Const(body, sh);
        body.push_back(0x88); // i64.shr_u
    }
    i64Const(body, 0xFF);
    body.push_back(0x83); // i64.and
    local(body, 0x21, destLocal);
}

// Write the low 8 bits of srcLocal into an 8-bit register (RMW on the GPR).
void emitWriteByte(Bytes& body, const Jit64Op& op, U32 idx, U32 srcLocal) {
    U32 phys, sh;
    byteRegParts(op, idx, phys, sh);
    local(body, 0x20, phys + 1);
    i64Const(body, ~(0xFFULL << sh));
    body.push_back(0x83); // i64.and (clear the target byte)
    local(body, 0x20, srcLocal);
    i64Const(body, 0xFF);
    body.push_back(0x83); // i64.and
    if (sh) {
        i64Const(body, sh);
        body.push_back(0x86); // i64.shl
    }
    body.push_back(0x84); // i64.or
    local(body, 0x21, phys + 1);
}

// Read a 16-bit register into destLocal as i64 0..65535.
void emitReadWord(Bytes& body, U32 idx, U32 destLocal) {
    local(body, 0x20, idx + 1);
    i64Const(body, 0xFFFFULL);
    body.push_back(0x83); // i64.and
    local(body, 0x21, destLocal);
}

// Write the low 16 bits of srcLocal into a 16-bit register (upper 48 kept).
void emitWriteWord(Bytes& body, U32 idx, U32 srcLocal) {
    local(body, 0x20, idx + 1);
    i64Const(body, 0xFFFFFFFFFFFF0000ULL);
    body.push_back(0x83); // i64.and
    local(body, 0x20, srcLocal);
    i64Const(body, 0xFFFFULL);
    body.push_back(0x83); // i64.and
    body.push_back(0x84); // i64.or
    local(body, 0x21, idx + 1);
}

// Sign-extend the low `size` bytes of the stack-top i64 to 64 bits.
void emitSext(Bytes& body, U8 size) {
    if (size == 8) return;
    U32 sh = 64 - size * 8;
    i64Const(body, sh);
    body.push_back(0x86); // i64.shl
    i64Const(body, sh);
    body.push_back(0x87); // i64.shr_s
}

// OR the stack-top 0/1 value, shifted left by `shift`, into L_F. The
// value comes from a comparison/test operator, which yields i32.
void orFlagBit(Bytes& body, U32 shift) {
    body.push_back(0xAD); // i64.extend_i32_u
    if (shift) {
        i64Const(body, shift);
        body.push_back(0x86); // i64.shl
    }
    local(body, 0x20, L_F);
    body.push_back(0x84); // i64.or
    local(body, 0x21, L_F);
}

// Compute the six ALU flag bits into L_F, then merge into L_RFLAGS while
// preserving the other RFLAGS bits. L_A/L_B/L_R hold width-masked operand
// values; sb is the width sign bit. Mirrors cpu64.cpp flagsAdd/flagsSub/
// flagsLogic exactly: CF/OF/AF formulas, SZP on the masked result, and AF
// cleared for logic ops.
void emitFlags(Bytes& body, U8 sub, U64 sb, bool isLogic) {
    const bool isAdd = !isLogic && (sub == 0 || sub == 2);
    const bool isSub = !isLogic && (sub == 3 || sub == 5 || sub == 7);
    i64Const(body, 0);
    local(body, 0x21, L_F);
    if (isAdd || isSub) {
        // CF: ADD/ADC: R <u A; SUB/SBB/CMP: A <u B.
        local(body, 0x20, isAdd ? L_R : L_A);
        local(body, 0x20, isAdd ? L_A : L_B);
        body.push_back(0x54); // i64.lt_u
        orFlagBit(body, F_CF);
        // OF: ADD: (~(A^B) & (A^R)); SUB: ((A^B) & (A^R)); tested at sb.
        local(body, 0x20, L_A);
        local(body, 0x20, L_B);
        body.push_back(0x85); // i64.xor
        if (isAdd) {
            i64Const(body, ~0ULL);
            body.push_back(0x85); // i64.xor -> ~(A^B)
        }
        local(body, 0x20, L_A);
        local(body, 0x20, L_R);
        body.push_back(0x85); // i64.xor -> A^R
        body.push_back(0x83); // i64.and
        i64Const(body, sb);
        body.push_back(0x83); // i64.and
        i64Const(body, 0);
        body.push_back(0x52); // i64.ne
        orFlagBit(body, F_OF);
        // AF: ((A^B^R) & 0x10) != 0.
        local(body, 0x20, L_A);
        local(body, 0x20, L_B);
        body.push_back(0x85);
        local(body, 0x20, L_R);
        body.push_back(0x85);
        i64Const(body, 0x10);
        body.push_back(0x83);
        i64Const(body, 0);
        body.push_back(0x52);
        orFlagBit(body, F_AF);
    }
    // ZF.
    local(body, 0x20, L_R);
    body.push_back(0x50); // i64.eqz
    orFlagBit(body, F_ZF);
    // SF.
    local(body, 0x20, L_R);
    i64Const(body, sb);
    body.push_back(0x83);
    i64Const(body, 0);
    body.push_back(0x52);
    orFlagBit(body, F_SF);
    // PF: even parity of the low byte; PF = ((folded & 1) ^ 1).
    local(body, 0x20, L_R);
    i64Const(body, 0xFF);
    body.push_back(0x83);
    local(body, 0x21, L_P);
    const U32 shifts[] = {4, 2, 1};
    for (U32 s : shifts) {
        local(body, 0x20, L_P);
        local(body, 0x20, L_P);
        i64Const(body, s);
        body.push_back(0x88); // i64.shr_u
        body.push_back(0x85); // i64.xor
        local(body, 0x21, L_P);
    }
    local(body, 0x20, L_P);
    i64Const(body, 1);
    body.push_back(0x83); // & 1
    i64Const(body, 1);
    body.push_back(0x85); // ^ 1
    body.push_back(0xA7); // i32.wrap_i64: test results are i32
    orFlagBit(body, F_PF);
    // rflags = ((rflags | MASK) ^ MASK) | (i32)L_F  ==  (rflags & ~MASK) | L_F.
    local(body, 0x20, L_RFLAGS);
    i32Const(body, F_ALU_MASK);
    body.push_back(0x72); // i32.or
    i32Const(body, F_ALU_MASK);
    body.push_back(0x73); // i32.xor
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or
    local(body, 0x21, L_RFLAGS);
}

// Read a width-masked operand from GPR idx into destLocal.
void emitReadOperand(Bytes& body, const Jit64Op& op, U32 idx, U32 destLocal) {
    if (op.size == 1) emitReadByte(body, op, idx, destLocal);
    else if (op.size == 2) emitReadWord(body, idx, destLocal);
    else {
        local(body, 0x20, idx + 1);
        if (op.size == 4) {
            i64Const(body, 0xFFFFFFFFULL);
            body.push_back(0x83); // i64.and
        }
        local(body, 0x21, destLocal);
    }
}

// Fold the incoming carry (CF as 0/1) into L_B for ADC/SBB, width-masked.
// L_B must already hold the width-masked rhs.
void emitAluCarryFold(Bytes& body, U64 mask) {
    local(body, 0x20, L_B);
    local(body, 0x20, L_RFLAGS);
    i32Const(body, 1);
    body.push_back(0x71); // i32.and -> incoming CF as 0/1
    body.push_back(0xAD); // i64.extend_i32_u
    body.push_back(0x7C); // i64.add
    i64Const(body, mask);
    body.push_back(0x83); // width-mask the rhs+carry
    local(body, 0x21, L_B);
}

// ALU compute core shared by the register and memory paths: L_A/L_B hold
// width-masked operands on entry; computes L_R = L_A <effSub> L_B
// (width-masked) and emits the flags. Mirrors cpu64.cpp runAlu.
void emitAluCompute(Bytes& body, U8 effSub, bool isLogic, U64 mask, U64 sb) {
    local(body, 0x20, L_A);
    local(body, 0x20, L_B);
    switch (effSub) {
    case 0:
    case 2: body.push_back(0x7C); break; // i64.add
    case 3:
    case 5:
    case 7: body.push_back(0x7D); break; // i64.sub
    case 4: body.push_back(0x83); break; // i64.and
    case 1: body.push_back(0x84); break; // i64.or
    case 6: body.push_back(0x85); break; // i64.xor
    default: break; // unreachable: filtered by the acceptance check
    }
    i64Const(body, mask);
    body.push_back(0x83);
    local(body, 0x21, L_R);
    emitFlags(body, effSub, sb, isLogic);
}

// Compute the guest effective address described by op.ea into L_T1.
// Mirrors CPU64::decodeModRM (the decoder precomputed the fields; see
// tasks/jit-port-plan.md section 13). All i64 math wraps mod 2^64, exactly
// like the interpreter's U64 arithmetic.
void emitEA(Bytes& body, const Jit64Op& op) {
    const Jit64MemEA& ea = op.ea;
    if (ea.ripRel) {
        // Decode-time constant (no 0x67 mask, no seg: interpreter quirk).
        i64Const(body, ea.ripRelTarget);
        local(body, 0x21, L_T1);
        return;
    }
    if (ea.baseReg == 0xFF) i64Const(body, 0);
    else local(body, 0x20, ea.baseReg + 1);
    if (ea.idxReg != 0xFF) {
        local(body, 0x20, ea.idxReg + 1);
        if (ea.scale) {
            i64Const(body, ea.scale);
            body.push_back(0x86); // i64.shl (0x7E is i64.mul!)
        }
        body.push_back(0x7C); // i64.add
    }
    if (ea.disp != 0) {
        i64Const(body, (U64)ea.disp); // signed LEB: sign-extended disp
        body.push_back(0x7C); // i64.add
    }
    if (ea.asize32) {
        i64Const(body, 0xFFFFFFFFULL);
        body.push_back(0x83); // i64.and: 0x67 masks after base+idx+disp wrap
    }
    local(body, 0x21, L_T1);
}



// Emit one register-direct IMUL r, r/m (0F AF). Returns the destination GPR
// index. Mirrors cpu64.cpp BK_IMUL_R_RM exactly: the destination is the
// ModRM reg field and the source is the r/m register; both operands are
// sign-extended to 64 bits, the wrapped 64-bit product is stored
// (zero-extended for 32-bit), and CF/OF are set iff the signed result does
// not fit in the operand width. All other flags are preserved (SF/ZF/AF/PF
// Emit one register-direct MOVZX/MOVSX (0F B6/B7/BE/BF) or MOVSXD (0x63).
// sub: 0=zx8, 1=zx16, 2=sx8, 3=sx16, 4=sxd32. No flags affected. Returns
// the destination GPR index, or 0xFF when the write-back was done inline
// (16-bit RMW).
// Mirrors cpu64.cpp BK_MOVX: 16-bit dest preserves the upper 48 bits,

// Emit one register-direct one-operand IMUL (F6/F7 /5). Writes RDX:RAX
// (DX:AX / EDX:EAX / AX for 16/32/8-bit); the 8-bit form writes the full
// AX (setU16). CF/OF reflect signed overflow; other flags preserved.

// Emit one register-direct three-operand IMUL (69/6B): r = sext(src) * imm.
// Overflow iff the full product does not fit the width; CF/OF set.
// Returns the destination GPR index, or 0xFF when written inline (16-bit).

// Table-driven emitters, generated by scripts/gen-jit64.mjs from
// source/emulation/cpu/jit64table.mjs. Included inside the anonymous namespace
// so the generated functions can use the emission primitives above.
#include "jit64gen.inc"

} // namespace

#ifdef JIT64_GEN_VERIFY
// Test hooks for the table-driven emitter migration (see jit64table.mjs and
// tests/jit64_gen_tests.cpp). jit64EmitOld dispatches to the hand-written
// emitter for a kind, jit64EmitNew to the generated one. Both return 0xFE
// when the kind has no emitter in that set; the byte-identical test skips
// such ops.
U32 jit64EmitOld(std::vector<U8>& body, const Jit64Op& op) {
    (void)body;
    switch (op.kind) {
    case J64_ALU_RM_R:
    case J64_ALU_R_RM:
    case J64_ALU_RM_IMM:
    case J64_ALU_ACC_IMM:
    case J64_TEST_RM_R:
        // Both hand-written ALU emitters are gone (migrated to the
        // table-generated emitAluGen/emitAluMemGen).
        return 0xFE;
    case J64_SHIFT_IMM:
        return 0xFE; // migrated to emitShiftGen/emitRotateGen
    case J64_SHIFT_CL:
        return 0xFE; // migrated to emitShiftCLGen/emitRotateCLGen
    case J64_IMUL_R_RM:
    case J64_IMUL_1OP:
    case J64_IMUL_3OP:
        return 0xFE; // migrated to emitImulGen/emitImul1Gen/emitImul3Gen
    case J64_MOVX:
    case J64_STRING:
        return 0xFE; // migrated to emitMovxGen/emitStringGen
    default:
        return 0xFE;
    }
}
U32 jit64EmitNew(std::vector<U8>& body, const Jit64Op& op) {
    switch (op.kind) {
    case J64_ALU_RM_R:
    case J64_ALU_R_RM:
    case J64_ALU_RM_IMM:
    case J64_ALU_ACC_IMM:
    case J64_TEST_RM_R:
        if (op.isMem) return emitAluMemGen(body, op);
        return emitAluGen(body, op);
    case J64_SHIFT_IMM:
        if (op.isMem)
            return op.sub <= 3 ? emitRotateMemGen(body, op) : emitShiftMemGen(body, op);
        return op.sub <= 3 ? emitRotateGen(body, op) : emitShiftGen(body, op);
    case J64_SHIFT_CL:
        if (op.isMem)
            return op.sub <= 3 ? emitRotateCLMemGen(body, op) : emitShiftCLMemGen(body, op);
        return op.sub <= 3 ? emitRotateCLGen(body, op) : emitShiftCLGen(body, op);
    case J64_IMUL_R_RM:
        return emitImulGen(body, op);
    case J64_IMUL_1OP:
        return emitImul1Gen(body, op);
    case J64_IMUL_3OP:
        return emitImul3Gen(body, op);
    case J64_MOVX:
        return emitMovxGen(body, op);
    case J64_STRING:
        return emitStringGen(body, op);
    case J64_LEA:
        return emitLeaGen(body, op);
    case J64_PUSH:
    case J64_POP:
        return emitStackGen(body, op);
    case J64_MOV_RM_R:
    case J64_MOV_R_RM:
        if (op.size == 1) return emitMov8Gen(body, op);
        return 0xFE; // 4/8-bit MOV keeps the hand-written emitter
    case J64_MOV_RM_IMM:
        // C6 (MOV r/m8, imm8): table-generated emitMovImm8Gen.
        // C7 (size 4/8) keeps the hand-written emitter.
        if (op.size == 1) return emitMovImm8Gen(body, op);
        return 0xFE;
    case J64_GRP3:
        return emitGrp3Gen(body, op);
    case J64_CBW:
        return emitCbwGen(body, op);
    case J64_CQO:
        return emitCqoGen(body, op);
    case J64_CMOV:
        return emitCmovGen(body, op);
    case J64_SETCC:
        return emitSetccGen(body, op);
    case J64_BT:
        return emitBtGen(body, op);
    default:
        return 0xFE;
    }
}
#endif

void jit64WasmStateInit(Jit64WasmState& state, const U64 gpr[16], U64 rip, U32 rflags) {
    for (U32 i = 0; i < 16; i++) state.gpr[i] = gpr[i];
    state.rip = rip;
    state.rflags = rflags;
    state.reserved = 0;
}

void jit64WasmStateRead(const Jit64WasmState& state, U64 gpr[16], U64& rip, U32& rflags) {
    for (U32 i = 0; i < 16; i++) gpr[i] = state.gpr[i];
    rip = state.rip;
    rflags = state.rflags;
}

// Emit a call to env.memRead(addrLocal, size): splits the i64 address to
// lo/hi i32s, passes the size and the memScratch address, then loads the
// 64-bit result into L_R. All import params are i32 (no BigInt dependence).
void emitMemRead(Bytes& body, U32 addrLocal, U32 size) {
    local(body, 0x20, addrLocal);
    body.push_back(0xA7); // i32.wrap_i64 (lo)
    local(body, 0x20, addrLocal);
    i64Const(body, 32);
    body.push_back(0x88); // i64.shr_u
    body.push_back(0xA7); // i32.wrap_i64 (hi)
    i32Const(body, size);
    local(body, 0x20, 0); // state ptr
    i32Const(body, (U32)offsetof(Jit64WasmState, memScratch));
    body.push_back(0x6A); // i32.add (retPtr)
    body.push_back(0x10); // call
    uleb(body, F_MEMREAD);
    local(body, 0x20, 0);
    memoryOp(body, 0x29, 3, (U32)offsetof(Jit64WasmState, memScratch)); // i64.load
    local(body, 0x21, L_R);
}

// Emit a call to env.memWrite(addrLocal, valLocal, size).
void emitMemWrite(Bytes& body, U32 addrLocal, U32 valLocal, U32 size) {
    local(body, 0x20, addrLocal);
    body.push_back(0xA7); // lo
    local(body, 0x20, addrLocal);
    i64Const(body, 32);
    body.push_back(0x88); // i64.shr_u
    body.push_back(0xA7); // hi
    i32Const(body, size);
    local(body, 0x20, valLocal);
    body.push_back(0xA7); // valLo
    local(body, 0x20, valLocal);
    i64Const(body, 32);
    body.push_back(0x88); // i64.shr_u
    body.push_back(0xA7); // valHi
    body.push_back(0x10); // call
    uleb(body, F_MEMWRITE);
}

// Emit one string op (MOVS/STOS/CMPS/SCAS). Returns 0xFF: RSI/RDI/RCX are
// updated in their locals and published by the epilogue's store-back.
// Mirrors CPU64::runStringOp exactly: DF (bit 10) selects the +/-size step,
// the effective address is masked to 32 bits under 0x67 but the register
// update is full 64-bit wrapping, REP takes its count from RCX (masked
// under 0x67), CMPS/SCAS set flags through the SUB path and honor
// REPE/REPNE early exit. Memory goes through the imported helpers so the

bool jit64EmitWasm(const Jit64Block& block, std::vector<U8>& output) {
    output.clear();
    if (block.ops.empty() || block.ops.size() > 24) return false;
    U32 byteCount = 0;
    for (const auto& op : block.ops) {
        if (op.plan != JIT64_FAST || !op.len || op.len > 15) return false;
        // Operand-width acceptance: ALU/shift/TEST/MOVX/IMUL kinds support
        // 1/2/4/8-byte operands (register-direct only); 8-bit MOV (88/8A)
        // joins them for size 1 (reg and mem forms); everything else
        // stays 4/8-byte.
        bool widthOk;
        switch (op.kind) {
        case J64_MOV_RM_R:
        case J64_MOV_R_RM:
        case J64_ALU_RM_R:
        case J64_ALU_R_RM:
        case J64_ALU_RM_IMM:
        case J64_ALU_ACC_IMM:
        case J64_TEST_RM_R:
        case J64_SHIFT_IMM:
        case J64_SHIFT_CL:
        case J64_MOVX:
        case J64_IMUL_R_RM:
        case J64_IMUL_1OP:
        case J64_IMUL_3OP:
        case J64_GRP3:
            widthOk = (op.size == 1 || op.size == 2 || op.size == 4 || op.size == 8);
            break;
        case J64_CBW:
            // CBW/CWDE/CDQE: 16/32/64-bit all valid.
            widthOk = (op.size == 2 || op.size == 4 || op.size == 8);
            break;
        case J64_CQO:
            // CWD/CDQ/CQO: 16/32/64-bit all valid.
            widthOk = (op.size == 2 || op.size == 4 || op.size == 8);
            break;
        case J64_CMOV:
            // CMOVcc: 16/32/64-bit all valid (never 8-bit).
            widthOk = (op.size == 2 || op.size == 4 || op.size == 8);
            break;
        case J64_SETCC:
            // SETcc: always 8-bit (size 1).
            widthOk = (op.size == 1);
            break;
        case J64_BT:
            // BT/BTS/BTR/BTC: 16/32/64-bit only (no 8-bit form).
            widthOk = (op.size == 2 || op.size == 4 || op.size == 8);
            break;
        case J64_MOV_RM_IMM:
            // C6 (MOV r/m8, imm8): size 1. C7: size 4/8 (size 2 is
            // decodeable but the decoder's length is wrong for 0x66;
            // the classifier leaves it fast, matching pre-C6 behavior).
            widthOk = (op.size == 1 || op.size == 4 || op.size == 8);
            break;
        default:
            widthOk = (op.size == 4 || op.size == 8);
            break;
        }
        if (op.kind == J64_STRING) {
            // String ops use 1/2/4/8-byte operands and touch memory through
            // the imported helpers (never raw linear memory).
            if (op.isMem || (op.size != 1 && op.size != 2 && op.size != 4 && op.size != 8)) return false;
            if (op.sub > 3) return false;
            if (op.rep != 0 && op.rep != 0xF2 && op.rep != 0xF3) return false;
        } else if (op.isMem) {
            // Memory operands are only accepted for ALU/TEST kinds, LEA,
            // PUSH/POP, 8-bit MOV (88/8A), F6/F7 group 3, shifts, and
            // CMOVcc; the EA fields are validated defensively (a malformed
            // EA degrades to whole-block rejection, never to a wrong
            // address). LEA names memory for its EA computation but never
            // dereferences it. 89/8B mem forms stay interpreter-fallback
            // (unchanged pre-existing behavior). CMOVcc's source is always
            // loaded (faults even if the condition is false), mirroring
            // dsp_38; the emitter does emitEA+emitMemRead before the
            // select, so fault ordering matches.
            bool memAlu = op.kind == J64_ALU_RM_R || op.kind == J64_ALU_R_RM ||
                          op.kind == J64_ALU_RM_IMM || op.kind == J64_TEST_RM_R;
            bool memLea = op.kind == J64_LEA;
            bool memStack = (op.kind == J64_PUSH && op.sub == 2) ||
                            (op.kind == J64_POP && op.sub == 1);
            bool memMov8 = (op.kind == J64_MOV_RM_R || op.kind == J64_MOV_R_RM) &&
                           op.size == 1;
            bool memGrp3 = op.kind == J64_GRP3;
            bool memShift = op.kind == J64_SHIFT_IMM || op.kind == J64_SHIFT_CL;
            bool memCmov = op.kind == J64_CMOV;
            bool memMovImm = op.kind == J64_MOV_RM_IMM && op.size == 1;
            bool memSetcc = op.kind == J64_SETCC;
            bool memBt = op.kind == J64_BT;
            if ((!memAlu && !memLea && !memStack && !memMov8 && !memGrp3 && !memShift && !memCmov && !memMovImm && !memSetcc && !memBt) || !widthOk) return false;
            if (op.ea.seg != 0) return false; // FS/GS: interpreter-only
            if (op.ea.baseReg != 0xFF && op.ea.baseReg >= 16) return false;
            if (op.ea.idxReg != 0xFF && op.ea.idxReg >= 16) return false;
            if (op.ea.scale > 3) return false;
        } else if (!widthOk) {
            return false;
        }
        switch (op.kind) {
        case J64_MOV_R_IMM:
            if (op.regField >= 16) return false;
            break;
        case J64_MOV_RM_IMM:
            // rmIndex is 0xFF for memory forms (scanModRM has no register
            // to report); only check it for register-direct ops, mirroring
            // the MOV_RM_R validation above.
            if (!op.isMem && op.rmIndex >= 16) return false;
            break;
        case J64_MOV_RM_R:
        case J64_MOV_R_RM:
            // rmIndex is 0xFF for memory forms (scanModRM has no register
            // to report); only check it for register-direct ops, mirroring
            // the ALU validation below.
            if (op.sub != 0 || op.regField >= 16) return false;
            if (!op.isMem && op.rmIndex >= 16) return false;
            break;
        case J64_LEA:
            // LEA r, m: r/m always names memory (reg form is #UD at decode);
            // the destination is the ModRM reg field.
            if (op.sub != 0 || op.regField >= 16) return false;
            break;
        case J64_PUSH:
            // sub 0 = reg (50-57), 1 = imm (68/6A), 2 = r/m (FF /6).
            // Always 64-bit; the stack address comes from the RSP local.
            if (op.sub > 2 || op.regField >= 16) return false;
            if (op.sub == 2 && !op.isMem && op.rmIndex >= 16) return false;
            break;
        case J64_POP:
            // sub 0 = reg (58-5F), 1 = r/m (8F /0). Always 64-bit.
            if (op.sub > 1 || op.regField >= 16) return false;
            if (op.sub == 1 && !op.isMem && op.rmIndex >= 16) return false;
            break;
        case J64_ALU_RM_R:
        case J64_ALU_R_RM:
        case J64_TEST_RM_R:
            if (op.regField >= 16 || op.sub > 7) return false;
            if (!op.isMem && op.rmIndex >= 16) return false;
            break;
        case J64_ALU_RM_IMM:
            if (op.sub > 7) return false;
            if (!op.isMem && op.rmIndex >= 16) return false;
            break;
        case J64_ALU_ACC_IMM:
            if (op.sub > 8) return false; // sub 8 = TEST acc,imm
            break;
        case J64_SHIFT_IMM:
            // SHL/SHR/SAR (/4,/5,/6,/7) and rotates (/0../3): 0xC1 (imm8)
            // and 0xD1 (implicit 1). Memory forms need the decoder-filled
            // EA (C1-mem and D1-mem both fill it now).
            if (op.sub > 7) return false;
            if (!op.isMem && op.rmIndex >= 16) return false;
            break;
        case J64_SHIFT_CL:
            // SHL/SHR/SAR (/4,/5,/6,/7) and rotates (/0../3): 0xD3 (D2
            // 8-bit), count from CL at runtime. Memory forms need the
            // decoder-filled EA.
            if (op.sub > 7) return false;
            if (!op.isMem && op.rmIndex >= 16) return false;
            break;
        case J64_IMUL_R_RM:
            // Two-operand IMUL r, r/m (0F AF), register-direct only.
            if (op.regField >= 16 || op.rmIndex >= 16) return false;
            break;
        case J64_MOVX:
            // MOVZX/MOVSX r, r/m (sub 0-3) and MOVSXD r, r/m32 (sub 4),
            // register-direct only.
            if (op.sub > 4 || op.regField >= 16 || op.rmIndex >= 16) return false;
            if (op.size == 1) return false; // destination is never 8-bit
            if (op.sub == 4 && op.size == 2) return false; // MOVSXD: 32/64-bit dest only
            break;
        case J64_IMUL_1OP:
            // One-operand IMUL r/m (F6/F7 /5), register-direct only.
            if (op.rmIndex >= 16) return false;
            break;
        case J64_IMUL_3OP:
            // Three-operand IMUL r, r/m, imm, register-direct only.
            if (op.regField >= 16 || op.rmIndex >= 16) return false;
            break;
        case J64_GRP3:
            // F6/F7 group 3: /0 TEST, /2 NOT, /3 NEG, /4 MUL. The
            // decoder only produces these four sub-ops; re-check
            // defensively. rmIndex is 0xFF for memory forms.
            if (op.sub != 0 && op.sub != 2 && op.sub != 3 && op.sub != 4) return false;
            if (!op.isMem && op.rmIndex >= 16) return false;
            break;
        case J64_CBW:
            // CBW/CWDE/CDQE (0x98): pure RAX transform, no ModRM, no flags,
            // no memory. Sizes 2/4/8 only (the decoder sets size from the
            // prefixes; the classifier already rejected anything else).
            if (op.size != 2 && op.size != 4 && op.size != 8) return false;
            break;
        case J64_CQO:
            // CWD/CDQ/CQO (0x99): RAX read-only, RDX written; no ModRM,
            // no flags, no memory. Sizes 2/4/8 only (the decoder sets size
            // from the prefixes; the classifier already rejected else).
            if (op.size != 2 && op.size != 4 && op.size != 8) return false;
            break;
        case J64_CMOV:
            // CMOVcc r, r/m (0F 40..4F): sub = condition 0..15 (decoder
            // sets it from the opcode; re-check defensively). Dest is
            // always a register; source may be reg or memory (rmIndex is
            // 0xFF for memory forms).
            if (op.sub > 15) return false;
            if (op.regField >= 16) return false;
            if (!op.isMem && op.rmIndex >= 16) return false;
            if (op.size != 2 && op.size != 4 && op.size != 8) return false;
            break;
        case J64_SETCC:
            // SETcc r/m8 (0F 90..9F): sub = condition 0..15. Dest is
            // r/m8 (rmIndex, or 0xFF for memory forms); regField is the
            // ModRM reg extension and is ignored. Always size 1.
            if (op.sub > 15) return false;
            if (op.size != 1) return false;
            break;
        case J64_BT:
            // BT/BTS/BTR/BTC (0F A3/AB/B3/BB): sub = 0..3. Bit index in
            // regField (GPR 0..15); target in rmIndex (GPR) or EA (mem).
            // Sizes 2/4/8 only.
            if (op.sub > 3) return false;
            if (op.size != 2 && op.size != 4 && op.size != 8) return false;
            if (op.regField >= 16) return false;
            if (!op.isMem && op.rmIndex >= 16) return false;
            break;
        case J64_STRING:
            break; // validated above
        default:
            return false; // MOVZX, control flow, and the rest
        }
        byteCount += op.len;
    }

    // Param local 0 is the wasm32 host pointer. Locals 1..16 are i64 guest
    // GPRs, 17 the i64 guest RIP, 18 the i32 RFLAGS, 19..25 i64 scratch.
    // Guest values are never wasm host addresses.
    Bytes body = {3, 17, 0x7E, 1, 0x7F, 9, 0x7E}; // +L_STEP/L_CNT
    for (U32 reg = 0; reg < 16; reg++) {
        local(body, 0x20, 0);
        memoryOp(body, 0x29, 3, reg * 8); // i64.load
        local(body, 0x21, reg + 1);
    }
    local(body, 0x20, 0);
    memoryOp(body, 0x29, 3, (U32)offsetof(Jit64WasmState, rip));
    local(body, 0x21, 17);
    local(body, 0x20, 0);
    memoryOp(body, 0x28, 2, (U32)offsetof(Jit64WasmState, rflags)); // i32.load
    local(body, 0x21, L_RFLAGS);

    for (const auto& op : block.ops) {
        switch (op.kind) {
        case J64_MOV_R_IMM:
        case J64_MOV_RM_IMM: {
            if (op.kind == J64_MOV_RM_IMM && op.size == 1) {
                // C6 (MOV r/m8, imm8): table-generated emitMovImm8Gen.
                // Handles reg and mem forms with 8-bit write semantics.
                emitMovImm8Gen(body, op);
                break;
            }
            U32 dest = op.kind == J64_MOV_RM_IMM ? op.rmIndex : op.regField;
            i64Const(body, op.size == 4 ? op.imm & 0xFFFFFFFFULL : op.imm);
            local(body, 0x21, dest + 1);
            break;
        }
        case J64_MOV_RM_R:
        case J64_MOV_R_RM: {
            if (op.size == 1) {
                // 8-bit MOV (88/8A): table-generated emitMov8Gen. Register
                // writes happen inline in the GPR locals (returns 0xFF).
                emitMov8Gen(body, op);
                break;
            }
            U32 dest = op.kind == J64_MOV_RM_R ? op.rmIndex : op.regField;
            U32 src = op.kind == J64_MOV_RM_R ? op.regField : op.rmIndex;
            local(body, 0x20, src + 1);
            if (op.size == 4) {
                i64Const(body, 0xFFFFFFFFULL);
                body.push_back(0x83); // i64.and, x86 32-bit zero extension
            }
            local(body, 0x21, dest + 1);
            break;
        }
        case J64_SHIFT_IMM: {
            // Register-direct shifts and rotates: emitShift/emitRotate leave
            // the result in L_R; publish it to the GPR local so the final
            // store-back writes it (and later ops observe it). A 0xFF return
            // is the 64-bit count==0 pure no-op (32-bit count==0 still
            // zero-extends via L_R and returns the register).
            // Memory forms: the mem emitters store back themselves and
            // always return 0xFF (no register writeback).
            U32 written;
            if (op.isMem)
                written = (op.sub <= 3) ? emitRotateMemGen(body, op) : emitShiftMemGen(body, op);
            else
                written = (op.sub <= 3) ? emitRotateGen(body, op) : emitShiftGen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        case J64_SHIFT_CL: {
            // Register-direct shifts/rotates by CL: the CL emitters leave
            // the result in L_R (which equals the input when count==0, so
            // the writeback is a harmless redundant store then, and the
            // required 32-bit zero-extension on count==0). Flags are
            // merged with a runtime count==0 select inside the emitter.
            // Memory forms store back themselves and return 0xFF.
            U32 written;
            if (op.isMem)
                written = (op.sub <= 3) ? emitRotateCLMemGen(body, op) : emitShiftCLMemGen(body, op);
            else
                written = (op.sub <= 3) ? emitRotateCLGen(body, op) : emitShiftCLGen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        case J64_IMUL_R_RM: {
            // Register-direct IMUL r, r/m: emitImul leaves the result in
            // L_R; publish it to the destination GPR local.
            U32 written = emitImulGen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        case J64_MOVX: {
            // MOVZX/MOVSX: emitMovxGen leaves the result in L_R (or did the
            // 16-bit RMW inline); publish like the ALU ops.
            U32 written = emitMovxGen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        case J64_LEA: {
            // LEA: emitLeaGen leaves the computed address in L_R; publish it
            // to the destination GPR local. No flags are touched.
            U32 written = emitLeaGen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        case J64_IMUL_1OP: {
            // One-operand IMUL: emitImul1Gen writes RAX/RDX inline.
            emitImul1Gen(body, op);
            break;
        }
        case J64_IMUL_3OP: {
            // Three-operand IMUL: emitImul3Gen writes the destination inline.
            emitImul3Gen(body, op);
            break;
        }
        case J64_GRP3: {
            // F6/F7 group 3: emitGrp3Gen returns 0xFF when it published
            // everything inline (TEST, MUL, memory forms, 8/16-bit
            // writebacks), else the destination GPR for L_R.
            U32 written = emitGrp3Gen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        case J64_CBW: {
            // CBW/CWDE/CDQE: emitCbwGen returns 0xFF for 16-bit (inline
            // RMW via emitWriteWord), else 0 (RAX) for L_R publish.
            U32 written = emitCbwGen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        case J64_CQO: {
            // CWD/CDQ/CQO: emitCqoGen returns 0xFF for 16-bit (inline
            // RMW via emitWriteWord), else 2 (RDX) for L_R publish.
            U32 written = emitCqoGen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        case J64_CMOV: {
            // CMOVcc: emitCmovGen computes the selected value in L_R
            // (branchless via wasm select) and returns the dest GPR.
            U32 written = emitCmovGen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        case J64_SETCC: {
            // SETcc: emitSetccGen writes the 0/1 byte inline (reg via
            // emitWriteByte, mem via emitEA+emitMemWrite) and returns
            // 0xFF; no L_R publish needed.
            emitSetccGen(body, op);
            break;
        }
        case J64_BT: {
            // BT/BTS/BTR/BTC: emitBtGen leaves the new value in L_R for
            // BTS/BTR/BTC reg-direct (32/64-bit) and returns the target
            // register for the epilogue store-back. BT (sub 0), 16-bit
            // reg-direct (via emitWriteWord), and mem forms return 0xFF.
            U32 written = emitBtGen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        case J64_STRING: {
            // String ops update RSI/RDI/RCX in their locals; the epilogue
            // store-back publishes them. emitStringGen returns 0xFF.
            emitStringGen(body, op);
            break;
        }
        case J64_PUSH:
        case J64_POP: {
            // Stack ops update RSP in its local inline (fault ordering
            // mirrors cpu64.cpp); the epilogue store-back publishes it.
            // emitStackGen returns 0xFF.
            emitStackGen(body, op);
            break;
        }
        default: {
            // Memory-operand ALU/TEST go through emitAluMem (EA in L_T1,
            // memory via the imported helpers); register-direct ALU/TEST
            // through emitAlu. Both leave the result in L_R; publish it to
            // the GPR local so the final store-back writes it (and later
            // ops in the block observe it).
            U32 written = op.isMem ? emitAluMemGen(body, op) : emitAluGen(body, op);
            if (written != 0xFF) {
                local(body, 0x20, L_R);
                local(body, 0x21, written + 1);
            }
            break;
        }
        }
    }

    for (U32 reg = 0; reg < 16; reg++) {
        local(body, 0x20, 0);
        local(body, 0x20, reg + 1);
        memoryOp(body, 0x37, 3, reg * 8); // i64.store
    }
    local(body, 0x20, 0);
    local(body, 0x20, 17);
    i64Const(body, byteCount);
    body.push_back(0x7C); // i64.add, modulo 64 bits
    memoryOp(body, 0x37, 3, (U32)offsetof(Jit64WasmState, rip));
    local(body, 0x20, 0);
    local(body, 0x20, L_RFLAGS);
    memoryOp(body, 0x36, 2, (U32)offsetof(Jit64WasmState, rflags)); // i32.store
    body.push_back(0x0B); // end execute

    Bytes module = {0, 0x61, 0x73, 0x6D, 1, 0, 0, 0};
    // Type section: 0: (i32)->() [execute], 1: (i32 x4)->() [memRead],
    // 2: (i32 x5)->() [memWrite].
    Bytes types = {3,
        0x60, 1, 0x7F, 0,
        0x60, 4, 0x7F, 0x7F, 0x7F, 0x7F, 0,
        0x60, 5, 0x7F, 0x7F, 0x7F, 0x7F, 0x7F, 0};
    section(module, 1, types);
    // Import section: env.memory, env.memRead (func 0, type 1),
    // env.memWrite (func 1, type 2).
    Bytes imports = {3,
        3, 'e', 'n', 'v', 6, 'm', 'e', 'm', 'o', 'r', 'y', 2, 0, 1,
        3, 'e', 'n', 'v', 7, 'm', 'e', 'm', 'R', 'e', 'a', 'd', 0, 1,
        3, 'e', 'n', 'v', 8, 'm', 'e', 'm', 'W', 'r', 'i', 't', 'e', 0, 2};
    section(module, 2, imports);
    section(module, 3, {1, 0}); // one function, type 0 (function index 2)
    section(module, 7, {1, 7, 'e', 'x', 'e', 'c', 'u', 't', 'e', 0, 2}); // export func 2
    Bytes code = {1};
    uleb(code, (U32)body.size());
    code.insert(code.end(), body.begin(), body.end());
    section(module, 10, code);
    output.swap(module);
    return true;
}
#endif
