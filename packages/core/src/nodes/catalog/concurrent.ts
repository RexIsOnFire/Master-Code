/**
 * Doing several things at once.
 *
 * Two shapes, because two things are actually being asked for. "Ask the same
 * question about each of these fifty indicators" is a map, and the answer is a
 * list. "Ask these four different systems at the same time" is a set of
 * branches, and the answer is whatever each branch wrote down.
 *
 * Both take a limit on how many run at once. That is not a performance dial -
 * it is the difference between enriching a hundred indicators and being rate
 * limited by the service you were asking. The default is deliberately small.
 */

import type { NodeDefinition, PortSpec } from '../definition.ts';
import { execIn, execOut } from '../definition.ts';
import { builtinNode } from './factory.ts';
import { E, S, at } from '../../ir/build.ts';
import { T } from '../../types/types.ts';

const CONCURRENT = '#fbbf24';

/** How many branches the Parallel node shows, from its property. */
function branchCount(props: Record<string, unknown>): number {
  const raw = Number(props.branches ?? 2);
  if (!Number.isFinite(raw)) return 2;
  return Math.max(2, Math.min(12, Math.trunc(raw)));
}

export const concurrentNodes: NodeDefinition[] = [
  builtinNode({
    type: 'fn/parallel-map',
    category: 'Concurrent',
    title: 'Map In Parallel',
    op: 'parallel_map',
    args: [
      'list',
      { name: 'transform', type: '(T) -> U' },
      { name: 'at once', default: 4, type: 'i64' },
    ],
    result: 'result',
    description:
      'Applies the transform to every element with several in flight at once, and returns the results in the original order. Use this rather than Map when the transform makes a request.',
    keywords: ['parallel', 'concurrent', 'async', 'fan out', 'batch', 'enrich', 'at once', 'map'],
    color: CONCURRENT,
  }),

  // ---------------------------------------------------------------------------
  {
    type: 'control/parallel',
    category: 'Concurrent',
    title: 'Parallel',
    description:
      'Runs each branch at the same time and continues once all of them have finished. A branch that fails fails the whole node.',
    keywords: ['parallel', 'concurrent', 'fan out', 'at once', 'join', 'gather', 'simultaneous'],
    styles: ['procedural', 'event-driven', 'service', 'dataflow'],
    inputs: [execIn()],
    outputs: [execOut('out', 'then')],
    props: [
      { name: 'branches', label: 'Branches', kind: 'number', default: 2, doc: 'Between 2 and 12.' },
      {
        name: 'atOnce',
        label: 'At once',
        kind: 'number',
        default: 4,
        doc: 'How many branches may be in flight together. Lower this when the far end is rate limited.',
      },
    ],
    ports(props) {
      const outs: PortSpec[] = [];
      for (let i = 0; i < branchCount(props); i += 1) {
        outs.push(execOut(`b${i}`, `branch ${i + 1}`));
      }
      outs.push(execOut('out', 'then'));
      return { inputs: [execIn()], outputs: outs };
    },
    color: CONCURRENT,
    validate(node, _project, diag) {
      if (Number(node.props.atOnce ?? 4) < 1) {
        diag.error('graph', 'concurrent/bad-limit', '"At once" must be at least 1.', {
          origin: { nodeId: node.id },
        });
      }
    },
    lower(ctx) {
      const count = branchCount(ctx.node.props);

      // Each branch becomes a thunk. Wrapping them rather than starting them
      // is what lets the runtime decide how many run together.
      const tasks = [];
      for (let i = 0; i < count; i += 1) {
        const body = ctx.execBranch(`b${i}`);
        if (!body.length) continue;
        tasks.push(at(E.lambda([], body, T.void), ctx.origin));
      }

      if (!tasks.length) return { stmts: ctx.execBranch('out') };

      const call = at(
        E.builtin(
          'parallel_all',
          [
            E.array(tasks, T.list(T.fn([], T.void))),
            E.int(Math.max(1, Number(ctx.prop('atOnce', 4)))),
          ],
          T.list(T.void),
        ),
        ctx.origin,
      );

      return { stmts: [at(S.expr(call), ctx.origin), ...ctx.execBranch('out')] };
    },
  },
];
