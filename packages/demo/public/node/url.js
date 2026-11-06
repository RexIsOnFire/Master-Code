/** `node:url` for the page: file URLs over the demo's POSIX paths. */

export function fileURLToPath(url) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  if (parsed.protocol !== 'file:') throw new TypeError(`The URL must be of scheme file: ${parsed.href}`);
  return decodeURIComponent(parsed.pathname);
}

export function pathToFileURL(path) {
  const encoded = String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(`file://${encoded.startsWith('/') ? '' : '/'}${encoded}`);
}

const { URL: URLClass, URLSearchParams } = globalThis;
export { URLClass as URL, URLSearchParams };
export default { fileURLToPath, pathToFileURL, URL: URLClass, URLSearchParams };
