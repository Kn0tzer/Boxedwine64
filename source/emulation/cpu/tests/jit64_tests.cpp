// jit64_tests.cpp — native unit-test harness for the phase-1 JIT framework
// (source/emulation/cpu/jit64.cpp + include/jit64.h).
//
// Build: g++ -std=c++17 -DBOXEDWINE_GUEST_X64=1 -I<repo>/include 
//     <repo>/source/emulation/cpu/jit64.cpp jit64_tests.cpp -o jit64_tests
// No SDL, no KMemory64, no emcc: feeds hand-built guest instruction streams
// into jit64DecodeOne/jit64CompileStream/Jit64BlockCache and checks the
// emitted decisions (kind/size/sub/len/plan, cache validity, plan text).
//
// Exit 0 = all pass; non-zero = failures (count printed).

#include <cstdio>
#include <cstring>
#include <vector>

#include "../../../../include/jit64.h"

static int g_pass = 0, g_fail = 0;

#define CHECK(cond, ...) do { \
    if (cond) { g_pass++; } \
    else { g_fail++; printf("  FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } \
} while (0)

// Decode one stream and return the op (asserts decode succeeded).
static Jit64Op dec(U64 base, std::vector<U8> b) {
    Jit64Op op;
    bool ok = jit64DecodeOne(base, b.data(), (U32)b.size(), op);
    CHECK(ok, "decode failed for %zu bytes @0x%llx", b.size(), base);
    jit64Classify(op, false, false);
    return op;
}

static void testCoverageTable() {
    U32 n = 0;
    const Jit64CoveredOpcode* t = jit64CoveredOpcodes(&n);
    CHECK(n == 20, "coverage table has %u entries, want 20", n);
    CHECK(t != nullptr, "coverage table null");
    // Spot-check rank order matches the profile.
    CHECK(t[0].op == 0x89, "rank1 op=0x%02x want 0x89", t[0].op);
    CHECK(t[1].op == 0x8B, "rank2 op=0x%02x want 0x8B", t[1].op);
    CHECK(t[2].op == 0x83, "rank3 op=0x%02x want 0x83", t[2].op);
    CHECK(t[3].op == 0xE8, "rank4 op=0x%02x want 0xE8", t[3].op);
    CHECK(t[4].op == 0x8D, "rank5 op=0x%02x want 0x8D", t[4].op);
    CHECK(t[5].op == 0x58, "rank6 op=0x%02x want 0x58 (POP class)", t[5].op);
    CHECK(t[6].op == 0xB8, "rank7 op=0x%02x want 0xB8 (MOV r,imm class)", t[6].op);
    CHECK(t[8].op == 0x50, "rank9 op=0x%02x want 0x50 (PUSH class)", t[8].op);
    CHECK(t[10].op == 0xC1, "rank11 op=0x%02x want 0xC1", t[10].op);
    CHECK(t[14].op == 0x0F && t[14].op2 == 0xB6, "rank15 want 0FB6 got %02x/%02x", t[14].op, t[14].op2);
    CHECK(t[18].op == 0x0F && t[18].op2 == 0x84, "rank19 want 0F84 got %02x/%02x", t[18].op, t[18].op2);
}

static void testMovForms() {
    // 48 89 C8          mov rax, rcx
    Jit64Op a = dec(0x400000, {0x48, 0x89, 0xC8});
    CHECK(a.kind == J64_MOV_RM_R && a.size == 8 && a.len == 3, "89: kind=%d size=%d len=%d", a.kind, a.size, a.len);
    CHECK(a.regField == 1 && a.rmIndex == 0 && !a.isMem, "89: rf=%d rm=%d mem=%d", a.regField, a.rmIndex, a.isMem);
    CHECK(a.plan == JIT64_FAST, "89 plan fallback");
    // 8B 45 FC          mov eax, [rbp-4]
    Jit64Op b = dec(0x400000, {0x8B, 0x45, 0xFC});
    CHECK(b.kind == J64_MOV_R_RM && b.size == 4 && b.len == 3, "8B: kind=%d size=%d len=%d", b.kind, b.size, b.len);
    CHECK(b.isMem && b.regField == 0, "8B: mem=%d rf=%d", b.isMem, b.regField);
    CHECK(b.plan == JIT64_FAST, "8B plan fallback");
    // 48 B8 imm64       mov rax, imm64
    Jit64Op c = dec(0x400000, {0x48, 0xB8, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11});
    CHECK(c.kind == J64_MOV_R_IMM && c.size == 8 && c.len == 10, "B8: kind=%d size=%d len=%d", c.kind, c.size, c.len);
    CHECK(c.imm == 0x1122334455667788ULL, "B8: imm=0x%llx", c.imm);
    CHECK(c.plan == JIT64_FAST, "B8 plan fallback");
    // B9 0A 00 00 00    mov ecx, 10
    Jit64Op d = dec(0x400000, {0xB9, 0x0A, 0x00, 0x00, 0x00});
    CHECK(d.kind == J64_MOV_R_IMM && d.size == 4 && d.len == 5 && d.regField == 1, "B9 len=%d rf=%d", d.len, d.regField);
    CHECK(d.imm == 10, "B9 imm=%llu", d.imm);
    // C7 45 FC 2A 00 00 00  mov dword [rbp-4], 42
    Jit64Op e = dec(0x400000, {0xC7, 0x45, 0xFC, 0x2A, 0x00, 0x00, 0x00});
    CHECK(e.kind == J64_MOV_RM_IMM && e.len == 7 && e.imm == 42, "C7: kind=%d len=%d imm=%llu", e.kind, e.len, e.imm);
    // 0F B6 C0          movzx eax, al  (reg form, MOVZX marker sub=1)
    Jit64Op f = dec(0x400000, {0x0F, 0xB6, 0xC0});
    CHECK(f.kind == J64_MOV_R_RM && f.len == 3, "0FB6: kind=%d len=%d", f.kind, f.len);
    CHECK(f.plan == JIT64_FAST, "0FB6 plan fallback");
}

static void testAluForms() {
    // 48 01 C8          add rax, rcx (rank-16 opcode 01)
    Jit64Op a = dec(0x400000, {0x48, 0x01, 0xC8});
    CHECK(a.kind == J64_ALU_RM_R && a.sub == 0 && a.size == 8 && a.len == 3, "01: kind=%d sub=%d", a.kind, a.sub);
    CHECK(a.plan == JIT64_FAST, "01 plan fallback");
    // 39 D8             cmp eax, ebx (rank-10 opcode 39)
    Jit64Op b = dec(0x400000, {0x39, 0xD8});
    CHECK(b.kind == J64_ALU_RM_R && b.sub == 7 && b.size == 4, "39: kind=%d sub=%d", b.kind, b.sub);
    // 48 29 D8          sub rax, rbx (rank-20 opcode 29)
    Jit64Op c = dec(0x400000, {0x48, 0x29, 0xD8});
    CHECK(c.kind == J64_ALU_RM_R && c.sub == 5 && c.size == 8, "29: kind=%d sub=%d", c.kind, c.sub);
    // 48 31 C0          xor rax, rax (rank-8 opcode 31)
    Jit64Op d = dec(0x400000, {0x48, 0x31, 0xC0});
    CHECK(d.kind == J64_ALU_RM_R && d.sub == 6, "31: kind=%d sub=%d", d.kind, d.sub);
    // 48 83 C0 03       add rax, 3 (rank-3 opcode 83)
    Jit64Op e = dec(0x400000, {0x48, 0x83, 0xC0, 0x03});
    CHECK(e.kind == J64_ALU_RM_IMM && e.sub == 0 && e.len == 4 && e.imm == 3, "83: kind=%d sub=%d len=%d imm=%llu", e.kind, e.sub, e.len, e.imm);
    // 48 83 E8 02       sub rax, 2 (sign-extended imm still positive)
    Jit64Op f = dec(0x400000, {0x48, 0x83, 0xE8, 0x02});
    CHECK(f.sub == 5 && f.imm == 2, "83-sub: sub=%d imm=%llu", f.sub, f.imm);
    // 48 83 F8 FF       cmp rax, -1 (imm8 0xFF sign-extends to all-ones)
    Jit64Op g = dec(0x400000, {0x48, 0x83, 0xF8, 0xFF});
    CHECK(g.sub == 7 && g.imm == 0xFFFFFFFFFFFFFFFFULL, "83-cmp-neg: sub=%d imm=0x%llx", g.sub, g.imm);
    // 05 34 12 00 00    add eax, 0x1234 (ACC-imm form)
    Jit64Op h = dec(0x400000, {0x05, 0x34, 0x12, 0x00, 0x00});
    CHECK(h.kind == J64_ALU_ACC_IMM && h.sub == 0 && h.len == 5 && h.imm == 0x1234, "05: kind=%d len=%d imm=0x%llx", h.kind, h.len, h.imm);
    // 85 C0             test eax, eax (rank-6 opcode 85)
    Jit64Op i = dec(0x400000, {0x85, 0xC0});
    CHECK(i.kind == J64_TEST_RM_R && i.size == 4 && i.len == 2, "85: kind=%d", i.kind);
    CHECK(i.plan == JIT64_FAST, "85 plan fallback");
}

static void testMiscFast() {
    // 48 8D 35 1A 00 00 00   lea rsi, [rip+0x1A]
    Jit64Op a = dec(0x400000, {0x48, 0x8D, 0x35, 0x1A, 0x00, 0x00, 0x00});
    CHECK(a.kind == J64_LEA && a.len == 7 && a.isMem, "8D: kind=%d len=%d mem=%d", a.kind, a.len, a.isMem);
    // C1 E0 04           shl eax, 4 (rank-17 opcode C1)
    Jit64Op b = dec(0x400000, {0xC1, 0xE0, 0x04});
    CHECK(b.kind == J64_SHIFT_IMM && b.sub == 4 && b.imm == 4 && b.len == 3, "C1: kind=%d sub=%d", b.kind, b.sub);
    // 50 / 5D            push rax, pop rbp (representative stack row)
    Jit64Op c = dec(0x400000, {0x50});
    CHECK(c.kind == J64_PUSH && c.regField == 0 && c.len == 1, "50: kind=%d", c.kind);
    Jit64Op d = dec(0x400000, {0x5D});
    CHECK(d.kind == J64_POP && d.regField == 5 && d.len == 1, "5D: kind=%d rf=%d", d.kind, d.regField);
    // E8 F3 FF FF FF     call -13
    Jit64Op e = dec(0x400010, {0xE8, 0xF3, 0xFF, 0xFF, 0xFF});
    CHECK(e.kind == J64_CALL_REL && e.len == 5 && e.delta == -13, "E8: kind=%d delta=%lld", e.kind, (long long)e.delta);
    // 74 07             jz +7
    Jit64Op f = dec(0x400000, {0x74, 0x07});
    CHECK(f.kind == J64_JCC && f.sub == 4 && f.delta == 7 && f.len == 2, "74: sub=%d delta=%lld", f.sub, (long long)f.delta);
    // 0F 84 10 00 00 00  jz rel32
    Jit64Op g = dec(0x400000, {0x0F, 0x84, 0x10, 0x00, 0x00, 0x00});
    CHECK(g.kind == J64_JCC && g.sub == 4 && g.delta == 16 && g.len == 6, "0F84: delta=%lld", (long long)g.delta);
    // 75 FB             jnz -5
    Jit64Op h = dec(0x400000, {0x75, 0xFB});
    CHECK(h.kind == J64_JCC && h.sub == 5 && h.delta == -5, "75: delta=%lld", (long long)h.delta);
    // C3 / C9 / 90
    CHECK(dec(0x400000, {0xC3}).kind == J64_RET, "C3 not RET");
    CHECK(dec(0x400000, {0xC9}).kind == J64_LEAVE, "C9 not LEAVE");
    CHECK(dec(0x400000, {0x90}).kind == J64_NOP, "90 not NOP");
    // E9 00 10 00 00     jmp rel32
    Jit64Op k = dec(0x400000, {0xE9, 0x00, 0x10, 0x00, 0x00});
    CHECK(k.kind == J64_JMP_REL && k.delta == 0x1000, "E9 delta=%lld", (long long)k.delta);
    // 0F 05 syscall decodes, but classifies fallback
    Jit64Op s;
    CHECK(jit64DecodeOne(0x400000, (const U8*)"\x0F\x05", 2, s) && s.kind == J64_SYSCALL, "0F05 not SYSCALL");
    jit64Classify(s, false, false);
    CHECK(s.plan == JIT64_FALLBACK, "syscall must be fallback");
}

static void testFallbackRules() {
    // LOCK prefix forces fallback even on a fast opcode.
    Jit64Op a;
    const U8 lockAdd[] = {0xF0, 0x48, 0x01, 0xC8};
    CHECK(jit64DecodeOne(0x400000, lockAdd, 4, a) && a.kind == J64_ALU_RM_R, "F0-decode kind=%d", a.kind);
    jit64Classify(a, true, false);
    CHECK(a.plan == JIT64_FALLBACK, "LOCK add must be fallback");
    // 66h operand size forces fallback.
    Jit64Op b;
    const U8 op16[] = {0x66, 0x89, 0xC8};
    CHECK(jit64DecodeOne(0x400000, op16, 3, b), "66-decode failed");
    jit64Classify(b, false, true);
    CHECK(b.plan == JIT64_FALLBACK, "o16 mov must be fallback");
    // 8-bit ALU is unknown (fallback by construction).
    Jit64Op c;
    const U8 add8[] = {0x00, 0xC8};
    CHECK(!jit64DecodeOne(0x400000, add8, 2, c), "8-bit ADD should not decode fast");
    // Truncated stream must not decode.
    Jit64Op d;
    const U8 trunc[] = {0x48, 0x89};
    CHECK(!jit64DecodeOne(0x400000, trunc, 2, d), "truncated MOV must fail");
    const U8 trunc2[] = {0xE8, 0x01, 0x02};
    CHECK(!jit64DecodeOne(0x400000, trunc2, 3, d), "truncated CALL must fail");
    // REX.B-extended push r8.
    Jit64Op e = dec(0x400000, {0x41, 0x50});
    CHECK(e.kind == J64_PUSH && e.regField == 8, "REX.B push rf=%d", e.regField);
}

static void testCompileStream() {
    // The loop-fixture from tools/buildLoopElf64.py:
    //   31 C0 | B9 0A000000 | 48 01 C8 | 48 FF C9 | 75 FB | 48 89 C7 | B8 3C000000 | 0F 05
    const U8 prog[] = {
        0x31, 0xC0,
        0xB9, 0x0A, 0x00, 0x00, 0x00,
        0x48, 0x01, 0xC8,
        0x48, 0xFF, 0xC9, // DEC rcx = FF /1 — interpreter handles, JIT: unknown->stop
    };
    Jit64Op ops[16];
    U32 n = jit64CompileStream(0x400000, prog, sizeof(prog), ops, 16, true);
    // 31C0 (xor, fast) + B9 (mov-imm, fast) + 4801C8 (add, fast), then stop at FF (unknown).
    CHECK(n == 3, "compileStream n=%u want 3", n);
    CHECK(ops[0].kind == J64_ALU_RM_R && ops[0].plan == JIT64_FAST, "op0 kind=%d", ops[0].kind);
    CHECK(ops[1].kind == J64_MOV_R_IMM, "op1 kind=%d", ops[1].kind);
    CHECK(ops[2].kind == J64_ALU_RM_R && ops[2].size == 8, "op2 kind=%d size=%d", ops[2].kind, ops[2].size);
    // Control-flow termination: stream ending in JNZ stops after it.
    const U8 prog2[] = {0x48, 0x31, 0xC0, 0x74, 0x07, 0x48, 0x89, 0xC7};
    n = jit64CompileStream(0x400000, prog2, sizeof(prog2), ops, 16, true);
    CHECK(n == 2 && ops[1].kind == J64_JCC, "cf-stop n=%u kind=%d", n, n >= 2 ? ops[1].kind : -1);
    // syscall terminates too.
    const U8 prog3[] = {0xB8, 0x3C, 0x00, 0x00, 0x00, 0x0F, 0x05, 0x90};
    n = jit64CompileStream(0x400000, prog3, sizeof(prog3), ops, 16, true);
    CHECK(n == 2 && ops[1].kind == J64_SYSCALL, "syscall-stop n=%u", n);
}

static void testBlockCache() {
    Jit64BlockCache cache;
    Jit64Op ops[2];
    U32 n = jit64CompileStream(0x400000, (const U8*)"\x48\x89\xC8\x48\x01\xC8", 6, ops, 2, false);
    CHECK(n == 2, "cache-setup n=%u", n);
    // Miss before insert.
    CHECK(cache.lookup(0x400000, 1, 7, 1, 7) == nullptr, "lookup hit before insert");
    const Jit64Block* b = cache.insert(0x400000, 1, 7, 1, 7, ops, n);
    CHECK(b && b->executable && b->fastCount == 2, "insert executable=%d fast=%u", b ? b->executable : -1, b ? b->fastCount : 0);
    // Hit with matching gens.
    const Jit64Block* h = cache.lookup(0x400000, 1, 7, 1, 7);
    CHECK(h == b, "lookup miss after insert");
    // Stale gen -> miss (self-modifying code invalidation path).
    CHECK(cache.lookup(0x400000, 1, 8, 1, 7) == nullptr, "stale gen0 should miss");
    CHECK(cache.lookup(0x400000, 1, 7, 1, 9) == nullptr, "stale gen1 should miss");
    // Wrong rip -> miss.
    CHECK(cache.lookup(0x400008, 1, 7, 1, 7) == nullptr, "wrong rip should miss");
    // Block containing a fallback op is NOT executable (whole-block fallback rule).
    Jit64Op mixed[2];
    CHECK(jit64DecodeOne(0x500000, (const U8*)"\x48\x89\xC8", 3, mixed[0]), "mixed0");
    CHECK(jit64DecodeOne(0x500003, (const U8*)"\x0F\x05", 2, mixed[1]), "mixed1");
    jit64Classify(mixed[0], false, false);
    jit64Classify(mixed[1], false, false);
    const Jit64Block* nb = cache.insert(0x500000, 2, 1, 2, 1, mixed, 2);
    CHECK(nb && !nb->executable, "mixed block must not be executable");
    CHECK(cache.lookup(0x500000, 2, 1, 2, 1) == nullptr, "non-executable must not hit");
    // invalidate + stats.
    cache.invalidate(0x400000);
    CHECK(cache.lookup(0x400000, 1, 7, 1, 7) == nullptr, "invalidated entry should miss");
    CHECK(cache.lookups() >= 6 && cache.hits() == 1 && cache.inserts() == 2,
          "stats lookups=%llu hits=%llu inserts=%llu", cache.lookups(), cache.hits(), cache.inserts());
}

static void testPlanText() {
    Jit64BlockCache cache;
    Jit64Op ops[2];
    U32 n = jit64CompileStream(0x400000, (const U8*)"\x48\x89\xC8\x74\x02", 5, ops, 2, true);
    CHECK(n == 2, "plantext-setup n=%u", n);
    const Jit64Block* b = cache.insert(0x400000, 0, 0, 0, 0, ops, n);
    char buf[512];
    U32 used = jit64EmitPlanText(*b, buf, sizeof(buf));
    CHECK(used > 0, "plan text empty");
    CHECK(std::strstr(buf, "fast") != nullptr, "plan text missing 'fast': %s", buf);
    CHECK(std::strstr(buf, "kind=0") != nullptr, "plan text missing kind=0: %s", buf);
    // Too-small buffer reports 0 (no truncation).
    CHECK(jit64EmitPlanText(*b, buf, 8) == 0, "small buffer should report 0");
}

static void testJitFlag() {
    // Default (env unset in test runner): disabled. Explicit check only that
    // the accessor is stable (cached) — behavior change requires env.
    bool a = jit64Enabled();
    bool b = jit64Enabled();
    CHECK(a == b, "jit64Enabled not stable");
}

int main() {
    printf("jit64 phase-1 unit tests\n");
    testCoverageTable();
    testMovForms();
    testAluForms();
    testMiscFast();
    testFallbackRules();
    testCompileStream();
    testBlockCache();
    testPlanText();
    testJitFlag();
    printf("  %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
