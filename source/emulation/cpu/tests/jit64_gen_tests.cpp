// Copyright (C) 2026 The BoxedWine Team. GPL-2.0-or-later.
// jit64_gen_tests.cpp — byte-identical verification for the table-driven
// emitter migration (see source/emulation/cpu/jit64table.mjs).
//
// For every op kind with both a hand-written emitter and a table-generated
// one, this test emits the op through jit64EmitOld (hand-written) and
// jit64EmitNew (generated) and requires BYTE-IDENTICAL output (both the
// emitted wasm bytes and the "register written" return value).
//
// Corpus: direct Jit64Op construction (adversarial: all sizes, all subs,
// high-byte 8-bit registers with/without REX, all immediates) plus
// decode-driven ops (jit64DecodeOne on biased-random bytes, classified).
// Built with -DJIT64_GEN_VERIFY=1 and wired into scripts/build-jit-wasm.sh.
#include "jit64wasm.h"

#include <cstdio>
#include <vector>

// Deterministic xorshift64* (fixed seed: the corpus is reproducible).
static U64 rngState = 0x9E3779B97F4A7C15ULL;
static U64 nextRand() {
    U64 x = rngState;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    rngState = x;
    return x * 0x2545F4914F6CDD1DULL;
}

static U64 compared = 0;
static U64 skipped = 0;
static int failures = 0;

static void checkOp(const Jit64Op& op, const char* tag) {
    std::vector<U8> bOld, bNew;
    U32 rOld = jit64EmitOld(bOld, op);
    U32 rNew = jit64EmitNew(bNew, op);
    // rOld == 0xFE means the kind's hand-written emitter is gone (group
    // already migrated): nothing to compare, skip. rNew == 0xFE with a live
    // old emitter is a coverage mismatch (fail).
    if (rOld == 0xFE) { skipped++; return; }
    if (rNew == 0xFE) {
        failures++;
        printf("COVERAGE-MISMATCH %s kind=%d isMem=%d: old=%u new=%u\n",
               tag, (int)op.kind, (int)op.isMem, rOld, rNew);
        return;
    }
    compared++;
    if (rOld != rNew || bOld != bNew) {
        failures++;
        if (failures <= 5) {
            printf("MISMATCH %s kind=%d sub=%u size=%u rm=%u reg=%u imm=0x%llx rex=%d: "
                   "old(r=%u,len=%zu) vs new(r=%u,len=%zu)\n",
                   tag, (int)op.kind, op.sub, op.size, op.rmIndex, op.regField,
                   (unsigned long long)op.imm, (int)op.rexPresent,
                   rOld, bOld.size(), rNew, bNew.size());
        }
    }
}

static bool isAluKind(Jit64Kind k) {
    return k == J64_ALU_RM_R || k == J64_ALU_R_RM || k == J64_ALU_RM_IMM ||
           k == J64_ALU_ACC_IMM || k == J64_TEST_RM_R;
}

// Direct construction: every ALU kind x size x sub, adversarial registers
// (high-byte 8-bit indices 4..7 with and without REX) and immediates.
static void corpusDirectAlu() {
    const Jit64Kind kinds[] = { J64_ALU_RM_R, J64_ALU_R_RM, J64_ALU_RM_IMM,
                                J64_ALU_ACC_IMM, J64_TEST_RM_R };
    const U8 sizes[] = { 1, 2, 4, 8 };
    for (int iter = 0; iter < 3000; iter++) {
        Jit64Op op;
        op.kind = kinds[nextRand() % 5];
        op.size = sizes[nextRand() % 4];
        op.sub = (U8)(nextRand() % 8);
        if (op.kind == J64_ALU_ACC_IMM && (nextRand() % 4) == 0) op.sub = 8; // TEST
        op.rmIndex = (U8)(nextRand() % 16);
        op.regField = (U8)(nextRand() % 16);
        op.imm = nextRand();
        op.rexPresent = (nextRand() % 2) != 0;
        op.isMem = false;
        // Bias 8-bit ops toward the high-byte indices to stress the
        // AH/BH/CH/DH-vs-REX rule in byteRegParts.
        if (op.size == 1 && (nextRand() % 2)) {
            op.rmIndex = (U8)(4 + nextRand() % 4);
            op.regField = (U8)(4 + nextRand() % 4);
        }
        checkOp(op, "direct");
    }
}

