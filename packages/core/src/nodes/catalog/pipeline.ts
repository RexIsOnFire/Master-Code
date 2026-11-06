/**
 * Data-flow / pipeline vocabulary, and state machines.
 *
 * Pipeline nodes are pure: they chain by data edge, so `Source -> Transform ->
 * Filter -> Aggregate -> Sink` reads left to right with no execution wire.
 * Only the sink is exec-threaded, because that is where the effect happens.
 */

import type { NodeDefinition } from '../definition.ts';
import { execIn, execOut, port, toIdentifier } from '../definition.ts';
import { E, S, at } from '../../ir/build.ts';
import type { IrClass, IrEnum, IrFunction, IrStmt } from '../../ir/ir.ts';
import { T } from '../../types/types.ts';

export const pipelineNodes: NodeDefinition[] = [
  // -------------------------------------------------------------------------
  {
    type: 'pipeline/source',
    category: 'Pipeline',
    title: 'Source',
    description:
      'Start of a data pipeline. Produces a list from a wired collection, an integer range, or the lines of a text file.',
    keywords: ['input', 'read', 'stream', 'origin', 'from'],
    styles: ['dataflow', 'pipeline'],
    pure: true,
    inputs: [port('input', 'input', 'Any')],
    outputs: [port('items', 'items', 'List<Any>')],
    props: [
      {
        name: 'kind',
        label: 'Source',
        kind: 'select',
        default: 'list',
        options: [
          { value: 'list', label: 'Wired list' },
          { value: 'range', label: 'Integer range' },
          { value: 'lines', label: 'Lines of a text file' },
        ],
      },
      { name: 'start', label: 'Range start', kind: 'integer', default: 0, visibleWhen: { prop: 'kind', equals: ['range'] } },
      { name: 'end', label: 'Range end', kind: 'integer', default: 10, visibleWhen: { prop: 'kind', equals: ['range'] } },
      { name: 'path', label: 'File path', kind: 'path', default: 'data.txt', visibleWhen: { prop: 'kind', equals: ['lines'] } },
    ],
    ports(props) {
      const kind = String(props.kind ?? 'list');
      if (kind === 'range') return { inputs: [], outputs: [port('items', 'items', 'List<i64>')] };
      if (kind === 'lines') return { inputs: [], outputs: [port('items', 'items', 'List<string>')] };
      return { inputs: [port('input', 'input', 'List<T>')], outputs: [port('items', 'items', 'List<T>')] };
    },
    color: '#0ea5e9',
    lower(ctx) {
      const kind = ctx.prop('kind', 'list');
      if (kind === 'range') {
        return {
          exprs: {
            items: at(
              E.builtin('list_range', [E.int(ctx.prop('start', 0)), E.int(ctx.prop('end', 10))], T.list(T.i64)),
              ctx.origin,
            ),
          },
        };
      }
      if (kind === 'lines') {
        ctx.requireCapability('fs.read');
        const text = E.builtin('file_read_text', [E.str(ctx.prop('path', 'data.txt'))], T.string, ['fs.read']);
        return {
          exprs: {
            items: at(E.builtin('str_split', [text, E.str('\n')], T.list(T.string)), ctx.origin),
          },
        };
      }
      return { exprs: { items: ctx.input('input') } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'pipeline/transform',
    category: 'Pipeline',
    title: 'Transform',
    description: 'Applies a function to every item flowing through the pipeline.',
    keywords: ['map', 'convert', 'project', 'stage'],
    styles: ['dataflow', 'pipeline'],
    pure: true,
    inputs: [port('items', 'items', 'List<T>'), port('fn', 'transform', '(T) -> U')],
    outputs: [port('items', 'items', 'List<U>')],
    color: '#0ea5e9',
    lower(ctx) {
      return {
        exprs: {
          items: at(
            E.builtin('list_map', [ctx.input('items'), ctx.input('fn')], ctx.portType('items')),
            ctx.origin,
          ),
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'pipeline/filter',
    category: 'Pipeline',
    title: 'Filter Stage',
    description: 'Drops items that fail a predicate.',
    keywords: ['where', 'keep', 'reject', 'stage'],
    styles: ['dataflow', 'pipeline'],
    pure: true,
    inputs: [port('items', 'items', 'List<T>'), port('fn', 'predicate', '(T) -> bool')],
    outputs: [port('items', 'items', 'List<T>')],
    color: '#0ea5e9',
    lower(ctx) {
      return {
        exprs: {
          items: at(
            E.builtin('list_filter', [ctx.input('items'), ctx.input('fn')], ctx.portType('items')),
            ctx.origin,
          ),
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'pipeline/aggregate',
    category: 'Pipeline',
    title: 'Aggregate',
    description: 'Collapses the pipeline into a single value.',
    keywords: ['sum', 'count', 'average', 'min', 'max', 'fold', 'total'],
    styles: ['dataflow', 'pipeline'],
    pure: true,
    inputs: [port('items', 'items', 'List<f64>')],
    outputs: [port('value', 'value', 'f64')],
    props: [
      {
        name: 'op',
        label: 'Operation',
        kind: 'select',
        default: 'sum',
        options: [
          { value: 'sum', label: 'Sum' },
          { value: 'count', label: 'Count' },
          { value: 'average', label: 'Average' },
          { value: 'min', label: 'Minimum' },
          { value: 'max', label: 'Maximum' },
          { value: 'join', label: 'Join as text' },
        ],
      },
      { name: 'separator', label: 'Separator', kind: 'string', default: ', ', visibleWhen: { prop: 'op', equals: ['join'] } },
    ],
    ports(props) {
      const op = String(props.op ?? 'sum');
      if (op === 'join') {
        return { inputs: [port('items', 'items', 'List<string>')], outputs: [port('value', 'text', 'string')] };
      }
      if (op === 'count') {
        return { inputs: [port('items', 'items', 'List<Any>')], outputs: [port('value', 'count', 'i64')] };
      }
      return { inputs: [port('items', 'items', 'List<f64>')], outputs: [port('value', 'value', 'f64')] };
    },
    color: '#0ea5e9',
    lower(ctx) {
      const items = ctx.input('items');
      const op = ctx.prop('op', 'sum');
      let expr;
      switch (op) {
        case 'count':
          expr = E.builtin('len', [items], T.i64);
          break;
        case 'average':
          expr = E.bin(
            '/',
            E.builtin('list_sum', [items], T.f64),
            E.builtin('math_max', [E.builtin('to_float', [E.builtin('len', [items], T.i64)], T.f64), E.float(1)], T.f64),
            T.f64,
          );
          break;
        case 'min':
          expr = E.builtin('list_min', [items], T.option(T.f64));
          break;
        case 'max':
          expr = E.builtin('list_max', [items], T.option(T.f64));
          break;
        case 'join':
          expr = E.builtin('str_join', [items, E.str(ctx.prop('separator', ', '))], T.string);
          break;
        default:
          expr = E.builtin('list_sum', [items], T.f64);
      }
      return { exprs: { value: at(expr, ctx.origin) } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'pipeline/sink',
    category: 'Pipeline',
    title: 'Sink',
    description: 'End of a pipeline: prints the result, or writes it to a file.',
    keywords: ['output', 'write', 'save', 'emit', 'to'],
    styles: ['dataflow', 'pipeline'],
    inputs: [execIn(), port('value', 'value', 'Any')],
    outputs: [execOut()],
    props: [
      {
        name: 'target',
        label: 'Target',
        kind: 'select',
        default: 'console',
        options: [
          { value: 'console', label: 'Console' },
          { value: 'file', label: 'Text file' },
        ],
      },
      { name: 'path', label: 'File path', kind: 'path', default: 'out.txt', visibleWhen: { prop: 'target', equals: ['file'] } },
      { name: 'label', label: 'Label', kind: 'string', default: '' },
    ],
    color: '#0ea5e9',
    lower(ctx) {
      const value = ctx.input('value');
      const label = ctx.prop('label', '');
      if (ctx.prop('target', 'console') === 'file') {
        ctx.requireCapability('fs.write');
        return {
          stmts: [
            at(
              S.expr(
                E.builtin(
                  'file_write_text',
                  [E.str(ctx.prop('path', 'out.txt')), E.builtin('to_string', [value], T.string)],
                  T.void,
                  ['fs.write'],
                ),
              ),
              ctx.origin,
            ),
            ...ctx.execBranch('out'),
          ],
        };
      }
      ctx.requireCapability('stdio');
      const args = label ? [E.str(label), value] : [value];
      return {
        stmts: [at(S.expr(E.builtin('print', args, T.void, ['stdio'])), ctx.origin), ...ctx.execBranch('out')],
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'state/machine',
    category: 'State Machine',
    title: 'State Machine',
    description:
      'Generates a state enum and a dispatcher class from a transition table. State entry and exit behaviour comes from State nodes naming this machine.',
    keywords: ['fsm', 'states', 'transitions', 'workflow', 'automaton'],
    styles: ['state-machine', 'event-driven'],
    root: true,
    inputs: [],
    outputs: [],
    props: [
      { name: 'name', label: 'Machine name', kind: 'identifier', default: 'Workflow' },
      { name: 'states', label: 'States', kind: 'json', default: ['Idle', 'Running', 'Done'] },
      { name: 'initial', label: 'Initial state', kind: 'string', default: 'Idle' },
      {
        name: 'transitions',
        label: 'Transitions',
        kind: 'json',
        default: [
          { from: 'Idle', event: 'start', to: 'Running' },
          { from: 'Running', event: 'finish', to: 'Done' },
        ],
        doc: 'Array of { from, event, to }.',
      },
    ],
    color: '#eab308',
    validate(node, _project, diag) {
      const states = new Set((node.props.states as unknown[] ?? []).map((s) => String(s)));
      const trans = (node.props.transitions as { from: string; to: string }[]) ?? [];
      for (const t of trans) {
        for (const s of [t.from, t.to]) {
          if (!states.has(s)) {
            diag.error('graph', 'state/unknown-state', `Transition references unknown state "${s}".`, {
              origin: { nodeId: node.id },
              hint: `Known states: ${[...states].join(', ')}`,
            });
          }
        }
      }
      const initial = String(node.props.initial ?? '');
      if (initial && !states.has(initial)) {
        diag.error('graph', 'state/unknown-initial', `Initial state "${initial}" is not in the state list.`, {
          origin: { nodeId: node.id },
        });
      }
      // Unreachable states are a warning, not an error: a machine may be driven
      // externally before the transition table is complete.
      const reachable = new Set([initial]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of trans) {
          if (reachable.has(t.from) && !reachable.has(t.to)) {
            reachable.add(t.to);
            grew = true;
          }
        }
      }
      for (const s of states) {
        if (!reachable.has(s)) {
          diag.warn('graph', 'state/unreachable', `State "${s}" cannot be reached from "${initial}".`, {
            origin: { nodeId: node.id },
          });
        }
      }
    },
    lower(ctx) {
      const name = ctx.ident('name', 'Workflow');
      const states = (ctx.prop<unknown[]>('states', []) ?? []).map((s) => toIdentifier(String(s)));
      const initial = toIdentifier(ctx.prop('initial', states[0] ?? 'Initial'));
      const transitions = ctx.prop<{ from: string; event: string; to: string }[]>('transitions', []);
      const enumName = `${name}State`;
      const enumType = T.named(enumName);

      const stateEnum: IrEnum = {
        k: 'enum',
        name: enumName,
        variants: states.map((s) => ({ name: s })),
        visibility: 'public',
        doc: `States of the ${name} machine.`,
        origin: ctx.origin,
      };

      // handle(event) -> bool : dispatch on (state, event), returning whether
      // the event was accepted. Generated as nested switches so the shape is
      // obvious in every target language.
      const byState = new Map<string, { event: string; to: string }[]>();
      for (const t of transitions) {
        const from = toIdentifier(String(t.from));
        if (!byState.has(from)) byState.set(from, []);
        byState.get(from)!.push({ event: String(t.event), to: toIdentifier(String(t.to)) });
      }

      const cases = [...byState.entries()].map(([from, outs]) => ({
        match: [E.member(E.symbol(enumName, enumType), from, enumType)],
        body: [
          S.switch_(
            E.ref('event', T.string),
            outs.map((o) => ({
              match: [E.str(o.event)],
              body: [
                S.expr(E.method(E.self(T.named(name)), `exit_${from}`, [], T.void)),
                S.assign(
                  E.member(E.self(T.named(name)), 'state', enumType),
                  E.member(E.symbol(enumName, enumType), o.to, enumType),
                ),
                S.expr(E.method(E.self(T.named(name)), `enter_${o.to}`, [], T.void)),
                S.return_(E.bool(true)),
              ],
            })),
          ) as IrStmt,
        ],
      }));

      const handle: IrFunction = {
        k: 'function',
        name: 'handle',
        params: [{ name: 'event', type: T.string }],
        returns: T.bool,
        body: [
          S.switch_(E.member(E.self(T.named(name)), 'state', enumType), cases),
          S.return_(E.bool(false)),
        ],
        visibility: 'public',
        doc: 'Applies an event. Returns true when a transition fired.',
        origin: ctx.origin,
      };

      // Default no-op entry/exit hooks; `state/state` nodes override them by
      // contributing a method with the same name, which wins during assembly.
      const hooks: IrFunction[] = states.flatMap((s) => [
        hook(`enter_${s}`, `Runs when the machine enters ${s}.`),
        hook(`exit_${s}`, `Runs when the machine leaves ${s}.`),
      ]);

      const cls: IrClass = {
        k: 'class',
        name,
        shape: 'class',
        fields: [
          {
            k: 'field',
            name: 'state',
            type: enumType,
            init: E.member(E.symbol(enumName, enumType), initial, enumType),
            visibility: 'public',
            doc: 'Current state.',
          },
        ],
        methods: [handle, ...hooks],
        visibility: 'public',
        doc: `State machine with states: ${states.join(', ')}.`,
        origin: ctx.origin,
      };

      return { decls: [stateEnum, cls] };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'state/state',
    category: 'State Machine',
    title: 'State Behaviour',
    description: 'Entry and exit behaviour for one state of a state machine.',
    keywords: ['fsm', 'enter', 'exit', 'on state'],
    styles: ['state-machine', 'event-driven'],
    root: true,
    inputs: [],
    outputs: [execOut('enter', 'on enter'), execOut('exit', 'on exit')],
    props: [
      { name: 'machine', label: 'Machine', kind: 'identifier', default: 'Workflow' },
      { name: 'state', label: 'State', kind: 'identifier', default: 'Idle' },
    ],
    color: '#eab308',
    lower(ctx) {
      const machine = ctx.ident('machine', 'Workflow');
      const state = ctx.ident('state', 'Idle');
      const mk = (kind: 'enter' | 'exit', body: IrStmt[]): IrFunction => ({
        k: 'function',
        name: `${kind}_${state}`,
        params: [],
        returns: T.void,
        body,
        visibility: 'public',
        doc: `Runs when the machine ${kind === 'enter' ? 'enters' : 'leaves'} ${state}.`,
        origin: ctx.origin,
      });
      const members = [];
      const enter = ctx.execBranch('enter');
      const exit = ctx.execBranch('exit');
      if (enter.length) members.push({ className: machine, method: mk('enter', enter) });
      if (exit.length) members.push({ className: machine, method: mk('exit', exit) });
      return { members };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'state/send-event',
    category: 'State Machine',
    title: 'Send Event',
    description: 'Feeds an event into a state machine instance.',
    keywords: ['fsm', 'trigger', 'fire', 'dispatch'],
    styles: ['state-machine', 'event-driven'],
    inputs: [execIn(), port('machine', 'machine', 'Any'), port('event', 'event', 'string', { default: 'start' })],
    outputs: [execOut(), port('accepted', 'accepted', 'bool')],
    color: '#eab308',
    lower(ctx) {
      const tmp = ctx.temp('accepted');
      const call = at(E.method(ctx.input('machine'), 'handle', [ctx.input('event')], T.bool), ctx.origin);
      const ref = E.ref(tmp, T.bool);
      ctx.bindOutput('accepted', ref);
      const decl = at(S.let_(tmp, T.bool, call, false), ctx.origin);
      return { stmts: [decl, ...ctx.execBranch('out')], exprs: { accepted: ref } };
    },
  },
];

function hook(name: string, doc: string): IrFunction {
  return {
    k: 'function',
    name,
    params: [],
    returns: T.void,
    body: [S.note('no behaviour attached')],
    visibility: 'public',
    doc,
  };
}
