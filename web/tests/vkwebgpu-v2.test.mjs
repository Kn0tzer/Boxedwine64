
// web/tests/vkwebgpu-v2.test.mjs — schema v2 (binary framed records) tests for
// the page tier's pure half: chunk framing, the frame assembler, record
// decoding, the streaming queue, and the WGSL transforms. No WebGPU and no
// browser: the fixtures below are built by a small LE writer that mirrors the
// C++ ChunkWriter field-for-field (tasks/schema-v2.md §3), so these tests pin
// the documented wire layout, not the module's own writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  V2_MAGIC, V2_VERSION, V2_REC, V2_QUEUE_CAP, V2_PUSH_GROUP, V2_PUSH_BINDING, V2_PUSH_SIZE,
  parseV2Chunk, V2FrameAssembler, V2FrameQueue, decodeV2Frame,
  rewritePushConstantsWGSL, scanWgslResources, v2PickSampleCount,
  v2TextureFormat, v2VertexFormat, v2Hex64,
  v2TargetKey, v2ImageTargetKey, v2ImageKnown, V2_UNKNOWN_IMAGE,
} from '../vkwebgpu.mjs';

// --- LE fixture writer (mirrors the C++ ChunkWriter) ---
class W {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 255); return this; }
  u16(v) { this.b.push(v & 255, (v >> 8) & 255); return this; }
  u32(v) { for (let i = 0; i < 4; i++) this.b.push((v >>> (8 * i)) & 255); return this; }
  u64(lo, hi = 0) { this.u32(lo); this.u32(hi); return this; }
  f32(v) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i)); return this; }
  bytes(u8) { for (const x of u8) this.b.push(x); return this; }
  buf() { return new Uint8Array(this.b); }
}
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const rec = (type, payload) => cat(new W().u16(type).u16(0).u32(payload.length).buf(), payload);
const chunk = (seq, more, ...records) =>
  cat(new W().u32(V2_MAGIC).u16(V2_VERSION).u16(more ? 1 : 0).u32(seq).u32(0).buf(), ...records);

