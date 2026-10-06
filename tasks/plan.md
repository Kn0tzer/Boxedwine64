# Browser Wine experiment

## Architecture and trust boundaries

The upstream revision is dee2ff3. The local fork is outside the web root. Only a build export is served at /wine. No Windows binary executes on the host: all guest code runs in Boxedwine's WASM interpreter. Folder imports and archives stay in browser storage. Imported paths are validated before writes; archive symlinks, encrypted entries, traversal, case collisions, excessive counts and expansion are rejected. The runtime is an iframe reset between launches, which owns its own Wine prefix, workers and canvas.

## Ordered vertical slices

1. Build upstream cleanly (M): `source /opt/emsdk/emsdk_env.sh; make -C project/emscripten wasm64-mt`. Acceptance: linked JS/WASM, CRC-tested rootfs. Fix emcc/em++ link regression. No upstream pushes.
2. Launcher/storage (L): folder/drop/ZIP → persistent package → EXE picker → iframe boot. Separate browser-only IndexedDB namespaces for each installation. Saves include registry and app profile, export/restore; patch ZIP is a checked overlay, not an invented universal binary patcher. Acceptance: hostile-path tests; import actual PE + sibling assets; guest accesses assets and writes save; reload preserves save.
3. Graphics foundation (L): collect supported real guest fixed-function GL commands at swap; render them with a WebGPU/WGSL pipeline, with explicitly bounded API support and WebGL fallback. Acceptance: animated Windows glcube frames from guest, not an unrelated JavaScript cube. Direct3D continues through upstream wined3d/WebGL until a complete state/shader translator exists; Vulkan is not falsely advertised.
4. Shader foundation (M): Naga WASM GLSL/SPIR-V → validated WGSL. Investigate real HLSL compiler rather than regex transpilation. Acceptance: translated vertex/fragment shaders compile with browser GPU validation; rejected syntax returns diagnostics. This is shader tooling, not full DirectX/Vulkan compatibility.
5. E2E/deploy (M): Playwright headless Chromium screenshots, console/network evidence, GUI input/save/upload/patch/export/restore, GL animation, exact live URL test. Add only /wine route and headers, validate Caddy before reload. Preserve unrelated services.

## Continuation: Unity startup (2026-10-03)

1. CPU regression slice (M): `cpu64.cpp`, `cpu64SelfTest.cpp`, Node runner. Prove RET imm16 dispatch, reciprocal SIMD lane preservation/m32 width, CMPXCHG8B/16B flag preservation, scalar conversion. Build `wasm64-runelf`; run `--x64-selftest` before/after. Regenerate opcode dispatch with the existing tool after adding handlers.
2. Unity diagnostic slice (S): existing Baldi Playwright test. Fail immediately on guest unimplemented opcodes/abort, record player logs, screenshot and failure exit code. Rebuild `wasm64-mt` and browser export. Acceptance is rendered gameplay and input—not merely a mapped window. Depends on CPU tests.
3. Regression/release slice (M): `pnpm test`, `pnpm typecheck`, browser smoke and upload persistence. Deploy only a passing runtime; retain explicit modern-game blocker if Unity is not yet playable. Do not push without clear instruction.

## Boundaries

Do not claim complete until the user's full modern-game goal is actually verified. A working GUI/import/3D foundation is a useful checkpoint, not universal compatibility. No GitHub fork/commit/push without unambiguous authorization. Independent reviewer unavailable; record self-review and executable adversarial tests instead.

## Borrowed designs (2026-10-03, verified upstream)

Do not rebase onto 32-bit upstreams: this repo's goal is 64-bit guests
(Baldi/Unity x64). Take patterns and reference code, never the runtime.

- Upstream `danoon2/Boxedwine#151` (merged, testJit 822/822, IndexedDB
  JIT cache + pipeline script) is the template for a cpu64 WASM JIT, not
  a cherry-pick: it implements the 32-bit `JitCodeGen` interface while
  `cpu64.cpp` is a pure interpreter with no DecodedOp/block-decode
  infra. Port estimate: block decoder + 64-bit WasmEmitter + cache
  pipeline, in that order. Perf claims (W95 38->122) unverified.
- `andrewnakas/exebrowser` (same author as this base; frontend MIT,
  bundled Boxedwine GPL-2.0): local-only File API import + Cloudflare
  Worker range-fetch for the 50MB root. Our chunked `bw64url` manifest
  already mirrors the range-fetch half; the variant-switcher UX is the
  remaining takeaway. License-compatible (repo is GPL-2.0).
- `jenissimo/bottleship` (Apache-2.0, vendoring-safe, 32-bit HLE via v86
  fork, D3D3-9 only): borrow the D3D9 render-state->WebGPU mapping tables
  and OPFS ROM+CoW / AudioWorklet-ring designs for `webgpu.mjs` growth.
  Does not solve Unity64/D3D11. One-way borrowing only (its CONTRIBUTING
  bans copying Wine code).
- `vgrichina/wine-assembly` (MIT, Win98/32-bit): adopt the per-app notes
  + numbered-binary smoke-matrix methodology for opcode/API coverage,
  not the runtime.
- Shaders: `naga-cli` offline vectors are now `web/tests/shader.test.mjs`
  (9/9 node-offline); HLSL stays browser-covered until slang-wasm ships
  a node entry. `SPIRV-Cross` fills tess/geometry + legacy GLSL/ESSL;
  `slang` HLSL->SPIR-V tracked upstream; `DXC` offline ground truth only,
  never compiled to WASM. Keep `wined3d->OpenGL->WebGL` (ANGLE does the
  last mile in-browser). DXVK/VKD3D->Venus needs VirtIO-GPU: research
  track only.

