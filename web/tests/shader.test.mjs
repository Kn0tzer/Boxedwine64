// Offline shader compatibility matrix (node, no browser).
// Covers the same Naga WASM build the browser lab vendors (web/vendor/naga)
// plus the input guards in web/shader.mjs. HLSL stays browser-covered
// (web/tests/browser.mjs) until slang-wasm ships a node entry point.
// Known-limit cases assert a clean throw: they document the exact Naga gaps
// (legacy GLSL/ESSL, tessellation/geometry stages, split sampler syntax)
// that SPIRV-Cross / Slang tracking must close. If a pinned failure starts
// passing, update the matrix instead of deleting the vector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as naga from '../vendor/naga/node.js';

const VERT_450 = `#version 450
layout(location=0) in vec3 p;
void main(){gl_Position=vec4(p,1.0);}`;
const FRAG_COMBINED = `#version 450
layout(location=0) out vec4 c;
layout(binding=0) uniform texture2D t;
layout(binding=1) uniform sampler s;
void main(){c=texture(sampler2D(t,s),vec2(0.5));}`;
const COMPUTE_450 = `#version 450
layout(local_size_x=64) in;
layout(binding=0) buffer B { float a[]; };
void main(){a[gl_GlobalInvocationID.x]+=1.0;}`;
const WGSL_MIN = '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }';

test('glsl vertex 450 translates to WGSL with position builtin', () => {
  const out = String(naga.translate({ from: 'glsl', to: 'wgsl', source: VERT_450, parse: { stage: 'vertex' } }));
  assert.match(out, /@builtin\(position\)/);
});

test('glsl fragment with combined sampler translates', () => {
  const out = String(naga.translate({ from: 'glsl', to: 'wgsl', source: FRAG_COMBINED, parse: { stage: 'fragment' } }));
  assert.match(out, /@location\(0\)/);
});

test('glsl compute translates with storage buffer', () => {
  const out = String(naga.translate({ from: 'glsl', to: 'wgsl', source: COMPUTE_450, parse: { stage: 'compute' } }));
  assert.match(out, /read_write/);
});

test('wgsl round-trips through validate', () => {
  const out = String(naga.translate({ from: 'wgsl', to: 'wgsl', source: WGSL_MIN }));
  assert.ok(out.includes('vertex_index'));
});

test('wgsl -> spir-v -> wgsl round-trips with valid magic', () => {
  const spv = naga.translate({ from: 'wgsl', to: 'spirv', source: WGSL_MIN });
  assert.equal(Buffer.from(spv.buffer, spv.byteOffset, 4).readUInt32LE(0), 0x07230203);
  const back = String(naga.translate({ from: 'spirv', to: 'wgsl', source: new Uint8Array(spv.buffer, spv.byteOffset, spv.byteLength) }));
  assert.ok(back.length > 0);
});

test('KNOWN GAP: legacy GLSL 120 attribute syntax is rejected', () => {
  assert.throws(() => naga.translate({ from: 'glsl', to: 'wgsl', source: 'attribute vec3 p;\nvoid main(){gl_Position=vec4(p,1.0);}', parse: { stage: 'vertex' } }));
});

test('KNOWN GAP: tessellation control layout is rejected', () => {
  assert.throws(() => naga.translate({ from: 'glsl', to: 'wgsl', source: '#version 450\nlayout(vertices=3) out;\nvoid main(){gl_TessLevelOuter[0]=1.0;}', parse: { stage: 'vertex' } }));
});

test('KNOWN GAP: split sampler2D uniform is rejected (use combined texture+sampler)', () => {
  assert.throws(() => naga.translate({ from: 'glsl', to: 'wgsl', source: '#version 450\nlayout(location=0) out vec4 c;\nlayout(binding=0) uniform sampler2D t;\nvoid main(){c=texture(t,vec2(0.5));}', parse: { stage: 'fragment' } }));
});

test('malformed SPIR-V is rejected, matching web/shader.mjs guards', () => {
  assert.throws(() => naga.translate({ from: 'spirv', to: 'wgsl', source: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }));
  assert.throws(() => naga.translate({ from: 'wgsl', to: 'wgsl', source: 42 }));
});
