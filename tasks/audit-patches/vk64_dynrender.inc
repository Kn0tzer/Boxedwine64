// vk64_dynrender.inc — TRANSPLANT PATCH (G2 lane, 2026-10-05). NOT APPLIED:
// the G2 lane is read-only on source/vulkan/*.
//
// WHY: DXVK 2.4.1 renders EXCLUSIVELY with dynamic rendering. There is no
// render-pass fallback: src/dxvk/dxvk_context.cpp calls cmdBeginRendering at 8
// sites unconditionally, and vkCmdBeginRenderPass has zero call sites outside
// the loader table (src/vulkan/vulkan_loader.h:344). The P2-NOW bridge only
// records render-pass begins, so every DXVK submit logs "has no framebuffer,
// skipped" and no FRAME-JSON is ever built. This patch teaches the bridge the
// dynamic-rendering begin/end as a first-class frame boundary. It is the
// single load-bearing G2 transplant: without it nothing DXVK draws can cross.
//
// SCOPE: ~90 lines across 4 files, all additive (new fn ids, new CmdKinds, one
// alternate path in serializeSubmit). No existing arm changes behavior.
//
// --- Step 0: generator (tools/vulkan/gen/gen_vk64_guest.py, STRUCTS) ---
// Add: VkRenderingInfo VkRenderingAttachmentInfo
// (both present in source/vulkan/vk/vulkan_core.h; then regenerate
// source/vulkan/vk64_guest.h — the generated header is the committed artifact).
//
// --- Step 1: ABI (source/vulkan/vk64bridge_abi.h, append at the end of the
// --- P2-NOW block, after VK64_fn_vkCmdPushConstants) ---
//   VK64_fn_vkCmdBeginRendering,   // (cmdBuf, pRenderingInfo*)
//   VK64_fn_vkCmdEndRendering,      // (cmdBuf)
//
// --- Step 2: guest shim (tools/rootfs64/libvk64/libvk64.c) ---
// Mirror the enum order from the ABI header, then:
//   API void vkCmdBeginRendering(VkCommandBuffer cb, const void* info) {
//       VK64Args a = {{0}}; a.a[0] = cb; a.a[1] = P(info);
//       (void)vk64_trap(VK64_fn_vkCmdBeginRendering, &a);
//   }
//   API void vkCmdEndRendering(VkCommandBuffer cb) {
//       VK64Args a = {{0}}; a.a[0] = cb;
//       (void)vk64_trap(VK64_fn_vkCmdEndRendering, &a);
//   }
// plus GIPA rows E(vkCmdBeginRendering, ...), E(vkCmdEndRendering, ...).
// Rebuild + restage with tools/rootfs64/buildvk.sh --stage dist/runtime.
//
// --- Step 3: bridge (source/vulkan/vk64bridge.cpp) ---
// (a) CmdKind: append CMD_BEGIN_DYN, CMD_END_DYN.
// (b) Cmd: add dynamic-rendering frame geometry. A VkRenderingInfo names
//     image VIEWS, not a framebuffer, so the frame's extent and clear values
//     are captured here, at record time:
//     U64 dynView = 0; U32 dynW = 0, dynH = 0, dynDepthView = 0;
//     (reuse c.f[0..3] for the color clear, c.clearDepth for the depth clear.)
// (c) New arms, placed beside vkCmdBeginRenderPass:
//     case VK64_fn_vkCmdBeginRendering: {
//         CmdBuf* cb = cbOf(args.a[0], "vkCmdBeginRendering");
//         VkRenderingInfo ri = {};
//         if (!cb || !readStruct(args.a[1], ri)) return 0;
//         Cmd c; c.kind = CMD_BEGIN_DYN;
//         c.dynW = ri.renderArea.extent.width;
//         c.dynH = ri.renderArea.extent.height;
//         if (ri.colorAttachmentCount && ri.pColorAttachments) {
//             VkRenderingAttachmentInfo att = {};
//             readStruct(ri.pColorAttachments, att);   // attachment [0]
//             c.dynView = att.imageView;
//             if (att.loadOp == VK_ATTACHMENT_LOAD_OP_CLEAR) {
//                 c.f[0] = att.clearValue.color.float32[0];
//                 c.f[1] = att.clearValue.color.float32[1];
//                 c.f[2] = att.clearValue.color.float32[2];
//                 c.f[3] = att.clearValue.color.float32[3];
//             }
//         }
//         if (ri.pDepthAttachment) {
//             VkRenderingAttachmentInfo datt = {};
//             if (readStruct(ri.pDepthAttachment, datt)) {
//                 c.dynDepthView = datt.imageView;
//                 if (datt.loadOp == VK_ATTACHMENT_LOAD_OP_CLEAR)
//                     c.clearDepth = datt.clearValue.depthStencil.depth;
//             }
//         }
//         pushCmd(cb, c);
//         return 0;
//     }
//     case VK64_fn_vkCmdEndRendering: {
//         CmdBuf* cb = cbOf(args.a[0], "vkCmdEndRendering");
//         Cmd c; c.kind = CMD_END_DYN;
//         pushCmd(cb, c);
//         return 0;
//     }
// (d) serializeSubmit: the dynamic path. After the existing fbId scan, add:
//     // Dynamic rendering names views, not a framebuffer: geometry comes from
//     // the BEGIN_DYN command when no BEGIN_RP is present.
//     const Cmd* dyn = nullptr;
//     for (const Cmd& k : st->cmds) if (k.kind == CMD_BEGIN_DYN) { dyn = &k; break; }
//     Framebuffer* fb = fbId ? objOf<Framebuffer>(fbId, K_FRAMEBUFFER, "vkQueueSubmit") : nullptr;
//     if (!fb && !dyn) { klog_fmt("vk64: submit: frame %u has no framebuffer, skipped", g_frameNo); continue; }
//     Then: width/height = fb ? (fb->w, fb->h) : (dyn->dynW, dyn->dynH);
//     colorFormat = fb ? (existing view lookup) : format of the ImageView dyn->dynView
//         (ImageView* dv = objOf<ImageView>(dyn->dynView, ...); view = dv for the
//         existing texture path below, so the texture bytes resolve the same way).
//     clear color/depth: prefer the CMD_BEGIN_RP values when present, else dyn's.
//     NOTE: multi-attachment rendering (colorAttachments[1..]) is intentionally
//     dropped — DXVK's d3d9 path renders color[0] + depth, which is all the
//     schema carries today. G-buffer/MRT games need schema v2 (P3).
//
// VERIFY: re-run web/tests/scratch-dxvk.mjs; expect "has no framebuffer,
// skipped" to disappear and FRAME-JSON with "width":480,"height":360 to appear.
// The vkCmdBeginRendering/vkCmdEndRendering names must vanish from the
// "asked-for (unimplemented)" list in the dxvk vklog.
