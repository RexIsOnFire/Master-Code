/**
 * Go backend.
 *
 * Two places where Go genuinely differs from the IR, handled explicitly rather
 * than fudged:
 *
 *  - Go has no exceptions. `Throw` becomes `panic`, and `Try/Catch` becomes a
 *    closure with `defer`/`recover`. That is the idiom Go programmers use for
 *    exactly this shape, and the generated code says so in a comment.
 *  - Go has no ternary operator, so `Select` becomes a small immediately-called
 *    closure. Readable, and correct with respect to evaluation order.
 */

import type { BuildMode, BuildPlan, EmitContext, GeneratedFile, LanguageBackend, RunPlan } from './backend.ts';
import { BackendGenError, defaultFeatures, generatedHeader } from './backend.ts';
import { CLikeEmitter, javaLikeDialect } from './clike.ts';
import { usedBuiltins } from './analysis.ts';
import { CodeWriter, avoidKeyword, camel, pascal, wrapText } from './emitter.ts';
import { scratchContext } from './java.ts';
import type { IrClass, IrDecl, IrEnum, IrExpr, IrFunction, IrInterface, IrParam, IrStmt, IrVisitor } from '../ir/ir.ts';
import { walkStmt } from '../ir/ir.ts';
import process from 'node:process';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project } from '../model/project.ts';
import type { TypeRef } from '../types/types.ts';

/**
 * Pure-Go SQLite. Chosen over mattn/go-sqlite3 because it needs no cgo, so a
 * generated project still cross-compiles and still builds on a machine with no
 * C toolchain - which is most of the reason to pick Go here in the first place.
 */
const SQLITE_DRIVER = 'modernc.org/sqlite';
const SQLITE_DRIVER_VERSION = 'v1.34.5';

const KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for',
  'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select',
  'struct', 'switch', 'type', 'var',
]);

class GoEmitter extends CLikeEmitter {
  private readonly imports = new Set<string>();

  /**
   * Names read somewhere in the function currently being emitted.
   *
   * Go refuses to compile a declared-and-unused variable, and the lowering pass
   * binds the result of every effectful builtin whether the graph wired that
   * output or not - an Execute SQL whose "affected" port is empty still
   * produces one. Those bindings are emitted against the blank identifier
   * instead. Every other language ignores the distinction.
   */
  private readNames = new Set<string>();

  constructor(ctx: EmitContext) {
    super(
      ctx,
      javaLikeDialect({
        letKeyword: () => '',
        semicolon: false,
        parenthesizedConditions: false,
        elseOnSameLine: true,
        foreach: (v, _t, it, index) => `for ${index ?? '_'}, ${v} := range ${it}`,
        forRange: (v, start, end, step, inclusive) =>
          `for ${v} := ${start}; ${v} ${inclusive ? '<=' : '<'} ${end}; ${v} += ${step}`,
        power: (b, e) => `math.Pow(${b}, ${e})`,
      }),
      KEYWORDS,
      '\t',
    );
  }

  protected override get langId(): string {
    return 'go';
  }

  override name(raw: string): string {
    return avoidKeyword(camel(raw), KEYWORDS);
  }

  /** Exported names must start with a capital in Go. */
  private exported(raw: string): string {
    return pascal(raw);
  }

  override typeName(raw: string): string {
    return pascal(raw);
  }

  /**
   * Referring to a declaration by name, rather than calling it.
   *
   * Go declarations generated here are exported, so they are capitalised - and
   * `resolveSymbol` capitalises cross-file references for the same reason. The
   * inherited version would leave a same-module reference in the casing the
   * graph used, so passing a function as a value emitted a name that did not
   * exist. Capitalising here keeps the three paths agreeing.
   */
  protected override symbolName(raw: string): string {
    return pascal(raw);
  }

  emit(): string {
    const { module, file, project } = this.ctx;
    const body = new CodeWriter('\t');
    for (const d of module.decls) this.decl(body, d);

    const entry = module.decls.find((d): d is IrFunction => d.k === 'function' && !!d.isEntry);
    const isMainPkg = packageOf(file.path) === 'main';
    // Go's entry point is `func main`, lowercase and exactly that. Generated
    // declarations are exported, so an entry called "main" in the graph becomes
    // `Main` — which Go does not recognise, and the linker rejects the binary
    // with "function main is undeclared in the main package". The wrapper is
    // therefore needed whenever the emitted name is not literally `main`,
    // which, given exported() capitalises, is always.
    if (entry && isMainPkg && this.exported(entry.name) !== 'main') {
      body.blank();
      body.line('// Go requires an entry point spelled exactly `main`.');
      body.braced('func main()', () => body.line(`${this.exported(entry.name)}()`));
    }

    const head = new CodeWriter('\t');
    for (const l of generatedHeader(goBackend, file, project)) head.line(l);
    head.blank();
    if (module.doc) for (const l of wrapText(module.doc)) head.line(`// ${l}`);
    head.line(`package ${packageOf(file.path)}`);

    const projectImports = module.imports
      .filter((i) => i.source === 'file')
      .map((i) => this.ctx.program.modules.find((m) => m.id === i.target))
      .filter(Boolean)
      .map((m) => `${moduleRoot(project)}/${dirOf(m!.path)}`)
      .filter((p) => !p.endsWith('/'));
    const all = [...new Set([...this.imports, ...projectImports])].sort();
    if (all.length) {
      head.blank();
      if (all.length === 1) head.line(`import "${all[0]}"`);
      else {
        head.line('import (');
        head.nest(() => all.forEach((i) => head.line(`"${i}"`)));
        head.line(')');
      }
    }
    head.blank();
    head.block(body.toString().replace(/\n$/, ''));
    return head.toString();
  }

  private need(pkg: string): string {
    this.imports.add(pkg);
    return pkg.split('/').pop()!;
  }

