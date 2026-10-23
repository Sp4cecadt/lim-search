import * as store from './js/store.js';
import { buildIndex, search, hasWord } from './js/search.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let DATA = null, ENG = null, META = null, HAS_PDF = false;
let PHOTOS = new Set(), PHMETA = null; // example photo keys "<defectId>/<exampleIndex>" stored on this phone
const phURL = new Map();

// ---------------- data loading ----------------
async function loadData() {
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
function addRecent(q) { q = q.trim(); if (q.length < 2) return; const r = [q, ...recent().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 12); localStorage.setItem('recent', JSON.stringify(r)); }

// ---------------- defect card ----------------
function defectCard(d, { open = false, terms = [] } = {}) {
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
  const scale = d.scale.length ? `<table class="scale">${(() => { let g = null, h = ''; for (const s of d.scale) { if (s.group && s.group !== g) { g = s.group; h += `<tr><td colspan="2" class="muted small"><b>${esc(g)}</b></td></tr>`; } h += `<tr><td class="l ${lvClass(s.level)}">${esc(s.level)}</td><td>${hl(s.text, terms).replace(/\[(Z Code[^\]]*)\]/gi, '<span class="zt">[$1]</span>')}</td></tr>`; } return h; })()}</table>` : '';
  const refs = [`Card ${pageLink(d.page, d.pageLabel)}${d.endPage > d.page ? `–${d.endPage}` : ''}`];
  if (d.summaryPage) refs.push(`Summary table ${pageLink(d.summaryPage)}`);
  if (d.inZIndex) refs.push(`App. 1 Z index ${pageLink(d.inZIndex)}`);
  if (d.inBreakdownIndex) refs.push(`App. 3 Breakdown index ${pageLink(d.inBreakdownIndex)}`);
  const ex = d.examples.map((e, i) => ({ ...e, key: d.id + '/' + i })).filter(e => e.caption || e.tags.length);
  const nPh = ex.filter(e => PHOTOS.has(e.key)).length;
  const rec = ['priorityfield', 'deadlines', 'notes', 'photos'].map(passage).filter(Boolean);
  return `<article class="card defect ${cls}">
    <h3><a href="#/d/${d.id}" style="color:inherit;text-decoration:none">${hl(d.title, terms)}</a></h3>
    <div class="sec">§${esc(d.num || d.section)} ${esc(d.sectionTitle)} · ${pageLink(d.page, d.pageLabel)}</div>
    <div class="badges">${badges.join('')}</div>
    ${warn.map(w => `<div class="note">⚠️ ${esc(w)}</div>`).join('')}
    <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${scale}
    ${d.details ? `<details ${open ? 'open' : ''}><summary>Details from the manual</summary><div class="pre">${hl(d.details, terms)}</div></details>` : ''}
    ${ex.length ? `<details class="phx" ${open ? 'open' : ''}><summary>${nPh ? '📷 ' : ''}Photo examples (${ex.length})</summary>${!PHOTOS.size ? `<div class="note small">The example photos aren’t on this phone yet. <a href="#/manual">Manual tab › Add photos</a></div>` : ''}${ex.map(e => `<div class="ex">${PHOTOS.has(e.key) ? `<button class="phb" data-ph="${e.key}" aria-label="Enlarge photo"><img data-phk="${e.key}" alt="Example photo from p.${e.p}"><span class="zoomi">⤢</span></button>` : ''}${hl(e.caption, terms)}<div>${e.tags.map(t => `<span class="tag ${t.k === 'Priority' && /z/i.test(t.v) ? 'zt' : ''}">${t.bfra ? esc(t.bfra) + ' ' : ''}${esc(t.k)}: ${esc(t.v)}</span>`).join('')} ${pageLink(e.p)}</div></div>`).join('')}</details>` : ''}
    ${d.summary ? `<details><summary>Section 5 summary table row</summary><div class="small muted">As printed in the condition summary table, ${pageLink(d.summary.p)}. Columns may run together.</div><dl class="kv"><dt>Quick code</dt><dd>${esc(d.summary.quickCode)}</dd><dt>Severity</dt><dd>${esc(d.summary.severity)}</dd></dl><div class="pre small">${hl(d.summary.details, terms)}</div></details>` : ''}
    ${d.kind === 'Summary table only' ? `<div class="note">There's no separate condition example page for this one. It's taken from the Section 5 summary table, ${pageLink(d.page)}, so check the page.</div>` : ''}
    ${rec.length ? `<details><summary>How to record it</summary>${rec.map(p => `<div class="ex"><b>${esc(p.title)}</b> ${pageLink(p.page)}<div class="pre small">${esc(p.text)}</div></div>`).join('')}</details>` : ''}
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
  lastQ = q;
  if (!q.trim()) {
    const r = recent();
    view.innerHTML = `${r.length ? `<h2>Recent searches</h2><div class="chips">${r.map(x => `<button class="chip" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
      <h2>Try</h2><div class="chips">${EXAMPLES.map(x => `<button class="chip" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <p class="muted small" style="margin-top:18px">Search runs on your phone and works offline. Results show the defect cards first (codes, priorities, severity scale), then everything else the manual says, with page numbers to check.</p>`;
    return;
  }
  const t0 = performance.now();
  const r = search(ENG, DATA, q);
  const terms = r.terms;
  let h = '';
  if (r.intents.z) h += zPanel();
  if (r.intents.breakdown) h += bdPanel();
  if (r.passages.length) h += `<h2>From the recording rules</h2>${r.passages.map(p => `<div class="card"><b>${esc(p.title)}</b> · ${pageLink(p.page)}<div class="pre small" style="margin-top:6px">${hl(p.text, terms)}</div></div>`).join('')}`;
  if (r.defects.length) {
    h += `<h2>Defect cards ${r.mode === 'any' ? '<small>(partial match)</small>' : ''}</h2>`;
    h += r.defects.slice(0, 2).map((x, i) => defectCard(x.d, { terms, open: false })).join('');
    if (r.defects.length > 2) h += `<div class="card">${r.defects.slice(2).map(x => `<a class="row" href="#/d/${x.d.id}"><span>${hl(x.d.title, terms)}<br><small>§${esc(x.d.section)} ${esc(x.d.sectionTitle)} · p.${x.d.page}</small></span><span>${x.d.zCode ? '<span class="b z">Z</span>' : ''}${x.d.breakdown ? ' <span class="b bd">BD</span>' : ''} ›</span></a>`).join('')}</div>`;
  }
  if (r.quickCodes.length) h += `<h2>Quick codes (§14.2)</h2><div class="card">${r.quickCodes.map(c => `<div class="row"><span><span class="qc">${esc(c.group ? c.group + ' > ' : '')}${hl(c.name, terms)}</span><br><small>${hl(c.desc, terms)}</small></span><span><span class="b">${esc(c.type)}</span> ${pageLink(c.p)}</span></div>`).join('')}</div>`;
  if (r.chunks.length) {
    h += `<h2>Other mentions (${r.chunks.length}${r.cmode === 'any' ? ', partial' : ''})</h2>`;
    h += r.chunks.map(x => `<div class="card mention"><div class="meta"><span>§${esc(x.c.sec)} ${esc(x.c.st)}</span>${pageLink(x.c.p, x.c.pl)}</div>
      <details><summary style="font-weight:400;color:var(--fg)"><span class="snip">${hl(snippet(x.c.text, terms), terms)}</span></summary><div class="pre">${hl(x.c.text, terms)}</div></details></div>`).join('');
  }
  if (!h) h = `<div class="card">Nothing found for “${esc(q)}”. Try fewer or different words (e.g. “crossarm” instead of “x-arm brace rusted through”).</div>`;
  view.innerHTML = h + `<p class="muted small">${Math.round(performance.now() - t0)} ms · matched: ${r.concepts.map(c => esc(c[0])).join(', ')}</p>`;
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
    <h2>Quick code list (§14.2)</h2><input class="filter" id="qcf" placeholder="Filter quick codes…"><div id="qcl" class="card"></div>
    <h2>Manual sections</h2><div class="card">${DATA.toc.filter(t => !/^\d+$/.test(t.num) || true).map(t => `<a class="row" href="#/page/${t.from}"><span>${esc(t.num)} ${esc(t.title)}</span><small>p.${t.from}–${t.to}</small></a>`).join('')}</div>`;
  const draw = () => { const v = ($('#qcf').value || '').toLowerCase(); $('#qcl').innerHTML = DATA.quickCodeTable.filter(c => !v || (c.name + ' ' + c.group + ' ' + c.desc + ' ' + c.type).toLowerCase().includes(v)).slice(0, 400).map(c => `<div class="row"><span><span class="qc">${esc(c.group ? c.group + ' > ' : '')}${esc(c.name)}</span><br><small>${esc(c.desc)}</small></span><span><span class="b">${esc(c.type)}</span> ${pageLink(c.p)}</span></div>`).join(''); };
  $('#qcf').addEventListener('input', draw); draw();
}
function renderCheat() {
  if (!DATA) return needData();
  const order = ['priorityscale', 'deadlines', 'priorityfield', 'fireconsequence', 'breakdown', 'severitydef', 'severityscale', 'probability', 'quickcode', 'description', 'notes', 'photos', 'systems', 'pfdsp'];
  const zs = DATA.defects.filter(d => d.zCode);
  const unmatched = DATA.zIndex.items.filter(i => !i.defect);
  view.innerHTML = `<div class="card defect bd"><h3>Urgent / Breakdown</h3><a class="btn pri" href="tel:0884044499">📞 Dispatch 8404 4499</a> <span class="muted small">(number as printed in the manual, ${pageLink((passage('breakdown') || {}).page || 1409)})</span></div>
    ${order.map(passage).filter(Boolean).map(p => `<details class="card" ${['priorityscale', 'deadlines', 'priorityfield'].includes(p.id) ? 'open' : ''}><summary>${esc(p.title)}</summary><div class="pre small">${esc(p.text)}</div><div class="small">${p.pages.map(n => pageLink(n)).join(' ')}</div></details>`).join('')}
    <h2>Cards where Z Code is possible (${zs.length})</h2>
    <div class="card">${zs.map(d => `<a class="row" href="#/d/${d.id}"><span>${esc(d.title)}<br><small>§${esc(d.section)} · p.${d.page} · ${esc((d.priorityByBfra && (d.priorityByBfra['H/MBFRA'] || d.priorityByBfra.HBFRA)) || d.priorityRange || '')}</small></span><span>${d.inZIndex ? '' : '<span class="b warn">not in App.1</span>'} ›</span></a>`).join('')}</div>
    ${unmatched.length ? `<h2>Appendix 1 entries without a matching card</h2><div class="card">${unmatched.map(i => `<div class="row"><span>${esc(i.secNum || '')} ${esc(i.secTitle || '')} – ${esc(i.name)}</span>${pageLink(i.page)}</div>`).join('')}</div>` : ''}
    <p class="muted small">Everything above is copied from the manual. Tap a page number to check it.</p>`;
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
    <div class="card"><h3>Storage</h3><p class="small muted">${est ? `Using ${(est.usage / 1e6).toFixed(1)} MB of ${(est.quota / 1e6).toFixed(0)} MB available.` : ''}</p>
    <button class="btn danger" id="wipe">Delete manual from this phone</button></div>
    <p class="muted small">Extractor v${esc(m ? m.extractorVersion : '')}. Defect cards are built automatically from the manual's layout. Always check the page reference before relying on a code or priority.</p>`;
  $('#pdffile').addEventListener('change', e => e.target.files[0] && doUpdate(e.target.files[0]));
  const ap = $('#addph'); if (ap) ap.addEventListener('click', addPhotosFromStored);
  $('#wipe').addEventListener('click', async () => { if (!confirm('Delete the stored manual, photos and PDF from this phone?')) return; PHOTO_RUN = null; await store.del('manual'); await store.del('meta'); await store.del('pdf'); await store.del('pdfInfo'); await store.del('photoMeta'); await store.photoClear(); PHOTOS = new Set(); PHMETA = null; resetPhotoURLs(); HAS_PDF = false; setData(null, null); renderManual('Deleted.'); });
}
function diffSummary(oldD, newD) {
  if (!oldD) return '';
  const key = d => d.section + '|' + d.title.toLowerCase();
  const om = new Map(oldD.defects.map(d => [key(d), d])), nm = new Map(newD.defects.map(d => [key(d), d]));
  const added = [...nm.keys()].filter(k => !om.has(k)), removed = [...om.keys()].filter(k => !nm.has(k));
  const sig = d => JSON.stringify([d.severityRange, d.priorityRange, d.quickCodes, d.scale.map(s => [s.level, s.text])]);
  const changed = [...nm.keys()].filter(k => om.has(k) && sig(om.get(k)) !== sig(nm.get(k)));
  const list = (a, m) => a.slice(0, 15).map(k => '• ' + esc(m.get(k).title) + ' (p.' + m.get(k).page + ')').join('<br>');
  return `<b>Changes vs previous version:</b> ${added.length} new, ${removed.length} removed, ${changed.length} changed cards.` +
    (added.length ? `<br><br><b>New:</b><br>${list(added, nm)}` : '') + (removed.length ? `<br><br><b>Removed:</b><br>${list(removed, om)}` : '') + (changed.length ? `<br><br><b>Changed:</b><br>${list(changed, nm)}` : '');
}
let PHOTO_RUN = null;
const bg = t => { const e = $('#bgtask'); if (!e) return; e.hidden = !t; e.innerHTML = t || ''; };
async function doUpdate(file, { fromStored = false } = {}) {
  const prog = $('#prog');
  PHOTO_RUN = null; // stop any photo run for the old manual
  prog.innerHTML = `<p>Reading <b>${esc(file.name || 'stored PDF')}</b>…</p><progress id="pb" max="100" value="0"></progress><p id="pt" class="small muted"></p>`;
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
    if (!ok && !confirm(`Only ${data.defects.length} defect cards were recognised. The layout may have changed, so search would mostly use plain text. Save anyway?`)) { prog.innerHTML = '<div class="note">Cancelled. Your previous manual is unchanged.</div>'; return; }
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
  } catch (e) {
    console.error(e); prog.innerHTML = `<div class="note">Couldn’t read that PDF: ${esc(e.message || e)}. Your previous manual is unchanged.</div>`; return;
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
  const tip = (t, ms = 12000) => { msg.hidden = false; msg.innerHTML = t; clearTimeout(tip.t); tip.t = setTimeout(() => msg.hidden = true, ms); };
  const KBTIP = `<b>Speak using the keyboard:</b> tap the <b>🎤</b> at the bottom right of the iPhone keyboard, say what you’re looking for, then tap it again. Results update as you talk.<br><small>No 🎤 on the keyboard? Turn on Settings › General › Keyboard › Enable Dictation.</small>`;
  let broken = sessionStorage.getItem('srBroken') === '1';
  const keyboardMode = () => !SR || broken || (IS_IOS && STANDALONE);
  // must run synchronously inside the tap, or iOS won't open the keyboard
  const kbDictate = (lead = '') => { q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) {} tip(lead + KBTIP, 15000); };
  btn.setAttribute('aria-label', keyboardMode() ? 'Voice search (opens the keyboard for dictation)' : 'Voice search');
  q.addEventListener('blur', () => setTimeout(() => { if (!on) msg.hidden = true; }, 300));
  let rec = null, on = false, wd = null, gotResult = false;
  const fail = (why, remember) => { clearTimeout(wd); on = false; btn.classList.remove('on'); try { rec && rec.abort(); } catch (e) {} if (remember) { broken = true; sessionStorage.setItem('srBroken', '1'); } kbDictate(why); };
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
function go(q) { addRecent(q); location.hash = '#/search?q=' + encodeURIComponent(q); }
function route() {
  const h = location.hash || '#/search';
  const tab = h.startsWith('#/browse') ? 'browse' : h.startsWith('#/cheat') ? 'cheat' : h.startsWith('#/manual') ? 'manual' : 'search';
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  if (!h.startsWith('#/page/')) { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
  let m;
  if ((m = h.match(/^#\/page\/(\d+)/))) return showPage(+m[1]);
  if ((m = h.match(/^#\/d\/(\w+)/))) { const d = ENG && ENG.byId.get(m[1]); view.innerHTML = d ? `<a class="btn" href="javascript:history.back()">‹ Back</a>${defectCard(d, { open: true, terms: lastQ ? lastQ.split(/\s+/) : [] })}` : ''; window.scrollTo(0, 0); hydratePhotos(); return; }
  window.scrollTo(0, 0);
  if (tab === 'browse') return renderBrowse();
  if (tab === 'cheat') return renderCheat();
  if (tab === 'manual') return renderManual();
  const qm = h.match(/[?&]q=([^&]*)/);
  renderSearch(qm ? decodeURIComponent(qm[1]) : ''); window.scrollTo(0, 0);
}
// ---------------- init ----------------
view.addEventListener('toggle', e => { if (e.target.open) hydratePhotos(e.target); }, true);
view.addEventListener('click', e => {
  const ph = e.target.closest('[data-ph]'); if (ph) { e.preventDefault(); showPhoto(ph.dataset.ph); return; }
  const c = e.target.closest('[data-q]'); if (c) { go(c.dataset.q); return; }
  const b = e.target.closest('[data-bf]'); if (b) { browseFilter = b.dataset.bf; renderBrowse(); }
});
let deb;
$('#q').addEventListener('input', e => { clearTimeout(deb); deb = setTimeout(() => { const q = e.target.value; if (!location.hash.startsWith('#/search')) location.hash = '#/search'; history.replaceState(null, '', '#/search?q=' + encodeURIComponent(q)); renderSearch(q); }, 220); });
$('#qform').addEventListener('submit', e => { e.preventDefault(); $('#q').blur(); go($('#q').value); });
window.addEventListener('hashchange', route);
setupMic();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
loadData().then(route);
window.__lim = { get data() { return DATA; }, get photos() { return PHOTOS; }, get photoMeta() { return PHMETA; }, get photoRun() { return !!PHOTO_RUN; } };
