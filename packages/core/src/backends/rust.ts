/**
 * Rust backend.
 *
 * Maturity is `full`: `tests/collections.test.ts` compiles and runs generated
 * Rust with cargo and compares its output against Python's, so the claim is
 * checked rather than asserted.
 *
 * The standing limitation is ownership. Graphs that share one value across
 * several consumers can still need adjustment after generation — non-`Copy`
 * values are cloned at argument positions, which keeps the common case
 * compiling, but it is not a borrow checker.
 *
 * Two mappings worth knowing:
 *  - `Throw`/`Try` become `panic!` and `catch_unwind`. Rust's real error idiom
 *    is `Result` + `?`, which does not correspond to the graph's exception
 *    shape; panics do.
 *  - Non-`Copy` values passed as arguments are cloned. Generated code that
 *    compiles beats generated code that is theoretically optimal.
 */

import type { BuildMode, BuildPlan, EmitContext, GeneratedFile, LanguageBackend, RunPlan } from './backend.ts';
import { BackendGenError, defaultFeatures, generatedHeader } from './backend.ts';
import { CLikeEmitter, javaLikeDialect } from './clike.ts';
import { CodeWriter, avoidKeyword, pascal, screamingSnake, snake, wrapText } from './emitter.ts';
import { scratchContext } from './java.ts';
import type { IrClass, IrDecl, IrEnum, IrExpr, IrFunction, IrInterface, IrParam, IrStmt } from '../ir/ir.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project } from '../model/project.ts';
import type { TypeRef } from '../types/types.ts';

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
  'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub',
  'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe',
  'use', 'where', 'while', 'box', 'macro', 'try', 'union',
]);

/** Types Rust copies rather than moves; everything else is cloned on use. */
function isCopy(t: TypeRef): boolean {
  return t.kind === 'primitive' && t.name !== 'string' && t.name !== 'bytes';
}

class RustEmitter extends CLikeEmitter {
  private readonly uses = new Set<string>();

  constructor(ctx: EmitContext) {
    super(
      ctx,
      javaLikeDialect({
        letKeyword: (mutable) => (mutable ? 'let mut' : 'let'),
        typeFirst: false,
        semicolon: true,
        parenthesizedConditions: false,
        elseOnSameLine: true,
        foreach: (v, _t, it, index) =>
          index ? `for (${index}, ${v}) in ${it}.iter().enumerate()` : `for ${v} in ${it}.iter()`,
        forRange: (v, start, end, _step, inclusive) => `for ${v} in ${start}..${inclusive ? '=' : ''}${end}`,
        power: (b, e) => `(${b} as f64).powf(${e} as f64)`,
      }),
      KEYWORDS,
      '    ',
    );
  }

  protected override get langId(): string {
    return 'rust';
  }

  override name(raw: string): string {
    return avoidKeyword(snake(raw), KEYWORDS);
  }

  override typeName(raw: string): string {
    return pascal(raw);
  }

  emit(): string {
    const { module, file, project } = this.ctx;
    const body = new CodeWriter('    ');
    for (const d of module.decls) this.decl(body, d);

    const entry = module.decls.find((d): d is IrFunction => d.k === 'function' && !!d.isEntry);
    if (entry && this.name(entry.name) !== 'main') {
      body.blank();
      body.braced('fn main()', () => body.line(`${this.name(entry.name)}();`));
    }

    const head = new CodeWriter('    ');
    for (const l of generatedHeader(rustBackend, file, project)) head.line(l);
    head.blank();
    if (module.doc) for (const l of wrapText(module.doc)) head.line(`//! ${l}`);
    head.line('#![allow(dead_code, unused_imports, unused_variables, unused_mut)]');
    head.blank();

    // A binary crate root declares the other modules; leaves just use them.
    if (isCrateRoot(file.path)) {
      const mods = this.ctx.program.modules
        .filter((m) => !isCrateRoot(`${m.path}.rs`))
        .map((m) => (m.path.split('/').pop() ?? '').replace(/\.rs$/, ''))
        .filter(Boolean);
      // `mcruntime` is written by emitProjectFiles rather than being an IR
      // module, so it is not in that list — and without a declaration here,
      // every `crate::mcruntime::…` reference fails to resolve. It is always
      // emitted, and `dead_code` is already allowed, so declare it always.
      mods.push('mcruntime');
      for (const m of [...new Set(mods)].sort()) head.line(`mod ${snake(m)};`);
      head.blank();
    }
    for (const u of [...this.uses].sort()) head.line(`use ${u};`);
    for (const imp of module.imports) {
      if (imp.source !== 'file') continue;
      const target = this.ctx.program.modules.find((m) => m.id === imp.target);
      if (!target) continue;
      const mod = snake((target.path.split('/').pop() ?? '').replace(/\.rs$/, ''));
      const syms = imp.symbols?.map((s) => this.symbolName(s.name)) ?? [];
      head.line(syms.length ? `use crate::${mod}::{${syms.join(', ')}};` : `use crate::${mod};`);
    }
    head.blank();
    head.block(body.toString().replace(/\n$/, ''));
    return head.toString();
  }

