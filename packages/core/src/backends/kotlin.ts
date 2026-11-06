/**
 * Kotlin backend.
 *
 * Kotlin fits the IR more closely than Java does: a file may hold any number of
 * top-level functions, classes and properties, so an IR module is simply a
 * `.kt` file, with no holder class. The decisions worth knowing, each because
 * Kotlin is stricter than the IR about something:
 *
 *  - **Numbers never widen implicitly.** `Long` does not flow into `Double`, nor
 *    `Int` into `Long`. The IR lets an integer feed a float port, so every typed
 *    sink - a `val`, a return, an argument, an assignment - is coerced here
 *    explicitly rather than left for kotlinc to reject.
 *  - **Collections are read-only by default.** Declared types use `List`, `Set`
 *    and `Map`, which is what idiomatic Kotlin APIs take and return. A local
 *    initialised with a fresh collection is declared `MutableList` and friends,
 *    because that is where the IR mutates; a mutating builtin applied to
 *    anything else casts, which succeeds for every collection the IR creates.
 *  - **Classes are final.** A class another class in the program extends is
 *    emitted `open`, and so is each of its methods a subclass replaces.
 *    `override` comes from the in-program hierarchy plus `isOverride`, which a
 *    graph sets when the supertype lives in a library.
 *  - **No statics.** Static members become a `companion object`; a class made
 *    only of static members becomes an `object`.
 *  - **Async is `suspend`.** An awaited call is just a call; Kotlin suspends at
 *    it without an operator.
 *
 * Projects are built by Gradle (Kotlin DSL), single- or multi-module, for the
 * JVM or Android, from the settings in `project.extensions.kotlin`; a plain JVM
 * program with no dependencies is also compiled directly with kotlinc, which is
 * an order of magnitude faster than starting Gradle.
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
import { CLikeEmitter } from './clike.ts';
import type { CLikeDialect } from './clike.ts';
import { CodeWriter, avoidKeyword, camel, pascal, screamingSnake, wrapText } from './emitter.ts';
import type {
  BinaryOp,
  IrClass,
  IrDecl,
  IrEnum,
  IrExpr,
  IrField,
  IrFunction,
  IrInterface,
  IrModule,
  IrParam,
  IrProgram,
  IrStmt,
  Origin,
} from '../ir/ir.ts';
import { walkModule } from '../ir/ir.ts';
import { getBuiltin } from '../ir/builtins.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Dependency, Project, ProjectFile } from '../model/project.ts';
import type { TypeRef } from '../types/types.ts';
import { T, isInteger, isNumeric } from '../types/types.ts';

/** Hard keywords: these cannot name anything without backticks. */
const KEYWORDS = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface',
  'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias',
  'typeof', 'val', 'var', 'when', 'while',
]);

// ---------------------------------------------------------------------------
// Project settings
// ---------------------------------------------------------------------------

/**
 * How a Kotlin project is built, read from `project.extensions.kotlin`.
 *
 * Absent, the project is one JVM application at the generated root. Present,
 * it names Gradle modules: each owns the files whose path starts with its
 * directory, and each is a JVM or Android library or application.
 */
export interface KotlinSettings {
  modules?: KotlinModuleSettings[];
  versions?: Partial<KotlinVersions>;
  /** Bytecode level for every module. */
  jvmTarget?: number;
}

export interface KotlinVersions {
  kotlin: string;
  agp: string;
  ksp: string;
  gradle: string;
}

export type KotlinModuleKind = 'jvm-application' | 'jvm-library' | 'android-application' | 'android-library';

export interface KotlinModuleSettings {
  /** Directory relative to the generated root, and the Gradle project name. */
  path: string;
  kind: KotlinModuleKind;
  /** Other modules (by path) this one compiles against. */
  dependsOn?: string[];
  /** Applies the Compose compiler plugin and enables the Compose build feature. */
  compose?: boolean;
  /** Applies the kotlinx.serialization compiler plugin. */
  serialization?: boolean;
  /** Fully-qualified main class, for JVM applications. Derived from the entry file when absent. */
  mainClass?: string;
  /** Arguments for the JVM that runs this module's unit tests. */
  testJvmArgs?: string[];
  /**
   * Gradle Kotlin DSL appended verbatim to the module's build script, for
   * configuration this model has no field for (a KSP argument, a plugin's
   * extension block). An escape hatch, like Custom Code: reviewed text, not
   * structure.
   */
  extraDsl?: string[];
  android?: AndroidSettings;
}

export interface AndroidSettings {
  namespace: string;
  applicationId?: string;
  minSdk: number;
  targetSdk: number;
  compileSdk: number;
  versionCode?: number;
  versionName?: string;
  permissions?: string[];
  /** The `<application>` element; attribute names without `android:` get it added. */
  application?: ManifestElement;
  /** Literal resource files, by path under `src/main/res/`. */
  resources?: Record<string, string>;
}

export interface ManifestElement {
  tag?: string;
  attributes?: Record<string, string>;
  children?: ManifestElement[];
}

/**
 * Versions this backend was last verified against, together, on a real build:
 * an Android app with Compose, Room through KSP and Robolectric tests. They move
 * as a set - the Compose BOM decides the minimum compileSdk, the AGP release
 * decides the minimum Gradle - so a project overrides them deliberately.
 */
export const DEFAULT_KOTLIN_VERSIONS: KotlinVersions = {
  kotlin: '2.4.20',
  agp: '9.4.1',
  ksp: '2.3.12',
  gradle: '9.8.1',
};

interface ResolvedModule extends KotlinModuleSettings {
  /** `''` for a single-module build at the root. */
  path: string;
}

interface ResolvedSettings {
  modules: ResolvedModule[];
  versions: KotlinVersions;
  jvmTarget: number;
  /** True when there is a `settings.modules` list, even of one. */
  multiModule: boolean;
}

export function kotlinSettings(project: Project): ResolvedSettings {
  const raw = (project.extensions?.kotlin ?? {}) as KotlinSettings;
  const versions = { ...DEFAULT_KOTLIN_VERSIONS, ...(raw.versions ?? {}) };
  const jvmTarget = typeof raw.jvmTarget === 'number' ? raw.jvmTarget : 17;
  if (Array.isArray(raw.modules) && raw.modules.length) {
    return {
      modules: raw.modules.map((m) => ({ ...m, path: m.path.replace(/^\/+|\/+$/g, '') })),
      versions,
      jvmTarget,
      multiModule: true,
    };
  }
  return { modules: [{ path: '', kind: 'jvm-application' }], versions, jvmTarget, multiModule: false };
}

function isAndroid(m: KotlinModuleSettings): boolean {
  return m.kind === 'android-application' || m.kind === 'android-library';
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const SOURCE_SET = /^(?:(.+?)\/)?src\/([A-Za-z0-9]+)\/(?:kotlin|java)\/(.*)$/;

function rootPackage(project: Project): string {
  return (
    (project.namespace ?? `com.${project.name}`)
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '') || 'app'
  );
}

/** Where a project file lands, under a source set of the module that owns it. */
function kotlinPathFor(file: ProjectFile, project: Project): string {
  if (SOURCE_SET.test(file.path)) return file.path;
  const settings = kotlinSettings(project);
  const owner =
    settings.modules.find((m) => m.path && file.path.startsWith(`${m.path}/`)) ??
    settings.modules.find((m) => m.kind.endsWith('application')) ??
    settings.modules[0];
  const rest = owner.path && file.path.startsWith(`${owner.path}/`) ? file.path.slice(owner.path.length + 1) : file.path;
  const set = file.role === 'test' ? 'test' : 'main';
  const pkgDir = rootPackage(project).replace(/\./g, '/');
  const prefix = owner.path ? `${owner.path}/` : '';
  return `${prefix}src/${set}/kotlin/${pkgDir}/${rest.replace(/^src\//, '')}`;
}

function packageOfPath(path: string, project: Project): string {
  const m = SOURCE_SET.exec(path);
  const dirs = (m ? m[3] : path).split('/');
  dirs.pop();
  const parts = dirs.filter(Boolean).map((d) => d.toLowerCase().replace(/[^a-z0-9_]/g, ''));
  return parts.length ? parts.join('.') : rootPackage(project);
}

function moduleOfPath(path: string, project: Project): ResolvedModule {
  const settings = kotlinSettings(project);
  const m = SOURCE_SET.exec(path);
  const dir = m?.[1] ?? '';
  return settings.modules.find((x) => x.path === dir) ?? settings.modules[0];
}

function fileStem(path: string): string {
  return pascal((path.split('/').pop() ?? 'Main').replace(/\.[^.]+$/, ''));
}

/** Name of the runtime support file, unique per Gradle module so two jars never ship the same class. */
function runtimeFileName(module: ResolvedModule, settings: ResolvedSettings): string {
  return settings.multiModule ? `McRuntime${pascal(module.path || 'main')}` : 'McRuntime';
}

// ---------------------------------------------------------------------------
// Program-wide facts the emitter needs
// ---------------------------------------------------------------------------

interface ProgramFacts {
  classes: Map<string, IrClass>;
  interfaces: Map<string, IrInterface>;
  enums: Map<string, IrEnum>;
  /** Classes some other class in the program extends. */
  extended: Set<string>;
  /** Top-level function names, for function references. */
  functions: Set<string>;
  /** Module-level constants, which are spelled SCREAMING_SNAKE. */
  constants: Set<string>;
  /**
   * Every type name the program declares. Only these are re-cased: a type the
   * program merely uses - `IOException`, `URL` - is spelled as written, since
   * PascalCase would turn it into `IoException`, which does not exist.
   */
  types: Set<string>;
}

const factsCache = new WeakMap<IrProgram, ProgramFacts>();

function programFacts(program: IrProgram): ProgramFacts {
  const cached = factsCache.get(program);
  if (cached) return cached;
  const facts: ProgramFacts = {
    classes: new Map(),
    interfaces: new Map(),
    enums: new Map(),
    extended: new Set(),
    functions: new Set(),
    constants: new Set(),
    types: new Set(),
  };
  for (const m of program.modules) {
    for (const d of m.decls) {
      // Raw declarations are not in here: their names are source text, kept as written.
      if (d.k === 'class' || d.k === 'interface' || d.k === 'enum' || d.k === 'typeAlias') facts.types.add(d.name);
      if (d.k === 'class') {
        facts.classes.set(d.name, d);
        if (d.extends?.kind === 'named') facts.extended.add(d.extends.name);
      } else if (d.k === 'interface') facts.interfaces.set(d.name, d);
      else if (d.k === 'enum') facts.enums.set(d.name, d);
      else if (d.k === 'function') facts.functions.add(d.name);
      else if (d.k === 'global' && d.constant && isConstLiteral(d.init)) facts.constants.add(d.name);
    }
  }
  factsCache.set(program, facts);
  return facts;
}

function isConstLiteral(e: IrExpr | undefined): boolean {
  return !!e && e.k === 'lit' && e.value.t !== 'null';
}

// ---------------------------------------------------------------------------
// Precedence. Kotlin's infix functions (`and`, `shl`, ...) all share one level,
// below the arithmetic operators and above comparison, which is not where C
// puts `&` and `|` - so the C table would parenthesise wrongly.
// ---------------------------------------------------------------------------

const KT_PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '&': 6, '|': 6, '^': 6, '<<': 6, '>>': 6,
  '+': 8, '-': 8, '*': 9, '/': 9, '%': 9,
};
const INFIX: Partial<Record<BinaryOp, string>> = { '&': 'and', '|': 'or', '^': 'xor', '<<': 'shl', '>>': 'shr' };
const CALL_PREC = 17;
const UNARY_PREC = 13;

const DIALECT: CLikeDialect = {
  letKeyword: (mutable) => (mutable ? 'var' : 'val'),
  typeFirst: false,
  nullLiteral: 'null',
  trueLiteral: 'true',
  falseLiteral: 'false',
  semicolon: false,
  parenthesizedConditions: true,
  elseOnSameLine: true,
  foreach: (v, _t, it) => `for (${v} in ${it})`,
  forRange: (v, start, end, step, inclusive) =>
    `for (${v} in ${start} ${inclusive ? '..' : 'until'} ${end}${step === '1' ? '' : ` step ${step}`})`,
  power: (b, e) => `${b}.toDouble().pow(${e}.toDouble())`,
};

// ---------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------

class KotlinEmitter extends CLikeEmitter {
  /** Fully-qualified names to import. */
  private readonly imports = new Set<string>();
  /** Runtime helpers this module calls. */
  readonly helpers = new Set<string>();
  private readonly facts: ProgramFacts;
  private readonly settings: ResolvedSettings;
  private readonly gradleModule: ResolvedModule;
  private readonly packageName: string;
  /** Generic parameters in scope, innermost last. */
  private readonly genericScopes: string[][] = [];
  /** Locals and parameters in scope, innermost last. */
  private readonly scopes: Set<string>[] = [];
  /** Names declared with a `Mutable…` collection type. */
  private readonly mutableNames = new Set<string>();
  private currentReturn: TypeRef = T.void;

  constructor(ctx: EmitContext) {
    super(ctx, DIALECT, KEYWORDS, '    ');
    this.facts = programFacts(ctx.program);
    this.settings = kotlinSettings(ctx.project);
    const outPath = ctx.file.path ? kotlinPathFor(ctx.file, ctx.project) : '';
    this.gradleModule = moduleOfPath(outPath, ctx.project);
    this.packageName = outPath ? packageOfPath(outPath, ctx.project) : rootPackage(ctx.project);
  }

  protected override get langId(): string {
    return 'kotlin';
  }

  private get android(): boolean {
    return isAndroid(this.gradleModule);
  }

  // -- naming ----------------------------------------------------------------

  override name(raw: string): string {
    return avoidKeyword(camel(raw), KEYWORDS);
  }

  /**
   * A type the program declares, PascalCase segment by segment so a nested
   * type stays `Outer.Inner`. Any other type is spelled exactly as written.
   */
  override typeName(raw: string): string {
    if (!this.facts.types.has(raw.split('.')[0])) return raw;
    return raw
      .split('.')
      .map((segment) => avoidKeyword(pascal(segment), KEYWORDS))
      .join('.');
  }

  /**
   * A function's name. Compose names a `@Composable` function that emits UI
   * like a type - `ChatScreen`, not `chatScreen` - and its lint flags anything
   * else, so those follow the type rule.
   */
  private functionName(f: IrFunction): string {
    const composable = f.annotations?.some((a) => /^@?(androidx\.compose\.runtime\.)?Composable$/.test(a.trim()));
    return composable && f.returns.kind === 'void' ? avoidKeyword(pascal(f.name), KEYWORDS) : this.name(f.name);
  }

  /** A module-level symbol, spelled the way its declaration was. */
  private symbolSpelling(raw: string): string {
    if (this.facts.constants.has(raw)) return screamingSnake(raw);
    return /^[A-Z]/.test(raw) ? this.typeName(raw) : this.name(raw);
  }

