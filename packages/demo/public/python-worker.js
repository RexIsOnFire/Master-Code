/**
 * Python for the demo: Pyodide in a worker.
 *
 * The page creates this worker from a `data:` URL, which gives it an opaque
 * origin. That is the isolation boundary: code running here cannot open the
 * demo's IndexedDB (or anything else stored for the site's origin) and can only
 * talk to the page through messages. It can still use the network, as a
 * program run on a desktop can.
 *
 * One worker serves every run, because starting Pyodide costs seconds. Each run
 * gets a fresh copy of its directory, and afterwards the interpreter is put back:
 * the project's modules are dropped from `sys.modules` so the next run imports
 * the code as it is now, and sys.path, os.environ, argv, stdin and the working
 * directory are restored. A run that has to be stopped (timeout, Stop) ends the
 * whole worker; the page starts a new one.
 *
 * It is a module worker and loads Pyodide's ES module build (pyodide.mjs):
 * Pyodide 314's pyodide.js does not load through importScripts.
 *
 * Messages in:  { type: 'init', indexURL } | { type: 'run', id, job }
 * Messages out: { type: 'note', text } | { type: 'started' } | { type: 'output', stream, text }
 *               | { type: 'exit', code, changes, removed } | { type: 'failed', message }
 */

const HELPER = String.raw`
import atexit, io, os, runpy, sys, traceback

# Matched against the traceback of an OSError or RuntimeError only, and kept
# specific: a hint attached to the wrong error is worse than none.
_HINTS = (
    (("socketserver.py", "http/server.py"),
     "Receiving HTTP needs a listening socket, which a browser tab cannot open. Download the project to serve requests from it."),
    (("can't start new thread", "can't create new thread"),
     "Threads are not available to Python in the browser (Pyodide). Download the project to run it with real threads."),
    (("subprocess.py",),
     "Starting processes is not possible from a browser tab. Download the project to run it locally."),
)

def _mc_hint(exc, text):
    if isinstance(exc, (OSError, RuntimeError)):
        for needles, hint in _HINTS:
            if any(needle in text for needle in needles):
                return hint
    return None

def _mc_report(exc):
    report = traceback.TracebackException.from_exception(exc)
    # Leave out the frames that belong to this wrapper and to runpy, so the
    # traceback starts where the program does - as it would under python itself.
    report.stack = traceback.StackSummary.from_list(
        [frame for frame in report.stack if not frame.filename.startswith("<") and not frame.filename.endswith("/runpy.py")]
    )
    text = "".join(report.format())
    sys.stderr.write(text)
    hint = _mc_hint(exc, text)
    if hint:
        sys.stderr.write("[browser] " + hint + "\n")

def _mc_exit_code(exc):
    if exc.code is None:
        return 0
    if isinstance(exc.code, int):
        return exc.code
    sys.stderr.write(str(exc.code) + "\n")
    return 1

def _mc_main(argv, cwd, env, stdin_text, root, banner):
    argv = list(argv)
    env = dict(env)
    saved = (list(sys.path), dict(os.environ), list(sys.argv), sys.stdin, os.getcwd(), sys.dont_write_bytecode)
    try:
        os.chdir(cwd)
        os.environ.update(env)
        # PYTHONPATH is only read at interpreter start-up, so apply it by hand.
        for entry in reversed([p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p]):
            sys.path.insert(0, os.path.abspath(entry))
        if env.get("PYTHONDONTWRITEBYTECODE"):
            sys.dont_write_bytecode = True
        sys.stdin = io.StringIO(stdin_text or "")

        while argv and argv[0].startswith("-") and argv[0] not in ("-m", "-c", "-"):
            flag = argv.pop(0)
            if flag in ("-V", "--version"):
                print(banner)
                return 0
            if flag in ("-O", "-OO"):
                sys.stderr.write("[browser] " + flag + " has no effect here: the optimisation level is fixed when the interpreter starts, so assertions still run.\n")
            elif flag in ("-X", "-W"):
                if argv:
                    argv.pop(0)
            elif flag in ("-u", "-B", "-E", "-s", "-I", "-q", "-b", "-d", "-v", "-P") or flag.startswith(("-X", "-W")):
                pass
            else:
                sys.stderr.write("unknown option " + flag + "\n")
                return 2

        if not argv:
            sys.stderr.write("[browser] There is no interactive interpreter here; give a script or -m module.\n")
            return 2
        try:
            if argv[0] == "-m":
                if len(argv) < 2:
                    sys.stderr.write("Argument expected for the -m option\n")
                    return 2
                sys.argv = [argv[1]] + argv[2:]
                sys.path.insert(0, os.getcwd())
                runpy.run_module(argv[1], run_name="__main__", alter_sys=True)
            elif argv[0] == "-c":
                sys.argv = ["-c"] + argv[2:]
                sys.path.insert(0, "")
                exec(compile(argv[1] if len(argv) > 1 else "", "<string>", "exec"), {"__name__": "__main__"})
            else:
                script = os.path.abspath(argv[0])
                sys.argv = [argv[0]] + argv[1:]
                sys.path.insert(0, os.path.dirname(script))
                runpy.run_path(script, run_name="__main__")
            return 0
        except SystemExit as exc:
            return _mc_exit_code(exc)
        except BaseException as exc:
            _mc_report(exc)
            return 1
    finally:
        # The interpreter outlives the run, so do what its exit would: run the
        # atexit handlers (the tracer saves its results in one), then forget them.
        atexit._run_exitfuncs()
        atexit._clear()
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except Exception:
                pass
        sys.path[:] = saved[0]
        os.environ.clear()
        os.environ.update(saved[1])
        sys.argv = saved[2]
        sys.stdin = saved[3]
        try:
            os.chdir(saved[4])
        except OSError:
            os.chdir("/")
        sys.dont_write_bytecode = saved[5]
        prefix = root.rstrip("/") + "/"
        for name, module in list(sys.modules.items()):
            if (getattr(module, "__file__", None) or "").startswith(prefix):
                del sys.modules[name]

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(line_buffering=True, write_through=True)
    except Exception:
        pass
`;

