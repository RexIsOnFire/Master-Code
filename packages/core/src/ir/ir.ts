/**
 * Master Code intermediate representation.
 *
 * The IR is a language-neutral abstract program: modules containing
 * declarations containing statements containing expressions. It is the only
 * thing a language backend ever sees, which is what lets one visual project
 * target several languages.
 *
 * Two properties are load-bearing:
 *
 *  1. Every node may carry an `origin`, pointing back at the visual node (and
 *     port) that produced it. Compiler diagnostics are mapped through this so
 *     an error in generated Rust can highlight the box the user drew.
 *  2. Every node may declare `caps` - the runtime capabilities it needs
 *     (filesystem, network, subprocess...). The sandbox refuses to run a
 *     program whose IR requires a capability the project has not granted, so
 *     the check happens before any code is compiled, let alone executed.
 */

import type { TypeRef } from '../types/types.ts';

/**
 * `net` is calling out; `net.listen` is accepting connections. They are
 * separated because they are different risks: a program that can reach the
 * network is one thing, a program that opens a port on the host is another,
 * and a reviewer should not have to read the graph to tell which this is.
 */
export type Capability =
  | 'fs.read'
  | 'fs.write'
  | 'net'
  | 'net.listen'
  | 'process'
  | 'env'
  | 'time'
  | 'random'
  | 'stdio';

export interface Origin {
  /** Logic-graph node id. */
  nodeId: string;
  /** Port id, when the construct came from a specific port. */
  portId?: string;
  /** Graph id, for projects with several graphs. */
  graphId?: string;
}

