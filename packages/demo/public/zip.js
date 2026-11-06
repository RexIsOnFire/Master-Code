/**
 * Zip archives, written and read with the platform's own deflate.
 *
 * `CompressionStream('deflate-raw')` is the deflate a zip entry holds, so no
 * library is needed. The writer emits plain zip (no zip64): 65,535 entries and
 * 4 GiB are hard limits of that format, and it refuses past them rather than
 * writing an archive other tools would misread.
 *
 * The reader is the security-sensitive half, because the archive comes from
 * wherever the user got it. Entry names are checked before anything is written
 * (`safeEntryName`), the CRC of every entry is verified, and the declared
 * uncompressed total is capped so a crafted archive cannot exhaust the tab.
 */

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;
/** Reading refuses archives that declare more than this uncompressed. */
export const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function transform(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

const deflate = (bytes) => transform(bytes, new CompressionStream('deflate-raw'));
const inflate = (bytes) => transform(bytes, new DecompressionStream('deflate-raw'));

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Builds an archive from `[{ name, data }]`, where `data` is a string (stored as
 * UTF-8) or a Uint8Array. Names use `/` and must be relative.
 */
export async function writeZip(entries, { date = new Date() } = {}) {
  if (entries.length > MAX_ENTRIES) throw new Error(`A zip can hold at most ${MAX_ENTRIES} files; this project has ${entries.length}.`);
  const { time, date: day } = dosDateTime(date);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const packed = await deflate(raw);
    // Deflate can grow incompressible data; storing it is then both smaller and simpler.
    const stored = packed.length >= raw.length;
    const body = stored ? raw : packed;
    const crc = crc32(raw);
    if (raw.length > MAX_BYTES || offset > MAX_BYTES) throw new Error('This project is larger than a plain zip can hold (4 GiB).');

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true); // version needed: 2.0
    header.setUint16(6, 0x0800, true); // flag: names are UTF-8
    header.setUint16(8, stored ? 0 : 8, true);
    header.setUint16(10, time, true);
    header.setUint16(12, day, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, body.length, true);
    header.setUint32(22, raw.length, true);
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true);
    locals.push(new Uint8Array(header.buffer), name, body);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 0x0314, true); // made by: Unix, 2.0 - so the mode below is honoured
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(10, stored ? 0 : 8, true);
    record.setUint16(12, time, true);
    record.setUint16(14, day, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, body.length, true);
    record.setUint32(24, raw.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(38, (0o100644 << 16) >>> 0, true); // external attributes: a regular rw-r--r-- file
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);

    offset += 30 + name.length + body.length;
  }

  const centralSize = central.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Uint8Array(await new Blob([...locals, ...central, new Uint8Array(end.buffer)]).arrayBuffer());
}

/**
 * The entry name as a safe relative path, or null when it must not be written:
 * absolute paths, drive letters, backslashes and any `..` segment are refused
 * outright rather than "cleaned", since a cleaned name is still not the file the
 * archive meant.
 */
export function safeEntryName(name) {
  if (!name || name.includes('\0') || name.includes('\\')) return null;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const segments = name.split('/').filter((s) => s !== '' && s !== '.');
  if (!segments.length || segments.some((s) => s === '..')) return null;
  return segments.join('/');
}

/**
 * Reads an archive into `[{ name, data }]`, `data` as Uint8Array. Directory
 * entries are skipped. Throws on anything it cannot read faithfully: an
 * encrypted entry, an unknown compression method, a CRC mismatch, an unsafe name.
 */
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not a zip file.');

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cursor === 0xffffffff) throw new Error('Zip64 archives are not supported.');

  const out = [];
  let declared = 0;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('The zip directory is damaged.');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    const rawName = decodeName(nameBytes, flags);
    if (rawName.endsWith('/')) continue;
    if (flags & 0x1) throw new Error(`"${rawName}" is encrypted, which is not supported.`);
    const name = safeEntryName(rawName);
    if (!name) throw new Error(`Refusing "${rawName}": it would be written outside the project folder.`);

    declared += size;
    if (declared > MAX_UNCOMPRESSED_BYTES) throw new Error('This archive expands to more than 1 GiB, which is more than the demo will unpack.');

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`The entry for "${name}" is damaged.`);
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const body = bytes.subarray(start, start + compressedSize);

    let data;
    if (method === 0) data = body.slice();
    else if (method === 8) data = await inflate(body);
    else throw new Error(`"${name}" uses compression method ${method}, which is not supported.`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`"${name}" is corrupt (its checksum does not match).`);
    out.push({ name, data });
  }
  return out;
}

function decodeName(bytes, flags) {
  if (flags & 0x0800) return new TextDecoder().decode(bytes);
  // Without the UTF-8 flag the name is nominally CP437; most tools write UTF-8
  // anyway, so try that first and fall back to a byte-for-byte reading.
  try {
    return utf8.decode(bytes);
  } catch {
    return String.fromCharCode(...bytes);
  }
}

/** Text when the bytes are valid UTF-8, otherwise the bytes unchanged. */
export function textOrBytes(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    return bytes;
  }
}
