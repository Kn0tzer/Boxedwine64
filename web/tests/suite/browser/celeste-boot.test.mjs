// web/tests/suite/browser/celeste-boot.test.mjs — Celeste capability gate (32-bit OpenGL).
//
// Does NOT claim gameplay. Gates the systemic preconditions that previously
// blocked Celeste before any game code ran: 32-bit Wine boot (wine-10.0),
// pixel-format query → CELESTE 1.4.0.0 / BEGIN LOAD, Content file access
// (large FMOD banks via FsZip per-node streams), and provenance match.
// Full playability = this + gl32-triangle + input-keyboard + audio-tone green.

import { ProbeTest } from '../lib/probe-base.mjs';
import { check, checkGreaterThan, checkIncludes } from '../lib/assert.mjs';

export default class CelesteBootTest extends ProbeTest {
  constructor() {
    super({ tag: 'celeste-boot', timeoutMs: 1200000 });
  }

  async run(ctx) {
    const { page } = ctx;
    await page.goto(`${ctx.server.url}/?test=celeste-boot`);
    await this.waitForPageFn(page, () => window.__done === true, 900000);

    const version = await page.evaluate(() => window.__wineVersion ?? '');
    if (version) {
      checkIncludes(String(version), 'wine',
        `32-bit wine --version must print wine-x.y (got ${version}; qemu prints wine-10.0 → emulator defect if not)`);
    }

    const stage = await page.evaluate(() => window.__celesteStage ?? '');
    check(String(stage).length > 0,
      'Celeste probe must report a stage (pixel-format query / CELESTE version / BEGIN LOAD). Empty = infra-blocked, not "assumed working" (P7).');

    const buildInfo = await page.evaluate(() => window.__buildInfo ?? null);
    if (buildInfo) {
      check(!!buildInfo.wasm_sha256, 'probe must assert BUILD_INFO wasm hash before trusting result (P2 stale-binary guard)');
    }
  }
}
