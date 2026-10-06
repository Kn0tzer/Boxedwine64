#!/usr/bin/env node
// Copyright (C) 2026 The BoxedWine Team. GPL-2.0-or-later.
// gen-jit64.mjs — table-driven JIT emitter generator.
//
// Reads source/emulation/cpu/jit64table.mjs and emits
// source/emulation/cpu/jit64gen.inc (C++ emitter functions, included into
// jit64wasm.cpp's anonymous namespace).
//
// Usage:
//   node scripts/gen-jit64.mjs          # regenerate jit64gen.inc
//   node scripts/gen-jit64.mjs --check  # verify jit64gen.inc is in sync
//
// The byte-identical bar: every generated function must produce
// byte-identical wasm output to the hand-written emitter it replaces,
// proven by source/emulation/cpu/tests/jit64_gen_tests.cpp.

import { EMITTERS } from "../source/emulation/cpu/jit64table.mjs";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(ROOT, "source/emulation/cpu/jit64gen.inc");

// dest keyword -> C++ expression for the destination GPR index.
const DEST_EXPR = { rm: "op.rmIndex", reg: "op.regField", acc: "0" };

function condFor(kinds) {
  return kinds.map((k) => `op.kind == ${k}`).join(" || ");
}

// Group wiring entries by a key function, preserving first-seen order.
// Returns [[key, [entries]], ...].
function groupBy(wiring, keyFn) {
  const groups = new Map();
  for (const w of wiring) {
    const k = keyFn(w);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  return [...groups.entries()];
}

// "alu" template: register-direct ALU/TEST (emitAlu shape).
// L_A = width-masked lhs, L_B = width-masked rhs; compute via
// emitAluCompute; writeback per the standard rule.
function genAlu(e) {
  const L = [];

  L.push(`U32 ${e.func}(Bytes& body, const Jit64Op& op) {`);
  L.push(`    const bool isTest = ${e.isTest};`);
  L.push(
    `    const bool isLogic = isTest || op.sub == 1 || op.sub == 4 || op.sub == 6;`
  );
  L.push(
    `    const U8 effSub = isTest ? 4 : op.sub; // TEST computes flags like AND`
  );
  L.push(`    const U64 mask = widthMask(op.size);`);
  L.push(`    const U64 sb = widthSB(op.size);`);

  // Destination GPR selection. The chain is exhaustive by construction
  // (every kind appears in exactly one group), so the last group takes
  // the final else.
  L.push(`    U32 destReg;`);
  const destGroups = groupBy(e.wiring, (w) => w.dest);
  destGroups.forEach(([dest, ws], i) => {
    if (i === destGroups.length - 1) {
      L.push(`    else destReg = ${DEST_EXPR[dest]};`);
    } else {
      const kw = i === 0 ? "if" : "else if";
      L.push(
        `    ${kw} (${condFor(ws.map((w) => w.kind))}) destReg = ${DEST_EXPR[dest]};`
      );
    }
  });

  // L_A sourcing.
  L.push(`    // L_A = width-masked lhs.`);
  const aGroups = groupBy(e.wiring, (w) => w.a);
  if (aGroups.length === 1 && aGroups[0][0] === "dest") {
    L.push(`    emitReadOperand(body, op, destReg, L_A);`);
  } else {
    throw new Error("alu template: only a='dest' implemented so far");
  }

  // L_B sourcing.
  L.push(`    // L_B = width-masked rhs.`);
  const bGroups = groupBy(e.wiring, (w) =>
    w.b === "imm" ? "imm" : "reg"
  );
  const immGroup = bGroups.find(([k]) => k === "imm");
  const regGroup = bGroups.find(([k]) => k === "reg");
  if (immGroup && regGroup) {
    L.push(
      `    if (${condFor(immGroup[1].map((w) => w.kind))}) {`
    );
    L.push(`        i64Const(body, op.imm & mask);`);
    L.push(`        local(body, 0x21, L_B);`);
    L.push(`    } else {`);
    // srcReg selection among the reg kinds (exhaustive: every non-imm
    // kind is a reg kind, so the last group takes the final else).
    const regExprs = groupBy(regGroup[1], (w) => w.b);
    const regCpp = (bexpr) => bexpr.slice("reg:".length);
    if (regExprs.length === 1) {
      L.push(`        emitReadOperand(body, op, ${regCpp(regExprs[0][0])}, L_B);`);
    } else {
      L.push(`        U32 srcReg;`);
      regExprs.forEach(([bexpr, ws], i) => {
        if (i === regExprs.length - 1) {
          L.push(`        else srcReg = ${regCpp(bexpr)};`);
        } else {
          const kw = i === 0 ? "if" : "else if";
          L.push(
            `        ${kw} (${condFor(ws.map((w) => w.kind))}) srcReg = ${regCpp(bexpr)};`
          );
        }
      });
      L.push(`        emitReadOperand(body, op, srcReg, L_B);`);
    }
    L.push(`    }`);
  } else if (immGroup) {
    L.push(`    i64Const(body, op.imm & mask);`);
    L.push(`    local(body, 0x21, L_B);`);
  } else {
    throw new Error("alu template: no imm/reg b-groups?!");
  }

  L.push(`    if (op.sub == 2 || op.sub == 3) emitAluCarryFold(body, mask);`);
  L.push(`    emitAluCompute(body, effSub, isLogic, mask, sb);`);
  L.push(
    `    if (isTest || op.sub == 7) return 0xFF; // TEST/CMP write no register`
  );
  L.push(
    `    if (op.size == 1) { emitWriteByte(body, op, destReg, L_R); return 0xFF; }`
  );
  L.push(
    `    if (op.size == 2) { emitWriteWord(body, destReg, L_R); return 0xFF; }`
  );
  L.push(`    return destReg;`);
  L.push(`}`);
  return L.join("\n");
}

// "alu" template, mem variant: memory-operand ALU/TEST (emitAluMem shape).
// EA into L_T1 via emitEA; fault ordering memRead -> compute+flags ->
// memWrite. L_A/L_B sourcing has two patterns (regA vs memA).
function genAluMem(e) {
  const L = [];
  const regCpp = (x) => x.slice("reg:".length);

  const regAKinds = e.wiring.filter((w) => w.a.startsWith("reg:"));
  const memAKinds = e.wiring.filter((w) => w.a === "mem");
  const immKinds = e.wiring.filter((w) => w.b === "imm");
  const regBKinds = e.wiring.filter((w) => w.b.startsWith("reg:"));
  const regDestKinds = e.wiring.filter((w) => w.dest === "reg");
  if (!regAKinds.length || !memAKinds.length)
    throw new Error("alu/mem template needs both regA and memA kinds");
  const regAExprs = [...new Set(regAKinds.map((w) => w.a))];
  const regBExprs = [...new Set(regBKinds.map((w) => w.b))];
  if (regAExprs.length !== 1) throw new Error("alu/mem: want one regA expr");
  if (regBExprs.length !== 1) throw new Error("alu/mem: want one regB expr");
  // For a "reg" dest, the destination GPR is the register operand
  // (the same register sourced into L_A).
  const destRegExpr = regCpp(regAExprs[0]);

  L.push(`U32 ${e.func}(Bytes& body, const Jit64Op& op) {`);
  L.push(`    const bool isTest = ${e.isTest};`);
  L.push(
    `    const bool isLogic = isTest || op.sub == 1 || op.sub == 4 || op.sub == 6;`
  );
  L.push(
    `    const U8 effSub = isTest ? 4 : op.sub; // TEST computes flags like AND`
  );
  L.push(`    const U64 mask = widthMask(op.size);`);
  L.push(`    const U64 sb = widthSB(op.size);`);
  L.push(`    emitEA(body, op); // L_T1 = effective address`);
  // A/B sourcing.
  L.push(`    if (${condFor(regAKinds.map((w) => w.kind))}) {`);
  L.push(`        // L_A = reg (dest old value), L_B = mem.`);
  L.push(`        emitReadOperand(body, op, ${regCpp(regAExprs[0])}, L_A);`);
  L.push(`        emitMemRead(body, L_T1, op.size); // -> L_R (zero-extended)`);
  L.push(`        local(body, 0x20, L_R);`);
  L.push(`        i64Const(body, mask);`);
  L.push(`        body.push_back(0x83);`);
  L.push(`        local(body, 0x21, L_B);`);
  L.push(`    } else {`);
  L.push(`        // L_A = mem (dest old value), L_B = reg or imm.`);
  L.push(`        emitMemRead(body, L_T1, op.size); // -> L_R (zero-extended)`);
  L.push(`        local(body, 0x20, L_R);`);
  L.push(`        i64Const(body, mask);`);
  L.push(`        body.push_back(0x83);`);
  L.push(`        local(body, 0x21, L_A);`);
  if (immKinds.length) {
    L.push(`        if (${condFor(immKinds.map((w) => w.kind))}) {`);
    L.push(`            i64Const(body, op.imm & mask);`);
    L.push(`            local(body, 0x21, L_B);`);
    L.push(`        } else {`);
    L.push(
      `            emitReadOperand(body, op, ${regCpp(regBExprs[0])}, L_B);`
    );
    L.push(`        }`);
  } else {
    L.push(`        emitReadOperand(body, op, ${regCpp(regBExprs[0])}, L_B);`);
  }
  L.push(`    }`);
  L.push(`    if (op.sub == 2 || op.sub == 3) emitAluCarryFold(body, mask);`);
  L.push(`    emitAluCompute(body, effSub, isLogic, mask, sb);`);
  L.push(`    if (isTest || op.sub == 7) return 0xFF; // TEST/CMP write nothing`);
  if (regDestKinds.length) {
    L.push(`    if (${condFor(regDestKinds.map((w) => w.kind))}) {`);
    L.push(`        // Destination is the register.`);
    L.push(
      `        if (op.size == 1) { emitWriteByte(body, op, ${destRegExpr}, L_R); return 0xFF; }`
    );
    L.push(
      `        if (op.size == 2) { emitWriteWord(body, ${destRegExpr}, L_R); return 0xFF; }`
    );
    L.push(`        return ${destRegExpr};`);
    L.push(`    }`);
  }
  L.push(`    // Destination is memory: write back through the imported helper.`);
  L.push(`    emitMemWrite(body, L_T1, L_R, op.size);`);
  L.push(`    return 0xFF;`);
  L.push(`}`);
  return L.join("\n");
}

// "shift" template: register-direct SHL/SHR/SAR (emitShift shape).
// The op carries all variation (sub/size/imm); the template documents the
// contract and generates the proven body under the table-given name.
function genShift(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U64 count = op.imm; // already masked to 0x1F/0x3F at decode
    const U32 destReg = op.rmIndex;
    const U64 mask = widthMask(op.size);
    const U64 sb = widthSB(op.size);
    const U64 wbits = (U64)op.size * 8;
    const U8 sub = op.sub == 6 ? 4 : op.sub; // /6 aliases SHL
    if (count == 0) {
        if (op.size == 4) {
            // The interpreter zero-extends the 32-bit destination even when
            // the count is 0 (cpu64.cpp BK_SHIFT_IMM / step shift path do
            // reg[rm].setU32((U32)v)); flags are untouched. Publish the
            // width-masked value via L_R so the caller stores it back.
            emitReadOperand(body, op, destReg, L_R);
            return destReg;
        }
        return 0xFF; // count==0: pure no-op for 1/2/8-bit, value and flags untouched
    }
    // L_A = width-masked operand.
    emitReadOperand(body, op, destReg, L_A);
    // L_R = shift result. The shift amount is pushed after any
    // sign-extension so the operand stack stays [value, amount].
    local(body, 0x20, L_A);
    if (sub == 4) {
        i64Const(body, count);
        body.push_back(0x86); // i64.shl
    } else if (sub == 5) {
        i64Const(body, count);
        body.push_back(0x88); // i64.shr_u (L_A already width-masked)
    } else { // SAR: sign-extend the width, arithmetic shift, mask.
        emitSext(body, op.size);
        i64Const(body, count);
        body.push_back(0x87); // i64.shr_s
    }
    i64Const(body, mask);
    body.push_back(0x83); // width-mask the result
    local(body, 0x21, L_R);
    // Flags: L_F accumulates the five shift flag bits.
    i64Const(body, 0);
    local(body, 0x21, L_F);
    // CF: SHL: (v >> (wbits - count)) & 1; SHR/SAR: (v >> (count - 1)) & 1.
    // Stash the 0/1 bit in L_P: the SHL count==1 OF formula needs it below.
    local(body, 0x20, L_A);
    i64Const(body, sub == 4 ? wbits - count : count - 1);
    body.push_back(0x88); // i64.shr_u
    i64Const(body, 1);
    body.push_back(0x83); // i64.and
    local(body, 0x21, L_P);
    local(body, 0x20, L_P);
    body.push_back(0xA7); // i32.wrap_i64
    orFlagBit(body, F_CF);
    // OF: only defined for count == 1 (the bit stays 0 otherwise, matching
    // the interpreter clearing OF for count > 1).
    if (count == 1) {
        if (sub == 4) {
            // OF = MSB(result) XOR CF.
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            local(body, 0x20, L_P);
            body.push_back(0xA7); // i32.wrap_i64
            body.push_back(0x73); // i32.xor
            orFlagBit(body, F_OF);
        } else if (sub == 5) {
            // OF = old MSB.
            local(body, 0x20, L_A);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            orFlagBit(body, F_OF);
        }
        // SAR: OF = 0, nothing to emit.
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
    // rflags = (rflags & ~SHIFT_MASK) | (i32)L_F; AF and the rest preserved.
    local(body, 0x20, L_RFLAGS);
    i32Const(body, F_SHIFT_MASK);
    body.push_back(0x72); // i32.or
    i32Const(body, F_SHIFT_MASK);
    body.push_back(0x73); // i32.xor
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or
    local(body, 0x21, L_RFLAGS);
    if (op.size == 1) { emitWriteByte(body, op, destReg, L_R); return 0xFF; }
    if (op.size == 2) { emitWriteWord(body, destReg, L_R); return 0xFF; }
    return destReg;
}`;
}

// "shift" template, mem=true: memory-operand SHL/SHR/SAR (emitShiftMem shape).
// EA via emitEA; fault ordering is load -> compute+flags -> store, mirroring
// the interpreter's loadRM/doShift/storeRM. The count comes from op.imm
// (D1: implicit 1; C1: imm8 masked at decode).
function genShiftMem(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U64 count = op.imm;
    const U64 mask = widthMask(op.size);
    const U64 sb = widthSB(op.size);
    const U64 wbits = (U64)op.size * 8;
    const U8 sub = op.sub == 6 ? 4 : op.sub; // /6 aliases SHL
    emitEA(body, op); // L_T1 = effective address
    // L_A = width-masked memory operand. emitMemRead faults on unmapped
    // pages exactly like the interpreter's loadRM.
    emitMemRead(body, L_T1, op.size); // -> L_R (zero-extended)
    local(body, 0x20, L_R);
    i64Const(body, mask);
    body.push_back(0x83); // i64.and
    local(body, 0x21, L_A);
    if (count == 0) {
        // Interpreter: count==0 never stores to memory (the 32-bit
        // zero-extend on count==0 applies to registers only). Pure no-op;
        // flags untouched.
        return 0xFF;
    }
    // L_R = shift result. Same computation as the register-direct path.
    local(body, 0x20, L_A);
    if (sub == 4) {
        i64Const(body, count);
        body.push_back(0x86); // i64.shl
    } else if (sub == 5) {
        i64Const(body, count);
        body.push_back(0x88); // i64.shr_u (L_A already width-masked)
    } else { // SAR: sign-extend the width, arithmetic shift, mask.
        emitSext(body, op.size);
        i64Const(body, count);
        body.push_back(0x87); // i64.shr_s
    }
    i64Const(body, mask);
    body.push_back(0x83); // width-mask the result
    local(body, 0x21, L_R);
    // Flags: L_F accumulates the five shift flag bits (same as genShift).
    i64Const(body, 0);
    local(body, 0x21, L_F);
    // CF: SHL: (v >> (wbits - count)) & 1; SHR/SAR: (v >> (count - 1)) & 1.
    local(body, 0x20, L_A);
    i64Const(body, sub == 4 ? wbits - count : count - 1);
    body.push_back(0x88); // i64.shr_u
    i64Const(body, 1);
    body.push_back(0x83); // i64.and
    local(body, 0x21, L_P);
    local(body, 0x20, L_P);
    body.push_back(0xA7); // i32.wrap_i64
    orFlagBit(body, F_CF);
    // OF: only defined for count == 1 (D1 always; the bit stays 0
    // otherwise, matching the interpreter clearing OF for count > 1).
    if (count == 1) {
        if (sub == 4) {
            // OF = MSB(result) XOR CF.
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            local(body, 0x20, L_P);
            body.push_back(0xA7); // i32.wrap_i64
            body.push_back(0x73); // i32.xor
            orFlagBit(body, F_OF);
        } else if (sub == 5) {
            // OF = old MSB.
            local(body, 0x20, L_A);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            orFlagBit(body, F_OF);
        }
        // SAR: OF = 0, nothing to emit.
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
    body.push_back(0xA7); // i32.wrap_i64
    orFlagBit(body, F_PF);
    // rflags = (rflags & ~SHIFT_MASK) | (i32)L_F; AF and the rest preserved.
    local(body, 0x20, L_RFLAGS);
    i32Const(body, F_SHIFT_MASK);
    body.push_back(0x72); // i32.or
    i32Const(body, F_SHIFT_MASK);
    body.push_back(0x73); // i32.xor
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or
    local(body, 0x21, L_RFLAGS);
    // Store back to memory (faults on unmapped, like the interpreter's
    // storeRM). No register writeback.
    emitMemWrite(body, L_T1, L_R, op.size);
    return 0xFF;
}`;
}

// "rotate" template: register-direct ROL/ROR/RCL/RCR (emitRotate shape).
function genRotate(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U64 count = op.imm; // already masked to 0x1F/0x3F at decode
    const U32 destReg = op.rmIndex;
    const U64 mask = widthMask(op.size);
    const U64 sb = widthSB(op.size);
    const U64 wbits = (U64)op.size * 8;
    const U8 sub = op.sub; // 0=ROL, 1=ROR, 2=RCL, 3=RCR
    if (count == 0) {
        if (op.size == 4) {
            // As for shifts: the interpreter zero-extends the 32-bit
            // destination even on count==0; flags untouched.
            emitReadOperand(body, op, destReg, L_R);
            return destReg;
        }
        return 0xFF; // count==0: pure no-op for 1/2/8-bit
    }
    // L_A = width-masked operand.
    emitReadOperand(body, op, destReg, L_A);
    if (sub == 0 || sub == 1) {
        // ROL/ROR: single rotate; c == count here (count already masked).
        const U64 c = count % wbits;
        local(body, 0x20, L_A);
        if (sub == 0) { // ROL: (v << c) | (v >> (wbits - c))
            i64Const(body, c);
            body.push_back(0x86); // i64.shl
            local(body, 0x20, L_A);
            i64Const(body, wbits - c);
            body.push_back(0x88); // i64.shr_u
        } else { // ROR: (v >> c) | (v << (wbits - c))
            i64Const(body, c);
            body.push_back(0x88); // i64.shr_u
            local(body, 0x20, L_A);
            i64Const(body, wbits - c);
            body.push_back(0x86); // i64.shl
        }
        body.push_back(0x84); // i64.or
        i64Const(body, mask);
        body.push_back(0x83); // width-mask
        local(body, 0x21, L_R);
        // CF: ROL: result & 1; ROR: (result & sb) != 0. Stash as i64 0/1 in L_P.
        local(body, 0x20, L_R);
        if (sub == 0) {
            i64Const(body, 1);
            body.push_back(0x83); // i64.and -> 0/1
        } else {
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            body.push_back(0xAD); // i64.extend_i32_u
        }
        local(body, 0x21, L_P);
    } else {
        // RCL/RCR: rotate through carry, count iterations. The loop threads
        // the carry in L_P (incoming CF first) and the counter in L_B; L_R
        // holds the running result. L_A is free after the L_R init below.
        local(body, 0x20, L_RFLAGS);
        i32Const(body, 1);
        body.push_back(0x71); // i32.and -> incoming CF as 0/1
        body.push_back(0xAD); // i64.extend_i32_u
        local(body, 0x21, L_P);
        local(body, 0x20, L_A);
        local(body, 0x21, L_R);
        i64Const(body, count);
        local(body, 0x21, L_B);
        body.push_back(0x02); body.push_back(0x40); // block $done
        body.push_back(0x03); body.push_back(0x40); // loop $l
        local(body, 0x20, L_B);
        body.push_back(0x50); // i64.eqz
        body.push_back(0x0D); body.push_back(0x01); // br_if 1 ($done)
        if (sub == 2) { // RCL
            // newCf = (L_R & sb) != 0, stashed in L_A as i64 0/1.
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne
            body.push_back(0xAD); // i64.extend_i32_u
            local(body, 0x21, L_A);
            // L_R = ((L_R << 1) | L_P) & mask.
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x86); // i64.shl
            local(body, 0x20, L_P);
            body.push_back(0x84); // i64.or
            i64Const(body, mask);
            body.push_back(0x83); // width-mask
            local(body, 0x21, L_R);
            // Carry = newCf.
            local(body, 0x20, L_A);
            local(body, 0x21, L_P);
        } else { // RCR
            // newCf = L_R & 1, stashed in L_A.
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x83);
            local(body, 0x21, L_A);
            // L_R = (L_R >>u 1) | (L_P * sb); & mask for 32-bit.
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x88); // i64.shr_u
            local(body, 0x20, L_P);
            i64Const(body, sb);
            body.push_back(0x7E); // i64.mul: 0 or sb
            body.push_back(0x84); // i64.or
            i64Const(body, mask);
            body.push_back(0x83); // width-mask
            local(body, 0x21, L_R);
            local(body, 0x20, L_A);
            local(body, 0x21, L_P);
        }
        local(body, 0x20, L_B);
        i64Const(body, 1);
        body.push_back(0x7D); // i64.sub
        local(body, 0x21, L_B);
        body.push_back(0x0C); body.push_back(0x00); // br 0 ($l)
        body.push_back(0x0B); // end loop
        body.push_back(0x0B); // end block
    }
    // Flags: L_F accumulates CF and OF only.
    i64Const(body, 0);
    local(body, 0x21, L_F);
    local(body, 0x20, L_P);
    body.push_back(0xA7); // i32.wrap_i64
    orFlagBit(body, F_CF);
    // OF: only defined for count == 1 (stays 0 otherwise, matching the
    // interpreter clearing OF for count > 1).
    if (count == 1) {
        if (sub == 0 || sub == 2) {
            // OF = MSB(result) XOR CF.
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            local(body, 0x20, L_P);
            body.push_back(0xA7); // i32.wrap_i64
            body.push_back(0x73); // i32.xor
            orFlagBit(body, F_OF);
        } else {
            // OF = MSB(result) XOR MSB(result<<1).
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x86); // i64.shl
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            body.push_back(0x73); // i32.xor
            orFlagBit(body, F_OF);
        }
    }
    // rflags = (rflags & ~mask) | (i32)L_F; SZP/AF and the rest preserved.
    // OF is only defined for count==1; for count!=1 it is preserved from RFLAGS,
    // so the mask covers OF only when count==1.
    U32 rotMask = (count == 1) ? F_CFOF_MASK : (1u << F_CF);
    local(body, 0x20, L_RFLAGS);
    i32Const(body, rotMask);
    body.push_back(0x72); // i32.or
    i32Const(body, rotMask);
    body.push_back(0x73); // i32.xor
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or
    local(body, 0x21, L_RFLAGS);
    if (op.size == 1) { emitWriteByte(body, op, destReg, L_R); return 0xFF; }
    if (op.size == 2) { emitWriteWord(body, destReg, L_R); return 0xFF; }
    return destReg;
}`;
}

// "rotate" template, mem=true: memory-operand ROL/ROR/RCL/RCR
// (emitRotateMem shape). EA via emitEA; fault ordering is load ->
// compute+flags -> store, mirroring the interpreter's loadRM/doShift/
// storeRM. The count comes from op.imm (D1: implicit 1; C1: imm8 masked
// at decode).
function genRotateMem(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U64 count = op.imm;
    const U64 mask = widthMask(op.size);
    const U64 sb = widthSB(op.size);
    const U64 wbits = (U64)op.size * 8;
    const U8 sub = op.sub; // 0=ROL, 1=ROR, 2=RCL, 3=RCR
    emitEA(body, op); // L_T1 = effective address
    // L_A = width-masked memory operand. emitMemRead faults on unmapped
    // pages exactly like the interpreter's loadRM.
    emitMemRead(body, L_T1, op.size); // -> L_R (zero-extended)
    local(body, 0x20, L_R);
    i64Const(body, mask);
    body.push_back(0x83); // i64.and
    local(body, 0x21, L_A);
    if (count == 0) {
        // Interpreter: count==0 never stores to memory (the 32-bit
        // zero-extend on count==0 applies to registers only). Pure no-op;
        // flags untouched.
        return 0xFF;
    }
    if (sub == 0 || sub == 1) {
        // ROL/ROR: single rotate; c == count here (count already masked).
        const U64 c = count % wbits;
        local(body, 0x20, L_A);
        if (sub == 0) { // ROL: (v << c) | (v >> (wbits - c))
            i64Const(body, c);
            body.push_back(0x86); // i64.shl
            local(body, 0x20, L_A);
            i64Const(body, wbits - c);
            body.push_back(0x88); // i64.shr_u
        } else { // ROR: (v >> c) | (v << (wbits - c))
            i64Const(body, c);
            body.push_back(0x88); // i64.shr_u
            local(body, 0x20, L_A);
            i64Const(body, wbits - c);
            body.push_back(0x86); // i64.shl
        }
        body.push_back(0x84); // i64.or
        i64Const(body, mask);
        body.push_back(0x83); // width-mask
        local(body, 0x21, L_R);
        // CF: ROL: result & 1; ROR: (result & sb) != 0. Stash as i64 0/1 in L_P.
        local(body, 0x20, L_R);
        if (sub == 0) {
            i64Const(body, 1);
            body.push_back(0x83); // i64.and -> 0/1
        } else {
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            body.push_back(0xAD); // i64.extend_i32_u
        }
        local(body, 0x21, L_P);
    } else {
        // RCL/RCR: rotate through carry, count iterations. The loop threads
        // the carry in L_P (incoming CF first) and the counter in L_B; L_R
        // holds the running result. L_A is free after the L_R init below.
        local(body, 0x20, L_RFLAGS);
        i32Const(body, 1);
        body.push_back(0x71); // i32.and -> incoming CF as 0/1
        body.push_back(0xAD); // i64.extend_i32_u
        local(body, 0x21, L_P);
        local(body, 0x20, L_A);
        local(body, 0x21, L_R);
        i64Const(body, count);
        local(body, 0x21, L_B);
        body.push_back(0x02); body.push_back(0x40); // block $done
        body.push_back(0x03); body.push_back(0x40); // loop $l
        local(body, 0x20, L_B);
        body.push_back(0x50); // i64.eqz
        body.push_back(0x0D); body.push_back(0x01); // br_if 1 ($done)
        if (sub == 2) { // RCL
            // newCf = (L_R & sb) != 0, stashed in L_A as i64 0/1.
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne
            body.push_back(0xAD); // i64.extend_i32_u
            local(body, 0x21, L_A);
            // L_R = ((L_R << 1) | L_P) & mask.
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x86); // i64.shl
            local(body, 0x20, L_P);
            body.push_back(0x84); // i64.or
            i64Const(body, mask);
            body.push_back(0x83); // width-mask
            local(body, 0x21, L_R);
            // Carry = newCf.
            local(body, 0x20, L_A);
            local(body, 0x21, L_P);
        } else { // RCR
            // newCf = L_R & 1, stashed in L_A.
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x83);
            local(body, 0x21, L_A);
            // L_R = (L_R >>u 1) | (L_P * sb); & mask for 32-bit.
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x88); // i64.shr_u
            local(body, 0x20, L_P);
            i64Const(body, sb);
            body.push_back(0x7E); // i64.mul: 0 or sb
            body.push_back(0x84); // i64.or
            i64Const(body, mask);
            body.push_back(0x83); // width-mask
            local(body, 0x21, L_R);
            local(body, 0x20, L_A);
            local(body, 0x21, L_P);
        }
        local(body, 0x20, L_B);
        i64Const(body, 1);
        body.push_back(0x7D); // i64.sub
        local(body, 0x21, L_B);
        body.push_back(0x0C); body.push_back(0x00); // br 0 ($l)
        body.push_back(0x0B); // end loop
        body.push_back(0x0B); // end block
    }
    // Flags: L_F accumulates CF and OF only (same as genRotate).
    i64Const(body, 0);
    local(body, 0x21, L_F);
    local(body, 0x20, L_P);
    body.push_back(0xA7); // i32.wrap_i64
    orFlagBit(body, F_CF);
    // OF: only defined for count == 1 (D1 always; stays 0 otherwise,
    // matching the interpreter clearing OF for count > 1).
    if (count == 1) {
        if (sub == 0 || sub == 2) {
            // OF = MSB(result) XOR CF.
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            local(body, 0x20, L_P);
            body.push_back(0xA7); // i32.wrap_i64
            body.push_back(0x73); // i32.xor
            orFlagBit(body, F_OF);
        } else {
            // OF = MSB(result) XOR MSB(result<<1).
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x86); // i64.shl
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            body.push_back(0x73); // i32.xor
            orFlagBit(body, F_OF);
        }
    }
    // rflags = (rflags & ~mask) | (i32)L_F; SZP/AF and the rest preserved.
    U32 rotMask = (count == 1) ? F_CFOF_MASK : (1u << F_CF);
    local(body, 0x20, L_RFLAGS);
    i32Const(body, rotMask);
    body.push_back(0x72); // i32.or
    i32Const(body, rotMask);
    body.push_back(0x73); // i32.xor
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or
    local(body, 0x21, L_RFLAGS);
    // Store back to memory (faults on unmapped, like the interpreter's
    // storeRM). No register writeback.
    emitMemWrite(body, L_T1, L_R, op.size);
    return 0xFF;
}`;
}

