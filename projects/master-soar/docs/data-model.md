# Master SOAR — Data Model

The schema is the product's memory. It has to answer, a year later, "what
happened, who decided it, what did the machine know at the time, and what
exactly ran" — and it has to answer that after the incident is closed and the
playbook has been revised twice.

Three rules shape everything below.

1. **Tenant first.** Every tenant-scoped table carries `org_id NOT NULL` and it
   participates in every unique constraint. Phase 1 creates one organisation and
   never mentions it in the UI.
2. **Immutable history, mutable present.** Entities that people edit are mutable
   rows. Things that *happened* — executions, steps, approvals, audit events,
   published playbook versions — are append-only.
3. **Observables are deduplicated globally, sightings are not.** An IP address is
   one row. The forty times it appeared in alerts are forty sightings. Getting
   this the other way round is what makes threat-intel tables unusable at scale.

Identifiers are ULIDs rendered as `<prefix>_<26 chars>` (`inc_01J9...`), so they
sort by creation time, are safe in URLs, and reveal their type in a log line.

---

## 1. Entity map

```
                              ORGANISATION
                                   |
     +-----------+-----------+-----+------+-----------+------------+
     |           |           |            |           |            |
   USER        TEAM     INTEGRATION   CREDENTIAL   COMMAND     PLAYBOOK
     |           |           |            |           |            |
   ROLE      membership   CONNECTOR   (sealed)    COMMAND_      PLAYBOOK_
     |                        |                   VERSION       VERSION
 PERMISSION                   |                                    |
                              |                                    |
                         EVENT (raw)                         EXECUTION
                              |                                    |
                          ALERT  ------------------------>  EXECUTION_STEP
                              |                                    |
                          INCIDENT  <-------------------------  APPROVAL
                              |
   +--------+--------+--------+--------+--------+--------+--------+
   |        |        |        |        |        |        |        |
 CASE     TASK   TIMELINE  EVIDENCE  NOTE   INDICATOR  ENTITY  AI_SESSION
   |                                            |        |        |
 TASK                                       SIGHTING   HOST      AI_TURN
                                                |      IDENTITY    |
                                             FEED     IP/DOMAIN/  AI_TOOL_CALL
                                                      URL/HASH

  MITRE_TECHNIQUE  <---->  INCIDENT / PLAYBOOK / COMMAND   (many-to-many)
  AUDIT_EVENT      <----   everything                       (append-only)
```

---

## 2. Tenancy, identity and access

### `organisation`
`id`, `name`, `slug`, `settings jsonb`, `created_at`, `status`.
Row-level security key. One row in Phase 1.

### `user`
`id`, `org_id`, `email citext`, `display_name`, `password_hash` (Argon2id),
`mfa_secret` (sealed), `mfa_enrolled_at`, `status` (`active` / `disabled` /
`locked`), `last_login_at`, `failed_attempts`, `created_at`.
Unique `(org_id, email)`.

### `role` and `permission`
`role`: `id`, `org_id`, `name`, `description`, `builtin bool`.
`role_permission`: `(role_id, permission)` — permission is a text key from the
fixed vocabulary (`incidents.read`, `playbooks.publish`, `response.isolate`, …).
`user_role`: `(user_id, role_id, granted_by, granted_at)`.

Permissions are flat strings with no inheritance. A role is a set. This is
deliberately boring: the most common RBAC bug is a hierarchy nobody can evaluate
in their head.

### `team`
`id`, `org_id`, `name`, `shift`, `escalation_to team_id`.
`team_member`: `(team_id, user_id, role_in_team)`.

### `api_token`
`id`, `org_id`, `name`, `token_hash`, `scopes text[]`, `created_by`,
`expires_at`, `last_used_at`, `revoked_at`. Never a user's password; a distinct
principal with its own scope set.

### `session`
Lives in Redis, not Postgres: `id`, `user_id`, `org_id`, `created_at`,
`expires_at`, `fingerprint`, `mfa_satisfied_at`, `step_up_until`.
In Postgres only as an audit record of login and logout.

