// web/tests/suite/runner.mjs — Master test runner for the Boxedwine64 suite.
//
// Runs ALL tests and reports per-test PASS/FAIL with specific assertion messages.
// Exit code 0 = all pass. Non-zero = one or more failures.
//
// Usage:
//   node web/tests/suite/runner.mjs                    # run everything
//   node web/tests/suite/runner.mjs --unit             # unit tests only (fast, no browser)
//   node web/tests/suite/runner.mjs --browser          # browser tests only (slow, needs box)
//   node web/tests/suite/runner.mjs --filter d3d11     # only tests matching 'd3d11'
//   node web/tests/suite/runner.mjs --json             # JSON summary to stdout (for CI)
//
// Test discovery:
//   unit/*.test.mjs    — run via node:test (fast, no browser)
//   browser/*.test.mjs — default-export a ProbeTest subclass (slow, Playwright)
//
// Each test prints:  PASS <name> (<duration>ms)
//                or: FAIL <name> (<duration>ms)\n  <error message>

import { readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const suiteDir = dirname(fileURLToPath(import.meta.url));
const unitDir = join(suiteDir, "unit");
const browserDir = join(suiteDir, "browser");

const args = process.argv.slice(2);
const onlyUnit = args.includes("--unit");
const onlyBrowser = args.includes("--browser");
const jsonOutput = args.includes("--json");
const filterArg = args.find(a => a.startsWith("--filter="));
const filter = filterArg ? filterArg.split("=")[1].toLowerCase() : null;

const results = [];

function log(...a) { if (!jsonOutput) console.log(...a); }

function record(name, category, passed, durationMs, error = null) {
  results.push({ name, category, passed, durationMs, error: error ? String(error).slice(0, 2000) : null });
  if (passed) {
    log(`  PASS ${name} (${durationMs}ms)`);
  } else {
    log(`  FAIL ${name} (${durationMs}ms)`);
    log(`    ${String(error).split("\n").join("\n    ")}`);
  }
}

// --- Unit tests: run each file via node --test, parse TAP output ---
// FAILS (never stalls): 120s per-file timeout kills hung tests and reports FAIL.
const UNIT_TIMEOUT_MS = Number(process.env.BW64_UNIT_TIMEOUT_MS || 120000);
async function runUnitFile(file) {
  const name = basename(file, ".test.mjs");
  const t0 = Date.now();
  return new Promise(resolve => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(killTimer); resolve(r); } };
    const proc = spawn("node", ["--test", file], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => stdout += d);
    proc.stderr.on("data", d => stderr += d);
    const killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      finish({ passed: false, durationMs: Date.now() - t0, error: `FAIL ${name}: timed out after ${UNIT_TIMEOUT_MS}ms (hung test killed — never stall forever)` });
    }, UNIT_TIMEOUT_MS);
    proc.on("close", code => {
      const durationMs = Date.now() - t0;
      // Parse TAP: look for "not ok" lines
      const failures = stdout.split("\n").filter(l => l.startsWith("not ok"));
      if (code === 0 && failures.length === 0) {
        finish({ passed: true, durationMs });
      } else {
        const detail = failures.join("\n") || stderr.slice(0, 1000) || `exit code ${code}`;
        finish({ passed: false, durationMs, error: detail });
      }
    });
    proc.on("error", e => finish({ passed: false, durationMs: Date.now() - t0, error: String(e) }));
  });
}

// --- Browser tests: import the module, instantiate default export, run ---
// FAILS (never stalls): outer timeout = test.timeoutMs + 60s setup/teardown grace.
// Any hang (slot, server, browser, page, teardown) becomes FAIL with a message.
async function runBrowserFile(file) {
  const name = basename(file, ".test.mjs");
  const t0 = Date.now();
  let test = null;
  try {
    const mod = await import(pathToFileURL(file).href);
    const TestClass = mod.default;
    if (!TestClass) throw new Error("No default export (expected a ProbeTest subclass)");
    test = new TestClass();
    const timeoutMs = (test.timeoutMs || 900000) + 60000;
    const runOnce = (async () => {
      await test.setup();
      try {
        const page = await test.newPage();
        try {
          await test.run({ page, console: test.consoleLines, dir: test.dir, server: test._server });
        } finally {
          try { await page.close(); } catch {}
        }
      } finally {
        await test.teardown();
      }
    })();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`FAIL ${name}: browser test timed out after ${timeoutMs}ms (hung probe killed — never stall forever)`)), timeoutMs));
    await Promise.race([runOnce, timeout]);
    return { passed: true, durationMs: Date.now() - t0 };
  } catch (e) {
    // Ensure cleanup even on failure/timeout (best effort, 10s cap each)
    if (test) {
      try { await Promise.race([test.teardown(), new Promise(r => setTimeout(r, 10000))]); } catch {}
    }
    return { passed: false, durationMs: Date.now() - t0, error: e.message + "\n" + (e.stack || "").split("\n").slice(1, 4).join("\n") };
  }
}

async function main() {
  const runUnit = !onlyBrowser;
  const runBrowser = !onlyUnit;

  if (runUnit) {
    log("Unit tests (fast, no browser):");
    let files = [];
    try { files = readdirSync(unitDir).filter(f => f.endsWith(".test.mjs")).sort(); } catch {}
    for (const f of files) {
      const name = basename(f, ".test.mjs");
      if (filter && !name.toLowerCase().includes(filter)) continue;
      const r = await runUnitFile(join(unitDir, f));
      record(name, "unit", r.passed, r.durationMs, r.error);
    }
  }

  if (runBrowser) {
    log("Browser tests (Playwright, needs box):");
    let files = [];
    try { files = readdirSync(browserDir).filter(f => f.endsWith(".test.mjs")).sort(); } catch {}
    for (const f of files) {
      const name = basename(f, ".test.mjs");
      if (filter && !name.toLowerCase().includes(filter)) continue;
      const r = await runBrowserFile(join(browserDir, f));
      record(name, "browser", r.passed, r.durationMs, r.error);
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  if (jsonOutput) {
    console.log(JSON.stringify({ passed, failed, results }, null, 2));
  } else {
    log(`\n${"=".repeat(50)}`);
    log(`SUITE RESULT: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      log("Failed tests:");
      for (const r of results.filter(r => !r.passed)) log(`  - ${r.name} [${r.category}]`);
    }
    log(`${"=".repeat(50)}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("Runner crashed:", e); process.exit(2); });
