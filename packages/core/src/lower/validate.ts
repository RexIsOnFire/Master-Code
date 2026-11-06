/**
 * Graph validation.
 *
 * Runs before lowering and is also what the editor calls after every edit, so
 * a bad connection is reported the moment it is made rather than at build time.
 * Everything reported here carries an `origin`, so the UI can highlight the
 * offending node or wire directly.
 */

import type { NodeRegistry } from '../nodes/definition.ts';
import type { Edge, GraphNode, LogicGraph, Project } from '../model/project.ts';
import { DiagnosticBag } from '../diagnostics.ts';
import { TypeResolver, basePortId } from './ports.ts';
import { isAssignable, typeToString } from '../types/types.ts';

export interface ValidationResult {
  diagnostics: DiagnosticBag;
  resolver: TypeResolver;
}

export function validateGraph(
  graph: LogicGraph,
  project: Project,
  registry: NodeRegistry,
  language: string,
  diag = new DiagnosticBag(),
): ValidationResult {
  const resolver = new TypeResolver(graph, registry);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // -- structural checks -----------------------------------------------------
  const seenIds = new Set<string>();
  for (const n of graph.nodes) {
    if (seenIds.has(n.id)) {
      diag.error('graph', 'graph/duplicate-node-id', `Two nodes share the id "${n.id}".`, {
        origin: { nodeId: n.id, graphId: graph.id },
      });
    }
    seenIds.add(n.id);

    const def = registry.get(n.type);
    if (!def) {
      diag.error('graph', 'graph/unknown-node-type', `No node type "${n.type}" is registered.`, {
        origin: { nodeId: n.id, graphId: graph.id },
        hint: 'It may come from a plugin that is not loaded.',
      });
      continue;
    }
    if (def.languages?.length && !def.languages.includes(language)) {
      diag.error(
        'graph',
        'graph/node-language',
        `"${def.title}" is only available for ${def.languages.join(', ')}, but this file targets ${language}.`,
        { origin: { nodeId: n.id, graphId: graph.id } },
      );
    }
    def.validate?.(n, project, diag);
  }

  for (const e of graph.edges) {
    const from = byId.get(e.from.node);
    const to = byId.get(e.to.node);
    if (!from || !to) {
      diag.error('graph', 'graph/dangling-edge', 'An edge references a node that no longer exists.', {
        origin: { nodeId: e.from.node, graphId: graph.id },
        hint: 'Delete the wire and reconnect it.',
      });
      continue;
    }
    const fromPort = from.outputs.find((p) => p.id === e.from.port);
    const toPort = to.inputs.find((p) => p.id === e.to.port);
    if (!fromPort || !toPort) {
      diag.error('graph', 'graph/dangling-port', 'An edge references a port that no longer exists.', {
        origin: { nodeId: (fromPort ? to : from).id, portId: fromPort ? e.to.port : e.from.port, graphId: graph.id },
        hint: 'Node properties changed and removed the port; reconnect the wire.',
      });
    }
  }

  // -- fan-in / fan-out rules ------------------------------------------------
  const inCount = new Map<string, Edge[]>();
  const outCount = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    push(inCount, `${e.to.node}:${e.to.port}`, e);
    push(outCount, `${e.from.node}:${e.from.port}`, e);
  }

  for (const n of graph.nodes) {
    for (const p of n.inputs) {
      const edges = inCount.get(`${n.id}:${p.id}`) ?? [];
      if (edges.length > 1) {
        diag.error(
          'graph',
          p.type.kind === 'exec' ? 'graph/multiple-exec-in' : 'graph/multiple-data-in',
          p.type.kind === 'exec'
            ? `"${n.title ?? n.type}" has ${edges.length} execution wires arriving at the same input.`
            : `Input "${p.name || p.id}" has ${edges.length} sources; a data input takes one.`,
          {
            origin: { nodeId: n.id, portId: p.id, graphId: graph.id },
            hint:
              p.type.kind === 'exec'
                ? 'Merge the chains with a Sequence node, or extract the shared part into a function.'
                : 'Remove one of the wires.',
          },
        );
      }
    }
    for (const p of n.outputs) {
      if (p.type.kind !== 'exec') continue;
      const edges = outCount.get(`${n.id}:${p.id}`) ?? [];
      if (edges.length > 1) {
        diag.error('graph', 'graph/multiple-exec-out', `Execution output "${p.name || p.id}" has ${edges.length} wires.`, {
          origin: { nodeId: n.id, portId: p.id, graphId: graph.id },
          hint: 'Execution is a single ordered chain. Use a Sequence node to fan out.',
        });
      }
    }
  }

  // -- type checking ---------------------------------------------------------
  resolver.resolve();
  for (const e of graph.edges) {
    const from = byId.get(e.from.node);
    const to = byId.get(e.to.node);
    if (!from || !to) continue;
    const fromPort = from.outputs.find((p) => p.id === e.from.port);
    const toPort = to.inputs.find((p) => p.id === e.to.port);
    if (!fromPort || !toPort) continue;

    const src = resolver.typeOf(e.from.node, e.from.port);
    const dst = resolver.typeOf(e.to.node, e.to.port);
    const check = isAssignable(src, dst);
    if (!check.ok) {
      diag.error(
        'type',
        'type/incompatible-connection',
        `Cannot connect ${typeToString(src)} to ${typeToString(dst)}: ${check.reason}.`,
        {
          origin: { nodeId: e.to.node, portId: e.to.port, graphId: graph.id },
          hint: 'Insert a Cast node, or change one of the port types.',
        },
      );
    } else if (check.coercion === 'to-string' && dst.kind === 'primitive' && src.kind !== 'primitive') {
      diag.warn(
        'type',
        'type/implicit-to-string',
        `${typeToString(src)} will be converted to text automatically.`,
        {
          origin: { nodeId: e.to.node, portId: e.to.port, graphId: graph.id },
          hint: 'Add a To String node to make the conversion explicit.',
        },
      );
    }
  }

  // -- unconnected required inputs ------------------------------------------
  for (const n of graph.nodes) {
    const def = registry.get(n.type);
    if (!def) continue;
    for (const p of n.inputs) {
      if (p.type.kind === 'exec') continue;
      if (inCount.has(`${n.id}:${p.id}`)) continue;
      if (p.defaultValue !== undefined) continue;
      // Variadic slots are optional by nature.
      if (basePortId(p.id) !== p.id) continue;
      const spec = def.inputs.find((s) => s.id === p.id);
      if (spec?.variadic) continue;
      diag.warn('graph', 'graph/unconnected-input', `Input "${p.name || p.id}" is not connected and has no default.`, {
        origin: { nodeId: n.id, portId: p.id, graphId: graph.id },
        hint: `A zero value of type ${typeToString(p.type)} will be used.`,
      });
    }
  }

  // -- reachability ----------------------------------------------------------
  const roots = graph.nodes.filter((n) => registry.get(n.type)?.root);
  if (!roots.length && graph.nodes.length) {
    diag.warn('graph', 'graph/no-root', 'This graph has no entry point, so it generates no code.', {
      origin: { nodeId: graph.nodes[0].id, graphId: graph.id },
      hint: 'Add a Main, Function, Class, Event Handler or Test Case node.',
    });
  }

  const reachable = collectReachable(graph, roots, registry);
  for (const n of graph.nodes) {
    if (reachable.has(n.id)) continue;
    const def = registry.get(n.type);
    if (!def) continue;
    diag.warn('graph', 'graph/unreachable', `"${def.title}" is not reachable from any entry point.`, {
      origin: { nodeId: n.id, graphId: graph.id },
      hint: 'Wire it into an execution chain, or into something that is.',
    });
  }

  // -- execution cycles ------------------------------------------------------
  for (const cycle of findExecCycles(graph, registry)) {
    diag.error('graph', 'graph/exec-cycle', `Execution chain loops back on itself: ${cycle.join(' -> ')}.`, {
      origin: { nodeId: cycle[0], graphId: graph.id },
      hint: 'Use a While or For loop instead of wiring the chain into a circle.',
    });
  }

  // -- data cycles -----------------------------------------------------------
  for (const cycle of findDataCycles(graph)) {
    diag.error('graph', 'graph/data-cycle', `Data flow loops back on itself: ${cycle.join(' -> ')}.`, {
      origin: { nodeId: cycle[0], graphId: graph.id },
      hint: 'Break the loop with a variable: write it in one place and read it in the other.',
    });
  }

  // -- duplicate declarations ------------------------------------------------
  const declared = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    const def = registry.get(n.type);
    if (!def?.root) continue;
    const name = String(n.props.name ?? n.props.event ?? '');
    if (!name) continue;
    const kind = n.type.startsWith('oop/class') ? 'type' : 'function';
    // A method belongs to its class: two classes may each have a `find`.
    const owner = String(n.props.className ?? '').trim();
    const k = `${kind}:${owner ? `${owner}.` : ''}${name}`;
    if (!declared.has(k)) declared.set(k, []);
    declared.get(k)!.push(n);
  }
  for (const [k, nodes] of declared) {
    if (nodes.length < 2) continue;
    for (const n of nodes.slice(1)) {
      diag.error('graph', 'graph/duplicate-declaration', `"${k.split(':')[1]}" is declared more than once in this file.`, {
        origin: { nodeId: n.id, graphId: graph.id },
        hint: 'Rename one of them, or move it to another file.',
      });
    }
  }

  return { diagnostics: diag, resolver };
}

