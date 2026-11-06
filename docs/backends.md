# Adding a language

A language is one implementation of `LanguageBackend`. Nothing in the core
imports a concrete backend — they are reached through `BackendRegistry`, which is
also the door a plugin-provided language walks through.

Read `backends/python.ts` alongside this. It is the reference implementation and
exercises every part of the contract.

## What the interface asks for

| Area | Members |
|---|---|
| Identity | `id`, `name`, `maturity`, `extensions`, `features` |
| Syntax | `lineComment`, `blockComment`, `indent`, `keywords` |
| Layout | `sourceRoot`, `testRoot`, `pathFor` |
| Types | `mapType` |
| References | `importFor`, `crossFileReference?` |
| Emission | `emitModule`, `emitUi?`, `emitProjectFiles` |
| Toolchain | `packageManager`, `toolchain`, `entry` |
| Lifecycle | `buildPlan`, `runPlan`, `testPlan` |
| Feedback | `parseDiagnostics` |

## Declare what the language cannot do

```ts
features: defaultFeatures({
  classes: false,
  closures: false,
  exceptions: false,
  generics: false,
  compiled: true,
}),
```

This is load-bearing. Before emitting anything, the generator checks the IR
against these flags and refuses a graph the language cannot express, naming the
node. A backend that overstates its features produces code that does not compile
and a user with no idea why.

State maturity honestly too:

| Value | Means |
|---|---|
| `full` | Generates, builds and runs; exercised by the test suite |
| `generates` | Emits idiomatic source and a working manifest; toolchain not verified here |
| `stub` | Structure only; emits a clearly-marked stub where it cannot do better |

Today: Python, JavaScript, HTML, CSS, Java, C#, Go and Rust are `full`; C++ and
C are `generates`, because no C++ toolchain has been run against their output.

The gap between those two labels is wider than it looks. Go and Rust were
`generates` until their output was first compiled — at which point three bugs
appeared at once, including a Go entry point emitted as `func Main()` where Go
requires exactly `func main()`. Every Go program the tool had produced would
have failed to link. A generation test cannot find that; only the compiler
can.

## Emitting

`emitModule(ctx)` turns one `IrModule` into source. Use `CodeWriter` rather than
string concatenation — it owns indentation and blank-line policy, which is what
makes output byte-for-byte reproducible and therefore diffable.

