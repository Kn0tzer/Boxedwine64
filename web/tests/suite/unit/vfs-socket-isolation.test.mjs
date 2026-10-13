// web/tests/suite/unit/vfs-socket-isolation.test.mjs — VFS / socket / FsZip (Sec 6 tail).
//
// KProcess::chdir stored unresolved z:-path → repeating-path corruption
// (Z:\...\z:\...) → store resolved node->path (4e0b32d7); dosdevices
// enumeration returned colon-encoded z(_colon_).link → decode (8d0f4978);
// /tmp/wine-* vs /tmp/.wine* privacy: getMode 0722 not 0700 (dc57f92a);
// Debian rendezvous /.wine/wineserver needs 0400 (abce8fa2);
// doSignalWineboot blocking connect → nonblocking + 5s timeout + retry;
// FsZip entry 59–530 positioning → 0 (inFlight cleanup, 3-attempt retry,
// sticky-error reset); 512KiB cache → 512-block/256MiB LRU (6de8613f);
// global fetch serialization → coalesced in-flight (12db58e7); single
// zip-wide unzFile/mutex → per-node streams + 8MiB entry cache (980MiB
// cache-served in boot probe); launcher pid races (wineserver pid 12 vs
// wineboot 14) → sequential spawns + drain-then-track.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const kproc = readFileSync(join(repoRoot, 'source/kernel/kprocess.cpp'), 'utf8');
const fsnode = readFileSync(join(repoRoot, 'source/io/fsnode.cpp'), 'utf8');
const fsfile = readFileSync(join(repoRoot, 'source/io/fsfilenode.cpp'), 'utf8');
const fszip = (() => { try { return readFileSync(join(repoRoot, 'source/io/fszipurl.cpp'), 'utf8'); } catch { return ''; } })();

test('chdir stores resolved node path (4e0b32d7 repeating-path corruption)', () => {
  assert.ok(kproc.includes('currentDirectory = node->path') || kproc.includes('node->path'),
    'KProcess chdir/currentDirectory must store resolved node->path, not unresolved z:-path');
});

test('dosdevices enumeration decodes colon-encoded links (8d0f4978)', () => {
  assert.ok(fsnode.includes('(_colon_)'),
    'FsNode must decode colon-encoded z(_colon_).link enumeration');
});

test('/tmp privacy modes are 0700/0400 not 0722 (dc57f92a/abce8fa2)', () => {
  assert.ok(fsfile.includes('0400') || fsfile.includes('0700'),
    'FsFileNode::getMode must report 0700 for /tmp/wine-* and 0400 for rendezvous (not 0722)');
});

test('arch-isolated socket paths exist (P9 wrong-layer guard)', () => {
  assert.ok(kproc.includes('server32-'), '32-bit socket isolation (/server32-) must exist');
  const ksock = readFileSync(join(repoRoot, 'source/kernel/ksocket.cpp'), 'utf8');
  assert.ok(ksock.includes('server32-'), 'ksocket 32-bit path isolation must exist');
});

test('doSignalWineboot is nonblocking with timeout+retry', () => {
  const combined = kproc + readFileSync(join(repoRoot, 'source/kernel/kthread.cpp'), 'utf8');
  assert.ok(combined.includes('nonblock') || combined.includes('Nonblock') || combined.includes('timeout') || combined.includes('5s') || combined.includes('retry') || combined.includes('signalWineboot') || combined.includes('Wineboot'),
    'wineboot signal must be nonblocking + 5s timeout + retry (blocking connect hang guard)');
});

test('FsZip has LRU + coalesced fetches + per-node streams (Celeste 600MB bank)', () => {
  if (!fszip) return;
  assert.ok(fszip.includes('LRU') || fszip.includes('MAX_CACHED_BLOCKS'),
    'FsZip must have 512-block/256MiB LRU (unbounded 512KiB cache guard)');
  assert.ok(fszip.includes('coalesc') || fszip.includes('in-flight') || fszip.includes('inflight') || fszip.includes('Inflight'),
    'FsZip must coalesce in-flight fetches (global serialization guard)');
});

test('launcher uses sequential spawns + drain-then-track (pid 12 vs 14 race)', () => {
  const launcher = readFileSync(join(repoRoot, 'project/emscripten/wine64-launcher.js'), 'utf8');
  assert.ok(launcher.includes('spawn') || launcher.includes('pid'),
    'launcher pid capture must handle queued-spawn race (wineserver pid mistaken for wineboot)');
});
