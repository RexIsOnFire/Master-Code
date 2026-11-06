/**
 * JavaScript for the demo: Node-style programs in a module worker.
 *
 * Created by the page from a `data:` URL, so it runs with an opaque origin and
 * cannot reach the demo's stored projects. One worker per run; the page ends it
 * afterwards, which is also how a timeout stops a program that never returns.
 *
 * What a generated Node program expects, and where it comes from here:
 *   - its files      a private copy of the run directory, behind `node:fs`
 *   - its modules    each project file becomes a blob: module with its import
 *                    specifiers rewritten - project files to their blobs, `node:`
 *                    modules to the shims below, declared npm packages to
 *                    jsDelivr's ES module build
 *   - `process`      argv, env, exit, stdout/stderr, getBuiltinModule
 *   - `node --test`  a small runner that prints the TAP the core already parses
 *
 * Node features a browser has no equivalent for - listening sockets, child
 * processes, SQLite, the inspector - fail with a message that says so, rather
 * than being half-imitated. ES modules that import each other in a cycle cannot
 * be expressed as blob URLs (each needs the other's URL first) and are refused
 * with the cycle named.
 *
 * Messages in:  { type: 'run', job, sources }   (the node-runtime modules' source, keyed by name)
 * Messages out: { type: 'note' | 'started' | 'output' | 'exit', ... } as for Python
 */

/** The run every message belongs to; the page ignores messages for any other. */
let runId = null;
const post = (message) => self.postMessage({ ...message, id: runId });
const out = (stream, text) => post({ type: 'output', stream, text });
const note = (text) => post({ type: 'note', text });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const blobUrl = (source) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

class Exit extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.exitCode = code;
  }
}

const UNAVAILABLE = {
  sqlite: 'SQLite is built into Node, not into browsers',
  http: 'a browser tab cannot listen on a port',
  https: 'a browser tab cannot listen on a port',
  net: 'a browser has no raw sockets',
  child_process: 'a browser cannot start processes',
  worker_threads: 'use the program locally for threads',
  inspector: 'the inspector is part of Node',
  'inspector/promises': 'the inspector is part of Node',
  cluster: 'a browser cannot fork processes',
  dgram: 'a browser has no UDP sockets',
};

const RESERVED = new Set(['default', 'delete', 'import', 'export', 'new', 'class', 'function', 'var', 'let', 'const', 'in', 'of', 'do', 'if', 'for', 'while', 'return', 'switch', 'case', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'typeof', 'instanceof', 'void', 'with', 'yield', 'await', 'enum', 'super', 'this', 'null', 'true', 'false']);

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  runId = data.id;
  let code = 1;
  let diff = { changes: [], removed: [] };
  try {
    const runtime = {};
    for (const [name, source] of Object.entries(data.sources)) runtime[name] = await import(blobUrl(source));
    const program = createProgram(data.job, runtime);
    post({ type: 'started' });
    code = await program.main();
    diff = program.diff();
  } catch (error) {
    out('stderr', `${error?.stack ?? error}\n`);
  }
  post({ type: 'exit', code, ...diff });
};

