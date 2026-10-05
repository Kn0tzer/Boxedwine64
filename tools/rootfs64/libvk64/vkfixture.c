/*
 *  Copyright (C) 2012-2025  The Boxedwine Team
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 */

/*
 * vkfixture — the P2 boundary fixture for the 64-bit Vulkan bridge.
 *
 * It walks the SAME path vulkan-tools' vkcube walks, and nothing else:
 *
 *   dlopen("libvulkan.so.1") + dlsym(vkGetInstanceProcAddr)   <- exactly how
 *       vkcube loads Vulkan (readelf on the P1 binary shows it has ZERO direct
 *       vk* imports), so this also answers tasks/p1-final.md unknown #1: where
 *       the guest actually finds the shim
 *     -> instance (+ VK_KHR_surface, VK_EXT_headless_surface)
 *     -> enumerate physical devices / properties / queue families / memory heaps
 *     -> device + queue
 *     -> surface + swapchain + swapchain images
 *     -> depth image + memory + image view
 *     -> render pass + framebuffer
 *     -> descriptor set layout / pool / set, uniform buffer (written through
 *        the vkMapMemory GUEST VA), staging texture upload via
 *        vkCmdCopyBufferToImage, sampler, texture image view
 *     -> the two SPIR-V modules vkcube itself uses (see vkfixture_spirv.h)
 *     -> graphics pipeline + pipeline layout
 *     -> command buffer: copy, barrier, beginRenderPass(clear), viewport,
 *        scissor, bindPipeline, bindDescriptorSets, draw(36), endRenderPass
 *     -> vkQueueSubmit (the host rebuilds a frame manifest out of this)
 *     -> vkWaitForFences, vkQueuePresentKHR (the host's ONE hop to the page)
 *     -> teardown
 *
 * Every step prints a "vkfix: ..." line, and the program returns 0 only if every
 * VkResult was VK_SUCCESS and both handles the app would have died without
 * (physical device, queue) are non-zero. That is the gate in
 * tasks/p1-final.md deliverable 3: the run is only evidence if the fixture
 * exited 0 AND the host log shows the corresponding traps.
 *
 * WHY NO WINDOW. There is no X server in the guest (and no xvfb to add one), and
 * vkcube's xcb path is exactly what cannot work headless. So the surface comes
 * from VK_EXT_headless_surface instead of VK_KHR_xcb_surface. Everything after
 * the surface is identical to vkcube's real sequence; the ONLY substitution is
 * how the surface is created. --width/--height (default 64) becomes the
 * swapchain imageExtent, the same knob vkcube exposes.
 *
 * Built against the REAL Khronos headers (source/vulkan/vk), exactly as a real
 * guest app would be — so if the guest struct layout and the host's generated
 * vk64_guest.h ever disagree, this binary is what notices.
 */
#define VK_NO_PROTOTYPES
#define VK_USE_64_BIT_PTR_DEFINES 1
#include <vulkan/vulkan_core.h>

#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "vkfixture_spirv.h"

#define CHK(expr)                                                          \
    do {                                                                   \
        VkResult _r = (expr);                                              \
        if (_r != VK_SUCCESS) {                                            \
            printf("vkfix: FAIL %s -> %d\n", #expr, (int)_r);             \
            printf("vkfix: RESULT %d\n", 1);                               \
            fflush(stdout);                                                \
            return 1;                                                      \
        }                                                                  \
    } while (0)

static int g_steps = 0;
static void step(const char* what) { printf("vkfix: ok  %s\n", what); g_steps++; fflush(stdout); }

/* A FAIL inside the DXVK-shaped probe must end the run the same way every other
 * failure does (RESULT 1), so the gate cannot read a green run that skipped it. */
#define PROBE_FAIL(...) do {                                                  \
        printf("vkfix: FAIL dxvk-probe: ");                                  \
        printf(__VA_ARGS__);                                                 \
        printf("\n");                                                        \
        printf("vkfix: RESULT 1\n");                                         \
        fflush(stdout);                                                      \
        return 1;                                                            \
    } while (0)
#define NEED(cond, ...) do { if (!(cond)) PROBE_FAIL(__VA_ARGS__); } while (0)

/* The in-tree vk/ headers carry no platform-surface declarations (there is no
 * vulkan_win32.h in the tree), exactly as the bridge's own comment says. So the
 * Win32 create-info is declared here in guest layout — sType u32, pad, pNext,
 * flags, hwnd — for the probe to pass a realistic pointer. The host mints an id
 * without reading it, and NOT reading it is what makes the boundary free of any
 * platform header. The sType value comes from the real header, not by hand. */
typedef struct VkWin32SurfaceCreateInfoKHR_local {
    VkStructureType sType;
    const void* pNext;
    VkFlags flags;
    void* hwnd;
} VkWin32SurfaceCreateInfoKHR_local;
/* Likewise PFN_vkCreateWin32SurfaceKHR lives in the platform header, so the probe
 * declares the one function-pointer type it needs. */
typedef VkResult (VKAPI_PTR *PFN_vkCreateWin32SurfaceKHR)(
    VkInstance, const VkWin32SurfaceCreateInfoKHR_local*, const VkAllocationCallbacks*, VkSurfaceKHR*);

/* Every entry point is resolved through vkGetInstanceProcAddr, exactly like a
 * loader-shaped caller (vkcube does the same). Declarations first, then R() only
 * ASSIGNS, so resolving the same entry point twice (teardown re-resolves several)
 * is not a redeclaration. */
static PFN_vkGetInstanceProcAddr gipa;

static PFN_vkVoidFunction vkfix_must(PFN_vkVoidFunction f, const char* name) {
    if (!f) {
        printf("vkfix: FAIL unresolved %s\n", name);
        printf("vkfix: RESULT 1\n");
        fflush(stdout);
        exit(1);
    }
    return f;
}

static PFN_vkAcquireNextImageKHR pAcquireNextImageKHR;
static PFN_vkAllocateCommandBuffers pAllocateCommandBuffers;
static PFN_vkAllocateDescriptorSets pAllocateDescriptorSets;
static PFN_vkAllocateMemory pAllocateMemory;
static PFN_vkBeginCommandBuffer pBeginCommandBuffer;
static PFN_vkBindBufferMemory pBindBufferMemory;
static PFN_vkBindImageMemory pBindImageMemory;
static PFN_vkCmdBeginRenderPass pCmdBeginRenderPass;
static PFN_vkCmdBindDescriptorSets pCmdBindDescriptorSets;
static PFN_vkCmdBindPipeline pCmdBindPipeline;
static PFN_vkCmdCopyBufferToImage pCmdCopyBufferToImage;
static PFN_vkCmdDraw pCmdDraw;
static PFN_vkCmdEndRenderPass pCmdEndRenderPass;
static PFN_vkCmdPipelineBarrier pCmdPipelineBarrier;
static PFN_vkCmdPushConstants pCmdPushConstants;
static PFN_vkCmdSetScissor pCmdSetScissor;
static PFN_vkCmdSetViewport pCmdSetViewport;
static PFN_vkCreateBuffer pCreateBuffer;
static PFN_vkCreateCommandPool pCreateCommandPool;
static PFN_vkCreateDescriptorPool pCreateDescriptorPool;
static PFN_vkCreateDescriptorSetLayout pCreateDescriptorSetLayout;
static PFN_vkCreateDevice pCreateDevice;
static PFN_vkCreateFence pCreateFence;
static PFN_vkCreateFramebuffer pCreateFramebuffer;
static PFN_vkCreateGraphicsPipelines pCreateGraphicsPipelines;
static PFN_vkCreateHeadlessSurfaceEXT pCreateHeadlessSurfaceEXT;
static PFN_vkCreateImage pCreateImage;
static PFN_vkCreateImageView pCreateImageView;
static PFN_vkCreatePipelineCache pCreatePipelineCache;
static PFN_vkCreatePipelineLayout pCreatePipelineLayout;
static PFN_vkCreateRenderPass pCreateRenderPass;
static PFN_vkCreateSampler pCreateSampler;
static PFN_vkCreateShaderModule pCreateShaderModule;
static PFN_vkCreateSwapchainKHR pCreateSwapchainKHR;
static PFN_vkDestroyBuffer pDestroyBuffer;
static PFN_vkDestroyCommandPool pDestroyCommandPool;
static PFN_vkDestroyDescriptorPool pDestroyDescriptorPool;
static PFN_vkDestroyDescriptorSetLayout pDestroyDescriptorSetLayout;
static PFN_vkDestroyDevice pDestroyDevice;
static PFN_vkDestroyFence pDestroyFence;
static PFN_vkDestroyFramebuffer pDestroyFramebuffer;
static PFN_vkDestroyImage pDestroyImage;
static PFN_vkDestroyImageView pDestroyImageView;
static PFN_vkDestroyInstance pDestroyInstance;
static PFN_vkDestroyPipeline pDestroyPipeline;
static PFN_vkDestroyPipelineCache pDestroyPipelineCache;
static PFN_vkDestroyPipelineLayout pDestroyPipelineLayout;
static PFN_vkDestroyRenderPass pDestroyRenderPass;
static PFN_vkDestroySampler pDestroySampler;
static PFN_vkDestroyShaderModule pDestroyShaderModule;
static PFN_vkDestroySurfaceKHR pDestroySurfaceKHR;
static PFN_vkDestroySwapchainKHR pDestroySwapchainKHR;
static PFN_vkDeviceWaitIdle pDeviceWaitIdle;
static PFN_vkEndCommandBuffer pEndCommandBuffer;
static PFN_vkEnumerateDeviceExtensionProperties pEnumerateDeviceExtensionProperties;
static PFN_vkEnumeratePhysicalDevices pEnumeratePhysicalDevices;
static PFN_vkFreeCommandBuffers pFreeCommandBuffers;
static PFN_vkFreeMemory pFreeMemory;
static PFN_vkGetBufferMemoryRequirements pGetBufferMemoryRequirements;
static PFN_vkGetDeviceQueue pGetDeviceQueue;
static PFN_vkGetImageMemoryRequirements pGetImageMemoryRequirements;
static PFN_vkGetPhysicalDeviceMemoryProperties pGetPhysicalDeviceMemoryProperties;
static PFN_vkGetPhysicalDeviceProperties pGetPhysicalDeviceProperties;
static PFN_vkGetPhysicalDeviceQueueFamilyProperties pGetPhysicalDeviceQueueFamilyProperties;
static PFN_vkGetPhysicalDeviceSurfaceCapabilitiesKHR pGetPhysicalDeviceSurfaceCapabilitiesKHR;
static PFN_vkGetPhysicalDeviceSurfaceFormatsKHR pGetPhysicalDeviceSurfaceFormatsKHR;
static PFN_vkGetPhysicalDeviceSurfacePresentModesKHR pGetPhysicalDeviceSurfacePresentModesKHR;
static PFN_vkGetSwapchainImagesKHR pGetSwapchainImagesKHR;
static PFN_vkMapMemory pMapMemory;
static PFN_vkQueuePresentKHR pQueuePresentKHR;
static PFN_vkQueueSubmit pQueueSubmit;
static PFN_vkUnmapMemory pUnmapMemory;
static PFN_vkUpdateDescriptorSets pUpdateDescriptorSets;
static PFN_vkWaitForFences pWaitForFences;
/* the DXVK-shaped init probe's own resolutions */
static PFN_vkCreateWin32SurfaceKHR pCreateWin32SurfaceKHR;
static PFN_vkGetSemaphoreCounterValue pGetSemaphoreCounterValue;
static PFN_vkWaitSemaphores pWaitSemaphores;
static PFN_vkSignalSemaphore pSignalSemaphore;
static PFN_vkGetPhysicalDeviceFeatures pGetPhysicalDeviceFeatures;
static PFN_vkGetPhysicalDeviceFeatures2 pGetPhysicalDeviceFeatures2;
static PFN_vkGetPhysicalDeviceProperties2 pGetPhysicalDeviceProperties2;
static PFN_vkCreateSemaphore pCreateSemaphore;
static PFN_vkDestroySemaphore pDestroySemaphore;

