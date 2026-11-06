/**
 * Object-oriented vocabulary: classes, fields, constructors, methods,
 * interfaces, enums and instance operations.
 *
 * A class is spread across several nodes rather than crammed into one, because
 * each method needs its own execution chain. `oop/class` declares the shell and
 * the fields; `oop/method` and `oop/constructor` contribute members to it by
 * name, and the module assembler stitches them together.
 */

import type { NodeDefinition } from '../definition.ts';
import { execIn, execOut, port, toIdentifier } from '../definition.ts';
import { ANNOTATIONS_PROP, readAnnotations } from './custom.ts';
import { E, S, at } from '../../ir/build.ts';
import type { IrClass, IrEnum, IrField, IrFunction, IrInterface, IrParam } from '../../ir/ir.ts';
import { VISIBILITIES } from '../../ir/ir.ts';
import { T, parseType } from '../../types/types.ts';

interface FieldDef {
  name: string;
  type: string;
  default?: string;
  visibility?: 'public' | 'private' | 'internal';
  static?: boolean;
  readonly?: boolean;
  doc?: string;
  annotations?: string[];
}

interface ParamDef {
  name: string;
  type: string;
  default?: string;
}

/** `{ name, payload: [{ name, type }] }` - a variant that carries data. */
interface VariantDef {
  name?: string;
  payload?: { name?: string; type?: string }[];
}

function readFields(props: Record<string, unknown>): FieldDef[] {
  const raw = props.fields;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is FieldDef => !!f && typeof f === 'object' && typeof (f as FieldDef).name === 'string')
    .map((f) => ({ ...f, name: toIdentifier(f.name), type: f.type || 'Any' }));
}

function readParams(props: Record<string, unknown>): ParamDef[] {
  const raw = props.params;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is ParamDef => !!p && typeof p === 'object' && typeof (p as ParamDef).name === 'string')
    .map((p) => ({ name: toIdentifier(p.name), type: p.type || 'Any', default: p.default }));
}

function toIrParams(params: ParamDef[], lang: string): IrParam[] {
  return params.map((p) => ({
    name: p.name,
    type: parseType(p.type),
    default: p.default ? E.raw(lang, p.default, parseType(p.type)) : undefined,
  }));
}

