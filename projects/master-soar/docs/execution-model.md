# Master SOAR — Execution Model

How a playbook becomes work, how work becomes a process, and how the platform
stays honest about what happened. This is the part of the product that has to be
right before anything else matters.

---

## 1. The chain, end to end

```
  trigger            an alert rule, a schedule, an analyst, an API call, or
                     a parent playbook. Never an inbound webhook directly.
     |
     v
  admission          Is the playbook published? Does the trigger's condition
                     match? Is the principal permitted? Is this a duplicate
                     within the dedupe window? Is the rate limit clear?
     |
     v
  execution created  A row, immediately, with status=queued and the version
                     hash pinned. Nothing runs before it is recorded.
     |
     v
  scheduler loop     Walks the playbook graph, computes the frontier of
                     runnable nodes, writes execution_step rows, enqueues jobs.
     |
     v
  queue              Redis stream per pool. The job carries ids and a sealed
                     credential envelope; never a callable, never code.
     |
     v
  worker             Claims, verifies the job signature, leases credentials,
                     dispatches by node kind.
     |
     v
  executor           trusted  -> in-process, platform code only
                     verified -> worker subprocess, limits applied
                     untrusted-> sandbox container, no network, no creds
     |
     v
  result             Written to execution_step, published to events:execution,
                     variables merged, the scheduler is woken.
     |
     v
  next frontier      ...or terminal: succeeded / failed / cancelled / timed_out
```

The scheduler is a loop over durable state, not a long-lived object holding a
playbook in memory. That is what lets the api restart mid-execution without
losing it, and it is what lets a second api node exist later.

---

## 2. The playbook definition

A playbook version's `definition` is a directed graph, validated on save and
frozen on publish.

```jsonc
{
  "start": "n_start",
  "variables": [
    { "name": "risk_score", "type": "number", "scope": "execution", "initial": 0 }
  ],
  "nodes": {
    "n_start":    { "kind": "start", "next": "n_extract" },
    "n_extract":  { "kind": "command", "command": "ioc.extract",
                    "inputs": { "text": "{{ incident.alert.description }}" },
                    "output_var": "iocs",
                    "on_error": "n_notify", "retry": { "max": 2, "backoff": "exponential" },
                    "timeout_ms": 30000, "next": "n_loop" },
    "n_loop":     { "kind": "for_each", "items": "{{ iocs.indicators }}",
                    "as": "ioc", "body": "n_vt", "max_iterations": 200,
                    "next": "n_score" },
    "n_vt":       { "kind": "parallel", "branches": ["n_vt_a","n_vt_b"],
                    "join": "all", "next": null },
    "n_decide":   { "kind": "condition",
                    "when": [{ "if": "risk_score >= 70", "then": "n_approve" }],
                    "else": "n_close" },
    "n_approve":  { "kind": "approval", "action_key": "response.isolate",
                    "risk_level": "high", "timeout_s": 1800,
                    "on_approve": "n_isolate", "on_reject": "n_close",
                    "on_timeout": "n_escalate" },
    "n_isolate":  { "kind": "command", "command": "crowdstrike.isolate_host",
                    "integration": "crowdstrike_prod",
                    "inputs": { "host_id": "{{ host.agent_ids.crowdstrike }}" },
                    "compensation": "n_unisolate",
                    "on_error": "n_fallback", "next": "n_report" }
  }
}
```

### Node kinds

| Kind | What it does | Runs where |
|---|---|---|
| `start` / `end` | entry, terminal with an outcome | scheduler |
| `command` | invokes a command version | worker or sandbox |
| `condition` | typed expression over the variable scope | scheduler |
| `switch` | multi-way on one value | scheduler |
| `for_each` | bounded iteration, optional concurrency | scheduler |
| `while` | bounded by `max_iterations`, always | scheduler |
| `parallel` | fan out, join `all` / `any` / `n` | scheduler |
| `delay` | durable sleep — a scheduled wake, not a held thread | scheduler |
| `approval` | suspends until decided or timed out | scheduler |
| `http` | the no-code HTTP command, inline | worker |
| `script` | custom Python / JavaScript | sandbox |
| `ai` | one of the AI actions | ai pool |
| `transform` | pure data reshaping, no side effects | scheduler |
| `set_var` | assignment into a declared scope | scheduler |
| `sub_playbook` | invokes another published playbook | scheduler |
| `incident_update` | status, severity, assignment, tags | worker |
| `task` | creates a human task and optionally waits | scheduler |
| `notification` | email, chat, ticket comment | worker |

