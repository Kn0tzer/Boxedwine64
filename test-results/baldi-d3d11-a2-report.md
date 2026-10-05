# A2 — real GL 3.x entry points for wined3d (Baldi's Basics / Unity 2020.3 D3D11)

**Status:** implementation + measurement. **Result: the A2 regression is gone and the D3D11
device now gets *real* framebuffer/sampler state instead of silent no-ops — but it still does
not reach `InitializeEngineGraphics` success, for a newly-diagnosed reason (§5).**

**Repo:** `/home/ubuntu/boxedwine64` · **Date:** 2025-10-04 · **Guest:** Unity 2020.3.38f1 at `/tmp/stage/baldi`
**Lane:** `source/opengl/gl64bridge.cpp`, `source/opengl/gl64bridge_abi.h`, `tools/rootfs64/libgl64/*`,
`web/tests/scratch-baldi.mjs`. No commits. No `web/` frontend files touched.

---

## 0. Starting state (what the previous attempt actually left in the tree)

The diagnosis said A2 had implemented §3 steps 0–4. In the tree that was only **half** true:

| Layer | State found at start |
|---|---|
| `tools/rootfs64/libgl64/libgl64.c` (guest shim) | **complete** — 127 new `GL64_fn_*` ids, ~200 real `API void glFoo(...)` wrappers, all `E(glFoo)` entries in `g_procs[]`, new `g_extList[]` entries |
| `source/opengl/gl64bridge_abi.h` (host enum) | **empty** — ended at `GL64_fn_glVersionMode = 620`; none of the 127 ids existed |
| `source/opengl/gl64bridge.cpp` (host switch) | **empty** — zero `case GL64_fn_glGenFramebuffers:` etc. |

So the guest shim trapped 127 fn ids into a host switch whose `default:` arm only logs
`gl64: unimplemented fn id` and returns 0. Every new proc was a *traced but inert* call.

**This fully explains the inherited "regression".** `baldi-a2-gl32-run.log` (00:50) and
`baldi-a2c-gl33-run.log` (01:17) both show `CPU64: exit_group syscall, status=1`, and so do
the two "oldshim" bisect runs — because the **host** was the missing half in every one of
them; swapping `libGL.so.1` back could not change anything. It was not a `GL_VERSION=3.3`
hazard (H4/O5) and not the extension string. Fixing the host side is what removed it.

---

## 1. What was implemented

### 1.1 Host enum (`gl64bridge_abi.h`) — 127 new ids, 630–843

Written with **explicit** values (not implicit `++`) so any future guest/host drift is visible
in review. Verified byte-identical against the guest enum by a scripted comparison:

```
guest ids: 286 | MISMATCH: none
```

### 1.2 Host switch (`gl64bridge.cpp`) — real 1:1 WebGL2 implementations

