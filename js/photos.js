// On-device photo extraction for the defect cards' "Photo examples".
// Layout in the manual: each example is a row of photos (often with red marker boxes/arrows drawn over them)
// followed directly by its caption + [Severity/Priority] tags. So for every caption we take the embedded images
// that sit between the previous caption (or the text above) and this caption, and render that page region
// (photos + overlays) to a JPEG. Shared by the browser (app) and Node (box-side audit; planning only).
export const PHOTO_VERSION = 1;
const MIN_SIDE = 24, MIN_AREA = 2500; // pt; ignores bullets, logos, tiny icons

// Image placement boxes (top-down page points) from a pdf.js operator list.
export function imageBoxes(opList, OPS, viewport) {
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = []; const out = [];
  const { fnArray: fa, argsArray: aa } = opList;
  for (let i = 0; i < fa.length; i++) {
    const f = fa[i], a = aa[i];
    if (f === OPS.save) stack.push(ctm);
    else if (f === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (f === OPS.transform) ctm = mul(ctm, a);
    else if (f === OPS.paintFormXObjectBegin) { stack.push(ctm); if (a && a[0] && a[0].length === 6) ctm = mul(ctm, a[0]); }
    else if (f === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject || f === OPS.paintImageXObjectRepeat || f === OPS.paintImageMaskXObject) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => viewport.convertToViewportPoint(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]));
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      if (b.x1 - b.x0 >= MIN_SIDE && b.y1 - b.y0 >= MIN_SIDE && (b.x1 - b.x0) * (b.y1 - b.y0) >= MIN_AREA) out.push(b);
    }
  }
  // merge exact duplicates (image + its soft mask / repeated paints)
  return out.filter((b, i) => !out.slice(0, i).some(c => Math.abs(c.x0 - b.x0) < 1 && Math.abs(c.y0 - b.y0) < 1 && Math.abs(c.x1 - b.x1) < 1 && Math.abs(c.y1 - b.y1) < 1));
}

