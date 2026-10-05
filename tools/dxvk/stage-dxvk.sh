#!/bin/bash
# stage-dxvk.sh — stage the DXVK bring-up payload into dist/runtime/prefix64.zip.
#
# What goes in, and why it goes THERE (not into wine64.zip):
#   tri9.exe + d3d9.dll at BOTH home/username/ (= Z:\home\username\, the spawn
#   working dir) and drive_c/ (= C:\, where wine resolves a bare "tri9.exe").
#   This mirrors exactly how build-prefix64.sh bundles d3dtri.exe/gltri.exe.
#   d3d9.dll sits NEXT TO tri9.exe (not in system32): wine's DLL search checks
#   the app directory first, so with WINEDLLOVERRIDES=d3d9=n the native DXVK
#   build loads without touching the shared system32 (which is a .link into the
#   wine install and must stay pristine).
#
# Usage: tools/dxvk/stage-dxvk.sh [PREFIX_ZIP]
#   default PREFIX_ZIP = dist/runtime/prefix64.zip
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ZIP="${1:-$REPO/dist/runtime/prefix64.zip}"
D3D9="$HERE/build.w64/src/d3d9/d3d9.dll"
TRI9="$HERE/tri9/tri9.exe"

[ -f "$ZIP" ]  || { echo "error: $ZIP missing" >&2; exit 1; }
[ -f "$D3D9" ] || { echo "error: $D3D9 missing (build DXVK first, see BUILD.md)" >&2; exit 1; }
[ -f "$TRI9" ] || { echo "error: $TRI9 missing (compile tools/dxvk/tri9/tri9.c first)" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/home/username" "$STAGE/home/username/.wine/drive_c"
cp "$TRI9" "$D3D9" "$STAGE/home/username/"
cp "$TRI9" "$D3D9" "$STAGE/home/username/.wine/drive_c/"
( cd "$STAGE" && zip -q "$ZIP" home/username/tri9.exe home/username/d3d9.dll \
    home/username/.wine/drive_c/tri9.exe home/username/.wine/drive_c/d3d9.dll )
echo "--- $ZIP (dxvk payload) ---"
unzip -l "$ZIP" | grep -E "tri9|d3d9" || true
echo "=== staged. WINEDLLOVERRIDES=d3d9=n selects the native dll at runtime ==="
