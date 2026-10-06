// jit64_invalidate_tests.cpp — §14.3 block-overlap invalidation test.
//
// Upstream BoxedWine's wasm JIT once executed stale code when a newly
// compiled block overlapped an existing cached block. Our defense is
// page-generation invalidation: buildBlock registers the block's pages and
// snapshots their generations; every guest write to a registered page bumps
// its generation (block pages are barred from the data-TLB fast path, and
// registration evicts the TLB); tryBlockStep re-checks generations at
// lookup, execBlock/execBlockThreaded re-check after every record, and the
// Jit64BlockCache lookup keys on (startRip, pages, generations).
//
// This test proves the mechanism instead of asserting it: it caches a block,
// rewrites guest memory inside / overlapping / across the block's range, and
// re-executes, comparing against the pure interpreter (tier 1, BW64_NOBLOCK=1).
// A broken invalidation would execute stale bytes and fail the expected
// register values. Covers the block-cache tier (1.5, switch dispatch) and
// the threaded tier (2, BW64_THREADED=1); tier 3's wasm vehicle falls back
// to execBlock on native builds, so it rides the same vehicle.
//
// Build (mirrors scripts/test-jit-lifetime.sh link recipe):
//   g++ -std=c++20 -DBOXEDWINE_GUEST_X64=1 -DBOXEDWINE_BLOCK_EXEC=1 \
//       -DBOXEDWINE_BLOCK_CACHE_INFRA=1 -ffunction-sections -fdata-sections \
//       -Iinclude -Ilib/simde source/emulation/cpu/cpu64.cpp \
//       source/emulation/cpu/jit64.cpp source/emulation/cpu/jit64wasm.cpp \
//       source/kernel/kmemory64.cpp source/util/bstring.cpp \
//       <fpu.o> source/emulation/cpu/tests/jit64_invalidate_tests.cpp \
//       -Wl,--gc-sections -o /tmp/jit64_invalidate_tests
// Driver: run 3x — BW64_NOBLOCK=1 (tier 1 baseline), default (tier 1.5),
// BW64_THREADED=1 (tier 2) — and require identical stdout + exit 0.
// Exit 0 = all pass; non-zero = failures (count printed).

#include "boxedwine.h"
#include "cpu64.h"
#include "kmemory64.h"

#include <cstdio>
#include <cstring>

// ---- standalone-link stubs (no kernel/process in this harness) ----
thread_local KThread* KThread::runningThread = nullptr;
void internal_log(BString msg, FILE* f) { std::fprintf(f, "%s\n", msg.str()); }
void internal_kpanic(BString msg) { std::fprintf(stderr, "KPANIC: %s\n", msg.str()); std::abort(); }
void kpanic(const char* msg) { std::fprintf(stderr, "KPANIC: %s\n", msg); std::abort(); }
void klog(const char* msg) { std::fprintf(stderr, "klog: %s\n", msg); }
void ksyscall64(CPU64*) { std::fprintf(stderr, "STUB: ksyscall64 reached\n"); std::abort(); }
bool CPU64::raiseSyncFault(U32, U32, S32, U64) { std::abort(); return false; }
void KProcess::signalProcess(U32) {}
bool KSystem::useF64 = true;
U64 KSystem::getSystemTimeAsMicroSeconds() { return 0; }
#include "softfloat_types.h"
// (remaining softfloat extF80 helpers come from lib/softfloat objects)