export const oopNodes: NodeDefinition[] = [
  // -------------------------------------------------------------------------
  {
    type: 'oop/class',
    category: 'Object',
    title: 'Class',
    description:
      'Declares a class or struct with its fields. Methods and constructors are separate nodes that name this class.',
    keywords: ['type', 'object', 'struct', 'record', 'model', 'entity'],
    styles: ['object-oriented', 'component', 'service', 'procedural'],
    root: true,
    inputs: [],
    outputs: [],
    props: [
      { name: 'name', label: 'Class name', kind: 'identifier', default: 'MyClass' },
      {
        name: 'shape',
        label: 'Shape',
        kind: 'select',
        default: 'class',
        options: [
          { value: 'class', label: 'Class (reference type)' },
          { value: 'struct', label: 'Struct (value type)' },
          { value: 'record', label: 'Record (data carrier)' },
        ],
      },
      { name: 'fields', label: 'Fields', kind: 'ports', default: [] },
      { name: 'extends', label: 'Extends', kind: 'string', default: '' },
      { name: 'implements', label: 'Implements', kind: 'string', default: '', doc: 'Comma-separated interface names.' },
      { name: 'generics', label: 'Type parameters', kind: 'string', default: '', doc: 'Comma-separated, e.g. T, U.' },
      { name: 'isAbstract', label: 'Abstract', kind: 'boolean', default: false },
      ANNOTATIONS_PROP,
      { name: 'doc', label: 'Documentation', kind: 'text', default: '' },
    ],
    color: '#f472b6',
    lower(ctx) {
      const name = ctx.ident('name', 'MyClass');
      const fields: IrField[] = readFields(ctx.node.props).map((f) => ({
        k: 'field',
        name: f.name,
        type: parseType(f.type),
        init: f.default ? E.raw(ctx.language, f.default, parseType(f.type)) : undefined,
        visibility: f.visibility ?? 'public',
        isStatic: f.static,
        readonly: f.readonly,
        doc: f.doc,
        annotations: readAnnotations(f as unknown as Record<string, unknown>),
      }));
      const impls = splitList(ctx.prop('implements', '')).map((s) => T.named(s));
      const ext = ctx.prop('extends', '').trim();
      const cls: IrClass = {
        k: 'class',
        name,
        shape: ctx.oneOf('shape', ['class', 'struct', 'record'] as const, 'class'),
        extends: ext ? T.named(ext) : undefined,
        implements: impls.length ? impls : undefined,
        generics: splitList(ctx.prop('generics', '')),
        fields,
        methods: [],
        visibility: 'public',
        isAbstract: ctx.prop('isAbstract', false),
        annotations: readAnnotations(ctx.node.props),
        doc: ctx.prop('doc', ''),
        origin: ctx.origin,
      };
      return { decls: [cls] };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'oop/constructor',
    category: 'Object',
    title: 'Constructor',
    description: 'Initialiser for a class declared elsewhere in this graph.',
    keywords: ['init', 'ctor', 'new', 'create'],
    styles: ['object-oriented', 'component', 'service'],
    root: true,
    inputs: [],
    outputs: [execOut('out', 'body'), port('self', 'self', 'Any')],
    props: [
      { name: 'className', label: 'Class', kind: 'identifier', default: 'MyClass' },
      { name: 'params', label: 'Parameters', kind: 'ports', default: [] },
      {
        name: 'assignFields',
        label: 'Assign matching fields',
        kind: 'boolean',
        default: true,
        doc: 'Emit `self.x = x` for every parameter whose name matches a field.',
      },
    ],
    ports(props) {
      const params = readParams(props);
      const cls = String(props.className ?? 'MyClass');
      return {
        inputs: [],
        outputs: [
          execOut('out', 'body'),
          port('self', 'self', cls, { bound: true }),
          ...params.map((p) => port(`p:${p.name}`, p.name, p.type, { bound: true })),
        ],
      };
    },
    color: '#f472b6',
    lower(ctx) {
      const className = ctx.ident('className', 'MyClass');
      const params = readParams(ctx.node.props);
      const selfType = T.named(className);
      const exprs: Record<string, ReturnType<typeof E.ref>> = { self: E.self(selfType) };
      ctx.bindOutput('self', exprs.self);
      for (const p of params) {
        const ref = E.ref(p.name, parseType(p.type));
        exprs[`p:${p.name}`] = ref;
        ctx.bindOutput(`p:${p.name}`, ref);
      }
      const pre = ctx.prop('assignFields', true)
        ? params.map((p) =>
            S.assign(
              E.member(E.self(selfType), p.name, parseType(p.type)),
              E.ref(p.name, parseType(p.type)),
            ),
          )
        : [];
      const ctor: IrFunction = {
        k: 'function',
        name: 'constructor',
        params: toIrParams(params, ctx.language),
        returns: T.void,
        body: [...pre, ...ctx.execBranch('out')],
        visibility: 'public',
        origin: ctx.origin,
      };
      return { members: [{ className, method: ctor, isCtor: true }], exprs };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'oop/method',
    category: 'Object',
    title: 'Method',
    description: 'A method on a class declared elsewhere in this graph.',
    keywords: ['function', 'member', 'behaviour', 'operation'],
    styles: ['object-oriented', 'component', 'service'],
    root: true,
    inputs: [],
    outputs: [execOut('out', 'body'), port('self', 'self', 'Any')],
    props: [
      { name: 'className', label: 'Class', kind: 'identifier', default: 'MyClass' },
      { name: 'name', label: 'Method name', kind: 'identifier', default: 'run' },
      { name: 'params', label: 'Parameters', kind: 'ports', default: [] },
      { name: 'returns', label: 'Returns', kind: 'type', default: 'Void' },
      { name: 'isStatic', label: 'Static', kind: 'boolean', default: false },
      { name: 'isAsync', label: 'Async', kind: 'boolean', default: false },
      {
        name: 'isOverride',
        label: 'Overrides',
        kind: 'boolean',
        default: false,
        doc: 'Set when the method replaces one inherited from a supertype.',
      },
      ANNOTATIONS_PROP,
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
      { name: 'doc', label: 'Documentation', kind: 'text', default: '' },
    ],
    ports(props) {
      const params = readParams(props);
      const cls = String(props.className ?? 'MyClass');
      const outs = [execOut('out', 'body')];
      if (!props.isStatic) outs.push(port('self', 'self', cls, { bound: true }));
      return {
        inputs: [],
        outputs: [...outs, ...params.map((p) => port(`p:${p.name}`, p.name, p.type, { bound: true }))],
      };
    },
    color: '#f472b6',
    lower(ctx) {
      const className = ctx.ident('className', 'MyClass');
      const params = readParams(ctx.node.props);
      const selfType = T.named(className);
      const exprs: Record<string, ReturnType<typeof E.ref>> = {};
      if (!ctx.prop('isStatic', false)) {
        exprs.self = E.self(selfType);
        ctx.bindOutput('self', exprs.self);
      }
      for (const p of params) {
        const ref = E.ref(p.name, parseType(p.type));
        exprs[`p:${p.name}`] = ref;
        ctx.bindOutput(`p:${p.name}`, ref);
      }
      const method: IrFunction = {
        k: 'function',
        name: ctx.ident('name', 'run'),
        params: toIrParams(params, ctx.language),
        returns: ctx.propType('returns', T.void),
        body: ctx.execBranch('out'),
        isStatic: ctx.prop('isStatic', false),
        isAsync: ctx.prop('isAsync', false),
        isOverride: ctx.prop('isOverride', false),
        annotations: readAnnotations(ctx.node.props),
        visibility: ctx.oneOf('visibility', VISIBILITIES, 'public'),
        doc: ctx.prop('doc', ''),
        origin: ctx.origin,
      };
      return { members: [{ className, method }], exprs };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'oop/interface',
    category: 'Object',
    title: 'Interface',
    description: 'Declares an interface: a set of method signatures classes can implement.',
    keywords: ['protocol', 'trait', 'contract', 'abstract'],
    styles: ['object-oriented', 'component', 'service'],
    root: true,
    inputs: [],
    outputs: [],
    props: [
      { name: 'name', label: 'Interface name', kind: 'identifier', default: 'MyInterface' },
      {
        name: 'methods',
        label: 'Methods',
        kind: 'json',
        default: [{ name: 'run', params: [], returns: 'Void' }],
        doc: 'Array of { name, params: [{name,type}], returns, isAsync?, annotations?, doc? }.',
      },
      { name: 'extends', label: 'Extends', kind: 'string', default: '' },
      { name: 'generics', label: 'Type parameters', kind: 'string', default: '', doc: 'Comma-separated, e.g. T, U.' },
      ANNOTATIONS_PROP,
      { name: 'doc', label: 'Documentation', kind: 'text', default: '' },
    ],
    color: '#f472b6',
    lower(ctx) {
      const raw = ctx.prop<
        { name: string; params?: ParamDef[]; returns?: string; isAsync?: boolean; doc?: string }[]
      >('methods', []);
      const methods: IrFunction[] = (Array.isArray(raw) ? raw : []).map((m) => ({
        k: 'function',
        name: toIdentifier(m.name ?? 'method'),
        params: toIrParams((m.params ?? []).map((p) => ({ ...p, type: p.type || 'Any' })), ctx.language),
        returns: parseType(m.returns ?? 'Void'),
        body: [],
        isAsync: m.isAsync === true,
        annotations: readAnnotations(m as unknown as Record<string, unknown>),
        doc: typeof m.doc === 'string' ? m.doc : undefined,
        visibility: 'public',
      }));
      const iface: IrInterface = {
        k: 'interface',
        name: ctx.ident('name', 'MyInterface'),
        methods,
        extends: splitList(ctx.prop('extends', '')).map((s) => T.named(s)),
        generics: splitList(ctx.prop('generics', '')),
        visibility: 'public',
        annotations: readAnnotations(ctx.node.props),
        doc: ctx.prop('doc', ''),
        origin: ctx.origin,
      };
      return { decls: [iface] };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'oop/enum',
    category: 'Object',
    title: 'Enum',
    description: 'Declares a fixed set of named values.',
    keywords: ['constant', 'variant', 'choice', 'union'],
    root: true,
    inputs: [],
    outputs: [],
    props: [
      { name: 'name', label: 'Enum name', kind: 'identifier', default: 'Status' },
      {
        name: 'variants',
        label: 'Variants',
        kind: 'json',
        default: ['Pending', 'Active', 'Done'],
        doc: 'Names, or { name, payload: [{ name, type }] } for a variant that carries data. Data-carrying variants need a language with sealed types.',
      },
      ANNOTATIONS_PROP,
      { name: 'doc', label: 'Documentation', kind: 'text', default: '' },
    ],
    color: '#f472b6',
    lower(ctx) {
      const variants = ctx.prop<unknown[]>('variants', []);
      const en: IrEnum = {
        k: 'enum',
        name: ctx.ident('name', 'Status'),
        variants: (Array.isArray(variants) ? variants : []).map((v, i) => {
          if (typeof v === 'string') return { name: toIdentifier(v, `V${i}`) };
          const def = (v ?? {}) as VariantDef;
          const payload = (Array.isArray(def.payload) ? def.payload : [])
            .filter((p) => typeof p?.name === 'string')
            .map((p) => ({ name: toIdentifier(p.name!), type: parseType(p.type || 'Any') }));
          return {
            name: toIdentifier(String(def.name ?? `V${i}`)),
            ...(payload.length ? { payload } : {}),
          };
        }),
        visibility: 'public',
        annotations: readAnnotations(ctx.node.props),
        doc: ctx.prop('doc', ''),
        origin: ctx.origin,
      };
      return { decls: [en] };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'oop/new',
    category: 'Object',
    title: 'New Instance',
    description: 'Constructs an instance of a class.',
    keywords: ['create', 'instantiate', 'construct', 'object'],
    inputs: [execIn(), port('a', 'arg', 'Any', { variadic: true })],
    outputs: [execOut(), port('instance', 'instance', 'Any')],
    props: [{ name: 'className', label: 'Class', kind: 'identifier', default: 'MyClass' }],
    ports(props) {
      const cls = String(props.className ?? 'MyClass');
      return {
        inputs: [execIn(), port('a', 'arg', 'Any', { variadic: true })],
        outputs: [execOut(), port('instance', 'instance', cls)],
      };
    },
    color: '#f472b6',
    lower(ctx) {
      const className = ctx.ident('className', 'MyClass');
      const type = T.named(className);
      const tmp = ctx.temp(className.charAt(0).toLowerCase() + className.slice(1));
      const expr = at(E.new_(className, ctx.variadic('a'), type), ctx.origin);
      const ref = E.ref(tmp, type);
      ctx.bindOutput('instance', ref);
      const decl = at(S.let_(tmp, type, expr, false), ctx.origin);
      return { stmts: [decl, ...ctx.execBranch('out')], exprs: { instance: ref } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'oop/call-method',
    category: 'Object',
    title: 'Call Method',
    description: 'Invokes a method on an object.',
    keywords: ['invoke', 'send', 'message', 'member'],
    inputs: [execIn(), port('target', 'target', 'Any'), port('a', 'arg', 'Any', { variadic: true })],
    outputs: [execOut(), port('result', 'result', 'Any')],
    props: [
      { name: 'method', label: 'Method name', kind: 'identifier', default: 'run' },
      { name: 'returns', label: 'Return type', kind: 'type', default: 'Void' },
      { name: 'await', label: 'Await result', kind: 'boolean', default: false },
    ],
    ports(props) {
      return {
        inputs: [execIn(), port('target', 'target', 'Any'), port('a', 'arg', 'Any', { variadic: true })],
        outputs: [execOut(), port('result', 'result', String(props.returns ?? 'Void'))],
      };
    },
    color: '#f472b6',
    lower(ctx) {
      const returns = ctx.propType('returns', T.void);
      let call = at(
        E.method(ctx.input('target'), ctx.ident('method', 'run'), ctx.variadic('a'), returns),
        ctx.origin,
      );
      if (ctx.prop('await', false)) call = E.await_(call, returns);
      if (returns.kind === 'void') {
        return { stmts: [at(S.expr(call), ctx.origin), ...ctx.execBranch('out')] };
      }
      const tmp = ctx.temp(ctx.ident('method', 'result'));
      const ref = E.ref(tmp, returns);
      ctx.bindOutput('result', ref);
      const decl = at(S.let_(tmp, returns, call, false), ctx.origin);
      return { stmts: [decl, ...ctx.execBranch('out')], exprs: { result: ref } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'oop/get-field',
    category: 'Object',
    title: 'Get Field',
    description: 'Reads a field or property of an object.',
    keywords: ['property', 'member', 'attribute', 'read'],
    pure: true,
    inputs: [port('target', 'target', 'Any')],
    outputs: [port('value', 'value', 'Any')],
    props: [
      { name: 'field', label: 'Field name', kind: 'identifier', default: 'value' },
      { name: 'type', label: 'Field type', kind: 'type', default: 'Any' },
    ],
    ports(props) {
      return {
        inputs: [port('target', 'target', 'Any')],
        outputs: [port('value', 'value', String(props.type ?? 'Any'))],
      };
    },
    color: '#f472b6',
    lower(ctx) {
      return {
        exprs: {
          value: at(
            E.member(ctx.input('target'), ctx.ident('field', 'value'), ctx.propType('type', T.any)),
            ctx.origin,
          ),
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'oop/set-field',
    category: 'Object',
    title: 'Set Field',
    description: 'Writes a field or property of an object.',
    keywords: ['property', 'member', 'attribute', 'write', 'assign'],
    inputs: [execIn(), port('target', 'target', 'Any'), port('value', 'value', 'Any')],
    outputs: [execOut()],
    props: [{ name: 'field', label: 'Field name', kind: 'identifier', default: 'value' }],
    color: '#f472b6',
    lower(ctx) {
      const value = ctx.input('value');
      return {
        stmts: [
          at(
            S.assign(E.member(ctx.input('target'), ctx.ident('field', 'value'), value.type), value),
            ctx.origin,
          ),
          ...ctx.execBranch('out'),
        ],
      };
    },
  },
];

function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}
