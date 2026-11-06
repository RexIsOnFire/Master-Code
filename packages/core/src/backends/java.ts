/**
 * Java backend.
 *
 * Java allows one public top-level type per file, which does not match the IR's
 * "a module holds several declarations". The mapping used here is the one Java
 * programmers already recognise: the module becomes a public final class named
 * after the file, module-level functions become its static methods, and IR
 * classes become public static nested types. That keeps one generated file per
 * module - so the file graph, imports and rename handling all still work -
 * without bending the language.
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
import { CLikeEmitter, javaLikeDialect } from './clike.ts';
import { CodeWriter, avoidKeyword, camel, pascal, screamingSnake, wrapText } from './emitter.ts';
import { usedBuiltins } from './analysis.ts';
import type {
  IrClass,
  IrDecl,
  IrEnum,
  IrExpr,
  IrFunction,
  IrInterface,
  IrModule,
  IrParam,
  IrStmt,
} from '../ir/ir.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project, ProjectFile } from '../model/project.ts';
import type { TypeRef } from '../types/types.ts';

const KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'var', 'void',
  'volatile', 'while', 'record', 'sealed', 'permits', 'yield',
]);

const RUNTIME_CLASS = 'McRuntime';

class JavaEmitter extends CLikeEmitter {
  private readonly imports = new Set<string>();
  private usesRuntime = false;

  constructor(ctx: EmitContext) {
    super(ctx, javaLikeDialect(), KEYWORDS, '    ');
  }

  protected override get langId(): string {
    return 'java';
  }

  emit(): string {
    const { module, file, project } = this.ctx;
    const className = classNameFor(file);
    const body = new CodeWriter('    ');

    const rawFunctions = module.decls.filter((d): d is IrFunction => d.k === 'function');
    const others = module.decls.filter((d) => d.k !== 'function');
    // `main()` with no arguments is not a JVM entry point, and declaring both
    // it and `main(String[])` reads as an accidental overload. Rename it.
    const functions = rawFunctions.map((f) =>
      f.isEntry && this.name(f.name) === 'main' ? { ...f, name: 'run' } : f,
    );

    body.line(`public final class ${className} {`);
    body.nest(() => {
      body.line(`private ${className}() {`);
      body.nest(() => body.line('// Static holder; not instantiable.'));
      body.line('}');
      for (const d of others) this.decl(body, d);
      for (const f of functions) this.method(body, f, true);
      const entry = functions.find((f) => f.isEntry);
      if (entry) {
        body.blank();
        body.line('/** JVM entry point. */');
        // Generated methods declare `throws Exception` so that IO nodes need no
        // special casing; main has to declare it too.
        body.braced('public static void main(String[] args) throws Exception', () => {
          body.line(`${this.runtime()}.setArgs(args);`);
          body.line(`${this.name(entry.name)}();`);
        });
      }
    });
    body.line('}');

    const head = new CodeWriter('    ');
    for (const l of generatedHeader(javaBackend, file, project)) head.line(l);
    const pkg = packageFor(file, project);
    if (pkg) {
      head.blank();
      head.line(`package ${pkg};`);
    }
    if (this.usesRuntime && pkg) this.imports.add(`${rootPackage(project)}.${RUNTIME_CLASS}`);
    if (this.imports.size) {
      head.blank();
      for (const i of [...this.imports].sort()) head.line(`import ${i};`);
    }
    for (const imp of module.imports) {
      if (imp.source !== 'file') continue;
      const target = this.ctx.program.modules.find((m) => m.id === imp.target);
      if (target) head.line(`import ${packageOfPath(target.path, project)}.${classNameForPath(target.path)};`);
    }
    head.blank();
    if (module.doc) {
      head.line('/**');
      for (const l of wrapText(module.doc)) head.line(` * ${l}`);
      head.line(' */');
    }
    head.block(body.toString().replace(/\n$/, ''));
    return head.toString();
  }

  private need(fqn: string): void {
    this.imports.add(fqn);
  }

  private runtime(): string {
    this.usesRuntime = true;
    return RUNTIME_CLASS;
  }

  override name(raw: string): string {
    return avoidKeyword(camel(raw), KEYWORDS);
  }

  override typeName(raw: string): string {
    return avoidKeyword(pascal(raw), KEYWORDS);
  }

  // -- types -----------------------------------------------------------------

  override type(t: TypeRef): string {
    return this.mapType(t, false);
  }

  /** `boxed` forces `Integer` over `int`, needed inside generics. */
  private mapType(t: TypeRef, boxed: boolean): string {
    switch (t.kind) {
      case 'void':
      case 'exec':
        return boxed ? 'Void' : 'void';
      case 'any':
        return 'Object';
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return boxed ? 'Boolean' : 'boolean';
          case 'i32':
            return boxed ? 'Integer' : 'int';
          case 'i64':
            return boxed ? 'Long' : 'long';
          case 'f32':
            return boxed ? 'Float' : 'float';
          case 'f64':
            return boxed ? 'Double' : 'double';
          case 'string':
            return 'String';
          case 'char':
            return boxed ? 'Character' : 'char';
          case 'bytes':
            return 'byte[]';
        }
        return 'Object';
      case 'list':
        this.need('java.util.List');
        return `List<${this.mapType(t.item, true)}>`;
      case 'set':
        this.need('java.util.Set');
        return `Set<${this.mapType(t.item, true)}>`;
      case 'map':
        this.need('java.util.Map');
        return `Map<${this.mapType(t.key, true)}, ${this.mapType(t.value, true)}>`;
      case 'option':
        // Empty is represented by null, not Optional: the builtins return
        // nullable values, and threading Optional through generated code makes
        // it markedly harder to read for no extra safety here.
        return this.mapType(t.inner, true);
      case 'tuple':
        this.need('java.util.List');
        return 'List<Object>';
      case 'future':
        this.need('java.util.concurrent.CompletableFuture');
        return `CompletableFuture<${this.mapType(t.inner, true)}>`;
      case 'result':
        return this.mapType(t.ok, boxed);
      case 'function':
        return this.functionalInterface(t);
      case 'named':
        switch (t.name) {
          case 'Error':
            return 'Exception';
          case 'Json':
            return 'Object';
          case 'HttpResponse':
            this.usesRuntime = true;
            return `${RUNTIME_CLASS}.HttpResponse`;
          case 'DbConnection':
            this.need('java.sql.Connection');
            return 'Connection';
          case 'Element':
            throw new BackendGenError('DOM types have no Java equivalent.', { code: 'codegen/dom-in-java' });
          default:
            return this.resolvedType(t.name);
        }
      case 'var':
        return 'Object';
    }
  }

  private functionalInterface(t: Extract<TypeRef, { kind: 'function' }>): string {
    const params = t.params.map((p) => this.mapType(p, true));
    const ret = t.returns;
    if (ret.kind === 'void') {
      if (params.length === 0) {
        this.need('java.lang.Runnable');
        return 'Runnable';
      }
      if (params.length === 1) {
        this.need('java.util.function.Consumer');
        return `Consumer<${params[0]}>`;
      }
      this.need('java.util.function.BiConsumer');
      return `BiConsumer<${params[0]}, ${params[1]}>`;
    }
    if (ret.kind === 'primitive' && ret.name === 'bool' && params.length === 1) {
      this.need('java.util.function.Predicate');
      return `Predicate<${params[0]}>`;
    }
    if (params.length === 0) {
      this.need('java.util.function.Supplier');
      return `Supplier<${this.mapType(ret, true)}>`;
    }
    if (params.length === 1) {
      this.need('java.util.function.Function');
      return `Function<${params[0]}, ${this.mapType(ret, true)}>`;
    }
    this.need('java.util.function.BiFunction');
    return `BiFunction<${params[0]}, ${params[1]}, ${this.mapType(ret, true)}>`;
  }

  override zero(t: TypeRef): string {
    switch (t.kind) {
      case 'primitive':
        if (t.name === 'bool') return 'false';
        if (t.name === 'string') return '""';
        if (t.name === 'char') return "' '";
        if (t.name === 'f32' || t.name === 'f64') return '0.0';
        if (t.name === 'bytes') return 'new byte[0]';
        return t.name === 'i64' ? '0L' : '0';
      case 'list':
        this.need('java.util.ArrayList');
        return 'new ArrayList<>()';
      case 'set':
        this.need('java.util.LinkedHashSet');
        return 'new LinkedHashSet<>()';
      case 'map':
        this.need('java.util.LinkedHashMap');
        return 'new LinkedHashMap<>()';
      default:
        return 'null';
    }
  }

  // -- declarations ----------------------------------------------------------

  private decl(w: CodeWriter, d: IrDecl): void {
    switch (d.k) {
      case 'class':
        this.classDecl(w, d);
        break;
      case 'interface':
        this.interfaceDecl(w, d);
        break;
      case 'enum':
        this.enumDecl(w, d);
        break;
      case 'global':
        w.blank();
        if (d.doc) w.line(`/** ${d.doc} */`);
        w.line(
          `public static ${d.constant ? 'final ' : ''}${this.type(d.type)} ` +
            `${d.constant ? screamingSnake(d.name) : this.name(d.name)} = ${d.init ? this.expr(d.init) : this.zero(d.type)};`,
        );
        break;
      case 'typeAlias':
        w.blank();
        w.line(`// type ${d.name} = ${this.type(d.target)} (Java has no type aliases)`);
        break;
      case 'rawDecl':
        if (d.lang !== 'java' && d.lang !== 'any') {
          throw new BackendGenError(`Raw ${d.lang} block cannot be emitted into a Java file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: d.origin,
          });
        }
        w.blank();
        w.verbatim(d.code);
        break;
      case 'function':
        this.method(w, d, true);
        break;
    }
  }

  private javadoc(w: CodeWriter, f: IrFunction): void {
    const lines: string[] = [];
    if (f.doc?.trim()) lines.push(...wrapText(f.doc.trim()));
    for (const p of f.params) lines.push(`@param ${this.name(p.name)} input`);
    if (f.returns.kind !== 'void') lines.push('@return the computed value');
    if (!lines.length) return;
    w.line('/**');
    for (const l of lines) w.line(` * ${l}`);
    w.line(' */');
  }

  private method(w: CodeWriter, f: IrFunction, isStatic: boolean): void {
    w.blank();
    this.javadoc(w, f);
    const vis = f.visibility === 'private' ? 'private' : 'public';
    const staticKw = isStatic || f.isStatic ? 'static ' : '';
    const params = f.params.map((p) => this.declParam(p)).join(', ');
    const throwsClause = ' throws Exception';
    w.braced(`${vis} ${staticKw}${this.type(f.returns)} ${this.name(f.name)}(${params})${throwsClause}`, () => {
      this.emitBody(w, f.body);
      if (f.returns.kind !== 'void' && !endsWithReturn(f.body)) {
        w.line(`return ${this.zero(f.returns)};`);
      }
    });
  }

  private declParam(p: IrParam): string {
    return `${p.rest ? `${this.type(p.type)}...` : this.type(p.type)} ${this.name(p.name)}`;
  }

  private classDecl(w: CodeWriter, c: IrClass): void {
    w.blank();
    if (c.doc?.trim()) w.line(`/** ${wrapText(c.doc.trim()).join(' ')} */`);
    const parts = ['public', 'static'];
    if (c.isAbstract) parts.push('abstract');
    parts.push('class', this.typeName(c.name));
    if (c.extends) parts.push('extends', this.type(c.extends));
    if (c.implements?.length) parts.push('implements', c.implements.map((i) => this.type(i)).join(', '));
    w.braced(parts.join(' '), () => {
      for (const f of c.fields) {
        if (f.doc) w.line(`/** ${f.doc} */`);
        const mods = [f.visibility === 'private' ? 'private' : 'public'];
        if (f.isStatic) mods.push('static');
        if (f.readonly) mods.push('final');
        w.line(`${mods.join(' ')} ${this.type(f.type)} ${this.name(f.name)} = ${f.init ? this.expr(f.init) : this.zero(f.type)};`);
      }
      if (c.ctor) {
        w.blank();
        const params = c.ctor.params.map((p) => this.declParam(p)).join(', ');
        w.braced(`public ${this.typeName(c.name)}(${params})`, () => this.emitBody(w, c.ctor!.body));
      }
      for (const m of c.methods) this.method(w, m, !!m.isStatic);
    });
  }

  private interfaceDecl(w: CodeWriter, i: IrInterface): void {
    w.blank();
    if (i.doc?.trim()) w.line(`/** ${wrapText(i.doc.trim()).join(' ')} */`);
    const ext = i.extends?.length ? ` extends ${i.extends.map((t) => this.type(t)).join(', ')}` : '';
    w.braced(`public interface ${this.typeName(i.name)}${ext}`, () => {
      for (const m of i.methods) {
        const params = m.params.map((p) => this.declParam(p)).join(', ');
        if (m.doc) w.line(`/** ${m.doc} */`);
        w.line(`${this.type(m.returns)} ${this.name(m.name)}(${params}) throws Exception;`);
      }
    });
  }

  private enumDecl(w: CodeWriter, e: IrEnum): void {
    w.blank();
    if (e.doc?.trim()) w.line(`/** ${e.doc.trim()} */`);
    w.braced(`public enum ${this.typeName(e.name)}`, () => {
      w.line(e.variants.map((v) => screamingSnake(v.name)).join(', ') + (e.variants.length ? ';' : ''));
    });
  }

  // -- expression specialisation --------------------------------------------

  protected override memberName(name: string, e: IrExpr): string {
    if (e.k === 'member' && e.target.k === 'symbol' && e.target.type.kind === 'named') return screamingSnake(name);
    return this.name(name);
  }

  protected override newExpr(e: Extract<IrExpr, { k: 'new' }>): string {
    return `new ${this.resolvedType(e.className)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
  }

  protected override arrayLit(e: Extract<IrExpr, { k: 'array' }>): string {
    this.need('java.util.ArrayList');
    this.need('java.util.Arrays');
    if (!e.items.length) return 'new ArrayList<>()';
    return `new ArrayList<>(Arrays.asList(${e.items.map((i) => this.expr(i)).join(', ')}))`;
  }

  protected override mapLit(e: Extract<IrExpr, { k: 'mapLit' }>): string {
    this.need('java.util.LinkedHashMap');
    if (!e.entries.length) return 'new LinkedHashMap<>()';
    this.usesRuntime = true;
    const pairs = e.entries.map((en) => `${this.expr(en.key)}, ${this.expr(en.value)}`).join(', ');
    return `${RUNTIME_CLASS}.mapOf(${pairs})`;
  }

  protected override tupleLit(e: Extract<IrExpr, { k: 'tupleLit' }>): string {
    this.need('java.util.List');
    return `List.of(${e.items.map((i) => this.expr(i)).join(', ')})`;
  }

  protected override cast(e: Extract<IrExpr, { k: 'cast' }>): string {
    const inner = this.expr(e.expr, 13);
    if (e.to.kind === 'primitive') {
      switch (e.to.name) {
        case 'string':
          return `String.valueOf(${inner})`;
        case 'i32':
          return `(int) (${inner})`;
        case 'i64':
          return `(long) (${inner})`;
        case 'f32':
          return `(float) (${inner})`;
        case 'f64':
          return `(double) (${inner})`;
        case 'bool':
          return `Boolean.parseBoolean(String.valueOf(${inner}))`;
      }
    }
    return `(${this.type(e.to)}) ${inner}`;
  }

  protected override awaitExpr(e: Extract<IrExpr, { k: 'await' }>): string {
    return `${this.expr(e.expr, 17)}.join()`;
  }

  protected override selfKeyword(): string {
    return 'this';
  }

  override builtin(e: Extract<IrExpr, { k: 'builtin' }>): string {
    const a = e.args.map((x) => this.expr(x, 17));
    const R = () => this.runtime();

    switch (e.op) {
      case 'print':
        return `System.out.println(${a.length ? a.map((x) => `String.valueOf(${x})`).join(' + " " + ') : '""'})`;
      case 'print_err':
        return `System.err.println(${a.length ? a.map((x) => `String.valueOf(${x})`).join(' + " " + ') : '""'})`;
      case 'read_line':
        return `${R()}.readLine()`;

      case 'to_string':
        return `String.valueOf(${a[0]})`;
      case 'to_int':
        return `(long) ${R()}.toDouble(${a[0]})`;
      case 'to_float':
        return `${R()}.toDouble(${a[0]})`;
      case 'parse_int':
        return `${R()}.parseIntOrNull(${a[0]})`;
      case 'parse_float':
        return `${R()}.parseFloatOrNull(${a[0]})`;

      case 'len':
        return `${R()}.lengthOf(${a[0]})`;
      case 'is_empty':
        return `${R()}.lengthOf(${a[0]}) == 0`;

      case 'str_concat':
        return `${a[0]} + ${a[1]}`;
      case 'str_upper':
        return `${a[0]}.toUpperCase()`;
      case 'str_lower':
        return `${a[0]}.toLowerCase()`;
      case 'str_trim':
        return `${a[0]}.strip()`;
      case 'str_split':
        return `${R()}.split(${a[0]}, ${a[1]})`;
      case 'str_join':
        return `String.join(${a[1]}, ${a[0]})`;
      case 'str_replace':
        return `${a[0]}.replace(${a[1]}, ${a[2]})`;
      case 'str_contains':
        return `${a[0]}.contains(${a[1]})`;
      case 'str_starts_with':
        return `${a[0]}.startsWith(${a[1]})`;
      case 'str_ends_with':
        return `${a[0]}.endsWith(${a[1]})`;
      case 'str_index_of':
        return `${a[0]}.indexOf(${a[1]})`;
      case 'str_substring':
        return `${R()}.substring(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'str_char_at':
        return `String.valueOf(${a[0]}.charAt((int) ${a[1]}))`;
      case 'str_repeat':
        return `${a[0]}.repeat((int) ${a[1]})`;
      case 'str_pad_left':
        return `${R()}.padLeft(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'format':
        return `${R()}.format(${a.join(', ')})`;

      case 'list_new':
        this.need('java.util.ArrayList');
        return 'new ArrayList<>()';
      case 'list_get':
        return `${a[0]}.get((int) ${a[1]})`;
      case 'list_set':
        return `${a[0]}.set((int) ${a[1]}, ${a[2]})`;
      case 'list_push':
        return `${a[0]}.add(${a[1]})`;
      case 'list_pop':
        return `${R()}.pop(${a[0]})`;
      case 'list_insert':
        return `${a[0]}.add((int) ${a[1]}, ${a[2]})`;
      case 'list_remove_at':
        return `${a[0]}.remove((int) ${a[1]})`;
      case 'list_contains':
        return `${a[0]}.contains(${a[1]})`;
      case 'list_index_of':
        return `${a[0]}.indexOf(${a[1]})`;
      case 'list_slice':
        return `${R()}.slice(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'list_concat':
        return `${R()}.concat(${a[0]}, ${a[1]})`;
      case 'list_reverse':
        return `${R()}.reversed(${a[0]})`;
      case 'list_sort':
        return `${R()}.sorted(${a[0]})`;
      case 'list_sort_by':
        return `${R()}.sortedBy(${a[0]}, ${a[1]})`;
      case 'list_map':
        return `${a[0]}.stream().map(${a[1]}).toList()`;
      case 'list_filter':
        return `${a[0]}.stream().filter(${a[1]}).toList()`;
      case 'list_reduce':
        return `${R()}.reduce(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'list_any':
        return `${a[0]}.stream().anyMatch(${a[1]})`;
      case 'list_all':
        return `${a[0]}.stream().allMatch(${a[1]})`;
      case 'list_find':
        return `${a[0]}.stream().filter(${a[1]}).findFirst().orElse(null)`;
      case 'list_sum':
        return `${R()}.sum(${a[0]})`;
      case 'list_min':
        return `${R()}.min(${a[0]})`;
      case 'list_max':
        return `${R()}.max(${a[0]})`;
      case 'list_unique':
        return `${R()}.unique(${a[0]})`;
      case 'list_range':
        return `${R()}.range(${a[0]}, ${a[1]})`;

      case 'map_new':
        this.need('java.util.LinkedHashMap');
        return 'new LinkedHashMap<>()';
      case 'map_get':
        return `${a[0]}.get(${a[1]})`;
      case 'map_get_or':
        return `${a[0]}.getOrDefault(${a[1]}, ${a[2]})`;
      case 'map_set':
        return `${a[0]}.put(${a[1]}, ${a[2]})`;
      case 'map_has':
        return `${a[0]}.containsKey(${a[1]})`;
      case 'map_remove':
        return `${a[0]}.remove(${a[1]})`;
      case 'map_keys':
        this.need('java.util.ArrayList');
        return `new ArrayList<>(${a[0]}.keySet())`;
      case 'map_values':
        this.need('java.util.ArrayList');
        return `new ArrayList<>(${a[0]}.values())`;

      case 'set_new':
        this.need('java.util.LinkedHashSet');
        return 'new LinkedHashSet<>()';
      case 'set_add':
        return `${a[0]}.add(${a[1]})`;
      case 'set_has':
        return `${a[0]}.contains(${a[1]})`;
      case 'set_remove':
        return `${a[0]}.remove(${a[1]})`;
      case 'set_to_list':
        this.need('java.util.ArrayList');
        return `new ArrayList<>(${a[0]})`;

      case 'math_abs':
        return `Math.abs(${a[0]})`;
      case 'math_floor':
        return `(long) Math.floor(${a[0]})`;
      case 'math_ceil':
        return `(long) Math.ceil(${a[0]})`;
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
        return `${a[0]} / ${a[1]}`;
      case 'math_pi':
        return 'Math.PI';

      case 'json_parse':
        return `${R()}.jsonParse(${a[0]})`;
      case 'json_stringify':
        return `${R()}.jsonStringify(${a[0]}, ${a[1]})`;
      case 'json_get':
        return `${R()}.jsonGet(${a[0]}, ${a[1]})`;
      case 'json_as_string':
        return `String.valueOf(${a[0]})`;
      case 'json_as_number':
        return `${R()}.toDouble(${a[0]})`;
      case 'json_as_list':
        return `${R()}.jsonAsList(${a[0]})`;

      case 'file_read_text':
        return `${R()}.readText(${a[0]})`;
      case 'file_write_text':
        return `${R()}.writeText(${a[0]}, ${a[1]})`;
      case 'file_append_text':
        return `${R()}.appendText(${a[0]}, ${a[1]})`;
      case 'file_exists':
        return `${R()}.fileExists(${a[0]})`;
      case 'file_delete':
        return `${R()}.deleteFile(${a[0]})`;
      case 'dir_list':
        return `${R()}.listDir(${a[0]})`;
      case 'dir_create':
        return `${R()}.createDir(${a[0]})`;
      case 'path_join':
        return `${R()}.pathJoin(${a[0]}, ${a[1]})`;

      case 'http_request':
        return `${R()}.httpRequest(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]})`;

      case 'db_open':
        return `${R()}.dbOpen(${a[0]})`;
      case 'db_execute':
        return `${R()}.dbExecute(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'db_query':
        return `${R()}.dbQuery(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'db_close':
        return `${R()}.dbClose(${a[0]})`;

      case 'env_get':
        return `System.getenv(${a[0]})`;
      case 'args_get':
        return `${R()}.args()`;
      case 'time_now_ms':
        return 'System.currentTimeMillis()';
      case 'time_sleep_ms':
        return `${R()}.sleep(${a[0]})`;
      case 'random_float':
        return 'Math.random()';
      case 'random_int':
        return `(${a[0]} + (long) (Math.random() * (${a[1]} - ${a[0]})))`;

      case 'error_new':
        return `new Exception(${a[0]})`;
      case 'error_message':
        return `String.valueOf(${a[0]}.getMessage())`;
      case 'assert':
        return `${R()}.check(${a[0]}, ${a[1]})`;
      case 'assert_eq':
        return `${R()}.checkEqual(${a[0]}, ${a[1]}, ${a[2]})`;

      default:
        throw new BackendGenError(`The Java backend does not implement the "${e.op}" operation.`, {
          code: 'codegen/unsupported-builtin',
          origin: e.origin,
        });
    }
  }
}

function endsWithReturn(body: IrStmt[]): boolean {
  const last = body[body.length - 1];
  return !!last && (last.k === 'return' || last.k === 'throw');
}

export function classNameFor(file: ProjectFile): string {
  return classNameForPath(file.path);
}

function classNameForPath(path: string): string {
  const base = path.split('/').pop() ?? 'Module';
  return pascal(base.replace(/\.[^.]+$/, ''));
}

function rootPackage(project: Project): string {
  return (project.namespace ?? `com.${project.name}`)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '') || 'app';
}

function packageFor(file: ProjectFile, project: Project): string {
  return packageOfPath(file.path, project);
}

function packageOfPath(path: string, project: Project): string {
  const root = rootPackage(project);
  const rel = path
    .replace(/^src\/main\/java\//, '')
    .replace(/^src\/test\/java\//, '')
    .replace(/^src\//, '')
    .split('/');
  rel.pop();
  const sub = rel.filter(Boolean).map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''));

  // The path under src/main/java usually already starts with the root package
  // (that is the Maven convention), so prepending it again would produce
  // `app.app`. Drop the overlap rather than duplicating it.
  const rootParts = root.split('.').filter(Boolean);
  let overlap = 0;
  while (overlap < rootParts.length && overlap < sub.length && rootParts[overlap] === sub[overlap]) overlap++;
  return [...rootParts, ...sub.slice(overlap)].filter(Boolean).join('.');
}

// ---------------------------------------------------------------------------

export const javaBackend: LanguageBackend = {
  id: 'java',
  name: 'Java',
  maturity: 'full',
  extensions: ['.java'],
  features: defaultFeatures({ compiled: true }),
  lineComment: '//',
  blockComment: { open: '/*', close: '*/' },
  indent: '    ',
  keywords: KEYWORDS,

  packageManager: {
    id: 'maven',
    name: 'Maven',
    installAll: { label: 'mvn dependency:resolve', command: 'mvn', args: ['-q', 'dependency:resolve'] },
    installOne: null,
    manifestFile: 'pom.xml',
  },

  toolchain: [
    { command: 'javac', versionArgs: ['--version'], installHint: 'Install a JDK 17 or newer (Temurin, Oracle, or your package manager).' },
    { command: 'java', versionArgs: ['-version'], installHint: 'A JRE comes with the JDK.' },
  ],

  entry: {
    // The package directory is part of the path on purpose. `pathFor` keeps any
    // path under src/main/java verbatim and derives the package from the
    // directory, so a file placed directly there lands in the default package
    // while the emitter still references the project package — and javac then
    // reports "cannot find symbol" on generated code that looks correct.
    file: 'src/main/java/app/Main.java',
    symbol: 'main',
    description: 'A class with a static main(String[]) method, in package app.',
  },

  sourceRoot: () => 'src/main/java',
  testRoot: () => 'src/test/java',

  pathFor(file, project) {
    if (file.path.startsWith('src/main/java/') || file.path.startsWith('src/test/java/')) return file.path;
    const pkgPath = rootPackage(project).replace(/\./g, '/');
    const rel = file.path.replace(/^src\//, '');
    return `src/main/java/${pkgPath}/${rel}`;
  },

  mapType(type, project) {
    return new JavaEmitter(scratchContext(project, 'java')).type(type);
  },

  importFor(_from, to, symbols, project) {
    const pkg = packageOfPath(to.path, project);
    const cls = classNameForPath(to.path);
    return symbols.length ? `import ${pkg}.${cls};` : `import ${pkg}.*;`;
  },

  crossFileReference(symbol, to) {
    // Module-level functions are static members of the file's class.
    return /^[A-Z]/.test(symbol) ? symbol : `${classNameForPath(to.path)}.${symbol}`;
  },

  emitModule(ctx) {
    return new JavaEmitter(ctx).emit();
  },

  emitProjectFiles(project, program) {
    const deps = project.dependencies.filter((d) => d.language === 'java');
    const root = rootPackage(project);
    const files: GeneratedFile[] = [
      {
        path: 'pom.xml',
        role: 'manifest',
        content: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<project xmlns="http://maven.apache.org/POM/4.0.0"',
          '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
          '         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">',
          '  <modelVersion>4.0.0</modelVersion>',
          `  <groupId>${root}</groupId>`,
          `  <artifactId>${project.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}</artifactId>`,
          `  <version>${project.version}</version>`,
          '  <properties>',
          '    <maven.compiler.release>17</maven.compiler.release>',
          '    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>',
          '  </properties>',
          '  <dependencies>',
          ...deps.flatMap((d) => {
            const [groupId, artifactId] = d.name.includes(':') ? d.name.split(':') : [d.name, d.name];
            return [
              '    <dependency>',
              `      <groupId>${groupId}</groupId>`,
              `      <artifactId>${artifactId}</artifactId>`,
              `      <version>${d.version === '*' ? 'LATEST' : d.version}</version>`,
              '    </dependency>',
            ];
          }),
          '  </dependencies>',
          '</project>',
          '',
        ].join('\n'),
      },
    ];

    // Always emitted, not only when a builtin needs it. The JVM entry point
    // unconditionally calls `McRuntime.setArgs(args)`, so a program using no
    // builtins at all — a blank project, the first challenge — still imports
    // the class, and gating on `usedBuiltins` left that import dangling.
    void usedBuiltins(program);
    files.push({
      path: `src/main/java/${root.replace(/\./g, '/')}/${RUNTIME_CLASS}.java`,
      role: 'source',
      content: javaRuntime(root),
    });

    // javac takes the file list from an argfile rather than the command line.
    // A project with many classes would otherwise overrun the Windows command
    // length limit, and a wildcard would miss the package subdirectories.
    // Written here so it is regenerated with the sources it lists — a stale
    // list is a build that compiles files that no longer exist.
    const sources = [
      ...project.files
        .filter((f) => f.language === 'java' && (f.role === 'source' || f.role === 'entry'))
        .map((f) => javaBackend.pathFor(f, project)),
      ...files.filter((f) => f.role === 'source').map((f) => f.path),
    ];
    files.push({
      path: 'sources.txt',
      role: 'build',
      content: `${[...new Set(sources)].sort().join('\n')}\n`,
    });

    return files;
  },

  buildPlan(project, mode: BuildMode): BuildPlan {
    // javac directly rather than through Maven: it is the toolchain that is
    // actually guaranteed to be present with a JDK.
    const debugFlags = mode === 'debug' ? ['-g'] : [];
    return {
      steps: [
        {
          label: 'Compile with javac',
          command: 'javac',
          // `--release` pins the bytecode level, so a newer JDK still produces
          // classes an older JRE on the same machine can load.
          args: [...debugFlags, '--release', '17', '-encoding', 'UTF-8', '-d', 'build/classes', '@sources.txt'],
        },
      ],
      artifact: 'build/classes',
      note: 'Sources are listed in sources.txt, regenerated with the project.',
    };
  },

  runPlan(project): RunPlan {
    const entry = project.files.find((f) => f.role === 'entry' && f.language === 'java');
    const root = rootPackage(project);
    const cls = entry ? `${packageOfPath(entry.path, project)}.${classNameForPath(entry.path)}` : `${root}.Main`;
    return { command: { label: 'Run', command: 'java', args: ['-cp', 'build/classes', cls] } };
  },

  testPlan(): BuildPlan | null {
    return null;
  },

  parseDiagnostics(output): Diagnostic[] {
    const out: Diagnostic[] = [];
    // `src/main/java/app/Main.java:12: error: cannot find symbol`
    const re = /^(.+\.java):(\d+):\s*(error|warning):\s*(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output))) {
      out.push({
        severity: m[3] === 'error' ? 'error' : 'warning',
        stage: 'build',
        code: `javac/${m[3]}`,
        message: m[4].trim(),
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]),
        raw: m[0],
      });
    }
    // Runtime stack frames.
    const stack = /at ([\w.$]+)\(([\w]+\.java):(\d+)\)/g;
    const first = /^(?:Exception in thread ".*" )?([\w.]*(?:Exception|Error)):?\s*(.*)$/m.exec(output);
    if (first) {
      const frame = stack.exec(output);
      out.push({
        severity: 'error',
        stage: 'runtime',
        code: 'java/exception',
        message: `${first[1]}${first[2] ? `: ${first[2]}` : ''}`,
        file: frame?.[2],
        line: frame ? Number(frame[3]) : undefined,
        raw: first[0],
      });
    }
    return out;
  },
};

/** Minimal context for standalone type mapping. */
export function scratchContext(project: Project, language: string): EmitContext {
  return {
    project,
    program: { name: '', language, modules: [], dependencies: [] },
    module: { id: '', name: '', path: '', imports: [], decls: [] },
    file: { id: '', path: '', language, kind: 'generated', role: 'source', exports: [], imports: [] },
    diag: { items: [], warn() {}, error() {} } as never,
    resolveSymbol: () => undefined,
    dependencies: [],
  };
}

function javaRuntime(pkg: string): string {
  return `package ${pkg};

// Runtime helpers used by generated Master Code programs.
//
// Only operations without a concise standard-library form live here.
// This file is generated. Edit the graph, not this.

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.Function;

public final class ${RUNTIME_CLASS} {
    private ${RUNTIME_CLASS}() {
    }

    private static String[] programArgs = new String[0];

    /** Outcome of an HTTP request. Transport failures arrive as status 0. */
    public static final class HttpResponse {
        public int status;
        public String body;
        public Map<String, String> headers;

        public HttpResponse(int status, String body, Map<String, String> headers) {
            this.status = status;
            this.body = body;
            this.headers = headers;
        }
    }

    public static void setArgs(String[] args) {
        programArgs = args == null ? new String[0] : args;
    }

    public static List<String> args() {
        return new ArrayList<>(Arrays.asList(programArgs));
    }

    public static String readLine() throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line = reader.readLine();
        return line == null ? "" : line;
    }

    public static long lengthOf(Object value) {
        if (value == null) {
            return 0;
        }
        if (value instanceof CharSequence text) {
            return text.length();
        }
        if (value instanceof Collection<?> items) {
            return items.size();
        }
        if (value instanceof Map<?, ?> map) {
            return map.size();
        }
        return 0;
    }

    public static double toDouble(Object value) {
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        try {
            return Double.parseDouble(String.valueOf(value));
        } catch (NumberFormatException ignored) {
            return 0.0;
        }
    }

    public static Long parseIntOrNull(String text) {
        try {
            return Long.parseLong(text.strip());
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    public static Double parseFloatOrNull(String text) {
        try {
            return Double.parseDouble(text.strip());
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    public static String format(String template, Object... args) {
        StringBuilder out = new StringBuilder();
        int argIndex = 0;
        for (int i = 0; i < template.length(); i++) {
            if (i + 1 < template.length() && template.charAt(i) == '{' && template.charAt(i + 1) == '}') {
                out.append(argIndex < args.length ? String.valueOf(args[argIndex++]) : "{}");
                i++;
            } else {
                out.append(template.charAt(i));
            }
        }
        return out.toString();
    }

    public static List<String> split(String text, String separator) {
        return new ArrayList<>(Arrays.asList(text.split(java.util.regex.Pattern.quote(separator), -1)));
    }

    public static String substring(String text, long start, long end) {
        int from = (int) Math.max(0, Math.min(text.length(), start));
        int to = (int) Math.max(from, Math.min(text.length(), end));
        return text.substring(from, to);
    }

    public static String padLeft(String text, long width, String fill) {
        StringBuilder out = new StringBuilder();
        while (out.length() + text.length() < width && !fill.isEmpty()) {
            out.append(fill);
        }
        return out + text;
    }

    public static <T> T pop(List<T> list) {
        return list.isEmpty() ? null : list.remove(list.size() - 1);
    }

    public static <T> List<T> slice(List<T> list, long start, long end) {
        int from = (int) Math.max(0, Math.min(list.size(), start));
        int to = (int) Math.max(from, Math.min(list.size(), end));
        return new ArrayList<>(list.subList(from, to));
    }

    public static <T> List<T> concat(List<T> a, List<T> b) {
        List<T> out = new ArrayList<>(a);
        out.addAll(b);
        return out;
    }

    public static <T> List<T> reversed(List<T> list) {
        List<T> out = new ArrayList<>(list);
        java.util.Collections.reverse(out);
        return out;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    public static <T> List<T> sorted(List<T> list) {
        List<T> out = new ArrayList<>(list);
        out.sort((a, b) -> {
            if (a instanceof Comparable && b instanceof Comparable) {
                return ((Comparable) a).compareTo(b);
            }
            return String.valueOf(a).compareTo(String.valueOf(b));
        });
        return out;
    }

    public static <T> List<T> sortedBy(List<T> list, Function<T, Double> key) {
        List<T> out = new ArrayList<>(list);
        out.sort(Comparator.comparingDouble(key::apply));
        return out;
    }

    public static <T, U> U reduce(List<T> list, BiFunction<U, T, U> combine, U initial) {
        U accumulator = initial;
        for (T item : list) {
            accumulator = combine.apply(accumulator, item);
        }
        return accumulator;
    }

    public static double sum(List<? extends Number> list) {
        double total = 0;
        for (Number n : list) {
            total += n.doubleValue();
        }
        return total;
    }

    public static Double min(List<? extends Number> list) {
        Double best = null;
        for (Number n : list) {
            if (best == null || n.doubleValue() < best) {
                best = n.doubleValue();
            }
        }
        return best;
    }

    public static Double max(List<? extends Number> list) {
        Double best = null;
        for (Number n : list) {
            if (best == null || n.doubleValue() > best) {
                best = n.doubleValue();
            }
        }
        return best;
    }

    public static <T> List<T> unique(List<T> list) {
        return new ArrayList<>(new LinkedHashSet<>(list));
    }

    public static List<Long> range(long start, long end) {
        List<Long> out = new ArrayList<>();
        for (long i = start; i < end; i++) {
            out.add(i);
        }
        return out;
    }

    public static Map<Object, Object> mapOf(Object... pairs) {
        Map<Object, Object> out = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            out.put(pairs[i], pairs[i + 1]);
        }
        return out;
    }

    public static String readText(String path) throws IOException {
        return Files.readString(Path.of(path), StandardCharsets.UTF_8);
    }

    public static void writeText(String path, String text) throws IOException {
        Files.writeString(Path.of(path), text, StandardCharsets.UTF_8);
    }

    public static void appendText(String path, String text) throws IOException {
        Files.writeString(Path.of(path), text, StandardCharsets.UTF_8,
                java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
    }

    public static boolean fileExists(String path) {
        return Files.exists(Path.of(path));
    }

    public static void deleteFile(String path) throws IOException {
        Files.deleteIfExists(Path.of(path));
    }

    public static List<String> listDir(String path) throws IOException {
        try (var stream = Files.list(Path.of(path))) {
            return stream.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    public static void createDir(String path) throws IOException {
        Files.createDirectories(Path.of(path));
    }

    public static String pathJoin(String a, String b) {
        return Path.of(a, b).toString();
    }

    public static void sleep(long millis) throws InterruptedException {
        Thread.sleep(millis);
    }

    public static void check(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError("assertion failed: " + message);
        }
    }

    public static void checkEqual(Object actual, Object expected, String message) {
        if (!java.util.Objects.equals(actual, expected)) {
            throw new AssertionError(message + ": expected " + expected + ", got " + actual);
        }
    }

    public static HttpResponse httpRequest(String method, String url, Map<String, String> headers, String body) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url));
            if (headers != null) {
                headers.forEach(builder::header);
            }
            builder.method(method.toUpperCase(java.util.Locale.ROOT),
                    body == null || body.isEmpty()
                            ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofString(body));
            var response = HttpClient.newHttpClient().send(builder.build(), BodyHandlers.ofString());
            Map<String, String> out = new LinkedHashMap<>();
            response.headers().map().forEach((k, v) -> out.put(k, String.join(", ", v)));
            return new HttpResponse(response.statusCode(), response.body(), out);
        } catch (Exception error) {
            return new HttpResponse(0, String.valueOf(error), new LinkedHashMap<>());
        }
    }

    /**
     * SQLite access needs the org.xerial:sqlite-jdbc driver on the classpath.
     * It is listed in the manifest, but Master Code never downloads it for you.
     */
    public static Connection dbOpen(String path) throws Exception {
        return DriverManager.getConnection("jdbc:sqlite:" + path);
    }

    public static long dbExecute(Connection connection, String sql, List<Object> params) throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            bind(statement, params);
            return statement.executeUpdate();
        }
    }

    public static List<Map<String, Object>> dbQuery(Connection connection, String sql, List<Object> params)
            throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            bind(statement, params);
            try (ResultSet rows = statement.executeQuery()) {
                ResultSetMetaData meta = rows.getMetaData();
                List<Map<String, Object>> out = new ArrayList<>();
                while (rows.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int i = 1; i <= meta.getColumnCount(); i++) {
                        row.put(meta.getColumnLabel(i), rows.getObject(i));
                    }
                    out.add(row);
                }
                return out;
            }
        }
    }

    public static void dbClose(Connection connection) throws Exception {
        connection.close();
    }

    private static void bind(PreparedStatement statement, List<Object> params) throws Exception {
        if (params == null) {
            return;
        }
        for (int i = 0; i < params.size(); i++) {
            statement.setObject(i + 1, params.get(i));
        }
    }

    /**
     * JSON support is deliberately minimal: parsing returns the raw text so the
     * program still compiles without a third-party library. Add Jackson or Gson
     * from the library catalogue and use a Custom Code node for real parsing.
     */
    public static Object jsonParse(String text) {
        return text;
    }

    public static String jsonStringify(Object value, boolean pretty) {
        return String.valueOf(value);
    }

    public static Object jsonGet(Object value, String field) {
        if (value instanceof Map<?, ?> map) {
            return map.get(field);
        }
        return null;
    }

    public static List<Object> jsonAsList(Object value) {
        if (value instanceof Collection<?> items) {
            return new ArrayList<>(items);
        }
        return new ArrayList<>();
    }
}
`;
}

export { JavaEmitter };