// "imul2" template: two-operand IMUL r, r/m (emitImul shape)
function genImul2(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U32 destReg = op.regField;
    const U32 srcReg = op.rmIndex;
    const U64 m32 = 0xFFFFFFFFULL;
    // L_A = sign-extended dest operand, L_B = sign-extended source operand.
    // (For 64-bit the raw u64 bit pattern already is the S64 operand.)
    local(body, 0x20, destReg + 1);
    emitSext(body, op.size);
    local(body, 0x21, L_A);
    local(body, 0x20, srcReg + 1);
    emitSext(body, op.size);
    local(body, 0x21, L_B);
    // L_R = wrapped 64-bit product (exact for 16/32-bit: |operands| < 2^32).
    local(body, 0x20, L_A);
    local(body, 0x20, L_B);
    body.push_back(0x7E); // i64.mul
    local(body, 0x21, L_R);
    // Overflow detection -> i32 0/1 on the stack.
    if (op.size == 2 || op.size == 4) {
        // 16/32-bit: the 64-bit product is exact; overflow iff it differs
        // from its own width sign extension.
        local(body, 0x20, L_R);
        emitSext(body, op.size); // sext16/32(L_R)
        local(body, 0x20, L_R);
        body.push_back(0x52); // i64.ne
    } else {
        // 64-bit: the product needs 128 bits. Compute the high 64 bits of
        // the unsigned product from 32-bit limbs, then adjust for signedness.
        //
        // Write a = a1*2^32+a0, b = b1*2^32+b0 (32-bit limbs) and
        // t0=a0*b0, t1=a1*b0, t2=a0*b1, t3=a1*b1 (all exact 64-bit). Then
        //   hi_u = t3 + s_hi + m_hi
        // where s_hi = (t1+t2)>>32 and
        // m_hi = (((t1+t2) mod 2^32)+(t0>>32))>>32. The true high word is
        // < 2^64 and every term is non-negative, so no intermediate i64.add
        // wraps. Finally
        //   signed_hi = hi_u - (a<0 ? b : 0) - (b<0 ? a : 0)  (mod 2^64)
        // and overflow iff signed_hi != sign_extend_64(lo).
        i64Const(body, 0);
        local(body, 0x21, L_P); // hi_u = 0
        // t3 = a1*b1; hi_u += t3.
        local(body, 0x20, L_A);
        i64Const(body, 32);
        body.push_back(0x88); // i64.shr_u -> a1
        local(body, 0x20, L_B);
        i64Const(body, 32);
        body.push_back(0x88); // b1
        body.push_back(0x7E); // t3 (exact, < 2^64)
        local(body, 0x20, L_P);
        body.push_back(0x7C); // i64.add
        local(body, 0x21, L_P);
        // t1 = a1*b0 -> L_T1; t2 = a0*b1 -> L_T2.
        local(body, 0x20, L_A);
        i64Const(body, 32);
        body.push_back(0x88);
        local(body, 0x20, L_B);
        i64Const(body, m32);
        body.push_back(0x83);
        body.push_back(0x7E);
        local(body, 0x21, L_T1);
        local(body, 0x20, L_A);
        i64Const(body, m32);
        body.push_back(0x83);
        local(body, 0x20, L_B);
        i64Const(body, 32);
        body.push_back(0x88);
        body.push_back(0x7E);
        local(body, 0x21, L_T2);
        // s_hi = (t1>>32)+(t2>>32)+(((t1&m32)+(t2&m32))>>32); hi_u += s_hi.
        // (t1>>32),(t2>>32) < 2^32 and the carry < 2, so s_hi < 2^33: exact.
        local(body, 0x20, L_T1);
        i64Const(body, 32);
        body.push_back(0x88);
        local(body, 0x20, L_T2);
        i64Const(body, 32);
        body.push_back(0x88);
        body.push_back(0x7C);
        local(body, 0x20, L_T1);
        i64Const(body, m32);
        body.push_back(0x83);
        local(body, 0x20, L_T2);
        i64Const(body, m32);
        body.push_back(0x83);
        body.push_back(0x7C); // lo_sum (< 2^33, exact)
        local(body, 0x22, L_T1); // tee: stash lo_sum, keep on stack
        i64Const(body, 32);
        body.push_back(0x88); // carry_s
        body.push_back(0x7C); // s_hi
        local(body, 0x20, L_P);
        body.push_back(0x7C);
        local(body, 0x21, L_P);
        // m = (lo_sum&m32)+(t0>>32) (< 2^33, exact); m_hi = m>>32; hi_u += m_hi.
        local(body, 0x20, L_T1);
        i64Const(body, m32);
        body.push_back(0x83); // s_lo32
        local(body, 0x20, L_A);
        i64Const(body, m32);
        body.push_back(0x83); // a0
        local(body, 0x20, L_B);
        i64Const(body, m32);
        body.push_back(0x83); // b0
        body.push_back(0x7E); // t0 (exact)
        i64Const(body, 32);
        body.push_back(0x88); // t0_hi
        body.push_back(0x7C); // m
        i64Const(body, 32);
        body.push_back(0x88); // m_hi
        local(body, 0x20, L_P);
        body.push_back(0x7C);
        local(body, 0x21, L_P);
        // signed_hi = hi_u - a_s*b - b_s*a (mod 2^64); overflow iff it
        // differs from shr_s(lo, 63) (0 when lo >= 0, -1 when lo < 0).
        local(body, 0x20, L_P);
        local(body, 0x20, L_A);
        i64Const(body, 63);
        body.push_back(0x88); // a_s (0/1)
        local(body, 0x20, L_B);
        body.push_back(0x7E); // a_s * b (0 or b)
        body.push_back(0x7D); // i64.sub
        local(body, 0x20, L_B);
        i64Const(body, 63);
        body.push_back(0x88); // b_s
        local(body, 0x20, L_A);
        body.push_back(0x7E); // b_s * a
        body.push_back(0x7D);
        local(body, 0x20, L_R);
        i64Const(body, 63);
        body.push_back(0x87); // i64.shr_s -> 0 or -1
        body.push_back(0x52); // i64.ne -> i32 overflow bit
    }
    // L_F = overflow ? (CF|OF) : 0. The overflow bit is 0/1, so scale it
    // with i64.mul (1 & 0x801 would stay 1, not set both flag bits).
    body.push_back(0xAD); // i64.extend_i32_u
    i64Const(body, F_CFOF_MASK);
    body.push_back(0x7E); // i64.mul
    local(body, 0x21, L_F);
    // Publish: 32-bit zero-extends the destination (setU32); 16-bit
    // preserves the upper 48 (setU16, RMW).
    if (op.size == 4) {
        local(body, 0x20, L_R);
        i64Const(body, m32);
        body.push_back(0x83);
        local(body, 0x21, L_R);
    }
    // rflags = (rflags & ~CFOF_MASK) | (i32)L_F; everything else preserved.
    local(body, 0x20, L_RFLAGS);
    i32Const(body, F_CFOF_MASK);
    body.push_back(0x72); // i32.or
    i32Const(body, F_CFOF_MASK);
    body.push_back(0x73); // i32.xor
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or
    local(body, 0x21, L_RFLAGS);
    if (op.size == 2) { emitWriteWord(body, destReg, L_R); return 0xFF; }
    return destReg;
}`;
}

// "imul1" template: one-operand IMUL r/m (emitImul1 shape)
function genImul1(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U64 m32 = 0xFFFFFFFFULL;
    // L_A = sign-extended RAX operand at width; L_B = sign-extended r/m.
    if (op.size == 1) emitReadByte(body, op, 0, L_A);
    else {
        local(body, 0x20, 0 + 1); // RAX
        if (op.size == 2) {
            i64Const(body, 0xFFFFULL);
            body.push_back(0x83);
        } else if (op.size == 4) {
            i64Const(body, m32);
            body.push_back(0x83);
        }
        local(body, 0x21, L_A);
    }
    if (op.size == 1) emitReadByte(body, op, op.rmIndex, L_B);
    else {
        local(body, 0x20, op.rmIndex + 1);
        if (op.size == 2) {
            i64Const(body, 0xFFFFULL);
            body.push_back(0x83);
        } else if (op.size == 4) {
            i64Const(body, m32);
            body.push_back(0x83);
        }
        local(body, 0x21, L_B);
    }
    local(body, 0x20, L_A);
    emitSext(body, op.size == 1 ? 1 : op.size);
    local(body, 0x21, L_A);
    local(body, 0x20, L_B);
    emitSext(body, op.size == 1 ? 1 : op.size);
    local(body, 0x21, L_B);
    // L_R = wrapped product.
    local(body, 0x20, L_A);
    local(body, 0x20, L_B);
    body.push_back(0x7E); // i64.mul
    local(body, 0x21, L_R);
    // Overflow -> i32 0/1 on the stack; then write the halves.
    if (op.size == 8) {
        // 128-bit check via limbs (same method as emitImul).
        // Compute signed_hi in L_P using the limb method.
        i64Const(body, 0);
        local(body, 0x21, L_P);
        local(body, 0x20, L_A);
        i64Const(body, 32); body.push_back(0x88);
        local(body, 0x20, L_B);
        i64Const(body, 32); body.push_back(0x88);
        body.push_back(0x7E);
        local(body, 0x20, L_P); body.push_back(0x7C);
        local(body, 0x21, L_P);
        local(body, 0x20, L_A);
        i64Const(body, 32); body.push_back(0x88);
        local(body, 0x20, L_B);
        i64Const(body, m32); body.push_back(0x83);
        body.push_back(0x7E);
        local(body, 0x21, L_T1);
        local(body, 0x20, L_A);
        i64Const(body, m32); body.push_back(0x83);
        local(body, 0x20, L_B);
        i64Const(body, 32); body.push_back(0x88);
        body.push_back(0x7E);
        local(body, 0x21, L_T2);
        local(body, 0x20, L_T1);
        i64Const(body, 32); body.push_back(0x88);
        local(body, 0x20, L_T2);
        i64Const(body, 32); body.push_back(0x88);
        body.push_back(0x7C);
        local(body, 0x20, L_T1);
        i64Const(body, m32); body.push_back(0x83);
        local(body, 0x20, L_T2);
        i64Const(body, m32); body.push_back(0x83);
        body.push_back(0x7C);
        local(body, 0x22, L_T1);
        i64Const(body, 32); body.push_back(0x88);
        body.push_back(0x7C);
        local(body, 0x20, L_P); body.push_back(0x7C);
        local(body, 0x21, L_P);
        local(body, 0x20, L_T1);
        i64Const(body, m32); body.push_back(0x83);
        local(body, 0x20, L_A);
        i64Const(body, m32); body.push_back(0x83);
        local(body, 0x20, L_B);
        i64Const(body, m32); body.push_back(0x83);
        body.push_back(0x7E);
        i64Const(body, 32); body.push_back(0x88);
        body.push_back(0x7C);
        i64Const(body, 32); body.push_back(0x88);
        local(body, 0x20, L_P); body.push_back(0x7C);
        local(body, 0x21, L_P);
        // signed_hi = hi_u - a_s*b - b_s*a; compare with sext64(lo).
        local(body, 0x20, L_P);
        local(body, 0x20, L_A);
        i64Const(body, 63); body.push_back(0x88);
        local(body, 0x20, L_B);
        body.push_back(0x7E);
        body.push_back(0x7D);
        local(body, 0x20, L_B);
        i64Const(body, 63); body.push_back(0x88);
        local(body, 0x20, L_A);
        body.push_back(0x7E);
        body.push_back(0x7D);
        // Stack: [signed_hi]. Save it (L_T1/L_T2 are dead after hi_u).
        local(body, 0x21, L_T1); // L_T1 = signed_hi. Stack: [].
        // Overflow: signed_hi != sext64(lo).
        local(body, 0x20, L_T1);
        local(body, 0x20, L_R);
        i64Const(body, 63); body.push_back(0x87);
        body.push_back(0x52); // i64.ne -> i32 overflow. Stack: [overflow].
        // Write RDX:RAX = signed_hi:lo.
        local(body, 0x20, L_T1);
        local(body, 0x21, 2 + 1); // RDX (GPR 2). Stack: [overflow].
        local(body, 0x20, L_R);
        local(body, 0x21, 0 + 1); // RAX (GPR 0). Stack: [overflow].
    } else {
        // 8/16/32-bit: product exact in 64 bits; overflow iff it differs
        // from its own width sign extension.
        local(body, 0x20, L_R);
        emitSext(body, op.size == 1 ? 1 : op.size);
        local(body, 0x20, L_R);
        body.push_back(0x52); // i64.ne -> i32 overflow
        if (op.size == 1) {
            // AX = prod (setU16, upper RAX preserved).
            emitWriteWord(body, 0, L_R);
        } else if (op.size == 2) {
            // DX:AX = prod (setU16 halves).
            local(body, 0x20, L_R);
            i64Const(body, 0xFFFFULL); body.push_back(0x83);
            local(body, 0x21, L_T1);
            emitWriteWord(body, 0, L_T1); // AX
            local(body, 0x20, L_R);
            i64Const(body, 16); body.push_back(0x88); // hi
            i64Const(body, 0xFFFFULL); body.push_back(0x83);
            local(body, 0x21, L_T1);
            emitWriteWord(body, 2, L_T1); // DX (GPR 2)
        } else {
            // EDX:EAX: full 64-bit writes of the zero-extended halves.
            local(body, 0x20, L_R);
            i64Const(body, m32); body.push_back(0x83);
            local(body, 0x21, 0 + 1); // RAX = lo
            local(body, 0x20, L_R);
            i64Const(body, 32); body.push_back(0x88);
            i64Const(body, m32); body.push_back(0x83);
            local(body, 0x21, 2 + 1); // RDX (GPR 2) = hi
        }
    }
    // L_F = overflow ? (CF|OF) : 0; merge preserving other flags.
    body.push_back(0xAD); // i64.extend_i32_u
    i64Const(body, F_CFOF_MASK);
    body.push_back(0x7E); // i64.mul
    local(body, 0x21, L_F);
    local(body, 0x20, L_RFLAGS);
    i32Const(body, F_CFOF_MASK);
    body.push_back(0x72); // i32.or
    i32Const(body, F_CFOF_MASK);
    body.push_back(0x73); // i32.xor
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or
    local(body, 0x21, L_RFLAGS);
    return 0xFF;
}`;
}

