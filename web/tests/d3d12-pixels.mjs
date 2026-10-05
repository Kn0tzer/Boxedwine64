// First-ever D3D12 live probe: tri12.exe -> vkd3d-proton -> shim -> v2 -> WebGPU.
// Clear-only: D3D12CreateDevice + 10 frames of ClearRenderTargetView (cornflower).
// Run from repo root: TAG=unique TIMEOUT=1800000 node web/tests/d3d12-pixels.mjs
// Uses existing dist artifacts, preserving their provenance. No build/deploy.
// Env overrides: TRI12_PATH, D3D12_PATH, D3D12CORE_PATH, VK_SHIM_PATH.
import { chromium } from "@playwright/test";
import { serve } from "../../tools/browser/serve.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { parseV2Chunk, V2FrameAssembler, decodeV2Frame } from "../vkwebgpu.mjs";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const tag = process.env.TAG || `d3d12-${Date.now()}`;
if (!/^[\w.-]+$/.test(tag)) throw new Error("TAG must contain only letters, numbers, _, . or -");
const dir = `test-results/dxvk-${tag}`;
await mkdir(dir, { recursive: true });

// Simple clear-color analysis: count pixels far from the page-tier default
// background (0,40,100). A working clear shows cornflower (100,149,237).
function clearPixels(png) {
  let width, height, channels, pos = 8;
  const data = [];
  while (pos + 12 <= png.length) {
    const n = png.readUInt32BE(pos), type = png.toString("ascii", pos + 4, pos + 8), b = png.subarray(pos + 8, pos + 8 + n);
    if (type === "IHDR") {
      width = b.readUInt32BE(0); height = b.readUInt32BE(4);
      channels = ({ 2: 3, 6: 4 })[b[9]];
      if (b[8] !== 8 || !channels) throw new Error("Unsupported PNG pixel encoding");
    } else if (type === "IDAT") data.push(b);
    pos += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(data)), stride = width * channels, rgb = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
    const a = x >= channels ? rgb[y * stride + x - channels] : 0;
    const b2 = y ? rgb[(y - 1) * stride + x] : 0;
    const c = y && x >= channels ? rgb[(y - 1) * stride + x - channels] : 0;
    const p = a + b2 - c, pa = Math.abs(p - a), pb = Math.abs(p - b2), pc = Math.abs(p - c);
    const f = raw[y * (stride + 1)];
    const predictor = [0, a, b2, (a + b2) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c][f];
    if (predictor === undefined) throw new Error("Invalid PNG row filter");
    rgb[y * stride + x] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
  }
  const at = (x, y) => [...rgb.subarray((y * width + x) * channels, (y * width + x) * channels + 3)];
  const bg = [0, 40, 100], close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 24);
  const cornflower = [100, 149, 237];
  let nonBackground = 0, cornflowerPx = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = at(x, y);
    if (!close(px, bg)) { nonBackground++; if (close(px, cornflower)) cornflowerPx++; }
  }
  return { width, height, nonBackground, cornflowerPx,
    center: at(Math.floor(width / 2), Math.floor(height / 2)) };
}

const server = await serve(process.env.WINE_DIST_DIR || "dist");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/local/bin/chromium", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-webgpu",
    "--enable-unsafe-swiftshader", "--use-angle=vulkan", "--use-vulkan=swiftshader", "--enable-features=Vulkan"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logs = [], errors = [], chunkFiles = [], decodedFrames = [];
