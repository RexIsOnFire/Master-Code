/**
 * Python 3 backend.
 *
 * The reference implementation of `LanguageBackend`: it exercises every part of
 * the contract, so a new adapter can be read against it.
 *
 * Two deliberate choices worth knowing about:
 *
 *  - Builtins map to the standard library wherever the standard library says
 *    the same thing. Only four operations (HTTP, SQLite wrappers, checked
 *    parsing, assertions) need helpers, and those are emitted into a single
 *    `_mcode_runtime.py` that is written only when something uses them.
 *  - Lambdas whose body is a statement list become named nested functions,
 *    because Python's `lambda` is expression-only. Generating a broken lambda
 *    and hoping would be worse than emitting the function the user meant.
 */

import type {
  BuildMode,
  BuildPlan,
  CommandSpec,
  EmitContext,
  GeneratedFile,
  LanguageBackend,
  RunPlan,
} from './backend.ts';
import { BackendGenError, defaultFeatures, generatedHeader } from './backend.ts';
import { CodeWriter, avoidKeyword, pascal, pyString, snake, wrapText } from './emitter.ts';
import { usedBuiltins } from './analysis.ts';
import type {
  BinaryOp,
  IrClass,
  IrDecl,
  IrEnum,
  IrExpr,
  IrFunction,
  IrImport,
  IrInterface,
  IrModule,
  IrProgram,
  IrParam,
  IrStmt,
  Origin,
} from '../ir/ir.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project, ProjectFile } from '../model/project.ts';
import type { TypeRef } from '../types/types.ts';
import { typeToString } from '../types/types.ts';

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with',
  'yield', 'match', 'case', 'type',
]);

/**
 * Standard-library modules this backend imports for itself.
 *
 * Python has no block scope, so a local named `uuid` shadows the `uuid` module
 * for the whole function - including the `uuid.uuid4()` call two lines above
 * that assignment, which fails at run time with an UnboundLocalError rather
 * than at compile time. A graph is free to name a value `time` or `json`, so
 * these are reserved the same way keywords are and suffixed on collision.
 */
const SHADOWED_MODULES = new Set([
  'hashlib', 'hmac', 'io', 'json', 'math', 'os', 'random', 'sys', 'time', 'unittest', 'urllib',
  'uuid', 'base64', 'binascii', 'datetime', 're', 'sqlite3',
]);

const RESERVED_NAMES = new Set([...KEYWORDS, ...SHADOWED_MODULES]);

const RUNTIME_MODULE = '_mcode_runtime';

/** Builtins that need a helper from the generated runtime module. */
const RUNTIME_OPS: Record<string, string> = {
  http_request: 'http_request',
  parse_int: 'parse_int',
  parse_float: 'parse_float',
  db_open: 'db_open',
  db_execute: 'db_execute',
  db_query: 'db_query',
  db_close: 'db_close',
  regex_match: 'regex_match',
  regex_find_all: 'regex_find_all',
  regex_capture: 'regex_capture',
  regex_replace: 'regex_replace',
  regex_split: 'regex_split',
  base64_decode: 'base64_decode',
  time_now_iso: 'time_now_iso',
  time_parse_iso: 'time_parse_iso',
  time_format_iso: 'time_format_iso',
  option_unwrap: 'require_value',
  option_or: 'option_or',
  http_serve: 'http_serve',
  http_reply: 'http_reply',
  parallel_map: 'parallel_map',
  parallel_all: 'parallel_all',
  schedule_every: 'schedule_every',
  json_path: 'json_path',
};

// Precedence table; higher binds tighter.
const PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 4, '!=': 4, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '|': 5, '^': 6, '&': 7, '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
  '**': 12,
};
const CALL_PREC = 16;
const ATOM_PREC = 20;

const PY_OP: Partial<Record<BinaryOp, string>> = { '&&': 'and', '||': 'or' };

class PythonEmitter {
  private readonly plainImports = new Set<string>();
  private readonly fromImports = new Map<string, Set<string>>();
  /** Stack of frames; each frame holds helper functions; each helper is lines. */
  private readonly pendingHelpers: string[][][] = [];
  private lambdaCounter = 0;

  private readonly ctx: EmitContext;

  constructor(ctx: EmitContext) {
    this.ctx = ctx;
  }

  emit(): string {
    const { module, file, project } = this.ctx;
    const bodyWriter = new CodeWriter('    ');

    for (const decl of module.decls) this.emitDecl(bodyWriter, decl);

    const entry = module.decls.find((d): d is IrFunction => d.k === 'function' && !!d.isEntry);
    if (entry) {
      bodyWriter.blank();
      bodyWriter.line('if __name__ == "__main__":');
      bodyWriter.nest(() => bodyWriter.line(`${this.name(entry.name)}()`));
    }

    // Test graphs produce plain functions, which unittest's discovery does not
    // find. A thin TestCase adapter makes them discoverable without changing
    // the functions themselves - they stay callable from anywhere.
    if (file.role === 'test') {
      const tests = module.decls.filter(
        (d): d is IrFunction => d.k === 'function' && this.name(d.name).startsWith('test_'),
      );
      if (tests.length) {
        this.need('unittest');
        bodyWriter.blank();
        bodyWriter.line('class GeneratedTests(unittest.TestCase):');
        bodyWriter.nest(() => {
          bodyWriter.line(`"""Adapter so unittest discovers the ${tests.length} generated test(s)."""`);
          for (const t of tests) {
            bodyWriter.blank();
            bodyWriter.line(`def ${this.name(t.name)}(self) -> None:`);
            bodyWriter.nest(() => bodyWriter.line(`${this.name(t.name)}()`));
          }
        });
        bodyWriter.blank();
        bodyWriter.line('if __name__ == "__main__":');
        bodyWriter.nest(() => bodyWriter.line('unittest.main()'));
      }
    }
    if (module.main?.length) {
      bodyWriter.blank();
      for (const s of module.main) this.emitStmt(bodyWriter, s);
    }

    // Imports are collected while emitting, so the header is written last.
    const head = new CodeWriter('    ');
    for (const l of generatedHeader(pythonBackend, file, project)) head.line(l);
    head.blank();
    if (module.doc) {
      head.line('"""');
      for (const l of wrapText(module.doc)) head.line(l);
      head.line('"""');
      head.blank();
    }
    head.line('from __future__ import annotations');

    this.writeImports(head, module);

    if (file.kind === 'hybrid') {
      head.blank();
      head.line('# <mcode:region id="user-imports">');
      head.line('# </mcode:region>');
    }

    head.blank();
    head.blockFrom(bodyWriter, 'pass  # nothing generated yet');

    if (file.kind === 'hybrid') {
      head.blank();
      head.line('# <mcode:region id="user-code">');
      head.line('# </mcode:region>');
    }
    // Hand the line attributions back so the source map can be exact rather
    // than inferred from identifiers. Only meaningful for the final writer,
    // which is why it happens here and not as each statement is emitted.
    if (this.ctx.lineOrigins) {
      for (const [line, origin] of head.lineOrigins()) {
        this.ctx.lineOrigins.set(line, origin as Origin);
      }
    }
    return head.toString();
  }

