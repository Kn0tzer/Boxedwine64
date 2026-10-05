# D3D12 bridge status, 2026-10-05

The vkd3d cross-build is complete; D3D12 device creation and rendered pixels
remain unverified. This status supersedes the reporting-only patch suggestions
in `ICD_WORK_ITEMS.md` and the obsolete prerequisite status in `PROBE_PLAN.md`.

The lane now includes the graphics work through `ad453e6`: synchronization2
submission, dynamic rendering, vertex/index binding, indexed draws, format
queries, buffer views, and descriptor update templates already exist. They
must not be counted again as new D3D12 implementation work. The original
31-entrypoint deficit is therefore obsolete.

New supporting entrypoints:

- `vkCmdSetViewportWithCount` and its EXT alias use the existing viewport
  recording path with first viewport 0.
- `vkCmdSetScissorWithCount` and its EXT alias use the existing scissor path.
  The current recorder/page supports one viewport/scissor; these aliases do
  not provide multiple-viewport rendering or advertise that capability.
- `vkFlushMappedMemoryRanges` and `vkInvalidateMappedMemoryRanges` validate
  device, memory handles, host-visible memory types, and allocation bounds.
  Host-visible guest memory is coherent, so valid ranges need no copying.

The command-pool lifetime increment also fixes an inherited capture corruption:
resetting pool A previously cleared every command buffer, including unsubmitted
draws in pool B. Buffers now retain pool ownership; pool reset clears only its
own buffers, begin/reset clear all recording state, free checks ownership, and
pool destruction removes its children. Object deletion invokes derived
destructors, reclaiming command/shader vectors rather than deleting only the
base object. Native tests reproduce the old reset bug, check unrelated draws
survive, and check derived vector element destruction. Address/undefined
sanitizers pass. This does not establish a browser leak-free soak or prove this
was the sole cause of the G2 submission failure.

All five device-creation gates remain blocked. Advertising them is not merely
reporting: each requires behavior absent from the page/shader or recorder.

| Required capability | Current evidence | Remaining implementation |
| --- | --- | --- |
| Push descriptors | No supported `vkCmdPushDescriptorSetKHR` | Descriptor decoding and command-local snapshot/lifetime, then extension/properties |
| Instance divisors including zero | Pipeline keeps input rate only | Preserve divisors and implement divisor/zero-rate vertex fetch |
| Mirror clamp to edge | Page maps only standard WebGPU address modes | Shader/sampling translation with mirror-clamp semantics |
| Shader draw parameters | No demonstrated BaseVertex/BaseInstance/DrawIndex shader translation | Compile/replay those builtins and validate draw offsets |
| Single-texel buffer alignment | Buffer views exist, but texel-buffer shader/replay support is unproven | Implement aligned texel-buffer access before claiming properties |

Upstream gates were checked in local vkd3d-proton `31d1f89`,
`libs/vkd3d/device.c:2495–2519,2633–2665`. The gate list itself is accurate;
the old statement that the bridge already implements their behavior is not.
No new capability bits or extensions are enabled by this increment.

Validation: `python3 tools/vkd3d/tests/run-native.py` compiles the actual shim
wrappers and bridge, replacing only the private x86 syscall and emulator memory
with a byte-addressed test boundary. It verifies recorded viewport/scissor
values and mapped-range success/failure including WHOLE_SIZE and overflow.
The unchanged code failed the first WithCount assertion before implementation.
The production host translation unit also passes native C++ syntax checking
with the real emulator headers. The native test is not a wasm, Wine, or GPU
execution claim.

Remaining launch vocabulary includes push descriptors, buffer copies, explicit
color/attachment clears, descriptor recycling, query pools, and secondary
command-buffer execution. Rootfs archives exist in the integrated `dist`
checkout, superseding the historical empty-dist note, but vkd3d DLL prefix
installation and a D3D12 guest probe have not been verified here.

Inherited submission risks remain: empty submitted buffers trigger a scan of
all recorded buffers, timeline waits advance counters themselves, and Present
holds the bridge mutex during the browser hop. These require separate fixes
and runtime verification; the historical 62-frame count alone is not D3D12 or
submission correctness evidence.
