/**
 * The IDE shell.
 *
 * Holds no derived state: the server owns the project, and every mutation is a
 * command whose response carries the new truth. That costs a round trip on a
 * localhost socket and buys the guarantee that what you see is what is saved.
 */

import { NodeEditor, portColor, isExec, typeText } from './editor.js';
import { ArchitectureView } from './architecture.js';
import { Welcome } from './welcome.js';
import { UiBuilder } from './ui-builder.js';

const $ = (id) => document.getElementById(id);

const state = {
  registries: null,
  project: null,
  fileGraph: null,
  activeFileId: null,
  activeGraphId: null,
  selection: [],
  diagnostics: [],
  /** {canUndo, canRedo, undoLabel, redoLabel} — server-owned, arrives with every state. */
  history: null,
  /** Every function, class and variable in the project. Server-derived. */
  symbols: [],
  duplicateSymbols: [],
  symbolFilter: '',
  symbolKinds: new Set(),
  /** 'file' shows the open file's outline; 'project' shows everything. */
  symbolScope: 'file',
  generated: new Map(),
  /** path -> Map(line -> nodeId), from the last generation. */
  lineOrigins: new Map(),
  /** The challenge this project came from, and how many hints are revealed. */
  challenge: null,
  hintsShown: 0,
  tests: [],
  lastRun: null,
  /** Result of the last traced run, shown on the graph until cleared. */
  lastTrace: null,
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Set by the browser demo, which answers the same commands inside the page
 * instead of over HTTP. Everything below is otherwise identical in both.
 */
const host = globalThis.masterCodeHost;

async function call(command, args = {}) {
  const body = host
    ? await host.call(command, args)
    : await (
        await fetch('/api/command', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command, args }),
        })
      ).json();
  if (!body.ok) throw new Error(body.error ?? 'command failed');
  return body.result;
}