| §3 step | Family | Host case |
|---|---|---|
| 1 | **FBO / renderbuffer** (22 ids) | `glGenFramebuffers`…`glBlitFramebuffer`, `glDrawBuffers`, `glReadBuffer`. `glGen*` now **write real ids into the guest array** via `GenKind::{Framebuffer,Renderbuffer,Sampler}` — the pre-A2 `gl64_noop` silently discarded it, so wined3d was binding uninitialised guest-stack garbage as its FBO name. `glCheckFramebufferStatus` returns the **real** status and logs non-`COMPLETE` under `BW64_GLTRACE`. |
| 2 | **Sampler objects** (14 ids) | all real; `glSamplerParameter*`/`glGetSamplerParameter*` marshal one guest element. **Load-bearing**: `feature_level_from_caps()` gates *every* FL ≥ 10_0 on `ARB_SAMPLER_OBJECTS`. |
| 3 | **3D / array textures** (6 ids) | `glTexImage3D`, `glTexSubImage3D`, `glCompressedTexImage3D`, `glCompressedTexSubImage3D`, `glTexImage{2,3}DMultisample`. |
| 4 | **MRT / frag data** (2 ids) | `glBindFragDataLocation` no-op (no GLES3 equivalent), `glGetFragDataIndex` → `-1`. |
| 5 | **Uniform blocks** (6 ids) | `glBindBufferRange`, `glBindBufferBase`, `glGetUniformBlockIndex`, `glUniformBlockBinding`, `glGetActiveUniformBlockiv/Name` — all real (SM4 constant buffers). |
| 6 | **Buffer objects** (4 ids) | `glBufferStorage` emulated with `glBufferData` (Emscripten has no `bufferStorage`); `glCopyBufferSubData`, `glGetBufferSubData`, `glGetBufferParameteriv` real. |
| 7 | **Int uniforms / introspection** (17 ids) | `glUniform2i/3i/4i`, `glUniform2iv/3iv/4iv`, `glGetUniform{f,i}v`, `glGetActiveUniform` (desktop 7-arg spelling), `glGetAttachedShaders`, `glGetShaderSourceImpl`, `glGetTexParameteriv`, … |
| 7 | **Indexed state** (9 ids) | `glEnablei/Disablei/IsEnabledi`, `glBlendEquation[i|Separatei]`, `glBlendFunc[i|Separatei]`, `glColorMaski`, `glMinSampleShading` — routed through `GLctx` (WebGL2 has them; Emscripten exports no C symbol). |
| 8 | **Instancing** (7 ids) | `glVertexAttribDivisor`, `glDrawArraysInstanced`, `glDrawElementsInstanced`, `glDrawElementsInstancedBaseVertex[BaseInstance]`, `glDrawElementsBaseVertex`, `glMultiDrawElementsBaseVertex`. |
| 9 | **Safe no-ops** (~20 ids) | debug messages, transform feedback, `glTexBuffer*`, `GL_NV_*`, `glPointParameter*`. Now at least *traced and routed* instead of an unaudited guest-side no-op. |
| 11 | **Capability overrides** | `GL_MAX_SAMPLES=4`, `GL_MAX_FRAMEBUFFER_WIDTH/HEIGHT`, `GL_MAX_COLOR_ATTACHMENTS=8`, `GL_MAX_DRAW_BUFFERS=8`, `GL_MAX_VERTEX_STREAMS=1`, `GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS=32` in the `glGetIntegerv` override table. |

Procs that Emscripten 6.0.9's `system/lib/gl/webgl2.c` does **not** export (`glFramebufferTexture`,
`glSamplerParameterIiv/Iuiv`, `glIsEnabledi`, indexed blend, `glMinSampleShading`,
`glTexImage2DMultisample`, base-vertex draws) are implemented against the raw `GLctx` WebGL2
context inside the same main-thread hop — verified against `system/lib/gl/webgl*.c`, not guessed.

### 1.3 Target selection — the fix that made the family usable at all

`glClear`/`glDrawArrays`/`glDrawElements`/`glEnd` force-bound the bridge's own FBO
(`g_emFbo`, the only target with a DEPTH attachment). With wined3d now really using FBOs that
is *wrong*. Added:

* `g_guestFboBound` / `g_guestFbo` — set by `glBindFramebuffer`; `bindDrawTarget()` backs off
  once the guest owns the target, and `readbackAndPresent()` reads back **the guest's** FBO.
* `bindGuestTarget()` — re-binds `g_guestFbo` inside the same `glOnMain` closure as every
  framebuffer op, because wined3d's `glBindFramebuffer` and `glFramebufferTexture2D` are
  separate traps and Emscripten's LEGACY_GL_EMULATION flush rebinds in between (this file's own
  `glClear`/`glEnd` comments already document that for the fixed-function path).

### 1.4 Two format translations found by measurement (§5)

* `bgraToRgba()` — wined3d maps `DXGI_FORMAT_B8G8R8A8_*` to the **desktop-only** `GL_BGRA`
  (0x80E1), which WebGL2 rejects with `GL_INVALID_ENUM`. Swizzles bytes and rewrites the format,
  **including on NULL-pixel allocations** (which is exactly the render-target case).
* `glesTexFormatFixup()` — WebGL2 rejects `GL_UNSIGNED_INT_2_10_10_10_REV`; expands each 32-bit
  word to 4 bytes and declares `GL_UNSIGNED_BYTE`.

Applied in `glTexImage2D`, `glTexSubImage2D`, `glTexImage3D`, `glTexSubImage3D`.

### 1.5 Guest shim (`tools/rootfs64/libgl64/`)