For brace-and-semicolon languages, extend `CLikeEmitter`. It shares statements
and expressions and leaves you the parts that genuinely differ: types, builtins,
declarations, and the handful of statements a language spells its own way (Go's
`for`, Rust's `match`).

### Emit the body before the import block

Imports are discovered *while* emitting: `ctx.resolveSymbol(name)` appends to
`module.imports` and returns the reference to use. Every backend therefore builds
the body first and renders the header last. Get this backwards and cross-file
imports vanish.

### Builtins are the contract

Map each operation to what the language actually says. When you cannot:

```ts
default:
  throw new BackendGenError(`The Go backend does not implement "${e.op}".`, {
    code: 'codegen/unsupported-builtin',
    origin: e.origin,
    hint: 'Use a Custom Code node, or extend the Go adapter.',
  });
```

Never guess. A wrong translation that compiles is the worst outcome available.

### Collection operations are where backends diverge

`list_map`, `filter`, `reduce`, `sort_by`, `any`, `all`, `find`, `min`, `max`
and `unique` are what the functional, dataflow and pipeline paradigms lower to.
A backend that skips them supports only half the platform, and the failure looks
like "this language does not do pipelines" rather than "one adapter is
incomplete".

How each language gets there differs, and the choice matters:

| Language | Approach |
|---|---|
| Python, JavaScript | Comprehensions and array methods; no helpers needed |
| Java, C# | Streams and LINQ |
| Rust | Iterator adaptors inline, collected back into a `Vec` |
| Go | Generic helpers in the runtime package — the standard library has none |
| C++ | Function templates over `<algorithm>`, taking the callable as a template parameter so a lambda does not go through `std::function` |
| C | Declares `closures: false`; the generator refuses these graphs up front |

Two traps worth knowing. Every one of these must return a *new* collection: the
IR treats a list operation as an expression, and a caller still holding the
original must not see it change. And the IR widens integers into a numeric slot,
so `list_sum` over a `List<i64>` is legal — a backend without implicit numeric
conversion has to cast per element rather than assume `f64`.

### What is left, and why

Of 109 non-DOM operations, Python, JavaScript, Java and C# implement all of
them. Go is at 105, Rust 98, C++ 97, C 74.

Every remaining gap needs a package the generated project does not currently
depend on — `serde_json` and `reqwest` for Rust, a driver for any of the
database operations — and adding one silently would change what a user's
project pulls from the network. That is a decision to put in front of them, not
one to make on their behalf, so those operations refuse with a message naming
the crate instead.

The exception is randomness. Rust's standard library has no generator, so the
runtime carries a small xorshift seeded from the clock. It is documented in
place as unsuitable for anything security related, because the alternative was
either a dependency in every project or a `random` node that does not work.

### Runtime helpers

A few operations have no concise standard-library form. Emit a runtime module —
but only when the program actually uses one:

```ts
emitProjectFiles(project, program) {
  const ops = usedBuiltins(program);
  if (Object.keys(RUNTIME_OPS).some((op) => ops.has(op))) {
    files.push({ path: 'src/_mcode_runtime.py', role: 'source', content: RUNTIME });
  }
  return files;
}
```

Keep it small. Python needs four helpers; if yours needs forty, the mapping is
probably fighting the language.

## Fitting the IR to the language

Not every language matches the IR's shape. Say what you did, in a comment:

| Language | Mismatch | Resolution |
|---|---|---|
| Java | One public top-level type per file | Module becomes a public final class; functions become static methods; IR classes become nested types |
| C# | Same | Module becomes a static class in a namespace; `Main` lives on it |
| Go | No exceptions | `Throw` → `panic`, `Try` → `defer`/`recover`, with a comment saying so |
| Go | No ternary | `Select` → an immediately-called closure |
| Rust | Ownership | Non-`Copy` values are cloned at argument positions; documented as a limitation |
| C | No closures, generics or exceptions | Declared in `features`; the generator refuses those graphs up front |
| Python | Statement-bodied lambdas | Become named nested functions |

Each of these is a judgement call. Record the reasoning where the next reader
will hit it.

## Naming

`emitter.ts` provides `snake`, `camel`, `pascal`, `screamingSnake`, `kebab` and
`avoidKeyword`. Use them, and route user-supplied names through
`avoidKeyword(x, KEYWORDS)` — a graph variable called `class` should compile.

## Build, run, test

Return plans, not side effects:

```ts
buildPlan(project, mode) {
  return {
    steps: [{ label: 'Compile', command: 'javac', args: ['--release', '17', …] }],
    artifact: 'build/classes',
  };
}
```

The pipeline probes the toolchain first and reports a missing one with your
`installHint` rather than a spawn failure. A language with nothing to compile
returns `{ steps: [], note: '…' }`.

## Diagnostics

Parse compiler output into structured diagnostics with a file and a line. The
build pipeline maps them back to nodes from there:

```ts
parseDiagnostics(output) {
  const re = /^(.+\.java):(\d+):\s*(error|warning):\s*(.+)$/gm;
  // → { severity, stage: 'build', code, message, file, line }
}
```

Getting `file` and `line` right is what turns a compiler error into a highlighted
box in the editor.

## Checklist

- [ ] `features` lists everything the language lacks
- [ ] `maturity` is honest
- [ ] `mapType` handles every `TypeRef` kind, including `Option`, `Result`, `Future`, `function`
- [ ] Body emitted before the import block
- [ ] Unimplemented builtins throw `BackendGenError`, never guess
- [ ] Output is deterministic — generate twice, compare bytes
- [ ] `parseDiagnostics` extracts file and line
- [ ] Reserved words are avoided in generated names
- [ ] `emitProjectFiles` writes a manifest the native tool accepts
- [ ] Added to `backends/index.ts`, or contributed by a plugin
- [ ] A template exists so the language is reachable from `mcode new`

## Testing

`tests/codegen.test.ts` covers every registered backend automatically: type
mapping, template generation, determinism. Add a template for your language and
it is included. If a toolchain is available, add an end-to-end case to
`tests/runtime.test.ts` that builds and runs the output and asserts what it
prints — that is the test that catches the mistakes type-level tests miss.
