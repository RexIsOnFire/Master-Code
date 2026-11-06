/**
 * JavaScript backend (ES modules).
 *
 * Emits plain ESM with JSDoc type annotations rather than TypeScript, so the
 * generated project runs unmodified in both Node and a browser with no build
 * step, while editors still get full type information.
 *
 * Module specifiers always carry the `.js` extension, because that is what the
 * browser's module loader requires and what Node's ESM resolver requires. The
 * one thing that differs by host is the runtime helper set: `node:sqlite` is
 * only reachable under Node, and the backend says so rather than emitting code
 * that would fail at load time in a page.
 */

import type {
  BuildMode,
  BuildPlan,
  EmitContext,
  GeneratedFile,
  LanguageBackend,
  RunPlan,
} from './backend.ts';
import { BackendGenError, defaultFeatures, generatedHeader } from './backend.ts';
import { CodeWriter, avoidKeyword, camel, cString, pascal, screamingSnake, wrapText } from './emitter.ts';
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
  IrParam,
  IrProgram,
  IrStmt,
} from '../ir/ir.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project, ProjectFile } from '../model/project.ts';
import type { TypeRef } from '../types/types.ts';

const KEYWORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'static', 'implements', 'interface',
  'package', 'private', 'protected', 'public', 'arguments', 'eval',
]);

const RUNTIME_MODULE = '_mcode_runtime.js';
const RUNTIME_OPS: Record<string, string> = {
  http_request: 'httpRequest',
  parse_int: 'parseIntOrNull',
  parse_float: 'parseFloatOrNull',
  db_open: 'dbOpen',
  db_execute: 'dbExecute',
  db_query: 'dbQuery',
  db_close: 'dbClose',
  assert: 'mcAssert',
  assert_eq: 'mcAssertEqual',
  format: 'formatText',
  regex_match: 'regexMatch',
  regex_find_all: 'regexFindAll',
  regex_capture: 'regexCapture',
  regex_replace: 'regexReplace',
  regex_split: 'regexSplit',
  base64_encode: 'base64Encode',
  base64_decode: 'base64Decode',
  hex_encode: 'hexEncode',
  url_encode: 'urlEncode',
  url_decode: 'urlDecode',
  hmac_sha256: 'hmacSha256Hex',
  uuid_v4: 'uuidV4',
  time_parse_iso: 'parseIsoMillis',
  option_unwrap: 'requireValue',
  http_serve: 'httpServe',
  http_reply: 'httpReply',
  parallel_map: 'parallelMap',
  parallel_all: 'parallelAll',
  schedule_every: 'scheduleEvery',
  json_path: 'jsonPath',
};

const PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11,
};
const CALL_PREC = 17;
const ATOM_PREC = 20;

const JS_OP: Partial<Record<BinaryOp, string>> = { '==': '===', '!=': '!==' };

class JsEmitter {
  private readonly ctx: EmitContext;
  private readonly runtimeImports = new Set<string>();
  private readonly nodeImports = new Map<string, Set<string>>();

  constructor(ctx: EmitContext) {
    this.ctx = ctx;
  }

  emit(): string {
    const { module, file, project } = this.ctx;
    const body = new CodeWriter('  ');

    for (const decl of module.decls) this.emitDecl(body, decl);
    if (module.main?.length) {
      body.blank();
      for (const s of module.main) this.emitStmt(body, s);
    }

    const entry = module.decls.find((d): d is IrFunction => d.k === 'function' && !!d.isEntry);
    if (entry) {
      body.blank();
      // An entry that waits for something has to be awaited here too, or the
      // module finishes while the work is still in flight and a failure
      // surfaces as an unhandled rejection with no stack worth reading. These
      // modules are ESM, where top-level await is available.
      body.line(`${entry.isAsync ? 'await ' : ''}${this.name(entry.name)}();`);
    }

    // `node --test` looks for test() registrations, not bare functions, so a
    // test file gets an adapter that registers each generated function.
    if (file.role === 'test') {
      const tests = module.decls.filter(
        (d): d is IrFunction => d.k === 'function' && /^test/i.test(d.name),
      );
      if (tests.length) {
        this.nodeModule('node:test', 'test');
        body.blank();
        for (const t of tests) {
          body.line(`test(${cString(t.name)}, () => { ${this.name(t.name)}(); });`);
        }
      }
    }
    // A browser graph rooted in "On Page Ready" needs its handler registered.
    if (module.decls.some((d) => d.k === 'function' && d.name === 'onReady')) {
      body.blank();
      body.line("if (typeof document !== 'undefined') {");
      body.nest(() => {
        body.line("if (document.readyState === 'loading') {");
        body.nest(() => body.line("document.addEventListener('DOMContentLoaded', onReady);"));
        body.line('} else {');
        body.nest(() => body.line('onReady();'));
        body.line('}');
      });
      body.line('}');
    }

    const head = new CodeWriter('  ');
    for (const l of generatedHeader(javascriptBackend, file, project)) head.line(l);
    if (module.doc) {
      head.blank();
      head.line('/**');
      for (const l of wrapText(module.doc)) head.line(` * ${l}`);
      head.line(' */');
    }

    const imports = this.renderImports(module);
    if (imports.length) {
      head.blank();
      imports.forEach((l) => head.line(l));
    }
    if (file.kind === 'hybrid') {
      head.blank();
      head.line('// <mcode:region id="user-imports">');
      head.line('// </mcode:region>');
    }
    head.blank();
    head.block(body.toString().trim() || '// nothing generated yet');
    if (file.kind === 'hybrid') {
      head.blank();
      head.line('// <mcode:region id="user-code">');
      head.line('// </mcode:region>');
    }
    return head.toString();
  }