// Decode-driven: biased-random bytes through jit64DecodeOne + jit64Classify.
static void corpusDecodeAlu() {
    for (int iter = 0; iter < 5000; iter++) {
        U8 bytes[16];
        U32 n = 0;
        if (nextRand() % 3 == 0) bytes[n++] = 0x66;
        if (nextRand() % 3 == 0) bytes[n++] = (U8)(0x40 | (nextRand() & 0x0F)); // REX
        U8 sub = (U8)(nextRand() % 8);
        U32 form = (U32)(nextRand() % 8);
        U8 opcode;
        U8 modrm = (U8)(0xC0 | (nextRand() & 0x3F)); // mod=3: register-direct
        U32 immBytes = 0;
        if (form < 6) {
            opcode = (U8)(sub * 8 + form); // 0x00-0x3D
            if (form == 4) immBytes = 1;
            else if (form == 5) immBytes = 4;
        } else if (form == 6) {
            U32 which = (U32)(nextRand() % 3);
            opcode = which == 0 ? 0x80 : (which == 1 ? 0x81 : 0x83);
            modrm = (U8)((modrm & 0xC7) | (sub << 3)); // modrm.reg = sub-op
            immBytes = (opcode == 0x81) ? 4 : 1;
        } else {
            opcode = (nextRand() % 2) ? 0x84 : 0x85; // TEST
        }
        bytes[n++] = opcode;
        if (form != 4 && form != 5) bytes[n++] = modrm; // else acc,imm: no modrm
        for (U32 i = 0; i < immBytes; i++) bytes[n++] = (U8)nextRand();
        Jit64Op op;
        if (!jit64DecodeOne(0x1000, bytes, n, op)) continue;
        jit64Classify(op, false, false);
        if (!isAluKind(op.kind)) continue;
        if (op.isMem) continue; // memory ALU migrates separately
        checkOp(op, "decode");
    }
}

// Direct construction: memory-operand ALU/TEST with random EAs
// (rip-relative, base+index*scale+disp, 0x67 addr-size).
static void corpusDirectAluMem() {
    const Jit64Kind kinds[] = { J64_ALU_RM_R, J64_ALU_R_RM, J64_ALU_RM_IMM,
                                J64_TEST_RM_R };
    const U8 sizes[] = { 1, 2, 4, 8 };
    for (int iter = 0; iter < 2000; iter++) {
        Jit64Op op;
        op.kind = kinds[nextRand() % 4];
        op.size = sizes[nextRand() % 4];
        op.sub = (U8)(nextRand() % 8);
        op.regField = (U8)(nextRand() % 16);
        op.rmIndex = 0xFF; // memory
        op.isMem = true;
        op.imm = nextRand();
        op.rexPresent = (nextRand() % 2) != 0;
        op.ea.ripRel = (nextRand() % 4) == 0;
        if (op.ea.ripRel) {
            op.ea.ripRelTarget = nextRand();
            op.ea.baseReg = 0xFF;
            op.ea.idxReg = 0xFF;
        } else {
            op.ea.baseReg = (nextRand() % 3 == 0) ? 0xFF : (U8)(nextRand() % 16);
            op.ea.idxReg = (nextRand() % 3 == 0) ? 0xFF : (U8)(nextRand() % 16);
            op.ea.ripRelTarget = 0;
        }
        op.ea.scale = (U8)(nextRand() % 4);
        op.ea.disp = (S64)nextRand();
        op.ea.asize32 = (nextRand() % 2) != 0;
        op.ea.seg = 0;
        checkOp(op, "direct-mem");
    }
}

