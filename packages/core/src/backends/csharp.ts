/**
 * C# backend.
 *
 * Modules map cleanly: a file becomes a namespace holding a static class for
 * the module-level functions plus whatever types the module declares. Nullable
 * reference types are enabled in the generated project, and `Option<T>` maps to
 * `T?`, so the compiler carries the same information the graph does.
 */

import type { BuildMode, BuildPlan, EmitContext, GeneratedFile, LanguageBackend, RunPlan } from './backend.ts';
import { BackendGenError, defaultFeatures, generatedHeader } from './backend.ts';
import { CLikeEmitter, javaLikeDialect } from './clike.ts';
import { CodeWriter, avoidKeyword, camel, pascal, screamingSnake, wrapText } from './emitter.ts';
import { scratchContext } from './java.ts';
import type { IrClass, IrDecl, IrEnum, IrExpr, IrFunction, IrInterface, IrParam, IrStmt } from '../ir/ir.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project, ProjectFile } from '../model/project.ts';
import type { TypeRef } from '../types/types.ts';

const KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class',
  'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event',
  'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if',
  'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new',
  'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public',
  'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static',
  'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong',
  'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
]);

const RUNTIME = 'McRuntime';

class CSharpEmitter extends CLikeEmitter {
  private readonly usings = new Set(['System', 'System.Collections.Generic', 'System.Linq']);

  constructor(ctx: EmitContext) {
    super(
      ctx,
      javaLikeDialect({
        letKeyword: () => 'var',
        foreach: (v, t, it, index) =>
          index ? `foreach (var (${v}, ${index}) in ${it}.Select((x, i) => (x, i)))` : `foreach (${t} ${v} in ${it})`,
        power: (b, e) => `Math.Pow(${b}, ${e})`,
      }),
      KEYWORDS,
      '    ',
    );
  }

  protected override get langId(): string {
    return 'csharp';
  }

  override name(raw: string): string {
    return avoidKeyword(camel(raw), KEYWORDS);
  }

  override typeName(raw: string): string {
    return avoidKeyword(pascal(raw), KEYWORDS);
  }

  private methodName(raw: string): string {
    return avoidKeyword(pascal(raw), KEYWORDS);
  }

  emit(): string {
    const { module, file, project } = this.ctx;
    const body = new CodeWriter('    ');
    const others = module.decls.filter((d) => d.k !== 'function');
    // A graph entry called `main` would map to `Main()`, which C# counts as a
    // second entry point alongside `Main(string[])`. Rename it.
    const functions = module.decls
      .filter((d): d is IrFunction => d.k === 'function')
      .map((f) => (f.isEntry && this.methodName(f.name) === 'Main' ? { ...f, name: 'run' } : f));

    for (const d of others) this.decl(body, d);
    const entry = functions.find((f) => f.isEntry);
    if (functions.length) {
      body.blank();
      body.line(`/// <summary>Module-level operations from ${file.path}.</summary>`);
      body.braced(`public static class ${moduleClass(file)}`, () => {
        for (const f of functions) this.method(body, f, true);
        // Main lives on the module class rather than a separate Program type:
        // a file already named Program.cs would otherwise declare it twice.
        if (entry) {
          body.blank();
          body.line('/// <summary>Process entry point.</summary>');
          body.braced('public static void Main(string[] args)', () => {
            body.line(`${RUNTIME}.SetArgs(args);`);
            body.line(`${this.methodName(entry.name)}();`);
          });
        }
      });
    }

    const head = new CodeWriter('    ');
    for (const l of generatedHeader(csharpBackend, file, project)) head.line(l);
    head.blank();
    head.line('#nullable enable');
    head.blank();
    for (const u of [...this.usings].sort()) head.line(`using ${u};`);
    for (const imp of module.imports) {
      if (imp.source !== 'file') continue;
      const target = this.ctx.program.modules.find((m) => m.id === imp.target);
      if (target) head.line(`using ${namespaceOfPath(target.path, project)};`);
    }
    head.blank();
    head.line(`namespace ${namespaceOfPath(file.path, project)};`);
    head.blank();
    if (module.doc) for (const l of wrapText(module.doc)) head.line(`// ${l}`);
    head.block(body.toString().replace(/\n$/, ''));
    return head.toString();
  }

