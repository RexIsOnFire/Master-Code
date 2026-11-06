# Master SOAR — Infrastructure Architecture

Three deployments of one codebase. The same modular monolith runs in all three;
what changes is how many processes there are and which machines they sit on.
Nothing below requires a rewrite to move from one to the next, and the reason is
stated at the end of each section.

---

## 0. The shape that makes all three possible

The application is one deployable artifact with hard internal seams:

```
                     master-soar (one artifact)
  +--------------------------------------------------------------+
  |  api          HTTP surface, auth, CSRF, rate limit, routing   |
  |  identity     users, sessions, MFA, RBAC                      |
  |  incidents    incidents, alerts, cases, timeline              |
  |  playbooks    definition, versioning, validation, engine      |
  |  execution    queue client, worker loop, sandbox launcher     |
  |  commands     registry, SDK contract, HTTP command builder    |
  |  integrations connector framework + vendor connectors         |
  |  intel        indicators, feeds, sightings, MITRE             |
  |  ai           provider gateway, tool registry, AI actions     |
  |  approvals    policy evaluation, approval lifecycle           |
  |  audit        append-only, hash-chained event log             |
  |  secrets      provider interface, sealed local store          |
  |  storage      relational port + object-store port             |
  |  platform     config, ids, clock, errors, redaction           |
  +--------------------------------------------------------------+
```

Two rules hold the seams open:

1. **A module never imports a peer's internals.** It calls the peer's declared
   interface. `architecture.json` records that interface per module, and the file
   graph makes a violation a visible import edge rather than a code-review
   argument.
2. **Every crossing that will one day be a network hop is already a port with an
   adapter behind it** — the relational store, the object store, the job queue,
   the secrets provider, the AI provider, and the command executor. Phase 1 binds
   each to a local adapter. Phase 2 and 3 swap the adapter, not the caller.

The process boundary is chosen by a role flag, not by a build:

```
soar serve                     api + scheduler   (HTTP in)
soar worker --pool default     execution worker  (no HTTP in)
soar worker --pool sandbox     untrusted code    (no HTTP in, no vendor creds)
soar ingest                    listeners         (webhook / syslog / poller)
```

All four load the same modules. Which ones they start is configuration.

---

## 1. Local workstation deployment (Phase 1)

One machine. One `docker compose up -d`. No cloud account, no Kubernetes, no
Azure. This is the deployment the product must be good at first.

### Components

| Component | Count | Runtime | Why it exists |
|---|---|---|---|
| `soar-api` | 1 | python:3.12-slim | HTTP API, served UI, scheduler |
| `soar-worker` | 1 | python:3.12-slim | Commands, playbook steps, integrations |
| `soar-sandbox` | 1 | python:3.12-slim, hardened | Runs **untrusted** analyst code only |
| `postgres` | 1 | postgres:16-alpine | System of record |
| `redis` | 1 | redis:7-alpine | Job queue, locks, rate limits, pub/sub |
| `objects` | — | bind mount `./data/objects` | Evidence, attachments, reports |
| `ollama` | 0 or 1 | ollama/ollama | Optional local AI, profile `ai-local` |

Seven containers, two of them optional. `docker compose --profile ai-local up -d`
adds the model runner. Without it, the AI provider is whatever the user
configures; with nothing configured, AI features report "no provider" rather than
failing at an odd place later.

### Topology and ports

```
   host 127.0.0.1
        |
        |  8443/tcp  https  (self-signed on first boot)
        v
  +-----------------------------------------------------------+
  | docker network: soar_edge            (api only)           |
  |    soar-api :8443                                         |
  +-------+---------------------------------------------------+
          |
  +-------+---------------------------------------------------+
  | docker network: soar_core            (internal: true)     |
  |    postgres :5432        redis :6379                      |
  |    soar-api              soar-worker                      |
  +-------+---------------------------------------------------+
          |
  +-------+---------------------------------------------------+
  | docker network: soar_sandbox         (internal: true)     |
  |    soar-sandbox  -- redis only, no postgres, no egress    |
  +-----------------------------------------------------------+
```

