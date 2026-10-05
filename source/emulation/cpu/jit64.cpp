/*
 *  Copyright (C) 2012-2026  The BoxedWine Team
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  jit64.cpp — Phase-1 JIT framework for the 64-bit guest (CPU64).
 *
 *  Self-contained decoder + classifier + block cache over raw guest bytes.
 *  Deliberately does NOT include cpu64.h: the phase-1 unit is decoupled from
 *  the interpreter so it can be unit-tested natively (g++, no SDL, no
 *  KMemory64) by feeding hand-built guest instruction streams.
 *
 *  The decode logic mirrors CPU64::step()'s dispatch (cpu64.cpp) for the
 *  phase-1 fast set; PUSH/POP/CALL/JMP/RET/LEAVE/NOP/SYSCALL coverage mirrors
 *  their step() handlers. Anything else -> J64_UNKNOWN (fallback).
 *
 *  Profile basis (tasks/jit-port-plan.md "Phase 1 status"): static disassembly
 *  via source/emulation/cpu/tests/profile_opcodes.py (capstone linear sweep,
 *  opcode counted AFTER legacy/REX prefixes, NOP padding 90/0F1F excluded)
 *  over 83,376 instructions from real x86-64 guest binaries shipped in this
 *  repo: tools/rootfs64/games/doom.exe (59.9k) + tetris/snake + gltest suite
 *  (glcube/gltri/msgloop/sleepprobe) + tools/dxvk/tri9/tri9.exe.
 *  NOTE: tools/rootfs64/apps/HxD/HxD64.exe was EXCLUDED: its .text is
 *  dominated by zero padding / non-code patterns that a linear sweep cannot
 *  distinguish from code (26% of "instructions" decoded as opcode 00).
 *  Only 64-bit PEs (COFF machine 0x8664) are accepted by the profiler.
 */

#include "../../../include/jit64.h"

#ifdef BOXEDWINE_GUEST_X64

#include <cstdlib>
#include <cstring>
#include <cstdio>

static const Jit64CoveredOpcode kCovered[] = {
    // rank opcode                 kind              measured share (padding excl.)
    { "89 MOV r/m,r",      0x89, 0x00, J64_MOV_RM_R },    // 1 (11.2%)
    { "8B MOV r,r/m",      0x8B, 0x00, J64_MOV_R_RM },    // 2 (10.1%)
    { "83 ALU r/m,imm8",   0x83, 0x00, J64_ALU_RM_IMM },  // 3 (6.7%)
    { "E8 CALL rel32",     0xE8, 0x00, J64_CALL_REL },    // 4 (6.0%)
    { "8D LEA",            0x8D, 0x00, J64_LEA },         // 5 (5.4%)
    { "58 POP r64",        0x58, 0x00, J64_POP },         // 6 (3.6%; whole 58..5F class)
    { "B8 MOV r,imm",      0xB8, 0x00, J64_MOV_R_IMM },   // 7 (3.1%; whole B8..BF class)
    { "85 TEST r/m,r",     0x85, 0x00, J64_TEST_RM_R },   // 8 (3.0%)
    { "50 PUSH r64",       0x50, 0x00, J64_PUSH },        // 9 (2.8%; whole 50..57 class)
    { "31 XOR r/m,r",      0x31, 0x00, J64_ALU_RM_R },    // 10 (2.4%)
    { "C1 SHIFT r/m,imm8", 0xC1, 0x00, J64_SHIFT_IMM },   // 11 (2.3%)
    { "E9 JMP rel32",      0xE9, 0x00, J64_JMP_REL },     // 12 (2.2%)
    { "74 JZ rel8",        0x74, 0x00, J64_JCC },         // 13 (2.0%)
    { "39 CMP r/m,r",      0x39, 0x00, J64_ALU_RM_R },    // 14 (2.0%)
    { "0FB6 MOVZX r,r/m8", 0x0F, 0xB6, J64_MOV_R_RM },    // 15 (1.9%)
    { "C7 MOV r/m,imm32",  0xC7, 0x00, J64_MOV_RM_IMM },  // 16 (1.8%)
    { "75 JNZ rel8",       0x75, 0x00, J64_JCC },         // 17 (1.7%)
    { "C3 RET",            0xC3, 0x00, J64_RET },         // 18 (1.7%)
    { "0F84 JZ rel32",     0x0F, 0x84, J64_JCC },         // 19 (1.2%)
    { "01 ADD r/m,r",      0x01, 0x00, J64_ALU_RM_R },    // 20 (1.2%)
    // NOTE: 0F85 (JNZ rel32) and 29 (SUB r/m,r) stay FAST in jit64Classify but
    // fell just outside this corpus's top-20, so they have no table row. FF
    // (INC/DEC/indirect CALL) and 00 (8-bit ADD) rank 19-20 by byte but are
    // not in the phase-1 fast set and are correctly absent.
};

