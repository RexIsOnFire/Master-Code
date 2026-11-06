/**
 * Mapping compiler output back to visual nodes.
 *
 * Every IR construct carries the id of the node that produced it, and the
 * emitters name locals after those nodes. That gives a workable bridge without
 * threading line numbers through every backend: build an index of
 * generated-identifier -> origin, then, for a diagnostic at file F line L, read
 * that line and see which generated name it mentions.
 *
 * Being straight about the accuracy: an error on a line that names a generated
 * symbol maps to the right node. An error on a line that names none of them -
 * a stray brace, a missing import - maps only as far as the file, and therefore
 * to the graph that produced the file. That is still better than a bare path,
 * and it never points at the *wrong* node, which would be worse than pointing
 * at nothing.
 */

import type { Diagnostic } from '../diagnostics.ts';
import type { IrDecl, IrModule, Origin } from '../ir/ir.ts';
import { walkDecl, walkModule } from '../ir/ir.ts';
import type { Project } from '../model/project.ts';
import type { GenerateResult } from '../codegen/generate.ts';
import { camel, pascal, snake } from '../backends/emitter.ts';

export interface GeneratedSourceMap {
  /** Generated path -> the file and graph it came from. */
  byPath: Map<string, { fileId: string; graphId?: string; language: string }>;
  /**
   * Generated path -> identifier -> origin. Identifiers are stored in every
   * casing a backend might use, since the same IR name becomes `buildGreeting`
   * in Java and `build_greeting` in Python.
   */
  symbols: Map<string, Map<string, Origin>>;
  /**
   * Generated path -> 1-based line -> origin, where the backend could say
   * exactly. Preferred over identifier matching when present; absent for
   * backends that do not report it.
   */
  lines: Map<string, Map<number, Origin>>;
}

export function buildSourceMap(project: Project, generated: GenerateResult): GeneratedSourceMap {
  const byPath = new Map<string, { fileId: string; graphId?: string; language: string }>();
  const symbols = new Map<string, Map<string, Origin>>();

  const modulesById = new Map<string, IrModule>();
  for (const program of generated.programs) {
    for (const module of program.modules) modulesById.set(module.id, module);
  }

  for (const artifact of generated.files) {
    if (!artifact.fileId) continue;
    const file = project.files.find((f) => f.id === artifact.fileId);
    if (!file) continue;
    byPath.set(artifact.path, {
      fileId: file.id,
      graphId: file.graphId,
      language: file.language,
    });

    const module = modulesById.get(file.id);
    if (!module) continue;

    const index = symbols.get(artifact.path) ?? new Map<string, Origin>();
    collectSymbols(module, index);
    symbols.set(artifact.path, index);
  }

  return { byPath, symbols, lines: generated.lineOrigins ?? new Map() };
}

function collectSymbols(module: IrModule, index: Map<string, Origin>): void {
  const record = (name: string, origin: Origin | undefined): void => {
    if (!origin || !name) return;
    for (const variant of nameVariants(name)) {
      // First writer wins: a declaration is a better anchor than a later use.
      if (!index.has(variant)) index.set(variant, origin);
    }
  };

  for (const decl of module.decls) {
    record(declName(decl), decl.origin);
    walkDecl(decl, {
      stmt: (s) => {
        if (s.k === 'let') record(s.name, s.origin ?? decl.origin);
        if (s.k === 'forRange') record(s.varName, s.origin ?? decl.origin);
        if (s.k === 'forEach') {
          record(s.varName, s.origin ?? decl.origin);
          if (s.indexName) record(s.indexName, s.origin ?? decl.origin);
        }
        if (s.k === 'try') for (const c of s.catches) record(c.varName, s.origin ?? decl.origin);
      },
    });
  }

  walkModule(module, {
    stmt: (s) => {
      if (s.k === 'let' && s.origin) record(s.name, s.origin);
    },
  });
}

function declName(decl: IrDecl): string {
  return 'name' in decl ? decl.name : '';
}

/** The spellings a backend might give one IR name. */
function nameVariants(name: string): string[] {
  return [...new Set([name, snake(name), camel(name), pascal(name), snake(name).toUpperCase()])].filter(Boolean);
}

/**
 * Attach an origin to a compiler diagnostic, when the line names something we
 * generated. Returns the diagnostic unchanged when it cannot be placed.
 */
export function mapDiagnostic(
  diagnostic: Diagnostic,
  map: GeneratedSourceMap,
  readLine?: (path: string, line: number) => string | undefined,
): Diagnostic {
  if (diagnostic.origin || !diagnostic.file) return diagnostic;

  const path = normalizePath(diagnostic.file);
  const entry = map.byPath.get(path) ?? findBySuffix(map, path);
  if (!entry) return diagnostic;

  // At minimum, point at the graph that produced this file.
  const graphOnly: Diagnostic = {
    ...diagnostic,
    origin: entry.graphId ? { nodeId: '', graphId: entry.graphId } : undefined,
  };

  const index = map.symbols.get(path);
  if (!index || !diagnostic.line) return graphOnly;

  // Prefer a symbol named in the message; compilers usually quote it.
  const fromMessage = matchSymbol(diagnostic.message, index);
  if (fromMessage) return { ...diagnostic, origin: fromMessage };

  const line = readLine?.(path, diagnostic.line) ?? diagnostic.raw;
  const fromLine = line ? matchSymbol(line, index) : undefined;
  return fromLine ? { ...diagnostic, origin: fromLine } : graphOnly;
}

/** Longest identifier in `text` that we know the origin of. */
/**
 * The node that owns an identifier appearing in a line of generated code.
 *
 * Exported because execution tracing needs the same question answered: given a
 * line the program actually ran, which node produced it?
 */
export function matchSymbol(text: string, index: Map<string, Origin>): Origin | undefined {
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!words) return undefined;
  let best: { name: string; origin: Origin } | undefined;
  for (const word of words) {
    const origin = index.get(word);
    if (!origin) continue;
    if (!best || word.length > best.name.length) best = { name: word, origin };
  }
  return best?.origin;
}

/**
 * Every node named on a line, not just the best match.
 *
 * A diagnostic wants one culprit, so `matchSymbol` picks the longest name. A
 * trace wants the opposite: `print(build_greeting(name))` is one line that
 * several nodes contributed to, and crediting only one of them reports the rest
 * as dead code.
 */
export function matchSymbols(text: string, index: Map<string, Origin>): Origin[] {
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!words) return [];
  const seen = new Set<string>();
  const out: Origin[] = [];
  for (const word of words) {
    const origin = index.get(word);
    if (!origin?.nodeId || seen.has(origin.nodeId)) continue;
    seen.add(origin.nodeId);
    out.push(origin);
  }
  return out;
}

function findBySuffix(map: GeneratedSourceMap, path: string): { fileId: string; graphId?: string; language: string } | undefined {
  for (const [known, entry] of map.byPath) {
    if (path.endsWith(known) || known.endsWith(path)) return entry;
  }
  return undefined;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Nodes a set of diagnostics points at, for highlighting in the editor. */
export function affectedNodes(diagnostics: Diagnostic[]): Set<string> {
  const out = new Set<string>();
  for (const d of diagnostics) if (d.origin?.nodeId) out.add(d.origin.nodeId);
  return out;
}
