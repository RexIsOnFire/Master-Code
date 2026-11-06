/**
 * Shared helpers for authoring Draken.
 *
 * Draken is a Kotlin/Android project written as Master Code graphs. Every file
 * here becomes a graph of real declaration nodes - classes, records, sealed
 * types, interfaces, functions - and the bodies the visual vocabulary cannot
 * draw are Custom Function nodes holding Kotlin. Everything goes through
 * GraphBuilder, so the result is a project the editor could have produced.
 *
 * Two problems the SOAR kit met are solved here once:
 *
 *  - **Escaping.** Kotlin uses `${...}` and backslash escapes; both mean
 *    something to a TypeScript template literal. The `kt` tag keeps the raw
 *    text, and turns `\${` back into `${`, so a body reads as Kotlin.
 *  - **Imports.** A Custom body is opaque to the generator, and Kotlin has no
 *    function-local imports. `wireImports` reads every body, signature and
 *    annotation in a file, resolves each name against the project's own
 *    declarations and a table of library names, and records the result as a
 *    Library Imports node on the file's graph - visible, and checked.
 */

import type { NodeRegistry } from '#core/nodes/definition.ts';
import type { GraphNode, Project, ProjectFile, ProjectModule } from '#core/model/project.ts';
import { GraphBuilder, addFile } from '#core/project/builder.ts';
import { camel, pascal } from '#core/backends/emitter.ts';
import type { KotlinSettings } from '#core/backends/kotlin.ts';
import { LIBRARY_NAMES } from './library-names.ts';

export interface Ctx {
  project: Project;
  registry: NodeRegistry;
  files: KtFile[];
}

/**
 * Kotlin source, as written. `\${` stands for Kotlin's `${`, and `` \` `` for a
 * backtick; everything else - backslashes included - is kept verbatim.
 * `${value}` without the backslash is still TypeScript interpolation.
 */
