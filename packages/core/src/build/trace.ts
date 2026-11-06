/**
 * Execution tracing: which nodes actually ran, and how often.
 *
 * This is deliberately not a debugger. A step-through debugger needs a debug
 * adapter per language, which is real work and is not pretended at here — see
 * the omissions in docs/architecture.md. What this does instead is record the
 * lines a program executed and map them back to the nodes that produced them,
 * which answers the questions people actually ask of a visual program: did this
 * branch run, how many times did that loop go round, and which part of my graph
 * is dead.
 *
 * The trace is collected without modifying the generated code. Instrumenting it
 * would mean the thing you ran is not the thing you would ship, and every
 * backend would need to emit two variants. Instead each language is traced with
 * whatever facility it already has — `sys.settrace` for Python, V8 coverage for
 * Node — from a wrapper the program never sees.
 *
 * Mapping is by identifier, the same approach `mapDiagnostic` uses, with the
 * same honest limit: a line naming a generated symbol maps to the right node; a
 * line naming none maps only as far as the file. It never points at the wrong
 * node, which matters more than covering every line.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GeneratedSourceMap } from './sourcemap.ts';
import { matchSymbols, normalizePath } from './sourcemap.ts';
import type { CommandSpec } from '../backends/backend.ts';

/** One executed line of generated source. */
export interface LineHit {
  /** Path relative to the generated output root. */
  file: string;
  line: number;
  count: number;
  /** Position in execution order of the first time this line ran. */
  firstAt: number;
}

export interface NodeTrace {
  nodeId: string;
  graphId?: string;
  /** Times any line belonging to this node executed. */
  count: number;
  /** Rank of the node's first execution: 1 is the first node that ran. */
  order: number;
}

export interface TraceResult {
  /** Nodes that ran, most-executed first. */
  nodes: NodeTrace[];
  /** Lines that ran but could not be attributed to a node. */
  unattributed: number;
  /** Raw hits, for a source-level view. */
  hits: LineHit[];
  /** Set when the language has no tracer here. */
  unsupported?: string;
}

/**
 * How to run a program under a tracer.
 *
 * `files` are written into the output directory before the run and are not part
 * of the project — they are removed by the caller. `resultPath` is where the
 * tracer leaves its JSON.
 */
export interface TracePlan {
  command: CommandSpec;
  files: { path: string; content: string }[];
  resultPath: string;
}

/** Languages that can be traced. Everything else reports why not. */
export function canTrace(language: string): boolean {
  return language === 'python' || language === 'javascript';
}

/**
 * Builds a trace plan by wrapping the language's normal run command.
 *
 * Returns undefined when the language has no tracer, so the caller can run
 * normally and say so rather than silently producing an empty trace.
 */
export function tracePlan(language: string, run: CommandSpec): TracePlan | undefined {
  if (language === 'python') {
    return {
      files: [{ path: TRACER_PY, content: PYTHON_TRACER }],
      resultPath: TRACE_JSON,
      command: {
        ...run,
        label: `${run.label} (traced)`,
        // The tracer takes the script it should run, then the program's own
        // arguments, so argv inside the program is unchanged.
        args: [TRACER_PY, ...run.args],
      },
    };
  }

  if (language === 'javascript') {
    return {
      files: [{ path: TRACER_JS, content: JS_TRACER }],
      resultPath: TRACE_JSON,
      command: {
        ...run,
        label: `${run.label} (traced)`,
        args: [TRACER_JS, ...run.args],
      },
    };
  }

  return undefined;
}

/** Reads the tracer's output and attributes each line to a node. */
export function readTrace(root: string, plan: TracePlan, map: GeneratedSourceMap): TraceResult {
  let hits: LineHit[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(root, plan.resultPath), 'utf8')) as unknown;
    if (Array.isArray(raw)) hits = raw as LineHit[];
  } catch {
    return { nodes: [], unattributed: 0, hits: [], unsupported: 'The tracer produced no output.' };
  }
  return attribute(hits, root, map);
}

/**
 * Maps line hits onto nodes.
 *
 * A node's count is the largest count of any line attributed to it rather than
 * the sum: one statement usually spans several generated lines, and adding them
 * up would report a loop that ran ten times as having run thirty.
 */
