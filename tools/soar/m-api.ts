/**
 * The API module and the process entry point.
 *
 * Two things here carry most of the weight: ingest.py, where an inbound webhook
 * is prevented from naming a playbook, and security.py, where every request is
 * turned into a principal before any handler sees it.
 */

import { addModule, addFile } from '#core/project/builder.ts';
import type { ProjectModule } from '#core/model/project.ts';
import type { Ctx } from './kit.ts';
import { exports_, fnWithBody, iface, imports_, py, pyPath } from './kit.ts';
import type { CoreModules } from './m-core.ts';
import type { DomainModules } from './m-domain.ts';
import type { AutomationModules } from './m-automation.ts';
import type { AiModules } from './m-ai.ts';

export function buildApi(
  ctx: Ctx,
  core: CoreModules,
  domain: DomainModules,
  automation: AutomationModules,
  aiModules: AiModules,
): ProjectModule {
  const api = addModule(ctx.project, {
    name: 'api',
    directory: 'src/soar/api',
    description:
      'The HTTP surface. Authentication, CSRF, CORS, rate limiting, webhook verification and routing. Everything the UI can do is an API call, because the UI is a client of these endpoints and nothing else.',
    dependencies: [
      core.platform.id,
      core.identity.id,
      core.audit.id,
      domain.incidents.id,
      domain.normalize.id,
      automation.playbooks.id,
      automation.approvals.id,
      aiModules.ai.id,
    ],
  });

  const find = (path: string) => ctx.project.files.find((f) => f.path === pyPath(path))!;
  const idsFile = find('src/platform/ids.py');
  const sessionsFile = find('src/identity/sessions.py');
  const rbacFile = find('src/identity/rbac.py');
  const auditFile = find('src/audit/log.py');

  // -------------------------------------------------------------------------
  // api/security.py
  // -------------------------------------------------------------------------
  const security = py(ctx, { path: 'src/api/security.py', module: api, doc: 'request security', style: 'procedural' });
  {
    const g = security.g;

    fnWithBody(g, {
      name: 'security_headers',
      params: [{ name: 'nonce', type: 'string' }],
      returns: 'Map<string, string>',
      doc: [
        'The response headers, on every response including errors.',
        '',
        'A nonce-based CSP with no unsafe-inline is what makes the XSS mitigation',
        'structural: even a successful injection into the analyst workspace has no',
        'way to execute.',
      ].join('\n'),
      implName: 'build_security_headers',
      code: [
        'return {',
        '    "Content-Security-Policy": (',
        '        "default-src \'self\'; "',
        '        "script-src \'self\' \'nonce-%s\'; " % nonce +',
        '        "style-src \'self\' \'nonce-%s\'; " % nonce +',
        '        "img-src \'self\' data:; "',
        '        "connect-src \'self\'; "',
        '        "frame-src \'self\'; "',
        '        "frame-ancestors \'none\'; "',
        '        "object-src \'none\'; "',
        '        "base-uri \'none\'; "',
        '        "form-action \'self\'"',
        '    ),',
        '    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",',
        '    "X-Content-Type-Options": "nosniff",',
        '    "Referrer-Policy": "no-referrer",',
        '    "Permissions-Policy": "geolocation=(), camera=(), microphone=()",',
        '    "Cache-Control": "no-store",',
        '    "Cross-Origin-Opener-Policy": "same-origin",',
        '    "Cross-Origin-Resource-Policy": "same-origin",',
        '}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'cors_headers',
      params: [
        { name: 'origin', type: 'string' },
        { name: 'allowed_origins', type: 'List<string>' },
      ],
      returns: 'Map<string, string>',
      doc: 'Exact-match origins only. No wildcard, no regular expression, and never a reflected origin with credentials - the combination that turns CORS into a same-origin bypass.',
      implName: 'build_cors_headers',
      code: [
        'if not origin or origin not in allowed_origins:',
        '    return {}',
        'return {',
        '    "Access-Control-Allow-Origin": origin,',
        '    "Access-Control-Allow-Credentials": "true",',
        '    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",',
        '    "Access-Control-Allow-Headers": "content-type, x-csrf-token",',
        '    "Vary": "Origin",',
        '    "Access-Control-Max-Age": "600",',
        '}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'rate_limit',
      params: [
        { name: 'redis', type: 'Any' },
        { name: 'bucket', type: 'string' },
        { name: 'limit', type: 'i64' },
        { name: 'window_s', type: 'i64' },
      ],
      returns: 'Map<string, Any>',
      doc: 'Token bucket in Redis, keyed per principal or per source. Shared across API replicas because the state is in Redis rather than in a process.',
      implName: 'consume_rate_limit',
      capabilities: ['net'],
      code: [
        'key = "rl:" + bucket',
        'pipe = redis.pipeline()',
        'pipe.incr(key)',
        'pipe.ttl(key)',
        'count, ttl = pipe.execute()',
        'if ttl < 0:',
        '    redis.expire(key, int(window_s))',
        '    ttl = int(window_s)',
        'return {"allowed": count <= int(limit), "remaining": max(0, int(limit) - count),',
        '        "reset_in_s": ttl}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'resolve_principal',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'redis', type: 'Any' },
        { name: 'request', type: 'Map<string, Any>' },
      ],
      returns: 'Map<string, Any>',
      doc: [
        'Turn a request into a principal, or refuse it.',
        '',
        'Two shapes of caller, deliberately separate: a browser session (cookie plus',
        'CSRF, subject to ambient authority and therefore needing the double-submit',
        'check) and an API token (a bearer credential with its own scopes and expiry,',
        'never a user password, and not subject to CSRF because it was never',
        'ambient).',
      ].join('\n'),
      implName: 'authenticate_request',
      code: [
        'import hashlib',
        '',
        'headers = request.get("headers") or {}',
        'authorization = headers.get("authorization", "")',
        '',
        'if authorization.lower().startswith("bearer "):',
        '    token = authorization.split(" ", 1)[1].strip()',
        '    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()',
        '    rows = db.query(',
        '        "SELECT id, org_id, name, scopes FROM api_token "',
        '        "WHERE token_hash = %s AND revoked_at IS NULL "',
        '        "AND (expires_at IS NULL OR expires_at > now())",',
        '        [digest], "",',
        '    )',
        '    if not rows:',
        '        raise PermissionError("invalid or expired API token")',
        '    db.execute("UPDATE api_token SET last_used_at = now() WHERE id = %s",',
        '               [rows[0]["id"]], rows[0]["org_id"])',
        '    return {"kind": "api_token", "id": rows[0]["id"], "org_id": rows[0]["org_id"],',
        '            "label": rows[0]["name"], "permissions": rows[0]["scopes"],',
        '            "mfa_satisfied": True}',
        '',
        'session_id = (request.get("cookies") or {}).get("soar_session")',
        'if not session_id:',
        '    raise PermissionError("no credentials presented")',
        '',
        'fingerprint = hashlib.sha256(',
        '    (headers.get("user-agent", "") + "|" +',
        '     request.get("address_family", "")).encode("utf-8")',
        ').hexdigest()',
        'record = load_session(redis, session_id, fingerprint)',
        '',
        'if request.get("method") not in ("GET", "HEAD", "OPTIONS"):',
        '    check_csrf(record, headers.get("x-csrf-token", ""))',
        '',
        '# NOT record["permissions"]. That list was computed when the session',
        '# opened, so a role granted or revoked since then did not apply, and a',
        '# permission the platform gained since then reached nobody already',
        '# signed in. The session establishes WHO; the roles decide what.',
        '#',
        '# Resolved against the HOME organisation, not the client currently being',
        '# viewed. Roles live where the person works - the provider - so asking',
        '# the customer tenant what roles they hold there returns nothing, and',
        '# switching client would silently strip every permission they have.',
        'home = record.get("home_org_id") or record["org_id"]',
        'return {"kind": "user", "id": record["user_id"], "org_id": record["org_id"],',
        '        "home_org_id": home,',
        '        "permissions": live_permissions(db, record["user_id"], home),',
        '        "mfa_satisfied": record.get("mfa_satisfied", False),',
        '        "session_id": session_id,',
        '        # Readable by same-origin script on purpose: that is what makes',
        '        # double-submit work. A cross-origin caller cannot read this',
        '        # response, and without the cookie it never gets one.',
        '        "csrf": record.get("csrf", ""),',
        '        "step_up_until": record.get("step_up_until", 0)}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'verify_webhook',
      params: [
        { name: 'redis', type: 'Any' },
        { name: 'secret', type: 'string' },
        { name: 'raw_body', type: 'string' },
        { name: 'signature', type: 'string' },
        { name: 'timestamp', type: 'string' },
        { name: 'source_id', type: 'string' },
      ],
      returns: 'Void',
      doc: [
        'Verify an inbound webhook: signature, freshness, and replay.',
        '',
        'The signature covers the timestamp, so a captured body cannot be replayed',
        'outside its window, and the (source, signature) pair is cached for the',
        'window duration so it cannot be replayed inside one either.',
      ].join('\n'),
      implName: 'check_webhook_signature',
      capabilities: ['net', 'time'],
      code: [
        'import hashlib',
        'import hmac',
        'import time',
        '',
        'WINDOW_S = 300',
        '',
        'try:',
        '    sent_at = int(timestamp)',
        'except (TypeError, ValueError):',
        '    raise PermissionError("webhook timestamp missing or malformed")',
        '',
        'if abs(time.time() - sent_at) > WINDOW_S:',
        '    raise PermissionError("webhook timestamp outside the %ds window" % WINDOW_S)',
        '',
        'expected = hmac.new(',
        '    secret.encode("utf-8"),',
        '    (str(sent_at) + "." + raw_body).encode("utf-8"),',
        '    hashlib.sha256,',
        ').hexdigest()',
        'if not hmac.compare_digest(expected, (signature or "").strip()):',
        '    raise PermissionError("webhook signature invalid")',
        '',
        '# Replay cache. SET NX is the whole check: a second delivery of the same',
        '# signed body loses the race and is rejected.',
        'key = "wh:%s:%s" % (source_id, expected)',
        'if not redis.set(key, "1", nx=True, ex=WINDOW_S):',
        '    raise PermissionError("webhook replay detected")',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'require_step_up',
      params: [
        { name: 'principal', type: 'Map<string, Any>' },
        { name: 'now_epoch', type: 'i64' },
      ],
      returns: 'Void',
      doc: 'Re-authentication for approving a HIGH action and for managing secrets. A session that has been open all day is not evidence that the person is still at the keyboard.',
      implName: 'enforce_step_up',
      code: [
        'if principal.get("kind") == "api_token":',
        '    raise PermissionError(',
        '        "this action requires an interactive, re-authenticated human; "',
        '        "an API token cannot satisfy step-up"',
        '    )',
        'if int(principal.get("step_up_until", 0)) < int(now_epoch):',
        '    raise PermissionError("re-authentication required")',
      ].join('\n'),
    });

    exports_(security.file, [
      { name: 'security_headers', sort: 'function' },
      { name: 'cors_headers', sort: 'function' },
      { name: 'rate_limit', sort: 'function' },
      { name: 'resolve_principal', sort: 'function' },
      { name: 'verify_webhook', sort: 'function' },
      { name: 'require_step_up', sort: 'function' },
    ]);
    imports_(security.file, sessionsFile, ['load_session', 'check_csrf']);
  }

  // -------------------------------------------------------------------------
  // api/routes.py
  // -------------------------------------------------------------------------
  const routes = py(ctx, { path: 'src/api/routes.py', module: api, doc: 'route table', style: 'service' });
  {
    const g = routes.g;

    fnWithBody(g, {
      name: 'route_table',
      returns: 'List<Map<string, Any>>',
      doc: [
        'Every endpoint, with the permission it needs and the rate limit it carries.',
        '',
        'The permission listed here is a first gate, not the gate: every service',
        'method checks again at the point of effect. A route that forgot its entry',
        'would still fail - which is the property that makes this table safe to read',
        'as documentation rather than as the security model.',
      ].join('\n'),
      implName: 'api_routes',
      code: [
        'def route(method, path, handler, permission=None, limit=120, step_up=False,',
        '          public=False):',
        '    # public means reachable without a session. It is separate from',
        '    # permission=None because /api/auth/logout and /api/me also carry no',
        '    # permission and very much do need one - and because a route that is',
        '    # public by accident is the hole nobody notices.',
        '    return {"method": method, "path": path, "handler": handler,',
        '            "permission": permission, "rate_limit_per_minute": limit,',
        '            "step_up": step_up, "public": public}',
        '',
        'return [',
        '    # --- session ---------------------------------------------------------',
        '    # The only two that must work with no session: one issues the pending',
        '    # session, the other exchanges it for permissions. Everything else in',
        '    # the product is reachable only after both have run.',
        '    route("POST", "/api/auth/login", "auth_login", None, limit=10, public=True),',
        '    route("POST", "/api/auth/mfa", "auth_mfa", None, limit=10, public=True),',
        '    route("POST", "/api/auth/step-up", "auth_step_up", None, limit=10),',
        '    route("POST", "/api/auth/logout", "auth_logout"),',
        '    route("GET", "/api/me", "whoami"),',
        '',
        '    # --- dashboard -------------------------------------------------------',
        '    route("GET", "/api/dashboard", "dashboard", "incidents.read"),',
        '',
        '    # --- incidents -------------------------------------------------------',
        '    route("GET", "/api/incidents", "incident_list", "incidents.read"),',
        '    route("POST", "/api/incidents", "incident_create", "incidents.write"),',
        '    route("GET", "/api/incidents/{id}", "incident_get", "incidents.read"),',
        '    route("PATCH", "/api/incidents/{id}", "incident_update", "incidents.write"),',
        '    route("POST", "/api/incidents/{id}/status", "incident_status", "incidents.write"),',
        '    route("GET", "/api/incidents/{id}/timeline", "incident_timeline", "incidents.read"),',
        '    route("POST", "/api/incidents/{id}/notes", "incident_note", "incidents.write"),',
        '    route("POST", "/api/incidents/{id}/indicators", "incident_add_ioc", "incidents.write"),',
        '    route("GET", "/api/incidents/{id}/related", "incident_related", "incidents.read"),',
        '',
        '    # --- alerts ----------------------------------------------------------',
        '    route("GET", "/api/alerts", "alert_list", "alerts.read"),',
        '    route("GET", "/api/alerts/{id}", "alert_get", "alerts.read"),',
        '    route("POST", "/api/alerts/{id}/triage", "alert_triage", "alerts.triage"),',
        '',
        '    # --- cases and tasks -------------------------------------------------',
        '    route("GET", "/api/cases", "case_list", "cases.read"),',
        '    route("POST", "/api/cases", "case_create", "cases.write"),',
        '    route("PATCH", "/api/tasks/{id}", "task_update", "cases.write"),',
        '',
        '    # --- commands --------------------------------------------------------',
        '    route("GET", "/api/commands", "command_list", "commands.read"),',
        '    route("POST", "/api/commands", "command_create", "commands.create"),',
        '    route("POST", "/api/commands/http-builder", "command_from_form", "commands.create"),',
        '    route("POST", "/api/commands/{id}/versions", "command_publish", "commands.create"),',
        '    route("POST", "/api/commands/{id}/trust", "command_promote", "commands.promote"),',
        '    route("POST", "/api/commands/{id}/run", "command_run", "commands.execute", limit=60),',
        '',
        '    # --- playbooks -------------------------------------------------------',
        '    route("GET", "/api/playbooks", "playbook_list", "playbooks.read"),',
        '    route("POST", "/api/playbooks", "playbook_create", "playbooks.create"),',
        '    route("GET", "/api/playbooks/{id}/versions", "playbook_versions", "playbooks.read"),',
        '    route("POST", "/api/playbooks/{id}/versions", "playbook_save_draft", "playbooks.create"),',
        '    route("GET", "/api/playbooks/{id}/diff", "playbook_diff", "playbooks.read"),',
        '    route("POST", "/api/playbooks/versions/{id}/validate", "playbook_validate", "playbooks.create"),',
        '    route("POST", "/api/playbooks/versions/{id}/simulate", "playbook_simulate", "playbooks.create"),',
        '    route("POST", "/api/playbooks/versions/{id}/publish", "playbook_publish", "playbooks.publish"),',
        '    route("POST", "/api/playbooks/{id}/run", "playbook_run", "playbooks.run", limit=60),',
        '    route("POST", "/api/playbooks/{id}/dry-run", "playbook_dry_run", "playbooks.run"),',
        '',
        '    # --- the playbook editor ----------------------------------------------',
        '    route("GET", "/api/playbooks/palette", "playbook_palette", "playbooks.read"),',
        '    route("GET", "/api/playbooks/versions/{id}", "playbook_version_get",',
        '          "playbooks.read"),',
        '    route("GET", "/api/response/coverage/{action}", "response_coverage",',
        '          "playbooks.read"),',
        '    route("GET", "/api/response/matrix", "response_matrix", "playbooks.read"),',
        '    route("GET", "/api/commands/catalogue", "command_catalogue", "commands.read"),',
        '',
        '    # --- executions ------------------------------------------------------',
        '    route("GET", "/api/executions", "execution_list", "executions.read"),',
        '    route("GET", "/api/executions/{id}", "execution_get", "executions.read"),',
        '    route("GET", "/api/executions/{id}/steps", "execution_steps", "executions.read"),',
        '    route("GET", "/api/executions/{id}/stream", "execution_stream", "executions.read"),',
        '    route("POST", "/api/executions/{id}/cancel", "execution_cancel", "executions.cancel"),',
        '    route("POST", "/api/executions/{id}/resume", "execution_resume", "executions.cancel"),',
        '',
        '    # --- approvals -------------------------------------------------------',
        '    route("GET", "/api/approvals", "approval_list", "approvals.read"),',
        '    route("POST", "/api/approvals/{id}/decide", "approval_decide",',
        '          "approvals.decide", step_up=True),',
        '',
        '    # --- integrations and credentials ------------------------------------',
        '    route("GET", "/api/connectors", "connector_catalogue", "integrations.read"),',
        '    route("POST", "/api/integrations/{id}/connect", "integration_connect", "integrations.manage"),',
        '    route("GET", "/api/integrations", "integration_list", "integrations.read"),',
        '    route("POST", "/api/integrations", "integration_install", "integrations.manage"),',
        '    route("POST", "/api/integrations/{id}/test", "integration_test", "integrations.manage"),',
        '    route("GET", "/api/credentials", "credential_list", "secrets.read_metadata"),',
        '    route("POST", "/api/credentials", "credential_create", "secrets.manage", step_up=True),',
        '    route("POST", "/api/credentials/{id}/rotate", "credential_rotate",',
        '          "secrets.manage", step_up=True),',
        '',
        '    # --- threat intelligence ---------------------------------------------',
        '    route("GET", "/api/indicators", "indicator_list", "intel.read"),',
        '    route("POST", "/api/indicators", "indicator_create", "intel.write"),',
        '    route("POST", "/api/indicators/{id}/enrich", "indicator_enrich", "intel.read"),',
        '    route("GET", "/api/mitre/coverage", "mitre_coverage", "intel.read"),',
        '    route("GET", "/api/mitre/status", "mitre_status", "intel.read"),',
        '    # Loading ATT&CK replaces the technique reference data the whole product',
        '    # reasons with, so it sits behind admin.platform rather than intel.write.',
        '    route("POST", "/api/mitre/load", "mitre_load", "admin.platform", limit=5),',
        '    # --- clients -----------------------------------------------------',
        '    # This is a managed service: the tenant is the product, not a Phase 3',
        '    # aspiration. Every other route in this table is scoped to whichever',
        '    # client the session is currently on.',
        '    route("GET", "/api/clients", "client_list", "clients.read"),',
        '    route("POST", "/api/clients", "client_create", "clients.manage"),',
        '    route("PATCH", "/api/clients/{id}", "client_update", "clients.manage"),',
        '    route("POST", "/api/clients/{id}/offboard", "client_offboard", "clients.manage"),',
        '    route("DELETE", "/api/clients/{id}", "client_delete", "clients.manage", limit=10),',
        '    route("POST", "/api/playbooks/{id}/duplicate", "playbook_duplicate", "playbooks.create"),',
        '    route("POST", "/api/commands/{id}/share", "command_share", "commands.create"),',
        '    route("GET", "/api/clients/{id}/tools", "client_tools", "clients.read"),',
        '    route("POST", "/api/clients/{id}/tools", "client_tool_add", "integrations.manage"),',
        '    route("GET", "/api/clients/{id}/intake", "client_intake_get", "clients.read"),',
        '    route("PUT", "/api/clients/{id}/intake", "client_intake_set", "integrations.manage"),',
        '    route("POST", "/api/clients/{id}/intake/preview", "client_intake_preview", "integrations.read"),',
        '    route("POST", "/api/session/client", "client_switch", None, limit=60),',
        '',
        '    route("GET", "/api/feeds", "feed_list", "intel.read"),',
        '    route("POST", "/api/feeds", "feed_create", "intel.feeds.manage"),',
        '    route("PATCH", "/api/feeds/{id}", "feed_update", "intel.feeds.manage"),',
        '    route("POST", "/api/feeds/{id}/fetch", "feed_fetch_now", "intel.feeds.manage", limit=20),',
        '    route("POST", "/api/feeds/{id}/discover", "feed_discover", "intel.feeds.manage", limit=20),',
        '    route("GET", "/api/feeds/{id}/collections", "feed_collections", "intel.read"),',
        '    route("GET", "/api/assets", "asset_list", "incidents.read"),',
        '',
        '    # --- threat hunting ---------------------------------------------------',
        '    # Every one of these needs a hunts.* permission, and the Analyst role',
        '    # holds none of them. What a hunt finds reaches an analyst as an',
        '    # ordinary alert, through the same queue as everything else.',
        '    route("GET", "/api/hunts", "hunt_list", "hunts.read"),',
        '    route("POST", "/api/hunts", "hunt_save", "hunts.write"),',
        '    route("GET", "/api/hunts/{id}", "hunt_get", "hunts.read"),',
        '    route("PUT", "/api/hunts/{id}", "hunt_save", "hunts.write"),',
        '    route("DELETE", "/api/hunts/{id}", "hunt_delete", "hunts.write"),',
        '    route("POST", "/api/hunts/{id}/run", "hunt_run_now", "hunts.run", limit=30),',
        '    route("GET", "/api/clients/{client_id}/hunt-tools", "hunt_tools", "hunts.read"),',
        '    route("GET", "/api/hunt-findings", "hunt_finding_list", "hunts.review"),',
        '    route("POST", "/api/hunt-findings/{id}/verdict", "hunt_finding_verdict", "hunts.review"),',
        '',
        '    # --- ai ---------------------------------------------------------------',
        '    route("POST", "/api/ai/sessions", "ai_open_session", "ai.configure", limit=30),',
        '    route("POST", "/api/ai/sessions/{id}/turn", "ai_turn", "ai.configure", limit=30),',
        '    route("GET", "/api/ai/sessions/{id}/context", "ai_context", "ai.configure"),',
        '    route("POST", "/api/ai/analyses/{id}/accept", "ai_accept", "incidents.write"),',
        '    route("POST", "/api/ai/generate-playbook", "ai_draft_playbook", "playbooks.create"),',
        '    route("GET", "/api/ai/tools", "ai_tool_list", "ai.configure"),',
        '    route("PATCH", "/api/ai/config", "ai_configure", "ai.configure"),',
        '',
        '    # --- reports and audit -------------------------------------------------',
        '    route("GET", "/api/reports", "report_list", "reports.read"),',
        '    route("GET", "/api/reports/{kind}", "report_render", "reports.read"),',
        '    route("POST", "/api/reports/{kind}/export", "report_export", "reports.export"),',
        '    route("GET", "/api/audit", "audit_search", "audit.read"),',
        '    route("POST", "/api/audit/verify", "audit_verify", "audit.read"),',
        '',
        '    # --- administration ----------------------------------------------------',
        '    route("GET", "/api/admin/users", "user_list", "admin.users"),',
        '    route("POST", "/api/admin/users", "user_create", "admin.users", step_up=True),',
        '    route("POST", "/api/admin/users/{id}/roles", "user_roles", "admin.roles",',
        '          step_up=True),',
        '    route("GET", "/api/admin/workers", "worker_list", "admin.platform"),',
        '    route("GET", "/api/admin/policies", "policy_list", "admin.platform"),',
        '',
        '    # --- ingest and health --------------------------------------------------',
        '    route("POST", "/ingest/{source}", "ingest_webhook", None, limit=600),',
        '    # Probed by the container runtime before any account exists.',
        '    route("GET", "/healthz", "health_live", None, limit=600, public=True),',
        '    route("GET", "/readyz", "health_ready", None, limit=600, public=True),',
        '    route("GET", "/metrics", "metrics", None, limit=600, public=True),',
        ']',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'match_route',
      params: [
        { name: 'table', type: 'List<Map<string, Any>>' },
        { name: 'method', type: 'string' },
        { name: 'path', type: 'string' },
      ],
      returns: 'Map<string, Any>',
      doc: 'Exact segment match with {named} captures. No regular expressions in the router, because a router that backtracks is a denial-of-service surface.',
      implName: 'resolve_route_entry',
      code: [
        'wanted = [segment for segment in (path or "").split("/") if segment != ""]',
        'for entry in table:',
        '    if entry["method"] != method:',
        '        continue',
        '    pattern = [s for s in entry["path"].split("/") if s != ""]',
        '    if len(pattern) != len(wanted):',
        '        continue',
        '    params, matched = {}, True',
        '    for expected, actual in zip(pattern, wanted):',
        '        if expected.startswith("{") and expected.endswith("}"):',
        '            params[expected[1:-1]] = actual',
        '        elif expected != actual:',
        '            matched = False',
        '            break',
        '    if matched:',
        '        return {"entry": entry, "params": params}',
        'return {}',
      ].join('\n'),
    });

    exports_(routes.file, [
      { name: 'route_table', sort: 'function' },
      { name: 'match_route', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // api/ingest.py -- threat T6
  // -------------------------------------------------------------------------
  const ingest = py(ctx, { path: 'src/api/ingest.py', module: api, doc: 'event ingestion', style: 'event-driven' });
  {
    const g = ingest.g;

    fnWithBody(g, {
      name: 'ingest_event',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'redis', type: 'Any' },
        { name: 'source', type: 'Map<string, Any>' },
        { name: 'raw_body', type: 'string' },
        { name: 'headers', type: 'Map<string, string>' },
      ],
      returns: 'Map<string, Any>',
      doc: [
        'Accept one inbound event. This is the most-attacked entry point in the',
        'product, so what it CANNOT do is as important as what it does.',
        '',
        'An ingested event may create an event row and an alert row. It may not name',
        'a playbook, a command, a user or a permission. Automation happens only if a',
        'trigger the SOC configured matches the NORMALISED alert - which means an',
        'attacker who can post to this endpoint gets to create an alert, not to run',
        'a containment action of their choosing.',
      ].join('\n'),
      implName: 'accept_inbound_event',
      code: [
        'import hashlib',
        'import json',
        '',
        'MAX_BODY = 1048576',
        '',
        'if len(raw_body or "") > MAX_BODY:',
        '    raise ValueError("body exceeds %d bytes" % MAX_BODY)',
        '',
        'verify_webhook(redis, source["secret"], raw_body,',
        '               headers.get("x-soar-signature", ""),',
        '               headers.get("x-soar-timestamp", ""), source["id"])',
        '',
        'try:',
        '    payload = json.loads(raw_body)',
        'except ValueError:',
        '    raise ValueError("body is not JSON")',
        'if not isinstance(payload, dict):',
        '    raise ValueError("body must be a JSON object")',
        '',
        'return ingest_payload(db, source, payload, raw_body)',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'ingest_payload',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'source', type: 'Map<string, Any>' },
        { name: 'payload', type: 'Map<string, Any>' },
        { name: 'raw_body', type: 'string' },
      ],
      returns: 'Map<string, Any>',
      doc: [
        'One vendor payload becomes one event row and one alert.',
        '',
        'Shared by the webhook endpoint and by the poller on purpose. A pushed',
        'alert and a pulled one are the same alert, and two code paths that both',
        'normalise would be two places for a mapping to be wrong in.',
        '',
        'The alert upsert is keyed on the vendor id, which is what makes polling',
        'safe: a poll that overlaps its own watermark, or a vendor that returns the',
        'same record twice, updates the alert rather than raising a second one.',
      ].join('\n'),
      implName: 'store_normalised_alert',
      code: [
        'import hashlib',
        'import json',
        '',
        'org_id = source["org_id"]',
        'body = raw_body if raw_body is not None else json.dumps(payload, sort_keys=True,',
        '                                                        default=str)',
        'digest = hashlib.sha256(body.encode("utf-8")).digest()',
        'event_id = new_id("evt")',
        '',
        '# The raw payload is kept verbatim. A mapping bug is then recoverable by',
        '# re-normalising rather than by asking the vendor to resend last month.',
        'db.execute(',
        '    "INSERT INTO event (id, org_id, source_id, raw, raw_sha256, "',
        '    "signature_verified, dedupe_key) VALUES (%s,%s,%s,%s,%s,%s,%s) "',
        '    "ON CONFLICT DO NOTHING",',
        '    [event_id, org_id, source["id"], body, digest,',
        '     bool(source.get("signature_verified", True)), digest.hex()],',
        '    org_id,',
        ')',
        '',
        '# The mapping this CLIENT configured wins. The shipped one is a starting',
        '# point the intake form pre-fills, not a ceiling: the same product sends',
        '# different shapes across versions and tenants, and a SOC that corrects',
        '# for that has to see its correction applied.',
        'mapping = source.get("mapping") or None',
        'if not mapping:',
        '    mapping = (builtin_mappings().get(source["connector_id"])',
        '               or builtin_mappings()["generic.webhook"])',
        '',
        'alert = normalise_event(source["connector_id"], payload, mapping)',
        'problems = validate_alert(alert)',
        'if problems:',
        '    raise ValueError("normalisation produced an invalid alert: "',
        '                     + "; ".join(problems))',
        '',
        'alert_id = new_id("alt")',
        'db.execute(',
        '    "INSERT INTO alert (id, org_id, event_id, source, vendor_alert_id, title, "',
        '    "description, severity, confidence, category, technique_ids, observed_at, "',
        '    "entities, indicators, custom) "',
        '    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "',
        '    "ON CONFLICT (org_id, source, vendor_alert_id) DO UPDATE "',
        '    "SET severity = EXCLUDED.severity, description = EXCLUDED.description, "',
        '    "custom = EXCLUDED.custom "',
        '    "RETURNING id",',
        '    [alert_id, org_id, event_id, alert["source"], alert["vendor_alert_id"],',
        '     alert["title"], alert["description"], alert["severity"],',
        '     alert["confidence"], alert["category"], alert["technique_ids"],',
        '     alert["observed_at"], json.dumps(alert["entities"]),',
        '     json.dumps(alert["indicators"]),',
        '     json.dumps(alert.get("custom") or {})],',
        '    org_id,',
        ')',
        '',
        'return {"event_id": event_id, "alert_id": alert_id,',
        '        "severity": alert["severity"],',
        '        "observed_at": alert["observed_at"],',
        '        "vendor_alert_id": alert["vendor_alert_id"],',
        '        "triggers_evaluated": evaluate_triggers(db, org_id, alert)}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'evaluate_triggers',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'org_id', type: 'string' },
        { name: 'alert', type: 'Map<string, Any>' },
      ],
      returns: 'List<string>',
      doc: [
        'Decide which configured triggers match this alert.',
        '',
        'The condition is a typed filter over the normalised alert, evaluated by the',
        'platform. The alert contributes values; it never contributes a playbook',
        'name, an operator or a field path that was not configured in advance.',
      ].join('\n'),
      implName: 'match_alert_triggers',
      code: [
        'fired = []',
        'triggers = db.query(',
        '    "SELECT id, playbook_id, condition, dedupe_window_s FROM trigger "',
        '    "WHERE org_id = %s AND kind = \'alert_rule\' AND enabled",',
        '    [org_id], org_id,',
        ')',
        'for trigger in triggers:',
        '    if matches(trigger["condition"], alert):',
        '        fired.append(trigger["id"])',
        'return fired',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'matches',
      params: [
        { name: 'condition', type: 'Map<string, Any>' },
        { name: 'alert', type: 'Map<string, Any>' },
      ],
      returns: 'bool',
      doc: [
        'Evaluate a typed filter AST against a normalised alert.',
        '',
        'A fixed grammar with a fixed operator set. There is no expression string to',
        'parse, so there is nothing to inject into - the same decision as the',
        'template renderer, for the same reason.',
      ].join('\n'),
      implName: 'evaluate_filter_ast',
      code: [
        'import re',
        '',
        'OPERATORS = {',
        '    "eq": lambda a, b: a == b,',
        '    "ne": lambda a, b: a != b,',
        '    "gt": lambda a, b: a is not None and a > b,',
        '    "gte": lambda a, b: a is not None and a >= b,',
        '    "lt": lambda a, b: a is not None and a < b,',
        '    "lte": lambda a, b: a is not None and a <= b,',
        '    "in": lambda a, b: a in (b or []),',
        '    "not_in": lambda a, b: a not in (b or []),',
        '    "contains": lambda a, b: b in (a or []),',
        '    "matches": lambda a, b: bool(re.fullmatch(b[:200], str(a or ""))),',
        '}',
        '',
        'if not condition:',
        '    return True',
        '',
        'node_type = condition.get("type")',
        'if node_type == "and":',
        '    return all(matches(c, alert) for c in condition.get("clauses", []))',
        'if node_type == "or":',
        '    return any(matches(c, alert) for c in condition.get("clauses", []))',
        'if node_type == "not":',
        '    return not matches(condition.get("clause", {}), alert)',
        '',
        'if node_type != "compare":',
        '    raise ValueError("unknown condition node %r" % node_type)',
        '',
        'operator = OPERATORS.get(condition.get("op"))',
        'if operator is None:',
        '    raise ValueError("unknown operator %r" % condition.get("op"))',
        '',
        '# The field is a path into the normalised alert only. It cannot reach the',
        '# raw vendor payload, and it cannot reach a Python attribute.',
        'value = read_path(alert, "$." + str(condition.get("field", "")))',
        'if condition.get("field") in ("severity",):',
        '    value = severity_rank(value)',
        '    literal = severity_rank(condition.get("value"))',
        'else:',
        '    literal = condition.get("value")',
        'return bool(operator(value, literal))',
      ].join('\n'),
    });

    exports_(ingest.file, [
      { name: 'ingest_event', sort: 'function' },
      { name: 'ingest_payload', sort: 'function' },
      { name: 'evaluate_triggers', sort: 'function' },
      { name: 'matches', sort: 'function' },
    ]);
    imports_(ingest.file, security.file, ['verify_webhook']);
    imports_(ingest.file, find('src/normalize/engine.py'), ['normalise_event', 'read_path']);
    imports_(ingest.file, find('src/normalize/mappings.py'), ['builtin_mappings']);
    imports_(ingest.file, find('src/normalize/model.py'), ['validate_alert', 'severity_rank']);
    imports_(ingest.file, idsFile, ['new_id']);
  }

  // -------------------------------------------------------------------------
  // api/server.py
  // -------------------------------------------------------------------------
  const server = py(ctx, { path: 'src/api/server.py', module: api, doc: 'request pipeline', style: 'event-driven' });
  {
    const g = server.g;

    // Drawn: the request pipeline is the order in which the gates apply, and the
    // order is the security property.
    const handler = g.add('net/on-request', { host: '0.0.0.0', port: 8443 });
    const note = g.add('data/comment', {
      text: [
        'Request pipeline, in order:',
        '  1  match the route          unmatched -> 404, no principal resolved',
        '  2  security headers         on every response, including errors',
        '  3  CORS                     exact-origin only, never reflected',
        '  4  rate limit               per principal or per source, in Redis',
        '  5  authenticate             session + CSRF, or bearer token',
        '  6  step-up                  for secrets.* and HIGH approvals',
        '  7  dispatch                 the handler, which checks permission AGAIN',
        '',
        'The order matters: nothing that can be expensive happens before the rate',
        'limit, and nothing that reads the body happens before authentication.',
      ].join('\n'),
    });
    g.chain([handler, 'out'], note);

    const dispatch = g.add('control/call', { target: 'dispatch_request', returns: 'Map<string, Any>' });
    const requestMap = g.add('map/literal', { keyType: 'string', valueType: 'Any' });
    g.setDefault(requestMap, 'k', 'method');
    g.connect(handler, 'method', requestMap, 'v');
    const pathKey = g.addVariadic(requestMap, 'k', 'in');
    const pathValue = g.addVariadic(requestMap, 'v', 'in');
    g.setDefault(requestMap, pathKey, 'path');
    g.connect(handler, 'path', requestMap, pathValue);
    const bodyKey = g.addVariadic(requestMap, 'k', 'in');
    const bodyValue = g.addVariadic(requestMap, 'v', 'in');
    g.setDefault(requestMap, bodyKey, 'body');
    g.connect(handler, 'body', requestMap, bodyValue);
    const headerKey = g.addVariadic(requestMap, 'k', 'in');
    const headerValue = g.addVariadic(requestMap, 'v', 'in');
    g.setDefault(requestMap, headerKey, 'headers');
    g.connect(handler, 'headers', requestMap, headerValue);
    g.connect(requestMap, 'map', dispatch, 'args');

    const statusField = g.add('map/get-or');
    g.connect(dispatch, 'result', statusField, 'a0');
    g.setDefault(statusField, 'a1', 'status');
    g.setDefault(statusField, 'a2', 500);
    const bodyField = g.add('map/get-or');
    g.connect(dispatch, 'result', bodyField, 'a0');
    g.setDefault(bodyField, 'a1', 'body');
    g.setDefault(bodyField, 'a2', '{}');

    const reply = g.add('net/reply');
    g.connect(statusField, 'value', reply, 'status');
    g.connect(bodyField, 'value', reply, 'body');
    g.setDefault(reply, 'contentType', 'application/json');
    g.chain(note, dispatch, reply);

    fnWithBody(g, {
      name: 'dispatch_request',
      params: [{ name: 'request', type: 'Map<string, Any>' }],
      returns: 'Map<string, Any>',
      doc: 'The pipeline the graph above describes, with the error mapping that keeps a refusal from leaking why.',
      implName: 'run_request_pipeline',
      code: [
        'import json',
        'import secrets as pysecrets',
        'import time',
        '',
        'nonce = pysecrets.token_urlsafe(16)',
        'headers = dict(security_headers(nonce))',
        '',
        'matched = match_route(route_table(), request["method"], request["path"])',
        'if not matched:',
        '    return {"status": 404, "headers": headers,',
        '            "body": json.dumps({"error": "not found"})}',
        'entry, params = matched["entry"], matched["params"]',
        '',
        'context = current_context()',
        'headers.update(cors_headers(request.get("headers", {}).get("origin", ""),',
        '                            context["allowed_origins"]))',
        '',
        'try:',
        '    if entry["path"].startswith("/ingest/"):',
        '        bucket = "src:" + params.get("source", "unknown")',
        '        principal = None',
        '    elif entry.get("public"):',
        '        # No session to resolve - one of these is how a session is got in',
        '        # the first place. Rate limited by peer address instead, so a login',
        '        # endpoint can neither be brute forced nor used to lock out others.',
        '        principal = None',
        '        bucket = "ip:%s:%s %s" % (request.get("address_family") or "anon",',
        '                                  entry["method"], entry["path"])',
        '    else:',
        '        principal = resolve_principal(context["db"], context["redis"], request)',
        '        # Per ROUTE, not per session. One bucket per principal meant the',
        '        # tightest limit in the table was enforced against every request',
        '        # they had made anywhere - so a console that polls made a',
        '        # 10-a-minute endpoint unusable after the first call.',
        '        bucket = "prn:%s:%s %s" % (principal["id"], entry["method"],',
        '                                   entry["path"])',
        '',
        '    allowance = rate_limit(context["redis"], bucket,',
        '                           entry["rate_limit_per_minute"], 60)',
        '    if not allowance["allowed"]:',
        '        headers["Retry-After"] = str(allowance["reset_in_s"])',
        '        return {"status": 429, "headers": headers,',
        '                "body": json.dumps({"error": "rate limit exceeded"})}',
        '',
        '    if entry.get("step_up"):',
        '        require_step_up(principal, int(time.time()))',
        '',
        '    if entry.get("permission") and principal is not None:',
        '        require_permission(principal, entry["permission"])',
        '',
        '    result = context["handlers"][entry["handler"]](principal, params, request)',
        '',
        '    # Lifted out of the handler result rather than serialised into the body.',
        '    # The ASGI adapter has always read set_cookies from the response; until',
        '    # now nothing put it there, so sign-in returned a session id that the',
        '    # browser had no way to send back.',
        '    cookies = result.pop("set_cookies", []) if isinstance(result, dict) else []',
        '    return {"status": 200, "headers": headers, "set_cookies": cookies,',
        '            "body": json.dumps(result, default=str)}',
        '',
        'except PermissionError as error:',
        '    # 403 for an authenticated principal that lacks the permission, 401 for',
        '    # one that presented nothing. The message is the reason, not the',
        '    # internals - "no such incident" and "not your incident" read alike on',
        '    # purpose.',
        '    status = 401 if "credentials" in str(error) else 403',
        '    return {"status": status, "headers": headers,',
        '            "body": json.dumps({"error": str(error)})}',
        'except (ValueError, KeyError) as error:',
        '    return {"status": 400, "headers": headers,',
        '            "body": json.dumps({"error": str(error)})}',
        'except Exception:  # noqa: BLE001',
        '    correlation = new_id("err")',
        '    log_exception(correlation)',
        '    return {"status": 500, "headers": headers,',
        '            "body": json.dumps({"error": "internal error",',
        '                                "correlation_id": correlation})}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'health_report',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'redis', type: 'Any' },
      ],
      returns: 'Map<string, Any>',
      doc: 'Backs /readyz. Reports what is actually checked, so a green light means something specific.',
      implName: 'build_health_report',
      capabilities: ['net'],
      code: [
        'checks = {"database": False, "redis": False, "migrations": False}',
        'checks["database"] = db.health()',
        'try:',
        '    checks["redis"] = bool(redis.ping())',
        'except Exception:',
        '    checks["redis"] = False',
        'try:',
        '    rows = db.query("SELECT max(version) AS v FROM migration", [], "")',
        '    checks["migrations"] = bool(rows and rows[0]["v"])',
        'except Exception:',
        '    checks["migrations"] = False',
        'return {"ready": all(checks.values()), "checks": checks}',
      ].join('\n'),
    });

    exports_(server.file, [
      { name: 'dispatch_request', sort: 'function' },
      { name: 'health_report', sort: 'function' },
    ]);
    imports_(server.file, security.file, ['security_headers', 'cors_headers', 'rate_limit', 'resolve_principal', 'require_step_up']);
    imports_(server.file, routes.file, ['route_table', 'match_route']);
    imports_(server.file, rbacFile, ['require_permission']);
    imports_(server.file, idsFile, ['new_id']);
  }

  // -------------------------------------------------------------------------
  // src/main.py -- one artifact, many roles
  // -------------------------------------------------------------------------
  const main = py(ctx, {
    path: 'src/main.py',
    doc: 'entry point',
    style: 'procedural',
    role: 'entry',
    kind: 'hybrid',
  });
  {
    const g = main.g;

    const entry = g.add('entry/main');
    const banner = g.add('data/comment', {
      text: [
        'One artifact, four roles. Which modules start is configuration, not a',
        'build:',
        '',
        '  soar serve                  api + scheduler      (HTTP in)',
        '  soar worker --pool default  execution worker     (no HTTP in)',
        '  soar worker --pool sandbox  untrusted code       (no creds, no egress)',
        '  soar ingest                 listeners            (webhook, syslog, poll)',
        '',
        'This is what lets the Phase 1 compose file become the Phase 2 VM split',
        'without a rewrite: the role flag that chose a container\'s job now chooses',
        'a machine\'s job.',
      ].join('\n'),
    });
    g.chain([entry, 'out'], banner);

    const settings = g.add('control/call', { target: 'load_settings', returns: 'Map<string, Any>' });

    // A subcommand, if there is one, is handled before the role is looked at:
    // create-admin and init-key are one-shot operations run from a shell on the
    // deployment, not a fifth long-running role.
    const command = g.add('control/call', { target: 'cli_command', returns: 'string' });
    const noCommand = g.add('data/literal', { type: 'string', value: '' });
    const isCommand = g.add('op/compare', { op: '!=' });
    g.connect(command, 'result', isCommand, 'a');
    g.connect(noCommand, 'value', isCommand, 'b');
    const branchCommand = g.add('control/if');
    g.connect(isCommand, 'result', branchCommand, 'cond');
    const runCommand = g.add('control/call', { target: 'run_cli_command', returns: 'Void' });
    g.connect(settings, 'result', runCommand, 'args');
    g.connect(command, 'result', runCommand, 'args#1');

    const role = g.add('map/get-or');
    g.connect(settings, 'result', role, 'a0');
    g.setDefault(role, 'a1', 'role');
    g.setDefault(role, 'a2', 'serve');

    const serveLit = g.add('data/literal', { type: 'string', value: 'serve' });
    const isServe = g.add('op/compare', { op: '==' });
    g.connect(role, 'value', isServe, 'a');
    g.connect(serveLit, 'value', isServe, 'b');
    const branchServe = g.add('control/if');
    g.connect(isServe, 'result', branchServe, 'cond');

    const runServe = g.add('control/call', { target: 'run_api_role', returns: 'Void' });
    g.connect(settings, 'result', runServe, 'args');

    const workerLit = g.add('data/literal', { type: 'string', value: 'worker' });
    const isWorker = g.add('op/compare', { op: '==' });
    g.connect(role, 'value', isWorker, 'a');
    g.connect(workerLit, 'value', isWorker, 'b');
    const branchWorker = g.add('control/if');
    g.connect(isWorker, 'result', branchWorker, 'cond');
    const runWorker = g.add('control/call', { target: 'run_worker_role', returns: 'Void' });
    g.connect(settings, 'result', runWorker, 'args');
    const runIngest = g.add('control/call', { target: 'run_ingest_role', returns: 'Void' });
    g.connect(settings, 'result', runIngest, 'args');

    g.chain(banner, settings, command, branchCommand);
    g.chain([branchCommand, 'then'], runCommand);
    g.chain([branchCommand, 'else'], branchServe);
    g.chain([branchServe, 'then'], runServe);
    g.chain([branchServe, 'else'], branchWorker);
    g.chain([branchWorker, 'then'], runWorker);
    g.chain([branchWorker, 'else'], runIngest);

    fnWithBody(g, {
      name: 'cli_command',
      params: [],
      returns: 'string',
      doc: 'The subcommand, if the process was started with one. Everything else is a role, chosen by SOAR_ROLE.',
      implName: 'read_cli_command',
      capabilities: ['stdio'],
      code: [
        'import sys',
        '',
        'if len(sys.argv) < 2:',
        '    return ""',
        'candidate = sys.argv[1].strip()',
        'return candidate if candidate and not candidate.startswith("-") else ""',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'run_cli_command',
      params: [
        { name: 'settings', type: 'Map<string, Any>' },
        { name: 'command', type: 'string' },
      ],
      returns: 'Void',
      doc: [
        'One-shot operations that are not a role.',
        '',
        'Both of these exist because the installation deliberately ships with no',
        'account and no key. Running them takes a shell on the deployment, which is',
        'the intended bar: there is no endpoint anywhere that creates the first',
        'administrator, because an endpoint that did would be the way in.',
      ].join('\n'),
      implName: 'dispatch_cli_command',
      capabilities: ['stdio', 'fs.write', 'env'],
      code: [
        'import base64',
        'import getpass',
        'import os',
        'import sys',
        '',
        'if command == "init-key":',
        '    # Printed, not written, when a path is not usable: the api container',
        '    # mounts /data/keys read-only, so the normal path is to put this in',
        '    # .env as SOAR_ROOT_KEY rather than to have a process create it.',
        '    key = base64.b64encode(os.urandom(32)).decode("ascii")',
        '    path = settings.get("root_key_path") or ""',
        '    if path and settings.get("allow_key_creation") == "true":',
        '        os.makedirs(os.path.dirname(path), exist_ok=True)',
        '        handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
        '        with os.fdopen(handle, "wb") as out:',
        '            out.write(base64.b64decode(key))',
        '        print("wrote %s (mode 0600)" % path)',
        '    else:',
        '        print("SOAR_ROOT_KEY=" + key)',
        '        print("")',
        '        print("Put that line in deploy/.env. Keep a copy somewhere safe:")',
        '        print("every stored credential is encrypted under it, and losing")',
        '        print("it loses all of them.")',
        '    return',
        '',
        'if command != "create-admin":',
        '    raise SystemExit(',
        '        "unknown command %r; expected create-admin or init-key" % command)',
        '',
        '# --- create-admin --------------------------------------------------',
        'context = build_service_context(settings)',
        '',
        'email = (os.environ.get("SOAR_ADMIN_EMAIL") or "").strip()',
        'if not email:',
        '    email = input("Email: ").strip()',
        'display_name = (os.environ.get("SOAR_ADMIN_NAME") or "").strip()',
        'if not display_name:',
        '    display_name = input("Display name: ").strip() or email',
        '',
        'password = os.environ.get("SOAR_ADMIN_PASSWORD") or ""',
        'if not password:',
        '    if not sys.stdin.isatty():',
        '        raise SystemExit(',
        '            "no terminal to prompt on; set SOAR_ADMIN_PASSWORD, or run "',
        '            "with -it")',
        '    password = getpass.getpass("Password (12+ characters): ")',
        '    if password != getpass.getpass("Repeat password: "):',
        '        raise SystemExit("the passwords did not match")',
        '',
        'created = create_admin_account(context["db"], settings, email,',
        '                               display_name, password)',
        '',
        'print("")',
        'print("Administrator created: %s" % created["email"])',
        'print("Roles granted: %s" % ", ".join(created["roles"]))',
        'print("")',
        'print("This account holds every built-in role so the platform is usable")',
        'print("on first sign-in. Create scoped accounts for day-to-day work and")',
        'print("take the ones it does not need back off it.")',
        'print("")',
        'print("Enrol this in an authenticator app NOW. It is shown once, and")',
        'print("sign-in needs a code from it - the password alone opens a session")',
        'print("with no permissions at all.")',
        'print("")',
        'print("  secret: %s" % created["totp_secret"])',
        'print("  uri:    %s" % created["totp_uri"])',
        'print("")',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'run_api_role',
      params: [{ name: 'settings', type: 'Map<string, Any>' }],
      returns: 'Void',
      doc: 'Serve the API and the UI, and run the scheduler under a Redis lease so exactly one node holds it.',
      implName: 'start_api_process',
      capabilities: ['net', 'stdio'],
      packages: [{ name: 'uvicorn', version: '0.30.*' }, { name: 'starlette', version: '0.38.*' }],
      code: [
        'import uvicorn',
        '',
        'context = build_service_context(settings)',
        'start_scheduler_if_leader(context)',
        'uvicorn.run(',
        '    build_asgi_app(context),',
        '    host=settings["bind_host"],',
        '    port=int(settings["bind_port"]),',
        '    # Empty means plain HTTP on the bind port, which is what the compose',
        '    # file expects: 8443 is published to the loopback only and TLS belongs',
        '    # on a proxy in front. Set both to serve it here instead.',
        '    ssl_keyfile=settings.get("tls_key") or None,',
        '    ssl_certfile=settings.get("tls_cert") or None,',
        '    log_config=None,  # structured JSON logging is configured in build_context',
        ')',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'run_worker_role',
      params: [{ name: 'settings', type: 'Map<string, Any>' }],
      returns: 'Void',
      doc: [
        'The worker loop.',
        '',
        'A worker holds no long-lived secret: the root key is not on it, only',
        'per-job leases are. The sandbox pool additionally has no Postgres route and',
        'no credential lease at all, which is enforced by its Redis ACL and its',
        'network, not by this code being careful.',
      ].join('\n'),
      implName: 'start_worker_process',
      capabilities: ['net', 'process', 'stdio'],
      code: [
        'context = build_service_context(settings)',
        'pool = settings.get("worker_pool", "default")',
        'worker_id = new_id("wrk")',
        'stream = "jobs:" + pool',
        '',
        'while True:',
        '    heartbeat(context["db"], worker_id, pool)',
        '    claimed = context["queue"].claim(stream, worker_id)',
        '    if not claimed:',
        '        continue',
        '    try:',
        '        handle_job(context["db"], context["queue"], context["secrets"],',
        '                   claimed["job"], worker_id)',
        '    except Exception as failure:  # noqa: BLE001 - the loop outlives the job',
        '        # A job that raises is one client having a bad day. Killing the',
        '        # worker over it stops every other client too, and the restart',
        '        # picks up the same job and dies again.',
        '        log_event("error", "job_failed", {',
        '            "worker": worker_id, "kind": claimed["job"].get("kind"),',
        '            "org_id": claimed["job"].get("org_id"),',
        '            "error": str(failure)[:500],',
        '        })',
        '    finally:',
        '        # Acknowledged either way: a job that failed has a recorded failure,',
        '        # and leaving it pending would only make it run again unrecorded.',
        '        context["queue"].acknowledge(stream, claimed["job_id"])',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'run_ingest_role',
      params: [{ name: 'settings', type: 'Map<string, Any>' }],
      returns: 'Void',
      doc: 'Listeners: scheduled SIEM queries, feed polling, syslog. Separate from the API so an ingest flood cannot starve analyst requests.',
      implName: 'start_ingest_process',
      capabilities: ['net', 'stdio'],
      code: [
        'import time',
        '',
        'context = build_service_context(settings)',
        'while True:',
        '    run_due_schedules(context)',
        '    poll_enabled_feeds(context)',
        '    # The other half of ingest: the estate that cannot push to us.',
        '    poll_alert_sources(context)',
        '    # Scheduled hunts, on the same tick. Exact-minute matching means',
        '    # this is a cheap query that almost always returns nothing.',
        '    queue_due_hunts(context)',
        '    time.sleep(10)',
      ].join('\n'),
    });

    exports_(main.file, [
      { name: 'cli_command', sort: 'function' },
      { name: 'run_cli_command', sort: 'function' },
      { name: 'run_api_role', sort: 'function' },
      { name: 'run_worker_role', sort: 'function' },
      { name: 'run_ingest_role', sort: 'function' },
    ]);
    imports_(main.file, find('src/platform/config.py'), ['load_settings']);
    imports_(main.file, find('src/execution/worker.py'), ['handle_job', 'heartbeat']);
    imports_(main.file, idsFile, ['new_id']);
  }

  void addFile;
  void auditFile;

  iface(api, [
    { name: 'dispatch_request', kind: 'function', doc: 'The request pipeline, in gate order.' },
    { name: 'route_table', kind: 'function', doc: 'Every endpoint with its permission and rate limit.' },
    { name: 'ingest_event', kind: 'function', doc: 'Inbound events that cannot name a playbook.' },
    { name: 'verify_webhook', kind: 'function', doc: 'Signature, freshness and replay.' },
  ]);

  return api;
}
