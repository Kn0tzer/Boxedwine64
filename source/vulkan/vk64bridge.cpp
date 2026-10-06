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

// Host side of the 64-bit Vulkan bridge — see vk64bridge.h / vk64bridge_abi.h.
//
// This is the P2 successor of the P1 native ICD (/tmp/p1work/icd/vkwebgpu_icd.c,
// 1764 LOC, proven by driving the real Vulkan loader 1.3.275 + vkcube to a clean
// exit 0 through it). The object tables, the command recording, the eager
// copyBufferToImage execution and the submit-time frame reconstruction are ported
// essentially verbatim. THREE things change, and only three:
//
//   1. There is no Vulkan LOADER in the guest and no ICD .so. The guest shim
//      (tools/rootfs64/libvk64/libvk64.c) IS the API surface: it exports the 85
//      vk* entry points plus vkGetInstanceProcAddr/vkGetDeviceProcAddr, each of
//      which packs a VK64Args block and traps here on VK64_SYSCALL_NR. So the
//      12 LOOKUP_REQUIRED_GIPA entry points, the negotiate handshake, the
//      VK_LOADER_DATA member-0 rule and the ICD JSON manifest are all gone — the
//      loader contract is vacuous. See tasks/p1-final.md PART 2 section 2.0.
//
//   2. Memory is GUEST memory, not host malloc. KMemory64 is a soft MMU (a
//      per-4KiB-page backing store; getRamPtr() returns nullptr whenever a range
//      crosses a page boundary), so there is no flat host pointer to hand a
//      guest write into. vkAllocateMemory therefore maps through
//      KMemory64::mmapReserveAndMap and vkMapMemory returns that GUEST VA;
//      everything that needs the bytes copies them with memcpyFromGuest /
//      memcpyToGuest. (tasks/p1-final.md section 2.4.)
//
//   3. The sink is one MAIN_THREAD_EM_ASM hop per frame into the page, not a
//      file tree. P1 wrote icd/vkwgpu_stream/frameNNNN.json + sidecar .bin/.spv
//      files that a separate node+chromium process read; P2 emits the SAME
//      manifest schema (tasks/p1-final.md section 2.6 — host/p1render.mjs stays
//      a valid reference consumer) with the sidecar payloads inlined as base64,
//      because there is no filesystem between the wasm host and the page.
//
// Everything runs inline on the calling guest thread (no main-thread hop per
// call): Vulkan already separates recording from submission, so the command
// buffer IS the batching boundary, and only the per-frame handoff hops.

#include "boxedwine.h"

#ifdef BOXEDWINE_VULKAN64

#include "vk64bridge.h"
#include "vk64bridge_abi.h"
#include "cpu64.h"
#include "kmemory64.h"
#include "kprocess.h"

// Vulkan core types, for STRUCT LAYOUTS, enums and constants only.
//
// This header is GENERATED from source/vulkan/vk/vulkan_core.h by
// tools/vulkan/gen/gen_vk64_guest.py and is NOT vulkan_core.h itself, because
// this file copies structs out of x86-64 GUEST memory while compiling into the
// wasm32 Emscripten build: in-tree, a `const void* pNext` /
// `const char* const* ppEnabledExtensionNames` / `const VkCommandBuffer*
// pCommandBuffers` member is FOUR bytes here and EIGHT in the guest, so every
// field after the first pointer would be read from the wrong offset. The
// generated header declares the same structs with every pointer/handle member
// widened to uint64_t, which IS the x86-64 layout — verified by diffing
// sizeof/offsetof of 69 structs/offsets against the real header on an LP64 host,
// and guarded by the static_asserts inside the generated header itself.
#include "vk64_guest.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

#include <algorithm>
#include <vector>
#include <unordered_map>
#include <string>
#include <mutex>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <set>
#include <tuple>
#include <deque>

namespace {

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
// BW64_VKTRACE=1 logs every trapped entry point by name; =2 is unlimited.
//
// getenv() is unreliable on guest worker threads in the pthread build
// (Module.ENV is not always wired to workers), so the env var alone cannot be
// the gate for "the trap log proves calls crossed the boundary". The first
// g_freeTraceCalls calls are therefore ALWAYS logged: that budget covers a whole
// bring-up sequence (P1's loader_tally needed 12 calls to reach vkQueueSubmit;
// vkcube's whole setup is ~40), which makes the evidence independent of env
// plumbing.
// BW64_VKFRAME=1 additionally dumps the full frame manifest JSON.
int  g_traceEnv     = 0;
bool g_traceEnvInit = false;
U64  g_tracedCalls  = 0;
const U64 g_freeTraceCalls = 256;

inline bool vkTrace() {
    if (!g_traceEnvInit) {
        const char* t = getenv("BW64_VKTRACE");
        g_traceEnv = t ? (t[0] == '2' ? 2 : 1) : 0;
        g_traceEnvInit = true;
    }
    return g_traceEnv != 0 || g_tracedCalls < g_freeTraceCalls;
}
// 0 = off, 1 = on with the payload-elision cap, 2 = on, never elide.
inline int vkDumpFrames() {
    static int cached = -1;
    if (cached < 0) {
        const char* t = getenv("BW64_VKFRAME");
        cached = (!t || !t[0] || t[0] == '0') ? 0 : (t[0] == '2' ? 2 : 1);
    }
    return cached;
}
// Above this, the manifest's base64 payloads are stripped from the log.
const size_t kManifestLogCap = 64 * 1024;

// ---------------------------------------------------------------------------
// Function-id name table (trace only). MUST stay in sync with
// vk64bridge_abi.h — the guest shim carries the same enum.
// ---------------------------------------------------------------------------
#define VK64_FN_LIST(X)                                                      \
    X(VK64_fn_witness,                              "witness")                \
    X(VK64_fn_unimplemented,                        "unimplemented")          \
    X(VK64_fn_traceProc,                            "traceProc")              \
    X(VK64_fn_vkEnumerateInstanceExtensionProperties,"vkEnumerateInstanceExtensionProperties") \
    X(VK64_fn_vkEnumerateInstanceLayerProperties,   "vkEnumerateInstanceLayerProperties")       \
    X(VK64_fn_vkEnumeratePhysicalDevices,           "vkEnumeratePhysicalDevices")               \
    X(VK64_fn_vkEnumerateDeviceExtensionProperties, "vkEnumerateDeviceExtensionProperties")     \
    X(VK64_fn_vkGetPhysicalDeviceProperties,        "vkGetPhysicalDeviceProperties")            \
    X(VK64_fn_vkGetPhysicalDeviceFeatures,          "vkGetPhysicalDeviceFeatures")              \
    X(VK64_fn_vkGetPhysicalDeviceMemoryProperties,  "vkGetPhysicalDeviceMemoryProperties")        \
    X(VK64_fn_vkGetPhysicalDeviceQueueFamilyProperties,"vkGetPhysicalDeviceQueueFamilyProperties")\
    X(VK64_fn_vkGetPhysicalDeviceFormatProperties,  "vkGetPhysicalDeviceFormatProperties")      \
    X(VK64_fn_vkGetPhysicalDeviceSurfaceCapabilitiesKHR,"vkGetPhysicalDeviceSurfaceCapabilitiesKHR") \
    X(VK64_fn_vkGetPhysicalDeviceSurfaceFormatsKHR, "vkGetPhysicalDeviceSurfaceFormatsKHR")     \
    X(VK64_fn_vkGetPhysicalDeviceSurfacePresentModesKHR,"vkGetPhysicalDeviceSurfacePresentModesKHR") \
    X(VK64_fn_vkGetPhysicalDeviceSurfaceSupportKHR, "vkGetPhysicalDeviceSurfaceSupportKHR")     \
    X(VK64_fn_vkGetDeviceQueue,                     "vkGetDeviceQueue")       \
    X(VK64_fn_vkGetBufferMemoryRequirements,        "vkGetBufferMemoryRequirements") \
    X(VK64_fn_vkGetBufferMemoryRequirements2,       "vkGetBufferMemoryRequirements2") \
    X(VK64_fn_vkGetDeviceBufferMemoryRequirements,    "vkGetDeviceBufferMemoryRequirements") \
    X(VK64_fn_vkGetImageMemoryRequirements,         "vkGetImageMemoryRequirements")  \
    X(VK64_fn_vkGetImageSubresourceLayout,          "vkGetImageSubresourceLayout")   \
    X(VK64_fn_vkGetSwapchainImagesKHR,              "vkGetSwapchainImagesKHR")       \
    X(VK64_fn_vkAcquireNextImageKHR,                "vkAcquireNextImageKHR")         \
    X(VK64_fn_vkGetPastPresentationTimingGOOGLE,    "vkGetPastPresentationTimingGOOGLE") \
    X(VK64_fn_vkResetFences,                        "vkResetFences")       \
    X(VK64_fn_vkWaitForFences,                      "vkWaitForFences")     \
    X(VK64_fn_vkDeviceWaitIdle,                     "vkDeviceWaitIdle")    \
    X(VK64_fn_vkResetCommandBuffer,                 "vkResetCommandBuffer")\
    X(VK64_fn_vkFreeCommandBuffers,                 "vkFreeCommandBuffers")\
    X(VK64_fn_vkCreateInstance,                     "vkCreateInstance")    \
    X(VK64_fn_vkCreateDevice,                       "vkCreateDevice")      \
    X(VK64_fn_vkCreateXcbSurfaceKHR,                "vkCreateXcbSurfaceKHR") \
    X(VK64_fn_vkCreateSwapchainKHR,                 "vkCreateSwapchainKHR") \
    X(VK64_fn_vkCreateCommandPool,                  "vkCreateCommandPool") \
    X(VK64_fn_vkCreateBuffer,                       "vkCreateBuffer")      \
    X(VK64_fn_vkCreateImage,                        "vkCreateImage")       \
    X(VK64_fn_vkCreateImageView,                    "vkCreateImageView")   \
    X(VK64_fn_vkCreateBufferView,                       "vkCreateBufferView") \
    X(VK64_fn_vkCreateSampler,                      "vkCreateSampler")     \
    X(VK64_fn_vkCreateRenderPass,                   "vkCreateRenderPass")  \
    X(VK64_fn_vkCreateFramebuffer,                  "vkCreateFramebuffer") \
    X(VK64_fn_vkCreateGraphicsPipelines,            "vkCreateGraphicsPipelines") \
    X(VK64_fn_vkCreateComputePipelines,             "vkCreateComputePipelines") \
    X(VK64_fn_vkCreatePipelineLayout,               "vkCreatePipelineLayout") \
    X(VK64_fn_vkCreateDescriptorSetLayout,          "vkCreateDescriptorSetLayout") \
    X(VK64_fn_vkCreateDescriptorPool,               "vkCreateDescriptorPool") \
    X(VK64_fn_vkCreateShaderModule,                 "vkCreateShaderModule") \
    X(VK64_fn_vkCreatePipelineCache,                "vkCreatePipelineCache") \
    X(VK64_fn_vkCreateFence,                        "vkCreateFence")       \
    X(VK64_fn_vkCreateSemaphore,                    "vkCreateSemaphore")   \
    X(VK64_fn_vkAllocateMemory,                     "vkAllocateMemory")    \
    X(VK64_fn_vkAllocateCommandBuffers,             "vkAllocateCommandBuffers") \
    X(VK64_fn_vkAllocateDescriptorSets,             "vkAllocateDescriptorSets") \
    X(VK64_fn_vkBindBufferMemory,                   "vkBindBufferMemory")  \
    X(VK64_fn_vkBindImageMemory,                    "vkBindImageMemory")   \
    X(VK64_fn_vkUpdateDescriptorSets,               "vkUpdateDescriptorSets") \
    X(VK64_fn_vkMapMemory,                          "vkMapMemory")         \
    X(VK64_fn_vkUnmapMemory,                        "vkUnmapMemory")       \
    X(VK64_fn_vkDestroyInstance,                    "vkDestroyInstance")   \
    X(VK64_fn_vkDestroyDevice,                      "vkDestroyDevice")     \
    X(VK64_fn_vkDestroySurfaceKHR,                  "vkDestroySurfaceKHR") \
    X(VK64_fn_vkDestroySwapchainKHR,                "vkDestroySwapchainKHR") \
    X(VK64_fn_vkDestroyCommandPool,                 "vkDestroyCommandPool") \
    X(VK64_fn_vkDestroyBuffer,                      "vkDestroyBuffer")     \
    X(VK64_fn_vkDestroyImage,                       "vkDestroyImage")      \
    X(VK64_fn_vkDestroyImageView,                   "vkDestroyImageView")  \
    X(VK64_fn_vkDestroySampler,                     "vkDestroySampler")    \
    X(VK64_fn_vkDestroyRenderPass,                  "vkDestroyRenderPass") \
    X(VK64_fn_vkDestroyFramebuffer,                 "vkDestroyFramebuffer")\
    X(VK64_fn_vkDestroyPipeline,                    "vkDestroyPipeline")   \
    X(VK64_fn_vkDestroyPipelineLayout,              "vkDestroyPipelineLayout") \
    X(VK64_fn_vkDestroyDescriptorSetLayout,         "vkDestroyDescriptorSetLayout") \
    X(VK64_fn_vkDestroyDescriptorPool,              "vkDestroyDescriptorPool") \
    X(VK64_fn_vkDestroyShaderModule,                "vkDestroyShaderModule") \
    X(VK64_fn_vkDestroyPipelineCache,               "vkDestroyPipelineCache") \
    X(VK64_fn_vkDestroyFence,                       "vkDestroyFence")      \
    X(VK64_fn_vkDestroySemaphore,                   "vkDestroySemaphore")  \
    X(VK64_fn_vkFreeMemory,                         "vkFreeMemory")        \
    X(VK64_fn_vkBeginCommandBuffer,                 "vkBeginCommandBuffer")\
    X(VK64_fn_vkEndCommandBuffer,                   "vkEndCommandBuffer")  \
    X(VK64_fn_vkCmdBeginRenderPass,                 "vkCmdBeginRenderPass")\
    X(VK64_fn_vkCmdBeginRenderPass2,                "vkCmdBeginRenderPass2")\
    X(VK64_fn_vkCmdBeginRenderPass2KHR,             "vkCmdBeginRenderPass2KHR")\
    X(VK64_fn_vkCmdEndRenderPass2,                  "vkCmdEndRenderPass2")\
    X(VK64_fn_vkCmdEndRenderPass2KHR,               "vkCmdEndRenderPass2KHR")\
    X(VK64_fn_vkCmdPipelineBarrier2,               "vkCmdPipelineBarrier2")\
    X(VK64_fn_vkCmdPipelineBarrier2KHR,            "vkCmdPipelineBarrier2KHR")\
    X(VK64_fn_vkCmdPushConstants2,                 "vkCmdPushConstants2")\
    X(VK64_fn_vkCmdPushConstants2KHR,              "vkCmdPushConstants2KHR")\
    X(VK64_fn_vkCmdBindIndexBuffer2,               "vkCmdBindIndexBuffer2")\
    X(VK64_fn_vkCmdBindIndexBuffer2KHR,            "vkCmdBindIndexBuffer2KHR")\
    X(VK64_fn_vkCmdBeginRendering,                "vkCmdBeginRendering")\
    X(VK64_fn_vkCmdBeginRenderingKHR,             "vkCmdBeginRenderingKHR")\
    X(VK64_fn_vkCmdEndRendering,                  "vkCmdEndRendering")\
    X(VK64_fn_vkCmdEndRenderingKHR,               "vkCmdEndRenderingKHR")\
    X(VK64_fn_vkCmdUpdateBuffer,                  "vkCmdUpdateBuffer")\
    X(VK64_fn_vkCmdBindPipeline,                    "vkCmdBindPipeline")   \
    X(VK64_fn_vkCmdBindDescriptorSets,              "vkCmdBindDescriptorSets") \
    X(VK64_fn_vkCmdSetViewport,                     "vkCmdSetViewport")    \
    X(VK64_fn_vkCmdSetScissor,                      "vkCmdSetScissor")     \
    X(VK64_fn_vkCmdDraw,                            "vkCmdDraw")           \
    X(VK64_fn_vkCmdPipelineBarrier,                 "vkCmdPipelineBarrier")\
    X(VK64_fn_vkCmdCopyBufferToImage,               "vkCmdCopyBufferToImage") \
    X(VK64_fn_vkFlushMappedMemoryRanges,            "vkFlushMappedMemoryRanges") \
    X(VK64_fn_vkInvalidateMappedMemoryRanges,       "vkInvalidateMappedMemoryRanges") \
    X(VK64_fn_vkCmdEndRenderPass,                   "vkCmdEndRenderPass")  \
    X(VK64_fn_vkQueueSubmit,                        "vkQueueSubmit")       \
    X(VK64_fn_vkQueueSubmit2,                       "vkQueueSubmit2")      \
    X(VK64_fn_vkQueueSubmit2KHR,                    "vkQueueSubmit2KHR")   \
    X(VK64_fn_vkCreateDescriptorUpdateTemplate,     "vkCreateDescriptorUpdateTemplate") \
    X(VK64_fn_vkDestroyDescriptorUpdateTemplate,    "vkDestroyDescriptorUpdateTemplate") \
    X(VK64_fn_vkUpdateDescriptorSetWithTemplate,    "vkUpdateDescriptorSetWithTemplate") \
    X(VK64_fn_vkQueuePresentKHR,                    "vkQueuePresentKHR")   \
    X(VK64_fn_vkEnumerateInstanceVersion,           "vkEnumerateInstanceVersion") \
    X(VK64_fn_vkGetPhysicalDeviceProperties2,       "vkGetPhysicalDeviceProperties2") \
    X(VK64_fn_vkGetPhysicalDeviceFeatures2,         "vkGetPhysicalDeviceFeatures2") \
    X(VK64_fn_vkGetPhysicalDeviceMemoryProperties2, "vkGetPhysicalDeviceMemoryProperties2") \
    X(VK64_fn_vkGetPhysicalDeviceQueueFamilyProperties2,"vkGetPhysicalDeviceQueueFamilyProperties2") \
    X(VK64_fn_vkGetFenceStatus,                     "vkGetFenceStatus")    \
    X(VK64_fn_vkResetCommandPool,                   "vkResetCommandPool")  \
    X(VK64_fn_vkQueueWaitIdle,                      "vkQueueWaitIdle")     \
    X(VK64_fn_vkCreateHeadlessSurfaceEXT,           "vkCreateHeadlessSurfaceEXT") \
    X(VK64_fn_vkCreateWin32SurfaceKHR,              "vkCreateWin32SurfaceKHR") \
    X(VK64_fn_vkGetSemaphoreCounterValue,           "vkGetSemaphoreCounterValue") \
    X(VK64_fn_vkWaitSemaphores,                     "vkWaitSemaphores")    \
    X(VK64_fn_vkSignalSemaphore,                    "vkSignalSemaphore")   \
    X(VK64_fn_vkCmdPushConstants,                   "vkCmdPushConstants") \
    X(VK64_fn_vkCreateXlibSurfaceKHR,               "vkCreateXlibSurfaceKHR") \
    X(VK64_fn_vkGetPhysicalDeviceXlibPresentationSupportKHR, "vkGetPhysicalDeviceXlibPresentationSupportKHR") \
    X(VK64_fn_vkGetPhysicalDeviceImageFormatProperties2, "vkGetPhysicalDeviceImageFormatProperties2") \
    X(VK64_fn_vkGetPhysicalDeviceImageFormatProperties,  "vkGetPhysicalDeviceImageFormatProperties") \
    X(VK64_fn_vkGetPhysicalDeviceFormatProperties2,      "vkGetPhysicalDeviceFormatProperties2") \
    X(VK64_fn_vkCmdDrawIndexed,                          "vkCmdDrawIndexed") \
    X(VK64_fn_vkCmdBindVertexBuffers2,                    "vkCmdBindVertexBuffers2") \
    X(VK64_fn_vkCmdBindVertexBuffers,                     "vkCmdBindVertexBuffers") \
    X(VK64_fn_vkCmdBindIndexBuffer,                       "vkCmdBindIndexBuffer") \
    X(VK64_fn_vkBindBufferMemory2,                        "vkBindBufferMemory2") \
    X(VK64_fn_vkBindBufferMemory2KHR,                     "vkBindBufferMemory2KHR") \
    X(VK64_fn_vkBindImageMemory2,                         "vkBindImageMemory2") \
    X(VK64_fn_vkBindImageMemory2KHR,                      "vkBindImageMemory2KHR")
#define VK64_NAME_ENTRY(id, nm) { (U64)(id), nm },
const struct { U64 id; const char* name; } g_fnNames[] = { VK64_FN_LIST(VK64_NAME_ENTRY) };
#undef VK64_NAME_ENTRY
const char* fnName(U64 id) {
    for (const auto& e : g_fnNames) if (e.id == id) return e.name;
    return "?";
}

std::recursive_mutex g_vkMutex;   // one bridge per process; every trap serializes
KMemory64* g_mem = nullptr;       // guest memory of the calling thread's process

// ---------------------------------------------------------------------------
// Guest memory helpers. EVERY guest pointer arrives here as a VA and is only
// ever read/written through these.
// ---------------------------------------------------------------------------
template <class T> inline bool readStruct(U64 addr, T& out) {
    if (!addr || !g_mem) return false;
    g_mem->memcpyFromGuest(&out, addr, sizeof(T));
    return true;
}
template <class T> inline void writeStruct(U64 addr, const T& in) {
    if (addr && g_mem) g_mem->memcpyToGuest(addr, &in, sizeof(T));
}
template <class T> inline void readArray(U64 addr, U32 count, std::vector<T>& out) {
    out.clear();
    if (!addr || !g_mem || !count) return;
    out.resize(count);
    g_mem->memcpyFromGuest(out.data(), addr, sizeof(T) * (size_t)count);
}
template <class T> inline void writeArray(U64 addr, const std::vector<T>& in, U32 count) {
    if (addr && g_mem && count) g_mem->memcpyToGuest(addr, in.data(), sizeof(T) * (size_t)count);
}
inline U32  rd32(U64 a) { return (a && g_mem) ? g_mem->readd(a) : 0; }
inline void wr32(U64 a, U32 v) { if (a && g_mem) g_mem->writed(a, v); }
inline U64  rd64(U64 a) { return (a && g_mem) ? g_mem->readq(a) : 0; }
inline void wr64(U64 a, U64 v) { if (a && g_mem) g_mem->writeq(a, v); }
inline std::string guestStr(U64 addr, size_t maxLen = 512) {
    std::string s;
    if (!addr || !g_mem) return s;
    for (size_t i = 0; i < maxLen; i++) {
        U8 c = g_mem->readb(addr + i);
        if (!c) break;
        s.push_back((char)c);
    }
    return s;
}

// ---------------------------------------------------------------------------
// Opaque handle registry.
//
// Vulkan handles are opaque to the guest, and P1 (which handed out real host
// pointers) could only validate them with a magic word read through a possibly
// freed pointer. Here every handle is an integer id into a live-object table,
// so a stale or bogus handle from the guest is a lookup miss — logged, benign
// return, no fault. (tasks/p1-final.md section 2.0 property 2.)
// ---------------------------------------------------------------------------
enum ObjKind : U32 {
    K_INSTANCE = 1, K_PHYSDEV, K_DEVICE, K_QUEUE, K_CMDPOOL, K_CMDBUF, K_MEMORY,
    K_BUFFER, K_IMAGE, K_IMAGEVIEW, K_BUFFERVIEW, K_SAMPLER, K_SHADER, K_SETLAYOUT, K_SET,
    K_PIPELAYOUT, K_PIPELINE, K_RENDERPASS, K_FRAMEBUFFER, K_PIPECACHE,
    K_DESCPOOL, K_FENCE, K_SEMAPHORE, K_SWAPCHAIN, K_SURFACE, K_TEMPLATE
};
struct Obj {
    virtual ~Obj() = default;
    U32 kind = 0;
    U64 magic = 0;
};
const U64 OBJ_MAGIC = 0x564B4F42ull;   // 'VKOB'

std::unordered_map<U64, Obj*> g_objs;
U64 g_nextId = 0x564B0100;

template <class T> T* createObj(U32 kind, U64& idOut) {
    T* o = new T();
    o->kind = kind;
    o->magic = OBJ_MAGIC;
    idOut = g_nextId++;
    g_objs[idOut] = o;
    return o;
}
Obj* findObj(U64 id, U32 kind) {
    if (!id) return nullptr;
    auto it = g_objs.find(id);
    if (it == g_objs.end()) return nullptr;
    Obj* o = it->second;
    if (!o || o->magic != OBJ_MAGIC || o->kind != kind) return nullptr;
    return o;
}
template <class T> T* objOf(U64 id, U32 kind, const char* who) {
    Obj* o = findObj(id, kind);
    if (!o) klog_fmt("vk64: %s: bad/stale handle 0x%llx", who, (unsigned long long)id);
    return (T*)o;
}
void dropObj(U64 id) {
    auto it = g_objs.find(id);
    if (it == g_objs.end()) return;
    delete it->second;
    g_objs.erase(it);
}

// ---------------------------------------------------------------------------
// Object bodies (ported from P1's DECL_NONDISP set; the create-info fields P1
// recorded are the same fields P2 records — that is what lets submit rebuild a
// complete frame manifest without the app re-stating anything).
// ---------------------------------------------------------------------------
const U32 VK64_MAX_SETS = 8, VK64_MAX_BINDINGS = 8, VK64_MAX_ATTACH = 4, VK64_MAX_DRAWS = 64;
const U32 VK64_MAX_CMDS = 4096;
const U32 VK64_MAX_VERT_BINDINGS = 4, VK64_MAX_VERT_ATTRIBS = 16;
const U32 VK64_MAX_PUSH_BYTES = 256;   // matches limits.maxPushConstantsSize

// dstArrayElement + count, so a descriptor ARRAY write is not silently collapsed
// to its first element (audit §f: DXVK writes texture arrays for descriptor
// indexing). The elements themselves stay in the flat Binding array — the
// per-element payload schema is P3 work — but the INDEX and COUNT are recorded
// now so the schema has something honest to read.
struct Binding { U32 binding = 0, type = 0, dstArrayElement = 0, count = 1; U64 obj = 0, range = 0;
                 U64 bufOff = 0; }; // VkDescriptorBufferInfo::offset: DXVK sub-allocates
                 // uniforms (D3D9ConstantBuffer::Alloc) and binds each range with its own
                 // offset; dropping it made every uniform capture read from offset 0.

struct Instance : Obj { U64 phys[4] = {0,0,0,0}; U32 physCount = 0; };
struct PhysDev  : Obj { U64 instance = 0; };
struct Device   : Obj { U64 physDev = 0, queue = 0; };
struct Queue    : Obj { U64 device = 0; };
struct CmdPool  : Obj { U64 device = 0; U32 queueFamily = 0; };
struct PipelineCache : Obj {};
struct DescPool  : Obj {};
struct Surface   : Obj {};
struct Fence     : Obj { int signalled = 0; };
// Timeline semaphores (audit P2-NOW item 3). DXVK puts a u64 wait/signal fence
// on EVERY command-list flush, so the counter is not optional bookkeeping: it is
// the only thing that makes vkQueueSubmit's VkTimelineSemaphoreSubmitInfo
// meaningful. Under immediate execution the counter is HONEST — everything a
// submit waits for has already run, and everything it signals is already done —
// so signal is a monotone max and a wait either succeeds (value reached) or,
// with timeout 0 against a value the queue has not reached, returns VK_TIMEOUT.
struct Semaphore : Obj {
    int signalled = 0;          /* binary semaphores keep the old flag */
    int isTimeline = 0;
    U64  counter = 0;
};
struct DeviceMemory : Obj { U64 size = 0, va = 0; U32 memIndex = 0; };
struct Buffer : Obj { U64 size = 0, mem = 0, memOff = 0; U32 usage = 0; };
struct Image  : Obj {
    U32 w = 0, h = 0, d = 0, layers = 0, mips = 0, format = 0, tiling = 0, usage = 0, samples = 0;
    U64 mem = 0, memOff = 0, pixBytes = 0;
    int copied = 0;                 // a staging copyBufferToImage landed here
};
struct ImageView : Obj { U64 image = 0; U32 format = 0, aspect = 0; };
struct BufferView : Obj { U64 buffer = 0; U32 format = 0; U64 offset = 0, range = 0; };
struct Sampler : Obj { U32 mag = 0, min = 0, mipmap = 0, addrU = 0, addrV = 0, addrW = 0; float maxAniso = 1.0f; };
struct ShaderModule : Obj {
    U32 stageHint = 0;
    U64 hash = 0;
    std::vector<U8> code;           // retained: vkcube destroys the module right
                                   // after pipeline creation (legal), so destroy
                                   // is a refcount drop (P1 section 1.2).
    int destroyed = 0;
};
struct DescSetLayout : Obj { U32 nbind = 0; Binding binds[VK64_MAX_BINDINGS]; };
struct DescSet : Obj { U64 layout = 0; U32 nbind = 0; Binding binds[VK64_MAX_BINDINGS]; };
struct TmplEntry { U32 binding = 0, arrayElement = 0, count = 0, type = 0; U64 offset = 0, stride = 0; };
struct DescTemplate : Obj { U32 nentry = 0; TmplEntry entries[VK64_MAX_BINDINGS]; };
struct PipelineLayout : Obj { U32 nsets = 0; U64 sets[VK64_MAX_SETS]; };
// The vertex input layout, recorded at pipeline creation (audit P2-NOW item 5).
// This is the one dropped-at-creation field that is not merely informative: with
// no binding/attribute descriptions there is no way to build a vertex buffer
// layout, so NOTHING rasterizes. DXVK needs it exactly as much as vkcube did.
// VkSpecializationInfo capture (2026-10-06): the guest may specialize
// shader constants via VkPipelineShaderStageCreateInfo.pSpecializationInfo.
// The bridge captures (constantID -> value bytes) per stage so the page tier
// can apply them instead of the SPIR-V defaults (spirvfix R2 folds to defaults).
struct SpecEntry { U32 constantID = 0; U32 size = 0; U8 value[8] = {0}; };
struct StageSpec { U32 n = 0; SpecEntry entries[16]; };
// Guest-side VkSpecializationInfo (pointers are U64 guest VAs).
struct Vk64SpecMapEntry { U32 constantID; U32 offset; U64 size; };
struct Vk64SpecInfo { U32 mapEntryCount; U32 _pad; U64 pMapEntries; U64 dataSize; U64 pData; };
static void captureStageSpec(U64 specVa, StageSpec& out) {
    if (!specVa) return;
    Vk64SpecInfo si = {};
    if (!readStruct(specVa, si)) return;
    if (!si.mapEntryCount || si.mapEntryCount > 16) return;
    if (!si.pMapEntries || !si.pData || !si.dataSize || si.dataSize > 256) return;
    std::vector<Vk64SpecMapEntry> mes;
    readArray(si.pMapEntries, si.mapEntryCount, mes);
    std::vector<U8> data((size_t)si.dataSize);
    g_mem->memcpyFromGuest(data.data(), si.pData, (size_t)si.dataSize);
    for (auto& me : mes) {
        if (out.n >= 16) break;
        if (me.offset + me.size > si.dataSize || me.size > 8 || me.size == 0) continue;
        // size must be 1, 2, 4, or 8 for scalar spec constants
        if (me.size != 1 && me.size != 2 && me.size != 4 && me.size != 8) continue;
        SpecEntry& e = out.entries[out.n++];
        e.constantID = me.constantID;
        e.size = (U32)me.size;
        memcpy(e.value, data.data() + me.offset, (size_t)me.size);
    }
}
struct Pipeline : Obj {
    U32 topology = 0, cull = 0, front = 0, depthTest = 0, depthWrite = 0, depthOp = 0, blend = 0;
    StageSpec vsSpec, fsSpec;
    U32 nvb = 0, nva = 0;
    bool dynamicVertexStride = false;
    struct VertexStrideVariant { std::vector<U32> strides; U64 id; };
    // The page caches pipelines by ID across frames. Dynamic layouts require
    // distinct IDs; keep the exact keys with the originating pipeline lifetime.
    std::vector<VertexStrideVariant> vertexStrideVariants;
    U32 vbStride[VK64_MAX_VERT_BINDINGS] = {0};
    U32 vbInputRate[VK64_MAX_VERT_BINDINGS] = {0};    /* 0 = per vertex, 1 = per instance */
    U32 vaBinding[VK64_MAX_VERT_ATTRIBS] = {0};       /* VkVertexInputAttributeDescription */
    U32 vaFormat[VK64_MAX_VERT_ATTRIBS] = {0};
    U32 vaOffset[VK64_MAX_VERT_ATTRIBS] = {0};
    U32 vaLocation[VK64_MAX_VERT_ATTRIBS] = {0};
    U64 vs = 0, fs = 0, cs = 0, layout = 0, rp = 0;
};
struct RenderPass : Obj {
    U32 natt = 0, formats[VK64_MAX_ATTACH] = {0}, loadOps[VK64_MAX_ATTACH] = {0},
        storeOps[VK64_MAX_ATTACH] = {0}, depthFmt = 0;
    U32 samples[VK64_MAX_ATTACH] = {0};   // v2: per-attachment MSAA sample count
};
struct Framebuffer : Obj { U64 rp = 0; U32 natt = 0; U64 views[VK64_MAX_ATTACH] = {0}; U32 w = 0, h = 0; };
struct Swapchain : Obj { U32 w = 0, h = 0, format = 0, nimg = 0, cur = 0; U64 imgs[8] = {0}; };

// --- command recording (P1's P1_Cmd / P1_CbState, with the copy record moved
// --- out of P1's process-global array into the command that recorded it, so a
// --- submit only executes the copies belonging to the command buffers it was
// --- given).
enum CmdKind : U32 {
    CMD_BEGIN_RP, CMD_END_RP, CMD_BIND_PIPE, CMD_BIND_SETS, CMD_VIEWPORT,
    CMD_SCISSOR, CMD_DRAW, CMD_DRAW_INDEXED, CMD_BARRIER, CMD_COPY_B2I, CMD_PUSH_CONST,
    CMD_BIND_VB, CMD_BIND_IB, CMD_UPDATE_BUF
};
struct Copy {
    U64 srcBuffer = 0, dstImage = 0, bufOff = 0;
    U32 rowLen = 0, imgH = 0; int32_t ox = 0, oy = 0; U32 w = 0, h = 0;
};
struct Cmd {
    U32 kind = 0;
    U64 a = 0, b = 0, c = 0, d = 0;
    float f[8] = {0};
    double clearDepth = 1.0;
    U32 vbCount = 0;
    U64 vbBuffers[VK64_MAX_VERT_BINDINGS] = {0}, vbOffsets[VK64_MAX_VERT_BINDINGS] = {0};
    U32 vbStrides[VK64_MAX_VERT_BINDINGS] = {0};
    bool vbHasStride[VK64_MAX_VERT_BINDINGS] = {false};
    Copy  copy;
    // Push constants: the recorded bytes, byte-offset preserved. DXVK pushes
    // constants per-draw for essentially everything, so this is a hot path, not a
    // corner case.
    U32 pcOffset = 0, pcSize = 0, pcStageFlags = 0;
    U8  pcBytes[VK64_MAX_PUSH_BYTES] = {0};
    // vkCmdUpdateBuffer: transfer-write into a buffer. Payload copied out
    // of guest memory at record time; executed into guest memory at submit
    // (transfer semantics), before the frame is serialized, so
    // readGuestRange sees the updated bytes. DXVK uploads D3D9
    // fixed-function VS constants with this.
    U64 updBuf = 0, updOff = 0;
    std::vector<U8> updBytes;
    // Indexed draw + G2 replay capture: vertexOffset for the draw, and the
    // resolved NDC positions / linear RGBA colors (capCount vertices) baked
    // for the procedural replay shader when the layout is understood.
    int32_t diVertexOffset = 0;
    U32 capCount = 0;
    std::vector<float> capPos, capCol;
};
struct CmdBuf : Obj {
    U64 pool = 0;
    std::vector<Cmd> cmds;
    U64  pipe = 0;
    U64  sets[VK64_MAX_SETS] = {0};
    float vp[6] = {0}, sci[4] = {0};
    bool haveVp = false, haveSci = false;
    // v2: vertex/index buffer tables (DXVK draws indexed almost exclusively).
    U64  vbs[VK64_MAX_VERT_BINDINGS] = {0};
    U64  vbOff[VK64_MAX_VERT_BINDINGS] = {0};
    U32 vbStride[VK64_MAX_VERT_BINDINGS] = {0};
    bool vbHasStride[VK64_MAX_VERT_BINDINGS] = {false};
    std::vector<U64> dynamicObjects; // Synthetic attachments live with the recording.
    ~CmdBuf() override { for (U64 id : dynamicObjects) dropObj(id); }
    U32  nvb = 0;
    U64  ib = 0, ibOff = 0;
    U32  ibType = 0;   // 0 = uint16, 1 = uint32
};
CmdBuf* cbOf(U64 id, const char* who) { return objOf<CmdBuf>(id, K_CMDBUF, who); }
void resetCmdBuf(CmdBuf* cb) {
    for (U64 id : cb->dynamicObjects) dropObj(id);
    cb->dynamicObjects.clear();
    cb->cmds.clear();
    cb->pipe = 0;
    cb->haveVp = cb->haveSci = false;
    memset(cb->sets, 0, sizeof(cb->sets));
    memset(cb->vp, 0, sizeof(cb->vp));
    memset(cb->sci, 0, sizeof(cb->sci));
    memset(cb->vbs, 0, sizeof(cb->vbs));
    memset(cb->vbOff, 0, sizeof(cb->vbOff));
    memset(cb->vbStride, 0, sizeof(cb->vbStride));
    memset(cb->vbHasStride, 0, sizeof(cb->vbHasStride));
    cb->nvb = 0;
    cb->ib = 0; cb->ibOff = 0; cb->ibType = 0;
}

// The frame serializer is defined above the switch; forward declaration so
// pushCmd can flag overflow.
bool g_frameOverflow = false;
void pushCmd(CmdBuf* st, const Cmd& c) {
    if (!st) return;
    if (st->cmds.size() >= VK64_MAX_CMDS) { g_frameOverflow = true; return; }
    st->cmds.push_back(c);
}

// ---------------------------------------------------------------------------
// Format helpers (P1's fmt_bpp / fmt_name, unchanged)
// ---------------------------------------------------------------------------
U32 fmt_bpp(U32 f) {
    switch (f) {
        case VK_FORMAT_R8_UNORM: case VK_FORMAT_R8_SNORM: case VK_FORMAT_R8_UINT:
        case VK_FORMAT_R8_SINT: case VK_FORMAT_S8_UINT: return 1;
        case VK_FORMAT_R8G8_UNORM: case VK_FORMAT_R16_UNORM: case VK_FORMAT_R16_SFLOAT:
        case VK_FORMAT_R5G6B5_UNORM_PACK16: case VK_FORMAT_B5G5R5A1_UNORM_PACK16:
        case VK_FORMAT_R4G4B4A4_UNORM_PACK16: case VK_FORMAT_D16_UNORM: return 2;
        case VK_FORMAT_R8G8B8A8_UNORM: case VK_FORMAT_R8G8B8A8_SRGB:
        case VK_FORMAT_B8G8R8A8_UNORM: case VK_FORMAT_B8G8R8A8_SRGB:
        case VK_FORMAT_R32_SFLOAT: case VK_FORMAT_R32_UINT: case VK_FORMAT_R32_SINT:
        case VK_FORMAT_D24_UNORM_S8_UINT: case VK_FORMAT_D32_SFLOAT:
        case VK_FORMAT_B10G11R11_UFLOAT_PACK32: return 4;
        case VK_FORMAT_R16G16_SFLOAT: case VK_FORMAT_R16G16B16A16_SFLOAT: return 8;
        case VK_FORMAT_R32G32_SFLOAT: return 8;
        case VK_FORMAT_R32G32B32A32_SFLOAT: return 16;
        default: return 4;
    }
}
const char* fmt_name(U32 f) {
    switch (f) {
        case VK_FORMAT_B8G8R8A8_UNORM: return "B8G8R8A8_UNORM";
        case VK_FORMAT_R8G8B8A8_UNORM: return "R8G8B8A8_UNORM";
        case VK_FORMAT_R8G8B8A8_SRGB: return "R8G8B8A8_SRGB";
        case VK_FORMAT_D16_UNORM: return "D16_UNORM";
        case VK_FORMAT_D24_UNORM_S8_UINT: return "D24S8";
        default: return "UNKNOWN";
    }
}
U64 blob_hash(const U8* p, size_t n) {
    U64 h = 5381;
    for (size_t i = 0; i < n; i++) h = h * 33 + p[i];
    return h;
}

// ---------------------------------------------------------------------------
// Frame manifest. P1's schema (tasks/p1-final.md section 1.3) with the sidecar
// payloads inlined base64: there is no filesystem between wasm and the page.
// ---------------------------------------------------------------------------
U32 g_frameNo = 0;
std::string g_pendingFrame;          // built by submit, hopped by present
U32 g_lastPresented = 0;

std::string b64(const U8* data, size_t n) {
    static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((n + 2) / 3) * 4);
    size_t i = 0;
    for (; i + 2 < n; i += 3) {
        U32 v = ((U32)data[i] << 16) | ((U32)data[i+1] << 8) | data[i+2];
        out += T[(v >> 18) & 63]; out += T[(v >> 12) & 63];
        out += T[(v >> 6) & 63];  out += T[v & 63];
    }
    if (i < n) {
        U32 v = (U32)data[i] << 16;
        bool two = (i + 1 < n);
        if (two) v |= (U32)data[i+1] << 8;
        out += T[(v >> 18) & 63]; out += T[(v >> 12) & 63];
        out += two ? T[(v >> 6) & 63] : '=';
        out += '=';
    }
    return out;
}
void jsonBlob(std::string& out, const char* key, const std::vector<U8>& bytes) {
    char num[32];
    snprintf(num, sizeof num, "%llu", (unsigned long long)bytes.size());
    out += '"'; out += key; out += "\":{\"size\":";
    out += num; out += ",\"b64\":\"";
    out += b64(bytes.data(), bytes.size());
    out += "\"}";
}
// P1 wrote a sidecar unconditionally (empty file when the source was missing);
// here an absent source is a null so the consumer can tell "no UBO" from
// "zero-length UBO".
void jsonBlobOrNull(std::string& out, const char* key, const std::vector<U8>& bytes, bool present) {
    if (!present) { out += '"'; out += key; out += "\":null"; return; }
    jsonBlob(out, key, bytes);
}
std::string jsonFloats(const float* v, int n) {
    char buf[64];
    std::string s = "[";
    for (int i = 0; i < n; i++) {
        if (i) s += ",";
        snprintf(buf, sizeof buf, "%g", (double)v[i]);
        s += buf;
    }
    return s + "]";
}