// ---------------------------------------------------------------------------

function push<V>(m: Map<string, V[]>, k: string, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/** Nodes reachable from the roots by following exec chains and data edges backwards. */
function collectReachable(graph: LogicGraph, roots: GraphNode[], registry: NodeRegistry): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = roots.map((r) => r.id);

  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    // Forwards along exec outputs.
    for (const e of graph.edges) {
      if (e.from.node !== id) continue;
      const p = node.outputs.find((x) => x.id === e.from.port);
      if (p?.type.kind === 'exec') stack.push(e.to.node);
    }
    // Backwards along data inputs.
    for (const e of graph.edges) {
      if (e.to.node !== id) continue;
      const p = node.inputs.find((x) => x.id === e.to.port);
      if (p && p.type.kind !== 'exec') stack.push(e.from.node);
    }
  }
  return seen;
}

function findExecCycles(graph: LogicGraph, registry: NodeRegistry): string[][] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const next = new Map<string, string[]>();
  for (const e of graph.edges) {
    const from = byId.get(e.from.node);
    const p = from?.outputs.find((x) => x.id === e.from.port);
    if (p?.type.kind !== 'exec') continue;
    push(next, e.from.node, e.to.node);
  }
  return findCycles(graph.nodes.map((n) => n.id), next);
}