const Jit64CoveredOpcode* jit64CoveredOpcodes(U32* countOut) {
    if (countOut) *countOut = (U32)(sizeof(kCovered) / sizeof(kCovered[0]));
    return kCovered;
}

bool jit64Enabled() {
    static int cached = -1;
    if (cached < 0) {
        cached = (std::getenv("BW64_JIT") && std::getenv("BW64_JIT")[0] == '1') ? 1 : 0;
    }
    return cached == 1;
}

// ---- byte-level prefix scan (mirrors CPU64::consumePrefixes) ----
struct PrefixInfo {
    U8 rex = 0;
    bool osize16 = false;
    bool asize32 = false;
    U8 seg = 0;
    U8 rep = 0;
    bool lock = false;
    U32 len = 0; // bytes consumed
};

static U32 scanPrefixes(const U8* bytes, U32 byteCount, PrefixInfo& p) {
    U32 off = 0;
    while (off < byteCount) {
        U8 b = bytes[off];
        switch (b) {
        case 0x66: p.osize16 = true; off++; continue;
        case 0x67: p.asize32 = true; off++; continue;
        case 0x64: p.seg = 0x64; off++; continue;
        case 0x65: p.seg = 0x65; off++; continue;
        case 0x26: case 0x2E: case 0x36: case 0x3E: off++; continue;
        case 0xF0: p.lock = true; off++; continue;
        case 0xF2: p.rep = 0xF2; off++; continue;
        case 0xF3: p.rep = 0xF3; off++; continue;
        default:
            if ((b & 0xF0) == 0x40) { p.rex = b; off++; }
            p.len = off;
            return off;
        }
    }
    p.len = off;
    return off;
}

// ---- ModRM length scan (addressing-form only, no EA computation) ----
// Returns total ModRM+SIB+disp bytes, or 0 if truncated/need-more-bytes.
// Fills regField/rmIsReg/rmIndex/hasMem.
static U32 scanModRM(const U8* bytes, U32 byteCount, const PrefixInfo& p,
                     U8& regField, bool& rmIsReg, U8& rmIndex, bool& hasMem) {
    if (byteCount < 1) return 0;
    U8 modrm = bytes[0];
    U8 mod = (modrm >> 6) & 0x3;
    U8 regF = (modrm >> 3) & 0x7;
    U8 rm = modrm & 0x7;
    regField = (U8)(regF | ((p.rex & 0x04) ? 0x08 : 0));
    U32 len = 1;
    if (mod == 0x3) {
        rmIsReg = true;
        rmIndex = (U8)(rm | ((p.rex & 0x01) ? 0x08 : 0));
        hasMem = false;
        return len;
    }
    rmIsReg = false;
    rmIndex = 0xFF;
    hasMem = true;
    if (mod == 0x0 && rm == 0x5) {
        // RIP-relative disp32
        if (byteCount < 5) return 0;
        return 5;
    }
    if (rm == 0x4) {
        if (byteCount < 2) return 0;
        len = 2;
    }
    if (mod == 0x1) {
        if (byteCount < len + 1) return 0;
        len += 1;
    } else if (mod == 0x2) {
        if (byteCount < len + 4) return 0;
        len += 4;
    } else if (mod == 0x0 && rm == 0x4) {
        // SIB with no base (mod==0, base==5): disp32 follows
        // len is 2 here (modrm+sib)
        if (byteCount < len + 4) return 0;
        len += 4;
    }
    return len;
}