  private use(path: string): void {
    this.uses.add(path);
  }

  override type(t: TypeRef): string {
    switch (t.kind) {
      case 'void':
      case 'exec':
        return '()';
      case 'any':
        return 'String';
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return 'bool';
          case 'i32':
            return 'i32';
          case 'i64':
            return 'i64';
          case 'f32':
            return 'f32';
          case 'f64':
            return 'f64';
          case 'string':
            return 'String';
          case 'char':
            return 'char';
          case 'bytes':
            return 'Vec<u8>';
        }
        return 'String';
      case 'list':
        return `Vec<${this.type(t.item)}>`;
      case 'set':
        this.use('std::collections::HashSet');
        return `HashSet<${this.type(t.item)}>`;
      case 'map':
        this.use('std::collections::BTreeMap');
        return `BTreeMap<${this.type(t.key)}, ${this.type(t.value)}>`;
      case 'option':
        return `Option<${this.type(t.inner)}>`;
      case 'tuple':
        return `(${t.items.map((i) => this.type(i)).join(', ')})`;
      case 'future':
        return `std::pin::Pin<Box<dyn std::future::Future<Output = ${this.type(t.inner)}>>>`;
      case 'result':
        return `Result<${this.type(t.ok)}, ${this.type(t.err)}>`;
      case 'function':
        return `Box<dyn Fn(${t.params.map((p) => this.type(p)).join(', ')}) -> ${this.type(t.returns)}>`;
      case 'named':
        switch (t.name) {
          case 'Error':
            return 'String';
          case 'Json':
            return 'String';
          case 'HttpResponse':
            return 'crate::mcruntime::HttpResponse';
          case 'DbConnection':
            return 'crate::mcruntime::Db';
          case 'Element':
            throw new BackendGenError('DOM types have no Rust equivalent.', { code: 'codegen/dom-in-rust' });
          default:
            return this.resolvedType(t.name);
        }
      case 'var':
        return 'String';
    }
  }

  override zero(t: TypeRef): string {
    switch (t.kind) {
      case 'primitive':
        if (t.name === 'bool') return 'false';
        if (t.name === 'string') return 'String::new()';
        if (t.name === 'char') return "' '";
        if (t.name === 'f32' || t.name === 'f64') return '0.0';
        if (t.name === 'bytes') return 'Vec::new()';
        return '0';
      case 'list':
        return 'Vec::new()';
      case 'set':
      case 'map':
        return `${this.type(t).split('<')[0]}::new()`;
      case 'option':
        return 'None';
      case 'void':
        return '()';
      case 'tuple':
        return `(${t.items.map((i) => this.zero(i)).join(', ')})`;
      default:
        return 'Default::default()';
    }
  }

  protected override letStatement(s: Extract<IrStmt, { k: 'let' }>): string {
    const init = s.init ? this.expr(s.init) : this.zero(s.type);
    const kw = s.mutable === false ? 'let' : 'let mut';
    return `${kw} ${this.name(s.name)}: ${this.type(s.type)} = ${init}`;
  }

  protected override throwStatement(value: IrExpr): string {
    return `panic!("{}", ${this.expr(value)})`;
  }

  protected override tryStmt(w: CodeWriter, s: Extract<IrStmt, { k: 'try' }>): void {
    const c = s.catches[0];
    w.line('// Rust has no exceptions; a caught panic is the closest equivalent.');
    w.line('let _caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {');
    w.nest(() => this.emitBody(w, s.body));
    w.line('}));');
    if (c) {
      w.braced('if let Err(payload) = _caught', () => {
        w.line(
          `let ${this.name(c.varName)}: String = payload.downcast_ref::<String>().cloned()` +
            `.unwrap_or_else(|| "panic".to_string());`,
        );
        this.emitBody(w, c.body);
      });
    }
    if (s.finally?.length) this.emitBody(w, s.finally);
  }

  protected override switchStmt(w: CodeWriter, s: Extract<IrStmt, { k: 'switch' }>): void {
    w.braced(`match ${this.expr(s.subject)}`, () => {
      for (const c of s.cases) {
        w.line(`${c.match.map((m) => this.expr(m)).join(' | ')} => {`);
        w.nest(() => this.emitBody(w, c.body));
        w.line('}');
      }
      w.line('_ => {');
      w.nest(() => this.emitBody(w, s.default ?? []));
      w.line('}');
    });
  }

  protected override exprInner(e: IrExpr): string {
    if (e.k === 'ternary') {
      return `if ${this.expr(e.cond)} { ${this.expr(e.then)} } else { ${this.expr(e.else)} }`;
    }
    if (e.k === 'ref' && !isCopy(e.type)) {
      // Conservative: clone rather than risk a move that breaks a later use.
      return `${this.name(e.name)}.clone()`;
    }
    if (e.k === 'lit' && e.value.t === 'string') {
      return `${super.exprInner(e)}.to_string()`;
    }
    if (e.k === 'new') {
      return `${this.typeName(e.className)}::new(${e.args.map((a) => this.expr(a)).join(', ')})`;
    }
    return super.exprInner(e);
  }

  protected override selfKeyword(): string {
    return 'self';
  }

  protected override memberName(name: string): string {
    return this.name(name);
  }

  protected override arrayLit(e: Extract<IrExpr, { k: 'array' }>): string {
    return `vec![${e.items.map((i) => this.expr(i)).join(', ')}]`;
  }

  protected override mapLit(e: Extract<IrExpr, { k: 'mapLit' }>): string {
    this.use('std::collections::BTreeMap');
    if (!e.entries.length) return 'BTreeMap::new()';
    const pairs = e.entries.map((en) => `(${this.expr(en.key)}, ${this.expr(en.value)})`).join(', ');
    return `BTreeMap::from([${pairs}])`;
  }

  protected override lambda(e: Extract<IrExpr, { k: 'lambda' }>): string {
    const params = e.params.map((p) => `${this.name(p.name)}: ${this.type(p.type)}`).join(', ');
    if (!Array.isArray(e.body)) return `Box::new(move |${params}| ${this.expr(e.body)})`;
    const inner = new CodeWriter('    ');
    this.emitBody(inner, e.body);
    return `Box::new(move |${params}| {\n${inner.toString().replace(/\n$/, '')}\n})`;
  }

  protected override cast(e: Extract<IrExpr, { k: 'cast' }>): string {
    const inner = this.expr(e.expr, 13);
    if (e.to.kind === 'primitive' && e.to.name === 'string') return `format!("{:?}", ${inner})`;
    if (e.to.kind === 'primitive') return `(${inner} as ${this.type(e.to)})`;
    return inner;
  }

  private decl(w: CodeWriter, d: IrDecl): void {
    switch (d.k) {
      case 'function':
        this.fnDecl(w, d);
        break;
      case 'class':
        this.structDecl(w, d);
        break;
      case 'interface':
        this.traitDecl(w, d);
        break;
      case 'enum':
        this.enumDecl(w, d);
        break;
      case 'global':
        w.blank();
        if (d.doc) w.line(`/// ${d.doc}`);
        w.line(
          `pub static ${screamingSnake(d.name)}: ${this.type(d.type)} = ${d.init ? this.expr(d.init) : this.zero(d.type)};`,
        );
        break;
      case 'typeAlias':
        w.blank();
        w.line(`pub type ${this.typeName(d.name)} = ${this.type(d.target)};`);
        break;
      case 'rawDecl':
        if (d.lang !== 'rust' && d.lang !== 'any') {
          throw new BackendGenError(`Raw ${d.lang} block cannot be emitted into a Rust file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: d.origin,
          });
        }
        w.blank();
        w.verbatim(d.code);
        break;
    }
  }

  private fnDecl(w: CodeWriter, f: IrFunction, inImpl = false): void {
    w.blank();
    if (f.doc?.trim()) for (const l of wrapText(f.doc.trim())) w.line(`/// ${l}`);
    const vis = f.visibility === 'private' ? '' : 'pub ';
    const asyncKw = f.isAsync ? 'async ' : '';
    const selfParam = inImpl && !f.isStatic ? ['&mut self'] : [];
    const params = [...selfParam, ...f.params.map((p) => this.declParam(p))].join(', ');
    const ret = f.returns.kind === 'void' ? '' : ` -> ${this.type(f.returns)}`;
    w.braced(`${vis}${asyncKw}fn ${this.name(f.name)}(${params})${ret}`, () => {
      this.emitBody(w, f.body);
      if (f.returns.kind !== 'void' && !endsWithReturn(f.body)) w.line(this.zero(f.returns));
    });
  }

  private declParam(p: IrParam): string {
    return `${this.name(p.name)}: ${this.type(p.type)}`;
  }

  private structDecl(w: CodeWriter, c: IrClass): void {
    w.blank();
    if (c.doc?.trim()) for (const l of wrapText(c.doc.trim())) w.line(`/// ${l}`);
    w.line('#[derive(Debug, Clone, Default)]');
    w.line(`pub struct ${this.typeName(c.name)} {`);
    w.nest(() => {
      for (const f of c.fields) {
        if (f.doc) w.line(`/// ${f.doc}`);
        w.line(`pub ${this.name(f.name)}: ${this.type(f.type)},`);
      }
    });
    w.line('}');
    w.blank();
    w.braced(`impl ${this.typeName(c.name)}`, () => {
      const ctorParams = c.ctor?.params.map((p) => this.declParam(p)).join(', ') ?? '';
      w.line('/// Construct a new instance.');
      w.braced(`pub fn new(${ctorParams}) -> Self`, () => {
        w.line('let mut self_ = Self::default();');
        if (c.ctor) {
          const rewritten = new CodeWriter('    ');
          this.emitBody(rewritten, c.ctor.body);
          w.block(rewritten.toString().replace(/\bself\./g, 'self_.').replace(/\n$/, ''));
        }
        w.line('self_');
      });
      for (const m of c.methods) this.fnDecl(w, m, true);
    });
  }

  private traitDecl(w: CodeWriter, i: IrInterface): void {
    w.blank();
    if (i.doc?.trim()) for (const l of wrapText(i.doc.trim())) w.line(`/// ${l}`);
    w.braced(`pub trait ${this.typeName(i.name)}`, () => {
      for (const m of i.methods) {
        const params = ['&mut self', ...m.params.map((p) => this.declParam(p))].join(', ');
        const ret = m.returns.kind === 'void' ? '' : ` -> ${this.type(m.returns)}`;
        w.line(`fn ${this.name(m.name)}(${params})${ret};`);
      }
    });
  }

  private enumDecl(w: CodeWriter, e: IrEnum): void {
    w.blank();
    if (e.doc?.trim()) w.line(`/// ${e.doc.trim()}`);
    w.line('#[derive(Debug, Clone, Copy, PartialEq, Eq)]');
    w.line(`pub enum ${this.typeName(e.name)} {`);
    w.nest(() => e.variants.forEach((v) => w.line(`${pascal(v.name)},`)));
    w.line('}');
  }

  /**
   * Renders a value as display text.
   *
   * Rust has no single trait that covers this. `Display` is what you want for a
   * string or a number but `Vec` does not implement it; `Debug` covers
   * everything but puts quotes round strings, which is wrong in output meant
   * for a person. So the choice is made from the static type, which the IR
   * always knows.
   */
  private asText(arg: IrExpr, rendered: string): string {
    const kind = arg.type?.kind;
    if (kind === 'list' || kind === 'set' || kind === 'tuple') {
      return `crate::mcruntime::seq_text(&${rendered})`;
    }
    if (kind === 'map') return `crate::mcruntime::map_text(&${rendered})`;
    if (kind === 'option') return `crate::mcruntime::option_text(&${rendered})`;
    return `format!("{}", ${rendered})`;
  }

  override builtin(e: Extract<IrExpr, { k: 'builtin' }>): string {
    const a = e.args.map((x) => this.expr(x, 17));
    // A closure handed straight to an iterator adaptor needs no parentheses
    // around it. `a` is rendered at high precedence so it is safe as an
    // operand anywhere; that is wrong for a bare method argument, and rustc
    // warns about the redundant parens.
    const fn = (i: number): string => this.expr(e.args[i]!, 0);
    const rt = 'crate::mcruntime';
    switch (e.op) {
      case 'print':
        return a.length ? `println!("${a.map(() => '{}').join(' ')}", ${a.join(', ')})` : 'println!()';
      case 'print_err':
        return a.length ? `eprintln!("${a.map(() => '{}').join(' ')}", ${a.join(', ')})` : 'eprintln!()';
      case 'read_line':
        return `${rt}::read_line()`;
      case 'to_string':
        return this.asText(e.args[0]!, a[0]!);
      case 'to_int':
        return `${rt}::to_float(&${a[0]}) as i64`;
      case 'to_float':
        return `${rt}::to_float(&${a[0]})`;
      case 'parse_int':
        return `${a[0]}.trim().parse::<i64>().ok()`;
      case 'parse_float':
        return `${a[0]}.trim().parse::<f64>().ok()`;
      case 'len':
        return `${a[0]}.len() as i64`;
      case 'is_empty':
        return `${a[0]}.is_empty()`;
      case 'str_concat':
        return `format!("{}{}", ${a[0]}, ${a[1]})`;
      case 'str_upper':
        return `${a[0]}.to_uppercase()`;
      case 'str_lower':
        return `${a[0]}.to_lowercase()`;
      case 'str_trim':
        return `${a[0]}.trim().to_string()`;
      case 'str_split':
        return `${a[0]}.split(&${a[1]}).map(|s| s.to_string()).collect::<Vec<String>>()`;
      case 'str_join':
        return `${a[0]}.join(&${a[1]})`;
      case 'str_replace':
        return `${a[0]}.replace(&${a[1]}, &${a[2]})`;
      case 'str_contains':
        return `${a[0]}.contains(&${a[1]})`;
      case 'str_starts_with':
        return `${a[0]}.starts_with(&${a[1]})`;
      case 'str_ends_with':
        return `${a[0]}.ends_with(&${a[1]})`;
      case 'str_index_of':
        return `${a[0]}.find(&${a[1]}).map(|i| i as i64).unwrap_or(-1)`;
      case 'str_substring':
        return `${rt}::substring(&${a[0]}, ${a[1]}, ${a[2]})`;
      case 'str_char_at':
        return `${rt}::substring(&${a[0]}, ${a[1]}, ${a[1]} + 1)`;
      case 'str_repeat':
        return `${a[0]}.repeat(${a[1]} as usize)`;
      case 'str_pad_left':
        return `${rt}::pad_left(&${a[0]}, ${a[1]}, &${a[2]})`;
      case 'format':
        return `${rt}::format_text(&${a[0]}, &[${e.args
          .slice(1)
          .map((arg, i) => this.asText(arg, a[i + 1]!))
          .join(', ')}])`;
      case 'list_new':
        return 'Vec::new()';
      case 'list_get':
        return `${a[0]}[${a[1]} as usize].clone()`;
      case 'list_set':
        return `${a[0]}[${a[1]} as usize] = ${a[2]}`;
      case 'list_push':
        return `${a[0]}.push(${a[1]})`;
      case 'list_pop':
        return `${a[0]}.pop()`;
      case 'list_insert':
        return `${a[0]}.insert(${a[1]} as usize, ${a[2]})`;
      case 'list_remove_at':
        return `${a[0]}.remove(${a[1]} as usize)`;
      case 'list_contains':
        return `${a[0]}.contains(&${a[1]})`;
      case 'list_index_of':
        return `${a[0]}.iter().position(|x| *x == ${a[1]}).map(|i| i as i64).unwrap_or(-1)`;
      case 'list_slice':
        return `${a[0]}[${a[1]} as usize..${a[2]} as usize].to_vec()`;
      case 'list_concat':
        return `[${a[0]}, ${a[1]}].concat()`;
      case 'list_reverse':
        return `{ let mut v = ${a[0]}; v.reverse(); v }`;

      // Iterator adaptors, collected back into a Vec so the result is the
      // owned list the IR's type says it is. `into_iter` rather than `iter`
      // because the argument is already a value here, and cloning every
      // element to hand it to a closure would be wasteful and un-Rust-like.
      case 'list_map':
        return `${a[0]}.into_iter().map(${fn(1)}).collect::<Vec<_>>()`;
      case 'list_filter':
        // The predicate takes the element by value, so it is cloned for the
        // test and the original moved into the result.
        return `${a[0]}.into_iter().filter(|x| (${a[1]})(x.clone())).collect::<Vec<_>>()`;
      case 'list_reduce':
        return `${a[0]}.into_iter().fold(${a[2]}, ${fn(1)})`;
      case 'list_any':
        return `${a[0]}.into_iter().any(${fn(1)})`;
      case 'list_all':
        return `${a[0]}.into_iter().all(${fn(1)})`;
      case 'list_find':
        return `${a[0]}.into_iter().find(|x| (${a[1]})(x.clone()))`;
      case 'list_sort':
        // `sort_by` with `partial_cmp` rather than `sort`: f64 is only
        // PartialOrd, and this keeps one spelling for every element type.
        return `{ let mut v = ${a[0]}; v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)); v }`;
      case 'list_sort_by':
        return `{ let mut v = ${a[0]}; let k = ${a[1]}; v.sort_by(|a, b| k(a.clone()).partial_cmp(&k(b.clone())).unwrap_or(std::cmp::Ordering::Equal)); v }`;
      case 'list_min':
        return `${a[0]}.iter().map(|x| *x as f64).fold(None::<f64>, |m, x| Some(match m { Some(v) if v < x => v, _ => x }))`;
      case 'list_max':
        return `${a[0]}.iter().map(|x| *x as f64).fold(None::<f64>, |m, x| Some(match m { Some(v) if v > x => v, _ => x }))`;
      case 'list_unique':
        // Order-preserving, and without requiring Hash on the element type —
        // the IR allows any T here, including structs that derive neither.
        return `{ let mut out: Vec<_> = Vec::new(); for x in ${a[0]} { if !out.contains(&x) { out.push(x); } } out }`;
      case 'list_sum':
        // `as f64` per element rather than `sum::<f64>()` directly. The IR
        // widens integers into a numeric slot, so this can legitimately be
        // handed a Vec<i64>, and Rust will not convert implicitly.
        return `${a[0]}.iter().map(|x| *x as f64).sum::<f64>()`;
      case 'list_range':
        return `(${a[0]}..${a[1]}).collect::<Vec<i64>>()`;
      case 'map_new':
        this.use('std::collections::BTreeMap');
        return 'BTreeMap::new()';
      case 'map_get':
        return `${a[0]}.get(&${a[1]}).cloned()`;
      case 'map_get_or':
        return `${a[0]}.get(&${a[1]}).cloned().unwrap_or(${a[2]})`;
      case 'map_set':
        return `${a[0]}.insert(${a[1]}, ${a[2]})`;
      case 'map_has':
        return `${a[0]}.contains_key(&${a[1]})`;
      case 'map_remove':
        return `${a[0]}.remove(&${a[1]})`;
      case 'map_keys':
        return `${a[0]}.keys().cloned().collect::<Vec<_>>()`;
      case 'map_values':
        return `${a[0]}.values().cloned().collect::<Vec<_>>()`;
      case 'set_new':
        this.use('std::collections::HashSet');
        return 'HashSet::new()';
      case 'set_add':
        return `${a[0]}.insert(${a[1]})`;
      case 'set_has':
        return `${a[0]}.contains(&${a[1]})`;
      case 'set_remove':
        return `${a[0]}.remove(&${a[1]})`;
      case 'set_to_list':
        return `${a[0]}.iter().cloned().collect::<Vec<_>>()`;
      case 'math_abs':
        return `(${a[0]} as f64).abs()`;
      case 'math_floor':
        return `(${a[0]} as f64).floor() as i64`;
      case 'math_ceil':
        return `(${a[0]} as f64).ceil() as i64`;
      case 'math_round':
        return `(${a[0]} as f64).round() as i64`;
      case 'math_sqrt':
        return `(${a[0]} as f64).sqrt()`;
      case 'math_pow':
        return `(${a[0]} as f64).powf(${a[1]} as f64)`;
      case 'math_min':
        return `(${a[0]} as f64).min(${a[1]} as f64)`;
      case 'math_max':
        return `(${a[0]} as f64).max(${a[1]} as f64)`;
      case 'math_log':
        return `(${a[0]} as f64).ln()`;
      case 'math_exp':
        return `(${a[0]} as f64).exp()`;
      case 'math_sin':
        return `(${a[0]} as f64).sin()`;
      case 'math_cos':
        return `(${a[0]} as f64).cos()`;
      case 'math_tan':
        return `(${a[0]} as f64).tan()`;
      case 'math_atan2':
        return `(${a[0]} as f64).atan2(${a[1]} as f64)`;
      case 'math_idiv':
        return `${a[0]} / ${a[1]}`;
      case 'math_pi':
        return 'std::f64::consts::PI';
      case 'file_read_text':
        return `std::fs::read_to_string(&${a[0]}).unwrap_or_default()`;
      case 'file_write_text':
        return `std::fs::write(&${a[0]}, &${a[1]}).ok()`;
      case 'file_exists':
        return `std::path::Path::new(&${a[0]}).exists()`;
      case 'dir_create':
        return `std::fs::create_dir_all(&${a[0]}).ok()`;
      case 'file_append_text':
        return `${rt}::append_text(&${a[0]}, &${a[1]})`;
      case 'file_delete':
        return `std::fs::remove_file(&${a[0]}).ok()`;
      case 'dir_list':
        return `${rt}::dir_list(&${a[0]})`;
      case 'path_join':
        return `${rt}::path_join(&${a[0]}, &${a[1]})`;

      // Rust's standard library has no random number generator, and pulling in
      // `rand` would make every generated project depend on a crate it may not
      // want. The runtime carries a small one instead; see the note there.
      case 'random_float':
        return `${rt}::random_float()`;
      case 'random_int':
        return `${rt}::random_int(${a[0]}, ${a[1]})`;
      case 'env_get':
        return `std::env::var(&${a[0]}).ok()`;
      case 'args_get':
        return 'std::env::args().skip(1).collect::<Vec<String>>()';
      case 'time_now_ms':
        return `${rt}::now_ms()`;
      case 'time_sleep_ms':
        return `std::thread::sleep(std::time::Duration::from_millis(${a[0]} as u64))`;
      case 'error_new':
        return a[0];
      case 'error_message':
        return a[0];
      case 'assert':
        return `assert!(${a[0]}, "{}", ${a[1]})`;
      case 'assert_eq':
        return `assert_eq!(${a[0]}, ${a[1]}, "{}", ${a[2]})`;
      default:
        throw new BackendGenError(
          `The Rust backend does not implement "${e.op}". Use a Custom Code node, or extend the Rust adapter.`,
          { code: 'codegen/unsupported-builtin', origin: e.origin },
        );
    }
  }
}

function endsWithReturn(body: IrStmt[]): boolean {
  const last = body[body.length - 1];
  return !!last && (last.k === 'return' || last.k === 'throw');
}

function isCrateRoot(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  return base === 'main.rs' || base === 'lib.rs' || base === 'main';
}

function crateName(project: Project): string {
  return snake(project.name) || 'app';
}

export const rustBackend: LanguageBackend = {
  id: 'rust',
  name: 'Rust',
  maturity: 'full',
  extensions: ['.rs'],
  features: defaultFeatures({ compiled: true, managedMemory: false, exceptions: false, inheritance: false }),
  lineComment: '//',
  blockComment: { open: '/*', close: '*/' },
  indent: '    ',
  keywords: KEYWORDS,

  packageManager: {
    id: 'cargo',
    name: 'Cargo',
    installAll: { label: 'cargo fetch', command: 'cargo', args: ['fetch'] },
    installOne: { label: 'cargo add', command: 'cargo', args: ['add', '{name}@{version}'] },
    manifestFile: 'Cargo.toml',
    lockFile: 'Cargo.lock',
  },

  toolchain: [
    { command: 'cargo', versionArgs: ['--version'], installHint: 'Install Rust with rustup from rustup.rs.' },
    { command: 'rustc', versionArgs: ['--version'], installHint: 'rustc comes with rustup.' },
  ],

  entry: { file: 'src/main.rs', symbol: 'main', description: 'A binary crate root with fn main().' },

  sourceRoot: () => 'src',
  testRoot: () => 'tests',
  pathFor: (file) => file.path,

  mapType(type, project) {
    return new RustEmitter(scratchContext(project, 'rust')).type(type);
  },

  importFor(_from, to, symbols) {
    const mod = snake((to.path.split('/').pop() ?? '').replace(/\.rs$/, ''));
    return symbols.length ? `use crate::${mod}::{${symbols.join(', ')}};` : `use crate::${mod};`;
  },

  emitModule(ctx) {
    return new RustEmitter(ctx).emit();
  },

  emitProjectFiles(project) {
    const deps = project.dependencies.filter((d) => d.language === 'rust');
    return [
      {
        path: 'Cargo.toml',
        role: 'manifest',
        content: [
          '[package]',
          `name = "${crateName(project)}"`,
          `version = "${project.version}"`,
          'edition = "2021"',
          `description = ${JSON.stringify(project.description ?? '')}`,
          '',
          '[dependencies]',
          ...deps.map((d) => `${d.name} = "${d.version === '*' ? '*' : d.version}"`),
          '',
          '# Master Code records dependencies here. Run `cargo fetch` yourself to download them.',
          '',
        ].join('\n'),
      },
      { path: 'src/mcruntime.rs', role: 'source', content: RUST_RUNTIME },
    ];
  },

  buildPlan(_project, mode: BuildMode): BuildPlan {
    return {
      steps: [
        {
          label: `cargo build (${mode})`,
          command: 'cargo',
          args: ['build', ...(mode === 'release' ? ['--release'] : [])],
        },
      ],
      artifact: `target/${mode === 'release' ? 'release' : 'debug'}`,
    };
  },

  runPlan: (_project, mode): RunPlan => ({
    command: { label: 'Run', command: 'cargo', args: ['run', ...(mode === 'release' ? ['--release'] : [])] },
  }),

  testPlan: () => ({ steps: [{ label: 'cargo test', command: 'cargo', args: ['test'] }] }),

  parseDiagnostics(output): Diagnostic[] {
    const out: Diagnostic[] = [];
    // `error[E0308]: mismatched types` then `  --> src/main.rs:12:9`
    const re = /^(error|warning)(?:\[(\w+)\])?:\s*(.+)\n\s*-->\s*(.+?):(\d+):(\d+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output))) {
      out.push({
        severity: m[1] === 'error' ? 'error' : 'warning',
        stage: 'build',
        code: `rustc/${m[2] ?? m[1]}`,
        message: m[3].trim(),
        file: m[4].replace(/\\/g, '/'),
        line: Number(m[5]),
        column: Number(m[6]),
        raw: m[0],
      });
    }
    return out;
  },
};

