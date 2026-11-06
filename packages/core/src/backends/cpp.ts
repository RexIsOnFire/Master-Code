/**
 * C++ backend (C++20).
 *
 * Maps onto the standard library directly: `std::vector`, `std::map`,
 * `std::optional`, `std::function`, exceptions. Each module emits a header and
 * an implementation file, which is what makes cross-file references work the
 * way a C++ programmer expects - `#include "models/user.hpp"`.
 *
 * Maturity is `generates`: no C++ toolchain is exercised by this repo's tests.
 */

import type { BuildMode, BuildPlan, EmitContext, GeneratedFile, LanguageBackend, RunPlan } from './backend.ts';
import { BackendGenError, defaultFeatures, generatedHeader } from './backend.ts';
import { CLikeEmitter, javaLikeDialect } from './clike.ts';
import { CodeWriter, avoidKeyword, pascal, screamingSnake, snake, wrapText } from './emitter.ts';
import { scratchContext } from './java.ts';
import type { IrClass, IrDecl, IrEnum, IrExpr, IrFunction, IrInterface, IrParam, IrStmt } from '../ir/ir.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project, ProjectFile } from '../model/project.ts';
import type { TypeRef } from '../types/types.ts';

const KEYWORDS = new Set([
  'alignas', 'alignof', 'and', 'asm', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class',
  'const', 'constexpr', 'continue', 'decltype', 'default', 'delete', 'do', 'double', 'dynamic_cast',
  'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if',
  'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'nullptr', 'operator',
  'or', 'private', 'protected', 'public', 'register', 'return', 'short', 'signed', 'sizeof',
  'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typeid',
  'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'while', 'xor',
]);

class CppEmitter extends CLikeEmitter {
  private readonly includes = new Set<string>();

  constructor(ctx: EmitContext) {
    super(
      ctx,
      javaLikeDialect({
        letKeyword: () => 'auto',
        foreach: (v, t, it, index) =>
          index
            ? `for (std::size_t ${index} = 0; ${index} < ${it}.size(); ++${index}) { const ${t}& ${v} = ${it}[${index}];`
            : `for (const auto& ${v} : ${it})`,
        forRange: (v, start, end, step, inclusive) =>
          `for (long long ${v} = ${start}; ${v} ${inclusive ? '<=' : '<'} ${end}; ${v} += ${step})`,
        power: (b, e) => `std::pow(${b}, ${e})`,
      }),
      KEYWORDS,
      '    ',
    );
  }

  protected override get langId(): string {
    return 'cpp';
  }

  override name(raw: string): string {
    return avoidKeyword(snake(raw), KEYWORDS);
  }

  override typeName(raw: string): string {
    return pascal(raw);
  }

  /** The implementation (.cpp) file. */
  emit(): string {
    const { module, file, project } = this.ctx;
    const body = new CodeWriter('    ');
    for (const d of module.decls) this.declImpl(body, d);

    const entry = module.decls.find((d): d is IrFunction => d.k === 'function' && !!d.isEntry);
    if (entry) {
      body.blank();
      body.braced('int main(int argc, char** argv)', () => {
        body.line('mcruntime::set_args(argc, argv);');
        body.line(`${this.name(entry.name)}();`);
        body.line('return 0;');
      });
    }

    const head = new CodeWriter('    ');
    for (const l of generatedHeader(cppBackend, file, project)) head.line(l);
    head.blank();
    head.line(`#include "${headerName(file.path).split('/').pop()}"`);
    head.blank();
    for (const i of [...this.includes].sort()) head.line(`#include ${i}`);
    for (const imp of module.imports) {
      if (imp.source !== 'file') continue;
      const target = this.ctx.program.modules.find((m) => m.id === imp.target);
      if (target) head.line(`#include "${headerName(`${target.path}.cpp`)}"`);
    }
    head.blank();
    head.block(body.toString().replace(/\n$/, ''));
    return head.toString();
  }

  /** The declaration (.hpp) file. */
  emitHeader(): string {
    const { module, file, project } = this.ctx;
    const w = new CodeWriter('    ');
    for (const l of generatedHeader(cppBackend, file, project)) w.line(l);
    w.blank();
    w.line('#pragma once');
    w.blank();
    w.line('#include <cstdint>');
    w.line('#include <functional>');
    w.line('#include <map>');
    w.line('#include <optional>');
    w.line('#include <set>');
    w.line('#include <string>');
    w.line('#include <vector>');
    w.blank();
    w.line('#include "mcruntime.hpp"');
    w.blank();
    if (module.doc) for (const l of wrapText(module.doc)) w.line(`// ${l}`);
    for (const d of module.decls) this.declHeader(w, d);
    return w.toString();
  }

  private include(header: string): void {
    this.includes.add(`<${header}>`);
  }