The scheduler-run kinds do no I/O and cannot be made to. That is why they are
allowed in the API process at all.

### Validation, on save and again before publish

Refused, not warned:

- a node id that is not reachable from `start`
- an edge to a node that does not exist
- a `while` or `for_each` with no bound
- a template path that does not resolve in the declared context
- a command that does not exist, is not published, or that the author lacks
  `commands.execute` for
- a sub-playbook cycle, at any depth
- an `approval` node whose `on_timeout` is `proceed` while `risk_level` is `high`
- a `compensation` target that is not idempotent-declared
- an input that does not satisfy the command's `input_schema`

Type checking is real: the command's `output_schema` types the variable it
writes, and the next node's `input_schema` is checked against it. A playbook that
would pass a string where a list is expected fails at publish, not at 03:00.

---

## 3. Variables and scopes

Four scopes, resolved innermost-first, with no implicit promotion:

| Scope | Lifetime | Writable by |
|---|---|---|
| `global` | organisation | administrators, at configuration time |
| `playbook` | one version | the playbook author (constants) |
| `execution` | one execution | any node in it |
| `step` | one node, including loop bodies (`ioc`, `index`) | the engine |

Reading is by path: `{{ incident.severity }}`, `{{ iocs.indicators[0].value }}`,
`{{ steps.n_vt.output.malicious_count }}`, `{{ host.agent_ids.crowdstrike }}`.

### The renderer is a path resolver, not an evaluator

`{{ path | filter | filter }}`, where `path` walks a plain data context and the
filter set is fixed: `default(x)`, `upper`, `lower`, `json`, `urlencode`,
`html`, `defang`, `refang`, `first`, `last`, `join(sep)`, `length`, `int`,
`float`, `bool`, `slice(a,b)`.

There is no expression language, no method call, no attribute access into a
runtime object. `{{ a.__class__ }}` resolves to nothing because `__class__` is
not a key. This is a deliberate reduction in power: template injection is the
cheapest remote code execution in every automation platform that chose an
expression evaluator instead.

Condition expressions are the one place an operator is needed, and they are
parsed into a typed AST with a fixed grammar:

```
  expr   := cmp (('and'|'or') cmp)*
  cmp    := path OP literal | path OP path | 'not' cmp | '(' expr ')'
  OP     := == != < <= > >= in not_in contains matches
```

`matches` takes a pre-compiled, length-bounded regular expression from the
playbook definition, never from data.

### Secret-aware rendering

A value resolved from a credential reference is a `SecretValue`. Rendering it
into a header or a body is allowed; rendering it into a log, an execution record,
an audit `before`/`after`, or an error message produces `***`. The marking
travels with the value through concatenation and JSON encoding. Redaction is by
type, so a credential in an unexpected place is still redacted — which pattern
matching cannot promise.

---

## 4. Command execution and trust levels

A command version declares, in machine-readable form:

```jsonc
{
  "key": "virustotal.ip_report",
  "kind": "http",
  "input_schema":  { "type": "object", "required": ["ip"],
                     "properties": { "ip": { "type": "string", "format": "ipv4" } } },
  "output_schema": { "type": "object",
                     "properties": { "malicious": { "type": "integer" },
                                     "verdict": { "enum": ["benign","suspicious","malicious","unknown"] } } },
  "auth": [{ "role": "api_key", "credential": "{{ integration.credential }}" }],
  "required_permissions": ["commands.execute", "intel.read"],
  "required_capabilities": ["net"],
  "risk_level": "low",
  "timeout_ms": 15000,
  "trust_level": "trusted"
}
```

