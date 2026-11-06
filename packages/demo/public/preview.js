/**
 * The preview shell: shows a generated page without giving it the site's origin.
 *
 * The page is the user's code - possibly from a zip someone else made - so it
 * runs in a `sandbox="allow-scripts"` iframe, which has an opaque origin: it
 * cannot read the demo's IndexedDB or anything else stored for this site, and
 * cannot reach into this shell. The cost of that boundary is that the iframe
 * cannot fetch the project's files by URL either, so this shell assembles each
 * page before handing it over:
 *
 *   stylesheets      inlined as <style>, with local url()s as data: URIs
 *   scripts          data: URLs; module imports rewritten to data: URLs too,
 *                    declared npm packages to jsDelivr's ES module build
 *   images, media    data: URIs
 *   fetch() of a     answered from a copy of the project's text files
 *   relative URL
 *   relative links   sent back here and rendered as the next page
 */

import process from './node/process.js';
import { disk } from './vfs.js';
import { dirname, extname, relative, resolve } from './node/path.js';

globalThis.process = process;

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain', '.csv': 'text/csv', '.md': 'text/markdown',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wasm': 'application/wasm',
};
const mimeOf = (path) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
const isLocal = (url) => !!url && !url.startsWith('#') && !url.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(url);
const encoder = new TextEncoder();

const frame = document.getElementById('frame');
const where = document.getElementById('where');
const problem = document.getElementById('problem');

const params = new URLSearchParams(location.search);
const out = resolve(params.get('out') ?? '/');
let page = params.get('page') ?? 'index.html';

function read(path) {
  const data = disk.readFile(path);
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

function dataUri(path) {
  const data = disk.readFile(path);
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mimeOf(path)};base64,${btoa(binary)}`;
}

/** A path inside the output directory, or null for anything that would leave it or does not exist. */
function local(url, fromFile) {
  const clean = url.split(/[?#]/)[0];
  const path = resolve(dirname(fromFile), decodeURIComponent(clean));
  return path.startsWith(`${out}/`) && disk.stat(path)?.kind === 'file' ? path : null;
}

const declared = (() => {
  try {
    const manifest = JSON.parse(read(`${out}/package.json`));
    return { ...manifest.devDependencies, ...manifest.dependencies };
  } catch {
    return {};
  }
})();

// -- modules -------------------------------------------------------------------

const STATIC_IMPORT = /(\b(?:import|export)\s+(?:[\w$*{}\s,]+?\s+from\s+)?)(['"])([^'"\n]+)\2/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

function moduleBuilder() {
  const done = new Map();
  const loading = [];

  function specifierFor(spec, from) {
    if (isLocal(spec) && (spec.startsWith('.') || spec.startsWith('/'))) {
      const target = local(spec, from);
      if (!target) throw new Error(`${relative(out, from)} imports "${spec}", which is not in the project.`);
      return url(target);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return spec;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    const version = declared[name];
    if (!version) throw new Error(`${relative(out, from)} imports "${spec}", which is not declared in package.json. Add it under Libraries.`);
    return `https://cdn.jsdelivr.net/npm/${name}@${encodeURIComponent(version)}${spec.slice(name.length)}/+esm`;
  }

  function rewrite(source, from) {
    return source
      .replace(/\bimport\.meta\.url\b/g, JSON.stringify(`file://${from}`))
      .replace(STATIC_IMPORT, (_, head, quote, spec) => `${head}${quote}${specifierFor(spec, from)}${quote}`)
      .replace(DYNAMIC_IMPORT, (_, quote, spec) => `import(${quote}${specifierFor(spec, from)}${quote})`);
  }

  function url(file) {
    if (done.has(file)) return done.get(file);
    if (loading.includes(file)) {
      const cycle = [...loading.slice(loading.indexOf(file)), file].map((f) => relative(out, f));
      throw new Error(`These modules import each other in a cycle: ${cycle.join(' -> ')}. A page in the demo cannot load a cycle of modules; download the project to open it from a server.`);
    }
    loading.push(file);
    try {
      const source = rewrite(read(file), file);
      const result = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
      done.set(file, result);
      return result;
    } finally {
      loading.pop();
    }
  }

  return { url, rewrite };
}

// -- styles --------------------------------------------------------------------

function inlineCss(css, fromFile, depth = 0) {
  return css
    .replace(/@import\s+(?:url\()?\s*(['"]?)([^'")\s]+)\1\s*\)?\s*;/g, (match, _q, href) => {
      const target = isLocal(href) && depth < 8 ? local(href, fromFile) : null;
      return target ? inlineCss(read(target), target, depth + 1) : match;
    })
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _q, href) => {
      const target = isLocal(href) ? local(href, fromFile) : null;
      return target ? `url("${dataUri(target)}")` : match;
    });
}