---

## 3. Events, alerts, incidents

### `event`
The raw thing that arrived, kept verbatim so a normalisation bug is recoverable.
`id`, `org_id`, `source_id`, `received_at`, `raw jsonb`, `raw_sha256`,
`content_type`, `signature_verified bool`, `dedupe_key`.
Partitioned monthly. `dedupe_key` unique per `(org_id, source_id, month)`.

### `alert`
The normalised form — the Common Security Event Model. Playbooks read this and
never `event.raw`.

`id`, `org_id`, `event_id`, `source` (vendor id), `vendor_alert_id`,
`title`, `description`, `severity` (`info|low|medium|high|critical`),
`confidence smallint`, `category`, `technique_ids text[]`,
`observed_at`, `ingested_at`, `status` (`new|triaged|merged|closed`),
`incident_id`, `entities jsonb`, `indicators jsonb`, `raw_severity`,
`normalisation_version`.
Unique `(org_id, source, vendor_alert_id)` — re-delivery updates, never
duplicates.

### `incident`
The unit of work.

`id` (`inc_…`), `org_id`, `number` (per-org sequence, what analysts say aloud),
`title`, `description`, `severity`, `priority`, `status`
(`new|triage|investigating|containment|eradication|recovery|closed`),
`resolution` (`true_positive|false_positive|benign|duplicate|inconclusive`),
`assignee_id`, `team_id`, `created_at`, `acknowledged_at`, `contained_at`,
`closed_at`, `sla_ack_due`, `sla_resolve_due`, `sla_state`,
`technique_ids text[]`, `tags text[]`, `source_summary jsonb`,
`ai_risk_score smallint`, `ai_summary_id`.

`acknowledged_at` and `contained_at` exist as columns because MTTA and MTTR are
dashboard metrics and deriving them from the timeline at query time does not
scale.

### `incident_link`
`(incident_id, related_incident_id, relation, created_by, created_at)` where
relation is `duplicate_of|related|child_of|merged_into`.

### `timeline_entry`
Append-only, and the spine of the analyst workspace.

`id`, `org_id`, `incident_id`, `at timestamptz`, `seq bigint`,
`kind` (`alert_received|status_change|assignment|note|command_run|
playbook_started|playbook_step|approval_requested|approval_decided|
response_action|ai_analysis|evidence_added|entity_added|sla_breach`),
`actor_kind` (`analyst|system|playbook|ai|integration`), `actor_id`,
`summary text`, `detail jsonb`, `execution_id`, `step_id`, `ai_session_id`.

`(incident_id, seq)` is unique and monotonic, so concurrent writers cannot
produce an ambiguous order.

---

## 4. Cases and work

### `case`
A case groups incidents that belong to one investigation, and holds the
long-lived analyst work.
`id`, `org_id`, `number`, `title`, `summary`, `status`, `owner_id`, `team_id`,
`opened_at`, `closed_at`, `template_id`, `severity`, `tags text[]`.
`case_incident`: `(case_id, incident_id)`.

### `task`
`id`, `org_id`, `case_id?`, `incident_id?`, `title`, `description`,
`status` (`open|in_progress|blocked|done|cancelled`), `assignee_id`,
`due_at`, `completed_at`, `order_index`, `created_from_template`,
`playbook_step_id?` — a task created by a playbook keeps the link, so a manual
step in an automated playbook is visible as both.

### `case_template`
`id`, `org_id`, `name`, `tasks jsonb`, `default_severity`, `sla jsonb`.

### `note`
`id`, `org_id`, `parent_kind`, `parent_id`, `author_id`, `body`, `created_at`,
`edited_at`, `body_history jsonb[]` — notes are evidence, so edits keep history.

### `evidence`
`id`, `org_id`, `incident_id?`, `case_id?`, `kind` (`file|screenshot|email|
memory_dump|report|export`), `object_key`, `sha256`, `size_bytes`,
`content_type`, `original_filename`, `collected_at`, `collected_by`,
`chain_of_custody jsonb[]`, `malicious bool?`.

