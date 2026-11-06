/**
 * `node:fs` for the browser, over the demo's in-memory disk.
 *
 * Only the synchronous calls the core and the IDE server make are provided, with
 * Node's semantics where they matter: a write into a missing directory fails
 * with ENOENT, `rmdir` refuses a non-empty directory, errors carry `code`. A
 * shim that quietly created parents would hide the bugs the real disk catches.
 */

import { disk, fsError } from '../vfs.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encodingOf = (options) => (typeof options === 'string' ? options : options?.encoding);

const asText = (data) => (typeof data === 'string' ? data : decoder.decode(data));
const asBytes = (data) => (typeof data === 'string' ? encoder.encode(data) : data);

class Stats {
  #kind;

  constructor(entry) {
    this.#kind = entry.kind;
    this.size = entry.kind === 'file' ? asBytes(entry.data).byteLength : 0;
    this.mtimeMs = entry.mtimeMs;
    this.mtime = new Date(entry.mtimeMs);
    this.mode = entry.kind === 'dir' ? 0o40755 : 0o100644;
  }

  isDirectory() {
    return this.#kind === 'dir';
  }

  isFile() {
    return this.#kind === 'file';
  }

  isSymbolicLink() {
    return false;
  }
}

class Dirent extends Stats {
  constructor(name, entry) {
    super(entry);
    this.name = name;
  }
}

export function existsSync(path) {
  return typeof path === 'string' && disk.exists(path);
}

export function statSync(path, options) {
  const entry = disk.stat(path);
  if (!entry) {
    if (options?.throwIfNoEntry === false) return undefined;
    throw fsError('ENOENT', 'stat', path);
  }
  return new Stats(entry);
}

export const lstatSync = statSync;

export function readFileSync(path, options) {
  const data = disk.readFile(path);
  return encodingOf(options) ? asText(data) : asBytes(data);
}

// Node ignores the encoding for byte data, so only strings stay strings.
export function writeFileSync(path, data) {
  disk.writeFile(path, typeof data === 'string' ? data : new Uint8Array(data));
}

export function appendFileSync(path, data) {
  const previous = disk.exists(path) ? asText(disk.readFile(path)) : '';
  disk.writeFile(path, previous + String(data));
}

export function mkdirSync(path, options) {
  return disk.mkdir(path, { recursive: !!options?.recursive });
}

export function readdirSync(path, options) {
  const names = disk.readdir(path);
  if (!options?.withFileTypes) return names;
  const base = path.endsWith('/') ? path : `${path}/`;
  return names.map((name) => new Dirent(name, disk.stat(base + name)));
}

export function rmSync(path, options) {
  disk.rm(path, { recursive: !!options?.recursive, force: !!options?.force });
}

export function rmdirSync(path, options) {
  if (options?.recursive) disk.rm(path, { recursive: true });
  else disk.rmdir(path);
}

export function unlinkSync(path) {
  const entry = disk.stat(path);
  if (!entry) throw fsError('ENOENT', 'unlink', path);
  if (entry.kind === 'dir') throw fsError('EISDIR', 'unlink', path);
  disk.rm(path);
}

export function renameSync(from, to) {
  for (const [path, data] of disk.files(from)) {
    const target = to + path.slice(from.length);
    disk.mkdir(target.slice(0, target.lastIndexOf('/')) || '/', { recursive: true });
    disk.writeFile(target, data);
  }
  disk.rm(from, { recursive: true, force: true });
}

export function mkdtempSync(prefix) {
  const path = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
  disk.mkdir(path, { recursive: true });
  return path;
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export default {
  existsSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  renameSync,
  mkdtempSync,
  constants,
};
