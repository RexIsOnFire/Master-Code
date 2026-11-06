/**
 * Example plugin: descriptive statistics.
 *
 * This is a complete, working plugin and a worked example of the extension
 * model. It adds four nodes and one project template, and it does so through
 * exactly the interfaces the built-in catalogue uses - there is no privileged
 * path for first-party nodes.
 *
 * Note what it does *not* do: it adds no per-language special cases. Each node
 * lowers to the same IR the built-ins produce, so all ten backends can emit it
 * without knowing this plugin exists. That is the property that makes a node
 * plugin a few dozen lines instead of ten backend patches.
 *
 * Drop this directory anywhere under `plugins/` and it loads on next start.
 * Verify with `mcode plugins` or `mcode nodes stats`.
 */

import { definePlugin } from '#core/plugin/api.ts';
import type { NodeDefinition } from '#core/nodes/definition.ts';
import { execIn, execOut, port } from '#core/nodes/definition.ts';
import { E, S, at } from '#core/ir/build.ts';
import { T } from '#core/types/types.ts';
import { GraphBuilder, addFile, newProject } from '#core/project/builder.ts';

/** Mean of a list of numbers, guarding against an empty list. */
const mean: NodeDefinition = {
  type: 'stats/mean',
  category: 'Statistics',
  title: 'Mean',
  description: 'Arithmetic mean of a list of numbers. An empty list gives zero.',
  keywords: ['average', 'avg', 'statistics'],
  pure: true,
  color: '#38bdf8',
  inputs: [port('values', 'values', 'List<f64>')],
  outputs: [port('mean', 'mean', 'f64')],
  lower(ctx) {
    const values = ctx.input('values');
    const total = E.builtin('list_sum', [values], T.f64);
    const count = E.builtin('to_float', [E.builtin('len', [values], T.i64)], T.f64);
    // max(count, 1) keeps an empty list from dividing by zero, in every backend.
    const safe = E.builtin('math_max', [count, E.float(1)], T.f64);
    return { exprs: { mean: at(E.bin('/', total, safe, T.f64), ctx.origin) } };
  },
};

/** Range: the spread between the smallest and largest value. */
const range: NodeDefinition = {
  type: 'stats/range',
  category: 'Statistics',
  title: 'Range',
  description: 'Difference between the largest and smallest value in a list.',
  keywords: ['spread', 'min', 'max', 'statistics'],
  pure: true,
  color: '#38bdf8',
  inputs: [port('values', 'values', 'List<f64>')],
  outputs: [port('range', 'range', 'f64'), port('min', 'min', 'Option<f64>'), port('max', 'max', 'Option<f64>')],
  lower(ctx) {
    const values = ctx.input('values');
    const low = E.builtin('list_min', [values], T.option(T.f64));
    const high = E.builtin('list_max', [values], T.option(T.f64));
    return {
      exprs: {
        // Sorting and taking the ends avoids depending on Option arithmetic,
        // which the backends spell very differently.
        range: at(
          E.bin(
            '-',
            E.builtin('list_get', [E.builtin('list_sort', [values], T.list(T.f64)), E.bin('-', E.builtin('len', [values], T.i64), E.int(1), T.i64)], T.f64),
            E.builtin('list_get', [E.builtin('list_sort', [values], T.list(T.f64)), E.int(0)], T.f64),
            T.f64,
          ),
          ctx.origin,
        ),
        min: low,
        max: high,
      },
    };
  },
};

/** Running tally, held in a graph variable. */
const accumulate: NodeDefinition = {
  type: 'stats/accumulate',
  category: 'Statistics',
  title: 'Accumulate',
  description: 'Adds a value to a running total held in a graph variable.',
  keywords: ['running total', 'sum', 'tally'],
  color: '#38bdf8',
  inputs: [execIn(), port('value', 'value', 'f64', { default: 0 })],
  outputs: [execOut(), port('total', 'total', 'f64')],
  props: [{ name: 'variable', label: 'Total variable', kind: 'variable', default: '' }],
  lower(ctx) {
    const name = ctx.prop('variable', '');
    const variable = ctx.variable(name);
    if (!variable) {
      ctx.error(
        'stats/no-variable',
        `Accumulate needs a variable to hold the total; "${name}" does not exist.`,
        'Create one in the Variables panel, then pick it here.',
      );
      return { stmts: ctx.execBranch('out') };
    }
    const ref = E.ref(variable.name, variable.type);
    ctx.bindOutput('total', ref);
    const add = at(S.assign(ref, ctx.input('value'), '+'), ctx.origin);
    return { stmts: [add, ...ctx.execBranch('out')], exprs: { total: ref } };
  },
};