export function attribute(hits: LineHit[], root: string, map: GeneratedSourceMap): TraceResult {
  const byNode = new Map<string, { graphId?: string; count: number; firstAt: number }>();
  const sources = new Map<string, string[]>();
  let unattributed = 0;

  const lineText = (file: string, line: number): string | undefined => {
    let lines = sources.get(file);
    if (!lines) {
      try {
        lines = readFileSync(join(root, file), 'utf8').split('\n');
      } catch {
        lines = [];
      }
      sources.set(file, lines);
    }
    return lines[line - 1];
  };

  for (const hit of hits) {
    const path = normalizePath(hit.file);
    const index = map.symbols.get(path);
    // Prefer what the backend recorded while emitting: it is exact, and it
    // covers pure nodes that were inlined and left no identifier behind.
    const exact = map.lines.get(path)?.get(hit.line);
    const text = lineText(hit.file, hit.line);
    // Otherwise credit every node named on the line. Generation inlines pure
    // nodes into their use site, so one line routinely belongs to several, and
    // picking one would report the others as never having run.
    const origins = exact ? [exact] : index && text ? matchSymbols(text, index) : [];

    if (!origins.length) {
      unattributed += 1;
      continue;
    }
    for (const origin of origins) {
      const existing = byNode.get(origin.nodeId);
      if (existing) {
        existing.count = Math.max(existing.count, hit.count);
        existing.firstAt = Math.min(existing.firstAt, hit.firstAt);
      } else {
        byNode.set(origin.nodeId, { graphId: origin.graphId, count: hit.count, firstAt: hit.firstAt });
      }
    }
  }

  // Rank by when each node first ran, so the UI can show execution order.
  const ordered = [...byNode.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt);
  const rank = new Map(ordered.map(([id], i) => [id, i + 1]));

  const nodes: NodeTrace[] = ordered
    .map(([nodeId, info]) => ({
      nodeId,
      graphId: info.graphId,
      count: info.count,
      order: rank.get(nodeId) ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.order - b.order);

  return { nodes, unattributed, hits };
}

/** Nodes in a graph that the trace never reached. */
export function unreachedNodes(trace: TraceResult, nodeIds: Iterable<string>): string[] {
  const ran = new Set(trace.nodes.map((n) => n.nodeId));
  return [...nodeIds].filter((id) => !ran.has(id));
}

// ---------------------------------------------------------------------------
// Tracers
// ---------------------------------------------------------------------------

const TRACE_JSON = '.mcode-trace.json';
const TRACER_PY = '_mcode_trace.py';
const TRACER_JS = '_mcode_trace.mjs';

/**
 * Python tracer.
 *
 * `sys.settrace` gives a callback per line, which is exactly what is wanted and
 * costs nothing at the source level. Only files under the run directory are
 * recorded, so the standard library does not drown the result.
 */
const PYTHON_TRACER = `# Generated by Master Code to record which lines ran. Not part of your project.
import atexit
import json
import os
import runpy
import sys

ROOT = os.path.abspath(os.path.dirname(__file__))
OUTPUT = os.path.join(ROOT, ${JSON.stringify(TRACE_JSON)})

hits = {}
order = [0]


def record(frame, event, arg):
    if event == 'line':
        raw = frame.f_code.co_filename
        # Skip pseudo-filenames such as <frozen importlib._bootstrap>: abspath
        # would turn them into paths that appear to live under ROOT, and the
        # interpreter's own start-up would swamp the trace.
        if raw.startswith('<'):
            return record
        # co_filename is the path as given to the interpreter, which for a
        # relative script argument is relative. Compare absolute paths, or
        # nothing under ROOT matches and the trace comes back empty.
        path = os.path.abspath(raw)
        if path.startswith(ROOT) and not os.path.basename(path).startswith('_mcode_trace'):
            key = (os.path.relpath(path, ROOT).replace(os.sep, '/'), frame.f_lineno)
            entry = hits.get(key)
            if entry is None:
                order[0] += 1
                hits[key] = [1, order[0]]
            else:
                entry[0] += 1
    return record


def save():
    sys.settrace(None)
    rows = [
        {'file': file, 'line': line, 'count': count, 'firstAt': first}
        for (file, line), (count, first) in hits.items()
    ]
    try:
        with open(OUTPUT, 'w', encoding='utf-8') as handle:
            json.dump(rows, handle)
    except OSError:
        pass


atexit.register(save)

script = sys.argv[1]
# The program must see its own arguments, not the tracer's.
sys.argv = [script] + sys.argv[2:]
sys.settrace(record)
try:
    runpy.run_path(script, run_name='__main__')
finally:
    sys.settrace(None)
`;

/**
 * JavaScript tracer.
 *
 * Node has no per-line hook, so this uses the inspector's coverage API, which
 * reports byte ranges that executed. Ranges are converted to line numbers
 * against the source on disk.
 */
const JS_TRACER = `// Generated by Master Code to record which lines ran. Not part of your project.
import { Session } from 'node:inspector/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, ${JSON.stringify(TRACE_JSON)});

const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

const script = resolve(root, process.argv[2]);
process.argv = [process.argv[0], script, ...process.argv.slice(3)];

let failure;
try {
  await import(pathToFileURL(script).href);
} catch (error) {
  failure = error;
}

const { result } = await session.post('Profiler.takePreciseCoverage');
await session.post('Profiler.stopPreciseCoverage');
session.disconnect();

const rows = [];
let order = 0;
for (const entry of result) {
  if (!entry.url.startsWith('file:')) continue;
  const path = fileURLToPath(entry.url);
  if (!path.startsWith(root)) continue;
  const name = relative(root, path).split('\\\\').join('/');
  if (name.startsWith('_mcode_trace')) continue;

  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  // Offset -> line, once per file.
  const lineAt = [];
  let line = 1;
  for (let i = 0; i < source.length; i++) {
    lineAt[i] = line;
    if (source[i] === '\\n') line += 1;
  }

  const counts = new Map();
  for (const fn of entry.functions) {
    for (const range of fn.ranges) {
      if (!range.count) continue;
      const from = lineAt[range.startOffset] ?? 1;
      const to = lineAt[Math.max(range.startOffset, range.endOffset - 1)] ?? from;
      for (let l = from; l <= to; l++) {
        counts.set(l, Math.max(counts.get(l) ?? 0, range.count));
      }
    }
  }
  for (const [l, count] of counts) {
    order += 1;
    rows.push({ file: name, line: l, count, firstAt: order });
  }
}

try {
  writeFileSync(output, JSON.stringify(rows), 'utf8');
} catch {
  // A trace we cannot write is not a reason to change the program's outcome.
}

if (failure) throw failure;
`;

export { TRACE_JSON, TRACER_JS, TRACER_PY };

/**
 * Credits pure nodes whose value fed a node that ran.
 *
 * Generation inlines a pure node into its use site, so it leaves no statement
 * and often no identifier of its own — a Literal or a Format disappears into
 * the expression that consumes it. Reporting those as "never ran" is not a gap
 * in the trace, it is a wrong answer: they demonstrably ran, because the
 * statement holding them did.
 *
 * The inference is sound in one direction only. If a consumer ran, everything
 * feeding it was evaluated. The reverse does not hold, so nothing is removed
 * here — only added.
 */
export function includeInlinedInputs(
  trace: TraceResult,
  graphs: { id: string; nodes: { id: string; type: string }[]; edges: { from: { node: string }; to: { node: string } }[] }[],
  isPure: (type: string) => boolean,
): TraceResult {
  const ran = new Map(trace.nodes.map((n) => [n.nodeId, n]));
  const added: NodeTrace[] = [];

  for (const graph of graphs) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // Repeat until nothing new is credited: a pure node may feed another pure
    // node, and a chain of them all ran if the far end did.
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of graph.edges) {
        const consumer = ran.get(edge.to.node);
        if (!consumer || ran.has(edge.from.node)) continue;
        const producer = byId.get(edge.from.node);
        if (!producer || !isPure(producer.type)) continue;

        const entry: NodeTrace = {
          nodeId: producer.id,
          graphId: graph.id,
          // It ran at least as often as whatever consumed it.
          count: consumer.count,
          order: consumer.order,
        };
        ran.set(producer.id, entry);
        added.push(entry);
        changed = true;
      }
    }
  }

  if (!added.length) return trace;
  return {
    ...trace,
    nodes: [...trace.nodes, ...added].sort((a, b) => b.count - a.count || a.order - b.order),
  };
}