// "imul3" template: three-operand IMUL r, r/m, imm (emitImul3 shape)
function genImul3(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U32 destReg = op.regField;
    // L_A = sign-extended source; L_B = sign-extended immediate.
    local(body, 0x20, op.rmIndex + 1);
    if (op.size == 2) {
        i64Const(body, 0xFFFFULL);
        body.push_back(0x83);
    } else if (op.size == 4) {
        i64Const(body, 0xFFFFFFFFULL);
        body.push_back(0x83);
    }
    emitSext(body, op.size);
    local(body, 0x21, L_A);
    i64Const(body, (U64)op.imm); // already sign-extended at decode
    local(body, 0x21, L_B);
    // L_R = wrapped product.
    local(body, 0x20, L_A);
    local(body, 0x20, L_B);
    body.push_back(0x7E); // i64.mul
    local(body, 0x21, L_R);
    if (op.size == 8) {
        // 128-bit overflow check (limb method, L_A/L_B/L_R as in emitImul).
        i64Const(body, 0);
        local(body, 0x21, L_P);
        local(body, 0x20, L_A);
        i64Const(body, 32); body.push_back(0x88);
        local(body, 0x20, L_B);
        i64Const(body, 32); body.push_back(0x88);
        body.push_back(0x7E);
        local(body, 0x20, L_P); body.push_back(0x7C);
        local(body, 0x21, L_P);
        local(body, 0x20, L_A);
        i64Const(body, 32); body.push_back(0x88);
        local(body, 0x20, L_B);
        i64Const(body, 0xFFFFFFFFULL); body.push_back(0x83);
        body.push_back(0x7E);
        local(body, 0x21, L_T1);
        local(body, 0x20, L_A);
        i64Const(body, 0xFFFFFFFFULL); body.push_back(0x83);
        local(body, 0x20, L_B);
        i64Const(body, 32); body.push_back(0x88);
        body.push_back(0x7E);
        local(body, 0x21, L_T2);
        local(body, 0x20, L_T1);
        i64Const(body, 32); body.push_back(0x88);
        local(body, 0x20, L_T2);
        i64Const(body, 32); body.push_back(0x88);
        body.push_back(0x7C);
        local(body, 0x20, L_T1);
        i64Const(body, 0xFFFFFFFFULL); body.push_back(0x83);
        local(body, 0x20, L_T2);
        i64Const(body, 0xFFFFFFFFULL); body.push_back(0x83);
        body.push_back(0x7C);
        local(body, 0x22, L_T1);
        i64Const(body, 32); body.push_back(0x88);
        body.push_back(0x7C);
        local(body, 0x20, L_P); body.push_back(0x7C);
        local(body, 0x21, L_P);
        local(body, 0x20, L_T1);
        i64Const(body, 0xFFFFFFFFULL); body.push_back(0x83);
        local(body, 0x20, L_A);
        i64Const(body, 0xFFFFFFFFULL); body.push_back(0x83);
        local(body, 0x20, L_B);
        i64Const(body, 0xFFFFFFFFULL); body.push_back(0x83);
        body.push_back(0x7E);
        i64Const(body, 32); body.push_back(0x88);
        body.push_back(0x7C);
        i64Const(body, 32); body.push_back(0x88);
        local(body, 0x20, L_P); body.push_back(0x7C);
        local(body, 0x21, L_P);
        local(body, 0x20, L_P);
        local(body, 0x20, L_A);
        i64Const(body, 63); body.push_back(0x88);
        local(body, 0x20, L_B);
        body.push_back(0x7E);
        body.push_back(0x7D);
        local(body, 0x20, L_B);
        i64Const(body, 63); body.push_back(0x88);
        local(body, 0x20, L_A);
        body.push_back(0x7E);
        body.push_back(0x7D);
        local(body, 0x20, L_R);
        i64Const(body, 63); body.push_back(0x87);
        body.push_back(0x52); // i64.ne -> i32 overflow
    } else {
        local(body, 0x20, L_R);
        emitSext(body, op.size);
        local(body, 0x20, L_R);
        body.push_back(0x52); // i64.ne -> i32 overflow
    }
    body.push_back(0xAD); // i64.extend_i32_u
    i64Const(body, F_CFOF_MASK);
    body.push_back(0x7E); // i64.mul
    local(body, 0x21, L_F);
    // Publish: 16-bit preserves upper (RMW); 32-bit zero-extends.
    if (op.size == 2) emitWriteWord(body, destReg, L_R);
    else {
        local(body, 0x20, L_R);
        if (op.size == 4) {
            i64Const(body, 0xFFFFFFFFULL);
            body.push_back(0x83);
        }
        local(body, 0x21, destReg + 1);
    }
    local(body, 0x20, L_RFLAGS);
    i32Const(body, F_CFOF_MASK);
    body.push_back(0x72); // i32.or
    i32Const(body, F_CFOF_MASK);
    body.push_back(0x73); // i32.xor
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or
    local(body, 0x21, L_RFLAGS);
    return 0xFF; // destination already published inline above
}`;
}

// "movx" template: movx
function genMovx(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U32 destReg = op.regField;
    const U32 srcReg = op.rmIndex;
    const U8 srcSize = (op.sub == 0 || op.sub == 2) ? 1 : (op.sub == 4 ? 4 : 2);
    const bool isSigned = op.sub >= 2;
    // L_R = extended source value.
    if (srcSize == 1) emitReadByte(body, op, srcReg, L_R);
    else if (srcSize == 2) emitReadWord(body, srcReg, L_R);
    else {
        // MOVSXD (sub 4): 32-bit source; the register holds the operand in
        // its low 32 bits (the interpreter's loadRM(m, 4)).
        local(body, 0x20, srcReg + 1);
        i64Const(body, 0xFFFFFFFFULL);
        body.push_back(0x83); // i64.and
        local(body, 0x21, L_R);
    }
    if (isSigned) {
        local(body, 0x20, L_R);
        emitSext(body, srcSize);
        local(body, 0x21, L_R);
    }
    if (op.size == 2) {
        // setU16: low 16 bits, upper 48 preserved.
        emitWriteWord(body, destReg, L_R);
        return 0xFF;
    }
    // 32/64-bit: the value already fits (zero-extended by construction for
    // MOVZX; low 32 bits of the sign extension for MOVSX/MOVSXD); publish
    // via L_R.
    if (op.size == 4 && isSigned) {
        local(body, 0x20, L_R);
        i64Const(body, 0xFFFFFFFFULL);
        body.push_back(0x83); // i64.and
        local(body, 0x21, L_R);
    }
    return destReg;
}`;
}

