/**
 * Code generation.
 *
 * This is the seam the whole architecture turns on:
 *
 *     logic graphs -> IR modules -> (one IrProgram per language)
 *                                -> symbol resolution across the file graph
 *                                -> backend emission
 *                                -> region merge
 *                                -> a set of files
 *
 * Nothing is written to disk here. `generate` returns the intended contents and
 * the caller decides whether to write them, diff them, or show them in a source
 * view. That is what makes "preview the generated code" and "write the project"
 * the same operation, and it keeps this module testable without a filesystem.
 */

import type { BackendRegistry, EmitContext, GeneratedFile, LanguageBackend } from '../backends/backend.ts';
import { BackendGenError } from '../backends/backend.ts';
import { emitCHeader, cHeaderPathFor } from '../backends/c.ts';
import { emitCppHeader, cppHeaderPathFor } from '../backends/cpp.ts';
import { uiDocumentOf } from '../backends/html.ts';
import { DiagnosticBag } from '../diagnostics.ts';
import type { Capability, IrDecl, IrModule, IrProgram, Origin } from '../ir/ir.ts';
import { collectCapabilities } from '../ir/ir.ts';
import { markSuspending } from '../lower/async.ts';
import { lowerGraph } from '../lower/lower.ts';
import type { NodeRegistry } from '../nodes/definition.ts';
import type { ExportedSymbol, Project, ProjectFile } from '../model/project.ts';
import { graphForFile } from '../model/project.ts';
import { SymbolIndex, setExports, setGeneratedImports, validateFileGraph } from '../filegraph/graph.ts';
import { mergeRegions } from './regions.ts';

export interface GenerateOptions {
  nodes: NodeRegistry;
  backends: BackendRegistry;
  /** Previous on-disk content, for preserving user regions in hybrid files. */
  readExisting?(path: string): string | undefined;
  /** Restrict generation to these file ids. Manifests are still emitted. */
  onlyFiles?: string[];
  /** Skip graph validation when the caller has already run it. */
  skipValidation?: boolean;
}

export interface GeneratedArtifact {
  path: string;
  content: string;
  fileId?: string;
  role: GeneratedFile['role'];
  language?: string;
  /** Region ids carried over from the previous version. */
  preservedRegions?: string[];
}

export interface GenerateResult {
  files: GeneratedArtifact[];
  /** One program per language present in the project. */
  programs: IrProgram[];
  diagnostics: DiagnosticBag;
  /** Everything the generated program will need at run time. */
  capabilities: Set<Capability>;
  /** External packages the graphs asked for, by language. */
  packages: { name: string; version: string; language: string }[];
  /** User regions that no longer have a home in the regenerated file. */
  orphanedRegions: { path: string; id: string; content: string }[];
  /**
   * Generated path -> 1-based line -> the node that produced it, for the
   * backends that can report it. Exact where present; the source map falls
   * back to matching identifiers where it is not.
   */
  lineOrigins: Map<string, Map<number, Origin>>;
}

