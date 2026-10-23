// Shared extraction logic: used by the box build (Node) and the in-app "Update manual" (browser).
// Input: pages from layoutPage(); output: structured manual data. Never invents content:
// every field is copied from the page text, with its PDF page number.
export const EXTRACTOR_VERSION = '1.1';

const FOOT = /This document is not to be copied|©\s*SA Power Networks|^Page \d+ of \d+$|^\.$|^express permission/;
const LEVEL_RE = /^(?:\d\s+)?(Extreme|Very High|High|Moderate|Low|New|Nil|End of Life)\b\s*(.*)$/;
const LABELS = ['Defect Severity Range', 'Defect Priority Range', 'Defect Condition Range', 'Quick Code', 'Details', 'Record Condition Only'];
const TAG_RE = /\[\s*(Severity|Priority|Condition)\s*:\s*([^\]]+?)\s*\]/g;

const norm = s => s.toLowerCase().replace(/&/g, ' and ').replace(/(\D)\/|\/(\D)/g, '$1 $2').replace(/[’']/g, '').replace(/[^a-z0-9/]+/g, ' ').replace(/\b(or|and|the|a|an|on|in|of|to|with|is|are)\b/g, ' ').replace(/\s+/g, ' ').trim();
const stem = t => t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
const tokens = s => norm(s).split(' ').filter(Boolean).map(stem);
function tri(t) { const g = new Set(); const s = '  ' + t + ' '; for (let i = 0; i < s.length - 2; i++) g.add(s.slice(i, i + 3)); return g; }
function osa(a, b) { const d = []; for (let i = 0; i <= a.length; i++) { d[i] = [i]; } for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) { const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); }
  return d[a.length][b.length]; }
function tokEq(a, b) { if (a === b) return true; if (a.length < 5 || b.length < 5) return false; return osa(a, b) <= 1; }
export { osa };
function sim(a, b) { // token Jaccard / overlap with typo-tolerant token equality
  const A = [...new Set(tokens(a))], B = [...new Set(tokens(b))]; if (!A.length || !B.length) return 0;
  let i = 0; for (const t of A) if (B.some(u => tokEq(t, u))) i++;
  const jac = i / (A.length + B.length - i), ov = i / Math.min(A.length, B.length);
  return Math.max(jac, Math.min(A.length, B.length) >= 3 ? 0.9 * ov : 0);
}
export { norm, sim };

function cleanPage(pg) {
  const lines = [];
  let label = null, header = null;
  pg.lines.forEach((l, idx) => {
    const txt = l.segs.map(s => s.s).join('  ').trim();
    const m = txt.match(/Page (\d+) of (\d+)\s*$/);
    if (m) label = `${m[1]} of ${m[2]}`;
    if (txt && FOOT.test(txt)) return;
    if (m && l.segs.length === 1) return;
    if (header === null && txt) {
      const h = txt.match(/^Line Inspection Manual No\.\s*\d+\s{2,}(?:Section\s+)?(\d+(?:\.\d+)*)\.?-?\s*(.*)$/);
      if (h) { header = { num: h[1], title: h[2].trim() }; return; }
      header = false;
    }
    lines.push({ segs: l.segs, txt, y: l.y });
  });
  return { n: pg.n, w: pg.w, label, header: header || null, lines };
}
const isBlank = l => !l.txt;

