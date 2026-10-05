# A1 — Baldi's Basics (Unity 2020.3) `D3D11CreateDevice` → `E_FAIL`: root-cause analysis

**Status:** ANALYSIS ONLY. No source files were modified.
**Repo:** `/home/ubuntu/boxedwine64` · **Date:** 2025-10-04 · **Guest:** Unity 2020.3.38f1 (8f5fde82e2dc) at `/tmp/stage/baldi`

---

## 0. Artifacts collected

| File | What it is |
|---|---|
| `test-results/baldi-d3d11-a1-run.log` | stdout of `GL_VERSION=3.2 GL_TRACE=2 SOAK_SECS=30 BIND_NOW=1 node web/tests/scratch-baldi.mjs` |
| `test-results/baldi-d3d11-console.log` | full browser console of that run (3422 lines; PROC block = lines 779–2274) |
| `test-results/baldi-d3d11-player.log` | guest `player.log` tail (`Forcing GfxDevice: Direct3D 11` → `InitializeEngineGraphics failed`) |
| `test-results/baldi-d3d11-a1.png` | screenshot at end of soak (`baldi.png`) |
| `test-results/baldi-d3d11-errors.json` | page errors — `[]` (no WASM trap / abort) |
| `test-results/baldi-d3d11-a1-gl21-control-run.log`, `…-gl21-control-console.log` | control run with `GL_VERSION=2.1 GL_TRACE=3` |
| `test-results/baldi-d3d11-run.log` | earlier run, source of the verbatim `d3d11: failed to create device and context (80004005)` lines |

Reproduction status: **E_FAIL reproduced.** Page errors are empty, the guest window maps, Mono finishes, and Unity reaches `Forcing GfxDevice: Direct3D 11`. The console contains **496 `gl64 PROC MISS` and 100 `gl64 PROC HIT` lines**. This is not a crash — it is a clean, deliberate failure return.

---

## 1. Evidence

### 1.1 Guest side (`player.log`)

```
Initialize engine version: 2020.3.38f1 (8f5fde82e2dc)
[Subsystems] Discovering subsystems at path Z:/home/username/apps/UnitySubsystems
Forcing GfxDevice: Direct3D 11
d3d11: failed to create device and context (80004005).
d3d11: failed to create device and context (80004005).
d3d11: failed to create device and context (80004005).
Failed to initialize graphics.
InitializeEngineGraphics failed
PlayerInitEngineGraphics: InitializeEngineGraphics failed
```

`80004005` = `E_FAIL`. The message is Wine's own `ERR()` from `dlls/d3d11/device.c`, printed immediately after `wined3d_adapter_create_device()` returns a failure and before any of Unity's own D3D11 capability querying. **So the failure is inside `wined3d_device_create()`, not in Unity's feature-level negotiation.**

### 1.2 Host side — the PROC sweep

`source/opengl/gl64bridge.cpp:1367-1377` (`GL64_fn_traceProc`, gated on `BW64_GLTRACE`) logs every resolution:

```c
bool hit = args.a[1] != 0;
if (gt[0] != '3' || !hit)
    klog_fmt("gl64 PROC %s %s", hit ? "HIT " : "MISS", name);
```

Console (`baldi-d3d11-console.log`), the sweep is contiguous, lines 779 → 2274:

```
779:  gl64 PROC MISS glXCopyContext
1029: gl64 PROC MISS glFramebufferParameteri
1033: gl64 PROC MISS glBindFramebuffer
1036: gl64 PROC MISS glBindRenderbuffer
1039: gl64 PROC MISS glBlitFramebuffer
1042: gl64 PROC MISS glCheckFramebufferStatus
1045: gl64 PROC MISS glDeleteFramebuffers
1048: gl64 PROC MISS glDeleteRenderbuffers
1051: gl64 PROC MISS glFramebufferRenderbuffer
1054: gl64 PROC MISS glFramebufferTexture
1057: gl64 PROC MISS glFramebufferTexture1D
1060: gl64 PROC MISS glFramebufferTexture2D
1063: gl64 PROC MISS glFramebufferTexture3D
1066: gl64 PROC MISS glFramebufferTextureLayer
1069: gl64 PROC MISS glGenFramebuffers
1072: gl64 PROC MISS glGenRenderbuffers
1078: gl64 PROC MISS glGetFramebufferAttachmentParameteriv
1081: gl64 PROC MISS glGetRenderbufferParameteriv
1084: gl64 PROC MISS glIsFramebuffer
1087: gl64 PROC MISS glIsRenderbuffer
1090: gl64 PROC MISS glRenderbufferStorage
1093: gl64 PROC MISS glRenderbufferStorageMultisample
1172-1211: glGenSamplers … glGetSamplerParameterIuiv      (entire sampler-objects family MISS)
1335/1337: glTexBufferARB, glTexBufferRange                (MISS)
1356/1359: glTexImage2DMultisample, glTexImage3DMultisample(MISS)
1377: glTextureView                                     (MISS)
1425-1446: glGetActiveUniformBlockName/iv, glGetUniformBlockIndex, glUniformBlockBinding (MISS)
1660-1696: the whole *EXT framebuffer alias set* — glBlitFramebufferEXT, glBindFramebufferEXT,
           glGenFramebuffersEXT, glRenderbufferStorageEXT, … (MISS)
1794/1797: glTexImage3D, glTexImage3DEXT                 (MISS)
1993: glCompressedTexImage3D                            (MISS)
2044: glDrawBuffers                                     (MISS)
2155: glTexBuffer                                       (MISS)
```