// A DXVK-shaped frame: MSAA colour + depth attachments, vs+fs, a pipeline
// with a vertex layout, two descriptor sets (one with a 3-element sampled
// image array), push constants, indexed draw.
function dxvkFrame(frameNo = 7) {
  const vsHash = new W().u64(0x84bf0791, 0x59496e66).buf(); // 59496e6684bf0791
  const fsHash = new W().u64(0xbeefd8c1, 0x88f8a5ce).buf(); // 88f8a5cebeefd8c1
  const R = [];
  R.push(rec(V2_REC.FRAME_BEGIN, new W().u32(frameNo).u32(800).u32(600).u32(0).buf()));
  // render pass: 4x MSAA colour + depth
  R.push(rec(V2_REC.RP_BEGIN, cat(
    new W().u64(0x11).u64(0x22).u32(800).u32(600).u32(2).buf(),
    new W().u32(44).u32(1).u32(0).u32(4).u32(0).buf(),   // B8G8R8A8_UNORM, clear, store, 4x, colour
    new W().u32(129).u32(1).u32(1).u32(4).u32(1).buf(),  // D24S8, clear, discard, 4x, depth
    new W().f32(0.1).f32(0.2).f32(0.3).f32(1).f32(1).u32(0).buf(),
    new W().u64(0xc0ffee).u64(0x1111).u64(0xdead).u64(0x2222).buf() // per-attachment {viewId, imageId} identity tail
  )));
  R.push(rec(V2_REC.SHADER, cat(new W().u8(0).u8(0).u16(0).buf(), vsHash, new W().u32(4).buf(), new Uint8Array([1, 2, 3, 4]))));
  R.push(rec(V2_REC.SHADER, cat(new W().u8(1).u8(0).u16(0).buf(), fsHash, new W().u32(4).buf(), new Uint8Array([5, 6, 7, 8]))));
  R.push(rec(V2_REC.PIPELINE, cat(
    new W().u64(0x99).buf(), vsHash, fsHash,
    new W().u32(3).u32(2).u32(0).u32(1).u32(1).u32(3).u32(1).buf(), // tri-list, back, ccw, depth on, write, less-equal, blend
    new W().u32(1).u32(2).buf(),                                    // 1 vb, 2 attribs
    new W().u32(0).u32(32).u32(0).buf(),                           // binding 0, stride 32, per-vertex
    new W().u32(0).u32(0).u32(106).u32(0).buf(),                   // loc 0, binding 0, R32G32B32_SFLOAT, off 0
    new W().u32(1).u32(0).u32(106).u32(12).buf()                   // loc 1, binding 0, R32G32B32_SFLOAT, off 12
  )));
  R.push(rec(V2_REC.BIND_SETS, cat(new W().u8(0).u8(2).u16(0).buf(), new W().u64(0xa1).u64(0xa2).buf())));
  // set 0: uniform buffer + 3-element sampled-image array + sampler
  R.push(rec(V2_REC.DESC_SET, cat(
    new W().u8(0).u8(3).u16(0).u64(0x1eaf).buf(),
    new W().u32(0).u32(6).u32(0).u32(1).u8(1).u8(0).u16(0).u64(0xb001).u64(128).u64(0).buf(),   // binding 0: UBO
    new W().u32(1).u32(2).u32(0).u32(3).u8(2).u8(0).u16(0).u64(0x9e9).u64(0).u64(0).buf(),       // binding 1: 3 sampled images
    new W().u32(2).u32(0).u32(0).u32(1).u8(3).u8(0).u16(0).u64(0x5a5a).u64(0).u64(0).buf()       // binding 2: sampler
  )));
  R.push(rec(V2_REC.DESC_SET, cat(
    new W().u8(1).u8(1).u16(0).u64(0x2eaf).buf(),
    new W().u32(0).u32(1000138000).u32(0).u32(16).u8(4).u8(0).u16(0).u64(0xdead).u64(16).u64(0).buf() // inline uniform block
  )));
  R.push(rec(V2_REC.BUFFER_DATA, cat(new W().u64(0xb001).u64(0).u32(8).buf(), new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]))));
  R.push(rec(V2_REC.IMAGE_DATA, cat(
    new W().u64(0x9e9).u64(0x1111).u32(4).u32(4).u32(37).u32(64).buf(), new Uint8Array(64).fill(7)
  )));
  R.push(rec(V2_REC.SAMPLER, new W().u64(0x5a5a).u32(1).u32(1).u32(1).u32(2).u32(2).f32(4).buf()));
  R.push(rec(V2_REC.PUSH, cat(new W().u32(0).u32(16).u32(0x1f).buf(), new Uint8Array(16).fill(0xaa))));
  R.push(rec(V2_REC.PUSH, cat(new W().u32(16).u32(16).u32(0x1f).buf(), new Uint8Array(16).fill(0xbb))));
  R.push(rec(V2_REC.VIEWPORT, new W().f32(0).f32(0).f32(800).f32(600).f32(0).f32(1).buf()));
  R.push(rec(V2_REC.SCISSOR, new W().u32(0).u32(0).u32(800).u32(600).buf()));
  R.push(rec(V2_REC.VERTEX_BIND, cat(new W().u8(1).u8(0).u16(0).buf(), new W().u32(0).u64(0xc001).u64(0).buf())));
  R.push(rec(V2_REC.BUFFER_DATA, cat(new W().u64(0xc001).u64(0).u32(96).buf(), new Uint8Array(96).fill(3))));
  R.push(rec(V2_REC.INDEX_BIND, new W().u64(0xc002).u64(0).u32(1).buf()));
  R.push(rec(V2_REC.BUFFER_DATA, cat(new W().u64(0xc002).u64(0).u32(12).buf(), new Uint8Array(12).fill(5))));
  R.push(rec(V2_REC.DRAW, new W().u32(0).u32(1).u32(0).u32(0).u8(1).u8(0).u16(0).u32(36).u32(0).u32(0).buf()));
  R.push(rec(V2_REC.INLINE_BYTES, cat(new W().u8(1).u8(0).u16(0).buf(), new W().u32(0).u32(0).u32(16).buf(), new Uint8Array(16).fill(0xcc))));
  R.push(rec(V2_REC.RP_END, new Uint8Array(0)));
  R.push(rec(V2_REC.FRAME_END, new W().u32(frameNo).buf()));
  return R;
}

