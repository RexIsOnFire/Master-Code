/**
 * Programmatic construction of projects and graphs.
 *
 * The editor is one client of this; templates, importers, tests and the CLI are
 * the others. Everything that creates a node goes through here, so port
 * materialisation and id allocation happen in exactly one place and a template
 * cannot accidentally produce a graph the editor could not have produced.
 */

import type { NodeDefinition, NodeRegistry } from '../nodes/definition.ts';
import { materializePorts, nextVariadicId } from '../lower/ports.ts';
import type {
  Architecture,
  Edge,
  GraphNode,
  GraphStyle,
  GraphVariable,
  LogicGraph,
  Project,
  ProjectFile,
  ProjectModule,
} from '../model/project.ts';
import { PROJECT_FORMAT_VERSION, defaultGrants, defaultSandbox, touch } from '../model/project.ts';
import { newId, normalize } from '../filegraph/graph.ts';
import { defaultBuild } from './io.ts';
import { parseType } from '../types/types.ts';
import type { TypeRef } from '../types/types.ts';

// ---------------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------------

export class GraphBuilder {
  readonly graph: LogicGraph;
  private readonly registry: NodeRegistry;
  private readonly project: Project;
  private column = 0;
  private row = 0;

  constructor(project: Project, registry: NodeRegistry, graph: LogicGraph) {
    this.project = project;
    this.registry = registry;
    this.graph = graph;
  }

  /** Add a node, materialising its ports from the definition and properties. */
  add(type: string, props: Record<string, unknown> = {}, position?: { x: number; y: number }): GraphNode {
    const def = this.registry.get(type);
    if (!def) throw new Error(`unknown node type "${type}"`);

    const defaults: Record<string, unknown> = {};
    for (const p of def.props ?? []) if (p.default !== undefined) defaults[p.name] = p.default;

    const node: GraphNode = {
      id: newId('n'),
      type,
      x: position?.x ?? this.column,
      y: position?.y ?? this.row,
      props: { ...defaults, ...props },
      inputs: [],
      outputs: [],
    };
    const ports = materializePorts(node, def, this.project);
    node.inputs = ports.inputs;
    node.outputs = ports.outputs;
    this.graph.nodes.push(node);

    if (!position) {
      this.column += 260;
      if (this.column > 1300) {
        this.column = 0;
        this.row += 200;
      }
    }
    return node;
  }

  /**
   * Set the literal an input port uses when nothing is wired to it.
   *
   * Port defaults are values, not node properties: `Format`'s template and
   * `Query Selector`'s selector are inputs a user could wire up instead, so
   * they live on the port where the editor can show them inline.
   */
  setDefault(node: GraphNode, portId: string, value: unknown): GraphNode {
    const port = node.inputs.find((p) => p.id === portId);
    if (!port) {
      throw new Error(`node ${node.type} has no input "${portId}" (has: ${node.inputs.map((p) => p.id).join(', ')})`);
    }
    port.defaultValue = value;
    return node;
  }

  /** Add a node and set input defaults in one call. */
  addWith(
    type: string,
    defaults: Record<string, unknown>,
    props: Record<string, unknown> = {},
    position?: { x: number; y: number },
  ): GraphNode {
    const node = this.add(type, props, position);
    for (const [portId, value] of Object.entries(defaults)) this.setDefault(node, portId, value);
    return node;
  }

  /** Re-materialise a node's ports after a property change. */
  refresh(node: GraphNode): void {
    const def = this.registry.get(node.type);
    if (!def) return;
    const ports = materializePorts(node, def, this.project);
    node.inputs = ports.inputs;
    node.outputs = ports.outputs;
    // Drop wires whose port no longer exists.
    this.graph.edges = this.graph.edges.filter((e) => {
      if (e.from.node === node.id && !node.outputs.some((p) => p.id === e.from.port)) return false;
      if (e.to.node === node.id && !node.inputs.some((p) => p.id === e.to.port)) return false;
      return true;
    });
  }

  /** Add another slot to a variadic port and return its id. */
  addVariadic(node: GraphNode, baseId: string, direction: 'in' | 'out' = 'in'): string {
    const def = this.registry.get(node.type);
    const spec = (direction === 'in' ? def?.inputs : def?.outputs)?.find((p) => p.id === baseId);
    if (!spec?.variadic) throw new Error(`port "${baseId}" on ${node.type} is not variadic`);
    const id = nextVariadicId(node, baseId, direction);
    const template = (direction === 'in' ? node.inputs : node.outputs).find((p) => p.id === baseId);
    if (!template) throw new Error(`port "${baseId}" not found on ${node.type}`);
    const port = { ...template, id, dynamic: true };
    if (direction === 'in') node.inputs.push(port);
    else node.outputs.push(port);
    return id;
  }

