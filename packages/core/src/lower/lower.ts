/**
 * Graph -> IR lowering.
 *
 * One logic graph becomes one IR module. The walk has two interleaved parts:
 *
 *   execution  Each root node (Main, Function, Class member, Event Handler,
 *              Test Case) starts a chain. A node in a chain emits its own
 *              statements and, by calling `execBranch('out')`, splices in
 *              everything downstream. Nesting therefore falls out of the graph
 *              shape instead of needing a separate structuring pass.
 *
 *   data       Pulling on an input port lowers the producing node on demand and
 *              memoises the result, so a node feeding three consumers is
 *              lowered once. Genuinely pure expressions are inlined at each use
 *              site; anything large enough to hurt readability is hoisted into
 *              a named local first.
 */

import type {
  ClassMemberContribution,
  LowerContext,
  LowerResult,
  NodeDefinition,
  NodeRegistry,
} from '../nodes/definition.ts';
import { toIdentifier } from '../nodes/definition.ts';
import type {
  Capability,
  IrClass,
  IrDecl,
  IrExpr,
  IrFunction,
  IrGlobal,
  IrImport,
  IrModule,
  IrStmt,
  Origin,
} from '../ir/ir.ts';
import { E, S } from '../ir/build.ts';
import { DiagnosticBag } from '../diagnostics.ts';
import type { Edge, GraphNode, LogicGraph, Project, ProjectFile } from '../model/project.ts';
import { T, parseType, typeToString } from '../types/types.ts';
import type { TypeRef } from '../types/types.ts';
import { TypeResolver, basePortId } from './ports.ts';
import { validateGraph } from './validate.ts';

export interface LowerOptions {
  language: string;
  /** Skip validation when the caller has already run it. */
  skipValidation?: boolean;
  diag?: DiagnosticBag;
}

export interface LoweredModule {
  module: IrModule;
  diagnostics: DiagnosticBag;
  /** External packages the graph asked for. */
  packages: { name: string; version: string }[];
  /** Capabilities the graph needs. */
  capabilities: Set<Capability>;
}

/** How big an inlined expression may get before it earns a named local. */
const INLINE_SIZE_LIMIT = 8;

export function lowerGraph(
  graph: LogicGraph,
  file: ProjectFile,
  project: Project,
  registry: NodeRegistry,
  options: LowerOptions,
): LoweredModule {
  const diag = options.diag ?? new DiagnosticBag();
  let resolver: TypeResolver;
  if (options.skipValidation) {
    resolver = new TypeResolver(graph, registry);
    resolver.resolve();
  } else {
    resolver = validateGraph(graph, project, registry, options.language, diag).resolver;
  }
  return new Lowerer(graph, file, project, registry, options.language, diag, resolver).run();
}

class Lowerer {
  private readonly byId: Map<string, GraphNode>;
  private readonly incoming = new Map<string, Edge>();
  private readonly outgoing = new Map<string, Edge[]>();
  private readonly useCount = new Map<string, number>();

  private readonly exprCache = new Map<string, Record<string, IrExpr>>();
  /** Outputs a node published via `bindOutput` while it is still lowering. */
  private readonly pending = new Map<string, Record<string, IrExpr>>();
  private readonly hoisted = new Map<string, IrExpr>();
  private readonly lowering = new Set<string>();

  private readonly imports: IrImport[] = [];
  private readonly extraDecls: IrDecl[] = [];
  private readonly packages = new Map<string, string>();
  private readonly capabilities = new Set<Capability>();
  private readonly members: ClassMemberContribution[] = [];

  private readonly tempCounters = new Map<string, number>();
  /** Names already taken by declarations, variables and parameters. */
  private readonly reserved = new Set<string>();
  /** Stack of hoist buffers, one per statement position being built. */
  private readonly hoistStack: IrStmt[][] = [];

  private readonly graph: LogicGraph;
  private readonly file: ProjectFile;
  private readonly project: Project;
  private readonly registry: NodeRegistry;
  private readonly language: string;
  private readonly diag: DiagnosticBag;
  private readonly resolver: TypeResolver;