static U32 readU32(const U8* b) {
    return (U32)b[0] | ((U32)b[1] << 8) | ((U32)b[2] << 16) | ((U32)b[3] << 24);
}

bool jit64DecodeOne(U64 ripBase, const U8* bytes, U32 byteCount, Jit64Op& out) {
    (void)ripBase;
    out = Jit64Op();
    if (!bytes || byteCount == 0) return false;
    PrefixInfo p;
    U32 opOff = scanPrefixes(bytes, byteCount, p);
    if (opOff >= byteCount) return false;
    bool rexW = (p.rex & 0x08) != 0;
    U8 size = rexW ? 8 : (p.osize16 ? 2 : 4);
    bool rexPresent = (p.rex != 0);
    (void)rexPresent;
    U8 op = bytes[opOff];

    // Two-byte map.
    if (op == 0x0F) {
        if (opOff + 1 >= byteCount) return false;
        U8 op2 = bytes[opOff + 1];
        if (op2 == 0x05) {
            out.kind = J64_SYSCALL;
            out.len = (U8)(opOff + 2);
            return true;
        }
        if (op2 >= 0x80 && op2 <= 0x8F) {
            if (opOff + 6 > byteCount) return false;
            out.kind = J64_JCC;
            out.sub = op2 & 0xF;
            out.len = (U8)(opOff + 6);
            out.delta = (S64)(S32)readU32(bytes + opOff + 2);
            return true;
        }
        if (op2 == 0xAF) { // IMUL r, r/m
            U8 rf; bool rr; U8 ri; bool hm;
            U32 ml = scanModRM(bytes + opOff + 2, byteCount - (opOff + 2), p, rf, rr, ri, hm);
            if (!ml) return false;
            out.kind = J64_IMUL_R_RM;
            out.size = size;
            out.len = (U8)(opOff + 2 + ml);
            out.regField = rf; out.rmIndex = ri; out.isMem = hm;
            return true;
        }
        if (op2 == 0xB6 || op2 == 0xB7) { // MOVZX r, r/m8/16
            U8 rf; bool rr; U8 ri; bool hm;
            U32 ml = scanModRM(bytes + opOff + 2, byteCount - (opOff + 2), p, rf, rr, ri, hm);
            if (!ml) return false;
            out.kind = J64_MOV_R_RM;
            out.size = size;
            out.len = (U8)(opOff + 2 + ml);
            out.regField = rf; out.rmIndex = ri; out.isMem = hm;
            out.sub = (op2 == 0xB6) ? 1 : 2; // source width marker
            return true;
        }
        if (op2 == 0x1F) { // multi-byte NOP
            U8 rf; bool rr; U8 ri; bool hm;
            U32 ml = scanModRM(bytes + opOff + 2, byteCount - (opOff + 2), p, rf, rr, ri, hm);
            if (!ml) return false;
            out.kind = J64_NOP;
            out.len = (U8)(opOff + 2 + ml);
            return true;
        }
        return false;
    }

    // PUSH r64 / POP r64.
    if (op >= 0x50 && op <= 0x57) {
        out.kind = J64_PUSH;
        out.regField = (U8)((op - 0x50) | ((p.rex & 0x01) ? 0x08 : 0));
        out.len = (U8)(opOff + 1);
        return true;
    }
    if (op >= 0x58 && op <= 0x5F) {
        out.kind = J64_POP;
        out.regField = (U8)((op - 0x58) | ((p.rex & 0x01) ? 0x08 : 0));
        out.len = (U8)(opOff + 1);
        return true;
    }
    // MOV r, imm.
    if (op >= 0xB8 && op <= 0xBF) {
        out.kind = J64_MOV_R_IMM;
        out.regField = (U8)((op - 0xB8) | ((p.rex & 0x01) ? 0x08 : 0));
        if (rexW) {
            if (opOff + 9 > byteCount) return false;
            U64 v = 0;
            for (int i = 0; i < 8; i++) v |= (U64)bytes[opOff + 1 + i] << (i * 8);
            out.imm = v;
            out.size = 8;
            out.len = (U8)(opOff + 9);
        } else {
            if (opOff + 5 > byteCount) return false;
            out.imm = readU32(bytes + opOff + 1);
            out.size = 4;
            out.len = (U8)(opOff + 5);
        }
        return true;
    }
    // MOV r/m, r / MOV r, r/m.
    if (op == 0x89 || op == 0x8B) {
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml) return false;
        out.kind = (op == 0x89) ? J64_MOV_RM_R : J64_MOV_R_RM;
        out.size = size;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        return true;
    }
    // ALU r/m, r / r, r/m (00..3B except /6 /7 rows: 06,07,0E,...).
    if (op <= 0x3D && ((op & 0x06) != 0x06) && (op & 0x7) <= 3) {
        U8 form = (U8)(op & 0x7);
        if (form == 0 || form == 2) return false; // 8-bit forms: phase-1 fallback (still decode as unknown)
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml) return false;
        out.kind = (form < 2) ? J64_ALU_RM_R : J64_ALU_R_RM;
        out.sub = (op >> 3) & 0x7;
        out.size = size;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        return true;
    }
    // ALU ACC, imm (04/05, 0C/0D, 14/15, 1C/1D, 24/25, 2C/2D, 34/35, 3C/3D).
    if (op <= 0x3D && ((op & 0x06) != 0x06) && ((op & 0x7) == 4 || (op & 0x7) == 5)) {
        U8 form = op & 0x7;
        U32 isz = (form == 4) ? 1 : (rexW ? 4 : (p.osize16 ? 2 : 4));
        if (opOff + 1 + isz > byteCount) return false;
        out.kind = J64_ALU_ACC_IMM;
        out.sub = (op >> 3) & 0x7;
        if (form == 4) { out.imm = bytes[opOff + 1]; out.size = 1; }
        else if (rexW) { out.imm = (U64)(S64)(S32)readU32(bytes + opOff + 1); out.size = 8; }
        else if (p.osize16) {
            out.imm = bytes[opOff + 1] | ((U32)bytes[opOff + 2] << 8);
            out.size = 2;
        } else { out.imm = readU32(bytes + opOff + 1); out.size = 4; }
        out.len = (U8)(opOff + 1 + isz);
        out.regField = 0; // ACC = RAX
        return true;
    }
    // 0x80/0x81/0x83 imm-group ALU.
    if (op == 0x80 || op == 0x81 || op == 0x83) {
        if (op == 0x80) return false; // 8-bit: fallback
        U32 trailing = (op == 0x81) ? (p.osize16 ? 2u : 4u) : 1u;
        // Need modrm + trailing bytes present.
        U32 avail = byteCount - (opOff + 1);
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, avail, p, rf, rr, ri, hm);
        if (!ml || avail < ml + trailing) return false;
        out.kind = J64_ALU_RM_IMM;
        out.sub = rf & 0x7;
        const U8* ip = bytes + opOff + 1 + ml;
        if (op == 0x83) {
            S8 i8 = (S8)ip[0];
            out.imm = (U64)(S64)i8;
            if (size == 4) out.imm &= 0xFFFFFFFFULL;
            else if (size == 2) out.imm &= 0xFFFFULL;
        } else if (size == 2) {
            out.imm = ip[0] | ((U32)ip[1] << 8);
        } else if (size == 4) {
            out.imm = readU32(ip);
        } else {
            out.imm = (U64)(S64)(S32)readU32(ip);
        }
        out.size = size;
        out.len = (U8)(opOff + 1 + ml + trailing);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        return true;
    }
    // TEST r/m, r.
    if (op == 0x84 || op == 0x85) {
        if (op == 0x84) return false; // 8-bit: fallback
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml) return false;
        out.kind = J64_TEST_RM_R;
        out.size = size;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        return true;
    }
    // LEA.
    if (op == 0x8D) {
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml || !hm) return false; // reg-form LEA is #UD
        out.kind = J64_LEA;
        out.size = size;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        return true;
    }
    // MOV r/m, imm (C6 /0, C7 /0).
    if (op == 0xC6 || op == 0xC7) {
        if (op == 0xC6) return false; // 8-bit: fallback
        U8 rf; bool rr; U8 ri; bool hm;
        U32 avail = byteCount - (opOff + 1);
        U32 ml = scanModRM(bytes + opOff + 1, avail, p, rf, rr, ri, hm);
        if (!ml || (rf & 0x7) != 0 || avail < ml + 4) return false;
        const U8* ip = bytes + opOff + 1 + ml;
        S32 i32 = (S32)readU32(ip);
        out.kind = J64_MOV_RM_IMM;
        out.size = size;
        out.imm = (size == 8) ? (U64)(S64)i32 : (U64)(U32)i32;
        out.len = (U8)(opOff + 1 + ml + 4);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        return true;
    }
    // SHIFT r/m, imm8 (C0/C1).
    if (op == 0xC0 || op == 0xC1) {
        if (op == 0xC0) return false; // 8-bit: fallback
        U8 rf; bool rr; U8 ri; bool hm;
        U32 avail = byteCount - (opOff + 1);
        U32 ml = scanModRM(bytes + opOff + 1, avail, p, rf, rr, ri, hm);
        if (!ml || avail < ml + 1) return false;
        U8 count = bytes[opOff + 1 + ml];
        out.kind = J64_SHIFT_IMM;
        out.sub = rf & 0x7;
        out.size = size;
        out.imm = count & ((size == 8) ? 0x3F : 0x1F);
        out.len = (U8)(opOff + 1 + ml + 1);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        return true;
    }
    // Control flow.
    if (op == 0xE8) {
        if (opOff + 5 > byteCount) return false;
        out.kind = J64_CALL_REL;
        out.delta = (S64)(S32)readU32(bytes + opOff + 1);
        out.len = (U8)(opOff + 5);
        return true;
    }
    if (op == 0xE9) {
        if (opOff + 5 > byteCount) return false;
        out.kind = J64_JMP_REL;
        out.delta = (S64)(S32)readU32(bytes + opOff + 1);
        out.len = (U8)(opOff + 5);
        return true;
    }
    if (op == 0xEB) {
        if (opOff + 2 > byteCount) return false;
        out.kind = J64_JMP_REL;
        out.delta = (S64)(S8)bytes[opOff + 1];
        out.len = (U8)(opOff + 2);
        return true;
    }
    if (op >= 0x70 && op <= 0x7F) {
        if (opOff + 2 > byteCount) return false;
        out.kind = J64_JCC;
        out.sub = op & 0xF;
        out.delta = (S64)(S8)bytes[opOff + 1];
        out.len = (U8)(opOff + 2);
        return true;
    }
    if (op == 0xC3) {
        out.kind = J64_RET;
        out.len = (U8)(opOff + 1);
        return true;
    }
    if (op == 0xC9) {
        out.kind = J64_LEAVE;
        out.len = (U8)(opOff + 1);
        return true;
    }
    if (op == 0x90) {
        out.kind = J64_NOP;
        out.len = (U8)(opOff + 1);
        return true;
    }
    return false;
}