// Plan the crops for one page.
// caps: [{key, y0, y1}] captions on this page (baselines, top-down pt); boxes: imageBoxes(); lines: layoutPage().lines
// prevTail: unused photo boxes at the bottom of the previous page (a photo whose caption starts the next page).
// returns { crops: [{key, rect, n, prev?}], tail: [boxes], orphans: n, gaps: [[above, below]] }
export function planPage(caps, boxes, lines, W, H, prevTail = null) {
  caps = [...caps].sort((a, b) => a.y0 - b.y0);
  const inBox = (x, y) => boxes.some(b => x >= b.x0 - 2 && x <= b.x1 + 2 && y >= b.y0 - 2 && y <= b.y1 + 8);
  // text lines that are not on top of a photo (labels drawn on photos don't count) and not header/footer
  const txt = [];
  for (const l of lines) if (l.y != null && l.segs.length) {
    const t = l.segs.map(s => s.s).join(' ');
    if (/This document is not to be copied|©\s*SA Power Networks|^Page \d+ of \d+|^Line Inspection Manual No/.test(t)) continue;
    if (l.segs.every(s => inBox((s.x + s.x2) / 2, l.y))) continue;
    txt.push(l.y);
  }
  txt.sort((a, b) => a - b);
  // placeholder graphics ("NO IMAGE AVAILABLE" + "Got a picture to go here…") are not photos
  const ph = lines.filter(l => l.y != null && /Got a picture/i.test(l.segs.map(s => s.s).join(' '))).map(l => l.y);
  boxes = boxes.filter(b => !ph.some(y => y > b.y1 - 2 && y < b.y1 + 30));
  // b belongs to c if the text under the photo runs on, line by line, into c's caption/tags
  const linked = (b, c) => {
    const ys = txt.filter(y => y > b.y1 && y < c.y0 - 0.5).concat(c.y0);
    let last = b.y1;
    for (const [i, y] of ys.entries()) { if (y - last > (i ? 32 : 40)) return false; last = y; }
    return true;
  };
  for (const c of caps) c.top = c.y0 - 10;
  const textBetween = (a, b) => txt.some(y => y > a + 4 && y < b - 1);
  const used = new Set(), got = new Map(), gaps = [];
  const take = (c, list) => { if (!list.length) return; list.forEach(b => used.add(b)); got.set(c.key, (got.get(c.key) || []).concat(list)); };
  // (a) usual layout: the photo row sits directly above its caption
  caps.forEach((c, k) => {
    const prevBottom = k ? caps[k - 1].y1 : 0;
    const mine = boxes.filter(b => !used.has(b) && b.y1 <= c.y0 && b.y1 > prevBottom - 2 && linked(b, c)
      // photo hugging the caption above it and well clear of this one = caption-above layout, leave it for (c)
      && !(k && b.y0 - prevBottom < 9 && c.y0 - b.y1 > b.y0 - prevBottom + 14));
    // caption printed beside a photo (photo spans the caption's lines)
    for (const b of boxes) if (!used.has(b) && !mine.includes(b) && b.y0 < c.top && b.y1 > c.y0 && b.y1 <= c.y1 + 14 && b.y1 > prevBottom) mine.push(b);
    // photos stacked above those (several rows for one caption)
    for (let more = mine.length > 0; more;) {
      more = false;
      for (const b of boxes) if (!used.has(b) && !mine.includes(b) && b.y1 > prevBottom - 2 && mine.some(m => m.y0 - b.y1 > -3 && m.y0 - b.y1 < 30 && !textBetween(b.y1, m.y0))) { mine.push(b); more = true; }
    }
    if (k && mine.length) gaps.push([Math.min(...mine.map(b => b.y0)) - prevBottom, c.y0 - Math.max(...mine.map(b => b.y1))]);
    take(c, mine);
  });
  // (b) caption at the top of the page with its photo at the bottom of the previous page
  const c0 = caps[0];
  if (c0 && !got.has(c0.key) && prevTail && prevTail.length && !txt.some(y => y < c0.top)) got.set(c0.key, [{ prev: true, boxes: prevTail }]);
  // (c) caption-above layout: photo directly below a caption that has none
  caps.forEach((c, k) => {
    if (got.has(c.key)) return;
    const nextTop = k + 1 < caps.length ? caps[k + 1].top : H;
    take(c, boxes.filter(b => !used.has(b) && b.y0 >= c.y1 - 2 && b.y1 <= nextTop + 8 && !textBetween(c.y1, b.y0 + 1)));
  });
  const crops = [];
  for (const c of caps) {
    const g = got.get(c.key); if (!g) continue;
    const isPrev = g[0] && g[0].prev, list = isPrev ? g[0].boxes : g;
    const pad = 3;
    crops.push({ key: c.key, prev: !!isPrev, n: list.length, rect: { x0: Math.max(0, Math.min(...list.map(b => b.x0)) - pad), y0: Math.max(0, Math.min(...list.map(b => b.y0)) - pad),
      x1: Math.min(W, Math.max(...list.map(b => b.x1)) + pad), y1: Math.min(H, Math.max(...list.map(b => b.y1)) + pad) } });
  }
  // tail: unused photos below the last caption with no text after them (their caption is on the next page)
  const lastY = caps.length ? caps[caps.length - 1].y1 : 0;
  const tail = boxes.filter(b => !used.has(b) && b.y0 > lastY - 2 && txt.filter(y => y > b.y1 + 2).every(y => y < b.y1 + 30) && txt.filter(y => y > b.y1 + 2).length <= 2); // a caption's first line may sit under it
  return { crops, tail, orphans: boxes.filter(b => !used.has(b)).length, gaps };
}

// Which captions are on which page: Map(page -> [{key, y0, y1}]). key = "<defectId>/<exampleIndex>"
export function captionsByPage(data) {
  const m = new Map();
  for (const d of data.defects) d.examples.forEach((e, i) => {
    if (e.y0 == null) return;
    if (!m.has(e.p)) m.set(e.p, []);
    m.get(e.p).push({ key: d.id + '/' + i, y0: e.y0, y1: e.y1 });
  });
  return m;
}

