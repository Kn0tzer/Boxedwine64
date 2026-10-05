// vk64_formatprops2.inc — TRANSPLANT PATCH (G2 lane, 2026-10-05). NOT APPLIED:
// the G2 lane is read-only on source/vulkan/*.
//
// WHY: DXVK reads per-format support through vkGetPhysicalDeviceFormatProperties2
// and consumes ONLY the pNext struct: DxvkAdapter::getFormatFeatures
// (src/dxvk/dxvk_adapter.cpp:80) fills VkFormatProperties3 and returns its
// optimalTilingFeatures / linearTilingFeatures / bufferFeatures. Callers sit on
// the hot path of EVERY graphics pipeline creation (src/dxvk/dxvk_graphics.cpp
// :1443 vertex-attribute format, :1469 depth format). The P2-NOW shim has no
// vkGetPhysicalDeviceFormatProperties2 at all (GIPA benign stub), so every
// format reads as supporting nothing and pipeline creation has no supported
// format to pick. vkGetPhysicalDeviceFormatProperties (non-2) exists but DXVK
// never calls it on this path.
//
// SCOPE: ~35 lines across 4 files, all additive.
//
// --- Step 0: generator (tools/vulkan/gen/gen_vk64_guest.py, STRUCTS) ---
// Add: VkFormatProperties2 VkFormatProperties3
// (both in source/vulkan/vk/vulkan_core.h; regenerate vk64_guest.h).
//
// --- Step 1: ABI (source/vulkan/vk64bridge_abi.h, append) ---
//   VK64_fn_vkGetPhysicalDeviceFormatProperties2,  // (physDev, format, out VkFormatProperties2)
//
// --- Step 2: guest shim (tools/rootfs64/libvk64/libvk64.c) ---
//   API void vkGetPhysicalDeviceFormatProperties2(VkPhysicalDevice pd, uint32_t format, void* p) {
//       VK64Args a = {{0}}; a.a[0] = pd; a.a[1] = format; a.a[2] = P(p);
//       (void)vk64_trap(VK64_fn_vkGetPhysicalDeviceFormatProperties2, &a);
//   }
// plus the GIPA row. Rebuild + restage via buildvk.sh --stage dist/runtime.
//
// --- Step 3: bridge (source/vulkan/vk64bridge.cpp, beside the non-2 arm) ---
//   case VK64_fn_vkGetPhysicalDeviceFormatProperties2: {
//       if (!args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
//       VkFormatProperties2 p2 = {};
//       if (!readStruct(args.a[2], p2)) return VK_ERROR_INITIALIZATION_FAILED;
//       // Same answers as the non-2 arm: sampled + storage image, transfer
//       // src/dst, uniform + storage texel buffers, vertex-buffer-capable.
//       VkFormatProperties base = {};
//       ... (factor the existing flag computation into a helper and call it
//       from BOTH arms — do not duplicate the constants) ...
//       p2.formatProperties = base;
//       writeStruct(args.a[2], p2);
//       // The struct DXVK actually reads: FormatProperties3 must be NONZERO,
//       // mirroring the same capability set in VkFormatFeatureFlags2.
//       for (U64 cur = p2.pNext; cur && g_mem;) {
//           if (g_mem->readd(cur) == VK_STRUCTURE_TYPE_FORMAT_PROPERTIES_3) {
//               VkFormatProperties3 p3 = {};
//               g_mem->memcpyFromGuest(&p3, cur, sizeof(p3));
//               p3.linearTilingFeatures = (VkFormatFeatureFlags2)base.linearTilingFeatures;
//               p3.optimalTilingFeatures = (VkFormatFeatureFlags2)base.optimalTilingFeatures;
//               p3.bufferFeatures = (VkFormatFeatureFlags2)base.bufferFeatures;
//               g_mem->memcpyToGuest(cur, &p3, sizeof(p3));
//               break;
//           }
//           cur = g_mem->readq(cur + 8);
//       }
//       return VK_SUCCESS;
//   }
// NOTE on the cast: VkFormatFeatureFlags is 32-bit, VkFormatFeatureFlags2 is
// 64-bit, and every bit the non-2 arm sets sits below bit 32, so the widening
// cast is exact. If a future format needs a genuine >32-bit flag (e.g.
// VK_FORMAT_FEATURE_2_STORAGE_IMAGE_WITHOUT_FORMAT — verify the value first),
// set it explicitly instead of relying on the cast.
//
// VERIFY: scratch-dxvk.mjs — pipeline-creation-adjacent failures mentioning
// formats disappear; the name vanishes from "asked-for (unimplemented)".