Input is validated against `input_schema` **before** the job is enqueued; output
is validated against `output_schema` **before** it is written to a variable. A
command whose output does not match its schema fails the step. There is no
text-scraping contract anywhere.

### Trust levels

| Level | Who writes it | Where it runs | What it may do |
|---|---|---|---|
| `trusted` | the platform | in-process or default worker | everything the pool allows |
| `verified` | an engineer, reviewed and approved | default worker, subprocess, limits | declared capabilities only |
| `untrusted` | any author, unreviewed | sandbox container | compute only; no network, no credentials, no filesystem beyond tmpfs |

Promotion is an explicit, audited review action. It is never automatic and never
inferred from successful runs. The execution policy is configurable per
organisation, but two things are not configurable: `untrusted` never runs outside
the sandbox pool, and `untrusted` never receives a credential lease.

### Limits applied to a `verified` subprocess run

`RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_NPROC`, `RLIMIT_FSIZE`, `RLIMIT_NOFILE`;
wall-clock timeout with a process-tree kill; stdout/stderr byte cap with
truncation recorded rather than silently dropped; a scrubbed environment built
from an allowlist; `shell=False` argv launch; working directory a per-job tmpfs
that is unmounted after. The same limits apply in the sandbox container, plus the
container's own controls.

Every run records which limits were applied and which were not, on the step. A
platform that cannot enforce a CPU quota on a given host should say so on the
step rather than imply a guarantee.

---

## 5. Approvals

```
  playbook reaches an approval node
        |
        v
  policy engine: first matching policy by priority
        |
        +-- effect=allow             -> continue, audited as auto-approved
        +-- effect=deny              -> step fails with a policy reason
        +-- effect=require_approval  -> create approval, suspend execution
                                        |
                          notify the required role / team
                                        |
                +-----------------------+---------------------+
                |                       |                     |
            approved                rejected               timed out
                |                       |                     |
        on_approve branch        on_reject branch    on_timeout: reject |
                                                     escalate (never
                                                     proceed for HIGH)
```

A suspended execution holds no thread and no worker. It is a row with
`status=waiting_approval` and a scheduled wake at `expires_at`.

Policy matching is on: action key, risk level, incident severity, asset
criticality, environment, integration, playbook, initiator kind (analyst /
schedule / AI), and time of day. `separation_of_duty` forbids the requester from
being a decider. `required_approvals > 1` produces multiple decision rows and
waits for the count. Each decision carries a nonce bound to that request, so a
captured approval cannot be replayed at a later one.

---

## 6. Error handling

Failure is a first-class path, never a swallowed exception.

```
  step fails
     |
     +-- retryable? (network, 429, 5xx, timeout)  and attempts < max
     |        |
     |        v   exponential backoff with jitter, new attempt row
     |     retry
     |
     +-- on_error edge defined?  -> take it, with error in a step variable
     |
     +-- compensation defined for completed siblings?
     |        -> run compensations in reverse order, each idempotent
     |
     +-- otherwise -> execution fails, incident timeline records it,
                      platform alert raised, on-call notified per policy
```

Classification is explicit, not guessed from the message: a command declares
which error classes are retryable. A 401 is never retried — it is a credential
problem and retrying it locks the account.

Compensation is opt-in and declared: `n_isolate` names `n_unisolate`. The
platform does not invent rollbacks. A compensation that itself fails raises a
platform alert and is never retried into a loop.

`manual_intervention` is a terminal-but-resumable state: the execution parks, an
analyst sees exactly which step failed with input, output and logs, fixes the
cause, and resumes from that step or skips it — both audited.

Cancellation is cooperative and then forceful: the execution is marked
`cancelled`, in-flight jobs are signalled, and a job that does not stop within
its grace period has its process tree killed. Steps already completed are not
rolled back unless compensations are declared.

---

## 7. Idempotency and exactly-once, honestly

The queue gives at-least-once. The platform gives effectively-once for
side-effecting steps, by construction:

1. `(execution_id, node_id, attempt)` is the unique job key.
2. Claiming a step is a conditional update from `queued` to `running` with the
   worker id. A redelivery finds the row already `running` or terminal and
   acknowledges without acting.