The bytes are in the object store under `object_key`; the row is the metadata and
the custody chain. `original_filename` is metadata and is never used to build a
path.

---

## 5. Observables, entities and intelligence

### `indicator`
One row per distinct observable value, per organisation.

`id`, `org_id`, `type` (`ipv4|ipv6|domain|url|sha256|sha1|md5|email|
file_path|registry_key|user_agent|asn|cve`), `value`, `value_normalised`,
`first_seen`, `last_seen`, `sighting_count`,
`verdict` (`unknown|benign|suspicious|malicious`), `confidence smallint`,
`score smallint`, `tlp`, `expires_at`, `tags text[]`, `is_whitelisted bool`.
Unique `(org_id, type, value_normalised)`.

`value_normalised` is the deduplication key: domains lowercased and
IDNA-encoded, URLs with default ports and fragments removed, IPv6 in compressed
form, hashes lowercased. Without it the same IOC arrives four ways and scores
four times.

### `sighting`
`id`, `org_id`, `indicator_id`, `at`, `context_kind`
(`alert|incident|feed|enrichment|manual`), `context_id`, `source`,
`verdict_at_time`, `raw jsonb`.
This is the high-volume table and it is partitioned by month.

### `enrichment`
The cached result of asking a provider about an indicator.
`id`, `org_id`, `indicator_id`, `provider`, `requested_at`, `expires_at`,
`verdict`, `score`, `raw jsonb`, `normalised jsonb`, `execution_id`.
Unique `(org_id, indicator_id, provider)` with TTL, so a playbook that runs
hourly does not burn the VirusTotal quota.

### `indicator_relation`
`(from_indicator_id, to_indicator_id, relation, confidence, source)` —
`resolves_to`, `hosted_on`, `dropped_by`, `communicates_with`, `same_campaign`.

### `feed`
`id`, `org_id`, `name`, `url`, `format` (`misp|stix|csv|json`), `credential_id?`,
`schedule`, `enabled`, `last_fetch_at`, `last_status`, `indicator_count`,
`default_confidence`, `default_tlp`, `auto_expire_days`.

### Entities

Entities are the *things in the estate* as opposed to observables about the
world. They are separate tables because they have lifecycle and ownership.

`host`: `id`, `org_id`, `hostname`, `fqdn`, `os`, `os_version`, `ip_addresses inet[]`,
`mac_addresses`, `criticality`, `owner_user_id`, `site`, `agent_ids jsonb`
(`{"crowdstrike": "aid…", "defender": "…"}`), `isolated bool`,
`isolated_at`, `last_seen_at`, `tags text[]`.

`identity`: `id`, `org_id`, `upn`, `display_name`, `email`, `department`,
`manager_id`, `privileged bool`, `mfa_enrolled bool`, `status`,
`external_ids jsonb`, `risk_score`.

`asset`: the general case — `id`, `org_id`, `kind` (`server|workstation|
saas_app|cloud_resource|network_device|mailbox`), `name`, `criticality`,
`owner`, `environment` (`prod|staging|dev`), `external_ids jsonb`.

`vulnerability`: `id`, `org_id`, `cve`, `cvss`, `epss`, `kev bool`,
`affected_asset_ids`, `status`, `due_at`.

`incident_entity`: `(incident_id, entity_kind, entity_id, role, added_by,
added_at)` where role is `subject|source|target|related`. This is how an incident
gathers its hosts, identities and assets without four nullable columns.

`incident_indicator`: `(incident_id, indicator_id, role, added_by, added_at)`.

### Threat context

