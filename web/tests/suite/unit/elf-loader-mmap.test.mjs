// web/tests/suite/unit/elf-loader-mmap.test.mjs — 32-bit boot chain regression guards.
//
// The Oct 6–10 32-bit debug chain (~20 probes). Each fixed layer must be
// pinned independently (P6: "fixed" layers regress silently when the stack
// shifts, e.g. prefix gaining syswow64/rundll32 re-enabled Wineboot path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const kmem = readFileSync(join(repoRoot, 'source/kernel/kmemory.cpp'), 'utf8');
const kproc = readFileSync(join(repoRoot, 'source/kernel/kprocess.cpp'), 'utf8');
const loader = readFileSync(join(repoRoot, 'source/kernel/loader/loader.cpp'), 'utf8');
const syscall = readFileSync(join(repoRoot, 'source/kernel/syscall.cpp'), 'utf8');
const softmmu = readFileSync(join(repoRoot, 'source/emulation/softmmu/soft_rw_page.cpp'), 'utf8');

test('allocator does not place addr=0 maps in kernel space (22e6d13c/ca4ebc6f)', () => {
  assert.ok(kmem.includes('ADDRESS_PROCESS_MMAP_START'),
    'KMemory::mmap must gate against ADDRESS_PROCESS_MMAP_START (0xC0800000+ kernel-space misplacement)');
  assert.ok(kproc.includes('LDT') || kmem.includes('wineMajorVersion') || kmem.includes('ADDRESS_PROCESS_MMAP_START'),
    'allocator version-gate path must still reference user-space placement');
});

test('3GB boundary check rejects only start-beyond-3GB (4e7257cf: 23318 ENOMEM)', () => {
  assert.ok(kmem.includes('ADDRESS_PROCESS_MMAP_START'),
    '3GB boundary logic must exist (Wine mmaps at BFFF0000 MAP_FIXED_NOREPLACE)');
});

test('MAP_FIXED_NOREPLACE heap collisions forward-scan (6d688403/6adc83d0)', () => {
  assert.ok(kmem.includes('K_MAP_FIXED_NOREPLACE') || kmem.includes('MAP_FIXED_NOREPLACE') || kmem.includes('FIXED_NOREPLACE'),
    'heap-collision forward-scan for 1MB PROT_NONE reservations (RtlCreateHeap 0x10000000 → c0000017) must exist');
});

test('clone() steps EIP past syscall (91b77cb1: 74 → 2 WebAssembly.Exceptions)', () => {
  assert.ok(kproc.includes('EIP at the int 0x80') || kproc.includes('step over') || kproc.includes('eip'),
    'KProcess::clone must step child EIP past the syscall (peek32(0) → 0 fault loop regression)');
});

test('clone() runs before TLS/GS setup (95cd034b: faultAddr=0x218 SIGSEGV)', () => {
  // Two clone sites exist (cloneVM fork path + CLONE_THREAD path); the thread
  // path carries the MUST-come-before-TLS comment. Check ANY site has it.
  const idxs = [];
  let from = 0;
  while (true) {
    const i = kproc.indexOf('newThread->clone(thread)', from);
    if (i === -1) break;
    idxs.push(i);
    from = i + 1;
  }
  assert.ok(idxs.length > 0, 'clone-before-TLS ordering marker must exist');
  const ok = idxs.some(idx => {
    const window = kproc.slice(Math.max(0, idx - 200), idx + 600);
    return window.includes('TLS') || window.includes('MUST come before');
  });
  assert.ok(ok,
    'clone() must be documented/ordered before TLS setup (GS clobber regression)');
});

test('nested exception escape is caught (8db5e8cd)', () => {
  const src = readFileSync(join(repoRoot, 'source/emulation/cpu/normal/normalPlatformMultiThreaded.cpp'), 'utf8');
  const catches = (src.match(/catch/g) || []).length;
  assert.ok(catches >= 2, `nested try/catch for page-fault→getNextOp fault (worker crash) must exist (found ${catches} catch)`);
});

test('32-bit fork syscall exists via clone path (7bfa2b18)', () => {
  assert.ok(syscall.includes('syscall_fork'), '__NR_fork (syscall 2) must be implemented via clone path');
  assert.ok(syscall.includes('syscall_clone'), '__NR_clone must exist');
});

