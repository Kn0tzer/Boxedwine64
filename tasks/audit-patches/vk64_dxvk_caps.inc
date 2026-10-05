// vk64_dxvk_caps.inc — PROTOTYPE (audit P2-NOW items 1-2). NOT compiled here.
// Transplant target: source/vulkan/vk64bridge.cpp, inside the anonymous namespace,
// replacing g_inst_exts, the device exts[] in vkEnumerateDeviceExtensionProperties,
// the core-bit blocks in vkGetPhysicalDeviceFeatures[2], and adding walkFeatures2 /
// walkProperties2 called from the *2 handlers. Requires: in-tree vk/ headers
// (all structs/sTypes/extension names below verified present — see probe_caps.c).
//
// Design notes:
// - Extension advertisement is pure reporting: unknown-at-create stays lenient, so
//   advertising an extension never breaks creation; it only changes what DXVK's
//   isSuitable/queryDeviceExtensions path enables. Every extension below is either
//   behavior-free for us (load_store_op_none, depth_clip_enable, maintenance5/6 —
//   our recorder already treats load/store/cull conservatively) or has its behavior
//   implemented alongside (robustness2 nullDescriptor -> Binding arrays may stay
//   unbound; transform_feedback -> benign capture of the Xfb query/write calls).
// - maintenance6 is included iff targeting DXVK master/2.7.1+; delete the two lines
//   (ext array + feature arm) when pinning DXVK 2.4.x for G2.
// - timelineSemaphore (1.2 core) is TRUE: emulated by the sync prototype
//   (patched/vk64_dxvk_sync.inc). bufferDeviceAddress stays FALSE until the BDA
//   audit (P3) proves DXVK never consumes it — advertising it early would turn the
//   benign-tail error code into a live GPU address.

// --- 1. instance extensions: ADD win32_surface (+debug_utils, optional/harmless) ---
// Replace g_inst_exts (vk64bridge.cpp ~:812):
// const char* const g_inst_exts[] = {
//     "VK_KHR_surface", "VK_KHR_win32_surface", "VK_KHR_xcb_surface",
//     "VK_KHR_xlib_surface", "VK_EXT_headless_surface", "VK_EXT_debug_utils",
// };

// --- 2. device extensions: the DXVK-required set ---
// Replace exts[] in vkEnumerateDeviceExtensionProperties (vk64bridge.cpp ~:926):
// static const char* exts[] = {
//     "VK_KHR_swapchain",
//     "VK_KHR_maintenance5",
//     "VK_KHR_maintenance6",          // drop iff pinning DXVK <= 2.5... see note
//     "VK_KHR_load_store_op_none",
//     "VK_EXT_robustness2",           // HARD requirement (nullDescriptor + robustBufferAccess2)
//     "VK_EXT_transform_feedback",    // required for D3D10/11
//     "VK_EXT_depth_clip_enable",
// };

// --- 3. core feature bits DXVK's isSuitable reads (add to BOTH Features handlers) ---
// f.imageCubeArray = VK_TRUE;        // D3D11 needs cube arrays
// f.independentBlend = VK_TRUE;      // D3D11 independent blend targets
// f.shaderInt64 = VK_TRUE;           // wiki: 64-bit integer types required
// f.shaderFloat64 = VK_TRUE;         // d3d11 double-precision shaders exist
// (keep geometryShader/tessellationShader FALSE only until the schema carries those
//  stages — DXVK probes them; FALSE is honest today, revisit P3.)