function genLea(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    // LEA r, m: the value IS the effective address. Mirrors cpu64.cpp
    // BK_LEA exactly: 32-bit zero-extends, 64-bit stores the full address.
    // (16-bit LEA never reaches emission: the classifier rejects it, and
    // the interpreter's block decoder breaks on it too.) No flags are
    // touched and no memory is read, so a bad address cannot fault.
    emitEA(body, op); // L_T1 = effective address
    local(body, 0x20, L_T1);
    if (op.size == 4) {
        i64Const(body, 0xFFFFFFFFULL);
        body.push_back(0x83); // i64.and: 32-bit zero extension
    }
    local(body, 0x21, L_R);
    return op.regField;
}`;
}

// "stack" template: PUSH/POP (emitStackGen).
// Always 64-bit. RSP is GPR local 5 (X64_RSP == 4; GPR local index = reg+1).
// The order of the RSP update vs the memory access mirrors cpu64.cpp exactly
// (reads return 0 and writes commit on unmapped pages, so the ORDER is the
// observable contract):
//   PUSH reg (sub 0): push64: value = old reg contents (PUSH RSP pushes the
//                     old RSP), RSP -= 8, [RSP] = value.
//   PUSH imm (sub 1): dsp_22: [RSP-8] = imm FIRST, then RSP -= 8.
//   PUSH r/m (sub 2): v = loadRM(m, 8); push64(v): read r/m (register or
//                     [decode-time EA]), RSP -= 8, [RSP] = v.
//   POP reg  (sub 0): v = readq(RSP); RSP += 8; reg = v. (POP RSP: the
//                     popped value overwrites the incremented RSP.)
//   POP r/m  (sub 1): v = pop64(); storeRM(m, 8, v): the EA is decode-time
//                     (pre-instruction registers), so emitEA runs BEFORE the
//                     RSP update; then v = [RSP], RSP += 8, r/m = v.
// No flags are touched. Returns 0xFF: RSP is updated inline in its local
// and the epilogue store-back publishes it.
function genStack(e) {
  const L = [];
  L.push(`U32 ${e.func}(Bytes& body, const Jit64Op& op) {`);
  L.push(`    constexpr U32 L_RSP = 5; // X64_RSP == 4; GPR local index = reg + 1`);
  L.push(`    if (op.kind == J64_PUSH) {`);
  L.push(`        if (op.sub == 0) {`);
  L.push(`            // PUSH reg: snapshot the source first (PUSH RSP pushes`);
  L.push(`            // the OLD rsp), then RSP -= 8, then [RSP] = value.`);
  L.push(`            local(body, 0x20, op.regField + 1);`);
  L.push(`            local(body, 0x21, L_A);`);
  L.push(`            local(body, 0x20, L_RSP);`);
  L.push(`            i64Const(body, 8);`);
  L.push(`            body.push_back(0x7D); // i64.sub`);
  L.push(`            local(body, 0x21, L_RSP);`);
  L.push(`            emitMemWrite(body, L_RSP, L_A, 8);`);
  L.push(`        } else if (op.sub == 1) {`);
  L.push(`            // PUSH imm: the interpreter writes [RSP-8] BEFORE`);
  L.push(`            // updating RSP (dsp_22).`);
  L.push(`            local(body, 0x20, L_RSP);`);
  L.push(`            i64Const(body, 8);`);
  L.push(`            body.push_back(0x7D); // i64.sub`);
  L.push(`            local(body, 0x21, L_T1);`);
  L.push(`            i64Const(body, (S64)op.imm); // sign-extended at decode`);
  L.push(`            local(body, 0x21, L_A);`);
  L.push(`            emitMemWrite(body, L_T1, L_A, 8);`);
  L.push(`            local(body, 0x20, L_T1);`);
  L.push(`            local(body, 0x21, L_RSP);`);
  L.push(`        } else {`);
  L.push(`            // PUSH r/m: read the operand first (register, or`);
  L.push(`            // [decode-time EA]), then RSP -= 8, then [RSP] = value.`);
  L.push(`            if (op.isMem) {`);
  L.push(`                emitEA(body, op); // L_T1 = effective address`);
  L.push(`                emitMemRead(body, L_T1, 8); // L_R = [EA]`);
  L.push(`                local(body, 0x20, L_R);`);
  L.push(`            } else {`);
  L.push(`                local(body, 0x20, op.rmIndex + 1);`);
  L.push(`            }`);
  L.push(`            local(body, 0x21, L_A);`);
  L.push(`            local(body, 0x20, L_RSP);`);
  L.push(`            i64Const(body, 8);`);
  L.push(`            body.push_back(0x7D); // i64.sub`);
  L.push(`            local(body, 0x21, L_RSP);`);
  L.push(`            emitMemWrite(body, L_RSP, L_A, 8);`);
  L.push(`        }`);
  L.push(`    } else {`);
  L.push(`        // POP. The r/m EA (if any) is decode-time, from`);
  L.push(`        // pre-instruction registers: compute it BEFORE the RSP`);
  L.push(`        // update so RSP-relative EAs see the old RSP.`);
  L.push(`        if (op.sub == 1 && op.isMem) emitEA(body, op); // L_T1 = EA`);
  L.push(`        emitMemRead(body, L_RSP, 8); // L_R = [RSP]`);
  L.push(`        local(body, 0x20, L_RSP);`);
  L.push(`        i64Const(body, 8);`);
  L.push(`        body.push_back(0x7C); // i64.add`);
  L.push(`        local(body, 0x21, L_RSP);`);
  L.push(`        local(body, 0x20, L_R);`);
  L.push(`        local(body, 0x21, L_A);`);
  L.push(`        if (op.sub == 0) {`);
  L.push(`            // POP reg: reg = v (POP RSP overwrites the +8).`);
  L.push(`            local(body, 0x20, L_A);`);
  L.push(`            local(body, 0x21, op.regField + 1);`);
  L.push(`        } else if (op.isMem) {`);
  L.push(`            // POP r/m (memory): [EA] = v.`);
  L.push(`            emitMemWrite(body, L_T1, L_A, 8);`);
  L.push(`        } else {`);
  L.push(`            // POP r/m (register-direct): reg = v.`);
  L.push(`            local(body, 0x20, L_A);`);
  L.push(`            local(body, 0x21, op.rmIndex + 1);`);
  L.push(`        }`);
  L.push(`    }`);
  L.push(`    return 0xFF;`);
  L.push(`}`);
  return L.join("\n");
}