void hopFrameToPage(const std::string& json) {
#ifdef __EMSCRIPTEN__
    // One hop per frame. The page side (web/runtime.html window.bwVkFrame) is
    // not wired yet in this lane, so the JS body is defensive: a missing sink
    // must not fault the guest.
    MAIN_THREAD_EM_ASM({
        if (globalThis.window && window.bwVkFrame) {
            try { window.bwVkFrame(UTF8ToString($0)); } catch (e) { console.warn('vk64: bwVkFrame failed', e); }
        }
    }, json.c_str());
#else
    (void)json;
#endif
}

void emitFrameNow() {
    if (g_pendingFrame.empty()) return;
    std::string json = g_pendingFrame;
    g_pendingFrame.clear();
    g_lastPresented = g_frameNo ? g_frameNo - 1 : 0;
    hopFrameToPage(json);
    // Log the manifest. It is the frame payload a WebGPU consumer needs, so it is
    // worth having in the host log as evidence — and a SMALL frame is cheap
    // enough that it is always logged, with no env var and no frontend wiring.
    // Above the cap the base64 payloads are stripped (the scalars stay) because a
    // vkcube-sized texture would otherwise be ~360KB per frame; BW64_VKFRAME=1
    // logs big frames elided and =2 logs them whole.
    int want = vkDumpFrames();
    if ((int)json.size() <= (int)kManifestLogCap) want = 2;
    if (want) {
        if (want == 2 || json.size() <= kManifestLogCap) {
            klog_fmt("vk64: FRAME-JSON %s", json.c_str());
        } else {
            // Same schema, payload elided: enough to prove the frame crossed and
            // to read every scalar, without the megabytes.
            std::string elided = json;
            const char* keys[] = { "\"pixels\":{", "\"spv\":{" };
            for (const char* k : keys) {
                size_t at = 0;
                while ((at = elided.find(k, at)) != std::string::npos) {
                    size_t b64 = elided.find("\"b64\":\"", at);
                    if (b64 == std::string::npos) break;
                    size_t end = elided.find('"', b64 + 7);
                    if (end == std::string::npos) break;
                    elided.replace(b64 + 7, end - (b64 + 7), "<elided>");
                    at = end;
                }
            }
            klog_fmt("vk64: FRAME-JSON (payload elided, %zu bytes -> %zu; set BW64_VKFRAME=2 for the full frame) %s",
                     json.size(), elided.size(), elided.c_str());
        }
    }
    g_frameNo++;
}

// ---------------------------------------------------------------------------
// Eager copyBufferToImage execution (P1's exec_copies, per-command-buffer now).
// Source and destination are BOTH guest ranges, so this is one
// memcpyFromGuest/memcpyToGuest per row.
// ---------------------------------------------------------------------------
// vkCmdUpdateBuffer execution: the transfer write lands in guest memory at
// submit time, exactly like a real implementation would make it visible.
// Bounds are clamped defensively; a short write still updates its prefix.
void execUpdateBuf(const Cmd& k) {
    Buffer* b = objOf<Buffer>(k.updBuf, K_BUFFER, "vkCmdUpdateBuffer");
    if (!b || !b->mem || k.updBytes.empty()) return;
    DeviceMemory* m = objOf<DeviceMemory>(b->mem, K_MEMORY, "vkCmdUpdateBuffer");
    if (!m || !m->va) return;
    U64 off = b->memOff + k.updOff;
    U64 n = (U64)k.updBytes.size();
    if (off >= m->size) return;
    if (off + n > m->size) n = m->size - off;
    g_mem->memcpyToGuest(m->va + off, k.updBytes.data(), n);
}
void execCopy(const Copy& r) {
    Buffer* src = objOf<Buffer>(r.srcBuffer, K_BUFFER, "copyBufferToImage");
    Image*  dst = objOf<Image>(r.dstImage, K_IMAGE, "copyBufferToImage");
    if (!src || !dst) return;
    DeviceMemory* smem = objOf<DeviceMemory>(src->mem, K_MEMORY, "copyBufferToImage");
    DeviceMemory* dmem = objOf<DeviceMemory>(dst->mem, K_MEMORY, "copyBufferToImage");
    if (!smem || !dmem || !smem->va || !dmem->va) return;
    dst->copied = 1;
    U32 bpp = fmt_bpp(dst->format);
    if (!bpp || !r.w || !r.h) return;
    size_t rowBytes = (size_t)r.w * bpp;
    size_t srcRow  = r.rowLen ? (size_t)r.rowLen * bpp : rowBytes;
    if (srcRow < rowBytes) srcRow = rowBytes;
    U64 srcBase = smem->va + src->memOff + r.bufOff;
    U64 dstBase = dmem->va + dst->memOff + ((size_t)r.oy * dst->w + r.ox) * bpp;
    if (srcBase + (U64)srcRow * r.h > smem->va + smem->size) return;
    if (dstBase + (U64)rowBytes * r.h > dmem->va + dmem->size) return;
    std::vector<U8> tmp(rowBytes);
    for (U32 y = 0; y < r.h; y++) {
        g_mem->memcpyFromGuest(tmp.data(), srcBase + (U64)y * srcRow, rowBytes);
        g_mem->memcpyToGuest(dstBase + (U64)y * (U64)dst->w * bpp, tmp.data(), rowBytes);
    }
}