export function kt(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  strings.raw.forEach((s, i) => {
    out += s.replace(/\\(\$\{|`)/g, '$1');
    if (i < values.length) out += String(values[i]);
  });
  // Bodies are written indented inside TypeScript. Remove that indentation so
  // the text is what a Kotlin file would hold; the generator adds its own.
  const lines = out.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(common, l.length - l.trimStart().length))).join('\n');
}

export interface Param {
  name: string;
  type: string;
  default?: string;
}

export interface Field {
  name: string;
  type: string;
  default?: string;
  /** `val` rather than `var`. Defaults to true: Draken prefers immutable data. */
  readonly?: boolean;
  visibility?: 'public' | 'private' | 'internal';
  static?: boolean;
  annotations?: string[];
  doc?: string;
}

interface Declared {
  name: string;
  file: KtFile;
  /** An extension member, called after a dot as well as bare. */
  extension?: boolean;
}

/** Every top-level name the kit has declared, for import resolution. */
const declared = new Map<string, Declared>();

function assertSpelling(name: string, kind: 'type' | 'value', where: string): void {
  // The backend spells declarations camelCase / PascalCase. A name that is not
  // already in that form would be declared as something else, and every body
  // calling it by the written spelling would fail to compile.
  const expected = kind === 'type' ? pascal(name) : camel(name);
  if (expected !== name) {
    throw new Error(`${where}: "${name}" would be generated as "${expected}". Name it "${expected}".`);
  }
}

export class KtFile {
  readonly file: ProjectFile;
  readonly g: GraphBuilder;
  readonly pkg: string;
  /** The Gradle module, the first path segment. */
  readonly module: string;
  /** The source set, `main` or `test`. */
  readonly sourceSet: string;
  /** Imports the scanner cannot see, such as one only a string mentions. */
  readonly extraImports = new Set<string>();
  /** Type, annotation and default-value text from signatures, for the import scan. */
  readonly signatureText: string[] = [];

  constructor(ctx: Ctx, path: string, spec: { doc: string; module?: ProjectModule; role?: ProjectFile['role'] }) {
    const { file, graph } = addFile(ctx.project, {
      path,
      language: 'kotlin',
      kind: 'generated',
      role: spec.role ?? 'source',
      moduleId: spec.module?.id,
      graph: { name: spec.doc, style: 'object-oriented' },
    });
    this.file = file;
    this.g = new GraphBuilder(ctx.project, ctx.registry, graph!);
    const m = /^([^/]+)\/src\/([a-zA-Z]+)\/kotlin\/(.+)\/[^/]+\.kt$/.exec(path);
    if (!m) throw new Error(`${path} is not under a Kotlin source set`);
    this.module = m[1];
    this.sourceSet = m[2];
    this.pkg = m[3].replace(/\//g, '.');
    ctx.files.push(this);
  }

  /** Record a top-level name. `verbatim` names are raw source, which the backend never re-cases. */
  private register(name: string, kind: 'type' | 'value', verbatim = false, extension = false): void {
    if (!verbatim) assertSpelling(name, kind, this.file.path);
    const clash = declared.get(name);
    if (clash && clash.file !== this) {
      throw new Error(`"${name}" is declared in both ${clash.file.file.path} and ${this.file.path}.`);
    }
    declared.set(name, { name, file: this, extension });
  }

  private sig(...parts: (string | undefined)[]): void {
    for (const p of parts) if (p) this.signatureText.push(p);
  }

  private params(list: Param[] | undefined): Param[] {
    for (const p of list ?? []) {
      assertSpelling(p.name, 'value', this.file.path);
      this.sig(p.type, p.default);
    }
    return list ?? [];
  }

  /** Library names a body uses that the scanner would miss. */
  use(...fqns: string[]): this {
    fqns.forEach((f) => this.extraImports.add(f));
    return this;
  }

  /** A data class. */
  record(name: string, fields: Field[], opts: { doc: string; annotations?: string[]; implements?: string[] }): GraphNode {
    this.register(name, 'type');
    this.sig(...(opts.annotations ?? []), ...(opts.implements ?? []));
    return this.g.add('oop/class', {
      name,
      shape: 'record',
      fields: fields.map((f) => this.field(f)),
      implements: (opts.implements ?? []).join(', '),
      annotations: opts.annotations ?? [],
      doc: opts.doc,
    });
  }

  private field(f: Field): Record<string, unknown> {
    assertSpelling(f.name, 'value', this.file.path);
    this.sig(f.type, f.default, ...(f.annotations ?? []));
    return {
      name: f.name,
      type: f.type,
      default: f.default,
      readonly: f.readonly ?? true,
      visibility: f.visibility ?? 'public',
      static: f.static ?? false,
      annotations: f.annotations,
      doc: f.doc,
    };
  }

  /**
   * A class. `ctor` parameters that share a field's name become constructor
   * properties; the rest are plain constructor parameters.
   */
  cls(
    name: string,
    opts: {
      doc: string;
      fields?: Field[];
      ctor?: Param[];
      extends?: string;
      implements?: string[];
      annotations?: string[];
      abstract?: boolean;
      generics?: string;
    },
  ): GraphNode {
    this.register(name, 'type');
    this.sig(opts.extends, ...(opts.implements ?? []), ...(opts.annotations ?? []));
    const node = this.g.add('oop/class', {
      name,
      shape: 'class',
      fields: (opts.fields ?? []).map((f) => this.field(f)),
      extends: opts.extends ?? '',
      implements: (opts.implements ?? []).join(', '),
      generics: opts.generics ?? '',
      isAbstract: opts.abstract ?? false,
      annotations: opts.annotations ?? [],
      doc: opts.doc,
    });
    if (opts.ctor) {
      this.g.add('oop/constructor', { className: name, params: this.params(opts.ctor), assignFields: true });
    }
    return node;
  }

  /** An interface. Members are signatures; `suspend` ones are marked async. */
  iface(
    name: string,
    methods: { name: string; params?: Param[]; returns?: string; suspend?: boolean; annotations?: string[]; doc?: string }[],
    opts: { doc: string; extends?: string[]; annotations?: string[]; generics?: string },
  ): GraphNode {
    this.register(name, 'type');
    this.sig(...(opts.extends ?? []), ...(opts.annotations ?? []));
    return this.g.add('oop/interface', {
      name,
      methods: methods.map((m) => {
        assertSpelling(m.name, 'value', this.file.path);
        this.sig(m.returns, ...(m.annotations ?? []));
        return {
          name: m.name,
          params: this.params(m.params),
          returns: m.returns ?? 'Void',
          isAsync: m.suspend ?? false,
          annotations: m.annotations,
          doc: m.doc,
        };
      }),
      extends: (opts.extends ?? []).join(', '),
      generics: opts.generics ?? '',
      annotations: opts.annotations ?? [],
      doc: opts.doc,
    });
  }

  /** An enum; a variant with a payload makes it a sealed hierarchy. */
  enm(
    name: string,
    variants: (string | { name: string; payload: { name: string; type: string }[] })[],
    opts: { doc: string; annotations?: string[] },
  ): GraphNode {
    this.register(name, 'type');
    this.sig(...(opts.annotations ?? []));
    for (const v of variants) {
      if (typeof v !== 'string') for (const p of v.payload) this.sig(p.type);
    }
    return this.g.add('oop/enum', { name, variants, annotations: opts.annotations ?? [], doc: opts.doc });
  }

  /** A function, or a method when `of` names a class in this file. */
  fn(
    name: string,
    spec: {
      doc: string;
      params?: Param[];
      returns?: string;
      code: string;
      of?: string;
      suspend?: boolean;
      override?: boolean;
      isStatic?: boolean;
      visibility?: 'public' | 'private' | 'internal';
      annotations?: string[];
      generics?: string;
      expression?: boolean;
    },
  ): GraphNode {
    // A composable that emits UI is named like a type, as Compose expects.
    const kind = (spec.annotations ?? []).includes('Composable') && !spec.returns ? 'type' : 'value';
    if (spec.of || spec.visibility === 'private') assertSpelling(name, kind, this.file.path);
    else this.register(name, kind);
    this.sig(spec.returns, ...(spec.annotations ?? []));
    return this.g.add('custom/function', {
      name,
      className: spec.of ?? '',
      params: this.params(spec.params),
      returns: spec.returns ?? 'Void',
      isAsync: spec.suspend ?? false,
      isOverride: spec.override ?? false,
      isStatic: spec.isStatic ?? false,
      visibility: spec.visibility ?? 'public',
      generics: spec.generics ?? '',
      annotations: spec.annotations ?? [],
      language: 'kotlin',
      form: spec.expression ? 'expression' : 'statements',
      code: spec.code,
      doc: spec.doc,
    });
  }

  /**
   * Verbatim Kotlin declarations, for what the node vocabulary cannot model.
   * `extensions` are provided names that are extension members, such as
   * `val Context.settings`; other files call them after a dot.
   */
  decl(code: string, spec: { doc: string; provides?: string[]; extensions?: string[] }): GraphNode {
    const extensions = new Set(spec.extensions ?? []);
    const provides = [...(spec.provides ?? []), ...extensions];
    for (const p of provides) this.register(p, /^[A-Z]/.test(p) ? 'type' : 'value', true, extensions.has(p));
    return this.g.add('custom/declaration', { language: 'kotlin', code, provides, doc: spec.doc });
  }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** Remove comments and string contents, keeping `${...}` templates, which are code. */
function codeOnly(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  out = out.replace(/"""[\s\S]*?"""/g, (s) => templates(s));
  out = out.replace(/"(?:[^"\\\n]|\\.)*"/g, (s) => templates(s));
  out = out.replace(/'(?:[^'\\\n]|\\.)'/g, ' ');
  return out;
}

function templates(literal: string): string {
  const parts = [...literal.matchAll(/\$\{([^}]*)\}|\$([A-Za-z_]\w*)/g)].map((m) => m[1] ?? m[2]);
  return ` ${parts.join(' ')} `;
}

/**
 * Whether `from` can see a declaration in `decl`, as Gradle compiles them: a
 * module sees its own main sources and those of the modules it depends on,
 * and only its own test sources see its test sources.
 */
function visible(decl: KtFile, from: KtFile, dependsOn: Map<string, string[]>): boolean {
  if (decl.module === from.module) return decl.sourceSet === 'main' || decl.sourceSet === from.sourceSet;
  if (decl.sourceSet !== 'main') return false;
  const seen = new Set<string>();
  const stack = [from.module];
  while (stack.length) {
    const m = stack.pop()!;
    if (m === decl.module) return true;
    if (seen.has(m)) continue;
    seen.add(m);
    stack.push(...(dependsOn.get(m) ?? []));
  }
  return false;
}

/**
 * Give every file the imports its text needs, as a Library Imports node.
 *
 * A name resolves to a declaration this file can see in another package of
 * this project, or to an entry in the library table. Extension functions and
 * properties are matched after a dot, since that is how they are called;
 * anything else only standing alone, so `x.size` never imports something
 * named `size`.
 */
export function wireImports(ctx: Ctx): number {
  const settings = ctx.project.extensions?.kotlin as KotlinSettings | undefined;
  const dependsOn = new Map((settings?.modules ?? []).map((m) => [m.path, m.dependsOn ?? []]));
  let total = 0;
  for (const f of ctx.files) {
    const texts: string[] = [...f.signatureText];
    for (const n of f.g.graph.nodes) {
      if (typeof n.props.code === 'string') texts.push(n.props.code);
    }
    const code = codeOnly(texts.join('\n'));
    const local = new Set([...declared.values()].filter((d) => d.file === f).map((d) => d.name));
    const imports = new Set<string>(f.extraImports);

    for (const m of code.matchAll(/(\.)?\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      const dotted = !!m[1];
      const name = m[2];
      if (local.has(name)) continue;
      const own = declared.get(name);
      if (own && visible(own.file, f, dependsOn) && (own.extension || !dotted)) {
        if (own.file.pkg !== f.pkg) imports.add(`${own.file.pkg}.${name}`);
        continue;
      }
      const lib = LIBRARY_NAMES[name];
      if (!lib || lib.manual || (lib.module && lib.module !== f.module)) continue;
      if (lib.extension ? dotted || lib.alsoBare : !dotted) imports.add(lib.fqn);
    }
    // `val x by remember { ... }` and friends: Compose's State delegates are
    // extension operators the delegate syntax calls without naming them.
    for (const m of code.matchAll(/\b(val|var)\s+\w+(?:\s*:\s*[^=\n]+?)?\s+by\s+([^\n]+)/g)) {
      if (!/remember|StateOf\b|collectAsState/.test(m[2])) continue;
      imports.add('androidx.compose.runtime.getValue');
      if (m[1] === 'var') imports.add('androidx.compose.runtime.setValue');
    }
    if (!imports.size) continue;
    f.g.add('module/imports', { imports: [...imports].sort() });
    total += imports.size;
  }
  return total;
}

/** Names declared by the kit so far; build.ts uses it to report the project's shape. */
export function declaredCount(): number {
  return declared.size;
}
