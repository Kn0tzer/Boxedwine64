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
#include "../../../include/jit64wasm.h"

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
    { "0FB6 MOVZX r,r/m8", 0x0F, 0xB6, J64_MOVX },        // 15 (1.9%)
    { "C7 MOV r/m,imm32",  0xC7, 0x00, J64_MOV_RM_IMM },  // 16 (1.8%)
    { "75 JNZ rel8",       0x75, 0x00, J64_JCC },         // 17 (1.7%)
    { "C3 RET",            0xC3, 0x00, J64_RET },         // 18 (1.7%)
    { "0F84 JZ rel32",     0x0F, 0x84, J64_JCC },         // 19 (1.2%)
    { "01 ADD r/m,r",      0x01, 0x00, J64_ALU_RM_R },    // 20 (1.2%)
    { "63 MOVSXD",         0x63, 0x00, J64_MOVX },        // 21 (1.3% doom.exe; sub 4)
    { "88 MOV r/m8,r8",    0x88, 0x00, J64_MOV_RM_R },    // 22 (0.83% doom.exe; 8A same row)
    { "F7 GRP3",           0xF7, 0x00, J64_GRP3 },        // 23 (0.32% F7 + 0.22% F6 doom.exe; /0 TEST /2 NOT /3 NEG /4 MUL; DIV/IDIV stay interpreted)
    { "98 CBW/CWDE/CDQE",  0x98, 0x00, J64_CBW },         // 24 (0.31% doom.exe)
    { "D1 SHIFT/ROT r/m,1", 0xD1, 0x00, J64_SHIFT_IMM },    // 25 (0.25% doom.exe; D0 8-bit + C1-mem also newly jitted)
    { "D3 SHIFT/ROT r/m,CL", 0xD3, 0x00, J64_SHIFT_CL },   // 29 (0.035% doom.exe; D2 8-bit form also jitted)
    { "0F40 CMOVcc",        0x0F, 0x40, J64_CMOV },        // 26 (0.51% doom.exe; whole 0F40..4F family; sub = cc)
    { "99 CWD/CDQ/CQO",      0x99, 0x00, J64_CQO },         // 27 (0.11% doom.exe)
    { "C6 MOV r/m8,imm8",    0xC6, 0x00, J64_MOV_RM_IMM },  // 28 (0.11% doom.exe; high-byte reg declined)
    { "0F90 SETcc",          0x0F, 0x90, J64_SETCC },       // 29 (0.25% doom.exe; whole 0F90..9F family; sub = cc; high-byte reg declined)
    { "0FA3 BT",             0x0F, 0xA3, J64_BT },          // 30 (0.02% doom.exe; 0FA3/AB/B3/BB BT/BTS/BTR/BTC; sub = op)
    // NOTE: 0F85 (JNZ rel32) stays FAST in jit64Classify but fell just outside
    // this corpus's top-20, so it has no table row. The whole 00..3B ALU range
    // (including 29 SUB r/m,r) is table-covered; the phase-1 table only names
    // the ranks that made its top-20. FF's INC/DEC /0 /1 forms have no fast
    // path, but in the profiled corpus every FF hit is indirect CALL/JMP /2 /4
    // (block boundaries, already handled).
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
    } else if (mod == 0x0 && rm == 0x4 && (bytes[1] & 0x7) == 0x5) {
        // SIB with no base (mod==0, SIB base field==5): disp32 follows.
        // len is 2 here (modrm+sib); a SIB *with* a base has no disp32.
        // (The interpreter's decodeModRM checks baseF==5, not rm==4.)
        if (byteCount < len + 4) return 0;
        len += 4;
    }
    return len;
}

static U32 readU32(const U8* b) {
    return (U32)b[0] | ((U32)b[1] << 8) | ((U32)b[2] << 16) | ((U32)b[3] << 24);
}

// Decode the full effective-address form of a memory ModRM (addressing
// fields only, no EA computation: base/index registers are read at
// runtime). Mirrors CPU64::decodeModRM field-for-field, including its
// quirks: RIP-relative (mod=0,rm=5) returns before the 0x67 mask and
// before FS/GS handling, so asize32/seg are ignored for it.
// `b` points at the ModRM byte; lengths were validated by scanModRM.
// `modrmGuestAddr` is the absolute guest address of the ModRM byte;
// `trailingImm` is the immediate length after ModRM/SIB/disp (for RIP-rel).
static void decodeEA(const U8* b, const PrefixInfo& p, U64 modrmGuestAddr,
                     U32 trailingImm, Jit64MemEA& ea) {
    ea = Jit64MemEA();
    U8 modrm = b[0];
    U8 mod = (modrm >> 6) & 0x3;
    U8 rm = modrm & 0x7;
    ea.asize32 = p.asize32;
    ea.seg = p.seg;
    if (mod == 0x0 && rm == 0x5) {
        // RIP-relative disp32. Materialize the absolute target now: the
        // emitter folds it to a single i64.const.
        S32 disp32 = (S32)readU32(b + 1);
        ea.ripRel = true;
        ea.ripRelTarget = modrmGuestAddr + 5 + trailingImm + (U64)(S64)disp32;
        return;
    }
    U32 pos = 1;
    if (rm == 0x4) {
        U8 sib = b[1];
        pos = 2;
        ea.scale = (U8)((sib >> 6) & 0x3);
        U8 idxF = (sib >> 3) & 0x7;
        U8 baseF = sib & 0x7;
        bool rexX = (p.rex & 0x02) != 0;
        bool rexB = (p.rex & 0x01) != 0;
        // Index field 100 with no REX.X: no index. With REX.X it is R12.
        if (!(idxF == 0x4 && !rexX))
            ea.idxReg = (U8)(idxF | (rexX ? 0x08 : 0));
        // Base field 101 with mod==0: disp32-only, no base register.
        if (!(baseF == 0x5 && mod == 0x0))
            ea.baseReg = (U8)(baseF | (rexB ? 0x08 : 0));
    } else {
        ea.baseReg = (U8)(rm | ((p.rex & 0x01) ? 0x08 : 0));
    }
    if (mod == 0x1) {
        ea.disp = (S64)(S8)b[pos];
    } else if (mod == 0x2) {
        ea.disp = (S64)(S32)readU32(b + pos);
    } else if (mod == 0x0 && rm == 0x4 && ea.baseReg == 0xFF) {
        // SIB disp32-only (baseF==5, mod==0).
        ea.disp = (S64)(S32)readU32(b + pos);
    }
}

