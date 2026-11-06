/**
 * Nodes for calling into a library: a function, a class's constructor, or a
 * method on an instance.
 *
 * They are created from what `libraries/surface.ts` read out of the library, and
 * each one carries that callable's signature in its own properties - so the
 * project keeps generating the same code without the library installed and
 * without the cached listing.
 *
 * Ports are the required parameters plus the optional ones named under "Use
 * parameters"; pandas' `read_csv` alone has some fifty, and a node with all of
 * them would be unusable. An optional parameter that is listed but not wired is
 * simply not passed, so the library's own default applies.
 *
 * Arguments are passed the way the library's signature allows: positionally
 * where it must be or where it reads naturally (`read_csv("data.csv")`), by
 * keyword otherwise (`Hosts(client_id=..., client_secret=...)`). Names keep the
 * library's spelling exactly; nothing is re-cased.
 *
 * Python only, for now: keyword arguments and these signatures are Python's.
 */

import type { NodeDefinition, PortSpec } from '../definition.ts';
import { execIn, execOut, port } from '../definition.ts';
import { E, S, at } from '../../ir/build.ts';
import type { IrExpr, IrKwarg } from '../../ir/ir.ts';
import { T } from '../../types/types.ts';
import type { TypeRef } from '../../types/types.ts';
import type { LibraryCallable, LibraryParam } from '../../libraries/surface.ts';

const COLOR = '#a855f7';

/** Port id for a parameter; prefixed so a parameter called `in`, `out` or `self` cannot collide. */
export const argPort = (name: string): string => `arg_${name}`;

function callableOf(props: Record<string, unknown>): LibraryCallable | undefined {
  const value = props.callable as LibraryCallable | undefined;
  return value && typeof value === 'object' && typeof value.name === 'string' ? value : undefined;
}

/** Optional parameter names listed in "Use parameters". */
function usedOptional(props: Record<string, unknown>): Set<string> {
  return new Set(
    String(props.use ?? '')
      .split(/[\s,]+/)
      .map((s) => s.replace(/^\*+/, '').trim())
      .filter(Boolean),
  );
}

/**
 * A port type from a library's type text. Only unambiguous simple types are
 * mapped; anything else - unions, generics, the library's own classes - is
 * `Any`, so a loose annotation never blocks a wire Python itself would accept.
 */
