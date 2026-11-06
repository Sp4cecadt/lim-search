import * as store from './js/store.js';
import { buildIndex, search, hasWord } from './js/search.js';
import { initSwipe } from './js/swipe.js';
import { parseNotesFile, notesForDefect as matchNotes } from './js/notes.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let DATA = null, ENG = null, META = null, HAS_PDF = false, NOTES = null;
let PHOTOS = new Set(), PHMETA = null; // example photo keys "<defectId>/<exampleIndex>" stored on this phone
const phURL = new Map();

// ---------------- data loading ----------------
async function loadData() {
  try { NOTES = await store.get('defectNotes'); } catch (e) { NOTES = null; }
  try {
    const d = await store.get('manual');
    if (d) { setData(d, await store.get('meta')); HAS_PDF = !!(await store.get('pdfInfo')); await loadPhotoKeys(); return; }
  } catch (e) { console.warn('IDB', e); }
  // optional pre-built data shipped with a private build
  try {
    const r = await fetch('data/manual.json', { cache: 'no-cache' });
    if (r.ok) {
      const d = await r.json();
      const meta = { source: 'bundled (pre-built on the box)', loadedAt: new Date().toISOString() };
      try { await store.set('manual', d); await store.set('meta', meta); } catch (e) {}
      setData(d, meta); await loadPhotoKeys(); return;
    }
  } catch (e) {}
  setData(null, null);
}
async function loadPhotoKeys() {
  try { PHOTOS = new Set(await store.photoKeys()); PHMETA = await store.get('photoMeta'); } catch (e) { PHOTOS = new Set(); PHMETA = null; }
  if (PHMETA && META && PHMETA.forLoadedAt !== META.loadedAt) PHMETA = null; // photos from an older manual (shouldn't happen: cleared on update)
}
function resetPhotoURLs() { for (const u of phURL.values()) URL.revokeObjectURL(u); phURL.clear(); }
function setData(d, meta) {
  DATA = d; META = meta; ENG = d ? buildIndex(d) : null;
  $('#ver').textContent = d ? `${d.meta.title.replace('Line Inspection Manual', 'LIM')}${d.meta.issued ? ' · ' + d.meta.issued : ''}` : 'no manual loaded';
}

