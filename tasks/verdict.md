# Verdict: does DXVK-on-vkwebgpu hold?

**Yes — conditionally, and the boundary as built is the right substrate.** The trap, the
opaque-id tables, the guest-VA memory model, and the one-hop-per-frame manifest are all
compatible with how DXVK actually drives Vulkan (worker-thread recording, immediate-friendly
sync, headless-capable surfaces); nothing architectural must be rethought, and the P1→P2
ports (object tables, eager copies, submit-time reconstruction) survive verbatim. What must
change NOW is all on the *reporting and recording* side, not the transport: the ICD currently
presents as a Vulkan 1.1 device with one extension and eleven feature bits, answers no pNext
chain, owns no timeline semaphores, offers no Win32 surface, hops while holding its own mutex,
and records a vkcube-shaped subset of commands — and DXVK's `isCompatible` gate, per-flush
timeline fence, winevulkan surface path, and indexed-draw-everything workload each hit one of
those walls before a single triangle can form. Every wall is small, enumerated in `audit.md`
(P2-NOW items 1–7), and prototypeable offline — two are prototyped in `patched/`. The deep
risk is unchanged from §2.10 unknown #2 and sits *outside* the boundary: naga 30.0.1 spv-in
rejects vkcube's own fragment shader (`InvalidId(40)`, reproduced in-repo), and dxc-produced
DXVK shaders are strictly harder (spec constants, 64-bit ints, descriptor-indexing
decorations, tessellation/geometry stages); the translator route must be decided in P2 even
though the work lands in P3.

**G2 lands when all of the following are true** (D3D9 triangle gate, DXVK 2.4.x pinned):
(1) a DXVK-built `d3d9.dll` behind wine's `vulkan-1.dll → winevulkan → our shim` passes
`isCompatible` and creates a device (log shows the required extensions enabled and the
robustness2/maintenance5/transform-feedback feature structs TRUE); (2) a D3D9 clear +
indexed-triangle frame crosses as manifest schema v2 (N descriptor sets, push constants,
vertex/index bindings + layouts, sample count) and the page renders it via WebGPU without
falling back to WebGL; (3) timeline-semaphore traffic from DXVK's per-flush tracking fence
is honored end-to-end (submit/present/wait agree, `pResults` written); (4) acquire→present
runs ≥60 consecutive frames with no leak (munmap path soaked) and no main-thread hop under
`g_vkMutex`; (5) the SPIR-V route is decided with a passing corpus entry for one dxc-compiled
vertex+pixel pair. Anything less is still P2.
