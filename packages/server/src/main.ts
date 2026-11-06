#!/usr/bin/env node
/**
 * The IDE server.
 *
 * A zero-dependency HTTP server that does two things: serve the browser IDE's
 * static files, and expose the core over one JSON command endpoint plus an
 * event stream for long-running output.
 *
 * One endpoint rather than thirty routes is a deliberate simplification. The
 * commands are named operations on the project, they all take and return JSON,
 * and adding one means adding a function to the table below - not a route, a
 * handler, a schema and a client method. The event stream is separate because
 * build and run output arrives over time and the browser needs it as it comes.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import process from 'node:process';
import { createWorkspace } from '#core/index.ts';
import { pluginDirectories } from '#cli/plugins.ts';
import type { Workspace } from '#core/index.ts';
import { DiagnosticBag } from '#core/diagnostics.ts';
import { build } from '#core/build/pipeline.ts';
import { generate } from '#core/codegen/generate.ts';
import { loadProject, readProjectFile, saveProject, writeArtifacts } from '#core/project/io.ts';
import { validateGraph } from '#core/lower/validate.ts';
import { FileGraph, createFile, deleteFile, newId, renameFile, validateFileGraph } from '#core/filegraph/graph.ts';
import { materializePorts, nextVariadicId } from '#core/lower/ports.ts';
import { GraphBuilder, addFile, addModule } from '#core/project/builder.ts';
import { catalogFor, catalogSummary, searchCatalog } from '#core/libraries/catalog.ts';
import { searchRegistry } from '#core/libraries/registry.ts';
import { addToProject, planInstall, removeFromProject } from '#core/libraries/install.ts';
import { checkCapabilities, describeLimits, runDiagnostics, runInSandbox } from '#core/runtime/sandbox.ts';
import { runTests } from '#core/testing/runner.ts';
import { probeTool } from '#core/runtime/exec.ts';
import { emptyUiDocument } from '#core/model/ui.ts';
import type { GraphNode, LogicGraph, Project, ProjectFile } from '#core/model/project.ts';
import { GRAPH_STYLES, findGraph, findNode, touch } from '#core/model/project.ts';
import { parseType } from '#core/types/types.ts';
import { History, isMutating } from './history.ts';
import { flatten, modularise } from '#core/project/architecture.ts';
import { duplicateSymbolNames, projectSymbols } from '#core/project/symbols.ts';
import { runTraced } from '#core/build/run-traced.ts';
import { includeInlinedInputs, unreachedNodes } from '#core/build/trace.ts';
import { challengeOf, challengesFor, checkOutput, getChallenge } from '#core/learn/challenges.ts';
import {
  folderNameFor,
  forgetProject,
  listDirectories,
  placeRoots,
  readRecent,
  rememberProject,
  suggestedRoot,
} from './workspace-state.ts';

const PUBLIC_DIR = resolve(import.meta.dirname, '../../ide/public');

interface Session {
  workspace: Workspace;
  project?: Project;
  root?: string;
  /** Where generated code is written. */
  out?: string;
  /** Undo/redo stacks for the open project. */
  history: History;
}

type CommandHandler = (session: Session, args: Record<string, unknown>) => Promise<unknown> | unknown;

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

const listeners = new Set<ServerResponse>();

function emit(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(payload);
    } catch {
      listeners.delete(res);
    }
  }
}

/**
 * Streams a chunk of build or program output to the IDE.
 *
 * The parameter order matches `RunOptions.onOutput` exactly, and must keep
 * matching: that callback is declared method-style, so TypeScript compares it
 * bivariantly and will not flag a swap. Getting it wrong prints the word
 * "stdout" and silently drops the program's actual output.
 */
