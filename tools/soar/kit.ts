/**
 * Shared helpers for authoring the Master SOAR project.
 *
 * Everything here goes through GraphBuilder, so a graph produced by this script
 * is one the editor could have produced by hand - the same port materialisation,
 * the same id allocation. Nothing is hand-written JSON.
 */

import type { NodeRegistry } from '#core/nodes/definition.ts';
import type { GraphNode, GraphStyle, LogicGraph, Project, ProjectFile, ProjectModule } from '#core/model/project.ts';
import { GraphBuilder, addFile } from '#core/project/builder.ts';

export interface Ctx {
  project: Project;
  registry: NodeRegistry;
}

export interface PyFileSpec {
  path: string;
  module?: ProjectModule;
  doc: string;
  style?: GraphStyle;
  kind?: ProjectFile['kind'];
  role?: ProjectFile['role'];
}

export interface Built {
  file: ProjectFile;
  graph: LogicGraph;
  g: GraphBuilder;
}

/**
 * Where Python lives on disk.
 *
 * Inside a real `soar` package, not loose under src/. A top-level `platform/`
 * directory on sys.path shadows the stdlib `platform` module for the entire
 * process - a latent import bug that only surfaces when some dependency reaches
 * for it. `soar.platform` cannot shadow anything.
 */
export function pyPath(path: string): string {
  if (path.startsWith('src/') && !path.startsWith('src/soar/')) {
    return 'src/soar/' + path.slice('src/'.length);
  }
  return path;
}

/** A Python source file with a logic graph attached. */
export function py(ctx: Ctx, spec: PyFileSpec): Built {
  const { file, graph } = addFile(ctx.project, {
    path: pyPath(spec.path),
    language: 'python',
    kind: spec.kind ?? 'hybrid',
    role: spec.role ?? 'source',
    moduleId: spec.module?.id,
    graph: { name: spec.doc, style: spec.style ?? 'procedural' },
  });
  return { file, graph: graph!, g: new GraphBuilder(ctx.project, ctx.registry, graph!) };
}

export interface Param {
  name: string;
  type: string;
}

/**
 * A public function whose body is one Custom Code block.
 *
 * This is the low-code/pro-code seam made concrete: the signature, the types and
 * the call site are graph objects an analyst can see and rewire; the body is the
 * escape hatch for what the visual vocabulary genuinely cannot express - crypto
 * primitives, database drivers, socket handling. The generated output is a named
 * helper plus a thin public function that calls it, which is what a person would
 * have written anyway.
 */
/** camelCase form of a snake_case identifier, as the JavaScript backend emits it. */
function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Guard against a public wrapper and its Custom Code body colliding.
 *
 * The JavaScript backend camelCases identifiers, so a function called
 * `renderCanvas` whose body is named `render_canvas` produces two declarations
 * of the same name - valid Python, invalid JavaScript. This turns that into an
 * authoring-time error with the fix in the message.
 */
function assertDistinct(name: string, implName: string, language?: string): void {
  if (language !== 'javascript') return;

  // The backend camelCases declarations, so a snake_case name is declared as
  // something else and every raw call site that spells it the original way
  // calls a function that is not there. Valid syntax, ReferenceError at run
  // time, invisible to a parser check - so it is refused here instead.
  if (name.includes('_')) {
    throw new Error(
      `JavaScript function "${name}" must be camelCase: the backend will declare ` +
        `it as "${camel(name)}" and any body calling "${name}" would break at run time.`,
    );
  }

  if (camel(implName) !== camel(name)) return;
  throw new Error(
    `"${implName}" camelCases to the same identifier as "${name}"; ` +
      'the JavaScript backend would emit two declarations of it. Rename the body.',
  );
}
export function fnWithBody(
  g: GraphBuilder,
  spec: {
    name: string;
    params?: Param[];
    returns?: string;
    doc: string;
    implName?: string;
    code: string;
    language?: string;
    capabilities?: string[];
    packages?: (string | { name: string; version?: string })[];
    isAsync?: boolean;
  },
): GraphNode {
  const params = spec.params ?? [];
  const asyncJs = spec.isAsync === true && spec.language === 'javascript';

  // A Custom Code node emits a plain named function, so a JavaScript body that
  // awaits has to carry its own async scope - and the wrapper must return the
  // promise rather than drop it, or `await` at the call site resolves early.
  const returns = asyncJs ? 'Any' : (spec.returns ?? 'Void');
  const code = asyncJs ? `return (async () => {
${spec.code}
})();` : spec.code;

  const implName = spec.implName ?? `${spec.name}_impl`;
  assertDistinct(spec.name, implName, spec.language);

  const fn = g.add('entry/function', {
    name: spec.name,
    params,
    returns,
    doc: spec.doc,
    isAsync: spec.isAsync ?? false,
  });
  const body = g.add('custom/code', {
    name: implName,
    language: spec.language ?? 'python',
    params,
    returns,
    code,
    doc: spec.doc,
    capabilities: spec.capabilities ?? [],
    packages: spec.packages ?? [],
  });
  for (const p of params) g.connect(fn, `p:${p.name}`, body, `p:${p.name}`);
  if (returns === 'Void') {
    g.chain([fn, 'out'], body);
  } else {
    const ret = g.add('control/return');
    g.connect(body, 'result', ret, 'value');
    g.chain([fn, 'out'], body, ret);
  }
  return fn;
}