  private writeImports(w: CodeWriter, module: IrModule): void {
    const std: string[] = [...this.plainImports].sort();
    const froms = [...this.fromImports.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (std.length) {
      w.blank();
      for (const m of std) w.line(`import ${m}`);
    }
    if (froms.length) {
      w.blank();
      for (const [mod, names] of froms) {
        w.line(`from ${mod} import ${[...names].sort().join(', ')}`);
      }
    }
    const projectImports = module.imports.filter((i) => i.source === 'file');
    const external = module.imports.filter((i) => i.source !== 'file');
    if (external.length) {
      w.blank();
      for (const imp of external) w.line(this.renderImport(imp));
    }
    if (projectImports.length) {
      w.blank();
      for (const imp of projectImports) w.line(this.renderImport(imp));
    }
  }

  private renderImport(imp: IrImport): string {
    const target =
      imp.source === 'file'
        ? modulePathToDotted(this.ctx.program.modules.find((m) => m.id === imp.target)?.path ?? imp.target)
        : imp.target;
    if (imp.wildcard) return `from ${target} import *`;
    if (imp.symbols?.length) {
      const names = imp.symbols.map((s) => (s.alias ? `${s.name} as ${s.alias}` : s.name)).join(', ');
      return `from ${target} import ${names}`;
    }
    return imp.alias ? `import ${target} as ${imp.alias}` : `import ${target}`;
  }

  private need(mod: string): void {
    this.plainImports.add(mod);
  }

  private needFrom(mod: string, name: string): void {
    let s = this.fromImports.get(mod);
    if (!s) {
      s = new Set();
      this.fromImports.set(mod, s);
    }
    s.add(name);
  }

  private name(raw: string): string {
    return avoidKeyword(snake(raw), RESERVED_NAMES);
  }

  private typeName(raw: string): string {
    return avoidKeyword(pascal(raw), KEYWORDS);
  }

  // -- types -----------------------------------------------------------------

  type(t: TypeRef): string {
    switch (t.kind) {
      case 'void':
        return 'None';
      case 'any':
        this.needFrom('typing', 'Any');
        return 'Any';
      case 'exec':
        return 'None';
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return 'bool';
          case 'i32':
          case 'i64':
            return 'int';
          case 'f32':
          case 'f64':
            return 'float';
          case 'string':
          case 'char':
            return 'str';
          case 'bytes':
            return 'bytes';
        }
        return 'object';
      case 'list':
        return `list[${this.type(t.item)}]`;
      case 'set':
        return `set[${this.type(t.item)}]`;
      case 'map':
        return `dict[${this.type(t.key)}, ${this.type(t.value)}]`;
      case 'option':
        return `${this.type(t.inner)} | None`;
      case 'tuple':
        return t.items.length ? `tuple[${t.items.map((i) => this.type(i)).join(', ')}]` : 'tuple[()]';
      case 'future':
        this.needFrom('typing', 'Awaitable');
        return `Awaitable[${this.type(t.inner)}]`;
      case 'result':
        // Python signals failure with exceptions, so a Result collapses to its
        // success type. The raising path is generated by Try/Throw nodes.
        return this.type(t.ok);
      case 'function': {
        this.needFrom('typing', 'Callable');
        const params = t.params.map((p) => this.type(p)).join(', ');
        return `Callable[[${params}], ${this.type(t.returns)}]`;
      }
      case 'named':
        return this.namedType(t.name);
      case 'var':
        this.needFrom('typing', 'Any');
        return 'Any';
    }
  }

  private namedType(name: string): string {
    switch (name) {
      case 'Error':
        return 'Exception';
      case 'Json':
        this.needFrom('typing', 'Any');
        return 'Any';
      case 'HttpResponse':
        this.needFrom(RUNTIME_MODULE, 'HttpResponse');
        return 'HttpResponse';
      case 'DbConnection':
        this.need('sqlite3');
        return 'sqlite3.Connection';
      case 'Element':
        throw new BackendGenError('DOM types have no Python equivalent.', {
          code: 'codegen/dom-in-python',
          hint: 'DOM nodes only run in a JavaScript file. Move them to a .js target.',
        });
      default:
        return this.resolvedType(name);
    }
  }

  /**
   * A user-declared type name, routed through symbol resolution so that
   * referring to a class from another file adds the import for it. Type
   * positions need this every bit as much as call sites do.
   */
  private resolvedType(name: string): string {
    return this.ctx.resolveSymbol(name)?.reference ?? this.typeName(name);
  }

  // -- declarations ----------------------------------------------------------