void jit64Classify(Jit64Op& op, bool hasLockOrRep, bool osize16) {
    op.plan = JIT64_FALLBACK;
    if (hasLockOrRep || osize16) return; // phase-1 rule: prefixes force fallback
    switch (op.kind) {
    case J64_MOV_RM_R:
    case J64_MOV_R_RM:
        // 8-bit MOV forms never reach here (decoder rejects them); MOVZX (sub)
        // and 16-bit operand size are fallback.
        if (op.size == 1 || op.size == 2) return;
        op.plan = JIT64_FAST;
        return;
    case J64_ALU_RM_R:
    case J64_ALU_R_RM:
    case J64_ALU_RM_IMM:
    case J64_ALU_ACC_IMM:
        if (op.size == 1 || op.size == 2) return;
        op.plan = JIT64_FAST;
        return;
    case J64_SHIFT_IMM:
        if (op.size == 1 || op.size == 2) return;
        op.plan = JIT64_FAST;
        return;
    case J64_IMUL_R_RM:
        if (op.size == 2) return;
        op.plan = JIT64_FAST;
        return;
    case J64_TEST_RM_R:
    case J64_LEA:
    case J64_MOV_RM_IMM:
    case J64_MOV_R_IMM:
    case J64_PUSH:
    case J64_POP:
    case J64_CALL_REL:
    case J64_JMP_REL:
    case J64_JCC:
    case J64_RET:
    case J64_LEAVE:
    case J64_NOP:
        op.plan = JIT64_FAST;
        return;
    case J64_SYSCALL:
    case J64_UNKNOWN:
    default:
        return;
    }
}

