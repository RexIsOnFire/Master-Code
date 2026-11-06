/**
 * Everything a project declares, in one list: functions, classes, methods,
 * enums, interfaces, state machines and variables, wherever they live.
 *
 * This exists because `file.exports` is only refreshed during generation. That
 * is correct for the file graph — an export is what a file *actually* emitted —
 * but useless for the question a user asks constantly: "what can I call from
 * here?" A function drawn thirty seconds ago has no export entry yet, and being
 * unable to reference it until you press Generate would be absurd.
 *
 * So symbols are read from the graphs, which are the source of truth, and
 * cross-checked against the exports to say whether each one has actually been
 * emitted yet. Both facts are useful and they are reported separately rather
 * than conflated.
 */

import type { GraphNode, LogicGraph, Project, ProjectFile } from '../model/project.ts';
import { typeToString } from '../types/types.ts';
import type { TypeRef } from '../types/types.ts';
import { parseType } from '../types/types.ts';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'enum'
  | 'constant'
  | 'variable'
  | 'field'
  | 'event'
  | 'state-machine'
  | 'test';

export interface ProjectSymbol {
  /** The name as written in the graph, before per-language casing. */
  name: string;
  kind: SymbolKind;
  /** Rendered for display: `build_greeting(name: string) -> string`. */
  signature: string;
  /** Owning class, for methods and fields. */
  owner?: string;

  fileId: string;
  filePath: string;
  language: string;
  moduleId?: string;
  moduleName?: string;

  /** Where to jump to. Absent for symbols that came only from a scanned file. */
  graphId?: string;
  nodeId?: string;

  /**
   * True once the symbol appears in the file's export list, which happens on
   * generation. False means "declared in a graph but not emitted yet".
   */
  emitted: boolean;
  /** Only a `module`-scoped variable is reachable from another file. */
  scope?: 'module' | 'local' | 'field';
  doc?: string;
}

export interface SymbolQuery {
  /** Restrict to what is referenceable from this file. */
  fromFileId?: string;
  kinds?: SymbolKind[];
  /** Case-insensitive match against name, signature and path. */
  search?: string;
}

// ---------------------------------------------------------------------------

/** Every symbol the project declares, sorted by file then name. */
export function projectSymbols(project: Project): ProjectSymbol[] {
  const out: ProjectSymbol[] = [];
  const graphsById = new Map(project.graphs.map((g) => [g.id, g]));

  for (const file of project.files) {
    const graph = file.graphId ? graphsById.get(file.graphId) : undefined;
    const exported = new Set(file.exports.map((e) => e.name));

    if (graph) {
      for (const symbol of symbolsFromGraph(graph, file, project)) {
        // A method is not its own export — its class is. Judging it by its own
        // name would mark every method of an emitted class as pending.
        const emittedUnder = symbol.owner ?? symbol.name;
        out.push({ ...symbol, emitted: exported.has(emittedUnder) });
      }
    }

    // A hand-written or scanned file has no graph, so its exports are all we
    // know about it — but they are real and referenceable.
    if (!graph) {
      for (const e of file.exports) {
        out.push({
          name: e.name,
          kind: sortToKind(e.sort),
          signature: e.type ? `${e.name}: ${typeToString(e.type)}` : e.name,
          fileId: file.id,
          filePath: file.path,
          language: file.language,
          moduleId: file.moduleId,
          moduleName: moduleNameOf(project, file),
          emitted: true,
          doc: e.doc,
        });
      }
    }
  }

  return out.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name),
  );
}

/**
 * The symbols a node in `fromFileId` may reference.
 *
 * Everything in the same file, plus anything module-scoped elsewhere. A `local`
 * variable in another graph is deliberately excluded — offering it would
 * generate code that does not compile.
 */
export function symbolsVisibleFrom(project: Project, fromFileId: string): ProjectSymbol[] {
  return projectSymbols(project).filter(
    (s) => s.fileId === fromFileId || s.scope === undefined || s.scope === 'module',
  );
}

export function findSymbols(project: Project, query: SymbolQuery = {}): ProjectSymbol[] {
  let list = query.fromFileId ? symbolsVisibleFrom(project, query.fromFileId) : projectSymbols(project);
  if (query.kinds?.length) {
    const kinds = new Set(query.kinds);
    list = list.filter((s) => kinds.has(s.kind));
  }
  const q = query.search?.toLowerCase().trim();
  if (q) {
    list = list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.signature.toLowerCase().includes(q) ||
        s.filePath.toLowerCase().includes(q),
    );
  }
  return list;
}

/** Names declared more than once, which make a bare reference ambiguous. */
export function duplicateSymbolNames(project: Project): Map<string, ProjectSymbol[]> {
  const byName = new Map<string, ProjectSymbol[]>();
  for (const symbol of projectSymbols(project)) {
    // A method belongs to its class, so two classes may share a method name.
    const key = symbol.owner ? `${symbol.owner}.${symbol.name}` : symbol.name;
    const list = byName.get(key);
    if (list) list.push(symbol);
    else byName.set(key, [symbol]);
  }
  for (const [name, list] of byName) if (list.length < 2) byName.delete(name);
  return byName;
}

// ---------------------------------------------------------------------------