3. Commands that talk to a vendor pass an idempotency key derived from the step
   id where the vendor supports one.
4. A worker that dies mid-step leaves the row `running` with a stale heartbeat; a
   reaper moves it to `failed` with `reason=worker_lost` after the lease expires,
   and the retry policy decides whether a new attempt is created. It does not
   silently re-run a containment action.

What that means in practice: a duplicate isolate is prevented by the row, not by
hoping the vendor is idempotent.

---

## 8. Dry run and simulation

Two distinct modes, because they answer different questions.

**Dry run** — "what would this playbook do with this real input?"
Every command is invoked through a shim: read-only commands run for real, and
side-effecting commands (declared `effect: mutating` in the command version)
return their declared `dry_run_example` from the schema instead of executing. The
execution record is marked `mode=dry_run`, steps are labelled, and nothing enters
the incident timeline as a response action. No credential lease is issued for a
mutating command in dry-run mode, which is what makes the guarantee structural
rather than behavioural.

**Simulation** — "does this playbook behave correctly?"
The playbook runs against a synthetic incident from a fixture: a canned alert,
canned entities, and recorded vendor responses. Every command is served from the
fixture. Assertions in the fixture check the outcome — which branch was taken,
what the final risk score was, which approvals were requested. A simulation run
is what `state=testing` means, and publishing can be configured to require a
passing simulation.

Both modes are the same engine. There is no separate test interpreter to drift.

---

## 9. Versioning and the publish workflow

```
  draft --------- validate ---------> testing
    ^                                    |
    |                              simulate / dry run
    |                                    |
    +--- edit (new draft) <------- fails |
                                         v  passes + review
                                    published  (immutable, hashed)
                                         |
                                    deprecated -> archived
```

- `published` versions are immutable and content-hashed.
- Only `published` versions can be reached by a trigger or a schedule.
- Editing a published version creates a new draft; the published one is
  untouched. A production playbook is never silently modified.
- Rollback is publishing an earlier version, recorded as its own publish event.
- Diff is structural — node added, input changed, branch retargeted — not a text
  diff of JSON.
- Executions store the version id and the hash, so the run is explicable after
  the playbook has moved on.

Commands follow the identical lifecycle, with the addition that a trust-level
change is its own reviewed, audited transition.

---

## 10. Execution monitoring

Every execution exposes, live:

```
  EXEC-2026-000123    Malware Containment v3    inc_01J9X…
  started 10:31:04    duration 1m 12s           status RUNNING
  trigger  alert_rule "CrowdStrike high severity"
  initiator system    pool default    mode live

  1  Extract IOCs            ok        180 ms
  2  VirusTotal lookup       ok        1.2 s
  3  CrowdStrike host        ok        640 ms
  4  AI analysis             RUNNING   4.1 s
  5  Risk decision           WAITING
  6  Approval: isolate       PENDING
  7  Isolate host            PENDING
```

Clicking a step shows its input, its output, its logs, its duration, the worker
that ran it, the command version, the error with its class, and the retry
history including earlier attempts. Steps stream over `events:execution`, so the
console updates without polling.

Anything an analyst can see there, the API returns; the console is a client of
the same endpoints.

---

## 11. Scheduling and fairness

One scheduler leader, elected by a Redis lease, doing three things on a tick:

1. advance executions whose frontier changed (woken by result events, not polled)
2. fire due triggers and scheduled queries
3. expire approvals, reap lost workers, roll up metrics

Fairness matters when one noisy alert rule generates a thousand executions:
per-org and per-playbook concurrency caps, weighted round-robin across
playbooks when the queue is deep, and a separate stream for interactive work
(an analyst clicking "run") so a bulk backfill never delays a person.

---

## 12. What the engine will not do

- It will not run an unpublished playbook from a trigger.
- It will not execute untrusted code outside the sandbox pool.
- It will not proceed past a HIGH-risk action on an approval timeout.
- It will not retry a 401, a 403, or a schema-validation failure.
- It will not invent a rollback that the playbook did not declare.
- It will not silently truncate output, swallow an error, or mark a step
  succeeded when its output failed schema validation.