export function portTypeFor(text: string | undefined): TypeRef {
  if (!text) return T.any;
  const cleaned = text
    .replace(/^Optional\[(.*)\]$/, '$1')
    .replace(/\s*\|\s*None\b|\bNone\s*\|\s*/g, '')
    .replace(/,\s*optional$/i, '')
    .replace(/\s*\(.*\)$/, '')
    .trim();
  if (/[|,\[]|\bor\b/.test(cleaned)) return T.any;
  switch (cleaned.toLowerCase()) {
    case 'str':
    case 'string':
      return T.string;
    case 'int':
    case 'integer':
      return T.i64;
    case 'float':
    case 'number':
      return T.f64;
    case 'bool':
    case 'boolean':
      return T.bool;
    default:
      return T.any;
  }
}

function paramPorts(callable: LibraryCallable | undefined, props: Record<string, unknown>): PortSpec[] {
  if (!callable) return [];
  if (!callable.params) return [port('args', 'args', 'Any', { variadic: true, doc: 'The signature could not be read; arguments are passed by position.' })];
  const use = usedOptional(props);
  const ports: PortSpec[] = [];
  for (const p of callable.params) {
    if (!p.required && !use.has(p.name)) continue;
    const doc = [p.type, p.default !== undefined ? `default ${p.default}` : '', p.doc].filter(Boolean).join(' - ') || undefined;
    if (p.kind === 'varargs') ports.push(port(argPort(p.name), `*${p.name}`, 'Any', { variadic: true, doc }));
    else ports.push(port(argPort(p.name), p.required ? p.name : `${p.name}?`, portTypeFor(p.type), { doc }));
  }
  return ports;
}

/**
 * The call's arguments from whatever is wired or set on the ports.
 *
 * Required positional parameters go by position until the first one without a
 * value; from there, everything that can go by name does. A positional-only
 * parameter after such a gap cannot be expressed, which is reported rather than
 * silently shifted into the wrong slot.
 */
function lowerArguments(
  ctx: Parameters<NodeDefinition['lower']>[0],
  callable: LibraryCallable,
): { args: IrExpr[]; kwargs: IrKwarg[] } {
  if (!callable.params) return { args: ctx.variadic('args'), kwargs: [] };
  const args: IrExpr[] = [];
  const kwargs: IrKwarg[] = [];
  let gap = false;
  for (const p of callable.params as LibraryParam[]) {
    if (p.kind === 'varargs') {
      const values = ctx.variadic(argPort(p.name));
      if (values.length && gap) {
        ctx.error('library/varargs-gap', `*${p.name} needs every parameter before it to have a value.`);
      }
      args.push(...values);
      continue;
    }
    const value = ctx.inputOpt(argPort(p.name));
    if (!value) {
      if (p.required) ctx.error('library/missing-argument', `${callable.name} needs "${p.name}".`, 'Wire a value into it, or set one on the port.');
      if (p.kind === 'positional' || p.kind === 'either') gap = true;
      continue;
    }
    if (p.kind === 'positional') {
      if (gap) ctx.error('library/positional-gap', `"${p.name}" can only be passed by position, so the parameters before it need values too.`);
      args.push(value);
    } else if (p.kind === 'either' && p.required && !gap) {
      args.push(value);
    } else {
      kwargs.push({ name: p.name, value });
    }
  }
  return { args, kwargs };
}

/** A local name for a result: readable, and never the name of the function it came from. */
function resultHint(name: string): string {
  return /^[A-Z]/.test(name) ? name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() : `${name}_result`;
}

/** Assigns the result unless the library says there is none. */
function emit(
  ctx: Parameters<NodeDefinition['lower']>[0],
  call: IrExpr,
  callable: LibraryCallable,
  output: string,
  hint: string,
): ReturnType<NodeDefinition['lower']> {
  const value = callable.async ? E.await_(call, T.any) : call;
  at(value, ctx.origin);
  if (callable.returns === 'None' && output === 'result') {
    return { stmts: [at(S.expr(value), ctx.origin), ...ctx.execBranch('out')] };
  }
  const tmp = ctx.temp(hint);
  const ref = E.ref(tmp, T.any);
  ctx.bindOutput(output, ref);
  return { stmts: [at(S.let_(tmp, T.any, value, false), ctx.origin), ...ctx.execBranch('out')], exprs: { [output]: ref } };
}

const commonProps = [
  { name: 'package', label: 'Package', kind: 'string' as const, default: '', doc: 'As recorded in the manifest (crowdstrike-falconpy).' },
  { name: 'version', label: 'Version', kind: 'string' as const, default: '*' },
  { name: 'module', label: 'Module', kind: 'string' as const, default: '', doc: 'What the code imports from (falconpy).' },
  {
    name: 'use',
    label: 'Use parameters',
    kind: 'string' as const,
    default: '',
    doc: 'Optional parameters to show as ports, separated by commas. Unlisted ones keep the library default.',
    placeholder: 'filter, limit',
  },
  { name: 'callable', label: 'Signature', kind: 'json' as const, default: null, doc: 'Read from the library when the node was added.' },
];

function checkSignature(ctx: Parameters<NodeDefinition['lower']>[0]): LibraryCallable | undefined {
  const callable = callableOf(ctx.node.props);
  const module = ctx.prop('module', '').trim();
  if (!callable || !module) {
    ctx.error('library/no-signature', 'This library node has no signature. Add it again from the Libraries panel.');
    return undefined;
  }
  const unknown = [...usedOptional(ctx.node.props)].filter((n) => !callable.params?.some((p) => p.name === n));
  if (unknown.length && callable.params) {
    const optional = callable.params.filter((p) => !p.required).map((p) => p.name);
    ctx.warn('library/unknown-parameter', `${callable.name} has no parameter ${unknown.map((n) => `"${n}"`).join(', ')}.`, optional.length ? `Optional parameters: ${optional.join(', ')}` : undefined);
  }
  return callable;
}

function registerImport(ctx: Parameters<NodeDefinition['lower']>[0], name: string): void {
  ctx.require({ source: 'package', target: ctx.prop('module', '').trim(), symbols: [{ name }] });
  const pkg = ctx.prop('package', '').trim();
  if (pkg) ctx.requirePackage(pkg, ctx.prop('version', '*'));
}

const exact = (name: string): IrExpr => ({ k: 'symbol', name, type: T.any, exact: true });

export const libraryNodes: NodeDefinition[] = [
  {
    type: 'library/function',
    category: 'Libraries',
    title: 'Library Function',
    description: 'Calls a function from a library, with its real parameters as ports. Add one from the Libraries panel.',
    keywords: ['library', 'package', 'call', 'function', 'import'],
    languages: ['python'],
    inputs: [execIn()],
    outputs: [execOut(), port('result', 'result', 'Any')],
    props: commonProps,
    ports(props) {
      return { inputs: [execIn(), ...paramPorts(callableOf(props), props)], outputs: [execOut(), port('result', 'result', 'Any')] };
    },
    color: COLOR,
    lower(ctx) {
      const callable = checkSignature(ctx);
      if (!callable) return { stmts: ctx.execBranch('out') };
      registerImport(ctx, callable.name);
      const { args, kwargs } = lowerArguments(ctx, callable);
      const call: IrExpr = { k: 'call', callee: exact(callable.name), args, kwargs, type: T.any };
      return emit(ctx, call, callable, 'result', resultHint(callable.name));
    },
  },
  {
    type: 'library/new',
    category: 'Libraries',
    title: 'Library Object',
    description: "Creates an instance of a library's class, with its constructor parameters as ports.",
    keywords: ['library', 'class', 'instance', 'new', 'construct', 'client'],
    languages: ['python'],
    inputs: [execIn()],
    outputs: [execOut(), port('instance', 'instance', 'Any')],
    props: [...commonProps, { name: 'className', label: 'Class', kind: 'string', default: '' }],
    ports(props) {
      return { inputs: [execIn(), ...paramPorts(callableOf(props), props)], outputs: [execOut(), port('instance', 'instance', 'Any')] };
    },
    color: COLOR,
    lower(ctx) {
      const callable = checkSignature(ctx);
      if (!callable) return { stmts: ctx.execBranch('out') };
      const className = ctx.prop('className', '').trim() || callable.name;
      registerImport(ctx, className);
      const { args, kwargs } = lowerArguments(ctx, callable);
      const call: IrExpr = { k: 'call', callee: exact(className), args, kwargs, type: T.any };
      return emit(ctx, call, { ...callable, returns: undefined, async: false }, 'instance', resultHint(className));
    },
  },
  {
    type: 'library/method',
    category: 'Libraries',
    title: 'Library Method',
    description: 'Calls a method on an object made by a library - wire the object into "object".',
    keywords: ['library', 'method', 'call', 'instance'],
    languages: ['python'],
    inputs: [execIn(), port('self', 'object', 'Any')],
    outputs: [execOut(), port('result', 'result', 'Any')],
    props: [...commonProps, { name: 'className', label: 'Class', kind: 'string', default: '' }],
    ports(props) {
      return {
        inputs: [execIn(), port('self', String(props.className || 'object'), 'Any'), ...paramPorts(callableOf(props), props)],
        outputs: [execOut(), port('result', 'result', 'Any')],
      };
    },
    color: COLOR,
    lower(ctx) {
      const callable = checkSignature(ctx);
      if (!callable) return { stmts: ctx.execBranch('out') };
      const target = ctx.inputOpt('self');
      if (!target) {
        ctx.error('library/no-object', `${callable.name} is a method; wire the object it belongs to into "${ctx.prop('className', '') || 'object'}".`);
        return { stmts: ctx.execBranch('out') };
      }
      const pkg = ctx.prop('package', '').trim();
      if (pkg) ctx.requirePackage(pkg, ctx.prop('version', '*'));
      const { args, kwargs } = lowerArguments(ctx, callable);
      const call: IrExpr = { k: 'method', target, name: callable.name, args, kwargs, exact: true, type: T.any };
      return emit(ctx, call, callable, 'result', resultHint(callable.name));
    },
  },
];