#define R(type, name, inst) do { name = (PFN_##type)vkfix_must(gipa((inst), #type), #type); } while (0)

/* ---------------------------------------------------------------------------
 * probe_dxvk_init — DXVK's own admission sequence, run against the boundary.
 *
 * Four things, in DXVK's order, each of which used to be a hard wall:
 *   1. isCompatible(): apiVersion >= 1.3, instance has VK_KHR_surface +
 *      VK_KHR_win32_surface, device advertises the required extension set.
 *   2. isSuitable(): the core bits and the whole Features2 pNext chain read
 *      back as supported (the host must WALK the chain, not ignore it).
 *   3. createDevice() with every one of those extensions + the full feature
 *      blob — which must succeed and hand back a live device.
 *   4. The first command-list flush's tracking fence: a TIMELINE semaphore,
 *      signalled through vkQueueSubmit's pNext, read with
 *      vkGetSemaphoreCounterValue, waited on with vkWaitSemaphores, plus the
 *      host-signalled path. DXVK does this on every flush.
 *   5. vkCreateWin32SurfaceKHR — the surface a wine-hosted DXVK must build a
 *      swapchain on.
 *
 * Returns 0 when every check held. Prints one 'vkfix: ok  dxvk: …' per step.
 * ------------------------------------------------------------------------- */
