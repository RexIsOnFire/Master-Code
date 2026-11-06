# Master SOAR

An AI-native SOC orchestration platform, authored as a Master Code project.

A modular monolith that runs standalone on one workstation and separates onto
many machines without a rewrite. Analysts build automation without writing code,
engineers extend it with code, and the AI operates the same capabilities through
governed tools.

---

## Read this before you generate

This directory holds the **project sources** - the semantic model, not source
code. Nothing has been generated yet; that is deliberate, so you can read the
design first.

```
project.json        identity, settings, dependencies, capability grants
architecture.json   17 modules and their declared public interfaces
files.json          the file graph: 99 files and their import edges
graphs/             80 logic graphs - one per file that has one
ui/                 18 UI documents - the whole workspace
docs/               architecture, threat model, data model, execution model, AI governance
deploy/             docker compose, Dockerfile, roles SQL, backup
```

Open it in Master Code and press **Generate** when you are ready. The generated
Python and JavaScript land in `build/generated/`, which is what
`deploy/Dockerfile` copies.

The project sources are reproducible: `node tools/soar/build.ts` in the Master
Code repository rewrites this directory from the authoring scripts in
`tools/soar/`. Editing in the IDE is the normal path; the scripts are there so
the whole project can be regenerated and diffed.

## The documents, in the order the design was built

1. [docs/architecture.md](docs/architecture.md) - three deployments (one
   workstation, 2-5 VMs, enterprise), with components, zones, ports, protocols,
   trust boundaries, backups, monitoring and the scaling strategy for each, and
   what specifically changes between them.
2. [docs/threat-model.md](docs/threat-model.md) - STRIDE per boundary, then 21
   named threats with mitigations, then a plain list of what Phase 1 does **not**
   mitigate, then ten invariants the code must hold.
3. [docs/data-model.md](docs/data-model.md) - the entities, why observables are
   deduplicated globally and sightings are not, and what the model deliberately
   refuses to do.
4. [docs/execution-model.md](docs/execution-model.md) - how a playbook becomes
   work, trust levels, idempotency, dry run versus simulation, versioning, and
   what the engine will not do.
5. [docs/ai-governance.md](docs/ai-governance.md) - the tool registry, the
   intersection rule, risk classes, and the structural defences against prompt
   injection.

## The command library

118 prebuilt commands across 30 connectors, computed by
`catalogue_summary()` rather than claimed here:

| Capability | Connectors |
|---|---|
| **EDR** (containment) | CrowdStrike Falcon, Microsoft Defender for Endpoint, SentinelOne, Cortex XDR, Cybereason |
| **SIEM** (ingest, hunting) | Microsoft Sentinel, Splunk ES, IBM QRadar, Elastic Security |
| **Identity** | Entra ID, Okta, Active Directory |
| **Email** | Send Email (SMTP), Microsoft 365 Mail |
| **Network** | PAN-OS, FortiGate, Cisco Umbrella, Zscaler |
| **Ticketing / notify** | ServiceNow, Jira, Slack, Teams, PagerDuty |
| **Threat intel** | VirusTotal, AbuseIPDB, OTX, MISP, GreyNoise, urlscan.io, Shodan |

74 of those commands change something; 35 are HIGH risk and cannot execute
without a recorded human approval. `response_commands()` returns exactly that
list - it is the platform's blast radius in one query, each entry naming the
permission it needs and the command that undoes it.

### EDR response actions are not interchangeable

This is the part the catalogue takes seriously. CrowdStrike contains at the agent
and keeps its own cloud reachable; Defender offers Full **or** Selective; SentinelOne
disconnects the interface outright; Cybereason has no app-restriction concept at
all. `edr_capability_matrix()` states, per vendor, what is supported, what is
**not** and why, what each one means by the word, and whether it is reversible.

So a playbook uses the abstract **Response Action** node - "Isolate Host" - and the
engine resolves it at run time against whichever EDR actually has an agent on that
host. Where none can, the step fails loudly with the reason:

```
cannot block_hash on WS-4417. Agents recorded: ['sentinelone'].
Reasons: cs_prod: no agent on WS-4417;
         s1_prod: Hash blocking is a policy object rather than an API action in
         this connector. Use the console, or add a blocklist connector.
```

A containment step that quietly does nothing is the worst outcome this platform
can produce, so it is the one case that is never allowed to pass silently.

## The playbook editor

`playbook.html` is a working node editor, not a mockup:

- **Palette** computed from the real registry - a node you can drag is a command
  that exists, is published, and that you are permitted to run. Unavailable ones
  stay visible with the reason, because a missing item reads as a missing capability.
- **Canvas** with drag-to-connect ports, pan, zoom, grid snap,
  undo/redo, and keyboard throughout (Del, ⌘Z, ⌘S, ⌘D, arrows, F to frame).
- **Inspector** that builds a typed form from the command's own `input_schema` -
  the same object the worker validates against - with a variable picker that can
  only offer paths the validator accepts.
- **Live validation** as you draw: unreachable nodes, unbounded loops, missing
  required inputs, a mutating step with no error branch, and a HIGH approval with
  nothing wired to `on_approve`.
- **Coverage, per response node**: "82% of hosts · crowdstrike, defender", the
  per-vendor semantics, and a prompt to wire `on_unsupported` for the rest.
- **Compensation in one click** where the registry knows the undo.

It serialises to exactly the `definition` the engine executes. There is no editor
format and no conversion step, so an editor that drifts from the engine is not
possible.

## Where to look in the graphs

Six files carry most of the design, and all six are drawn rather than buried in
code - open them in the Visual view:

| File | Why |
|---|---|
| `src/soar/execution/policy.py` | `choose_executor` - trust level to executor. The untrusted branch is the isolation guarantee. |
| `src/soar/identity/rbac.py` | `has_permission` - the most-called security decision in the product. |
| `src/soar/playbooks/versions.py` | The version state machine. Note that `published -> published` does not exist. |
| `src/soar/intel/scoring.py` | The weighted risk score, which is the number a SOC will argue about. |
| `src/soar/api/server.py` | The request pipeline, in gate order. The order is the security property. |
| `src/soar/integrations/catalog_edr.py` | The EDR capability matrix, and why one playbook can drive five EDRs. |

## The seams that make Phase 3 possible

Six ports, each with a Phase 1 adapter and a documented replacement:

| Port | Phase 1 | Later |
|---|---|---|
| `storage.Database` | container Postgres | Patroni, managed PG behind PgBouncer |
| `storage.ObjectStore` | bind mount | S3 / Azure Blob with object lock |
| `execution.JobQueue` | Redis Streams | Redis Cluster, Service Bus, Kafka |
| `secrets.SecretProvider` | sealed local file | Vault, Azure Key Vault, HSM |
| `ai.AiProvider` | Ollama | Azure OpenAI, Anthropic, OpenAI-compatible |
| `execution.choose_executor` | local container | one k8s Job per run, gVisor |
| `integrations.connector` | 30 shipped manifests | any vendor, without an engine change |

## What is honest about the current state

Verified by generating into a scratch copy and running the result, not by
assertion:

- **81 routes, 81 handlers.** `handler_registry()` is checked against
  `route_table()` at boot, so a route with no handler refuses to start rather
  than returning a 500 the first time an analyst clicks it. That check found the
  one handler that was missing.
- **Zero functions called but never defined**, and zero defined and never
  referenced, across the whole tree.
- **52 tables**, 9 migrations, every table referenced by a query, and every
  column the code reads present after migration.
- **19 pages**, and every link in the navigation resolves.
- All generated Python byte-compiles; all browser JavaScript parses as ES
  modules; the generated tests pass.
- **The ingest paths were run against live sources, not only fixtures.** abuse.ch
  Feodo, URLhaus and MalwareBazaar parse to 13,914 indicators with nothing
  rejected; the CIRCL OSINT MISP feed resolves its 1,680-event manifest and
  parses 1,475 indicators from a sample of it with none malformed; the ATT&CK
  enterprise bundle loads all 858 of its techniques; and the live ATT&CK TAXII
  2.1 server discovers 109 collections across 45 API roots and polls them
  incrementally. Every one of those found a bug the fixtures had not.

The **graphs** express the platform's structure, contracts and the security
decisions. Bodies the visual vocabulary genuinely cannot express - crypto
primitives, the Postgres driver, subprocess limits, the ASGI adapter - are Custom
Code nodes, which generate real named Python functions rather than hiding
anything.

### Still not built

- **SSO / OIDC / SCIM.** Local accounts with Argon2id and TOTP only.
- **The content-pack registry and signing.** Connector manifests carry a
  `publisher` and `signature` field and `verify_manifest` checks them, but
  there is no registry to install from and no publisher key store.
- **PDF rendering.** JSON and CSV export properly; `pdf` produces a print-ready
  HTML document instead of bundling a headless browser.