  override type(t: TypeRef): string {
    switch (t.kind) {
      case 'void':
      case 'exec':
        return 'void';
      case 'any':
        return 'std::string';
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return 'bool';
          case 'i32':
            return 'std::int32_t';
          case 'i64':
            return 'std::int64_t';
          case 'f32':
            return 'float';
          case 'f64':
            return 'double';
          case 'string':
            return 'std::string';
          case 'char':
            return 'char';
          case 'bytes':
            return 'std::vector<unsigned char>';
        }
        return 'std::string';
      case 'list':
        return `std::vector<${this.type(t.item)}>`;
      case 'set':
        return `std::set<${this.type(t.item)}>`;
      case 'map':
        return `std::map<${this.type(t.key)}, ${this.type(t.value)}>`;
      case 'option':
        return `std::optional<${this.type(t.inner)}>`;
      case 'tuple':
        this.include('tuple');
        return `std::tuple<${t.items.map((i) => this.type(i)).join(', ')}>`;
      case 'future':
        this.include('future');
        return `std::future<${this.type(t.inner)}>`;
      case 'result':
        return this.type(t.ok);
      case 'function':
        return `std::function<${this.type(t.returns)}(${t.params.map((p) => this.type(p)).join(', ')})>`;
      case 'named':
        switch (t.name) {
          case 'Error':
            this.include('stdexcept');
            return 'std::runtime_error';
          case 'Json':
            return 'std::string';
          case 'HttpResponse':
            return 'mcruntime::HttpResponse';
          case 'DbConnection':
            return 'mcruntime::Db';
          case 'Element':
            throw new BackendGenError('DOM types have no C++ equivalent.', { code: 'codegen/dom-in-cpp' });
          default:
            return this.resolvedType(t.name);
        }
      case 'var':
        return 'std::string';
    }
  }

  override zero(t: TypeRef): string {
    switch (t.kind) {
      case 'primitive':
        if (t.name === 'bool') return 'false';
        if (t.name === 'string') return 'std::string()';
        if (t.name === 'char') return "' '";
        if (t.name === 'f32' || t.name === 'f64') return '0.0';
        return '0';
      case 'option':
        return 'std::nullopt';
      case 'void':
        return '';
      default:
        return `${this.type(t)}{}`;
    }
  }

  protected override letStatement(s: Extract<IrStmt, { k: 'let' }>): string {
    const init = s.init ? this.expr(s.init) : this.zero(s.type);
    const constKw = s.mutable === false ? 'const ' : '';
    return `${constKw}${this.type(s.type)} ${this.name(s.name)} = ${init}`;
  }

  protected override throwStatement(value: IrExpr): string {
    this.include('stdexcept');
    return `throw ${this.expr(value)}`;
  }

  protected override catchClause(c: { errType?: TypeRef; varName: string }): string {
    this.include('stdexcept');
    return `const std::exception& ${this.name(c.varName)}`;
  }

  protected override exprInner(e: IrExpr): string {
    if (e.k === 'lit' && e.value.t === 'string') {
      return `std::string(${super.exprInner(e)})`;
    }
    if (e.k === 'new') {
      return `${this.typeName(e.className)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
    }
    return super.exprInner(e);
  }

  protected override selfKeyword(): string {
    return '(*this)';
  }

  protected override memberName(name: string): string {
    return this.name(name);
  }

  protected override arrayLit(e: Extract<IrExpr, { k: 'array' }>): string {
    return `${this.type(e.type)}{${e.items.map((i) => this.expr(i)).join(', ')}}`;
  }

  protected override mapLit(e: Extract<IrExpr, { k: 'mapLit' }>): string {
    const pairs = e.entries.map((en) => `{${this.expr(en.key)}, ${this.expr(en.value)}}`).join(', ');
    return `${this.type(e.type)}{${pairs}}`;
  }

  protected override tupleLit(e: Extract<IrExpr, { k: 'tupleLit' }>): string {
    this.include('tuple');
    return `std::make_tuple(${e.items.map((i) => this.expr(i)).join(', ')})`;
  }

  protected override lambda(e: Extract<IrExpr, { k: 'lambda' }>): string {
    const params = e.params.map((p) => `${this.type(p.type)} ${this.name(p.name)}`).join(', ');
    if (!Array.isArray(e.body)) return `[=](${params}) { return ${this.expr(e.body)}; }`;
    const inner = new CodeWriter('    ');
    this.emitBody(inner, e.body);
    return `[=](${params}) {\n${inner.toString().replace(/\n$/, '')}\n}`;
  }

  protected override cast(e: Extract<IrExpr, { k: 'cast' }>): string {
    const inner = this.expr(e.expr, 17);
    if (e.to.kind === 'primitive' && e.to.name === 'string') return `mcruntime::to_text(${inner})`;
    return `static_cast<${this.type(e.to)}>(${inner})`;
  }

  // -- declarations ----------------------------------------------------------

  private declHeader(w: CodeWriter, d: IrDecl): void {
    switch (d.k) {
      case 'function':
        w.blank();
        if (d.doc?.trim()) for (const l of wrapText(d.doc.trim())) w.line(`/// ${l}`);
        w.line(`${this.type(d.returns)} ${this.name(d.name)}(${d.params.map((p) => this.declParam(p)).join(', ')});`);
        break;
      case 'class':
        this.classHeader(w, d);
        break;
      case 'interface':
        this.interfaceHeader(w, d);
        break;
      case 'enum':
        w.blank();
        if (d.doc?.trim()) w.line(`/// ${d.doc.trim()}`);
        w.line(`enum class ${this.typeName(d.name)} {`);
        w.nest(() => d.variants.forEach((v) => w.line(`${pascal(v.name)},`)));
        w.line('};');
        break;
      case 'global':
        w.blank();
        if (d.doc) w.line(`/// ${d.doc}`);
        w.line(`extern ${this.type(d.type)} ${d.constant ? screamingSnake(d.name) : this.name(d.name)};`);
        break;
      case 'typeAlias':
        w.blank();
        w.line(`using ${this.typeName(d.name)} = ${this.type(d.target)};`);
        break;
      case 'rawDecl':
        break;
    }
  }

  private declImpl(w: CodeWriter, d: IrDecl): void {
    switch (d.k) {
      case 'function':
        w.blank();
        w.braced(
          `${this.type(d.returns)} ${this.name(d.name)}(${d.params.map((p) => this.declParam(p)).join(', ')})`,
          () => {
            this.emitBody(w, d.body);
            if (d.returns.kind !== 'void' && !endsWithReturn(d.body)) w.line(`return ${this.zero(d.returns)};`);
          },
        );
        break;
      case 'class':
        this.classImpl(w, d);
        break;
      case 'global':
        w.blank();
        w.line(
          `${this.type(d.type)} ${d.constant ? screamingSnake(d.name) : this.name(d.name)} = ` +
            `${d.init ? this.expr(d.init) : this.zero(d.type)};`,
        );
        break;
      case 'rawDecl':
        if (d.lang !== 'cpp' && d.lang !== 'any') {
          throw new BackendGenError(`Raw ${d.lang} block cannot be emitted into a C++ file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: d.origin,
          });
        }
        w.blank();
        w.verbatim(d.code);
        break;
      default:
        break;
    }
  }

  private declParam(p: IrParam): string {
    const byRef = p.type.kind === 'list' || p.type.kind === 'map' || p.type.kind === 'set';
    const t = byRef ? `const ${this.type(p.type)}&` : this.type(p.type);
    return `${t} ${this.name(p.name)}`;
  }

  private classHeader(w: CodeWriter, c: IrClass): void {
    w.blank();
    if (c.doc?.trim()) for (const l of wrapText(c.doc.trim())) w.line(`/// ${l}`);
    const bases = [c.extends, ...(c.implements ?? [])].filter(Boolean).map((t) => `public ${this.type(t!)}`);
    w.line(`${c.shape === 'struct' ? 'struct' : 'class'} ${this.typeName(c.name)}${bases.length ? ` : ${bases.join(', ')}` : ''} {`);
    w.line('public:');
    w.nest(() => {
      for (const f of c.fields) {
        if (f.doc) w.line(`/// ${f.doc}`);
        w.line(`${f.isStatic ? 'static ' : ''}${this.type(f.type)} ${this.name(f.name)}${f.init ? ` = ${this.expr(f.init)}` : ''};`);
      }
      w.line(`${this.typeName(c.name)}(${(c.ctor?.params ?? []).map((p) => this.declParam(p)).join(', ')});`);
      for (const m of c.methods) {
        if (m.doc?.trim()) w.line(`/// ${wrapText(m.doc.trim()).join(' ')}`);
        w.line(
          `${m.isStatic ? 'static ' : ''}${this.type(m.returns)} ${this.name(m.name)}(` +
            `${m.params.map((p) => this.declParam(p)).join(', ')});`,
        );
      }
    });
    w.line('};');
  }

  private classImpl(w: CodeWriter, c: IrClass): void {
    const cls = this.typeName(c.name);
    w.blank();
    w.braced(`${cls}::${cls}(${(c.ctor?.params ?? []).map((p) => this.declParam(p)).join(', ')})`, () => {
      if (c.ctor) this.emitBody(w, c.ctor.body);
    });
    for (const m of c.methods) {
      w.blank();
      w.braced(
        `${this.type(m.returns)} ${cls}::${this.name(m.name)}(${m.params.map((p) => this.declParam(p)).join(', ')})`,
        () => {
          this.emitBody(w, m.body);
          if (m.returns.kind !== 'void' && !endsWithReturn(m.body)) w.line(`return ${this.zero(m.returns)};`);
        },
      );
    }
  }

  private interfaceHeader(w: CodeWriter, i: IrInterface): void {
    w.blank();
    if (i.doc?.trim()) for (const l of wrapText(i.doc.trim())) w.line(`/// ${l}`);
    w.line(`class ${this.typeName(i.name)} {`);
    w.line('public:');
    w.nest(() => {
      w.line(`virtual ~${this.typeName(i.name)}() = default;`);
      for (const m of i.methods) {
        w.line(
          `virtual ${this.type(m.returns)} ${this.name(m.name)}(` +
            `${m.params.map((p) => this.declParam(p)).join(', ')}) = 0;`,
        );
      }
    });
    w.line('};');
  }

  override builtin(e: Extract<IrExpr, { k: 'builtin' }>): string {
    const a = e.args.map((x) => this.expr(x, 17));
    const rt = 'mcruntime';
    switch (e.op) {
      case 'print':
        this.include('iostream');
        return `std::cout << ${a.length ? a.map((x) => `${rt}::to_text(${x})`).join(' << " " << ') : '""'} << std::endl`;
      case 'print_err':
        this.include('iostream');
        return `std::cerr << ${a.length ? a.map((x) => `${rt}::to_text(${x})`).join(' << " " << ') : '""'} << std::endl`;
      case 'read_line':
        return `${rt}::read_line()`;
      case 'to_string':
        return `${rt}::to_text(${a[0]})`;
      case 'to_int':
        return `static_cast<std::int64_t>(${rt}::to_number(${a[0]}))`;
      case 'to_float':
        return `${rt}::to_number(${a[0]})`;
      case 'parse_int':
        return `${rt}::parse_int(${a[0]})`;
      case 'parse_float':
        return `${rt}::parse_float(${a[0]})`;
      case 'len':
        return `static_cast<std::int64_t>(${a[0]}.size())`;
      case 'is_empty':
        return `${a[0]}.empty()`;
      case 'str_concat':
        return `(${a[0]} + ${a[1]})`;
      case 'str_upper':
        return `${rt}::upper(${a[0]})`;
      case 'str_lower':
        return `${rt}::lower(${a[0]})`;
      case 'str_trim':
        return `${rt}::trim(${a[0]})`;
      case 'str_split':
        return `${rt}::split(${a[0]}, ${a[1]})`;
      case 'str_join':
        return `${rt}::join(${a[0]}, ${a[1]})`;
      case 'str_replace':
        return `${rt}::replace_all(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'str_contains':
        return `(${a[0]}.find(${a[1]}) != std::string::npos)`;
      case 'str_starts_with':
        return `${a[0]}.starts_with(${a[1]})`;
      case 'str_ends_with':
        return `${a[0]}.ends_with(${a[1]})`;
      case 'str_index_of':
        return `${rt}::index_of(${a[0]}, ${a[1]})`;
      case 'str_substring':
        return `${rt}::substring(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'str_char_at':
        return `${rt}::substring(${a[0]}, ${a[1]}, ${a[1]} + 1)`;
      case 'str_repeat':
        return `${rt}::repeat(${a[0]}, ${a[1]})`;
      case 'str_pad_left':
        return `${rt}::pad_left(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'format':
        return `${rt}::format_text(${a[0]}, {${a.slice(1).map((x) => `${rt}::to_text(${x})`).join(', ')}})`;
      case 'list_new':
        return `${this.type(e.type)}{}`;
      case 'list_get':
        return `${a[0]}[static_cast<std::size_t>(${a[1]})]`;
      case 'list_set':
        return `${a[0]}[static_cast<std::size_t>(${a[1]})] = ${a[2]}`;
      case 'list_push':
        return `${a[0]}.push_back(${a[1]})`;
      case 'list_pop':
        return `${rt}::pop(${a[0]})`;
      case 'list_contains':
        return `${rt}::contains(${a[0]}, ${a[1]})`;
      case 'list_index_of':
        return `${rt}::index_of_item(${a[0]}, ${a[1]})`;
      case 'list_slice':
        return `${rt}::slice(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'list_concat':
        return `${rt}::concat(${a[0]}, ${a[1]})`;
      case 'list_reverse':
        return `${rt}::reversed(${a[0]})`;
      case 'list_sort':
        return `${rt}::sorted(${a[0]})`;
      case 'list_sum':
        return `${rt}::sum(${a[0]})`;
      case 'list_map':
        return `${rt}::mapped(${a[0]}, ${a[1]})`;
      case 'list_filter':
        return `${rt}::filtered(${a[0]}, ${a[1]})`;
      case 'list_reduce':
        return `${rt}::reduced(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'list_any':
        return `${rt}::any_of_list(${a[0]}, ${a[1]})`;
      case 'list_all':
        return `${rt}::all_of_list(${a[0]}, ${a[1]})`;
      case 'list_find':
        return `${rt}::find_first(${a[0]}, ${a[1]})`;
      case 'list_sort_by':
        return `${rt}::sorted_by(${a[0]}, ${a[1]})`;
      case 'list_min':
        return `${rt}::min_value(${a[0]})`;
      case 'list_max':
        return `${rt}::max_value(${a[0]})`;
      case 'list_unique':
        return `${rt}::unique_items(${a[0]})`;
      case 'list_insert':
        return `${a[0]} = ${rt}::inserted(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'list_remove_at':
        return `${a[0]} = ${rt}::removed_at(${a[0]}, ${a[1]})`;
      case 'set_to_list':
        return `${rt}::set_items(${a[0]})`;
      case 'list_range':
        return `${rt}::range(${a[0]}, ${a[1]})`;
      case 'map_new':
        return `${this.type(e.type)}{}`;
      case 'map_get':
        return `${rt}::map_get(${a[0]}, ${a[1]})`;
      case 'map_get_or':
        return `${rt}::map_get_or(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'map_set':
        return `${a[0]}[${a[1]}] = ${a[2]}`;
      case 'map_has':
        return `(${a[0]}.find(${a[1]}) != ${a[0]}.end())`;
      case 'map_remove':
        return `${a[0]}.erase(${a[1]})`;
      case 'map_keys':
        return `${rt}::keys(${a[0]})`;
      case 'map_values':
        return `${rt}::values(${a[0]})`;
      case 'set_new':
        return `${this.type(e.type)}{}`;
      case 'set_add':
        return `${a[0]}.insert(${a[1]})`;
      case 'set_has':
        return `(${a[0]}.count(${a[1]}) > 0)`;
      case 'set_remove':
        return `${a[0]}.erase(${a[1]})`;
      case 'math_abs':
        this.include('cmath');
        return `std::fabs(${a[0]})`;
      case 'math_floor':
        this.include('cmath');
        return `static_cast<std::int64_t>(std::floor(${a[0]}))`;
      case 'math_ceil':
        this.include('cmath');
        return `static_cast<std::int64_t>(std::ceil(${a[0]}))`;
      case 'math_round':
        this.include('cmath');
        return `static_cast<std::int64_t>(std::llround(${a[0]}))`;
      case 'math_sqrt':
        this.include('cmath');
        return `std::sqrt(${a[0]})`;
      case 'math_pow':
        this.include('cmath');
        return `std::pow(${a[0]}, ${a[1]})`;
      case 'math_min':
        this.include('algorithm');
        return `std::min<double>(${a[0]}, ${a[1]})`;
      case 'math_max':
        this.include('algorithm');
        return `std::max<double>(${a[0]}, ${a[1]})`;
      case 'math_log':
        this.include('cmath');
        return `std::log(${a[0]})`;
      case 'math_exp':
        this.include('cmath');
        return `std::exp(${a[0]})`;
      case 'math_sin':
        this.include('cmath');
        return `std::sin(${a[0]})`;
      case 'math_cos':
        this.include('cmath');
        return `std::cos(${a[0]})`;
      case 'math_tan':
        this.include('cmath');
        return `std::tan(${a[0]})`;
      case 'math_atan2':
        this.include('cmath');
        return `std::atan2(${a[0]}, ${a[1]})`;
      case 'math_idiv':
        return `(${a[0]} / ${a[1]})`;
      case 'math_pi':
        return '3.14159265358979323846';
      case 'file_read_text':
        return `${rt}::read_text(${a[0]})`;
      case 'file_write_text':
        return `${rt}::write_text(${a[0]}, ${a[1]})`;
      case 'file_append_text':
        return `${rt}::append_text(${a[0]}, ${a[1]})`;
      case 'file_exists':
        return `${rt}::file_exists(${a[0]})`;
      case 'dir_create':
        return `${rt}::create_dir(${a[0]})`;
      case 'dir_list':
        return `${rt}::list_dir(${a[0]})`;
      case 'path_join':
        return `${rt}::path_join(${a[0]}, ${a[1]})`;
      case 'env_get':
        return `${rt}::env_get(${a[0]})`;
      case 'args_get':
        return `${rt}::args()`;
      case 'time_now_ms':
        return `${rt}::now_ms()`;
      case 'time_sleep_ms':
        return `${rt}::sleep_ms(${a[0]})`;
      case 'random_float':
        return `${rt}::random_float()`;
      case 'random_int':
        return `${rt}::random_int(${a[0]}, ${a[1]})`;
      case 'error_new':
        this.include('stdexcept');
        return `std::runtime_error(${a[0]})`;
      case 'error_message':
        return `std::string(${a[0]}.what())`;
      case 'assert':
        return `${rt}::check(${a[0]}, ${a[1]})`;
      case 'assert_eq':
        return `${rt}::check_equal(${rt}::to_text(${a[0]}), ${rt}::to_text(${a[1]}), ${a[2]})`;
      default:
        throw new BackendGenError(
          `The C++ backend does not implement "${e.op}". Use a Custom Code node, or extend the C++ adapter.`,
          { code: 'codegen/unsupported-builtin', origin: e.origin },
        );
    }
  }
}

function endsWithReturn(body: IrStmt[]): boolean {
  const last = body[body.length - 1];
  return !!last && (last.k === 'return' || last.k === 'throw');
}

export function headerName(path: string): string {
  return path.replace(/\.(cpp|cc|cxx)$/, '.hpp');
}

export const cppBackend: LanguageBackend = {
  id: 'cpp',
  name: 'C++ (C++20)',
  maturity: 'generates',
  extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.h'],
  features: defaultFeatures({ compiled: true, managedMemory: false }),
  lineComment: '//',
  blockComment: { open: '/*', close: '*/' },
  indent: '    ',
  keywords: KEYWORDS,

  packageManager: {
    id: 'vcpkg',
    name: 'vcpkg',
    installAll: { label: 'vcpkg install', command: 'vcpkg', args: ['install'] },
    installOne: { label: 'vcpkg install', command: 'vcpkg', args: ['install', '{name}'] },
    manifestFile: 'vcpkg.json',
  },

  toolchain: [
    { command: 'cmake', versionArgs: ['--version'], installHint: 'Install CMake 3.20+ from cmake.org.' },
    { command: 'g++', versionArgs: ['--version'], installHint: 'Install GCC, Clang, or MSVC build tools.' },
  ],

  entry: { file: 'src/main.cpp', symbol: 'main', description: 'A translation unit with int main().' },

  sourceRoot: () => 'src',
  testRoot: () => 'tests',
  pathFor: (file) => file.path,

  mapType(type, project) {
    return new CppEmitter(scratchContext(project, 'cpp')).type(type);
  },

  importFor(_from, to) {
    return `#include "${headerName(`${to.path}.cpp`)}"`;
  },

  emitModule(ctx) {
    return new CppEmitter(ctx).emit();
  },

  emitProjectFiles(project, program) {
    const files: GeneratedFile[] = [];
    const sources = program.modules.map((m) => `${m.path}.cpp`);
    const deps = project.dependencies.filter((d) => d.language === 'cpp');

    files.push({
      path: 'CMakeLists.txt',
      role: 'build',
      content: [
        'cmake_minimum_required(VERSION 3.20)',
        `project(${project.name.replace(/[^A-Za-z0-9_]/g, '_')} VERSION ${project.version.split('-')[0]} LANGUAGES CXX)`,
        '',
        'set(CMAKE_CXX_STANDARD 20)',
        'set(CMAKE_CXX_STANDARD_REQUIRED ON)',
        'set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)',
        '',
        'add_executable(app',
        ...['src/mcruntime.cpp', ...sources].map((s) => `    ${s}`),
        ')',
        '',
        'target_include_directories(app PRIVATE src)',
        ...deps.map((d) => `# find_package(${d.name} CONFIG REQUIRED)  # from the library catalogue`),
        '',
      ].join('\n'),
    });

    files.push({
      path: 'vcpkg.json',
      role: 'manifest',
      content: `${JSON.stringify(
        {
          name: project.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
          version: project.version.split('-')[0],
          dependencies: deps.map((d) => d.name),
        },
        null,
        2,
      )}\n`,
    });

    files.push({ path: 'src/mcruntime.hpp', role: 'source', content: CPP_RUNTIME_HPP });
    files.push({ path: 'src/mcruntime.cpp', role: 'source', content: CPP_RUNTIME_CPP });
    return files;
  },

  buildPlan(_project, mode: BuildMode): BuildPlan {
    return {
      steps: [
        {
          label: 'CMake configure',
          command: 'cmake',
          args: ['-S', '.', '-B', 'build', `-DCMAKE_BUILD_TYPE=${mode === 'release' ? 'Release' : 'Debug'}`],
        },
        { label: 'CMake build', command: 'cmake', args: ['--build', 'build', '--config', mode === 'release' ? 'Release' : 'Debug'] },
      ],
      artifact: 'build/bin/app',
    };
  },

  runPlan: () => ({ command: { label: 'Run', command: 'build/bin/app', args: [] } }),
  testPlan: () => ({ steps: [{ label: 'ctest', command: 'ctest', args: ['--test-dir', 'build', '--output-on-failure'] }] }),

  parseDiagnostics(output): Diagnostic[] {
    const out: Diagnostic[] = [];
    // GCC/Clang: `src/main.cpp:12:5: error: ...`  MSVC: `src\main.cpp(12): error C2065: ...`
    const gnu = /^(.+?\.(?:cpp|hpp|cc|h)):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = gnu.exec(output))) {
      if (m[4] === 'note') continue;
      out.push({
        severity: m[4] === 'error' ? 'error' : 'warning',
        stage: 'build',
        code: `cpp/${m[4]}`,
        message: m[5].trim(),
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]),
        column: Number(m[3]),
        raw: m[0],
      });
    }
    const msvc = /^(.+?\.(?:cpp|hpp|h))\((\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)$/gm;
    while ((m = msvc.exec(output))) {
      out.push({
        severity: m[3] === 'error' ? 'error' : 'warning',
        stage: 'build',
        code: `cpp/${m[4]}`,
        message: m[5].trim(),
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]),
        raw: m[0],
      });
    }
    return out;
  },
};

/** Header emission, exposed so the code generator can write both halves. */
export function emitCppHeader(ctx: EmitContext): string {
  return new CppEmitter(ctx).emitHeader();
}

export function cppHeaderPathFor(file: ProjectFile): string {
  return headerName(file.path);
}

const CPP_RUNTIME_HPP = `// Runtime helpers used by generated Master Code programs.
// This file is generated. Edit the graph, not this.
#pragma once

// <algorithm> is needed by the collection helpers below (sort, find, any_of).
#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace mcruntime {

/// Outcome of an HTTP request. Transport failures arrive as status 0.
struct HttpResponse {
    std::int64_t status = 0;
    std::string body;
};

/// Placeholder database handle; add a driver from the library catalogue.
struct Db {
    std::string path;
};

void set_args(int argc, char** argv);
std::vector<std::string> args();

std::string read_line();
std::string to_text(const std::string& value);
std::string to_text(bool value);
std::string to_text(std::int64_t value);
std::string to_text(std::int32_t value);
std::string to_text(double value);
double to_number(const std::string& value);
double to_number(double value);
std::optional<std::int64_t> parse_int(const std::string& text);
std::optional<double> parse_float(const std::string& text);

std::string upper(const std::string& text);
std::string lower(const std::string& text);
std::string trim(const std::string& text);
std::vector<std::string> split(const std::string& text, const std::string& separator);
std::string join(const std::vector<std::string>& parts, const std::string& separator);
std::string replace_all(const std::string& text, const std::string& find, const std::string& with);
std::int64_t index_of(const std::string& text, const std::string& needle);
std::string substring(const std::string& text, std::int64_t start, std::int64_t end);
std::string repeat(const std::string& text, std::int64_t times);
std::string pad_left(const std::string& text, std::int64_t width, const std::string& fill);
std::string format_text(const std::string& tmpl, const std::vector<std::string>& args);

std::vector<std::int64_t> range(std::int64_t start, std::int64_t end);

std::string read_text(const std::string& path);
void write_text(const std::string& path, const std::string& text);
void append_text(const std::string& path, const std::string& text);
bool file_exists(const std::string& path);
void create_dir(const std::string& path);
std::vector<std::string> list_dir(const std::string& path);
std::string path_join(const std::string& a, const std::string& b);

std::optional<std::string> env_get(const std::string& name);
std::int64_t now_ms();
void sleep_ms(std::int64_t millis);
double random_float();
std::int64_t random_int(std::int64_t low, std::int64_t high);

void check(bool condition, const std::string& message);
void check_equal(const std::string& actual, const std::string& expected, const std::string& message);

/// Templates that must be visible at every call site.
template <typename T>
std::optional<T> pop(std::vector<T>& list) {
    if (list.empty()) return std::nullopt;
    T last = list.back();
    list.pop_back();
    return last;
}

template <typename T>
bool contains(const std::vector<T>& list, const T& value) {
    for (const auto& item : list) {
        if (item == value) return true;
    }
    return false;
}

template <typename T>
std::int64_t index_of_item(const std::vector<T>& list, const T& value) {
    for (std::size_t i = 0; i < list.size(); ++i) {
        if (list[i] == value) return static_cast<std::int64_t>(i);
    }
    return -1;
}

template <typename T>
std::vector<T> slice(const std::vector<T>& list, std::int64_t start, std::int64_t end) {
    const auto size = static_cast<std::int64_t>(list.size());
    const auto from = start < 0 ? 0 : (start > size ? size : start);
    const auto to = end < from ? from : (end > size ? size : end);
    return std::vector<T>(list.begin() + from, list.begin() + to);
}

template <typename T>
std::vector<T> concat(std::vector<T> a, const std::vector<T>& b) {
    a.insert(a.end(), b.begin(), b.end());
    return a;
}

template <typename T>
std::vector<T> reversed(std::vector<T> list) {
    std::vector<T> out(list.rbegin(), list.rend());
    return out;
}

template <typename T>
std::vector<T> sorted(std::vector<T> list) {
    std::sort(list.begin(), list.end());
    return list;
}

template <typename T>
double sum(const std::vector<T>& list) {
    double total = 0;
    for (const auto& item : list) total += static_cast<double>(item);
    return total;
}

// -- functional collection operations ----------------------------------------
//
// <algorithm> covers most of this, but each one still has to build and return a
// new vector, because the IR treats a list operation as an expression. Taking
// the callable as a template parameter lets a lambda be passed without going
// through std::function, which would allocate on every call.

template <typename T, typename F>
auto mapped(const std::vector<T>& list, F fn) -> std::vector<decltype(fn(list[0]))> {
    std::vector<decltype(fn(list[0]))> out;
    out.reserve(list.size());
    for (const auto& item : list) out.push_back(fn(item));
    return out;
}

template <typename T, typename F>
std::vector<T> filtered(const std::vector<T>& list, F fn) {
    std::vector<T> out;
    for (const auto& item : list) {
        if (fn(item)) out.push_back(item);
    }
    return out;
}

template <typename T, typename U, typename F>
U reduced(const std::vector<T>& list, F fn, U initial) {
    U acc = initial;
    for (const auto& item : list) acc = fn(acc, item);
    return acc;
}

template <typename T, typename F>
bool any_of_list(const std::vector<T>& list, F fn) {
    return std::any_of(list.begin(), list.end(), fn);
}

template <typename T, typename F>
bool all_of_list(const std::vector<T>& list, F fn) {
    return std::all_of(list.begin(), list.end(), fn);
}

template <typename T, typename F>
std::optional<T> find_first(const std::vector<T>& list, F fn) {
    auto found = std::find_if(list.begin(), list.end(), fn);
    return found == list.end() ? std::nullopt : std::optional<T>(*found);
}

template <typename T, typename F>
std::vector<T> sorted_by(std::vector<T> list, F key) {
    // Stable, so equal keys keep their original order and the output is
    // reproducible across runs and standard library implementations.
    std::stable_sort(list.begin(), list.end(),
                     [&](const T& a, const T& b) { return key(a) < key(b); });
    return list;
}

template <typename T>
std::optional<double> min_value(const std::vector<T>& list) {
    if (list.empty()) return std::nullopt;
    double best = static_cast<double>(list.front());
    for (const auto& item : list) best = std::min(best, static_cast<double>(item));
    return best;
}

template <typename T>
std::optional<double> max_value(const std::vector<T>& list) {
    if (list.empty()) return std::nullopt;
    double best = static_cast<double>(list.front());
    for (const auto& item : list) best = std::max(best, static_cast<double>(item));
    return best;
}

// Order-preserving, and only needs operator== on T — a std::set would demand
// operator< and reorder the result.
template <typename T>
std::vector<T> unique_items(const std::vector<T>& list) {
    std::vector<T> out;
    for (const auto& item : list) {
        if (std::find(out.begin(), out.end(), item) == out.end()) out.push_back(item);
    }
    return out;
}

template <typename T>
std::vector<T> inserted(std::vector<T> list, long long index, T value) {
    long long at = index < 0 ? 0 : index;
    if (at > static_cast<long long>(list.size())) at = static_cast<long long>(list.size());
    list.insert(list.begin() + at, value);
    return list;
}

template <typename T>
std::vector<T> removed_at(std::vector<T> list, long long index) {
    if (index < 0 || index >= static_cast<long long>(list.size())) return list;
    list.erase(list.begin() + index);
    return list;
}

template <typename T>
std::vector<T> set_items(const std::set<T>& values) {
    return std::vector<T>(values.begin(), values.end());
}

template <typename K, typename V>
std::optional<V> map_get(const std::map<K, V>& m, const K& key) {
    auto found = m.find(key);
    return found == m.end() ? std::nullopt : std::optional<V>(found->second);
}

template <typename K, typename V>
V map_get_or(const std::map<K, V>& m, const K& key, const V& fallback) {
    auto found = m.find(key);
    return found == m.end() ? fallback : found->second;
}

template <typename K, typename V>
std::vector<K> keys(const std::map<K, V>& m) {
    std::vector<K> out;
    for (const auto& entry : m) out.push_back(entry.first);
    return out;
}

template <typename K, typename V>
std::vector<V> values(const std::map<K, V>& m) {
    std::vector<V> out;
    for (const auto& entry : m) out.push_back(entry.second);
    return out;
}

}  // namespace mcruntime
`;

const CPP_RUNTIME_CPP = `// Runtime helpers used by generated Master Code programs.
// This file is generated. Edit the graph, not this.
#include "mcruntime.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <random>
#include <sstream>
#include <stdexcept>
#include <thread>

namespace mcruntime {
namespace {
std::vector<std::string> g_args;
std::mt19937_64& rng() {
    static std::mt19937_64 engine{std::random_device{}()};
    return engine;
}
}  // namespace

void set_args(int argc, char** argv) {
    g_args.clear();
    for (int i = 1; i < argc; ++i) g_args.emplace_back(argv[i]);
}

std::vector<std::string> args() { return g_args; }

std::string read_line() {
    std::string line;
    if (!std::getline(std::cin, line)) return "";
    if (!line.empty() && line.back() == '\\r') line.pop_back();
    return line;
}

std::string to_text(const std::string& value) { return value; }
std::string to_text(bool value) { return value ? "true" : "false"; }
std::string to_text(std::int64_t value) { return std::to_string(value); }
std::string to_text(std::int32_t value) { return std::to_string(value); }

std::string to_text(double value) {
    std::ostringstream out;
    out << value;
    return out.str();
}

double to_number(const std::string& value) {
    try {
        return std::stod(value);
    } catch (const std::exception&) {
        return 0.0;
    }
}

double to_number(double value) { return value; }

std::optional<std::int64_t> parse_int(const std::string& text) {
    try {
        std::size_t used = 0;
        const auto value = std::stoll(trim(text), &used);
        return used == trim(text).size() ? std::optional<std::int64_t>(value) : std::nullopt;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

std::optional<double> parse_float(const std::string& text) {
    try {
        std::size_t used = 0;
        const auto value = std::stod(trim(text), &used);
        return used == trim(text).size() ? std::optional<double>(value) : std::nullopt;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

std::string upper(const std::string& text) {
    std::string out = text;
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return std::toupper(c); });
    return out;
}

std::string lower(const std::string& text) {
    std::string out = text;
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return std::tolower(c); });
    return out;
}

std::string trim(const std::string& text) {
    const auto first = text.find_first_not_of(" \\t\\r\\n");
    if (first == std::string::npos) return "";
    const auto last = text.find_last_not_of(" \\t\\r\\n");
    return text.substr(first, last - first + 1);
}

std::vector<std::string> split(const std::string& text, const std::string& separator) {
    std::vector<std::string> out;
    if (separator.empty()) {
        out.push_back(text);
        return out;
    }
    std::size_t start = 0;
    std::size_t found = text.find(separator);
    while (found != std::string::npos) {
        out.push_back(text.substr(start, found - start));
        start = found + separator.size();
        found = text.find(separator, start);
    }
    out.push_back(text.substr(start));
    return out;
}

std::string join(const std::vector<std::string>& parts, const std::string& separator) {
    std::string out;
    for (std::size_t i = 0; i < parts.size(); ++i) {
        if (i) out += separator;
        out += parts[i];
    }
    return out;
}

std::string replace_all(const std::string& text, const std::string& find, const std::string& with) {
    if (find.empty()) return text;
    std::string out;
    std::size_t start = 0;
    std::size_t found = text.find(find);
    while (found != std::string::npos) {
        out += text.substr(start, found - start) + with;
        start = found + find.size();
        found = text.find(find, start);
    }
    return out + text.substr(start);
}

std::int64_t index_of(const std::string& text, const std::string& needle) {
    const auto found = text.find(needle);
    return found == std::string::npos ? -1 : static_cast<std::int64_t>(found);
}

std::string substring(const std::string& text, std::int64_t start, std::int64_t end) {
    const auto size = static_cast<std::int64_t>(text.size());
    const auto from = std::clamp<std::int64_t>(start, 0, size);
    const auto to = std::clamp<std::int64_t>(end, from, size);
    return text.substr(static_cast<std::size_t>(from), static_cast<std::size_t>(to - from));
}

std::string repeat(const std::string& text, std::int64_t times) {
    std::string out;
    for (std::int64_t i = 0; i < times; ++i) out += text;
    return out;
}

std::string pad_left(const std::string& text, std::int64_t width, const std::string& fill) {
    if (fill.empty()) return text;
    std::string out;
    while (static_cast<std::int64_t>(out.size() + text.size()) < width) out += fill;
    return out + text;
}

std::string format_text(const std::string& tmpl, const std::vector<std::string>& args) {
    std::string out;
    std::size_t index = 0;
    for (std::size_t i = 0; i < tmpl.size(); ++i) {
        if (i + 1 < tmpl.size() && tmpl[i] == '{' && tmpl[i + 1] == '}') {
            out += index < args.size() ? args[index++] : "{}";
            ++i;
            continue;
        }
        out += tmpl[i];
    }
    return out;
}

std::vector<std::int64_t> range(std::int64_t start, std::int64_t end) {
    std::vector<std::int64_t> out;
    for (std::int64_t i = start; i < end; ++i) out.push_back(i);
    return out;
}

std::string read_text(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) return "";
    std::ostringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

void write_text(const std::string& path, const std::string& text) {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file << text;
}

void append_text(const std::string& path, const std::string& text) {
    std::ofstream file(path, std::ios::binary | std::ios::app);
    file << text;
}

bool file_exists(const std::string& path) { return std::filesystem::exists(path); }

void create_dir(const std::string& path) {
    std::error_code error;
    std::filesystem::create_directories(path, error);
}

std::vector<std::string> list_dir(const std::string& path) {
    std::vector<std::string> out;
    std::error_code error;
    for (const auto& entry : std::filesystem::directory_iterator(path, error)) {
        out.push_back(entry.path().filename().string());
    }
    std::sort(out.begin(), out.end());
    return out;
}

std::string path_join(const std::string& a, const std::string& b) {
    return (std::filesystem::path(a) / b).string();
}

std::optional<std::string> env_get(const std::string& name) {
    const char* value = std::getenv(name.c_str());
    return value ? std::optional<std::string>(value) : std::nullopt;
}

std::int64_t now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

void sleep_ms(std::int64_t millis) {
    std::this_thread::sleep_for(std::chrono::milliseconds(millis));
}

double random_float() {
    std::uniform_real_distribution<double> dist(0.0, 1.0);
    return dist(rng());
}

std::int64_t random_int(std::int64_t low, std::int64_t high) {
    if (high <= low) return low;
    std::uniform_int_distribution<std::int64_t> dist(low, high - 1);
    return dist(rng());
}

void check(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error("assertion failed: " + message);
}

void check_equal(const std::string& actual, const std::string& expected, const std::string& message) {
    if (actual != expected) {
        throw std::runtime_error(message + ": expected " + expected + ", got " + actual);
    }
}

}  // namespace mcruntime
`;

export { CppEmitter };