  /**
   * Wire two ports together. Ports named with a `#` suffix are variadic slots
   * and are created on demand, so a caller can just ask for `a#1`.
   */
  connect(from: GraphNode, fromPort: string, to: GraphNode, toPort: string, label?: string): Edge {
    this.ensurePort(from, fromPort, 'out');
    this.ensurePort(to, toPort, 'in');
    const edge: Edge = {
      id: newId('e'),
      from: { node: from.id, port: fromPort },
      to: { node: to.id, port: toPort },
      label,
    };
    this.graph.edges.push(edge);
    return edge;
  }

  /** Chain execution through a series of nodes, using their default exec ports. */
  chain(...nodes: (GraphNode | [GraphNode, string])[]): void {
    for (let i = 0; i < nodes.length - 1; i++) {
      const current = nodes[i];
      const next = nodes[i + 1];
      const [fromNode, fromPort] = Array.isArray(current) ? current : [current, 'out'];
      const toNode = Array.isArray(next) ? next[0] : next;
      this.connect(fromNode, fromPort, toNode, 'in');
    }
  }

  variable(name: string, type: TypeRef | string, initial?: unknown, scope: GraphVariable['scope'] = 'module'): GraphVariable {
    const variable: GraphVariable = {
      id: newId('v'),
      name,
      type: typeof type === 'string' ? parseType(type) : type,
      initial,
      scope,
    };
    this.graph.variables.push(variable);
    return variable;
  }

  private ensurePort(node: GraphNode, portId: string, direction: 'in' | 'out'): void {
    const ports = direction === 'in' ? node.inputs : node.outputs;
    if (ports.some((p) => p.id === portId)) return;
    const hash = portId.indexOf('#');
    if (hash < 0) {
      throw new Error(`node ${node.type} has no ${direction} port "${portId}" (has: ${ports.map((p) => p.id).join(', ')})`);
    }
    const base = portId.slice(0, hash);
    const template = ports.find((p) => p.id === base);
    if (!template) throw new Error(`node ${node.type} has no variadic port "${base}"`);
    ports.push({ ...template, id: portId, dynamic: true });
  }
}

// ---------------------------------------------------------------------------
// Project building
// ---------------------------------------------------------------------------

export interface NewProjectOptions {
  name: string;
  language: string;
  description?: string;
  architecture?: Architecture;
  namespace?: string;
  author?: string;
  license?: string;
  version?: string;
  template?: string;
}

export function newProject(options: NewProjectOptions): Project {
  const now = new Date().toISOString();
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: newId('project'),
    name: options.name,
    description: options.description,
    version: options.version ?? '0.1.0',
    language: options.language,
    languages: [options.language],
    architecture: options.architecture ?? 'monolithic',
    template: options.template,
    created: now,
    modified: now,
    files: [],
    modules: [],
    graphs: [],
    dependencies: [],
    build: defaultBuild(),
    sandbox: defaultSandbox(),
    grants: defaultGrants(),
    namespace: options.namespace,
    author: options.author,
    license: options.license ?? 'MIT',
  };
}

export interface AddFileOptions {
  path: string;
  language: string;
  kind?: ProjectFile['kind'];
  role?: ProjectFile['role'];
  moduleId?: string;
  /** Create a logic graph attached to this file. */
  graph?: { name: string; style?: GraphStyle };
  literalContent?: string;
  options?: Record<string, unknown>;
}

