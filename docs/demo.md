# The browser demo

**https://rexisonfire.github.io/Master-Code/demo/**

The demo is Master Code running entirely in a browser tab: the same IDE, the
same command table, the same core. You can create a project, draw it, make it
modular, generate source, build, run, test and trace it, then download it as a
zip that opens in the desktop app. There is no server. Nothing is uploaded.

It offers four languages: Python, JavaScript, HTML and CSS. Those four can also
be *run* in a browser, which is the point of the demo. The desktop app has all
ten.

## How it works

```
  packages/ide/public      the IDE, unchanged
          │  call(command, args)          (globalThis.masterCodeHost instead of HTTP)
  packages/demo/public/host.js
          │  execute(commands, session, …)
  packages/server/src/commands.ts      the same command table the local server runs
          │
  packages/core            compiled by type stripping only
          │  node:fs / node:path / node:process …   → packages/demo/public/node/*
          │  runCommand('python' | 'node', …)        → packages/demo/public/runner.js
  ┌───────┴───────────────┐
  in-memory disk           workers with an opaque origin
  ↕ IndexedDB              python-worker.js (Pyodide)   js-worker.js (Node-style modules)
```

- **Storage.** Projects live on an in-memory POSIX disk (`/home/demo/MasterCode/…`)
  that is written through to IndexedDB. A command does not return until its
  changes are stored, the same promise the desktop server's autosave makes. The
  open project is remembered per tab, so a reload reopens it.
- **Running code.** Everything the core runs goes through `runCommand`
  (`runtime/exec.ts`); the demo installs a process host there
  (`setProcessHost`), so the build, the run, the tracer, the test runner and the
  toolchain probe all move together.
- **Python** is CPython 3.14 compiled to WebAssembly (Pyodide), loaded from
  jsDelivr on first use and cached by the browser.
- **JavaScript** projects that target Node run in a worker that provides
  `node:fs`, `path`, `process`, `test`, `assert`, `crypto` (sha256, sha1, md5,
  HMAC), `url`, `os`, `util`, `events` and `buffer`.
- **HTML pages** open in a preview that inlines stylesheets, scripts and media
  into a sandboxed frame, answers `fetch()` for the project's own files, and
  follows relative links.

## What runs and what does not

| | In the demo |
|---|---|
| Python standard library, `sqlite3`, files, env, arguments | runs |
| Python packages from `requirements.txt` | pure-Python wheels from PyPI and Pyodide's own builds (numpy, pandas, …) install with micropip; packages with native code Pyodide has not built do not |
| `urllib` / `requests` | work through `fetch`, so only to servers that allow cross-origin requests |
| Receiving HTTP (`http.server`, `node:http`), threads, subprocesses, `node:sqlite` | do not run - a browser tab cannot listen on a port or start processes. The project still generates and downloads; run it locally |
| `input()` / stdin | reads whatever stdin the run was given (none from the Run button, as on the desktop) |
| npm packages | declared ones load from jsDelivr's ES module build instead of `node_modules` |
| A Python library's functions as nodes (Libraries → In this project → Functions) | read inside the sandbox, which installs the library first; the listing is saved in the project, so later looks are instant |
| ES modules that import each other in a cycle | refused with the cycle named; blob and data URLs cannot express a cycle |
| JavaScript line tracing | not available - it uses Node's inspector |
| `node --check` | skipped; syntax errors appear when the program runs |
| Java, C#, Kotlin, Go, Rust, C++, C | not offered - use the desktop app |

There is no project size limit beyond the browser's storage quota, which is a
share of free disk space. The demo asks the browser to keep its data
persistently once you create something, so it is not evicted under storage
pressure. A private window keeps nothing after it closes.

## Isolation

The site is served from `rexisonfire.github.io`, an origin shared by every
GitHub Pages project of that account. Code that ran on that origin could read
and change the stored projects - and a project can come from a zip someone else
made. So user code never runs there:

- **Programs** run in workers created from `data:` URLs, which have an opaque
  origin: they cannot open the site's IndexedDB, and talk to the page only by
  messages. Each run carries an unguessable id; messages for any other run are
  ignored. When a run ends, the page applies the files it changed - **only**
  inside the run's own directory; anything addressed elsewhere is refused and
  the interpreter discarded.
- **Each project gets its own Python interpreter.** It is reused between runs of
  the same project (starting Pyodide costs seconds) and replaced when the project
  changes, so nothing one project leaves in the interpreter is there for the next.
- **Previews** render in an `<iframe sandbox="allow-scripts">`, also an opaque
  origin.
- **Zips** are read by a reader that refuses absolute paths, drive letters,
  backslashes and `..` segments, verifies every CRC, and refuses archives that
  declare more than 1 GiB uncompressed.

What this does **not** stop: a program can use the network, as one run on the
desktop can, and it can use as much CPU and memory as the tab allows until the
run's timeout ends it. `packages/demo/check.ts` tests each of the guarantees above
from inside the sandboxes themselves.

## Building and checking

```sh
node packages/demo/build.ts            # → build/pages/demo
node packages/demo/check.ts            # builds, then drives it in headless Edge or Chrome
```

`build.ts` needs Node 22.13 or newer. It strips types with Node's own
`stripTypeScriptTypes`, the same transform `node` applies when it runs the
repository from source, and finds imports by parsing each module rather than by
pattern, so the many `import … from 'node:…'` strings inside generated-code
templates are left alone. It fails on an import that resolves to nothing or a
`node:` module with no browser shim.

`check.ts` serves the build under `/Master-Code/demo/`, the path GitHub Pages
uses, with a throwaway browser profile. It needs the network (Pyodide, PyPI,
jsDelivr). Set `DEMO_SCREENSHOTS=<dir>` to save screenshots.

The Pages workflow (`.github/workflows/pages.yml`) runs the demo's tests and
`check.ts` before every deployment, then publishes the README as the home page and
the demo under `/demo/`.
