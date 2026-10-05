#!/usr/bin/env node
// scan.mjs <dir>  — baked graphics-API evidence for a Unity build
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
const root = process.argv[2];
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) { if (e.name !== 'Managed' && e.name !== 'MonoBleedingEdge') walk(p); }
    else if (e.isFile() && statSync(p).size < 400 * 1024 * 1024) files.push(p);
  }
})(root);
const pats = {
  platformKeys: /(glcore|gles3|gles2|d3d11|d3d9|vulkan|metal|opengles|direct3d11|direct3d9)/gi,
  glslVer: /#version\s+\d+\s*(core|compat|es)/gi,
  glslSym: /\bgl_Position\b|\bgl_FragColor\b|\bprecision\s+(mediump|highp)\b/gi,
  dxbc: /DXBC/g,
  spirv: /spirv/g,
};
const tally = {}; const hits = [];
for (const f of files) {
  const fd = openSync(f, 'r'); const buf = Buffer.alloc(Math.min(statSync(f).size, 400 << 20));
  readSync(fd, buf, 0, buf.length, 0); closeSync(fd);
  const s = buf.toString('latin1');
  for (const [k, re] of Object.entries(pats)) {
    const m = s.match(re);
    if (m) { const u = {}; for (const x of m) u[x] = (u[x] || 0) + 1; tally[k] = (tally[k] || 0) + m.length; hits.push([f.split('/').pop(), k, u]); }
  }
}
console.log('== files:', files.length);
for (const [k, v] of Object.entries(tally)) console.log('  TOTAL', k, v);
for (const [f, k, u] of hits) {
  const e = Object.entries(u).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([a, b]) => `${a}x${b}`).join(' ');
  console.log(' ', f, k, e);
}