/*
 *  Copyright (C) 2012-2026  The BoxedWine Team
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  jit64.h — Phase-1 JIT framework for the 64-bit guest (CPU64).
 *
 *  Strategy (per tasks/jit-port-plan.md §3.1 "recommend the former with a thin
 *  adapter"): build on cpu64's OWN BBlock/BRec IR rather than forcing cpu64
 *  onto the 32-bit DecodedOp pipeline. Phase 1 implements:
 *
 *    1. A block cache (hash on startRip + page generations, same validity
 *       contract as BOXEDWINE_BLOCK_EXEC's blockTable).
 *    2. A "compiled block" representation (Jit64Block): for phase 1 this is a
 *       validated + ranked copy of the BBlock recipe stream with a dispatch
 *       plan per record (inline-fast vs interpreter-fallback), NOT yet native
 *       machine code. The wasm-module emitter (phase 2, emcc-gated) consumes
 *       exactly this plan; phase 1 proves the decode/classify/cache seams.
 *    3. A runtime flag (BW64_JIT=1) so default behavior is unchanged.
 *
 *  Fallback rule: any record the JIT cannot prove fast stays on the
 *  interpreter path (execute via CPU64's execBlock/step). A compiled block is
 *  only entered when EVERY record in it has a fast plan; otherwise the whole
 *  block falls back. This keeps phase-1 semantics bit-identical by
 *  construction.
 */

#ifndef BOXEDWINE_JIT64_H
#define BOXEDWINE_JIT64_H

// NOTE: deliberately does NOT include boxedwine.h (which drags in SDL/simde
// via common/cpu.h). Only needs the U8/U32/U64/S64 basement types.
#include "platformtypes.h"

#include <cstddef>
#include <cstdint>
#include <vector>

// NOTE: intentionally NOT gated on BOXEDWINE_GUEST_X64 so the native
// unit-test harness can compile this header standalone with plain g++.
// In-tree builds always define BOXEDWINE_GUEST_X64 when these TUs compile.

// Forward declarations (avoid pulling cpu64.h into every TU).
class CPU64;

// Jit64OpcodeClass — what the JIT intends to do with one guest instruction.
enum Jit64OpcodeClass : U8 {
    JIT64_FAST = 0,   // compiled to the fast path (phase 2: wasm opcodes)
    JIT64_FALLBACK = 1 // executed by the interpreter
};

// Jit64Kind — the JIT's own decode of a guest instruction, derived from the
// raw bytes (independent copy of the interpreter's dispatch logic, used to
// cross-check the interpreter's BBlock builder in tests).
enum Jit64Kind : U8 {
    J64_MOV_RM_R = 0,
    J64_MOV_R_RM = 1,
    J64_ALU_RM_R = 2,   // sub = aluOp 0..7
    J64_ALU_R_RM = 3,   // sub = aluOp 0..7
    J64_ALU_RM_IMM = 4, // sub = aluOp 0..7 (0x81/0x83; 0x80 8-bit excluded)
    J64_ALU_ACC_IMM = 5,// sub = aluOp 0..7 (0x04/0x05/0x0C/0x0D/.../0x3D)
    J64_SHIFT_IMM = 6,  // sub = shift op 0..7 (0xC0/0xC1)
    J64_IMUL_R_RM = 7,  // 0F AF
    J64_TEST_RM_R = 8,  // 0x84/0x85
    J64_LEA = 9,        // 0x8D
    J64_MOV_RM_IMM = 10,// 0xC6/0xC7 /0
    J64_MOV_R_IMM = 11, // 0xB8..0xBF (+REX.W imm64)
    J64_PUSH = 12,      // 0x50..0x57
    J64_POP = 13,       // 0x58..0x5F
    J64_CALL_REL = 14,  // 0xE8 rel32
    J64_JMP_REL = 15,   // 0xE9 rel32 / 0xEB rel8
    J64_JCC = 16,       // sub = cc 0..15 (0x70..0x7F / 0F 80..8F)
    J64_RET = 17,       // 0xC3
    J64_LEAVE = 18,     // 0xC9
    J64_NOP = 19,       // 0x90 (+ 0F 1F multi-byte NOP if seen)
    J64_SYSCALL = 20,   // 0F 05 — always fallback (block terminator)
    J64_STRING = 21,    // A4-A7/AA/AB/AE/AF: sub 0=MOVS,1=STOS,2=CMPS,3=SCAS
    J64_FPU = 22,       // D8-DF x87: interpreter-only by design (80-bit SoftFloat); never JIT64_FAST
    J64_MOVX = 23,      // 0F B6/B7/BE/BF MOVZX/MOVSX r, r/m; 63 MOVSXD r,r/m32; sub 0=zx8,1=zx16,2=sx8,3=sx16,4=sxd32
    J64_IMUL_1OP = 24,  // F6/F7 /5 one-operand IMUL (implicit RAX/RDX)
    J64_IMUL_3OP = 25,  // 69/6B three-operand IMUL r, r/m, imm
    J64_GRP3 = 26,      // F6/F7 group 3: sub = ModRM reg field;
                        // 0=TEST r/m,imm, 2=NOT, 3=NEG, 4=MUL (unsigned).
                        // /1 invalid; /5 stays J64_IMUL_1OP; /6 /7 DIV/IDIV
                        // are interpreter-only (their #DE path delivers a
                        // host SIGFPE with exact register state, which the
                        // straight-line wasm block model cannot represent).
    J64_CBW = 27,       // 0x98 CBW/CWDE/CDQE: sign-extend AL->AX (16),
                        // AX->EAX (32), EAX->RAX (64). Pure RAX
                        // transform; no flags, no memory, no faults.
    J64_CMOV = 28,      // 0F 40..4F CMOVcc r, r/m16/32/64: sub = condition
                        // 0..15 (same encoding as Jcc). Dest is always a
                        // register; source is always loaded (faults even if
                        // the condition is false). No flags touched.
    J64_CQO = 29,       // 0x99 CWD/CDQ/CQO: sign-extend AX->DX:AX (16),
                        // EAX->EDX:EAX (32), RAX->RDX:RAX (64). RAX is
                        // read-only, RDX is written. No flags, no memory,
                        // no faults.
    J64_SHIFT_CL = 30,  // sub = shift op 0..7 (0xD2/0xD3). Count is dynamic:
                        // CL & 0xFF at runtime, masked to 0x1F (0x3F for
                        // 64-bit) by the emitter. count==0 is a pure no-op
                        // (flags untouched); 32-bit count==0 still
                        // zero-extends a register dest. OF defined only for
                        // count==1. D2 is the 8-bit form.
    J64_SETCC = 31,     // 0F 90..9F SETcc r/m8: sub = condition 0..15
                        // (same encoding as Jcc/CMOVcc). Dest is r/m8
                        // (always byte); 0/1 based on RFLAGS. No flags
                        // touched. 0x66/REX.W ignored.
    J64_BT = 32,        // 0F A3/AB/B3/BB BT/BTS/BTR/BTC r/m16/32/64, r16/32/64:
                        // sub = 0(BT)/1(BTS)/2(BTR)/3(BTC). Bit = reg & (width-1).
                        // CF = selected bit. BTS/BTR/BTC modify the bit.
                        // Only CF touched. 0x66 selects 16-bit; REX.W 64-bit.
    J64_UNKNOWN = 255
};