  private use(helper: string): string {
    this.helpers.add(helper);
    return helper;
  }

  private need(fqn: string): void {
    this.imports.add(fqn);
  }

  // -- module ----------------------------------------------------------------

  emit(): string {
    const { module, file, project } = this.ctx;
    if (module.main?.length) {
      throw new BackendGenError('Kotlin has no top-level statements; put them in a Main or Function node.', {
        code: 'codegen/kotlin-top-level-statements',
      });
    }

    const body = new CodeWriter('    ');
    const isTest = file.role === 'test';
    const functions = module.decls.filter((d): d is IrFunction => d.k === 'function');
    const testFunctions = isTest ? functions.filter((f) => f.isTest) : [];
    for (const d of module.decls) {
      if (testFunctions.includes(d as IrFunction)) continue;
      this.decl(body, d);
    }
    if (testFunctions.length) this.testClass(body, testFunctions);

    const head = new CodeWriter('    ');
    for (const l of generatedHeader(kotlinBackend, file, project)) head.line(l);
    head.blank();
    head.line(`package ${this.packageName}`);

    const imports = this.importLines();
    if (imports.length) {
      head.blank();
      for (const l of imports) head.line(l);
    }
    // A hybrid file keeps hand-written imports and code across regeneration.
    if (file.kind === 'hybrid') {
      head.blank();
      head.line('// <mcode:region id="user-imports">');
      head.line('// </mcode:region>');
    }
    head.blank();
    head.blockFrom(body);
    if (file.kind === 'hybrid') {
      head.blank();
      head.line('// <mcode:region id="user-code">');
      head.line('// </mcode:region>');
    }
    if (this.ctx.lineOrigins) {
      for (const [line, origin] of head.lineOrigins()) this.ctx.lineOrigins.set(line, origin as Origin);
    }
    return head.toString();
  }

  private importLines(): string[] {
    const { module, program, project } = this.ctx;
    const fqns = new Set(this.imports);

    for (const imp of module.imports) {
      if (imp.source === 'file') {
        const target = program.modules.find((m) => m.id === imp.target);
        const targetFile = project.files.find((f) => f.id === imp.target);
        if (!target || !targetFile) continue;
        const pkg = packageOfPath(kotlinPathFor(targetFile, project), project);
        if (pkg === this.packageName) continue;
        for (const s of imp.symbols ?? []) fqns.add(`${pkg}.${this.symbolSpelling(s.name)}`);
        continue;
      }
      // Library imports are written as the language spells them.
      const symbols = imp.symbols?.length ? imp.symbols : undefined;
      if (!symbols) {
        fqns.add(imp.alias ? `${imp.target} as ${imp.alias}` : imp.target);
        continue;
      }
      for (const s of symbols) fqns.add(`${imp.target}.${s.name}${s.alias ? ` as ${s.alias}` : ''}`);
    }

    // Helpers live in the root package; a file elsewhere imports what it calls.
    const root = rootPackage(project);
    if (root !== this.packageName) {
      for (const h of this.helpers) fqns.add(`${root}.${h}`);
    }

    return [...fqns]
      .filter((f) => !isDefaultImport(f) && packageOf(f) !== this.packageName)
      .sort()
      .map((f) => `import ${f}`);
  }

  // -- types -----------------------------------------------------------------

