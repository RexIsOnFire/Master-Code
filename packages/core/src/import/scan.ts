/**
 * Importing an existing codebase.
 *
 * The honest goal here is not to reverse-engineer source into node graphs.
 * Round-tripping arbitrary code through a visual representation loses
 * information, and a lossy import that *looks* complete is worse than one that
 * is upfront about what it did.
 *
 * So the importer builds the **file graph** and the **symbol index**, and marks
 * every existing file as `user` - owned by the person who wrote it, never
 * overwritten. What that buys is real:
 *
 *   - the project explorer and architecture view show the actual codebase;
 *   - `Call Function` and `Use Module Member` can target existing functions,
 *     because their names are indexed;
 *   - new visual files generate correct imports against the existing ones;
 *   - circular imports and orphaned modules are reported.
 *
 * In other words: you can start adding visual code to a codebase you already
 * have, which is the useful half of "import", without pretending to a fidelity
 * that is not achievable.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { BackendRegistry } from '../backends/backend.ts';
import { DiagnosticBag } from '../diagnostics.ts';
import type { ExportedSymbol, FileImport, Project, ProjectFile } from '../model/project.ts';
import { newId, normalize } from '../filegraph/graph.ts';
import { newProject } from '../project/builder.ts';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  '__pycache__', '.venv', 'venv', 'env', '.idea', '.vscode', 'vendor', '.gradle', '.mvn',
  'coverage', '.next', '.nuxt', '.cache', '.pytest_cache', '.mypy_cache',
]);

const MAX_FILE_BYTES = 2_000_000;

export interface ImportOptions {
  root: string;
  name?: string;
  backends: BackendRegistry;
  /** Stop after this many source files, to keep a huge repo from stalling. */
  maxFiles?: number;
}

export interface ImportOutcome {
  project: Project;
  diagnostics: DiagnosticBag;
  stats: {
    filesScanned: number;
    filesImported: number;
    skipped: number;
    languages: Record<string, number>;
    symbols: number;
  };
}

