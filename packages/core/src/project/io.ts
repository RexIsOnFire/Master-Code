/**
 * The project file format, and reading and writing it.
 *
 * A project is a directory, not a single blob:
 *
 *     MyProject/
 *       project.json          identity, settings, dependencies, capabilities
 *       architecture.json     modules and their public interfaces
 *       files.json            the file graph
 *       graphs/<id>.json      one logic graph per file that has one
 *       ui/<id>.json          one UI document per markup file that has one
 *       src/ ...              generated and hand-written source
 *       build/ ...            build output, never read back
 *
 * Splitting it this way is a version-control decision. Editing one node touches
 * one graph file, so two people working on different parts of a project get a
 * clean merge instead of a conflict in a 4000-line document. Every writer sorts
 * keys and ends with a newline, so a regenerated file that did not change is
 * byte-identical and shows up as no diff at all.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DiagnosticBag } from '../diagnostics.ts';
import { parseRegions } from '../codegen/regions.ts';
import {
  PROJECT_FORMAT_VERSION,
  defaultGrants,
  defaultSandbox,
} from '../model/project.ts';
import type {
  Architecture,
  BuildSettings,
  CapabilityGrants,
  Dependency,
  LogicGraph,
  Project,
  ProjectFile,
  ProjectModule,
  SandboxSettings,
} from '../model/project.ts';
import type { UiDocument } from '../model/ui.ts';
import { parseType, typeToString } from '../types/types.ts';
import { newId, normalize } from '../filegraph/graph.ts';

export const PROJECT_MANIFEST = 'project.json';
export const ARCHITECTURE_FILE = 'architecture.json';
export const FILES_FILE = 'files.json';
export const GRAPHS_DIR = 'graphs';
export const UI_DIR = 'ui';

// ---------------------------------------------------------------------------
// Serialisation
//
// Types are stored as their textual form rather than as nested objects: it is
// far more readable in a diff, and it round-trips exactly through parseType.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function serializeGraph(graph: LogicGraph): Json {
  return {
    id: graph.id,
    name: graph.name,
    style: graph.style,
    fileId: graph.fileId,
    viewport: graph.viewport,
    variables: graph.variables.map((v) => ({ ...v, type: typeToString(v.type) })),
    nodes: [...graph.nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        x: n.x,
        y: n.y,
        width: n.width,
        props: sortKeys(n.props),
        inputs: n.inputs.map(serializePort),
        outputs: n.outputs.map(serializePort),
        collapsed: n.collapsed || undefined,
        comment: n.comment || undefined,
        enabled: n.enabled === false ? false : undefined,
        groupId: n.groupId,
        breakpoint: n.breakpoint || undefined,
      })),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
    groups: graph.groups?.length ? graph.groups : undefined,
    comments: graph.comments?.length ? graph.comments : undefined,
  };
}

function serializePort(p: {
  id: string;
  name: string;
  type: unknown;
  direction: string;
  defaultValue?: unknown;
  dynamic?: boolean;
  bound?: boolean;
  doc?: string;
}): Json {
  return {
    id: p.id,
    name: p.name,
    type: typeToString(p.type as never),
    direction: p.direction,
    defaultValue: p.defaultValue,
    dynamic: p.dynamic || undefined,
    // `bound` must survive the round trip: validation uses it to tell a loop
    // body reading its own loop variable from a genuine data cycle. Dropping it
    // makes a reloaded project report errors the live one did not.
    bound: p.bound || undefined,
    doc: p.doc,
  };
}

function deserializeGraph(raw: Json): LogicGraph {
  const nodes = asArray(raw.nodes).map((n) => {
    const node = n as Json;
    return {
      id: String(node.id),
      type: String(node.type),
      title: node.title as string | undefined,
      x: Number(node.x ?? 0),
      y: Number(node.y ?? 0),
      width: node.width as number | undefined,
      props: (node.props as Record<string, unknown>) ?? {},
      inputs: asArray(node.inputs).map((p) => deserializePort(p as Json, 'in')),
      outputs: asArray(node.outputs).map((p) => deserializePort(p as Json, 'out')),
      collapsed: node.collapsed as boolean | undefined,
      comment: node.comment as string | undefined,
      enabled: node.enabled as boolean | undefined,
      groupId: node.groupId as string | undefined,
      breakpoint: node.breakpoint as boolean | undefined,
    };
  });

  return {
    id: String(raw.id),
    name: String(raw.name ?? 'graph'),
    style: (raw.style as LogicGraph['style']) ?? 'procedural',
    fileId: String(raw.fileId ?? ''),
    nodes,
    edges: asArray(raw.edges) as LogicGraph['edges'],
    groups: raw.groups as LogicGraph['groups'],
    comments: raw.comments as LogicGraph['comments'],
    variables: asArray(raw.variables).map((v) => {
      const variable = v as Json;
      return {
        id: String(variable.id ?? newId('var')),
        name: String(variable.name ?? 'value'),
        type: parseType(String(variable.type ?? 'Any')),
        initial: variable.initial,
        scope: (variable.scope as 'module' | 'local' | 'field') ?? 'module',
        constant: variable.constant as boolean | undefined,
        doc: variable.doc as string | undefined,
      };
    }),
    viewport: raw.viewport as LogicGraph['viewport'],
  };
}

function deserializePort(raw: Json, fallbackDirection: 'in' | 'out') {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    type: parseType(String(raw.type ?? 'Any')),
    direction: (raw.direction as 'in' | 'out') ?? fallbackDirection,
    defaultValue: raw.defaultValue,
    dynamic: raw.dynamic as boolean | undefined,
    bound: raw.bound as boolean | undefined,
    doc: raw.doc as string | undefined,
  };
}

function serializeModule(m: ProjectModule): Json {
  return {
    ...m,
    interface: m.interface.map((i) => ({
      ...i,
      signature: i.signature ? typeToString(i.signature) : undefined,
    })),
  };
}

function deserializeModule(raw: Json): ProjectModule {
  return {
    id: String(raw.id),
    name: String(raw.name),
    directory: String(raw.directory ?? 'src'),
    version: String(raw.version ?? '0.1.0'),
    description: raw.description as string | undefined,
    interface: asArray(raw.interface).map((i) => {
      const member = i as Json;
      return {
        name: String(member.name),
        kind: (member.kind as 'function') ?? 'function',
        signature: member.signature ? parseType(String(member.signature)) : undefined,
        doc: member.doc as string | undefined,
      };
    }),
    dependencies: (raw.dependencies as string[]) ?? [],
    packages: (raw.packages as string[]) ?? [],
    config: (raw.config as Record<string, unknown>) ?? {},
    docFileId: raw.docFileId as string | undefined,
    testFileIds: (raw.testFileIds as string[]) ?? [],
    reusable: raw.reusable as boolean | undefined,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Stable JSON: sorted object keys, two-space indent, trailing newline. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, replacer, 2)}\n`;
}

function replacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return sortKeys(value as Record<string, unknown>);
  }
  return value;
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export interface SaveResult {
  written: string[];
  removed: string[];
  diagnostics: DiagnosticBag;
}

export function saveProject(project: Project, root: string): SaveResult {
  const diag = new DiagnosticBag();
  const written: string[] = [];
  const removed: string[] = [];

  const write = (relPath: string, content: string): void => {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    // Skip identical writes so file timestamps - and watchers - stay quiet.
    if (existsSync(full) && readFileSync(full, 'utf8') === content) return;
    writeFileSync(full, content, 'utf8');
    written.push(relPath);
  };

  project.formatVersion = PROJECT_FORMAT_VERSION;

  write(
    PROJECT_MANIFEST,
    stableJson({
      formatVersion: PROJECT_FORMAT_VERSION,
      id: project.id,
      name: project.name,
      description: project.description,
      version: project.version,
      language: project.language,
      languages: [...project.languages].sort(),
      architecture: project.architecture,
      template: project.template,
      namespace: project.namespace,
      author: project.author,
      license: project.license,
      created: project.created,
      modified: project.modified,
      build: project.build,
      sandbox: project.sandbox,
      grants: project.grants,
      dependencies: [...project.dependencies].sort(
        (a, b) =>
          a.language.localeCompare(b.language) ||
          a.name.localeCompare(b.name) ||
          (a.target ?? '').localeCompare(b.target ?? '') ||
          (a.configuration ?? '').localeCompare(b.configuration ?? ''),
      ),
      extensions: project.extensions,
    }),
  );

  write(
    ARCHITECTURE_FILE,
    stableJson({
      architecture: project.architecture,
      modules: [...project.modules].sort((a, b) => a.name.localeCompare(b.name)).map(serializeModule),
    }),
  );

  write(
    FILES_FILE,
    stableJson({
      files: [...project.files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => ({ ...f, path: normalize(f.path) })),
    }),
  );

  const graphDir = join(root, GRAPHS_DIR);
  const keep = new Set(project.graphs.map((g) => `${g.id}.json`));
  for (const graph of project.graphs) write(join(GRAPHS_DIR, `${graph.id}.json`), stableJson(serializeGraph(graph)));
  // Graphs deleted in the editor must not linger on disk.
  if (existsSync(graphDir)) {
    for (const name of readdirSync(graphDir)) {
      if (name.endsWith('.json') && !keep.has(name)) {
        rmSync(join(graphDir, name));
        removed.push(join(GRAPHS_DIR, name));
      }
    }
  }

  const uiKeep = new Set<string>();
  for (const file of project.files) {
    const doc = file.options?.ui as UiDocument | undefined;
    if (!doc) continue;
    uiKeep.add(`${file.id}.json`);
    write(join(UI_DIR, `${file.id}.json`), stableJson(doc));
  }
  const uiDir = join(root, UI_DIR);
  if (existsSync(uiDir)) {
    for (const name of readdirSync(uiDir)) {
      if (name.endsWith('.json') && !uiKeep.has(name)) {
        rmSync(join(uiDir, name));
        removed.push(join(UI_DIR, name));
      }
    }
  }

  return { written, removed, diagnostics: diag };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface LoadResult {
  project: Project;
  diagnostics: DiagnosticBag;
}

export function loadProject(root: string): LoadResult {
  const diag = new DiagnosticBag();
  const manifestPath = join(root, PROJECT_MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`No ${PROJECT_MANIFEST} in ${root}. Is this a Master Code project?`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Json;

  const version = Number(manifest.formatVersion ?? 0);
  if (version > PROJECT_FORMAT_VERSION) {
    diag.warn(
      'graph',
      'project/newer-format',
      `This project was written by a newer version of Master Code (format ${version}, this build understands ${PROJECT_FORMAT_VERSION}).`,
      { hint: 'Some settings may be dropped when you save.' },
    );
  }

  const architecture = readJsonIfPresent(join(root, ARCHITECTURE_FILE));
  const filesDoc = readJsonIfPresent(join(root, FILES_FILE));

  const files: ProjectFile[] = asArray(filesDoc?.files).map((f) => {
    const file = f as Json;
    return {
      id: String(file.id),
      path: normalize(String(file.path)),
      language: String(file.language),
      kind: (file.kind as ProjectFile['kind']) ?? 'generated',
      role: (file.role as ProjectFile['role']) ?? 'source',
      moduleId: file.moduleId as string | undefined,
      graphId: file.graphId as string | undefined,
      exports: (file.exports as ProjectFile['exports']) ?? [],
      imports: (file.imports as ProjectFile['imports']) ?? [],
      contentRef: file.contentRef as 'disk' | undefined,
      literalContent: file.literalContent as string | undefined,
      options: (file.options as Record<string, unknown>) ?? undefined,
      frozen: file.frozen as boolean | undefined,
    };
  });

  const graphs: LogicGraph[] = [];
  const graphDir = join(root, GRAPHS_DIR);
  if (existsSync(graphDir)) {
    for (const name of readdirSync(graphDir).sort()) {
      if (!name.endsWith('.json')) continue;
      try {
        graphs.push(deserializeGraph(JSON.parse(readFileSync(join(graphDir, name), 'utf8')) as Json));
      } catch (err) {
        diag.error('graph', 'project/graph-unreadable', `Could not read ${GRAPHS_DIR}/${name}: ${String(err)}`, {
          file: `${GRAPHS_DIR}/${name}`,
        });
      }
    }
  }

  const uiDir = join(root, UI_DIR);
  if (existsSync(uiDir)) {
    for (const name of readdirSync(uiDir)) {
      if (!name.endsWith('.json')) continue;
      const fileId = name.replace(/\.json$/, '');
      const target = files.find((f) => f.id === fileId);
      if (!target) continue;
      try {
        target.options = { ...target.options, ui: JSON.parse(readFileSync(join(uiDir, name), 'utf8')) };
      } catch (err) {
        diag.error('graph', 'project/ui-unreadable', `Could not read ${UI_DIR}/${name}: ${String(err)}`);
      }
    }
  }

  const project: Project = {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: String(manifest.id ?? newId('project')),
    name: String(manifest.name ?? 'Untitled'),
    description: manifest.description as string | undefined,
    version: String(manifest.version ?? '0.1.0'),
    language: String(manifest.language ?? 'python'),
    languages: (manifest.languages as string[]) ?? [String(manifest.language ?? 'python')],
    architecture: (manifest.architecture as Architecture) ?? 'monolithic',
    template: manifest.template as string | undefined,
    created: String(manifest.created ?? new Date().toISOString()),
    modified: String(manifest.modified ?? new Date().toISOString()),
    files,
    modules: asArray(architecture?.modules).map((m) => deserializeModule(m as Json)),
    graphs,
    dependencies: (manifest.dependencies as Dependency[]) ?? [],
    build: { ...defaultBuild(), ...((manifest.build as Partial<BuildSettings>) ?? {}) },
    sandbox: { ...defaultSandbox(), ...((manifest.sandbox as Partial<SandboxSettings>) ?? {}) },
    grants: { ...defaultGrants(), ...((manifest.grants as Partial<CapabilityGrants>) ?? {}) },
    namespace: manifest.namespace as string | undefined,
    author: manifest.author as string | undefined,
    license: manifest.license as string | undefined,
    extensions: manifest.extensions as Record<string, unknown> | undefined,
  };

  // Cross-link graphs and files, and report anything left dangling.
  for (const graph of project.graphs) {
    const file = files.find((f) => f.id === graph.fileId);
    if (!file) {
      diag.warn('graph', 'project/orphan-graph', `Graph "${graph.name}" points at a file that no longer exists.`, {
        hint: 'Attach it to a file, or delete it.',
      });
      continue;
    }
    file.graphId = graph.id;
  }
  for (const file of files) {
    if (file.graphId && !project.graphs.some((g) => g.id === file.graphId)) {
      diag.warn('graph', 'project/missing-graph', `"${file.path}" refers to a graph that is not on disk.`, {
        file: file.path,
      });
      file.graphId = undefined;
    }
  }

  return { project, diagnostics: diag };
}

function readJsonIfPresent(path: string): Json | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Json;
  } catch {
    return undefined;
  }
}

export function defaultBuild(): BuildSettings {
  return {
    mode: 'debug',
    outputDir: 'build',
    sourceDir: 'src',
    generatedDir: 'src',
    incremental: true,
    flags: {},
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Writing generated source
// ---------------------------------------------------------------------------

export interface WriteResult {
  written: string[];
  unchanged: string[];
  /** Files an earlier generation wrote that this one no longer produces. */
  removed: string[];
  diagnostics: DiagnosticBag;
}