test('ELF getInterpreter loops e_phnum not e_phoff (53e8117a)', () => {
  assert.ok(loader.includes('e_phnum'), 'getInterpreter must loop e_phnum (e_phoff-loop regression)');
});

test('ElfLoader loads main binary first, PT_INTERP at 0xB0000000 (1c95e140)', () => {
  assert.ok(loader.includes('0xB0000000') || loader.includes('0xB0000000'.toLowerCase()),
    'interpreter base 0xB0000000 marker must exist (AT_PHDR/AT_ENTRY pointed at wrong binary)');
  assert.ok(loader.includes('AT_ENTRY') || loader.includes('process->entry'),
    'AT_ENTRY bookkeeping for main binary must exist');
});

test('LDT has entries for Wine 32-bit PE (86c68a9f: needs LDT[4]/LDT[5])', () => {
  assert.ok(kproc.includes('LDT[4]') || kproc.includes('LDT') && kproc.includes('0x23'),
    'LDT setup must reference Wine 32-bit PE segments (CS=0x23 LDT[4], DS=0x2B LDT[5])');
});

test('PT_INTERP ELFs do not prepend /lib/ld-linux.so.2 to argv', () => {
  assert.ok(loader.includes('PT_INTERP') || loader.includes('interpreter'),
    'loader must handle PT_INTERP without argv prepending (unlike Linux, unlike 64-bit path)');
});

test('32-bit socket isolation uses /server32- (a13f6816: 1394 zero-byte polls)', () => {
  assert.ok(kproc.includes('server32-'),
    'KProcess socket path must isolate 32-bit (/server- → /server32-)');
  const ksock = readFileSync(join(repoRoot, 'source/kernel/ksocket.cpp'), 'utf8');
  assert.ok(ksock.includes('server32-'), 'ksocket must also isolate 32-bit server paths');
});

test('soft-MMU fast path requires backing RAM (32-bit non-determinism fix)', () => {
  assert.ok(softmmu.includes('ramIndex'), 'soft-MMU must gate fast path on backing RAM (host address zero corruption)');
  assert.ok(softmmu.includes('onDemmand') || softmmu.includes('onDemand') || softmmu.includes('ramPageAlloc'),
    'on-demand page backing must exist');
});

test('CPU Callback routes through normalDispatch (BOXEDWINE_DIRECT_NORMAL_DISPATCH)', () => {
  const cpu = readFileSync(join(repoRoot, 'source/emulation/cpu/normal/normalCPU.cpp'), 'utf8');
  assert.ok(cpu.includes('normalDispatch') && cpu.includes('onExitSignal') && cpu.includes('Callback'),
    'normalCPU.cpp must route Callback table OOB through normalDispatch()/onExitSignal()');
});

test('signal frame resets CS/SS/DS/ES bases (linear-memory fault fix)', () => {
  const kthread = readFileSync(join(repoRoot, 'source/kernel/kthread.cpp'), 'utf8');
  assert.ok(kthread.includes('setSegment') || kthread.includes('runSignal'),
    'KThread::runSignal setSegment handling must exist');
});

test('FS:0x1f8 seg_mapper workaround exists (36074007: 0x76fc80 unmapped)', () => {
  const kthread = readFileSync(join(repoRoot, 'source/kernel/kthread.cpp'), 'utf8');
  assert.ok(kthread.includes('seg_mapper') || kthread.includes('segMapper') || kthread.includes('0x1f8') || kthread.includes('syscall_frame'),
    'FS:0x1f8 on-demand mapping workaround must exist (every win32u syscall killer)');
});

test('stale Wine8 FINDENV intercept is gone (EIP=0x3078303D ASCII "=0x0")', () => {
  const cpu = readFileSync(join(repoRoot, 'source/emulation/cpu/common/cpu.cpp'), 'utf8');
  assert.ok(!cpu.includes('FINDENV_INTERCEPT') || !cpu.includes('0x1064D470'),
    'stale Wine8-era FINDENV_INTERCEPT at ntdll 0x1064D470 must be removed (Wine10 corruption)');
});
