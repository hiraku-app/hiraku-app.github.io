// ひらく — 画面の動き（本棚・表示・せってい・暗証番号・ホーム追加の案内）
// 読み込んだHTMLは sandbox の iframe（allow-same-origin なし）で動かす。題名などファイル由来の文字は
// すべて textContent で入れ、innerHTML には渡さない。
import { Pack, buildView, titleOf, kindLabel, decodeText, loadShim } from './pack.js';
import { isZip } from './zip.js';

const VERSION = '1.0.0';
const HDB = window.HDB;
const $ = s => document.querySelector(s);
const SIZES = [[0.85, '小さめ', 20], [1, 'ふつう', 26], [1.25, '大きめ', 32], [1.5, 'とても大きい', 38]];
const LOCK_DELAYS = [[0, 'すぐ'], [60000, '1分たったら'], [300000, '5分たったら']];
// 別窓（popups）は許さない：外のページは親が行き先を見せてから開く（偽の画面へ連れ出されない＝Codex審査）
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-downloads';

/* ---------- 小道具 ---------- */
const ICON = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M5.5 18.5l2.1-2.1M16.4 7.6l2.1-2.1"/>',
  toc: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.5M4.5 12h.5M4.5 18h.5" stroke-width="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5"/>',
  text: '<path d="M3 19L8 6l5 13M4.8 14.5h6.4M14.5 19l3.2-8.5L21 19M15.6 16.3h4.3"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M8 10H5v11h14V10h-3"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>'
};
const svg = (n, s = 26) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;
function paintIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (el.dataset.painted) return;
    el.dataset.painted = '1';
    el.insertAdjacentHTML('afterbegin', svg(el.dataset.icon, el.classList.contains('ico-inline') ? 20 : 26));
  });
}
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}
const fmtSize = n => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + 'KB' : (n / 1048576).toFixed(1) + 'MB');
function fmtDay(t) {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return '今日';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'きのう';
  return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '年' : '') + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256(buf) {
  try { return hex(await crypto.subtle.digest('SHA-256', buf)); } catch (e) { return ''; }
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const ENV = (() => {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const line = /\bLine\//i.test(ua);
  const inapp = line || /FBAN|FBAV|Instagram|KAKAOTALK|YJApp|\bGSA\//.test(ua);
  const standalone = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  return { ios, android, line, inapp, standalone };
})();
const appUrl = () => new URL('./', location.href).href + '?openExternalBrowser=1';

/* ---------- 状態 ---------- */
const S = {
  docs: [], cur: null, settings: { scale: 1, lockDelay: 60000 }, pin: null,
  layers: [], afterPop: null, bip: null, newIds: new Set(), hiddenAt: 0, pickingAt: 0, locked: false, lastOpen: 0
};

/* ---------- 保存（少し待ってまとめて書く） ---------- */
const timers = new Map();
function later(key, fn, ms = 500) {
  const old = timers.get(key);
  if (old) clearTimeout(old.t);
  timers.set(key, { t: setTimeout(() => { timers.delete(key); fn(); }, ms), fn });
}
function flushAll() {
  for (const v of timers.values()) { clearTimeout(v.t); v.fn(); }
  timers.clear();
}
const gone = new Set();
const saveDocSoon = d => { if (!gone.has(d.id)) later('doc:' + d.id, () => { if (!gone.has(d.id)) HDB.put('docs', d).catch(() => {}); }); };
// アプリの保存データは待たずにすぐ書く。書いている間に来た分は、終わってから最新の1つだけ書く（取りこぼし防止＝Codex審査）
const lsWrite = new Map();
function saveLs(id, data) {
  if (gone.has(id)) return;
  let st = lsWrite.get(id);
  if (!st) { st = { busy: false, next: null }; lsWrite.set(id, st); }
  st.next = data;
  if (st.busy) return;
  const run = () => {
    const d = st.next;
    st.next = null;
    if (!d || gone.has(id)) { st.busy = false; return; }
    st.busy = true;
    HDB.put('appdata', d, id).catch(() => {}).then(() => { if (st.next) run(); else st.busy = false; });
  };
  run();
}
function forget(id) {
  gone.add(id);
  const t = timers.get('doc:' + id);
  if (t) { clearTimeout(t.t); timers.delete('doc:' + id); }
}
// 読み込んだページから来た知らせは信用しない：形・長さを確かめてから使う（Codex審査）
function cleanLs(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const out = {};
  let n = 0, size = 0;
  for (const k of Object.keys(x)) {
    const v = x[k];
    if (typeof v !== 'string') return null;
    size += k.length + v.length;
    if (++n > 20000 || size > 11 * 1048576) return null;
    out[k] = v;
  }
  return out;
}
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
async function saveSettings() { try { await HDB.put('kv', S.settings, 'settings'); } catch (e) { /* 続ける */ } }

/* ---------- 戻る（Android の戻るボタンと画面の「本棚」をそろえる） ---------- */
function pushLayer(layer) {
  S.layers.push(layer);
  history.pushState({ hk: S.layers.length }, '');
}
function goBack() { if (S.layers.length) history.back(); }
function closeTopThen(fn) { S.afterPop = fn; goBack(); }
window.addEventListener('popstate', () => {
  const n = (history.state && history.state.hk) || 0;
  while (S.layers.length > n) {
    const l = S.layers.pop();
    try { l.close && l.close(); } catch (e) { console.error(e); }
  }
  const f = S.afterPop;
  S.afterPop = null;
  if (f) setTimeout(f, 0);
});

/* ---------- お知らせ帯 ---------- */
function banner(where, text, kind = '', actions = [], hideMs = 0) {
  const box = where === 'v' ? $('#vBanner') : $('#notice');
  box.textContent = '';
  const acts = h('div', { class: 'acts' });
  const el = h('div', { class: 'banner ' + kind, role: kind === 'err' ? 'alert' : 'status' }, h('p', {}, text), acts);
  for (const [label, fn] of actions) acts.append(h('button', { type: 'button', onclick: () => { el.remove(); fn(); } }, label));
  acts.append(h('button', { type: 'button', onclick: () => el.remove() }, 'とじる'));
  box.append(el);
  if (hideMs || (!kind && !actions.length)) setTimeout(() => el.remove(), hideMs || 9000);
  return el;
}

/* ---------- 下から出る板 ---------- */
function sheet(title, body) {
  const back = h('div', { class: 'sheet-back' });
  const box = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h3', {}, title), h('button', { type: 'button', onclick: goBack }, 'とじる')),
    body);
  back.append(box);
  back.addEventListener('click', e => { if (e.target === back) goBack(); });
  document.body.append(back);
  paintIcons(box);
  pushLayer({ type: 'sheet', close: () => back.remove() });
  return box;
}
function menuList(items) {
  return h('ul', { class: 'menu' }, items.map(([label, fn, cls]) =>
    h('li', {}, h('button', { type: 'button', class: cls || '', onclick: fn }, label))));
}

