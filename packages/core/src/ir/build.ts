/**
 * Terse constructors for IR nodes.
 *
 * Templates, importers and tests build IR by hand; the lowering pass builds it
 * from graphs. Both go through here so the shapes stay consistent.
 */

import type {
  BinaryOp,
  Capability,
  IrDecl,
  IrExpr,
  IrFunction,
  IrImport,
  IrModule,
  IrParam,
  IrStmt,
  Origin,
  UnaryOp,
} from './ir.ts';
import type { TypeRef } from '../types/types.ts';
import { T, numericJoin } from '../types/types.ts';

export const E = {
  bool: (v: boolean): IrExpr => ({ k: 'lit', value: { t: 'bool', v }, type: T.bool }),
  int: (v: number | string, type: TypeRef = T.i64): IrExpr => ({ k: 'lit', value: { t: 'int', v }, type }),
  float: (v: number): IrExpr => ({ k: 'lit', value: { t: 'float', v }, type: T.f64 }),
  str: (v: string): IrExpr => ({ k: 'lit', value: { t: 'string', v }, type: T.string }),
  char: (v: string): IrExpr => ({ k: 'lit', value: { t: 'char', v }, type: T.char }),
  null: (type: TypeRef = T.option(T.any)): IrExpr => ({ k: 'lit', value: { t: 'null' }, type }),

  ref: (name: string, type: TypeRef): IrExpr => ({ k: 'ref', name, type }),
  symbol: (name: string, type: TypeRef, from?: string): IrExpr => ({ k: 'symbol', name, from, type }),
  self: (type: TypeRef): IrExpr => ({ k: 'self', type }),

  bin: (op: BinaryOp, left: IrExpr, right: IrExpr, type?: TypeRef): IrExpr => ({
    k: 'binary',
    op,
    left,
    right,
    type: type ?? inferBinary(op, left.type, right.type),
  }),
  un: (op: UnaryOp, operand: IrExpr, type?: TypeRef): IrExpr => ({
    k: 'unary',
    op,
    operand,
    type: type ?? (op === '!' ? T.bool : operand.type),
  }),

  call: (callee: IrExpr, args: IrExpr[], type: TypeRef, caps?: Capability[]): IrExpr => ({
    k: 'call',
    callee,
    args,
    type,
    caps,
  }),
  method: (target: IrExpr, name: string, args: IrExpr[], type: TypeRef, caps?: Capability[]): IrExpr => ({
    k: 'method',
    target,
    name,
    args,
    type,
    caps,
  }),
  member: (target: IrExpr, name: string, type: TypeRef): IrExpr => ({ k: 'member', target, name, type }),
  index: (target: IrExpr, index: IrExpr, type: TypeRef): IrExpr => ({ k: 'index', target, index, type }),
  new_: (className: string, args: IrExpr[], type?: TypeRef): IrExpr => ({
    k: 'new',
    className,
    args,
    type: type ?? T.named(className),
  }),
  array: (items: IrExpr[], item?: TypeRef): IrExpr => ({
    k: 'array',
    items,
    type: T.list(item ?? items[0]?.type ?? T.any),
  }),
  mapLit: (entries: { key: IrExpr; value: IrExpr }[], key?: TypeRef, value?: TypeRef): IrExpr => ({
    k: 'mapLit',
    entries,
    type: T.map(key ?? entries[0]?.key.type ?? T.string, value ?? entries[0]?.value.type ?? T.any),
  }),
  tuple: (items: IrExpr[]): IrExpr => ({ k: 'tupleLit', items, type: T.tuple(...items.map((i) => i.type)) }),
  lambda: (params: IrParam[], body: IrStmt[] | IrExpr, returns: TypeRef, isAsync?: boolean): IrExpr => ({
    k: 'lambda',
    params,
    body,
    isAsync,
    type: T.fn(params.map((p) => p.type), returns),
  }),
  ternary: (cond: IrExpr, then: IrExpr, else_: IrExpr, type?: TypeRef): IrExpr => ({
    k: 'ternary',
    cond,
    then,
    else: else_,
    type: type ?? then.type,
  }),
  cast: (expr: IrExpr, to: TypeRef): IrExpr => ({ k: 'cast', expr, to, type: to }),
  await_: (expr: IrExpr, type?: TypeRef): IrExpr => ({
    k: 'await',
    expr,
    type: type ?? (expr.type.kind === 'future' ? expr.type.inner : expr.type),
  }),
  builtin: (op: string, args: IrExpr[], type: TypeRef, caps?: Capability[]): IrExpr => ({
    k: 'builtin',
    op,
    args,
    type,
    caps,
  }),
  raw: (lang: string, code: string, type: TypeRef = T.any, caps?: Capability[]): IrExpr => ({
    k: 'raw',
    lang,
    code,
    type,
    caps,
  }),
};

