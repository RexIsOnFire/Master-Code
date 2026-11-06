# Architecture

How a drawing becomes a program, and why the boundaries sit where they do.

## The pipeline

```
  LogicGraph          nodes, ports, edges — what the user drew
      │
      │  lower/          validate, resolve generics, walk exec chains,
      ▼                  pull data edges, assemble class members
  IrModule            language-neutral: decls, statements, expressions
      │
      │  codegen/        group by language, resolve cross-file symbols,
      ▼                  add imports as a side effect of emission
  IrProgram           one per language present in the project
      │
      │  backends/       LanguageBackend.emitModule
      ▼
  GeneratedFile[]     paths and content, nothing written yet
      │
      │  codegen/regions + project/io
      ▼
  Files on disk       preserved regions merged, path escapes refused
      │
      │  build/          toolchain probe, compile, parse diagnostics,
      ▼                  map each one back to a node
  Artifact + diagnostics
```

Every stage is a pure function of its input except the last two, which touch the
filesystem and spawn processes. That is why `generate()` can back both "write the
project" and "show me the source" with no separate preview path.

## The layers, and what each may know

| Layer | Knows about | Must never know about |
|---|---|---|
| `model/` | Projects, files, graphs, widgets | IR, backends, languages |
| `types/` | The type lattice | Everything else |
| `ir/` | Declarations, statements, expressions, builtins | Graphs, files, languages |
| `nodes/` | The IR and the model | Any specific language |
| `lower/` | Graphs, nodes, the IR | Any specific language |
| `backends/` | The IR, one language | Graphs, nodes, the lowering pass |
| `codegen/` | Everything above | The CLI, the server, the UI |
| `cli/`, `server/`, `ide/` | The core's public surface | Its internals |

The one rule that keeps this honest: **no file under `backends/` imports from
`nodes/` or `lower/`, and no file under `nodes/` names a language.** A node
definition that needed a per-language branch would be a design failure — the
right fix is a new builtin operation, which every backend then has to implement
or explicitly refuse.

## Why an IR at all

The obvious implementation of a visual programming tool emits source directly
from nodes. It is simpler and it is a dead end: each node needs one emitter per
language, so 207 nodes × 10 languages is 2,070 pieces of code to write and keep
consistent.

With an IR it is 207 lowering functions plus 10 backends. More importantly the
*failure modes* change. Direct emission has no place to notice that a C target
cannot express a closure — it just produces text that will not compile. With an
IR there is a structure to inspect, so `checkFeatureSupport` can refuse the graph
up front and name the node.

## Lowering in detail

Two interleaved walks:

**Execution.** Each root node (Main, Function, Class member, Event Handler,
Test Case) starts a chain. A node emits its own statements and calls
`ctx.execBranch('out')` to splice in everything downstream, so nesting falls out
of the graph's shape rather than needing a separate structuring pass.

**Data.** Pulling on an input lowers the producing node on demand and memoises
it, so a node feeding three consumers is lowered once. Pure expressions are
inlined at each use site; anything large enough to hurt readability is hoisted
into a named local first.

### The one subtlety worth knowing: `bindOutput`

A Function node's body reads the Function node's own parameter ports. Lowering
the body naively re-enters the node that is currently being lowered, which looks
exactly like a cycle.

The fix is a protocol rather than a special case. A node whose execution branch
can see its own outputs publishes them first:

```ts
lower(ctx) {
  const ref = E.ref('who', T.string);
  ctx.bindOutput('p:who', ref);     // publish
  const body = ctx.execBranch('out'); // now safe to walk the body
  …
}
```

Those ports are marked `bound: true` in the definition, which also tells graph
validation that a wire from one back into its declaring node is nesting rather
than a data cycle. Loops, catch clauses, lambdas, methods and event handlers all
use the same mechanism.

*(This flag has to survive the project round trip. It did not, once — a reloaded
project reported its own loop bodies as cycles. There is a regression test.)*

## Cross-file references

Generated code needs `from greeting import build_greeting`. Nothing in the graph
says that; the node just names a symbol.

Resolution happens during emission. Each backend calls
`ctx.resolveSymbol(name)`, which looks the name up in the project's symbol index
and, if it lives in another file, **appends an import to the module and returns
the reference to use**. Every backend renders its import block *after* the body
for exactly this reason.