function connectEvents() {
  // The demo host delivers the same named events, with the same JSON payloads.
  const source = host ? host.events : new EventSource('/api/events');
  source.addEventListener('output', (e) => {
    const { stream, chunk } = JSON.parse(e.data);
    appendOutput(chunk, stream === 'stderr');
  });
  source.addEventListener('status', (e) => {
    const { phase, state: phaseState, ok } = JSON.parse(e.data);
    setStatus(
      phaseState === 'started'
        ? `${phase}…`
        : phaseState === 'blocked'
          ? `${phase} blocked`
          : `${phase} ${ok ? 'ok' : 'failed'}`,
    );
  });
  source.addEventListener('step', (e) => {
    const step = JSON.parse(e.data);
    appendOutput(`▸ ${step.label} (${step.durationMs} ms)\n`);
  });
  if (!host) source.onerror = () => setStatus('disconnected — is the server still running?');
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const editor = new NodeEditor($('canvas'), $('minimap'), {
  onSelect(ids) {
    state.selection = ids;
    renderProperties();
    renderNodeCode();
  },
  async onMove(moves) {
    if (!state.activeGraphId) return;
    await call('graph.moveNodes', { graphId: state.activeGraphId, moves });
  },
  async onConnect(from, to) {
    const result = await call('graph.connect', { graphId: state.activeGraphId, from, to });
    applyDiagnostics(result.diagnostics);
    await refreshGraph();
  },
  async onDisconnect(edgeIds) {
    const result = await call('graph.disconnect', { graphId: state.activeGraphId, edgeIds });
    applyDiagnostics(result.diagnostics);
    await refreshGraph();
  },
  async onDropNode(type, x, y) {
    await addNode(type, x, y);
  },
  onDropWire(fromPort, x, y) {
    openCommandPalette(fromPort ? `` : ``, { x, y, from: fromPort });
  },
  onOpenNode(node) {
    state.selection = [node.id];
    renderProperties();
    switchPanel('right', 'properties');
  },
  onViewport(view) {
    if (state.activeGraphId) void call('graph.viewport', { graphId: state.activeGraphId, viewport: view });
  },
  onMessage: (text) => toast(text, 'error'),
  onContextMenu({ node }) {
    if (node) {
      state.selection = [node.id];
      renderProperties();
    }
  },
});

/**
 * The file graph, drawn. Selecting a box selects the file; double-clicking
 * opens it, which is the fastest route from "who imports this" to editing it.
 */
const archView = new ArchitectureView($('archCanvas'), {
  onSelectFile(fileId) {
    renderArchDetail(fileId);
  },
  onOpenFile(fileId) {
    switchView('graph');
    void openFile(fileId);
  },
});

/**
 * The welcome screen. It owns the no-project state, so nothing else has to know
 * how a project comes into existence — it hands one over and the IDE loads it
 * exactly as if the server had opened it at startup.
 */
const welcome = new Welcome({
  call,
  toast: (text, kind) => toast(text, kind),
  importZip: host ? () => host.importZip() : undefined,
  async onProjectReady(result) {
    applyProjectState(result);
    const entry =
      state.project.files.find((f) => f.role === 'entry' && f.graphId) ??
      state.project.files.find((f) => f.graphId);
    if (entry) await openFile(entry.id);
    if (result.challenge) {
      state.challenge = result.challenge;
      state.hintsShown = 0;
      state.challengeResult = null;
      renderChallenge();
      switchPanel('dock', 'challenge');
    }
    setStatus('ready');
  },
});

/**
 * The UI builder. The document is server-owned like everything else, so an edit
 * is a command, is saved, and is undoable — and the preview comes from the same
 * generated HTML the backend will write, not a separate render path.
 */
const uiBuilder = new UiBuilder({
  document: () => state.project?.files.find((f) => f.id === state.activeFileId)?.options?.ui ?? null,
  preview: () => {
    const file = state.project?.files.find((f) => f.id === state.activeFileId);
    return file ? (state.generated.get(file.path) ?? '') : '';
  },
  // Only handlers that exist can be bound, so a wiring mistake is impossible
  // rather than discovered at generation.
  handlers: () => state.symbols.filter((sym) => sym.kind === 'event').map((sym) => sym.name),
  toast: (text, kind) => toast(text, kind),
  async save(doc) {
    if (!state.activeFileId) return;
    await call('file.setUi', { fileId: state.activeFileId, ui: doc });
    const fresh = await call('project.state');
    applyProjectState(fresh);
    // Regenerate so the preview shows what the backend actually emits.
    await generate({ quiet: true });
    renderUiDesigner();
  },
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  buildMenus();
  bindChrome();
  connectEvents();

  const hello = await call('hello');
  state.registries = hello.registries;
  editor.setDefinitions(hello.registries.nodes);
  renderPalette('');
  renderLibraryLanguages();
  $('paletteSearch').placeholder = `Search ${hello.registries.nodes.length} nodes…`;

  if (hello.open) {
    await loadProject();
  } else {
    // No project in the working directory. That is the normal case when the app
    // is launched from a shortcut rather than a terminal, so it opens the
    // welcome screen rather than an empty editor the user cannot fill.
    showEmptyProject();
    await welcome.open({ closable: false });
  }
  setStatus('ready');
}

async function loadProject() {
  const result = await call('project.state');
  applyProjectState(result);
  // A project started from a challenge carries it in its template id.
  const { challenge } = await call('learn.current');
  state.challenge = challenge;
  state.hintsShown = 0;
  renderChallenge();
  if (challenge) switchPanel('dock', 'challenge');
  const entry = state.project.files.find((f) => f.role === 'entry' && f.graphId) ?? state.project.files.find((f) => f.graphId);
  if (entry) await openFile(entry.id);
  await validate();
}

function applyProjectState(result) {
  state.project = result.project;
  state.fileGraph = result.fileGraph;
  if (result.history) state.history = result.history;
  state.symbols = result.symbols ?? [];
  if (result.challenge !== undefined) {
    state.challenge = result.challenge;
    state.hintsShown = 0;
    state.challengeResult = null;
  }
  state.duplicateSymbols = new Set(result.duplicateSymbols ?? []);
  $('projectName').textContent = `${state.project.name} · ${state.project.languages.join(', ')}`;
  document.title = `${state.project.name} — Master Code`;
  renderExplorer();
  renderSymbols();
  renderArchitecture();
  archView.setData(state.project, state.fileGraph);
  renderSettings();
  renderSourcePicker();
}

function showEmptyProject() {
  $('explorer').innerHTML =
    '<div class="empty">No project open.<br><br>Use <b>File → New project</b> to create one.</div>';
  $('canvasHelp').textContent = 'No project open.';
}

// ---------------------------------------------------------------------------
// Files and graphs
// ---------------------------------------------------------------------------

async function openFile(fileId) {
  const file = state.project.files.find((f) => f.id === fileId);
  if (!file) return;
  state.activeFileId = fileId;
  state.activeGraphId = file.graphId ?? null;

  const graph = state.project.graphs.find((g) => g.id === file.graphId);
  editor.setGraph(graph ?? { id: '', name: '', nodes: [], edges: [], variables: [] });
  if (graph && !graph.viewport) editor.fit();

  $('viewHint').textContent = graph
    ? `${graph.name} · ${graph.style} · ${graph.nodes.length} nodes`
    : `${file.path} · ${file.kind}`;
  $('canvasHelp').textContent = graph
    ? 'drag from the palette · drag a port to wire · double-click empty space to add a node\nscroll to zoom · alt-drag or middle-drag to pan'
    : `${file.path} has no logic graph.`;

  renderExplorer();
  renderSymbols();
  renderStylePicker();
  renderPalette($('paletteSearch').value);
  renderVariables();
  renderProperties();
  renderUiDesigner();
  await showSource(fileId);
  renderLogicView();
}

async function refreshGraph() {
  const result = await call('project.state');
  applyProjectState(result);
  const graph = state.project.graphs.find((g) => g.id === state.activeGraphId);
  if (graph) editor.setGraph(graph);
  renderLogicView();
  renderVariables();
}

async function addNode(type, x, y) {
  if (!state.activeGraphId) {
    toast('Open a file with a logic graph first.', 'error');
    return null;
  }
  const result = await call('graph.addNode', { graphId: state.activeGraphId, type, x, y });
  applyDiagnostics(result.diagnostics);
  await refreshGraph();
  state.selection = [result.node.id];
  editor.selection = new Set(state.selection);
  renderProperties();
  editor.draw();
  return result.node;
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

function renderExplorer() {
  const host = $('explorer');
  host.innerHTML = '';
  const groups = new Map();
  for (const file of [...state.project.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const key = file.role === 'test' ? 'tests' : file.role === 'config' ? 'configuration' : 'source';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  for (const [group, files] of groups) {
    const title = document.createElement('div');
    title.className = 'tree-group';
    title.textContent = group;
    host.append(title);
    for (const file of files) {
      const row = document.createElement('div');
      row.className = `tree-item${file.id === state.activeFileId ? ' active' : ''}`;
      row.innerHTML = `
        <span class="kind ${file.kind}">${file.kind.slice(0, 3)}</span>
        <span class="path">${escapeHtml(file.path)}</span>
        <span class="lang">${file.language}</span>`;
      row.onclick = () => void openFile(file.id);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        void fileMenu(file);
      };
      host.append(row);
    }
  }
}

async function fileMenu(file) {
  const action = window.prompt(
    `${file.path}\n\nType an action: rename, delete, entry, cancel`,
    'rename',
  );
  if (!action || action === 'cancel') return;
  if (action === 'rename') {
    const next = window.prompt('New path', file.path);
    if (!next || next === file.path) return;
    const result = await call('file.rename', { fileId: file.id, path: next });
    applyProjectState(result.state);
    applyDiagnostics(result.diagnostics);
    toast(`Renamed. ${result.changes.length} change(s); generated importers update on the next Generate.`, 'ok');
  } else if (action === 'delete') {
    if (!window.confirm(`Delete ${file.path}?`)) return;
    const result = await call('file.delete', { fileId: file.id });
    applyProjectState(result.state);
    applyDiagnostics(result.diagnostics);
    if (state.activeFileId === file.id) state.activeFileId = null;
  }
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function renderPalette(query) {
  const host = $('palette');
  host.innerHTML = '';
  const language = currentLanguage();
  const q = query.trim().toLowerCase();

  const matches = state.registries.nodes.filter((d) => {
    if (d.languages.length && language && !d.languages.includes(language)) return false;
    if (!q) return true;
    return `${d.type} ${d.title} ${d.category} ${d.keywords.join(' ')} ${d.description}`.toLowerCase().includes(q);
  });

  const addItem = (def) => {
    const item = document.createElement('div');
    item.className = 'palette-item';
    item.draggable = true;
    item.title = `${def.type}\n\n${def.description}`;
    item.innerHTML = `
      <span class="dot" style="background:${def.color ?? 'var(--accent)'}"></span>
      <span>${escapeHtml(def.title)}</span>
      <span class="desc">${escapeHtml(def.description)}</span>`;
    item.ondragstart = (e) => e.dataTransfer.setData('text/mcode-node', def.type);
    item.ondblclick = () => void addNode(def.type, 40, 40);
    host.append(item);
  };

  // Nodes that name the current paradigm go first, under their own heading.
  //
  // Surfaced rather than filtered: most nodes declare no style because they
  // genuinely belong to every paradigm — a List Append is not "procedural
  // only" — so hiding the untagged ones would remove almost the whole
  // catalogue. Ranking says "this is what the style is for" without pretending
  // the rest are unavailable.
  const style = currentGraphStyle();
  const suited = style ? matches.filter((d) => d.styles?.includes(style)) : [];
  if (suited.length && !q) {
    const head = document.createElement('div');
    head.className = 'palette-group suited';
    head.textContent = `For ${style} (${suited.length})`;
    host.append(head);
    for (const def of suited) addItem(def);
  }

  const rest = suited.length && !q ? matches.filter((d) => !suited.includes(d)) : matches;
  const byCategory = new Map();
  for (const def of rest) {
    if (!byCategory.has(def.category)) byCategory.set(def.category, []);
    byCategory.get(def.category).push(def);
  }

  for (const [category, defs] of [...byCategory].sort((a, b) => a[0].localeCompare(b[0]))) {
    const head = document.createElement('div');
    head.className = 'palette-group';
    head.textContent = `${category} (${defs.length})`;
    host.append(head);
    for (const def of defs) addItem(def);
  }
  if (!matches.length) host.innerHTML = '<div class="empty">No nodes match.</div>';
}

/** Paradigms, in the order the picker offers them. Mirrors GRAPH_STYLES. */
const STYLES = [
  'procedural',
  'object-oriented',
  'functional',
  'event-driven',
  'dataflow',
  'state-machine',
  'pipeline',
  'component',
  'service',
];

/** The paradigm of the open graph, or null when nothing is open. */
function currentGraphStyle() {
  return state.project?.graphs.find((g) => g.id === state.activeGraphId)?.style ?? null;
}

/**
 * Fills the paradigm picker and keeps it in step with the open graph.
 *
 * Changing it is an ordinary edit — saved, and undoable — but it changes no
 * generated code. It declares what the file is meant to be, and the palette
 * answers by putting that paradigm's nodes first.
 */
function renderStylePicker() {
  const select = $('graphStyle');
  if (!select) return;
  const graph = state.project?.graphs.find((g) => g.id === state.activeGraphId);
  select.disabled = !graph;
  if (!select.children.length) {
    for (const style of STYLES) {
      const option = document.createElement('option');
      option.value = style;
      option.textContent = style;
      select.append(option);
    }
    select.onchange = async () => {
      if (!state.activeGraphId) return;
      const result = await call('graph.setStyle', { graphId: state.activeGraphId, style: select.value });
      applyProjectState(result);
      renderPalette($('paletteSearch').value);
      toast(`This graph is now ${select.value}. Ctrl+Z undoes it.`, 'ok');
    };
  }
  select.value = graph?.style ?? 'procedural';
}

function currentLanguage() {
  return state.project?.files.find((f) => f.id === state.activeFileId)?.language ?? state.project?.language;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function renderProperties() {
  const host = $('properties');
  host.innerHTML = '';
  const graph = state.project?.graphs.find((g) => g.id === state.activeGraphId);
  if (!graph || state.selection.length !== 1) {
    host.innerHTML = `<div class="empty">${
      state.selection.length > 1 ? `${state.selection.length} nodes selected.` : 'Select a node to edit its properties.'
    }</div>`;
    return;
  }

  const node = graph.nodes.find((n) => n.id === state.selection[0]);
  const def = state.registries.nodes.find((d) => d.type === node?.type);
  if (!node || !def) return;

  host.insertAdjacentHTML(
    'beforeend',
    `<div class="prop-title">${escapeHtml(def.title)}</div>
     <div class="prop-sub">${escapeHtml(def.type)} · ${escapeHtml(def.category)}</div>
     <div class="prop-sub">${escapeHtml(def.description)}</div>`,
  );

  for (const spec of def.props ?? []) {
    if (spec.visibleWhen && !spec.visibleWhen.equals.includes(node.props[spec.visibleWhen.prop])) continue;
    host.append(propertyField(node, spec, graph));
  }

  // Port defaults for unconnected inputs: editable inline, like the editor does.
  const unconnected = node.inputs.filter(
    (p) => !isExec(p.type) && !graph.edges.some((e) => e.to.node === node.id && e.to.port === p.id),
  );
  if (unconnected.length) {
    host.insertAdjacentHTML('beforeend', '<div class="prop-section">Unconnected inputs</div>');
    for (const port of unconnected) {
      const wrap = document.createElement('div');
      wrap.className = 'prop';
      wrap.innerHTML = `<label>${escapeHtml(port.name || port.id)} <span style="color:${portColor(port.type)}">${escapeHtml(typeText(port.type))}</span></label>`;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = port.defaultValue ?? '';
      input.onchange = async () => {
        let value = input.value;
        if (/^-?\d+$/.test(value)) value = Number(value);
        else if (value === 'true' || value === 'false') value = value === 'true';
        await call('graph.setPortDefault', { graphId: graph.id, nodeId: node.id, portId: port.id, value });
        await refreshGraph();
      };
      wrap.append(input);
      host.append(wrap);
    }
  }

  const variadic = def.inputs.filter((p) => p.variadic);
  for (const spec of variadic) {
    const button = document.createElement('button');
    button.className = 'btn tiny';
    button.textContent = `Add another "${spec.name || spec.id}"`;
    button.onclick = async () => {
      await call('graph.addVariadic', { graphId: graph.id, nodeId: node.id, portId: spec.id });
      await refreshGraph();
      renderProperties();
    };
    host.append(button);
  }

  host.insertAdjacentHTML('beforeend', '<div class="prop-section">Node</div>');
  const actions = document.createElement('div');
  actions.className = 'port-row';
  actions.innerHTML = `
    <button class="btn tiny" data-act="toggle">${node.enabled === false ? 'Enable' : 'Disable'}</button>
    <button class="btn tiny" data-act="break">${node.breakpoint ? 'Clear breakpoint' : 'Breakpoint'}</button>
    <button class="btn tiny" data-act="delete">Delete</button>`;
  actions.querySelector('[data-act=toggle]').onclick = async () => {
    await call('graph.setProps', { graphId: graph.id, nodeId: node.id, props: {} });
    node.enabled = node.enabled === false ? true : false;
    editor.draw();
    renderProperties();
  };
  actions.querySelector('[data-act=break]').onclick = () => {
    node.breakpoint = !node.breakpoint;
    editor.draw();
    renderProperties();
  };
  actions.querySelector('[data-act=delete]').onclick = async () => {
    await call('graph.deleteNodes', { graphId: graph.id, nodeIds: [node.id] });
    state.selection = [];
    await refreshGraph();
    renderProperties();
  };
  host.append(actions);

  if (def.doc) {
    host.insertAdjacentHTML('beforeend', `<div class="prop-section">Reference</div><div class="doc">${escapeHtml(def.doc)}</div>`);
  }
}

function propertyField(node, spec, graph) {
  const wrap = document.createElement('div');
  wrap.className = 'prop';
  const label = document.createElement('label');
  label.textContent = spec.label;
  wrap.append(label);

  const commit = async (value) => {
    const result = await call('graph.setProps', { graphId: graph.id, nodeId: node.id, props: { [spec.name]: value } });
    applyDiagnostics(result.diagnostics);
    await refreshGraph();
    renderProperties();
  };

  let control;
  switch (spec.kind) {
    case 'boolean':
      control = document.createElement('input');
      control.type = 'checkbox';
      control.checked = !!node.props[spec.name];
      control.onchange = () => void commit(control.checked);
      break;
    case 'select':
      control = document.createElement('select');
      for (const option of spec.options ?? []) {
        const el = document.createElement('option');
        el.value = option.value;
        el.textContent = option.label;
        control.append(el);
      }
      control.value = String(node.props[spec.name] ?? '');
      control.onchange = () => void commit(control.value);
      break;
    case 'variable':
      control = document.createElement('select');
      control.innerHTML = '<option value="">(choose)</option>';
      for (const v of graph.variables) {
        const el = document.createElement('option');
        el.value = v.name;
        el.textContent = `${v.name}: ${v.type}`;
        control.append(el);
      }
      control.value = String(node.props[spec.name] ?? '');
      control.onchange = () => void commit(control.value);
      break;
    case 'symbol': {
      // A list of what actually exists, grouped by file and showing signatures.
      // The previous free-text box let you name anything, including a function
      // that had never existed, and the mistake only surfaced at the compiler.
      const current = String(node.props[spec.name] ?? '');
      control = document.createElement('div');
      control.className = 'sym-picker';

      const select = document.createElement('select');
      select.innerHTML = '<option value="">(choose a function)</option>';

      const callable = state.symbols.filter((sym) => sym.kind === 'function' || sym.kind === 'method');
      let group = null;
      let optgroup = null;
      for (const sym of callable) {
        if (sym.filePath !== group) {
          group = sym.filePath;
          optgroup = document.createElement('optgroup');
          // Say where it is, and whether calling it will cross a file boundary.
          optgroup.label = sym.fileId === state.activeFileId ? `${sym.filePath} (this file)` : sym.filePath;
          select.append(optgroup);
        }
        const option = document.createElement('option');
        option.value = sym.name;
        option.textContent = `${sym.signature}${sym.emitted ? '' : '  · ungenerated'}`;
        optgroup.append(option);
      }

      // Keep a value that no longer resolves rather than silently dropping it:
      // the node still refers to it, and validation will say so.
      if (current && !callable.some((sym) => sym.name === current)) {
        const orphan = document.createElement('option');
        orphan.value = current;
        orphan.textContent = `${current}  · not found`;
        select.append(orphan);
      }
      select.value = current;
      select.onchange = () => void commit(select.value);

      const goto = document.createElement('button');
      goto.className = 'goto';
      goto.textContent = '→';
      goto.title = 'Open the function this calls';
      goto.onclick = () => {
        const target = state.symbols.find((sym) => sym.name === select.value);
        if (target) void revealSymbol(target);
        else toast(`"${select.value}" is not declared anywhere in this project.`, 'warn');
      };

      control.append(select, goto);
      break;
    }
    case 'text':
    case 'code':
    case 'json':
    case 'ports':
      control = document.createElement('textarea');
      control.value =
        spec.kind === 'text' || spec.kind === 'code'
          ? String(node.props[spec.name] ?? '')
          : JSON.stringify(node.props[spec.name] ?? (spec.kind === 'ports' ? [] : null), null, 2);
      control.onchange = () => {
        if (spec.kind === 'text' || spec.kind === 'code') return void commit(control.value);
        try {
          void commit(JSON.parse(control.value));
        } catch (err) {
          toast(`Not valid JSON: ${err.message}`, 'error');
        }
      };
      break;
    case 'integer':
    case 'number':
      control = document.createElement('input');
      control.type = 'number';
      control.value = String(node.props[spec.name] ?? 0);
      if (spec.min !== undefined) control.min = String(spec.min);
      if (spec.max !== undefined) control.max = String(spec.max);
      control.onchange = () => void commit(Number(control.value));
      break;
    default:
      control = document.createElement('input');
      control.type = 'text';
      control.value = String(node.props[spec.name] ?? '');
      control.onchange = () => void commit(control.value);
  }

  wrap.append(control);
  if (spec.doc) wrap.insertAdjacentHTML('beforeend', `<div class="doc">${escapeHtml(spec.doc)}</div>`);
  return wrap;
}


// ---------------------------------------------------------------------------
// Variables, settings, architecture
// ---------------------------------------------------------------------------

function renderVariables() {
  const host = $('variables');
  const graph = state.project?.graphs.find((g) => g.id === state.activeGraphId);
  host.innerHTML = '';
  if (!graph) {
    host.innerHTML = '<div class="empty">Open a graph to manage its variables.</div>';
    return;
  }
  for (const variable of graph.variables) {
    const row = document.createElement('div');
    row.className = 'port-row';
    row.innerHTML = `<span style="flex:1">${escapeHtml(variable.name)} <span class="hint">${escapeHtml(String(variable.type))} · ${variable.scope}</span></span>`;
    const remove = document.createElement('button');
    remove.className = 'btn tiny ghost';
    remove.textContent = '✕';
    remove.onclick = async () => {
      await call('graph.removeVariable', { graphId: graph.id, variableId: variable.id });
      await refreshGraph();
    };
    row.append(remove);
    host.append(row);
  }
  const add = document.createElement('button');
  add.className = 'btn tiny';
  add.textContent = 'Add variable';
  add.onclick = async () => {
    const name = window.prompt('Variable name', 'counter');
    if (!name) return;
    const type = window.prompt('Type (e.g. i64, string, List<string>)', 'i64') ?? 'Any';
    await call('graph.addVariable', { graphId: graph.id, name, type, scope: 'module' });
    await refreshGraph();
    renderVariables();
  };
  host.append(add);

  // Variables belonging to other graphs. Only module-scoped ones are listed:
  // a local in another graph is not reachable from here, and showing it would
  // invite a reference that cannot be generated.
  const elsewhere = state.symbols.filter(
    (sym) =>
      (sym.kind === 'variable' || sym.kind === 'constant') &&
      sym.scope === 'module' &&
      sym.graphId !== graph.id,
  );
  if (elsewhere.length) {
    host.insertAdjacentHTML('beforeend', '<div class="prop-section">Elsewhere in the project</div>');
    for (const sym of elsewhere) {
      const row = document.createElement('div');
      row.className = 'sym';
      row.innerHTML = `<span class="sig">${escapeHtml(sym.signature)}</span>`;
      row.title = `Declared in ${sym.filePath}. Click to open.`;
      row.onclick = () => void revealSymbol(sym);
      host.append(row);
    }
  }
}

function renderSettings() {
  const host = $('settings');
  const p = state.project;
  host.innerHTML = `
    <div class="prop-title">${escapeHtml(p.name)}</div>
    <div class="prop-sub">${escapeHtml(p.description ?? '')}</div>
    <div class="prop-section">Capabilities</div>`;
  for (const [cap, granted] of Object.entries(p.grants)) {
    const row = document.createElement('label');
    row.className = 'check';
    row.style.padding = '2px 0';
    row.innerHTML = `<input type="checkbox" ${granted ? 'checked' : ''}/> ${cap}`;
    row.querySelector('input').onchange = async (e) => {
      const result = await call('project.settings', { settings: { grants: { [cap]: e.target.checked } } });
      applyProjectState(result);
    };
    host.append(row);
  }
  host.insertAdjacentHTML(
    'beforeend',
    `<div class="prop-section">Sandbox</div>
     <div class="doc">timeout ${p.sandbox.timeoutMs} ms · heap ${p.sandbox.memoryLimitMb} MB · output cap ${Math.round(p.sandbox.maxOutputBytes / 1000)} kB<br>
     A capability the graph needs but the project has not granted blocks the run before anything is compiled.</div>
     <div class="prop-section">Dependencies</div>`,
  );
  if (!p.dependencies.length) host.insertAdjacentHTML('beforeend', '<div class="doc">None recorded.</div>');
  for (const dep of p.dependencies) {
    host.insertAdjacentHTML(
      'beforeend',
      `<div class="doc">${escapeHtml(dep.name)} ${escapeHtml(dep.version)} <span class="hint">${dep.language} · ${dep.installed ? 'installed' : 'not installed'}</span></div>`,
    );
  }
}

/**
 * The hint line above the architecture canvas. It answers the two questions the
 * diagram makes people ask: how big is this graph, and what does the file I
 * just clicked depend on.
 */
function renderArchDetail(fileId) {
  const p = state.project;
  const cycles = state.fileGraph?.cycles ?? [];
  const file = p?.files.find((f) => f.id === fileId);

  const parts = [];
  if (file) {
    const summary = state.fileGraph?.summary?.find((s) => s.fileId === file.id);
    parts.push(file.path);
    if (summary) parts.push(`imports ${summary.imports} · imported by ${summary.importedBy}`);
    parts.push(file.kind);
  } else {
    const shown = p?.files.filter((f) => f.kind !== 'external').length ?? 0;
    parts.push(`${shown} files · ${(state.fileGraph?.edges ?? []).length} imports`);
    parts.push(p?.modules.length ? `${p.modules.length} modules` : 'monolithic');
  }
  if (cycles.length) parts.push(`${cycles.length} circular dependency${cycles.length > 1 ? ' groups' : ''}`);

  const hint = $('archHint');
  hint.textContent = parts.join('  ·  ');
  hint.classList.toggle('bad', cycles.length > 0);
}

/**
 * Every function, class and variable in the project, grouped by file.
 *
 * Reads from the graphs, not from the last generation, so something drawn a
 * moment ago is listed immediately — marked "ungenerated" until it has actually
 * been emitted, because those are different facts and the user needs both.
 */
/**
 * The code a node produced.
 *
 * This is the answer to "what does this block actually become", and it is not
 * guessed: the backends record which node emitted each line while emitting, so
 * the mapping is exact rather than inferred from the text afterwards.
 *
 * Where a backend does not report line origins, it says so instead of showing
 * a plausible-looking approximation.
 */
/**
 * The challenge panel: brief, steps, hints, and a Check button.
 *
 * Hints are revealed one at a time rather than listed. A wall of hints is a
 * solution, and someone stuck on step two should not have step five spoiled.
 */
function renderChallenge() {
  const host = $('challenge');
  const tab = $('tabChallenge');
  if (!host || !tab) return;
  const c = state.challenge;
  tab.hidden = !c;
  if (!c) {
    host.innerHTML = '';
    return;
  }

  const md = (text) =>
    escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`(.+?)`/g, '<code>$1</code>');

  host.innerHTML = `
    <h3>${escapeHtml(c.title)} <span class="difficulty ${escapeHtml(c.difficulty)}">${escapeHtml(c.difficulty)}</span></h3>
    <div class="brief">${md(c.brief)}</div>
    <ol>${c.steps.map((s) => `<li>${md(s)}</li>`).join('')}</ol>`;

  for (let i = 0; i < state.hintsShown && i < c.hints.length; i++) {
    host.insertAdjacentHTML('beforeend', `<span class="hint">${md(c.hints[i])}</span>`);
  }

  const actions = document.createElement('div');
  actions.className = 'challenge-actions';

  const check = document.createElement('button');
  check.className = 'btn';
  check.textContent = 'Check my answer';
  check.onclick = () => void checkChallenge(check);
  actions.append(check);

  if (state.hintsShown < c.hints.length) {
    const hint = document.createElement('button');
    hint.className = 'btn tiny ghost';
    hint.textContent = state.hintsShown ? 'Another hint' : 'Give me a hint';
    hint.onclick = () => {
      state.hintsShown += 1;
      renderChallenge();
    };
    actions.append(hint);
  }
  host.append(actions);

  if (c.args?.length) {
    host.insertAdjacentHTML(
      'beforeend',
      `<div class="doc">Checked by running with: <code>${escapeHtml(c.args.join(' '))}</code></div>`,
    );
  }
  if (state.challengeResult) host.append(state.challengeResult);
}

/** Builds, runs and checks the project against the challenge. */
async function checkChallenge(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const result = await call('learn.check', {});
    const box = document.createElement('div');
    box.className = `verdict ${result.ok ? 'pass' : 'fail'}`;

    if (result.ok) {
      box.innerHTML = `<b>Passed.</b> ${escapeHtml(result.afterword ?? '')}`;
    } else {
      box.innerHTML = `<b>Not yet.</b> ${escapeHtml(result.reason ?? '')}`;
      if (result.checks) {
        const list = result.checks
          .map((c) => `<div class="${c.found ? 'ok' : 'no'}">${escapeHtml(c.expected)}</div>`)
          .join('');
        box.insertAdjacentHTML('beforeend', `<div class="checks">${list}</div>`);
      }
      if (result.diagnostics) applyDiagnostics(result.diagnostics);
    }
    state.challengeResult = box;
    renderChallenge();
    toast(result.ok ? 'Challenge passed.' : 'Not passing yet — see the Challenge panel.', result.ok ? 'ok' : 'warn');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function renderNodeCode() {
  const host = $('nodeCode');
  const what = $('nodeCodeWhat');
  if (!host) return;
  host.innerHTML = '';

  const selected = new Set(state.selection);
  if (!selected.size) {
    what.textContent = 'Select a node to see the code it produces.';
    return;
  }
  if (!state.generated.size) {
    what.textContent = 'Generate first — there is no code yet.';
    return;
  }

  const context = $('nodeCodeContext').checked;
  const titles = state.selection
    .map((id) => {
      const node = state.project?.graphs.flatMap((g) => g.nodes).find((n) => n.id === id);
      return node ? (state.registries.nodes.find((d) => d.type === node.type)?.title ?? node.type) : id;
    })
    .join(', ');

  let shown = 0;
  for (const [path, lines] of state.lineOrigins) {
    const own = [...lines].filter(([, nodeId]) => selected.has(nodeId)).map(([line]) => line);
    if (!own.length) continue;

    const source = (state.generated.get(path) ?? '').split('\n');
    const wanted = new Set(own);
    if (context) {
      // Two lines either side, so a statement is readable in place.
      for (const line of own) for (let d = -2; d <= 2; d++) wanted.add(line + d);
    }
    const ordered = [...wanted].filter((n) => n >= 1 && n <= source.length).sort((a, b) => a - b);
    if (!ordered.length) continue;

    host.insertAdjacentHTML('beforeend', `<div class="file">${escapeHtml(path)}</div>`);
    let previous = null;
    for (const line of ordered) {
      // A gap in the run of lines is worth showing, or two distant statements
      // read as if they were adjacent.
      if (previous !== null && line > previous + 1) {
        host.insertAdjacentHTML('beforeend', '<div class="ln"><span class="num">⋯</span><span></span></div>');
      }
      const isOwn = own.includes(line);
      host.insertAdjacentHTML(
        'beforeend',
        `<div class="ln${isOwn ? ' own' : ''}"><span class="num">${line}</span><span>${escapeHtml(source[line - 1] ?? '')}</span></div>`,
      );
      previous = line;
    }
    shown += own.length;
  }

  if (!shown) {
    what.textContent = `${titles}: no generated lines are attributed to this node.`;
    host.innerHTML =
      '<div class="empty">Either it produced nothing on its own — a pure node is inlined into whatever uses it — or this language does not report line origins yet.</div>';
    return;
  }
  what.textContent = `${titles} — ${shown} line${shown === 1 ? '' : 's'}`;
}

function renderSymbols() {
  const host = $('symbols');
  if (!host) return;
  renderSymbolFilters();

  const query = state.symbolFilter.toLowerCase().trim();
  const kinds = state.symbolKinds;
  // File scope is an outline of what is open; project scope is everything. A
  // search always spans the project, because searching within one file when you
  // meant to find something elsewhere just looks broken.
  const fileScope = state.symbolScope === 'file' && !query;
  const matches = state.symbols.filter((sym) => {
    if (fileScope && sym.fileId !== state.activeFileId) return false;
    if (kinds.size && !kinds.has(sym.kind)) return false;
    if (!query) return true;
    return (
      sym.name.toLowerCase().includes(query) ||
      sym.signature.toLowerCase().includes(query) ||
      sym.filePath.toLowerCase().includes(query)
    );
  });

  host.innerHTML = '';
  if (!matches.length) {
    host.innerHTML = `<div class="empty">${
      !state.symbols.length
        ? 'Nothing declared yet. Add a Function or a Class node.'
        : fileScope
          ? 'This file declares nothing yet.'
          : 'Nothing matches.'
    }</div>`;
    return;
  }

  let group = null;
  for (const sym of matches) {
    // In file scope every row is the same file, so the heading is just noise.
    if (!fileScope && sym.filePath !== group) {
      group = sym.filePath;
      const head = document.createElement('div');
      head.className = 'group';
      head.textContent = sym.moduleName ? `${sym.filePath}  ·  ${sym.moduleName}` : sym.filePath;
      host.append(head);
    }
    const row = document.createElement('div');
    const dupe = state.duplicateSymbols?.has?.(sym.owner ? `${sym.owner}.${sym.name}` : sym.name);
    row.className = `sym${sym.emitted ? '' : ' pending'}${dupe ? ' dupe' : ''}`;
    row.title = [
      sym.doc,
      dupe ? 'Declared in more than one file — a reference to it is ambiguous.' : '',
      sym.emitted ? '' : 'Declared in the graph; not generated yet.',
    ]
      .filter(Boolean)
      .join('\n');
    row.innerHTML = `<span class="kind">${escapeHtml(sym.kind)}</span><span class="sig">${escapeHtml(sym.signature)}</span>`;
    row.onclick = () => void revealSymbol(sym);
    host.append(row);
  }
}

function renderSymbolFilters() {
  const host = $('symbolFilters');
  if (!host || host.children.length) return;
  for (const kind of ['function', 'method', 'class', 'variable', 'constant', 'test']) {
    const button = document.createElement('button');
    button.textContent = kind;
    button.onclick = () => {
      if (state.symbolKinds.has(kind)) state.symbolKinds.delete(kind);
      else state.symbolKinds.add(kind);
      button.classList.toggle('on', state.symbolKinds.has(kind));
      renderSymbols();
    };
    host.append(button);
  }
}

/** Opens the file a symbol lives in and focuses the node that declares it. */
async function revealSymbol(sym) {
  if (!sym.fileId) return;
  if (sym.fileId !== state.activeFileId) await openFile(sym.fileId);
  switchView('graph');
  if (sym.nodeId) {
    state.selection = [sym.nodeId];
    editor.focusNode(sym.nodeId);
    renderProperties();
    switchPanel('right', 'properties');
  }
}

function renderArchitecture() {
  const host = $('architecture');
  const p = state.project;
  host.innerHTML = '';
  if (!p.modules.length) {
    host.innerHTML = `<div class="empty">This project is monolithic.<br><br>Create a module to group files behind a public interface.</div>`;
  }
  for (const module of p.modules) {
    const el = document.createElement('div');
    el.className = 'arch-module';
    const deps = module.dependencies
      .map((id) => p.modules.find((m) => m.id === id)?.name)
      .filter(Boolean);
    el.innerHTML = `
      <h4>${escapeHtml(module.name)}</h4>
      <div class="meta">${escapeHtml(module.directory)} · ${p.files.filter((f) => f.moduleId === module.id).length} files</div>
      <div class="iface">exports: ${module.interface.map((i) => escapeHtml(i.name)).join(', ') || '(none)'}</div>
      ${deps.length ? `<div class="iface">depends on: ${deps.map(escapeHtml).join(', ')}</div>` : ''}`;
    host.append(el);
  }

  const edges = state.fileGraph?.edges ?? [];
  if (edges.length) {
    host.insertAdjacentHTML('beforeend', '<div class="prop-section">File imports</div>');
    for (const edge of edges.slice(0, 80)) {
      const from = p.files.find((f) => f.id === edge.from)?.path ?? edge.from;
      const to = p.files.find((f) => f.id === edge.to)?.path ?? edge.to;
      host.insertAdjacentHTML('beforeend', `<div class="arch-edge">${escapeHtml(from)} → ${escapeHtml(to)}</div>`);
    }
  }
  for (const cycle of state.fileGraph?.cycles ?? []) {
    const names = cycle.map((id) => p.files.find((f) => f.id === id)?.path ?? id);
    host.insertAdjacentHTML('beforeend', `<div class="arch-edge" style="color:var(--error)">cycle: ${escapeHtml(names.join(' → '))}</div>`);
  }
}

// ---------------------------------------------------------------------------
// Source, logic and UI views
// ---------------------------------------------------------------------------

function renderSourcePicker() {
  const select = $('sourceFile');
  const previous = select.value;
  select.innerHTML = '';
  for (const [path] of [...state.generated].sort((a, b) => a[0].localeCompare(b[0]))) {
    const option = document.createElement('option');
    option.value = path;
    option.textContent = path;
    select.append(option);
  }
  if (previous && state.generated.has(previous)) select.value = previous;
  select.onchange = () => {
    $('sourceView').textContent = state.generated.get(select.value) ?? '';
  };
}

async function showSource(fileId) {
  if (!state.generated.size) await generate({ write: false, quiet: true });
  const file = state.project.files.find((f) => f.id === fileId);
  const match = [...state.generated.keys()].find((p) => p === file?.path || p.endsWith(`/${file?.path}`));
  if (match) {
    $('sourceFile').value = match;
    $('sourceView').textContent = state.generated.get(match) ?? '';
    $('sourceHint').textContent = `${state.generated.get(match)?.split('\n').length ?? 0} lines · regenerated from the graph`;
  }
}

/**
 * The logic view: the same graph as structured pseudocode.
 *
 * Derived from the graph rather than the generated source, so it reads the same
 * whichever language the file targets.
 */
function renderLogicView() {
  const graph = state.project?.graphs.find((g) => g.id === state.activeGraphId);
  const out = $('logicView');
  if (!graph) {
    out.textContent = 'No graph selected.';
    return;
  }
  const defs = new Map(state.registries.nodes.map((d) => [d.type, d]));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines = [];

  const execTarget = (nodeId, portId) => {
    const edge = graph.edges.find((e) => e.from.node === nodeId && e.from.port === portId);
    return edge ? byId.get(edge.to.node) : null;
  };
  const dataSource = (nodeId, portId) => {
    const edge = graph.edges.find((e) => e.to.node === nodeId && e.to.port === portId);
    if (!edge) return null;
    const node = byId.get(edge.from.node);
    return node ? `${defs.get(node.type)?.title ?? node.type}.${edge.from.port}` : null;
  };

  const walk = (node, depth, seen) => {
    let current = node;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const def = defs.get(current.type);
      const label = current.title || def?.title || current.type;
      const args = current.inputs
        .filter((p) => !isExec(p.type))
        .map((p) => `${p.name || p.id}=${dataSource(current.id, p.id) ?? JSON.stringify(p.defaultValue ?? null)}`)
        .join(', ');
      lines.push(`${'  '.repeat(depth)}${label}${args ? `(${args})` : ''}`);

      const branches = current.outputs.filter((p) => isExec(p.type) && p.id !== 'out');
      for (const branch of branches) {
        const target = execTarget(current.id, branch.id);
        if (!target) continue;
        lines.push(`${'  '.repeat(depth)}  ${branch.name || branch.id}:`);
        walk(target, depth + 2, seen);
      }
      current = execTarget(current.id, 'out');
    }
  };

  for (const node of graph.nodes.filter((n) => defs.get(n.type)?.root).sort((a, b) => a.y - b.y)) {
    const def = defs.get(node.type);
    lines.push(`${def?.title ?? node.type} ${node.props.name ?? node.props.event ?? ''}`.trim());
    const body = execTarget(node.id, 'out');
    if (body) walk(body, 1, new Set([node.id]));
    lines.push('');
  }
  out.textContent = lines.join('\n') || 'This graph has no entry point yet.';
}

function renderUiDesigner() {
  uiBuilder.render();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function validate() {
  const result = await call('validate.all');
  applyDiagnostics(result.diagnostics);
}

async function generate({ write = true, quiet = false } = {}) {
  setStatus('generating…');
  const result = await call('code.generate', { write });
  state.generated = new Map(result.files.map((f) => [f.path, f.content]));
  state.lineOrigins = new Map(
    (result.lineOrigins ?? []).map((entry) => [entry.path, new Map(entry.lines)]),
  );
  applyDiagnostics(result.diagnostics);
  renderSourcePicker();
  renderUiDesigner();
  renderNodeCode();
  if (state.activeFileId) await showSource(state.activeFileId);
  setStatus(`generated ${result.files.length} file(s)`);
  if (!quiet) toast(`Generated ${result.files.length} files into ${result.out}`, 'ok');
  return result;
}

/** Demo only: the project folder as a zip, generated first so the source in it is current. */
async function downloadProjectZip() {
  try {
    const result = await generate({ quiet: true });
    const failed = result.diagnostics.some((d) => d.severity === 'error');
    const { files } = await host.downloadProject();
    toast(
      failed
        ? `Downloaded ${files} files. The project has errors, so its source is from the last generation that succeeded.`
        : `Downloaded ${files} files.`,
      failed ? 'error' : 'ok',
    );
  } catch (err) {
    toast(String(err.message ?? err), 'error');
  }
}

/** Demo only: unpacks a downloaded project into the browser and opens it. */
async function openProjectZip() {
  try {
    const result = await host.importZip();
    if (!result) return;
    welcome.close();
    await welcome.onProjectReady(result);
    toast(`Opened ${result.project.name}.`, 'ok');
  } catch (err) {
    toast(String(err.message ?? err), 'error');
  }
}

async function runProject() {
  switchPanel('dock', 'output');
  clearOutput();
  const result = await call('code.run', {});
  applyDiagnostics(result.diagnostics ?? []);
  state.lastRun = result;
  renderRuntimeView();
  if (result.blocked) {
    switchPanel('dock', 'problems');
    const caps = result.missing.map((m) => m.capability);
    if (window.confirm(`This program needs: ${caps.join(', ')}.\n\nGrant and run?`)) {
      const grants = Object.fromEntries(caps.map((c) => [c, true]));
      const updated = await call('project.settings', { settings: { grants } });
      applyProjectState(updated);
      return runProject();
    }
    return;
  }
  if (result.openInBrowser) {
    window.open(result.openInBrowser, '_blank');
    return;
  }
  appendOutput(`\n[exit ${result.exitCode} · ${result.limits}]\n`);
  for (const note of result.unenforced ?? []) appendOutput(`[not enforced: ${note}]\n`);
}

/**
 * Runs the program and paints the result onto the graph.
 *
 * The overlay is the point: nodes that ran keep their colour and carry a run
 * count, nodes that never ran are dimmed. Seeing a whole branch greyed out is
 * how you notice the condition was wrong.
 */
async function traceProject() {
  if (state.lastTrace) {
    state.lastTrace = null;
    editor.setTrace(new Map());
    renderRuntimeView();
    toast('Trace cleared.', 'ok');
    return;
  }

  switchPanel('dock', 'output');
  clearOutput();
  const result = await call('code.trace', {});

  if (result.blocked) {
    applyDiagnostics(result.diagnostics ?? []);
    switchPanel('dock', 'problems');
    toast('Refused: the program needs a capability it has not been granted.', 'warn');
    return;
  }
  if (result.unsupported) {
    toast(result.unsupported, 'warn');
    return;
  }
  if (!result.nodes) {
    applyDiagnostics(result.diagnostics ?? []);
    toast('The build failed; nothing to trace.', 'error');
    return;
  }

  state.lastTrace = result;
  editor.setTrace(result.nodes.map((n) => [n.nodeId, { count: n.count, order: n.order }]));
  renderRuntimeView();
  switchView('graph');
  const ran = result.nodes.length;
  const cold = result.unreached?.length ?? 0;
  toast(`${ran} node${ran === 1 ? '' : 's'} ran, ${cold} never did.`, 'ok');
}

async function runTestsAction() {
  switchPanel('dock', 'tests');
  clearOutput();
  const result = await call('code.test', {});
  state.tests = result.results ?? [];
  applyDiagnostics(result.diagnostics ?? []);
  renderTests(result.note);
}

function renderTests(note) {
  const host = $('tests');
  host.innerHTML = '';
  if (note) host.innerHTML = `<div class="empty">${escapeHtml(note)}</div>`;
  for (const test of state.tests) {
    const row = document.createElement('div');
    row.className = `test-row ${test.status}`;
    row.innerHTML = `<span class="status">${test.status}</span><span>${escapeHtml(test.name)}</span>
      <span class="hint">${escapeHtml(test.message ?? '')}</span>`;
    if (test.nodeId) row.onclick = () => editor.focusNode(test.nodeId);
    host.append(row);
  }
}

function renderRuntimeView() {
  const host = $('runtimeView');
  const run = state.lastRun;
  if (!run) {
    host.innerHTML = '<div class="empty">Run the project to see what happened here.</div>';
    return;
  }
  host.innerHTML = `
    <div class="row"><span class="key">outcome</span><span>${run.ok ? 'completed' : 'failed'}</span></div>
    <div class="row"><span class="key">exit code</span><span>${run.exitCode ?? '-'}</span></div>
    <div class="row"><span class="key">duration</span><span>${run.durationMs ?? '-'} ms</span></div>
    <div class="row"><span class="key">limits applied</span><span>${escapeHtml(run.limits ?? '-')}</span></div>
    <div class="prop-section">Not enforced by the sandbox</div>
    ${(run.unenforced ?? []).map((n) => `<div class="doc">${escapeHtml(n)}</div>`).join('') || '<div class="doc">nothing outstanding</div>'}
    ${
      state.lastTrace
        ? `<div class="prop-section">Execution</div>
    <div class="row"><span class="key">nodes that ran</span><span>${state.lastTrace.nodes.length}</span></div>
    <div class="row"><span class="key">never ran</span><span>${state.lastTrace.unreached?.length ?? 0}</span></div>
    <div class="doc">Shown on the graph: dimmed nodes never executed. Build → Clear trace to remove.</div>`
        : '<div class="prop-section">Execution</div><div class="doc">Build → Run with trace to see which nodes ran.</div>'
    }
    <div class="prop-section">Nodes with problems</div>
    ${
      state.diagnostics.filter((d) => d.origin?.nodeId).length
        ? state.diagnostics
            .filter((d) => d.origin?.nodeId)
            .map((d) => `<div class="doc">${escapeHtml(d.code)} → node ${escapeHtml(d.origin.nodeId)}</div>`)
            .join('')
        : '<div class="doc">none</div>'
    }`;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function applyDiagnostics(list) {
  state.diagnostics = list ?? [];
  const errors = state.diagnostics.filter((d) => d.severity === 'error').length;
  const badge = $('problemCount');
  badge.textContent = String(state.diagnostics.length);
  badge.classList.toggle('error', errors > 0);

  const host = $('problems');
  host.innerHTML = '';
  if (!state.diagnostics.length) {
    host.innerHTML = '<div class="empty">No problems.</div>';
  }
  for (const d of state.diagnostics) {
    const row = document.createElement('div');
    row.className = `problem ${d.severity}`;
    const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : d.origin?.nodeId ? 'graph' : '';
    row.innerHTML = `<span class="sev">${d.severity}</span>
      <span class="msg">${escapeHtml(d.message)}${d.hint ? `<span class="fix">${escapeHtml(d.hint)}</span>` : ''}</span>
      <span class="where">${escapeHtml(where)}</span>`;
    if (d.origin?.nodeId) row.onclick = () => editor.focusNode(d.origin.nodeId);
    host.append(row);
  }
  editor.setHighlights(state.diagnostics.filter((d) => d.severity === 'error' && d.origin?.nodeId).map((d) => d.origin.nodeId));
  renderRuntimeView();
}

// ---------------------------------------------------------------------------
// Libraries
// ---------------------------------------------------------------------------

function renderLibraryLanguages() {
  const select = $('libLanguage');
  select.innerHTML = '';
  for (const backend of state.registries.backends) {
    const option = document.createElement('option');
    option.value = backend.id;
    option.textContent = backend.name;
    select.append(option);
  }
  select.value = state.project?.language ?? 'python';
  select.onchange = () => void searchLibraries();
  $('libSearch').oninput = debounce(() => void searchLibraries(), 250);
  $('libOnline').onchange = () => void searchLibraries();
}

async function searchLibraries() {
  const language = $('libLanguage').value;
  const query = $('libSearch').value.trim();
  const online = $('libOnline').checked;
  const host = $('libraries');
  host.innerHTML = '<div class="lib-note">searching…</div>';

  const result = query
    ? await call('libs.search', { language, query, online })
    : { local: (await call('libs.list', { language })).entries, remote: [], source: 'offline' };

  host.innerHTML = '';
  const section = (title, entries) => {
    if (!entries?.length) return;
    host.insertAdjacentHTML('beforeend', `<div class="lib-group">${title}</div>`);
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'lib-row';
      row.innerHTML = `<span class="name">${escapeHtml(entry.name)}</span>
        <span class="version">${escapeHtml(entry.version)}</span>
        <span class="summary" title="${escapeHtml(entry.summary)}">${escapeHtml(entry.summary)}</span>`;
      const add = document.createElement('button');
      add.className = 'btn tiny';
      add.textContent = 'Add';
      add.title = 'Records it in the manifest. Nothing is downloaded.';
      add.onclick = async () => {
        const res = await call('libs.add', { language, name: entry.name, version: entry.version });
        applyProjectState(res.state);
        toast(`${entry.name} added to the manifest. Nothing downloaded — install it with your package manager.`, 'ok');
      };
      row.append(add);
      host.append(row);
    }
  };
  section('Curated catalogue', result.local);
  section('Registry', result.remote);
  if (result.note) host.insertAdjacentHTML('beforeend', `<div class="lib-note">${escapeHtml(result.note)}</div>`);
  if (!result.local?.length && !result.remote?.length) {
    host.insertAdjacentHTML('beforeend', '<div class="lib-note">Nothing matched. Tick "search the registry" to look beyond the offline catalogue.</div>');
  }
}

// ---------------------------------------------------------------------------
// Chrome: menus, tabs, shortcuts, command palette
// ---------------------------------------------------------------------------

const MENUS = [
  {
    title: 'File',
    items: [
      { label: 'New project…', action: () => welcome.openNew() },
      { label: 'Open project…', action: () => welcome.open({ closable: !!state.project }) },
      { label: 'New file…', action: newFile, enabled: () => !!state.project },
      { label: 'New module…', action: newModule },
      { label: () => (state.project?.architecture === 'modular' ? 'Flatten into one layout…' : 'Group into modules…'), action: convertArchitecture },
      { label: 'Save project', shortcut: 'Ctrl+S', action: () => call('project.save').then(() => toast('Saved.', 'ok')) },
      // The browser demo keeps projects in the browser; these move them in and out of it.
      ...(host
        ? [
            { label: 'Download project (.zip)', action: downloadProjectZip, enabled: () => !!state.project },
            { label: 'Open project from .zip…', action: openProjectZip },
          ]
        : []),
    ],
  },
  {
    title: 'Edit',
    items: [
      { label: () => (state.history?.undoLabel ? `Undo ${state.history.undoLabel}` : 'Undo'), shortcut: 'Ctrl+Z', action: undoEdit, enabled: () => !!state.history?.canUndo },
      { label: () => (state.history?.redoLabel ? `Redo ${state.history.redoLabel}` : 'Redo'), shortcut: 'Ctrl+Shift+Z', action: redoEdit, enabled: () => !!state.history?.canRedo },
    ],
  },
  {
    title: 'Build',
    items: [
      { label: 'Generate source', shortcut: 'Ctrl+G', action: () => generate() },
      { label: 'Build', shortcut: 'Ctrl+B', action: buildProject },
      { label: 'Run', shortcut: 'F5', action: runProject },
      { label: () => (state.lastTrace ? 'Clear trace' : 'Run with trace'), action: traceProject },
      { label: 'Run tests', shortcut: 'Ctrl+T', action: runTestsAction },
      { label: 'Validate', action: validate },
    ],
  },
  {
    title: 'View',
    items: [
      { label: 'Fit graph', shortcut: 'Ctrl+0', action: () => editor.fit() },
      { label: 'Toggle theme', action: toggleTheme },
      { label: 'Toggle bottom panel', action: () => $('dock').classList.toggle('collapsed') },
    ],
  },
  {
    title: 'Help',
    items: [
      { label: 'Command palette', shortcut: 'Ctrl+K', action: () => openCommandPalette('') },
      { label: 'Toolchain report', action: showDoctor },
    ],
  },
];

function buildMenus() {
  const host = $('menus');
  for (const menu of MENUS) {
    const el = document.createElement('div');
    el.className = 'menu';
    const button = document.createElement('button');
    button.textContent = menu.title;
    const items = document.createElement('div');
    items.className = 'menu-items';
    const refresh = [];
    for (const item of menu.items) {
      const entry = document.createElement('button');
      // A label may be a function so entries like "Undo delete nodes" can name
      // what they will actually do. Re-read when the menu opens: cheap, and it
      // cannot go stale the way a push-on-every-change would.
      const paint = () => {
        const label = typeof item.label === 'function' ? item.label() : item.label;
        entry.innerHTML = `<span>${escapeHtml(label)}</span>${item.shortcut ? `<kbd>${item.shortcut}</kbd>` : ''}`;
        entry.disabled = item.enabled ? !item.enabled() : false;
      };
      paint();
      refresh.push(paint);
      entry.onclick = () => {
        if (entry.disabled) return;
        el.classList.remove('open');
        void item.action();
      };
      items.append(entry);
    }
    button.onclick = (e) => {
      e.stopPropagation();
      const open = el.classList.contains('open');
      document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open'));
      if (!open) for (const paint of refresh) paint();
      el.classList.toggle('open', !open);
    };
    el.append(button, items);
    host.append(el);
  }
  document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open')));
}

function bindChrome() {
  for (const tabs of document.querySelectorAll('.pane-tabs')) {
    tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.pane-tab');
      if (!tab) return;
      const group = tabs.dataset.group;
      if (group === 'view') switchView(tab.dataset.view);
      else switchPanel(group, tab.dataset.panel);
    });
  }

  $('btnGenerate').onclick = () => void generate();
  $('btnRun').onclick = () => void runProject();
  $('btnTest').onclick = () => void runTestsAction();
  $('btnTheme').onclick = toggleTheme;
  $('btnNewFile').onclick = newFile;
  $('btnNewModule').onclick = newModule;
  $('btnClearOutput').onclick = clearOutput;
  $('btnToggleDock').onclick = () => $('dock').classList.toggle('collapsed');
  $('paletteSearch').oninput = (e) => renderPalette(e.target.value);
  $('nodeCodeContext').onchange = () => renderNodeCode();
  $('symbolSearch').oninput = (e) => {
    state.symbolFilter = e.target.value;
    renderSymbols();
  };
  for (const button of document.querySelectorAll('#symbolScope button')) {
    button.onclick = () => {
      state.symbolScope = button.dataset.scope;
      for (const other of document.querySelectorAll('#symbolScope button')) {
        other.classList.toggle('on', other === button);
      }
      renderSymbols();
    };
  }

  window.addEventListener('resize', () => {
    editor.resize();
    archView.resize();
  });
  new ResizeObserver(() => editor.resize()).observe($('canvas').parentElement);
  new ResizeObserver(() => archView.resize()).observe($('archCanvas').parentElement);

  for (const [id, key] of [['archModules', 'groupByModule'], ['archExternal', 'showExternal']]) {
    $(id).addEventListener('change', (e) => {
      archView.setOptions({ [key]: e.target.checked });
      archView.fit();
    });
  }

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette('');
      return;
    }
    if (e.key === 'Escape') closeCommandPalette();
    // Undo is handled before the `typing` guard: property fields commit
    // straight to the project, so Ctrl+Z inside one still means "undo my edit".
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      void (e.shiftKey ? redoEdit() : undoEdit());
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      void redoEdit();
      return;
    }
    if (typing) return;
    if (e.key === 'F5') {
      e.preventDefault();
      void runProject();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      void generate();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      void buildProject();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
      e.preventDefault();
      void runTestsAction();
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      editor.fit();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.length) {
      e.preventDefault();
      void call('graph.deleteNodes', { graphId: state.activeGraphId, nodeIds: state.selection }).then(async () => {
        state.selection = [];
        await refreshGraph();
        renderProperties();
      });
    }
  });
}

