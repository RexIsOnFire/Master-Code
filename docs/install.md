# Installation

## Requirements

**Node 22.6 or newer.** That is the whole hard requirement. Master Code runs from
source using Node's native TypeScript type stripping — there is no build step, no
bundler, and no `node_modules`.

```sh
node --version    # must be >= 22.6
```

Get it from [nodejs.org](https://nodejs.org) if that command is not recognised.

Everything else is optional and only affects which languages you can *build*.
Generation, validation, the IDE and export work for all ten languages with
nothing else installed — and the app tells you which is which, on screen, before
you pick a language.

## Starting it

**Double-click `MasterCode.exe`.**

A console window opens, reports what it found, and your browser opens on the
welcome screen. Leave that window open; closing it stops Master Code.

```
  Master Code
  -----------
  Installation  F:\Repos\Master Code\
  Node          v25.8 (C:\nvm4w\nodejs\node.exe)
  Project       welcome screen
  Address       http://127.0.0.1:4488/
```

If Node is missing or too old, it says so and points at nodejs.org rather than
failing with a stack trace. If port 4488 is busy it moves to the next free one.
Dropping a project folder onto the exe opens that project directly.

**Without the exe:** `Master Code.cmd` on Windows, `./master-code.sh` on macOS
and Linux. Same thing, minus the Node check and the tidy shutdown.

**Rebuilding the exe** (only if you change the launcher — it needs the .NET SDK,
and produces a self-contained binary that does not):

```powershell
powershell -ExecutionPolicy Bypass -File launcher\build.ps1
```

## The welcome screen

The first thing you see. Nothing here needs a terminal.

- **New project** — pick a language, then a starting point (including a blank
  project, if you would rather start from nothing), then a name and a folder. Each language shows what this machine can do with it: **ready** means
  the toolchain is installed and it will build and run here; **generates** means
  it emits idiomatic source and a working manifest, but the compiler is not
  installed yet, and it names the one to install.
- **Learn by doing** — a guided tutorial, then challenges from easy to hard:
  add two numbers, even or odd, a calculator, FizzBuzz, number statistics,
  splitting logic across two files. Every one works in any language, because
  the graph you draw is not language-specific. The Challenge panel carries the
  brief, the steps, hints one at a time, and a **Check** button that builds,
  runs and compares the real output.
- **Open a project** — a folder browser, no path typing.
- **Recent** — projects you have opened, most recent first. One that has been
  moved or deleted is shown struck through rather than quietly dropped.
- **This machine** — the same toolchain report the CLI's `doctor` prints.

Once a project is open, `File → New project` and `File → Open project` come back
to it.

## First project, in the UI

1. Double-click `MasterCode.exe`.
2. **New project** → **Python 3** → **Command-line application**.
3. Name it, press **Create project**.
4. **Generate** turns the graph into source; **Run** builds and runs it.

`Run` will refuse the first time and ask for a capability. That is the sandbox
working — the template reads command-line arguments, which needs `env`. Grant it
and run again.

## Language toolchains

Install only the ones you intend to build. The welcome screen reflects whatever
you have at the moment you look.

| Language | Needs | Get it |
|---|---|---|
| Python | `python` 3.10+ | [python.org](https://python.org) or your package manager |
| JavaScript | `node` 20+ | Already have it |
| HTML / CSS | nothing | — |
| Java | JDK 17+ (`javac`, `java`) | [Temurin](https://adoptium.net) |
| C# | .NET SDK 8+ (`dotnet`) | [dotnet.microsoft.com](https://dotnet.microsoft.com) |
| Go | Go 1.21+ | [go.dev/dl](https://go.dev/dl) |
| Rust | rustup (`cargo`, `rustc`) | [rustup.rs](https://rustup.rs) |
| C / C++ | CMake 3.20+ and a compiler | [cmake.org](https://cmake.org) + GCC / Clang / MSVC |

A missing toolchain blocks only building and running that language. Generating,
validating and exporting still work.

## Dependencies of your projects

Master Code never downloads anything on its own. Adding a library from the
Libraries panel writes it to the manifest and nothing more; installing is an
explicit action that shows the exact command first.

The manifests are ordinary `requirements.txt` / `package.json` / `Cargo.toml` /
`pom.xml` / `go.mod` / `*.csproj` / `vcpkg.json` files, so you can install by
hand too.

## The command line

Everything the IDE does is also a `mcode` command — the IDE is a client of the
same core. You never need it, but it is there for scripting and CI.

```powershell
# PowerShell
function mcode { node "C:\path\to\Master Code\packages\cli\src\main.ts" @args }
```

```sh
# bash / zsh
alias mcode='node "/path/to/Master Code/packages/cli/src/main.ts"'
```

```sh
mcode new Greeter --template python/cli
cd Greeter
mcode gen
mcode grant env
mcode run -- Ada     # anything after `--` goes to the program
mcode test
mcode doctor         # the toolchain report, as text
```

`mcode --help` lists every command.

## Ports and environment

| Variable | Default | |
|---|---|---|
| `MASTERCODE_PORT` | `4488` | The launcher picks the next free port if this one is taken |
| `MASTERCODE_HOST` | `127.0.0.1` | Leave it. The server has no authentication — see [security.md](security.md) |
| `MASTERCODE_NODE` | — | Full path to `node.exe`, if the launcher cannot find it |

## Plugins

Drop a directory containing `plugin.ts` into either:

- `<install>/plugins/` — available to every project
- `<project>/plugins/` — travels with one project

The shipped example is `plugins/nodes/statistics/`. See [plugins.md](plugins.md),
which has an important note about how a plugin imports the core depending on
where it lives.

## Running the tests

```sh
node --test "tests/*.test.ts"
```

159 tests, no install required. Cases needing a toolchain skip themselves when it
is absent rather than failing.

## Type checking

Optional, and the only reason to install TypeScript:

```sh
npm install --no-save typescript@5.9 @types/node@22
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

TypeScript 5.9 or newer — `erasableSyntaxOnly` and
`rewriteRelativeImportExtensions` do not exist before it. The first of those is
what catches anything Node's type stripping would reject at load time:
parameter properties, `enum`, namespaces.

The tree checks clean, tests included. The one thing it cannot resolve is
`@anthropic-ai/sdk`, which is why [the AI provider](../packages/core/src/ai/anthropic.ts)
builds that specifier at runtime — the SDK is optional and intentionally absent
from `package.json`.

## Troubleshooting

**The launcher says Node is missing, but you have it** — it looks on `PATH`
first, then the usual install locations. Set `MASTERCODE_NODE` to the full path
of `node.exe` if yours lives somewhere unusual.

**The browser opens on the wrong page, or not at all** — the console window
prints the address. Open it yourself.

**`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`** — a parameter property, `enum` or
namespace has crept in. None of those are erasable. Run the type check above; it
reports them with a location.

**`Cannot find module '#core/…'`** — you are running a file from outside the
Master Code package. Subpath imports resolve from the nearest `package.json`. If
it is a plugin, see the import note in [plugins.md](plugins.md).

**Run refuses to start** — that is the capability gate. It names the capability
and the node that needs it. Grant it in the Project panel.

**A stale Master Code is holding the port** — the launcher ties the server to
its own lifetime with a Windows job object, so closing the window always stops
it, even if the launcher is killed outright. If you started the server by hand
instead, stop it by hand.