export function addFile(project: Project, spec: AddFileOptions): { file: ProjectFile; graph?: LogicGraph } {
  const file: ProjectFile = {
    id: newId('file'),
    path: normalize(spec.path),
    language: spec.language,
    kind: spec.kind ?? 'generated',
    role: spec.role ?? 'source',
    moduleId: spec.moduleId,
    exports: [],
    imports: [],
    literalContent: spec.literalContent,
    options: spec.options,
  };
  project.files.push(file);
  if (!project.languages.includes(spec.language)) project.languages.push(spec.language);

  let graph: LogicGraph | undefined;
  if (spec.graph) {
    graph = {
      id: newId('g'),
      name: spec.graph.name,
      style: spec.graph.style ?? 'procedural',
      fileId: file.id,
      nodes: [],
      edges: [],
      variables: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    project.graphs.push(graph);
    file.graphId = graph.id;
  }

  touch(project);
  return { file, graph };
}

export function addModule(
  project: Project,
  spec: { name: string; directory: string; description?: string; dependencies?: string[] },
): ProjectModule {
  const module: ProjectModule = {
    id: newId('mod'),
    name: spec.name,
    directory: normalize(spec.directory),
    version: '0.1.0',
    description: spec.description,
    interface: [],
    dependencies: spec.dependencies ?? [],
    packages: [],
    config: {},
    testFileIds: [],
  };
  project.modules.push(module);
  project.architecture = 'modular';
  touch(project);
  return module;
}

/** Record a dependency in the manifest. Nothing is downloaded. */
export function addDependency(
  project: Project,
  spec: {
    name: string;
    version?: string;
    language: string;
    manager: string;
    license?: string;
    source?: string;
    scope?: 'runtime' | 'dev' | 'build' | 'test';
    configuration?: string;
    target?: string;
  },
): void {
  // One library may legitimately appear once per module and configuration -
  // a test framework in two Gradle modules is two entries, not a duplicate.
  const existing = project.dependencies.find(
    (d) =>
      d.name === spec.name &&
      d.language === spec.language &&
      d.target === spec.target &&
      d.configuration === spec.configuration,
  );
  if (existing) {
    if (spec.version && spec.version !== '*') existing.version = spec.version;
    return;
  }
  project.dependencies.push({
    name: spec.name,
    version: spec.version ?? '*',
    language: spec.language,
    manager: spec.manager,
    license: spec.license,
    source: spec.source,
    scope: spec.scope ?? 'runtime',
    installed: false,
    ...(spec.configuration ? { configuration: spec.configuration } : {}),
    ...(spec.target ? { target: spec.target } : {}),
  });
  touch(project);
}

/** Grant a capability the project's graphs need. */
export function grant(project: Project, capability: keyof Project['grants'], allowed = true): void {
  project.grants[capability] = allowed;
  touch(project);
}

export function builderFor(project: Project, registry: NodeRegistry, graph: LogicGraph): GraphBuilder {
  return new GraphBuilder(project, registry, graph);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const LAYOUT_COLUMN = 250;
const LAYOUT_ROW = 130;

/**
 * Arrange a graph left to right by data and execution flow.
 *
 * Nodes built programmatically arrive in creation order, which reads as a wrap-
 * around grid with wires crossing the whole canvas. Layering by dependency puts
 * producers to the left of consumers, which is how a person would have drawn
 * it. Positions are only a starting point - the user drags nodes wherever they
 * like and those positions are saved.
 */
export function autoLayout(graph: LogicGraph, registry: NodeRegistry): void {
  if (!graph.nodes.length) return;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();

  // A node sits one column right of the furthest thing it depends on.
  const resolve = (id: string, guard: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (guard.has(id)) return 0;
    guard.add(id);

    const node = byId.get(id);
    let best = 0;
    if (node) {
      for (const edge of graph.edges) {
        if (edge.to.node !== id) continue;
        const source = byId.get(edge.from.node);
        if (!source) continue;
        const port = source.outputs.find((p) => p.id === edge.from.port);
        // A body-scoped output flows inward, so it must not push its own
        // declaring node rightwards - that is what would create a cycle here.
        if (port?.bound) continue;
        best = Math.max(best, resolve(edge.from.node, guard) + 1);
      }
    }
    guard.delete(id);
    depth.set(id, best);
    return best;
  };

  for (const node of graph.nodes) resolve(node.id, new Set());

  // Roots anchor the left edge so entry points read first.
  for (const node of graph.nodes) {
    if (registry.get(node.type)?.root) depth.set(node.id, 0);
  }

  const columns = new Map<number, string[]>();
  for (const node of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const column = depth.get(node.id) ?? 0;
    const list = columns.get(column);
    if (list) list.push(node.id);
    else columns.set(column, [node.id]);
  }

  for (const [column, ids] of columns) {
    ids.forEach((id, row) => {
      const node = byId.get(id);
      if (!node) return;
      node.x = column * LAYOUT_COLUMN;
      node.y = row * LAYOUT_ROW;
    });
  }

  // Let the editor frame it on first open rather than restoring a stale view.
  graph.viewport = undefined;
}

/** Lay out every graph in a project. Templates call this when they finish. */
export function autoLayoutProject(project: Project, registry: NodeRegistry): void {
  for (const graph of project.graphs) autoLayout(graph, registry);
}

/** Convenience: definition lookup that throws with a useful message. */
export function requireNode(registry: NodeRegistry, type: string): NodeDefinition {
  const def = registry.get(type);
  if (!def) throw new Error(`unknown node type "${type}"`);
  return def;
}
