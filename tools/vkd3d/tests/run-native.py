#!/usr/bin/env python3
"""Compile the real bridge and shim; replace only the private x86 syscall in tests."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
source = (root / "tools/rootfs64/libvk64/libvk64.c").read_text()
start = source.index("static inline uint64_t vk64_trap(")
opening = source.index("{", start)
depth = 1
end = opening + 1
while depth:
    depth += (source[end] == "{") - (source[end] == "}")
    end += 1
replacement = """extern uint64_t vk64_test_trap(uint64_t, VK64Args*);
static inline uint64_t vk64_trap(uint64_t fnId, VK64Args* args) {
    return vk64_test_trap(fnId, args);
}"""
sanitize = os.environ.get("VK64_TEST_SANITIZERS")
flags = ["-fsanitize=" + sanitize, "-fno-omit-frame-pointer"] if sanitize else []
with tempfile.TemporaryDirectory(prefix="vkd3d-native-") as folder:
    path = Path(folder)
    shim = path / "shim.c"
    shim.write_text(source[:start] + replacement + source[end:])
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-O0", "-fno-builtin",
                    *flags, "-c", str(shim), "-o", str(path / "shim.o")], check=True)
    subprocess.run([os.environ.get("CXX", "c++"), "-std=c++17", "-O0", "-g",
                    *flags, "-I", str(root / "include"),
                    str(root / "tools/vkd3d/tests/vk64_native_test.cpp"),
                    str(path / "shim.o"), "-o", str(path / "test")], check=True)
    subprocess.run([str(path / "test")], check=True)
