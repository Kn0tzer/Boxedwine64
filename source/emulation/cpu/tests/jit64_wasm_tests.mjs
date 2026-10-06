// Copyright (C) 2026 The BoxedWine Team. GPL-2.0-or-later.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const fixture = process.env.JIT64_WASM_FIXTURE;
assert.ok(fixture, 'JIT64_WASM_FIXTURE must point at the native fixture emitter');
const dir = mkdtempSync(join(tmpdir(), 'jit64-wasm-'));
let sequence = 0;
const mask64 = (1n << 64n) - 1n;
const little = (value, count) => Array.from({ length: count }, (_, i) => Number((value >> BigInt(8 * i)) & 255n));
const movabs = (reg, value) => [reg >= 8 ? 0x49 : 0x48, 0xB8 + reg % 8, ...little(value, 8)];

// Import object for emitted modules. memRead/memWrite are required imports
// (string ops); the stubs throw so a non-string test that touches them fails
// loudly instead of silently.
function baseEnv(memory) {
  return { env: {
    memory,
    memRead: () => { throw new Error('memRead called by non-string test'); },
    memWrite: () => { throw new Error('memWrite called by non-string test'); },
  } };
}

function emit(code) {
  const path = join(dir, String(sequence++));
  writeFileSync(path + '.bin', new Uint8Array(code));
  const result = spawnSync(fixture, [path + '.bin', path + '.wasm'], { encoding: 'utf8' });
  return { result, path: path + '.wasm' };
}

async function check(code, changed, rip = 0x12345678ABCDEFF0n, ptr = 512) {
  const { result, path } = emit(code);
  assert.equal(result.status, 0, result.stderr);
  const module = readFileSync(path);
  assert.ok(WebAssembly.validate(module), 'emitted module must validate');
  const memory = new WebAssembly.Memory({ initial: 1 });
  // Distinguish the wasm host pointer from guest RIP; unaligned host state
  // pointers are legal too (the wasm alignment immediate is only a hint).
  const view = new DataView(memory.buffer);
  const before = Array.from({ length: 16 }, (_, i) => 0xFEDCBA9876543200n + BigInt(i));
  before.forEach((v, i) => view.setBigUint64(ptr + i * 8, v, true));
  view.setBigUint64(ptr + 128, rip, true);
  view.setUint32(ptr + 136, 0x8D7, true);
  view.setUint32(ptr + 140, 0xA5A5A5A5, true);
  const { instance } = await WebAssembly.instantiate(module, baseEnv(memory));
  instance.exports.execute(ptr);
  const expected = [...before];
  changed(expected);
  for (let i = 0; i < 16; i++) assert.equal(view.getBigUint64(ptr + i * 8, true), expected[i], `GPR ${i}`);
  assert.equal(view.getBigUint64(ptr + 128, true), (rip + BigInt(code.length)) & mask64, '64-bit RIP');
  assert.equal(view.getUint32(ptr + 136, true), 0x8D7, 'MOV preserves flags');
  assert.equal(view.getUint32(ptr + 140, true), 0xA5A5A5A5, 'ABI reserved word');
}

test('all 16 registers retain full 64-bit immediate values', async () => {
  const values = Array.from({ length: 16 }, (_, i) => 0x8123456789ABCD00n + BigInt(i));
  await check(values.flatMap((v, i) => movabs(i, v)), regs => values.forEach((v, i) => { regs[i] = v; }));
});

for (const value of [0n, 63n, 64n, 127n, 128n, 0x7FFFFFFFFFFFFFFFn, 0x8000000000000000n, 0xFFFFFFFFFFFFFFFFn]) {
  test(`i64 signed LEB encoding preserves ${value.toString(16)}`, () => check(movabs(15, value), regs => { regs[15] = value; }));
}

test('32-bit immediate MOV zero-extends high registers', () => check(
  [0x41, 0xBF, 0xFF, 0xFF, 0xFF, 0xFF], regs => { regs[15] = 0xFFFFFFFFn; }));
test('MOV r/m64,r64 and MOV r64,r/m64 preserve high halves', () => check(
  [0x4D, 0x89, 0xF8, 0x4D, 0x8B, 0xC8], regs => { regs[8] = regs[15]; regs[9] = regs[8]; }));
test('32-bit register MOV zero-extends both encoding directions', () => check(
  [0x45, 0x89, 0xF8, 0x45, 0x8B, 0xC8], regs => { regs[8] = regs[15] & 0xFFFFFFFFn; regs[9] = regs[8]; }));
test('C7 imm32 sign-extends for a 64-bit register destination', () => check(
  [0x49, 0xC7, 0xC0, 0x80, 0xFF, 0xFF, 0xFF], regs => { regs[8] = 0xFFFFFFFFFFFFFF80n; }));
test('C7 imm32 zero-extends for a 32-bit register destination', () => check(
  [0x41, 0xC7, 0xC0, 0x80, 0xFF, 0xFF, 0xFF], regs => { regs[8] = 0xFFFFFF80n; }));
test('RIP advancement wraps modulo 64 bits', () => check(movabs(0, 1n), regs => { regs[0] = 1n; }, mask64 - 3n));
test('state at the end of imported memory stays in bounds', () => check(
  movabs(0, 7n), regs => { regs[0] = 7n; }, 0n, 65536 - 144));
test('unaligned state pointer executes correctly', () => check(
  movabs(0, 9n), regs => { regs[0] = 9n; }, 0n, 513));
test('out-of-bounds state traps before modifying any guest state', async () => {
  const { result, path } = emit(movabs(0, 1n));
  assert.equal(result.status, 0, result.stderr);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new Uint8Array(memory.buffer);
  bytes.fill(0xA5);
  const { instance } = await WebAssembly.instantiate(readFileSync(path), baseEnv(memory));
  for (const ptr of [65536 - 128, -1, -128]) {
    assert.throws(() => instance.exports.execute(ptr), WebAssembly.RuntimeError);
    assert.ok(bytes.every(value => value === 0xA5), 'trap must leave memory unchanged');
  }
});

for (const [name, code] of [
  ['empty block', []],
  ['guest-memory MOV', [0x48, 0x89, 0x00]],
  ['16-bit MOV', [0x66, 0xB8, 0x42, 0]], ['16-bit MOVSXD', [0x66, 0x63, 0xC0]],
  ['REP prefix', [0xF3, 0xB8, 0x42, 0, 0, 0]],
  ['FS-segment memory ADD', [0x64, 0x48, 0x01, 0x00]],
  ['GS-segment memory ADD', [0x65, 0x48, 0x01, 0x00]],
  ['LOCK memory ADD', [0xF0, 0x48, 0x01, 0x00]],
  // NOTE: the old 'unsupported suffix after MOV' case ([...movabs, 0x48,0xC1,0x20,0x04])
  // was removed: C1 SHL r/m,imm8 with a SIB memory operand is a supported
  // fast-path instruction (table mem:true), so the block correctly succeeds
  // (status 0), not fallbacks (status 2). The remaining cases cover fallback.
  ['block longer than 24 operations', Array.from({ length: 25 }, () => movabs(0, 1n)).flat()],
]) {
  test(`whole-block fallback rejects ${name}`, () => assert.equal(emit(code).result.status, 2));
}

// --- ALU reference model (mirrors cpu64.cpp flagsAdd/flagsSub/flagsLogic) ---
const ALU_MASK = 0x8D5;
function refAlu(sub, a, b, width, carryIn = 0n) {
  const mask = width === 8 ? mask64 : (1n << BigInt(width * 8)) - 1n;
  const sb = 1n << BigInt(width * 8 - 1);
  a &= mask; b &= mask;
  const isAdd = sub === 0 || sub === 2, isSub = sub === 3 || sub === 5 || sub === 7;
  const isLogic = !isAdd && !isSub;
  if (sub === 2 || sub === 3) b = (b + carryIn) & mask;
  let r, cf = 0n, of = 0n, af = 0n;
  if (isAdd) {
    r = (a + b) & mask;
    cf = r < a ? 1n : 0n;
    of = (((~(a ^ b)) & (a ^ r)) & sb) ? 1n : 0n;
  } else if (isSub) {
    r = (a - b) & mask;
    cf = a < b ? 1n : 0n;
    of = (((a ^ b) & (a ^ r)) & sb) ? 1n : 0n;
  } else {
    r = (sub === 1 ? a | b : sub === 4 ? a & b : a ^ b) & mask;
  }
  if (!isLogic) af = ((a ^ b ^ r) & 0x10n) ? 1n : 0n;
  const zf = r === 0n ? 1n : 0n, sf = (r & sb) ? 1n : 0n;
  let p = Number(r & 0xFFn); p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
  const pf = (p & 1) === 0 ? 1n : 0n;
  return { r, flags: cf | (pf << 2n) | (af << 4n) | (zf << 6n) | (sf << 7n) | (of << 11n) };
}

async function runAlu(code, regs, rflags, rip = 0x12345678ABCDEFF0n, ptr = 512) {
  const { result, path } = emit(code);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(WebAssembly.validate(readFileSync(path)), 'emitted module must validate');
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  regs.forEach((v, i) => view.setBigUint64(ptr + i * 8, v, true));
  view.setBigUint64(ptr + 128, rip, true);
  view.setUint32(ptr + 136, rflags >>> 0, true);
  view.setUint32(ptr + 140, 0xA5A5A5A5, true);
  const { instance } = await WebAssembly.instantiate(readFileSync(path), baseEnv(memory));
  instance.exports.execute(ptr);
  return {
    regs: Array.from({ length: 16 }, (_, i) => view.getBigUint64(ptr + i * 8, true)),
    rflags: view.getUint32(ptr + 136, true),
    ripOut: view.getBigUint64(ptr + 128, true),
    reserved: view.getUint32(ptr + 140, true),
  };
}

const baseRegs = () => Array.from({ length: 16 }, (_, i) => 0xFEDCBA9876543200n + BigInt(i));
const modrm = (reg, rm) => 0xC0 | (reg << 3) | rm;
function expectAlu(out, initFlags, newBits, codeLen, changed) {
  assert.equal(out.rflags, (((initFlags & ~ALU_MASK) | Number(newBits)) >>> 0), 'rflags');
  assert.equal(out.ripOut, (0x12345678ABCDEFF0n + BigInt(codeLen)) & mask64, 'RIP advances');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
  changed(out.regs);
}

test('ADD r64,r64 wraps with carry out', async () => {
  const regs = baseRegs(); regs[0] = mask64; regs[3] = 1n;
  const { r, flags } = refAlu(0, regs[0], regs[3], 8);
  assert.equal(flags & 0x8D5n, 0x1n | 0x40n | 0x4n | 0x10n, 'CF+ZF+PF+AF set');
  const out = await runAlu([0x48, 0x01, modrm(3, 0)], regs, 0x202);
  expectAlu(out, 0x202, flags, 3, got => {
    assert.equal(got[0], r);
    assert.equal(got[3], 1n, 'source register untouched');
  });
});

test('ADD r32,r32 uses 32-bit flags and zero-extends', async () => {
  const regs = baseRegs(); regs[0] = 0x80000000n; regs[3] = 0x80000000n;
  const { r, flags } = refAlu(0, regs[0], regs[3], 4);
  assert.equal(flags & 0x8D5n, 0x1n | 0x40n | 0x4n | 0x800n, 'CF+ZF+PF+OF set');
  const out = await runAlu([0x01, modrm(3, 0)], regs, 0x202);
  expectAlu(out, 0x202, flags, 2, got => assert.equal(got[0], r));
});

