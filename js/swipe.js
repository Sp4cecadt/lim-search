// Swipe navigation (iOS-style). Right-to-left = next tab; left-to-right = back (closes an open photo/page/card first), else previous tab.
// Ignores: vertical scrolls, pinch (2+ fingers), page zoom, text selection, form fields, and horizontal scrollers that can still
// scroll in the swipe direction (a swipe starting at the screen edge always navigates, like the iOS back gesture).
const TABS = ['search', 'browse', 'cheat', 'manual', 'docs'];
const EDGE = 24, LOCK = 12, COMMIT = 60, FLICK_V = 0.45, FLICK_MIN = 28;

export function initSwipe(o) {
  // o: { view, modal, tabOf(hash), tabHref(tab), canGoBack(), back(), closeModal(), standalone }
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let s = null, suppressClick = 0, last = null;
  const W = () => window.innerWidth;
  const modalOpen = () => !o.modal.hidden;
  const inDetail = () => modalOpen() || /^#\/(d|page)\//.test(location.hash);

  function scrollerBlocks(el, dir) { // dir +1 = finger moving right (content would scroll towards start)
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowX) || el.scrollWidth <= el.clientWidth + 2) continue;
      if (dir > 0 ? el.scrollLeft > 1 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    }
    return false;
  }
  // what a swipe in direction dir would do right now (null = nothing)
  function action(dir) {
    if (dir > 0) { // left -> right
      if (modalOpen()) return { kind: 'close', el: o.modal };
      if (/^#\/(d|page)\//.test(location.hash)) return { kind: 'back', el: o.view };
      const i = TABS.indexOf(o.tabOf(location.hash));
      return i > 0 ? { kind: 'tab', tab: TABS[i - 1], el: o.view } : null;
    }
    if (inDetail()) return null; // no "forward" from a detail view
    const i = TABS.indexOf(o.tabOf(location.hash));
    return i >= 0 && i < TABS.length - 1 ? { kind: 'tab', tab: TABS[i + 1], el: o.view } : null;
  }
  const setX = (el, x, anim) => {
    el.style.transition = anim ? `transform ${anim}ms cubic-bezier(.2,.7,.3,1), opacity ${anim}ms` : 'none';
    el.style.transform = x ? `translate3d(${x}px,0,0)` : '';
    el.style.opacity = x ? String(Math.max(0.55, 1 - Math.abs(x) / W() * 0.45)) : '';
  };
  const after = (ms, f) => setTimeout(f, reduce.matches ? 0 : ms);

  function start(e) {
    s = null;
    if (e.touches.length !== 1) return;
    if (window.visualViewport && visualViewport.scale > 1.01) return; // page is pinch-zoomed: let the user pan
    const t = e.touches[0], tg = e.target;
    if (tg.closest && tg.closest('input,textarea,select,[contenteditable],[data-noswipe]')) return;
    const sel = window.getSelection && getSelection(); if (sel && !sel.isCollapsed && String(sel).trim()) return;
    const edge = t.clientX < EDGE || t.clientX > W() - EDGE;
    if (edge && !o.standalone()) return; // in a Safari tab the browser owns edge swipes (its back/forward triggers hashchange)
    s = { x0: t.clientX, y0: t.clientY, t0: performance.now(), x: t.clientX, y: t.clientY, edge, target: tg, lock: null, act: null, dir: 0, hist: [[performance.now(), t.clientX]] };
  }
  function move(e) {
    if (!s) return;
    if (e.touches.length !== 1) { cancel(); return; } // second finger = pinch
    const t = e.touches[0], dx = t.clientX - s.x0, dy = t.clientY - s.y0, now = performance.now(); s.x = t.clientX; s.y = t.clientY;
    s.hist.push([now, t.clientX]); while (s.hist.length > 2 && now - s.hist[0][0] > 100) s.hist.shift(); // recent samples for flick speed
    if (!s.lock) {
      if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.3) { s = null; return; } // vertical: leave it to scrolling
      s.dir = dx > 0 ? 1 : -1;
      if (!s.edge && scrollerBlocks(s.target, s.dir)) { s = null; return; }
      s.lock = 'x'; s.act = action(s.dir); s.el = s.act ? s.act.el : (modalOpen() ? o.modal : o.view);
    }
    if (e.cancelable) e.preventDefault();
    let x = dx; if (!s.act || Math.sign(dx) !== s.dir) x = dx * 0.2; // rubber-band when there's nowhere to go
    if (!reduce.matches) setX(s.el, x);
  }
  function end() {
    if (!s || !s.lock) { s = null; return; }
    const dx = s.x - s.x0, h0 = s.hist[0], dt = Math.max(16, performance.now() - h0[0]), v = Math.abs(s.x - h0[1]) / dt; last = { dx, v, dt };
    const go = s.act && Math.sign(dx) === s.dir && (Math.abs(dx) > COMMIT || (v > FLICK_V && Math.abs(dx) > FLICK_MIN));
    const el = s.el, act = s.act; s = null;
    suppressClick = performance.now() + 400;
    if (!go) { setX(el, 0, 180); after(200, () => setX(el, 0)); return; }
    commit(act, el);
  }
  function cancel() { if (s && s.el) setX(s.el, 0, 150); s = null; }
  function commit(act, el) {
    const dir = act.kind === 'tab' && TABS.indexOf(act.tab) > TABS.indexOf(o.tabOf(location.hash)) ? -1 : 1;
    setX(el, dir * W(), 170);
    after(170, () => {
      if (act.kind === 'close') { o.closeModal(); setX(el, 0); return; }
      if (act.kind === 'back') { if (o.canGoBack()) history.back(); else location.replace('#/search'); }
      else location.hash = o.tabHref(act.tab);
      // incoming view slides in from the opposite side once the route has rendered
      const v = o.view; setX(v, -dir * W() * 0.28); v.style.opacity = '0.6';
      requestAnimationFrame(() => requestAnimationFrame(() => { setX(v, 0, 220); after(240, () => setX(v, 0)); }));
    });
  }
  document.addEventListener('touchstart', start, { passive: true });
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', cancel, { passive: true });
  document.addEventListener('click', e => { if (performance.now() < suppressClick) { e.preventDefault(); e.stopPropagation(); } }, true);
  return { action, get state() { return s; }, get last() { return last; } };
}