* `gl_version_mode()` now accepts the host's new `33` return value.
* `g_extList[]` **and** the monolithic `GL_EXTENSIONS` string both grew (kept in sync as the
  file's own comment demands): `GL_ARB_sampler_objects`, `GL_ARB_framebuffer_object`,
  `GL_ARB_uniform_buffer_object`, `GL_ARB_draw_buffers`, `GL_ARB_instanced_arrays`, and (cycle 2)
  `GL_ARB_polygon_offset_clamp`, `GL_ARB_draw_buffers_blend`, `GL_ARB_texture_cube_map_array`.
* **New finding:** `feature_level_from_caps()` (`adapter_gl.c:1252-1254`) needs **all three** of
  `WINED3D_GL_VERSION_3_2 && ARB_POLYGON_OFFSET_CLAMP && ARB_SAMPLER_OBJECTS` before it returns
  *any* level ≥ 10_0. `GL_ARB_polygon_offset_clamp` was missing, so FL stayed capped at 9_3 even
  with samplers real. `glPolygonOffsetClamp` is now implemented (forwarded to `glPolygonOffset`,
  clamp dropped — WebGL2 has none) and advertised. 10_1 additionally needs
  `ARB_TEXTURE_CUBE_MAP_ARRAY` + `ARB_DRAW_BUFFERS_BLEND`, both of which are now real and advertised.
* `libgl64_stubs.h`: the three `GLSTUB`s that collided with real wrappers were removed (pre-existing).
* Version stays **3.2** by default; `BW64_GLVERSION=33` is now an explicit, working opt-in probe.

---

## 2. Build + self-test

| Step | Command | Result |
|---|---|---|
| Guest shim | `gcc -shared -fPIC -O2 -fvisibility=hidden -nostdlib -ffreestanding -Wl,-soname,libGL.so.1` (linux/amd64) | **BUILD_OK**, 600 dynamic `FUNC GLOBAL` exports, SONAME `libGL.so.1` |
| Host | `nice -n 19 make -C project/emscripten wasm64-mt` | **exit 0** (8 successive builds; logs `test-results/baldi-a2d-build*.log`) |
| Self-test | `node Build/Wasm64SelfTest/boxedwine64-selftest.js --x64-selftest` | **`=== self-test summary: 256 passed, 0 failed ===`** (`test-results/baldi-a2d-selftest-run.log`) |
| Rootfs restage | `zip` update of `libGL.so.1` into `web/runtime/glibc-rootfs64.zip` | verified by extracting the entry and `sha256sum`-matching the built `.so` |
| Export | `node tools/browser/build.mjs` | `Browser export: dist/` |

> **Environment notes for the reviewer** (both are sandbox facts, not regressions):
> * `tools/rootfs64/build-libgl64.sh` needs an x86_64 toolchain. The host is aarch64 and the
>   `boxedwine64/wine64-debian:bookworm` image is not present, so the build was run through
>   `docker run --platform linux/amd64 debian:bookworm` with the *identical* flags the script
>   uses. The script itself is unmodified. The resulting container was committed as
>   `bw64-libgl64-gcc:bookworm` so later builds are ~2 s instead of ~2 min.
> * For the same reason `tools/rootfs64/build-wine64-zip.sh` cannot run here (no wine64 image),
>   so only the one file that changed was re-zipped. **`build-wine64-zip.sh` still needs a full
>   run on a machine with the image before release.**
> * The self-test binary links SDL; under headless node it needs `globalThis.screen` and a
>   CommonJS entry point (the repo's `package.json` sets `"type":"module"`). Wrapped in
>   `Build/Wasm64SelfTest/run-selftest.cjs` (build dir, not tracked). The selftest target is built
>   **without** `-DBOXEDWINE_OPENGL`, so neither shim can mask a bridge regression.

---

## 3. Probe outcomes

All runs: `TAG=a2d-* GL_TRACE=2 BIND_NOW=1`, 60–90 s soak, headless chromium + SwiftShader.

| Config | mapped | non-zero `exit_group` | page errors | PROC MISS | PROC HIT | incomplete-FBO checks | verdict |
|---|---|---|---|---|---|---|---|
| A1 baseline (pre-A2, `baldi-d3d11-a1-run.log`) | yes | 0 | `[]` | 496 | 100 | 0 (all no-ops) | clean `E_FAIL` (`80004005`) |
| A2 inherited (`baldi-a2c-gl33-run.log`) | **no** | **1** | `[]` | 0 | 0 | – | guest died before the sweep |
| **A2 `GL_VERSION=3.2`** (`baldi-a2d-final-*`) | **yes** | **0** | **`[]`** | **362** | **233** | 134 | **regression gone; real FBO path live** |
| **A2 `GL_VERSION=3.3`** (`baldi-a2d-gl33-*`) | **yes** | **0** | **`[]`** | 362 | 233 | 94 | **3.3 no longer crashes either** |

Key deltas vs A1:

* `PROC HIT` **100 → 233**, `PROC MISS` **496 → 362**, and **zero** `gl64: unimplemented fn id`
  lines — all 127 new ids resolve to real host cases.
* **Zero** `PROC MISS` for any FBO / sampler / 3D-texture / UBO core name.
* The guest now actually drives wined3d's render-target setup: the console tail is full of
  `glGenRenderbuffers` → `glBindRenderbuffer` → `glRenderbufferStorage` →
  `glFramebufferRenderbuffer` → `glFramebufferTexture2D` → `glCheckFramebufferStatus`, with
  `bound=20` proving wined3d is using **its own** framebuffer (the bridge's FBO is no longer
  being force-bound over it).
* The `exit_group status=1` / "memory access out of bounds" failures from the inherited A2/A2c
  runs **do not reproduce** in any configuration, at 3.2 or 3.3.

Test-harness fixes (lane: `scratch-baldi.mjs`):

* `art('png')` produced `…-png` with **no extension** → `page.screenshot` threw
  `path: unsupported mime type "null"` before the run could finish. Renamed to `art('shot.png')`.
* `FS.readFile()` was decoded blindly, yielding the literal `[object Object]` in `player.log`.
  Now normalised across `string | ArrayBuffer | TypedArray | Promise` with `await`, and errors are
  reported as `name/errno`. **This revealed the real fact in §5: `player.log` does not exist
  (`ErrnoError/44` = ENOENT) — Unity never reaches the point of opening it.**

---

## 4. Pass criteria

| Criterion | Result |
|---|---|
| (a) rendered gameplay | **no** — guest window maps, but Unity never opens `player.log`, so no graphics init at all |
| (b) GfxDevice init success / past `Forcing GfxDevice: Direct3D 11` | **not reached** — and the failure is now *earlier and better characterised* (below) |
| (c) documented new failure point with evidence | **yes** — §5 |

---

## 5. New, documented failure point (with evidence)

**wined3d's render targets never become complete, and Unity therefore never starts graphics init.**

Evidence — `test-results/baldi-a2d-final-console.log`:

```
gl64 FBO: check status target=0x8d40 -> 0x8cd7 (bound=20)   × 97   GL_FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT
gl64 FBO: check status target=0x8d40 -> 0x8cd6 (bound=20)   × 36   GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT
gl64 FBO: check status target=0x8ca9 -> 0x8cd6 (bound=0)    ×  1   (the default framebuffer, once)
```

`0x8CD7` **MISSING_ATTACHMENT** means `glFramebufferTexture2D` / `glFramebufferRenderbuffer`
left nothing attached. That is *not* the format problem any more: the trace added this cycle
shows every `glTexImage2D`/`glRenderbufferStorage` combination wined3d issues now returns
`err=0x0`, with exactly one residual exception:

```
gl64 TEX2D: target=0x84f5 lvl=0 ifmt=0x8051 16x16 fmt=0x1907 type=0x1401 err=0x500
```

`target=0x84F5` is **`GL_TEXTURE_RECTANGLE`** — a desktop-GL-only target GLES3/WebGL2 does not
have. Everything else (`GL_RGBA8`, `GL_RGB8`, `GL_RGBA16F`, `GL_RGB5_A1`, cube-array targets
`0x8515..0x851A`, `GL_DEPTH24_STENCIL8`, …) now allocates cleanly.

Also ruled out by measurement: `bindGuestTarget()` (re-binding the guest FBO inside every FBO op)
did **not** change the counts (134 vs 131/140 across cycles) — so the attachments are not being
lost to an Emscripten framebuffer rebind; they are genuinely rejected or never issued.

**The open question this hands to A3:** 97 `MISSING_ATTACHMENT` checks against one stable FBO
name (`bound=20`) means wined3d believes it attached something and WebGL2 disagrees. The two
remaining candidates, in the order I would test them:

1. **`GL_TEXTURE_RECTANGLE` (0x84F5).** wined3d falls back to rectangle textures when it decides
   a target cannot be a power-of-two texture. We advertise `GL_ARB_texture_non_power_of_two`, so
   that fallback should be off — but a `GL_TEXTURE_RECTANGLE` upload *is* being issued and it
   fails. Either suppress the rectangle path or translate `GL_TEXTURE_RECTANGLE` → `GL_TEXTURE_2D`.
   Note `glBindFragDataLocation`/`glGetFragDataIndex` are also no-ops here, so MRT fragment
   outputs all collapse to location 0 — this is the other half of the same problem and needs the
   GLSL-1.50 → GLSL-ES-3.00 `layout(location=N) out` rewrite (A3 work, already flagged).
2. **`GL_DEPTH_COMPONENT` / depth-stencil attachment mismatch.** The 36 `INCOMPLETE_ATTACHMENT`
   checks are consistent with a depth attachment whose `glRenderbufferStorage` internal format
   (`GL_DEPTH_COMPONENT16` seen in `RBSTORAGE` logs) is not the one wined3d then queries, or with
   wined3d attaching a depth *texture* (`GL_DEPTH_ATTACHMENT` + `GL_TEXTURE_2D`) that WebGL2
   requires `EXT_webgl_depth_texture` for.

---

## 6. Remaining gaps vs diagnosis §3

| Step | Status |
|---|---|
| 0 — version probe | done; **3.2 is the default and works**; `33` added as a working opt-in and also verified clean |
| 1 — FBO / renderbuffer | done (real), **except** `GL_TEXTURE_RECTANGLE` and `glFramebufferTexture{1,3}D` (probe-only, no-ops) |
| 2 — sampler objects | done (real) |
| 3 — 3D / array textures | done (real) |
| 4 — MRT / frag data | **partial** — `glBindFragDataLocation` cannot exist in GLES3; needs the shader-side rewrite |
| 5 — uniform blocks | done (real) |
| 6 — buffer objects | done (`glBufferStorage` emulated; **`glMapBufferRange` still a no-op returning 0** — diagnosis O3, unresolved) |
| 7 — cheap forwarding | done |
| 8 — instancing / base vertex | done (real via `GLctx`) |
| 9 — no-op deny-list | **not done** — `glXGetProcAddressARB` still returns `gl64_noop` rather than `NULL` for step-9 procs. Every id is now at least routed to the host and traced, so the audit trail exists, but wined3d still believes unimplemented extensions work. (362 remaining `PROC MISS` are ARB/EXT/ATI/NV aliases it resolves but never calls.) |
| 10 — capability correctness | done for the FBO/MRT names; `GL_MAX_TEXTURE_IMAGE_UNITS` already forced to 8 |

## 7. A3 recommendation

1. **Chase `GL_TEXTURE_RECTANGLE` first** — it is the single remaining rejected format and the
   most likely cause of the 97 `MISSING_ATTACHMENT` checks (§5). One more
   `glTexImage2D`/`glTexParameteri` trace that prints the *target enum name* and whether
   `glFramebufferTexture2D` followed, on the same `bound=20` FBO, should settle it in one cycle.
2. **Instrument the wined3d side.** The remaining unknown is whether wined3d is *issuing* the
   attach calls at all. `adapter_gl.c`'s `wined3d_fbo_*` paths need `WINEDEBUG=+wined3d`, and
   diagnosis **O2** still blocks that (`project/emscripten/wine64-launcher.js:191-196`: WINEDEBUG
   set via `prefixEnv()` does not reach in-session app spawns). Fixing that plumbing unblocks the
   one channel that would answer this definitively.
3. **MRT rewrite** — `glBindFragDataLocation` is unavailable in GLES3, so A3 must translate the
   GLSL-1.50 `gl_FragData[i]` output the bridge already rewrites into
   `layout(location=i) out vec4`, and keep the name→index map the host currently discards.
4. **`glMapBufferRange`** (diagnosis O3) becomes load-bearing once a device exists: wined3d's
   dynamic-buffer path reads uninitialised guest memory today.
5. **Step 9/10 deny-list** last — it is a hardening step and only meaningful once the mandatory
   families are demonstrably sufficient.
