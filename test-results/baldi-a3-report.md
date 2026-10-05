# A3 — Baldi D3D11 attachment completeness and gameplay

Date: 2026-10-04. Repo: `/home/ubuntu/boxedwine64`. No commits or pushes.

## Acceptance / boundaries

- Primary PASS requires actual Baldi game content in a screenshot **and** the probe completion sentinel; mapping alone is not PASS.
- After gameplay: demonstrate keyboard/input response, then exercise a second staged Unity/modern 3D sample if available.
- Source lane: `source/opengl/*`, `tools/rootfs64/libgl64/*`; only test knobs in `web/tests/scratch-baldi.mjs`. No frontend edits.
- All new evidence: `test-results/baldi-a3-*`; heavy builds/probes strictly sequential; emcc build at `nice -n 19` after sourcing `/opt/emsdk/emsdk_env.sh`.
- Every cycle records changes, evidence, and next action. Change approach after three consecutive stagnant fix/build/probe cycles.

## Baseline inspection

Read the required documents in order, then guest/host GL bridge. A2 reported 97 MISSING_ATTACHMENT + 36 INCOMPLETE_ATTACHMENT, 362 PROC MISS, 233 HIT, mapped window, empty page errors, no gameplay. Checked actual A2 console: rectangle uploads fail with 0x500; **other errors are present too**, e.g. internal format 0x8059 with unsigned bytes fails 0x502 (0x8059 is RGB10_A2, not RGBA16F; confirmed against Khronos WebGL2 IDL). A2 prose overstates the absence of other allocation errors.

Host: aarch64, Emscripten 6.0.9, Playwright 1.58.2. Existing `bw64-libgl64-gcc:bookworm` image available; the full Wine staging image is absent. `/tmp/stage` contains only Baldi. GL source/shim/test lane clean at entry. Existing selftest wrapper is under `project/emscripten/Build/Wasm64SelfTest/`, not top-level Build.

Source-level gaps worth discriminating:
- `glFramebufferTexture1D/3D` silently do nothing; A2 trace contains fnId=634 then MISSING_ATTACHMENT.
- `glFramebufferTexture` invokes `GLctx.framebufferTexture`, which WebGL2 does not expose; exceptions are swallowed by inherited A2 code.
- One global framebuffer tracks GL_FRAMEBUFFER only, not separate READ/DRAW bindings.
- Guest `glMapBufferRange` already has scratch/upload emulation (A2 report says it is still a no-op; source disagrees).
- Probe currently emits only a mapped checkpoint; no gameplay sentinel or keyboard injection is present in this checkout. Do not silently treat that checkpoint as PASS.

## Cycle 1 — rectangle translation + attachment diagnostics (complete)

Plan: translate desktop GL_TEXTURE_RECTANGLE to WebGL2 GL_TEXTURE_2D consistently for binds, parameters, uploads, queries and attachment targets. Add trace-gated attachment details and actual FBO object queries. Do not fake framebuffer completeness. Rebuild host, export runtime, run the requested GL 3.2/trace 2/60s soak/BIND_NOW probe with TAG=a3-c1.

Evidence: `baldi-a3-c1-build.log` build exit 0; `baldi-a3-c1-export.log`; `baldi-a3-c1-run.log` diagnostic exit 0, MAPPED, errors `[]`, player.log ENOENT. Screenshots `baldi-a3-c1-frame.png` and `...-shot.png`; **not gameplay PASS**. Actual trace: MISSING_ATTACHMENT raw counts **97 -> 35**, INCOMPLETE_ATTACHMENT **37 -> 39** (including one default-FBO check). **Caveat found on deeper review:** A2 performed 205 FBO checks / 279 allocations, C1 only 113 checks / 158 allocations before the soak ended. Raw counts alone are not a full-sweep comparison; use attachment-state transitions as proof and run a longer soak once fixes land. 20 fn=634 and 20 fn=636 attachment no-ops recorded, actual queried objects absent. Rectangle attachment now succeeds for backed formats. Remaining TEX2D allocation errors: 57 INVALID_VALUE, 16 INVALID_OPERATION, 9 INVALID_ENUM; includes packed reversed desktop types and legacy alpha/luminance formats. Progress, no stagnant-cycle count.

Next: supply real 1D emulation and 3D-layer attachments; correct packed pixel enums/conversions rather than lying about FBO status. Official reference: https://registry.khronos.org/webgl/specs/latest/2.0/ and installed Emscripten 6.0.9 `src/lib/libwebgl{,2}.js`: GL ids must resolve through Emscripten object tables; no WebGL2 framebufferTexture method exists.

## Cycle 2 — real 1D/3D attachment path + packed formats (complete)

Implement 1D textures as 2D width x 1, bridge glTexImage1D instead of its inherited stub; correct glFramebufferTexture3D's six-argument guest ABI; use framebufferTextureLayer for 3D slices. Fix packed 8888/565/4444/1555/2101010 layouts using actual bit widths, retaining WebGL2 RGB10_A2's supported packed type. Restage changed shim, rebuild host, probe again. Full rootfs script requires absent Wine Docker image; record any staging limitation explicitly.