// ---------------------------------------------------------------- framing
test('a well-formed chunk parses: header fields and record splitting', () => {
  const records = dxvkFrame();
  const c = parseV2Chunk(chunk(41, true, ...records));
  assert.equal(c.seq, 41);
  assert.equal(c.more, true);
  assert.equal(c.records.length, records.length);
  assert.equal(c.records[0].type, V2_REC.FRAME_BEGIN);
  assert.equal(c.records[c.records.length - 1].type, V2_REC.FRAME_END);
});

test('malformed chunks are rejected with a reason', () => {
  const good = dxvkFrame();
  const badMagic = chunk(0, false, ...good); badMagic[0] = 0x00;
  assert.throws(() => parseV2Chunk(badMagic), /bad magic/);
  const badVer = chunk(0, false, ...good); badVer[4] = 0x03;
  assert.throws(() => parseV2Chunk(badVer), /version/);
  assert.throws(() => parseV2Chunk(new Uint8Array(8)), /size out of range/);
  assert.throws(() => parseV2Chunk('nope'), /not bytes/);
  // truncated record payload (cut mid-record: header 16 + rec header 8 + 6 payload bytes)
  const cut = chunk(0, false, ...good).subarray(0, 30);
  assert.throws(() => parseV2Chunk(cut), /truncat/);
  // unknown record type
  const unk = rec(0x13, new Uint8Array(4));
  assert.throws(() => parseV2Chunk(chunk(0, false, unk)), /unknown record type/);
  // declared length overruns the chunk
  const lie = new W().u16(V2_REC.PUSH).u16(0).u32(9999).buf();
  assert.throws(() => parseV2Chunk(chunk(0, false, lie)), /truncated/);
});

// ---------------------------------------------------------------- assembler
test('the assembler seals a frame split across chunks via MORE', () => {
  const records = dxvkFrame();
  const mid = 9;
  const asm = new V2FrameAssembler();
  assert.equal(asm.ingest(parseV2Chunk(chunk(10, true, ...records.slice(0, mid)))), null);
  const frame = asm.ingest(parseV2Chunk(chunk(11, false, ...records.slice(mid))));
  assert.ok(frame);
  assert.equal(frame.length, records.length);
  assert.equal(asm.gaps, 0);
});

test('a sequence gap drops the partial frame and counts the gap', () => {
  const records = dxvkFrame();
  const asm = new V2FrameAssembler();
  asm.ingest(parseV2Chunk(chunk(20, true, ...records.slice(0, 5))));
  const frame = asm.ingest(parseV2Chunk(chunk(22, false, ...records.slice(5)))); // seq 21 lost
  assert.equal(frame, null, 'partial frame after a gap is dropped, not rendered');
  assert.equal(asm.gaps, 1);
  assert.equal(asm.droppedPartials, 1);
  // the next clean frame still assembles
  const ok = asm.ingest(parseV2Chunk(chunk(23, false, ...dxvkFrame(8))));
  assert.ok(ok);
});

test('records outside a frame are ignored, not fatal', () => {
  const asm = new V2FrameAssembler();
  const stray = rec(V2_REC.PUSH, cat(new W().u32(0).u32(4).u32(0).buf(), new Uint8Array(4)));
  assert.equal(asm.ingest(parseV2Chunk(chunk(30, false, stray))), null);
});

