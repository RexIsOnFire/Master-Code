/**
 * Synchronous digests for the JavaScript runner's `node:crypto`.
 *
 * Generated code calls `createHash(alg).update(text).digest('hex')`, which is
 * synchronous; WebCrypto only offers promises, so the three algorithms the
 * backend can emit (sha256, sha1, md5) and HMAC are implemented here. Speed is
 * irrelevant at the sizes a demo program hashes; agreeing with Node bit for bit
 * is not, and the tests hold these to `node:crypto`.
 *
 * Self-contained on purpose: the worker loads it from source, with no imports.
 */

const encoder = new TextEncoder();
const bytesOf = (data) => (typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data));

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Merkle-Damgard padding: 0x80, zeros, then the bit length in 64 bits. */
function pad(bytes, littleEndian) {
  const length = bytes.length;
  const total = (((length + 8) >> 6) + 1) << 6;
  const out = new Uint8Array(total);
  out.set(bytes);
  out[length] = 0x80;
  const view = new DataView(out.buffer);
  const bits = length * 8;
  const high = Math.floor(bits / 2 ** 32);
  const low = bits >>> 0;
  if (littleEndian) {
    view.setUint32(total - 8, low, true);
    view.setUint32(total - 4, high, true);
  } else {
    view.setUint32(total - 8, high);
    view.setUint32(total - 4, low);
  }
  return view;
}

const rotl = (x, n) => (x << n) | (x >>> (32 - n));
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function sha256(data) {
  const view = pad(bytesOf(data), false);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let block = 0; block < view.byteLength; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return wordsToBytes(h, false);
}

export function sha1(data) {
  const view = pad(bytesOf(data), false);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let block = 0; block < view.byteLength; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1) >>> 0;
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  return wordsToBytes(h, false);
}

const S_MD5 = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K_MD5 = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data) {
  const view = pad(bytesOf(data), true);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const m = new Uint32Array(16);
  for (let block = 0; block < view.byteLength; block += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(block + i * 4, true);
    let [a, b, c, d] = h;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const next = (b + rotl((a + f + K_MD5[i] + m[g]) >>> 0, S_MD5[i])) >>> 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
  }
  return wordsToBytes(h, true);
}

function wordsToBytes(words, littleEndian) {
  const out = new DataView(new ArrayBuffer(words.length * 4));
  words.forEach((word, i) => out.setUint32(i * 4, word, littleEndian));
  return new Uint8Array(out.buffer);
}

const ALGORITHMS = { sha256, sha1, md5 };

function algorithm(name) {
  const fn = ALGORITHMS[String(name).toLowerCase().replace('-', '')];
  if (!fn) throw new Error(`Digest method not supported in the browser demo: ${name} (available: sha256, sha1, md5)`);
  return fn;
}

export function hmac(name, key, message) {
  const hash = algorithm(name);
  let k = bytesOf(key);
  if (k.length > 64) k = hash(k);
  const block = new Uint8Array(64);
  block.set(k);
  const inner = block.map((b) => b ^ 0x36);
  const outer = block.map((b) => b ^ 0x5c);
  return hash(concat([outer, hash(concat([inner, bytesOf(message)]))]));
}

function encode(bytes, encoding) {
  if (encoding === 'hex') return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (encoding === 'base64') return btoa(String.fromCharCode(...bytes));
  if (encoding === undefined) return bytes;
  throw new Error(`Unsupported digest encoding in the browser demo: ${encoding}`);
}

/** The slice of `node:crypto` generated code uses. */
export function createCrypto() {
  const accumulate = (finish) => {
    const parts = [];
    const handle = {
      update(data) {
        parts.push(bytesOf(data));
        return handle;
      },
      digest(encoding) {
        return encode(finish(concat(parts)), encoding);
      },
    };
    return handle;
  };
  return {
    createHash: (name) => {
      const hash = algorithm(name);
      return accumulate((bytes) => hash(bytes));
    },
    createHmac: (name, key) => {
      algorithm(name);
      return accumulate((bytes) => hmac(name, key, bytes));
    },
    randomUUID: () => globalThis.crypto.randomUUID(),
    getRandomValues: (array) => globalThis.crypto.getRandomValues(array),
    webcrypto: globalThis.crypto,
  };
}
