/* ひらく shim — 読み込んだHTMLの一番最初に差し込まれて動く（表示枠の中・別オリジン扱い）
   1 保存   : localStorage / sessionStorage / cookie の代わり。localStorage の中身は親へ送り、本棚に保存する
   2 ZIP    : JS からの後読み（fetch・XHR・img.src など）を親に頼み、中で blob URL にする
   3 リンク : #見出し は自分でスクロール／外のURLは親に開いてもらう／ZIP内の別ページは親が切り替える
   4 読みやすさ : 画面幅に合わせる・文字の大きさ・目次・ページ内検索・続きから
   ※ ここで例外を出すとページが壊れるので、外から呼ばれる所はすべて try で包む */
(function () {
  'use strict';
  var C = window.__HIRAKU__ || {};
  try { delete window.__HIRAKU__; } catch (e) { window.__HIRAKU__ = undefined; }
  var P = window.parent;
  if (!P || P === window) return;
  var hasOwn = Object.prototype.hasOwnProperty;
  var SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  function post(t, d) { d = d || {}; d.h = 'hiraku'; d.t = t; try { P.postMessage(d, '*'); } catch (e) { /* 送れない */ } }

  /* ---------- 1. 保存 ---------- */
  function makeStorage(init, persist) {
    var data = Object.create(null), total = 0, queued = false;
    if (init) for (var k0 in init) if (hasOwn.call(init, k0)) { data[k0] = String(init[k0]); total += k0.length + data[k0].length; }
    function changed() {
      if (!persist || queued) return;
      queued = true;
      Promise.resolve().then(function () {
        queued = false;
        var snap = {};
        for (var k in data) snap[k] = data[k];
        post('ls', { data: snap });
      });
    }
    var api = {
      getItem: function (k) { k = String(k); return hasOwn.call(data, k) ? data[k] : null; },
      setItem: function (k, v) {
        k = String(k); v = String(v);
        var old = hasOwn.call(data, k) ? data[k] : null;
        var next = total - (old === null ? 0 : k.length + old.length) + k.length + v.length;
        if (next > 10485760) throw new DOMException('保存できる量を超えました', 'QuotaExceededError');
        data[k] = v; total = next;
        if (old !== v) changed();
      },
      removeItem: function (k) { k = String(k); if (hasOwn.call(data, k)) { total -= k.length + data[k].length; delete data[k]; changed(); } },
      clear: function () { var had = false; for (var k in data) { delete data[k]; had = true; } total = 0; if (had) changed(); },
      key: function (i) { var ks = Object.keys(data); i = Number(i) | 0; return i >= 0 && i < ks.length ? ks[i] : null; }
    };
    Object.defineProperty(api, 'length', { configurable: true, enumerable: false, get: function () { return Object.keys(data).length; } });
    return new Proxy(api, {
      get: function (t, p) { if (typeof p !== 'string' || p in t) return t[p]; return hasOwn.call(data, p) ? data[p] : undefined; },
      set: function (t, p, v) { if (typeof p === 'string' && !(p in t)) t.setItem(p, v); return true; },
      has: function (t, p) { return (typeof p === 'string' && hasOwn.call(data, p)) || (p in t); },
      deleteProperty: function (t, p) { if (typeof p === 'string' && hasOwn.call(data, p)) t.removeItem(p); return true; },
      ownKeys: function () { return Object.keys(data); },
      getOwnPropertyDescriptor: function (t, p) {
        if (typeof p === 'string' && hasOwn.call(data, p)) return { value: data[p], writable: true, enumerable: true, configurable: true };
        return undefined;
      },
      defineProperty: function (t, p, d) { if (typeof p === 'string' && d && 'value' in d) t.setItem(p, d.value); return true; }
    });
  }
  function defGet(o, n, v) {
    try { Object.defineProperty(o, n, { configurable: true, enumerable: true, get: function () { return v; } }); } catch (e) { /* 上書きできない */ }
  }
  defGet(window, 'localStorage', makeStorage(C.ls, true));
  defGet(window, 'sessionStorage', makeStorage(null, false));
  try {
    var jar = Object.create(null);
    Object.defineProperty(document, 'cookie', {
      configurable: true, enumerable: true,
      get: function () { return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; '); },
      set: function (v) {
        v = String(v);
        var first = v.split(';')[0], i = first.indexOf('=');
        if (i < 0) return;
        var k = first.slice(0, i).trim(), val = first.slice(i + 1).trim();
        var ex = /;\s*expires\s*=([^;]*)/i.exec(v), ma = /;\s*max-age\s*=\s*(-?\d+)/i.exec(v);
        if ((ma && +ma[1] <= 0) || (ex && Date.parse(ex[1]) < Date.now())) delete jar[k]; else jar[k] = val;
      }
    });
  } catch (e) { /* 上書きできない */ }

  /* ---------- 2. ZIP の中の後読み ---------- */
  function resolvePath(baseDir, ref) {
    if (ref == null) return null;
    ref = String(ref).trim();
    if (!ref || SCHEME.test(ref) || ref.slice(0, 2) === '//' || ref.charAt(0) === '#') return null;
    var path = ref.replace(/[?#][\s\S]*$/, '');
    if (!path) return null;
    try { path = decodeURIComponent(path); } catch (e) { /* そのまま */ }
    var parts = path.charAt(0) === '/' ? [] : String(baseDir || '').split('/').filter(Boolean);
    path.split('/').forEach(function (seg) {
      if (!seg || seg === '.') return;
      if (seg === '..') parts.pop(); else parts.push(seg);
    });
    return parts.join('/');
  }
  var assets = null, assetsLower = null;
  if (C.assets && C.assets.length) {
    assets = Object.create(null); assetsLower = Object.create(null);
    C.assets.forEach(function (a) { assets[a] = 1; assetsLower[a.toLowerCase()] = a; });
  }
  function inList(p, set, lower) {
    if (p == null || !set) return null;
    var cands = [p].concat((C.roots || []).map(function (r) { return r + p; }));
    for (var i = 0; i < cands.length; i++) {
      if (set[cands[i]]) return cands[i];
      var l = lower[cands[i].toLowerCase()];
      if (l) return l;
    }
    return null;
  }
  function inZip(ref) { return assets && typeof ref === 'string' ? inList(resolvePath(C.base, ref), assets, assetsLower) : null; }
  var waits = Object.create(null), seq = 0, urls = Object.create(null);
  function need(path) {
    if (!urls[path]) {
      urls[path] = new Promise(function (res, rej) {
        var id = ++seq;
        waits[id] = { res: res, rej: rej };
        post('need', { id: id, path: path });
      }).then(function (blob) { return URL.createObjectURL(blob); });
    }
    return urls[path];
  }
  if (assets) {
    var oFetch = window.fetch;
    if (oFetch) {
      window.fetch = function (input, init) {
        var s = typeof input === 'string' ? input : (typeof URL !== 'undefined' && input instanceof URL ? input.href : null);
        var p = s != null ? inZip(s) : null;
        if (p) return need(p).then(function (u) { return oFetch.call(window, u); });
        return oFetch.apply(this, arguments);
      };
    }
    var X = window.XMLHttpRequest && XMLHttpRequest.prototype;
    if (X) {
      var oOpen = X.open, oSend = X.send, oSetH = X.setRequestHeader;
      X.open = function (m, url, async) {
        var p = (arguments.length < 3 || async !== false) ? inZip(String(url)) : null;
        this.__hk = p ? { p: p, url: url } : null;
        if (!p) return oOpen.apply(this, arguments);
      };
      X.setRequestHeader = function () { if (this.__hk) return; return oSetH.apply(this, arguments); };
      X.send = function () {
        var x = this, hk = x.__hk;
        if (!hk) return oSend.apply(this, arguments);
        need(hk.p).then(function (u) { oOpen.call(x, 'GET', u, true); oSend.call(x); },
          function () { oOpen.call(x, 'GET', hk.url, true); oSend.call(x); });
      };
    }
    var MEDIA = /^(img|audio|video|source|script|track|embed)$/;
    var patchSrc = function (Ctor, attr) {
      if (!Ctor) return;
      var d = Object.getOwnPropertyDescriptor(Ctor.prototype, attr);
      if (!d || !d.set) return;
      Object.defineProperty(Ctor.prototype, attr, {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) {
          var p = inZip(String(v));
          if (!p) { this.__hkWant = null; return d.set.call(this, v); }
          var el = this;
          el.__hkWant = p;
          need(p).then(function (u) { if (el.__hkWant === p) d.set.call(el, u); });
        }
      });
    };
    patchSrc(window.HTMLImageElement, 'src');
    patchSrc(window.HTMLMediaElement, 'src');
    patchSrc(window.HTMLSourceElement, 'src');
    patchSrc(window.HTMLScriptElement, 'src');
    patchSrc(window.HTMLVideoElement, 'poster');
    var oSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      if ((n === 'src' || n === 'poster') && MEDIA.test(this.localName)) {
        var p = inZip(String(v));
        if (p) {
          var el = this;
          el.__hkWant = p;
          need(p).then(function (u) { if (el.__hkWant === p) oSetAttr.call(el, n, u); });
          return;
        }
      }
      return oSetAttr.apply(this, arguments);
    };
    var fixEl = function (el) {
      if (!el.getAttribute || !MEDIA.test(el.localName)) return;
      var s = el.getAttribute('src');
      var p = s ? inZip(s) : null;
      if (p) need(p).then(function (u) { if (el.getAttribute('src') === s) oSetAttr.call(el, 'src', u); });
    };
    try {
      new MutationObserver(function (ms) {
        ms.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            fixEl(n);
            if (n.querySelectorAll) Array.prototype.forEach.call(n.querySelectorAll('[src]'), fixEl);
          });
        });
      }).observe(document, { childList: true, subtree: true });
    } catch (e) { /* 古い端末 */ }
  }

  /* ---------- 3. リンク ---------- */
  var pages = null, pagesLower = null;
  if (C.pages && C.pages.length) {
    pages = Object.create(null); pagesLower = Object.create(null);
    C.pages.forEach(function (a) { pages[a] = 1; pagesLower[a.toLowerCase()] = a; });
  }
  function jump(id) {
    if (!id) { window.scrollTo(0, 0); return; }
    try { id = decodeURIComponent(id); } catch (e) { /* そのまま */ }
    var el = document.getElementById(id) || document.getElementsByName(id)[0];
    try { history.replaceState(history.state, '', '#' + id); } catch (e) { /* 書き換えできない */ }
    if (el) { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    try { window.dispatchEvent(new HashChangeEvent('hashchange')); } catch (e) { /* 古い端末 */ }
  }
  window.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    var t = ev.target;
    var a = t && t.closest ? t.closest('a,area') : null;
    if (!a) return;
    var raw = a.getAttribute('href');
    if (raw == null) raw = a.getAttribute('xlink:href');
    if (raw == null) return;
    raw = raw.trim();
    if (!raw || /^javascript:/i.test(raw) || a.hasAttribute('download')) return;
    if (raw.charAt(0) === '#') { ev.preventDefault(); jump(raw.slice(1)); return; }
    if (/^(data|blob):/i.test(raw)) return;
    if (SCHEME.test(raw) || raw.slice(0, 2) === '//') {
      ev.preventDefault();
      // 外のページは、親が「どこへ行くか」を見せて、もう一度押してもらってから開く（偽の画面へ連れ出されない＝Codex審査）
      post('open', { url: (raw.slice(0, 2) === '//' ? 'https:' + raw : raw).slice(0, 2000) });
      return;
    }
    ev.preventDefault();
    var at = raw.indexOf('#'), frag = at >= 0 ? raw.slice(at + 1) : '';
    var pg = inList(resolvePath(C.base, raw), pages, pagesLower);
    if (pg) { if (pg === C.entry) jump(frag); else post('nav', { path: pg, frag: frag }); return; }
    var ap = inZip(raw);
    if (ap) { post('file', { path: ap }); return; }
    post('nolink', { href: raw.slice(0, 200) });
  }, false);

  /* ---------- 4. 読みやすさ ---------- */
  // 拡大・縮小は親が表示枠ごと transform で行う（中で CSS zoom を使うと WebKit で位置計算がずれる＝2026-10-30 試験）。
  // ここではページの横幅を測って親に知らせるだけ。
  function size() {
    var de = document.documentElement, b = document.body;
    if (!de || !b) return;
    post('size', { w: Math.max(de.scrollWidth, b.scrollWidth), vw: de.clientWidth || window.innerWidth, vp: !!document.querySelector('meta[name="viewport" i]') });
  }

  var tocEls = [];
  function toc() {
    tocEls = [];
    var items = [], hs = document.querySelectorAll('h1,h2,h3');
    for (var i = 0; i < hs.length && items.length < 120; i++) {
      var h = hs[i], t = (h.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || !h.getClientRects().length) continue;
      tocEls.push(h);
      items.push({ t: t.length > 60 ? t.slice(0, 58) + '…' : t, lv: +h.tagName.charAt(1) });
    }
    post('toc', { items: items });
  }

  var HL = !!(window.CSS && CSS.highlights && window.Highlight), hits = [], marks = [], cur = -1, styled = false;
  function addStyle() {
    if (styled) return;
    styled = true;
    var s = document.createElement('style');
    s.setAttribute('data-hiraku', '');
    s.textContent = '::highlight(hiraku-hit){background-color:#ffe27a;color:#191714}' +
      '::highlight(hiraku-cur){background-color:#d9480f;color:#fff}' +
      'mark[data-hiraku]{background:#ffe27a;color:#191714;padding:0}mark[data-hiraku].cur{background:#d9480f;color:#fff}';
    (document.head || document.documentElement).appendChild(s);
  }
  function clearFind() {
    if (HL) { CSS.highlights.delete('hiraku-hit'); CSS.highlights.delete('hiraku-cur'); }
    marks.forEach(function (m) {
      var par = m.parentNode;
      if (!par) return;
      par.replaceChild(document.createTextNode(m.textContent), m);
      par.normalize();
    });
    marks = []; hits = []; cur = -1;
  }
  function visible(el) {
    if (!el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function find(q) {
    clearFind();
    addStyle();
    q = String(q || '').toLowerCase();
    if (!q.trim() || !document.body) { post('found', { n: 0, i: -1 }); return; }
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1 };
    var tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return n.parentNode && SKIP[n.parentNode.nodeName] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    var memo = new Map(), found = [], n;
    while ((n = tw.nextNode()) && found.length < 500) {
      var s = n.nodeValue.toLowerCase(), i = s.indexOf(q);
      if (i < 0) continue;
      var pe = n.parentElement;
      if (!pe) continue;
      var vis = memo.get(pe);
      if (vis === undefined) { vis = visible(pe); memo.set(pe, vis); }
      if (!vis) continue;
      while (i >= 0 && found.length < 500) { found.push([n, i]); i = s.indexOf(q, i + q.length); }
    }
    var mk = function (f) { var r = document.createRange(); r.setStart(f[0], f[1]); r.setEnd(f[0], Math.min(f[0].length, f[1] + q.length)); return r; };
    if (HL) {
      found.forEach(function (f) { try { hits.push(mk(f)); } catch (e) { /* 位置ずれ */ } });
      if (hits.length) CSS.highlights.set('hiraku-hit', new Highlight(...hits));
    } else {
      for (var k = found.length - 1; k >= 0; k--) {
        try {
          var m = document.createElement('mark');
          m.setAttribute('data-hiraku', '');
          mk(found[k]).surroundContents(m);
          marks.unshift(m);
        } catch (e) { /* 包めない所は飛ばす */ }
      }
      hits = marks.slice();
    }
    go(0);
  }
  function go(i) {
    if (!hits.length) { post('found', { n: 0, i: -1 }); return; }
    cur = ((i % hits.length) + hits.length) % hits.length;
    var target;
    if (HL) {
      CSS.highlights.set('hiraku-cur', new Highlight(hits[cur]));
      target = hits[cur].startContainer.parentElement;
    } else {
      hits.forEach(function (m, k) { m.classList.toggle('cur', k === cur); });
      target = hits[cur];
    }
    if (target) target.scrollIntoView({ block: 'center' });
    post('found', { n: hits.length, i: cur });
  }

  var scroller = null, posT = null;
  function cssPath(el) {
    if (el.id) { try { return '#' + CSS.escape(el.id); } catch (e) { /* 古い端末 */ } }
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && parts.length < 14) {
      var i = 1, s = el;
      while ((s = s.previousElementSibling)) i++;
      parts.unshift(el.localName + ':nth-child(' + i + ')');
      el = el.parentElement;
    }
    return 'body>' + parts.join('>');
  }
  function scrollBox() {
    var R = C.restore;
    if (scroller) return scroller;
    if (R && R.el) { try { var e = document.querySelector(R.el); if (e) return e; } catch (x) { /* 形が変わった */ } }
    return document.scrollingElement || document.documentElement;
  }
  function sendPos() {
    var el = scroller || document.scrollingElement || document.documentElement;
    var y = el.scrollTop, max = el.scrollHeight - el.clientHeight;
    post('pos', { y: Math.round(y), r: max > 0 ? Math.min(1, y / max) : 0, el: scroller ? cssPath(scroller) : '' });
  }
  document.addEventListener('scroll', function (ev) {
    var t = ev.target;
    var el = (t === document || t === document.documentElement || t === document.body) ? null : t;
    if (el && el.scrollHeight - el.clientHeight < 300) return;
    scroller = el;
    if (posT) return;
    posT = setTimeout(function () { posT = null; sendPos(); }, 600);
  }, { capture: true, passive: true });
  // R = { y, r, el, same }（same＝前回と同じ倍率なら y を、違えば割合 r を使う）
  function restore(R) {
    if (!R || !(R.y > 0 || R.r > 0)) return false;
    C.restore = R;
    var box = scrollBox();
    var max = box.scrollHeight - box.clientHeight;
    box.scrollTop = R.same ? R.y : R.r * max;
    return true;
  }
  function checkMissing() {
    var n = 0;
    var rel = function (s) { return s && !SCHEME.test(s) && s.slice(0, 2) !== '//' && s.charAt(0) !== '#'; };
    Array.prototype.forEach.call(document.images, function (img) {
      if (rel(img.getAttribute('src')) && img.complete && img.naturalWidth === 0) n++;
    });
    Array.prototype.forEach.call(document.querySelectorAll('link[rel~="stylesheet"][href],script[src]'), function (e) {
      if (rel(e.getAttribute('href') || e.getAttribute('src'))) n++;
    });
    if (n) post('missing', { n: n });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== P) return;
    var d = ev.data;
    if (!d || d.h !== 'hiraku') return;
    ev.stopImmediatePropagation();
    try {
      switch (d.t) {
        case 'asset': {
          var w = waits[d.id];
          if (w) { delete waits[d.id]; if (d.blob) w.res(d.blob); else w.rej(new Error('missing')); }
          break;
        }
        case 'find': find(d.q); break;
        case 'next': go(cur + 1); break;
        case 'prev': go(cur - 1); break;
        case 'unfind': clearFind(); break;
        case 'goto': if (tocEls[d.i]) tocEls[d.i].scrollIntoView({ block: 'start' }); break;
        case 'restore': post('restored', { ok: restore(d.R) }); break;
        case 'size': size(); break;
        case 'top': scrollBox().scrollTop = 0; window.scrollTo(0, 0); break;
        case 'jump': jump(d.frag); break;
        case 'toc': toc(); break;
        case 'pos': sendPos(); break;
      }
    } catch (e) { /* ページを壊さない */ }
  }, false);

  var done = false;
  function ready() {
    if (done) return;
    done = true;
    try { size(); } catch (e) { /* 測れない */ }
    try { toc(); checkMissing(); } catch (e) { /* 続ける */ }
    post('ready', { title: document.title || '' });
  }
  // 外の部品（CDN など）が電波なしで止まっても、3秒で使える状態にする
  document.addEventListener('DOMContentLoaded', function () { setTimeout(ready, 3000); });
  window.addEventListener('load', function () { setTimeout(ready, 60); });
  window.addEventListener('error', function (e) { post('err', { m: String((e && e.message) || '').slice(0, 200) }); });
  post('hello', {});
})();
