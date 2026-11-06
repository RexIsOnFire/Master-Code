/**
 * Factories for the large families of nodes that are thin wrappers over a
 * builtin operation. Writing each of them out by hand would be a hundred
 * near-identical blocks; deriving them from the builtin registry keeps the
 * node catalogue and the backend contract from drifting apart.
 */

import type { NodeDefinition, PortSpec } from '../definition.ts';
import { execIn, execOut, port } from '../definition.ts';
import { E, S, at } from '../../ir/build.ts';
import { getBuiltin } from '../../ir/builtins.ts';
import { T, typeToString } from '../../types/types.ts';
import type { TypeRef } from '../../types/types.ts';

export interface BuiltinNodeOptions {
  type: string;
  category: string;
  title: string;
  /** Builtin op id from `ir/builtins.ts`. */
  op: string;
  /** Input port names, in argument order. Defaults come from the builtin spec. */
  args: (string | { name: string; default?: unknown; type?: TypeRef | string })[];
  /** Output port name; omitted for void operations. */
  result?: string;
  description?: string;
  keywords?: string[];
  languages?: string[];
  /**
   * Force an exec-threaded node even when the builtin is pure, or force a pure
   * node even when it is effectful. Defaults to `spec.effectful`.
   */
  exec?: boolean;
  /** Extra trailing arguments supplied as constants rather than ports. */
  fixedArgs?: unknown[];
  color?: string;
}

export function builtinNode(o: BuiltinNodeOptions): NodeDefinition {
  const spec = getBuiltin(o.op);
  if (!spec) throw new Error(`builtinNode: unknown builtin "${o.op}" for node ${o.type}`);

  const argSpecs = o.args.map((a, i) => (typeof a === 'string' ? { name: a } : a));
  const isExec = o.exec ?? spec.effectful ?? false;
  const returnsValue = spec.returns.kind !== 'void';
  const resultName = o.result ?? 'result';

  const dataInputs: PortSpec[] = argSpecs.map((a, i) =>
    port(`a${i}`, a.name, a.type ?? spec.params[Math.min(i, spec.params.length - 1)] ?? T.any, {
      default: a.default,
    }),
  );

  const inputs = isExec ? [execIn(), ...dataInputs] : dataInputs;
  const outputs: PortSpec[] = [];
  if (isExec) outputs.push(execOut());
  if (returnsValue) outputs.push(port(resultName, resultName, spec.returns));

  return {
    type: o.type,
    category: o.category,
    title: o.title,
    description: o.description ?? spec.doc,
    keywords: o.keywords ?? [o.op, spec.category],
    languages: o.languages,
    inputs,
    outputs,
    caps: spec.caps,
    pure: !isExec,
    color: o.color,
    doc: `Builtin \`${o.op}\`: ${spec.doc}\n\nSignature: (${spec.params
      .map(typeToString)
      .join(', ')}) -> ${typeToString(spec.returns)}`,
    lower(ctx) {
      const args = argSpecs.map((_, i) => ctx.input(`a${i}`));
      for (const fixed of o.fixedArgs ?? []) args.push(constOf(fixed));
      // The port's resolved type is more precise than the builtin's declared
      // return type whenever generics were involved (List<T> -> T).
      const outType = returnsValue ? ctx.portType(resultName) : T.void;
      const call = at(E.builtin(o.op, args, outType, spec.caps), ctx.origin);
      spec.caps?.forEach((c) => ctx.requireCapability(c));

      if (!isExec) return { exprs: returnsValue ? { [resultName]: call } : {} };

      if (!returnsValue) {
        return { stmts: [at(S.expr(call), ctx.origin), ...ctx.execBranch('out')] };
      }
      const tmp = ctx.temp(resultName === 'result' ? o.op.replace(/^[a-z]+_/, '') : resultName);
      const ref = E.ref(tmp, outType);
      // Publish before walking the chain: the next node along almost always
      // reads this value.
      ctx.bindOutput(resultName, ref);
      const decl = at(S.let_(tmp, outType, call, false), ctx.origin);
      return { stmts: [decl, ...ctx.execBranch('out')], exprs: { [resultName]: ref } };
    },
  };
}

/** Variadic wrapper, for ops like `print` and `format` that take a list. */
export function variadicBuiltinNode(
  o: Omit<BuiltinNodeOptions, 'args'> & { argName: string; leading?: BuiltinNodeOptions['args'] },
): NodeDefinition {
  const spec = getBuiltin(o.op);
  if (!spec) throw new Error(`variadicBuiltinNode: unknown builtin "${o.op}"`);
  const isExec = o.exec ?? spec.effectful ?? false;
  const returnsValue = spec.returns.kind !== 'void';
  const resultName = o.result ?? 'result';

  const leading = (o.leading ?? []).map((a, i) =>
    typeof a === 'string' ? port(`a${i}`, a, T.any) : port(`a${i}`, a.name, a.type ?? T.any, { default: a.default }),
  );

  return {
    type: o.type,
    category: o.category,
    title: o.title,
    description: o.description ?? spec.doc,
    keywords: o.keywords ?? [o.op],
    languages: o.languages,
    inputs: [...(isExec ? [execIn()] : []), ...leading, port('v', o.argName, T.any, { variadic: true })],
    outputs: [
      ...(isExec ? [execOut()] : []),
      ...(returnsValue ? [port(resultName, resultName, spec.returns)] : []),
    ],
    caps: spec.caps,
    pure: !isExec,
    color: o.color,
    lower(ctx) {
      const head = leading.map((p) => ctx.input(p.id));
      const rest = ctx.variadic('v');
      const args = [...head, ...rest];
      const outType = returnsValue ? ctx.portType(resultName) : T.void;
      spec.caps?.forEach((c) => ctx.requireCapability(c));
      const call = at(E.builtin(o.op, args, outType, spec.caps), ctx.origin);
      if (!isExec) return { exprs: returnsValue ? { [resultName]: call } : {} };
      if (!returnsValue) return { stmts: [at(S.expr(call), ctx.origin), ...ctx.execBranch('out')] };
      const tmp = ctx.temp(resultName);
      const ref = E.ref(tmp, outType);
      ctx.bindOutput(resultName, ref);
      const decl = at(S.let_(tmp, outType, call, false), ctx.origin);
      return { stmts: [decl, ...ctx.execBranch('out')], exprs: { [resultName]: ref } };
    },
  };
}

function constOf(v: unknown) {
  if (typeof v === 'boolean') return E.bool(v);
  if (typeof v === 'number') return Number.isInteger(v) ? E.int(v) : E.float(v);
  return E.str(String(v));
}