`malware`: `id`, `org_id`, `name`, `family`, `aliases text[]`, `platform`.
`threat_actor`: `id`, `org_id`, `name`, `aliases`, `motivation`, `origin`,
`technique_ids text[]`, `reference_urls`.
`campaign`: `id`, `org_id`, `name`, `actor_id`, `first_seen`, `last_seen`,
`description`.
`mitre_technique`: `id` (`T1566.001`), `tactic`, `name`, `description`,
`platforms`, `data_sources`, `revoked bool`, `version` — loaded from the ATT&CK
bundle, refreshed on demand, not hand-maintained.
`mitre_mapping`: `(subject_kind, subject_id, technique_id, confidence, source)`
where `subject_kind` is `incident|alert|playbook|command|detection`.

---

## 6. Automation

### `integration`
An installed connector instance.
`id`, `org_id`, `connector_id` (`crowdstrike.falcon`), `connector_version`,
`name` (`crowdstrike_prod`), `config jsonb` (non-secret), `credential_id`,
`enabled`, `health` (`healthy|degraded|failing|unknown`), `last_check_at`,
`last_error`, `worker_pool`, `egress_allowlist text[]`, `rate_limit jsonb`.

### `credential`
`id`, `org_id`, `name` (the logical identifier playbooks use), `kind`
(`api_key|oauth2_client|basic|token|certificate|ssh_key`),
`ciphertext bytea`, `nonce bytea`, `wrapped_key bytea`, `key_version`,
`provider` (`local|vault|azure_keyvault|aws_sm`), `external_ref`,
`owner_user_id`, `purpose`, `rotation_due_at`, `last_used_at`, `created_at`.
Unique `(org_id, name)`.

No column here ever holds plaintext. When `provider != 'local'` the ciphertext
columns are null and `external_ref` names the secret in the external store.

### `command` and `command_version`
`command`: `id`, `org_id?` (null = platform-provided), `key`
(`virustotal.ip_report`), `name`, `category`, `integration_id?`,
`trust_level` (`trusted|verified|untrusted`), `current_version_id`,
`created_by`, `deprecated bool`.

`command_version`: `id`, `command_id`, `version`, `state` (`draft|testing|
published|deprecated|archived`), `kind` (`python|http|builtin|shell|transform`),
`input_schema jsonb`, `output_schema jsonb`, `implementation jsonb`,
`required_permissions text[]`, `required_capabilities text[]`,
`auth jsonb` (which credential roles it needs), `timeout_ms`,
`risk_level` (`low|medium|high`), `technique_ids text[]`,
`content_sha256`, `signature`, `publisher`, `created_by`, `published_at`,
`published_by`, `review_notes`.

Input and output schemas are JSON Schema. Commands are machine-readable in and
machine-readable out; there is no text-scraping contract anywhere in the
platform.

### `playbook` and `playbook_version`
`playbook`: `id`, `org_id`, `key`, `name`, `description`, `category`,
`current_version_id`, `owner_id`, `technique_ids text[]`, `tags`.

`playbook_version`: `id`, `playbook_id`, `version int`, `state`,
`definition jsonb` (nodes, edges, variables, error handling),
`input_schema jsonb`, `content_sha256`, `created_by`, `created_at`,
`published_by`, `published_at`, `deprecated_at`, `notes`,
`test_results jsonb`, `validation jsonb`.

A published row is immutable. Editing creates a new draft. `content_sha256`
covers `definition` + `input_schema`, and an execution stores it, so "what
actually ran" survives the playbook being revised.

### `trigger`
What is allowed to start a playbook. Deliberately a first-class table, because
the alternative — letting the caller name the playbook — is the main SOAR
design flaw.
`id`, `org_id`, `kind` (`alert_rule|schedule|manual|incident_status|webhook_source`),
`playbook_id`, `condition jsonb` (typed filter AST over the normalised alert),
`enabled`, `created_by`, `rate_limit jsonb`, `dedupe_window_s`.

