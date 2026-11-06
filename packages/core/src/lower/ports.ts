/**
 * Port materialisation and generic resolution.
 *
 * A node instance's ports come from three places: the definition's static
 * lists, the definition's `ports()` hook (which reads configuration), and any
 * variadic duplicates the user added. Once materialised, the declared types may
 * still contain type variables - `List<T>` on For Each, `(T) -> U` on Map - so
 * a second pass unifies them against whatever is actually wired up.
 *
 * Resolution walks backwards along data edges and memoises, so a diamond in the
 * data graph resolves once rather than exponentially.
 */

import type { NodeDefinition, PortSpec, NodeRegistry } from '../nodes/definition.ts';
import type { Edge, GraphNode, LogicGraph, Port, Project } from '../model/project.ts';
import type { Substitution, TypeRef } from '../types/types.ts';
import { T, parseType, substitute, unify } from '../types/types.ts';

/** Base id of a variadic port instance: `a#2` -> `a`. */
export function basePortId(portId: string): string {
  const hash = portId.indexOf('#');
  return hash < 0 ? portId : portId.slice(0, hash);
}

function specType(spec: PortSpec): TypeRef {
  return typeof spec.type === 'string' ? parseType(spec.type) : spec.type;
}

function toPort(spec: PortSpec, direction: 'in' | 'out', idOverride?: string): Port {
  return {
    id: idOverride ?? spec.id,
    name: spec.name,
    type: specType(spec),
    direction,
    defaultValue: spec.default,
    dynamic: idOverride !== undefined,
    bound: spec.bound,
    doc: spec.doc,
  };
}

/**
 * Recompute a node's ports from its definition and properties, preserving the
 * variadic instances the user has added. Called after any property edit.
 */
export function materializePorts(
  node: GraphNode,
  def: NodeDefinition,
  project: Project,
): { inputs: Port[]; outputs: Port[] } {
  const shape = def.ports ? def.ports(node.props, project) : { inputs: def.inputs, outputs: def.outputs };

  const build = (specs: PortSpec[], direction: 'in' | 'out', existing: Port[]): Port[] => {
    const out: Port[] = [];
    for (const spec of specs) {
      out.push(toPort(spec, direction));
      if (spec.variadic) {
        // Keep however many extra slots the user has already created.
        const extras = existing
          .filter((p) => p.id.startsWith(`${spec.id}#`))
          .map((p) => p.id)
          .sort(compareVariadic);
        for (const id of extras) out.push(toPort(spec, direction, id));
      }
    }
    return out;
  };

  return {
    inputs: build(shape.inputs, 'in', node.inputs ?? []),
    outputs: build(shape.outputs, 'out', node.outputs ?? []),
  };
}

function compareVariadic(a: string, b: string): number {
  const na = Number(a.slice(a.indexOf('#') + 1));
  const nb = Number(b.slice(b.indexOf('#') + 1));
  return na - nb;
}

/** Next free id for another instance of a variadic port. */
export function nextVariadicId(node: GraphNode, baseId: string, direction: 'in' | 'out'): string {
  const ports = direction === 'in' ? node.inputs : node.outputs;
  let n = 1;
  while (ports.some((p) => p.id === `${baseId}#${n}`)) n++;
  return `${baseId}#${n}`;
}

// ---------------------------------------------------------------------------
// Type resolution
// ---------------------------------------------------------------------------

export interface ResolvedTypes {
  /** `${nodeId}:${portId}` -> concrete type. */
  port: Map<string, TypeRef>;
  /** Per-node substitution, for diagnostics. */
  subst: Map<string, Substitution>;
}

const key = (nodeId: string, portId: string) => `${nodeId}:${portId}`;

export class TypeResolver {
  private readonly result: ResolvedTypes = { port: new Map(), subst: new Map() };
  private readonly inFlight = new Set<string>();
  private readonly nodesById: Map<string, GraphNode>;
  private readonly incoming: Map<string, Edge>;
  private readonly graph: LogicGraph;

  constructor(graph: LogicGraph, _registry?: NodeRegistry) {
    this.graph = graph;
    this.nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
    this.incoming = new Map();
    for (const e of graph.edges) this.incoming.set(key(e.to.node, e.to.port), e);
  }

