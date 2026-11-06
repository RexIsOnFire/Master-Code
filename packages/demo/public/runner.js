/**
 * The demo's process host: what `runCommand` does when there are no processes.
 *
 * `python` goes to Pyodide in a worker, `node` to a JavaScript worker with
 * Node-style modules; anything else is reported the way a missing executable is,
 * with a startError, so the build and the welcome screen say "generates" rather
 * than pretending a compiler exists.
 *
 * Both workers are created from `data:` URLs and so run with an opaque origin:
 * user code cannot reach the demo's IndexedDB, which holds every project. The
 * page sends a run the files below its working directory and applies what the
 * run changed when it ends.
 *
 * The result has the same shape as `runCommand`'s, with the same output cap and
 * truncation note, and the timeout is measured from when the program starts -
 * not from when Pyodide starts downloading, which on a first visit can take
 * longer than the program's whole budget.
 */

import { disk } from './vfs.js';
import { basename, dirname, resolve } from './node/path.js';
import { HOME } from './node/process.js';

export const PYODIDE_VERSION = '314.0.7';
export const PYTHON_VERSION = '3.14.2';
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const PYTHON_BANNER = `Python ${PYTHON_VERSION} (Pyodide ${PYODIDE_VERSION}, in the browser)`;
const NODE_BANNER = 'JavaScript in a browser worker, with Node-style fs, path, process and test modules';

const encoder = new TextEncoder();

function kindOf(command) {
  const name = basename(command).replace(/\.exe$/i, '');
  if (name === 'python' || name === 'python3') return 'python';
  if (name === 'node') return 'node';
  return null;
}

