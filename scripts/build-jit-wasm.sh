#!/usr/bin/env bash
# scripts/build-jit-wasm.sh — decoder/cache and initial wasm emitter gates.
#
# Activate an Emscripten SDK before running the wasm gates.
#
# When run, it:
#   1. Runs native decoder/cache tests and emitted wasm MOV modules under Node.
#      Any failure aborts before touching emcc.
#   2. Builds the wasm64-selftest recipe (project/emscripten/makefile), which
#      compiles with GUEST_X64 and BLOCK_EXEC enabled in an isolated directory.
#      source/emulation/cpu/jit64.cpp is
#      auto-globbed into SOURCES (BOXEDWINE_GUEST_X64-gated, so it is empty in
#      the 32-bit targets); source/emulation/cpu/tests/ is pruned from the
#      glob because the native harness has its own main().
#   3. Smoke-runs the result under node twice — BW64_JIT unset (interpreter
#      baseline) and BW64_JIT=1 (JIT fast path) — and diffs the outputs. Phase
#      1 executes JIT-compiled blocks via the interpreter's execBlock, so the
#      test output must match; a separate sentinel proves JIT blocks executed.
#
# Future work will extend this script: runtime module instantiation/table glue
# (boxedwine_wasm_instantiate_runtime_batch), broader arithmetic, and the
# node --x64-run-elf fixture with timing comparison.
#
# Usage: ./scripts/build-jit-wasm.sh [--selftest-only]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_TMP="${BUILD_TMP:-/tmp/bw64-jit-build}"
SELFTEST_ONLY="${1:-}"
JOBS="${JOBS:-2}"
case "$SELFTEST_ONLY" in
    ''|--selftest-only) ;;
    *) echo "Usage: $0 [--selftest-only]" >&2; exit 2 ;;
esac
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: JOBS must be positive." >&2; exit 2; }

echo "=== [1/4] native phase-1 unit tests (g++ gate) ==="
mkdir -p "$BUILD_TMP"
BUILD_TMP="$BUILD_TMP/lifetime" bash "$REPO/scripts/test-jit-lifetime.sh"
g++ -std=c++17 -Wall -Wextra -DBOXEDWINE_GUEST_X64=1 \
    -I"$REPO/include" \
    "$REPO/source/emulation/cpu/jit64.cpp" \
    "$REPO/source/emulation/cpu/jit64wasm.cpp" \
    "$REPO/source/emulation/cpu/tests/jit64_tests.cpp" \
    -o "$BUILD_TMP/jit64_tests"
"$BUILD_TMP/jit64_tests"
# Byte-identical migration gate: the table-generated emitters must produce
# byte-identical wasm output to the hand-written ones they replace
# (see source/emulation/cpu/jit64table.mjs). The generated .inc must also
# be in sync with the table.
node "$REPO/scripts/gen-jit64.mjs" --check
g++ -std=c++17 -Wall -Wextra -DBOXEDWINE_GUEST_X64=1 -DJIT64_GEN_VERIFY=1 \
    -I"$REPO/include" \
    "$REPO/source/emulation/cpu/jit64.cpp" \
    "$REPO/source/emulation/cpu/jit64wasm.cpp" \
    "$REPO/source/emulation/cpu/tests/jit64_gen_tests.cpp" \
    -o "$BUILD_TMP/jit64_gen_tests"
"$BUILD_TMP/jit64_gen_tests"
# Plan section 14.3: block-overlap invalidation. Caches a block, rewrites
# guest memory inside / overlapping / across its range (plus a within-block
# self-modifying store and a cross-page block), and re-executes on all three
# native tiers, differentially against the pure interpreter. A sensitivity
# check (noteGuestWrite neutered) was verified to fail T1/T3/T4, so this gate
# is not vacuous.
echo "--- jit64 block-invalidation tests (section 14.3) ---"
# NOTE: -ffunction-sections/-fdata-sections are load-bearing here: fpu.cpp
# also implements 32-bit-KMemory FPU helpers (FSTENV/FRSTOR/...) that must be
# dead-stripped by --gc-sections at link time.
g++ -std=c++20 -DBOXEDWINE_GUEST_X64=1 -ffunction-sections -fdata-sections -c \
    -I"$REPO/include" -I"$REPO/lib/simde" \
    "$REPO/source/emulation/cpu/common/fpu.cpp" -o "$BUILD_TMP/inv_fpu.o"
