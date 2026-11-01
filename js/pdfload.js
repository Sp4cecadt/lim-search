// In-browser PDF reading (pdf.js bundled locally) + shared layout/extraction rules.
import { layoutPage } from './layout.js';
import { extractManual } from './extract.js';
import { fillRects, HAS_LEVEL } from './fills.js';
import { planManual, renderCrops } from './photos.js';
let pdfjsP = null;
export function pdfjs() {
  if (!pdfjsP) pdfjsP = import('../vendor/pdfjs/pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href; return m; });
  return pdfjsP;
}
export async function openPdf(blob) {
  const lib = await pdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  return lib.getDocument({ data, disableFontFace: true, isEvalSupported: false }).promise;
}
export async function extractFromPdf(blob, onProgress = () => {}) {
  const lib = await pdfjs();
  const doc = await openPdf(blob);
  const meta = await doc.getMetadata().catch(() => ({}));
  const pages = [];
  const t0 = Date.now();
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    const vp = pg.getViewport({ scale: 1 });
    const lp = layoutPage(i, tc, vp);
    // severity cells are coloured (Red = raise a defect, Grey = no defect): read the drawings on pages that have a scale
    if (lp.lines.some(l => l.segs[0] && l.segs[0].x < vp.width * 0.17 && HAS_LEVEL.test(l.segs[0].s))) {
      try { lp.fills = fillRects(await pg.getOperatorList(), lib.OPS, vp); } catch (e) { lp.fills = null; }
    }
    pages.push(lp);
    pg.cleanup();
    if (i % 10 === 0 || i === doc.numPages) onProgress({ phase: 'text', done: i, total: doc.numPages });
  }
  await doc.destroy();
  onProgress({ phase: 'structure' });
  await new Promise(r => setTimeout(r, 30));
  const data = extractManual(pages, meta.info || {});
  data.meta.textMs = Date.now() - t0;
  return data;
}
// Example photos: find each caption's photos on the page and save them as JPEGs via put(key, rec).
// shouldStop() lets the app abandon a run (e.g. a newer manual was loaded meanwhile).
export async function extractPhotosFromPdf(blob, data, put, onProgress = () => {}, shouldStop = () => false, has = () => false) {
  const lib = await pdfjs();
  const doc = await openPdf(blob);
  const t0 = Date.now(); let n = 0, bytes = 0;
  try {
    await planManual(doc, data, lib.OPS, layoutPage, async (done, total) => {
      if (shouldStop()) throw new Error('stopped');
      if (done % 5 === 0 || done === total) { onProgress({ done, total, n, bytes }); await new Promise(r => setTimeout(r, 0)); }
    }, async (p, crops, pg) => { const todo = crops.filter(c => !has(c.key)); n += crops.length; if (todo.length) bytes += await renderCrops(pg, todo, put); });
  } finally { await doc.destroy(); }
  return { n, bytes, ms: Date.now() - t0 };
}