/** Normalise a value into 0..1 given a known range. */
const normalize: NodeDefinition = {
  type: 'stats/normalize',
  category: 'Statistics',
  title: 'Normalise',
  description: 'Rescales a value into 0..1 given the low and high bounds of its range.',
  keywords: ['scale', 'rescale', 'clamp', 'statistics'],
  pure: true,
  color: '#38bdf8',
  inputs: [
    port('value', 'value', 'f64', { default: 0 }),
    port('low', 'low', 'f64', { default: 0 }),
    port('high', 'high', 'f64', { default: 1 }),
  ],
  outputs: [port('result', 'result', 'f64')],
  lower(ctx) {
    const value = ctx.input('value');
    const low = ctx.input('low');
    const high = ctx.input('high');
    const span = E.builtin('math_max', [E.bin('-', high, low, T.f64), E.float(1e-9)], T.f64);
    const scaled = E.bin('/', E.bin('-', value, low, T.f64), span, T.f64);
    // Clamp so a value outside the stated range still lands in 0..1.
    const clamped = E.builtin('math_min', [E.builtin('math_max', [scaled, E.float(0)], T.f64), E.float(1)], T.f64);
    return { exprs: { result: at(clamped, ctx.origin) } };
  },
};

export default definePlugin({
  id: 'example.statistics',
  name: 'Statistics nodes',
  version: '1.0.0',
  apiVersion: 1,
  author: 'Master Code examples',
  description: 'Mean, range, accumulate and normalise, plus a template that uses them.',

  contributes: {
    nodes: [mean, range, accumulate, normalize],
    templates: [
      {
        id: 'python/statistics',
        language: 'python',
        title: 'Statistics report',
        description:
          'Reads a list of numbers, prints the mean and range, and normalises each value. Contributed by the example statistics plugin.',
        outline: ['src/main.py', 'requirements.txt'],
        styles: ['dataflow', 'pipeline'],
        build({ registry, options }) {
          const project = newProject({ ...options, language: 'python', template: 'python/statistics' });
          const { graph } = addFile(project, {
            path: 'src/main.py',
            language: 'python',
            role: 'entry',
            graph: { name: 'report', style: 'pipeline' },
          });
          const g = new GraphBuilder(project, registry, graph!);

          const entry = g.add('entry/main');
          const source = g.add('pipeline/source', { kind: 'range', start: 4, end: 25 });
          const asFloats = g.add('fn/map');
          const toFloat = g.add('fn/lambda', { params: [{ name: 'n', type: 'i64' }], returns: 'f64' });
          const convert = g.add('convert/to-float');
          const average = g.add('stats/mean');
          const spread = g.add('stats/range');
          const showMean = g.addWith('pipeline/sink', {}, { label: 'mean:' });
          const showRange = g.addWith('pipeline/sink', {}, { label: 'range:' });

          g.connect(toFloat, 'p:n', convert, 'a0');
          g.connect(convert, 'number', toFloat, 'result');
          g.connect(source, 'items', asFloats, 'a0');
          g.connect(toFloat, 'fn', asFloats, 'a1');
          g.connect(asFloats, 'result', average, 'values');
          g.connect(asFloats, 'result', spread, 'values');
          g.connect(average, 'mean', showMean, 'value');
          g.connect(spread, 'range', showRange, 'value');
          g.chain(entry, showMean, showRange);

          return project;
        },
      },
    ],
  },

  activate(context) {
    context.log(`registered ${4} statistics nodes for ${context.backends.ids().length} languages`);
  },
});