function switchPanel(group, panel) {
  const tabs = document.querySelector(`.pane-tabs[data-group="${group}"]`);
  if (!tabs) return;
  tabs.querySelectorAll('.pane-tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === panel));
  const body = tabs.parentElement.querySelector('.pane-body');
  body.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${panel}`));
  if (panel === 'libraries' && !$('libraries').children.length) void searchLibraries();
  if (group === 'dock') $('dock').classList.remove('collapsed');
}

function switchView(view) {
  document.querySelectorAll('.pane-tabs[data-group="view"] .pane-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.workspace .view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'graph') editor.resize();
  if (view === 'logic') renderLogicView();
  if (view === 'arch') {
    archView.resize();
    archView.select(state.activeFileId);
    archView.fit();
    renderArchDetail(state.activeFileId);
  }
  if (view === 'ui') renderUiDesigner();
  if (view === 'runtime') renderRuntimeView();
  if (view === 'source' && state.activeFileId) void showSource(state.activeFileId);
}

/**
 * Undo and redo.
 *
 * The server owns the stacks, so this is one round trip that returns a whole
 * project — the same shape every other mutation returns. That means the graph,
 * the file tree, the architecture view and the property panel all refresh
 * through the ordinary path; nothing here has to know what the undone edit was.
 */
async function undoEdit() {
  await applyHistoryStep('edit.undo', 'Nothing left to undo.');
}

async function redoEdit() {
  await applyHistoryStep('edit.redo', 'Nothing to redo.');
}

/**
 * Guards against overlapping history calls. Holding Ctrl+Z fires faster than a
 * round trip, and two in flight at once resolve in whatever order they finish —
 * which shows the user a "nothing left to undo" for a step that did happen.
 */
let historyBusy = false;

async function applyHistoryStep(command, emptyMessage) {
  if (!state.project || historyBusy) return;
  historyBusy = true;
  try {
    await runHistoryStep(command, emptyMessage);
  } finally {
    historyBusy = false;
  }
}

async function runHistoryStep(command, emptyMessage) {
  const label = command === 'edit.undo' ? state.history?.undoLabel : state.history?.redoLabel;
  const result = await call(command, {});
  if (!result.applied) {
    toast(emptyMessage, 'warn');
    if (result.history) state.history = result.history;
    return;
  }
  applyProjectState(result);

  // The open file may have been deleted by the edit being undone, or created by
  // the one being redone. Fall back to the entry point rather than showing a
  // graph that is no longer in the project.
  const stillOpen = state.project.files.some((f) => f.id === state.activeFileId);
  const target = stillOpen
    ? state.activeFileId
    : (state.project.files.find((f) => f.role === 'entry' && f.graphId) ?? state.project.files[0])?.id;
  state.selection = [];
  if (target) await openFile(target);
  await validate();

  // Refresh the generated view without writing. Undoing restores the project,
  // but the Source view and the UI preview are rendered from the last
  // generation, which would otherwise keep showing the change that was just
  // undone. Not written to disk: an undo should not silently rewrite output.
  await generate({ write: false, quiet: true });
  renderUiDesigner();

  toast(`${command === 'edit.undo' ? 'Undid' : 'Redid'} ${label ?? 'the last edit'}.`, 'ok');
}

async function buildProject() {
  switchPanel('dock', 'output');
  clearOutput();
  const result = await call('code.build', {});
  applyDiagnostics(result.diagnostics);
  appendOutput(`\n[${result.ok ? 'build succeeded' : 'build failed'} in ${result.durationMs} ms]\n`);
}

async function newFile() {
  const path = window.prompt('New file path', 'src/module.py');
  if (!path) return;
  const language = guessLanguage(path);
  const result = await call('file.create', { path, language });
  applyProjectState(result.state);
  await openFile(result.file.id);
  toast(`Created ${path}.`, 'ok');
}

/**
 * Converts the project between layouts, after showing exactly what will move.
 *
 * Runs a dry run first: this moves every source file, and a confirmation that
 * lists the actual moves is worth the extra round trip. The conversion itself
 * is an ordinary mutation, so Ctrl+Z undoes it.
 */
async function convertArchitecture() {
  if (!state.project) return;
  const target = state.project.architecture === 'modular' ? 'monolithic' : 'modular';

  let groups;
  if (target === 'modular') {
    // Nothing can guess a module boundary from file names, so ask. The default
    // offered is the folder each file already sits in, which is right often
    // enough to be a starting point rather than a blank box.
    const suggestion = state.project.files
      .filter((f) => f.role === 'source')
      .map((f) => `${f.path.split('/').slice(-2, -1)[0] ?? 'core'}=${f.path}`)
      .join('\n');
    const spec = window.prompt('Group files into modules.\n\nOne "module=path" per line:', suggestion);
    if (!spec) return;
    groups = {};
    for (const line of spec.split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      const name = line.slice(0, at).trim();
      const path = line.slice(at + 1).trim();
      if (name && path) (groups[name] ??= []).push(path);
    }
  }

  const preview = await call('project.architecture', { target, groups, dryRun: true });
  applyDiagnostics(preview.diagnostics ?? []);
  if (!preview.changed) {
    toast('Nothing to convert. See Problems for why.', 'warn');
    return;
  }
  const summary = preview.moves.map((m) => `  ${m.from} → ${m.to}`).join('\n');
  if (!window.confirm(`Convert to ${target}?\n\n${summary}\n\nCtrl+Z undoes this.`)) return;

  const result = await call('project.architecture', { target, groups });
  applyProjectState(result);
  applyDiagnostics(result.diagnostics ?? []);
  await generate();
  toast(`Converted to ${target}. ${result.moves.length} files moved.`, 'ok');
}

async function newModule() {
  const name = window.prompt('Module name', 'services');
  if (!name) return;
  const result = await call('module.create', { name, directory: `src/${name}` });
  applyProjectState(result.state);
  switchPanel('left', 'architecture');
}

function guessLanguage(path) {
  const ext = path.slice(path.lastIndexOf('.'));
  const backend = state.registries.backends.find((b) => b.extensions.includes(ext));
  return backend?.id ?? state.project.language;
}

async function showDoctor() {
  const result = await call('doctor');
  switchPanel('dock', 'output');
  clearOutput();
  appendOutput(`node ${result.node}\n\n`);
  for (const tool of result.toolchains) {
    appendOutput(`${tool.available ? '✓' : '✗'} ${tool.language.padEnd(11)} ${tool.command.padEnd(8)} ${tool.version ?? tool.hint ?? ''}\n`);
  }
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('mcode-theme', next);
  editor.refreshTheme();
}

// -- command palette ---------------------------------------------------------

let paletteContext = null;
let paletteIndex = 0;
let paletteItems = [];

function openCommandPalette(initial, context = null) {
  paletteContext = context;
  const overlay = $('overlay');
  overlay.hidden = false;
  const input = $('commandInput');
  input.value = initial;
  input.placeholder = context ? 'Add a node here…' : 'Type a command or a node to add…';
  input.focus();
  updatePalette();
  input.oninput = updatePalette;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') {
      paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1);
      renderPaletteResults();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      paletteIndex = Math.max(0, paletteIndex - 1);
      renderPaletteResults();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      paletteItems[paletteIndex]?.run();
      closeCommandPalette();
    }
  };
  overlay.onclick = (e) => {
    if (e.target === overlay) closeCommandPalette();
  };
}

function closeCommandPalette() {
  $('overlay').hidden = true;
  paletteContext = null;
}

function updatePalette() {
  const query = $('commandInput').value.trim().toLowerCase();
  const commands = MENUS.flatMap((m) => m.items.map((i) => ({ label: `${m.title}: ${i.label}`, sub: i.shortcut ?? '', run: () => void i.action() })));
  const nodes = state.registries.nodes.map((d) => ({
    label: d.title,
    sub: d.type,
    run: () => void addNode(d.type, paletteContext?.x ?? 60, paletteContext?.y ?? 60),
  }));
  const pool = paletteContext ? nodes : [...commands, ...nodes];
  paletteItems = pool
    .filter((item) => !query || `${item.label} ${item.sub}`.toLowerCase().includes(query))
    .slice(0, 40);
  paletteIndex = 0;
  renderPaletteResults();
}

function renderPaletteResults() {
  const host = $('commandResults');
  host.innerHTML = '';
  paletteItems.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = `command-result${i === paletteIndex ? ' selected' : ''}`;
    row.innerHTML = `<span>${escapeHtml(item.label)}</span><span class="sub">${escapeHtml(item.sub)}</span>`;
    row.onclick = () => {
      item.run();
      closeCommandPalette();
    };
    host.append(row);
  });
}

// -- small helpers -----------------------------------------------------------

function appendOutput(text, isError = false) {
  const el = $('output');
  const span = document.createElement('span');
  if (isError) span.className = 'err';
  span.textContent = text;
  el.append(span);
  el.scrollTop = el.scrollHeight;
}

function clearOutput() {
  $('output').textContent = '';
}

function setStatus(text) {
  $('statusLeft').textContent = text;
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function debounce(fn, ms) {
  let handle;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------

const savedTheme = localStorage.getItem('mcode-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

boot().catch((err) => {
  setStatus(`failed to start: ${err.message}`);
  toast(err.message, 'error');
});

$('statusRight').textContent = 'Master Code 0.1.0';
