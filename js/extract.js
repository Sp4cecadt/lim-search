// Shared extraction logic: used by the box build (Node) and the in-app "Update manual" (browser).
// Input: pages from layoutPage(); output: structured manual data. Never invents content:
// every field is copied from the page text, with its PDF page number.
export const EXTRACTOR_VERSION = '1.3'; // 1.2: severity cell fill colours (scale[].c); 1.3: LIM audit fixes (tag columns, merged cells, two-column charts, tables, Breakdown sources, body-heading TOC)
import { colourAt } from './fills.js';

const FOOT = /This document is not to be copied|©\s*SA Power Networks|^Page \d+ of \d+$|^\.$|^express permission/;
const LEVEL_RE = /^(?:\d\s+)?(Extreme|Very High|High|Moderate|Low|New|Nil|End of Life|Z Code)\b\s*(.*)$/;
const LABELS = ['Defect Severity Range', 'Defect Priority Range', 'Defect Condition Range', 'Quick Code', 'Details', 'Record Condition Only'];
// a details sentence that merely starts with a level word (e.g. "Low severity …", "High density …", "Low voltage …").
// A real scale row has the level in its own cell (a column gap before the text); prose has the next word in the same run.
const PROSE_RE = /^(severity|density|voltage)\b/i;
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
  return { n: pg.n, w: pg.w, label, header: header || null, lines, fills: pg.fills || null };
}
const isBlank = l => !l.txt;