export function generate(project: Project, options: GenerateOptions): GenerateResult {
  const diag = new DiagnosticBag();
  const { nodes, backends } = options;

  diag.merge(validateFileGraph(project, backends));

  // -- 1. Lower every graph-backed file into an IR module --------------------
  const modulesByFile = new Map<string, IrModule>();
  const capabilities = new Set<Capability>();
  const packages: { name: string; version: string; language: string }[] = [];

  for (const file of project.files) {
    if (file.kind === 'user' || file.kind === 'external') continue;
    const graph = graphForFile(project, file.id);
    if (!graph) continue;
    if (options.onlyFiles && !options.onlyFiles.includes(file.id)) continue;

    const backend = backends.get(file.language);
    if (!backend) continue;

    const lowered = lowerGraph(graph, file, project, nodes, {
      language: file.language,
      diag,
      skipValidation: options.skipValidation,
    });
    modulesByFile.set(file.id, lowered.module);
    lowered.capabilities.forEach((c) => capabilities.add(c));
    for (const p of lowered.packages) packages.push({ ...p, language: file.language });

    checkFeatureSupport(backend, lowered.module, file, diag);
    setExports(file, exportsOf(lowered.module));
  }

  // -- 2. Group into one program per language --------------------------------
  const byLanguage = new Map<string, IrModule[]>();
  for (const [fileId, module] of modulesByFile) {
    const file = project.files.find((f) => f.id === fileId)!;
    const list = byLanguage.get(file.language);
    if (list) list.push(module);
    else byLanguage.set(file.language, [module]);
  }
  // Languages with no graphs but with files (HTML, CSS, manifests) still need a
  // program so their backend gets a chance to contribute project files.
  for (const file of project.files) {
    if (!byLanguage.has(file.language) && backends.get(file.language)) byLanguage.set(file.language, []);
  }

  const programs: IrProgram[] = [...byLanguage.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([language, modules]) => {
      const entryFile = project.files.find((f) => f.role === 'entry' && f.language === language);
      const entryModule = entryFile ? modulesByFile.get(entryFile.id) : undefined;
      return {
        name: project.name,
        language,
        modules: modules.sort((a, b) => a.path.localeCompare(b.path)),
        entryModule: entryModule?.id,
        entrySymbol: entryModule?.decls.find(
          (d): d is Extract<IrDecl, { k: 'function' }> => d.k === 'function' && d.isEntry === true,
        )?.name,
        dependencies: project.dependencies
          .filter((d) => d.language === language)
          .map((d) => ({ name: d.name, version: d.version, language })),
      } satisfies IrProgram;
    });

  // -- 3. Emit -----------------------------------------------------------------
  const index = new SymbolIndex(project);
  const artifacts: GeneratedArtifact[] = [];
  const orphanedRegions: GenerateResult['orphanedRegions'] = [];
  const lineOrigins = new Map<string, Map<number, Origin>>();

  for (const program of programs) {
    const backend = backends.require(program.language);

    // Where the language's effectful builtins are promises rather than blocking
    // calls, the ordering the IR takes for granted has to be written out before
    // anything is emitted. Every other language already has it.
    if (backend.features.asyncBuiltins) markSuspending(program, diag);

    for (const module of program.modules) {
      const file = project.files.find((f) => f.id === module.id);
      if (!file) continue;

      const ctx: EmitContext = {
        project,
        program,
        module,
        file,
        diag,
        dependencies: project.dependencies,
        resolveSymbol: (name, from) => resolveSymbol(name, from, file, module, project, backend, index, diag),
      };

      const marks = new Map<number, Origin>();
      ctx.lineOrigins = marks;
      let content: string;
      try {
        content = backend.emitModule(ctx);
      } catch (err) {
        reportEmitFailure(err, file, diag);
        continue;
      }

      setGeneratedImports(
        file,
        module.imports
          .filter((i) => i.source === 'file')
          .map((i) => ({ to: i.target, scope: 'file' as const, symbols: i.symbols?.map((s) => s.name) })),
      );

      const outPath = backend.pathFor(file, project);
      if (marks.size) {
        // Stored 1-based, matching how every tool reports a line number.
        lineOrigins.set(outPath, new Map([...marks].map(([line, o]) => [line + 1, o])));
      }
      artifacts.push(finish(outPath, content, file, backend, options, orphanedRegions, diag, 'source'));

      // C and C++ split declarations into a header.
      if (program.language === 'cpp') {
        try {
          artifacts.push(
            finish(cppHeaderPathFor(file), emitCppHeader(ctx), file, backend, options, orphanedRegions, diag, 'source'),
          );
        } catch (err) {
          reportEmitFailure(err, file, diag);
        }
      } else if (program.language === 'c') {
        try {
          artifacts.push(
            finish(cHeaderPathFor(file), emitCHeader(ctx), file, backend, options, orphanedRegions, diag, 'source'),
          );
        } catch (err) {
          reportEmitFailure(err, file, diag);
        }
      }
    }

    // Markup and stylesheets come from the UI document, not a logic graph.
    if (backend.emitUi) {
      for (const file of project.files) {
        if (file.language !== program.language) continue;
        if (file.kind === 'user' || file.kind === 'external') continue;
        if (options.onlyFiles && !options.onlyFiles.includes(file.id)) continue;
        if (modulesByFile.has(file.id)) continue;
        const doc = uiDocumentOf(file);
        try {
          const content = backend.emitUi(doc, file, project);
          artifacts.push(
            finish(backend.pathFor(file, project), content, file, backend, options, orphanedRegions, diag, 'source'),
          );
        } catch (err) {
          reportEmitFailure(err, file, diag);
        }
      }
    }

    // Manifests, build scripts, runtime support modules.
    try {
      for (const extra of backend.emitProjectFiles(project, program)) {
        artifacts.push({
          path: extra.path,
          content: extra.content,
          role: extra.role,
          language: program.language,
          fileId: extra.fileId,
        });
      }
    } catch (err) {
      diag.error(
        'codegen',
        'codegen/project-files-failed',
        `Could not generate ${backend.name} project files: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -- 4. Files the model owns outright --------------------------------------
  for (const file of project.files) {
    if (file.literalContent === undefined) continue;
    if (artifacts.some((a) => a.fileId === file.id)) continue;
    artifacts.push({
      path: file.path,
      content: file.literalContent,
      fileId: file.id,
      role: file.role === 'config' ? 'manifest' : 'source',
      language: file.language,
    });
  }

  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  dedupePaths(artifacts, diag);

  return {
    files: artifacts,
    programs,
    diagnostics: diag,
    capabilities,
    packages: dedupePackages(packages),
    orphanedRegions,
    lineOrigins,
  };
}

// ---------------------------------------------------------------------------

function finish(
  path: string,
  content: string,
  file: ProjectFile,
  backend: LanguageBackend,
  options: GenerateOptions,
  orphaned: GenerateResult['orphanedRegions'],
  diag: DiagnosticBag,
  role: GeneratedFile['role'],
): GeneratedArtifact {
  if (file.kind !== 'hybrid') {
    return { path, content, fileId: file.id, role, language: file.language };
  }
  const previous = options.readExisting?.(path);
  const merged = mergeRegions(content, previous);
  for (const err of merged.errors) {
    diag.error('codegen', 'codegen/region-parse', `Could not read preserved regions in "${path}": ${err}.`, {
      file: path,
      hint: 'Fix the region markers by hand; the file was left untouched to avoid losing your code.',
    });
  }
  for (const region of merged.orphaned) {
    orphaned.push({ path, id: region.id, content: region.content });
    diag.warn(
      'codegen',
      'codegen/orphaned-region',
      `Region "${region.id}" in "${path}" no longer exists in the generated output.`,
      {
        file: path,
        hint: `Its contents were saved to ${path}.orphaned so nothing is lost.`,
      },
    );
  }
  // A parse failure means we must not overwrite: keep whatever is on disk.
  const finalContent = merged.errors.length && previous !== undefined ? previous : merged.content;
  return {
    path,
    content: finalContent,
    fileId: file.id,
    role,
    language: file.language,
    preservedRegions: merged.preserved,
  };
}

function reportEmitFailure(err: unknown, file: ProjectFile, diag: DiagnosticBag): void {
  if (err instanceof BackendGenError) {
    diag.error('codegen', err.detail.code, err.message, {
      file: file.path,
      origin: err.detail.origin,
      hint: err.detail.hint,
    });
    return;
  }
  diag.error(
    'codegen',
    'codegen/emit-failed',
    `Generating "${file.path}" failed: ${err instanceof Error ? err.message : String(err)}`,
    { file: file.path },
  );
}

/**
 * Resolve a cross-file symbol, registering the import as a side effect.
 *
 * Called from inside a backend's emitter, which is why it mutates
 * `module.imports`: every backend renders its import block after the body, so
 * imports discovered while emitting still make it into the output.
 */
function resolveSymbol(
  name: string,
  from: string | undefined,
  file: ProjectFile,
  module: IrModule,
  project: Project,
  backend: LanguageBackend,
  index: SymbolIndex,
  diag: DiagnosticBag,
): { reference: string; import?: string } | undefined {
  // `module:<id>` comes from a Use Module Member node.
  let preferFileId: string | undefined;
  if (from?.startsWith('module:')) {
    const moduleId = from.slice('module:'.length);
    const owner = project.files.find((f) => f.moduleId === moduleId && f.exports.some((e) => e.name === name));
    preferFileId = owner?.id;
  } else if (from) {
    preferFileId = from;
  }

  const found = index.resolve(name, file.id, preferFileId);
  if (!found) {
    if (index.ambiguous(name)) {
      diag.error('codegen', 'codegen/ambiguous-symbol', `"${name}" is exported by more than one file.`, {
        file: file.path,
        hint: `Defined in: ${index.all(name).map((l) => l.file.path).join(', ')}. Use a Use Module Member node to say which.`,
      });
    }
    // Not a project symbol: it is a local, a parameter, or something the graph
    // imported from a package. Leave the name as written.
    return undefined;
  }

  // Declared in this file, so there is nothing to import - but the name still
  // has to be spelled the way this backend spelled the declaration. Returning
  // the graph's own spelling here would emit `onRequest` into Go, which names
  // that declaration `OnRequest`, and `parseAlert` into Python, which names it
  // `parse_alert`. Falling through leaves the spelling to the backend.
  if (found.fileId === file.id) return undefined;

  const already = module.imports.some(
    (i) => i.source === 'file' && i.target === found.fileId && i.symbols?.some((s) => s.name === name),
  );
  if (!already) {
    const existing = module.imports.find((i) => i.source === 'file' && i.target === found.fileId);
    if (existing) {
      existing.symbols = [...(existing.symbols ?? []), { name }];
    } else {
      module.imports.push({ source: 'file', target: found.fileId, symbols: [{ name }] });
    }
  }

  return { reference: backend.crossFileReference?.(name, found.file, project) ?? name };
}

/** Public symbols a module offers to the rest of the project. */
export function exportsOf(module: IrModule): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
  const allow = module.exports ? new Set(module.exports) : undefined;

  const add = (name: string, sort: ExportedSymbol['sort'], doc?: string): void => {
    if (allow && !allow.has(name)) return;
    out.push({ name, sort, doc });
  };

  for (const decl of module.decls) {
    if (isPrivate(decl)) continue;
    switch (decl.k) {
      case 'function':
        add(decl.name, 'function', decl.doc);
        break;
      case 'class':
        add(decl.name, 'class', decl.doc);
        break;
      case 'interface':
        add(decl.name, 'interface', decl.doc);
        break;
      case 'enum':
        add(decl.name, 'enum', decl.doc);
        break;
      case 'global':
        add(decl.name, decl.constant ? 'const' : 'variable', decl.doc);
        break;
      case 'typeAlias':
        add(decl.name, 'type', decl.doc);
        break;
      case 'rawDecl':
        for (const name of decl.provides ?? []) add(name, 'unknown');
        break;
    }
  }
  return out;
}

function isPrivate(decl: IrDecl): boolean {
  return 'visibility' in decl && decl.visibility === 'private';
}

/**
 * Refuse a graph the target language cannot express, naming the node.
 *
 * This runs before emission so the user gets one clear message rather than a
 * cascade of failures from deep inside an emitter.
 */
function checkFeatureSupport(
  backend: LanguageBackend,
  module: IrModule,
  file: ProjectFile,
  diag: DiagnosticBag,
): void {
  const f = backend.features;
  const complain = (what: string, hint: string, origin?: IrDecl['origin']): void => {
    diag.error('codegen', 'codegen/unsupported-feature', `${backend.name} has no ${what}.`, {
      file: file.path,
      origin,
      hint,
    });
  };

  for (const decl of module.decls) {
    if (decl.k === 'class' && !f.classes) {
      complain('classes', 'Use plain functions and a struct, or pick another language for this file.', decl.origin);
    }
    if (decl.k === 'interface' && !f.interfaces) {
      complain('interfaces', 'Model the contract as a struct of function pointers instead.', decl.origin);
    }
    if (decl.k === 'class' && decl.extends && !f.inheritance) {
      complain('inheritance', 'Compose instead: hold the base value as a field.', decl.origin);
    }
    if (decl.k === 'function' && decl.isAsync && !f.async) {
      complain('async functions', 'Make the function synchronous, or move it to a language with async support.', decl.origin);
    }
    if (decl.k === 'enum' && !f.taggedUnions && decl.variants.some((v) => v.payload?.length)) {
      complain('enum variants that carry data', 'Use a plain enum plus a class per case, or pick a language with sealed types.', decl.origin);
    }
    if (!f.annotations) {
      const annotated = annotatedParts(decl).find((part) => part.annotations?.length);
      if (annotated) {
        complain(
          'annotations',
          `Remove "@${annotated.annotations![0]}" from the node, or move it to a file in a language that has annotations.`,
          annotated.origin ?? decl.origin,
        );
      }
    }
  }
}

/** A declaration and every member of it that may carry annotations. */
function annotatedParts(decl: IrDecl): { annotations?: string[]; origin?: IrDecl['origin'] }[] {
  switch (decl.k) {
    case 'class':
      return [decl, ...decl.fields, ...decl.methods, ...(decl.ctor ? [decl.ctor] : [])];
    case 'interface':
      return [decl, ...decl.methods, ...(decl.fields ?? [])];
    case 'function':
    case 'enum':
      return [decl];
    default:
      return [];
  }
}

function dedupePaths(artifacts: GeneratedArtifact[], diag: DiagnosticBag): void {
  const seen = new Map<string, GeneratedArtifact>();
  for (const a of artifacts) {
    const clash = seen.get(a.path);
    if (clash && clash.content !== a.content) {
      diag.error('codegen', 'codegen/output-collision', `Two sources want to write "${a.path}" with different content.`, {
        file: a.path,
        hint: 'Rename one of the files.',
      });
    }
    seen.set(a.path, a);
  }
}

function dedupePackages(
  packages: { name: string; version: string; language: string }[],
): { name: string; version: string; language: string }[] {
  const map = new Map<string, { name: string; version: string; language: string }>();
  for (const p of packages) {
    const key = `${p.language}:${p.name}`;
    const existing = map.get(key);
    if (!existing || existing.version === '*') map.set(key, p);
  }
  return [...map.values()].sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
}

/** Capabilities an already-lowered program needs. Used by the sandbox check. */
export function programCapabilities(program: IrProgram): Set<Capability> {
  return collectCapabilities(program);
}