  constructor(
    graph: LogicGraph,
    file: ProjectFile,
    project: Project,
    registry: NodeRegistry,
    language: string,
    diag: DiagnosticBag,
    resolver: TypeResolver,
  ) {
    this.graph = graph;
    this.file = file;
    this.project = project;
    this.registry = registry;
    this.language = language;
    this.diag = diag;
    this.resolver = resolver;
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const v of graph.variables ?? []) this.reserved.add(toIdentifier(v.name));
    for (const n of graph.nodes) {
      for (const key of ['name', 'event', 'className', 'method', 'varName', 'target']) {
        const value = n.props[key];
        if (typeof value === 'string' && value) this.reserved.add(toIdentifier(value));
      }
      const params = n.props.params;
      if (Array.isArray(params)) {
        for (const p of params) {
          const name = (p as { name?: unknown })?.name;
          if (typeof name === 'string') this.reserved.add(toIdentifier(name));
        }
      }
    }
    for (const e of graph.edges) {
      this.incoming.set(`${e.to.node}:${e.to.port}`, e);
      const k = `${e.from.node}:${e.from.port}`;
      const arr = this.outgoing.get(k);
      if (arr) arr.push(e);
      else this.outgoing.set(k, [e]);
      this.useCount.set(k, (this.useCount.get(k) ?? 0) + 1);
    }
  }

  run(): LoweredModule {
    const decls: IrDecl[] = [];

    // Module-scope variables become globals; graph-local ones are hoisted into
    // the entry body further down.
    for (const v of this.graph.variables ?? []) {
      if (v.scope !== 'module') continue;
      const g: IrGlobal = {
        k: 'global',
        name: toIdentifier(v.name),
        type: v.type,
        init: literalExpr(v.initial, v.type),
        constant: v.constant,
        visibility: 'public',
        doc: v.doc,
      };
      decls.push(g);
    }

    // Roots in a stable order so regeneration is byte-for-byte reproducible.
    const roots = this.graph.nodes
      .filter((n) => this.registry.get(n.type)?.root)
      .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));

    for (const node of roots) {
      const result = this.lowerNode(node);
      if (result.decls) decls.push(...result.decls);
      if (result.members) this.members.push(...result.members);
      if (result.stmts?.length) {
        this.diag.warn(
          'ir',
          'lower/orphan-statements',
          `"${this.registry.get(node.type)?.title}" produced statements outside any function; they were dropped.`,
          { origin: { nodeId: node.id, graphId: this.graph.id } },
        );
      }
    }

    decls.push(...this.extraDecls);
    this.attachClassMembers(decls);

    const localVars = (this.graph.variables ?? []).filter((v) => v.scope === 'local');
    if (localVars.length) this.injectLocals(decls, localVars);

    const module: IrModule = {
      id: this.file.id,
      name: moduleNameFor(this.file, this.project),
      path: stripExtension(this.file.path),
      imports: dedupeImports(this.imports),
      decls,
      doc: this.graph.name ? `Generated from graph "${this.graph.name}".` : undefined,
      exports: undefined,
    };

    return {
      module,
      diagnostics: this.diag,
      packages: [...this.packages].map(([name, version]) => ({ name, version })),
      capabilities: this.capabilities,
    };
  }

  // -- class assembly --------------------------------------------------------

  private attachClassMembers(decls: IrDecl[]): void {
    const classes = new Map<string, IrClass>();
    for (const d of decls) if (d.k === 'class') classes.set(d.name, d);

    for (const m of this.members) {
      const cls = classes.get(m.className);
      if (!cls) {
        this.diag.error(
          'ir',
          'lower/no-such-class',
          `"${m.method?.name ?? m.field?.name}" targets class "${m.className}", which is not declared in this file.`,
          {
            origin: m.method?.origin ?? m.field?.origin,
            hint: `Classes in this file: ${[...classes.keys()].join(', ') || '(none)'}`,
          },
        );
        continue;
      }
      if (m.field) {
        const i = cls.fields.findIndex((f) => f.name === m.field!.name);
        if (i >= 0) cls.fields[i] = m.field;
        else cls.fields.push(m.field);
      }
      if (m.method) {
        if (m.isCtor) {
          cls.ctor = m.method;
          continue;
        }
        // A contributed method replaces a same-named default (state machine
        // hooks work this way), otherwise it is appended.
        const i = cls.methods.findIndex((x) => x.name === m.method!.name);
        if (i >= 0) cls.methods[i] = m.method;
        else cls.methods.push(m.method);
      }
    }
  }

  private injectLocals(decls: IrDecl[], vars: LogicGraph['variables']): void {
    const entry = decls.find((d): d is IrFunction => d.k === 'function' && !!d.isEntry);
    const target = entry ?? decls.find((d): d is IrFunction => d.k === 'function');
    const stmts = vars.map((v) =>
      S.let_(toIdentifier(v.name), v.type, literalExpr(v.initial, v.type), !v.constant),
    );
    if (target) {
      target.body.unshift(...stmts);
      return;
    }
    this.diag.warn(
      'ir',
      'lower/locals-without-function',
      'Local variables were declared but this file has no function to put them in; they became module-level values.',
      { origin: { graphId: this.graph.id, nodeId: this.graph.nodes[0]?.id ?? '' } },
    );
    for (const v of vars) {
      decls.push({
        k: 'global',
        name: toIdentifier(v.name),
        type: v.type,
        init: literalExpr(v.initial, v.type),
        constant: v.constant,
      });
    }
  }

  // -- node lowering ---------------------------------------------------------

  private lowerNode(node: GraphNode): LowerResult {
    const def = this.registry.get(node.type);
    if (!def) return {};
    if (node.enabled === false) {
      // A disabled node still passes execution through, so toggling one off
      // does not silently sever the rest of the chain.
      return { stmts: this.execBranchOf(node, 'out') };
    }
    if (this.lowering.has(node.id)) {
      this.diag.error('ir', 'lower/cycle', 'A node is part of a cycle and cannot be lowered.', {
        origin: { nodeId: node.id, graphId: this.graph.id },
      });
      return {};
    }
    this.lowering.add(node.id);
    this.pending.set(node.id, {});
    let result: LowerResult;
    try {
      result = def.lower(this.contextFor(node, def));
    } catch (err) {
      this.diag.error(
        'ir',
        'lower/node-failed',
        `Node "${def.title}" failed to generate: ${err instanceof Error ? err.message : String(err)}`,
        { origin: { nodeId: node.id, graphId: this.graph.id } },
      );
      result = {};
    } finally {
      this.lowering.delete(node.id);
    }
    if (result.imports) this.imports.push(...result.imports);
    const published = this.pending.get(node.id) ?? {};
    this.pending.delete(node.id);
    if (result.exprs || Object.keys(published).length) {
      this.exprCache.set(node.id, { ...published, ...result.exprs });
    }
    def.caps?.forEach((c) => this.capabilities.add(c));
    return result;
  }

  /** All statements produced by the chain hanging off an exec output. */
  private execBranchOf(node: GraphNode, portId: string): IrStmt[] {
    const edge = (this.outgoing.get(`${node.id}:${portId}`) ?? [])[0];
    if (!edge) return [];
    const target = this.byId.get(edge.to.node);
    if (!target) return [];

    const buffer: IrStmt[] = [];
    this.hoistStack.push(buffer);
    let result: LowerResult;
    try {
      result = this.lowerNode(target);
    } finally {
      this.hoistStack.pop();
    }
    return [...buffer, ...(result.stmts ?? [])];
  }

  /** The expression on a node's data output, lowering the node if needed. */
  private outputExpr(nodeId: string, portId: string): IrExpr {
    const hoistKey = `${nodeId}:${portId}`;
    const already = this.hoisted.get(hoistKey);
    if (already) return already;

    let exprs = this.exprCache.get(nodeId);
    if (!exprs && this.lowering.has(nodeId)) {
      // The node is mid-lowering and something inside its own body is reading
      // one of its outputs. That is legitimate when the output was published
      // up front; anything else is a real cycle.
      const published = this.pending.get(nodeId)?.[portId];
      if (published) return published;
      this.diag.error('ir', 'lower/self-reference', 'A node reads an output it has not published yet.', {
        origin: { nodeId, portId, graphId: this.graph.id },
        hint: 'This is a cycle in the graph. Break it with a variable.',
      });
      return zeroValue(this.resolver.typeOf(nodeId, portId));
    }
    if (!exprs) {
      const node = this.byId.get(nodeId);
      if (!node) return E.null();
      const result = this.lowerNode(node);
      // A node with exec ports reached only by a data edge has no place to put
      // its statements. That is a graph error, not something to paper over.
      if (result.stmts?.length && !this.hoistStack.length) {
        this.diag.error(
          'ir',
          'lower/effect-without-chain',
          `"${this.registry.get(node.type)?.title}" performs work but is not on any execution chain.`,
          {
            origin: { nodeId, graphId: this.graph.id },
            hint: 'Wire its execution input so the order of operations is defined.',
          },
        );
      } else if (result.stmts?.length) {
        this.hoistStack[this.hoistStack.length - 1].push(...result.stmts);
      }
      exprs = this.exprCache.get(nodeId) ?? result.exprs ?? {};
      this.exprCache.set(nodeId, exprs);
    }

    const expr = exprs[portId];
    if (!expr) {
      const type = this.resolver.typeOf(nodeId, portId);
      return zeroValue(type);
    }

    // Hoist when a large expression would otherwise be duplicated.
    const uses = this.useCount.get(hoistKey) ?? 0;
    if (uses > 1 && exprSize(expr) > INLINE_SIZE_LIMIT && this.hoistStack.length) {
      const name = this.freshTemp(portId === 'result' ? 'value' : portId);
      this.hoistStack[this.hoistStack.length - 1].push(S.let_(name, expr.type, expr, false));
      const ref = E.ref(name, expr.type);
      this.hoisted.set(hoistKey, ref);
      return ref;
    }
    return expr;
  }

  private freshTemp(hint: string): string {
    let base = toIdentifier(hint, 'tmp').toLowerCase();
    // Never shadow a function, class or variable the graph declares: the
    // generated code would still compile in some languages and silently mean
    // the wrong thing in others.
    if (this.reserved.has(base)) base = `${base}_result`;
    const n = (this.tempCounters.get(base) ?? 0) + 1;
    this.tempCounters.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  }

  // -- context ---------------------------------------------------------------

  private contextFor(node: GraphNode, def: NodeDefinition): LowerContext {
    const origin: Origin = { nodeId: node.id, graphId: this.graph.id };
    const self = this;

    const inputExpr = (portId: string): IrExpr | undefined => {
      const edge = self.incoming.get(`${node.id}:${portId}`);
      if (edge) return self.outputExpr(edge.from.node, edge.from.port);
      const p = node.inputs.find((x) => x.id === portId);
      if (!p) return undefined;
      if (p.defaultValue !== undefined) return literalExpr(p.defaultValue, p.type);
      return undefined;
    };

    return {
      project: self.project,
      graph: self.graph,
      node,
      language: self.language,
      origin,
      diag: self.diag,

      input(portId) {
        const e = inputExpr(portId);
        if (e) return e;
        const type = self.resolver.typeOf(node.id, portId);
        return zeroValue(type);
      },
      inputOpt: inputExpr,
      connected(portId) {
        return self.incoming.has(`${node.id}:${portId}`);
      },
      variadic(base) {
        const ids = node.inputs
          .filter((p) => basePortId(p.id) === base)
          .map((p) => p.id)
          .sort(variadicOrder);
        const out: IrExpr[] = [];
        for (const id of ids) {
          const e = inputExpr(id);
          // Unconnected trailing slots are simply absent rather than zero-filled.
          if (e) out.push(e);
        }
        return out;
      },

      bindOutput(portId, expr) {
        const slot = self.pending.get(node.id);
        if (slot) slot[portId] = expr;
        else self.exprCache.set(node.id, { ...(self.exprCache.get(node.id) ?? {}), [portId]: expr });
      },
      execBranch(portId) {
        return self.execBranchOf(node, portId);
      },
      hasBranch(portId) {
        return (self.outgoing.get(`${node.id}:${portId}`) ?? []).length > 0;
      },

      portType(portId) {
        return self.resolver.typeOf(node.id, portId);
      },

      prop(name, fallback) {
        const v = node.props[name];
        return (v === undefined || v === null ? fallback : v) as never;
      },
      oneOf(name, allowed, fallback) {
        const v = node.props[name];
        return allowed.includes(v as never) ? (v as typeof fallback) : fallback;
      },
      ident(name, fallback) {
        return toIdentifier(String(node.props[name] ?? fallback), fallback);
      },
      propType(name, fallback) {
        const raw = node.props[name];
        if (typeof raw !== 'string' || !raw.trim()) return fallback;
        try {
          return parseType(raw);
        } catch {
          self.diag.warn('type', 'type/unparsable', `Could not parse type "${raw}"; using ${typeToString(fallback)}.`, {
            origin,
          });
          return fallback;
        }
      },

      temp(hint) {
        return self.freshTemp(hint);
      },
      require(imp) {
        self.imports.push(imp);
      },
      requirePackage(name, version = '*') {
        const existing = self.packages.get(name);
        if (!existing || existing === '*') self.packages.set(name, version);
      },
      emitDecl(decl) {
        self.extraDecls.push(decl);
      },
      requireCapability(cap) {
        self.capabilities.add(cap);
      },

      variable(name) {
        const v = (self.graph.variables ?? []).find((x) => x.name === name || x.id === name);
        return v ? { name: toIdentifier(v.name), type: v.type, scope: v.scope } : undefined;
      },
      error(code, message, hint) {
        self.diag.error('ir', code, message, { origin, hint });
      },
      warn(code, message, hint) {
        self.diag.warn('ir', code, message, { origin, hint });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function variadicOrder(a: string, b: string): number {
  const na = a.includes('#') ? Number(a.slice(a.indexOf('#') + 1)) : 0;
  const nb = b.includes('#') ? Number(b.slice(b.indexOf('#') + 1)) : 0;
  return na - nb;
}

/** A JSON literal from a port default or variable initial value. */
export function literalExpr(value: unknown, type: TypeRef): IrExpr | undefined {
  if (value === undefined) return undefined;
  if (value === null) return E.null(type);
  switch (typeof value) {
    case 'boolean':
      return E.bool(value);
    case 'number':
      return type.kind === 'primitive' && (type.name === 'f64' || type.name === 'f32')
        ? E.float(value)
        : Number.isInteger(value)
          ? E.int(value, type.kind === 'primitive' ? type : T.i64)
          : E.float(value);
    case 'string':
      return E.str(value);
    default:
      if (Array.isArray(value)) {
        const item = type.kind === 'list' ? type.item : T.any;
        return E.array(
          value.map((v) => literalExpr(v, item) ?? E.null(item)),
          item,
        );
      }
      if (typeof value === 'object') {
        const kt = type.kind === 'map' ? type.key : T.string;
        const vt = type.kind === 'map' ? type.value : T.any;
        return E.mapLit(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
            key: E.str(k),
            value: literalExpr(v, vt) ?? E.null(vt),
          })),
          kt,
          vt,
        );
      }
      return undefined;
  }
}