  override type(t: TypeRef): string {
    switch (t.kind) {
      case 'void':
      case 'exec':
        return '';
      case 'any':
        return 'any';
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return 'bool';
          case 'i32':
            return 'int32';
          case 'i64':
            return 'int64';
          case 'f32':
            return 'float32';
          case 'f64':
            return 'float64';
          case 'string':
          case 'char':
            return 'string';
          case 'bytes':
            return '[]byte';
        }
        return 'any';
      case 'list':
        return `[]${this.type(t.item)}`;
      case 'set':
        return `map[${this.type(t.item)}]bool`;
      case 'map':
        return `map[${this.type(t.key)}]${this.type(t.value)}`;
      case 'option':
        // Go's zero values already stand in for "absent" on most types; a
        // pointer makes the distinction explicit where it matters.
        return t.inner.kind === 'list' || t.inner.kind === 'map' ? this.type(t.inner) : `*${this.type(t.inner)}`;
      case 'tuple':
        return `[]any`;
      case 'future':
        return `chan ${this.type(t.inner)}`;
      case 'result':
        return this.type(t.ok);
      case 'function':
        return `func(${t.params.map((p) => this.type(p)).join(', ')})${
          t.returns.kind === 'void' ? '' : ` ${this.type(t.returns)}`
        }`;
      case 'named':
        switch (t.name) {
          case 'Error':
            return 'error';
          case 'Json':
            return 'any';
          case 'HttpResponse':
            return `${this.need(`${moduleRootOf(this.ctx.project)}/mcruntime`)}.HTTPResponse`;
          case 'HttpRequest':
            return `${this.need(`${moduleRootOf(this.ctx.project)}/mcruntime`)}.HTTPRequestIn`;
          case 'HttpReply':
            return `${this.need(`${moduleRootOf(this.ctx.project)}/mcruntime`)}.HTTPReplyOut`;
          case 'DbConnection':
            return `*${this.need(`${moduleRootOf(this.ctx.project)}/mcruntime`)}.DB`;
          case 'Element':
            throw new BackendGenError('DOM types have no Go equivalent.', { code: 'codegen/dom-in-go' });
          default:
            return this.resolvedType(t.name);
        }
      case 'var':
        return 'any';
    }
  }

  override zero(t: TypeRef): string {
    switch (t.kind) {
      case 'primitive':
        if (t.name === 'bool') return 'false';
        if (t.name === 'string' || t.name === 'char') return '""';
        if (t.name === 'f32' || t.name === 'f64') return '0.0';
        if (t.name === 'bytes') return '[]byte{}';
        return '0';
      case 'list':
        return `${this.type(t)}{}`;
      case 'set':
      case 'map':
        return `${this.type(t)}{}`;
      default:
        return 'nil';
    }
  }

  protected override throwStatement(value: IrExpr): string {
    return `panic(${this.expr(value)})`;
  }

  protected override tryStmt(w: CodeWriter, s: Extract<IrStmt, { k: 'try' }>): void {
    const c = s.catches[0];
    w.line('// Go has no exceptions; this is the defer/recover equivalent.');
    w.line('func() {');
    w.nest(() => {
      w.line('defer func() {');
      w.nest(() => {
        w.line(`if ${c ? this.name(c.varName) : 'recovered'} := recover(); ${c ? this.name(c.varName) : 'recovered'} != nil {`);
        w.nest(() => {
          if (c) this.emitBody(w, c.body);
          else w.line('panic(recovered)');
        });
        w.line('}');
      });
      w.line('}()');
      this.emitBody(w, s.body);
    });
    w.line('}()');
    if (s.finally?.length) this.emitBody(w, s.finally);
  }

  protected override exprInner(e: IrExpr): string {
    if (e.k === 'ternary') {
      // No conditional operator in Go; an inline closure keeps the semantics.
      const t = this.type(e.type) || 'any';
      return `func() ${t} { if ${this.expr(e.cond)} { return ${this.expr(e.then)} }; return ${this.expr(e.else)} }()`;
    }
    if (e.k === 'new') {
      return `${this.typeName(e.className)}{}`;
    }
    return super.exprInner(e);
  }

  protected override binaryOp(op: string): string {
    return op === '&&' ? '&&' : op === '||' ? '||' : op;
  }

  protected override arrayLit(e: Extract<IrExpr, { k: 'array' }>): string {
    return `${this.type(e.type)}{${e.items.map((i) => this.expr(i)).join(', ')}}`;
  }

  protected override mapLit(e: Extract<IrExpr, { k: 'mapLit' }>): string {
    const body = e.entries.map((en) => `${this.expr(en.key)}: ${this.expr(en.value)}`).join(', ');
    return `${this.type(e.type)}{${body}}`;
  }

  protected override tupleLit(e: Extract<IrExpr, { k: 'tupleLit' }>): string {
    return `[]any{${e.items.map((i) => this.expr(i)).join(', ')}}`;
  }

  protected override lambda(e: Extract<IrExpr, { k: 'lambda' }>): string {
    const params = e.params.map((p) => `${this.name(p.name)} ${this.type(p.type)}`).join(', ');
    const ret = e.type.kind === 'function' && e.type.returns.kind !== 'void' ? ` ${this.type(e.type.returns)}` : '';
    const inner = new CodeWriter('\t');
    if (Array.isArray(e.body)) this.emitBody(inner, e.body);
    else inner.line(`return ${this.expr(e.body)}`);
    return `func(${params})${ret} {\n${inner.toString().replace(/\n$/, '')}\n}`;
  }

  protected override cast(e: Extract<IrExpr, { k: 'cast' }>): string {
    const inner = this.expr(e.expr, 17);
    if (e.to.kind === 'primitive' && e.to.name === 'string') {
      return `${this.need('fmt')}.Sprint(${inner})`;
    }
    return `${this.type(e.to)}(${inner})`;
  }

  protected override selfKeyword(): string {
    return 'self';
  }

  private decl(w: CodeWriter, d: IrDecl): void {
    switch (d.k) {
      case 'function':
        this.funcDecl(w, d);
        break;
      case 'class':
        this.structDecl(w, d);
        break;
      case 'interface':
        this.interfaceDecl(w, d);
        break;
      case 'enum':
        this.enumDecl(w, d);
        break;
      case 'global':
        w.blank();
        if (d.doc) w.line(`// ${this.exported(d.name)} ${d.doc}`);
        w.line(`var ${this.exported(d.name)} ${this.type(d.type)} = ${d.init ? this.expr(d.init) : this.zero(d.type)}`);
        break;
      case 'typeAlias':
        w.blank();
        w.line(`type ${this.typeName(d.name)} = ${this.type(d.target)}`);
        break;
      case 'rawDecl':
        if (d.lang !== 'go' && d.lang !== 'any') {
          throw new BackendGenError(`Raw ${d.lang} block cannot be emitted into a Go file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: d.origin,
          });
        }
        w.blank();
        w.verbatim(d.code);
        break;
    }
  }

  private funcDecl(w: CodeWriter, f: IrFunction, receiver?: string): void {
    w.blank();
    const name = f.visibility === 'private' ? this.name(f.name) : this.exported(f.name);
    if (f.doc?.trim()) w.line(`// ${name} ${wrapText(f.doc.trim()).join(' ')}`);
    const recv = receiver ? `(self *${receiver}) ` : '';
    const params = f.params.map((p) => this.declParam(p)).join(', ');
    const ret = f.returns.kind === 'void' ? '' : ` ${this.type(f.returns)}`;
    const outerReads = this.readNames;
    this.readNames = namesRead(f.body);
    w.braced(`func ${recv}${name}(${params})${ret}`, () => {
      this.emitBody(w, f.body);
      if (f.returns.kind !== 'void' && !endsWithReturn(f.body)) w.line(`return ${this.zero(f.returns)}`);
    });
    this.readNames = outerReads;
  }

  /** A binding nothing reads becomes `_ = expr`, which Go accepts. */
  protected override letStatement(s: Extract<IrStmt, { k: 'let' }>): string {
    const init = s.init ? this.expr(s.init) : this.zero(s.type);
    const name = this.name(s.name);
    if (!this.readNames.has(s.name) && !this.readNames.has(name)) return `_ = ${init}`;
    return `${name} := ${init}`;
  }

  private declParam(p: IrParam): string {
    return `${this.name(p.name)} ${p.rest ? '...' : ''}${this.type(p.type)}`;
  }

  private structDecl(w: CodeWriter, c: IrClass): void {
    w.blank();
    if (c.doc?.trim()) w.line(`// ${this.typeName(c.name)} ${wrapText(c.doc.trim()).join(' ')}`);
    w.line(`type ${this.typeName(c.name)} struct {`);
    w.nest(() => {
      if (c.extends) w.line(`${this.type(c.extends)} // embedded base`);
      for (const f of c.fields) {
        const comment = f.doc ? ` // ${f.doc}` : '';
        w.line(`${this.exported(f.name)} ${this.type(f.type)}${comment}`);
      }
    });
    w.line('}');

    if (c.ctor) {
      w.blank();
      const params = c.ctor.params.map((p) => this.declParam(p)).join(', ');
      w.braced(`func New${this.typeName(c.name)}(${params}) *${this.typeName(c.name)}`, () => {
        w.line(`self := &${this.typeName(c.name)}{}`);
        this.emitBody(w, c.ctor!.body);
        w.line('return self');
      });
    }
    for (const m of c.methods) this.funcDecl(w, m, this.typeName(c.name));
  }

  private interfaceDecl(w: CodeWriter, i: IrInterface): void {
    w.blank();
    if (i.doc?.trim()) w.line(`// ${this.typeName(i.name)} ${wrapText(i.doc.trim()).join(' ')}`);
    w.line(`type ${this.typeName(i.name)} interface {`);
    w.nest(() => {
      for (const e of i.extends ?? []) w.line(this.type(e));
      for (const m of i.methods) {
        const ret = m.returns.kind === 'void' ? '' : ` ${this.type(m.returns)}`;
        w.line(`${this.exported(m.name)}(${m.params.map((p) => this.declParam(p)).join(', ')})${ret}`);
      }
    });
    w.line('}');
  }

  private enumDecl(w: CodeWriter, e: IrEnum): void {
    w.blank();
    if (e.doc?.trim()) w.line(`// ${this.typeName(e.name)} ${e.doc.trim()}`);
    w.line(`type ${this.typeName(e.name)} int`);
    w.blank();
    w.line('const (');
    w.nest(() => {
      e.variants.forEach((v, i) => {
        const name = `${this.typeName(e.name)}${pascal(v.name)}`;
        w.line(i === 0 ? `${name} ${this.typeName(e.name)} = iota` : name);
      });
    });
    w.line(')');
  }

  protected override memberName(name: string): string {
    return pascal(name);
  }

  override builtin(e: Extract<IrExpr, { k: 'builtin' }>): string {
    const a = e.args.map((x) => this.expr(x, 17));
    const rt = () => this.need(`${moduleRootOf(this.ctx.project)}/mcruntime`);
    const fmt = () => this.need('fmt');
    const math = () => this.need('math');
    const strings = () => this.need('strings');

    switch (e.op) {
      case 'print':
        return `${fmt()}.Println(${a.join(', ')})`;
      case 'print_err':
        return `${fmt()}.Fprintln(${this.need('os')}.Stderr, ${a.join(', ')})`;
      case 'read_line':
        return `${rt()}.ReadLine()`;
      case 'to_string':
        return `${fmt()}.Sprint(${a[0]})`;
      case 'to_int':
        return `int64(${rt()}.ToFloat(${a[0]}))`;
      case 'to_float':
        return `${rt()}.ToFloat(${a[0]})`;
      case 'parse_int':
        return `${rt()}.ParseInt(${a[0]})`;
      case 'parse_float':
        return `${rt()}.ParseFloat(${a[0]})`;
      case 'len':
        return `int64(len(${a[0]}))`;
      case 'is_empty':
        return `len(${a[0]}) == 0`;
      case 'str_concat':
        return `${a[0]} + ${a[1]}`;
      case 'str_upper':
        return `${strings()}.ToUpper(${a[0]})`;
      case 'str_lower':
        return `${strings()}.ToLower(${a[0]})`;
      case 'str_trim':
        return `${strings()}.TrimSpace(${a[0]})`;
      case 'str_split':
        return `${strings()}.Split(${a[0]}, ${a[1]})`;
      case 'str_join':
        return `${strings()}.Join(${a[0]}, ${a[1]})`;
      case 'str_replace':
        return `${strings()}.ReplaceAll(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'str_contains':
        return `${strings()}.Contains(${a[0]}, ${a[1]})`;
      case 'str_starts_with':
        return `${strings()}.HasPrefix(${a[0]}, ${a[1]})`;
      case 'str_ends_with':
        return `${strings()}.HasSuffix(${a[0]}, ${a[1]})`;
      case 'str_index_of':
        return `int64(${strings()}.Index(${a[0]}, ${a[1]}))`;
      case 'str_substring':
        return `${rt()}.Substring(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'str_char_at':
        return `${rt()}.Substring(${a[0]}, ${a[1]}, ${a[1]}+1)`;
      case 'str_repeat':
        return `${strings()}.Repeat(${a[0]}, int(${a[1]}))`;
      case 'str_pad_left':
        return `${rt()}.PadLeft(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'format':
        return `${rt()}.Format(${a.join(', ')})`;
      case 'list_new':
        return `${this.type(e.type)}{}`;
      case 'list_get':
        return `${a[0]}[${a[1]}]`;
      case 'list_set':
        return `${a[0]}[${a[1]}] = ${a[2]}`;
      case 'list_push':
        return `${a[0]} = append(${a[0]}, ${a[1]})`;
      case 'list_contains':
        return `${rt()}.Contains(${a[0]}, ${a[1]})`;
      case 'list_index_of':
        return `${rt()}.IndexOf(${a[0]}, ${a[1]})`;
      case 'list_slice':
        return `${a[0]}[${a[1]}:${a[2]}]`;
      case 'list_concat':
        return `append(append(${this.type(e.type)}{}, ${a[0]}...), ${a[1]}...)`;
      case 'list_range':
        return `${rt()}.Range(${a[0]}, ${a[1]})`;
      case 'list_sum':
        return `${rt()}.Sum(${a[0]})`;

      // Go's standard library has no functional collection operations, so all
      // of these route through generic helpers in the runtime package.
      case 'list_map':
        return `${rt()}.Map(${a[0]}, ${a[1]})`;
      case 'list_filter':
        return `${rt()}.Filter(${a[0]}, ${a[1]})`;
      case 'list_reduce':
        return `${rt()}.Reduce(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'list_any':
        return `${rt()}.Any(${a[0]}, ${a[1]})`;
      case 'list_all':
        return `${rt()}.All(${a[0]}, ${a[1]})`;
      case 'list_find':
        return `${rt()}.Find(${a[0]}, ${a[1]})`;
      case 'list_sort':
        return `${rt()}.Sort(${a[0]})`;
      case 'list_sort_by':
        return `${rt()}.SortBy(${a[0]}, ${a[1]})`;
      case 'list_min':
        return `${rt()}.Min(${a[0]})`;
      case 'list_max':
        return `${rt()}.Max(${a[0]})`;
      case 'list_unique':
        return `${rt()}.Unique(${a[0]})`;
      case 'list_reverse':
        return `${rt()}.Reverse(${a[0]})`;
      case 'list_pop':
        return `${rt()}.Pop(${a[0]})`;
      case 'list_insert':
        return `${a[0]} = ${rt()}.Insert(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'list_remove_at':
        return `${a[0]} = ${rt()}.RemoveAt(${a[0]}, ${a[1]})`;

      // A Go set is a map to empty structs; there is no set type.
      case 'set_new':
        return `${this.type(e.type)}{}`;
      case 'set_add':
        return `${rt()}.SetAdd(${a[0]}, ${a[1]})`;
      case 'set_has':
        return `${rt()}.SetHas(${a[0]}, ${a[1]})`;
      case 'set_remove':
        return `${rt()}.SetRemove(${a[0]}, ${a[1]})`;
      case 'set_to_list':
        return `${rt()}.SetToList(${a[0]})`;
      case 'map_new':
        return `${this.type(e.type)}{}`;
      case 'map_get':
        return `${rt()}.MapGet(${a[0]}, ${a[1]})`;
      case 'map_get_or':
        return `${rt()}.MapGetOr(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'map_set':
        return `${a[0]}[${a[1]}] = ${a[2]}`;
      case 'map_has':
        return `${rt()}.MapHas(${a[0]}, ${a[1]})`;
      case 'map_remove':
        return `delete(${a[0]}, ${a[1]})`;
      case 'map_keys':
        return `${rt()}.MapKeys(${a[0]})`;
      case 'map_values':
        return `${rt()}.MapValues(${a[0]})`;
      case 'math_abs':
        return `${math()}.Abs(${a[0]})`;
      case 'math_floor':
        return `int64(${math()}.Floor(${a[0]}))`;
      case 'math_ceil':
        return `int64(${math()}.Ceil(${a[0]}))`;
      case 'math_round':
        return `int64(${math()}.Round(${a[0]}))`;
      case 'math_sqrt':
        return `${math()}.Sqrt(${a[0]})`;
      case 'math_pow':
        return `${math()}.Pow(${a[0]}, ${a[1]})`;
      case 'math_min':
        return `${math()}.Min(${a[0]}, ${a[1]})`;
      case 'math_max':
        return `${math()}.Max(${a[0]}, ${a[1]})`;
      case 'math_log':
        return `${math()}.Log(${a[0]})`;
      case 'math_exp':
        return `${math()}.Exp(${a[0]})`;
      case 'math_sin':
        return `${math()}.Sin(${a[0]})`;
      case 'math_cos':
        return `${math()}.Cos(${a[0]})`;
      case 'math_tan':
        return `${math()}.Tan(${a[0]})`;
      case 'math_atan2':
        return `${math()}.Atan2(${a[0]}, ${a[1]})`;
      case 'math_idiv':
        return `${a[0]} / ${a[1]}`;
      case 'math_pi':
        return `${math()}.Pi`;
      case 'json_parse':
        return `${rt()}.JSONParse(${a[0]})`;
      case 'json_stringify':
        return `${rt()}.JSONStringify(${a[0]}, ${a[1]})`;
      case 'json_get':
        return `${rt()}.JSONGet(${a[0]}, ${a[1]})`;
      case 'file_read_text':
        return `${rt()}.ReadText(${a[0]})`;
      case 'file_delete':
        return `${rt()}.DeleteFile(${a[0]})`;
      case 'json_as_string':
        return `${rt()}.JSONString(${a[0]})`;
      case 'json_as_number':
        return `${rt()}.JSONNumber(${a[0]})`;
      case 'json_as_list':
        return `${rt()}.JSONList(${a[0]})`;
      case 'file_write_text':
        return `${rt()}.WriteText(${a[0]}, ${a[1]})`;
      case 'file_append_text':
        return `${rt()}.AppendText(${a[0]}, ${a[1]})`;
      case 'file_exists':
        return `${rt()}.FileExists(${a[0]})`;
      case 'dir_list':
        return `${rt()}.ListDir(${a[0]})`;
      case 'dir_create':
        return `${rt()}.CreateDir(${a[0]})`;
      case 'path_join':
        return `${this.need('path/filepath')}.Join(${a[0]}, ${a[1]})`;
      case 'http_request':
        return `${rt()}.HTTPRequest(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]})`;
      case 'env_get':
        return `${rt()}.EnvGet(${a[0]})`;
      case 'args_get':
        return `${this.need('os')}.Args[1:]`;
      case 'time_now_ms':
        return `${this.need('time')}.Now().UnixMilli()`;
      case 'time_sleep_ms':
        return `${this.need('time')}.Sleep(${this.need('time')}.Duration(${a[0]}) * ${this.need('time')}.Millisecond)`;
      case 'random_float':
        return `${this.need('math/rand')}.Float64()`;
      case 'random_int':
        return `(${a[0]} + ${this.need('math/rand')}.Int63n(${a[1]}-${a[0]}))`;
      case 'error_new':
        return `${this.need('errors')}.New(${a[0]})`;
      case 'error_message':
        return `${fmt()}.Sprint(${a[0]})`;
      // -- pattern, encoding, digest, identity, time, optional, concurrency ---
      // Every one of these is standard library in Go, which is why the adapter
      // needs no module beyond the generated one.
      case 'regex_match':
        return `${rt()}.RegexMatch(${a[0]}, ${a[1]})`;
      case 'regex_find_all':
        return `${rt()}.RegexFindAll(${a[0]}, ${a[1]})`;
      case 'regex_capture':
        return `${rt()}.RegexCapture(${a[0]}, ${a[1]})`;
      case 'regex_replace':
        return `${rt()}.RegexReplace(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'regex_split':
        return `${rt()}.RegexSplit(${a[0]}, ${a[1]})`;

      case 'base64_encode':
        return `${rt()}.Base64Encode(${a[0]})`;
      case 'base64_decode':
        return `${rt()}.Base64Decode(${a[0]})`;
      case 'hex_encode':
        return `${rt()}.HexEncode(${a[0]})`;
      case 'url_encode':
        return `${rt()}.URLEncode(${a[0]})`;
      case 'url_decode':
        return `${rt()}.URLDecode(${a[0]})`;

      case 'hash_sha256':
        return `${rt()}.HashSHA256(${a[0]})`;
      case 'hash_sha1':
        return `${rt()}.HashSHA1(${a[0]})`;
      case 'hash_md5':
        return `${rt()}.HashMD5(${a[0]})`;
      case 'hmac_sha256':
        return `${rt()}.HMACSHA256(${a[0]}, ${a[1]})`;

      case 'uuid_v4':
        return `${rt()}.UUIDv4()`;
      case 'time_now_iso':
        return `${rt()}.NowISO()`;
      case 'time_parse_iso':
        return `${rt()}.ParseISO(${a[0]})`;
      case 'time_format_iso':
        return `${rt()}.FormatISO(${a[0]})`;

      case 'option_or':
        return `${rt()}.OptionOr(${a[0]}, ${a[1]})`;
      case 'option_is_some':
        return `${rt()}.OptionIsSome(${a[0]})`;
      case 'option_unwrap':
        return `${rt()}.RequireValue(${a[0]}, ${a[1]})`;

      case 'json_path':
        return `${rt()}.JSONPath(${a[0]}, ${a[1]})`;

      case 'parallel_map':
        return `${rt()}.ParallelMap(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'parallel_all':
        return `${rt()}.ParallelAll(${a[0]}, ${a[1]})`;
      case 'schedule_every':
        return `${rt()}.ScheduleEvery(${a[0]}, ${a[1]})`;

      case 'db_open':
        return `${rt()}.DBOpen(${a[0]})`;
      case 'db_execute':
        return `${rt()}.DBExecute(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'db_query':
        return `${rt()}.DBQuery(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'db_close':
        return `${rt()}.DBClose(${a[0]})`;

      case 'http_serve':
        return `${rt()}.HTTPServe(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'http_reply':
        return `${rt()}.HTTPReply(${a[0]}, ${a[1]}, ${a[2]})`;

      case 'assert':
        return `${rt()}.Check(${a[0]}, ${a[1]})`;
      case 'assert_eq':
        return `${rt()}.CheckEqual(${a[0]}, ${a[1]}, ${a[2]})`;
      default:
        throw new BackendGenError(
          `The Go backend does not implement "${e.op}". Use a Custom Code node, or extend the Go adapter.`,
          { code: 'codegen/unsupported-builtin', origin: e.origin },
        );
    }
  }
}

/**
 * Every local name the body reads.
 *
 * Deliberately over-collects: a name that appears anywhere counts, even in a
 * nested closure. Over-collecting keeps a binding that Go would have accepted
 * either way; under-collecting would emit `_` for something later referenced
 * and break the build.
 */
function namesRead(body: IrStmt[]): Set<string> {
  const names = new Set<string>();
  const visitor: IrVisitor = {
    expr(e) {
      if (e.k === 'ref') names.add(e.name);
    },
  };
  for (const stmt of body) walkStmt(stmt, visitor);
  return names;
}

function endsWithReturn(body: IrStmt[]): boolean {
  const last = body[body.length - 1];
  return !!last && (last.k === 'return' || last.k === 'throw');
}

function dirOf(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

function packageOf(path: string): string {
  const dir = dirOf(path);
  if (!dir || dir === 'src' || dir === '.') return 'main';
  return (dir.split('/').pop() ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function moduleRoot(project: Project): string {
  return moduleRootOf(project);
}

function moduleRootOf(project: Project): string {
  return (project.namespace ?? `example.com/${project.name}`)
    .toLowerCase()
    .replace(/[^a-z0-9./-]/g, '');
}

export const goBackend: LanguageBackend = {
  id: 'go',
  name: 'Go',
  maturity: 'full',
  extensions: ['.go'],
  features: defaultFeatures({ compiled: true, exceptions: false, inheritance: false }),
  lineComment: '//',
  blockComment: { open: '/*', close: '*/' },
  indent: '\t',
  keywords: KEYWORDS,

  packageManager: {
    id: 'gomod',
    name: 'Go modules',
    installAll: { label: 'go mod tidy', command: 'go', args: ['mod', 'tidy'] },
    installOne: { label: 'go get', command: 'go', args: ['get', '{name}@{version}'] },
    manifestFile: 'go.mod',
    lockFile: 'go.sum',
  },

  toolchain: [{ command: 'go', versionArgs: ['version'], installHint: 'Install Go 1.21 or newer from go.dev/dl.' }],

  entry: { file: 'main.go', symbol: 'main', description: 'Package main with a func main().' },

  sourceRoot: () => '',
  testRoot: () => '',
  pathFor: (file) => file.path.replace(/^src\//, ''),

  mapType(type, project) {
    return new GoEmitter(scratchContext(project, 'go')).type(type);
  },

  importFor(_from, to, _symbols, project) {
    return `import "${moduleRootOf(project)}/${dirOf(to.path)}"`;
  },

  crossFileReference(symbol, to) {
    const pkg = packageOf(to.path);
    return pkg === 'main' ? pascal(symbol) : `${pkg}.${pascal(symbol)}`;
  },

  emitModule(ctx) {
    return new GoEmitter(ctx).emit();
  },

  emitProjectFiles(project, program) {
    const deps = project.dependencies
      .filter((d) => d.language === 'go')
      .map((d) => ({ name: d.name, version: d.version === '*' ? 'latest' : d.version }));

    // The database helpers are the only part of the runtime needing a module
    // outside the standard library, so they are written - and the driver
    // required - only when a graph actually opens a database. A project that
    // never touches SQLite still generates with an empty go.mod.
    const ops = usedBuiltins(program);
    const usesDb = ['db_open', 'db_execute', 'db_query', 'db_close'].some((op) => ops.has(op));
    if (usesDb && !deps.some((d) => d.name === SQLITE_DRIVER)) {
      deps.push({ name: SQLITE_DRIVER, version: SQLITE_DRIVER_VERSION });
    }

    const files: GeneratedFile[] = [
      {
        path: 'go.mod',
        role: 'manifest',
        content: [
          `module ${moduleRootOf(project)}`,
          '',
          'go 1.21',
          '',
          ...(deps.length
            ? [
                'require (',
                ...deps.map((d) => `\t${d.name} ${d.version}`),
                ')',
                '',
                '// Run: go mod tidy   (writes go.sum and pulls indirect modules)',
                '',
              ]
            : ['// No external dependencies. Add them from the library catalogue.', '']),
        ].join('\n'),
      },
      { path: 'mcruntime/runtime.go', role: 'source', content: GO_RUNTIME },
    ];
    if (usesDb) files.push({ path: 'mcruntime/db.go', role: 'source', content: GO_DB_RUNTIME });
    return files;
  },

  buildPlan(_project, mode: BuildMode): BuildPlan {
    // `.` rather than `./...`: the runtime package is a second package, and
    // `go build -o <file>` refuses to write more than one of them to a single
    // path. Building the main package pulls the rest in as dependencies.
    // Windows will not execute a binary without the extension, so name it.
    const artifact = process.platform === 'win32' ? 'build/app.exe' : 'build/app';
    return {
      steps: [
        {
          label: `go build (${mode})`,
          command: 'go',
          args: ['build', ...(mode === 'release' ? ['-ldflags', '-s -w'] : []), '-o', artifact, '.'],
        },
      ],
      artifact,
    };
  },

  runPlan: () => ({ command: { label: 'Run', command: 'go', args: ['run', '.'] } }),
  testPlan: () => ({ steps: [{ label: 'go test', command: 'go', args: ['test', './...'] }] }),

  parseDiagnostics(output): Diagnostic[] {
    const out: Diagnostic[] = [];
    const re = /^(.+?\.go):(\d+):(\d+):\s*(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output))) {
      out.push({
        severity: 'error',
        stage: 'build',
        code: 'go/compile',
        message: m[4].trim(),
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]),
        column: Number(m[3]),
        raw: m[0],
      });
    }
    return out;
  },
};

const GO_RUNTIME = `// Package mcruntime holds helpers used by generated Master Code programs.
//
// This file is generated. Edit the graph, not this.
package mcruntime

import (
	"bufio"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// HTTPResponse is the outcome of a request. Transport failures arrive as status 0.
type HTTPResponse struct {
	Status  int64
	Body    string
	Headers map[string]string
}

var stdin = bufio.NewReader(os.Stdin)

// ReadLine reads one line from standard input.
func ReadLine() string {
	line, err := stdin.ReadString('\\n')
	if err != nil && line == "" {
		return ""
	}
	return strings.TrimRight(line, "\\r\\n")
}

// ToFloat converts any value to a float64, yielding 0 when it cannot.
func ToFloat(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0
		}
		return parsed
	}
	return 0
}

// ParseInt returns a pointer to the parsed value, or nil when it does not parse.
func ParseInt(text string) *int64 {
	value, err := strconv.ParseInt(strings.TrimSpace(text), 10, 64)
	if err != nil {
		return nil
	}
	return &value
}

// ParseFloat returns a pointer to the parsed value, or nil when it does not parse.
func ParseFloat(text string) *float64 {
	value, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil {
		return nil
	}
	return &value
}

// Format interpolates {} placeholders in order.
func Format(template string, args ...any) string {
	var out strings.Builder
	index := 0
	for i := 0; i < len(template); i++ {
		if i+1 < len(template) && template[i] == '{' && template[i+1] == '}' {
			if index < len(args) {
				fmt.Fprint(&out, args[index])
				index++
			} else {
				out.WriteString("{}")
			}
			i++
			continue
		}
		out.WriteByte(template[i])
	}
	return out.String()
}

// Substring slices by rune-safe byte offsets, clamped to the string length.
func Substring(text string, start, end int64) string {
	runes := []rune(text)
	from := clamp(start, 0, int64(len(runes)))
	to := clamp(end, from, int64(len(runes)))
	return string(runes[from:to])
}

// PadLeft pads text on the left until it reaches the given width.
func PadLeft(text string, width int64, fill string) string {
	if fill == "" {
		return text
	}
	for int64(len(text)) < width {
		text = fill + text
	}
	return text
}

// Contains reports whether a slice holds a value.
func Contains[T comparable](list []T, value T) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// IndexOf returns the first index of a value, or -1.
func IndexOf[T comparable](list []T, value T) int64 {
	for i, item := range list {
		if item == value {
			return int64(i)
		}
	}
	return -1
}

// Range returns the integers from start (inclusive) to end (exclusive).
func Range(start, end int64) []int64 {
	out := []int64{}
	for i := start; i < end; i++ {
		out = append(out, i)
	}
	return out
}

// Sum totals a slice of numbers.
func Sum[T int64 | float64](list []T) float64 {
	var total float64
	for _, item := range list {
		total += float64(item)
	}
	return total
}

// MapHas reports whether a key is present.
func MapHas[K comparable, V any](m map[K]V, key K) bool {
	_, ok := m[key]
	return ok
}

// MapGetOr returns the value for a key, or a fallback.
func MapGetOr[K comparable, V any](m map[K]V, key K, fallback V) V {
	if value, ok := m[key]; ok {
		return value
	}
	return fallback
}

// MapKeys returns the keys in sorted order, so output is reproducible.
func MapKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// MapValues returns the values ordered by their sorted keys.
func MapValues[V any](m map[string]V) []V {
	out := make([]V, 0, len(m))
	for _, key := range MapKeys(m) {
		out = append(out, m[key])
	}
	return out
}

// JSONParse decodes JSON text into a dynamic value.
func JSONParse(text string) any {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil
	}
	return value
}

// JSONStringify encodes a value as JSON.
func JSONStringify(value any, pretty bool) string {
	var data []byte
	var err error
	if pretty {
		data, err = json.MarshalIndent(value, "", "  ")
	} else {
		data, err = json.Marshal(value)
	}
	if err != nil {
		return ""
	}
	return string(data)
}

// JSONGet reads a field from a decoded JSON object.
func JSONGet(value any, field string) any {
	if object, ok := value.(map[string]any); ok {
		return object[field]
	}
	return nil
}

// ReadText reads a whole UTF-8 file, returning "" on failure.
func ReadText(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

// WriteText writes a UTF-8 file, replacing it.
func WriteText(path, text string) {
	_ = os.WriteFile(path, []byte(text), 0o644)
}

// AppendText appends to a UTF-8 file.
func AppendText(path, text string) {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(text)
}

// FileExists reports whether a path exists.
func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ListDir returns the sorted entry names of a directory.
func ListDir(path string) []string {
	entries, err := os.ReadDir(path)
	if err != nil {
		return []string{}
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry.Name())
	}
	sort.Strings(out)
	return out
}

// CreateDir creates a directory and any missing parents.
func CreateDir(path string) {
	_ = os.MkdirAll(filepath.Clean(path), 0o755)
}

// HTTPRequest performs a request. It never panics; failures arrive as status 0.
func HTTPRequest(method, url string, headers map[string]string, body string) HTTPResponse {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, err := http.NewRequest(strings.ToUpper(method), url, reader)
	if err != nil {
		return HTTPResponse{Status: 0, Body: err.Error(), Headers: map[string]string{}}
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return HTTPResponse{Status: 0, Body: err.Error(), Headers: map[string]string{}}
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	out := map[string]string{}
	for key := range response.Header {
		out[strings.ToLower(key)] = response.Header.Get(key)
	}
	return HTTPResponse{Status: int64(response.StatusCode), Body: string(data), Headers: out}
}

// Check panics unless the condition holds.
func Check(condition bool, message string) {
	if !condition {
		panic("assertion failed: " + message)
	}
}

// CheckEqual panics unless the two values render identically.
func CheckEqual(actual, expected any, message string) {
	if fmt.Sprint(actual) != fmt.Sprint(expected) {
		panic(fmt.Sprintf("%s: expected %v, got %v", message, expected, actual))
	}
}

func clamp(value, low, high int64) int64 {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

// DeleteFile removes a file; a missing file is not an error.
func DeleteFile(path string) {
	_ = os.Remove(path)
}

// -- reading parsed JSON ------------------------------------------------------
//
// JSONParse yields any, which is what encoding/json produces. These narrow it
// to the shape the graph asked for, returning the zero value rather than
// panicking when the document does not match — a graph should not crash because
// a field it read was a string this time.

// JSONString reads a value as text, rendering non-strings rather than failing.
func JSONString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

// JSONNumber reads a value as a number. encoding/json decodes every number as
// float64, so that is the only case that needs handling.
func JSONNumber(value any) float64 {
	switch n := value.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	case int:
		return float64(n)
	}
	return 0
}

// JSONList reads a value as an array, or an empty slice when it is not one.
func JSONList(value any) []any {
	if items, ok := value.([]any); ok {
		return items
	}
	return []any{}
}

// -- collections -------------------------------------------------------------
//
// Go has no map/filter/reduce in its standard library, so they live here as
// generics. Every one of these returns a new slice rather than mutating the
// argument: the IR treats a list operation as an expression, and a caller that
// still holds the original would otherwise see it change underneath them.

// Map applies fn to each element, producing a new slice.
func Map[T any, U any](list []T, fn func(T) U) []U {
	out := make([]U, 0, len(list))
	for _, item := range list {
		out = append(out, fn(item))
	}
	return out
}

// Filter keeps the elements fn accepts.
func Filter[T any](list []T, fn func(T) bool) []T {
	out := make([]T, 0, len(list))
	for _, item := range list {
		if fn(item) {
			out = append(out, item)
		}
	}
	return out
}

// Reduce folds the list left to right from an initial value.
func Reduce[T any, U any](list []T, fn func(U, T) U, initial U) U {
	acc := initial
	for _, item := range list {
		acc = fn(acc, item)
	}
	return acc
}

// Any reports whether fn accepts at least one element.
func Any[T any](list []T, fn func(T) bool) bool {
	for _, item := range list {
		if fn(item) {
			return true
		}
	}
	return false
}

// All reports whether fn accepts every element. True for an empty list.
func All[T any](list []T, fn func(T) bool) bool {
	for _, item := range list {
		if !fn(item) {
			return false
		}
	}
	return true
}

// Find returns the first accepted element, and whether there was one. The IR
// models this as an Option, which is a pointer in generated Go.
// MapGet is a lookup that can say "absent".
//
// A plain m[k] yields the zero value for a missing key, which is
// indistinguishable from a stored zero. The Option the IR declares means the
// difference matters, so this returns nil instead and the graph decides.
func MapGet[K comparable, V any](m map[K]V, key K) *V {
	value, ok := m[key]
	if !ok {
		return nil
	}
	return &value
}

// EnvGet distinguishes an unset variable from one set to the empty string,
// which os.Getenv alone cannot.
func EnvGet(name string) *string {
	value, ok := os.LookupEnv(name)
	if !ok {
		return nil
	}
	return &value
}

func Find[T any](list []T, fn func(T) bool) *T {
	for i, item := range list {
		if fn(item) {
			return &list[i]
		}
	}
	return nil
}

// Sort returns the list in ascending order, leaving the argument untouched.
func Sort[T int64 | float64 | string](list []T) []T {
	out := append([]T(nil), list...)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// SortBy orders by a numeric key extracted from each element.
func SortBy[T any](list []T, key func(T) float64) []T {
	out := append([]T(nil), list...)
	sort.SliceStable(out, func(i, j int) bool { return key(out[i]) < key(out[j]) })
	return out
}

// Min returns the smallest value, or nil for an empty list.
func Min[T int64 | float64](list []T) *float64 {
	if len(list) == 0 {
		return nil
	}
	best := float64(list[0])
	for _, item := range list[1:] {
		if float64(item) < best {
			best = float64(item)
		}
	}
	return &best
}

// Max returns the largest value, or nil for an empty list.
func Max[T int64 | float64](list []T) *float64 {
	if len(list) == 0 {
		return nil
	}
	best := float64(list[0])
	for _, item := range list[1:] {
		if float64(item) > best {
			best = float64(item)
		}
	}
	return &best
}

// Unique removes repeats, keeping the first occurrence of each value.
func Unique[T comparable](list []T) []T {
	seen := map[T]bool{}
	out := make([]T, 0, len(list))
	for _, item := range list {
		if !seen[item] {
			seen[item] = true
			out = append(out, item)
		}
	}
	return out
}

// Reverse returns the list back to front.
func Reverse[T any](list []T) []T {
	out := make([]T, 0, len(list))
	for i := len(list) - 1; i >= 0; i-- {
		out = append(out, list[i])
	}
	return out
}

// Pop returns the last element, or nil when the list is empty.
func Pop[T any](list []T) *T {
	if len(list) == 0 {
		return nil
	}
	return &list[len(list)-1]
}

// Insert puts value at index, clamped into range.
func Insert[T any](list []T, index int64, value T) []T {
	at := int(clamp(index, 0, int64(len(list))))
	out := append([]T(nil), list[:at]...)
	out = append(out, value)
	return append(out, list[at:]...)
}

// RemoveAt drops the element at index, or returns the list unchanged.
func RemoveAt[T any](list []T, index int64) []T {
	if index < 0 || int(index) >= len(list) {
		return append([]T(nil), list...)
	}
	out := append([]T(nil), list[:index]...)
	return append(out, list[index+1:]...)
}

// -- sets ---------------------------------------------------------------------
//
// Go has no set type. This mirrors what the type mapper emits for Set<T>,
// which is map[T]bool — keep the two in step.

// SetAdd inserts a value.
func SetAdd[T comparable](set map[T]bool, value T) {
	set[value] = true
}

// SetHas reports membership.
func SetHas[T comparable](set map[T]bool, value T) bool {
	return set[value]
}

// SetRemove deletes a value; absent is not an error.
func SetRemove[T comparable](set map[T]bool, value T) {
	delete(set, value)
}

// SetToList returns the members in a stable order, so generated programs are
// -- pattern matching --------------------------------------------------------

// compilePattern compiles once and says which pattern failed, rather than
// leaving the caller with regexp's context-free complaint.
func compilePattern(pattern string) *regexp.Regexp {
	re, err := regexp.Compile(pattern)
	if err != nil {
		panic(fmt.Sprintf("invalid pattern %q: %v", pattern, err))
	}
	return re
}

func RegexMatch(text string, pattern string) bool {
	return compilePattern(pattern).MatchString(text)
}

func RegexFindAll(text string, pattern string) []string {
	found := compilePattern(pattern).FindAllString(text, -1)
	if found == nil {
		return []string{}
	}
	return found
}

// RegexCapture returns the whole match at index 0 and the groups after it.
func RegexCapture(text string, pattern string) []string {
	match := compilePattern(pattern).FindStringSubmatch(text)
	if match == nil {
		return []string{}
	}
	return match
}

// RegexReplace honours only the nine numbered groups and a doubled dollar, the
// same set every other backend honours. Go's Expand syntax is close but not
// identical, so the template is walked here rather than handed over.
func RegexReplace(text string, pattern string, replacement string) string {
	re := compilePattern(pattern)
	return re.ReplaceAllStringFunc(text, func(whole string) string {
		groups := re.FindStringSubmatch(whole)
		var out strings.Builder
		for i := 0; i < len(replacement); i++ {
			ch := replacement[i]
			if ch != '$' || i+1 >= len(replacement) {
				out.WriteByte(ch)
				continue
			}
			next := replacement[i+1]
			switch {
			case next == '$':
				out.WriteByte('$')
				i++
			case next >= '1' && next <= '9':
				index := int(next - '0')
				if index < len(groups) {
					out.WriteString(groups[index])
				}
				i++
			default:
				out.WriteByte(ch)
			}
		}
		return out.String()
	})
}

func RegexSplit(text string, pattern string) []string {
	return compilePattern(pattern).Split(text, -1)
}

// -- encoding ----------------------------------------------------------------

func Base64Encode(text string) string {
	return base64.StdEncoding.EncodeToString([]byte(text))
}

// Base64Decode panics on input that is not base64, rather than returning an
// empty string that would travel on and fail somewhere with no context.
func Base64Decode(encoded string) string {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		panic(fmt.Sprintf("not valid base64: %.32q", encoded))
	}
	return string(raw)
}

func HexEncode(text string) string {
	return hex.EncodeToString([]byte(text))
}

// URLEncode escapes everything outside the unreserved set, which is what the
// builtin promises. QueryEscape alone would render a space as a plus sign.
func URLEncode(text string) string {
	escaped := url.QueryEscape(text)
	return strings.ReplaceAll(escaped, "+", "%20")
}

func URLDecode(encoded string) string {
	decoded, err := url.QueryUnescape(encoded)
	if err != nil {
		panic(fmt.Sprintf("not valid percent-encoded text: %.32q", encoded))
	}
	return decoded
}

// -- digests -----------------------------------------------------------------

func HashSHA256(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func HashSHA1(text string) string {
	sum := sha1.Sum([]byte(text))
	return hex.EncodeToString(sum[:])
}

func HashMD5(text string) string {
	sum := md5.Sum([]byte(text))
	return hex.EncodeToString(sum[:])
}

func HMACSHA256(key string, message string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

// -- identity and time -------------------------------------------------------

// UUIDv4 is built from crypto/rand rather than a module, so the generated
// project still needs nothing outside the standard library.
func UUIDv4() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(fmt.Sprintf("no randomness available: %v", err))
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

const isoLayout = "2006-01-02T15:04:05.000Z"

func NowISO() string {
	return time.Now().UTC().Format(isoLayout)
}

// ParseISO reads a timestamp carrying no zone as UTC, matching every other
// backend; Go would otherwise refuse it outright.
func ParseISO(text string) *int64 {
	raw := strings.TrimSpace(text)
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02",
	}
	for _, layout := range layouts {
		if moment, err := time.Parse(layout, raw); err == nil {
			millis := moment.UTC().UnixMilli()
			return &millis
		}
	}
	return nil
}

func FormatISO(millis int64) string {
	return time.UnixMilli(millis).UTC().Format(isoLayout)
}

// -- optional values ---------------------------------------------------------

func OptionOr[T any](value *T, fallback T) T {
	if value == nil {
		return fallback
	}
	return *value
}

func OptionIsSome[T any](value *T) bool {
	return value != nil
}

func RequireValue[T any](value *T, message string) T {
	if value == nil {
		panic(fmt.Sprintf("expected a value: %s", message))
	}
	return *value
}

// -- structured access -------------------------------------------------------

// JSONPath follows a dotted path with optional bracketed indexes. Missing is
// nil rather than an error: an absent optional field is the ordinary case.
func JSONPath(value any, path string) *any {
	current := value
	for _, step := range strings.Split(path, ".") {
		if step == "" {
			continue
		}
		name := step
		indexes := []int{}
		if open := strings.Index(step, "["); open >= 0 {
			name = step[:open]
			rest := step[open:]
			for len(rest) > 0 && rest[0] == '[' {
				end := strings.Index(rest, "]")
				if end < 0 {
					return nil
				}
				n, err := strconv.Atoi(rest[1:end])
				if err != nil {
					return nil
				}
				indexes = append(indexes, n)
				rest = rest[end+1:]
			}
		}
		if name != "" {
			object, ok := current.(map[string]any)
			if !ok {
				return nil
			}
			current, ok = object[name]
			if !ok {
				return nil
			}
		}
		for _, n := range indexes {
			items, ok := current.([]any)
			if !ok || n < 0 || n >= len(items) {
				return nil
			}
			current = items[n]
		}
	}
	return &current
}

// -- concurrency -------------------------------------------------------------

// runPool runs worker(i) for every index, at most limit at a time, keeping the
// results in index order. A panic in any task is re-raised on the caller once
// the pool has drained, so one failing lookup fails the group rather than
// taking the process down from an unrelated goroutine.
func runPool(count int, limit int64, worker func(int) any) []any {
	results := make([]any, count)
	if count == 0 {
		return results
	}
	width := int(limit)
	if width < 1 {
		width = 1
	}
	if width > count {
		width = count
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	var failure any
	indexes := make(chan int)

	for w := 0; w < width; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range indexes {
				func() {
					defer func() {
						if r := recover(); r != nil {
							mu.Lock()
							if failure == nil {
								failure = r
							}
							mu.Unlock()
						}
					}()
					results[i] = worker(i)
				}()
			}
		}()
	}
	for i := 0; i < count; i++ {
		indexes <- i
	}
	close(indexes)
	wg.Wait()

	if failure != nil {
		panic(failure)
	}
	return results
}

func ParallelMap[T any, U any](items []T, fn func(T) U, limit int64) []U {
	raw := runPool(len(items), limit, func(i int) any { return fn(items[i]) })
	out := make([]U, len(raw))
	for i, value := range raw {
		out[i], _ = value.(U)
	}
	return out
}

func ParallelAll(tasks []func(), limit int64) []any {
	return runPool(len(tasks), limit, func(i int) any {
		tasks[i]()
		return nil
	})
}

// ScheduleEvery leaves a gap between runs rather than firing at a fixed rate,
// so a slow poll delays the next one instead of overlapping with itself.
func ScheduleEvery(millis int64, task func()) {
	for {
		task()
		time.Sleep(time.Duration(millis) * time.Millisecond)
	}
}

// -- serving -----------------------------------------------------------------

// HTTPRequestIn is one inbound request, as the graph sees it.
type HTTPRequestIn struct {
	Method  string
	Path    string
	Body    string
	Headers map[string]string
	Query   map[string]string
}

// HTTPReplyOut is the answer a handler returns.
type HTTPReplyOut struct {
	Status      int64
	Body        string
	ContentType string
}

func HTTPReply(status int64, body string, contentType string) HTTPReplyOut {
	return HTTPReplyOut{Status: status, Body: body, ContentType: contentType}
}

// HTTPServe listens until the process is interrupted. Go already serves each
// request on its own goroutine, so there is no pool to arrange here.
func HTTPServe(host string, port int64, handler func(HTTPRequestIn) HTTPReplyOut) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		headers := map[string]string{}
		for key, values := range r.Header {
			headers[strings.ToLower(key)] = strings.Join(values, ", ")
		}
		query := map[string]string{}
		for key, values := range r.URL.Query() {
			if len(values) > 0 {
				query[key] = values[len(values)-1]
			}
		}

		reply := HTTPReplyOut{Status: 500, Body: "internal error", ContentType: "text/plain"}
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					// A handler that panicked is a mistake in the graph, not a
					// bad request, so it is reported rather than hidden.
					fmt.Fprintf(os.Stderr, "request handler failed: %v", rec)
				}
			}()
			reply = handler(HTTPRequestIn{
				Method:  r.Method,
				Path:    r.URL.Path,
				Body:    string(body),
				Headers: headers,
				Query:   query,
			})
		}()

		contentType := reply.ContentType
		if contentType == "" {
			contentType = "text/plain"
		}
		w.Header().Set("content-type", contentType)
		w.WriteHeader(int(reply.Status))
		io.WriteString(w, reply.Body)
	})

	address := fmt.Sprintf("%s:%d", host, port)
	server := &http.Server{Addr: address, Handler: mux}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		server.Close()
	}()

	fmt.Fprintf(os.Stderr, "listening on http://%s", address)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		panic(err)
	}
}

// reproducible rather than depending on Go's randomised map iteration.
func SetToList[T comparable](set map[T]bool) []T {
	out := make([]T, 0, len(set))
	for value := range set {
		out = append(out, value)
	}
	sort.Slice(out, func(i, j int) bool { return fmt.Sprint(out[i]) < fmt.Sprint(out[j]) })
	return out
}
`;

const GO_DB_RUNTIME = `// Package mcruntime: SQLite helpers.
//
// This file is written only when a graph actually uses a database node, because
// it is the one part of the generated runtime that needs a module outside the
// standard library. The driver is modernc.org/sqlite, which is SQLite
// translated to pure Go: no cgo, so the project still cross-compiles and still
// builds on a machine with no C toolchain.
//
// This file is generated. Edit the graph, not this.
package mcruntime

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

// DB is an open connection. The path is kept for error messages.
type DB struct {
	Path string
	Conn *sql.DB
}

// DBOpen opens or creates a database file.
//
// sql.Open is lazy, so it reports almost nothing; the Ping is what turns an
// unwritable directory or a corrupt file into an error here rather than three
// statements later with no clue which one opened it.
func DBOpen(path string) *DB {
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		panic(fmt.Sprintf("cannot open database %q: %v", path, err))
	}
	if err := conn.Ping(); err != nil {
		panic(fmt.Sprintf("cannot open database %q: %v", path, err))
	}
	return &DB{Path: path, Conn: conn}
}

