// web/vkwebgpu.test.mjs — offline tests for the vk64 PAGE TIER's pure half: the
// frame-manifest decoder. No WebGPU and no browser: parseManifest() is what the
// bridge's MAIN_THREAD_EM_ASM hop feeds, so its tolerance (the host serializer
// leaves the vs/fs wrapper objects unterminated) and its rejections are the
// contract between source/vulkan/vk64bridge.cpp and web/vkwebgpu.mjs.
//
// Fixtures are built from the exact shape the bridge emits (tasks/p1-final.md
// §2.6 + serializeSubmit), including one real 64x64 manifest captured from the
// vk64 run in test-results/vk-console.log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, MAX_DIMENSION } from '../vkwebgpu.mjs';

const b64 = (n, fill) => Buffer.alloc(n, fill).toString('base64');
const blob = (b64s, size) => ({ size, b64: b64s });

function manifest(over = {}) {
  return {
    frame: 0, width: 64, height: 64, overflow: false, colorFormat: 'R8G8B8A8_UNORM',
    clearColor: [0.2, 0.2, 0.2, 0.2], clearDepth: 1, viewport: [0, 0, 64, 64, 0, 1],
    scissor: [0, 0, 64, 64], cull: 2, front: 0, depthTest: 1, depthWrite: 1, depthOp: 3,
    vs: { hash: '59496e6684bf0791', spv: blob(b64(1560, 2), 1560) },
    fs: { hash: '88f8a5cebeefd8c1', spv: blob(b64(1280, 3), 1280) },
    ubo: blob(b64(128, 0), 128),
    texture: { w: 4, h: 4, format: 'R8G8B8A8_UNORM', staged: true, pixels: blob(b64(64, 7), 64) },
    sampler: { mag: 0, min: 0, mipmap: 0, addrU: 2, addrV: 2, maxAniso: 1 },
    draws: [{ vertexCount: 36, firstVertex: 0 }],
    ...over,
  };
}
// The host writes `jsonBlob(...); j += ","` after the vs/fs objects, so the real
// wire text is missing the '}' that closes each of them: drop one brace after
// every inline spv blob to reproduce the bytes vk64Bridge hops into the page.
function unterminated(m) {
  return JSON.stringify(m).replace(/("spv":\{"size":\d+,"b64":"[^"]*"\})\},/g, '$1,');
}

test('a well-formed manifest decodes to the WebGPU state the renderer needs', () => {
  const m = parseManifest(JSON.stringify(manifest()));
  assert.equal(m.width, 64);
  assert.equal(m.cull, 'back');            // VK_CULL_MODE_BACK_BIT
  assert.equal(m.front, 'ccw');            // VK_FRONT_FACE_COUNTER_CLOCKWISE
  assert.equal(m.depthOp, 'less-equal');   // VK_COMPARE_OP_LESS_OR_EQUAL
  assert.equal(m.depthTest, true);
  assert.equal(m.depthWrite, true);
  assert.equal(m.clear[0], 0.2);
  assert.equal(m.viewport.length, 6);
  assert.deepEqual(m.scissor, [0, 0, 64, 64]);
  assert.equal(m.texture.format, 'rgba8unorm');   // R8G8B8A8_UNORM
  assert.equal(m.sampler.mag, 'nearest');          // VK_FILTER_NEAREST
  assert.equal(m.sampler.addrU, 'clamp-to-edge');  // VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE
  assert.equal(m.ubo.length, 128);
  assert.equal(m.texture.pixels.length, 64);
  assert.equal(m.vs.code.length, 1560);
  assert.equal(m.fs.code.length, 1280);
  assert.deepEqual(m.draws, [{ vertexCount: 36, firstVertex: 0 }]);
});

test("the host's unterminated vs/fs objects are repaired", () => {
  const wire = unterminated(manifest());
  assert.throws(() => JSON.parse(wire), 'fixture must really be invalid JSON');
  const m = parseManifest(wire);
  assert.equal(m.vs.code.length, 1560);
  assert.equal(m.fs.code.length, 1280);
  assert.equal(m.ubo.length, 128);
});

test('the repair is a no-op once the host closes the objects', () => {
  const m = parseManifest(JSON.stringify(manifest()));
  assert.equal(m.vs.hash, '59496e6684bf0791');
  assert.equal(m.draws[0].vertexCount, 36);
});

test('a depth-test-free frame drops the depth attachment', () => {
  const m = parseManifest(JSON.stringify(manifest({ depthTest: 0, depthWrite: 1 })));
  assert.equal(m.depthTest, false);
  assert.equal(m.depthWrite, false, 'Vulkan forbids depth writes without a depth test');
});

test('an overflowed frame is rejected rather than rendered', () => {
  assert.throws(() => parseManifest(JSON.stringify(manifest({ overflow: true }))), /overflow/);
});

test('garbage manifests are rejected with a reason', () => {
  assert.throws(() => parseManifest('not json'), /not valid JSON/);
  assert.throws(() => parseManifest(JSON.stringify([1, 2])), /not an object/);
  assert.throws(() => parseManifest(JSON.stringify(manifest({ width: 0 }))), /frame size/);
  assert.throws(() => parseManifest(JSON.stringify(manifest({ width: MAX_DIMENSION + 1 }))), /frame size/);
  assert.throws(() => parseManifest(JSON.stringify(manifest({ scissor: [0, 0, 65, 64] }))), /scissor/);
  assert.throws(() => parseManifest(JSON.stringify(manifest({ clearColor: [0, 0, 0] }))), /clearColor/);
  assert.throws(() => parseManifest(JSON.stringify(manifest({ draws: [{ vertexCount: -1, firstVertex: 0 }] }))), /draw range/);
  // A blob whose declared size disagrees with its payload is a truncated frame.
  const bad = manifest();
  bad.ubo = { size: 256, b64: b64(128, 0) };
  assert.throws(() => parseManifest(JSON.stringify(bad)), /size does not match/);
});

test('missing optional payloads degrade instead of throwing', () => {
  const m = parseManifest(JSON.stringify(manifest({ ubo: null, texture: { w: 0, h: 0, format: 'UNKNOWN', pixels: null }, vs: null })));
  assert.equal(m.ubo, null);
  assert.equal(m.vs, null);
  assert.equal(m.texture.pixels, null);
  assert.equal(m.viewport.length, 6, 'a null viewport falls back to the whole frame');
});