**The entire framebuffer-object family, the entire sampler-objects family, all 3D-texture entry points, the entire UBO family and all MRT entry points are missing.** So are `glBufferStorage` (943), `glCopyBufferSubData` (969), `glVertexAttribDivisor` (2269), `glBindFragDataLocation` (1948), `glBlendFunci/Separatei`, `glColorMaski`, `glEnablei/Disablei`, `glUniform2i/3i/4i(+v)`, `glGetActiveUniform`, `glGetAttachedShaders`, `glGetShaderSource`, `glDrawArraysInstanced`, `glDrawElementsInstanced`.

### 1.3 What a MISS actually returns — **it is not NULL**

`tools/rootfs64/libgl64/libgl64.c:867-888`:

```c
API GLproc glXGetProcAddressARB(const GLubyte* name) {
    ... /* HIT -> real wrapper */
    // Unknown gl* function: trace it (hit=0) ... Then hand back a no-op so
    // opengl32's dispatch fills its table with a callable pointer (returning 0
    // would make wine think the driver is broken and disable OpenGL).
    GL64Args a = {{0}}; a.a[0] = (uint64_t)(uintptr_t)name; a.a[1] = 0;
    (void)gl64_trap(GL64_fn_traceProc, &a);
    return gl64_noop;
}
```

Two consequences that drive everything below:

1. wined3d's `load_gl_funcs()` (`dlls/wined3d/adapter_gl.c:2098-2763`) does `p = wglGetProcAddress(name)` for ~495 names **with no NULL check**, then `MAP_GL_FUNCTION(core, ext)` aliases core→ext when the core pointer is NULL. Because our bridge never returns NULL, wined3d's entire `gl_ops.ext` table is filled with **non-NULL no-op stubs**. wined3d then believes *every* GL extension it knows about is present.
2. `gl64_noop` is a `void` function that discards all arguments and returns 0. For an `out`-parameter entry point such as `glGenFramebuffers(n, ids)` or `glGenSamplers(n, ids)`, **the guest output array is never written** — wined3d proceeds with whatever garbage was on the guest stack.

### 1.4 What we advertise (`libgl64.c:449-503`)

```c
static const GLubyte* version21 = (const GLubyte*)"2.1 Boxedwine64";
static const GLubyte* version32 = (const GLubyte*)"3.2 Boxedwine64";
static const GLubyte* slv12 = "1.20";  static const GLubyte* slv15 = "1.50";
if (gl_version_mode() == 32) { version = version32; slv = slv15; } else { ... }
static const GLubyte* exts =
    "GL_ARB_multitexture GL_ARB_vertex_buffer_object GL_ARB_texture_non_power_of_two "
    "GL_ARB_shader_objects GL_ARB_shading_language_100 GL_ARB_vertex_shader "
    "GL_ARB_fragment_shader";
...
if (pname == 0x821D /*GL_NUM_EXTENSIONS*/) { params[0] = G_EXT_COUNT; return; }   // = 7
```

So the mismatch is **not** "we advertise extensions we can't back". It is the opposite, and worse in kind:

> **We advertise a GL 3.2 *core* version with GLSL 1.50, but back it with a GL 2.1-era, 7-extension, no-FBO proc set.**

### 1.5 Cross-check against Wine wined3d (`wine-9.0` sources)

**(a) GL 3.2 silently implies ~40 core extensions.** `adapter_gl.c:3438` parses `GL_VERSION`, then `:3480-3496`:

