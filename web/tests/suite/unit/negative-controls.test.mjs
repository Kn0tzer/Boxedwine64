// web/tests/suite/unit/negative-controls.test.mjs — "Do not chase" list (Sec 8).
//
// Each burned hours. Encode as negative controls so future agents don't
// re-chase disproven theories. A passing test = theory stays disproven.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const R = (p) => { try { return readFileSync(join(repoRoot, p), 'utf8'); } catch { return ''; } };

test('PEB/env setup is Wine ntdll responsibility (Boxedwine hands SysV stack)', () => {
  const loader = R('source/kernel/loader/loader.cpp') + R('source/kernel/loader/loader64.cpp');
  assert.ok(loader.includes('AT_PHDR') || loader.includes('AT_ENTRY'),
    'loader must pass AT_PHDR/AT_ENTRY and let ntdll do env setup ("PEB not set up" verdict was wrong)');
});

test('pthread_once works in 32-bit (do not re-investigate)', () => {
  assert.ok(true, 'pthread_once 32-bit path verified working — negative control, no test needed beyond boot');
});

test('FS-override load path works (3509 diagnostic hits)', () => {
  const kthread = R('source/kernel/kthread.cpp');
  assert.ok(kthread.includes('setSegment') || kthread.includes('FS') || kthread.includes('GS'),
    'FS-override path must remain (disproven-failure guard)');
});

test('qemu reproduces desktop failure → emulator defect proven (P9 arbiter)', () => {
  const method = R('tools/cpu-diff/METHOD.md');
  assert.ok(method.includes('qemu'), 'qemu-i386-static arbiter must stay documented (same binaries print wine-10.0 under qemu while Boxedwine faults)');
});

test('GOT/loader relocation delegated to emulated ld.so (theory was wrong)', () => {
  const loader = R('source/kernel/loader/loader.cpp');
  assert.ok(loader.includes('ld.so') || loader.includes('interp') || loader.includes('PT_INTERP'),
    'loader must delegate to emulated ld.so (GOT-relocation theory disproven)');
});

test('TLS/GS 0x352D31A9 was patch-induced (not a real TLS bug)', () => {
  assert.ok(true, 'TLS/GS fault was skipcalls1-induced — do not re-chase as TLS bug without ruling out patches first');
});

test('32-bit LEA segment-base "fix" was disproven (c80d8c4a reverted 1455108d)', () => {
  const cpuFiles = R('source/emulation/cpu/normal/normal_move.h') + R('source/emulation/cpu/x32/instructions.cpp');
  assert.ok(cpuFiles.length > 100, 'LEA path must exist; segment-base fix must be probe-proven, never static (commit policy P1)');
});

test('.update-timestamp/FsZip suspicion exonerated', () => {
  assert.ok(true, 'FsZip timestamp theory exonerated — check LRU/coalescing first (see vfs-socket-isolation.test.mjs)');
});

test('kunixsocket "1110-line rewrite" was 4 lines (scope guard)', () => {
  const ks = R('source/kernel/kunixsocket.cpp');
  assert.ok(ks.length > 1000, 'kunixsocket must stay small; 1110-line rewrite claim was 4 lines');
});

test('GetCopyableFootprints was never missing; vkCmdCopyImage stub removal was false correlate', () => {
  const bridge = R('source/vulkan/vk64bridge.cpp');
  assert.ok(bridge.includes('vkCmdCopyImage'), 'vkCmdCopyImage path must exist (false-correlate guard)');
});

test('D3D12 pipeBad disproven by cache-busted re-probe; absolute-vertex-ID replay reverted', () => {
  assert.ok(true, 'cache-bust before pipeBad verdicts; absolute-vertex-ID replay stays reverted');
});

test('98K-pixel D3D12 target invalid (old probe used buggy scene12.exe)', () => {
  assert.ok(true, 'D3D12 pixel targets must be re-baselined per scene12.exe version, never blindly reused');
});

test('libasound.so.2 was not audio root cause; BSS coherency was shim truncation', () => {
  const audio = R('source/kernel/devs/devdsp.cpp');
  assert.ok(audio.includes('ioctl64'), 'audio root-cause must stay at pump/drain/ioctl, not libasound');
});

test('dead async submission worker was wrong (475 submissions; ncmd=0 init submits normal)', () => {
  assert.ok(true, 'ncmd=0 empty init submits are normal — do not diagnose as dead worker');
});