function createProgram(job, runtime) {
  const { inspect, format } = runtime.inspect;
  const path = runtime.path.default;
  const files = new Map(job.files);
  const original = new Map(job.files);
  const dirs = new Set(['/']);
  const addParents = (file) => {
    for (let dir = path.dirname(file); !dirs.has(dir); dir = path.dirname(dir)) dirs.add(dir);
  };
  for (const file of files.keys()) addParents(file);
  dirs.add(job.cwd);
  addParents(job.cwd);

  // -- process ---------------------------------------------------------------

  let cwd = job.cwd;
  const exitListeners = [];
  const proc = {
    argv: ['/usr/bin/node'],
    execArgv: [],
    env: { ...job.env },
    platform: 'linux',
    arch: 'wasm32',
    version: 'v22.0.0',
    versions: { node: '22.0.0' },
    release: { name: 'node' },
    pid: 1,
    exitCode: undefined,
    cwd: () => cwd,
    chdir(dir) {
      const target = path.resolve(cwd, dir);
      if (!dirs.has(target)) throw nodeError('ENOENT', 'chdir', target);
      cwd = target;
    },
    exit(code) {
      throw new Exit(code ?? proc.exitCode ?? 0);
    },
    on(event, fn) {
      if (event === 'exit') exitListeners.push(fn);
      return proc;
    },
    once(event, fn) {
      return proc.on(event, fn);
    },
    off: () => proc,
    removeListener: () => proc,
    emitWarning: (warning) => out('stderr', `(node) Warning: ${warning?.message ?? warning}\n`),
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    hrtime: Object.assign(() => [Math.floor(performance.now() / 1000), Math.floor((performance.now() % 1000) * 1e6)], {
      bigint: () => BigInt(Math.floor(performance.now() * 1e6)),
    }),
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    uptime: () => performance.now() / 1000,
    stdout: { write: (text) => (out('stdout', String(text)), true), isTTY: false, columns: 80 },
    stderr: { write: (text) => (out('stderr', String(text)), true), isTTY: false, columns: 80 },
    stdin: { isTTY: false, fd: 0 },
    getBuiltinModule: (specifier) => builtin(specifier),
  };
  globalThis.process = proc;

  const write = (stream) => (...args) => out(stream, `${format(...args)}\n`);
  Object.assign(console, {
    log: write('stdout'),
    info: write('stdout'),
    debug: write('stdout'),
    error: write('stderr'),
    warn: write('stderr'),
    trace: (...args) => out('stderr', `Trace: ${format(...args)}\n${new Error().stack?.split('\n').slice(2).join('\n') ?? ''}\n`),
    dir: (value) => out('stdout', `${inspect(value)}\n`),
  });

  // -- Buffer, enough for what generated code does with it --------------------

  class Buffer extends Uint8Array {
    static alloc(size, fill = 0) {
      return new Buffer(size).fill(fill);
    }
    static from(value, encoding) {
      if (typeof value === 'string') {
        if (encoding === 'base64') return new Buffer(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
        if (encoding === 'hex') return new Buffer((value.match(/../g) ?? []).map((h) => parseInt(h, 16)));
        return new Buffer(encoder.encode(value));
      }
      return new Buffer(value);
    }
    static concat(list) {
      const result = new Buffer(list.reduce((n, b) => n + b.length, 0));
      let at = 0;
      for (const b of list) {
        result.set(b, at);
        at += b.length;
      }
      return result;
    }
    static isBuffer(value) {
      return value instanceof Buffer;
    }
    static byteLength(text) {
      return encoder.encode(String(text)).byteLength;
    }
    toString(encoding = 'utf8', start = 0, end = this.length) {
      const slice = this.subarray(start, end);
      if (encoding === 'hex') return [...slice].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (encoding === 'base64') return btoa(String.fromCharCode(...slice));
      return decoder.decode(slice);
    }
  }
  globalThis.Buffer = Buffer;

  // -- fs over the private copy ------------------------------------------------

  function nodeError(code, syscall, target) {
    const text = { ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory', ENOTEMPTY: 'directory not empty' }[code];
    const error = new Error(`${code}: ${text ?? 'error'}, ${syscall} '${target}'`);
    Object.assign(error, { code, syscall, path: target });
    return error;
  }

  const full = (p) => path.resolve(cwd, String(p instanceof URL ? decodeURIComponent(p.pathname) : p));
  const stdinBytes = encoder.encode(job.stdin ?? '');
  let stdinAt = 0;

  const stats = (target) => {
    const isDir = dirs.has(target);
    const data = files.get(target);
    if (!isDir && data === undefined) return undefined;
    const size = isDir ? 0 : typeof data === 'string' ? encoder.encode(data).byteLength : data.byteLength;
    return { size, isDirectory: () => isDir, isFile: () => !isDir, isSymbolicLink: () => false, mtime: new Date(), mtimeMs: Date.now() };
  };

  const fs = {
    existsSync: (p) => {
      const target = full(p);
      return dirs.has(target) || files.has(target);
    },
    statSync(p, options) {
      const target = full(p);
      const s = stats(target);
      if (!s && options?.throwIfNoEntry === false) return undefined;
      if (!s) throw nodeError('ENOENT', 'stat', target);
      return s;
    },
    readFileSync(p, options) {
      if (p === 0 || p === '/dev/stdin') return (typeof options === 'string' || options?.encoding) ? decoder.decode(stdinBytes) : Buffer.from(stdinBytes);
      const target = full(p);
      if (dirs.has(target)) throw nodeError('EISDIR', 'read', target);
      const data = files.get(target);
      if (data === undefined) throw nodeError('ENOENT', 'open', target);
      const text = typeof options === 'string' || options?.encoding;
      if (text) return typeof data === 'string' ? data : decoder.decode(data);
      return Buffer.from(typeof data === 'string' ? encoder.encode(data) : data);
    },
    writeFileSync(p, data) {
      const target = full(p);
      if (!dirs.has(path.dirname(target))) throw nodeError('ENOENT', 'open', target);
      if (dirs.has(target)) throw nodeError('EISDIR', 'open', target);
      files.set(target, typeof data === 'string' ? data : new Uint8Array(data));
    },
    appendFileSync(p, data) {
      const target = full(p);
      const before = files.has(target) ? fs.readFileSync(target, 'utf8') : '';
      fs.writeFileSync(target, before + String(data));
    },
    mkdirSync(p, options) {
      const target = full(p);
      if (dirs.has(target)) {
        if (options?.recursive) return undefined;
        throw nodeError('EEXIST', 'mkdir', target);
      }
      if (!dirs.has(path.dirname(target))) {
        if (!options?.recursive) throw nodeError('ENOENT', 'mkdir', target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
      }
      dirs.add(target);
      return target;
    },
    readdirSync(p, options) {
      const target = full(p);
      if (!dirs.has(target)) throw nodeError(files.has(target) ? 'ENOTDIR' : 'ENOENT', 'scandir', target);
      const prefix = target === '/' ? '/' : `${target}/`;
      const names = new Set();
      for (const entry of [...dirs, ...files.keys()]) {
        if (entry !== target && entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split('/')[0]);
      }
      const sorted = [...names].sort();
      if (!options?.withFileTypes) return sorted;
      return sorted.map((name) => ({ name, ...stats(prefix + name) }));
    },
    rmSync(p, options) {
      const target = full(p);
      if (files.delete(target)) return;
      if (dirs.has(target)) {
        if (!options?.recursive) throw nodeError('EISDIR', 'rm', target);
        for (const file of [...files.keys()]) if (file.startsWith(`${target}/`)) files.delete(file);
        for (const dir of [...dirs]) if (dir === target || dir.startsWith(`${target}/`)) dirs.delete(dir);
        return;
      }
      if (!options?.force) throw nodeError('ENOENT', 'rm', target);
    },
    unlinkSync(p) {
      const target = full(p);
      if (!files.delete(target)) throw nodeError(dirs.has(target) ? 'EISDIR' : 'ENOENT', 'unlink', target);
    },
    rmdirSync(p) {
      const target = full(p);
      if (!dirs.has(target)) throw nodeError('ENOENT', 'rmdir', target);
      if (fs.readdirSync(target).length) throw nodeError('ENOTEMPTY', 'rmdir', target);
      dirs.delete(target);
    },
    renameSync(from, to) {
      const a = full(from);
      const b = full(to);
      if (files.has(a)) {
        files.set(b, files.get(a));
        files.delete(a);
        return;
      }
      throw nodeError('ENOENT', 'rename', a);
    },
    /** Only standard input is readable by descriptor - which is what readLine() uses. */
    readSync(fd, buffer, offset = 0, length = buffer.length) {
      if (fd !== 0) throw new Error('Only standard input (fd 0) can be read by descriptor in the browser demo.');
      const chunk = stdinBytes.subarray(stdinAt, stdinAt + length);
      buffer.set(chunk, offset);
      stdinAt += chunk.length;
      return chunk.length;
    },
  };
  fs.promises = Object.fromEntries(
    ['readFile', 'writeFile', 'appendFile', 'mkdir', 'readdir', 'rm', 'stat', 'unlink', 'rmdir', 'rename'].map((name) => [
      name,
      async (...args) => fs[`${name}Sync`](...args),
    ]),
  );
  fs.promises.access = async (p) => {
    if (!fs.existsSync(p)) throw nodeError('ENOENT', 'access', full(p));
  };

  // -- the test runner ---------------------------------------------------------

  const suiteRoot = { name: '', children: [], hooks: { before: [], after: [], beforeEach: [], afterEach: [] } };
  let currentSuite = suiteRoot;
  const register = (kind, name, options, fn) => {
    if (typeof name === 'function') [fn, options, name] = [name, {}, name.name || '<anonymous>'];
    if (typeof options === 'function') [fn, options] = [options, {}];
    const node = { kind, name: String(name), fn, skip: !!options?.skip, todo: !!options?.todo, children: [], hooks: { before: [], after: [], beforeEach: [], afterEach: [] } };
    currentSuite.children.push(node);
    if (kind === 'suite' && typeof fn === 'function') {
      const parent = currentSuite;
      currentSuite = node;
      try {
        fn();
      } finally {
        currentSuite = parent;
      }
    }
    return Promise.resolve();
  };
  const test = (name, options, fn) => register('test', name, options, fn);
  const describe = (name, options, fn) => register('suite', name, options, fn);
  test.skip = (name, options, fn) => register('test', name, { skip: true }, typeof options === 'function' ? options : fn);
  test.todo = (name, options, fn) => register('test', name, { todo: true }, typeof options === 'function' ? options : fn);
  test.only = test;
  describe.skip = (name, options, fn) => register('suite', name, { skip: true }, typeof options === 'function' ? options : fn);
  Object.assign(test, {
    test,
    it: test,
    describe,
    suite: describe,
    before: (fn) => currentSuite.hooks.before.push(fn),
    after: (fn) => currentSuite.hooks.after.push(fn),
    beforeEach: (fn) => currentSuite.hooks.beforeEach.push(fn),
    afterEach: (fn) => currentSuite.hooks.afterEach.push(fn),
  });

  const yamlLine = (text) => `'${String(text).split('\n')[0].replace(/'/g, "''")}'`;

  async function runSuite(suite, depth, chain, totals) {
    const pad = '    '.repeat(depth);
    let index = 0;
    let failed = false;
    for (const fn of suite.hooks.before) await fn();
    for (const child of suite.children) {
      index += 1;
      out('stdout', `${pad}# Subtest: ${child.name}\n`);
      const started = performance.now();
      let error = null;
      if (child.kind === 'suite') {
        if (!child.skip && (await runSuite(child, depth + 1, [...chain, child], totals))) error = new Error(`${child.name}: subtests failed`);
      } else if (!child.skip && !child.todo && typeof child.fn === 'function') {
        try {
          for (const s of chain) for (const fn of s.hooks.beforeEach) await fn();
          await child.fn({ name: child.name, diagnostic: (m) => out('stdout', `${pad}# ${m}\n`), skip: () => {}, todo: () => {} });
          for (const s of [...chain].reverse()) for (const fn of s.hooks.afterEach) await fn();
        } catch (e) {
          error = e;
        }
      }
      const directive = child.skip ? ' # SKIP' : child.todo ? ' # TODO' : '';
      const ms = (performance.now() - started).toFixed(3);
      if (child.kind === 'test') {
        if (child.skip || child.todo) totals.skipped += 1;
        else if (error) totals.failed += 1;
        else totals.passed += 1;
      }
      if (error) failed = true;
      out('stdout', `${pad}${error ? 'not ok' : 'ok'} ${index} - ${child.name}${directive}\n${pad}  ---\n${pad}  duration_ms: ${ms}\n`);
      if (error) {
        out('stdout', `${pad}  failureType: 'testCodeFailure'\n${pad}  error: ${yamlLine(error.message ?? error)}\n${pad}  code: '${error.code ?? 'ERR_TEST_FAILURE'}'\n`);
      }
      out('stdout', `${pad}  ...\n`);
    }
    for (const fn of suite.hooks.after) await fn();
    out('stdout', `${pad}1..${index}\n`);
    return failed;
  }

  /**
   * The files `node --test` would run. With no arguments, Node's own name
   * patterns under the working directory. With a directory, every JavaScript
   * file below it - what the generated `node --test tests/` intends, and how Node
   * 20 read a directory argument.
   */
  function testFiles(targets) {
    const js = /\.(c|m)?js$/;
    const named = /(^|\/)(test|test-[^/]*|[^/]*[.\-_]test)\.(c|m)?js$|(^|\/)test\/.+\.(c|m)?js$/;
    const found = new Set();
    const candidates = [...files.keys()].filter((f) => js.test(f) && !f.includes('/node_modules/'));
    if (!targets.length) {
      for (const f of candidates) if (f.startsWith(`${cwd}/`) && named.test(f.slice(cwd.length + 1))) found.add(f);
    }
    for (const target of targets) {
      const abs = path.resolve(cwd, target);
      if (dirs.has(abs)) {
        for (const f of candidates) if (f.startsWith(`${abs}/`)) found.add(f);
      } else if (files.has(abs)) {
        found.add(abs);
      } else {
        throw new Error(`Could not find '${abs}'`);
      }
    }
    return [...found].sort();
  }

  async function runTests(targets) {
    const totals = { passed: 0, failed: 0, skipped: 0 };
    out('stdout', 'TAP version 13\n');
    for (const file of testFiles(targets)) {
      suiteRoot.children = [];
      proc.argv = ['/usr/bin/node', file];
      await import(moduleUrl(file));
      await runSuite(suiteRoot, 0, [suiteRoot], totals);
    }
    out('stdout', `# tests ${totals.passed + totals.failed + totals.skipped}\n# pass ${totals.passed}\n# fail ${totals.failed}\n# skipped ${totals.skipped}\n`);
    return totals.failed ? 1 : 0;
  }

  // -- built-in modules ----------------------------------------------------------

  const assert = runtime.assert.createAssert(inspect);
  const crypto = runtime.digest.createCrypto();
  const urlModule = {
    URL,
    URLSearchParams,
    fileURLToPath: (u) => decodeURIComponent(new URL(String(u)).pathname),
    pathToFileURL: (p) => new URL(`file://${encodeURI(path.resolve(cwd, String(p)))}`),
  };
  const builtins = {
    fs,
    'fs/promises': fs.promises,
    path,
    'path/posix': path,
    process: proc,
    test,
    assert,
    'assert/strict': assert.strict,
    url: urlModule,
    util: { inspect, format, promisify: (fn) => (...a) => new Promise((ok, no) => fn(...a, (e, v) => (e ? no(e) : ok(v)))), isDeepStrictEqual: (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } } },
    os: { EOL: '\n', platform: () => 'linux', homedir: () => proc.env.HOME ?? '/home/demo', tmpdir: () => '/tmp', cpus: () => [], arch: () => 'wasm32', hostname: () => 'browser' },
    crypto,
    buffer: { Buffer },
    timers: { setTimeout: (...a) => globalThis.setTimeout(...a), clearTimeout: (id) => globalThis.clearTimeout(id), setInterval: (...a) => globalThis.setInterval(...a), clearInterval: (id) => globalThis.clearInterval(id) },
    events: { EventEmitter: createEventEmitter() },
  };
  builtins.events.default = builtins.events.EventEmitter;

  function builtin(specifier) {
    const name = String(specifier).replace(/^node:/, '');
    if (name in UNAVAILABLE) {
      throw new Error(`"node:${name}" is not available in the browser demo: ${UNAVAILABLE[name]}. Download the project to run it with Node.`);
    }
    if (!(name in builtins)) throw new Error(`No such built-in module: node:${name}`);
    return builtins[name];
  }

  const builtinUrls = new Map();
  function builtinUrl(specifier) {
    const name = String(specifier).replace(/^node:/, '');
    if (builtinUrls.has(name)) return builtinUrls.get(name);
    let source;
    try {
      const module = builtin(name);
      const names = Object.keys(module).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k));
      source = `const m = globalThis.process.getBuiltinModule(${JSON.stringify(`node:${name}`)});\nexport default m;\n${names.length ? `export const { ${names.join(', ')} } = m;\n` : ''}`;
    } catch (error) {
      source = `throw new Error(${JSON.stringify(error.message)});\n`;
    }
    const url = blobUrl(source);
    builtinUrls.set(name, url);
    return url;
  }

  // -- project modules -----------------------------------------------------------

  const urlOf = new Map();
  const pathOfUrl = new Map();
  const loading = [];
  /** Node resolves `fs` and `node:fs` alike; both reach the same shim. */
  const NODE_NAMES = new Set([...Object.keys(builtins), ...Object.keys(UNAVAILABLE)]);
  const announced = new Set();

  const manifest = (() => {
    try {
      const text = files.get(`${job.cwd}/package.json`);
      return typeof text === 'string' ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  })();
  const declared = { ...manifest.devDependencies, ...manifest.dependencies };

  function packageUrl(specifier, from) {
    const parts = specifier.split('/');
    const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const subpath = specifier.slice(name.length);
    const version = declared[name];
    if (!version) {
      throw new Error(`Cannot find package '${name}' imported from ${from}. Add it to the project under Libraries so it is declared in package.json.`);
    }
    if (!announced.has(name)) {
      announced.add(name);
      note(`Loading ${name}@${version} from jsDelivr - in the browser, packages come from a CDN instead of node_modules.`);
    }
    return `https://cdn.jsdelivr.net/npm/${name}@${encodeURIComponent(version)}${subpath}/+esm`;
  }

  function resolveImport(specifier, from) {
    const bare = specifier.replace(/^node:/, '');
    if (specifier.startsWith('node:') || NODE_NAMES.has(bare)) return builtinUrl(bare);
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
      const target = path.resolve(path.dirname(from), specifier);
      if (!files.has(target)) throw new Error(`Cannot find module '${target}' imported from ${from}`);
      return moduleUrl(target);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return specifier;
    return packageUrl(specifier, from);
  }

  const STATIC_IMPORT = /(\b(?:import|export)\s+(?:[\w$*{}\s,]+?\s+from\s+)?)(['"])([^'"\n]+)\2/g;
  const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

  function moduleUrl(file) {
    if (urlOf.has(file)) return urlOf.get(file);
    if (loading.includes(file)) {
      const cycle = [...loading.slice(loading.indexOf(file)), file].map((f) => path.relative(job.cwd, f));
      throw new Error(`These modules import each other in a cycle: ${cycle.join(' -> ')}. The browser demo cannot load a cycle of ES modules; download the project to run it with Node.`);
    }
    loading.push(file);
    try {
      const data = files.get(file);
      let source = typeof data === 'string' ? data : decoder.decode(data);
      const fileUrl = `file://${encodeURI(file)}`;
      source = source
        .replace(/\bimport\.meta\.url\b/g, JSON.stringify(fileUrl))
        .replace(/\bimport\.meta\.filename\b/g, JSON.stringify(file))
        .replace(/\bimport\.meta\.dirname\b/g, JSON.stringify(path.dirname(file)))
        .replace(STATIC_IMPORT, (_, head, quote, spec) => `${head}${quote}${resolveImport(spec, file)}${quote}`)
        .replace(DYNAMIC_IMPORT, (_, quote, spec) => `import(${quote}${resolveImport(spec, file)}${quote})`);
      const url = blobUrl(source);
      urlOf.set(file, url);
      pathOfUrl.set(url, file);
      return url;
    } finally {
      loading.pop();
    }
  }

  /** Stack traces name blob: URLs; put the project's paths back so diagnostics land on the right file and line. */
  function readableStack(error) {
    let text = error?.stack ?? String(error);
    if (error && error.stack && !text.includes(error.message ?? '')) text = `${error.name}: ${error.message}\n${text}`;
    for (const [url, file] of pathOfUrl) text = text.split(url).join(file);
    return text;
  }

  // -- timers, so the run lasts as long as Node's event loop would ------------------

  let pending = 0;
  let onIdle = null;
  const settleIdle = () => {
    if (pending === 0 && onIdle) {
      const resolveIdle = onIdle;
      onIdle = null;
      resolveIdle();
    }
  };
  const timers = new Set();
  const native = { setTimeout, clearTimeout, setInterval, clearInterval };
  globalThis.setTimeout = (fn, ms, ...args) => {
    pending += 1;
    const id = native.setTimeout(() => {
      timers.delete(id);
      pending -= 1;
      try {
        if (typeof fn === 'function') fn(...args);
      } finally {
        queueMicrotask(settleIdle);
      }
    }, ms);
    timers.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    if (timers.delete(id)) {
      pending -= 1;
      queueMicrotask(settleIdle);
    }
    native.clearTimeout(id);
  };
  const intervals = new Set();
  globalThis.setInterval = (fn, ms, ...args) => {
    pending += 1;
    const id = native.setInterval(fn, ms, ...args);
    intervals.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    if (intervals.delete(id)) {
      pending -= 1;
      queueMicrotask(settleIdle);
    }
    native.clearInterval(id);
  };
  globalThis.setImmediate = (fn, ...args) => globalThis.setTimeout(fn, 0, ...args);
  globalThis.clearImmediate = (id) => globalThis.clearTimeout(id);
  const idle = () => new Promise((resolveIdle) => {
    onIdle = resolveIdle;
    settleIdle();
  });

  // -- running -------------------------------------------------------------------

  async function body(args) {
    const flags = [];
    while (args.length && args[0].startsWith('-') && !['-e', '--eval', '--test', '--check', '-c'].includes(args[0])) flags.push(args.shift());
    const [first, ...rest] = args;
    if (first === '--test') return runTests(rest.filter((a) => !a.startsWith('-')));
    if (first === '--check' || first === '-c') {
      note('Syntax is checked when the program runs; a browser has no separate parse-only step.');
      return 0;
    }
    if (first === '-e' || first === '--eval') {
      proc.argv = ['/usr/bin/node', ...rest.slice(1)];
      await import(blobUrl(rest[0] ?? ''));
      return undefined;
    }
    if (!first) throw new Error('No script given. An interactive REPL is not available in the browser demo.');
    let script = first;
    let programArgs = rest;
    if (path.basename(first).startsWith('_mcode_trace')) {
      note("Line tracing for JavaScript uses Node's inspector, which a browser does not have; the program ran without it.");
      [script, ...programArgs] = rest;
    }
    const entry = path.resolve(cwd, script);
    if (!files.has(entry)) throw new Error(`Cannot find module '${entry}'`);
    proc.argv = ['/usr/bin/node', entry, ...programArgs];
    await import(moduleUrl(entry));
    return undefined;
  }

  function main() {
    return new Promise((settle) => {
      let done = false;
      const end = (code) => {
        if (done) return;
        done = true;
        for (const fn of exitListeners) {
          try {
            fn(code);
          } catch {
            /* an exit listener cannot change the outcome */
          }
        }
        settle(code);
      };
      const fail = (error) => {
        if (error instanceof Exit) return end(error.exitCode);
        out('stderr', `${readableStack(error)}\n`);
        end(1);
      };
      self.addEventListener('error', (event) => {
        event.preventDefault();
        fail(event.error ?? new Error(event.message));
      });
      self.addEventListener('unhandledrejection', (event) => {
        event.preventDefault();
        fail(event.reason);
      });
      body([...job.args])
        .then(async (code) => {
          if (code !== undefined) return end(code);
          await idle();
          end(proc.exitCode ?? 0);
        })
        .catch(fail);
    });
  }

  function diff() {
    const changes = [];
    for (const [file, data] of files) {
      if (file.includes('/node_modules/') || sameData(original.get(file), data)) continue;
      changes.push([file, typeof data === 'string' ? data : textOrBytes(data)]);
    }
    const removed = [...original.keys()].filter((file) => !files.has(file));
    return { changes, removed };
  }

  return { main, diff };
}

function textOrBytes(bytes) {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return bytes;
  }
}

/** Whether a file's content is unchanged; text and bytes compare by their UTF-8 form. */
function sameData(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  const x = typeof a === 'string' ? encoder.encode(a) : a;
  const y = typeof b === 'string' ? encoder.encode(b) : b;
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function createEventEmitter() {
  return class EventEmitter {
    #listeners = new Map();
    on(event, fn) {
      (this.#listeners.get(event) ?? this.#listeners.set(event, []).get(event)).push(fn);
      return this;
    }
    addListener(event, fn) {
      return this.on(event, fn);
    }
    once(event, fn) {
      const wrapper = (...args) => {
        this.off(event, wrapper);
        fn.apply(this, args);
      };
      return this.on(event, wrapper);
    }
    off(event, fn) {
      const list = this.#listeners.get(event) ?? [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
      return this;
    }
    removeListener(event, fn) {
      return this.off(event, fn);
    }
    emit(event, ...args) {
      const list = [...(this.#listeners.get(event) ?? [])];
      if (event === 'error' && !list.length) throw args[0];
      for (const fn of list) fn.apply(this, args);
      return list.length > 0;
    }
    listenerCount(event) {
      return (this.#listeners.get(event) ?? []).length;
    }
  };
}