// Decode-driven: ModRM mod != 3 (memory), decoder fills the EA.
static void corpusDecodeAluMem() {
    for (int iter = 0; iter < 3000; iter++) {
        U8 bytes[20];
        U32 n = 0;
        if (nextRand() % 3 == 0) bytes[n++] = 0x66;
        if (nextRand() % 3 == 0) bytes[n++] = (U8)(0x40 | (nextRand() & 0x0F));
        U8 sub = (U8)(nextRand() % 8);
        U32 form = (U32)(nextRand() % 8);
        U8 mod = (U8)(nextRand() % 3); // 0,1,2: memory
        U8 modrm = (U8)((mod << 6) | (nextRand() & 0x3F));
        U8 opcode;
        U32 immBytes = 0;
        if (form < 6) {
            opcode = (U8)(sub * 8 + form);
            if (form == 4) immBytes = 1;
            else if (form == 5) immBytes = 4;
        } else if (form == 6) {
            U32 which = (U32)(nextRand() % 3);
            opcode = which == 0 ? 0x80 : (which == 1 ? 0x81 : 0x83);
            modrm = (U8)((modrm & 0xC7) | (sub << 3));
            immBytes = (opcode == 0x81) ? 4 : 1;
        } else {
            opcode = (nextRand() % 2) ? 0x84 : 0x85;
        }
        bytes[n++] = opcode;
        if (form != 4 && form != 5) bytes[n++] = modrm;
        // SIB/disp/imm: append enough random bytes; the decoder consumes
        // what the ModRM needs and ignores the rest.
        for (int i = 0; i < 6; i++) bytes[n++] = (U8)nextRand();
        for (U32 i = 0; i < immBytes; i++) bytes[n++] = (U8)nextRand();
        Jit64Op op;
        if (!jit64DecodeOne(0x1000, bytes, n, op)) continue;
        jit64Classify(op, false, false);
        if (!isAluKind(op.kind)) continue;
        if (!op.isMem) continue;
        if (op.ea.seg != 0) continue; // emitter rejects seg overrides
        checkOp(op, "decode-mem");
    }
}

// Direct construction: shifts (sub 4/5/6/7), all sizes, counts 0..63.
static void corpusDirectShift() {
    const U8 subs[] = { 4, 5, 6, 7 };
    const U8 sizes[] = { 1, 2, 4, 8 };
    for (int iter = 0; iter < 2000; iter++) {
        Jit64Op op;
        op.kind = J64_SHIFT_IMM;
        op.sub = subs[nextRand() % 4];
        op.size = sizes[nextRand() % 4];
        op.rmIndex = (U8)(nextRand() % 16);
        op.imm = nextRand() & 0x3F; // count, masked like the decoder
        op.rexPresent = (nextRand() % 2) != 0;
        op.isMem = false;
        if (op.size == 1 && (nextRand() % 2))
            op.rmIndex = (U8)(4 + nextRand() % 4);
        checkOp(op, "direct-shift");
    }
}

// Decode-driven: 0xC1 /4../7 (0xC0 for 8-bit), register-direct.
static void corpusDecodeShift() {
    for (int iter = 0; iter < 2000; iter++) {
        U8 bytes[8];
        U32 n = 0;
        if (nextRand() % 3 == 0) bytes[n++] = 0x66;
        if (nextRand() % 3 == 0) bytes[n++] = (U8)(0x40 | (nextRand() & 0x0F));
        U8 sub = (U8)(4 + nextRand() % 4);
        bool is8 = (nextRand() % 4) == 0;
        bytes[n++] = is8 ? 0xC0 : 0xC1;
        bytes[n++] = (U8)(0xC0 | (sub << 3) | (nextRand() & 0x07));
        bytes[n++] = (U8)nextRand(); // count imm8
        Jit64Op op;
        if (!jit64DecodeOne(0x1000, bytes, n, op)) continue;
        jit64Classify(op, false, false);
        if (op.kind != J64_SHIFT_IMM) continue;
        if (op.sub > 7) continue; // rotates handled separately
        checkOp(op, "decode-shift");
    }
}

// Direct construction: rotates (sub 0/1/2/3), all sizes, counts 0..63.
static void corpusDirectRotate() {
    const U8 subs[] = { 0, 1, 2, 3 };
    const U8 sizes[] = { 1, 2, 4, 8 };
    for (int iter = 0; iter < 2000; iter++) {
        Jit64Op op;
        op.kind = J64_SHIFT_IMM;
        op.sub = subs[nextRand() % 4];
        op.size = sizes[nextRand() % 4];
        op.rmIndex = (U8)(nextRand() % 16);
        op.imm = nextRand() & 0x3F;
        op.rexPresent = (nextRand() % 2) != 0;
        op.isMem = false;
        if (op.size == 1 && (nextRand() % 2))
            op.rmIndex = (U8)(4 + nextRand() % 4);
        checkOp(op, "direct-rotate");
    }
}

