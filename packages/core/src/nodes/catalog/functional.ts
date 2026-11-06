/**
 * Functional vocabulary: lambdas, function values, and the higher-order list
 * operations that consume them.
 */

import type { NodeDefinition } from '../definition.ts';
import { execOut, port, toIdentifier } from '../definition.ts';
import { builtinNode } from './factory.ts';
import { E, at } from '../../ir/build.ts';
import type { IrParam } from '../../ir/ir.ts';
import { T, parseType, typeToString } from '../../types/types.ts';

interface ParamDef {
  name: string;
  type: string;
}

function readParams(props: Record<string, unknown>): ParamDef[] {
  const raw = props.params;
  if (!Array.isArray(raw)) return [{ name: 'x', type: 'Any' }];
  const list = raw
    .filter((p): p is ParamDef => !!p && typeof p === 'object' && typeof (p as ParamDef).name === 'string')
    .map((p) => ({ name: toIdentifier(p.name), type: p.type || 'Any' }));
  return list.length ? list : [{ name: 'x', type: 'Any' }];
}

export const functionalNodes: NodeDefinition[] = [
  // -------------------------------------------------------------------------
  {
    type: 'fn/lambda',
    category: 'Functional',
    title: 'Lambda',
    description:
      'An anonymous function value. In expression mode the wired result becomes the body; in statement mode the execution chain does.',
    keywords: ['closure', 'anonymous', 'arrow', 'callback', 'function'],
    styles: ['functional', 'dataflow', 'pipeline', 'event-driven', 'procedural', 'object-oriented'],
    pure: true,
    inputs: [port('result', 'result', 'Any')],
    outputs: [port('fn', 'function', 'Any')],
    props: [
      { name: 'params', label: 'Parameters', kind: 'ports', default: [{ name: 'x', type: 'Any' }] },
      { name: 'returns', label: 'Returns', kind: 'type', default: 'Any' },
      {
        name: 'mode',
        label: 'Body',
        kind: 'select',
        default: 'expression',
        options: [
          { value: 'expression', label: 'Expression (wire the result)' },
          { value: 'statements', label: 'Statements (use the exec chain)' },
        ],
      },
      { name: 'isAsync', label: 'Async', kind: 'boolean', default: false },
    ],
    ports(props) {
      const params = readParams(props);
      const returns = String(props.returns ?? 'Any');
      const signature = `(${params.map((p) => p.type).join(', ')}) -> ${returns}`;
      const outs = [
        port('fn', 'function', signature),
        ...params.map((p) => port(`p:${p.name}`, p.name, p.type, { bound: true })),
      ];
      if (props.mode === 'statements') outs.splice(1, 0, execOut('body', 'body'));
      return {
        inputs: props.mode === 'statements' ? [] : [port('result', 'result', returns)],
        outputs: outs,
      };
    },
    color: '#a3e635',
    lower(ctx) {
      const params = readParams(ctx.node.props);
      const returns = ctx.propType('returns', T.any);
      const irParams: IrParam[] = params.map((p) => ({ name: p.name, type: parseType(p.type) }));
      const exprs: Record<string, ReturnType<typeof E.ref>> = {};
      for (const p of params) {
        const ref = E.ref(p.name, parseType(p.type));
        exprs[`p:${p.name}`] = ref;
        ctx.bindOutput(`p:${p.name}`, ref);
      }
      const body =
        ctx.prop('mode', 'expression') === 'statements'
          ? ctx.execBranch('body')
          : ctx.input('result');
      const lambda = at(E.lambda(irParams, body, returns, ctx.prop('isAsync', false)), ctx.origin);
      exprs.fn = lambda;
      return { exprs };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'fn/reference',
    category: 'Functional',
    title: 'Function Reference',
    description: 'Passes a named function as a value, without calling it.',
    keywords: ['pointer', 'handle', 'callback', 'first class'],
    styles: ['functional', 'dataflow', 'pipeline', 'event-driven'],
    pure: true,
    inputs: [],
    outputs: [port('fn', 'function', 'Any')],
    props: [
      { name: 'target', label: 'Function', kind: 'symbol', default: '' },
      { name: 'signature', label: 'Signature', kind: 'type', default: '(Any) -> Any' },
    ],
    ports(props) {
      return { inputs: [], outputs: [port('fn', 'function', String(props.signature ?? '(Any) -> Any'))] };
    },
    color: '#a3e635',
    lower(ctx) {
      const target = ctx.prop('target', '');
      if (!target) {
        ctx.error('fn-ref/no-target', 'Function Reference has no target selected.');
        return { exprs: { fn: E.null() } };
      }
      const sig = ctx.propType('signature', T.fn([T.any], T.any));
      return { exprs: { fn: at(E.symbol(target, sig), ctx.origin) } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'fn/compose',
    category: 'Functional',
    title: 'Compose',
    description: 'Builds a new function that applies `f` and then `g`.',
    keywords: ['pipe', 'chain', 'combine', 'then'],
    styles: ['functional', 'dataflow', 'pipeline'],
    pure: true,
    inputs: [port('f', 'f', '(A) -> B'), port('g', 'g', '(B) -> C')],
    outputs: [port('fn', 'f then g', '(A) -> C')],
    color: '#a3e635',
    lower(ctx) {
      const f = ctx.input('f');
      const g = ctx.input('g');
      const aType = f.type.kind === 'function' ? (f.type.params[0] ?? T.any) : T.any;
      const cType = g.type.kind === 'function' ? g.type.returns : T.any;
      const bType = f.type.kind === 'function' ? f.type.returns : T.any;
      const inner = E.call(f, [E.ref('x', aType)], bType);
      const outer = E.call(g, [inner], cType);
      return {
        exprs: { fn: at(E.lambda([{ name: 'x', type: aType }], outer, cType), ctx.origin) },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'fn/apply',
    category: 'Functional',
    title: 'Apply',
    description: 'Calls a function value with the given arguments.',
    keywords: ['call', 'invoke', 'run'],
    styles: ['functional', 'dataflow', 'pipeline', 'event-driven'],
    pure: true,
    inputs: [port('fn', 'function', 'Any'), port('a', 'arg', 'Any', { variadic: true })],
    outputs: [port('result', 'result', 'Any')],
    props: [{ name: 'returns', label: 'Return type', kind: 'type', default: 'Any' }],
    ports(props) {
      return {
        inputs: [port('fn', 'function', 'Any'), port('a', 'arg', 'Any', { variadic: true })],
        outputs: [port('result', 'result', String(props.returns ?? 'Any'))],
      };
    },
    color: '#a3e635',
    lower(ctx) {
      const returns = ctx.propType('returns', T.any);
      return {
        exprs: { result: at(E.call(ctx.input('fn'), ctx.variadic('a'), returns), ctx.origin) },
      };
    },
  },

  // -- higher-order list operations -----------------------------------------
  builtinNode({
    type: 'fn/map',
    category: 'Functional',
    title: 'Map',
    op: 'list_map',
    args: ['list', { name: 'transform', type: '(T) -> U' }],
    result: 'result',
    keywords: ['transform', 'each', 'project', 'select'],
    color: '#a3e635',
  }),
  builtinNode({
    type: 'fn/filter',
    category: 'Functional',
    title: 'Filter',
    op: 'list_filter',
    args: ['list', { name: 'predicate', type: '(T) -> bool' }],
    result: 'result',
    keywords: ['where', 'keep', 'select', 'reject'],
    color: '#a3e635',
  }),
  builtinNode({
    type: 'fn/reduce',
    category: 'Functional',
    title: 'Reduce',
    op: 'list_reduce',
    args: ['list', { name: 'combine', type: '(U, T) -> U' }, { name: 'initial', type: 'U' }],
    result: 'result',
    keywords: ['fold', 'accumulate', 'aggregate', 'sum'],
    color: '#a3e635',
  }),
  builtinNode({
    type: 'fn/any',
    category: 'Functional',
    title: 'Any Match',
    op: 'list_any',
    args: ['list', { name: 'predicate', type: '(T) -> bool' }],
    result: 'matched',
    color: '#a3e635',
  }),
  builtinNode({
    type: 'fn/all',
    category: 'Functional',
    title: 'All Match',
    op: 'list_all',
    args: ['list', { name: 'predicate', type: '(T) -> bool' }],
    result: 'matched',
    color: '#a3e635',
  }),
  builtinNode({
    type: 'fn/find',
    category: 'Functional',
    title: 'Find First',
    op: 'list_find',
    args: ['list', { name: 'predicate', type: '(T) -> bool' }],
    result: 'found',
    color: '#a3e635',
  }),
];

/** Signature string for a lambda node, used by the editor's port labels. */
export function lambdaSignature(props: Record<string, unknown>): string {
  const params = readParams(props);
  return `(${params.map((p) => p.type).join(', ')}) -> ${String(props.returns ?? 'Any')}`;
}

export { typeToString };
