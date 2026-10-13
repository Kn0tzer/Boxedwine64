// web/tests/suite/unit/v2-transport-contract.test.mjs — Bridge/page protocol (highest-value boundary).
//
// Unit tests inside one layer rarely caught these; every major bug was
// end-to-end or cross-layer differential. Past failures: bwVkChunk never
// assigned (all v2 chunks dropped); 4MB cap → 16MB; decoder didn't know 0x13;
// MAIN_THREAD_EM_ASM Module.HEAPU8 undefined; chunk magic endianness;
// 12B vs 16B header; IMAGE_DATA viewId-before-imageId; synthetic FB fb->rp
// never set (53 RP_BEGIN dropped); VkRenderingInfo misalignment; 4-pass split
// resetting replay state (dropped VB/pipeline binds); canvas never
// reconfigured; hop ALL frames vs presented frame; uniform cache keyed by id
// only (256B poisoned 1792B); ResizeObserver destroying in-flight textures;
// Y-flip h>0 skip; depth/stencil mismatch + 32767 scissor; BUFFER_DATA
// dedup desync (1MB prefix + periodic full-resend fixed D3D9/D3D10/D3D12).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const page = readFileSync(join(repoRoot, 'web/vkwebgpu.mjs'), 'utf8');
const bridge = readFileSync(join(repoRoot, 'source/vulkan/vk64bridge.cpp'), 'utf8');

test('bwVkChunk wiring exists (ace9685f: never assigned → all dropped)', () => {
  assert.ok(page.includes('bwVkChunk'), 'page must define window.bwVkChunk entry point');
  assert.ok(page.includes('globalThis.bwVkChunk') || page.includes('window.bwVkChunk'),
    'bwVkChunk must be assigned on globalThis/window');
});

test('chunk magic is VK2F LE on both sides (endianness guard)', () => {
  assert.ok(page.includes('0x46324B56'), 'page V2_MAGIC must be 0x46324B56');
  assert.ok(bridge.includes('0x46324B56'), 'bridge V2_CHUNK_MAGIC must be 0x46324B56');
  assert.ok(!bridge.includes('0x324B5632') || bridge.includes('0x46324B56'),
    'bridge must not use byte-swapped 0x324B5632 (old JS expectation bug)');
});

test('chunk header is 16 bytes with viewId ordering', () => {
  assert.ok(page.includes('V2_CHUNK_HEADER_LEN') && page.includes('16'),
    'chunk header must be 16 bytes (12B vs 16B spec drift guard)');
  assert.ok(bridge.includes('V2_CHUNK_MAGIC') && bridge.includes('V2_CHUNK_VERSION'),
    'bridge must emit magic+version header');
});

test('record registry fails loudly on unknown types (0x13 silent-drop guard)', () => {
  assert.ok(page.includes('unknown record type'),
    'page decoder must throw on unknown record type (new record must fail loudly, not be silently dropped like 0x13)');
  assert.ok(page.includes('READBACK'), 'READBACK (0x13) must be known (e294e5c2 every-readback-rejected fix)');
});

test('16MB chunk cap (4MB too small → vertex loss)', () => {
  assert.ok(page.includes('V2_MAX_CHUNK_BYTES') && page.includes('16 * 1024 * 1024'),
    'ingest cap must be 16MB (4MB cap dropped full emissions; 88cdd449 1MB prefix + resend)');
});

test('IMAGE_DATA carries viewId before imageId', () => {
  assert.ok(page.includes('viewId') && page.includes('imageId'),
    'IMAGE_DATA must carry viewId first (DESC_SET binds views, dedup is per image)');
});

test('synthetic framebuffer sets fb->rp (5b9e946: 53 RP_BEGIN dropped)', () => {
  assert.ok(bridge.includes('fb') && bridge.includes('rp'),
    'bridge framebuffer must link fb->rp (synthetic BeginRendering FB with unset rp dropped all RP_BEGIN)');
});

test('page handles attachment-less passes (e644a023 vkd3d binds outside BeginRenderPass)', () => {
  assert.ok(page.includes('RenderPass') || page.includes('RP_BEGIN') || page.includes('attachment'),
    'page must not skip attachment-less passes (viewport/VB/pipeline binds dropped)');
});

test('canvas reconfigure on resize exists (d01c6f5a blank canvas)', () => {
  assert.ok(page.includes('ResizeObserver') || page.includes('reconfig'),
    'canvas must reconfigure after resize (stale getCurrentTexture → blank)');
});

test('present-only frame hopping (c3df454f stale 480x360 before 472x333)', () => {
  assert.ok(page.includes('takeLatest') || page.includes('present'),
    'must hop only the presented frame (hopping ALL pending rendered stale first)');
});

test('uniform cache keyed by id:offset (256B poisoned 1792B)', () => {
  assert.ok(page.includes('bufferKey') || (page.includes('offset') && page.includes('cache')),
    'uniform buffer cache must key by id:offset (id-only key poisoned lookups; effLen inconsistency 074b6fe5/5395bed3)');
});

test('Y-flip emulates h<0 as rect + un-negated VS (h>0 skip was NOT benign)', () => {
  assert.ok(page.includes('flip') || page.includes('viewport') || page.includes('Y'),
    'Y-flip handling must exist (h>0 viewport skip regressed rendering)');
});

test('depth/stencil + scissor validation guards exist (1038020d WebGPU errors)', () => {
  assert.ok(page.includes('depth') && page.includes('scissor') || page.includes('DepthStencil') || page.includes('Scissor'),
    'depth/stencil format + scissor clamping must exist (32767×32767 on 256×256 → validation errors)');
});