/** Paths of every file the last generation wrote, one per line, relative to the output root. */
const GENERATED_MANIFEST = '.mcode-generated';

/**
 * Write generated artifacts under `root`.
 *
 * Paths are checked against the project root before anything is written: a
 * generated path is derived from user-supplied file paths, so a `..` in one
 * must not be able to reach outside the project.
 */
export function writeArtifacts(
  root: string,
  artifacts: { path: string; content: string }[],
  orphanedRegions: { path: string; id: string; content: string }[] = [],
): WriteResult {
  const diag = new DiagnosticBag();
  const written: string[] = [];
  const unchanged: string[] = [];
  const rootResolved = resolve(root);
  const previous = readGeneratedManifest(rootResolved);

  for (const artifact of artifacts) {
    const full = resolve(root, artifact.path);
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
      diag.error('codegen', 'codegen/path-escape', `Refusing to write outside the project: "${artifact.path}".`, {
        file: artifact.path,
      });
      continue;
    }
    if (existsSync(full) && readFileSync(full, 'utf8') === artifact.content) {
      unchanged.push(artifact.path);
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, artifact.content, 'utf8');
    written.push(artifact.path);
  }

  // Never drop preserved code on the floor: park it beside the file.
  const grouped = new Map<string, string[]>();
  for (const region of orphanedRegions) {
    const list = grouped.get(region.path);
    const block = `--- region "${region.id}" ---\n${region.content}\n`;
    if (list) list.push(block);
    else grouped.set(region.path, [block]);
  }
  for (const [path, blocks] of grouped) {
    const full = resolve(root, `${path}.orphaned`);
    if (!full.startsWith(rootResolved + sep)) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(
      full,
      `Regions that no longer exist in ${path}.\nMove anything you still need back into the file, then delete this.\n\n${blocks.join('\n')}`,
      'utf8',
    );
    written.push(`${path}.orphaned`);
  }

  const current = new Set(artifacts.map((a) => normalize(a.path)));
  const removed = pruneStale(rootResolved, previous, current, diag);
  mkdirSync(rootResolved, { recursive: true });
  writeFileSync(join(rootResolved, GENERATED_MANIFEST), `${[...current].sort().join('\n')}\n`, 'utf8');

  return { written, unchanged, removed, diagnostics: diag };
}

