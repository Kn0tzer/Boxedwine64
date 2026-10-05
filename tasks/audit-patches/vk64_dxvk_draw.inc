// vk64_dxvk_draw.inc — TRANSPLANT PATCH (G2 lane, 2026-10-05). NOT APPLIED:
// the G2 lane is read-only on source/vulkan/*.
//
// WHY: DXVK draws ~100% indexed (d3d9 DrawIndexedPrimitive ->
// vkCmdDrawIndexed; vertex data via vkCmdBindVertexBuffers +
// vkCmdBindIndexBuffer). All three are benign-tail TAIL entries in the P2-NOW
// shim, so a DXVK frame records zero draws and serializeSubmit logs "without
// draw". The P2-NOW record path (vertex input LAYOUT at pipeline creation,
// push constants, descriptor fidelity) is necessary but not sufficient: without
// the bindings, the layout describes buffers that are never named.
//
// SCOPE: ~70 lines across 4 files, all additive. Depends on vk64_dynrender.inc
// only in the sense that draws without a frame boundary still serialize to
// nothing — transplant dynamic rendering first, then this.
//
// --- Step 1: ABI (source/vulkan/vk64bridge_abi.h, append after the dynrender ids) ---
//   VK64_fn_vkCmdDrawIndexed,        // (cmdBuf, indexCount, instanceCount, firstIndex, vertexOffset, firstInstance)
//   VK64_fn_vkCmdBindIndexBuffer,    // (cmdBuf, buffer, offset, indexType)
//   VK64_fn_vkCmdBindVertexBuffers,  // (cmdBuf, firstBinding, bindingCount, pBuffers*, pOffsets*)
//
// --- Step 2: guest shim (tools/rootfs64/libvk64/libvk64.c) ---
// Same shapes as the existing vkCmdDraw / vkCmdBindDescriptorSets wrappers
// (scalars in a[0..], guest pointers passed through as VAs), plus GIPA rows.
// Rebuild + restage with tools/rootfs64/buildvk.sh --stage dist/runtime.
// NOTE: vkCmdDrawIndexed, vkCmdBindIndexBuffer, vkCmdBindVertexBuffers,
// vkCmdCopyBuffer, vkCmdClearColorImage, vkCmdBeginQuery, vkCmdEndQuery,
// vkCreateQueryPool, vkGetQueryPoolResults, vkCreateComputePipelines and
// vkCmdDispatch are CURRENTLY TAIL entries — delete each TAIL line as its real
// wrapper lands, or the build fails on duplicate symbols. (This file only
// promotes the three draw-path ones; query/compute/clear-image stay TAIL until
// the probe proves DXVK's d3d9 path needs them — see "observe, don't guess".)
//
// --- Step 3: bridge (source/vulkan/vk64bridge.cpp) ---
// (a) CmdKind: append CMD_DRAW_INDEXED, CMD_BIND_VB, CMD_BIND_IB.
// (b) CmdBuf: record the CURRENT bindings (not just markers — submit must see
//     what was bound at draw time even if the app rebinds later):
//     U64 vbBuf[VK64_MAX_VERT_BINDINGS] = {0}; U64 vbOff[VK64_MAX_VERT_BINDINGS] = {0};
//     U64 ibBuf = 0; U64 ibOff = 0; U32 ibType = 0;  // 0 = uint16, 1 = uint32
//     Reset them in vkBeginCommandBuffer / vkResetCommandBuffer beside sets[].
// (c) Arms:
//     case VK64_fn_vkCmdBindVertexBuffers: {
//         CmdBuf* cb = cbOf(args.a[0], "vkCmdBindVertexBuffers");
//         if (!cb) return 0;
//         U32 first = (U32)args.a[1], n = (U32)args.a[2];
//         for (U32 i = 0; i < n && first + i < VK64_MAX_VERT_BINDINGS; i++) {
//             cb->vbBuf[first + i] = rd64(args.a[3] + (U64)i * 8);
//             cb->vbOff[first + i] = rd64(args.a[4] + (U64)i * 8);
//         }
//         Cmd c; c.kind = CMD_BIND_VB; c.a = first; c.b = n;
//         pushCmd(cb, c);
//         return 0;
//     }
//     case VK64_fn_vkCmdBindIndexBuffer: {
//         CmdBuf* cb = cbOf(args.a[0], "vkCmdBindIndexBuffer");
//         if (!cb) return 0;
//         cb->ibBuf = args.a[1]; cb->ibOff = args.a[2]; cb->ibType = (U32)args.a[3];
//         Cmd c; c.kind = CMD_BIND_IB;
//         c.a = args.a[1]; c.b = args.a[2]; c.c = args.a[3];
//         pushCmd(cb, c);
//         return 0;
//     }
//     case VK64_fn_vkCmdDrawIndexed: {
//         CmdBuf* cb = cbOf(args.a[0], "vkCmdDrawIndexed");
//         if (!cb) return 0;
//         Cmd c; c.kind = CMD_DRAW_INDEXED;
//         c.a = args.a[1]; c.b = args.a[2]; c.c = args.a[3]; c.d = args.a[4];
//         // Snapshot the bindings INTO the draw: a later rebind must not rewrite
//         // what this draw saw. (Store buffer ids + offsets; byte payloads are
//         // schema v2 — see (d).)
//         pushCmd(cb, c);
//         return 0;
//     }
// (d) serializeSubmit + manifest: extend the draws vector with indexed entries
//     {"indexCount","firstIndex","vertexOffset"} (keep {"vertexCount",
//     "firstVertex"} for CMD_DRAW — additive, old consumers ignore new keys),
//     and emit "vertexBindings":[{"buffer":id,"offset":n}...] plus
//     "indexBinding":{"buffer":id,"offset":n,"type":16|32} from the CmdBuf state
//     at submit. IDs are bridge object ids; the byte payloads (base64 of the
//     guest ranges, clamped to the allocations like uboBytes today) are the
//     remaining schema-v2 work and are DELIBERATELY out of scope here — this
//     patch names the buffers, it does not ship their bytes.
//
// VERIFY: scratch-dxvk.mjs "without draw" skips disappear; draws entries gain
// "indexCount":1 for tri9; the three names vanish from "asked-for
// (unimplemented)".
//
// OBSERVE, DON'T GUESS (parked until the probe names them):
// vkCmdClearColorImage / vkCmdClearDepthStencilImage (explicit clears outside
// render passes), vkCreateQueryPool + vkCmdBeginQuery/vkCmdEndQuery +
// vkGetQueryPoolResults + vkCmdResetQueryPool (d3d9 occlusion/timestamp
// GetData), vkCreateComputePipelines + vkCmdDispatch (DXVK meta ops). All stay
// benign-tail until a vklog proves the d3d9 triangle path calls them.
