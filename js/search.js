// Search engine shared by the app and the Node tests.
import MiniSearch from '../vendor/minisearch.js';
import { synonymsOf, PHRASES } from './synonyms.js';

const STOP = new Set('the a an of on in at to for is are be what whats how do does i my we with and or it its this that when where which should need any if about there has have can get show me tell find over under near into from by'.split(' '));
export const tokenize = s => s.toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9/]+/).filter(Boolean);
const processTerm = t => { t = t.toLowerCase(); if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1); return t; };

export function buildIndex(data) {
  const defIdx = new MiniSearch({
    fields: ['title', 'section', 'qc', 'scale', 'details', 'examples', 'ranges'],
    storeFields: [], tokenize, processTerm, idField: 'id',
    searchOptions: { boost: { title: 6, qc: 2.5, section: 1.5, ranges: 1, scale: 1, details: 0.8, examples: 0.5 }, prefix: t => t.length > 3, fuzzy: t => t.length > 4 ? 0.2 : false },
  });
  defIdx.addAll(data.defects.map(d => ({
    id: d.id, title: d.title + (d.kind !== 'Defect' ? ' ' + d.kind : ''), section: d.sectionTitle || '',
    qc: d.quickCodes.map(q => q.group + ' ' + q.code).join(' '), scale: d.scale.map(s => s.text).join(' '),
    details: d.details, examples: d.examples.map(e => e.caption).join(' '),
    ranges: [d.severityRange, d.priorityRange, d.zCode ? 'z code' : '', d.breakdown ? 'breakdown' : ''].join(' '),
  })));
  const chunkIdx = new MiniSearch({
    fields: ['text', 'st'], storeFields: [], tokenize, processTerm,
    searchOptions: { boost: { st: 1.5, text: 1 }, prefix: t => t.length > 3, fuzzy: t => t.length > 4 ? 0.2 : false },
  });
  chunkIdx.addAll(data.chunks);
  const blob = new Map(data.defects.map(d => [d.id, ' ' + [d.title, d.sectionTitle, d.quickCodes.map(q => q.group + ' ' + q.code).join(' '), d.scale.map(x => x.text).join(' '), d.details, d.priorityRange, d.severityRange].join(' ').toLowerCase().replace(/[^a-z0-9/]+/g, ' ') + ' ']));
  return { defIdx, chunkIdx, blob, byId: new Map(data.defects.map(d => [d.id, d])), chunkById: new Map(data.chunks.map(c => [c.id, c])) };
}

// Split the query into concepts (phrases first), each expanded with synonyms.
export function parseQuery(q) {
  let s = ' ' + q.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9/\- ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  const concepts = [];
  for (const ph of PHRASES) {
    const re = new RegExp(' ' + ph.replace(/[-/]/g, m => '\\' + m) + ' ', 'g');
    if (re.test(s)) { concepts.push([ph, ...synonymsOf(ph)]); s = s.replace(re, ' '); }
  }
  for (const t of tokenize(s)) {
    if (STOP.has(t)) continue;
    concepts.push([t, ...synonymsOf(t)]);
  }
  return concepts;
}
const toQuery = (concepts, comb) => ({ combineWith: comb, queries: concepts.map(c => ({ combineWith: 'OR', queries: c.map((t, i) => i === 0 ? t : { queries: [t], boost: 0.6 }) })) });
// MiniSearch query trees accept plain strings; boosted synonym sub-queries are wrapped:
function qtree(concepts, comb) {
  return { combineWith: comb, queries: concepts.map(c => ({ combineWith: 'OR', queries: c })) };
}

export function intents(q) {
  const s = q.toLowerCase();
  return {
    z: /\bz[\s-]?(code|priority|codes)?\b|fire start|fire season|\bfds\b/.test(s) && /\bz\b|z[\s-]?code|zcode|fire start|fds|fire season/.test(s),
    breakdown: /break\s?down|dispatch|8404/.test(s),
    quickcode: /quick\s?code|\bqc\b/.test(s),
    recording: /record|blueworx|sap|notification|notes|photo|description|how (do|to) (i )?(book|raise|log|enter)/.test(s),
    severity: /severity|extreme|very high|moderate/.test(s),
  };
}

// whole-word (or word-prefix for longer terms) match inside a normalised ' word word ' blob
export function hasWord(blob, w) {
  w = w.toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim(); if (!w) return false;
  if (blob.includes(' ' + w + ' ')) return true;
  if (w.length >= 4 && blob.includes(' ' + w)) return true;
  const st = w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : null; return !!(st && blob.includes(' ' + st));
}
export function search(engine, data, q, { maxDefects = 6, maxChunks = 40 } = {}) {
  const concepts = parseQuery(q);
  if (!concepts.length) return { concepts, defects: [], chunks: [], quickCodes: [], intents: intents(q) };
  let dres = engine.defIdx.search(qtree(concepts, 'AND'));
  let mode = 'all';
  if (!dres.length && concepts.length > 1) { dres = engine.defIdx.search(qtree(concepts, 'OR')); mode = 'any'; }
  // re-rank: reward concepts matched in the title
  const titleHit = d => { const t = (d.title + ' ' + d.sectionTitle).toLowerCase(); return concepts.filter(c => c.some(w => t.includes(w))).length; };
  const cov = id => { const b = engine.blob.get(id); return concepts.filter(c => c.some(w => hasWord(b, w))).length / concepts.length; };
  dres = dres.map(r => { const d = engine.byId.get(r.id); const cv = cov(r.id); return { d, cov: cv, score: r.score * (1 + 0.6 * titleHit(d) / concepts.length) * (0.3 + 0.7 * cv * cv) }; }).sort((a, b) => b.score - a.score);
  const top = dres.length ? dres[0].score : 0;
  const defects = dres.filter((r, i) => i < maxDefects && r.score >= top * 0.35);
  let cres = engine.chunkIdx.search(qtree(concepts, 'AND'));
  let cmode = 'all';
  if (cres.length < 3 && concepts.length > 1) { cres = engine.chunkIdx.search(qtree(concepts, 'OR')); cmode = 'any'; }
  const chunks = cres.slice(0, maxChunks).map(r => ({ c: engine.chunkById.get(r.id), score: r.score, terms: r.terms }));
  const qset = concepts.flat();
  const quickCodes = data.quickCodeTable.filter(r => { const t = ' ' + (r.name + ' ' + r.group + ' ' + r.desc).toLowerCase().replace(/[^a-z0-9/]+/g, ' ') + ' '; return concepts.every(c => c.some(w => hasWord(t, w))); }).slice(0, 15);
  const it = intents(q);
  const passages = (data.passages || []).map(p => { const t = ' ' + (p.title + ' ' + p.text).toLowerCase().replace(/[^a-z0-9/]+/g, ' ') + ' '; const n = concepts.filter(c => c.some(w => hasWord(t, w))).length; return { p, n }; })
    .filter(x => x.n === concepts.length || (concepts.length > 2 && x.n >= concepts.length - 1) || (it.recording && x.n >= 1)).sort((a, b) => b.n - a.n).slice(0, 3).map(x => x.p);
  return { concepts, mode, cmode, defects, chunks, quickCodes, passages, terms: qset, intents: it };
}
