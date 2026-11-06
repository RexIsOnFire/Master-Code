/**
 * Core platform modules: platform, storage, secrets, audit, identity.
 *
 * These are the five that everything else depends on, and the four ports that
 * Phase 2 and Phase 3 swap out (relational, object store, secrets provider, and
 * - in m-automation - the job queue) are all declared here.
 */

import { addModule } from '#core/project/builder.ts';
import type { ProjectModule } from '#core/model/project.ts';
import type { Ctx } from './kit.ts';
import { exports_, fnWithBody, iface, imports_, methodWithBody, note, py } from './kit.ts';

export interface CoreModules {
  platform: ProjectModule;
  storage: ProjectModule;
  secrets: ProjectModule;
  audit: ProjectModule;
  identity: ProjectModule;
}

export function buildCore(ctx: Ctx): CoreModules {
  const platform = addModule(ctx.project, {
    name: 'platform',
    directory: 'src/soar/platform',
    description: 'Configuration, identifiers, clock, error classification and secret-aware redaction. Depends on nothing.',
  });
  const storage = addModule(ctx.project, {
    name: 'storage',
    directory: 'src/soar/storage',
    description: 'The relational port and the object-store port. Every adapter that a later phase swaps lives behind these two.',
    dependencies: [platform.id],
  });
  const secrets = addModule(ctx.project, {
    name: 'secrets',
    directory: 'src/soar/secrets',
    description: 'Credential sealing and the SecretProvider port. No plaintext credential exists outside a lease.',
    dependencies: [platform.id, storage.id],
  });
  const audit = addModule(ctx.project, {
    name: 'audit',
    directory: 'src/soar/audit',
    description: 'Append-only, hash-chained audit. Insert-only at the database role level as well as in code.',
    dependencies: [platform.id, storage.id],
  });
  const identity = addModule(ctx.project, {
    name: 'identity',
    directory: 'src/soar/identity',
    description: 'Users, passwords, MFA, sessions and RBAC. Permission is checked at the point of effect.',
    dependencies: [platform.id, storage.id, audit.id],
  });

  // -------------------------------------------------------------------------
  // platform/config.py
  // -------------------------------------------------------------------------
  const config = py(ctx, {
    path: 'src/platform/config.py',
    module: platform,
    doc: 'configuration',
    style: 'procedural',
  });
  {
    const g = config.g;

    // The defaults are drawn, not hidden in code, because the set of knobs a
    // deployment has is exactly the set of things that change between Phase 1
    // and Phase 3. Seeing them on the canvas is the point.
    const defaults = g.add('entry/function', {
      name: 'default_settings',
      params: [],
      returns: 'Map<string, Any>',
      doc: 'Every setting the platform reads, with its single-machine default.',
    });
    const m = g.add('map/literal', { keyType: 'string', valueType: 'Any' });
    const pairs: [string, string][] = [
      ['role', 'serve'],
      ['bind_host', '127.0.0.1'],
      ['bind_port', '8443'],
      ['database_url', 'postgresql://soar_app@postgres:5432/soar?sslmode=require'],
      ['redis_url', 'redis://redis:6379/0'],
      ['object_store_url', 'file:///data/objects'],
      ['secrets_provider', 'local'],
      ['ai_provider_default', 'ollama'],
      ['ai_local_only', 'false'],
      ['executor', 'container'],
      ['worker_pool', 'default'],
      ['worker_concurrency', '2'],
      ['sandbox_pool', 'sandbox'],
      ['step_budget', '500'],
      ['execution_wallclock_s', '3600'],
      ['approval_default_timeout_s', '1800'],
      ['session_ttl_s', '28800'],
      ['require_mfa_for_response', 'true'],
      ['require_dual_publish', 'false'],
      ['egress_proxy', ''],
      ['audit_mirror_url', ''],
      ['log_level', 'info'],
      // Declared, or read_environment_overrides never copies SOAR_JOB_SIGNING_KEY
      // in and build_service_context refuses to start every role in the product.
      ['job_signing_key', ''],
      // Read by the CORS gate. Undeclared it could never be set, so the browser
      // origin list was unconfigurable rather than merely empty.
      ['allowed_origins', ''],
      // Empty means plain HTTP on the bind port, which is what the compose file
      // expects behind a proxy. Set both to serve TLS directly.
      ['tls_cert', ''],
      ['tls_key', ''],
      // First boot may write a root key; a later boot may not. A missing key on a
      // running system means something is wrong, and inventing one would destroy
      // every credential rather than reveal the problem.
      ['allow_key_creation', 'false'],
    ];
    // map/literal materialises one k/v pair; the rest are variadic slots, which
    // is exactly what a user gets by clicking "add pair" in the editor.
    pairs.forEach(([k, v], i) => {
      const kid = i === 0 ? 'k' : g.addVariadic(m, 'k', 'in');
      const vid = i === 0 ? 'v' : g.addVariadic(m, 'v', 'in');
      g.setDefault(m, kid, k);
      g.setDefault(m, vid, v);
    });
    const retDefaults = g.add('control/return');
    g.connect(m, 'map', retDefaults, 'value');
    g.chain([defaults, 'out'], retDefaults);

    fnWithBody(g, {
      name: 'load_settings',
      returns: 'Map<string, Any>',
      doc: 'Defaults, overlaid by SOAR_* environment variables. Nothing else is consulted.',
      implName: 'read_environment_overrides',
      capabilities: ['env'],
      code: [
        'import os',
        '',
        'settings = default_settings()',
        'for key in list(settings.keys()):',
        '    env_name = "SOAR_" + key.upper()',
        '    if env_name in os.environ:',
        '        settings[key] = os.environ[env_name]',
        '',
        '# A missing root key is a refusal to start, never a generated default at',
        '# run time. The key is created once, by first boot, with mode 0600.',
        'settings["root_key_path"] = os.environ.get("SOAR_ROOT_KEY_PATH", "/data/keys/root.key")',
        'settings["root_key_inline"] = os.environ.get("SOAR_ROOT_KEY", "")',
        'return settings',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'require_setting',
      params: [
        { name: 'settings', type: 'Map<string, Any>' },
        { name: 'key', type: 'string' },
      ],
      returns: 'string',
      doc: 'Read a setting or fail loudly. There is no silent empty string.',
      implName: 'lookup_required_setting',
      code: [
        'value = settings.get(key)',
        'if value is None or value == "":',
        '    raise RuntimeError(',
        '        "setting \'%s\' is not configured; set SOAR_%s" % (key, key.upper())',
        '    )',
        'return str(value)',
      ].join('\n'),
    });

    exports_(config.file, [
      { name: 'default_settings', sort: 'function', doc: 'Every setting with its single-machine default.' },
      { name: 'load_settings', sort: 'function', doc: 'Defaults overlaid by the environment.' },
      { name: 'require_setting', sort: 'function', doc: 'Read a setting or raise.' },
    ]);
  }

  // -------------------------------------------------------------------------
  // platform/ids.py
  // -------------------------------------------------------------------------
  const ids = py(ctx, { path: 'src/platform/ids.py', module: platform, doc: 'identifiers', style: 'functional' });
  {
    const g = ids.g;
    fnWithBody(g, {
      name: 'new_id',
      params: [{ name: 'prefix', type: 'string' }],
      returns: 'string',
      doc: 'A sortable, type-revealing identifier: inc_01J9XК..., exec_01J9...',
      implName: 'make_ulid',
      capabilities: ['random', 'time'],
      code: [
        'import os',
        'import time',
        '',
        'ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"',
        '',
        '# Crockford base32 over 48 bits of millisecond time and 80 bits of entropy.',
        '# Sortable by creation, safe in a URL, and the prefix says what it is when',
        '# it turns up alone in a log line a year later.',
        'value = (int(time.time() * 1000) << 80) | int.from_bytes(os.urandom(10), "big")',
        'out = []',
        'for _ in range(26):',
        '    out.append(ALPHABET[value & 0x1F])',
        '    value >>= 5',
        'return prefix + "_" + "".join(reversed(out))',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'execution_label',
      params: [
        { name: 'year', type: 'i64' },
        { name: 'sequence', type: 'i64' },
      ],
      returns: 'string',
      doc: 'The human-facing execution label: EXEC-2026-000123.',
      implName: 'format_execution_label',
      code: 'return "EXEC-%04d-%06d" % (int(year), int(sequence))',
    });

    fnWithBody(g, {
      name: 'now_iso',
      returns: 'string',
      doc: 'UTC, ISO 8601, microseconds. One clock, called from one place.',
      implName: 'utc_now_iso',
      capabilities: ['time'],
      code: [
        'import datetime',
        '',
        'return datetime.datetime.now(datetime.timezone.utc).isoformat()',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'iso_hours_ago',
      params: [{ name: 'hours', type: 'i64' }],
      returns: 'string',
      doc: 'A point in the past, in the same format every watermark is written in. Used to give a source that has never polled a starting point that is not the beginning of time.',
      implName: 'utc_hours_ago_iso',
      capabilities: ['time'],
      code: [
        'import datetime',
        '',
        'moment = (datetime.datetime.now(datetime.timezone.utc)',
        '          - datetime.timedelta(hours=hours))',
        'return moment.isoformat()',
      ].join('\n'),
    });

    exports_(ids.file, [
      { name: 'new_id', sort: 'function', doc: 'Prefixed ULID.' },
      { name: 'execution_label', sort: 'function' },
      { name: 'now_iso', sort: 'function' },
      { name: 'iso_hours_ago', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // platform/redact.py  -- the control behind threat T13
  // -------------------------------------------------------------------------
  const redact = py(ctx, { path: 'src/platform/redact.py', module: platform, doc: 'secret-aware redaction', style: 'object-oriented' });
  {
    const g = redact.g;
    g.add('oop/class', {
      name: 'SecretValue',
      shape: 'class',
      doc: [
        'A string that knows it is secret.',
        '',
        'Redaction is by type, not by pattern. A regular expression over log output',
        'can only redact the credential shapes someone thought of; a value that',
        'carries its own marking is redacted wherever it ends up, including places',
        'nobody anticipated. str() and repr() return the mask; reveal() is the one',
        'deliberate, greppable way to get the plaintext.',
      ].join('\n'),
      fields: [
        { name: 'plaintext', type: 'string', visibility: 'private' },
        { name: 'reference', type: 'string', visibility: 'public' },
      ],
    });
    g.add('oop/constructor', {
      className: 'SecretValue',
      params: [
        { name: 'plaintext', type: 'string' },
        { name: 'reference', type: 'string' },
      ],
    });
    methodWithBody(g, {
      className: 'SecretValue',
      name: 'reveal',
      returns: 'string',
      doc: 'The plaintext. Every call site is meant to be findable by grep.',
      implName: 'secret_reveal',
      code: 'return self.plaintext',
    });
    methodWithBody(g, {
      className: 'SecretValue',
      name: 'masked',
      returns: 'string',
      doc: 'What a log, an audit record or an execution step sees.',
      implName: 'secret_masked',
      code: 'return "***[" + str(self.reference) + "]***"',
    });

    fnWithBody(g, {
      name: 'redacting_encoder',
      params: [{ name: 'value', type: 'Any' }],
      returns: 'Any',
      doc: 'Recursively replace SecretValue with its mask before serialisation.',
      implName: 'walk_and_redact',
      code: [
        'if isinstance(value, SecretValue):',
        '    return value.masked()',
        'if isinstance(value, dict):',
        '    return {k: redacting_encoder(v) for k, v in value.items()}',
        'if isinstance(value, (list, tuple)):',
        '    return [redacting_encoder(v) for v in value]',
        'return value',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'looks_like_credential',
      params: [{ name: 'text', type: 'string' }],
      returns: 'bool',
      doc: 'Defence in depth: flag credential SHAPES in command output. A hit raises a platform alert rather than silently redacting, because silent redaction teaches nobody anything.',
      implName: 'credential_shape_scan',
      code: [
        'import re',
        '',
        'PATTERNS = [',
        '    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",',
        '    r"\\bAKIA[0-9A-Z]{16}\\b",',
        '    r"\\bgh[pousr]_[A-Za-z0-9]{36,}\\b",',
        '    r"\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b",',
        '    r"\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b",',
        ']',
        'for pattern in PATTERNS:',
        '    if re.search(pattern, text or ""):',
        '        return True',
        'return False',
      ].join('\n'),
    });

    exports_(redact.file, [
      { name: 'SecretValue', sort: 'class', doc: 'A string that carries its own redaction.' },
      { name: 'redacting_encoder', sort: 'function' },
      { name: 'looks_like_credential', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // platform/errors.py
  // -------------------------------------------------------------------------
  const errors = py(ctx, { path: 'src/platform/errors.py', module: platform, doc: 'error classification', style: 'procedural' });
  {
    const g = errors.g;
    g.add('oop/enum', {
      name: 'ErrorClass',
      variants: ['TRANSIENT', 'RATE_LIMITED', 'AUTH', 'NOT_FOUND', 'VALIDATION', 'POLICY', 'PERMANENT'],
      doc: 'Why a step failed. Retry policy reads this, never the message text.',
    });

    // Drawn rather than written: the retry decision is the thing an engineer
    // most wants to see and change without editing code.
    const retryable = g.add('entry/function', {
      name: 'is_retryable',
      params: [{ name: 'error_class', type: 'string' }],
      returns: 'bool',
      doc: 'Only TRANSIENT and RATE_LIMITED are retried. A 401 retried is an account lockout, not a recovery.',
    });
    const retrySet = g.add('list/literal', { itemType: 'string' });
    g.setDefault(retrySet, 'e', 'TRANSIENT');
    g.setDefault(retrySet, g.addVariadic(retrySet, 'e', 'in'), 'RATE_LIMITED');
    const contains = g.add('list/contains');
    const retRetry = g.add('control/return');
    g.connect(retrySet, 'list', contains, 'a0');
    g.connect(retryable, 'p:error_class', contains, 'a1');
    g.connect(contains, 'found', retRetry, 'value');
    g.chain([retryable, 'out'], retRetry);

    fnWithBody(g, {
      name: 'classify_http_status',
      params: [{ name: 'status', type: 'i64' }],
      returns: 'string',
      doc: 'Map a vendor HTTP status onto an ErrorClass. Explicit, because guessing from a message is how a platform retries a permission error forever.',
      implName: 'http_status_to_class',
      code: [
        'code = int(status)',
        'if code == 429:',
        '    return "RATE_LIMITED"',
        'if code in (401, 403):',
        '    return "AUTH"',
        'if code == 404:',
        '    return "NOT_FOUND"',
        'if code in (408, 425, 502, 503, 504):',
        '    return "TRANSIENT"',
        'if 400 <= code < 500:',
        '    return "VALIDATION"',
        'if code >= 500:',
        '    return "TRANSIENT"',
        'return "PERMANENT"',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'backoff_ms',
      params: [
        { name: 'attempt', type: 'i64' },
        { name: 'base_ms', type: 'i64' },
      ],
      returns: 'i64',
      doc: 'Exponential backoff with full jitter, capped. Jitter matters: a hundred playbooks retrying in lockstep is a self-inflicted outage.',
      implName: 'compute_backoff',
      capabilities: ['random'],
      code: [
        'import random',
        '',
        'ceiling = min(int(base_ms) * (2 ** max(0, int(attempt) - 1)), 60000)',
        'return int(random.uniform(0, ceiling))',
      ].join('\n'),
    });

    exports_(errors.file, [
      { name: 'ErrorClass', sort: 'enum' },
      { name: 'is_retryable', sort: 'function' },
      { name: 'classify_http_status', sort: 'function' },
      { name: 'backoff_ms', sort: 'function' },
    ]);
  }

  iface(platform, [
    { name: 'load_settings', kind: 'function', doc: 'Configuration, defaults overlaid by the environment.' },
    { name: 'new_id', kind: 'function', doc: 'Prefixed, sortable identifiers.' },
    { name: 'SecretValue', kind: 'class', doc: 'A string that carries its own redaction.' },
    { name: 'is_retryable', kind: 'function', doc: 'Retry decision, by error class.' },
  ]);

  // -------------------------------------------------------------------------
  // storage/db.py  -- the relational port
  // -------------------------------------------------------------------------
  const db = py(ctx, { path: 'src/storage/db.py', module: storage, doc: 'relational port', style: 'object-oriented' });
  {
    const g = db.g;
    g.add('oop/class', {
      name: 'Database',
      shape: 'class',
      doc: [
        'The relational port.',
        '',
        'Every query in the platform goes through query()/execute(), and both take',
        'parameters separately. There is no method on this class that accepts an',
        'assembled SQL string with values already in it, which is what makes',
        '"the platform is free of SQL injection" a structural claim rather than a',
        'review habit.',
        '',
        'Phase 1 binds this to a local container; Phase 3 binds it to Patroni or a',
        'managed instance behind PgBouncer. The caller never changes.',
      ].join('\n'),
      fields: [
        { name: 'dsn', type: 'string', visibility: 'private' },
        { name: 'pool', type: 'Any', visibility: 'private' },
        { name: 'role', type: 'string', visibility: 'public' },
      ],
    });
    g.add('oop/constructor', {
      className: 'Database',
      params: [
        { name: 'dsn', type: 'string' },
        { name: 'role', type: 'string' },
      ],
    });
    methodWithBody(g, {
      className: 'Database',
      name: 'connect',
      returns: 'Void',
      doc: 'Open the pool. TLS is required, not preferred.',
      implName: 'database_connect',
      capabilities: ['net'],
      packages: [{ name: 'psycopg[binary,pool]', version: '3.2.*' }],
      code: [
        'from psycopg_pool import ConnectionPool',
        '',
        'if "sslmode=" not in self.dsn:',
        '    raise RuntimeError("database dsn must state an sslmode; require or verify-full")',
        'self.pool = ConnectionPool(self.dsn, min_size=1, max_size=10, open=True)',
      ].join('\n'),
    });
    methodWithBody(g, {
      className: 'Database',
      name: 'query',
      params: [
        { name: 'sql', type: 'string' },
        { name: 'params', type: 'List<Any>' },
        { name: 'org_id', type: 'string' },
      ],
      returns: 'List<Map<string, Any>>',
      doc: 'Parameterised read. org_id is set as a session variable so row-level security applies even if a WHERE clause is forgotten.',
      implName: 'database_query',
      capabilities: ['net'],
      code: [
        'from psycopg.rows import dict_row',
        '',
        'with self.pool.connection() as conn:',
        '    with conn.cursor(row_factory=dict_row) as cur:',
        '        cur.execute("SELECT set_config(\'soar.org_id\', %s, true)", (org_id,))',
        '        cur.execute(sql, tuple(params))',
        '        return list(cur.fetchall())',
      ].join('\n'),
    });
    methodWithBody(g, {
      className: 'Database',
      name: 'execute',
      params: [
        { name: 'sql', type: 'string' },
        { name: 'params', type: 'List<Any>' },
        { name: 'org_id', type: 'string' },
      ],
      returns: 'i64',
      doc: 'Parameterised write. Returns the affected row count.',
      implName: 'database_execute',
      capabilities: ['net'],
      code: [
        'with self.pool.connection() as conn:',
        '    with conn.cursor() as cur:',
        '        cur.execute("SELECT set_config(\'soar.org_id\', %s, true)", (org_id,))',
        '        cur.execute(sql, tuple(params))',
        '        return cur.rowcount',
      ].join('\n'),
    });
    methodWithBody(g, {
      className: 'Database',
      name: 'execute_many',
      params: [
        { name: 'sql', type: 'string' },
        { name: 'rows', type: 'List<Any>' },
        { name: 'org_id', type: 'string' },
      ],
      returns: 'i64',
      doc: [
        'One statement, many parameter sets, one round trip.',
        '',
        'Here for feed ingestion and the ATT&CK bundle, which arrive as tens of',
        'thousands of rows at a time. The same work as a loop of execute() calls, at',
        'a fraction of the round trips - and in one transaction, so a feed that fails',
        'halfway does not leave the intel table half updated.',
      ].join('\n'),
      implName: 'database_execute_many',
      capabilities: ['net'],
      code: [
        'if not rows:',
        '    return 0',
        'with self.pool.connection() as conn:',
        '    with conn.cursor() as cur:',
        '        cur.execute("SELECT set_config(\'soar.org_id\', %s, true)", (org_id,))',
        '        cur.executemany(sql, [tuple(row) for row in rows])',
        '        return len(rows)',
      ].join('\n'),
    });

    methodWithBody(g, {
      className: 'Database',
      name: 'claim_step',
      params: [
        { name: 'step_id', type: 'string' },
        { name: 'worker_id', type: 'string' },
        { name: 'org_id', type: 'string' },
      ],
      returns: 'bool',
      doc: [
        'The conditional update that makes redelivery safe.',
        '',
        'A queue that promises at-least-once will occasionally deliver a',
        'containment job twice. This is the line that stops the second delivery',
        'from isolating the host again: the transition out of queued happens once,',
        'in the database, and the loser acknowledges without acting.',
      ].join('\n'),
      implName: 'database_claim_step',
      capabilities: ['net'],
      code: [
        'affected = self.execute(',
        '    "UPDATE execution_step SET status = \'running\', worker_id = %s, started_at = now() "',
        '    "WHERE id = %s AND status = \'queued\'",',
        '    [worker_id, step_id],',
        '    org_id,',
        ')',
        'return affected == 1',
      ].join('\n'),
    });
    methodWithBody(g, {
      className: 'Database',
      name: 'health',
      returns: 'bool',
      doc: 'Readiness probe backing /readyz.',
      implName: 'database_health',
      capabilities: ['net'],
      code: [
        'try:',
        '    with self.pool.connection() as conn:',
        '        with conn.cursor() as cur:',
        '            cur.execute("SELECT 1")',
        '            return cur.fetchone() is not None',
        'except Exception:',
        '    return False',
      ].join('\n'),
    });
    exports_(db.file, [{ name: 'Database', sort: 'class', doc: 'The relational port.' }]);
  }

  // -------------------------------------------------------------------------
  // storage/schema.py
  // -------------------------------------------------------------------------
  const schema = py(ctx, { path: 'src/storage/schema.py', module: storage, doc: 'schema and migrations', style: 'procedural' });
  {
    const g = schema.g;
    fnWithBody(g, {
      name: 'migrations',
      returns: 'List<Map<string, Any>>',
      doc: 'Ordered, immutable migrations. See docs/data-model.md for why each table looks the way it does.',
      implName: 'migration_list',
      code: [
        'return [',
        '    {',
        '        "version": 1,',
        '        "name": "foundation",',
        '        "sql": [',
        '            "CREATE EXTENSION IF NOT EXISTS citext",',
        '            """CREATE TABLE organisation (',
        '                 id text PRIMARY KEY,',
        '                 name text NOT NULL,',
        '                 slug text NOT NULL UNIQUE,',
        '                 settings jsonb NOT NULL DEFAULT \'{}\',',
        '                 status text NOT NULL DEFAULT \'active\',',
        '                 created_at timestamptz NOT NULL DEFAULT now())""",',
        '            """CREATE TABLE app_user (',
        '                 id text PRIMARY KEY,',
        '                 org_id text NOT NULL REFERENCES organisation(id),',
        '                 email citext NOT NULL,',
        '                 display_name text NOT NULL,',
        '                 password_hash text NOT NULL,',
        '                 mfa_secret bytea,',
        '                 mfa_enrolled_at timestamptz,',
        '                 status text NOT NULL DEFAULT \'active\',',
        '                 failed_attempts int NOT NULL DEFAULT 0,',
        '                 last_login_at timestamptz,',
        '                 created_at timestamptz NOT NULL DEFAULT now(),',
        '                 UNIQUE (org_id, email))""",',
        '            """CREATE TABLE role (',
        '                 id text PRIMARY KEY,',
        '                 org_id text NOT NULL REFERENCES organisation(id),',
        '                 name text NOT NULL,',
        '                 description text,',
        '                 builtin boolean NOT NULL DEFAULT false,',
        '                 UNIQUE (org_id, name))""",',
        '            """CREATE TABLE role_permission (',
        '                 role_id text NOT NULL REFERENCES role(id) ON DELETE CASCADE,',
        '                 permission text NOT NULL,',
        '                 PRIMARY KEY (role_id, permission))""",',
        '            """CREATE TABLE user_role (',
        '                 user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,',
        '                 role_id text NOT NULL REFERENCES role(id) ON DELETE CASCADE,',
        '                 granted_by text, granted_at timestamptz NOT NULL DEFAULT now(),',
        '                 PRIMARY KEY (user_id, role_id))""",',
        '        ],',
        '    },',
        '    {',
        '        "version": 2,',
        '        "name": "incidents",',
        '        "sql": [',
        '            """CREATE TABLE event (',
        '                 id text PRIMARY KEY,',
        '                 org_id text NOT NULL,',
        '                 source_id text NOT NULL,',
        '                 received_at timestamptz NOT NULL DEFAULT now(),',
        '                 raw jsonb NOT NULL,',
        '                 raw_sha256 bytea NOT NULL,',
        '                 signature_verified boolean NOT NULL DEFAULT false,',
        '                 dedupe_key text)""",',
        '            """CREATE TABLE incident (',
        '                 id text PRIMARY KEY,',
        '                 org_id text NOT NULL,',
        '                 number bigint NOT NULL,',
        '                 title text NOT NULL,',
        '                 description text,',
        '                 severity text NOT NULL,',
        '                 priority text,',
        '                 status text NOT NULL DEFAULT \'new\',',
        '                 resolution text,',
        '                 assignee_id text,',
        '                 team_id text,',
        '                 created_at timestamptz NOT NULL DEFAULT now(),',
        '                 acknowledged_at timestamptz,',
        '                 contained_at timestamptz,',
        '                 closed_at timestamptz,',
        '                 sla_ack_due timestamptz,',
        '                 sla_resolve_due timestamptz,',
        '                 technique_ids text[] NOT NULL DEFAULT \'{}\',',
        '                 tags text[] NOT NULL DEFAULT \'{}\',',
        '                 ai_risk_score smallint,',
        '                 UNIQUE (org_id, number))""",',
        '            """CREATE TABLE alert (',
        '                 id text PRIMARY KEY,',
        '                 org_id text NOT NULL,',
        '                 event_id text REFERENCES event(id),',
        '                 source text NOT NULL,',
        '                 vendor_alert_id text NOT NULL,',
        '                 title text NOT NULL,',
        '                 description text,',
        '                 severity text NOT NULL,',
        '                 confidence smallint,',
        '                 category text,',
        '                 technique_ids text[] NOT NULL DEFAULT \'{}\',',
        '                 observed_at timestamptz NOT NULL,',
        '                 ingested_at timestamptz NOT NULL DEFAULT now(),',
        '                 status text NOT NULL DEFAULT \'new\',',
        '                 incident_id text REFERENCES incident(id),',
        '                 entities jsonb NOT NULL DEFAULT \'[]\',',
        '                 indicators jsonb NOT NULL DEFAULT \'[]\',',
        '                 normalisation_version int NOT NULL DEFAULT 1,',
        '                 UNIQUE (org_id, source, vendor_alert_id))""",',
        '            """CREATE TABLE timeline_entry (',
        '                 id text PRIMARY KEY,',
        '                 org_id text NOT NULL,',
        '                 incident_id text NOT NULL REFERENCES incident(id) ON DELETE CASCADE,',
        '                 at timestamptz NOT NULL DEFAULT now(),',
        '                 seq bigint NOT NULL,',
        '                 kind text NOT NULL,',
        '                 actor_kind text NOT NULL,',
        '                 actor_id text,',
        '                 summary text NOT NULL,',
        '                 detail jsonb NOT NULL DEFAULT \'{}\',',
        '                 execution_id text, step_id text, ai_session_id text,',
        '                 UNIQUE (incident_id, seq))""",',
        '            "CREATE INDEX incident_board ON incident (org_id, status, severity, created_at DESC)",',
        '            "CREATE INDEX alert_queue ON alert (org_id, status, observed_at DESC)",',
        '        ],',
        '    },',
        '    {',
        '        "version": 3,',
        '        "name": "automation",',
        '        "sql": [',
        '            """CREATE TABLE credential (',
        '                 id text PRIMARY KEY,',
        '                 org_id text NOT NULL,',
        '                 name text NOT NULL,',
        '                 kind text NOT NULL,',
        '                 ciphertext bytea, nonce bytea, wrapped_key bytea,',
        '                 key_version int NOT NULL DEFAULT 1,',
        '                 provider text NOT NULL DEFAULT \'local\',',
        '                 external_ref text,',
        '                 owner_user_id text, purpose text,',
        '                 rotation_due_at timestamptz, last_used_at timestamptz,',
        '                 created_at timestamptz NOT NULL DEFAULT now(),',
        '                 UNIQUE (org_id, name))""",',
        '            """CREATE TABLE integration (',
        '                 id text PRIMARY KEY,',
        '                 org_id text NOT NULL,',
        '                 connector_id text NOT NULL,',
        '                 connector_version text NOT NULL,',
        '                 name text NOT NULL,',
        '                 config jsonb NOT NULL DEFAULT \'{}\',',
        '                 credential_id text REFERENCES credential(id),',
        '                 enabled boolean NOT NULL DEFAULT true,',
        '                 health text NOT NULL DEFAULT \'unknown\',',
        '                 last_check_at timestamptz, last_error text,',
        '                 worker_pool text NOT NULL DEFAULT \'default\',',
        '                 egress_allowlist text[] NOT NULL DEFAULT \'{}\',',
        '                 UNIQUE (org_id, name))""",',
        '            """CREATE TABLE command (',
        '                 id text PRIMARY KEY, org_id text,',
        '                 key text NOT NULL, name text NOT NULL, category text,',
        '                 integration_id text REFERENCES integration(id),',
        '                 trust_level text NOT NULL DEFAULT \'untrusted\',',
        '                 current_version_id text,',
        '                 created_by text, deprecated boolean NOT NULL DEFAULT false,',
        '                 UNIQUE (org_id, key))""",',
        '            """CREATE TABLE command_version (',
        '                 id text PRIMARY KEY,',
        '                 command_id text NOT NULL REFERENCES command(id) ON DELETE CASCADE,',
        '                 version int NOT NULL, state text NOT NULL DEFAULT \'draft\',',
        '                 kind text NOT NULL,',
        '                 input_schema jsonb NOT NULL, output_schema jsonb NOT NULL,',
        '                 implementation jsonb NOT NULL,',
        '                 required_permissions text[] NOT NULL DEFAULT \'{}\',',
        '                 required_capabilities text[] NOT NULL DEFAULT \'{}\',',
        '                 auth jsonb NOT NULL DEFAULT \'[]\',',
        '                 timeout_ms int NOT NULL DEFAULT 30000,',
        '                 risk_level text NOT NULL DEFAULT \'low\',',
        '                 effect text NOT NULL DEFAULT \'read\',',
        '                 content_sha256 bytea NOT NULL,',
        '                 signature bytea, publisher text,',
        '                 created_by text, published_at timestamptz, published_by text,',
        '                 UNIQUE (command_id, version))""",',
        '            """CREATE TABLE playbook (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 key text NOT NULL, name text NOT NULL, description text,',
        '                 category text, current_version_id text, owner_id text,',
        '                 technique_ids text[] NOT NULL DEFAULT \'{}\',',
        '                 UNIQUE (org_id, key))""",',
        '            """CREATE TABLE playbook_version (',
        '                 id text PRIMARY KEY,',
        '                 playbook_id text NOT NULL REFERENCES playbook(id) ON DELETE CASCADE,',
        '                 version int NOT NULL, state text NOT NULL DEFAULT \'draft\',',
        '                 definition jsonb NOT NULL, input_schema jsonb NOT NULL DEFAULT \'{}\',',
        '                 content_sha256 bytea NOT NULL,',
        '                 created_by text, created_at timestamptz NOT NULL DEFAULT now(),',
        '                 published_by text, published_at timestamptz,',
        '                 test_results jsonb, notes text,',
        '                 UNIQUE (playbook_id, version))""",',
        '            """CREATE TABLE trigger (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 kind text NOT NULL,',
        '                 playbook_id text NOT NULL REFERENCES playbook(id),',
        '                 condition jsonb NOT NULL DEFAULT \'{}\',',
        '                 enabled boolean NOT NULL DEFAULT true,',
        '                 dedupe_window_s int NOT NULL DEFAULT 0,',
        '                 created_by text)""",',
        '            """CREATE TABLE execution (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 label text NOT NULL,',
        '                 playbook_id text NOT NULL, playbook_version_id text NOT NULL,',
        '                 content_sha256 bytea NOT NULL,',
        '                 incident_id text, case_id text,',
        '                 trigger_kind text NOT NULL, trigger_id text,',
        '                 initiator_kind text NOT NULL, initiator_id text,',
        '                 parent_execution_id text, depth smallint NOT NULL DEFAULT 0,',
        '                 mode text NOT NULL DEFAULT \'live\',',
        '                 status text NOT NULL DEFAULT \'queued\',',
        '                 inputs jsonb NOT NULL DEFAULT \'{}\',',
        '                 outputs jsonb NOT NULL DEFAULT \'{}\',',
        '                 variables jsonb NOT NULL DEFAULT \'{}\',',
        '                 started_at timestamptz, finished_at timestamptz,',
        '                 duration_ms int, step_budget_used int NOT NULL DEFAULT 0,',
        '                 error jsonb, worker_pool text,',
        '                 UNIQUE (org_id, label))""",',
        '            """CREATE TABLE execution_step (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 execution_id text NOT NULL REFERENCES execution(id) ON DELETE CASCADE,',
        '                 node_id text NOT NULL, sequence int NOT NULL,',
        '                 attempt smallint NOT NULL DEFAULT 1,',
        '                 node_kind text NOT NULL, command_version_id text,',
        '                 integration_id text,',
        '                 status text NOT NULL DEFAULT \'pending\',',
        '                 input jsonb, output jsonb, logs jsonb, error jsonb,',
        '                 started_at timestamptz, finished_at timestamptz, duration_ms int,',
        '                 worker_id text, job_id text, approval_id text, ai_turn_id text,',
        '                 retry_of_step_id text, is_compensation boolean NOT NULL DEFAULT false,',
        '                 limits_applied jsonb NOT NULL DEFAULT \'{}\',',
        '                 UNIQUE (execution_id, node_id, attempt))""",',
        '            """CREATE TABLE approval (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 execution_id text, step_id text, incident_id text,',
        '                 requested_by_kind text NOT NULL, requested_by_id text,',
        '                 action_key text NOT NULL, action_summary text NOT NULL,',
        '                 risk_level text NOT NULL,',
        '                 payload jsonb NOT NULL DEFAULT \'{}\',',
        '                 policy_id text, required_permission text,',
        '                 required_approvals smallint NOT NULL DEFAULT 1,',
        '                 separation_of_duty boolean NOT NULL DEFAULT true,',
        '                 status text NOT NULL DEFAULT \'pending\',',
        '                 nonce text NOT NULL,',
        '                 expires_at timestamptz NOT NULL, decided_at timestamptz)""",',
        '            """CREATE TABLE approval_decision (',
        '                 approval_id text NOT NULL REFERENCES approval(id) ON DELETE CASCADE,',
        '                 decider_id text NOT NULL, decision text NOT NULL, reason text,',
        '                 step_up_satisfied boolean NOT NULL DEFAULT false,',
        '                 decided_at timestamptz NOT NULL DEFAULT now(),',
        '                 PRIMARY KEY (approval_id, decider_id))""",',
        '        ],',
        '    },',
        '    {',
        '        "version": 4,',
        '        "name": "intel-and-audit",',
        '        "sql": [',
        '            """CREATE TABLE indicator (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 type text NOT NULL, value text NOT NULL,',
        '                 value_normalised text NOT NULL,',
        '                 first_seen timestamptz NOT NULL DEFAULT now(),',
        '                 last_seen timestamptz NOT NULL DEFAULT now(),',
        '                 sighting_count bigint NOT NULL DEFAULT 0,',
        '                 verdict text NOT NULL DEFAULT \'unknown\',',
        '                 confidence smallint, score smallint, tlp text,',
        '                 expires_at timestamptz, tags text[] NOT NULL DEFAULT \'{}\',',
        '                 is_whitelisted boolean NOT NULL DEFAULT false,',
        '                 UNIQUE (org_id, type, value_normalised))""",',
        '            """CREATE TABLE sighting (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 indicator_id text NOT NULL REFERENCES indicator(id) ON DELETE CASCADE,',
        '                 at timestamptz NOT NULL DEFAULT now(),',
        '                 context_kind text NOT NULL, context_id text,',
        '                 source text, verdict_at_time text, raw jsonb)""",',
        '            """CREATE TABLE enrichment (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 indicator_id text NOT NULL REFERENCES indicator(id) ON DELETE CASCADE,',
        '                 provider text NOT NULL,',
        '                 requested_at timestamptz NOT NULL DEFAULT now(),',
        '                 expires_at timestamptz NOT NULL,',
        '                 verdict text, score smallint,',
        '                 raw jsonb, normalised jsonb, execution_id text,',
        '                 UNIQUE (org_id, indicator_id, provider))""",',
        '            """CREATE TABLE host (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 hostname text NOT NULL, fqdn text, os text, os_version text,',
        '                 ip_addresses inet[] NOT NULL DEFAULT \'{}\',',
        '                 criticality text NOT NULL DEFAULT \'normal\',',
        '                 owner_user_id text, site text,',
        '                 agent_ids jsonb NOT NULL DEFAULT \'{}\',',
        '                 isolated boolean NOT NULL DEFAULT false, isolated_at timestamptz,',
        '                 last_seen_at timestamptz,',
        '                 UNIQUE (org_id, hostname))""",',
        '            """CREATE TABLE identity_entity (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 upn text NOT NULL, display_name text, email text, department text,',
        '                 privileged boolean NOT NULL DEFAULT false,',
        '                 mfa_enrolled boolean, status text, risk_score smallint,',
        '                 external_ids jsonb NOT NULL DEFAULT \'{}\',',
        '                 UNIQUE (org_id, upn))""",',
        '            """CREATE TABLE incident_entity (',
        '                 incident_id text NOT NULL REFERENCES incident(id) ON DELETE CASCADE,',
        '                 entity_kind text NOT NULL, entity_id text NOT NULL,',
        '                 role text NOT NULL DEFAULT \'related\',',
        '                 added_by text, added_at timestamptz NOT NULL DEFAULT now(),',
        '                 PRIMARY KEY (incident_id, entity_kind, entity_id))""",',
        '            """CREATE TABLE incident_indicator (',
        '                 incident_id text NOT NULL REFERENCES incident(id) ON DELETE CASCADE,',
        '                 indicator_id text NOT NULL REFERENCES indicator(id) ON DELETE CASCADE,',
        '                 role text NOT NULL DEFAULT \'related\',',
        '                 added_by text, added_at timestamptz NOT NULL DEFAULT now(),',
        '                 PRIMARY KEY (incident_id, indicator_id))""",',
        '            """CREATE TABLE mitre_technique (',
        '                 id text PRIMARY KEY, tactic text NOT NULL, name text NOT NULL,',
        '                 description text, platforms text[], revoked boolean NOT NULL DEFAULT false,',
        '                 version text)""",',
        '            """CREATE TABLE audit_event (',
        '                 id text PRIMARY KEY, org_id text NOT NULL,',
        '                 at timestamptz NOT NULL DEFAULT now(),',
        '                 seq bigint NOT NULL, stream text NOT NULL,',
        '                 actor_kind text NOT NULL, actor_id text, actor_label text,',
        '                 on_behalf_of_id text,',
        '                 action text NOT NULL,',
        '                 target_kind text, target_id text, target_label text,',
        '                 source_ip inet, user_agent text, session_id text,',
        '                 correlation_id text, execution_id text, approval_id text,',
        '                 ai_session_id text,',
        '                 before jsonb, after jsonb,',
        '                 result text NOT NULL, reason text,',
        '                 prev_hash bytea, hash bytea NOT NULL,',
        '                 UNIQUE (stream, seq))""",',
        '            "CREATE INDEX audit_by_target ON audit_event (org_id, target_kind, target_id, at DESC)",',
        '        ],',
        '    },',
        '    {',
        '        "version": 5,',
        '        "name": "least-privilege-roles",',
        '        "sql": [',
        '            "REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM PUBLIC",',
        '            "ALTER TABLE incident ENABLE ROW LEVEL SECURITY",',
        '            "ALTER TABLE alert ENABLE ROW LEVEL SECURITY",',
        '            "ALTER TABLE execution ENABLE ROW LEVEL SECURITY",',
        '            "ALTER TABLE credential ENABLE ROW LEVEL SECURITY",',
        '            """CREATE POLICY org_isolation ON incident USING',
        '                 (org_id = current_setting(\'soar.org_id\', true))""",',
        '            """CREATE POLICY org_isolation ON alert USING',
        '                 (org_id = current_setting(\'soar.org_id\', true))""",',
        '            """CREATE POLICY org_isolation ON execution USING',
        '                 (org_id = current_setting(\'soar.org_id\', true))""",',
        '            """CREATE POLICY org_isolation ON credential USING',
        '                 (org_id = current_setting(\'soar.org_id\', true))""",',
        '        ],',
        '    },',
        '] + extra_migrations()',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'apply_migrations',
      params: [{ name: 'dsn', type: 'string' }],
      returns: 'i64',
      doc: 'Run pending migrations under the migrate role. The application roles have no DDL grant, which is why this is a separate entry point and not something the api does at boot.',
      implName: 'run_pending_migrations',
      capabilities: ['net'],
      packages: [{ name: 'psycopg[binary]', version: '3.2.*' }],
      code: [
        'import psycopg',
        '',
        'applied = 0',
        'with psycopg.connect(dsn, autocommit=False) as conn:',
        '    with conn.cursor() as cur:',
        '        cur.execute(',
        '            "CREATE TABLE IF NOT EXISTS migration ("',
        '            " version int PRIMARY KEY, name text NOT NULL,"',
        '            " applied_at timestamptz NOT NULL DEFAULT now())"',
        '        )',
        '        cur.execute("SELECT version FROM migration")',
        '        done = {row[0] for row in cur.fetchall()}',
        '        for migration in migrations():',
        '            if migration["version"] in done:',
        '                continue',
        '            for statement in migration["sql"]:',
        '                cur.execute(statement)',
        '            cur.execute(',
        '                "INSERT INTO migration (version, name) VALUES (%s, %s)",',
        '                (migration["version"], migration["name"]),',
        '            )',
        '            applied += 1',
        '    conn.commit()',
        'return applied',
      ].join('\n'),
    });
    exports_(schema.file, [
      { name: 'migrations', sort: 'function' },
      { name: 'apply_migrations', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // storage/objects.py  -- the object-store port
  // -------------------------------------------------------------------------
  const objects = py(ctx, { path: 'src/storage/objects.py', module: storage, doc: 'object store port', style: 'object-oriented' });
  {
    const g = objects.g;
    g.add('oop/interface', {
      name: 'ObjectStore',
      doc: [
        'Evidence, attachments, reports and AI conversation bodies.',
        '',
        'No module anywhere builds a filesystem path. They ask for a key, which is',
        'derived from a content hash and a validated id. That is simultaneously the',
        'path-traversal mitigation and the reason S3 or Azure Blob is a',
        'configuration change rather than a refactor.',
      ].join('\n'),
      methods: [
        { name: 'put', params: [{ name: 'key', type: 'string' }, { name: 'data', type: 'string' }], returns: 'string' },
        { name: 'get', params: [{ name: 'key', type: 'string' }], returns: 'string' },
        { name: 'exists', params: [{ name: 'key', type: 'string' }], returns: 'bool' },
        { name: 'delete', params: [{ name: 'key', type: 'string' }], returns: 'Void' },
      ],
    });

    fnWithBody(g, {
      name: 'object_key',
      params: [
        { name: 'org_id', type: 'string' },
        { name: 'kind', type: 'string' },
        { name: 'sha256_hex', type: 'string' },
      ],
      returns: 'string',
      doc: 'Content-addressed key. An uploaded filename is metadata; it never reaches a path.',
      implName: 'derive_object_key',
      code: [
        'import re',
        '',
        'if not re.fullmatch(r"[0-9a-f]{64}", sha256_hex or ""):',
        '    raise ValueError("object key requires a lowercase hex sha256")',
        'if not re.fullmatch(r"[a-z_]{1,32}", kind or ""):',
        '    raise ValueError("object kind must be a short lowercase identifier")',
        'if not re.fullmatch(r"org_[0-9A-Z]{26}", org_id or ""):',
        '    raise ValueError("object key requires a valid organisation id")',
        'return "%s/%s/%s/%s/%s" % (org_id, kind, sha256_hex[0:2], sha256_hex[2:4], sha256_hex)',
      ].join('\n'),
    });

    g.add('oop/class', {
      name: 'LocalObjectStore',
      shape: 'class',
      implements: 'ObjectStore',
      doc: 'Phase 1 adapter: a bind-mounted directory. Phase 3 swaps in S3 or Blob with object lock; the ObjectStore interface is unchanged.',
      fields: [{ name: 'root', type: 'string', visibility: 'private' }],
    });
    g.add('oop/constructor', { className: 'LocalObjectStore', params: [{ name: 'root', type: 'string' }] });
    methodWithBody(g, {
      className: 'LocalObjectStore',
      name: 'put',
      params: [{ name: 'key', type: 'string' }, { name: 'data', type: 'string' }],
      returns: 'string',
      doc: 'Write, verifying the key stays inside the root.',
      implName: 'local_store_put',
      capabilities: ['fs.write'],
      code: [
        'import os',
        '',
        'target = os.path.realpath(os.path.join(self.root, key))',
        'root = os.path.realpath(self.root)',
        'if not target.startswith(root + os.sep):',
        '    raise ValueError("object key escaped the store root")',
        'os.makedirs(os.path.dirname(target), exist_ok=True)',
        'with open(target, "wb") as handle:',
        '    handle.write(data.encode("utf-8") if isinstance(data, str) else data)',
        'return key',
      ].join('\n'),
    });
    methodWithBody(g, {
      className: 'LocalObjectStore',
      name: 'get',
      params: [{ name: 'key', type: 'string' }],
      returns: 'string',
      doc: 'Read, with the same containment check.',
      implName: 'local_store_get',
      capabilities: ['fs.read'],
      code: [
        'import os',
        '',
        'target = os.path.realpath(os.path.join(self.root, key))',
        'root = os.path.realpath(self.root)',
        'if not target.startswith(root + os.sep):',
        '    raise ValueError("object key escaped the store root")',
        'with open(target, "rb") as handle:',
        '    return handle.read().decode("utf-8")',
      ].join('\n'),
    });
    exports_(objects.file, [
      { name: 'ObjectStore', sort: 'interface' },
      { name: 'LocalObjectStore', sort: 'class' },
      { name: 'object_key', sort: 'function' },
    ]);
  }

  iface(storage, [
    { name: 'Database', kind: 'class', doc: 'The relational port; parameterised queries only.' },
    { name: 'ObjectStore', kind: 'type', doc: 'The object-store port.' },
    { name: 'apply_migrations', kind: 'function', doc: 'Run pending migrations under the migrate role.' },
  ]);

  // -------------------------------------------------------------------------
  // secrets/sealed.py
  // -------------------------------------------------------------------------
  const sealed = py(ctx, { path: 'src/secrets/sealed.py', module: secrets, doc: 'envelope encryption', style: 'procedural' });
  {
    const g = sealed.g;
    fnWithBody(g, {
      name: 'load_root_key',
      params: [{ name: 'settings', type: 'Map<string, Any>' }],
      returns: 'string',
      doc: 'Environment, then the key file, then refuse to start. There is no third fallback and no insecure mode.',
      implName: 'resolve_root_key',
      capabilities: ['fs.read', 'fs.write', 'env', 'random'],
      code: [
        'import base64',
        'import os',
        '',
        'inline = settings.get("root_key_inline") or ""',
        'if inline:',
        '    return inline',
        '',
        'path = settings.get("root_key_path")',
        'if os.path.exists(path):',
        '    with open(path, "rb") as handle:',
        '        return base64.b64encode(handle.read()).decode("ascii")',
        '',
        '# First boot generates one, 0600, and says so. It never generates one',
        '# silently on a later boot: a missing key on a running system means',
        '# something is wrong, and inventing a new one would destroy every',
        '# credential rather than reveal the problem.',
        'if settings.get("allow_key_creation") != "true":',
        '    raise RuntimeError(',
        '        "no root key at %s; run \'soar init-key\' once, or set SOAR_ROOT_KEY" % path',
        '    )',
        'os.makedirs(os.path.dirname(path), exist_ok=True)',
        'key = os.urandom(32)',
        'handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
        'with os.fdopen(handle, "wb") as out:',
        '    out.write(key)',
        'return base64.b64encode(key).decode("ascii")',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'seal',
      params: [
        { name: 'root_key_b64', type: 'string' },
        { name: 'plaintext', type: 'string' },
        { name: 'context', type: 'string' },
      ],
      returns: 'Map<string, Any>',
      doc: 'Envelope-encrypt a credential: a fresh data key per credential, wrapped by the root key, with the credential id bound in as associated data.',
      implName: 'envelope_seal',
      capabilities: ['random'],
      packages: [{ name: 'cryptography', version: '43.*' }],
      code: [
        'import base64',
        'import os',
        'from cryptography.hazmat.primitives.ciphers.aead import AESGCM',
        '',
        'root = base64.b64decode(root_key_b64)',
        'data_key = os.urandom(32)',
        '',
        '# The context (the credential id) is authenticated but not encrypted, so a',
        '# ciphertext moved to another credential row fails to decrypt instead of',
        '# quietly authenticating as the wrong secret.',
        'aad = context.encode("utf-8")',
        'nonce = os.urandom(12)',
        'ciphertext = AESGCM(data_key).encrypt(nonce, plaintext.encode("utf-8"), aad)',
        '',
        'wrap_nonce = os.urandom(12)',
        'wrapped = AESGCM(root).encrypt(wrap_nonce, data_key, aad)',
        '',
        'return {',
        '    "ciphertext": base64.b64encode(ciphertext).decode("ascii"),',
        '    "nonce": base64.b64encode(nonce).decode("ascii"),',
        '    "wrapped_key": base64.b64encode(wrap_nonce + wrapped).decode("ascii"),',
        '    "key_version": 1,',
        '}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'unseal',
      params: [
        { name: 'root_key_b64', type: 'string' },
        { name: 'record', type: 'Map<string, Any>' },
        { name: 'context', type: 'string' },
      ],
      returns: 'string',
      doc: 'Decrypt one credential, for one lease. Callers wrap the result in SecretValue immediately.',
      implName: 'envelope_unseal',
      packages: [{ name: 'cryptography', version: '43.*' }],
      code: [
        'import base64',
        'from cryptography.hazmat.primitives.ciphers.aead import AESGCM',
        '',
        'root = base64.b64decode(root_key_b64)',
        'aad = context.encode("utf-8")',
        '',
        'blob = base64.b64decode(record["wrapped_key"])',
        'data_key = AESGCM(root).decrypt(blob[:12], blob[12:], aad)',
        '',
        'nonce = base64.b64decode(record["nonce"])',
        'ciphertext = base64.b64decode(record["ciphertext"])',
        'return AESGCM(data_key).decrypt(nonce, ciphertext, aad).decode("utf-8")',
      ].join('\n'),
    });
    exports_(sealed.file, [
      { name: 'load_root_key', sort: 'function' },
      { name: 'seal', sort: 'function' },
      { name: 'unseal', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // secrets/provider.py
  // -------------------------------------------------------------------------
  const provider = py(ctx, { path: 'src/secrets/provider.py', module: secrets, doc: 'secret provider port', style: 'object-oriented' });
  {
    const g = provider.g;
    g.add('oop/interface', {
      name: 'SecretProvider',
      doc: 'Phase 1: the sealed local store. Later: Vault, Azure Key Vault, an HSM. Playbooks name a credential (crowdstrike_prod); they never hold one.',
      methods: [
        { name: 'resolve', params: [{ name: 'org_id', type: 'string' }, { name: 'name', type: 'string' }], returns: 'Any' },
        { name: 'store', params: [{ name: 'org_id', type: 'string' }, { name: 'name', type: 'string' }, { name: 'plaintext', type: 'string' }], returns: 'string' },
        { name: 'rotate', params: [{ name: 'org_id', type: 'string' }, { name: 'name', type: 'string' }], returns: 'Void' },
      ],
    });

    g.add('oop/class', {
      name: 'LocalSecretProvider',
      shape: 'class',
      implements: 'SecretProvider',
      doc: 'Sealed rows in Postgres under a root key that is not in Postgres. A database dump is therefore not a credential store.',
      fields: [
        { name: 'db', type: 'Any', visibility: 'private' },
        { name: 'root_key', type: 'string', visibility: 'private' },
      ],
    });
    g.add('oop/constructor', {
      className: 'LocalSecretProvider',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'root_key', type: 'string' },
      ],
    });
    methodWithBody(g, {
      className: 'LocalSecretProvider',
      name: 'resolve',
      params: [
        { name: 'org_id', type: 'string' },
        { name: 'name', type: 'string' },
      ],
      returns: 'Any',
      doc: 'Return a SecretValue, never a bare string. The type carries the redaction.',
      implName: 'local_provider_resolve',
      code: [
        'rows = self.db.query(',
        '    "SELECT id, ciphertext, nonce, wrapped_key, provider, external_ref "',
        '    "FROM credential WHERE org_id = %s AND name = %s",',
        '    [org_id, name],',
        '    org_id,',
        ')',
        'if not rows:',
        '    raise KeyError("no credential named %r" % name)',
        'row = rows[0]',
        'if row["provider"] != "local":',
        '    raise RuntimeError(',
        '        "credential %r lives in %s; configure that provider" % (name, row["provider"])',
        '    )',
        'plaintext = unseal(',
        '    self.root_key,',
        '    {',
        '        "ciphertext": row["ciphertext"],',
        '        "nonce": row["nonce"],',
        '        "wrapped_key": row["wrapped_key"],',
        '    },',
        '    row["id"],',
        ')',
        'self.db.execute(',
        '    "UPDATE credential SET last_used_at = now() WHERE id = %s", [row["id"]], org_id',
        ')',
        'return SecretValue(plaintext, name)',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'lease_for_job',
      params: [
        { name: 'provider', type: 'Any' },
        { name: 'org_id', type: 'string' },
        { name: 'auth_spec', type: 'List<Map<string, Any>>' },
      ],
      returns: 'Map<string, Any>',
      doc: [
        'Build the credential lease for one job: exactly the credentials the command',
        'declared, and nothing else.',
        '',
        'The lease travels inside the signed job payload and lives in the worker',
        'process memory for the life of the job. It is never an environment',
        'variable - /proc would expose it to a sibling - and never a file.',
      ].join('\n'),
      implName: 'build_credential_lease',
      code: [
        'lease = {}',
        'for entry in auth_spec or []:',
        '    role = entry.get("role")',
        '    name = entry.get("credential")',
        '    if not role or not name:',
        '        raise ValueError("auth entry needs both a role and a credential name")',
        '    lease[role] = provider.resolve(org_id, name)',
        'return lease',
      ].join('\n'),
    });
    exports_(provider.file, [
      { name: 'SecretProvider', sort: 'interface' },
      { name: 'LocalSecretProvider', sort: 'class' },
      { name: 'lease_for_job', sort: 'function' },
    ]);
    imports_(provider.file, sealed.file, ['unseal']);
    imports_(provider.file, redact.file, ['SecretValue']);
  }

  iface(secrets, [
    { name: 'SecretProvider', kind: 'type', doc: 'The secrets port.' },
    { name: 'lease_for_job', kind: 'function', doc: 'Per-job credential lease, scoped to what the command declared.' },
  ]);

  // -------------------------------------------------------------------------
  // audit/log.py
  // -------------------------------------------------------------------------
  const auditLog = py(ctx, { path: 'src/audit/log.py', module: audit, doc: 'hash-chained audit', style: 'procedural' });
  {
    const g = auditLog.g;
    fnWithBody(g, {
      name: 'record',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'entry', type: 'Map<string, Any>' },
      ],
      returns: 'string',
      doc: [
        'Append one audit event, chained to its predecessor.',
        '',
        'hash = SHA256(prev_hash || canonical_json(row)). Editing or deleting a row',
        'breaks every hash after it, which is what makes the log worth keeping when',
        'the database itself is the thing that was compromised.',
      ].join('\n'),
      implName: 'append_audit_event',
      code: [
        'import hashlib',
        'import json',
        '',
        'org_id = entry["org_id"]',
        'stream = entry.get("stream") or org_id',
        '',
        'head = db.query(',
        '    "SELECT seq, hash FROM audit_event WHERE stream = %s "',
        '    "ORDER BY seq DESC LIMIT 1",',
        '    [stream],',
        '    org_id,',
        ')',
        'prev_seq = head[0]["seq"] if head else 0',
        'prev_hash = head[0]["hash"] if head else b""',
        '',
        'row = {',
        '    "id": new_id("aud"),',
        '    "org_id": org_id,',
        '    "seq": prev_seq + 1,',
        '    "stream": stream,',
        '    "actor_kind": entry["actor_kind"],',
        '    "actor_id": entry.get("actor_id"),',
        '    "actor_label": entry.get("actor_label"),',
        '    "on_behalf_of_id": entry.get("on_behalf_of_id"),',
        '    "action": entry["action"],',
        '    "target_kind": entry.get("target_kind"),',
        '    "target_id": entry.get("target_id"),',
        '    "target_label": entry.get("target_label"),',
        '    "source_ip": entry.get("source_ip"),',
        '    "user_agent": entry.get("user_agent"),',
        '    "session_id": entry.get("session_id"),',
        '    "correlation_id": entry.get("correlation_id"),',
        '    "execution_id": entry.get("execution_id"),',
        '    "approval_id": entry.get("approval_id"),',
        '    "ai_session_id": entry.get("ai_session_id"),',
        '    "before": redacting_encoder(entry.get("before")),',
        '    "after": redacting_encoder(entry.get("after")),',
        '    "result": entry.get("result", "success"),',
        '    "reason": entry.get("reason"),',
        '}',
        '',
        'canonical = json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)',
        'digest = hashlib.sha256(prev_hash + canonical.encode("utf-8")).digest()',
        '',
        'db.execute(',
        '    "INSERT INTO audit_event (id, org_id, seq, stream, actor_kind, actor_id, "',
        '    "actor_label, on_behalf_of_id, action, target_kind, target_id, target_label, "',
        '    "source_ip, user_agent, session_id, correlation_id, execution_id, approval_id, "',
        '    "ai_session_id, before, after, result, reason, prev_hash, hash) "',
        '    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",',
        '    [',
        '        row["id"], row["org_id"], row["seq"], row["stream"], row["actor_kind"],',
        '        row["actor_id"], row["actor_label"], row["on_behalf_of_id"], row["action"],',
        '        row["target_kind"], row["target_id"], row["target_label"], row["source_ip"],',
        '        row["user_agent"], row["session_id"], row["correlation_id"],',
        '        row["execution_id"], row["approval_id"], row["ai_session_id"],',
        '        json.dumps(row["before"], default=str), json.dumps(row["after"], default=str),',
        '        row["result"], row["reason"], prev_hash, digest,',
        '    ],',
        '    org_id,',
        ')',
        'return row["id"]',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'verify_chain',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'org_id', type: 'string' },
        { name: 'stream', type: 'string' },
      ],
      returns: 'Map<string, Any>',
      doc: 'Walk the chain and report the first break. Runs on a schedule and on demand; a break raises a platform alert.',
      implName: 'verify_audit_chain',
      code: [
        'import hashlib',
        'import json',
        '',
        'rows = db.query(',
        '    "SELECT * FROM audit_event WHERE stream = %s ORDER BY seq ASC", [stream], org_id',
        ')',
        'prev_hash = b""',
        'for row in rows:',
        '    body = {k: v for k, v in row.items() if k not in ("hash", "prev_hash", "at")}',
        '    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)',
        '    expected = hashlib.sha256(prev_hash + canonical.encode("utf-8")).digest()',
        '    if bytes(row["hash"]) != expected:',
        '        return {"ok": False, "broken_at_seq": row["seq"], "checked": len(rows)}',
        '    prev_hash = bytes(row["hash"])',
        'return {"ok": True, "broken_at_seq": None, "checked": len(rows)}',
      ].join('\n'),
    });
    exports_(auditLog.file, [
      { name: 'record', sort: 'function' },
      { name: 'verify_chain', sort: 'function' },
    ]);
    imports_(auditLog.file, ids.file, ['new_id']);
    imports_(auditLog.file, redact.file, ['redacting_encoder']);
  }

  iface(audit, [
    { name: 'record', kind: 'function', doc: 'Append one hash-chained audit event.' },
    { name: 'verify_chain', kind: 'function', doc: 'Detect tampering in an audit stream.' },
  ]);

  // -------------------------------------------------------------------------
  // identity/rbac.py -- drawn, because this is what an engineer will want to read
  // -------------------------------------------------------------------------
  const rbac = py(ctx, { path: 'src/identity/rbac.py', module: identity, doc: 'permissions', style: 'procedural' });
  {
    const g = rbac.g;

    fnWithBody(g, {
      name: 'permission_catalogue',
      returns: 'List<string>',
      doc: 'Every permission the platform recognises. A flat vocabulary with no inheritance, because the most common RBAC bug is a hierarchy nobody can evaluate in their head.',
      implName: 'all_permissions',
      code: [
        'return [',
        '    "incidents.read", "incidents.write", "incidents.close", "incidents.assign",',
        '    "alerts.read", "alerts.triage",',
        '    "cases.read", "cases.write",',
        '    "playbooks.read", "playbooks.create", "playbooks.publish", "playbooks.run",',
        '    "commands.read", "commands.create", "commands.execute", "commands.promote",',
        '    "integrations.read", "integrations.manage",',
        '    "secrets.read_metadata", "secrets.manage",',
        '    "intel.read", "intel.write", "intel.feeds.manage",',
        '    "executions.read", "executions.cancel",',
        '    "approvals.read", "approvals.decide",',
        '    "response.isolate", "response.block", "response.disable_account",',
        '    "response.revoke_sessions", "response.delete_mail", "response.firewall",',
        '    "ai.use", "ai.execute", "ai.configure",',
        '    "audit.read", "reports.read", "reports.export",',
        '    "admin.users", "admin.roles", "admin.platform",',
        '    "clients.read", "clients.manage",',
        '    # Threat hunting. Writing a query that runs against a client estate on',
        '    # a schedule is an engineering act, not an analyst one, so none of',
        '    # these reach the Analyst role - which is why Admin takes the whole',
        '    # catalogue rather than a list somebody has to remember to extend.',
        '    "hunts.read", "hunts.write", "hunts.run", "hunts.review",',
        ']',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'builtin_roles',
      returns: 'Map<string, Any>',
      doc: [
        'The two roles. Admin and Analyst.',
        '',
        'Admin sees everything in the platform - the whole permission catalogue, so',
        'the two can never drift apart as capabilities are added.',
        '',
        'Analyst sees the dashboard, detections and alerts, and nothing else.',
        'Playbooks, commands, integrations, intel, credentials, clients, reports and',
        'administration are not theirs. The rail hides what they cannot open, so the',
        'screen is four items rather than fifteen with eleven refusals behind them.',
      ].join('\n'),
      implName: 'default_role_definitions',
      code: [
        'return {',
        '    "Analyst": [',
        '        # Detections.',
        '        "incidents.read", "incidents.write", "incidents.assign",',
        '        "incidents.close",',
        '        # Alerts.',
        '        "alerts.read", "alerts.triage",',
        '    ],',
        '    # Everything, taken from the catalogue rather than listed again here:',
        '    # a permission added to the platform reaches Admin the moment it exists,',
        '    # and cannot be forgotten in a second list that looks complete.',
        '    "Admin": list(permission_catalogue()),',
        '}',
      ].join('\n'),
    });

    // has_permission, drawn. This is the single most-called security decision in
    // the product, so it is on the canvas rather than buried in a helper.
    const hasPerm = g.add('entry/function', {
      name: 'has_permission',
      params: [
        { name: 'held', type: 'List<string>' },
        { name: 'needed', type: 'string' },
      ],
      returns: 'bool',
      doc: 'Exact match, or a trailing-wildcard grant such as "response.*".',
    });
    const direct = g.add('list/contains');
    g.connect(hasPerm, 'p:held', direct, 'a0');
    g.connect(hasPerm, 'p:needed', direct, 'a1');
    const ifDirect = g.add('control/if');
    g.connect(direct, 'found', ifDirect, 'cond');
    const yes = g.add('data/literal', { type: 'bool', value: 'true' });
    const retYes = g.add('control/return');
    g.connect(yes, 'value', retYes, 'value');

    const loop = g.add('control/for-each', { varName: 'grant' });
    g.connect(hasPerm, 'p:held', loop, 'items');
    const isWildcard = g.add('string/ends-with');
    g.connect(loop, 'item', isWildcard, 'a0');
    g.setDefault(isWildcard, 'a1', '.*');
    const ifWildcard = g.add('control/if');
    g.connect(isWildcard, 'found', ifWildcard, 'cond');

    const grantLen = g.add('string/length');
    g.connect(loop, 'item', grantLen, 'a0');
    const one = g.add('data/literal', { type: 'i64', value: '1' });
    const prefixLen = g.add('op/arithmetic', { op: '-' });
    g.connect(grantLen, 'length', prefixLen, 'a');
    g.connect(one, 'value', prefixLen, 'b');
    const prefix = g.add('string/substring');
    g.connect(loop, 'item', prefix, 'a0');
    g.setDefault(prefix, 'a1', 0);
    g.connect(prefixLen, 'result', prefix, 'a2');
    const startsWith = g.add('string/starts-with');
    g.connect(hasPerm, 'p:needed', startsWith, 'a0');
    g.connect(prefix, 'text', startsWith, 'a1');
    const ifPrefix = g.add('control/if');
    g.connect(startsWith, 'found', ifPrefix, 'cond');
    const yes2 = g.add('data/literal', { type: 'bool', value: 'true' });
    const retYes2 = g.add('control/return');
    g.connect(yes2, 'value', retYes2, 'value');

    const no = g.add('data/literal', { type: 'bool', value: 'false' });
    const retNo = g.add('control/return');
    g.connect(no, 'value', retNo, 'value');

    g.chain([hasPerm, 'out'], ifDirect);
    g.chain([ifDirect, 'then'], retYes);
    g.chain([ifDirect, 'else'], loop);
    g.chain([loop, 'body'], ifWildcard);
    g.chain([ifWildcard, 'then'], ifPrefix);
    g.chain([ifPrefix, 'then'], retYes2);
    g.chain([loop, 'out'], retNo);

    fnWithBody(g, {
      name: 'require_permission',
      params: [
        { name: 'principal', type: 'Map<string, Any>' },
        { name: 'needed', type: 'string' },
      ],
      returns: 'Void',
      doc: [
        'Called at the point of effect, not at the route.',
        '',
        'Every service method that changes state takes a principal and calls this.',
        'A route that forgets its decorator therefore still fails, which is the',
        'difference between a permission model and a decorating convention.',
      ].join('\n'),
      implName: 'enforce_permission',
      code: [
        'held = principal.get("permissions") or []',
        'if not has_permission(held, needed):',
        '    raise PermissionError(',
        '        "principal %s lacks %s" % (principal.get("id", "anonymous"), needed)',
        '    )',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'live_permissions',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'user_id', type: 'string' },
        { name: 'org_id', type: 'string' },
      ],
      returns: 'List<string>',
      doc: [
        'What this user may do, right now, from the roles they hold.',
        '',
        'Read on every request rather than once at sign-in. A permission list',
        'frozen into a session is a role change that does not take effect until',
        'the person signs out - which means a role REMOVED mid-shift keeps',
        'working, and a capability added to the platform reaches nobody who is',
        'already signed in. Both were true here.',
        '',
        'It is one indexed lookup on two small tables. That is the right price for',
        'an authorisation decision being about the present rather than about',
        'whenever the browser tab was opened.',
      ].join('\n'),
      implName: 'resolve_live_permissions',
      code: [
        'rows = db.query(',
        '    "SELECT DISTINCT rp.permission FROM user_role ur "',
        '    "JOIN role_permission rp ON rp.role_id = ur.role_id "',
        '    "WHERE ur.user_id = %s", [user_id], org_id,',
        ')',
        'return sorted(row["permission"] for row in rows)',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'grant_role',
      params: [
        { name: 'actor', type: 'Map<string, Any>' },
        { name: 'target_user_id', type: 'string' },
        { name: 'role_permissions', type: 'List<string>' },
        { name: 'mfa_enrolled', type: 'bool' },
      ],
      returns: 'Void',
      doc: 'The two rules that stop RBAC becoming an escalation path: no amplification, and no self-grant.',
      implName: 'check_role_grant',
      code: [
        'require_permission(actor, "admin.roles")',
        '',
        'if actor.get("id") == target_user_id:',
        '    raise PermissionError("a principal cannot change its own roles")',
        '',
        '# No amplification: you cannot grant what you do not hold.',
        'held = actor.get("permissions") or []',
        'for permission in role_permissions:',
        '    if not has_permission(held, permission):',
        '        raise PermissionError(',
        '            "cannot grant %s: the granting principal does not hold it" % permission',
        '        )',
        '',
        '# A response or secrets permission requires MFA on the receiving account.',
        '# Enforced here rather than at login, so the invariant holds for accounts',
        '# that were created before the policy existed.',
        'sensitive = [p for p in role_permissions if p.startswith(("response.", "secrets.", "admin."))]',
        'if sensitive and not mfa_enrolled:',
        '    raise PermissionError(',
        '        "target account must have MFA enrolled before receiving %s" % ", ".join(sensitive)',
        '    )',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'intersect_for_ai',
      params: [
        { name: 'analyst_permissions', type: 'List<string>' },
        { name: 'tool_set_permissions', type: 'List<string>' },
      ],
      returns: 'List<string>',
      doc: [
        'The AI principal, computed once per session.',
        '',
        'Intersection, never union. There is no AI service account with privileges',
        'of its own that an analyst could borrow, and because this runs before any',
        'incident text is read, no injected instruction can widen it.',
      ].join('\n'),
      implName: 'ai_principal_permissions',
      code: [
        'return sorted(',
        '    p for p in tool_set_permissions if has_permission(analyst_permissions, p)',
        ')',
      ].join('\n'),
    });

    exports_(rbac.file, [
      { name: 'permission_catalogue', sort: 'function' },
      { name: 'builtin_roles', sort: 'function' },
      { name: 'has_permission', sort: 'function' },
      { name: 'require_permission', sort: 'function' },
      { name: 'grant_role', sort: 'function' },
      { name: 'live_permissions', sort: 'function' },
      { name: 'intersect_for_ai', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // identity/credentials.py  (passwords, MFA)
  // -------------------------------------------------------------------------
  const creds = py(ctx, { path: 'src/identity/credentials.py', module: identity, doc: 'passwords and MFA', style: 'procedural' });
  {
    const g = creds.g;
    fnWithBody(g, {
      name: 'hash_password',
      params: [{ name: 'password', type: 'string' }],
      returns: 'string',
      doc: 'Argon2id with parameters chosen for an interactive login on modest hardware.',
      implName: 'argon2_hash',
      packages: [{ name: 'argon2-cffi', version: '23.*' }],
      code: [
        'from argon2 import PasswordHasher',
        '',
        'hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)',
        'return hasher.hash(password)',
      ].join('\n'),
    });
    fnWithBody(g, {
      name: 'verify_password',
      params: [
        { name: 'stored_hash', type: 'string' },
        { name: 'password', type: 'string' },
      ],
      returns: 'bool',
      doc: 'Constant-time verification that never leaks which half of the pair was wrong.',
      implName: 'argon2_verify',
      packages: [{ name: 'argon2-cffi', version: '23.*' }],
      code: [
        'from argon2 import PasswordHasher',
        'from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError',
        '',
        'try:',
        '    PasswordHasher().verify(stored_hash, password)',
        '    return True',
        'except (VerifyMismatchError, VerificationError, InvalidHashError):',
        '    return False',
      ].join('\n'),
    });
    fnWithBody(g, {
      name: 'verify_totp',
      params: [
        { name: 'secret_b32', type: 'string' },
        { name: 'code', type: 'string' },
        { name: 'timestamp', type: 'i64' },
      ],
      returns: 'bool',
      doc: 'RFC 6238, one step of drift each way, constant-time compare.',
      implName: 'totp_check',
      code: [
        'import base64',
        'import hashlib',
        'import hmac',
        'import struct',
        '',
        'key = base64.b32decode(secret_b32, casefold=True)',
        'counter = int(timestamp) // 30',
        'for drift in (-1, 0, 1):',
        '    payload = struct.pack(">Q", counter + drift)',
        '    digest = hmac.new(key, payload, hashlib.sha1).digest()',
        '    offset = digest[-1] & 0x0F',
        '    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF',
        '    candidate = "%06d" % (value % 1000000)',
        '    if hmac.compare_digest(candidate, str(code).strip()):',
        '        return True',
        'return False',
      ].join('\n'),
    });
    exports_(creds.file, [
      { name: 'hash_password', sort: 'function' },
      { name: 'verify_password', sort: 'function' },
      { name: 'verify_totp', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // identity/bootstrap.py -- the first administrator
  // -------------------------------------------------------------------------
  const bootstrap = py(ctx, {
    path: 'src/identity/bootstrap.py',
    module: identity,
    doc: 'first administrator',
    style: 'procedural',
  });
  {
    const g = bootstrap.g;

    fnWithBody(g, {
      name: 'new_totp_secret',
      params: [],
      returns: 'string',
      doc: [
        'A fresh TOTP secret, base32, 160 bits.',
        '',
        'RFC 4226 puts the floor at 128 bits and recommends 160, which is also what',
        'every authenticator app expects to be handed. Base32 without padding,',
        'because a padded secret is rejected by several of them.',
      ].join('\n'),
      implName: 'generate_totp_secret',
      capabilities: ['random'],
      code: [
        'import base64',
        'import os',
        '',
        'return base64.b32encode(os.urandom(20)).decode("ascii").rstrip("=")',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'totp_uri',
      params: [
        { name: 'secret_b32', type: 'string' },
        { name: 'email', type: 'string' },
        { name: 'issuer', type: 'string' },
      ],
      returns: 'string',
      doc: 'The otpauth:// URI an authenticator app scans. Spelled out in full - algorithm, digits and period - because apps that assume defaults and apps that do not both exist, and a silently wrong period produces codes that never verify.',
      implName: 'build_totp_uri',
      code: [
        'import urllib.parse',
        '',
        'label = urllib.parse.quote("%s:%s" % (issuer, email))',
        '# quote_via=quote, not the default quote_plus: a space encoded as "+" is',
        '# shown literally as "+" by several authenticator apps, so the account',
        '# reads "Master+SOAR" forever after.',
        'query = urllib.parse.urlencode({',
        '    "secret": secret_b32,',
        '    "issuer": issuer,',
        '    "algorithm": "SHA1",',
        '    "digits": "6",',
        '    "period": "30",',
        '}, quote_via=urllib.parse.quote)',
        'return "otpauth://totp/%s?%s" % (label, query)',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'totp_qr_svg',
      params: [{ name: 'uri', type: 'string' }],
      returns: 'string',
      doc: [
        'The enrolment code, as an inline SVG.',
        '',
        'Drawn on the server and sent as markup. The alternative - handing the',
        'secret to the browser and asking a script to render it - puts the one',
        'value that must not be logged into a page, a console and a history entry.',
        '',
        'Error correction M rather than L: this is read off a monitor by a phone',
        'camera at an angle, which is exactly the case the redundancy is for.',
      ].join('\n'),
      implName: 'render_totp_qr',
      packages: [{ name: 'segno', version: '1.6.*' }],
      code: [
        'import io',
        '',
        'import segno',
        '',
        '# Bytes, not text: segno writes an encoded document even for SVG, so a',
        '# StringIO here fails with a type error rather than anything that reads',
        '# like a QR problem.',
        'buffer = io.BytesIO()',
        'segno.make(uri, error="m").save(',
        '    buffer, kind="svg", scale=5, border=2,',
        '    dark="#0d1117", light="#ffffff", xmldecl=False, svgns=True,',
        ')',
        'return buffer.getvalue().decode("utf-8")',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'create_admin_account',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'settings', type: 'Map<string, Any>' },
        { name: 'email', type: 'string' },
        { name: 'display_name', type: 'string' },
        { name: 'password', type: 'string' },
      ],
      returns: 'Map<string, Any>',
      doc: [
        'Create an administrator with MFA already enrolled.',
        '',
        'The installation seeds no user, so this is the only way in. It runs from a',
        'shell on the deployment rather than over HTTP, which is the point: the',
        'authority to create the first administrator is the authority to run commands',
        'on the host, and there is no endpoint that grants it.',
        '',
        'MFA is enrolled in the same step rather than offered afterwards, for two',
        'reasons. Login is a mandatory two-step - the password alone opens a session',
        'with no permissions at all - so an account without a factor cannot finish',
        'signing in. And the role grant refuses to attach admin.* to an account with',
        'no factor, so doing it later would mean doing it in the wrong order.',
      ].join('\n'),
      implName: 'provision_first_admin',
      code: [
        'import json',
        '',
        'if "@" not in email:',
        '    raise ValueError("an email address is required")',
        'if len(password) < 12:',
        '    raise ValueError("choose a password of at least 12 characters")',
        '',
        'organisations = db.query(',
        '    "SELECT id, name FROM organisation ORDER BY created_at LIMIT 1", [], "")',
        'if not organisations:',
        '    raise RuntimeError(',
        '        "no organisation yet; run the migrations first "',
        '        "(docker compose up migrate)")',
        'org_id = organisations[0]["id"]',
        '',
        'existing = db.query(',
        '    "SELECT id FROM app_user WHERE org_id = %s AND email = %s",',
        '    [org_id, email], org_id)',
        'if existing:',
        '    raise ValueError("%s already has an account" % email)',
        '',
        '# The Admin role. The first account runs the service, and creates',
        '# Analyst accounts from Administration once it is in.',
        'roles = db.query(',
        '    "SELECT id, name FROM role WHERE org_id = %s AND name = %s AND builtin",',
        '    [org_id, "Admin"], org_id)',
        'if not roles:',
        '    raise RuntimeError("the Admin role is missing; the seed did not complete")',
        '',
        'user_id = new_id("usr")',
        'secret = new_totp_secret()',
        '',
        '# Sealed under the root key with the user id as associated data, so a',
        '# secret copied into another user row fails to decrypt rather than',
        '# quietly authenticating as the wrong person.',
        'sealed_secret = seal(settings["root_key"], secret, user_id)',
        '',
        'db.execute(',
        '    "INSERT INTO app_user (id, org_id, email, display_name, password_hash, "',
        '    "mfa_secret, mfa_enrolled_at) VALUES (%s,%s,%s,%s,%s,%s, now())",',
        '    [user_id, org_id, email, display_name, hash_password(password),',
        '     json.dumps(sealed_secret)],',
        '    org_id,',
        ')',
        'for role in roles:',
        '    db.execute(',
        '        "INSERT INTO user_role (user_id, role_id, granted_by) "',
        '        "VALUES (%s, %s, %s)",',
        '        [user_id, role["id"], "bootstrap"], org_id,',
        '    )',
        '',
        'audit_record(db, {',
        '    "org_id": org_id, "actor_kind": "system", "actor_id": "bootstrap",',
        '    "action": "user.create.admin", "target_kind": "user",',
        '    "target_id": user_id, "target_label": email,',
        '    "after": {"roles": [r["name"] for r in roles], "mfa": "totp"},',
        '    "reason": "first administrator, created from the host",',
        '    "result": "success",',
        '})',
        '',
        'return {',
        '    "user_id": user_id,',
        '    "org_id": org_id,',
        '    "email": email,',
        '    "totp_secret": secret,',
        '    "totp_uri": totp_uri(secret, email, "Master SOAR"),',
        '    "roles": [role["name"] for role in roles],',
        '}',
      ].join('\n'),
    });

    exports_(bootstrap.file, [
      { name: 'new_totp_secret', sort: 'function' },
      { name: 'totp_uri', sort: 'function' },
      { name: 'totp_qr_svg', sort: 'function' },
      { name: 'create_admin_account', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // identity/sessions.py
  // -------------------------------------------------------------------------
  const sessions = py(ctx, { path: 'src/identity/sessions.py', module: identity, doc: 'sessions', style: 'procedural' });
  {
    const g = sessions.g;
    fnWithBody(g, {
      name: 'open_session',
      params: [
        { name: 'redis', type: 'Any' },
        { name: 'user', type: 'Map<string, Any>' },
        { name: 'fingerprint', type: 'string' },
        { name: 'ttl_s', type: 'i64' },
      ],
      returns: 'Map<string, Any>',
      doc: 'Server-side session plus a double-submit CSRF token. The session id is never readable by page script; the CSRF token is, and that asymmetry is the defence.',
      implName: 'create_session_record',
      capabilities: ['random', 'net'],
      packages: [{ name: 'redis', version: '5.*' }],
      code: [
        'import json',
        'import secrets as pysecrets',
        '',
        'session_id = pysecrets.token_urlsafe(32)',
        'csrf_token = pysecrets.token_urlsafe(32)',
        'record = {',
        '    "user_id": user["id"],',
        '    "org_id": user["org_id"],',
        '    "permissions": user.get("permissions", []),',
        '    "fingerprint": fingerprint,',
        '    "csrf": csrf_token,',
        '    "mfa_satisfied": bool(user.get("mfa_satisfied")),',
        '    "step_up_until": 0,',
        '}',
        'redis.setex("session:" + session_id, int(ttl_s), json.dumps(record))',
        'return {"session_id": session_id, "csrf": csrf_token, "record": record}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'load_session',
      params: [
        { name: 'redis', type: 'Any' },
        { name: 'session_id', type: 'string' },
        { name: 'fingerprint', type: 'string' },
      ],
      returns: 'Map<string, Any>',
      doc: 'Reject a session presented from a materially different client. Rotation on privilege change is why this is cheap to be strict about.',
      implName: 'read_session_record',
      capabilities: ['net'],
      code: [
        'import json',
        '',
        'raw = redis.get("session:" + (session_id or ""))',
        'if not raw:',
        '    raise PermissionError("no such session")',
        'record = json.loads(raw)',
        'if record.get("fingerprint") != fingerprint:',
        '    redis.delete("session:" + session_id)',
        '    raise PermissionError("session fingerprint mismatch; session revoked")',
        'return record',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'check_csrf',
      params: [
        { name: 'record', type: 'Map<string, Any>' },
        { name: 'header_token', type: 'string' },
      ],
      returns: 'Void',
      doc: 'Double-submit check for every cookie-authenticated mutation. Bearer-token callers skip it, because they were never subject to ambient authority.',
      implName: 'enforce_csrf',
      code: [
        'import hmac',
        '',
        'expected = record.get("csrf") or ""',
        'if not header_token or not hmac.compare_digest(expected, header_token):',
        '    raise PermissionError("csrf token missing or invalid")',
      ].join('\n'),
    });
    exports_(sessions.file, [
      { name: 'open_session', sort: 'function' },
      { name: 'load_session', sort: 'function' },
      { name: 'check_csrf', sort: 'function' },
    ]);
  }

  iface(identity, [
    { name: 'has_permission', kind: 'function', doc: 'Permission test, with trailing-wildcard grants.' },
    { name: 'require_permission', kind: 'function', doc: 'Enforce at the point of effect.' },
    { name: 'intersect_for_ai', kind: 'function', doc: 'The AI principal: intersection, never union.' },
    { name: 'open_session', kind: 'function', doc: 'Server-side session and CSRF token.' },
  ]);

  return { platform, storage, secrets, audit, identity };
}