/** A data: URL worker has an opaque origin, unlike a blob: URL one, which inherits the page's. */
function isolatedWorker(source, options) {
  return new Worker(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`, options);
}

async function source(file) {
  const response = await fetch(new URL(file, import.meta.url));
  if (!response.ok) throw new Error(`Could not load ${file}: HTTP ${response.status}`);
  return response.text();
}

export async function createProcessHost() {
  // The workers have opaque origins and cannot fetch from the site themselves,
  // so everything they load from it is read here and sent along.
  const [pythonSource, nodeSource, ...runtime] = await Promise.all(
    ['./python-worker.js', './js-worker.js', './node/path.js', './node-runtime/inspect.js', './node-runtime/assert.js', './node-runtime/digest.js'].map(source),
  );
  const nodeRuntime = { path: runtime[0], inspect: runtime[1], assert: runtime[2], digest: runtime[3] };

  let python = null;
  /** The run directory the current interpreter has served; null until its first run. */
  let pythonRoot = null;
  let queue = Promise.resolve();

  /**
   * The interpreter for a run in `cwd`. Reused within one project, replaced when
   * the project changes: whatever one project's code left in the interpreter -
   * an import hook, a patched builtin - must not be there when another project's
   * files arrive.
   */
  const pythonWorker = (cwd) => {
    if (python && cwd && pythonRoot && pythonRoot !== cwd) {
      python.terminate();
      python = null;
    }
    if (!python) {
      python = isolatedWorker(pythonSource, { type: 'module' });
      python.postMessage({ type: 'init', indexURL: PYODIDE_INDEX_URL });
      pythonRoot = null;
    }
    if (cwd) pythonRoot = cwd;
    return python;
  };

  function execute(kind, options) {
    // Unguessable, so code in the worker cannot address a report to a run it did not see.
    const id = crypto.randomUUID();
    const started = Date.now();
    const maxBytes = options.maxOutputBytes ?? 2_000_000;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;

    const capture = (text, stream) => {
      bytes += encoder.encode(text).byteLength;
      if (bytes > maxBytes) {
        if (!truncated) {
          truncated = true;
          const note = `\n[output truncated at ${maxBytes} bytes]\n`;
          if (stream === 'stdout') stdout += note;
          else stderr += note;
        }
        return;
      }
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      options.onOutput?.(text, stream);
    };

    const job = {
      cwd: options.cwd,
      args: options.args,
      env: { HOME, PATH: '/usr/local/bin:/usr/bin', LANG: 'en_US.UTF-8', ...options.env },
      stdin: options.stdin,
      files: disk.files(options.cwd),
      banner: PYTHON_BANNER,
      indexURL: PYODIDE_INDEX_URL,
    };

    return new Promise((settle) => {
      const worker = kind === 'python' ? pythonWorker(options.cwd) : isolatedWorker(nodeSource, { type: 'module' });
      let timer = null;
      let finished = false;

      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        // A stopped run, or an interpreter that never started, takes its worker with it.
        if (kind === 'node' || result.signal || result.startError) worker.terminate();
        if (kind === 'python' && (result.signal || result.startError)) python = null;
        settle({ command: options.command, args: options.args, durationMs: Date.now() - started, stdout, stderr, truncated, ...result });
      };

      const stop = (signal, timedOut) => finish({ code: null, signal, timedOut });
      const onAbort = () => stop('SIGTERM', false);
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const onMessage = ({ data }) => {
        if (data?.id !== id) return; // a message from an earlier run, or not from the runner at all
        if (data.type === 'output') capture(data.text, data.stream);
        else if (data.type === 'note') options.onOutput?.(`[browser] ${data.text}\n`, 'stderr');
        else if (data.type === 'started') timer ??= setTimeout(() => stop('SIGKILL', true), options.timeoutMs ?? 60_000);
        else if (data.type === 'exit') {
          const refused = applyRunChanges(options.cwd, data.changes, data.removed);
          if (refused) {
            capture(`[browser] Ignored ${refused} file change(s) outside ${options.cwd}.\n`, 'stderr');
            // Only the program itself could have sent that; its interpreter is not reused.
            if (kind === 'python') {
              worker.terminate();
              python = null;
            }
          }
          finish({ code: Number.isInteger(data.code) ? data.code : 1, signal: null, timedOut: false });
        } else if (data.type === 'failed') {
          finish({ code: null, signal: null, timedOut: false, startError: data.message });
        }
      };
      const onError = (event) => {
        event.preventDefault?.();
        if (kind === 'python') python = null;
        finish({ code: null, signal: null, timedOut: false, startError: event.message || 'The worker stopped unexpectedly.' });
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage(kind === 'python' ? { type: 'run', id, job } : { type: 'run', id, job, sources: nodeRuntime });
    });
  }

  return {
    which(command) {
      const kind = kindOf(command);
      return kind ? `/usr/bin/${kind === 'python' ? 'python' : 'node'}` : undefined;
    },

    async run(options) {
      const kind = kindOf(options.command);
      if (!kind) {
        return {
          command: options.command,
          args: options.args,
          code: null,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 0,
          timedOut: false,
          truncated: false,
          startError: `"${options.command}" is not available in the browser demo. Download the project to build it with your own toolchain.`,
        };
      }
      // Answered here so the welcome screen's toolchain check does not download Pyodide.
      if (options.args.length === 1 && ['--version', '-V'].includes(options.args[0])) {
        const text = `${kind === 'python' ? PYTHON_BANNER : NODE_BANNER}\n`;
        options.onOutput?.(text, 'stdout');
        return { command: options.command, args: options.args, code: 0, signal: null, stdout: text, stderr: '', durationMs: 0, timedOut: false, truncated: false };
      }
      // Python runs one at a time on the shared interpreter.
      if (kind === 'python') {
        const result = queue.then(() => execute(kind, options));
        queue = result.catch(() => {});
        return result;
      }
      return execute(kind, options);
    },

    /** Starts Pyodide loading in the background, so the first Run does not wait for it. */
    warm() {
      pythonWorker();
    },
  };
}

/**
 * Brings the disk up to date with what a run did, inside its working directory
 * only. The worker runs the user's code, and that code can post messages too, so
 * its report is untrusted input: a change addressed anywhere else - another
 * project, the recent list - is dropped, not written. Returns how many were.
 */
export function applyRunChanges(cwd, changes, removed) {
  const root = resolve(cwd);
  const inside = (path) => typeof path === 'string' && resolve(path).startsWith(`${root}/`);
  let refused = 0;
  for (const change of Array.isArray(changes) ? changes : []) {
    const [path, data] = Array.isArray(change) ? change : [];
    if (!inside(path) || !(typeof data === 'string' || data instanceof Uint8Array)) {
      refused += 1;
      continue;
    }
    disk.mkdir(dirname(resolve(path)), { recursive: true });
    disk.writeFile(resolve(path), data);
  }
  for (const path of Array.isArray(removed) ? removed : []) {
    if (inside(path)) disk.rm(resolve(path), { force: true });
    else refused += 1;
  }
  return refused;
}
