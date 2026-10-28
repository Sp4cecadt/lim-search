// Offline support: app shell cached on install; everything else stale-while-revalidate.
const V = 'lim-search-v10';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'js/store.js', 'js/search.js', 'js/synonyms.js', 'js/layout.js', 'js/extract.js', 'js/pdfload.js', 'js/photos.js', 'js/theme.js', 'js/swipe.js',
  'vendor/minisearch.js', 'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || (u.pathname.endsWith('.json') ? new Response('{}', { status: 404 }) : c.match('index.html'));
  }));
});