static int g_pass = 0, g_fail = 0;
#define CHECK(cond, ...) do { \
    if (cond) { g_pass++; } \
    else { g_fail++; printf("  FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } \
} while (0)

struct Ctx {
    KMemory64 mem;
    CPU64 cpu;
    Ctx() : mem(nullptr), cpu(&mem) {}
    void code(U64 addr, const U8* bytes, U64 len) {
        for (U64 i = 0; i < len; i++) mem.writeb(addr + i, bytes[i]);
    }
    void resetRegs() {
        for (int i = 0; i < 16; i++) cpu.reg[i].u64 = 0;
        cpu.rflags = 0x202;
    }
};

// Test 1: rewrite a byte INSIDE a cached block's range; re-enter at the
// block's start. Stale cache would execute the old immediate.
static void testRewriteInsideBlock() {
    Ctx c;
    const U64 X = 0x100000;
    // B8 05 00 00 00   mov eax, 5
    // BB 07 00 00 00   mov ebx, 7
    const U8 prog[] = {0xB8,0x05,0x00,0x00,0x00, 0xBB,0x07,0x00,0x00,0x00};
    c.code(X, prog, sizeof(prog));
    c.cpu.rip = X;
    U64 ran1 = c.cpu.runBounded(2);
    CHECK(ran1 == 2, "t1: first run executed %llu insns, want 2", (unsigned long long)ran1);
    CHECK(c.cpu.reg[X64_RAX].u64 == 5, "t1: eax=%llu want 5", (unsigned long long)c.cpu.reg[X64_RAX].u64);
    CHECK(c.cpu.reg[X64_RBX].u64 == 7, "t1: ebx=%llu want 7", (unsigned long long)c.cpu.reg[X64_RBX].u64);
    // Rewrite the immediate inside the cached block: 5 -> 9.
    c.mem.writeb(X + 1, 9);
    c.resetRegs();
    c.cpu.rip = X;
    c.cpu.runBounded(2);
    CHECK(c.cpu.reg[X64_RAX].u64 == 9, "t1: after rewrite eax=%llu want 9 (stale=5)",
          (unsigned long long)c.cpu.reg[X64_RAX].u64);
    CHECK(c.cpu.reg[X64_RBX].u64 == 7, "t1: after rewrite ebx=%llu want 7", (unsigned long long)c.cpu.reg[X64_RBX].u64);
    CHECK(c.cpu.rip == X + 10, "t1: rip=0x%llx want 0x%llx", (unsigned long long)c.cpu.rip, (unsigned long long)(X + 10));
    printf("T1 eax=%llu ebx=%llu rip=0x%llx\n",
           (unsigned long long)c.cpu.reg[X64_RAX].u64,
           (unsigned long long)c.cpu.reg[X64_RBX].u64,
           (unsigned long long)c.cpu.rip);
}

// Test 2 (plan §14.3 prescribed case): block cached at X; page rewritten so
// a NEW block starts at X+2 overlapping the old range. The old entry must
// never be entered; the new bytes must execute.
static void testOverlapAtXPlus2() {
    Ctx c;
    const U64 Y = 0x200000;
    const U8 prog[] = {0xB8,0x05,0x00,0x00,0x00, 0xBB,0x07,0x00,0x00,0x00};
    c.code(Y, prog, sizeof(prog));
    c.cpu.rip = Y;
    c.cpu.runBounded(2); // caches block at Y
    CHECK(c.cpu.reg[X64_RAX].u64 == 5, "t2: warmup eax");
    // Overwrite [Y+2, Y+12) with a new 2-insn block:
    // B9 0B 00 00 00   mov ecx, 11
    // BA 0D 00 00 00   mov edx, 13
    const U8 patch[] = {0xB9,0x0B,0x00,0x00,0x00, 0xBA,0x0D,0x00,0x00,0x00};
    c.code(Y + 2, patch, sizeof(patch));
    c.resetRegs();
    c.cpu.rip = Y + 2;
    c.cpu.runBounded(2);
    CHECK(c.cpu.reg[X64_RCX].u64 == 11, "t2: ecx=%llu want 11", (unsigned long long)c.cpu.reg[X64_RCX].u64);
    CHECK(c.cpu.reg[X64_RDX].u64 == 13, "t2: edx=%llu want 13", (unsigned long long)c.cpu.reg[X64_RDX].u64);
    CHECK(c.cpu.reg[X64_RAX].u64 == 0, "t2: eax=%llu want 0 (old block entered!)",
          (unsigned long long)c.cpu.reg[X64_RAX].u64);
    CHECK(c.cpu.rip == Y + 12, "t2: rip=0x%llx want 0x%llx", (unsigned long long)c.cpu.rip, (unsigned long long)(Y + 12));
    printf("T2 ecx=%llu edx=%llu eax=%llu rip=0x%llx\n",
           (unsigned long long)c.cpu.reg[X64_RCX].u64,
           (unsigned long long)c.cpu.reg[X64_RDX].u64,
           (unsigned long long)c.cpu.reg[X64_RAX].u64,
           (unsigned long long)c.cpu.rip);
}

// Test 3: the block's own store rewrites a LATER instruction in the same
// block. execBlock/execBlockThreaded must stop at the next record (per-record
// generation check) so the following instruction decodes the NEW bytes.
static void testWithinBlockSelfMod() {
    Ctx c;
    const U64 Z = 0x300000;
    // C7 05 01 00 00 00 78 56 34 12   mov dword [rip+1], 0x12345678
    //   (len 10; effAddr = Z+10+1 = Z+11)
    // B8 00 00 00 00                  mov eax, 0   (imm lives at Z+11..Z+14)
    const U8 prog[] = {0xC7,0x05,0x01,0x00,0x00,0x00,0x78,0x56,0x34,0x12,
                       0xB8,0x00,0x00,0x00,0x00};
    c.code(Z, prog, sizeof(prog));
    c.cpu.rip = Z;
    c.cpu.runBounded(2);
    CHECK(c.cpu.reg[X64_RAX].u64 == 0x12345678ULL, "t3: eax=0x%llx want 0x12345678 (stale=0)",
          (unsigned long long)c.cpu.reg[X64_RAX].u64);
    CHECK(c.cpu.rip == Z + 15, "t3: rip=0x%llx want 0x%llx", (unsigned long long)c.cpu.rip, (unsigned long long)(Z + 15));
    printf("T3 eax=0x%llx rip=0x%llx\n",
           (unsigned long long)c.cpu.reg[X64_RAX].u64, (unsigned long long)c.cpu.rip);
}

// Test 4: block spanning two pages; rewrite lands on the SECOND page.
// Exercises the page1 generation snapshot, not just page0.
static void testCrossPageRewrite() {
    Ctx c;
    const U64 W = 0x40FFB; // 5 bytes on page 0x40, 5 bytes on page 0x41
    const U8 prog[] = {0xB8,0x05,0x00,0x00,0x00, 0xBB,0x07,0x00,0x00,0x00};
    c.code(W, prog, sizeof(prog));
    c.cpu.rip = W;
    c.cpu.runBounded(2);
    CHECK(c.cpu.reg[X64_RBX].u64 == 7, "t4: warmup ebx");
    c.mem.writeb(W + 6, 9); // page 0x41, inside the cached block
    c.resetRegs();
    c.cpu.rip = W;
    c.cpu.runBounded(2);
    CHECK(c.cpu.reg[X64_RBX].u64 == 9, "t4: after rewrite ebx=%llu want 9 (stale=7)",
          (unsigned long long)c.cpu.reg[X64_RBX].u64);
    CHECK(c.cpu.reg[X64_RAX].u64 == 5, "t4: eax=%llu want 5", (unsigned long long)c.cpu.reg[X64_RAX].u64);
    printf("T4 eax=%llu ebx=%llu\n",
           (unsigned long long)c.cpu.reg[X64_RAX].u64, (unsigned long long)c.cpu.reg[X64_RBX].u64);
}

int main() {
    testRewriteInsideBlock();
    testOverlapAtXPlus2();
    testWithinBlockSelfMod();
    testCrossPageRewrite();
    printf("invalidate_tests: pass=%d fail=%d\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