function readGeneratedManifest(root: string): string[] {
  const path = join(root, GENERATED_MANIFEST);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Delete what an earlier generation wrote and this one did not.
 *
 * A file that was renamed or removed in the project otherwise lingers in the
 * output, still compiled, still imported by whatever used it - so the generated
 * tree drifts from the project it claims to be. Only paths in the previous
 * manifest are candidates, so a file the generator never wrote is never
 * touched; and one whose preserved regions hold hand-written code is kept and
 * reported rather than deleted.
 */
function pruneStale(root: string, previous: string[], current: Set<string>, diag: DiagnosticBag): string[] {
  const removed: string[] = [];
  for (const path of previous) {
    if (current.has(path)) continue;
    const full = resolve(root, path);
    if (!full.startsWith(root + sep) || !existsSync(full)) continue;
    const kept = [...parseRegions(readFileSync(full, 'utf8')).regions.values()].filter((r) => r.content.trim());
    if (kept.length) {
      diag.warn('codegen', 'codegen/stale-file-kept', `"${path}" is no longer generated but holds hand-written regions, so it was kept.`, {
        file: path,
        hint: `Move ${kept.map((r) => `"${r.id}"`).join(', ')} somewhere else, then delete the file.`,
      });
      continue;
    }
    rmSync(full);
    removed.push(path);
    removeEmptyParents(dirname(full), root);
  }
  return removed;
}

/** Remove directories a deletion left empty, up to (not including) the root. */
function removeEmptyParents(dir: string, root: string): void {
  let current = dir;
  while (current.startsWith(root + sep) && existsSync(current) && readdirSync(current).length === 0) {
    rmdirSync(current);
    current = dirname(current);
  }
}

/** Read a file under the project root, or undefined when it is absent. */
export function readProjectFile(root: string, path: string): string | undefined {
  const full = resolve(root, path);
  if (!full.startsWith(resolve(root))) return undefined;
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
}

export function projectRelative(root: string, path: string): string {
  return normalize(relative(root, path));
}
