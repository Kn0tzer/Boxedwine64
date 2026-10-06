// Copyright (C) 2026 The BoxedWine Team. GPL-2.0-or-later.
// jit64table.mjs — semantics table for the table-driven JIT emitter.
//
// Each entry describes one GENERATED emitter function (see
// scripts/gen-jit64.mjs). The table drives the EMITTER (the per-group
// `emit*` functions in jit64wasm.cpp), not the decoder (jit64DecodeOne
// stays hand-written). New instruction coverage becomes table rows
// (+ a new template only when the composition is truly novel).
//
// Entry fields:
//   func:     generated C++ function name, e.g. "emitAluGen".
//   template: composition pattern implemented by the generator
//             ("alu", "shift", "rotate", "imul2", "imul1", "imul3",
//              "movx", "string", "lea", "stack", "mov8", "grp3", "cbw").
//   mem:      for the "alu"/"shift"/"rotate" templates: false =
//             register-direct, true = memory-operand (separate mem
//             emitter; EA via emitEA, fault ordering load->compute->store).
//   kinds:    Jit64Kind values the emitter handles.
//   encoding: decode contract (opcode, ModRM.reg extension, prefixes
//             REX/0x66/0x67, REX.W/B) — documentation; the real decoder
//             is jit64DecodeOne.
//   operands: operand spec per role (sizes; reg-direct with the
//             AH/BH/CH/DH-vs-REX byte rule; ModRM r/m reg-or-memory;
//             immediates).
//   flags:    flag behavior (which flags are written, result width,
//             what is preserved).
//   isTest:   (alu template) C++ bool expression: the op computes flags
//             like AND but writes no register.
//   wiring:   (alu template) per-kind operand wiring, in order.
//             dest: "rm" (op.rmIndex) | "reg" (op.regField) | "acc" (0) |
//                   "mem" (memory writeback)
//             a:    "dest" (dest's old value) | "mem" | "reg:<C++ GPR expr>"
//             b:    "imm" (op.imm & mask) | "mem" | "reg:<C++ GPR expr>"