/* ---------- 本棚 ---------- */
async function loadDocs() {
  S.docs = (await HDB.all('docs')) || [];
}
function renderList() {
  const ul = $('#list');
  ul.textContent = '';
  const q = $('#filter').value.trim().toLowerCase();
  $('#count').textContent = S.docs.length + '冊';
  $('#filter').hidden = S.docs.length < 7;
  const docs = [...S.docs].sort((a, b) => b.openedAt - a.openedAt)
    .filter(d => !q || d.title.toLowerCase().includes(q) || (d.fileName || '').toLowerCase().includes(q));
  if (!docs.length) {
    ul.append(h('li', { class: 'empty' }, q ? '見つかりませんでした。' : 'まだ何も入っていません。上の「HTMLファイルをえらぶ」から入れてください。'));
  }
  for (const d of docs) {
    const pct = d.pos && d.pos.r > 0.02 && d.pos.r < 0.98 ? Math.round(d.pos.r * 100) : 0;
    // 背表紙の太さ＝ファイルの大きさ（厚い本ほど太い）
    const thick = 46 + Math.min(18, Math.max(0, Math.round(Math.log2(Math.max(1, (d.size || 0) / 4096)) * 2)));
    ul.append(h('li', { class: 'book' + (S.newIds.has(d.id) ? ' new' : '') },
      h('button', { type: 'button', class: 'book-open', onclick: () => openDoc(d.id) },
        h('span', { class: 'spine k-' + d.label, style: '--w:' + thick + 'px' }, d.label),
        h('span', { class: 'book-body' },
          h('span', { class: 'book-title' }, d.title),
          h('span', { class: 'book-meta' }, pct ? h('b', {}, '続き ' + pct + '%') : null, pct ? '・' : null,
            fmtDay(d.openedAt) + 'に開いた・' + fmtSize(d.size)))),
      h('button', { type: 'button', class: 'book-more', 'aria-label': d.title + ' のメニュー', 'data-icon': 'more', onclick: () => bookMenu(d) }, h('span', {}, 'メニュー'))));
  }
  paintIcons(ul);
}

function looksHtml(u8, name) {
  if (/\.(x?html?|shtml)$/i.test(name)) return true;
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 4096));
  return /<(!doctype\s+html|html|head|body)\b/i.test(head);
}
function errText(e, name) {
  const m = (e && (e.message || e.name)) || '';
  if (m === 'NOT_HTML') return '「' + name + '」はHTMLファイルではないようです。名前の最後が .html か .zip のファイルを選んでください。';
  if (m === 'NO_HTML_IN_ZIP') return '「' + name + '」の中にHTMLファイルが入っていません。';
  if (m === 'ZIP_ENCRYPTED') return '「' + name + '」はパスワード付きのZIPなので開けません。パスワードなしで作り直してください。';
  if (m === 'ZIP_TOO_BIG' || m === 'ZIP_TOO_MANY') return '「' + name + '」は大きすぎて、スマホでは開けません（中身の合計200MBまで・5000ファイルまで）。';
  if (/^ZIP_/.test(m)) return '「' + name + '」のZIPを読めませんでした（こわれているか、対応していない形です）。';
  if (/Quota/i.test(m)) return 'スマホの空き容量が足りないため、入れられませんでした。';
  return '「' + name + '」を読みこめませんでした。（' + m + '）';
}
async function importOne(name, buf, extra = {}) {
  const u8 = new Uint8Array(buf);
  const hash = await sha256(buf);
  const dup = hash && S.docs.find(d => d.hash === hash);
  if (dup) return { doc: dup, dup: true };
  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const base = name.replace(/\.[^.]+$/, '') || '名前のないファイル';
  let doc;
  if (isZip(u8)) {
    const pack = new Pack(buf);
    const entry = pack.mainHtml();
    if (!entry) throw new Error('NO_HTML_IN_ZIP');
    const html = decodeText(await pack.bytes(entry));
    doc = { id, kind: 'zip', entry, title: titleOf(html, base), label: '写真', pages: pack.htmls().length };
  } else {
    if (!looksHtml(u8, name)) throw new Error('NOT_HTML');
    const html = decodeText(u8);
    doc = { id, kind: 'html', title: titleOf(html, base), label: kindLabel(html) };
  }
  Object.assign(doc, { fileName: name, size: buf.byteLength, hash, addedAt: Date.now(), openedAt: Date.now(), pos: null, scale: null, fit: true }, extra);
  await HDB.putDoc(doc, buf);
  S.docs.push(doc);
  return { doc, dup: false };
}
// 返り値：ファイルごとの結果 [{ ok, quota }]（共有の受け取り箱で、入れ終わった物だけ消すのに使う）
async function importFiles(files) {
  const wait = banner('s', '読みこんでいます…');
  const added = [], dups = [], results = [];
  for (const f of files) {
    try {
      const r = await importOne(f.name || 'ファイル', await f.arrayBuffer());
      (r.dup ? dups : added).push(r.doc);
      results.push({ ok: true });
    } catch (e) {
      console.error(e);
      results.push({ ok: false, quota: /Quota/i.test((e && (e.name + e.message)) || '') });
      banner('s', errText(e, f.name || 'ファイル'), 'err');
    }
  }
  wait.remove();
  S.newIds = new Set(added.map(d => d.id));
  renderList();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 続ける */ }
  const all = added.concat(dups);
  if (all.length === 1) {
    if (dups.length) banner('s', '同じファイルが本棚にあったので、そちらを開きます。');
    openDoc(all[0].id);
  } else if (all.length > 1) {
    banner('s', added.length + '冊を本棚に入れました。' + (dups.length ? '（' + dups.length + '冊は同じものが入っていました）' : ''), 'ok');
  }
  return results;
}