| From | To | Port | Protocol | Notes |
|---|---|---|---|---|
| browser | soar-api | 8443 | HTTPS/1.1 | the only port published to the host |
| soar-api | postgres | 5432 | TCP, `sslmode=require` | role `soar_app` |
| soar-api | redis | 6379 | RESP, password | db 0 |
| soar-worker | postgres | 5432 | TCP | role `soar_worker` |
| soar-worker | redis | 6379 | RESP | consumer group |
| soar-worker | vendor APIs | 443 | HTTPS | egress allowlist |
| soar-sandbox | redis | 6379 | RESP | job in, result out, nothing else |
| soar-api | ollama | 11434 | HTTP | profile `ai-local` only |

`soar-sandbox` has no route to postgres and no default route off the sandbox
network. It receives a job and returns a result. That is the whole of its world.

### Trust boundaries

```
  (1) browser            -->  soar-api
      session cookie + CSRF token, or bearer token; every request re-authorised

  (2) soar-api           -->  postgres
      least-privilege role; no DDL at run time

  (3) soar-api           -->  soar-worker
      via redis; a job is data, never a callable

  (4) soar-worker        -->  soar-sandbox
      the sharpest boundary in the product: analyst code lives past it

  (5) soar-worker        -->  vendor APIs
      credentials leased per job, egress allowlisted

  (6) inbound webhook    -->  soar-api
      signature-verified, replay-windowed, never trusted as an identity
```

Boundary (4) is why the sandbox is a separate container even on one laptop.
Putting it in-process would be the single decision that makes the rest of the
security work pointless.

### Secrets

- One root key. Sourced, in order: `SOAR_ROOT_KEY` env, then
  `./data/keys/root.key` (mode 0600, generated on first boot), then refuse to
  start. There is no third fallback and no "insecure default" mode.
- Every credential is sealed with AES-256-GCM under a per-credential data key,
  which is itself wrapped by the root key. The database stores ciphertext, nonce,
  wrapped key and a version. It never stores plaintext.
- A worker receives a **lease**: the plaintext of exactly the credentials the
  command's declared `auth` block names, for the life of one job, in memory, via
  the job payload's sealed envelope. Never in an environment variable that
  `/proc` would expose to a sibling process, never on disk.
- Rendering is secret-aware: a value marked sensitive carries that marking
  through templating, and the log and audit writers redact by marking rather than
  by scanning output for things that look like keys.

### Database

PostgreSQL 16, one database, three roles:

| Role | Grants | Used by |
|---|---|---|
| `soar_migrate` | DDL | the migration job, at deploy time only |
| `soar_app` | CRUD on app tables; `INSERT` only on `audit_event` | api |
| `soar_worker` | CRUD on execution tables; `INSERT` only on `audit_event` | worker |

`audit_event` is insert-only for every runtime role. No application role can
`UPDATE` or `DELETE` it. Tamper-evidence comes from a hash chain, described in
[execution-model.md](execution-model.md).

### Queue

Redis Streams, not a list. Consumer groups give at-least-once delivery with
explicit acknowledgement and a pending-entries list, which is what lets a worker
crash mid-step without losing the step.

```
jobs:default      ordinary commands and integrations
jobs:sandbox      untrusted custom code
jobs:ai           AI provider calls, with their own concurrency budget
events:execution  step transitions, for the live execution console (pub/sub)
```

Idempotency lives on the job, not the queue: every job carries
`(execution_id, step_id, attempt)` and the step transition is a conditional
update, so a redelivery cannot run a containment action twice.

### Workers

Two pools on one machine: `default` (concurrency 2) and `sandbox` (concurrency
1). A worker is a loop — claim, lease credentials, execute under limits, write
the result, acknowledge. It holds no state that a restart cannot rebuild from
Postgres.

### AI