// --- 4. pNext walker: the load-bearing piece. DXVK chains ~15 structs. ---
// Unknown sTypes are SKIPPED (never fail): forward-compatible with newer DXVK.
inline U64 walkFeatures2(U64 pNextAddr) {
    U64 cur = pNextAddr;
    while (cur && g_mem) {
        U32 sType = g_mem->readd(cur);
        switch (sType) {
        case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ROBUSTNESS_2_FEATURES_EXT: {
            VkPhysicalDeviceRobustness2FeaturesEXT f = {};
            g_mem->memcpyFromGuest(&f, cur, sizeof(f));
            f.robustBufferAccess2 = VK_TRUE;
            f.robustImageAccess2 = VK_TRUE;
            f.nullDescriptor = VK_TRUE;
            g_mem->memcpyToGuest(cur, &f, sizeof(f));
            break;
        }
        case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_5_FEATURES: {
            VkPhysicalDeviceMaintenance5Features f = {};
            g_mem->memcpyFromGuest(&f, cur, sizeof(f));
            f.maintenance5 = VK_TRUE;
            g_mem->memcpyToGuest(cur, &f, sizeof(f));
            break;
        }
        case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_6_FEATURES: {
            VkPhysicalDeviceMaintenance6Features f = {};
            g_mem->memcpyFromGuest(&f, cur, sizeof(f));
            f.maintenance6 = VK_TRUE;
            g_mem->memcpyToGuest(cur, &f, sizeof(f));
            break;
        }
        case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TRANSFORM_FEEDBACK_FEATURES_EXT: {
            VkPhysicalDeviceTransformFeedbackFeaturesEXT f = {};
            g_mem->memcpyFromGuest(&f, cur, sizeof(f));
            f.transformFeedback = VK_TRUE;
            f.geometryStreams = VK_TRUE;
            g_mem->memcpyToGuest(cur, &f, sizeof(f));
            break;
        }
        case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DESCRIPTOR_INDEXING_FEATURES: {
            VkPhysicalDeviceDescriptorIndexingFeatures f = {};
            g_mem->memcpyFromGuest(&f, cur, sizeof(f));
            f.shaderInputAttachmentArrayDynamicIndexing = VK_TRUE;
            f.shaderUniformTexelBufferArrayDynamicIndexing = VK_TRUE;
            f.shaderStorageTexelBufferArrayDynamicIndexing = VK_TRUE;
            f.shaderUniformBufferArrayNonUniformIndexing = VK_TRUE;
            f.shaderSampledImageArrayNonUniformIndexing = VK_TRUE;
            f.shaderStorageBufferArrayNonUniformIndexing = VK_TRUE;
            f.shaderStorageImageArrayNonUniformIndexing = VK_TRUE;
            f.shaderInputAttachmentArrayNonUniformIndexing = VK_TRUE;
            f.shaderUniformTexelBufferArrayNonUniformIndexing = VK_TRUE;
            f.shaderStorageTexelBufferArrayNonUniformIndexing = VK_TRUE;
            f.descriptorBindingUniformBufferUpdateAfterBind = VK_TRUE;
            f.descriptorBindingSampledImageUpdateAfterBind = VK_TRUE;
            f.descriptorBindingStorageImageUpdateAfterBind = VK_TRUE;
            f.descriptorBindingStorageBufferUpdateAfterBind = VK_TRUE;
            f.descriptorBindingUniformTexelBufferUpdateAfterBind = VK_TRUE;
            f.descriptorBindingStorageTexelBufferUpdateAfterBind = VK_TRUE;
            f.descriptorBindingUpdateUnusedWhilePending = VK_TRUE;
            f.descriptorBindingPartiallyBound = VK_TRUE;
            f.descriptorBindingVariableDescriptorCount = VK_TRUE;
            f.runtimeDescriptorArray = VK_TRUE;
            g_mem->memcpyToGuest(cur, &f, sizeof(f));
            break;
        }
        case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_FLOAT16_INT8_FEATURES: {
            VkPhysicalDeviceShaderFloat16Int8Features f = {};
            g_mem->memcpyFromGuest(&f, cur, sizeof(f));
            f.shaderFloat16 = VK_TRUE;
            f.shaderInt8 = VK_TRUE;
            g_mem->memcpyToGuest(cur, &f, sizeof(f));
            break;
        }
        case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_16BIT_STORAGE_FEATURES: {
            VkPhysicalDevice16BitStorageFeatures f = {};
            g_mem->memcpyFromGuest(&f, cur, sizeof(f));
            f.storageBuffer16BitAccess = VK_TRUE;
            f.uniformAndStorageBuffer16BitAccess = VK_TRUE;
            f.storageInputOutput16 = VK_TRUE;
            g_mem->memcpyToGuest(cur, &f, sizeof(f));
            break;
        }
        case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_8BIT_STORAGE_FEATURES: {
            VkPhysicalDevice8BitStorageFeatures f = {};
            g_mem->memcpyFromGuest(&f, cur, sizeof(f));
            f.storageBuffer8BitAccess = VK_TRUE;
            f.uniformAndStorageBuffer8BitAccess = VK_TRUE;
            g_mem->memcpyToGuest(cur, &f, sizeof(f));
            break;
        }
        case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SCALAR_BLOCK_LAYOUT_FEATURES: {
            VkPhysicalDeviceScalarBlockLayoutFeatures f = {};
            g_mem->memcpyFromGuest(&f, cur, sizeof(f));
            f.scalarBlockLayout = VK_TRUE;
            g_mem->memcpyToGuest(cur, &f, sizeof(f));
            break;
        }
        case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES: {
            VkPhysicalDeviceVulkan12Features f = {};
            g_mem->memcpyFromGuest(&f, cur, sizeof(f));
            f.timelineSemaphore = VK_TRUE;   // emulated (see vk64_dxvk_sync.inc)
            f.bufferDeviceAddress = VK_FALSE; // P3 audit: prove unused before TRUE
            f.descriptorIndexing = VK_TRUE;
            f.shaderSampledImageArrayNonUniformIndexing = VK_TRUE;
            f.descriptorBindingPartiallyBound = VK_TRUE;
            f.runtimeDescriptorArray = VK_TRUE;
            g_mem->memcpyToGuest(cur, &f, sizeof(f));
            break;
        }
        default:
            klog_fmt("vk64: Features2 pNext sType=%u: not modeled, left as guest set", sType);
            break;
        }
        // pNext is at offset 8 in every features struct (sType u32 + pad + ptr).
        cur = g_mem->readq(cur + 8);
    }
    return pNextAddr;
}
// Wire-in: in vkGetPhysicalDeviceFeatures2, after filling f2.features and BEFORE
// writeStruct: walkFeatures2(f2.pNext). Same pattern for Properties2 chains
// (vk11/vk12 props + descriptor-indexing properties + maintenance5 properties +
// transform-feedback properties: fill the WebGPU-plausible constants, zeros where
// unknown — zeros degrade gracefully EXCEPT maxDescriptorSetUpdateAfterBind* which
// must be nonzero when descriptor indexing is advertised; set 1024/64/16/8/4/8).