  private emitDecl(w: CodeWriter, d: IrDecl): void {
    // Declarations carry an origin too — a Function or Class node produces one
    // and no statement of its own, so without this the node that defines the
    // shape of a file maps to none of its lines.
    w.mark(d.origin);
    switch (d.k) {
      case 'function':
        this.emitFunction(w, d);
        break;
      case 'class':
        this.emitClass(w, d);
        break;
      case 'interface':
        this.emitInterface(w, d);
        break;
      case 'enum':
        this.emitEnum(w, d);
        break;
      case 'global': {
        w.blank();
        if (d.doc) w.line(`# ${d.doc}`);
        const init = d.init ? this.expr(d.init) : this.zero(d.type);
        w.line(`${this.constName(d)}: ${this.type(d.type)} = ${init}`);
        break;
      }
      case 'typeAlias':
        w.blank();
        w.line(`${this.typeName(d.name)} = ${this.type(d.target)}`);
        break;
      case 'rawDecl':
        if (d.lang !== 'python' && d.lang !== 'any') {
          throw new BackendGenError(`Raw ${d.lang} block cannot be emitted into a Python file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: d.origin,
          });
        }
        w.blank();
        w.verbatim(d.code);
        break;
    }
  }

  private constName(d: { name: string; constant?: boolean }): string {
    return d.constant ? snake(d.name).toUpperCase() : this.name(d.name);
  }

  private emitFunction(w: CodeWriter, f: IrFunction, insideClass = false): void {
    w.blank();
    if (f.isStatic && insideClass) w.line('@staticmethod');
    const params = this.params(f, insideClass);
    const kw = f.isAsync ? 'async def' : 'def';
    const name = f.name === 'constructor' ? '__init__' : this.name(f.name);
    w.line(`${kw} ${name}(${params}) -> ${this.type(f.returns)}:`);
    w.nest(() => {
      if (f.doc?.trim()) {
        const lines = wrapText(f.doc.trim());
        if (lines.length === 1) w.line(`"""${lines[0]}"""`);
        else {
          w.line('"""');
          lines.forEach((l) => w.line(l));
          w.line('"""');
        }
      }
      // A body of nothing but comments is still an empty body as far as Python
      // is concerned, and `def f():` followed only by a `#` line is an
      // IndentationError. Emit the comments, then `pass`. This is the state
      // every blank project and every challenge starts in.
      const executable = f.body.filter((s) => s.k !== 'note');
      if (!executable.length) {
        for (const s of f.body) this.emitStmt(w, s);
        w.line('pass');
        return;
      }
      const before = w.indentDepth;
      for (const s of f.body) this.emitStmt(w, s);
      if (w.indentDepth !== before) throw new Error('unbalanced indentation while emitting a function body');
    });
  }

  private params(f: IrFunction, insideClass: boolean): string {
    const parts: string[] = [];
    if (insideClass && !f.isStatic) parts.push('self');
    for (const p of f.params) parts.push(this.param(p));
    return parts.join(', ');
  }

  private param(p: IrParam): string {
    const star = p.rest ? '*' : '';
    const base = `${star}${this.name(p.name)}: ${this.type(p.type)}`;
    return p.default ? `${base} = ${this.expr(p.default)}` : base;
  }

  private emitClass(w: CodeWriter, c: IrClass): void {
    w.blank();
    const bases: string[] = [];
    if (c.extends) bases.push(this.type(c.extends));
    for (const i of c.implements ?? []) bases.push(this.type(i));
    if (c.isAbstract) {
      this.needFrom('abc', 'ABC');
      bases.push('ABC');
    }
    if (c.shape === 'record' || (c.shape === 'struct' && !c.ctor)) {
      this.needFrom('dataclasses', 'dataclass');
      w.line('@dataclass');
    }
    w.line(`class ${this.typeName(c.name)}${bases.length ? `(${bases.join(', ')})` : ''}:`);
    w.nest(() => {
      if (c.doc?.trim()) w.line(`"""${wrapText(c.doc.trim()).join(' ')}"""`);
      const isData = c.shape === 'record' || (c.shape === 'struct' && !c.ctor);
      let wroteSomething = false;

      for (const f of c.fields) {
        const decl = `${this.name(f.name)}: ${f.isStatic ? `ClassVar[${this.type(f.type)}]` : this.type(f.type)}`;
        if (f.isStatic) this.needFrom('typing', 'ClassVar');
        const init = f.init ? this.expr(f.init) : isData ? this.zero(f.type) : undefined;
        // Non-dataclass instance fields are set in __init__, so only annotate.
        if (isData || f.isStatic) w.line(init !== undefined ? `${decl} = ${init}` : decl);
        else w.line(decl);
        if (f.doc) w.line(`"""${f.doc}"""`);
        wroteSomething = true;
      }

      if (c.ctor) {
        // Fields without an explicit initialiser are set to their zero value
        // before the constructor body, so no attribute is ever undefined.
        const seeded = c.fields.filter((f) => !f.isStatic);
        const ctor: IrFunction = {
          ...c.ctor,
          body: [
            ...seeded
              .filter((f) => !constructorAssigns(c.ctor!, f.name))
              .map(
                (f): IrStmt => ({
                  k: 'assign',
                  target: { k: 'member', target: { k: 'self', type: { kind: 'named', name: c.name } }, name: f.name, type: f.type },
                  value: f.init ?? zeroIr(f.type),
                }),
              ),
            ...c.ctor.body,
          ],
        };
        this.emitFunction(w, ctor, true);
        wroteSomething = true;
      }
      for (const m of c.methods) {
        this.emitFunction(w, m, true);
        wroteSomething = true;
      }
      if (!wroteSomething) w.line('pass');
    });
  }

  private emitInterface(w: CodeWriter, i: IrInterface): void {
    this.needFrom('typing', 'Protocol');
    w.blank();
    const bases = ['Protocol', ...(i.extends ?? []).map((t) => this.type(t))];
    w.line(`class ${this.typeName(i.name)}(${bases.join(', ')}):`);
    w.nest(() => {
      if (i.doc?.trim()) w.line(`"""${wrapText(i.doc.trim()).join(' ')}"""`);
      if (!i.methods.length && !(i.fields ?? []).length) {
        w.line('...');
        return;
      }
      for (const f of i.fields ?? []) w.line(`${this.name(f.name)}: ${this.type(f.type)}`);
      for (const m of i.methods) {
        w.blank();
        w.line(`def ${this.name(m.name)}(${this.params(m, true)}) -> ${this.type(m.returns)}:`);
        w.nest(() => w.line('...'));
      }
    });
  }

  private emitEnum(w: CodeWriter, e: IrEnum): void {
    this.needFrom('enum', 'Enum');
    w.blank();
    w.line(`class ${this.typeName(e.name)}(Enum):`);
    w.nest(() => {
      if (e.doc?.trim()) w.line(`"""${e.doc.trim()}"""`);
      if (!e.variants.length) {
        w.line('pass');
        return;
      }
      e.variants.forEach((v, i) => {
        const value = v.value ? this.literal(v.value) : String(i + 1);
        w.line(`${snake(v.name).toUpperCase()} = ${value}`);
      });
    });
  }

  // -- statements ------------------------------------------------------------

  private emitStmt(w: CodeWriter, s: IrStmt): void {
    // Expression rendering can produce helper functions (statement lambdas);
    // they must land before the statement that uses them.
    this.pendingHelpers.push([]);
    // Render into a staging writer at depth 0 first: rendering is what
    // discovers any closures, and those have to be written out ahead of the
    // statement that refers to them.
    const staged = new CodeWriter('    ');
    this.emitStmtInner(staged, s);
    for (const helper of this.pendingHelpers.pop()!) {
      for (const line of helper) w.line(line);
      w.blank();
    }
    w.blockFrom(staged);
  }

  private emitStmtInner(w: CodeWriter, s: IrStmt): void {
    // Attribute the statement's first line to the node that produced it. Done
    // here rather than in `emitStmt` because nested bodies come straight to
    // this method, and marking only the outer call would leave everything
    // inside an `if` or a loop unattributed.
    //
    // This is what lets a trace say "this node ran" for a pure node that was
    // inlined into an expression and left no identifier behind.
    w.mark(s.origin);
    if (s.comment) w.line(`# ${s.comment}`);
    switch (s.k) {
      case 'note':
        for (const l of s.text.split('\n')) w.line(`# ${l}`);
        break;
      case 'let': {
        const init = s.init ? this.expr(s.init) : this.zero(s.type);
        w.line(`${this.name(s.name)}: ${this.type(s.type)} = ${init}`);
        break;
      }
      case 'assign': {
        const target = this.expr(s.target);
        const value = this.expr(s.value);
        w.line(s.op ? `${target} ${s.op}= ${value}` : `${target} = ${value}`);
        break;
      }
      case 'expr':
        w.line(this.statementExpr(s.expr));
        break;
      case 'if': {
        w.line(`if ${this.expr(s.cond)}:`);
        this.body(w, s.then);
        for (const ei of s.elseIf ?? []) {
          w.line(`elif ${this.expr(ei.cond)}:`);
          this.body(w, ei.body);
        }
        if (s.else?.length) {
          w.line('else:');
          this.body(w, s.else);
        }
        break;
      }
      case 'while':
        w.line(`while ${this.expr(s.cond)}:`);
        this.body(w, s.body);
        break;
      case 'doWhile':
        w.line('while True:');
        this.body(w, [...s.body, { k: 'if', cond: { k: 'unary', op: '!', operand: s.cond, type: s.cond.type }, then: [{ k: 'break' }] }]);
        break;
      case 'forRange': {
        const start = this.expr(s.start);
        const rawEnd = this.expr(s.end);
        const end = s.inclusive ? `${rawEnd} + 1` : rawEnd;
        const step = s.step ? `, ${this.expr(s.step)}` : '';
        w.line(`for ${this.name(s.varName)} in range(${start}, ${end}${step}):`);
        this.body(w, s.body);
        break;
      }
      case 'forEach': {
        const it = this.expr(s.iterable);
        if (s.indexName) {
          w.line(`for ${this.name(s.indexName)}, ${this.name(s.varName)} in enumerate(${it}):`);
        } else {
          w.line(`for ${this.name(s.varName)} in ${it}:`);
        }
        this.body(w, s.body);
        break;
      }
      case 'switch': {
        // `match` needs Python 3.10+, which the generated manifest requires.
        w.line(`match ${this.expr(s.subject)}:`);
        w.nest(() => {
          for (const c of s.cases) {
            w.line(`case ${c.match.map((m) => this.matchPattern(m)).join(' | ')}:`);
            this.body(w, c.body);
          }
          if (s.default?.length) {
            w.line('case _:');
            this.body(w, s.default);
          }
          if (!s.cases.length && !s.default?.length) {
            w.line('case _:');
            w.nest(() => w.line('pass'));
          }
        });
        break;
      }
      case 'return':
        w.line(s.value ? `return ${this.expr(s.value)}` : 'return');
        break;
      case 'break':
        w.line('break');
        break;
      case 'continue':
        w.line('continue');
        break;
      case 'throw':
        w.line(`raise ${this.expr(s.value)}`);
        break;
      case 'try': {
        w.line('try:');
        this.body(w, s.body);
        for (const c of s.catches) {
          const t = c.errType ? this.type(c.errType) : 'Exception';
          w.line(`except ${t} as ${this.name(c.varName)}:`);
          this.body(w, c.body);
        }
        if (!s.catches.length) {
          w.line('except Exception:');
          w.nest(() => w.line('raise'));
        }
        if (s.finally?.length) {
          w.line('finally:');
          this.body(w, s.finally);
        }
        break;
      }
      case 'block':
        for (const inner of s.body) this.emitStmtInner(w, inner);
        break;
      case 'raw':
        if (s.lang !== 'python' && s.lang !== 'any') {
          throw new BackendGenError(`Raw ${s.lang} code cannot be emitted into a Python file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: s.origin,
          });
        }
        w.verbatim(s.code);
        break;
    }
  }

  private body(w: CodeWriter, stmts: IrStmt[]): void {
    w.nest(() => {
      const real = stmts.filter((s) => s.k !== 'note');
      if (!real.length && !stmts.length) {
        w.line('pass');
        return;
      }
      for (const s of stmts) this.emitStmtInner(w, s);
      if (!real.length) w.line('pass');
    });
  }

  private matchPattern(e: IrExpr): string {
    // Bare identifiers in a match arm would capture rather than compare, so a
    // symbol reference is spelled as a value pattern.
    if (e.k === 'member') return this.expr(e);
    if (e.k === 'ref' || e.k === 'symbol') return `"${e.name}"`;
    return this.expr(e);
  }

  // -- expressions -----------------------------------------------------------

  expr(e: IrExpr, parentPrec = 0): string {
    const text = this.exprInner(e);
    const p = this.precOf(e);
    return p < parentPrec ? `(${text})` : text;
  }

  private precOf(e: IrExpr): number {
    switch (e.k) {
      case 'binary':
        return PRECEDENCE[e.op] ?? 5;
      case 'unary':
        return 11;
      case 'ternary':
        return 0.5;
      case 'lambda':
        return 0.5;
      case 'await':
        return 13;
      default:
        return ATOM_PREC;
    }
  }

  private exprInner(e: IrExpr): string {
    switch (e.k) {
      case 'lit':
        return this.literal(e.value);
      case 'ref':
        return this.name(e.name);
      case 'self':
        return 'self';
      case 'symbol': {
        const resolved = this.ctx.resolveSymbol(e.name, e.from);
        return resolved?.reference ?? this.symbolName(e.name);
      }
      case 'binary': {
        const p = PRECEDENCE[e.op] ?? 5;
        const op = PY_OP[e.op] ?? e.op;
        // `**` is right-associative; everything else here is left.
        const left = this.expr(e.left, e.op === '**' ? p + 1 : p);
        const right = this.expr(e.right, e.op === '**' ? p : p + 1);
        return `${left} ${op} ${right}`;
      }
      case 'unary': {
        const op = e.op === '!' ? 'not ' : e.op;
        return `${op}${this.expr(e.operand, 11)}`;
      }
      case 'call':
        return `${this.expr(e.callee, CALL_PREC)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      case 'method':
        return `${this.expr(e.target, CALL_PREC)}.${this.name(e.name)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      case 'member':
        return `${this.expr(e.target, CALL_PREC)}.${this.memberName(e)}`;
      case 'index':
        return `${this.expr(e.target, CALL_PREC)}[${this.expr(e.index)}]`;
      case 'new':
        return `${this.resolvedType(e.className)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      case 'array':
        return `[${e.items.map((i) => this.expr(i)).join(', ')}]`;
      case 'mapLit':
        return `{${e.entries.map((en) => `${this.expr(en.key)}: ${this.expr(en.value)}`).join(', ')}}`;
      case 'tupleLit':
        return e.items.length === 1
          ? `(${this.expr(e.items[0])},)`
          : `(${e.items.map((i) => this.expr(i)).join(', ')})`;
      case 'lambda':
        return this.lambda(e);
      case 'ternary':
        return `${this.expr(e.then, 1)} if ${this.expr(e.cond, 1)} else ${this.expr(e.else, 1)}`;
      case 'cast':
        return this.cast(e);
      case 'await':
        return `await ${this.expr(e.expr, 13)}`;
      case 'builtin':
        return this.builtin(e);
      case 'raw':
        if (e.lang !== 'python' && e.lang !== 'any') {
          throw new BackendGenError(`Raw ${e.lang} expression cannot be emitted into a Python file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: e.origin,
          });
        }
        return e.code.trim();
    }
  }

  private memberName(e: IrExpr & { k: 'member' }): string {
    // Enum member access keeps the SCREAMING form the enum declaration used.
    if (e.target.k === 'symbol' && e.target.type.kind === 'named') return snake(e.name).toUpperCase();
    return this.name(e.name);
  }

  private symbolName(name: string): string {
    return /^[A-Z]/.test(name) ? this.typeName(name) : this.name(name);
  }

  private literal(v: Extract<IrExpr, { k: 'lit' }>['value']): string {
    switch (v.t) {
      case 'bool':
        return v.v ? 'True' : 'False';
      case 'int':
        return String(v.v);
      case 'float':
        return Number.isInteger(v.v) ? `${v.v}.0` : String(v.v);
      case 'string':
      case 'char':
        return pyString(v.v);
      case 'null':
        return 'None';
    }
  }

  private zero(t: TypeRef): string {
    switch (t.kind) {
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return 'False';
          case 'string':
          case 'char':
            return "''";
          case 'f32':
          case 'f64':
            return '0.0';
          case 'bytes':
            return "b''";
          default:
            return '0';
        }
      case 'list':
        return '[]';
      case 'set':
        return 'set()';
      case 'map':
        return '{}';
      case 'tuple':
        return `(${t.items.map((i) => this.zero(i)).join(', ')}${t.items.length === 1 ? ',' : ''})`;
      default:
        return 'None';
    }
  }

  private lambda(e: Extract<IrExpr, { k: 'lambda' }>): string {
    const params = e.params.map((p) => this.name(p.name)).join(', ');
    if (!Array.isArray(e.body)) {
      const prefix = e.isAsync ? 'async ' : '';
      // Python has no async lambda; wrap it in a named coroutine instead.
      if (e.isAsync) return this.namedClosure(e);
      void prefix;
      return `lambda${params ? ` ${params}` : ''}: ${this.expr(e.body, 1)}`;
    }
    return this.namedClosure(e);
  }

  /** Statement-bodied (or async) lambdas become a named nested function. */
  private namedClosure(e: Extract<IrExpr, { k: 'lambda' }>): string {
    const name = `_closure_${++this.lambdaCounter}`;
    const w = new CodeWriter('    ');
    const params = e.params.map((p) => this.param(p)).join(', ');
    const returns = e.type.kind === 'function' ? this.type(e.type.returns) : 'None';
    w.line(`${e.isAsync ? 'async def' : 'def'} ${name}(${params}) -> ${returns}:`);
    w.nest(() => {
      const body = Array.isArray(e.body) ? e.body : [{ k: 'return', value: e.body } as IrStmt];
      if (!body.length) w.line('pass');
      else for (const s of body) this.emitStmtInner(w, s);
    });
    const lines = w.toString().replace(/\n$/, '').split('\n');
    const target = this.pendingHelpers[this.pendingHelpers.length - 1];
    if (target) target.push(lines);
    return name;
  }

  private cast(e: Extract<IrExpr, { k: 'cast' }>): string {
    const inner = this.expr(e.expr, CALL_PREC);
    const to = e.to;
    if (to.kind === 'primitive') {
      switch (to.name) {
        case 'string':
        case 'char':
          return `str(${inner})`;
        case 'i32':
        case 'i64':
          return `int(${inner})`;
        case 'f32':
        case 'f64':
          return `float(${inner})`;
        case 'bool':
          return `bool(${inner})`;
        case 'bytes':
          return `bytes(${inner})`;
      }
    }
    if (to.kind === 'list') return `list(${inner})`;
    if (to.kind === 'set') return `set(${inner})`;
    if (to.kind === 'map') return `dict(${inner})`;
    // Python has no meaningful runtime cast for user types; annotate instead.
    this.needFrom('typing', 'cast');
    return `cast(${this.type(to)}, ${inner})`;
  }

  /** Builtins whose Python form is a statement, not an expression. */
  private statementExpr(e: IrExpr): string {
    if (e.k !== 'builtin') return this.expr(e);
    const a = e.args.map((x) => this.expr(x, CALL_PREC));
    switch (e.op) {
      case 'map_set':
        return `${a[0]}[${a[1]}] = ${a[2]}`;
      case 'list_set':
        return `${a[0]}[${a[1]}] = ${a[2]}`;
      case 'list_remove_at':
        return `del ${a[0]}[${a[1]}]`;
      case 'map_remove':
        return `${a[0]}.pop(${a[1]}, None)`;
      case 'assert':
        return `assert ${this.expr(e.args[0], 1)}, ${a[1] ?? "''"}`;
      case 'assert_eq':
        return `assert ${this.expr(e.args[0], 5)} == ${this.expr(e.args[1], 5)}, ${a[2] ?? "''"}`;
      default:
        return this.expr(e);
    }
  }

  private builtin(e: Extract<IrExpr, { k: 'builtin' }>): string {
    const a = e.args.map((x) => this.expr(x, CALL_PREC));
    const all = a.join(', ');
    const runtime = RUNTIME_OPS[e.op];
    if (runtime) {
      this.needFrom(RUNTIME_MODULE, runtime);
      return `${runtime}(${all})`;
    }

    switch (e.op) {
      // -- io
      case 'print':
        return `print(${all})`;
      case 'print_err':
        this.need('sys');
        return `print(${all}${a.length ? ', ' : ''}file=sys.stderr)`;
      case 'read_line':
        return 'input()';

      // -- convert
      case 'to_string':
        return `str(${a[0]})`;
      case 'to_int':
        return `int(${a[0]})`;
      case 'to_float':
        return `float(${a[0]})`;

      // -- generic
      case 'len':
        return `len(${a[0]})`;
      case 'is_empty':
        return `len(${a[0]}) == 0`;

      // -- string
      case 'str_concat':
        return `${a[0]} + ${a[1]}`;
      case 'str_upper':
        return `${a[0]}.upper()`;
      case 'str_lower':
        return `${a[0]}.lower()`;
      case 'str_trim':
        return `${a[0]}.strip()`;
      case 'str_split':
        return `${a[0]}.split(${a[1]})`;
      case 'str_join':
        return `${a[1]}.join(${a[0]})`;
      case 'str_replace':
        return `${a[0]}.replace(${a[1]}, ${a[2]})`;
      case 'str_contains':
        return `${a[1]} in ${a[0]}`;
      case 'str_starts_with':
        return `${a[0]}.startswith(${a[1]})`;
      case 'str_ends_with':
        return `${a[0]}.endswith(${a[1]})`;
      case 'str_index_of':
        return `${a[0]}.find(${a[1]})`;
      case 'str_substring':
        return `${a[0]}[${a[1]}:${a[2]}]`;
      case 'str_char_at':
        return `${a[0]}[${a[1]}]`;
      case 'str_repeat':
        return `${a[0]} * ${a[1]}`;
      case 'str_pad_left':
        return `${a[0]}.rjust(${a[1]}, ${a[2]})`;
      case 'format':
        return `${a[0]}.format(${a.slice(1).join(', ')})`;

      // -- list
      case 'list_new':
        return '[]';
      case 'list_get':
        return `${a[0]}[${a[1]}]`;
      case 'list_push':
        return `${a[0]}.append(${a[1]})`;
      case 'list_pop':
        return `(${a[0]}.pop() if ${a[0]} else None)`;
      case 'list_insert':
        return `${a[0]}.insert(${a[1]}, ${a[2]})`;
      case 'list_contains':
        return `${a[1]} in ${a[0]}`;
      case 'list_index_of':
        return `(${a[0]}.index(${a[1]}) if ${a[1]} in ${a[0]} else -1)`;
      case 'list_slice':
        return `${a[0]}[${a[1]}:${a[2]}]`;
      case 'list_concat':
        return `${a[0]} + ${a[1]}`;
      case 'list_reverse':
        return `list(reversed(${a[0]}))`;
      case 'list_sort':
        return `sorted(${a[0]})`;
      case 'list_sort_by':
        return `sorted(${a[0]}, key=${a[1]})`;
      case 'list_map':
        return `[${a[1]}(_x) for _x in ${a[0]}]`;
      case 'list_filter':
        return `[_x for _x in ${a[0]} if ${a[1]}(_x)]`;
      case 'list_reduce':
        this.needFrom('functools', 'reduce');
        return `reduce(${a[1]}, ${a[0]}, ${a[2]})`;
      case 'list_any':
        return `any(${a[1]}(_x) for _x in ${a[0]})`;
      case 'list_all':
        return `all(${a[1]}(_x) for _x in ${a[0]})`;
      case 'list_find':
        return `next((_x for _x in ${a[0]} if ${a[1]}(_x)), None)`;
      case 'list_sum':
        return `sum(${a[0]})`;
      case 'list_min':
        return `(min(${a[0]}) if ${a[0]} else None)`;
      case 'list_max':
        return `(max(${a[0]}) if ${a[0]} else None)`;
      case 'list_unique':
        return `list(dict.fromkeys(${a[0]}))`;
      case 'list_range':
        return `list(range(${a[0]}, ${a[1]}))`;

      // -- map / set
      case 'map_new':
        return '{}';
      case 'map_get':
        return `${a[0]}.get(${a[1]})`;
      case 'map_get_or':
        return `${a[0]}.get(${a[1]}, ${a[2]})`;
      case 'map_has':
        return `${a[1]} in ${a[0]}`;
      case 'map_keys':
        return `list(${a[0]}.keys())`;
      case 'map_values':
        return `list(${a[0]}.values())`;
      case 'set_new':
        return 'set()';
      case 'set_add':
        return `${a[0]}.add(${a[1]})`;
      case 'set_has':
        return `${a[1]} in ${a[0]}`;
      case 'set_remove':
        return `${a[0]}.discard(${a[1]})`;
      case 'set_to_list':
        return `sorted(${a[0]})`;

      // -- math
      case 'math_abs':
        return `abs(${a[0]})`;
      case 'math_floor':
        this.need('math');
        return `math.floor(${a[0]})`;
      case 'math_ceil':
        this.need('math');
        return `math.ceil(${a[0]})`;
      case 'math_round':
        return `round(${a[0]})`;
      case 'math_sqrt':
        this.need('math');
        return `math.sqrt(${a[0]})`;
      case 'math_pow':
        return `${a[0]} ** ${a[1]}`;
      case 'math_min':
        return `min(${a[0]}, ${a[1]})`;
      case 'math_max':
        return `max(${a[0]}, ${a[1]})`;
      case 'math_log':
        this.need('math');
        return `math.log(${a[0]})`;
      case 'math_exp':
        this.need('math');
        return `math.exp(${a[0]})`;
      case 'math_sin':
        this.need('math');
        return `math.sin(${a[0]})`;
      case 'math_cos':
        this.need('math');
        return `math.cos(${a[0]})`;
      case 'math_tan':
        this.need('math');
        return `math.tan(${a[0]})`;
      case 'math_atan2':
        this.need('math');
        return `math.atan2(${a[0]}, ${a[1]})`;
      case 'math_idiv':
        return `${a[0]} // ${a[1]}`;
      case 'math_pi':
        this.need('math');
        return 'math.pi';

      // -- json
      case 'json_parse':
        this.need('json');
        return `json.loads(${a[0]})`;
      case 'json_stringify':
        this.need('json');
        return `json.dumps(${a[0]}, indent=(2 if ${a[1] ?? 'False'} else None))`;
      case 'json_get':
        return `${a[0]}.get(${a[1]})`;
      case 'json_as_string':
        return `str(${a[0]})`;
      case 'json_as_number':
        return `float(${a[0]})`;
      case 'json_as_list':
        return `list(${a[0]})`;

      // -- filesystem
      case 'file_read_text':
        this.needFrom('pathlib', 'Path');
        return `Path(${a[0]}).read_text(encoding='utf-8')`;
      case 'file_write_text':
        this.needFrom('pathlib', 'Path');
        return `Path(${a[0]}).write_text(${a[1]}, encoding='utf-8')`;
      case 'file_append_text':
        this.need('io');
        return `open(${a[0]}, 'a', encoding='utf-8').write(${a[1]})`;
      case 'file_exists':
        this.needFrom('pathlib', 'Path');
        return `Path(${a[0]}).exists()`;
      case 'file_delete':
        this.needFrom('pathlib', 'Path');
        return `Path(${a[0]}).unlink(missing_ok=True)`;
      case 'dir_list':
        this.need('os');
        return `sorted(os.listdir(${a[0]}))`;
      case 'dir_create':
        this.needFrom('pathlib', 'Path');
        return `Path(${a[0]}).mkdir(parents=True, exist_ok=True)`;
      case 'path_join':
        this.need('os');
        return `os.path.join(${a[0]}, ${a[1]})`;

      // -- environment / time / random
      case 'env_get':
        this.need('os');
        return `os.environ.get(${a[0]})`;
      case 'args_get':
        this.need('sys');
        return 'sys.argv[1:]';
      case 'time_now_ms':
        this.need('time');
        return 'int(time.time() * 1000)';
      case 'time_sleep_ms':
        this.need('time');
        return `time.sleep(${a[0]} / 1000.0)`;
      case 'random_float':
        this.need('random');
        return 'random.random()';
      case 'random_int':
        this.need('random');
        return `random.randrange(${a[0]}, ${a[1]})`;

      // -- optional values
      case 'option_is_some':
        return `(${a[0]} is not None)`;

      // -- encoding and digests
      case 'base64_encode':
        this.need('base64');
        return `base64.b64encode(${a[0]}.encode('utf-8')).decode('ascii')`;
      case 'hex_encode':
        return `${a[0]}.encode('utf-8').hex()`;
      // quote() leaves exactly A-Z a-z 0-9 _ . - ~ alone, which is the set the
      // builtin promises; safe='' stops it from sparing the slash as well.
      case 'url_encode':
        this.need('urllib.parse');
        return `urllib.parse.quote(${a[0]}, safe='')`;
      case 'url_decode':
        this.need('urllib.parse');
        return `urllib.parse.unquote(${a[0]})`;
      case 'hash_sha256':
        this.need('hashlib');
        return `hashlib.sha256(${a[0]}.encode('utf-8')).hexdigest()`;
      case 'hash_sha1':
        this.need('hashlib');
        return `hashlib.sha1(${a[0]}.encode('utf-8')).hexdigest()`;
      case 'hash_md5':
        this.need('hashlib');
        return `hashlib.md5(${a[0]}.encode('utf-8')).hexdigest()`;
      case 'hmac_sha256':
        this.need('hashlib');
        this.need('hmac');
        return `hmac.new(${a[0]}.encode('utf-8'), ${a[1]}.encode('utf-8'), hashlib.sha256).hexdigest()`;
      case 'uuid_v4':
        this.need('uuid');
        return 'str(uuid.uuid4())';

      // -- errors and tests
      case 'error_new':
        return `Exception(${a[0]})`;
      case 'error_message':
        return `str(${a[0]})`;
      case 'assert':
        // Reached only when an assertion is used in expression position.
        return `(${a[0]} or _raise_assert(${a[1] ?? "''"}))`;
      case 'assert_eq':
        return `(${a[0]} == ${a[1]} or _raise_assert(${a[2] ?? "''"}))`;

      default:
        throw new BackendGenError(`The Python backend does not implement the "${e.op}" operation.`, {
          code: 'codegen/unsupported-builtin',
          origin: e.origin,
          hint: 'Replace the node with a Custom Code node, or add the mapping to the Python backend.',
        });
    }
  }
}

function constructorAssigns(ctor: IrFunction, field: string): boolean {
  return ctor.body.some(
    (s) => s.k === 'assign' && s.target.k === 'member' && s.target.target.k === 'self' && s.target.name === field,
  );
}

function zeroIr(t: TypeRef): IrExpr {
  switch (t.kind) {
    case 'primitive':
      if (t.name === 'bool') return { k: 'lit', value: { t: 'bool', v: false }, type: t };
      if (t.name === 'string' || t.name === 'char') return { k: 'lit', value: { t: 'string', v: '' }, type: t };
      if (t.name === 'f32' || t.name === 'f64') return { k: 'lit', value: { t: 'float', v: 0 }, type: t };
      return { k: 'lit', value: { t: 'int', v: 0 }, type: t };
    case 'list':
      return { k: 'array', items: [], type: t };
    case 'map':
      return { k: 'mapLit', entries: [], type: t };
    default:
      return { k: 'lit', value: { t: 'null' }, type: t };
  }
}

function modulePathToDotted(path: string): string {
  return path
    .replace(/^src\//, '')
    .split('/')
    .filter(Boolean)
    .map((s) => snake(s))
    .join('.');
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

export const pythonBackend: LanguageBackend = {
  id: 'python',
  name: 'Python 3',
  maturity: 'full',
  extensions: ['.py', '.pyi'],
  features: defaultFeatures({ compiled: false, staticTypes: false }),
  lineComment: '#',
  blockComment: { open: '"""', close: '"""' },
  indent: '    ',
  keywords: KEYWORDS,

  packageManager: {
    id: 'pip',
    name: 'pip',
    installAll: { label: 'pip install -r requirements.txt', command: 'python', args: ['-m', 'pip', 'install', '-r', 'requirements.txt'] },
    installOne: { label: 'pip install', command: 'python', args: ['-m', 'pip', 'install', '{name}=={version}'] },
    manifestFile: 'requirements.txt',
  },

  toolchain: [
    {
      command: 'python',
      versionArgs: ['--version'],
      installHint: 'Install Python 3.10 or newer from python.org, or your package manager.',
    },
  ],

  entry: {
    file: 'src/main.py',
    symbol: 'main',
    description: 'A module with a main() function, guarded by the __main__ check.',
  },

  sourceRoot: () => 'src',
  testRoot: () => 'tests',

  pathFor(file) {
    return file.path;
  },

  mapType(type, project) {
    // A standalone mapping needs a scratch emitter for the import side effects,
    // which callers outside code generation do not care about.
    const emitter = new PythonEmitter({
      project,
      program: { name: '', language: 'python', modules: [], dependencies: [] },
      module: { id: '', name: '', path: '', imports: [], decls: [] },
      file: { id: '', path: '', language: 'python', kind: 'generated', role: 'source', exports: [], imports: [] },
      diag: { items: [] } as never,
      resolveSymbol: () => undefined,
      dependencies: [],
    });
    return emitter.type(type);
  },

  importFor(_from, to, symbols) {
    const dotted = modulePathToDotted(to.path);
    return symbols.length ? `from ${dotted} import ${symbols.join(', ')}` : `import ${dotted}`;
  },

  emitModule(ctx) {
    return new PythonEmitter(ctx).emit();
  },

  emitProjectFiles(project, program) {
    const files: GeneratedFile[] = [];
    const deps = project.dependencies.filter((d) => d.language === 'python');

    files.push({
      path: 'requirements.txt',
      role: 'manifest',
      content:
        `# Dependencies for ${project.name}.\n` +
        `# Master Code records requirements here but never installs them for you.\n` +
        `# Install with:  python -m pip install -r requirements.txt\n` +
        (deps.length
          ? deps
              .map((d) => (d.version && d.version !== '*' ? `${d.name}==${d.version}` : d.name))
              .sort()
              .join('\n') + '\n'
          : '# (no external dependencies)\n'),
    });

    files.push({
      path: 'pyproject.toml',
      role: 'manifest',
      content: [
        '[project]',
        `name = "${project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}"`,
        `version = "${project.version}"`,
        `description = ${JSON.stringify(project.description ?? '')}`,
        'requires-python = ">=3.10"',
        `dependencies = [${deps.map((d) => JSON.stringify(d.version && d.version !== '*' ? `${d.name}==${d.version}` : d.name)).join(', ')}]`,
        '',
        '[build-system]',
        'requires = ["setuptools>=68"]',
        'build-backend = "setuptools.build_meta"',
        '',
        '[tool.setuptools]',
        'package-dir = { "" = "src" }',
        '',
      ].join('\n'),
    });

    const ops = usedBuiltins(program);
    if (Object.keys(RUNTIME_OPS).some((op) => ops.has(op))) {
      files.push({
        path: `src/${RUNTIME_MODULE}.py`,
        role: 'source',
        content: PYTHON_RUNTIME,
      });
    }

    // Package markers so `src/models/user.py` is importable as `models.user`.
    const dirs = new Set<string>();
    for (const m of program.modules) {
      // Only source modules become packages; tests are found by path.
      if (!m.path.startsWith('src/')) continue;
      const parts = m.path.replace(/^src\//, '').split('/');
      parts.pop();
      let acc = '';
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        dirs.add(acc);
      }
    }
    for (const d of [...dirs].sort()) {
      files.push({ path: `src/${d}/__init__.py`, role: 'source', content: `"""Package ${d.replace(/\//g, '.')}."""\n` });
    }

    return files;
  },

  buildPlan(project, mode) {
    // Python has no compile step; a syntax check is the closest useful thing
    // and gives the user real errors before running.
    return {
      steps: [
        {
          label: 'Byte-compile sources (syntax check)',
          command: 'python',
          args: ['-m', 'compileall', '-q', project.build.sourceDir || 'src'],
        },
      ],
      note: mode === 'release' ? 'Release mode only affects the run command (-O).' : undefined,
    };
  },

  runPlan(project, mode): RunPlan {
    const entry = project.files.find((f) => f.role === 'entry' && f.language === 'python');
    const args = mode === 'release' ? ['-O'] : [];
    return {
      command: {
        label: 'Run',
        command: 'python',
        args: [...args, entry?.path ?? 'src/main.py'],
        env: { PYTHONPATH: 'src', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
      },
    };
  },

  testPlan(project): BuildPlan {
    return {
      steps: [
        {
          label: 'Run tests (unittest discovery)',
          command: 'python',
          args: ['-m', 'unittest', 'discover', '-s', project.build.sourceDir ? 'tests' : 'tests', '-v'],
          env: { PYTHONPATH: 'src' },
        },
      ],
    };
  },

  parseDiagnostics(output): Diagnostic[] {
    const out: Diagnostic[] = [];
    const lines = output.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // Traceback frames: `  File "src/main.py", line 12, in main`
      const frame = /^\s*File "([^"]+)", line (\d+)/.exec(lines[i]);
      if (frame) {
        const message = lines.slice(i + 1).find((l) => /^\w+(Error|Exception|Warning):/.test(l.trim()));
        if (message) {
          out.push({
            severity: 'error',
            stage: 'runtime',
            code: 'python/exception',
            message: message.trim(),
            file: frame[1].replace(/\\/g, '/'),
            line: Number(frame[2]),
            raw: lines[i],
          });
        }
        continue;
      }
      // compileall: `*** File "src/x.py", line 3` then `SyntaxError: ...`
      const syn = /^\s*(SyntaxError|IndentationError|TabError): (.+)$/.exec(lines[i]);
      if (syn && !out.some((d) => d.message.startsWith(syn[1]))) {
        const prev = lines.slice(Math.max(0, i - 4), i).reverse().find((l) => l.includes('File "'));
        const m = prev ? /File "([^"]+)", line (\d+)/.exec(prev) : null;
        out.push({
          severity: 'error',
          stage: 'build',
          code: 'python/syntax',
          message: `${syn[1]}: ${syn[2]}`,
          file: m?.[1].replace(/\\/g, '/'),
          line: m ? Number(m[2]) : undefined,
          raw: lines[i],
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Runtime support module
// ---------------------------------------------------------------------------

const PYTHON_RUNTIME = `"""Runtime helpers used by generated Master Code programs.

Only the operations that have no single-expression standard-library form live
here: checked parsing, HTTP, and thin SQLite wrappers. Everything else is
emitted inline against the standard library.

This file is generated. Edit the graph, not this.
"""

from __future__ import annotations

import concurrent.futures as _futures
import datetime as _datetime
import http.server
import json as _json
import sys as _sys
import re as _re
import sqlite3
import urllib.error
import urllib.request
from dataclasses import dataclass, field


def parse_int(text: str) -> int | None:
    """Integer value of *text*, or None when it does not parse."""
    try:
        return int(text.strip())
    except (TypeError, ValueError):
        return None


def parse_float(text: str) -> float | None:
    """Float value of *text*, or None when it does not parse."""
    try:
        return float(text.strip())
    except (TypeError, ValueError):
        return None


@dataclass
class HttpResponse:
    """Outcome of an HTTP request. A transport failure yields status 0."""

    status: int = 0
    body: str = ""
    headers: dict[str, str] = field(default_factory=dict)

    def json(self):
        return _json.loads(self.body) if self.body else None


def http_request(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    body: str = "",
) -> HttpResponse:
    """Perform an HTTP request. Never raises: transport errors become status 0."""
    data = body.encode("utf-8") if body else None
    request = urllib.request.Request(url, data=data, method=method.upper())
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return HttpResponse(
                status=response.status,
                body=response.read().decode("utf-8", errors="replace"),
                headers={k.lower(): v for k, v in response.headers.items()},
            )
    except urllib.error.HTTPError as exc:
        return HttpResponse(
            status=exc.code,
            body=exc.read().decode("utf-8", errors="replace"),
            headers={k.lower(): v for k, v in (exc.headers or {}).items()},
        )
    except (urllib.error.URLError, OSError) as exc:
        return HttpResponse(status=0, body=str(exc), headers={})


def db_open(path: str) -> sqlite3.Connection:
    """Open (or create) a SQLite database and return rows as mappings."""
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def db_execute(connection: sqlite3.Connection, sql: str, params: list = None) -> int:
    """Run a statement and commit. Returns the number of affected rows."""
    cursor = connection.execute(sql, tuple(params or ()))
    connection.commit()
    return cursor.rowcount


def db_query(connection: sqlite3.Connection, sql: str, params: list = None) -> list[dict]:
    """Run a query and return every row as a dict."""
    cursor = connection.execute(sql, tuple(params or ()))
    return [dict(row) for row in cursor.fetchall()]


def db_close(connection: sqlite3.Connection) -> None:
    """Close a connection opened by db_open."""
    connection.close()


def schedule_every(millis: int, task) -> None:
    """Run *task*, wait, repeat, until the process is stopped.

    A fixed gap between runs rather than a fixed rate: a timer that fired on
    schedule would start a second poll while the first was still waiting on a
    slow API, and two pollers reading the same cursor ingest the same feed
    twice.
    """
    import time as _time

    while True:
        task()
        _time.sleep(millis / 1000.0)


def json_path(value, path: str):
    """Follow a dotted path into a parsed value, or None.

    Missing is not an error: an optional field that is absent is the ordinary
    case when reading someone else's JSON, and the graph decides what to do
    about it with Value Or Default or Require Value.
    """
    current = value
    for step in str(path).split("."):
        if not step:
            continue
        name = _re.sub(r"\\[\\d+\\]", "", step)
        if name:
            if current is None:
                return None
            try:
                current = current[name]
            except (KeyError, IndexError, TypeError):
                return None
        for index in _re.findall(r"\\[(\\d+)\\]", step):
            if current is None:
                return None
            try:
                current = current[int(index)]
            except (KeyError, IndexError, TypeError):
                return None
    return current


def _run_pool(count: int, limit: int, worker):
    """Run worker(index) for each index, at most *limit* at a time, in order.

    A thread pool rather than asyncio: every effectful helper here is a
    blocking call, and threads are what make blocking calls overlap. The width
    is capped by the caller because the far end usually has a rate limit that
    the machine's core count knows nothing about.
    """
    if count == 0:
        return []
    width = max(1, min(int(limit) or 1, count))
    with _futures.ThreadPoolExecutor(max_workers=width) as pool:
        futures = [pool.submit(worker, index) for index in range(count)]
        # Indexing rather than as_completed: the contract is input order.
        return [future.result() for future in futures]


def parallel_map(items, fn, limit: int) -> list:
    """Apply *fn* to every element, up to *limit* at a time, in order."""
    values = list(items or [])
    return _run_pool(len(values), limit, lambda index: fn(values[index]))


def parallel_all(tasks, limit: int) -> list:
    """Run every task, up to *limit* at a time, in order."""
    values = list(tasks or [])
    return _run_pool(len(values), limit, lambda index: values[index]())


@dataclass
class HttpRequest:
    """One inbound request, as the graph sees it."""

    method: str
    path: str
    body: str
    headers: dict
    query: dict


@dataclass
class HttpReply:
    """The answer a handler returns."""

    status: int
    body: str
    contentType: str


def http_reply(status: int, body: str, content_type: str) -> HttpReply:
    """Build a reply for http_serve to send."""
    return HttpReply(status=status, body=body, contentType=content_type)


def http_serve(host: str, port: int, handler) -> None:
    """Listen on host:port, answering every request with *handler*.

    Threaded so that one slow handler does not stall the next request, and
    daemon_threads so Ctrl-C stops the process instead of hanging on an open
    connection. Does not return while the server is running.
    """
    import urllib.parse

    class _Handler(http.server.BaseHTTPRequestHandler):
        def _respond(self):
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
            parts = urllib.parse.urlsplit(self.path)
            request = HttpRequest(
                method=self.command,
                path=parts.path,
                body=body,
                headers={k.lower(): v for k, v in self.headers.items()},
                query={k: v[-1] for k, v in urllib.parse.parse_qs(parts.query).items()},
            )
            try:
                reply = handler(request) or http_reply(204, "", "text/plain")
            except Exception as error:
                # A handler that raised is a mistake in the graph, not a bad
                # request, so it is reported rather than hidden behind a 200.
                print(f"request handler failed: {error}", file=_sys.stderr)
                reply = http_reply(500, "internal error", "text/plain")
            payload = (reply.body or "").encode("utf-8")
            self.send_response(reply.status)
            self.send_header("content-type", reply.contentType or "text/plain")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

        do_GET = _respond
        do_POST = _respond
        do_PUT = _respond
        do_PATCH = _respond
        do_DELETE = _respond
        do_HEAD = _respond

    server = http.server.ThreadingHTTPServer((host, port), _Handler)
    server.daemon_threads = True
    print(f"listening on http://{host}:{port}", file=_sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def option_or(value, fallback):
    """The value when present, the fallback when empty.

    A helper rather than an inline conditional because Python has no
    null-coalescing operator, and the inline form would evaluate the optional
    twice - two dictionary lookups, or two HTTP calls.
    """
    return fallback if value is None else value


def require_value(value, message: str):
    """The value, or a readable error naming what was expected."""
    if value is None:
        raise ValueError(f"expected a value: {message}")
    return value


def _compile(pattern: str):
    """Compile *pattern*, naming it when it will not compile.

    A bad pattern is a mistake in the graph, and the message should say which
    pattern rather than surfacing re's own context-free complaint.
    """
    try:
        return _re.compile(pattern)
    except _re.error as cause:
        raise ValueError(f"invalid pattern {pattern!r}: {cause}") from cause


def regex_match(text: str, pattern: str) -> bool:
    """True when *pattern* is found anywhere in *text*."""
    return _compile(pattern).search(text) is not None


def regex_find_all(text: str, pattern: str) -> list:
    """Every non-overlapping whole match.

    re.findall would return the capture groups instead as soon as the pattern
    has any, which is not what the builtin promises; finditer never does that.
    """
    return [m.group(0) for m in _compile(pattern).finditer(text)]


def regex_capture(text: str, pattern: str) -> list:
    """Groups of the first match, index 0 being the whole match."""
    match = _compile(pattern).search(text)
    if match is None:
        return []
    return [match.group(0)] + [g if g is not None else "" for g in match.groups()]


def regex_replace(text: str, pattern: str, replacement: str) -> str:
    """Replace every match, with $1..$9 and $$ as the only substitutions.

    re.sub reads backslash escapes instead, so the template is translated and
    everything else - a stray backslash included - is passed through literally.
    """

    def expand(match):
        out = []
        index = 0
        while index < len(replacement):
            char = replacement[index]
            following = replacement[index + 1] if index + 1 < len(replacement) else ""
            if char == "$" and following == "$":
                out.append("$")
                index += 2
            elif char == "$" and following.isdigit() and following != "0":
                group = int(following)
                out.append(match.group(group) or "" if group <= len(match.groups()) else "")
                index += 2
            else:
                out.append(char)
                index += 1
        return "".join(out)

    return _compile(pattern).sub(expand, text)


def regex_split(text: str, pattern: str) -> list:
    """Split on every match.

    re.split interleaves the capture groups when the pattern has any, so the
    spans between matches are collected directly instead.
    """
    parts = []
    position = 0
    for match in _compile(pattern).finditer(text):
        parts.append(text[position:match.start()])
        position = match.end()
    parts.append(text[position:])
    return parts


def base64_decode(encoded: str) -> str:
    """Decode standard base64. Input that is not base64 raises, never returns ''."""
    import base64 as _base64
    import binascii

    try:
        return _base64.b64decode(encoded, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError) as cause:
        raise ValueError(f"not valid base64: {encoded[:32]!r}") from cause


def time_now_iso() -> str:
    """The current UTC instant, ISO 8601 with milliseconds and a trailing Z."""
    return time_format_iso(int(_datetime.datetime.now(_datetime.timezone.utc).timestamp() * 1000))


def time_parse_iso(text: str):
    """Milliseconds since the epoch, or None.

    A timestamp with no zone is read as UTC. fromisoformat would leave it naive
    and the later timestamp() call would apply the machine's local offset, so
    the same graph would produce different numbers on two machines.
    """
    raw = text.strip()
    if raw.endswith(("Z", "z")):
        raw = raw[:-1] + "+00:00"
    try:
        moment = _datetime.datetime.fromisoformat(raw)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_datetime.timezone.utc)
    return int(moment.timestamp() * 1000)


def time_format_iso(millis: int) -> str:
    """Milliseconds since the epoch as ISO 8601 UTC. Inverse of time_parse_iso."""
    moment = _datetime.datetime.fromtimestamp(millis / 1000.0, _datetime.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _raise_assert(message: str):
    raise AssertionError(message)
`;

export { PythonEmitter };
export const __pythonTypeToString = typeToString;
