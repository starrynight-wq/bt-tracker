'use strict';

/*
 * Minimal bencode implementation that works in Node.js and Cloudflare Workers.
 * Byte strings are represented as Uint8Array so arbitrary binary data
 * (e.g. info_hash, compact peers) survives round trips unchanged.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function isBytes(v) { return v instanceof Uint8Array; }
function toBytes(v) {
  if (isBytes(v)) return v;
  if ( typeof v === 'string') return ENC.encode(v);
  throw new Error('bencode: expected string or Uint8Array');
}
function asString(v) {
  if (typeof v === 'string') return v;
  return DEC.decode(v);
}
function cmpBytes(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function encodeStr(s) { return ENC.encode(s); }

function encode(val) {
  if (val === null || val === undefined) throw new Error('bencode: cannot encode null/undefined');
  if (typeof val === 'number') {
    if (!Number.isInteger(val)) throw new Error('bencode: integer expected');
    return concat([encodeStr('i'), ENC.encode(val.toString(10)), encodeStr('e')]);
  }
  if (typeof val === 'string' || isBytes(val)) {
    const b = toBytes(val);
    return concat([encodeStr(b.length.toString(10)), encodeStr(':'), b]);
  }
  if (Array.isArray(val)) {
    const parts = [encodeStr('l')];
    for (const item of val) parts.push(encode(item));
    parts.push(encodeStr('e'));
    return concat(parts);
  }
  if (typeof val === 'object') {
    const entries = [];
    for (const key of Object.keys(val)) {
      entries.push({ key: toBytes(key), val: val[key] });
    }
    entries.sort((a, b) => cmpBytes(a.key, b.key));
    const parts = [encodeStr('d')];
    for (const e of entries) {
      parts.push(encodeStr(e.key.length.toString(10)));
      parts.push(encodeStr(':'));
      parts.push(e.key);
      parts.push(encode(e.val));
    }
    parts.push(encodeStr('e'));
    return concat(parts);
  }
  throw new Error('bencode: unsupported type ' + typeof val);
}

function decode(input, pos = 0) {
  const bytes = isBytes(input) ? input : ENC.encode(input);
  if (pos >= bytes.length) throw new Error('bencode: unexpected end of input');
  const c = bytes[pos];

  // string: <length>:<bytes>
  if (c >= 0x30 && c <= 0x39) {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0x3A) end++; // ':'
    if (end === bytes.length) throw new Error('bencode: bad string');
    const n = Number(asString(bytes.slice(pos, end)));
    if (!Number.isInteger(n) || n < 0) throw new Error('bencode: bad length');
    const start = end + 1;
    if (start + n > bytes.length) throw new Error('bencode: string exceeds input');
    return { value: bytes.slice(start, start + n), pos: start + n };
  }

  // integer: i<number>e
  if (c === 0x69) {
    let end = pos + 1;
    while (end < bytes.length && bytes[end] !== 0x65) end++; // 'e'
    if (end === bytes.length) throw new Error('bencode: bad integer');
    const n = Number(asString(bytes.slice(pos + 1, end)));
    if (!Number.isInteger(n)) throw new Error('bencode: bad integer');
    return { value: n, pos: end + 1 };
  }

  // list: l<items>e
  if (c === 0x6C) {
    const list = [];
    let p = pos + 1;
    while (bytes[p] !== 0x65) {
      const item = decode(bytes, p);
      list.push(item.value);
      p = item.pos;
    }
    return { value: list, pos: p + 1 };
  }

  // dict: d<key><value>...e  (keys must be byte strings)
  if (c === 0x64) {
    const dict = {};
    let p = pos + 1;
    while (bytes[p] !== 0x65) {
      const keyItem = decode(bytes, p);
      p = keyItem.pos;
      if (!isBytes(keyItem.value)) throw new Error('bencode: dict key must be a string');
      const valItem = decode(bytes, p);
      p = valItem.pos;
      dict[asString(keyItem.value)] = valItem.value;
    }
    return { value: dict, pos: p + 1 };
  }

  throw new Error('bencode: unknown marker ' + String.fromCharCode(c));
}

export function decodeSync(input) {
  return decode(input).value;
}

export { encode, decode, encodeStr, toBytes, asString };

export function bytesToHex(b) {
  let s = '';
  for (const x of b) s += (x < 16 ? '0' : '') + x.toString(16);
  return s;
}