Evidence: packed conversion regression vectors failed before repair (`baldi-a3-pixel-red.log`) and pass 7/7 after repair (`...-green.log`). Shim build exit 0; host build exit 0, export complete. `baldi-a3-c2-rootfs.log` records preflight failure for full staging, CRC tests of both existing layers and four extracted-entry SHA256 matches against new shim (including previously stale Wine overlay). **Full build-wine64-zip.sh remains a release limitation.** Probe (`...-c2-run.log`) MAPPED, errors `[]`, player.log ENOENT. **Zero MISSING_ATTACHMENT in 79 checks**; 39 INCOMPLETE_ATTACHMENT. 1D storage and 3D layers attach real objects now. Only a partial sweep finished in 60s; screenshots still show launcher/loading, not gameplay. Corrected actual packed types and 3D attachment ABI. No stagnant cycle.

Next: apply format conversion consistently to 3D uploads, cover measured RGB10_A2/BYTE and legacy alpha/luminance allocations, fix wrong capability enum constants, then run a longer soak so the full wined3d format sweep can finish. Source audit found A2 overrides swapped GL_MAX_COLOR_ATTACHMENTS (0x8CDF) and GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS (0x8B4D), and mislabeled DRAW_BUFFER0 (0x8825) as a cap.

## Cycle 3 — consistent formats/caps and full-sweep probe (complete)

11 pixel vectors pass after fail-first (`baldi-a3-pixel-c3-{red,green}.log`). Host build/export exit 0. `SOAK_SECS=300 WINEDEBUG=+d3d` probe reaches **441 FBO checks, zero MISSING_ATTACHMENT, 92 INCOMPLETE_ATTACHMENT**, no shader compile/link failures, errors `[]`, and no gameplay. Screenshot still launcher/loading. Sweeping progresses into Wine's depth/format functional tests; the original assertion that any incomplete capability probe necessarily blocks device init is too strong (many unsupported formats legitimately fail). WINEDEBUG still absent from logs; test knob alone does not repair inherited boot-env plumbing. `player.log` ENOENT still not proof Unity never initialized: console DOES show Initialize engine version.

Cycle 3 exposed two concrete defects: BGRA packed input to RGB10_A2 bypasses the new BYTE->packed conversion after unpacking; canonical RG formats cannot take desktop RGBA/BYTE allocation tuples. 3D depth textures are genuinely invalid in WebGL2; do not fake support. Additional remaining API stubs used in Wine functional tests include glReadPixels and glGetTexImage. Next: repair observed conversions, use low trace/long soak to determine whether startup completes vs hangs; preserve source of unsupported-format failures.

## Cycle 4 — allocation tuples and low-trace completion probe (complete)

12 vectors pass (`baldi-a3-pixel-c4-green.log`); build/export exit 0. Low-trace (`GL_TRACE=3`) attempt **FAILED exit 1 before first GL trap**, wild jump then unimplemented opcode at 0x10270 in wine service startup (`baldi-a3-c4-console.log`, UNIMPLDUMP pid=27); outside permitted GL lane. Original trace 2 retry succeeds diagnostically, MAPPED, errors `[]`, no gameplay. 420s soak reaches **548 FBO checks, zero MISSING_ATTACHMENT, 108 INCOMPLETE_ATTACHMENT**. Sweep has moved to a second FBO=700, consistent with repeated adapter/context initialization, not a single stuck GL call. Functional format probes and depth blits continue. No shader compile/link errors. No completion sentinel.

Residual errors now mostly genuinely unsupported 3D depth, normalized formats/float renderability, plus a newly found mistaken canonical RG16F/RG32F allocation tuple (should RG, not RED). A2 stubs for **glGetTexImage/glReadPixels** and **glGetTexLevelParameteriv returns zero** invalidate Wine's functional tests even when attachments are complete. Change approach from further raw FBO-count chasing to actual texture metadata/readback semantics. No repeated stagnant rebuilds.

## Cycle 5 — Wine functional texture queries/readback (complete)

Plan: implement 2D texture level metadata queries and real glReadPixels/glGetTexImage guest marshalling, preserving framebuffer bindings for readback. Correct RG float canonical tuple. Leave unsupported targets/formats honestly unsupported; don't spoof completeness. Probe long enough to move through functional adapter tests, then run final CPU/unit/type regressions.

Implemented appended ABI ids 850/851 (glReadPixels/glGetTexImage), real guest wrappers, successful-allocation metadata for desktop level queries, RG16F/RG32F canonical RG/FLOAT allocations. Readback is currently bounded **RGBA/BGRA byte/8888_REV**, 2D/1D/cube-face texture levels and current framebuffer. Saves/restores READ/DRAW FBO and pack state around texture readback; no fake positive writes after a GL error. 3D texture readback and integer/float readback remain unsupported. These limitations matter for the continued capability tests; final review makes these unsupported requests report GL errors explicitly. Metadata cleared on texture deletion. No frontend or probe source edits. Final review repair below adds explicit bridge errors and packed destination semantics; the earlier 600s evidence applies to pre-review C5, not to that later repair.

