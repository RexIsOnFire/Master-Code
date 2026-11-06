/**
 * The language adapter contract.
 *
 * Everything a language needs to be a first-class target lives behind this one
 * interface: how its files are laid out, how types and imports are spelled, how
 * a project is built and run, and which package manager owns its dependencies.
 * Nothing in the core imports a concrete backend - they are looked up through
 * `BackendRegistry`, which is also what plugins register into. Adding a
 * language is writing one of these, not editing the compiler.
 */

import type { Diagnostic, DiagnosticBag } from '../diagnostics.ts';
import type { IrModule, IrProgram, Origin } from '../ir/ir.ts';
import type { Dependency, Project, ProjectFile } from '../model/project.ts';
import type { UiDocument } from '../model/ui.ts';
import type { TypeRef } from '../types/types.ts';

// ---------------------------------------------------------------------------
// Capability description
// ---------------------------------------------------------------------------

export interface LanguageFeatures {
  classes: boolean;
  interfaces: boolean;
  inheritance: boolean;
  generics: boolean;
  closures: boolean;
  exceptions: boolean;
  async: boolean;
  /**
   * True when this language's implementations of effectful builtins are
   * asynchronous, so a call has to be awaited to have happened.
   *
   * Asynchrony is a property of the language, not of the operation: an HTTP
   * request is a promise in JavaScript and a blocking call in Python, Go and
   * Java. The IR says only that one call must complete before the next
   * statement runs - which is already true of a blocking call - so this flag
   * decides whether that ordering has to be spelled out with `async`/`await`
   * or comes for free.
   */
  asyncBuiltins: boolean;
  /** Garbage collected, so generated code need not manage lifetimes. */
  managedMemory: boolean;
  modules: boolean;
  /** Compiled to a binary, as opposed to interpreted. */
  compiled: boolean;
  /** Runs in a browser. */
  browser: boolean;
  /** Type annotations are required rather than optional. */
  staticTypes: boolean;
  /** Can print `Annotated.annotations` (annotations, decorators, attributes). */
  annotations: boolean;
  /** Enum variants may carry a payload (sealed hierarchies, tagged unions). */
  taggedUnions: boolean;
}

/** How complete this adapter is, stated plainly so nothing is oversold. */
export type BackendMaturity =
  /** Generates, builds and runs; exercised by the test suite. */
  | 'full'
  /** Generates idiomatic source and a build manifest; toolchain not verified here. */
  | 'generates'
  /** Structure only; emits a clearly-marked stub where it cannot do better. */
  | 'stub';

export interface ToolchainProbe {
  /** Executable to look for. */
  command: string;
  /** Arguments that make it print its version. */
  versionArgs: string[];
  /** What to tell the user when it is missing. */
  installHint: string;
}

// ---------------------------------------------------------------------------
// Build and run
// ---------------------------------------------------------------------------

export interface CommandSpec {
  label: string;
  command: string;
  args: string[];
  /** Relative to the generated project root. */
  cwd?: string;
  env?: Record<string, string>;
  /** Failure is reported but does not stop the pipeline. */
  optional?: boolean;
}

export interface BuildPlan {
  /** Steps in order. An empty list means "nothing to compile". */
  steps: CommandSpec[];
  /** Path of the produced artifact, relative to the project root. */
  artifact?: string;
  /** Human-readable note shown in the build log. */
  note?: string;
}

export interface RunPlan {
  command: CommandSpec;
  /** For web targets: open this file in a browser rather than spawning a process. */
  openInBrowser?: string;
}

export type BuildMode = 'debug' | 'release';

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GeneratedFile {
  /** Path relative to the generated project root. */
  path: string;
  content: string;
  /** Project file this came from, when it maps to one. */
  fileId?: string;
  /** Generated manifests and build scripts are not user-editable. */
  role: 'source' | 'manifest' | 'build' | 'test' | 'asset' | 'doc';
  /** Regions inside this file that must survive regeneration. */
  preserveRegions?: boolean;
}

export interface EmitContext {
  project: Project;
  program: IrProgram;
  module: IrModule;
  file: ProjectFile;
  diag: DiagnosticBag;
  /**
   * Resolve a cross-file symbol to the import the emitter should add and the
   * name to use at the reference site. Supplied by the file-graph pass, which
   * is the only thing that knows the final layout.
   */
  resolveSymbol(name: string, from?: string): { reference: string; import?: string } | undefined;
  /** Registered dependencies, for emitters that inline CDN URLs or crate paths. */
  dependencies: Dependency[];
  /**
   * Filled by backends that can say which node produced each emitted line
   * (0-based). Optional: a backend that does not is simply mapped by
   * identifier instead, which is less precise but never wrong.
   */
  lineOrigins?: Map<number, Origin>;
}

/** Thrown by a backend asked to emit something it genuinely cannot express. */
export class BackendGenError extends Error {
  readonly detail: { code: string; hint?: string; origin?: Diagnostic['origin'] };