  private using(ns: string): void {
    this.usings.add(ns);
  }

  override type(t: TypeRef): string {
    switch (t.kind) {
      case 'void':
      case 'exec':
        return 'void';
      case 'any':
        return 'object?';
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return 'bool';
          case 'i32':
            return 'int';
          case 'i64':
            return 'long';
          case 'f32':
            return 'float';
          case 'f64':
            return 'double';
          case 'string':
            return 'string';
          case 'char':
            return 'char';
          case 'bytes':
            return 'byte[]';
        }
        return 'object';
      case 'list':
        return `List<${this.type(t.item)}>`;
      case 'set':
        return `HashSet<${this.type(t.item)}>`;
      case 'map':
        return `Dictionary<${this.type(t.key)}, ${this.type(t.value)}>`;
      case 'option':
        return `${this.type(t.inner)}?`;
      case 'tuple':
        return `(${t.items.map((i) => this.type(i)).join(', ')})`;
      case 'future':
        this.using('System.Threading.Tasks');
        return `Task<${this.type(t.inner)}>`;
      case 'result':
        return this.type(t.ok);
      case 'function':
        return t.returns.kind === 'void'
          ? t.params.length
            ? `Action<${t.params.map((p) => this.type(p)).join(', ')}>`
            : 'Action'
          : `Func<${[...t.params.map((p) => this.type(p)), this.type(t.returns)].join(', ')}>`;
      case 'named':
        switch (t.name) {
          case 'Error':
            return 'Exception';
          case 'Json':
            this.using('System.Text.Json');
            return 'JsonElement';
          case 'HttpResponse':
            return `${RUNTIME}.HttpResult`;
          case 'DbConnection':
            return `${RUNTIME}.Db`;
          case 'Element':
            throw new BackendGenError('DOM types have no C# equivalent.', { code: 'codegen/dom-in-csharp' });
          default:
            return this.resolvedType(t.name);
        }
      case 'var':
        return 'object?';
    }
  }

  override zero(t: TypeRef): string {
    switch (t.kind) {
      case 'primitive':
        if (t.name === 'bool') return 'false';
        if (t.name === 'string') return '""';
        if (t.name === 'char') return "' '";
        if (t.name === 'f32' || t.name === 'f64') return '0.0';
        if (t.name === 'bytes') return 'Array.Empty<byte>()';
        return '0';
      case 'list':
      case 'set':
      case 'map':
        return `new ${this.type(t)}()`;
      default:
        return 'null';
    }
  }

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
        if (d.doc) w.line(`/// <summary>${d.doc}</summary>`);
        w.braced(`public static class ${pascal(d.name)}Holder`, () => {
          w.line(
            `public static ${d.constant ? 'readonly ' : ''}${this.type(d.type)} Value = ` +
              `${d.init ? this.expr(d.init) : this.zero(d.type)};`,
          );
        });
        break;
      case 'typeAlias':
        w.line(`// using ${this.typeName(d.name)} = ${this.type(d.target)};`);
        break;
      case 'rawDecl':
        if (d.lang !== 'csharp' && d.lang !== 'any') {
          throw new BackendGenError(`Raw ${d.lang} block cannot be emitted into a C# file.`, {
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

  private method(w: CodeWriter, f: IrFunction, isStatic: boolean): void {
    w.blank();
    if (f.doc?.trim()) w.line(`/// <summary>${wrapText(f.doc.trim()).join(' ')}</summary>`);
    const vis = f.visibility === 'private' ? 'private' : 'public';
    const staticKw = isStatic || f.isStatic ? 'static ' : '';
    const asyncKw = f.isAsync ? 'async ' : '';
    const params = f.params.map((p) => this.declParam(p)).join(', ');
    w.braced(`${vis} ${staticKw}${asyncKw}${this.type(f.returns)} ${this.methodName(f.name)}(${params})`, () => {
      this.emitBody(w, f.body);
      if (f.returns.kind !== 'void' && !endsWithReturn(f.body)) w.line(`return ${this.zero(f.returns)};`);
    });
  }

  private declParam(p: IrParam): string {
    const base = `${p.rest ? 'params ' : ''}${this.type(p.type)}${p.rest ? '[]' : ''} ${this.name(p.name)}`;
    return p.default ? `${base} = ${this.expr(p.default)}` : base;
  }

  private classDecl(w: CodeWriter, c: IrClass): void {
    w.blank();
    if (c.doc?.trim()) w.line(`/// <summary>${wrapText(c.doc.trim()).join(' ')}</summary>`);
    const kind = c.shape === 'record' ? 'record' : c.shape === 'struct' ? 'struct' : 'class';
    const bases = [c.extends, ...(c.implements ?? [])].filter(Boolean).map((t) => this.type(t!));
    const abstractKw = c.isAbstract ? 'abstract ' : '';
    w.braced(
      `public ${abstractKw}${kind} ${this.typeName(c.name)}${bases.length ? ` : ${bases.join(', ')}` : ''}`,
      () => {
        for (const f of c.fields) {
          if (f.doc) w.line(`/// <summary>${f.doc}</summary>`);
          const mods = [f.visibility === 'private' ? 'private' : 'public'];
          if (f.isStatic) mods.push('static');
          w.line(
            `${mods.join(' ')} ${this.type(f.type)} ${pascal(f.name)} { get; ${f.readonly ? 'init' : 'set'}; } = ` +
              `${f.init ? this.expr(f.init) : this.zero(f.type)};`,
          );
        }
        if (c.ctor) {
          w.blank();
          const params = c.ctor.params.map((p) => this.declParam(p)).join(', ');
          w.braced(`public ${this.typeName(c.name)}(${params})`, () => this.emitBody(w, c.ctor!.body));
        }
        for (const m of c.methods) this.method(w, m, !!m.isStatic);
      },
    );
  }

  private interfaceDecl(w: CodeWriter, i: IrInterface): void {
    w.blank();
    if (i.doc?.trim()) w.line(`/// <summary>${wrapText(i.doc.trim()).join(' ')}</summary>`);
    const ext = i.extends?.length ? ` : ${i.extends.map((t) => this.type(t)).join(', ')}` : '';
    w.braced(`public interface ${this.typeName(i.name)}${ext}`, () => {
      for (const m of i.methods) {
        w.line(`${this.type(m.returns)} ${this.methodName(m.name)}(${m.params.map((p) => this.declParam(p)).join(', ')});`);
      }
    });
  }

  private enumDecl(w: CodeWriter, e: IrEnum): void {
    w.blank();
    if (e.doc?.trim()) w.line(`/// <summary>${e.doc.trim()}</summary>`);
    w.braced(`public enum ${this.typeName(e.name)}`, () => {
      e.variants.forEach((v) => w.line(`${pascal(v.name)},`));
    });
  }

  protected override memberName(name: string, e: IrExpr): string {
    if (e.k === 'member' && e.target.k === 'symbol' && e.target.type.kind === 'named') return pascal(name);
    return pascal(name);
  }

  protected override exprInner(e: IrExpr): string {
    if (e.k === 'method') {
      return `${this.expr(e.target, 17)}.${this.methodName(e.name)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
    }
    return super.exprInner(e);
  }

  protected override arrayLit(e: Extract<IrExpr, { k: 'array' }>): string {
    const item = e.type.kind === 'list' ? this.type(e.type.item) : 'object?';
    return `new List<${item}> { ${e.items.map((i) => this.expr(i)).join(', ')} }`;
  }

  protected override mapLit(e: Extract<IrExpr, { k: 'mapLit' }>): string {
    const k = e.type.kind === 'map' ? this.type(e.type.key) : 'string';
    const v = e.type.kind === 'map' ? this.type(e.type.value) : 'object?';
    const body = e.entries.map((en) => `{ ${this.expr(en.key)}, ${this.expr(en.value)} }`).join(', ');
    return `new Dictionary<${k}, ${v}> { ${body} }`;
  }

  protected override tupleLit(e: Extract<IrExpr, { k: 'tupleLit' }>): string {
    return `(${e.items.map((i) => this.expr(i)).join(', ')})`;
  }

  protected override lambda(e: Extract<IrExpr, { k: 'lambda' }>): string {
    const params = `(${e.params.map((p) => this.name(p.name)).join(', ')})`;
    const asyncKw = e.isAsync ? 'async ' : '';
    if (!Array.isArray(e.body)) return `${asyncKw}${params} => ${this.expr(e.body, 1)}`;
    const inner = new CodeWriter('    ');
    this.emitBody(inner, e.body);
    return `${asyncKw}${params} =>\n{\n${inner.toString().replace(/\n$/, '')}\n}`;
  }

  protected override awaitExpr(e: Extract<IrExpr, { k: 'await' }>): string {
    return `await ${this.expr(e.expr, 14)}`;
  }

  override builtin(e: Extract<IrExpr, { k: 'builtin' }>): string {
    const a = e.args.map((x) => this.expr(x, 17));
    switch (e.op) {
      case 'print':
        return `Console.WriteLine(${a.length ? a.map((x) => `${x}`).join(' + " " + ') : '""'})`;
      case 'print_err':
        return `Console.Error.WriteLine(${a.length ? a.join(' + " " + ') : '""'})`;
      case 'read_line':
        return 'Console.ReadLine() ?? ""';
      case 'to_string':
        return `Convert.ToString(${a[0]}) ?? ""`;
      case 'to_int':
        return `Convert.ToInt64(${a[0]})`;
      case 'to_float':
        return `Convert.ToDouble(${a[0]})`;
      case 'parse_int':
        return `${RUNTIME}.ParseInt(${a[0]})`;
      case 'parse_float':
        return `${RUNTIME}.ParseFloat(${a[0]})`;
      case 'len':
        return `${RUNTIME}.Length(${a[0]})`;
      case 'is_empty':
        return `${RUNTIME}.Length(${a[0]}) == 0`;
      case 'str_concat':
        return `${a[0]} + ${a[1]}`;
      case 'str_upper':
        return `${a[0]}.ToUpperInvariant()`;
      case 'str_lower':
        return `${a[0]}.ToLowerInvariant()`;
      case 'str_trim':
        return `${a[0]}.Trim()`;
      case 'str_split':
        return `${a[0]}.Split(${a[1]}).ToList()`;
      case 'str_join':
        return `string.Join(${a[1]}, ${a[0]})`;
      case 'str_replace':
        return `${a[0]}.Replace(${a[1]}, ${a[2]})`;
      case 'str_contains':
        return `${a[0]}.Contains(${a[1]})`;
      case 'str_starts_with':
        return `${a[0]}.StartsWith(${a[1]})`;
      case 'str_ends_with':
        return `${a[0]}.EndsWith(${a[1]})`;
      case 'str_index_of':
        return `${a[0]}.IndexOf(${a[1]}, StringComparison.Ordinal)`;
      case 'str_substring':
        return `${RUNTIME}.Substring(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'str_char_at':
        return `${a[0]}[(int)${a[1]}].ToString()`;
      case 'str_repeat':
        return `string.Concat(Enumerable.Repeat(${a[0]}, (int)${a[1]}))`;
      case 'str_pad_left':
        return `${a[0]}.PadLeft((int)${a[1]}, ${a[2]}[0])`;
      case 'format':
        return `${RUNTIME}.Format(${a.join(', ')})`;
      case 'list_new':
        return 'new List<object?>()';
      case 'list_get':
        return `${a[0]}[(int)${a[1]}]`;
      case 'list_set':
        return `${a[0]}[(int)${a[1]}] = ${a[2]}`;
      case 'list_push':
        return `${a[0]}.Add(${a[1]})`;
      case 'list_pop':
        return `${RUNTIME}.Pop(${a[0]})`;
      case 'list_insert':
        return `${a[0]}.Insert((int)${a[1]}, ${a[2]})`;
      case 'list_remove_at':
        return `${a[0]}.RemoveAt((int)${a[1]})`;
      case 'list_contains':
        return `${a[0]}.Contains(${a[1]})`;
      case 'list_index_of':
        return `${a[0]}.IndexOf(${a[1]})`;
      case 'list_slice':
        return `${RUNTIME}.Slice(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'list_concat':
        return `${a[0]}.Concat(${a[1]}).ToList()`;
      case 'list_reverse':
        return `Enumerable.Reverse(${a[0]}).ToList()`;
      case 'list_sort':
        return `${a[0]}.OrderBy(x => x).ToList()`;
      case 'list_sort_by':
        return `${a[0]}.OrderBy(${a[1]}).ToList()`;
      case 'list_map':
        return `${a[0]}.Select(${a[1]}).ToList()`;
      case 'list_filter':
        return `${a[0]}.Where(${a[1]}).ToList()`;
      case 'list_reduce':
        return `${a[0]}.Aggregate(${a[2]}, ${a[1]})`;
      case 'list_any':
        return `${a[0]}.Any(${a[1]})`;
      case 'list_all':
        return `${a[0]}.All(${a[1]})`;
      case 'list_find':
        return `${a[0]}.FirstOrDefault(${a[1]})`;
      case 'list_sum':
        return `${a[0]}.Sum()`;
      case 'list_min':
        return `(${a[0]}.Count > 0 ? ${a[0]}.Min() : (double?)null)`;
      case 'list_max':
        return `(${a[0]}.Count > 0 ? ${a[0]}.Max() : (double?)null)`;
      case 'list_unique':
        return `${a[0]}.Distinct().ToList()`;
      case 'list_range':
        return `Enumerable.Range((int)${a[0]}, (int)(${a[1]} - ${a[0]})).Select(x => (long)x).ToList()`;
      case 'map_new':
        return 'new Dictionary<string, object?>()';
      case 'map_get':
        return `${RUNTIME}.MapGet(${a[0]}, ${a[1]})`;
      case 'map_get_or':
        return `(${a[0]}.TryGetValue(${a[1]}, out var _v) ? _v : ${a[2]})`;
      case 'map_set':
        return `${a[0]}[${a[1]}] = ${a[2]}`;
      case 'map_has':
        return `${a[0]}.ContainsKey(${a[1]})`;
      case 'map_remove':
        return `${a[0]}.Remove(${a[1]})`;
      case 'map_keys':
        return `${a[0]}.Keys.ToList()`;
      case 'map_values':
        return `${a[0]}.Values.ToList()`;
      case 'set_new':
        return 'new HashSet<object?>()';
      case 'set_add':
        return `${a[0]}.Add(${a[1]})`;
      case 'set_has':
        return `${a[0]}.Contains(${a[1]})`;
      case 'set_remove':
        return `${a[0]}.Remove(${a[1]})`;
      case 'set_to_list':
        return `${a[0]}.ToList()`;
      case 'math_abs':
        return `Math.Abs(${a[0]})`;
      case 'math_floor':
        return `(long)Math.Floor(${a[0]})`;
      case 'math_ceil':
        return `(long)Math.Ceiling(${a[0]})`;
      case 'math_round':
        return `(long)Math.Round(${a[0]}, MidpointRounding.AwayFromZero)`;
      case 'math_sqrt':
        return `Math.Sqrt(${a[0]})`;
      case 'math_pow':
        return `Math.Pow(${a[0]}, ${a[1]})`;
      case 'math_min':
        return `Math.Min(${a[0]}, ${a[1]})`;
      case 'math_max':
        return `Math.Max(${a[0]}, ${a[1]})`;
      case 'math_log':
        return `Math.Log(${a[0]})`;
      case 'math_exp':
        return `Math.Exp(${a[0]})`;
      case 'math_sin':
        return `Math.Sin(${a[0]})`;
      case 'math_cos':
        return `Math.Cos(${a[0]})`;
      case 'math_tan':
        return `Math.Tan(${a[0]})`;
      case 'math_atan2':
        return `Math.Atan2(${a[0]}, ${a[1]})`;
      case 'math_idiv':
        return `${a[0]} / ${a[1]}`;
      case 'math_pi':
        return 'Math.PI';
      case 'json_parse':
        this.using('System.Text.Json');
        return `JsonDocument.Parse(${a[0]}).RootElement`;
      case 'json_stringify':
        this.using('System.Text.Json');
        return `JsonSerializer.Serialize(${a[0]}, new JsonSerializerOptions { WriteIndented = ${a[1]} })`;
      case 'json_get':
        return `${RUNTIME}.JsonGet(${a[0]}, ${a[1]})`;
      case 'json_as_string':
        return `${RUNTIME}.JsonAsString(${a[0]})`;
      case 'json_as_number':
        return `${RUNTIME}.JsonAsNumber(${a[0]})`;
      case 'json_as_list':
        return `${RUNTIME}.JsonAsList(${a[0]})`;
      case 'file_read_text':
        this.using('System.IO');
        return `File.ReadAllText(${a[0]})`;
      case 'file_write_text':
        this.using('System.IO');
        return `File.WriteAllText(${a[0]}, ${a[1]})`;
      case 'file_append_text':
        this.using('System.IO');
        return `File.AppendAllText(${a[0]}, ${a[1]})`;
      case 'file_exists':
        this.using('System.IO');
        return `File.Exists(${a[0]})`;
      case 'file_delete':
        this.using('System.IO');
        return `File.Delete(${a[0]})`;
      case 'dir_list':
        this.using('System.IO');
        return `Directory.GetFileSystemEntries(${a[0]}).Select(Path.GetFileName).OrderBy(x => x).ToList()`;
      case 'dir_create':
        this.using('System.IO');
        return `Directory.CreateDirectory(${a[0]})`;
      case 'path_join':
        this.using('System.IO');
        return `Path.Combine(${a[0]}, ${a[1]})`;
      case 'http_request':
        return `${RUNTIME}.Http(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]})`;
      case 'db_open':
        return `${RUNTIME}.DbOpen(${a[0]})`;
      case 'db_execute':
        return `${RUNTIME}.DbExecute(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'db_query':
        return `${RUNTIME}.DbQuery(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'db_close':
        return `${RUNTIME}.DbClose(${a[0]})`;
      case 'env_get':
        return `Environment.GetEnvironmentVariable(${a[0]})`;
      case 'args_get':
        return `${RUNTIME}.Args()`;
      case 'time_now_ms':
        return 'DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()';
      case 'time_sleep_ms':
        this.using('System.Threading');
        return `Thread.Sleep((int)${a[0]})`;
      case 'random_float':
        return `${RUNTIME}.RandomFloat()`;
      case 'random_int':
        return `${RUNTIME}.RandomInt(${a[0]}, ${a[1]})`;
      case 'error_new':
        return `new Exception(${a[0]})`;
      case 'error_message':
        return `${a[0]}.Message`;
      case 'assert':
        return `${RUNTIME}.Check(${a[0]}, ${a[1]})`;
      case 'assert_eq':
        return `${RUNTIME}.CheckEqual(${a[0]}, ${a[1]}, ${a[2]})`;
      default:
        throw new BackendGenError(`The C# backend does not implement the "${e.op}" operation.`, {
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

function moduleClass(file: ProjectFile): string {
  return pascal((file.path.split('/').pop() ?? 'Module').replace(/\.[^.]+$/, ''));
}

function rootNamespace(project: Project): string {
  return pascal(project.namespace ?? project.name) || 'App';
}

function namespaceOfPath(path: string, project: Project): string {
  const parts = path.replace(/^src\//, '').split('/');
  parts.pop();
  return [rootNamespace(project), ...parts.map((p) => pascal(p))].filter(Boolean).join('.');
}

export const csharpBackend: LanguageBackend = {
  id: 'csharp',
  name: 'C#',
  maturity: 'full',
  extensions: ['.cs'],
  features: defaultFeatures({ compiled: true }),
  lineComment: '//',
  blockComment: { open: '/*', close: '*/' },
  indent: '    ',
  keywords: KEYWORDS,

  packageManager: {
    id: 'nuget',
    name: 'NuGet',
    installAll: { label: 'dotnet restore', command: 'dotnet', args: ['restore'] },
    installOne: { label: 'dotnet add package', command: 'dotnet', args: ['add', 'package', '{name}', '--version', '{version}'] },
    manifestFile: 'project.csproj',
  },

  toolchain: [
    { command: 'dotnet', versionArgs: ['--version'], installHint: 'Install the .NET SDK 8 or newer from dotnet.microsoft.com.' },
  ],

  entry: { file: 'src/Program.cs', symbol: 'Main', description: 'A class with a static Main(string[]).' },

  sourceRoot: () => 'src',
  testRoot: () => 'tests',
  pathFor: (file) => file.path,

  mapType(type, project) {
    return new CSharpEmitter(scratchContext(project, 'csharp')).type(type);
  },

  importFor(_from, to, _symbols, project) {
    return `using ${namespaceOfPath(to.path, project)};`;
  },

  crossFileReference(symbol, to) {
    return /^[A-Z]/.test(symbol) ? pascal(symbol) : `${moduleClass(to)}.${pascal(symbol)}`;
  },

  emitModule(ctx) {
    return new CSharpEmitter(ctx).emit();
  },

  emitProjectFiles(project) {
    const deps = project.dependencies.filter((d) => d.language === 'csharp');
    const name = pascal(project.name) || 'App';
    return [
      {
        path: `${name}.csproj`,
        role: 'manifest',
        content: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net8.0</TargetFramework>',
          '    <Nullable>enable</Nullable>',
          '    <ImplicitUsings>disable</ImplicitUsings>',
          `    <RootNamespace>${rootNamespace(project)}</RootNamespace>`,
          `    <AssemblyVersion>${project.version.split('-')[0]}.0</AssemblyVersion>`,
          '    <EnableDefaultCompileItems>true</EnableDefaultCompileItems>',
          '  </PropertyGroup>',
          '',
          '  <ItemGroup>',
          ...deps.map(
            (d) => `    <PackageReference Include="${d.name}" Version="${d.version === '*' ? '*' : d.version}" />`,
          ),
          '  </ItemGroup>',
          '',
          '</Project>',
          '',
        ].join('\n'),
      },
      { path: `src/${RUNTIME}.cs`, role: 'source', content: csharpRuntime(rootNamespace(project)) },
    ];
  },

  buildPlan(_project, mode: BuildMode): BuildPlan {
    return {
      steps: [
        {
          label: `dotnet build (${mode})`,
          command: 'dotnet',
          args: ['build', '-c', mode === 'release' ? 'Release' : 'Debug', '--nologo'],
        },
      ],
      artifact: `bin/${mode === 'release' ? 'Release' : 'Debug'}/net8.0`,
    };
  },

  runPlan(_project, mode): RunPlan {
    return {
      command: {
        label: 'Run',
        command: 'dotnet',
        args: ['run', '-c', mode === 'release' ? 'Release' : 'Debug', '--nologo'],
      },
    };
  },

  testPlan: () => ({ steps: [{ label: 'dotnet test', command: 'dotnet', args: ['test', '--nologo'] }] }),

  parseDiagnostics(output): Diagnostic[] {
    const out: Diagnostic[] = [];
    // `src\Program.cs(12,9): error CS0103: The name 'x' does not exist`
    const re = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+?)(?:\s*\[.*\])?$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output))) {
      out.push({
        severity: m[4] === 'error' ? 'error' : 'warning',
        stage: 'build',
        code: `csc/${m[5]}`,
        message: m[6].trim(),
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]),
        column: Number(m[3]),
        raw: m[0],
      });
    }
    return out;
  },
};