- **Editor conveniences.** Selection is one node at a time: no rubber-band
  selection, no copy/paste between playbooks, no minimap.
- **Credential-aware connector health checks.** The probe establishes
  reachability - DNS, egress, TLS, the vendor answering - and not credential
  validity, because the shipped manifests do not yet declare auth headers. 401
  and 403 are recorded as reachable rather than failing.

## Threat intelligence in

Feeds and ATT&CK arrive the same way everything external does: the ingest role
decides what to fetch, a **worker** does the fetching, and the parse happens in a
process holding no database credentials. Every redirect hop is screened against
the resolved address, and the body is read against a hard ceiling, because a feed
is a stranger by definition.

- **MISP** - events, `restSearch` responses, and the feed **manifest**, which
  lists its events rather than carrying them. The manifest case is the one that
  catches parsers out; this one names the files to follow and resolves them in
  one extra round. `to_ids` is honoured by default, so MISP's own judgement
  about what is fit for detection is not quietly overridden.
- **STIX 2.x** - patterns are read for their observables, with TLP resolved
  through `marking-definition` references. YARA and Snort patterns are refused
  with a reason: a rule is a detection, not an observable, and storing its text
  as an indicator produces a row no lookup will ever match.
- **CSV and block lists** - including the two conventions that real feeds use and
  tidy fixtures do not: a header inside a `#` comment, and an indicator column
  called `dst_ip` or `sha256_hash` rather than `value`. A header it does not
  recognise falls through to classifying the cells, so the column where most
  values are observables is the indicator column whatever it is named. A document
  with no such column says so instead of returning nothing.
- **TAXII 2.0 and 2.1** - discovery, collections, and incremental polling. See
  below; it is the one that is a protocol rather than a file.
- **MITRE ATT&CK** - the STIX bundle, fetched or uploaded. Uploaded matters: a
  SOC platform with no egress is normal, not exceptional. A technique keeps
  **every** tactic it belongs to (195 of the 858 enterprise techniques are in more
  than one), and one absent from the bundle is left alone rather than revoked, so
  loading Enterprise onto a system that has Mobile does not silently empty half
  the matrix.

### TAXII, and the watermark

TAXII is the only one of these that is a conversation rather than a document, and
the parts that matter are the ones a fixture cannot teach you.

**Discovery is a separate, cached step.** A TAXII server names its collections by
uuid, and nobody can configure a feed against a uuid they have not been shown. So
discovery walks the API roots, writes what it finds to `taxii_collection`, and
the analyst picks from a list. Where the server offers exactly one readable
collection it is selected outright. API roots are resolved against the discovery
URL, because the spec calls them URLs and real servers return paths.

**Polling is incremental, and the watermark is the whole point.** Each poll asks
for what the server accepted since the last one (`added_after`), and the
watermark advances **only after the indicators are committed** - move it first and
a failed write skips everything that page carried, with nothing anywhere to say
so. Three rules make it safe:

- The server's own `X-TAXII-Date-Added-Last` is preferred over any object's
  `modified`, because they are different clocks and `added_after` filters on the
  first one.
- Timestamps are compared as moments, not as text: `...00.000Z` sorts *before*
  `...00Z` as a string, which would silently rewind a watermark on any server
  that varies its fractional precision.
- **A watermark never moves backwards.** This is not defensive tidiness - the
  ATT&CK TAXII server pages newest-first, so the second page carries an older
  marker than the first. A poller that took the last page's marker would rewind
  two years and re-read the collection on every poll, forever.

Both paging schemes work: 2.1 follows the envelope cursor and stops if it stops
advancing; 2.0 walks the `Range` header and treats 416 as the end of the
collection rather than a failure.

**A poll that reads objects and finds no indicators says so on the feed row.**
The ATT&CK collections are exactly this - attack-patterns and courses-of-action,
no IOCs at all - so a SOC can point a feed at one and watch it succeed forever
while storing nothing. That is the failure this platform refuses everywhere else,
and it gets a sentence rather than a silence.

One decision runs through all of it: **a feed entry is not a sighting.** A feed
says an indicator is interesting to somebody else; it says nothing about your
estate. So ingestion updates verdict, confidence, TLP, tags and expiry, and never
touches `sighting_count` or `last_seen` - the numbers an analyst triages by stay
about what was actually seen here. It also refuses to re-verdict a whitelisted
indicator, and drops private and reserved addresses, because public block lists
do occasionally ship one and the platform would otherwise hold an indicator
matching the organisation's own network.