// ---------------------------------------------------------------- decode
const frameRecords = R => parseV2Chunk(chunk(0, false, ...R)).records;

test('a DXVK-shaped frame decodes to the render model', () => {
  const frame = decodeV2Frame(frameRecords(dxvkFrame()));
  assert.equal(frame.frameNo, 7);
  assert.equal(frame.width, 800);
  assert.equal(frame.height, 600);
  assert.equal(frame.passes.length, 1);
  const [pass] = frame.passes;
  assert.equal(pass.attachments.length, 2);
  assert.equal(pass.attachments[0].samples, 4, 'MSAA sample count survives the hop');
  assert.equal(pass.attachments[1].isDepth, 1);
  assert.equal(pass.attachments[0].viewId, '0000000000c0ffee', 'attachment view identity survives the hop');
  assert.equal(pass.attachments[0].imageId, '0000000000001111');
  assert.equal(pass.attachments[1].viewId, '000000000000dead');
  assert.equal(pass.attachments[1].imageId, '0000000000002222');
  // Alias join: the sampled view 0x9e9 resolves to the same image as the colour attachment.
  assert.equal(frame.views.get('00000000000009e9'), pass.attachments[0].imageId);
  assert.deepEqual(pass.clearColor, [0.10000000149011612, 0.20000000298023224, 0.30000001192092896, 1]);

test('render-target cache keys alias by VkImage identity', () => {
  const frame = decodeV2Frame(frameRecords(dxvkFrame()));
  const [pass] = frame.passes;
  const [colour, depth] = pass.attachments;
  // Identity-keyed: the fixture tail names image 0x1111 (colour) and 0x2222 (depth).
  assert.equal(v2TargetKey(colour.imageId, 800, 600, 1, false), 'img:0000000000001111');
  assert.equal(v2TargetKey(depth.imageId, 800, 600, 4, true), 'imgd:0000000000002222');
  assert.equal(v2ImageTargetKey('0000000000001111', false), 'img:0000000000001111');
  // Same image, different geometry or naming view -> same key: that is the alias.
  assert.equal(v2TargetKey('0000000000001111', 1024, 768, 1, false), 'img:0000000000001111');
  assert.equal(v2TargetKey('0000000000001111', 800, 600, 4, false), 'img:0000000000001111');
  // Unknown identity falls back to the geometry keys, byte-identical to the old scheme.
  assert.equal(v2TargetKey(V2_UNKNOWN_IMAGE, 800, 600, 1, false), 'c800x600x1');
  assert.equal(v2TargetKey(undefined, 800, 600, 4, false), 'c800x600x4');
  assert.equal(v2TargetKey('0000000000000000', 800, 600, 4, true), 'd800x600x4');
  assert.equal(v2TargetKey(null, 800, 600, 4, false), 'c800x600x4', 'MSAA texture stays geometry-keyed');
  assert.ok(!v2ImageKnown(V2_UNKNOWN_IMAGE) && !v2ImageKnown(undefined) && !v2ImageKnown(null));
  assert.ok(v2ImageKnown('0000000000001111'));
});

  assert.equal(frame.shaders.size, 2);
  assert.ok(frame.shaders.has('59496e6684bf0791'));
  assert.ok(frame.shaders.has('88f8a5cebeefd8c1'));

  const pipe = frame.pipelines.get('0000000000000099');
  assert.equal(pipe.topology, 3);
  assert.equal(pipe.vb.length, 1);
  assert.equal(pipe.vb[0].stride, 32);
  assert.equal(pipe.va.length, 2);
  assert.equal(pipe.va[1].format, 106, 'R32G32B32_SFLOAT layout travels with the pipeline');

  const ops = pass.ops.map(o => o.op);
  assert.deepEqual(ops, ['bindPipe', 'bindSets', 'descSet', 'descSet', 'push', 'push',
    'viewport', 'scissor', 'vbind', 'ibind', 'draw', 'inline']);

  const ds0 = pass.ops.find(o => o.op === 'descSet' && o.setIndex === 0);
  assert.equal(ds0.bindings.length, 3);
  const arr = ds0.bindings.find(b => b.binding === 1);
  assert.equal(arr.count, 3, 'descriptor array geometry is explicit, not collapsed to element 0');
  assert.equal(arr.dstArrayElement, 0);
  assert.equal(arr.kind, 2);

  const pushes = pass.ops.filter(o => o.op === 'push');
  assert.equal(pushes[0].offset, 0);
  assert.equal(pushes[1].offset, 16);
  assert.equal(pushes[0].bytes[0], 0xaa);
  assert.equal(pushes[1].bytes[0], 0xbb, 'push order is preserved for the overlay');

  const vb = pass.ops.find(o => o.op === 'vbind');
  assert.equal(vb.binds[0].buf, '000000000000c001');
  const ib = pass.ops.find(o => o.op === 'ibind');
  assert.equal(ib.indexType, 1, 'uint32 index type');

  const draw = pass.ops.find(o => o.op === 'draw');
  assert.equal(draw.indexed, true);
  assert.equal(draw.indexCount, 36);
  assert.equal(draw.vertexOffset, 0);

  assert.equal(frame.buffers.get('000000000000b001').length, 8);
  const img = frame.images.get('0000000000001111');
  assert.equal(img.w, 4);
  assert.equal(img.pixels.length, 64);
  assert.equal(frame.views.get('00000000000009e9'), '0000000000001111', 'view->image link resolves');
  assert.equal(frame.samplers.get('0000000000005a5a').mag, 'linear');
});