const capturedAssembler = new V2FrameAssembler();
page.on("console", m => logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", e => errors.push(e.message));
const flush = () => writeFile(`${dir}/console.log`, logs.join("\n"));
await page.exposeFunction("saveVkChunk", async b64 => {
  const file = `chunk-${String(chunkFiles.length).padStart(4, "0")}.bin`;
  chunkFiles.push(file);
  const bytes = Buffer.from(b64, "base64");
  const records = capturedAssembler.ingest(parseV2Chunk(bytes));
  if (records) {
    const frame = decodeV2Frame(records);
    decodedFrames.push({ frame: frame.frameNo, w: frame.width, h: frame.height,
      draws: frame.passes.flatMap(p => p.ops).filter(o => o.op === "draw").length,
      ops: frame.passes.flatMap(p => p.ops).map(o => o.op).join(",") });
  }
  await writeFile(`${dir}/${file}`, bytes);
});
const timeout = Number(process.env.TIMEOUT || 1800000);
let summary = { passed: false }, pixels = null;
const provenance = [];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/runtime/index.html?p=cmd%20%2Fc%20echo%20vkboot&session=1&novideo=1&persist=0&gltrace=0`);
  await page.waitForFunction(() => window.bwRuntime?.ready?.() === true, null, { timeout });
  console.log("SESSION READY");
  const assets = [
    ["tri12.exe", process.env.TRI12_PATH || "tools/vkd3d/probe/tri12.exe"],
    ["d3d12.dll", process.env.D3D12_PATH || "/home/ubuntu/wt-vkd3d/tools/vkd3d/build.w64/libs/d3d12/d3d12.dll"],
    ["d3d12core.dll", process.env.D3D12CORE_PATH || "/home/ubuntu/wt-vkd3d/tools/vkd3d/build.w64/libs/d3d12core/d3d12core.dll"],
    ["libvulkan.so.1", process.env.VK_SHIM_PATH || "tools/rootfs64/libvk64/libvulkan.so.1"]];
  for (const [name, path] of assets) {
    const bytes = await readFile(path);
    provenance.push({ name, path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    const b64 = bytes.toString("base64");
    await page.evaluate(({ name, b64 }) => {
      const fs = window.bwRuntime.fs();
      fs.mkdirTree("/root/home/username");
      fs.writeFile("/root/home/username/" + name, Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      const registered = window.bwRuntime.call("bw64_register_file", ["string"], ["/home/username/" + name]);
      if (registered !== 1) throw new Error("Guest VFS registration failed for " + name);
    }, { name, b64 });
  }
  console.log("ASSETS STAGED", JSON.stringify(provenance.map(p => [p.name, p.bytes])));
  const bootstrapUntil = Date.now() + timeout;
  while (!logs.some(l => /^log: vkboot\s*$/.test(l))) {
    if (Date.now() > bootstrapUntil) throw new Error("Wine bootstrap sentinel timed out");
    await flush();
    await page.waitForTimeout(500);
  }
  console.log("BOOTSTRAP COMPLETE");
  await page.evaluate(async () => {
    const { installVkPageTier } = await import("../vkwebgpu.mjs");
    window.bwVkTier = installVkPageTier();
    window.bwVkTierReady = Promise.resolve(window.bwVkTier);
    const original = window.bwVkChunk;
    window.bwVkChunk = (bytes, flags) => {
      let str = "";
      for (let i = 0; i < bytes.length; i += 8192) str += String.fromCharCode(...bytes.subarray(i, i + 8192));
      window.saveVkChunk(btoa(str));
      return original(bytes, flags);
    };
  });
  const spawn = await page.evaluate(() => window.bwRuntime.call("bw64_spawn", ["string", "string"],
    ["/usr/lib/wine/wine64\nZ:\\\\home\\\\username\\\\tri12.exe", "BW64_VKTRACE=2\nBW64_VKFRAME=1\nWINEDLLOVERRIDES=d3d12=n,d3d12core=n\nLD_LIBRARY_PATH=/home/username"]));
  console.log("SPAWN", spawn);
  const until = Date.now() + timeout;
  let lastPrint = 0, lastRendered = 0, shot = null;
  while (Date.now() < until) {
    const stats = await page.evaluate(() => window.bwVkStats?.());
    if (stats?.v2?.rendered > lastRendered) {
      lastRendered = stats.v2.rendered;
      shot = await page.evaluate(() => document.getElementById("vkCanvas")?.toDataURL("image/png"));
      await page.screenshot({ path: `${dir}/page.png` });
    }
    if (Date.now() - lastPrint > 15000) {
      lastPrint = Date.now();
      console.log("PROGRESS", JSON.stringify({ chunks: chunkFiles.length, stats, tail: logs.slice(-2) }));
      await flush();
    }
    if (logs.some(l => /tri12: RESULT [01]/.test(l))) {
      await page.waitForTimeout(3000);
      break;
    }
    if (logs.some(l => /exit_group syscall, status=[1-9]\d*.*cmd=.*tri12\.exe/.test(l))) break;
    if (errors.some(l => /unreachable|memory access out of bounds|Aborted/.test(l))) break;
    await page.waitForTimeout(250);
  }
  const stats = await page.evaluate(() => window.bwVkStats?.());
  if (!shot) shot = await page.evaluate(() => document.getElementById("vkCanvas")?.toDataURL("image/png"));
  if (shot) {
    const bytes = Buffer.from(shot.split(",")[1], "base64");
    await writeFile(`${dir}/canvas.png`, bytes);
    pixels = clearPixels(bytes);
  }
  const joined = logs.join("\n");
  const renderErrors = logs.filter(l => /page tier WebGPU error|frame rejected|chunk rejected|cannot translate/.test(l));
  // vkd3d gate diagnostics: capture the exact failing requirement from guest log
  const gateLines = logs.filter(l => /not supported|Lacking support|required|E_INVALIDARG|is not supported/i.test(l)).slice(0, 20);
  summary = {
    passed: /tri12: RESULT 0/.test(joined) && !errors.length && !renderErrors.length
      && stats?.v2?.rendered > 0 && pixels && pixels.cornflowerPx > 1000,
    tri12Result: /tri12: RESULT 0/.test(joined) ? 0 : /tri12: RESULT 1/.test(joined) ? 1 : null,
    tri12FailLines: logs.filter(l => /tri12: FAIL/.test(l)),
    gateLines,
    framesBuilt: (joined.match(/vk64: FRAME \d+ built/g) || []).length,
    chunksCaptured: chunkFiles.length, decodedFrames,
    guestExitLines: logs.filter(l => /exit_group syscall.*cmd=.*tri12\.exe/.test(l)),
    provenance, stats, pixels, errors, renderErrors,
  };
} catch (e) {
  summary.failure = String(e.stack || e);
} finally {
  await flush();
  await page.screenshot({ path: `${dir}/final-page.png` }).catch(() => {});
  await writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 2));
  await writeFile(`${dir}/chunks.json`, JSON.stringify(chunkFiles));
  console.log("D3D12 VERDICT", JSON.stringify(summary));
  await browser.close(); server.close();
  if (!summary.passed) process.exitCode = 1;
}