/**
 * The value used when an input is left unconnected. Every backend can emit
 * these, and validation has already warned that it is happening.
 */
export function zeroValue(type: TypeRef): IrExpr {
  switch (type.kind) {
    case 'primitive':
      switch (type.name) {
        case 'bool':
          return E.bool(false);
        case 'string':
          return E.str('');
        case 'char':
          return E.char(' ');
        case 'f32':
        case 'f64':
          return E.float(0);
        case 'bytes':
          return E.array([], T.i32);
        default:
          return E.int(0, type);
      }
    case 'list':
      return E.array([], type.item);
    case 'set':
      return E.builtin('set_new', [], type);
    case 'map':
      return E.mapLit([], type.key, type.value);
    case 'tuple':
      return E.tuple(type.items.map(zeroValue));
    case 'option':
      return E.null(type);
    case 'void':
      return E.null(T.void);
    case 'function':
      return E.lambda(
        type.params.map((p, i) => ({ name: `a${i}`, type: p })),
        zeroValue(type.returns),
        type.returns,
      );
    default:
      return E.null(type);
  }
}

function exprSize(e: IrExpr): number {
  let n = 1;
  switch (e.k) {
    case 'binary':
      n += exprSize(e.left) + exprSize(e.right);
      break;
    case 'unary':
      n += exprSize(e.operand);
      break;
    case 'call':
      n += exprSize(e.callee) + e.args.reduce((s, a) => s + exprSize(a), 0);
      break;
    case 'method':
      n += exprSize(e.target) + e.args.reduce((s, a) => s + exprSize(a), 0);
      break;
    case 'builtin':
    case 'new':
      n += e.args.reduce((s, a) => s + exprSize(a), 0);
      break;
    case 'array':
    case 'tupleLit':
      n += e.items.reduce((s, a) => s + exprSize(a), 0);
      break;
    case 'mapLit':
      n += e.entries.reduce((s, en) => s + exprSize(en.key) + exprSize(en.value), 0);
      break;
    case 'member':
      n += exprSize(e.target);
      break;
    case 'index':
      n += exprSize(e.target) + exprSize(e.index);
      break;
    case 'ternary':
      n += exprSize(e.cond) + exprSize(e.then) + exprSize(e.else);
      break;
    case 'cast':
    case 'await':
      n += exprSize(e.expr);
      break;
    case 'lambda':
      n += 4;
      break;
    default:
      break;
  }
  return n;
}