Evidence: `baldi-a3-c5-{build,export,shim-build,rootfs}.log`, all build steps exit 0, zip CRC checks + shim hash matches. `baldi-a3-c5-run.log` 600s soak, diagnostic exit 0, MAPPED, errors `[]`, no gameplay. **722 FBO checks, ZERO MISSING_ATTACHMENT, 125 INCOMPLETE_ATTACHMENT**; 246 readback calls with err=0, 65 INVALID_OPERATION, 2 INVALID_ENUM. No shader compile/link failures. Screenshot `baldi-a3-c5-frame.png` still shows startup/loading. Repeated capability sweeps and functional tests continue, not certified completion. `baldi-a3-summary.json` gives cycle counts; raw failure counts must be normalized to work completed (A2 only 205 checks). C5 now sees repeat proc sweeps (597 misses/280 hits total), not directly comparable to single-sweep A2 counts.

## Final verification / handoff

- Latest WASM rebuilt/exported after final native preprocessor guard/comment repair (`baldi-a3-final-build.log`, exit 0). Latest artifact browser WebGPU regression PASS, 17 real guest GL frames advancing, errors `[]` (`baldi-a3-final-browser-retry-run.log`, `...-webgpu-cube.png`). Initial artifact-name-only wrapper failed on data-URL module resolution; fixed wrapper imports absolute URLs; original checked-in test unchanged. This GPU_ONLY regression does not certify Baldi or shader UI.
- CPU64 existing binary rerun: **256 passed, 0 failed** (`baldi-a3-final-selftest.log`). No CPU edits; binary is not linked with GL.
- Pixel vectors: **12 passed**, extracted directly from final bridge source (`baldi-a3-final-pixels.log`); earlier fail-first evidence retained.
- `pnpm test`: **29 passed, 0 failed, 1 existing opt-in browser e2e skipped** (`baldi-a3-final-unit.log`). Do not call this 30/30.
- `pnpm typecheck`: **FAILED** in out-of-lane `web/games.mjs:47`, TS2339 property `id` absent on `{archive,size?,title}`. No frontend source changes in this lane; left for orchestrator rather than breaking edit boundary.
- ABI **288 guest ids match host** (`baldi-a3-final-abi-summary.log`); initial ad-hoc comparison regex incorrectly read uses after enum, then corrected to enum-only/comment-stripped. Artifact checks: all eight libGL entries across web/dist and both zip layers match built shim; exported WASM matches linked output (`baldi-a3-final-artifacts.log`). `git diff --check` clean.
- Full `tools/rootfs64/build-wine64-zip.sh` still blocked by absent `boxedwine64/wine64-debian:bookworm`. Both existing layers updated, CRC-tested, hash-checked; full clean restage still required before release.
- Additional direct GL3.2 imported-glcube probe **FAILED before GL** with same 0x10270 service wild jump (`baldi-a3-final-glcube-run.log`, exit 1). This is distinct from the successful built-in WebGPU glcube regression and shows boot reliability remains unresolved; preserved failure, not reclassified as pass.
- Baldi gameplay, completion sentinel, input: **NOT PASSED**. Current scratch-baldi checkout contains no gameplay sentinel or keyboard injection, only mapped checkpoint; no test assertion weakened/changed. Second Unity title unavailable in `/tmp/stage`. Real guest glcube regression is a checkpoint only, not a substitute for modern-game gameplay.

### Next investigation (different approach, not another blind format batch)

1. Obtain Wine `+d3d` diagnostics in the actual spawned guest environment using orchestrator-owned launcher/kernel lane; current addInitScript knob does not produce those logs. Identify why adapters/capability tests restart and which context-init bail-out returns.
2. Support texture readback/metadata representations that the trace actually consumes (3D, float/integer and further packed output); broaden and browser-test the newly repaired pixel pack-buffer semantics; preserve real GL errors and do not claim unsupported 3D depth support. Existing glGetTexImage/level query coverage remains deliberately partial.
3. Repair inherited FBO tracking for distinct READ/DRAW/default targets before game presentation. `bindGuestTarget` still conflates them; no evidence yet that the remaining format probes are solely a completeness bug.
4. MRT output-location translation and shader-side rectangle/1D sampling semantics remain unimplemented. A3 only emulates their storage/attachments, not complete sampling support. Inherited glFramebufferTexture and multisample/indexed raw GLctx paths contain non-WebGL methods/argument misuse and swallowed exceptions; audit before advertising their capabilities.
5. Investigate the preserved pre-GL service wild jump separately (C4 trace=3); original trace=2 retry reaches GL, so don't conflate that failure with GL source correctness.

## Final completion review repair (2026-10-04)

Code review found a necessary correctness repair in newly added readback: unsupported formats/targets/absent levels returned silently, and destination row packing / pixel pack buffers were ignored. Added first-error preservation through guest glGetError, explicit invalid-enum/operation/value and resource errors, aligned PACK_ROW_LENGTH/SKIP destination writes, bounded PBO capacity validation and real row uploads. No tests weakened; unsupported readback is now a visible error, not a success-shaped no-op.

