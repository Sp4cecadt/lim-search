// Shared (browser + Node): filled rectangles on a page, from a pdf.js operator list.
// Used to read the coloured severity cells (Red = raise a defect, Grey = no defect; manual §1.1.3).
// Returns [{x0, y0, x1, y1, c:'#RRGGBB'}] in top-down page points (same space as layoutPage()).
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const hex2 = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
function toHex(a) {
  if (typeof a === 'string') return a.startsWith('#') ? a.toUpperCase() : null;
  if (a && typeof a[0] === 'string') return toHex(a[0]);
  if (a && a.length >= 3) return ('#' + hex2(a[0]) + hex2(a[1]) + hex2(a[2])).toUpperCase();
  return null;
}
export function fillRects(opList, OPS, viewport) {
  const H = viewport.height, out = [];
  let ctm = [1, 0, 0, 1, 0, 0], fill = '#000000', path = null;
  const stack = [];
  const FILL = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(x => x != null));
  const { fnArray: F, argsArray: A } = opList;
  for (let i = 0; i < F.length; i++) {
    const f = F[i], a = A[i];
    if (f === OPS.save) stack.push([ctm, fill]);
    else if (f === OPS.restore) { const s = stack.pop(); if (s) [ctm, fill] = s; }
    else if (f === OPS.transform) ctm = mul(ctm, a);
    else if (f === OPS.paintFormXObjectBegin) { stack.push([ctm, fill]); if (a && a[0] && a[0].length === 6) ctm = mul(ctm, a[0]); }
    else if (f === OPS.paintFormXObjectEnd) { const s = stack.pop(); if (s) [ctm, fill] = s; }
    else if (f === OPS.setFillRGBColor) fill = toHex(a) || fill;
    else if (f === OPS.setFillGray) { const g = Array.isArray(a) || (a && a.length) ? a[0] : a; fill = typeof g === 'string' ? toHex(g) : toHex([g * 255, g * 255, g * 255]); }
    else if (f === OPS.setFillColor || f === OPS.setFillColorN) { const h = toHex(a); if (h) fill = h; }
    else if (f === OPS.constructPath) path = a && a[2] ? a[2] : null; // [ops, coords, minMax]
    else if (FILL.has(f) && path) {
      const [x0, y0, x1, y1] = path; path = null;
      const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => H - p[1]);
      const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), c: fill };
      const w = r.x1 - r.x0, h = r.y1 - r.y0;
      if (w >= 6 && h >= 4 && w < viewport.width * 0.95 && fill && fill !== '#000000') out.push({ x0: +r.x0.toFixed(1), y0: +r.y0.toFixed(1), x1: +r.x1.toFixed(1), y1: +r.y1.toFixed(1), c: fill });
    } else if (f === OPS.endPath) path = null;
  }
  return out;
}
// Fill colour under a point (last-painted rectangle wins, as on the page).
export function colourAt(fills, x, y) {
  if (!fills) return null;
  for (let k = fills.length - 1; k >= 0; k--) { const r = fills[k]; if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r.c; }
  return null;
}
// Red / grey tone of a cell colour (see the manual key, section 1.1.3).
export function colourClass(c) {
  if (!c) return null;
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  if (r > 200 && r - g > 50 && r - b > 50 && Math.abs(g - b) < 25) return 'red';
  if (Math.max(r, g, b) - Math.min(r, g, b) <= 12 && r < 240) return 'grey';
  return 'other';
}
// Pages worth reading the drawings of: those with a severity-scale label at the start of a line.
export const HAS_LEVEL = /^(?:\d\s+)?(Extreme|Very High|High|Moderate|Low|Z Code)\b/;
