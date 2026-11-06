# Plugins

A plugin is an ES module that default-exports a `Plugin`. It gets the same
registries the built-in catalogue uses — there is no separate, lesser extension
surface, which is why "add a language" is a plugin-sized task rather than a fork.

## What a plugin can contribute

| Contribution | Adds |
|---|---|
| `nodes` | Node types, available in every language that can express them |
| `languages` | A whole `LanguageBackend` — see [backends.md](backends.md) |
| `templates` | Starting projects |
| `exporters` | New output formats |
| `importers` | New ways to read an existing codebase |
| `themes` | IDE colour schemes |

## Where plugins live

Two directories, both scanned at startup:

```
<install>/plugins/…/plugin.ts     ships with Master Code, or dropped in globally
<project>/plugins/…/plugin.ts     travels with one project
```

Any nested folder holding `plugin.ts`, `plugin.js` or `plugin.mjs` is a plugin.
The `languages/ nodes/ templates/ exporters/ themes/` grouping under `plugins/`
is for humans; nothing reads it.

### Importing the core — read this before you write the import

A plugin inside `<install>/plugins/` reaches the core through the `#core/*`
subpath, which resolves because it sits inside the Master Code package:

```ts
import { definePlugin } from '#core/plugin/api.ts';
import { E, S, at } from '#core/ir/build.ts';
import { T } from '#core/types/types.ts';
```

A plugin in a **project** directory is outside that package, so `#core/*` does
not resolve for it. Use a relative path to the installation:

```ts
import { definePlugin } from '../../../path/to/Master Code/packages/core/src/plugin/api.ts';
```

If that is awkward, put the plugin in `<install>/plugins/` instead — that is what
the directory is for, and it then works for every project on the machine.

## A minimal plugin

```ts
import { definePlugin } from '#core/plugin/api.ts';
import { port } from '#core/nodes/definition.ts';
import { E, at } from '#core/ir/build.ts';
import { T } from '#core/types/types.ts';

export default definePlugin({
  id: 'example.clamp',
  name: 'Clamp',
  version: '1.0.0',
  apiVersion: 1,

  contributes: {
    nodes: [
      {
        type: 'math/clamp',
        category: 'Math',
        title: 'Clamp',
        description: 'Restricts a number to a low and high bound.',
        keywords: ['limit', 'bound', 'range'],
        pure: true,
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
      },
    ],
  },
});
```

That node works in all ten languages, because it lowers to builtins every backend
already implements. This is the property to preserve: **a node definition should
never branch on the target language.** If you find yourself wanting to, the right
move is a new builtin operation that every backend implements or explicitly
refuses — see [nodes.md](nodes.md).

A complete worked example, with four nodes and a template, is in
[`plugins/nodes/statistics/plugin.ts`](../plugins/nodes/statistics/plugin.ts).

## Loading and failure

Loading is deliberately dull: import the module, register the declarative
contributions, call `activate`, record what was registered.

Failures are reported, never silent:

| Situation | What happens |
|---|---|
| No default export | Error naming the file |
| `apiVersion` mismatch | Refused, with both versions in the message |
| Duplicate plugin id | Skipped with a warning |
| Node/language id collides | That one contribution is rejected; the rest load |
| `activate` throws | Reported; declarative contributions stay registered |

Check what loaded with `mcode plugins`.

## Contribution details

### Nodes

See [nodes.md](nodes.md). The contract is `NodeDefinition`: ports, properties,
docs, and one `lower(ctx)` function.

### Templates

A template is a function that builds a project, not files to copy. Everything it
produces must be an ordinary graph the user could have drawn.

```ts
templates: [{
  id: 'python/worker',
  language: 'python',
  title: 'Background worker',
  description: 'Polls a queue and processes items.',
  outline: ['src/main.py', 'requirements.txt'],
  build({ registry, options }) {
    const project = newProject({ ...options, language: 'python' });
    const { graph } = addFile(project, {
      path: 'src/main.py', language: 'python', role: 'entry',
      graph: { name: 'worker', style: 'procedural' },
    });
    const g = new GraphBuilder(project, registry, graph!);
    // …add and connect nodes…
    return project;
  },
}]
```

Node positions are laid out for you — the registry wraps every template so its
graphs are arranged by dependency order on the way out.

### Exporters

```ts
exporters: [{
  id: 'docs.markdown',
  title: 'Markdown documentation',
  description: 'One page per module, from the public interfaces.',
  output: 'docs/',
  run(project, generated) {
    return project.modules.map((m) => ({
      path: `docs/${m.name}.md`,
      content: `# ${m.name}\n\n${m.description ?? ''}\n`,
    }));
  },
}]
```

### Importers

```ts
importers: [{
  id: 'import.gradle',
  title: 'Gradle project',
  description: 'Reads a Gradle build into a project.',
  languages: ['java'],
  detect: (root) => existsSync(join(root, 'build.gradle')),
  run: (root, options) => { /* … */ },
}]
```

## Trust

**Plugins run with the platform's full privileges.** There is no plugin sandbox.
Installing one is the same trust decision as installing an editor extension
anywhere else, and it is stated here rather than left to be discovered.

The capability system constrains *generated programs*, not the plugins that
generate them.

## Stability

`PLUGIN_API_VERSION` is `1`. A plugin declaring a different version is refused
rather than loaded and left to fail somewhere subtler. Within a version, these
are the stable surfaces:

- `Plugin`, `PluginContributions`, `PluginContext`, `definePlugin`
- `NodeDefinition`, `LowerContext`, `LowerResult`, `PortSpec`, `PropSpec`
- `LanguageBackend` and everything it references
- `ProjectTemplate`, `Exporter`, `Importer`, `Theme`
- The IR types, `E`/`S`/`D` builders, and the builtin registry
