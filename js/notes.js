// Parse a Windows Notes (or similar) export into groups headed by manual section numbers,
// and match those groups to a defect card.
//
// Supports two layouts:
// 1) Photos-attached export (Shannon's Windows Notes cut-and-paste): ALL-CAPS titles,
//    phrase lines, then a "Photos attached … Page X of Y … 6.5" marker, then optional
//    Quick Code / Keywords / Notes. Section number is taken from that marker line.
// 2) Markdown / plain headings that START with a section number ("6.2 Standard Poles",
//    "## 6.2.1 …", "Section 6.2").
const NUM_RE = /\b(\d{1,2}(?:\.\d{1,3}){1,3})\b/g;
const NUM_ONE = /\b(\d{1,2}(?:\.\d{1,3}){1,3})\b/;
const PHOTOS_START = /^\s*Photos attached\b/i;

export function splitNotesText(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (hasPhotosAttachedLayout(raw)) return splitPhotosAttachedNotes(raw);
  return splitHeadingNotes(raw);
}

function hasPhotosAttachedLayout(raw) {
  let n = 0;
  for (const line of raw.split('\n')) {
    if (PHOTOS_START.test(line)) {
      n++;
      if (n >= 2) return true;
    }
  }
  return false;
}

function splitHeadingNotes(raw) {
  const lines = raw.split('\n');
  const blocks = [];
  let heading = '';
  let buf = [];
  const flush = () => {
    const body = buf.join('\n').replace(/^\n+|\n+$/g, '').trim();
    const h = heading.trim();
    if (h && body) {
      const nums = uniqNums(h);
      blocks.push({
        heading: h.replace(/^#{1,6}\s+/, '').trim(),
        headingNorm: norm(h),
        nums,
        titles: [],
        text: body
      });
    }
    heading = '';
    buf = [];
  };
  const isHeading = (line, next) => {
    const t = line.trim();
    if (!t || t.length > 160) return false;
    if (/^#{1,6}\s+\S/.test(t)) return true;
    if (next != null && /^[=-]{3,}\s*$/.test(String(next).trim()) && t.length < 120) return true;
    // "6.2 Standard Poles", "§6.2 …", "Section 6.2 …"
    if (/^(?:section\s+|§\s*)?\d{1,2}(?:\.\d{1,3}){1,3}\b/i.test(t)) return true;
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (isHeading(line, next)) {
      flush();
      heading = line.trim().replace(/^#{1,6}\s+/, '');
      if (next != null && /^[=-]{3,}\s*$/.test(String(next).trim())) i++;
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

function splitPhotosAttachedNotes(raw) {
  const lines = raw.split('\n');
  const markerIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (PHOTOS_START.test(lines[i])) markerIdxs.push(i);
  }
  const blocks = [];
  let prevNums = [];
  let cursor = 0;

  for (let m = 0; m < markerIdxs.length; m++) {
    const mi = markerIdxs[m];
    const nextMi = m + 1 < markerIdxs.length ? markerIdxs[m + 1] : lines.length;

    // Body lines for this entry run from cursor → marker (exclusive).
    // Skip leading blanks and chapter/section banners.
    let start = cursor;
    while (start < mi && (isBlank(lines[start]) || isBanner(lines[start]))) start++;

    const before = [];
    for (let i = start; i < mi; i++) before.push(lines[i]);

    // Trailing meta after the marker until the next entry starts (ALL-CAPS title,
    // next photos marker, or banner). Keep Quick Code / Keywords / Notes / severity.
    let metaEnd = mi + 1;
    while (metaEnd < nextMi) {
      const t = lines[metaEnd];
      if (isBlank(t)) {
        // Peek ahead: blank then ALL-CAPS / banner → end meta; else keep blanks inside meta.
        let k = metaEnd + 1;
        while (k < nextMi && isBlank(lines[k])) k++;
        if (k >= nextMi || isAllCapsTitle(lines[k]) || isBanner(lines[k]) || PHOTOS_START.test(lines[k])) break;
        metaEnd++;
        continue;
      }
      if (isBanner(t) || isAllCapsTitle(t) || PHOTOS_START.test(t)) break;
      metaEnd++;
    }
    const after = [];
    for (let i = mi + 1; i < metaEnd; i++) after.push(lines[i]);

    // Section numbers: marker line, then nearby lines, then inherit.
    let nums = numsFromPhotosLine(lines[mi]);
    if (!nums.length) {
      // e.g. section on the next annotation line: "Page 95 of 97-FUL TABLE\t8.7"
      for (let i = mi + 1; i < Math.min(mi + 3, metaEnd); i++) {
        const n = numsFromLooseLine(lines[i]);
        if (n.length) { nums = n; break; }
      }
    }
    if (!nums.length) {
      // e.g. "Reinstall to E-drawing standards\t\t10.2" on the line above the marker
      for (let i = mi - 1; i >= Math.max(start, mi - 3); i--) {
        const n = trailingNums(lines[i]);
        if (n.length) { nums = n; break; }
      }
    }
    if (!nums.length && prevNums.length) nums = prevNums.slice();
    if (nums.length) prevNums = nums.slice();

    const titles = extractAllCapsTitles(before);
    const heading = titles[0] || firstUsefulLine(before) || (nums[0] ? `Section ${nums[0]}` : 'Notes');

    // Display text: titles + phrases (verbatim), omit structural Photos marker,
    // keep Quick Code / Keywords / Notes / severity lines.
    const textParts = [];
    for (const l of before) textParts.push(l);
    for (const l of after) {
      // Drop pure banner lines that snuck into after (shouldn't), keep the rest.
      if (isBanner(l)) continue;
      textParts.push(l);
    }
    const text = textParts.join('\n').replace(/^\n+|\n+$/g, '').trim();
    if (!text && !titles.length) {
      cursor = metaEnd;
      continue;
    }

    blocks.push({
      heading,
      headingNorm: norm(heading),
      nums: nums.slice(),
      titles,
      text: text || heading
    });

    cursor = metaEnd;
  }
  return blocks;
}

function isBlank(line) {
  return !String(line || '').trim();
}

function isBanner(line) {
  const t = String(line || '').trim();
  if (!t || t.length > 160) return false;
  // "6. DISTRIBUTION SUPPORTS CONDITION", "7. INSULATORS CONDITION EXAMPLES"
  if (/^\d{1,2}\.\s+[A-Z][A-Z0-9 \/\-\&,]{6,}(?:CONDITION|EXAMPLES|SUPPORTS)\b/i.test(t)) return true;
  if (/^\d{1,2}\.\s+[A-Z][A-Z0-9 \/\-\&,]{10,}$/.test(t) && !/[a-z]/.test(t)) return true;
  // "10.2 Pole Top Transformers, Page 33 of 110"
  if (/^\d{1,2}(?:\.\d{1,3})+\s+.+,?\s*Page\s+\d+/i.test(t)) return true;
  // "10.3 FUSES / DF BASES", "9.10 OTHER CONDUCTOR ATTACHMENTS", "10.6 UD TERMINATIONS"
  if (/^\d{1,2}(?:\.\d{1,3})+\s+[A-Z][A-Z0-9 \/\-\&]{3,}$/.test(t) && !/[a-z]/.test(t)) return true;
  return false;
}

function isAllCapsTitle(line) {
  const t = String(line || '').trim();
  if (!t || t.length < 4 || t.length > 120) return false;
  if (PHOTOS_START.test(t)) return false;
  if (/^(?:Quick\s*Code|Keywords|Notes|Date)\s*:/i.test(t)) return false;
  if (isBanner(t)) return false;
  // Must be predominantly uppercase letters (allow digits, %, *, /, (), -, commas, quotes).
  if (/[a-z]/.test(t)) return false;
  if (!/[A-Z]/.test(t)) return false;
  // Reject lines that are only punctuation/numbers.
  const letters = (t.match(/[A-Z]/g) || []).length;
  if (letters < 3) return false;
  // Reject severity dumps like "VERY HIGH   SERV > PTJB ..."
  if (/^(?:EXTREME|VERY\s+HIGH|HIGH|MODERATE|LOW|MINOR)\b/.test(t) && t.length < 40) return false;
  return true;
}

function extractAllCapsTitles(beforeLines) {
  const titles = [];
  let i = 0;
  while (i < beforeLines.length && isBlank(beforeLines[i])) i++;
  while (i < beforeLines.length && isAllCapsTitle(beforeLines[i])) {
    titles.push(beforeLines[i].trim());
    i++;
    while (i < beforeLines.length && isBlank(beforeLines[i])) i++;
  }
  return titles;
}

function firstUsefulLine(beforeLines) {
  for (const l of beforeLines) {
    const t = String(l || '').trim();
    if (t && !isBanner(t)) return t.slice(0, 120);
  }
  return '';
}

function uniqNums(s) {
  const nums = [];
  const seen = new Set();
  for (const m of String(s || '').matchAll(NUM_RE)) {
    if (!seen.has(m[1])) { seen.add(m[1]); nums.push(m[1]); }
  }
  return nums;
}

function numsFromPhotosLine(line) {
  // Collect dotted section numbers; ignore undotted page numbers ("Page 29 of 215").
  // Prefer numbers that appear after "Page X of Y" when present; otherwise all dotted nums.
  // For "6.10/10.10" keep both.
  return uniqNums(line);
}

function numsFromLooseLine(line) {
  const t = String(line || '').trim();
  if (!t) return [];
  // Prefer a trailing dotted number on annotation lines after the marker.
  const all = uniqNums(t);
  if (!all.length) return [];
  // If the line is mostly a page reference plus a section, take the last.
  if (/Page\s+\d+/i.test(t) || /\bFUL\b/i.test(t) || /STRUCTURE/i.test(t)) return [all[all.length - 1]];
  return all;
}

function trailingNums(line) {
  const t = String(line || '').trim();
  if (!t) return [];
  // Trailing "…. 10.2" or tab-separated section at end of a phrase line.
  const m = t.match(/(\d{1,2}(?:\.\d{1,3}){1,3})\s*$/);
  return m ? [m[1]] : [];
}

export function notesForDefect(notes, d) {
  if (!notes || !notes.sections || !d) return [];
  const cardNum = d.num ? String(d.num) : '';
  const secNum = d.section ? String(d.section) : '';
  const titleN = norm(d.title);
  const secTitleN = norm(d.sectionTitle);
  const scored = [];
  for (let si = 0; si < notes.sections.length; si++) {
    const s = notes.sections[si];
    if (!s.text) continue;
    let score = 0;
    const nums = s.nums || [];
    if (cardNum && nums.includes(cardNum)) score = Math.max(score, 300);
    if (secNum && nums.includes(secNum)) score = Math.max(score, 200);
    // Title ranking against the heading and every ALL-CAPS title in the block.
    const candidates = [s.headingNorm, ...(s.titles || []).map(norm)].filter(Boolean);
    let bestTitle = 0;
    for (const c of candidates) {
      bestTitle = Math.max(bestTitle, titleMatchBonus(titleN, c));
    }
    if (bestTitle) {
      // With a section/num hit, title bonus floats the best paste above a bare dump.
      // Without a section hit, only strong title matches count (avoids "damaged"/"pole"
      // leaking 10.10 fuse-box notes onto a 6.2.1 pole card).
      if (score >= 200) score += bestTitle;
      else if (bestTitle >= 50) score = Math.max(score, 100 + bestTitle);
    }
    if (secNum && secTitleN && s.headingNorm && s.headingNorm.includes(secTitleN) && nums.includes(secNum)) {
      score = Math.max(score, 210);
    }
    if (score) scored.push({ score, heading: s.heading, text: s.text, si });
  }
  scored.sort((a, b) => b.score - a.score || a.heading.localeCompare(b.heading));
  const seen = new Set();
  return scored.filter(x => {
    const k = x.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function titleMatchBonus(cardTitleNorm, noteTitleNorm) {
  if (!cardTitleNorm || !noteTitleNorm) return 0;
  if (cardTitleNorm === noteTitleNorm) return 80;
  if (cardTitleNorm.length > 8 && noteTitleNorm.length > 8) {
    if (cardTitleNorm.includes(noteTitleNorm) || noteTitleNorm.includes(cardTitleNorm)) return 50;
  }
  const stop = new Set(['a', 'an', 'the', 'to', 'of', 'or', 'and', 'for', 'in', 'on', 'with', 'from']);
  const ta = cardTitleNorm.split(' ').filter(t => t && !stop.has(t));
  const tb = noteTitleNorm.split(' ').filter(t => t && !stop.has(t));
  if (ta.length < 2 || tb.length < 2) return 0;
  const sb = new Set(tb);
  const hit = ta.filter(t => sb.has(t)).length;
  const ratio = hit / Math.min(ta.length, tb.length);
  if (ratio >= 0.8 && hit >= 3) return 50;
  if (ratio >= 0.7 && hit >= 2) return 35;
  if (ratio >= 0.5 && hit >= 2) return 20;
  return 0;
}

export async function parseNotesFile(file) {
  const text = await readNotesFile(file);
  const sections = splitNotesText(text);
  return {
    fileName: file.name || 'notes',
    size: file.size || 0,
    loadedAt: Date.now(),
    sections
  };
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function readNotesFile(file) {
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  if (name.endsWith('.docx') || type.includes('wordprocessingml')) return textFromDocx(file);
  if (name.endsWith('.pdf') || type.includes('pdf')) return textFromPdf(file);
  const buf = await file.arrayBuffer();
  const text = decodeBytes(new Uint8Array(buf));
  if (name.endsWith('.rtf') || type.includes('rtf') || text.trimStart().startsWith('{\\rtf')) return stripRtf(text);
  if (name.endsWith('.html') || name.endsWith('.htm') || type.includes('html')) return htmlToText(text);
  return text;
}

function decodeBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.slice(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('h1,h2,h3,h4').forEach(h => {
    h.insertAdjacentText('afterbegin', '# ');
  });
  return (doc.body && doc.body.innerText) || '';
}

function stripRtf(s) {
  return String(s)
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\'[0-9a-fA-F]{2}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)))
    .replace(/\\[a-z]+\-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function textFromPdf(file) {
  const { openPdf } = await import('./pdfload.js');
  const doc = await openPdf(file);
  const parts = [];
  try {
    for (let i = 1; i <= (doc.numPages || 0); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let line = '', lastY = null;
      for (const it of tc.items || []) {
        const y = it.transform && it.transform[5];
        if (lastY != null && y != null && Math.abs(y - lastY) > 2) {
          parts.push(line);
          line = '';
        }
        line += (it.str || '');
        lastY = y;
      }
      if (line) parts.push(line);
    }
  } finally {
    try { await doc.destroy(); } catch (_) {}
  }
  return parts.join('\n');
}

async function textFromDocx(file) {
  const xml = await unzipEntryText(await file.arrayBuffer(), 'word/document.xml');
  return xml
    .replace(/<w:tab\b[^/]*\/>/g, '\t')
    .replace(/<w:br\b[^/]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function unzipEntryText(buf, innerPath) {
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);
  let i = 0;
  while (i < u8.length - 30) {
    if (view.getUint32(i, true) !== 0x04034b50) { i++; continue; }
    const method = view.getUint16(i + 8, true);
    const flags = view.getUint16(i + 6, true);
    const compSize = view.getUint32(i + 18, true);
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(u8.subarray(i + 30, i + 30 + nameLen));
    const start = i + 30 + nameLen + extraLen;
    if (name === innerPath) {
      if (flags & 0x8) throw new Error('docx uses a data descriptor; save as .txt or .md instead');
      const data = u8.subarray(start, start + compSize);
      if (method === 0) return new TextDecoder('utf-8').decode(data);
      if (method === 8) {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        await writer.write(data);
        await writer.close();
        const out = await new Response(ds.readable).arrayBuffer();
        return new TextDecoder('utf-8').decode(out);
      }
      throw new Error('unsupported compression');
    }
    i = start + (compSize || 0);
  }
  throw new Error('document.xml not found');
}