  constructor(
    message: string,
    detail: { code: string; hint?: string; origin?: Diagnostic['origin'] } = { code: 'codegen/unsupported' },
  ) {
    super(message);
    this.name = 'BackendGenError';
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface LanguageBackend {
  readonly id: string;
  readonly name: string;
  readonly maturity: BackendMaturity;
  /** Primary extension first; the rest are recognised on import. */
  readonly extensions: string[];
  readonly features: LanguageFeatures;

  /** `#`, `//`, `<!--` ... used for headers and preserved-region markers. */
  readonly lineComment: string;
  readonly blockComment?: { open: string; close: string };
  readonly indent: string;

  /** Package manager metadata. */
  readonly packageManager: {
    id: string;
    name: string;
    /** Command that installs everything in the manifest. */
    installAll: CommandSpec | null;
    /** Command that installs one package; `{name}` and `{version}` are substituted. */
    installOne: CommandSpec | null;
    manifestFile: string;
    lockFile?: string;
  };

  /** Toolchains this backend needs, in the order they are used. */
  readonly toolchain: ToolchainProbe[];

  /** Source root inside the generated project, e.g. `src` or `src/main/java`. */
  sourceRoot(project: Project): string;
  testRoot(project: Project): string;

  /** Final on-disk path for a project file, including any language-specific root. */
  pathFor(file: ProjectFile, project: Project): string;

  /** Spelling of a type in this language. */
  mapType(type: TypeRef, project: Project): string;

  /** Import statement text for reaching `symbols` in `to` from `from`. */
  importFor(
    from: IrModule,
    to: { path: string; name: string },
    symbols: string[],
    project: Project,
  ): string;

  /**
   * How a symbol defined in another file is written at the reference site.
   *
   * Most languages import the name and use it bare. Java and C# put
   * module-level functions on a static class, and Go qualifies by package, so
   * those override this to return `Helpers.compute` rather than `compute`.
   */
  crossFileReference?(symbol: string, to: ProjectFile, project: Project): string;

  /** Render one IR module as source. */
  emitModule(ctx: EmitContext): string;

  /** Render a UI document. Only markup/style backends implement this. */
  emitUi?(doc: UiDocument, file: ProjectFile, project: Project): string;

  /** Manifests, build scripts, ignore files and anything else the project needs. */
  emitProjectFiles(project: Project, program: IrProgram): GeneratedFile[];

  buildPlan(project: Project, mode: BuildMode): BuildPlan;
  runPlan(project: Project, mode: BuildMode): RunPlan | null;
  testPlan(project: Project): BuildPlan | null;

  /** Turn raw compiler output into diagnostics. */
  parseDiagnostics(output: string, project: Project): Diagnostic[];

  /** Entry-point conventions, shown in the new-file dialog. */
  readonly entry: {
    /** Default relative path of the entry file. */
    file: string;
    /** Symbol the runtime calls. */
    symbol: string;
    description: string;
  };

  /** Reserved words this backend renames around. */
  readonly keywords: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class BackendRegistry {
  private readonly byId = new Map<string, LanguageBackend>();

  register(backend: LanguageBackend): void {
    if (this.byId.has(backend.id)) {
      throw new Error(`language "${backend.id}" is already registered`);
    }
    this.byId.set(backend.id, backend);
  }

  get(id: string): LanguageBackend | undefined {
    return this.byId.get(id);
  }

  require(id: string): LanguageBackend {
    const b = this.byId.get(id);
    if (!b) {
      throw new Error(
        `no backend registered for language "${id}" (have: ${[...this.byId.keys()].join(', ')})`,
      );
    }
    return b;
  }

  all(): LanguageBackend[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  /** Backend that owns a file extension, for project import. */
  forExtension(ext: string): LanguageBackend | undefined {
    const e = ext.startsWith('.') ? ext : `.${ext}`;
    return this.all().find((b) => b.extensions.includes(e));
  }

  forFile(path: string): LanguageBackend | undefined {
    const i = path.lastIndexOf('.');
    return i < 0 ? undefined : this.forExtension(path.slice(i));
  }
}

// ---------------------------------------------------------------------------
// Shared defaults
// ---------------------------------------------------------------------------

export function defaultFeatures(over: Partial<LanguageFeatures> = {}): LanguageFeatures {
  return {
    classes: true,
    interfaces: true,
    inheritance: true,
    generics: true,
    closures: true,
    exceptions: true,
    async: true,
    asyncBuiltins: false,
    managedMemory: true,
    modules: true,
    compiled: false,
    browser: false,
    staticTypes: true,
    annotations: false,
    taggedUnions: false,
    ...over,
  };
}

/** Header comment placed at the top of every generated file. */
export function generatedHeader(
  backend: LanguageBackend,
  file: ProjectFile,
  project: Project,
  extra: string[] = [],
): string[] {
  const c = backend.lineComment;
  const lines = [
    `${c} Generated by Master Code from ${file.graphId ? 'graph' : 'project'} "${project.name}".`,
    `${c} Source of truth: ${project.name}.mcproj -> ${file.path}`,
  ];
  if (file.kind === 'hybrid') {
    lines.push(`${c} Edits inside "mcode:region" markers are preserved; everything else is overwritten.`);
  } else {
    lines.push(`${c} Manual edits are overwritten on the next generate. Change the graph instead.`);
  }
  for (const e of extra) lines.push(`${c} ${e}`);
  return lines;
}