/* ---------- 表示 ---------- */
function send(t, d = {}) {
  const c = S.cur;
  if (c && c.frame && c.frame.contentWindow) c.frame.contentWindow.postMessage(Object.assign({}, d, { h: 'hiraku', t }), '*');
}
function setStatus(text) {
  const box = $('#vBox');
  let st = box.querySelector('.vstatus');
  if (!text) { if (st) st.remove(); return; }
  if (!st) { st = h('div', { class: 'vstatus' }); box.append(st); }
  st.textContent = text;
}
async function openDoc(id) {
  const doc = S.docs.find(d => d.id === id);
  if (!doc) return;
  if (S.cur) closeViewerUI();
  delete document.documentElement.dataset.viewReady;
  S.cur = { doc, bytes: null, pack: null, entry: null, frame: null, url: null, toc: [], fit: doc.fit !== false, scale: doc.scale || S.settings.scale || 1 };
  $('#viewer').hidden = false;
  $('#vTitle').textContent = doc.title;
  $('#vBanner').textContent = '';
  pushLayer({ type: 'viewer', close: closeViewerUI });
  doc.openedAt = Date.now();
  saveDocSoon(doc);
  const c = S.cur;
  try {
    c.bytes = await HDB.get('files', id);
    if (!c.bytes) throw new Error('本体が見つかりません');
    if (doc.kind === 'zip') c.pack = new Pack(c.bytes);
    c.ls = (await HDB.get('appdata', id)) || {};
    if (doc.size > 60 * 1048576) banner('v', '大きいファイルなので、開くまで時間がかかることがあります。');
    await showEntry(doc.kind === 'zip' ? doc.entry : null);
  } catch (e) {
    console.error(e);
    if (S.cur === c) { setStatus(''); banner('v', 'ひらけませんでした。（' + (e.message || e) + '）', 'err'); }
  }
}
async function showEntry(entry, frag) {
  const c = S.cur;
  if (!c) return;
  c.entry = entry;
  c.toc = [];
  c.frag = frag || '';
  c.missingShown = false;
  setStatus('ひらいています…');
  c.main = !entry || entry === c.doc.entry;
  const html = await buildView(c.doc, c.bytes, { pack: c.pack, entry, ls: c.ls });
  if (S.cur !== c) return;
  mountFrame(html, 'text/html;charset=utf-8');
}
// 文字の大きさ・画面幅合わせ＝表示枠ごと transform で伸び縮みさせる。
// z＝(幅合わせ ? 画面幅 / ページの横幅 : 1) × 文字の倍率。枠の中の幅は「画面幅 / z」なので横に余白も出ない。
function applyScale() {
  const c = S.cur;
  if (!c || !c.frame) return;
  const box = $('#vBox');
  const bw = box.clientWidth, bh = box.clientHeight;
  if (!bw || !bh) return;
  const z = (c.fit && c.wideW ? bw / c.wideW : 1) * c.scale;
  c.z = Math.round(z * 1000) / 1000;
  const f = c.frame;
  f.style.width = bw / z + 'px';
  f.style.height = bh / z + 'px';
  f.style.transform = Math.abs(z - 1) < 0.001 ? 'none' : 'scale(' + z + ')';
}
function mountFrame(content, type) {
  const c = S.cur;
  const box = $('#vBox');
  if (c.frame) c.frame.remove();
  if (c.url) URL.revokeObjectURL(c.url);
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', SANDBOX);
  f.setAttribute('allow', 'fullscreen; autoplay; clipboard-write');
  f.setAttribute('title', c.doc.title);
  c.url = URL.createObjectURL(new Blob([content], { type }));
  f.src = c.url;
  c.frame = f;
  delete document.documentElement.dataset.viewReady;
  c.measuring = true;
  c.wideW = 0;
  box.prepend(f);
  applyScale();
  clearTimeout(c.readyT);
  c.readyT = setTimeout(() => { if (S.cur === c) setStatus(''); }, 6000);
}
function closeViewerUI() {
  const c = S.cur;
  if (!c) return;
  flushAll();
  if (c.frame) c.frame.remove();
  if (c.url) URL.revokeObjectURL(c.url);
  clearTimeout(c.readyT);
  S.cur = null;
  $('#viewer').hidden = true;
  $('#viewer').classList.remove('full');
  const uf = $('#viewer .unfull');
  if (uf) uf.remove();
  $('#vSearch').hidden = true;
  $('#tFind').setAttribute('aria-pressed', 'false');
  $('#vBox').textContent = '';
  renderList();
}
async function navTo(entry, frag) {
  const c = S.cur;
  const prev = c.entry;
  pushLayer({ type: 'page', close: () => { if (S.cur === c) showEntry(prev); } });
  await showEntry(entry, frag);
}
function showAssetPage(path) {
  const c = S.cur;
  c.pack.blob(path).then(blob => {
    const t = blob.type;
    const r = new FileReader();
    r.onload = () => {
      const src = r.result;
      let inner;
      if (/^image\//.test(t)) inner = '<img src="' + src + '" style="max-width:100%;height:auto" alt="">';
      else if (/^video\//.test(t)) inner = '<video src="' + src + '" controls playsinline style="max-width:100%"></video>';
      else if (/^audio\//.test(t)) inner = '<audio src="' + src + '" controls></audio>';
      else { shareFile(new File([blob], path.split('/').pop(), { type: t })); return; }
      pushLayer({ type: 'page', close: () => { if (S.cur === c) showEntry(c.entry); } });
      mountFrame('<!doctype html><meta charset="utf-8"><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#191714">' + inner, 'text/html;charset=utf-8');
      setStatus('');
    };
    r.readAsDataURL(blob);
  }).catch(() => banner('v', 'このファイルは開けませんでした。', 'err'));
}
// 外のページ・電話・メールは、行き先を見せてから開く（押したのは本棚側のボタン＝ブラウザに止められない）
function openOutside(url) {
  if (document.querySelector('.sheet-back')) return;
  let u;
  try { u = new URL(url); } catch (e) { return; }
  const web = /^https?:$/.test(u.protocol);
  const call = /^(mailto|tel|sms):$/.test(u.protocol);
  if (!web && !call) return;
  const label = web ? u.hostname : decodeURIComponent(u.href.replace(/^[a-z]+:/i, '')).slice(0, 80);
  const title = web ? '外のページを開きます' : u.protocol === 'tel:' ? '電話をかけます' : u.protocol === 'sms:' ? 'メッセージを送ります' : 'メールを書きます';
  sheet(title, h('div', {},
    h('p', { class: 'dest' }, label),
    web ? h('p', { class: 'muted small-url' }, u.href.slice(0, 300)) : null,
    web ? h('p', {}, '知らない所へ行く時や、パスワードを聞かれた時は、入力しないでください。') : null,
    h('div', { class: 'row-btns' },
      h('button', { type: 'button', onclick: goBack }, 'やめる'),
      h('button', {
        type: 'button', class: 'go', onclick: () => {
          if (web) window.open(u.href, '_blank', 'noopener');
          else location.href = u.href;
          goBack();
        }
      }, web ? 'そのページを見る' : 'すすむ'))));
}

window.addEventListener('message', async ev => {
  const c = S.cur;
  if (!c || !c.frame || ev.source !== c.frame.contentWindow) return;
  const d = ev.data;
  if (!d || typeof d !== 'object' || d.h !== 'hiraku') return;
  switch (d.t) {
    case 'ls': {
      const ls = cleanLs(d.data);
      if (!ls) break;
      c.ls = ls;
      saveLs(c.doc.id, ls);
      break;
    }
    case 'pos':
      if (c.main) { c.doc.pos = { y: num(d.y, 0, 1e7), r: num(d.r, 0, 1), z: c.z, el: str(d.el, 400) }; saveDocSoon(c.doc); }
      break;
    case 'toc':
      c.toc = Array.isArray(d.items) ? d.items.slice(0, 120).map(it => ({ t: str(it && it.t, 80), lv: num(it && it.lv, 1, 3) })).filter(it => it.t) : [];
      break;
    case 'size':
      // 最初の1回（文字の倍率だけ掛けた幅で測った値）で「パソコン向けの横長ページか」を決める。
      // スマホ向けの印（viewport）があるページは、長い1行で少しはみ出しただけでは縮めない（1.5倍以上で縮める）
      if (!c.measuring) break;
      c.measuring = false;
      c.wideW = num(d.w, 0, 20000) > num(d.vw, 1, 20000) * (d.vp ? 1.5 : 1.08) ? num(d.w, 0, 20000) : 0;
      applyScale();
      break;
    case 'restored':
      if (d.ok && $('#vSearch').hidden) banner('v', '前回の続きから表示しています。', '', [['最初から', () => send('top')]], 20000);
      break;
    case 'found': {
      const q = $('#q').value.trim();
      const n = num(d.n, 0, 100000), i = num(d.i, -1, 100000);
      $('#qCount').textContent = n ? (i + 1) + ' / ' + n : (q ? 'ありません' : '');
      break;
    }
    case 'ready':
      clearTimeout(c.readyT);
      setStatus('');
      // 倍率を当てた後の形で、続きの位置へ戻す（ページ内の#指定があればそちらを優先）
      requestAnimationFrame(() => {
        if (S.cur !== c) return;
        if (c.frag) send('jump', { frag: c.frag });
        else if (c.main && c.doc.pos) send('restore', { R: Object.assign({}, c.doc.pos, { same: Math.abs((c.doc.pos.z || 1) - c.z) < 0.01 }) });
        if ($('#q').value.trim() && !$('#vSearch').hidden) send('find', { q: $('#q').value });
        document.documentElement.dataset.viewReady = '1'; // 試験と遠隔診断の目印（表示の準備ができた）
      });
      break;
    case 'need': {
      if (!c.pack || typeof d.path !== 'string' || (c.needs = (c.needs || 0) + 1) > 5000) break;
      let blob = null;
      try { const p = c.pack.find(d.path.slice(0, 1000)); if (p) blob = await c.pack.blob(p); } catch (e) { /* 無い */ }
      ev.source.postMessage({ h: 'hiraku', t: 'asset', id: num(d.id, 0, 1e9), blob }, '*');
      break;
    }
    case 'open': openOutside(str(d.url, 2000)); break;
    case 'nav': { const p = c.pack && c.pack.find(str(d.path, 1000)); if (p && /\.html?$/i.test(p)) navTo(p, str(d.frag, 200)); break; }
    case 'file': { const p = c.pack && c.pack.find(str(d.path, 1000)); if (p) showAssetPage(p); break; }
    case 'nolink': banner('v', 'このリンクの行き先は、本棚に入っていません。', '', [], 6000); break;
    case 'missing':
      if (c.missingShown || !$('#vSearch').hidden) break;
      c.missingShown = true;
      banner('v', '一部の画像などが表示できていません。', '', [['くわしく', missingSheet]]);
      break;
  }
});
function missingSheet() {
  const zip = S.cur && S.cur.doc.kind === 'zip';
  sheet('画像が出ないとき', h('div', {},
    h('p', {}, zip
      ? 'このZIPの中に、ページが使う画像などが入っていないようです。作った人に、フォルダごとZIPにし直してもらってください。'
      : 'このHTMLは、画像などを別のファイルに分けて使っています。HTMLと画像のフォルダをまとめてZIPにすると、画像も表示できます。'),
    h('p', { class: 'muted' }, '文字は、このまま読めます。')));
}

/* 目次・さがす・文字・送る・その他 */
function tocSheet() {
  const c = S.cur;
  if (!c) return;
  const items = c.toc || [];
  const body = items.length
    ? menuList(items.map((it, i) => [it.t, () => closeTopThen(() => send('goto', { i })), 'lv' + it.lv]))
    : h('p', { class: 'empty' }, 'このページには見出しがありません。「さがす」で言葉から探せます。');
  sheet('目次', body);
}
function toggleSearch(on) {
  $('#vSearch').hidden = !on;
  $('#tFind').setAttribute('aria-pressed', String(on));
  if (on) {
    $('#vBanner').textContent = ''; // 探している間は、お知らせで画面を狭くしない
    $('#q').focus();
    if ($('#q').value.trim()) send('find', { q: $('#q').value });
  } else {
    send('unfind');
    $('#qCount').textContent = '';
  }
}
function sizeSheet() {
  const c = S.cur;
  if (!c) return;
  const grid = h('div', { class: 'sizes' });
  for (const [v, label, fs] of SIZES) {
    grid.append(h('button', {
      type: 'button', 'aria-pressed': String(c.scale === v), style: '--fs:' + fs + 'px',
      onclick: ev => {
        c.scale = v; c.doc.scale = v; saveDocSoon(c.doc);
        applyScale();
        grid.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === ev.currentTarget)));
      }
    }, h('b', {}, 'あ'), label));
  }
  // 「画面の幅に合わせる」は、どちらを選んでいるかが見える2択にする（オン／オフの1ボタンは状態か操作か分かりにくい＝破壊者）
  const fitChoice = h('div', { class: 'choice' });
  for (const [val, label] of [[true, '合わせる'], [false, 'そのまま']]) {
    fitChoice.append(h('button', {
      type: 'button', 'aria-pressed': String(c.fit === val),
      onclick: ev => {
        c.fit = val; c.doc.fit = val; saveDocSoon(c.doc);
        fitChoice.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === ev.currentTarget)));
        applyScale();
      }
    }, label));
  }
  const wide = !!c.wideW;
  sheet('文字の大きさ', h('div', {},
    grid,
    h('div', { class: 'fitbox' },
      h('p', {}, h('b', {}, '画面の幅に'), h('small', {}, wide
        ? 'パソコン向けのページです。「合わせる」にすると、縮めて横に動かさずに全体を見られます。'
        : 'このページは、もともとスマホの幅に合っています。')),
      fitChoice),
    h('div', { class: 'stack', style: 'margin-top:20px' },
      h('button', { type: 'button', onclick: () => closeTopThen(() => send('top')) }, '一番上にもどる'))));
}
function shareFile(file) {
  if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: file.name }).catch(e => { if (e && e.name !== 'AbortError') download(file); });
  } else download(file);
}
function download(file) {
  const a = h('a', { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
function docFile(doc, bytes) {
  const ext = doc.kind === 'zip' ? '.zip' : '.html';
  const name = doc.fileName || (doc.title + ext);
  return new File([bytes], name, { type: doc.kind === 'zip' ? 'application/zip' : 'text/html' });
}
function moreSheet() {
  const c = S.cur;
  if (!c) return;
  const items = [];
  if (c.pack && c.pack.htmls().length > 1) items.push(['ほかのページを開く', () => closeTopThen(pagesSheet)]);
  items.push(['画面いっぱいに表示（上と下の帯を消す）', () => closeTopThen(enterFull)]);
  items.push(['名前を変える', () => closeTopThen(() => renameSheet(c.doc))]);
  items.push(['表示し直す（保存した中身は消えません）', () => closeTopThen(() => showEntry(c.entry))]);
  items.push(['本棚から消す', () => closeTopThen(() => deleteSheet(c.doc)), 'danger']);
  sheet('その他', menuList(items));
}
function pagesSheet() {
  const c = S.cur;
  if (!c || !c.pack) return;
  sheet('ほかのページ', menuList(c.pack.htmls().map(p => [p.replace(c.pack.root, ''), () => closeTopThen(() => { if (p !== c.entry) navTo(p); })])));
}
function enterFull() {
  const v = $('#viewer');
  v.classList.add('full');
  const b = h('button', { type: 'button', class: 'unfull', onclick: goBack }, 'もどす');
  $('#vBox').append(b);
  pushLayer({ type: 'full', close: () => { v.classList.remove('full'); b.remove(); } });
}
function renameSheet(doc) {
  const input = h('input', { class: 'field', type: 'text', value: doc.title, 'aria-label': '新しい名前', enterkeyhint: 'done' });
  const save = () => {
    const v = input.value.trim();
    if (!v) return;
    doc.title = v.slice(0, 80);
    HDB.put('docs', doc).catch(() => {});
    if (S.cur && S.cur.doc === doc) $('#vTitle').textContent = doc.title;
    renderList();
    goBack();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  sheet('名前を変える', h('div', {}, input, h('div', { class: 'row-btns' },
    h('button', { type: 'button', onclick: goBack }, 'やめる'),
    h('button', { type: 'button', class: 'go', onclick: save }, 'この名前にする'))));
  setTimeout(() => input.focus(), 50);
}
function deleteSheet(doc) {
  sheet('本棚から消す', h('div', {},
    h('p', {}, '「' + doc.title + '」を本棚から消します。中で保存したデータも消えます。元のファイルは消えません。'),
    h('div', { class: 'row-btns' },
      h('button', { type: 'button', onclick: goBack }, 'やめる'),
      h('button', {
        type: 'button', class: 'bad', onclick: async () => {
          forget(doc.id);
          try { await HDB.delDoc(doc.id); } catch (e) { gone.delete(doc.id); banner('s', '消せませんでした。', 'err'); return; }
          S.docs = S.docs.filter(d => d.id !== doc.id);
          closeTopThen(() => { if (S.cur && S.cur.doc.id === doc.id) goBack(); else renderList(); });
        }
      }, '消す'))));
}
function bookMenu(doc) {
  const bytesP = HDB.get('files', doc.id);
  sheet(doc.title, menuList([
    ['ひらく', () => closeTopThen(() => openDoc(doc.id))],
    ['ほかの人に送る（LINEなど）', async () => { const b = await bytesP; if (b) shareFile(docFile(doc, b)); }],
    ['名前を変える', () => closeTopThen(() => renameSheet(doc))],
    ['本棚から消す', () => closeTopThen(() => deleteSheet(doc)), 'danger']
  ]));
}

/* ---------- せってい ---------- */
function openSettings() {
  renderSettings();
  $('#shelf').hidden = true;
  $('#settings').hidden = false;
  window.scrollTo(0, 0);
  pushLayer({ type: 'settings', close: () => { $('#settings').hidden = true; $('#shelf').hidden = false; } });
}
function qrSvg(text) {
  if (!window.qrcode) return null;
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + c + ' ' + r + 'h1v1h-1z';
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '-2 -2 ' + (n + 4) + ' ' + (n + 4));
  s.setAttribute('shape-rendering', 'crispEdges');
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', 'このアプリを開くQRコード');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', '#191714');
  s.append(p);
  return s;
}
function renderSettings() {
  const body = $('#sBody');
  body.textContent = '';
  const url = appUrl();
  const sect = (title, ...kids) => h('section', { class: 'sect' }, h('h3', {}, title), ...kids);

  const pinBtns = S.pin
    ? [h('button', { type: 'button', onclick: changePin }, '暗証番号を変える'), h('button', { type: 'button', class: 'danger', onclick: removePin }, '暗証番号をはずす')]
    : [h('button', { type: 'button', class: 'go', onclick: setPinFlow }, '暗証番号をつける')];
  const delay = h('div', { class: 'choice' }, LOCK_DELAYS.map(([ms, label]) => h('button', {
    type: 'button', 'aria-pressed': String(S.settings.lockDelay === ms),
    onclick: () => { S.settings.lockDelay = ms; saveSettings(); renderSettings(); }
  }, label)));
  body.append(sect('暗証番号でロック',
    h('p', {}, S.pin ? 'いまは暗証番号がついています。' : 'ひらくを開くときに、4けたの番号を聞くようにできます。'),
    h('p', { class: 'muted' }, '人に画面をのぞかれないためのものです。ファイルそのものに鍵をかける機能ではありません。'),
    h('div', { class: 'stack' }, pinBtns),
    S.pin ? h('div', {}, h('p', { style: 'margin-top:16px' }, 'ほかのアプリに切り替えて、'), delay) : null));

  body.append(sect('はじめの文字の大きさ',
    h('p', { class: 'muted' }, '新しく開くファイルの文字の大きさです。ファイルごとに「文字」でも変えられます。'),
    h('div', { class: 'choice' }, SIZES.map(([v, label]) => h('button', {
      type: 'button', 'aria-pressed': String(S.settings.scale === v),
      onclick: () => { S.settings.scale = v; saveSettings(); renderSettings(); }
    }, label)))));

  const qr = qrSvg(url);
  body.append(sect('このアプリを人にすすめる',
    h('p', {}, 'QRコードを読み取ってもらうか、リンクを送ってください。'),
    h('div', { class: 'qr-wrap' }, qr, h('code', {}, url.replace(/\?.*$/, ''))),
    h('div', { class: 'stack' },
      h('button', { type: 'button', class: 'go', onclick: () => window.open('https://line.me/R/share?text=' + encodeURIComponent('HTMLファイルをスマホで開ける「ひらく」というアプリです。リンクを開いて、ホーム画面に追加してから使ってください。\n' + url), '_blank', 'noopener') }, 'LINEで送る'),
      h('button', {
        type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(url); banner('s', 'リンクをコピーしました。', 'ok'); } catch (e) { banner('s', 'コピーできませんでした。上のリンクを長押ししてコピーしてください。', 'err'); }
          window.scrollTo(0, 0);
        }
      }, 'リンクをコピーする'),
      navigator.share ? h('button', { type: 'button', onclick: () => navigator.share({ title: 'ひらく', text: 'HTMLファイルをスマホで開けるアプリ「ひらく」', url }).catch(() => {}) }, 'ほかの方法で送る') : null)));

  body.append(sect('ホーム画面に追加',
    h('p', {}, ENV.standalone ? 'ホーム画面から開いています。' : 'ホーム画面に追加すると、アプリとして使えます。'),
    ENV.standalone ? null : h('div', { class: 'stack' }, h('button', { type: 'button', onclick: () => showInstall(true) }, '追加のしかたを見る'))));

  body.append(sect('使い方の見本',
    h('p', { class: 'muted' }, '本棚から消した「ひらくの使い方」を、もう一度入れられます。'),
    h('div', { class: 'stack' }, h('button', { type: 'button', onclick: () => seedSample(true) }, '使い方の見本をもう一度入れる'))));

  const used = h('p', {}, '計算しています…');
  body.append(sect('保存している量', used,
    h('p', { class: 'muted' }, '入れたファイルは、このスマホの中だけに保存しています。ひらくを消すと本棚も消えます。')));
  const total = S.docs.reduce((s, d) => s + (d.size || 0), 0);
  used.textContent = '本棚 ' + S.docs.length + '冊・' + fmtSize(total);
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(e => { if (e && e.usage) used.textContent += '（アプリ全体で 約' + fmtSize(e.usage) + '）'; }).catch(() => {});
  }

  body.append(sect('本棚を空にする',
    h('p', { class: 'muted' }, '本棚のファイルと、中で保存したデータをすべて消します。'),
    h('div', { class: 'stack' }, h('button', { type: 'button', class: 'danger', onclick: () => wipeSheet(false) }, '本棚を空にする'))));
  body.append(h('p', { class: 'foot' }, 'ひらく ' + VERSION));
  paintIcons(body);
}
function wipeSheet(fromLock) {
  const box = h('div', {},
    h('p', {}, fromLock
      ? '暗証番号を忘れたときは、本棚を空にして最初からやり直すしかありません。本棚のファイルと、中で保存したデータがすべて消えます。（元のファイルは消えません）'
      : '本棚のファイルと、中で保存したデータがすべて消えます。（元のファイルは消えません）'),
    h('div', { class: 'row-btns' },
      h('button', { type: 'button', onclick: goBack }, 'やめる'),
      h('button', {
        type: 'button', class: 'bad', onclick: async () => {
          await HDB.wipe();
          location.replace(new URL('./', location.href).href);
        }
      }, 'すべて消す')));
  const s = sheet(fromLock ? '番号を忘れたとき' : '本棚を空にする', box);
  if (fromLock) s.parentNode.style.zIndex = 80;
}

