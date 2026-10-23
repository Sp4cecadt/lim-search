// Tiny IndexedDB wrapper (on-device storage for the manual data, the PDF and the example photos).
// v2 adds the "photos" store: key "<defectId>/<exampleIndex>" -> { blob (JPEG), w, h, p }.
const DB = 'lim-search', ST = 'kv', PH = 'photos';
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(ST)) d.createObjectStore(ST); if (!d.objectStoreNames.contains(PH)) d.createObjectStore(PH); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn, store = ST) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}
export const get = k => tx('readonly', s => s.get(k));
export const set = (k, v) => tx('readwrite', s => s.put(v, k));
export const del = k => tx('readwrite', s => s.delete(k));
export const photoGet = k => tx('readonly', s => s.get(k), PH);
export const photoPut = (k, v) => tx('readwrite', s => s.put(v, k), PH);
export const photoKeys = () => tx('readonly', s => s.getAllKeys(), PH);
export const photoClear = () => tx('readwrite', s => s.clear(), PH);
export async function persist() { try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {} return false; }
export async function estimate() { try { return await navigator.storage.estimate(); } catch (e) { return null; } }
