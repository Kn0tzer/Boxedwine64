// web/tests/suite/browser/input-keyboard.test.mjs — Keyboard is verified, not assumed (P7).
//
// Mouse path (10/10 buttons, relMouse:true, 5b0cdb74) does NOT prove keyboard.
// This test injects real key events and requires the guest to observe them.
// Pong "50% loss" precedent: parser must use raw logs (12/12) with truncation
// tolerance, strict regexes must allow Emscripten prefixes, and verdicts need
// proven-positive controls.

import { ProbeTest } from '../lib/probe-base.mjs';
import { check, checkGreaterThan } from '../lib/assert.mjs';

export default class InputKeyboardTest extends ProbeTest {
  constructor() {
    super({ tag: 'input-keyboard', timeoutMs: 900000 });
  }

  async run(ctx) {
    const { page } = ctx;
    await page.goto(`${ctx.server.url}/?test=input-keyboard`);
    await this.waitForPageFn(page, () => window.__done === true, 600000);

    const seen = await page.evaluate(() => window.__keysSeen ?? []);
    const raw = await page.evaluate(() => window.__rawLog ?? '');
    check(Array.isArray(seen), `guest must report observed keys array (got ${typeof seen}; raw log len ${String(raw).length})`);

    checkGreaterThan(seen.length, 0,
      `keyboard events must reach guest (seen ${seen.length}; 0 = assumed-fixed fallacy P7 — check sdlScancodeToX11, focus, hit-test routing)`);
  }
}
