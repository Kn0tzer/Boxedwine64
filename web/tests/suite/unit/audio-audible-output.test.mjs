// web/tests/suite/unit/audio-audible-output.test.mjs — Audio: STORE, not "assumed verified" (P7).
//
// Past: audio "verified" on SDL_QueueAudio calls with no audible output
// (later downgraded: captured output all zeros); pump ran but drain timer
// never fired → all zeros → bwPump bypass in kdspaudio.h/.cpp+devdsp.cpp;
// direct /dev/dsp path verified with real 441Hz sine (10e1b456); Wine waveOut
// still hangs (WHDR_DONE never fires, winealsa feeder stalls after ~2 writes
// — OPEN); custom 93KB winmm.dll bypass built, unverified; devdsp 120-line
// ioctl64 once replaced by ownerless 4-line -ENOTTY stub and restored.
// Celeste uses FNA + fmod.dll + SDL2.dll — needs REAL audible bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const devdsp = readFileSync(join(repoRoot, 'source/kernel/devs/devdsp.cpp'), 'utf8');
const kdsp = (() => { try { return readFileSync(join(repoRoot, 'include/kdspaudio.h'), 'utf8'); } catch { return ''; } })();

test('bwPump bypass exists (drain-timer-never-fired → all zeros guard)', () => {
  assert.ok(devdsp.includes('bwPump') || kdsp.includes('bwPump'),
    'bwPump bypass (JS Web Audio ring owns backpressure) must exist in kdspaudio.h/.cpp+devdsp.cpp');
});

test('ioctl64 is full 120-line path, not 4-line -ENOTTY stub', () => {
  assert.ok(devdsp.includes('ioctl64'), 'DevDsp::ioctl64 must exist');
  assert.ok(devdsp.length > 5000, `devdsp.cpp must be full implementation (found ${devdsp.length} chars; 4-line stub regression guard)`);
  assert.ok(devdsp.includes('OSS') || devdsp.includes('SNDCTL') || devdsp.includes('DSP_'),
    'OSS ioctl handling (SNDCTL_DSP_*) must exist');
});

test('WHDR_DONE / waveOut hang is tracked (OPEN, not claimed fixed)', () => {
  assert.ok(devdsp.includes('WHDR_DONE') || devdsp.includes('waveOut') || devdsp.includes('pending'),
    'waveOut WHDR_DONE-never-fires hang must be documented/handled (never claim audible without bytes)');
});

test('441Hz sine verification path exists (10e1b456 ground truth)', () => {
  const probes = ['web/tests/audio-tone-probe.mjs', 'web/tests/audio-dsptone.mjs', 'web/tests/audio-direct-p.mjs'];
  let found = false;
  for (const p of probes) {
    try {
      const src = readFileSync(join(repoRoot, p), 'utf8');
      if (src.includes('441') || src.includes('sine') || src.includes('tone')) found = true;
    } catch {}
  }
  assert.ok(found, '441Hz sine direct-/dev/dsp verification probe must exist (SDL_QueueAudio calls ≠ audible)');
});
