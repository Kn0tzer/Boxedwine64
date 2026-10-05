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

echo "=== [1/3] native phase-1 unit tests (g++ gate) ==="
mkdir -p "$BUILD_TMP"
BUILD_TMP="$BUILD_TMP/lifetime" bash "$REPO/scripts/test-jit-lifetime.sh"
g++ -std=c++17 -Wall -Wextra -DBOXEDWINE_GUEST_X64=1 \
    -I"$REPO/include" \
    "$REPO/source/emulation/cpu/jit64.cpp" \
    "$REPO/source/emulation/cpu/tests/jit64_tests.cpp" \
    -o "$BUILD_TMP/jit64_tests"
"$BUILD_TMP/jit64_tests"
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

echo "=== [2/3] wasm64-selftest build (emcc) ==="
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
    printf '%s\n' 'var Module = { preRun: function() { ENV.BW64_JIT = process.env.BW64_JIT || "0"; ENV.BW64_JIT_VERIFY = process.env.BW64_JIT_VERIFY || "0"; } };'
    cat "$JS"
} > "$JS_CJS"

echo "=== [3/3] smoke run: interpreter vs BW64_JIT=1 (outputs must match) ==="
if ! BW64_JIT=0 BW64_JIT_VERIFY=0 node "$JS_CJS" --x64-selftest > "$BUILD_TMP/selftest_interp.log" 2>&1; then
    echo "FAIL: interpreter self-test; see $BUILD_TMP/selftest_interp.log" >&2
    exit 1
fi
if ! BW64_JIT=1 BW64_JIT_VERIFY=1 node "$JS_CJS" --x64-selftest > "$BUILD_TMP/selftest_jit.log" 2>&1; then
    echo "FAIL: JIT self-test; see $BUILD_TMP/selftest_jit.log" >&2
    exit 1
fi
grep -E '^JIT64: blocks=[1-9][0-9]* insns=[1-9][0-9]*$' "$BUILD_TMP/selftest_jit.log"
sed '/^JIT64:/d' "$BUILD_TMP/selftest_jit.log" > "$BUILD_TMP/selftest_jit_results.log"
if diff -u "$BUILD_TMP/selftest_interp.log" "$BUILD_TMP/selftest_jit_results.log"; then
    echo "OK: BW64_JIT=1 output identical to interpreter baseline."
else
    echo "FAIL: JIT output differs from interpreter baseline (see diff above)." >&2
    exit 1
fi
echo "build-jit-wasm.sh: all gates passed."
