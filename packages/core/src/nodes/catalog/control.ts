/**
 * Entry points, control flow and error handling.
 *
 * These are the nodes that own an execution chain. Everything else either
 * hangs off one of them or is a pure expression pulled in by a data edge.
 */

import type { NodeDefinition } from '../definition.ts';
import { execIn, execOut, port, toIdentifier } from '../definition.ts';
import { E, S, at } from '../../ir/build.ts';
import type { IrFunction, IrParam, IrStmt } from '../../ir/ir.ts';
import { VISIBILITIES } from '../../ir/ir.ts';
import { projectSymbols } from '../../project/symbols.ts';
import { ANNOTATIONS_PROP, readAnnotations } from './custom.ts';
import { closestName } from '../../project/symbols.ts';
import { T, parseType } from '../../types/types.ts';

/** Function/method parameter list stored as a `ports` property. */
interface ParamDef {
  name: string;
  type: string;
  default?: string;
}

function readParams(props: Record<string, unknown>): ParamDef[] {
  const raw = props.params;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is ParamDef => !!p && typeof p === 'object' && typeof (p as ParamDef).name === 'string')
    .map((p) => ({ name: toIdentifier(p.name), type: p.type || 'Any', default: p.default }));
}

export const controlNodes: NodeDefinition[] = [
  // -------------------------------------------------------------------------
  {
    type: 'entry/main',
    category: 'Entry',
    title: 'Main',
    description:
      'Program entry point. The execution chain leaving this node becomes the module\'s main body.',
    keywords: ['start', 'entry', 'program', 'run'],
    root: true,
    inputs: [],
    outputs: [execOut('out', 'body'), port('args', 'args', 'List<string>')],
    props: [
      {
        name: 'guard',
        label: 'Guard entry',
        kind: 'boolean',
        default: true,
        doc: 'Wrap the body in the language\'s "only when run directly" guard where one exists (Python\'s __main__ check).',
      },
    ],
    caps: ['stdio'],
    color: '#4ade80',
    lower(ctx) {
      const args = E.builtin('args_get', [], T.list(T.string), ['env']);
      ctx.bindOutput('args', args);
      const body = ctx.execBranch('out');
      const fn: IrFunction = {
        k: 'function',
        name: 'main',
        params: [],
        returns: T.void,
        body: body.length ? body : [S.note('empty body')],
        isEntry: true,
        visibility: 'public',
        origin: ctx.origin,
        doc: ctx.prop('doc', ''),
      };
      return { decls: [fn], exprs: { args } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'entry/function',
    category: 'Entry',
    title: 'Function',
    description:
      'Declares a named function. Parameters appear as data outputs; the exec chain is the body.',
    keywords: ['def', 'fn', 'procedure', 'subroutine', 'method'],
    root: true,
    inputs: [],
    outputs: [execOut('out', 'body')],
    props: [
      { name: 'name', label: 'Name', kind: 'identifier', default: 'my_function' },
      { name: 'params', label: 'Parameters', kind: 'ports', default: [] },
      { name: 'returns', label: 'Returns', kind: 'type', default: 'Void' },
      { name: 'isAsync', label: 'Async', kind: 'boolean', default: false },
      {
        name: 'visibility',
        label: 'Visibility',
        kind: 'select',
        default: 'public',
        options: [
          { value: 'public', label: 'Public' },
          { value: 'private', label: 'Private' },
          { value: 'internal', label: 'Internal' },
        ],
      },
      ANNOTATIONS_PROP,
      { name: 'doc', label: 'Documentation', kind: 'text', default: '' },
    ],
    ports(props) {
      const params = readParams(props);
      return {
        inputs: [],
        outputs: [
          execOut('out', 'body'),
          ...params.map((p) => port(`p:${p.name}`, p.name, p.type, { bound: true })),
        ],
      };
    },
    color: '#60a5fa',
    lower(ctx) {
      const name = ctx.ident('name', 'my_function');
      const params = readParams(ctx.node.props);
      const returns = ctx.propType('returns', T.void);
      const exprs: Record<string, ReturnType<typeof E.ref>> = {};
      for (const p of params) {
        const ref = E.ref(p.name, parseType(p.type));
        exprs[`p:${p.name}`] = ref;
        ctx.bindOutput(`p:${p.name}`, ref);
      }
      const body = ctx.execBranch('out');
      const irParams: IrParam[] = params.map((p) => ({
        name: p.name,
        type: parseType(p.type),
        default: p.default ? E.raw(ctx.language, p.default, parseType(p.type)) : undefined,
      }));
      const fn: IrFunction = {
        k: 'function',
        name,
        params: irParams,
        returns,
        body,
        isAsync: ctx.prop('isAsync', false),
        visibility: ctx.oneOf('visibility', VISIBILITIES, 'public'),
        annotations: readAnnotations(ctx.node.props),
        doc: ctx.prop('doc', ''),
        origin: ctx.origin,
      };
      return { decls: [fn], exprs };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'control/call',
    category: 'Control',
    title: 'Call Function',
    description:
      'Calls a function declared in this project. Arguments and the return value follow the target signature.',
    keywords: ['invoke', 'apply', 'run'],
    inputs: [execIn(), port('args', 'arg', 'Any', { variadic: true })],
    outputs: [execOut(), port('result', 'result', 'Any')],
    props: [
      { name: 'target', label: 'Function', kind: 'symbol', default: '' },
      { name: 'returns', label: 'Return type', kind: 'type', default: 'Any' },
      { name: 'await', label: 'Await result', kind: 'boolean', default: false },
    ],
    /**
     * A target that does not exist anywhere in the project produces generated
     * code that fails at the compiler, pointing at a line the user did not
     * write. Catching it here points at the node instead.
     */
    validate(node, project, diag) {
      const target = String(node.props.target ?? '').trim();
      if (!target) return;

      const candidates = projectSymbols(project).filter(
        (s) => s.name === target && (s.kind === 'function' || s.kind === 'method'),
      );
      if (!candidates.length) {
        const near = closestName(target, projectSymbols(project).map((s) => s.name));
        diag.error('graph', 'call/unknown-target', `No function named "${target}" in this project.`, {
          origin: { nodeId: node.id },
          hint: near ? `Did you mean "${near}"?` : 'Pick one from the Function list, or draw it first.',
        });
        return;
      }
      if (candidates.length > 1) {
        diag.warn(
          'graph',
          'call/ambiguous-target',
          `"${target}" is declared in ${candidates.length} files: ${candidates.map((c) => c.filePath).join(', ')}.`,
          {
            origin: { nodeId: node.id },
            hint: 'Rename one of them, or the generated import may resolve to the wrong file.',
          },
        );
      }
    },
    lower(ctx) {
      const target = ctx.prop('target', '');
      if (!target) {
        ctx.error('call/no-target', 'Call Function has no target selected.');
        return { stmts: [] };
      }
      const args = ctx.variadic('args');
      const returns = ctx.propType('returns', T.any);
      // `symbol` refs are resolved to a concrete import by the file-graph pass.
      let call = E.call(E.symbol(target, T.fn(args.map((a) => a.type), returns)), args, returns);
      if (ctx.prop('await', false)) call = E.await_(call, returns);
      at(call, ctx.origin);

      if (returns.kind === 'void') {
        return { stmts: [at(S.expr(call), ctx.origin), ...ctx.execBranch('out')] };
      }
      const tmp = ctx.temp(target.split(/[.\/]/).pop() ?? 'result');
      const ref = E.ref(tmp, returns);
      ctx.bindOutput('result', ref);
      const decl = at(S.let_(tmp, returns, call, false), ctx.origin);
      return { stmts: [decl, ...ctx.execBranch('out')], exprs: { result: ref } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'control/if',
    category: 'Control',
    title: 'If',
    description: 'Branches execution on a boolean condition.',
    keywords: ['branch', 'condition', 'else', 'when'],
    inputs: [execIn(), port('cond', 'condition', 'bool', { default: true })],
    outputs: [execOut('then', 'then'), execOut('else', 'else'), execOut('out', 'after')],
    color: '#f59e0b',
    lower(ctx) {
      const cond = ctx.input('cond');
      const then = ctx.execBranch('then');
      const els = ctx.execBranch('else');
      const stmt = at(S.if_(cond, then.length ? then : [S.note('empty branch')], els.length ? els : undefined), ctx.origin);
      return { stmts: [stmt, ...ctx.execBranch('out')] };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'control/switch',
    category: 'Control',
    title: 'Switch',
    description: 'Dispatches on a value against a list of cases.',
    keywords: ['match', 'case', 'select'],
    inputs: [execIn(), port('subject', 'subject', 'Any')],
    outputs: [execOut('default', 'default'), execOut('out', 'after')],
    props: [
      {
        name: 'cases',
        label: 'Cases',
        kind: 'json',
        default: ['a', 'b'],
        doc: 'Array of literal values. Each produces an exec output named case:<value>.',
      },
      { name: 'caseType', label: 'Case type', kind: 'type', default: 'string' },
    ],
    ports(props) {
      const cases = Array.isArray(props.cases) ? props.cases : [];
      return {
        inputs: [execIn(), port('subject', 'subject', String(props.caseType ?? 'string'))],
        outputs: [
          ...cases.map((c, i) => execOut(`case:${i}`, String(c))),
          execOut('default', 'default'),
          execOut('out', 'after'),
        ],
      };
    },
    color: '#f59e0b',
    lower(ctx) {
      const subject = ctx.input('subject');
      const caseType = ctx.propType('caseType', T.string);
      const values = ctx.prop<unknown[]>('cases', []);
      const cases = values.map((v, i) => ({
        match: [literalOf(v, caseType)],
        body: ctx.execBranch(`case:${i}`),
      }));
      const def = ctx.execBranch('default');
      return {
        stmts: [
          at(S.switch_(subject, cases, def.length ? def : undefined), ctx.origin),
          ...ctx.execBranch('out'),
        ],
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'control/while',
    category: 'Control',
    title: 'While',
    description: 'Repeats the body while a condition holds.',
    keywords: ['loop', 'repeat', 'until'],
    inputs: [execIn(), port('cond', 'condition', 'bool', { default: true })],
    outputs: [execOut('body', 'body'), execOut('out', 'after')],
    color: '#a78bfa',
    lower(ctx) {
      return {
        stmts: [
          at(S.while_(ctx.input('cond'), ctx.execBranch('body')), ctx.origin),
          ...ctx.execBranch('out'),
        ],
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'control/for-range',
    category: 'Control',
    title: 'For Range',
    description: 'Counts from a start value up to an end value.',
    keywords: ['loop', 'count', 'iterate', 'index'],
    inputs: [
      execIn(),
      port('start', 'start', 'i64', { default: 0 }),
      port('end', 'end', 'i64', { default: 10 }),
      port('step', 'step', 'i64', { default: 1, advanced: true }),
    ],
    outputs: [execOut('body', 'body'), port('index', 'index', 'i64', { bound: true }), execOut('out', 'after')],
    props: [
      { name: 'varName', label: 'Variable', kind: 'identifier', default: 'i' },
      { name: 'inclusive', label: 'Include end', kind: 'boolean', default: false },
    ],
    color: '#a78bfa',
    lower(ctx) {
      const v = ctx.ident('varName', 'i');
      ctx.bindOutput('index', E.ref(v, T.i64));
      const body = ctx.execBranch('body');
      return {
        stmts: [
          at(
            S.forRange(v, ctx.input('start'), ctx.input('end'), body, ctx.inputOpt('step'), ctx.prop('inclusive', false)),
            ctx.origin,
          ),
          ...ctx.execBranch('out'),
        ],
        exprs: { index: E.ref(v, T.i64) },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'control/for-each',
    category: 'Control',
    title: 'For Each',
    description: 'Iterates the elements of a list.',
    keywords: ['loop', 'iterate', 'foreach', 'list'],
    inputs: [execIn(), port('items', 'items', 'List<T>')],
    outputs: [
      execOut('body', 'body'),
      port('item', 'item', 'T', { bound: true }),
      port('index', 'index', 'i64', { bound: true }),
      execOut('out', 'after'),
    ],
    props: [
      { name: 'varName', label: 'Item variable', kind: 'identifier', default: 'item' },
      { name: 'withIndex', label: 'Expose index', kind: 'boolean', default: false },
    ],
    color: '#a78bfa',
    lower(ctx) {
      const v = ctx.ident('varName', 'item');
      const items = ctx.input('items');
      const itemType = items.type.kind === 'list' ? items.type.item : T.any;
      const idxName = ctx.prop('withIndex', false) ? `${v}_index` : undefined;
      ctx.bindOutput('item', E.ref(v, itemType));
      ctx.bindOutput('index', idxName ? E.ref(idxName, T.i64) : E.int(0));
      const body = ctx.execBranch('body');
      return {
        stmts: [
          at(S.forEach(v, itemType, items, body, idxName), ctx.origin),
          ...ctx.execBranch('out'),
        ],
        exprs: {
          item: E.ref(v, itemType),
          index: idxName ? E.ref(idxName, T.i64) : E.int(0),
        },
      };
    },
  },

  { ...simpleTerminator('control/break', 'Break', 'Exits the innermost loop.', () => S.break_()) },
  { ...simpleTerminator('control/continue', 'Continue', 'Skips to the next loop iteration.', () => S.continue_()) },

  // -------------------------------------------------------------------------
  {
    type: 'control/return',
    category: 'Control',
    title: 'Return',
    description: 'Returns from the enclosing function.',
    keywords: ['exit', 'result', 'yield'],
    inputs: [execIn(), port('value', 'value', 'Any')],
    outputs: [],
    color: '#ef4444',
    lower(ctx) {
      // `inputOpt` rather than a `connected` check: a port default is a real
      // way to supply a value, and the properties panel is where most people
      // set a constant. Testing only for a wire made `return 1` emit a bare
      // `return`, so the caller silently got null instead of a number.
      const value = ctx.inputOpt('value');
      return { stmts: [at(S.return_(value), ctx.origin)], terminates: true };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'control/sequence',
    category: 'Control',
    title: 'Sequence',
    description: 'Runs several execution chains one after another. Useful for keeping graphs tidy.',
    keywords: ['then', 'order', 'group'],
    inputs: [execIn()],
    outputs: [execOut('0', '1'), execOut('1', '2'), execOut('2', '3')],
    props: [{ name: 'count', label: 'Branches', kind: 'integer', default: 3, min: 1, max: 16 }],
    ports(props) {
      const n = Math.max(1, Math.min(16, Number(props.count ?? 3)));
      return {
        inputs: [execIn()],
        outputs: Array.from({ length: n }, (_, i) => execOut(String(i), String(i + 1))),
      };
    },
    lower(ctx) {
      const n = Math.max(1, Math.min(16, ctx.prop('count', 3)));
      const stmts: IrStmt[] = [];
      for (let i = 0; i < n; i++) stmts.push(...ctx.execBranch(String(i)));
      return { stmts };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'error/try',
    category: 'Error',
    title: 'Try / Catch',
    description: 'Runs a body, routing failures to a handler chain.',
    keywords: ['exception', 'error', 'catch', 'finally', 'handle'],
    inputs: [execIn()],
    outputs: [
      execOut('body', 'try'),
      execOut('catch', 'catch'),
      port('error', 'error', 'Error', { bound: true }),
      execOut('finally', 'finally'),
      execOut('out', 'after'),
    ],
    props: [
      { name: 'varName', label: 'Error variable', kind: 'identifier', default: 'err' },
      {
        name: 'errType',
        label: 'Error type',
        kind: 'type',
        default: 'Error',
        doc: 'Narrow the catch where the language supports typed handlers.',
      },
    ],
    color: '#ef4444',
    lower(ctx) {
      const v = ctx.ident('varName', 'err');
      ctx.bindOutput('error', E.ref(v, T.named('Error')));
      const body = ctx.execBranch('body');
      const catchBody = ctx.execBranch('catch');
      const fin = ctx.execBranch('finally');
      return {
        stmts: [
          at(
            S.try_(
              body,
              [{ errType: ctx.propType('errType', T.named('Error')), varName: v, body: catchBody }],
              fin.length ? fin : undefined,
            ),
            ctx.origin,
          ),
          ...ctx.execBranch('out'),
        ],
        exprs: { error: E.ref(v, T.named('Error')) },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'error/throw',
    category: 'Error',
    title: 'Throw',
    description: 'Raises an error and unwinds to the nearest handler.',
    keywords: ['raise', 'panic', 'fail', 'exception'],
    inputs: [execIn(), port('message', 'message', 'string', { default: 'error' })],
    outputs: [],
    color: '#ef4444',
    lower(ctx) {
      const msg = ctx.input('message');
      const err =
        msg.type.kind === 'named' && msg.type.name === 'Error'
          ? msg
          : E.builtin('error_new', [msg], T.named('Error'));
      return { stmts: [at(S.throw_(err), ctx.origin)], terminates: true };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'error/guard',
    category: 'Error',
    title: 'Guard',
    description:
      'Validates a condition and throws a descriptive error when it fails. The common shape of an input validator.',
    keywords: ['validate', 'assert', 'require', 'check', 'precondition'],
    inputs: [execIn(), port('cond', 'condition', 'bool', { default: true })],
    outputs: [execOut()],
    props: [{ name: 'message', label: 'Failure message', kind: 'string', default: 'validation failed' }],
    lower(ctx) {
      const msg = E.str(ctx.prop('message', 'validation failed'));
      const check = at(
        S.if_(E.un('!', ctx.input('cond')), [S.throw_(E.builtin('error_new', [msg], T.named('Error')))]),
        ctx.origin,
      );
      return { stmts: [check, ...ctx.execBranch('out')] };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'event/handler',
    category: 'Events',
    title: 'Event Handler',
    description:
      'Declares a handler for a named event. Event-driven graphs use these as their roots; the UI builder wires widget events here.',
    keywords: ['on', 'listen', 'callback', 'signal'],
    styles: ['event-driven', 'component', 'service'],
    root: true,
    inputs: [],
    outputs: [execOut('out', 'body'), port('payload', 'payload', 'Any', { bound: true })],
    props: [
      { name: 'event', label: 'Event name', kind: 'identifier', default: 'on_start' },
      { name: 'payloadType', label: 'Payload type', kind: 'type', default: 'Any' },
      { name: 'isAsync', label: 'Async', kind: 'boolean', default: false },
    ],
    color: '#f472b6',
    lower(ctx) {
      const name = ctx.ident('event', 'on_event');
      const payloadType = ctx.propType('payloadType', T.any);
      ctx.bindOutput('payload', E.ref('payload', payloadType));
      const fn: IrFunction = {
        k: 'function',
        name,
        params: payloadType.kind === 'void' ? [] : [{ name: 'payload', type: payloadType }],
        returns: T.void,
        body: ctx.execBranch('out'),
        isAsync: ctx.prop('isAsync', false),
        visibility: 'public',
        doc: `Event handler for "${ctx.prop('event', name)}".`,
        origin: ctx.origin,
      };
      return { decls: [fn], exprs: { payload: E.ref('payload', payloadType) } };
    },
  },
];

// ---------------------------------------------------------------------------

function simpleTerminator(
  type: string,
  title: string,
  description: string,
  make: () => IrStmt,
): NodeDefinition {
  return {
    type,
    category: 'Control',
    title,
    description,
    inputs: [execIn()],
    outputs: [],
    color: '#a78bfa',
    lower(ctx) {
      return { stmts: [at(make(), ctx.origin)], terminates: true };
    },
  };
}

function literalOf(v: unknown, type: ReturnType<typeof parseType>) {
  if (typeof v === 'boolean') return E.bool(v);
  if (typeof v === 'number') return Number.isInteger(v) ? E.int(v, type) : E.float(v);
  return E.str(String(v));
}
