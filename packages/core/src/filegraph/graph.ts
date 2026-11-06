/**
 * The file graph.
 *
 * The logic graph says what the program does; the file graph says how it is
 * laid out and which file reaches which. They are separate on purpose - moving
 * `models/user.py` to `domain/user.py` is a file-graph edit and must not
 * disturb a single node.
 *
 * The load-bearing decision here is that internal references are stored by
 * **file id**, never by path. A rename therefore changes one field, and every
 * generated import is recomputed correctly on the next generate without any
 * text rewriting at all. Hand-written files are the exception - those hold real
 * text - so they get an explicit, language-aware rewrite pass, and anything the
 * pass is not confident about is reported rather than silently mangled.
 */

import type { BackendRegistry, LanguageBackend } from '../backends/backend.ts';
import { DiagnosticBag } from '../diagnostics.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { ExportedSymbol, FileImport, Project, ProjectFile } from '../model/project.ts';
import { findFile, findFileByPath, touch } from '../model/project.ts';
import { findCycles } from '../lower/validate.ts';

// ---------------------------------------------------------------------------
// Symbol index
// ---------------------------------------------------------------------------

export interface SymbolLocation {
  fileId: string;
  file: ProjectFile;
  symbol: ExportedSymbol;
}

export class SymbolIndex {
  private readonly byName = new Map<string, SymbolLocation[]>();

  constructor(project: Project) {
    for (const file of project.files) {
      for (const symbol of file.exports) {
        const list = this.byName.get(symbol.name);
        const entry: SymbolLocation = { fileId: file.id, file, symbol };
        if (list) list.push(entry);
        else this.byName.set(symbol.name, [entry]);
      }
    }
  }

  /** Every file exporting a symbol of this name. */
  all(name: string): SymbolLocation[] {
    return this.byName.get(name) ?? [];
  }

  /**
   * Resolve a name as seen from `fromFileId`. A symbol defined in the same file
   * wins; otherwise a unique external definition wins; an ambiguous name
   * returns undefined so the caller can report it rather than guess.
   */
  resolve(name: string, fromFileId: string, preferFileId?: string): SymbolLocation | undefined {
    const candidates = this.all(name);
    if (!candidates.length) return undefined;
    const local = candidates.find((c) => c.fileId === fromFileId);
    if (local) return local;
    if (preferFileId) {
      const preferred = candidates.find((c) => c.fileId === preferFileId);
      if (preferred) return preferred;
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  ambiguous(name: string): boolean {
    return this.all(name).length > 1;
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }
}

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

export interface FileEdge {
  from: string;
  to: string;
  scope: FileImport['scope'];
  symbols: string[];
}

export class FileGraph {
  readonly edges: FileEdge[] = [];
  private readonly outgoing = new Map<string, FileEdge[]>();
  private readonly incoming = new Map<string, FileEdge[]>();
  private readonly project: Project;

  constructor(project: Project) {
    this.project = project;
    for (const file of project.files) {
      for (const imp of file.imports) {
        if (imp.scope !== 'file') continue;
        const edge: FileEdge = { from: file.id, to: imp.to, scope: imp.scope, symbols: imp.symbols ?? [] };
        this.edges.push(edge);
        push(this.outgoing, file.id, edge);
        push(this.incoming, imp.to, edge);
      }
    }
  }

  /** Files this one imports. */
  dependencies(fileId: string): ProjectFile[] {
    return (this.outgoing.get(fileId) ?? [])
      .map((e) => findFile(this.project, e.to))
      .filter((f): f is ProjectFile => !!f);
  }

  /** Files that import this one. */
  dependents(fileId: string): ProjectFile[] {
    return (this.incoming.get(fileId) ?? [])
      .map((e) => findFile(this.project, e.from))
      .filter((f): f is ProjectFile => !!f);
  }

  /** Transitive closure of `dependencies`. */
  reachableFrom(fileId: string): Set<string> {
    const seen = new Set<string>();
    const stack = [fileId];
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of this.outgoing.get(id) ?? []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        stack.push(e.to);
      }
    }
    return seen;
  }

  /** Import cycles, as lists of file ids. */
  cycles(): string[][] {
    const adjacency = new Map<string, string[]>();
    for (const e of this.edges) push2(adjacency, e.from, e.to);
    return findCycles(
      this.project.files.map((f) => f.id),
      adjacency,
    );
  }