U32 jit64CompileStream(U64 ripBase, const U8* bytes, U32 byteCount,
                       Jit64Op* opsOut, U32 maxOps, bool stopAtControlFlow) {
    if (!bytes || !opsOut || maxOps == 0) return 0;
    U32 n = 0;
    U32 off = 0;
    while (off < byteCount && n < maxOps) {
        Jit64Op op;
        // Prefix peek for classify (LOCK/REP/66h force fallback but still decode).
        PrefixInfo p;
        scanPrefixes(bytes + off, byteCount - off, p);
        if (!jit64DecodeOne(ripBase + off, bytes + off, byteCount - off, op)) break;
        if (op.len == 0) break;
        jit64Classify(op, p.lock || p.rep != 0, p.osize16);
        opsOut[n++] = op;
        off += op.len;
        if (stopAtControlFlow) {
            switch (op.kind) {
            case J64_CALL_REL: case J64_JMP_REL: case J64_JCC:
            case J64_RET: case J64_SYSCALL:
                return n;
            default: break;
            }
        }
    }
    return n;
}

// ---- block cache ----

Jit64BlockCache::Jit64BlockCache() {
    for (U32 i = 0; i < SLOTS; i++) m_slots[i].block.startRip = 0;
}

U32 Jit64BlockCache::slotFor(U64 rip) {
    return (U32)((rip ^ (rip >> 9)) & (SLOTS - 1));
}