export const S = {
  let_: (name: string, type: TypeRef, init?: IrExpr, mutable = true): IrStmt => ({
    k: 'let',
    name,
    type,
    init,
    mutable,
  }),
  assign: (target: IrExpr, value: IrExpr, op?: BinaryOp): IrStmt => ({ k: 'assign', target, value, op }),
  expr: (expr: IrExpr): IrStmt => ({ k: 'expr', expr }),
  if_: (cond: IrExpr, then: IrStmt[], else_?: IrStmt[]): IrStmt => ({ k: 'if', cond, then, else: else_ }),
  while_: (cond: IrExpr, body: IrStmt[]): IrStmt => ({ k: 'while', cond, body }),
  forRange: (
    varName: string,
    start: IrExpr,
    end: IrExpr,
    body: IrStmt[],
    step?: IrExpr,
    inclusive?: boolean,
  ): IrStmt => ({ k: 'forRange', varName, start, end, step, inclusive, body }),
  forEach: (varName: string, itemType: TypeRef, iterable: IrExpr, body: IrStmt[], indexName?: string): IrStmt => ({
    k: 'forEach',
    varName,
    itemType,
    iterable,
    body,
    indexName,
  }),
  switch_: (
    subject: IrExpr,
    cases: { match: IrExpr[]; body: IrStmt[] }[],
    default_?: IrStmt[],
  ): IrStmt => ({ k: 'switch', subject, cases, default: default_ }),
  return_: (value?: IrExpr): IrStmt => ({ k: 'return', value }),
  break_: (): IrStmt => ({ k: 'break' }),
  continue_: (): IrStmt => ({ k: 'continue' }),
  throw_: (value: IrExpr): IrStmt => ({ k: 'throw', value }),
  try_: (
    body: IrStmt[],
    catches: { errType?: TypeRef; varName: string; body: IrStmt[] }[],
    finally_?: IrStmt[],
  ): IrStmt => ({ k: 'try', body, catches, finally: finally_ }),
  block: (body: IrStmt[]): IrStmt => ({ k: 'block', body }),
  note: (text: string): IrStmt => ({ k: 'note', text }),
  raw: (lang: string, code: string, caps?: Capability[]): IrStmt => ({ k: 'raw', lang, code, caps }),
};

export const D = {
  fn: (
    name: string,
    params: IrParam[],
    returns: TypeRef,
    body: IrStmt[],
    opts: Partial<IrFunction> = {},
  ): IrFunction => ({ k: 'function', name, params, returns, body, ...opts }),

  param: (name: string, type: TypeRef, def?: IrExpr): IrParam => ({ name, type, default: def }),
};

export function imp(
  source: IrImport['source'],
  target: string,
  symbols?: string[] | { name: string; alias?: string }[],
  alias?: string,
): IrImport {
  const syms = symbols?.map((s) => (typeof s === 'string' ? { name: s } : s));
  return { source, target, symbols: syms, alias };
}

export function mod(
  id: string,
  name: string,
  path: string,
  parts: Partial<Omit<IrModule, 'id' | 'name' | 'path'>> = {},
): IrModule {
  return { id, name, path, imports: [], decls: [], ...parts };
}

/** Stamp an origin onto a node and return it, for chaining during lowering. */
export function at<X extends { origin?: Origin }>(node: X, origin: Origin | undefined): X {
  if (origin) node.origin = origin;
  return node;
}

function inferBinary(op: BinaryOp, l: TypeRef, r: TypeRef): TypeRef {
  switch (op) {
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
    case '&&':
    case '||':
      return T.bool;
    case '/':
      // Division promotes to float so `3 / 2` means the same everywhere; the
      // integer-division builtin exists separately for when that is intended.
      return T.f64;
    case '+':
      if (l.kind === 'primitive' && l.name === 'string') return T.string;
      if (l.kind === 'list') return l;
      return numericJoin(l, r) ?? l;
    case '<<':
    case '>>':
    case '&':
    case '|':
    case '^':
      return l;
    default:
      return numericJoin(l, r) ?? l;
  }
}

export type { IrDecl, IrExpr, IrModule, IrStmt };