// Effective-address description for isMem ops, mirroring CPU64::decodeModRM
// (source/emulation/cpu/cpu64.cpp) field-for-field. Filled by the decoder
// for memory-operand ALU/TEST kinds (J64_ALU_RM_R, J64_ALU_R_RM,
// J64_ALU_RM_IMM, J64_TEST_RM_R); meaningless when !isMem. See
// tasks/jit-port-plan.md section 13 for the design.
struct Jit64MemEA {
    bool ripRel = false;  // mod=0,rm=5: EA is the absolute ripRelTarget
    U64 ripRelTarget = 0; // decode-time constant (no 0x67 mask, no seg: quirk)
    U8 baseReg = 0xFF;    // 0..15, or 0xFF if none (SIB disp32-only)
    U8 idxReg = 0xFF;     // 0..15, or 0xFF if none (idxF==4 && !REX.X)
    U8 scale = 0;         // 0..3 (SIB shift count)
    S64 disp = 0;         // sign-extended displacement
    bool asize32 = false; // 0x67: mask EA to 32 bits after base+idx+disp wrap
    U8 seg = 0;           // 0, 0x64 (FS), 0x65 (GS); emitter rejects seg != 0
};

// One decoded guest instruction in JIT IR.
struct Jit64Op {
    Jit64Kind kind = J64_UNKNOWN;
    U8 size = 4;        // operand size in bytes (1/2/4/8)
    U8 sub = 0;         // aluOp / shift sub-op / cc
    U8 len = 0;         // full instruction length in bytes
    U8 regField = 0;    // ModRM reg field (REX.R extended), or dst reg for MOV_R_IMM/PUSH/POP
    U8 rmIndex = 0;     // ModRM r/m reg index (REX.B extended); 0xFF if memory/none
    bool isMem = false; // ModRM names memory (vs register-direct)
    U64 imm = 0;        // finalized immediate (sign/mask applied at decode)
    S64 delta = 0;      // branch displacement (CALL/JMP/JCC)
    U8 rep = 0;         // REP prefix: 0, 0xF2 or 0xF3 (J64_STRING only)
    bool asize32 = false; // 0x67 address-size prefix (J64_STRING only)
    bool rexPresent = false; // any REX prefix byte (8-bit high-byte vs SPL/... rule)
    Jit64MemEA ea;        // effective address (valid only when isMem)
    Jit64OpcodeClass plan = JIT64_FALLBACK;
};