/** A method on a class, body in Custom Code, wired from `self` and parameters. */
export function methodWithBody(
  g: GraphBuilder,
  spec: {
    className: string;
    name: string;
    params?: Param[];
    returns?: string;
    doc: string;
    selfType?: string;
    implName?: string;
    code: string;
    language?: string;
    capabilities?: string[];
    packages?: (string | { name: string; version?: string })[];
    isStatic?: boolean;
  },
): GraphNode {
  const params = spec.params ?? [];
  const returns = spec.returns ?? 'Void';
  const method = g.add('oop/method', {
    className: spec.className,
    name: spec.name,
    params,
    returns,
    doc: spec.doc,
    isStatic: spec.isStatic ?? false,
  });
  const implParams: Param[] = spec.isStatic
    ? params
    : [{ name: 'self', type: spec.selfType ?? spec.className }, ...params];
  const body = g.add('custom/code', {
    name: spec.implName ?? `${toSnake(spec.className)}_${spec.name}`,
    language: spec.language ?? 'python',
    params: implParams,
    returns,
    code: spec.code,
    doc: spec.doc,
    capabilities: spec.capabilities ?? [],
    packages: spec.packages ?? [],
  });
  if (!spec.isStatic) g.connect(method, 'self', body, 'p:self');
  for (const p of params) g.connect(method, `p:${p.name}`, body, `p:${p.name}`);
  if (returns === 'Void') {
    g.chain([method, 'out'], body);
  } else {
    const ret = g.add('control/return');
    g.connect(body, 'result', ret, 'value');
    g.chain([method, 'out'], body, ret);
  }
  return method;
}

/** Declare what other files may import from this one. */
export function exports_(
  file: ProjectFile,
  symbols: { name: string; sort: 'function' | 'class' | 'const'; doc?: string }[],
): void {
  for (const s of symbols) file.exports.push({ name: s.name, sort: s.sort, doc: s.doc });
}

/** Record an import edge between two project files. */
export function imports_(from: ProjectFile, to: ProjectFile, symbols: string[]): void {
  from.imports.push({ to: to.id, scope: 'file', symbols, generated: true });
}

/** Publish a member on a module's declared interface. */
export function iface(
  module: ProjectModule,
  members: { name: string; kind: 'function' | 'class' | 'constant' | 'type'; doc: string }[],
): void {
  for (const m of members) module.interface.push(m);
}

export function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

/** A note pinned into a graph, so the intent is visible on the canvas. */
export function note(g: GraphBuilder, after: GraphNode, port: string, text: string): GraphNode {
  const n = g.add('data/comment', { text });
  g.connect(after, port, n, 'in');
  return n;
}

