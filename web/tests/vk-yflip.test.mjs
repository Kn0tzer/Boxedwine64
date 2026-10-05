
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripNagaYNegation, swizzleBgraVb, v2VertexFormat,
} from '../vkwebgpu.mjs';

const NAGA_EPILOGUE = `    main_1();
    let _e36 = out_Position0_.y;
    out_Position0_.y = -(_e36);
    let _e38 = out_Position0_;
    return VertexOutput(_e38);`;

test('stripNagaYNegation removes the temp-form Y negation', () => {
  const out = stripNagaYNegation(NAGA_EPILOGUE);
  assert.ok(!out.includes('-(_e36)'), 'negation gone');
  assert.ok(!out.includes('let _e36'), 'temp gone');
  assert.ok(out.includes('main_1();'), 'surrounding code kept');
  assert.ok(out.includes('return VertexOutput(_e38);'), 'return kept');
});

test('stripNagaYNegation removes the direct form', () => {
  const out = stripNagaYNegation('    foo.y = -(foo.y);\n    bar();');
  assert.equal(out.trim(), 'bar();');
});

test('stripNagaYNegation is a no-op without a negation', () => {
  const code = 'fn main() { let x = 1.0; }';
  assert.equal(stripNagaYNegation(code), code);
});

test('stripNagaYNegation does not touch other negations', () => {
  const code = '    let a = -(b);\n    c = -(d + e);';
  assert.equal(stripNagaYNegation(code), code);
});

test('v2VertexFormat(44) maps B8G8R8A8 to unorm8x4 (swizzled on upload)', () => {
  assert.equal(v2VertexFormat(44), 'unorm8x4');
});

test('swizzleBgraVb swaps R/B per attribute element', () => {
  // stride 20 (float4 pos + bgra color), color at offset 16, two vertices.
  // v0 color bytes B,G,R,A = 10,20,30,40 -> expect 30,20,10,40.
  const bytes = new Uint8Array(40);
  bytes.set([10, 20, 30, 40], 16);
  bytes.set([50, 60, 70, 80], 36);
  const out = swizzleBgraVb(bytes, 20, [16]);
  assert.deepEqual([...out.slice(16, 20)], [30, 20, 10, 40]);
  assert.deepEqual([...out.slice(36, 40)], [70, 60, 50, 80]);
  // position bytes untouched
  assert.deepEqual([...out.slice(0, 16)], [...bytes.slice(0, 16)]);
  // input not mutated
  assert.deepEqual([...bytes.slice(16, 20)], [10, 20, 30, 40]);
});

test('swizzleBgraVb handles multiple attributes and partial tails', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]); // stride 4, 2 full elems + 1 byte tail
  const out = swizzleBgraVb(bytes, 4, [0]);
  assert.deepEqual([...out], [3, 2, 1, 4, 7, 6, 5, 8, 9]);
});

test('swizzleBgraVb with no offsets or bad stride returns a copy', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.deepEqual([...swizzleBgraVb(bytes, 4, [])], [1, 2, 3, 4]);
  assert.deepEqual([...swizzleBgraVb(bytes, 0, [0])], [1, 2, 3, 4]);
});