/* ---------- 暗証番号 ---------- */
async function pinHash(pin, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(x => parseInt(x, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120000 }, key, 256));
}
async function pinOk(pin) {
  if (!S.pin) return true;
  return (await pinHash(pin, S.pin.salt)) === S.pin.hash;
}
function pinPad(title, onDone, extra) {
  const ov = h('div', { class: 'lock', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const t = h('h2', {}, title);
  const dots = h('div', { class: 'dots', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => h('i')));
  const msg = h('p', { class: 'lock-msg', 'aria-live': 'assertive' });
  const said = h('span', { class: 'sr', style: 'position:absolute;left:-9999px', 'aria-live': 'polite' });
  let v = '', busy = false;
  const paint = () => { dots.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i < v.length)); said.textContent = v.length + 'けた入力'; };
  const press = async k => {
    if (busy) return;
    if (k === 'del') v = v.slice(0, -1);
    else if (v.length < 4) v += k;
    paint();
    if (v.length < 4) return;
    busy = true;
    const r = await onDone(v, api);
    busy = false;
    if (r === true) return;
    v = '';
    paint();
    if (r) { msg.textContent = r; dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake'); }
  };
  const pad = h('div', { class: 'pad' });
  for (const k of '123456789') pad.append(h('button', { type: 'button', onclick: () => press(k) }, k));
  pad.append(extra ? h('button', { type: 'button', class: 'small', onclick: extra[1] }, extra[0]) : h('span'));
  pad.append(h('button', { type: 'button', onclick: () => press('0') }, '0'));
  pad.append(h('button', { type: 'button', class: 'small', 'aria-label': '1けた消す', onclick: () => press('del') }, 'けす'));
  ov.append(t, dots, msg, pad, said);
  const onKey = e => { if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); };
  document.addEventListener('keydown', onKey);
  const api = {
    el: ov,
    title: s => { t.textContent = s; },
    msg: s => { msg.textContent = s; },
    close: () => { document.removeEventListener('keydown', onKey); ov.remove(); }
  };
  document.body.append(ov);
  return api;
}
async function showLock() {
  if (S.locked || !S.pin) return;
  S.locked = true;
  const cover = $('.cover');
  pinPad('暗証番号を入れてください', async (v, pad) => {
    const f = (await HDB.get('kv', 'pinFails').catch(() => null)) || { n: 0, until: 0 };
    if (f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000) + '秒たってから、もう一度入れてください';
    if (await pinOk(v)) {
      await HDB.put('kv', { n: 0, until: 0 }, 'pinFails').catch(() => {});
      S.locked = false;
      pad.close();
      return true;
    }
    f.n += 1;
    if (f.n >= 5) { f.n = 0; f.until = Date.now() + 30000; }
    await HDB.put('kv', f, 'pinFails').catch(() => {});
    return f.until > Date.now() ? '5回まちがえたので、30秒お待ちください' : 'ちがいます（あと' + (5 - f.n) + '回）';
  }, ['忘れたとき', () => wipeSheet(true)]);
  if (cover) cover.remove();
}
function newPinFlow(done) {
  let first = '';
  const pad = pinPad('新しい暗証番号（4けた）', async (v, p) => {
    if (!first) { first = v; p.title('確認のため、もう一度入れてください'); p.msg(''); return ''; }
    if (v !== first) { first = ''; p.title('新しい暗証番号（4けた）'); return 'ちがう番号でした。はじめからもう一度'; }
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    S.pin = { salt, hash: await pinHash(v, salt) };
    await HDB.put('kv', S.pin, 'pin');
    p.close();
    done();
    return true;
  }, ['やめる', () => pad.close()]);
}
function setPinFlow() { newPinFlow(() => { renderSettings(); banner('s', '暗証番号をつけました。', 'ok'); }); }
function verifyThen(title, fn) {
  const pad = pinPad(title, async (v, p) => {
    if (!(await pinOk(v))) return 'ちがいます';
    p.close();
    fn();
    return true;
  }, ['やめる', () => pad.close()]);
}
function changePin() { verifyThen('いまの暗証番号を入れてください', () => newPinFlow(() => { renderSettings(); banner('s', '暗証番号を変えました。', 'ok'); })); }
function removePin() {
  verifyThen('いまの暗証番号を入れてください', async () => {
    S.pin = null;
    await HDB.del('kv', 'pin');
    renderSettings();
    banner('s', '暗証番号をはずしました。', 'ok');
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    flushAll();
    S.hiddenAt = Date.now();
    if (S.pin && !S.locked && !$('.cover')) document.body.append(h('div', { class: 'cover' }, h('b', {}, 'ひらく')));
    return;
  }
  const cover = $('.cover');
  const picking = S.pickingAt && Date.now() - S.pickingAt < 180000;
  if (S.pin && !S.locked && !picking && Date.now() - S.hiddenAt >= S.settings.lockDelay) showLock();
  else if (cover) cover.remove();
  S.pickingAt = 0;
});
window.addEventListener('pagehide', flushAll);

