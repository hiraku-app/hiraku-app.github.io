// ひらく — 本棚の1冊を「表示用の1枚のHTML」に組み立てる
//  ・1ファイルのHTML … 文字コードを直し、先頭に shim.js を差し込むだけ（中身はいじらない）
//  ・ZIP … 中の画像・CSS・JS を data URL にして埋め込み、shim.js を差し込む
//    （表示枠は別オリジン扱いのため、親が作った blob URL は中から読めない＝2026-10-30 実験）
import { readZip, readEntry } from './zip.js';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', txt: 'text/plain', csv: 'text/csv', xml: 'application/xml', md: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf', wasm: 'application/wasm', glb: 'model/gltf-binary', gltf: 'model/gltf+json', stl: 'model/stl'
};
export const extOf = p => { const m = /\.([a-z0-9]+)$/i.exec(p || ''); return m ? m[1].toLowerCase() : ''; };
export const mimeOf = p => MIME[extOf(p)] || 'application/octet-stream';
export const dirname = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };

// 相対パスを ZIP の中の場所に直す（http: や data: や #だけ は対象外＝null）
export function resolvePath(baseDir, ref) {
  if (ref == null) return null;
  ref = String(ref).trim();
  if (!ref || SCHEME.test(ref) || ref.startsWith('//') || ref.startsWith('#')) return null;
  let path = ref.replace(/[?#].*$/, '');
  if (!path) return null;
  try { path = decodeURIComponent(path); } catch (e) { /* そのまま */ }
  const parts = path.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

// 文字コードの判定：BOM → meta/@charset の宣言 → UTF-8 で読めるか → Shift_JIS → EUC-JP
export function decodeText(u8) {
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  // BOM なしの UTF-16（英字の間に 0 が交互に入る）
  if (u8.length > 4 && u8[0] !== 0 && u8[1] === 0 && u8[2] !== 0 && u8[3] === 0) return new TextDecoder('utf-16le').decode(u8);
  if (u8.length > 4 && u8[0] === 0 && u8[1] !== 0 && u8[2] === 0 && u8[3] !== 0) return new TextDecoder('utf-16be').decode(u8);
  const head = String.fromCharCode.apply(null, u8.subarray(0, 2048));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w:-]+)/i.exec(head) || /@charset\s+["']([\w:-]+)["']/i.exec(head);
  const cs = m ? m[1].toLowerCase() : '';
  if (cs && !/^utf-?8$/.test(cs)) { try { return new TextDecoder(cs).decode(u8); } catch (e) { /* 知らない名前 */ } }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { /* UTF-8 ではない */ }
  for (const enc of ['shift_jis', 'euc-jp']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(u8); } catch (e) { /* 次 */ }
  }
  return new TextDecoder('utf-8').decode(u8);
}

// 読み直した後は UTF-8 で渡すので、宣言も UTF-8 にそろえる（先頭 4KB の中だけ）
function fixCharset(html) {
  const cut = Math.min(html.length, 4096);
  const head = html.slice(0, cut).replace(/(<meta[^>]+charset\s*=\s*["']?)\s*[\w:-]+/i, (all, a) => a + 'utf-8');
  return head + html.slice(cut);
}

export function titleOf(html, fallback) {
  let m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 300000));
  let t = m ? m[1] : '';
  if (!t.trim()) {
    m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html.slice(0, 600000));
    t = m ? m[1].replace(/<[^>]+>/g, ' ') : '';
  }
  if (t) t = new DOMParser().parseFromString('<!doctype html><body>' + t.replace(/</g, '&lt;'), 'text/html').body.textContent;
  t = (t || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 80) || fallback;
}

// 種類の札（背表紙に縦書きで出す）
export function kindLabel(html) {
  return /<(input|textarea|select|canvas)\b|localStorage\.setItem|localStorage\[/i.test(html) ? 'アプリ' : '資料';
}

function toDataUrl(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

// 同時に動かす数を絞る（待つ側は他を待たない葉の仕事だけに使う＝詰まらない）
const slot = (() => {
  let running = 0;
  const queue = [];
  const next = () => {
    if (running >= 4 || !queue.length) return;
    running++;
    const { fn, res, rej } = queue.shift();
    fn().then(res, rej).finally(() => { running--; next(); });
  };
  return fn => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
})();

async function replaceAsync(str, re, fn) {
  const jobs = [];
  str.replace(re, (...a) => { jobs.push(fn(...a)); return a[0]; });
  if (!jobs.length) return str;
  const out = await Promise.all(jobs);
  let i = 0;
  return str.replace(re, () => out[i++]);
}

export class Pack {
  constructor(buf) {
    this.zip = readZip(buf);
    this.names = [...this.zip.entries.keys()];
    this.lower = new Map(this.names.map(n => [n.toLowerCase(), n]));
    const tops = new Set(this.names.map(n => (n.includes('/') ? n.split('/')[0] + '/' : '')));
    this.root = tops.size === 1 && !tops.has('') ? [...tops][0] : '';
    // 直下に README などがあって root が決まらない時のため、本体HTMLの一番上のフォルダも「根元」の候補にする
    const main = this.mainHtml();
    const alt = main && main.includes('/') ? main.slice(0, main.indexOf('/') + 1) : '';
    this.roots = [...new Set([this.root, alt].filter(Boolean))];
    this.cache = new Map();
  }
  htmls() { return this.names.filter(n => /\.html?$/i.test(n)); }
  mainHtml() {
    const depth = n => n.split('/').length;
    const isIdx = n => (/(^|\/)index\.html?$/i.test(n) ? 1 : 0);
    const hs = this.htmls().sort((a, b) => depth(a) - depth(b) || isIdx(b) - isIdx(a) || a.localeCompare(b));
    return hs[0] || null;
  }
  find(path) {
    if (path == null) return null;
    const E = this.zip.entries;
    for (const c of [path, ...this.roots.map(r => r + path)]) {
      if (E.has(c)) return c;
      const l = this.lower.get(c.toLowerCase());
      if (l) return l;
    }
    return null;
  }
  bytes(path) {
    if (!this.cache.has(path)) this.cache.set(path, readEntry(this.zip, this.zip.entries.get(path)));
    return this.cache.get(path);
  }
  async blob(path) { return new Blob([await this.bytes(path)], { type: mimeOf(path) }); }
  get totalSize() { let s = 0; for (const e of this.zip.entries.values()) s += e.usize; return s; }
}

// ZIP の中の1ページを、画像・CSS・JS 埋め込み済みの1枚のHTMLにする
export async function buildZipPage(pack, entry, depth = 0) {
  const memo = new Map();
  let dir = dirname(entry);

  const urlOf = (d, ref) => {
    const p = pack.find(resolvePath(d, ref));
    if (!p) return null;
    if (!memo.has(p)) memo.set(p, makeUrl(p));
    return memo.get(p);
  };
  async function makeUrl(p) {
    const ext = extOf(p);
    if (ext === 'css') return toDataUrl(new Blob([await cssFile(p, 0)], { type: 'text/css' }));
    if (ext === 'js' || ext === 'mjs') return toDataUrl(new Blob([decodeText(await pack.bytes(p))], { type: 'text/javascript' }));
    if ((ext === 'html' || ext === 'htm') && depth < 2) return toDataUrl(new Blob([await buildZipPage(pack, p, depth + 1)], { type: 'text/html' }));
    // 画像・音・フォントは同時に4つまで（一斉に展開するとスマホのメモリが足りなくなる＝Codex審査）
    return slot(async () => toDataUrl(await pack.blob(p)));
  }
  async function cssFile(p, d) { return rewriteCss(decodeText(await pack.bytes(p)), dirname(p), d); }
  async function rewriteCss(css, d0, d) {
    css = css.replace(/@charset\s+["'][^"']*["']\s*;?/i, '');
    css = await replaceAsync(css, /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?/gi, async (all, q, ref) => {
      const p = pack.find(resolvePath(d0, ref));
      if (!p || d > 3) return all;
      return '@import url("' + (await toDataUrl(new Blob([await cssFile(p, d + 1)], { type: 'text/css' }))) + '")';
    });
    return replaceAsync(css, /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi, async (all, a, b, c) => {
      const ref = a != null ? a : b != null ? b : c;
      if (!ref || /^data:/i.test(ref)) return all;
      const u = urlOf(d0, ref);
      return u ? 'url("' + (await u) + '")' : all;
    });
  }

  const html = decodeText(await pack.bytes(entry));
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const base = doc.querySelector('base[href]');
  if (base) {
    const b = base.getAttribute('href');
    if (!SCHEME.test(b) && !b.startsWith('//')) {
      const r = resolvePath(dir, b.endsWith('/') ? b + 'x' : b);
      if (r != null) dir = dirname(r);
      base.remove();
    }
  }
  doc.querySelectorAll('meta[charset]').forEach(m => m.setAttribute('charset', 'utf-8'));
  doc.querySelectorAll('meta[http-equiv]').forEach(m => { if (/content-type/i.test(m.getAttribute('http-equiv'))) m.remove(); });

  const tasks = [];
  const setAttr = (el, attr, ref) => {
    const u = urlOf(dir, ref);
    if (u) tasks.push(u.then(v => el.setAttribute(attr, v)));
  };
  doc.querySelectorAll('img[src],script[src],source[src],video[src],audio[src],track[src],embed[src],input[src],iframe[src],frame[src]')
    .forEach(el => setAttr(el, 'src', el.getAttribute('src')));
  doc.querySelectorAll('video[poster]').forEach(el => setAttr(el, 'poster', el.getAttribute('poster')));
  doc.querySelectorAll('object[data]').forEach(el => setAttr(el, 'data', el.getAttribute('data')));
  doc.querySelectorAll('img[srcset],source[srcset]').forEach(el => {
    if (/data:/i.test(el.getAttribute('srcset'))) return; // 埋め込み済みはカンマを含むので触らない
    const parts = el.getAttribute('srcset').split(/\s*,\s*/).filter(Boolean);
    tasks.push(Promise.all(parts.map(async c => {
      const [u, ...rest] = c.trim().split(/\s+/);
      const p = urlOf(dir, u);
      return (p ? await p : u) + (rest.length ? ' ' + rest.join(' ') : '');
    })).then(list => el.setAttribute('srcset', list.join(', '))));
  });
  doc.querySelectorAll('link[href]').forEach(el => {
    const rel = (el.getAttribute('rel') || '').toLowerCase();
    const href = el.getAttribute('href');
    if (SCHEME.test(href) || href.startsWith('//')) return;
    if (/\b(stylesheet|icon)\b/.test(rel)) setAttr(el, 'href', href);
    else if (/preload|prefetch|modulepreload|manifest/.test(rel)) el.remove();
  });
  doc.querySelectorAll('style').forEach(st => tasks.push(rewriteCss(st.textContent, dir, 0).then(t => { st.textContent = t; })));
  doc.querySelectorAll('[style]').forEach(el => {
    const s = el.getAttribute('style');
    if (/url\(/i.test(s)) tasks.push(rewriteCss(s, dir, 0).then(t => el.setAttribute('style', t)));
  });
  // SVG：<image href> は埋め込み、<use href="sprite.svg#id"> は中身を貼り込んで #id にする
  const sprites = new Map();
  doc.querySelectorAll('image, use').forEach(el => {
    for (const a of ['href', 'xlink:href']) {
      const v = el.getAttribute(a);
      if (!v || v.startsWith('#') || SCHEME.test(v)) continue;
      if (el.localName !== 'use') { setAttr(el, a, v); continue; }
      const [file, frag] = v.split('#');
      const p = pack.find(resolvePath(dir, file));
      if (!p || !frag) continue;
      if (!sprites.has(p)) {
        sprites.set(p, pack.bytes(p).then(b => {
          const holder = doc.createElement('div');
          holder.setAttribute('hidden', '');
          holder.setAttribute('aria-hidden', 'true');
          holder.innerHTML = decodeText(b).replace(/<\?xml[^>]*>/i, '');
          doc.body.appendChild(holder);
        }));
      }
      tasks.push(sprites.get(p).then(() => el.setAttribute(a, '#' + frag)));
    }
  });

  await Promise.all(tasks);
  const dt = doc.doctype;
  let out = '';
  if (dt) {
    out = '<!DOCTYPE ' + dt.name;
    if (dt.publicId) out += ' PUBLIC "' + dt.publicId + '"' + (dt.systemId ? ' "' + dt.systemId + '"' : '');
    else if (dt.systemId) out += ' SYSTEM "' + dt.systemId + '"';
    out += '>\n';
  }
  return out + doc.documentElement.outerHTML;
}

// shim.js を一番最初に動く位置へ差し込む（<head> の直後。無ければ <html> の直後、doctype の直後、先頭）
export function injectShim(html, cfg, shim) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c').split(String.fromCharCode(8232)).join('\\u2028').split(String.fromCharCode(8233)).join('\\u2029');
  const tag = '<script data-hiraku>window.__HIRAKU__=' + json + ';\n' + shim + '\n</script>';
  const firsts = [/<script\b/i, /<body\b/i].map(r => html.search(r)).filter(i => i >= 0);
  const lim = firsts.length ? Math.min(...firsts) : -1;
  const ok = m => m && (lim < 0 || m.index < lim);
  let m = /<head(?:\s[^>]*)?>/i.exec(html);
  if (ok(m)) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  m = /<html(?:\s[^>]*)?>/i.exec(html);
  if (ok(m)) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  m = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(html);
  if (m) return html.slice(0, m[0].length) + tag + html.slice(m[0].length);
  return tag + html;
}

let shimP = null;
export function loadShim() {
  if (!shimP) {
    shimP = fetch('./shim.js').then(r => { if (!r.ok) throw new Error('shim ' + r.status); return r.text(); });
    shimP.catch(() => { shimP = null; });
  }
  return shimP;
}

// 表示用の1枚を作る。opt = { entry, pack, ls }
export async function buildView(doc, bytes, opt = {}) {
  const shim = await loadShim();
  const cfg = { id: doc.id, ls: opt.ls || {}, base: '' };
  let html;
  if (doc.kind === 'zip') {
    const pack = opt.pack || new Pack(bytes);
    const entry = opt.entry || doc.entry || pack.mainHtml();
    html = await buildZipPage(pack, entry);
    Object.assign(cfg, { base: dirname(entry), entry, roots: pack.roots, assets: pack.names, pages: pack.htmls() });
  } else {
    html = fixCharset(decodeText(new Uint8Array(bytes)));
  }
  return injectShim(html, cfg, shim);
}
