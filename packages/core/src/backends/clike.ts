/**
 * Shared emitter for brace-and-semicolon languages.
 *
 * Java, C#, Go, Rust, C and C++ differ enormously in their type systems and
 * standard libraries, but they agree almost completely on the shape of
 * statements and expressions. That agreement is factored out here; each backend
 * subclasses this and overrides the parts where its language really is
 * different (types, builtins, declarations, and the handful of statements that
 * genuinely diverge, such as Go's `for` and Rust's `match`).
 *
 * Subclasses override by assignment rather than by `abstract`, so the base is a
 * plain class with honest failure: an unoverridden hook throws rather than
 * emitting something plausible-looking and wrong.
 */

import { BackendGenError } from './backend.ts';
import type { EmitContext } from './backend.ts';
import { CodeWriter, avoidKeyword, camel, cString } from './emitter.ts';
import type { BinaryOp, IrExpr, IrParam, IrStmt } from '../ir/ir.ts';
import type { TypeRef } from '../types/types.ts';

export const C_PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11,
};
export const C_CALL_PREC = 17;
export const C_ATOM_PREC = 20;

export interface CLikeDialect {
  /** `let` keyword: `var`, `let mut`, `auto`, or '' when the type leads. */
  letKeyword(mutable: boolean): string;
  /** True when the declared type precedes the name (`int x` rather than `x: int`). */
  typeFirst: boolean;
  /** `null`, `nil`, `None`, `nullptr`. */
  nullLiteral: string;
  trueLiteral: string;
  falseLiteral: string;
  /** Statement terminator; Go omits it. */
  semicolon: boolean;
  /** Parentheses around `if`/`while` conditions; Go and Rust omit them. */
  parenthesizedConditions: boolean;
  /**
   * True when `else` must share a line with the brace that closes the branch
   * before it. Go's automatic semicolon insertion terminates the statement at
   * a `}` left on its own line, so the `else` that follows is orphaned and the
   * file does not parse. Rust is the same. The other C-family languages accept
   * either, and keep the brace on its own line.
   */
  elseOnSameLine?: boolean;
  /** How a foreach loop is spelled. */
  foreach(varName: string, itemType: string, iterable: string, indexName?: string): string;
  /** How an exclusive/inclusive counted loop is spelled. */
  forRange(varName: string, start: string, end: string, step: string, inclusive: boolean): string;
  /** Exponentiation, which no C-family language has as an operator. */
  power(base: string, exponent: string): string;
}

export class CLikeEmitter {
  protected readonly ctx: EmitContext;
  protected readonly dialect: CLikeDialect;
  protected readonly keywords: ReadonlySet<string>;
  protected readonly w: CodeWriter;

  constructor(ctx: EmitContext, dialect: CLikeDialect, keywords: ReadonlySet<string>, indent = '    ') {
    this.ctx = ctx;
    this.dialect = dialect;
    this.keywords = keywords;
    this.w = new CodeWriter(indent);
  }

  // -- hooks a subclass must provide ----------------------------------------

  type(_t: TypeRef): string {
    throw new BackendGenError('type mapping not implemented by this backend');
  }

  builtin(_e: Extract<IrExpr, { k: 'builtin' }>): string {
    throw new BackendGenError('builtin mapping not implemented by this backend');
  }

  zero(_t: TypeRef): string {
    throw new BackendGenError('zero value not implemented by this backend');
  }

  /** The language id used to validate raw blocks. */
  protected get langId(): string {
    return this.ctx.program.language;
  }

  // -- naming ----------------------------------------------------------------

  name(raw: string): string {
    return avoidKeyword(camel(raw), this.keywords);
  }

