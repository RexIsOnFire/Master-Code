# Example projects

Five real projects, each a Master Code project directory you can open, edit and
run. They are not fixtures — they were created with `mcode new`, they generate
clean code, and the ones with a toolchain available on your machine build and
run.

Open one in the IDE:

```sh
cd examples/hello-cli
mcode ide          # or: node packages/server/src/main.ts
```

Or drive it from the terminal:

```sh
cd examples/hello-cli
mcode gen          # graph -> source
mcode build        # source -> artifact
mcode run          # run it under the sandbox
mcode test         # run the tests the graph defines
mcode export --out /tmp/plain-python   # a project that no longer needs us
```

| Example | Template | What it shows |
|---|---|---|
| [hello-cli](hello-cli/) | `python/cli` | Two source files and a test. `main.py` calls `greeting.py`, so the generated code contains a real cross-file import that the file graph produced — not a string the template pasted in. |
| [data-pipeline](data-pipeline/) | `python/pipeline` | Data-flow rather than control-flow: Source → Transform → Filter → Aggregate → Sink, wired entirely with data edges. Two lambda nodes supply the transform and the predicate. |
| [item-service](item-service/) | `python/api` | A modular project: an `api` module and a `storage` module, each with a declared public interface, and a dependency (Flask) recorded in `requirements.txt` but deliberately not installed. |
| [web-dashboard](web-dashboard/) | `web/dashboard` | Three languages in one project. The page comes from the UI designer, the stylesheet from its style rules (including a responsive breakpoint), and the behaviour from an event-driven JavaScript graph. |
| [node-tool](node-tool/) | `javascript/cli` | The smallest useful Node project: reads `argv`, formats a message, prints it. |

## What to look at in each

**hello-cli** — run `mcode gen`, then open `build/generated/src/main.py`. The
line `from greeting import build_greeting` was not written by anyone; the
generator resolved the symbol through the file graph. Rename the file
(`mcode mv src/greeting.py src/messages.py`) and regenerate: the import follows,
because references are stored by file id rather than by path.

**data-pipeline** — the whole program is one expression. Look at the generated
`main.py` to see how a graph with no execution wires between its stages becomes
a nested comprehension.

**item-service** — `mcode info` prints the module structure and the import
edges. `requirements.txt` lists Flask with a note that Master Code does not
install it; `mcode install` will show you the exact command before it runs
anything.

**web-dashboard** — `mcode gen` writes `index.html`, `styles.css` and
`src/app.js`. The markup carries `data-mcode-events` attributes rather than
inline `onclick` handlers, so the page works under a content security policy.
`mcode run` prints the path to open.

**node-tool** — the shortest path from a graph to a running program.

## Regenerating these

They are checked in as project sources only — `build/` is not committed. Every
example regenerates from its graphs:

```sh
for d in examples/*/; do (cd "$d" && mcode gen); done
```
