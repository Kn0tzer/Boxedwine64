#!/bin/bash
# buildvk.sh — build the guest Vulkan shim (libvulkan.so.1) + the P2 boundary
# fixture, and stage them into the Boxedwine64 rootfs zips.
#
# What this produces:
#   tools/rootfs64/libvk64/libvulkan.so.1   freestanding x86-64-linux ELF .so,
#                                           SONAME=libvulkan.so.1, NO DT_NEEDED.
#                                           This is the guest's Vulkan API
#                                           surface: there is NO Vulkan loader
#                                           and NO ICD in the guest, so the shim
#                                           exports the 85 vk* entry points (plus
#                                           vkGetInstanceProcAddr /
#                                           vkGetDeviceProcAddr and the 3
#                                           vk_icd* aliases) and each one packs a
#                                           VK64Args block and traps to the host
#                                           on VK64_SYSCALL_NR.
#                                           See source/vulkan/vk64bridge_abi.h and
#                                           source/vulkan/vk64bridge.cpp for the
#                                           other half of the boundary.
#   tools/rootfs64/libvk64/vkfixture        the x86_64 ELF that walks vkcube's
#                                           whole Vulkan path through the shim
#                                           (dlopen + GIPA -> instance -> device
#                                           -> queue -> headless surface ->
#                                           swapchain -> pipeline -> submit ->
#                                           present -> teardown) and exits 0.
#
# Staging (--stage): both files go into the rootfs zips at the paths the guest's
# dynamic linker actually searches. The P1 envdump
# (test-results/baldi-o2-envdump-console.log:4378-4387) shows the guest probing
# /lib/x86_64-linux-gnu/, /usr/lib/x86_64-linux-gnu/, /lib/ and /usr/lib/, and the
# committed zips today contain NO libvulkan.so.1 at all — that is the reason
# tasks/p1-final.md lists "where does the guest look for the shim" as unknown #1.
# So: the .so goes to BOTH lib/x86_64-linux-gnu/ and usr/lib/x86_64-linux-gnu/ of
# BOTH zips (the same both-paths trick the libGL.so.1 staging uses), and the
# fixture goes to usr/bin/ in wine64.zip (that zip owns the usr/ tree).
#
# ICD manifest (--stage also writes this): usr/share/vulkan/icd.d/
# vkwebgpu_icd.json pointing at the shim with api_version 1.3. No loader exists
# in the guest and winevulkan dlopens libvulkan.so.1 directly (no ICD lookup),
# so this manifest is for completeness — any real Vulkan loader that shows up
# finds THIS library through the standard JSON path instead of failing.
#
# Usage:
#   tools/rootfs64/buildvk.sh                 # build the shim + fixture
#   tools/rootfs64/buildvk.sh --stage         # build, then inject into the zips
#   tools/rootfs64/buildvk.sh --stage DIR     # ... using zips from DIR
#                                            # (default tools/rootfs64/dist)
#   tools/rootfs64/buildvk.sh --regen-spirv D # regenerate vkfixture_spirv.h from
#                                            # the .spv files in directory D
#
# The build needs an x86_64-linux compiler. In preference order:
#   1. a host x86_64-linux-gnu-gcc (i.e. an x86_64 dev box)
#   2. a host clang that can target x86_64-linux-gnu + ld.lld
#   3. the bw64-libgl64-gcc:bookworm amd64 Debian image under Docker/qemu, which
#      is what an aarch64 dev box uses (this is build-libgl64.sh's fallback path)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SRC="$HERE/libvk64"
IMAGE="${BW64_GCC_IMAGE:-bw64-libgl64-gcc:bookworm}"
STAGE_DIRS=()
REGEN_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
        --stage)
            if [ -n "${2:-}" ] && [ "${2#-}" = "$2" ]; then STAGE_DIRS+=("$2"); shift; else STAGE_DIRS+=("$HERE/dist"); fi
            ;;
        --regen-spirv) REGEN_DIR="${2:?--regen-spirv needs a directory}"; shift ;;
        -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done
