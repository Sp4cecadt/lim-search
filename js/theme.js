// Appearance bootstrap. Loaded as a blocking classic script in <head> so the theme is set before first paint (no flash).
(function () {
  var MODES = ['system', 'light', 'dark'];
  var SCHEMES = [
    { id: 'hivis', name: 'Hi-Vis', sb: '#1c2026', dk: '#ffd23f', lt: '#ffcc00' },
    { id: 'ocean', name: 'Ocean', sb: '#0a4a94', dk: '#4da3ff', lt: '#0a64c8' },
    { id: 'lagoon', name: 'Lagoon', sb: '#00574e', dk: '#2ec4b6', lt: '#00877a' },
    { id: 'eucalypt', name: 'Eucalypt', sb: '#22552a', dk: '#6fcf8a', lt: '#2e7d32' },
    { id: 'jacaranda', name: 'Jacaranda', sb: '#43289a', dk: '#b39dff', lt: '#6a3fd1' },
    { id: 'graphite', name: 'Graphite', sb: '#2f3a46', dk: '#c9d1d9', lt: '#36414e' },
    { id: 'ios', name: 'iOS', sub: 'Apple style', sb: '#1c1c1e', dk: '#0a84ff', lt: '#8e8e93', dbg: '#000000', lhdr: '#f9f9f9' },
    { id: 'manual', name: 'Manual', sub: 'LIM colours', sb: '#2a7f7a', dk: '#44b6b0', lt: '#ed7d31', dbg: '#0b2523', lhdr: '#44b6b0' }
  ];
  var DARK_BG = '#0d1117', LIGHT_HDR = '#ffffff';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: true };
  var sa = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : { matches: false };
  function read(k, d, ok) { try { var v = localStorage.getItem(k); return ok(v) ? v : d; } catch (e) { return d; } }
  function mode() { return read('lim.mode', 'system', function (v) { return MODES.indexOf(v) >= 0; }); }
  function scheme() { return read('lim.scheme', 'hivis', function (v) { return SCHEMES.some(function (s) { return s.id === v; }); }); }
  function apply() {
    var m = mode(), s = scheme(), r = m === 'system' ? (mq.matches ? 'dark' : 'light') : m, h = document.documentElement;
    h.setAttribute('data-mode', r); h.setAttribute('data-scheme', s); h.style.colorScheme = r;
    var sc = SCHEMES.filter(function (x) { return x.id === s; })[0];
    // Status bar: in a Home Screen app the iOS status bar text is always white (black-translucent), so light mode puts a solid
    // scheme-coloured band behind it; in a Safari tab theme-color tints the browser bar, so it matches the header.
    var standalone = navigator.standalone || sa.matches;
    var tc = r === 'dark' ? (sc.dbg || DARK_BG) : standalone ? sc.sb : (sc.lhdr || LIGHT_HDR);
    var meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', tc);
    return { mode: m, resolved: r, scheme: s };
  }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} return apply(); }
  var onChange = function () { if (mode() === 'system') apply(); };
  if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  window.LIMTheme = { MODES: MODES, SCHEMES: SCHEMES, apply: apply, mode: mode, scheme: scheme,
    setMode: function (v) { return set('lim.mode', v); }, setScheme: function (v) { return set('lim.scheme', v); } };
  apply();
})();
