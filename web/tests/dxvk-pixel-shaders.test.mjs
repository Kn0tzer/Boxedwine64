import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applySpirvFix, parseSpirv, serializeSpirv } from '../../tools/spirvfix/spirvfix.mjs';
import { createShaderCache, rewritePushConstantsWGSL } from '../vkwebgpu.mjs';
import * as naga from '../vendor/naga/node.js';
const present = new Uint8Array(readFileSync(new URL('../../testdata/spirv/dxvk-live/present.frag.spv', import.meta.url)));
test('real DXVK SPIR-V 1.6 combined samplers preserve entrypoint interfaces', () => {
  const fixed = applySpirvFix(present);
  assert.doesNotThrow(() => naga.translate({ from: 'spirv', to: 'wgsl', source: fixed.bytes }));
  const twice = applySpirvFix(fixed.bytes);
  assert.deepEqual(twice.bytes, fixed.bytes);
  assert.deepEqual(twice.applied, []);
});
const live = name => new Uint8Array(readFileSync(new URL('../../testdata/spirv/dxvk-live/' + name, import.meta.url)));
test('real triangle shaders translate only with non-point raster context', () => {
  for (const name of ['tri9.vert.spv', 'tri9.frag.spv']) {
    const raw = live(name);
    assert.doesNotThrow(() => naga.translate({ from: 'spirv', to: 'wgsl', source: applySpirvFix(raw, { rasterTopology: 3 }).bytes }), name);
    for (const options of [{}, { rasterTopology: 0 }, { rasterTopology: 99 }])
      assert.throws(() => naga.translate({ from: 'spirv', to: 'wgsl', source: applySpirvFix(raw, options).bytes }), /PointSize|PointCoord|Demote/, name);
  }
});

test('demote with continuing shader computation retains strict rejection', () => {
  const module = parseSpirv(live('tri9.frag.spv'));
  const demote = module.insns.findIndex(i => i.op === 5380);
  const value = module.insns.find(i => i.op === 44);
  const id = module.header.bound++;
  module.insns.splice(demote + 1, 0, { op: 83, words: [value.resultType, id, value.resultId], resultType: value.resultType, resultId: id });
  const fixed = applySpirvFix(serializeSpirv(module), { rasterTopology: 3 });
  assert.ok(!fixed.applied.includes('tail-demote-to-kill'));
  assert.throws(() => naga.translate({ from: 'spirv', to: 'wgsl', source: fixed.bytes }), /Demote/);
});
test('shader cache separates non-point translation from point and unknown contexts', async () => {
  const code = live('tri9.vert.spv'), cache = createShaderCache({ log() {} });
  const shader = { code, size: code.length, hash: 'real-dxvk-tri9-vs' };
  assert.ok(await cache.get('vertex', shader, { rasterTopology: 3 }));
  assert.equal(await cache.get('vertex', shader, { rasterTopology: 0 }), null);
  assert.equal(await cache.get('vertex', shader), null);
});
test('real naga immediate declarations become one shared push UBO per stage', () => {
  for (const name of ['tri9.vert.spv', 'tri9.frag.spv', 'present.vert.spv', 'present.frag.spv']) {
    const wgsl = naga.translate({ from: 'spirv', to: 'wgsl', source: applySpirvFix(live(name), { rasterTopology: 3 }).bytes });
    const rewritten = rewritePushConstantsWGSL(wgsl);
    assert.equal(rewritten.pushBlocks, name === 'present.vert.spv' ? 0 : 1, name);
    assert.doesNotMatch(rewritten.code, /var<immediate>|var<push_constant>/);
    if (rewritten.pushBlocks) assert.match(rewritten.code, /@group\(3\) @binding\(0\) var<uniform>/);
    assert.equal(rewritePushConstantsWGSL(rewritten.code).pushBlocks, 0);
  }
});