const Jit64Block* Jit64BlockCache::lookup(U64 rip, U64 page0, U32 gen0, U64 page1, U32 gen1) {
    m_lookups++;
    if (rip == 0) return nullptr;
    const Jit64Block& b = m_slots[slotFor(rip)].block;
    if (b.startRip != rip) return nullptr;
    if (b.page0 != page0 || b.gen0 != gen0) return nullptr;
    if (b.page1 != page1 || b.gen1 != gen1) return nullptr;
    if (!b.executable) return nullptr;
    m_hits++;
    return &b;
}

const Jit64Block* Jit64BlockCache::insert(U64 rip, U64 page0, U32 gen0, U64 page1, U32 gen1,
                                          const Jit64Op* ops, U32 nOps) {
    if (rip == 0 || !ops || nOps == 0) return nullptr;
    m_inserts++;
    Jit64Block& b = m_slots[slotFor(rip)].block;
    b.startRip = rip;
    b.page0 = page0; b.gen0 = gen0;
    b.page1 = page1; b.gen1 = gen1;
    b.ops.assign(ops, ops + nOps);
    b.fastCount = 0;
    for (U32 i = 0; i < nOps; i++) if (ops[i].plan == JIT64_FAST) b.fastCount++;
    b.executable = (b.fastCount == nOps);
    b.execCount = 0;
    return &b;
}

void Jit64BlockCache::invalidate(U64 rip) {
    if (rip == 0) return;
    Jit64Block& b = m_slots[slotFor(rip)].block;
    if (b.startRip == rip) b.startRip = 0;
}

void Jit64BlockCache::clear() {
    for (U32 i = 0; i < SLOTS; i++) m_slots[i].block = Jit64Block();
    m_lookups = m_hits = m_inserts = 0;
}

U32 jit64EmitPlanText(const Jit64Block& b, char* buf, U32 bufSize) {
    if (!buf || bufSize == 0) return 0;
    U32 used = 0;
    for (size_t i = 0; i < b.ops.size(); i++) {
        const Jit64Op& op = b.ops[i];
        char line[96];
        int n = std::snprintf(line, sizeof(line), "kind=%u size=%u sub=%u plan=%s\n",
                              (unsigned)op.kind, (unsigned)op.size, (unsigned)op.sub,
                              op.plan == JIT64_FAST ? "fast" : "fallback");
        if (n <= 0) break;
        if (used + (U32)n + 1 > bufSize) return 0; // too small: report 0
        std::memcpy(buf + used, line, (size_t)n);
        used += (U32)n;
    }
    if (used < bufSize) buf[used] = '\0';
    else return 0;
    return used;
}

#endif // BOXEDWINE_GUEST_X64