static int probe_dxvk_init(VkInstance instance, VkPhysicalDevice pd) {
    printf("vkfix: dxvk-probe: begin\n");
    fflush(stdout);

    /* --- 1a. apiVersion ---------------------------------------------------- */
    PFN_vkGetPhysicalDeviceProperties pProps =
        (PFN_vkGetPhysicalDeviceProperties)vkfix_must(gipa(instance, "vkGetPhysicalDeviceProperties"),
                                                      "vkGetPhysicalDeviceProperties");
    VkPhysicalDeviceProperties pdp;
    pProps(pd, &pdp);
    NEED(pdp.apiVersion >= VK_API_VERSION_1_3,
         "apiVersion %u.%u.%u < 1.3 — DXVK skips the adapter outright",
         VK_VERSION_MAJOR(pdp.apiVersion), VK_VERSION_MINOR(pdp.apiVersion), VK_VERSION_PATCH(pdp.apiVersion));

    /* --- 1b. instance extensions ------------------------------------------ */
    PFN_vkEnumerateInstanceExtensionProperties pInstExts =
        (PFN_vkEnumerateInstanceExtensionProperties)vkfix_must(
            gipa(NULL, "vkEnumerateInstanceExtensionProperties"), "vkEnumerateInstanceExtensionProperties");
    uint32_t nie = 0;
    pInstExts(NULL, &nie, NULL);
    VkExtensionProperties ie[32];
    if (nie > 32) nie = 32;
    pInstExts(NULL, &nie, ie);
    for (uint32_t i = 0; i < nie; i++)
        if (strcmp(ie[i].extensionName, VK_KHR_SURFACE_EXTENSION_NAME) == 0 ||
            strcmp(ie[i].extensionName, "VK_KHR_win32_surface") == 0) goto have_inst_exts;
    PROBE_FAIL("no VK_KHR_surface / VK_KHR_win32_surface: winevulkan has no surface to create");
have_inst_exts:
    printf("vkfix: ok  dxvk: apiVersion %u.%u.%u + surface extensions\n",
           VK_VERSION_MAJOR(pdp.apiVersion), VK_VERSION_MINOR(pdp.apiVersion), VK_VERSION_PATCH(pdp.apiVersion));

    /* --- 1c. the required DEVICE extension set ----------------------------- */
    static const char* const kReq[] = {
        VK_KHR_SWAPCHAIN_EXTENSION_NAME, "VK_KHR_maintenance5", "VK_KHR_load_store_op_none",
        VK_EXT_ROBUSTNESS_2_EXTENSION_NAME, VK_EXT_TRANSFORM_FEEDBACK_EXTENSION_NAME,
        VK_EXT_DEPTH_CLIP_ENABLE_EXTENSION_NAME,
    };
    PFN_vkEnumerateDeviceExtensionProperties pDevExts =
        (PFN_vkEnumerateDeviceExtensionProperties)vkfix_must(
            gipa(instance, "vkEnumerateDeviceExtensionProperties"), "vkEnumerateDeviceExtensionProperties");
    uint32_t nde2 = 0;
    pDevExts(pd, NULL, &nde2, NULL);
    VkExtensionProperties de2[32];
    if (nde2 > 32) nde2 = 32;
    pDevExts(pd, NULL, &nde2, de2);
    for (unsigned k = 0; k < sizeof(kReq) / sizeof(kReq[0]); k++) {
        int found = 0;
        for (uint32_t i = 0; i < nde2; i++)
            if (strcmp(de2[i].extensionName, kReq[k]) == 0) { found = 1; break; }
        NEED(found, "required device extension '%s' is not advertised", kReq[k]);
    }
    printf("vkfix: ok  dxvk: %u/%u required device extensions advertised\n",
           (unsigned)(sizeof(kReq) / sizeof(kReq[0])), (unsigned)nde2);

    /* --- 2a. the core bits isSuitable() reads ----------------------------- */
    R(vkGetPhysicalDeviceFeatures, pGetPhysicalDeviceFeatures, instance);
    VkPhysicalDeviceFeatures core;
    memset(&core, 0, sizeof(core));
    pGetPhysicalDeviceFeatures(pd, &core);
    NEED(core.imageCubeArray, "core feature imageCubeArray is FALSE (D3D11 cube arrays)");
    NEED(core.independentBlend, "core feature independentBlend is FALSE (D3D11 blend targets)");
    NEED(core.shaderInt64, "core feature shaderInt64 is FALSE");
    NEED(core.shaderFloat64, "core feature shaderFloat64 is FALSE");
    NEED(core.robustBufferAccess && core.fullDrawIndexUint32, "core robustBufferAccess/fullDrawIndexUint32 FALSE");

    /* --- 2b. the Features2 pNext chain ------------------------------------
     * Every struct here is chained exactly as DXVK chains them, and every bit
     * is asserted afterwards: the host has to WALK the chain and write the
     * answers back into this same buffer, because that is where DXVK reads them
     * from. A walker that only fills the root struct leaves all of this zero. */
    VkPhysicalDeviceRobustness2FeaturesEXT r2 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ROBUSTNESS_2_FEATURES_EXT };
    VkPhysicalDeviceTransformFeedbackFeaturesEXT tf = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TRANSFORM_FEEDBACK_FEATURES_EXT };
    VkPhysicalDeviceDescriptorIndexingFeatures di = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DESCRIPTOR_INDEXING_FEATURES };
    VkPhysicalDeviceShaderFloat16Int8Features f16 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_FLOAT16_INT8_FEATURES };
    VkPhysicalDevice16BitStorageFeatures s16 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_16BIT_STORAGE_FEATURES };
    VkPhysicalDevice8BitStorageFeatures s8 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_8BIT_STORAGE_FEATURES };
    VkPhysicalDeviceScalarBlockLayoutFeatures sbl = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SCALAR_BLOCK_LAYOUT_FEATURES };
    VkPhysicalDeviceDepthClipEnableFeaturesEXT dce = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DEPTH_CLIP_ENABLE_FEATURES_EXT };
    VkPhysicalDeviceMaintenance5Features m5 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_5_FEATURES };
    VkPhysicalDeviceMaintenance6Features m6 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_6_FEATURES };
    VkPhysicalDeviceVulkan12Features v12 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES };
    /* chained oldest-last, exactly like every Vulkan loader-built chain */
    di.pNext = &tf; tf.pNext = &sbl; sbl.pNext = &s16; s16.pNext = &s8; s8.pNext = &f16;
    f16.pNext = &m5; m5.pNext = &m6; m6.pNext = &dce; dce.pNext = &v12; v12.pNext = &r2;
    VkPhysicalDeviceFeatures2 feat2 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, .pNext = &di };
    R(vkGetPhysicalDeviceFeatures2, pGetPhysicalDeviceFeatures2, instance);
    pGetPhysicalDeviceFeatures2(pd, &feat2);
    NEED(r2.nullDescriptor, "robustness2.nullDescriptor FALSE — DXVK 'will not run without' it");
    NEED(r2.robustBufferAccess2 && r2.robustImageAccess2, "robustness2 robust*2 FALSE");
    NEED(m5.maintenance5, "maintenance5 FALSE");
    NEED(m6.maintenance6, "maintenance6 FALSE");
    NEED(tf.transformFeedback && tf.geometryStreams, "transformFeedback/geometryStreams FALSE");
    NEED(di.descriptorBindingPartiallyBound && di.runtimeDescriptorArray,
         "descriptor-indexing partiallyBound/runtimeDescriptorArray FALSE");
    NEED(di.descriptorBindingUniformBufferUpdateAfterBind,
         "descriptor-indexing update-after-bind FALSE");
    NEED(f16.shaderFloat16 && f16.shaderInt8, "shaderFloat16/shaderInt8 FALSE");
    NEED(s16.storageBuffer16BitAccess && s16.uniformAndStorageBuffer16BitAccess, "16-bit storage FALSE");
    NEED(s8.storageBuffer8BitAccess && s8.uniformAndStorageBuffer8BitAccess, "8-bit storage FALSE");
    NEED(sbl.scalarBlockLayout, "scalarBlockLayout FALSE");
    NEED(dce.depthClipEnable, "depthClipEnable FALSE");
    NEED(v12.timelineSemaphore, "Vulkan12.timelineSemaphore FALSE — DXVK's per-flush fence would die");
    NEED(v12.descriptorIndexing, "Vulkan12.descriptorIndexing FALSE");
    NEED(!v12.bufferDeviceAddress, "Vulkan12.bufferDeviceAddress TRUE is unproven — must stay off until the BDA audit");

    /* --- 2c. the Properties2 chain ----------------------------------------
     * Zeros degrade gracefully here, EXCEPT the update-after-bind limits:
     * DXVK refuses descriptor-indexing layouts above them, so advertising the
     * features above with a zero limit is a self-contradictory device. */
    VkPhysicalDeviceIDProperties idp = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES };
    VkPhysicalDeviceSubgroupProperties sgp = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_PROPERTIES };
    VkPhysicalDeviceDescriptorIndexingProperties dip = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DESCRIPTOR_INDEXING_PROPERTIES };
    VkPhysicalDeviceTransformFeedbackPropertiesEXT tfp = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TRANSFORM_FEEDBACK_PROPERTIES_EXT };
    VkPhysicalDeviceMaintenance5Properties m5p = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_5_PROPERTIES };
    VkPhysicalDeviceVulkan11Properties v11p = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_PROPERTIES };
    VkPhysicalDeviceVulkan12Properties v12p = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_PROPERTIES };
    sgp.pNext = &idp; idp.pNext = &v11p; v11p.pNext = &dip; dip.pNext = &tfp; tfp.pNext = &m5p; m5p.pNext = &v12p;
    VkPhysicalDeviceProperties2 prop2 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &sgp };
    R(vkGetPhysicalDeviceProperties2, pGetPhysicalDeviceProperties2, instance);
    pGetPhysicalDeviceProperties2(pd, &prop2);
    NEED(dip.maxDescriptorSetUpdateAfterBindUniformBuffers > 0 &&
         dip.maxPerStageDescriptorUpdateAfterBindUniformBuffers > 0,
         "descriptor-indexing update-after-bind limits are zero — the features above contradict them");
    NEED(dip.maxUpdateAfterBindDescriptorsInAllPools > 0, "maxUpdateAfterBindDescriptorsInAllPools is zero");
    NEED(tfp.maxTransformFeedbackStreams > 0 && tfp.maxTransformFeedbackBufferSize > 0,
         "transform-feedback properties are zero");
    NEED(sgp.subgroupSize >= 4 && sgp.subgroupSize <= 128, "subgroupSize %u out of range", (unsigned)sgp.subgroupSize);
    NEED(v11p.subgroupSize >= 4, "VkPhysicalDeviceVulkan11Properties.subgroupSize %u zero", (unsigned)v11p.subgroupSize);
    printf("vkfix: ok  dxvk: features2 + properties2 pNext chains walked (%u updateAfterBind UBOs, subgroup %u)\n",
           (unsigned)dip.maxDescriptorSetUpdateAfterBindUniformBuffers, (unsigned)sgp.subgroupSize);

    /* --- 3. createDevice with every extension and the full feature blob ---- */
    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci = { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
                                   .queueFamilyIndex = 0, .queueCount = 1, .pQueuePriorities = &prio };
    VkPhysicalDeviceFeatures enabled = core;
    VkPhysicalDeviceFeatures2 e12 = feat2;                 /* the same chain, TRUE now */
    VkDeviceCreateInfo dci = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .pNext = &e12,
                               .queueCreateInfoCount = 1, .pQueueCreateInfos = &qci,
                               .enabledExtensionCount = nde2, .ppEnabledExtensionNames = (const char* const*)de2,
                               .pEnabledFeatures = &enabled };
    R(vkCreateDevice, pCreateDevice, instance);
    VkDevice dev = VK_NULL_HANDLE;
    CHK(pCreateDevice(pd, &dci, NULL, &dev));
    NEED(dev != VK_NULL_HANDLE, "vkCreateDevice with the full DXVK caps returned a null device");
    R(vkGetDeviceQueue, pGetDeviceQueue, instance);
    VkQueue q = VK_NULL_HANDLE;
    pGetDeviceQueue(dev, 0, 0, &q);
    NEED(q != VK_NULL_HANDLE, "null queue from the DXVK-shaped device");
    step("dxvk: device created with the full extension + feature set");

    /* --- 4. the timeline-semaphore tracking fence -------------------------
     * DXVK puts a u64 wait/signal on every command-list flush. A submit with
     * no command buffer is legal and is the smallest thing that exercises the
     * submit pNext, so this is the whole flush path with the frame payload
     * left out. */
    R(vkCreateSemaphore, pCreateSemaphore, instance);
    VkSemaphoreTypeCreateInfo stci = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO,
                                       .semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE, .initialValue = 0 };
    VkSemaphoreCreateInfo sci = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO, .pNext = &stci };
    VkSemaphore tl = VK_NULL_HANDLE;
    CHK(pCreateSemaphore(dev, &sci, NULL, &tl));
    R(vkGetSemaphoreCounterValue, pGetSemaphoreCounterValue, instance);
    uint64_t value = 0xdeadbeef;
    CHK(pGetSemaphoreCounterValue(dev, tl, &value));
    NEED(value == 0, "fresh timeline semaphore counter is %llu, want 0", (unsigned long long)value);

    uint64_t signalTo[1] = { 7 };
    VkTimelineSemaphoreSubmitInfo tsi = { .sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
                                          .signalSemaphoreValueCount = 1, .pSignalSemaphoreValues = signalTo };
    VkSemaphore oneSem[1] = { tl };
    VkSubmitInfo flush = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .pNext = &tsi,
                           .signalSemaphoreCount = 1, .pSignalSemaphores = oneSem };
    R(vkQueueSubmit, pQueueSubmit, instance);
    CHK(pQueueSubmit(q, 1, &flush, VK_NULL_HANDLE));
    CHK(pGetSemaphoreCounterValue(dev, tl, &value));
    NEED(value == 7, "counter is %llu after a submit signalling 7", (unsigned long long)value);

    uint64_t wantVal[1] = { 7 };
    const VkSemaphore ws[1] = { tl };
    VkSemaphoreWaitInfo wi = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO,
                               .semaphoreCount = 1, .pSemaphores = ws, .pValues = wantVal };
    R(vkWaitSemaphores, pWaitSemaphores, instance);
    CHK(pWaitSemaphores(dev, &wi, UINT64_MAX));

    /* A value the queue has not reached, with timeout 0: the spec answer is
     * VK_TIMEOUT, and asserting it is what proves the emulation is not just
     * returning SUCCESS to everything. */
    wantVal[0] = 11;
    NEED(pWaitSemaphores(dev, &wi, 0) == VK_TIMEOUT,
         "vkWaitSemaphores for an unreached value with timeout 0 did not return VK_TIMEOUT");
    R(vkSignalSemaphore, pSignalSemaphore, instance);
    VkSemaphoreSignalInfo sgi = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO, .semaphore = tl, .value = 11 };
    CHK(pSignalSemaphore(dev, &sgi));
    CHK(pGetSemaphoreCounterValue(dev, tl, &value));
    NEED(value == 11, "counter is %llu after vkSignalSemaphore(11)", (unsigned long long)value);
    CHK(pWaitSemaphores(dev, &wi, 0));

    /* wait+signal in one submit, the shape DXVK's flush actually has */
    uint64_t waitVals[1] = { 11 }, sigVals[1] = { 20 };
    VkTimelineSemaphoreSubmitInfo tsi2 = { .sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
                                           .waitSemaphoreValueCount = 1, .pWaitSemaphoreValues = waitVals,
                                           .signalSemaphoreValueCount = 1, .pSignalSemaphoreValues = sigVals };
    VkSubmitInfo flush2 = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .pNext = &tsi2,
                            .waitSemaphoreCount = 1, .pWaitSemaphores = oneSem,
                            .signalSemaphoreCount = 1, .pSignalSemaphores = oneSem };
    CHK(pQueueSubmit(q, 1, &flush2, VK_NULL_HANDLE));
    CHK(pGetSemaphoreCounterValue(dev, tl, &value));
    NEED(value == 20, "counter is %llu after a wait 11 / signal 20 submit", (unsigned long long)value);
    printf("vkfix: ok  dxvk: timeline semaphore signal/wait/getCounter agree (counter %llu)\n",
           (unsigned long long)value);
    step("dxvk: timeline semaphore create-with-type, submit pNext, wait, signal, counter");

    /* --- 5. the Win32 surface winevulkan needs ---------------------------- */
    R(vkCreateWin32SurfaceKHR, pCreateWin32SurfaceKHR, instance);
    VkWin32SurfaceCreateInfoKHR_local wsci = {
        .sType = VK_STRUCTURE_TYPE_WIN32_SURFACE_CREATE_INFO_KHR,
        .flags = 0, .hwnd = (void*)(uintptr_t)0x1234
    };
    VkSurfaceKHR win32 = VK_NULL_HANDLE;
    CHK(pCreateWin32SurfaceKHR(instance, &wsci, NULL, &win32));
    NEED(win32 != VK_NULL_HANDLE, "vkCreateWin32SurfaceKHR returned a null surface");
    /* and it must answer like any other surface, or the swapchain path stalls.
     * Resolved HERE, not via the file-scope pGetPhysicalDeviceSurface*: the
     * probe runs before main() resolves those, and calling the still-NULL
     * pointer is a guest segfault, not a graceful FAIL. */
    PFN_vkGetPhysicalDeviceSurfaceCapabilitiesKHR wCaps =
        (PFN_vkGetPhysicalDeviceSurfaceCapabilitiesKHR)vkfix_must(
            gipa(instance, "vkGetPhysicalDeviceSurfaceCapabilitiesKHR"),
            "vkGetPhysicalDeviceSurfaceCapabilitiesKHR");
    PFN_vkGetPhysicalDeviceSurfaceFormatsKHR wFmts =
        (PFN_vkGetPhysicalDeviceSurfaceFormatsKHR)vkfix_must(
            gipa(instance, "vkGetPhysicalDeviceSurfaceFormatsKHR"),
            "vkGetPhysicalDeviceSurfaceFormatsKHR");
    PFN_vkGetPhysicalDeviceSurfaceSupportKHR wSup =
        (PFN_vkGetPhysicalDeviceSurfaceSupportKHR)vkfix_must(
            gipa(instance, "vkGetPhysicalDeviceSurfaceSupportKHR"),
            "vkGetPhysicalDeviceSurfaceSupportKHR");
    VkSurfaceCapabilitiesKHR wcaps;
    CHK(wCaps(pd, win32, &wcaps));
    uint32_t nsf = 0;
    CHK(wFmts(pd, win32, &nsf, NULL));
    VkSurfaceFormatKHR wfmt[8];
    if (nsf > 8) nsf = 8;
    CHK(wFmts(pd, win32, &nsf, wfmt));
    VkBool32 supported = VK_FALSE;
    CHK(wSup(pd, 0, win32, &supported));
    NEED(supported, "vkGetPhysicalDeviceSurfaceSupportKHR says the win32 surface cannot present");
    printf("vkfix: ok  dxvk: win32 surface 0x%llx (%u format(s), presentable)\n",
           (unsigned long long)win32, (unsigned)nsf);
    step("dxvk: vkCreateWin32SurfaceKHR + surface queries");

    /* --- teardown, so the trap log shows the whole probe ------------------- */
    R(vkDestroySemaphore, pDestroySemaphore, instance);
    pDestroySemaphore(dev, tl, NULL);
    PFN_vkDestroySurfaceKHR pDestroySurface =
        (PFN_vkDestroySurfaceKHR)vkfix_must(gipa(instance, "vkDestroySurfaceKHR"), "vkDestroySurfaceKHR");
    pDestroySurface(instance, win32, NULL);
    R(vkDestroyDevice, pDestroyDevice, instance);
    pDestroyDevice(dev, NULL);
    printf("vkfix: dxvk-probe: PASS\n");
    fflush(stdout);
    return 0;
}

