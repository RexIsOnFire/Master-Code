# Writing a node

A node type is data plus one function. The data is ports, properties and
documentation; the function lowers an instance to IR.

## The shape

```ts
import type { NodeDefinition } from '#core/nodes/definition.ts';
import { execIn, execOut, port } from '#core/nodes/definition.ts';
import { E, S, at } from '#core/ir/build.ts';
import { T } from '#core/types/types.ts';

export const clamp: NodeDefinition = {
  type: 'math/clamp',          // namespaced, globally unique
  category: 'Math',            // groups it in the palette
  title: 'Clamp',
  description: 'Restricts a number to a low and high bound.',
  keywords: ['limit', 'bound'],// palette and command-palette search
  pure: true,                  // no exec ports; may be inlined at each use

  inputs: [
    port('value', 'value', 'f64', { default: 0 }),
    port('low', 'low', 'f64', { default: 0 }),
    port('high', 'high', 'f64', { default: 1 }),
  ],
  outputs: [port('result', 'result', 'f64')],

  lower(ctx) {
    const clamped = E.builtin(
      'math_min',
      [E.builtin('math_max', [ctx.input('value'), ctx.input('low')], T.f64), ctx.input('high')],
      T.f64,
    );
    return { exprs: { result: at(clamped, ctx.origin) } };
  },
};
```

## The rule that matters most

**A node definition must never branch on the target language.** If you need
behaviour a language does not have, add a *builtin operation* — then every
backend either implements it or refuses it explicitly. A per-language branch
inside a node is 207 × 10 work waiting to happen.

The only exception is a node that is genuinely language-specific, like the DOM
nodes. Those declare `languages: ['javascript']`, and the registry filters them
out of the palette everywhere else so a graph cannot silently contain one its
target cannot emit.

## Pure versus exec

**Pure nodes** have no execution ports. They lower to an expression, and the
engine inlines them at each use site (hoisting into a named local when the
expression is large enough to hurt readability).

**Exec nodes** have `execIn()` and `execOut()`. They lower to statements and
must splice in what follows:

```ts
lower(ctx) {
  return { stmts: [at(S.expr(call), ctx.origin), ...ctx.execBranch('out')] };
}
```

Forgetting `...ctx.execBranch('out')` silently truncates the program after your
node. If a node produces a value *and* continues a chain, publish the value
before walking the branch:

```ts
lower(ctx) {
  const tmp = ctx.temp('result');
  const ref = E.ref(tmp, type);
  ctx.bindOutput('result', ref);          // ← before execBranch
  const decl = at(S.let_(tmp, type, call, false), ctx.origin);
  return { stmts: [decl, ...ctx.execBranch('out')], exprs: { result: ref } };
}
```

## Body-scoped outputs

A Function node's parameters, a loop's current item, a catch clause's error —
values that exist only inside the node's own branch. Mark them `bound: true`:

```ts
outputs: [
  execOut('body', 'body'),
  port('item', 'item', 'T', { bound: true }),
]
```

Two things depend on that flag. Lowering needs the value published via
`bindOutput` before the branch is walked, or reading it re-enters the node being
lowered. Validation needs to know a wire from that port back into its declaring
node is nesting, not a data cycle.

## Dynamic ports

When a node's shape depends on its configuration, implement `ports()`:

```ts
props: [{ name: 'params', label: 'Parameters', kind: 'ports', default: [] }],

ports(props) {
  const params = readParams(props);
  return {
    inputs: [],
    outputs: [
      execOut('out', 'body'),
      ...params.map((p) => port(`p:${p.name}`, p.name, p.type, { bound: true })),
    ],
  };
}
```

The editor re-materialises ports after every property edit and drops wires whose
port no longer exists.

For a variable number of the *same* input, mark it `variadic: true` and read them
with `ctx.variadic('v')`. The user adds slots from the properties panel; they get
ids `v#1`, `v#2`, …

## Generics

Port types may contain type variables. `List<T>` on an input and `T` on an output
means the output type follows whatever is wired in:

```ts
inputs: [port('items', 'items', 'List<T>')],
outputs: [port('item', 'item', 'T', { bound: true })],
```

Resolution unifies declared types against connected ones, then substitutes.
Inputs win: a consumer can pin a variable the inputs left open, but it cannot
re-type one the inputs already determined. Read the resolved type with
`ctx.portType('item')` rather than assuming the declared one.

## The lowering context

| Call | Use |
|---|---|
| `ctx.input(portId)` | The wired expression, or the port default, or a zero value |
| `ctx.inputOpt(portId)` | Same, but `undefined` when there is nothing |
| `ctx.connected(portId)` | Is anything wired here |
| `ctx.variadic(baseId)` | All slots of a variadic input, in order |
| `ctx.bindOutput(portId, expr)` | Publish an output before walking a branch |
| `ctx.execBranch(portId)` | Lower everything downstream of an exec output |
| `ctx.portType(portId)` | The resolved type after generic unification |
| `ctx.prop(name, fallback)` | A typed property read |
| `ctx.oneOf(name, allowed, fallback)` | A property constrained to a set of values |
| `ctx.ident(name, fallback)` | A property as an identifier legal in every language |
| `ctx.propType(name, fallback)` | A property as a `TypeRef` |
| `ctx.temp(hint)` | A unique local name that will not shadow a declaration |
| `ctx.require(imp)` | Add an import to the module |
| `ctx.requirePackage(name, ver)` | Record a dependency in the manifest |
| `ctx.emitDecl(decl)` | Add a module-level declaration |
| `ctx.requireCapability(cap)` | Declare a runtime capability for the sandbox |
| `ctx.variable(name)` | Look up a graph variable |
| `ctx.error(code, msg, hint)` | Report a problem anchored to this node |

## Deriving nodes from builtins

Most nodes are thin wrappers over one builtin. Do not write them by hand:

```ts
builtinNode({
  type: 'string/trim',
  category: 'String',
  title: 'Trim',
  op: 'str_trim',
  args: ['text'],
  result: 'text',
});
```

The factory reads the builtin's signature, capabilities and documentation from
the registry, decides whether the node needs exec ports from whether the
operation is effectful, and wires up the result binding. That is how the node
catalogue and the backend contract stay from drifting apart.

## Adding a builtin

When no existing operation fits, add one to `ir/builtins.ts`:

```ts
b('str_title_case', 'string', [T.string], T.string,
  'Capitalises the first letter of each word.'),
```

Then implement it in every backend. A backend that cannot must throw
`BackendGenError` naming the node — a build-time refusal is far better than a
plausible-looking wrong translation. The test suite asserts every builtin has a
signature, a category and a real description.

## Reading properties safely

`ctx.prop` widens its fallback: `ctx.prop('mode', 'sum')` gives you a `string`,
not the literal `'sum'`. That is deliberate — the value comes out of project
JSON, and a file edited by hand or written by an older version of your node can
hold anything.

When the value has to be one of a fixed set, say so and let the read validate
it:

```ts
const op = ctx.oneOf('op', ['+', '-', '*', '/'] as const, '+');
```

Anything outside the list falls back rather than reaching the IR. Casting
instead (`ctx.prop<BinaryOp>('op', '+')`) puts unchecked text into the tree,
where it surfaces much later as broken generated source.

## Validation

Beyond port typing, a node can check its own configuration:

```ts
validate(node, project, diag) {
  if (!String(node.props.code ?? '').trim()) {
    diag.warn('graph', 'custom/empty', 'Custom Code node has no source.', {
      origin: { nodeId: node.id },
      hint: 'Write the body, or delete the node.',
    });
  }
}
```

Anchor every diagnostic to a node id. That is what lets the editor highlight the
box and the Problems list jump to it.

## Registering

Built-in nodes go in a `nodes/catalog/*.ts` group and are exported from
`catalog/index.ts`. Plugin nodes go in `contributes.nodes` — the same
`NodeRegistry.register` either way. See [plugins.md](plugins.md).