let pyodide = null;
let booting = null;
let indexURL = null;
let lastRoot = null;
const installed = new Set();
let httpPatched = false;
/** The run every message belongs to; the page ignores messages for any other. */
let runId = null;

const post = (message) => self.postMessage({ ...message, id: runId });
const note = (text) => post({ type: 'note', text });

function boot() {
  booting ??= (async () => {
    note('Loading Python (Pyodide) - the first run downloads it, later runs reuse it.');
    const { loadPyodide } = await import(`${indexURL}pyodide.mjs`);
    const py = await loadPyodide({ indexURL });
    for (const stream of ['stdout', 'stderr']) {
      const decoder = new TextDecoder();
      const handler = {
        write(bytes) {
          post({ type: 'output', stream, text: decoder.decode(bytes, { stream: true }) });
          return bytes.length;
        },
      };
      if (stream === 'stdout') py.setStdout(handler);
      else py.setStderr(handler);
    }
    py.runPython(HELPER);
    pyodide = py;
    return py;
  })();
  return booting;
}

// -- the worker's copy of the run directory ----------------------------------

function removeTree(FS, path) {
  let stat;
  try {
    stat = FS.stat(path);
  } catch {
    return;
  }
  if (FS.isDir(stat.mode)) {
    for (const name of FS.readdir(path)) if (name !== '.' && name !== '..') removeTree(FS, `${path}/${name}`);
    FS.rmdir(path);
  } else {
    FS.unlink(path);
  }
}

function writeTree(FS, files) {
  for (const [path, data] of files) {
    FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
    FS.writeFile(path, data);
  }
}

/** Every file below `dir`, leaving out bytecode caches, which are never part of a project. */
function listTree(FS, dir, out = []) {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = `${dir}/${name}`;
    if (FS.isDir(FS.stat(path).mode)) {
      if (name !== '__pycache__') listTree(FS, path, out);
    } else if (!name.endsWith('.pyc')) {
      out.push(path);
    }
  }
  return out;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function textOrBytes(bytes) {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return bytes;
  }
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** What the run created, changed or deleted, so the page can bring its disk up to date. */
function diffTree(FS, root, original) {
  const changes = [];
  const seen = new Set();
  for (const path of listTree(FS, root)) {
    seen.add(path);
    const before = original.get(path);
    if (typeof before === 'string') {
      const now = FS.readFile(path, { encoding: 'utf8' });
      if (now !== before) changes.push([path, now]);
    } else {
      const now = FS.readFile(path);
      if (!before || !sameBytes(now, before)) changes.push([path, textOrBytes(now)]);
    }
  }
  const removed = [...original.keys()].filter((path) => !seen.has(path) && !/(^|\/)__pycache__\/|\.pyc$/.test(path));
  return { changes, removed };
}

// -- packages ----------------------------------------------------------------