bool jit64DecodeOne(U64 ripBase, const U8* bytes, U32 byteCount, Jit64Op& out) {
    out = Jit64Op();
    if (!bytes || byteCount == 0) return false;
    PrefixInfo p;
    U32 opOff = scanPrefixes(bytes, byteCount, p);
    if (opOff >= byteCount) return false;
    bool rexW = (p.rex & 0x08) != 0;
    U8 size = rexW ? 8 : (p.osize16 ? 2 : 4);
    out.rexPresent = (p.rex != 0);
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
        if (op2 == 0xB6 || op2 == 0xB7 || op2 == 0xBE || op2 == 0xBF) {
            // MOVZX r, r/m8/16 (B6/B7); MOVSX r, r/m8/16 (BE/BF).
            U8 rf; bool rr; U8 ri; bool hm;
            U32 ml = scanModRM(bytes + opOff + 2, byteCount - (opOff + 2), p, rf, rr, ri, hm);
            if (!ml) return false;
            out.kind = J64_MOVX;
            out.size = size; // destination width (2/4/8); never 1
            out.len = (U8)(opOff + 2 + ml);
            out.regField = rf; out.rmIndex = ri; out.isMem = hm;
            out.sub = (U8)((op2 == 0xB6) ? 0 : (op2 == 0xB7) ? 1 :
                           (op2 == 0xBE) ? 2 : 3);
            return true;
        }
        if (op2 >= 0x40 && op2 <= 0x4F) {
            // CMOVcc r, r/m16/32/64. Condition in low 4 bits (same
            // encoding as Jcc). Dest is always a register; the source
            // is always loaded (faults even if the condition is false),
            // mirroring cpu64.cpp dsp_38. Sizes 2/4/8 (0x66 -> 16-bit,
            // REX.W -> 64-bit, default 32-bit); never 8-bit.
            U8 rf; bool rr; U8 ri; bool hm;
            U32 ml = scanModRM(bytes + opOff + 2, byteCount - (opOff + 2), p, rf, rr, ri, hm);
            if (!ml) return false;
            out.kind = J64_CMOV;
            out.sub = (U8)(op2 & 0xF);
            out.size = size;
            out.len = (U8)(opOff + 2 + ml);
            out.regField = rf; out.rmIndex = ri; out.isMem = hm;
            if (hm) decodeEA(bytes + opOff + 2, p, ripBase + opOff + 2, 0, out.ea);
            return true;
        }
        if (op2 >= 0x90 && op2 <= 0x9F) {
            // SETcc r/m8. Condition in low 4 bits (same encoding as
            // Jcc/CMOVcc). Dest is always r/m8 (byte); 0x66/REX.W ignored.
            // Mirrors cpu64.cpp dsp_15: val = evalCC(cc) ? 1 : 0, stored
            // via storeRM(m, 1, val, rexPresent). No flags touched.
            U8 rf; bool rr; U8 ri; bool hm;
            U32 ml = scanModRM(bytes + opOff + 2, byteCount - (opOff + 2), p, rf, rr, ri, hm);
            if (!ml) return false;
            out.kind = J64_SETCC;
            out.sub = (U8)(op2 & 0xF);
            out.size = 1;
            out.len = (U8)(opOff + 2 + ml);
            out.regField = rf; out.rmIndex = ri; out.isMem = hm;
            if (hm) decodeEA(bytes + opOff + 2, p, ripBase + opOff + 2, 0, out.ea);
            return true;
        }
        if (op2 == 0xA3 || op2 == 0xAB || op2 == 0xB3 || op2 == 0xBB) {
            // BT/BTS/BTR/BTC r/m16/32/64, r16/32/64. sub = 0(BT)/1(BTS)/
            // 2(BTR)/3(BTC) = (op2 - 0xA3) >> 3. The bit index is in the
            // ModRM reg field (always a register); the target is r/m.
            // Mirrors cpu64.cpp: bit = idx & (width-1); CF = (v>>bit)&1;
            // BTS/BTR/BTC modify the bit. Only CF touched.
            U8 rf; bool rr; U8 ri; bool hm;
            U32 ml = scanModRM(bytes + opOff + 2, byteCount - (opOff + 2), p, rf, rr, ri, hm);
            if (!ml) return false;
            out.kind = J64_BT;
            out.sub = (U8)((op2 - 0xA3) >> 3);
            out.size = size;
            out.len = (U8)(opOff + 2 + ml);
            out.regField = rf; out.rmIndex = ri; out.isMem = hm;
            if (hm) decodeEA(bytes + opOff + 2, p, ripBase + opOff + 2, 0, out.ea);
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

    // PUSH r64 (50+rd) / POP r64 (58+rd). Always 64-bit in long mode:
    // the interpreter (cpu64.cpp dsp_0/dsp_1) ignores the 0x66 operand-size
    // override on near push/pop of GPRs, so the decoder sets size=8
    // unconditionally. sub: 0 = register form (imm and r/m forms below
    // use sub 1/2).
    if (op >= 0x50 && op <= 0x57) {
        out.kind = J64_PUSH;
        out.sub = 0;
        out.size = 8;
        out.regField = (U8)((op - 0x50) | ((p.rex & 0x01) ? 0x08 : 0));
        out.len = (U8)(opOff + 1);
        return true;
    }
    if (op >= 0x58 && op <= 0x5F) {
        out.kind = J64_POP;
        out.sub = 0;
        out.size = 8;
        out.regField = (U8)((op - 0x58) | ((p.rex & 0x01) ? 0x08 : 0));
        out.len = (U8)(opOff + 1);
        return true;
    }
    // PUSH imm8 (6A) / PUSH imm32 sign-extended (68). Always a 64-bit push
    // in long mode (cpu64.cpp dsp_22); the immediate is sign-extended to
    // 64 bits at decode. Segment pushes (06/0E/16/1E/0F A0/A8) are #UD in
    // the interpreter and stay unknown here.
    if (op == 0x68 || op == 0x6A) {
        U32 isz = (op == 0x6A) ? 1 : 4;
        if (opOff + 1 + isz > byteCount) return false;
        S64 imm = (op == 0x6A) ? (S64)(S8)bytes[opOff + 1]
                               : (S64)(S32)readU32(bytes + opOff + 1);
        out.kind = J64_PUSH;
        out.sub = 1; // immediate form
        out.size = 8;
        out.imm = (U64)imm;
        out.len = (U8)(opOff + 1 + isz);
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
    // MOV r/m, r / MOV r, r/m (88/89/8A/8B). 8-bit forms (88/8A) use size 1;
    // the 0x66 prefix is ignored for them, matching the interpreter
    // (cpu64.cpp dsp_9/dsp_10 hardcode the width). Memory forms decode the
    // EA (needed by the wasm mem path); the 89/8B EA was previously never
    // read (mem 89/8B stays interpreter-fallback at emission).
    if (op == 0x88 || op == 0x89 || op == 0x8A || op == 0x8B) {
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml) return false;
        out.kind = (op == 0x88 || op == 0x89) ? J64_MOV_RM_R : J64_MOV_R_RM;
        out.size = (op == 0x88 || op == 0x8A) ? 1 : size;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, 0, out.ea);
        return true;
    }
    // ALU r/m, r / r, r/m (00..3B except /6 /7 rows: 06,07,0E,...).
    // 8-bit forms (form 0/2) use size 1; the 0x66 prefix is ignored for them.
    if (op <= 0x3D && ((op & 0x06) != 0x06) && (op & 0x7) <= 3) {
        U8 form = (U8)(op & 0x7);
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml) return false;
        out.kind = (form < 2) ? J64_ALU_RM_R : J64_ALU_R_RM;
        out.sub = (op >> 3) & 0x7;
        out.size = (form & 1) ? size : 1;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, 0, out.ea);
        return true;
    }
    // ALU ACC, imm (04/05, 0C/0D, 14/15, 1C/1D, 24/25, 2C/2D, 34/35, 3C/3D).
    // A8/A9 are TEST AL/AX/EAX/RAX, imm (decoded as J64_ALU_ACC_IMM sub=8).
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
    if (op == 0xA8 || op == 0xA9) {
        U32 isz = (op == 0xA8) ? 1 : (rexW ? 4 : (p.osize16 ? 2 : 4));
        if (opOff + 1 + isz > byteCount) return false;
        out.kind = J64_ALU_ACC_IMM;
        out.sub = 8; // TEST marker (flags-only, like J64_TEST_RM_R)
        if (op == 0xA8) { out.imm = bytes[opOff + 1]; out.size = 1; }
        else if (rexW) { out.imm = (U64)(S64)(S32)readU32(bytes + opOff + 1); out.size = 8; }
        else if (p.osize16) {
            out.imm = bytes[opOff + 1] | ((U32)bytes[opOff + 2] << 8);
            out.size = 2;
        } else { out.imm = readU32(bytes + opOff + 1); out.size = 4; }
        out.len = (U8)(opOff + 1 + isz);
        out.regField = 0; // ACC = RAX
        return true;
    }
    // 0x80/0x81/0x83 imm-group ALU (0x80 is the 8-bit form; 0x66/REX.W ignored).
    if (op == 0x80 || op == 0x81 || op == 0x83) {
        U8 isz = (op == 0x80) ? 1 : size;
        U32 trailing = (op == 0x81) ? (isz == 2 ? 2u : 4u) : 1u;
        // Need modrm + trailing bytes present.
        U32 avail = byteCount - (opOff + 1);
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, avail, p, rf, rr, ri, hm);
        if (!ml || avail < ml + trailing) return false;
        out.kind = J64_ALU_RM_IMM;
        out.sub = rf & 0x7;
        const U8* ip = bytes + opOff + 1 + ml;
        if (op == 0x80 || op == 0x83) {
            S8 i8 = (S8)ip[0];
            out.imm = (U64)(S64)i8;
            if (isz == 4) out.imm &= 0xFFFFFFFFULL;
            else if (isz == 2) out.imm &= 0xFFFFULL;
        } else if (isz == 2) {
            out.imm = ip[0] | ((U32)ip[1] << 8);
        } else if (isz == 4) {
            out.imm = readU32(ip);
        } else {
            out.imm = (U64)(S64)(S32)readU32(ip);
        }
        out.size = isz;
        out.len = (U8)(opOff + 1 + ml + trailing);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, trailing, out.ea);
        return true;
    }
    // TEST r/m, r (0x84 is the 8-bit form; 0x66/REX.W ignored).
    if (op == 0x84 || op == 0x85) {
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml) return false;
        out.kind = J64_TEST_RM_R;
        out.size = (op == 0x84) ? 1 : size;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, 0, out.ea);
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
        decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, 0, out.ea);
        return true;
    }
    // MOVSXD r, r/m32 (0x63): sub 4 of the J64_MOVX family. With REX.W the
    // 32-bit source is sign-extended to 64 bits; without, it is a 32-bit
    // copy (setU32). The interpreter (cpu64.cpp dsp_40) ignores 0x66 and
    // always loads 32 bits, so the decoder sets size 4/8 unconditionally;
    // the classifier's osize16 guard keeps 0x66 forms on the interpreter.
    // Register-direct only at emission (mirrors the 0F MOVX scope); memory
    // forms decode (isMem) but stay fallback via jit64EmitWasm acceptance.
    if (op == 0x63) {
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml) return false;
        out.kind = J64_MOVX;
        out.sub = 4; // MOVSXD: 32-bit source, sign-extended
        out.size = rexW ? 8 : 4;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        return true;
    }
    // MOV r/m, imm (C6 /0, C7 /0). C6 is the 8-bit form: 1-byte
    // immediate, size always 1 (0x66/REX.W ignored, matching the
    // interpreter which hardcodes width 1 in dsp_12). C7 is the
    // 16/32/64-bit form with a 4-byte immediate.
    if (op == 0xC6 || op == 0xC7) {
        U8 rf; bool rr; U8 ri; bool hm;
        U32 avail = byteCount - (opOff + 1);
        U32 ml = scanModRM(bytes + opOff + 1, avail, p, rf, rr, ri, hm);
        if (!ml || (rf & 0x7) != 0) return false;
        const U8* ip = bytes + opOff + 1 + ml;
        out.kind = J64_MOV_RM_IMM;
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        if (op == 0xC6) {
            if (avail < ml + 1) return false;
            out.size = 1;
            out.imm = (U64)ip[0];
            out.len = (U8)(opOff + 1 + ml + 1);
        } else {
            if (avail < ml + 4) return false;
            S32 i32 = (S32)readU32(ip);
            out.size = size;
            out.imm = (size == 8) ? (U64)(S64)i32 : (U64)(U32)i32;
            out.len = (U8)(opOff + 1 + ml + 4);
        }
        if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, 0, out.ea);
        return true;
    }
    // SHIFT r/m, imm8 (C0 is the 8-bit form; 0x66/REX.W ignored).
    // D0/D1 are shift/rotate by implicit 1 (same /0../7 sub-ops; D0 is
    // 8-bit, D1 takes the operand size from prefixes). Memory forms fill
    // the EA so the mem emitters can use them (C1-mem was previously
    // decode-only/fallback).
    if (op == 0xC0 || op == 0xC1 || op == 0xD0 || op == 0xD1) {
        bool isD01 = (op == 0xD0 || op == 0xD1);
        U8 ssz = (op == 0xC0 || op == 0xD0) ? 1 : size;
        U8 rf; bool rr; U8 ri; bool hm;
        U32 avail = byteCount - (opOff + 1);
        U32 ml = scanModRM(bytes + opOff + 1, avail, p, rf, rr, ri, hm);
        if (!ml) return false;
        U8 count;
        U32 immLen;
        if (isD01) {
            count = 1;
            immLen = 0;
        } else {
            if (avail < ml + 1) return false;
            count = bytes[opOff + 1 + ml];
            immLen = 1;
        }
        out.kind = J64_SHIFT_IMM;
        out.sub = rf & 0x7;
        out.size = ssz;
        out.imm = count & ((ssz == 8) ? 0x3F : 0x1F);
        out.len = (U8)(opOff + 1 + ml + immLen);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, immLen, out.ea);
        return true;
    }
    // SHIFT/ROTATE r/m, CL (D2 is the 8-bit form; D3 takes the operand
    // size from prefixes). The count is dynamic: CL & 0xFF at runtime,
    // masked to 0x1F (0x3F for 64-bit) by the emitter, mirroring the
    // interpreter's dsp_41 count handling.
    // Memory forms fill the EA so the mem emitters can use them.
    if (op == 0xD2 || op == 0xD3) {
        U8 ssz = (op == 0xD2) ? 1 : size;
        U8 rf; bool rr; U8 ri; bool hm;
        U32 avail = byteCount - (opOff + 1);
        U32 ml = scanModRM(bytes + opOff + 1, avail, p, rf, rr, ri, hm);
        if (!ml) return false;
        out.kind = J64_SHIFT_CL;
        out.sub = rf & 0x7;
        out.size = ssz;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, 0, out.ea);
        return true;
    }
    // F6/F7 group 3. /5 (IMUL r/m, one-operand) keeps the proven
    // J64_IMUL_1OP path. /0 TEST r/m,imm, /2 NOT, /3 NEG, /4 MUL r/m
    // (unsigned) decode as J64_GRP3 with sub = the ModRM reg field.
    // /1 is an invalid encoding; /6 /7 DIV/IDIV stay unknown (fallback):
    // their #DE path delivers a host SIGFPE with exact register state
    // and may redirect RIP to a handler, which the straight-line wasm
    // block model cannot represent (no mid-block bail; tryWasmExec does
    // not catch traps). The interpreter implements them exactly.
    // F6 is the 8-bit form (0x66 ignored, like the interpreter);
    // F7 uses the operand size.
    if (op == 0xF6 || op == 0xF7) {
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml) return false;
        U8 sub = rf & 0x7;
        if (sub == 5) {
            out.kind = J64_IMUL_1OP;
            out.size = (op == 0xF6) ? 1 : size;
            out.len = (U8)(opOff + 1 + ml);
            out.regField = rf; out.rmIndex = ri; out.isMem = hm;
            return true;
        }
        if (sub != 0 && sub != 2 && sub != 3 && sub != 4) return false;
        U8 grpsize = (op == 0xF6) ? 1 : size;
        out.kind = J64_GRP3;
        out.sub = sub;
        out.size = grpsize;
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        if (sub == 0) {
            // TEST r/m,imm: trailing immediate (imm8/imm16/imm32, or
            // sign-extended imm32 for 64-bit, mirroring dsp_31). The
            // immediate shifts RIP-relative addressing, so decodeEA gets
            // the immediate length (the interpreter adds it to effAddr).
            U32 immLen = (grpsize == 1) ? 1 : (grpsize == 2) ? 2 : 4;
            U32 avail = byteCount - (opOff + 1);
            if (avail < ml + immLen) return false;
            const U8* ip = bytes + opOff + 1 + ml;
            if (grpsize == 1) out.imm = ip[0];
            else if (grpsize == 2) out.imm = (U64)(ip[0] | ((U16)ip[1] << 8));
            else if (grpsize == 4) out.imm = readU32(ip);
            else out.imm = (U64)(S64)(S32)readU32(ip);
            out.len = (U8)(opOff + 1 + ml + immLen);
            if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, immLen, out.ea);
        } else {
            out.len = (U8)(opOff + 1 + ml);
            if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, 0, out.ea);
        }
        return true;
    }
    // PUSH r/m64 (FF /6). Always 64-bit in long mode (cpu64.cpp: the /6
    // sub-op does loadRM(m, 8) then push64). mod==3 is the register-direct
    // form (isMem=false); otherwise the EA is decoded (pre-instruction
    // register values, mirroring decodeModRM in cpu64.cpp).
    if (op == 0xFF) {
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml || (rf & 0x7) != 6) return false;
        out.kind = J64_PUSH;
        out.sub = 2; // r/m form
        out.size = 8;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, 0, out.ea);
        return true;
    }
    // POP r/m64 (8F /0). Always 64-bit in long mode (cpu64.cpp dsp_34:
    // pop64 then storeRM(m, 8)). The EA is computed at decode time from
    // pre-instruction registers (decodeModRM runs before pop64 in the
    // interpreter), so RSP-relative EAs use the old RSP.
    if (op == 0x8F) {
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml || (rf & 0x7) != 0) return false;
        out.kind = J64_POP;
        out.sub = 1; // r/m form (sub 0 = register form from 58-5F)
        out.size = 8;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        if (hm) decodeEA(bytes + opOff + 1, p, ripBase + opOff + 1, 0, out.ea);
        return true;
    }
    // 69/6B: three-operand IMUL r, r/m, imm. 6B takes a sign-extended imm8;
    // 69 takes imm16 under 0x66 else imm32 (sign-extended for 64-bit).
    if (op == 0x69 || op == 0x6B) {
        // 6B takes a sign-extended imm8; 69 takes imm16 under 0x66 else imm32.
        // The operand size is the regular opSize for both.
        U32 trailing = (op == 0x6B) ? 1u : (size == 2 ? 2u : 4u);
        U32 avail = byteCount - (opOff + 1);
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, avail, p, rf, rr, ri, hm);
        if (!ml || avail < ml + trailing) return false;
        const U8* ip = bytes + opOff + 1 + ml;
        out.kind = J64_IMUL_3OP;
        out.size = size;
        if (op == 0x6B) out.imm = (U64)(S64)(S8)ip[0];
        else if (size == 2) out.imm = (U64)(S64)(S16)(ip[0] | ((U16)ip[1] << 8));
        else out.imm = (U64)(S64)(S32)readU32(ip);
        out.len = (U8)(opOff + 1 + ml + trailing);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        return true;
    }
    // String ops: MOVS (A4/A5), CMPS (A6/A7), STOS (AA/AB), SCAS (AE/AF).
    // A8/A9 are TEST AL/AX,imm (not string ops); AC/AD are LODS, which the
    // interpreter does not implement (must stay #UD via fallback); LOCK is
    // rejected (the interpreter ignores it, so fallback preserves behavior).
    // Segment prefixes are ignored, matching dsp_43/dsp_44 (they never
    // consult p.seg); REX.W selects 8-byte size via opSize, like the
    // interpreter.
    if (((op >= 0xA4 && op <= 0xA7) || op == 0xAA || op == 0xAB ||
         op == 0xAE || op == 0xAF) && !p.lock) {
        U8 sub = (op <= 0xA5) ? 0 : (op <= 0xA7) ? 2 : (op <= 0xAB) ? 1 : 3;
        out.kind = J64_STRING;
        out.sub = sub;
        out.size = ((op & 1) == 0) ? 1 : (p.rex & 0x08) ? 8 : (p.osize16 ? 2 : 4);
        out.rep = p.rep;
        out.asize32 = p.asize32;
        out.len = (U8)(opOff + 1);
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
    if (op == 0x98) {
        // CBW/CWDE/CDQE: sign-extend AL->AX (16-bit, 0x66), AX->EAX
        // (32-bit, default), EAX->RAX (64-bit, REX.W). The `size` local
        // already encodes rexW ? 8 : (osize16 ? 2 : 4), exactly matching
        // the interpreter's opSize (cpu64.cpp dsp_20). Pure RAX transform;
        // no ModRM, no flags, no memory.
        out.kind = J64_CBW;
        out.size = size;
        out.len = (U8)(opOff + 1);
        return true;
    }
    if (op == 0x99) {
        // CWD/CDQ/CQO: sign-extend AX->DX (16-bit, 0x66), EAX->EDX:EAX
        // (32-bit, default), RAX->RDX:RAX (64-bit, REX.W). The size local
        // already encodes rexW ? 8 : (osize16 ? 2 : 4), exactly matching
        // the interpreter opSize (cpu64.cpp dsp_19). RAX is read-only,
        // RDX is written; no flags, no memory, no faults.
        out.kind = J64_CQO;
        out.size = size;
        out.len = (U8)(opOff + 1);
        return true;
    }
    // x87 FPU escape (D8-DF): interpreter-only by design (plan section 12 --
    // the 64-bit guest mandates 80-bit SoftFloat; wasm f64 emission is
    // provably not bit-exact). Decode the exact length via ModRM so the
    // stream truncates precisely here; the op never enters a JIT plan.
    if (op >= 0xD8 && op <= 0xDF) {
        U8 rf; bool rr; U8 ri; bool hm;
        U32 ml = scanModRM(bytes + opOff + 1, byteCount - (opOff + 1), p, rf, rr, ri, hm);
        if (!ml) return false;
        out.kind = J64_FPU;
        out.len = (U8)(opOff + 1 + ml);
        out.regField = rf; out.rmIndex = ri; out.isMem = hm;
        return true;
    }
    return false;
}