// "mov8" template: 8-bit MOV (emitMov8Gen).
// 0x88 MOV r/m8, r8; 0x8A MOV r8, r/m8. Mirrors cpu64.cpp dsp_9/dsp_10
// exactly: no flags are touched; 8-bit register access follows the
// AH/BH/CH/DH-vs-REX rule via emitReadByte/emitWriteByte; memory forms
// go through the imported helpers with the interpreter's fault ordering:
//   88 mem: readReg8 (cannot fault), then [EA] = byte (may fault);
//   8A mem: byte = [EA] (may fault), then writeReg8 (cannot fault).
// The EA is computed from pre-instruction registers (decode-time), so
// emitEA runs before any register write. Returns 0xFF: GPR writes happen
// inline in the GPR locals and the epilogue store-back publishes them.
function genMov8(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U32 src = op.kind == J64_MOV_RM_R ? op.regField : op.rmIndex;
    const U32 dest = op.kind == J64_MOV_RM_R ? op.rmIndex : op.regField;
    if (op.isMem) {
        emitEA(body, op); // L_T1 = effective address
        if (op.kind == J64_MOV_RM_R) {
            emitReadByte(body, op, src, L_A);
            emitMemWrite(body, L_T1, L_A, 1);
        } else {
            emitMemRead(body, L_T1, 1); // L_R = [EA]
            emitWriteByte(body, op, dest, L_R);
        }
    } else {
        emitReadByte(body, op, src, L_A);
        emitWriteByte(body, op, dest, L_A);
    }
    return 0xFF;
}`;
}

// "movimm8" template: MOV r/m8, imm8 (emitMovImm8Gen).
// 0xC6 /0. Mirrors cpu64.cpp dsp_12 exactly: no flags are touched; the
// 1-byte immediate is written to the 8-bit register or memory location.
// Register destinations follow the AH/BH/CH/DH-vs-REX rule via
// emitWriteByte (but AH/BH/CH/DH are declined to the interpreter by the
// classifier). Memory forms go through emitEA + emitMemWrite with the
// interpreter's fault ordering: the EA is computed from pre-instruction
// registers (decode-time), then [EA] = imm8 (may fault).
// Returns 0xFF: the write happens inline (GPR locals for reg, imported
// helper for mem) and the epilogue store-back publishes GPRs.
function genMovImm8(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    i64Const(body, op.imm & 0xFF);
    local(body, 0x21, L_A); // L_A = imm8
    if (op.isMem) {
        emitEA(body, op); // L_T1 = effective address
        emitMemWrite(body, L_T1, L_A, 1);
    } else {
        emitWriteByte(body, op, op.rmIndex, L_A);
    }
    return 0xFF;
}`;
}

// "setcc" template: SETcc r/m8 (emitSetccGen).
// 0F 90..9F: dest = (condition holds) ? 1 : 0. The condition evaluator is
// identical to CMOVcc (mirrors CPU64::evalCC): leaves i32 0/1 on the stack.
// Extended to i64, stored to L_A, then written via emitWriteByte (reg) or
// emitEA + emitMemWrite (mem). No flags are touched (only read).
// Returns 0xFF: the write happens inline (GPR locals for reg, imported
// helper for mem) and the epilogue store-back publishes GPRs.
function genSetcc(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    // Condition evaluator: leaves i32 0/1 on the stack. Same logic as
    // the CMOVcc template (and CPU64::evalCC). L_RFLAGS is i32.
    auto emitCond = [&]() {
        const U8 cc = op.sub;
        auto pushFlagBit = [&](U32 bit) {
            local(body, 0x20, L_RFLAGS); // i32
            i32Const(body, bit);
            body.push_back(0x76); // i32.shr_u
            i32Const(body, 1);
            body.push_back(0x71); // i32.and -> i32 0/1
        };
        switch (cc & 0xE) {
            case 0x0: pushFlagBit(F_OF); break;
            case 0x2: pushFlagBit(F_CF); break;
            case 0x4: pushFlagBit(F_ZF); break;
            case 0x6:
                pushFlagBit(F_CF);
                pushFlagBit(F_ZF);
                body.push_back(0x72); // i32.or
                break;
            case 0x8: pushFlagBit(F_SF); break;
            case 0xA: pushFlagBit(F_PF); break;
            case 0xC:
                pushFlagBit(F_SF);
                pushFlagBit(F_OF);
                body.push_back(0x73); // i32.xor
                break;
            case 0xE:
                pushFlagBit(F_ZF);
                pushFlagBit(F_SF);
                pushFlagBit(F_OF);
                body.push_back(0x73); // i32.xor (SF^OF)
                body.push_back(0x72); // i32.or (ZF | (SF^OF))
                break;
        }
        if (cc & 0x1) body.push_back(0x45); // i32.eqz
    };
    emitCond(); // i32 0/1 on stack
    body.push_back(0xAD); // i64.extend_i32_u -> i64 0/1
    local(body, 0x21, L_A); // L_A = result byte
    if (op.isMem) {
        emitEA(body, op); // L_T1 = effective address
        emitMemWrite(body, L_T1, L_A, 1);
    } else {
        emitWriteByte(body, op, op.rmIndex, L_A);
    }
    return 0xFF;
}`;
}

// "bt" template: BT/BTS/BTR/BTC r/m16/32/64, r16/32/64 (emitBtGen).
// Bit index from ModRM reg field (GPR); target is r/m (reg or mem).
// Mirrors cpu64.cpp: bit = idx & (width-1); CF = (v >> bit) & 1;
// BTS: v |= (1<<bit); BTR: v &= ~(1<<bit); BTC: v ^= (1<<bit).
// Only CF is written; all other flags preserved.
function genBt(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U32 size = op.size; // 2, 4, or 8
    const U32 sub = op.sub;   // 0=BT, 1=BTS, 2=BTR, 3=BTC
    const U64 wbits = (U64)size * 8;
    const U64 widthMask = size == 2 ? 0xFFFFULL :
                          size == 4 ? 0xFFFFFFFFULL : 0xFFFFFFFFFFFFFFFFULL;
    const U64 bitMask = wbits - 1; // 15, 31, or 63

    // L_T2 = bit index: GPR[regField] masked to width, then & (wbits-1).
    local(body, 0x20, op.regField + 1);
    if (size != 8) {
        i64Const(body, widthMask);
        body.push_back(0x83); // i64.and
    }
    i64Const(body, bitMask);
    body.push_back(0x83); // i64.and
    local(body, 0x21, L_T2);

    // L_A = target value, masked to width.
    if (op.isMem) {
        emitEA(body, op); // L_T1 = EA
        emitMemRead(body, L_T1, size); // -> L_R
        local(body, 0x20, L_R);
    } else {
        local(body, 0x20, op.rmIndex + 1);
    }
    if (size != 8) {
        i64Const(body, widthMask);
        body.push_back(0x83); // i64.and
    }
    local(body, 0x21, L_A);

    // L_B = selected bit: (L_A >> L_T2) & 1.
    local(body, 0x20, L_A);
    local(body, 0x20, L_T2);
    body.push_back(0x88); // i64.shr_u
    i64Const(body, 1);
    body.push_back(0x83); // i64.and
    local(body, 0x21, L_B);

    // CF = L_B (clear CF, OR in selected bit). L_RFLAGS is i32.
    local(body, 0x20, L_RFLAGS);
    i32Const(body, 0xFFFFFFFE); // ~X64_CF
    body.push_back(0x71); // i32.and
    local(body, 0x20, L_B);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or
    local(body, 0x21, L_RFLAGS);

    if (sub == 0) return 0xFF; // BT: no writeback.

    // BTS/BTR/BTC: compute new value in L_R.
    // L_R = 1 << bit (mask).
    i64Const(body, 1);
    local(body, 0x20, L_T2);
    body.push_back(0x86); // i64.shl
    local(body, 0x21, L_R);
    if (sub == 1) {
        // BTS: v | mask
        local(body, 0x20, L_A);
        local(body, 0x20, L_R);
        body.push_back(0x84); // i64.or
    } else if (sub == 2) {
        // BTR: v & ~mask
        local(body, 0x20, L_R);
        i64Const(body, ~0ULL);
        body.push_back(0x85); // i64.xor -> ~mask
        local(body, 0x21, L_R);
        local(body, 0x20, L_A);
        local(body, 0x20, L_R);
        body.push_back(0x83); // i64.and
    } else {
        // BTC: v ^ mask
        local(body, 0x20, L_A);
        local(body, 0x20, L_R);
        body.push_back(0x85); // i64.xor
    }
    local(body, 0x21, L_R);

    // Write back.
    if (op.isMem) {
        emitMemWrite(body, L_T1, L_R, size);
        return 0xFF;
    }
    if (size == 2) {
        emitWriteWord(body, op.rmIndex, L_R);
        return 0xFF;
    }
    // 32/64-bit: L_R already masked; caller publishes via epilogue.
    return op.rmIndex;
}`;
}