function findDataCycles(graph: LogicGraph): string[][] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const next = new Map<string, string[]>();
  for (const e of graph.edges) {
    const from = byId.get(e.from.node);
    const p = from?.outputs.find((x) => x.id === e.from.port);
    if (!p || p.type.kind === 'exec') continue;
    // A body-scoped output (a parameter, a loop item) feeding back into its own
    // declaring node is nesting, not a cycle.
    if (p.bound) continue;
    push(next, e.from.node, e.to.node);
  }
  return findCycles(graph.nodes.map((n) => n.id), next);
}

/** Depth-first cycle enumeration; returns each cycle once, as a node path. */
export function findCycles(nodes: string[], edges: Map<string, string[]>): string[][] {
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const cycles: string[][] = [];
  const seenKeys = new Set<string>();

  const visit = (id: string): void => {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      const start = path.indexOf(id);
      if (start >= 0) {
        const cycle = [...path.slice(start), id];
        const k = [...cycle].sort().join('|');
        if (!seenKeys.has(k)) {
          seenKeys.add(k);
          cycles.push(cycle);
        }
      }
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    path.push(id);
    for (const n of edges.get(id) ?? []) visit(n);
    path.pop();
    state.set(id, 2);
  };

  for (const n of nodes) visit(n);
  return cycles;
}