  resolve(): ResolvedTypes {
    for (const n of this.graph.nodes) this.resolveNode(n.id);
    return this.result;
  }

  /** Concrete type of a port, resolving lazily. */
  typeOf(nodeId: string, portId: string): TypeRef {
    const k = key(nodeId, portId);
    const hit = this.result.port.get(k);
    if (hit) return hit;
    this.resolveNode(nodeId);
    return this.result.port.get(k) ?? T.any;
  }

  private resolveNode(nodeId: string): void {
    if (this.result.subst.has(nodeId)) return;
    if (this.inFlight.has(nodeId)) {
      // Data cycle. Fall back to declared types; validation reports the cycle.
      return;
    }
    this.inFlight.add(nodeId);

    const node = this.nodesById.get(nodeId);
    if (!node) {
      this.inFlight.delete(nodeId);
      return;
    }

    const subst: Substitution = new Map();

    // Unify each declared input type against whatever feeds it.
    for (const p of node.inputs) {
      if (p.type.kind === 'exec') continue;
      const edge = this.incoming.get(key(nodeId, p.id));
      if (!edge) continue;
      const sourceType = this.typeOf(edge.from.node, edge.from.port);
      unify(p.type, sourceType, subst);
    }

    // Consumers can also pin a variable, but only one the inputs left open:
    // a node whose element type is already known from its input must not be
    // re-typed by whatever it happens to feed into. That distinction is what
    // keeps `List<i64> -> Filter -> Aggregate(List<f64>)` from deciding the
    // filter's predicate takes a double.
    const fromConsumers: Substitution = new Map();
    for (const p of node.outputs) {
      if (p.type.kind === 'exec') continue;
      for (const e of this.graph.edges) {
        if (e.from.node !== nodeId || e.from.port !== p.id) continue;
        const target = this.nodesById.get(e.to.node);
        const targetPort = target?.inputs.find((x) => x.id === e.to.port);
        // Only propagate from a consumer whose own type is already concrete,
        // so resolution stays acyclic.
        if (targetPort && !hasVar(targetPort.type)) unify(p.type, targetPort.type, fromConsumers);
      }
    }
    for (const [name, type] of fromConsumers) {
      if (!subst.has(name)) subst.set(name, type);
    }

    for (const p of [...node.inputs, ...node.outputs]) {
      const resolved = substitute(p.type, subst);
      this.result.port.set(key(nodeId, p.id), collapseUnbound(resolved));
    }
    this.result.subst.set(nodeId, subst);
    this.inFlight.delete(nodeId);
  }
}

function hasVar(t: TypeRef): boolean {
  switch (t.kind) {
    case 'var':
      return true;
    case 'list':
    case 'set':
      return hasVar(t.item);
    case 'option':
    case 'future':
      return hasVar(t.inner);
    case 'map':
      return hasVar(t.key) || hasVar(t.value);
    case 'result':
      return hasVar(t.ok) || hasVar(t.err);
    case 'tuple':
      return t.items.some(hasVar);
    case 'function':
      return t.params.some(hasVar) || hasVar(t.returns);
    case 'named':
      return (t.args ?? []).some(hasVar);
    default:
      return false;
  }
}

/** Unbound type variables become `Any`, which every backend can emit. */
function collapseUnbound(t: TypeRef): TypeRef {
  if (!hasVar(t)) return t;
  const all: Substitution = new Map();
  const collect = (x: TypeRef): void => {
    if (x.kind === 'var') all.set(x.name, T.any);
    else if (x.kind === 'list' || x.kind === 'set') collect(x.item);
    else if (x.kind === 'option' || x.kind === 'future') collect(x.inner);
    else if (x.kind === 'map') {
      collect(x.key);
      collect(x.value);
    } else if (x.kind === 'result') {
      collect(x.ok);
      collect(x.err);
    } else if (x.kind === 'tuple') x.items.forEach(collect);
    else if (x.kind === 'function') {
      x.params.forEach(collect);
      collect(x.returns);
    } else if (x.kind === 'named') (x.args ?? []).forEach(collect);
  };
  collect(t);
  return substitute(t, all);
}
