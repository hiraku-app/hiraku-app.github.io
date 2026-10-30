/* ひらく — 端末の中の保存庫（IndexedDB）。画面（app.js）と sw.js の両方から読む。
   docs    : 本棚の1冊ごとの情報（題名・種類・続きの位置など。軽い）
   files   : 本体のバイト列（id → ArrayBuffer。重いので docs と分ける）
   appdata : 読み込んだアプリが中で保存したデータ（id → {キー: 値}）
   kv      : 設定（暗証番号のハッシュ・文字の大きさ など）
   inbox   : Android の「共有」から届いたファイルの受け取り箱（sw.js が入れ、画面が取り出す） */
(function (g) {
  'use strict';
  var NAME = 'hiraku', VER = 1, dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var rq = indexedDB.open(NAME, VER);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('appdata')) db.createObjectStore('appdata');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { autoIncrement: true });
      };
      rq.onsuccess = function () {
        var db = rq.result;
        db.onversionchange = function () { db.close(); dbp = null; };
        res(db);
      };
      rq.onerror = function () { dbp = null; rej(rq.error); };
    });
    return dbp;
  }

  function run(stores, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(stores, mode), out;
        var r = fn(t);
        if (r && typeof r === 'object' && 'onsuccess' in r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('abort')); };
      });
    });
  }

  g.HDB = {
    get: function (s, k) { return run(s, 'readonly', function (t) { return t.objectStore(s).get(k); }); },
    put: function (s, v, k) { return run(s, 'readwrite', function (t) { return k === undefined ? t.objectStore(s).put(v) : t.objectStore(s).put(v, k); }); },
    del: function (s, k) { return run(s, 'readwrite', function (t) { return t.objectStore(s).delete(k); }); },
    all: function (s) { return run(s, 'readonly', function (t) { return t.objectStore(s).getAll(); }); },
    clear: function (s) { return run(s, 'readwrite', function (t) { return t.objectStore(s).clear(); }); },
    /* 1冊を、情報・本体・中のデータまとめて入れる／消す（途中で失敗したら全部取り消し） */
    putDoc: function (doc, bytes) {
      return run(['docs', 'files'], 'readwrite', function (t) {
        t.objectStore('files').put(bytes, doc.id);
        t.objectStore('docs').put(doc);
      });
    },
    delDoc: function (id) {
      return run(['docs', 'files', 'appdata'], 'readwrite', function (t) {
        t.objectStore('docs').delete(id);
        t.objectStore('files').delete(id);
        t.objectStore('appdata').delete(id);
      });
    },
    /* 受け取り箱の中身を見る（消すのは本棚に入れ終わってから＝inboxDel。途中で止まっても失わない） */
    inboxAll: function () {
      var items = [];
      return run('inbox', 'readonly', function (t) {
        t.objectStore('inbox').openCursor().onsuccess = function (e) {
          var c = e.target.result;
          if (c) { items.push({ key: c.key, value: c.value }); c.continue(); }
        };
      }).then(function () { return items; });
    },
    inboxDel: function (key) { return run('inbox', 'readwrite', function (t) { return t.objectStore('inbox').delete(key); }); },
    wipe: function () {
      return run(['docs', 'files', 'appdata', 'kv', 'inbox'], 'readwrite', function (t) {
        ['docs', 'files', 'appdata', 'kv', 'inbox'].forEach(function (s) { t.objectStore(s).clear(); });
      });
    }
  };
})(self);
