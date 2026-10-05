# Manifest schema v2 + frame streaming — lane-schema

**Status:** design accepted for implementation in this lane (2026-10-05).
**Scope:** the `vk64 -> WebGPU` pipeline only: `source/vulkan/vk64bridge.cpp`
(serializer), `web/vkwebgpu.mjs` (consumer), `web/tests/vkwebgpu.test.mjs`.
No emcc rebuilds in this lane; C++ is checked with `g++ -fsyntax-only`.

## 1. Why v1 is vkcube-shaped (the problem)

The v1 FRAME-JSON manifest (`serializeSubmit` in `vk64bridge.cpp`) assumes:

| v1 assumption | DXVK reality (D3D9 via winevulkan) |
|---|---|
| one frame per submit | a frame is **present-to-present**: N submits, command buffers recorded on worker threads, one `vkQueuePresentKHR` |
| vs+fs only, fixed set 0 | N descriptor sets, descriptor **arrays** (`dstArrayElement`/`count` — descriptor indexing), storage buffers/images |
| one UBO at set 0 binding 0, one texture at binding 1 | arbitrary binding tables per set; inline uniform blocks |
| no push constants | `vkCmdPushConstants` per draw for nearly everything |
| `vkCmdDraw` only | `vkCmdDrawIndexed` almost exclusively; vertex/index buffer binds |
| no MSAA | D3D9 apps request multisampled backbuffers |
| one render pass, colour+depth | an ordered **render-pass graph** (shadow/clear passes, resolve) |

v2 carries all of the right column. The recording side already captures most of
it (`Binding{type,dstArrayElement,count}`, `CMD_PUSH_CONST` with offset/size/
bytes, `Image.samples`, the pipeline vertex layout); v2 is the *reporting*
half: the serializer, the wire format, and the page consumer.

## 2. Wire protocol decision: binary framed records

**Chosen: binary framed records over the `MAIN_THREAD_EM_ASM` hop.**
Rejected: chunked JSON lines.

### 2.1 The hop

The boundary is one `MAIN_THREAD_EM_ASM` per **chunk**. The JS body receives
`(ptr, len, flags)` — three ints — and the C++ side never builds a JS string:

```c
MAIN_THREAD_EM_ASM({
    if (globalThis.window && window.bwVkChunk) {
        try {
            const bytes = new Uint8Array(Module.HEAPU8.buffer, $0, $1).slice();
            window.bwVkChunk(bytes, $2);
        } catch (e) { console.warn('vk64: bwVkChunk failed', e); }
    }
}, ptr, len, flags);
```

`slice()` is one `memcpy`. A `HEAPU8.subarray` view would be zero-copy but is
unsafe to retain: wasm memory can grow under it and detach every live view, so
any consumer that outlives the hop (the streaming queue) must copy anyway.

### 2.2 Cost comparison at the wasm boundary

| cost per frame | chunked JSON lines | binary framed records |
|---|---|---|
| wasm side | `std::string` JSON build **+ base64 encode of every blob** (+33% bytes, encode loop on the guest thread) | raw struct writes into the chunk buffer; blobs `memcpy`'d verbatim |
| UTF-8 boundary | `UTF8ToString(ptr)` decodes every byte into a JS string: O(n) + one large string allocation per chunk | no string exists; the hop moves 3 ints |
| JS parse | `JSON.parse` per chunk: O(n) + one object allocation **per record** (DXVK: hundreds of small records/frame — pushes, binds, draws) | `DataView` reads walk the records; allocation only for payloads the renderer keeps (shader blobs, textures) |
| blobs | base64 inflates SPIR-V/textures/UBOs by 33% and pays decode on the page | raw bytes; `writeTexture`/`writeBuffer` take the `Uint8Array` directly |
| debuggability | eyeball-able | `BW64_VKDUMP=1` page-side text dump of decoded records (see §6); v1 JSON stays behind `BW64_VKSCHEMA=1` |

The fixed hop cost (main-thread post + JS entry) is identical for both and is
amortized by **chunking**: a frame is 1+ chunks, chunk cap 1 MiB, so a
DXVK-sized frame crosses in a handful of hops instead of one JSON string per
record. At DXVK's record volume the binary path is an order of magnitude less
per-byte work at the boundary; the JSON path's per-record `stringify`/`parse`
object churn is exactly the cost that would show up as guest-thread stalls.

