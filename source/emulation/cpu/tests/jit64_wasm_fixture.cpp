// Copyright (C) 2026 The BoxedWine Team. GPL-2.0-or-later.
#include "jit64wasm.h"
#include <fstream>
#include <iterator>

int main(int argc, char** argv) {
    if (argc != 3) return 1;
    std::ifstream input(argv[1], std::ios::binary);
    if (!input) return 1;
    std::vector<U8> bytes((std::istreambuf_iterator<char>(input)), {});
    Jit64Op ops[24];
    U32 count = jit64CompileStream(0, bytes.data(), (U32)bytes.size(), ops, 24, true);
    U32 consumed = 0;
    for (U32 i = 0; i < count; i++) consumed += ops[i].len;
    if (consumed != bytes.size()) return 2;
    Jit64Block block;
    block.ops.assign(ops, ops + count);
    std::vector<U8> module = {0xAA}; // failure must discard any prior module
    if (!jit64EmitWasm(block, module)) return module.empty() ? 2 : 3;
    std::ofstream output(argv[2], std::ios::binary);
    output.write((const char*)module.data(), module.size());
    return output ? 0 : 1;
}
