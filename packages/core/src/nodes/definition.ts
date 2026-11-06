/**
 * Visual node definitions.
 *
 * A node type is data (ports, properties, docs) plus one function that lowers
 * an instance to IR. Nothing about the built-in catalogue is privileged - a
 * plugin registers nodes through exactly this interface, which is why adding
 * new visual vocabulary does not require touching the compiler.
 */

import type {
  Capability,
  IrDecl,
  IrExpr,
  IrField,
  IrFunction,
  IrImport,
  IrStmt,
  Origin,
} from '../ir/ir.ts';
import type { TypeRef } from '../types/types.ts';
import type { DiagnosticBag } from '../diagnostics.ts';
import type { GraphNode, GraphStyle, LogicGraph, Project } from '../model/project.ts';

export interface PortSpec {
  id: string;
  name: string;
  /** Textual form (`List<T>`) or a built TypeRef. Text is parsed once at load. */
  type: TypeRef | string;
  /** Literal used when the port is unconnected. */
  default?: unknown;
  doc?: string;
  /**
   * The port may be duplicated by the user. Extra instances get ids
   * `${id}#1`, `${id}#2`, ... and are collected by `ctx.variadic(id)`.
   */
  variadic?: boolean;
  /** Hide unless the node is expanded; keeps common cases uncluttered. */
  advanced?: boolean;
  /**
   * A value that only exists inside this node's own execution branch: a
   * function's parameters, a loop's current item, a catch clause's error.
   *
   * These are published before the branch is lowered (see
   * `LowerContext.bindOutput`), so a wire from one back into the node that
   * declares it is ordinary nesting, not a cycle. Validation needs to know
   * that, or every loop body would be reported as a data cycle.
   */
  bound?: boolean;
}

export type PropKind =
  | 'string'
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'select'
  | 'type'
  | 'identifier'
  | 'code'
  | 'json'
  | 'path'
  | 'color'
  | 'ports'
  | 'variable'
  | 'symbol';

export interface PropSpec {
  name: string;
  label: string;
  kind: PropKind;
  default?: unknown;
  options?: { value: string; label: string }[];
  doc?: string;
  /** For `code`: which language the editor should highlight. */
  language?: string;
  /** Show this property only when another property has one of these values. */
  visibleWhen?: { prop: string; equals: unknown[] };
  placeholder?: string;
  min?: number;
  max?: number;
}

/**
 * A method or field contributed to a class declared elsewhere in the graph.
 * Class members are separate nodes so a method body can have its own execution
 * chain; the module assembler merges them into the owning `IrClass`.
 */
export interface ClassMemberContribution {
  className: string;
  method?: IrFunction;
  field?: IrField;
  isCtor?: boolean;
}

export interface LowerResult {
  /** Statements this node contributes, in order, at its place in the exec chain. */
  stmts?: IrStmt[];
  /** Methods/fields to merge into a class declared by another node. */
  members?: ClassMemberContribution[];
  /** Expression for each data output port id. */
  exprs?: Record<string, IrExpr>;
  /** Module-level declarations (helper functions, classes). */
  decls?: IrDecl[];
  /** Imports the node needs. */
  imports?: IrImport[];
  /**
   * When set, the lowering engine stops walking the exec chain after this node
   * (`return`, `break`, `throw`). Prevents unreachable code being emitted.
   */
  terminates?: boolean;
}

/** Widens a literal fallback back to its base type. See `LowerContext.prop`. */
export type Widen<X> = X extends string
  ? string
  : X extends number
    ? number
    : X extends boolean
      ? boolean
      : X;

export interface LowerContext {
  readonly project: Project;
  readonly graph: LogicGraph;
  readonly node: GraphNode;
  readonly language: string;
  readonly origin: Origin;
  readonly diag: DiagnosticBag;

  /** Value flowing into a data input, or its default literal. */
  input(portId: string): IrExpr;
  /** Same, but undefined when nothing is connected and no default exists. */
  inputOpt(portId: string): IrExpr | undefined;
  /** All instances of a variadic input, base port first. */
  variadic(basePortId: string): IrExpr[];
  /** True when something is wired to this input. */
  connected(portId: string): boolean;

  /**
   * Publish one of this node's data outputs before lowering anything that
   * reads it.
   *
   * A Function node's body refers to the Function node's own parameter ports.
   * Without this, lowering the body would re-enter the node that is currently
   * being lowered and be reported as a cycle. Any node whose execution branch
   * can see its own outputs - functions, methods, loops, catch handlers,
   * lambdas, event handlers - binds them first and then calls `execBranch`.
   */
  bindOutput(portId: string, expr: IrExpr): void;

  /** Lower everything downstream of an exec output into a statement list. */
  execBranch(portId: string): IrStmt[];
  /** True when an exec output has anything wired to it. */
  hasBranch(portId: string): boolean;

  /** Resolved type of a port after unification against connected edges. */
  portType(portId: string): TypeRef;

  /**
   * Typed property read with a fallback. The fallback fixes the type but not
   * the *value*: props come from project JSON, so a `'sum'` fallback still
   * yields `string`, not the literal `'sum'`. Widening here is what lets a
   * node switch over the other modes it accepts.
   */
  prop<X>(name: string, fallback: X): Widen<X>;
  /**
   * Property read constrained to a set of accepted values. Anything else —
   * a hand-edited project file, a stale value left by an older node version —
   * yields the fallback instead of reaching the IR unchecked.
   */
  oneOf<X extends string>(name: string, allowed: readonly X[], fallback: X): X;
  /** Property read as a sanitised identifier valid in every target language. */
  ident(name: string, fallback: string): string;
  /** Property read as a TypeRef (`kind: 'type'` properties). */
  propType(name: string, fallback: TypeRef): TypeRef;