### 2.3 Chunk framing

All integers little-endian.

```
chunk header (16 bytes):
  u32 magic   = 0x324B5632  ('VK2F' LE)
  u16 version = 2
  u16 flags   bit0: MORE   (more chunks follow for this frame)
              bit1: V1FALLBACK (never set by the v2 writer; reserved)
  u32 chunkSeq (monotonic; lets the page count dropped chunks)

record header (8 bytes):
  u16 type
  u16 rflags  (reserved)
  u32 len     (payload bytes that follow)

payload: type-specific, §3.
```

A chunk is `header + records*`. Records never straddle chunks: the writer
seals the chunk before appending a record that would exceed the cap.

### 2.4 v1 compatibility

`BW64_VKSCHEMA=1` in the guest environment selects the **v1 emitter verbatim**:
the existing `serializeSubmit` JSON path and the `window.bwVkFrame(string)`
hop are untouched. Default (unset/anything else) is v2. The page needs no
sniffing: v1 arrives at `window.bwVkFrame`, v2 at `window.bwVkChunk`.

Rationale for env-over-negotiation: the page cannot negotiate before the first
frame without a round trip the guest would block on; the env var is read once
and cached at the first submit (getenv is unreliable on guest worker threads,
so the decision is pinned to the submit path, never re-read per frame).

## 3. Schema v2 record catalogue

Frame = **present-to-present**. Records stream across submits; `FRAME_BEGIN`
is emitted at the first submit-with-draw after a present, `FRAME_END` seals at
`vkQueuePresentKHR`. A submit with no draws emits nothing.

| type | name | payload (LE) |
|---|---|---|
| 0x01 | `FRAME_BEGIN` | `u32 frameNo, u32 width, u32 height, u32 flags` (bit0: overflow — the guest exceeded `VK64_MAX_CMDS`; the page rejects the frame like v1) |
| 0x02 | `FRAME_END` | `u32 frameNo` |
| 0x03 | `RP_BEGIN` | `u64 rpId, u64 fbId, u32 w, u32 h, u32 nAtt`, then `nAtt × {u32 format, u32 loadOp, u32 storeOp, u32 samples, u32 isDepth}`, then `f32 clearColor[4], f32 clearDepth, u32 clearStencil`, then `nAtt × {u64 viewId, u64 imageId}` (attachment identity tail, in attachment order). The image identity links each render attachment to the sampled-image aliases in `frame.views` that share the same `VkImage`. The ordered sequence of `RP_BEGIN`/`RP_END` pairs **is the render-pass graph**. `samples` comes from `VkAttachmentDescription.samples` (recorded at `vkCreateRenderPass`); `isDepth` from the image view aspect. |
| 0x04 | `RP_END` | — |
| 0x05 | `SHADER` | `u8 stage (0=vs,1=fs), u8 pad, u16 pad, u64 hash, u32 codeLen, u8 code[codeLen]`. Emitted at most once per hash per frame; the page caches translated WGSL per hash (existing `createShaderCache`). |
| 0x06 | `PIPELINE` | `u64 pipeId, u64 vsHash, u64 fsHash, u32 topology, cull, front, depthTest, depthWrite, depthOp, blend, u32 nVb, u32 nVa`, then `nVb × {u32 binding, stride, inputRate}`, `nVa × {u32 location, binding, format, offset}`. The vertex input layout travels with the pipeline that declares it — the one field without which nothing rasterizes (audit P2-NOW item 5). |
| 0x07 | `BIND_SETS` | `u8 firstSet, u8 setCount, u16 pad, u64 setIds[setCount]`. Which descriptor sets are live for subsequent draws. |
| 0x08 | `DESC_SET` | `u8 setIndex, u8 nBind, u16 pad, u64 layoutId`, then per binding `u32 binding, u32 type (VkDescriptorType), u32 dstArrayElement, u32 count, u8 kind, u8 pad[3], u64 obj, u64 range`. `kind`: 0=none, 1=buffer, 2=image, 3=sampler, 4=inline-bytes. **Binding arrays are explicit**: `dstArrayElement`/`count` are recorded, not collapsed to element 0. |
| 0x09 | `BUFFER_DATA` | `u64 bufId, u64 offset, u32 len, u8 bytes[len]`. Uniform/storage/vertex/index bytes, at most once per `(bufId,offset,len)` per frame. |
| 0x0A | `IMAGE_DATA` | `u64 viewId, u64 imageId, u32 w, u32 h, u32 format (VkFormat), u32 pixLen, u8 bytes[pixLen]`. Once per image per frame; `viewId` first because `DESC_SET` bindings name image *views* while this record is deduped per image. |
| 0x0B | `SAMPLER` | `u64 samplerId, u32 mag, min, mipmap, addrU, addrV, f32 maxAniso` (Vk enums; the page maps them as v1 does). |
| 0x0C | `PUSH` | `u32 offset, u32 size, u32 stageFlags, u8 bytes[size]`. The page overlays each into a 256-byte push-constant block (offset-preserved: a push is an overlay, not a replacement). |
| 0x0D | `VIEWPORT` | `f32 x, y, w, h, minDepth, maxDepth` |
| 0x0E | `SCISSOR` | `i32 x, y, u32 w, h` |
| 0x0F | `VERTEX_BIND` | `u8 nVb, u8 pad[3]`, then `nVb × {u32 binding, u64 bufId, u64 offset}`. The current vertex-buffer table, emitted on `vkCmdBindVertexBuffers`. |
| 0x10 | `INDEX_BIND` | `u64 bufId, u64 offset, u32 indexType (0=u16,1=u32)`. |
| 0x11 | `DRAW` | `u32 vertexCount, instanceCount, firstVertex, firstInstance, u8 indexed, u8 pad[3], u32 indexCount, u32 firstIndex, i32 vertexOffset`. Covers `vkCmdDraw` and `vkCmdDrawIndexed`. |
| 0x12 | `INLINE_BYTES` | `u8 setIndex, u8 pad, u16 pad, u32 binding, u32 dstArrayElement, u32 len, u8 bytes[len]`. Payload for `kind=4` (`INLINE_UNIFORM_BLOCK`) bindings, whose bytes live in guest memory at write time. |

