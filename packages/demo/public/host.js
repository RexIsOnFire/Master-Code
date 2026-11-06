/**
 * The browser demo's command host.
 *
 * The IDE's commands, answered inside the page by the same `commands.ts` table
 * the local server runs, against the in-memory disk. Three things are the
 * demo's own:
 *
 *   - the workspace offers Python, JavaScript, HTML and CSS - the languages the
 *     browser can run or render - with every node and template they use;
 *   - every result is handed to the IDE as a JSON copy, exactly as it would
 *     arrive over HTTP, so the IDE can never hold the session's live objects;
 *   - a command does not return until its changes are in IndexedDB, which is the
 *     demo's version of the server's synchronous autosave.
 *
 * Which project is open is kept in sessionStorage, so a reload reopens it in the
 * same tab and a new tab starts at the welcome screen.
 */

import { createCommands, execute } from './lib/server/commands.js';
import { History } from './lib/server/history.js';
import { folderNameFor, suggestedRoot } from './lib/server/workspace-state.js';
import { createDefaultRegistry } from './lib/core/nodes/catalog/index.js';
import { BackendRegistry } from './lib/core/backends/backend.js';
import { cssBackend, htmlBackend, javascriptBackend, pythonBackend } from './lib/core/backends/index.js';
import { TemplateRegistry, builtinTemplates } from './lib/core/project/templates.js';
import { PluginHost } from './lib/core/plugin/api.js';
import { setProcessHost } from './lib/core/runtime/exec.js';
import { createProcessHost, PYODIDE_VERSION, PYTHON_VERSION } from './runner.js';
import { readZip, textOrBytes, writeZip } from './zip.js';
import { disk } from './vfs.js';
import { HOME } from './node/process.js';
import { basename, dirname, join, relative } from './node/path.js';

export const DEMO_BACKENDS = [pythonBackend, javascriptBackend, htmlBackend, cssBackend];

const OPEN_KEY = 'mastercode.demo.open';
const OPENING = new Set(['project.open', 'project.create', 'learn.start']);

const tabStorage = {
  get(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* a tab without storage just starts at the welcome screen after a reload */
    }
  },
};

export async function createHost() {
  disk.mkdir(join(HOME, 'MasterCode'), { recursive: true });
  disk.mkdir('/tmp', { recursive: true });

  const processes = await createProcessHost();
  setProcessHost(processes);

  const nodes = createDefaultRegistry();
  const backends = new BackendRegistry();
  for (const backend of DEMO_BACKENDS) backends.register(backend);
  const languages = new Set(DEMO_BACKENDS.map((b) => b.id));
  const templates = new TemplateRegistry(builtinTemplates.filter((t) => languages.has(t.language)));
  const plugins = new PluginHost({ nodes, backends, templates });
  const state = { workspace: { nodes, backends, templates, plugins }, history: new History() };

  const events = new EventTarget();
  const commands = createCommands({
    emit: (event, data) => events.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) })),
    previewUrl: (out, page) => `preview.html?${new URLSearchParams({ out, page })}`,
    runtime: `In this browser · Python ${PYTHON_VERSION} (Pyodide ${PYODIDE_VERSION}) · projects are stored here, not uploaded`,
  });

  let askedToPersist = false;

  async function call(command, args = {}) {
    const outcome = await execute(commands, state, command, args);
    try {
      await disk.flush();
    } catch (error) {
      return {
        ok: false,
        error: `The change was made, but the browser refused to store it (${error?.message ?? error}). Download the project to keep it.`,
      };
    }
    if (outcome.ok && OPENING.has(command) && state.root) {
      tabStorage.set(OPEN_KEY, state.root);
      if (state.project?.languages.includes('python')) processes.warm();
      // Ask once, when there is first something worth keeping, so the browser
      // does not evict the projects under storage pressure.
      if (!askedToPersist && command !== 'project.open') {
        askedToPersist = true;
        void navigator.storage?.persist?.().catch(() => {});
      }
    }
    return JSON.parse(JSON.stringify(outcome));
  }

  async function downloadProject() {
    if (!state.root) throw new Error('No project is open.');
    await disk.flush();
    const root = state.root;
    const folder = basename(root);
    const entries = disk
      .files(root)
      .filter(([path]) => !/\/__pycache__\/|\.pyc$/.test(path))
      .map(([path, data]) => ({ name: `${folder}/${relative(root, path)}`, data }));
    const bytes = await writeZip(entries);
    saveFile(new Blob([bytes], { type: 'application/zip' }), `${folder}.zip`);
    return { files: entries.length, bytes: bytes.byteLength };
  }

  /**
   * Unpacks a project zip into a new folder and opens it. Only the subtree that
   * holds the project's project.json is written; entry names were already
   * refused by `readZip` if they could escape it.
   */
  async function importZip() {
    const file = await pickFile('.zip,application/zip');
    if (!file) return null;
    const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
    const manifest = entries
      .map((e) => e.name)
      .filter((name) => name === 'project.json' || name.endsWith('/project.json'))
      .sort((a, b) => a.split('/').length - b.split('/').length)[0];
    if (!manifest) throw new Error(`${file.name} has no project.json, so it is not a Master Code project.`);

    const base = manifest.slice(0, -'project.json'.length);
    const name = base ? base.slice(0, -1).split('/').pop() : file.name.replace(/\.zip$/i, '');
    const target = freeFolder(join(suggestedRoot(), folderNameFor(name)));
    for (const entry of entries) {
      if (!entry.name.startsWith(base)) continue;
      const path = join(target, entry.name.slice(base.length));
      disk.mkdir(dirname(path), { recursive: true });
      disk.writeFile(path, textOrBytes(entry.data));
    }
    const opened = await call('project.open', { path: target });
    if (!opened.ok) throw new Error(opened.error);
    return opened.result;
  }

  // A reload reopens what this tab had open.
  const previous = tabStorage.get(OPEN_KEY);
  if (previous && disk.exists(join(previous, 'project.json'))) {
    const reopened = await execute(commands, state, 'project.open', { path: previous });
    if (reopened.ok && state.project?.languages.includes('python')) processes.warm();
  }

  return { call, events, downloadProject, importZip, persistent: disk.persistent };
}

/** `path`, or `path-2`, `path-3`... - an import never merges into an existing folder. */
function freeFolder(path) {
  if (!disk.exists(path)) return path;
  for (let n = 2; ; n++) if (!disk.exists(`${path}-${n}`)) return `${path}-${n}`;
}

function pickFile(accept) {
  return new Promise((settle) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => settle(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => settle(null), { once: true });
    input.click();
  });
}

function saveFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