[ ${#STAGE_DIRS[@]} -eq 0 ] && STAGE_DIRS=()
# Resolve stage dirs to absolute paths: staging cd's into $STAGE before
# invoking zip, so a relative dir would resolve against the wrong cwd and zip
# would fail with "No such file or directory".
for i in "${!STAGE_DIRS[@]}"; do
    STAGE_DIRS[$i]="$(cd "${STAGE_DIRS[$i]}" && pwd)"
done
DO_STAGE=0
if [ ${#STAGE_DIRS[@]} -gt 0 ]; then DO_STAGE=1; fi

[ -f "$SRC/libvk64.c" ]    || { echo "error: $SRC/libvk64.c missing" >&2; exit 1; }
[ -f "$SRC/vkfixture.c" ]  || { echo "error: $SRC/vkfixture.c missing" >&2; exit 1; }

# --- SPIR-V refresh mode -----------------------------------------------------
if [ -n "$REGEN_DIR" ]; then
    echo "=== regenerating vkfixture_spirv.h from $REGEN_DIR ==="
    python3 - "$REGEN_DIR" "$SRC/vkfixture_spirv.h" <<'PY'
import glob, os, struct, sys
d, out = sys.argv[1], sys.argv[2]
verts = sorted(glob.glob(os.path.join(d, '*.vert.spv')))
frags = sorted(glob.glob(os.path.join(d, '*.frag.spv')))
if not verts or not frags:
    sys.exit('need one *.vert.spv and one *.frag.spv in %s' % d)
def words(p):
    b = open(p, 'rb').read()
    assert struct.unpack('<I', b[:4])[0] == 0x07230203, 'not SPIR-V: ' + p
    assert len(b) % 4 == 0
    return list(struct.unpack('<%dI' % (len(b) // 4), b))
def emit(name, w):
    lines = ['static const uint32_t %s[] = {' % name]
    for i in range(0, len(w), 6):
        lines.append('    ' + ', '.join('0x%08xu' % x for x in w[i:i+6]) + ('' if i + 6 >= len(w) else ','))
    lines.append('};')
    return '\n'.join(lines)
hdr = open(out).read().split('*/')[0] + '*/\n#ifndef __VKFIXTURE_SPIRV_H__\n#define __VKFIXTURE_SPIRV_H__\n\n'
body = emit('vkfix_vert_spv', words(verts[0])) + '\n\n' + emit('vkfix_frag_spv', words(frags[0])) + '\n\n'
open(out, 'w').write(hdr + body + '#endif // __VKFIXTURE_SPIRV_H__\n')
print('wrote %s (%d vert words from %s, %d frag words from %s)' %
      (out, len(words(verts[0])), os.path.basename(verts[0]), len(words(frags[0])), os.path.basename(frags[0])))
PY
    exit 0
fi

# --- build -------------------------------------------------------------------
build_native() {
    local CC="$1"
    [ -n "$CC" ] || return 1
    echo "--- using host $CC ---"
    # The shim: freestanding, so no libc objects are needed and the result has no
    # DT_NEEDED at all (nothing to resolve at load time in the guest).
    "$CC" -shared -fPIC -O2 -fvisibility=hidden -nostdlib -ffreestanding \
        -Wl,-soname,libvulkan.so.1 -o "$SRC/libvulkan.so.1" "$SRC/libvk64.c"
    # The fixture links against libc (it is a normal dynamically linked program)
    # and against the REAL Khronos headers, exactly like any guest application.
    # The in-tree headers live at source/vulkan/vk/; expose them under the
    # conventional <vulkan/...> include path so the fixture's #include is what a
    # real app writes.
    local inc="$SRC/.inc"
    rm -rf "$inc"; mkdir -p "$inc"
    ln -sfn "$REPO/source/vulkan/vk" "$inc/vulkan"
    "$CC" -O2 -Wall -I "$inc" -I "$SRC" -o "$SRC/vkfixture" "$SRC/vkfixture.c" -ldl
    rm -rf "$inc"
    return 0
}

echo "=== building guest libvulkan.so.1 + vkfixture ==="
built=0
if command -v x86_64-linux-gnu-gcc >/dev/null 2>&1; then
    build_native x86_64-linux-gnu-gcc && built=1
fi
if [ $built -eq 0 ] && command -v clang >/dev/null 2>&1; then
    LLD=""
    for c in ld.lld lld /usr/local/opt/llvm/bin/ld.lld /opt/homebrew/opt/llvm/bin/ld.lld; do
        command -v "$c" >/dev/null 2>&1 && { LLD="$c"; break; }
        [ -x "$c" ] && { LLD="$c"; break; }
    done
    if [ -n "$LLD" ]; then
        echo "--- using host clang (x86_64-linux target) + $LLD ---"
        clang --target=x86_64-linux-gnu -fPIC -O2 -fvisibility=hidden -ffreestanding \
            -c "$SRC/libvk64.c" -o "$SRC/libvk64.o"
        "$LLD" -shared -soname libvulkan.so.1 -o "$SRC/libvulkan.so.1" "$SRC/libvk64.o"
        rm -f "$SRC/libvk64.o"
        local inc="$SRC/.inc"; rm -rf "$inc"; mkdir -p "$inc"
        ln -sfn "$REPO/source/vulkan/vk" "$inc/vulkan"
        clang --target=x86_64-linux-gnu -O2 -Wall -I "$inc" -I "$SRC" \
            -o "$SRC/vkfixture" "$SRC/vkfixture.c" -ldl
        rm -rf "$inc"
        built=1
    fi
fi
if [ $built -eq 0 ]; then
    if ! docker info >/dev/null 2>&1; then
        echo "error: no x86_64-linux compiler found and docker is unavailable." >&2
        echo "       install x86_64-linux-gnu-gcc, or a clang that can target" >&2
        echo "       x86_64-linux-gnu, or make $IMAGE available to docker." >&2
        exit 1
    fi
    echo "--- compiling inside $IMAGE (linux/amd64) ---"
    docker run --rm --platform linux/amd64 -v "$REPO":/repo -v "$SRC":/out -w /repo "$IMAGE" bash -c '
        set -euo pipefail
        gcc -shared -fPIC -O2 -fvisibility=hidden -nostdlib -ffreestanding \
            -Wl,-soname,libvulkan.so.1 -o /out/libvulkan.so.1 tools/rootfs64/libvk64/libvk64.c
        # <vulkan/vulkan_core.h> on the conventional include path; the in-tree
        # headers are at source/vulkan/vk/.
        rm -rf /tmp/vkinc; mkdir -p /tmp/vkinc
        ln -sfn /repo/source/vulkan/vk /tmp/vkinc/vulkan
        gcc -O2 -Wall -I /tmp/vkinc -I tools/rootfs64/libvk64 \
            -o /out/vkfixture tools/rootfs64/libvk64/vkfixture.c -ldl
    '
    built=1
fi

echo "=== result ==="
ls -l "$SRC/libvulkan.so.1" "$SRC/vkfixture"
echo "--- shim: soname + NEEDED (must be none) + export count ---"
readelf -d "$SRC/libvulkan.so.1" | grep -i soname || true
echo -n "DT_NEEDED entries: "; readelf -d "$SRC/libvulkan.so.1" | grep -c NEEDED || true
echo -n "exported functions: "; readelf --dyn-syms -W "$SRC/libvulkan.so.1" | grep -c " FUNC " || true
echo "--- load-time witness (fires the moment the guest dlopens the shim) ---"
readelf -S "$SRC/libvulkan.so.1" | grep -A1 init_array || echo "(no .init_array — the witness will NOT fire)"
echo "--- fixture: PT_INTERP + DT_NEEDED ---"
readelf -l "$SRC/vkfixture" | grep -A1 "INTERP" | tail -1
readelf -d "$SRC/vkfixture" | grep NEEDED

# --- stage into the rootfs zips ---------------------------------------------
if [ "$DO_STAGE" = 1 ]; then
    echo "=== staging into the rootfs zips ==="
    for ZD in "${STAGE_DIRS[@]}"; do
        GZ="$ZD/glibc-rootfs64.zip"
        WZ="$ZD/wine64.zip"
        [ -f "$GZ" ] || { echo "error: $GZ missing (build the rootfs zips first)" >&2; exit 1; }
        [ -f "$WZ" ] || { echo "error: $WZ missing (build the rootfs zips first)" >&2; exit 1; }
        STAGE="$ZD/vk-stage"
        rm -rf "$STAGE"; mkdir -p "$STAGE/lib/x86_64-linux-gnu" "$STAGE/usr/lib/x86_64-linux-gnu" "$STAGE/usr/bin" "$STAGE/usr/share/vulkan/icd.d"
        # The ICD manifest (see the header comment): library_path is absolute so
        # it resolves no matter which layer of the overlay owns the file.
        cat > "$STAGE/usr/share/vulkan/icd.d/vkwebgpu_icd.json" <<'JSON'
{
    "file_format_version": "1.0.0",
    "ICD": {
        "library_path": "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
        "api_version": "1.3"
    }
}
JSON
        # Both library paths, in BOTH zips — the guest's loader probes
        # /lib/x86_64-linux-gnu and /usr/lib/x86_64-linux-gnu (and /lib, /usr/lib)
        # and the two zips are layered, so writing both entries into both zips
        # makes the shim win regardless of which layer is searched first.
        for Z in "$GZ" "$WZ"; do
            for P in lib/x86_64-linux-gnu usr/lib/x86_64-linux-gnu; do
                cp "$SRC/libvulkan.so.1" "$STAGE/$P/libvulkan.so.1"
            done
            ( cd "$STAGE" && zip -q "$Z" lib/x86_64-linux-gnu/libvulkan.so.1 usr/lib/x86_64-linux-gnu/libvulkan.so.1 )
        done
        # The fixture: usr/bin/ is owned by wine64.zip.
        cp "$SRC/vkfixture" "$STAGE/usr/bin/vkfixture"
        ( cd "$STAGE" && zip -q "$WZ" usr/bin/vkfixture )
        # The ICD manifest goes in BOTH zips (same both-layers reasoning as the
        # .so: whichever layer a loader searches first, the manifest is there).
        ( cd "$STAGE" && zip -q "$GZ" usr/share/vulkan/icd.d/vkwebgpu_icd.json )
        ( cd "$STAGE" && zip -q "$WZ" usr/share/vulkan/icd.d/vkwebgpu_icd.json )
        rm -rf "$STAGE"
        echo "--- $GZ ---"; unzip -l "$GZ" | grep -E "libvulkan|vkfixture|icd.d" || true
        echo "--- $WZ ---"; unzip -l "$WZ" | grep -E "libvulkan|vkfixture|icd.d" || true
    done
    echo "=== staged. rerun web/tests/scratch-vk.mjs to run the fixture ==="
fi

echo "=== done ==="