/**
 * `node:path` for the browser: POSIX semantics only.
 *
 * The demo's disk is a POSIX tree rooted at `/`, so the Windows half of
 * `node:path` has nothing to do. The working directory comes from
 * `globalThis.process` rather than an import, so the same file serves both the
 * page (where it is the demo's process shim) and the JavaScript runner (where it
 * is the running program's).
 */

export const sep = '/';
export const delimiter = ':';

const cwd = () => globalThis.process?.cwd?.() ?? '/';

/** Collapse `.`, `..` and empty segments. `..` above the root of an absolute path is dropped, as Node does. */
function collapse(segments, absolute) {
  const out = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return out;
}

export function normalize(path) {
  if (path === '') return '.';
  const absolute = path.startsWith('/');
  const trailing = path.endsWith('/');
  let body = collapse(path.split('/'), absolute).join('/');
  if (!body && !absolute) body = '.';
  if (body && trailing) body += '/';
  return absolute ? `/${body}` : body;
}

export function join(...parts) {
  const joined = parts.filter((p) => p !== '').join('/');
  return joined ? normalize(joined) : '.';
}

export function resolve(...parts) {
  let resolved = '';
  let absolute = false;
  for (let i = parts.length - 1; i >= -1 && !absolute; i--) {
    const part = i >= 0 ? parts[i] : cwd();
    if (!part) continue;
    resolved = `${part}/${resolved}`;
    absolute = part.startsWith('/');
  }
  const body = collapse(resolved.split('/'), absolute).join('/');
  return absolute ? `/${body}` : body || '.';
}

export function isAbsolute(path) {
  return path.startsWith('/');
}

function stripTrailing(path) {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/** Node's POSIX algorithm, kept literal: its handling of repeated slashes is what callers see on a real system. */
export function dirname(path) {
  if (!path) return '.';
  const hasRoot = path[0] === '/';
  let end = -1;
  let inName = false;
  for (let i = path.length - 1; i >= 1; i--) {
    if (path[i] === '/') {
      if (inName) {
        end = i;
        break;
      }
    } else {
      inName = true;
    }
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

export function basename(path, ext) {
  const trimmed = stripTrailing(path);
  const base = trimmed === '/' ? '' : trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return ext && base !== ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

export function extname(path) {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  // A leading dot starts a name, not an extension; `..` is a name like any other.
  return dot <= 0 || base === '..' ? '' : base.slice(dot);
}

export function relative(from, to) {
  const a = resolve(from);
  const b = resolve(to);
  if (a === b) return '';
  const left = a === '/' ? [] : a.slice(1).split('/');
  const right = b === '/' ? [] : b.slice(1).split('/');
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return [...left.slice(shared).map(() => '..'), ...right.slice(shared)].join('/');
}

export function parse(path) {
  const root = path.startsWith('/') ? '/' : '';
  const base = basename(path);
  const ext = extname(path);
  const dir = dirname(path);
  return { root, dir: dir === '.' && !path.includes('/') ? '' : dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export function format({ dir, root, base, name, ext }) {
  const file = base ?? `${name ?? ''}${ext ?? ''}`;
  const folder = dir ?? root ?? '';
  return folder ? (folder.endsWith('/') ? `${folder}${file}` : `${folder}/${file}`) : file;
}

export function toNamespacedPath(path) {
  return path;
}

const path = { sep, delimiter, normalize, join, resolve, isAbsolute, dirname, basename, extname, relative, parse, format, toNamespacedPath };
path.posix = path;
export const posix = path;
export default path;
