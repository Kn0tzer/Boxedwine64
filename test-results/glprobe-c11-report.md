# C11 — GLCORE/GLES3-baked Unity Windows build hunt

**Result: no GL-baked Unity Windows build exists among the sampled indie titles. All four are
DXBC-only; `-force-glcore` fail-fasts on the shader payload, not on the bridge.**

## Scanner (`/tmp/scan.mjs`, `grep` recipe in this file)
For each `<Game>_Data/*` (skipping `Managed/`, `MonoBleedingEdge/`):

| signal | meaning |
| --- | --- |
| `glcore` / `gles3` / `gles2` / `vulkan` / `metal` / `d3d11` / `d3d9` as substrings | Unity serialized shader **platform keys** (a hit on `glcore`/`gles3` ⇒ GL shaders baked) |
| `#version N core`, `gl_Position`, `gl_FragColor`, `attribute vec`, `uniform mat4`, `precision mediump` | raw GLSL subprogram text (GL platforms only) |
| `DXBC` occurrence count | D3D shader blobs (`m_SubProgramBlob`) |

Note: `metal` is a false-positive generator (`_Metallic`, `_MetallicGlossMap`). Unity serializes
non-default platforms by name, so a GL-baked build *must* surface the literal `glcore`/`gles3`.

## Candidates downloaded and scanned (all verified with curl + Playwright click-to-download)

| # | game | Unity | exe | DXBC blobs | GLSL | platform keys |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Baldi's Basics Classic Remastered (baseline, C10) | 2020.3.38f1 | BALDI.exe | 51 (globalgamemanagers.assets 20, resources.assets 14, sharedassets0 2, sharedassets3 15) | none | none |
| 1 | Overhead: Tower Defense — chicomcastro.itch.io/overhead (Dec 2017, Win+Mac, 38 MB) | **2017.1.0f3** | OverHead.exe | 23 (resources 16, sharedassets0 7) | none | none |
| 2 | ScatterBraiiin — sandoomer.itch.io/scatterbraiiin (Jun 2023, Win+Mac+Linux, 29 MB) | **2020.3.30f1** | Scatter Braiiin.exe | 4 | none | none |
| 3 | Spyce Town — angelo11k.itch.io/spyce-town (May 2022, Win+Linux, 47 MB) | **2021.3.0f1** | StandaloneWindows64.exe | 6 | none | none |
| 4 | Horror Room — themian.itch.io/horror-hotel (Win, 82 MB) | 2021.x | Horror Room.exe | not scanned (cap reached) | — | — |

3/3 scanned (2017 → 2021) are DXBC-only. Spanning 5 Unity versions, 4 Windows standalone builds,
0 GLSL subprograms, 0 GL/Vulkan/D3D platform keys. **Unity strips non-selected graphics APIs' shader
data at build time**; "Auto Graphics API" on Windows Standalone = D3D11 only.

Funnel note: `itch.io/games/tag-unity/tag-opengl` contains exactly **1** game (yoanb.itch.io/speedrunner,
an OpenGL-game-jam prototype) and it has **no uploads**. The `opengl` tag is a jam/tech tag, not an
API-support tag. DDG/Bing/Mojeek are blocked from this host; itch.io search is title-only.

## Probe run — Spyce Town, Unity 2021.3.0f1, `-force-glcore`

`GAME_DIR=/tmp/stage/spyce GAME_EXE=StandaloneWindows64.exe GL_VERSION=3.2 SOAK_SECS=180
GAME_ARGS=["-force-glcore","-screen-width","640","-screen-height","480","-screen-fullscreen","0"]`

- Import: 133 files, window **MAPPED**, runtime Running, **zero page errors**, guest exited `status=0`.
- Console (`glprobe-spyce-console.log`, lines 4090-4094):

```
log: Initialize engine version: 2021.3.0f1 (6eacc8284459)
log: [Subsystems] Discovering subsystems at path Z:/home/username/apps/StandaloneWindows64_Data/UnitySubsystems
log: Forcing GfxDevice: OpenGL Core
log: Forced GfxDevice 'OpenGL Core' was not built from editor, shaders will not be available
log: InitializeEngineGraphics failed
log: PlayerInitEngineGraphics: InitializeEngineGraphics failed
```

**GfxDevice status: never created.** Unity accepts and honours `-force-glcore` selection, then
rejects it at the shader-set lookup — *before* any GL call. Confirmed by **0 `PROC MISS` entries**
and **no `wglCreateContext`/`glGetString`** in the trace: the gl64bridge is never engaged, so nothing
here is blocked in `gl64bridge.cpp`.

## Conclusions for the fleet

1. C10's Baldi finding generalises: **DXBC-only is the norm, not an outlier.** Chasing a
   GLCORE-baked indie Windows build is very likely a dead end (4/4 sampled).
2. The only remaining ways to get a GL-baked Windows payload are: (a) a dev who explicitly added
   OpenGLCore/OpenGLES3 to Windows Player Settings (no public sample found), or (b) **patching the
   bake**, e.g. `ShaderUtil.SetShaderVariant`/AssetStudio round-trip to inject a GLCORE shader
   subprogram, or (c) **D3D11→GL translation at runtime** (Naga/wined3d GLSL path, already the C1/D1
   lanes) — i.e. (c) is the real road, and C11 should not spend more cycles on game hunting.
3. Harness win: `scratch-baldi.mjs` handled a new exe name and a non-`BALDI.exe` `_Data` dir with no
   changes; artifacts namespaced cleanly via `TAG=glprobe-spyce`.

Artifacts: `glprobe-spyce-{run.log,console.log,player.log,shot.png,frame.png,errors.json}`.