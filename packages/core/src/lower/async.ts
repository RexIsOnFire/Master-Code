/**
 * Making "this call has finished" true in languages where it is not free.
 *
 * The IR states ordering, not concurrency: a statement runs after the one
 * before it. In Python, Go or Java that is simply what a blocking call does,
 * and there is nothing to arrange. In JavaScript the same operation hands back
 * a promise, so `response.status` on the next line reads a field off the
 * promise and quietly produces `undefined` - a program that looks right, runs
 * without error, and is wrong.
 *
 * This pass closes that gap for the backends that need it. It wraps every call
 * that can suspend in an `await`, marks the function containing it, and then
 * keeps going: a function that awaits is itself something callers must await,
 * so the marking spreads through the call graph until it stops changing.
 *
 * It runs only for backends whose `asyncBuiltins` feature is set, because in
 * every other language the guarantee already holds and the annotations would
 * be noise.
 */

import { E, at } from '../ir/build.ts';
import { getBuiltin } from '../ir/builtins.ts';
import type { IrClass, IrDecl, IrExpr, IrFunction, IrModule, IrProgram, IrStmt } from '../ir/ir.ts';
import type { DiagnosticBag } from '../diagnostics.ts';

/**
 * Builtins that take a callback and call it straight away, expecting a value
 * back rather than a promise.
 *
 * A suspending call inside one of these is not something this pass can fix by
 * marking: `list_map` with an async callback yields a list of promises in
 * JavaScript, and no amount of awaiting the `list_map` itself repairs that.
 * The graph has to use a For Each loop instead, so the case is reported rather
 * than miscompiled.
 */
const SYNCHRONOUS_CALLBACKS = new Set([
  'list_map',
  'list_filter',
  'list_reduce',
  'list_any',
  'list_all',
  'list_find',
  'list_sort_by',
]);

interface Scope {
  /** Set once anything in this function body has been wrapped in an await. */
  suspends: boolean;
  /** The builtin whose callback we are inside, if any. */
  callback?: string;
}

class Marker {
  private readonly suspending = new Set<string>();
  private readonly wrapped = new WeakSet<IrExpr>();
  private readonly reported = new Set<string>();
  private changed = false;

  private readonly diag?: DiagnosticBag;

  constructor(diag?: DiagnosticBag) {
    this.diag = diag;
  }

  run(program: IrProgram): void {
    // Repeat until no new function is discovered to suspend. Each pass can
    // only add names, and there are finitely many, so this terminates.
    let rounds = 0;
    do {
      this.changed = false;
      for (const module of program.modules) this.module(module);
      rounds += 1;
    } while (this.changed && rounds < 100);
  }

  private module(module: IrModule): void {
    for (const decl of module.decls) this.decl(decl);
    if (module.main?.length) {
      // Top-level statements are their own scope: a module body that awaits is
      // legal in every target this pass runs for, and has no caller to mark.
      const scope: Scope = { suspends: false };
      this.stmts(module.main, scope);
    }
  }

  private decl(decl: IrDecl): void {
    if (decl.k === 'function') this.fn(decl);
    else if (decl.k === 'class') this.class_(decl as IrClass);
  }

  private class_(cls: IrClass): void {
    for (const method of cls.methods) this.fn(method, cls.name);
    if (cls.ctor) this.fn(cls.ctor, cls.name);
    // A field initialiser has no function to mark, so a suspending call there
    // would have nowhere to go; it is left alone and caught by the backend.
  }

  private fn(fn: IrFunction, owner?: string): void {
    const scope: Scope = { suspends: false };
    this.stmts(fn.body, scope);
    if (!scope.suspends) return;
    if (!fn.isAsync) {
      fn.isAsync = true;
      this.changed = true;
    }
    for (const key of names(fn.name, owner)) {
      if (!this.suspending.has(key)) {
        this.suspending.add(key);
        this.changed = true;
      }
    }
  }

  // -- traversal -------------------------------------------------------------

  private stmts(list: IrStmt[] | undefined, scope: Scope): void {
    for (const s of list ?? []) this.stmt(s, scope);
  }

  private stmt(s: IrStmt, scope: Scope): void {
    switch (s.k) {
      case 'let':
        s.init = this.expr(s.init, scope);
        break;
      case 'assign':
        s.target = this.expr(s.target, scope)!;
        s.value = this.expr(s.value, scope)!;
        break;
      case 'expr':
        s.expr = this.expr(s.expr, scope)!;
        break;
      case 'if':
        s.cond = this.expr(s.cond, scope)!;
        this.stmts(s.then, scope);
        for (const branch of s.elseIf ?? []) {
          branch.cond = this.expr(branch.cond, scope)!;
          this.stmts(branch.body, scope);
        }
        this.stmts(s.else, scope);
        break;
      case 'while':
      case 'doWhile':
        s.cond = this.expr(s.cond, scope)!;
        this.stmts(s.body, scope);
        break;
      case 'forRange':
        s.start = this.expr(s.start, scope)!;
        s.end = this.expr(s.end, scope)!;
        s.step = this.expr(s.step, scope);
        this.stmts(s.body, scope);
        break;
      case 'forEach':
        s.iterable = this.expr(s.iterable, scope)!;
        this.stmts(s.body, scope);
        break;
      case 'switch':
        s.subject = this.expr(s.subject, scope)!;
        for (const c of s.cases) {
          c.match = c.match.map((m) => this.expr(m, scope)!);
          this.stmts(c.body, scope);
        }
        this.stmts(s.default, scope);
        break;
      case 'return':
        s.value = this.expr(s.value, scope);
        break;
      case 'throw':
        s.value = this.expr(s.value, scope)!;
        break;
      case 'try':
        this.stmts(s.body, scope);
        for (const c of s.catches) this.stmts(c.body, scope);
        this.stmts(s.finally, scope);
        break;
      case 'block':
        this.stmts(s.body, scope);
        break;
      default:
        break;
    }
  }