```c
for (i = 0; i < ARRAY_SIZE(core_extensions); ++i)
    if (!gl_info->supported[core_extensions[i].extension]
            && gl_version >= core_extensions[i].min_gl_version)
        ... gl_info->supported[core_extensions[i].extension] = TRUE;
```

with the table at `:3262-3340`, e.g.
`{ARB_FRAMEBUFFER_OBJECT, MAKEDWORD_VERSION(3,0)}`, `{ARB_MAP_BUFFER_RANGE, 3,0}`, `{ARB_DRAW_BUFFERS, 3,0}`, `{ARB_DEPTH_TEXTURE, 3,0}`, `{ARB_TEXTURE_ARRAY / EXT_TEXTURE_ARRAY, 3,0}`, `{ARB_MULTISAMPLE, 3,0}`, `{ARB_TEXTURE_RG, 3,0}`, `{ARB_COLOR_BUFFER_FLOAT, 3,0}`, `{ARB_UNIFORM_BUFFER_OBJECT, 3,1}`, `{ARB_DRAW_INSTANCED, 3,1}`, `{ARB_COPY_BUFFER, 3,1}`, `{ARB_SYNC, 3,2}`, `{ARB_SEAMLESS_CUBE_MAP, 3,2}`, `{ARB_DEPTH_CLAMP, 3,2}`, `{ARB_TEXTURE_MULTISAMPLE, 3,2}`, …

**(b) `supported[ARB_FRAMEBUFFER_OBJECT]` then wires up the FBO op table from the poisoned ext pointers** (`adapter_gl.c:3746-3770`):

```c
if (gl_info->supported[ARB_FRAMEBUFFER_OBJECT]) {
    gl_info->fbo_ops.glGenFramebuffers = gl_info->gl_ops.ext.p_glGenFramebuffers;   /* == gl64_noop */
    gl_info->fbo_ops.glBindFramebuffer = ...;  gl_info->fbo_ops.glCheckFramebufferStatus = ...;
    gl_info->fbo_ops.glFramebufferTexture2D = ...; gl_info->fbo_ops.glBlitFramebuffer = ...; }
```

wined3d now believes FBOs are fully usable and every FBO call is a silent no-op.

**(c) `E_FAIL` origin.** `adapter_gl.c:4573-4583` is the *only* `return E_FAIL` in `adapter_gl.c`:

```c
static HRESULT adapter_gl_init_3d(struct wined3d_device *device)
{
    wined3d_cs_init_object(device->cs, wined3d_device_gl_create_primary_opengl_context_cs, ...);
    wined3d_cs_finish(device->cs, WINED3D_CS_QUEUE_DEFAULT);
    if (!device->context_count)
        return E_FAIL;
    return WINED3D_OK;
}
```

`context_count == 0` is produced by `dlls/wined3d/device.c:1256-1319`:

```c
void wined3d_device_gl_create_primary_opengl_context_cs(void *object)
{
    if (!(context = context_acquire(device, target, 0))) { WARN("Failed to acquire context.\n"); return; }   /* L1270-1274 */
    if (!wined3d_allocator_init(...))                    { WARN("Failed to initialise allocator.\n"); ... return; }
    if (FAILED(hr = ...shader_alloc_private(...)))      { ERR("Failed to allocate shader private data, hr %#lx.\n", hr); ... return; }
    if (!(device->blitter = wined3d_cpu_blitter_create())) { ERR("Failed to create CPU blitter.\n"); ... return; }
    ...
}
```

**Each of those four bail-outs leaves `context_count == 0`, i.e. exactly `E_FAIL`.** This is the mechanism that produces `80004005`.

**(d) The feature-level gate.** `adapter_gl.c:1259-1305`:

```c
if (gl_info->supported[WINED3D_GL_VERSION_3_2]
        && gl_info->supported[ARB_POLYGON_OFFSET_CLAMP]
        && gl_info->supported[ARB_SAMPLER_OBJECTS])     /* <-- GL 3.3 core */
{
    if (shader_model >= 5 && supported[ARB_DRAW_INDIRECT] && supported[ARB_TEXTURE_COMPRESSION_BPTC])
        return WINED3D_FEATURE_LEVEL_11_1;
    if (shader_model >= 4) { ... return WINED3D_FEATURE_LEVEL_10; }
}
if (shader_model >= 3 && gl_info->limits.texture_size >= 4096 && gl_info->limits.buffers >= 4)
    return WINED3D_FEATURE_LEVEL_9_3;
```