std::vector<U8> readGuestRange(U64 memId, U64 memOff, U64 bytes) {
    std::vector<U8> out;
    DeviceMemory* m = objOf<DeviceMemory>(memId, K_MEMORY, "readGuestRange");
    if (!m || !m->va || !bytes) return out;
    if (memOff >= m->size) return out;
    if (memOff + bytes > m->size) bytes = m->size - memOff;
    out.resize((size_t)bytes);
    g_mem->memcpyFromGuest(out.data(), m->va + memOff, bytes);
    return out;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// G2 replay capture + procedural shader synthesis (schema-v2 stopgap).
//
// The page tier (web/vkwebgpu.mjs) replays each draw as
// pass.draw(vertexCount, 1, firstVertex, 0) with NO vertex buffers bound, so a
// guest vertex shader with @location inputs can never produce pixels there:
// pipeline creation itself rejects the missing buffers. Until the manifest
// schema carries vertex/index BYTES (schema v2, a separate tracked goal), the
// bridge resolves the draw vertices itself and bakes them into a procedural
// SPIR-V vertex shader: gl_VertexIndex selects among constant position/color
// pairs captured from the REAL vertex/index buffers of DXVK at draw time. The
// geometry and colors that rasterize are the guest own; only the fetch
// mechanism is replayed. A draw the synthesizer does not understand keeps the
// guest modules (current behaviour; the page tier then skips the frame).
// ---------------------------------------------------------------------------
const U32 kCapMaxVerts = 256;   // baked-vertex cap per draw; tri9 needs 3

bool captureIndexedDraw(CmdBuf* cb, Cmd& c) {
    U32 indexCount = (U32)c.a, firstIndex = (U32)c.c;
    if (!indexCount || indexCount > kCapMaxVerts) return false;
    Pipeline* pipe = objOf<Pipeline>(cb->pipe, K_PIPELINE, "capDraw");
    if (!pipe || !pipe->nva) return false;
    // Position = location-0 float4, color = location-1 unorm8x4 (tri9 FVF).
    int posAi = -1, colAi = -1;
    for (U32 i = 0; i < pipe->nva; i++) {
        U32 f = pipe->vaFormat[i];
        if (pipe->vaLocation[i] == 0 && f == VK_FORMAT_R32G32B32A32_SFLOAT) posAi = (int)i;
        if (pipe->vaLocation[i] == 1 &&
            (f == VK_FORMAT_B8G8R8A8_UNORM || f == VK_FORMAT_R8G8B8A8_UNORM ||
             f == VK_FORMAT_B8G8R8A8_SRGB || f == VK_FORMAT_R8G8B8A8_SRGB)) colAi = (int)i;
    }
    if (posAi < 0 || colAi < 0) return false;
    U32 posBind = pipe->vaBinding[posAi], colBind = pipe->vaBinding[colAi];
    if (posBind >= VK64_MAX_VERT_BINDINGS || colBind >= VK64_MAX_VERT_BINDINGS) return false;
    Buffer* pbuf = objOf<Buffer>(cb->vbs[posBind], K_BUFFER, "capDraw");
    Buffer* cbuf = objOf<Buffer>(cb->vbs[colBind], K_BUFFER, "capDraw");
    Buffer* ibuf = objOf<Buffer>(cb->ib, K_BUFFER, "capDraw");
    if (!pbuf || !cbuf || !ibuf || !pbuf->mem || !cbuf->mem || !ibuf->mem) return false;
    U32 idxSize = (cb->ibType == 1) ? 4 : 2;
    std::vector<U8> idxBytes = readGuestRange(ibuf->mem, ibuf->memOff + cb->ibOff + (U64)firstIndex * idxSize,
                                              (U64)indexCount * idxSize);
    if (idxBytes.size() < (size_t)indexCount * idxSize) return false;
    // Resolve vertex ids (firstIndex + vertexOffset) so the baked arrays are in
    // draw order and the replay vertex_index maps 1:1.
    U32 maxV = 0;
    std::vector<U32> vids(indexCount);
    for (U32 i = 0; i < indexCount; i++) {
        U32 ix = (idxSize == 4)
            ? (U32)(idxBytes[i*4] | ((U32)idxBytes[i*4+1] << 8) |
                    ((U32)idxBytes[i*4+2] << 16) | ((U32)idxBytes[i*4+3] << 24))
            : (U32)(idxBytes[i*2] | ((U32)idxBytes[i*2+1] << 8));
        int64_t v = (int64_t)ix + c.diVertexOffset;
        if (v < 0 || v > 1000000) return false;
        vids[i] = (U32)v;
        if ((U32)v > maxV) maxV = (U32)v;
    }
    U32 pstride = pipe->vbStride[posBind], cstride = pipe->vbStride[colBind];
    if (!pstride || !cstride) return false;
    U64 pNeed = (U64)maxV * pstride + pipe->vaOffset[posAi] + 16;
    U64 cNeed = (U64)maxV * cstride + pipe->vaOffset[colAi] + 4;
    std::vector<U8> pbytes = readGuestRange(pbuf->mem, pbuf->memOff + cb->vbOff[posBind], pNeed);
    std::vector<U8> cbytes = readGuestRange(cbuf->mem, cbuf->memOff + cb->vbOff[colBind], cNeed);
    if (pbytes.size() < pNeed || cbytes.size() < cNeed) return false;
    // RHW pixel -> NDC bake needs the viewport DXVK set for this draw.
    if (!cb->haveVp || cb->vp[2] <= 0 || cb->vp[3] <= 0) return false;
    float vpw = cb->vp[2], vph = cb->vp[3];
    bool bgr = (pipe->vaFormat[colAi] == VK_FORMAT_B8G8R8A8_UNORM ||
                pipe->vaFormat[colAi] == VK_FORMAT_B8G8R8A8_SRGB);
    c.capPos.reserve((size_t)indexCount * 4);
    c.capCol.reserve((size_t)indexCount * 4);
    for (U32 i = 0; i < indexCount; i++) {
        U32 v = vids[i];
        float pf[4];
        memcpy(pf, &pbytes[(size_t)v * pstride + pipe->vaOffset[posAi]], 16);
        U32 ci;
        memcpy(&ci, &cbytes[(size_t)v * cstride + pipe->vaOffset[colAi]], 4);
        float rhw = pf[3] != 0.0f ? pf[3] : 1.0f;
        // Vulkan and WebGPU share the top-left framebuffer origin: NDC y
        // follows the pixel row, no flip (the page tier documented rule).
        c.capPos.push_back(pf[0] / rhw / vpw * 2.0f - 1.0f);
        c.capPos.push_back(pf[1] / rhw / vph * 2.0f - 1.0f);
        c.capPos.push_back(pf[2] / rhw);
        c.capPos.push_back(1.0f);
        // D3DCOLOR is 0xAARRGGBB; the B8G8R8A8 byte order already matches it.
        float comp[4] = { (ci & 0xff) / 255.0f, ((ci >> 8) & 0xff) / 255.0f,
                          ((ci >> 16) & 0xff) / 255.0f, ((ci >> 24) & 0xff) / 255.0f };
        c.capCol.push_back(bgr ? comp[2] : comp[0]);
        c.capCol.push_back(comp[1]);
        c.capCol.push_back(bgr ? comp[0] : comp[2]);
        c.capCol.push_back(comp[3]);
    }
    c.capCount = indexCount;
    klog_fmt("vk64: replay capture: %u verts baked (NDC, %s)", indexCount, bgr ? "B8G8R8A8" : "R8G8B8A8");
    return true;
}

// Minimal SPIR-V 1.0 word emitter for the replay shaders.
struct SpvEmit {
    std::vector<U32> w;
    U32 next = 1;
    U32 fresh() { return next++; }
    void inst(U32 opcode, std::initializer_list<U32> args) {
        w.push_back((((U32)args.size() + 1) << 16) | opcode);
        for (U32 a : args) w.push_back(a);
    }
    void entryPoint(U32 model, U32 id, const char* name, std::initializer_list<U32> iface) {
        size_t at = w.size();
        w.push_back(0);
        w.push_back(model); w.push_back(id);
        size_t n = strlen(name) + 1, words = (n + 3) / 4, base = w.size();
        w.resize(base + words, 0);
        memcpy(&w[base], name, n);
        for (U32 i : iface) w.push_back(i);
        w[at] = ((U32)(w.size() - at) << 16) | 15;   // OpEntryPoint
    }
    std::vector<U8> bytes() {
        w[3] = next;   // id bound
        std::vector<U8> out(w.size() * 4);
        memcpy(out.data(), w.data(), out.size());
        return out;
    }
};

// Vertex: gl_VertexIndex -> OpSwitch -> constant NDC position + linear color.
std::vector<U8> synthReplayVs(const std::vector<float>& pos, const std::vector<float>& col, U32 n) {
    SpvEmit s;
    s.w.reserve(700);
    s.w.insert(s.w.end(), {0x07230203, 0x00010000, 0, 0, 0});
    U32 tVoid = s.fresh(), tInt = s.fresh(), tFloat = s.fresh(), tV4 = s.fresh();
    U32 tFn = s.fresh(), pInInt = s.fresh(), pOutV4 = s.fresh();
    U32 vIdx = s.fresh(), vPos = s.fresh(), vCol = s.fresh(), fn = s.fresh();
    s.inst(17, {1});                        // OpCapability Shader
    s.inst(14, {0, 1});                     // OpMemoryModel Logical GLSL450
    s.entryPoint(0, fn, "main", {vIdx, vPos, vCol});
    s.inst(71, {vIdx, 11, 42});             // OpDecorate BuiltIn VertexIndex
    s.inst(71, {vPos, 11, 0});              // OpDecorate BuiltIn Position
    s.inst(71, {vCol, 30, 0});              // OpDecorate Location 0
    s.inst(19, {tVoid});                    // OpTypeVoid
    s.inst(21, {tInt, 32, 1});              // OpTypeInt 32 1
    s.inst(22, {tFloat, 32});               // OpTypeFloat 32
    s.inst(23, {tV4, tFloat, 4});           // OpTypeVector %float 4
    s.inst(33, {tFn, tVoid});               // OpTypeFunction %void
    s.inst(32, {pInInt, 1, tInt});          // OpTypePointer Input %int
    s.inst(32, {pOutV4, 3, tV4});           // OpTypePointer Output %v4f
    std::vector<U32> posId(n), colId(n);
    for (U32 i = 0; i < n; i++) {
        U32 pc[4], cc[4];
        for (int k = 0; k < 4; k++) {
            U32 b;
            pc[k] = s.fresh(); memcpy(&b, &pos[i*4+k], 4); s.inst(43, {tFloat, pc[k], b});
            cc[k] = s.fresh(); memcpy(&b, &col[i*4+k], 4); s.inst(43, {tFloat, cc[k], b});
        }
        posId[i] = s.fresh(); s.inst(44, {tV4, posId[i], pc[0], pc[1], pc[2], pc[3]});
        colId[i] = s.fresh(); s.inst(44, {tV4, colId[i], cc[0], cc[1], cc[2], cc[3]});
    }
    s.inst(59, {pInInt, vIdx, 1});          // OpVariable Input
    s.inst(59, {pOutV4, vPos, 3});          // OpVariable Output
    s.inst(59, {pOutV4, vCol, 3});
    s.inst(54, {tVoid, fn, 0, tFn});        // OpFunction
    U32 entry = s.fresh(), merge = s.fresh();
    s.inst(248, {entry});                   // OpLabel
    U32 idx = s.fresh();
    s.inst(61, {tInt, idx, vIdx});          // OpLoad VertexIndex
    std::vector<U32> caseLbl(n);
    for (U32 i = 0; i < n; i++) caseLbl[i] = s.fresh();
    U32 dflt = s.fresh();
    s.inst(246, {merge, 0});                // OpSelectionMerge
    {
        size_t at = s.w.size();             // OpSwitch
        s.w.push_back(0); s.w.push_back(idx); s.w.push_back(dflt);
        for (U32 i = 0; i < n; i++) { s.w.push_back(i); s.w.push_back(caseLbl[i]); }
        s.w[at] = ((U32)(s.w.size() - at) << 16) | 247;
    }
    for (U32 i = 0; i < n; i++) {
        s.inst(248, {caseLbl[i]});
        s.inst(62, {vPos, posId[i]});       // OpStore position/color
        s.inst(62, {vCol, colId[i]});
        s.inst(249, {merge});               // OpBranch
    }
    s.inst(248, {dflt});
    s.inst(249, {merge});
    s.inst(248, {merge});
    s.inst(253, {});                        // OpReturn
    s.inst(56, {});                         // OpFunctionEnd
    return s.bytes();
}

// Fragment: Location-0 color passthrough.
std::vector<U8> synthReplayFs() {
    SpvEmit s;
    s.w.reserve(80);
    s.w.insert(s.w.end(), {0x07230203, 0x00010000, 0, 0, 0});
    U32 tVoid = s.fresh(), tFloat = s.fresh(), tV4 = s.fresh();
    U32 tFn = s.fresh(), pInV4 = s.fresh(), pOutV4 = s.fresh();
    U32 vIn = s.fresh(), vOut = s.fresh(), fn = s.fresh();
    s.inst(17, {1});
    s.inst(14, {0, 1});
    s.entryPoint(4, fn, "main", {vIn, vOut});
    s.inst(16, {fn, 7});                    // OpExecutionMode OriginUpperLeft
    s.inst(71, {vIn, 30, 0});
    s.inst(71, {vOut, 30, 0});
    s.inst(19, {tVoid});
    s.inst(22, {tFloat, 32});
    s.inst(23, {tV4, tFloat, 4});
    s.inst(33, {tFn, tVoid});
    s.inst(32, {pInV4, 1, tV4});
    s.inst(32, {pOutV4, 3, tV4});
    s.inst(59, {pInV4, vIn, 1});
    s.inst(59, {pOutV4, vOut, 3});
    s.inst(54, {tVoid, fn, 0, tFn});
    U32 entry = s.fresh(), tmp = s.fresh();
    s.inst(248, {entry});
    s.inst(61, {tV4, tmp, vIn});
    s.inst(62, {vOut, tmp});
    s.inst(253, {});
    s.inst(56, {});
    return s.bytes();
}

void fillImageFormatProps(VkImageFormatProperties* p) {
    p->maxExtent = VkExtent3D{16384, 16384, 2048};
    p->maxMipLevels = 14;
    p->maxArrayLayers = 2048;
    p->sampleCounts = (VkSampleCountFlags)(VK_SAMPLE_COUNT_1_BIT | VK_SAMPLE_COUNT_2_BIT |
                                           VK_SAMPLE_COUNT_4_BIT | VK_SAMPLE_COUNT_8_BIT);
    p->maxResourceSize = 2ull * 1024 * 1024 * 1024;
}

// Submit-time frame reconstruction (P1's vkQueueSubmit body, file I/O replaced
// by the in-memory manifest serializer).
// ---------------------------------------------------------------------------
void resolveFrame(CmdBuf* st, U64* uboOut, U64* uboSize, U64* viewOut, U64* sampOut) {
    *uboOut = 0; *uboSize = 0; *viewOut = 0; *sampOut = 0;
    DescSet* s0 = st->sets[0] ? objOf<DescSet>(st->sets[0], K_SET, "resolveFrame") : nullptr;
    if (!s0) return;
    for (U32 i = 0; i < s0->nbind; i++) {
        if (s0->binds[i].binding == 0 && s0->binds[i].obj) { *uboOut = s0->binds[i].obj; *uboSize = s0->binds[i].range; }
        if (s0->binds[i].binding == 1 && s0->binds[i].obj) { *viewOut = s0->binds[i].obj; *sampOut = s0->binds[i].range; }
    }
}

void serializeSubmit(const std::vector<std::pair<CmdBuf*, U64>>& frames) {
    for (const auto& fr : frames) {
        CmdBuf* st = fr.first;
        // the recorded framebuffer id lives in the BEGIN_RP command
        U64 fbId = 0;
        for (const Cmd& k : st->cmds) if (k.kind == CMD_BEGIN_RP) { fbId = k.b; break; }
        Framebuffer* fb = objOf<Framebuffer>(fbId, K_FRAMEBUFFER, "vkQueueSubmit");
        if (!fb) { klog_fmt("vk64: submit: frame %u has no framebuffer, skipped", g_frameNo); continue; }

        Pipeline* pipe = nullptr;
        const float* vp = nullptr;
        const float* sci = nullptr;
        float clear[4] = {0, 0, 0, 1};
        double clearDepth = 1.0;
        std::vector<std::pair<U32, U32>> draws;   // vertexCount, firstVertex
        std::vector<const Cmd*> pushes;           // in order: offset + bytes matter
        const Cmd* firstCap = nullptr;            // first indexed draw with baked verts
        for (const Cmd& k : st->cmds) {
            switch (k.kind) {
                case CMD_BEGIN_RP:
                    memcpy(clear, k.f, sizeof(clear));
                    clearDepth = k.clearDepth;
                    break;
                case CMD_BIND_PIPE:
                    pipe = objOf<Pipeline>(k.a, K_PIPELINE, "vkQueueSubmit");
                    break;
                case CMD_VIEWPORT: vp = k.f; break;
                case CMD_SCISSOR:  sci = k.f; break;
                case CMD_PUSH_CONST: pushes.push_back(&k); break;
                case CMD_DRAW:
                    if (draws.size() < VK64_MAX_DRAWS) draws.push_back({(U32)k.a, (U32)k.c});
                    break;
                case CMD_DRAW_INDEXED:
                    // Baked in draw order, so the replay vertex_index maps 1:1.
                    if (draws.size() < VK64_MAX_DRAWS) draws.push_back({(U32)k.a, 0});
                    if (!firstCap && k.capCount) firstCap = &k;
                    break;
                default: break;
            }
        }
        if (!pipe || draws.empty()) {
            klog_fmt("vk64: submit: frame %u without draw (pipe=0x%llx draws=%u), skipped",
                     g_frameNo, (unsigned long long)(pipe ? 0 : 0), (unsigned)draws.size());
            continue;
        }

        U64 uboId = 0, uboSize = 0, viewId = 0, sampId = 0;
        resolveFrame(st, &uboId, &uboSize, &viewId, &sampId);
        Buffer* ubo = uboId ? objOf<Buffer>(uboId, K_BUFFER, "vkQueueSubmit") : nullptr;
        Sampler* samp = sampId ? objOf<Sampler>(sampId, K_SAMPLER, "vkQueueSubmit") : nullptr;
        ImageView* view = viewId ? objOf<ImageView>(viewId, K_IMAGEVIEW, "vkQueueSubmit") : nullptr;
        Image* tex = view ? objOf<Image>(view->image, K_IMAGE, "vkQueueSubmit") : nullptr;
        ShaderModule* vs = pipe->vs ? objOf<ShaderModule>(pipe->vs, K_SHADER, "vkQueueSubmit") : nullptr;
        ShaderModule* fs = pipe->fs ? objOf<ShaderModule>(pipe->fs, K_SHADER, "vkQueueSubmit") : nullptr;

        // UBO bytes: descriptor-set-0 binding 0, clamped to the allocation.
        std::vector<U8> uboBytes;
        bool haveUbo = false;
        if (ubo && ubo->mem) {
            uboBytes = readGuestRange(ubo->mem, ubo->memOff, uboSize ? uboSize : ubo->size);
            haveUbo = !uboBytes.empty();
        }
        // Texture bytes: the staging path (a recorded copy landed in the image's
        // bound memory) and the linear path (guest wrote them through
        // vkGetImageSubresourceLayout / vkMapMemory) are now the same guest
        // range; P1's 'copied' flag only decides which of the two it reports.
        std::vector<U8> texBytes;
        bool haveTex = false;
        U32 tw = 0, th = 0;
        if (tex) {
            tw = tex->w; th = tex->h;
            if (tex->mem) {
                texBytes = readGuestRange(tex->mem, tex->memOff, tex->pixBytes);
                haveTex = !texBytes.empty();
            }
        }

        std::string j = "{";
        char buf[512];
        snprintf(buf, sizeof buf, "\"frame\":%u,\"width\":%u,\"height\":%u,\"overflow\":%s,",
                 g_frameNo, fb->w, fb->h, g_frameOverflow ? "true" : "false");
        j += buf;
        snprintf(buf, sizeof buf, "\"colorFormat\":\"%s\",", fmt_name(fb->natt && view ? (U32)view->format : 0));
        j += buf;
        j += "\"clearColor\":" + jsonFloats(clear, 4) + ",";
        snprintf(buf, sizeof buf, "\"clearDepth\":%g,", clearDepth);
        j += buf;
        j += "\"viewport\":"; j += vp ? jsonFloats(vp, 6) : "null"; j += ",";
        j += "\"scissor\":";  j += sci ? jsonFloats(sci, 4) : "null"; j += ",";
        snprintf(buf, sizeof buf, "\"cull\":%u,\"front\":%u,\"depthTest\":%u,\"depthWrite\":%u,\"depthOp\":%u,",
                 pipe->cull, pipe->front, pipe->depthTest, pipe->depthWrite, pipe->depthOp);
        j += buf;
        // G2 replay: when an indexed draw baked its vertices, substitute the
        // procedural shaders so the page tier (no vertex buffers) rasterizes the
        // captured triangle. Otherwise the guest modules go out unchanged.
        std::vector<U8> repVs, repFs;
        bool haveReplay = false;
        if (firstCap) {
            repVs = synthReplayVs(firstCap->capPos, firstCap->capCol, firstCap->capCount);
            repFs = synthReplayFs();
            haveReplay = !repVs.empty() && !repFs.empty();
            if (haveReplay)
                klog_fmt("vk64: replay shaders synthesized (%u verts, vs %zuB fs %zuB)",
                         firstCap->capCount, repVs.size(), repFs.size());
        }
        if (haveReplay) {
            char sh[40];
            snprintf(sh, sizeof sh, "%016llx",
                     (unsigned long long)blob_hash(repVs.data(), repVs.size()));
            j += "\"vs\":{\"hash\":\""; j += sh; j += "\",";
            jsonBlob(j, "spv", repVs); j += ",";
            snprintf(sh, sizeof sh, "%016llx",
                     (unsigned long long)blob_hash(repFs.data(), repFs.size()));
            j += "\"fs\":{\"hash\":\""; j += sh; j += "\",";
            jsonBlob(j, "spv", repFs); j += ",";
        } else if (vs) {
            char sh[40];
            snprintf(sh, sizeof sh, "%016llx", (unsigned long long)vs->hash);
            j += "\"vs\":{\"hash\":\""; j += sh; j += "\",";
            jsonBlob(j, "spv", vs->code); j += ",";
        } else j += "\"vs\":null,";
        if (!haveReplay) {
            if (fs) {
                char sh[40];
                snprintf(sh, sizeof sh, "%016llx", (unsigned long long)fs->hash);
                j += "\"fs\":{\"hash\":\""; j += sh; j += "\",";
                jsonBlob(j, "spv", fs->code); j += ",";
            } else j += "\"fs\":null,";
        }
        jsonBlobOrNull(j, "ubo", uboBytes, haveUbo);
        j += ",";
        snprintf(buf, sizeof buf, "\"texture\":{\"w\":%u,\"h\":%u,\"format\":\"%s\",\"staged\":%s,",
                 tw, th, tex ? fmt_name(tex->format) : "UNKNOWN", (tex && tex->copied) ? "true" : "false");
        j += buf;
        jsonBlobOrNull(j, "pixels", texBytes, haveTex);
        j += "},";
        snprintf(buf, sizeof buf,
                 "\"sampler\":{\"mag\":%u,\"min\":%u,\"mipmap\":%u,\"addrU\":%u,\"addrV\":%u,\"maxAniso\":%g},",
                 samp ? samp->mag : 0, samp ? samp->min : 0, samp ? samp->mipmap : 0,
                 samp ? samp->addrU : 0, samp ? samp->addrV : 0, samp ? (double)samp->maxAniso : 1.0);
        j += buf;
        // The vertex input layout, straight off the recorded pipeline. Additive:
        // a consumer that predates these keys (host/p1render.mjs) ignores them and
        // vkcube's own frame still renders exactly as before.
        j += "\"vertexLayout\":{\"bindings\":[";
        for (U32 i = 0; i < pipe->nvb; i++) {
            if (i) j += ",";
            snprintf(buf, sizeof buf, "{\"binding\":%u,\"stride\":%u,\"inputRate\":%u}",
                     i, pipe->vbStride[i], pipe->vbInputRate[i]);
            j += buf;
        }
        j += "],\"attributes\":[";
        for (U32 i = 0; i < pipe->nva; i++) {
            if (i) j += ",";
            snprintf(buf, sizeof buf,
                     "{\"location\":%u,\"binding\":%u,\"format\":%u,\"offset\":%u}",
                     pipe->vaLocation[i], pipe->vaBinding[i], pipe->vaFormat[i], pipe->vaOffset[i]);
            j += buf;
        }
        j += "]},";
        // Push constants: one entry per recorded push, base64 bytes + the byte
        // offset they land at, so a consumer can overlay them per draw.
        j += "\"pushConstants\":[";
        for (size_t i = 0; i < pushes.size(); i++) {
            if (i) j += ",";
            snprintf(buf, sizeof buf, "{\"offset\":%u,\"size\":%u,\"stageFlags\":%u,",
                     pushes[i]->pcOffset, pushes[i]->pcSize, pushes[i]->pcStageFlags);
            j += buf;
            std::vector<U8> bytes(pushes[i]->pcBytes, pushes[i]->pcBytes + pushes[i]->pcSize);
            jsonBlob(j, "bytes", bytes);
            j += "}";
        }
        j += "],";
        j += "\"draws\":[";
        for (size_t i = 0; i < draws.size(); i++) {
            if (i) j += ",";
            snprintf(buf, sizeof buf, "{\"vertexCount\":%u,\"firstVertex\":%u}", draws[i].first, draws[i].second);
            j += buf;
        }
        j += "]}";

        // P1 wrote one manifest per submit-with-draw and let present.log tie the
        // present to it. Here the manifest is BUILT at submit and HOPPED at
        // present; if a second submit-with-draw arrives before any present, the
        // stale one is flushed first so no frame is silently dropped.
        if (!g_pendingFrame.empty()) emitFrameNow();
        g_pendingFrame = j;
        g_frameOverflow = false;
        klog_fmt("vk64: FRAME %u built: %ux%u draws=%u vs=%s fs=%s ubo=%zuB tex=%ux%u(%zuB) "
                 "vtxAttrs=%u pushes=%u json=%zuB",
                 g_frameNo, fb->w, fb->h, (unsigned)draws.size(),
                 vs ? "yes" : "no", fs ? "yes" : "no",
                 uboBytes.size(), tw, th, texBytes.size(), (unsigned)pipe->nva,
                 (unsigned)pushes.size(), j.size());
    }
}

// ---------------------------------------------------------------------------
// Schema v2: binary framed records (tasks/schema-v2.md sections 2-3).
//
// v1 hops one JSON string per present; v2 streams binary records across one
// MAIN_THREAD_EM_ASM per CHUNK (1 MiB cap). The hop moves (ptr,len,flags) —
// three ints — and the JS body copies the bytes once; there is no UTF-8
// decode, no JSON.parse, and no base64 on either side. FRAME_BEGIN is emitted
// at the first submit-with-draw after a present, FRAME_END seals at present,
// so a frame is present-to-present no matter how many submits it spans.
//
// BW64_VKSCHEMA=1 selects the v1 JSON emitter verbatim (serializeSubmit +
// window.bwVkFrame); the default is v2.
// ---------------------------------------------------------------------------
inline bool vkSchemaV2() {
    static int v = -1;
    if (v < 0) {
        const char* e = getenv("BW64_VKSCHEMA");
        v = (e && e[0] == '1' && e[1] == '\0') ? 0 : 1;
    }
    return v != 0;
}
inline bool vkDumpV2() {
    static int cached = -1;
    if (cached < 0) { const char* t = getenv("BW64_VKDUMP"); cached = (t && t[0] == '1' && t[1] == '\0') ? 1 : 0; }
    return cached != 0;
}

enum V2Rec : U32 {
    V2_FRAME_BEGIN = 0x01, V2_FRAME_END = 0x02,
    V2_RP_BEGIN = 0x03, V2_RP_END = 0x04,
    V2_SHADER = 0x05, V2_PIPELINE = 0x06,
    V2_BIND_SETS = 0x07, V2_DESC_SET = 0x08,
    V2_BUFFER_DATA = 0x09, V2_IMAGE_DATA = 0x0A, V2_SAMPLER = 0x0B,
    V2_PUSH = 0x0C, V2_VIEWPORT = 0x0D, V2_SCISSOR = 0x0E,
    V2_VERTEX_BIND = 0x0F, V2_INDEX_BIND = 0x10, V2_DRAW = 0x11,
    V2_INLINE_BYTES = 0x12,
};
const U32 V2_CHUNK_MAGIC = 0x46324B56u;   // 'VK2F' little-endian: bytes 56 4B 32 46
const U32 V2_CHUNK_VERSION = 2;
const size_t V2_CHUNK_CAP = 1024 * 1024;  // seal before a record that would overflow
const U32 V2_PRODUCER_CHUNK_RING = 8;     // drop oldest COMPLETE frame past this

struct ChunkWriter {
    std::vector<U8> b;
    void u8(U32 v)  { b.push_back((U8)v); }
    void u16(U32 v) { b.push_back((U8)v); b.push_back((U8)(v >> 8)); }
    void u32(U32 v) { for (int i = 0; i < 4; i++) b.push_back((U8)(v >> (8 * i))); }
    void u64(U64 v) { for (int i = 0; i < 8; i++) b.push_back((U8)(v >> (8 * i))); }
    void f32(float v) { U32 u; memcpy(&u, &v, 4); u32(u); }
    void bytes(const U8* p, size_t n) { if (p && n) b.insert(b.end(), p, p + n); }
    void bytes(const std::vector<U8>& v) { bytes(v.data(), v.size()); }
};

// One frame under construction: an open chunk plus sealed chunks. Records never
// straddle chunks; a single oversize record gets a chunk of its own.
struct V2FrameAsm {
    ChunkWriter cur;
    std::vector<std::vector<U8>> sealed;
    U32* hist = nullptr;   // optional per-frame record-type histogram (BW64_VKDUMP=1)
    void openChunk(U32 seq) {
        cur.b.clear();
        // 16-byte header per tasks/schema-v2.md §2.3: magic, version, flags,
        // seq, reserved. (flags bit0 = MORE is patched at byte 6 in
        // v2QueueFrame.)
        cur.u32(V2_CHUNK_MAGIC); cur.u16(V2_CHUNK_VERSION); cur.u16(0); cur.u32(seq);
        cur.u32(0);
    }
    void sealChunk() {
        if (cur.b.size() > 16) sealed.push_back(cur.b);
        cur.b.clear();
    }
    void emitRec(U32 type, const std::vector<U8>& payload, U32& seq) {
        size_t need = 8 + payload.size();
        if (cur.b.size() + need > V2_CHUNK_CAP && cur.b.size() > 16) {
            sealChunk();
            openChunk(seq++);
        }
        cur.u16(type); cur.u16(0); cur.u32((U32)payload.size());
        cur.bytes(payload);
        if (hist && type < 32) hist[type]++;
    }
};

struct V2DoneFrame { std::vector<std::vector<U8>> chunks; };
std::deque<V2DoneFrame> g_v2Pending;   // complete frames awaiting the present hop
U32 g_v2ChunkSeq = 0;
U64 g_v2DroppedProducer = 0;

void v2QueueFrame(V2FrameAsm& fa) {
    fa.sealChunk();
    if (fa.sealed.empty()) return;
    // MORE flag on every chunk but the last (byte 6 = flags low byte).
    for (size_t i = 0; i + 1 < fa.sealed.size(); i++) fa.sealed[i][6] |= 1;
    size_t chunks = 0;
    for (const auto& f : g_v2Pending) chunks += f.chunks.size();
    while (chunks + fa.sealed.size() > V2_PRODUCER_CHUNK_RING && !g_v2Pending.empty()) {
        chunks -= g_v2Pending.front().chunks.size();
        g_v2Pending.pop_front();
        g_v2DroppedProducer++;
        klog_fmt("vk64: v2 producer ring full, dropped oldest frame (total dropped=%llu)",
                 (unsigned long long)g_v2DroppedProducer);
    }
    V2DoneFrame done;
    done.chunks = std::move(fa.sealed);
    g_v2Pending.push_back(std::move(done));
}

void hopV2ToPage() {
#ifdef __EMSCRIPTEN__
    // Hop the frame with the actual pixel data. DXVK builds two v2 frames per
    // present: a 480x360 backbuffer frame (1MB, contains IMAGE_DATA with the
    // rendered triangle) and a 472x333 present frame (3.5KB, just the present
    // metadata without pixels). Hopping only the back (472x333) gives the page
    // an empty frame -> litPixels=0. Hopping all frames causes the page to
    // render 480x360 then clear for 472x333, racing the readback -> blank.
    // Select the frame with the maximum bytes (the one with the pixels).
    if (!g_v2Pending.empty()) {
        const V2DoneFrame* best = &g_v2Pending.front();
        size_t bestBytes = 0;
        for (const auto& f : g_v2Pending) {
            size_t total = 0;
            for (const auto& c : f.chunks) total += c.size();
            if (total > bestBytes) { bestBytes = total; best = &f; }
        }
        const auto& f = *best;
        for (const auto& chunk : f.chunks) {
            const U8* ptr = chunk.data();
            U32 len = (U32)chunk.size();
            MAIN_THREAD_EM_ASM({
                if (globalThis.window && window.bwVkChunk) {
                    try {
                        // One memcpy: a subarray view is unsafe to retain because
                        // wasm memory growth detaches every live view.
                        // Use HEAPU8 directly (Module.HEAPU8 may not be in scope).
                        const bytes = new Uint8Array(HEAPU8.buffer, $0, $1).slice();
                        window.bwVkChunk(bytes, $2);
                    } catch (e) { console.warn('vk64: bwVkChunk failed', e); }
                }
            }, ptr, len, (U32)0);
        }
    }
#else
    if (!g_v2Pending.empty())
        klog_fmt("vk64: v2 hop skipped (not an emscripten build): %u queued frames dropped",
                 (unsigned)g_v2Pending.size());
#endif
    g_v2Pending.clear();
}

// Submit-time v2 frame reconstruction: the same walk as serializeSubmit, but
// the frame is a stream of binary records instead of one JSON string, and it
// covers the DXVK-shaped calls v1 never modelled (descriptor sets with arrays,
// indexed draws, vertex/index binds, per-attachment MSAA, the render-pass
// graph). One v2 frame per submit-with-draw, queued for the present hop.
void serializeSubmitV2(const std::vector<std::pair<CmdBuf*, U64>>& frames) {
    for (const auto& fr : frames) {
        CmdBuf* st = fr.first;
        U64 fbId = 0;
        for (const Cmd& k : st->cmds) if (k.kind == CMD_BEGIN_RP) { fbId = k.b; break; }
        Framebuffer* fb = objOf<Framebuffer>(fbId, K_FRAMEBUFFER, "vkQueueSubmit");
        if (!fb) { klog_fmt("vk64: submit(v2): frame %u has no framebuffer, skipped", g_frameNo); continue; }
        bool anyDraw = false;
        for (const Cmd& k : st->cmds)
            if (k.kind == CMD_DRAW || k.kind == CMD_DRAW_INDEXED) { anyDraw = true; break; }
        if (!anyDraw) { klog_fmt("vk64: submit(v2): frame %u without draw, skipped", g_frameNo); continue; }

        V2FrameAsm fa;
        U32 hist[32] = {0};
        if (vkDumpV2()) fa.hist = hist;
        fa.openChunk(g_v2ChunkSeq++);

        auto emit = [&](U32 type, auto&& fill) {
            ChunkWriter p;
            fill(p);
            fa.emitRec(type, p.b, g_v2ChunkSeq);
        };

        // Per-frame dedup: a set bound twice or a buffer referenced by ten
        // draws crosses once.
        std::set<U64> shaderDone, samplerDone, imageDone;
        std::set<std::tuple<U64,U64,U64>> bufDone;

        auto emitShader = [&](ShaderModule* sm, U32 stage) {
            if (!sm || !sm->hash || !shaderDone.insert(sm->hash).second) return;
            emit(V2_SHADER, [&](ChunkWriter& p) {
                p.u8(stage); p.u8(0); p.u16(0);
                p.u64(sm->hash); p.u32((U32)sm->code.size()); p.bytes(sm->code);
            });
        };
        auto emitBufferData = [&](U64 bufId, U64 memOff, U64 len) {
            if (!bufId || !len) return;
            if (!bufDone.insert(std::make_tuple(bufId, memOff, len)).second) return;
            Buffer* b = objOf<Buffer>(bufId, K_BUFFER, "vkQueueSubmit");
            if (!b || !b->mem) return;
            std::vector<U8> bytes = readGuestRange(b->mem, memOff, len);
            if (bytes.empty()) return;
            emit(V2_BUFFER_DATA, [&](ChunkWriter& p) {
                p.u64(bufId); p.u64(memOff); p.u32((U32)bytes.size()); p.bytes(bytes);
            });
        };
        auto emitSampler = [&](U64 id) {
            if (!id || !samplerDone.insert(id).second) return;
            Sampler* s = objOf<Sampler>(id, K_SAMPLER, "vkQueueSubmit");
            if (!s) return;
            emit(V2_SAMPLER, [&](ChunkWriter& p) {
                p.u64(id);
                p.u32(s->mag); p.u32(s->min); p.u32(s->mipmap);
                p.u32(s->addrU); p.u32(s->addrV); p.f32(s->maxAniso);
            });
        };
        auto emitImageData = [&](U64 viewId) {
            ImageView* view = objOf<ImageView>(viewId, K_IMAGEVIEW, "vkQueueSubmit");
            if (!view || !view->image) return;
            if (!imageDone.insert(view->image).second) return;
            Image* tex = objOf<Image>(view->image, K_IMAGE, "vkQueueSubmit");
            if (!tex) return;
            std::vector<U8> bytes;
            if (tex->mem && tex->pixBytes) bytes = readGuestRange(tex->mem, tex->memOff, tex->pixBytes);
            emit(V2_IMAGE_DATA, [&](ChunkWriter& p) {
                // viewId first: the page's DESC_SET bindings name image VIEWS,
                // while this record is deduped per image, so the record carries
                // the view->image link the page needs.
                p.u64(viewId); p.u64(view->image); p.u32(tex->w); p.u32(tex->h); p.u32(tex->format);
                p.u32((U32)bytes.size()); p.bytes(bytes);
            });
        };
        auto emitDescSet = [&](U32 setIndex, U64 setId) {
            DescSet* s = objOf<DescSet>(setId, K_SET, "vkQueueSubmit");
            if (!s) return;
            emit(V2_DESC_SET, [&](ChunkWriter& p) {
                p.u8(setIndex); p.u8(s->nbind); p.u16(0); p.u64(s->layout);
                for (U32 i = 0; i < s->nbind; i++) {
                    const Binding& b = s->binds[i];
                    U32 kind = 0;
                    switch (b.type) {
                        case VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER:
                        case VK_DESCRIPTOR_TYPE_STORAGE_BUFFER: kind = 1; break;
                        case VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE:
                        case VK_DESCRIPTOR_TYPE_STORAGE_IMAGE:
                        case VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER: kind = 2; break;
                        case VK_DESCRIPTOR_TYPE_SAMPLER: kind = 3; break;
                        case VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK: kind = 4; break;
                        default: break;
                    }
                    // Absolute byte offset of this binding's range, matching
                    // V2_BUFFER_DATA's memOff. One VkBuffer may back several
                    // uniform bindings at different offsets (DXVK sub-allocates
                    // D3D9 constants); the page keys captures by (id, offset).
                    U64 absOff = 0;
                    if (kind == 1) {
                        Buffer* bbuf = objOf<Buffer>(b.obj, K_BUFFER, "vkQueueSubmit");
                        if (bbuf) absOff = bbuf->memOff + b.bufOff;
                    }
                    p.u32(b.binding); p.u32(b.type); p.u32(b.dstArrayElement); p.u32(b.count);
                    p.u8(kind); p.u8(0); p.u16(0);
                    p.u64(b.obj); p.u64(b.range); p.u64(absOff);
                }
            });
            for (U32 i = 0; i < s->nbind; i++) {
                const Binding& b = s->binds[i];
                if (b.type == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER ||
                    b.type == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER) {
                    Buffer* buf = objOf<Buffer>(b.obj, K_BUFFER, "vkQueueSubmit");
                    if (buf) emitBufferData(b.obj, buf->memOff + b.bufOff, b.range ? b.range : buf->size);
                } else if (b.type == VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE ||
                           b.type == VK_DESCRIPTOR_TYPE_STORAGE_IMAGE ||
                           b.type == VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER) {
                    emitImageData(b.obj);    // b.obj = image view id (see vkUpdateDescriptorSets)
                    emitSampler(b.range);    // b.range = sampler id
                } else if (b.type == VK_DESCRIPTOR_TYPE_SAMPLER) {
                    emitSampler(b.obj);
                } else if (b.type == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK) {
                    // b.obj = guest VA of the inline bytes, b.range = size.
                    if (b.obj && b.range) {
                        std::vector<U8> bytes((size_t)b.range);
                        g_mem->memcpyFromGuest(bytes.data(), b.obj, b.range);
                        emit(V2_INLINE_BYTES, [&](ChunkWriter& p) {
                            p.u8(setIndex); p.u8(0); p.u16(0);
                            p.u32(b.binding); p.u32(b.dstArrayElement); p.u32((U32)bytes.size());
                            p.bytes(bytes);
                        });
                    }
                }
            }
        };
        U64 activePipe = 0;
        U32 vertexStrides[VK64_MAX_VERT_BINDINGS] = {0};
        bool vertexHasStride[VK64_MAX_VERT_BINDINGS] = {false};
        auto emitPipeline = [&](U64 pipeId) {
            Pipeline* pipe = objOf<Pipeline>(pipeId, K_PIPELINE, "vkQueueSubmit");
            if (!pipe) return;
            ShaderModule* vs = pipe->vs ? objOf<ShaderModule>(pipe->vs, K_SHADER, "vkQueueSubmit") : nullptr;
            ShaderModule* fs = pipe->fs ? objOf<ShaderModule>(pipe->fs, K_SHADER, "vkQueueSubmit") : nullptr;
            emitShader(vs, 0);
            emitShader(fs, 1);
            U64 serializedId = pipeId;
            std::vector<U32> effectiveStrides;
            for (U32 i = 0; i < pipe->nvb; ++i)
                effectiveStrides.push_back(pipe->dynamicVertexStride && vertexHasStride[i]
                    ? vertexStrides[i] : pipe->vbStride[i]);
            if (pipe->dynamicVertexStride) {
                auto variant = std::find_if(pipe->vertexStrideVariants.begin(), pipe->vertexStrideVariants.end(),
                    [&](const Pipeline::VertexStrideVariant& v) { return v.strides == effectiveStrides; });
                if (variant == pipe->vertexStrideVariants.end()) {
                    serializedId = g_nextId++; // Shared allocator prevents collisions with guest handles.
                    pipe->vertexStrideVariants.push_back({effectiveStrides, serializedId});
                } else serializedId = variant->id;
            }
            emit(V2_PIPELINE, [&](ChunkWriter& p) {
                p.u64(serializedId);
                p.u64(vs ? vs->hash : 0); p.u64(fs ? fs->hash : 0);
                p.u32(pipe->topology); p.u32(pipe->cull); p.u32(pipe->front);
                p.u32(pipe->depthTest); p.u32(pipe->depthWrite); p.u32(pipe->depthOp);
                p.u32(pipe->blend);
                p.u32(pipe->nvb); p.u32(pipe->nva);
                for (U32 i = 0; i < pipe->nvb; i++) {
                    p.u32(i); p.u32(effectiveStrides[i]); p.u32(pipe->vbInputRate[i]);
                }
                for (U32 i = 0; i < pipe->nva; i++) {
                    p.u32(pipe->vaLocation[i]); p.u32(pipe->vaBinding[i]);
                    p.u32(pipe->vaFormat[i]); p.u32(pipe->vaOffset[i]);
                }
                // Append-only specialization tail (2026-10-06): per-stage
                // (constantID, size, value bytes). Decoders that predate this
                // tail stop at the va list; new decoders read it if present.
                auto emitSpec = [&](const StageSpec& s) {
                    p.u32(s.n);
                    for (U32 i = 0; i < s.n; i++) {
                        p.u32(s.entries[i].constantID);
                        p.u32(s.entries[i].size);
                        p.bytes(s.entries[i].value, s.entries[i].size);
                    }
                };
                emitSpec(pipe->vsSpec);
                emitSpec(pipe->fsSpec);
            });
        };
        auto emitRpBegin = [&](const Cmd& k) {
            Framebuffer* rfb = objOf<Framebuffer>(k.b, K_FRAMEBUFFER, "vkQueueSubmit");
            RenderPass* rrp = rfb ? objOf<RenderPass>(rfb->rp, K_RENDERPASS, "vkQueueSubmit") : nullptr;
            if (!rfb || !rrp) return;
            emit(V2_RP_BEGIN, [&](ChunkWriter& p) {
                p.u64(k.a); p.u64(k.b); p.u32(rfb->w); p.u32(rfb->h); p.u32(rfb->natt);
                for (U32 i = 0; i < rfb->natt; i++) {
                    ImageView* v = objOf<ImageView>(rfb->views[i], K_IMAGEVIEW, "vkQueueSubmit");
                    p.u32(rrp->formats[i]); p.u32(rrp->loadOps[i]); p.u32(rrp->storeOps[i]);
                    p.u32(rrp->samples[i] ? rrp->samples[i] : 1);
                    p.u32(v && (v->aspect & 0x2u) ? 1 : 0);
                }
                p.f32(k.f[0]); p.f32(k.f[1]); p.f32(k.f[2]); p.f32(k.f[3]);
                p.f32((float)k.clearDepth); p.u32(0);
                // Optional attachment identity tail, paired with the updated
                // decoder. Image identity links render and sampled view aliases.
                for (U32 i = 0; i < rfb->natt; ++i) {
                    auto* view = objOf<ImageView>(rfb->views[i], K_IMAGEVIEW, "vkQueueSubmit");
                    p.u64(rfb->views[i]); p.u64(view ? view->image : 0);
                }
            });
        };

        // FRAME_BEGIN. The overflow flag is consumed here, like v1.
        bool ovf = g_frameOverflow;
        g_frameOverflow = false;
        emit(V2_FRAME_BEGIN, [&](ChunkWriter& p) {
            p.u32(g_frameNo); p.u32(fb->w); p.u32(fb->h); p.u32(ovf ? 1 : 0);
        });

        U32 nDraw = 0, nPush = 0;
        for (const Cmd& k : st->cmds) {
            switch (k.kind) {
                case CMD_BEGIN_RP: emitRpBegin(k); break;
                case CMD_END_RP:   emit(V2_RP_END, [](ChunkWriter&) {}); break;
                case CMD_BIND_PIPE: activePipe = k.a; emitPipeline(k.a); break;
                case CMD_BIND_SETS: {
                    U32 first = (U32)k.a, count = (U32)k.b;
                    if (first >= VK64_MAX_SETS) break;
                    if (first + count > VK64_MAX_SETS) count = VK64_MAX_SETS - first;
                    emit(V2_BIND_SETS, [&](ChunkWriter& p) {
                        p.u8(first); p.u8(count); p.u16(0);
                        for (U32 i = 0; i < count; i++) p.u64(st->sets[first + i]);
                    });
                    for (U32 i = 0; i < count; i++)
                        if (st->sets[first + i]) emitDescSet(first + i, st->sets[first + i]);
                    break;
                }
                case CMD_VIEWPORT:
                    emit(V2_VIEWPORT, [&](ChunkWriter& p) {
                        for (int i = 0; i < 6; i++) p.f32(k.f[i]);
                    });
                    break;
                case CMD_SCISSOR:
                    emit(V2_SCISSOR, [&](ChunkWriter& p) {
                        p.u32((U32)(int32_t)k.f[0]); p.u32((U32)(int32_t)k.f[1]);
                        p.u32((U32)(int32_t)k.f[2]); p.u32((U32)(int32_t)k.f[3]);
                    });
                    break;
                case CMD_PUSH_CONST:
                    nPush++;
                    emit(V2_PUSH, [&](ChunkWriter& p) {
                        p.u32(k.pcOffset); p.u32(k.pcSize); p.u32(k.pcStageFlags);
                        p.bytes(k.pcBytes, k.pcSize);
                    });
                    break;
                case CMD_BIND_VB: {
                    emit(V2_VERTEX_BIND, [&](ChunkWriter& p) {
                        p.u8(k.vbCount); p.u8(0); p.u16(0);
                        for (U32 i = 0; i < k.vbCount; i++) {
                            p.u32(i); p.u64(k.vbBuffers[i]); p.u64(k.vbOffsets[i]);
                        }
                    });
                    memcpy(vertexStrides, k.vbStrides, sizeof(vertexStrides));
                    memcpy(vertexHasStride, k.vbHasStride, sizeof(vertexHasStride));
                    for (U32 i = 0; i < k.vbCount; i++) {
                        Buffer* vb = objOf<Buffer>(k.vbBuffers[i], K_BUFFER, "vkQueueSubmit");
                        if (vb && vb->size) emitBufferData(k.vbBuffers[i], vb->memOff, vb->size);
                    }
                    auto* pipe = activePipe ? objOf<Pipeline>(activePipe, K_PIPELINE, "vkQueueSubmit") : nullptr;
                    if (pipe && pipe->dynamicVertexStride) emitPipeline(activePipe);
                    break;
                }
                case CMD_BIND_IB: {
                    emit(V2_INDEX_BIND, [&](ChunkWriter& p) {
                        p.u64(st->ib); p.u64(st->ibOff); p.u32(st->ibType);
                    });
                    Buffer* ib = objOf<Buffer>(st->ib, K_BUFFER, "vkQueueSubmit");
                    if (ib && ib->size) emitBufferData(st->ib, ib->memOff, ib->size);
                    break;
                }
                case CMD_DRAW:
                    nDraw++;
                    emit(V2_DRAW, [&](ChunkWriter& p) {
                        p.u32((U32)k.a); p.u32((U32)k.b); p.u32((U32)k.c); p.u32((U32)k.d);
                        p.u8(0); p.u8(0); p.u16(0);
                        p.u32(0); p.u32(0); p.u32(0);
                    });
                    break;
                case CMD_DRAW_INDEXED:
                    nDraw++;
                    emit(V2_DRAW, [&](ChunkWriter& p) {
                        p.u32(0); p.u32((U32)k.b); p.u32(0); p.u32((U32)k.d);
                        p.u8(1); p.u8(0); p.u16(0);
                        p.u32((U32)k.a); p.u32((U32)k.c); p.u32((U32)(int32_t)k.copy.ox);
                    });
                    break;
                default: break;   // barriers, copies (eagerly executed at submit)
            }
        }

        emit(V2_FRAME_END, [&](ChunkWriter& p) { p.u32(g_frameNo); });
        v2QueueFrame(fa);

        const V2DoneFrame& qd = g_v2Pending.back();
        size_t totalBytes = 0;
        for (const auto& c : qd.chunks) totalBytes += c.size();
        klog_fmt("vk64: FRAME %u built (v2): %ux%u draws=%u pushes=%u chunks=%u bytes=%zu",
                 g_frameNo, fb->w, fb->h, (unsigned)nDraw, (unsigned)nPush,
                 (unsigned)qd.chunks.size(), totalBytes);
        if (vkDumpV2()) {
            std::string dump = "vk64: FRAME " + std::to_string(g_frameNo) + " v2 records:";
            const char* names[] = { "?", "FRAME_BEGIN", "FRAME_END", "RP_BEGIN", "RP_END",
                "SHADER", "PIPELINE", "BIND_SETS", "DESC_SET", "BUFFER_DATA", "IMAGE_DATA",
                "SAMPLER", "PUSH", "VIEWPORT", "SCISSOR", "VERTEX_BIND", "INDEX_BIND",
                "DRAW", "INLINE_BYTES" };
            for (U32 t = 1; t < 19; t++)
                if (hist[t]) { dump += " "; dump += names[t]; dump += "=" + std::to_string(hist[t]); }
            klog_fmt("%s", dump.c_str());
        }
        g_frameNo++;
    }
}

// ---------------------------------------------------------------------------
// Physical device: one == one WebGPU adapter (P1 section 1.2 table row 2).
// ---------------------------------------------------------------------------
const char* GPU_NAME = "VKWGPU WebGPU Virtual Device";
const U32  g_icd_api_version = VK_API_VERSION_1_3;

void fillProperties(VkPhysicalDeviceProperties* p) {
    memset(p, 0, sizeof(*p));
    p->apiVersion = g_icd_api_version;
    p->driverVersion = 1;
    p->vendorID = 0x1A2B3C4D;      /* synthetic, as in P1 */
    p->deviceID = 0x0000ABCD;
    p->deviceType = VK_PHYSICAL_DEVICE_TYPE_OTHER;
    strncpy(p->deviceName, GPU_NAME, VK_MAX_PHYSICAL_DEVICE_NAME_SIZE - 1);
    /* llvmpipe-ish geometry: Boxedwine guests assume a real GPU */
    VkPhysicalDeviceLimits& L = p->limits;
    L.maxImageDimension1D = 16384; L.maxImageDimension2D = 16384; L.maxImageDimension3D = 2048;
    L.maxImageDimensionCube = 16384; L.maxImageArrayLayers = 2048;
    L.maxTexelBufferElements = 1 << 27; L.maxUniformBufferRange = 65536;
    L.maxStorageBufferRange = 1 << 30; L.maxPushConstantsSize = 256;
    L.maxMemoryAllocationCount = 4096; L.maxSamplerAllocationCount = 4000;
    L.bufferImageGranularity = 1; L.sparseAddressSpaceSize = 0;
    L.maxBoundDescriptorSets = 4; L.maxPerStageDescriptorSamplers = 16;
    L.maxPerStageDescriptorUniformBuffers = 16; L.maxPerStageDescriptorStorageBuffers = 4;
    L.maxPerStageDescriptorSampledImages = 16; L.maxPerStageDescriptorStorageImages = 4;
    L.maxPerStageDescriptorInputAttachments = 4;
    L.maxPerStageResources = 128; L.maxDescriptorSetSamplers = 16;
    L.maxDescriptorSetUniformBuffers = 16; L.maxDescriptorSetUniformBuffersDynamic = 8;
    L.maxDescriptorSetStorageBuffers = 4; L.maxDescriptorSetStorageBuffersDynamic = 4;
    L.maxDescriptorSetSampledImages = 16; L.maxDescriptorSetStorageImages = 4;
    L.maxDescriptorSetInputAttachments = 4;
    L.maxVertexInputAttributes = 16; L.maxVertexInputBindings = 16;
    L.maxVertexInputAttributeOffset = 2047; L.maxVertexInputBindingStride = 2048;
    L.maxVertexOutputComponents = 64; L.maxTessellationGenerationLevel = 64;
    L.maxTessellationPatchSize = 32;
    L.maxFragmentInputComponents = 64; L.maxFragmentOutputAttachments = 4;
    L.maxFragmentDualSrcAttachments = 0; L.maxFragmentCombinedOutputResources = 4;
    L.maxComputeSharedMemorySize = 16384;
    L.maxComputeWorkGroupCount[0] = L.maxComputeWorkGroupCount[1] = L.maxComputeWorkGroupCount[2] = 65535;
    L.maxComputeWorkGroupInvocations = 128;
    L.maxComputeWorkGroupSize[0] = 128; L.maxComputeWorkGroupSize[1] = 128; L.maxComputeWorkGroupSize[2] = 64;
    L.subPixelPrecisionBits = 8; L.subTexelPrecisionBits = 8; L.mipmapPrecisionBits = 8;
    L.maxDrawIndexedIndexValue = 0xFFFFFFFFu; L.maxDrawIndirectCount = 0xFFFFFFFFu;
    L.maxSamplerLodBias = 2.0f; L.maxSamplerAnisotropy = 16.0f;
    // G2: DXVK D3D9 DecodeMultiSampleType derives sampleCount from
    // framebuffer{Color,Depth}SampleCounts; zero here zeroes the backbuffer
    // sampleCount and fails CheckImageSupport. Advertise at least 1x.
    L.framebufferColorSampleCounts = VK_SAMPLE_COUNT_1_BIT | VK_SAMPLE_COUNT_4_BIT;
    L.framebufferDepthSampleCounts = VK_SAMPLE_COUNT_1_BIT | VK_SAMPLE_COUNT_4_BIT;
    L.framebufferStencilSampleCounts = VK_SAMPLE_COUNT_1_BIT | VK_SAMPLE_COUNT_4_BIT;
    L.sampledImageColorSampleCounts = VK_SAMPLE_COUNT_1_BIT | VK_SAMPLE_COUNT_4_BIT;
    L.sampledImageDepthSampleCounts = VK_SAMPLE_COUNT_1_BIT;
    L.storageImageSampleCounts = VK_SAMPLE_COUNT_1_BIT;
    L.maxViewports = 16;
    L.maxViewportDimensions[0] = 4096; L.maxViewportDimensions[1] = 4096;
    L.viewportBoundsRange[0] = -8192.0f; L.viewportBoundsRange[1] = 8191.0f;
    L.viewportSubPixelBits = 0; L.minMemoryMapAlignment = 4096;
    L.minTexelBufferOffsetAlignment = 256; L.minUniformBufferOffsetAlignment = 256;
    L.minStorageBufferOffsetAlignment = 256; L.minTexelOffset = -8; L.maxTexelOffset = 7;
    L.minTexelGatherOffset = -8; L.maxTexelGatherOffset = 7;
    L.minInterpolationOffset = -0.5f; L.maxInterpolationOffset = 0.5f;
    L.subPixelInterpolationOffsetBits = 4; L.maxFramebufferWidth = 16384; L.maxFramebufferHeight = 16384;
    L.maxFramebufferLayers = 2048; L.maxColorAttachments = 8; L.maxSampleMaskWords = 1;
    L.maxClipDistances = 8; L.maxCullDistances = 8; L.maxCombinedClipAndCullDistances = 8;
    L.discreteQueuePriorities = 2;
    L.pointSizeRange[0] = 1.0f; L.pointSizeRange[1] = 64.0f;
    L.lineWidthRange[0] = 1.0f; L.lineWidthRange[1] = 1.0f;
    L.pointSizeGranularity = 0.0f; L.lineWidthGranularity = 0.0f;
    L.strictLines = VK_TRUE; L.standardSampleLocations = VK_TRUE;
    L.optimalBufferCopyOffsetAlignment = 1; L.optimalBufferCopyRowPitchAlignment = 1;
    L.nonCoherentAtomSize = 64;
}

const char* const g_inst_exts[] = {
    "VK_KHR_surface", "VK_KHR_win32_surface", "VK_KHR_xcb_surface",
    "VK_KHR_xlib_surface", "VK_EXT_headless_surface", "VK_EXT_debug_utils",
};

// The DXVK-required DEVICE extension set. Advertising an extension is pure
// reporting here: vkCreateDevice stays lenient about names it does not know, so
// this changes only what DXVK's isSuitable()/createDevice() decides to enable —
// but that is the whole init wall (audit P2-NOW item 1): with only
// VK_KHR_swapchain present, DXVK skips the adapter with "Device does not
// support required feature" and never reaches a triangle.
//
// Every name here is either behaviour-free for us (load_store_op_none,
// depth_clip_enable, maintenance5/6 — the recorder already treats load/store and
// cull conservatively) or has its behaviour implemented alongside (robustness2
// nullDescriptor -> a Binding may legitimately stay unbound; transform_feedback
// -> the Xfb query/write calls fall into the benign tail). VK_KHR_maintenance6 is
// present for DXVK >= 2.7.1 / master; a 2.4.x pin simply never asks for it.
const char* const g_dev_exts[] = {
    "VK_KHR_swapchain",
    "VK_KHR_maintenance5",
    "VK_KHR_maintenance6",
    "VK_KHR_load_store_op_none",
    "VK_EXT_robustness2",           // HARD requirement (nullDescriptor + robustBufferAccess2)
    "VK_EXT_transform_feedback",    // D3D10/11 stream output
    "VK_EXT_depth_clip_enable",
    // D3D12 (vkd3d-proton) device-creation gates. CAVEAT: advertised so
    // vkd3d_init_device_caps passes; the clear/triangle probes never exercise
    // real divisor/push-descriptor behavior. Actual usage needs page-side
    // replay support -- follow-up, not built here.
    "VK_EXT_vertex_attribute_divisor",
    "VK_KHR_push_descriptor",
};

// Core bits BOTH Features handlers set. DXVK's isSuitable() reads these out of
// the same struct we hand back, so a FALSE here is an adapter skip. geometryShader
// / tessellationShader stay FALSE on purpose: nothing in the manifest schema
// carries those stages yet, and DXVK only probes them.
void fillCoreFeatures(VkPhysicalDeviceFeatures* f) {
    memset(f, 0, sizeof(*f));
    f->robustBufferAccess = VK_TRUE;
    f->fullDrawIndexUint32 = VK_TRUE;
    f->imageCubeArray = VK_TRUE;        /* D3D11 cube arrays */
    f->independentBlend = VK_TRUE;      /* D3D11 independent blend targets */
    f->shaderInt64 = VK_TRUE;           /* wiki: 64-bit int types required */
    f->shaderFloat64 = VK_TRUE;         /* d3d11 double-precision shaders exist */
    f->shaderStorageImageExtendedFormats = VK_TRUE;
    f->shaderStorageImageReadWithoutFormat = VK_TRUE;
    f->shaderStorageImageWriteWithoutFormat = VK_TRUE;
    f->shaderClipDistance = VK_TRUE;
    f->samplerAnisotropy = VK_TRUE;
    f->geometryShader = VK_FALSE;       /* WebGPU has no geometry stage */
    f->tessellationShader = VK_FALSE;
    f->fragmentStoresAndAtomics = VK_TRUE;
    f->vertexPipelineStoresAndAtomics = VK_TRUE;
}

// ---------------------------------------------------------------------------
// Features2 / Properties2 pNext walkers (audit P2-NOW items 1-2).
//
// DXVK does not call the core 1.0 getters when it wants to know what the device
// supports: it chains a VkPhysicalDeviceFeatures2 with ~15 feature structs and
// reads each VkBool32 back out of the SAME buffer it passed in. Before these
// walkers existed every chained struct stayed at whatever the guest left there
// (zero), so every required feature read "unsupported" even with the extension
// advertised. So the walkers are load-bearing, not decoration.
//
// Contract: unknown sTypes are SKIPPED, never rejected — a newer DXVK chaining a
// struct we do not model must still get a device. pNext sits at offset 8 in every
// VkStructureType-headed struct (sType u32 + 4 pad + ptr), which the generated
// header's static_asserts and probe_caps both pin.
// ---------------------------------------------------------------------------
// One arm of the Features2 walk: read the struct out of guest memory, let the
// fill function set the bits, write it back. The guest handed us this buffer, so
// writing it back is the only place an answer can go — and it is where DXVK
// reads it from.
#define SET_FEATURES(addr, fn, T)                                             \
    do {                                                                       \
        if ((addr) && g_mem) {                                                 \
            T f_ = {};                                                         \
            g_mem->memcpyFromGuest(&f_, (addr), sizeof(f_));                   \
            fn(f_);                                                            \
            g_mem->memcpyToGuest((addr), &f_, sizeof(f_));                     \
        }                                                                      \
    } while (0)
inline void fillRobustness2(VkPhysicalDeviceRobustness2FeaturesEXT& f) {
    f.robustBufferAccess2 = VK_TRUE;
    f.robustImageAccess2 = VK_TRUE;
    f.nullDescriptor = VK_TRUE;
}
inline void fillMaintenance5(VkPhysicalDeviceMaintenance5Features& f) {
        f.maintenance5 = VK_TRUE;
}
inline void fillMaintenance6(VkPhysicalDeviceMaintenance6Features& f) {
        f.maintenance6 = VK_TRUE;
}
inline void fillTransformFeedback(VkPhysicalDeviceTransformFeedbackFeaturesEXT& f) {
    f.transformFeedback = VK_TRUE;
    f.geometryStreams = VK_TRUE;
}
// vk64_guest.h (the trimmed Vulkan header this TU builds against) does not
// define VkPhysicalDeviceVertexAttributeDivisorFeaturesEXT or
// VkPhysicalDeviceVulkan13Properties. Local mirrors with the exact canonical
// layout (source/vulkan/vk/vulkan_core.h); static_asserts pin it.
struct Vk64VertexAttributeDivisorFeaturesEXT {
    VkStructureType sType;
    U64             pNext; // uint64_t, not void*: matches the 64-bit guest layout (cf. vk64_guest.h)
    VkBool32        vertexAttributeInstanceRateDivisor;
    VkBool32        vertexAttributeInstanceRateZeroDivisor;
};
struct Vk64Vulkan13Properties {
    VkStructureType sType;
    U64             pNext; // uint64_t, not void*: matches the 64-bit guest layout (cf. vk64_guest.h)
    U32 minSubgroupSize, maxSubgroupSize, maxComputeWorkgroupSubgroups;
    U32 requiredSubgroupSizeStages; // VkShaderStageFlags
    U32 maxInlineUniformBlockSize, maxPerStageDescriptorInlineUniformBlocks;
    U32 maxPerStageDescriptorUpdateAfterBindInlineUniformBlocks;
    U32 maxDescriptorSetInlineUniformBlocks;
    U32 maxDescriptorSetUpdateAfterBindInlineUniformBlocks;
    U32 maxInlineUniformTotalSize;
    VkBool32 integerDotProduct8BitUnsignedAccelerated;
    VkBool32 integerDotProduct8BitSignedAccelerated;
    VkBool32 integerDotProduct8BitMixedSignednessAccelerated;
    VkBool32 integerDotProduct4x8BitPackedUnsignedAccelerated;
    VkBool32 integerDotProduct4x8BitPackedSignedAccelerated;
    VkBool32 integerDotProduct4x8BitPackedMixedSignednessAccelerated;
    VkBool32 integerDotProduct16BitUnsignedAccelerated;
    VkBool32 integerDotProduct16BitSignedAccelerated;
    VkBool32 integerDotProduct16BitMixedSignednessAccelerated;
    VkBool32 integerDotProduct32BitUnsignedAccelerated;
    VkBool32 integerDotProduct32BitSignedAccelerated;
    VkBool32 integerDotProduct32BitMixedSignednessAccelerated;
    VkBool32 integerDotProduct64BitUnsignedAccelerated;
    VkBool32 integerDotProduct64BitSignedAccelerated;
    VkBool32 integerDotProduct64BitMixedSignednessAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating8BitUnsignedAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating8BitSignedAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating8BitMixedSignednessAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating4x8BitPackedUnsignedAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating4x8BitPackedSignedAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating4x8BitPackedMixedSignednessAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating16BitUnsignedAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating16BitSignedAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating16BitMixedSignednessAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating32BitUnsignedAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating32BitSignedAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating32BitMixedSignednessAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating64BitUnsignedAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating64BitSignedAccelerated;
    VkBool32 integerDotProductAccumulatingSaturating64BitMixedSignednessAccelerated;
    U64 storageTexelBufferOffsetAlignmentBytes;      // VkDeviceSize
    VkBool32 storageTexelBufferOffsetSingleTexelAlignment;
    U64 uniformTexelBufferOffsetAlignmentBytes;      // VkDeviceSize
    VkBool32 uniformTexelBufferOffsetSingleTexelAlignment;
    U64 maxBufferSize;                               // VkDeviceSize
};
static_assert(sizeof(Vk64VertexAttributeDivisorFeaturesEXT) == 24,
              "divisor features mirror layout");
static_assert(sizeof(Vk64Vulkan13Properties) == 216,
              "1.3 properties mirror layout");
// vkd3d-proton device-creation gate (device.c:2495): requires BOTH divisor
// features. Same advertisement-only caveat as g_dev_exts above.
inline void fillVertexAttributeDivisor(Vk64VertexAttributeDivisorFeaturesEXT& f) {
    f.vertexAttributeInstanceRateDivisor = VK_TRUE;
    f.vertexAttributeInstanceRateZeroDivisor = VK_TRUE;
}
inline void fillDescriptorIndexing(VkPhysicalDeviceDescriptorIndexingFeatures& f) {
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
}
inline void fillFloat16Int8(VkPhysicalDeviceShaderFloat16Int8Features& f) {
        f.shaderFloat16 = VK_TRUE;
    f.shaderInt8 = VK_TRUE;
}
inline void fillStorage16(VkPhysicalDevice16BitStorageFeatures& f) {
    f.storageBuffer16BitAccess = VK_TRUE;
    f.uniformAndStorageBuffer16BitAccess = VK_TRUE;
    f.storagePushConstant16 = VK_TRUE;
    f.storageInputOutput16 = VK_TRUE;
}
inline void fillStorage8(VkPhysicalDevice8BitStorageFeatures& f) {
    f.storageBuffer8BitAccess = VK_TRUE;
    f.uniformAndStorageBuffer8BitAccess = VK_TRUE;
    f.storagePushConstant8 = VK_TRUE;
}
inline void fillScalarBlockLayout(VkPhysicalDeviceScalarBlockLayoutFeatures& f) {
        f.scalarBlockLayout = VK_TRUE;
}
inline void fillDepthClipEnable(VkPhysicalDeviceDepthClipEnableFeaturesEXT& f) {
        f.depthClipEnable = VK_TRUE;
}
inline void fillVulkan12Features(VkPhysicalDeviceVulkan12Features& f) {
    // timelineSemaphore is emulated honestly under immediate execution (u64
    // counter per semaphore; a wait for a value the queue already ran past
    // returns SUCCESS, and a wait for a FUTURE value with timeout 0 returns
    // VK_TIMEOUT). bufferDeviceAddress stays FALSE until the P3 BDA audit proves
    // DXVK never consumes it: the benign tail returns an error CODE, and if DXVK
    // treated that as an address it would be catastrophic, not cosmetic.
    f.timelineSemaphore = VK_TRUE;
    f.bufferDeviceAddress = VK_FALSE;
    f.descriptorIndexing = VK_TRUE;
    f.shaderInputAttachmentArrayDynamicIndexing = VK_TRUE;
    f.shaderUniformTexelBufferArrayDynamicIndexing = VK_TRUE;
    f.shaderStorageTexelBufferArrayDynamicIndexing = VK_TRUE;
    f.shaderSampledImageArrayNonUniformIndexing = VK_TRUE;
    f.shaderUniformBufferArrayNonUniformIndexing = VK_TRUE;
    f.shaderStorageBufferArrayNonUniformIndexing = VK_TRUE;
    f.shaderStorageImageArrayNonUniformIndexing = VK_TRUE;
    f.descriptorBindingPartiallyBound = VK_TRUE;
    f.descriptorBindingUpdateUnusedWhilePending = VK_TRUE;
    f.runtimeDescriptorArray = VK_TRUE;
    f.samplerMirrorClampToEdge = VK_TRUE;   // vkd3d-proton hard gate (device.c:2636)
    // vkd3d-proton bindless hard gate (state.c:8352). Same advertisement-only
    // caveat as the divisor/push_descriptor entries: the clear/triangle probes
    // never exercise real bindless heaps; page-side support is follow-up.
    f.shaderStorageTexelBufferArrayNonUniformIndexing = VK_TRUE;
    f.shaderStorageImageArrayNonUniformIndexing = VK_TRUE;
    f.descriptorBindingVariableDescriptorCount = VK_TRUE;
}
inline void fillVulkan11Features(VkPhysicalDeviceVulkan11Features& f) {
    f.storageBuffer16BitAccess = VK_TRUE;
    f.uniformAndStorageBuffer16BitAccess = VK_TRUE;
    f.storagePushConstant16 = VK_TRUE;
    f.multiview = VK_TRUE;
    f.multiviewGeometryShader = VK_FALSE;
    f.multiviewTessellationShader = VK_FALSE;
    f.variablePointers = VK_TRUE;
    f.variablePointersStorageBuffer = VK_TRUE;
    f.shaderDrawParameters = VK_TRUE;       // vkd3d-proton hard gate (device.c:2658)
    f.protectedMemory = VK_FALSE;
}

void walkFeatures2(U64 pNextAddr) {
    for (U64 cur = pNextAddr; cur && g_mem;) {
        U32 sType = g_mem->readd(cur);
        switch (sType) {
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ROBUSTNESS_2_FEATURES_EXT:
                SET_FEATURES(cur, fillRobustness2, VkPhysicalDeviceRobustness2FeaturesEXT); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_5_FEATURES:
                SET_FEATURES(cur, fillMaintenance5, VkPhysicalDeviceMaintenance5Features); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_6_FEATURES:
                SET_FEATURES(cur, fillMaintenance6, VkPhysicalDeviceMaintenance6Features); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TRANSFORM_FEEDBACK_FEATURES_EXT:
                SET_FEATURES(cur, fillTransformFeedback, VkPhysicalDeviceTransformFeedbackFeaturesEXT); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VERTEX_ATTRIBUTE_DIVISOR_FEATURES_EXT:
                SET_FEATURES(cur, fillVertexAttributeDivisor, Vk64VertexAttributeDivisorFeaturesEXT); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DESCRIPTOR_INDEXING_FEATURES:
                SET_FEATURES(cur, fillDescriptorIndexing, VkPhysicalDeviceDescriptorIndexingFeatures); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_FLOAT16_INT8_FEATURES:
                SET_FEATURES(cur, fillFloat16Int8, VkPhysicalDeviceShaderFloat16Int8Features); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_16BIT_STORAGE_FEATURES:
                SET_FEATURES(cur, fillStorage16, VkPhysicalDevice16BitStorageFeatures); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_8BIT_STORAGE_FEATURES:
                SET_FEATURES(cur, fillStorage8, VkPhysicalDevice8BitStorageFeatures); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SCALAR_BLOCK_LAYOUT_FEATURES:
                SET_FEATURES(cur, fillScalarBlockLayout, VkPhysicalDeviceScalarBlockLayoutFeatures); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DEPTH_CLIP_ENABLE_FEATURES_EXT:
                SET_FEATURES(cur, fillDepthClipEnable, VkPhysicalDeviceDepthClipEnableFeaturesEXT); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES:
                SET_FEATURES(cur, fillVulkan12Features, VkPhysicalDeviceVulkan12Features); break;
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES:
                SET_FEATURES(cur, fillVulkan11Features, VkPhysicalDeviceVulkan11Features); break;
            default:
                klog_fmt("vk64: Features2 pNext sType=%u not modeled, left as the guest set it",
                         (unsigned)sType);
                break;
        }
        cur = g_mem->readq(cur + 8);      /* pNext is at offset 8 in every struct */
    }
}

// Properties2 side. Zeros degrade gracefully (a consumer clamps to them), EXCEPT
// the maxDescriptorSetUpdateAfterBind* limits: DXVK refuses descriptor-indexing
// layouts above them, so advertising the features above with a zero limit would
// make the device self-contradictory.
void walkProperties2(U64 pNextAddr) {
    // A stable, non-zero device UUID. DXVK's per-adapter matching (and D3DKMT's
    // driverID workarounds) key off this; a constant is fine because there is
    // exactly one adapter, and it is stable across runs.
    static const U8 uuid[VK_UUID_SIZE] = {
        0x56, 0x4B, 0x57, 0x47, 0x50, 0x55, 0x21, 0x01,   /* 'VKWGPU' + version */
        0x56, 0x4B, 0x57, 0x47, 0x50, 0x55, 0x21, 0x02,
    };
    for (U64 cur = pNextAddr; cur && g_mem;) {
        U32 sType = g_mem->readd(cur);
        switch (sType) {
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES: {
                VkPhysicalDeviceIDProperties p = {};
                g_mem->memcpyFromGuest(&p, cur, sizeof(p));
                memcpy(p.deviceUUID, uuid, VK_UUID_SIZE);
                p.deviceNodeMask = 1;
                g_mem->memcpyToGuest(cur, &p, sizeof(p));
                break;
            }
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_PROPERTIES: {
                VkPhysicalDeviceSubgroupProperties p = {};
                g_mem->memcpyFromGuest(&p, cur, sizeof(p));
                p.subgroupSize = 32;          /* warp-shaped, like every real ICD */
                p.supportedStages = 0xffffffffu;
                p.supportedOperations = 0xffffffffu;
                p.quadOperationsInAllStages = VK_TRUE;
                g_mem->memcpyToGuest(cur, &p, sizeof(p));
                break;
            }
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_5_PROPERTIES: {
                VkPhysicalDeviceMaintenance5Properties p = {};
                g_mem->memcpyFromGuest(&p, cur, sizeof(p));
                p.earlyFragmentMultisampleCoverageAfterSampleCounting = VK_TRUE;
                p.earlyFragmentSampleMaskTestBeforeSampleCounting = VK_TRUE;
                p.polygonModePointSize = VK_TRUE;
                g_mem->memcpyToGuest(cur, &p, sizeof(p));
                break;
            }
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DESCRIPTOR_INDEXING_PROPERTIES: {
                VkPhysicalDeviceDescriptorIndexingProperties p = {};
                g_mem->memcpyFromGuest(&p, cur, sizeof(p));
                p.maxUpdateAfterBindDescriptorsInAllPools = 1024;
                p.maxPerStageDescriptorUpdateAfterBindSamplers = 16;
                p.maxPerStageDescriptorUpdateAfterBindUniformBuffers = 16;
                /* vkd3d legacy bindless requires >= 1M (VKD3D_MIN_VIEW_DESCRIPTOR_COUNT);
                   same advertisement-only caveat as above */
                p.maxPerStageDescriptorUpdateAfterBindStorageBuffers = 1000000;
                p.maxPerStageDescriptorUpdateAfterBindSampledImages = 1000000;
                p.maxPerStageDescriptorUpdateAfterBindStorageImages = 1000000;
                p.maxPerStageDescriptorUpdateAfterBindInputAttachments = 4;
                p.maxPerStageUpdateAfterBindResources = 128;
                p.maxDescriptorSetUpdateAfterBindSamplers = 1024;
                p.maxDescriptorSetUpdateAfterBindUniformBuffers = 1024;
                p.maxDescriptorSetUpdateAfterBindUniformBuffersDynamic = 64;
                p.maxDescriptorSetUpdateAfterBindStorageBuffers = 1024;
                p.maxDescriptorSetUpdateAfterBindStorageBuffersDynamic = 64;
                p.maxDescriptorSetUpdateAfterBindSampledImages = 1024;
                p.maxDescriptorSetUpdateAfterBindStorageImages = 1024;
                p.maxDescriptorSetUpdateAfterBindInputAttachments = 16;
                g_mem->memcpyToGuest(cur, &p, sizeof(p));
                break;
            }
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ROBUSTNESS_2_PROPERTIES_EXT: {
                VkPhysicalDeviceRobustness2PropertiesEXT p = {};
                g_mem->memcpyFromGuest(&p, cur, sizeof(p));
                // MUST be non-zero: DXVK D3D9DeviceEx divides constant-layout
                // sizes by these alignments; zero => guest SIGFPE.
                p.robustStorageBufferAccessSizeAlignment = 4;
                p.robustUniformBufferAccessSizeAlignment = 4;
                g_mem->memcpyToGuest(cur, &p, sizeof(p));
                break;
            }
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TRANSFORM_FEEDBACK_PROPERTIES_EXT: {
                VkPhysicalDeviceTransformFeedbackPropertiesEXT p = {};
                g_mem->memcpyFromGuest(&p, cur, sizeof(p));
                p.maxTransformFeedbackStreams = 4;
                p.maxTransformFeedbackBuffers = 4;
                p.maxTransformFeedbackBufferSize = 1ull << 27;
                p.maxTransformFeedbackStreamDataSize = 4096;
                p.maxTransformFeedbackBufferDataSize = 4096;
                p.maxTransformFeedbackBufferDataStride = 256;
                p.transformFeedbackQueries = VK_TRUE;
                p.transformFeedbackStreamsLinesTriangles = VK_TRUE;
                p.transformFeedbackDraw = VK_TRUE;
                g_mem->memcpyToGuest(cur, &p, sizeof(p));
                break;
            }
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_PROPERTIES: {
                VkPhysicalDeviceVulkan11Properties p = {};
                g_mem->memcpyFromGuest(&p, cur, sizeof(p));
                memcpy(p.deviceUUID, uuid, VK_UUID_SIZE);
                p.deviceNodeMask = 1;
                p.subgroupSize = 32;
                p.subgroupSupportedStages = 0xffffffffu;
                p.subgroupSupportedOperations = 0xffffffffu;
                p.subgroupQuadOperationsInAllStages = VK_TRUE;
                p.pointClippingBehavior = VK_POINT_CLIPPING_BEHAVIOR_ALL_CLIP_PLANES;
                p.maxMultiviewViewCount = 6;
                p.maxMultiviewInstanceIndex = 0xFFFFFFFFu;
                p.maxPerSetDescriptors = 1024;
                p.maxMemoryAllocationSize = 2ull * 1024 * 1024 * 1024;
                g_mem->memcpyToGuest(cur, &p, sizeof(p));
                break;
            }
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_PROPERTIES: {
                Vk64Vulkan13Properties p = {};
                g_mem->memcpyFromGuest(&p, cur, sizeof(p));
                // vkd3d-proton single-texel-alignment gate (device.c:2520):
                // storageTexelBufferOffsetSingleTexelAlignment ||
                // storageTexelBufferOffsetAlignmentBytes == 1 (same for uniform).
                p.storageTexelBufferOffsetSingleTexelAlignment = VK_TRUE;
                p.uniformTexelBufferOffsetSingleTexelAlignment = VK_TRUE;
                g_mem->memcpyToGuest(cur, &p, sizeof(p));
                break;
            }
            case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_PROPERTIES: {
                VkPhysicalDeviceVulkan12Properties p = {};
                g_mem->memcpyFromGuest(&p, cur, sizeof(p));
                p.driverID = VK_DRIVER_ID_MESA_LLVMPIPE;
                p.driverName[0] = 'b';
                p.driverName[1] = 'o';
                p.driverName[2] = 'x';
                p.driverName[3] = 'e';
                p.driverName[4] = 'd';
                p.driverName[5] = 'w';
                p.driverName[6] = 'i';
                p.driverName[7] = 'n';
                p.driverName[8] = 'e';
                p.driverInfo[0] = 'v';
                p.driverInfo[1] = 'k';
                p.driverInfo[2] = '6';
                p.driverInfo[3] = '4';
                /* descriptor-indexing limits, mirroring the properties2 arm */
                p.maxUpdateAfterBindDescriptorsInAllPools = 1024;
                p.maxPerStageDescriptorUpdateAfterBindSamplers = 16;
                p.maxPerStageDescriptorUpdateAfterBindUniformBuffers = 16;
                /* vkd3d legacy bindless requires >= 1M (VKD3D_MIN_VIEW_DESCRIPTOR_COUNT);
                   same advertisement-only caveat as above */
                p.maxPerStageDescriptorUpdateAfterBindStorageBuffers = 1000000;
                p.maxPerStageDescriptorUpdateAfterBindSampledImages = 1000000;
                p.maxPerStageDescriptorUpdateAfterBindStorageImages = 1000000;
                p.maxPerStageDescriptorUpdateAfterBindInputAttachments = 4;
                p.maxPerStageUpdateAfterBindResources = 128;
                p.maxDescriptorSetUpdateAfterBindSamplers = 1024;
                p.maxDescriptorSetUpdateAfterBindUniformBuffers = 1024;
                p.maxDescriptorSetUpdateAfterBindUniformBuffersDynamic = 64;
                p.maxDescriptorSetUpdateAfterBindStorageBuffers = 1024;
                p.maxDescriptorSetUpdateAfterBindStorageBuffersDynamic = 64;
                p.maxDescriptorSetUpdateAfterBindSampledImages = 1024;
                p.maxDescriptorSetUpdateAfterBindStorageImages = 1024;
                p.maxDescriptorSetUpdateAfterBindInputAttachments = 16;
                p.maxTimelineSemaphoreValueDifference = 0xFFFFFFFFull;
                p.framebufferIntegerColorSampleCounts = VK_SAMPLE_COUNT_1_BIT;
                g_mem->memcpyToGuest(cur, &p, sizeof(p));
                break;
            }
            default:
                klog_fmt("vk64: Properties2 pNext sType=%u not modeled, left as the guest set it",
                         (unsigned)sType);
                break;
        }
        cur = g_mem->readq(cur + 8);
    }
}

void fillMemoryProperties(VkPhysicalDeviceMemoryProperties* p) {
    memset(p, 0, sizeof(*p));
    p->memoryHeapCount = 2;
    p->memoryHeaps[0].size = 2ull * 1024 * 1024 * 1024;
    p->memoryHeaps[0].flags = VK_MEMORY_HEAP_DEVICE_LOCAL_BIT;
    p->memoryHeaps[1].size = 4ull * 1024 * 1024 * 1024;
    p->memoryHeaps[1].flags = 0;
    p->memoryTypeCount = 4;
    for (U32 i = 0; i < 4; i++) {
        p->memoryTypes[i].heapIndex = i < 2 ? 0 : 1;
        p->memoryTypes[i].propertyFlags =
            (i == 0) ? (VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT | VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
                        VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)
                      : (i == 1 ? VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT
                                : (VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT));
    }
}

// Create a surface: there is no windowing system behind it (P1 section 1.4), so
// the handle is just an id. Both the xcb and the headless EXT path land here,
// which is what lets a guest run with no X server at all.
U64 createSurface() {
    U64 id = 0;
    createObj<Surface>(K_SURFACE, id);
    return id;
}

} // namespace