  typeName(raw: string): string {
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  // -- statements ------------------------------------------------------------

  end(text: string): string {
    return this.dialect.semicolon ? `${text};` : text;
  }

  cond(text: string): string {
    return this.dialect.parenthesizedConditions ? `(${text})` : text;
  }

  emitBody(w: CodeWriter, body: IrStmt[]): void {
    for (const s of body) this.stmt(w, s);
  }

  stmt(w: CodeWriter, s: IrStmt): void {
    if (s.comment) w.line(`// ${s.comment}`);
    switch (s.k) {
      case 'note':
        for (const l of s.text.split('\n')) w.line(`// ${l}`);
        break;
      case 'let':
        w.line(this.end(this.letStatement(s)));
        break;
      case 'assign': {
        const t = this.expr(s.target);
        w.line(this.end(s.op ? `${t} ${s.op}= ${this.expr(s.value)}` : `${t} = ${this.expr(s.value)}`));
        break;
      }
      case 'expr':
        w.line(this.end(this.expr(s.expr)));
        break;
      case 'if': {
        // Each following clause needs to know whether the brace that closed the
        // previous one is still waiting on this line.
        const joined = this.dialect.elseOnSameLine === true;
        const elseIfs = s.elseIf ?? [];

        w.braced(`if ${this.cond(this.expr(s.cond))}`, () => this.emitBody(w, s.then));

        const clauses: { header: string; body: IrStmt[] }[] = [
          ...elseIfs.map((ei) => ({
            header: `else if ${this.cond(this.expr(ei.cond))}`,
            body: ei.body,
          })),
          ...(s.else?.length ? [{ header: 'else', body: s.else }] : []),
        ];

        for (const clause of clauses) {
          if (joined) w.joinLast(` ${clause.header} {`);
          else w.line(`${clause.header} {`);
          w.nest(() => this.emitBody(w, clause.body));
          w.line('}');
        }
        break;
      }
      case 'while':
        w.braced(this.whileHeader(this.expr(s.cond)), () => this.emitBody(w, s.body));
        break;
      case 'doWhile':
        w.line('do {');
        w.nest(() => this.emitBody(w, s.body));
        w.line(this.end(`} while ${this.cond(this.expr(s.cond))}`));
        break;
      case 'forRange':
        w.braced(
          this.dialect.forRange(
            this.name(s.varName),
            this.expr(s.start),
            this.expr(s.end),
            s.step ? this.expr(s.step) : '1',
            !!s.inclusive,
          ),
          () => this.emitBody(w, s.body),
        );
        break;
      case 'forEach':
        w.braced(
          this.dialect.foreach(
            this.name(s.varName),
            this.type(s.itemType),
            this.expr(s.iterable, C_CALL_PREC),
            s.indexName ? this.name(s.indexName) : undefined,
          ),
          () => this.emitBody(w, s.body),
        );
        break;
      case 'switch':
        this.switchStmt(w, s);
        break;
      case 'return':
        w.line(this.end(s.value ? `return ${this.expr(s.value)}` : 'return'));
        break;
      case 'break':
        w.line(this.end('break'));
        break;
      case 'continue':
        w.line(this.end('continue'));
        break;
      case 'throw':
        w.line(this.end(this.throwStatement(s.value)));
        break;
      case 'try':
        this.tryStmt(w, s);
        break;
      case 'block':
        w.braced('', () => this.emitBody(w, s.body));
        break;
      case 'raw':
        if (s.lang !== this.langId && s.lang !== 'any') {
          throw new BackendGenError(`Raw ${s.lang} code cannot be emitted into a ${this.langId} file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: s.origin,
          });
        }
        w.verbatim(s.code);
        break;
    }
  }

  protected letStatement(s: Extract<IrStmt, { k: 'let' }>): string {
    const init = s.init ? this.expr(s.init) : this.zero(s.type);
    const name = this.name(s.name);
    if (this.dialect.typeFirst) {
      const kw = this.dialect.letKeyword(s.mutable !== false);
      const head = kw ? `${kw} ` : `${this.type(s.type)} `;
      return `${head}${name} = ${init}`;
    }
    return `${this.dialect.letKeyword(s.mutable !== false)} ${name}: ${this.type(s.type)} = ${init}`;
  }

  protected whileHeader(cond: string): string {
    return `while ${this.cond(cond)}`;
  }

  protected throwStatement(value: IrExpr): string {
    return `throw ${this.expr(value)}`;
  }

  protected switchStmt(w: CodeWriter, s: Extract<IrStmt, { k: 'switch' }>): void {
    w.braced(`switch ${this.cond(this.expr(s.subject))}`, () => {
      for (const c of s.cases) {
        for (const m of c.match) w.line(`case ${this.expr(m)}:`);
        w.nest(() => {
          this.emitBody(w, c.body);
          if (!endsWithJump(c.body)) w.line(this.end('break'));
        });
      }
      if (s.default?.length) {
        w.line('default:');
        w.nest(() => {
          this.emitBody(w, s.default!);
          if (!endsWithJump(s.default!)) w.line(this.end('break'));
        });
      }
    });
  }

  protected tryStmt(w: CodeWriter, s: Extract<IrStmt, { k: 'try' }>): void {
    w.line('try {');
    w.nest(() => this.emitBody(w, s.body));
    for (const c of s.catches) {
      w.line(`} catch (${this.catchClause(c)}) {`);
      w.nest(() => this.emitBody(w, c.body));
    }
    if (!s.catches.length) {
      w.line('} catch (Exception ignored) {');
      w.nest(() => w.line('throw ignored;'));
    }
    if (s.finally?.length) {
      w.line('} finally {');
      w.nest(() => this.emitBody(w, s.finally!));
    }
    w.line('}');
  }

  protected catchClause(c: { errType?: TypeRef; varName: string }): string {
    return `${c.errType ? this.type(c.errType) : 'Exception'} ${this.name(c.varName)}`;
  }

  // -- expressions -----------------------------------------------------------

  expr(e: IrExpr, parentPrec = 0): string {
    const text = this.exprInner(e);
    return this.precOf(e) < parentPrec ? `(${text})` : text;
  }

  protected precOf(e: IrExpr): number {
    switch (e.k) {
      case 'binary':
        return e.op === '**' ? C_ATOM_PREC : (C_PRECEDENCE[e.op] ?? 5);
      case 'unary':
        return 13;
      case 'ternary':
      case 'lambda':
        return 0.5;
      case 'await':
        return 14;
      default:
        return C_ATOM_PREC;
    }
  }

  protected exprInner(e: IrExpr): string {
    switch (e.k) {
      case 'lit':
        return this.literal(e.value);
      case 'ref':
        return this.name(e.name);
      case 'self':
        return this.selfKeyword();
      case 'symbol':
        return this.ctx.resolveSymbol(e.name, e.from)?.reference ?? this.symbolName(e.name);
      case 'binary':
        return this.binary(e);
      case 'unary':
        return `${e.op}${this.expr(e.operand, 13)}`;
      case 'call':
        return `${this.expr(e.callee, C_CALL_PREC)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      case 'method':
        return `${this.expr(e.target, C_CALL_PREC)}${this.memberAccess()}${this.name(e.name)}(${e.args
          .map((a) => this.expr(a))
          .join(', ')})`;
      case 'member':
        return `${this.expr(e.target, C_CALL_PREC)}${this.memberAccess()}${this.memberName(e.name, e)}`;
      case 'index':
        return `${this.expr(e.target, C_CALL_PREC)}[${this.expr(e.index)}]`;
      case 'new':
        return this.newExpr(e);
      case 'array':
        return this.arrayLit(e);
      case 'mapLit':
        return this.mapLit(e);
      case 'tupleLit':
        return this.tupleLit(e);
      case 'lambda':
        return this.lambda(e);
      case 'ternary':
        return `${this.expr(e.cond, 1)} ? ${this.expr(e.then, 1)} : ${this.expr(e.else, 1)}`;
      case 'cast':
        return this.cast(e);
      case 'await':
        return this.awaitExpr(e);
      case 'builtin':
        return this.builtin(e);
      case 'raw':
        if (e.lang !== this.langId && e.lang !== 'any') {
          throw new BackendGenError(`Raw ${e.lang} expression cannot be emitted into a ${this.langId} file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: e.origin,
          });
        }
        return e.code.trim();
    }
  }

  protected binary(e: Extract<IrExpr, { k: 'binary' }>): string {
    if (e.op === '**') return this.dialect.power(this.expr(e.left, C_CALL_PREC), this.expr(e.right, C_CALL_PREC));
    const p = C_PRECEDENCE[e.op] ?? 5;
    return `${this.expr(e.left, p)} ${this.binaryOp(e.op)} ${this.expr(e.right, p + 1)}`;
  }

  protected binaryOp(op: BinaryOp): string {
    return op;
  }

  protected selfKeyword(): string {
    return 'this';
  }

  protected memberAccess(): string {
    return '.';
  }

  protected memberName(name: string, _e: IrExpr): string {
    return this.name(name);
  }

  protected symbolName(name: string): string {
    return /^[A-Z]/.test(name) ? this.typeName(name) : this.name(name);
  }

  protected newExpr(e: Extract<IrExpr, { k: 'new' }>): string {
    return `new ${this.resolvedType(e.className)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
  }

  /**
   * A user-declared type name, routed through symbol resolution so naming a
   * type from another file registers the import or using-directive for it.
   */
  protected resolvedType(name: string): string {
    return this.ctx.resolveSymbol(name)?.reference ?? this.typeName(name);
  }

  protected arrayLit(e: Extract<IrExpr, { k: 'array' }>): string {
    return `{${e.items.map((i) => this.expr(i)).join(', ')}}`;
  }

  protected mapLit(_e: Extract<IrExpr, { k: 'mapLit' }>): string {
    throw new BackendGenError('map literals not implemented by this backend');
  }

  protected tupleLit(e: Extract<IrExpr, { k: 'tupleLit' }>): string {
    return `(${e.items.map((i) => this.expr(i)).join(', ')})`;
  }

  protected lambda(e: Extract<IrExpr, { k: 'lambda' }>): string {
    const params = e.params.map((p) => this.lambdaParam(p)).join(', ');
    if (!Array.isArray(e.body)) return `(${params}) -> ${this.expr(e.body, 1)}`;
    const inner = new CodeWriter('    ');
    this.emitBody(inner, e.body);
    return `(${params}) -> {\n${inner.toString().replace(/\n$/, '')}\n}`;
  }

  protected lambdaParam(p: IrParam): string {
    return this.name(p.name);
  }

  protected cast(e: Extract<IrExpr, { k: 'cast' }>): string {
    return `(${this.type(e.to)}) ${this.expr(e.expr, 13)}`;
  }

  protected awaitExpr(e: Extract<IrExpr, { k: 'await' }>): string {
    return `await ${this.expr(e.expr, 14)}`;
  }

  literal(v: Extract<IrExpr, { k: 'lit' }>['value']): string {
    switch (v.t) {
      case 'bool':
        return v.v ? this.dialect.trueLiteral : this.dialect.falseLiteral;
      case 'int':
        return String(v.v);
      case 'float':
        return Number.isInteger(v.v) ? `${v.v}.0` : String(v.v);
      case 'string':
        return cString(v.v);
      case 'char':
        return `'${v.v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      case 'null':
        return this.dialect.nullLiteral;
    }
  }
}

export function endsWithJump(body: IrStmt[]): boolean {
  const last = body[body.length - 1];
  return !!last && (last.k === 'return' || last.k === 'break' || last.k === 'continue' || last.k === 'throw');
}

/** Dialect preset for languages that spell things the way Java does. */
export function javaLikeDialect(over: Partial<CLikeDialect> = {}): CLikeDialect {
  return {
    letKeyword: () => 'var',
    typeFirst: true,
    nullLiteral: 'null',
    trueLiteral: 'true',
    falseLiteral: 'false',
    semicolon: true,
    parenthesizedConditions: true,
    foreach: (v, t, it, index) =>
      index
        ? `for (int ${index} = 0; ${index} < ${it}.size(); ${index}++) { ${t} ${v} = ${it}.get(${index});`
        : `for (${t} ${v} : ${it})`,
    forRange: (v, start, end, step, inclusive) =>
      `for (int ${v} = ${start}; ${v} ${inclusive ? '<=' : '<'} ${end}; ${v} += ${step})`,
    power: (b, e) => `Math.pow(${b}, ${e})`,
    ...over,
  };
}
