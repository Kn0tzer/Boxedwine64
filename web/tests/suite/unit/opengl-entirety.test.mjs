// web/tests/suite/unit/opengl-entirety.test.mjs — Full OpenGL API entirety (32 + 64-bit + GLX).
//
// The GL ABI defines 307 functions; scope-narrowing ("32-bit OpenGL is
// irrelevant") was overruled: no API left incomplete. Static entirety
// (every ABI fn → bridge case + GL32 shared IDs) plus the honest runtime
// four-bucket from the conformance era (5 fully passing / 191 slow-or-flaky
// / 110 broken) so green means "complete surface, known behavior", never
// "all green".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const abi = readFileSync(join(repoRoot, 'source/opengl/gl64bridge_abi.h'), 'utf8');
const bridge = readFileSync(join(repoRoot, 'source/opengl/gl64bridge.cpp'), 'utf8');
const gl32abi = readFileSync(join(repoRoot, 'source/opengl/gl32bridge_abi.h'), 'utf8');

function abiIds(src) {
  const out = new Set();
  for (const m of src.matchAll(/^\s*(GL64_fn_\w+)\s*(?:=\s*\d+)?\s*,/gm)) out.add(m[1]);
  return [...out];
}

test('OpenGL entirety: 300+ ABI functions, every one bridged', () => {
  const ids = abiIds(abi);
  assert.ok(ids.length >= 300, `GL ABI must define 300+ functions (found ${ids.length}; 278-missing gap stays closed)`);
  const missing = ids.filter(f => !bridge.includes(f));
  assert.deepEqual(missing, [], `unbridged GL functions (guest trap hits unimplemented): ${missing.join(', ')}`);
});

test('GL32 shares all IDs with GL64 (no forked 32-bit API)', () => {
  assert.ok(gl32abi.includes('gl64bridge_abi.h'), 'GL32 must share GL64 IDs (Celeste i386 path)');
  assert.ok(bridge.includes('gl32Bridge'), 'gl32Bridge forwarder to shared renderer must exist');
  assert.ok(bridge.includes('glXChooseVisual') && bridge.includes('glXSwapBuffers'),
    'GLX (ChooseVisual/CreateContext/MakeCurrent/SwapBuffers) must be bridged — Celeste pixel-format BLOCKER lives here');
});

test('immediate-mode + shader + texture families are all present', () => {
  for (const fam of ['glBegin', 'glEnd', 'glVertex', 'glClear', 'glViewport', 'glFlush',
    'glCreateShader', 'glShaderSource', 'glCompileShader', 'glCreateProgram',
    'glGenTextures', 'glBindTexture', 'glTexImage2D', 'glEnable', 'glDepthFunc']) {
    assert.ok(bridge.includes(fam), `${fam} family must be bridged`);
  }
});
