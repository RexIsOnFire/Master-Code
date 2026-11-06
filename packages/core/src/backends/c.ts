/**
 * C backend (C11).
 *
 * C is the one target where the IR is genuinely wider than the language: there
 * are no closures, no generics, no exceptions and no collection types. Rather
 * than fake any of those, this adapter:
 *
 *  - declares the missing features in `features`, so the generator refuses the
 *    graph up front with a message naming the node, instead of emitting code
 *    that will not compile;
 *  - ships a small runtime (`mc_list`, `mc_map`, `mc_str`) so lists, maps and
 *    strings behave predictably where they are supported;
 *  - emits a header and an implementation per module, so cross-file references
 *    are ordinary `#include`s.
 *
 * What it does support - procedural logic, structs, enums, arithmetic, strings,
 * lists, maps, file and console I/O - it supports properly.
 */

import type { BuildMode, BuildPlan, EmitContext, GeneratedFile, LanguageBackend, RunPlan } from './backend.ts';
import { BackendGenError, defaultFeatures, generatedHeader } from './backend.ts';
import { CLikeEmitter, javaLikeDialect } from './clike.ts';
import { CodeWriter, avoidKeyword, pascal, screamingSnake, snake, wrapText } from './emitter.ts';
import { scratchContext } from './java.ts';
import type { IrClass, IrDecl, IrEnum, IrExpr, IrFunction, IrParam, IrStmt } from '../ir/ir.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project, ProjectFile } from '../model/project.ts';
import type { TypeRef } from '../types/types.ts';

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return',
  'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
  'volatile', 'while', 'bool', 'true', 'false',
]);

class CEmitter extends CLikeEmitter {
  private readonly includes = new Set(['<stdio.h>', '<stdlib.h>', '<string.h>', '"mcruntime.h"']);

  constructor(ctx: EmitContext) {
    super(
      ctx,
      javaLikeDialect({
        letKeyword: () => '',
        foreach: (v, t, it, index) => {
          const i = index ?? '_i';
          return `for (long ${i} = 0; ${i} < mc_list_len(${it}); ++${i}) { ${t} ${v} = (${t}) mc_list_get(${it}, ${i});`;
        },
        forRange: (v, start, end, step, inclusive) =>
          `for (long long ${v} = ${start}; ${v} ${inclusive ? '<=' : '<'} ${end}; ${v} += ${step})`,
        power: (b, e) => `pow(${b}, ${e})`,
      }),
      KEYWORDS,
      '    ',
    );
  }

  protected override get langId(): string {
    return 'c';
  }

  override name(raw: string): string {
    return avoidKeyword(snake(raw), KEYWORDS);
  }

  override typeName(raw: string): string {
    return `${snake(raw)}_t`;
  }

  emit(): string {
    const { module, file, project } = this.ctx;
    const body = new CodeWriter('    ');
    for (const d of module.decls) this.declImpl(body, d);

    const entry = module.decls.find((d): d is IrFunction => d.k === 'function' && !!d.isEntry);
    if (entry) {
      body.blank();
      body.braced('int main(int argc, char** argv)', () => {
        body.line('mc_set_args(argc, argv);');
        body.line(`${this.name(entry.name)}();`);
        body.line('return 0;');
      });
    }

    const head = new CodeWriter('    ');
    for (const l of generatedHeader(cBackend, file, project)) head.line(l);
    head.blank();
    head.line(`#include "${(headerOf(file.path).split('/').pop() ?? 'module.h')}"`);
    head.blank();
    for (const i of [...this.includes].sort()) head.line(`#include ${i}`);
    for (const imp of module.imports) {
      if (imp.source !== 'file') continue;
      const target = this.ctx.program.modules.find((m) => m.id === imp.target);
      if (target) head.line(`#include "${headerOf(`${target.path}.c`)}"`);
    }
    head.blank();
    head.block(body.toString().replace(/\n$/, ''));
    return head.toString();
  }

  emitHeader(): string {
    const { module, file, project } = this.ctx;
    const guard = `MC_${screamingSnake(file.path.replace(/[^A-Za-z0-9]/g, '_'))}_H`;
    const w = new CodeWriter('    ');
    for (const l of generatedHeader(cBackend, file, project)) w.line(l);
    w.blank();
    w.line(`#ifndef ${guard}`);
    w.line(`#define ${guard}`);
    w.blank();
    w.line('#include <stdbool.h>');
    w.line('#include <stdint.h>');
    w.line('#include "mcruntime.h"');
    w.blank();
    if (module.doc) for (const l of wrapText(module.doc)) w.line(`/* ${l} */`);
    for (const d of module.decls) this.declHeader(w, d);
    w.blank();
    w.line(`#endif  /* ${guard} */`);
    return w.toString();
  }

  private include(header: string): void {
    this.includes.add(header.startsWith('"') ? header : `<${header}>`);
  }