// Walk the pages that have example captions and plan every crop. Calls onJob(p, crops, page) as soon as a page's
// crops are known (page = the pdf.js page, still loaded, so the caller can render it without re-parsing).
// A caption that starts a page may take the photos at the bottom of the previous page (onJob(p - 1, …) then).
export async function planManual(doc, data, OPS, layoutPage, onProgress = () => {}, onJob = null) {
  const byPage = captionsByPage(data);
  const cache = new Map();
  const info = async p => {
    if (cache.has(p)) return cache.get(p);
    const pg = await doc.getPage(p); const vp = pg.getViewport({ scale: 1 });
    const boxes = imageBoxes(await pg.getOperatorList(), OPS, vp);
    const lines = boxes.length ? layoutPage(p, await pg.getTextContent(), vp).lines : [];
    const r = { pg, boxes, lines, W: vp.width, H: vp.height };
    cache.set(p, r);
    for (const k of [...cache.keys()]) if (k < p - 1) { cache.get(k).pg.cleanup(); cache.delete(k); }
    return r;
  };
  const pagesSorted = [...byPage.keys()].sort((a, b) => a - b);
  const jobs = new Map(); let orphans = 0, done = 0; const orphanPages = [], gaps = []; let lastTail = null, lastP = -1;
  for (const p of pagesSorted) {
    const I = await info(p);
    let prevTail = null;
    if (p > 1) {
      if (lastP === p - 1) prevTail = lastTail;
      else { const J = await info(p - 1); if (J.boxes.length) prevTail = planPage([], J.boxes, J.lines, J.W, J.H).tail; }
    }
    const r = I.boxes.length || (prevTail && prevTail.length) ? planPage(byPage.get(p), I.boxes, I.lines, I.W, I.H, prevTail) : { crops: [], tail: [], orphans: 0, gaps: [] };
    const here = r.crops.filter(c => !c.prev), before = r.crops.filter(c => c.prev);
    if (before.length) { (jobs.get(p - 1) || jobs.set(p - 1, []).get(p - 1)).push(...before); if (onJob) await onJob(p - 1, before, (await info(p - 1)).pg); }
    if (here.length) { (jobs.get(p) || jobs.set(p, []).get(p)).push(...here); if (onJob) await onJob(p, here, I.pg); }
    if (r.orphans) { orphans += r.orphans; orphanPages.push(p + ':' + r.orphans); }
    gaps.push(...r.gaps);
    lastTail = r.tail; lastP = p;
    await onProgress(++done, pagesSorted.length);
  }
  for (const v of cache.values()) v.pg.cleanup();
  return { jobs: [...jobs].map(([p, crops]) => ({ p, crops })).sort((a, b) => a.p - b.p), orphans, orphanPages, gaps, captionPages: pagesSorted.length, allKeys: [...byPage.values()].flat().map(c => c.key) };
}

// Browser only: render each crop (photos + the manual's red marker boxes) to a JPEG blob and hand it to put(key, rec).
// One render per page (the union of that page's crops), then cut out each crop. Sized for a phone screen.
export const PHOTO_MAX_W = 900, PHOTO_SCALE = 1.5, PHOTO_Q = 0.72;
export async function renderCrops(pg, crops, put) {
  const W = PHOTO_MAX_W;
  const u = { x0: Math.min(...crops.map(c => c.rect.x0)), y0: Math.min(...crops.map(c => c.rect.y0)), x1: Math.max(...crops.map(c => c.rect.x1)), y1: Math.max(...crops.map(c => c.rect.y1)) };
  const s = Math.min(PHOTO_SCALE, W / Math.max(...crops.map(c => c.rect.x1 - c.rect.x0)));
  const vp = pg.getViewport({ scale: s, offsetX: -u.x0 * s, offsetY: -u.y0 * s });
  const cv = document.createElement('canvas');
  cv.width = Math.ceil((u.x1 - u.x0) * s); cv.height = Math.ceil((u.y1 - u.y0) * s);
  const ctx = cv.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: 0 }).promise;
  let bytes = 0;
  for (const c of crops) {
    const w = Math.round((c.rect.x1 - c.rect.x0) * s), h = Math.round((c.rect.y1 - c.rect.y0) * s);
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    out.getContext('2d', { alpha: false }).drawImage(cv, Math.round((c.rect.x0 - u.x0) * s), Math.round((c.rect.y0 - u.y0) * s), w, h, 0, 0, w, h);
    const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', PHOTO_Q));
    out.width = out.height = 0;
    if (blob) { bytes += blob.size; await put(c.key, { blob, w, h, p: pg.pageNumber }); }
  }
  cv.width = cv.height = 0; // free canvas memory right away (iOS has a tight canvas budget)
  return bytes;
}
