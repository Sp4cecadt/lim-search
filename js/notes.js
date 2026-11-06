// Parse a Windows Notes (or similar) export into groups headed by manual section numbers,
// and match those groups to a defect card.
const NUM_RE = /\b(\d{1,2}(?:\.\d{1,3}){1,3})\b/g;

export function splitNotesText(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n');
  const blocks = [];
  let heading = '';
  let buf = [];
  const flush = () => {
    const body = buf.join('\n').replace(/^\n+|\n+$/g, '').trim();
    const h = heading.trim();
    if (h && body) {
      const nums = [];
      const seen = new Set();
      for (const m of h.matchAll(NUM_RE)) {
        if (!seen.has(m[1])) { seen.add(m[1]); nums.push(m[1]); }
      }
      blocks.push({
        heading: h.replace(/^#{1,6}\s+/, '').trim(),
        headingNorm: norm(h),
        nums,
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

export function notesForDefect(notes, d) {
  if (!notes || !notes.sections || !d) return [];
  const cardNum = d.num ? String(d.num) : '';
  const secNum = d.section ? String(d.section) : '';
  const titleN = norm(d.title);
  const secTitleN = norm(d.sectionTitle);
  const scored = [];
  for (const s of notes.sections) {
    if (!s.text) continue;
    let score = 0;
    const nums = s.nums || [];
    if (cardNum && nums.includes(cardNum)) score = Math.max(score, 300);
    if (secNum && nums.includes(secNum)) score = Math.max(score, 200);
    if (titleN && s.headingNorm) {
      if (s.headingNorm === titleN) score = Math.max(score, 280);
      else if (titleN.length > 8 && (s.headingNorm.includes(titleN) || titleN.includes(s.headingNorm))) score = Math.max(score, 240);
    }
    if (secNum && secTitleN && s.headingNorm && s.headingNorm.includes(secTitleN) && nums.includes(secNum)) {
      score = Math.max(score, 210);
    }
    if (score) scored.push({ score, heading: s.heading, text: s.text });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  return scored.filter(x => {
    const k = x.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
