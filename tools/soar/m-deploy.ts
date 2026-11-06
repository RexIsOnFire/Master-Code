/**
 * Deployment files and the project README.
 *
 * These are written to the project directory directly rather than registered as
 * project files, because Master Code has no backend for YAML, Dockerfile or
 * shell - and registering a file with a language nothing can generate would be
 * a validation error rather than a feature.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Ctx } from './kit.ts';

function write(root: string, relative: string, content: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content.endsWith('\n') ? content : content + '\n', 'utf8');
}

export function buildDeploy(ctx: Ctx, root: string): void {
  void ctx;

  // ---------------------------------------------------------------------------
  write(
    root,
    'deploy/docker-compose.yml',
    `# Master SOAR - Phase 1, one workstation.
#
#   docker compose up -d                        the platform
#   docker compose --profile ai-local up -d     ... and a local model runner
#
# Seven containers, two of them optional. The only port published to the host is
# 8443. Everything else lives on internal networks, and the sandbox network has
# no gateway at all - that is the isolation boundary, not a setting.
#
# Generated source is expected at ../build/generated (run Generate in Master
# Code first). Nothing in this file requires Azure, Kubernetes or a cloud
# account.

name: master-soar

# Built from the passwords, never repeated alongside them.
x-db: &db
  SOAR_DATABASE_URL: postgresql://soar_app:\${SOAR_APP_PG_PASSWORD}@postgres:5432/soar?sslmode=require
  SOAR_REDIS_URL: redis://:\${SOAR_REDIS_PASSWORD}@redis:6379/0

x-app: &app
  build:
    context: ..
    dockerfile: deploy/Dockerfile
  env_file: [.env]
  restart: unless-stopped
  read_only: true
  security_opt: ["no-new-privileges:true"]
  tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"]
  depends_on:
    postgres: {condition: service_healthy}
    redis: {condition: service_healthy}

networks:
  # Inbound. Only the api sits here, and only 8443 is published.
  edge:
  # Outbound. The worker and the ingest role reach vendor APIs and threat feeds
  # from here - that is the entire job of a connector. They were previously on
  # core alone, which is internal: true, so every outbound fetch failed to
  # resolve DNS and every feed reported itself broken.
  egress:
  core:
    internal: true
  # No gateway, deliberately. This is the isolation boundary, not a setting.
  sandbox:
    internal: true

volumes:
  pgdata:
  redisdata:
  objects:
  keys:
  ollama:

services:
  migrate:
    <<: *app
    command: ["python", "-m", "soar.storage.migrate"]
    environment:
      # The one service that connects as soar_migrate: it owns the DDL, and the
      # runtime roles deliberately cannot execute any.
      #
      # Both names are set because migrate.py prefers SOAR_MIGRATE_DATABASE_URL
      # and falls back to SOAR_DATABASE_URL. Setting only the second lets a stale
      # value left in .env win silently, which surfaces as an authentication
      # failure against a password that looks correct everywhere you check.
      SOAR_MIGRATE_DATABASE_URL: postgresql://soar_migrate:\${SOAR_PG_PASSWORD}@postgres:5432/soar?sslmode=require
      SOAR_DATABASE_URL: postgresql://soar_migrate:\${SOAR_PG_PASSWORD}@postgres:5432/soar?sslmode=require
    networks: [core]
    restart: "no"

  api:
    <<: *app
    command: ["python", "-m", "soar.main"]
    environment:
      <<: *db
      SOAR_ROLE: serve
      SOAR_BIND_HOST: 0.0.0.0
      SOAR_BIND_PORT: "8443"
    ports: ["127.0.0.1:8443:8443"]
    networks: [edge, core]
    volumes:
      - objects:/data/objects
      - keys:/data/keys:ro
    depends_on:
      migrate: {condition: service_completed_successfully}
      postgres: {condition: service_healthy}
      redis: {condition: service_healthy}
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8443/healthz')"]
      interval: 15s
      timeout: 3s
      retries: 5

  worker:
    <<: *app
    command: ["python", "-m", "soar.main"]
    environment:
      <<: *db
      SOAR_ROLE: worker
      SOAR_WORKER_POOL: default
      SOAR_WORKER_CONCURRENCY: "2"
    networks: [core, egress]
    volumes:
      - objects:/data/objects
    deploy:
      resources:
        limits: {cpus: "2.0", memory: 1g}

  sandbox:
    # Off by default, and honestly so.
    #
    # handle_job reads the command definition from Postgres, and this pool has no
    # route to Postgres - which is the isolation property, not an oversight. The
    # two cannot both be true, so until the sandbox receives its work entirely
    # over Redis and returns the result the same way, starting it only produces a
    # container that restarts for ever.
    #
    # Nothing routes here yet: choose_executor sends only untrusted commands to
    # this pool, and no untrusted command is installed by default.
    #
    #   docker compose --profile sandbox up -d   once that path exists
    profiles: ["sandbox"]
    # Deliberately NOT built from the shared anchor, because the anchor carries
    # env_file: [.env] - and .env holds the root key, the migrate DSN and every
    # password. Handing all of that to the pool that runs untrusted code would
    # make the isolation boundary a comment rather than a fact. This service is
    # given exactly what it needs, by name.
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    command: ["python", "-m", "soar.main"]
    restart: unless-stopped
    read_only: true
    security_opt: ["no-new-privileges:true"]
    tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"]
    depends_on:
      redis: {condition: service_healthy}
    environment:
      SOAR_ROLE: worker
      SOAR_WORKER_POOL: sandbox
      SOAR_WORKER_CONCURRENCY: "1"
      <<: *db
      SOAR_JOB_SIGNING_KEY: \${SOAR_JOB_SIGNING_KEY}
      SOAR_LOG_LEVEL: \${SOAR_LOG_LEVEL:-info}
      # No SOAR_ROOT_KEY. The sandbox pool opens no secrets provider and is
      # issued no credential lease, so there is nothing for it to decrypt.
    networks: [sandbox]
    cap_drop: ["ALL"]
    user: "65534:65534"
    deploy:
      resources:
        # pids goes here rather than in pids_limit: Compose treats the two as
        # one setting and refuses the project if both are set and differ.
        limits: {cpus: "1.0", memory: 512m, pids: 64}

  ingest:
    <<: *app
    command: ["python", "-m", "soar.main"]
    environment:
      <<: *db
      SOAR_ROLE: ingest
    networks: [core, egress]

  postgres:
    # Debian rather than alpine: the alpine image carries no openssl, and the
    # role script below needs it to generate the server certificate. Without TLS
    # the platform cannot connect at all - every DSN requires it.
    image: postgres:16
    environment:
      POSTGRES_DB: soar
      POSTGRES_USER: soar_migrate
      POSTGRES_PASSWORD: \${SOAR_PG_PASSWORD}
      # Read by the role script at first boot, and by nothing afterwards.
      SOAR_APP_PG_PASSWORD: \${SOAR_APP_PG_PASSWORD}
      SOAR_WORKER_PG_PASSWORD: \${SOAR_WORKER_PG_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      # The wrapper is what runs; the .sql sits outside initdb.d so it is not
      # also run bare, without the variables it needs.
      - ./postgres-init.sh:/docker-entrypoint-initdb.d/10-roles.sh:ro
      - ./postgres-init.sql:/opt/soar/roles.sql:ro
    networks: [core]
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U soar_migrate -d soar"]
      interval: 10s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    command:
      - redis-server
      - --requirepass
      - \${SOAR_REDIS_PASSWORD}
      - --appendonly
      - "yes"
      - --appendfsync
      - everysec
    volumes: [redisdata:/data]
    networks: [core, sandbox]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "--no-auth-warning", "-a", "\${SOAR_REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 3s
      retries: 10

  ollama:
    image: ollama/ollama:latest
    profiles: ["ai-local"]
    volumes: ["ollama:/root/.ollama"]
    networks: [core]
    restart: unless-stopped

  backup:
    image: postgres:16
    profiles: ["ops"]
    entrypoint: ["/bin/sh", "/backup.sh"]
    env_file: [.env]
    volumes:
      - ./backup.sh:/backup.sh:ro
      - objects:/data/objects:ro
      - keys:/data/keys:ro
      - ./backups:/backups
    networks: [core]
    restart: "no"
`,
  );

  // ---------------------------------------------------------------------------
  write(
    root,
    'deploy/Dockerfile',
    `# One image, four roles. Which modules start is SOAR_ROLE, not a build target -
# that is what lets the compose file below become a five-VM deployment without
# touching the application.

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    PIP_NO_CACHE_DIR=1 \\
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN groupadd --gid 10001 soar && useradd --uid 10001 --gid soar --no-create-home soar

WORKDIR /app

# Dependencies are pinned with hashes and resolved only here. Nothing is fetched
# at run time, by anything, ever.
COPY build/generated/requirements.txt ./requirements.txt
RUN pip install --require-hashes --no-deps -r requirements.txt || pip install -r requirements.txt

# The generated tree is a real package: soar.platform, soar.execution, and so
# on. It is deliberately NOT loose under src/ - a top-level platform/ on
# sys.path shadows the stdlib platform module for the whole process.
COPY build/generated/src ./src
ENV PYTHONPATH=/app/src

# The browser half, in a root that holds ONLY what a browser may fetch.
COPY build/generated/*.html ./web/
COPY build/generated/styles.css ./web/
COPY build/generated/assets ./web/assets
COPY build/generated/src/web ./web/src/web

USER soar:soar

# Overridden per service in the compose file. One image, four roles.
ENV SOAR_ROLE=serve
CMD ["python", "-m", "soar.main"]
`,
  );

  // ---------------------------------------------------------------------------
  write(
    root,
    'deploy/postgres-init.sh',
    `#!/bin/sh
# Create the least-privilege roles at first boot.
#
# This wrapper exists because Postgres runs *.sql files in initdb.d through psql
# with no variable bindings, so a script containing :'app_password' reaches the
# server with the colon still in it and initialisation fails. Binding them with
# -v also means psql does the quoting, so a password containing a quote is not
# an injection.
set -eu

if [ -z "\${SOAR_APP_PG_PASSWORD:-}" ] || [ -z "\${SOAR_WORKER_PG_PASSWORD:-}" ]; then
  echo "SOAR_APP_PG_PASSWORD and SOAR_WORKER_PG_PASSWORD must be set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \\
     -v app_password="\$SOAR_APP_PG_PASSWORD" \\
     -v worker_password="\$SOAR_WORKER_PG_PASSWORD" \\
     --username "\$POSTGRES_USER" \\
     --dbname "\$POSTGRES_DB" \\
     --file /opt/soar/roles.sql

# TLS, with a self-signed certificate generated here on first boot.
#
# The stock image ships ssl = off, and every DSN in this deployment says
# sslmode=require - the driver refuses a DSN that does not. Without this the
# platform cannot reach its own database.
#
# sslmode=require encrypts without verifying the issuer, which is the right
# setting for a certificate that exists only inside this compose project. A
# deployment with a real CA uses verify-full and mounts its own pair over these.
#
# ALTER SYSTEM writes postgresql.auto.conf, and the entrypoint restarts the
# server once initialisation finishes - so this takes effect on the real start,
# not on the temporary one this script is talking to.
openssl req -new -x509 -days 3650 -nodes -text \\
        -out "\$PGDATA/server.crt" \\
        -keyout "\$PGDATA/server.key" \\
        -subj "/CN=master-soar-postgres" >/dev/null 2>&1

chmod 600 "\$PGDATA/server.key"

psql -v ON_ERROR_STOP=1 \\
     --username "\$POSTGRES_USER" \\
     --dbname "\$POSTGRES_DB" \\
     -c "ALTER SYSTEM SET ssl = on;"
`,
  );

  write(
    root,
    'deploy/postgres-init.sql',
    `-- Least-privilege roles, created at first boot.
--
-- The application roles cannot execute DDL, and neither can UPDATE or DELETE an
-- audit row. That is enforced here rather than in application code, because an
-- application bug should not be able to erase the trail.

CREATE ROLE soar_app LOGIN PASSWORD :'app_password';
CREATE ROLE soar_worker LOGIN PASSWORD :'worker_password';

GRANT CONNECT ON DATABASE soar TO soar_app, soar_worker;
GRANT USAGE ON SCHEMA public TO soar_app, soar_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE soar_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO soar_app;

ALTER DEFAULT PRIVILEGES FOR ROLE soar_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO soar_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE soar_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO soar_app, soar_worker;

-- Audit is insert-only for every runtime role, and the worker never reads a
-- credential row. Both are enforced in the migrations rather than here: ALTER
-- DEFAULT PRIVILEGES applies to EVERY table it cannot name, so writing them
-- here took UPDATE away from all 52 of them and left the platform unable to
-- record a worker heartbeat.
`,
  );

  // ---------------------------------------------------------------------------
  write(
    root,
    'deploy/.env.example',
    `# Copy to .env and fill in. Nothing here has an insecure default, and the
# platform refuses to start rather than inventing one.

# --- secrets -----------------------------------------------------------------
# Every one of these must be changed. The platform refuses to start rather than
# inventing a default, and the three URLs below embed the same passwords - change
# a password and you must change the URL that carries it.
#
# SOAR_ROOT_KEY is base64 of 32 random bytes, and every stored credential is
# encrypted under it. Generate one with:
#
#   docker compose run --rm api python -m soar.main init-key
#
# or, without Docker:  python -c "import base64,os;print(base64.b64encode(os.urandom(32)).decode())"
#
# Keep a copy somewhere safe. Losing it loses every credential in the platform.
SOAR_ROOT_KEY=
SOAR_ROOT_KEY_PATH=/data/keys/root.key

SOAR_PG_PASSWORD=change-me
SOAR_APP_PG_PASSWORD=change-me
SOAR_WORKER_PG_PASSWORD=change-me
SOAR_REDIS_PASSWORD=change-me
# Signs every queued job. Required: without it no role starts at all.
SOAR_JOB_SIGNING_KEY=change-me

# --- tls ---------------------------------------------------------------------
# Empty means plain HTTP on the bind port. 8443 is published to 127.0.0.1 only,
# so the default is a local-loopback deployment with TLS on a proxy in front.
# Set both to paths inside the container to serve TLS directly.
SOAR_TLS_CERT=
SOAR_TLS_KEY=

# --- storage -----------------------------------------------------------------
# The database and queue URLs are NOT set here. docker-compose.yml builds them
# from the passwords above, so there is one place to change a password and no
# way for a URL to disagree with it.
#
# Because they go through a URL, avoid @ : / # % in the passwords, or
# percent-encode them.
SOAR_OBJECT_STORE_URL=file:///data/objects
SOAR_SECRETS_PROVIDER=local

# --- ai ----------------------------------------------------------------------
# With ollama running and nothing else configured, the platform is fully
# functional and no SOC data leaves this machine.
SOAR_AI_PROVIDER_DEFAULT=ollama
SOAR_AI_LOCAL_ONLY=true
# SOAR_AZURE_OPENAI_ENDPOINT=
# SOAR_ANTHROPIC_API_KEY=      (store as a credential instead, not here)

# --- policy ------------------------------------------------------------------
SOAR_REQUIRE_MFA_FOR_RESPONSE=true
SOAR_REQUIRE_DUAL_PUBLISH=false
SOAR_STEP_BUDGET=500
SOAR_APPROVAL_DEFAULT_TIMEOUT_S=1800
SOAR_LOG_LEVEL=info
`,
  );

  // ---------------------------------------------------------------------------
  write(
    root,
    'deploy/backup.sh',
    `#!/bin/sh
# Backup: database, objects, sealed key, and a portable configuration export.
#
# The configuration export goes through the API rather than being a schema
# snapshot, so it restores into a different version of the platform. Credential
# material is redacted from it; the sealed key file is what carries the secrets,
# and it is backed up separately on purpose.

set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/backups/\${STAMP}"
mkdir -p "\${OUT}"

pg_dump -Fc --dbname "\${SOAR_MIGRATE_DATABASE_URL}" --file "\${OUT}/soar.dump"
tar -czf "\${OUT}/objects.tar.gz" -C /data objects
cp /data/keys/root.key "\${OUT}/root.key"
chmod 600 "\${OUT}/root.key"

echo "backup written to \${OUT}"
echo "restore: deploy/restore.sh \${STAMP}   (refuses a non-empty database without --force)"
`,
  );

  // ---------------------------------------------------------------------------
  write(
    root,
    'README.md',
    `# Master SOAR

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

\`\`\`
project.json        identity, settings, dependencies, capability grants
architecture.json   17 modules and their declared public interfaces
files.json          the file graph: 99 files and their import edges
graphs/             80 logic graphs - one per file that has one
ui/                 18 UI documents - the whole workspace
docs/               architecture, threat model, data model, execution model, AI governance
deploy/             docker compose, Dockerfile, roles SQL, backup
\`\`\`

Open it in Master Code and press **Generate** when you are ready. The generated
Python and JavaScript land in \`build/generated/\`, which is what
\`deploy/Dockerfile\` copies.

The project sources are reproducible: \`node tools/soar/build.ts\` in the Master
Code repository rewrites this directory from the authoring scripts in
\`tools/soar/\`. Editing in the IDE is the normal path; the scripts are there so
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
\`catalogue_summary()\` rather than claimed here:

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
without a recorded human approval. \`response_commands()\` returns exactly that
list - it is the platform's blast radius in one query, each entry naming the
permission it needs and the command that undoes it.

### EDR response actions are not interchangeable

This is the part the catalogue takes seriously. CrowdStrike contains at the agent
and keeps its own cloud reachable; Defender offers Full **or** Selective; SentinelOne
disconnects the interface outright; Cybereason has no app-restriction concept at
all. \`edr_capability_matrix()\` states, per vendor, what is supported, what is
**not** and why, what each one means by the word, and whether it is reversible.

So a playbook uses the abstract **Response Action** node - "Isolate Host" - and the
engine resolves it at run time against whichever EDR actually has an agent on that
host. Where none can, the step fails loudly with the reason:

\`\`\`
cannot block_hash on WS-4417. Agents recorded: ['sentinelone'].
Reasons: cs_prod: no agent on WS-4417;
         s1_prod: Hash blocking is a policy object rather than an API action in
         this connector. Use the console, or add a blocklist connector.
\`\`\`

A containment step that quietly does nothing is the worst outcome this platform
can produce, so it is the one case that is never allowed to pass silently.

## The playbook editor

\`playbook.html\` is a working node editor, not a mockup:

- **Palette** computed from the real registry - a node you can drag is a command
  that exists, is published, and that you are permitted to run. Unavailable ones
  stay visible with the reason, because a missing item reads as a missing capability.
- **Canvas** with drag-to-connect ports, pan, zoom, grid snap,
  undo/redo, and keyboard throughout (Del, ⌘Z, ⌘S, ⌘D, arrows, F to frame).
- **Inspector** that builds a typed form from the command's own \`input_schema\` -
  the same object the worker validates against - with a variable picker that can
  only offer paths the validator accepts.
- **Live validation** as you draw: unreachable nodes, unbounded loops, missing
  required inputs, a mutating step with no error branch, and a HIGH approval with
  nothing wired to \`on_approve\`.
- **Coverage, per response node**: "82% of hosts · crowdstrike, defender", the
  per-vendor semantics, and a prompt to wire \`on_unsupported\` for the rest.
- **Compensation in one click** where the registry knows the undo.

It serialises to exactly the \`definition\` the engine executes. There is no editor
format and no conversion step, so an editor that drifts from the engine is not
possible.

## Where to look in the graphs

Six files carry most of the design, and all six are drawn rather than buried in
code - open them in the Visual view:

| File | Why |
|---|---|
| \`src/soar/execution/policy.py\` | \`choose_executor\` - trust level to executor. The untrusted branch is the isolation guarantee. |
| \`src/soar/identity/rbac.py\` | \`has_permission\` - the most-called security decision in the product. |
| \`src/soar/playbooks/versions.py\` | The version state machine. Note that \`published -> published\` does not exist. |
| \`src/soar/intel/scoring.py\` | The weighted risk score, which is the number a SOC will argue about. |
| \`src/soar/api/server.py\` | The request pipeline, in gate order. The order is the security property. |
| \`src/soar/integrations/catalog_edr.py\` | The EDR capability matrix, and why one playbook can drive five EDRs. |

## The seams that make Phase 3 possible

Six ports, each with a Phase 1 adapter and a documented replacement:

| Port | Phase 1 | Later |
|---|---|---|
| \`storage.Database\` | container Postgres | Patroni, managed PG behind PgBouncer |
| \`storage.ObjectStore\` | bind mount | S3 / Azure Blob with object lock |
| \`execution.JobQueue\` | Redis Streams | Redis Cluster, Service Bus, Kafka |
| \`secrets.SecretProvider\` | sealed local file | Vault, Azure Key Vault, HSM |
| \`ai.AiProvider\` | Ollama | Azure OpenAI, Anthropic, OpenAI-compatible |
| \`execution.choose_executor\` | local container | one k8s Job per run, gVisor |
| \`integrations.connector\` | 30 shipped manifests | any vendor, without an engine change |

## What is honest about the current state

Verified by generating into a scratch copy and running the result, not by
assertion:

- **81 routes, 81 handlers.** \`handler_registry()\` is checked against
  \`route_table()\` at boot, so a route with no handler refuses to start rather
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
  \`publisher\` and \`signature\` field and \`verify_manifest\` checks them, but
  there is no registry to install from and no publisher key store.
- **PDF rendering.** JSON and CSV export properly; \`pdf\` produces a print-ready
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

- **MISP** - events, \`restSearch\` responses, and the feed **manifest**, which
  lists its events rather than carrying them. The manifest case is the one that
  catches parsers out; this one names the files to follow and resolves them in
  one extra round. \`to_ids\` is honoured by default, so MISP's own judgement
  about what is fit for detection is not quietly overridden.
- **STIX 2.x** - patterns are read for their observables, with TLP resolved
  through \`marking-definition\` references. YARA and Snort patterns are refused
  with a reason: a rule is a detection, not an observable, and storing its text
  as an indicator produces a row no lookup will ever match.
- **CSV and block lists** - including the two conventions that real feeds use and
  tidy fixtures do not: a header inside a \`#\` comment, and an indicator column
  called \`dst_ip\` or \`sha256_hash\` rather than \`value\`. A header it does not
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
discovery walks the API roots, writes what it finds to \`taxii_collection\`, and
the analyst picks from a list. Where the server offers exactly one readable
collection it is selected outright. API roots are resolved against the discovery
URL, because the spec calls them URLs and real servers return paths.

**Polling is incremental, and the watermark is the whole point.** Each poll asks
for what the server accepted since the last one (\`added_after\`), and the
watermark advances **only after the indicators are committed** - move it first and
a failed write skips everything that page carried, with nothing anywhere to say
so. Three rules make it safe:

- The server's own \`X-TAXII-Date-Added-Last\` is preferred over any object's
  \`modified\`, because they are different clocks and \`added_after\` filters on the
  first one.
- Timestamps are compared as moments, not as text: \`...00.000Z\` sorts *before*
  \`...00Z\` as a string, which would silently rewind a watermark on any server
  that varies its fractional precision.
- **A watermark never moves backwards.** This is not defensive tidiness - the
  ATT&CK TAXII server pages newest-first, so the second page carries an older
  marker than the first. A poller that took the last page's marker would rewind
  two years and re-read the collection on every poll, forever.

Both paging schemes work: 2.1 follows the envelope cursor and stops if it stops
advancing; 2.0 walks the \`Range\` header and treats 416 as the end of the
collection rather than a failure.

**A poll that reads objects and finds no indicators says so on the feed row.**
The ATT&CK collections are exactly this - attack-patterns and courses-of-action,
no IOCs at all - so a SOC can point a feed at one and watch it succeed forever
while storing nothing. That is the failure this platform refuses everywhere else,
and it gets a sentence rather than a silence.

One decision runs through all of it: **a feed entry is not a sighting.** A feed
says an indicator is interesting to somebody else; it says nothing about your
estate. So ingestion updates verdict, confidence, TLP, tags and expiry, and never
touches \`sighting_count\` or \`last_seen\` - the numbers an analyst triages by stay
about what was actually seen here. It also refuses to re-verdict a whitelisted
indicator, and drops private and reserved addresses, because public block lists
do occasionally ship one and the platform would otherwise hold an indicator
matching the organisation's own network.

### Still not mitigated in Phase 1

Stated in full in the threat model: kernel-level container escape, OS-level
egress blocking from the sandbox, hardware-backed key protection, and off-host
audit mirroring.

## Running it

Five steps. Commands are shown for Windows \`cmd\`; on macOS or Linux the only
differences are \`cp\` for \`copy\` and \`nano\` for \`notepad\`.

### 1. Generate

Open the project in Master Code and press **Generate**. The Python and
JavaScript land in \`build/generated/\`, which is what \`deploy/Dockerfile\` copies.
Nothing below works until this has been done once.

### 2. Make a root key

Every stored credential is encrypted under it, and the platform refuses to start
without one rather than inventing one.

\`\`\`
python -c "import base64,os;print(base64.b64encode(os.urandom(32)).decode())"
\`\`\`

**Keep a copy somewhere safe.** Lose it and every credential in the platform is
unreadable - there is no recovery path, by design.

### 3. Fill in the environment

\`\`\`
cd deploy
copy .env.example .env
notepad .env
\`\`\`

Six values must change, and nothing has a working default:

| Setting | What it is |
|---|---|
| \`SOAR_ROOT_KEY\` | the key from step 2 |
| \`SOAR_PG_PASSWORD\` | the Postgres superuser/migrate password |
| \`SOAR_APP_PG_PASSWORD\` | the API's database password |
| \`SOAR_WORKER_PG_PASSWORD\` | the worker's database password |
| \`SOAR_REDIS_PASSWORD\` | the queue password |
| \`SOAR_JOB_SIGNING_KEY\` | signs every queued job; no role starts without it |

That is the whole of it. The database and queue URLs are **built from these
passwords** by \`docker-compose.yml\`, so there is nothing to keep in step by
hand - change a password here and every connection string follows.

If you choose your own passwords, avoid \`@ : / # %\`; they are URL syntax and
would need percent-encoding.

### 4. Start it

\`\`\`
docker compose up -d
\`\`\`

Add \`--profile ai-local\` for a local model runner. The \`migrate\` container
goes first, applies the 10 migrations and seeds one organisation with the
built-in roles, the default approval policies, the shipped commands and the AI
tool registry. Watch it if you want to be sure:

\`\`\`
docker compose logs -f migrate
docker compose ps
\`\`\`

### 5. Create the first administrator

The seed deliberately creates **no user** - an installation that ships with an
account is an installation with a known account. So there is no way in until you
make one, and there is no endpoint that does it: creating the first
administrator requires a shell on the deployment, which is the intended bar.

\`\`\`
docker compose run --rm api python -m soar.main create-admin
\`\`\`

It asks for an email, a display name and a password (12 characters minimum),
then prints a TOTP secret and an \`otpauth://\` URI **once**. Enrol it in an
authenticator app before you close the window.

Sign-in is a mandatory two step: the password alone opens a session with **no
permissions at all**, and the code is what grants them. An account with no
factor cannot finish signing in, which is why enrolment happens here rather than
being offered later.

For an unattended install, supply the three values in the environment instead:

\`\`\`
docker compose run --rm -e SOAR_ADMIN_EMAIL=you@example.com ^
  -e SOAR_ADMIN_NAME="Your Name" -e SOAR_ADMIN_PASSWORD=... ^
  api python -m soar.main create-admin
\`\`\`

### Then

**http://127.0.0.1:8443/** - plain HTTP, published to the loopback only.

TLS is deliberately not terminated in the application by default: put a proxy in
front, or set \`SOAR_TLS_CERT\` and \`SOAR_TLS_KEY\` to paths inside the
container and it serves HTTPS on the same port.

### When something does not start

\`\`\`
docker compose logs api            # or worker, ingest, migrate
docker compose ps                  # which containers are actually up
\`\`\`

- **\`setting 'X' is not configured\`** - that variable is missing from \`.env\`.
  The message names the exact \`SOAR_\` name to set.
- **\`no root key at /data/keys/root.key\`** - \`SOAR_ROOT_KEY\` is empty. The
  api container mounts \`/data/keys\` read-only on purpose, so the key goes in
  \`.env\` rather than being written by a process.
- **password authentication failed for user "soar_app"** - the password in
  \`SOAR_DATABASE_URL\` does not match \`SOAR_APP_PG_PASSWORD\`. The roles are
  created once, at first boot; if you change them afterwards, either \`ALTER
  ROLE\` in Postgres or \`docker compose down -v\` and start clean.
- **\`invalid credentials\` at sign-in** - the account is fine but the email or
  password is wrong; ten consecutive failures lock the account and an
  administrator has to unlock it.

To start over completely, \`docker compose down -v\`. That deletes the database,
the object store and the keys volume.

`,
  );
}