- Extracted-source pack layout/first-error regression vectors **7/7 PASS** (`baldi-a3-final-readback.log`); pixel vectors **12/12 PASS**, rerun on final source.
- Final repaired host build/export **exit 0** (`baldi-a3-final-repair-{build,export}.log`); linked/exported WASM SHA256 matches: `027e31c3d6f3a8a068be141c5ca8d975d9283ae8faa6318d79b3592e50d9dedf`.
- Requested 60s trace2 Baldi probe rerun on repaired artifact: **MAPPED, page errors []**, 66 FBO checks, **zero MISSING_ATTACHMENT**, 5 INCOMPLETE_ATTACHMENT; 36 readback calls err=0, 8 explicit INVALID_ENUM (unsupported paths). Screenshot still loading, player.log ENOENT, **no gameplay/sentinel PASS** (`baldi-a3-final-repair-run.log`, exit 0 diagnostic only). This is partial-sweep evidence, not comparable to 600s C5 counts.
- CPU/unit/type checks were not repeated because their relevant inputs did not change: prior CPU/unit/pixel outcomes and existing typecheck failure remain as documented. Latest repaired artifact browser regression **PASS**, 16 real guest GL WebGPU frames advancing, errors `[]` (`baldi-a3-final-repair-browser-run.log`, exit 0).

No commits, pushes, deploys, or frontend source edits. All usable evidence saved with baldi-a3 prefix; heavy jobs were sequential.

## Cycle 6 — level queries, readback representations, attachment classification (complete)