// "grp3" template: F6/F7 group 3 (emitGrp3Gen).
// TEST r/m,imm (/0): flags like AND of (r/m & imm), no writeback.
// NOT r/m (/2): r/m = ~r/m, no flags touched.
// NEG r/m (/3): r/m = 0 - r/m, flags like SUB (CF = (r/m != 0)).
// MUL r/m (/4, unsigned): RDX:RAX = RAX * r/m (DX:AX / EDX:EAX / AX for
// smaller widths); CF/OF set iff the high half is non-zero, all other
// flags preserved. Mirrors cpu64.cpp dsp_31 exactly.
// The r/m operand is sourced into L_A (width-masked): register-direct via
// emitReadOperand (the 8-bit high-byte rule included), memory via emitEA +
// emitMemRead. Fault ordering for the storing sub-ops (NOT/NEG) is
// memRead -> compute+flags -> memWrite, matching loadRM/storeRM.
// Returns 0xFF when everything was published inline (TEST, MUL, memory
// forms, 8/16-bit writebacks); otherwise the destination GPR index for
// L_R (NOT/NEG register-direct 4/8-bit, following the ALU convention).
function genGrp3(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U64 mask = widthMask(op.size);
    const U64 sb = widthSB(op.size);
    const U64 m32 = 0xFFFFFFFFULL;
    // L_A = width-masked r/m operand.
    if (op.isMem) {
        emitEA(body, op); // L_T1 = effective address
        emitMemRead(body, L_T1, op.size); // -> L_R (zero-extended)
        local(body, 0x20, L_R);
        i64Const(body, mask);
        body.push_back(0x83); // i64.and
        local(body, 0x21, L_A);
    } else {
        emitReadOperand(body, op, op.rmIndex, L_A);
    }
    if (op.sub == 0) {
        // TEST: flags like AND of (a & imm); no writeback.
        i64Const(body, op.imm & mask);
        local(body, 0x21, L_B);
        emitAluCompute(body, 4, true, mask, sb);
        return 0xFF;
    }
    if (op.sub == 2 || op.sub == 3) {
        // NOT / NEG.
        if (op.sub == 2) {
            local(body, 0x20, L_A);
            i64Const(body, mask);
            body.push_back(0x85); // i64.xor -> (~a) & mask
            local(body, 0x21, L_R);
        } else {
            // NEG via the SUB path: L_A = 0, L_B = a. CF = (R <u 0)
            // = (a != 0); OF/AF/SZ/P per flagsSub(0, a, r).
            local(body, 0x20, L_A);
            local(body, 0x21, L_B);
            i64Const(body, 0);
            local(body, 0x21, L_A);
            emitAluCompute(body, 7, false, mask, sb);
        }
        if (op.isMem) {
            emitMemWrite(body, L_T1, L_R, op.size);
            return 0xFF;
        }
        if (op.size == 1) { emitWriteByte(body, op, op.rmIndex, L_R); return 0xFF; }
        if (op.size == 2) { emitWriteWord(body, op.rmIndex, L_R); return 0xFF; }
        return op.rmIndex;
    }
    // MUL r/m (unsigned). On entry L_A = width-masked r/m operand; move it
    // to L_B, then L_A = zero-extended RAX at width.
    local(body, 0x20, L_A);
    local(body, 0x21, L_B); // L_B = operand (L_A is clobbered below)
    if (op.size == 1) emitReadByte(body, op, 0, L_A);
    else {
        local(body, 0x20, 0 + 1); // RAX
        if (op.size == 2) {
            i64Const(body, 0xFFFFULL);
            body.push_back(0x83);
        } else if (op.size == 4) {
            i64Const(body, m32);
            body.push_back(0x83);
        }
        local(body, 0x21, L_A);
    }
    local(body, 0x20, L_A);
    local(body, 0x20, L_B);
    body.push_back(0x7E); // i64.mul
    local(body, 0x21, L_R); // L_R = low half (exact for widths < 8)
    if (op.size == 8) {
        // 128-bit product via 32-bit limbs (unsigned long multiplication):
        // hi = a_hi*b_hi + (a_lo*b_hi >> 32) + (a_hi*b_lo >> 32) +
        //      (((a_lo*b_lo >> 32) + (a_lo*b_hi & m32) +
        //        (a_hi*b_lo & m32)) >> 32).
        // Every partial sum fits in 64 bits, so wrapping is exact.
        local(body, 0x20, L_A);
        i64Const(body, m32);
        body.push_back(0x83);
        local(body, 0x21, L_T1); // a_lo
        local(body, 0x20, L_A);
        i64Const(body, 32);
        body.push_back(0x88);
        local(body, 0x21, L_T2); // a_hi
        local(body, 0x20, L_B);
        i64Const(body, m32);
        body.push_back(0x83);
        local(body, 0x21, L_P); // b_lo
        local(body, 0x20, L_B);
        i64Const(body, 32);
        body.push_back(0x88);
        local(body, 0x21, L_A); // b_hi (L_B dead)
        local(body, 0x20, L_T2);
        local(body, 0x20, L_A);
        body.push_back(0x7E); // a_hi*b_hi
        local(body, 0x20, L_T1);
        local(body, 0x20, L_A);
        body.push_back(0x7E);
        i64Const(body, 32);
        body.push_back(0x88); // (a_lo*b_hi) >> 32
        local(body, 0x20, L_T2);
        local(body, 0x20, L_P);
        body.push_back(0x7E);
        i64Const(body, 32);
        body.push_back(0x88); // (a_hi*b_lo) >> 32
        local(body, 0x20, L_T1);
        local(body, 0x20, L_P);
        body.push_back(0x7E);
        i64Const(body, 32);
        body.push_back(0x88); // (a_lo*b_lo) >> 32
        local(body, 0x20, L_T1);
        local(body, 0x20, L_A);
        body.push_back(0x7E);
        i64Const(body, m32);
        body.push_back(0x83); // (a_lo*b_hi) & m32
        local(body, 0x20, L_T2);
        local(body, 0x20, L_P);
        body.push_back(0x7E);
        i64Const(body, m32);
        body.push_back(0x83); // (a_hi*b_lo) & m32
        body.push_back(0x7C); // +
        body.push_back(0x7C); // +
        i64Const(body, 32);
        body.push_back(0x88); // carry >> 32
        body.push_back(0x7C); // +
        body.push_back(0x7C); // +
        body.push_back(0x7C); // + -> hi
        local(body, 0x21, L_P); // L_P = hi
        // overflow = (hi != 0); RDX:RAX = hi:lo.
        local(body, 0x20, L_P);
        i64Const(body, 0);
        body.push_back(0x52); // i64.ne -> i32 overflow
        local(body, 0x20, L_P);
        local(body, 0x21, 2 + 1); // RDX
        local(body, 0x20, L_R);
        local(body, 0x21, 0 + 1); // RAX
    } else {
        // 8/16/32-bit: the product is exact in 64 bits; split hi/lo.
        local(body, 0x20, L_R);
        if (op.size == 1) {
            i64Const(body, 8);
            body.push_back(0x88); // hi = prod >> 8
        } else if (op.size == 2) {
            i64Const(body, 16);
            body.push_back(0x88);
            i64Const(body, 0xFFFFULL);
            body.push_back(0x83); // hi = (prod >> 16) & 0xFFFF
        } else {
            i64Const(body, 32);
            body.push_back(0x88); // hi = prod >> 32
        }
        local(body, 0x21, L_T1); // L_T1 = hi
        local(body, 0x20, L_T1);
        i64Const(body, 0);
        body.push_back(0x52); // i64.ne -> i32 overflow
        if (op.size == 1) {
            // AX = prod (setU16, upper RAX preserved).
            emitWriteWord(body, 0, L_R);
        } else if (op.size == 2) {
            // DX:AX = hi:lo (setU16 halves).
            local(body, 0x20, L_R);
            i64Const(body, 0xFFFFULL);
            body.push_back(0x83);
            local(body, 0x21, L_T2); // lo
            emitWriteWord(body, 0, L_T2); // AX
            emitWriteWord(body, 2, L_T1); // DX
        } else {
            // EDX:EAX: full 64-bit writes of the zero-extended halves.
            local(body, 0x20, L_R);
            i64Const(body, m32);
            body.push_back(0x83);
            local(body, 0x21, 0 + 1); // RAX = lo
            local(body, 0x20, L_T1);
            local(body, 0x21, 2 + 1); // RDX = hi
        }
    }
    // L_F = overflow ? (CF|OF) : 0; merge preserving other flags.
    body.push_back(0xAD); // i64.extend_i32_u
    i64Const(body, F_CFOF_MASK);
    body.push_back(0x7E); // i64.mul
    local(body, 0x21, L_F);
    local(body, 0x20, L_RFLAGS);
    i32Const(body, F_CFOF_MASK);
    body.push_back(0x72); // i32.or
    i32Const(body, F_CFOF_MASK);
    body.push_back(0x73); // i32.xor
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or
    local(body, 0x21, L_RFLAGS);
    return 0xFF;
}`;
}

// "string" template: string
function genString(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U32 size = op.size; // 1, 2, or 4
    const U32 sub = op.sub;   // 0=MOVS, 1=STOS, 2=CMPS, 3=SCAS
    const bool isStos = (sub == 1);
    const bool isScas = (sub == 3);
    const bool isMovsStos = (sub <= 1);
    const U64 mask = size == 1 ? 0xFFULL : size == 2 ? 0xFFFFULL :
                       size == 4 ? 0xFFFFFFFFULL : 0xFFFFFFFFFFFFFFFFULL;
    const U64 sb = (U64)1 << (size * 8 - 1);
    const U32 RSI = 6 + 1, RDI = 7 + 1, RCX = 1 + 1, RAX = 0 + 1;

    // L_CNT = rep ? RCX : 1 (masked to 32 bits under 0x67).
    if (op.rep == 0) {
        i64Const(body, 1);
    } else {
        local(body, 0x20, RCX);
        if (op.asize32) {
            i64Const(body, 0xFFFFFFFFULL);
            body.push_back(0x83); // i64.and
        }
    }
    local(body, 0x21, L_CNT);

    // L_STEP = DF ? -size : +size.
    local(body, 0x20, L_RFLAGS);
    i32Const(body, 0x400); // X64_DF
    body.push_back(0x71);  // i32.and
    body.push_back(0x45);  // i32.eqz
    body.push_back(0x04);  // if
    body.push_back(0x7E);  //   result i64
    i64Const(body, size);
    body.push_back(0x05);  // else
    i64Const(body, (U64)(-(S64)size));
    body.push_back(0x0B);  // end
    local(body, 0x21, L_STEP);

    body.push_back(0x02); body.push_back(0x40); // block $done
    body.push_back(0x03); body.push_back(0x40); // loop $rep
    local(body, 0x20, L_CNT);
    body.push_back(0x50); // i64.eqz
    body.push_back(0x0D); body.push_back(0x01); // br_if 1 ($done)
    local(body, 0x20, L_CNT);
    i64Const(body, 1);
    body.push_back(0x7D); // i64.sub
    local(body, 0x21, L_CNT);

    if (isMovsStos) {
        // dst = RDI (& 0xFFFFFFFF under 0x67) -> L_A.
        local(body, 0x20, RDI);
        if (op.asize32) {
            i64Const(body, 0xFFFFFFFFULL);
            body.push_back(0x83);
        }
        local(body, 0x21, L_A);
        if (isStos) {
            local(body, 0x20, RAX);
            i64Const(body, mask);
            body.push_back(0x83);
            local(body, 0x21, L_R);
        } else {
            local(body, 0x20, RSI);
            if (op.asize32) {
                i64Const(body, 0xFFFFFFFFULL);
                body.push_back(0x83);
            }
            local(body, 0x21, L_A);
            emitMemRead(body, L_A, size); // -> L_R
            local(body, 0x20, RDI);
            if (op.asize32) {
                i64Const(body, 0xFFFFFFFFULL);
                body.push_back(0x83);
            }
            local(body, 0x21, L_A);
        }
        emitMemWrite(body, L_A, L_R, size);
        if (!isStos) {
            local(body, 0x20, RSI);
            local(body, 0x20, L_STEP);
            body.push_back(0x7C); // i64.add
            local(body, 0x21, RSI);
        }
        local(body, 0x20, RDI);
        local(body, 0x20, L_STEP);
        body.push_back(0x7C);
        local(body, 0x21, RDI);
    } else {
        // lhs -> L_A.
        if (isScas) {
            local(body, 0x20, RAX);
            i64Const(body, mask);
            body.push_back(0x83);
            local(body, 0x21, L_A);
        } else {
            local(body, 0x20, RSI);
            if (op.asize32) {
                i64Const(body, 0xFFFFFFFFULL);
                body.push_back(0x83);
            }
            local(body, 0x21, L_P); // temp addr (L_P is emitFlags scratch)
            emitMemRead(body, L_P, size); // -> L_R
            local(body, 0x20, L_R);
            local(body, 0x21, L_A);
        }
        // rhs = mem[RDI (& mask)] -> L_B.
        local(body, 0x20, RDI);
        if (op.asize32) {
            i64Const(body, 0xFFFFFFFFULL);
            body.push_back(0x83);
        }
        local(body, 0x21, L_P); // temp addr
        emitMemRead(body, L_P, size); // -> L_R
        local(body, 0x20, L_R);
        local(body, 0x21, L_B);
        // L_R = (L_A - L_B) & mask; flags through the SUB path.
        local(body, 0x20, L_A);
        local(body, 0x20, L_B);
        body.push_back(0x7D); // i64.sub
        i64Const(body, mask);
        body.push_back(0x83);
        local(body, 0x21, L_R);
        emitFlags(body, 5, sb, false);
        if (!isScas) {
            local(body, 0x20, RSI);
            local(body, 0x20, L_STEP);
            body.push_back(0x7C);
            local(body, 0x21, RSI);
        }
        local(body, 0x20, RDI);
        local(body, 0x20, L_STEP);
        body.push_back(0x7C);
        local(body, 0x21, RDI);
        // REP early exit on ZF.
        if (op.rep == 0xF3) { // REPE: break if !ZF
            local(body, 0x20, L_RFLAGS);
            i32Const(body, 0x40); // ZF
            body.push_back(0x71); // i32.and
            body.push_back(0x45); // i32.eqz
            body.push_back(0x0D); body.push_back(0x01); // br_if 1
        } else if (op.rep == 0xF2) { // REPNE: break if ZF
            local(body, 0x20, L_RFLAGS);
            i32Const(body, 0x40);
            body.push_back(0x71);
            body.push_back(0x0D); body.push_back(0x01); // br_if 1
        }
    }

    body.push_back(0x0C); body.push_back(0x00); // br 0 ($rep)
    body.push_back(0x0B); // end loop
    body.push_back(0x0B); // end block

    // REP updates RCX: MOVS/STOS leave 0, CMPS/SCAS leave the remainder.
    if (op.rep != 0) {
        if (isMovsStos) i64Const(body, 0);
        else local(body, 0x20, L_CNT);
        local(body, 0x21, RCX);
    }
    return 0xFF;
}`;
}

// "cbw" template: CBW/CWDE/CDQE (emitCbwGen).
// 0x98: sign-extend AL->AX (16-bit/CBW), AX->EAX (32-bit/CWDE),
// EAX->RAX (64-bit/CDQE). Mirrors cpu64.cpp dsp_20 exactly: no flags are
// touched, no memory is accessed, RAX is the only operand. RAX is GPR
// local 1 (X64_RAX == 0; GPR local index = reg + 1).
// Returns 0 (RAX) for 32/64-bit (epilogue publishes L_R), 0xFF for 16-bit
// (emitWriteWord does the RMW inline, preserving the upper 48 bits).
function genCbw(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    // RAX is the only operand; the value is already in GPR local 1.
    if (op.size == 2) {
        // CBW: AL -> AX, upper 48 bits of RAX preserved (setU16).
        local(body, 0x20, 1); // RAX
        i64Const(body, 0xFF);
        body.push_back(0x83); // i64.and: AL
        local(body, 0x21, L_R);
        local(body, 0x20, L_R);
        emitSext(body, 1); // sign-extend 8 -> 64 (low 16 are the result)
        local(body, 0x21, L_R);
        emitWriteWord(body, 0, L_R); // low 16 bits, upper 48 kept
        return 0xFF;
    }
    if (op.size == 4) {
        // CWDE: AX -> EAX, then zero-extended to 64 (setU64 of the
        // 32-bit sign extension).
        emitReadWord(body, 0, L_R); // L_R = AX (0..65535)
        local(body, 0x20, L_R);
        emitSext(body, 2); // sign-extend 16 -> 64
        local(body, 0x21, L_R);
        local(body, 0x20, L_R);
        i64Const(body, 0xFFFFFFFFULL);
        body.push_back(0x83); // i64.and: keep low 32 (zero-extend)
        local(body, 0x21, L_R);
        return 0; // RAX
    }
    // CDQE (size == 8): EAX -> RAX sign extension.
    local(body, 0x20, 1); // RAX
    i64Const(body, 0xFFFFFFFFULL);
    body.push_back(0x83); // i64.and: EAX
    local(body, 0x21, L_R);
    local(body, 0x20, L_R);
    emitSext(body, 4); // sign-extend 32 -> 64
    local(body, 0x21, L_R);
    return 0; // RAX
}`;
}

// "cmov" template: CMOVcc r, r/m (emitCmovGen).
function genCmov(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U32 destReg = op.regField;
    const U64 mask = widthMask(op.size);
    if (op.isMem) {
        emitEA(body, op);
        emitMemRead(body, L_T1, op.size);
        local(body, 0x20, L_R);
        local(body, 0x21, L_A);
    } else {
        local(body, 0x20, op.rmIndex + 1);
        if (op.size != 8) {
            i64Const(body, mask);
            body.push_back(0x83);
        }
        local(body, 0x21, L_A);
    }
    // Condition evaluator: leaves i32 0/1 on the stack. Inlined at each
    // select site (L_P is i64, cannot hold the i32 condition).
    auto emitCond = [&]() {
        const U8 cc = op.sub;
        auto pushFlagBit = [&](U32 bit) {
            local(body, 0x20, L_RFLAGS); // i32
            i32Const(body, bit);
            body.push_back(0x76); // i32.shr_u
            i32Const(body, 1);
            body.push_back(0x71); // i32.and -> i32 0/1
        };
        switch (cc & 0xE) {
            case 0x0: pushFlagBit(F_OF); break;
            case 0x2: pushFlagBit(F_CF); break;
            case 0x4: pushFlagBit(F_ZF); break;
            case 0x6:
                pushFlagBit(F_CF);
                pushFlagBit(F_ZF);
                body.push_back(0x72);
                break;
            case 0x8: pushFlagBit(F_SF); break;
            case 0xA: pushFlagBit(F_PF); break;
            case 0xC:
                pushFlagBit(F_SF);
                pushFlagBit(F_OF);
                body.push_back(0x73);
                break;
            case 0xE:
                pushFlagBit(F_ZF);
                pushFlagBit(F_SF);
                pushFlagBit(F_OF);
                body.push_back(0x73);
                body.push_back(0x72);
                break;
        }
        if (cc & 0x1) body.push_back(0x45); // i32.eqz
    };
    if (op.size == 8) {
        local(body, 0x20, L_A);        // new (val1)
        local(body, 0x20, destReg + 1); // old (val2)
        emitCond();                    // cond (i32)
        body.push_back(0x1B);          // select -> i64
        local(body, 0x21, L_R);
    } else if (op.size == 4) {
        local(body, 0x20, L_A);        // new (val1)
        local(body, 0x20, destReg + 1); // old
        i64Const(body, 0xFFFFFFFFULL);
        body.push_back(0x83);          // old & 0xFFFFFFFF (val2)
        emitCond();                    // cond (i32)
        body.push_back(0x1B);          // select -> i64
        local(body, 0x21, L_R);
    } else {
        local(body, 0x20, destReg + 1);
        i64Const(body, 0xFFFFFFFFFFFF0000ULL);
        body.push_back(0x83);
        local(body, 0x20, L_A);
        i64Const(body, 0xFFFFULL);
        body.push_back(0x83);
        body.push_back(0x7C);
        local(body, 0x20, destReg + 1); // old (val2)
        emitCond();                    // cond (i32)
        body.push_back(0x1B);          // select -> i64
        local(body, 0x21, L_R);
    }
    return destReg;
}`;
}