export function importProject(options: ImportOptions): ImportOutcome {
  const diagnostics = new DiagnosticBag();
  const { root, backends } = options;
  const maxFiles = options.maxFiles ?? 5000;

  const name = options.name ?? (root.split(/[\\/]/).filter(Boolean).pop() ?? 'Imported');
  const project = newProject({ name, language: 'python', template: 'import' });
  project.languages = [];
  project.description = `Imported from ${root}.`;

  const stats: ImportOutcome['stats'] = {
    filesScanned: 0,
    filesImported: 0,
    skipped: 0,
    languages: {},
    symbols: 0,
  };

  const paths = walk(root, root, 0);
  const byPath = new Map<string, ProjectFile>();

  for (const rel of paths) {
    stats.filesScanned++;
    if (stats.filesImported >= maxFiles) {
      stats.skipped++;
      continue;
    }
    const backend = backends.forFile(rel);
    if (!backend) {
      stats.skipped++;
      continue;
    }

    let source: string;
    try {
      const full = join(root, rel);
      if (statSync(full).size > MAX_FILE_BYTES) {
        diagnostics.warn('import', 'import/file-too-large', `Skipped "${rel}": larger than 2 MB.`, { file: rel });
        stats.skipped++;
        continue;
      }
      source = readFileSync(full, 'utf8');
    } catch (err) {
      diagnostics.warn('import', 'import/unreadable', `Could not read "${rel}": ${String(err)}`, { file: rel });
      stats.skipped++;
      continue;
    }

    const file: ProjectFile = {
      id: newId('file'),
      path: normalize(rel),
      language: backend.id,
      // Never overwritten. The user wrote it; the platform reads it.
      kind: 'user',
      role: guessRole(rel),
      exports: scanExports(source, backend.id),
      imports: [],
      contentRef: 'disk',
    };
    project.files.push(file);
    byPath.set(file.path, file);
    stats.filesImported++;
    stats.symbols += file.exports.length;
    stats.languages[backend.id] = (stats.languages[backend.id] ?? 0) + 1;
    if (!project.languages.includes(backend.id)) project.languages.push(backend.id);
  }

  // Second pass: resolve imports now that every file is known.
  for (const file of project.files) {
    let source: string;
    try {
      source = readFileSync(join(root, file.path), 'utf8');
    } catch {
      continue;
    }
    file.imports = scanImports(source, file, project, byPath);
  }

  // Pick a primary language and an entry point.
  const ranked = Object.entries(stats.languages).sort((a, b) => b[1] - a[1]);
  project.language = ranked[0]?.[0] ?? 'python';
  const entry = findEntry(project);
  if (entry) entry.role = 'entry';
  else {
    diagnostics.info('import', 'import/no-entry', 'No obvious entry point was found.', {
      hint: 'Mark one file as the entry in the project explorer.',
    });
  }

  project.architecture = inferArchitecture(project);
  if (project.architecture === 'modular') inferModules(project);

  diagnostics.info(
    'import',
    'import/summary',
    `Imported ${stats.filesImported} file(s) across ${Object.keys(stats.languages).length} language(s); ` +
      `${stats.symbols} symbol(s) indexed. Existing files are marked user-owned and will not be regenerated.`,
  );

  return { project, diagnostics, stats };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Top-level declarations a file offers.
 *
 * These are line-anchored patterns, not parsers. That is a deliberate ceiling:
 * they find the declarations that matter for cross-file references and quietly
 * miss exotic ones, rather than half-parsing and producing confident nonsense.
 */
export function scanExports(source: string, language: string): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
  const seen = new Set<string>();
  const add = (name: string, sort: ExportedSymbol['sort']): void => {
    if (!name || seen.has(name) || name.startsWith('_')) return;
    seen.add(name);
    out.push({ name, sort });
  };

  const patterns = EXPORT_PATTERNS[language] ?? [];
  for (const { re, sort, group } of patterns) {
    for (const match of source.matchAll(re)) add(match[group ?? 1], sort);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface ExportPattern {
  re: RegExp;
  sort: ExportedSymbol['sort'];
  group?: number;
}

const EXPORT_PATTERNS: Record<string, ExportPattern[]> = {
  python: [
    { re: /^def\s+([A-Za-z_]\w*)/gm, sort: 'function' },
    { re: /^async\s+def\s+([A-Za-z_]\w*)/gm, sort: 'function' },
    { re: /^class\s+([A-Za-z_]\w*)/gm, sort: 'class' },
    { re: /^([A-Z][A-Z0-9_]*)\s*[:=]/gm, sort: 'const' },
  ],
  javascript: [
    { re: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, sort: 'function' },
    { re: /^export\s+class\s+([A-Za-z_$][\w$]*)/gm, sort: 'class' },
    { re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, sort: 'const' },
    { re: /^export\s*\{\s*([^}]+)\}/gm, sort: 'unknown' },
  ],
  java: [
    { re: /^\s*public\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/gm, sort: 'class' },
    { re: /^\s*public\s+interface\s+([A-Za-z_]\w*)/gm, sort: 'interface' },
    { re: /^\s*public\s+enum\s+([A-Za-z_]\w*)/gm, sort: 'enum' },
    { re: /^\s*public\s+record\s+([A-Za-z_]\w*)/gm, sort: 'class' },
  ],
  csharp: [
    { re: /^\s*public\s+(?:sealed\s+|abstract\s+|static\s+|partial\s+)*class\s+([A-Za-z_]\w*)/gm, sort: 'class' },
    { re: /^\s*public\s+interface\s+([A-Za-z_]\w*)/gm, sort: 'interface' },
    { re: /^\s*public\s+enum\s+([A-Za-z_]\w*)/gm, sort: 'enum' },
    { re: /^\s*public\s+record\s+([A-Za-z_]\w*)/gm, sort: 'class' },
  ],
  go: [
    { re: /^func\s+([A-Z]\w*)\s*\(/gm, sort: 'function' },
    { re: /^type\s+([A-Z]\w*)\s+struct/gm, sort: 'class' },
    { re: /^type\s+([A-Z]\w*)\s+interface/gm, sort: 'interface' },
  ],
  rust: [
    { re: /^pub\s+(?:async\s+)?fn\s+([a-z_]\w*)/gm, sort: 'function' },
    { re: /^pub\s+struct\s+([A-Za-z_]\w*)/gm, sort: 'class' },
    { re: /^pub\s+enum\s+([A-Za-z_]\w*)/gm, sort: 'enum' },
    { re: /^pub\s+trait\s+([A-Za-z_]\w*)/gm, sort: 'interface' },
  ],
  cpp: [
    { re: /^(?:class|struct)\s+([A-Za-z_]\w*)\s*[:{]/gm, sort: 'class' },
    { re: /^[\w:<>*&\s]+\s+([A-Za-z_]\w*)\s*\([^;{]*\)\s*[{;]/gm, sort: 'function' },
  ],
  c: [
    { re: /^[\w*\s]+\s+([A-Za-z_]\w*)\s*\([^;{]*\)\s*[{;]/gm, sort: 'function' },
    { re: /^typedef\s+struct[^;]*?\}\s*([A-Za-z_]\w*)\s*;/gms, sort: 'class' },
  ],
  html: [],
  css: [],
};

/** Import edges this file declares, resolved to project files where possible. */
export function scanImports(
  source: string,
  file: ProjectFile,
  project: Project,
  byPath: Map<string, ProjectFile>,
): FileImport[] {
  const out: FileImport[] = [];
  const seen = new Set<string>();
  const push = (to: string, scope: FileImport['scope'], symbols?: string[]): void => {
    const key = `${scope}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ to, scope, symbols, generated: false });
  };

  for (const spec of importSpecifiers(source, file.language)) {
    const target = resolveSpecifier(spec.module, file, byPath, project);
    if (target) push(target.id, 'file', spec.symbols);
    else push(spec.module, spec.module.startsWith('.') ? 'file' : 'package', spec.symbols);
  }
  return out;
}

interface ImportSpec {
  module: string;
  symbols?: string[];
}

function importSpecifiers(source: string, language: string): ImportSpec[] {
  const out: ImportSpec[] = [];
  const list = (raw: string | undefined): string[] | undefined =>
    raw
      ? raw
          .split(',')
          .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean)
      : undefined;

  switch (language) {
    case 'python':
      for (const m of source.matchAll(/^from\s+([\w.]+)\s+import\s+([^\n#]+)/gm)) {
        out.push({ module: m[1], symbols: list(m[2].replace(/[()]/g, '')) });
      }
      for (const m of source.matchAll(/^import\s+([\w.]+)/gm)) out.push({ module: m[1] });
      break;
    case 'javascript':
      for (const m of source.matchAll(/^import\s+(?:\{([^}]*)\}\s*from\s*)?['"]([^'"]+)['"]/gm)) {
        out.push({ module: m[2], symbols: list(m[1]) });
      }
      for (const m of source.matchAll(/^import\s+[\w$]+\s+from\s+['"]([^'"]+)['"]/gm)) out.push({ module: m[1] });
      break;
    case 'java':
    case 'csharp': {
      const re = language === 'java' ? /^import\s+(?:static\s+)?([\w.]+);/gm : /^using\s+(?:static\s+)?([\w.]+);/gm;
      for (const m of source.matchAll(re)) out.push({ module: m[1] });
      break;
    }
    case 'go':
      for (const m of source.matchAll(/^\s*(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push({ module: m[1] });
      break;
    case 'rust':
      for (const m of source.matchAll(/^use\s+([\w:]+)(?:::\{([^}]*)\})?/gm)) {
        out.push({ module: m[1].replace(/::$/, ''), symbols: list(m[2]) });
      }
      break;
    case 'c':
    case 'cpp':
      for (const m of source.matchAll(/^#include\s+"([^"]+)"/gm)) out.push({ module: m[1] });
      break;
    case 'html':
      for (const m of source.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) out.push({ module: m[1] });
      break;
    default:
      break;
  }
  return out;
}

function resolveSpecifier(
  specifier: string,
  from: ProjectFile,
  byPath: Map<string, ProjectFile>,
  project: Project,
): ProjectFile | undefined {
  const dir = from.path.split('/').slice(0, -1);

  const candidates: string[] = [];
  if (specifier.startsWith('.')) {
    const parts = [...dir];
    for (const segment of specifier.split('/')) {
      if (segment === '.') continue;
      else if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    const joined = parts.join('/');
    candidates.push(joined, `${joined}.js`, `${joined}.py`, `${joined}/index.js`, `${joined}/__init__.py`);
  } else {
    const dotted = specifier.replace(/\./g, '/').replace(/::/g, '/');
    candidates.push(
      `${dotted}.py`,
      `src/${dotted}.py`,
      `${dotted}.js`,
      `src/${dotted}.js`,
      `${dotted}.rs`,
      `src/${dotted}.rs`,
      specifier,
      `${dir.join('/')}/${specifier}`,
    );
  }

  for (const candidate of candidates) {
    const hit = byPath.get(normalize(candidate));
    if (hit && hit.id !== from.id) return hit;
  }
  // Fall back to a unique basename match, which handles Java and C# packages.
  const base = specifier.split(/[./:]/).pop();
  if (base) {
    const matches = project.files.filter((f) => {
      const name = f.path.split('/').pop()?.replace(/\.[^.]+$/, '');
      return name === base && f.id !== from.id;
    });
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Structure inference
// ---------------------------------------------------------------------------

function guessRole(path: string): ProjectFile['role'] {
  const lower = path.toLowerCase();
  if (/(^|\/)(tests?|spec)s?\//.test(lower) || /(^|\/)test_|_test\.|\.test\.|\.spec\./.test(lower)) return 'test';
  if (/\.(json|toml|ya?ml|ini|cfg|xml|properties)$/.test(lower)) return 'config';
  if (/\.(md|rst|txt)$/.test(lower)) return 'doc';
  if (/(^|\/)(assets|static|public|resources)\//.test(lower)) return 'asset';
  return 'source';
}

function findEntry(project: Project): ProjectFile | undefined {
  const names = ['main', 'index', 'app', 'program', 'cli', '__main__'];
  const candidates = project.files.filter((f) => f.role === 'source' || f.role === 'entry');
  for (const name of names) {
    const hit = candidates.find((f) => {
      const base = f.path.split('/').pop()?.replace(/\.[^.]+$/, '').toLowerCase();
      return base === name;
    });
    if (hit) return hit;
  }
  return project.files.find((f) => f.language === 'html');
}

/** A project with several top-level source directories reads as modular. */
function inferArchitecture(project: Project): Project['architecture'] {
  const dirs = new Set<string>();
  for (const file of project.files) {
    if (file.role !== 'source') continue;
    const parts = file.path.replace(/^src\//, '').split('/');
    if (parts.length > 1) dirs.add(parts[0]);
  }
  return dirs.size >= 2 ? 'modular' : 'monolithic';
}

function inferModules(project: Project): void {
  const groups = new Map<string, ProjectFile[]>();
  for (const file of project.files) {
    if (file.role !== 'source') continue;
    const parts = file.path.replace(/^src\//, '').split('/');
    if (parts.length < 2) continue;
    const key = parts[0];
    const list = groups.get(key);
    if (list) list.push(file);
    else groups.set(key, [file]);
  }

  for (const [name, files] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const directory = files[0].path.startsWith('src/') ? `src/${name}` : name;
    const module = {
      id: newId('mod'),
      name,
      directory,
      version: '0.1.0',
      description: `Imported from ${directory}.`,
      // Everything a file exports is treated as public: the importer cannot
      // know the author's intent, and guessing narrower would break references.
      interface: files.flatMap((f) =>
        f.exports.map((s) => ({
          name: s.name,
          kind: (s.sort === 'class' ? 'class' : s.sort === 'const' ? 'constant' : 'function') as
            | 'class'
            | 'constant'
            | 'function',
          doc: s.doc,
        })),
      ),
      dependencies: [] as string[],
      packages: [] as string[],
      config: {},
      testFileIds: [] as string[],
    };
    project.modules.push(module);
    for (const file of files) file.moduleId = module.id;
  }

  // Module-to-module edges, from the file imports already resolved.
  const moduleOf = new Map(project.files.map((f) => [f.id, f.moduleId]));
  for (const file of project.files) {
    const from = file.moduleId;
    if (!from) continue;
    const module = project.modules.find((m) => m.id === from);
    if (!module) continue;
    for (const imp of file.imports) {
      if (imp.scope !== 'file') continue;
      const to = moduleOf.get(imp.to);
      if (to && to !== from && !module.dependencies.includes(to)) module.dependencies.push(to);
    }
  }
}

function walk(root: string, dir: string, depth: number): string[] {
  if (depth > 12) return [];
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    if (name.startsWith('.') && name !== '.env.example') continue;
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) out.push(...walk(root, full, depth + 1));
    else if (extname(name)) out.push(normalize(relative(root, full)));
  }
  return out;
}
