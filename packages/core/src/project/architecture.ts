/**
 * Converting a project between monolithic and modular layouts.
 *
 * The two shapes differ only in where files sit and whether modules exist to
 * group them. Nothing in a logic graph refers to a path — references are file
 * ids, resolved to import text during emission — so a conversion is a set of
 * moves plus some bookkeeping, and the imports come out right on the next
 * generate without anyone rewriting them.
 *
 * The exception is hand-written files, which hold literal text with literal
 * imports. Those go through the same conservative rewrite `renameFile` uses,
 * and anything it cannot rewrite confidently is reported rather than guessed
 * at. That is what "convertible where practical" means here: the practical part
 * is stated per file, in diagnostics, rather than assumed.
 *
 * Both directions are `dryRun`-able, because moving every file in a project is
 * not something anyone should trigger without seeing the list first.
 */

import { DiagnosticBag } from '../diagnostics.ts';
import type { BackendRegistry } from '../backends/backend.ts';
import type { Project, ProjectFile, ProjectModule } from '../model/project.ts';
import { touch } from '../model/project.ts';
import { newId, renameFile } from '../filegraph/graph.ts';
import { toIdentifier } from '../nodes/definition.ts';

export interface ConversionMove {
  fileId: string;
  from: string;
  to: string;
  /** The module the file ends up in, for a modularise. */
  module?: string;
}

export interface ConversionResult {
  /** What moved, or would move under `dryRun`. */
  moves: ConversionMove[];
  /** Modules created (modularise) or removed (flatten). */
  modules: string[];
  diagnostics: DiagnosticBag;
  /** False when the project was already in the requested shape. */
  changed: boolean;
}

export interface ConvertOptions {
  backends: BackendRegistry;
  /** Report the moves without performing them. */
  dryRun?: boolean;
  /** Supplies the current text of a hand-written file, so its imports can be rewritten. */
  readUserFile?: (file: ProjectFile) => string | undefined;
}

/** Files a conversion may move. Config, assets and build output stay put. */
const MOVABLE = new Set(['source', 'entry', 'test']);