void jit64Classify(Jit64Op& op, bool hasLockOrRep, bool osize16) {
    op.plan = JIT64_FALLBACK;
    if (op.kind == J64_STRING) {
        // REP and 0x66/0x67/REX.W are legitimate string-op prefixes (decoded
        // into op.rep/op.size/op.asize32); LOCK was already excluded at decode.
        // F2 (REPNE) only affects CMPS/SCAS, but the interpreter treats any
        // nonzero rep as REP for MOVS/STOS, so all encodings are accepted.
        if (op.sub > 3) return;
        if (op.size != 1 && op.size != 2 && op.size != 4 && op.size != 8) return;
        if (op.rep != 0 && op.rep != 0xF2 && op.rep != 0xF3) return;
        op.plan = JIT64_FAST;
        return;
    }
    // FS/GS-segment memory operands stay interpreter-only: the segment
    // bases live on the CPU object, not in Jit64WasmState. (String ops
    // ignore seg like the interpreter, and are exempt above.)
    if (op.isMem && op.ea.seg != 0) return;
    if (hasLockOrRep) return; // LOCK/REP on non-string ops: interpreter-only
    // osize16 means "0x66 selected a 16-bit operand size" (the caller masks
    // out the redundant-0x66-with-REX.W case, where the size stays 64-bit).
    // 8-bit forms ignore 0x66, so they are exempt.
    if (osize16 && op.size != 1 && op.size != 2) return;
    switch (op.kind) {
    case J64_MOV_RM_R:
    case J64_MOV_R_RM:
        // 8-bit MOV (88/8A) is fast; 16-bit stays fallback (not in the
        // fast set). The 0x66 prefix is ignored for the 8-bit forms (the
        // decoder hardcodes size 1), matching the interpreter.
        if (op.size == 2 || op.sub != 0) return;
        if (op.size != 1 && op.size != 4 && op.size != 8) return;
        op.plan = JIT64_FAST;
        return;
    case J64_MOVX:
        // MOVZX/MOVSX r, r/m (sub 0-3) and MOVSXD r, r/m32 (sub 4);
        // register-direct only at emission.
        if (op.size != 2 && op.size != 4 && op.size != 8) return;
        if (op.sub > 4) return;
        op.plan = JIT64_FAST;
        return;
    case J64_ALU_RM_R:
    case J64_ALU_R_RM:
    case J64_ALU_RM_IMM:
    case J64_ALU_ACC_IMM:
        // sub 8 = TEST acc,imm (A8/A9); otherwise the 0..7 ALU sub-ops.
        if (op.size != 1 && op.size != 2 && op.size != 4 && op.size != 8) return;
        if (op.sub > 8) return;
        op.plan = JIT64_FAST;
        return;
    case J64_SHIFT_IMM:
        if (op.size != 1 && op.size != 2 && op.size != 4 && op.size != 8) return;
        if (op.sub > 7) return;
        // AH/BH/CH/DH (8-bit, rm 4..7, no REX): interpreter-only. The
        // high-byte writeback path in the emitter has a latent bug (fuzz
        // found incorrect results for SHL AH,1); 64-bit code rarely uses
        // these registers. Conservative decline per DIV/IDIV precedent.
        if (op.size == 1 && !op.rexPresent && !op.isMem &&
            op.rmIndex >= 4 && op.rmIndex <= 7) return;
        op.plan = JIT64_FAST;
        return;
    case J64_SHIFT_CL:
        if (op.size != 1 && op.size != 2 && op.size != 4 && op.size != 8) return;
        if (op.sub > 7) return;
        // Same AH/BH/CH/DH decline as J64_SHIFT_IMM (latent high-byte
        // writeback bug found by D1-round fuzz).
        if (op.size == 1 && !op.rexPresent && !op.isMem &&
            op.rmIndex >= 4 && op.rmIndex <= 7) return;
        // Memory forms DECLINED (interpreter-only): the mem emitters'
        // dynamic flag-merge has a bug (flags read as 0 in wasm tests).
        // 16-bit DECLINED: ROL/ROR writeback bug (0xFFFF vs 0x8000 in fuzz).
        // 8-bit rotates (sub 0..3, size 1) DECLINED: result bug (fuzz shows
        // 0xFF instead of correct rotate; 8-bit shifts work fine).
        // 32/64-bit rotates ENABLED: fixed the reg-direct rotateCL OF block
        // which was copy-pasted shift logic (sub==4/5/6 checks, L_T2 for
        // count). Now uses rotate OF semantics (ROL/RCL: MSB^CF, ROR/RCR:
        // MSB^((result<<1)&sb)) with count in L_T1. Verified by 600-case fuzz.
        if (op.isMem) return;
        if (op.size == 2) return;
        if (op.sub <= 3 && op.size == 1) return;
        op.plan = JIT64_FAST;
        return;
    case J64_IMUL_R_RM:
        if (op.size == 1) return;
        op.plan = JIT64_FAST;
        return;
    case J64_IMUL_1OP:
    case J64_IMUL_3OP:
        if (op.size != 1 && op.size != 2 && op.size != 4 && op.size != 8) return;
        op.plan = JIT64_FAST;
        return;
    case J64_GRP3:
        // F6/F7 group 3: /0 TEST, /2 NOT, /3 NEG, /4 MUL. The decoder
        // only produces these four sub-ops (/1 invalid, /5 is
        // J64_IMUL_1OP, /6 /7 DIV/IDIV never decode here); re-check
        // defensively. F6 is always 8-bit (0x66 ignored, matching the
        // interpreter); F7 takes 2/4/8.
        if (op.size != 1 && op.size != 2 && op.size != 4 && op.size != 8) return;
        if (op.sub != 0 && op.sub != 2 && op.sub != 3 && op.sub != 4) return;
        op.plan = JIT64_FAST;
        return;
    case J64_CMOV:
        // CMOVcc r, r/m16/32/64: sizes 2/4/8 (never 8-bit, so no
        // AH/BH/CH/DH high-byte concern). sub = condition 0..15 (the
        // decoder sets it from the opcode; re-check defensively).
        // Memory sources are always loaded (faults even if the
        // condition is false); FS/GS and LOCK are already rejected by
        // the generic guards above. No flags are touched.
        if (op.size != 2 && op.size != 4 && op.size != 8) return;
        if (op.sub > 15) return;
        op.plan = JIT64_FAST;
        return;
    case J64_SETCC:
        // SETcc r/m8: always size 1 (0x66/REX.W ignored by decoder).
        // sub = condition 0..15. Dest is r/m8 (reg or mem); the value
        // written is 0 or 1 based on RFLAGS. No flags are touched.
        // AH/BH/CH/DH (8-bit, rm 4..7, no REX, reg-direct):
        // interpreter-only (latent high-byte writeback bug, D1 round).
        if (op.size != 1) return;
        if (op.sub > 15) return;
        if (!op.rexPresent && !op.isMem &&
            op.rmIndex >= 4 && op.rmIndex <= 7) return;
        op.plan = JIT64_FAST;
        return;
    case J64_BT:
        // BT/BTS/BTR/BTC r/m16/32/64, r16/32/64: sub = 0(BT)/1(BTS)/
        // 2(BTR)/3(BTC). Bit index in regField (always a GPR); target
        // in rmIndex (reg) or EA (mem). Sizes 2/4/8 only (no 8-bit form).
        // Only CF is written; other flags preserved.
        if (op.size != 2 && op.size != 4 && op.size != 8) return;
        if (op.sub > 3) return;
        op.plan = JIT64_FAST;
        return;
    case J64_PUSH:
    case J64_POP:
        // Near PUSH/POP are always 64-bit in long mode (the interpreter
        // ignores 0x66); the decoder sets size=8 unconditionally. 0x66
        // forms stay fallback via the generic osize16 guard above.
        if (op.size != 8) return;
        if (op.kind == J64_PUSH ? op.sub > 2 : op.sub > 1) return;
        op.plan = JIT64_FAST;
        return;
    case J64_TEST_RM_R:
    case J64_MOV_R_IMM:
    case J64_CALL_REL:
    case J64_JMP_REL:
    case J64_JCC:
    case J64_RET:
    case J64_LEAVE:
    case J64_NOP:
        op.plan = JIT64_FAST;
        return;
    case J64_MOV_RM_IMM:
        // C6 (size 1): AH/BH/CH/DH (rm 4..7, no REX, reg-direct) stay
        // interpreter-only. The high-byte writeback path in the emitter
        // has a latent bug (fuzz found incorrect results for SHL AH,1
        // in the D1 round); 64-bit code rarely uses these registers.
        // Conservative decline per DIV/IDIV precedent. C7 (size 4/8)
        // is unaffected (no high-byte forms).
        if (op.size == 1 && !op.rexPresent && !op.isMem &&
            op.rmIndex >= 4 && op.rmIndex <= 7) return;
        op.plan = JIT64_FAST;
        return;
    case J64_CBW:
        // CBW/CWDE/CDQE: 16/32/64-bit all reach emission (the interpreter's
        // dsp_20 handles all three; buildBlock decodes all three too).
        // The generic osize16 guard above already permits size==2 here.
        if (op.size != 2 && op.size != 4 && op.size != 8) return;
        op.plan = JIT64_FAST;
        return;
    case J64_CQO:
        // CWD/CDQ/CQO: 16/32/64-bit all reach emission (the interpreter
        // dsp_19 handles all three; buildBlock decodes all three too).
        // The generic osize16 guard above already permits size==2 here.
        if (op.size != 2 && op.size != 4 && op.size != 8) return;
        op.plan = JIT64_FAST;
        return;
    case J64_LEA:
        // 16-bit LEA is not in the interpreter's block set (buildBlock
        // breaks on size==2); only 32/64-bit forms reach emission.
        if (op.size != 4 && op.size != 8) return;
        op.plan = JIT64_FAST;
        return;
    case J64_SYSCALL:
    case J64_FPU: // x87: interpreter-only by design (plan section 12); never fast
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
        if (op.kind == J64_FPU) break; // x87 is interpreter-only (plan section 12); truncate, keep the fast prefix
        if (op.len == 0) break;
        jit64Classify(op, p.lock || p.rep != 0, p.osize16 && !(p.rex & 0x08));
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

Jit64Block* Jit64BlockCache::lookup(U64 rip, U64 page0, U32 gen0, U64 page1, U32 gen1) {
    m_lookups++;
    if (rip == 0) return nullptr;
    Jit64Block& b = m_slots[slotFor(rip)].block;
    if (b.startRip != rip) return nullptr;
    if (b.page0 != page0 || b.gen0 != gen0) return nullptr;
    if (b.page1 != page1 || b.gen1 != gen1) return nullptr;
    if (!b.executable) return nullptr;
    m_hits++;
    return &b;
}

Jit64Block* Jit64BlockCache::insert(U64 rip, U64 page0, U32 gen0, U64 page1, U32 gen1,
                                          const Jit64Op* ops, U32 nOps) {
    if (rip == 0 || !ops || nOps == 0) return nullptr;
    m_inserts++;
    Jit64Block& b = m_slots[slotFor(rip)].block;
    // Slot overwrite frees the previous block's instantiated module, if any.
    if (b.wasmIndex >= 0) jit64WasmRelease(b.wasmIndex);
    b.wasmIndex = -1;
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
    if (b.startRip == rip) {
        if (b.wasmIndex >= 0) jit64WasmRelease(b.wasmIndex);
        b.startRip = 0;
        b.wasmIndex = -1;
    }
}

void Jit64BlockCache::clear() {
    for (U32 i = 0; i < SLOTS; i++) {
        Jit64Block& b = m_slots[i].block;
        if (b.wasmIndex >= 0) jit64WasmRelease(b.wasmIndex);
        b = Jit64Block();
    }
    m_lookups = m_hits = m_inserts = 0;
}

// §14.3: the wasm module executes a whole block with no mid-block page-
// generation checks -- unlike execBlock/execBlockThreaded, which stop at the
// next record after a guest store bumps a page generation. If a block stores
// into its own code range, the module would run stale immediates/decoding
// for the later ops (the store itself goes through jit64MemWrite and does
// bump the generation, but nothing re-checks it mid-module). Decline the
// wasm vehicle for any block that may store to guest memory; the execBlock
// vehicle (with per-record checks) stays correct. Conservative by design:
// a precise "store targets our own pages" test is impossible statically for
// register-indirect stores, and correctness outranks the phase-2 vehicle.
bool jit64BlockMayStore(const Jit64Op* ops, U32 nOps) {
    if (!ops) return true;
    for (U32 i = 0; i < nOps; i++) {
        const Jit64Op& op = ops[i];
        switch (op.kind) {
        case J64_MOV_RM_R:
        case J64_ALU_RM_R:
        case J64_ALU_RM_IMM:
        case J64_SHIFT_IMM:
        case J64_SHIFT_CL:
        case J64_MOV_RM_IMM:
            if (op.isMem) return true;
            break;
        case J64_STRING:
            if (op.sub == 0 || op.sub == 1) return true; // MOVS/STOS store
            break;
        case J64_GRP3:
            // NOT/NEG r/m (sub 2/3) store to guest memory via the
            // imported helper; TEST (sub 0) and MUL (sub 4) never do
            // (MUL writes RAX/RDX, which are wasm locals).
            if (op.isMem && (op.sub == 2 || op.sub == 3)) return true;
            break;
        case J64_PUSH:
            return true; // stack store; a pathological rsp could hit code
        case J64_POP:
            // POP r/m (8F /0, mod!=3) stores to guest memory via storeRM;
            // same hazard as PUSH. Register POPs only touch wasm locals.
            if (op.isMem) return true;
            break;
        default:
            break;
        }
    }
    return false;
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