The `ai` module talks to a provider interface. Phase 1 adapters: Ollama (local),
OpenAI-compatible, Anthropic, Azure OpenAI. The role-to-model mapping is
configuration:

```
fast           -> llama3.1:8b        (local)
investigation  -> claude-sonnet-5    (if a key is configured)
reasoning      -> claude-opus-5
embedding      -> nomic-embed-text   (local)
```

With only Ollama present the platform is fully functional and no SOC data leaves
the machine. That is the point of making local the default rather than the
fallback.

### Storage

An object-store port with a filesystem adapter over `./data/objects`, content
addressed by SHA-256 under a tenant and kind prefix. No module builds a
filesystem path; modules ask the port for a key. That is what makes S3 and Blob a
configuration change.

### Backups

`docker compose run --rm backup` writes to `./backups/<timestamp>/`:

- `pg_dump -Fc` of the database
- a tar of `./data/objects`
- the sealed key file
- `config-export.json` (integrations, playbooks, commands) taken through the API,
  so the export is portable rather than a schema snapshot

Restore is the reverse, and the restore script refuses to run against a non-empty
database without `--force`.

### Monitoring

`/healthz` (liveness), `/readyz` (database, redis, migration state), `/metrics`
(Prometheus text format). Structured JSON logs to stdout with a correlation id
that follows a request into its execution and its steps. There is no Prometheus
container in Phase 1 — the endpoint exists so that adding one later is a scrape
config and nothing else.

### Authentication

Local accounts with Argon2id, TOTP MFA (mandatory for any role holding a
`response.*` or `secrets.*` permission), server-side sessions in Redis with
rotation on privilege change, cookies marked `SameSite=Lax`, `Secure` and
`HttpOnly`, and a double-submit CSRF token for cookie-authenticated mutations.
API tokens are separate objects with their own scopes and expiry — never a user's
password.

### Scaling strategy

Vertical only. Raise worker concurrency, raise Postgres shared buffers. When one
machine stops being enough, nothing about the application changes: the compose
file becomes three compose files on three hosts.

---

## 2. Small SOC deployment (Phase 2) — 2 to 5 VMs

The same containers, spread out, with a proxy in front, and the sandbox moved to
its own host because that is the boundary worth spending a VM on.

```
                       SOC MANAGEMENT VLAN (10.10.0.0/24)
                                    |
                            analyst workstations
                                    |  443/tcp
                    +---------------v----------------+
                    |  VM1  reverse proxy            |
                    |  nginx / Traefik, TLS term.,   |
                    |  WAF rules, mTLS to app        |
                    +---------------+----------------+
                                    |  8443 mTLS
         APP VLAN (10.20.0.0/24)    |
                    +---------------v----------------+
                    |  VM2  soar-api x2 (systemd)    |
                    |       scheduler (leader-elect) |
                    +------+------------------+------+
                           |  5432            |  6379
         DATA VLAN (10.30.0.0/24)             |
              +------------v------+  +--------v---------+
              | VM3 postgres 16   |  | VM3 redis 7      |
              | + WAL archiving   |  | AOF everysec     |
              | + MinIO (objects) |  |                  |
              +-------------------+  +--------+---------+
                                              |  6379
         EXECUTION VLAN (10.40.0.0/24)        |
              +-------------------------------v--------+
              | VM4  soar-worker x4   (pool: default)  |
              |      egress via forward proxy only     |
              +-------------------------------+--------+
                                              |
         SANDBOX VLAN (10.50.0.0/24)          |
              +-------------------------------v--------+
              | VM5  soar-sandbox x2  (pool: sandbox)  |
              |      gVisor / Firecracker, NO egress,  |
              |      redis only, no vendor credentials |
              +----------------------------------------+

         AI: gateway co-located on VM2, reaching either a local Ollama on a
             GPU host or Azure OpenAI through the forward proxy.
```

### Ports and protocols

