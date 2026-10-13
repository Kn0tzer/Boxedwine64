// web/tests/suite/browser/audio-tone.test.mjs — Audible bytes, not QueueAudio calls (P7).
//
// Precedent: SDL_QueueAudio verified with zero audible output (captured all
// zeros; drain timer never fired). Ground truth is a real 441Hz sine through
// /dev/dsp (10e1b456) with non-zero captured bytes. Wine waveOut hang
// (WHDR_DONE never fires) stays OPEN — this test must fail there, not pass
// on call counts.

import { ProbeTest } from '../lib/probe-base.mjs';
import { check, checkGreaterThan } from '../lib/assert.mjs';

export default class AudioToneTest extends ProbeTest {
  constructor() {
    super({ tag: 'audio-tone', timeoutMs: 900000 });
  }

  async run(ctx) {
    const { page } = ctx;
    await page.goto(`${ctx.server.url}/?test=audio-tone`);
    await this.waitForPageFn(page, () => window.__done === true, 600000);

    const calls = await page.evaluate(() => window.__queueCalls ?? 0);
    const nonZero = await page.evaluate(() => window.__nonZeroBytes ?? window.__rms ?? 0);

    checkGreaterThan(calls, 0, 'SDL_QueueAudio/bwPump must be called at least once');
    checkGreaterThan(nonZero, 0,
      `captured audio must contain non-zero bytes (441Hz sine ground truth; got ${nonZero} from ${calls} calls — zeros = drain-timer bug, not verified)`);
  }
}
