// Copyright (C) 2026 The BoxedWine Team. GPL-2.0-or-later.
#include "boxedwine.h"
#include "cpu64.h"
#include "jit64.h"
#include <cstdlib>
#include <new>

// Observe actual deallocation without adding counters to the production ABI.
static void* stateAllocation;
static const void* opsAllocation;
static bool stateReleased;
static bool opsReleased;

void operator delete(void* pointer) noexcept {
    if (pointer == stateAllocation) stateReleased = true;
    if (pointer == opsAllocation) opsReleased = true;
    std::free(pointer);
}
void operator delete(void* pointer, std::size_t) noexcept {
    ::operator delete(pointer);
}

int main() {
    {
        CPU64 unused(nullptr); // No state was allocated; destruction is safe.
    }
    {
        CPU64 cpu(nullptr);
#ifdef BOXEDWINE_BLOCK_EXEC
        cpu.ensureJit();
        auto* first = cpu.jit();
        cpu.ensureJit();
        if (cpu.jit() != first) return 1;
#else
        // Ownership also applies in builds with block execution compiled out.
        cpu.m_jit = new Jit64State();
#endif
        Jit64Op op;
        const auto* block = cpu.jit()->cache.insert(0x400000, 1, 1, 0, 0, &op, 1);
        stateAllocation = cpu.jit();
        opsAllocation = block->ops.data();
    }
    if (!stateReleased || !opsReleased) {
        std::fprintf(stderr, "FAIL: CPU64 destruction released state=%d cached ops=%d\n",
                     stateReleased, opsReleased);
        // Clean the intentional fail-before leak so sanitizers stay useful.
        delete static_cast<Jit64State*>(stateAllocation);
        return 1;
    }
    std::puts("PASS: CPU64 destruction releases JIT state and cached ops");
    return 0;
}
