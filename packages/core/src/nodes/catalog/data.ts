/**
 * Literals, variables, operators, conversion and string handling.
 */

import type { NodeDefinition } from '../definition.ts';
import { execIn, execOut, port } from '../definition.ts';
import { builtinNode, variadicBuiltinNode } from './factory.ts';
import { E, S, at } from '../../ir/build.ts';
import type { BinaryOp } from '../../ir/ir.ts';

/** Operators offered by the Arithmetic and Compare nodes, in palette order. */
const ARITHMETIC_OPS = ['+', '-', '*', '/', '%', '**'] as const satisfies readonly BinaryOp[];
const COMPARISON_OPS = ['==', '!=', '<', '<=', '>', '>='] as const satisfies readonly BinaryOp[];
/** Includes the unary `!`, which the Logic node handles separately. */
const LOGICAL_OPS = ['&&', '||', '!'] as const;
import { T, parseType, typeToString } from '../../types/types.ts';

export const dataNodes: NodeDefinition[] = [
  // -------------------------------------------------------------------------
  {
    type: 'data/literal',
    category: 'Data',
    title: 'Literal',
    description: 'A constant value of any primitive type.',
    keywords: ['constant', 'value', 'number', 'string', 'true', 'false'],
    pure: true,
    inputs: [],
    outputs: [port('value', 'value', 'Any')],
    props: [
      {
        name: 'type',
        label: 'Type',
        kind: 'select',
        default: 'string',
        options: [
          { value: 'string', label: 'string' },
          { value: 'i64', label: 'integer' },
          { value: 'f64', label: 'float' },
          { value: 'bool', label: 'boolean' },
        ],
      },
      { name: 'value', label: 'Value', kind: 'string', default: '' },
    ],
    ports(props) {
      return { inputs: [], outputs: [port('value', 'value', String(props.type ?? 'string'))] };
    },
    color: '#94a3b8',
    lower(ctx) {
      const kind = ctx.prop('type', 'string');
      const raw = ctx.prop<unknown>('value', '');
      let expr;
      switch (kind) {
        case 'i64':
          expr = E.int(Math.trunc(Number(raw) || 0));
          break;
        case 'f64':
          expr = E.float(Number(raw) || 0);
          break;
        case 'bool':
          expr = E.bool(raw === true || raw === 'true');
          break;
        default:
          expr = E.str(String(raw ?? ''));
      }
      return { exprs: { value: at(expr, ctx.origin) } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'data/variable-get',
    category: 'Data',
    title: 'Get Variable',
    description: 'Reads a graph variable.',
    keywords: ['read', 'load', 'var'],
    pure: true,
    inputs: [],
    outputs: [port('value', 'value', 'Any')],
    props: [{ name: 'name', label: 'Variable', kind: 'variable', default: '' }],
    color: '#38bdf8',
    lower(ctx) {
      const name = ctx.prop('name', '');
      const v = ctx.variable(name);
      if (!v) {
        ctx.error('variable/unknown', `No variable named "${name}" in this graph.`,
          'Declare it in the Variables panel, or pick an existing one.');
        return { exprs: { value: E.null(T.any) } };
      }
      return { exprs: { value: at(E.ref(v.name, v.type), ctx.origin) } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'data/variable-set',
    category: 'Data',
    title: 'Set Variable',
    description: 'Writes a graph variable.',
    keywords: ['write', 'store', 'assign', 'var'],
    inputs: [execIn(), port('value', 'value', 'Any')],
    outputs: [execOut(), port('out_value', 'value', 'Any')],
    props: [{ name: 'name', label: 'Variable', kind: 'variable', default: '' }],
    color: '#38bdf8',
    lower(ctx) {
      const name = ctx.prop('name', '');
      const v = ctx.variable(name);
      if (!v) {
        ctx.error('variable/unknown', `No variable named "${name}" in this graph.`);
        return { stmts: ctx.execBranch('out') };
      }
      const value = ctx.input('value');
      const ref = E.ref(v.name, v.type);
      ctx.bindOutput('out_value', ref);
      const assign = at(S.assign(ref, value), ctx.origin);
      return { stmts: [assign, ...ctx.execBranch('out')], exprs: { out_value: ref } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'data/local',
    category: 'Data',
    title: 'Declare Local',
    description: 'Introduces a local binding inside the current function body.',
    keywords: ['let', 'const', 'define', 'temp'],
    inputs: [execIn(), port('value', 'value', 'Any')],
    outputs: [execOut(), port('ref', 'ref', 'Any')],
    props: [
      { name: 'name', label: 'Name', kind: 'identifier', default: 'value' },
      { name: 'type', label: 'Type', kind: 'type', default: 'Any' },
      { name: 'constant', label: 'Constant', kind: 'boolean', default: false },
    ],
    color: '#38bdf8',
    lower(ctx) {
      const name = ctx.ident('name', 'value');
      const value = ctx.input('value');
      const declared = ctx.prop('type', 'Any');
      const type = declared === 'Any' ? value.type : parseType(declared);
      const ref = E.ref(name, type);
      ctx.bindOutput('ref', ref);
      const decl = at(S.let_(name, type, value, !ctx.prop('constant', false)), ctx.origin);
      return { stmts: [decl, ...ctx.execBranch('out')], exprs: { ref } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'op/arithmetic',
    category: 'Operators',
    title: 'Arithmetic',
    description: 'Applies a binary arithmetic operator.',
    keywords: ['add', 'subtract', 'multiply', 'divide', 'modulo', 'plus', 'minus', 'math'],
    pure: true,
    // `N` is a type variable: integer inputs give an integer result, and a mix
    // of widths resolves to the wider one. Division is the exception and always
    // produces a double, which the IR builder handles.
    inputs: [port('a', 'a', 'N', { default: 0 }), port('b', 'b', 'N', { default: 0 })],
    outputs: [port('result', 'result', 'N')],
    props: [
      {
        name: 'op',
        label: 'Operator',
        kind: 'select',
        default: '+',
        options: [
          { value: '+', label: '+ add' },
          { value: '-', label: '- subtract' },
          { value: '*', label: '* multiply' },
          { value: '/', label: '/ divide' },
          { value: '%', label: '% remainder' },
          { value: '**', label: '** power' },
        ],
      },
    ],
    color: '#22d3ee',
    lower(ctx) {
      const op = ctx.oneOf('op', ARITHMETIC_OPS, '+');
      const type = op === '/' ? T.f64 : ctx.portType('result');
      return { exprs: { result: at(E.bin(op, ctx.input('a'), ctx.input('b'), type), ctx.origin) } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'op/compare',
    category: 'Operators',
    title: 'Compare',
    description: 'Compares two values and produces a boolean.',
    keywords: ['equal', 'greater', 'less', 'not equal', 'compare', 'condition'],
    pure: true,
    inputs: [port('a', 'a', 'Any'), port('b', 'b', 'Any')],
    outputs: [port('result', 'result', 'bool')],
    props: [
      {
        name: 'op',
        label: 'Operator',
        kind: 'select',
        default: '==',
        options: [
          { value: '==', label: '== equal' },
          { value: '!=', label: '!= not equal' },
          { value: '<', label: '< less' },
          { value: '<=', label: '<= less or equal' },
          { value: '>', label: '> greater' },
          { value: '>=', label: '>= greater or equal' },
        ],
      },
    ],
    color: '#22d3ee',
    lower(ctx) {
      const op = ctx.oneOf('op', COMPARISON_OPS, '==');
      return { exprs: { result: at(E.bin(op, ctx.input('a'), ctx.input('b'), T.bool), ctx.origin) } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'op/logic',
    category: 'Operators',
    title: 'Logic',
    description: 'Boolean AND, OR or NOT.',
    keywords: ['and', 'or', 'not', 'boolean'],
    pure: true,
    inputs: [port('a', 'a', 'bool', { default: false }), port('b', 'b', 'bool', { default: false })],
    outputs: [port('result', 'result', 'bool')],
    props: [
      {
        name: 'op',
        label: 'Operator',
        kind: 'select',
        default: '&&',
        options: [
          { value: '&&', label: 'AND' },
          { value: '||', label: 'OR' },
          { value: '!', label: 'NOT (a only)' },
        ],
      },
    ],
    ports(props) {
      const unary = props.op === '!';
      return {
        inputs: unary
          ? [port('a', 'a', 'bool', { default: false })]
          : [port('a', 'a', 'bool', { default: false }), port('b', 'b', 'bool', { default: false })],
        outputs: [port('result', 'result', 'bool')],
      };
    },
    color: '#22d3ee',
    lower(ctx) {
      const op = ctx.oneOf('op', LOGICAL_OPS, '&&');
      if (op === '!') return { exprs: { result: at(E.un('!', ctx.input('a')), ctx.origin) } };
      return {
        exprs: { result: at(E.bin(op, ctx.input('a'), ctx.input('b'), T.bool), ctx.origin) },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'op/select',
    category: 'Operators',
    title: 'Select',
    description: 'Chooses between two values based on a condition, without branching execution.',
    keywords: ['ternary', 'choose', 'if else', 'conditional'],
    pure: true,
    inputs: [
      port('cond', 'condition', 'bool', { default: true }),
      port('then', 'if true', 'T'),
      port('else', 'if false', 'T'),
    ],
    outputs: [port('result', 'result', 'T')],
    color: '#22d3ee',
    lower(ctx) {
      return {
        exprs: {
          result: at(
            E.ternary(ctx.input('cond'), ctx.input('then'), ctx.input('else'), ctx.portType('result')),
            ctx.origin,
          ),
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'op/cast',
    category: 'Operators',
    title: 'Cast',
    description: 'Converts a value to another type, emitting an explicit conversion in the target language.',
    keywords: ['convert', 'coerce', 'as', 'type'],
    pure: true,
    inputs: [port('value', 'value', 'Any')],
    outputs: [port('result', 'result', 'Any')],
    props: [{ name: 'to', label: 'Target type', kind: 'type', default: 'string' }],
    ports(props) {
      return {
        inputs: [port('value', 'value', 'Any')],
        outputs: [port('result', 'result', String(props.to ?? 'string'))],
      };
    },
    color: '#22d3ee',
    lower(ctx) {
      const to = ctx.propType('to', T.string);
      return { exprs: { result: at(E.cast(ctx.input('value'), to), ctx.origin) } };
    },
  },

  // -- optional values -------------------------------------------------------
  // The consuming half of every operation that can come back empty: Parse
  // Integer, Map Get, Environment Variable, Find, Smallest, Largest, Pop.
  builtinNode({
    type: 'option/or-else',
    category: 'Optional',
    title: 'Value Or Default',
    op: 'option_or',
    args: ['optional', 'fallback'],
    result: 'value',
    keywords: ['option', 'default', 'fallback', 'coalesce', 'null', 'none', 'empty', 'else'],
    color: '#22d3ee',
  }),
  builtinNode({
    type: 'option/has-value',
    category: 'Optional',
    title: 'Has Value',
    op: 'option_is_some',
    args: ['optional'],
    result: 'present',
    keywords: ['option', 'some', 'present', 'exists', 'null', 'none', 'empty', 'check'],
    color: '#22d3ee',
  }),
  builtinNode({
    type: 'option/require',
    category: 'Optional',
    title: 'Require Value',
    op: 'option_unwrap',
    args: ['optional', { name: 'message', default: 'value is required' }],
    result: 'value',
    keywords: ['option', 'unwrap', 'expect', 'assert', 'must', 'require'],
    color: '#22d3ee',
  }),

  // -------------------------------------------------------------------------
  {
    type: 'data/comment',
    category: 'Data',
    title: 'Note',
    description: 'Emits a comment into the generated source. Documents intent without affecting behaviour.',
    keywords: ['comment', 'doc', 'annotate', 'remark'],
    inputs: [execIn()],
    outputs: [execOut()],
    props: [{ name: 'text', label: 'Text', kind: 'text', default: '' }],
    color: '#64748b',
    lower(ctx) {
      return { stmts: [S.note(ctx.prop('text', '')), ...ctx.execBranch('out')] };
    },
  },

  // -- conversion ------------------------------------------------------------
  builtinNode({ type: 'convert/to-string', category: 'Convert', title: 'To String', op: 'to_string', args: ['value'], result: 'text' }),
  builtinNode({ type: 'convert/to-int', category: 'Convert', title: 'To Integer', op: 'to_int', args: ['value'], result: 'number' }),
  builtinNode({ type: 'convert/to-float', category: 'Convert', title: 'To Float', op: 'to_float', args: ['value'], result: 'number' }),
  builtinNode({ type: 'convert/parse-int', category: 'Convert', title: 'Parse Integer', op: 'parse_int', args: ['text'], result: 'number' }),
  builtinNode({ type: 'convert/parse-float', category: 'Convert', title: 'Parse Float', op: 'parse_float', args: ['text'], result: 'number' }),

  // -- string ----------------------------------------------------------------
  variadicBuiltinNode({
    type: 'string/format',
    category: 'String',
    title: 'Format',
    op: 'format',
    argName: 'arg',
    leading: [{ name: 'template', default: '{}', type: T.string }],
    result: 'text',
    keywords: ['interpolate', 'template', 'concat', 'message', 'sprintf'],
    color: '#fbbf24',
  }),
  builtinNode({ type: 'string/concat', category: 'String', title: 'Concat', op: 'str_concat', args: ['a', 'b'], result: 'text', color: '#fbbf24' }),
  builtinNode({ type: 'string/upper', category: 'String', title: 'Upper Case', op: 'str_upper', args: ['text'], result: 'text', color: '#fbbf24' }),
  builtinNode({ type: 'string/lower', category: 'String', title: 'Lower Case', op: 'str_lower', args: ['text'], result: 'text', color: '#fbbf24' }),
  builtinNode({ type: 'string/trim', category: 'String', title: 'Trim', op: 'str_trim', args: ['text'], result: 'text', color: '#fbbf24' }),
  builtinNode({ type: 'string/split', category: 'String', title: 'Split', op: 'str_split', args: ['text', { name: 'separator', default: ',' }], result: 'parts', color: '#fbbf24' }),
  builtinNode({ type: 'string/join', category: 'String', title: 'Join', op: 'str_join', args: ['parts', { name: 'separator', default: ', ' }], result: 'text', color: '#fbbf24' }),
  builtinNode({ type: 'string/replace', category: 'String', title: 'Replace', op: 'str_replace', args: ['text', 'find', 'replace'], result: 'text', color: '#fbbf24' }),
  builtinNode({ type: 'string/contains', category: 'String', title: 'Contains', op: 'str_contains', args: ['text', 'needle'], result: 'found', color: '#fbbf24' }),
  builtinNode({ type: 'string/starts-with', category: 'String', title: 'Starts With', op: 'str_starts_with', args: ['text', 'prefix'], result: 'found', color: '#fbbf24' }),
  builtinNode({ type: 'string/ends-with', category: 'String', title: 'Ends With', op: 'str_ends_with', args: ['text', 'suffix'], result: 'found', color: '#fbbf24' }),
  builtinNode({ type: 'string/index-of', category: 'String', title: 'Index Of', op: 'str_index_of', args: ['text', 'needle'], result: 'index', color: '#fbbf24' }),
  builtinNode({ type: 'string/substring', category: 'String', title: 'Substring', op: 'str_substring', args: ['text', { name: 'start', default: 0 }, { name: 'end', default: 0 }], result: 'text', color: '#fbbf24' }),
  builtinNode({ type: 'string/char-at', category: 'String', title: 'Char At', op: 'str_char_at', args: ['text', { name: 'index', default: 0 }], result: 'char', color: '#fbbf24' }),
  builtinNode({ type: 'string/repeat', category: 'String', title: 'Repeat', op: 'str_repeat', args: ['text', { name: 'times', default: 2 }], result: 'text', color: '#fbbf24' }),
  builtinNode({ type: 'string/pad-left', category: 'String', title: 'Pad Left', op: 'str_pad_left', args: ['text', { name: 'width', default: 8 }, { name: 'fill', default: ' ' }], result: 'text', color: '#fbbf24' }),
  builtinNode({ type: 'string/length', category: 'String', title: 'Length', op: 'len', args: ['text'], result: 'length', color: '#fbbf24' }),

  // -- math ------------------------------------------------------------------
  builtinNode({ type: 'math/abs', category: 'Math', title: 'Absolute', op: 'math_abs', args: ['x'] }),
  builtinNode({ type: 'math/floor', category: 'Math', title: 'Floor', op: 'math_floor', args: ['x'] }),
  builtinNode({ type: 'math/ceil', category: 'Math', title: 'Ceiling', op: 'math_ceil', args: ['x'] }),
  builtinNode({ type: 'math/round', category: 'Math', title: 'Round', op: 'math_round', args: ['x'] }),
  builtinNode({ type: 'math/sqrt', category: 'Math', title: 'Square Root', op: 'math_sqrt', args: ['x'] }),
  builtinNode({ type: 'math/pow', category: 'Math', title: 'Power', op: 'math_pow', args: ['base', 'exponent'] }),
  builtinNode({ type: 'math/min', category: 'Math', title: 'Minimum', op: 'math_min', args: ['a', 'b'] }),
  builtinNode({ type: 'math/max', category: 'Math', title: 'Maximum', op: 'math_max', args: ['a', 'b'] }),
  builtinNode({ type: 'math/log', category: 'Math', title: 'Natural Log', op: 'math_log', args: ['x'] }),
  builtinNode({ type: 'math/exp', category: 'Math', title: 'Exponential', op: 'math_exp', args: ['x'] }),
  builtinNode({ type: 'math/sin', category: 'Math', title: 'Sine', op: 'math_sin', args: ['radians'] }),
  builtinNode({ type: 'math/cos', category: 'Math', title: 'Cosine', op: 'math_cos', args: ['radians'] }),
  builtinNode({ type: 'math/tan', category: 'Math', title: 'Tangent', op: 'math_tan', args: ['radians'] }),
  builtinNode({ type: 'math/atan2', category: 'Math', title: 'Atan2', op: 'math_atan2', args: ['y', 'x'] }),
  builtinNode({ type: 'math/int-divide', category: 'Math', title: 'Integer Divide', op: 'math_idiv', args: ['a', 'b'] }),
  builtinNode({ type: 'math/pi', category: 'Math', title: 'Pi', op: 'math_pi', args: [] }),
  builtinNode({ type: 'math/random', category: 'Math', title: 'Random Float', op: 'random_float', args: [], result: 'value' }),
  builtinNode({ type: 'math/random-int', category: 'Math', title: 'Random Integer', op: 'random_int', args: [{ name: 'low', default: 0 }, { name: 'high', default: 100 }], result: 'value' }),
];

/** Human-readable summary of a node's signature, used in tooltips and docs. */
export function describePorts(def: NodeDefinition): string {
  const fmt = (ps: { name: string; type: unknown }[]) =>
    ps
      .map((p) => `${p.name || '·'}: ${typeof p.type === 'string' ? p.type : typeToString(p.type as never)}`)
      .join(', ');
  return `(${fmt(def.inputs)}) -> (${fmt(def.outputs)})`;
}