// A compiled block: decoded ops + entry metadata + cache validity.
struct Jit64Block {
    U64 startRip = 0;   // 0 = empty slot
    U64 page0 = 0, page1 = 0;
    U32 gen0 = 0, gen1 = 0;
    std::vector<Jit64Op> ops;
    U32 fastCount = 0;  // ops with plan == JIT64_FAST
    bool executable = false; // true iff fastCount == ops.size() && ops not empty
    U64 execCount = 0;  // times this block was entered via jit (stats)
    // Phase-2 wasm module slot: -1 = not attempted, >= 0 = instantiated
    // table index from jit64WasmInstantiate, -2 = emission rejected (the
    // emitter is deterministic per block, so rejection is never retried).
    // Owned by Jit64BlockCache: insert/invalidate/clear release live slots.
    int wasmIndex = -1;
};

// Phase-1 opcode coverage table: exactly one row per opcode class the JIT
// claims as fast. The test harness asserts this list matches the top-20
// profile (see tasks/jit-port-plan.md "Phase 1 status").
struct Jit64CoveredOpcode {
    const char* name;   // e.g. "89 MOV r/m,r"
    U8 op;              // primary opcode byte (0x0F for two-byte)
    U8 op2;             // second byte if op == 0x0F, else 0
    Jit64Kind kind;
};

// Returns the static coverage table (20 entries in phase 1).
const Jit64CoveredOpcode* jit64CoveredOpcodes(U32* countOut);

// Decode one guest instruction at `rip` (absolute guest address) by reading
// `bytes`/`byteCount` (a snapshot callers fetch via CPU64). Returns false if
// the bytes don't decode to a known instruction. Never reads past byteCount.
// `ripBase` is the guest RIP of bytes[0] (needed for RIP-relative only to
// record isMem=true; no absolute target is materialized in phase 1).
bool jit64DecodeOne(U64 ripBase, const U8* bytes, U32 byteCount, Jit64Op& out);

// Classify: assign op.plan (FAST iff kind/size in the phase-1 fast set).
// 8-bit ALU forms, 16-bit operand size, LOCK/REP prefixes, and SYSCALL are
// always FALLBACK in phase 1.
void jit64Classify(Jit64Op& op, bool hasLockOrRep, bool osize16);

// Compile a raw byte stream (one block, caller-delimited: stops AFTER a
// control-flow op or at maxOps). Returns true if at least one op decoded.
// `stopAtControlFlow` terminates after CALL/JMP/JCC/RET/SYSCALL (inclusive).
U32 jit64CompileStream(U64 ripBase, const U8* bytes, U32 byteCount,
                       Jit64Op* opsOut, U32 maxOps, bool stopAtControlFlow);

// Block cache. Fixed-size open-addressed table keyed on startRip; validity
// additionally requires matching page generations (same contract as the
// interpreter's BOXEDWINE_BLOCK_EXEC blockTable: any write to a registered
// page bumps its generation and the entry rebuilds).
class Jit64BlockCache {
public:
    static constexpr U32 SLOTS = 512;
    Jit64BlockCache();
    // Look up a compiled entry valid for `rip` with the given page gens.
    // Returns nullptr on miss/stale.
    Jit64Block* lookup(U64 rip, U64 page0, U32 gen0, U64 page1, U32 gen1);
    // Insert (evicts whatever collides). Copies ops.
    Jit64Block* insert(U64 rip, U64 page0, U32 gen0, U64 page1, U32 gen1,
                             const Jit64Op* ops, U32 nOps);
    void invalidate(U64 rip); // drop one entry (negative-cache support)
    void clear();
    // Stats.
    U64 lookups() const { return m_lookups; }
    U64 hits() const { return m_hits; }
    U64 inserts() const { return m_inserts; }
private:
    struct Slot { Jit64Block block; };
    Slot m_slots[SLOTS];
    U64 m_lookups = 0, m_hits = 0, m_inserts = 0;
    static U32 slotFor(U64 rip);
};

// Runtime flag: BW64_JIT=1 enables the JIT path; anything else (or unset)
// keeps the interpreter. Cached after first read (zero cost when off).
bool jit64Enabled();
// §14.3: true if any op in the block may store to guest memory (conservative
// over-approximation; see jit64.cpp). Used to decline the wasm vehicle for
// self-modifying-risk blocks.
bool jit64BlockMayStore(const Jit64Op* ops, U32 nOps);

// Per-CPU JIT state owned by CPU64 (pointer to keep cpu64.h lean; defined
// here so cpu64.cpp can hold it by pointer without exposing internals).
struct Jit64State {
    Jit64BlockCache cache;
    U64 blocksCompiled = 0;
    U64 blocksExecuted = 0;
    U64 insnsFast = 0;
    U64 insnsFallback = 0;
    U64 wasmBlocks = 0;  // blocks executed via emitted wasm modules
    U64 wasmInsns = 0;   // instructions executed via emitted wasm modules
};

// Emit a wasm-module stub summary for a compiled block (phase-2 preparation):
// reports the op plan in a stable text form the wasm emitter will consume.
// Format: one line per op "kind=<n> size=<n> sub=<n> plan=<fast|fallback>".
// Returns the number of bytes written (excluding NUL); 0 if buf too small.
U32 jit64EmitPlanText(const Jit64Block& b, char* buf, U32 bufSize);

#endif // __JIT64_H__