const absolute = (cwd, path) => (path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`);

/** Requirement lines from a requirements file, without comments, options or blank lines. */
function requirementsIn(files, path) {
  const text = files.get(path);
  if (typeof text !== 'string') return [];
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line && !line.startsWith('-'));
}

async function preparePackages(py, job, files) {
  const sources = [...files].filter(([path, data]) => path.endsWith('.py') && typeof data === 'string').map(([, data]) => data);
  const code = sources.join('\n');

  // Packages Pyodide ships pre-built (numpy, pandas, ...) are found from the imports.
  await py.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: (m) => note(m) });

  // MASTERCODE_INSTALL names packages a run needs beyond the manifest: reading a
  // library's functions sets it, so the library is there to be read.
  const extra = String(job.env?.MASTERCODE_INSTALL ?? '').split(/[\s,]+/).filter(Boolean);
  const wanted = [...new Set([...requirementsIn(files, absolute(job.cwd, 'requirements.txt')), ...extra])].filter((r) => !installed.has(r));
  if (wanted.length) {
    note(`Installing ${wanted.join(', ')} with micropip (pure-Python wheels and Pyodide's own builds only).`);
    await py.loadPackage('micropip');
    const micropip = py.pyimport('micropip');
    try {
      await micropip.install(py.toPy(wanted));
      for (const r of wanted) installed.add(r);
    } finally {
      micropip.destroy();
    }
  }

  // urllib and requests have no sockets here; pyodide-http routes them through fetch.
  if (!httpPatched && /\b(urllib\.request|urllib3|requests|http\.client)\b|from urllib import request/.test(code)) {
    await py.loadPackage('pyodide-http');
    py.runPython('import pyodide_http\npyodide_http.patch_all()');
    httpPatched = true;
  }
}

/** `python -m pip install ...`: the closest honest equivalent is micropip. */
async function pipInstall(py, args, files, cwd) {
  if (args[0] !== 'install') {
    post({ type: 'output', stream: 'stderr', text: `[browser] Only "pip install" is available here, through micropip.\n` });
    return 2;
  }
  const wanted = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '-r' && args[i + 1]) wanted.push(...requirementsIn(files, absolute(cwd, args[++i])));
    else if (!args[i].startsWith('-')) wanted.push(args[i]);
  }
  await py.loadPackage('micropip');
  const micropip = py.pyimport('micropip');
  try {
    await micropip.install(py.toPy(wanted));
    for (const r of wanted) installed.add(r);
    post({ type: 'output', stream: 'stdout', text: `Installed ${wanted.join(', ') || 'nothing'} with micropip.\n` });
    return 0;
  } catch (error) {
    post({ type: 'output', stream: 'stderr', text: `${error.message ?? error}\n` });
    return 1;
  } finally {
    micropip.destroy();
  }
}

// -- a run -------------------------------------------------------------------

async function run(job) {
  const py = await boot();
  const FS = py.FS;
  if (lastRoot) removeTree(FS, lastRoot);
  lastRoot = job.cwd;
  const files = new Map(job.files);
  writeTree(FS, files);
  FS.mkdirTree(job.cwd);

  const args = job.args;
  const pip = args[0] === '-m' && args[1] === 'pip';
  const quick = pip || args[0] === '-V' || args[0] === '--version' || (args[0] === '-m' && args[1] === 'compileall');
  if (!quick) {
    try {
      await preparePackages(py, job, files);
    } catch (error) {
      post({ type: 'started' });
      post({ type: 'output', stream: 'stderr', text: `[browser] Could not prepare the packages this program needs:\n${error.message ?? error}\n` });
      return { code: 1, ...diffTree(FS, job.cwd, files) };
    }
  }

  post({ type: 'started' });
  if (pip) return { code: await pipInstall(py, args.slice(2), files, job.cwd), ...diffTree(FS, job.cwd, files) };

  const main = py.globals.get('_mc_main');
  const argv = py.toPy(args);
  const env = py.toPy(job.env);
  try {
    const code = main(argv, job.cwd, env, job.stdin ?? '', job.cwd, job.banner);
    return { code, ...diffTree(FS, job.cwd, files) };
  } finally {
    argv.destroy();
    env.destroy();
    main.destroy();
  }
}

async function handle(data) {
  try {
    if (data.type === 'init') {
      indexURL = data.indexURL;
      await boot();
      post({ type: 'ready' });
    } else if (data.type === 'run') {
      runId = data.id;
      indexURL ??= data.job.indexURL;
      const result = await run(data.job);
      post({ type: 'exit', ...result });
    }
  } catch (error) {
    post({ type: 'failed', message: String(error?.message ?? error) });
  }
}

// One message at a time. Without this a second run could start at one of the
// first run's awaits and share its directory and interpreter state.
let chain = Promise.resolve();
self.onmessage = ({ data }) => {
  chain = chain.then(() => handle(data));
};