/* ---------- ホーム画面に追加の案内 ---------- */
/* 手順の図：実際の画面を単純にした絵。赤い丸と赤い枠が「押す所」（画面の細部は機種で違うので、目印だけを描く） */
const FIG = {
  iosBar: '<svg viewBox="0 0 300 80"><rect x="1" y="8" width="298" height="64" rx="8" fill="#fff" stroke="#d8cfba" stroke-width="2"/><path d="M30 28l-10 12 10 12" fill="none" stroke="#1B4965" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><rect x="48" y="24" width="150" height="32" rx="6" fill="#f1ebdd"/><text x="123" y="45" font-size="14" text-anchor="middle" fill="#6f6858">github.io</text><g fill="none" stroke="#1B4965" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M232 26v16M226 32l6-6 6 6"/><path d="M226 35h-4v18h20V35h-4"/></g><circle cx="232" cy="40" r="22" fill="none" stroke="#C8102E" stroke-width="3.5"/><g fill="#1B4965"><circle cx="266" cy="40" r="2.6"/><circle cx="275" cy="40" r="2.6"/><circle cx="284" cy="40" r="2.6"/></g></svg>',
  iosSheet: '<svg viewBox="0 0 300 150"><rect x="1" y="1" width="298" height="148" rx="8" fill="#fff" stroke="#d8cfba" stroke-width="2"/><text x="20" y="34" font-size="16" fill="#6f6858">コピー</text><line x1="12" y1="50" x2="288" y2="50" stroke="#e8e1d0" stroke-width="2"/><rect x="8" y="55" width="284" height="44" rx="6" fill="#fdecef" stroke="#C8102E" stroke-width="3.5"/><text x="20" y="84" font-size="17" font-weight="700" fill="#191714">ホーム画面に追加</text><rect x="256" y="66" width="22" height="22" rx="4" fill="none" stroke="#191714" stroke-width="2"/><path d="M267 71v12M261 77h12" stroke="#191714" stroke-width="2"/><line x1="12" y1="104" x2="288" y2="104" stroke="#e8e1d0" stroke-width="2"/><text x="20" y="131" font-size="16" fill="#6f6858">ブックマークを追加</text></svg>',
  iosAdd: '<svg viewBox="0 0 300 64"><rect x="1" y="1" width="298" height="62" rx="8" fill="#fff" stroke="#d8cfba" stroke-width="2"/><text x="16" y="38" font-size="15" fill="#1B4965">キャンセル</text><text x="153" y="38" font-size="14" font-weight="700" text-anchor="middle" fill="#191714">ホーム画面に追加</text><text x="266" y="38" font-size="16" font-weight="700" text-anchor="middle" fill="#1B4965">追加</text><circle cx="266" cy="32" r="22" fill="none" stroke="#C8102E" stroke-width="3.5"/></svg>',
  andBtn: '<svg viewBox="0 0 300 64"><rect x="1" y="1" width="298" height="62" rx="8" fill="#fff" stroke="#d8cfba" stroke-width="2"/><rect x="14" y="16" width="222" height="32" rx="16" fill="#f1ebdd"/><text x="125" y="37" font-size="14" text-anchor="middle" fill="#6f6858">github.io</text><g fill="#1B4965"><circle cx="270" cy="22" r="3"/><circle cx="270" cy="32" r="3"/><circle cx="270" cy="42" r="3"/></g><circle cx="270" cy="32" r="21" fill="none" stroke="#C8102E" stroke-width="3.5"/></svg>',
  andMenu: '<svg viewBox="0 0 300 150"><rect x="1" y="1" width="298" height="148" rx="8" fill="#fff" stroke="#d8cfba" stroke-width="2"/><text x="20" y="34" font-size="16" fill="#6f6858">新しいタブ</text><line x1="12" y1="50" x2="288" y2="50" stroke="#e8e1d0" stroke-width="2"/><rect x="8" y="55" width="284" height="44" rx="6" fill="#fdecef" stroke="#C8102E" stroke-width="3.5"/><text x="20" y="84" font-size="17" font-weight="700" fill="#191714">ホーム画面に追加</text><line x1="12" y1="104" x2="288" y2="104" stroke="#e8e1d0" stroke-width="2"/><text x="20" y="131" font-size="16" fill="#6f6858">設定</text></svg>',
  andInstall: '<svg viewBox="0 0 300 96"><rect x="1" y="1" width="298" height="94" rx="8" fill="#fff" stroke="#d8cfba" stroke-width="2"/><text x="20" y="34" font-size="16" font-weight="700" fill="#191714">アプリをインストール</text><text x="150" y="74" font-size="15" text-anchor="middle" fill="#1B4965">キャンセル</text><text x="248" y="74" font-size="15" font-weight="700" text-anchor="middle" fill="#1B4965">インストール</text><rect x="196" y="52" width="104" height="36" rx="18" fill="none" stroke="#C8102E" stroke-width="3.5"/></svg>'
};
function fig(name, label) {
  const d = h('div', { class: 'fig', role: 'img', 'aria-label': label });
  d.innerHTML = FIG[name]; // 中身はこのファイルに書いた決まった絵だけ（外から来た文字は入れない）
  return d;
}
function stepsList(items, alt) {
  return h('ol', { class: 'steps' + (alt ? ' alt' : '') }, items.map(([main, sub, pic]) =>
    h('li', {}, h('p', {}, ...main, sub ? h('span', { class: 'sub' }, sub) : null, pic || null))));
}
function showInstall(fromSettings) {
  const wrap = h('section', { class: 'install', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'ホーム画面に追加' });
  const inner = h('div', { class: 'install-in' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('div', {}, h('h1', {}, 'ひらく'), h('p', {}, 'HTMLの本棚'))));
  const close = () => {
    if (fromSettings) goBack();
    else { try { sessionStorage.setItem('hk-later', '1'); } catch (e) { /* 続ける */ } wrap.remove(); }
  };
  if (ENV.inapp) {
    const browser = ENV.ios ? 'Safari' : 'Chrome';
    const copied = h('p', { class: 'lead', 'aria-live': 'polite' });
    inner.append(h('h2', {}, browser + ' で開いてください'),
      h('p', { class: 'lead' }, (ENV.line ? 'LINE' : 'このアプリ') + 'の中では、ホーム画面に追加できません。'),
      stepsList(ENV.ios ? [
        [['画面の右下か右上にある「', h('b', {}, '…'), '」か、共有ボタン', h('span', { class: 'ico-inline', 'data-icon': 'share' }), 'を押します。']],
        [['「', h('b', {}, 'Safariで開く'), '」（または「ブラウザで開く」）を押します。']]
      ] : [
        [['画面の右上の「', h('b', {}, '⋮'), '」を押します。']],
        [['「', h('b', {}, 'ブラウザで開く'), '」（または「他のアプリで開く」）を押します。']]
      ]),
      h('h3', { class: 'install-sub' }, 'それでも見つからないとき'),
      stepsList([
        [['下の「', h('b', {}, 'リンクをコピーする'), '」を押します。']],
        [[browser + ' を開きます。']],
        [['上か下にある入力欄を押し、もう一度押して「', h('b', {}, 'ペースト'), '」（貼り付け）を選び、開きます。']]
      ], true),
      h('div', { class: 'stack' }, h('button', {
        type: 'button', class: 'go', onclick: async () => {
          try { await navigator.clipboard.writeText(appUrl()); copied.textContent = 'コピーしました。' + browser + ' を開いて貼り付けてください。'; } catch (e) { copied.textContent = 'コピーできませんでした。'; }
        }
      }, 'リンクをコピーする')), copied);
  } else if (ENV.ios) {
    inner.append(h('h2', {}, 'ホーム画面に追加すると、アプリとして使えます'),
      stepsList([
        [['共有ボタン', h('span', { class: 'ico-inline', 'data-icon': 'share' }), 'を押します。'], '画面の下か上にあります。見つからないときは「…」を押すと出てきます。', fig('iosBar', 'Safariの帯。四角に上向き矢印の共有ボタンに赤い丸')],
        [['「', h('b', {}, 'ホーム画面に追加'), '」を押します。'], '見当たらないときは、出てきた一覧を上にすべらせて探してください。', fig('iosSheet', '一覧の中の「ホーム画面に追加」に赤い枠')],
        [['右上の「', h('b', {}, '追加'), '」を押します。'], '', fig('iosAdd', '右上の「追加」に赤い丸')],
        [['ホーム画面にできた「ひらく」から開きます。']]
      ]),
      h('p', { class: 'warn' }, 'ここ（ブラウザ）で入れたファイルは、ホーム画面の「ひらく」には引き継がれません。先にホーム画面に追加して、そちらで入れてください。'));
  } else if (ENV.android) {
    inner.append(h('h2', {}, 'ホーム画面に追加すると、アプリとして使えます'));
    if (S.bip) {
      inner.append(h('div', { class: 'stack' }, h('button', {
        type: 'button', class: 'go', onclick: async () => {
          try { S.bip.prompt(); const r = await S.bip.userChoice; if (r && r.outcome === 'accepted') close(); } catch (e) { /* 続ける */ }
          S.bip = null;
        }
      }, 'ホーム画面に追加する')));
    }
    inner.append(h('p', { class: 'lead', style: 'margin-top:16px' }, S.bip ? 'ボタンが動かないときは、次の手順で追加してください。' : '次の手順で追加してください。'),
      stepsList([
        [['右上の「', h('b', {}, '⋮'), '」を押します。'], '', fig('andBtn', 'Chromeの右上の点3つに赤い丸')],
        [['「', h('b', {}, 'ホーム画面に追加'), '」か「', h('b', {}, 'アプリをインストール'), '」を押します。'], '', fig('andMenu', 'メニューの「ホーム画面に追加」に赤い枠')],
        [['「', h('b', {}, 'インストール'), '」か「', h('b', {}, '追加'), '」を押します。'], '', fig('andInstall', '「インストール」に赤い丸')]
      ]));
  } else {
    inner.append(h('h2', {}, 'スマホで使うアプリです'),
      h('p', { class: 'lead' }, 'スマホのカメラでこのQRコードを読み取ると開けます。パソコンでも、このまま使えます。'),
      h('div', { class: 'qr-wrap' }, qrSvg(appUrl())));
  }
  inner.append(h('button', { type: 'button', class: 'later', onclick: close }, fromSettings ? 'とじる' : 'あとで（このまま使う）'));
  wrap.append(inner);
  document.body.append(wrap);
  paintIcons(wrap);
  if (fromSettings) pushLayer({ type: 'install', close: () => wrap.remove() });
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.bip = e; });
window.addEventListener('appinstalled', () => { S.bip = null; const w = $('.install'); if (w) w.remove(); });

