# Master SOAR — AI Orchestration and Governance

The AI is not a chat panel bolted to the side of the product. It is a principal
that can invoke the same governed capabilities an analyst can, through the same
permission checks, the same approval policies and the same audit log — and
strictly never more than the analyst who invoked it.

---

## 1. The layer

```
                        ANALYST  (or a playbook's ai node)
                              |
                       session opened
                              |
      +-----------------------v------------------------+
      |  AI ORCHESTRATOR                                |
      |  - builds the tool set for this turn            |
      |  - assembles context from the SOAR, not the web |
      |  - separates instructions from evidence         |
      |  - enforces budgets and loop detection          |
      +-----------------------+------------------------+
                              |
      +-----------------------v------------------------+
      |  TOOL REGISTRY                                  |
      |  name | description | schema | permission       |
      |  risk | approval | timeout | max calls          |
      +-----------------------+------------------------+
                              |
                    permission check (RBAC)
                              |
                    approval policy (if risk >= threshold)
                              |
      +-----------------------v------------------------+
      |  EXECUTION                                      |
      |  command | sub-playbook | typed query           |
      +-----------------------+------------------------+
                              |
                  result -> audit -> timeline -> turn
```

The model never reaches the operating system, never reaches a shell, never
reaches an arbitrary URL, and never reaches the database directly. Its entire
reach is the tool registry, and the registry is filtered before the model sees
anything.

---

## 2. The permission rule

At session start the orchestrator computes:

```
  session_tools = registry_enabled
                INTERSECT tools_whose_permission_is_held_by(invoking_principal)
                INTERSECT tool_set_configured_for(purpose)
```

Three properties follow, and they are the whole of the AI authorisation model:

1. **Intersection, never union.** The AI principal is a subset of the invoking
   analyst's permissions. There is no "AI service account" with its own
   privileges that an analyst could borrow.
2. **Computed before untrusted content is read.** The tool set for a turn is
   fixed before any incident text, alert body, email or vendor response enters
   the context. No injected instruction can add a tool, because the model does
   not choose the tools.
3. **Risk class belongs to the tool.** `crowdstrike.isolate_host` is HIGH
   whoever asks and however it is justified. An injected instruction cannot
   lower it; a persuasive rationale cannot lower it.

---

## 3. Tool definitions

Every tool in the registry carries all of this, and a tool missing any field is
not loadable:

```jsonc
{
  "name": "crowdstrike_get_host",
  "description": "Retrieve CrowdStrike endpoint detail for a host already linked to this incident.",
  "input_schema": {
    "type": "object", "required": ["host_id"], "additionalProperties": false,
    "properties": { "host_id": { "type": "string", "pattern": "^host_[0-9A-Z]{26}$" } }
  },
  "output_schema": { "$ref": "#/schemas/NormalisedHost" },
  "implementation": "command:crowdstrike.get_host",
  "risk_level": "low",
  "required_permission": "integrations.crowdstrike.read",
  "requires_approval": false,
  "timeout_ms": 15000,
  "max_calls_per_turn": 10,
  "scope": "incident"
}
```

`scope: "incident"` is doing real work: the argument must name an entity already
attached to the current incident. "Isolate every host" is not expressible,
because the schema takes one host id and the policy checks that it belongs to
this incident's entity set. Constraining the *shape* of an action is more
reliable than constraining the *intent* behind it.

---

## 4. Risk classes and what they require

| Class | Examples | Requirement |
|---|---|---|
| **LOW** | reputation lookup, WHOIS, passive DNS, IOC enrichment, incident search, summarisation, MITRE mapping | permission only; audited |
| **MEDIUM** | change alert status, add a note, create a task, update a ticket, send a notification, assign an incident | permission; approval if policy says so; audited with before/after |
| **HIGH** | isolate endpoint, block IP, disable account, revoke sessions, delete mail, change a firewall rule, run a mutating playbook | permission **and** a recorded human approval by a different principal; MFA step-up; audited with the AI session, the analyst, and the approver |

`requires_approval` on a HIGH tool cannot be turned off by configuration. The
approval *policy* can add requirements; it cannot remove the human.

---

## 5. Prompt injection: the structural defences

An alert description, an email body, a threat-intel note and a vendor response
are all attacker-influenceable. The design assumes they are hostile.

- **Channel separation.** Instructions come from the platform's system framing.
  Evidence arrives in a delimited data block, labelled by provenance
  (`source: alert alt_01J…, field: description, trust: untrusted`), with the
  standing instruction that content inside it is material to analyse and is never
  an instruction to follow.
- **No capability from content.** Tools are fixed before content is read (§2).
- **Schema-bounded arguments.** Every argument is validated against the schema and
  then against scope policy. Free-text arguments that reach a command are
  parameterised, never concatenated.
- **No generic fetch.** There is no `http_get` tool. Enrichment tools take an
  indicator; the connector decides the endpoint. Exfiltration through a tool
  argument has nowhere to go.
- **Budgets.** Per turn: a maximum tool-call count, a maximum token spend, a
  maximum wall-clock, and a repetition detector that stops a tool being called
  with the same arguments in a loop.
- **Injection flagging.** Content is screened for imperative patterns aimed at the
  assistant; a hit does not block the analysis — it annotates the turn and is
  shown to the analyst, because knowing the alert *contained* an injection attempt
  is itself intelligence.
- **Provenance in the output.** Every AI conclusion cites the fields it was drawn
  from, so an analyst can see that a recommendation rests on an
  attacker-controlled string.

The residual is stated plainly: injection can still degrade the *quality* of an
analysis and produce a wrong-but-legitimate LOW recommendation. It cannot gain
capability. That is the line the architecture defends.

---

## 6. AI playbook actions