// -- the page --------------------------------------------------------------------

/** Runs first inside the sandbox: answers fetch() for project files and hands relative links back to the shell. */
function bootstrap(files, pageDir) {
  return `(() => {
  const files = ${JSON.stringify(files).replace(/</g, '\\u003c')};
  const pageDir = ${JSON.stringify(pageDir)};
  const local = (url) => url && !url.startsWith('#') && !url.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(url);
  const resolve = (url) => {
    const parts = (url.startsWith('/') ? url.slice(1) : pageDir ? pageDir + '/' + url : url).split(/[?#]/)[0].split('/');
    const outParts = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') outParts.pop(); else outParts.push(decodeURIComponent(part));
    }
    return outParts.join('/');
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!local(url)) return realFetch(input, init);
    const hit = files[resolve(url)];
    return Promise.resolve(hit === undefined
      ? new Response('Not found in the project', { status: 404 })
      : new Response(hit.body, { status: 200, headers: { 'content-type': hit.type } }));
  };
  document.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link || link.target === '_blank') return;
    const href = link.getAttribute('href');
    if (!local(href)) return;
    event.preventDefault();
    parent.postMessage({ type: 'mastercode-preview-navigate', path: resolve(href) }, '*');
  });
})();`;
}

function textFiles() {
  const files = {};
  let budget = 8 * 1024 * 1024;
  for (const [path, data] of disk.files(out)) {
    if (typeof data !== 'string' || /\.(html|py|pyc)$/.test(path)) continue;
    if ((budget -= data.length) < 0) break;
    files[relative(out, path)] = { body: data, type: mimeOf(path) };
  }
  return files;
}

function assemble(file) {
  const doc = new DOMParser().parseFromString(read(file), 'text/html');
  const modules = moduleBuilder();

  for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const target = isLocal(link.getAttribute('href')) ? local(link.getAttribute('href'), file) : null;
    if (!target) continue;
    const style = doc.createElement('style');
    style.textContent = inlineCss(read(target), target);
    link.replaceWith(style);
  }
  for (const style of doc.querySelectorAll('style')) style.textContent = inlineCss(style.textContent, file);

  for (const script of doc.querySelectorAll('script')) {
    const src = script.getAttribute('src');
    const isModule = script.getAttribute('type') === 'module';
    if (src && isLocal(src)) {
      const target = local(src, file);
      if (!target) continue;
      script.setAttribute('src', isModule ? modules.url(target) : `data:text/javascript;charset=utf-8,${encodeURIComponent(read(target))}`);
    } else if (!src && isModule) {
      script.textContent = modules.rewrite(script.textContent, file);
    }
  }

  for (const element of doc.querySelectorAll('img[src], source[src], video[src], audio[src], track[src], input[src], link[rel~="icon"][href]')) {
    const attribute = element.hasAttribute('src') ? 'src' : 'href';
    const value = element.getAttribute(attribute);
    const target = isLocal(value) ? local(value, file) : null;
    if (target) element.setAttribute(attribute, dataUri(target));
  }
  for (const element of doc.querySelectorAll('[style]')) element.setAttribute('style', inlineCss(element.getAttribute('style'), file));

  const boot = doc.createElement('script');
  boot.textContent = bootstrap(textFiles(), dirname(relative(out, file)) === '.' ? '' : dirname(relative(out, file)));
  doc.head.prepend(boot);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function show(path) {
  problem.hidden = true;
  const file = resolve(out, path);
  if (!file.startsWith(`${out}/`) || disk.stat(file)?.kind !== 'file') {
    problem.textContent = `${path} is not a page in this project's output. Generate the project, then reload.`;
    problem.hidden = false;
    return;
  }
  try {
    frame.srcdoc = assemble(file);
    page = relative(out, file);
    where.textContent = page;
    document.title = `${page} — preview`;
    history.replaceState(null, '', `?${new URLSearchParams({ out, page })}`);
  } catch (error) {
    problem.textContent = String(error?.message ?? error);
    problem.hidden = false;
  }
}

addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.data?.type !== 'mastercode-preview-navigate') return;
  const path = String(event.data.path ?? '');
  if (/\.html?$/i.test(path)) show(path);
});

// A fresh load, not a second disk.load(): that would merge, keeping files since deleted.
document.getElementById('reload').onclick = () => location.reload();

await disk.load();
show(page);
