These four SPIR-V modules came from the actual tri9.exe → DXVK v2.4.1+ → vk64 binary-v2 browser capture on 2026-10-05. They retain the producer's original bytes; they were not rebuilt from example GLSL.

| Module | Producer hash | Bytes |
| --- | --- | ---: |
| tri9.vert.spv | 238b8caad999da90 | 10152 |
| tri9.frag.spv | 7af91d5067fc2223 | 8064 |
| present.vert.spv | 5db584af0a2e19fa | 1252 |
| present.frag.spv | d61c5e8d1939ac57 | 1800 |

The capture used tools/dxvk/tri9/tri9.exe (SHA256 718484fc18f467db73876f24e37853e626e6670676d9e04a09d34063652a084d), tools/dxvk/build.w64/src/d3d9/d3d9.dll (00c05dca7315c9f9970cd1cfbe57013adc73a3dee39b53c98e63f36b609b9c69), and tools/rootfs64/libvk64/libvulkan.so.1 (231c42d5fb1bea1268179ba682354e47c0d1b615f6ac528bb47f75ed1fe120f0). Its local artifacts are test-results/dxvk-20261005-a5/. That run produced 53 frames and 101 chunks but rendered no pixels because render-pass attachments were absent. Shader translation alone does not prove end-to-end rendering.

The pre-pass preserves [SPIR-V 1.4+ entrypoint interfaces](https://registry.khronos.org/SPIR-V/specs/unified1/SPIRV.html#OpEntryPoint) when it splits combined samplers. It removes point-specific interface decorations only when the caller supplies a known line/triangle topology. [PointCoord is undefined for non-point primitives](https://registry.khronos.org/VulkanSC/specs/1.0-extensions/man/html/PointCoord.html); the rewrite chooses zero and retains the original shader computations. Point and unknown topology keep strict rejection. [Demote differs from Kill](https://github.com/KhronosGroup/SPIRV-Registry/blob/main/extensions/EXT/SPV_EXT_demote_to_helper_invocation.asciidoc); lowering is restricted to an acyclic branch/return tail with no subsequent helper execution, derivatives, or writes. General demote remains unsupported.
