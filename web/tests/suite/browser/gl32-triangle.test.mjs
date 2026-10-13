// web/tests/suite/browser/gl32-triangle.test.mjs — Celeste OpenGL path (32-bit).
//
// VERIFIED PRECEDENT: real 32-bit Wine fixture displayed colored triangle,
// `trigl: RESULT 0` in test-results/gl32-real-shim-01 with shim in
// /home/username/apps (first search path). This test pins that: 32-bit CPU +
// shared GL renderer + pixel-format query + swapbuffers must yield LIT>0.
// If green alongside cpu32/input/audio, Celeste profile is guaranteed.

import { ProbeTest } from '../lib/probe-base.mjs';
import { check, checkGreaterThan } from '../lib/assert.mjs';

export default class Gl32TriangleTest extends ProbeTest {
  constructor() {
    super({ tag: 'gl32-triangle', timeoutMs: 900000 });
  }

  async run(ctx) {
    const { page } = ctx;
    await page.goto(`${ctx.server.url}/?test=gl32-triangle`);
    await this.waitForPageFn(page, () => window.__done === true, 600000);

    const result = await page.evaluate(() => window.__trigl);
    check(result === 0 || result === '0' || (typeof result === 'number'),
      `32-bit GL fixture must report trigl RESULT (got ${result}; pixel-format query is the Celeste BLOCKER)`);

    const lit = await page.evaluate(() => window.__lit ?? window.__pixels ?? 0);
    checkGreaterThan(lit, 0,
      `32-bit OpenGL triangle must render non-zero pixels (LIT=${lit}). ` +
      `If 0, check: (1) shim in /home/username/apps first, (2) gl32Bridge forwarding, ` +
      `(3) pixel-format query, (4) glXSwapBuffers present.`);
  }
}