// "cqo" template: CWD/CDQ/CQO (emitCqoGen).
// 0x99: RDX = sign-extension of RAX. 16-bit (CWD): DX = (AX & 0x8000)
//   ? 0xFFFF : 0 with upper 48 of RDX preserved (setU16). 32-bit (CDQ):
//   EDX = (EAX & 0x80000000) ? 0xFFFFFFFF : 0, full 64-bit RDX write
//   (setU64). 64-bit (CQO): RDX = (RAX sign bit) ? ~0ULL : 0, full
//   64-bit write. Mirrors cpu64.cpp dsp_19 exactly: no flags touched,
//   no memory accessed, RAX is read-only. RAX is GPR local 1
//   (X64_RAX == 0), RDX is GPR local 3 (X64_RDX == 2).
// Branchless: cond = (sign bit set) ? 1 : 0 (i32 via i64.ne);
// result = select(-1, 0, cond); the -1 is width-truncated by the write.
// Returns 0xFF for 16-bit (inline RMW via emitWriteWord, upper 48 kept),
// 2 (RDX) for 32/64-bit (epilogue publishes L_R to RDX).
function genCqo(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    // Stack for select: [val1, val2, cond] -> val1 if cond else val2.
    i64Const(body, ~0ULL);           // val1 = -1 (all ones)
    i64Const(body, 0ULL);            // val2 = 0
    local(body, 0x20, 1);            // RAX
    if (op.size == 2) i64Const(body, 0x8000ULL);
    else if (op.size == 4) i64Const(body, 0x80000000ULL);
    else i64Const(body, 0x8000000000000000ULL);
    body.push_back(0x83);            // i64.and: isolate sign bit
    i64Const(body, 0ULL);
    body.push_back(0x52);            // i64.ne -> i32 cond
    body.push_back(0x1B);            // select -> i64 (-1 or 0)
    local(body, 0x21, L_R);
    if (op.size == 2) {
        emitWriteWord(body, 2, L_R); // RDX low 16, upper 48 preserved
        return 0xFF;
    }
    return 2; // RDX: full 64-bit write via epilogue
}`;
}



// "shiftCL" template: register-direct SHL/SHR/SAR with dynamic count from CL
// (emitShiftCL shape, 0xD3/0xD2). The count is read from RCX at runtime:
// L_T1 = (CL & 0xFF) & (0x3F for 64-bit else 0x1F), mirroring the
// interpreter's dsp_41 (count = reg[RCX].u8, masked after fetch).
// count==0 is a pure no-op for flags (via runtime select on the final
// rflags merge); the result naturally equals the input when count==0, so
// the 32-bit zero-extension on count==0 falls out of the normal writeback.
function genShiftCL(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U32 destReg = op.rmIndex;
    const U64 mask = widthMask(op.size);
    const U64 sb = widthSB(op.size);
    const U64 wbits = (U64)op.size * 8;
    const U8 sub = op.sub == 6 ? 4 : op.sub; // /6 aliases SHL
    const U64 countMask = (op.size == 8) ? 0x3F : 0x1F;
    // L_T1 = count. RCX is GPR 1 -> wasm local 2.
    local(body, 0x20, 2);
    i64Const(body, 0xFF);
    body.push_back(0x83); // i64.and
    i64Const(body, countMask);
    body.push_back(0x83); // i64.and
    local(body, 0x21, L_T1);
    // L_A = width-masked operand.
    emitReadOperand(body, op, destReg, L_A);
    // L_R = shift result. Stack discipline: [value, count].
    local(body, 0x20, L_A);
    if (sub == 7) emitSext(body, op.size); // SAR: arithmetic shift of sext value
    local(body, 0x20, L_T1);
    if (sub == 4) body.push_back(0x86);      // i64.shl
    else if (sub == 5) body.push_back(0x88); // i64.shr_u (L_A width-masked)
    else body.push_back(0x87);               // i64.shr_s
    i64Const(body, mask);
    body.push_back(0x83); // width-mask the result
    local(body, 0x21, L_R);
    // Flags: L_F accumulates the five shift flag bits. Computed
    // unconditionally; the final merge selects old rflags when count==0.
    i64Const(body, 0);
    local(body, 0x21, L_F);
    // CF -> L_P as i64 0/1. SHL: (L_A >> (wbits - count)) & 1;
    // SHR/SAR: (L_A >> (count - 1)) & 1. (For count==0 the value is
    // meaningless but well-defined -- wasm shifts never trap -- and is
    // discarded by the final select.)
    local(body, 0x20, L_A);
    if (sub == 4 || sub == 6) {
        i64Const(body, wbits);
        local(body, 0x20, L_T1);
        body.push_back(0x7D); // i64.sub: wbits - count
    } else {
        local(body, 0x20, L_T1);
        i64Const(body, 1);
        body.push_back(0x7D); // i64.sub: count - 1
    }
    body.push_back(0x88); // i64.shr_u
    i64Const(body, 1);
    body.push_back(0x83); // i64.and
    local(body, 0x21, L_P);
    local(body, 0x20, L_P);
    body.push_back(0xA7); // i32.wrap_i64
    orFlagBit(body, F_CF);
    // OF: only defined for count == 1; mask the bit by (count == 1),
    // matching the interpreter clearing OF for count != 1.
    {
        if (sub == 4 || sub == 6) {
            // OF = MSB(result) XOR CF (SHL; /6 aliases SHL).
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            local(body, 0x20, L_P);
            body.push_back(0xA7); // i32.wrap_i64
            body.push_back(0x73); // i32.xor
            body.push_back(0xAD); // i64.extend_i32_u
        } else if (sub == 5) {
            // OF = old MSB.
            local(body, 0x20, L_A);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            body.push_back(0xAD); // i64.extend_i32_u
        } else {
            i64Const(body, 0); // SAR: OF = 0
        }
        local(body, 0x20, L_T1);
        i64Const(body, 1);
        body.push_back(0x51); // i64.eq -> i32 (count == 1)
        body.push_back(0xAD); // i64.extend_i32_u
        body.push_back(0x83); // i64.and
        body.push_back(0xA7); // i32.wrap_i64
        orFlagBit(body, F_OF);
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
    body.push_back(0xA7); // i32.wrap_i64
    orFlagBit(body, F_PF);
    // Final merge: rflags = count==0 ? old : (old & ~F_SHIFT_MASK) | L_F.
    // select(val1=old, val2=merged, cond): returns val1 if cond != 0.
    local(body, 0x20, L_RFLAGS); // [old]
    local(body, 0x20, L_RFLAGS);
    i32Const(body, F_SHIFT_MASK);
    body.push_back(0x72); // i32.or
    i32Const(body, F_SHIFT_MASK);
    body.push_back(0x73); // i32.xor -> old & ~MASK
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or -> merged
    local(body, 0x20, L_T1);
    body.push_back(0x50); // i64.eqz -> i32 (count == 0)
    body.push_back(0x1B); // select
    local(body, 0x21, L_RFLAGS);
    if (op.size == 1) { emitWriteByte(body, op, destReg, L_R); return 0xFF; }
    if (op.size == 2) { emitWriteWord(body, destReg, L_R); return 0xFF; }
    return destReg;
}`;
}

// "shiftCL" template, mem=true: memory-operand SHL/SHR/SAR with dynamic
// count from CL (emitShiftCLMem shape). EA via emitEA; fault ordering is
// load -> compute+flags -> store, mirroring the interpreter's
// loadRM/doShift/storeRM. The load faults even when count==0 (matching the
// interpreter); the store is skipped when count==0 (32-bit zero-extend on
// count==0 is register-only).
function genShiftCLMem(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U64 mask = widthMask(op.size);
    const U64 sb = widthSB(op.size);
    const U64 wbits = (U64)op.size * 8;
    const U8 sub = op.sub == 6 ? 4 : op.sub; // /6 aliases SHL
    const U64 countMask = (op.size == 8) ? 0x3F : 0x1F;
    // L_T2 = count (L_T1 is the EA below). RCX is GPR 1 -> wasm local 2.
    local(body, 0x20, 2);
    i64Const(body, 0xFF);
    body.push_back(0x83); // i64.and
    i64Const(body, countMask);
    body.push_back(0x83); // i64.and
    local(body, 0x21, L_T2);
    emitEA(body, op); // L_T1 = effective address
    // L_A = width-masked memory operand. emitMemRead faults on unmapped
    // pages exactly like the interpreter's loadRM (even when count==0).
    emitMemRead(body, L_T1, op.size); // -> L_R (zero-extended)
    local(body, 0x20, L_R);
    i64Const(body, mask);
    body.push_back(0x83); // i64.and
    local(body, 0x21, L_A);
    // L_R = shift result (same computation as the register-direct path,
    // reading the count from L_T2).
    local(body, 0x20, L_A);
    if (sub == 7) emitSext(body, op.size);
    local(body, 0x20, L_T2);
    if (sub == 4) body.push_back(0x86);
    else if (sub == 5) body.push_back(0x88);
    else body.push_back(0x87);
    i64Const(body, mask);
    body.push_back(0x83);
    local(body, 0x21, L_R);
    // Flags (same as genShiftCL, count from L_T2).
    i64Const(body, 0);
    local(body, 0x21, L_F);
    local(body, 0x20, L_A);
    if (sub == 4 || sub == 6) {
        i64Const(body, wbits);
        local(body, 0x20, L_T2);
        body.push_back(0x7D); // wbits - count
    } else {
        local(body, 0x20, L_T2);
        i64Const(body, 1);
        body.push_back(0x7D); // count - 1
    }
    body.push_back(0x88);
    i64Const(body, 1);
    body.push_back(0x83);
    local(body, 0x21, L_P);
    local(body, 0x20, L_P);
    body.push_back(0xA7);
    orFlagBit(body, F_CF);
    {
        if (sub == 4) {
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            local(body, 0x20, L_P);
            body.push_back(0xA7);
            body.push_back(0x73);
            body.push_back(0xAD);
        } else if (sub == 5) {
            local(body, 0x20, L_A);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            body.push_back(0xAD);
        } else {
            i64Const(body, 0);
        }
        local(body, 0x20, L_T2);
        i64Const(body, 1);
        body.push_back(0x51);
        body.push_back(0xAD);
        body.push_back(0x83);
        body.push_back(0xA7);
        orFlagBit(body, F_OF);
    }
    local(body, 0x20, L_R);
    body.push_back(0x50);
    orFlagBit(body, F_ZF);
    local(body, 0x20, L_R);
    i64Const(body, sb);
    body.push_back(0x83);
    i64Const(body, 0);
    body.push_back(0x52);
    orFlagBit(body, F_SF);
    local(body, 0x20, L_R);
    i64Const(body, 0xFF);
    body.push_back(0x83);
    local(body, 0x21, L_P);
    const U32 shifts[] = {4, 2, 1};
    for (U32 s : shifts) {
        local(body, 0x20, L_P);
        local(body, 0x20, L_P);
        i64Const(body, s);
        body.push_back(0x88);
        body.push_back(0x85);
        local(body, 0x21, L_P);
    }
    local(body, 0x20, L_P);
    i64Const(body, 1);
    body.push_back(0x83);
    i64Const(body, 1);
    body.push_back(0x85);
    body.push_back(0xA7);
    orFlagBit(body, F_PF);
    // Final merge with count==0 select (same as genShiftCL).
    local(body, 0x20, L_RFLAGS);
    local(body, 0x20, L_RFLAGS);
    i32Const(body, F_SHIFT_MASK);
    body.push_back(0x72);
    i32Const(body, F_SHIFT_MASK);
    body.push_back(0x73);
    local(body, 0x20, L_F);
    body.push_back(0xA7);
    body.push_back(0x72);
    local(body, 0x20, L_T2);
    body.push_back(0x50);
    body.push_back(0x1B);
    local(body, 0x21, L_RFLAGS);
    // Store back to memory only when count != 0 (interpreter never stores
    // on count==0 for memory operands). No register writeback.
    local(body, 0x20, L_T2);
    i64Const(body, 0);
    body.push_back(0x52); // i64.ne -> i32 (count != 0)
    body.push_back(0x04); body.push_back(0x40); // if
    emitMemWrite(body, L_T1, L_R, op.size);
    body.push_back(0x0B); // end
    return 0xFF;
}`;
}

// "rotateCL" template: register-direct ROL/ROR/RCL/RCR with dynamic count
// from CL (emitRotateCL shape, 0xD3/0xD2). ROL/ROR use the closed-form
// single rotate with c = count % wbits (when c==0 the result equals the
// input, so the interpreter's c==0 CF special-case falls out naturally).
// RCL/RCR reuse the proven block/loop structure with a dynamic trip count
// c = count % (wbits+1) in L_B. OF is preserved (not cleared) for
// count != 1, matching the existing rotate template and refRotate;
// the interpreter clears it, but OF is architecturally undefined for
// count != 1.
function genRotateCL(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U32 destReg = op.rmIndex;
    const U64 mask = widthMask(op.size);
    const U64 sb = widthSB(op.size);
    const U64 wbits = (U64)op.size * 8;
    const U8 sub = op.sub; // 0=ROL, 1=ROR, 2=RCL, 3=RCR
    const U64 countMask = (op.size == 8) ? 0x3F : 0x1F;
    // L_T1 = count. RCX is GPR 1 -> wasm local 2.
    local(body, 0x20, 2);
    i64Const(body, 0xFF);
    body.push_back(0x83);
    i64Const(body, countMask);
    body.push_back(0x83);
    local(body, 0x21, L_T1);
    // L_A = width-masked operand.
    emitReadOperand(body, op, destReg, L_A);
    if (sub == 0 || sub == 1) {
        // ROL/ROR: c = count % wbits in L_B.
        local(body, 0x20, L_T1);
        i64Const(body, wbits);
        body.push_back(0x82); // i64.rem_u
        local(body, 0x21, L_B);
        local(body, 0x20, L_A);
        local(body, 0x20, L_B);
        if (sub == 0) { // ROL: (v << c) | (v >> (wbits - c))
            body.push_back(0x86); // i64.shl
            local(body, 0x20, L_A);
            i64Const(body, wbits);
            local(body, 0x20, L_B);
            body.push_back(0x7D); // i64.sub
            body.push_back(0x88); // i64.shr_u
        } else { // ROR: (v >> c) | (v << (wbits - c))
            body.push_back(0x88); // i64.shr_u
            local(body, 0x20, L_A);
            i64Const(body, wbits);
            local(body, 0x20, L_B);
            body.push_back(0x7D);
            body.push_back(0x86); // i64.shl
        }
        body.push_back(0x84); // i64.or
        i64Const(body, mask);
        body.push_back(0x83);
        local(body, 0x21, L_R);
        // CF -> L_P as i64 0/1. ROL: result & 1; ROR: (result & sb) != 0.
        // When c==0, L_R == L_A, so these match the interpreter's c==0
        // special cases ((v & 1) / (v & sb)) without a branch.
        local(body, 0x20, L_R);
        if (sub == 0) {
            i64Const(body, 1);
            body.push_back(0x83);
        } else {
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            body.push_back(0xAD);
        }
        local(body, 0x21, L_P);
    } else {
        // RCL/RCR: rotate through carry. c = count % (wbits+1) in L_B;
        // loop threads the carry in L_P (incoming CF first), L_R holds
        // the running result. Same structure as genRotate, dynamic trip count.
        local(body, 0x20, L_RFLAGS);
        i32Const(body, 1);
        body.push_back(0x71); // i32.and -> incoming CF as 0/1
        body.push_back(0xAD); // i64.extend_i32_u
        local(body, 0x21, L_P);
        local(body, 0x20, L_A);
        local(body, 0x21, L_R);
        local(body, 0x20, L_T1);
        i64Const(body, wbits + 1);
        body.push_back(0x82); // i64.rem_u
        local(body, 0x21, L_B);
        body.push_back(0x02); body.push_back(0x40); // block $done
        body.push_back(0x03); body.push_back(0x40); // loop $l
        local(body, 0x20, L_B);
        body.push_back(0x50); // i64.eqz
        body.push_back(0x0D); body.push_back(0x01); // br_if 1 ($done)
        if (sub == 2) { // RCL
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            body.push_back(0xAD);
            local(body, 0x21, L_A); // L_A = newCf (temp)
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x86);
            local(body, 0x20, L_P);
            body.push_back(0x84);
            i64Const(body, mask);
            body.push_back(0x83);
            local(body, 0x21, L_R);
            local(body, 0x20, L_A);
            local(body, 0x21, L_P);
        } else { // RCR
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x83);
            local(body, 0x21, L_A);
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x88);
            local(body, 0x20, L_P);
            i64Const(body, sb);
            body.push_back(0x7E); // i64.mul: 0 or sb
            body.push_back(0x84);
            i64Const(body, mask);
            body.push_back(0x83);
            local(body, 0x21, L_R);
            local(body, 0x20, L_A);
            local(body, 0x21, L_P);
        }
        local(body, 0x20, L_B);
        i64Const(body, 1);
        body.push_back(0x7D); // i64.sub
        local(body, 0x21, L_B);
        body.push_back(0x0C); body.push_back(0x00); // br 0 ($l)
        body.push_back(0x0B); // end loop
        body.push_back(0x0B); // end block
    }
    // Flags: L_F accumulates CF and OF only.
    i64Const(body, 0);
    local(body, 0x21, L_F);
    local(body, 0x20, L_P);
    body.push_back(0xA7); // i32.wrap_i64
    orFlagBit(body, F_CF);
    // OF: only defined for count == 1; mask the bit by (count == 1).
    // ROL/RCL: OF = MSB(result) XOR CF.
    // ROR/RCR: OF = MSB(result) XOR ((result << 1) & sb != 0).
    {
        if (sub == 0 || sub == 2) {
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52); // i64.ne -> i32
            local(body, 0x20, L_P);
            body.push_back(0xA7); // i32.wrap_i64
            body.push_back(0x73); // i32.xor
            body.push_back(0xAD); // i64.extend_i32_u
        } else {
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x86);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            body.push_back(0x73);
            body.push_back(0xAD);
        }
        local(body, 0x20, L_T1);
        i64Const(body, 1);
        body.push_back(0x51); // i64.eq -> i32 (count == 1)
        body.push_back(0xAD);
        body.push_back(0x83);
        body.push_back(0xA7);
        orFlagBit(body, F_OF);
    }
    // Dynamic flag mask: CF always, OF only when count == 1.
    // maskBits = (1 << F_CF) | ((count==1) << F_OF), stashed in L_T2 (i64).
    i64Const(body, 1u << F_CF);
    local(body, 0x20, L_T1);
    i64Const(body, 1);
    body.push_back(0x51); // i64.eq -> i32 (count == 1)
    body.push_back(0xAD); // i64.extend_i32_u
    i64Const(body, (U64)F_OF);
    body.push_back(0x86); // i64.shl
    body.push_back(0x84); // i64.or
    local(body, 0x21, L_T2);
    // Final merge: rflags = count==0 ? old : (old & ~maskBits) | L_F.
    // RFLAGS ops are i32; wrap the i64 mask and flag bits.
    local(body, 0x20, L_RFLAGS); // [old] i32
    local(body, 0x20, L_RFLAGS); // [old, old]
    local(body, 0x20, L_T2);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or -> [old, old|mask]
    local(body, 0x20, L_T2);
    body.push_back(0xA7);
    body.push_back(0x73); // i32.xor -> [old, old & ~maskBits]
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or -> [old, merged]
    local(body, 0x20, L_T1);
    body.push_back(0x50); // i64.eqz -> count == 0
    body.push_back(0x1B); // select
    local(body, 0x21, L_RFLAGS);
    if (op.size == 1) { emitWriteByte(body, op, destReg, L_R); return 0xFF; }
    if (op.size == 2) { emitWriteWord(body, destReg, L_R); return 0xFF; }
    return destReg;
}`;
}

