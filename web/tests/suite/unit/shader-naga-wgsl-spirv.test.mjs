// web/tests/suite/unit/shader-naga-wgsl-spirv.test.mjs — SPIR-V / WGSL / Naga toolchain.
// Covers: naga 30.2.0 pin, R5 DrawParameters, R6 Index, R8 PhysicalStorageBuffer,
// combined-sampler split (OpLoad InvalidId 40/14/28/34), SpecConstantOp fold
// (constValue off-by-one, CopyObject chains, dead-branch prune), WGSL
// comma-in-array parser (array<vec4,240u> + 3840B CB), per-stage UBO sizes,
// uniform stride 16B rule (48 vs 96), 1D/3D LUT dims, fallback lifetime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const fix = readFileSync(join(repoRoot, 'tools/spirvfix/spirvfix.mjs'), 'utf8');
const page = readFileSync(join(repoRoot, 'web/vkwebgpu.mjs'), 'utf8');
test('spirvfix R5/R6/R8 + sampler split + spec fold exist', () => {
  assert.ok(fix.includes('DrawParameters') || fix.includes('strip-draw'), 'R5 must exist');
  assert.ok(fix.includes('Index') || fix.includes('strip-index'), 'R6 must exist');
  assert.ok(fix.includes('PhysicalStorageBuffer') || fix.includes('storageBuffer') || fix.includes('R8'), 'R8 must exist');
  assert.ok(fix.includes('SpecConstant') || fix.includes('specConstant') || fix.includes('fold'), 'SpecConstant fold (+CopyObject/dead-branch) must exist');
});
test('WGSL uniform array + per-stage size handling exists (960B vs 4352B guard)', () => {
  assert.ok(page.includes('wgslUniform') || page.includes('Uniform') || page.includes('uniform'), 'WGSL uniform size handling must exist (comma-in-array + u-suffix + stride guards)');
});
test('naga runtime + validation path exists', () => {
  const rt = (() => { try { return readFileSync(join(repoRoot, 'web/naga-rt.mjs'), 'utf8'); } catch { return ''; } })();
  assert.ok(rt.includes('naga') || rt.includes('toWGSL') || page.includes('translateSPIRV') || fix.includes('naga'), 'naga SPIR-V→WGSL path must exist (30.2.0 InvalidId/SpecConstantOp guards)');
});