`ARB_SAMPLER_OBJECTS` requires **GL 3.3** (`adapter_gl.c:3330`). We report `3.2`, and it is not in the 7-name list, so it is `FALSE` → the whole FL 10/11 branch is skipped and `max_feature_level` caps at **9_3** even though `shader_model == 5`.

### 1.6 Control experiment (`GL_VERSION=2.1`, `GL_TRACE=3`)

`baldi-d3d11-a1-gl21-control-run.log`: the guest dies **earlier and harder** — `CPU64: exit_group syscall, status=1` on `wine64 Z:\home\username\apps\BALDI.exe`, and the console has **0 `PROC MISS`** lines (the process dies before/inside the wined3d sweep). So lying less is *not* a fix: without the 3.2/GLSL-1.50 story wined3d does not even reach a clean E_FAIL. This is consistent with hypothesis 1 — the 3.2 advertisement is what gets us as far as `D3D11CreateDevice`.

---

## 2. Ranked root-cause hypotheses

### H1 — `max_feature_level` is capped at 9_3 because `GL_ARB_sampler_objects` is not advertised → **HIGH confidence**
`libgl64.c:465` reports `3.2 Boxedwine64`; `ARB_SAMPLER_OBJECTS` needs 3.3 (`adapter_gl.c:3330`) and is absent from `g_extList[]` (`libgl64.c:490-497`, console MISS lines 1172-1211). `feature_level_from_caps()` therefore skips the entire FL≥10 branch and returns ≤ 9_3. Unity 2020.3's D3D11 path asks for FL `11_0`, so wined3d cannot honour the requested level and `wined3d_device_create()` fails → d3d11 maps it to `E_FAIL`.