  /**
   * Files in dependency order: a file appears after everything it imports.
   * Members of a cycle keep their declaration order, since no valid order
   * exists; the caller has already been told about the cycle.
   */
  topoOrder(): ProjectFile[] {
    const state = new Map<string, 0 | 1 | 2>();
    const out: ProjectFile[] = [];
    const byId = new Map(this.project.files.map((f) => [f.id, f]));

    const visit = (id: string): void => {
      if (state.get(id)) return;
      state.set(id, 1);
      for (const e of this.outgoing.get(id) ?? []) {
        if (state.get(e.to) !== 1) visit(e.to);
      }
      state.set(id, 2);
      const file = byId.get(id);
      if (file) out.push(file);
    };
    for (const f of this.project.files) visit(f.id);
    return out;
  }

  /** Every file, annotated for the architecture view. */
  summary(): { file: ProjectFile; imports: number; importedBy: number }[] {
    return this.project.files.map((file) => ({
      file,
      imports: (this.outgoing.get(file.id) ?? []).length,
      importedBy: (this.incoming.get(file.id) ?? []).length,
    }));
  }
}

function push<V>(m: Map<string, V[]>, k: string, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function push2(m: Map<string, string[]>, k: string, v: string): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateFileGraph(project: Project, backends: BackendRegistry): DiagnosticBag {
  const diag = new DiagnosticBag();
  const graph = new FileGraph(project);
  const seenPaths = new Map<string, ProjectFile>();

  for (const file of project.files) {
    const clash = seenPaths.get(file.path.toLowerCase());
    if (clash) {
      // Case-insensitive on purpose: a project that works on Linux and breaks
      // on Windows is a bug worth catching before it ships.
      diag.error('filegraph', 'filegraph/duplicate-path', `Two files share the path "${file.path}".`, {
        file: file.path,
        hint: `Also used by file ${clash.id}. Paths must differ by more than case.`,
      });
    }
    seenPaths.set(file.path.toLowerCase(), file);

    if (!backends.get(file.language)) {
      diag.error('filegraph', 'filegraph/unknown-language', `No backend is registered for "${file.language}".`, {
        file: file.path,
        hint: `Known languages: ${backends.ids().join(', ')}`,
      });
    }

    const backend = backends.get(file.language);
    if (backend && !backend.extensions.some((e) => file.path.endsWith(e))) {
      diag.warn(
        'filegraph',
        'filegraph/extension-mismatch',
        `"${file.path}" is marked as ${backend.name} but does not use one of ${backend.extensions.join(', ')}.`,
        { file: file.path },
      );
    }

    for (const imp of file.imports) {
      if (imp.scope !== 'file') continue;
      const target = findFile(project, imp.to);
      if (!target) {
        diag.error('filegraph', 'filegraph/missing-import-target', `"${file.path}" imports a file that no longer exists.`, {
          file: file.path,
          hint: 'Delete the import, or restore the file.',
        });
        continue;
      }
      if (target.id === file.id) {
        diag.error('filegraph', 'filegraph/self-import', `"${file.path}" imports itself.`, { file: file.path });
      }
      if (target.language !== file.language && !crossLanguageAllowed(file.language, target.language)) {
        diag.error(
          'filegraph',
          'filegraph/cross-language-import',
          `"${file.path}" (${file.language}) cannot import "${target.path}" (${target.language}).`,
          {
            file: file.path,
            hint: 'Cross-language boundaries need a process or protocol, not an import. Split them into separate modules.',
          },
        );
      }
      for (const symbol of imp.symbols ?? []) {
        if (target.exports.length && !target.exports.some((e) => e.name === symbol)) {
          diag.warn(
            'filegraph',
            'filegraph/unknown-symbol',
            `"${file.path}" imports "${symbol}" from "${target.path}", which does not export it.`,
            {
              file: file.path,
              hint: `Exports: ${target.exports.map((e) => e.name).join(', ') || '(none)'}`,
            },
          );
        }
      }
    }
  }

  for (const cycle of graph.cycles()) {
    const paths = cycle.map((id) => findFile(project, id)?.path ?? id);
    diag.error('filegraph', 'filegraph/import-cycle', `Import cycle: ${paths.join(' -> ')}.`, {
      file: paths[0],
      hint: 'Move the shared declarations into a third file that both can import.',
    });
  }

  // Ambiguous exports make cross-file symbol resolution a guess.
  const index = new SymbolIndex(project);
  for (const name of index.names()) {
    const locations = index.all(name);
    if (locations.length < 2) continue;
    diag.warn('filegraph', 'filegraph/ambiguous-symbol', `"${name}" is exported by ${locations.length} files.`, {
      file: locations[0].file.path,
      hint: `Also in: ${locations.slice(1).map((l) => l.file.path).join(', ')}. References must name the module explicitly.`,
    });
  }

  return diag;
}

/** HTML may reference CSS and JavaScript; nothing else crosses languages. */
function crossLanguageAllowed(from: string, to: string): boolean {
  if (from === 'html') return to === 'css' || to === 'javascript';
  if (from === 'css') return to === 'css';
  return false;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface FileChange {
  kind: 'create' | 'delete' | 'rename' | 'edit';
  fileId: string;
  from?: string;
  to?: string;
  /** Rewritten content for user files whose text had to change. */
  content?: string;
  note?: string;
}

export interface MutationResult {
  changes: FileChange[];
  diagnostics: DiagnosticBag;
}

export function createFile(
  project: Project,
  spec: {
    path: string;
    language: string;
    kind?: ProjectFile['kind'];
    role?: ProjectFile['role'];
    moduleId?: string;
    id?: string;
  },
): { file: ProjectFile; result: MutationResult } {
  const diag = new DiagnosticBag();
  const path = normalize(spec.path);
  if (findFileByPath(project, path)) {
    diag.error('filegraph', 'filegraph/path-taken', `A file already exists at "${path}".`, { file: path });
  }
  const file: ProjectFile = {
    id: spec.id ?? newId('file'),
    path,
    language: spec.language,
    kind: spec.kind ?? 'generated',
    role: spec.role ?? 'source',
    moduleId: spec.moduleId,
    exports: [],
    imports: [],
  };
  if (diag.ok) {
    project.files.push(file);
    if (!project.languages.includes(spec.language)) project.languages.push(spec.language);
    touch(project);
  }
  return { file, result: { changes: [{ kind: 'create', fileId: file.id, to: path }], diagnostics: diag } };
}

export function deleteFile(project: Project, fileId: string): MutationResult {
  const diag = new DiagnosticBag();
  const file = findFile(project, fileId);
  if (!file) {
    diag.error('filegraph', 'filegraph/no-such-file', `No file with id ${fileId}.`);
    return { changes: [], diagnostics: diag };
  }

  const graph = new FileGraph(project);
  const dependents = graph.dependents(fileId);
  for (const d of dependents) {
    diag.warn('filegraph', 'filegraph/dangling-after-delete', `"${d.path}" imports "${file.path}", which is being deleted.`, {
      file: d.path,
      hint: 'Its import is removed; anything that used those symbols will fail to build until you rewire it.',
    });
  }

  const changes: FileChange[] = [{ kind: 'delete', fileId, from: file.path }];
  for (const other of project.files) {
    const before = other.imports.length;
    other.imports = other.imports.filter((i) => !(i.scope === 'file' && i.to === fileId));
    if (other.imports.length !== before) changes.push({ kind: 'edit', fileId: other.id, note: 'import removed' });
  }

  project.files = project.files.filter((f) => f.id !== fileId);
  project.graphs = project.graphs.filter((g) => g.fileId !== fileId);
  for (const m of project.modules) m.testFileIds = m.testFileIds.filter((t) => t !== fileId);
  touch(project);
  return { changes, diagnostics: diag };
}

/**
 * Move or rename a file.
 *
 * Generated importers need no edit at all - they reference by id and are
 * recomputed on the next generate. Hand-written importers hold literal text, so
 * their content is rewritten here and returned for the caller to write to disk.
 */
export function renameFile(
  project: Project,
  fileId: string,
  newPath: string,
  backends: BackendRegistry,
  readUserFile?: (file: ProjectFile) => string | undefined,
): MutationResult {
  const diag = new DiagnosticBag();
  const file = findFile(project, fileId);
  if (!file) {
    diag.error('filegraph', 'filegraph/no-such-file', `No file with id ${fileId}.`);
    return { changes: [], diagnostics: diag };
  }
  const target = normalize(newPath);
  if (target === file.path) return { changes: [], diagnostics: diag };

  const clash = findFileByPath(project, target);
  if (clash) {
    diag.error('filegraph', 'filegraph/path-taken', `A file already exists at "${target}".`, { file: target });
    return { changes: [], diagnostics: diag };
  }

  const backend = backends.get(file.language);
  if (backend && !backend.extensions.some((e) => target.endsWith(e))) {
    diag.warn(
      'filegraph',
      'filegraph/extension-mismatch',
      `"${target}" does not end with one of ${backend.extensions.join(', ')}.`,
      { file: target },
    );
  }

  const oldPath = file.path;
  const graph = new FileGraph(project);
  const dependents = graph.dependents(fileId);

  file.path = target;
  const changes: FileChange[] = [{ kind: 'rename', fileId, from: oldPath, to: target }];

  for (const dependent of dependents) {
    if (dependent.kind === 'generated' || dependent.kind === 'hybrid') {
      // Regeneration recomputes the import from the id; nothing to do.
      changes.push({
        kind: 'edit',
        fileId: dependent.id,
        note: 'import recomputed on next generate',
      });
      continue;
    }
    const source = readUserFile?.(dependent);
    if (source === undefined) {
      diag.warn(
        'filegraph',
        'filegraph/manual-import-update',
        `"${dependent.path}" is hand-written and imports "${oldPath}". Update its import to "${target}" yourself.`,
        { file: dependent.path },
      );
      continue;
    }
    const rewritten = rewriteImportPath(source, oldPath, target, backends.get(dependent.language));
    if (rewritten === source) {
      diag.warn(
        'filegraph',
        'filegraph/manual-import-update',
        `Could not find the import of "${oldPath}" in "${dependent.path}"; update it by hand.`,
        { file: dependent.path },
      );
      continue;
    }
    changes.push({ kind: 'edit', fileId: dependent.id, content: rewritten, note: 'import path rewritten' });
  }

  // Keep the owning module's directory honest.
  if (file.moduleId) {
    const mod = project.modules.find((m) => m.id === file.moduleId);
    if (mod && !target.startsWith(`${mod.directory}/`)) {
      diag.info(
        'filegraph',
        'filegraph/left-module',
        `"${target}" is now outside module "${mod.name}" (${mod.directory}).`,
        { file: target, hint: 'Reassign the file to another module, or move it back.' },
      );
    }
  }

  touch(project);
  return { changes, diagnostics: diag };
}

/**
 * Rewrite the module specifier for a moved file inside hand-written source.
 *
 * Deliberately conservative: it matches the specifier the language would
 * actually use, and if it does not find exactly that, it changes nothing and
 * lets the caller report it. Half-rewriting someone's file is worse than not
 * touching it.
 */
export function rewriteImportPath(
  source: string,
  oldPath: string,
  newPath: string,
  backend: LanguageBackend | undefined,
): string {
  const forms = specifierForms(oldPath, backend?.id);
  const replacements = specifierForms(newPath, backend?.id);
  let out = source;
  for (let i = 0; i < forms.length; i++) {
    const from = forms[i];
    const to = replacements[i];
    if (!from || !to || from === to) continue;
    // Only replace when the specifier appears as a whole token, so `user` does
    // not match inside `user_profile`.
    const pattern = new RegExp(`(?<![\\w./])${escapeRegExp(from)}(?![\\w./])`, 'g');
    out = out.replace(pattern, to);
  }
  return out;
}

/** The ways a path can appear in an import statement, per language. */
function specifierForms(path: string, language: string | undefined): string[] {
  const noExt = path.replace(/\.[^./]+$/, '');
  const dotted = noExt.replace(/^src\//, '').replace(/\//g, '.');
  const base = noExt.split('/').pop() ?? noExt;
  switch (language) {
    case 'python':
      return [dotted, base];
    case 'javascript':
      return [`./${noExt.replace(/^src\//, '')}.js`, path];
    case 'java':
    case 'csharp':
      return [dotted];
    case 'go':
      return [noExt];
    case 'rust':
      return [base];
    case 'c':
    case 'cpp':
      return [path, path.replace(/\.(c|cpp|cc)$/, m => (m === '.c' ? '.h' : '.hpp'))];
    default:
      return [path, noExt];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

let idCounter = 0;

/** Deterministic-ish unique id. Stable across a session, unique across files. */
export function newId(prefix: string): string {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${random}`;
}

/** Refresh a file's export list from what its module actually declares. */
export function setExports(file: ProjectFile, exports: ExportedSymbol[]): void {
  file.exports = [...exports].sort((a, b) => a.name.localeCompare(b.name));
}

/** Replace the generated import edges of a file, keeping any scanned ones. */
export function setGeneratedImports(file: ProjectFile, imports: FileImport[]): void {
  const scanned = file.imports.filter((i) => !i.generated);
  file.imports = [...imports.map((i) => ({ ...i, generated: true })), ...scanned];
}

export function diagnosticsFor(file: ProjectFile, items: Diagnostic[]): Diagnostic[] {
  return items.filter((d) => d.file === file.path);
}
