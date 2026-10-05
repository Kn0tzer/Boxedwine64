import { checkEntries } from './files.mjs';
const NAME = 'wine-browser-library-v1';
async function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('packages', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function operation(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('packages', mode);
      const request = fn(tx.objectStore('packages'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Browser storage transaction failed'));
    });
  } finally { db.close(); }
}
export async function savePackage(pkg) {
  checkEntries(pkg.files);
  await operation('readwrite', store => store.put(pkg));
}
export const getPackage = id => operation('readonly', store => store.get(id));
export const listPackages = () => operation('readonly', store => store.getAll());
export const deletePackage = id => operation('readwrite', store => store.delete(id));
export async function overlay(pkg, patch) {
  checkEntries(patch);
  const merged = new Map(pkg.files.map(f => [f.path.toLowerCase(), f]));
  for (const file of patch) merged.set(file.path.toLowerCase(), file);
  const next = { ...pkg, files: [...merged.values()], patched: new Date().toISOString() };
  await savePackage(next); // The old package remains intact if the transaction fails.
  return next;
}