export function extractManual(rawPages, info = {}) {
  const pages = rawPages.map(cleanPage);
  const P = n => pages[n - 1];
  // ---------- meta ----------
  const firstTxt = pages.slice(0, 3).map(p => p.lines.map(l => l.txt).join('\n')).join('\n');
  const meta = {
    title: (firstTxt.match(/LINE INSPECTION MANUAL/i) ? 'Line Inspection Manual' : 'Manual') + ((firstTxt.match(/Manual No\.?\s*(\d+)/i) || [])[1] ? ' No. ' + firstTxt.match(/Manual No\.?\s*(\d+)/i)[1] : ''),
    issued: (firstTxt.match(/Issued\s+(\d{1,2}\s+\w+\s+\d{4})/i) || [])[1] || null,
    pdfModDate: info.ModDate || info.CreationDate || null,
    numPages: pages.length, extractorVersion: EXTRACTOR_VERSION,
  };
  // ---------- sections / TOC (from running page headers + body headings) ----------
  const secMap = new Map();
  const pageSec = [];
  let cur = null;
  for (const p of pages) {
    let s = null;
    if (p.header) s = { num: p.header.num, title: p.header.title };
    for (const l of p.lines.slice(0, 6)) {
      const m = l.segs.length === 1 && l.txt.match(/^(\d{1,2})\.\s+([A-Z][A-Z &\-–,()/’']{3,})$/);
      if (m) s = { num: m[1], title: m[2].trim() };
    }
    if (s) cur = s;
    pageSec.push(cur);
    if (cur) {
      const k = cur.num + '|' + cur.title.toLowerCase();
      if (!secMap.has(k)) secMap.set(k, { num: cur.num, title: cur.title, from: p.n, to: p.n });
      else secMap.get(k).to = p.n;
    }
  }
  const toc = [...secMap.values()];
  // ---------- defect blocks ----------
  const anchors = [];
  for (const p of pages) {
    p.lines.forEach((l, k) => {
      if (l.txt !== 'Quick Code') return;
      const after = p.lines.slice(k + 1, k + 30).some(x => x.txt === 'Details');
      const before = p.lines.slice(Math.max(0, k - 10), k).some(x => /^Defect (Severity|Priority|Condition) Range$/.test(x.txt));
      if (after || before) anchors.push({ p, k });
    });
    // cards without a Quick Code (e.g. "11.2.4 Denso Tape Damage / Record Condition Only / Details")
    p.lines.forEach((l, k) => {
      if (l.txt !== 'Details') return;
      if (p.lines.slice(Math.max(0, k - 30), k).some(x => x.txt === 'Quick Code')) return;
      const above = p.lines.slice(Math.max(0, k - 4), k).filter(x => x.txt);
      const rc = above.findIndex(x => x.txt === 'Record Condition Only');
      const numbered = above.some(x => /^\d+\.\d+\.\d+\s+\S/.test(x.txt));
      if (rc >= 0 || numbered) anchors.push({ p, k, noQc: true });
    });
  }
  const defects = [];
  anchors.sort((a, b) => a.p.n - b.p.n || a.k - b.k);
  for (const { p, k, noQc } of anchors) {
    let start = k;
    if (noQc && p.lines[k - 1] && p.lines[k - 1].txt === 'Record Condition Only') start = k - 1;
    else if (noQc && p.lines[k - 2] && p.lines[k - 2].txt === 'Record Condition Only') start = k - 2;
    let label = null;
    if (noQc) {
      let j = start - 1; while (j >= 0 && isBlank(p.lines[j])) j--;
      if (j >= 0 && !/^\d+\.\d+/.test(p.lines[j].txt) && p.lines[j].txt.length < 40) {
        let jj = j - 1; while (jj >= 0 && isBlank(p.lines[jj])) jj--;
        if (jj >= 0 && /^\d+\.\d+\.\d+\s/.test(p.lines[jj].txt)) { label = p.lines[j].txt; start = j; }
      }
    }
    for (const lab of ['Defect Priority Range', 'Defect Condition Range', 'Defect Severity Range']) {
      for (let j = start - 1; j >= Math.max(0, start - 10); j--) if (p.lines[j].txt === lab) { start = j; break; }
    }
    // title: contiguous non-blank lines above start (stop at section heading / blank)
    let t = start - 1; while (t >= 0 && isBlank(p.lines[t])) t--;
    const tl = [];
    let num = null, subsec = null;
    while (t >= 0 && !isBlank(p.lines[t]) && tl.length < 3) {
      const txt = p.lines[t].txt;
      const m = txt.match(/^(\d+(?:\.\d+){1,3})\s+(.+)$/);
      if (m) {
        if (tl.length === 0) { num = m[1]; tl.unshift(m[2]); t--; continue; }
        subsec = { num: m[1], title: m[2] }; break; // heading above title
      }
      if (LABELS.includes(txt) || txt.length > 90 || /[.:]$/.test(txt)) break;
      tl.unshift(txt); t--;
    }
    // a "Section heading" line directly above with a blank (e.g. 6.2 Standard Poles)
    if (!subsec) for (let j = t; j >= Math.max(0, t - 4); j--) {
      const m = p.lines[j] && p.lines[j].txt.match(/^(\d+\.\d+)\s+(.+)$/); if (m) { subsec = { num: m[1], title: m[2] }; break; }
    }
    let title = tl.join(' ').replace(/\s+/g, ' ').trim();
    let kind = 'Defect';
    if (/Information Notification$/i.test(title)) { kind = 'Information Notification'; title = title.replace(/\s*Information Notification$/i, '').trim(); }
    const sec = pageSec[p.n - 1];
    defects.push({ p, start, k, title, num, kind, subsec, hdr: p.header, sec, label });
  }
  // section of each block = latest 2-level body heading above it (page headers can lag a page or two)
  const heads = [];
  for (const p of pages) p.lines.forEach((l, k) => {
    const m = l.segs.length === 1 && l.txt.match(/^(\d{1,2}\.\d{1,2})\.?\s+([A-Z][^.]{2,60})$/);
    if (m && (m[2].match(/\(/g) || []).length === (m[2].match(/\)/g) || []).length && !(p.header == null && /^\d+\.?\s/.test(l.txt) && p.lines.length > 40)) heads.push({ p: p.n, k, num: m[1], title: m[2].trim() });
  });
  for (const d of defects) {
    let h = null;
    for (const x of heads) { if (x.p < d.p.n || (x.p === d.p.n && x.k < d.start)) h = x; else break; }
    const hs = d.hdr ? { num: d.hdr.num, title: d.hdr.title } : null;
    const fromNum = d.num ? d.num.split('.').slice(0, 2).join('.') : null;
    let s = hs || h;
    if (h && hs && h.num !== hs.num && h.num.split('.')[0] === hs.num.split('.')[0]) {
      // header names a new sub-section: trust it unless its own body heading only appears a little later (header lag)
      const lag = heads.some(x => x.num === hs.num && sim(x.title, hs.title) >= 0.5 && (x.p > d.p.n || (x.p === d.p.n && x.k > d.start)) && x.p <= d.p.n + 2);
      // only when the defect title clearly belongs to the earlier heading (e.g. "LV Isolator…" under "Low Voltage Isolators")
      const ov = t => { const A = tokens(d.title), B = tokens(t); return A.filter(a => B.some(b => tokEq(a, b) || (a.length > 4 && b.startsWith(a.slice(0, 5))))).length; };
      if (lag && ov(h.title) > ov(hs.title) && h.p < d.p.n) s = h;
    }
    if (d.subsec && /^\d+\.\d+$/.test(d.subsec.num)) s = d.subsec;
    if (fromNum && (!s || s.num !== fromNum)) s = heads.slice().reverse().find(x => x.num === fromNum && x.p <= d.p.n) || { num: fromNum, title: hs ? hs.title : '' };
    d.section = s ? { num: s.num, title: s.title } : (d.sec ? { num: d.sec.num, title: d.sec.title } : { num: '', title: '' });
  }
  // parse each block's fields; the block is a line stream running across pages until the next block / section change
  const out = [];
  defects.forEach((d, i) => {
    const next = defects[i + 1];
    const secTop = (d.section.num || '').split('.')[0];
    const stream = [];
    let endPage = d.p.n;
    for (let pn = d.p.n; pn <= Math.min(d.p.n + 40, pages.length); pn++) {
      const pg = P(pn);
      if (pn > d.p.n) { const h = pg.header; if (!h || h.num.split('.')[0] !== secTop) break; }
      let from = pn === d.p.n ? d.start : 0;
      let to = pg.lines.length;
      if (next && next.p.n === pn) {
        // stop before the next block's title lines
        let t = next.start - 1; while (t >= 0 && isBlank(pg.lines[t])) t--;
        const nTitleLines = Math.max(1, Math.ceil((next.title.length + (next.num ? next.num.length + 1 : 0)) / 95));
        to = Math.max(from, t - nTitleLines + 1);
        // also drop a sub-section heading just above
        while (to > from && (isBlank(pg.lines[to - 1]) || /^\d+\.\d+(\.\d+)*\s+\S/.test(pg.lines[to - 1].txt))) to--;
      }
      if (pn > d.p.n) stream.push({ pageBreak: pn });
      for (let k = from; k < to; k++) stream.push({ ...pg.lines[k], pn, k });
      if (to > from || pn === d.p.n) endPage = pn;
      if (next && next.p.n === pn) break;
    }
    const f = { sev: [], pri: [], cond: [], qc: [], det: [] };
    let mode = null, si = 0;
    const scale = [];
    let lastLevel = null, group = null, indentBuf = [], centred = false;
    const lineTxt = l => l.segs.map(s => s.s).join('  ');
    for (; si < stream.length; si++) {
      const l = stream[si];
      if (l.pageBreak) { lastLevel = null; indentBuf = []; continue; }
      if (l.txt === 'Defect Severity Range') { mode = 'sev'; continue; }
      if (l.txt === 'Defect Priority Range') { mode = 'pri'; continue; }
      if (l.txt === 'Defect Condition Range') { mode = 'cond'; continue; }
      if (l.txt === 'Record Condition Only') { f.cond.push(l.txt); continue; }
      if (l.txt === 'Quick Code') { mode = 'qc'; continue; }
      if (l.txt === 'Details') { mode = 'det'; continue; }
      if (!mode) continue;
      if (mode !== 'det') { if (l.txt) f[mode].push(lineTxt(l)); continue; }
      const joined = l.segs.map(s => s.s).join(' ');
      const isCaption = /\[\s*(Severity|Priority|Condition)\s*:/.test(joined) || l.segs.some(s => /^(H\/MBFRA|NBFRA)$/.test(s.s) && s.x > l.segs[0].x + 50) || /^Figure \d+/.test(l.txt);
      if (isCaption) break;
      if (!l.txt) { indentBuf = []; if (!lastLevel) f.det.push(''); lastLevel = null; continue; }
      const s0 = l.segs[0];
      const lv = s0.s.match(LEVEL_RE);
      const leftEdge = s0.x < P(l.pn).w * 0.17;
      if (lastLevel && lastLevel.pendingNum && !lastLevel.level && lv && leftEdge) {
        lastLevel.level = lv[1]; delete lastLevel.pendingNum;
        const rest = [lv[2], ...l.segs.slice(1).map(s => s.s)].filter(Boolean).join(' ');
        if (rest) lastLevel.text += ' ' + rest; continue;
      }
      if (lv && leftEdge && l.segs.length === 1 && !lv[2] && /^(Extreme|Very High|High|Moderate|Low)$/.test(s0.s) && indentBuf.length) {
        // level label vertically centred beside its text block: pull the indented lines above it
        const pulled = indentBuf.map(ix => f.det[ix]); for (const ix of indentBuf.slice().reverse()) f.det.splice(ix, 1);
        scale.push({ level: lv[1], text: pulled.join(' '), group, p: l.pn }); lastLevel = scale[scale.length - 1]; indentBuf = []; centred = true; continue;
      }
      if (lv && leftEdge && (l.segs.length >= 2 || lv[2] || /^\d\s/.test(s0.s)) && !/[.]$/.test(lv[2] || '') ) {
        const rest = [lv[2], ...l.segs.slice(1).map(s => s.s)].filter(Boolean).join(' ');
        scale.push({ level: lv[1], text: rest, group, p: l.pn }); lastLevel = scale[scale.length - 1];
        continue;
      }
      if (/^\d$/.test(s0.s) && leftEdge) { // e.g. "2" on one line, "Moderate" on the next
        scale.push({ level: '', text: l.segs.slice(1).map(s => s.s).join(' '), group, p: l.pn, pendingNum: s0.s }); lastLevel = scale[scale.length - 1]; continue;
      }
      if (lastLevel) {
        if (!leftEdge || /^(OR|AND)$/.test(l.txt)) { lastLevel.text += ' ' + joined; continue; }
        const lv2 = l.txt.match(/^(Extreme|Very High|High|Moderate|Low)\b\s*(.*)$/);
        if (lv2 && lastLevel.pendingNum && !lastLevel.level) { lastLevel.level = lv2[1]; delete lastLevel.pendingNum; if (lv2[2]) lastLevel.text += ' ' + lv2[2]; continue; }
      }
      // ordinary details line (or a heading between two scales, e.g. "LV Crossarm Bolts or Nuts:")
      if (scale.length && /:$/.test(l.txt) && l.txt.length < 70) { group = l.txt.replace(/:$/, ''); lastLevel = null; continue; }
      lastLevel = null;
      if (!leftEdge) indentBuf.push(f.det.length); else indentBuf = [];
      if (/:$/.test(l.txt) && l.txt.length < 70 && stream.slice(si + 1, si + 5).some(x => x.segs && x.segs[0] && x.segs.length >= 2 && LEVEL_RE.test(x.segs[0].s))) { group = l.txt.replace(/:$/, ''); f.det.push(lineTxt(l)); continue; }
      f.det.push(lineTxt(l));
    }
    for (const sc of scale) { sc.z = /\[Z Code[^\]]*\]/i.test(sc.text); sc.text = sc.text.replace(/\s+/g, ' ').trim(); delete sc.pendingNum; if (!sc.group) delete sc.group; }
    // quick codes
    const qcs = []; let grp = '';
    for (const raw of f.qc) {
      const m = raw.match(/^(.*?)\s*>\s*(.+)$/);
      if (m) { if (m[1].trim()) grp = m[1].trim(); qcs.push({ group: grp, code: m[2].trim() }); }
      else qcs.push({ group: '', code: raw.trim(), raw: true });
    }
    // examples: remainder of the stream, grouped per page
    const ex = [];
    let bucket = [], bp = null;
    const flushB = () => { if (bucket.length) collectExamples({ w: P(bp).w, n: bp, lines: bucket }, 0, bucket.length, ex); bucket = []; };
    let g2 = null, last2 = null;
    for (; si < stream.length; si++) {
      const l = stream[si];
      if (l.pageBreak) { flushB(); bp = l.pageBreak; last2 = null; continue; }
      if (bp === null) bp = l.pn;
      // a further severity chart printed after the photo examples (e.g. "33kV & 19kV:")
      if (l.txt && /:$/.test(l.txt) && l.txt.length < 60 && l.segs.length === 1) { g2 = l.txt.replace(/:$/, ''); }
      const s0 = l.segs[0], lv = s0 && s0.s.match(LEVEL_RE);
      if (lv && l.segs.length >= 2 && !lv[2] && s0.x < P(l.pn).w * 0.17 && !/\[\s*(Severity|Priority|Condition)\s*:/.test(l.txt)) {
        last2 = { level: lv[1], text: l.segs.slice(1).map(x => x.s).join(' '), group: g2 || 'Further chart', p: l.pn }; scale.push(last2); continue;
      }
      if (last2 && l.txt && s0.x >= P(l.pn).w * 0.17 && !/\[/.test(l.txt)) { last2.text += ' ' + l.segs.map(x => x.s).join(' '); continue; }
      if (!l.txt) last2 = null;
      bucket.push(l);
    }
    for (const sc of scale) { sc.z = /\[Z Code[^\]]*\]|Z code/i.test(sc.text); sc.text = sc.text.replace(/\s+/g, ' ').trim(); if (!sc.group) delete sc.group; }
    flushB();
    // tags that spilled over to the top of the next page belong to the previous example
    for (let i = ex.length - 1; i > 0; i--) if (!ex[i].caption && ex[i].p === ex[i - 1].p + 1 && ex[i].y0 < 90) { ex[i - 1].tags.push(...ex[i].tags); ex.splice(i, 1); }
    const sevText = f.sev.join('\n'), priText = f.pri.join('\n');
    const byBfra = txt => {
      const r = {}; for (const ln of txt.split('\n')) { const m = ln.match(/^(H\/MBFRA|H\/MBFA|HBFRA|MBFRA|NBFRA|H\/M\/NBFRA)\s*:?\s+(.+)$/); if (m) r[m[1]] = m[2].trim(); }
      return Object.keys(r).length ? r : null;
    };
    const det = f.det.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    let kind = d.kind;
    if (kind === 'Defect' && !qcs.length && !sevText && !priText) kind = /Record Condition Only/i.test(f.cond.join(' ')) ? 'Condition only' : 'Guidance';
    out.push({
      id: 'd' + (out.length + 1),
      num: d.num, title: d.title, kind,
      section: d.section.num, sectionTitle: d.section.title,
      page: d.p.n, pageLabel: d.p.label, endPage,
      severityRange: sevText || null, severityByBfra: byBfra(sevText),
      priorityRange: priText || null, priorityByBfra: byBfra(priText),
      conditionRange: [d.label, ...f.cond].filter(Boolean).join('\n') || null,
      zCode: /Z\s*Code/i.test(priText) || scale.some(s => s.z),
      breakdown: /Breakdown/i.test(priText),
      quickCodes: qcs, details: det, scale, examples: ex,
    });
  });
  // ---------- quick code reference table (14.2) ----------
  const quickCodeTable = parseQuickCodeTable(pages);
  // ---------- Z-code (App 1) and Breakdown (App 3) indexes ----------
  const zIndex = parseIndex(pages, /APPENDIX 1\s*[–-]\s*Z CODE/i, /APPENDIX 2/i, out);
  const breakdownIndex = parseIndex(pages, /APPENDIX 3\s*[–-]\s*BREAKDOWN/i, /APPENDIX 4/i, out);
  for (const it of zIndex.items) if (it.defect) { const d = out.find(x => x.id === it.defect); d.inZIndex = it.page; }
  for (const it of breakdownIndex.items) if (it.defect) { const d = out.find(x => x.id === it.defect); d.inBreakdownIndex = it.page; }
  // ---------- Section 5 condition summary table: rows segmented by the Defect Description column ----------
  const summaryRows = parseSummaryTable(pages, pageSec, toc);
  for (const r of summaryRows) {
    let bd = null, bs = 0;
    for (const d of out) { let s = sim(r.title, d.title); if (s > 0 && r.section && d.section === r.section) s += 0.01; if (s > bs) { bs = s; bd = d; } }
    if (bd && bs >= 0.7) { if (!bd.summaryPage) bd.summaryPage = r.p; bd.summary = bd.summary || r; }
    else out.push({ id: 'd' + (out.length + 1), num: null, title: r.title, kind: 'Summary table only', section: r.section || '', sectionTitle: (toc.find(t => t.num === r.section) || {}).title || '',
      page: r.p, pageLabel: P(r.p).label, endPage: r.p, severityRange: r.severity || null, severityByBfra: null, priorityRange: null, priorityByBfra: null, conditionRange: null,
      zCode: /Z Code/i.test(r.details), breakdown: /Breakdown/i.test(r.details), quickCodes: r.quickCode ? [{ group: '', code: r.quickCode, raw: true }] : [], details: r.details, scale: [], examples: [], summaryPage: r.p });
  }
  // ---------- condition-summary table pages (section 5) that mention each defect ----------
  const summaryPages = pages.filter((p, i) => pageSec[i] && pageSec[i].num === '5');
  for (const d of out) {
    const nt = norm(d.title);
    const hit = summaryPages.find(p => norm(p.lines.map(l => l.segs.map(s => s.s).join(' ')).join(' ')).includes(nt) && p.lines.some(l => /Quick Code/.test(l.txt)));
    if (hit) d.summaryPage = hit.n;
  }
  // ---------- key passages (verbatim, anchored) ----------
  const passages = extractPassages(pages);
  // ---------- full-text chunks ----------
  const chunks = [];
  pages.forEach((p, i) => {
    const s = pageSec[i];
    let buf = [], blanks = 0;
    const flush = () => {
      const text = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length > 2) chunks.push({ id: 'c' + chunks.length, p: p.n, pl: p.label, sec: s ? s.num : '', st: s ? s.title : '', text });
      buf = [];
    };
    for (const l of p.lines) {
      if (!l.txt) { blanks++; if (blanks >= 2 && buf.join('').length > 250) flush(); if (buf.length) buf.push(''); continue; }
      blanks = 0; buf.push(l.segs.map(x => x.s).join('   '));
      if (buf.join('\n').length > 1400) flush();
    }
    flush();
  });
  return { meta, toc, defects: out, quickCodeTable, zIndex, breakdownIndex, passages, chunks };
}

function collectExamples(pg, from, to, ex) {
  const W = pg.w;
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const cap = [], cols = [];
    for (const l of group) for (const s of l.segs) {
      if (s.x < W * 0.45) cap.push(s.s);
      else {
        let c = cols.find(c => Math.abs(c.x - s.x) < W * 0.1);
        if (!c) { c = { x: s.x, parts: [] }; cols.push(c); }
        c.parts.push(s.s);
      }
    }
    cols.sort((a, b) => a.x - b.x);
    const tags = [];
    for (const c of cols) {
      const txt = c.parts.join(' ');
      const pre = txt.split('[')[0].trim();
      const bf = pre && pre.length < 40 ? pre : null;
      let m; TAG_RE.lastIndex = 0;
      while ((m = TAG_RE.exec(txt))) tags.push({ k: m[1], v: m[2].replace(/\s+/g, ' '), bfra: bf });
    }
    const caption = cap.join(' ').replace(/\s+/g, ' ').trim();
    if (tags.length || /^Figure/.test(caption)) ex.push({ p: pg.n, caption, tags, y0: group[0].y, y1: group[group.length - 1].y }); // y0/y1: caption top/bottom baselines (pt, top-down), used to map photos
    group = [];
  };
  for (let k = from; k < to; k++) { const l = pg.lines[k]; if (!l || !l.txt) flush(); else group.push(l); }
  flush();
}

function parseQuickCodeTable(pages) {
  const rows = [];
  let cols = null, pend = null, cat = null;
  for (const p of pages) {
    if (!p.header || p.header.num !== '14.2') continue;
    for (const l of p.lines) {
      if (!l.txt) continue;
      const hi = l.segs.findIndex(s => s.s === 'Quick Code Name');
      if (hi >= 0) { cols = l.segs.map(s => ({ name: s.s, x: s.x })); continue; }
      const cm = l.txt.match(/^(.+)\(([A-Z]{2})\)$/); if (cm && l.segs.length === 1) { cat = cm[1].trim(); continue; }
      if (!cols || l.txt === 'Notification' || /^14\.2/.test(l.txt)) continue;
      const xs = { name: cols[0].x, group: cols[1].x, desc: cols[2].x, type: cols[3] ? cols[3].x : 9999 };
      const r = { name: '', group: '', desc: '', type: '' };
      for (const s of l.segs) {
        if (/^(DD|SD|IF|VG)$/.test(s.s) && s.x > xs.desc - 5) { r.type = s.s; continue; }
        const key = s.x >= xs.desc - 6 ? 'desc' : s.x >= xs.group - 6 ? 'group' : 'name';
        r[key] = (r[key] + ' ' + s.s).trim();
      }
      if (!r.type) { // wrapped line
        if (pend && !r.group && rows.length && rows[rows.length - 1] === pend) { pend.name += ' ' + r.name; pend = null; continue; }
        pend = { pre: r }; continue;
      }
      if (pend && pend.pre) { r.name = (pend.pre.name + ' ' + r.name).trim(); r.group = (pend.pre.group + ' ' + r.group).trim(); }
      pend = null;
      if (r.group === 'N/A') r.group = '';
      r.cat = cat; r.p = p.n;
      rows.push(r);
    }
  }
  return rows;
}

function parseIndex(pages, startRe, endRe, defects) {
  let on = false; const items = []; let first = null, last = null, intro = [];
  for (const p of pages) {
    const all = p.lines.map(l => l.txt).join('\n');
    if (!on && startRe.test(all)) { on = true; first = p.n; }
    else if (on && endRe.test(all)) break;
    if (!on) continue;
    last = p.n;
    // intro paragraph(s) before the "Section" header line
    let bodyStart = 0;
    const hk = p.lines.findIndex(l => /^Section(\s+Section)?$/.test(l.segs.map(s => s.s).join(' ')));
    if (hk >= 0) { if (p.n === first) intro = p.lines.slice(0, hk).map(l => l.txt); bodyStart = hk + 1; }
    for (const half of [0, 1]) {
      let sec = null;
      for (const l of p.lines.slice(bodyStart)) {
        const segs = l.segs.filter(s => half ? s.x >= p.w / 2 - 5 : s.x < p.w / 2 - 5);
        if (!segs.length) continue;
        let t = segs.map(s => s.s).join(' ').trim();
        if (/^(Section|APPENDIX)/.test(t)) continue;
        const m = t.match(/^(\d+(?:\.\d+)+)\s*(.*)$/);
        let num = null;
        if (m) { num = m[1]; t = m[2]; if (!t) continue; if (num.split('.').length === 2) { sec = { num, title: t }; continue; } }
        items.push({ secNum: num ? num.split('.').slice(0, 2).join('.') : sec?.num, secTitle: sec?.title, num, name: t, page: p.n });
      }
    }
  }
  // merge wrapped names greedily using defect titles
  const merged = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i], nx = items[i + 1];
    const best = n => Math.max(0, ...defects.map(d => sim(n, d.title)));
    const bj = nx ? best(it.name + ' ' + nx.name) : 0;
    if (nx && !nx.num && nx.secNum === it.secNum && (/^[a-z]/.test(nx.name) || /(\bOr|\bOn|\bAnd|,|-|&)$/.test(it.name) || (best(it.name) < 0.7 && best(nx.name) < 0.7 && bj >= 0.7) || (best(nx.name) < 0.5 && bj >= best(it.name) && bj >= 0.7) || (best(nx.name) < 0.4 && nx.name.split(' ').length <= 3 && bj >= 0.7))) {
      merged.push({ ...it, name: it.name + ' ' + nx.name }); i++;
    } else merged.push(it);
  }
  for (const it of merged) {
    let bd = null, bs = 0;
    for (const d of defects) {
      let s = sim(it.name, d.title);
      if (s > 0 && it.secNum && d.section === it.secNum) s += 0.01;
      if (s > bs) { bs = s; bd = d; }
    }
    if (bd && bs >= 0.7) it.defect = bd.id;
  }
  // leftover wrap fragments ("Damage", "Damaged Or Missing") belong to the previous entry
  for (let i = merged.length - 1; i > 0; i--) {
    const it = merged[i], pv = merged[i - 1];
    if (!it.defect && !it.num && it.name.split(' ').length <= 3 && pv.defect && it.page === pv.page) { pv.name += ' ' + it.name; merged.splice(i, 1); }
  }
  return { from: first, to: last, intro: intro.join(' ').replace(/\s+/g, ' ').trim(), items: merged };
}

