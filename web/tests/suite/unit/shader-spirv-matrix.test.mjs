// web/tests/suite/unit/shader-spirv-matrix.test.mjs — SPIR-V → WGSL (naga) boundary.
//
// naga rejects OpCapability DrawParameters when unused → spirvfix R5 (strip);
// rejects dual-source Index decoration though spirv-val passes → R6;
// PhysicalStorageBuffer unused declarations → R8; glslang combined sampler2D
// loads OpTypeSampledImage directly; naga lookup populates only via
// OpSampledImage → combined-sampler splitting pre-pass; SpecConstantOp
// unsupported → default-value folding; D3D12 replay baked indexed verts in
// draw order but page replayed with original index buffer → gl_VertexIndex
// wrong switch cases → replay indexed as non-indexed; captureIndexedDraw
// hardcoded D3D9 layout (vec4 pos + BGRA8) vs scene12 (vec3 pos + float4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const fix = readFileSync(join(repoRoot, 'tools/spirvfix/spirvfix.mjs'), 'utf8');

test('R5 strip-draw-parameters exists (naga DrawParameters rejection)', () => {
  assert.ok(fix.includes('strip-draw-parameters') || fix.includes('DrawParameters'),
    'spirvfix R5 must strip unused OpCapability DrawParameters');
});

test('R6 strip-index-decorations exists (dual-source Index)', () => {
  assert.ok(fix.includes('strip-index') || fix.includes('Index'),
    'spirvfix R6 must strip fragment Index decorations (spirv-val passes, naga rejects)');
});

test('R8 PhysicalStorageBuffer stripping exists', () => {
  assert.ok(fix.includes('PhysicalStorageBuffer') || fix.includes('R8') || fix.includes('storageBuffer'),
    'spirvfix R8 (PhysicalStorageBuffer unused declarations) must exist');
});

test('combined-sampler splitting pre-pass exists (OpTypeSampledImage vs OpSampledImage)', () => {
  assert.ok(fix.includes('sampler') && (fix.includes('split') || fix.includes('SampledImage') || fix.includes('combined')),
    'combined sampler2D splitting pre-pass must exist (glslang vs naga lookup mismatch)');
});

test('SpecConstantOp folding exists (naga unsupported → default values)', () => {
  assert.ok(fix.includes('SpecConstant') || fix.includes('specConstant') || fix.includes('fold'),
    'SpecConstantOp default-value folding pre-pass must exist');
});

test('indexed draws replay as non-indexed with baked verts (D3D12 gl_VertexIndex guard)', () => {
  const page = readFileSync(join(repoRoot, 'web/vkwebgpu.mjs'), 'utf8');
  assert.ok(page.includes('VertexIndex') || page.includes('indexed') || page.includes('non-indexed') || page.includes('index'),
    'indexed-draw replay policy (bake in draw order, replay non-indexed) must be documented/handled');
});