Each is a node kind with a typed contract, not a free-text prompt:

| Action | Input | Output |
|---|---|---|
| `ai.analyze` | alert or incident | structured analysis: assessment, key findings, confidence, cited fields |
| `ai.classify` | incident | `{ classification, confidence, rationale }` over a fixed label set |
| `ai.extract` | email, log, alert text | `{ indicators: [{type, value, context}] }`, then normalised and deduplicated by the intel module |
| `ai.summarize` | incident with timeline | analyst-readable summary, with a length budget |
| `ai.investigate` | entity | investigation result built from tool calls, with the call trail attached |
| `ai.recommend` | incident state | ranked recommended actions, each naming a real playbook or command that exists |
| `ai.execute` | an already-approved action | execution result; refuses if the approval is missing, expired, or for a different action |
| `ai.generate_query` | natural language + target dialect | KQL / SPL / SQL / vendor query, validated by the dialect's parser before it is offered |
| `ai.generate_playbook` | objective | a **draft** playbook version |

Two rules hold across all of them:

- **Output is schema-validated.** A malformed AI response fails the step; it is
  never coerced into "close enough".
- **No hallucinated capability.** `ai.recommend` and `ai.generate_playbook` are
  constrained to the actual command and playbook registry, supplied as part of
  the request. A recommendation that names a command that does not exist is a
  validation failure, not something an analyst has to catch.

### Generated playbooks are always drafts

```
  AI generates  ->  version created as `draft`, authored_by = ai session
       |
  Human reviews ->  structural diff, every command resolved, permissions shown
       |
  Validate      ->  the same validator any playbook faces
       |
  Test          ->  simulation against fixtures
       |
  Approve       ->  reviewer recorded
       |
  Publish       ->  immutable, hashed, now reachable by triggers
```

There is no path from `ai.generate_playbook` to `published`. Not a discouraged
one — none. The state machine does not contain the transition.

---

## 7. Provider abstraction

```
  ai.gateway
      |
      +-- OllamaProvider          local, default, no data leaves the host
      +-- OpenAICompatibleProvider  vLLM, LM Studio, LocalAI, others
      +-- OpenAIProvider
      +-- AnthropicProvider
      +-- AzureOpenAIProvider     with Entra credentials
```

Roles, not vendors, appear in playbooks and tool configuration:

| Role | Used for | Local default |
|---|---|---|
| `fast` | extraction, classification, summarisation | `llama3.1:8b` |
| `investigation` | multi-step tool-using investigation | `llama3.1:70b` or a cloud model |
| `reasoning` | analysis, recommendations, playbook drafting | a cloud model if configured |
| `embedding` | similarity search over incidents and intel | `nomic-embed-text` |

A playbook node says `role: "fast"`. Changing which model serves that role is a
configuration change with no playbook edit, and it is audited.

**Data residency is a first-class setting.** An organisation can mark roles as
local-only, and a request that would route incident content to an external
provider is refused with a clear reason rather than downgraded silently. Which
provider served a turn is recorded on `ai_turn`, so "did this incident's data
leave the building" is answerable.

---

## 8. What the AI knows

Context is assembled from the platform, never from the model's memory:

- the incident: severity, status, timeline, entities, indicators, evidence index
- linked alerts, normalised
- the enrichment already gathered, with age
- the commands and playbooks that actually exist and that this principal may run
- the integrations configured and their health
- the organisation's policies relevant to the proposed action
- MITRE technique mappings already asserted

This is why "What can I do with this incident?" has a truthful answer: the tool
registry and the command registry are the answer, supplied as data. The model is
not asked to remember a product catalogue.

---

## 9. Human in the loop

```
  AI recommends  ->  analyst reviews (with provenance and the call trail)
                 ->  analyst approves (MFA step-up for HIGH)
                 ->  SOAR executes (as a normal execution, fully audited)
                 ->  result returns to the incident timeline
```

The timeline distinguishes actor kinds, so a reader can always tell a person
from the assistant:

```
  10:33  ai        AI analysis completed — likely malicious (confidence 0.82)
  10:34  ai        Requested approval: isolate host WS-4417 (HIGH)
  10:35  analyst   J. Rivera approved isolation — "confirmed beacon to known C2"
  10:35  playbook  Endpoint isolated via crowdstrike_prod (EXEC-2026-000123 / step 7)
```

And the audit record for that action carries: action, initiated-by (AI session),
on-behalf-of (the analyst who opened the session), authorisation (human
approval), approver, playbook, version hash, execution id, and result.

---

## 10. AI capability packs

The marketplace concept — Phishing Analyst, Malware Analyst, KQL Generator,
Detection Engineering Assistant, MITRE Mapping Assistant — is implemented as
**tool sets plus prompts plus schemas**, not as autonomous agents.

A pack declares the tools it needs, the risk classes it touches and the
permissions it requires. Installing one shows that declaration and requires
acceptance; the tools still pass through the same intersection at session start,
so a pack cannot grant itself anything. A pack that widens its declaration in a
new version requires re-acceptance.

---

## 11. AI-specific invariants

1. The AI principal's permissions are a subset of the invoking analyst's, always.
2. The tool set for a turn is computed before untrusted content is read.
3. A HIGH tool cannot execute without a recorded human approval by a different
   principal.
4. No tool accepts a raw URL, a raw query string against the database, or code.
5. Every tool call is audited with arguments, risk class, approval and result.
6. AI-generated playbooks and commands can only be created in `draft`.
7. Structured outputs are schema-validated; a malformed response fails the step.
8. Which provider and model served each turn is recorded and queryable.
9. An AI conclusion is a proposal until a human accepts it, and the acceptance is
   a stored fact, not a UI state.