// Key passages copied verbatim between anchors. If an anchor isn't found, the passage is omitted.
const PASSAGES = [
  { id: 'deadlines', title: 'SAP data entry deadlines (Z Code)', start: /^Data Entry Deadlines/, end: /^Table 1|Maintenance information needs/, extra: 1 },
  { id: 'photos', title: 'Photo requirements', start: /^Basics$/, end: /Photos should be at least/, extra: 1 },
  { id: 'quickcode', title: 'Quick Code field', start: /^Quick Code$/, end: /^Description$/, inSec: '3.2' },
  { id: 'description', title: 'Description field', start: /^Description$/, end: /^Priority$/, inSec: '3.2' },
  { id: 'priorityfield', title: 'Priority field (Z or blank)', start: /^Priority$/, end: /notifications must use the blank/, extra: 1, inSec: '3.2' },
  { id: 'notes', title: 'Notes field and recommended fix', start: /^Notes$/, end: /under ‘Recording Of Results’|Recording Of Results/, extra: 1, inSec: '3.2' },
  { id: 'systems', title: 'Systems for recording defects', start: /^Systems Access$/, end: /Notification Upload App/, extra: 1, inSec: '3.2' },
  { id: 'fireconsequence', title: 'Fire start consequence (Z Code)', start: /^Assess The Consequence Of Fire Start/, end: /Must be flagged within the Priority field/, extra: 1 },
  { id: 'probability', title: 'Probability of failure', start: /^Determine The Probability Of Failure/, end: /Condition Monitoring/, extra: 1 },
  { id: 'severitydef', title: 'Defect severity definitions', start: /^Determine The Defect Severity/, end: /^Determine The Number Of Affected/ },
  { id: 'priorityscale', title: 'Z Code & Breakdown – immediate response flags', start: /^Asset Priority, Severity & Condition Scale/, end: /^Asset Severity & Condition Scale/ },
  { id: 'severityscale', title: 'Asset severity & condition scale', start: /^Asset Severity & Condition Scale/, end: /^Table 20/, crossPage: true },
  { id: 'breakdown', title: 'Breakdown definition & reporting', start: /^APPENDIX 3/, end: /^RES:|NOCDispatch/, extra: 1 },
  { id: 'pfdsp', title: 'Pre-Fire Danger Season patrols period', start: /Pre-Fire Danger Season Patrols.{0,30}annually/, end: /declared fire seasons/, extra: 1 },
];
function extractPassages(pages) {
  const res = [];
  for (const def of PASSAGES) {
    let found = null;
    outer: for (const p of pages) {
      if (def.inSec && !(p.header && p.header.num === def.inSec)) continue;
      for (let k = 0; k < p.lines.length; k++) {
        if (!def.start.test(p.lines[k].txt)) continue;
        const buf = []; let pages_ = [p.n]; let pg = p, kk = k, guard = 0;
        while (guard++ < 120) {
          if (kk >= pg.lines.length) {
            if (!def.crossPage) break;
            pg = pages[pg.n]; if (!pg) break; kk = 0; pages_.push(pg.n); continue;
          }
          const l = pg.lines[kk];
          if (kk > k || pg !== p) { if (def.end.test(l.txt)) { if (def.extra) buf.push(l.segs.map(s => s.s).join('  ')); break; } }
          buf.push(l.txt ? l.segs.map(s => s.s).join('  ') : '');
          kk++;
        }
        found = { id: def.id, title: def.title, page: p.n, pages: pages_, text: buf.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
        break outer;
      }
    }
    if (found) res.push(found);
  }
  return res;
}

function parseSummaryTable(pages, pageSec, toc) {
  const rows = [];
  const tocTitles = toc.map(t => t.title).filter(t => t && t.length > 3);
  let lastSecNum = null;
  for (const p of pages) {
    const s = pageSec[p.n - 1]; if (!s || s.num !== '5') continue;
    const hdr = p.lines.findIndex(l => l.segs.some(x => x.s === 'Defect Description') || l.segs.some(x => /^Defect Description/.test(x.s)));
    if (hdr < 0) continue;
    const H = p.lines.slice(Math.max(0, hdr - 3), hdr + 4).flatMap(l => l.segs);
    const xOf = re => { const g = H.find(x => re.test(x.s)); return g ? g.x : null; };
    const xd0 = xOf(/^Defect Description/), xq0 = xOf(/^Quick Code/), xdet0 = xOf(/^Defect Details/), xs0 = xOf(/^(Severity|HBFRA|NBFRA)$/);
    if (xd0 == null || xq0 == null || xdet0 == null) continue;
    const body = p.lines.slice(hdr + 1).filter(l => l.txt && l.y != null && !/^(MBFRA|NBFRA|HBFRA|Section)$/.test(l.txt));
    // headers are centred over their columns; find real (left-aligned) column starts from the body text
    const freq = new Map(); for (const l of body) for (const g of l.segs) { const k = Math.round(g.x / 3) * 3; freq.set(k, (freq.get(k) || 0) + 1); }
    const modeIn = (a, b) => { let best = null, bn = 0; for (const [k, n] of freq) if (k > a && k < b && n > bn) { bn = n; best = k; } return best; };
    const xq = modeIn(xd0 + 30, xq0 + 10) ?? xq0;
    const xs = xs0 != null ? Math.min(xs0, (modeIn(xq + 40, xs0 + 10) ?? xs0)) : null;
    const xdet = modeIn((xs0 ?? xq) + 30, xdet0 + 10) ?? xdet0;
    const xd = 0; // description column runs from the section column to the quick code column
    const xsecEnd = (() => { let m = 1e9; for (const l of body) for (const g of l.segs) if (/^\d+\.\d+(\.\d+)?$/.test(g.s)) m = Math.min(m, g.x2 + 4); return m < 1e9 ? m : xd0 - 40; })();
    // title fragments: segments starting inside the description column
    const frags = [];
    for (const l of body) for (const g of l.segs) if (g.x >= xsecEnd && g.x < xq - 6 && !/^\d+\.\d+(\.\d+)?$/.test(g.s)) frags.push({ y: l.y, s: g.s });
    const titles = [];
    for (const f of frags) { const t = titles[titles.length - 1]; if (t && f.y - t.y2 < 16) { t.s += ' ' + f.s; t.y2 = f.y; } else titles.push({ y1: f.y, y2: f.y, s: f.s }); }
    // section-heading rows (e.g. "6.2 Standard Poles", "Insulators Condition Examples") are separators, not defects
    const isHead = t => /Condition Examples$/i.test(t.s) || tocTitles.some(h => sim(h, t.s) >= 0.85) || body.some(l => Math.abs(l.y - t.y1) < 2 && l.segs.length <= 2 && /^\d+\.\d+$/.test(l.segs[0].s));
    const seps = titles.filter(isHead).map(t => t.y1);
    const real = titles.filter(t => !isHead(t));
    const secMarks = []; for (const l of body) for (const g of l.segs) if (g.x < xsecEnd && /^\d+\.\d+(\.\d+)?$/.test(g.s)) secMarks.push({ y: l.y, num: g.s });
    real.forEach((t, i) => {
      const yc = (t.y1 + t.y2) / 2;
      const prev = real[i - 1], next = real[i + 1];
      let top = prev ? ((prev.y1 + prev.y2) / 2 + yc) / 2 : -1, bot = next ? ((next.y1 + next.y2) / 2 + yc) / 2 : 1e9;
      for (const y of seps) { if (y < t.y1 && y + 4 > top) top = y + 4; if (y > t.y2 && y - 4 < bot) bot = y - 4; }
      const col = (a, b) => body.filter(l => l.y > top && l.y <= bot).map(l => l.segs.filter(g => g.x >= a && g.x < b).map(g => g.s).join(' ')).filter(Boolean).join('\n');
      let secTxt = col(0, xsecEnd).match(/\d+\.\d+(\.\d+)?/);
      const above = secMarks.filter(m => m.y <= t.y2 + 2); if (!secTxt && above.length) secTxt = [above[above.length - 1].num]; else if (!secTxt && lastSecNum) secTxt = [lastSecNum];
      let qcRaw = col(xq - 6, xs != null ? xs - 6 : xdet - 6), sevRaw = xs != null ? col(xs - 6, xdet - 6) : '';
      const leak = qcRaw.match(/\s*\b((?:Extreme|Very High|High|Moderate|Low) down to (?:Very High|High|Moderate|Low))\b/);
      if (leak) { qcRaw = qcRaw.replace(leak[0], ' '); sevRaw = (sevRaw + ' ' + leak[1]).trim(); }
      rows.push({ p: p.n, title: t.s.replace(/\s+/g, ' ').trim(), section: secTxt ? secTxt[0].split('.').slice(0, 2).join('.') : null, num: secTxt ? secTxt[0] : null,
        quickCode: qcRaw.split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'),
        severity: sevRaw.replace(/\s+/g, ' ').trim(), details: col(xdet - 6, 1e9) });
    });
    if (secMarks.length) lastSecNum = secMarks[secMarks.length - 1].num;
  }
  return rows;
}
