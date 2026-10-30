/* ひらく — Service Worker
   ・電波が無くても開ける：ネット優先＋3秒で手元の控えへ（キャッシュ優先だと修正が2回開かないと届かない＝ops-notes 103）
   ・Android の「共有」から届いたファイルを受け取り箱（IndexedDB の inbox）へ入れて、画面へ渡す */
importScripts('./db.js');

const CACHE = 'hiraku-v1.0.0';
const SHELL = [
  './', './index.html', './app.css', './app.js', './pack.js', './zip.js', './shim.js', './db.js', './qr.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './sample/guide.html'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('hiraku-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET') return;
  e.respondWith(netFirst(req));
});

function within(p, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); res(v); }, err => { clearTimeout(t); rej(err); });
  });
}

async function netFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await within(fetch(req), 3000);
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const page = (await cache.match('./index.html')) || (await cache.match('./'));
      if (page) return page;
    }
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

async function receiveShare(req) {
  let ok = true;
  try {
    const form = await req.formData();
    for (const f of form.getAll('file')) {
      if (f && typeof f === 'object' && typeof f.arrayBuffer === 'function') {
        await self.HDB.put('inbox', { name: f.name, type: f.type, bytes: await f.arrayBuffer(), at: Date.now() });
      }
    }
  } catch (e) { ok = false; /* 画面に「受け取れなかった」と出す */ }
  return Response.redirect(ok ? './?shared=1' : './?shared=0', 303);
}