  override type(t: TypeRef): string {
    switch (t.kind) {
      case 'void':
      case 'exec':
        return 'void';
      case 'any':
        return 'const char*';
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return 'bool';
          case 'i32':
            return 'int32_t';
          case 'i64':
            return 'int64_t';
          case 'f32':
            return 'float';
          case 'f64':
            return 'double';
          case 'string':
            return 'const char*';
          case 'char':
            return 'char';
          case 'bytes':
            return 'mc_bytes';
        }
        return 'const char*';
      case 'list':
        return 'mc_list*';
      case 'set':
        return 'mc_list*';
      case 'map':
        return 'mc_map*';
      case 'option':
        // C has no optional; a pointer type carries NULL, and value types
        // cannot, so the inner type is used and absence is its zero value.
        return this.type(t.inner);
      case 'tuple':
        throw new BackendGenError('C has no tuple type. Return a struct, or use several outputs.', {
          code: 'codegen/c-no-tuples',
        });
      case 'future':
        throw new BackendGenError('C has no async support in this adapter.', { code: 'codegen/c-no-async' });
      case 'result':
        return this.type(t.ok);
      case 'function':
        return `${this.type(t.returns)} (*)(${t.params.map((p) => this.type(p)).join(', ') || 'void'})`;
      case 'named':
        switch (t.name) {
          case 'Error':
            return 'const char*';
          case 'Json':
            return 'const char*';
          case 'HttpResponse':
            return 'mc_http_response';
          case 'DbConnection':
            throw new BackendGenError('Database nodes are not supported by the C adapter.', {
              code: 'codegen/c-no-db',
              hint: 'Use a Custom Code node with your own SQLite bindings.',
            });
          case 'Element':
            throw new BackendGenError('DOM types have no C equivalent.', { code: 'codegen/dom-in-c' });
          default:
            return `${this.typeName(t.name)}`;
        }
      case 'var':
        return 'const char*';
    }
  }

  override zero(t: TypeRef): string {
    switch (t.kind) {
      case 'primitive':
        if (t.name === 'bool') return 'false';
        if (t.name === 'string') return '""';
        if (t.name === 'char') return "' '";
        if (t.name === 'f32' || t.name === 'f64') return '0.0';
        return '0';
      case 'list':
      case 'set':
        return 'mc_list_new()';
      case 'map':
        return 'mc_map_new()';
      case 'void':
        return '';
      default:
        return 'NULL';
    }
  }

  protected override letStatement(s: Extract<IrStmt, { k: 'let' }>): string {
    const init = s.init ? this.expr(s.init) : this.zero(s.type);
    return `${this.type(s.type)} ${this.name(s.name)} = ${init}`;
  }

  protected override throwStatement(value: IrExpr): string {
    // No exceptions in C: report and exit, which is at least honest and
    // debuggable, rather than silently continuing.
    return `mc_fail(${this.expr(value)})`;
  }

  protected override tryStmt(w: CodeWriter, s: Extract<IrStmt, { k: 'try' }>): void {
    throw new BackendGenError(
      'C has no exceptions, so Try/Catch cannot be generated. Return an error code and branch on it instead.',
      { code: 'codegen/c-no-exceptions', origin: s.origin, hint: 'Replace the Try node with an If on a status value.' },
    );
  }

  protected override lambda(e: Extract<IrExpr, { k: 'lambda' }>): string {
    throw new BackendGenError(
      'C has no closures, so Lambda nodes cannot be generated. Use a named Function node and a Function Reference.',
      { code: 'codegen/c-no-closures', origin: e.origin },
    );
  }

  protected override exprInner(e: IrExpr): string {
    if (e.k === 'new') {
      throw new BackendGenError('C has no constructors. Declare a struct and set its fields.', {
        code: 'codegen/c-no-new',
        origin: e.origin,
      });
    }
    return super.exprInner(e);
  }

  protected override selfKeyword(): string {
    return 'self';
  }

  protected override memberAccess(): string {
    return '->';
  }

  protected override memberName(name: string): string {
    return this.name(name);
  }

  protected override arrayLit(e: Extract<IrExpr, { k: 'array' }>): string {
    if (!e.items.length) return 'mc_list_new()';
    return `mc_list_of(${e.items.length}, ${e.items.map((i) => `(void*)(intptr_t)(${this.expr(i)})`).join(', ')})`;
  }

  protected override mapLit(e: Extract<IrExpr, { k: 'mapLit' }>): string {
    if (!e.entries.length) return 'mc_map_new()';
    const pairs = e.entries.map((en) => `${this.expr(en.key)}, (void*)(${this.expr(en.value)})`).join(', ');
    return `mc_map_of(${e.entries.length}, ${pairs})`;
  }

  protected override cast(e: Extract<IrExpr, { k: 'cast' }>): string {
    const inner = this.expr(e.expr, 13);
    if (e.to.kind === 'primitive' && e.to.name === 'string') return `mc_to_text_any(${inner})`;
    return `(${this.type(e.to)}) (${inner})`;
  }

  // -- declarations ----------------------------------------------------------

  private declHeader(w: CodeWriter, d: IrDecl): void {
    switch (d.k) {
      case 'function':
        w.blank();
        if (d.doc?.trim()) for (const l of wrapText(d.doc.trim())) w.line(`/* ${l} */`);
        w.line(`${this.type(d.returns)} ${this.name(d.name)}(${this.paramList(d.params)});`);
        break;
      case 'class':
        this.structHeader(w, d);
        break;
      case 'enum':
        this.enumHeader(w, d);
        break;
      case 'global':
        w.blank();
        w.line(`extern ${this.type(d.type)} ${d.constant ? screamingSnake(d.name) : this.name(d.name)};`);
        break;
      case 'typeAlias':
        w.blank();
        w.line(`typedef ${this.type(d.target)} ${this.typeName(d.name)};`);
        break;
      case 'interface':
        w.blank();
        w.line(`/* Interface "${d.name}" has no C equivalent; implement it as a struct of function pointers. */`);
        break;
      case 'rawDecl':
        break;
    }
  }

  private declImpl(w: CodeWriter, d: IrDecl): void {
    switch (d.k) {
      case 'function':
        w.blank();
        w.braced(`${this.type(d.returns)} ${this.name(d.name)}(${this.paramList(d.params)})`, () => {
          this.emitBody(w, d.body);
          if (d.returns.kind !== 'void' && !endsWithReturn(d.body)) w.line(`return ${this.zero(d.returns)};`);
        });
        break;
      case 'class':
        for (const m of d.methods) {
          w.blank();
          const params = [`${this.typeName(d.name)}* self`, ...d.methods.length ? m.params.map((p) => this.param(p)) : []];
          w.braced(`${this.type(m.returns)} ${snake(d.name)}_${this.name(m.name)}(${params.join(', ')})`, () => {
            this.emitBody(w, m.body);
            if (m.returns.kind !== 'void' && !endsWithReturn(m.body)) w.line(`return ${this.zero(m.returns)};`);
          });
        }
        break;
      case 'global':
        w.blank();
        w.line(
          `${this.type(d.type)} ${d.constant ? screamingSnake(d.name) : this.name(d.name)} = ` +
            `${d.init ? this.expr(d.init) : this.zero(d.type)};`,
        );
        break;
      case 'rawDecl':
        if (d.lang !== 'c' && d.lang !== 'any') {
          throw new BackendGenError(`Raw ${d.lang} block cannot be emitted into a C file.`, {
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

  private paramList(params: IrParam[]): string {
    return params.length ? params.map((p) => this.param(p)).join(', ') : 'void';
  }

  private param(p: IrParam): string {
    return `${this.type(p.type)} ${this.name(p.name)}`;
  }

  private structHeader(w: CodeWriter, c: IrClass): void {
    w.blank();
    if (c.doc?.trim()) for (const l of wrapText(c.doc.trim())) w.line(`/* ${l} */`);
    w.line('typedef struct {');
    w.nest(() => {
      for (const f of c.fields) {
        w.line(`${this.type(f.type)} ${this.name(f.name)};${f.doc ? `  /* ${f.doc} */` : ''}`);
      }
      if (!c.fields.length) w.line('char _unused;  /* C forbids an empty struct */');
    });
    w.line(`} ${this.typeName(c.name)};`);
    for (const m of c.methods) {
      const params = [`${this.typeName(c.name)}* self`, ...m.params.map((p) => this.param(p))];
      w.line(`${this.type(m.returns)} ${snake(c.name)}_${this.name(m.name)}(${params.join(', ')});`);
    }
  }

  private enumHeader(w: CodeWriter, e: IrEnum): void {
    w.blank();
    if (e.doc?.trim()) w.line(`/* ${e.doc.trim()} */`);
    w.line('typedef enum {');
    w.nest(() => e.variants.forEach((v) => w.line(`${screamingSnake(e.name)}_${screamingSnake(v.name)},`)));
    w.line(`} ${this.typeName(e.name)};`);
  }

  override builtin(e: Extract<IrExpr, { k: 'builtin' }>): string {
    const a = e.args.map((x) => this.expr(x, 17));
    switch (e.op) {
      case 'print':
        return `mc_print(${a.length}${a.length ? ', ' : ''}${a.map((x) => `mc_to_text_any(${x})`).join(', ')})`;
      case 'print_err':
        return `mc_print_err(${a.length}${a.length ? ', ' : ''}${a.map((x) => `mc_to_text_any(${x})`).join(', ')})`;
      case 'read_line':
        return 'mc_read_line()';
      case 'to_string':
        return `mc_to_text_any(${a[0]})`;
      case 'to_int':
        return `(int64_t) mc_to_number(${a[0]})`;
      case 'to_float':
        return `mc_to_number(${a[0]})`;
      case 'parse_int':
        return `mc_parse_int(${a[0]})`;
      case 'parse_float':
        return `mc_parse_float(${a[0]})`;
      case 'len':
        return `mc_length(${a[0]})`;
      case 'is_empty':
        return `(mc_length(${a[0]}) == 0)`;
      case 'str_concat':
        return `mc_concat(${a[0]}, ${a[1]})`;
      case 'str_upper':
        return `mc_upper(${a[0]})`;
      case 'str_lower':
        return `mc_lower(${a[0]})`;
      case 'str_trim':
        return `mc_trim(${a[0]})`;
      case 'str_split':
        return `mc_split(${a[0]}, ${a[1]})`;
      case 'str_join':
        return `mc_join(${a[0]}, ${a[1]})`;
      case 'str_replace':
        return `mc_replace(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'str_contains':
        return `(strstr(${a[0]}, ${a[1]}) != NULL)`;
      case 'str_starts_with':
        return `mc_starts_with(${a[0]}, ${a[1]})`;
      case 'str_ends_with':
        return `mc_ends_with(${a[0]}, ${a[1]})`;
      case 'str_index_of':
        return `mc_index_of(${a[0]}, ${a[1]})`;
      case 'str_substring':
        return `mc_substring(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'str_char_at':
        return `mc_substring(${a[0]}, ${a[1]}, (${a[1]}) + 1)`;
      case 'str_repeat':
        return `mc_repeat(${a[0]}, ${a[1]})`;
      case 'str_pad_left':
        return `mc_pad_left(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'format':
        return `mc_format(${a[0]}, ${a.length - 1}${a.length > 1 ? ', ' : ''}${a.slice(1).map((x) => `mc_to_text_any(${x})`).join(', ')})`;
      case 'list_new':
        return 'mc_list_new()';
      case 'list_get':
        return `mc_list_get(${a[0]}, ${a[1]})`;
      case 'list_set':
        return `mc_list_set(${a[0]}, ${a[1]}, (void*)(${a[2]}))`;
      case 'list_push':
        return `mc_list_push(${a[0]}, (void*)(${a[1]}))`;
      case 'list_pop':
        return `mc_list_pop(${a[0]})`;
      case 'list_contains':
        return `mc_list_contains_text(${a[0]}, ${a[1]})`;
      case 'list_index_of':
        return `mc_list_index_of_text(${a[0]}, ${a[1]})`;
      case 'list_range':
        return `mc_range(${a[0]}, ${a[1]})`;
      case 'map_new':
        return 'mc_map_new()';
      case 'map_get':
        return `mc_map_get(${a[0]}, ${a[1]})`;
      case 'map_get_or':
        return `mc_map_get_or(${a[0]}, ${a[1]}, (void*)(${a[2]}))`;
      case 'map_set':
        return `mc_map_set(${a[0]}, ${a[1]}, (void*)(${a[2]}))`;
      case 'map_has':
        return `mc_map_has(${a[0]}, ${a[1]})`;
      case 'map_remove':
        return `mc_map_remove(${a[0]}, ${a[1]})`;
      case 'map_keys':
        return `mc_map_keys(${a[0]})`;
      case 'map_values':
        return `mc_map_values(${a[0]})`;
      case 'math_abs':
        this.include('math.h');
        return `fabs(${a[0]})`;
      case 'math_floor':
        this.include('math.h');
        return `(int64_t) floor(${a[0]})`;
      case 'math_ceil':
        this.include('math.h');
        return `(int64_t) ceil(${a[0]})`;
      case 'math_round':
        this.include('math.h');
        return `(int64_t) llround(${a[0]})`;
      case 'math_sqrt':
        this.include('math.h');
        return `sqrt(${a[0]})`;
      case 'math_pow':
        this.include('math.h');
        return `pow(${a[0]}, ${a[1]})`;
      case 'math_min':
        return `mc_min(${a[0]}, ${a[1]})`;
      case 'math_max':
        return `mc_max(${a[0]}, ${a[1]})`;
      case 'math_log':
        this.include('math.h');
        return `log(${a[0]})`;
      case 'math_exp':
        this.include('math.h');
        return `exp(${a[0]})`;
      case 'math_sin':
        this.include('math.h');
        return `sin(${a[0]})`;
      case 'math_cos':
        this.include('math.h');
        return `cos(${a[0]})`;
      case 'math_tan':
        this.include('math.h');
        return `tan(${a[0]})`;
      case 'math_atan2':
        this.include('math.h');
        return `atan2(${a[0]}, ${a[1]})`;
      case 'math_idiv':
        return `(${a[0]} / ${a[1]})`;
      case 'math_pi':
        return '3.14159265358979323846';
      case 'file_read_text':
        return `mc_read_text(${a[0]})`;
      case 'file_write_text':
        return `mc_write_text(${a[0]}, ${a[1]})`;
      case 'file_append_text':
        return `mc_append_text(${a[0]}, ${a[1]})`;
      case 'file_exists':
        return `mc_file_exists(${a[0]})`;
      case 'file_delete':
        return `remove(${a[0]})`;
      case 'path_join':
        return `mc_path_join(${a[0]}, ${a[1]})`;
      case 'env_get':
        return `getenv(${a[0]})`;
      case 'args_get':
        return 'mc_args()';
      case 'time_now_ms':
        return 'mc_now_ms()';
      case 'time_sleep_ms':
        return `mc_sleep_ms(${a[0]})`;
      case 'random_float':
        return 'mc_random_float()';
      case 'random_int':
        return `mc_random_int(${a[0]}, ${a[1]})`;
      case 'error_new':
        return a[0];
      case 'error_message':
        return a[0];
      case 'assert':
        return `mc_check(${a[0]}, ${a[1]})`;
      case 'assert_eq':
        return `mc_check_equal(mc_to_text_any(${a[0]}), mc_to_text_any(${a[1]}), ${a[2]})`;
      default:
        throw new BackendGenError(
          `The C adapter does not implement "${e.op}". Use a Custom Code node, or pick a language with a richer standard library.`,
          { code: 'codegen/unsupported-builtin', origin: e.origin },
        );
    }
  }
}

function endsWithReturn(body: IrStmt[]): boolean {
  const last = body[body.length - 1];
  return !!last && (last.k === 'return' || last.k === 'throw');
}

export function headerOf(path: string): string {
  return path.replace(/\.c$/, '.h');
}

export const cBackend: LanguageBackend = {
  id: 'c',
  name: 'C (C11)',
  maturity: 'generates',
  extensions: ['.c', '.h'],
  features: defaultFeatures({
    classes: false,
    interfaces: false,
    inheritance: false,
    generics: false,
    closures: false,
    exceptions: false,
    async: false,
    managedMemory: false,
    compiled: true,
  }),
  lineComment: '//',
  blockComment: { open: '/*', close: '*/' },
  indent: '    ',
  keywords: KEYWORDS,

  packageManager: {
    id: 'vcpkg',
    name: 'vcpkg / system packages',
    installAll: { label: 'vcpkg install', command: 'vcpkg', args: ['install'] },
    installOne: { label: 'vcpkg install', command: 'vcpkg', args: ['install', '{name}'] },
    manifestFile: 'vcpkg.json',
  },

  toolchain: [
    { command: 'cc', versionArgs: ['--version'], installHint: 'Install GCC, Clang, or MSVC build tools.' },
    { command: 'cmake', versionArgs: ['--version'], installHint: 'Install CMake 3.20+ from cmake.org.' },
  ],

  entry: { file: 'src/main.c', symbol: 'main', description: 'A translation unit with int main().' },

  sourceRoot: () => 'src',
  testRoot: () => 'tests',
  pathFor: (file) => file.path,

  mapType(type, project) {
    return new CEmitter(scratchContext(project, 'c')).type(type);
  },

  importFor(_from, to) {
    return `#include "${headerOf(`${to.path}.c`)}"`;
  },

  emitModule(ctx) {
    return new CEmitter(ctx).emit();
  },

  emitProjectFiles(project, program) {
    const sources = program.modules.map((m) => `${m.path}.c`);
    return [
      {
        path: 'CMakeLists.txt',
        role: 'build',
        content: [
          'cmake_minimum_required(VERSION 3.20)',
          `project(${project.name.replace(/[^A-Za-z0-9_]/g, '_')} VERSION ${project.version.split('-')[0]} LANGUAGES C)`,
          '',
          'set(CMAKE_C_STANDARD 11)',
          'set(CMAKE_C_STANDARD_REQUIRED ON)',
          'set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)',
          '',
          'add_executable(app',
          ...['src/mcruntime.c', ...sources].map((s) => `    ${s}`),
          ')',
          '',
          'target_include_directories(app PRIVATE src)',
          'if(NOT MSVC)',
          '    target_link_libraries(app PRIVATE m)',
          'endif()',
          '',
        ].join('\n'),
      },
      { path: 'src/mcruntime.h', role: 'source', content: C_RUNTIME_H },
      { path: 'src/mcruntime.c', role: 'source', content: C_RUNTIME_C },
    ];
  },

  buildPlan(_project, mode: BuildMode): BuildPlan {
    return {
      steps: [
        {
          label: 'CMake configure',
          command: 'cmake',
          args: ['-S', '.', '-B', 'build', `-DCMAKE_BUILD_TYPE=${mode === 'release' ? 'Release' : 'Debug'}`],
        },
        { label: 'CMake build', command: 'cmake', args: ['--build', 'build'] },
      ],
      artifact: 'build/bin/app',
    };
  },

  runPlan: () => ({ command: { label: 'Run', command: 'build/bin/app', args: [] } }),
  testPlan: () => null,
  parseDiagnostics: (output) => cppLikeDiagnostics(output),
};

/** Header emission, exposed so the code generator can write both halves. */
export function emitCHeader(ctx: EmitContext): string {
  return new CEmitter(ctx).emitHeader();
}

export function cHeaderPathFor(file: ProjectFile): string {
  return headerOf(file.path);
}

function cppLikeDiagnostics(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /^(.+?\.[ch]):(\d+):(\d+):\s*(error|warning):\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    out.push({
      severity: m[4] === 'error' ? 'error' : 'warning',
      stage: 'build',
      code: `c/${m[4]}`,
      message: m[5].trim(),
      file: m[1].replace(/\\/g, '/'),
      line: Number(m[2]),
      column: Number(m[3]),
      raw: m[0],
    });
  }
  return out;
}

const C_RUNTIME_H = `/* Runtime helpers used by generated Master Code programs.
 * This file is generated. Edit the graph, not this. */
#ifndef MC_RUNTIME_H
#define MC_RUNTIME_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* A growable array of pointers. Elements are borrowed, not owned. */
typedef struct mc_list mc_list;

/* A string-keyed association list. Small and predictable rather than fast. */
typedef struct mc_map mc_map;

typedef struct {
    unsigned char* data;
    size_t length;
} mc_bytes;

typedef struct {
    int64_t status;
    const char* body;
} mc_http_response;

void mc_set_args(int argc, char** argv);
mc_list* mc_args(void);

void mc_print(int count, ...);
void mc_print_err(int count, ...);
const char* mc_read_line(void);

const char* mc_to_text_any(const void* value);
double mc_to_number(const char* text);
int64_t mc_parse_int(const char* text);
double mc_parse_float(const char* text);

int64_t mc_length(const void* value);
const char* mc_concat(const char* a, const char* b);
const char* mc_upper(const char* text);
const char* mc_lower(const char* text);
const char* mc_trim(const char* text);
mc_list* mc_split(const char* text, const char* separator);
const char* mc_join(mc_list* parts, const char* separator);
const char* mc_replace(const char* text, const char* find, const char* with);
bool mc_starts_with(const char* text, const char* prefix);
bool mc_ends_with(const char* text, const char* suffix);
int64_t mc_index_of(const char* text, const char* needle);
const char* mc_substring(const char* text, int64_t start, int64_t end);
const char* mc_repeat(const char* text, int64_t times);
const char* mc_pad_left(const char* text, int64_t width, const char* fill);
const char* mc_format(const char* tmpl, int count, ...);

mc_list* mc_list_new(void);
mc_list* mc_list_of(int count, ...);
void mc_list_push(mc_list* list, void* value);
void* mc_list_get(mc_list* list, int64_t index);
void mc_list_set(mc_list* list, int64_t index, void* value);
void* mc_list_pop(mc_list* list);
int64_t mc_list_len(mc_list* list);
bool mc_list_contains_text(mc_list* list, const char* value);
int64_t mc_list_index_of_text(mc_list* list, const char* value);
mc_list* mc_range(int64_t start, int64_t end);

mc_map* mc_map_new(void);
mc_map* mc_map_of(int count, ...);
void mc_map_set(mc_map* map, const char* key, void* value);
void* mc_map_get(mc_map* map, const char* key);
void* mc_map_get_or(mc_map* map, const char* key, void* fallback);
bool mc_map_has(mc_map* map, const char* key);
void mc_map_remove(mc_map* map, const char* key);
mc_list* mc_map_keys(mc_map* map);
mc_list* mc_map_values(mc_map* map);

const char* mc_read_text(const char* path);
void mc_write_text(const char* path, const char* text);
void mc_append_text(const char* path, const char* text);
bool mc_file_exists(const char* path);
const char* mc_path_join(const char* a, const char* b);

int64_t mc_now_ms(void);
void mc_sleep_ms(int64_t millis);
double mc_random_float(void);
int64_t mc_random_int(int64_t low, int64_t high);
double mc_min(double a, double b);
double mc_max(double a, double b);

void mc_check(bool condition, const char* message);
void mc_check_equal(const char* actual, const char* expected, const char* message);
void mc_fail(const char* message);

#endif /* MC_RUNTIME_H */
`;

const C_RUNTIME_C = `/* Runtime helpers used by generated Master Code programs.
 * This file is generated. Edit the graph, not this.
 *
 * Strings returned by these helpers are allocated from an arena that lives for
 * the lifetime of the process. That trades memory for the absence of ownership
 * rules in the generated code, which is the right trade for generated programs
 * of this size; long-running services should use Custom Code nodes instead. */
#include "mcruntime.h"

#include <ctype.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

struct mc_list {
    void** items;
    int64_t length;
    int64_t capacity;
};

typedef struct mc_entry {
    char* key;
    void* value;
    struct mc_entry* next;
} mc_entry;

struct mc_map {
    mc_entry* head;
};

static char** g_arena = NULL;
static size_t g_arena_len = 0;
static size_t g_arena_cap = 0;
static mc_list* g_args = NULL;

static char* arena_take(char* text) {
    if (g_arena_len == g_arena_cap) {
        g_arena_cap = g_arena_cap ? g_arena_cap * 2 : 64;
        g_arena = (char**) realloc(g_arena, g_arena_cap * sizeof(char*));
    }
    g_arena[g_arena_len++] = text;
    return text;
}

static char* arena_copy(const char* text) {
    if (!text) return arena_take(strdup(""));
    return arena_take(strdup(text));
}

void mc_set_args(int argc, char** argv) {
    g_args = mc_list_new();
    for (int i = 1; i < argc; ++i) mc_list_push(g_args, arena_copy(argv[i]));
}

mc_list* mc_args(void) { return g_args ? g_args : mc_list_new(); }

void mc_print(int count, ...) {
    va_list args;
    va_start(args, count);
    for (int i = 0; i < count; ++i) {
        if (i) printf(" ");
        printf("%s", va_arg(args, const char*));
    }
    va_end(args);
    printf("\\n");
}

void mc_print_err(int count, ...) {
    va_list args;
    va_start(args, count);
    for (int i = 0; i < count; ++i) {
        if (i) fprintf(stderr, " ");
        fprintf(stderr, "%s", va_arg(args, const char*));
    }
    va_end(args);
    fprintf(stderr, "\\n");
}

const char* mc_read_line(void) {
    size_t capacity = 128;
    size_t length = 0;
    char* buffer = (char*) malloc(capacity);
    int ch;
    while ((ch = fgetc(stdin)) != EOF && ch != '\\n') {
        if (length + 1 >= capacity) {
            capacity *= 2;
            buffer = (char*) realloc(buffer, capacity);
        }
        buffer[length++] = (char) ch;
    }
    if (length && buffer[length - 1] == '\\r') --length;
    buffer[length] = '\\0';
    return arena_take(buffer);
}

const char* mc_to_text_any(const void* value) {
    return value ? (const char*) value : "";
}

double mc_to_number(const char* text) { return text ? atof(text) : 0.0; }

int64_t mc_parse_int(const char* text) { return text ? (int64_t) strtoll(text, NULL, 10) : 0; }

double mc_parse_float(const char* text) { return text ? strtod(text, NULL) : 0.0; }

int64_t mc_length(const void* value) {
    return value ? (int64_t) strlen((const char*) value) : 0;
}

const char* mc_concat(const char* a, const char* b) {
    size_t size = strlen(a) + strlen(b) + 1;
    char* out = (char*) malloc(size);
    snprintf(out, size, "%s%s", a, b);
    return arena_take(out);
}

const char* mc_upper(const char* text) {
    char* out = strdup(text);
    for (char* p = out; *p; ++p) *p = (char) toupper((unsigned char) *p);
    return arena_take(out);
}

const char* mc_lower(const char* text) {
    char* out = strdup(text);
    for (char* p = out; *p; ++p) *p = (char) tolower((unsigned char) *p);
    return arena_take(out);
}

const char* mc_trim(const char* text) {
    while (*text && isspace((unsigned char) *text)) ++text;
    size_t length = strlen(text);
    while (length && isspace((unsigned char) text[length - 1])) --length;
    char* out = (char*) malloc(length + 1);
    memcpy(out, text, length);
    out[length] = '\\0';
    return arena_take(out);
}

mc_list* mc_split(const char* text, const char* separator) {
    mc_list* out = mc_list_new();
    if (!separator || !*separator) {
        mc_list_push(out, arena_copy(text));
        return out;
    }
    const char* start = text;
    const char* found;
    size_t step = strlen(separator);
    while ((found = strstr(start, separator)) != NULL) {
        size_t length = (size_t) (found - start);
        char* piece = (char*) malloc(length + 1);
        memcpy(piece, start, length);
        piece[length] = '\\0';
        mc_list_push(out, arena_take(piece));
        start = found + step;
    }
    mc_list_push(out, arena_copy(start));
    return out;
}

const char* mc_join(mc_list* parts, const char* separator) {
    size_t total = 1;
    for (int64_t i = 0; i < mc_list_len(parts); ++i) {
        total += strlen((const char*) mc_list_get(parts, i)) + strlen(separator);
    }
    char* out = (char*) malloc(total);
    out[0] = '\\0';
    for (int64_t i = 0; i < mc_list_len(parts); ++i) {
        if (i) strcat(out, separator);
        strcat(out, (const char*) mc_list_get(parts, i));
    }
    return arena_take(out);
}

const char* mc_replace(const char* text, const char* find, const char* with) {
    if (!find || !*find) return arena_copy(text);
    mc_list* parts = mc_split(text, find);
    return mc_join(parts, with);
}

bool mc_starts_with(const char* text, const char* prefix) {
    return strncmp(text, prefix, strlen(prefix)) == 0;
}

bool mc_ends_with(const char* text, const char* suffix) {
    size_t a = strlen(text);
    size_t b = strlen(suffix);
    return b <= a && strcmp(text + a - b, suffix) == 0;
}

int64_t mc_index_of(const char* text, const char* needle) {
    const char* found = strstr(text, needle);
    return found ? (int64_t) (found - text) : -1;
}

const char* mc_substring(const char* text, int64_t start, int64_t end) {
    int64_t size = (int64_t) strlen(text);
    if (start < 0) start = 0;
    if (start > size) start = size;
    if (end < start) end = start;
    if (end > size) end = size;
    size_t length = (size_t) (end - start);
    char* out = (char*) malloc(length + 1);
    memcpy(out, text + start, length);
    out[length] = '\\0';
    return arena_take(out);
}

const char* mc_repeat(const char* text, int64_t times) {
    size_t unit = strlen(text);
    size_t total = unit * (size_t) (times > 0 ? times : 0) + 1;
    char* out = (char*) malloc(total);
    out[0] = '\\0';
    for (int64_t i = 0; i < times; ++i) strcat(out, text);
    return arena_take(out);
}

const char* mc_pad_left(const char* text, int64_t width, const char* fill) {
    if (!fill || !*fill) return arena_copy(text);
    size_t total = (size_t) (width > 0 ? width : 0) + strlen(text) + strlen(fill) + 1;
    char* out = (char*) malloc(total);
    out[0] = '\\0';
    while ((int64_t) (strlen(out) + strlen(text)) < width) strcat(out, fill);
    strcat(out, text);
    return arena_take(out);
}

const char* mc_format(const char* tmpl, int count, ...) {
    va_list args;
    va_start(args, count);
    size_t total = strlen(tmpl) + 1;
    const char** values = (const char**) malloc(sizeof(char*) * (size_t) (count > 0 ? count : 1));
    for (int i = 0; i < count; ++i) {
        values[i] = va_arg(args, const char*);
        total += strlen(values[i]);
    }
    va_end(args);

    char* out = (char*) malloc(total + 1);
    size_t written = 0;
    int index = 0;
    for (size_t i = 0; tmpl[i]; ++i) {
        if (tmpl[i] == '{' && tmpl[i + 1] == '}') {
            const char* value = index < count ? values[index++] : "{}";
            size_t length = strlen(value);
            memcpy(out + written, value, length);
            written += length;
            ++i;
            continue;
        }
        out[written++] = tmpl[i];
    }
    out[written] = '\\0';
    free(values);
    return arena_take(out);
}

mc_list* mc_list_new(void) {
    mc_list* list = (mc_list*) calloc(1, sizeof(mc_list));
    return list;
}

mc_list* mc_list_of(int count, ...) {
    mc_list* list = mc_list_new();
    va_list args;
    va_start(args, count);
    for (int i = 0; i < count; ++i) mc_list_push(list, va_arg(args, void*));
    va_end(args);
    return list;
}

void mc_list_push(mc_list* list, void* value) {
    if (list->length == list->capacity) {
        list->capacity = list->capacity ? list->capacity * 2 : 8;
        list->items = (void**) realloc(list->items, (size_t) list->capacity * sizeof(void*));
    }
    list->items[list->length++] = value;
}

void* mc_list_get(mc_list* list, int64_t index) {
    return (index >= 0 && index < list->length) ? list->items[index] : NULL;
}

void mc_list_set(mc_list* list, int64_t index, void* value) {
    if (index >= 0 && index < list->length) list->items[index] = value;
}

void* mc_list_pop(mc_list* list) {
    return list->length ? list->items[--list->length] : NULL;
}

int64_t mc_list_len(mc_list* list) { return list ? list->length : 0; }

bool mc_list_contains_text(mc_list* list, const char* value) {
    return mc_list_index_of_text(list, value) >= 0;
}

int64_t mc_list_index_of_text(mc_list* list, const char* value) {
    for (int64_t i = 0; i < mc_list_len(list); ++i) {
        const char* item = (const char*) mc_list_get(list, i);
        if (item && value && strcmp(item, value) == 0) return i;
    }
    return -1;
}

mc_list* mc_range(int64_t start, int64_t end) {
    mc_list* out = mc_list_new();
    for (int64_t i = start; i < end; ++i) {
        char buffer[32];
        snprintf(buffer, sizeof(buffer), "%lld", (long long) i);
        mc_list_push(out, arena_copy(buffer));
    }
    return out;
}

mc_map* mc_map_new(void) { return (mc_map*) calloc(1, sizeof(mc_map)); }

mc_map* mc_map_of(int count, ...) {
    mc_map* map = mc_map_new();
    va_list args;
    va_start(args, count);
    for (int i = 0; i < count; ++i) {
        const char* key = va_arg(args, const char*);
        void* value = va_arg(args, void*);
        mc_map_set(map, key, value);
    }
    va_end(args);
    return map;
}

static mc_entry* map_find(mc_map* map, const char* key) {
    for (mc_entry* entry = map->head; entry; entry = entry->next) {
        if (strcmp(entry->key, key) == 0) return entry;
    }
    return NULL;
}

void mc_map_set(mc_map* map, const char* key, void* value) {
    mc_entry* found = map_find(map, key);
    if (found) {
        found->value = value;
        return;
    }
    mc_entry* entry = (mc_entry*) calloc(1, sizeof(mc_entry));
    entry->key = strdup(key);
    entry->value = value;
    entry->next = map->head;
    map->head = entry;
}

void* mc_map_get(mc_map* map, const char* key) {
    mc_entry* found = map_find(map, key);
    return found ? found->value : NULL;
}

void* mc_map_get_or(mc_map* map, const char* key, void* fallback) {
    mc_entry* found = map_find(map, key);
    return found ? found->value : fallback;
}

bool mc_map_has(mc_map* map, const char* key) { return map_find(map, key) != NULL; }

void mc_map_remove(mc_map* map, const char* key) {
    mc_entry** link = &map->head;
    while (*link) {
        if (strcmp((*link)->key, key) == 0) {
            mc_entry* dead = *link;
            *link = dead->next;
            free(dead->key);
            free(dead);
            return;
        }
        link = &(*link)->next;
    }
}

mc_list* mc_map_keys(mc_map* map) {
    mc_list* out = mc_list_new();
    for (mc_entry* entry = map->head; entry; entry = entry->next) mc_list_push(out, entry->key);
    return out;
}

mc_list* mc_map_values(mc_map* map) {
    mc_list* out = mc_list_new();
    for (mc_entry* entry = map->head; entry; entry = entry->next) mc_list_push(out, entry->value);
    return out;
}

const char* mc_read_text(const char* path) {
    FILE* file = fopen(path, "rb");
    if (!file) return "";
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    fseek(file, 0, SEEK_SET);
    char* buffer = (char*) malloc((size_t) size + 1);
    size_t read = fread(buffer, 1, (size_t) size, file);
    buffer[read] = '\\0';
    fclose(file);
    return arena_take(buffer);
}

void mc_write_text(const char* path, const char* text) {
    FILE* file = fopen(path, "wb");
    if (!file) return;
    fputs(text, file);
    fclose(file);
}

void mc_append_text(const char* path, const char* text) {
    FILE* file = fopen(path, "ab");
    if (!file) return;
    fputs(text, file);
    fclose(file);
}

bool mc_file_exists(const char* path) {
    FILE* file = fopen(path, "rb");
    if (!file) return false;
    fclose(file);
    return true;
}

const char* mc_path_join(const char* a, const char* b) {
    size_t size = strlen(a) + strlen(b) + 2;
    char* out = (char*) malloc(size);
    snprintf(out, size, "%s/%s", a, b);
    return arena_take(out);
}

int64_t mc_now_ms(void) { return (int64_t) time(NULL) * 1000; }

void mc_sleep_ms(int64_t millis) {
    clock_t target = clock() + (clock_t) (millis * CLOCKS_PER_SEC / 1000);
    while (clock() < target) {
        /* Portable busy wait; replace with your platform's sleep if it matters. */
    }
}

double mc_random_float(void) { return (double) rand() / ((double) RAND_MAX + 1.0); }

int64_t mc_random_int(int64_t low, int64_t high) {
    if (high <= low) return low;
    return low + (int64_t) (mc_random_float() * (double) (high - low));
}

double mc_min(double a, double b) { return a < b ? a : b; }

double mc_max(double a, double b) { return a > b ? a : b; }

void mc_check(bool condition, const char* message) {
    if (!condition) {
        fprintf(stderr, "assertion failed: %s\\n", message);
        exit(1);
    }
}

void mc_check_equal(const char* actual, const char* expected, const char* message) {
    if (strcmp(actual, expected) != 0) {
        fprintf(stderr, "%s: expected %s, got %s\\n", message, expected, actual);
        exit(1);
    }
}

void mc_fail(const char* message) {
    fprintf(stderr, "error: %s\\n", message);
    exit(1);
}
`;

export { CEmitter };