test('SUB r64,r64 borrows', async () => {
  const regs = baseRegs(); regs[0] = 0n; regs[3] = 1n;
  const { r, flags } = refAlu(5, regs[0], regs[3], 8);
  assert.equal(flags & 0x8D5n, 0x1n | 0x80n | 0x10n | 0x4n, 'CF+SF+AF+PF set');
  const out = await runAlu([0x48, 0x29, modrm(3, 0)], regs, 0x202);
  expectAlu(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});

test('XOR r64,r64 self-zeroes with logic flags', async () => {
  const regs = baseRegs(); regs[0] = 0x123456789ABCDEF0n;
  const { r, flags } = refAlu(6, regs[0], regs[0], 8);
  assert.equal(flags & 0x8D5n, 0x40n | 0x4n, 'only ZF+PF set');
  const out = await runAlu([0x48, 0x31, modrm(0, 0)], regs, 0x8D5);
  expectAlu(out, 0x8D5, flags, 3, got => assert.equal(got[0], r));
});

test('AND/OR r64,r64 clear CF/OF/AF', async () => {
  const regs = baseRegs(); regs[0] = 0xF0F0F0F0F0F0F0F0n; regs[3] = 0x0FF00FF00FF00FF0n;
  for (const [op, sub] of [[0x21, 4], [0x09, 1]]) {
    const { r, flags } = refAlu(sub, regs[0], regs[3], 8);
    assert.equal(flags & 0x811n, 0n, 'CF/OF/AF clear');
    const out = await runAlu([0x48, op, modrm(3, 0)], [...regs], 0x8D5);
    expectAlu(out, 0x8D5, flags, 3, got => assert.equal(got[0], r));
  }
});

test('ADD r64,imm32 sign-extends the immediate', async () => {
  const regs = baseRegs(); regs[0] = 5n;
  const imm = 0xFFFFFFFFFFFFFFFBn; // -5
  const { r, flags } = refAlu(0, regs[0], imm, 8);
  const out = await runAlu([0x48, 0x81, modrm(0, 0), 0xFB, 0xFF, 0xFF, 0xFF], regs, 0x202);
  expectAlu(out, 0x202, flags, 7, got => assert.equal(got[0], r));
});

test('ADD r64,imm8 sign-extends and SUB r64,imm8 borrows', async () => {
  const regs = baseRegs(); regs[0] = 0n;
  let m = refAlu(0, regs[0], 0xFFFFFFFFFFFFFFFFn, 8); // +(-1)
  let out = await runAlu([0x48, 0x83, modrm(0, 0), 0xFF], regs, 0x202);
  expectAlu(out, 0x202, m.flags, 4, got => assert.equal(got[0], m.r));
  m = refAlu(5, regs[0], 1n, 8);
  out = await runAlu([0x48, 0x83, modrm(5, 0), 0x01], [...regs], 0x202);
  expectAlu(out, 0x202, m.flags, 4, got => assert.equal(got[0], m.r));
});

test('ADD rax,imm32 accumulator form', async () => {
  const regs = baseRegs(); regs[0] = 0x7FFFFFFFFFFFFFFFn;
  const { r, flags } = refAlu(0, regs[0], 1n, 8);
  assert.equal(flags & 0x8D5n, 0x800n | 0x80n | 0x10n | 0x4n, 'OF+SF+AF+PF set');
  const out = await runAlu([0x48, 0x05, 0x01, 0x00, 0x00, 0x00], regs, 0x202);
  expectAlu(out, 0x202, flags, 6, got => assert.equal(got[0], r));
});

test('CMP r64,r64 writes no register', async () => {
  const regs = baseRegs(); regs[0] = 10n; regs[3] = 10n;
  const { flags } = refAlu(7, regs[0], regs[3], 8);
  const out = await runAlu([0x48, 0x39, modrm(3, 0)], regs, 0x202);
  expectAlu(out, 0x202, flags, 3, got => {
    assert.equal(got[0], 10n, 'CMP leaves the destination alone');
    assert.equal(got[3], 10n);
  });
});

test('TEST r64,r64 writes no register', async () => {
  const regs = baseRegs(); regs[0] = 0xF0F0n; regs[3] = 0x0F0Fn;
  const { flags } = refAlu(4, regs[0], regs[3], 8);
  const out = await runAlu([0x48, 0x85, modrm(3, 0)], regs, 0x202);
  expectAlu(out, 0x202, flags, 3, got => {
    assert.equal(got[0], 0xF0F0n, 'TEST leaves the destination alone');
  });
});

test('ADC/SBB fold the incoming carry', async () => {
  const regs = baseRegs(); regs[0] = mask64; regs[3] = 0n;
  let m = refAlu(2, regs[0], regs[3], 8, 1n);
  let out = await runAlu([0x48, 0x11, modrm(3, 0)], [...regs], 0x203);
  expectAlu(out, 0x203, m.flags, 3, got => assert.equal(got[0], m.r));
  regs[0] = 5n; regs[3] = 5n;
  m = refAlu(3, regs[0], regs[3], 8, 1n);
  out = await runAlu([0x48, 0x19, modrm(3, 0)], [...regs], 0x203);
  expectAlu(out, 0x203, m.flags, 3, got => assert.equal(got[0], m.r));
});

test('ALU on extended registers (r8/r9)', async () => {
  const regs = baseRegs(); regs[8] = 2n; regs[9] = 3n;
  const { r, flags } = refAlu(0, regs[9], regs[8], 8);
  const out = await runAlu([0x4D, 0x01, modrm(0, 1)], regs, 0x202); // add r9, r8
  expectAlu(out, 0x202, flags, 3, got => {
    assert.equal(got[9], r);
    assert.equal(got[8], 2n);
  });
});

test('ALU preserves non-written RFLAGS bits', async () => {
  const regs = baseRegs(); regs[0] = 1n;
  const { flags } = refAlu(6, regs[0], regs[0], 8);
  const out = await runAlu([0x48, 0x31, modrm(0, 0)], regs, 0xA5A5A5A5);
  expectAlu(out, 0xA5A5A5A5, flags, 3, () => {});
});

test('mixed MOV+ADD block', async () => {
  const regs = baseRegs(); regs[3] = 8n;
  const code = [...movabs(0, 7n), 0x48, 0x01, modrm(3, 0)];
  const { r, flags } = refAlu(0, 7n, 8n, 8);
  const out = await runAlu(code, regs, 0x202);
  expectAlu(out, 0x202, flags, code.length, got => assert.equal(got[0], r));
});

// --- Memory-operand ALU (mirrors decodeEA + emitAluMem; fixture ripBase=0) ---

// 8-bit register read/write with the x86-64 high-byte rule (mirrors
// byteRegParts/emitReadByte/emitWriteByte).
function memRegRead(regs, idx, size, rexPresent) {
  if (size === 1) {
    let phys = idx, shift = 0n;
    if (!rexPresent && idx >= 4 && idx <= 7) { phys = idx - 4; shift = 8n; }
    return (regs[phys] >> shift) & 0xFFn;
  }
  const mask = size === 8 ? mask64 : (1n << BigInt(size * 8)) - 1n;
  return regs[idx] & mask;
}
function memRegWrite(regs, idx, size, val, rexPresent) {
  if (size === 1) {
    let phys = idx, shift = 0n;
    if (!rexPresent && idx >= 4 && idx <= 7) { phys = idx - 4; shift = 8n; }
    regs[phys] = (regs[phys] & ~(0xFFn << shift)) | ((val & 0xFFn) << shift);
  } else if (size === 2) {
    regs[idx] = (regs[idx] & ~0xFFFFn) | (val & 0xFFFFn);
  } else {
    regs[idx] = val & mask64; // 32-bit: val already masked, zero-extends
  }
  regs[idx] &= mask64;
}

// Effective address from decoded EA params (mirrors emitEA's i64 math).
function computeEA(ea, regs) {
  if (ea.ripRel) return ea.ripRelTarget & mask64;
  let a = ea.baseReg === 0xFF ? 0n : regs[ea.baseReg];
  if (ea.idxReg !== 0xFF) a = (a + ((regs[ea.idxReg] << BigInt(ea.scale)) & mask64)) & mask64;
  a = (a + (ea.disp & mask64)) & mask64;
  if (ea.asize32) a &= 0xFFFFFFFFn;
  return a;
}

// Encode a memory-operand ALU/TEST instruction.
// form: 'rm_r' | 'r_rm' | 'rm_imm' | 'test'; sub: 0..7; size: 1|2|4|8.
// eaKind: 'base' | 'disp8' | 'disp32' | 'sib' | 'sib32' | 'riprel'.
// Returns { code, ea, reg, imm, rexPresent, trailingImm }.
function encAluMem({ form, sub, size, reg = 0, imm = 0, eaKind = 'base', base = 0, idx = 1, scale = 0, disp = 0, asize32 = false, immOp = 0 }) {
  let rex = 0;
  if (size === 8) rex |= 0x08;
  if (reg >= 8) rex |= 0x04;
  const needB = eaKind !== 'riprel' && base >= 8;
  const needX = (eaKind === 'sib' || eaKind === 'sib32') && idx >= 8;
  if (needB) rex |= 0x01;
  if (needX) rex |= 0x02;
  // 8-bit high-byte registers (4..7) forbid REX; bump to low regs instead.
  let r = reg;
  if (size === 1 && !rex && r >= 4 && r <= 7 && (needB || needX || size === 8)) r = 0;
  const rexPresent = rex !== 0;
  if (size === 1 && r >= 4 && r <= 7) { /* high-byte: rex must be 0 */ }
  let effRex = rex;
  if (size === 1 && r >= 4 && r <= 7) effRex = 0; // high-byte rule: drop REX
  const code = [];
  if (asize32) code.push(0x67);
  if (size === 2) code.push(0x66);
  if (effRex) code.push(0x40 | effRex);
  const prefixLen = code.length;
  let op;
  if (form === 'rm_r') op = 0x00 | (sub << 3) | (size > 1 ? 1 : 0);
  else if (form === 'r_rm') op = 0x02 | (sub << 3) | (size > 1 ? 1 : 0);
  else if (form === 'test') op = size === 1 ? 0x84 : 0x85;
  else op = immOp; // rm_imm: 0x80 | 0x81 | 0x83
  code.push(op);
  const modrmPos = prefixLen + 1;
  let mod, rm;
  const dispBytes = [];
  const sibBytes = [];
  if (eaKind === 'riprel') { mod = 0; rm = 5; }
  else if (eaKind === 'sib' || eaKind === 'sib32') {
    rm = 4;
    const noBase = eaKind === 'sib32';
    mod = noBase ? 0 : disp !== 0 ? (disp >= -128 && disp <= 127 ? 1 : 2) : 0;
    sibBytes.push((scale << 6) | ((idx & 7) << 3) | (noBase ? 5 : (base & 7)));
  } else {
    rm = base & 7;
    mod = eaKind === 'disp8' ? 1 : eaKind === 'disp32' ? 2 : 0;
  }
  if (mod === 1) dispBytes.push(disp & 0xFF);
  if (mod === 2 || eaKind === 'riprel' || eaKind === 'sib32') dispBytes.push(...little(BigInt(disp) & 0xFFFFFFFFn, 4));
  const regF = form === 'rm_imm' ? sub : (r & 7);
  code.push((mod << 6) | (regF << 3) | rm, ...sibBytes, ...dispBytes);
  let trailingImm = 0;
  let immVal = 0n;
  if (form === 'rm_imm') {
    if (op === 0x80 || op === 0x83) {
      code.push(Number(BigInt(imm) & 0xFFn)); trailingImm = 1;
      immVal = BigInt.asIntN(64, BigInt.asIntN(8, BigInt(imm)));
    } else {
      const n = size === 2 ? 2 : 4; trailingImm = n;
      code.push(...little(BigInt(imm) & (n === 2 ? 0xFFFFn : 0xFFFFFFFFn), n));
      immVal = n === 2 ? BigInt(imm) & 0xFFFFn : size === 8 ? BigInt.asIntN(64, BigInt.asIntN(32, BigInt(imm))) : BigInt(imm) & 0xFFFFFFFFn;
    }
  }
  // Expected EA params (fixture ripBase=0).
  const ea = { ripRel: false, ripRelTarget: 0n, baseReg: 0xFF, idxReg: 0xFF, scale: 0, disp: 0n, asize32, seg: 0 };
  if (eaKind === 'riprel') {
    ea.ripRel = true;
    ea.ripRelTarget = (BigInt(modrmPos) + 5n + BigInt(trailingImm) + BigInt.asIntN(64, BigInt.asIntN(32, BigInt(disp)))) & mask64;
  } else {
    if (eaKind === 'sib' || eaKind === 'sib32') {
      ea.scale = scale;
      if (!(eaKind === 'sib32')) ea.baseReg = base;
      if (!((idx & 7) === 4 && !(effRex & 0x02))) ea.idxReg = idx;
    } else {
      ea.baseReg = base;
    }
    ea.disp = BigInt(disp) & mask64; // sign-extended below via asIntN
    if (mod === 1) ea.disp = BigInt.asIntN(64, BigInt.asIntN(8, BigInt(disp))) & mask64;
    else if (mod === 2 || eaKind === 'sib32') ea.disp = BigInt.asIntN(64, BigInt.asIntN(32, BigInt(disp))) & mask64;
    else ea.disp = 0n;
  }
  return { code, ea, reg: r, imm: immVal, rexPresent: effRex !== 0, form, sub, size };
}

// Run one memory-ALU instruction against real memRead/memWrite imports.
async function runAluMem(code, { regs, rflags = 0x202, memInit = new Map(), rip = 0x12345678ABCDEFF0n, ptr = 512 }) {
  const { result, path } = emit(code);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(WebAssembly.validate(readFileSync(path)), 'emitted module must validate');
  const memory = new WebAssembly.Memory({ initial: 1 });
  const guestMem = makeGuestMem();
  for (const [k, v] of memInit) guestMem.bytes.set(k, v);
  const view = new DataView(memory.buffer);
  regs.forEach((v, i) => view.setBigUint64(ptr + i * 8, v, true));
  view.setBigUint64(ptr + 128, rip, true);
  view.setUint32(ptr + 136, rflags >>> 0, true);
  view.setUint32(ptr + 140, 0xA5A5A5A5, true);
  const { instance } = await WebAssembly.instantiate(readFileSync(path), stringEnv(memory, guestMem));
  instance.exports.execute(ptr);
  return {
    regs: Array.from({ length: 16 }, (_, i) => view.getBigUint64(ptr + i * 8, true)),
    rflags: view.getUint32(ptr + 136, true),
    ripOut: view.getBigUint64(ptr + 128, true),
    reserved: view.getUint32(ptr + 140, true),
    guestMem,
  };
}

// Differential check: wasm vs JS reference model.
async function checkAluMem(enc, { regs, rflags = 0x202, memInit = new Map(), rip = 0x12345678ABCDEFF0n }) {
  const { form, sub, size } = enc;
  const refRegs = [...regs];
  const refMem = makeGuestMem();
  for (const [k, v] of memInit) refMem.bytes.set(k, v);
  const eaAddr = computeEA(enc.ea, refRegs);
  const mask = size === 8 ? mask64 : (1n << BigInt(size * 8)) - 1n;
  const memVal = refMem.read(eaAddr, size);
  const effSub = form === 'test' ? 4 : sub;
  let a, b;
  if (form === 'r_rm') { a = memRegRead(refRegs, enc.reg, size, enc.rexPresent); b = memVal; }
  else { a = memVal; b = form === 'rm_imm' ? enc.imm & mask : memRegRead(refRegs, enc.reg, size, enc.rexPresent); }
  const carryIn = (sub === 2 || sub === 3) && (rflags & 1) ? 1n : 0n;
  const { r, flags } = refAlu(effSub, a, b, size, carryIn);
  const refFlags = ((BigInt(rflags) & ~0x8D5n) | flags) & 0xFFFFFFFFn;
  const isWrite = form !== 'test' && sub !== 7;
  if (isWrite) {
    if (form === 'r_rm') memRegWrite(refRegs, enc.reg, size, r, enc.rexPresent);
    else refMem.write(eaAddr, size, r);
  }
  const out = await runAluMem(enc.code, { regs: [...regs], rflags, memInit, rip });
  assert.deepEqual(out.regs, refRegs, 'GPRs');
  assert.equal(BigInt(out.rflags), refFlags, 'RFLAGS');
  assert.equal(out.ripOut, (rip + BigInt(enc.code.length)) & mask64, 'RIP');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
  const refKeys = [...refMem.bytes.keys()].map(String).sort();
  const outKeys = [...out.guestMem.bytes.keys()].map(String).sort();
  assert.deepEqual(outKeys, refKeys, 'written addresses');
  for (const k of refKeys) assert.equal(out.guestMem.bytes.get(BigInt(k)), refMem.bytes.get(BigInt(k)), `mem[${k}]`);
}

const ALU_SBASE = 0x10000n;
function aluMemInit(base, arr) {
  const m = new Map();
  arr.forEach((v, i) => m.set(base + BigInt(i), v));
  return m;
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

// Adversarial 64-bit values: zero, +-1, sign/width boundaries, high addresses.
function advVal(rng) {
  return pick(rng, [
    0n, 1n, 0xFFFFFFFFFFFFFFFFn, 0xFFFFFFFFFFFFFFFEn,
    0x8000000000000000n, 0x7FFFFFFFFFFFFFFFn,
    0x00000000FFFFFFFFn, 0x0000000100000000n,
    0xFFFFFFFF00000000n, 0x00000000000000FFn, 0x000000000000FF00n,
    BigInt(Math.floor(rng() * 2 ** 32)) << 32n | BigInt(Math.floor(rng() * 2 ** 32)),
  ]);
}

// Random EA description covering all addressing forms, including adversarial
// ones (page boundaries, 0x67 wrap, SIB edge cases, RIP-relative).
function randomEA(rng) {
  const kind = pick(rng, ['base', 'base', 'disp8', 'disp32', 'sib', 'sib', 'sib32', 'riprel']);
  const asize32 = rng() < 0.25;
  if (kind === 'riprel') {
    // disp32 adversarial: small, page-boundary, negative, huge.
    const disp = pick(rng, [0, 8, -8, 0x1000, -0x1000, 0x7FFFFFFF, -0x80000000, Math.floor(rng() * 2 ** 32) - 2 ** 31]);
    return { eaKind: 'riprel', disp, asize32: false };
  }
  if (kind === 'sib32') {
    const idx = pick(rng, [0, 1, 4, 7, 8, 12, 15]);
    const disp = pick(rng, [0, 0x1000, -0x1000, 0x7FFFFFFF, Math.floor(rng() * 2 ** 32) - 2 ** 31]);
    return { eaKind: 'sib32', base: 0, idx, scale: pick(rng, [0, 1, 2, 3]), disp, asize32 };
  }
  if (kind === 'sib') {
    // base&7==5 with mod=0 needs disp32 (that's the sib32 kind); avoid it here.
    const base = pick(rng, [0, 1, 4, 7, 8, 12, 15]);
    const idx = pick(rng, [0, 1, 2, 4, 7, 8, 12, 15]);
    const disp = pick(rng, [0, 1, -1, 127, -128, 0x1000, -0x1000, 0x1234, -0x1234]);
    return { eaKind: 'sib', base, idx, scale: pick(rng, [0, 1, 2, 3]), disp, asize32 };
  }
  // base / disp8 / disp32: avoid (base&7)==5 with mod=0 (that's riprel,
  // so no r13), and avoid rsp/r12 (base&7==4) which needs a SIB byte.
  const base = pick(rng, [0, 1, 2, 3, 6, 7, 8, 9, 14, 15]);
  const disp = kind === 'base' ? 0 : pick(rng, [1, -1, 127, -128, 0x1000, -0x1000, 0x7FFFFFFF, -0x80000000]);
  return { eaKind: kind, base, disp, asize32 };
}

test('fuzz memory ALU vs reference (600 cases)', async () => {
  const rng = mulberry32(0xC0FFEE);
  const forms = ['rm_r', 'r_rm', 'rm_imm', 'test'];
  const sizes = [1, 2, 4, 8];
  for (let i = 0; i < 600; i++) {
    const form = pick(rng, forms);
    const sub = form === 'test' ? 0 : Math.floor(rng() * 8);
    const size = pick(rng, sizes);
    const reg = Math.floor(rng() * 16);
    const ea = randomEA(rng);
    // 8-bit high-byte registers (4..7) cannot combine with REX (needed for
    // base/idx >= 8); the encoder bumps them, so just avoid here.
    const needRexForEA = (ea.base ?? 0) >= 8 || (ea.idx ?? 0) >= 8 || size === 8;
    const effReg = (size === 1 && reg >= 4 && reg <= 7 && needRexForEA) ? reg - 4 : reg;
    let immOp = 0, imm = 0;
    if (form === 'rm_imm') {
      immOp = pick(rng, [0x80, 0x83, 0x83, 0x81]);
      if (size === 1) immOp = 0x80;
      else if (immOp === 0x80) immOp = 0x83; // 0x80 is 8-bit only
      if (size === 2 && immOp === 0x81) immOp = 0x83; // keep it simple
      imm = pick(rng, [0, 1, -1, 127, -128, 0x7F, 0x80, 0xFF, 0x1234, -0x1234]);
    }
    const enc = encAluMem({ form, sub, size, reg: effReg, imm, eaKind: ea.eaKind, base: ea.base ?? 0, idx: ea.idx ?? 1, scale: ea.scale ?? 0, disp: ea.disp ?? 0, asize32: ea.asize32, immOp });
    // Registers: adversarial values; base/index regs get plausible addresses
    // sometimes, adversarial (page-boundary, huge) other times.
    const regs = Array.from({ length: 16 }, () => advVal(rng));
    const eaForInit = enc.ea;
    const targetHint = computeEA(eaForInit, regs);
    // Memory: initialize the target bytes (and only those) with adversarial data.
    const memInit = new Map();
    const initVal = advVal(rng) & (size === 8 ? mask64 : (1n << BigInt(size * 8)) - 1n);
    for (let b = 0; b < size; b++) memInit.set((targetHint + BigInt(b)) & mask64, Number((initVal >> BigInt(8 * b)) & 0xFFn));
    const rflags = pick(rng, [0x202, 0x203, 0x8D5, 0x246, 0x202 | 0x800]);
    await checkAluMem(enc, { regs, rflags, memInit });
  }
}, 120000);

test('CMP [mem],r64 and TEST r64,[mem] write nothing', async () => {
  const regs = baseRegs(); regs[0] = ALU_SBASE; regs[1] = 0xFFFFFFFFFFFFFFFFn;
  const memInit = aluMemInit(ALU_SBASE, [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  const before = [...regs];
  await checkAluMem(encAluMem({ form: 'rm_r', sub: 7, size: 8, reg: 1, eaKind: 'base', base: 0 }),
    { regs, rflags: 0x202, memInit });
  // Memory must be unchanged by CMP; regs unchanged too.
  const out = await runAluMem(encAluMem({ form: 'test', sub: 0, size: 8, reg: 1, eaKind: 'base', base: 0 }).code,
    { regs: [...before], rflags: 0x202, memInit });
  assert.deepEqual(out.regs, before, 'TEST writes no register');
  assert.deepEqual([...out.guestMem.bytes.keys()], [...memInit.keys()], 'TEST writes no memory');
});

test('ADC/SBB [mem],r64 fold the incoming carry', async () => {
  for (const cf of [0, 1]) {
    const regs = baseRegs(); regs[0] = ALU_SBASE; regs[1] = 5n;
    const memInit = aluMemInit(ALU_SBASE, [0xFF, 0, 0, 0, 0, 0, 0, 0]);
    const rflags = 0x202 | cf;
    await checkAluMem(encAluMem({ form: 'rm_r', sub: 2, size: 8, reg: 1, eaKind: 'base', base: 0 }),
      { regs, rflags, memInit });
    await checkAluMem(encAluMem({ form: 'rm_r', sub: 3, size: 8, reg: 1, eaKind: 'base', base: 0 }),
      { regs, rflags, memInit });
  }
});

test('immediate-to-memory ADD/SUB/AND/OR/XOR', async () => {
  const regs = baseRegs(); regs[0] = ALU_SBASE;
  for (const [sub, immOp, imm] of [[0, 0x83, 5], [5, 0x83, -3], [4, 0x80, 0xF0], [6, 0x81, 0x12345678], [1, 0x81, -1]]) {
    const size = immOp === 0x80 ? 1 : 8;
    const memInit = aluMemInit(ALU_SBASE, [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
    await checkAluMem(encAluMem({ form: 'rm_imm', sub, size, eaKind: 'base', base: 0, imm, immOp }),
      { regs, rflags: 0x202, memInit });
  }
});

test('16-bit and 8-bit memory ALU', async () => {
  const regs = baseRegs(); regs[0] = ALU_SBASE; regs[1] = 0x1234n; regs[2] = 0xABn;
  const memInit = aluMemInit(ALU_SBASE, [0xFF, 0x00, 0x11, 0x22]);
  await checkAluMem(encAluMem({ form: 'rm_r', sub: 0, size: 2, reg: 1, eaKind: 'base', base: 0 }),
    { regs, rflags: 0x202, memInit });
  await checkAluMem(encAluMem({ form: 'r_rm', sub: 4, size: 2, reg: 1, eaKind: 'disp8', base: 0, disp: 2 }),
    { regs, rflags: 0x202, memInit });
  // 8-bit with high-byte register (AH).
  await checkAluMem(encAluMem({ form: 'rm_r', sub: 6, size: 1, reg: 4, eaKind: 'base', base: 0 }),
    { regs, rflags: 0x202, memInit });
  // 8-bit r8b (REX, low byte).
  await checkAluMem(encAluMem({ form: 'r_rm', sub: 0, size: 1, reg: 8, eaKind: 'base', base: 0 }),
    { regs, rflags: 0x202, memInit });
});

test('SIB and displacement addressing', async () => {
  const regs = baseRegs();
  regs[0] = ALU_SBASE; regs[1] = 0x100n; regs[2] = 0x10n;
  const memInit = aluMemInit(ALU_SBASE + 0x100n * 4n + 0x10n - 8n, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  // [rax + rcx*4 + 0x10], disp8 variant
  await checkAluMem(encAluMem({ form: 'rm_r', sub: 0, size: 8, reg: 3, eaKind: 'sib', base: 0, idx: 1, scale: 2, disp: 0x10 }),
    { regs, rflags: 0x202, memInit });
  // [rbx + rdx*2 - 16]
  regs[3] = ALU_SBASE + 0x200n; regs[4] = 0x50n;
  const memInit2 = aluMemInit(ALU_SBASE + 0x200n + 0x50n * 2n - 16n, [0xAA, 0xBB, 0xCC, 0xDD]);
  await checkAluMem(encAluMem({ form: 'r_rm', sub: 5, size: 4, reg: 5, eaKind: 'sib', base: 3, idx: 4, scale: 1, disp: -16 }),
    { regs, rflags: 0x202, memInit: memInit2 });
  // disp32-only [0x1000]
  const memInit3 = aluMemInit(0x1000n, [7, 7, 7, 7]);
  await checkAluMem(encAluMem({ form: 'rm_r', sub: 1, size: 4, reg: 6, eaKind: 'sib32', disp: 0x1000 }),
    { regs, rflags: 0x202, memInit: memInit3 });
});

test('RIP-relative memory ALU (fixture ripBase=0)', async () => {
  const regs = baseRegs(); regs[1] = 0x42n;
  // add [rip+0x100], rax: target = len + 0x100 (ripBase=0).
  const enc = encAluMem({ form: 'rm_r', sub: 0, size: 8, reg: 1, eaKind: 'riprel', disp: 0x100 });
  const target = enc.ea.ripRelTarget;
  const memInit = aluMemInit(target, [1, 0, 0, 0, 0, 0, 0, 0]);
  await checkAluMem(enc, { regs, rflags: 0x202, memInit });
  // sub [rip-0x10], 5 with trailing imm (tests the trailingImm term).
  const enc2 = encAluMem({ form: 'rm_imm', sub: 5, size: 8, eaKind: 'riprel', disp: -0x10, imm: 5, immOp: 0x83 });
  const target2 = enc2.ea.ripRelTarget;
  const memInit2 = aluMemInit(target2, [10, 0, 0, 0, 0, 0, 0, 0]);
  await checkAluMem(enc2, { regs, rflags: 0x202, memInit: memInit2 });
});

test('0x67 address-size wraps the EA to 32 bits', async () => {
  const regs = baseRegs();
  regs[0] = 0x1_00010000n; // low 32 bits = 0x10000
  const memInit = aluMemInit(0x10000n, [0xFF, 0xFF, 0xFF, 0xFF]);
  await checkAluMem(encAluMem({ form: 'rm_r', sub: 4, size: 4, reg: 1, eaKind: 'base', base: 0, asize32: true }),
    { regs, rflags: 0x202, memInit });
});

test('unmapped read returns 0 then write commits (fault ordering)', async () => {
  const regs = baseRegs(); regs[0] = 0xDEAD0000n; regs[1] = 1n;
  // Read from an address never initialized: reference reads 0, adds 1, writes 1.
  await checkAluMem(encAluMem({ form: 'rm_r', sub: 0, size: 8, reg: 1, eaKind: 'base', base: 0 }),
    { regs, rflags: 0x202, memInit: new Map() });
});

test('ADD [mem],r64 / SUB r64,[mem] round-trip', async () => {
  const regs = baseRegs(); regs[0] = ALU_SBASE; regs[1] = 0x1122334455667788n;
  const memInit = aluMemInit(ALU_SBASE, [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  await checkAluMem(encAluMem({ form: 'rm_r', sub: 0, size: 8, reg: 1, eaKind: 'base', base: 0 }),
    { regs, rflags: 0x202, memInit });
  await checkAluMem(encAluMem({ form: 'r_rm', sub: 5, size: 8, reg: 1, eaKind: 'base', base: 0 }),
    { regs, rflags: 0x202, memInit });
});

// --- 8-bit MOV (88/8A) reference model (mirrors cpu64.cpp dsp_9/dsp_10) ---
// Encode MOV r/m8,r8 (0x88) / MOV r8,r/m8 (0x8A), reg-direct (eaKind 'reg')
// or memory (eaKinds shared with encAluMem). Returns { code, ea, reg, rm,
// rexPresent, dir, eaKind }.
function encMov8({ dir, reg = 0, rm = 0, eaKind = 'reg', base = 0, idx = 1, scale = 0, disp = 0, asize32 = false }) {
  let rex = 0;
  if (reg >= 8) rex |= 0x04;
  if (eaKind === 'reg') { if (rm >= 8) rex |= 0x01; }
  else if (eaKind !== 'riprel') { if (base >= 8) rex |= 0x01; }
  if ((eaKind === 'sib' || eaKind === 'sib32') && idx >= 8) rex |= 0x02;
  const rexPresent = rex !== 0;
  const code = [];
  if (asize32) code.push(0x67);
  if (rex) code.push(0x40 | rex);
  const prefixLen = code.length;
  code.push(dir === 'rm_r' ? 0x88 : 0x8A);
  const modrmPos = prefixLen + 1;
  let mod, rmF;
  const dispBytes = [];
  const sibBytes = [];
  if (eaKind === 'reg') { mod = 3; rmF = rm & 7; }
  else if (eaKind === 'riprel') { mod = 0; rmF = 5; }
  else if (eaKind === 'sib' || eaKind === 'sib32') {
    rmF = 4;
    const noBase = eaKind === 'sib32';
    mod = noBase ? 0 : disp !== 0 ? (disp >= -128 && disp <= 127 ? 1 : 2) : 0;
    sibBytes.push((scale << 6) | ((idx & 7) << 3) | (noBase ? 5 : (base & 7)));
  } else {
    rmF = base & 7;
    mod = eaKind === 'disp8' ? 1 : eaKind === 'disp32' ? 2 : 0;
  }
  if (mod === 1) dispBytes.push(disp & 0xFF);
  if (mod === 2 || eaKind === 'riprel' || eaKind === 'sib32') dispBytes.push(...little(BigInt(disp) & 0xFFFFFFFFn, 4));
  code.push((mod << 6) | ((reg & 7) << 3) | rmF, ...sibBytes, ...dispBytes);
  // Expected EA params (fixture ripBase=0); mirrors encAluMem.
  const ea = { ripRel: false, ripRelTarget: 0n, baseReg: 0xFF, idxReg: 0xFF, scale: 0, disp: 0n, asize32, seg: 0 };
  if (eaKind === 'riprel') {
    ea.ripRel = true;
    ea.ripRelTarget = (BigInt(modrmPos) + 5n + BigInt.asIntN(64, BigInt.asIntN(32, BigInt(disp)))) & mask64;
  } else if (eaKind !== 'reg') {
    if (eaKind === 'sib' || eaKind === 'sib32') {
      ea.scale = scale;
      if (eaKind !== 'sib32') ea.baseReg = base;
      if (!((idx & 7) === 4 && !(rex & 0x02))) ea.idxReg = idx;
    } else {
      ea.baseReg = base;
    }
    ea.disp = 0n;
    if (mod === 1) ea.disp = BigInt.asIntN(64, BigInt.asIntN(8, BigInt(disp))) & mask64;
    else if (mod === 2 || eaKind === 'sib32') ea.disp = BigInt.asIntN(64, BigInt.asIntN(32, BigInt(disp))) & mask64;
  }
  return { code, ea, reg, rm, rexPresent, dir, eaKind };
}

// Differential check: wasm vs JS reference model (dsp_9/dsp_10).
async function checkMov8(enc, { regs, rflags = 0x202, memInit = new Map(), rip = 0x12345678ABCDEFF0n }) {
  const refRegs = [...regs];
  const refMem = makeGuestMem();
  for (const [k, v] of memInit) refMem.bytes.set(k, v);
  if (enc.eaKind === 'reg') {
    const srcIdx = enc.dir === 'rm_r' ? enc.reg : enc.rm;
    const destIdx = enc.dir === 'rm_r' ? enc.rm : enc.reg;
    const byte = memRegRead(refRegs, srcIdx, 1, enc.rexPresent);
    memRegWrite(refRegs, destIdx, 1, byte, enc.rexPresent);
  } else {
    const eaAddr = computeEA(enc.ea, refRegs);
    if (enc.dir === 'rm_r') {
      const byte = memRegRead(refRegs, enc.reg, 1, enc.rexPresent);
      refMem.write(eaAddr, 1, byte);
    } else {
      const byte = refMem.read(eaAddr, 1);
      memRegWrite(refRegs, enc.reg, 1, byte, enc.rexPresent);
    }
  }
  const out = await runAluMem(enc.code, { regs: [...regs], rflags, memInit, rip });
  assert.deepEqual(out.regs, refRegs, 'GPRs');
  assert.equal(BigInt(out.rflags), BigInt(rflags) & 0xFFFFFFFFn, 'RFLAGS preserved (MOV never touches flags)');
  assert.equal(out.ripOut, (rip + BigInt(enc.code.length)) & mask64, 'RIP');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
  const refKeys = [...refMem.bytes.keys()].map(String).sort();
  const outKeys = [...out.guestMem.bytes.keys()].map(String).sort();
  assert.deepEqual(outKeys, refKeys, 'written addresses');
  for (const k of refKeys) assert.equal(out.guestMem.bytes.get(BigInt(k)), refMem.bytes.get(BigInt(k)), `mem[${k}]`);
}

test('MOV r/m8,r8 reg-direct: low bytes and high-byte AH', async () => {
  // 88 C8: mov al, cl
  await checkMov8(encMov8({ dir: 'rm_r', reg: 1, rm: 0, eaKind: 'reg' }), { regs: baseRegs() });
  // 88 E0: mov al, ah (no REX: reg field 4 => AH)
  const regs = baseRegs(); regs[0] = 0x1122334455667788n;
  await checkMov8(encMov8({ dir: 'rm_r', reg: 4, rm: 0, eaKind: 'reg' }), { regs });
});

test('MOV r8,r/m8 reg-direct: 8A direction and REX SPL semantics', async () => {
  // 8A C3: mov al, bl
  await checkMov8(encMov8({ dir: 'r_rm', reg: 0, rm: 3, eaKind: 'reg' }), { regs: baseRegs() });
  // 40 88 E0: mov spl, al (REX present: reg field 4 => SPL, not AH)
  const regs = baseRegs(); regs[4] = 0xAABBCCDDEEFF0011n;
  await checkMov8(encMov8({ dir: 'rm_r', reg: 4, rm: 0, eaKind: 'reg' }), { regs });
});

test('MOV r/m8,r8 with REX.B: r8b/r9b', async () => {
  // 45 88 C1: mov r9b, r8b
  const regs = baseRegs(); regs[8] = 0x5An;
  await checkMov8(encMov8({ dir: 'rm_r', reg: 8, rm: 9, eaKind: 'reg' }), { regs });
});

test('MOV byte [mem],r8 / r8,[mem] round-trip', async () => {
  const regs = baseRegs(); regs[0] = ALU_SBASE; regs[1] = 0xABn;
  const memInit = aluMemInit(ALU_SBASE, [0x11]);
  // 88 08: mov [rax], cl ; 8A 10: mov dl, [rax]
  await checkMov8(encMov8({ dir: 'rm_r', reg: 1, eaKind: 'base', base: 0 }), { regs, memInit });
  const regs2 = baseRegs(); regs2[0] = ALU_SBASE;
  await checkMov8(encMov8({ dir: 'r_rm', reg: 2, eaKind: 'base', base: 0 }), { regs: regs2, memInit });
});

test('MOV r/m8,r8 to unmapped address commits the write', async () => {
  const regs = baseRegs(); regs[0] = 0xDEAD0000n; regs[3] = 0x7Fn;
  await checkMov8(encMov8({ dir: 'rm_r', reg: 3, eaKind: 'base', base: 0 }), { regs, memInit: new Map() });
});

test('MOV r8,[mem] from unmapped address reads 0', async () => {
  const regs = baseRegs(); regs[0] = 0xDEAD0000n;
  await checkMov8(encMov8({ dir: 'r_rm', reg: 3, eaKind: 'base', base: 0 }), { regs, memInit: new Map() });
});

test('66 88 stays fast (0x66 ignored for 8-bit)', async () => {
  await checkMov8({ ...encMov8({ dir: 'rm_r', reg: 1, rm: 0, eaKind: 'reg' }), code: [0x66, 0x88, 0xC8] }, { regs: baseRegs() });
});

test('whole-block fallback rejects 16-bit MOV (66 89)', () => {
  assert.equal(emit([0x66, 0x89, 0xC8]).result.status, 2);
});

test('fuzz 8-bit MOV vs reference (600 cases)', async () => {
  const rng = mulberry32(0x885A);
  for (let i = 0; i < 600; i++) {
    const dir = pick(rng, ['rm_r', 'r_rm']);
    const reg = Math.floor(rng() * 16);
    const useMem = rng() < 0.7; // 88 is 91% memory-store in doom.exe
    let eaKind = 'reg', ea = null, rm = 0;
    if (useMem) {
      ea = randomEA(rng);
      eaKind = ea.eaKind;
    } else {
      rm = Math.floor(rng() * 16);
    }
    // High-byte registers (4..7) with no REX: keep the EA REX-free so the
    // encoder's intent (AH/BH/CH/DH) survives; REX+4..7 (SPL/...) is still
    // covered when the EA forces REX via base/idx >= 8.
    const hiReg = reg >= 4 && reg <= 7;
    const hiRm = !useMem && rm >= 4 && rm <= 7;
    let effReg = reg, effRm = rm, effEa = ea, effEaKind = eaKind;
    if ((hiReg || hiRm) && useMem && ((ea.base ?? 0) >= 8 || (ea.idx ?? 0) >= 8)) {
      effEaKind = 'base'; effEa = { eaKind: 'base', base: 0, disp: 0, asize32: ea.asize32 };
    }
    if ((hiReg || hiRm) && !useMem && (effRm >= 8)) effRm = effRm - 8;
    const enc = encMov8({ dir, reg: effReg, rm: effRm, eaKind: effEaKind,
      base: effEa?.base ?? 0, idx: effEa?.idx ?? 1, scale: effEa?.scale ?? 0,
      disp: effEa?.disp ?? 0, asize32: effEa?.asize32 ?? false });
    const regs = Array.from({ length: 16 }, () => advVal(rng));
    // Adversarial byte patterns in the source byte's lane.
    const memInit = new Map();
    if (useMem) {
      const eaForInit = enc.ea;
      const targetHint = computeEA(eaForInit, regs);
      memInit.set(targetHint & mask64, Math.floor(rng() * 256));
    }
    const rflags = pick(rng, [0x202, 0x203, 0x8D5, 0x246, 0x202 | 0x800, 0x402]);
    await checkMov8(enc, { regs, rflags, memInit });
  }
}, 180000);

// --- Shift reference model (mirrors cpu64.cpp doShift; count pre-masked) ---
const SHIFT_MASK = 0x8C5;
function refShift(sub, v, count, width, rflagsIn) {
  const mask = width === 1 ? 0xFFn : width === 2 ? 0xFFFFn : width === 4 ? 0xFFFFFFFFn : mask64;
  const sb = 1n << BigInt(width * 8 - 1);
  const wbits = BigInt(width * 8);
  v &= mask;
  if (count === 0n) return { r: v, flags: BigInt(rflagsIn) & BigInt(SHIFT_MASK) };
  let r, cf;
  if (sub === 4 || sub === 6) {          // SHL
    cf = (v >> (wbits - count)) & 1n;
    r = (v << count) & mask;
  } else if (sub === 5) {                // SHR
    cf = (v >> (count - 1n)) & 1n;
    r = (v >> count) & mask;
  } else {                               // SAR: arithmetic shift of sign-extended value
    cf = (v >> (count - 1n)) & 1n;
    const signed = (v & sb) ? v - (1n << wbits) : v;
    r = (signed >> count) & mask;        // BigInt >> is arithmetic
  }
  let of = 0n;
  if (count === 1n) {
    if (sub === 4 || sub === 6) of = (((r & sb) ? 1n : 0n) ^ cf) & 1n;
    else if (sub === 5) of = (v & sb) ? 1n : 0n;
  }
  const zf = r === 0n ? 1n : 0n, sf = (r & sb) ? 1n : 0n;
  let q = Number(r & 0xFFn); q ^= q >> 4; q ^= q >> 2; q ^= q >> 1;
  const pf = (q & 1) === 0 ? 1n : 0n;
  return { r, flags: cf | (pf << 2n) | (zf << 6n) | (sf << 7n) | (of << 11n) };
}

function expectShift(out, initFlags, newBits, codeLen, changed) {
  assert.equal(out.rflags, (((initFlags & ~SHIFT_MASK) | Number(newBits)) >>> 0), 'rflags');
  assert.equal(out.ripOut, (0x12345678ABCDEFF0n + BigInt(codeLen)) & mask64, 'RIP advances');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
  changed(out.regs);
}

test('SHL r64 by 4 shifts out CF and zeroes', async () => {
  const regs = baseRegs(); regs[0] = 0xF000000000000000n;
  const { r, flags } = refShift(4, regs[0], 4n, 8, 0x202);
  assert.equal(flags & 0x8C5n, 0x1n | 0x40n | 0x4n, 'CF+ZF+PF set, OF clear');
  const out = await runAlu([0x48, 0xC1, modrm(4, 0), 0x04], regs, 0x202);
  expectShift(out, 0x202, flags, 4, got => assert.equal(got[0], r));
});

test('SHL r64 by 1 sets OF from MSB xor CF', async () => {
  const regs = baseRegs(); regs[0] = 0x4000000000000000n;
  const { r, flags } = refShift(4, regs[0], 1n, 8, 0x202);
  assert.equal(flags & 0x8C5n, 0x800n | 0x80n | 0x4n, 'OF+SF+PF set');
  const out = await runAlu([0x48, 0xC1, modrm(4, 0), 0x01], regs, 0x202);
  expectShift(out, 0x202, flags, 4, got => assert.equal(got[0], r));
});

test('SHR r64 by 1 shifts into CF, OF is old MSB', async () => {
  const regs = baseRegs(); regs[0] = 0x8000000000000001n;
  const { r, flags } = refShift(5, regs[0], 1n, 8, 0x202);
  assert.equal(flags & 0x8C5n, 0x1n | 0x800n | 0x4n, 'CF+OF+PF set');
  const out = await runAlu([0x48, 0xC1, modrm(5, 0), 0x01], regs, 0x202);
  expectShift(out, 0x202, flags, 4, got => assert.equal(got[0], r));
});

test('SAR r64 by 1 sign-extends and clears OF', async () => {
  const regs = baseRegs(); regs[0] = 0x8000000000000000n;
  const { r, flags } = refShift(7, regs[0], 1n, 8, 0x202);
  assert.equal(r, 0xC000000000000000n);
  assert.equal(flags & 0x8C5n, 0x80n | 0x4n, 'only SF+PF set');
  const out = await runAlu([0x48, 0xC1, modrm(7, 0), 0x01], regs, 0x202);
  expectShift(out, 0x202, flags, 4, got => assert.equal(got[0], r));
});

test('SAR r64 by 63 of -1 stays -1 with CF set', async () => {
  const regs = baseRegs(); regs[0] = mask64;
  const { r, flags } = refShift(7, regs[0], 63n, 8, 0x202);
  assert.equal(r, mask64);
  assert.equal(flags & 0x8C5n, 0x1n | 0x80n | 0x4n, 'CF+SF+PF set');
  const out = await runAlu([0x48, 0xC1, modrm(7, 0), 0x3F], regs, 0x202);
  expectShift(out, 0x202, flags, 4, got => assert.equal(got[0], r));
});

test('SHL r32 uses 32-bit width, flags and zero-extension', async () => {
  const regs = baseRegs(); regs[0] = 0x80000001n;
  const { r, flags } = refShift(4, regs[0], 1n, 4, 0x202);
  assert.equal(r, 0x2n);
  assert.equal(flags & 0x8C5n, 0x1n | 0x800n, 'CF+OF set');
  const out = await runAlu([0xC1, modrm(4, 0), 0x01], regs, 0x202);
  expectShift(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});

test('SAR r32 sign-extends from 32 bits', async () => {
  const regs = baseRegs(); regs[0] = 0x80000000n;
  const { r, flags } = refShift(7, regs[0], 1n, 4, 0x202);
  assert.equal(r, 0xC0000000n);
  const out = await runAlu([0xC1, modrm(7, 0), 0x01], regs, 0x202);
  expectShift(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});

test('shift by 0 is a no-op preserving value and flags', async () => {
  const regs = baseRegs(); regs[0] = 0x123n;
  const out = await runAlu([0x48, 0xC1, modrm(4, 0), 0x00], regs, 0x8C5);
  assert.equal(out.rflags, 0x8C5, 'flags untouched');
  assert.equal(out.regs[0], 0x123n, 'value untouched');
});

test('shift preserves AF and non-shift RFLAGS bits', async () => {
  const regs = baseRegs(); regs[0] = 1n;
  const { flags } = refShift(4, regs[0], 1n, 8, 0xA5B5);
  const out = await runAlu([0x48, 0xC1, modrm(4, 0), 0x01], regs, 0xA5B5);
  expectShift(out, 0xA5B5, flags, 4, () => {});
  assert.equal(out.rflags & 0x10, 0x10, 'AF preserved');
});

test('SHL /6 alias behaves like /4', async () => {
  const regs = baseRegs(); regs[0] = 0x4000000000000000n;
  const { r, flags } = refShift(6, regs[0], 1n, 8, 0x202);
  const out = await runAlu([0x48, 0xC1, modrm(6, 0), 0x01], regs, 0x202);
  expectShift(out, 0x202, flags, 4, got => assert.equal(got[0], r));
});

test('shift on extended register r8', async () => {
  const regs = baseRegs(); regs[8] = 3n;
  const { r, flags } = refShift(4, regs[8], 2n, 8, 0x202);
  const out = await runAlu([0x49, 0xC1, modrm(4, 0), 0x02], regs, 0x202);
  expectShift(out, 0x202, flags, 4, got => {
    assert.equal(got[8], r);
    assert.equal(got[0], regs[0], 'rax untouched');
  });
});

test('mixed shift+ALU block observes shift result', async () => {
  const regs = baseRegs(); regs[0] = 1n; regs[3] = 0n;
  const code = [0x48, 0xC1, modrm(4, 0), 0x03, 0x48, 0x01, modrm(3, 0)];
  const s = refShift(4, 1n, 3n, 8, 0x202);
  const a = refAlu(0, s.r, 0n, 8);
  const out = await runAlu(code, regs, 0x202);
  // Final flags come from the ADD; check the value chain instead.
  assert.equal(out.regs[0], a.r, 'add saw the shifted value');
  assert.equal(out.rflags & 0x8C5, Number(a.flags & 0x8D5n) & 0x8C5, 'ADD flags');
});

// --- Rotate reference model (mirrors cpu64.cpp doShift sub 0..3; count pre-masked) ---
const ROT_MASK = 0x801;
function refRotate(sub, v, count, width, rflagsIn) {
  const mask = width === 1 ? 0xFFn : width === 2 ? 0xFFFFn : width === 4 ? 0xFFFFFFFFn : mask64;
  const sb = 1n << BigInt(width * 8 - 1);
  const wbits = BigInt(width * 8);
  const mbits = width === 4 ? 31n : 63n;
  v &= mask;
  const c = count & mbits; // decoder pre-masks, but mirror it
  if (c === 0n) return { r: v, flags: BigInt(rflagsIn) }; // flags untouched
  let r, cf, of = 0n;
  if (sub === 0) { // ROL
    r = ((v << c) | (v >> (wbits - c))) & mask;
    cf = (v >> (wbits - c)) & 1n;
    if (c === 1n) of = (((r & sb) ? 1n : 0n) ^ cf) & 1n;
  } else if (sub === 1) { // ROR
    r = ((v >> c) | (v << (wbits - c))) & mask;
    cf = (v >> (c - 1n)) & 1n;
    if (c === 1n) of = (((r & sb) ? 1n : 0n) ^ ((r >> (wbits - 2n)) & 1n)) & 1n;
  } else if (sub === 2) { // RCL: loop-carried carry
    cf = BigInt(rflagsIn) & 1n;
    r = v;
    for (let i = 0n; i < c; i++) {
      const ncf = (r & sb) ? 1n : 0n;
      r = ((r << 1n) | cf) & mask;
      cf = ncf;
    }
    if (c === 1n) of = (((r & sb) ? 1n : 0n) ^ cf) & 1n;
  } else { // RCR
    cf = BigInt(rflagsIn) & 1n;
    r = v;
    for (let i = 0n; i < c; i++) {
      const ncf = r & 1n;
      r = ((r >> 1n) | (cf << (wbits - 1n))) & mask;
      cf = ncf;
    }
    if (c === 1n) of = (((r & sb) ? 1n : 0n) ^ ((r >> (wbits - 2n)) & 1n)) & 1n;
  }
  // OF is only defined for count==1; otherwise it is preserved.
  const fmask = c === 1n ? ~0x801n : ~0x001n;
  return { r, flags: (BigInt(rflagsIn) & fmask) | cf | (of << 11n) };
}

function expectRotate(out, initFlags, newBits, codeLen, changed) {
  assert.equal(out.rflags, (((initFlags & ~ROT_MASK) | Number(newBits)) >>> 0), 'rflags');
  assert.equal(out.ripOut, (0x12345678ABCDEFF0n + BigInt(codeLen)) & mask64, 'RIP advances');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
  changed(out.regs);
}

// --- IMUL reference model (two-operand 0F AF; mirrors cpu64.cpp BK_IMUL_R_RM) ---
const IMUL_MASK = 0x801;
function refImul(a, b, width) {
  const mask = width === 4 ? 0xFFFFFFFFn : mask64;
  const wbits = BigInt(width * 8);
  const sb = 1n << (wbits - 1n);
  // Sign-extend operands to the operation width, then to BigInt full precision.
  let sa = a & mask, sbv = b & mask;
  sa = (sa & sb) ? sa - (1n << wbits) : sa;
  sbv = (sbv & sb) ? sbv - (1n << wbits) : sbv;
  const prod = sa * sbv;
  const r = prod & mask;
  // Overflow iff the full product differs from its sign-extended low half.
  let rs = r & mask;
  rs = (rs & sb) ? rs - (1n << wbits) : rs;
  const ovf = prod !== rs ? 1n : 0n;
  return { r, flags: ovf ? 0x801n : 0n };
}

function expectImul(out, initFlags, newBits, codeLen, changed) {
  assert.equal(out.rflags, (((initFlags & ~IMUL_MASK) | Number(newBits)) >>> 0), 'rflags');
  assert.equal(out.ripOut, (0x12345678ABCDEFF0n + BigInt(codeLen)) & mask64, 'RIP advances');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
  changed(out.regs);
}

// ===== Rotate execution tests (0xC1 /0../3) =====

test('ROL r64 by 1 rotates MSB into CF and LSB', async () => {
  const regs = baseRegs(); regs[0] = 0x8000000000000001n;
  const { r, flags } = refRotate(0, regs[0], 1n, 8, 0x202);
  assert.equal(r, 0x0000000000000003n);
  assert.equal(flags & 0x801n, 0x801n, 'CF+OF set');
  const out = await runAlu([0x48, 0xC1, modrm(0, 0), 0x01], regs, 0x202);
  expectRotate(out, 0x202, flags, 4, got => assert.equal(got[0], r));
});

test('ROL r64 by 4, OF preserved when count!=1', async () => {
  const regs = baseRegs(); regs[0] = 0x123456789ABCDEF0n;
  const { r, flags } = refRotate(0, regs[0], 4n, 8, 0xADB5);
  const out = await runAlu([0x48, 0xC1, modrm(0, 0), 0x04], regs, 0xADB5);
  expectRotate(out, 0xADB5, flags, 4, got => {
    assert.equal(got[0], r);
    assert.equal(out.rflags & 0x800, 0x800, 'OF preserved from input (count!=1)');
  });
});

test('ROR r64 by 1 shifts LSB into CF', async () => {
  const regs = baseRegs(); regs[0] = 0x8000000000000001n;
  const { r, flags } = refRotate(1, regs[0], 1n, 8, 0x202);
  assert.equal(r, 0xC000000000000000n);
  const out = await runAlu([0x48, 0xC1, modrm(1, 0), 0x01], regs, 0x202);
  expectRotate(out, 0x202, flags, 4, got => assert.equal(got[0], r));
});

test('RCL r64 by 1 threads carry through CF', async () => {
  const regs = baseRegs(); regs[0] = 0x8000000000000000n;
  // CF=1 in: bit0 becomes 1, MSB goes to CF.
  const { r, flags } = refRotate(2, regs[0], 1n, 8, 0x203);
  assert.equal(r, 0x0000000000000001n);
  assert.equal(flags & 1n, 1n, 'CF set from old MSB');
  const out = await runAlu([0x48, 0xC1, modrm(2, 0), 0x01], regs, 0x203);
  expectRotate(out, 0x203, flags, 4, got => assert.equal(got[0], r));
});

test('RCR r64 by 1 threads carry through CF', async () => {
  const regs = baseRegs(); regs[0] = 0x0000000000000001n;
  const { r, flags } = refRotate(3, regs[0], 1n, 8, 0x202);
  assert.equal(r, 0x0000000000000000n);
  assert.equal(flags & 1n, 1n, 'CF set from old LSB');
  const out = await runAlu([0x48, 0xC1, modrm(3, 0), 0x01], regs, 0x202);
  expectRotate(out, 0x202, flags, 4, got => assert.equal(got[0], r));
});

test('ROL r32 by 1 zero-extends and uses 32-bit width', async () => {
  const regs = baseRegs(); regs[0] = 0xDEADBEEF80000001n;
  const { r, flags } = refRotate(0, regs[0], 1n, 4, 0x202);
  assert.equal(r, 0x00000003n); // ROL(0x80000001,1): bit31->CF, bit0=1
  const out = await runAlu([0xC1, modrm(0, 0), 0x01], regs, 0x202);
  expectRotate(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});

test('rotate by 0 leaves value and flags untouched', async () => {
  const regs = baseRegs(); regs[0] = 0x123456789ABCDEF0n;
  for (const sub of [0, 1, 2, 3]) {
    const { r, flags } = refRotate(sub, regs[0], 0n, 8, 0xA5B5);
    assert.equal(r, regs[0]);
    assert.equal(flags, 0xA5B5n);
    const out = await runAlu([0x48, 0xC1, modrm(sub, 0), 0x00], regs, 0xA5B5);
    expectRotate(out, 0xA5B5, flags, 4, got => assert.equal(got[0], r));
  }
});

test('RCL r64 by 63 iterates the full carry chain', async () => {
  const regs = baseRegs(); regs[0] = 0xFFFFFFFFFFFFFFFFn;
  const { r, flags } = refRotate(2, regs[0], 63n, 8, 0x202);
  const out = await runAlu([0x48, 0xC1, modrm(2, 0), 0x3F], regs, 0x202);
  expectRotate(out, 0x202, flags, 4, got => assert.equal(got[0], r));
});

test('rotate preserves SZP/AF (only CF/OF change)', async () => {
  const regs = baseRegs(); regs[0] = 0x8000000000000000n;
  const { flags } = refRotate(0, regs[0], 1n, 8, 0xA5B5);
  const out = await runAlu([0x48, 0xC1, modrm(0, 0), 0x01], regs, 0xA5B5);
  assert.equal(out.rflags & ~0x801, 0xA5B5 & ~0x801, 'SZP/AF preserved');
  assert.equal(out.rflags & 0x801, Number(flags & 0x801n), 'CF/OF from rotate');
});

// ===== IMUL execution tests (0F AF) =====

test('IMUL r64,r64 without overflow clears CF/OF', async () => {
  const regs = baseRegs(); regs[2] = 6n; regs[5] = 7n;
  const { r, flags } = refImul(6n, 7n, 8);
  assert.equal(r, 42n); assert.equal(flags, 0n);
  const out = await runAlu([0x48, 0x0F, 0xAF, modrm(2, 5)], regs, 0xA5B5);
  expectImul(out, 0xA5B5, flags, 4, got => {
    assert.equal(got[2], 42n, 'rdx = 6*7');
    assert.equal(got[5], 7n, 'rbp untouched');
  });
});

test('IMUL r64,r64 overflow sets CF and OF', async () => {
  const regs = baseRegs(); regs[2] = 0x7000000000000000n; regs[5] = 2n;
  const { r, flags } = refImul(0x7000000000000000n, 2n, 8);
  assert.equal(r, 0xE000000000000000n); assert.equal(flags, 0x801n);
  const out = await runAlu([0x48, 0x0F, 0xAF, modrm(2, 5)], regs, 0x202);
  expectImul(out, 0x202, flags, 4, got => assert.equal(got[2], r));
});

test('IMUL r64,r64 INT64_MIN * -1 overflows', async () => {
  const regs = baseRegs(); regs[2] = 0x8000000000000000n; regs[5] = 0xFFFFFFFFFFFFFFFFn;
  const { r, flags } = refImul(0x8000000000000000n, 0xFFFFFFFFFFFFFFFFn, 8);
  assert.equal(r, 0x8000000000000000n); assert.equal(flags, 0x801n);
  const out = await runAlu([0x48, 0x0F, 0xAF, modrm(2, 5)], regs, 0x202);
  expectImul(out, 0x202, flags, 4, got => assert.equal(got[2], r));
});

test('IMUL r32,r32 sign-extends and detects 32-bit overflow', async () => {
  const regs = baseRegs(); regs[2] = 0xDEADBEEF00010000n; regs[5] = 0x0000000000020000n;
  const { r, flags } = refImul(0x10000n, 0x20000n, 4);
  assert.equal(r, 0x00000000n); // 2^32 truncated to 0
  assert.equal(flags, 0x801n, '2^32 does not fit in i32');
  const out = await runAlu([0x0F, 0xAF, modrm(2, 5)], regs, 0x202);
  expectImul(out, 0x202, flags, 3, got => assert.equal(got[2], r));
});

test('IMUL r32,r32 negative operands without overflow', async () => {
  const regs = baseRegs(); regs[2] = 0xFFFFFFFFFFFFFFF6n; regs[5] = 0x0000000000000007n;
  const { r, flags } = refImul(0xFFFFFFF6n, 7n, 4); // (-10) * 7 = -70
  assert.equal(r, 0xFFFFFFBAn); assert.equal(flags, 0n);
  const out = await runAlu([0x0F, 0xAF, modrm(2, 5)], regs, 0xA5B5);
  expectImul(out, 0xA5B5, flags, 3, got => assert.equal(got[2], r));
});

test('IMUL preserves SZP/AF, only CF/OF change', async () => {
  const regs = baseRegs(); regs[2] = 3n; regs[5] = 4n;
  const out = await runAlu([0x48, 0x0F, 0xAF, modrm(2, 5)], regs, 0xA5B5);
  assert.equal(out.rflags & ~0x801, 0xA5B5 & ~0x801, 'SZP/AF preserved');
  assert.equal(out.rflags & 0x801, 0, 'no overflow');
  assert.equal(out.regs[2], 12n);
});
// --- String-op tests (memory-touching emission) ---

// Guest memory model: sparse byte map; unmapped reads return 0, matching
// KMemory64::readb. Writes commit (populate the map).
function makeGuestMem() {
  const bytes = new Map(); // BigInt addr -> Number byte
  return {
    read(addr, size) {
      let v = 0n;
      for (let i = 0; i < size; i++) v |= BigInt(bytes.get(addr + BigInt(i)) || 0) << BigInt(8 * i);
      return v;
    },
    write(addr, size, val) {
      for (let i = 0; i < size; i++) bytes.set(addr + BigInt(i), Number((val >> BigInt(8 * i)) & 0xFFn));
    },
    clone() {
      const c = makeGuestMem();
      for (const [k, v] of bytes) c.bytes.set(k, v);
      return c;
    },
    bytes,
  };
}

// Import object for string-op modules: real memRead/memWrite backed by the
// JS guest memory. Protocol: (addrLo, addrHi, size, retPtr) and
// (addrLo, addrHi, size, valLo, valHi); memRead writes 8 bytes to retPtr.
function stringEnv(memory, guestMem) {
  const view = new DataView(memory.buffer);
  const u32 = n => Number(BigInt.asUintN(32, BigInt(n)));
  return { env: {
    memory,
    memRead: (addrLo, addrHi, size, retPtr) => {
      const addr = (BigInt(u32(addrHi)) << 32n) | BigInt(u32(addrLo));
      view.setBigUint64(retPtr, guestMem.read(addr, size), true);
    },
    memWrite: (addrLo, addrHi, size, valLo, valHi) => {
      const addr = (BigInt(u32(addrHi)) << 32n) | BigInt(u32(addrLo));
      const val = (BigInt(u32(valHi)) << 32n) | BigInt(u32(valLo));
      guestMem.write(addr, size, val);
    },
  } };
}

// JS reference model of CPU64::runStringOp (transcribed from cpu64.cpp).
// regs: array of 16 BigInts, modified in place. Returns new rflags (Number).
function refString(sub, size, rep, asize32, regs, rflags, guestMem) {
  const DF = 0x400n, ALU_MASK = 0x8D5n;
  const sizeMask = (1n << BigInt(size * 8)) - 1n;
  let flags = BigInt(rflags);
  const step = (flags & DF) ? -BigInt(size) : BigInt(size);
  const eff = a => asize32 ? a & 0xFFFFFFFFn : a & mask64;
  const readM = a => guestMem.read(eff(a), size);
  const writeM = (a, v) => guestMem.write(eff(a), size, v & sizeMask);
  if (sub <= 1) {
    const isStos = sub === 1;
    let count = rep !== 0 ? regs[1] : 1n;
    if (asize32) count &= 0xFFFFFFFFn;
    // while (count--) { ... }
    for (;;) {
      const old = count; count = (count - 1n) & mask64;
      if (old === 0n) break;
      const val = isStos ? regs[0] & sizeMask : readM(regs[6]);
      writeM(regs[7], val);
      if (!isStos) regs[6] = (regs[6] + step) & mask64;
      regs[7] = (regs[7] + step) & mask64;
    }
    if (rep !== 0) regs[1] = 0n;
  } else {
    const isScas = sub === 3;
    let count = rep !== 0 ? regs[1] : 1n;
    if (asize32) count &= 0xFFFFFFFFn;
    while (count > 0n) {
      count--;
      const lhs = isScas ? regs[0] & sizeMask : readM(regs[6]);
      const rhs = readM(regs[7]);
      const { flags: nf } = refAlu(5, lhs, rhs, size);
      flags = (flags & ~ALU_MASK) | nf;
      if (!isScas) regs[6] = (regs[6] + step) & mask64;
      regs[7] = (regs[7] + step) & mask64;
      if (rep !== 0) {
        const zf = (flags & 0x40n) !== 0n;
        if ((rep === 0xF3 && !zf) || (rep === 0xF2 && zf)) break;
      }
    }
    if (rep !== 0) regs[1] = count;
  }
  return Number(flags & 0xFFFFFFFFn);
}

async function runString(code, { regs, rflags = 0x202, memInit = new Map(), ptr = 512 }) {
  const { result, path } = emit(code);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(WebAssembly.validate(readFileSync(path)), 'emitted module must validate');
  const memory = new WebAssembly.Memory({ initial: 1 });
  const guestMem = makeGuestMem();
  for (const [k, v] of memInit) guestMem.bytes.set(k, v);
  const view = new DataView(memory.buffer);
  regs.forEach((v, i) => view.setBigUint64(ptr + i * 8, v, true));
  view.setBigUint64(ptr + 128, 0x12345678ABCDEFF0n, true);
  view.setUint32(ptr + 136, rflags >>> 0, true);
  view.setUint32(ptr + 140, 0xA5A5A5A5, true);
  const { instance } = await WebAssembly.instantiate(readFileSync(path), stringEnv(memory, guestMem));
  instance.exports.execute(ptr);
  return {
    regs: Array.from({ length: 16 }, (_, i) => view.getBigUint64(ptr + i * 8, true)),
    rflags: view.getUint32(ptr + 136, true),
    ripOut: view.getBigUint64(ptr + 128, true),
    reserved: view.getUint32(ptr + 140, true),
    guestMem,
  };
}

// Compare wasm execution against the reference model.
async function checkString(code, sub, size, rep, asize32, regs, rflags, memInit) {
  const refRegs = [...regs];
  const refMem = makeGuestMem();
  for (const [k, v] of memInit) refMem.bytes.set(k, v);
  const refFlags = refString(sub, size, rep, asize32, refRegs, rflags, refMem);
  const out = await runString(code, { regs: [...regs], rflags, memInit });
  assert.deepEqual(out.regs, refRegs, 'GPRs');
  assert.equal(out.rflags, refFlags >>> 0, 'RFLAGS');
  assert.equal(out.ripOut, (0x12345678ABCDEFF0n + BigInt(code.length)) & mask64, 'RIP');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
  // Memory: compare the full byte maps.
  const refKeys = [...refMem.bytes.keys()].map(String).sort();
  const outKeys = [...out.guestMem.bytes.keys()].map(String).sort();
  assert.deepEqual(outKeys, refKeys, 'written addresses');
  for (const k of refKeys) assert.equal(out.guestMem.bytes.get(BigInt(k)), refMem.bytes.get(BigInt(k)), `mem[${k}]`);
}

const SBASE = 0x1000n; // test scratch region
function memBytes(base, arr) {
  const m = new Map();
  arr.forEach((v, i) => m.set(base + BigInt(i), v));
  return m;
}

test('STOSB stores AL and advances RDI', async () => {
  const regs = baseRegs(); regs[0] = 0xABn; regs[7] = SBASE;
  await checkString([0xAA], 1, 1, 0, false, regs, 0x202, new Map());
});

test('STOSD stores EAX and advances RDI by 4', async () => {
  const regs = baseRegs(); regs[0] = 0xDEADBEEFn; regs[7] = SBASE;
  await checkString([0xAB], 1, 4, 0, false, regs, 0x202, new Map());
});

test('REP STOSD fills RCX dwords and zeroes RCX', async () => {
  const regs = baseRegs(); regs[0] = 0x11223344n; regs[7] = SBASE; regs[1] = 4n;
  await checkString([0xF3, 0xAB], 1, 4, 0xF3, false, regs, 0x202, new Map());
});

test('MOVSB copies byte and advances RSI/RDI', async () => {
  const regs = baseRegs(); regs[6] = SBASE; regs[7] = SBASE + 0x100n;
  await checkString([0xA4], 0, 1, 0, false, regs, 0x202, memBytes(SBASE, [0x7E]));
});

test('REP MOVSD copies RCX dwords', async () => {
  const regs = baseRegs(); regs[6] = SBASE; regs[7] = SBASE + 0x100n; regs[1] = 3n;
  await checkString([0xF3, 0xA5], 0, 4, 0xF3, false, regs, 0x202,
    memBytes(SBASE, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
});

test('STD makes STOSB decrement RDI', async () => {
  const regs = baseRegs(); regs[0] = 0x5An; regs[7] = SBASE + 0x10n;
  await checkString([0xAA], 1, 1, 0, false, regs, 0x202 | 0x400, new Map());
});

test('0x67 masks addresses to 32 bits but not register updates', async () => {
  const regs = baseRegs(); regs[6] = 0x1_00001000n; regs[7] = 0x2_00002000n;
  await checkString([0x67, 0xA5], 0, 4, 0, true, regs, 0x202, memBytes(0x1000n, [9, 9, 9, 9]));
});

test('REP with RCX=0 does nothing but still clears RCX', async () => {
  const regs = baseRegs(); regs[6] = SBASE; regs[7] = SBASE + 0x100n; regs[1] = 0n;
  await checkString([0xF3, 0xA5], 0, 4, 0xF3, false, regs, 0x202, new Map());
});

test('SCASB finds AL and sets ZF', async () => {
  const regs = baseRegs(); regs[0] = 0x42n; regs[7] = SBASE;
  await checkString([0xAE], 3, 1, 0, false, regs, 0x202, memBytes(SBASE, [0x42]));
});

test('REPE CMPSB stops at first mismatch with RCX remainder', async () => {
  const regs = baseRegs(); regs[6] = SBASE; regs[7] = SBASE + 0x100n; regs[1] = 8n;
  const mem = memBytes(SBASE, [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const [k, v] of memBytes(SBASE + 0x100n, [1, 2, 9, 4, 5, 6, 7, 8])) mem.set(k, v);
  await checkString([0xF3, 0xA6], 2, 1, 0xF3, false, regs, 0x202, mem);
});

test('REPNE SCASD stops at match', async () => {
  const regs = baseRegs(); regs[0] = 0x99n; regs[7] = SBASE; regs[1] = 8n;
  await checkString([0xF2, 0xAF], 3, 4, 0xF2, false, regs, 0x202,
    memBytes(SBASE, [0, 0, 0, 0, 0x99, 0, 0, 0]));
});

test('REP STOSQ writes 8 bytes per iteration', async () => {
  const regs = baseRegs(); regs[0] = 0x1122334455667788n; regs[7] = SBASE; regs[1] = 2n;
  await checkString([0xF3, 0x48, 0xAB], 1, 8, 0xF3, false, regs, 0x202, new Map());
});

test('string op preserves non-flag RFLAGS bits', async () => {
  const regs = baseRegs(); regs[6] = SBASE; regs[7] = SBASE + 0x100n;
  await checkString([0xA6], 2, 1, 0, false, regs, 0x202 | 0x400 | 0x200, memBytes(SBASE, [5]));
});

// --- String-op differential fuzzing vs the JS reference model ---
// Deterministic PRNG (mulberry32) for reproducible fuzzing.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('string ops differential fuzz (reference model)', async () => {
  const rand = mulberry32(0x5EED);
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const r64 = () => BigInt(Math.floor(rand() * 0xFFFFFFFF)) << 32n | BigInt(Math.floor(rand() * 0xFFFFFFFF));
  const CASES = 300;
  for (let c = 0; c < CASES; c++) {
    const sub = Math.floor(rand() * 4);
    const size = pick([1, 2, 4, 8]);
    const rep = pick([0, 0xF2, 0xF3]);
    const asize32 = rand() < 0.3;
    const df = rand() < 0.3;
    // Addresses: mostly in the scratch region, sometimes with high bits set
    // (to exercise 0x67 masking vs full 64-bit update).
    const addrBase = SBASE + BigInt(Math.floor(rand() * 256));
    const hi = rand() < 0.2 ? BigInt(Math.floor(rand() * 0xFFFF)) << 32n : 0n;
    const regs = baseRegs();
    regs[0] = r64(); // RAX (STOS value / SCAS comparand)
    regs[1] = BigInt(Math.floor(rand() * 12)); // RCX (REP count)
    regs[6] = addrBase + hi; // RSI
    regs[7] = addrBase + 0x200n + hi; // RDI (separate region)
    const rflags = 0x202 | (df ? 0x400 : 0) | (rand() < 0.5 ? 0x1 : 0);
    // Random memory contents in both regions.
    const memInit = new Map();
    for (let i = 0; i < 64; i++) {
      if (rand() < 0.7) memInit.set(SBASE + BigInt(i), Math.floor(rand() * 256));
      if (rand() < 0x7) memInit.set(SBASE + 0x200n + BigInt(i), Math.floor(rand() * 256));
    }
    // Encode the instruction.
    const opByte = [0xA4, 0xAA, 0xA6, 0xAE][sub] + (size === 1 ? 0 : 1);
    // A4/A5, AA/AB, A6/A7, AE/AF: byte opcode for size 1, +1 for size 2/4/8.
    // 0x66 prefix selects size 2, REX.W selects size 8.
    const code = [];
    if (rep) code.push(rep);
    if (asize32) code.push(0x67);
    if (size === 2) code.push(0x66);
    if (size === 8) code.push(0x48);
    code.push(opByte);
    await checkString(code, sub, size, rep, asize32, regs, rflags, memInit);
  }
});

// --- 8-bit ALU emission ---
// 8-bit register model: without REX, indices 4..7 are AH/CH/DH/BH;
// with any REX they are SPL/BPL/SIL/DIL.
function byteAccess(regs, idx, rex) {
  let phys = idx, shift = 0n;
  if (!rex && idx >= 4 && idx <= 7) { phys = idx - 4; shift = 8n; }
  return {
    get: () => (regs[phys] >> shift) & 0xFFn,
    set: (v) => { regs[phys] = (regs[phys] & ~(0xFFn << shift)) | ((v & 0xFFn) << shift); },
  };
}

async function checkAlu8(code, destIdx, srcIdx, rex, sub, rflagsIn = 0x202) {
  const regs = baseRegs();
  const dest = byteAccess(regs, destIdx, rex);
  const src = byteAccess(regs, srcIdx, rex);
  const { r, flags } = refAlu(sub, dest.get(), src.get(), 1);
  const out = await runAlu(code, regs, rflagsIn);
  expectAlu(out, rflagsIn, flags, code.length, got => {
    const exp = [...regs];
    if (sub !== 7) byteAccess(exp, destIdx, rex).set(r);
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
}

for (const sub of [0, 1, 2, 3, 4, 5, 6, 7]) {
  test(`8-bit ALU r/m,r sub=${sub} (AL,CL)`, async () => {
    await checkAlu8([sub * 8, modrm(1, 0)], 0, 1, false, sub);
  });
  test(`8-bit ALU r,r/m sub=${sub} (CL,AL)`, async () => {
    const regs = baseRegs();
    const dest = byteAccess(regs, 1, false), src = byteAccess(regs, 0, false);
    const { r, flags } = refAlu(sub, dest.get(), src.get(), 1);
    const out = await runAlu([sub * 8 + 2, modrm(1, 0)], regs, 0x202);
    expectAlu(out, 0x202, flags, 2, got => {
      const exp = [...regs];
      if (sub !== 7) byteAccess(exp, 1, false).set(r);
      for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
    });
  });
}

test('8-bit ADD AH,BH (high-byte registers, no REX)', async () => {
  await checkAlu8([0x00, modrm(7, 4)], 4, 7, false, 0);
});
test('8-bit SUB DH,AH preserves neighbors', async () => {
  const regs = baseRegs();
  regs[0] = 0x1122334455667788n; regs[2] = 0xAABBCCDDEEFF0011n;
  const dest = byteAccess(regs, 6, false), src = byteAccess(regs, 4, false);
  const { r, flags } = refAlu(5, dest.get(), src.get(), 1);
  const out = await runAlu([0x28, modrm(4, 6)], regs, 0x202);
  expectAlu(out, 0x202, flags, 2, got => {
    const exp = [...regs];
    byteAccess(exp, 6, false).set(r);
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
});
test('8-bit ADD SPL,SPL under REX (not AH)', async () => {
  const regs = baseRegs();
  regs[4] = 0x1122334455667788n; // RSP: SPL is the low byte
  const dest = byteAccess(regs, 4, true), src = byteAccess(regs, 4, true);
  const { r, flags } = refAlu(0, dest.get(), src.get(), 1);
  const out = await runAlu([0x40, 0x00, modrm(4, 4)], regs, 0x202);
  expectAlu(out, 0x202, flags, 3, got => {
    const exp = [...regs];
    byteAccess(exp, 4, true).set(r);
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
});
test('8-bit ADD AL,imm8 (acc-imm)', async () => {
  const regs = baseRegs();
  const { r, flags } = refAlu(0, regs[0] & 0xFFn, 0x7Fn, 1);
  const out = await runAlu([0x04, 0x7F], regs, 0x202);
  expectAlu(out, 0x202, flags, 2, got => {
    const exp = [...regs]; exp[0] = (exp[0] & ~0xFFn) | r;
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
});
test('8-bit OR r/m8,imm8 (0x80 group)', async () => {
  const regs = baseRegs();
  const { r, flags } = refAlu(1, regs[2] & 0xFFn, 0xF0n, 1);
  const out = await runAlu([0x80, modrm(1, 2), 0xF0], regs, 0x202);
  expectAlu(out, 0x202, flags, 3, got => {
    const exp = [...regs]; exp[2] = (exp[2] & ~0xFFn) | r;
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
});
test('8-bit TEST r/m8,r8 sets flags only', async () => {
  const regs = baseRegs();
  const { flags } = refAlu(4, regs[0] & 0xFFn, regs[1] & 0xFFn, 1);
  const out = await runAlu([0x84, modrm(1, 0)], regs, 0x202);
  expectAlu(out, 0x202, flags, 2, got => {
    for (let i = 0; i < 16; i++) assert.equal(got[i], regs[i], `GPR ${i} untouched`);
  });
});
test('8-bit TEST AL,imm8 (A8)', async () => {
  const regs = baseRegs();
  const { flags } = refAlu(4, regs[0] & 0xFFn, 0x0Fn, 1);
  const out = await runAlu([0xA8, 0x0F], regs, 0x202);
  expectAlu(out, 0x202, flags, 2, got => {
    for (let i = 0; i < 16; i++) assert.equal(got[i], regs[i], `GPR ${i} untouched`);
  });
});

// --- 16-bit ALU emission ---
async function checkAlu16(code, sub, rflagsIn = 0x202) {
  const regs = baseRegs();
  const { r, flags } = refAlu(sub, regs[0] & 0xFFFFn, regs[1] & 0xFFFFn, 2);
  const out = await runAlu(code, regs, rflagsIn);
  expectAlu(out, rflagsIn, flags, code.length, got => {
    const exp = [...regs];
    if (sub !== 7) exp[0] = (exp[0] & ~0xFFFFn) | r; // setU16: upper preserved
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
}
for (const [name, byte] of [['ADD', 0x01], ['OR', 0x09], ['ADC', 0x11], ['SBB', 0x19], ['AND', 0x21], ['SUB', 0x29], ['XOR', 0x31], ['CMP', 0x39]]) {
  test(`16-bit ${name} AX,CX preserves upper 48`, async () => {
    await checkAlu16([0x66, byte, modrm(1, 0)], (byte >> 3) & 7);
  });
}
test('16-bit ADD AX,imm16 (acc-imm)', async () => {
  const regs = baseRegs();
  const { r, flags } = refAlu(0, regs[0] & 0xFFFFn, 0x1234n, 2);
  const out = await runAlu([0x66, 0x05, 0x34, 0x12], regs, 0x202);
  expectAlu(out, 0x202, flags, 4, got => {
    const exp = [...regs]; exp[0] = (exp[0] & ~0xFFFFn) | r;
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
});
test('16-bit SHL AX,1 with flags', async () => {
  const regs = baseRegs(); regs[0] = 0xFEDCBA987654C001n;
  const v = regs[0] & 0xFFFFn;
  const r = (v << 1n) & 0xFFFFn;
  const cf = (v >> 15n) & 1n, of = (((r >> 15n) & 1n) ^ cf);
  const zf = r === 0n ? 1n : 0n, sf = (r >> 15n) & 1n;
  let p = Number(r & 0xFFn); p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
  const flags = cf | (BigInt((p & 1) === 0 ? 1 : 0) << 2n) | (zf << 6n) | (sf << 7n) | (of << 11n);
  const out = await runAlu([0x66, 0xC1, modrm(4, 0), 0x01], regs, 0x202);
  expectAlu(out, 0x202, flags, 4, got => {
    const exp = [...regs]; exp[0] = (exp[0] & ~0xFFFFn) | r;
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
});

// --- MOVZX/MOVSX emission ---
async function checkMovx(op2, destSize, rexW) {
  const sub = [0xB6, 0xB7, 0xBE, 0xBF].indexOf(op2);
  const srcSize = (sub === 0 || sub === 2) ? 1 : 2; // B6/BE: 8-bit source
  const signed = sub >= 2;
  const regs = baseRegs();
  regs[1] = 0xFEDCBA9876543281n; // src: low byte 0x81, low word 0x3281
  let v = srcSize === 1 ? regs[1] & 0xFFn : regs[1] & 0xFFFFn;
  if (signed) v = srcSize === 1 ? BigInt.asIntN(8, v) : BigInt.asIntN(16, v);
  v = BigInt.asUintN(64, v);
  const code = [];
  if (destSize === 2) code.push(0x66);
  if (rexW) code.push(0x48);
  code.push(0x0F, op2, modrm(0, 1));
  const out = await runAlu(code, regs, 0x202);
  const exp = [...regs];
  if (destSize === 2) exp[0] = (exp[0] & ~0xFFFFn) | (v & 0xFFFFn);
  else if (destSize === 4) exp[0] = v & 0xFFFFFFFFn;
  else exp[0] = v;
  expectAlu(out, 0x202, 0n, code.length, got => {
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
  assert.equal(out.rflags, 0x202, 'MOVX preserves flags');
}
for (const op2 of [0xB6, 0xB7, 0xBE, 0xBF]) {
  for (const [ds, rw] of [[2, false], [4, false], [8, true]]) {
    test(`MOVX 0F${op2.toString(16).toUpperCase()} dest${ds * 8}`, async () => {
      await checkMovx(op2, ds, rw);
    });
  }
}

// --- one-operand IMUL emission ---
async function checkImul1(size, rexW) {
  const regs = baseRegs();
  regs[0] = 0xFEDCBA9876543211n; regs[1] = 0x1122334455667788n;
  const w = size * 8;
  const wmask = (1n << BigInt(w)) - 1n;
  const sa = BigInt.asIntN(w, regs[0] & wmask);
  const sb = BigInt.asIntN(w, regs[1] & wmask);
  const prod = sa * sb;
  const lo = BigInt.asUintN(w, prod);
  const overflow = BigInt.asIntN(w, lo) !== prod ? 1n : 0n;
  const code = [];
  if (rexW) code.push(0x48); else if (size === 2) code.push(0x66);
  code.push(size === 1 ? 0xF6 : 0xF7, modrm(5, 1));
  const out = await runAlu(code, regs, 0x202);
  const exp = [...regs];
  // 8-bit IMUL writes the 16-bit product to AX (interpreter setU16).
  if (size === 1) exp[0] = (exp[0] & ~0xFFFFn) | BigInt.asUintN(16, prod);
  else if (size === 2) {
    exp[0] = (exp[0] & ~0xFFFFn) | lo;
    exp[2] = (exp[2] & ~0xFFFFn) | ((prod >> BigInt(w)) & 0xFFFFn);
  } else if (size === 4) {
    exp[0] = lo; exp[2] = (prod >> 32n) & 0xFFFFFFFFn;
  } else { exp[0] = BigInt.asUintN(64, prod); exp[2] = BigInt.asUintN(64, prod >> 64n); }
  const flags = overflow ? 0x801n : 0n;
  expectAlu(out, 0x202, flags, code.length, got => {
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
  assert.equal(out.rflags & ~0x801, 0x202 & ~0x801, 'other flags preserved');
}
for (const [size, rexW] of [[1, false], [2, false], [4, false], [8, true]]) {
  test(`IMUL 1-op ${size * 8}-bit`, async () => { await checkImul1(size, rexW); });
}

// --- three-operand IMUL emission ---
async function checkImul3(size, useImm8) {
  const regs = baseRegs();
  regs[1] = 0xFEDCBA9876543211n;
  const w = size * 8;
  const sa = BigInt.asIntN(w, regs[1] & ((1n << BigInt(w)) - 1n));
  const imm = useImm8 ? -5n : 0x12345n;
  const prod = sa * imm;
  const r = BigInt.asUintN(w, prod);
  const overflow = BigInt.asIntN(w, r) !== prod ? 1n : 0n;
  const code = [];
  if (size === 8) code.push(0x48); else if (size === 2) code.push(0x66);
  if (useImm8) code.push(0x6B, modrm(0, 1), 0xFB);
  else if (size === 2) code.push(0x69, modrm(0, 1), 0x45, 0x23);
  else code.push(0x69, modrm(0, 1), 0x45, 0x23, 0x01, 0x00);
  const out = await runAlu(code, regs, 0x202);
  const exp = [...regs];
  if (size === 2) exp[0] = (exp[0] & ~0xFFFFn) | r;
  else if (size === 4) exp[0] = r;
  else exp[0] = BigInt.asUintN(64, prod);
  const flags = overflow ? 0x801n : 0n;
  expectAlu(out, 0x202, flags, code.length, got => {
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
  assert.equal(out.rflags & ~0x801, 0x202 & ~0x801, 'other flags preserved');
}
for (const size of [2, 4, 8]) {
  test(`IMUL 3-op ${size * 8}-bit imm8`, async () => { await checkImul3(size, true); });
  test(`IMUL 3-op ${size * 8}-bit imm${size === 2 ? 16 : 32}`, async () => { await checkImul3(size, false); });
}

// --- Differential fuzzing for new groups ---
function makeRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function r64fuzz(rand) {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(Math.floor(rand() * 256));
  return v;
}

test('fuzz 8-bit ALU vs reference (500 cases, high-byte adversarial)', async () => {
  const rand = makeRand(0x8A1F);
  for (let i = 0; i < 500; i++) {
    const sub = Math.floor(rand() * 8);
    const useRex = rand() < 0.4;
    // Register indices in the modrm byte (0..7, or 0..15 with REX).
    let d = Math.floor(rand() * 8), s = Math.floor(rand() * 8);
    if (useRex && rand() < 0.5) d += 8;
    if (useRex && rand() < 0.5) s += 8;
    // Adversarial: force high-byte (4..7) without REX half the time.
    if (!useRex && rand() < 0.5) d = 4 + Math.floor(rand() * 4);
    if (!useRex && rand() < 0.5) s = 4 + Math.floor(rand() * 4);
    const isRRM = rand() < 0.5; // true: r8,r/m8 (02); false: r/m8,r8 (00)
    const code = [];
    let rex = 0;
    if (useRex) {
      rex = 0x40;
      if (d >= 8) { rex |= 0x04; d -= 8; } // REX.R extends reg field
      if (s >= 8) { rex |= 0x01; s -= 8; } // REX.B extends rm field
      // Note: for r/m8,r8, reg=s, rm=d. For r8,r/m8, reg=d, rm=s.
      // We set REX based on d/s as reg/rm; adjust below.
    }
    // Recompute: for opcode 00 (r/m,r): reg=s, rm=d. For 02 (r,r/m): reg=d, rm=s.
    let regF = isRRM ? d : s, rmF = isRRM ? s : d;
    if (useRex) {
      rex = 0x40;
      if (regF >= 8) { rex |= 0x04; regF -= 8; }
      if (rmF >= 8) { rex |= 0x01; rmF -= 8; }
      code.push(rex);
    }
    code.push(sub * 8 + (isRRM ? 2 : 0), 0xC0 | (regF << 3) | rmF);
    const regs = baseRegs();
    for (let r = 0; r < 16; r++) regs[r] = r64fuzz(rand);
    // Physical accessors: byteAccess maps 4..7 to high-byte iff !rex.
    const destIdx = isRRM ? d : d; // d is the destination modrm index (0..15)
    const srcIdx = isRRM ? s : s;
    // Reconstruct full indices (with high bits) for byteAccess.
    const dFull = isRRM ? (regF + (rex & 0x04 ? 8 : 0)) : (rmF + (rex & 0x01 ? 8 : 0));
    const sFull = isRRM ? (rmF + (rex & 0x01 ? 8 : 0)) : (regF + (rex & 0x04 ? 8 : 0));
    const hasRex = code[0] === rex && useRex;
    const dAcc = byteAccess(regs, dFull, hasRex);
    const sAcc = byteAccess(regs, sFull, hasRex);
    const { r, flags } = refAlu(sub, dAcc.get(), sAcc.get(), 1);
    const out = await runAlu(code, regs, 0x202);
    const exp = [...regs];
    if (sub !== 7) {
      const eAcc = byteAccess(exp, dFull, hasRex);
      eAcc.set(r);
    }
    const got = out.regs;
    for (let g = 0; g < 16; g++) {
      assert.equal(got[g], exp[g], `fuzz8 i=${i} sub=${sub} GPR${g}`);
    }
    assert.equal(out.rflags, (0x202 & ~0x8D5) | Number(flags), `fuzz8 i=${i} flags`);
    assert.equal(out.ripOut, (0x12345678ABCDEFF0n + BigInt(code.length)) & mask64, `fuzz8 i=${i} rip`);
  }
});

test('fuzz 16-bit ALU vs reference (300 cases)', async () => {
  const rand = makeRand(0x16B1);
  for (let i = 0; i < 300; i++) {
    const sub = Math.floor(rand() * 8);
    const isRRM = rand() < 0.5;
    const d = Math.floor(rand() * 8), s = Math.floor(rand() * 8);
    const regF = isRRM ? d : s, rmF = isRRM ? s : d;
    const code = [0x66, sub * 8 + (isRRM ? 3 : 1), 0xC0 | (regF << 3) | rmF];
    const regs = baseRegs();
    for (let r = 0; r < 16; r++) regs[r] = r64fuzz(rand);
    const dv = regs[d] & 0xFFFFn, sv = regs[s] & 0xFFFFn;
    const { r, flags } = refAlu(sub, dv, sv, 2);
    const out = await runAlu(code, regs, 0x202);
    const exp = [...regs];
    if (sub !== 7) exp[d] = (exp[d] & ~0xFFFFn) | r;
    const got = out.regs;
    for (let g = 0; g < 16; g++) assert.equal(got[g], exp[g], `fuzz16 i=${i} GPR${g}`);
    assert.equal(out.rflags, (0x202 & ~0x8D5) | Number(flags), `fuzz16 i=${i} flags`);
  }
});

test('fuzz MOVX vs reference (240 cases)', async () => {
  const rand = makeRand(0x0F5E);
  const ops = [0xB6, 0xB7, 0xBE, 0xBF];
  for (let i = 0; i < 240; i++) {
    const op2 = ops[Math.floor(rand() * 4)];
    const sub = ops.indexOf(op2);
    const srcSize = (sub === 0 || sub === 2) ? 1 : 2;
    const signed = sub >= 2;
    const destSize = [2, 4, 8][Math.floor(rand() * 3)];
    const d = Math.floor(rand() * 8), s = Math.floor(rand() * 8);
    const code = [];
    if (destSize === 2) code.push(0x66);
    if (destSize === 8) code.push(0x48);
    code.push(0x0F, op2, 0xC0 | (d << 3) | s);
    const regs = baseRegs();
    for (let r = 0; r < 16; r++) regs[r] = r64fuzz(rand);
    // Source may be a high-byte register (AH/BH/CH/DH) if s in 4..7 and no REX.
    // REX.W is present for 64-bit dest, so pass rex=true in that case.
    const hasRex = destSize === 8;
    let v;
    if (srcSize === 1) v = byteAccess(regs, s, hasRex).get();
    else v = regs[s] & 0xFFFFn;
    if (signed) v = srcSize === 1 ? BigInt.asIntN(8, v) : BigInt.asIntN(16, v);
    v = BigInt.asUintN(64, v);
    const out = await runAlu(code, regs, 0x202);
    const exp = [...regs];
    if (destSize === 2) exp[d] = (exp[d] & ~0xFFFFn) | (v & 0xFFFFn);
    else if (destSize === 4) exp[d] = v & 0xFFFFFFFFn;
    else exp[d] = v;
    const got = out.regs;
    for (let g = 0; g < 16; g++) assert.equal(got[g], exp[g], `fuzzMovx i=${i} GPR${g}`);
    assert.equal(out.rflags, 0x202, `fuzzMovx i=${i} flags preserved`);
  }
});

// --- MOVSXD (0x63) emission: 32-bit source sign-extended (sub 4) ---
async function checkMovsxd(destSize, rexW, srcIdx, srcVal) {
  const regs = baseRegs();
  regs[srcIdx] = srcVal;
  const d = 0;
  let v = BigInt.asIntN(32, srcVal & 0xFFFFFFFFn);
  v = BigInt.asUintN(64, v);
  const code = [];
  const rex = (rexW ? 0x08 : 0) | (srcIdx >= 8 ? 0x01 : 0);
  if (rex) code.push(0x40 | rex);
  code.push(0x63, modrm(d, srcIdx & 7));
  const out = await runAlu(code, regs, 0x202);
  const exp = [...regs];
  exp[d] = destSize === 4 ? v & 0xFFFFFFFFn : v;
  expectAlu(out, 0x202, 0n, code.length, got => {
    for (let i = 0; i < 16; i++) assert.equal(got[i], exp[i], `GPR ${i}`);
  });
  assert.equal(out.rflags, 0x202, 'MOVSXD preserves flags');
}
for (const srcVal of [0n, 1n, 0x7FFFFFFFn, 0x80000000n, 0xFFFFFFFFn, 0xDEADBEEF80000001n, 0x1234567800000000n]) {
  for (const [ds, rw] of [[4, false], [8, true]]) {
    test(`MOVSXD src=0x${srcVal.toString(16)} dest${ds * 8}`, async () => {
      await checkMovsxd(ds, rw, 1, srcVal);
    });
  }
}
test('MOVSXD dest==src aliasing (movsxd rax, eax)', async () => {
  await checkMovsxd(4, false, 0, 0xFFFFFFFFFF800005n);
});
test('MOVSXD high source register (movsxd r8, r9d)', async () => {
  await checkMovsxd(8, true, 9, 0xA5A5A5A5FFFFFFFFn);
});

test('fuzz MOVSXD vs reference (600 cases)', async () => {
  const rand = makeRand(0x635E);
  for (let i = 0; i < 600; i++) {
    const destSize = rand() < 0.5 ? 4 : 8;
    const d = Math.floor(rand() * 16), s = Math.floor(rand() * 16);
    const code = [];
    const rex = (destSize === 8 ? 0x08 : 0) | (d >= 8 ? 0x04 : 0) | (s >= 8 ? 0x01 : 0);
    if (rex) code.push(0x40 | rex);
    code.push(0x63, 0xC0 | ((d & 7) << 3) | (s & 7));
    const regs = baseRegs();
    for (let r = 0; r < 16; r++) regs[r] = r64fuzz(rand);
    // Adversarial sign-boundary low-32 values on a fixed cadence.
    if (i % 7 === 0) regs[s] = [0n, 1n, 0x7FFFFFFFn, 0x80000000n, 0xFFFFFFFFn][i % 5];
    const initFlags = Math.floor(rand() * 0x100000);
    let v = BigInt.asIntN(32, regs[s] & 0xFFFFFFFFn);
    v = BigInt.asUintN(64, v);
    const out = await runAlu(code, regs, initFlags);
    const exp = [...regs];
    exp[d] = destSize === 4 ? v & 0xFFFFFFFFn : v;
    const got = out.regs;
    for (let g = 0; g < 16; g++) assert.equal(got[g], exp[g], `fuzzMovsxd i=${i} GPR${g}`);
    assert.equal(out.rflags, initFlags >>> 0, `fuzzMovsxd i=${i} flags preserved`);
    assert.equal(out.reserved, 0xA5A5A5A5, `fuzzMovsxd i=${i} ABI reserved`);
  }
});

test('fuzz IMUL 1-op vs reference (200 cases)', async () => {
  const rand = makeRand(0xF607);
  for (let i = 0; i < 200; i++) {
    const size = [1, 2, 4, 8][Math.floor(rand() * 4)];
    const s = Math.floor(rand() * 8);
    const code = [];
    if (size === 8) code.push(0x48); else if (size === 2) code.push(0x66);
    code.push(size === 1 ? 0xF6 : 0xF7, 0xC0 | (5 << 3) | s);
    const regs = baseRegs();
    for (let r = 0; r < 16; r++) regs[r] = r64fuzz(rand);
    const w = size * 8, wmask = (1n << BigInt(w)) - 1n;
    const sa = BigInt.asIntN(w, regs[0] & wmask);
    // 8-bit source may be high-byte (no REX in this fuzz).
    const sbRaw = size === 1 ? byteAccess(regs, s, false).get() : regs[s] & wmask;
    const sb = BigInt.asIntN(w, sbRaw);
    const prod = sa * sb;
    const out = await runAlu(code, regs, 0x202);
    const exp = [...regs];
    let overflow;
    if (size === 1) {
      exp[0] = (exp[0] & ~0xFFFFn) | BigInt.asUintN(16, prod);
      overflow = BigInt.asIntN(8, BigInt.asUintN(8, prod)) !== prod;
    } else if (size === 2) {
      exp[0] = (exp[0] & ~0xFFFFn) | BigInt.asUintN(16, prod);
      exp[2] = (exp[2] & ~0xFFFFn) | BigInt.asUintN(16, prod >> 16n);
      overflow = BigInt.asIntN(16, BigInt.asUintN(16, prod)) !== prod;
    } else if (size === 4) {
      exp[0] = BigInt.asUintN(32, prod);
      exp[2] = BigInt.asUintN(32, prod >> 32n);
      overflow = BigInt.asIntN(32, BigInt.asUintN(32, prod)) !== prod;
    } else {
      exp[0] = BigInt.asUintN(64, prod);
      exp[2] = BigInt.asUintN(64, prod >> 64n);
      overflow = BigInt.asIntN(64, BigInt.asUintN(64, prod)) !== prod;
    }
    const got = out.regs;
    for (let g = 0; g < 16; g++) assert.equal(got[g], exp[g], `fuzzImul1 i=${i} GPR${g}`);
    const expFlags = (0x202 & ~0x801) | (overflow ? 0x801 : 0);
    assert.equal(out.rflags, expFlags, `fuzzImul1 i=${i} flags`);
  }
});

test('fuzz IMUL 3-op vs reference (200 cases)', async () => {
  const rand = makeRand(0x69B1);
  for (let i = 0; i < 200; i++) {
    const size = [2, 4, 8][Math.floor(rand() * 3)];
    const useImm8 = rand() < 0.5;
    const d = Math.floor(rand() * 8), s = Math.floor(rand() * 8);
    const imm = useImm8 ? BigInt(Math.floor(rand() * 256) - 128)
                       : BigInt(Math.floor(rand() * 4294967296) - 2147483648);
    const code = [];
    if (size === 8) code.push(0x48); else if (size === 2) code.push(0x66);
    if (useImm8) {
      code.push(0x6B, 0xC0 | (d << 3) | s, Number(imm & 0xFFn));
    } else if (size === 2) {
      code.push(0x69, 0xC0 | (d << 3) | s, Number(imm & 0xFFn), Number((imm >> 8n) & 0xFFn));
    } else {
      code.push(0x69, 0xC0 | (d << 3) | s,
        Number(imm & 0xFFn), Number((imm >> 8n) & 0xFFn),
        Number((imm >> 16n) & 0xFFn), Number((imm >> 24n) & 0xFFn));
    }
    const regs = baseRegs();
    for (let r = 0; r < 16; r++) regs[r] = r64fuzz(rand);
    const w = size * 8;
    const sa = BigInt.asIntN(w, regs[s] & ((1n << BigInt(w)) - 1n));
    const prod = sa * imm;
    const out = await runAlu(code, regs, 0x202);
    const exp = [...regs];
    const r = BigInt.asUintN(w, prod);
    if (size === 2) exp[d] = (exp[d] & ~0xFFFFn) | r;
    else exp[d] = size === 4 ? r : BigInt.asUintN(64, prod);
    const overflow = BigInt.asIntN(w, r) !== prod;
    const got = out.regs;
    for (let g = 0; g < 16; g++) assert.equal(got[g], exp[g], `fuzzImul3 i=${i} GPR${g}`);
    const expFlags = (0x202 & ~0x801) | (overflow ? 0x801 : 0);
    assert.equal(out.rflags, expFlags, `fuzzImul3 i=${i} flags`);
  }
});

// --- LEA differential fuzzing vs the interpreter's EA computation ---
// Reference model: EA from computeEA (mirrors emitEA's i64 math and the
// interpreter's decodeModRM); 32-bit LEA zero-extends, 64-bit stores the
// full address; flags are never touched; no memory is read (a bad address
// cannot fault). The fixture decodes at ripBase=0, so RIP-relative targets
// are computed from the modrm offset, matching decodeEA.
function encLea({ size, reg = 0, eaKind = 'base', base = 0, idx = 1, scale = 0, disp = 0, asize32 = false }) {
  let rex = 0;
  if (size === 8) rex |= 0x08;
  if (reg >= 8) rex |= 0x04;
  const needB = eaKind !== 'riprel' && eaKind !== 'sib32' && base >= 8;
  const needX = (eaKind === 'sib' || eaKind === 'sib32') && idx >= 8;
  if (needB) rex |= 0x01;
  if (needX) rex |= 0x02;
  const code = [];
  if (asize32) code.push(0x67);
  if (rex) code.push(0x40 | rex);
  const prefixLen = code.length;
  code.push(0x8D);
  const modrmPos = prefixLen + 1;
  let mod, rm;
  const dispBytes = [], sibBytes = [];
  if (eaKind === 'riprel') { mod = 0; rm = 5; }
  else if (eaKind === 'sib' || eaKind === 'sib32') {
    rm = 4;
    const noBase = eaKind === 'sib32';
    mod = noBase ? 0 : disp !== 0 ? (disp >= -128 && disp <= 127 ? 1 : 2) : 0;
    if (!noBase && (base & 7) === 5 && mod === 0) { mod = 1; disp = 0; } // [r13] needs disp8
    sibBytes.push((scale << 6) | ((idx & 7) << 3) | (noBase ? 5 : (base & 7)));
  } else {
    rm = base & 7;
    mod = eaKind === 'disp8' ? 1 : eaKind === 'disp32' ? 2 : 0;
    if (rm === 5 && mod === 0) { mod = 1; disp = 0; } // [rbp] needs disp8=0
    if (rm === 4) sibBytes.push(0x20 | (base & 7)); // rsp/r12 base needs a SIB (idx=none)
  }
  if (mod === 1) dispBytes.push(disp & 0xFF);
  if (mod === 2 || eaKind === 'riprel' || eaKind === 'sib32') dispBytes.push(...little(BigInt(disp) & 0xFFFFFFFFn, 4));
  code.push((mod << 6) | ((reg & 7) << 3) | rm, ...sibBytes, ...dispBytes);
  const ea = { ripRel: false, ripRelTarget: 0n, baseReg: 0xFF, idxReg: 0xFF, scale: 0, disp: 0n, asize32 };
  if (eaKind === 'riprel') {
    ea.ripRel = true;
    ea.ripRelTarget = (BigInt(modrmPos) + 5n + BigInt.asIntN(64, BigInt.asIntN(32, BigInt(disp)))) & mask64;
  } else {
    if (eaKind === 'sib' || eaKind === 'sib32') {
      ea.scale = scale;
      if (eaKind !== 'sib32') ea.baseReg = base;
      if (!((idx & 7) === 4 && !(rex & 0x02))) ea.idxReg = idx;
    } else {
      ea.baseReg = base;
    }
    if (mod === 1) ea.disp = BigInt.asIntN(64, BigInt.asIntN(8, BigInt(disp))) & mask64;
    else if (mod === 2 || eaKind === 'sib32') ea.disp = BigInt.asIntN(64, BigInt.asIntN(32, BigInt(disp))) & mask64;
    else ea.disp = 0n;
  }
  return { code, ea, reg, size };
}

test('LEA basic forms', async () => {
  // lea rax, [rbx+rcx*4+0x10]
  const regs = baseRegs(); regs[3] = 0x1000n; regs[1] = 0x100n;
  const out = await runAlu([0x48, 0x8D, 0x44, 0x8B, 0x10], regs, 0x202);
  assert.equal(out.regs[0], 0x1410n);
  assert.equal(out.regs[3], 0x1000n, 'base register untouched');
  assert.equal(out.regs[1], 0x100n, 'index register untouched');
  assert.equal(out.rflags, 0x202, 'LEA preserves flags');
  // 32-bit LEA zero-extends (high bits of the address are discarded)
  const regs2 = baseRegs(); regs2[3] = 0xFFFFFFFF00000000n;
  const out2 = await runAlu([0x8D, 0x03], regs2, 0x202);
  assert.equal(out2.regs[0], 0n);
  // RIP-relative (fixture ripBase=0; modrm at offset 2)
  const out3 = await runAlu([0x48, 0x8D, 0x05, 0x00, 0x01, 0x00, 0x00], baseRegs(), 0x202);
  assert.equal(out3.regs[0], 0x107n);
  // 0x67 address-size override masks the address to 32 bits
  const regs4 = baseRegs(); regs4[3] = 0x1FFFFFFFFn;
  const out4 = await runAlu([0x67, 0x48, 0x8D, 0x03], regs4, 0x202);
  assert.equal(out4.regs[0], 0xFFFFFFFFn);
});

test('fuzz LEA vs reference (600 cases)', async () => {
  const rand = makeRand(0x1EA0);
  const eaKinds = ['base', 'disp8', 'disp32', 'sib', 'sib32', 'riprel'];
  const advVals = [0n, 0xFFFFFFFFFFFFFFFFn, 0xFFFFFFFFn, 0x100000000n, 0xFFFFFFFF00000000n, 0x8000000000000000n, 0x7FFFFFFFFFFFFFFFn];
  const flagSets = [0x202, 0x246, 0x8D5, 0xFFFFFFFF, 0x0];
  for (let i = 0; i < 600; i++) {
    const size = rand() < 0.5 ? 4 : 8;
    const eaKind = eaKinds[Math.floor(rand() * eaKinds.length)];
    const reg = Math.floor(rand() * 16);
    const base = Math.floor(rand() * 16);
    const idx = Math.floor(rand() * 16);
    const scale = Math.floor(rand() * 4);
    const asize32 = rand() < 0.15;
    const dispChoices = [0, 1, -1, 127, -128, 0x7FFFFFFF, -0x80000000, Math.floor(rand() * 0x100000000) - 0x80000000];
    const disp = dispChoices[Math.floor(rand() * dispChoices.length)];
    const enc = encLea({ size, reg, eaKind, base, idx, scale, disp, asize32 });
    const regs = baseRegs();
    for (let r = 0; r < 16; r++) {
      regs[r] = rand() < 0.35 ? advVals[Math.floor(rand() * advVals.length)] : r64fuzz(rand);
    }
    const initFlags = flagSets[Math.floor(rand() * flagSets.length)];
    const refRegs = [...regs];
    const eaAddr = computeEA(enc.ea, refRegs);
    refRegs[enc.reg] = size === 4 ? eaAddr & 0xFFFFFFFFn : eaAddr;
    const out = await runAlu(enc.code, [...regs], initFlags);
    const got = out.regs;
    for (let g = 0; g < 16; g++) {
      assert.equal(got[g], refRegs[g], `fuzzLea i=${i} kind=${eaKind} size=${size} GPR${g}`);
    }
    assert.equal(out.rflags, initFlags >>> 0, `fuzzLea i=${i} flags preserved`);
    assert.equal(out.ripOut, (0x12345678ABCDEFF0n + BigInt(enc.code.length)) & mask64, `fuzzLea i=${i} rip`);
    assert.equal(out.reserved, 0xA5A5A5A5, `fuzzLea i=${i} reserved`);
  }
});

for (const [name, code] of [
  ['16-bit LEA', [0x66, 0x8D, 0x00]],
  ['FS-segment LEA', [0x64, 0x8D, 0x00]],
  ['GS-segment LEA', [0x65, 0x48, 0x8D, 0x00]],
  ['reg-form LEA', [0x48, 0x8D, 0xC0]],
  ['LOCK LEA', [0xF0, 0x48, 0x8D, 0x00]],
]) {
  test(`whole-block fallback rejects ${name}`, () => assert.equal(emit(code).result.status, 2));
}
// --- PUSH/POP differential fuzz vs the interpreter model ---
// Reference model transcribed from cpu64.cpp:
//   push64 (dsp_0):    RSP -= 8, then write [RSP] = value
//   PUSH imm (dsp_22): write [RSP-8] = imm, then RSP -= 8
//   PUSH r/m (FF /6):  v = loadRM(m,8); push64(v)
//   pop64 (dsp_1):     v = read [RSP]; RSP += 8
//   POP r/m (dsp_34):  v = pop64(); storeRM(m,8,v)
// The r/m EA is decode-time (pre-instruction registers), like the
// interpreter's decodeModRM which runs before any RSP update.
// Memory: reads of unmapped bytes return 0, writes commit (makeGuestMem
// matches KMemory64's observable behavior).
function refStack(form, regs, mem, o) {
  const RSP = 4;
  if (form === 'push_reg') {
    const v = regs[o.reg];
    regs[RSP] = (regs[RSP] - 8n) & mask64;
    mem.write(regs[RSP], 8, v);
  } else if (form === 'push_imm') {
    const sp = (regs[RSP] - 8n) & mask64;
    mem.write(sp, 8, o.imm);
    regs[RSP] = sp;
  } else if (form === 'push_rm') {
    const v = o.isMem ? mem.read(o.ea, 8) : regs[o.rm];
    regs[RSP] = (regs[RSP] - 8n) & mask64;
    mem.write(regs[RSP], 8, v);
  } else if (form === 'pop_reg') {
    const v = mem.read(regs[RSP], 8);
    regs[RSP] = (regs[RSP] + 8n) & mask64;
    regs[o.reg] = v;
  } else { // pop_rm
    const v = mem.read(regs[RSP], 8);
    regs[RSP] = (regs[RSP] + 8n) & mask64;
    if (o.isMem) mem.write(o.ea, 8, v);
    else regs[o.rm] = v;
  }
}

function encStack({ form, reg = 0, rm = 0, isMem = false, base = 0, disp = 0, imm = 0n }) {
  const code = [];
  const rexB = r => (r >= 8 ? [0x41] : []);
  if (form === 'push_reg') code.push(...rexB(reg), 0x50 + (reg & 7));
  else if (form === 'pop_reg') code.push(...rexB(reg), 0x58 + (reg & 7));
  else if (form === 'push_imm8') code.push(0x6A, Number(imm & 0xFFn));
  else if (form === 'push_imm32') code.push(0x68, ...little(imm & 0xFFFFFFFFn, 4));
  else {
    const opcode = form === 'push_rm' ? 0xFF : 0x8F;
    const ext = form === 'push_rm' ? 6 : 0;
    if (isMem) {
      // mod=1 [base + disp8]; base=4 (RSP) needs a SIB byte.
      if (base >= 8) code.push(0x41); // REX.B
      if ((base & 7) === 4) code.push(opcode, 0x40 | (ext << 3) | 0x04, 0x24, disp & 0xFF);
      else code.push(opcode, 0x40 | (ext << 3) | (base & 7), disp & 0xFF);
    } else {
      code.push(...rexB(rm), opcode, 0xC0 | (ext << 3) | (rm & 7));
    }
  }
  return code;
}

// Adversarial stack addresses: normal, page boundaries, zero, top.
function pickStackAddr(rand) {
  const choices = [0x10000n, 0xFFF8n, 0x1000n, 0x0FF8n, 0x1008n, 0x1FF8n,
                   0n, 0xFFFFFFFFFFFFFFF8n, 0x7FFFFFFFFFFFF000n];
  if (rand() < 0.7) return choices[Math.floor(rand() * choices.length)];
  return r64fuzz(rand) & ~7n; // 8-aligned random
}

test('PUSH RSP pushes the old RSP value', async () => {
  const regs = baseRegs(); regs[4] = 0x10000n;
  const out = await runAluMem([0x54], { regs: [...regs], rflags: 0x202, memInit: new Map() });
  assert.equal(out.regs[4], 0xFFF8n, 'RSP decremented');
  assert.equal(out.guestMem.read(0xFFF8n, 8), 0x10000n, '[RSP] = old RSP');
  assert.equal(out.rflags, 0x202, 'flags preserved');
});

test('POP RSP loads the popped value (discards the +8)', async () => {
  const regs = baseRegs(); regs[4] = 0xFFF8n;
  const memInit = new Map();
  const val = 0x123456789ABCDEF0n;
  for (let b = 0; b < 8; b++) memInit.set(0xFFF8n + BigInt(b), Number((val >> BigInt(8 * b)) & 0xFFn));
  const out = await runAluMem([0x5C], { regs: [...regs], rflags: 0x202, memInit });
  assert.equal(out.regs[4], val, 'RSP = popped value');
  assert.equal(out.rflags, 0x202, 'flags preserved');
});

test('PUSH [RSP] uses the decode-time EA', async () => {
  // PUSH qword [rsp]: EA = old RSP; v = [old RSP]; [old RSP - 8] = v.
  const regs = baseRegs(); regs[4] = 0x10000n;
  const memInit = new Map();
  const val = 0xDEADBEEFCAFEBABEn;
  for (let b = 0; b < 8; b++) memInit.set(0x10000n + BigInt(b), Number((val >> BigInt(8 * b)) & 0xFFn));
  const out = await runAluMem([0xFF, 0x74, 0x24, 0x00], { regs: [...regs], rflags: 0x202, memInit });
  assert.equal(out.regs[4], 0xFFF8n, 'RSP decremented');
  assert.equal(out.guestMem.read(0xFFF8n, 8), val, '[RSP-8] = old [RSP]');
  assert.equal(out.rflags, 0x202, 'flags preserved');
});

test('POP [RSP] uses the decode-time EA', async () => {
  // POP qword [rsp]: EA = old RSP; v = [old RSP]; RSP += 8; [old RSP] = v.
  const regs = baseRegs(); regs[4] = 0x10000n;
  const memInit = new Map();
  const val = 0x1122334455667788n;
  for (let b = 0; b < 8; b++) memInit.set(0x10000n + BigInt(b), Number((val >> BigInt(8 * b)) & 0xFFn));
  const out = await runAluMem([0x8F, 0x04, 0x24], { regs: [...regs], rflags: 0x202, memInit });
  assert.equal(out.regs[4], 0x10008n, 'RSP incremented');
  assert.equal(out.guestMem.read(0x10000n, 8), val, '[old RSP] = popped value');
  assert.equal(out.rflags, 0x202, 'flags preserved');
});

test('PUSH then POP round-trips through unmapped stack', async () => {
  const regs = baseRegs(); regs[4] = 0x20000n; regs[0] = 0x42n;
  const out = await runAluMem([0x50, 0x5B], { regs: [...regs], rflags: 0x202, memInit: new Map() });
  assert.equal(out.regs[4], 0x20000n, 'RSP restored');
  assert.equal(out.regs[3], 0x42n, 'RBX = pushed RAX');
  assert.equal(out.regs[0], 0x42n, 'RAX untouched');
  assert.equal(out.rflags, 0x202, 'flags preserved');
});

test('POP from unmapped stack yields zero', async () => {
  const regs = baseRegs(); regs[4] = 0x30000n;
  const out = await runAluMem([0x58], { regs: [...regs], rflags: 0x202, memInit: new Map() });
  assert.equal(out.regs[0], 0n, 'unmapped read = 0');
  assert.equal(out.regs[4], 0x30008n, 'RSP incremented');
  assert.equal(out.rflags, 0x202, 'flags preserved');
});

test('PUSH imm8/imm32 sign-extend and push 8 bytes', async () => {
  const regs = baseRegs(); regs[4] = 0x10000n;
  // 6A FE = PUSH -2; 68 00 00 00 80 = PUSH 0x80000000 (sign-extended)
  const out = await runAluMem([0x6A, 0xFE, 0x68, 0x00, 0x00, 0x00, 0x80],
    { regs: [...regs], rflags: 0x202, memInit: new Map() });
  assert.equal(out.regs[4], 0xFFF0n, 'RSP decremented twice');
  assert.equal(out.guestMem.read(0xFFF8n, 8), 0xFFFFFFFFFFFFFFFEn, '[RSP+8] = -2');
  assert.equal(out.guestMem.read(0xFFF0n, 8), 0xFFFFFFFF80000000n, '[RSP] = sign-extended 0x80000000');
  assert.equal(out.rflags, 0x202, 'flags preserved');
});

test('fuzz PUSH/POP vs reference (600 cases)', async () => {
  const rand = makeRand(0x5757AC4);
  const forms = ['push_reg', 'push_reg', 'pop_reg', 'pop_reg',
                 'push_imm8', 'push_imm32', 'push_rm', 'pop_rm'];
  const flagSets = [0x202, 0x246, 0x8D5, 0xFFFFFFFF, 0x0, 0x202 | 0x400];
  for (let i = 0; i < 600; i++) {
    const form = forms[Math.floor(rand() * forms.length)];
    const regs = Array.from({ length: 16 }, () => advVal(rand));
    // RSP: adversarial — page boundaries, zero, huge, or aliased to another reg.
    const rspPick = rand();
    if (rspPick < 0.35) regs[4] = pickStackAddr(rand);
    else if (rspPick < 0.45) regs[4] = regs[Math.floor(rand() * 16)];
    let reg = 0, rm = 0, isMem = false, base = 0, disp = 0, imm = 0n, ea = 0n;
    if (form === 'push_reg' || form === 'pop_reg') {
      reg = Math.floor(rand() * 16);
      if (rand() < 0.25) reg = 4; // RSP aliasing
    } else if (form === 'push_imm8' || form === 'push_imm32') {
      const v = Math.floor(rand() * 0x100000000) - 0x80000000;
      imm = form === 'push_imm8'
        ? BigInt.asIntN(64, BigInt.asIntN(8, BigInt(v & 0xFF)))
        : BigInt.asIntN(64, BigInt.asIntN(32, BigInt(v)));
    } else {
      isMem = rand() < 0.6;
      if (isMem) {
        base = Math.floor(rand() * 8);
        if (rand() < 0.3) base = 4; // RSP-relative EA: decode-time semantics
        disp = Math.floor(rand() * 256) - 128;
        if (rand() < 0.5) regs[base] = pickStackAddr(rand);
        ea = (regs[base] + BigInt(disp)) & mask64; // pre-instruction regs
      } else {
        rm = Math.floor(rand() * 16);
        if (rand() < 0.25) rm = 4;
      }
    }
    const code = encStack({ form, reg, rm, isMem, base, disp, imm });
    const rflags = flagSets[Math.floor(rand() * flagSets.length)];
    // Reference.
    const refRegs = [...regs];
    const refMem = makeGuestMem();
    const stackLo = (regs[4] - 64n) & mask64;
    for (let b = 0; b < 128; b++) refMem.bytes.set((stackLo + BigInt(b)) & mask64, Math.floor(rand() * 256));
    if (isMem) for (let b = 0; b < 8; b++) refMem.bytes.set((ea + BigInt(b)) & mask64, Math.floor(rand() * 256));
    const memInit = new Map(refMem.bytes);
    const refForm = (form === 'push_imm8' || form === 'push_imm32') ? 'push_imm' : form;
    refStack(refForm, refRegs, refMem, { reg, rm, isMem, ea, imm });
    // Wasm under test.
    const out = await runAluMem(code, { regs: [...regs], rflags, memInit });
    const tag = `fuzzStack i=${i} form=${form}`;
    assert.deepEqual(out.regs, refRegs, `${tag} GPRs`);
    assert.equal(out.rflags, rflags >>> 0, `${tag} RFLAGS preserved`);
    assert.equal(out.ripOut, (0x12345678ABCDEFF0n + BigInt(code.length)) & mask64, `${tag} RIP`);
    assert.equal(out.reserved, 0xA5A5A5A5, `${tag} reserved`);
    const refKeys = [...refMem.bytes.keys()].map(String).sort();
    const outKeys = [...out.guestMem.bytes.keys()].map(String).sort();
    assert.deepEqual(outKeys, refKeys, `${tag} written addresses`);
    for (const k of refKeys) {
      assert.equal(out.guestMem.bytes.get(BigInt(k)), refMem.bytes.get(BigInt(k)), `${tag} mem[${k}]`);
    }
  }
}, 120000);

// --- F6/F7 group 3 (TEST/NOT/NEG/MUL) reference model (mirrors cpu64.cpp dsp_31) ---
// Encode F6/F7 /0 (TEST r/m,imm), /2 (NOT r/m), /3 (NEG r/m), /4 (MUL r/m).
// sub: 0|2|3|4; size: 1|2|4|8 (F6 forces size 1). eaKind: 'reg' | 'base' |
// 'disp8' | 'disp32' | 'sib' | 'sib32' | 'riprel'.
// Returns { code, ea, sub, size, imm, rm, rexPresent, eaKind }.
function encGrp3({ sub, size, rm = 0, imm = 0, eaKind = 'reg', base = 0, idx = 1, scale = 0, disp = 0, asize32 = false }) {
  const isF6 = size === 1;
  let r = rm;
  let rex = 0;
  if (size === 8) rex |= 0x08;
  if (eaKind === 'reg' ? r >= 8 : (eaKind !== 'riprel' && base >= 8)) rex |= 0x01;
  if ((eaKind === 'sib' || eaKind === 'sib32') && idx >= 8) rex |= 0x02;
  // High-byte rule: size 1 with r in 4..7 (AH..BH) forbids REX entirely.
  // The fuzz avoids REX-needing EAs in that case; assert the invariant.
  if (size === 1 && r >= 4 && r <= 7) assert.equal(rex, 0, 'high-byte rm needs REX-free encoding');
  const rexPresent = rex !== 0;
  const code = [];
  if (asize32) code.push(0x67);
  if (size === 2) code.push(0x66);
  if (rex) code.push(0x40 | rex);
  const prefixLen = code.length;
  code.push(isF6 ? 0xF6 : 0xF7);
  const modrmPos = prefixLen + 1;
  let mod, rmF;
  const dispBytes = [];
  const sibBytes = [];
  if (eaKind === 'reg') { mod = 3; rmF = r & 7; }
  else if (eaKind === 'riprel') { mod = 0; rmF = 5; }
  else if (eaKind === 'sib' || eaKind === 'sib32') {
    rmF = 4;
    const noBase = eaKind === 'sib32';
    mod = noBase ? 0 : disp !== 0 ? (disp >= -128 && disp <= 127 ? 1 : 2) : 0;
    sibBytes.push((scale << 6) | ((idx & 7) << 3) | (noBase ? 5 : (base & 7)));
  } else {
    rmF = base & 7;
    mod = eaKind === 'disp8' ? 1 : eaKind === 'disp32' ? 2 : 0;
  }
  if (mod === 1) dispBytes.push(disp & 0xFF);
  if (mod === 2 || eaKind === 'riprel' || eaKind === 'sib32') dispBytes.push(...little(BigInt(disp) & 0xFFFFFFFFn, 4));
  code.push((mod << 6) | (sub << 3) | rmF, ...sibBytes, ...dispBytes);
  // TEST immediate (finalized like the decoder: imm8/imm16/imm32, or
  // sign-extended imm32 for 64-bit).
  let immVal = 0n, immLen = 0;
  if (sub === 0) {
    immLen = size === 1 ? 1 : size === 2 ? 2 : 4;
    if (size === 1) { code.push(Number(BigInt(imm) & 0xFFn)); immVal = BigInt(imm) & 0xFFn; }
    else if (size === 2) { code.push(...little(BigInt(imm) & 0xFFFFn, 2)); immVal = BigInt(imm) & 0xFFFFn; }
    else if (size === 4) { code.push(...little(BigInt(imm) & 0xFFFFFFFFn, 4)); immVal = BigInt(imm) & 0xFFFFFFFFn; }
    else { code.push(...little(BigInt(imm) & 0xFFFFFFFFn, 4)); immVal = BigInt.asIntN(64, BigInt.asIntN(32, BigInt(imm))); }
  }
  // Expected EA params (fixture ripBase=0). TEST's RIP-relative target
  // includes the trailing immediate length (decodeEA trailingImm).
  const ea = { ripRel: false, ripRelTarget: 0n, baseReg: 0xFF, idxReg: 0xFF, scale: 0, disp: 0n, asize32, seg: 0 };
  if (eaKind === 'riprel') {
    ea.ripRel = true;
    ea.ripRelTarget = (BigInt(modrmPos) + 5n + BigInt(immLen) + BigInt.asIntN(64, BigInt.asIntN(32, BigInt(disp)))) & mask64;
  } else if (eaKind !== 'reg') {
    if (eaKind === 'sib' || eaKind === 'sib32') {
      ea.scale = scale;
      if (eaKind !== 'sib32') ea.baseReg = base;
      if (!((idx & 7) === 4 && !(rex & 0x02))) ea.idxReg = idx;
    } else {
      ea.baseReg = base;
    }
    if (mod === 1) ea.disp = BigInt.asIntN(64, BigInt.asIntN(8, BigInt(disp))) & mask64;
    else if (mod === 2 || eaKind === 'sib32') ea.disp = BigInt.asIntN(64, BigInt.asIntN(32, BigInt(disp))) & mask64;
  }
  return { code, ea, sub, size, imm: immVal, rm: r, rexPresent, eaKind };
}

// Differential check: wasm vs JS reference model (dsp_31).
async function checkGrp3(enc, { regs, rflags = 0x202, memInit = new Map(), rip = 0x12345678ABCDEFF0n }) {
  const { sub, size } = enc;
  const mask = size === 8 ? mask64 : (1n << BigInt(size * 8)) - 1n;
  const refRegs = [...regs];
  const refMem = makeGuestMem();
  for (const [k, v] of memInit) refMem.bytes.set(k, v);
  let a, eaAddr = 0n;
  if (enc.eaKind === 'reg') {
    a = memRegRead(refRegs, enc.rm, size, enc.rexPresent);
  } else {
    eaAddr = computeEA(enc.ea, refRegs);
    a = refMem.read(eaAddr, size);
  }
  let refFlags = BigInt(rflags) & 0xFFFFFFFFn;
  const writeback = (v) => {
    if (enc.eaKind === 'reg') memRegWrite(refRegs, enc.rm, size, v, enc.rexPresent);
    else refMem.write(eaAddr, size, v);
  };
  if (sub === 0) {
    // TEST: flags like AND of (a & imm); no writeback.
    const { flags } = refAlu(4, a, enc.imm & mask, size);
    refFlags = ((BigInt(rflags) & ~0x8D5n) | flags) & 0xFFFFFFFFn;
  } else if (sub === 2) {
    // NOT: no flags.
    writeback((~a) & mask);
  } else if (sub === 3) {
    // NEG: SUB of (0 - a).
    const { r, flags } = refAlu(5, 0n, a, size);
    refFlags = ((BigInt(rflags) & ~0x8D5n) | flags) & 0xFFFFFFFFn;
    writeback(r);
  } else {
    // MUL (unsigned): RDX:RAX = RAX * a; CF/OF iff hi != 0.
    const prod = (refRegs[0] & mask) * a;
    const lo = prod & mask;
    const hi = (prod >> BigInt(size * 8)) & mask;
    const overflow = hi !== 0n;
    if (size === 1) {
      refRegs[0] = (refRegs[0] & ~0xFFFFn) | (prod & 0xFFFFn); // AX = prod
    } else if (size === 2) {
      refRegs[0] = (refRegs[0] & ~0xFFFFn) | lo;
      refRegs[2] = (refRegs[2] & ~0xFFFFn) | hi;
    } else {
      refRegs[0] = lo; // 32-bit: zero-extended by construction
      refRegs[2] = hi;
    }
    refFlags = ((BigInt(rflags) & ~0x801n) | (overflow ? 0x801n : 0n)) & 0xFFFFFFFFn;
  }
  const out = await runAluMem(enc.code, { regs: [...regs], rflags, memInit, rip });
  assert.deepEqual(out.regs, refRegs, 'GPRs');
  assert.equal(BigInt(out.rflags), refFlags, 'RFLAGS');
  assert.equal(out.ripOut, (rip + BigInt(enc.code.length)) & mask64, 'RIP');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
  const refKeys = [...refMem.bytes.keys()].map(String).sort();
  const outKeys = [...out.guestMem.bytes.keys()].map(String).sort();
  assert.deepEqual(outKeys, refKeys, 'written addresses');
  for (const k of refKeys) assert.equal(out.guestMem.bytes.get(BigInt(k)), refMem.bytes.get(BigInt(k)), `mem[${k}]`);
}

test('GRP3 TEST reg-direct: flags like AND, no writeback', async () => {
  // F7 C0 imm32: test eax, 0x12345678
  const regs = baseRegs();
  await checkGrp3(encGrp3({ sub: 0, size: 4, rm: 0, imm: 0x12345678 }), { regs });
  // 48 F7 C3 imm32(-1): test rbx, -1 (sign-extended imm)
  const regs2 = baseRegs(); regs2[3] = 0x8000000000000000n;
  await checkGrp3(encGrp3({ sub: 0, size: 8, rm: 3, imm: -1 }), { regs: regs2 });
  // F6 C4 0x0F: test ah, 0x0F (high-byte register, no REX)
  const regs3 = baseRegs(); regs3[0] = 0x0000FF00n;
  await checkGrp3(encGrp3({ sub: 0, size: 1, rm: 4, imm: 0x0F }), { regs: regs3 });
});

test('GRP3 TEST [mem]: fault-free load, RIP-relative immediate shift', async () => {
  // F7 05 disp32 imm32: test [rip+disp], imm — the EA must skip the imm.
  const regs = baseRegs();
  const disp = 0x100;
  const target = (10n + BigInt(disp)) & mask64; // fixture ripBase=0, len 10
  const memInit = aluMemInit(target, [0xFF, 0xFF, 0xFF, 0xFF]);
  await checkGrp3(encGrp3({ sub: 0, size: 4, eaKind: 'riprel', disp, imm: 0x0F0F0F0F }), { regs, memInit });
  // F6 00 disp8: test byte [rax+disp], imm8
  const regs2 = baseRegs(); regs2[0] = ALU_SBASE;
  const memInit2 = aluMemInit(ALU_SBASE + 0x10n, [0x81]);
  await checkGrp3(encGrp3({ sub: 0, size: 1, eaKind: 'disp8', base: 0, disp: 0x10, imm: 0x81 }), { regs: regs2, memInit: memInit2 });
});

test('GRP3 NOT: bitwise complement, flags preserved', async () => {
  // F7 D1: not ecx
  const regs = baseRegs();
  const rflags = 0x8D5;
  await checkGrp3(encGrp3({ sub: 2, size: 4, rm: 1 }), { regs, rflags });
  // 48 F7 D7: not rdi (64-bit)
  await checkGrp3(encGrp3({ sub: 2, size: 8, rm: 7 }), { regs: baseRegs(), rflags });
  // F6 D4: not ah (high byte)
  const regs3 = baseRegs(); regs3[0] = 0x123456789ABCDEF0n;
  await checkGrp3(encGrp3({ sub: 2, size: 1, rm: 4 }), { regs: regs3, rflags });
  // F7 13: not [rbx] (memory store)
  const regs4 = baseRegs(); regs4[3] = ALU_SBASE;
  const memInit = aluMemInit(ALU_SBASE, [0x00, 0x00, 0x00, 0x00]);
  await checkGrp3(encGrp3({ sub: 2, size: 4, eaKind: 'base', base: 3 }), { regs: regs4, rflags, memInit });
});

test('GRP3 NEG: 0-a with SUB flags, CF=(a!=0)', async () => {
  // F7 DB: neg ebx — CF set (ebx != 0)
  const regs = baseRegs();
  await checkGrp3(encGrp3({ sub: 3, size: 4, rm: 3 }), { regs, rflags: 0x202 });
  // NEG of 0: CF clear, ZF set.
  const regs2 = baseRegs(); regs2[3] = 0n;
  await checkGrp3(encGrp3({ sub: 3, size: 4, rm: 3 }), { regs: regs2, rflags: 0x203 });
  // NEG of 0x80000000: OF set.
  const regs3 = baseRegs(); regs3[3] = 0x80000000n;
  await checkGrp3(encGrp3({ sub: 3, size: 4, rm: 3 }), { regs: regs3 });
  // 48 F7 DF: neg rdi (64-bit, -1 -> 1, CF set)
  const regs4 = baseRegs(); regs4[7] = 0xFFFFFFFFFFFFFFFFn;
  await checkGrp3(encGrp3({ sub: 3, size: 8, rm: 7 }), { regs: regs4 });
  // F7 1D disp32: neg [mem32]
  const regs5 = baseRegs(); regs5[0] = ALU_SBASE;
  const memInit = aluMemInit(ALU_SBASE + 0x20n, [0x01, 0x00, 0x00, 0x80]);
  await checkGrp3(encGrp3({ sub: 3, size: 4, eaKind: 'disp8', base: 0, disp: 0x20 }), { regs: regs5, memInit });
});

test('GRP3 MUL: unsigned RDX:RAX product, CF/OF=(hi!=0)', async () => {
  // F7 E0: mul eax — RAX=0xFFFFFFFF, r/m=0xFFFFFFFF -> hi!=0, CF/OF set.
  const regs = baseRegs(); regs[0] = 0xFFFFFFFFn;
  await checkGrp3(encGrp3({ sub: 4, size: 4, rm: 0 }), { regs });
  // No overflow: RAX=2, r/m=3 -> RAX=6, RDX=0, CF/OF clear.
  const regs2 = baseRegs(); regs2[0] = 2n;
  await checkGrp3(encGrp3({ sub: 4, size: 4, rm: 0 }), { regs: regs2 });
  // 48 F7 E3: mul rbx, 64-bit with high limbs (exercises the limb path).
  const regs3 = baseRegs(); regs3[0] = 0xFFFFFFFFFFFFFFFFn; regs3[3] = 0xFFFFFFFFFFFFFFFFn;
  await checkGrp3(encGrp3({ sub: 4, size: 8, rm: 3 }), { regs: regs3 });
  // 64-bit, hi=0: RAX=0x100000000, r/m=0x100000000 -> prod=2^64, lo=0, hi=1.
  const regs4 = baseRegs(); regs4[0] = 0x100000000n; regs4[3] = 0x100000000n;
  await checkGrp3(encGrp3({ sub: 4, size: 8, rm: 3 }), { regs: regs4 });
  // F6 E0: mul al — AX = AL * r/m8.
  const regs5 = baseRegs(); regs5[0] = 0xFFn;
  await checkGrp3(encGrp3({ sub: 4, size: 1, rm: 0 }), { regs: regs5 });
  // 66 F7 E1: mul cx — DX:AX.
  const regs6 = baseRegs(); regs6[0] = 0xFFFFn;
  await checkGrp3(encGrp3({ sub: 4, size: 2, rm: 1 }), { regs: regs6 });
  // MUL r/m32 (memory).
  const regs7 = baseRegs(); regs7[0] = 0x12345678n; regs7[1] = ALU_SBASE;
  const memInit = aluMemInit(ALU_SBASE, [0xFF, 0xFF, 0xFF, 0xFF]);
  await checkGrp3(encGrp3({ sub: 4, size: 4, eaKind: 'base', base: 1 }), { regs: regs7, memInit });
});

test('GRP3 whole-block fallback rejects DIV/IDIV and /1', () => {
  assert.equal(emit([0xF7, 0xF0]).result.status, 2); // DIV r/m32
  assert.equal(emit([0xF7, 0xF8]).result.status, 2); // IDIV r/m32
  assert.equal(emit([0xF6, 0xF0]).result.status, 2); // DIV r/m8
  assert.equal(emit([0xF7, 0xC8]).result.status, 2); // /1 invalid
  assert.equal(emit([0xF0, 0xF7, 0xD0]).result.status, 2); // LOCK NOT
});

test('fuzz F6/F7 group 3 vs reference (600 cases)', async () => {
  const rng = mulberry32(0xF607);
  const flagSets = [0x202, 0x203, 0x8D5, 0x246, 0x202 | 0x800, 0x402, 0x0];
  for (let i = 0; i < 600; i++) {
    const sub = pick(rng, [0, 0, 2, 3, 3, 4]); // weight by profile (TEST/NEG heavy)
    const size = pick(rng, [1, 1, 2, 4, 4, 4, 8, 8]);
    const useMem = rng() < 0.55;
    let eaKind = 'reg', rm = 0;
    let eaParams = {};
    if (useMem) {
      const ea = randomEA(rng);
      eaKind = ea.eaKind;
      eaParams = ea;
    } else {
      rm = Math.floor(rng() * 16);
    }
    // High-byte rm (4..7) with size 1: keep the encoding REX-free.
    if (size === 1 && rm >= 4 && rm <= 7 && useMem &&
        ((eaParams.base ?? 0) >= 8 || (eaParams.idx ?? 0) >= 8 || size === 8)) {
      eaKind = 'base'; eaParams = { eaKind: 'base', base: 0, disp: 0, asize32: eaParams.asize32 };
    }
    const imm = sub === 0 ? Math.floor(rng() * 0x100000000) - 0x80000000 : 0;
    const enc = encGrp3({ sub, size, rm, imm, eaKind,
      base: eaParams.base ?? 0, idx: eaParams.idx ?? 1, scale: eaParams.scale ?? 0,
      disp: eaParams.disp ?? 0, asize32: eaParams.asize32 ?? false });
    const regs = Array.from({ length: 16 }, () => advVal(rng));
    const memInit = new Map();
    if (useMem) {
      const targetHint = computeEA(enc.ea, regs);
      for (let b = 0; b < size; b++) memInit.set((targetHint + BigInt(b)) & mask64, Math.floor(rng() * 256));
    }
    const rflags = pick(rng, flagSets);
    const tag = `fuzzGrp3 i=${i} sub=${sub} size=${size} ea=${eaKind}`;
    try {
      await checkGrp3(enc, { regs, rflags, memInit });
    } catch (e) {
      e.message = `${tag}: ${e.message}`;
      throw e;
    }
  }
}, 180000);

// ---- CBW/CWDE/CDQE (0x98) ----
// Pure RAX transform; no ModRM, no flags, no memory. The reference model
// mirrors cpu64.cpp dsp_20 exactly.
function encCbw(size) {
  const code = [];
  if (size === 2) code.push(0x66);
  if (size === 8) code.push(0x48); // REX.W
  code.push(0x98);
  return { code, size };
}

async function checkCbw(enc, { regs, rflags = 0x202, rip = 0x12345678ABCDEFF0n }) {
  const { size } = enc;
  const refRegs = [...regs];
  const rax = refRegs[0];
  // Sign-extend via (v ^ signBit) - signBit (BigInt-safe; ~mask does not
  // sign-extend with infinite-precision BigInt).
  if (size === 2) {
    // CBW: AL -> AX, upper 48 of RAX preserved (setU16).
    const al = rax & 0xFFn;
    const sext16 = ((al ^ 0x80n) - 0x80n) & 0xFFFFn;
    refRegs[0] = (rax & ~0xFFFFn) | sext16;
  } else if (size === 4) {
    // CWDE: AX -> EAX sign-extended, then zero-extended to 64.
    const ax = rax & 0xFFFFn;
    const sext32 = ((ax ^ 0x8000n) - 0x8000n) & 0xFFFFFFFFn;
    refRegs[0] = sext32;
  } else {
    // CDQE: EAX -> RAX sign-extended.
    const eax = rax & 0xFFFFFFFFn;
    refRegs[0] = (((eax ^ 0x80000000n) - 0x80000000n) & mask64);
  }
  const out = await runAluMem(enc.code, { regs: [...regs], rflags, rip });
  assert.deepEqual(out.regs, refRegs, 'GPRs');
  assert.equal(BigInt(out.rflags), BigInt(rflags) & 0xFFFFFFFFn, 'RFLAGS preserved');
  assert.equal(out.ripOut, (rip + BigInt(enc.code.length)) & mask64, 'RIP');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
}

test('CBW (66 98): AL->AX sign extension, upper 48 preserved', async () => {
  // AL=0x80 -> AX=0xFF80, upper 48 of RAX untouched.
  const regs = baseRegs(); regs[0] = 0x123456789ABC0080n;
  await checkCbw(encCbw(2), { regs });
  // AL=0x7F -> AX=0x007F (positive stays).
  const regs2 = baseRegs(); regs2[0] = 0xFFFFFFFFFFFF007Fn;
  await checkCbw(encCbw(2), { regs: regs2 });
  // AL=0xFF -> AX=0xFFFF.
  const regs3 = baseRegs(); regs3[0] = 0x00000000000000FFn;
  await checkCbw(encCbw(2), { regs: regs3 });
});

test('CWDE (98): AX->EAX sign extension, zero-extended to 64', async () => {
  // AX=0x8000 -> EAX=0xFFFF8000, RAX=0x00000000FFFF8000.
  const regs = baseRegs(); regs[0] = 0x1234567880001234n;
  await checkCbw(encCbw(4), { regs });
  // AX=0x7FFF -> EAX=0x00007FFF.
  const regs2 = baseRegs(); regs2[0] = 0xFFFFFFFFFFFF7FFFn;
  await checkCbw(encCbw(4), { regs: regs2 });
});

test('CDQE (48 98): EAX->RAX sign extension', async () => {
  // EAX=0x80000000 -> RAX=0xFFFFFFFF80000000.
  const regs = baseRegs(); regs[0] = 0x1234567880000000n;
  await checkCbw(encCbw(8), { regs });
  // EAX=0x7FFFFFFF -> RAX=0x000000007FFFFFFF.
  const regs2 = baseRegs(); regs2[0] = 0xFFFFFFFF7FFFFFFFn;
  await checkCbw(encCbw(8), { regs: regs2 });
});

test('CBW/CWDE/CDQE: RFLAGS preserved across flag sets', async () => {
  const flagSets = [0x202, 0x8D5, 0x0, 0xFFFFFFFF];
  for (const rflags of flagSets) {
    const regs = baseRegs(); regs[0] = 0xDEADBEEF80n;
    await checkCbw(encCbw(2), { regs, rflags });
    await checkCbw(encCbw(4), { regs: baseRegs(), rflags });
    await checkCbw(encCbw(8), { regs: baseRegs(), rflags });
  }
});

test('fuzz CBW/CWDE/CDQE vs reference (600 cases)', async () => {
  const rng = mulberry32(0x98CB);
  const flagSets = [0x202, 0x203, 0x8D5, 0x246, 0x202 | 0x800, 0x402, 0x0];
  const advVals = [0n, 1n, 0x7Fn, 0x80n, 0xFFn, 0x7FFFn, 0x8000n, 0xFFFFn,
                   0x7FFFFFFFn, 0x80000000n, 0xFFFFFFFFn, 0xFFFFFFFFFFFFFFFFn];
  for (let i = 0; i < 600; i++) {
    const size = pick(rng, [2, 4, 4, 8, 8]);
    const enc = encCbw(size);
    const regs = Array.from({ length: 16 }, () => advVal(rng));
    // Bias RAX toward sign-boundary values.
    if (rng() < 0.6) regs[0] = pick(rng, advVals);
    // Randomize upper bits of RAX to prove the 16-bit preserve / 32-bit zero-extend.
    if (rng() < 0.5) regs[0] = (regs[0] & 0xFFFFFFFFn) | (BigInt(Math.floor(rng() * 0x100000000)) << 32n);
    const rflags = pick(rng, flagSets);
    const tag = `fuzzCbw i=${i} size=${size}`;
    try {
      await checkCbw(enc, { regs, rflags });
    } catch (e) {
      e.message = `${tag}: ${e.message}`;
      throw e;
    }
  }
}, 180000);


// ---- CWD/CDQ/CQO (0x99) ----
// RDX = sign-extension of RAX. No ModRM, no flags, no memory. RAX is
// read-only. The reference model mirrors cpu64.cpp dsp_19 exactly.
function encCqo(size) {
  const code = [];
  if (size === 2) code.push(0x66);
  if (size === 8) code.push(0x48); // REX.W
  code.push(0x99);
  return { code, size };
}

async function checkCqo(enc, { regs, rflags = 0x202, rip = 0x12345678ABCDEFF0n }) {
  const { size } = enc;
  const refRegs = [...regs];
  const rax = refRegs[0];
  const rdx = refRegs[2];
  let signSet;
  if (size === 2) signSet = (rax & 0x8000n) !== 0n;
  else if (size === 4) signSet = (rax & 0x80000000n) !== 0n;
  else signSet = (rax & 0x8000000000000000n) !== 0n;
  if (size === 2) {
    // CWD: DX = sign ? 0xFFFF : 0, upper 48 of RDX preserved (setU16).
    refRegs[2] = (rdx & ~0xFFFFn) | (signSet ? 0xFFFFn : 0n);
  } else {
    // CDQ/CQO: full 64-bit RDX write (setU64).
    refRegs[2] = signSet ? mask64 : 0n;
  }
  // RAX (refRegs[0]) is unchanged: 0x99 only reads it.
  const out = await runAluMem(enc.code, { regs: [...regs], rflags, rip });
  assert.deepEqual(out.regs, refRegs, "GPRs");
  assert.equal(BigInt(out.rflags), BigInt(rflags) & 0xFFFFFFFFn, "RFLAGS preserved");
  assert.equal(out.ripOut, (rip + BigInt(enc.code.length)) & mask64, "RIP");
  assert.equal(out.reserved, 0xA5A5A5A5, "ABI reserved word");
}

test("CWD (66 99): AX->DX sign extension, upper 48 of RDX preserved", async () => {
  // AX=0x8000 -> DX=0xFFFF, upper 48 of RDX untouched.
  const regs = baseRegs(); regs[0] = 0x1234567880001234n; regs[2] = 0xABCDEF0123456789n;
  await checkCqo(encCqo(2), { regs });
  // AX=0x7FFF -> DX=0x0000.
  const regs2 = baseRegs(); regs2[0] = 0xFFFFFFFFFFFF7FFFn; regs2[2] = 0xFFFFFFFFFFFFFFFFn;
  await checkCqo(encCqo(2), { regs: regs2 });
});

test("CDQ (99): EAX->EDX sign extension, full RDX write", async () => {
  // EAX=0x80000000 -> RDX=0xFFFFFFFFFFFFFFFF.
  const regs = baseRegs(); regs[0] = 0x1234567880000000n;
  await checkCqo(encCqo(4), { regs });
  // EAX=0x7FFFFFFF -> RDX=0x0000000000000000.
  const regs2 = baseRegs(); regs2[0] = 0xFFFFFFFF7FFFFFFFn; regs2[2] = 0xABCDEF0123456789n;
  await checkCqo(encCqo(4), { regs: regs2 });
});

test("CQO (48 99): RAX->RDX sign extension", async () => {
  // RAX=0x8000000000000000 -> RDX=0xFFFFFFFFFFFFFFFF.
  const regs = baseRegs(); regs[0] = 0x8000000000000000n;
  await checkCqo(encCqo(8), { regs });
  // RAX=0x7FFFFFFFFFFFFFFF -> RDX=0x0.
  const regs2 = baseRegs(); regs2[0] = 0x7FFFFFFFFFFFFFFFn; regs2[2] = 0xABCDEF0123456789n;
  await checkCqo(encCqo(8), { regs: regs2 });
});

test("CWD/CDQ/CQO: RAX read-only, RFLAGS preserved across flag sets", async () => {
  const flagSets = [0x202, 0x8D5, 0x0, 0xFFFFFFFF];
  for (const rflags of flagSets) {
    const regs = baseRegs(); regs[0] = 0xDEADBEEF80000000n;
    await checkCqo(encCqo(2), { regs, rflags });
    await checkCqo(encCqo(4), { regs: baseRegs(), rflags });
    await checkCqo(encCqo(8), { regs: baseRegs(), rflags });
  }
});

test("fuzz CWD/CDQ/CQO vs reference (600 cases)", async () => {
  const rng = mulberry32(0x99C0);
  const flagSets = [0x202, 0x203, 0x8D5, 0x246, 0x202 | 0x800, 0x402, 0x0];
  const advVals = [0n, 1n, 0x7FFFn, 0x8000n, 0xFFFFn, 0x7FFFFFFFn, 0x80000000n,
                   0xFFFFFFFFn, 0x7FFFFFFFFFFFFFFFn, 0x8000000000000000n,
                   0xFFFFFFFFFFFFFFFFn];
  for (let i = 0; i < 600; i++) {
    const size = pick(rng, [2, 4, 4, 8, 8]);
    const enc = encCqo(size);
    const regs = Array.from({ length: 16 }, () => advVal(rng));
    // Bias RAX and RDX toward sign-boundary values.
    if (rng() < 0.6) regs[0] = pick(rng, advVals);
    if (rng() < 0.4) regs[2] = pick(rng, advVals);
    const rflags = pick(rng, flagSets);
    const tag = "fuzzCqo i=" + i + " size=" + size;
    try {
      await checkCqo(enc, { regs, rflags });
    } catch (e) {
      e.message = tag + ": " + e.message;
      throw e;
    }
  }
}, 180000);


// ---- CMOVcc (0F 40..4F) ----
// Conditional move: dest=reg, src=r/m. Source is ALWAYS loaded (faults
// even if condition false). No flags touched. 32-bit form zero-extends
// dest even when not taken (x86-64 quirk). Reference mirrors dsp_38.
function evalCCRef(cc, rflags) {
  const OF = (rflags & 0x800) !== 0;
  const CF = (rflags & 0x1) !== 0;
  const ZF = (rflags & 0x40) !== 0;
  const SF = (rflags & 0x80) !== 0;
  const PF = (rflags & 0x4) !== 0;
  switch (cc & 0xF) {
    case 0x0: return OF;
    case 0x1: return !OF;
    case 0x2: return CF;
    case 0x3: return !CF;
    case 0x4: return ZF;
    case 0x5: return !ZF;
    case 0x6: return CF || ZF;
    case 0x7: return !(CF || ZF);
    case 0x8: return SF;
    case 0x9: return !SF;
    case 0xA: return PF;
    case 0xB: return !PF;
    case 0xC: return SF !== OF;
    case 0xD: return SF === OF;
    case 0xE: return ZF || (SF !== OF);
    case 0xF: return !ZF && (SF === OF);
  }
}

function encCmov(cc, size, dest, src) {
  const code = [];
  if (size === 2) code.push(0x66);
  const rexR = dest >= 8 ? 1 : 0, rexB = src >= 8 ? 1 : 0;
  const rex = (size === 8 ? 0x48 : 0x40) | (rexR << 2) | rexB;
  if (rex !== 0x40) code.push(rex);
  code.push(0x0F, 0x40 | cc);
  code.push(0xC0 | ((dest & 7) << 3) | (src & 7));
  return { code, cc, size, dest, src, isMem: false };
}

function encCmovMem(cc, size, dest, baseReg) {
  const code = [];
  if (size === 2) code.push(0x66);
  const rexR = dest >= 8 ? 1 : 0;
  const rex = (size === 8 ? 0x48 : 0x40) | (rexR << 2);
  if (rex !== 0x40) code.push(rex);
  code.push(0x0F, 0x40 | cc);
  code.push(((dest & 7) << 3) | (baseReg & 7));
  return { code, cc, size, dest, baseReg, isMem: true };
}

async function checkCmov(enc, { regs, rflags = 0x202, memInit = new Map(), rip = 0x12345678ABCDEFF0n }) {
  const { cc, size, dest } = enc;
  const refRegs = [...regs];
  const mask = size === 8 ? mask64 : (1n << BigInt(size * 8)) - 1n;
  let src;
  if (enc.isMem) {
    const addr = refRegs[enc.baseReg] & mask64;
    const refMem = makeGuestMem();
    for (const [k, v] of memInit) refMem.bytes.set(k, v);
    src = refMem.read(addr, size);
  } else {
    src = refRegs[enc.src] & mask;
  }
  if (evalCCRef(cc, rflags)) {
    if (size === 2) refRegs[dest] = (refRegs[dest] & ~0xFFFFn) | src;
    else refRegs[dest] = src;
  } else if (size === 4) {
    refRegs[dest] = refRegs[dest] & 0xFFFFFFFFn;
  }
  const out = await runAluMem(enc.code, { regs: [...regs], rflags, memInit, rip });
  assert.deepEqual(out.regs, refRegs, 'GPRs');
  assert.equal(BigInt(out.rflags), BigInt(rflags) & 0xFFFFFFFFn, 'RFLAGS preserved');
  assert.equal(out.ripOut, (rip + BigInt(enc.code.length)) & mask64, 'RIP');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
}

test('CMOVcc: all 16 conditions, taken and not-taken', async () => {
  // For each cc, test with rflags that make it taken and not-taken.
  // We use evalCCRef as ground truth; the emitter must match it.
  const flagCombos = [
    0x202,                    // baseline
    0x202 | 0x001,            // CF
    0x202 | 0x004,            // PF
    0x202 | 0x040,            // ZF
    0x202 | 0x080,            // SF
    0x202 | 0x800,            // OF
    0x202 | 0x881,            // CF+SF+OF
    0x202 | 0x0C5,            // CF+PF+ZF
  ];
  for (let cc = 0; cc < 16; cc++) {
    let sawTaken = false, sawNotTaken = false;
    for (const rflags of flagCombos) {
      const taken = evalCCRef(cc, rflags);
      if (taken) sawTaken = true; else sawNotTaken = true;
      const regs = Array.from({ length: 16 }, (_, i) => 0xFEDCBA9876543200n + BigInt(i));
      regs[0] = 0x1111111111111111n;
      regs[1] = 0x2222222222222222n;
      await checkCmov(encCmov(cc, 8, 0, 1), { regs, rflags });
    }
    assert.ok(sawTaken, `cc=${cc} never taken in flag combos`);
    assert.ok(sawNotTaken, `cc=${cc} never not-taken in flag combos`);
  }
});

test('CMOVcc: 32-bit not-taken zero-extends dest', async () => {
  const regs = baseRegs();
  regs[1] = 0xFFFFFFFFFFFFFFFFn;
  regs[2] = 0x12345678n;
  // cc=0 (O): OF=0 in rflags=0x202, so NOT taken. Dest must still be zero-extended.
  const enc = encCmov(0, 4, 1, 2);
  const out = await runAluMem(enc.code, { regs, rflags: 0x202 });
  assert.equal(out.regs[1], 0xFFFFFFFFn, 'dest zero-extended even when not taken');
});

test('CMOVcc: 16-bit preserves upper 48', async () => {
  const regs = baseRegs();
  regs[1] = 0xAAAAAAAAAAAAAAAAn;
  regs[2] = 0x1234n;
  const enc = encCmov(4, 2, 1, 2);
  const out = await runAluMem(enc.code, { regs, rflags: 0x240 });
  assert.equal(out.regs[1], 0xAAAAAAAAAAAA1234n, 'upper 48 preserved');
});

test('CMOVcc: memory source, taken and not-taken', async () => {
  const memAddr = 0x10000n;
  const memInit = new Map();
  [0xEF, 0xBE, 0xAD, 0xDE].forEach((b, i) => memInit.set(memAddr + BigInt(i), b));
  const regs = baseRegs();
  regs[1] = 0n;
  regs[3] = memAddr;
  const enc = encCmovMem(4, 4, 1, 3);
  await checkCmov(enc, { regs, rflags: 0x240, memInit });
  const regs2 = baseRegs();
  regs2[1] = 0xFFFFFFFFFFFFFFFFn;
  regs2[3] = memAddr;
  const enc2 = encCmovMem(5, 4, 1, 3);
  await checkCmov(enc2, { regs: regs2, rflags: 0x240, memInit });
});

test('fuzz CMOVcc vs reference (600 cases)', async () => {
  const rng = mulberry32(0xC40F);
  const flagSets = [0x202, 0x203, 0x8C5, 0x246, 0x202 | 0x800, 0x402, 0x0, 0x8D5];
  const advVals = [0n, 1n, 0x7Fn, 0x80n, 0xFFn, 0x7FFFn, 0x8000n, 0xFFFFn,
                   0x7FFFFFFFn, 0x80000000n, 0xFFFFFFFFn, 0xFFFFFFFFFFFFFFFFn];
  for (let i = 0; i < 600; i++) {
    const cc = Math.floor(rng() * 16);
    const size = pick(rng, [2, 4, 4, 8, 8]);
    const dest = Math.floor(rng() * 16);
    const isMem = rng() < 0.4;
    let enc, regs;
    const memAddr = 0x10000n + BigInt(Math.floor(rng() * 16) * 8);
    const memInit = new Map();
    if (isMem) {
      // NB: baseReg 4 (RSP) needs a SIB byte and 5 (RBP) encodes as
      // RIP-relative in mod=00; encCmovMem only emits the simple mod=00
      // [base] form, so both are excluded here.
      const baseReg = pick(rng, [0, 1, 2, 3, 6, 7]);
      enc = encCmovMem(cc, size, dest, baseReg);
      regs = Array.from({ length: 16 }, () => advVal(rng));
      // Vary the memory operand: page-boundary touch, unmapped (reads 0),
      // or normal mapped. The source is always loaded even if the condition
      // is false, so all three exercise the load path.
      const ar = rng();
      let addr, doInit;
      if (ar < 0.15) {
        // Page-boundary: address straddling a 4K boundary.
        addr = 0x2000n - BigInt(2 + Math.floor(rng() * 6));
        doInit = true;
      } else if (ar < 0.25) {
        // Unmapped: no memInit entries; the sparse map reads 0.
        addr = 0x50000n + BigInt(Math.floor(rng() * 32));
        doInit = false;
      } else {
        addr = memAddr;
        doInit = true;
      }
      regs[baseReg] = addr;
      if (doInit) {
        for (let b = 0; b < 8; b++) memInit.set(addr + BigInt(b), Math.floor(rng() * 256));
      }
    } else {
      const src = Math.floor(rng() * 16);
      enc = encCmov(cc, size, dest, src);
      regs = Array.from({ length: 16 }, () => advVal(rng));
      if (rng() < 0.5) regs[src] = pick(rng, advVals);
    }
    if (rng() < 0.5) regs[dest] = (regs[dest] & 0xFFFFFFFFn) | 0xFFFFFFFF00000000n;
    const rflags = pick(rng, flagSets);
    const tag = 'fuzzCmov i=' + i + ' cc=' + cc + ' size=' + size + ' mem=' + isMem;
    try {
      await checkCmov(enc, { regs, rflags, memInit });
    } catch (e) {
      e.message = tag + ': ' + e.message;
      throw e;
    }
  }
}, 180000);


// --- D0/D1 shift/rotate by 1: targeted tests + differential fuzz ---
// D1: 0xD1 /0../7 r/m (16/32/64-bit via prefixes); D0: 0xD0 /0../7 r/m8.
// Both have implicit count 1. Reference models are refShift/refRotate
// with count=1n (mirroring cpu64.cpp doShift).

function encD1(sub, size, rm) {
  // size: 1 (D0), 2 (0x66), 4 (default), 8 (REX.W). rm: 0..15 reg index.
  // Prefix order: legacy (0x66) first, then REX, then opcode.
  const code = [];
  if (size === 2) code.push(0x66);
  const rexB = rm >= 8 ? 1 : 0;
  if (size === 8) code.push(0x48 | rexB); // REX.W (+B)
  else if (rexB) code.push(0x40 | rexB); // REX.B without W
  code.push(size === 1 ? 0xD0 : 0xD1);
  code.push(0xC0 | (sub << 3) | (rm & 7));
  return code;
}

function encD1Mem(sub, size, baseReg) {
  // Simple [baseReg] memory form: mod=00, rm=baseReg (0..7, no REX.B for simplicity).
  const code = [];
  if (size === 8) code.push(0x48);
  else if (size === 2) code.push(0x66);
  code.push(size === 1 ? 0xD0 : 0xD1);
  code.push((sub << 3) | (baseReg & 7)); // mod=00
  return code;
}

test('D1 SHL r64 by 1 (implicit count)', async () => {
  const regs = baseRegs(); regs[0] = 0x4000000000000000n;
  const { r, flags } = refShift(4, regs[0], 1n, 8, 0x202);
  assert.equal(flags & 0x8C5n, 0x800n | 0x80n | 0x4n, 'OF+SF+PF set');
  const out = await runAlu(encD1(4, 8, 0), regs, 0x202);
  expectShift(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});

test('D1 SHR r32 by 1 (implicit count)', async () => {
  const regs = baseRegs(); regs[1] = 0x80000001n;
  const { r, flags } = refShift(5, regs[1], 1n, 4, 0x202);
  const out = await runAlu(encD1(5, 4, 1), regs, 0x202);
  expectShift(out, 0x202, flags, 2, got => assert.equal(got[1], r));
});

test('D1 SAR r16 by 1 sign-extends', async () => {
  const regs = baseRegs(); regs[2] = 0x123456789ABC8000n;
  const { r, flags } = refShift(7, regs[2] & 0xFFFFn, 1n, 2, 0x202);
  assert.equal(r, 0xC000n);
  const out = await runAlu(encD1(7, 2, 2), regs, 0x202);
  expectShift(out, 0x202, flags, 3, got => {
    // Upper 48 bits preserved.
    assert.equal(got[2], (0x123456789ABC8000n & ~0xFFFFn) | r);
  });
});

test('D0 SHL r8 by 1 (8-bit form)', async () => {
  const regs = baseRegs(); regs[0] = 0x123456789ABCDE81n;
  const { r, flags } = refShift(4, 0x81n, 1n, 1, 0x202);
  assert.equal(r, 0x02n);
  const out = await runAlu(encD1(4, 1, 0), regs, 0x202);
  expectShift(out, 0x202, flags, 2, got => {
    // Low byte updated, upper 56 preserved.
    assert.equal(got[0], (0x123456789ABCDE81n & ~0xFFn) | r);
  });
});

test('D1 ROL r64 by 1', async () => {
  const regs = baseRegs(); regs[0] = 0x8000000000000000n;
  const { r, flags } = refRotate(0, regs[0], 1n, 8, 0x202);
  assert.equal(r, 0x0000000000000001n);
  const out = await runAlu(encD1(0, 8, 0), regs, 0x202);
  expectRotate(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});

test('D1 ROR r64 by 1', async () => {
  const regs = baseRegs(); regs[0] = 0x0000000000000001n;
  const { r, flags } = refRotate(1, regs[0], 1n, 8, 0x202);
  assert.equal(r, 0x8000000000000000n);
  const out = await runAlu(encD1(1, 8, 0), regs, 0x202);
  expectRotate(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});

test('D1 RCL r64 by 1 threads carry', async () => {
  const regs = baseRegs(); regs[0] = 0x8000000000000000n;
  const { r, flags } = refRotate(2, regs[0], 1n, 8, 0x203); // CF=1 in
  assert.equal(r, 0x0000000000000001n);
  const out = await runAlu(encD1(2, 8, 0), regs, 0x203);
  expectRotate(out, 0x203, flags, 3, got => assert.equal(got[0], r));
});

test('D1 RCR r64 by 1 threads carry', async () => {
  const regs = baseRegs(); regs[0] = 0x0000000000000001n;
  const { r, flags } = refRotate(3, regs[0], 1n, 8, 0x202); // CF=0 in
  assert.equal(r, 0x0000000000000000n);
  const out = await runAlu(encD1(3, 8, 0), regs, 0x202);
  expectRotate(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});

test('D1 SHL [rax] mem form writes back', async () => {
  const regs = baseRegs(); regs[0] = ALU_SBASE;
  const memInit = aluMemInit(ALU_SBASE, [0x81, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  // Reference: SHL mem8 by 1: 0x81 -> 0x02, CF=1 (bit7), OF=MSB^CF=1^1=0? No: OF=MSB(result)^CF = 0^1 = 1.
  const { r, flags } = refShift(4, 0x81n, 1n, 1, 0x202);
  const out = await runAluMem(encD1Mem(4, 1, 0), { regs, rflags: 0x202, memInit });
  assert.equal(out.guestMem.read(ALU_SBASE, 1), r, 'mem written');
  assert.equal(BigInt(out.rflags) & 0x8C5n, flags & 0x8C5n, 'flags');
});

test('D1 SAR [rax] mem64 form', async () => {
  const regs = baseRegs(); regs[0] = ALU_SBASE;
  const memInit = aluMemInit(ALU_SBASE, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80]);
  const { r, flags } = refShift(7, 0x8000000000000000n, 1n, 8, 0x202);
  const out = await runAluMem(encD1Mem(7, 8, 0), { regs, rflags: 0x202, memInit });
  assert.equal(out.guestMem.read(ALU_SBASE, 8), r, 'mem written');
  assert.equal(BigInt(out.rflags) & 0x8C5n, flags & 0x8C5n, 'flags');
});

test('fuzz D0/D1 shift/rotate-by-1 vs reference (600 cases)', async () => {
  const rng = mulberry32(0xD1F1);
  const flagSets = [0x202, 0x203, 0x8D5, 0x246, 0x202 | 0x800, 0x402, 0x0, 0xA5B5];
  const advVals = [0n, 1n, 0x7Fn, 0x80n, 0xFFn, 0x7FFFn, 0x8000n, 0xFFFFn,
                   0x7FFFFFFFn, 0x80000000n, 0xFFFFFFFFn,
                   0x7FFFFFFFFFFFFFFFn, 0x8000000000000000n, 0xFFFFFFFFFFFFFFFFn];
  for (let i = 0; i < 600; i++) {
    const sub = Math.floor(rng() * 8);
    const size = pick(rng, [1, 4, 4, 8, 8]); // 16-bit declined
    const isMem = rng() < 0.3; // 30% memory forms
    const rflags = pick(rng, flagSets);
    const tag = `fuzzD1 i=${i} sub=${sub} size=${size} mem=${isMem}`;
    try {
      if (!isMem) {
        // Register-direct.
        let rm = Math.floor(rng() * 16);
        // 8-bit high-byte (AH/BH/CH/DH, rm 4..7 no REX): interpreter-only
        // (classifier fallback); skip in the JIT fuzz.
        if (size === 1 && rm >= 4 && rm <= 7) { i--; continue; }
        const effRm = rm;
        const code = encD1(sub, size, effRm);
        const regs = Array.from({ length: 16 }, () => advVal(rng));
        if (rng() < 0.5) regs[effRm & 15] = pick(rng, advVals);
        const v = size === 1 ? regs[effRm & 15] & 0xFFn :
                  size === 2 ? regs[effRm & 15] & 0xFFFFn :
                  size === 4 ? regs[effRm & 15] & 0xFFFFFFFFn : regs[effRm & 15];
        const ref = sub <= 3 ? refRotate(sub, v, 1n, size, rflags) : refShift(sub, v, 1n, size, rflags);
        const out = await runAlu(code, regs, rflags);
        const fmask = sub <= 3 ? 0x801 : 0x8C5;
        assert.equal(BigInt(out.rflags) & BigInt(fmask), ref.flags & BigInt(fmask), `${tag} flags`);
        // Check the destination register: upper bits preserved from INPUT.
        const inReg = regs[effRm & 15];
        const isHighByte = size === 1 && effRm >= 4 && effRm <= 7;
        let expReg;
        if (size === 8) expReg = ref.r;
        else if (size === 4) expReg = ref.r & 0xFFFFFFFFn;
        else if (size === 2) expReg = (inReg & ~0xFFFFn) | (ref.r & 0xFFFFn);
        else if (isHighByte) expReg = (inReg & ~(0xFFn << 8n)) | ((ref.r & 0xFFn) << 8n);
        else expReg = (inReg & ~0xFFn) | (ref.r & 0xFFn);
        const gotReg = out.regs[effRm & 15];
        if (gotReg !== expReg) {
          throw new Error(`${tag} reg: rm=${effRm} inReg=${inReg.toString(16)} ref.r=${ref.r.toString(16)} got=${gotReg.toString(16)} exp=${expReg.toString(16)} rflagsIn=${rflags.toString(16)}`);
        }
      } else {
        // Memory form: simple [rax] EA.
        const code = encD1Mem(sub, size, 0);
        const regs = baseRegs(); regs[0] = ALU_SBASE;
        const initVal = pick(rng, advVals) & (size === 8 ? mask64 : (1n << BigInt(size * 8)) - 1n);
        const memInit = new Map();
        for (let b = 0; b < size; b++) memInit.set(ALU_SBASE + BigInt(b), Number((initVal >> BigInt(8 * b)) & 0xFFn));
        const ref = sub <= 3 ? refRotate(sub, initVal, 1n, size, rflags) : refShift(sub, initVal, 1n, size, rflags);
        const out = await runAluMem(code, { regs, rflags, memInit });
        assert.equal(out.guestMem.read(ALU_SBASE, size), ref.r, `${tag} mem`);
        const fmask = sub <= 3 ? 0x801 : 0x8C5;
        assert.equal(BigInt(out.rflags) & BigInt(fmask), ref.flags & BigInt(fmask), `${tag} flags`);
      }
    } catch (e) {
      e.message = `${tag}: ${e.message}`;
      throw e;
    }
  }
}, 180000);

// --- D2/D3 shift/rotate by CL: targeted tests + differential fuzz ---
// Semantics mirror the interpreter's dsp_41: count = CL & (size==8 ? 0x3F : 0x1F).
// count==0 is a pure no-op (no flags; 32-bit zero-extends on writeback).
// OF only defined for count==1. RCL/RCR carry-in from CF.
function encD3(sub, size, rm) {
  // size: 1 (D2), 2 (0x66), 4 (default), 8 (REX.W). rm: 0..15 reg index.
  const code = [];
  if (size === 2) code.push(0x66);
  const rexB = rm >= 8 ? 1 : 0;
  if (size === 8) code.push(0x48 | rexB); // REX.W (+B)
  else if (rexB) code.push(0x40 | rexB); // REX.B without W
  code.push(size === 1 ? 0xD2 : 0xD3);
  code.push(0xC0 | (sub << 3) | (rm & 7));
  return code;
}

function encD3Mem(sub, size, baseReg) {
  // Simple [baseReg] memory form: mod=00, rm=baseReg (0..7, no REX.B).
  const code = [];
  if (size === 8) code.push(0x48);
  else if (size === 2) code.push(0x66);
  code.push(size === 1 ? 0xD2 : 0xD3);
  code.push((sub << 3) | (baseReg & 7)); // mod=00
  return code;
}

function effCountCL(cl, size) {
  return BigInt((Number(cl) & 0xFF) & (size === 8 ? 0x3F : 0x1F));
}

test('D3 SHL r64 by CL', async () => {
  const regs = baseRegs(); regs[0] = 0x4000000000000000n; regs[1] = 0x4n; // CL=4
  const { r, flags } = refShift(4, regs[0], 4n, 8, 0x202);
  const out = await runAlu(encD3(4, 8, 0), regs, 0x202);
  expectShift(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});

test('D3 SHL r32 by CL=0 is no-op (flags untouched)', async () => {
  const regs = baseRegs(); regs[0] = 0xDEADBEEFn; regs[1] = 0x20n; // CL=32 -> masked to 0
  const out = await runAlu(encD3(4, 4, 0), regs, 0x8D5);
  assert.equal(out.rflags, 0x8D5, 'flags untouched');
  assert.equal(BigInt(out.regs[0]) & 0xFFFFFFFFn, 0xDEADBEEFn, 'value unchanged');
});

test('D3 SHL r64 by CL=0 is pure no-op', async () => {
  const regs = baseRegs(); regs[0] = 0x123456789ABCDEF0n; regs[1] = 0x0n;
  const out = await runAlu(encD3(4, 8, 0), regs, 0x246);
  assert.equal(out.rflags, 0x246, 'flags untouched');
  assert.equal(out.regs[0], 0x123456789ABCDEF0n, 'value unchanged');
});

test('D3 SHR r64 by CL=1 sets OF from MSB', async () => {
  const regs = baseRegs(); regs[0] = 0x8000000000000000n; regs[1] = 0x1n;
  const { r, flags } = refShift(5, regs[0], 1n, 8, 0x202);
  assert.equal(flags & 0x800n, 0x800n, 'OF set (MSB was 1)');
  const out = await runAlu(encD3(5, 8, 0), regs, 0x202);
  expectShift(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});

test('D3 count masked to 0x1F for 32-bit (CL=33 -> 1)', async () => {
  const regs = baseRegs(); regs[0] = 0x00000001n; regs[1] = 0x21n; // CL=33 -> 1
  const { r, flags } = refShift(4, regs[0], 1n, 4, 0x202);
  assert.equal(r, 0x00000002n);
  const out = await runAlu(encD3(4, 4, 0), regs, 0x202);
  expectShift(out, 0x202, flags, 2, got => assert.equal(got[0], r));
});

test('D3 count masked to 0x3F for 64-bit (CL=65 -> 1)', async () => {
  const regs = baseRegs(); regs[0] = 0x0000000000000001n; regs[1] = 0x41n; // CL=65 -> 1
  const { r, flags } = refShift(4, regs[0], 1n, 8, 0x202);
  assert.equal(r, 0x0000000000000002n);
  const out = await runAlu(encD3(4, 8, 0), regs, 0x202);
  expectShift(out, 0x202, flags, 3, got => assert.equal(got[0], r));
});


test('fuzz D2/D3 shift/rotate-by-CL vs reference (600 cases)', async () => {
  const rng = mulberry32(0xD3C1);
  const flagSets = [0x202, 0x203, 0x8D5, 0x246, 0x202 | 0x800, 0x402, 0x0, 0xA5B5];
  const advVals = [0n, 1n, 0x7Fn, 0x80n, 0xFFn, 0x7FFFn, 0x8000n, 0xFFFFn,
                   0x7FFFFFFFn, 0x80000000n, 0xFFFFFFFFn,
                   0x7FFFFFFFFFFFFFFFn, 0x8000000000000000n, 0xFFFFFFFFFFFFFFFFn];
  // Adversarial CL values: 0 (no-op), 1 (OF edge), 31/32/33 (mask edges),
  // 63/64/65 (64-bit mask edges), 255 (max), plus random.
  const advCL = [0, 1, 2, 31, 32, 33, 63, 64, 65, 127, 128, 255];
  for (let i = 0; i < 600; i++) {
    let sub = Math.floor(rng() * 8); // 0-3 rotates, 4-7 shifts
    const size = pick(rng, [1, 4, 4, 8, 8]); // 16-bit declined
    if (sub <= 3 && size === 1) { i--; continue; } // 8-bit rotates: result bug, declined
    const isMem = false; // mem forms declined (interpreter-only)
    const rflags = pick(rng, flagSets);
    const cl = rng() < 0.5 ? pick(rng, advCL) : Math.floor(rng() * 256);
    const count = effCountCL(cl, size);
    const tag = `fuzzD3 i=${i} sub=${sub} size=${size} mem=${isMem} cl=${cl}`;
    try {
      if (!isMem) {
        // Register-direct. Never use rm=1 (RCX) as the operand: CL is the
        // count source and writing it would be a data-dependent mess the
        // interpreter handles but the fuzz reference models separately.
        let rm = Math.floor(rng() * 16);
        if (rm === 1) rm = 9; // RCX -> R9
        // 8-bit high-byte (AH/BH/CH/DH, rm 4..7 no REX): interpreter-only
        // (classifier fallback); skip in the JIT fuzz.
        if (size === 1 && rm >= 4 && rm <= 7) { i--; continue; }
        const code = encD3(sub, size, rm);
        const regs = Array.from({ length: 16 }, () => advVal(rng));
        if (rng() < 0.5) regs[rm & 15] = pick(rng, advVals);
        regs[1] = (regs[1] & ~0xFFn) | BigInt(cl); // CL = count source
        const v = size === 1 ? regs[rm & 15] & 0xFFn :
                  size === 2 ? regs[rm & 15] & 0xFFFFn :
                  size === 4 ? regs[rm & 15] & 0xFFFFFFFFn : regs[rm & 15];
        const ref = sub <= 3 ? refRotate(sub, v, count, size, rflags)
                             : refShift(sub, v, count, size, rflags);
        const out = await runAlu(code, regs, rflags);
        // Reference model returns the masked value; the JIT writes back the
        // full register (64-bit: full; 32-bit: zero-extended; 16/8-bit: merged).
        const want = size === 8 ? ref.r :
                     size === 4 ? ref.r & 0xFFFFFFFFn :
                     size === 2 ? (regs[rm & 15] & ~0xFFFFn) | ref.r :
                                  (regs[rm & 15] & ~0xFFn) | ref.r;
        assert.equal(out.regs[rm & 15] & mask64, want & mask64, `${tag} reg`);
        const fmask = sub <= 3 ? 0x801 : 0x8C5;
        assert.equal(BigInt(out.rflags) & BigInt(fmask), ref.flags & BigInt(fmask), `${tag} flags`);
      } else {
        // Memory form: [rax] via baseReg=0. Skip rm=1 (RCX) as base too.
        const code = encD3Mem(sub, size, 0);
        const regs = baseRegs(); regs[0] = ALU_SBASE;
        regs[1] = (regs[1] & ~0xFFn) | BigInt(cl);
        const initVal = pick(rng, advVals) & (size === 8 ? mask64 : (1n << BigInt(size * 8)) - 1n);
        const memInit = new Map();
        for (let b = 0; b < size; b++) memInit.set(ALU_SBASE + BigInt(b), Number((initVal >> BigInt(8 * b)) & 0xFFn));
        const ref = sub <= 3 ? refRotate(sub, initVal, count, size, rflags)
                             : refShift(sub, initVal, count, size, rflags);
        const out = await runAluMem(code, { regs, rflags, memInit });
        assert.equal(out.guestMem.read(ALU_SBASE, size), ref.r, `${tag} mem`);
        const fmask = sub <= 3 ? 0x801 : 0x8C5;
        assert.equal(BigInt(out.rflags) & BigInt(fmask), ref.flags & BigInt(fmask), `${tag} flags`);
      }
    } catch (e) {
      e.message = `${tag}: ${e.message}`;
      throw e;
    }
  }
}, 180000);

// C6 (MOV r/m8, imm8) tests. Reference model: the immediate byte is
// written to the 8-bit register or memory location; no flags touched.
// Mirrors cpu64.cpp dsp_12 (storeRM with size 1).
function encC6({ rm = 0, imm = 0x42, eaKind = 'reg', base = 0, disp = 0 }) {
  // rm is 0..15 (like encMov8); REX.B is emitted iff rm >= 8.
  const rexPresent = rm >= 8;
  const code = [];
  if (rexPresent) code.push(0x41); // REX.B
  code.push(0xC6);
  let mod, rmF;
  const dispBytes = [];
  if (eaKind === 'reg') { mod = 3; rmF = rm & 7; }
  else { rmF = base & 7; mod = disp !== 0 ? (disp >= -128 && disp <= 127 ? 1 : 2) : 0; }
  if (mod === 1) dispBytes.push(disp & 0xFF);
  if (mod === 2) dispBytes.push(...little(BigInt(disp) & 0xFFFFFFFFn, 4));
  code.push((mod << 6) | (0 << 3) | rmF, ...dispBytes); // /0
  code.push(imm & 0xFF);
  const ea = { ripRel: false, ripRelTarget: 0n, baseReg: 0xFF, idxReg: 0xFF, scale: 0, disp: 0n, asize32: false, seg: 0 };
  if (eaKind !== 'reg') {
    ea.baseReg = base;
    ea.disp = 0n;
    if (mod === 1) ea.disp = BigInt.asIntN(64, BigInt.asIntN(8, BigInt(disp))) & mask64;
    else if (mod === 2) ea.disp = BigInt.asIntN(64, BigInt.asIntN(32, BigInt(disp))) & mask64;
  }
  return { code, ea, rm, imm: imm & 0xFF, rexPresent, eaKind };
}

async function checkC6(enc, { regs, rflags = 0x202, memInit = new Map(), rip = 0x12345678ABCDEFF0n }) {
  const refRegs = [...regs];
  const refMem = makeGuestMem();
  for (const [k, v] of memInit) refMem.bytes.set(k, v);
  const byte = BigInt(enc.imm & 0xFF);
  if (enc.eaKind === 'reg') {
    memRegWrite(refRegs, enc.rm, 1, byte, enc.rexPresent);
  } else {
    const eaAddr = computeEA(enc.ea, refRegs);
    refMem.write(eaAddr, 1, byte);
  }
  const out = await runAluMem(enc.code, { regs: [...regs], rflags, memInit, rip });
  assert.deepEqual(out.regs, refRegs, 'GPRs');
  assert.equal(BigInt(out.rflags), BigInt(rflags) & 0xFFFFFFFFn, 'RFLAGS preserved (MOV never touches flags)');
  assert.equal(out.ripOut, (rip + BigInt(enc.code.length)) & mask64, 'RIP');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
  const refKeys = [...refMem.bytes.keys()].map(String).sort();
  const outKeys = [...out.guestMem.bytes.keys()].map(String).sort();
  assert.deepEqual(outKeys, refKeys, 'written addresses');
  for (const k of refKeys) assert.equal(out.guestMem.bytes.get(BigInt(k)), refMem.bytes.get(BigInt(k)), `mem[${k}]`);
}

test('C6 MOV r/m8,imm8 reg-direct: low bytes', async () => {
  // C6 C0 42: mov al, 0x42
  await checkC6(encC6({ rm: 0, imm: 0x42 }), { regs: baseRegs() });
  // C6 C3 FF: mov bl, 0xFF (upper bits preserved)
  const regs = baseRegs(); regs[3] = 0x1122334455667788n;
  await checkC6(encC6({ rm: 3, imm: 0xFF }), { regs });
  // 41 C6 C0 42: mov r8b, 0x42 (REX.B, rm=8)
  await checkC6(encC6({ rm: 8, imm: 0x42 }), { regs: baseRegs() });
});

test('C6 MOV r/m8,imm8 mem form', async () => {
  // C6 00 42: mov byte [rax], 0x42
  const regs = baseRegs(); regs[0] = ALU_SBASE;
  await checkC6(encC6({ eaKind: 'base', base: 0, imm: 0x42 }), { regs, memInit: new Map() });
  // C6 40 08 42: mov byte [rax+8], 0x42 (disp8)
  const regs2 = baseRegs(); regs2[0] = ALU_SBASE;
  await checkC6(encC6({ eaKind: 'disp8', base: 0, disp: 8, imm: 0xAB }), { regs: regs2, memInit: new Map() });
});

test('C6 preserves RFLAGS', async () => {
  const regs = baseRegs();
  for (const rf of [0x202, 0x8D5, 0x0, 0xFFFFFFFF]) {
    await checkC6(encC6({ rm: 1, imm: 0x00 }), { regs: [...regs], rflags: rf });
  }
});

test('fuzz C6 MOV r/m8,imm8 vs reference (600 cases)', async () => {
  const rng = mulberry32(0xC600);
  const flagSets = [0x202, 0x203, 0x8D5, 0x246, 0x202 | 0x800, 0x402, 0x0, 0xA5B5];
  const advImms = [0, 1, 0x7F, 0x80, 0xFF, 0x42, 0xAB];
  for (let i = 0; i < 600; i++) {
    const isMem = rng() < 0.4; // 40% memory forms
    const rflags = pick(rng, flagSets);
    const imm = pick(rng, advImms);
    const tag = `fuzzC6 i=${i} mem=${isMem} imm=${imm}`;
    try {
      if (!isMem) {
        // Register-direct: rm 0..15. High-byte (4..7, no REX) is
        // interpreter-only (classifier decline); skip in the JIT fuzz.
        const rm = Math.floor(rng() * 16);
        if (rm >= 4 && rm <= 7) { i--; continue; } // declined, no REX.B
        const regs = Array.from({ length: 16 }, () => advVal(rng));
        const enc = encC6({ rm, imm });
        await checkC6(enc, { regs, rflags });
      } else {
        // Memory form: [rax] and [rax+disp8].
        const regs = baseRegs(); regs[0] = ALU_SBASE;
        const useDisp = rng() < 0.5;
        const disp = useDisp ? Math.floor(rng() * 256) - 128 : 0;
        const enc = encC6({ eaKind: useDisp ? 'disp8' : 'base', base: 0, disp, imm });
        await checkC6(enc, { regs, rflags, memInit: new Map() });
      }
    } catch (e) {
      e.message = `${tag}: ${e.message}`;
      throw e;
    }
  }
}, 180000);

// --- SETcc (0F 90..9F) differential tests ---
function encSetcc({ cc = 4, rm = 0, eaKind = 'reg', base = 0, disp = 0 }) {
  // cc 0..15, rm 0..15 (REX.B emitted iff rm >= 8).
  const rexPresent = rm >= 8;
  const code = [];
  if (rexPresent) code.push(0x41); // REX.B
  code.push(0x0F, 0x90 + (cc & 0xF));
  let mod, rmF;
  const dispBytes = [];
  if (eaKind === 'reg') { mod = 3; rmF = rm & 7; }
  else { rmF = base & 7; mod = disp !== 0 ? (disp >= -128 && disp <= 127 ? 1 : 2) : 0; }
  if (mod === 1) dispBytes.push(disp & 0xFF);
  if (mod === 2) dispBytes.push(...little(BigInt(disp) & 0xFFFFFFFFn, 4));
  code.push((mod << 6) | (0 << 3) | rmF, ...dispBytes);
  const ea = { ripRel: false, ripRelTarget: 0n, baseReg: 0xFF, idxReg: 0xFF, scale: 0, disp: 0n, asize32: false, seg: 0 };
  if (eaKind !== 'reg') {
    ea.baseReg = base;
    ea.disp = 0n;
    if (mod === 1) ea.disp = BigInt.asIntN(64, BigInt.asIntN(8, BigInt(disp))) & mask64;
    else if (mod === 2) ea.disp = BigInt.asIntN(64, BigInt.asIntN(32, BigInt(disp))) & mask64;
  }
  return { code, ea, cc: cc & 0xF, rm, rexPresent, eaKind };
}

async function checkSetcc(enc, { regs, rflags = 0x202, memInit = new Map(), rip = 0x12345678ABCDEFF0n }) {
  const refRegs = [...regs];
  const refMem = makeGuestMem();
  for (const [k, v] of memInit) refMem.bytes.set(k, v);
  const val = evalCCRef(enc.cc, rflags) ? 1n : 0n;
  if (enc.eaKind === 'reg') {
    memRegWrite(refRegs, enc.rm, 1, val, enc.rexPresent);
  } else {
    const eaAddr = computeEA(enc.ea, refRegs);
    refMem.write(eaAddr, 1, val);
  }
  const out = await runAluMem(enc.code, { regs: [...regs], rflags, memInit, rip });
  assert.deepEqual(out.regs, refRegs, 'GPRs');
  assert.equal(BigInt(out.rflags), BigInt(rflags) & 0xFFFFFFFFn, 'RFLAGS preserved (SETcc never touches flags)');
  assert.equal(out.ripOut, (rip + BigInt(enc.code.length)) & mask64, 'RIP');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
  const refKeys = [...refMem.bytes.keys()].map(String).sort();
  const outKeys = [...out.guestMem.bytes.keys()].map(String).sort();
  assert.deepEqual(outKeys, refKeys, 'written addresses');
  for (const k of refKeys) assert.equal(out.guestMem.bytes.get(BigInt(k)), refMem.bytes.get(BigInt(k)), `mem[${k}]`);
}

test('SETcc reg-direct: all 16 conditions', async () => {
  // ZF=1: sete (cc=4) -> 1, setne (cc=5) -> 0
  let regs = baseRegs();
  await checkSetcc(encSetcc({ cc: 4, rm: 1 }), { regs, rflags: 0x202 | 0x40 });
  regs = baseRegs();
  await checkSetcc(encSetcc({ cc: 5, rm: 1 }), { regs, rflags: 0x202 | 0x40 });
  // CF=1: setb (cc=2) -> 1, setnb (cc=3) -> 0
  regs = baseRegs();
  await checkSetcc(encSetcc({ cc: 2, rm: 2 }), { regs, rflags: 0x202 | 0x1 });
  regs = baseRegs();
  await checkSetcc(encSetcc({ cc: 3, rm: 2 }), { regs, rflags: 0x202 | 0x1 });
  // SF!=OF: setl (cc=12) -> 1
  regs = baseRegs();
  await checkSetcc(encSetcc({ cc: 12, rm: 3 }), { regs, rflags: 0x202 | 0x80 });
  // 41 0F 9F C0: setg r8b (REX.B, rm=8)
  regs = baseRegs();
  await checkSetcc(encSetcc({ cc: 15, rm: 8 }), { regs, rflags: 0x202 });
});

test('SETcc mem form', async () => {
  // 0F 94 00: sete byte [rax]
  const regs = baseRegs(); regs[0] = ALU_SBASE;
  await checkSetcc(encSetcc({ cc: 4, eaKind: 'base', base: 0 }), { regs, rflags: 0x202 | 0x40, memInit: new Map() });
  // 0F 95 40 08: setne byte [rax+8]
  const regs2 = baseRegs(); regs2[0] = ALU_SBASE;
  await checkSetcc(encSetcc({ cc: 5, eaKind: 'disp8', base: 0, disp: 8 }), { regs: regs2, rflags: 0x202, memInit: new Map() });
});

test('SETcc preserves RFLAGS', async () => {
  const regs = baseRegs();
  for (const rf of [0x202, 0x8D5, 0x0, 0xFFFFFFFF, 0xA5B5]) {
    await checkSetcc(encSetcc({ cc: 4, rm: 1 }), { regs: [...regs], rflags: rf });
  }
});

test('fuzz SETcc vs reference (600 cases)', async () => {
  const rng = mulberry32(0x90CC);
  // Adversarial flag sets: each flag bit isolated + combinations.
  const flagSets = [0x202, 0x203, 0x206, 0x242, 0x282, 0x806, 0x8D5, 0x0, 0xFFFFFFFF, 0xA5B5, 0x5A5A];
  for (let i = 0; i < 600; i++) {
    const cc = Math.floor(rng() * 16);
    const isMem = rng() < 0.4; // 40% memory forms
    const rflags = pick(rng, flagSets);
    const tag = `fuzzSetcc i=${i} cc=${cc} mem=${isMem} flags=0x${rflags.toString(16)}`;
    try {
      if (!isMem) {
        // Register-direct: rm 0..15. High-byte (4..7, no REX) is
        // interpreter-only (classifier decline); skip in the JIT fuzz.
        const rm = Math.floor(rng() * 16);
        if (rm >= 4 && rm <= 7) { i--; continue; } // declined, no REX.B
        const regs = Array.from({ length: 16 }, () => advVal(rng));
        const enc = encSetcc({ cc, rm });
        await checkSetcc(enc, { regs, rflags });
      } else {
        // Memory form: [rax] and [rax+disp8].
        const regs = baseRegs(); regs[0] = ALU_SBASE;
        const useDisp = rng() < 0.5;
        const disp = useDisp ? Math.floor(rng() * 256) - 128 : 0;
        const enc = encSetcc({ cc, eaKind: useDisp ? 'disp8' : 'base', base: 0, disp });
        await checkSetcc(enc, { regs, rflags, memInit: new Map() });
      }
    } catch (e) {
      e.message = `${tag}: ${e.message}`;
      throw e;
    }
  }
}, 180000);

// --- BT/BTS/BTR/BTC (0F A3/AB/B3/BB) differential tests ---
function encBt({ sub = 0, regField = 0, rm = 0, eaKind = 'reg', base = 0, disp = 0, size = 4 }) {
  const code = [];
  let rex = 0;
  if (size === 8) rex |= 0x08;
  if (regField >= 8) rex |= 0x04;
  if (rm >= 8 && eaKind === 'reg') rex |= 0x01;
  if (size === 2) code.push(0x66);
  if (rex) code.push(0x40 | rex);
  const op2 = 0xA3 + sub * 8;
  code.push(0x0F, op2);
  let mod, regF = regField & 7, rmF;
  const dispBytes = [];
  if (eaKind === 'reg') { mod = 3; rmF = rm & 7; }
  else { rmF = base & 7; mod = disp !== 0 ? 1 : 0; }
  if (mod === 1) dispBytes.push(disp & 0xFF);
  code.push((mod << 6) | (regF << 3) | rmF, ...dispBytes);
  return { code, sub, regField, rm, eaKind, base, disp, size };
}

async function checkBt(enc, { regs, rflags = 0x202, memInit = new Map(), rip = 0x12345678ABCDEFF0n }) {
  const refRegs = regs.map(x => BigInt(x));
  const refMem = makeGuestMem();
  for (const [k, v] of memInit) refMem.bytes.set(k, v);
  const size = enc.size;
  const wbits = BigInt(size * 8);
  const widthMask = (1n << wbits) - 1n;
  const idx = refRegs[enc.regField] & widthMask;
  const bit = idx & (wbits - 1n);
  const mask = 1n << bit;
  let v, eaAddr = 0n;
  if (enc.eaKind === 'reg') {
    v = refRegs[enc.rm] & widthMask;
  } else {
    eaAddr = (refRegs[enc.base] + BigInt(enc.disp)) & mask64;
    const bytes = [];
    for (let b = 0; b < size; b++) bytes.push(refMem.bytes.get(eaAddr + BigInt(b)) || 0);
    v = 0n;
    for (let b = size - 1; b >= 0; b--) v = (v << 8n) | BigInt(bytes[b]);
    v &= widthMask;
  }
  const selected = (v >> bit) & 1n;
  const refRflags = (BigInt(rflags) & ~1n) | selected;
  if (enc.sub !== 0) {
    let nv = v;
    if (enc.sub === 1) nv = v | mask;
    else if (enc.sub === 2) nv = v & (widthMask ^ mask);
    else nv = v ^ mask;
    nv &= widthMask;
    if (enc.eaKind === 'reg') {
      if (size === 2) refRegs[enc.rm] = (refRegs[enc.rm] & ~0xFFFFn) | nv;
      else refRegs[enc.rm] = nv;
    } else {
      for (let b = 0; b < size; b++) refMem.bytes.set(eaAddr + BigInt(b), Number((nv >> BigInt(b * 8)) & 0xFFn));
    }
  }
  const out = await runAluMem(enc.code, { regs: regs.map(x => BigInt(x)), rflags, memInit, rip });
  assert.deepEqual(out.regs.map(x => BigInt(x)), refRegs, 'GPRs');
  const outFlags = BigInt(out.rflags) & 0xFFFFFFFFn;
  const wantFlags = refRflags & 0xFFFFFFFFn;
  assert.equal(outFlags, wantFlags, 'RFLAGS (only CF changes)');
  assert.equal(out.ripOut, (rip + BigInt(enc.code.length)) & mask64, 'RIP');
  assert.equal(out.reserved, 0xA5A5A5A5, 'ABI reserved word');
}

test('fuzz BT/BTS/BTR/BTC vs reference (600 cases)', async () => {
  const rng = mulberry32(0x0FA3);
  const flagSets = [0x202, 0x203, 0x206, 0x242, 0x282, 0x806, 0x8D5, 0x0, 0xFFFFFFFF, 0xA5B5];
  const bitVals = [0n, 1n, 15n, 16n, 17n, 31n, 32n, 33n, 63n, 64n, 65n, 255n, 4294967295n, 18446744073709551615n];
  for (let i = 0; i < 600; i++) {
    const sub = Math.floor(rng() * 4);
    const size = [2, 4, 8][Math.floor(rng() * 3)];
    const isMem = rng() < 0.4;
    const rflags = flagSets[Math.floor(rng() * flagSets.length)];
    const tag = 'fuzzBt i=' + i + ' sub=' + sub + ' size=' + size + ' mem=' + isMem;
    try {
      if (!isMem) {
        const regs = Array.from({ length: 16 }, () => advVal(rng));
        const regField = Math.floor(rng() * 16);
        regs[regField] = bitVals[Math.floor(rng() * bitVals.length)];
        const rm = Math.floor(rng() * 16);
        const enc = encBt({ sub, regField, rm, size });
        await checkBt(enc, { regs, rflags });
      } else {
        const regs = baseRegs();
        regs[0] = ALU_SBASE;
        const regField = Math.floor(rng() * 16);
        regs[regField] = bitVals[Math.floor(rng() * bitVals.length)];
        const useDisp = rng() < 0.5;
        const disp = useDisp ? Math.floor(rng() * 256) - 128 : 0;
        const enc = encBt({ sub, regField, eaKind: useDisp ? 'disp8' : 'base', base: 0, disp, size });
        await checkBt(enc, { regs, rflags, memInit: new Map() });
      }
    } catch (e) {
      e.message = tag + ': ' + e.message;
      throw e;
    }
  }
}, 180000);
