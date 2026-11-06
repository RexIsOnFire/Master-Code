/**
 * The demo's disk: an in-memory POSIX tree that the core reads and writes
 * synchronously, kept in IndexedDB behind it.
 *
 * The core's file code is synchronous (`readFileSync`, `writeFileSync`) and
 * IndexedDB is not, so memory is the source of truth and the database is a
 * write-behind copy. Everything is loaded once at startup; every change marks
 * its path dirty; dirty paths are written in one transaction shortly after.
 * `flush()` forces that, and the host calls it after every command, so a command
 * that returned has been saved - the same promise the desktop server makes.
 *
 * Files hold a string when they are text and a Uint8Array otherwise. The core
 * only ever reads and writes UTF-8, so in practice binaries arrive only through
 * an imported zip.
 */

import { dirname, resolve } from './node/path.js';

const DB_NAME = 'mastercode-demo';
const DB_VERSION = 1;
const STORE = 'entries';

/** A Node-shaped error, so core code that checks `err.code` behaves as it does on a real disk. */
export function fsError(code, syscall, path) {
  const messages = {
    ENOENT: 'no such file or directory',
    EEXIST: 'file already exists',
    ENOTDIR: 'not a directory',
    EISDIR: 'illegal operation on a directory',
    ENOTEMPTY: 'directory not empty',
  };
  const error = new Error(`${code}: ${messages[code] ?? 'error'}, ${syscall} '${path}'`);
  error.code = code;
  error.syscall = syscall;
  error.path = path;
  return error;
}

export class MemoryFs {
  /** path -> { kind: 'dir', mtimeMs } | { kind: 'file', data, mtimeMs } */
  #entries = new Map();
  /** dir path -> Set of child names, so listing a directory never scans the whole disk. */
  #children = new Map();
  #dirty = new Set();
  #db = null;
  #timer = null;
  #writing = Promise.resolve();

  constructor() {
    this.#setDir('/');
  }

  // -- persistence -----------------------------------------------------------

  /** Opens the database and loads every entry. Without IndexedDB the disk still works, in memory only. */
  async load() {
    try {
      this.#db = await openDb();
    } catch {
      this.#db = null;
      return { persisted: false };
    }
    const rows = await request(this.#db.transaction(STORE).objectStore(STORE).getAll());
    // Parents before children, so every entry finds its directory already there.
    rows.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    for (const row of rows) {
      if (row.kind === 'dir') this.#setDir(row.path, row.mtimeMs);
      else this.#setFile(row.path, row.data, row.mtimeMs);
    }
    return { persisted: true, entries: rows.length };
  }

  get persistent() {
    return !!this.#db;
  }

  /** Writes every pending change. Resolves once the transaction has committed. */
  flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#db || !this.#dirty.size) return this.#writing;
    const paths = [...this.#dirty];
    this.#dirty.clear();
    const db = this.#db;
    this.#writing = this.#writing.then(
      () =>
        new Promise((settle, fail) => {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          for (const path of paths) {
            const entry = this.#entries.get(path);
            if (entry) store.put({ path, ...entry });
            else store.delete(path);
          }
          tx.oncomplete = () => settle();
          tx.onerror = () => fail(tx.error);
          tx.onabort = () => fail(tx.error ?? new Error('IndexedDB write aborted'));
        }),
    );
    return this.#writing;
  }

  #touch(path) {
    this.#dirty.add(path);
    if (!this.#timer) this.#timer = setTimeout(() => void this.flush(), 250);
  }

  // -- reading ---------------------------------------------------------------

  stat(path) {
    return this.#entries.get(resolve(path));
  }

  exists(path) {
    return this.#entries.has(resolve(path));
  }

  readFile(path) {
    const full = resolve(path);
    const entry = this.#entries.get(full);
    if (!entry) throw fsError('ENOENT', 'open', full);
    if (entry.kind === 'dir') throw fsError('EISDIR', 'read', full);
    return entry.data;
  }