/* ---------- 使い方の切り替え ---------- */
function setHowto(os) {
  document.querySelectorAll('.tabs [data-os]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.os === os)));
  document.querySelectorAll('.steps[data-for]').forEach(o => { o.hidden = o.dataset.for !== os; });
}

/* ---------- はじめに入れておく見本 ---------- */
async function seedSample(again) {
  try {
    if (!again && (await HDB.get('kv', 'seeded'))) return;
    const r = await fetch('./sample/guide.html');
    if (!r.ok) throw new Error('fetch');
    const res = await importOne('ひらくの使い方.html', await r.arrayBuffer(), { openedAt: Date.now() - 1000 });
    await HDB.put('kv', true, 'seeded');
    if (again) { renderList(); banner('s', res.dup ? '使い方の見本は、もう本棚に入っています。' : '使い方の見本を本棚に入れました。', 'ok'); }
  } catch (e) {
    if (again) banner('s', '見本を入れられませんでした。電波のある所で、もう一度ためしてください。', 'err');
  }
}

/* ---------- Android の「共有」から届いた物（本棚に入れ終わった物だけ箱から消す） ---------- */
async function takeInbox() {
  const q = location.search;
  if (/[?&]shared=/.test(q)) history.replaceState(null, '', location.pathname);
  if (/[?&]shared=0/.test(q)) banner('s', '共有されたファイルを受け取れませんでした。「ファイルを入れる」から入れてください。', 'err');
  let items = [];
  try { items = await HDB.inboxAll(); } catch (e) { return; }
  if (!items.length) return;
  const res = await importFiles(items.map(it => new File([it.value.bytes], it.value.name || 'ファイル.html', { type: it.value.type || '' })));
  for (let i = 0; i < items.length; i++) {
    if (!res[i] || !res[i].quota) await HDB.inboxDel(items[i].key).catch(() => {}); // 容量不足の物だけ、次に開いた時にもう一度ためす
  }
}
// 「本棚」ボタン：ZIPの中で何ページ進んでいても、一度で本棚へ戻る（Codex審査）
function backToShelf() {
  const i = S.layers.findIndex(l => l.type === 'viewer');
  if (i < 0) return;
  history.go(-(S.layers.length - i));
}

/* ---------- 起動 ---------- */
async function boot() {
  paintIcons();
  loadShim().catch(() => {}); // 表示に使う部品を先に読んでおく（電波なしでも本がすぐ開く）
  if (history.state && history.state.hk) history.replaceState(null, '', location.href);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  setHowto(ENV.android ? 'android' : 'ios');
  document.querySelectorAll('.tabs [data-os]').forEach(b => b.addEventListener('click', () => setHowto(b.dataset.os)));

  $('#pick').addEventListener('click', () => { S.pickingAt = Date.now(); $('#file').click(); });
  $('#file').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) importFiles(files);
  });
  $('#filter').addEventListener('input', debounce(renderList, 200));
  $('#toSettings').addEventListener('click', openSettings);
  $('#sBack').addEventListener('click', goBack);
  $('#vBack').addEventListener('click', backToShelf);
  $('#stripBtn').addEventListener('click', () => showInstall(true));
  $('#tToc').addEventListener('click', tocSheet);
  $('#tFind').addEventListener('click', () => toggleSearch($('#vSearch').hidden));
  $('#tSize').addEventListener('click', sizeSheet);
  $('#tShare').addEventListener('click', () => { const c = S.cur; if (c && c.bytes) shareFile(docFile(c.doc, c.bytes)); });
  $('#tMore').addEventListener('click', moreSheet);
  $('#q').addEventListener('input', debounce(() => send('find', { q: $('#q').value }), 350));
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send('next'); $('#q').blur(); } });
  $('#qNext').addEventListener('click', () => send('next'));
  $('#qPrev').addEventListener('click', () => send('prev'));
  $('#qClose').addEventListener('click', () => toggleSearch(false));
  // 検索の帯・お知らせ・画面の向きで表示枠の大きさが変わったら、倍率を当て直す
  if (window.ResizeObserver) new ResizeObserver(() => applyScale()).observe($('#vBox'));
  else window.addEventListener('resize', debounce(applyScale, 150));
  document.addEventListener('dragover', e => { e.preventDefault(); });
  document.addEventListener('drop', e => {
    e.preventDefault();
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (files.length && !S.cur) importFiles(files);
  });

  try {
    S.settings = Object.assign(S.settings, (await HDB.get('kv', 'settings')) || {});
    S.pin = (await HDB.get('kv', 'pin')) || null;
    if (S.pin) await showLock();
    await loadDocs();
    await seedSample();
  } catch (e) {
    console.error(e);
    banner('s', 'このブラウザでは本棚に保存できません。（プライベートモードでは使えないことがあります）', 'err');
  }
  $('#howto').open = S.docs.length <= 1;
  // スマホのブラウザで開いている間は、本棚の一番上で「先にホーム画面へ」と知らせ続ける（入れた物が引き継がれないため）
  $('#strip').hidden = ENV.standalone || !(ENV.ios || ENV.android);
  renderList();
  await takeInbox();
  if (!ENV.standalone) {
    let later = false;
    try { later = !!sessionStorage.getItem('hk-later'); } catch (e) { /* 続ける */ }
    if (!later) showInstall(false);
  }
  document.documentElement.dataset.ready = '1';
}
boot();