| From | To | Port | Protocol | Auth |
|---|---|---|---|---|
| analyst | VM1 | 443 | HTTPS | session + MFA |
| VM1 | VM2 | 8443 | HTTPS, mTLS | client certificate |
| VM2 | VM3 | 5432 | TCP, TLS required | scram-sha-256, per role |
| VM2, VM4 | VM3 | 6379 | RESP, TLS | Redis ACL user per pool |
| VM4 | VM3 (MinIO) | 9000 | HTTPS | scoped access key |
| VM4 | forward proxy | 3128 | HTTP CONNECT | allowlist by FQDN |
| forward proxy | vendor | 443 | HTTPS | — |
| VM5 | VM3 (redis) | 6379 | RESP, TLS | ACL user `sandbox`, `jobs:sandbox` only |
| SIEM / EDR | VM1 | 443 | HTTPS webhook | HMAC signature + source allowlist |
| syslog sources | VM4 | 6514 | syslog over TLS | mutual TLS |

### Trust boundaries — what changed

Every boundary from Phase 1 becomes a network boundary as well as a process one.
Two are new:

- The reverse proxy terminates analyst TLS and re-originates mTLS, so the
  application never owns an internet-facing socket.
- The forward proxy is the only path to a vendor API, which turns "which
  integrations can reach the internet" from a code property into a firewall rule
  an auditor can read.

The sandbox VLAN has **no default route**. Not a restrictive one — none.

### Secrets

The root key moves to the OS keystore, or to an HSM-backed file on VM2 and VM4
delivered by the configuration manager. It is never in an image. Credential
leasing is unchanged: the same `SecretProvider` interface, now with a Vault or
Key Vault adapter if the SOC already runs one.

### Database, queue, storage

Postgres on VM3 with streaming replication to a standby (asynchronous is enough
at this size) and WAL archiving to MinIO. Redis with AOF `everysec` and a
replica. MinIO in single-node erasure mode. All three keep the connection-string
shape the Phase 1 adapters already use.

### Backups

`pg_basebackup` nightly plus continuous WAL to MinIO; MinIO bucket replication to
a second site or to tape; Redis AOF snapshot hourly. The queue is recoverable
state, not a system of record — losing it costs in-flight jobs, which the
execution table can re-drive. Restore is rehearsed quarterly and the runbook
lives beside this document.

### Monitoring

Prometheus scrapes `/metrics` on VM2, VM4 and VM5. Loki or the SOC's own SIEM
ingests the JSON logs. The SOAR's audit stream is forwarded to the SIEM as well,
because a SOAR that only audits into itself is a SOAR an attacker has to
compromise exactly once.

### Scaling strategy

Add worker VMs. Add an api VM behind the proxy. Neither needs a code change: a
worker is stateless, and the api holds sessions in Redis rather than in memory.

### Why no rewrite was needed

The ports were already ports. `DATABASE_URL`, `REDIS_URL`, `OBJECT_STORE_URL`,
`SECRETS_PROVIDER`, `AI_PROVIDER` and `EXECUTOR` moved from compose environment
to a configuration manager. The role flag that chose one container's job now
chooses one VM's job.

---

## 3. Enterprise deployment (Phase 3)

```
        +---------------- region A (primary) ------------------+
        |                                                      |
   users -> global LB -> WAF -> ingress ---> soar-api (HPA 3-20)
        |                          |                           |
        |                          +--> soar-scheduler (1, leader-elected)
        |                          +--> soar-ingest (HPA)
        |                          |                           |
        |        +-----------------+---------------+           |
        |        | worker pools: separate node     |           |
        |        | pools, separate service accounts|           |
        |        |   default    HPA on queue depth |           |
        |        |   vendor-a   credentials scoped |           |
        |        |   sandbox    gVisor nodes, taint|           |
        |        |   ai         GPU nodes          |           |
        |        +---------------------------------+           |
        |                                                      |
        |  Postgres: primary + 2 synchronous replicas (Patroni),|
        |            or Azure Database for PostgreSQL Flexible  |
        |  Redis:    cluster, 3 shards x 2 replicas, or         |
        |            Azure Cache; Service Bus / Kafka for jobs   |
        |  Objects:  S3 / Azure Blob, versioned, object lock     |
        |  Secrets:  Vault or Azure Key Vault, HSM-backed        |
        |  AI:       vLLM or Ollama on the GPU pool, plus        |
        |            Azure OpenAI for the reasoning role         |
        +----------------------+-------------------------------+
                               |  async replication, WAL shipping
        +----------------------v-------------------------------+
        |  region B (warm standby) — the same manifests,        |
        |  read-only until promotion. RPO <= 5 min, RTO <= 1 h. |
        +-------------------------------------------------------+
```