  override type(t: TypeRef): string {
    switch (t.kind) {
      case 'void':
      case 'exec':
        return 'Unit';
      case 'any':
        return 'Any?';
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return 'Boolean';
          case 'i32':
            return 'Int';
          case 'i64':
            return 'Long';
          case 'f32':
            return 'Float';
          case 'f64':
            return 'Double';
          case 'string':
            return 'String';
          case 'char':
            return 'Char';
          case 'bytes':
            return 'ByteArray';
        }
        return 'Any?';
      case 'list':
        return `List<${this.type(t.item)}>`;
      case 'set':
        return `Set<${this.type(t.item)}>`;
      case 'map':
        return `Map<${this.type(t.key)}, ${this.type(t.value)}>`;
      case 'option': {
        const inner = this.type(t.inner);
        // `() -> Unit?` is a function returning a nullable; the nullable
        // function is `(() -> Unit)?`. A function type also ends in `?` when
        // only its result is nullable, so that test alone cannot be trusted.
        if (inner.includes('->')) return `(${inner})?`;
        return inner.endsWith('?') ? inner : `${inner}?`;
      }
      case 'tuple':
        return 'List<Any?>';
      case 'future':
        this.need('kotlinx.coroutines.Deferred');
        return `Deferred<${this.type(t.inner)}>`;
      case 'result':
        // Failure travels as an exception, as everywhere else in generated Kotlin.
        return this.type(t.ok);
      case 'function': {
        const params = t.params.map((p) => this.type(p)).join(', ');
        return `(${params}) -> ${this.type(t.returns)}`;
      }
      case 'named':
        return this.namedType(t);
      case 'var':
        return this.genericScopes.some((s) => s.includes(t.name)) ? t.name : 'Any?';
    }
  }

  private namedType(t: Extract<TypeRef, { kind: 'named' }>): string {
    switch (t.name) {
      case 'Error':
        return 'Exception';
      case 'Json':
        return 'Any?';
      case 'HttpResponse':
        return this.use('McHttpResponse');
      case 'HttpRequest':
        return this.use('McHttpRequest');
      case 'HttpReply':
        return this.use('McHttpReply');
      case 'DbConnection':
        if (this.android) {
          throw new BackendGenError('Android has no JDBC; SQLite on Android goes through Room or SQLiteDatabase.', {
            code: 'codegen/kotlin-db-on-android',
            hint: 'Declare a Room DAO with a Custom Declaration, or move this file to a JVM module.',
          });
        }
        this.need('java.sql.Connection');
        return 'Connection';
      case 'Element':
        throw new BackendGenError('DOM types have no Kotlin equivalent.', { code: 'codegen/dom-in-kotlin' });
      default: {
        const base = this.resolvedType(t.name);
        return t.args?.length ? `${base}<${t.args.map((a) => this.type(a)).join(', ')}>` : base;
      }
    }
  }

  /** A user type; naming one from another file imports it - the outer type, for a nested one. */
  protected override resolvedType(name: string): string {
    this.ctx.resolveSymbol(name.split('.')[0]);
    return this.typeName(name);
  }

  /** `MutableList<T>` for a list type, and so on; anything else unchanged. */
  private mutableType(t: TypeRef): string {
    if (t.kind === 'list') return `MutableList<${this.type(t.item)}>`;
    if (t.kind === 'set') return `MutableSet<${this.type(t.item)}>`;
    if (t.kind === 'map') return `MutableMap<${this.type(t.key)}, ${this.type(t.value)}>`;
    return this.type(t);
  }

  override zero(t: TypeRef): string {
    switch (t.kind) {
      case 'primitive':
        switch (t.name) {
          case 'bool':
            return 'false';
          case 'string':
            return '""';
          case 'char':
            return "' '";
          case 'f32':
            return '0f';
          case 'f64':
            return '0.0';
          case 'i32':
            return '0';
          case 'i64':
            return '0L';
          case 'bytes':
            return 'ByteArray(0)';
        }
        return 'null';
      case 'list':
        return `mutableListOf<${this.type(t.item)}>()`;
      case 'set':
        return `mutableSetOf<${this.type(t.item)}>()`;
      case 'map':
        return `mutableMapOf<${this.type(t.key)}, ${this.type(t.value)}>()`;
      case 'void':
      case 'exec':
        return 'Unit';
      default:
        return 'null';
    }
  }

  /** True when `zero(t)` is a real value of type `t` rather than `null`. */
  private hasZero(t: TypeRef): boolean {
    return t.kind === 'primitive' || t.kind === 'list' || t.kind === 'set' || t.kind === 'map' || nullable(t);
  }

  // -- declarations ----------------------------------------------------------

  private decl(w: CodeWriter, d: IrDecl): void {
    switch (d.k) {
      case 'function':
        this.functionDecl(w, d, { topLevel: true });
        break;
      case 'class':
        this.classDecl(w, d);
        break;
      case 'interface':
        this.interfaceDecl(w, d);
        break;
      case 'enum':
        this.enumDecl(w, d);
        break;
      case 'typeAlias':
        w.blank();
        this.kdoc(w, d.doc);
        this.withGenerics(d.generics, () => {
          const g = d.generics?.length ? `<${d.generics.join(', ')}>` : '';
          w.line(`${this.visibility(d.visibility)}typealias ${this.typeName(d.name)}${g} = ${this.type(d.target)}`);
        });
        break;
      case 'global':
        this.globalDecl(w, d);
        break;
      case 'rawDecl':
        if (d.lang !== 'kotlin' && d.lang !== 'any') {
          throw new BackendGenError(`Raw ${d.lang} block cannot be emitted into a Kotlin file.`, {
            code: 'codegen/raw-language-mismatch',
            origin: d.origin,
          });
        }
        w.blank();
        w.mark(d.origin);
        w.verbatim(d.code);
        break;
    }
  }

  private globalDecl(w: CodeWriter, d: Extract<IrDecl, { k: 'global' }>): void {
    w.blank();
    this.kdoc(w, d.doc);
    const vis = this.visibility(d.visibility);
    if (this.facts.constants.has(d.name)) {
      w.line(`${vis}const val ${screamingSnake(d.name)}: ${this.type(d.type)} = ${this.coerce(d.init!, d.type)}`);
      return;
    }
    const keyword = d.constant ? 'val' : 'var';
    const init = d.init ? this.coerce(d.init, d.type) : this.zero(d.type);
    w.line(`${vis}${keyword} ${this.name(d.name)}: ${this.type(d.type)} = ${init}`);
  }

  private visibility(v: string | undefined): string {
    if (v === 'private') return 'private ';
    if (v === 'internal') return 'internal ';
    return '';
  }

  private kdoc(w: CodeWriter, doc: string | undefined): void {
    const text = doc?.trim();
    if (!text) return;
    const lines = wrapText(text.replace(/\*\//g, '* /'));
    if (lines.length === 1) {
      w.line(`/** ${lines[0]} */`);
      return;
    }
    w.line('/**');
    for (const l of lines) w.line(l ? ` * ${l}` : ' *');
    w.line(' */');
  }

  private annotations(w: CodeWriter, list: string[] | undefined): void {
    for (const a of list ?? []) w.line(`@${a.replace(/^@/, '')}`);
  }

  private withGenerics<R>(generics: string[] | undefined, body: () => R): R {
    this.genericScopes.push(generics ?? []);
    try {
      return body();
    } finally {
      this.genericScopes.pop();
    }
  }

  private withScope<R>(names: string[], body: () => R): R {
    this.scopes.push(new Set(names));
    try {
      return body();
    } finally {
      this.scopes.pop();
    }
  }

  private inScope(name: string): boolean {
    return this.scopes.some((s) => s.has(name));
  }

  private declParam(p: IrParam): string {
    const head = `${p.rest ? 'vararg ' : ''}${this.name(p.name)}: ${this.type(p.type)}`;
    return p.default ? `${head} = ${this.coerce(p.default, p.type)}` : head;
  }

  private functionDecl(
    w: CodeWriter,
    f: IrFunction,
    where: { topLevel?: boolean; modifiers?: string[]; signatureOnly?: boolean },
  ): void {
    w.blank();
    this.kdoc(w, f.doc);
    this.annotations(w, f.annotations);
    w.mark(f.origin);

    this.withGenerics(f.generics, () => {
      const generics = f.generics?.length ? `<${f.generics.join(', ')}> ` : '';
      const mods = [...(where.modifiers ?? [])];
      if (f.isAsync) mods.push('suspend');

      if (f.isEntry && where.topLevel) {
        this.entryDecl(w, f, mods);
        return;
      }

      const params = f.params.map((p) => this.declParam(p)).join(', ');
      const returns = f.returns.kind === 'void' ? '' : `: ${this.type(f.returns)}`;
      const head = `${this.visibility(f.visibility)}${mods.map((m) => `${m} `).join('')}fun ${generics}${this.functionName(f)}(${params})${returns}`;
      if (where.signatureOnly) {
        w.line(head);
        return;
      }
      w.braced(head, () => this.functionBody(w, f));
    });
  }

  private functionBody(w: CodeWriter, f: IrFunction): void {
    const saved = this.currentReturn;
    this.currentReturn = f.returns;
    this.withScope(
      f.params.map((p) => p.name),
      () => {
        this.emitBody(w, f.body);
        const last = f.body[f.body.length - 1];
        // Raw source manages its own returns; appending one after it would be
        // unreachable, and kotlinc is right to reject a body that never returns.
        if (f.returns.kind !== 'void' && last?.k !== 'raw' && !endsInJump(f.body)) {
          w.line(this.hasZero(f.returns) ? `return ${this.zero(f.returns)}` : 'error("unreachable: no value was returned")');
        }
      },
    );
    this.currentReturn = saved;
  }

  /** `fun main`. Kotlin accepts `suspend fun main` directly, so async needs no runner. */
  private entryDecl(w: CodeWriter, f: IrFunction, mods: string[]): void {
    const usesArgs = usesOp(f, 'args_get');
    const head = `${mods.map((m) => `${m} `).join('')}fun main(${usesArgs ? 'args: Array<String>' : ''})`;
    w.braced(head, () => {
      if (usesArgs) w.line(`${this.use('mcSetArgs')}(args)`);
      this.functionBody(w, { ...f, returns: T.void });
    });
  }

  /** Test functions in a test file become `@Test` methods of a class named after the file. */
  private testClass(w: CodeWriter, tests: IrFunction[]): void {
    this.need('kotlin.test.Test');
    w.blank();
    w.braced(`class ${fileStem(this.ctx.file.path)}`, () => {
      for (const t of tests) {
        this.functionDecl(w, { ...t, annotations: ['Test', ...(t.annotations ?? [])] }, {});
      }
    });
  }

  // -- classes ---------------------------------------------------------------

  private classDecl(w: CodeWriter, c: IrClass): void {
    this.withGenerics(c.generics, () => this.classBody(w, c));
  }

  private classBody(w: CodeWriter, c: IrClass): void {
    w.blank();
    this.kdoc(w, c.doc);
    this.annotations(w, c.annotations);
    w.mark(c.origin);

    const instanceFields = c.fields.filter((f) => !f.isStatic);
    const staticFields = c.fields.filter((f) => f.isStatic);
    const instanceMethods = c.methods.filter((m) => !m.isStatic);
    const staticMethods = c.methods.filter((m) => m.isStatic);
    const name = this.typeName(c.name);
    const generics = c.generics?.length ? `<${c.generics.join(', ')}>` : '';
    const supers = this.supertypes(c);
    const vis = this.visibility(c.visibility);

    // A class with nothing per instance is a namespace: Kotlin spells that `object`.
    if (!instanceFields.length && !instanceMethods.length && !c.ctor && !c.extends && !this.facts.extended.has(c.name) && !c.isAbstract && !c.generics?.length) {
      w.braced(`${vis}object ${name}${supers}`, () => {
        for (const f of staticFields) this.fieldDecl(w, f);
        for (const m of staticMethods) this.methodDecl(w, c, m);
      });
      return;
    }

    const isData = (c.shape === 'record' || c.shape === 'struct') && instanceFields.length > 0 && !c.ctor;
    const modifiers: string[] = [];
    if (c.isAbstract) modifiers.push('abstract');
    else if (this.facts.extended.has(c.name)) modifiers.push('open');
    if (isData) modifiers.push('data');

    const ctor = isData ? undefined : this.primaryConstructor(c);
    const ctorProps = isData
      ? instanceFields.map((f) => this.ctorProperty(f))
      : ctor?.params ?? [];
    const headerParams = ctorProps.length ? `(${ctorProps.join(', ')})` : '';
    const header = `${vis}${modifiers.map((m) => `${m} `).join('')}class ${name}${generics}${headerParams}${supers}`;

    const bodyFields = isData ? [] : instanceFields.filter((f) => !ctor?.covered.has(f.name));
    const hasBody = bodyFields.length || ctor?.init.length || instanceMethods.length || staticFields.length || staticMethods.length;
    if (!hasBody) {
      w.line(header);
      return;
    }

    w.braced(header, () => {
      for (const f of bodyFields) this.fieldDecl(w, f);
      if (ctor?.init.length) {
        w.blank();
        w.braced('init', () => this.withScope(c.ctor!.params.map((p) => p.name), () => this.emitBody(w, ctor.init)));
      }
      for (const m of instanceMethods) this.methodDecl(w, c, m);
      if (staticFields.length || staticMethods.length) {
        w.blank();
        w.braced('companion object', () => {
          for (const f of staticFields) this.fieldDecl(w, f);
          for (const m of staticMethods) this.methodDecl(w, c, m);
        });
      }
    });
  }

  /** `: Base(), Iface` - a superclass is constructed, an interface is not. */
  private supertypes(c: IrClass): string {
    const parts: string[] = [];
    if (c.extends) parts.push(`${this.type(c.extends)}()`);
    for (const i of c.implements ?? []) parts.push(this.type(i));
    return parts.length ? ` : ${parts.join(', ')}` : '';
  }

  private ctorProperty(f: IrField): string {
    const annotations = (f.annotations ?? []).map((a) => `@${a} `).join('');
    const keyword = f.readonly ? 'val' : 'var';
    const init = f.init ? ` = ${this.coerce(f.init, f.type)}` : '';
    return `${annotations}${this.visibility(f.visibility)}${keyword} ${this.name(f.name)}: ${this.type(f.type)}${init}`;
  }

  /**
   * Fold a constructor into Kotlin's primary constructor.
   *
   * A parameter that is only ever copied into the field of the same name is a
   * constructor property (`class Repo(private val dao: NoteDao)`), which is how
   * every Kotlin programmer writes it. Whatever else the constructor does runs
   * in an `init` block, after the properties are set, which is the same order.
   */
  private primaryConstructor(c: IrClass): { params: string[]; covered: Set<string>; init: IrStmt[] } | undefined {
    if (!c.ctor) return undefined;
    const covered = new Set<string>();
    const init: IrStmt[] = [];
    for (const s of c.ctor.body) {
      const copied = copiedField(s);
      if (copied && !covered.has(copied) && c.fields.some((f) => !f.isStatic && f.name === copied)) covered.add(copied);
      else init.push(s);
    }
    const params = c.ctor.params.map((p) => {
      const field = covered.has(p.name) ? c.fields.find((f) => f.name === p.name) : undefined;
      if (!field) return this.declParam(p);
      const annotations = (field.annotations ?? []).map((a) => `@${a} `).join('');
      const keyword = field.readonly ? 'val' : 'var';
      const head = `${annotations}${this.visibility(field.visibility)}${keyword} ${this.name(p.name)}: ${this.type(field.type)}`;
      return p.default ? `${head} = ${this.coerce(p.default, field.type)}` : head;
    });
    return { params, covered, init };
  }

  private fieldDecl(w: CodeWriter, f: IrField): void {
    this.kdoc(w, f.doc);
    for (const a of f.annotations ?? []) w.line(`@${a}`);
    const vis = this.visibility(f.visibility);
    const keyword = f.readonly ? 'val' : 'var';
    const fresh = f.init && createsCollection(f.init);
    const type = fresh || (!f.init && isCollection(f.type)) ? this.mutableType(f.type) : this.type(f.type);
    if (fresh || (!f.init && isCollection(f.type))) this.mutableNames.add(`.${f.name}`);
    if (f.init) {
      w.line(`${vis}${keyword} ${this.name(f.name)}: ${type} = ${this.coerce(f.init, f.type)}`);
    } else if (this.hasZero(f.type)) {
      w.line(`${vis}${keyword} ${this.name(f.name)}: ${type} = ${this.zero(f.type)}`);
    } else {
      // No value to start from and no null to stand in for one.
      w.line(`${vis}lateinit var ${this.name(f.name)}: ${type}`);
    }
  }

  private methodDecl(w: CodeWriter, c: IrClass, m: IrFunction): void {
    const mods: string[] = [];
    if (m.isOverride || this.overridesInProgram(c, m.name)) mods.push('override');
    else if (this.facts.extended.has(c.name) && this.overriddenBelow(c.name, m.name)) mods.push('open');
    this.functionDecl(w, m, { modifiers: mods });
  }

  /** True when a supertype declared in this program has a member of that name. */
  private overridesInProgram(c: IrClass, method: string): boolean {
    const seen = new Set<string>();
    const visit = (name: string): boolean => {
      if (seen.has(name)) return false;
      seen.add(name);
      const iface = this.facts.interfaces.get(name);
      if (iface) {
        if (iface.methods.some((m) => m.name === method)) return true;
        return (iface.extends ?? []).some((e) => e.kind === 'named' && visit(e.name));
      }
      const cls = this.facts.classes.get(name);
      if (!cls) return false;
      if (cls.methods.some((m) => m.name === method)) return true;
      return [cls.extends, ...(cls.implements ?? [])].some((t) => t?.kind === 'named' && visit(t.name));
    };
    return [c.extends, ...(c.implements ?? [])].some((t) => t?.kind === 'named' && visit(t.name));
  }

  /** True when a subclass in this program redefines the method, so it must be `open`. */
  private overriddenBelow(className: string, method: string): boolean {
    for (const cls of this.facts.classes.values()) {
      if (cls.extends?.kind !== 'named' || cls.extends.name !== className) continue;
      if (cls.methods.some((m) => m.name === method) || this.overriddenBelow(cls.name, method)) return true;
    }
    return false;
  }

  private interfaceDecl(w: CodeWriter, i: IrInterface): void {
    w.blank();
    this.kdoc(w, i.doc);
    this.annotations(w, i.annotations);
    w.mark(i.origin);
    this.withGenerics(i.generics, () => {
      const generics = i.generics?.length ? `<${i.generics.join(', ')}>` : '';
      const ext = i.extends?.length ? ` : ${i.extends.map((t) => this.type(t)).join(', ')}` : '';
      const head = `${this.visibility(i.visibility)}interface ${this.typeName(i.name)}${generics}${ext}`;
      if (!i.methods.length && !i.fields?.length) {
        w.line(head);
        return;
      }
      w.braced(head, () => {
        for (const f of i.fields ?? []) {
          this.kdoc(w, f.doc);
          this.annotations(w, f.annotations);
          w.line(`val ${this.name(f.name)}: ${this.type(f.type)}`);
        }
        for (const m of i.methods) this.functionDecl(w, m, { signatureOnly: true });
      });
    });
  }

  private enumDecl(w: CodeWriter, e: IrEnum): void {
    w.blank();
    this.kdoc(w, e.doc);
    this.annotations(w, e.annotations);
    w.mark(e.origin);
    const name = this.typeName(e.name);
    const vis = this.visibility(e.visibility);
    if (!e.variants.some((v) => v.payload?.length)) {
      w.braced(`${vis}enum class ${name}`, () => {
        w.line(e.variants.map((v) => screamingSnake(v.name)).join(', '));
      });
      return;
    }
    // Data-carrying variants are a sealed hierarchy: each case its own type,
    // and a `when` over them is checked for exhaustiveness by the compiler.
    w.braced(`${vis}sealed interface ${name}`, () => {
      for (const v of e.variants) {
        const variant = avoidKeyword(pascal(v.name), KEYWORDS);
        if (v.payload?.length) {
          const fields = v.payload.map((p) => `val ${this.name(p.name)}: ${this.type(p.type)}`).join(', ');
          w.line(`data class ${variant}(${fields}) : ${name}`);
        } else {
          w.line(`data object ${variant} : ${name}`);
        }
      }
    });
  }

  // -- statements ------------------------------------------------------------

  override stmt(w: CodeWriter, s: IrStmt): void {
    const handled = ['let', 'assign', 'return', 'expr', 'throw', 'forRange', 'forEach', 'block'].includes(s.k);
    if (!handled) {
      if (s.origin) w.mark(s.origin);
      super.stmt(w, s);
      return;
    }
    if (s.comment) w.line(`// ${s.comment}`);
    if (s.origin) w.mark(s.origin);
    switch (s.k) {
      case 'let':
        this.text(w, this.letStatement(s));
        this.scopes[this.scopes.length - 1]?.add(s.name);
        return;
      case 'assign': {
        const target = this.expr(s.target);
        if (s.op === '**') {
          this.text(w, `${target} = ${this.dialect.power(target, this.expr(s.value, CALL_PREC))}`);
        } else if (s.op && INFIX[s.op]) {
          this.text(w, `${target} = ${target} ${INFIX[s.op]} ${this.expr(s.value, KT_PRECEDENCE[s.op] + 1)}`);
        } else {
          this.text(w, `${target} ${s.op ? `${s.op}=` : '='} ${this.coerce(s.value, s.target.type)}`);
        }
        return;
      }
      case 'return':
        this.text(w, s.value ? `return ${this.coerce(s.value, this.currentReturn)}` : 'return');
        return;
      case 'expr':
        this.text(w, this.expr(s.expr));
        return;
      case 'throw':
        this.text(w, `throw ${this.expr(s.value)}`);
        return;
      case 'forRange':
        this.forRange(w, s);
        return;
      case 'forEach': {
        const iterable = this.expr(s.iterable, CALL_PREC);
        const head = s.indexName
          ? `for ((${this.name(s.indexName)}, ${this.name(s.varName)}) in ${iterable}.withIndex())`
          : `for (${this.name(s.varName)} in ${iterable})`;
        w.braced(head, () =>
          this.withScope([s.varName, ...(s.indexName ? [s.indexName] : [])], () => this.emitBody(w, s.body)),
        );
        return;
      }
      case 'block':
        // A bare `{ }` is a lambda in Kotlin and would never run.
        w.braced('run', () => this.withScope([], () => this.emitBody(w, s.body)));
        return;
    }
  }

  /**
   * Write statement text that may span lines - a lambda, a `when`, a raw
   * expression - so every line sits at the current depth plus its own relative
   * indentation, rather than only the first.
   */
  private text(w: CodeWriter, text: string): void {
    for (const line of text.split('\n')) w.line(line);
  }

  override emitBody(w: CodeWriter, body: IrStmt[]): void {
    this.withScope([], () => {
      for (const s of body) this.stmt(w, s);
    });
  }

  protected override letStatement(s: Extract<IrStmt, { k: 'let' }>): string {
    const name = this.name(s.name);
    const fresh = !s.init ? isCollection(s.type) : createsCollection(s.init);
    const type = fresh ? this.mutableType(s.type) : this.type(s.type);
    if (fresh) this.mutableNames.add(s.name);
    const keyword = s.mutable === false ? 'val' : 'var';
    if (s.init) return `${keyword} ${name}: ${type} = ${this.coerce(s.init, s.type)}`;
    if (this.hasZero(s.type)) return `${keyword} ${name}: ${type} = ${this.zero(s.type)}`;
    return `lateinit var ${name}: ${type}`;
  }

  private forRange(w: CodeWriter, s: Extract<IrStmt, { k: 'forRange' }>): void {
    const v = this.name(s.varName);
    const start = this.expr(s.start, 7);
    const end = this.expr(s.end, 7);
    const step = s.step;
    let head: string;
    if (!step || (step.k === 'lit' && step.value.t === 'int' && Number(step.value.v) === 1)) {
      head = `for (${v} in ${start} ${s.inclusive ? '..' : 'until'} ${end})`;
    } else if (step.k === 'lit' && step.value.t === 'int' && Number(step.value.v) < 0) {
      // Counting down: `downTo` takes a positive step, and an exclusive bound
      // stops one short of the end.
      const by = this.literalInt(-Number(step.value.v), s.start.type);
      const bound = s.inclusive ? end : `${end} + ${this.literalInt(1, s.end.type)}`;
      head = `for (${v} in ${start} downTo ${bound}${by === '1' || by === '1L' ? '' : ` step ${by}`})`;
    } else {
      head = `for (${v} in ${start} ${s.inclusive ? '..' : 'until'} ${end} step ${this.expr(step, 7)})`;
    }
    w.braced(head, () => this.withScope([s.varName], () => this.emitBody(w, s.body)));
  }

  protected override switchStmt(w: CodeWriter, s: Extract<IrStmt, { k: 'switch' }>): void {
    w.braced(`when (${this.expr(s.subject)})`, () => {
      for (const c of s.cases) {
        w.braced(`${c.match.map((m) => this.expr(m)).join(', ')} ->`, () => this.emitBody(w, c.body));
      }
      if (s.default?.length) w.braced('else ->', () => this.emitBody(w, s.default!));
    });
  }

  protected override tryStmt(w: CodeWriter, s: Extract<IrStmt, { k: 'try' }>): void {
    w.line('try {');
    w.nest(() => this.emitBody(w, s.body));
    for (const c of s.catches) {
      w.line(`} catch (${this.catchClause(c)}) {`);
      w.nest(() => this.withScope([c.varName], () => this.emitBody(w, c.body)));
    }
    if (s.finally?.length) {
      w.line('} finally {');
      w.nest(() => this.emitBody(w, s.finally!));
    } else if (!s.catches.length) {
      // `try` alone is not Kotlin; with nothing to catch or clean up it is a block.
      w.line('} finally {');
    }
    w.line('}');
  }

  protected override catchClause(c: { errType?: TypeRef; varName: string }): string {
    return `${this.name(c.varName)}: ${c.errType ? this.type(c.errType) : 'Exception'}`;
  }

  // -- expressions -----------------------------------------------------------

  protected override precOf(e: IrExpr): number {
    switch (e.k) {
      case 'binary':
        return e.op === '**' ? CALL_PREC : (KT_PRECEDENCE[e.op] ?? 5);
      case 'unary':
        return UNARY_PREC;
      case 'ternary':
      case 'lambda':
        return 0.5;
      case 'cast':
        return e.to.kind === 'named' || e.to.kind === 'any' ? 10 : CALL_PREC;
      default:
        // Builtins render as an atom or parenthesise themselves.
        return 20;
    }
  }

  protected override exprInner(e: IrExpr): string {
    switch (e.k) {
      case 'lit':
        return this.typedLiteral(e);
      case 'ref':
        if (e.type.kind === 'function' && !this.inScope(e.name) && this.facts.functions.has(e.name)) {
          return `::${this.name(e.name)}`;
        }
        return this.facts.constants.has(e.name) && !this.inScope(e.name) ? screamingSnake(e.name) : this.name(e.name);
      case 'symbol': {
        const resolved = this.ctx.resolveSymbol(e.name, e.from);
        const spelled = this.symbolSpelling(resolved?.reference ?? e.name);
        return e.type.kind === 'function' && this.facts.functions.has(e.name) ? `::${spelled}` : spelled;
      }
      case 'unary':
        return e.op === '~' ? `${this.expr(e.operand, CALL_PREC)}.inv()` : `${e.op}${this.expr(e.operand, UNARY_PREC)}`;
      case 'call':
        return this.callExpr(e);
      case 'method':
        return `${this.expr(e.target, CALL_PREC)}.${this.name(e.name)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      case 'member':
        return `${this.expr(e.target, CALL_PREC)}.${this.memberName(e.name, e)}`;
      case 'index': {
        const target = this.expr(e.target, CALL_PREC);
        const keyed = e.target.type.kind === 'map';
        const index = keyed ? this.expr(e.index) : this.asInt(e.index);
        return e.target.type.kind === 'primitive' && e.target.type.name === 'string'
          ? `${target}[${index}].toString()`
          : `${target}[${index}]`;
      }
      case 'ternary':
        return `if (${this.expr(e.cond)}) ${this.coerce(e.then, e.type, 1)} else ${this.coerce(e.else, e.type, 1)}`;
      default:
        return super.exprInner(e);
    }
  }

  protected override memberName(name: string, e: IrExpr): string {
    if (e.k === 'member' && (e.target.k === 'symbol' || e.target.k === 'ref')) {
      const owner = this.facts.enums.get(e.target.name);
      if (owner && !owner.variants.some((v) => v.payload?.length)) return screamingSnake(name);
    }
    return this.name(name);
  }

  protected override symbolName(name: string): string {
    return this.symbolSpelling(name);
  }

  protected override binary(e: Extract<IrExpr, { k: 'binary' }>): string {
    if (e.op === '**') {
      this.need('kotlin.math.pow');
      return this.dialect.power(this.expr(e.left, CALL_PREC), this.expr(e.right, CALL_PREC));
    }
    const p = KT_PRECEDENCE[e.op] ?? 5;
    const infix = INFIX[e.op];
    if (infix) {
      // All infix functions share one level and associate left, so an operand
      // that is itself infix is parenthesised rather than trusted to bind.
      return `${this.expr(e.left, p + 1)} ${infix} ${this.expr(e.right, p + 1)}`;
    }
    const leftText = this.expr(e.left, p);
    const rightText = this.expr(e.right, p + 1);
    const isText = e.type.kind === 'primitive' && e.type.name === 'string' && e.op === '+';
    if (isText && !isString(e.left.type)) {
      // `1 + "a"` is not Kotlin: Int has no plus(String).
      return `${this.expr(e.left, CALL_PREC)}.toString() + ${rightText}`;
    }
    if ((e.op === '==' || e.op === '!=') && isNumeric(e.left.type) && isNumeric(e.right.type)) {
      // `Long == Int` does not compile; compare in the wider type.
      const wide = widerNumeric(e.left.type, e.right.type);
      return `${this.coerce(e.left, wide, p)} ${e.op} ${this.coerce(e.right, wide, p + 1)}`;
    }
    return `${leftText} ${e.op} ${rightText}`;
  }

  private callExpr(e: Extract<IrExpr, { k: 'call' }>): string {
    let callee: string;
    if (e.callee.k === 'ref' || e.callee.k === 'symbol') {
      const resolved = e.callee.k === 'symbol' ? this.ctx.resolveSymbol(e.callee.name, e.callee.from) : undefined;
      callee = this.symbolSpelling(resolved?.reference ?? e.callee.name);
    } else {
      callee = this.expr(e.callee, CALL_PREC);
    }
    const params = e.callee.type.kind === 'function' ? e.callee.type.params : [];
    const args = e.args.map((a, i) => this.coerce(a, params[i])).join(', ');
    return `${callee}(${args})`;
  }

  protected override newExpr(e: Extract<IrExpr, { k: 'new' }>): string {
    const cls = this.facts.classes.get(e.className);
    const params = cls?.ctor?.params.map((p) => p.type) ?? (cls?.shape === 'record' || cls?.shape === 'struct' ? cls.fields.filter((f) => !f.isStatic).map((f) => f.type) : []);
    return `${this.resolvedType(e.className)}(${e.args.map((a, i) => this.coerce(a, params[i])).join(', ')})`;
  }

  protected override arrayLit(e: Extract<IrExpr, { k: 'array' }>): string {
    const item = e.type.kind === 'list' ? e.type.item : T.any;
    return `mutableListOf<${this.type(item)}>(${e.items.map((i) => this.coerce(i, item)).join(', ')})`;
  }

  protected override mapLit(e: Extract<IrExpr, { k: 'mapLit' }>): string {
    const [k, v] = e.type.kind === 'map' ? [e.type.key, e.type.value] : [T.string, T.any];
    const entries = e.entries.map((en) => `${this.coerce(en.key, k, 7)} to ${this.coerce(en.value, v, 7)}`);
    return `mutableMapOf<${this.type(k)}, ${this.type(v)}>(${entries.join(', ')})`;
  }

  protected override tupleLit(e: Extract<IrExpr, { k: 'tupleLit' }>): string {
    return `listOf<Any?>(${e.items.map((i) => this.expr(i)).join(', ')})`;
  }

  protected override lambda(e: Extract<IrExpr, { k: 'lambda' }>): string {
    const returns = e.type.kind === 'function' ? e.type.returns : T.any;
    const params = e.params.map((p) => `${this.name(p.name)}: ${this.type(p.type)}`).join(', ');
    if (!Array.isArray(e.body)) {
      const body = this.withScope(e.params.map((p) => p.name), () => this.coerce(e.body as IrExpr, returns));
      return `{ ${params}${params ? ' -> ' : ''}${body} }`;
    }
    // A statement body uses `return`, which inside a lambda would return from
    // the enclosing function. An anonymous function scopes it correctly.
    const inner = new CodeWriter('    ');
    const saved = this.currentReturn;
    this.currentReturn = returns;
    this.withScope(e.params.map((p) => p.name), () => this.emitBody(inner, e.body as IrStmt[]));
    this.currentReturn = saved;
    const ret = returns.kind === 'void' ? '' : `: ${this.type(returns)}`;
    return `fun(${params})${ret} {\n${inner.toString().replace(/\n$/, '')}\n}`;
  }

  protected override cast(e: Extract<IrExpr, { k: 'cast' }>): string {
    const from = e.expr.type;
    if (e.to.kind === 'primitive') {
      switch (e.to.name) {
        case 'string':
          return `${this.expr(e.expr, CALL_PREC)}.toString()`;
        case 'i32':
        case 'i64':
        case 'f32':
        case 'f64': {
          const fn = { i32: 'toInt', i64: 'toLong', f32: 'toFloat', f64: 'toDouble' }[e.to.name];
          if (isNumeric(from)) return `${this.expr(e.expr, CALL_PREC)}.${fn}()`;
          if (isString(from)) return `${this.expr(e.expr, CALL_PREC)}.trim().toDouble().${fn}()`;
          return `${this.use('mcToDouble')}(${this.expr(e.expr)}).${fn}()`;
        }
        case 'bool':
          return isString(from) ? `${this.expr(e.expr, CALL_PREC)}.toBoolean()` : `(${this.expr(e.expr)} as Boolean)`;
      }
    }
    return `${this.expr(e.expr, 11)} as ${this.type(e.to)}`;
  }

  protected override awaitExpr(e: Extract<IrExpr, { k: 'await' }>): string {
    // Calling a suspend function is the await; only a Deferred needs `.await()`.
    if (e.expr.type.kind === 'future') return `${this.expr(e.expr, CALL_PREC)}.await()`;
    return this.expr(e.expr);
  }

  private typedLiteral(e: Extract<IrExpr, { k: 'lit' }>): string {
    const v = e.value;
    switch (v.t) {
      case 'int':
        return this.literalInt(v.v, e.type);
      case 'float':
        return e.type.kind === 'primitive' && e.type.name === 'f32' ? `${v.v}f` : floatText(v.v);
      case 'string':
        return kString(v.v);
      case 'char':
        return `'${v.v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      default:
        return this.literal(v);
    }
  }

  private literalInt(v: number | string, type: TypeRef): string {
    if (type.kind === 'primitive') {
      if (type.name === 'i32') return String(v);
      if (type.name === 'f64') return floatText(Number(v));
      if (type.name === 'f32') return `${v}f`;
    }
    return `${v}L`;
  }

  /** An index expression as the `Int` Kotlin collections take. */
  private asInt(e: IrExpr): string {
    if (e.k === 'lit' && e.value.t === 'int') return String(e.value.v);
    if (e.type.kind === 'primitive' && e.type.name === 'i32') return this.expr(e);
    return `${this.expr(e, CALL_PREC)}.toInt()`;
  }

  /**
   * Render `e` for a slot of type `to`, converting where Kotlin will not.
   *
   * Only the conversions the IR's assignability rules allow are made: integer
   * widening into a wider integer or a float, and rendering a value as text.
   * Anything else is left alone for kotlinc to judge.
   */
  private coerce(e: IrExpr, to: TypeRef | undefined, prec = 0): string {
    if (!to) return this.expr(e, prec);
    const from = e.type;
    if (e.k === 'lit' && e.value.t === 'int' && to.kind === 'primitive' && isNumeric(to)) {
      return this.literalInt(e.value.v, to);
    }
    if (e.k === 'lit' && e.value.t === 'float' && to.kind === 'primitive' && to.name === 'f32') {
      return `${e.value.v}f`;
    }
    if (from.kind === 'primitive' && to.kind === 'primitive' && from.name !== to.name) {
      if (isInteger(from) && isNumeric(to)) {
        const fn = { i32: 'toInt', i64: 'toLong', f32: 'toFloat', f64: 'toDouble' }[to.name as 'i32'];
        if (fn) return `${this.expr(e, CALL_PREC)}.${fn}()`;
      }
      if (from.name === 'f32' && to.name === 'f64') return `${this.expr(e, CALL_PREC)}.toDouble()`;
      if (to.name === 'string') return `${this.expr(e, CALL_PREC)}.toString()`;
    }
    if (to.kind === 'primitive' && to.name === 'string' && from.kind !== 'primitive' && from.kind !== 'any' && !nullable(from)) {
      return `${this.expr(e, CALL_PREC)}.toString()`;
    }
    return this.expr(e, prec);
  }

  /** The receiver of a mutating builtin, cast when it was not declared mutable. */
  private mutable(e: IrExpr): string {
    const known =
      (e.k === 'ref' && this.mutableNames.has(e.name)) ||
      (e.k === 'member' && e.target.k === 'self' && this.mutableNames.has(`.${e.name}`)) ||
      createsCollection(e);
    const text = this.expr(e, CALL_PREC);
    if (known) return text;
    return `(${text} as ${this.mutableType(e.type)})`;
  }

  // -- builtins --------------------------------------------------------------

  override builtin(e: Extract<IrExpr, { k: 'builtin' }>): string {
    const spec = getBuiltin(e.op);
    const P = (i: number, prec = CALL_PREC): string => {
      const param = spec?.params[Math.min(i, (spec?.params.length ?? 1) - 1)];
      const concrete = param && param.kind === 'primitive' ? param : undefined;
      return concrete ? this.coerce(e.args[i], concrete, prec) : this.expr(e.args[i], prec);
    };
    const A = (i: number): string => P(i, 0);
    const R = (name: string): string => this.use(name);
    const arg = (i: number): IrExpr => e.args[i];
    const listItem = (i: number): TypeRef => {
      const t = arg(i)?.type;
      return t?.kind === 'list' || t?.kind === 'set' ? t.item : T.any;
    };
    const resultItem = (): TypeRef => (e.type.kind === 'list' || e.type.kind === 'set' ? e.type.item : T.any);
    const math = (fn: string): string => {
      this.need(`kotlin.math.${fn}`);
      return fn;
    };

    switch (e.op) {
      case 'print':
        return e.args.length <= 1 ? `println(${e.args.length ? A(0) : ''})` : `println(listOf<Any?>(${e.args.map((_, i) => A(i)).join(', ')}).joinToString(" "))`;
      case 'print_err':
        return `System.err.println(${e.args.length <= 1 ? (e.args.length ? A(0) : '""') : `listOf<Any?>(${e.args.map((_, i) => A(i)).join(', ')}).joinToString(" ")`})`;
      case 'read_line':
        return '(readlnOrNull() ?: "")';

      case 'to_string':
        return `${P(0)}.toString()`;
      case 'to_int':
        if (isNumeric(arg(0).type)) return `${P(0)}.toLong()`;
        return `${R('mcToDouble')}(${A(0)}).toLong()`;
      case 'to_float':
        if (isNumeric(arg(0).type)) return `${P(0)}.toDouble()`;
        return `${R('mcToDouble')}(${A(0)})`;
      case 'parse_int':
        return `${P(0)}.trim().toLongOrNull()`;
      case 'parse_float':
        return `${P(0)}.trim().toDoubleOrNull()`;

      case 'len':
        return this.sizeOf(arg(0));
      case 'is_empty':
        return isSized(arg(0).type) ? `${P(0)}.isEmpty()` : `(${R('mcLength')}(${A(0)}) == 0L)`;

      case 'str_concat':
        return `(${P(0, 8)} + ${P(1, 9)})`;
      case 'str_upper':
        return `${P(0)}.uppercase()`;
      case 'str_lower':
        return `${P(0)}.lowercase()`;
      case 'str_trim':
        return `${P(0)}.trim()`;
      case 'str_split':
        return `${P(0)}.split(${A(1)}).toMutableList()`;
      case 'str_join':
        return `${P(0)}.joinToString(${A(1)})`;
      case 'str_replace':
        return `${P(0)}.replace(${A(1)}, ${A(2)})`;
      case 'str_contains':
        return `${P(0)}.contains(${A(1)})`;
      case 'str_starts_with':
        return `${P(0)}.startsWith(${A(1)})`;
      case 'str_ends_with':
        return `${P(0)}.endsWith(${A(1)})`;
      case 'str_index_of':
        return `${P(0)}.indexOf(${A(1)}).toLong()`;
      case 'str_substring':
        return `${R('mcSubstring')}(${A(0)}, ${A(1)}, ${A(2)})`;
      case 'str_char_at':
        return `${P(0)}[${this.asInt(arg(1))}].toString()`;
      case 'str_repeat':
        return `${P(0)}.repeat(${this.asInt(arg(1))})`;
      case 'str_pad_left':
        return `${R('mcPadLeft')}(${A(0)}, ${A(1)}, ${A(2)})`;
      case 'format':
        return `${R('mcFormat')}(${e.args.map((_, i) => A(i)).join(', ')})`;

      case 'list_new':
        return `mutableListOf<${this.type(resultItem())}>()`;
      case 'list_get':
        return `${P(0)}[${this.asInt(arg(1))}]`;
      case 'list_set':
        return `${this.mutable(arg(0))}.set(${this.asInt(arg(1))}, ${this.coerce(arg(2), listItem(0))})`;
      case 'list_push':
        return `${this.mutable(arg(0))}.add(${this.coerce(arg(1), listItem(0))})`;
      case 'list_pop':
        return `${this.mutable(arg(0))}.removeLastOrNull()`;
      case 'list_insert':
        return `${this.mutable(arg(0))}.add(${this.asInt(arg(1))}, ${this.coerce(arg(2), listItem(0))})`;
      case 'list_remove_at':
        return `${this.mutable(arg(0))}.removeAt(${this.asInt(arg(1))})`;
      case 'list_contains':
        return `${P(0)}.contains(${A(1)})`;
      case 'list_index_of':
        return `${P(0)}.indexOf(${A(1)}).toLong()`;
      case 'list_slice':
        return `${R('mcSlice')}(${A(0)}, ${A(1)}, ${A(2)})`;
      case 'list_concat':
        return `(${P(0, 8)} + ${P(1, 9)}).toMutableList()`;
      case 'list_reverse':
        return `${P(0)}.reversed().toMutableList()`;
      case 'list_sort':
        return isComparable(listItem(0)) ? `${P(0)}.sorted().toMutableList()` : `${R('mcSorted')}(${A(0)})`;
      case 'list_sort_by':
        return `${P(0)}.sortedBy(${A(1)}).toMutableList()`;
      case 'list_map':
        return `${P(0)}.map(${A(1)}).toMutableList()`;
      case 'list_filter':
        return `${P(0)}.filter(${A(1)}).toMutableList()`;
      case 'list_reduce':
        return `${P(0)}.fold(${A(2)}, ${A(1)})`;
      case 'list_any':
        return `${P(0)}.any(${A(1)})`;
      case 'list_all':
        return `${P(0)}.all(${A(1)})`;
      case 'list_find':
        return `${P(0)}.firstOrNull(${A(1)})`;
      case 'list_sum':
        return `${P(0)}.sumOf { it.toDouble() }`;
      case 'list_min':
        return `${P(0)}.minOfOrNull { it.toDouble() }`;
      case 'list_max':
        return `${P(0)}.maxOfOrNull { it.toDouble() }`;
      case 'list_unique':
        return `${P(0)}.distinct().toMutableList()`;
      case 'list_range':
        return `(${P(0, 8)} until ${P(1, 8)}).toMutableList()`;

      case 'map_new': {
        const [k, v] = e.type.kind === 'map' ? [e.type.key, e.type.value] : [T.string, T.any];
        return `mutableMapOf<${this.type(k)}, ${this.type(v)}>()`;
      }
      case 'map_get':
        return `${P(0)}[${A(1)}]`;
      case 'map_get_or':
        return `${P(0)}.getOrElse(${A(1)}) { ${A(2)} }`;
      case 'map_set':
        return `${this.mutable(arg(0))}.put(${A(1)}, ${A(2)})`;
      case 'map_has':
        return `${P(0)}.containsKey(${A(1)})`;
      case 'map_remove':
        return `${this.mutable(arg(0))}.remove(${A(1)})`;
      case 'map_keys':
        return `${P(0)}.keys.toMutableList()`;
      case 'map_values':
        return `${P(0)}.values.toMutableList()`;

      case 'set_new':
        return `mutableSetOf<${this.type(resultItem())}>()`;
      case 'set_add':
        return `${this.mutable(arg(0))}.add(${this.coerce(arg(1), listItem(0))})`;
      case 'set_has':
        return `${P(0)}.contains(${A(1)})`;
      case 'set_remove':
        return `${this.mutable(arg(0))}.remove(${A(1)})`;
      case 'set_to_list':
        return `${P(0)}.toMutableList()`;

      case 'math_abs':
        return `${math('abs')}(${A(0)})`;
      case 'math_floor':
        return `${math('floor')}(${A(0)}).toLong()`;
      case 'math_ceil':
        return `${math('ceil')}(${A(0)}).toLong()`;
      case 'math_round':
        return `${R('mcRound')}(${A(0)})`;
      case 'math_sqrt':
        return `${math('sqrt')}(${A(0)})`;
      case 'math_pow':
        math('pow');
        return `${P(0)}.pow(${A(1)})`;
      case 'math_min':
        return `minOf(${A(0)}, ${A(1)})`;
      case 'math_max':
        return `maxOf(${A(0)}, ${A(1)})`;
      case 'math_log':
        return `${math('ln')}(${A(0)})`;
      case 'math_exp':
        return `${math('exp')}(${A(0)})`;
      case 'math_sin':
        return `${math('sin')}(${A(0)})`;
      case 'math_cos':
        return `${math('cos')}(${A(0)})`;
      case 'math_tan':
        return `${math('tan')}(${A(0)})`;
      case 'math_atan2':
        return `${math('atan2')}(${A(0)}, ${A(1)})`;
      case 'math_idiv':
        return `(${P(0, 9)} / ${P(1, 10)})`;
      case 'math_pi':
        return math('PI');

      case 'json_parse':
        return `${R('mcJsonParse')}(${A(0)})`;
      case 'json_stringify':
        return `${R('mcJsonStringify')}(${A(0)}, ${A(1)})`;
      case 'json_get':
        return `(${this.expr(arg(0), CALL_PREC)} as? Map<*, *>)?.get(${A(1)})`;
      case 'json_as_string':
        return `${this.expr(arg(0), CALL_PREC)}.toString()`;
      case 'json_as_number':
        return `${R('mcToDouble')}(${A(0)})`;
      case 'json_as_list':
        return `((${this.expr(arg(0), CALL_PREC)} as? List<*>)?.toMutableList<Any?>() ?: mutableListOf())`;
      case 'json_path':
        return `${R('mcJsonPath')}(${A(0)}, ${A(1)})`;

      case 'file_read_text':
        return `java.io.File(${A(0)}).readText()`;
      case 'file_write_text':
        return `java.io.File(${A(0)}).writeText(${A(1)})`;
      case 'file_append_text':
        return `java.io.File(${A(0)}).appendText(${A(1)})`;
      case 'file_exists':
        return `java.io.File(${A(0)}).exists()`;
      case 'file_delete':
        return `java.io.File(${A(0)}).delete()`;
      case 'dir_list':
        return `(java.io.File(${A(0)}).list()?.sorted()?.toMutableList() ?: mutableListOf())`;
      case 'dir_create':
        return `java.io.File(${A(0)}).mkdirs()`;
      case 'path_join':
        return `java.io.File(${A(0)}, ${A(1)}).path`;

      case 'http_request':
        return `${R('mcHttpRequest')}(${A(0)}, ${A(1)}, ${A(2)}, ${A(3)})`;
      case 'http_serve':
        this.jvmOnly(e, 'Android apps do not open listening sockets this way; use a foreground service.');
        return `${R('mcServe')}(${A(0)}, ${A(1)}, ${A(2)})`;
      case 'http_reply':
        return `${R('McHttpReply')}(${A(0)}, ${A(1)}, ${A(2)})`;
      case 'schedule_every':
        return `${R('mcScheduleEvery')}(${A(0)}, ${A(1)})`;
      case 'parallel_map':
        return `${R('mcParallelMap')}(${A(0)}, ${A(1)}, ${A(2)})`;
      case 'parallel_all':
        return `${R('mcParallelAll')}(${A(0)}, ${A(1)})`;

      case 'db_open':
        this.jvmOnly(e, 'Android has no JDBC driver; use Room.');
        return `${R('mcDbOpen')}(${A(0)})`;
      case 'db_execute':
        this.jvmOnly(e, 'Android has no JDBC driver; use Room.');
        return `${R('mcDbExecute')}(${A(0)}, ${A(1)}, ${A(2)})`;
      case 'db_query':
        this.jvmOnly(e, 'Android has no JDBC driver; use Room.');
        return `${R('mcDbQuery')}(${A(0)}, ${A(1)}, ${A(2)})`;
      case 'db_close':
        this.jvmOnly(e, 'Android has no JDBC driver; use Room.');
        return `${P(0)}.close()`;

      case 'env_get':
        return `System.getenv(${A(0)})`;
      case 'args_get':
        return `${R('mcArgs')}()`;
      case 'time_now_ms':
        return 'System.currentTimeMillis()';
      case 'time_sleep_ms':
        return `Thread.sleep(${A(0)})`;
      case 'random_float':
        return 'kotlin.random.Random.nextDouble()';
      case 'random_int':
        return `kotlin.random.Random.nextLong(${A(0)}, ${A(1)})`;

      case 'error_new':
        return `Exception(${A(0)})`;
      case 'error_message':
        return `(${this.expr(arg(0), CALL_PREC)}.message ?: ${this.expr(arg(0), CALL_PREC)}.toString())`;
      case 'assert':
        return `${R('mcCheck')}(${A(0)}, ${A(1)})`;
      case 'assert_eq':
        return `${R('mcCheckEqual')}(${A(0)}, ${A(1)}, ${A(2)})`;

      case 'option_or':
        return `(${this.expr(arg(0), 6)} ?: ${this.expr(arg(1), 6)})`;
      case 'option_is_some':
        return `(${this.expr(arg(0), 4)} != null)`;
      case 'option_unwrap':
        return `(${this.expr(arg(0), 6)} ?: throw IllegalStateException(${A(1)}))`;

      case 'regex_match':
        return `Regex(${A(1)}).containsMatchIn(${A(0)})`;
      case 'regex_find_all':
        return `Regex(${A(1)}).findAll(${A(0)}).map { it.value }.toMutableList()`;
      case 'regex_capture':
        return `(Regex(${A(1)}).find(${A(0)})?.groupValues?.toMutableList() ?: mutableListOf())`;
      case 'regex_replace':
        return `${R('mcRegexReplace')}(${A(0)}, ${A(1)}, ${A(2)})`;
      case 'regex_split':
        return `Regex(${A(1)}).split(${A(0)}).toMutableList()`;

      case 'base64_encode':
        return `java.util.Base64.getEncoder().encodeToString(${P(0)}.toByteArray(Charsets.UTF_8))`;
      case 'base64_decode':
        return `String(java.util.Base64.getDecoder().decode(${A(0)}), Charsets.UTF_8)`;
      case 'hex_encode':
        return `${R('mcHex')}(${P(0)}.toByteArray(Charsets.UTF_8))`;
      case 'url_encode':
        return `${R('mcUrlEncode')}(${A(0)})`;
      case 'url_decode':
        return `${R('mcUrlDecode')}(${A(0)})`;
      case 'hash_sha256':
        return `${R('mcDigest')}("SHA-256", ${A(0)})`;
      case 'hash_sha1':
        return `${R('mcDigest')}("SHA-1", ${A(0)})`;
      case 'hash_md5':
        return `${R('mcDigest')}("MD5", ${A(0)})`;
      case 'hmac_sha256':
        return `${R('mcHmacSha256')}(${A(0)}, ${A(1)})`;
      case 'uuid_v4':
        return 'java.util.UUID.randomUUID().toString()';
      case 'time_now_iso':
        return `${R('mcIsoFormat')}(System.currentTimeMillis())`;
      case 'time_parse_iso':
        return `${R('mcIsoParse')}(${A(0)})`;
      case 'time_format_iso':
        return `${R('mcIsoFormat')}(${A(0)})`;

      default:
        throw new BackendGenError(`The Kotlin backend does not implement the "${e.op}" operation.`, {
          code: 'codegen/unsupported-builtin',
          origin: e.origin,
          hint: e.op.startsWith('dom_') ? 'DOM operations exist only in browser languages.' : undefined,
        });
    }
  }

  private sizeOf(e: IrExpr): string {
    const t = e.type;
    if (isString(t)) return `${this.expr(e, CALL_PREC)}.length.toLong()`;
    if (isSized(t) || (t.kind === 'primitive' && t.name === 'bytes')) return `${this.expr(e, CALL_PREC)}.size.toLong()`;
    return `${this.use('mcLength')}(${this.expr(e)})`;
  }

  private jvmOnly(e: IrExpr, why: string): void {
    if (!this.android) return;
    throw new BackendGenError(`This operation is not available in an Android module. ${why}`, {
      code: 'codegen/kotlin-jvm-only',
      origin: e.origin,
    });
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isString(t: TypeRef): boolean {
  return t.kind === 'primitive' && t.name === 'string';
}

function isCollection(t: TypeRef): boolean {
  return t.kind === 'list' || t.kind === 'set' || t.kind === 'map';
}

function isSized(t: TypeRef): boolean {
  return isString(t) || isCollection(t);
}

function nullable(t: TypeRef): boolean {
  return t.kind === 'option' || t.kind === 'any' || (t.kind === 'named' && t.name === 'Json');
}

function isComparable(t: TypeRef): boolean {
  return t.kind === 'primitive' && t.name !== 'bytes';
}

function widerNumeric(a: TypeRef, b: TypeRef): TypeRef {
  const rank = (t: TypeRef): number => (t.kind === 'primitive' ? ({ i32: 1, i64: 2, f32: 3, f64: 4 }[t.name as 'i32'] ?? 0) : 0);
  return rank(a) >= rank(b) ? a : b;
}

/** Expressions whose value is a collection nothing else holds a reference to. */
function createsCollection(e: IrExpr): boolean {
  if (e.k === 'array' || e.k === 'mapLit') return true;
  if (e.k !== 'builtin') return false;
  return [
    'list_new', 'map_new', 'set_new', 'str_split', 'list_slice', 'list_concat', 'list_reverse', 'list_sort',
    'list_sort_by', 'list_map', 'list_filter', 'list_unique', 'list_range', 'map_keys', 'map_values',
    'set_to_list', 'regex_find_all', 'regex_split', 'dir_list', 'json_as_list', 'parallel_map', 'parallel_all',
  ].includes(e.op);
}

/** The field a statement copies a same-named parameter into (`this.x = x`), if that is all it does. */
function copiedField(s: IrStmt): string | undefined {
  if (s.k !== 'assign' || s.op || s.target.k !== 'member' || s.target.target.k !== 'self') return undefined;
  return s.value.k === 'ref' && s.value.name === s.target.name ? s.target.name : undefined;
}

function endsInJump(body: IrStmt[]): boolean {
  const last = body[body.length - 1];
  return !!last && (last.k === 'return' || last.k === 'throw');
}

function usesOp(f: IrFunction, op: string): boolean {
  let found = false;
  walkModule({ id: '', name: '', path: '', imports: [], decls: [f] }, {
    expr: (e) => {
      if (e.k === 'builtin' && e.op === op) found = true;
    },
  });
  return found;
}

function floatText(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? 'Double.POSITIVE_INFINITY' : v < 0 ? 'Double.NEGATIVE_INFINITY' : 'Double.NaN';
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

/** A Kotlin string literal: C escapes, plus `$`, which would start a template. */
function kString(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '$') out += '\\$';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function packageOf(fqn: string): string {
  const name = fqn.split(' as ')[0];
  return name.slice(0, Math.max(0, name.lastIndexOf('.')));
}

/** Packages every Kotlin file imports implicitly. */
const DEFAULT_PACKAGES = new Set([
  'kotlin', 'kotlin.annotation', 'kotlin.collections', 'kotlin.comparisons', 'kotlin.io', 'kotlin.ranges',
  'kotlin.sequences', 'kotlin.text', 'java.lang',
]);

function isDefaultImport(fqn: string): boolean {
  return !fqn.includes(' as ') && DEFAULT_PACKAGES.has(packageOf(fqn));
}

// ---------------------------------------------------------------------------
// Runtime support
//
// Each helper is emitted only when something calls it, and only into the
// Gradle module whose files call it: `internal` visibility stops at a module
// boundary, and two modules shipping the same class would collide when the
// app is packaged.
// ---------------------------------------------------------------------------

interface Helper {
  code: string;
  imports?: string[];
  needs?: string[];
  /** A different body for Android, where java.net.http does not exist. */
  android?: string;
  androidImports?: string[];
}

const HELPERS: Record<string, Helper> = {
  mcSetArgs: {
    needs: ['mcArgs'],
    code: String.raw`
internal fun mcSetArgs(args: Array<String>) {
    programArgs = args.toList()
}`,
  },
  mcArgs: {
    code: String.raw`
private var programArgs: List<String> = emptyList()

/** Command-line arguments, excluding the program name. */
internal fun mcArgs(): MutableList<String> = programArgs.toMutableList()`,
  },
  mcToDouble: {
    code: String.raw`
/** A number from whatever the value is: numbers convert, text parses, anything else is 0. */
internal fun mcToDouble(value: Any?): Double = when (value) {
    is Number -> value.toDouble()
    is Boolean -> if (value) 1.0 else 0.0
    null -> 0.0
    else -> value.toString().trim().toDoubleOrNull() ?: 0.0
}`,
  },
  mcLength: {
    code: String.raw`
internal fun mcLength(value: Any?): Long = when (value) {
    is CharSequence -> value.length.toLong()
    is Collection<*> -> value.size.toLong()
    is Map<*, *> -> value.size.toLong()
    is Array<*> -> value.size.toLong()
    is ByteArray -> value.size.toLong()
    else -> 0L
}`,
  },
  mcFormat: {
    code: String.raw`
/** Replace each {} in order with the next argument. */
internal fun mcFormat(template: String, vararg args: Any?): String {
    val out = StringBuilder()
    var next = 0
    var i = 0
    while (i < template.length) {
        if (i + 1 < template.length && template[i] == '{' && template[i + 1] == '}') {
            out.append(if (next < args.size) args[next++].toString() else "{}")
            i += 2
        } else {
            out.append(template[i])
            i += 1
        }
    }
    return out.toString()
}`,
  },
  mcSubstring: {
    code: String.raw`
/** The slice [start, end), clamped to the text rather than throwing. */
internal fun mcSubstring(text: String, start: Long, end: Long): String {
    val from = start.coerceIn(0L, text.length.toLong()).toInt()
    val to = end.coerceIn(from.toLong(), text.length.toLong()).toInt()
    return text.substring(from, to)
}`,
  },
  mcPadLeft: {
    code: String.raw`
internal fun mcPadLeft(text: String, width: Long, fill: String): String {
    if (fill.isEmpty()) return text
    val out = StringBuilder()
    while (out.length + text.length < width) out.append(fill)
    return out.toString() + text
}`,
  },
  mcSlice: {
    code: String.raw`
/** A copy of [start, end), clamped to the list rather than throwing. */
internal fun <T> mcSlice(list: List<T>, start: Long, end: Long): MutableList<T> {
    val from = start.coerceIn(0L, list.size.toLong()).toInt()
    val to = end.coerceIn(from.toLong(), list.size.toLong()).toInt()
    return list.subList(from, to).toMutableList()
}`,
  },
  mcSorted: {
    code: String.raw`
/** Natural order where the elements have one, text order otherwise. */
@Suppress("UNCHECKED_CAST")
internal fun <T> mcSorted(list: List<T>): MutableList<T> = list.sortedWith { a, b ->
    if (a is Comparable<*> && b != null && a::class == b::class) (a as Comparable<Any>).compareTo(b as Any)
    else a.toString().compareTo(b.toString())
}.toMutableList()`,
  },
  mcRound: {
    code: String.raw`
/** Half away from zero, which is neither Kotlin's round() nor Math.round(). */
internal fun mcRound(value: Double): Long =
    if (value < 0) -Math.round(-value) else Math.round(value)`,
  },
  mcCheck: {
    code: String.raw`
internal fun mcCheck(condition: Boolean, message: String) {
    if (!condition) throw AssertionError("assertion failed: " + message)
}`,
  },
  mcCheckEqual: {
    code: String.raw`
internal fun mcCheckEqual(actual: Any?, expected: Any?, message: String) {
    val same = if (actual is Number && expected is Number) actual.toDouble() == expected.toDouble() else actual == expected
    if (!same) throw AssertionError(message + ": expected " + expected + ", got " + actual)
}`,
  },
  mcRegexReplace: {
    code: String.raw`
/**
 * Replace every match. In the replacement $1..$9 name groups and $$ is a
 * dollar; Java's own syntax differs on both, so it is translated here.
 */
internal fun mcRegexReplace(text: String, pattern: String, replacement: String): String {
    val out = StringBuilder()
    var i = 0
    while (i < replacement.length) {
        val c = replacement[i]
        if (c == '$' && i + 1 < replacement.length && replacement[i + 1] == '$') {
            out.append("\\$")
            i += 2
            continue
        }
        if (c == '\\') out.append("\\\\") else out.append(c)
        i += 1
    }
    return Regex(pattern).replace(text, out.toString())
}`,
  },
  mcHex: {
    code: String.raw`
internal fun mcHex(bytes: ByteArray): String {
    val digits = "0123456789abcdef"
    val out = StringBuilder(bytes.size * 2)
    for (b in bytes) {
        val v = b.toInt() and 0xff
        out.append(digits[v shr 4]).append(digits[v and 0x0f])
    }
    return out.toString()
}`,
  },
  mcDigest: {
    needs: ['mcHex'],
    code: String.raw`
internal fun mcDigest(algorithm: String, text: String): String =
    mcHex(java.security.MessageDigest.getInstance(algorithm).digest(text.toByteArray(Charsets.UTF_8)))`,
  },
  mcHmacSha256: {
    needs: ['mcHex'],
    code: String.raw`
internal fun mcHmacSha256(key: String, message: String): String {
    val mac = javax.crypto.Mac.getInstance("HmacSHA256")
    mac.init(javax.crypto.spec.SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return mcHex(mac.doFinal(message.toByteArray(Charsets.UTF_8)))
}`,
  },
  mcUrlEncode: {
    code: String.raw`
/** Percent-encode everything outside A-Z a-z 0-9 - _ . ~, space included. */
internal fun mcUrlEncode(text: String): String {
    val unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~"
    val out = StringBuilder()
    for (b in text.toByteArray(Charsets.UTF_8)) {
        val c = (b.toInt() and 0xff).toChar()
        if (b >= 0 && unreserved.indexOf(c) >= 0) out.append(c)
        else out.append('%').append("0123456789ABCDEF"[(b.toInt() and 0xff) shr 4]).append("0123456789ABCDEF"[b.toInt() and 0x0f])
    }
    return out.toString()
}`,
  },
  mcUrlDecode: {
    code: String.raw`
/** Reverse of mcUrlEncode; a literal + stays a +. */
internal fun mcUrlDecode(text: String): String =
    java.net.URLDecoder.decode(text.replace("+", "%2B"), "UTF-8")`,
  },
  mcIsoFormat: {
    code: String.raw`
private val isoFormat: java.time.format.DateTimeFormatter =
    java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC)

/** Milliseconds since the epoch as ISO 8601 UTC, always with milliseconds. */
internal fun mcIsoFormat(millis: Long): String = isoFormat.format(java.time.Instant.ofEpochMilli(millis))`,
  },
  mcIsoParse: {
    code: String.raw`
/** Milliseconds for an ISO 8601 timestamp; an offset is honoured, none means UTC. */
internal fun mcIsoParse(text: String): Long? {
    val value = text.trim()
    return runCatching { java.time.OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()
        ?: runCatching { java.time.Instant.parse(value).toEpochMilli() }.getOrNull()
        ?: runCatching {
            java.time.LocalDateTime.parse(value).toInstant(java.time.ZoneOffset.UTC).toEpochMilli()
        }.getOrNull()
}`,
  },
  mcJsonParse: {
    code: String.raw`
/** Parse JSON into maps, lists, strings, doubles, booleans and null. */
internal fun mcJsonParse(text: String): Any? {
    val reader = McJsonReader(text)
    val value = reader.value()
    reader.end()
    return value
}

private class McJsonReader(private val text: String) {
    private var at = 0

    fun end() {
        space()
        if (at != text.length) fail("unexpected trailing text")
    }

    fun value(): Any? {
        space()
        if (at >= text.length) fail("unexpected end of input")
        return when (text[at]) {
            '{' -> obj()
            '[' -> array()
            '"' -> string()
            't' -> word("true", true)
            'f' -> word("false", false)
            'n' -> word("null", null)
            else -> number()
        }
    }

    private fun obj(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        at += 1
        space()
        if (peek('}')) return out
        while (true) {
            space()
            val key = string()
            space()
            expect(':')
            out[key] = value()
            space()
            if (peek('}')) return out
            expect(',')
        }
    }

    private fun array(): List<Any?> {
        val out = ArrayList<Any?>()
        at += 1
        space()
        if (peek(']')) return out
        while (true) {
            out.add(value())
            space()
            if (peek(']')) return out
            expect(',')
        }
    }

    private fun string(): String {
        expect('"')
        val out = StringBuilder()
        while (at < text.length) {
            val c = text[at++]
            when (c) {
                '"' -> return out.toString()
                '\\' -> {
                    if (at >= text.length) fail("unterminated escape")
                    when (val e = text[at++]) {
                        'n' -> out.append('\n')
                        't' -> out.append('\t')
                        'r' -> out.append('\r')
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'u' -> {
                            if (at + 4 > text.length) fail("short unicode escape")
                            out.append(text.substring(at, at + 4).toInt(16).toChar())
                            at += 4
                        }
                        else -> out.append(e)
                    }
                }
                else -> out.append(c)
            }
        }
        fail("unterminated string")
    }

    private fun number(): Double {
        val start = at
        while (at < text.length && (text[at].isDigit() || text[at] in "+-.eE")) at += 1
        return text.substring(start, at).toDoubleOrNull() ?: fail("invalid number at " + start)
    }

    private fun word(word: String, value: Any?): Any? {
        if (!text.startsWith(word, at)) fail("invalid literal at " + at)
        at += word.length
        return value
    }

    private fun space() {
        while (at < text.length && text[at].isWhitespace()) at += 1
    }

    private fun peek(c: Char): Boolean {
        if (at < text.length && text[at] == c) {
            at += 1
            return true
        }
        return false
    }

    private fun expect(c: Char) {
        if (!peek(c)) fail("expected '" + c + "' at " + at)
    }

    private fun fail(message: String): Nothing = throw IllegalArgumentException("invalid JSON: " + message)
}`,
  },
  mcJsonStringify: {
    code: String.raw`
/** Serialise maps, lists, strings, numbers, booleans and null as JSON. */
internal fun mcJsonStringify(value: Any?, pretty: Boolean): String {
    val out = StringBuilder()
    mcJsonWrite(out, value, if (pretty) 0 else -1)
    return out.toString()
}

private fun mcJsonWrite(out: StringBuilder, value: Any?, depth: Int) {
    val pad = { d: Int -> if (depth >= 0) out.append('\n').append("  ".repeat(d)) }
    when (value) {
        null -> out.append("null")
        is Boolean -> out.append(value)
        is Int, is Long, is Short, is Byte -> out.append(value)
        is Number -> {
            val d = value.toDouble()
            if (d == Math.floor(d) && !d.isInfinite() && Math.abs(d) < 1e15) out.append(d.toLong()) else out.append(d)
        }
        is Map<*, *> -> {
            out.append('{')
            var first = true
            for ((k, v) in value) {
                if (!first) out.append(',')
                first = false
                pad(depth + 1)
                mcJsonWrite(out, k.toString(), depth)
                out.append(if (depth >= 0) ": " else ":")
                mcJsonWrite(out, v, if (depth >= 0) depth + 1 else -1)
            }
            if (!first) pad(depth)
            out.append('}')
        }
        is Iterable<*> -> {
            out.append('[')
            var first = true
            for (v in value) {
                if (!first) out.append(',')
                first = false
                pad(depth + 1)
                mcJsonWrite(out, v, if (depth >= 0) depth + 1 else -1)
            }
            if (!first) pad(depth)
            out.append(']')
        }
        else -> {
            out.append('"')
            for (c in value.toString()) {
                when {
                    c == '"' -> out.append("\\\"")
                    c == '\\' -> out.append("\\\\")
                    c == '\n' -> out.append("\\n")
                    c == '\r' -> out.append("\\r")
                    c == '\t' -> out.append("\\t")
                    c < ' ' -> out.append(String.format("\\u%04x", c.code))
                    else -> out.append(c)
                }
            }
            out.append('"')
        }
    }
}`,
  },
  mcJsonPath: {
    code: String.raw`
/** Follow a dotted path such as items[0].id; null as soon as a step is missing. */
internal fun mcJsonPath(value: Any?, path: String): Any? {
    var current = value
    for (step in path.split('.')) {
        if (step.isEmpty()) continue
        val name = step.substringBefore('[')
        if (name.isNotEmpty()) current = (current as? Map<*, *>)?.get(name) ?: return null
        for (match in Regex("\\[(\\d+)]").findAll(step)) {
            val list = current as? List<*> ?: return null
            current = list.getOrNull(match.groupValues[1].toInt()) ?: return null
        }
    }
    return current
}`,
  },
  McHttpResponse: {
    code: String.raw`
/** Outcome of an HTTP request. A transport failure arrives as status 0 with the reason as the body. */
internal data class McHttpResponse(val status: Long, val body: String, val headers: Map<String, String>)`,
  },
  mcHttpRequest: {
    needs: ['McHttpResponse'],
    code: String.raw`
internal fun mcHttpRequest(method: String, url: String, headers: Map<String, String>, body: String): McHttpResponse =
    try {
        val builder = java.net.http.HttpRequest.newBuilder(java.net.URI.create(url))
        for ((k, v) in headers) builder.header(k, v)
        builder.method(
            method.uppercase(),
            if (body.isEmpty()) java.net.http.HttpRequest.BodyPublishers.noBody()
            else java.net.http.HttpRequest.BodyPublishers.ofString(body),
        )
        val response = java.net.http.HttpClient.newHttpClient()
            .send(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofString())
        McHttpResponse(
            response.statusCode().toLong(),
            response.body(),
            response.headers().map().mapValues { it.value.joinToString(", ") },
        )
    } catch (error: Exception) {
        McHttpResponse(0L, error.toString(), emptyMap())
    }`,
    android: String.raw`
/**
 * HttpURLConnection, because java.net.http does not exist on Android. It cannot
 * send PATCH; that is reported as a failed request rather than sent as POST.
 */
internal fun mcHttpRequest(method: String, url: String, headers: Map<String, String>, body: String): McHttpResponse =
    try {
        val connection = java.net.URL(url).openConnection() as java.net.HttpURLConnection
        connection.requestMethod = method.uppercase()
        for ((k, v) in headers) connection.setRequestProperty(k, v)
        if (body.isNotEmpty()) {
            connection.doOutput = true
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        val status = connection.responseCode
        val stream = if (status >= 400) connection.errorStream else connection.inputStream
        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        val received = connection.headerFields
            .filterKeys { it != null }
            .mapKeys { it.key.lowercase() }
            .mapValues { it.value.joinToString(", ") }
        connection.disconnect()
        McHttpResponse(status.toLong(), text, received)
    } catch (error: Exception) {
        McHttpResponse(0L, error.toString(), emptyMap())
    }`,
  },
  McHttpRequest: {
    code: String.raw`
/** A request as a handler sees it. Header names are lower-case. */
internal data class McHttpRequest(
    val method: String,
    val path: String,
    val body: String,
    val headers: Map<String, String>,
    val query: Map<String, String>,
)`,
  },
  McHttpReply: {
    code: String.raw`
/** What a handler answers with. */
internal data class McHttpReply(val status: Long, val body: String, val contentType: String)`,
  },
  mcServe: {
    needs: ['McHttpRequest', 'McHttpReply'],
    code: String.raw`
/** Answer every request with the handler; does not return while serving. */
internal fun mcServe(host: String, port: Long, handler: (McHttpRequest) -> McHttpReply) {
    val server = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress(host, port.toInt()), 0)
    server.executor = java.util.concurrent.Executors.newCachedThreadPool()
    server.createContext("/") { exchange ->
        val reply = try {
            val query = (exchange.requestURI.rawQuery ?: "").split('&').filter { it.isNotEmpty() }.associate {
                val key = it.substringBefore('=')
                java.net.URLDecoder.decode(key, "UTF-8") to java.net.URLDecoder.decode(it.substringAfter('=', ""), "UTF-8")
            }
            handler(
                McHttpRequest(
                    exchange.requestMethod,
                    exchange.requestURI.path,
                    exchange.requestBody.bufferedReader(Charsets.UTF_8).use { it.readText() },
                    exchange.requestHeaders.entries.associate { it.key.lowercase() to it.value.joinToString(", ") },
                    query,
                ),
            )
        } catch (error: Exception) {
            // A handler that throws is a bug in the program, not a bad request.
            System.err.println("request handler failed: " + error)
            McHttpReply(500L, "internal error", "text/plain")
        }
        val payload = reply.body.toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.set("content-type", reply.contentType.ifEmpty { "text/plain" })
        exchange.sendResponseHeaders(reply.status.toInt(), if (payload.isEmpty()) -1 else payload.size.toLong())
        if (payload.isNotEmpty()) exchange.responseBody.use { it.write(payload) }
        exchange.close()
    }
    System.err.println("listening on http://" + host + ":" + port)
    server.start()
    Thread.currentThread().join()
}`,
  },
  mcScheduleEvery: {
    code: String.raw`
/** Run, wait the gap, repeat. A fixed gap rather than a fixed rate, so a slow run never overlaps the next. */
internal fun mcScheduleEvery(millis: Long, task: () -> Unit) {
    while (true) {
        task()
        Thread.sleep(millis)
    }
}`,
  },
  mcParallelMap: {
    needs: ['mcRunPool'],
    code: String.raw`
/** Map with at most limit calls in flight, results in the original order. */
internal fun <T, U> mcParallelMap(items: List<T>, transform: (T) -> U, limit: Long): MutableList<U> =
    mcRunPool(items.size, limit) { transform(items[it]) }`,
  },
  mcParallelAll: {
    needs: ['mcRunPool'],
    code: String.raw`
/** Run every task, at most limit at once, results in the original order. */
internal fun <T> mcParallelAll(tasks: List<() -> T>, limit: Long): MutableList<T> =
    mcRunPool(tasks.size, limit) { tasks[it]() }`,
  },
  mcRunPool: {
    code: String.raw`
/** Threads rather than coroutines: the work is blocking calls, and threads are what overlap those. */
internal fun <U> mcRunPool(count: Int, limit: Long, work: (Int) -> U): MutableList<U> {
    if (count == 0) return mutableListOf()
    val pool = java.util.concurrent.Executors.newFixedThreadPool(limit.coerceIn(1L, count.toLong()).toInt())
    try {
        val futures = (0 until count).map { index -> pool.submit<U> { work(index) } }
        return futures.map { it.get() }.toMutableList()
    } finally {
        pool.shutdown()
    }
}`,
  },
  mcDbOpen: {
    code: String.raw`
/** SQLite through JDBC; needs org.xerial:sqlite-jdbc, which the build lists. */
internal fun mcDbOpen(path: String): java.sql.Connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + path)`,
  },
  mcDbExecute: {
    needs: ['mcDbBind'],
    code: String.raw`
internal fun mcDbExecute(connection: java.sql.Connection, sql: String, params: List<Any?>): Long =
    connection.prepareStatement(sql).use { statement ->
        mcDbBind(statement, params)
        statement.executeUpdate().toLong()
    }`,
  },
  mcDbQuery: {
    needs: ['mcDbBind'],
    code: String.raw`
internal fun mcDbQuery(connection: java.sql.Connection, sql: String, params: List<Any?>): MutableList<Map<String, Any?>> =
    connection.prepareStatement(sql).use { statement ->
        mcDbBind(statement, params)
        statement.executeQuery().use { rows ->
            val meta = rows.metaData
            val out = mutableListOf<Map<String, Any?>>()
            while (rows.next()) {
                val row = LinkedHashMap<String, Any?>()
                for (i in 1..meta.columnCount) row[meta.getColumnLabel(i)] = rows.getObject(i)
                out.add(row)
            }
            out
        }
    }`,
  },
  mcDbBind: {
    code: String.raw`
private fun mcDbBind(statement: java.sql.PreparedStatement, params: List<Any?>) {
    params.forEachIndexed { i, value -> statement.setObject(i + 1, value) }
}`,
  },
};

/** The helpers `names` call, closed over their own dependencies, in a stable order. */
function helperClosure(names: Iterable<string>): string[] {
  const out = new Set<string>();
  const visit = (n: string): void => {
    if (out.has(n) || !HELPERS[n]) return;
    out.add(n);
    for (const d of HELPERS[n].needs ?? []) visit(d);
  };
  for (const n of names) visit(n);
  return [...out].sort();
}

function runtimeSource(pkg: string, names: string[], android: boolean): string {
  const header = [
    '// Runtime helpers for generated Master Code programs: only those this module calls.',
    '// Generated; edit the graph, not this file.',
    '',
    `package ${pkg}`,
  ].join('\n');
  const bodies = names.map((n) => {
    const helper = HELPERS[n];
    return (android && helper.android ? helper.android : helper.code).trim();
  });
  return `${header}\n\n${bodies.join('\n\n')}\n`;
}

/** Run the emitter over a program's modules to learn which helpers each Gradle module needs. */
function helpersByModule(project: Project, program: IrProgram): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const module of program.modules) {
    const file = project.files.find((f) => f.id === module.id);
    if (!file) continue;
    const emitter = new KotlinEmitter({
      project,
      program,
      module: { ...module, imports: [...module.imports] },
      file,
      diag: { items: [], warn() {}, error() {}, info() {} } as never,
      resolveSymbol: () => undefined,
      dependencies: project.dependencies,
    });
    try {
      emitter.emit();
    } catch {
      // Emission errors are reported where the module itself is generated.
      continue;
    }
    if (!emitter.helpers.size) continue;
    const gradle = moduleOfPath(kotlinPathFor(file, project), project).path;
    const set = out.get(gradle) ?? new Set<string>();
    emitter.helpers.forEach((h) => set.add(h));
    out.set(gradle, set);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gradle
// ---------------------------------------------------------------------------

const PLUGIN_IDS = {
  androidApp: 'com.android.application',
  androidLib: 'com.android.library',
  jvm: 'org.jetbrains.kotlin.jvm',
  compose: 'org.jetbrains.kotlin.plugin.compose',
  serialization: 'org.jetbrains.kotlin.plugin.serialization',
  ksp: 'com.google.devtools.ksp',
};

function modulePlugins(m: ResolvedModule, deps: Dependency[]): string[] {
  const out: string[] = [];
  if (m.kind === 'android-application') out.push(PLUGIN_IDS.androidApp);
  else if (m.kind === 'android-library') out.push(PLUGIN_IDS.androidLib);
  else out.push(PLUGIN_IDS.jvm);
  if (m.kind === 'jvm-application') out.push('application');
  if (m.compose) out.push(PLUGIN_IDS.compose);
  if (m.serialization) out.push(PLUGIN_IDS.serialization);
  if (deps.some((d) => configurationOf(d) === 'ksp')) out.push(PLUGIN_IDS.ksp);
  return out;
}

function pluginVersion(id: string, v: KotlinVersions): string | undefined {
  if (id === PLUGIN_IDS.androidApp || id === PLUGIN_IDS.androidLib) return v.agp;
  if (id === PLUGIN_IDS.ksp) return v.ksp;
  if (id.startsWith('org.jetbrains.kotlin.')) return v.kotlin;
  return undefined;
}

function configurationOf(d: Dependency): string {
  if (d.configuration) return d.configuration;
  switch (d.scope) {
    case 'test':
      return 'testImplementation';
    case 'dev':
      return 'debugImplementation';
    case 'build':
      return 'compileOnly';
    default:
      return 'implementation';
  }
}

function dependencyLine(d: Dependency): string {
  const config = configurationOf(d);
  const coordinate = d.version && d.version !== '*' ? `${d.name}:${d.version}` : d.name;
  if (config.startsWith('platform:')) return `${config.slice('platform:'.length)}(platform("${coordinate}"))`;
  return `${config}("${coordinate}")`;
}

function dependenciesFor(project: Project, m: ResolvedModule, settings: ResolvedSettings): Dependency[] {
  const primary = settings.modules[0].path;
  return project.dependencies.filter(
    (d) => d.language === 'kotlin' && (d.target ?? primary) === m.path,
  );
}

function rootBuild(project: Project, settings: ResolvedSettings): string {
  const used = new Set<string>();
  for (const m of settings.modules) {
    for (const id of modulePlugins(m, dependenciesFor(project, m, settings))) used.add(id);
  }
  const lines = ['plugins {'];
  for (const id of [...used].sort()) {
    const version = pluginVersion(id, settings.versions);
    if (version) lines.push(`    id("${id}") version "${version}" apply false`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

/**
 * One module's build script. In a single-module build there is no root script
 * to declare plugin versions, so this one carries them.
 */
function moduleBuild(project: Project, m: ResolvedModule, settings: ResolvedSettings, testCases: Set<string>): string {
  const deps = dependenciesFor(project, m, settings);
  const target = settings.jvmTarget;
  const lines: string[] = [];
  lines.push('import org.jetbrains.kotlin.gradle.dsl.JvmTarget', '');
  lines.push('plugins {');
  for (const id of modulePlugins(m, deps)) {
    const version = settings.multiModule ? undefined : pluginVersion(id, settings.versions);
    if (id === 'application') lines.push('    application');
    else lines.push(`    id("${id}")${version ? ` version "${version}"` : ''}`);
  }
  lines.push('}', '');

  if (isAndroid(m)) {
    const a = m.android;
    if (!a) {
      throw new BackendGenError(`Android module "${m.path}" has no android settings.`, {
        code: 'codegen/kotlin-android-settings',
        hint: 'Give it at least a namespace, minSdk, targetSdk and compileSdk.',
      });
    }
    lines.push('android {');
    lines.push(`    namespace = "${a.namespace}"`);
    lines.push(`    compileSdk = ${a.compileSdk}`, '');
    lines.push('    defaultConfig {');
    if (m.kind === 'android-application') lines.push(`        applicationId = "${a.applicationId ?? a.namespace}"`);
    lines.push(`        minSdk = ${a.minSdk}`);
    if (m.kind === 'android-application') {
      lines.push(`        targetSdk = ${a.targetSdk}`);
      lines.push(`        versionCode = ${a.versionCode ?? 1}`);
      lines.push(`        versionName = "${a.versionName ?? project.version}"`);
    }
    if (deps.some((d) => configurationOf(d) === 'androidTestImplementation')) {
      lines.push('        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"');
    }
    lines.push('    }', '');
    lines.push('    buildTypes {', '        release {', '            isMinifyEnabled = false', '        }', '    }', '');
    lines.push(
      '    compileOptions {',
      `        sourceCompatibility = JavaVersion.VERSION_${target}`,
      `        targetCompatibility = JavaVersion.VERSION_${target}`,
      '    }',
    );
    if (m.compose) lines.push('', '    buildFeatures {', '        compose = true', '    }');
    lines.push('', '    testOptions {', '        unitTests {', '            isIncludeAndroidResources = true');
    if (m.testJvmArgs?.length) {
      lines.push(`            all { it.jvmArgs(${m.testJvmArgs.map((x) => `"${x}"`).join(', ')}) }`);
    }
    lines.push('        }', '    }');
    lines.push('}', '');
  } else {
    lines.push('java {', `    sourceCompatibility = JavaVersion.VERSION_${target}`, `    targetCompatibility = JavaVersion.VERSION_${target}`, '}', '');
  }

  lines.push('kotlin {', '    compilerOptions {', `        jvmTarget.set(JvmTarget.JVM_${target})`, '    }', '}', '');

  if (m.kind === 'jvm-application') {
    lines.push('application {', `    mainClass.set("${m.mainClass ?? mainClassFor(project)}")`, '}', '');
  }

  const projectDeps = (m.dependsOn ?? []).map((p) => `    implementation(project(":${p.replace(/\//g, ':')}"))`);
  const libraryDeps = deps.map((d) => `    ${dependencyLine(d)}`);
  if (testCases.has(m.path) && !deps.some((d) => d.name.startsWith('org.jetbrains.kotlin:kotlin-test'))) {
    // Test Case nodes become kotlin.test @Test methods; the library is the
    // compiler's own, versioned with it, as the standard library is.
    libraryDeps.push(`    testImplementation("org.jetbrains.kotlin:kotlin-test:${settings.versions.kotlin}")`);
  }
  libraryDeps.sort();
  if (projectDeps.length || libraryDeps.length) {
    lines.push('dependencies {', ...projectDeps, ...libraryDeps, '}', '');
  }

  if (m.extraDsl?.length) lines.push(...m.extraDsl, '');

  // Each test outcome on its own line, so a runner reading the log - and a
  // person - can see which test failed without opening the HTML report.
  lines.push('tasks.withType<Test>().configureEach {');
  if (!isAndroid(m) && m.testJvmArgs?.length) lines.push(`    jvmArgs(${m.testJvmArgs.map((x) => `"${x}"`).join(', ')})`);
  lines.push('    testLogging {', '        events("passed", "skipped", "failed")', '        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL', '    }', '}', '');
  return lines.join('\n');
}

function mainClassFor(project: Project): string {
  // The file marked as the entry, or failing that the one whose last
  // generation actually declared `main`: the role is a label, the export is a fact.
  const kotlinFiles = project.files.filter((f) => f.language === 'kotlin');
  const entry =
    kotlinFiles.find((f) => f.role === 'entry') ??
    kotlinFiles.find((f) => f.exports.some((e) => e.name === 'main' && e.sort === 'function'));
  if (!entry) return `${rootPackage(project)}.MainKt`;
  const path = kotlinPathFor(entry, project);
  return `${packageOfPath(path, project)}.${fileStem(path)}Kt`;
}

function manifestXml(a: AndroidSettings): string {
  const attr = (name: string): string => (name.includes(':') ? name : `android:${name}`);
  const element = (el: ManifestElement, depth: number, fallbackTag: string): string[] => {
    const pad = '    '.repeat(depth);
    const tag = el.tag ?? fallbackTag;
    const attrs = Object.entries(el.attributes ?? {}).map(([k, v]) => `${attr(k)}="${xmlEscape(v)}"`);
    const open = attrs.length > 1
      ? [`${pad}<${tag}`, ...attrs.map((x) => `${pad}    ${x}`)]
      : [`${pad}<${tag}${attrs.length ? ` ${attrs[0]}` : ''}`];
    if (!el.children?.length) {
      open[open.length - 1] += ' />';
      return open;
    }
    open[open.length - 1] += '>';
    return [...open, ...el.children.flatMap((c) => element(c, depth + 1, 'element')), `${pad}</${tag}>`];
  };
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
  ];
  for (const p of a.permissions ?? []) lines.push(`    <uses-permission android:name="${xmlEscape(p)}" />`);
  if (a.application) {
    if (a.permissions?.length) lines.push('');
    lines.push(...element(a.application, 1, 'application'));
  }
  lines.push('</manifest>', '');
  return lines.join('\n');
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function gradleFiles(project: Project, program: IrProgram, settings: ResolvedSettings): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const name = project.name.replace(/"/g, '');
  const includes = settings.modules.filter((m) => m.path).map((m) => `include(":${m.path.replace(/\//g, ':')}")`);
  files.push({
    path: 'settings.gradle.kts',
    role: 'build',
    content: [
      'pluginManagement {',
      '    repositories {',
      '        google()',
      '        mavenCentral()',
      '        gradlePluginPortal()',
      '    }',
      '}',
      '',
      'dependencyResolutionManagement {',
      '    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)',
      '    repositories {',
      '        google()',
      '        mavenCentral()',
      '    }',
      '}',
      '',
      `rootProject.name = "${name}"`,
      ...includes,
      '',
    ].join('\n'),
  });

  const android = settings.modules.some(isAndroid);
  files.push({
    path: 'gradle.properties',
    role: 'build',
    content: [
      'org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8',
      'kotlin.code.style=official',
      ...(android ? ['android.useAndroidX=true', 'android.nonTransitiveRClass=true'] : []),
      '',
    ].join('\n'),
  });
  files.push({
    path: 'gradle/wrapper/gradle-wrapper.properties',
    role: 'build',
    content: [
      'distributionBase=GRADLE_USER_HOME',
      'distributionPath=wrapper/dists',
      `distributionUrl=https\\://services.gradle.org/distributions/gradle-${settings.versions.gradle}-bin.zip`,
      'zipStoreBase=GRADLE_USER_HOME',
      'zipStorePath=wrapper/dists',
      '',
    ].join('\n'),
  });
  files.push({
    path: '.gitignore',
    role: 'build',
    content: ['.gradle/', 'build/', '.kotlin/', 'local.properties', '*.iml', '.idea/', ''].join('\n'),
  });

  if (settings.multiModule) {
    files.push({ path: 'build.gradle.kts', role: 'build', content: rootBuild(project, settings) });
  }
  for (const m of settings.modules) {
    const dir = m.path ? `${m.path}/` : '';
    const testCases = modulesWithTestCases(project, program);
    files.push({ path: `${dir}build.gradle.kts`, role: 'manifest', content: moduleBuild(project, m, settings, testCases) });
    if (isAndroid(m) && m.android) {
      files.push({ path: `${dir}src/main/AndroidManifest.xml`, role: 'manifest', content: manifestXml(m.android) });
      for (const [res, text] of Object.entries(m.android.resources ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        files.push({ path: `${dir}src/main/res/${res}`, role: 'asset', content: text.endsWith('\n') ? text : `${text}\n` });
      }
    }
  }
  return files;
}

/** Gradle modules whose files hold Test Case nodes, which need a test library. */
function modulesWithTestCases(project: Project, program: IrProgram): Set<string> {
  const out = new Set<string>();
  for (const module of program.modules) {
    if (!module.decls.some((d) => d.k === 'function' && d.isTest)) continue;
    const file = project.files.find((f) => f.id === module.id);
    if (file) out.add(moduleOfPath(kotlinPathFor(file, project), project).path);
  }
  return out;
}

/** True when kotlinc alone can build it: one JVM module, no libraries, nothing needing Gradle. */
function plainKotlinc(project: Project, settings: ResolvedSettings): boolean {
  return (
    !settings.multiModule &&
    !project.dependencies.some((d) => d.language === 'kotlin') &&
    !project.files.some((f) => f.language === 'kotlin' && f.role === 'test')
  );
}

// ---------------------------------------------------------------------------

export const kotlinBackend: LanguageBackend = {
  id: 'kotlin',
  name: 'Kotlin',
  maturity: 'full',
  extensions: ['.kt'],
  features: defaultFeatures({ compiled: true, annotations: true, taggedUnions: true }),
  lineComment: '//',
  blockComment: { open: '/*', close: '*/' },
  indent: '    ',
  keywords: KEYWORDS,

  packageManager: {
    id: 'gradle',
    name: 'Gradle',
    installAll: { label: 'gradle dependencies', command: 'gradle', args: ['--console=plain', 'dependencies'] },
    installOne: null,
    manifestFile: 'build.gradle.kts',
  },

  toolchain: [
    { command: 'kotlinc', versionArgs: ['-version'], installHint: 'Install the Kotlin compiler (kotlinlang.org, or `scoop install kotlin` / `brew install kotlin`).' },
    { command: 'gradle', versionArgs: ['--version'], installHint: 'Install Gradle 9 or newer (gradle.org), needed for projects with libraries, tests or Android.' },
    { command: 'java', versionArgs: ['-version'], installHint: 'Install a JDK 17 or newer; JDK 21 is what Android builds are verified with.' },
  ],

  entry: {
    file: 'src/main/kotlin/app/Main.kt',
    symbol: 'main',
    description: 'A top-level fun main() in package app.',
  },

  sourceRoot: (project) => {
    const m = kotlinSettings(project).modules[0];
    return `${m.path ? `${m.path}/` : ''}src/main/kotlin`;
  },
  testRoot: (project) => {
    const m = kotlinSettings(project).modules[0];
    return `${m.path ? `${m.path}/` : ''}src/test/kotlin`;
  },

  pathFor: kotlinPathFor,

  mapType(type, project) {
    return new KotlinEmitter(kotlinScratchContext(project)).type(type);
  },

  importFor(_from, to, symbols, project) {
    const pkg = packageOfPath(to.path, project);
    return symbols.map((s) => `import ${pkg}.${s}`).join('\n') || `import ${pkg}.*`;
  },

  crossFileReference(symbol) {
    return symbol;
  },

  emitModule(ctx) {
    return new KotlinEmitter(ctx).emit();
  },

  emitProjectFiles(project, program) {
    const settings = kotlinSettings(project);
    const files = gradleFiles(project, program, settings);

    const root = rootPackage(project);
    for (const [path, helpers] of helpersByModule(project, program)) {
      const module = settings.modules.find((m) => m.path === path) ?? settings.modules[0];
      const dir = module.path ? `${module.path}/` : '';
      files.push({
        path: `${dir}src/main/kotlin/${root.replace(/\./g, '/')}/${runtimeFileName(module, settings)}.kt`,
        role: 'source',
        content: runtimeSource(root, helperClosure(helpers), isAndroid(module)),
      });
    }

    if (plainKotlinc(project, settings)) {
      // kotlinc reads its file list from here: regenerated with the sources, so
      // it never names a file that no longer exists.
      const sources = [
        ...project.files.filter((f) => f.language === 'kotlin' && f.role !== 'test').map((f) => kotlinPathFor(f, project)),
        ...files.filter((f) => f.role === 'source').map((f) => f.path),
      ];
      files.push({ path: 'sources.txt', role: 'build', content: `${[...new Set(sources)].sort().join('\n')}\n` });
    }
    return files;
  },

  buildPlan(project, mode: BuildMode): BuildPlan {
    const settings = kotlinSettings(project);
    if (plainKotlinc(project, settings)) {
      return {
        steps: [{ label: 'Compile with kotlinc', command: 'kotlinc', args: ['@sources.txt', '-include-runtime', '-d', 'build/app.jar'] }],
        artifact: 'build/app.jar',
        note: 'Sources are listed in sources.txt, regenerated with the project.',
      };
    }
    const app = settings.modules.find((m) => m.kind === 'android-application');
    const task = app ? `${gradlePath(app)}assemble${mode === 'release' ? 'Release' : 'Debug'}` : 'build';
    return {
      steps: [{ label: `Gradle ${task}`, command: 'gradle', args: ['--console=plain', task, ...(app ? [] : ['-x', 'test'])] }],
      artifact: app ? `${app.path}/build/outputs/apk/${mode}/${app.path}-${mode}.apk` : undefined,
      note: app ? 'An Android build needs ANDROID_HOME pointing at an SDK.' : undefined,
    };
  },

  runPlan(project): RunPlan | null {
    const settings = kotlinSettings(project);
    if (plainKotlinc(project, settings)) {
      return { command: { label: 'Run', command: 'java', args: ['-cp', 'build/app.jar', mainClassFor(project)] } };
    }
    const app = settings.modules.find((m) => m.kind === 'jvm-application');
    if (!app) return null; // An APK runs on a device, not here.
    return { command: { label: 'Run', command: 'gradle', args: ['--console=plain', '-q', `${gradlePath(app)}run`] } };
  },

  testPlan(project): BuildPlan | null {
    const settings = kotlinSettings(project);
    const tasks = settings.modules.map((m) => `${gradlePath(m)}${isAndroid(m) ? 'testDebugUnitTest' : 'test'}`);
    return {
      steps: [{ label: 'Gradle unit tests', command: 'gradle', args: ['--console=plain', '--continue', ...tasks] }],
      note: 'Unit tests run on the JVM; Android code runs under Robolectric where a test asks for it.',
    };
  },

  parseDiagnostics(output, project): Diagnostic[] {
    const out: Diagnostic[] = [];
    const known = project.files.filter((f) => f.language === 'kotlin').map((f) => kotlinPathFor(f, project));
    const relative = (path: string): string => {
      const norm = path.replace(/\\/g, '/').replace(/^file:\/\/\/?/, '');
      return known.find((k) => norm.endsWith(k)) ?? norm;
    };
    // Gradle:  e: file:///F:/x/app/src/main/kotlin/a/B.kt:12:5 Unresolved reference 'c'.
    const gradle = /^([ew]): (?:file:\/\/\/?)?(.+?\.kts?):(\d+):(\d+) (.+)$/gm;
    // kotlinc: src/main/kotlin/a/B.kt:12:5: error: unresolved reference 'c'.
    const cli = /^(.+?\.kts?):(\d+):(\d+): (error|warning): (.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = gradle.exec(output))) {
      out.push({
        severity: m[1] === 'e' ? 'error' : 'warning',
        stage: 'build',
        code: `kotlinc/${m[1] === 'e' ? 'error' : 'warning'}`,
        message: m[5].trim(),
        file: relative(m[2]),
        line: Number(m[3]),
        column: Number(m[4]),
        raw: m[0],
      });
    }
    while ((m = cli.exec(output))) {
      out.push({
        severity: m[4] === 'error' ? 'error' : 'warning',
        stage: 'build',
        code: `kotlinc/${m[4]}`,
        message: m[5].trim(),
        file: relative(m[1]),
        line: Number(m[2]),
        column: Number(m[3]),
        raw: m[0],
      });
    }
    const thrown = /^Exception in thread "[^"]*" ([\w.$]+)(?::\s*(.*))?$/m.exec(output);
    if (thrown) {
      const frame = /at [\w.$]+\(([\w]+\.kt):(\d+)\)/.exec(output);
      out.push({
        severity: 'error',
        stage: 'runtime',
        code: 'kotlin/exception',
        message: `${thrown[1]}${thrown[2] ? `: ${thrown[2]}` : ''}`,
        file: frame?.[1],
        line: frame ? Number(frame[2]) : undefined,
        raw: thrown[0],
      });
    }
    return out;
  },
};

function gradlePath(m: ResolvedModule): string {
  return m.path ? `:${m.path.replace(/\//g, ':')}:` : '';
}

function kotlinScratchContext(project: Project): EmitContext {
  return {
    project,
    program: { name: '', language: 'kotlin', modules: [], dependencies: [] },
    module: { id: '', name: '', path: '', imports: [], decls: [] },
    file: { id: '', path: '', language: 'kotlin', kind: 'generated', role: 'source', exports: [], imports: [] },
    diag: { items: [], warn() {}, error() {}, info() {} } as never,
    resolveSymbol: () => undefined,
    dependencies: [],
  };
}

export { KotlinEmitter };
