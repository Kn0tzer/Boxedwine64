# Build / Probe Coordination Protocol

Exactly one writer of `dist/runtime/boxedwine64.{wasm,js}` at a time,
and no probe starts while a build is in flight. Violating this produces
torn builds that crash with `func is not a function` and poison every lane.

## Builds

Always through the wrapper. Never raw `make wasm64-mt`:

```sh
tools/bw64-build.sh          # build + verify + sync + provenance
tools/bw64-build.sh --check  # idle / in-progress / stale
```

The wrapper takes an atomic lock, refuses while any probe slot is held,
verifies WASM magic, copies the matched pair to `dist/runtime/` and
`web/runtime/`, and writes `BUILD_INFO.json` (git SHA, hashes, timestamp)
beside both. Identify yourself: `BW64_BUILD_OWNER="agent:<what>"`.

## Probes

Acquire a slot first, then wait for build idle:

```js
import { acquireProbeSlot } from './probe-slots.mjs';
import { waitForBuildIdle } from './build-lock.mjs';
const slot = await acquireProbeSlot();
await waitForBuildIdle(); // throws after 10 min on a stuck build
```

Record provenance in every `summary.json` (`dist/runtime/BUILD_INFO.json`).
A result without a recorded build hash is inadmissible — it may describe
a stale binary.
