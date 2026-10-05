// vk64_dxvk_sync.inc — PROTOTYPE (audit P2-NOW item 3). NOT compiled here.
// Transplant target: source/vulkan/vk64bridge.cpp.
//   (a) Semaphore struct: add `U64 counter = 0; int isTimeline = 0;`
//   (b) vkCreateSemaphore: read VkSemaphoreCreateInfo, then its pNext chain for
//       VkSemaphoreTypeCreateInfo{semaphoreType}; set isTimeline/counter(0).
//   (c) four new fn-ids (append-only, next free ids) + shim wrappers + GIPA rows:
//       vkGetSemaphoreCounterValue, vkWaitSemaphores, vkSignalSemaphore,
//       (+ vkCreateSemaphore already exists; binary create path unchanged).
//   (d) vkQueueSubmit: honor VkTimelineSemaphoreSubmitInfo pNext (signal=max,
//       wait=no-op-success); write pResults in vkQueuePresentKHR.
// Rationale: DXVK puts a timeline wait/signal (u64) on every command-list flush
// (dxvk_context.cpp tracking fence). Under immediate execution everything has
// already run, so signal=max(counter) and wait=immediate-success are *honest*,
// not lies. Binary semaphores keep current behavior (auto-signal on acquire,
// ignored in submit/present) until the P3 multi-queue wiring.

// --- (b) create: replace the vkCreateSemaphore case body ---
// case VK64_fn_vkCreateSemaphore: {
//     VkSemaphoreCreateInfo ci = {};
//     if (!objOf<Device>(args.a[0], K_DEVICE, "vkCreateSemaphore") ||
//         !readStruct(args.a[1], ci) || !args.a[3])
//         return VK_ERROR_INITIALIZATION_FAILED;
//     U64 id = 0;
//     Semaphore* s = createObj<Semaphore>(K_SEMAPHORE, id);
//     // NEW: timeline detection. pNext[0] may be VkSemaphoreTypeCreateInfo.
//     if (ci.pNext) {
//         U32 st = g_mem->readd(ci.pNext);
//         if (st == VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO) {
//             U32 semType = g_mem->readd(ci.pNext + 12); // sType + initialValue(u64@8) layout: type @12
//             s->isTimeline = (semType == VK_SEMAPHORE_TYPE_TIMELINE);
//         }
//     }
//     s->counter = ci.pNext ? 0 : 0;
//     wr64(args.a[3], id);
//     return VK_SUCCESS;
// }
// NOTE on offset: VkSemaphoreTypeCreateInfo = { sType:u32, pNext:u64(@8),
// initialValue:u64(@16), ... } — wait, the layout is sType(0..4), pNext(8..16),
// semaphoreType(16..20), initialValue(24..32)? VERIFY against header at transplant:
//   sType u32 @0, pNext u64 @8, semaphoreType VkSemaphoreType(u32) @16,
//   initialValue u64 @24. So semaphoreType is read at +16 and initialValue at +24.
// The sketch above (+12) is WRONG — corrected in the probe (probe_caps.c asserts
// offsetof(VkSemaphoreTypeCreateInfo, semaphoreType)==16). Transplant with +16/+24.

// --- (c) the quartet (new cases; ids TBD append-only) ---
// case VK64_fn_vkGetSemaphoreCounterValue: {          // (device, sem, out u64*)
//     Semaphore* s = objOf<Semaphore>(args.a[1], K_SEMAPHORE, "vkGetSemaphoreCounterValue");
//     if (!s || !args.a[2]) return VK_ERROR_INITIALIZATION_FAILED;
//     wr64(args.a[2], s->counter);
//     return VK_SUCCESS;
// }
// case VK64_fn_vkWaitSemaphores: {                    // (device, pWaitInfo*, timeout)
//     VkSemaphoreWaitInfo wi = {};
//     if (!readStruct(args.a[1], wi)) return VK_ERROR_INITIALIZATION_FAILED;
//     // Immediate model: every signaled value has already "happened". Bump any
//     // lagging counter forward (monotonic, never backward) and return SUCCESS.
//     // A timeout of 0 with an unsignaled value returns TIMEOUT (spec-honest).
//     for (U32 i = 0; i < wi.semaphoreCount; i++) {
//         U64 semId = rd64(wi.pSemaphores + (U64)i * 8);
//         U64 want  = rd64(wi.pValues + (U64)i * 8);
//         Semaphore* s = objOf<Semaphore>(semId, K_SEMAPHORE, "vkWaitSemaphores");
//         if (!s) return VK_ERROR_INITIALIZATION_FAILED;
//         if (s->counter < want) {
//             if (!args.a[2]) return VK_TIMEOUT;
//             s->counter = want;
//         }
//     }
//     return VK_SUCCESS;
// }
// case VK64_fn_vkSignalSemaphore: {                   // (device, pSignalInfo*)
//     VkSemaphoreSignalInfo si = {};
//     if (!readStruct(args.a[1], si)) return VK_ERROR_INITIALIZATION_FAILED;
//     Semaphore* s = objOf<Semaphore>(si.semaphore, K_SEMAPHORE, "vkSignalSemaphore");
//     if (!s) return VK_ERROR_INITIALIZATION_FAILED;
//     if (si.value > s->counter) s->counter = si.value;   // monotonic host signal
//     return VK_SUCCESS;
// }
// (vkCreateSemaphore-with-type is (b); binary path unchanged.)

// --- (d) submit pNext + present pResults ---
// In vkQueueSubmit, before serializeSubmit: if (si.pNext) walk the chain; for
// VkTimelineSemaphoreSubmitInfo: for each signal value, set that semaphore's
// counter = max(counter, value); waits: assert-or-bump as in WaitSemaphores
// (DXVK submits waits only for values it signaled earlier in the same flush
// sequence, so bump-forward is consistent).
// In vkQueuePresentKHR: after the per-swapchain loop,
//   if (pi.pResults) for (i...) writed(pi.pResults + i*4, VK_SUCCESS);
// One-liner that kills a whole class of phantom device-loss cascades.

// --- locking interaction (audit item c) ---
// The quartet runs under g_vkMutex like everything else and performs NO
// main-thread hop — safe. The present-path hop MUST move outside the lock
// (separate restructure): build `json` under lock, release, then hop.