### Still not mitigated in Phase 1

Stated in full in the threat model: kernel-level container escape, OS-level
egress blocking from the sandbox, hardware-backed key protection, and off-host
audit mirroring.

## Running it

Five steps. Commands are shown for Windows `cmd`; on macOS or Linux the only
differences are `cp` for `copy` and `nano` for `notepad`.

### 1. Generate

Open the project in Master Code and press **Generate**. The Python and
JavaScript land in `build/generated/`, which is what `deploy/Dockerfile` copies.
Nothing below works until this has been done once.

### 2. Make a root key

Every stored credential is encrypted under it, and the platform refuses to start
without one rather than inventing one.

```
python -c "import base64,os;print(base64.b64encode(os.urandom(32)).decode())"
```

**Keep a copy somewhere safe.** Lose it and every credential in the platform is
unreadable - there is no recovery path, by design.

### 3. Fill in the environment

```
cd deploy
copy .env.example .env
notepad .env
```

Six values must change, and nothing has a working default:

| Setting | What it is |
|---|---|
| `SOAR_ROOT_KEY` | the key from step 2 |
| `SOAR_PG_PASSWORD` | the Postgres superuser/migrate password |
| `SOAR_APP_PG_PASSWORD` | the API's database password |
| `SOAR_WORKER_PG_PASSWORD` | the worker's database password |
| `SOAR_REDIS_PASSWORD` | the queue password |
| `SOAR_JOB_SIGNING_KEY` | signs every queued job; no role starts without it |

That is the whole of it. The database and queue URLs are **built from these
passwords** by `docker-compose.yml`, so there is nothing to keep in step by
hand - change a password here and every connection string follows.

If you choose your own passwords, avoid `@ : / # %`; they are URL syntax and
would need percent-encoding.

### 4. Start it

```
docker compose up -d
```

Add `--profile ai-local` for a local model runner. The `migrate` container
goes first, applies the 10 migrations and seeds one organisation with the
built-in roles, the default approval policies, the shipped commands and the AI
tool registry. Watch it if you want to be sure:

```
docker compose logs -f migrate
docker compose ps
```

### 5. Create the first administrator

The seed deliberately creates **no user** - an installation that ships with an
account is an installation with a known account. So there is no way in until you
make one, and there is no endpoint that does it: creating the first
administrator requires a shell on the deployment, which is the intended bar.

```
docker compose run --rm api python -m soar.main create-admin
```

It asks for an email, a display name and a password (12 characters minimum),
then prints a TOTP secret and an `otpauth://` URI **once**. Enrol it in an
authenticator app before you close the window.

Sign-in is a mandatory two step: the password alone opens a session with **no
permissions at all**, and the code is what grants them. An account with no
factor cannot finish signing in, which is why enrolment happens here rather than
being offered later.

For an unattended install, supply the three values in the environment instead:

```
docker compose run --rm -e SOAR_ADMIN_EMAIL=you@example.com ^
  -e SOAR_ADMIN_NAME="Your Name" -e SOAR_ADMIN_PASSWORD=... ^
  api python -m soar.main create-admin
```

### Then

**http://127.0.0.1:8443/** - plain HTTP, published to the loopback only.

TLS is deliberately not terminated in the application by default: put a proxy in
front, or set `SOAR_TLS_CERT` and `SOAR_TLS_KEY` to paths inside the
container and it serves HTTPS on the same port.

### When something does not start

```
docker compose logs api            # or worker, ingest, migrate
docker compose ps                  # which containers are actually up
```

- **`setting 'X' is not configured`** - that variable is missing from `.env`.
  The message names the exact `SOAR_` name to set.
- **`no root key at /data/keys/root.key`** - `SOAR_ROOT_KEY` is empty. The
  api container mounts `/data/keys` read-only on purpose, so the key goes in
  `.env` rather than being written by a process.
- **password authentication failed for user "soar_app"** - the password in
  `SOAR_DATABASE_URL` does not match `SOAR_APP_PG_PASSWORD`. The roles are
  created once, at first boot; if you change them afterwards, either `ALTER
  ROLE` in Postgres or `docker compose down -v` and start clean.
- **`invalid credentials` at sign-in** - the account is fine but the email or
  password is wrong; ten consecutive failures lock the account and an
  administrator has to unlock it.

To start over completely, `docker compose down -v`. That deletes the database,
the object store and the keys volume.

