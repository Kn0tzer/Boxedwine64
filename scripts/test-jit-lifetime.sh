#!/usr/bin/env bash
# Exercise real CPU64/Jit64State destruction with block execution on and off.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_TMP="${BUILD_TMP:-/tmp/bw64-jit-lifetime}"
mkdir -p "$BUILD_TMP"
FLAGS=(-std=c++20 -DBOXEDWINE_GUEST_X64=1 -ffunction-sections -fdata-sections
    -I"$REPO/include" -I"$REPO/lib/simde")
# Section GC links only constructor/destructor/JIT ownership code, leaving
# unrelated CPU instruction and kernel entry points out of this focused test.
g++ "${FLAGS[@]}" -c "$REPO/source/emulation/cpu/common/fpu.cpp" -o "$BUILD_TMP/fpu.o"
for mode in off on; do
    MODE_FLAGS=()
    if [[ "$mode" == on ]]; then MODE_FLAGS=(-DBOXEDWINE_BLOCK_EXEC=1); fi
    g++ "${FLAGS[@]}" "${MODE_FLAGS[@]}" \
        "$REPO/source/emulation/cpu/cpu64.cpp" \
        "$REPO/source/emulation/cpu/jit64.cpp" \
        "$REPO/source/emulation/cpu/tests/jit64_lifetime_tests.cpp" \
        "$BUILD_TMP/fpu.o" -Wl,--gc-sections -o "$BUILD_TMP/lifetime-$mode"
    "$BUILD_TMP/lifetime-$mode"
done