// Decode-driven: 0xC1 /0../3, register-direct.
static void corpusDecodeRotate() {
    for (int iter = 0; iter < 2000; iter++) {
        U8 bytes[8];
        U32 n = 0;
        if (nextRand() % 3 == 0) bytes[n++] = 0x66;
        if (nextRand() % 3 == 0) bytes[n++] = (U8)(0x40 | (nextRand() & 0x0F));
        U8 sub = (U8)(nextRand() % 4);
        bool is8 = (nextRand() % 4) == 0;
        bytes[n++] = is8 ? 0xC0 : 0xC1;
        bytes[n++] = (U8)(0xC0 | (sub << 3) | (nextRand() & 0x07));
        bytes[n++] = (U8)nextRand();
        Jit64Op op;
        if (!jit64DecodeOne(0x1000, bytes, n, op)) continue;
        jit64Classify(op, false, false);
        if (op.kind != J64_SHIFT_IMM) continue;
        if (op.sub > 3) continue;
        checkOp(op, "decode-rotate");
    }
}

// Direct: IMUL2 (r, r/m), IMUL1 (r/m), IMUL3 (r, r/m, imm).
static void corpusDirectImul() {
    const U8 sizes2[] = { 4, 8 };
    const U8 sizes1[] = { 1, 2, 4, 8 };
    const U8 sizes3[] = { 2, 4, 8 };
    for (int iter = 0; iter < 1500; iter++) {
        Jit64Op op;
        op.kind = J64_IMUL_R_RM;
        op.size = sizes2[nextRand() % 2];
        op.regField = (U8)(nextRand() % 16);
        op.rmIndex = (U8)(nextRand() % 16);
        op.isMem = false;
        checkOp(op, "direct-imul2");
    }
    for (int iter = 0; iter < 1500; iter++) {
        Jit64Op op;
        op.kind = J64_IMUL_1OP;
        op.size = sizes1[nextRand() % 4];
        op.rmIndex = (U8)(nextRand() % 16);
        op.rexPresent = (nextRand() % 2) != 0;
        op.isMem = false;
        if (op.size == 1 && (nextRand() % 2))
            op.rmIndex = (U8)(4 + nextRand() % 4);
        checkOp(op, "direct-imul1");
    }
    for (int iter = 0; iter < 1500; iter++) {
        Jit64Op op;
        op.kind = J64_IMUL_3OP;
        op.size = sizes3[nextRand() % 3];
        op.regField = (U8)(nextRand() % 16);
        op.rmIndex = (U8)(nextRand() % 16);
        op.imm = nextRand();
        op.isMem = false;
        checkOp(op, "direct-imul3");
    }
}

// Decode-driven: 0F AF, F6/F7 /5, 6B/69.
static void corpusDecodeImul() {
    for (int iter = 0; iter < 1500; iter++) {
        U8 bytes[10];
        U32 n = 0;
        if (nextRand() % 3 == 0) bytes[n++] = 0x66;
        if (nextRand() % 2) bytes[n++] = (U8)(0x40 | (nextRand() & 0x0F));
        U32 which = (U32)(nextRand() % 3);
        if (which == 0) {
            bytes[n++] = 0x0F; bytes[n++] = 0xAF;
            bytes[n++] = (U8)(0xC0 | (nextRand() & 0x3F));
        } else if (which == 1) {
            bool is8 = (nextRand() % 2) != 0;
            bytes[n++] = is8 ? 0xF6 : 0xF7;
            bytes[n++] = (U8)(0xC0 | (5 << 3) | (nextRand() & 0x07));
        } else {
            bool imm8 = (nextRand() % 2) != 0;
            bytes[n++] = imm8 ? 0x6B : 0x69;
            bytes[n++] = (U8)(0xC0 | (nextRand() & 0x3F));
            bytes[n++] = (U8)nextRand();
            if (!imm8) { bytes[n++] = (U8)nextRand(); bytes[n++] = (U8)nextRand(); bytes[n++] = (U8)nextRand(); }
        }
        Jit64Op op;
        if (!jit64DecodeOne(0x1000, bytes, n, op)) continue;
        jit64Classify(op, false, false);
        if (op.kind != J64_IMUL_R_RM && op.kind != J64_IMUL_1OP && op.kind != J64_IMUL_3OP) continue;
        checkOp(op, "decode-imul");
    }
}