export function dedupeImports(imports: IrImport[]): IrImport[] {
  const merged = new Map<string, IrImport>();
  for (const imp of imports) {
    const k = `${imp.source}|${imp.target}|${imp.alias ?? ''}`;
    const existing = merged.get(k);
    if (!existing) {
      merged.set(k, { ...imp, symbols: imp.symbols ? [...imp.symbols] : undefined });
      continue;
    }
    if (imp.symbols) {
      existing.symbols ??= [];
      for (const s of imp.symbols) {
        if (!existing.symbols.some((x) => x.name === s.name && x.alias === s.alias)) existing.symbols.push(s);
      }
    }
    existing.wildcard ||= imp.wildcard;
  }
  const out = [...merged.values()];
  for (const imp of out) imp.symbols?.sort((a, b) => a.name.localeCompare(b.name));
  return out.sort(
    (a, b) => rank(a.source) - rank(b.source) || a.target.localeCompare(b.target),
  );
}

function rank(source: IrImport['source']): number {
  return source === 'stdlib' ? 0 : source === 'package' ? 1 : 2;
}

export function stripExtension(path: string): string {
  const i = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return i > slash ? path.slice(0, i) : path;
}

/** Dotted module name for a file, respecting the project's namespace. */
export function moduleNameFor(file: ProjectFile, project: Project): string {
  const rel = stripExtension(file.path)
    .replace(/^src\//, '')
    .replace(/^source\//, '');
  const dotted = rel.split('/').filter(Boolean).map((s) => toIdentifier(s)).join('.');
  return project.namespace ? `${project.namespace}.${dotted}` : dotted;
}