  /** A unique local name derived from a hint. */
  temp(hint: string): string;
  /** Register an import for the containing module. */
  require(imp: IrImport): void;
  /** Register an external package dependency (manifest entry only, not installed). */
  requirePackage(name: string, version?: string): void;
  /** Add a module-level declaration. */
  emitDecl(decl: IrDecl): void;
  /** Declare that this node needs a capability, for the sandbox pre-check. */
  requireCapability(cap: Capability): void;

  /** Look up a graph variable by name. */
  variable(name: string): { name: string; type: TypeRef; scope: string } | undefined;
  /** Report a problem anchored to this node. */
  error(code: string, message: string, hint?: string): void;
  warn(code: string, message: string, hint?: string): void;
}

export interface NodeDefinition {
  /** Namespaced id, e.g. `control/if`. Must be globally unique. */
  type: string;
  category: string;
  title: string;
  description: string;
  /** Search terms for the palette and command palette. */
  keywords?: string[];
  /** Paradigms this node belongs to; empty means "all". */
  styles?: GraphStyle[];
  /** Restrict to certain languages; empty means "all". */
  languages?: string[];

  inputs: PortSpec[];
  outputs: PortSpec[];
  props?: PropSpec[];

  /**
   * Recompute ports from the node's properties. Nodes whose shape depends on
   * configuration (a function call's arguments, a class's fields, a format
   * string's placeholders) implement this; everything else omits it.
   */
  ports?(props: Record<string, unknown>, project: Project): { inputs: PortSpec[]; outputs: PortSpec[] };

  /** Capabilities every instance needs, regardless of configuration. */
  caps?: Capability[];

  /**
   * Nodes that declare their own scope for the exec chain (function bodies,
   * class bodies, event handlers). The engine will not thread them into the
   * enclosing statement list.
   */
  root?: boolean;

  /** Pure nodes have no exec ports and may be inlined at their use site. */
  pure?: boolean;

  lower(ctx: LowerContext): LowerResult;

  /** Extra per-instance validation beyond port typing. */
  validate?(node: GraphNode, project: Project, diag: DiagnosticBag): void;

  /** Colour hint for the editor; falls back to a per-category colour. */
  color?: string;
  icon?: string;
  /** Documentation shown in the properties panel and generated docs. */
  doc?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class NodeRegistry {
  private readonly byType = new Map<string, NodeDefinition>();
  private readonly origin = new Map<string, string>();

  register(def: NodeDefinition, source = 'builtin'): void {
    const existing = this.byType.get(def.type);
    if (existing) {
      throw new Error(
        `node type "${def.type}" is already registered by ${this.origin.get(def.type)}; ` +
          `${source} must choose a different id`,
      );
    }
    this.byType.set(def.type, def);
    this.origin.set(def.type, source);
  }

  registerAll(defs: NodeDefinition[], source = 'builtin'): void {
    for (const d of defs) this.register(d, source);
  }

  get(type: string): NodeDefinition | undefined {
    return this.byType.get(type);
  }

  has(type: string): boolean {
    return this.byType.has(type);
  }

  all(): NodeDefinition[] {
    return [...this.byType.values()];
  }

  sourceOf(type: string): string | undefined {
    return this.origin.get(type);
  }

  /** Node types available for a given language and paradigm. */
  available(language: string, style?: GraphStyle): NodeDefinition[] {
    return this.all().filter((d) => {
      if (d.languages?.length && !d.languages.includes(language)) return false;
      if (style && d.styles?.length && !d.styles.includes(style)) return false;
      return true;
    });
  }

  categories(): string[] {
    return [...new Set(this.all().map((d) => d.category))].sort();
  }

  search(query: string): NodeDefinition[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.all();
    const score = (d: NodeDefinition): number => {
      const hay = [d.type, d.title, d.category, ...(d.keywords ?? [])].join(' ').toLowerCase();
      if (d.title.toLowerCase() === q) return 100;
      if (d.type.toLowerCase().includes(q)) return 60;
      if (d.title.toLowerCase().includes(q)) return 50;
      if (hay.includes(q)) return 20;
      return d.description.toLowerCase().includes(q) ? 5 : 0;
    };
    return this.all()
      .map((d) => ({ d, s: score(d) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.d);
  }
}

// ---------------------------------------------------------------------------
// Helpers for definition authors
// ---------------------------------------------------------------------------

export const EXEC_IN: PortSpec = { id: 'in', name: '', type: 'Exec' };
export const EXEC_OUT: PortSpec = { id: 'out', name: '', type: 'Exec' };

export function execIn(id = 'in', name = ''): PortSpec {
  return { id, name, type: 'Exec' };
}

export function execOut(id = 'out', name = ''): PortSpec {
  return { id, name, type: 'Exec' };
}

export function port(id: string, name: string, type: TypeRef | string, extra: Partial<PortSpec> = {}): PortSpec {
  return { id, name, type, ...extra };
}

/** Turn arbitrary user text into an identifier that is legal in all backends. */
export function toIdentifier(raw: string, fallback = 'value'): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
