#!/usr/bin/env node
// Emscripten's Node targets emit CommonJS .js; the browser package uses ESM.
// Compile with Node's CommonJS loader without renaming generated build files.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
if (!process.argv[2]) throw new Error('Usage: node tools/runWasm.cjs <build.js> [arguments...]');
const filename = path.resolve(process.argv[2]);
process.argv.splice(1, 1);
const generated = new Module(filename, module);
generated.filename = filename;
generated.paths = Module._nodeModulePaths(path.dirname(filename));
generated._compile(fs.readFileSync(filename, 'utf8'), filename);