This is why renaming a file costs nothing: references are file ids, and the
import text is recomputed from scratch on the next generate. Hand-written files
are the exception — those hold literal text, so they get an explicit,
conservative rewrite pass that reports anything it is not sure about instead of
guessing.

## Two graphs, not one

A project holds two distinct graphs, and conflating them is the mistake this
design most wants to avoid.

| | Logic graph | File graph |
|---|---|---|
| Nodes | Functions, branches, loops, expressions | Files and modules |
| Edges | Execution order and data flow | Imports, includes, package membership |
| Scope | Inside one file | Across the project |
| Lives in | `project.graphs[]` | Derived from `project.files[].imports` |
| Built by | The node editor | Generation, plus scanning for user files |
| Drawn by | `packages/ide/public/editor.js` | `packages/ide/public/architecture.js` |

They are separate because they answer different questions and change at
different times. Editing a condition rewrites a logic graph and touches no file
edges. Moving a file rewrites file edges and touches no logic. Keeping them
apart is what lets a rename be a one-field change: the logic never referred to
the path in the first place.

Both are rendered as graphs. A dependency structure shown as a list of strings
is a dependency structure nobody reads, and "we recomputed your imports" is only
a credible claim if you can see which edges were recomputed.

The Architecture view lays files out by dependency depth — one column right of
everything they import — so the arrows read left to right and the entry point
lands last. Cycles have no consistent depth, so the edges that close them are
excluded from layout and then drawn in red. `layoutFileGraph` is a pure function
for this reason: the interesting cases are cycles and orphans, and those are far
easier to assert on than to click through.

## Referring to things in other files

A node names a symbol; it never names a path. `ctx.resolveSymbol(name)` looks
the name up in the project index during emission and, if it lives in another
file, appends the import and returns the reference to use. That is why a rename
costs one field: the graph never mentioned the path.

For the *editor*, though, `file.exports` is the wrong source. It is refreshed
during generation, which is correct for the file graph — an export is what a
file actually emitted — but it cannot answer the question a user asks
constantly: what can I call from here? A function drawn thirty seconds ago has
no export entry yet.

So `projectSymbols(project)` reads declarations out of the **graphs**, and
cross-checks them against the exports to report `emitted` separately. Both facts
are true and useful, and conflating them would either hide new work or claim
something exists in the generated tree when it does not.

Scope rules follow from that. `symbolsVisibleFrom(project, fileId)` offers
everything in the same file plus anything module-scoped elsewhere; a `local`
variable in another graph is excluded, because offering it would produce code
that does not compile. And a Call Function node whose target resolves to nothing
is an error anchored to the node, with a "did you mean" — far better than a
compiler error on a line the user never wrote.

## Monolithic and modular are the same project

A project declares an `architecture`, but the two shapes differ only in where
files sit and whether modules exist to group them. Converting between them is
therefore a set of moves plus bookkeeping — not a migration.

That works because of the property above: nothing in a logic graph refers to a
path. `flatten` moves every module's files into the source root and drops the
modules; `modularise` groups files into directories and creates them. Both run
through `renameFile`, so reference updating — including the conservative rewrite
of hand-written imports, and the warnings when that is not possible — behaves
exactly as it does for a single rename. Generated imports are recomputed on the
next generate from file ids that never changed.

Three details are deliberate:

- **Modularising will not guess.** With no subdirectories to read boundaries
  from, it declines and says why rather than inventing modules from file names.
- **The entry point joins no module.** Putting it in one makes that module
  depend on everything, which defeats the grouping.
- **A flatten collision renames rather than overwrites.** Two modules can each
  hold a `user.py`; the second becomes `storage_user.py`, and that is reported.

Both directions take `dryRun`, and both the CLI and the IDE use it to show the
moves before doing anything. Conversion is also an ordinary mutation, so it is
covered by undo without any inverse being written for it — which is the payoff
of making commands undoable by default.

## The UI builder

Markup is a tree, not control flow, so a UI document sits beside the logic graph
rather than inside it — forcing it through the statement IR would lose exactly
the structure a designer cares about. `UiWidgetKind` is abstract (`button`,
`card`, `row`) rather than HTML-specific, which is what leaves room for a
desktop toolkit to be added as an adapter.

The same tree drives three backends: HTML renders the elements, CSS collects the
rules declared on nodes, and JavaScript wires each `events` entry to a handler
function in the logic graph. That last one is the join between the two halves of
the model, and the builder only offers handlers that exist — the list comes from
the project symbol index, so a binding cannot be mistyped into something that
fails at generation.