  private renderImports(module: IrModule): string[] {
    const out: string[] = [];
    for (const [mod, names] of [...this.nodeImports].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`import { ${[...names].sort().join(', ')} } from '${mod}';`);
    }
    if (this.runtimeImports.size) {
      const rel = relativeSpecifier(this.ctx.module.path, `src/${RUNTIME_MODULE.replace('.js', '')}`);
      out.push(`import { ${[...this.runtimeImports].sort().join(', ')} } from '${rel}';`);
    }
    for (const imp of module.imports) out.push(this.renderImport(imp));
    return out;
  }

  private renderImport(imp: IrImport): string {
    const target =
      imp.source === 'file'
        ? relativeSpecifier(
            this.ctx.module.path,
            this.ctx.program.modules.find((m) => m.id === imp.target)?.path ?? imp.target,
          )
        : imp.source === 'stdlib'
          ? `node:${imp.target.replace(/^node:/, '')}`
          : imp.target;
    if (imp.wildcard) return `import * as ${imp.alias ?? camel(imp.target)} from '${target}';`;
    if (imp.symbols?.length) {
      const names = imp.symbols.map((s) => (s.alias ? `${s.name} as ${s.alias}` : s.name)).join(', ');
      return `import { ${names} } from '${target}';`;
    }
    return `import ${imp.alias ?? camel(imp.target)} from '${target}';`;
  }

  private runtime(name: string): string {
    this.runtimeImports.add(name);
    return name;
  }

  private nodeModule(mod: string, symbol: string): string {
    let s = this.nodeImports.get(mod);
    if (!s) {
      s = new Set();
      this.nodeImports.set(mod, s);
    }
    s.add(symbol);
    return symbol;
  }

  private name(raw: string): string {
    return avoidKeyword(camel(raw), KEYWORDS);
  }

  private typeName(raw: string): string {
    return avoidKeyword(pascal(raw), KEYWORDS);
  }

  // -- JSDoc types -----------------------------------------------------------

  type(t: TypeRef): string {
    switch (t.kind) {
      case 'void':
      case 'exec':
        return 'void';
      case 'any':
        return '*';
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return 'boolean';
          case 'string':
          case 'char':
            return 'string';
          case 'bytes':
            return 'Uint8Array';
          default:
            return 'number';
        }
      case 'list':
        return `Array<${this.type(t.item)}>`;
      case 'set':
        return `Set<${this.type(t.item)}>`;
      case 'map':
        return `Map<${this.type(t.key)}, ${this.type(t.value)}>`;
      case 'option':
        return `?${this.type(t.inner)}`;
      case 'tuple':
        return `[${t.items.map((i) => this.type(i)).join(', ')}]`;
      case 'future':
        return `Promise<${this.type(t.inner)}>`;
      case 'result':
        return this.type(t.ok);
      case 'function':
        return `function(${t.params.map((p) => this.type(p)).join(', ')}): ${this.type(t.returns)}`;
      case 'named':
        switch (t.name) {
          case 'Error':
            return 'Error';
          case 'Json':
            return '*';
          case 'HttpResponse':
            return 'HttpResponse';
          case 'DbConnection':
            return 'DatabaseSync';
          case 'Element':
            return 'Element';
          default:
            return this.resolvedType(t.name);
        }
      case 'var':
        return '*';
    }
  }

  // -- declarations ----------------------------------------------------------

  private emitDecl(w: CodeWriter, d: IrDecl): void {
    switch (d.k) {
      case 'function':
        this.emitFunction(w, d, false, true);
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
      case 'global':
        w.blank();
        if (d.doc) w.line(`/** ${d.doc} */`);
        w.line(
          `export ${d.constant ? 'const' : 'let'} ${d.constant ? screamingSnake(d.name) : this.name(d.name)} = ` +
            `${d.init ? this.expr(d.init) : this.zero(d.type)};`,
        );
        break;
      case 'typeAlias':
        w.blank();
        w.line(`/** @typedef {${this.type(d.target)}} ${this.typeName(d.name)} */`);
        break;
      case 'rawDecl':
        if (d.lang !== 'javascript' && d.lang !== 'any') {
          throw new BackendGenError(`Raw ${d.lang} block cannot be emitted into a JavaScript file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: d.origin,
          });
        }
        w.blank();
        w.verbatim(d.code);
        break;
    }
  }

  private jsdoc(w: CodeWriter, f: IrFunction): void {
    const lines: string[] = [];
    if (f.doc?.trim()) lines.push(...wrapText(f.doc.trim()));
    for (const p of f.params) lines.push(`@param {${this.type(p.type)}} ${this.name(p.name)}`);
    if (f.returns.kind !== 'void') lines.push(`@returns {${this.type(f.returns)}}`);
    if (!lines.length) return;
    if (lines.length === 1) {
      w.line(`/** ${lines[0]} */`);
      return;
    }
    w.line('/**');
    for (const l of lines) w.line(` * ${l}`);
    w.line(' */');
  }

  private emitFunction(w: CodeWriter, f: IrFunction, insideClass: boolean, exported: boolean): void {
    w.blank();
    this.jsdoc(w, f);
    const params = f.params.map((p) => this.param(p)).join(', ');
    const asyncKw = f.isAsync ? 'async ' : '';
    if (insideClass) {
      const name = f.name === 'constructor' ? 'constructor' : this.name(f.name);
      const staticKw = f.isStatic ? 'static ' : '';
      const prefix = f.visibility === 'private' && name !== 'constructor' ? '#' : '';
      w.braced(`${staticKw}${asyncKw}${prefix}${name}(${params})`, () => this.emitBody(w, f.body));
      return;
    }
    const exportKw = exported && f.visibility !== 'private' ? 'export ' : '';
    w.braced(`${exportKw}${asyncKw}function ${this.name(f.name)}(${params})`, () => this.emitBody(w, f.body));
  }

  private param(p: IrParam): string {
    const base = `${p.rest ? '...' : ''}${this.name(p.name)}`;
    return p.default ? `${base} = ${this.expr(p.default)}` : base;
  }

  private emitBody(w: CodeWriter, body: IrStmt[]): void {
    for (const s of body) this.emitStmt(w, s);
  }

  private emitClass(w: CodeWriter, c: IrClass): void {
    w.blank();
    if (c.doc?.trim()) w.line(`/** ${wrapText(c.doc.trim()).join(' ')} */`);
    const ext = c.extends ? ` extends ${this.type(c.extends)}` : '';
    if (c.implements?.length) {
      w.line(`/** @implements {${c.implements.map((i) => this.type(i)).join('} @implements {')}} */`);
    }
    w.braced(`export class ${this.typeName(c.name)}${ext}`, () => {
      for (const f of c.fields) {
        if (f.doc) w.line(`/** @type {${this.type(f.type)}} ${f.doc} */`);
        else w.line(`/** @type {${this.type(f.type)}} */`);
        const prefix = f.isStatic ? 'static ' : '';
        w.line(`${prefix}${this.name(f.name)} = ${f.init ? this.expr(f.init) : this.zero(f.type)};`);
      }
      if (c.ctor) this.emitFunction(w, { ...c.ctor, name: 'constructor' }, true, false);
      for (const m of c.methods) this.emitFunction(w, m, true, false);
    });
  }

  private emitInterface(w: CodeWriter, i: IrInterface): void {
    // JavaScript has no interfaces; a JSDoc typedef carries the contract so
    // editors and type-checkers still see it.
    w.blank();
    w.line('/**');
    if (i.doc?.trim()) w.line(` * ${i.doc.trim()}`);
    w.line(` * @typedef {Object} ${this.typeName(i.name)}`);
    for (const f of i.fields ?? []) w.line(` * @property {${this.type(f.type)}} ${this.name(f.name)}`);
    for (const m of i.methods) {
      const sig = `function(${m.params.map((p) => this.type(p.type)).join(', ')}): ${this.type(m.returns)}`;
      w.line(` * @property {${sig}} ${this.name(m.name)}`);
    }
    w.line(' */');
  }

  private emitEnum(w: CodeWriter, e: IrEnum): void {
    w.blank();
    if (e.doc?.trim()) w.line(`/** ${e.doc.trim()} */`);
    w.line(`export const ${this.typeName(e.name)} = Object.freeze({`);
    w.nest(() => {
      e.variants.forEach((v) => {
        const value = v.value ? this.literal(v.value) : cString(v.name);
        w.line(`${screamingSnake(v.name)}: ${value},`);
      });
    });
    w.line('});');
  }

  // -- statements ------------------------------------------------------------

  private emitStmt(w: CodeWriter, s: IrStmt): void {
    if (s.comment) w.line(`// ${s.comment}`);
    switch (s.k) {
      case 'note':
        for (const l of s.text.split('\n')) w.line(`// ${l}`);
        break;
      case 'let':
        w.line(`/** @type {${this.type(s.type)}} */`);
        w.line(`${s.mutable === false ? 'const' : 'let'} ${this.name(s.name)} = ${s.init ? this.expr(s.init) : this.zero(s.type)};`);
        break;
      case 'assign': {
        const t = this.expr(s.target);
        w.line(s.op ? `${t} ${s.op}= ${this.expr(s.value)};` : `${t} = ${this.expr(s.value)};`);
        break;
      }
      case 'expr':
        w.line(`${this.statementExpr(s.expr)};`);
        break;
      case 'if': {
        w.braced(`if (${this.expr(s.cond)})`, () => this.emitBody(w, s.then), '}');
        for (const ei of s.elseIf ?? []) {
          w.braced(`if (${this.expr(ei.cond)})`, () => this.emitBody(w, ei.body));
        }
        if (s.else?.length) w.braced('else', () => this.emitBody(w, s.else!));
        break;
      }
      case 'while':
        w.braced(`while (${this.expr(s.cond)})`, () => this.emitBody(w, s.body));
        break;
      case 'doWhile':
        w.line('do {');
        w.nest(() => this.emitBody(w, s.body));
        w.line(`} while (${this.expr(s.cond)});`);
        break;
      case 'forRange': {
        const v = this.name(s.varName);
        const cmp = s.inclusive ? '<=' : '<';
        const step = s.step ? this.expr(s.step) : '1';
        const inc = step === '1' ? `${v}++` : `${v} += ${step}`;
        w.braced(`for (let ${v} = ${this.expr(s.start)}; ${v} ${cmp} ${this.expr(s.end)}; ${inc})`, () =>
          this.emitBody(w, s.body),
        );
        break;
      }
      case 'forEach': {
        const v = this.name(s.varName);
        if (s.indexName) {
          w.braced(`for (const [${this.name(s.indexName)}, ${v}] of ${this.expr(s.iterable, CALL_PREC)}.entries())`, () =>
            this.emitBody(w, s.body),
          );
        } else {
          w.braced(`for (const ${v} of ${this.expr(s.iterable)})`, () => this.emitBody(w, s.body));
        }
        break;
      }
      case 'switch':
        w.braced(`switch (${this.expr(s.subject)})`, () => {
          for (const c of s.cases) {
            for (const m of c.match) w.line(`case ${this.expr(m)}:`);
            w.nest(() => {
              this.emitBody(w, c.body);
              if (!endsWithJump(c.body)) w.line('break;');
            });
          }
          if (s.default?.length) {
            w.line('default:');
            w.nest(() => this.emitBody(w, s.default!));
          }
        });
        break;
      case 'return':
        w.line(s.value ? `return ${this.expr(s.value)};` : 'return;');
        break;
      case 'break':
        w.line('break;');
        break;
      case 'continue':
        w.line('continue;');
        break;
      case 'throw':
        w.line(`throw ${this.expr(s.value)};`);
        break;
      case 'try': {
        w.line('try {');
        w.nest(() => this.emitBody(w, s.body));
        const c = s.catches[0];
        if (c) {
          w.line(`} catch (${this.name(c.varName)}) {`);
          w.nest(() => {
            // JavaScript has one catch clause, so extra typed handlers become
            // instanceof branches rather than being silently dropped.
            if (s.catches.length > 1) {
              for (const extra of s.catches.slice(1)) {
                w.braced(
                  `if (${this.name(c.varName)} instanceof ${extra.errType ? this.type(extra.errType) : 'Error'})`,
                  () => {
                    w.line(`const ${this.name(extra.varName)} = ${this.name(c.varName)};`);
                    this.emitBody(w, extra.body);
                  },
                );
              }
            }
            this.emitBody(w, c.body);
          });
        } else {
          w.line('} catch (error) {');
          w.nest(() => w.line('throw error;'));
        }
        if (s.finally?.length) {
          w.line('} finally {');
          w.nest(() => this.emitBody(w, s.finally!));
        }
        w.line('}');
        break;
      }
      case 'block':
        w.braced('', () => this.emitBody(w, s.body));
        break;
      case 'raw':
        if (s.lang !== 'javascript' && s.lang !== 'any') {
          throw new BackendGenError(`Raw ${s.lang} code cannot be emitted into a JavaScript file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: s.origin,
          });
        }
        w.verbatim(s.code);
        break;
    }
  }

  // -- expressions -----------------------------------------------------------

  expr(e: IrExpr, parentPrec = 0): string {
    const text = this.exprInner(e);
    return this.precOf(e) < parentPrec ? `(${text})` : text;
  }

  private precOf(e: IrExpr): number {
    switch (e.k) {
      case 'binary':
        return PRECEDENCE[e.op] ?? 5;
      case 'unary':
        return 13;
      case 'ternary':
        return 0.5;
      case 'lambda':
        return 0.5;
      case 'await':
        return 14;
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
        return 'this';
      case 'symbol':
        return this.ctx.resolveSymbol(e.name, e.from)?.reference ?? this.symbolName(e.name);
      case 'binary': {
        const p = PRECEDENCE[e.op] ?? 5;
        const op = JS_OP[e.op] ?? e.op;
        const right = e.op === '**' ? p : p + 1;
        const left = e.op === '**' ? p + 1 : p;
        return `${this.expr(e.left, left)} ${op} ${this.expr(e.right, right)}`;
      }
      case 'unary':
        return `${e.op}${this.expr(e.operand, 13)}`;
      case 'call':
        return `${this.expr(e.callee, CALL_PREC)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      case 'method':
        return `${this.expr(e.target, CALL_PREC)}.${this.name(e.name)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      case 'member':
        return `${this.expr(e.target, CALL_PREC)}.${this.memberName(e)}`;
      case 'index':
        return `${this.expr(e.target, CALL_PREC)}[${this.expr(e.index)}]`;
      case 'new':
        return `new ${this.resolvedType(e.className)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      case 'array':
        return `[${e.items.map((i) => this.expr(i)).join(', ')}]`;
      case 'mapLit':
        return `new Map([${e.entries.map((en) => `[${this.expr(en.key)}, ${this.expr(en.value)}]`).join(', ')}])`;
      case 'tupleLit':
        return `[${e.items.map((i) => this.expr(i)).join(', ')}]`;
      case 'lambda': {
        const params = `(${e.params.map((p) => this.param(p)).join(', ')})`;
        const asyncKw = e.isAsync ? 'async ' : '';
        if (!Array.isArray(e.body)) return `${asyncKw}${params} => ${this.expr(e.body, 1)}`;
        const inner = new CodeWriter('  ');
        this.emitBody(inner, e.body);
        const text = inner.toString().replace(/\n$/, '');
        return `${asyncKw}${params} => {\n${text}\n}`;
      }
      case 'ternary':
        return `${this.expr(e.cond, 1)} ? ${this.expr(e.then, 1)} : ${this.expr(e.else, 1)}`;
      case 'cast':
        return this.cast(e);
      case 'await':
        return `await ${this.expr(e.expr, 14)}`;
      case 'builtin':
        return this.builtin(e);
      case 'raw':
        if (e.lang !== 'javascript' && e.lang !== 'any') {
          throw new BackendGenError(`Raw ${e.lang} expression cannot be emitted into a JavaScript file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: e.origin,
          });
        }
        return e.code.trim();
    }
  }

  private memberName(e: IrExpr & { k: 'member' }): string {
    if (e.target.k === 'symbol' && e.target.type.kind === 'named') return screamingSnake(e.name);
    return this.name(e.name);
  }

  private symbolName(name: string): string {
    return /^[A-Z]/.test(name) ? this.typeName(name) : this.name(name);
  }

  /** A type name, resolved through the file graph so the import is added. */
  private resolvedType(name: string): string {
    return this.ctx.resolveSymbol(name)?.reference ?? this.typeName(name);
  }

  private literal(v: Extract<IrExpr, { k: 'lit' }>['value']): string {
    switch (v.t) {
      case 'bool':
        return v.v ? 'true' : 'false';
      case 'int':
        return String(v.v);
      case 'float':
        return Number.isInteger(v.v) ? `${v.v}.0` : String(v.v);
      case 'string':
      case 'char':
        return cString(v.v);
      case 'null':
        return 'null';
    }
  }

  private zero(t: TypeRef): string {
    switch (t.kind) {
      case 'primitive':
        if (t.name === 'bool') return 'false';
        if (t.name === 'string' || t.name === 'char') return "''";
        if (t.name === 'bytes') return 'new Uint8Array()';
        return '0';
      case 'list':
      case 'tuple':
        return '[]';
      case 'set':
        return 'new Set()';
      case 'map':
        return 'new Map()';
      default:
        return 'null';
    }
  }

  private cast(e: Extract<IrExpr, { k: 'cast' }>): string {
    const inner = this.expr(e.expr, CALL_PREC);
    if (e.to.kind === 'primitive') {
      switch (e.to.name) {
        case 'string':
        case 'char':
          return `String(${inner})`;
        case 'bool':
          return `Boolean(${inner})`;
        case 'i32':
        case 'i64':
          return `Math.trunc(Number(${inner}))`;
        default:
          return `Number(${inner})`;
      }
    }
    if (e.to.kind === 'list') return `Array.from(${inner})`;
    if (e.to.kind === 'set') return `new Set(${inner})`;
    return `/** @type {${this.type(e.to)}} */ (${inner})`;
  }

  private statementExpr(e: IrExpr): string {
    if (e.k !== 'builtin') return this.expr(e);
    const a = e.args.map((x) => this.expr(x, CALL_PREC));
    switch (e.op) {
      case 'list_set':
        return `${a[0]}[${a[1]}] = ${a[2]}`;
      case 'list_remove_at':
        return `${a[0]}.splice(${a[1]}, 1)`;
      default:
        return this.expr(e);
    }
  }

  private builtin(e: Extract<IrExpr, { k: 'builtin' }>): string {
    const a = e.args.map((x) => this.expr(x, CALL_PREC));
    const runtime = RUNTIME_OPS[e.op];
    if (runtime) return `${this.runtime(runtime)}(${a.join(', ')})`;

    switch (e.op) {
      case 'print':
        return `console.log(${a.join(', ')})`;
      case 'print_err':
        return `console.error(${a.join(', ')})`;
      case 'read_line':
        return `${this.runtime('readLine')}()`;

      case 'to_string':
        return `String(${a[0]})`;
      case 'to_int':
        return `Math.trunc(Number(${a[0]}))`;
      case 'to_float':
        return `Number(${a[0]})`;

      case 'len':
        return `${this.runtime('lengthOf')}(${a[0]})`;
      case 'is_empty':
        return `${this.runtime('lengthOf')}(${a[0]}) === 0`;

      case 'str_concat':
        return `${a[0]} + ${a[1]}`;
      case 'str_upper':
        return `${a[0]}.toUpperCase()`;
      case 'str_lower':
        return `${a[0]}.toLowerCase()`;
      case 'str_trim':
        return `${a[0]}.trim()`;
      case 'str_split':
        return `${a[0]}.split(${a[1]})`;
      case 'str_join':
        return `${a[0]}.join(${a[1]})`;
      case 'str_replace':
        return `${a[0]}.replaceAll(${a[1]}, ${a[2]})`;
      case 'str_contains':
        return `${a[0]}.includes(${a[1]})`;
      case 'str_starts_with':
        return `${a[0]}.startsWith(${a[1]})`;
      case 'str_ends_with':
        return `${a[0]}.endsWith(${a[1]})`;
      case 'str_index_of':
        return `${a[0]}.indexOf(${a[1]})`;
      case 'str_substring':
        return `${a[0]}.slice(${a[1]}, ${a[2]})`;
      case 'str_char_at':
        return `${a[0]}.charAt(${a[1]})`;
      case 'str_repeat':
        return `${a[0]}.repeat(${a[1]})`;
      case 'str_pad_left':
        return `${a[0]}.padStart(${a[1]}, ${a[2]})`;

      case 'list_new':
        return '[]';
      case 'list_get':
        return `${a[0]}[${a[1]}]`;
      case 'list_push':
        return `${a[0]}.push(${a[1]})`;
      case 'list_pop':
        return `(${a[0]}.pop() ?? null)`;
      case 'list_insert':
        return `${a[0]}.splice(${a[1]}, 0, ${a[2]})`;
      case 'list_contains':
        return `${a[0]}.includes(${a[1]})`;
      case 'list_index_of':
        return `${a[0]}.indexOf(${a[1]})`;
      case 'list_slice':
        return `${a[0]}.slice(${a[1]}, ${a[2]})`;
      case 'list_concat':
        return `${a[0]}.concat(${a[1]})`;
      case 'list_reverse':
        return `${a[0]}.slice().reverse()`;
      case 'list_sort':
        return `${this.runtime('sortNatural')}(${a[0]})`;
      case 'list_sort_by':
        return `${a[0]}.slice().sort((x, y) => ${a[1]}(x) - ${a[1]}(y))`;
      case 'list_map':
        return `${a[0]}.map(${a[1]})`;
      case 'list_filter':
        return `${a[0]}.filter(${a[1]})`;
      case 'list_reduce':
        return `${a[0]}.reduce(${a[1]}, ${a[2]})`;
      case 'list_any':
        return `${a[0]}.some(${a[1]})`;
      case 'list_all':
        return `${a[0]}.every(${a[1]})`;
      case 'list_find':
        return `(${a[0]}.find(${a[1]}) ?? null)`;
      case 'list_sum':
        return `${a[0]}.reduce((x, y) => x + y, 0)`;
      case 'list_min':
        return `(${a[0]}.length ? Math.min(...${a[0]}) : null)`;
      case 'list_max':
        return `(${a[0]}.length ? Math.max(...${a[0]}) : null)`;
      case 'list_unique':
        return `[...new Set(${a[0]})]`;
      case 'list_range':
        return `${this.runtime('rangeList')}(${a[0]}, ${a[1]})`;

      case 'map_new':
        return 'new Map()';
      case 'map_get':
        return `(${a[0]}.get(${a[1]}) ?? null)`;
      case 'map_get_or':
        return `(${a[0]}.get(${a[1]}) ?? ${a[2]})`;
      case 'map_set':
        return `${a[0]}.set(${a[1]}, ${a[2]})`;
      case 'map_has':
        return `${a[0]}.has(${a[1]})`;
      case 'map_remove':
        return `${a[0]}.delete(${a[1]})`;
      case 'map_keys':
        return `[...${a[0]}.keys()]`;
      case 'map_values':
        return `[...${a[0]}.values()]`;

      case 'set_new':
        return 'new Set()';
      case 'set_add':
        return `${a[0]}.add(${a[1]})`;
      case 'set_has':
        return `${a[0]}.has(${a[1]})`;
      case 'set_remove':
        return `${a[0]}.delete(${a[1]})`;
      case 'set_to_list':
        return `[...${a[0]}]`;

      case 'math_abs':
        return `Math.abs(${a[0]})`;
      case 'math_floor':
        return `Math.floor(${a[0]})`;
      case 'math_ceil':
        return `Math.ceil(${a[0]})`;
      case 'math_round':
        return `Math.round(${a[0]})`;
      case 'math_sqrt':
        return `Math.sqrt(${a[0]})`;
      case 'math_pow':
        return `Math.pow(${a[0]}, ${a[1]})`;
      case 'math_min':
        return `Math.min(${a[0]}, ${a[1]})`;
      case 'math_max':
        return `Math.max(${a[0]}, ${a[1]})`;
      case 'math_log':
        return `Math.log(${a[0]})`;
      case 'math_exp':
        return `Math.exp(${a[0]})`;
      case 'math_sin':
        return `Math.sin(${a[0]})`;
      case 'math_cos':
        return `Math.cos(${a[0]})`;
      case 'math_tan':
        return `Math.tan(${a[0]})`;
      case 'math_atan2':
        return `Math.atan2(${a[0]}, ${a[1]})`;
      case 'math_idiv':
        return `Math.trunc(${a[0]} / ${a[1]})`;
      case 'math_pi':
        return 'Math.PI';

      case 'json_parse':
        return `JSON.parse(${a[0]})`;
      case 'json_stringify':
        return `JSON.stringify(${a[0]}, null, ${a[1]} ? 2 : 0)`;
      case 'json_get':
        return `(${a[0]}?.[${a[1]}] ?? null)`;
      case 'json_as_string':
        return `String(${a[0]})`;
      case 'json_as_number':
        return `Number(${a[0]})`;
      case 'json_as_list':
        return `Array.from(${a[0]} ?? [])`;

      case 'file_read_text':
        return `${this.nodeModule('node:fs', 'readFileSync')}(${a[0]}, 'utf8')`;
      case 'file_write_text':
        return `${this.nodeModule('node:fs', 'writeFileSync')}(${a[0]}, ${a[1]}, 'utf8')`;
      case 'file_append_text':
        return `${this.nodeModule('node:fs', 'appendFileSync')}(${a[0]}, ${a[1]}, 'utf8')`;
      case 'file_exists':
        return `${this.nodeModule('node:fs', 'existsSync')}(${a[0]})`;
      case 'file_delete':
        return `${this.nodeModule('node:fs', 'rmSync')}(${a[0]}, { force: true })`;
      case 'dir_list':
        return `${this.nodeModule('node:fs', 'readdirSync')}(${a[0]}).sort()`;
      case 'dir_create':
        return `${this.nodeModule('node:fs', 'mkdirSync')}(${a[0]}, { recursive: true })`;
      case 'path_join':
        return `${this.nodeModule('node:path', 'join')}(${a[0]}, ${a[1]})`;

      case 'env_get':
        return `(${this.nodeModule('node:process', 'env')}[${a[0]}] ?? null)`;
      case 'args_get':
        return `${this.nodeModule('node:process', 'argv')}.slice(2)`;
      case 'time_now_ms':
        return 'Date.now()';
      case 'time_sleep_ms':
        return `${this.runtime('sleepMs')}(${a[0]})`;
      case 'random_float':
        return 'Math.random()';
      case 'random_int':
        return `(${a[0]} + Math.floor(Math.random() * (${a[1]} - ${a[0]})))`;

      case 'error_new':
        return `new Error(${a[0]})`;
      case 'error_message':
        return `String(${a[0]}?.message ?? ${a[0]})`;

      case 'option_or':
        return `(${a[0]} ?? ${a[1]})`;
      case 'option_is_some':
        return `(${a[0]} != null)`;

      case 'hash_sha256':
        return `${this.runtime('digestHex')}('sha256', ${a[0]})`;
      case 'hash_sha1':
        return `${this.runtime('digestHex')}('sha1', ${a[0]})`;
      case 'hash_md5':
        return `${this.runtime('digestHex')}('md5', ${a[0]})`;

      case 'time_now_iso':
        return 'new Date().toISOString()';
      case 'time_format_iso':
        return `new Date(${a[0]}).toISOString()`;

      case 'dom_query':
        return `${this.runtime('requireElement')}(${a[0]})`;
      case 'dom_query_all':
        return `[...document.querySelectorAll(${a[0]})]`;
      case 'dom_create':
        return `document.createElement(${a[0]})`;
      case 'dom_set_text':
        return `(${a[0]}.textContent = ${a[1]})`;
      case 'dom_get_value':
        return `(${a[0]}.value ?? '')`;
      case 'dom_set_value':
        return `(${a[0]}.value = ${a[1]})`;
      case 'dom_set_attr':
        return `${a[0]}.setAttribute(${a[1]}, ${a[2]})`;
      case 'dom_add_class':
        return `${a[0]}.classList.add(${a[1]})`;
      case 'dom_remove_class':
        return `${a[0]}.classList.remove(${a[1]})`;
      case 'dom_append':
        return `${a[0]}.appendChild(${a[1]})`;
      case 'dom_on':
        return `${a[0]}.addEventListener(${a[1]}, ${a[2]})`;

      default:
        throw new BackendGenError(`The JavaScript backend does not implement the "${e.op}" operation.`, {
          code: 'codegen/unsupported-builtin',
          origin: e.origin,
        });
    }
  }
}

function endsWithJump(body: IrStmt[]): boolean {
  const last = body[body.length - 1];
  return !!last && (last.k === 'return' || last.k === 'break' || last.k === 'continue' || last.k === 'throw');
}

/** Relative ESM specifier from one module path to another, with `.js`. */
export function relativeSpecifier(fromPath: string, toPath: string): string {
  const from = fromPath.split('/').slice(0, -1);
  const to = toPath.split('/');
  const file = to.pop()!;
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => '..');
  const down = to.slice(i);
  const parts = [...up, ...down, `${file}.js`];
  const joined = parts.join('/');
  return joined.startsWith('.') ? joined : `./${joined}`;
}

// ---------------------------------------------------------------------------

export const javascriptBackend: LanguageBackend = {
  id: 'javascript',
  name: 'JavaScript (ES modules)',
  maturity: 'full',
  extensions: ['.js', '.mjs'],
  // asyncBuiltins: fetch, timers and everything built on them return promises
  // here, so the ordering the IR assumes has to be spelled out as async/await.
  features: defaultFeatures({
    staticTypes: false,
    browser: true,
    interfaces: false,
    asyncBuiltins: true,
  }),
  lineComment: '//',
  blockComment: { open: '/*', close: '*/' },
  indent: '  ',
  keywords: KEYWORDS,

  packageManager: {
    id: 'npm',
    name: 'npm',
    installAll: { label: 'npm install', command: 'npm', args: ['install'] },
    installOne: { label: 'npm install', command: 'npm', args: ['install', '{name}@{version}'] },
    manifestFile: 'package.json',
    lockFile: 'package-lock.json',
  },

  toolchain: [
    { command: 'node', versionArgs: ['--version'], installHint: 'Install Node.js 20 or newer from nodejs.org.' },
  ],

  entry: {
    file: 'src/main.js',
    symbol: 'main',
    description: 'An ES module whose main() runs on load.',
  },

  sourceRoot: () => 'src',
  testRoot: () => 'tests',
  pathFor: (file) => file.path,

  mapType(type, project) {
    return new JsEmitter({
      project,
      program: { name: '', language: 'javascript', modules: [], dependencies: [] },
      module: { id: '', name: '', path: '', imports: [], decls: [] },
      file: { id: '', path: '', language: 'javascript', kind: 'generated', role: 'source', exports: [], imports: [] },
      diag: { items: [] } as never,
      resolveSymbol: () => undefined,
      dependencies: [],
    }).type(type);
  },

  importFor(from, to, symbols) {
    const spec = relativeSpecifier(from.path, to.path);
    return symbols.length ? `import { ${symbols.join(', ')} } from '${spec}';` : `import '${spec}';`;
  },

  emitModule(ctx) {
    return new JsEmitter(ctx).emit();
  },

  emitProjectFiles(project, program) {
    const files: GeneratedFile[] = [];
    const deps = project.dependencies.filter((d) => d.language === 'javascript');
    const entry = project.files.find((f) => f.role === 'entry' && f.language === 'javascript');
    const isWeb = project.files.some((f) => f.language === 'html');

    files.push({
      path: 'package.json',
      role: 'manifest',
      content: `${JSON.stringify(
        {
          name: project.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
          version: project.version,
          description: project.description ?? '',
          type: 'module',
          main: entry?.path ?? 'src/main.js',
          license: project.license ?? 'MIT',
          scripts: {
            start: isWeb ? 'npx --yes serve .' : `node ${entry?.path ?? 'src/main.js'}`,
            test: 'node --test tests/',
          },
          dependencies: Object.fromEntries(
            deps
              .filter((d) => d.scope !== 'dev')
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((d) => [d.name, d.version === '*' ? 'latest' : d.version]),
          ),
          devDependencies: Object.fromEntries(
            deps
              .filter((d) => d.scope === 'dev')
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((d) => [d.name, d.version === '*' ? 'latest' : d.version]),
          ),
        },
        null,
        2,
      )}\n`,
    });

    const ops = usedBuiltins(program);
    const needsRuntime =
      Object.keys(RUNTIME_OPS).some((op) => ops.has(op)) ||
      ['len', 'is_empty', 'list_sort', 'list_range', 'time_sleep_ms', 'read_line', 'dom_query'].some((op) =>
        ops.has(op),
      );
    if (needsRuntime) {
      files.push({ path: 'src/_mcode_runtime.js', role: 'source', content: JS_RUNTIME });
    }
    return files;
  },

  buildPlan(project): BuildPlan {
    // Nothing to compile; a parse check catches syntax errors before running.
    //
    // Every JavaScript file is checked, not just the entry point. A web project
    // has no JavaScript entry at all — the entry is the HTML page — and the
    // previous fallback to a hard-coded `src/main.js` failed the build on a
    // file that had never been generated.
    const scripts = project.files
      .filter((f) => f.language === 'javascript' && f.role !== 'asset')
      .map((f) => f.path)
      .sort();

    if (!scripts.length) {
      return { steps: [], note: 'No JavaScript files to check.' };
    }
    return {
      steps: scripts.map((path) => ({
        label: `Parse check ${path}`,
        command: 'node',
        args: ['--check', path],
      })),
    };
  },

  runPlan(project): RunPlan | null {
    const html = project.files.find((f) => f.language === 'html' && f.role === 'entry');
    if (html) {
      return {
        command: { label: 'Serve', command: 'node', args: ['-e', 'process.exit(0)'] },
        openInBrowser: html.path,
      };
    }
    const entry = project.files.find((f) => f.role === 'entry' && f.language === 'javascript');
    return {
      command: { label: 'Run', command: 'node', args: [entry?.path ?? 'src/main.js'] },
    };
  },

  testPlan(): BuildPlan {
    return { steps: [{ label: 'node --test', command: 'node', args: ['--test', 'tests/'] }] };
  },

  parseDiagnostics(output): Diagnostic[] {
    const out: Diagnostic[] = [];
    const lines = output.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // `file:///.../src/main.js:12` followed by the offending source and message
      const loc = /^(?:file:\/\/\/)?(.+\.m?js):(\d+)$/.exec(lines[i].trim());
      if (loc) {
        const msg = lines.slice(i + 1, i + 8).find((l) => /^(\w*Error|SyntaxError):/.test(l.trim()));
        if (msg) {
          out.push({
            severity: 'error',
            stage: 'build',
            code: 'js/parse',
            message: msg.trim(),
            file: normalizePath(loc[1]),
            line: Number(loc[2]),
            raw: lines[i],
          });
        }
        continue;
      }
      // Stack frames: `    at fn (/abs/src/main.js:10:5)`
      const frame = /\s+at .*\((.+\.m?js):(\d+):(\d+)\)/.exec(lines[i]);
      if (frame && !out.length) {
        const msg = lines.slice(0, i).reverse().find((l) => /^\w*Error:/.test(l.trim()));
        if (msg) {
          out.push({
            severity: 'error',
            stage: 'runtime',
            code: 'js/exception',
            message: msg.trim(),
            file: normalizePath(frame[1]),
            line: Number(frame[2]),
            column: Number(frame[3]),
            raw: lines[i],
          });
        }
      }
    }
    return out;
  },
};

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^.*?\/(src|tests)\//, '$1/');
}

const JS_RUNTIME = `// Runtime helpers used by generated Master Code programs.
//
// Only operations without a one-expression standard form live here. Everything
// else is emitted inline. Node-only helpers throw a clear error in a browser
// rather than failing with an opaque module-resolution message.
//
// This file is generated. Edit the graph, not this.

/** First element matching a selector. Throws a readable error when absent. */
export function requireElement(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(\`no element matches "\${selector}"\`);
  return element;
}

/** Length of a string, array, Map or Set. */
export function lengthOf(value) {
  if (value == null) return 0;
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  return Object.keys(value).length;
}

/** Integer value of text, or null when it does not parse. */
export function parseIntOrNull(text) {
  const value = Number.parseInt(String(text).trim(), 10);
  return Number.isNaN(value) ? null : value;
}

/** Float value of text, or null when it does not parse. */
export function parseFloatOrNull(text) {
  const value = Number.parseFloat(String(text).trim());
  return Number.isNaN(value) ? null : value;
}

/** Interpolate {} placeholders in order. */
export function formatText(template, ...args) {
  let index = 0;
  return String(template).replace(/\\{\\}/g, () => (index < args.length ? String(args[index++]) : '{}'));
}

/** Ascending sort that compares numbers numerically and everything else as text. */
export function sortNatural(list) {
  return list
    .slice()
    .sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
}

/** Integers from start (inclusive) to end (exclusive). */
export function rangeList(start, end) {
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/** Resolve after the given number of milliseconds. */
export function sleepMs(millis) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

/** Response of an HTTP request. A transport failure yields status 0. */
export async function httpRequest(method, url, headers = new Map(), body = '') {
  const headerObject = headers instanceof Map ? Object.fromEntries(headers) : { ...(headers || {}) };
  try {
    const response = await fetch(url, {
      method: String(method).toUpperCase(),
      headers: headerObject,
      body: body ? body : undefined,
    });
    return {
      status: response.status,
      body: await response.text(),
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (error) {
    return { status: 0, body: String(error), headers: {} };
  }
}

/** Read one line from standard input (Node only). */
export function readLine() {
  const fs = requireNode('node:fs', 'read_line');
  const buffer = Buffer.alloc(4096);
  let read = 0;
  try {
    read = fs.readSync(0, buffer, 0, buffer.length, null);
  } catch {
    return '';
  }
  return buffer.toString('utf8', 0, read).replace(/\\r?\\n$/, '');
}

export function dbOpen(path) {
  const { DatabaseSync } = requireNode('node:sqlite', 'db_open');
  return new DatabaseSync(path);
}

export function dbExecute(connection, sql, params = []) {
  const statement = connection.prepare(sql);
  const result = statement.run(...params);
  return Number(result.changes ?? 0);
}

export function dbQuery(connection, sql, params = []) {
  return connection.prepare(sql).all(...params);
}

export function dbClose(connection) {
  connection.close();
}

export function mcAssert(condition, message) {
  if (!condition) throw new Error(\`assertion failed: \${message}\`);
}

export function mcAssertEqual(actual, expected, message) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) throw new Error(\`\${message}: expected \${JSON.stringify(expected)}, got \${JSON.stringify(actual)}\`);
}

/**
 * Run the task, wait, repeat, until the process is stopped.
 *
 * A fixed gap between runs rather than a fixed rate: setInterval would start a
 * second poll while the first was still waiting on a slow API, and two pollers
 * reading the same cursor is how a feed gets ingested twice.
 */
export async function scheduleEvery(millis, task) {
  for (;;) {
    await task();
    await sleepMs(millis);
  }
}

/**
 * Follow a dotted path into a parsed value, or null.
 *
 * Missing is not an error: an optional field that is absent is the ordinary
 * case when reading someone else's JSON, and the graph decides what to do
 * about it with Value Or Default or Require Value.
 */
export function jsonPath(value, path) {
  let current = value;
  for (const step of String(path).split('.')) {
    if (!step) continue;
    const name = step.replace(/\\[\\d+\\]/g, '');
    if (name) {
      if (current == null) return null;
      current = current instanceof Map ? current.get(name) : current[name];
    }
    for (const match of step.matchAll(/\\[(\\d+)\\]/g)) {
      if (current == null) return null;
      current = current[Number(match[1])];
    }
    if (current === undefined) return null;
  }
  return current === undefined ? null : current;
}

/**
 * Run the worker over each index, at most "limit" at a time, in order.
 *
 * Promise.all on its own would start every task at once, which is the wrong
 * default against a rate-limited API: a list of five hundred indicators would
 * open five hundred sockets and earn a round of 429s. Workers pull from a
 * shared cursor instead, so exactly that many are ever in flight.
 */
async function runPool(count, limit, worker) {
  const results = new Array(count);
  const width = Math.max(1, Math.min(Number(limit) || 1, count));
  let next = 0;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) return;
      results[index] = await worker(index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function parallelMap(items, fn, limit) {
  const list = Array.from(items ?? []);
  return runPool(list.length, limit, (index) => fn(list[index]));
}

export function parallelAll(tasks, limit) {
  const list = Array.from(tasks ?? []);
  return runPool(list.length, limit, (index) => list[index]());
}

/** A reply for httpServe to send. */
export function httpReply(status, body, contentType) {
  return { status, body, contentType };
}

/**
 * Listen on host:port and answer every request with the handler.
 *
 * The returned promise settles when the listener closes, not when it opens, so
 * an entry point that awaits this keeps running - which is what a graph that
 * drew a server meant. SIGINT and SIGTERM close it, so the process still stops
 * on Ctrl-C and under a supervisor.
 */
export function httpServe(host, port, handler) {
  const http = requireNode('node:http', 'http_serve');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        const url = new URL(req.url ?? '/', \`http://\${req.headers.host ?? 'localhost'}\`);
        const request = {
          method: req.method ?? 'GET',
          path: url.pathname,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: new Map(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])),
          query: new Map(url.searchParams),
        };
        try {
          const reply = (await handler(request)) ?? httpReply(204, '', 'text/plain');
          res.writeHead(reply.status, { 'content-type': reply.contentType || 'text/plain' });
          res.end(reply.body ?? '');
        } catch (error) {
          // A handler that threw is a bug in the graph, not a malformed
          // request, so it is reported here rather than swallowed into a 200.
          console.error('request handler failed:', error);
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('internal error');
        }
      });
    });

    const close = () => server.close(() => resolve());
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    server.on('error', reject);
    server.on('close', resolve);
    server.listen(port, host, () => {
      console.error(\`listening on http://\${host}:\${port}\`);
    });
  });
}

/** The value, or a readable error naming what was expected. */
export function requireValue(value, message) {
  if (value == null) throw new Error(\`expected a value: \${message}\`);
  return value;
}

/**
 * Compile a pattern, naming the operation when it will not compile. A bad
 * pattern is a mistake in the graph, and the message should say so rather than
 * surfacing as "Invalid regular expression" with no context.
 */
function regexOf(pattern, flags) {
  try {
    return new RegExp(pattern, flags);
  } catch (cause) {
    throw new Error(\`invalid pattern \${JSON.stringify(pattern)}: \${cause.message}\`);
  }
}

export function regexMatch(text, pattern) {
  return regexOf(pattern, '').test(String(text));
}

export function regexFindAll(text, pattern) {
  return [...String(text).matchAll(regexOf(pattern, 'g'))].map((m) => m[0]);
}

/** Groups of the first match: 0 is the whole match. Empty list when no match. */
export function regexCapture(text, pattern) {
  const m = regexOf(pattern, '').exec(String(text));
  if (!m) return [];
  return Array.from(m, (group) => group ?? '');
}

/**
 * Replace every match. Only \$1..\$9 and \$\$ are substitutions - the other
 * sequences JavaScript would honour (\$&, \$\`, \$') are left as literal text,
 * because no other Master Code target understands them and a graph that relied
 * on one would stop working the moment it was generated into Python.
 */
export function regexReplace(text, pattern, replacement) {
  const template = String(replacement);
  return String(text).replace(regexOf(pattern, 'g'), (...args) => {
    const groups = args.slice(0, args.length - 2);
    let out = '';
    for (let i = 0; i < template.length; i += 1) {
      const ch = template[i];
      if (ch !== '$' || i + 1 >= template.length) {
        out += ch;
        continue;
      }
      const next = template[i + 1];
      if (next === '$') {
        out += '$';
        i += 1;
      } else if (next >= '1' && next <= '9') {
        out += groups[Number(next)] ?? '';
        i += 1;
      } else {
        out += ch;
      }
    }
    return out;
  });
}

export function regexSplit(text, pattern) {
  return String(text).split(regexOf(pattern, ''));
}

/** UTF-8 bytes of a string, the unit every encoding and digest below works on. */
function utf8Bytes(text) {
  return new TextEncoder().encode(String(text));
}

export function base64Encode(text) {
  let binary = '';
  for (const byte of utf8Bytes(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64Decode(text) {
  let binary;
  try {
    binary = atob(String(text));
  } catch {
    throw new Error(\`not valid base64: \${JSON.stringify(String(text).slice(0, 32))}\`);
  }
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function hexEncode(text) {
  let out = '';
  for (const byte of utf8Bytes(text)) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Percent-encode for one query-string value. encodeURIComponent leaves
 * ! * ' ( ) alone; those are escaped here so the result matches what every
 * other backend produces for the same input.
 */
export function urlEncode(text) {
  return encodeURIComponent(String(text)).replace(
    /[!*'()]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function urlDecode(text) {
  try {
    return decodeURIComponent(String(text));
  } catch {
    throw new Error(\`not valid percent-encoded text: \${JSON.stringify(String(text).slice(0, 32))}\`);
  }
}

/** Lower-case hex digest. Node-only: the browser's SubtleCrypto is async. */
export function digestHex(algorithm, text) {
  const crypto = requireNode('node:crypto', \`hash_\${algorithm}\`);
  return crypto.createHash(algorithm).update(String(text), 'utf8').digest('hex');
}

export function hmacSha256Hex(key, message) {
  const crypto = requireNode('node:crypto', 'hmac_sha256');
  return crypto.createHmac('sha256', String(key)).update(String(message), 'utf8').digest('hex');
}

export function uuidV4() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return requireNode('node:crypto', 'uuid_v4').randomUUID();
}

/**
 * ISO 8601 to milliseconds, or null. A timestamp carrying no zone is read as
 * UTC; Date.parse would read it as local time, which would make the same graph
 * produce different numbers on two machines.
 */
export function parseIsoMillis(text) {
  const raw = String(text).trim();
  const zoned = /(?:[Zz]|[+-]\\d{2}:?\\d{2})$/.test(raw);
  const dateOnly = /^\\d{4}-\\d{2}-\\d{2}$/.test(raw);
  const value = Date.parse(zoned || dateOnly ? raw : \`\${raw}Z\`);
  return Number.isNaN(value) ? null : value;
}

/**
 * Reach a Node builtin without a static import, so this module still loads in
 * a browser. Anything that genuinely needs Node fails with a message that says
 * which operation and which module, instead of a module-resolution error.
 */
function requireNode(specifier, operation) {
  const builtin = globalThis.process?.getBuiltinModule;
  if (typeof builtin !== 'function') {
    throw new Error(\`"\${operation}" needs \${specifier}, which only exists under Node 22 or newer.\`);
  }
  return builtin.call(globalThis.process, specifier);
}
`;

export { JsEmitter };