test('malformed frames are rejected with a reason', () => {
  const R = dxvkFrame();
  // overflow flag
  const ovf = R.slice();
  ovf[0] = rec(V2_REC.FRAME_BEGIN, new W().u32(7).u32(800).u32(600).u32(1).buf());
  assert.throws(() => decodeV2Frame(frameRecords(ovf)), /overflow/);
  // FRAME_BEGIN/FRAME_END number mismatch
  const mm = R.slice();
  mm[mm.length - 1] = rec(V2_REC.FRAME_END, new W().u32(8).buf());
  assert.throws(() => decodeV2Frame(frameRecords(mm)), /mismatch/);
  // not starting with FRAME_BEGIN
  assert.throws(() => decodeV2Frame(frameRecords(R).slice(1)), /FRAME_BEGIN/);
  // zero-size frame
  const zero = R.slice();
  zero[0] = rec(V2_REC.FRAME_BEGIN, new W().u32(7).u32(0).u32(600).u32(0).buf());
  assert.throws(() => decodeV2Frame(frameRecords(zero)), /size out of range/);
  // trailing bytes in a record payload
  const typeOf = r => new DataView(r.buffer, r.byteOffset, r.byteLength).getUint16(0, true);
  const pi = R.findIndex(r => typeOf(r) === V2_REC.PUSH);
  assert.ok(pi >= 0, 'fixture has a PUSH record');
  const badPush = cat(new W().u32(0).u32(4).u32(0).buf(), new Uint8Array(4), new Uint8Array([0xff]));
  const R2 = R.slice(); R2[pi] = rec(V2_REC.PUSH, badPush);
  assert.throws(() => decodeV2Frame(frameRecords(R2)), /trailing bytes/);
  // PUSH past the 256-byte block
  const big = R.slice(); big[pi] = rec(V2_REC.PUSH, cat(new W().u32(250).u32(16).u32(0).buf(), new Uint8Array(16)));
  assert.throws(() => decodeV2Frame(frameRecords(big)), /PUSH out of range/);
});

// ---------------------------------------------------------------- queue
test('V2FrameQueue drops the oldest past its cap', () => {
  const q = new V2FrameQueue(3);
  for (let i = 0; i < 5; i++) q.push({ frameNo: i });
  assert.equal(q.size, 3);
  assert.equal(q.dropped, 2);
  assert.deepEqual(q.q.map(f => f.frameNo), [2, 3, 4]);
});