int main(int argc, char** argv) {
    unsigned width = 64, height = 64;
    if (argc > 1) width = (unsigned)strtoul(argv[1], NULL, 0);
    if (argc > 2) height = (unsigned)strtoul(argv[2], NULL, 0);
    printf("vkfix: start %ux%u\n", width, height);
    fflush(stdout);

    /* ---- 1. the load path under test ---------------------------------- */
    void* lib = dlopen("libvulkan.so.1", RTLD_NOW);
    if (!lib) { printf("vkfix: FAIL dlopen libvulkan.so.1: %s\n", dlerror()); printf("vkfix: RESULT 1\n"); return 1; }
    gipa = (PFN_vkGetInstanceProcAddr)dlsym(lib, "vkGetInstanceProcAddr");
    if (!gipa) { printf("vkfix: FAIL no vkGetInstanceProcAddr\n"); printf("vkfix: RESULT 1\n"); return 1; }
    step("dlopen libvulkan.so.1 + dlsym(vkGetInstanceProcAddr)");

    /* Global commands MUST resolve with a NULL instance (loader-spec rule). */
    {
        PFN_vkEnumerateInstanceVersion eiv = (PFN_vkEnumerateInstanceVersion)gipa(NULL, "vkEnumerateInstanceVersion");
        if (!eiv) { printf("vkfix: FAIL vkEnumerateInstanceVersion NULL\n"); printf("vkfix: RESULT 1\n"); return 1; }
        uint32_t ver = 0;
        CHK(eiv(&ver));
        printf("vkfix: instance apiVersion %u.%u.%u\n",
               VK_VERSION_MAJOR(ver), VK_VERSION_MINOR(ver), VK_VERSION_PATCH(ver));
        step("vkEnumerateInstanceVersion");
    }
    {
        PFN_vkEnumerateInstanceExtensionProperties eiep =
            (PFN_vkEnumerateInstanceExtensionProperties)gipa(NULL, "vkEnumerateInstanceExtensionProperties");
        uint32_t n = 0;
        if (!eiep) { printf("vkfix: FAIL no vkEnumerateInstanceExtensionProperties\n"); printf("vkfix: RESULT 1\n"); return 1; }
        CHK(eiep(NULL, &n, NULL));
        VkExtensionProperties props[32];
        if (n > 32) n = 32;
        CHK(eiep(NULL, &n, props));
        printf("vkfix: instance extensions %u:", (unsigned)n);
        for (uint32_t i = 0; i < n; i++) printf(" %s", props[i].extensionName);
        printf("\n");
        fflush(stdout);
        step("vkEnumerateInstanceExtensionProperties");
    }

    /* ---- 2. instance --------------------------------------------------- */
    VkApplicationInfo ai = { .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
                             .pApplicationName = "vkfixture",
                             .apiVersion = VK_API_VERSION_1_1 };
    const char* inst_exts[] = { VK_KHR_SURFACE_EXTENSION_NAME, VK_EXT_HEADLESS_SURFACE_EXTENSION_NAME };
    VkInstanceCreateInfo ici = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
                                 .pApplicationInfo = &ai,
                                 .enabledExtensionCount = 2,
                                 .ppEnabledExtensionNames = inst_exts };
    PFN_vkCreateInstance gCreateInstance = (PFN_vkCreateInstance)gipa(NULL, "vkCreateInstance");
    if (!gCreateInstance) { printf("vkfix: FAIL no vkCreateInstance\n"); printf("vkfix: RESULT 1\n"); return 1; }
    VkInstance instance = VK_NULL_HANDLE;
    CHK(gCreateInstance(&ici, NULL, &instance));
    step("vkCreateInstance");

    /* ---- 3. physical device -------------------------------------------- */
    R(vkEnumeratePhysicalDevices, pEnumeratePhysicalDevices, instance);
    uint32_t npd = 0;
    CHK(pEnumeratePhysicalDevices(instance, &npd, NULL));
    if (!npd) { printf("vkfix: FAIL no physical devices\n"); printf("vkfix: RESULT 1\n"); return 1; }
    VkPhysicalDevice phys[4];
    if (npd > 4) npd = 4;
    CHK(pEnumeratePhysicalDevices(instance, &npd, phys));
    VkPhysicalDevice pd = phys[0];
    if (!pd) { printf("vkfix: FAIL null physical device handle\n"); printf("vkfix: RESULT 1\n"); return 1; }

    R(vkGetPhysicalDeviceProperties, pGetPhysicalDeviceProperties, instance);
    VkPhysicalDeviceProperties pdp;
    pGetPhysicalDeviceProperties(pd, &pdp);
    printf("vkfix: device '%s' apiVersion %u.%u.%u type %d\n", pdp.deviceName,
           VK_VERSION_MAJOR(pdp.apiVersion), VK_VERSION_MINOR(pdp.apiVersion),
           VK_VERSION_PATCH(pdp.apiVersion), (int)pdp.deviceType);
    printf("vkfix: limits maxPushConstantsSize=%u maxImageDimension2D=%u maxBoundDescriptorSets=%u\n",
           pdp.limits.maxPushConstantsSize, pdp.limits.maxImageDimension2D, pdp.limits.maxBoundDescriptorSets);

    R(vkGetPhysicalDeviceQueueFamilyProperties, pGetPhysicalDeviceQueueFamilyProperties, instance);
    uint32_t nq = 0;
    pGetPhysicalDeviceQueueFamilyProperties(pd, &nq, NULL);
    if (!nq) { printf("vkfix: FAIL no queue families\n"); printf("vkfix: RESULT 1\n"); return 1; }
    VkQueueFamilyProperties qfp[4];
    if (nq > 4) nq = 4;
    pGetPhysicalDeviceQueueFamilyProperties(pd, &nq, qfp);
    printf("vkfix: queue families %u (family0 flags 0x%x count %u)\n", (unsigned)nq, qfp[0].queueFlags, qfp[0].queueCount);

    R(vkGetPhysicalDeviceMemoryProperties, pGetPhysicalDeviceMemoryProperties, instance);
    VkPhysicalDeviceMemoryProperties pdmp;
    pGetPhysicalDeviceMemoryProperties(pd, &pdmp);
    printf("vkfix: memory heaps %u types %u\n", (unsigned)pdmp.memoryHeapCount, (unsigned)pdmp.memoryTypeCount);

    R(vkEnumerateDeviceExtensionProperties, pEnumerateDeviceExtensionProperties, instance);
    uint32_t nde = 0;
    pEnumerateDeviceExtensionProperties(pd, NULL, &nde, NULL);
    VkExtensionProperties de[16];
    if (nde > 16) nde = 16;
    if (nde) pEnumerateDeviceExtensionProperties(pd, NULL, &nde, de);
    printf("vkfix: device extensions %u:", (unsigned)nde);
    for (uint32_t i = 0; i < nde; i++) printf(" %s", de[i].extensionName);
    printf("\n");
    fflush(stdout);
    step("physical device queries");

    /* ---- 3b. DXVK-shaped init probe (audit P2-NOW items 1-4) --------------
     *
     * DXVK gates itself twice before it will touch a device
     * (dxvk_adapter.cpp / dxvk_device_info.h). isCompatible() reads apiVersion
     * and scans the reported extension lists; isSuitable() then reads the
     * feature structs back OUT of the same pNext buffer it passed in. Either
     * check failing means "Skipping: Device does not support required feature"
     * and then "No adapters found" — a silent zero-adapter world, not an error.
     *
     * So this reproduces that gate exactly, and then does what DXVK's first
     * command-list flush does: a timeline semaphore create/signal/wait. No D3D,
     * no window, no d3d11.dll — just the boundary behaviour DXVK needs. */
    if (probe_dxvk_init(instance, pd) != 0) return 1;

    /* ---- 4. device + queue --------------------------------------------- */
    const char* dev_exts[] = { VK_KHR_SWAPCHAIN_EXTENSION_NAME };
    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci = { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
                                   .queueFamilyIndex = 0, .queueCount = 1, .pQueuePriorities = &prio };
    VkDeviceCreateInfo dci = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
                               .queueCreateInfoCount = 1, .pQueueCreateInfos = &qci,
                               .enabledExtensionCount = 1, .ppEnabledExtensionNames = dev_exts };
    R(vkCreateDevice, pCreateDevice, instance);
    VkDevice device = VK_NULL_HANDLE;
    CHK(pCreateDevice(pd, &dci, NULL, &device));
    R(vkGetDeviceQueue, pGetDeviceQueue, instance);
    VkQueue queue = VK_NULL_HANDLE;
    pGetDeviceQueue(device, 0, 0, &queue);
    if (!queue) { printf("vkfix: FAIL null queue handle\n"); printf("vkfix: RESULT 1\n"); return 1; }
    printf("vkfix: device=0x%llx queue=0x%llx\n",
           (unsigned long long)device, (unsigned long long)queue);
    step("vkCreateDevice + vkGetDeviceQueue");

    /* ---- 5. surface + swapchain (headless: no window in the guest) ----- */
    R(vkCreateHeadlessSurfaceEXT, pCreateHeadlessSurfaceEXT, instance);
    VkHeadlessSurfaceCreateInfoEXT hsci = { .sType = VK_STRUCTURE_TYPE_HEADLESS_SURFACE_CREATE_INFO_EXT };
    VkSurfaceKHR surface = VK_NULL_HANDLE;
    CHK(pCreateHeadlessSurfaceEXT(instance, &hsci, NULL, &surface));
    R(vkGetPhysicalDeviceSurfaceCapabilitiesKHR, pGetPhysicalDeviceSurfaceCapabilitiesKHR, instance);
    VkSurfaceCapabilitiesKHR caps;
    CHK(pGetPhysicalDeviceSurfaceCapabilitiesKHR(pd, surface, &caps));
    printf("vkfix: surface caps currentExtent %ux%u (0xffffffff = undefined)\n",
           caps.currentExtent.width, caps.currentExtent.height);
    R(vkGetPhysicalDeviceSurfaceFormatsKHR, pGetPhysicalDeviceSurfaceFormatsKHR, instance);
    uint32_t nsf = 0;
    CHK(pGetPhysicalDeviceSurfaceFormatsKHR(pd, surface, &nsf, NULL));
    VkSurfaceFormatKHR sfmt[8];
    if (nsf > 8) nsf = 8;
    CHK(pGetPhysicalDeviceSurfaceFormatsKHR(pd, surface, &nsf, sfmt));
    VkFormat colorFmt = sfmt[0].format;
    R(vkGetPhysicalDeviceSurfacePresentModesKHR, pGetPhysicalDeviceSurfacePresentModesKHR, instance);
    uint32_t npm = 0;
    CHK(pGetPhysicalDeviceSurfacePresentModesKHR(pd, surface, &npm, NULL));
    VkPresentModeKHR pmodes[8];
    if (npm > 8) npm = 8;
    if (npm) CHK(pGetPhysicalDeviceSurfacePresentModesKHR(pd, surface, &npm, pmodes));

    uint32_t qfams[] = { 0 };
    VkSwapchainCreateInfoKHR sci = { .sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR,
                                     .surface = surface, .minImageCount = 2,
                                     .imageFormat = colorFmt,
                                     .imageColorSpace = sfmt[0].colorSpace,
                                     .imageExtent = { width, height },
                                     .imageArrayLayers = 1,
                                     .imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
                                     .imageSharingMode = VK_SHARING_MODE_EXCLUSIVE,
                                     .queueFamilyIndexCount = 1, .pQueueFamilyIndices = qfams,
                                     .preTransform = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR,
                                     .compositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR,
                                     .presentMode = VK_PRESENT_MODE_FIFO_KHR,
                                     .clipped = VK_TRUE };
    R(vkCreateSwapchainKHR, pCreateSwapchainKHR, instance);
    VkSwapchainKHR swapchain = VK_NULL_HANDLE;
    CHK(pCreateSwapchainKHR(device, &sci, NULL, &swapchain));
    R(vkGetSwapchainImagesKHR, pGetSwapchainImagesKHR, instance);
    uint32_t nimg = 0;
    CHK(pGetSwapchainImagesKHR(device, swapchain, &nimg, NULL));
    VkImage scImages[8];
    if (nimg > 8) nimg = 8;
    CHK(pGetSwapchainImagesKHR(device, swapchain, &nimg, scImages));
    printf("vkfix: swapchain %ux%u images %u\n", width, height, (unsigned)nimg);
    step("headless surface + swapchain");

    /* ---- 6. depth image ------------------------------------------------ */
    const VkFormat depthFmt = VK_FORMAT_D32_SFLOAT;
    VkImageCreateInfo dci2 = { .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
                               .imageType = VK_IMAGE_TYPE_2D, .format = depthFmt,
                               .extent = { width, height, 1 }, .mipLevels = 1, .arrayLayers = 1,
                               .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
                               .usage = VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT };
    R(vkCreateImage, pCreateImage, instance);
    VkImage depthImage = VK_NULL_HANDLE;
    CHK(pCreateImage(device, &dci2, NULL, &depthImage));
    R(vkGetImageMemoryRequirements, pGetImageMemoryRequirements, instance);
    VkMemoryRequirements depthReq;
    pGetImageMemoryRequirements(device, depthImage, &depthReq);

    /* ---- 7. memory + a uniform buffer written through the mapped VA ---- */
    R(vkAllocateMemory, pAllocateMemory, instance);
    VkMemoryAllocateInfo mai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                  .allocationSize = depthReq.size, .memoryTypeIndex = 0 };
    VkDeviceMemory depthMem = VK_NULL_HANDLE;
    CHK(pAllocateMemory(device, &mai, NULL, &depthMem));
    R(vkBindImageMemory, pBindImageMemory, instance);
    CHK(pBindImageMemory(device, depthImage, depthMem, 0));

    VkImageViewCreateInfo dvi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,
                                  .image = depthImage, .viewType = VK_IMAGE_VIEW_TYPE_2D,
                                  .format = depthFmt,
                                  .subresourceRange = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1 } };
    R(vkCreateImageView, pCreateImageView, instance);
    VkImageView depthView = VK_NULL_HANDLE;
    CHK(pCreateImageView(device, &dvi, NULL, &depthView));

    const VkDeviceSize uboSize = 128;
    VkBufferCreateInfo uboci = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
                                 .size = uboSize, .usage = VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT,
                                 .sharingMode = VK_SHARING_MODE_EXCLUSIVE };
    R(vkCreateBuffer, pCreateBuffer, instance);
    VkBuffer ubo = VK_NULL_HANDLE;
    CHK(pCreateBuffer(device, &uboci, NULL, &ubo));
    R(vkGetBufferMemoryRequirements, pGetBufferMemoryRequirements, instance);
    VkMemoryRequirements uboReq;
    pGetBufferMemoryRequirements(device, ubo, &uboReq);
    VkMemoryAllocateInfo umai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                  .allocationSize = uboReq.size, .memoryTypeIndex = 0 };
    VkDeviceMemory uboMem = VK_NULL_HANDLE;
    CHK(pAllocateMemory(device, &umai, NULL, &uboMem));
    R(vkBindBufferMemory, pBindBufferMemory, instance);
    CHK(pBindBufferMemory(device, ubo, uboMem, 0));
    /* THE guest-memory substrate: the host returns a GUEST VA here (P1 returned a
     * host malloc pointer). Writing through it must land in K64Page buffers and
     * be visible to the host's frame serializer as the UBO sidecar bytes. */
    R(vkMapMemory, pMapMemory, instance);
    void* mapped = NULL;
    CHK(pMapMemory(device, uboMem, 0, uboSize, 0, &mapped));
    if (!mapped) { printf("vkfix: FAIL vkMapMemory returned null\n"); printf("vkfix: RESULT 1\n"); return 1; }
    float* uboBytes = (float*)mapped;
    for (unsigned i = 0; i < uboSize / sizeof(float); i++) uboBytes[i] = (float)i * 0.5f;
    R(vkUnmapMemory, pUnmapMemory, instance);
    pUnmapMemory(device, uboMem);
    printf("vkfix: mapped UBO at guest va 0x%llx (%llu bytes written)\n",
           (unsigned long long)(uintptr_t)mapped, (unsigned long long)uboSize);
    step("vkAllocateMemory + vkMapMemory -> guest VA + write-through");

    /* ---- 8. a 4x4 texture uploaded through a staging buffer ----------- */
    const uint32_t texDim = 4;
    const VkDeviceSize texBytes = texDim * texDim * 4;
    uint8_t tex[16 * 16 * 4];
    for (unsigned i = 0; i < texDim * texDim; i++) {
        tex[i * 4 + 0] = (uint8_t)(i * 16);
        tex[i * 4 + 1] = (uint8_t)(255 - i * 16);
        tex[i * 4 + 2] = (uint8_t)(i * 7);
        tex[i * 4 + 3] = 255;
    }
    VkBufferCreateInfo tbci = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
                                .size = texBytes, .usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                                .sharingMode = VK_SHARING_MODE_EXCLUSIVE };
    VkBuffer staging = VK_NULL_HANDLE;
    CHK(pCreateBuffer(device, &tbci, NULL, &staging));
    VkMemoryRequirements stgReq;
    pGetBufferMemoryRequirements(device, staging, &stgReq);
    VkDeviceMemory stgMem = VK_NULL_HANDLE;
    VkMemoryAllocateInfo stgMai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                     .allocationSize = stgReq.size, .memoryTypeIndex = 0 };
    CHK(pAllocateMemory(device, &stgMai, NULL, &stgMem));
    CHK(pBindBufferMemory(device, staging, stgMem, 0));
    void* stgPtr = NULL;
    CHK(pMapMemory(device, stgMem, 0, texBytes, 0, &stgPtr));
    memcpy(stgPtr, tex, (size_t)texBytes);
    pUnmapMemory(device, stgMem);

    VkImageCreateInfo tici = { .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
                               .imageType = VK_IMAGE_TYPE_2D, .format = VK_FORMAT_R8G8B8A8_UNORM,
                               .extent = { texDim, texDim, 1 }, .mipLevels = 1, .arrayLayers = 1,
                               .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
                               .usage = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT };
    VkImage texImage = VK_NULL_HANDLE;
    CHK(pCreateImage(device, &tici, NULL, &texImage));
    VkMemoryRequirements texReq;
    pGetImageMemoryRequirements(device, texImage, &texReq);
    VkDeviceMemory texMem = VK_NULL_HANDLE;
    VkMemoryAllocateInfo texMai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                     .allocationSize = texReq.size, .memoryTypeIndex = 0 };
    CHK(pAllocateMemory(device, &texMai, NULL, &texMem));
    CHK(pBindImageMemory(device, texImage, texMem, 0));

    VkImageViewCreateInfo tivi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,
                                   .image = texImage, .viewType = VK_IMAGE_VIEW_TYPE_2D,
                                   .format = VK_FORMAT_R8G8B8A8_UNORM,
                                   .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
    VkImageView texView = VK_NULL_HANDLE;
    CHK(pCreateImageView(device, &tivi, NULL, &texView));

    VkSamplerCreateInfo smpci = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO,
                                  .magFilter = VK_FILTER_NEAREST, .minFilter = VK_FILTER_NEAREST,
                                  .mipmapMode = VK_SAMPLER_MIPMAP_MODE_NEAREST,
                                  .addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                                  .addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                                  .addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                                  .maxAnisotropy = 1.0f };
    R(vkCreateSampler, pCreateSampler, instance);
    VkSampler sampler = VK_NULL_HANDLE;
    CHK(pCreateSampler(device, &smpci, NULL, &sampler));
    step("texture image + staging buffer + view + sampler");

    /* ---- 9. render pass + framebuffer --------------------------------- */
    VkAttachmentDescription atts[2] = { {0}, {0} };
    atts[0].format = colorFmt;
    atts[0].samples = VK_SAMPLE_COUNT_1_BIT;
    atts[0].loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    atts[0].storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    atts[0].stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
    atts[0].stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
    atts[0].initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    atts[0].finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
    atts[1].format = depthFmt;
    atts[1].samples = VK_SAMPLE_COUNT_1_BIT;
    atts[1].loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    atts[1].storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
    atts[1].stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
    atts[1].stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
    atts[1].initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    atts[1].finalLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
    VkAttachmentReference colorRef = { 0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL };
    VkAttachmentReference depthRef = { 1, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL };
    VkSubpassDescription sub = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
                                  .colorAttachmentCount = 1, .pColorAttachments = &colorRef,
                                  .pDepthStencilAttachment = &depthRef };
    VkRenderPassCreateInfo rpci = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO,
                                    .attachmentCount = 2, .pAttachments = atts,
                                    .subpassCount = 1, .pSubpasses = &sub };
    R(vkCreateRenderPass, pCreateRenderPass, instance);
    VkRenderPass renderPass = VK_NULL_HANDLE;
    CHK(pCreateRenderPass(device, &rpci, NULL, &renderPass));
    VkImageViewCreateInfo cvi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,
                                  .image = scImages[0], .viewType = VK_IMAGE_VIEW_TYPE_2D,
                                  .format = colorFmt,
                                  .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
    R(vkCreateImageView, pCreateImageView, instance);
    VkImageView colorView = VK_NULL_HANDLE;
    CHK(pCreateImageView(device, &cvi, NULL, &colorView));
    VkImageView fbViews[2] = { colorView, depthView };
    VkFramebufferCreateInfo fbci = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO,
                                     .renderPass = renderPass, .attachmentCount = 2,
                                     .pAttachments = fbViews, .width = width, .height = height, .layers = 1 };
    R(vkCreateFramebuffer, pCreateFramebuffer, instance);
    VkFramebuffer framebuffer = VK_NULL_HANDLE;
    CHK(pCreateFramebuffer(device, &fbci, NULL, &framebuffer));
    step("render pass + framebuffer");

    /* ---- 10. descriptors ---------------------------------------------- */
    VkDescriptorSetLayoutBinding binds[2] = { {0}, {0} };
    binds[0].binding = 0; binds[0].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    binds[0].descriptorCount = 1; binds[0].stageFlags = VK_SHADER_STAGE_VERTEX_BIT;
    binds[1].binding = 1; binds[1].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    binds[1].descriptorCount = 1;
    binds[1].stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT;
    VkDescriptorSetLayoutCreateInfo dslci = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                              .bindingCount = 2, .pBindings = binds };
    R(vkCreateDescriptorSetLayout, pCreateDescriptorSetLayout, instance);
    VkDescriptorSetLayout setLayout = VK_NULL_HANDLE;
    CHK(pCreateDescriptorSetLayout(device, &dslci, NULL, &setLayout));

    VkDescriptorPoolSize psizes[2] = { { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1 },
                                       { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1 } };
    VkDescriptorPoolCreateInfo dpci = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
                                        .maxSets = 1, .poolSizeCount = 2, .pPoolSizes = psizes };
    R(vkCreateDescriptorPool, pCreateDescriptorPool, instance);
    VkDescriptorPool descPool = VK_NULL_HANDLE;
    CHK(pCreateDescriptorPool(device, &dpci, NULL, &descPool));
    VkDescriptorSetLayout oneLayout = setLayout;
    VkDescriptorSetAllocateInfo dsai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                         .descriptorPool = descPool, .descriptorSetCount = 1,
                                         .pSetLayouts = &oneLayout };
    R(vkAllocateDescriptorSets, pAllocateDescriptorSets, instance);
    VkDescriptorSet descSet = VK_NULL_HANDLE;
    CHK(pAllocateDescriptorSets(device, &dsai, &descSet));
    VkDescriptorBufferInfo dbi = { ubo, 0, uboSize };
    /* field order is (sampler, imageView, imageLayout) */
    VkDescriptorImageInfo dii = { sampler, texView, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL };
    VkWriteDescriptorSet writes[2] = { {0}, {0} };
    writes[0].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    writes[0].dstSet = descSet; writes[0].dstBinding = 0; writes[0].descriptorCount = 1;
    writes[0].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER; writes[0].pBufferInfo = &dbi;
    writes[1].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    writes[1].dstSet = descSet; writes[1].dstBinding = 1; writes[1].descriptorCount = 1;
    writes[1].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER; writes[1].pImageInfo = &dii;
    R(vkUpdateDescriptorSets, pUpdateDescriptorSets, instance);
    pUpdateDescriptorSets(device, 2, writes, 0, NULL);
    step("descriptor set layout / pool / set / writes");

    /* ---- 11. shader modules + pipeline --------------------------------- */
    R(vkCreateShaderModule, pCreateShaderModule, instance);
    VkShaderModuleCreateInfo vsci = { .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
                                      .codeSize = sizeof(vkfix_vert_spv), .pCode = vkfix_vert_spv };
    VkShaderModule vs = VK_NULL_HANDLE, fs = VK_NULL_HANDLE;
    CHK(pCreateShaderModule(device, &vsci, NULL, &vs));
    VkShaderModuleCreateInfo fsci = { .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
                                      .codeSize = sizeof(vkfix_frag_spv), .pCode = vkfix_frag_spv };
    CHK(pCreateShaderModule(device, &fsci, NULL, &fs));

    VkPipelineLayoutCreateInfo plci = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                        .setLayoutCount = 1, .pSetLayouts = &oneLayout };
    R(vkCreatePipelineLayout, pCreatePipelineLayout, instance);
    VkPipelineLayout pipelineLayout = VK_NULL_HANDLE;
    CHK(pCreatePipelineLayout(device, &plci, NULL, &pipelineLayout));
    R(vkCreatePipelineCache, pCreatePipelineCache, instance);
    VkPipelineCacheCreateInfo pcci = { .sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO };
    VkPipelineCache pipelineCache = VK_NULL_HANDLE;
    CHK(pCreatePipelineCache(device, &pcci, NULL, &pipelineCache));

    /* Two vertex attributes (position + colour), matching what vkcube's vertex
     * stage declares. No vertex buffer is ever bound: this fixture proves the
     * BOUNDARY, and the manifest records the draw, not the vertex bytes. */
    VkVertexInputBindingDescription vib = { .binding = 0, .stride = 32, .inputRate = VK_VERTEX_INPUT_RATE_VERTEX };
    VkVertexInputAttributeDescription vias[2] = { {0}, {0} };
    vias[0].location = 0; vias[0].binding = 0; vias[0].format = VK_FORMAT_R32G32B32_SFLOAT; vias[0].offset = 0;
    vias[1].location = 1; vias[1].binding = 0; vias[1].format = VK_FORMAT_R32G32B32A32_SFLOAT; vias[1].offset = 12;
    VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
                                                 .vertexBindingDescriptionCount = 1, .pVertexBindingDescriptions = &vib,
                                                 .vertexAttributeDescriptionCount = 2, .pVertexAttributeDescriptions = vias };
    VkPipelineInputAssemblyStateCreateInfo ias = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                   .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, .primitiveRestartEnable = VK_FALSE };
    VkViewport viewport = { 0, 0, (float)width, (float)height, 0.0f, 1.0f };
    VkRect2D scissor = { { 0, 0 }, { width, height } };
    VkPipelineViewportStateCreateInfo vps = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
                                              .viewportCount = 1, .pViewports = &viewport,
                                              .scissorCount = 1, .pScissors = &scissor };
    VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                   .polygonMode = VK_POLYGON_MODE_FILL,
                                                   .cullMode = VK_CULL_MODE_BACK_BIT,
                                                   .frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE,
                                                   .lineWidth = 1.0f };
    VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
    VkPipelineDepthStencilStateCreateInfo ds = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO,
                                                  .depthTestEnable = VK_TRUE, .depthWriteEnable = VK_TRUE,
                                                  .depthCompareOp = VK_COMPARE_OP_LESS_OR_EQUAL };
    VkPipelineColorBlendAttachmentState cba = { .blendEnable = VK_FALSE,
                                                 .colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT |
                                                                  VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT };
    VkPipelineColorBlendStateCreateInfo cbs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                .attachmentCount = 1, .pAttachments = &cba };
    VkPipelineShaderStageCreateInfo stages[2] = { {0}, {0} };
    stages[0].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT; stages[0].module = vs; stages[0].pName = "main";
    stages[1].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT; stages[1].module = fs; stages[1].pName = "main";
    VkGraphicsPipelineCreateInfo gpci = { .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO,
                                          .stageCount = 2, .pStages = stages,
                                          .pVertexInputState = &vis, .pInputAssemblyState = &ias,
                                          .pViewportState = &vps, .pRasterizationState = &rs,
                                          .pMultisampleState = &ms, .pDepthStencilState = &ds,
                                          .pColorBlendState = &cbs, .layout = pipelineLayout,
                                          .renderPass = renderPass, .subpass = 0 };
    R(vkCreateGraphicsPipelines, pCreateGraphicsPipelines, instance);
    VkPipeline pipeline = VK_NULL_HANDLE;
    CHK(pCreateGraphicsPipelines(device, pipelineCache, 1, &gpci, NULL, &pipeline));
    R(vkDestroyShaderModule, pDestroyShaderModule, instance);
    pDestroyShaderModule(device, vs, NULL);
    pDestroyShaderModule(device, fs, NULL);
    printf("vkfix: pipeline created (vkcube's own SPIR-V modules crossed)\n");
    step("vkCreateShaderModule + vkCreateGraphicsPipelines");

    /* ---- 12. record + submit + present -------------------------------- */
    VkCommandPoolCreateInfo cpci = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, .queueFamilyIndex = 0 };
    R(vkCreateCommandPool, pCreateCommandPool, instance);
    VkCommandPool pool = VK_NULL_HANDLE;
    CHK(pCreateCommandPool(device, &cpci, NULL, &pool));
    VkCommandBufferAllocateInfo cbai = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                         .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                         .commandBufferCount = 1 };
    R(vkAllocateCommandBuffers, pAllocateCommandBuffers, instance);
    VkCommandBuffer cmd = VK_NULL_HANDLE;
    CHK(pAllocateCommandBuffers(device, &cbai, &cmd));
    R(vkBeginCommandBuffer, pBeginCommandBuffer, instance);
    VkCommandBufferBeginInfo cbbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
    CHK(pBeginCommandBuffer(cmd, &cbbi));

    R(vkCmdCopyBufferToImage, pCmdCopyBufferToImage, instance);
    VkBufferImageCopy region = { .bufferOffset = 0, .bufferRowLength = 0, .bufferImageHeight = 0,
                                 .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                 .imageOffset = { 0, 0, 0 }, .imageExtent = { texDim, texDim, 1 } };
    pCmdCopyBufferToImage(cmd, staging, texImage, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
    R(vkCmdPipelineBarrier, pCmdPipelineBarrier, instance);
    pCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, 0,
                        0, NULL, 0, NULL, 0, NULL);

    VkClearValue clears[2];
    memset(clears, 0, sizeof(clears));
    clears[0].color.float32[0] = 0.2f; clears[0].color.float32[1] = 0.2f;
    clears[0].color.float32[2] = 0.2f; clears[0].color.float32[3] = 0.2f;
    clears[1].depthStencil.depth = 1.0f;
    VkRenderPassBeginInfo rpbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO,
                                   .renderPass = renderPass, .framebuffer = framebuffer,
                                   .renderArea = { { 0, 0 }, { width, height } },
                                   .clearValueCount = 2, .pClearValues = clears };
    R(vkCmdBeginRenderPass, pCmdBeginRenderPass, instance);
    pCmdBeginRenderPass(cmd, &rpbi, VK_SUBPASS_CONTENTS_INLINE);
    R(vkCmdSetViewport, pCmdSetViewport, instance);
    pCmdSetViewport(cmd, 0, 1, &viewport);
    R(vkCmdSetScissor, pCmdSetScissor, instance);
    pCmdSetScissor(cmd, 0, 1, &scissor);
    R(vkCmdBindPipeline, pCmdBindPipeline, instance);
    pCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
    R(vkCmdBindDescriptorSets, pCmdBindDescriptorSets, instance);
    pCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipelineLayout, 0, 1, &descSet, 0, NULL);
    /* Push constants. vkcube never pushes any, so this call used to be absent
     * from the boundary entirely — and DXVK pushes them per-draw for nearly
     * everything, so without it the record path cannot describe a DXVK frame.
     * 16 bytes at offset 0: inside maxPushConstantsSize, and non-zero so the
     * manifest's base64 blob is distinguishable from "nothing pushed". */
    float push[4] = { 0.5f, 0.25f, 0.125f, 1.0f };
    R(vkCmdPushConstants, pCmdPushConstants, instance);
    pCmdPushConstants(cmd, pipelineLayout, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
                      0, sizeof(push), push);
    R(vkCmdDraw, pCmdDraw, instance);
    pCmdDraw(cmd, 36, 1, 0, 0);
    R(vkCmdEndRenderPass, pCmdEndRenderPass, instance);
    pCmdEndRenderPass(cmd);
    R(vkEndCommandBuffer, pEndCommandBuffer, instance);
    CHK(pEndCommandBuffer(cmd));
    step("record: copy, barrier, renderPass, viewport, scissor, pipeline, sets, pushConstants, draw(36)");

    R(vkCreateFence, pCreateFence, instance);
    VkFenceCreateInfo fci = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
    VkFence fence = VK_NULL_HANDLE;
    CHK(pCreateFence(device, &fci, NULL, &fence));
    VkCommandBuffer one[1] = { cmd };
    VkSubmitInfo si = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = one };
    R(vkQueueSubmit, pQueueSubmit, instance);
    CHK(pQueueSubmit(queue, 1, &si, fence));
    printf("vkfix: vkQueueSubmit returned — host rebuilt the frame manifest\n");
    step("vkQueueSubmit");

    R(vkWaitForFences, pWaitForFences, instance);
    CHK(pWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX));
    R(vkAcquireNextImageKHR, pAcquireNextImageKHR, instance);
    uint32_t imgIndex = 0;
    CHK(pAcquireNextImageKHR(device, swapchain, UINT64_MAX, VK_NULL_HANDLE, VK_NULL_HANDLE, &imgIndex));
    VkSwapchainKHR oneSc[1] = { swapchain };
    VkPresentInfoKHR pi = { .sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR, .waitSemaphoreCount = 0,
                            .swapchainCount = 1, .pSwapchains = oneSc, .pImageIndices = &imgIndex };
    R(vkQueuePresentKHR, pQueuePresentKHR, instance);
    CHK(pQueuePresentKHR(queue, &pi));
    printf("vkfix: presented image %u — this is the frame handoff\n", (unsigned)imgIndex);
    step("vkWaitForFences + vkAcquireNextImageKHR + vkQueuePresentKHR");

    /* ---- 13. teardown: every destroy of the path, so the trap log shows the
     * full surface, not just setup ---------------------------------------- */
    R(vkDeviceWaitIdle, pDeviceWaitIdle, instance);
    pDeviceWaitIdle(device);
    R(vkDestroyFence, pDestroyFence, instance);              pDestroyFence(device, fence, NULL);
    R(vkFreeCommandBuffers, pFreeCommandBuffers, instance);  pFreeCommandBuffers(device, pool, 1, &cmd);
    R(vkDestroyCommandPool, pDestroyCommandPool, instance);  pDestroyCommandPool(device, pool, NULL);
    R(vkDestroyPipeline, pDestroyPipeline, instance);        pDestroyPipeline(device, pipeline, NULL);
    R(vkDestroyPipelineLayout, pDestroyPipelineLayout, instance); pDestroyPipelineLayout(device, pipelineLayout, NULL);
    R(vkDestroyPipelineCache, pDestroyPipelineCache, instance);    pDestroyPipelineCache(device, pipelineCache, NULL);
    R(vkDestroyDescriptorPool, pDestroyDescriptorPool, instance);  pDestroyDescriptorPool(device, descPool, NULL);
    R(vkDestroyDescriptorSetLayout, pDestroyDescriptorSetLayout, instance);
    pDestroyDescriptorSetLayout(device, setLayout, NULL);
    R(vkDestroyFramebuffer, pDestroyFramebuffer, instance);  pDestroyFramebuffer(device, framebuffer, NULL);
    R(vkDestroyRenderPass, pDestroyRenderPass, instance);    pDestroyRenderPass(device, renderPass, NULL);
    R(vkDestroySampler, pDestroySampler, instance);          pDestroySampler(device, sampler, NULL);
    R(vkDestroyImageView, pDestroyImageView, instance);      pDestroyImageView(device, colorView, NULL);
    R(vkDestroyImageView, pDestroyImageView, instance);      pDestroyImageView(device, texView, NULL);
    R(vkDestroyImageView, pDestroyImageView, instance);      pDestroyImageView(device, depthView, NULL);
    R(vkDestroyImage, pDestroyImage, instance);              pDestroyImage(device, texImage, NULL);
    R(vkDestroyImage, pDestroyImage, instance);              pDestroyImage(device, depthImage, NULL);
    R(vkDestroyBuffer, pDestroyBuffer, instance);            pDestroyBuffer(device, staging, NULL);
    R(vkDestroyBuffer, pDestroyBuffer, instance);            pDestroyBuffer(device, ubo, NULL);
    R(vkFreeMemory, pFreeMemory, instance);                  pFreeMemory(device, texMem, NULL);
    R(vkFreeMemory, pFreeMemory, instance);                  pFreeMemory(device, stgMem, NULL);
    R(vkFreeMemory, pFreeMemory, instance);                  pFreeMemory(device, uboMem, NULL);
    R(vkFreeMemory, pFreeMemory, instance);                  pFreeMemory(device, depthMem, NULL);
    R(vkDestroySwapchainKHR, pDestroySwapchainKHR, instance); pDestroySwapchainKHR(device, swapchain, NULL);
    R(vkDestroyDevice, pDestroyDevice, instance);            pDestroyDevice(device, NULL);
    R(vkDestroySurfaceKHR, pDestroySurfaceKHR, instance);
    PFN_vkDestroySurfaceKHR pDestroySurfaceKHR2 =
        (PFN_vkDestroySurfaceKHR)gipa(instance, "vkDestroySurfaceKHR");
    if (pDestroySurfaceKHR2) pDestroySurfaceKHR2(instance, surface, NULL);
    R(vkDestroyInstance, pDestroyInstance, instance);        pDestroyInstance(instance, NULL);
    step("teardown (every destroy of the path)");

    dlclose(lib);
    printf("vkfix: steps=%u\n", g_steps);
    printf("vkfix: RESULT 0\n");
    fflush(stdout);
    return 0;
}