Deliberately **not** in v2: secondary command buffers (DXVK doesn't use them
for D3D9), input attachments, tessellation/geometry stages (pipeline records
`topology` only; the page renders triangle lists), sparse binding, and
per-element descriptor payloads for arrays beyond index/count (the *geometry*
is honest; element payloads are P3).

## 4. Backpressure: latest-frame-wins, drop-oldest

Two queues, one on each side of the hop. Neither ever blocks the guest.

**Producer (wasm), chunk ring:** one open chunk (1 MiB cap). Completed frames
(a frame = its sealed chunks) queue in a deque; the deque is capped at **8
chunks total**. When a newly sealed frame would exceed the cap, the **oldest
complete frame is dropped first** — never a partial frame, which is
unrenderable. At `vkQueuePresentKHR` the queued frames hop in order, one
`MAIN_THREAD_EM_ASM` per chunk, and the deque clears. The `chunkSeq` in each
header lets the page count gaps.

**Consumer (page), `FrameQueue`:** cap **3 complete frames**. `push(frame)`
drops the oldest while at/over cap. The render pump calls `takeLatest()`,
which returns the newest complete frame and drops everything older —
**latest-frame-wins**: a guest presenting faster than the page renders never
builds a backlog; it just re-renders the newest state. `clear()` drains the
queue; it is called by the canvas-resize hook (§5) because frames recorded at
the old size would misconfigure the targets.

Overflow accounting is visible in `window.bwVkStats()` (`chunksReceived`,
`framesReceived`, `rendered`, `droppedConsumer`, `chunkGaps`, `rejected`).
Producer-side drops are host-side only (klog `v2 producer ring full`); the
page detects loss through `chunkGaps` on the chunk sequence.

## 5. Page-side consumption (`web/vkwebgpu.mjs`)

- `ingestChunk(bytes)` — validates the chunk header, appends records to the
  frame assembler; on `FRAME_END` pushes the complete frame into the
  `FrameQueue` and kicks the render pump. Never throws back at the guest.
