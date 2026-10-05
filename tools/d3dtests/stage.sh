#!/bin/bash
# stage.sh — stage the d3dtests probe exes into dist/runtime/prefix64.zip.
#
# Mirrors tools/dxvk/stage-dxvk.sh exactly: each exe goes to BOTH
# home/username/ (= Z:\home\username\, the spawn working dir) and
# home/username/.wine/drive_c/ (= C:\, where wine resolves a bare "clear9.exe").
# checker.bmp (texquad9's texture) is staged alongside texquad9.exe in both
# locations. d3d9.dll itself is NOT copied here — tools/dxvk/stage-dxvk.sh owns
# it and already staged it next to where these exes land; this script only
# verifies it is present.
#
# Does NOT modify tools/rootfs64/buildvk.sh or the glibc-rootfs64/wine64 zips:
# this payload rides the prefix64.zip layer like tri9 does.
#
# Usage: tools/d3dtests/stage.sh [PREFIX_ZIP]
#   default PREFIX_ZIP = dist/runtime/prefix64.zip
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ZIP="${1:-$REPO/dist/runtime/prefix64.zip}"
EXES="clear9.exe texquad9.exe vshade9.exe"
DATA="checker.bmp"

[ -f "$ZIP" ] || { echo "error: $ZIP missing" >&2; exit 1; }
for e in $EXES; do
    [ -f "$HERE/$e" ] || { echo "error: $HERE/$e missing (run make first)" >&2; exit 1; }
done
[ -f "$HERE/$DATA" ] || { echo "error: $HERE/$DATA missing" >&2; exit 1; }
# d3d9.dll is staged by tools/dxvk/stage-dxvk.sh — verify, don't touch.
unzip -l "$ZIP" | grep -q "home/username/d3d9.dll" \
    || { echo "error: d3d9.dll not in $ZIP (run tools/dxvk/stage-dxvk.sh first)" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/home/username" "$STAGE/home/username/.wine/drive_c"
for e in $EXES; do
    cp "$HERE/$e" "$STAGE/home/username/$e"
    cp "$HERE/$e" "$STAGE/home/username/.wine/drive_c/$e"
done
cp "$HERE/$DATA" "$STAGE/home/username/$DATA"
cp "$HERE/$DATA" "$STAGE/home/username/.wine/drive_c/$DATA"
( cd "$STAGE" && zip -q "$ZIP" \
    home/username/clear9.exe home/username/texquad9.exe home/username/vshade9.exe \
    home/username/checker.bmp \
    home/username/.wine/drive_c/clear9.exe home/username/.wine/drive_c/texquad9.exe \
    home/username/.wine/drive_c/vshade9.exe home/username/.wine/drive_c/checker.bmp )
echo "--- $ZIP (d3dtests payload) ---"
unzip -l "$ZIP" | grep -E "clear9|texquad9|vshade9|checker" || true
echo "=== staged. WINEDLLOVERRIDES=d3d9=n selects the native dll at runtime ==="