// ---------------------------------------------------------------------------
// Entry point from ksyscall64.
// ---------------------------------------------------------------------------
U64 vk64Bridge(CPU64* cpu, U64 fnId, U64 argsAddr) {
    std::lock_guard<std::recursive_mutex> lk(g_vkMutex);
    g_mem = cpu ? cpu->memory : nullptr;

    if (fnId == VK64_fn_witness) {
        // The guest shim's constructor. Proves the guest dlopen()ed THIS
        // libvulkan.so.1 (tasks/p1-final.md unknown #1) before any real call.
        klog("vk64: FIRST trap - guest libvulkan.so.1 mapped (witness fnId=0)");
        return 0;
    }
    if (fnId == VK64_fn_unimplemented) {
        // (name*) — the guest shim's benign stub for a vk* we do not implement.
        // This is the P1 loader_tally worklist, still recording what a real guest
        // actually asks for.
        VK64Args a0 = {};
        if (argsAddr && g_mem) g_mem->memcpyFromGuest(&a0, argsAddr, sizeof(a0));
        klog_fmt("vk64: asked-for (unimplemented): %s", guestStr(a0.a[0]).c_str());
        return (U64)(int64_t)VK_ERROR_FEATURE_NOT_PRESENT;
    }
    if (fnId == VK64_fn_traceProc) {
        VK64Args a0 = {};
        if (argsAddr && g_mem) g_mem->memcpyFromGuest(&a0, argsAddr, sizeof(a0));
        klog_fmt("vk64: gipa %s: %s", a0.a[1] ? "HIT " : "MISS", guestStr(a0.a[0]).c_str());
        return 0;
    }

    if (vkTrace()) { klog_fmt("vk64: trap %s", fnName(fnId)); g_tracedCalls++; }

    VK64Args args = {};
    if (argsAddr && g_mem) g_mem->memcpyFromGuest(&args, argsAddr, sizeof(args));

    switch (fnId) {
    // =====================================================================
    // B. Queries and state answers (25 of the 85)
    // =====================================================================
    case VK64_fn_vkEnumerateInstanceVersion:
        wr32(args.a[0], g_icd_api_version);
        return VK_SUCCESS;

    case VK64_fn_vkEnumerateInstanceExtensionProperties: {
        // (layerName*, pCount*, pProperties*)
        const U32 n = (U32)(sizeof(g_inst_exts) / sizeof(g_inst_exts[0]));
        if (!args.a[1]) return VK_ERROR_INITIALIZATION_FAILED;
        std::string layer = guestStr(args.a[0]);
        if (!layer.empty()) klog_fmt("vk64: layer '%s' requested; we have none", layer.c_str());
        if (!args.a[2]) { wr32(args.a[1], n); return VK_SUCCESS; }
        U32 want = rd32(args.a[1]);
        U32 c = want < n ? want : n;
        std::vector<VkExtensionProperties> props((size_t)(c ? c : 1));
        for (U32 i = 0; i < c; i++) {
            memset(&props[i], 0, sizeof(props[i]));
            strncpy(props[i].extensionName, g_inst_exts[i], VK_MAX_EXTENSION_NAME_SIZE - 1);
            props[i].specVersion = VK_API_VERSION_1_1;
        }
        writeArray(args.a[2], props, c);
        wr32(args.a[1], c);
        return c < n ? VK_INCOMPLETE : VK_SUCCESS;
    }
    case VK64_fn_vkEnumerateInstanceLayerProperties:
        if (!args.a[0]) return VK_ERROR_INITIALIZATION_FAILED;
        wr32(args.a[0], 0);
        return VK_SUCCESS;

    case VK64_fn_vkEnumeratePhysicalDevices: {
        // (instance, pCount*, pPhysDevs*)
        Instance* inst = objOf<Instance>(args.a[0], K_INSTANCE, "vkEnumeratePhysicalDevices");
        if (!inst || !args.a[1]) return VK_ERROR_INITIALIZATION_FAILED;
        U32 n = inst->physCount;
        if (!args.a[2]) { wr32(args.a[1], n); return VK_SUCCESS; }
        U32 want = rd32(args.a[1]);
        U32 c = want < n ? want : n;
        std::vector<U64> devs((size_t)(c ? c : 1));
        for (U32 i = 0; i < c; i++) devs[i] = inst->phys[i];
        writeArray(args.a[2], devs, c);
        wr32(args.a[1], c);
        return c < n ? VK_INCOMPLETE : VK_SUCCESS;
    }
    case VK64_fn_vkEnumerateDeviceExtensionProperties: {
        // (physDev, pLayerName*, out pCount*, out pProperties*)
        const U32 n = (U32)(sizeof(g_dev_exts) / sizeof(g_dev_exts[0]));
        if (!args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        std::string layer = guestStr(args.a[1]);
        if (!layer.empty()) klog_fmt("vk64: device layer '%s' requested; we have none", layer.c_str());
        if (!args.a[3]) { wr32(args.a[2], n); return VK_SUCCESS; }
        U32 want = rd32(args.a[2]);
        U32 c = want < n ? want : n;

        std::vector<VkExtensionProperties> props((size_t)(c ? c : 1));
        for (U32 i = 0; i < c; i++) {
            memset(&props[i], 0, sizeof(props[i]));
            strncpy(props[i].extensionName, g_dev_exts[i], VK_MAX_EXTENSION_NAME_SIZE - 1);
            props[i].specVersion = VK_API_VERSION_1_3;
        }
        writeArray(args.a[3], props, c);
        wr32(args.a[2], c);
        return c < n ? VK_INCOMPLETE : VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceProperties: {
        // (physDev, out VkPhysicalDeviceProperties)  [real limits, as P1]
        if (!objOf<PhysDev>(args.a[0], K_PHYSDEV, "vkGetPhysicalDeviceProperties") || !args.a[1])
            return VK_ERROR_INITIALIZATION_FAILED;
        VkPhysicalDeviceProperties p;
        fillProperties(&p);
        writeStruct(args.a[1], p);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceProperties2: {
        if (!objOf<PhysDev>(args.a[0], K_PHYSDEV, "vkGetPhysicalDeviceProperties2") || !args.a[1])
            return VK_ERROR_INITIALIZATION_FAILED;
        VkPhysicalDeviceProperties2 p2 = {};
        if (!readStruct(args.a[1], p2)) return VK_ERROR_INITIALIZATION_FAILED;
        fillProperties(&p2.properties);
        writeStruct(args.a[1], p2);
        // The chained structs are filled IN PLACE, after the root struct is
        // written: the guest passes one buffer for the root and the chain, and
        // reads the chain back out of it.
        walkProperties2(p2.pNext);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceFeatures: {
        if (!args.a[1]) return VK_ERROR_INITIALIZATION_FAILED;
        VkPhysicalDeviceFeatures f = {};
        fillCoreFeatures(&f);
        writeStruct(args.a[1], f);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceFeatures2: {
        VkPhysicalDeviceFeatures2 f2 = {};
        if (!readStruct(args.a[1], f2)) return VK_ERROR_INITIALIZATION_FAILED;
        fillCoreFeatures(&f2.features);
        writeStruct(args.a[1], f2);
        walkFeatures2(f2.pNext);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceMemoryProperties: {
        if (!args.a[1]) return VK_ERROR_INITIALIZATION_FAILED;
        VkPhysicalDeviceMemoryProperties p;
        fillMemoryProperties(&p);
        writeStruct(args.a[1], p);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceMemoryProperties2: {
        VkPhysicalDeviceMemoryProperties2 p2 = {};
        if (!readStruct(args.a[1], p2)) return VK_ERROR_INITIALIZATION_FAILED;
        fillMemoryProperties(&p2.memoryProperties);
        writeStruct(args.a[1], p2);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceQueueFamilyProperties:
    case VK64_fn_vkGetPhysicalDeviceQueueFamilyProperties2: {
        bool v2 = (fnId == VK64_fn_vkGetPhysicalDeviceQueueFamilyProperties2);
        U64 countAddr = args.a[1], arrAddr = args.a[2];
        const U32 fams = 1;   /* one universal graphics+compute+transfer family */
        if (!countAddr) return VK_ERROR_INITIALIZATION_FAILED;
        if (!arrAddr) { wr32(countAddr, fams); return VK_SUCCESS; }
        U32 want = rd32(countAddr);
        U32 c = want < fams ? want : fams;
        VkQueueFamilyProperties q = {};
        q.queueFlags = VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT | VK_QUEUE_TRANSFER_BIT;
        q.queueCount = 1;
        q.timestampValidBits = 64;
        q.minImageTransferGranularity = VkExtent3D{1, 1, 1};
        if (v2) {
            VkQueueFamilyProperties2 q2 = {};
            if (!readStruct(arrAddr, q2)) return VK_ERROR_INITIALIZATION_FAILED;
            q2.queueFamilyProperties = q;
            writeStruct(arrAddr, q2);
        } else {
            writeStruct(arrAddr, q);
        }
        wr32(countAddr, c);
        return c < fams ? VK_INCOMPLETE : VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceFormatProperties: {
        // (physDev, format, out VkFormatProperties)
        if (!args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        VkFormatProperties p = {};
        p.linearTilingFeatures = (VkFormatFeatureFlags)(VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT |
            VK_FORMAT_FEATURE_STORAGE_IMAGE_BIT | VK_FORMAT_FEATURE_TRANSFER_SRC_BIT |
            VK_FORMAT_FEATURE_TRANSFER_DST_BIT);
        p.optimalTilingFeatures = (VkFormatFeatureFlags)(p.linearTilingFeatures |
            VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BIT | VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT);
        p.bufferFeatures = (VkFormatFeatureFlags)(VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT |
            VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT | VK_FORMAT_FEATURE_VERTEX_BUFFER_BIT);
        writeStruct(args.a[2], p);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceFormatProperties2: {
        // (physDev, format, out VkFormatProperties2) + FormatProperties3 pNext.
        if (!args.a[2]) return 0;
        VkFormatProperties2 p2 = {};
        if (!readStruct(args.a[2], p2)) return 0;
        VkFormatFeatureFlags img = (VkFormatFeatureFlags)(
            VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT | VK_FORMAT_FEATURE_STORAGE_IMAGE_BIT |
            VK_FORMAT_FEATURE_TRANSFER_SRC_BIT | VK_FORMAT_FEATURE_TRANSFER_DST_BIT);
        p2.formatProperties.linearTilingFeatures = img;
        p2.formatProperties.optimalTilingFeatures = (VkFormatFeatureFlags)(img |
            VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BIT | VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT);
        p2.formatProperties.bufferFeatures = (VkFormatFeatureFlags)(
            VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT | VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT |
            VK_FORMAT_FEATURE_VERTEX_BUFFER_BIT);
        writeStruct(args.a[2], p2);
        for (U64 cur = p2.pNext; cur && g_mem;) {
            if (g_mem->readd(cur) == VK_STRUCTURE_TYPE_FORMAT_PROPERTIES_3) {
                VkFormatProperties3 p3 = {};
                g_mem->memcpyFromGuest(&p3, cur, sizeof(p3));
                // _2 flag values match v1 on the low bits; add color/depth targets.
                const VkFormatFeatureFlags2 img2 = (VkFormatFeatureFlags2)((U64)img | 0x3800ull);
                p3.linearTilingFeatures = img2;
                p3.optimalTilingFeatures = (VkFormatFeatureFlags2)((U64)img2 |
                    (U64)VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BIT | (U64)VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT);
                p3.bufferFeatures = (VkFormatFeatureFlags2)p2.formatProperties.bufferFeatures;
                g_mem->memcpyToGuest(cur, &p3, sizeof(p3));
            }
            cur = g_mem->readq(cur + 8);
        }
        return 0;
    }
    case VK64_fn_vkGetPhysicalDeviceImageFormatProperties: {
        // (physDev, format, type, tiling, usage, flags, out VkImageFormatProperties)
        if (!args.a[6]) return VK_ERROR_INITIALIZATION_FAILED;
        VkImageFormatProperties pr = {};
        fillImageFormatProps(&pr);
        writeStruct(args.a[6], pr);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceImageFormatProperties2: {
        // (physDev, pInfo2*, pProps2*)
        if (!args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        VkImageFormatProperties2 p2 = {};
        g_mem->memcpyFromGuest(&p2, args.a[2], sizeof(p2));
        VkPhysicalDeviceImageFormatInfo2 info = {};
        g_mem->memcpyFromGuest(&info, args.a[1], sizeof(info));
        fillImageFormatProps(&p2.imageFormatProperties);
        g_mem->memcpyToGuest(args.a[2], &p2, sizeof(p2));
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceSurfaceCapabilitiesKHR: {
        if (!args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        VkSurfaceCapabilitiesKHR c = {};
        c.minImageCount = 1; c.maxImageCount = 3;
        /* currentExtent undefined => the app's --width/--height are honoured */
        c.currentExtent = VkExtent2D{0xFFFFFFFFu, 0xFFFFFFFFu};
        c.minImageExtent = VkExtent2D{1, 1};
        c.maxImageExtent = VkExtent2D{16384, 16384};
        c.maxImageArrayLayers = 1;
        c.supportedTransforms = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR;
        c.currentTransform = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR;
        c.supportedCompositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
        c.supportedUsageFlags = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
        writeStruct(args.a[2], c);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceSurfaceFormatsKHR: {
        if (!args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        const VkSurfaceFormatKHR f = { VK_FORMAT_B8G8R8A8_UNORM, VK_COLOR_SPACE_SRGB_NONLINEAR_KHR };
        if (!args.a[3]) { wr32(args.a[2], 1); return VK_SUCCESS; }
        if (rd32(args.a[2]) < 1) { wr32(args.a[2], 1); return VK_INCOMPLETE; }
        writeStruct(args.a[3], f);
        wr32(args.a[2], 1);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceSurfacePresentModesKHR: {
        if (!args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        if (!args.a[3]) { wr32(args.a[2], 1); return VK_SUCCESS; }
        if (rd32(args.a[2]) < 1) { wr32(args.a[2], 1); return VK_INCOMPLETE; }
        wr32(args.a[3], VK_PRESENT_MODE_FIFO_KHR);
        wr32(args.a[2], 1);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPhysicalDeviceSurfaceSupportKHR:
        wr32(args.a[3], VK_TRUE);
        return VK_SUCCESS;
    case VK64_fn_vkGetPhysicalDeviceXlibPresentationSupportKHR:
        // (physDev, qFam, dpy*, visual) -> VkBool32 in RAX. winex11's
        // wine_vk_init dlsym()s this (LOAD_FUNCPTR, hard fail) and X11DRV
        // calls it per device when picking a presentable one. TRUE: the page
        // tier presents every frame through the canvas; there is no
        // non-presentable device behind this shim.
        return VK_TRUE;

    case VK64_fn_vkGetDeviceQueue: {
        // (device, family, index, out VkQueue*)
        Device* dev = objOf<Device>(args.a[0], K_DEVICE, "vkGetDeviceQueue");
        if (!dev || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        wr64(args.a[3], dev->queue);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetBufferMemoryRequirements: {
        Buffer* b = objOf<Buffer>(args.a[1], K_BUFFER, "vkGetBufferMemoryRequirements");
        if (!b || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        VkMemoryRequirements r = {};
        r.size = b->size ? ((b->size + 255) & ~(U64)255) : 0;
        r.alignment = 256;
        r.memoryTypeBits = 0xF;
        writeStruct(args.a[2], r);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetBufferMemoryRequirements2: {
        // (dev, VkBufferMemoryRequirementsInfo2*, VkMemoryRequirements2*)
        if (!args.a[1] || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        VkBufferMemoryRequirementsInfo2 in2 = {};
        g_mem->memcpyFromGuest(&in2, args.a[1], sizeof(in2));
        Buffer* b = objOf<Buffer>((U64)in2.buffer, K_BUFFER, "vkGetBufferMemoryRequirements2");
        // G2: DXVK may query requirements for buffers created outside our
        // bridge (e.g., via winevulkan paths that bypass our vkCreateBuffer).
        // Return sensible defaults rather than failing, so the allocator
        // can proceed. The size is advisory; DXVK validates it.
        U64 bufSize = (b && b->size) ? b->size : 65536;
        VkMemoryRequirements2 out2 = {};
        g_mem->memcpyFromGuest(&out2, args.a[2], sizeof(out2));
        out2.memoryRequirements.size = (bufSize + 255) & ~(U64)255;
        out2.memoryRequirements.alignment = 256;
        out2.memoryRequirements.memoryTypeBits = 0xF;
        g_mem->memcpyToGuest(args.a[2], &out2, sizeof(out2));
        // Fill chained VkMemoryDedicatedRequirements in place.
        U64 pn = out2.pNext;
        while (pn) {
            U32 st = 0;
            g_mem->memcpyFromGuest(&st, pn, sizeof(st));
            if (st == VK_STRUCTURE_TYPE_MEMORY_DEDICATED_REQUIREMENTS) {
                VkMemoryDedicatedRequirements dr = {};
                g_mem->memcpyFromGuest(&dr, pn, sizeof(dr));
                dr.prefersDedicatedAllocation = 0;
                dr.requiresDedicatedAllocation = 0;
                g_mem->memcpyToGuest(pn, &dr, sizeof(dr));
                break;
            }
            U64 nxt = 0;
            g_mem->memcpyFromGuest(&nxt, pn + 8, sizeof(nxt));
            pn = nxt;
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetDeviceBufferMemoryRequirements: {
        // (dev, VkDeviceBufferMemoryRequirements*, VkMemoryRequirements2*)
        // Core in Vulkan 1.3 (maintenance4); DXVK uses this instead of
        // creating a temp buffer when available.
        if (!args.a[1] || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        VkDeviceBufferMemoryRequirements devInfo = {};
        g_mem->memcpyFromGuest(&devInfo, args.a[1], sizeof(devInfo));
        U64 createInfoSize = 0;
        if (devInfo.pCreateInfo) {
            VkBufferCreateInfo ci = {};
            g_mem->memcpyFromGuest(&ci, devInfo.pCreateInfo, sizeof(ci));
            createInfoSize = ci.size;
        }
        VkMemoryRequirements2 out2 = {};
        g_mem->memcpyFromGuest(&out2, args.a[2], sizeof(out2));
        out2.memoryRequirements.size = createInfoSize ? ((createInfoSize + 255) & ~(U64)255) : 256;
        out2.memoryRequirements.alignment = 256;
        out2.memoryRequirements.memoryTypeBits = 0xF;
        g_mem->memcpyToGuest(args.a[2], &out2, sizeof(out2));
        U64 pn = out2.pNext;
        while (pn) {
            U32 st = 0;
            g_mem->memcpyFromGuest(&st, pn, sizeof(st));
            if (st == VK_STRUCTURE_TYPE_MEMORY_DEDICATED_REQUIREMENTS) {
                VkMemoryDedicatedRequirements dr = {};
                g_mem->memcpyFromGuest(&dr, pn, sizeof(dr));
                dr.prefersDedicatedAllocation = 0;
                dr.requiresDedicatedAllocation = 0;
                g_mem->memcpyToGuest(pn, &dr, sizeof(dr));
                break;
            }
            U64 nxt = 0;
            g_mem->memcpyFromGuest(&nxt, pn + 8, sizeof(nxt));
            pn = nxt;
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetImageMemoryRequirements: {
        Image* im = objOf<Image>(args.a[1], K_IMAGE, "vkGetImageMemoryRequirements");
        if (!im || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        U64 px = (U64)im->w * im->h * (im->d ? im->d : 1) * (im->layers ? im->layers : 1) * fmt_bpp(im->format);
        VkMemoryRequirements r = {};
        r.size = (px + 255) & ~(U64)255;
        r.alignment = 256;
        r.memoryTypeBits = 0xF;
        writeStruct(args.a[2], r);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetImageMemoryRequirements2: {
        // (dev, VkImageMemoryRequirementsInfo2*, VkMemoryRequirements2*)
        if (!args.a[1] || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        VkImageMemoryRequirementsInfo2 in2 = {};
        g_mem->memcpyFromGuest(&in2, args.a[1], sizeof(in2));
        Image* im = objOf<Image>((U64)in2.image, K_IMAGE, "vkGetImageMemoryRequirements2");
        if (!im) return VK_ERROR_INITIALIZATION_FAILED;
        VkMemoryRequirements2 out2 = {};
        g_mem->memcpyFromGuest(&out2, args.a[2], sizeof(out2));
        U64 px = (U64)im->w * im->h * (im->d ? im->d : 1) * (im->layers ? im->layers : 1) * fmt_bpp(im->format);
        out2.memoryRequirements.size = (px + 255) & ~(U64)255;
        out2.memoryRequirements.alignment = 256;
        out2.memoryRequirements.memoryTypeBits = 0xF;
        g_mem->memcpyToGuest(args.a[2], &out2, sizeof(out2));
        // Fill chained VkMemoryDedicatedRequirements in place (guest buffer).
        U64 pn = out2.pNext;
        while (pn) {
            U32 st = 0;
            g_mem->memcpyFromGuest(&st, pn, sizeof(st));
            if (st == VK_STRUCTURE_TYPE_MEMORY_DEDICATED_REQUIREMENTS) {
                VkMemoryDedicatedRequirements dr = {};
                g_mem->memcpyFromGuest(&dr, pn, sizeof(dr));
                dr.prefersDedicatedAllocation = 0;
                dr.requiresDedicatedAllocation = 0;
                g_mem->memcpyToGuest(pn, &dr, sizeof(dr));
                break;
            }
            U64 nxt = 0;
            g_mem->memcpyFromGuest(&nxt, pn + 8, sizeof(nxt));
            pn = nxt;
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetImageSubresourceLayout: {
        // Must report the GUEST address: the guest then addresses the mapped
        // range directly and its stores land in the page buffers, so the copy
        // happens later, once, where the GPU needs the pixels
        // (tasks/p1-final.md section 2.4).
        Image* im = objOf<Image>(args.a[1], K_IMAGE, "vkGetImageSubresourceLayout");
        if (!im || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        DeviceMemory* m = im->mem ? objOf<DeviceMemory>(im->mem, K_MEMORY, "vkGetImageSubresourceLayout") : nullptr;
        U32 bpp = fmt_bpp(im->format);
        VkSubresourceLayout l = {};
        l.offset = m ? (m->va + im->memOff) : 0;      /* VkDeviceSize: GUEST VA */
        l.size = (size_t)im->w * im->h * bpp;
        l.rowPitch = (size_t)im->w * bpp;
        l.arrayPitch = l.size;
        l.depthPitch = l.size;
        writeStruct(args.a[3], l);
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetSwapchainImagesKHR: {
        Swapchain* sc = objOf<Swapchain>(args.a[1], K_SWAPCHAIN, "vkGetSwapchainImagesKHR");
        if (!sc || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        if (!args.a[3]) { wr32(args.a[2], sc->nimg); return VK_SUCCESS; }
        U32 want = rd32(args.a[2]);
        U32 c = want < sc->nimg ? want : sc->nimg;
        std::vector<U64> imgs((size_t)(c ? c : 1));
        for (U32 i = 0; i < c; i++) imgs[i] = sc->imgs[i];
        writeArray(args.a[3], imgs, c);
        wr32(args.a[2], c);
        return c < sc->nimg ? VK_INCOMPLETE : VK_SUCCESS;
    }
    case VK64_fn_vkAcquireNextImageKHR: {
        // (device, swapchain, timeout, sem, fence, out u32*)
        Swapchain* sc = objOf<Swapchain>(args.a[1], K_SWAPCHAIN, "vkAcquireNextImageKHR");
        if (!sc) return VK_ERROR_INITIALIZATION_FAILED;
        sc->cur = (sc->cur + 1) % (sc->nimg ? sc->nimg : 1);
        wr32(args.a[5], sc->cur);
        if (args.a[3]) { Semaphore* s = objOf<Semaphore>(args.a[3], K_SEMAPHORE, "vkAcquireNextImageKHR"); if (s) s->signalled = 1; }
        if (args.a[4]) { Fence* f = objOf<Fence>(args.a[4], K_FENCE, "vkAcquireNextImageKHR"); if (f) f->signalled = 1; }
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetPastPresentationTimingGOOGLE:
        if (args.a[2]) wr32(args.a[2], 0);   /* no timestamps */
        return VK_SUCCESS;

    case VK64_fn_vkResetFences: {
        U32 n = (U32)args.a[1];
        for (U32 i = 0; i < n; i++) {
            Fence* f = objOf<Fence>(rd64(args.a[2] + (U64)i * 8), K_FENCE, "vkResetFences");
            if (f) f->signalled = 0;
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkWaitForFences: {
        /* Everything executes synchronously at submit, so a fence is always
         * already signalled (P1 section 1.2 "Sync"). That is what keeps an app's
         * Present wait loop from spinning forever. */
        U32 n = (U32)args.a[1];
        for (U32 i = 0; i < n; i++) {
            Fence* f = objOf<Fence>(rd64(args.a[2] + (U64)i * 8), K_FENCE, "vkWaitForFences");
            if (f) f->signalled = 1;
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetFenceStatus: {
        Fence* f = objOf<Fence>(args.a[1], K_FENCE, "vkGetFenceStatus");
        if (!f) return VK_ERROR_INITIALIZATION_FAILED;
        return f->signalled ? VK_SUCCESS : VK_NOT_READY;
    }
    case VK64_fn_vkDeviceWaitIdle:
    case VK64_fn_vkQueueWaitIdle:
        return VK_SUCCESS;

    case VK64_fn_vkResetCommandBuffer: {
        CmdBuf* cb = cbOf(args.a[0], "vkResetCommandBuffer");
        if (!cb) return VK_ERROR_INITIALIZATION_FAILED;
        resetCmdBuf(cb);
        return VK_SUCCESS;
    }
    case VK64_fn_vkResetCommandPool: {
        CmdPool* pool = objOf<CmdPool>(args.a[1], K_CMDPOOL, "vkResetCommandPool");
        if (!pool || pool->device != args.a[0]) return VK_ERROR_INITIALIZATION_FAILED;
        // Pools are independently reset by DXVK worker threads. Resetting every
        // CmdBuf erased draws still awaiting submission in a different pool.
        for (auto& kv : g_objs)
            if (kv.second->kind == K_CMDBUF && ((CmdBuf*)kv.second)->pool == args.a[1])
                resetCmdBuf((CmdBuf*)kv.second);
        return VK_SUCCESS;
    }
    case VK64_fn_vkFreeCommandBuffers: {
        U32 n = (U32)args.a[2];
        CmdPool* pool = objOf<CmdPool>(args.a[1], K_CMDPOOL, "vkFreeCommandBuffers");
        if (!pool || pool->device != args.a[0]) return 0;
        for (U32 i = 0; i < n; i++) {
            U64 id = rd64(args.a[3] + (U64)i * 8);
            CmdBuf* cb = cbOf(id, "vkFreeCommandBuffers");
            if (cb && cb->pool == args.a[1]) dropObj(id);
        }
        return VK_SUCCESS;
    }

    // =====================================================================
    // C1. Creates (19 of the 85)
    // =====================================================================
    case VK64_fn_vkCreateInstance: {
        VkInstanceCreateInfo ci = {};
        if (!readStruct(args.a[0], ci) || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        // Lenient about extensions, exactly as P1 was: an unknown instance
        // extension is logged, not rejected, so a guest that asks for something
        // extra still gets an instance instead of an early exit.
        for (U32 i = 0; i < ci.enabledExtensionCount && ci.ppEnabledExtensionNames; i++)
            klog_fmt("vk64: vkCreateInstance: extension '%s'",
                     guestStr(rd64(ci.ppEnabledExtensionNames + (U64)i * 8)).c_str());
        VkApplicationInfo ai = {};
        readStruct(ci.pApplicationInfo, ai);
        U64 instId = 0;
        Instance* inst = createObj<Instance>(K_INSTANCE, instId);
        // One physical device per instance == one WebGPU adapter. It is owned by
        // the instance and torn down with it (P1 did the same).
        U64 pdId = 0;
        PhysDev* pd = createObj<PhysDev>(K_PHYSDEV, pdId);
        pd->instance = instId;
        inst->phys[0] = pdId;
        inst->physCount = 1;
        wr64(args.a[2], instId);
        klog_fmt("vk64: vkCreateInstance ok (apiVersion=%u, %u ext) instance=0x%llx",
                 (unsigned)ai.apiVersion, (unsigned)ci.enabledExtensionCount,
                 (unsigned long long)instId);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateDevice: {
        // (physDev, pCreateInfo*, pAllocator, out VkDevice*)
        VkDeviceCreateInfo ci = {};
        PhysDev* pd = objOf<PhysDev>(args.a[0], K_PHYSDEV, "vkCreateDevice");
        if (!pd || !readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        if (!ci.queueCreateInfoCount) return VK_ERROR_INITIALIZATION_FAILED;
        U64 devId = 0, qId = 0;
        Device* dev = createObj<Device>(K_DEVICE, devId);
        // Rule: queues are created by vkCreateDevice; the getter only fetches.
        Queue* q = createObj<Queue>(K_QUEUE, qId);
        dev->physDev = args.a[0];
        dev->queue = qId;
        q->device = devId;
        wr64(args.a[3], devId);
        klog_fmt("vk64: vkCreateDevice ok (%u queue families requested)", (unsigned)ci.queueCreateInfoCount);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateXcbSurfaceKHR:
    case VK64_fn_vkCreateXlibSurfaceKHR:
    case VK64_fn_vkCreateWin32SurfaceKHR:
    case VK64_fn_vkCreateHeadlessSurfaceEXT: {
        // (instance, pCreateInfo*, pAllocator, out VkSurfaceKHR*)
        //
        // Win32 is the arm a DXVK-on-wine guest actually needs: d3d11.dll reaches
        // vulkan-1.dll, winevulkan calls dlopen("libvulkan.so.1") — which is us —
        // and then creates a WIN32 surface for the window winevulkan owns. Without
        // this arm there is no swapchain, period (audit §d).
        //
        // As with xcb and headless, the create-info is NOT read: the in-tree
        // vk/ headers carry no platform-surface declarations at all (no
        // VkWin32SurfaceCreateInfoKHR to widen), and there is no windowing system
        // behind the handle anyway — the id is the whole surface. Nothing needs
        // hwnd/pNext, and skipping the read is also what keeps the shim free of a
        // platform header.
        if (!objOf<Instance>(args.a[0], K_INSTANCE, "vkCreateSurfaceKHR") || !args.a[3])
            return VK_ERROR_INITIALIZATION_FAILED;
        wr64(args.a[3], createSurface());
        klog_fmt("vk64: %s -> surface id minted", fnName(fnId));
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateSwapchainKHR: {
        VkSwapchainCreateInfoKHR ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        U64 scId = 0;
        Swapchain* sc = createObj<Swapchain>(K_SWAPCHAIN, scId);
        sc->w = ci.imageExtent.width;
        sc->h = ci.imageExtent.height;
        sc->format = ci.imageFormat;
        sc->nimg = ci.minImageCount < 2 ? 2 : (ci.minImageCount > 8 ? 8 : ci.minImageCount);
        sc->cur = 0;
        for (U32 i = 0; i < sc->nimg; i++) {
            U64 imId = 0;
            Image* im = createObj<Image>(K_IMAGE, imId);
            im->w = sc->w; im->h = sc->h; im->d = 1; im->layers = 1; im->mips = 1;
            im->format = sc->format; im->tiling = VK_IMAGE_TILING_OPTIMAL;
            im->usage = ci.imageUsage; im->samples = 1;
            sc->imgs[i] = imId;
        }
        wr64(args.a[3], scId);
        klog_fmt("vk64: vkCreateSwapchainKHR %ux%u fmt=%u nimg=%u", sc->w, sc->h, sc->format, sc->nimg);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateCommandPool: {
        VkCommandPoolCreateInfo ci = {};
        if (!objOf<Device>(args.a[0], K_DEVICE, "vkCreateCommandPool") || !readStruct(args.a[1], ci) || !args.a[3])
            return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        CmdPool* p = createObj<CmdPool>(K_CMDPOOL, id);
        p->device = args.a[0];
        p->queueFamily = ci.queueFamilyIndex;
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateBuffer: {
        VkBufferCreateInfo ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        if (!ci.size) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        Buffer* b = createObj<Buffer>(K_BUFFER, id);
        b->size = ci.size;
        b->usage = ci.usage;
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateImage: {
        VkImageCreateInfo ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        Image* im = createObj<Image>(K_IMAGE, id);
        im->w = ci.extent.width; im->h = ci.extent.height; im->d = ci.extent.depth;
        im->layers = ci.arrayLayers ? ci.arrayLayers : 1;
        im->mips = ci.mipLevels ? ci.mipLevels : 1;
        im->format = ci.format; im->tiling = ci.tiling; im->usage = ci.usage;
        im->samples = ci.samples;
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateImageView: {
        VkImageViewCreateInfo ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        Image* src = objOf<Image>(ci.image, K_IMAGE, "vkCreateImageView");
        if (!src) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        ImageView* v = createObj<ImageView>(K_IMAGEVIEW, id);
        v->image = ci.image;
        v->format = ci.format ? ci.format : src->format;
        v->aspect = ci.subresourceRange.aspectMask;
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateBufferView: {
        VkBufferViewCreateInfo ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        // Buffer may be from outside our bridge; don't fail if unknown.
        U64 id = 0;
        BufferView* v = createObj<BufferView>(K_BUFFERVIEW, id);
        v->buffer = ci.buffer;
        v->format = ci.format;
        v->offset = ci.offset;
        v->range = ci.range;
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateSampler: {
        VkSamplerCreateInfo ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        Sampler* s = createObj<Sampler>(K_SAMPLER, id);
        s->mag = ci.magFilter; s->min = ci.minFilter; s->mipmap = ci.mipmapMode;
        s->addrU = ci.addressModeU; s->addrV = ci.addressModeV; s->addrW = ci.addressModeW;
        s->maxAniso = ci.maxAnisotropy;
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateRenderPass: {
        VkRenderPassCreateInfo ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        RenderPass* rp = createObj<RenderPass>(K_RENDERPASS, id);
        rp->natt = ci.attachmentCount > VK64_MAX_ATTACH ? VK64_MAX_ATTACH : ci.attachmentCount;
        std::vector<VkAttachmentDescription> atts;
        readArray(ci.pAttachments, rp->natt, atts);
        for (U32 i = 0; i < atts.size(); i++) {
            rp->formats[i] = atts[i].format;
            rp->loadOps[i] = atts[i].loadOp;
            rp->storeOps[i] = atts[i].storeOp;
            rp->samples[i] = atts[i].samples;
        }
        if (atts.size() > 1) rp->depthFmt = atts[1].format;
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateFramebuffer: {
        VkFramebufferCreateInfo ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        Framebuffer* fb = createObj<Framebuffer>(K_FRAMEBUFFER, id);
        fb->rp = ci.renderPass;
        fb->natt = ci.attachmentCount > VK64_MAX_ATTACH ? VK64_MAX_ATTACH : ci.attachmentCount;
        std::vector<VkImageView> views;
        readArray(ci.pAttachments, fb->natt, views);
        for (U32 i = 0; i < views.size(); i++) fb->views[i] = views[i];
        fb->w = ci.width; fb->h = ci.height;
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateGraphicsPipelines: {
        // (device, cache, n, pCreateInfos*, pAllocator, out VkPipeline*)
        U32 n = (U32)args.a[2];
        if (!objOf<Device>(args.a[0], K_DEVICE, "vkCreateGraphicsPipelines") || !n || !args.a[3] || !args.a[5])
            return VK_ERROR_INITIALIZATION_FAILED;
        std::vector<VkGraphicsPipelineCreateInfo> cis;
        readArray(args.a[3], n, cis);
        for (U32 i = 0; i < n; i++) {
            const VkGraphicsPipelineCreateInfo& ci = cis[i];
            U64 id = 0;
            Pipeline* p = createObj<Pipeline>(K_PIPELINE, id);
            // Each pXxxState is a guest VA: read the sub-state structs out one
            // at a time (they are small and fixed).
            VkPipelineInputAssemblyStateCreateInfo ia = {};
            VkPipelineRasterizationStateCreateInfo rs = {};
            VkPipelineDepthStencilStateCreateInfo ds = {};
            VkPipelineColorBlendStateCreateInfo cbs = {};
            readStruct(ci.pInputAssemblyState, ia);
            readStruct(ci.pRasterizationState, rs);
            readStruct(ci.pDepthStencilState, ds);
            readStruct(ci.pColorBlendState, cbs);
            p->topology = ia.topology;
            p->cull = rs.cullMode;
            p->front = rs.frontFace;
            p->depthTest = ds.depthTestEnable;
            p->depthWrite = ds.depthWriteEnable;
            p->depthOp = ds.depthCompareOp;
            // pVertexInputState: binding + attribute descriptions. Recorded
            // because the consumer cannot infer any of it — the draw call carries
            // no format, no stride and no offset — and without it there is no
            // vertex layout to build and nothing rasterizes.
            VkPipelineVertexInputStateCreateInfo vi = {};
            if (readStruct(ci.pVertexInputState, vi)) {
                p->nvb = vi.vertexBindingDescriptionCount > VK64_MAX_VERT_BINDINGS
                             ? VK64_MAX_VERT_BINDINGS : vi.vertexBindingDescriptionCount;
                p->nva = vi.vertexAttributeDescriptionCount > VK64_MAX_VERT_ATTRIBS
                             ? VK64_MAX_VERT_ATTRIBS : vi.vertexAttributeDescriptionCount;
                std::vector<VkVertexInputBindingDescription> vbs;
                readArray(vi.pVertexBindingDescriptions, p->nvb, vbs);
                for (U32 b = 0; b < vbs.size(); b++) {
                    p->vbStride[b] = vbs[b].stride;
                    p->vbInputRate[b] = vbs[b].inputRate;
                }
                std::vector<VkVertexInputAttributeDescription> vas;
                readArray(vi.pVertexAttributeDescriptions, p->nva, vas);
                for (U32 a = 0; a < vas.size(); a++) {
                    p->vaLocation[a] = vas[a].location;
                    p->vaBinding[a] = vas[a].binding;
                    p->vaFormat[a] = vas[a].format;
                    p->vaOffset[a] = vas[a].offset;
                }
            }
            VkPipelineDynamicStateCreateInfo dynamic = {};
            if (readStruct(ci.pDynamicState, dynamic)) {
                std::vector<VkDynamicState> states;
                readArray(dynamic.pDynamicStates, dynamic.dynamicStateCount, states);
                for (auto state : states)
                    if (state == VK_DYNAMIC_STATE_VERTEX_INPUT_BINDING_STRIDE)
                        p->dynamicVertexStride = true;
            }
            std::vector<VkPipelineColorBlendAttachmentState> blends;
            readArray(cbs.pAttachments, cbs.attachmentCount ? 1 : 0, blends);
            p->blend = (!blends.empty() && blends[0].blendEnable) ? 1 : 0;
            std::vector<VkPipelineShaderStageCreateInfo> stages;
            readArray(ci.pStages, ci.stageCount, stages);
            for (const VkPipelineShaderStageCreateInfo& st : stages) {
                if (st.stage == VK_SHADER_STAGE_VERTEX_BIT) {
                    p->vs = st.module;
                    captureStageSpec(st.pSpecializationInfo, p->vsSpec);
                }
                if (st.stage == VK_SHADER_STAGE_FRAGMENT_BIT) {
                    p->fs = st.module;
                    captureStageSpec(st.pSpecializationInfo, p->fsSpec);
                }
            }
            p->layout = ci.layout;
            p->rp = ci.renderPass;
            wr64(args.a[5] + (U64)i * 8, id);
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateComputePipelines: {
        // (device, cache, n, pCreateInfos*, pAllocator, out VkPipeline*)
        // vkd3d-proton builds internal compute pipelines (clear-UAV ops) during
        // device creation; without this the benign stub returns -2 and
        // D3D12CreateDevice fails E_OUTOFMEMORY. Capture is minimal: the
        // compute shader module + layout, enough for the page tier to key on.
        U32 n = (U32)args.a[2];
        if (!objOf<Device>(args.a[0], K_DEVICE, "vkCreateComputePipelines") || !n || !args.a[3] || !args.a[5])
            return VK_ERROR_INITIALIZATION_FAILED;
        for (U32 i = 0; i < n; i++) {
            VkComputePipelineCreateInfo ci = {};
            g_mem->memcpyFromGuest(&ci, args.a[3] + (U64)i * sizeof(ci), sizeof(ci));
            U64 id = 0;
            Pipeline* pl = createObj<Pipeline>(K_PIPELINE, id);
            pl->cs = ci.stage.module;
            pl->layout = ci.layout;
            wr64(args.a[5] + (U64)i * 8, id);
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreatePipelineLayout: {
        VkPipelineLayoutCreateInfo ci = {};
        klog_fmt("vk64: vkCreatePipelineLayout trap reached (real wrapper, not benign)");
        if (!readStruct(args.a[1], ci) || !args.a[3]) {
            klog_fmt("vk64: vkCreatePipelineLayout FAILED: readOk=%d outNull=%d",
                     (int)(readStruct(args.a[1], ci)), (int)(!args.a[3]));
            return VK_ERROR_INITIALIZATION_FAILED;
        }
        U64 id = 0;
        PipelineLayout* l = createObj<PipelineLayout>(K_PIPELAYOUT, id);
        l->nsets = ci.setLayoutCount > VK64_MAX_SETS ? VK64_MAX_SETS : ci.setLayoutCount;
        for (U32 i = 0; i < l->nsets; i++) l->sets[i] = rd64(ci.pSetLayouts + (U64)i * 8);
        wr64(args.a[3], id);
        klog_fmt("vk64: vkCreatePipelineLayout OK: id=%llu nsets=%u", (unsigned long long)id, (unsigned)l->nsets);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateDescriptorSetLayout: {
        VkDescriptorSetLayoutCreateInfo ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        DescSetLayout* l = createObj<DescSetLayout>(K_SETLAYOUT, id);
        l->nbind = ci.bindingCount > VK64_MAX_BINDINGS ? VK64_MAX_BINDINGS : ci.bindingCount;
        std::vector<VkDescriptorSetLayoutBinding> binds;
        readArray(ci.pBindings, l->nbind, binds);
        for (U32 i = 0; i < binds.size(); i++) {
            l->binds[i].binding = binds[i].binding;
            l->binds[i].type = binds[i].descriptorType;
        }
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateDescriptorPool: {
        if (!objOf<Device>(args.a[0], K_DEVICE, "vkCreateDescriptorPool") || !args.a[3])
            return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        createObj<DescPool>(K_DESCPOOL, id);
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateShaderModule: {
        VkShaderModuleCreateInfo ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        if (!ci.codeSize || !ci.pCode) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        ShaderModule* m = createObj<ShaderModule>(K_SHADER, id);
        // One memcpyFromGuest of the SPIR-V words; dedupe by the same djb2 hash
        // P1 used for its .spv filenames, and KEEP the words (destroy is a
        // refcount drop — vkcube destroys both modules right after pipeline
        // creation, which is legal).
        m->code.resize((size_t)ci.codeSize);
        g_mem->memcpyFromGuest(m->code.data(), ci.pCode, ci.codeSize);
        m->hash = blob_hash(m->code.data(), m->code.size());
        wr64(args.a[3], id);
        klog_fmt("vk64: vkCreateShaderModule %llu bytes (hash %016llx)",
                 (unsigned long long)ci.codeSize, (unsigned long long)m->hash);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreatePipelineCache: {
        if (!objOf<Device>(args.a[0], K_DEVICE, "vkCreatePipelineCache") || !args.a[3])
            return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        createObj<PipelineCache>(K_PIPECACHE, id);
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateFence: {
        VkFenceCreateInfo ci = {};
        if (!readStruct(args.a[1], ci) || !args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        Fence* f = createObj<Fence>(K_FENCE, id);
        f->signalled = (ci.flags & VK_FENCE_CREATE_SIGNALED_BIT) ? 1 : 0;
        wr64(args.a[3], id);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateSemaphore: {
        VkSemaphoreCreateInfo ci = {};
        if (!objOf<Device>(args.a[0], K_DEVICE, "vkCreateSemaphore") ||
            !readStruct(args.a[1], ci) || !args.a[3])
            return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        Semaphore* s = createObj<Semaphore>(K_SEMAPHORE, id);
        // Timeline detection: VkSemaphoreTypeCreateInfo hangs off
        // VkSemaphoreCreateInfo::pNext, and the walker must not stop at the first
        // unknown sType (a guest may chain something else first).
        for (U64 cur = ci.pNext; cur && g_mem;) {
            if (g_mem->readd(cur) == VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO) {
                VkSemaphoreTypeCreateInfo ti = {};
                g_mem->memcpyFromGuest(&ti, cur, sizeof(ti));
                s->isTimeline = (ti.semaphoreType == VK_SEMAPHORE_TYPE_TIMELINE) ? 1 : 0;
                s->counter = ti.initialValue;
                break;
            }
            cur = g_mem->readq(cur + 8);
        }
        wr64(args.a[3], id);
        klog_fmt("vk64: vkCreateSemaphore%s%s",
                 s->isTimeline ? " (timeline" : "", s->isTimeline ? ")" : "");
        return VK_SUCCESS;
    }
    case VK64_fn_vkGetSemaphoreCounterValue: {
        // (device, semaphore, out u64*)
        Semaphore* s = objOf<Semaphore>(args.a[1], K_SEMAPHORE, "vkGetSemaphoreCounterValue");
        if (!s || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        wr64(args.a[2], s->counter);
        return VK_SUCCESS;
    }
    case VK64_fn_vkWaitSemaphores: {
        // (device, pWaitInfo*, timeout)
        VkSemaphoreWaitInfo wi = {};
        if (!readStruct(args.a[1], wi)) return VK_ERROR_INITIALIZATION_FAILED;
        for (U32 i = 0; i < wi.semaphoreCount; i++) {
            U64 semId = rd64(wi.pSemaphores + (U64)i * 8);
            U64 want  = rd64(wi.pValues + (U64)i * 8);
            Semaphore* s = objOf<Semaphore>(semId, K_SEMAPHORE, "vkWaitSemaphores");
            if (!s) return VK_ERROR_INITIALIZATION_FAILED;
            if (s->counter < want) {
                // A value the queue has not reached yet. timeout == 0 means
                // "don't block", and the spec answer there is VK_TIMEOUT, not a
                // lie; any other timeout blocks, and since execution is immediate
                // the value is as good as reached — bump it forward, monotonically.
                if (!args.a[2]) return VK_TIMEOUT;
                s->counter = want;
            }
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkSignalSemaphore: {
        // (device, pSignalInfo*)
        VkSemaphoreSignalInfo si = {};
        if (!readStruct(args.a[1], si)) return VK_ERROR_INITIALIZATION_FAILED;
        Semaphore* s = objOf<Semaphore>(si.semaphore, K_SEMAPHORE, "vkSignalSemaphore");
        if (!s) return VK_ERROR_INITIALIZATION_FAILED;
        if (si.value > s->counter) s->counter = si.value;   /* monotonic */
        return VK_SUCCESS;
    }

    // =====================================================================
    // C2. Allocation / binding / update / map (8 of the 85)
    // =====================================================================
    case VK64_fn_vkAllocateMemory: {
        VkMemoryAllocateInfo ai = {};
        if (!objOf<Device>(args.a[0], K_DEVICE, "vkAllocateMemory") || !readStruct(args.a[1], ai) || !args.a[3])
            return VK_ERROR_INITIALIZATION_FAILED;
        if (!ai.allocationSize) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        DeviceMemory* m = createObj<DeviceMemory>(K_MEMORY, id);
        m->size = ai.allocationSize;
        m->memIndex = ai.memoryTypeIndex;
        // GUEST memory, not host malloc: the guest's stores go through the
        // CPU64 store path into K64Page buffers and cannot write to a wasm-heap
        // address, so the only substrate a guest-visible map can use is the
        // kernel's own mapper (tasks/p1-final.md section 2.4).
        m->va = g_mem->mmapReserveAndMap(ai.allocationSize, K_PROT_READ | K_PROT_WRITE);
        wr64(args.a[3], id);
        klog_fmt("vk64: vkAllocateMemory %llu bytes -> guest va 0x%llx (type %u)",
                 (unsigned long long)m->size, (unsigned long long)m->va, (unsigned)m->memIndex);
        return VK_SUCCESS;
    }
    case VK64_fn_vkAllocateCommandBuffers: {
        VkCommandBufferAllocateInfo ai = {};
        if (!readStruct(args.a[1], ai) || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        CmdPool* pool = objOf<CmdPool>(ai.commandPool, K_CMDPOOL, "vkAllocateCommandBuffers");
        if (!pool || pool->device != args.a[0]) return VK_ERROR_INITIALIZATION_FAILED;
        for (U32 i = 0; i < ai.commandBufferCount; i++) {
            U64 id = 0;
            CmdBuf* cb = createObj<CmdBuf>(K_CMDBUF, id);
            cb->pool = ai.commandPool;
            wr64(args.a[2] + (U64)i * 8, id);
        }
        klog_fmt("vk64: vkAllocateCommandBuffers x%u", (unsigned)ai.commandBufferCount);
        return VK_SUCCESS;
    }
    case VK64_fn_vkAllocateDescriptorSets: {
        VkDescriptorSetAllocateInfo ai = {};
        if (!readStruct(args.a[1], ai) || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
        for (U32 i = 0; i < ai.descriptorSetCount; i++) {
            U64 id = 0;
            DescSet* s = createObj<DescSet>(K_SET, id);
            s->layout = rd64(ai.pSetLayouts + (U64)i * 8);
            wr64(args.a[2] + (U64)i * 8, id);
        }
        return VK_SUCCESS;
    }
    // VkBindBufferMemoryInfo / VkBindImageMemoryInfo share this x86-64 layout.
    struct VkBindMemInfo2 {
        U32 sType;
        U32 _pad0;
        U64 pNext;
        U64 handle;       // buffer or image
        U64 memory;
        U64 memoryOffset;
    };
    static_assert(sizeof(VkBindMemInfo2) == 40, "VkBind*MemoryInfo layout");

    case VK64_fn_vkBindBufferMemory: {
        Buffer* b = objOf<Buffer>(args.a[1], K_BUFFER, "vkBindBufferMemory");
        DeviceMemory* m = objOf<DeviceMemory>(args.a[2], K_MEMORY, "vkBindBufferMemory");
        if (!b || !m) return VK_ERROR_INITIALIZATION_FAILED;
        if (args.a[3] >= m->size) return VK_ERROR_INITIALIZATION_FAILED;
        b->mem = args.a[2];
        b->memOff = args.a[3];
        return VK_SUCCESS;
    }
    case VK64_fn_vkBindImageMemory: {
        Image* im = objOf<Image>(args.a[1], K_IMAGE, "vkBindImageMemory");
        DeviceMemory* m = objOf<DeviceMemory>(args.a[2], K_MEMORY, "vkBindImageMemory");
        if (!im || !m) return VK_ERROR_INITIALIZATION_FAILED;
        im->mem = args.a[2];
        im->memOff = args.a[3];
        im->pixBytes = (U64)im->w * im->h * (im->d ? im->d : 1) * (im->layers ? im->layers : 1) * fmt_bpp(im->format);
        return VK_SUCCESS;
    }
    case VK64_fn_vkBindBufferMemory2:
    case VK64_fn_vkBindBufferMemory2KHR: {
        // (device, bindInfoCount, pBindInfos*) — same record-only semantics as
        // vkBindBufferMemory; the host has no real Vulkan device to bind on.
        U32 n = (U32)args.a[1];
        std::vector<VkBindMemInfo2> infos;
        readArray(args.a[2], n, infos);
        for (const auto& info : infos) {
            Buffer* b = objOf<Buffer>(info.handle, K_BUFFER, "vkBindBufferMemory2");
            DeviceMemory* m = objOf<DeviceMemory>(info.memory, K_MEMORY, "vkBindBufferMemory2");
            if (!b || !m) return VK_ERROR_INITIALIZATION_FAILED;
            if (info.memoryOffset >= m->size) return VK_ERROR_INITIALIZATION_FAILED;
            b->mem = info.memory;
            b->memOff = info.memoryOffset;
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkBindImageMemory2:
    case VK64_fn_vkBindImageMemory2KHR: {
        // (device, bindInfoCount, pBindInfos*) — same record-only semantics as
        // vkBindImageMemory.
        U32 n = (U32)args.a[1];
        std::vector<VkBindMemInfo2> infos;
        readArray(args.a[2], n, infos);
        for (const auto& info : infos) {
            Image* im = objOf<Image>(info.handle, K_IMAGE, "vkBindImageMemory2");
            DeviceMemory* m = objOf<DeviceMemory>(info.memory, K_MEMORY, "vkBindImageMemory2");
            if (!im || !m) return VK_ERROR_INITIALIZATION_FAILED;
            im->mem = info.memory;
            im->memOff = info.memoryOffset;
            im->pixBytes = (U64)im->w * im->h * (im->d ? im->d : 1) * (im->layers ? im->layers : 1) * fmt_bpp(im->format);
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkUpdateDescriptorSets: {
        // (device, nWrite, pWrites*, nCopy, pCopies*)
        U32 nw = (U32)args.a[1];
        std::vector<VkWriteDescriptorSet> writes;
        readArray(args.a[2], nw, writes);
        for (U32 i = 0; i < nw; i++) {
            const VkWriteDescriptorSet& w = writes[i];
            DescSet* s = objOf<DescSet>(w.dstSet, K_SET, "vkUpdateDescriptorSets");
            if (!s || w.dstBinding >= VK64_MAX_BINDINGS) continue;
            Binding* b = nullptr;
            for (U32 k = 0; k < s->nbind; k++)
                if (s->binds[k].binding == w.dstBinding) { b = &s->binds[k]; break; }
            if (!b) {
                if (s->nbind >= VK64_MAX_BINDINGS) continue;
                b = &s->binds[s->nbind++];
                b->binding = w.dstBinding;
            }
            // Fidelity: the write's own descriptorType (not the set layout's) and
            // its ARRAY GEOMETRY. A DXVK caller writes descriptor arrays and
            // partial-overlap ranges (dstArrayElement/count), and collapsing those
            // to "element 0 of binding N" makes the recorded set a different set
            // from the one the app declared. The element payloads stay in the flat
            // Binding table for now (schema v2 is P3); index and count are honest
            // today so that table can grow without re-reading the guest.
            b->type = w.descriptorType;
            b->dstArrayElement = w.dstArrayElement;
            b->count = w.descriptorCount ? w.descriptorCount : 1;
            if (w.descriptorType == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER ||
                w.descriptorType == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER) {
                VkDescriptorBufferInfo bi = {};
                readStruct(w.pBufferInfo, bi);
                b->obj = bi.buffer;
                b->range = bi.range;
                b->bufOff = bi.offset;
            } else if (w.descriptorType == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK) {
                // Inline UBO: the bytes live in the write's pNext
                // (VkWriteDescriptorSetInlineUniformBlock), not in a buffer. Keep
                // the data pointer so the binding is not mistaken for a null one.
                for (U64 cur = w.pNext; cur && g_mem;) {
                    if (g_mem->readd(cur) == VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET_INLINE_UNIFORM_BLOCK) {
                        VkWriteDescriptorSetInlineUniformBlock ib = {};
                        g_mem->memcpyFromGuest(&ib, cur, sizeof(ib));
                        b->obj = ib.pData;
                        b->range = ib.dataSize;
                        break;
                    }
                    cur = g_mem->readq(cur + 8);
                }
            } else if (w.descriptorType == VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE ||
                       w.descriptorType == VK_DESCRIPTOR_TYPE_STORAGE_IMAGE ||
                       w.descriptorType == VK_DESCRIPTOR_TYPE_SAMPLER) {
                // image-only / sampler-only: keep the one handle each names, so a
                // storage image is not misreported as a sampled image
                VkDescriptorImageInfo ii = {};
                readStruct(w.pImageInfo, ii);
                b->obj = ii.imageView;
                b->range = ii.sampler;
            } else {
                // combined image sampler (and texel buffers, which share the
                // VkDescriptorBufferInfo shape)
                if (w.pBufferInfo) {
                    VkDescriptorBufferInfo bi = {};
                    readStruct(w.pBufferInfo, bi);
                    b->obj = bi.buffer;
                    b->range = bi.range;
                } else {
                    VkDescriptorImageInfo ii = {};
                    readStruct(w.pImageInfo, ii);
                    b->obj = ii.imageView;
                    b->range = ii.sampler;
                }
            }
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkCreateDescriptorUpdateTemplate: {
        // (device, pCreateInfo*, pAllocator, out VkDescriptorUpdateTemplate*)
        VkDescriptorUpdateTemplateCreateInfo ci = {};
        if (!readStruct(args.a[1], ci)) return VK_ERROR_INITIALIZATION_FAILED;
        if (!args.a[3]) return VK_ERROR_INITIALIZATION_FAILED;
        U64 id = 0;
        DescTemplate* t = createObj<DescTemplate>(K_TEMPLATE, id);
        std::vector<VkDescriptorUpdateTemplateEntry> entries;
        readArray(ci.pDescriptorUpdateEntries, ci.descriptorUpdateEntryCount, entries);
        for (auto& e : entries) {
            if (t->nentry >= VK64_MAX_BINDINGS) break;
            TmplEntry& te = t->entries[t->nentry++];
            te.binding = e.dstBinding; te.arrayElement = e.dstArrayElement;
            te.count = e.descriptorCount; te.type = e.descriptorType;
            te.offset = e.offset; te.stride = e.stride;
        }
        wr64(args.a[3], id);
        klog_fmt("vk64: vkCreateDescriptorUpdateTemplate -> 0x%llx (%u entries)",
                 (unsigned long long)id, (unsigned)t->nentry);
        return VK_SUCCESS;
    }
    case VK64_fn_vkDestroyDescriptorUpdateTemplate: {
        // (device, template, pAllocator)
        dropObj(args.a[1]);
        return VK_SUCCESS;
    }
    case VK64_fn_vkUpdateDescriptorSetWithTemplate: {
        // (device, descriptorSet, descriptorUpdateTemplate, pData)
        DescSet* s = objOf<DescSet>(args.a[1], K_SET, "vkUpdateDescriptorSetWithTemplate");
        DescTemplate* t = objOf<DescTemplate>(args.a[2], K_TEMPLATE, "vkUpdateDescriptorSetWithTemplate");
        if (!s || !t || !args.a[3]) return VK_SUCCESS;
        U64 dataBase = args.a[3];
        for (U32 ei = 0; ei < t->nentry; ei++) {
            const TmplEntry& te = t->entries[ei];
            for (U32 i = 0; i < te.count; i++) {
                U64 dAddr = dataBase + te.offset + (U64)i * te.stride;
                U32 binding = te.binding;
                U32 elem = te.arrayElement + i;
                if (binding >= VK64_MAX_BINDINGS) continue;
                Binding* b = nullptr;
                for (U32 k = 0; k < s->nbind; k++)
                    if (s->binds[k].binding == binding) { b = &s->binds[k]; break; }
                if (!b) {
                    if (s->nbind >= VK64_MAX_BINDINGS) continue;
                    b = &s->binds[s->nbind++];
                    b->binding = binding;
                }
                b->type = te.type;
                b->dstArrayElement = elem;
                b->count = 1;
                if (te.type == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER ||
                    te.type == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER) {
                    U64 buf = rd64(dAddr); U64 off = rd64(dAddr + 8); U64 range = rd64(dAddr + 16);
                    b->obj = buf; b->range = range; b->bufOff = off;
                } else if (te.type == VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE ||
                           te.type == VK_DESCRIPTOR_TYPE_STORAGE_IMAGE) {
                    U64 view = rd64(dAddr + 8);
                    b->obj = view; b->range = 0;
                } else if (te.type == VK_DESCRIPTOR_TYPE_SAMPLER) {
                    U64 samp = rd64(dAddr);
                    b->obj = samp; b->range = 0;
                } else if (te.type == VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER ||
                           te.type == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER) {
                    U64 bv = rd64(dAddr);
                    b->obj = bv; b->range = 0;
                }
            }
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkMapMemory: {
        // (device, memory, offset, size, flags, out void**) -> the GUEST VA, so
        // the guest addresses its own pages directly.
        DeviceMemory* m = objOf<DeviceMemory>(args.a[1], K_MEMORY, "vkMapMemory");
        if (!m || !args.a[5]) return VK_ERROR_MEMORY_MAP_FAILED;
        if (args.a[2] > m->size) return VK_ERROR_MEMORY_MAP_FAILED;
        wr64(args.a[5], m->va + args.a[2]);
        return VK_SUCCESS;
    }
    case VK64_fn_vkFlushMappedMemoryRanges:
    case VK64_fn_vkInvalidateMappedMemoryRanges: {
        // All exposed host-visible memory is coherent guest memory. A valid
        // flush/invalidate has no extra work, but must not mask invalid ranges.
        if (!objOf<Device>(args.a[0], K_DEVICE, "vkMappedMemoryRanges") ||
            (args.a[1] && !args.a[2])) return VK_ERROR_MEMORY_MAP_FAILED;
        std::vector<VkMappedMemoryRange> ranges;
        readArray(args.a[2], (U32)args.a[1], ranges);
        for (const auto& range : ranges) {
            DeviceMemory* mem = objOf<DeviceMemory>(range.memory, K_MEMORY, "vkMappedMemoryRanges");
            if (!mem || !mem->va || mem->memIndex == 1 || range.offset >= mem->size)
                return VK_ERROR_MEMORY_MAP_FAILED;
            if (range.size != VK_WHOLE_SIZE &&
                (!range.size || range.size > mem->size - range.offset))
                return VK_ERROR_MEMORY_MAP_FAILED;
        }
        return VK_SUCCESS;
    }
    case VK64_fn_vkUnmapMemory:
        return VK_SUCCESS;   /* nothing to release: it is ordinary guest memory */

    // =====================================================================
    // C3. Destroys (20 of the 85)
    // =====================================================================
    case VK64_fn_vkDestroyInstance: {
        Instance* inst = objOf<Instance>(args.a[0], K_INSTANCE, "vkDestroyInstance");
        if (inst) {
            for (U32 i = 0; i < inst->physCount; i++) dropObj(inst->phys[i]);
            dropObj(args.a[0]);
        }
        return 0;
    }
    case VK64_fn_vkDestroyDevice: {
        Device* dev = objOf<Device>(args.a[0], K_DEVICE, "vkDestroyDevice");
        if (dev) {
            U64 q = dev->queue;
            dropObj(args.a[0]);
            dropObj(q);
        }
        return 0;
    }
    case VK64_fn_vkDestroySurfaceKHR:      dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyCommandPool: {
        if (!args.a[1]) return 0;
        CmdPool* pool = objOf<CmdPool>(args.a[1], K_CMDPOOL, "vkDestroyCommandPool");
        if (!pool || pool->device != args.a[0]) return 0;
        // Collect first: dropObj erases the shared object map.
        std::vector<U64> children;
        for (const auto& kv : g_objs)
            if (kv.second->kind == K_CMDBUF && ((CmdBuf*)kv.second)->pool == args.a[1])
                children.push_back(kv.first);
        for (U64 id : children) dropObj(id);
        dropObj(args.a[1]);
        return 0;
    }
    case VK64_fn_vkDestroyBuffer:          dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyImage:           dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyImageView:       dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroySampler:         dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyRenderPass:      dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyFramebuffer:     dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyPipeline:        dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyPipelineLayout:  dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyDescriptorSetLayout: dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyDescriptorPool:  dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyPipelineCache:   dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyFence:           dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroySemaphore:       dropObj(args.a[1]); return 0;
    case VK64_fn_vkDestroyShaderModule: {
        // Retain the SPIR-V words: pipelines created from this module are still
        // live and vkcube destroys the module immediately after
        // vkCreateGraphicsPipelines (legal). This is the bounded, deliberate
        // leak P1 documented; the bytes stay reachable through the pipeline.
        ShaderModule* m = objOf<ShaderModule>(args.a[1], K_SHADER, "vkDestroyShaderModule");
        if (m) m->destroyed++;
        return 0;
    }
    case VK64_fn_vkDestroySwapchainKHR: {
        Swapchain* sc = objOf<Swapchain>(args.a[1], K_SWAPCHAIN, "vkDestroySwapchainKHR");
        if (sc) {
            for (U32 i = 0; i < sc->nimg; i++) dropObj(sc->imgs[i]);
            dropObj(args.a[1]);
        }
        return 0;
    }
    case VK64_fn_vkFreeMemory: {
        DeviceMemory* m = objOf<DeviceMemory>(args.a[1], K_MEMORY, "vkFreeMemory");
        if (m) {
            if (m->va) g_mem->munmap(m->va, m->size);
            dropObj(args.a[1]);
        }
        return 0;
    }

    // =====================================================================
    // D. Command recording (11 of the 85)
    // =====================================================================
    case VK64_fn_vkBeginCommandBuffer: {
        CmdBuf* cb = cbOf(args.a[0], "vkBeginCommandBuffer");
        if (!cb) return VK_ERROR_INITIALIZATION_FAILED;
        resetCmdBuf(cb);
        return VK_SUCCESS;
    }
    case VK64_fn_vkEndCommandBuffer: {
        CmdBuf* cb = cbOf(args.a[0], "vkEndCommandBuffer");
        if (vkTrace()) klog_fmt("vk64: vkEndCommandBuffer ncmd=%u", cb ? (unsigned)cb->cmds.size() : 0);
        return VK_SUCCESS;
    }
    case VK64_fn_vkCmdBeginRenderPass: {
        // (cmdBuf, pRenderPassBegin* (clear values!), contents)
        klog_fmt("vk64: BEGIN_RP_CALLED cb=0x%llx", (unsigned long long)args.a[0]);
        CmdBuf* cb = cbOf(args.a[0], "vkCmdBeginRenderPass");
        VkRenderPassBeginInfo bi = {};
        if (!cb || !readStruct(args.a[1], bi)) { klog("vk64: BEGIN_RP_FAILED"); return 0; }
        klog_fmt("vk64: BEGIN_RP fb=0x%llx", (unsigned long long)bi.framebuffer);
        Cmd c;
        c.kind = CMD_BEGIN_RP;
        c.a = bi.renderPass;
        c.b = bi.framebuffer;
        // pClearValues is a guest VA: colour first, then depth/stencil (P1 read
        // index 0 as colour and index 1 as depth).
        std::vector<VkClearValue> clears;
        readArray(bi.pClearValues, bi.clearValueCount ? (bi.clearValueCount > 2 ? 2 : bi.clearValueCount) : 0, clears);
        if (clears.size() > 0) {
            c.f[0] = clears[0].color.float32[0];
            c.f[1] = clears[0].color.float32[1];
            c.f[2] = clears[0].color.float32[2];
            c.f[3] = clears[0].color.float32[3];
        }
        if (clears.size() > 1) c.clearDepth = clears[1].depthStencil.depth;
        else c.clearDepth = 1.0;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdEndRenderPass: {
        CmdBuf* cb = cbOf(args.a[0], "vkCmdEndRenderPass");
        Cmd c;
        c.kind = CMD_END_RP;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdBeginRenderPass2:
    case VK64_fn_vkCmdBeginRenderPass2KHR: {
        // (cmdBuf, pRenderPassBegin*, pSubpassBeginInfo*) — v2 has extra dependency
        // info in pNext; the begin info itself is identical to v1.
        klog_fmt("vk64: BEGIN_RP2_CALLED cb=0x%llx", (unsigned long long)args.a[0]);
        CmdBuf* cb = cbOf(args.a[0], "vkCmdBeginRenderPass2");
        VkRenderPassBeginInfo bi = {};
        if (!cb || !readStruct(args.a[1], bi)) return 0;
        Cmd c;
        c.kind = CMD_BEGIN_RP;
        c.a = bi.renderPass;
        c.b = bi.framebuffer;
        std::vector<VkClearValue> clears;
        readArray(bi.pClearValues, bi.clearValueCount ? (bi.clearValueCount > 2 ? 2 : bi.clearValueCount) : 0, clears);
        if (clears.size() > 0) {
            c.f[0] = clears[0].color.float32[0];
            c.f[1] = clears[0].color.float32[1];
            c.f[2] = clears[0].color.float32[2];
            c.f[3] = clears[0].color.float32[3];
        }
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdEndRenderPass2:
    case VK64_fn_vkCmdEndRenderPass2KHR: {
        // (cmdBuf, pSubpassEndInfo*)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdEndRenderPass2");
        if (!cb) return 0;
        Cmd c;
        c.kind = CMD_END_RP;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdPipelineBarrier2:
    case VK64_fn_vkCmdPipelineBarrier2KHR: {
        // (cmdBuf, pDependencyInfo*) — v2 barrier. For our purposes, barriers
        // are no-ops (we execute synchronously), but we record the call so the
        // command buffer is not empty and DXVK's state tracking works.
        CmdBuf* cb = cbOf(args.a[0], "vkCmdPipelineBarrier2");
        if (!cb) return 0;
        Cmd c;
        c.kind = CMD_BARRIER;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdPushConstants2:
    case VK64_fn_vkCmdPushConstants2KHR: {
        // (cmdBuf, pPushConstantsInfo*) — VkPushConstantsInfo has layout,
        // stageFlags, offset, size, pValues. We extract and record like v1.
        CmdBuf* cb = cbOf(args.a[0], "vkCmdPushConstants2");
        if (!cb || !args.a[1]) return 0;
        // VkPushConstantsInfo: sType(0), pNext(8), layout(16), stageFlags(24),
        // offset(28), size(32), pValues(40)
        U64 layout = rd64(args.a[1] + 16);
        U32 stageFlags = rd32(args.a[1] + 24);
        U32 offset = rd32(args.a[1] + 28);
        U32 size = rd32(args.a[1] + 32);
        U64 pValues = rd64(args.a[1] + 40);
        Cmd c;
        c.kind = CMD_PUSH_CONST;
        c.a = layout;
        c.pcStageFlags = stageFlags;
        c.pcOffset = offset;
        c.pcSize = size > VK64_MAX_PUSH_BYTES ? VK64_MAX_PUSH_BYTES : size;
        if (pValues && c.pcSize) g_mem->memcpyFromGuest(c.pcBytes, pValues, c.pcSize);
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdBindIndexBuffer2:
    case VK64_fn_vkCmdBindIndexBuffer2KHR: {
        // (cmdBuf, buffer, offset, size, indexType) — v2 adds size param.
        // For our purposes, size is informational; we bind like v1.
        CmdBuf* cb = cbOf(args.a[0], "vkCmdBindIndexBuffer2");
        if (!cb) return 0;
        cb->ib = args.a[1];
        cb->ibOff = args.a[2];
        // args.a[3] is size (ignored), args.a[4] is indexType
        cb->ibType = (U32)args.a[4] == 1 ? 1 : 0;  // 1 = UINT32, 0 = UINT16
        Cmd c;
        c.kind = CMD_BIND_IB;
        c.a = cb->ib;
        c.b = cb->ibOff;
        c.c = cb->ibType;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdBeginRendering:
    case VK64_fn_vkCmdBeginRenderingKHR: {
        CmdBuf* cb = cbOf(args.a[0], "vkCmdBeginRendering");
        VkRenderingInfo ri = {};
        if (!cb || !readStruct(args.a[1], ri)) return 0;
        U64 rpId = 0, fbId = 0;
        auto* rp = createObj<RenderPass>(K_RENDERPASS, rpId);
        auto* fb = createObj<Framebuffer>(K_FRAMEBUFFER, fbId);
        cb->dynamicObjects.push_back(rpId);
        cb->dynamicObjects.push_back(fbId);
        fb->rp = rpId; fb->w = ri.renderAreaWidth; fb->h = ri.renderAreaHeight;
        Cmd c; c.kind = CMD_BEGIN_RP; c.a = rpId; c.b = fbId;
        auto attachment = [&](U64 address, bool depth) {
            VkRenderingAttachmentInfo att = {};
            if (!address || fb->natt >= VK64_MAX_ATTACH || !readStruct(address, att)) return;
            auto* view = objOf<ImageView>(att.imageView, K_IMAGEVIEW, "vkCmdBeginRendering");
            if (!view) return;
            auto* image = objOf<Image>(view->image, K_IMAGE, "vkCmdBeginRendering");
            U32 i = fb->natt++;
            fb->views[i] = att.imageView;
            rp->formats[i] = view->format ? view->format : (image ? image->format : 0);
            rp->loadOps[i] = att.loadOp; rp->storeOps[i] = att.storeOp;
            rp->samples[i] = image && image->samples ? image->samples : 1;
            if (depth) {
                float value; memcpy(&value, att.clearValue, 4); c.clearDepth = value;
                rp->depthFmt = rp->formats[i];
            } else if (i == 0) memcpy(c.f, att.clearValue, 16);
        };
        U32 colors = std::min(ri.colorAttachmentCount, (U32)VK64_MAX_ATTACH);
        for (U32 i = 0; i < colors && ri.pColorAttachments; ++i)
            attachment(ri.pColorAttachments + (U64)i * sizeof(VkRenderingAttachmentInfo), false);
        attachment(ri.pDepthAttachment, true);
        // Packed depth/stencil shares one image view and one replay attachment.
        if (!ri.pDepthAttachment) attachment(ri.pStencilAttachment, true);
        rp->natt = fb->natt;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdEndRendering:
    case VK64_fn_vkCmdEndRenderingKHR: {
        // (cmdBuf)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdEndRendering");
        if (!cb) return 0;
        Cmd c;
        c.kind = CMD_END_RP;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdBindPipeline: {
        // (cmdBuf, bindPoint, pipeline)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdBindPipeline");
        if (!cb) return 0;
        Cmd c;
        c.kind = CMD_BIND_PIPE;
        c.a = args.a[2];
        cb->pipe = args.a[2];
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdBindDescriptorSets: {
        // (cmdBuf, bindPoint, layout, firstSet, setCount, pSets*, nDyn, pDynOffsets*)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdBindDescriptorSets");
        if (!cb) return 0;
        U32 firstSet = (U32)args.a[3];
        U32 setCount = (U32)args.a[4];
        if (setCount > VK64_MAX_SETS) setCount = VK64_MAX_SETS;
        for (U32 i = 0; i < setCount; i++) {
            U64 set = rd64(args.a[5] + (U64)i * 8);
            if (firstSet + i < VK64_MAX_SETS) cb->sets[firstSet + i] = set;
        }
        Cmd c;
        c.kind = CMD_BIND_SETS;
        c.a = firstSet;
        c.b = setCount;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdSetViewport: {
        // (cmdBuf, first, count, pViewports*)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdSetViewport");
        std::vector<VkViewport> vps;
        readArray(args.a[3], (U32)args.a[2], vps);
        if (!cb || vps.empty()) return 0;
        Cmd c;
        c.kind = CMD_VIEWPORT;
        c.f[0] = vps[0].x; c.f[1] = vps[0].y; c.f[2] = vps[0].width; c.f[3] = vps[0].height;
        c.f[4] = vps[0].minDepth; c.f[5] = vps[0].maxDepth;
        memcpy(cb->vp, c.f, sizeof(cb->vp));
        cb->haveVp = true;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdSetScissor: {
        // (cmdBuf, first, count, pScissors*)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdSetScissor");
        std::vector<VkRect2D> scs;
        readArray(args.a[3], (U32)args.a[2], scs);
        if (!cb || scs.empty()) return 0;
        Cmd c;
        c.kind = CMD_SCISSOR;
        c.f[0] = (float)scs[0].offset.x; c.f[1] = (float)scs[0].offset.y;
        c.f[2] = (float)scs[0].extent.width; c.f[3] = (float)scs[0].extent.height;
        memcpy(cb->sci, c.f, sizeof(cb->sci));
        cb->haveSci = true;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdDraw: {
        // (cmdBuf, vertexCount, instanceCount, firstVertex, firstInstance)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdDraw");
        if (!cb) return 0;
        Cmd c;
        c.kind = CMD_DRAW;
        c.a = args.a[1];   // vertexCount
        c.b = args.a[2];   // instanceCount
        c.c = args.a[3];   // firstVertex
        c.d = args.a[4];   // firstInstance
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdBindVertexBuffers:
    case VK64_fn_vkCmdBindVertexBuffers2: {
        // (cmdBuf, firstBinding, bindingCount, pBuffers*, pOffsets*)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdBindVertexBuffers");
        if (!cb) return 0;
        U32 first = (U32)args.a[1], count = (U32)args.a[2];
        if (!args.a[3] || !args.a[4] || !count || first >= VK64_MAX_VERT_BINDINGS) return 0;
        if (first + count > VK64_MAX_VERT_BINDINGS) count = VK64_MAX_VERT_BINDINGS - first;
        for (U32 i = 0; i < count; i++) {
            cb->vbs[first + i] = rd64(args.a[3] + (U64)i * 8);
            cb->vbOff[first + i] = rd64(args.a[4] + (U64)i * 8);
            if (fnId == VK64_fn_vkCmdBindVertexBuffers2 && args.a[6]) {
                cb->vbStride[first + i] = (U32)rd64(args.a[6] + (U64)i * 8);
                cb->vbHasStride[first + i] = true;
            }
        }
        U32 end = first + count;
        if (end > cb->nvb) cb->nvb = end;
        Cmd c;
        c.kind = CMD_BIND_VB;
        c.a = first; c.b = count;
        c.vbCount = cb->nvb;
        memcpy(c.vbBuffers, cb->vbs, sizeof(c.vbBuffers));
        memcpy(c.vbOffsets, cb->vbOff, sizeof(c.vbOffsets));
        memcpy(c.vbStrides, cb->vbStride, sizeof(c.vbStrides));
        memcpy(c.vbHasStride, cb->vbHasStride, sizeof(c.vbHasStride));
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdBindIndexBuffer: {
        // (cmdBuf, buffer, offset, indexType)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdBindIndexBuffer");
        if (!cb) return 0;
        cb->ib = args.a[1]; cb->ibOff = args.a[2]; cb->ibType = (U32)args.a[3];
        Cmd c;
        c.kind = CMD_BIND_IB;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdDrawIndexed: {
        // (cmdBuf, indexCount, instanceCount, firstIndex, vertexOffset, firstInstance)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdDrawIndexed");
        if (!cb) return 0;
        Cmd c;
        c.kind = CMD_DRAW_INDEXED;
        c.a = args.a[1];   // indexCount
        c.b = args.a[2];   // instanceCount
        c.c = args.a[3];   // firstIndex
        c.diVertexOffset = (int32_t)(U32)args.a[4];
        c.copy.ox = (int32_t)args.a[4];  // vertexOffset (signed; rides the Copy spare for v2)
        c.d = args.a[5];   // firstInstance
        captureIndexedDraw(cb, c);
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdPushConstants: {
        /* (cmdBuf, layout, stageFlags, offset, size, pValues). DXVK pushes
         * constants per-draw for nearly everything, so this used to be a hard
         * stop: the call fell into the benign tail and the manifest carried no
         * per-draw constants at all. The bytes are copied out of guest memory now,
         * with the byte OFFSET kept, because a push is an overlay into a
         * push-constant range rather than a replacement of it. */
        CmdBuf* cb = cbOf(args.a[0], "vkCmdPushConstants");
        if (!cb) return 0;
        U32 off = (U32)args.a[3], size = (U32)args.a[4];
        if (!args.a[5] || !size) return 0;
        if (size > VK64_MAX_PUSH_BYTES) {
            klog_fmt("vk64: vkCmdPushConstants %u bytes truncated to %u (maxPushConstantsSize)",
                     (unsigned)size, (unsigned)VK64_MAX_PUSH_BYTES);
            size = VK64_MAX_PUSH_BYTES;
        }
        Cmd c;
        c.kind = CMD_PUSH_CONST;
        c.pcOffset = off;
        c.pcSize = size;
        c.pcStageFlags = (U32)args.a[2];
        g_mem->memcpyFromGuest(c.pcBytes, args.a[5], size);
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdUpdateBuffer: {
        /* (cmdBuf, dstBuffer, dstOffset, dataSize, pData). DXVK uploads
         * small uniforms with this -- notably the D3D9 fixed-function VS
         * constant buffer -- so this used to be a hard stop: the call fell
         * into the benign tail and the manifest carried zeros for every
         * uniform updated this way. The payload is copied out of guest
         * memory at record time and written back at submit (transfer
         * semantics), before serialization reads the buffer. */
        CmdBuf* cb = cbOf(args.a[0], "vkCmdUpdateBuffer");
        if (!cb) return 0;
        U64 size = args.a[3];
        if (!args.a[4] || !size) return 0;
        if (size > 65536) {
            klog_fmt("vk64: vkCmdUpdateBuffer %llu bytes truncated to 65536 (spec max)",
                     (unsigned long long)size);
            size = 65536;
        }
        Cmd c;
        c.kind = CMD_UPDATE_BUF;
        c.updBuf = args.a[1];
        c.updOff = args.a[2];
        c.updBytes.resize((size_t)size);
        g_mem->memcpyFromGuest(c.updBytes.data(), args.a[4], size);
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdPipelineBarrier: {
        /* WebGPU pass encoding makes colour/depth layout transitions implicit,
         * so the barrier is dropped — but an ordering marker is kept so submit
         * preserves relative order (P1 section 1.4). */
        CmdBuf* cb = cbOf(args.a[0], "vkCmdPipelineBarrier");
        Cmd c;
        c.kind = CMD_BARRIER;
        pushCmd(cb, c);
        return 0;
    }
    case VK64_fn_vkCmdCopyBufferToImage: {
        // (cmdBuf, srcBuffer, dstImage, layout, nRegions, pRegions*)
        CmdBuf* cb = cbOf(args.a[0], "vkCmdCopyBufferToImage");
        U32 nreg = (U32)args.a[4];
        std::vector<VkBufferImageCopy> regs;
        readArray(args.a[5], nreg, regs);
        if (!cb) return 0;
        for (U32 i = 0; i < regs.size(); i++) {
            Cmd c;
            c.kind = CMD_COPY_B2I;
            c.a = args.a[1]; c.b = args.a[2]; c.c = nreg;
            c.copy.srcBuffer = args.a[1];
            c.copy.dstImage = args.a[2];
            c.copy.bufOff = regs[i].bufferOffset;
            c.copy.rowLen = regs[i].bufferRowLength;
            c.copy.imgH = regs[i].bufferImageHeight;
            c.copy.ox = regs[i].imageOffset.x;
            c.copy.oy = regs[i].imageOffset.y;
            c.copy.w = regs[i].imageExtent.width;
            c.copy.h = regs[i].imageExtent.height;
            pushCmd(cb, c);
        }
        return 0;
    }

    // =====================================================================
    // E. Frame boundary (2 of the 85)
    // =====================================================================
    case VK64_fn_vkQueueSubmit: {
        // (queue, nSubmits, pSubmits*)
        U32 n = (U32)args.a[1];
        std::vector<VkSubmitInfo> sis;
        readArray(args.a[2], n, sis);
        std::vector<std::pair<CmdBuf*, U64>> frames;
        for (U32 i = 0; i < n; i++) {
            // VkTimelineSemaphoreSubmitInfo in pNext: the per-batch wait/signal
            // VALUES that make a u64 semaphore mean anything. DXVK writes one of
            // these on every flush (its tracking fence), so ignoring the chain
            // means the counter never moves and every later wait reads stale.
            for (U64 cur = sis[i].pNext; cur && g_mem;) {
                if (g_mem->readd(cur) == VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO) {
                    VkTimelineSemaphoreSubmitInfo ti = {};
                    g_mem->memcpyFromGuest(&ti, cur, sizeof(ti));
                    for (U32 w = 0; w < ti.waitSemaphoreValueCount; w++) {
                        U64 semId = rd64(sis[i].pWaitSemaphores + (U64)w * 8);
                        U64 want  = rd64(ti.pWaitSemaphoreValues + (U64)w * 8);
                        Semaphore* s = objOf<Semaphore>(semId, K_SEMAPHORE, "vkQueueSubmit");
                        if (s && s->counter < want) s->counter = want;
                    }
                    for (U32 sg = 0; sg < ti.signalSemaphoreValueCount; sg++) {
                        U64 semId = rd64(sis[i].pSignalSemaphores + (U64)sg * 8);
                        U64 val   = rd64(ti.pSignalSemaphoreValues + (U64)sg * 8);
                        Semaphore* s = objOf<Semaphore>(semId, K_SEMAPHORE, "vkQueueSubmit");
                        if (s && val > s->counter) s->counter = val;
                    }
                    break;
                }
                cur = g_mem->readq(cur + 8);
            }
            for (U32 c = 0; c < sis[i].commandBufferCount; c++) {
                U64 cbId = rd64(sis[i].pCommandBuffers + (U64)c * 8);
                CmdBuf* cb = cbOf(cbId, "vkQueueSubmit");
                if (!cb) continue;
                // Eager copy execution, against the guest memory both sides of
                // the copy live in (P1 ran these first at submit too).
                for (const Cmd& k : cb->cmds) if (k.kind == CMD_COPY_B2I) execCopy(k.copy);
                for (const Cmd& k : cb->cmds) if (k.kind == CMD_UPDATE_BUF) execUpdateBuf(k);
                frames.push_back({cb, cbId});
            }
        }
        if (vkTrace()) klog_fmt("vk64: vkQueueSubmit(%u batches, %u command buffers)", (unsigned)n, (unsigned)frames.size());
        bool hasWork = false;
        for (auto& fr : frames) if (fr.first && !fr.first->cmds.empty()) { hasWork = true; break; }
        // Fallback: DXVK sometimes records draws to CBs that are never
        // submitted (e.g., 70 draws to 3 CBs, but submits reference empty CBs).
        // Scan all CmdBufs for non-empty ones and include them.
        if (!hasWork) {
            for (auto& kv : g_objs) {
                Obj* o = kv.second;
                if (!o || o->kind != K_CMDBUF) continue;
                CmdBuf* cb = (CmdBuf*)o;
                if (!cb->cmds.empty()) {
                    frames.push_back({cb, kv.first});
                    hasWork = true;
                    if (vkTrace()) klog_fmt("vk64: vkQueueSubmit2 fallback: found non-empty CB 0x%llx (%u cmds)",
                                             (unsigned long long)kv.first, (unsigned)cb->cmds.size());
                }
            }
        }
        if (hasWork) {
            if (vkSchemaV2()) serializeSubmitV2(frames); else serializeSubmit(frames);
        }
        if (args.a[3]) { Fence* f = objOf<Fence>(args.a[3], K_FENCE, "vkQueueSubmit"); if (f) f->signalled = 1; }
        return VK_SUCCESS;
    }
    case VK64_fn_vkQueueSubmit2:
    case VK64_fn_vkQueueSubmit2KHR: {
        // (queue, nSubmits, pSubmitInfo2*, fence) — Vulkan 1.3 path DXVK uses.
        // VkSubmitInfo2 carries semaphore values inline (no timeline pNext).
        U32 n = (U32)args.a[1];
        std::vector<VkSubmitInfo2> sis;
        readArray(args.a[2], n, sis);
        std::vector<std::pair<CmdBuf*, U64>> frames;
        for (U32 i = 0; i < n; i++) {
            std::vector<VkSemaphoreSubmitInfo> waits, signals;
            readArray(sis[i].pWaitSemaphoreInfos, sis[i].waitSemaphoreInfoCount, waits);
            readArray(sis[i].pSignalSemaphoreInfos, sis[i].signalSemaphoreInfoCount, signals);
            for (auto& w : waits) {
                Semaphore* s = objOf<Semaphore>((U64)w.semaphore, K_SEMAPHORE, "vkQueueSubmit2");
                if (s && s->counter < w.value) s->counter = w.value;
            }
            for (auto& sg : signals) {
                Semaphore* s = objOf<Semaphore>((U64)sg.semaphore, K_SEMAPHORE, "vkQueueSubmit2");
                if (s && sg.value > s->counter) s->counter = sg.value;
            }
            std::vector<VkCommandBufferSubmitInfo> cbis;
            readArray(sis[i].pCommandBufferInfos, sis[i].commandBufferInfoCount, cbis);
            for (auto& cbi : cbis) {
                CmdBuf* cb = cbOf((U64)cbi.commandBuffer, "vkQueueSubmit2");
                if (!cb) continue;
                for (const Cmd& k : cb->cmds) if (k.kind == CMD_COPY_B2I) execCopy(k.copy);
                for (const Cmd& k : cb->cmds) if (k.kind == CMD_UPDATE_BUF) execUpdateBuf(k);
                frames.push_back({cb, (U64)cbi.commandBuffer});
            }
        }
        if (vkTrace()) klog_fmt("vk64: vkQueueSubmit2(%u batches, %u command buffers)", (unsigned)n, (unsigned)frames.size());
        // Skip serialization if no command buffers have commands (common case
        // for DXVK's empty init submits). This avoids the frame manifest
        // overhead for submits that carry no rendering work.
        bool hasWork = false;
        for (auto& fr : frames) if (fr.first && !fr.first->cmds.empty()) { hasWork = true; break; }
        // Fallback: DXVK sometimes records draws to CBs that are never
        // submitted (e.g., 70 draws to 3 CBs, but submits reference empty CBs).
        // Scan all CmdBufs for non-empty ones and include them.
        if (!hasWork) {
            for (auto& kv : g_objs) {
                Obj* o = kv.second;
                if (!o || o->kind != K_CMDBUF) continue;
                CmdBuf* cb = (CmdBuf*)o;
                if (!cb->cmds.empty()) {
                    frames.push_back({cb, kv.first});
                    hasWork = true;
                    if (vkTrace()) klog_fmt("vk64: vkQueueSubmit2 fallback: found non-empty CB 0x%llx (%u cmds)",
                                             (unsigned long long)kv.first, (unsigned)cb->cmds.size());
                }
            }
        }
        if (hasWork) {
            if (vkSchemaV2()) serializeSubmitV2(frames); else serializeSubmit(frames);
        }
        if (args.a[3]) { Fence* f = objOf<Fence>(args.a[3], K_FENCE, "vkQueueSubmit2"); if (f) f->signalled = 1; }
        return VK_SUCCESS;
    }
    case VK64_fn_vkQueuePresentKHR: {
        // (queue, pPresentInfo*)
        VkPresentInfoKHR pi = {};
        if (!readStruct(args.a[1], pi)) return VK_ERROR_INITIALIZATION_FAILED;
        for (U32 i = 0; i < pi.swapchainCount; i++) {
            U64 scId = rd64(pi.pSwapchains + (U64)i * 8);
            Swapchain* sc = objOf<Swapchain>(scId, K_SWAPCHAIN, "vkQueuePresentKHR");
            klog_fmt("vk64: vkQueuePresentKHR swapchain=0x%llx image=%u %ux%u -> presents frame %u",
                     (unsigned long long)scId, (unsigned)rd32(pi.pImageIndices + (U64)i * 4),
                     sc ? sc->w : 0, sc ? sc->h : 0, g_frameNo ? g_frameNo - 1 : 0);
            // One result PER SWAPCHAIN, always VK_SUCCESS. Not writing this is
            // what produces a phantom device-loss cascade in a DXVK-shaped caller:
            // it reads the array back and finds whatever was on the stack. (And
            // write it even for a swapchain we did not resolve, so the count the
            // guest sees is still complete.)
            if (pi.pResults) wr32(pi.pResults + (U64)i * 4, VK_SUCCESS);
        }
        // THE frame handoff. v1: the one JSON manifest submit built, hopped as
        // a string. v2: every queued frame's chunks, one MAIN_THREAD_EM_ASM per
        // chunk; the producer ring already dropped the oldest frames past its
        // cap, so this never carries a backlog.
        if (vkSchemaV2()) hopV2ToPage(); else emitFrameNow();
        return VK_SUCCESS;
    }

    default:
        // Benign-error tail. This is what turned P1's original
        // "Segmentation fault" into a clean exit 0 (P1 section 1.4) and it is
        // what keeps an un-ported entry point harmless here too.
        klog_fmt("vk64: unimplemented fnId=%llu (%s) -> benign error",
                 (unsigned long long)fnId, fnName(fnId));
        return (U64)(int64_t)VK_ERROR_FEATURE_NOT_PRESENT;
    }
}

#endif // BOXEDWINE_VULKAN64