### What changes, precisely

| Concern | Phase 1 | Phase 3 | Code change |
|---|---|---|---|
| Relational | container postgres | Patroni or managed PG + PgBouncer | connection string |
| Queue | Redis Streams | Redis Cluster, or Service Bus / Kafka | one adapter class |
| Objects | bind mount | S3 / Blob with object lock | one adapter class |
| Secrets | sealed local file | Vault / Key Vault / HSM | one adapter class |
| Executor | local container | one k8s Job per untrusted run, gVisor runtime | one adapter class |
| AI | Ollama | GPU pool + Azure OpenAI, per-role routing | configuration |
| Identity | local + TOTP | Entra ID / Okta OIDC, SCIM provisioning | adapter + config |
| Tenancy | one organisation row | `org_id` enforced by row-level security | already in the schema |

Every row in the last column is an adapter behind an interface the Phase 1 code
already calls. That is the claim this architecture has to make good on, and it is
why the ports exist in the first release rather than being retrofitted.

### High availability and disaster recovery

- Postgres: synchronous replicas in-region, so no committed transaction is lost
  on a node failure; asynchronous across regions.
- Redis: cluster mode. The queue is replayable — the execution table is the
  system of record for what has and has not run.
- API and workers: stateless, with a `PodDisruptionBudget` and rolling updates.
- Scheduler: exactly one leader via a lease; a second instance stays warm.
- DR: region B runs the same manifests against replicated data; promotion is a
  documented, rehearsed runbook. Object lock on the audit bucket means a
  compromised administrator cannot erase the trail.

### Multi-tenancy

`org_id` on every tenant-scoped table from day one: `NOT NULL`, part of every
unique key, and enforced by PostgreSQL row-level security tied to a session
variable that the connection pool sets from the authenticated principal. Phase 1
creates exactly one organisation and never shows the concept in the UI. Nothing
about Phase 1 is complicated by it, and Phase 3 does not need a data migration.

### Network zones

```
  PUBLIC        LB / WAF
  MANAGEMENT    ingress, api, UI              <- analysts, SSO
  CONTROL       scheduler, ingest
  DATA          postgres, redis, object store, secret store
  EXECUTION     worker pools (egress via proxy, per-pool allowlists)
  SANDBOX       untrusted execution (no egress, no data-zone access)
  AI            model serving (no vendor credentials, no data-zone access)
  TOOLS         the SOC's own EDR / SIEM / identity systems (destination only)
```

Traffic is default-deny between zones with an explicit policy per arrow. SANDBOX
and AI are the two zones that are never a source into DATA.

---

## 4. Why the local deployment can become the large one

1. **One artifact, many roles.** There is no "local build" and "cloud build".
2. **Every future network hop is already an interface.** Six ports, six adapters,
   chosen by configuration at startup.
3. **State lives in Postgres and the object store, nowhere else.** Sessions and
   the queue live in Redis and are both rebuildable. No module keeps in-memory
   state that a second replica would contradict.
4. **The tenant column exists before there are tenants.**
5. **The sandbox is a separate process on day one.** The most expensive
   architectural property to add late is the one that costs least to keep from
   the start.

The honest limit: Phase 1 gives you no high availability, and does not pretend
otherwise. One Postgres, one Redis, one of each worker. What it gives you is the
shape that survives contact with the second machine.