function log(chunk: string, stream: 'stdout' | 'stderr'): void {
  emit('output', { stream, chunk });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireProject(session: Session): { project: Project; root: string; out: string } {
  if (!session.project || !session.root) throw new Error('No project is open.');
  return { project: session.project, root: session.root, out: session.out ?? join(session.root, 'build/generated') };
}

function serializeProject(session: Session): unknown {
  const { project } = requireProject(session);
  const graph = new FileGraph(project);
  return {
    project,
    fileGraph: {
      edges: graph.edges,
      cycles: graph.cycles(),
      summary: graph.summary().map((s) => ({ fileId: s.file.id, imports: s.imports, importedBy: s.importedBy })),
    },
    // Every mutating command returns the project state, so this rides along and
    // the Edit menu is never stale.
    history: session.history.state(),
    // Symbols come from the graphs, not from the last generation, so a function
    // drawn a moment ago is immediately referenceable. Sent with the state for
    // the same reason as the history: it is derived, and the client must never
    // compute it separately and drift.
    symbols: projectSymbols(project),
    duplicateSymbols: [...duplicateSymbolNames(project).keys()],
  };
}

/**
 * One row per language, saying plainly what this machine can do with it.
 *
 * `maturity` is what the backend claims it supports; `ready` is whether the
 * tools are actually installed here. Keeping them separate matters — "Rust
 * generates idiomatic source but cargo is missing" and "Rust is a stub" are
 * different sentences, and the New Project dialog should not blur them.
 */
async function describeLanguages(session: Session): Promise<unknown[]> {
  const rows = [];
  for (const backend of session.workspace.backends.all()) {
    const tools = [];
    for (const probe of backend.toolchain) {
      tools.push(await probeTool(probe.command, probe.versionArgs, probe.installHint));
    }
    const missing = tools.filter((t) => !t.available);
    rows.push({
      id: backend.id,
      name: backend.name,
      maturity: backend.maturity,
      extensions: backend.extensions,
      /** No toolchain needed (HTML, CSS) counts as ready. */
      ready: missing.length === 0,
      tools: tools.map((t) => ({
        command: t.command,
        available: t.available,
        version: t.version,
        hint: t.hint,
      })),
      templates: session.workspace.templates
        .forLanguage(backend.id)
        .map((t) => ({ id: t.id, title: t.title, description: t.description, outline: t.outline })),
    });
  }
  return rows;
}

function describeChallenge(c: import('#core/learn/challenges.ts').Challenge): unknown {
  return {
    id: c.id,
    title: c.title,
    difficulty: c.difficulty,
    brief: c.brief,
    steps: c.steps,
    hints: c.hints,
    expect: c.expect,
    args: c.args ?? [],
  };
}

function describeRegistries(workspace: Workspace): unknown {
  return {
    nodes: workspace.nodes.all().map((d) => ({
      type: d.type,
      category: d.category,
      title: d.title,
      description: d.description,
      keywords: d.keywords ?? [],
      styles: d.styles ?? [],
      languages: d.languages ?? [],
      color: d.color,
      root: !!d.root,
      pure: !!d.pure,
      caps: d.caps ?? [],
      props: d.props ?? [],
      doc: d.doc,
      inputs: d.inputs.map(serializePortSpec),
      outputs: d.outputs.map(serializePortSpec),
    })),
    categories: workspace.nodes.categories(),
    backends: workspace.backends.all().map((b) => ({
      id: b.id,
      name: b.name,
      maturity: b.maturity,
      extensions: b.extensions,
      features: b.features,
      packageManager: { id: b.packageManager.id, name: b.packageManager.name, manifestFile: b.packageManager.manifestFile },
      entry: b.entry,
    })),
    templates: workspace.templates.all().map((t) => ({
      id: t.id,
      language: t.language,
      title: t.title,
      description: t.description,
      outline: t.outline,
    })),
    plugins: workspace.plugins.loaded.map((p) => ({ id: p.plugin.id, name: p.plugin.name, version: p.plugin.version })),
  };
}

function serializePortSpec(spec: { id: string; name: string; type: unknown; default?: unknown; variadic?: boolean; bound?: boolean; doc?: string }): unknown {
  return {
    id: spec.id,
    name: spec.name,
    type: typeof spec.type === 'string' ? spec.type : String(spec.type),
    default: spec.default,
    variadic: spec.variadic,
    bound: spec.bound,
    doc: spec.doc,
  };
}

function validateAll(session: Session): DiagnosticBag {
  const { project, workspace } = { ...requireProject(session), workspace: session.workspace };
  const diagnostics = new DiagnosticBag();
  diagnostics.merge(validateFileGraph(project, workspace.backends));
  for (const graph of project.graphs) {
    const file = project.files.find((f) => f.id === graph.fileId);
    if (!file) continue;
    validateGraph(graph, project, workspace.nodes, file.language, diagnostics);
  }
  return diagnostics;
}

function refreshPorts(session: Session, graph: LogicGraph, node: GraphNode): void {
  const def = session.workspace.nodes.get(node.type);
  if (!def) return;
  const { project } = requireProject(session);
  const ports = materializePorts(node, def, project);
  node.inputs = ports.inputs;
  node.outputs = ports.outputs;
  graph.edges = graph.edges.filter((e) => {
    if (e.from.node === node.id && !node.outputs.some((p) => p.id === e.from.port)) return false;
    if (e.to.node === node.id && !node.inputs.some((p) => p.id === e.to.port)) return false;
    return true;
  });
}

function autosave(session: Session): void {
  const { project, root } = requireProject(session);
  touch(project);
  saveProject(project, root);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands: Record<string, CommandHandler> = {
  hello(session) {
    return {
      version: '0.1.0',
      cwd: process.cwd(),
      registries: describeRegistries(session.workspace),
      open: !!session.project,
    };
  },

  /**
   * Everything the welcome screen needs, in one round trip: what languages this
   * machine can actually build, what was open recently, and where a new project
   * should go. One call because the welcome screen is the first thing drawn and
   * three sequential requests would show three stages of a half-built page.
   */
  async 'workspace.welcome'(session) {
    const languages = await describeLanguages(session);
    return {
      languages,
      templates: session.workspace.templates.all().map((t) => ({
        id: t.id,
        language: t.language,
        title: t.title,
        description: t.description,
        outline: t.outline,
      })),
      recent: readRecent(),
      suggestedRoot: suggestedRoot(),
      places: placeRoots(),
      node: process.version,
    };
  },

  /** Directory listing for the location picker. */
  'workspace.browse'(_session, args) {
    return listDirectories(String(args.path ?? suggestedRoot()));
  },

  'workspace.forget'(_session, args) {
    forgetProject(String(args.path ?? ''));
    return { recent: readRecent() };
  },

  /** Challenges a language can express, easiest first. */
  'learn.list'(session, args) {
    const language = String(args.language ?? session.project?.language ?? 'python');
    const backend = session.workspace.backends.get(language);
    return {
      language,
      challenges: challengesFor(backend?.features).map((c) => ({
        id: c.id,
        title: c.title,
        difficulty: c.difficulty,
        brief: c.brief,
      })),
    };
  },

  /** Creates a project from a challenge, in the chosen language. */
  'learn.start'(session, args) {
    const challenge = getChallenge(String(args.id));
    if (!challenge) throw new Error(`No challenge "${String(args.id)}".`);
    const language = String(args.language ?? 'python');
    const backend = session.workspace.backends.require(language);

    const name = String(args.name ?? challenge.title);
    const parent = String(args.path ?? suggestedRoot());
    const root = resolve(parent, folderNameFor(name));
    if (existsSync(join(root, 'project.json'))) {
      throw new Error(`A project already exists in ${root}. Choose another name or folder.`);
    }
    mkdirSync(root, { recursive: true });

    const project = challenge.start({
      registry: session.workspace.nodes,
      options: { name, language },
      entryPath: backend.entry.file,
    });
    saveProject(project, root);
    session.project = project;
    session.root = root;
    session.out = join(root, 'build/generated');
    session.history.clear();
    rememberProject({ name: project.name, path: root, language });
    return { ...(serializeProject(session) as object), root, challenge: describeChallenge(challenge) };
  },

  /** The challenge the open project came from, with its steps and hints. */
  'learn.current'(session) {
    const { project } = requireProject(session);
    const challenge = challengeOf(project);
    return { challenge: challenge ? describeChallenge(challenge) : null };
  },

  /**
   * Builds, runs, and checks the output against the challenge.
   *
   * The real program is run and its real output compared — the graph's shape is
   * never inspected. Several drawings are correct, and marking the drawing
   * would fail the good ones.
   */
  async 'learn.check'(session) {
    const { project, out } = requireProject(session);
    const challenge = challengeOf(project);
    if (!challenge) return { ok: false, reason: 'This project did not come from a challenge.' };

    const built = await build({
      project,
      root: out,
      nodes: session.workspace.nodes,
      backends: session.workspace.backends,
      onOutput: log,
    });
    if (!built.ok) {
      return { ok: false, stage: 'build', diagnostics: built.diagnostics.toJSON(), reason: 'It does not build yet.' };
    }

    const backend = session.workspace.backends.require(project.language);
    const plan = backend.runPlan(project, 'debug');
    if (!plan || plan.openInBrowser) {
      return { ok: false, reason: `${backend.name} cannot be checked automatically.` };
    }

    const run = await runInSandbox({
      project,
      root: out,
      command: challenge.args?.length
        ? { ...plan.command, args: [...plan.command.args, ...challenge.args] }
        : plan.command,
      stdin: challenge.stdin,
      onOutput: log,
    });
    if (run.code !== 0) {
      return {
        ok: false,
        stage: 'run',
        reason: `The program exited with code ${run.code}.`,
        stderr: run.stderr.slice(0, 2000),
      };
    }

    const result = checkOutput(challenge, run.stdout);
    return {
      ok: result.passed,
      stage: 'check',
      checks: result.checks,
      reason: result.message,
      stdout: run.stdout.slice(0, 4000),
      afterword: result.passed ? challenge.afterword : undefined,
    };
  },

  'project.open'(session, args) {
    const root = resolve(String(args.path ?? process.cwd()));
    const { project, diagnostics } = loadProject(root);
    session.project = project;
    session.root = root;
    session.out = join(root, 'build/generated');
    // The stacks hold snapshots of a different project; they cannot apply here.
    session.history.clear();
    rememberProject({ name: project.name, path: root, language: project.language });
    return { ...(serializeProject(session) as object), diagnostics: diagnostics.toJSON() };
  },

  /**
   * Creates a project from the welcome screen.
   *
   * `path` is the *parent* folder; the project directory is derived from the
   * name. Refusing to write into a directory that already holds a project is
   * deliberate — the dialog can offer another name, but silently merging into
   * someone else's project is not recoverable.
   */
  'project.create'(session, args) {
    const template = session.workspace.templates.get(String(args.template));
    if (!template) throw new Error(`No template "${String(args.template)}".`);
    const name = String(args.name ?? 'Untitled').trim() || 'Untitled';

    const parent = String(args.path ?? suggestedRoot());
    const root = args.exact === true ? resolve(parent) : resolve(parent, folderNameFor(name));
    if (existsSync(join(root, 'project.json'))) {
      throw new Error(`A project already exists in ${root}. Choose another name or folder.`);
    }
    mkdirSync(root, { recursive: true });

    const project = template.build({
      registry: session.workspace.nodes,
      options: { name, language: template.language },
    });
    saveProject(project, root);
    session.project = project;
    session.root = root;
    session.out = join(root, 'build/generated');
    session.history.clear();
    rememberProject({ name: project.name, path: root, language: project.language });
    return { ...(serializeProject(session) as object), root };
  },

  'project.state'(session) {
    return serializeProject(session);
  },

  'project.save'(session) {
    const { project, root } = requireProject(session);
    return saveProject(project, root);
  },

  // -- undo / redo -----------------------------------------------------------

  'edit.undo'(session) {
    const { project } = requireProject(session);
    const restored = session.history.undo(project);
    if (!restored) return { ...(serializeProject(session) as object), applied: false };
    session.project = restored;
    autosave(session);
    return { ...(serializeProject(session) as object), applied: true };
  },

  'edit.redo'(session) {
    const { project } = requireProject(session);
    const restored = session.history.redo(project);
    if (!restored) return { ...(serializeProject(session) as object), applied: false };
    session.project = restored;
    autosave(session);
    return { ...(serializeProject(session) as object), applied: true };
  },

  'edit.history'(session) {
    return session.history.state();
  },

  'project.settings'(session, args) {
    const { project } = requireProject(session);
    const patch = (args.settings ?? {}) as Record<string, unknown>;
    if (typeof patch.name === 'string') project.name = patch.name;
    if (typeof patch.description === 'string') project.description = patch.description;
    if (typeof patch.namespace === 'string') project.namespace = patch.namespace;
    if (patch.grants && typeof patch.grants === 'object') Object.assign(project.grants, patch.grants);
    if (patch.sandbox && typeof patch.sandbox === 'object') Object.assign(project.sandbox, patch.sandbox);
    if (patch.build && typeof patch.build === 'object') Object.assign(project.build, patch.build);
    autosave(session);
    return serializeProject(session);
  },

  'validate.all'(session) {
    return { diagnostics: validateAll(session).toJSON() };
  },

  // -- graph editing ---------------------------------------------------------

  'graph.addNode'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    if (!graph) throw new Error('No such graph.');
    const builder = new GraphBuilder(project, session.workspace.nodes, graph);
    const node = builder.add(String(args.type), (args.props as Record<string, unknown>) ?? {}, {
      x: Number(args.x ?? 0),
      y: Number(args.y ?? 0),
    });
    autosave(session);
    return { node, diagnostics: validateAll(session).toJSON() };
  },

  'graph.moveNodes'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    if (!graph) throw new Error('No such graph.');
    for (const move of (args.moves ?? []) as { id: string; x: number; y: number }[]) {
      const node = findNode(graph, move.id);
      if (node) {
        node.x = move.x;
        node.y = move.y;
      }
    }
    autosave(session);
    return { ok: true };
  },

  'graph.setProps'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    const node = graph && findNode(graph, String(args.nodeId));
    if (!graph || !node) throw new Error('No such node.');
    Object.assign(node.props, (args.props ?? {}) as Record<string, unknown>);
    refreshPorts(session, graph, node);
    autosave(session);
    return { node, diagnostics: validateAll(session).toJSON() };
  },

  'graph.setPortDefault'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    const node = graph && findNode(graph, String(args.nodeId));
    if (!graph || !node) throw new Error('No such node.');
    const port = node.inputs.find((p) => p.id === String(args.portId));
    if (!port) throw new Error('No such port.');
    port.defaultValue = args.value;
    autosave(session);
    return { node };
  },

  'graph.addVariadic'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    const node = graph && findNode(graph, String(args.nodeId));
    if (!graph || !node) throw new Error('No such node.');
    const base = String(args.portId);
    const template = node.inputs.find((p) => p.id === base);
    if (!template) throw new Error('No such port.');
    node.inputs.push({ ...template, id: nextVariadicId(node, base, 'in'), dynamic: true });
    autosave(session);
    return { node };
  },

  'graph.deleteNodes'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    if (!graph) throw new Error('No such graph.');
    const ids = new Set((args.nodeIds ?? []) as string[]);
    graph.nodes = graph.nodes.filter((n) => !ids.has(n.id));
    graph.edges = graph.edges.filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node));
    autosave(session);
    return { diagnostics: validateAll(session).toJSON() };
  },

  'graph.connect'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    if (!graph) throw new Error('No such graph.');
    const from = args.from as { node: string; port: string };
    const to = args.to as { node: string; port: string };
    // One source per data input, and one wire per exec output.
    graph.edges = graph.edges.filter((e) => !(e.to.node === to.node && e.to.port === to.port));
    const source = findNode(graph, from.node);
    const sourcePort = source?.outputs.find((p) => p.id === from.port);
    if (sourcePort?.type.kind === 'exec') {
      graph.edges = graph.edges.filter((e) => !(e.from.node === from.node && e.from.port === from.port));
    }
    graph.edges.push({ id: newId('e'), from, to });
    autosave(session);
    return { edges: graph.edges, diagnostics: validateAll(session).toJSON() };
  },

  'graph.disconnect'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    if (!graph) throw new Error('No such graph.');
    const ids = new Set((args.edgeIds ?? []) as string[]);
    graph.edges = graph.edges.filter((e) => !ids.has(e.id));
    autosave(session);
    return { edges: graph.edges, diagnostics: validateAll(session).toJSON() };
  },

  'graph.addVariable'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    if (!graph) throw new Error('No such graph.');
    graph.variables.push({
      id: newId('v'),
      name: String(args.name ?? 'value'),
      type: parseType(String(args.type ?? 'Any')),
      initial: args.initial,
      scope: (args.scope as 'module' | 'local' | 'field') ?? 'module',
    });
    autosave(session);
    return { variables: graph.variables };
  },

  'graph.removeVariable'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    if (!graph) throw new Error('No such graph.');
    graph.variables = graph.variables.filter((v) => v.id !== String(args.variableId));
    autosave(session);
    return { variables: graph.variables };
  },

  /**
   * Sets a graph's paradigm.
   *
   * This does not change what is generated — the same graph emits the same
   * code whatever it is labelled. It declares intent: which nodes the palette
   * should put in front of you, and what the file is meant to be. Treating it
   * as an edit means it is undoable and saved like everything else.
   */
  'graph.setStyle'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    if (!graph) throw new Error('No such graph.');
    const style = String(args.style) as LogicGraph['style'];
    if (!GRAPH_STYLES.includes(style)) throw new Error(`"${style}" is not a paradigm.`);
    graph.style = style;
    autosave(session);
    return serializeProject(session);
  },

  'graph.viewport'(session, args) {
    const { project } = requireProject(session);
    const graph = findGraph(project, String(args.graphId));
    if (!graph) return { ok: false };
    graph.viewport = args.viewport as LogicGraph['viewport'];
    return { ok: true };
  },

  // -- files -----------------------------------------------------------------

  'file.create'(session, args) {
    const { project } = requireProject(session);
    const language = String(args.language);
    const result = addFile(project, {
      path: String(args.path),
      language,
      kind: (args.kind as 'generated' | 'hybrid' | 'user') ?? 'hybrid',
      role: (args.role as 'source' | 'entry' | 'test') ?? 'source',
      graph: args.withGraph === false ? undefined : { name: String(args.path).split('/').pop() ?? 'graph', style: (args.style as never) ?? 'procedural' },
      options: language === 'html' ? { ui: emptyUiDocument(project.name) } : undefined,
    });
    autosave(session);
    return { file: result.file, graph: result.graph, state: serializeProject(session) };
  },

  'file.rename'(session, args) {
    const { project, out } = requireProject(session);
    const result = renameFile(project, String(args.fileId), String(args.path), session.workspace.backends, (dependent) =>
      readProjectFile(out, dependent.path),
    );
    autosave(session);
    return { changes: result.changes, diagnostics: result.diagnostics.toJSON(), state: serializeProject(session) };
  },

  'file.delete'(session, args) {
    const { project } = requireProject(session);
    const result = deleteFile(project, String(args.fileId));
    autosave(session);
    return { changes: result.changes, diagnostics: result.diagnostics.toJSON(), state: serializeProject(session) };
  },

  'file.setUi'(session, args) {
    const { project } = requireProject(session);
    const file = project.files.find((f) => f.id === String(args.fileId));
    if (!file) throw new Error('No such file.');
    file.options = { ...file.options, ui: args.ui };
    autosave(session);
    return { file };
  },

  /**
   * Converts the project between a flat layout and one grouped into modules.
   *
   * Undoable like any other mutation — which matters more here than most,
   * since it moves every source file in the project.
   */
  'project.architecture'(session, args) {
    const { project } = requireProject(session);
    const target = String(args.target ?? '');
    if (target !== 'modular' && target !== 'monolithic') {
      throw new Error('target must be "modular" or "monolithic".');
    }
    const options = {
      backends: session.workspace.backends,
      dryRun: args.dryRun === true,
      readUserFile: (file: ProjectFile) => readProjectFile(session.out ?? '', file.path),
    };
    const result =
      target === 'modular'
        ? modularise(project, { ...options, groups: args.groups as Record<string, string[]> | undefined })
        : flatten(project, options);

    if (!options.dryRun && result.changed) autosave(session);
    return {
      ...(serializeProject(session) as object),
      moves: result.moves,
      modules: result.modules,
      changed: result.changed,
      diagnostics: result.diagnostics.toJSON(),
    };
  },

  'module.create'(session, args) {
    const { project } = requireProject(session);
    const module = addModule(project, {
      name: String(args.name),
      directory: String(args.directory ?? `src/${String(args.name)}`),
      description: args.description ? String(args.description) : undefined,
    });
    autosave(session);
    return { module, state: serializeProject(session) };
  },

  // -- generation, build, run, test -----------------------------------------

  'code.generate'(session, args) {
    const { project, root, out } = requireProject(session);
    const result = generate(project, {
      nodes: session.workspace.nodes,
      backends: session.workspace.backends,
      readExisting: (path) => readProjectFile(out, path),
    });
    if (args.write !== false && result.diagnostics.ok) {
      writeArtifacts(out, result.files, result.orphanedRegions);
      saveProject(project, root);
    }
    return {
      files: result.files.map((f) => ({ path: f.path, fileId: f.fileId, role: f.role, language: f.language, content: f.content })),
      diagnostics: result.diagnostics.toJSON(),
      capabilities: [...result.capabilities],
      packages: result.packages,
      // Which node produced each line, so the IDE can show a node's own code.
      // Inverted here rather than in the browser: the backends already report
      // it during emission and this is the only place that knows the mapping.
      lineOrigins: [...result.lineOrigins].map(([path, lines]) => ({
        path,
        lines: [...lines].map(([line, origin]) => [line, origin.nodeId] as const),
      })),
      out,
    };
  },

  async 'code.build'(session, args) {
    const { project, root, out } = requireProject(session);
    emit('status', { phase: 'build', state: 'started' });
    const outcome = await build({
      project,
      root: out,
      nodes: session.workspace.nodes,
      backends: session.workspace.backends,
      mode: args.release ? 'release' : 'debug',
      onOutput: log,
      onStep: (step) => emit('step', step),
    });
    saveProject(project, root);
    emit('status', { phase: 'build', state: 'finished', ok: outcome.ok });
    return {
      ok: outcome.ok,
      steps: outcome.steps,
      diagnostics: outcome.diagnostics.toJSON(),
      artifacts: outcome.artifacts,
      toolchain: outcome.toolchain,
      durationMs: outcome.durationMs,
    };
  },

  async 'code.run'(session, args) {
    const { project, out } = requireProject(session);
    const backend = session.workspace.backends.require(String(args.language ?? project.language));
    emit('status', { phase: 'run', state: 'started' });

    const built = await build({
      project,
      root: out,
      nodes: session.workspace.nodes,
      backends: session.workspace.backends,
      mode: args.release ? 'release' : 'debug',
      onOutput: log,
    });
    if (!built.ok) {
      emit('status', { phase: 'run', state: 'finished', ok: false });
      return { ok: false, diagnostics: built.diagnostics.toJSON() };
    }

    const program = built.generated.programs.find((p) => p.language === backend.id);
    if (program) {
      const check = checkCapabilities(project, program);
      if (!check.ok) {
        emit('status', { phase: 'run', state: 'blocked' });
        return {
          ok: false,
          blocked: true,
          missing: check.missing.map((m) => ({ capability: m.capability, origins: m.origins })),
          diagnostics: check.diagnostics.toJSON(),
        };
      }
    }

    const plan = backend.runPlan(project, args.release ? 'release' : 'debug');
    if (!plan) return { ok: false, diagnostics: [{ severity: 'error', stage: 'runtime', code: 'run/no-plan', message: `${backend.name} has no run command.` }] };
    if (plan.openInBrowser) {
      emit('status', { phase: 'run', state: 'finished', ok: true });
      return { ok: true, openInBrowser: `/preview/${plan.openInBrowser}` };
    }

    const result = await runInSandbox({
      project,
      root: out,
      command: plan.command,
      stdin: typeof args.stdin === 'string' ? args.stdin : undefined,
      onOutput: log,
    });
    const diagnostics = runDiagnostics(result, (text) => backend.parseDiagnostics(text, project));
    emit('status', { phase: 'run', state: 'finished', ok: result.code === 0 });
    return {
      ok: result.code === 0,
      exitCode: result.code,
      diagnostics,
      limits: describeLimits(result),
      unenforced: result.unenforced,
      durationMs: result.durationMs,
    };
  },

  /**
   * Runs the program and reports which nodes executed, for the graph overlay.
   *
   * Separate from `code.run` because tracing writes a wrapper into the output
   * directory and costs a little speed; an ordinary Run should not pay for it.
   */
  async 'code.trace'(session, args) {
    const { project, out } = requireProject(session);
    const backend = session.workspace.backends.require(project.language);
    emit('status', { phase: 'trace', state: 'started' });

    const built = await build({
      project,
      root: out,
      nodes: session.workspace.nodes,
      backends: session.workspace.backends,
      onOutput: log,
    });
    if (!built.ok) {
      emit('status', { phase: 'trace', state: 'finished', ok: false });
      return { ok: false, diagnostics: built.diagnostics.toJSON() };
    }

    const program = built.generated.programs.find((p) => p.language === backend.id);
    if (program) {
      const check = checkCapabilities(project, program);
      if (!check.ok) {
        emit('status', { phase: 'trace', state: 'blocked' });
        return {
          ok: false,
          blocked: true,
          missing: check.missing.map((m) => ({ capability: m.capability, origins: m.origins })),
          diagnostics: check.diagnostics.toJSON(),
        };
      }
    }

    const plan = backend.runPlan(project, 'debug');
    if (!plan || plan.openInBrowser) {
      emit('status', { phase: 'trace', state: 'finished', ok: false });
      return { ok: false, unsupported: `${backend.name} cannot be traced from here.` };
    }

    const { run, trace: raw } = await runTraced({
      project,
      root: out,
      language: project.language,
      command: args.args ? { ...plan.command, args: [...plan.command.args, ...(args.args as string[])] } : plan.command,
      sourceMap: built.sourceMap,
      onOutput: log,
    });

    // A pure node inlined into a statement that ran, ran.
    const trace = includeInlinedInputs(raw, project.graphs, (t) => !!session.workspace.nodes.get(t)?.pure);
    const all = project.graphs.flatMap((g) => g.nodes.map((n) => n.id));

    emit('status', { phase: 'trace', state: 'finished', ok: run.code === 0 });
    return {
      ok: run.code === 0,
      exitCode: run.code,
      unsupported: trace.unsupported,
      nodes: trace.nodes,
      unreached: unreachedNodes(trace, all),
      limits: describeLimits(run),
      unenforced: run.unenforced,
    };
  },

  async 'code.test'(session, args) {
    const { project, out } = requireProject(session);
    emit('status', { phase: 'test', state: 'started' });
    const built = await build({
      project,
      root: out,
      nodes: session.workspace.nodes,
      backends: session.workspace.backends,
      generateOnly: true,
    });
    if (!built.ok) {
      emit('status', { phase: 'test', state: 'finished', ok: false });
      return { ok: false, diagnostics: built.diagnostics.toJSON() };
    }
    const outcome = await runTests({
      project,
      root: out,
      backends: session.workspace.backends,
      sourceMap: built.sourceMap,
      language: args.language ? String(args.language) : undefined,
      onOutput: log,
    });
    emit('status', { phase: 'test', state: 'finished', ok: outcome.ok });
    return {
      ok: outcome.ok,
      results: outcome.results,
      diagnostics: outcome.diagnostics.toJSON(),
      note: outcome.note,
      durationMs: outcome.durationMs,
    };
  },

  // -- libraries -------------------------------------------------------------

  'libs.summary'() {
    return { summary: catalogSummary() };
  },

  async 'libs.search'(session, args) {
    const language = String(args.language ?? 'python');
    const query = String(args.query ?? '');
    if (!args.online) {
      return { local: searchCatalog(query, { language, limit: 60 }), remote: [], source: 'offline' };
    }
    return searchRegistry({ language, query, allowNetwork: true, limit: 20 });
  },

  'libs.list'(_session, args) {
    return { entries: catalogFor(String(args.language ?? 'python')) };
  },

  'libs.add'(session, args) {
    const { project } = requireProject(session);
    const result = addToProject(project, {
      language: String(args.language ?? project.language),
      name: String(args.name),
      version: args.version ? String(args.version) : undefined,
    });
    autosave(session);
    return { dependency: result.dependency, diagnostics: result.diagnostics.toJSON(), state: serializeProject(session) };
  },

  'libs.remove'(session, args) {
    const { project } = requireProject(session);
    const removed = removeFromProject(project, String(args.language), String(args.name));
    autosave(session);
    return { removed, state: serializeProject(session) };
  },

  'libs.installPlan'(session) {
    const { project } = requireProject(session);
    return { plans: planInstall(project, session.workspace.backends) };
  },

  // -- environment -----------------------------------------------------------

  async doctor(session) {
    const rows = [];
    for (const backend of session.workspace.backends.all()) {
      for (const probe of backend.toolchain) {
        rows.push({ language: backend.id, ...(await probeTool(probe.command, probe.versionArgs, probe.installHint)) });
      }
    }
    return { node: process.version, toolchains: rows };
  },
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res: ServerResponse, root: string, urlPath: string): boolean {
  const rootResolved = resolve(root);
  const target = resolve(root, `.${urlPath}`);
  if (!target.startsWith(rootResolved)) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  let file = target;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(readFileSync(file));
  return true;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function start(): Promise<void> {
  const port = Number(process.env.MASTERCODE_PORT ?? 4488);
  const host = process.env.MASTERCODE_HOST ?? '127.0.0.1';
  const workspace = await createWorkspace({ pluginDirs: pluginDirectories() });
  const session: Session = { workspace, history: new History() };

  // Open the project in the working directory, when there is one.
  const cwd = process.cwd();
  if (existsSync(join(cwd, 'project.json'))) {
    try {
      const { project } = loadProject(cwd);
      session.project = project;
      session.root = cwd;
      session.out = join(cwd, 'build/generated');
    } catch {
      // Left closed; the UI offers to create or open one.
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res, session).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });

  server.listen(port, host, () => {
    console.log(`Master Code IDE  http://${host}:${port}`);
    console.log(session.project ? `  project: ${session.project.name} (${session.root})` : '  no project open - create one in the UI');
    console.log(`  ${workspace.nodes.all().length} node types, ${workspace.backends.all().length} languages`);
    if (workspace.plugins.loaded.length) console.log(`  ${workspace.plugins.loaded.length} plugin(s) loaded`);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    listeners.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      listeners.delete(res);
    });
    return;
  }

  if (path === '/api/command' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.command ?? '');
    const handler = commands[name];
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (!handler) {
      res.writeHead(404).end(JSON.stringify({ error: `Unknown command "${name}".` }));
      return;
    }
    try {
      // Snapshot here rather than inside each handler: a handler that forgets
      // is an edit that silently cannot be undone.
      if (session.project && isMutating(name)) session.history.record(session.project, name);
      const result = await handler(session, (body.args ?? {}) as Record<string, unknown>);
      res.writeHead(200).end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.writeHead(200).end(
        JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    }
    return;
  }

  // Serve generated output so the browser preview can load a generated page.
  if (path.startsWith('/preview/') && session.out) {
    if (serveStatic(res, session.out, path.slice('/preview'.length))) return;
  }

  if (serveStatic(res, PUBLIC_DIR, path === '/' ? '/index.html' : path)) return;

  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}

void start();