// DBExecute runs a parameterised statement and returns the rows affected.
func DBExecute(db *DB, query string, params []any) int64 {
	if db == nil || db.Conn == nil {
		panic("database is not open")
	}
	result, err := db.Conn.Exec(query, params...)
	if err != nil {
		panic(fmt.Sprintf("%v: %s", err, query))
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0
	}
	return affected
}

// DBQuery runs a parameterised query and returns every row as a map.
//
// Values arrive as any, and a driver is free to hand back []byte for text
// columns. Those are converted to string so that a value read out of a row
// compares equal to the same value written in, which is what every graph
// downstream assumes.
func DBQuery(db *DB, query string, params []any) []map[string]any {
	if db == nil || db.Conn == nil {
		panic("database is not open")
	}
	rows, err := db.Conn.Query(query, params...)
	if err != nil {
		panic(fmt.Sprintf("%v: %s", err, query))
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		panic(err)
	}

	out := []map[string]any{}
	for rows.Next() {
		cells := make([]any, len(columns))
		targets := make([]any, len(columns))
		for i := range cells {
			targets[i] = &cells[i]
		}
		if err := rows.Scan(targets...); err != nil {
			panic(err)
		}
		row := map[string]any{}
		for i, name := range columns {
			if raw, ok := cells[i].([]byte); ok {
				row[name] = string(raw)
			} else {
				row[name] = cells[i]
			}
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	return out
}

// DBClose closes a connection opened by DBOpen.
func DBClose(db *DB) {
	if db != nil && db.Conn != nil {
		db.Conn.Close()
	}
}
`;

export { GoEmitter };