// ---------------- helpers ----------------
const lvClass = l => 'lv-' + String(l || '').replace(/\s+/g, '');
// Severity cell colours copied from the manual's own cell shading (scale[].c, read from the PDF drawings).
// Severity cell colour helpers: the colour comes from the uploaded PDF (see the manual key, section 1.1.3).
const hexRGB = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const sevTone = c => { if (!c || !/^#[0-9A-F]{6}$/i.test(c)) return null; const [r, g, b] = hexRGB(c);
  if (r > 200 && r - g > 50 && r - b > 50 && Math.abs(g - b) < 25) return 'red'; if (Math.max(r, g, b) - Math.min(r, g, b) <= 12 && r < 240) return 'grey'; return 'other'; };
const cellCls = c => { const t = sevTone(c); return t ? ' sevc sev-' + t : (c === undefined ? ' sevc sev-none' : ''); };
function cellStyle(c) {
  if (!c || !/^#[0-9A-F]{6}$/i.test(c)) return '';
  const [r, g, b] = hexRGB(c); const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return ` style="background:${c};color:${L > 0.55 ? '#1a1a1a' : '#fff'}" title="Manual cell colour ${c}"`;
}
function sevKey(d) {
  if (!(+((DATA && DATA.meta && DATA.meta.extractorVersion) || 0) >= 1.2)) return `<div class="sevkey small muted">Cell colours not read from your manual yet. They’re added automatically from the stored PDF (Manual tab). Until then, check the colour on the card’s page.</div>`;
  const t = new Set(d.scale.map(s => sevTone(s.c)));
  const bits = [];
  if (t.has('red')) bits.push('<span class="sevsw" style="background:#FFA29B"></span> Red = raise a defect');
  if (t.has('grey')) bits.push('<span class="sevsw" style="background:#AEAAAA"></span> Grey = no defect');
  if (t.has(null)) bits.push('<span class="sevsw" style="background:transparent"></span> no shading in the manual');
  const zc = d.scale.find(s => s.level === 'Z Code' && s.c);
  if (zc) bits.push(`<span class="sevsw" style="background:${zc.c}"></span> Z Code row as shaded in the manual`);
  if (d.scale.some(s => sevTone(s.c) === 'other' && !(zc && s.c === zc.c))) bits.push('other colours as printed');
  return bits.length ? `<div class="sevkey small muted">${bits.join(' · ')} <span class="nowrap">(manual key §1.1.3, ${pageLink(10)})</span></div>` : '';
}
const pageLink = (p, label) => `<a class="pg" href="#/page/${p}">p.${p}${label ? ` <small>(${esc(label)})</small>` : ''}</a>`;
function hl(text, terms) {
  let h = esc(text);
  const ws = [...new Set(terms.map(t => t.toLowerCase()).filter(t => t.length > 1))].sort((a, b) => b.length - a.length);
  if (!ws.length) return h;
  const re = new RegExp('\\b(' + ws.map(w => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|') + ')', 'gi');
  return h.replace(re, '<mark class="hit">$1</mark>');
}
function snippet(text, terms, len = 260) {
  const low = text.toLowerCase(); let pos = -1;
  for (const t of terms) { const i = low.search(new RegExp('\\b' + t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  if (pos < 0) pos = 0;
  const a = Math.max(0, pos - 90), b = Math.min(text.length, a + len);
  return (a > 0 ? '… ' : '') + text.slice(a, b).replace(/\n{2,}/g, '\n') + (b < text.length ? ' …' : '');
}
const passage = id => DATA && DATA.passages.find(p => p.id === id);
function recent() { try { return JSON.parse(localStorage.getItem('recent') || '[]'); } catch (e) { return []; } }
const RECENT_STORE_CAP = 200; // keep a long history in storage; on-screen list is capped by layout fit
function addRecent(q) {
  q = q.trim(); if (q.length < 2) return;
  const r = [q, ...recent().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_STORE_CAP);
  localStorage.setItem('recent', JSON.stringify(r));
}

/** Collapsible section: heading looks like h2; body toggles open/closed. Default closed (pass open=true to start open, e.g. Defect cards). */
function secfold(titleHtml, bodyHtml, open = false) {
  const keep = open ? ' secfold-keepopen' : '';
  return `<details class="secfold${keep}"${open ? ' open' : ''}><summary>${titleHtml}</summary><div class="secfold-body">${bodyHtml}</div></details>`;
}
/** Force-close secfolds after render (Safari can restore open). Skip .secfold-keepopen (Defect cards). */
function closeSecfolds(root = view) {
  if (!root) return;
  root.querySelectorAll('details.secfold:not(.secfold-keepopen)').forEach(d => { d.open = false; });
}
/** How many recent chips fit between the header and bottom tabs with wrapping rows (display-only; storage is untouched). */
function recentFitCount() {
  const headerH = document.getElementById('top')?.getBoundingClientRect().height || 0;
  const tabsH = document.getElementById('tabs')?.getBoundingClientRect().height || 50;
  const pad = 24; // main#view padding top+bottom
  const heading = 48; // "Recent searches" h2
  const avail = Math.max(0, window.innerHeight - headerH - tabsH - pad - heading);
  const list = document.querySelector('.recent-list');
  const chips = list ? [...list.querySelectorAll('[data-q]')] : [];
  const listW = (list?.getBoundingClientRect().width) || Math.max(200, window.innerWidth - 32);
  if (chips.length) {
    const listTop = list.getBoundingClientRect().top;
    let fit = 0;
    for (const c of chips) {
      if (c.getBoundingClientRect().bottom - listTop <= avail + 0.5) fit++;
      else break;
    }
    const rowH = chips[0].getBoundingClientRect().height + 8;
    const usedH = chips[fit ? fit - 1 : 0]
      ? (chips[Math.max(0, fit - 1)].getBoundingClientRect().bottom - listTop)
      : 0;
    // If everything painted still fits and there is room for another row, estimate extra capacity
    if (fit === chips.length && usedH + rowH <= avail + 0.5) {
      const widths = chips.map(c => c.getBoundingClientRect().width);
      const avgW = Math.max(48, widths.reduce((a, b) => a + b, 0) / widths.length + 8);
      const perRow = Math.max(1, Math.floor(listW / avgW));
      const extraRows = Math.max(0, Math.floor((avail - usedH) / rowH));
      return fit + extraRows * perRow;
    }
    return fit;
  }
  // Cold estimate before first paint: wrapping rows × ~avg chip width
  const rowH = 52;
  const rows = Math.max(0, Math.floor(avail / rowH));
  const perRow = Math.max(1, Math.floor(listW / 100));
  return rows * perRow;
}

// ---------------- defect card ----------------
const SKYNET_ID = '3b498f46-4fb4-4a80-ba39-20249f15d21e';
function currentDefect() {
  const m = (location.hash || '').match(/^#\/d\/(\w+)/);
  return (m && ENG && ENG.byId.get(m[1])) || null;
}
function askSkynetText(d) {
  // One-line prefill only. Never include manual body/details/PDF text.
  let t;
  if (d && d.title) {
    const bits = [];
    if (d.zCode) bits.push('Z Code possible');
    if (d.breakdown) bits.push('Breakdown possible');
    if (d.priorityRange) bits.push(String(d.priorityRange).replace(/\s+/g, ' ').trim().slice(0, 80));
    else if (d.severityRange) bits.push('severity ' + String(d.severityRange).replace(/\s+/g, ' ').trim().slice(0, 60));
    t = `Help me with this LIM defect: ${d.title}.`;
    if (bits.length) t += ` Priority: ${bits.join('; ')}.`;
    t += ' What should I check and how should I record it?';
  } else {
    t = 'Help me with the LIM (Line Inspection Manual): searching defects, priorities (Z Code / Breakdown), compare photo/s to Lim photo/s and give opinion based on the LIM and relevent docs uploaded to LIM Search app';
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > 1000 ? t.slice(0, 997) + '…' : t;
}
function askSkynetLinks(d) {
  const text = askSkynetText(d);
  const q = `id=${SKYNET_ID}&text=${encodeURIComponent(text)}`;
  return { native: `grokbot://app/v1/prompt?${q}`, https: `https://cursor.com/grok-bot/link/v1/prompt?${q}`, text };
}
function openAskSkynet(d) {
  const { native, https } = askSkynetLinks(d == null ? currentDefect() : d);
  // Prefer the native deep link on iOS Home Screen / standalone; fall back to https if the app doesn't open.
  const started = Date.now();
  const goHttps = () => { if (document.visibilityState === 'visible' && Date.now() - started < 2500) location.href = https; };
  try { location.href = native; } catch (_) { location.href = https; return; }
  setTimeout(goHttps, STANDALONE || IS_IOS ? 900 : 200);
}

const NOTES_ACCEPT = '.txt,.md,.markdown,.text,.rtf,.html,.htm,.pdf,.docx,text/plain,text/markdown,text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function cardFileActions(d) {
  return `<div class="card-file-actions">
    <p class="muted small">Two separate uploads — they do not overwrite each other. Updating the Line Inspection Manual refreshes this card’s usual information from that PDF, exactly as the app already does. The notes file only fills the Notes section.</p>
    <label class="btn" for="card-pdf-${esc(d.id)}">📥 ${DATA ? 'Update line inspection manual' : 'Load line inspection manual'}</label>
    <input id="card-pdf-${esc(d.id)}" class="js-card-pdf" type="file" accept="application/pdf,.pdf" hidden>
    <label class="btn" for="card-notes-${esc(d.id)}">📥 ${NOTES ? 'Replace notes file' : 'Upload notes file'}</label>
    <input id="card-notes-${esc(d.id)}" class="js-card-notes" type="file" accept="${NOTES_ACCEPT}" hidden>
    <div class="js-update-prog"></div>
  </div>`;
}
async function saveNotesFile(file) {
  const parsed = await parseNotesFile(file);
  await store.persist();
  await store.set('defectNotes', parsed);
  NOTES = parsed;
  return parsed;
}
function afterNotesSaved(parsed) {
  const n = (parsed.sections || []).length;
  const msg = n
    ? `✅ Loaded ${n} note group${n === 1 ? '' : 's'} from ${parsed.fileName}. This only fills the Notes section — the Line Inspection Manual is unchanged.`
    : `Loaded ${parsed.fileName}, but no section headings were found. Use headings like “6.2 Standard Poles”. The Line Inspection Manual is unchanged.`;
  if (location.hash.startsWith('#/manual')) renderManual(msg);
  else { bg(msg); route(); }
}
function wireCardUploads(root = view) {
  root.querySelectorAll('.js-card-pdf').forEach(inp => {
    if (inp.dataset.wired === '1') return;
    inp.dataset.wired = '1';
    inp.addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) doUpdate(file);
    });
  });
  root.querySelectorAll('.js-card-notes').forEach(inp => {
    if (inp.dataset.wired === '1') return;
    inp.dataset.wired = '1';
    inp.addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try { afterNotesSaved(await saveNotesFile(file)); }
      catch (err) {
        console.warn('notes import', err);
        const msg = 'Couldn’t read that notes file. Try saving it from the Windows Notes app as a .txt or .md file. The Line Inspection Manual was not changed.';
        if (location.hash.startsWith('#/manual')) renderManual(msg);
        else bg(msg);
      }
    });
  });
}
function notesBody(d) {
  if (!NOTES || !NOTES.sections || !NOTES.sections.length) {
    return `<p class="muted small">No notes file on this phone yet. Use “Upload notes file” in Settings. That file only fills this Notes section — it does not change the Line Inspection Manual information on the card.</p>`;
  }
  const items = matchNotes(NOTES, d);
  if (!items.length) {
    const where = d.section ? ` (§${esc(d.section)}${d.sectionTitle ? ' ' + esc(d.sectionTitle) : ''})` : '';
    return `<p class="muted small">No notes in “${esc(NOTES.fileName || 'your file')}” matched this card${where}. Headings in the file should use the manual’s section numbers, for example “6.2 Standard Poles”.</p>`;
  }
  return items.map(it => `<div class="ex note-entry" data-note-si="${it.si}">
      <div class="pre small" data-note-hold="${it.si}">${esc(it.text)}</div>
      <div class="note-actions">
        <button type="button" class="btn" data-edit-note="${it.si}">Edit</button>
        <button type="button" class="btn danger" data-del-note="${it.si}">Delete</button>
      </div>
    </div>`).join('')
    + `<button type="button" class="btn" data-copy-notes="${esc(d.id)}">Copy notes</button>`;
}
async function persistNotesLocal() {
  if (!NOTES) return;
  await store.set('defectNotes', NOTES);
}
function refreshNotesPopBody() {
  const el = document.getElementById('notes-pop');
  if (!el || el.hidden || notesPopId == null || popKind !== 'notes') return;
  const d = ENG && ENG.byId.get(notesPopId);
  const body = el.querySelector('.notes-pop-body');
  if (!d || !body) return;
  body.innerHTML = notesBody(d);
  bindNoteHold(body);
}
function startEditNote(si) {
  const el = document.getElementById('notes-pop');
  if (!el || !NOTES || !NOTES.sections || !NOTES.sections[si]) return;
  const entry = el.querySelector(`.note-entry[data-note-si="${si}"]`);
  if (!entry) return;
  const cur = NOTES.sections[si].text || '';
  entry.innerHTML = `<textarea class="note-edit" rows="8" aria-label="Edit note">${esc(cur)}</textarea>
    <div class="note-actions">
      <button type="button" class="btn pri" data-save-note="${si}">Save</button>
      <button type="button" class="btn" data-cancel-note="${si}">Cancel</button>
    </div>`;
  const ta = entry.querySelector('textarea');
  if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {} }
}
function bindNoteHold(root) {
  if (!root) return;
  let timer = null, si = null, moved = false;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; si = null; };
  root.querySelectorAll('[data-note-hold]').forEach(node => {
    const begin = e => {
      if (e.type === 'mousedown' && e.button !== 0) return;
      moved = false;
      si = +node.getAttribute('data-note-hold');
      timer = setTimeout(() => { const n = si; clear(); if (Number.isFinite(n)) startEditNote(n); }, 500);
    };
    const move = () => { moved = true; clear(); };
    const end = () => { clear(); };
    node.addEventListener('touchstart', begin, { passive: true });
    node.addEventListener('touchmove', move, { passive: true });
    node.addEventListener('touchend', end);
    node.addEventListener('touchcancel', end);
    node.addEventListener('mousedown', begin);
    node.addEventListener('mousemove', () => { if (timer) move(); });
    node.addEventListener('mouseup', end);
    node.addEventListener('mouseleave', end);
  });
}
let notesPopId = null, popKind = 'notes';
function closeNotesPop() {
  const el = document.getElementById('notes-pop');
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
    el.classList.remove('notes-pop-card');
    el.style.removeProperty('--notes-left');
    el.style.removeProperty('--notes-top');
    el.style.removeProperty('--notes-width');
    el.style.removeProperty('--notes-max-h');
  }
  document.querySelectorAll('.notes-btn-ph').forEach(ph => ph.remove());
  document.querySelectorAll('[data-open-notes].on,[data-open-lim].on').forEach(b => {
    b.classList.remove('on');
    b.style.zIndex = '';
    b.style.position = '';
    b.style.top = '';
    b.style.left = '';
    b.style.width = '';
    b.style.height = '';
    b.style.margin = '';
  });
  notesPopId = null;
}
/** Defect card immediately under a search-result Notes / LIM tools row. */
function cardUnderToolsBtn(btn) {
  const tools = btn && btn.closest('.defect-card-tools');
  if (!tools) return null;
  if (tools.classList.contains('defect-card-tools-heading')) {
    const body = document.getElementById('defect-cards-body');
    return body ? body.querySelector('.card') : null;
  }
  let n = tools.nextElementSibling;
  while (n && !n.classList.contains('card')) n = n.nextElementSibling;
  return n;
}
function openNotesPop(d, btn, kind = 'notes', limHtml = '') {
  let el = document.getElementById('notes-pop');
  if (!el) {
    el = document.createElement('div');
    el.id = 'notes-pop';
    el.className = 'notes-pop';
    el.hidden = true;
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      if (e.target.closest('[data-close-notes]')) { e.preventDefault(); closeNotesPop(); return; }
      const cn = e.target.closest('[data-copy-notes]');
      if (cn) { e.preventDefault(); copyNotesFor(cn); return; }
      const ed = e.target.closest('[data-edit-note]');
      if (ed) { e.preventDefault(); startEditNote(+ed.getAttribute('data-edit-note')); return; }
      const can = e.target.closest('[data-cancel-note]');
      if (can) { e.preventDefault(); refreshNotesPopBody(); return; }
      const sv = e.target.closest('[data-save-note]');
      if (sv) {
        e.preventDefault();
        const si = +sv.getAttribute('data-save-note');
        const entry = sv.closest('.note-entry');
        const ta = entry && entry.querySelector('textarea.note-edit');
        if (!NOTES || !NOTES.sections || !NOTES.sections[si] || !ta) return;
        const next = ta.value.replace(/\r\n/g, '\n');
        if (!next.trim()) {
          if (!confirm('This note is empty. Delete it?')) return;
          NOTES.sections.splice(si, 1);
        } else {
          NOTES.sections[si].text = next;
        }
        persistNotesLocal().then(refreshNotesPopBody).catch(err => console.warn('notes save', err));
        return;
      }
      const del = e.target.closest('[data-del-note]');
      if (del) {
        e.preventDefault();
        const si = +del.getAttribute('data-del-note');
        if (!NOTES || !NOTES.sections || !NOTES.sections[si]) return;
        if (!confirm('Delete this note? It will be removed from notes on this phone.')) return;
        NOTES.sections.splice(si, 1);
        persistNotesLocal().then(refreshNotesPopBody).catch(err => console.warn('notes delete', err));
      }
    });
  }
  notesPopId = d.id; popKind = kind;
  const card = btn ? cardUnderToolsBtn(btn) : null;
  if (btn) {
    const r = btn.getBoundingClientRect();
    // Spacer holds the flex slot so LIM details / heading row never reflow when Notes lifts above the scrim.
    document.querySelectorAll('.notes-btn-ph').forEach(ph => ph.remove());
    const ph = document.createElement('span');
    ph.className = 'notes-btn-ph';
    ph.setAttribute('aria-hidden', 'true');
    ph.style.width = r.width + 'px';
    ph.style.height = r.height + 'px';
    btn.parentNode.insertBefore(ph, btn);
    btn.classList.add('on');
    // Keep the Notes button above the scrim so a second tap toggles closed.
    btn.style.position = 'fixed';
    btn.style.top = r.top + 'px';
    btn.style.left = r.left + 'px';
    btn.style.width = r.width + 'px';
    btn.style.height = r.height + 'px';
    btn.style.zIndex = '30';
    btn.style.margin = '0';
  }
  if (card) {
    const cr = card.getBoundingClientRect();
    el.classList.add('notes-pop-card');
    el.style.setProperty('--notes-left', cr.left + 'px');
    el.style.setProperty('--notes-top', cr.top + 'px');
    el.style.setProperty('--notes-width', cr.width + 'px');
    // Cover the card; allow a bit more height if the card is short so notes stay usable.
    const maxH = Math.max(cr.height, Math.min(window.innerHeight * 0.55, 420));
    el.style.setProperty('--notes-max-h', maxH + 'px');
  } else {
    el.classList.remove('notes-pop-card');
    el.style.removeProperty('--notes-left');
    el.style.removeProperty('--notes-top');
    el.style.removeProperty('--notes-width');
    el.style.removeProperty('--notes-max-h');
  }
  el.hidden = false;
  const lbl = kind === 'lim' ? 'LIM details' : 'Notes';
  const barTitle = d.title ? `${lbl} · ${esc(d.title)}` : lbl;
  const bodyHtml = kind === 'lim' ? `<div class="pre lim-pop-pre">${limHtml}</div>` : notesBody(d);
  el.innerHTML = `<div class="notes-pop-scrim" data-close-notes></div>
    <div class="notes-pop-panel" role="dialog" aria-modal="true" aria-label="${lbl}">
      <div class="notes-pop-bar"><span class="t">${barTitle}</span><button type="button" class="btn" data-close-notes aria-label="Close">✕</button></div>
      <div class="notes-pop-body">${bodyHtml}</div>
    </div>`;
  if (kind === 'notes') bindNoteHold(el.querySelector('.notes-pop-body'));
}
function toggleNotesPop(d, btn, kind = 'notes', limHtml = '') {
  if (notesPopId === d.id && popKind === kind) { closeNotesPop(); return; }
  closeNotesPop();
  openNotesPop(d, btn, kind, limHtml);
}
function copyNotesFor(cn) {
  const id = cn.getAttribute('data-copy-notes');
  const d = ENG && ENG.byId.get(id);
  const items = (d && NOTES) ? matchNotes(NOTES, d) : [];
  const text = items.map(it => [it.heading, it.text].filter(Boolean).join('\n')).join('\n\n');
  (async () => {
    try {
      await navigator.clipboard.writeText(text);
      cn.textContent = 'Copied';
      setTimeout(() => { cn.textContent = 'Copy notes'; }, 1600);
    } catch (_) { cn.textContent = 'Couldn’t copy'; }
  })();
}
function defectCard(d, { open = false, terms = [], showNotes = true, showDetails = true } = {}) {
  const cls = d.zCode ? 'z' : d.breakdown ? 'bd' : '';
  const badges = [];
  if (d.kind !== 'Defect') badges.push(`<span class="b ${d.kind === 'Information Notification' ? 'if' : 'warn'}">${esc(d.kind)}</span>`);
  if (d.zCode) badges.push(`<span class="b z">Z Code possible</span>`);
  if (d.breakdown) badges.push(`<span class="b bd">Breakdown possible</span>`);
  const warn = [];
  if (d.zCode && !d.inZIndex) warn.push('This card allows a Z Code, but it isn’t listed in the Appendix 1 Z Code index. Check the card and the index.');
  if (d.inZIndex && !d.zCode) warn.push('Listed in the Appendix 1 Z Code index, but the card’s priority range doesn’t mention Z Code.');
  const rng = (txt, by) => by ? Object.entries(by).map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`).join('<br>') : esc(txt || '');
  const kv = [];
  if (d.severityRange) kv.push(['Severity', rng(d.severityRange, d.severityByBfra)]);
  if (d.priorityRange) kv.push(['Priority', rng(d.priorityRange, d.priorityByBfra)]);
  if (d.conditionRange) kv.push(['Condition', esc(d.conditionRange)]);
  if (d.quickCodes.length) {
    const g = new Map(); for (const q of d.quickCodes) { if (!g.has(q.group)) g.set(q.group, []); g.get(q.group).push(q.code); }
    kv.push(['Quick code', [...g].map(([grp, codes]) => `${grp ? `<div class="small muted">${esc(grp)} &gt;</div>` : ''}${codes.map(c => `<span class="qc">${esc(c)}</span>`).join(' ')}`).join('')]);
  }
  const scale = d.scale.length ? `<table class="scale">${(() => { let g = null, h = ''; for (const s of d.scale) { if (s.group && s.group !== g) { g = s.group; h += `<tr><td colspan="2" class="muted small"><b>${esc(g)}</b></td></tr>`; } h += `<tr><td class="l ${lvClass(s.level)}${cellCls(s.c)}"${cellStyle(s.c)}>${esc(s.level)}</td><td>${hl(s.text, terms).replace(/\[([^\]]*Z Code[^\]]*)\]/gi, '<span class="zt">[$1]</span>')}</td></tr>`; } return h; })()}</table>` : '';
  const refs = [`Card ${pageLink(d.page, d.pageLabel)}${d.endPage > d.page ? `–${d.endPage}` : ''}`];
  if (d.summaryPage) refs.push(`Summary table ${pageLink(d.summaryPage)}`);
  if (d.inZIndex) refs.push(`App. 1 Z index ${pageLink(d.inZIndex)}`);
  if (d.inBreakdownIndex) refs.push(`App. 3 Breakdown index ${pageLink(d.inBreakdownIndex)}`);
  const ex = d.examples.map((e, i) => ({ ...e, key: d.id + '/' + i })).filter(e => e.caption || e.tags.length);
  const nPh = ex.filter(e => PHOTOS.has(e.key)).length;
  return `<article class="card defect ${cls}">
    <div class="card-head">
      <h3><a href="#/d/${d.id}" style="color:inherit;text-decoration:none">${hl(d.title, terms)}</a></h3>
      ${showNotes ? `<button type="button" class="btn btn-notes" data-open-notes="${esc(d.id)}" aria-label="Notes">Notes</button>` : ''}
    </div>
    <div class="sec">§${esc(d.num || d.section)} ${esc(d.sectionTitle)} · ${pageLink(d.page, d.pageLabel)}</div>
    <div class="badges">${badges.join('')}</div>
    ${warn.map(w => `<div class="note">⚠️ ${esc(w)}</div>`).join('')}
    <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${scale}
    ${showDetails && d.details ? `<details ${open ? 'open' : ''}><summary>Details from the manual</summary><div class="pre">${hl(d.details, terms)}</div></details>` : ''}
    ${ex.length ? `<details class="phx" ${open ? 'open' : ''}><summary>${nPh ? '📷 ' : ''}Photo examples (${ex.length})</summary>${!PHOTOS.size ? `<div class="note small">The example photos aren’t on this phone yet. <a href="#/manual">Manual tab › Add photos</a></div>` : ''}${ex.map(e => `<div class="ex">${PHOTOS.has(e.key) ? `<button class="phb" data-ph="${e.key}" aria-label="Enlarge photo"><img data-phk="${e.key}" alt="Example photo from p.${e.p}"><span class="zoomi">⤢</span></button>` : ''}${hl(e.caption, terms)}<div>${e.tags.map(t => `<span class="tag ${t.k === 'Priority' && /z/i.test(t.v) ? 'zt' : ''}">${t.bfra ? esc(t.bfra) + ' ' : ''}${esc(t.k)}: ${esc(t.v)}</span>`).join('')} ${pageLink(e.p)}</div></div>`).join('')}</details>` : ''}
    ${d.summary ? `<details><summary>Section 5 summary table row</summary><div class="small muted">As printed in the condition summary table, ${pageLink(d.summary.p)}. Columns may run together.</div><dl class="kv"><dt>Quick code</dt><dd>${esc(d.summary.quickCode)}</dd><dt>Severity</dt><dd>${esc(d.summary.severity)}</dd></dl><div class="pre small">${hl(d.summary.details, terms)}</div></details>` : ''}
    ${d.kind === 'Summary table only' ? `<div class="note">There's no separate condition example page for this one. It's taken from the Section 5 summary table, ${pageLink(d.page)}, so check the page.</div>` : ''}
    <div class="small muted" style="margin-top:8px">${refs.join(' · ')}</div>
  </article>`;
}

// ---------------- views ----------------
function needData() {
  view.innerHTML = `<div class="card"><h3>Load your manual</h3><p>No manual is stored on this phone yet. Open the <b>Manual</b> tab and pick the Line Inspection Manual PDF. It's processed on the phone and never uploaded.</p><a class="btn pri" href="#/manual">Go to Manual</a></div>`;
}
const EXAMPLES = ['cracked crossarm', 'Z priority', 'stay wire broken', 'bird nest', 'king bolt missing', 'pole rust', 'vegetation clearance', 'how to record photos', 'hot joint', 'oil leak padmount'];
let lastQ = '';
function renderSearch(q) {
  if (!DATA) return needData();
  q = q ?? $('#q').value;
  if ($('#q').value !== q) $('#q').value = q;
  { const c = $('#qclear'); if (c) c.hidden = !$('#q').value; }
  lastQ = q;
  if (!q.trim()) {
    const all = recent();
    const fit = recentFitCount();
    const r = all.slice(0, fit); // newest first; oldest visible drops off when full — storage keeps the rest
    // Try/EXAMPLES gated off so Recent can use the space. Restore by uncommenting the Try block below.
    // const tryBlock = `<h2>Try</h2><div class="chips">${EXAMPLES.map(x => `<button class="chip" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div>`;
    // Recent is permanently open (plain h2 — not a secfold; never collapses).
    view.innerHTML = `${r.length ? `<h2>Recent searches</h2><div class="recent-list chips">${r.map(x => `<button class="chip" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
      <p class="muted small" style="margin-top:18px">Search runs on your phone and works offline. Results show the defect cards first (codes, priorities, severity scale), then everything else the manual says, with page numbers to check.</p>`;
    // After first paint, refine fit for wrapping layout (may need a couple passes)
    if (all.length) {
      let passes = 0;
      const refine = () => {
        const refined = Math.min(all.length, recentFitCount());
        const list = view.querySelector('.recent-list');
        const shown = list ? list.querySelectorAll('[data-q]').length : 0;
        if (refined !== shown) {
          const r2 = all.slice(0, refined);
          if (list) list.innerHTML = r2.map(x => `<button class="chip" data-q="${esc(x)}">${esc(x)}</button>`).join('');
          else if (r2.length) { renderSearch(''); return; }
          if (++passes < 3) requestAnimationFrame(refine);
        }
      };
      requestAnimationFrame(refine);
    }
    return;
  }
  const t0 = performance.now();
  const r = search(ENG, DATA, q);
  const terms = r.terms;
  let h = '';
  if (r.intents.z) h += zPanel();
  if (r.intents.breakdown) h += bdPanel();
  if (r.passages.length) h += secfold('From the recording rules', r.passages.map(p => `<div class="card"><b>${esc(p.title)}</b> · ${pageLink(p.page)}<div class="pre small" style="margin-top:6px">${hl(p.text, terms)}</div></div>`).join(''));
  if (r.defects.length) {
    const defectTools = (d, heading) => {
      const lim = d.details
        ? `<button type="button" class="btn btn-lim" data-open-lim="${esc(d.id)}" aria-label="LIM details">LIM details</button><template class="lim-tpl">${hl(d.details, terms)}</template>`
        : '';
      const notes = `<button type="button" class="btn btn-notes" data-open-notes="${esc(d.id)}" aria-label="Notes">Notes</button>`;
      return `<div class="defect-card-tools${heading ? ' defect-card-tools-heading' : ''}">${lim}${notes}</div>`;
    };
    const top = r.defects.slice(0, 2);
    let body = '';
    top.forEach((x, i) => {
      // First card's tools sit on the Defect cards heading row (outside body via wrapper).
      body += `<span class="dc-anchor" data-dc="${i}"></span>`;
      if (i > 0) body += defectTools(x.d, false);
      body += defectCard(x.d, { terms, open: false, showNotes: false, showDetails: false });
    });
    if (r.defects.length > 2) body += `<div class="card">${r.defects.slice(2).map((x, k) => `<a class="row" data-dc="${k + 2}" href="#/d/${x.d.id}"><span>${hl(x.d.title, terms)}<br><small>§${esc(x.d.section)} ${esc(x.d.sectionTitle)} · p.${x.d.page}</small></span><span>${x.d.zCode ? '<span class="b z">Z</span>' : ''}${x.d.breakdown ? ' <span class="b bd">BD</span>' : ''} ›</span></a>`).join('')}</div>`;
    const headingTools = defectTools(top[0].d, true);
    const defectTitle = `Defect cards ${r.mode === 'any' ? '<small>(partial match)</small>' : ''}`;
    // In-flow heading row: title + tools share one flex row; LIM details overlay sits on the card (see CSS).
    h += `<div class="defect-cards-block">` +
      `<div class="defect-cards-heading-row">` +
      `<button type="button" class="defect-cards-toggle" aria-expanded="true" aria-controls="defect-cards-body">${defectTitle}</button>` +
      `${headingTools}` +
      `</div>` +
      `<div class="defect-cards-body" id="defect-cards-body">${body}</div>` +
      `</div>`;
  }
  if (r.quickCodes.length) h += secfold('Quick codes (§14.2)', `<div class="card">${r.quickCodes.map(c => `<div class="row"><span><span class="qc">${esc(c.group ? c.group + ' > ' : '')}${hl(c.name, terms)}</span><br><small>${hl(c.desc, terms)}</small></span><span><span class="b">${esc(c.type)}</span> ${pageLink(c.p)}</span></div>`).join('')}</div>`);
  if (r.chunks.length) {
    h += secfold(`Other mentions (${r.chunks.length}${r.cmode === 'any' ? ', partial' : ''})`, r.chunks.map(x => `<div class="card mention"><div class="meta"><span>§${esc(x.c.sec)} ${esc(x.c.st)}</span>${pageLink(x.c.p, x.c.pl)}</div>
      <details><summary style="font-weight:400;color:var(--fg)"><span class="snip">${hl(snippet(x.c.text, terms), terms)}</span></summary><div class="pre">${hl(x.c.text, terms)}</div></details></div>`).join(''));
  }
  if (!h) h = `<div class="card">Nothing found for “${esc(q)}”. Try fewer or different words (e.g. “crossarm” instead of “x-arm brace rusted through”).</div>`;
  view.innerHTML = h + `<p class="muted small">${Math.round(performance.now() - t0)} ms · matched: ${r.concepts.map(c => esc(c[0])).join(', ')}</p>`;
  closeSecfolds();
  wireCardUploads();
}
function zPanel() {
  const p = passage('priorityscale'), dl = passage('deadlines');
  return `<div class="card defect z"><h3>Z Code (priority)</h3>
    ${p ? `<div class="pre small">${esc(p.text)}</div><div class="small">${pageLink(p.page)}</div>` : ''}
    ${dl ? `<details open><summary>Data entry deadlines</summary><div class="pre small">${esc(dl.text)}</div>${pageLink(dl.page)}</details>` : ''}
    <a class="btn" href="#/cheat">Full priorities cheat sheet and Z Code defect list ›</a></div>`;
}
function bdPanel() {
  const p = passage('breakdown');
  return p ? `<div class="card defect bd"><h3>Breakdown</h3><div class="pre small">${esc(p.text)}</div>${pageLink(p.page)}<br><a class="btn" href="tel:0884044499" style="margin-top:8px">📞 Dispatch 8404 4499</a></div>` : '';
}
let browseFilter = 'all';
function renderBrowse() {
  if (!DATA) return needData();
  const f = { all: () => true, z: d => d.zCode, bd: d => d.breakdown, if: d => d.kind !== 'Defect' }[browseFilter];
  const groups = new Map();
  for (const d of DATA.defects.filter(f)) { const k = d.section + ' ' + d.sectionTitle; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  const keys = [...groups.keys()].sort((a, b) => { const x = a.split(' ')[0].split('.').map(Number), y = b.split(' ')[0].split('.').map(Number); return x[0] - y[0] || (x[1] || 0) - (y[1] || 0); });
  const chip = (k, t) => `<button class="chip ${browseFilter === k ? 'on' : ''}" data-bf="${k}">${t}</button>`;
  view.innerHTML = `<div class="chips">${chip('all', 'All')}${chip('z', 'Z Code possible')}${chip('bd', 'Breakdown')}${chip('if', 'Info / guidance')}</div>
    <p class="muted small">${DATA.defects.filter(f).length} cards</p>
    ${keys.map(k => `<details class="card"><summary>${esc(k)} <small class="muted">&nbsp;(${groups.get(k).length})</small></summary>${groups.get(k).map(d => `<a class="row" href="#/d/${d.id}"><span>${esc(d.title)}<br><small>p.${d.page}</small></span><span>${d.zCode ? '<span class="b z">Z</span>' : ''}${d.breakdown ? ' <span class="b bd">BD</span>' : ''} ›</span></a>`).join('')}</details>`).join('')}
    ${secfold('Quick code list (§14.2)', `<input class="filter" id="qcf" placeholder="Filter quick codes…"><div id="qcl" class="card"></div>`)}
    ${secfold('Manual sections', `<div class="card">${DATA.toc.filter(t => !/^\d+$/.test(t.num) || true).map(t => `<a class="row" href="#/page/${t.from}"><span>${esc(t.num)} ${esc(t.title)}</span><small>p.${t.from}–${t.to}</small></a>`).join('')}</div>`)}`;
  const draw = () => { const v = ($('#qcf').value || '').toLowerCase(); $('#qcl').innerHTML = DATA.quickCodeTable.filter(c => !v || (c.name + ' ' + c.group + ' ' + c.desc + ' ' + c.type).toLowerCase().includes(v)).slice(0, 400).map(c => `<div class="row"><span><span class="qc">${esc(c.group ? c.group + ' > ' : '')}${esc(c.name)}</span><br><small>${esc(c.desc)}</small></span><span><span class="b">${esc(c.type)}</span> ${pageLink(c.p)}</span></div>`).join(''); };
  $('#qcf').addEventListener('input', draw); draw();
  closeSecfolds();
}
function renderCheat() {
  if (!DATA) return needData();
  const order = ['priorityscale', 'deadlines', 'priorityfield', 'fireconsequence', 'breakdown', 'severitydef', 'severityscale', 'probability', 'quickcode', 'description', 'notes', 'photos', 'systems', 'pfdsp'];
  const zs = DATA.defects.filter(d => d.zCode);
  const unmatched = DATA.zIndex.items.filter(i => !i.defect);
  view.innerHTML = `<div class="card defect bd"><h3>Urgent / Breakdown</h3><a class="btn pri" href="tel:0884044499">📞 Dispatch 8404 4499</a> <span class="muted small">(number as printed in the manual, ${pageLink((passage('breakdown') || {}).page || 1409)})</span></div>
    ${order.map(passage).filter(Boolean).map(p => `<details class="card" ${['priorityscale', 'deadlines', 'priorityfield'].includes(p.id) ? 'open' : ''}><summary>${esc(p.title)}</summary><div class="pre small">${esc(p.text)}</div><div class="small">${p.pages.map(n => pageLink(n)).join(' ')}</div></details>`).join('')}
    ${secfold(`Cards where Z Code is possible (${zs.length})`, `<div class="card">${zs.map(d => `<a class="row" href="#/d/${d.id}"><span>${esc(d.title)}<br><small>§${esc(d.section)} · p.${d.page} · ${esc((d.priorityByBfra && (d.priorityByBfra['H/MBFRA'] || d.priorityByBfra.HBFRA)) || d.priorityRange || '')}</small></span><span>${d.inZIndex ? '' : '<span class="b warn">not in App.1</span>'} ›</span></a>`).join('')}</div>`)}
    ${unmatched.length ? secfold('Appendix 1 entries without a matching card', `<div class="card">${unmatched.map(i => `<div class="row"><span>${esc(i.secNum || '')} ${esc(i.secTitle || '')} – ${esc(i.name)}</span>${pageLink(i.page)}</div>`).join('')}</div>`) : ''}
    <p class="muted small">Everything above is copied from the manual. Tap a page number to check it.</p>`;
  closeSecfolds();
}
function photoStatus() {
  const m = DATA && DATA.meta;
  if (!m) return '';
  const needNewExtract = !(+m.extractorVersion >= 1.1);
  const cards = new Set([...PHOTOS].map(k => k.split('/')[0])).size;
  if (PHOTO_RUN) return `<p class="small">📷 Extracting photos now… see progress below.</p>`;
  if (PHMETA && PHMETA.status === 'done') return `<p class="small">📷 <b>${PHOTOS.size} example photos</b> for ${cards} cards (${(PHMETA.bytes / 1e6).toFixed(0)} MB, took ${Math.round(PHMETA.ms / 1000)} s).</p>`;
  const why = PHOTOS.size ? `Photo extraction stopped part-way (${PHOTOS.size} photos so far).` : needNewExtract ? 'This manual was loaded with an older version of the app, so it has no example photos yet.' : 'No example photos stored yet.';
  return `<div class="note">📷 ${why} ${HAS_PDF ? '' : 'Pick the PDF again with the button above to add them.'}</div>
    ${HAS_PDF ? `<button class="btn pri" id="addph">📷 ${PHOTOS.size && !needNewExtract ? 'Finish adding photos' : 'Add photos'} (uses the PDF already on this phone)</button>` : ''}`;
}
function appearanceCard() {
  const T = window.LIMTheme; if (!T) return '';
  const m = T.mode(), sc = T.scheme();
  const modes = [['light', '☀️ Light'], ['dark', '🌙 Dark'], ['system', '📱 System']];
  return `<div class="card" id="appearance"><h3>Appearance</h3>
    <div class="seg" role="group" aria-label="Light or dark">${modes.map(([v, l]) => `<button type="button" data-m="${v}" aria-pressed="${m === v}">${l}</button>`).join('')}</div>
    <p class="small muted" style="margin:4px 0 12px">System follows your iPhone’s Light/Dark setting (Settings › Display &amp; Brightness).</p>
    <div class="small muted" style="font-weight:600">Colour scheme</div>
    <div class="swatches" role="group" aria-label="Colour scheme">${T.SCHEMES.map(s => `<button type="button" class="sw" data-s="${s.id}" aria-pressed="${sc === s.id}"><span class="dots"><i style="background:${s.dk}"></i><i style="background:${s.lt}"></i></span><span>${s.name}${s.sub ? `<small class="swsub">${s.sub}</small>` : ''}</span></button>`).join('')}</div>
    <p class="small muted" style="margin:6px 0 0">Priority colours (Z Code red, Breakdown orange) stay the same in every scheme.</p></div>`;
}
function wireAppearance() {
  const c = $('#appearance'); if (!c) return;
  c.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.m) window.LIMTheme.setMode(b.dataset.m); else if (b.dataset.s) window.LIMTheme.setScheme(b.dataset.s); else return;
    c.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', x.dataset.m === window.LIMTheme.mode()));
    c.querySelectorAll('.sw').forEach(x => x.setAttribute('aria-pressed', x.dataset.s === window.LIMTheme.scheme()));
  });
}
async function renderManual(msg = '') {
  const est = await store.estimate();
  const m = DATA && DATA.meta;
  view.innerHTML = `<div class="card"><h3>Manual on this phone</h3>
    ${m ? `<dl class="kv"><dt>Manual</dt><dd>${esc(m.title)}</dd><dt>Issued</dt><dd>${esc(m.issued || 'not found on the cover')}</dd><dt>PDF pages</dt><dd>${m.numPages}</dd>
      <dt>File</dt><dd>${esc(META && META.fileName || META && META.source || '')}</dd>
      <dt>Loaded</dt><dd>${META && META.loadedAt ? new Date(META.loadedAt).toLocaleString('en-AU') : '?'}</dd>
      <dt>Contents</dt><dd>${DATA.defects.length} defect cards · ${DATA.quickCodeTable.length} quick codes · ${DATA.chunks.length} text passages</dd>
      <dt>Page view</dt><dd>${HAS_PDF ? 'PDF stored on this phone' : 'PDF not stored (page links can’t show the page)'}</dd></dl>` : '<p>No manual loaded yet.</p>'}
    ${msg ? `<div class="note">${msg}</div>` : ''}
    <label class="btn pri" for="pdffile">📥 ${m ? 'Update manual (pick new PDF)' : 'Load manual PDF'}</label>
    <input id="pdffile" type="file" accept="application/pdf,.pdf" hidden>
    <p class="muted small">Processing happens on the phone. The PDF isn’t uploaded anywhere. Reading the text of a 1,400-page manual takes about a minute, then the example photos are cut out of the PDF (a few more minutes; search works meanwhile). Keep the app open while it runs. A new version replaces the old text and photos.</p>
    ${photoStatus()}
    <div id="prog"></div></div>
    <div class="card"><h3>Defect notes</h3>
      ${NOTES ? `<dl class="kv"><dt>File</dt><dd>${esc(NOTES.fileName || '')}</dd>
        <dt>Loaded</dt><dd>${NOTES.loadedAt ? new Date(NOTES.loadedAt).toLocaleString('en-AU') : '?'}</dd>
        <dt>Groups found</dt><dd>${(NOTES.sections || []).length}</dd></dl>` : '<p>No notes file loaded yet.</p>'}
      <label class="btn pri" for="notesfile">📥 ${NOTES ? 'Replace notes file' : 'Upload notes file'}</label>
      <input id="notesfile" type="file" accept=".txt,.md,.markdown,.text,.rtf,.html,.htm,.pdf,.docx,text/plain,text/markdown,text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
      <p class="muted small">Upload the Windows Notes export you cut and paste when raising a defect. The text should be grouped under headings for each manual section (for example “6.2 Standard Poles”). It stays on this phone and isn’t sent anywhere. Matching notes then appear in the Notes section on each defect card, alongside the Line Inspection Manual information.</p>
      ${NOTES ? '<button class="btn danger" type="button" id="wipenotes">Remove notes file</button>' : ''}
    </div>
    ${appearanceCard()}
    <div class="card"><h3>Storage</h3><p class="small muted">${est ? `Using ${(est.usage / 1e6).toFixed(1)} MB of ${(est.quota / 1e6).toFixed(0)} MB available.` : ''}</p>
    <button class="btn danger" id="wipe">Delete manual from this phone</button></div>
    <p class="muted small">Extractor v${esc(m ? m.extractorVersion : '')}. Defect cards are built automatically from the manual's layout. Always check the page reference before relying on a code or priority.</p>`;
  wireAppearance();
  $('#pdffile').addEventListener('change', e => e.target.files[0] && doUpdate(e.target.files[0]));
  const nf = $('#notesfile');
  if (nf) nf.addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { afterNotesSaved(await saveNotesFile(file)); }
    catch (err) {
      console.warn('notes import', err);
      renderManual('Couldn’t read that notes file. Try saving it from the Windows Notes app as a .txt or .md file. The Line Inspection Manual was not changed.');
    }
  });
  const wn = $('#wipenotes');
  if (wn) wn.addEventListener('click', async () => {
    if (!confirm('Remove the notes file from this phone? Defect cards will keep their Line Inspection Manual information.')) return;
    await store.del('defectNotes');
    NOTES = null;
    renderManual('Notes file removed.');
  });
  const ap = $('#addph'); if (ap) ap.addEventListener('click', addPhotosFromStored);
  $('#wipe').addEventListener('click', async () => { if (!confirm('Delete the stored manual, photos and PDF from this phone?')) return; PHOTO_RUN = null; await store.del('manual'); await store.del('meta'); await store.del('pdf'); await store.del('pdfInfo'); await store.del('photoMeta'); await store.photoClear(); PHOTOS = new Set(); PHMETA = null; resetPhotoURLs(); HAS_PDF = false; setData(null, null); renderManual('Deleted.'); });
}
function docKind(f) {
  const t = (f.type || '').toLowerCase(), n = (f.name || '').toLowerCase();
  if (t.includes('pdf') || n.endsWith('.pdf')) return 'PDF';
  if (t.startsWith('image/') || /\.(png|jpe?g|webp|heic|gif)$/.test(n)) return 'Image';
  if (n.endsWith('.docx') || n.endsWith('.doc') || t.includes('word')) return 'Doc';
  return t ? t.split('/').pop().toUpperCase() : 'File';
}
function docIsPdf(f) {
  const t = (f.type || '').toLowerCase(), n = (f.name || '').toLowerCase();
  return t.includes('pdf') || n.endsWith('.pdf');
}
function docIsImage(f) {
  const t = (f.type || '').toLowerCase(), n = (f.name || '').toLowerCase();
  return t.startsWith('image/') || /\.(png|jpe?g|webp|heic|gif)$/.test(n);
}
/** Open a user Doc in the modal: images inline, PDFs via pdf.js, other types via blob link. */
async function showUserDoc(id) {
  closeNotesPop();
  const f = await store.docGet(id).catch(() => null);
  if (!f || !f.blob) return;
  const m = $('#modal'); m.hidden = false;
  const name = f.name || 'Document';
  const close = (urls = []) => {
    for (const u of urls) try { URL.revokeObjectURL(u); } catch (_) {}
    m.hidden = true; m.innerHTML = '';
  };
  if (docIsImage(f)) {
    const u = URL.createObjectURL(f.blob);
    m.innerHTML = `<div class="bar"><button class="btn" id="mx" type="button">✕</button><span class="t">${esc(name)}</span><button class="btn" id="mz" type="button">＋</button></div>
      <div class="body phbody" id="mbody"><img id="bigph" src="${u}" alt="${esc(name)}"></div>`;
    let z = 1; const img = $('#bigph');
    $('#mz').onclick = () => { z = z >= 3 ? 1 : z + 1; img.style.width = (100 * z) + '%'; $('#mz').textContent = z >= 3 ? '－' : '＋'; };
    $('#mx').onclick = () => close([u]);
    return;
  }
  if (docIsPdf(f)) {
    m.innerHTML = `<div class="bar"><button class="btn" id="mx" type="button">✕</button><span class="t" id="mt">${esc(name)}</span><button class="btn" id="mprev" type="button">‹</button><button class="btn" id="mnext" type="button">›</button><button class="btn" id="mz" type="button">＋</button></div><div class="body" id="mbody"><p class="muted">Loading…</p></div>`;
    const body = $('#mbody');
    let zoom = 1, pageN = 1, doc = null;
    $('#mx').onclick = () => { try { doc && doc.destroy(); } catch (_) {} close(); };
    try {
      const { openPdf } = await import('./js/pdfload.js');
      doc = await openPdf(f.blob);
      const total = doc.numPages || 1;
      const draw = async () => {
        $('#mt').textContent = `${name} · ${pageN}/${total}`;
        const pg = await doc.getPage(pageN);
        const w = Math.min(window.innerWidth - 20, 900) * zoom;
        const vp1 = pg.getViewport({ scale: 1 }); const scale = w / vp1.width; const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const vp = pg.getViewport({ scale: scale * dpr });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; c.style.width = (vp.width / dpr) + 'px';
        await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        body.innerHTML = ''; body.appendChild(c);
      };
      $('#mprev').onclick = () => { if (pageN > 1) { pageN--; draw(); } };
      $('#mnext').onclick = () => { if (pageN < total) { pageN++; draw(); } };
      $('#mz').onclick = () => { zoom = zoom >= 3 ? 1 : zoom + 1; draw(); };
      await draw();
    } catch (e) {
      body.innerHTML = `<div class="note">Couldn’t open this PDF: ${esc(e.message || e)}</div>`;
    }
    return;
  }
  const u = URL.createObjectURL(f.blob);
  m.innerHTML = `<div class="bar"><button class="btn" id="mx" type="button">✕</button><span class="t">${esc(name)}</span></div>
    <div class="body" id="mbody">
      <div class="card"><p>No in-app preview for this file type (${esc(docKind(f))}).</p>
      <p class="muted small">It is saved on this phone. Open or share it with another app:</p>
      <a class="btn pri" href="${u}" download="${esc(name)}">Download</a>
      <a class="btn" href="${u}" target="_blank" rel="noopener">Open</a></div>
    </div>`;
  $('#mx').onclick = () => close([u]);
}
async function fillDocPreviews(root = view) {
  for (const el of root.querySelectorAll('[data-doc-prev]')) {
    if (el.dataset.ready === '1') continue;
    const id = el.getAttribute('data-doc-prev');
    const f = await store.docGet(id).catch(() => null);
    if (!f || !f.blob) { el.innerHTML = '<span class="muted small">No preview</span>'; el.dataset.ready = '1'; continue; }
    if (docIsImage(f)) {
      const u = URL.createObjectURL(f.blob);
      el.innerHTML = `<img class="docprev-img" src="${u}" alt="">`;
      el.dataset.ready = '1';
      continue;
    }
    if (docIsPdf(f)) {
      try {
        const { openPdf } = await import('./js/pdfload.js');
        const doc = await openPdf(f.blob);
        const pg = await doc.getPage(1);
        const maxW = Math.min(el.clientWidth || (window.innerWidth - 72), 360);
        const vp1 = pg.getViewport({ scale: 1 });
        const scale = maxW / vp1.width;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const vp = pg.getViewport({ scale: scale * dpr });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        c.style.width = maxW + 'px';
        c.className = 'docprev-canvas';
        await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        el.innerHTML = ''; el.appendChild(c);
        try { await doc.destroy(); } catch (_) {}
      } catch (e) {
        el.innerHTML = '<span class="muted small">Preview unavailable</span>';
      }
      el.dataset.ready = '1';
      continue;
    }
    el.innerHTML = '<span class="muted small">No preview for this type</span>';
    el.dataset.ready = '1';
  }
}
let docPreviewTimer = 0;
function clearDocPreview() {
  clearTimeout(docPreviewTimer);
  docPreviewTimer = 0;
  view.querySelectorAll('.docprev').forEach(el => el.remove());
}
function scheduleDocPreviewDismiss() {
  clearTimeout(docPreviewTimer);
  docPreviewTimer = setTimeout(() => {
    docPreviewTimer = 0;
    view.querySelectorAll('.docprev').forEach(el => el.remove());
  }, 2800);
}
async function showInlineDocPreview(row, id) {
  if (!row || !id) return;
  view.querySelectorAll('.docprev').forEach(el => {
    if (el.getAttribute('data-doc-prev') !== id) el.remove();
  });
  if (!row.querySelector('[data-doc-prev]')) {
    const box = document.createElement('div');
    box.className = 'docprev';
    box.setAttribute('data-doc-prev', id);
    box.innerHTML = '<span class="muted small">Loading preview…</span>';
    const meta = row.querySelector('.docmeta');
    (meta || row).appendChild(box);
    await fillDocPreviews(row);
  }
  scheduleDocPreviewDismiss();
}
document.addEventListener('click', e => {
  if (!view.querySelector('.docprev')) return;
  if (e.target.closest('[data-doc]')) return;
  if (e.target.closest('[data-doc-del]')) return;
  clearDocPreview();
});
let DOC_SEC = 'work'; // 'work' = manuals; 'defect' = inspection info; 'mdms' = MDMS files
async function renderDocs(msg = '') {
  clearDocPreview();
  const all = (await store.docAll().catch(() => [])) || [];
  const files = all.filter(f => !f.section || f.section === DOC_SEC);
  files.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' }));
  const qfilter = (($('#q') && $('#q').value) || '').trim();
  const shown = qfilter ? files.filter(f => (f.name || '').toLowerCase().includes(qfilter.toLowerCase())) : files;
  const groupName = DOC_SEC === 'defect' ? 'inspection info' : DOC_SEC === 'mdms' ? 'MDMS files' : 'manuals';
  const rows = !files.length
    ? `<div class="card"><p class="muted">${all.length ? `No ${groupName} in this group yet. Add files while this group is selected.` : 'No docs on this phone yet. Add PDFs, screenshots, or other files — they stay on the device and aren’t uploaded.'}</p></div>`
    : !shown.length
    ? `<div class="card"><p class="muted">No docs match “${esc(qfilter)}”.</p></div>`
    : `<div class="card">${shown.map(f => {
        return `<div class="row docrow" role="button" tabindex="0" data-doc="${esc(f.id)}" aria-label="${esc(f.name)}">
          <div class="docmeta">
            <b class="docname">${esc(f.name)}</b>
          </div>
          <button type="button" class="btn danger" data-doc-del="${esc(f.id)}" aria-label="Delete ${esc(f.name)}">Delete</button>
        </div>`;
      }).join('')}</div>`;
  view.innerHTML = `<div class="card"><h3>Docs</h3>
    <div class="chips docsubs" role="tablist" aria-label="Doc groups">
      <button type="button" class="chip${DOC_SEC === 'work' ? ' on' : ''}" data-doc-sec="work" role="tab" aria-selected="${DOC_SEC === 'work'}">Manuals</button>
      <button type="button" class="chip${DOC_SEC === 'defect' ? ' on' : ''}" data-doc-sec="defect" role="tab" aria-selected="${DOC_SEC === 'defect'}">Inspection info</button>
      <button type="button" class="chip${DOC_SEC === 'mdms' ? ' on' : ''}" data-doc-sec="mdms" role="tab" aria-selected="${DOC_SEC === 'mdms'}">MDMS</button>
    </div>
    <p class="muted small">Your own files on this phone (not the Line Inspection Manual). Manuals is for manuals on how to work objects. Inspection info is for defect-related information. MDMS is a separate group for MDMS files. Files you add go into the selected group. Tap a name once for a thumbnail preview (it disappears on its own). Double-tap to open the file. Use the search bar to filter these files.</p>
    ${msg ? `<div class="note">${msg}</div>` : ''}
    <label class="btn pri" for="docsfile">📥 Add files</label>
    <input id="docsfile" type="file" multiple accept="application/pdf,.pdf,image/*,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
  </div>${rows}`;
  $('#docsfile').addEventListener('change', async e => {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    if (!list.length) return;
    await store.persist();
    let n = 0;
    for (const file of list) {
      const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try {
        await store.docPut(id, { id, name: file.name, type: file.type || '', size: file.size || 0, addedAt: Date.now(), section: DOC_SEC, blob: file });
        n++;
      } catch (err) { console.warn('doc save', err); }
    }
    if (location.hash.startsWith('#/docs')) renderDocs(n ? `✅ Added ${n} file${n === 1 ? '' : 's'}.` : 'Couldn’t save those files (storage full?).');
  });
  view.querySelectorAll('[data-doc-sec]').forEach(btn => btn.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    const sec = btn.getAttribute('data-doc-sec');
    if (sec === 'work' || sec === 'defect' || sec === 'mdms') { DOC_SEC = sec; renderDocs(); }
  }));
  view.querySelectorAll('[data-doc-del]').forEach(btn => btn.addEventListener('click', async e => {
    e.preventDefault(); e.stopPropagation();
    const id = btn.getAttribute('data-doc-del');
    const f = files.find(x => x.id === id);
    if (!confirm(`Delete “${f ? f.name : 'this file'}” from this phone?`)) return;
    await store.docDel(id);
    if (location.hash.startsWith('#/docs')) renderDocs('Deleted.');
  }));
  let lastDocTap = { id: null, t: 0 };
  view.querySelectorAll('[data-doc]').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('[data-doc-del]')) return;
      const id = row.getAttribute('data-doc');
      const now = Date.now();
      if (lastDocTap.id === id && now - lastDocTap.t < 400) {
        lastDocTap = { id: null, t: 0 };
        clearDocPreview();
        showUserDoc(id);
        return;
      }
      lastDocTap = { id, t: now };
      showInlineDocPreview(row, id);
    });
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); showUserDoc(row.getAttribute('data-doc')); }
      if (e.key === ' ') { e.preventDefault(); showInlineDocPreview(row, row.getAttribute('data-doc')); }
    });
  });
}
function diffSummary(oldD, newD) {
  if (!oldD) return '';
  const key = d => d.section + '|' + d.title.toLowerCase();
  const om = new Map(oldD.defects.map(d => [key(d), d])), nm = new Map(newD.defects.map(d => [key(d), d]));
  const added = [...nm.keys()].filter(k => !om.has(k)), removed = [...om.keys()].filter(k => !nm.has(k));
  const sig = d => JSON.stringify([d.severityRange, d.priorityRange, d.quickCodes, d.scale.map(s => [s.level, s.text, s.c || ''])]);
  const changed = [...nm.keys()].filter(k => om.has(k) && sig(om.get(k)) !== sig(nm.get(k)));
  const list = (a, m) => a.slice(0, 15).map(k => '• ' + esc(m.get(k).title) + ' (p.' + m.get(k).page + ')').join('<br>');
  return `<b>Changes vs previous version:</b> ${added.length} new, ${removed.length} removed, ${changed.length} changed cards.` +
    (added.length ? `<br><br><b>New:</b><br>${list(added, nm)}` : '') + (removed.length ? `<br><br><b>Removed:</b><br>${list(removed, om)}` : '') + (changed.length ? `<br><br><b>Changed:</b><br>${list(changed, nm)}` : '');
}
let PHOTO_RUN = null, UPGRADING = false;
const bg = t => { const e = $('#bgtask'); if (!e) return; e.hidden = !t; e.innerHTML = t || ''; };
async function doUpdate(file, { fromStored = false } = {}) {
  const prog = $('#prog') || view.querySelector('.js-update-prog');
  const showProg = html => { if (prog) prog.innerHTML = html; };
  PHOTO_RUN = null; // stop any photo run for the old manual
  // Reads only the Line Inspection Manual PDF. Does not read or write the notes file.
  showProg(`<p>Reading <b>${esc(file.name || 'stored PDF')}</b>…</p><progress id="pb" max="100" value="0"></progress><p id="pt" class="small muted"></p>`);
  let data, meta;
  try {
    await store.persist();
    const { extractFromPdf } = await import('./js/pdfload.js');
    const t0 = Date.now();
    data = await extractFromPdf(file, p => {
      const pb = $('#pb'), pt = $('#pt'); if (!pb) return;
      if (p.phase === 'text') { pb.value = Math.round(p.done / p.total * 90); pt.textContent = `Reading text: page ${p.done} of ${p.total}`; }
      else { pb.value = 95; pt.textContent = 'Finding defect cards, codes and priorities…'; }
    });
    const ok = data.defects.length >= 20;
    if (!ok && !confirm(`Only ${data.defects.length} defect cards were recognised. The layout may have changed, so search would mostly use plain text. Save anyway?`)) { showProg('<div class="note">Cancelled. Your previous manual is unchanged.</div>'); return; }
    meta = { source: 'loaded on this phone', fileName: file.name || (META && META.fileName), fileSize: file.size, loadedAt: new Date().toISOString(), ms: Date.now() - t0 };
    const diff = fromStored ? '' : diffSummary(DATA, data);
    await store.set('manual', data); await store.set('meta', meta);
    // the old manual's photos go as soon as the new text is saved
    await store.photoClear(); await store.set('photoMeta', { forLoadedAt: meta.loadedAt, status: 'running' }); PHOTOS = new Set(); resetPhotoURLs();
    let pdfMsg = '';
    if (!fromStored) try { await store.set('pdf', file); await store.set('pdfInfo', { name: file.name, size: file.size }); HAS_PDF = true; } catch (e) { pdfMsg = ' (Not enough space to keep the PDF for page view.)'; }
    setData(data, meta); PHMETA = await store.get('photoMeta');
    const done = `✅ Loaded ${esc(meta.fileName || '')} in ${Math.round(meta.ms / 1000)} s: ${data.defects.length} defect cards, ${data.quickCodeTable.length} quick codes, ${data.chunks.length} passages.${pdfMsg}${ok ? '' : ' ⚠️ Few cards were recognised, so search will mostly use plain text.'}${diff ? '<br><br>' + diff : ''}`;
    if (location.hash.startsWith('#/manual')) renderManual(done);
    else { bg('✅ Line inspection manual updated. Card information comes from that file, exactly as before. Your notes file was not changed.'); route(); }
  } catch (e) {
    console.error(e);
    const err = `Couldn’t read that PDF: ${esc(e.message || e)}. Your previous manual is unchanged.`;
    if (prog) prog.innerHTML = `<div class="note">${err}</div>`;
    else bg(err);
    return;
  }
  await runPhotos(file);
}
async function addPhotosFromStored() {
  const blob = await store.get('pdf'); if (!blob) return renderManual('The PDF isn’t stored on this phone. Pick it with the button above.');
  if (!(+DATA.meta.extractorVersion >= 1.1)) return doUpdate(blob, { fromStored: true }); // older data: re-read the text too (needs caption positions)
  return runPhotos(blob);
}
async function runPhotos(blob) {
  const run = PHOTO_RUN = {}; const forLoadedAt = META.loadedAt;
  const show = t => { bg(t); const pr = $('#prog'); if (pr && location.hash.startsWith('#/manual')) pr.innerHTML = `<p>${t}</p>`; };
  show('📷 Finding example photos…');
  try {
    const { extractPhotosFromPdf } = await import('./js/pdfload.js');
    const r = await extractPhotosFromPdf(blob, DATA, async (k, v) => { if (PHOTO_RUN !== run) throw new Error('stopped'); await store.photoPut(k, v); PHOTOS.add(k); },
      p => show(`📷 Adding example photos: ${Math.round(p.done / p.total * 100)}% (${p.n} photos)<br><progress max="${p.total}" value="${p.done}"></progress>`),
      () => PHOTO_RUN !== run, k => PHOTOS.has(k));
    if (PHOTO_RUN !== run) return;
    const all = await store.photoKeys(); let bytes = 0;
    for (const k of all) { const v = await store.photoGet(k); bytes += v && v.blob ? v.blob.size : 0; }
    PHMETA = { forLoadedAt, status: 'done', count: all.length, bytes, ms: r.ms };
    await store.set('photoMeta', PHMETA); PHOTO_RUN = null; bg('');
    if (location.hash.startsWith('#/manual')) renderManual(`✅ Added ${all.length} example photos (${(bytes / 1e6).toFixed(0)} MB) in ${Math.round(r.ms / 1000)} s.`);
  } catch (e) {
    if (PHOTO_RUN !== run) return;
    console.error(e); PHOTO_RUN = null; bg('');
    if (location.hash.startsWith('#/manual')) renderManual(`Photo extraction stopped: ${esc(e.message || e)}. Search still works. You can try again with “Finish adding photos”.`);
  }
}
// ---------------- photos: lazy load + enlarge ----------------
async function phSrc(k) {
  if (phURL.has(k)) return phURL.get(k);
  const v = await store.photoGet(k); if (!v || !v.blob) return null;
  const u = URL.createObjectURL(v.blob); phURL.set(k, u); return u;
}
async function hydratePhotos(root = view) {
  for (const img of root.querySelectorAll('details[open] img[data-phk]:not([src])')) { const u = await phSrc(img.dataset.phk); if (u) img.src = u; }
}
async function showPhoto(k) {
  const [did, i] = k.split('/'); const d = ENG && ENG.byId.get(did); const e = d && d.examples[+i];
  const u = await phSrc(k); if (!u) return;
  closeNotesPop();
  const m = $('#modal'); m.hidden = false;
  m.innerHTML = `<div class="bar"><button class="btn" id="mx">✕</button><span class="t">${esc(d ? d.title : '')}</span><button class="btn" id="mz">＋</button></div>
    <div class="body phbody" id="mbody"><img id="bigph" src="${u}" alt="Example photo"><div class="phcap">${esc(e ? e.caption : '')}<div>${e ? e.tags.map(t => `<span class="tag">${t.bfra ? esc(t.bfra) + ' ' : ''}${esc(t.k)}: ${esc(t.v)}</span>`).join('') : ''} ${e ? `<a class="pg" href="#/page/${e.p}">p.${e.p}</a>` : ''}</div></div></div>`;
  let z = 1; const img = $('#bigph');
  $('#mz').onclick = () => { z = z >= 3 ? 1 : z + 1; img.style.width = (100 * z) + '%'; $('#mz').textContent = z >= 3 ? '－' : '＋'; };
  $('#mx').onclick = () => { m.hidden = true; m.innerHTML = ''; };
}
// ---------------- PDF page viewer ----------------
let pdfDoc = null;
async function showPage(n) {
  closeNotesPop();
  const m = $('#modal'); m.hidden = false;
  const chunks = DATA ? DATA.chunks.filter(c => c.p === n) : [];
  m.innerHTML = `<div class="bar"><button class="btn" id="mx">✕</button><span class="t">PDF page ${n}</span><button class="btn" id="mprev">‹</button><button class="btn" id="mnext">›</button><button class="btn" id="mz">＋</button></div><div class="body" id="mbody"><p class="muted">Loading…</p></div>`;
  let zoom = 1;
  $('#mx').onclick = () => { m.hidden = true; m.innerHTML = ''; if (location.hash.startsWith('#/page/')) history.back(); };
  $('#mprev').onclick = () => n > 1 && (location.hash = '#/page/' + (n - 1));
  $('#mnext').onclick = () => (location.hash = '#/page/' + (n + 1));
  const body = $('#mbody');
  const textFallback = why => { body.innerHTML = `<div class="note">${why}</div>` + (chunks.length ? chunks.map(c => `<div class="card"><div class="pre">${esc(c.text)}</div></div>`).join('') : '<p class="muted">No text on this page (it may be a photo or diagram).</p>'); };
  const blob = HAS_PDF ? await store.get('pdf') : null;
  if (!blob) return textFallback('The PDF isn’t stored on this phone, so this is the page’s text only. Load the PDF in the Manual tab to see the actual page.');
  try {
    const { openPdf } = await import('./js/pdfload.js');
    if (!pdfDoc) pdfDoc = await openPdf(blob);
    const pg = await pdfDoc.getPage(n);
    const draw = async () => {
      const w = Math.min(window.innerWidth - 20, 900) * zoom;
      const vp1 = pg.getViewport({ scale: 1 }); const scale = w / vp1.width; const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = pg.getViewport({ scale: scale * dpr });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; c.style.width = (vp.width / dpr) + 'px';
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      body.innerHTML = ''; body.appendChild(c);
    };
    $('#mz').onclick = () => { zoom = zoom >= 3 ? 1 : zoom + 1; draw(); };
    await draw();
  } catch (e) { textFallback('Couldn’t render the page: ' + esc(e.message)); }
}
// ---------------- voice ----------------
// iOS doesn't give Home Screen web apps a working speech recogniser: webkitSpeechRecognition is either missing or
// starts and then never returns a result/error (WebKit bugs 317741 / 321436). So on an iPhone Home Screen app the mic
// button opens the keyboard on the search box and points at the keyboard's own dictation mic, which works offline.
// Elsewhere (Safari tab, Chrome, desktop) it tries the Web Speech API with a watchdog and falls back the same way.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#mic'), msg = $('#micmsg'), q = $('#q');
  if (!btn || !msg || !q) return;
  const tip = (t, ms = 12000) => { msg.hidden = false; msg.innerHTML = t; clearTimeout(tip.t); tip.t = setTimeout(() => msg.hidden = true, ms); };
  const KBTIP = `<b>Speak using the keyboard:</b> tap the <b>🎤</b> at the bottom right of the iPhone keyboard, say what you’re looking for, then tap it again. Results update as you talk.<br><small>No 🎤 on the keyboard? Turn on Settings › General › Keyboard › Enable Dictation.</small>`;
  let broken = sessionStorage.getItem('srBroken') === '1';
  const keyboardMode = () => !SR || broken || (IS_IOS && STANDALONE);
  // Toggle: focus #q to show keyboard, blur to hide. Must run sync inside the tap on iOS.
  const kbUp = () => document.activeElement === q;
  const syncMicLabel = () => {
    if (kbUp()) { btn.setAttribute('aria-label', 'Hide keyboard'); btn.title = 'Hide keyboard'; }
    else { btn.setAttribute('aria-label', 'Show keyboard'); btn.title = 'Show keyboard'; }
  };
  const kbDictate = (lead = '', forceShow = false) => {
    if (!forceShow && kbUp()) {
      q.blur();
      msg.hidden = true;
      syncMicLabel();
      return;
    }
    q.focus();
    try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) {}
    tip((lead || '') + KBTIP, 15000);
    syncMicLabel();
  };
  // UI is a keyboard toggle (matches what iPhone Home Screen does); SR may still run elsewhere under the hood.
  syncMicLabel();
  // Always show keyboard glyph: on iPhone Home Screen that's what the control does; elsewhere it still falls back to the keyboard tip.
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6.5" width="19" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  q.addEventListener('focus', syncMicLabel);
  q.addEventListener('blur', () => setTimeout(() => { if (!on) msg.hidden = true; syncMicLabel(); }, 300));
  let rec = null, on = false, wd = null, gotResult = false;
  const fail = (why, remember) => { clearTimeout(wd); on = false; btn.classList.remove('on'); try { rec && rec.abort(); } catch (e) {} if (remember) { broken = true; sessionStorage.setItem('srBroken', '1'); } kbDictate(why, true); };
  // Don't let the button steal focus (would blur #q before click and fight the toggle).
  btn.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button !== 0) return; e.preventDefault(); });
  btn.addEventListener('click', () => {
    if (keyboardMode()) return kbDictate();
    if (on) { try { rec.stop(); } catch (e) {} return; }
    gotResult = false;
    try { rec = new SR(); } catch (e) { return fail('Voice search isn’t available here. ', true); }
    rec.lang = 'en-AU'; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
    rec.onstart = () => { on = true; btn.classList.add('on'); tip('Listening… say what you’re looking for, e.g. “cracked crossarm”.'); clearTimeout(wd); wd = setTimeout(() => { if (!gotResult) fail('Didn’t hear anything. ', true); }, 8000); };
    rec.onresult = e => { gotResult = true; const t = [...e.results].map(r => r[0].transcript).join(' '); q.value = t; if (e.results[e.results.length - 1].isFinal) { clearTimeout(wd); go(t); } };
    rec.onerror = e => fail(e.error === 'no-speech' ? 'Didn’t hear anything. ' : (e.error === 'not-allowed' || e.error === 'service-not-allowed') ? 'Voice search is blocked for this app. ' : 'Voice search didn’t work (' + esc(e.error) + '). ', e.error !== 'no-speech' && e.error !== 'aborted');
    rec.onend = () => { clearTimeout(wd); on = false; btn.classList.remove('on'); if (gotResult) setTimeout(() => msg.hidden = true, 600); };
    try { rec.start(); } catch (e) { return fail('Couldn’t start voice search. ', true); }
    // watchdog: some iOS versions accept start() and then go silent with no event at all
    wd = setTimeout(() => { if (!on) fail('Voice search didn’t start. ', true); }, 2500);
  });
}
// ---------------- routing ----------------
function onDocsTab() { return (location.hash || '').startsWith('#/docs'); }
function go(q) {
  if (onDocsTab()) { if ($('#q')) $('#q').value = q || ''; renderDocs(); return; }
  addRecent(q); location.hash = '#/search?q=' + encodeURIComponent(q);
}
// history bookkeeping: each entry gets an index so a back swipe knows whether there is an in-app screen to go back to
let NAVIDX = -1, LAST_SEARCH = '#/search';
const tabOf = h => h.startsWith('#/browse') ? 'browse' : h.startsWith('#/cheat') ? 'cheat' : h.startsWith('#/manual') ? 'manual' : h.startsWith('#/docs') ? 'docs' : h.startsWith('#/search') || !h || h === '#' || h === '#/' ? 'search' : null;
function trackHistory() {
  const st = history.state;
  if (st && typeof st.idx === 'number') NAVIDX = st.idx; else { NAVIDX++; history.replaceState({ ...(st || {}), idx: NAVIDX }, ''); }
  if (location.hash.startsWith('#/search')) LAST_SEARCH = location.hash;
}
function closeModal() {
  const m = $('#modal');
  if (location.hash.startsWith('#/page/')) { if (NAVIDX > 0) history.back(); else location.replace('#/search'); return; }
  m.hidden = true; m.innerHTML = '';
}
function fillViewHeight() {
  const headerH = document.getElementById('top')?.offsetHeight || 0;
  const tabsH = document.getElementById('tabs')?.offsetHeight || 50;
  view.style.minHeight = Math.max(120, window.innerHeight - headerH - tabsH) + 'px';
}
function route() {
  trackHistory();
  const h = location.hash || '#/search';
  const tab = tabOf(h) || 'search';
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  fillViewHeight();
  // Dismiss search keyboard when leaving Search so iOS doesn't leave the fixed tab bar raised.
  const qEl = $('#q');
  if (qEl) {
    if (tab === 'docs') { qEl.placeholder = 'Search docs…'; qEl.setAttribute('aria-label', 'Search docs'); }
    else { qEl.placeholder = 'Search defects, codes, rules…'; qEl.setAttribute('aria-label', 'Search the manual'); }
  }
  // Dismiss search keyboard when leaving Search/Docs so iOS doesn't leave the fixed tab bar raised.
  if (tab !== 'search' && tab !== 'docs') { try { qEl.blur(); } catch (_) {} }
  if (!h.startsWith('#/page/')) { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
  closeNotesPop();
  let m;
  if ((m = h.match(/^#\/page\/(\d+)/))) return showPage(+m[1]);
  if ((m = h.match(/^#\/d\/(\w+)/))) { const d = ENG && ENG.byId.get(m[1]); view.innerHTML = d ? `<a class="btn" href="#/search" data-back>‹ Back</a>${defectCard(d, { open: true, terms: lastQ ? lastQ.split(/\s+/) : [] })}` : ''; window.scrollTo(0, 0); hydratePhotos(); wireCardUploads(); return; }
  window.scrollTo(0, 0);
  if (tab === 'browse') return renderBrowse();
  if (tab === 'cheat') return renderCheat();
  if (tab === 'manual') return renderManual();
  if (tab === 'docs') return renderDocs();
  const qm = h.match(/[?&]q=([^&]*)/);
  renderSearch(qm ? decodeURIComponent(qm[1]) : ''); window.scrollTo(0, 0);
}
// ---------------- init ----------------
view.addEventListener('toggle', e => { if (e.target.open) hydratePhotos(e.target); }, true);
view.addEventListener('click', e => {
  const lb = e.target.closest('[data-open-lim]');
  if (lb) {
    e.preventDefault(); e.stopPropagation();
    const d = ENG && ENG.byId.get(lb.getAttribute('data-open-lim'));
    const tpl = lb.parentNode.querySelector('template.lim-tpl');
    if (d) toggleNotesPop(d, lb, 'lim', tpl ? tpl.innerHTML : '');
    return;
  }
  const on = e.target.closest('[data-open-notes]');
  if (on) {
    e.preventDefault();
    e.stopPropagation();
    const id = on.getAttribute('data-open-notes');
    const d = ENG && ENG.byId.get(id);
    if (d) toggleNotesPop(d, on);
    return;
  }
  const cn = e.target.closest('[data-copy-notes]');
  if (cn) {
    e.preventDefault();
    copyNotesFor(cn);
    return;
  }
  const dct = e.target.closest('.defect-cards-toggle');
  if (dct) {
    e.preventDefault();
    const block = dct.closest('.defect-cards-block');
    if (block) {
      const open = dct.getAttribute('aria-expanded') !== 'true';
      dct.setAttribute('aria-expanded', open ? 'true' : 'false');
      block.classList.toggle('is-collapsed', !open);
    }
    return;
  }
  const bk = e.target.closest('[data-back]'); if (bk) { e.preventDefault(); if (NAVIDX > 0) history.back(); else location.replace(LAST_SEARCH); return; }
  const ph = e.target.closest('[data-ph]'); if (ph) { e.preventDefault(); showPhoto(ph.dataset.ph); return; }
  const c = e.target.closest('[data-q]'); if (c) { go(c.dataset.q); return; }
  const b = e.target.closest('[data-bf]'); if (b) { browseFilter = b.dataset.bf; renderBrowse(); }
});
let deb;
$('#q').addEventListener('input', e => { clearTimeout(deb); deb = setTimeout(() => { const q = e.target.value; if (onDocsTab()) { renderDocs(); return; } if (!location.hash.startsWith('#/search')) location.hash = '#/search'; history.replaceState(history.state, '', '#/search?q=' + encodeURIComponent(q)); LAST_SEARCH = location.hash; renderSearch(q); }, 220); });
$('#q').addEventListener('input', e => { $('#qclear').hidden = !e.target.value; });
$('#qclear').addEventListener('click', () => { clearTimeout(deb); const q = $('#q'); q.value = ''; $('#qclear').hidden = true; if (onDocsTab()) { renderDocs(); q.focus(); return; } if (!location.hash.startsWith('#/search')) location.hash = '#/search'; history.replaceState(history.state, '', '#/search?q='); LAST_SEARCH = location.hash; renderSearch(''); q.focus(); });
$('#qform').addEventListener('submit', e => { e.preventDefault(); if (onDocsTab()) { renderDocs(); return; } $('#q').blur(); go($('#q').value); });
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => {
  const h = location.hash || '#/search';
  if (!(h.startsWith('#/search') || h === '' || h === '#' || h === '#/')) return;
  const qm = h.match(/[?&]q=([^&]*)/);
  const q = qm ? decodeURIComponent(qm[1]) : '';
  if (!q.trim()) renderSearch('');
});
// Keyboard button removed (v47); tap #q to bring up the keyboard.
$('#ask').addEventListener('click', e => { e.preventDefault(); openAskSkynet(currentDefect()); });
const SWIPE = initSwipe({ view, modal: $('#modal'), tabOf: h => tabOf(h || '#/search'), tabHref: t => t === 'search' ? LAST_SEARCH : '#/' + t,
  canGoBack: () => NAVIDX > 0, closeModal, standalone: () => STANDALONE || document.documentElement.dataset.standalone === '1' });
// Keep #tabs matching Browse/Priorities/Manual/Docs (flush, bottom:0).
// Earlier always-on translateY "pins" left Search sitting high: short Search
// pages make visualViewport report a gap even with no keyboard, and the
// counter-transform fought fixed+safe-area. Only nudge while #q is focused
// and the gap is clearly a keyboard (>= 80px). Otherwise clear transform so
// Search matches the other tabs exactly.
(function pinTabsToLayoutBottom() {
  const tabs = document.getElementById('tabs');
  if (!tabs) return;
  let baselineInnerH = window.innerHeight;
  let raf = 0;
  const sync = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      tabs.style.bottom = '0px';
      const vv = window.visualViewport;
      const q = document.getElementById('q');
      const focused = !!(q && document.activeElement === q);
      if (!focused) baselineInnerH = window.innerHeight;
      if (!vv || !focused) { tabs.style.transform = ''; return; }
      const layoutH = Math.max(baselineInnerH, window.innerHeight);
      const gap = Math.max(0, layoutH - vv.height - vv.offsetTop);
      // Ignore small chrome gaps — only counter a real keyboard.
      tabs.style.transform = gap >= 80 ? `translateY(${gap}px)` : '';
    });
  };
  sync();
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', sync);
    visualViewport.addEventListener('scroll', sync);
  }
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', () => setTimeout(sync, 50));
  window.addEventListener('hashchange', sync);
  window.addEventListener('focusin', e => {
    if (e.target && e.target.id === 'q') baselineInnerH = Math.max(baselineInnerH, window.innerHeight);
    sync();
  });
  window.addEventListener('focusout', () => setTimeout(sync, 50));
})();
// Blur search field when tapping a bottom tab so focus races don't leave the bar raised.
document.getElementById('tabs')?.addEventListener('click', e => {
  if (e.target.closest('a')) { try { document.getElementById('q').blur(); } catch (_) {} }
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
loadData().then(route).then(() => setTimeout(upgradeStoredManual, 1500));
// Data read by an older extractor (< 1.2) has no severity cell colours. Re-read the stored PDF on the phone and
// swap the new data in. Card ids and photo examples are unchanged by 1.2, so stored photos are kept.
async function upgradeStoredManual() {
  try {
    if (!DATA || +DATA.meta.extractorVersion >= 1.2 || PHOTO_RUN || UPGRADING) return;
    const blob = await store.get('pdf'); if (!blob) return;
    UPGRADING = true;
    bg('🎨 Adding the manual’s severity colours (red / grey) from your stored PDF…');
    const { extractFromPdf } = await import('./js/pdfload.js');
    const nd = await extractFromPdf(blob, p => { if (p.phase === 'text') bg(`🎨 Adding severity colours: page ${p.done} of ${p.total}<br><progress max="${p.total}" value="${p.done}"></progress>`); });
    const old = DATA;
    const same = nd.defects.length === old.defects.length && nd.defects.every((d, i) => d.id === old.defects[i].id && d.title === old.defects[i].title && d.examples.length === old.defects[i].examples.length);
    if (!same) { // layout changed between versions: keep the old cards, copy colours onto matching rows only
      const byId = new Map(nd.defects.map(d => [d.id + '|' + d.title, d]));
      for (const d of old.defects) { const n = byId.get(d.id + '|' + d.title); if (!n) continue;
        for (const s of d.scale) { const m = n.scale.find(x => x.level === s.level && x.text === s.text && x.p === s.p); if (m && m.c) s.c = m.c; } }
      old.meta.extractorVersion = nd.meta.extractorVersion; old.meta.coloursMerged = true;
      await store.set('manual', old); setData(old, META);
    } else { await store.set('manual', nd); setData(nd, META); }
    bg(''); route();
  } catch (e) { console.error(e); bg(''); }
  finally { UPGRADING = false; }
}
window.__lim = { get navIdx() { return NAVIDX; }, swipe: SWIPE, askSkynetText, askSkynetLinks, currentDefect, openAskSkynet, get data() { return DATA; }, get photos() { return PHOTOS; }, get photoMeta() { return PHMETA; }, get photoRun() { return !!PHOTO_RUN; } };

// ---------------- defect card cycler (header far-right) ----------------
(() => {
  const btn = document.getElementById('cycle');
  if (!btn) return;
  let idx = 0;
  const targets = () => [...view.querySelectorAll('[data-dc]')];
  const label = n => {
    btn.textContent = `${idx + 1} / ${n}`;
    btn.setAttribute('aria-label', `Next defect card, ${idx + 1} of ${n}`);
    btn.title = `Defect card ${idx + 1} of ${n}`;
  };
  const update = () => {
    const n = targets().length;
    idx = 0;
    if (n > 1) { btn.classList.remove('is-off'); btn.removeAttribute('aria-hidden'); btn.tabIndex = 0; label(n); }
    else { btn.classList.add('is-off'); btn.setAttribute('aria-hidden', 'true'); btn.tabIndex = -1; btn.textContent = ''; }
  };
  new MutationObserver(update).observe(view, { childList: true });
  btn.addEventListener('click', () => {
    const ts = targets(); const n = ts.length; if (n < 2) return;
    idx = (idx + 1) % n;
    const el = ts[idx];
    const hdr = document.getElementById('top');
    const off = (hdr ? hdr.getBoundingClientRect().bottom : 0) + 8;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'smooth' });
    label(n);
  });
  update();
})();
