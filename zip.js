// ひらく — ZIP を読む（外部ライブラリなし。展開はブラウザ標準の DecompressionStream）
// 対応：無圧縮・deflate／ZIP64／日本語ファイル名（UTF-8 と、Windows の古い圧縮が使う Shift_JIS の両方）
// 非対応：パスワード付き ZIP（ZIP_ENCRYPTED を投げる）

let sjis = null;
try { sjis = new TextDecoder('shift_jis'); } catch (e) { /* 古い端末 */ }
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder().decode(bytes);
  try { return utf8Strict.decode(bytes); } catch (e) { /* UTF-8 ではない */ }
  return sjis ? sjis.decode(bytes) : new TextDecoder().decode(bytes);
}

// スマホで落ちないための上限（ZIP爆弾・大きすぎる束を断る＝2026-10-30 Codex審査）
export const LIMITS = { files: 5000, total: 200 * 1048576, entry: 100 * 1048576, ratio: 1000 };

export function isZip(u8) {
  return u8.length > 22 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5);
}

function u64(dv, p) { return Number(dv.getBigUint64(p, true)); }

export function readZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP_BROKEN');
  let count = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  if ((count === 0xffff || cdOff === 0xffffffff) && eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50) {
    const z64 = u64(dv, eocd - 12);
    if (dv.getUint32(z64, true) === 0x06064b50) { count = u64(dv, z64 + 32); cdOff = u64(dv, z64 + 48); }
  }
  const entries = new Map();
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP_BROKEN');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    let lho = dv.getUint32(p + 42, true);
    const name = decodeName(u8.subarray(p + 46, p + 46 + nlen), flags & 0x800).replace(/\\/g, '/');
    if (usize === 0xffffffff || csize === 0xffffffff || lho === 0xffffffff) {
      let x = p + 46 + nlen;
      const xend = x + xlen;
      while (x + 4 <= xend) {
        const id = dv.getUint16(x, true), sz = dv.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = u64(dv, q); q += 8; }
          if (csize === 0xffffffff) { csize = u64(dv, q); q += 8; }
          if (lho === 0xffffffff) { lho = u64(dv, q); }
          break;
        }
        x += 4 + sz;
      }
    }
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name) || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name)) continue;
    entries.set(name, { name, flags, method, csize, usize, lho });
    if (entries.size > LIMITS.files) throw new Error('ZIP_TOO_MANY');
  }
  let total = 0;
  for (const e of entries.values()) {
    if (e.usize > LIMITS.entry) throw new Error('ZIP_TOO_BIG');
    if (e.usize > 10 * 1048576 && e.csize > 0 && e.usize / e.csize > LIMITS.ratio) throw new Error('ZIP_TOO_BIG');
    total += e.usize;
  }
  if (total > LIMITS.total) throw new Error('ZIP_TOO_BIG');
  return { u8, dv, entries };
}

export async function readEntry(zip, e) {
  const { u8, dv } = zip;
  if (dv.getUint32(e.lho, true) !== 0x04034b50) throw new Error('ZIP_BROKEN');
  if (e.flags & 1) throw new Error('ZIP_ENCRYPTED');
  const nlen = dv.getUint16(e.lho + 26, true);
  const xlen = dv.getUint16(e.lho + 28, true);
  const start = e.lho + 30 + nlen + xlen;
  const data = u8.subarray(start, start + e.csize);
  if (e.method === 0) return data.slice();
  if (e.method === 8) {
    // 書いてある大きさ（usize）を超えて出てきたら、偽りの ZIP として止める
    const out = new Uint8Array(e.usize);
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    let off = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (off + value.length > out.length) { reader.cancel().catch(() => {}); throw new Error('ZIP_BROKEN'); }
      out.set(value, off);
      off += value.length;
    }
    return off === out.length ? out : out.slice(0, off);
  }
  throw new Error('ZIP_METHOD');
}