/** `src/soar/incidents/service.py` -> `soar.incidents.service`. */
function pythonModule(path: string): string {
  return path.replace(/^src\//, '').replace(/\.py$/, '').replace(/\//g, '.');
}

/**
 * Strip comments and string literals before scanning for identifiers.
 *
 * Without this the scanner finds `read` and `append` inside a docstring and
 * concludes the file depends on whichever module exports them - which produced
 * five phantom import cycles the first time this ran. Prose is not code.
 */
function stripLiterals(code: string, language: string): string {
  let out = code;
  if (language === 'python') {
    out = out.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, ' ');
    out = out.replace(/#[^\n]*/g, ' ');
  } else {
    out = out.replace(/\/\*[\s\S]*?\*\//g, ' ');
    out = out.replace(/\/\/[^\n]*/g, ' ');
    out = out.replace(/`(?:[^`\\]|\\.)*`/g, ' ');
  }
  out = out.replace(/'(?:[^'\\\n]|\\.)*'/g, ' ');
  out = out.replace(/"(?:[^"\\\n]|\\.)*"/g, ' ');
  return out;
}

/**
 * Aliases a Custom Code body uses that are not the exported name.
 *
 * Three of them, and they exist because the bare names would read badly at the
 * call site: `record(...)` and `append(...)` say nothing, and `invoke(...)` says
 * less. Declaring them here keeps the alias local to the import rather than
 * forcing a rename that would make audit/log.py read worse.
 */
const ALIASES: Record<string, { path: string; name: string }> = {
  audit_record: { path: 'src/soar/audit/log.py', name: 'record' },
  timeline_append: { path: 'src/soar/incidents/timeline.py', name: 'append' },
  timeline_read: { path: 'src/soar/incidents/timeline.py', name: 'read' },
  http_invoke: { path: 'src/soar/commands/http_command.py', name: 'invoke' },
};

/**
 * Give every Custom Code body the imports its text actually needs.
 *
 * The generator discovers imports from IR references; a Custom Code body is
 * opaque text, so a cross-file call inside one produces none. This resolves them
 * from the export table after the project is built - the same computation the
 * generator does, applied to the one place it cannot see.
 *
 * Only call sites and class references count. An identifier has to be followed
 * by `(`, or be a PascalCase exported type, and must not be preceded by a dot.
 * Anything looser matches ordinary words and invents dependencies.
 */
export function wireCustomCodeImports(project: Project): number {
  const owners = new Map<string, ProjectFile>();
  const ambiguous = new Set<string>();
  for (const file of project.files) {
    for (const symbol of file.exports) {
      if (owners.has(symbol.name) && owners.get(symbol.name) !== file) {
        ambiguous.add(symbol.name);
      }
      owners.set(symbol.name, file);
    }
  }

  let wired = 0;
  for (const graph of project.graphs) {
    const file = project.files.find((f) => f.id === graph.fileId);
    if (!file) continue;

    const local = new Set(file.exports.map((e) => e.name));
    for (const node of graph.nodes) {
      if (typeof node.props.name === 'string') local.add(node.props.name);
      if (typeof node.props.className === 'string') local.add(node.props.className);
    }

    for (const node of graph.nodes) {
      if (node.type !== 'custom/code') continue;
      const language = String(node.props.language ?? 'any');
      if (language !== 'python' && language !== 'javascript') continue;

      const code = String(node.props.code ?? '');
      const scannable = stripLiterals(code, language);

      // name -> [file, exported name]
      const needed = new Map<string, { file: ProjectFile; name: string }>();
      const consider = (used: string): void => {
        if (local.has(used) || needed.has(used)) return;

        const alias = ALIASES[used];
        if (alias) {
          const owner = project.files.find((f) => f.path === alias.path);
          if (owner && owner.id !== file.id) needed.set(used, { file: owner, name: alias.name });
          return;
        }
        if (ambiguous.has(used)) return;
        const owner = owners.get(used);
        if (!owner || owner.id === file.id) return;
        if (owner.language !== file.language) return;
        needed.set(used, { file: owner, name: used });
      };

      for (const match of scannable.matchAll(/(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
        consider(match[1]);
      }
      for (const match of scannable.matchAll(/(?<![\w.])([A-Z][A-Za-z0-9]*)(?![\w])/g)) {
        if (owners.has(match[1]) || ALIASES[match[1]]) consider(match[1]);
      }
      if (!needed.size) continue;

      const byPath = new Map<string, { path: string; entries: string[] }>();
      for (const [used, target] of [...needed].sort()) {
        const bucket = byPath.get(target.file.path)
          ?? { path: target.file.path, entries: [] };
        bucket.entries.push(
          used === target.name
            ? used
            : language === 'python'
              ? `${target.name} as ${used}`
              : `${target.name}: ${used}`,
        );
        byPath.set(target.file.path, bucket);

        const edge = file.imports.find((i) => i.to === target.file.id);
        if (edge) {
          edge.symbols = [...new Set([...(edge.symbols ?? []), target.name])].sort();
        } else {
          file.imports.push({
            to: target.file.id, scope: 'file', symbols: [target.name], generated: true,
          });
        }
      }

      const lines = [...byPath.values()]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(({ path, entries }) =>
          language === 'python'
            ? `from ${pythonModule(path)} import ${entries.sort().join(', ')}`
            // An ES import is only legal at module top level, and a Custom Code
            // body is a function body. Modules publish into a small registry at
            // load; a body destructures what it needs from it at call time.
            : `const { ${entries.sort().join(', ')} } = globalThis.SOAR;`,
        );

      node.props.code = `${lines.join('\n')}\n\n${code}`;
      wired += needed.size;
    }
  }
  return wired;
}

/**
 * Publish a browser module's public functions into `globalThis.SOAR`.
 *
 * The browser files are ES modules with separate scopes, and a Custom Code body
 * is a function body - so a cross-file call inside one cannot be resolved by an
 * import. Each module registers its public surface at load, and a body reads
 * what it needs from the registry. Scripts are included in dependency order, so
 * everything is registered before the entry module's boot runs.
 *
 * It is a small, explicit seam rather than an implicit global: only the names
 * passed here are reachable, and they are the same names `exports_` declares.
 */
/**
 * Attach every handler the markup asks for.
 *
 * The HTML backend writes `data-mcode-events="click:onNavigate"` onto the
 * element and expects something to honour it. Nothing did: every handler in the
 * workspace was a live exported function that no event ever reached, so the
 * whole UI rendered correctly and did nothing at all.
 *
 * The names come from the graph's own event/handler nodes, so a handler added
 * to a screen is bound without anyone remembering to add it to a list here.
 */
export function bindMarkupHandlers(g: GraphBuilder): void {
  const names = [
    ...new Set(
      g.graph.nodes
        .filter((n) => n.type === 'event/handler')
        .map((n) => String(n.props.event ?? ''))
        .filter(Boolean),
    ),
  ].sort();
  if (!names.length) return;

  chainOnReady(
    g,
    g.add('custom/code', {
      name: 'bind_markup_handlers',
      language: 'javascript',
      params: [],
      returns: 'Void',
      doc: 'Bind this module\'s handlers to the elements that name them.',
      code: [
        'const { bindDeclaredHandlers } = globalThis.SOAR;',
        'bindDeclaredHandlers({',
        ...names.map((name) => `  ${name},`),
        '});',
      ].join('\n'),
    }),
  );
}

export function publishToRegistry(g: GraphBuilder, names: string[]): void {
  chainOnReady(
    g,
    g.add('custom/code', {
      name: 'publish_module_exports',
      language: 'javascript',
      params: [],
      returns: 'Void',
      doc: 'Register this module in globalThis.SOAR so Custom Code bodies in sibling modules can reach it.',
      code: [
        'globalThis.SOAR = globalThis.SOAR || {};',
        'Object.assign(globalThis.SOAR, {',
        ...names.map((name) => `  ${name},`),
        '});',
      ].join('\n'),
    }),
  );
}

/**
 * Append a node to the end of a file's On Page Ready chain.
 *
 * Reuses an existing On Page Ready rather than adding a second: two of them in
 * one file generate two functions of the same name, which is valid Python and
 * invalid JavaScript - the kind of difference that only shows up at generate.
 */
function chainOnReady(g: GraphBuilder, node: GraphNode): void {
  const existing = g.graph.nodes.find((n) => n.type === 'dom/on-ready');
  const ready = existing ?? g.add('dom/on-ready');

  let from: GraphNode = ready;
  let port = 'out';
  for (;;) {
    const edge = g.graph.edges.find((e) => e.from.node === from.id && e.from.port === port);
    if (!edge) break;
    const next = g.graph.nodes.find((n) => n.id === edge.to.node);
    if (!next || !next.outputs.some((p) => p.id === 'out')) break;
    from = next;
    port = 'out';
  }
  g.chain([from, port], node);
}