// "rotateCL" template, mem=true: memory-operand ROL/ROR/RCL/RCR with dynamic
// count from CL (emitRotateCLMem shape). EA via emitEA; fault ordering is
// load -> compute+flags -> store. The store is skipped when count==0.
function genRotateCLMem(e) {
  return `U32 ${e.func}(Bytes& body, const Jit64Op& op) {
    const U64 mask = widthMask(op.size);
    const U64 sb = widthSB(op.size);
    const U64 wbits = (U64)op.size * 8;
    const U8 sub = op.sub;
    const U64 countMask = (op.size == 8) ? 0x3F : 0x1F;
    // L_T2 = count (L_T1 is the EA below).
    local(body, 0x20, 2);
    i64Const(body, 0xFF);
    body.push_back(0x83);
    i64Const(body, countMask);
    body.push_back(0x83);
    local(body, 0x21, L_T2);
    emitEA(body, op); // L_T1 = effective address
    emitMemRead(body, L_T1, op.size); // -> L_R (zero-extended)
    local(body, 0x20, L_R);
    i64Const(body, mask);
    body.push_back(0x83);
    local(body, 0x21, L_A);
    if (sub == 0 || sub == 1) {
        local(body, 0x20, L_T2);
        i64Const(body, wbits);
        body.push_back(0x82); // i64.rem_u
        local(body, 0x21, L_B);
        local(body, 0x20, L_A);
        local(body, 0x20, L_B);
        if (sub == 0) {
            body.push_back(0x86);
            local(body, 0x20, L_A);
            i64Const(body, wbits);
            local(body, 0x20, L_B);
            body.push_back(0x7D);
            body.push_back(0x88);
        } else {
            body.push_back(0x88);
            local(body, 0x20, L_A);
            i64Const(body, wbits);
            local(body, 0x20, L_B);
            body.push_back(0x7D);
            body.push_back(0x86);
        }
        body.push_back(0x84);
        i64Const(body, mask);
        body.push_back(0x83);
        local(body, 0x21, L_R);
        local(body, 0x20, L_R);
        if (sub == 0) {
            i64Const(body, 1);
            body.push_back(0x83);
        } else {
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            body.push_back(0xAD);
        }
        local(body, 0x21, L_P);
    } else {
        local(body, 0x20, L_RFLAGS);
        i32Const(body, 1);
        body.push_back(0x71);
        body.push_back(0xAD);
        local(body, 0x21, L_P);
        local(body, 0x20, L_A);
        local(body, 0x21, L_R);
        local(body, 0x20, L_T2);
        i64Const(body, wbits + 1);
        body.push_back(0x82); // i64.rem_u
        local(body, 0x21, L_B);
        body.push_back(0x02); body.push_back(0x40);
        body.push_back(0x03); body.push_back(0x40);
        local(body, 0x20, L_B);
        body.push_back(0x50);
        body.push_back(0x0D); body.push_back(0x01);
        if (sub == 2) {
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            body.push_back(0xAD);
            local(body, 0x21, L_A);
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x86);
            local(body, 0x20, L_P);
            body.push_back(0x84);
            i64Const(body, mask);
            body.push_back(0x83);
            local(body, 0x21, L_R);
            local(body, 0x20, L_A);
            local(body, 0x21, L_P);
        } else {
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x83);
            local(body, 0x21, L_A);
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x88);
            local(body, 0x20, L_P);
            i64Const(body, sb);
            body.push_back(0x7E);
            body.push_back(0x84);
            i64Const(body, mask);
            body.push_back(0x83);
            local(body, 0x21, L_R);
            local(body, 0x20, L_A);
            local(body, 0x21, L_P);
        }
        local(body, 0x20, L_B);
        i64Const(body, 1);
        body.push_back(0x7D);
        local(body, 0x21, L_B);
        body.push_back(0x0C); body.push_back(0x00);
        body.push_back(0x0B);
        body.push_back(0x0B);
    }
    i64Const(body, 0);
    local(body, 0x21, L_F);
    local(body, 0x20, L_P);
    body.push_back(0xA7);
    orFlagBit(body, F_CF);
    {
        if (sub == 0 || sub == 2) {
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            local(body, 0x20, L_P);
            body.push_back(0xA7);
            body.push_back(0x73);
            body.push_back(0xAD);
        } else {
            local(body, 0x20, L_R);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            local(body, 0x20, L_R);
            i64Const(body, 1);
            body.push_back(0x86);
            i64Const(body, sb);
            body.push_back(0x83);
            i64Const(body, 0);
            body.push_back(0x52);
            body.push_back(0x73);
            body.push_back(0xAD);
        }
        local(body, 0x20, L_T2);
        i64Const(body, 1);
        body.push_back(0x51);
        body.push_back(0xAD);
        body.push_back(0x83);
        body.push_back(0xA7);
        orFlagBit(body, F_OF);
    }
    // maskBits -> L_P as i64 (L_P is free: carry already folded into L_F).
    // L_T2 keeps the count for the count==0 tests below.
    i64Const(body, 1u << F_CF);
    local(body, 0x20, L_T2);
    i64Const(body, 1);
    body.push_back(0x51); // i64.eq -> i32 (count == 1)
    body.push_back(0xAD); // i64.extend_i32_u
    i64Const(body, (U64)F_OF);
    body.push_back(0x86); // i64.shl
    body.push_back(0x84); // i64.or
    local(body, 0x21, L_P);
    local(body, 0x20, L_RFLAGS); // i32 old
    local(body, 0x20, L_RFLAGS);
    local(body, 0x20, L_P);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or -> [old, old|mask]
    local(body, 0x20, L_P);
    body.push_back(0xA7);
    body.push_back(0x73); // i32.xor -> [old, old & ~maskBits]
    local(body, 0x20, L_F);
    body.push_back(0xA7); // i32.wrap_i64
    body.push_back(0x72); // i32.or -> [old, merged]
    local(body, 0x20, L_T2);
    body.push_back(0x50); // i64.eqz -> count == 0
    body.push_back(0x1B); // select
    local(body, 0x21, L_RFLAGS);
    // Store back to memory only when count != 0.
    local(body, 0x20, L_T2);
    i64Const(body, 0);
    body.push_back(0x52); // i64.ne -> count != 0
    body.push_back(0x04); body.push_back(0x40); // if
    emitMemWrite(body, L_T1, L_R, op.size);
    body.push_back(0x0B); // end
    return 0xFF;
}`;
}
const TEMPLATES = { alu: (e) => (e.mem ? genAluMem(e) : genAlu(e)), shift: (e) => (e.mem ? genShiftMem(e) : genShift(e)), rotate: (e) => (e.mem ? genRotateMem(e) : genRotate(e)), shiftCL: (e) => (e.mem ? genShiftCLMem(e) : genShiftCL(e)), rotateCL: (e) => (e.mem ? genRotateCLMem(e) : genRotateCL(e)), imul2: genImul2, imul1: genImul1, imul3: genImul3, movx: genMovx, string: genString, lea: genLea, stack: genStack, mov8: genMov8, movimm8: genMovImm8, grp3: genGrp3, cbw: genCbw, cmov: genCmov, cqo: genCqo, setcc: genSetcc, bt: genBt };

function generate() {
  const out = [];
  out.push(
    `// GENERATED by scripts/gen-jit64.mjs from source/emulation/cpu/jit64table.mjs`
  );
  out.push(`// DO NOT EDIT — regenerate with: node scripts/gen-jit64.mjs`);
  out.push(`//`);
  out.push(
    `// Table-driven JIT emitters. Included into jit64wasm.cpp's anonymous`
  );
  out.push(
    `// namespace so the generated functions can use the emission primitives.`
  );
  out.push(``);
  for (const e of EMITTERS) {
    const gen = TEMPLATES[e.template];
    if (!gen) throw new Error(`unknown template: ${e.template}`);
    out.push(gen(e));
    out.push(``);
  }
  return out.join("\n");
}

const check = process.argv.includes("--check");
const text = generate();
if (check) {
  const cur = readFileSync(OUT_PATH, "utf8");
  if (cur !== text) {
    console.error(
      `jit64gen.inc is out of sync with jit64table.mjs; run: node scripts/gen-jit64.mjs`
    );
    process.exit(1);
  }
  console.log("jit64gen.inc in sync.");
} else {
  writeFileSync(OUT_PATH, text);
  console.log(`wrote ${OUT_PATH} (${EMITTERS.length} emitter(s))`);
}