export interface IrBase {
  origin?: Origin;
  /** Free-form comment emitted above the construct where the language allows it. */
  comment?: string;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type IrLiteralValue =
  | { t: 'bool'; v: boolean }
  | { t: 'int'; v: number | string }
  | { t: 'float'; v: number }
  | { t: 'string'; v: string }
  | { t: 'char'; v: string }
  | { t: 'null' };

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%' | '**'
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | '&&' | '||'
  | '&' | '|' | '^' | '<<' | '>>';

export type UnaryOp = '-' | '!' | '~';

/**
 * A keyword argument (`sep=";"`). Only a library call produces these, and the
 * nodes that do are limited to languages with keyword arguments; a backend
 * without them never sees one.
 */
export interface IrKwarg {
  name: string;
  value: IrExpr;
}

export type IrExpr = IrBase &
  (
    | { k: 'lit'; value: IrLiteralValue; type: TypeRef }
    /** Reference to a local, parameter, field (via `self`), or module-level symbol. */
    | { k: 'ref'; name: string; type: TypeRef }
    /**
     * Reference to a symbol imported from another file. `from` is a file id.
     * `exact` marks a name spelled by an external library (`APIHarnessV2`,
     * `read_csv`): backends emit it as is instead of re-casing it to their own
     * conventions, which would name something that does not exist.
     */
    | { k: 'symbol'; name: string; from?: string; type: TypeRef; exact?: boolean }
    | { k: 'self'; type: TypeRef }
    | { k: 'binary'; op: BinaryOp; left: IrExpr; right: IrExpr; type: TypeRef }
    | { k: 'unary'; op: UnaryOp; operand: IrExpr; type: TypeRef }
    | { k: 'call'; callee: IrExpr; args: IrExpr[]; kwargs?: IrKwarg[]; type: TypeRef; caps?: Capability[] }
    | { k: 'method'; target: IrExpr; name: string; args: IrExpr[]; kwargs?: IrKwarg[]; exact?: boolean; type: TypeRef; caps?: Capability[] }
    | { k: 'member'; target: IrExpr; name: string; type: TypeRef }
    | { k: 'index'; target: IrExpr; index: IrExpr; type: TypeRef }
    | { k: 'new'; className: string; args: IrExpr[]; type: TypeRef }
    | { k: 'array'; items: IrExpr[]; type: TypeRef }
    | { k: 'mapLit'; entries: { key: IrExpr; value: IrExpr }[]; type: TypeRef }
    | { k: 'tupleLit'; items: IrExpr[]; type: TypeRef }
    | { k: 'lambda'; params: IrParam[]; body: IrStmt[] | IrExpr; type: TypeRef; isAsync?: boolean }
    | { k: 'ternary'; cond: IrExpr; then: IrExpr; else: IrExpr; type: TypeRef }
    | { k: 'cast'; expr: IrExpr; to: TypeRef; type: TypeRef }
    | { k: 'await'; expr: IrExpr; type: TypeRef }
    /**
     * A builtin operation the backends implement idiomatically rather than by
     * name (`len`, `print`, `to_string`, `http.get`, ...). This is how the IR
     * stays language-neutral without inventing a standard library.
     */
    | { k: 'builtin'; op: string; args: IrExpr[]; type: TypeRef; caps?: Capability[] }
    /**
     * Verbatim target-language source. Produced by Custom Code nodes and by
     * the importer for constructs it could not model. `lang` pins it to one
     * backend; generation fails loudly if the target differs.
     */
    | { k: 'raw'; lang: string; code: string; type: TypeRef; caps?: Capability[] }
  );

export interface IrParam {
  name: string;
  type: TypeRef;
  default?: IrExpr;
  /** Variadic parameter (`*args`, `params T[]`, `...rest`). */
  rest?: boolean;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type IrStmt = IrBase &
  (
    | { k: 'let'; name: string; type: TypeRef; init?: IrExpr; mutable?: boolean }
    | { k: 'assign'; target: IrExpr; value: IrExpr; op?: BinaryOp }
    | { k: 'expr'; expr: IrExpr }
    | { k: 'if'; cond: IrExpr; then: IrStmt[]; else?: IrStmt[]; elseIf?: { cond: IrExpr; body: IrStmt[] }[] }
    | { k: 'while'; cond: IrExpr; body: IrStmt[] }
    | { k: 'doWhile'; cond: IrExpr; body: IrStmt[] }
    | { k: 'forRange'; varName: string; start: IrExpr; end: IrExpr; step?: IrExpr; inclusive?: boolean; body: IrStmt[] }
    | { k: 'forEach'; varName: string; itemType: TypeRef; iterable: IrExpr; body: IrStmt[]; indexName?: string }
    | { k: 'switch'; subject: IrExpr; cases: { match: IrExpr[]; body: IrStmt[] }[]; default?: IrStmt[] }
    | { k: 'return'; value?: IrExpr }
    | { k: 'break' }
    | { k: 'continue' }
    | { k: 'throw'; value: IrExpr }
    | {
        k: 'try';
        body: IrStmt[];
        catches: { errType?: TypeRef; varName: string; body: IrStmt[] }[];
        finally?: IrStmt[];
      }
    | { k: 'block'; body: IrStmt[] }
    | { k: 'raw'; lang: string; code: string; caps?: Capability[] }
    /** A pure marker; backends emit it as a comment. Useful for traceability. */
    | { k: 'note'; text: string }
  );

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export type Visibility = 'public' | 'private' | 'internal';

/**
 * Annotations, decorators or attributes, written as the target language spells
 * them but without the leading sigil: `Composable`, `Entity(tableName = "note")`.
 *
 * They are framework vocabulary rather than program structure, so the IR does
 * not interpret them. A backend whose language has them declares the
 * `annotations` feature and prints each one; every other backend refuses the
 * graph up front, naming the node, rather than dropping them.
 */
export interface Annotated {
  annotations?: string[];
}

/** Runtime form of `Visibility`, for validating a value read from a project file. */
export const VISIBILITIES = ['public', 'private', 'internal'] as const satisfies readonly Visibility[];

export interface IrFunction extends IrBase, Annotated {
  k: 'function';
  name: string;
  params: IrParam[];
  returns: TypeRef;
  body: IrStmt[];
  isAsync?: boolean;
  isStatic?: boolean;
  visibility?: Visibility;
  /** Generic parameters, by name; correspond to `{kind:'var'}` types in signatures. */
  generics?: string[];
  doc?: string;
  /** Marks the program entry point for the containing module. */
  isEntry?: boolean;
  /** Declared exception types, for languages with checked exceptions. */
  throws?: TypeRef[];
  /**
   * Replaces a member inherited from a supertype. Languages that require the
   * keyword (Kotlin, C#) cannot infer it when the supertype lives in a library,
   * so the graph states it.
   */
  isOverride?: boolean;
  /** A test case a test runner should discover; set by the Test Case node, never inferred from a name. */
  isTest?: boolean;
}

export interface IrField extends IrBase, Annotated {
  k: 'field';
  name: string;
  type: TypeRef;
  init?: IrExpr;
  visibility?: Visibility;
  isStatic?: boolean;
  readonly?: boolean;
  doc?: string;
}

export interface IrClass extends IrBase, Annotated {
  k: 'class';
  name: string;
  /** `struct` maps to value types where the language distinguishes them. */
  shape?: 'class' | 'struct' | 'record';
  extends?: TypeRef;
  implements?: TypeRef[];
  generics?: string[];
  fields: IrField[];
  methods: IrFunction[];
  ctor?: IrFunction;
  visibility?: Visibility;
  isAbstract?: boolean;
  doc?: string;
}

export interface IrInterface extends IrBase, Annotated {
  k: 'interface';
  name: string;
  generics?: string[];
  extends?: TypeRef[];
  /** Method signatures; `body` is ignored (kept for default-method support). */
  methods: IrFunction[];
  fields?: IrField[];
  visibility?: Visibility;
  doc?: string;
}

export interface IrEnum extends IrBase, Annotated {
  k: 'enum';
  name: string;
  /**
   * Simple enums have no payload; tagged unions do (mapped to sealed types /
   * unions). A backend renders payloads only if it declares `taggedUnions`.
   */
  variants: { name: string; value?: IrLiteralValue; payload?: { name: string; type: TypeRef }[] }[];
  visibility?: Visibility;
  doc?: string;
}

export interface IrTypeAlias extends IrBase {
  k: 'typeAlias';
  name: string;
  target: TypeRef;
  generics?: string[];
  visibility?: Visibility;
  doc?: string;
}

export interface IrGlobal extends IrBase {
  k: 'global';
  name: string;
  type: TypeRef;
  init?: IrExpr;
  constant?: boolean;
  visibility?: Visibility;
  doc?: string;
}

export interface IrRawDecl extends IrBase {
  k: 'rawDecl';
  lang: string;
  code: string;
  /** Symbols this raw block defines, so the file graph can still resolve refs. */
  provides?: string[];
  caps?: Capability[];
}

export type IrDecl =
  | IrFunction
  | IrClass
  | IrInterface
  | IrEnum
  | IrTypeAlias
  | IrGlobal
  | IrRawDecl;

// ---------------------------------------------------------------------------
// Modules and programs
// ---------------------------------------------------------------------------

export interface IrImport {
  /**
   * Where the symbols come from.
   *  - `file`   another file in this project, by file id
   *  - `package` an external dependency, by catalog/package name
   *  - `stdlib`  the target language's standard library
   */
  source: 'file' | 'package' | 'stdlib';
  /** File id, package name, or stdlib module name. */
  target: string;
  /** Named symbols to import. Empty means "import the module itself". */
  symbols?: { name: string; alias?: string }[];
  /** Alias for the module itself (`import numpy as np`). */
  alias?: string;
  /** Star import; backends that disallow it will expand or reject. */
  wildcard?: boolean;
}

export interface IrModule extends IrBase {
  /** Stable id; matches the owning ProjectFile id. */
  id: string;
  /** Logical module name (`models.user`, `com.acme.models.User`, ...). */
  name: string;
  /**
   * Path relative to the source root, without extension
   * (`models/user`). The backend adds the extension and any language-specific
   * root (`src/`, `src/main/java/`, ...).
   */
  path: string;
  imports: IrImport[];
  decls: IrDecl[];
  /** Statements executed at module load (script bodies, `if __name__ == ...`). */
  main?: IrStmt[];
  doc?: string;
  /** Symbols visible to other modules. Empty means "everything public". */
  exports?: string[];
}

export interface IrProgram {
  name: string;
  /** Language id this program was lowered for; a project may hold several. */
  language: string;
  modules: IrModule[];
  /** Module id holding the entry point. */
  entryModule?: string;
  entrySymbol?: string;
  /** External dependencies referenced anywhere in the program. */
  dependencies: { name: string; version: string; language: string }[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

export interface IrVisitor {
  expr?(e: IrExpr): void;
  stmt?(s: IrStmt): void;
  decl?(d: IrDecl): void;
  module?(m: IrModule): void;
}

export function walkExpr(e: IrExpr | undefined, v: IrVisitor): void {
  if (!e) return;
  v.expr?.(e);
  switch (e.k) {
    case 'binary':
      walkExpr(e.left, v);
      walkExpr(e.right, v);
      break;
    case 'unary':
      walkExpr(e.operand, v);
      break;
    case 'call':
      walkExpr(e.callee, v);
      e.args.forEach((a) => walkExpr(a, v));
      e.kwargs?.forEach((a) => walkExpr(a.value, v));
      break;
    case 'method':
      walkExpr(e.target, v);
      e.args.forEach((a) => walkExpr(a, v));
      e.kwargs?.forEach((a) => walkExpr(a.value, v));
      break;
    case 'member':
      walkExpr(e.target, v);
      break;
    case 'index':
      walkExpr(e.target, v);
      walkExpr(e.index, v);
      break;
    case 'new':
    case 'array':
    case 'tupleLit':
    case 'builtin':
      ('args' in e ? e.args : e.items).forEach((a) => walkExpr(a, v));
      break;
    case 'mapLit':
      e.entries.forEach((en) => {
        walkExpr(en.key, v);
        walkExpr(en.value, v);
      });
      break;
    case 'lambda':
      e.params.forEach((p) => walkExpr(p.default, v));
      if (Array.isArray(e.body)) e.body.forEach((s) => walkStmt(s, v));
      else walkExpr(e.body, v);
      break;
    case 'ternary':
      walkExpr(e.cond, v);
      walkExpr(e.then, v);
      walkExpr(e.else, v);
      break;
    case 'cast':
    case 'await':
      walkExpr(e.expr, v);
      break;
    default:
      break;
  }
}

export function walkStmt(s: IrStmt | undefined, v: IrVisitor): void {
  if (!s) return;
  v.stmt?.(s);
  switch (s.k) {
    case 'let':
      walkExpr(s.init, v);
      break;
    case 'assign':
      walkExpr(s.target, v);
      walkExpr(s.value, v);
      break;
    case 'expr':
      walkExpr(s.expr, v);
      break;
    case 'if':
      walkExpr(s.cond, v);
      s.then.forEach((x) => walkStmt(x, v));
      s.elseIf?.forEach((b) => {
        walkExpr(b.cond, v);
        b.body.forEach((x) => walkStmt(x, v));
      });
      s.else?.forEach((x) => walkStmt(x, v));
      break;
    case 'while':
    case 'doWhile':
      walkExpr(s.cond, v);
      s.body.forEach((x) => walkStmt(x, v));
      break;
    case 'forRange':
      walkExpr(s.start, v);
      walkExpr(s.end, v);
      walkExpr(s.step, v);
      s.body.forEach((x) => walkStmt(x, v));
      break;
    case 'forEach':
      walkExpr(s.iterable, v);
      s.body.forEach((x) => walkStmt(x, v));
      break;
    case 'switch':
      walkExpr(s.subject, v);
      s.cases.forEach((c) => {
        c.match.forEach((m) => walkExpr(m, v));
        c.body.forEach((x) => walkStmt(x, v));
      });
      s.default?.forEach((x) => walkStmt(x, v));
      break;
    case 'return':
      walkExpr(s.value, v);
      break;
    case 'throw':
      walkExpr(s.value, v);
      break;
    case 'try':
      s.body.forEach((x) => walkStmt(x, v));
      s.catches.forEach((c) => c.body.forEach((x) => walkStmt(x, v)));
      s.finally?.forEach((x) => walkStmt(x, v));
      break;
    case 'block':
      s.body.forEach((x) => walkStmt(x, v));
      break;
    default:
      break;
  }
}

export function walkDecl(d: IrDecl, v: IrVisitor): void {
  v.decl?.(d);
  switch (d.k) {
    case 'function':
      d.params.forEach((p) => walkExpr(p.default, v));
      d.body.forEach((s) => walkStmt(s, v));
      break;
    case 'class':
      d.fields.forEach((f) => walkExpr(f.init, v));
      if (d.ctor) walkDecl(d.ctor, v);
      d.methods.forEach((m) => walkDecl(m, v));
      break;
    case 'interface':
      d.methods.forEach((m) => walkDecl(m, v));
      break;
    case 'global':
      walkExpr(d.init, v);
      break;
    default:
      break;
  }
}

export function walkModule(m: IrModule, v: IrVisitor): void {
  v.module?.(m);
  m.decls.forEach((d) => walkDecl(d, v));
  m.main?.forEach((s) => walkStmt(s, v));
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

/** Every capability the program requires, computed from the IR. */
export function collectCapabilities(program: IrProgram): Set<Capability> {
  const caps = new Set<Capability>();
  const add = (list?: Capability[]) => list?.forEach((c) => caps.add(c));
  for (const m of program.modules) {
    walkModule(m, {
      expr: (e) => {
        if (e.k === 'call' || e.k === 'method' || e.k === 'builtin' || e.k === 'raw') add(e.caps);
      },
      stmt: (s) => {
        if (s.k === 'raw') add(s.caps);
      },
      decl: (d) => {
        if (d.k === 'rawDecl') add(d.caps);
      },
    });
  }
  return caps;
}

/** All `raw` fragments, with the language they are pinned to. */
export function collectRawFragments(program: IrProgram): { lang: string; code: string; origin?: Origin }[] {
  const out: { lang: string; code: string; origin?: Origin }[] = [];
  for (const m of program.modules) {
    walkModule(m, {
      expr: (e) => {
        if (e.k === 'raw') out.push({ lang: e.lang, code: e.code, origin: e.origin });
      },
      stmt: (s) => {
        if (s.k === 'raw') out.push({ lang: s.lang, code: s.code, origin: s.origin });
      },
      decl: (d) => {
        if (d.k === 'rawDecl') out.push({ lang: d.lang, code: d.code, origin: d.origin });
      },
    });
  }
  return out;
}

/** Type of an expression, without re-deriving it. */
export function exprType(e: IrExpr): TypeRef {
  return e.type;
}
