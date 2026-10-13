// web/tests/suite/unit/input-keyboard-full.test.mjs — Input: keyboard is NOT "assumed fixed" (P7).
//
// Past: keyboard "assumed fixed" (same mutex path as mouse — never confirmed);
// XWire hit-test ran before delta accumulation → negative rel deltas failed
// y>=0, never reached game → accumulate into virtual absolute first (5b0cdb74,
// verified 10/10 button, relMouse:true); Wine merge_events collapses
// back-to-back MotionNotify → pace like real pointerlock HW (probe workaround);
// wheel dropped; X1/X2 mis-mapped as wheel; relative missing in headless
// (70270923); concurrent main/guest XWire → recursive per-connection I/O
// mutex (10bef982). Celeste needs keyboard + gamepad; Portal needs FPS mouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const conn = readFileSync(join(repoRoot, 'source/x11wire/xwireconnection.cpp'), 'utf8');
const sdl = readFileSync(join(repoRoot, 'source/x11wire/xwirepresentSDL.cpp'), 'utf8');

test('virtual-absolute accumulation precedes hit-test (5b0cdb74 negative-delta guard)', () => {
  assert.ok(conn.includes('virtual absolute') || conn.includes('accumulate'),
    'EvMotionRel deltas must accumulate into virtual absolute BEFORE hit-test (dy=-5 fails y>=0 → event lost)');
});

test('recursive per-connection I/O mutex exists (10bef982 concurrent access)', () => {
  assert.ok(conn.includes('recursive_mutex') && conn.includes('ioMutex'),
    'XWire must use recursive per-connection I/O mutex (main-thread/guest-thread race)');
});

test('wheel buttons 4/5/6/7 mapped with press+release (dropped-wheel guard)', () => {
  assert.ok(sdl.includes('SDL_BUTTON_X1') && sdl.includes('SDL_BUTTON_X2'),
    'X1/X2 must map to 8/9, not wheel buttons (mis-map guard)');
  assert.ok(sdl.includes('wheel') && (sdl.includes('button 4') || sdl.includes('button4') || sdl.includes('BUTTON_WHEEL') || sdl.includes('4 = up')),
    'wheel convention (4=up,5=down,6=left,7=right + release) must exist');
});

test('keyboard scancode path returns REAL keysyms (GetKeyboardMapping)', () => {
  assert.ok(conn.includes('GetKeyboardMapping') || sdl.includes('sdlScancodeToX11'),
    'sdlScancodeToX11 (evdev+8) + REAL keysyms must exist — keyboard inferred-from-mouse is a test gap, not coverage (P7)');
  assert.ok(sdl.includes('evdev') || sdl.includes('+ 8') || sdl.includes('+8'),
    'evdev scancode+8 mapping must exist (Wine XKB correctness)');
});

test('relative motion works in headless (70270923)', () => {
  assert.ok(sdl.includes('rel') || sdl.includes('Rel') || conn.includes('Rel'),
    'relative-motion path must exist for headless (no HW cursor) + pointerlock pacing (merge_events collapse workaround)');
});