Editing follows the same rule as everything else: the document is server-owned,
each change goes through `file.setUi`, and it is therefore saved and undoable.
The preview is the *generated* HTML rather than a separate render path, so what
you see cannot disagree with what the backend writes.

Styles come in two kinds and the builder keeps them apart, because they are not
interchangeable. An **inline style** belongs to one widget and travels with it;
a **stylesheet rule** has a selector, applies across the page, and may sit
inside a breakpoint. The rules editor offers the document's declared
breakpoints rather than a free-text media query — a responsive rule that does
not match a declared breakpoint is almost always a typo, and the breakpoint list
is exactly what the CSS backend groups its output by.

## Seeing a run on the graph

Tracing answers the questions a visual program actually raises — did that branch
run, how many times did the loop go round, which nodes are dead — without a
debug adapter.

The generated code is not instrumented. Instrumenting it would mean the thing
you ran is not the thing you would ship, and every backend would need to emit
two variants. Each language is traced with what it already has, from a wrapper
the program never sees: `sys.settrace` for Python, the inspector's coverage API
for Node. The wrapper is deleted afterwards, so it can never reach an export.

Mapping lines back to nodes happens two ways, in order of confidence:

1. **What the backend recorded while emitting.** `CodeWriter.mark` attributes a
   line to the node that produced it, and `blockFrom` carries those attributions
   when a body is composed into a header. Exact.
2. **Identifiers on the line**, the same approach diagnostics use. Less precise,
   never wrong, and the fallback for backends that do not report line origins.

Then one inference is applied: **a pure node inlined into a statement that ran,
ran.** Generation inlines pure nodes into their use site, so a Literal or a
Format leaves no statement and often no identifier. Reporting those as dead is
not a gap, it is a wrong answer — the statement holding them executed. The
inference is sound one way only (a consumer running proves its inputs ran, not
the reverse), so it only ever adds.

## Determinism

Generated files are byte-for-byte reproducible: roots are lowered in a stable
order, imports are sorted, temporary names are derived from node names rather
than counters where possible, and every writer trims trailing whitespace and
ends with exactly one newline. Project JSON sorts its keys.

This is a version-control requirement, not neatness. If regeneration produced
cosmetically different output, every `mcode gen` would create a diff and the
generated tree would be unreviewable.

## Diagnostics and source mapping

Every IR node carries an `origin` — the id of the visual node that produced it.
Compiler output is parsed by the backend into structured diagnostics, and
`build/sourcemap.ts` maps each back to a node.

The mapping is a symbol index, not line tracking: emitters name locals after the
nodes they came from, so a diagnostic that mentions a generated identifier maps
to the right node. One that mentions none of them maps only as far as the file,
and therefore to the graph. That is a real limitation, and the honest behaviour
is what it does — it never points at the *wrong* node, which would be worse than
pointing at nothing.

## Where the UI fits

The IDE holds no derived state. Every mutation is a command to the server, whose
response carries the new project. That costs a round trip on a localhost socket
and buys the guarantee that what is on screen is what is saved.

The canvas is one drawing surface rather than DOM nodes because a few hundred
nodes with live wires repaint far more smoothly that way, and hit-testing a
bezier is easier in canvas coordinates. The editor owns no truth: it renders the
graph it is handed and reports intent through callbacks.

**Undo lives on the server for the same reason.** A browser-side history would
have to model what each command did in order to reverse it, and that model would
drift from the handlers the first time one changed. Instead the dispatcher
snapshots the whole project before any mutating command — in the dispatcher, not
in each handler, because a handler that forgets is an edit that silently cannot
be undone. Undo is then exact by construction rather than by a per-command
inverse that has to be written and kept correct.

Two policies are worth knowing. Commands are undoable **by default**: a mutating
command added later is covered without anyone opting in. And only *continuous*
edits coalesce — typing in a property field is one step, but adding two nodes
quickly is two, because a fast user must not lose a step to a timer.

## Deliberate omissions

- **No incremental compilation.** Generation is fast enough (a few milliseconds
  for a typical project) that a cache would be complexity without payoff yet.
- **No live debugger protocol.** There are no breakpoints and no stepping;
  those need a debug adapter per language, which is real work and is not
  pretended at. What exists instead is execution tracing — see below.
- **No graph diff/merge UI.** The project format is split per graph and sorted so
  that text merges work; a visual diff is a future addition, not a shipped one.
