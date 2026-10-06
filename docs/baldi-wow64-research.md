# Baldi's Basics -- WoW64 Research

Date: 2026-10-06
Goal: goal_0ea9f8e0561b (Baldi D3D9 bring-up prep)

## Verdict

WoW64 is NOT needed for Baldi's Basics Classic Remastered.

## Binary Evidence

BALDI.exe (staged at /tmp/stage/baldi/BALDI.exe):
- PE Machine type: 0x8664 (x64) -- verified 2026-10-06 via direct header parse
- Unity version: 2020.3.38f1 (binary string 2020.3.38f1_8f5fde82e2dc)
- Player type: Win64 Mono (not IL2CPP, not 32-bit)

UnityPlayer.dll (60 MB): 64-bit PE, empty import directory.

## Boxedwine64 WoW64 Status

From docs/PLAN_64BIT.md:
- Boxedwine64 is 64-bit-first. Runs 64-bit Wine (wine64) and 64-bit Windows apps.
- WoW64 support deferred to v2: "For v1 we punt on WoW64 thunks."
- v1 process model: one guest = one bitness. No thunking layer.

## Implications

1. No WoW64 work needed for Baldi (pure 64-bit).
2. A 32-bit Unity game would need either a separate wine32 container (v1 approach)
   or a v2 WoW64 thunking layer (mode-switch, per-process bitness, separate JIT
   block caches). Neither exists in v1; out of scope.
3. The distributed Baldi zip (/home/ubuntu/kn0tzer/wine/games/baldi.zip, 138 MB)
   contains only x64 binaries.

## References
- docs/PLAN_64BIT.md
- tasks/baldi-d3d9-prep.md
