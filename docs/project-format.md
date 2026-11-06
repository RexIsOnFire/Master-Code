# The project format

A Master Code project is a directory, not a single file.

```
MyProject/
  project.json          identity, settings, dependencies, capability grants
  architecture.json     modules and their public interfaces
  files.json            the file graph
  graphs/<id>.json      one logic graph per file that has one
  ui/<id>.json          one UI document per markup file that has one
  src/ …                generated and hand-written source
  build/ …              build output; never read back, safe to delete
```

## Why it is split

One file per graph is a version-control decision. Editing a node touches one
graph file, so two people working on different parts of a project get a clean
text merge instead of a conflict in a 4,000-line document.

Every writer sorts object keys, omits undefined fields and ends with exactly one
newline. Saving an unchanged project rewrites nothing, and a regenerated file
that did not change produces no diff.

## `project.json`

```jsonc
{
  "formatVersion": 1,
  "id": "project_ms…",
  "name": "Greeter",
  "version": "0.1.0",
  "language": "python",          // the primary language
  "languages": ["python"],       // every language present
  "architecture": "monolithic",  // or "modular"
  "namespace": "com.acme",       // Java packages, C# namespaces, Go modules, Rust crate
  "created": "2026-08-14T…",
  "modified": "2026-08-14T…",

  "build":   { "mode": "debug", "outputDir": "build", "sourceDir": "src", … },
  "sandbox": { "enabled": true, "timeoutMs": 20000, "memoryLimitMb": 512, … },
  "grants":  { "fs.read": false, "net": false, "stdio": true, … },

  "dependencies": [
    { "name": "flask", "version": "3.0.3", "language": "python",
      "manager": "pip", "license": "BSD-3-Clause", "installed": false }
  ]
}
```

`installed` is the honest record of whether the package is actually present. It
is `false` until `mcode install --yes` succeeds; adding a library never sets it.

## `files.json`

The file graph. Each entry:

```jsonc
{
  "id": "file_ms…",              // stable; this is what references point at
  "path": "src/greeting.py",     // relative, forward slashes, with extension
  "language": "python",
  "kind": "generated",           // generated | hybrid | user | external
  "role": "source",              // source | entry | test | config | asset | doc
  "moduleId": "mod_…",           // for modular projects
  "graphId": "g_…",              // the logic graph rendered into this file
  "exports": [ { "name": "build_greeting", "sort": "function" } ],
  "imports": [ { "to": "file_…", "scope": "file", "symbols": ["User"],
                 "generated": true } ]
}
```

### File kinds

| Kind | Who owns it | On regenerate |
|---|---|---|
| `generated` | The platform | Overwritten completely |
| `hybrid` | Shared | Overwritten, except inside `mcode:region` markers |
| `user` | You | Never written. Read for its exported symbols |
| `external` | Something else | Never written, never scanned |

### References are ids, not paths

`imports[].to` is a **file id**. This is the single decision that makes renaming
cheap: `mcode mv src/greeting.py src/messages.py` changes one `path` field, and
every generated import is recomputed correctly on the next generate, because the
generator derives the import text from the id.

Hand-written (`user`) files hold literal text, so they get an explicit
language-aware rewrite. It is deliberately conservative — it matches the exact
specifier the language would use, and reports anything it is not certain about
rather than half-rewriting someone's file.

## `graphs/<id>.json`

```jsonc
{
  "id": "g_…",
  "name": "main",
  "style": "procedural",          // the paradigm; changes the palette and lowering
  "fileId": "file_…",
  "variables": [ { "name": "count", "type": "i64", "scope": "module" } ],
  "nodes": [
    {
      "id": "n_…",
      "type": "control/if",
      "x": 250, "y": 130,
      "props": { … },              // node-type-specific configuration
      "inputs":  [ { "id": "cond", "name": "condition", "type": "bool",
                     "direction": "in", "defaultValue": true } ],
      "outputs": [ { "id": "then", "name": "then", "type": "Exec",
                     "direction": "out" } ]
    }
  ],
  "edges": [
    { "id": "e_…", "from": { "node": "n_a", "port": "out" },
                   "to":   { "node": "n_b", "port": "in" } }
  ]
}
```

### Types are text

`"List<Map<string, i64>>"`, not a nested object. It round-trips exactly through
`parseType`/`typeToString`, and it is far more readable in a diff.

### Ports are stored, not derived

A node's ports are written out rather than recomputed from the definition on
load. That is what lets a project open when a plugin is missing: the graph still
renders and the file still shows its shape, with one diagnostic naming the
unknown node type, instead of collapsing.

Two flags on a port matter beyond display:

- `dynamic` — a user-added slot on a variadic port.
- `bound` — a body-scoped output: a function's parameter, a loop's current item,
  a catch clause's error. Validation uses it to tell a loop body reading its own
  loop variable from a genuine data cycle. **It must survive the round trip**;
  dropping it makes a reloaded project report errors the live one did not.

## `ui/<id>.json`

A UI document: the widget tree, style rules, linked stylesheets and scripts, and
responsive breakpoints. Markup is a tree, so forcing it through the statement IR
would lose exactly the structure the designer cares about — it sits beside the
logic graph rather than inside it.

Widget kinds are abstract (`button`, `textbox`, `grid`) rather than HTML tags, so
a desktop toolkit could be added as a backend without changing the designer.

## Version control

Commit: `project.json`, `architecture.json`, `files.json`, `graphs/`, `ui/`, and
any `user` or `hybrid` source.

Ignore: `build/`.

Whether to commit the generated tree is a genuine choice. Committing it makes
the repository readable to people without Master Code and makes code review
possible; not committing it keeps the diff smaller. The output is deterministic
either way, so both work.

```gitignore
build/
*.orphaned
```

## Format versioning

`formatVersion` is `1`. Loading a project written by a newer build warns rather
than failing, and unknown fields are dropped on save — so opening a newer
project read-only is safe, and saving it is lossy and says so.