const RUST_RUNTIME = `//! Runtime helpers used by generated Master Code programs.
//!
//! This file is generated. Edit the graph, not this.

#![allow(dead_code)]

use std::fmt::Display;
use std::io::BufRead;

/// Outcome of an HTTP request. Transport failures arrive as status 0.
#[derive(Debug, Clone, Default)]
pub struct HttpResponse {
    pub status: i64,
    pub body: String,
}

/// Placeholder database handle. Add a driver from the library catalogue to use it.
#[derive(Debug, Clone, Default)]
pub struct Db {
    pub path: String,
}

/// Read one line from standard input, without the trailing newline.
pub fn read_line() -> String {
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        return String::new();
    }
    line.trim_end_matches(['\\r', '\\n']).to_string()
}

/// Best-effort conversion of a printable value to f64.
pub fn to_float(value: &impl Display) -> f64 {
    value.to_string().trim().parse::<f64>().unwrap_or(0.0)
}

/// Slice a string by character offsets, clamped to its length.
pub fn substring(text: &str, start: i64, end: i64) -> String {
    let chars: Vec<char> = text.chars().collect();
    let from = start.clamp(0, chars.len() as i64) as usize;
    let to = end.clamp(from as i64, chars.len() as i64) as usize;
    chars[from..to].iter().collect()
}

/// Pad on the left until the text reaches the given width.
pub fn pad_left(text: &str, width: i64, fill: &str) -> String {
    if fill.is_empty() {
        return text.to_string();
    }
    let mut out = String::new();
    while (out.chars().count() + text.chars().count()) < width as usize {
        out.push_str(fill);
    }
    out + text
}

/// Interpolate {} placeholders in order.
pub fn format_text(template: &str, args: &[String]) -> String {
    let mut out = String::new();
    let mut index = 0usize;
    let chars: Vec<char> = template.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if i + 1 < chars.len() && chars[i] == '{' && chars[i + 1] == '}' {
            if index < args.len() {
                out.push_str(&args[index]);
                index += 1;
            } else {
                out.push_str("{}");
            }
            i += 2;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Renders a list or set the way the other backends do: [1, 2, 3].
pub fn seq_text<T: Display>(items: &[T]) -> String {
    let parts: Vec<String> = items.iter().map(|item| item.to_string()).collect();
    format!("[{}]", parts.join(", "))
}

/// Renders a map as {key: value, ...}, in key order.
pub fn map_text<K: Display + Ord, V: Display>(entries: &std::collections::BTreeMap<K, V>) -> String {
    let parts: Vec<String> = entries.iter().map(|(k, v)| format!("{}: {}", k, v)).collect();
    format!("{{{}}}", parts.join(", "))
}

/// Renders an optional value, with a word rather than a blank for absence.
pub fn option_text<T: Display>(value: &Option<T>) -> String {
    match value {
        Some(inner) => inner.to_string(),
        None => "none".to_string(),
    }
}

/// Appends to a file, creating it when absent.
pub fn append_text(path: &str, text: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(text.as_bytes());
    }
}

/// Names of the entries in a directory, sorted so output is reproducible.
pub fn dir_list(path: &str) -> Vec<String> {
    let mut out: Vec<String> = match std::fs::read_dir(path) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort();
    out
}

/// Joins two path segments with the platform separator.
pub fn path_join(base: &str, part: &str) -> String {
    std::path::Path::new(base).join(part).to_string_lossy().to_string()
}

// -- random -------------------------------------------------------------------
//
// A xorshift64* generator, seeded from the clock and the address of a local.
//
// This exists because Rust's standard library has no RNG and the alternative
// is making every generated project depend on the rand crate. It is fine for
// sampling, shuffling and test data. It is NOT suitable for anything security
// related — keys, tokens, passwords. Use a real CSPRNG for those.

use std::cell::Cell;

thread_local! {
    static RNG_STATE: Cell<u64> = Cell::new(0);
}

fn next_u64() -> u64 {
    RNG_STATE.with(|state| {
        let mut x = state.get();
        if x == 0 {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0x9E3779B97F4A7C15);
            let local = 0u8;
            x = nanos ^ (&local as *const u8 as u64).rotate_left(17);
            if x == 0 {
                x = 0x9E3779B97F4A7C15;
            }
        }
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        state.set(x);
        x.wrapping_mul(0x2545F4914F6CDD1D)
    })
}

/// A value in [0, 1).
pub fn random_float() -> f64 {
    // 53 bits is the most an f64 can hold exactly.
    (next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

/// An integer in [low, high). Returns low when the range is empty.
pub fn random_int(low: i64, high: i64) -> i64 {
    if high <= low {
        return low;
    }
    let span = (high - low) as u64;
    low + (next_u64() % span) as i64
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
`;

export { RustEmitter };
