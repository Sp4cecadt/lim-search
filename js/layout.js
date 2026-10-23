// Shared (browser + Node) layout reconstruction from pdf.js textContent.
// Produces, per page: {n, w, h, lines:[{y, segs:[{x, x2, s}]}], text}
// text approximates `pdftotext -layout`: segments separated by >=2 spaces when there's a visual gap.
export function layoutPage(n, textContent, viewport) {
  const W = viewport.width, H = viewport.height;
  const items = [];
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], yb = it.transform[5];
    const fs = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
    items.push({ x, x2: x + it.width, y: H - yb, fs, s: it.str });
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    let ln = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 4; k--) {
      if (Math.abs(lines[k].y - it.y) <= Math.max(2, it.fs * 0.35)) { ln = lines[k]; break; }
    }
    if (!ln) { ln = { y: it.y, fs: it.fs, items: [] }; lines.push(ln); }
    ln.items.push(it);
  }
  lines.sort((a, b) => a.y - b.y);
  const CW = W / 130; // nominal character cell, ~4.6pt on A4
  const out = [];
  let prevY = null;
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    // merge into segments (items close together = same segment)
    const segs = [];
    for (const it of ln.items) {
      const last = segs[segs.length - 1];
      const gap = last ? it.x - last.x2 : Infinity;
      if (last && gap < Math.max(CW * 1.6, it.fs * 0.9)) {
        last.s += (gap > it.fs * 0.15 && !last.s.endsWith(' ') && !it.s.startsWith(' ') ? ' ' : '') + it.s;
        last.x2 = Math.max(last.x2, it.x2);
      } else segs.push({ x: it.x, x2: it.x2, s: it.s });
    }
    for (const s of segs) s.s = s.s.replace(/\s+/g, ' ').trim();
    // blank lines for vertical gaps (helps paragraph/block detection)
    if (prevY !== null) {
      const dy = ln.y - prevY;
      const blanks = Math.min(3, Math.max(0, Math.round(dy / (ln.fs * 1.25)) - 1));
      for (let b = 0; b < blanks; b++) out.push({ y: null, segs: [] });
    }
    prevY = ln.y;
    out.push({ y: Math.round(ln.y * 10) / 10, segs });
  }
  const text = out.map(l => {
    let str = '';
    for (const sg of l.segs) {
      const col = Math.round(sg.x / CW);
      if (str.length) str += ' '.repeat(Math.max(2, col - str.length)); else str += ' '.repeat(Math.max(0, Math.min(col, 40)));
      str += sg.s;
    }
    return str;
  }).join('\n');
  return { n, w: Math.round(W), h: Math.round(H), lines: out, text };
}