test('takeLatest returns the newest and drains the queue', () => {
  const q = new V2FrameQueue();
  q.push({ frameNo: 1 }); q.push({ frameNo: 2 });
  assert.equal(q.takeLatest().frameNo, 2);
  assert.equal(q.size, 0);
  assert.equal(q.takeLatest(), null);
});

test('clear drains the queue for the resize hook', () => {
  const q = new V2FrameQueue();
  q.push({ frameNo: 1 });
  q.clear();
  assert.equal(q.size, 0);
  assert.equal(V2_QUEUE_CAP, 3, 'consumer cap is 3 frames per the design doc');
});

// ---------------------------------------------------------------- transforms
test('push-constant WGSL is rewritten to the reserved group-3 UBO', () => {
  const wgsl = `
@group(0) @binding(0) var<uniform> ubo : Ubo;
@group(1) @binding(2) var<push_constant> pc : PushBlock;
@fragment fn main() -> @location(0) vec4f { return vec4f(pc.color, 1.0); }`;
  const { code, pushBlocks } = rewritePushConstantsWGSL(wgsl);
  assert.equal(pushBlocks, 1);
  assert.match(code, /@group\(3\) @binding\(0\)\s*var<uniform> pc : PushBlock;/);
  assert.doesNotMatch(code, /push_constant/);
  assert.match(code, /@group\(0\) @binding\(0\) var<uniform> ubo/);
  assert.equal(V2_PUSH_GROUP, 3);
  assert.equal(V2_PUSH_BINDING, 0);
  assert.equal(V2_PUSH_SIZE, 256);
});

test('scanWgslResources honours naga binding assignment, incl. binding arrays', () => {
  const wgsl = `
@group(0) @binding(0) var<uniform> ubo : Ubo;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;
@group(1) @binding(0) var arr : binding_array<texture_2d<f32>, 3>;
@group(3) @binding(0) var<uniform> pc : PushBlock;`;
  const decls = scanWgslResources(wgsl);
  assert.equal(decls.length, 5);
  const tex = decls.find(d => d.name === 'tex');
  assert.equal(tex.binding, 1);
  const samp = decls.find(d => d.name === 'samp');
  assert.equal(samp.binding, 1, 'texture+sampler may share a binding');
  const arr = decls.find(d => d.name === 'arr');
  assert.equal(arr.arrayCount, 3);
  assert.equal(arr.group, 1);
});

test('MSAA sample counts clamp to what WebGPU guarantees', () => {
  assert.equal(v2PickSampleCount(0), 1);
  assert.equal(v2PickSampleCount(1), 1);
  assert.equal(v2PickSampleCount(2), 4);
  assert.equal(v2PickSampleCount(4), 4);
  assert.equal(v2PickSampleCount(16), 4);
});

test('format maps cover the DXVK set and count the unknown', () => {
  assert.equal(v2TextureFormat(44), 'bgra8unorm');   // B8G8R8A8_UNORM: the D3D9 backbuffer
  assert.equal(v2TextureFormat(37), 'rgba8unorm');
  assert.equal(v2TextureFormat(129), 'depth24plus-stencil8');
  const counters = {};
  assert.equal(v2TextureFormat(9999, counters), 'rgba8unorm');
  assert.equal(counters.unknownFormats, 1);
  assert.equal(v2VertexFormat(106), 'float32x3');
  assert.equal(v2VertexFormat(37), 'unorm8x4');
  assert.equal(v2VertexFormat(9999), null);
});

test('v2Hex64 matches the host %016llx hash formatting', () => {
  assert.equal(v2Hex64(0x88f8a5cebeefd8c1n), '88f8a5cebeefd8c1');
  assert.equal(v2Hex64(0n), '0000000000000000');
});