- **Bind groups from descriptor sets:** one `GPUBindGroupLayout` per Vulkan
  set index, entries derived from the `DESC_SET` binding table
  (`kind=1` → `buffer:{type}`, `kind=2` → `texture`, `kind=3` → `sampler`,
  all-stages visibility). Binding **arrays** stay WebGPU binding arrays:
  naga's WGSL already declares descriptor arrays as `binding_array<T, count>`,
  so each Vulkan binding is one layout entry and the bind group carries an
  array of resources at that binding. (Flattening to `binding*64+index` was
  considered and rejected: it would require rewriting dynamic index
  expressions in the translated shader, which is unsound. The manifest's
  `dstArrayElement`/`count` are honoured when filling the resource array,
  clamped to the WGSL-declared count.) Non-array bindings keep their declared
  `@binding`.
- **Push constants as a small UBO:** the translated WGSL's `var<push_constant>`
  is rewritten to `var<uniform>` at reserved `@group(3) @binding(0)`; the page
  keeps one ≤256-byte uniform buffer and `writeBuffer`s the current block
  before each draw group. Group 3 enters the pipeline layout only when the
  WGSL actually declares the push block.
- **MSAA:** `RP_BEGIN`'s per-attachment `samples` drives target creation:
  `samples>1` → multisampled colour texture + `resolveTarget` into the
  single-sample target the readback/present path already uses, clamped to the
  adapter's supported sample counts.
- **Canvas-resize hook:** a `ResizeObserver` on the canvas drains the
  `FrameQueue` and invalidates the render targets; the next frame re-creates
  them at the new size. Swapchain recreation at a new extent arrives as frames
  with new `width`/`height` and takes the same path.
- v1 (`tier.frame(string)`) is untouched and keeps the existing renderer.

## 6. Host-side changes (`source/vulkan/vk64bridge.cpp`)

- `vkSchemaV2()` — env gate (§2.4); default v2.
- `ChunkWriter` — LE append buffer; `sealChunk()` at the 1 MiB cap.
- `serializeSubmitV2()` — walks the recorded commands in order and emits §3
  records: `FRAME_BEGIN`, per-`CMD_BEGIN_RP`/`CMD_END_RP` the render-pass
  graph, `SHADER`+`PIPELINE` on pipeline binds, `BIND_SETS`+`DESC_SET` (+
  `BUFFER_DATA`/`IMAGE_DATA`/`SAMPLER`/`INLINE_BYTES`, deduped per frame) on
  set binds, `PUSH` on push-constant records, `VIEWPORT`/`SCISSOR`,
  `VERTEX_BIND`/`INDEX_BIND`, `DRAW`/`DRAW_INDEXED`.
- New recording (append-only ABI ids before `VK64_fn__MAX`):
  `vkCmdDrawIndexed`, `vkCmdBindVertexBuffers`, `vkCmdBindIndexBuffer`;
  `RenderPass.samples[]` recorded at `vkCreateRenderPass`.
  (Guest-shim wrappers in `tools/rootfs64/libvk64/libvk64.c` are a
  follow-up lane; the host records whatever traps arrive.)
- Present path: v2 → hop every queued frame's chunks; v1 → `emitFrameNow()`
  unchanged.
- `BW64_VKDUMP=1` logs the decoded record list per frame (host side).

## 7. Tests (`web/tests/vkwebgpu.test.mjs`)

Page-side synthetic v2 fixtures — a small binary chunk builder mirroring the
C++ writer — covering: chunk/record framing, `FRAME_BEGIN` fields,
`DESC_SET` with a 3-element binding array (flattening + `binding_array`
transform), `PUSH` overlay order, per-attachment MSAA samples, the
render-pass graph order, `FrameQueue` drop-oldest / `takeLatest` /
resize-drain, the push-constant WGSL transform, and malformed-chunk
rejections. `npm test` green; the existing v1 tests are untouched.

## 8. Open risks (not solved here)

1. naga's WGSL backend and SPIR-V `OpTypePushConstant`: the page rewrites
   `var<push_constant>` textually; if naga rejects such modules outright the
   frame is counted-skipped (same discipline as the `InvalidId(40)` fragment
   override). A dxc-compiled vertex+pixel pair through this path is the P3
   corpus entry.
2. `binding_array` in WGSL requires the element type/count statically — true
   descriptor indexing with runtime `count` is P3.
3. Vertex buffer `BUFFER_DATA` inlines whole buffers; a DXVK frame's dynamic
   VBs can be megabytes — the chunk cap handles the framing, but per-frame
   re-upload cost is unmeasured (§2.10 unknown #4 territory).