  readdir(path) {
    const full = resolve(path);
    const entry = this.#entries.get(full);
    if (!entry) throw fsError('ENOENT', 'scandir', full);
    if (entry.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', full);
    return [...(this.#children.get(full) ?? [])].sort();
  }

  /** Every file at or below `root`, as `[absolutePath, data]`. */
  files(root) {
    const base = resolve(root);
    const prefix = base === '/' ? '/' : `${base}/`;
    const out = [];
    for (const [path, entry] of this.#entries) {
      if (entry.kind === 'file' && (path === base || path.startsWith(prefix))) out.push([path, entry.data]);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  // -- writing ---------------------------------------------------------------

  writeFile(path, data) {
    const full = resolve(path);
    const parent = this.#entries.get(dirname(full));
    if (!parent) throw fsError('ENOENT', 'open', full);
    if (parent.kind !== 'dir') throw fsError('ENOTDIR', 'open', full);
    if (this.#entries.get(full)?.kind === 'dir') throw fsError('EISDIR', 'open', full);
    this.#setFile(full, data);
    this.#touch(full);
  }

  mkdir(path, { recursive = false } = {}) {
    const full = resolve(path);
    const existing = this.#entries.get(full);
    if (existing) {
      if (recursive && existing.kind === 'dir') return undefined;
      throw fsError('EEXIST', 'mkdir', full);
    }
    const parent = dirname(full);
    const parentEntry = this.#entries.get(parent);
    if (!parentEntry) {
      if (!recursive) throw fsError('ENOENT', 'mkdir', full);
      this.mkdir(parent, { recursive: true });
    } else if (parentEntry.kind !== 'dir') {
      throw fsError('ENOTDIR', 'mkdir', full);
    }
    this.#setDir(full);
    this.#touch(full);
    return full;
  }

  rm(path, { recursive = false, force = false } = {}) {
    const full = resolve(path);
    const entry = this.#entries.get(full);
    if (!entry) {
      if (force) return;
      throw fsError('ENOENT', 'rm', full);
    }
    if (entry.kind === 'dir') {
      if (!recursive) throw fsError('EISDIR', 'rm', full);
      for (const name of this.readdir(full)) this.rm(`${full === '/' ? '' : full}/${name}`, { recursive: true, force: true });
    }
    if (full === '/') return;
    this.#delete(full);
  }

  rmdir(path) {
    const full = resolve(path);
    const entry = this.#entries.get(full);
    if (!entry) throw fsError('ENOENT', 'rmdir', full);
    if (entry.kind !== 'dir') throw fsError('ENOTDIR', 'rmdir', full);
    if (this.#children.get(full)?.size) throw fsError('ENOTEMPTY', 'rmdir', full);
    if (full !== '/') this.#delete(full);
  }

  // -- internals -------------------------------------------------------------

  #link(path) {
    if (path === '/') return;
    const parent = dirname(path);
    let set = this.#children.get(parent);
    if (!set) this.#children.set(parent, (set = new Set()));
    set.add(path.slice(parent === '/' ? 1 : parent.length + 1));
  }

  #setDir(path, mtimeMs = Date.now()) {
    this.#entries.set(path, { kind: 'dir', mtimeMs });
    if (!this.#children.has(path)) this.#children.set(path, new Set());
    this.#link(path);
  }

  #setFile(path, data, mtimeMs = Date.now()) {
    this.#entries.set(path, { kind: 'file', data, mtimeMs });
    this.#link(path);
  }

  #delete(path) {
    this.#entries.delete(path);
    this.#children.delete(path);
    const parent = dirname(path);
    this.#children.get(parent)?.delete(path.slice(parent === '/' ? 1 : parent.length + 1));
    this.#touch(path);
  }
}

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available'));
  const open = indexedDB.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'path' });
  };
  return request(open);
}

function request(req) {
  return new Promise((settle, fail) => {
    req.onsuccess = () => settle(req.result);
    req.onerror = () => fail(req.error);
  });
}

/** The one disk the page's core and the demo host share. */
export const disk = new MemoryFs();
