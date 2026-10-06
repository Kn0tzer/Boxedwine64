// vk64_xlib_surface.inc — TRANSPLANT PATCH (G2 lane, 2026-10-05). NOT APPLIED YET:
// held for in-guest confirmation (see VERIFY).
//
// WHY (suspected, not yet proven): wine 8.0's winevulkan builds its HOST-side
// surface with vkCreateXlibSurfaceKHR (the X11 driver's WSI path), while the
// P2-NOW shim exports xcb + headless + win32 only. If the guest's surface call
// arrives as xlib, it lands in the benign tail (VK_ERROR_FEATURE_NOT_PRESENT)
// and no swapchain can ever be created — the same wall win32_surface was before
// e9e0e2c, one layer down. APPLY ONLY IF the dxvk probe's vklog shows an
// xlib-surface call failing; if winevulkan uses xcb/headless on the host side,
// delete this file instead.
//
// SCOPE: ~12 lines across 3 files, all additive — qualifies as "trivial" under
// the lane rules, which is why it is pre-written for one-step application.
// No generator change (platform surface structs are never read, same as the
// xcb/headless/win32 arms).
//
// --- Step 1: ABI (source/vulkan/vk64bridge_abi.h, append) ---
//   VK64_fn_vkCreateXlibSurfaceKHR,  // (instance, pCreateInfo*, pAllocator, out VkSurfaceKHR*)
//
// --- Step 2: guest shim (tools/rootfs64/libvk64/libvk64.c) ---
// Wrapper mirroring vkCreateXcbSurfaceKHR, plus the GIPA row:
//   E(vkCreateXlibSurfaceKHR, VK64_fn_vkCreateXlibSurfaceKHR),
// Rebuild + restage via buildvk.sh --stage dist/runtime.
//
// --- Step 3: bridge (source/vulkan/vk64bridge.cpp, surface arm) ---
// Add one case label to the existing surface arm — the body is unchanged (mint
// id, no struct read):
//   case VK64_fn_vkCreateXcbSurfaceKHR:
//   case VK64_fn_vkCreateXlibSurfaceKHR:    // <-- add
//   case VK64_fn_vkCreateWin32SurfaceKHR:
//   case VK64_fn_vkCreateHeadlessSurfaceEXT: {
// ... plus the VK64_FN_LIST X() row for the trap-name table.
//
// VERIFY: scratch-dxvk.mjs — an xlib name in "asked-for (unimplemented)" (or a
// surface-creation failure in winevulkan's log) is the trigger. After applying:
// one wasm rebuild (the ONLY heavy step this patch needs), re-run the probe,
// expect vkCreateXlibSurfaceKHR in the trap list and swapchain creation to
// proceed. If instead the vklog shows the host surface arriving as xcb or
// headless, this patch is unnecessary — remove this file.
