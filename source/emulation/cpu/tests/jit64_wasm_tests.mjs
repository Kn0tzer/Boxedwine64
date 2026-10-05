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
  const { instance } = await WebAssembly.instantiate(module, { env: { memory } });
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
  const { instance } = await WebAssembly.instantiate(readFileSync(path), { env: { memory } });
  for (const ptr of [65536 - 128, -1, -128]) {
    assert.throws(() => instance.exports.execute(ptr), WebAssembly.RuntimeError);
    assert.ok(bytes.every(value => value === 0xA5), 'trap must leave memory unchanged');
  }
});

for (const [name, code] of [
  ['empty block', []], ['flag-changing XOR', [0x31, 0xC0]],
  ['guest-memory MOV', [0x48, 0x89, 0x00]], ['MOVZX source width', [0x0F, 0xB6, 0xC0]],
  ['16-bit MOV', [0x66, 0xB8, 0x42, 0]], ['REP prefix', [0xF3, 0xB8, 0x42, 0, 0, 0]],
  ['unsupported suffix after MOV', [...movabs(0, 1n), 0x31, 0xC9]],
  ['block longer than 24 operations', Array.from({ length: 25 }, () => movabs(0, 1n)).flat()],
]) {
  test(`whole-block fallback rejects ${name}`, () => assert.equal(emit(code).result.status, 2));
}