export const EMITTERS = [
  {
    func: "emitAluGen",
    template: "alu",
    mem: false,
    kinds: [
      "J64_ALU_RM_R",
      "J64_ALU_R_RM",
      "J64_ALU_RM_IMM",
      "J64_ALU_ACC_IMM",
      "J64_TEST_RM_R",
    ],
    encoding:
      "ADD/ADC/SUB/SBB/AND/OR/XOR/CMP (/0../7): 0x00-0x05 r/m,r; " +
      "0x28-0x2D r,r/m; 0x80/0x81/0x83 r/m,imm; 0x04/0x05/.../0x3D acc,imm " +
      "(sub 8 = TEST); 0x84/0x85 TEST r/m,r. REX.W selects 64-bit, 0x66 16-bit.",
    operands:
      "sizes 1/2/4/8, reg-direct; 8-bit follows the AH/BH/CH/DH-vs-REX " +
      "rule (byteRegParts: no-REX idx 4..7 => high byte, else low byte).",
    flags: {
      writes: ["CF", "PF", "AF", "ZF", "SF", "OF"],
      preserves: "all other RFLAGS bits",
      note: "TEST/CMP compute flags but write no register",
    },
    isTest:
      "op.kind == J64_TEST_RM_R || (op.kind == J64_ALU_ACC_IMM && op.sub == 8)",
    wiring: [
      { kind: "J64_ALU_RM_R", dest: "rm", a: "dest", b: "reg:op.regField" },
      { kind: "J64_ALU_R_RM", dest: "reg", a: "dest", b: "reg:op.rmIndex" },
      { kind: "J64_ALU_RM_IMM", dest: "rm", a: "dest", b: "imm" },
      { kind: "J64_ALU_ACC_IMM", dest: "acc", a: "dest", b: "imm" },
      { kind: "J64_TEST_RM_R", dest: "rm", a: "dest", b: "reg:op.regField" },
    ],
  },
  {
    func: "emitAluMemGen",
    template: "alu",
    mem: true,
    kinds: [
      "J64_ALU_RM_R",
      "J64_ALU_R_RM",
      "J64_ALU_RM_IMM",
      "J64_TEST_RM_R",
    ],
    encoding:
      "ADD/ADC/SUB/SBB/AND/OR/XOR/CMP (/0../7) with ModRM mod != 3: " +
      "0x00-0x03 r/m,r; 0x28-0x2B r,r/m; 0x80/0x81/0x83 r/m,imm; " +
      "0x84/0x85 TEST r/m,r. EA via emitEA (SIB/RIP-relative/0x67/seg).",
    operands:
      "sizes 1/2/4/8, ModRM r/m names memory; fault ordering: memRead " +
      "before compute+flags, memWrite after (interpreter's loadRM/runAlu/" +
      "storeRM order).",
    flags: {
      writes: ["CF", "PF", "AF", "ZF", "SF", "OF"],
      preserves: "all other RFLAGS bits",
      note: "TEST/CMP compute flags but write nothing (no memWrite)",
    },
    isTest: "op.kind == J64_TEST_RM_R",
    wiring: [
      { kind: "J64_ALU_RM_R", dest: "mem", a: "mem", b: "reg:op.regField" },
      { kind: "J64_ALU_R_RM", dest: "reg", a: "reg:op.regField", b: "mem" },
      { kind: "J64_ALU_RM_IMM", dest: "mem", a: "mem", b: "imm" },
      { kind: "J64_TEST_RM_R", dest: "mem", a: "mem", b: "reg:op.regField" },
    ],
  },
  {
    func: "emitShiftGen",
    template: "shift",
    kinds: ["J64_SHIFT_IMM"],
    encoding:
      "SHL/SHR/SAR: 0xC1 /4,/5,/7 (0xC0 /4,/5,/7 for 8-bit; /6 aliases /4). " +
      "REX.W selects 64-bit, 0x66 16-bit. Count in imm8, masked to " +
      "0x1F/0x3F at decode.",
    operands:
      "sizes 1/2/4/8, register-direct; 8-bit follows the AH/BH/CH/DH-vs-REX rule.",
    flags: {
      writes: ["CF", "OF", "ZF", "SF", "PF"],
      preserves: "AF and all other RFLAGS bits (F_SHIFT_MASK merge)",
      note: "count==0: no-op (flags untouched); 32-bit count==0 still " +
            "zero-extends. OF defined only for count==1.",
    },
  },
  {
    func: "emitRotateGen",
    template: "rotate",
    kinds: ["J64_SHIFT_IMM"],
    encoding:
      "ROL/ROR/RCL/RCR: 0xC1 /0../3 (0xC0 /0../3 for 8-bit). REX.W selects " +
      "64-bit, 0x66 16-bit. Count in imm8, masked to 0x1F/0x3F at decode.",
    operands:
      "sizes 1/2/4/8, register-direct; 8-bit follows the AH/BH/CH/DH-vs-REX rule.",
    flags: {
      writes: ["CF", "OF"],
      preserves: "SZP/AF and all other RFLAGS bits (F_CFOF_MASK merge)",
      note: "count==0: no-op (flags untouched); 32-bit count==0 still " +
            "zero-extends. OF defined only for count==1.",
    },
  },
  {
    func: "emitShiftMemGen",
    template: "shift",
    mem: true,
    kinds: ["J64_SHIFT_IMM"],
    encoding:
      "SHL/SHR/SAR r/m,1 (0xD1 /4,/5,/7) and r/m,imm8 (0xC1 /4,/5,/7) " +
      "with ModRM mod != 3. D1 count is implicit 1; C1 count in imm8 " +
      "(masked 0x1F/0x3F at decode). REX.W selects 64-bit, 0x66 16-bit. " +
      "EA via emitEA.",
    operands:
      "sizes 1/2/4/8, memory operand; fault ordering: memRead before " +
      "compute+flags, memWrite after (interpreter's loadRM/doShift/" +
      "storeRM order).",
    flags: {
      writes: ["CF", "OF", "ZF", "SF", "PF"],
      preserves: "AF and all other RFLAGS bits (F_SHIFT_MASK merge)",
      note: "count==0 (C1 only): no-op, flags untouched; 32-bit " +
            "count==0 still zero-extends via memWrite. OF defined " +
            "only for count==1 (D1 always).",
    },
  },
  {
    func: "emitRotateMemGen",
    template: "rotate",
    mem: true,
    kinds: ["J64_SHIFT_IMM"],
    encoding:
      "ROL/ROR/RCL/RCR r/m,1 (0xD1 /0../3) and r/m,imm8 (0xC1 /0../3) " +
      "with ModRM mod != 3. D1 count is implicit 1; C1 count in imm8 " +
      "(masked 0x1F/0x3F at decode). REX.W selects 64-bit, 0x66 16-bit. " +
      "EA via emitEA.",
    operands:
      "sizes 1/2/4/8, memory operand; fault ordering: memRead before " +
      "compute+flags, memWrite after.",
    flags: {
      writes: ["CF", "OF"],
      preserves: "SZP/AF and all other RFLAGS bits (F_CFOF_MASK merge)",
      note: "count==0 (C1 only): no-op, flags untouched; 32-bit " +
            "count==0 still zero-extends via memWrite. OF defined " +
            "only for count==1 (D1 always).",
    },
  },
  {
    func: "emitShiftCLGen",
    template: "shiftCL",
    kinds: ["J64_SHIFT_CL"],
    encoding:
      "SHL/SHR/SAR: 0xD3 /4,/5,/7 (0xD2 /4,/5,/7 for 8-bit; /6 aliases /4). " +
      "REX.W selects 64-bit, 0x66 16-bit. Count = CL & 0xFF at runtime, " +
      "masked to 0x1F/0x3F by the emitter.",
    operands:
      "sizes 1/2/4/8, register-direct; 8-bit follows the AH/BH/CH/DH-vs-REX rule " +
      "(high-byte declined to interpreter by the classifier).",
    flags: {
      writes: ["CF", "OF", "ZF", "SF", "PF"],
      preserves: "AF and all other RFLAGS bits (F_SHIFT_MASK merge)",
      note: "count==0: no-op (flags untouched, via runtime select); 32-bit " +
            "count==0 still zero-extends. OF defined only for count==1.",
    },
  },
  {
    func: "emitRotateCLGen",
    template: "rotateCL",
    kinds: ["J64_SHIFT_CL"],
    encoding:
      "ROL/ROR/RCL/RCR: 0xD3 /0../3 (0xD2 /0../3 for 8-bit). REX.W selects " +
      "64-bit, 0x66 16-bit. Count = CL & 0xFF at runtime, masked to " +
      "0x1F/0x3F by the emitter. RCL/RCR use the closed-form (wbits+1)-bit " +
      "rotation (no wasm loop).",
    operands:
      "sizes 1/2/4/8, register-direct; 8-bit follows the AH/BH/CH/DH-vs-REX rule.",
    flags: {
      writes: ["CF", "OF"],
      preserves: "SZP/AF and all other RFLAGS bits (F_CFOF_MASK merge)",
      note: "count==0: no-op (flags untouched, via runtime select). OF " +
            "defined only for count==1.",
    },
  },
  {
    func: "emitShiftCLMemGen",
    template: "shiftCL",
    mem: true,
    kinds: ["J64_SHIFT_CL"],
    encoding:
      "SHL/SHR/SAR r/m,CL (0xD3 /4,/5,/7) with ModRM mod != 3. Count = " +
      "CL & 0xFF at runtime, masked to 0x1F/0x3F by the emitter. REX.W " +
      "selects 64-bit, 0x66 16-bit. EA via emitEA.",
    operands:
      "sizes 1/2/4/8, memory operand; fault ordering: memRead before " +
      "compute+flags (load faults even when count==0, matching the " +
      "interpreter), memWrite only when count != 0.",
    flags: {
      writes: ["CF", "OF", "ZF", "SF", "PF"],
      preserves: "AF and all other RFLAGS bits (F_SHIFT_MASK merge)",
      note: "count==0: no store, flags untouched. OF defined only for count==1.",
    },
  },
  {
    func: "emitRotateCLMemGen",
    template: "rotateCL",
    mem: true,
    kinds: ["J64_SHIFT_CL"],
    encoding:
      "ROL/ROR/RCL/RCR r/m,CL (0xD3 /0../3) with ModRM mod != 3. Count = " +
      "CL & 0xFF at runtime, masked to 0x1F/0x3F. EA via emitEA.",
    operands:
      "sizes 1/2/4/8, memory operand; fault ordering: memRead before " +
      "compute+flags, memWrite only when count != 0.",
    flags: {
      writes: ["CF", "OF"],
      preserves: "SZP/AF and all other RFLAGS bits (F_CFOF_MASK merge)",
      note: "count==0: no store, flags untouched. OF defined only for count==1.",
    },
  },
  {
    func: "emitImulGen",
    template: "imul2",
    kinds: ["J64_IMUL_R_RM"],
    encoding: "IMUL r32/64, r/m32/64: 0x0F 0xAF. REX.W selects 64-bit.",
    operands: "sizes 4/8, register-direct.",
    flags: {
      writes: ["CF", "OF"],
      preserves: "all other RFLAGS bits",
      note: "CF/OF set iff the signed result does not fit (128-bit limb product)",
    },
  },
  {
    func: "emitImul1Gen",
    template: "imul1",
    kinds: ["J64_IMUL_1OP"],
    encoding: "IMUL r/m: 0xF6 /5 (8-bit) or 0xF7 /5 (32/64-bit). rDX:rAX result.",
    operands: "sizes 1/2/4/8, register-direct.",
    flags: {
      writes: ["CF", "OF"],
      preserves: "all other RFLAGS bits",
      note: "32-bit limb product + sign correction; writes RAX and RDX",
    },
  },
  {
    func: "emitImul3Gen",
    template: "imul3",
    kinds: ["J64_IMUL_3OP"],
    encoding: "IMUL r, r/m, imm: 0x6B (imm8) or 0x69 (imm16/32). REX.W selects 64-bit.",
    operands: "sizes 2/4/8, register-direct.",
    flags: {
      writes: ["CF", "OF"],
      preserves: "all other RFLAGS bits",
      note: "CF/OF set iff the signed result does not fit",
    },
  },
  {
    func: "emitMovxGen",
    template: "movx",
    kinds: ["J64_MOVX"],
    encoding: "MOVZX: 0x0F 0xB6 (r/m8) / 0x0F 0xB7 (r/m16); MOVSX: 0x0F 0xBE / 0x0F 0xBF; MOVSXD: 0x63 /r (r/m32). REX.W/0x66 select dest size.",
    operands: "sizes 2/4/8 dest, 1/2/4 src; register-direct; 8-bit src follows AH/BH/CH/DH-vs-REX.",
    flags: {
      writes: [],
      preserves: "all RFLAGS bits (flags untouched)",
      note: "sub: 0=MOVZX8, 1=MOVZX16, 2=MOVSX8, 3=MOVSX16, 4=MOVSXD (32-bit src, sign-extended; dest 4/8 only)",
    },
  },
  {
    func: "emitStringGen",
    template: "string",
    kinds: ["J64_STRING"],
    encoding: "MOVS (0xA4/0xA5), STOS (0xAA/0xAB), CMPS (0xA6/0xA7), SCAS (0xAE/0xAF) with REP/REPE/REPNE (0xF2/0xF3).",
    operands: "sizes 1/2/4/8; RSI/RDI/RCX implicit; 0x67 addr-size.",
    flags: {
      writes: ["CF", "PF", "AF", "ZF", "SF", "OF"],
      preserves: "CMPS/SCAS write all six; MOVS/STOS preserve all flags",
      note: "sub: 0=MOVS, 1=STOS, 2=CMPS, 3=SCAS; rep loop with ZF early-exit",
    },
  },
  {
    func: "emitLeaGen",
    template: "lea",
    kinds: ["J64_LEA"],
    encoding:
      "LEA r, m: 0x8D /r, ModRM mod != 3 (reg form is #UD). REX.W selects " +
      "64-bit, else 32-bit (zero-extended). 0x66 16-bit rejected by the " +
      "classifier (the interpreter's block decoder breaks on it). EA via " +
      "emitEA (SIB/RIP-relative/0x67); FS/GS-segment EAs stay " +
      "interpreter-only.",
    operands:
      "sizes 4/8; destination is the ModRM reg field; the r/m names memory " +
      "but is never dereferenced, so no fault is possible.",
    flags: {
      writes: [],
      preserves: "all RFLAGS bits - LEA never touches flags",
      note: "the value IS the effective address; no memory is read",
    },
  },
  {
    func: "emitStackGen",
    template: "stack",
    kinds: ["J64_PUSH", "J64_POP"],
    encoding:
      "PUSH: 0x50-0x57 r64 (sub 0), 0x68/0x6A imm32/imm8 sign-extended " +
      "(sub 1), 0xFF /6 r/m64 (sub 2). POP: 0x58-0x5F r64 (sub 0), " +
      "0x8F /0 r/m64 (sub 1). Always 64-bit in long mode - the " +
      "interpreter ignores 0x66 on near PUSH/POP, and 32-bit forms do " +
      "not exist in 64-bit mode. Segment pushes (06/0E/16/1E/0F A0/A8) " +
      "are #UD in the interpreter and stay unknown in the decoder. " +
      "EA via emitEA for r/m memory forms (SIB/RIP-relative/0x67/seg; " +
      "FS/GS-segment EAs stay interpreter-only via the classifier).",
    operands:
      "size 8 only. PUSH reg reads the source register BEFORE touching " +
      "RSP (PUSH RSP pushes the old RSP). PUSH r/m reads the r/m operand " +
      "first (mod==3: register, else [EA]). POP r/m uses the decode-time " +
      "EA, computed from pre-instruction registers (RSP-relative EAs " +
      "see the old RSP).",
    flags: {
      writes: [],
      preserves: "all RFLAGS bits - PUSH/POP never touch flags",
      note: "fault ordering mirrors cpu64.cpp exactly. PUSH reg: RSP-=8 " +
            "then write [RSP]. PUSH imm: write [RSP-8] then RSP-=8. " +
            "PUSH r/m: read r/m, RSP-=8, write [RSP]. POP reg: read " +
            "[RSP], RSP+=8, write reg. POP r/m: read [RSP], RSP+=8, " +
            "write r/m. (Reads return 0 and writes commit on unmapped " +
            "pages, so the ORDER of RSP update vs memory access is the " +
            "observable contract.)",
    },
  },
  {
    func: "emitGrp3Gen",
    template: "grp3",
    kinds: ["J64_GRP3"],
    encoding:
      "F6/F7 group 3: TEST r/m,imm (0xF6 /0 imm8, 0xF7 /0 imm16/imm32, " +
      "imm32 sign-extended for 64-bit); NOT r/m (0xF6/0xF7 /2); NEG r/m " +
      "(/3); MUL r/m unsigned (/4). /1 invalid; /5 stays J64_IMUL_1OP; " +
      "/6 /7 DIV/IDIV are interpreter-only (#DE). F6 is always 8-bit " +
      "(0x66 ignored, matching the interpreter); F7 takes 2/4/8. EA via " +
      "emitEA for memory forms (SIB/RIP-relative/0x67/seg; FS/GS-segment " +
      "EAs stay interpreter-only). TEST's RIP-relative EA includes the " +
      "trailing immediate length (decodeEA trailingImm).",
    operands:
      "sizes 1/2/4/8; the r/m operand is the ModRM r/m field (register " +
      "or memory); TEST's immediate is finalized at decode.",
    flags: {
      writes: ["CF", "PF", "AF", "ZF", "SF", "OF"],
      preserves: "NOT preserves all flags; MUL preserves all but CF/OF; " +
                 "TEST/NEG write all six",
      note: "TEST: flags like AND of (r/m & imm), no writeback. NOT: no " +
            "flags. NEG: flags like SUB of (0 - r/m), CF = (r/m != 0). " +
            "MUL: CF/OF = (high half != 0), others preserved. Fault " +
            "ordering mirrors cpu64.cpp: memRead before compute+flags, " +
            "memWrite after (NOT/NEG).",
    },
  },
  {
    func: "emitMov8Gen",
    template: "mov8",
    kinds: ["J64_MOV_RM_R", "J64_MOV_R_RM"],
    encoding:
      "MOV r/m8, r8 (0x88); MOV r8, r/m8 (0x8A). The 8-bit forms ignore " +
      "REX.W and 0x66 for the size (always 1) - 0x66 is accepted and " +
      "ignored, matching the interpreter (cpu64.cpp dsp_9/dsp_10 " +
      "hardcode the width). 16-bit MOV stays interpreter-only via the " +
      "classifier. EA via emitEA for memory forms (SIB/RIP-relative/" +
      "0x67/seg; FS/GS-segment EAs stay interpreter-only).",
    operands:
      "size 1 only. Register operands follow the AH/BH/CH/DH-vs-REX " +
      "rule (no REX + index 4..7 => high byte of regs 0..3; any REX => " +
      "low byte of regs 4..7), via emitReadByte/emitWriteByte. Memory " +
      "forms: 88 reads the source byte register then writes [EA]; 8A " +
      "reads [EA] then writes the dest byte register.",
    flags: {
      writes: [],
      preserves: "all RFLAGS bits - MOV never touches flags",
      note: "fault ordering mirrors cpu64.cpp exactly. 88 mem: " +
            "readReg8 (cannot fault), then [EA] = byte (may fault). " +
            "8A mem: byte = [EA] (may fault), then writeReg8. The EA " +
            "itself is computed from pre-instruction registers at " +
            "decode time, like the interpreter's decodeModRM.",
    },
  },
  {
    func: "emitCbwGen",
    template: "cbw",
    kinds: ["J64_CBW"],
    encoding:
      "CBW/CWDE/CDQE (0x98): no ModRM, no immediate. 0x66 selects 16-bit " +
      "(CBW: AL->AX), default is 32-bit (CWDE: AX->EAX), REX.W selects " +
      "64-bit (CDQE: EAX->RAX). Pure RAX transform.",
    operands:
      "sizes 2/4/8, implicit RAX operand only.",
    flags: {
      writes: [],
      preserves: "all RFLAGS bits - CBW/CWDE/CDQE never touch flags",
      note: "16-bit: setU16 (upper 48 preserved); 32-bit: sign-extend " +
            "AX to 32 then zero-extend to 64; 64-bit: sign-extend EAX " +
            "to 64. Mirrors cpu64.cpp dsp_20 exactly.",
    },
  },
  {
    func: "emitCmovGen",
    template: "cmov",
    kinds: ["J64_CMOV"],
    encoding:
      "CMOVcc r16/32/64, r/m16/32/64 (0F 40..4F): sub = condition 0..15 " +
      "(same encoding as Jcc). 0x66 selects 16-bit, default is 32-bit, " +
      "REX.W selects 64-bit. Dest is always a register (regField).",
    operands:
      "sizes 2/4/8, reg-direct dest; reg-or-memory source (rmIndex/isMem). " +
      "The source is ALWAYS loaded, even if the condition is false.",
    flags: {
      writes: [],
      preserves: "all RFLAGS bits - CMOVcc never touches flags",
      note: "32-bit form zero-extends the destination even when the " +
            "condition is false (x86-64 quirk). Mirrors dsp_38 exactly.",
    },
  },
  {
    func: "emitCqoGen",
    template: "cqo",
    kinds: ["J64_CQO"],
    encoding:
      "CWD/CDQ/CQO (0x99): no ModRM, no immediate. 0x66 selects 16-bit " +
      "(CWD: AX->DX), default is 32-bit (CDQ: EAX->EDX), REX.W selects " +
      "64-bit (CQO: RAX->RDX). RAX is read-only, RDX is written.",
    operands:
      "sizes 2/4/8, implicit RAX source and RDX destination only.",
    flags: {
      writes: [],
      preserves: "all RFLAGS bits - CWD/CDQ/CQO never touch flags",
      note: "16-bit: setU16 (upper 48 of RDX preserved); 32/64-bit: full " +
            "64-bit RDX write of the sign extension. Mirrors cpu64.cpp " +
            "dsp_19 exactly.",
    },
  },
  {
    func: "emitMovImm8Gen",
    template: "movimm8",
    kinds: ["J64_MOV_RM_IMM"],
    encoding:
      "MOV r/m8, imm8 (0xC6 /0). The 8-bit form uses a 1-byte immediate " +
      "(vs 4 bytes for C7); size is always 1 (0x66/REX.W ignored, " +
      "matching the interpreter which hardcodes width 1 in dsp_12). " +
      "Only /0 is defined; other sub-ops fall through to unhandled. " +
      "EA via emitEA for memory forms (SIB/RIP-relative/0x67/seg; " +
      "FS/GS-segment EAs stay interpreter-only).",
    operands:
      "size 1 only. Register destinations follow the AH/BH/CH/DH-vs-REX " +
      "rule via emitWriteByte, but AH/BH/CH/DH (no REX, rm 4..7) are " +
      "declined to the interpreter by the classifier (latent high-byte " +
      "writeback bug, D1 round). Memory forms: [EA] = imm8.",
    flags: {
      writes: [],
      preserves: "all RFLAGS bits - MOV never touches flags",
      note: "fault ordering mirrors cpu64.cpp exactly. Mem: [EA] = imm8 " +
            "(may fault); the EA itself is computed from pre-instruction " +
            "registers at decode time, like the interpreter's " +
            "decodeModRM. Reg: writeReg8 (cannot fault).",
    },
  },
  {
    func: "emitSetccGen",
    template: "setcc",
    kinds: ["J64_SETCC"],
    encoding:
      "SETcc r/m8 (0F 90..9F): sub = condition 0..15 (same encoding as " +
      "Jcc/CMOVcc). Dest is always r/m8 (byte); 0x66/REX.W ignored. " +
      "The value written is 1 if the condition holds, 0 otherwise.",
    operands:
      "size 1 only. Register destinations follow the AH/BH/CH/DH-vs-REX " +
      "rule via emitWriteByte, but AH/BH/CH/DH (no REX, rm 4..7) are " +
      "declined to the interpreter by the classifier (latent high-byte " +
      "writeback bug, D1 round). Memory forms: [EA] = (cc ? 1 : 0) via " +
      "emitEA + emitMemWrite.",
    flags: {
      writes: [],
      preserves: "all RFLAGS bits - SETcc never touches flags (only reads)",
      note: "condition evaluated from RFLAGS via the same logic as " +
            "evalCC/cpu64.cpp and the CMOVcc template. Mem: EA computed " +
            "at decode time, then [EA] = byte (may fault). Reg: writeReg8 " +
            "(cannot fault).",
    },
  },
  {
    func: "emitBtGen",
    template: "bt",
    kinds: ["J64_BT"],
    encoding:
      "BT/BTS/BTR/BTC r/m16/32/64, r16/32/64 (0F A3/AB/B3/BB): sub = " +
      "0(BT)/1(BTS)/2(BTR)/3(BTC). Bit index from ModRM reg field " +
      "(GPR); target is r/m (reg or mem).",
    operands:
      "sizes 2/4/8 only (no 8-bit form; 0x66 selects 16-bit, REX.W 64-bit). " +
      "Bit = idx & (width-1). Reg-direct: target in rmIndex. Mem: EA " +
      "computed at decode time.",
    flags: {
      writes: ["CF"],
      preserves: "all RFLAGS except CF - only CF is written (from the " +
                 "selected bit); OF/SF/ZF/AF/PF untouched",
      note: "Mirrors cpu64.cpp: v = loadRM; bit = idx & (width-1); " +
            "CF = (v >> bit) & 1. BTS: v |= mask; BTR: v &= ~mask; " +
            "BTC: v ^= mask; storeRM if sub != 0. Mem: [EA] read then " +
            "written (may fault on either).",
    },
  },
];
