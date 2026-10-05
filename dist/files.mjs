import { ZipReader, ZipWriter, BlobReader, BlobWriter } from './vendor/zip/index-native.js';

export const limits = { count: 20000, file: 256 * 1024 ** 2, total: 768 * 1024 ** 2 };
export function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\x00-\x1f\x7f\\:]/.test(path) || path.startsWith('/')) throw new Error('Unsafe file path');
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new Error(`Unsafe Windows path: ${path}`);
  return path;
}
export function checkEntries(entries) {
  if (!entries.length || entries.length > limits.count) throw new Error('Empty package or too many files');
  let total = 0;
  const seen = new Set();
  for (const entry of entries) {
    safePath(entry.path);
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Windows filename collision: ${entry.path}`);
    seen.add(key);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.file) throw new Error(`File exceeds 256 MiB: ${entry.path}`);
    total += entry.size;
    if (total > limits.total) throw new Error('Package exceeds the 768 MiB memory budget');
  }
  // A file cannot also be the parent directory of another file.
  for (const key of seen) {
    const parts = key.split('/');
    while (parts.length > 1) { parts.pop(); if (seen.has(parts.join('/'))) throw new Error('File/directory collision'); }
  }
  return total;
}
export function stripRoot(entries) {
  const root = entries[0]?.path.split('/')[0];
  if (root && entries.every(e => e.path.startsWith(root + '/'))) return entries.map(e => ({ ...e, path: e.path.slice(root.length + 1) }));
  return entries;
}
export async function fromFiles(files) {
  const entries = stripRoot(Array.from(files, f => ({ path: f.webkitRelativePath || f.name, size: f.size, blob: f })));
  checkEntries(entries);
  return entries;
}
export async function fromDrop(items) {
  const roots = Array.from(items).map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  const entries = [];
  async function visit(entry, path) {
    if (entries.length >= limits.count) throw new Error('Too many files');
    if (entry.isFile) {
      const blob = await new Promise((ok, fail) => entry.file(ok, fail));
      entries.push({ path, size: blob.size, blob });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((ok, fail) => reader.readEntries(ok, fail));
        if (!batch.length) break; // readEntries returns at most 100 entries per call.
        for (const child of batch) await visit(child, path + '/' + child.name);
      }
    }
  }
  for (const entry of roots) await visit(entry, entry.name);
  const result = stripRoot(entries);
  checkEntries(result);
  return result;
}
export async function fromZip(blob, { strip = true } = {}) {
  if (blob.size > limits.total) throw new Error('Archive too large');
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  try {
    const archived = await reader.getEntries();
    if (archived.length > limits.count) throw new Error('Too many archive entries');
    /** @type {{path: string, size: number, entry?: import('@zip.js/zip.js').FileEntry, blob?: Blob}[]} */
    const entries = [];
    for (const entry of archived) {
      safePath(entry.filename.replace(/\/$/, ''));
      if (entry.encrypted || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Encrypted entries and symlinks are not supported');
      if (!entry.directory) entries.push({ path: entry.filename, size: entry.uncompressedSize, entry: /** @type {import('@zip.js/zip.js').FileEntry} */ (entry) });
    }
    checkEntries(entries); // Reject advertised expansion before decompressing anything.
    for (const e of entries) {
      e.blob = await e.entry.getData(new BlobWriter(), { checkSignature: true });
      if (e.blob.size !== e.size) throw new Error('Archive length mismatch');
      delete e.entry;
    }
    return strip ? stripRoot(entries) : entries;
  } finally { await reader.close(); }
}
export async function makeZip(entries) {
  checkEntries(entries);
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false });
  for (const e of entries) await writer.add(e.path, new BlobReader(e.blob), { level: 0 });
  return writer.close();
}
export async function peArchitecture(blob) {
  const head = new DataView(await blob.slice(0, 4096).arrayBuffer());
  if (head.byteLength < 64 || head.getUint16(0, true) !== 0x5a4d) throw new Error('Executable is not a Windows PE file');
  const offset = head.getUint32(60, true);
  if (offset > blob.size - 6) throw new Error('Invalid PE header offset');
  const pe = new DataView(await blob.slice(offset, offset + 6).arrayBuffer());
  if (pe.getUint32(0, true) !== 0x4550) throw new Error('Invalid PE signature');
  const machine = pe.getUint16(4, true);
  if (machine === 0x8664) return 'x64';
  if (machine === 0x14c) return 'x86';
  throw new Error(`Unsupported PE architecture: 0x${machine.toString(16)}`);
}