Plan (successor to C5's three suspect defects): (1) stop returning false zeros from glGetTexLevelParameteriv; (2) close 3D + float/integer readback gaps and determine whether Wine treats readback errors as fatal; (3) classify every INCOMPLETE_ATTACHMENT in a 300s soak with format+type per call, fixing wrong tuples and leaving legitimately-unsupported formats failing honestly. All edits in `source/opengl/gl64bridge.cpp`; no ABI or guest-shim changes, no frontend edits.

What changed:
- `boundTexture()` now resolves the binding matching the guest target (3D→`GL_TEXTURE_BINDING_3D`, 2D-array→its binding; rect/1D stay on 2D). Previously every 3D metadata lookup missed, so every 3D readback failed `INVALID_OPERATION`.
- New `sizedFormatBits()` (R/RG/RGB/RGBA 8–32b, packed, depth/stencil, SNORM blocks) drives level queries and depth-texture detection.
- New `canonicalFloatTuple()`: sized float ifmts (R16F/R32F, RG16F/RG32F, RGB(A)16/32F, R11F_G11F_B10F, RGB9_E5) issued with RGBA/RGB/UBYTE pixels are upconverted in software to the canonical (RED/RG/RGB/RGBA, FLOAT) tuple — with or without pixels. Fixes the 3 C5 `TEX2D … err=0x502` cases (R16F/RG16F/RGBA16F probes).
- New `renderbufferStorageFixup()`: legacy unsized internal formats (R3_G3_B2, ALPHA4/8, LUMINANCE8/16, LUMINANCE4_ALPHA4, LUMINANCE8_ALPHA8, RGB4/5) are backed with RGBA8. Sized-but-not-renderable (float, SNORM, plain sRGB, packed float) deliberately still fail so probes see real device limits.
- `glGetTexLevelParameteriv`: mip levels derive from the base record (halved per level); answers WIDTH/HEIGHT/DEPTH/INTERNAL_FORMAT/RED…ALPHA/DEPTH/STENCIL/SHARED/COMPRESSED_IMAGE_SIZE. Unknown storage now yields `INVALID_VALUE` and unknown pnames `INVALID_ENUM` **without touching guest memory** (no more false zeros); previously any miss wrote 0.
- Readback (`glReadPixels`/`glGetTexImage`): reads through RGBA/UBYTE then software-converts to requested color (fmt ∈ RGBA/BGRA/RGB/BGR/RG/RED × type ∈ BYTE/SHORT/INT + unsigned + FLOAT + HALF_FLOAT + packed REV); depth textures attach to `GL_DEPTH_ATTACHMENT` and serve DEPTH_COMPONENT×(FLOAT/UINT/USHORT); STENCIL_INDEX/UBYTE reads directly; 3D textures loop slices via `framebufferTextureLayer`. Destination stride/pack math generalized to bytes-per-texel. TRACE line now prints target + w×h×d + fmt + type per call (defect 3's ask).
- FBO diagnostics: `ATTACH2D` logs the attached texture's recorded storage ifmt; `check` logs all 8 color slots + depth + stencil with object type, name, and recorded storage format (new `g_textureInfo`/`g_renderbufferInfo` reverse maps, maintained on alloc/delete).
- `glTexImage3D` now captures its GL error in-hop and records metadata (with depth) instead of a detached drain.

Evidence: helper vectors **28/28 PASS** (`baldi-a3-c6-test.py` → `baldi-a3-c6-green.log`; new code, green on first run after two extraction-harness fixes); inherited pixel vectors **12/12 PASS** rerun (`baldi-a3-c6-pixels.log`). Host build exit 0 (`baldi-a3-c6-build.log`, `nice -n 19`, emsdk sourced), export exit 0 (`baldi-a3-c6-export.log`). Requested probe `GL_VERSION=3.2 GL_TRACE=2 SOAK_SECS=300 BIND_NOW=1` exit 0, MAPPED, page errors `[]`, player.log ENOENT (`baldi-a3-c6-run.log`), no gameplay — early and final screenshots byte-identical (boot canvas 88%, no visual progress).

Soak classification (300s, `baldi-a3-c6-console.log`, `baldi-a3-summary.json` "c6"): **68 FBO checks, ZERO MISSING_ATTACHMENT, 68 INCOMPLETE_ATTACHMENT**, all on bound=27; 0 shader compile/link failures. Deltas vs C5: TEX2D nonzero errors **3 → 0**; RBSTORAGE nonzero **36 → 10** (13 legacy-unsized remapped to RGBA8, visible as `remapped->RGBA8`); float upconvert fired 3×; readback err=0 **157** (incl. **22 successful 3D-slice readbacks**, plus rect/cube-face coverage) vs 42 `INVALID_OPERATION` (level-miss on probe textures whose storage never existed — honest) and 1 `INVALID_ENUM`.
- The 68 incompletes decompose to ~20 Wine renderability probes × repeat checks: C0-as-texture with SNORM (R8/RG8/RGB8/RGBA8/R16/RG16/RGBA16 ×5), RGB32F, RGB9_E5, SRGB8 (all **legitimately non-renderable in WebGL2** — desktop GL renders SNORM but ES 3.0 does not; RGB32F needs `EXT_color_buffer_float`), the same 10 as renderbuffers (**legitimate**), 8 depth-texture + 4 stencil-texture attachments with no allocation record (**unclassified** — likely `glTexImage2DMultisample`/`glTexStorage*` paths that record no metadata), 8 transient C0-unattached, and C1–C7/depth/stencil empty (single-RT probes, not culprits).
- GLERR (20-line cap): `0x502` clusters after [DelTex, TexParam, Attach2D] and [BindRB, RBStorage, RB-attach] — Wine observes honest per-format errors **and keeps sweeping** (682 TEX2D, 287 RBSTORAGE, repeat checks). Readback/allocation errors are per-format results, not adapter-init fatals — answers defect 2's question for the capability phase.
- Only 1 TEXQUERY in 300s: Wine barely queries levels here, so defect 1's fix is verified by vectors only, with near-zero blast radius.
- No `glDraw*` issued in the entire run (`DRAW: first` absent, 0 present frames): wined3d never leaves capability probing. The boot canvas never updates.

Next (C7, different approach — format chasing is exhausted):
1. Unclassified depth/stencil-NONE attachments: log the texture NAME in TEX2D/TEX3D success lines and cover `glTexStorage2D/3D` (+ multisample-storage metadata) so every attachment resolves to a format or a proven-absent allocation.
2. Probe `EXT_color_buffer_float` availability in this SwiftShader path; if present, sized float color attachments may become renderable and the RGB32F/RGBA16F-class incompletes change meaning.
3. Present-path audit: the X11-mapped window's readback frames never visibly update the runtime canvas across 300s (early==final bytes) — verify whether `readbackAndPresent` frames reach the canvas at all, independent of the capability sweep.
4. Obtaining Wine `+d3d` logs in the spawned guest env (C5 handoff item 1) remains the highest-leverage unknown: which adapter-init bail-out actually repeats, now that per-format failures are proven non-fatal.

## Cycle 7 — depth/stencil-NONE classified; the loop has draws (complete)

Two offline findings first, both from already-saved traces (no build needed):
- The format sweep is a deterministic loop, proven by sequence analysis: C6's 679 `TEX2D` allocations match C5's first 679 one-for-one (676/679 exact-tuple), and C5's lines 679+ are an exact prefix-repeat of its own pass 1 (424/424). Restart gap is ~100 console lines: fresh FBO ids, a second full PROC re-sweep, near-instant re-init.
- **Correction of a C6 error:** C6 claimed "zero glDraw". That searched for the `gl64 DRAW: first` marker, which only fires for `glDrawElements`. `glDrawArrays` (fnId 510) has no such marker and was firing all along: 589 (C5) / 369 (C6) / 362 (C7) draws, spread uniformly through the sweep (per-format draw-verification), plus readbacks with err=0. The sweep draws successfully; it never *presents* (swaps=0 in every run).
- Decoded C5 pass-1 tail (lines 20539–20644): last probe → `RenderbufferStorage(DEPTH24_STENCIL8, err=0)` → attach → clear/depth/enable/viewport → **clear → drawArrays ×2 with readback err=0x0 each** → deletes → `glXMakeCurrent` + `glXDestroyContext` → 38× `glXGetFBConfigAttrib` → `glXCreateContext`/`MakeCurrent` → destroy again → 3× `glGetString` → new PROC sweep. No GL/shader error anywhere at the boundary: the pass **succeeds at GL level, then the context is deliberately torn down and rebuilt**.

Instrumentation + fixes (lane: `source/opengl/*`, `tools/rootfs64/libgl64/*`):
- `gl64 PHASE` clock (`bridgeElapsedSec`, steady_clock): proc-burst start/end (burst = contiguous `traceProc` run; full adapter re-init re-resolves ~500 names), `create-context`, `swap`, and `t=` on every incomplete-FBO line. Discriminates loop (identical sequences at fresh timestamps) from hang (one sequence, growing gaps).
- `tex=<bound id>` appended to `TEX2D`/`TEX3D` lines (field order preserved otherwise).
- **Immutable storage implemented end-to-end** (prime suspect for the 12 depth/stencil-NONE attachments): ABI 852/853/854 (`glTexStorage2D/3D/1D`, append-only both sides), guest wrappers + `E()` entries, host cases calling real `glTexStorage*` on the context thread with per-level metadata on success and honest driver errors otherwise (1D → w×1 2D). Guest shim rebuilt in `bw64-libgl64-gcc:bookworm` with the script's docker-path flags (603 defined global funcs = 600+3, SONAME ok, TexStorage symbols present) and re-zipped into all four `libGL.so.1` entries of `glibc-rootfs64.zip`/`wine64.zip` (clean rewrite, `unzip -t` ok, extracted SHA256 == built shim `37f31f45…`).
- Multisample paths now record metadata too (`RBSTOR-MS`/`TEXMS` trace lines, bound-texture coverage for 0x9100/0x9102); previously fire-and-forget with errors drained.
- Guest/host ABI re-verified after the append: 291 ids, 0 mismatches (`baldi-a3-c7-abi.log`).

Evidence: `baldi-a3-c7-{shim-build,rootfs,build,export}.log` all exit 0 (emcc at `nice -n 19`, emsdk sourced; export re-syncs `dist`). Soak per spec (`GL_VERSION=3.2 GL_TRACE=2 SOAK_SECS=300 BIND_NOW=1`, TAG=a3-c7): **first attempt failed pre-GL** with the known-flaky service wild jump (`unimpl opcode at RIP=0x10270`, pid=27, zero FIRST-traps — byte-identical signature to C4's failed attempt; preserved as `baldi-a3-c7-bootfail-*`), **retry exit 0**, MAPPED, page errors `[]`, player.log ENOENT. New shim proven live in-guest: `glTexStorage1D/2D/3D` now PROC HIT (were MISS).

Soak classification (300s, `baldi-a3-summary.json` "c7"): 68 checks, **0 MISSING**, 68 INCOMPLETE (all bound=27, t=66.5→289.4s, mean gap 3.3s, max 38s — steady progress, no stall); 362 draws uniform across the run; readback 150×err=0 / 42×`INVALID_OPERATION` (honest level-miss) / 1×`INVALID_ENUM`; creates=3, destroys=2 (both early, ~66s), swaps=0; screenshots static (early==final bytes, boot canvas).
- The 12 unclassified depth/stencil attachments are **closed**: all 8 distinct texture names resolve via the new `tex=` index to **failed 3D depth/stencil allocations** (`0x806f` 16³, DEPTH_COMPONENT16/24/32F, DEPTH24_STENCIL8, DEPTH32F_STENCIL8, err=`0x502`) — genuinely invalid in WebGL2 on any implementation. **Legitimate.**
- The TexStorage hypothesis is **refuted by measurement**: `TEXSTOR` calls = 0 (resolved but never called in this phase); multisample calls = 0 likewise. The implementation stays (later device phases may use it) but it was never the depth-NONE source.

Verdict: **LOOP, not stall — and a healthy-looking one.** Passes run to completion with successful draws + readbacks, then deliberate teardown + full re-init. No GL error aborts any sweep, so hypotheses (b) "one init-fatal GL error" is out for the sweep phase; remaining are (a) Unity retrying `D3D11CreateDevice` after a *post-sweep* failure, or Wine cycling adapters — indistinguishable from the GL side. C6's "no draws" premise is retracted; the open question moves up one level: what fails *after* a successful capability/functional sweep.
- C8: add PHASE logs to destroy/MakeCurrent, capture a restart with timestamps (needs >300s or luck — C7's 300s covered exactly one pass), and, highest leverage, Wine `+d3d` logs in the spawned guest env (orchestrator lane) to see the post-sweep bail-out; plus required-vs-probed format analysis (which honest failures, e.g. float renderability, the real backbuffer path actually needs).

## Cycle 8 — both ends of the missing present (complete)

Question from C7: draws happen (362–589 `glDrawArrays`/run) but swaps stay 0 — the guest renders into buffers that never present. C8 attacks both ends: (1) bridge-side PHASE logging of the whole swap/destroy/reinit path; (2) the wait hypothesis (fence/sync/swap that never signals).

Pre-build mining of the C7 trace (exact fnId-boundary counts, fixing C7's own substring-count method) already half-answered it: `FenceSync`/`ClientWaitSync`/`WaitSync`/`DeleteSync`/`GetSynciv` = **0 calls each**, `Flush` = 0, `BlitFramebuffer` = 0, `SwapBuffers` = 0, `Finish` = 1 — against 362 draws, 192 clears, 164 `GetTexImage`, 662 `GetError`. Wine never waits on anything during the sweep; it continuously probes (draw → read back → check error → next format). Hypothesis (c) "waiting on a fence that never signals" is **out**.

Bridge changes (`source/opengl/gl64bridge.cpp` only; no ABI/shim changes needed — the swap path is GLX-only here: `glXSwapBuffers` is the sole presenter, MESA/SGI interval variants are local stubs):
- `PHASE: make-current t=… drawable=…` on both `glXMakeCurrent` variants.
- `PHASE: destroy-context t=…`.
- `PHASE: swap t=… drew=…` consuming the existing `g_glDrew` flag (set by every draw path): distinguishes draws-without-swaps from empty presents, had any swap ever arrived.

Evidence: build exit 0 (`baldi-a3-c8-build.log`, `nice -n 19`, emsdk sourced), export exit 0. Selftest **not runnable in this environment**: the `wasm64-selftest` target builds *without* `-DBOXEDWINE_OPENGL` (makefile l.31 vs l.81), so C7/C8 edits — confined to `gl64bridge.cpp`, which compiles out there — cannot affect it; under headless node it dies at `SDL_Init` ("No audio context available") before test 1 (`baldi-a3-c8-selftest.log`). Same rationale as C5/C6's documented skip, stronger (target excludes the edited TU). Soak per spec (TAG=a3-c8, 300s): exit 0 first try, MAPPED, page errors `[]`, player.log ENOENT, screenshots static (early==final, boot canvas).

C8 soak numbers (`baldi-a3-summary.json` "c8"): 68 checks / 0 MISSING / 68 INCOMPLETE (bound=27, t=67.7→294.2s); 355 draws; readback 142×ok / 42×honest-`INVALID_OPERATION` / 1×`INVALID_ENUM`; 0 shader/link failures; creates=3, destroys=2 (both at t≈0.5/1.1s — early churn only, no mid-run restart in 300s), **swaps=0**. Main PROC resolution finishes by ~t=13s; the rest is the slow format sweep. `TEXSTOR` calls still 0.

Answer: **wined3d NEVER calls swap — zero times in 300s, zero times across all C5–C8 traces (>2400s combined) — and never waits on any fence, sync, flush, or blit either.** After each probe draw comes readback-verification and object teardown (C7's decoded pass tail), never a present: there is no swapchain because device init never completes, so there is nothing that *could* swap yet. "Renders into buffers that never present" is therefore the wrong frame — the draws are capability-probe renders into temporary FBOs, and the loop is Unity↔Wine device-creation cycling with each cycle's GL work succeeding. The C8 instrumentation (swap/drew + destroy/makecurrent timestamps) stays in the tree to recognize the moment a real present path first appears.

Wanted from the orchestrator's WINEDEBUG lane (O2 plumbing — not touched here): `WINEDEBUG=+d3d11,+d3d,+wined3d` reaching `BALDI.exe`, to see (a) each `D3D11CreateDevice` attempt's requested feature level/flags, (b) which post-sweep step returns the failure Unity retries on, and (c) whether the retry sequence matches our ~400s GL pass period. From the GL side there is nothing left that fails: allocations that should succeed do, draws execute, readbacks verify, errors observed are honest per-format results.

## Cycle 9 — Wine-side eyes: max FL is 9_3, D3D11 is structurally unreachable (complete)

O2's plumbing works: `WINEDBG_CHANNELS=+d3d,+d3d11,+wined3d` delivered **3792 wined3d (`d3d`-channel) lines** to the C9 console (each doubled by the fd=2 relay; 701 unique). No source changes were needed for this cycle — probe + analysis only, per the C9 mandate.

(a) **Feature level/flags per attempt: no attempt exists.** Zero `d3d11`-channel lines in 300s — Unity never reaches `D3D11CreateDevice`. What Wine *does* announce: `wined3d_driver_info_init GPU maximum feature level 0x9300` = **9_3**, despite all three A2-era gate conditions showing FOUND (GL 3.2, `ARB_sampler_objects`, `ARB_polygon_offset_clamp`) plus `ARB_texture_cube_map_array` + `ARB_draw_buffers_blend`. Mechanism, from the vendored `/tmp/adapter_gl.c:1242` (`feature_level_from_caps`): `shader_model = min(vs, ps, max(gs,3), max(hs,4), max(ds,4))`. WebGL2 has **no geometry shaders** (0 GS procs resolved, 0 GS blocks/samplers in caps), so `gs_version = 0` → `max(0,3) = 3` → `shader_model ≤ 3` **no matter what vs/ps report** → falls to the `SM>=3 + 16384px + 8 buffers` branch → exactly 9_3. Unity 2020.3 D3D11 requires 11_0; any future attempt must fail against the 9_3 ceiling (the A1 `80004005` symptom). Faking GS support to lift the cap is rejected: Wine would then emit real GS shaders that WebGL2 cannot compile — a louder failure, not progress.
(b) **Failing post-sweep step: none observed — the sweep doesn't finish in 300s.** The run ends mid-`init_format_fbo_compat_info` (41 formats walked: B8G8R8…R16G16_SINT of 100+; FBO checks only t=104.9→300.5s, throttled further by trace I/O). Only honest per-capability results: 2 err (`0x500` from `glTexSubImage2D` @adapter_gl.c:653 caps upload; `0x502` from the post-pixelshader blending check @utils.c:2686) + 46 warn (R32G32B32_FLOAT / SNORM renderability, all "no fallback" continuations). Nothing aborts; single adapter init, no retry inside 300s.
(c) **Retry timing: no restart in 300s** (one `wined3d_adapter_gl_init`, ordinal 0). C5's restart boundary sits past ~400s; combined with the ~7s/format rate, a full capability pass needs ~700s+ under SwiftShader. The C5 "loop" is therefore consistent with Unity retrying device creation on a multi-minute period after each fully-swept-but-FL-capped init.

Collateral, directly from the trace (queued, not done in C9): `Disabling ARB_texture_multisample because immutable storage is not supported` — Wine wants `glTexStorage2DMultisample`, which C7 didn't implement (TexStorage2D/3D resolve HIT but are never called in this phase; multisample paths 0 calls). Small, in-lane, now Wine-motivated: ABI + shim + host case, then re-probe to see the warning disappear. Build-scripts branch closed too: `tools/buildWine/buildAll.sh` uses `-DNDEBUG -O2` with **no `--disable-debug** — the absent `d3d11` lines are behavioral (never reached), not compiled out; in-game wined3d tracing is fully possible.

Consequence for the goal: **the D3D11 path cannot reach gameplay on WebGL2** — FL 11_0 is unreachable without geometry shaders, independent of every format/readback fix since A2. All D3D11-side work is now bounded by that ceiling. The viable gameplay path is forcing Unity onto its OpenGL renderer (`-force-glcore` via the `GAME_ARGS` probe knob — no source change), where feature levels don't apply and the GL 3.2 bridge is native. That plus the multisample-storage completion is the proposed C10.

Evidence: `baldi-a3-c9-{run,console,player,errors,shot,frame,early}.log/png` (exit 0, MAPPED, errors `[]`, screenshots static); counts in `baldi-a3-summary.json` "c9" (34 checks/0 MISSING, 83 readbacks ok, 219 draws, 0 swaps — the no-present verdict stands with Wine-side corroboration: no swapchain phase exists yet).

## Cycle 10 — OpenGL pivot: bridge ready, build refuses (complete)

Step 1 — shader-bundle verification (whole-tree scan, `/tmp/stage/baldi`, 167 files >1KB): game shaders are **DXBC-only** (`sharedassets*.assets`, `resources.assets`, `globalgamemanagers.assets` — zero GLSL/GLES markers; apparent 'gles' hits proven false positives: mesh-binary soup and "ToggleSuperSpeed"). But `BALDI_Data/Resources/unity default resources` (built-ins) carries **real desktop-GL and GLES programs**: `#version 150` ×6, `#version 430` ×55, `#version 310 es` ×39, `#version 300 es` ×6, `#version 100` ×6 (`GL_ARB_explicit_attrib_location`, `420pack`). The Oct-3 "no glcore shaders" note is TRUE for game shaders, FALSE for built-ins — and Unity fail-fasts on forced-but-unbaked APIs anyway, so the distinction doesn't unlock gameplay. Proceeded per plan.

Step 2 — multisample immutable storage (Wine-motivated, from C9's `Disabling ARB_texture_multisample` warning; root cause found in `adapter_gl.c:3663`: the flag derives from the extension *string*, and `g_extList[]` lacked both names): ABI 855/856/857 (`glTexStorage2DMultisample/3DMultisample` — identical layout/semantics to `TexImage*Multisample`, one shared host path — plus `glGetMultisamplefv` via `GLctx.getMultisamplefv` since Emscripten exports no C symbol). Shim rebuilt (606 defined global funcs = 603+3; `readelf` truncates the long names — verified via binary strings instead), all four rootfs entries re-zipped with SHA256 match, wasm rebuilt exit 0, exported. **Verified**: in the `mscheck` soak the warning is 0, `FOUND: GL_ARB_texture_storage_multisample`, `GL CORE: GL_ARB_texture_multisample support` stands (procs resolve; 0 calls in this phase — enabled but unexercised).

Step 3 — backend probes (300s soaks, `+d3d`):
- `-force-glcore`: RECOGNIZED — `Forcing GfxDevice: OpenGL Core`, opengl32.dll loads — then **refused**: `Forced GfxDevice 'OpenGL Core' was not built from editor, shaders will not be available` → `InitializeEngineGraphics failed`, clean exit(0)s, **zero** GL/PROC/wined3d activity (init fails at line 4081/4097, soak idles). Unity will not run GL shaders it didn't bake, even magenta-fallback.
- `-force-gles3`: **not a valid standalone flag** — silently ignored, falls back to the D3D11 path (595 PROC, 376 TEX2D mid-sweep, full wined3d format probing, engine version line only).

C10 criteria (`GfxDevice created, scene loading begins`) NOT met on either flag; C11 gameplay impossible on this build through any API. Per the task's STOP condition, no further probe cycles on Baldi: the blocker is the shipped shader payload, not the bridge. Fallbacks for the orchestrator: (a) a Unity build of Baldi (or any sample) with OpenGLCore in its baked graphics APIs — our `#version 150` path + GLSL translator is exactly its tier; (b) a tiny GLCore Unity probe to validate the bridge end-to-end (device → scene → present) independent of Baldi's content; (c) D3D11 stays capped at FL 9_3 (C9) regardless. No CPU/kernel files touched (selftest rationale per C8 stands).

Artifacts: `baldi-a3-c10-{abi,shim-build,shim-build2,rootfs,build,export,export2}.log`, three full probe sets (`glcore`, `gles3`, `mscheck` consoles/runs/screenshots), summary.json entries.