// Direct: MOVX (sub 0-4; 4=MOVSXD), String (sub 0-3, rep, asize32).
static void corpusDirectMovx() {
    const U8 subs[] = { 0, 1, 2, 3, 4 };
    const U8 sizes[] = { 2, 4, 8 };
    for (int iter = 0; iter < 1500; iter++) {
        Jit64Op op;
        op.kind = J64_MOVX;
        op.sub = subs[nextRand() % 5];
        op.size = sizes[nextRand() % 3];
        if (op.sub == 4 && op.size == 2)
            op.size = (nextRand() % 2) ? 4 : 8; // MOVSXD: 32/64-bit dest only
        op.regField = (U8)(nextRand() % 16);
        op.rmIndex = (U8)(nextRand() % 16);
        op.rexPresent = (nextRand() % 2) != 0;
        op.isMem = false;
        // 8-bit src high-byte stress.
        U8 srcSize = (op.sub == 0 || op.sub == 2) ? 1 : (op.sub == 4 ? 4 : 2);
        if (srcSize == 1 && (nextRand() % 2))
            op.rmIndex = (U8)(4 + nextRand() % 4);
        checkOp(op, "direct-movx");
    }
}

static void corpusDecodeMovx() {
    for (int iter = 0; iter < 1500; iter++) {
        U8 bytes[8];
        U32 n = 0;
        if (nextRand() % 2) bytes[n++] = (U8)(0x40 | (nextRand() & 0x0F));
        if (nextRand() % 5 == 4) {
            bytes[n++] = 0x63; // MOVSXD /r (sub 4)
        } else {
            U32 which = (U32)(nextRand() % 4);
            bytes[n++] = 0x0F;
            bytes[n++] = (U8)(0xB6 + which); // B6/B7/BE/BF
        }
        bytes[n++] = (U8)(0xC0 | (nextRand() & 0x3F));
        Jit64Op op;
        if (!jit64DecodeOne(0x1000, bytes, n, op)) continue;
        jit64Classify(op, false, false);
        if (op.kind != J64_MOVX) continue;
        checkOp(op, "decode-movx");
    }
}

static void corpusDirectString() {
    const U8 subs[] = { 0, 1, 2, 3 };
    const U8 sizes[] = { 1, 2, 4, 8 };
    const U8 reps[] = { 0, 0xF2, 0xF3 };
    for (int iter = 0; iter < 1500; iter++) {
        Jit64Op op;
        op.kind = J64_STRING;
        op.sub = subs[nextRand() % 4];
        op.size = sizes[nextRand() % 4];
        op.rep = reps[nextRand() % 3];
        op.asize32 = (nextRand() % 2) != 0;
        op.isMem = false;
        checkOp(op, "direct-string");
    }
}

static void corpusDecodeString() {
    for (int iter = 0; iter < 1500; iter++) {
        U8 bytes[8];
        U32 n = 0;
        if (nextRand() % 3 == 0) bytes[n++] = 0x67;
        U32 repRoll = (U32)(nextRand() % 3);
        if (repRoll == 1) bytes[n++] = 0xF2;
        else if (repRoll == 2) bytes[n++] = 0xF3;
        U8 sub = (U8)(nextRand() % 4);
        // A4/A5=MOVS, AA/AB=STOS, A6/A7=CMPS, AC/AD=SCAS
        U8 base = sub == 0 ? 0xA4 : (sub == 1 ? 0xAA : (sub == 2 ? 0xA6 : 0xAC));
        if ((nextRand() % 2) && sub != 1) base |= 0x01; // word form (not STOS)
        bytes[n++] = base;
        Jit64Op op;
        if (!jit64DecodeOne(0x1000, bytes, n, op)) continue;
        jit64Classify(op, false, false);
        if (op.kind != J64_STRING) continue;
        checkOp(op, "decode-string");
    }
}

int main() {
    corpusDirectAlu();
    corpusDecodeAlu();
    corpusDirectAluMem();
    corpusDecodeAluMem();
    corpusDirectShift();
    corpusDecodeShift();
    corpusDirectRotate();
    corpusDecodeRotate();
    corpusDirectImul();
    corpusDecodeImul();
    corpusDirectMovx();
    corpusDecodeMovx();
    corpusDirectString();
    corpusDecodeString();
    printf("jit64_gen_tests: compared=%llu skipped=%llu failures=%d\n",
           (unsigned long long)compared, (unsigned long long)skipped, failures);
    if (failures) {
        printf("FAIL: generated emitters differ from hand-written ones\n");
        return 1;
    }
    printf("OK: all generated emitters byte-identical\n");
    return 0;
}