export function extractManual(rawPages, info = {}) {
  const pages = rawPages.map(cleanPage);
  const P = n => pages[n - 1];
  // fill colour of the severity label cell (manual §1.1.3: Red = raise a defect, Grey = no defect); null if not read
  const cellCol = l => { const pg = P(l.pn), s0 = l.segs && l.segs[0]; if (!pg || !pg.fills || !s0 || l.y == null) return null; return colourAt(pg.fills, s0.x + 3, l.y - 3) || colourAt(pg.fills, s0.x + 3, l.y - 1); };
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
  // sections whose running page header is wrong in the manual (e.g. 10.7, 12.7) only exist as body headings: add them to the TOC
  {
    const have = new Set(toc.map(t => t.num)), tops = new Set(toc.map(t => t.num.split('.')[0]));
    const add = [];
    const topOf = n => (pageSec[n - 1] ? pageSec[n - 1].num.split('.')[0] : null);
    const lastOfTop = t => { let z = 0; pageSec.forEach((x, i) => { if (x && x.num.split('.')[0] === t) z = i + 1; }); return z; };
    for (const h of heads) if (!have.has(h.num) && tops.has(h.num.split('.')[0]) && topOf(h.p) === h.num.split('.')[0] && !add.some(a => a.num === h.num)) add.push({ num: h.num, title: h.title, from: h.p, to: h.p, bodyHeading: true });
    const cmpNum = (a, b) => { const A = a.split('.').map(Number), B = b.split('.').map(Number); for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] ?? -1) - (B[i] ?? -1); if (d) return d; } return 0; };
    for (const a of add) {
      // runs until the next body heading of the same level
      const nx = heads.find(x => (x.p > a.from) && x.num !== a.num && x.num.split('.').length === a.num.split('.').length && cmpNum(x.num, a.num) > 0);
      a.to = Math.min(nx ? Math.max(a.from, nx.p - (nx.k > 3 ? 0 : 1)) : a.from, Math.max(a.from, lastOfTop(a.num.split('.')[0])));
      let at = toc.findIndex(t => /\./.test(t.num) && t.num.split('.')[0] === a.num.split('.')[0] && cmpNum(t.num, a.num) > 0);
      if (at < 0) { at = toc.length; for (let i = toc.length - 1; i >= 0; i--) if (toc[i].num.split('.')[0] === a.num.split('.')[0]) { at = i + 1; break; } }
      toc.splice(at, 0, a);
    }
  }
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
    const f = { sev: [], pri: [], cond: [], qc: [], det: [], aside: [] };
    let mode = null, si = 0;
    const scale = [];
    let lastLevel = null, group = null, indentBuf = [], centred = false, detFrom = -1, detTo = -1, twoCol = null, sideNote = [];
    const LEVEL_WORD = /^(Extreme|Very High|High|Moderate|Low)$/;
    const isBare = l => l && l.segs && l.segs.length === 1 && LEVEL_WORD.test(l.segs[0].s) && l.segs[0].x < P(l.pn).w * 0.17;
    const isCap = l => /\[\s*(Severity|Priority|Condition)\s*:/.test(l.segs.map(s => s.s).join(' ')) || l.segs.some(s => /^(H\/MBFRA|NBFRA)$/.test(s.s) && s.x > l.segs[0].x + 50) || /^Figure \d+/.test(l.txt);
    const flushTwoCol = () => { if (!twoCol) return; for (const c of twoCol.cols) scale.push(...c.rows); twoCol = null; lastLevel = null; };
    // A line ending in ':' is a chart heading unless it reads as a sentence lead-in ("It is …:", "If …:", "… as below:")
    // or is the wrapped last line of a longer sentence.
    const proseLabel = (l, si) => { if (/^(it is|if|when|where|note|determine|for details)\b|\b(below|follows|if)\s*:$/i.test(l.txt)) return true;
      const pv = stream[si - 1]; return !!(pv && pv.txt && pv.pn === l.pn && !/[.:;!?)\]]$/.test(pv.txt.trim()) && !LEVEL_RE.test((pv.segs && pv.segs[0] && pv.segs[0].s) || '') && Math.abs(l.y - pv.y) < 16); };
    const lineTxt = l => l.segs.map(s => s.s).join('  ');
    for (; si < stream.length; si++) {
      const l = stream[si];
      if (l.pageBreak) { lastLevel = null; indentBuf = []; continue; }
      if (l.txt === 'Defect Severity Range') { mode = 'sev'; continue; }
      if (l.txt === 'Defect Priority Range') { mode = 'pri'; continue; }
      if (l.txt === 'Defect Condition Range') { mode = 'cond'; continue; }
      if (l.txt === 'Record Condition Only') { f.cond.push(l.txt); continue; }
      if (l.txt === 'Quick Code') { mode = 'qc'; continue; }
      if (l.txt === 'Details') { mode = 'det'; if (detFrom < 0) detFrom = si + 1; continue; }
      if (!mode) continue;
      // a signage panel printed below the quick codes is not a quick code
      if (mode === 'qc' && l.txt === 'Signage Identification') { mode = 'aside'; continue; }
      if (mode !== 'det') { if (l.txt) f[mode].push(lineTxt(l)); continue; }
      const joined = l.segs.map(s => s.s).join(' ');
      const isCaption = /\[\s*(Severity|Priority|Condition)\s*:/.test(joined) || l.segs.some(s => /^(H\/MBFRA|NBFRA)$/.test(s.s) && s.x > l.segs[0].x + 50) || /^Figure \d+/.test(l.txt);
      if (isCaption) break;
      const W = P(l.pn).w;
      // two-column chart (column headings over two text columns beside one level column): one row per column, grouped under its heading
      if (twoCol) {
        if (!l.txt) continue;
        const a0 = l.segs[0], alv = a0.s.match(LEVEL_RE), aEdge = a0.x < W * 0.17;
        const near = x => { let bi = 0; twoCol.xs.forEach((cx, i) => { if (Math.abs(cx - x) < Math.abs(twoCol.xs[bi] - x)) bi = i; }); return bi; };
        if (alv && aEdge && !alv[2]) { const seen = new Set(); for (const sg of l.segs.slice(1)) { const ci = near(sg.x); const c = twoCol.cols[ci]; if (seen.has(ci)) c.rows[c.rows.length - 1].text += ' ' + sg.s; else c.rows.push({ level: alv[1], text: sg.s, group: c.h, p: l.pn, c: cellCol(l) }); seen.add(ci); } continue; }
        if (!aEdge) { for (const sg of l.segs) { const c = twoCol.cols[near(sg.x)]; if (c.rows.length) c.rows[c.rows.length - 1].text += ' ' + sg.s; } continue; }
        flushTwoCol();
      }
      if (l.txt && l.segs.length >= 2 && l.segs[0].x >= W * 0.17 && !/[\[:]/.test(l.txt) && !LEVEL_RE.test(l.segs[0].s)) {
        let j = si + 1; while (j < stream.length && stream[j].segs && !stream[j].txt) j++;
        const nx = stream[j];
        if (nx && nx.segs && nx.pn === l.pn && nx.segs.length === l.segs.length + 1 && LEVEL_RE.test(nx.segs[0].s) && nx.segs[0].x < W * 0.17 && l.segs.every((sg, i) => Math.abs(nx.segs[i + 1].x - sg.x) < 20)) {
          twoCol = { xs: l.segs.map(sg => sg.x), cols: l.segs.map(sg => ({ h: sg.s, rows: [] })) }; lastLevel = null; indentBuf = []; continue;
        }
      }
      if (!l.txt) { indentBuf = []; if (!lastLevel) f.det.push(''); lastLevel = null; continue; }
      const s0 = l.segs[0];
      const lv = s0.s.match(LEVEL_RE);
      const leftEdge = s0.x < W * 0.17;
      // merged cell: one text block printed beside several level labels that have no text of their own
      // (one table cell spanning several level rows). Applies the text to every level it spans.
      if (isBare(l) && !indentBuf.length) {
        const items = []; let j = si;
        for (; j < stream.length; j++) {
          const x = stream[j];
          if (x.pageBreak || x.pn !== l.pn) break;
          if (!x.txt) continue;
          if (isBare(x)) { items.push({ j, bare: true, l: x }); continue; }
          if (x.segs[0].x >= W * 0.17 && !isCap(x)) { items.push({ j, bare: false, l: x }); continue; }
          break;
        }
        while (items.length && !items[items.length - 1].bare) items.pop();
        const labs = items.filter(x => x.bare), txts = items.filter(x => !x.bare);
        const prev = (() => { for (let k = si - 1; k >= 0; k--) { const x = stream[k]; if (x.pageBreak) return null; if (x.txt) return x; } return null; })();
        const prevIndented = prev && prev.pn === l.pn && prev.segs[0].x >= W * 0.17 && Math.abs(l.y - prev.y) < 30;
        if (labs.length >= 2 && txts.length && !prevIndented) {
          const blocks = [];
          for (const t of txts) { const b = blocks[blocks.length - 1]; if (b && t.j === b.last.j + 1 + (stream.slice(b.last.j + 1, t.j).filter(x => !x.txt).length) && stream.slice(b.last.j + 1, t.j).every(x => !x.txt || !isBare(x)) && t.l.y - b.last.l.y < 16) { b.lines.push(t.l); b.last = t; } else blocks.push({ lines: [t.l], last: t }); }
          const ly = labs.map(x => x.l.y);
          const nearestOf = blocks.map(b => { const c = (b.lines[0].y + b.lines[b.lines.length - 1].y) / 2; b.c = c; let n = 0; ly.forEach((y, i) => { if (Math.abs(y - c) < Math.abs(ly[n] - c)) n = i; }); return n; });
          const cover = new Array(labs.length).fill(null); let ok = true;
          blocks.forEach((b, bi) => {
            const n = nearestOf[bi]; let best = null;
            for (let a = 0; a <= n; a++) for (let z = n; z < labs.length; z++) {
              let bad = false; for (let q = a; q <= z; q++) if (cover[q] || nearestOf.some((m, oi) => oi !== bi && m === q)) bad = true;
              if (bad) continue;
              const mean = ly.slice(a, z + 1).reduce((x, y) => x + y, 0) / (z - a + 1);
              if (Math.abs(mean - b.c) <= 5 && (!best || z - a > best[1] - best[0])) best = [a, z];
            }
            if (!best) { ok = false; return; }
            for (let q = best[0]; q <= best[1]; q++) cover[q] = { b, span: best[1] - best[0] + 1 };
          });
          if (ok) {
            labs.forEach((x, q) => { const cv = cover[q]; if (!cv) return; const r = { level: x.l.segs[0].s, text: cv.b.lines.map(lineTxt).join(' '), group, p: x.l.pn, c: cellCol(x.l) }; if (cv.span > 1) r.merged = cv.span; scale.push(r); });
            si = items[items.length - 1].j; lastLevel = null; indentBuf = []; continue;
          }
        }
      }
      // a side note printed to the right of a chart row, starting just above the row's baseline
      if (!leftEdge && s0.x >= W * 0.6 && !lastLevel) {
        let j = si + 1; while (j < stream.length && stream[j].segs && !stream[j].txt) j++;
        const nx = stream[j];
        if (nx && nx.txt && nx.pn === l.pn && nx.y - l.y < 12 && nx.segs[0].x < W * 0.17 && LEVEL_RE.test(nx.segs[0].s) && nx.segs.every(sg => (sg.x2 || sg.x) < s0.x - 20)) { sideNote.push(joined); continue; }
      }
      // table header line(s) printed directly above a chart's rows, without a trailing colon
      if (scale.length && leftEdge && !lv && l.txt.length < 70 && !/[.,;:\]]$/.test(l.txt) && !/\[/.test(l.txt)) {
        const hdr = [l]; let j = si + 1;
        while (j < stream.length && stream[j].txt && stream[j].pn === l.pn && !LEVEL_RE.test(stream[j].segs[0].s) && stream[j].y - hdr[hdr.length - 1].y < 16 && hdr.length < 3) { hdr.push(stream[j]); j++; }
        const nx = stream[j];
        if (nx && nx.txt && nx.pn === l.pn && nx.y - hdr[hdr.length - 1].y < 16 && LEVEL_RE.test(nx.segs[0].s) && nx.segs[0].x < W * 0.17 && hdr.every(h => h.segs[0].x < W * 0.17 && !/[.,;:]$/.test(h.txt))) {
          const cols = []; for (const h of hdr) for (const sg of h.segs) { let c = cols.find(c => Math.abs(c.x - sg.x) < 15); if (!c) { c = { x: sg.x, t: [] }; cols.push(c); } c.t.push(sg.s); }
          cols.sort((a, b) => a.x - b.x);
          group = cols.map(c => c.t.join(' ')).join(' | '); lastLevel = null; indentBuf = []; si = j - 1; continue;
        }
      }
      if (lastLevel && lastLevel.pendingNum && !lastLevel.level && lv && leftEdge) {
        lastLevel.level = lv[1]; lastLevel.c = cellCol(l) || lastLevel.c; delete lastLevel.pendingNum;
        const rest = [lv[2], ...l.segs.slice(1).map(s => s.s)].filter(Boolean).join(' ');
        if (rest) lastLevel.text += ' ' + rest; continue;
      }
      if (lv && leftEdge && l.segs.length === 1 && !lv[2] && /^(Extreme|Very High|High|Moderate|Low)$/.test(s0.s) && indentBuf.length) {
        // level label vertically centred beside its text block: pull the indented lines above it
        const pulled = indentBuf.map(ix => f.det[ix]); for (const ix of indentBuf.slice().reverse()) f.det.splice(ix, 1);
        scale.push({ level: lv[1], text: pulled.join(' '), group, p: l.pn, c: cellCol(l) }); lastLevel = scale[scale.length - 1]; indentBuf = []; centred = true; continue;
      }
      if (lv && leftEdge && (l.segs.length >= 2 || lv[2] || /^\d\s/.test(s0.s)) && !/[.]$/.test(lv[2] || '') && !(lv[2] && !/^\d\s/.test(s0.s) && (l.segs.length === 1 || PROSE_RE.test(lv[2])))) {
        const rest = [lv[2], ...l.segs.slice(1).map(s => s.s), ...sideNote].filter(Boolean).join(' '); sideNote = [];
        scale.push({ level: lv[1], text: rest, group, p: l.pn, c: cellCol(l) }); lastLevel = scale[scale.length - 1];
        continue;
      }
      if (/^\d$/.test(s0.s) && leftEdge) { // e.g. "2" on one line, "Moderate" on the next
        scale.push({ level: '', text: l.segs.slice(1).map(s => s.s).join(' '), group, p: l.pn, pendingNum: s0.s, c: cellCol(l) }); lastLevel = scale[scale.length - 1]; continue;
      }
      if (lastLevel) {
        if (!leftEdge || /^(OR|AND)$/.test(l.txt)) { lastLevel.text += ' ' + joined; continue; }
        const lv2 = l.txt.match(/^(Extreme|Very High|High|Moderate|Low)\b\s*(.*)$/);
        if (lv2 && lastLevel.pendingNum && !lastLevel.level) { lastLevel.level = lv2[1]; lastLevel.c = cellCol(l) || lastLevel.c; delete lastLevel.pendingNum; if (lv2[2]) lastLevel.text += ' ' + lv2[2]; continue; }
      }
      // ordinary details line (or a heading between two scales, e.g. "LV Crossarm Bolts or Nuts:")
      if (scale.length && /:$/.test(l.txt) && l.txt.length < 70 && !proseLabel(l, si)) { group = l.txt.replace(/:$/, ''); lastLevel = null; continue; }
      lastLevel = null;
      if (!leftEdge) indentBuf.push(f.det.length); else indentBuf = [];
      if (/:$/.test(l.txt) && l.txt.length < 70 && !proseLabel(l, si) && (() => { // chart heading: a severity chart follows before the next heading
        const titleLike = l.txt.replace(/:$/, '').split(/\s+/).every(w => /^[A-Z0-9&(]/.test(w) || /^(and|or|of|to|for|the|in|on|with)$/.test(w));
        for (let j = si + 1; j < Math.min(stream.length, si + (titleLike ? 13 : 7)); j++) { const x = stream[j]; if (x.pageBreak) return false; if (!x.segs || !x.segs[0]) continue;
          if (x.segs.length >= 2 && LEVEL_RE.test(x.segs[0].s) && x.segs[0].x < P(x.pn).w * 0.17) return true;
          if (/:$/.test(x.txt) && x.txt.length < 70 && !proseLabel(x, j)) return false; if (isCap(x)) return false; }
        return false; })()) { group = l.txt.replace(/:$/, ''); f.det.push(lineTxt(l)); continue; }
      f.det.push(lineTxt(l));
    }
    flushTwoCol();
    detTo = si;
    for (const sc of scale) { sc.z = sc.level === 'Z Code' || /\[[^\]]*Z Code[^\]]*\]/i.test(sc.text); sc.text = sc.text.replace(/\s+/g, ' ').trim(); delete sc.pendingNum; if (!sc.group) delete sc.group; if (!sc.c) delete sc.c; }
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
        last2 = { level: lv[1], text: l.segs.slice(1).map(x => x.s).join(' '), group: g2 || 'Further chart (no heading printed)', p: l.pn, c: cellCol(l) }; scale.push(last2); continue;
      }
      if (last2 && l.txt && s0.x >= P(l.pn).w * 0.17 && !/\[/.test(l.txt)) { last2.text += ' ' + l.segs.map(x => x.s).join(' '); continue; }
      if (!l.txt) last2 = null;
      bucket.push(l);
    }
    for (const sc of scale) { sc.z = sc.level === 'Z Code' || /\[[^\]]*Z Code[^\]]*\]|Z code/i.test(sc.text); sc.text = sc.text.replace(/\s+/g, ' ').trim(); if (!sc.group) delete sc.group; }
    flushB();
    // tags that spilled over to the top of the next page belong to the previous example
    for (let i = ex.length - 1; i > 0; i--) if (!ex[i].caption && ex[i].p === ex[i - 1].p + 1 && ex[i].y0 < 90) { ex[i - 1].tags.push(...ex[i].tags); ex.splice(i, 1); }
    const sevText = f.sev.join('\n'), priText = f.pri.join('\n');
    const byBfra = txt => {
      const r = {}; for (const ln of txt.split('\n')) { const m = ln.match(/^(H\/MBFRA|H\/MBFA|HBFRA|MBFRA|NBFRA|H\/M\/NBFRA)\s*:?\s+(.+)$/); if (m) r[m[1]] = m[2].trim(); }
      return Object.keys(r).length ? r : null;
    };
    const det = f.det.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const tables = detFrom >= 0 ? findTables(stream.slice(detFrom, detTo), P) : [];
    const aside = f.aside.length ? { title: 'Signage Identification', text: f.aside.join('\n') } : null; // panel heading as printed
    // Breakdown: the priority range, or the card's own details / chart saying it is a Breakdown
    const bdTxt = [det, ...scale.map(s => s.text)].join('\n');
    const bdDet = /\b(it is a|is a|as a|be a|considered a)\s+['‘’"“]?breakdown\b|\bbreakdown in all areas\b/i.test(bdTxt.replace(/\bnot (a|as a) breakdown\b/gi, ''));
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
      breakdown: /Breakdown/i.test(priText) || bdDet,
      breakdownFrom: !/Breakdown/i.test(priText) && bdDet ? 'details' : undefined,
      quickCodes: qcs, details: det, scale, examples: ex,
      ...(tables.length ? { tables } : {}), ...(aside ? { aside } : {}),
    });
  });
  // ---------- quick code reference table (14.2) ----------
  const quickCodeTable = parseQuickCodeTable(pages);
  // ---------- Z-code (App 1) and Breakdown (App 3) indexes ----------
  const zIndex = parseIndex(pages, /APPENDIX 1\s*[–-]\s*Z CODE/i, /APPENDIX 2/i, out);
  const breakdownIndex = parseIndex(pages, /APPENDIX 3\s*[–-]\s*BREAKDOWN/i, /APPENDIX 4/i, out);
  for (const it of zIndex.items) if (it.defect) { const d = out.find(x => x.id === it.defect); d.inZIndex = it.page; }
  for (const it of breakdownIndex.items) if (it.defect) { const d = out.find(x => x.id === it.defect); d.inBreakdownIndex = it.page; if (!d.breakdown) { d.breakdown = true; d.breakdownFrom = 'index'; } }
  for (const d of out) if (d.breakdownFrom === undefined) delete d.breakdownFrom;
  // ---------- Section 5 condition summary table: rows segmented by the Defect Description column ----------
  const summaryRows = parseSummaryTable(pages, pageSec, toc);
  for (const r of summaryRows) {
    let bd = null, bs = 0;
    for (const d of out) { let s = sim(r.title, d.title); if (s > 0 && r.section && d.section === r.section) s += 0.01; if (s > bs) { bs = s; bd = d; } }
    if (bd && bs >= 0.7) { if (!bd.summary) { bd.summary = r; bd.summaryPage = r.p; } }
    else out.push({ id: 'd' + (out.length + 1), num: null, title: r.title, kind: 'Summary table only', section: r.section || '', sectionTitle: (toc.find(t => t.num === r.section) || {}).title || '',
      page: r.p, pageLabel: P(r.p).label, endPage: r.p, severityRange: r.severity || null, severityByBfra: null, priorityRange: null, priorityByBfra: null, conditionRange: null,
      zCode: /Z Code/i.test(r.details), breakdown: /Breakdown/i.test(r.details), quickCodes: r.quickCode ? [{ group: '', code: r.quickCode, raw: true }] : [], details: r.details, scale: [], examples: [], summaryPage: r.p });
  }
  // ---------- condition-summary table pages (section 5) that mention each defect ----------
  const summaryPages = pages.filter((p, i) => pageSec[i] && pageSec[i].num === '5');
  for (const d of out) {
    const nt = norm(d.title);
    const hit = summaryPages.find(p => norm(p.lines.map(l => l.segs.map(s => s.s).join(' ')).join(' ')).includes(nt) && p.lines.some(l => /Quick Code/.test(l.txt)));
    if (hit && !d.summary) d.summaryPage = hit.n; // a matched summary row wins: a page-wide text hit can be a mention in another row's details
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

// Area / voltage column headings printed above two columns of tags (e.g. "H/MBFRA" | "NBFRA", "SWER Areas" | "MEN/CMEN Areas")
const BF_HDR = /^(H\/MBFRA|H\/MBFA|HBFRA|MBFRA|NBFRA|H\/M\/NBFRA|SWER Areas|MEN\/CMEN Areas|11kV or 19kV|33kV|Within 5kms coast|Outside 5kms coast)$/;
function collectExamples(pg, from, to, ex) {
  const W = pg.w;
  let group = [];
  const flush = () => {
    if (!group.length) return;
    // join a tag split over two lines ("[Severity: Very" / "High]") within a column
    const L = group.map(l => ({ ...l, segs: l.segs.map(s => ({ ...s })) }));
    for (let i = 0; i < L.length - 1; i++) for (const s of L[i].segs) {
      if ((s.s.match(/\[/g) || []).length <= (s.s.match(/\]/g) || []).length) continue;
      const nx = L[i + 1].segs.find(t => Math.abs(t.x - s.x) < W * 0.12 && /^[^\[]*\]/.test(t.s));
      if (nx) { const m = nx.s.match(/^[^\[]*\]/)[0]; s.s += ' ' + m; s.x2 = Math.max(s.x2 || s.x, s.x + 1); nx.s = nx.s.slice(m.length).trim(); }
    }
    const cap = [], hdrs = [], pieces = []; let li = 0;
    for (const l of L) { li++; for (const s of l.segs) {
      if (!s.s) continue;
      const tagMs = []; let m; TAG_RE.lastIndex = 0; while ((m = TAG_RE.exec(s.s))) tagMs.push({ i: m.index, len: m[0].length, k: m[1], v: m[2].replace(/\s+/g, ' ') });
      const rest = s.s.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
      const x2 = s.x2 && s.x2 > s.x ? s.x2 : s.x + s.s.length * 4.5, cw = (x2 - s.x) / Math.max(1, s.s.length);
      if (!tagMs.length) {
        if (BF_HDR.test(rest)) hdrs.push({ t: rest, c: (s.x + x2) / 2, li });
        else if (s.x < W * 0.45) cap.push(s.s);
        else pieces.push({ text: s.s, x: s.x, li, seg: s }); // old behaviour: right-half text joins its column
        continue;
      }
      const pre = s.s.split('[')[0].trim();
      let own = null;
      if (pre && BF_HDR.test(pre)) own = pre;
      else if (pre && s.x < W * 0.45) cap.push(rest);
      else if (pre) pieces.push({ text: s.s.split('[')[0], x: s.x, li, seg: s });
      const post = s.s.slice(s.s.lastIndexOf(']') + 1).trim(); // text after the last tag in a caption run stays in the caption
      if (post && s.x < W * 0.45 && !own && pre) { /* already in rest */ } else if (post && s.x < W * 0.45) cap.push(post);
      for (const t of tagMs) pieces.push({ tag: { k: t.k, v: t.v }, own, c: s.x + cw * (t.i + t.len / 2), x: s.x, li, seg: s });
    } }
    const tags = [];
    if (hdrs.length) {
      // tags go to the nearest column heading by centre; a heading printed in the same run binds its own tags
      const H = []; for (const h of hdrs) if (!H.some(x => x.t === h.t && Math.abs(x.c - h.c) < W * 0.05)) H.push(h);
      H.sort((a, b) => a.c - b.c);
      const out = [];
      for (const p of pieces) { if (!p.tag) continue;
        let bf = p.own; let col = p.own ? -1 : 0;
        if (!bf) { let bi = 0; H.forEach((h, i) => { if (Math.abs(h.c - p.c) < Math.abs(H[bi].c - p.c)) bi = i; }); bf = H[bi].t; col = bi; }
        out.push({ ...p.tag, bfra: bf, _x: p.own ? p.x : H[col].c, _li: p.li });
      }
      out.sort((a, b) => a._x - b._x || a._li - b._li);
      for (const t of out) { delete t._x; delete t._li; tags.push(t); }
    } else {
      // no headings: columns by run start, as printed
      const cols = [];
      for (const p of pieces) { let c = cols.find(c => Math.abs(c.x - p.x) < W * 0.1); if (!c) { c = { x: p.x, ps: [] }; cols.push(c); } c.ps.push(p); }
      cols.sort((a, b) => a.x - b.x);
      for (const c of cols) {
        const pre = c.ps.map(p => p.tag ? (p.own || '') : p.text).join(' ').split('[')[0].trim();
        const own = c.ps.find(p => p.own); const bf = own ? own.own : (pre && pre.length < 40 && !c.ps[0].tag ? pre : null);
        for (const p of c.ps) if (p.tag) tags.push({ ...p.tag, bfra: p.own || bf });
      }
    }
    const caption = cap.join(' ').replace(/\s+/g, ' ').trim();
    if (tags.length || caption) local.push({ p: pg.n, caption, tags, y0: group[0].y, y1: group[group.length - 1].y }); // y0/y1: caption top/bottom baselines (pt, top-down), used to map photos
    group = [];
  };
  const local = [];
  for (let k = from; k < to; k++) { const l = pg.lines[k]; if (!l || !l.txt) flush(); else group.push(l); }
  flush();
  // a tag block printed on its own just above its caption (no tags in the caption block) is one example
  for (let i = 0; i < local.length - 1; i++) {
    const a = local[i], b = local[i + 1];
    if (a.tags.length && !a.caption && b.caption && !b.tags.length && !/^Figure/.test(b.caption) && b.y0 - a.y1 < 40) { a.caption = b.caption; a.y1 = b.y1; local.splice(i + 1, 1); }
  }
  // …or just below its caption
  for (let i = 1; i < local.length; i++) {
    const a = local[i - 1], b = local[i];
    if (b.tags.length && !b.caption && a.caption && !a.tags.length && !/^Figure/.test(a.caption) && b.y0 - a.y1 < 40) { a.tags = b.tags; a.y1 = b.y1; local.splice(i, 1); i--; }
  }
  for (const e of local) if (e.tags.length || /^Figure/.test(e.caption)) ex.push(e);
}

// Grid tables inside a card's Details (e.g. a severity matrix by area or voltage). Kept as printed: one text row per
// printed line, columns spaced by their position on the page. Lines that are severity chart rows are not tables.
function findTables(lines, P) {
  const out = [];
  const isLv = l => l.segs[0].x < P(l.pn).w * 0.17 && LEVEL_RE.test(l.segs[0].s);
  const isGrid = l => l.segs && l.segs.length >= 2 && !isLv(l) && !/^(•|o|[-–]|\(?[a-z0-9]{1,2}[.)])$/i.test(l.segs[0].s) && !/\[\s*(Severity|Priority|Condition)\s*:/.test(l.txt);
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.pageBreak || !l.txt || !isGrid(l)) { i++; continue; }
    let a = i; // stacked header words printed above the first grid row
    while (a > 0 && lines[a - 1].txt && !lines[a - 1].pageBreak && lines[a - 1].pn === l.pn && lines[a - 1].segs.length === 1 && lines[a - 1].segs[0].x >= P(l.pn).w * 0.3 && l.y - lines[a - 1].y < 60) a--;
    let z = i, blanks = 0, grid = 0;
    for (let j = i; j < lines.length; j++) {
      const x = lines[j];
      if (x.pageBreak || x.pn !== l.pn) break;
      if (!x.txt) { if (++blanks > 1) break; continue; }
      if (isLv(x)) break;
      if (/^(•|[-–])$/.test(x.segs[0].s)) break;
      if (x.segs.length === 1 && x.segs[0].x < P(x.pn).w * 0.17 && /[.:]$/.test(x.txt) && x.txt.length > 60) break; // prose
      blanks = 0; z = j; if (isGrid(x)) grid++;
    }
    if (grid >= 3) {
      let rows = lines.slice(a, z + 1).filter(x => x.segs);
      const x0 = Math.min(...rows.filter(r => r.txt).map(r => r.segs[0].x)), CW = 4.6;
      // column headings stacked over several printed lines (staggered baselines): one wrapped cell per column
      const W0 = P(l.pn).w; let hz = 0; while (hz < rows.length && (!rows[hz].txt || rows[hz].segs[0].x >= W0 * 0.3)) hz++;
      const headText = [];
      if (hz >= 3) {
        const cols = []; for (const r of rows.slice(0, hz)) for (const sg of r.segs) { let c = cols.find(c => Math.abs(c.x - sg.x) < 20); if (!c) { c = { x: sg.x, t: [] }; cols.push(c); } c.t.push(sg.s); }
        cols.sort((p, q) => p.x - q.x);
        const wrapped = cols.map((c, i) => { const w = Math.max(8, Math.round(((cols[i + 1] ? cols[i + 1].x : c.x + 90) - c.x) / CW) - 2); const out = []; let cur = '';
          for (const word of c.t.join(' ').split(/\s+/)) { if (cur && (cur + ' ' + word).length > w) { out.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word; } if (cur) out.push(cur); return out; });
        const n = Math.max(...wrapped.map(w => w.length));
        for (let k = 0; k < n; k++) { let t = ''; cols.forEach((c, i) => { const s2 = wrapped[i][k] || ''; if (!s2) return; const col = Math.round((c.x - x0) / CW); t += ' '.repeat(Math.max(t.length ? 2 : 0, col - t.length)) + s2; }); headText.push(t); }
        rows = rows.slice(hz);
      }
      const text = headText.concat(rows.map(r => { let t = ''; for (const s of r.segs) { const col = Math.round((s.x - x0) / CW); t += (t.length && col <= t.length + 1 ? '  ' : ' '.repeat(Math.max(0, col - t.length))) + s.s; } return t.replace(/\s+$/, ''); }));
      while (text.length && !text[text.length - 1]) text.pop();
      out.push({ p: l.pn, rows: text.map(t => t.replace(/\uf0fb/g, '✗').replace(/\uf0fc/g, '✓')) }); // Wingdings cross / tick as printed
    }
    i = Math.max(z + 1, i + 1);
  }
  return out;
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
        if (m) { num = m[1]; t = m[2]; if (!t) continue; if (num.split('.').length === 2) { sec = { num, title: t }; if (!defects.some(d => d.section === num && norm(t) === norm(d.title))) continue; } } // a section heading can itself be the card (e.g. 10.2)
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