function movable(file: ProjectFile): boolean {
  return MOVABLE.has(file.role) && file.kind !== 'external';
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// ---------------------------------------------------------------------------
// Monolithic -> modular
// ---------------------------------------------------------------------------

/**
 * Groups files into modules, one per directory beneath the language's source
 * root. A flat project has nothing to group, so the caller must supply an
 * explicit grouping — there is no way to guess a sensible module boundary from
 * file names, and inventing one would be worse than declining.
 */
export function modularise(
  project: Project,
  options: ConvertOptions & {
    /**
     * Module name -> the files that belong to it. When omitted, existing
     * subdirectories under the source root are used.
     */
    groups?: Record<string, string[]>;
  },
): ConversionResult {
  const diag = new DiagnosticBag();
  const moves: ConversionMove[] = [];
  const created: string[] = [];

  if (project.architecture === 'modular' && project.modules.length) {
    diag.info('filegraph', 'architecture/already-modular', 'This project is already modular.');
    return { moves, modules: [], diagnostics: diag, changed: false };
  }

  const backend = options.backends.get(project.language);
  const root = backend ? backend.sourceRoot(project) : 'src';
  const candidates = project.files.filter(movable);

  const groups = options.groups
    ? resolveExplicitGroups(project, options.groups, diag)
    : groupByDirectory(candidates, root);

  if (!groups.size) {
    diag.warn(
      'filegraph',
      'architecture/nothing-to-group',
      'Every source file sits directly in the source root, so there are no natural module boundaries.',
      {
        hint: 'Pass explicit groups, or move some files into subdirectories first.',
      },
    );
    return { moves, modules: [], diagnostics: diag, changed: false };
  }

  // The entry point belongs to the application, not to a module: putting it
  // inside one makes that module depend on everything, which defeats grouping.
  const entry = project.files.find((f) => f.role === 'entry');
  const pending: { module: ProjectModule; members: ProjectFile[] }[] = [];

  for (const [name, files] of groups) {
    const identifier = toIdentifier(name, 'module');
    const directory = `${root}/${identifier}`;
    const module: ProjectModule = {
      id: newId('mod'),
      name: identifier,
      directory,
      version: '0.1.0',
      description: `Grouped from ${directory} during conversion to a modular layout.`,
      interface: [],
      dependencies: [],
      packages: [],
      config: {},
      testFileIds: [],
    };

    const members = files.filter((f) => f.id !== entry?.id);
    if (!members.length) continue;

    for (const file of members) {
      const target = `${directory}/${nameOf(file.path)}`;
      moves.push({ fileId: file.id, from: file.path, to: target, module: identifier });
    }

    if (!options.dryRun) {
      project.modules.push(module);
      // Membership is assigned after the moves land, below: setting it now
      // would make `renameFile` report each file as sitting outside the module
      // it is on its way into.
      pending.push({ module, members });
    }
    created.push(identifier);
  }

  const applied = applyMoves(project, moves, options, diag);
  if (!options.dryRun && applied) {
    for (const { module, members } of pending) {
      for (const file of members) file.moduleId = module.id;
      // The interface is the union of what the members export. Regeneration
      // refreshes it; this makes the module meaningful straight away.
      module.interface = members.flatMap((f) =>
        f.exports.map((e) => ({ name: e.name, kind: interfaceKind(e.sort), doc: e.doc })),
      );
      module.testFileIds = members.filter((f) => f.role === 'test').map((f) => f.id);
    }
    project.architecture = 'modular';
    deriveModuleDependencies(project);
    touch(project);
  }

  return { moves, modules: created, diagnostics: diag, changed: moves.length > 0 };
}

function interfaceKind(sort: string): 'function' | 'class' | 'constant' | 'event' | 'type' {
  if (sort === 'function') return 'function';
  if (sort === 'class' || sort === 'interface') return 'class';
  if (sort === 'const') return 'constant';
  if (sort === 'enum' || sort === 'type') return 'type';
  return 'constant';
}

function groupByDirectory(files: ProjectFile[], root: string): Map<string, ProjectFile[]> {
  const groups = new Map<string, ProjectFile[]>();
  for (const file of files) {
    const dir = dirOf(file.path);
    if (dir === root || !dir.startsWith(`${root}/`)) continue;
    // Only the first segment below the root: nested folders stay nested inside
    // their module rather than becoming modules of their own.
    const segment = dir.slice(root.length + 1).split('/')[0];
    if (!segment) continue;
    const list = groups.get(segment) ?? [];
    list.push(file);
    groups.set(segment, list);
  }
  return groups;
}

function resolveExplicitGroups(
  project: Project,
  groups: Record<string, string[]>,
  diag: DiagnosticBag,
): Map<string, ProjectFile[]> {
  const resolved = new Map<string, ProjectFile[]>();
  for (const [name, paths] of Object.entries(groups)) {
    const files: ProjectFile[] = [];
    for (const path of paths) {
      const file = project.files.find((f) => f.path === path || f.id === path);
      if (!file) {
        diag.warn('filegraph', 'architecture/no-such-file', `No file "${path}"; skipping it.`);
        continue;
      }
      if (!movable(file)) {
        diag.info(
          'filegraph',
          'architecture/not-movable',
          `"${file.path}" is a ${file.role} file and stays where it is.`,
        );
        continue;
      }
      files.push(file);
    }
    if (files.length) resolved.set(name, files);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Modular -> monolithic
// ---------------------------------------------------------------------------

/**
 * Flattens every module's files into the source root and removes the modules.
 *
 * Two files in different modules can share a base name, so a collision is
 * resolved by prefixing with the module name (`storage/user.py` becomes
 * `storage_user.py`). That is reported, because a renamed file is something the
 * author should know about even when the imports are fixed for them.
 */
export function flatten(project: Project, options: ConvertOptions): ConversionResult {
  const diag = new DiagnosticBag();
  const moves: ConversionMove[] = [];

  if (project.architecture === 'monolithic' && !project.modules.length) {
    diag.info('filegraph', 'architecture/already-monolithic', 'This project is already monolithic.');
    return { moves, modules: [], diagnostics: diag, changed: false };
  }

  const backend = options.backends.get(project.language);
  const root = backend ? backend.sourceRoot(project) : 'src';
  const removed = project.modules.map((m) => m.name);

  // Reserve the names of files that are already where they need to be, so a
  // move never lands on one of them.
  const taken = new Set(
    project.files.filter((f) => !movable(f) || dirOf(f.path) === root).map((f) => f.path),
  );

  for (const file of project.files.filter(movable)) {
    if (dirOf(file.path) === root) continue;

    const module = project.modules.find((m) => m.id === file.moduleId);
    const base = nameOf(file.path);
    let target = `${root}/${base}`;

    if (taken.has(target)) {
      const prefix = module ? `${module.name}_` : `${dirOf(file.path).split('/').pop()}_`;
      target = `${root}/${prefix}${base}`;
      diag.info(
        'filegraph',
        'architecture/renamed-on-flatten',
        `"${base}" already exists in ${root}, so "${file.path}" becomes "${target}".`,
        { file: file.path },
      );
    }
    if (taken.has(target)) {
      diag.error(
        'filegraph',
        'architecture/flatten-collision',
        `Cannot flatten "${file.path}": "${target}" is taken as well.`,
        { file: file.path, hint: 'Rename one of the two files, then convert again.' },
      );
      continue;
    }

    taken.add(target);
    moves.push({ fileId: file.id, from: file.path, to: target });
  }

  if (diag.errors.length) return { moves: [], modules: [], diagnostics: diag, changed: false };

  // Unassign before moving. `renameFile` reports a file that has left its
  // module's directory, which is right for a single move and pure noise here —
  // the modules are about to be removed, so there is nothing to reassign to.
  if (!options.dryRun) {
    for (const file of project.files) delete file.moduleId;
  }

  const applied = applyMoves(project, moves, options, diag);
  if (!options.dryRun && applied) {
    project.modules = [];
    project.architecture = 'monolithic';
    touch(project);
  }

  return { moves, modules: removed, diagnostics: diag, changed: moves.length > 0 };
}

// ---------------------------------------------------------------------------

/**
 * Performs the moves through `renameFile`, so reference updating — including
 * the conservative rewrite of hand-written imports and the warnings when that
 * is not possible — behaves exactly as it does for a single rename.
 */
function applyMoves(
  project: Project,
  moves: ConversionMove[],
  options: ConvertOptions,
  diag: DiagnosticBag,
): boolean {
  if (options.dryRun) return false;
  for (const move of moves) {
    const result = renameFile(project, move.fileId, move.to, options.backends, options.readUserFile);
    diag.merge(result.diagnostics.items);
    if (result.diagnostics.errors.length) return false;
  }
  return true;
}

/**
 * Derives `module.dependencies` from the import edges that actually exist, so
 * cross-module references are checked against a real graph rather than an empty
 * one. Called after modularising; regeneration keeps it current.
 */
export function deriveModuleDependencies(project: Project): void {
  const moduleOf = new Map<string, string>();
  for (const file of project.files) if (file.moduleId) moduleOf.set(file.id, file.moduleId);

  for (const module of project.modules) module.dependencies = [];
  for (const file of project.files) {
    const from = file.moduleId;
    if (!from) continue;
    const module = project.modules.find((m) => m.id === from);
    if (!module) continue;
    for (const imp of file.imports) {
      if (imp.scope !== 'file') continue;
      const to = moduleOf.get(imp.to);
      if (!to || to === from) continue;
      if (!module.dependencies.includes(to)) module.dependencies.push(to);
    }
  }
  for (const module of project.modules) module.dependencies.sort();
}