function csharpRuntime(ns: string): string {
  return `// Runtime helpers used by generated Master Code programs.
// This file is generated. Edit the graph, not this.

#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace ${ns};

/// <summary>Support functions the generated code calls into.</summary>
public static class ${RUNTIME}
{
    private static string[] _args = Array.Empty<string>();
    private static readonly Random Rng = new();
    private static readonly HttpClient Client = new();

    /// <summary>Outcome of an HTTP request; transport failures arrive as status 0.</summary>
    public sealed record HttpResult(int Status, string Body, Dictionary<string, string> Headers);

    /// <summary>A database handle. Requires a provider from the library catalogue.</summary>
    public sealed record Db(string Path);

    public static void SetArgs(string[] args) => _args = args ?? Array.Empty<string>();

    public static List<string> Args() => _args.ToList();

    public static long Length(object? value) => value switch
    {
        null => 0,
        string s => s.Length,
        System.Collections.ICollection c => c.Count,
        System.Collections.IEnumerable e => e.Cast<object>().Count(),
        _ => 0,
    };

    public static long? ParseInt(string text) =>
        long.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : null;

    public static double? ParseFloat(string text) =>
        double.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : null;

    public static string Format(string template, params object?[] args)
    {
        var output = new StringBuilder();
        var index = 0;
        for (var i = 0; i < template.Length; i++)
        {
            if (i + 1 < template.Length && template[i] == '{' && template[i + 1] == '}')
            {
                output.Append(index < args.Length ? Convert.ToString(args[index++]) : "{}");
                i++;
            }
            else
            {
                output.Append(template[i]);
            }
        }
        return output.ToString();
    }

    public static string Substring(string text, long start, long end)
    {
        var from = (int)Math.Clamp(start, 0, text.Length);
        var to = (int)Math.Clamp(end, from, text.Length);
        return text[from..to];
    }

    public static T? Pop<T>(List<T> list)
    {
        if (list.Count == 0) return default;
        var last = list[^1];
        list.RemoveAt(list.Count - 1);
        return last;
    }

    public static List<T> Slice<T>(List<T> list, long start, long end)
    {
        var from = (int)Math.Clamp(start, 0, list.Count);
        var to = (int)Math.Clamp(end, from, list.Count);
        return list.GetRange(from, to - from);
    }

    public static TValue? MapGet<TKey, TValue>(Dictionary<TKey, TValue> map, TKey key) where TKey : notnull =>
        map.TryGetValue(key, out var value) ? value : default;

    public static double RandomFloat() => Rng.NextDouble();

    public static long RandomInt(long low, long high) => Rng.NextInt64(low, high);

    public static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"assertion failed: {message}");
    }

    public static void CheckEqual(object? actual, object? expected, string message)
    {
        if (!Equals(actual, expected))
            throw new InvalidOperationException($"{message}: expected {expected}, got {actual}");
    }

    public static HttpResult Http(string method, string url, Dictionary<string, string> headers, string body)
    {
        try
        {
            using var request = new HttpRequestMessage(new HttpMethod(method.ToUpperInvariant()), url);
            foreach (var (key, value) in headers) request.Headers.TryAddWithoutValidation(key, value);
            if (!string.IsNullOrEmpty(body)) request.Content = new StringContent(body, Encoding.UTF8);
            using var response = Client.Send(request);
            var text = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            var map = response.Headers.ToDictionary(h => h.Key, h => string.Join(", ", h.Value));
            return new HttpResult((int)response.StatusCode, text, map);
        }
        catch (Exception error)
        {
            return new HttpResult(0, error.Message, new Dictionary<string, string>());
        }
    }

    public static JsonElement JsonGet(JsonElement value, string field) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(field, out var found) ? found : default;

    public static string JsonAsString(JsonElement value) =>
        value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : value.ToString();

    public static double JsonAsNumber(JsonElement value) =>
        value.ValueKind == JsonValueKind.Number ? value.GetDouble() : 0;

    public static List<JsonElement> JsonAsList(JsonElement value) =>
        value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().ToList() : new List<JsonElement>();

    // Database access needs a provider package (for example Microsoft.Data.Sqlite).
    // The manifest records it; Master Code does not install it. Until one is added
    // these throw rather than pretending to work.
    public static Db DbOpen(string path) =>
        throw new NotSupportedException(
            "Add Microsoft.Data.Sqlite from the library catalogue, then implement DbOpen in a Custom Code node.");

    public static long DbExecute(Db db, string sql, List<object?> parameters) =>
        throw new NotSupportedException("DbExecute needs a database provider package.");

    public static List<Dictionary<string, object?>> DbQuery(Db db, string sql, List<object?> parameters) =>
        throw new NotSupportedException("DbQuery needs a database provider package.");

    public static void DbClose(Db db)
    {
    }
}
`;
}

export { CSharpEmitter };