### `execution`
`id` (`exec_2026_000123`), `org_id`, `playbook_id`, `playbook_version_id`,
`content_sha256`, `incident_id?`, `case_id?`, `trigger_kind`, `trigger_id?`,
`initiator_kind` (`analyst|schedule|alert|api|ai|sub_playbook`),
`initiator_id`, `parent_execution_id?`, `depth smallint`,
`mode` (`live|dry_run|simulation`),
`status` (`queued|running|waiting_approval|paused|succeeded|failed|cancelled|timed_out`),
`inputs jsonb`, `outputs jsonb`, `variables jsonb`,
`started_at`, `finished_at`, `duration_ms`, `step_budget_used`,
`error jsonb`, `worker_pool`.

### `execution_step`
Append-only. One row per attempt, not per step — retries are visible.
`id`, `org_id`, `execution_id`, `node_id`, `sequence int`, `attempt smallint`,
`node_kind`, `command_version_id?`, `integration_id?`,
`status` (`pending|queued|running|succeeded|failed|skipped|waiting_approval|cancelled`),
`input jsonb`, `output jsonb`, `logs jsonb`, `error jsonb`,
`started_at`, `finished_at`, `duration_ms`, `worker_id`, `job_id`,
`approval_id?`, `ai_turn_id?`, `retry_of_step_id?`, `is_compensation bool`.

`(execution_id, node_id, attempt)` is unique, which is also the idempotency key
the queue consumer uses.

### `approval`
`id`, `org_id`, `execution_id?`, `step_id?`, `incident_id?`,
`requested_by_kind` (`playbook|ai|analyst`), `requested_by_id`,
`action_key`, `action_summary`, `risk_level`, `payload jsonb` (redacted),
`policy_id`, `required_permission`, `required_approvals smallint`,
`separation_of_duty bool`,
`status` (`pending|approved|rejected|expired|cancelled`),
`expires_at`, `decided_at`, `nonce`,
and `approval_decision`: `(approval_id, decider_id, decision, reason,
decided_at, step_up_satisfied)` — plural, because two-person rules need two rows.

### `approval_policy`
`id`, `org_id`, `name`, `priority int`, `enabled`,
`match jsonb` (action key, risk level, severity, asset criticality, environment,
integration, playbook, initiator kind, time of day),
`effect` (`allow|require_approval|deny`), `required_approvals`,
`required_permission`, `separation_of_duty`, `timeout_s`,
`on_timeout` (`reject|escalate|proceed` — `proceed` is refused for HIGH).

---

## 7. AI

### `ai_provider`
`id`, `org_id`, `kind` (`ollama|openai|anthropic|azure_openai|openai_compatible`),
`name`, `base_url`, `credential_id?`, `enabled`, `health`, `models jsonb`.

### `ai_model_role`
`(org_id, role, provider_id, model, params jsonb)` where role is
`fast|investigation|reasoning|embedding|local`. This is the indirection that
keeps playbooks from naming a vendor model.

### `ai_tool`
The registry the model reasons over.
`id`, `org_id?`, `name` (`crowdstrike_get_host`), `description`,
`input_schema jsonb`, `output_schema jsonb`, `implementation`
(`command:<key>` / `playbook:<key>` / `query:<kind>`),
`risk_level` (`low|medium|high`), `required_permission`,
`requires_approval bool`, `timeout_ms`, `enabled`, `max_calls_per_turn`.

### `ai_session`
`id`, `org_id`, `user_id`, `incident_id?`, `case_id?`, `purpose`,
`tool_set_id`, `principal_permissions text[]` (the intersection computed at
session start — recorded so the audit shows what the AI *could* have done),
`started_at`, `ended_at`, `token_in`, `token_out`, `cost_estimate`.

### `ai_turn`
`id`, `session_id`, `sequence`, `role` (`user|assistant|tool`),
`model`, `provider_id`, `prompt_sha256`, `content_ref` (object key —
conversation bodies are objects, not rows), `tokens_in`, `tokens_out`,
`latency_ms`, `finish_reason`, `injection_flags jsonb`.

### `ai_tool_call`
`id`, `turn_id`, `tool_id`, `arguments jsonb` (redacted), `status`,
`approval_id?`, `execution_id?`, `result_ref`, `duration_ms`, `error`.

