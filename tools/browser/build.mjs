import { cp, mkdir, copyFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, process.env.WINE_BUILD_OUT || 'dist');
await mkdir(out, { recursive: true });
for (const name of ['index.html', 'style.css', 'app.mjs', 'files.mjs', 'games.mjs', 'storage.mjs', 'webgpu.mjs', 'shader.mjs', 'naga-rt.mjs', 'vkwebgpu.mjs']) await copyFile(resolve(root, 'web', name), resolve(out, name));
// Built-in game archives are staged under /games so the launcher catalog can
// range-fetch them. WINE_GAMES_DIR selects the source; WINE_GAMES_COPY=1 copies
// the archives instead of linking them (link is the default: they are 100+ MB).
const gamesOut = resolve(out, 'games');
async function findGames() {
  for (const dir of [process.env.WINE_GAMES_DIR, '/home/ubuntu/kn0tzer/wine/games', resolve(root, 'web/games')].filter(Boolean)) {
    try { await stat(resolve(dir, 'baldi.zip')); return dir; } catch { /* try the next source */ }
  }
  return null;
}
const gamesSrc = await findGames();
// Always drop the previous staging first, including the no-source branch: a
// stale dist/games left behind by an earlier build would still serve an old
// (or truncated) archive while this build reports the catalog as unavailable.
await rm(gamesOut, { recursive: true, force: true });
if (gamesSrc) {
  if (process.env.WINE_GAMES_COPY === '1') await cp(gamesSrc, gamesOut, { recursive: true });
  else await symlink(gamesSrc, gamesOut, 'dir');
  console.log(`Built-in games: ${gamesOut} -> ${gamesSrc} (${process.env.WINE_GAMES_COPY === '1' ? 'copied' : 'linked'})`);
} else {
  console.warn('Built-in games: no archive source found; the launcher catalog will report its card as unavailable.');
}

await mkdir(resolve(out, 'vendor'), { recursive: true });
await cp(resolve(root, 'node_modules/@zip.js/zip.js'), resolve(out, 'vendor/zip'), { recursive: true, dereference: true });
await cp(resolve(root, 'node_modules/naga-wasm/dist'), resolve(out, 'vendor/naga'), { recursive: true });
await mkdir(resolve(out, 'runtime'), { recursive: true });
for (const name of ['boxedwine64.js', 'boxedwine64.wasm']) await copyFile(resolve(root, 'project/emscripten/Build/Wasm64Mt', name), resolve(out, 'runtime', name));
await copyFile(resolve(root, 'project/emscripten/wine64-launcher.js'), resolve(out, 'runtime/wine64-launcher.js'));
for (const name of ['glibc-rootfs64.zip', 'wine64.zip', 'prefix64.zip']) await copyFile(resolve(root, 'web/runtime', name), resolve(out, 'runtime', name));
await copyFile(resolve(root, 'web/runtime.html'), resolve(out, 'runtime/index.html'));
await copyFile(resolve(root, 'license.txt'), resolve(out, 'LICENSE.txt'));
await mkdir(resolve(out, 'vendor/slang'), { recursive: true });
for (const name of ['slang-wasm.js', 'slang-wasm.wasm', 'interface.d.ts']) await copyFile(resolve(root, 'tools/browser/slang', name), resolve(out, 'vendor/slang', name));
await cp(resolve(root, 'tools/browser/slang/third-party-notices'), resolve(out, 'vendor/slang/third-party-notices'), { recursive: true });
await cp(resolve(root, 'web/vendor'), resolve(out, 'vendor'), { recursive: true });
// SPIR-V pre-pass (tools/spirvfix): web/shader.mjs imports
// '../tools/spirvfix/spirvfix.mjs', which the browser resolves to
// /tools/spirvfix/ when dist is the document root.
await cp(resolve(root, 'tools/spirvfix'), resolve(out, 'tools/spirvfix'), { recursive: true });
console.log(`Browser export: ${out}`);
