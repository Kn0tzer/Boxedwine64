// web/tests/suite/unit/harness-no-stall.test.mjs — No test stalls forever (user requirement).
//
// Every test must REPORT failure, never hang. Guards:
//  (a) runner kills hung unit files after 120s and reports FAIL,
//  (b) runner wraps browser tests in timeoutMs+60s outer timeout,
//  (c) probe-base setup/teardown have finite timeouts,
//  (d) every browser test uses waitForPageFn with explicit timeout (no bare
//      waitForFunction / infinite poll loops).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(suiteDir, '..', '..', '..', '..');
const runner = readFileSync(join(repoRoot, 'web/tests/suite/runner.mjs'), 'utf8');
const probeBase = readFileSync(join(repoRoot, 'web/tests/suite/lib/probe-base.mjs'), 'utf8');

test('runner kills hung unit tests (120s SIGKILL → FAIL)', () => {
  assert.ok(runner.includes('UNIT_TIMEOUT_MS'), 'runner must define UNIT_TIMEOUT_MS');
  assert.ok(runner.includes('SIGKILL'), 'runner must SIGKILL hung unit procs');
  assert.ok(runner.includes('never stall'), 'timeout error must state never-stall contract');
});

test('runner wraps browser tests in outer timeout (timeoutMs+60s → FAIL)', () => {
  assert.ok(runner.includes('Promise.race'), 'browser wrapper must use Promise.race timeout');
  assert.ok(runner.includes('browser test timed out'), 'timeout must report FAIL with test name');
});

test('probe-base setup/teardown are bounded (server 60s, browser 120s, close 15/10/5s)', () => {
  assert.ok(probeBase.includes('withTimeout'), 'probe-base must wrap setup/teardown in withTimeout');
  assert.ok(probeBase.includes('60000') && probeBase.includes('120000'),
    'server start (60s) and chromium.launch (120s) must be bounded');
});

test('every browser test uses waitForPageFn with timeout (no infinite waits)', () => {
  const dir = join(suiteDir, '..', 'browser');
  const files = readdirSync(dir).filter(f => f.endsWith('.test.mjs'));
  assert.ok(files.length >= 8, `expected 8+ browser tests, found ${files.length}`);
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(src.includes('waitForPageFn'),
      `${f}: must use waitForPageFn (bounded) — bare waitForFunction / while(true) would stall forever`);
    assert.ok(!src.includes('while (true)') && !src.includes('while(true)'),
      `${f}: must not contain infinite while(true) poll loops`);
  }
});

test('unit tests are synchronous file/assert checks (no network/browser hangs)', () => {
  const files = readdirSync(suiteDir).filter(f => f.endsWith('.test.mjs') && f !== 'harness-no-stall.test.mjs');
  for (const f of files) {
    const src = readFileSync(join(suiteDir, f), 'utf8');
    assert.ok(!src.includes('from "@playwright') && !src.includes("from '@playwright") && !src.includes('chromium.launch('),
      `${f}: unit tests must not launch browsers (browser hangs belong in browser/ with timeouts)`);
  }
});