mkdir -p "$BUILD_TMP/softfloat"
for sf in "$REPO"/lib/softfloat/source/*.c "$REPO"/lib/softfloat/source/8086-SSE/*.c; do
    obj="$BUILD_TMP/softfloat/$(basename "$sf" .c).o"
    [ -f "$obj" ] || gcc -O1 -c -I"$REPO/lib/softfloat/source/include" \
        -I"$REPO/lib/softfloat/source" -I"$REPO/lib/softfloat/source/8086-SSE" \
        "$sf" -o "$obj"
done
g++ -std=c++20 -Wall -Wextra -DBOXEDWINE_GUEST_X64=1 -DBOXEDWINE_BLOCK_EXEC=1 \
    -DBOXEDWINE_BLOCK_CACHE_INFRA=1 -ffunction-sections -fdata-sections \
    -I"$REPO/include" -I"$REPO/lib/simde" -I"$REPO/lib/softfloat/source/include" \
    "$REPO/source/emulation/cpu/cpu64.cpp" \
    "$REPO/source/emulation/cpu/jit64.cpp" \
    "$REPO/source/emulation/cpu/jit64wasm.cpp" \
    "$REPO/source/kernel/kmemory64.cpp" \
    "$REPO/source/util/bstring.cpp" \
    "$BUILD_TMP/inv_fpu.o" "$BUILD_TMP"/softfloat/*.o \
    "$REPO/source/emulation/cpu/tests/jit64_invalidate_tests.cpp" \
    -Wl,--gc-sections -o "$BUILD_TMP/jit64_invalidate_tests" > "$BUILD_TMP/inv_build.log" 2>&1 || \
    { echo "FAIL: invalidate-test build failed; see $BUILD_TMP/inv_build.log" >&2; exit 1; }
BW64_NOBLOCK=1 "$BUILD_TMP/jit64_invalidate_tests" > "$BUILD_TMP/inv_tier1.log"
"$BUILD_TMP/jit64_invalidate_tests" > "$BUILD_TMP/inv_tier15.log"
BW64_THREADED=1 "$BUILD_TMP/jit64_invalidate_tests" > "$BUILD_TMP/inv_tier2.log"
cmp -s "$BUILD_TMP/inv_tier1.log" "$BUILD_TMP/inv_tier15.log" || { echo "FAIL: tier 1.5 invalidation output differs from interpreter baseline" >&2; exit 1; }
cmp -s "$BUILD_TMP/inv_tier1.log" "$BUILD_TMP/inv_tier2.log" || { echo "FAIL: tier 2 invalidation output differs from interpreter baseline" >&2; exit 1; }
echo "OK: block-invalidation tests pass identically on tiers 1 / 1.5 / 2."
command -v node >/dev/null || { echo "ERROR: node not found." >&2; exit 1; }
g++ -std=c++17 -Wall -Wextra -DBOXEDWINE_GUEST_X64=1 \
    -I"$REPO/include" \
    "$REPO/source/emulation/cpu/jit64.cpp" \
    "$REPO/source/emulation/cpu/jit64wasm.cpp" \
    "$REPO/source/emulation/cpu/tests/jit64_wasm_fixture.cpp" \
    -o "$BUILD_TMP/jit64_wasm_fixture"
JIT64_WASM_FIXTURE="$BUILD_TMP/jit64_wasm_fixture" node --test \
    "$REPO/source/emulation/cpu/tests/jit64_wasm_tests.mjs"

if [ -n "$SELFTEST_ONLY" ]; then
    echo "selftest-only: skipping emcc build."
    exit 0
fi

echo "=== [2/4] wasm64-selftest build (emcc) ==="
command -v emcc >/dev/null || {
    echo "ERROR: emcc not found. Activate the Emscripten SDK first (emsdk_env.sh)." >&2
    exit 1
}
# Command-line MAKEFLAGS wins over the makefile's automatic CPU-count setting.
# Separate objects prevent stale files compiled without BLOCK_EXEC from passing.
make -C "$REPO/project/emscripten" Build/Wasm64JitSelfTest/boxedwine64-selftest.js MAKEFLAGS="-j$JOBS" \
    BUILD_DIR=Build/Wasm64JitSelfTest \
    TARGET_EXEC=boxedwine64-selftest.js \
    EXTRA_LD_FLAGS='-sENVIRONMENT=node -sEXIT_RUNTIME=1' \
    EXTRA_CPP_FLAGS='-DBOXEDWINE_GUEST_X64=1 -DBOXEDWINE_BLOCK_EXEC=1 -DBOXEDWINE_BLOCK_CACHE_INFRA=1'
JS="$REPO/project/emscripten/Build/Wasm64JitSelfTest/boxedwine64-selftest.js"
[ -f "$JS" ] || { echo "ERROR: expected output $JS not produced." >&2; exit 1; }
# The repository is type=module, but Emscripten's Node shell is CommonJS.
# Keep the copy alongside the wasm so its __dirname asset lookup still works.
JS_CJS="${JS%.js}.cjs"
# Emscripten 6 does not mirror Node's environment unless NODE_HOST_ENV is set.
# Forward only these two test controls before the guest calls getenv().
{
    printf '%s\n' 'var Module = { preRun: function() { ENV.BW64_JIT = process.env.BW64_JIT || "0"; ENV.BW64_JIT_VERIFY = process.env.BW64_JIT_VERIFY || "0"; ENV.BW64_THREADED = process.env.BW64_THREADED || "0"; } };'
    cat "$JS"
} > "$JS_CJS"

echo "=== [3/4] smoke run: interpreter vs BW64_JIT=1 (outputs must match) ==="
if ! BW64_JIT=0 BW64_JIT_VERIFY=0 node "$JS_CJS" --x64-selftest > "$BUILD_TMP/selftest_interp.log" 2>&1; then
    echo "FAIL: interpreter self-test; see $BUILD_TMP/selftest_interp.log" >&2
    exit 1
fi
if ! BW64_JIT=1 BW64_JIT_VERIFY=1 node "$JS_CJS" --x64-selftest > "$BUILD_TMP/selftest_jit.log" 2>&1; then
    echo "FAIL: JIT self-test; see $BUILD_TMP/selftest_jit.log" >&2
    exit 1
fi
grep -E '^JIT64: blocks=[1-9][0-9]* insns=[1-9][0-9]*$' "$BUILD_TMP/selftest_jit.log"
grep -E '^WASM64: blocks=[1-9][0-9]* insns=[1-9][0-9]*$' "$BUILD_TMP/selftest_jit.log"
sed -e '/^JIT64:/d' -e '/^WASM64:/d' "$BUILD_TMP/selftest_jit.log" > "$BUILD_TMP/selftest_jit_results.log"
if diff -u "$BUILD_TMP/selftest_interp.log" "$BUILD_TMP/selftest_jit_results.log"; then
    echo "OK: BW64_JIT=1 output identical to interpreter baseline."
else
    echo "FAIL: JIT output differs from interpreter baseline (see diff above)." >&2
    exit 1
fi
echo "=== [4/4] threaded-tier smoke: BW64_THREADED=1 (must match interpreter) ==="
if ! BW64_THREADED=1 node "$JS_CJS" --x64-selftest > "$BUILD_TMP/selftest_threaded.log" 2>&1; then
    echo "FAIL: threaded self-test; see $BUILD_TMP/selftest_threaded.log" >&2
    exit 1
fi
if diff -u "$BUILD_TMP/selftest_interp.log" "$BUILD_TMP/selftest_threaded.log"; then
    echo "OK: BW64_THREADED=1 output identical to interpreter baseline."
else
    echo "FAIL: threaded output differs from interpreter baseline (see diff above)." >&2
    exit 1
fi
echo "build-jit-wasm.sh: all gates passed."