### `ai_analysis`
The durable output that attaches to an incident: `id`, `org_id`, `incident_id`,
`kind` (`summary|classification|extraction|investigation|recommendation|
mitre_mapping`), `session_id`, `model`, `structured jsonb`, `confidence`,
`created_at`, `accepted_by?`, `accepted_at?`, `superseded_by?`.

An AI conclusion is a *proposal* until a human accepts it. `accepted_by` is what
makes that visible in the data rather than only in the UI.

---

## 8. Audit

### `audit_event`
Insert-only for every runtime role. Hash-chained per stream.

`id`, `org_id`, `at`, `seq bigint`, `stream` (per-org partition key),
`actor_kind` (`user|api_token|playbook|ai|system|integration`), `actor_id`,
`actor_label`, `on_behalf_of_id?` (set when the AI acts for an analyst),
`action` (`incident.status.change`, `credential.read`, `playbook.publish`,
`response.isolate`, …),
`target_kind`, `target_id`, `target_label`,
`source_ip inet`, `user_agent`, `session_id`, `correlation_id`,
`execution_id?`, `approval_id?`, `ai_session_id?`,
`before jsonb`, `after jsonb`, `result` (`success|failure|denied`),
`reason`, `prev_hash bytea`, `hash bytea`.

`hash = SHA256(prev_hash || canonical_json(row without hash))`. A verifier walks
the chain on a schedule and on demand. Deleting or editing a row breaks every
subsequent hash, which is the property that makes the log worth keeping.

`before` and `after` are redacted through the secret-aware encoder, so a
credential update audits the *fact* and never the value.

---

## 9. Operational tables

`worker`: `id`, `org_id?`, `pool`, `hostname`, `pid`, `version`,
`started_at`, `last_heartbeat_at`, `jobs_completed`, `jobs_failed`, `status`.

`integration_health_check`: `(integration_id, at, ok, latency_ms, error)` —
the series behind the dashboard's integration health tile.

`platform_alert`: `id`, `org_id`, `kind` (`queue_depth|worker_down|
integration_failing|audit_chain_broken|credential_expiring|secret_shape_in_output`),
`severity`, `detail jsonb`, `raised_at`, `cleared_at`. The SOAR watching itself.

`schedule`: `id`, `org_id`, `kind`, `cron`, `timezone`, `target`, `enabled`,
`last_run_at`, `next_run_at`, `last_status`.

`migration`: applied schema versions, checked by `/readyz`.

---

## 10. Indexing and retention, briefly

- Hot paths: `incident(org_id, status, severity, created_at desc)`,
  `alert(org_id, status, observed_at desc)`,
  `execution(org_id, status, started_at desc)`,
  `timeline_entry(incident_id, seq)`,
  `indicator(org_id, type, value_normalised)` unique,
  `sighting(indicator_id, at desc)`.
- Partitioned monthly: `event`, `sighting`, `audit_event`, `execution_step`.
- Retention is policy per table, not a global setting: `event` 90 days by
  default, `sighting` 13 months, `execution_step` 13 months, `audit_event`
  7 years and never automatically. Evidence follows the case, not a clock.
- JSONB columns that are queried (`alert.entities`, `execution.variables`) get
  GIN indexes; the ones that are only ever read whole (`event.raw`) do not.

---

## 11. What this model deliberately does not do

- **No EAV.** Custom fields are typed JSONB with a registered schema per
  organisation, validated on write. Entity-attribute-value tables are how
  security products become unqueryable.
- **No soft-delete flag on everything.** Things that happened are append-only;
  things that are configuration are versioned. `deleted_at` exists only where a
  user genuinely expects a recycle bin.
- **No polymorphic foreign key without a kind column.** `parent_kind` +
  `parent_id` always travel together and are always constrained.
- **No storing secrets "temporarily".** There is no column anywhere that holds a
  plaintext credential, including during rotation.