## Verification status (2026-10-03 continuation)

- Deployed at kn0tzer.work.gd/wine (dist export + COOP/COEP headers, Caddy validated + reloaded). Live smoke: crossOriginIsolated, GLSL→WGSL, WASM threads + WebGPU detected.
- `node --test web/tests/files.test.mjs web/tests/graphics.test.mjs`: 10/10 pass.
- `node web/tests/browser.mjs`: GLSL+HLSL→WGSL, real Notepad window mapped, real guest OpenGL→WebGPU frames, zero page errors.
- `node web/tests/upload.mjs`: folder import → save count 1 → reload persistence (count 2) → export → patch overlay (count 3, patched asset) → browser restart with same profile → restore backup → run (count 3, original asset), zero page errors.
- Known limitation: 4+ consecutive Wine boots in a single browser process can hang (worker/renderer accumulation); the upload test restarts the browser before restore, matching a returning-user session. Fresh boots are unaffected.

## Verification status (2026-10-03 full-control session)

- `node --test` 19/19 (files+graphics 10, shader matrix 9) + `tsc` clean.
- cpu64 self-test 256/256 (RET imm16, PREFETCH(W), RSQRT/RCP lane
  preservation, CMPXCHG8B/16B ZF-only, full CVT family, times/getcwd/fstat).
- Native Win64 probes, all Playwright PASS: CRT stat32/64 seconds-timestamps;
  LoadLibrary case-insensitivity (3 spellings); crypt32 LoadLibrary +
  CertOpenStore; UnityPlayer.dll (28 MB) LoadLibrary.
- Baldi/Unity 2020.3.38f1: boots through Mono (mscorlib -> engine init) with
  ZERO unimpl opcodes; Unity shows its own dialog when graphics fails.
  Proven blockers fixed: missing libgnutls.so.30 in rootfs (crypt32 unixlib
  .bss table stayed zero -> NULL call; fixed by staging libgnutls30+closure,
  recorded in tools/rootfs64/build-wine64-zip.sh); lazy-PLT slots left
  unrelocated (libgcc_s _Unwind_Find_FDE wild jump; worked around with
  LD_BIND_NOW=1 via ?bindnow=1, default off).
- D3D11 status: Baldi requires D3D11 (2020.3 dropped D3D9; -force-d3d9
  ignored; -force-glcore unavailable in this build's shaders). Unity retries
  D3D11CreateDevice 3x -> E_FAIL. Guest libGL now reports 3.2 core behind
  ?glversion=3.2 (default stays 2.1; trap-query design, no guest-libc
  dependency; shim rebuilt with zig, staged into both rootfs zips). With 3.2
  strings wined3d runs its full capability sweep (PROC MISS list captured in
  test-results) but the device still fails. WINEDEBUG does not reach game
  processes (launcher prefixEnv limitation); GLTRACE=2 (?gltrace=2) is the
  working visibility tool. Next: bisect wined3d's failing requirement, grow
  the bridge's GL coverage, translate wined3d GLSL via Naga.
- Diag knobs added (all opt-in, default-off): BW64_WILDJUMP ring dump,
  BW64_UNIMPLDUMP (pid/GPRs/exe), BW64_DUMPADDR (guest qword dump),
  BW64_GLVERSION/BW64_RIPSAMPLE/BW64_DLLTRACE/BW64_FMMAP plumbing.
- Test-harness fixes: unityprobe re-resolves the runtime frame every poll
  (iframe reloads detached the cached handle); completion sentinels replace
  byte-count thresholds (a finished cryptprobe result is 62 bytes);
  scratch-baldi screenshots immediately after map + rolling console capture
  + SOAK_SECS + always dump player.log.

## Phase: Modern-game completion (2026-10-04, orchestration)

Fleet: Kilo/Space Bunny (primary), Experiential/glm-5.3-flash-abliterated + tokenharbor
deepseek/qwen (fallbacks). TokenBom and Kilo hy3/nex shelved (probe failures). Single C++
writer lane (A) and single web-UI writer lane (B); orchestrator owns commits, deploys,
and tasks/plan.md.

- A1 (diagnose, no code): gltrace=2 Baldi run; identify the exact wined3d requirement that
  fails D3D11CreateDevice; rank root-cause hypotheses; list minimal GL procs/behaviors to
  implement. Output: test-results/baldi-d3d11-diagnosis.md.
- A2 (fix, C++ lane): implement A1's minimal list in gl64bridge.cpp (+cpu64 if needed);
  rebuild wasm64-mt; re-run Baldi probe. Pass = GfxDevice init succeeds and rendered
  gameplay verified (screenshot + input), not a mapped window.
- B1 (web UI lane): built-in games catalog (games/baldi.zip) in app.mjs/index.html, Baldi
  probe buttons, games-catalog e2e probe reaching MAPPED. No C++ edits.
- B2 (reliability): fix 4+ consecutive boot hang (worker teardown).
- C1 (after A2): wire wined3d guest GLSL through Naga->WGSL in the runtime path (D3D9
  triangle as first consumer), fallback to ANGLE GLSL1 on Naga rejection.
- D1 (after C1): grow WebGPU bridge coverage from PROC MISS/trace data.
- Orchestrator: commit per lane on review, deploy to /home/ubuntu/kn0tzer/wine + Caddy only
  after passing evidence, verify live at kn0tzer.work.gd/wine. Never push.