function symbolsFromGraph(
  graph: LogicGraph,
  file: ProjectFile,
  project: Project,
): Omit<ProjectSymbol, 'emitted'>[] {
  const base = {
    fileId: file.id,
    filePath: file.path,
    language: file.language,
    moduleId: file.moduleId,
    moduleName: moduleNameOf(project, file),
    graphId: graph.id,
  };
  const out: Omit<ProjectSymbol, 'emitted'>[] = [];

  for (const node of graph.nodes) {
    const declared = declarationOf(node);
    if (!declared) continue;
    out.push({ ...base, ...declared, nodeId: node.id });
  }

  // Graph variables are declarations too, and the only ones a Get/Set Variable
  // node can name. Module-scoped ones are reachable from other files.
  for (const variable of graph.variables) {
    out.push({
      ...base,
      name: variable.name,
      kind: variable.constant ? 'constant' : variable.scope === 'field' ? 'field' : 'variable',
      signature: `${variable.name}: ${typeToString(variable.type)}`,
      scope: variable.scope,
      doc: variable.doc,
    });
  }

  return out;
}

/** What a node declares, if anything. Returns undefined for ordinary nodes. */
function declarationOf(
  node: GraphNode,
): Pick<ProjectSymbol, 'name' | 'kind' | 'signature' | 'owner' | 'doc'> | undefined {
  const prop = (key: string): string => String(node.props?.[key] ?? '').trim();
  const doc = prop('doc') || undefined;

  switch (node.type) {
    case 'entry/function': {
      const name = prop('name');
      if (!name) return undefined;
      return { name, kind: 'function', signature: `${name}(${paramList(node)})${returns(node)}`, doc };
    }
    case 'oop/method': {
      const name = prop('name');
      const owner = prop('className');
      if (!name) return undefined;
      return {
        name,
        kind: 'method',
        owner: owner || undefined,
        signature: `${owner ? `${owner}.` : ''}${name}(${paramList(node)})${returns(node)}`,
        doc,
      };
    }
    case 'oop/constructor': {
      const owner = prop('className');
      if (!owner) return undefined;
      return { name: owner, kind: 'method', owner, signature: `${owner}(${paramList(node)})`, doc };
    }
    case 'oop/class': {
      const name = prop('name');
      if (!name) return undefined;
      const shape = prop('shape') || 'class';
      return { name, kind: 'class', signature: `${shape} ${name}`, doc };
    }
    case 'oop/interface': {
      const name = prop('name');
      return name ? { name, kind: 'interface', signature: `interface ${name}`, doc } : undefined;
    }
    case 'oop/enum': {
      const name = prop('name');
      return name ? { name, kind: 'enum', signature: `enum ${name}`, doc } : undefined;
    }
    case 'state/machine': {
      const name = prop('name');
      return name ? { name, kind: 'state-machine', signature: `state machine ${name}`, doc } : undefined;
    }
    case 'event/handler': {
      const name = prop('event');
      return name ? { name, kind: 'event', signature: `on ${name}`, doc } : undefined;
    }
    case 'test/case': {
      const name = prop('name');
      return name ? { name, kind: 'test', signature: `test ${name}`, doc } : undefined;
    }
    case 'entry/main':
      return { name: 'main', kind: 'function', signature: 'main()', doc };
    default:
      return undefined;
  }
}

/**
 * Renders the `ports` property a Function or Method node uses for parameters.
 * Best effort: this is display text, and a half-configured node should still
 * show something useful rather than throw.
 */
function paramList(node: GraphNode): string {
  const raw = node.props?.params;
  if (!Array.isArray(raw)) return '';
  return raw
    .map((p) => {
      const spec = p as { name?: unknown; type?: unknown };
      const name = String(spec?.name ?? '').trim() || '_';
      const type = spec?.type ? safeType(spec.type) : 'Any';
      return `${name}: ${type}`;
    })
    .join(', ');
}

function returns(node: GraphNode): string {
  const raw = node.props?.returns;
  if (raw === undefined || raw === null || raw === '') return '';
  const type = safeType(raw);
  return type === 'void' ? '' : ` -> ${type}`;
}

function safeType(value: unknown): string {
  if (typeof value !== 'string') return typeToString(value as TypeRef);
  try {
    return typeToString(parseType(value));
  } catch {
    return value;
  }
}

function sortToKind(sort: string): SymbolKind {
  switch (sort) {
    case 'function':
      return 'function';
    case 'class':
      return 'class';
    case 'interface':
      return 'interface';
    case 'enum':
      return 'enum';
    case 'const':
      return 'constant';
    case 'variable':
      return 'variable';
    default:
      return 'constant';
  }
}

function moduleNameOf(project: Project, file: ProjectFile): string | undefined {
  return file.moduleId ? project.modules.find((m) => m.id === file.moduleId)?.name : undefined;
}

/**
 * The closest name in `candidates`, for a "did you mean" hint.
 *
 * Plain edit distance with a tight cutoff: a suggestion that is wrong is worse
 * than no suggestion, because the user will try it.
 */
export function closestName(target: string, candidates: readonly string[]): string | undefined {
  const limit = Math.max(2, Math.floor(target.length / 3));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (candidate === target) continue;
    const distance = editDistance(target.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance && distance <= limit) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