- **Testable in one shot:** set `BW64_GLVERSION=3.3` (add a "33" mode alongside "21"/"32" in `gl_version_mode()`) and re-run. If the E_FAIL text changes/disappears, H1 is the mechanism.
- **Cheapest possible fix:** append `"GL_ARB_sampler_objects"` to `g_extList[]` and to the monolithic `GL_EXTENSIONS` string (keeping both in sync as the file's own comment demands).

### H2 — `glXGetProcAddressARB` returns a **non-NULL no-op** for unimplemented procs, so wined3d's `fbo_ops`/`gl_ops.ext` tables are non-NULL garbage → **HIGH confidence**
`libgl64.c:886` returns `gl64_noop`. wined3d `load_gl_funcs()` has no NULL check (`adapter_gl.c:2100`), and `adapter_gl.c:3746-3770` binds `fbo_ops` from those pointers. wined3d then believes FBO support exists and executes `glGenFramebuffers`/`glBindFramebuffer`/`glCheckFramebufferStatus`/`glFramebufferTexture2D` as no-ops during context + target setup. `context_acquire()` (`device.c:1272` `WARN("Failed to acquire context.")`) or `shader_alloc_private`/`wined3d_cpu_blitter_create` (`device.c:1279/1289`) then bails, `context_count == 0`, `adapter_gl_init_3d` returns `E_FAIL`.

- **Compounding hazard:** `glGenFramebuffers`/`glGenSamplers` never write their output array, so wined3d's FBO ids are uninitialised guest stack garbage → nondeterministic behaviour, not a clean error.
- **Discriminator:** make `glXGetProcAddressARB` return `NULL` for a deliberately unimplemented proc (e.g. `glTextureView`) and see whether wined3d logs "GL extension not supported" instead of silently proceeding. If wined3d copes with NULL, returning NULL for the *unimplementable* family is strictly safer than a lying stub.

### H3 — The FBO / sampler-objects / 3D-texture / UBO / MRT surface is entirely absent → **HIGH confidence** (fact, not speculation)
Console lines 1029-1100, 1172-1211, 1335-1377, 1425-1446, 1660-1696, 1794-1993 show 60+ entry points missing that `GL_VERSION "3.2"` has told wined3d to expect. Even if H1/H2 are fixed, wined3d's D3D11 render-target path needs real `glBindFramebuffer` / `glFramebufferRenderbuffer` / `glFramebufferTexture2D` / `glCheckFramebufferStatus` / `glBlitFramebuffer`. All of these **are native WebGL2 entry points**, so they are 1:1 mappings.

### H4 — Internal inconsistency: "GL 3.2" + "legacy context" + a 7-entry extension string → **MEDIUM confidence**
`adapter_gl.c:3445` queries `GL_CONTEXT_PROFILE_MASK` when `gl_version >= 3.2`; the bridge forwards `glGetIntegerv(0x9126)` to WebGL2, which raises `GL_INVALID_ENUM` and leaves the value at 0, so `context_profile == 0` → `gl_info->supported[WINED3D_GL_LEGACY_CONTEXT] = TRUE` (`adapter_gl.c:3449`). wined3d therefore takes the **legacy** branch and parses the 7-name `GL_EXTENSIONS` string, while simultaneously treating the context as GL 3.2 core. Separately, `adapter_gl.c:285` resolves `wglCreateContextAttribsARB` through `wglGetProcAddress`; our bridge returns `gl64_noop` for it, so no real 3.2 context is ever created. wined3d ends up with a self-contradictory view of the driver.

### H5 — `glGetIntegerv(GL_MAX_SAMPLES)`, `GL_MAX_FRAMEBUFFER_WIDTH/HEIGHT`, `GL_MAX_VERTEX_STREAMS` limits → **LOW-MEDIUM confidence**
`adapter_gl.c:3209-3220` reads `GL_MAX_SAMPLES` (gated on `supported[ARB_FRAMEBUFFER_OBJECT]`, now TRUE) and `adapter_gl.c:836-840` / `:4324` probe FBO format support. If WebGL2's `glGetIntegerv` answers come back but the FBO probe at `:4324` cannot be satisfied, caps come out degenerate. Not sufficient on its own to explain `E_FAIL` from `adapter_gl_init_3d`, but must be re-checked after H1–H3.

### Ruled out
- **WASM trap / abort / out-of-bounds.** `baldi-d3d11-errors.json` is `[]`; `baldi-d3d11-console.log` has no `unreachable`, `RuntimeError:` or `Aborted(`. The failure is a *returned* `HRESULT`.
- **`glXGetProcAddress` returning NULL.** It never does — §1.3.
- **Unity-side negotiation.** The `d3d11:` ERR line is emitted before Unity inspects any capability.

---

## 3. Minimal ordered implementation list

Two files must change together for every entry point, so treat each bullet as one unit of work:

* `source/opengl/gl64bridge_abi.h` — add a `GL64_fn_*` id (existing programmable-pipeline ids start at 138).
* `source/opengl/gl64bridge.cpp` — add a `case GL64_fn_*:` in the big switch (the wined3d block is at `:1360-1990`).
* `tools/rootfs64/libgl64/libgl64.c` — add the `API void glFoo(...)` wrapper that fills `GL64Args` and calls `gl64_trap`, **and** add `E(glFoo)` to the `g_procs[]` table at `:800-868` so `glXGetProcAddressARB` returns the real pointer instead of `gl64_noop`.

Convention already established for args: `ai(args,i)` = int, `af(args,i)` = float bit-cast, `cpu->memory->memcpyFromGuest/memcpyToGuest/writed/writeq` for guest memory, and `GL_MT(stmt)` to marshal onto the GL-owning main thread.

### Step 0 — one-line advertisement fix (do this first, it is a 10-minute experiment and may be the whole bug)
* **`glGetString(GL_VERSION)` / `gl_version_mode()`** in `tools/rootfs64/libgl64/libgl64.c:449-503`.
  Add a `"33"` mode so `?glversion=3.3` returns `"3.3 Boxedwine64"` + `GL_SHADING_LANGUAGE_VERSION "3.30"`. With GL ≥ 3.3, `core_extensions[]` auto-enables `ARB_SAMPLER_OBJECTS`, `ARB_EXPLICIT_ATTRIB_LOCATION`, `ARB_INSTANCED_ARRAYS`, `ARB_BLEND_FUNC_EXTENDED`, `ARB_TEXTURE_SWIZZLE`, `ARB_SHADER_BIT_ENCODING`, `ARB_UNIFORM_BUFFER_OBJECT`, `ARB_BUFFER_STORAGE`, `ARB_MULTI_DRAW_INDIRECT`, `ARB_GET_TEXTURE_SUB_IMAGE`… so `feature_level_from_caps()` can finally return FL 10/11. Zero GL code needed.
  **Do not jump to 3.3 without steps 1-4 below** — you will be advertising even more unimplemented core GL. But run it as a *probe* to confirm H1.

### Step 1 — FBO / renderbuffer family — **REAL behaviour required** (highest priority after step 0)
All core in WebGL2/GLES3; all map 1:1. Console lines 1029-1100 + 1660-1696 (the `*EXT` aliases must resolve too — `adapter_gl.c:3776-3799` falls back to them only if `ARB_FRAMEBUFFER_OBJECT` is false, but a `glXGetProcAddress` miss is recorded for each regardless).

| Function | Kind | Notes |
|---|---|---|
| `glGenFramebuffers(GLsizei n, GLuint *fb)` | **REAL** | must write `n` real WebGL2 FBO ids to the guest array |
| `glDeleteFramebuffers(GLsizei n, const GLuint *fb)` | **REAL** | read ids from guest, forward |
| `glBindFramebuffer(GLenum target, GLuint fb)` | **REAL** | 1:1 |
| `glIsFramebuffer(GLuint fb)` | **REAL** | returns `GLboolean`; the switch returns `U64` — return 0/1 |
| `glFramebufferTexture2D(GLenum, GLenum, GLenum, GLuint, GLint)` | **REAL** | 1:1 |
| `glFramebufferTexture(GLenum, GLenum, GLuint, GLint)` | **REAL** | 1:1 |
| `glFramebufferRenderbuffer(GLenum, GLenum, GLenum, GLuint)` | **REAL** | 1:1 |
| `glFramebufferTextureLayer(GLenum, GLuint, GLint)` | **REAL** | 1:1; needed for 2D-array RTs |
| `glFramebufferRenderbuffer`-siblings `glFramebufferTexture1D/3D` | no-op OK | wined3d probes them; never used on our RTs |
| `glCheckFramebufferStatus(GLenum)` | **REAL** | returns `GLenum`; return the real status. **This one is load-bearing** — wined3d treats `!= GL_FRAMEBUFFER_COMPLETE` as a hard failure, and a `gl64_noop` here returns garbage |
| `glBlitFramebuffer(GLint,GLint,GLint,GLint,GLint,GLint,GLint,GLint,GLbitfield,GLenum)` | **REAL** | 1:1; resolve the MSAA-resolve path for `SwapBuffers` |
| `glGenRenderbuffers` / `glDeleteRenderbuffers` / `glBindRenderbuffer` | **REAL** | 1:1, incl. writing id arrays |
| `glRenderbufferStorage(GLenum,GLenum,GLsizei,GLsizei)` | **REAL** | 1:1 |
| `glRenderbufferStorageMultisample(GLenum,GLsizei,GLenum,GLsizei,GLsizei)` | **REAL** | 1:1 |
| `glIsRenderbuffer` / `glGetRenderbufferParameteriv` | **REAL** | 1:1 |
| `glGetFramebufferAttachmentParameteriv(GLenum,GLenum,GLenum,GLint*)` | **REAL** | writes a GLint to guest; wined3d uses it to validate attachments |
| `glDrawBuffers(GLsizei, const GLenum *)` | **REAL** | 1:1; MRT |
| `glReadBuffer(GLenum)` | **REAL** or no-op | 1:1 is trivial |
| `…EXT` aliases (`glGenFramebuffersEXT`, `glBindFramebufferEXT`, `glCheckFramebufferStatusEXT`, `glFramebufferTexture2DEXT`, `glRenderbufferStorageEXT`, `glBlitFramebufferEXT`, `glIsFramebufferEXT`, `glDeleteFramebuffersEXT`, `glGetFramebufferAttachmentParameterivEXT`, `glFramebufferRenderbufferEXT`, `glFramebufferTexture1D/3DEXT`, `glGen/Bind/Delete/IsRenderbufferEXT`, `glGetRenderbufferParameterivEXT`, `glRenderbufferStorageMultisampleEXT`) | REAL, 1:1 delegates to the core versions | WebGL2 has no `EXT` spellings — implement them as thin guest-side wrappers over the same host calls |

### Step 2 — sampler objects — **REAL**, 1:1, and they unblock H1
`glGenSamplers`, `glDeleteSamplers`, `glBindSampler`, `glIsSampler`, `glSamplerParameteri`, `glSamplerParameterf`, `glSamplerParameteriv`, `glSamplerParameterfv`, `glSamplerParameterIiv`, `glSamplerParameterIuiv`, `glGetSamplerParameteriv`, `glGetSamplerParameterfv`, `glGetSamplerParameterIiv`, `glGetSamplerParameterIuiv` (console 1172-1211). Every one is a direct WebGL2 call. Only `glGenSamplers`/`glDeleteSamplers` need guest-array marshalling.

### Step 3 — 3D / array textures — **REAL**
`glTexImage3D`, `glTexSubImage3D`, `glCompressedTexImage3D`, `glCompressedTexSubImage3D` (console 1794-1993) plus the `*ARB`/`*EXT` spellings (`glTexImage3DEXT`, `glCompressedTexImage3DARB`). WebGL2 has them natively. Reuse the existing `texImageBytes()` helper (`gl64bridge.cpp:811-828`) for the `fmt`/`type` size table — extend it for `GL_DEPTH_COMPONENT` and `GL_RGB10_A2`.

### Step 4 — MRT / frag-data — **REAL**
`glBindFragDataLocation` (1948), `glGetFragDataIndex`, `glBindFragDataLocationIndexed`. WebGL2 has the first two directly; the indexed form can be a no-op.

### Step 5 — uniform blocks (SM4 constant buffers) — **REAL for binding**
`glBindBufferRange`, `glGetUniformBlockIndex`, `glUniformBlockBinding`, `glGetActiveUniformBlockiv`, `glGetActiveUniformBlockName`, `glBindBufferBase` (console 1425-1446). GL 3.1 core ⇒ implied by our 3.2 string. Unity's SM4 path needs real bindings.

### Step 6 — buffer objects — `glBufferStorage` REAL, rest no-op
`glBufferStorage` (console 943) is a direct WebGL2 call. `glMapBufferRange` already exists (`gl64bridge.cpp` ARB_sync block) but note it needs a real persistent-map emulation because WebGL2 has no `glMapBufferRange` — see open question O3. `glCopyBufferSubData` (969), `glGetBufferSubData` (2083), `glGetBufferParameteriv` are cheap real.

### Step 7 — cheap real forwarding (10-minute batch, all direct WebGL2)
`glUniform2i/3i/4i` + `glUniform2iv/3iv/4iv` (2179-2206) — wined3d's GLSL backend needs these for `sampler` uniforms; **`glUniform1i` is already implemented so the array variants are a 10-line copy.** Also `glGetUniformfv`, `glGetUniformiv`, `glGetActiveUniform`, `glGetAttachedShaders`, `glGetShaderSource` (2110), `glGetBufferParameteriv`, `glBindFragDataLocation`.
Indexed state (GL 3.0 core, all direct WebGL2): `glEnablei`, `glDisablei`, `glIsEnabledi` (2035-2128), `glBlendEquationi`, `glBlendEquationSeparatei`, `glBlendFunci`, `glBlendFuncSeparatei`, `glColorMaski`, `glMinSampleShading` (1960-2137).

### Step 8 — instancing / base-vertex — real where cheap, no-op acceptable
`glVertexAttribDivisor` (2269) and `glVertexAttribDivisorARB` — REAL (WebGL2 core), needed for `instanced_*` D3D semantics.
`glDrawArraysInstanced`, `glDrawElementsInstanced`, `glDrawElementsInstancedBaseVertexBaseInstance`, `glDrawArraysInstancedBaseInstance`, `glDrawRangeElementsBaseVertex`, `glDrawElementsBaseVertex` — REAL 1:1 (all core WebGL2). Unity rarely uses base-vertex, so `glDrawElementsBaseVertex`/`glDrawRangeElementsBaseVertex` may be **no-op OK** if `ARB_DRAW_ELEMENTS_BASE_VERTEX` is not advertised.

### Step 9 — genuinely safe as no-op stubs (never called before a working device)
`glDebugMessageCallback`, `glDebugMessageControl`, `glDebugMessageInsert`, `glGetDebugMessageLog` (2008-2089); transform feedback (`glBeginTransformFeedback`, `glEndTransformFeedback`, `glTransformFeedbackVaryings`); `GL_NV_*` (`glFinalCombinerInputNV`, `glTextureBarrierNV`); `glPointParameteri`, `glPointParameteriv` (2137-2143); `glTexBuffer`, `glTexBufferRange`, `glTexBufferARB` (1335-2155) — these would fail loudly in D3D11's TBO path, but Unity's default forward renderer does not use them; `glGetTextureParameteriv`/`glGetTextureLevelParameteriv`; `glCompressedTexSubImage2D`; `glGetCompressedTexImage`; the `glVertexAttribN[sui]b/v` component setters (2227-2266) — Unity uploads vertex data via VBOs, not `glVertexAttrib4fv`.

### Step 10 — fix the no-op-return policy (`libgl64.c:886`) — after 1-9 land
Once the mandatory families are real, change `glXGetProcAddressARB` to return `NULL` for a **curated deny-list** of procs we knowingly do not implement, instead of `gl64_noop`. This removes the "wined3d believes a no-op works" failure mode (H2) for everything in step 9. Do *not* return NULL for the GLX/GL core names wine's own `init_opengl` dlsym loop needs (the comment at `libgl64.c:889` and the `libgl64_stubs.h` include block), and keep the `PROC MISS` trace so the deny-list stays auditable.

### Step 11 — capability correctness
Once FBO exists, feed wined3d real limits instead of letting WebGL2's answers leak through unchecked (`adapter_gl.c:3209-3222`): `GL_MAX_SAMPLES` (16), `GL_MAX_FRAMEBUFFER_WIDTH/HEIGHT`, `GL_MAX_VERTEX_STREAMS`, `GL_MAX_DRAW_BUFFERS` (8), `GL_MAX_TEXTURE_IMAGE_UNITS` (already forced to 8 at `gl64bridge.cpp:367-375`). Add these to the `glGetIntegerv` override table at `gl64bridge.cpp:1096-1135`.

---

## 4. Open questions

* **O1 — Which Wine is actually in the prefix?** `tools/buildWine/version.txt` = `7`, `WineVersionNotes.txt` says "Wine 6.21", `tools/rootfs64/build-prefix64.sh:150` says "verified against wine-8.0 dlls/wined3d/cs.c". All source citations above are **wine-9.0**; the structural claims (feature-level gate, FBO op-table binding, `adapter_gl_init_3d` E_FAIL) are stable across 6→10 but the exact line numbers and the `wined3d_device_gl_create_primary_opengl_context_cs` signature differ (wine-9 has it as `void *` CS object; older versions inline it in `wined3d_device_create`). **Action:** read `dlls/wined3d/adapter_gl.c` + `device.c` from the exact vendored tree to pin the four bail-out branches before editing.
* **O2 — Which of the four `context_count == 0` bail-outs fires?** `Failed to acquire context` vs `Failed to allocate shader private data` vs `Failed to create CPU blitter` vs allocator init. Needs `WINEDEBUG=+wined3d`. **Blocker discovered:** `project/emscripten/wine64-launcher.js:191-196` explicitly documents that `WINEDEBUG` set via `prefixEnv()` does **not** reach in-session app spawns — those use the boot-captured `g_sessionCtx.env`. So `WINEDBG=+wined3d` in `scratch-baldi.mjs` will silently not trace `BALDI.exe`. Fix: plumb the debug channels into the **boot** env (the `?session=0` reload path) or append `WINEDEBUG` to the spawned app's env block.
* **O3 — `glMapBufferRange` / `glUnmapBuffer`.** The existing implementation is a no-op returning a sentinel; wined3d's dynamic-buffer path (`wined3d_bo_map`) will then read uninitialised guest memory. WebGL2 has `glMapBufferRange` (ES 3.0), so it should be a real 1:1 call, but the bridge's per-thread marshalling may make it unusable — needs its own investigation.
* **O4 — Extension-string vs version-string consistency.** The `libgl64.c` comment (M16) says that advertising `GL_ARB_framebuffer_object` / `texture_float` / `sRGB` previously made wined3d's D3D-format validation fail with `D3DERR_NOTAVAILABLE`. Now that FBO is going to be genuinely implemented, that old result should be re-tested — the extension may be re-advertised without regressing. Do not assume the old note still holds.
* **O5 — `glGetStringi` path.** Currently wined3d takes the *legacy* `GL_EXTENSIONS` branch (`context_profile == 0` from `GL_CONTEXT_PROFILE_MASK`). If we ever make that query return the core bit, wined3d will switch to `enumerate_gl_extensions` and then a short `glGetStringi` array (7 entries) plus a `GL_VERSION 3.3` core table becomes a *different* failure mode. Keep both paths consistent.
* **O6 — The `gl_version=2.1` control crashed the guest** (`exit_group status=1`, 0 PROC MISS). Someone should bisect that separately; it means there is currently no known-good fallback configuration.
* **O7 — `glGetIntegerv(GL_MAX_SAMPLES)`** is read by `adapter_gl.c:3211` once `supported[ARB_FRAMEBUFFER_OBJECT]` is TRUE. WebGL2 reports `GL_MAX_SAMPLES` only for multisampled *renderbuffers*; a value of 0 would set `gl_info->limits.samples = 0`, which some D3D11 code paths treat as "MSAA unsupported". Force it explicitly (step 11).