  private expr(e: IrExpr | undefined, scope: Scope): IrExpr | undefined {
    if (!e) return e;

    switch (e.k) {
      case 'binary':
        e.left = this.expr(e.left, scope)!;
        e.right = this.expr(e.right, scope)!;
        break;
      case 'unary':
        e.operand = this.expr(e.operand, scope)!;
        break;
      case 'call':
        e.callee = this.expr(e.callee, scope)!;
        e.args = e.args.map((a) => this.expr(a, scope)!);
        break;
      case 'method':
        e.target = this.expr(e.target, scope)!;
        e.args = e.args.map((a) => this.expr(a, scope)!);
        break;
      case 'member':
        e.target = this.expr(e.target, scope)!;
        break;
      case 'index':
        e.target = this.expr(e.target, scope)!;
        e.index = this.expr(e.index, scope)!;
        break;
      case 'new':
        e.args = e.args.map((a) => this.expr(a, scope)!);
        break;
      case 'array':
      case 'tupleLit':
        e.items = e.items.map((i) => this.expr(i, scope)!);
        break;
      case 'mapLit':
        for (const entry of e.entries) {
          entry.key = this.expr(entry.key, scope)!;
          entry.value = this.expr(entry.value, scope)!;
        }
        break;
      case 'ternary':
        e.cond = this.expr(e.cond, scope)!;
        e.then = this.expr(e.then, scope)!;
        e.else = this.expr(e.else, scope)!;
        break;
      case 'cast':
      case 'await':
        e.expr = this.expr(e.expr, scope)!;
        break;
      case 'builtin':
        // A callback argument is a scope of its own, and for the collection
        // operations it is a scope that may not suspend at all.
        e.args = e.args.map((a) => this.expr(a, { ...scope, callback: e.op })!);
        break;
      case 'lambda':
        this.lambda(e, scope);
        return e;
      default:
        break;
    }

    return this.maybeAwait(e, scope);
  }

  private lambda(e: Extract<IrExpr, { k: 'lambda' }>, outer: Scope): void {
    const inner: Scope = { suspends: false, callback: outer.callback };
    if (Array.isArray(e.body)) this.stmts(e.body, inner);
    else e.body = this.expr(e.body, inner)!;

    if (!inner.suspends) return;
    if (outer.callback && SYNCHRONOUS_CALLBACKS.has(outer.callback)) {
      this.complain(outer.callback, e);
      return;
    }
    // An event handler or a task body may suspend without its creator doing
    // so - registering the handler is what the enclosing function waits for,
    // not running it.
    if (!e.isAsync) {
      e.isAsync = true;
      this.changed = true;
    }
  }

  /** Wraps `e` when it is a call that can suspend, and marks the scope. */
  private maybeAwait(e: IrExpr, scope: Scope): IrExpr {
    if (this.wrapped.has(e)) return e;
    if (!this.suspends(e)) return e;

    if (scope.callback && SYNCHRONOUS_CALLBACKS.has(scope.callback)) {
      this.complain(scope.callback, e);
      return e;
    }

    this.wrapped.add(e);
    scope.suspends = true;
    return at(E.await_(e, e.type), e.origin);
  }

  private suspends(e: IrExpr): boolean {
    if (e.k === 'builtin') return getBuiltin(e.op)?.suspends === true;
    if (e.k !== 'call') return false;
    const callee = e.callee;
    const name = callee.k === 'ref' || callee.k === 'symbol' ? callee.name : undefined;
    return name !== undefined && this.suspending.has(name);
  }

  private complain(op: string, e: IrExpr): void {
    const key = `${op}:${e.origin?.nodeId ?? ''}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diag?.error(
      'ir',
      'ir/suspending-callback',
      `A step inside this ${label(op)} waits for something - a request, a pause - and ${label(op)} cannot wait.`,
      {
        origin: e.origin,
        hint: 'Use a For Each loop, which can wait inside its body, and collect the results into a list.',
      },
    );
  }
}

/** `list_map` -> `Map`, for a message that names what the user drew. */
function label(op: string): string {
  const tail = op.replace(/^list_/, '').replace(/_/g, ' ');
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

/** The keys a call to this function could use: bare, and qualified by owner. */
function names(name: string, owner?: string): string[] {
  return owner ? [name, `${owner}.${name}`] : [name];
}

/**
 * Marks every call that has to be waited for, and the functions containing
 * them. Only for backends whose `asyncBuiltins` feature is set.
 */
export function markSuspending(program: IrProgram, diag?: DiagnosticBag): void {
  new Marker(diag).run(program);
}
