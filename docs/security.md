# Security

What the sandbox actually enforces, and what it does not.

This page is deliberately blunt. A tool that generates and runs code invites the
assumption that it contains that code safely. Master Code contains it partially,
and being precise about which part is more useful than a reassuring summary.

## The strongest control is not a runtime one

Every node declares the capabilities it needs. The lowering pass records them on
the IR, and the sandbox compares them against the project's grants **before the
program is compiled, let alone executed**:

```
$ mcode run
error sandbox/capability-not-granted [node n_ms…]
  This program needs the "env" capability, which the project has not granted.
  Needed by 1 node.
  hint: Grant it in Project Settings, or with: mcode grant env
```

| Capability | Granted by default | Covers |
|---|---|---|
| `stdio` | yes | Console input and output |
| `time` | yes | Clock reads and sleeping |
| `random` | yes | Random numbers |
| `fs.read` | **no** | Reading files and directories |
| `fs.write` | **no** | Writing, appending, deleting, creating directories |
| `net` | **no** | HTTP requests going out |
| `net.listen` | **no** | Opening a port and accepting requests |
| `process` | **no** | Spawning processes |
| `env` | **no** | Environment variables and command-line arguments |

`net` and `net.listen` are deliberately separate. A program that can reach the
network is one thing; a program that opens a port on the host and runs a graph
for whoever connects to it is another, and a reviewer should be able to tell
which they are looking at without reading the graph. Granting one never grants
the other.

This is a whole-program gate, not a prompt per call. The user grants a capability
once, with the full list of nodes that will use it in front of them, rather than
being asked mid-run when refusing is expensive.

**Its limit:** it is derived from the graph. A Custom Code node declares its own
capabilities, and a graph author who declares none while writing `open(...)` in
the body gets no error — the declaration is a claim, not an analysis of the text.
It stops accidents and honest mistakes; it does not stop someone determined to
lie in a snippet they wrote themselves.

## Runtime controls

| Enforced | How |
|---|---|
| Process isolation | A separate child process, never `eval` in-process |
| Working directory | The process starts in the generated output directory |
| Wall-clock timeout | Default 20s, then the whole process **tree** is killed |
| Output cap | Default 1 MB captured; the rest is dropped with a marker |
| Environment allowlist | Only listed variables are passed; everything else is stripped |
| Heap ceiling | Where the runtime has a flag: `node --max-old-space-size`, `java -Xmx`, .NET GC limits |

| **Not enforced** | Why |
|---|---|
| Filesystem confinement | Setting the working directory is not a jail. A program granted `fs.write` can write anywhere the user can. |
| Network blocking | No packet filtering. The capability check refuses ungranted network *nodes*; it does not stop a socket opened from hand-written code. |
| CPU quota | Only the wall-clock timeout applies. |
| Syscall filtering | Would need seccomp, AppContainer or equivalent. |
| Memory ceiling on Python, Go, Rust, C, C++ | Those runtimes expose no flag for it. Reported as unenforced. |

Every run prints both lists:

```
[timeout 20000 ms, heap unlimited, output cap 1000 kB, cwd …/build/generated]
[not enforced: memory limit (512 MB): python has no flag for it; …]
[not enforced: network block: not enforced at the process level; …]
[not enforced: filesystem confinement to build, assets: the working directory is set, but paths outside it are still reachable]
```

The platform would rather tell you a limit is not in force than let you assume it
is.

## What this means in practice

**Fine.** Running code you wrote, in graphs you drew, on your own machine — the
normal case. The capability gate catches the accidental `file/write` you did not
mean to leave in.

**Not fine.** Running an untrusted project someone sent you, or building a
multi-tenant service on top of this. Neither is safe with the controls above.
Real confinement needs an OS-level boundary: a container, a VM, a seccomp or
AppContainer profile. Master Code cannot construct one from Node without native
modules, so it does not claim to.

If you need that, run the whole platform inside a container. Everything works
there, and the boundary is then a real one.

## Other trust boundaries

**Plugins run with full privileges.** There is no plugin sandbox. Installing one
is the same decision as installing an editor extension. The capability system
constrains generated *programs*, not the code that generates them.

**Dependencies are never fetched implicitly.** Browsing the catalogue, adding a
library and writing the manifest are offline operations. `mcode install` shows
the exact command and requires `--yes`. Nothing else in the platform invokes a
package manager.

**Registry search is opt-in.** `mcode libs` is offline unless you pass `--online`,
which queries the language's own index directly — no intermediary, no account, no
telemetry. There is no other outbound network traffic.

**The AI layer is optional and proposal-only.** No core path imports a provider.
With none configured every other feature works. When one is configured, every
capability returns a reviewable proposal; nothing is applied without acceptance.

**Path escapes are refused.** Generated paths derive from user-supplied file
paths, so `writeArtifacts` resolves every target against the project root and
refuses anything outside it.

**The IDE server binds to localhost** (`127.0.0.1:4488`) and has no
authentication. It exposes the filesystem operations the IDE needs, so do not
bind it to a public interface. Setting `MASTERCODE_HOST` is enough rope; the
default is not.

**The browser demo never runs user code on the site's origin.** Programs run in
workers with an opaque origin and previews in a sandboxed frame, so neither can
read the projects stored for the site; a run can change files only inside its own
directory. [docs/demo.md](demo.md#isolation) lists each guarantee and what it
does not cover.

**In the browser demo, declared dependencies are fetched when a program runs.**
This is the one exception to "never fetched implicitly": a browser has no install
step to confirm, so the packages in `requirements.txt` (micropip, from PyPI and
Pyodide's index) and the npm packages a module imports (jsDelivr) are downloaded
into that run's sandboxed interpreter. Nothing is installed on your machine.

## Reporting

This is a prototype, and the boundaries above are the intended ones. If you find
a way past a control this page claims *is* enforced — a path escape, a timeout
that does not kill the tree, a capability gate that can be bypassed from a graph
— that is a real bug and worth reporting. Behaviour this page already lists as
unenforced is a documented limitation, not a vulnerability.
