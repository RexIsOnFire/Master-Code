/**
 * Tests the graphs define.
 *
 * These are not coverage theatre. Each one asserts a security invariant from
 * docs/threat-model.md section 6 - the statements that, if false, make the
 * threat model false.
 */

import type { Ctx } from './kit.ts';
import { exports_, fnWithBody, py } from './kit.ts';
import type { CoreModules } from './m-core.ts';
import type { AutomationModules } from './m-automation.ts';
import { GraphBuilder } from '#core/project/builder.ts';

export function buildTests(ctx: Ctx, core: CoreModules, automation: AutomationModules): void {
  void core;
  void automation;

  // -------------------------------------------------------------------------
  // tests/test_isolation.py -- invariants 1, 2, 10
  // -------------------------------------------------------------------------
  const isolation = py(ctx, {
    path: 'tests/test_isolation.py',
    doc: 'isolation invariants',
    style: 'procedural',
    role: 'test',
    kind: 'hybrid',
  });
  {
    const g: GraphBuilder = isolation.g;

    const t1 = g.add('test/case', {
      name: 'test_untrusted_never_leaves_the_sandbox',
      kind: 'unit',
      doc: 'Invariant 1: untrusted code never executes in the API process or the default worker pool.',
    });
    const untrusted = g.add('data/literal', { type: 'string', value: 'untrusted' });
    const kind = g.add('data/literal', { type: 'string', value: 'python' });
    const call = g.add('control/call', { target: 'choose_executor', returns: 'string' });
    g.connect(untrusted, 'value', call, 'args');
    g.connect(kind, 'value', call, 'args#1');
    const expected = g.add('data/literal', { type: 'string', value: 'sandbox' });
    const assert1 = g.add('test/assert-equal', {
      message: 'untrusted must resolve to the sandbox executor, whatever the command kind',
    });
    g.connect(call, 'result', assert1, 'actual');
    g.connect(expected, 'value', assert1, 'expected');
    g.chain([t1, 'out'], call, assert1);

    const t2 = g.add('test/case', {
      name: 'test_untrusted_gets_no_network_and_no_credentials',
      kind: 'unit',
      doc: 'Invariant 2: an untrusted command is never issued a credential lease.',
    });
    const level = g.add('data/literal', { type: 'string', value: 'untrusted' });
    const timeout = g.add('data/literal', { type: 'i64', value: '60000' });
    const limits = g.add('control/call', { target: 'limits_for', returns: 'Map<string, Any>' });
    g.connect(level, 'value', limits, 'args');
    g.connect(timeout, 'value', limits, 'args#1');
    const network = g.add('map/get-or');
    g.connect(limits, 'result', network, 'a0');
    g.setDefault(network, 'a1', 'network');
    g.setDefault(network, 'a2', true);
    const no = g.add('data/literal', { type: 'bool', value: 'false' });
    const assert2 = g.add('test/assert-equal', { message: 'untrusted execution must have no network' });
    g.connect(network, 'value', assert2, 'actual');
    g.connect(no, 'value', assert2, 'expected');

    const credentials = g.add('map/get-or');
    g.connect(limits, 'result', credentials, 'a0');
    g.setDefault(credentials, 'a1', 'credentials');
    g.setDefault(credentials, 'a2', true);
    const no2 = g.add('data/literal', { type: 'bool', value: 'false' });
    const assert3 = g.add('test/assert-equal', { message: 'untrusted execution must receive no credential lease' });
    g.connect(credentials, 'value', assert3, 'actual');
    g.connect(no2, 'value', assert3, 'expected');
    g.chain([t2, 'out'], limits, assert2, assert3);

    const t3 = g.add('test/case', {
      name: 'test_template_cannot_reach_python',
      kind: 'unit',
      doc: 'Invariant 10: template rendering cannot reach a Python attribute, a method, or a builtin.',
    });
    const evil = g.add('data/literal', { type: 'string', value: '{{ incident.__class__ }}' });
    const context = g.add('map/new');
    const position = g.add('data/literal', { type: 'string', value: 'text' });
    const render = g.add('control/call', { target: 'render', returns: 'string' });
    g.connect(evil, 'value', render, 'args');
    g.connect(context, 'map', render, 'args#1');
    g.connect(position, 'value', render, 'args#2');
    const empty = g.add('data/literal', { type: 'string', value: '' });
    const assert4 = g.add('test/assert-equal', {
      message: '__class__ is not a key in a dictionary, so it must resolve to nothing',
    });
    g.connect(render, 'result', assert4, 'actual');
    g.connect(empty, 'value', assert4, 'expected');
    g.chain([t3, 'out'], render, assert4);

    exports_(isolation.file, []);
  }

  // -------------------------------------------------------------------------
  // tests/test_governance.py -- invariants 3, 6, 7, 8
  // -------------------------------------------------------------------------
  const governance = py(ctx, {
    path: 'tests/test_governance.py',
    doc: 'governance invariants',
    style: 'procedural',
    role: 'test',
    kind: 'hybrid',
  });
  {
    const g: GraphBuilder = governance.g;

    const t1 = g.add('test/case', {
      name: 'test_high_risk_cannot_be_auto_approved',
      kind: 'unit',
      doc: 'Invariant 7: no policy can allow a HIGH-risk action without a human. Even a policy that says "allow" is overridden.',
    });
    const policies = g.add('control/call', { target: 'default_policies', returns: 'List<Map<string, Any>>' });
    const req = g.add('map/literal', { keyType: 'string', valueType: 'Any' });
    g.setDefault(req, 'k', 'risk_level');
    g.setDefault(req, 'v', 'high');
    const evaluate = g.add('control/call', { target: 'evaluate', returns: 'Map<string, Any>' });
    g.connect(policies, 'result', evaluate, 'args');
    g.connect(req, 'map', evaluate, 'args#1');
    const effect = g.add('map/get-or');
    g.connect(evaluate, 'result', effect, 'a0');
    g.setDefault(effect, 'a1', 'effect');
    g.setDefault(effect, 'a2', 'allow');
    const expected = g.add('data/literal', { type: 'string', value: 'require_approval' });
    const assert1 = g.add('test/assert-equal', {
      message: 'a high-risk action must always require approval',
    });
    g.connect(effect, 'value', assert1, 'actual');
    g.connect(expected, 'value', assert1, 'expected');
    g.chain([t1, 'out'], policies, evaluate, assert1);

    const t2 = g.add('test/case', {
      name: 'test_ai_permissions_are_an_intersection',
      kind: 'unit',
      doc: 'Invariant 6: the AI principal is a subset of the invoking analyst, never a union.',
    });
    const analyst = g.add('list/literal', { itemType: 'string' });
    g.setDefault(analyst, 'e', 'incidents.read');
    g.setDefault(analyst, g.addVariadic(analyst, 'e', 'in'), 'intel.read');
    const toolSet = g.add('list/literal', { itemType: 'string' });
    g.setDefault(toolSet, 'e', 'intel.read');
    g.setDefault(toolSet, g.addVariadic(toolSet, 'e', 'in'), 'response.isolate');
    const intersect = g.add('control/call', { target: 'intersect_for_ai', returns: 'List<string>' });
    g.connect(analyst, 'list', intersect, 'args');
    g.connect(toolSet, 'list', intersect, 'args#1');
    const hasIsolate = g.add('list/contains');
    g.connect(intersect, 'result', hasIsolate, 'a0');
    g.setDefault(hasIsolate, 'a1', 'response.isolate');

    // Bind the membership test to a local before asserting on it. Asserting
    // directly on `x in y` emits `assert x in y == False`, which Python parses as
    // a chained comparison and evaluates as `(x in y) and (y == False)` - an
    // assertion that fails for the wrong reason.
    const granted = g.add('data/local', { name: 'granted', type: 'bool', constant: true });
    g.connect(hasIsolate, 'found', granted, 'value');

    const no = g.add('data/literal', { type: 'bool', value: 'false' });
    const assert2 = g.add('test/assert-equal', {
      message: 'a tool set cannot grant the AI a permission the analyst does not hold',
    });
    g.connect(granted, 'ref', assert2, 'actual');
    g.connect(no, 'value', assert2, 'expected');
    g.chain([t2, 'out'], intersect, granted, assert2);

    const t3 = g.add('test/case', {
      name: 'test_published_version_cannot_be_republished',
      kind: 'unit',
      doc: 'Invariant 8: a published playbook version is immutable; editing produces a new draft.',
    });
    const from = g.add('data/literal', { type: 'string', value: 'published' });
    const to = g.add('data/literal', { type: 'string', value: 'published' });
    const can = g.add('control/call', { target: 'can_transition', returns: 'bool' });
    g.connect(from, 'value', can, 'args');
    g.connect(to, 'value', can, 'args#1');
    const no2 = g.add('data/literal', { type: 'bool', value: 'false' });
    const assert3 = g.add('test/assert-equal', {
      message: 'published -> published is not a legal transition',
    });
    g.connect(can, 'result', assert3, 'actual');
    g.connect(no2, 'value', assert3, 'expected');
    g.chain([t3, 'out'], can, assert3);

    const t4 = g.add('test/case', {
      name: 'test_wildcard_grants_do_not_over_match',
      kind: 'unit',
      doc: 'Invariant 3: permission checks are exact, or an explicit trailing wildcard. "response.*" must not grant "responsible.thing".',
    });
    const held = g.add('list/literal', { itemType: 'string' });
    g.setDefault(held, 'e', 'response.*');
    const needed = g.add('data/literal', { type: 'string', value: 'responsex.isolate' });
    const check = g.add('control/call', { target: 'has_permission', returns: 'bool' });
    g.connect(held, 'list', check, 'args');
    g.connect(needed, 'value', check, 'args#1');
    const no3 = g.add('data/literal', { type: 'bool', value: 'false' });
    const assert4 = g.add('test/assert-equal', {
      message: 'the wildcard prefix includes the dot, so a neighbouring namespace does not match',
    });
    g.connect(check, 'result', assert4, 'actual');
    g.connect(no3, 'value', assert4, 'expected');
    g.chain([t4, 'out'], check, assert4);

    exports_(governance.file, []);
  }

  // -------------------------------------------------------------------------
  // tests/test_ingest.py -- invariants 5, 9
  // -------------------------------------------------------------------------
  const ingestTests = py(ctx, {
    path: 'tests/test_ingest.py',
    doc: 'ingest and egress invariants',
    style: 'procedural',
    role: 'test',
    kind: 'hybrid',
  });
  {
    const g: GraphBuilder = ingestTests.g;

    fnWithBody(g, {
      name: 'assert_ssrf_refusals',
      returns: 'bool',
      doc: 'Drive check_destination over every destination that must be refused, and return true only if all of them were.',
      implName: 'exercise_ssrf_guard',
      code: [
        'HOSTILE = [',
        '    "http://169.254.169.254/latest/meta-data/",',
        '    "http://[fd00:ec2::254]/",',
        '    "http://127.0.0.1:5432/",',
        '    "http://localhost/admin",',
        '    "http://10.0.0.5/",',
        '    "http://192.168.1.1/",',
        '    "http://172.16.0.1/",',
        '    "file:///etc/passwd",',
        '    "gopher://internal/",',
        ']',
        'for url in HOSTILE:',
        '    try:',
        '        check_destination(url, [])',
        '    except (PermissionError, ValueError):',
        '        continue',
        '    return False  # a hostile destination was accepted',
        'return True',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'assert_hostile_payload_inert',
      returns: 'bool',
      doc: 'A payload that tries to name a playbook and grant itself permissions must normalise into an ordinary alert with those fields inert.',
      implName: 'exercise_hostile_ingest',
      code: [
        'payload = {',
        '    "id": "attacker-1",',
        '    "title": "benign looking alert",',
        '    "severity": "low",',
        '    "timestamp": "2026-09-14T10:00:00Z",',
        '    "playbook": "malware.containment",',
        '    "command": "crowdstrike.isolate_host",',
        '    "permissions": ["admin.platform"],',
        '    "user_id": "usr_admin",',
        '}',
        'alert = normalise_event("generic.webhook", payload,',
        '                        builtin_mappings()["generic.webhook"])',
        '',
        '# The hostile fields survive only inside the preserved vendor payload.',
        '# Nothing in the normalised alert names an action, and no field outside',
        '# alert["vendor"] mentions them at all.',
        'for key in ("playbook", "command", "permissions", "user_id"):',
        '    if key in alert:',
        '        return False',
        'if alert["vendor"].get("playbook") != "malware.containment":',
        '    return False  # the raw payload must still be preserved verbatim',
        '',
        '# And a trigger only fires on what the SOC configured, over normalised',
        '# fields - never on a field the payload supplied.',
        'condition = {"type": "compare", "field": "severity", "op": "gte", "value": "high"}',
        'return matches(condition, alert) is False',
      ].join('\n'),
    });

    const t1 = g.add('test/case', {
      name: 'test_ssrf_guard_refuses_metadata_and_private_space',
      kind: 'unit',
      doc: 'Invariant 9: every outbound URL is screened after DNS resolution, on the resolved address.',
    });
    const note = g.add('data/comment', {
      text: [
        'The cases this covers, each of which has been a real CVE in some',
        'automation platform:',
        '  http://169.254.169.254/latest/meta-data/   cloud metadata, by address',
        '  http://metadata.internal/                  metadata, by name',
        '  http://127.0.0.1:5432/                     loopback to a local service',
        '  http://10.0.0.5/                           RFC1918',
        '  file:///etc/passwd                         non-http scheme',
        '  https://ok.example -> 302 -> 169.254...    redirect after an allowed hop',
      ].join('\n'),
    });
    const guardCall = g.add('control/call', { target: 'assert_ssrf_refusals', returns: 'bool' });
    const yes = g.add('data/literal', { type: 'bool', value: 'true' });
    const assert1 = g.add('test/assert-equal', {
      message: 'every non-routable destination must be refused, including after a redirect',
    });
    g.connect(guardCall, 'result', assert1, 'actual');
    g.connect(yes, 'value', assert1, 'expected');
    g.chain([t1, 'out'], note, guardCall, assert1);

    const t2 = g.add('test/case', {
      name: 'test_webhook_cannot_name_a_playbook',
      kind: 'unit',
      doc: 'Invariant 5: an inbound webhook may create an alert and nothing else. It cannot name a playbook, a command, a user or a permission.',
    });
    const note2 = g.add('data/comment', {
      text: [
        'The payload under test contains "playbook": "malware.containment" and',
        '"permissions": ["admin.platform"]. Both are ordinary vendor fields as far',
        'as normalisation is concerned: they end up in alert["vendor"] and reach no',
        'decision anywhere. Automation only happens if a trigger the SOC configured',
        'matches the normalised alert.',
      ].join('\n'),
    });
    const hostile = g.add('control/call', { target: 'assert_hostile_payload_inert', returns: 'bool' });
    const yes2 = g.add('data/literal', { type: 'bool', value: 'true' });
    const assert2 = g.add('test/assert-equal', {
      message: 'a hostile payload must produce an alert row and no automation of its choosing',
    });
    g.connect(hostile, 'result', assert2, 'actual');
    g.connect(yes2, 'value', assert2, 'expected');
    g.chain([t2, 'out'], note2, hostile, assert2);

    const t3 = g.add('test/case', {
      name: 'test_indicator_normalisation_deduplicates',
      kind: 'unit',
      doc: 'The same observable arriving four ways must produce one indicator row.',
    });
    const defanged = g.add('data/literal', { type: 'string', value: 'hxxps://Evil[.]Example[.]COM:443/a' });
    const plain = g.add('data/literal', { type: 'string', value: 'https://evil.example.com/a' });
    const normA = g.add('control/call', { target: 'normalise_value', returns: 'string' });
    const urlKind = g.add('data/literal', { type: 'string', value: 'url' });
    g.connect(urlKind, 'value', normA, 'args');
    g.connect(defanged, 'value', normA, 'args#1');
    const normB = g.add('control/call', { target: 'normalise_value', returns: 'string' });
    const urlKind2 = g.add('data/literal', { type: 'string', value: 'url' });
    g.connect(urlKind2, 'value', normB, 'args');
    g.connect(plain, 'value', normB, 'args#1');
    const assert3 = g.add('test/assert-equal', {
      message: 'defanged, uppercased and default-port forms must canonicalise to one value',
    });
    g.connect(normA, 'result', assert3, 'actual');
    g.connect(normB, 'result', assert3, 'expected');
    g.chain([t3, 'out'], normA, normB, assert3);

    exports_(ingestTests.file, []);
  }

  // -------------------------------------------------------------------------
  // tests/test_audit.py -- invariant 4
  // -------------------------------------------------------------------------
  const auditTests = py(ctx, {
    path: 'tests/test_audit.py',
    doc: 'audit invariants',
    style: 'procedural',
    role: 'test',
    kind: 'hybrid',
  });
  {
    const g: GraphBuilder = auditTests.g;

    fnWithBody(g, {
      name: 'test_database',
      params: [],
      returns: 'Any',
      doc: [
        'A connected Database for the one test that needs a real one.',
        '',
        'Skipped rather than failed when SOAR_TEST_DSN is unset. A developer running',
        'the suite on a laptop should see this test skip with a reason, not watch it',
        'fail for a cause that has nothing to do with their change.',
      ].join('\n'),
      implName: 'connect_test_database',
      capabilities: ['env', 'net'],
      code: [
        'import os',
        'import unittest',
        '',
        'dsn = os.environ.get("SOAR_TEST_DSN")',
        'if not dsn:',
        '    raise unittest.SkipTest(',
        '        "set SOAR_TEST_DSN to a disposable Postgres to run the audit "',
        '        "tampering test; it writes and then corrupts audit rows")',
        '',
        'db = Database(dsn, "soar_app")',
        'db.connect()',
        'run_migrations(db)',
        'return db',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'migrate_connection',
      params: [],
      returns: 'Any',
      doc: [
        'A connection under the migrate role, which is the only role that can write',
        'an audit row that already exists.',
        '',
        'The test needs it precisely because the application role cannot do this: the',
        'REVOKE in migration 5 is what makes tampering require a second credential,',
        'and a test that could tamper as the app role would be testing nothing.',
      ].join('\n'),
      implName: 'open_migrate_connection',
      capabilities: ['env', 'net'],
      packages: [{ name: 'psycopg[binary,pool]', version: '3.2.*' }],
      code: [
        'import os',
        'import unittest',
        '',
        'import psycopg',
        '',
        'dsn = os.environ.get("SOAR_TEST_MIGRATE_DSN") or os.environ.get("SOAR_TEST_DSN")',
        'if not dsn:',
        '    raise unittest.SkipTest("no SOAR_TEST_DSN configured")',
        'return psycopg.connect(dsn, autocommit=True)',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'assert_chain_break_detected',
      params: [],
      returns: 'i64',
      doc: 'Write three audit events, tamper with the second using the migrate role, and return the sequence number the verifier reports.',
      implName: 'exercise_audit_chain',
      code: [
        'db = test_database()',
        'org_id = seed_organisation(db, "Test Org")["org_id"]',
        '',
        'for index in range(3):',
        '    audit_record(db, {',
        '        "org_id": org_id, "actor_kind": "system",',
        '        "action": "test.event.%d" % index, "result": "success",',
        '    })',
        '',
        '# Reaching around the permission model on purpose: no application role can',
        '# do this, which is the point of the test.',
        'with migrate_connection() as conn:',
        '    conn.execute(',
        '        "UPDATE audit_event SET reason = %s WHERE stream = %s AND seq = 2",',
        '        ("tampered", org_id),',
        '    )',
        '',
        'result = verify_chain(db, org_id, org_id)',
        'if result["ok"]:',
        '    return -1  # tampering went undetected',
        'return int(result["broken_at_seq"])',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'assert_secret_masked_in_audit',
      returns: 'bool',
      doc: 'Place a SecretValue in a nested audit payload and confirm the plaintext appears nowhere in what is written.',
      implName: 'exercise_secret_redaction',
      code: [
        'import json',
        '',
        'PLAINTEXT = "cs-client-secret-4f2a9e"',
        'payload = {',
        '    "integration": "crowdstrike_prod",',
        '    "nested": {"list": [SecretValue(PLAINTEXT, "crowdstrike_prod")]},',
        '}',
        'encoded = json.dumps(redacting_encoder(payload), default=str)',
        'return PLAINTEXT not in encoded and "***[crowdstrike_prod]***" in encoded',
      ].join('\n'),
    });

    const t1 = g.add('test/case', {
      name: 'test_audit_chain_detects_tampering',
      kind: 'integration',
      doc: 'Invariant 4: audit_event is insert-only, and an edit breaks every hash after it.',
    });
    const note = g.add('data/comment', {
      text: [
        'Writes three events, edits the middle row directly with the migrate role,',
        'and asserts that verify_chain reports the break at the right sequence',
        'number. The application roles cannot perform that edit at all - this test',
        'has to reach around the permission model to create the condition it checks.',
      ].join('\n'),
    });
    const verify = g.add('control/call', { target: 'assert_chain_break_detected', returns: 'i64' });
    const expectedSeq = g.add('data/literal', { type: 'i64', value: '2' });
    const assert1 = g.add('test/assert-equal', {
      message: 'the verifier must name the sequence number where the chain broke',
    });
    g.connect(verify, 'result', assert1, 'actual');
    g.connect(expectedSeq, 'value', assert1, 'expected');
    g.chain([t1, 'out'], note, verify, assert1);

    const t2 = g.add('test/case', {
      name: 'test_secrets_never_reach_an_audit_record',
      kind: 'unit',
      doc: 'A SecretValue in a before/after payload is masked by type, not by pattern.',
    });
    const masked = g.add('control/call', { target: 'assert_secret_masked_in_audit', returns: 'bool' });
    const yes = g.add('data/literal', { type: 'bool', value: 'true' });
    const assert2 = g.add('test/assert-equal', {
      message: 'a credential placed in an audit payload must be masked wherever it sits',
    });
    g.connect(masked, 'result', assert2, 'actual');
    g.connect(yes, 'value', assert2, 'expected');
    g.chain([t2, 'out'], masked, assert2);

    exports_(auditTests.file, []);
  }

  // -------------------------------------------------------------------------
  // tests/test_response.py -- EDR variance
  // -------------------------------------------------------------------------
  const response = py(ctx, {
    path: 'tests/test_response.py',
    doc: 'EDR response invariants',
    style: 'procedural',
    role: 'test',
    kind: 'hybrid',
  });
  {
    const g: GraphBuilder = response.g;

    fnWithBody(g, {
      name: 'check_containment_resolution',
      returns: 'List<string>',
      doc: [
        'One playbook, five EDRs: the resolution has to pick the one with an agent on',
        'this host, refuse loudly where the vendor cannot do it, and never contain',
        'nothing while reporting success.',
      ].join('\n'),
      implName: 'exercise_containment_resolution',
      code: [
        'class _Stub:',
        '    """A database stand-in: this test is about the resolution logic, not SQL."""',
        '',
        '    def __init__(self, agents, integrations):',
        '        self.agents = agents',
        '        self.integrations = integrations',
        '',
        '    def query(self, sql, params, org_id):',
        '        if "FROM host" in sql:',
        '            return [{"agent_ids": self.agents, "hostname": "WS-4417"}]',
        '        if "FROM integration" in sql:',
        '            return self.integrations',
        '        return []',
        '',
        '',
        'BOTH = [',
        '    {"name": "cs_prod", "connector_id": "crowdstrike.falcon", "health": "healthy"},',
        '    {"name": "s1_prod", "connector_id": "sentinelone.v2", "health": "healthy"},',
        ']',
        '',
        'failures = []',
        '',
        '# 1. The EDR that has an agent on THIS host wins, not the first one configured.',
        'chosen = resolve_containment(',
        '    _Stub({"sentinelone": "s1-123"}, BOTH), "org_X", "isolate_host", "host_X")',
        'if chosen["command"] != "sentinelone.disconnect_agent":',
        '    failures.append("picked %s for a SentinelOne-only host" % chosen["command"])',
        '',
        '# 2. The vendor semantics travel with the command, so the timeline can say what',
        '#    this particular EDR means by "isolate" rather than a word meaning five things.',
        'if "network" not in chosen["semantics"].lower():',
        '    failures.append("no vendor semantics returned with the command")',
        '',
        '# 3. An action this EDR cannot perform fails LOUDLY and names the reason. This is',
        '#    the case that matters: silently skipping it would report the host contained.',
        'try:',
        '    resolve_containment(',
        '        _Stub({"sentinelone": "s1-123"}, BOTH), "org_X", "block_hash", "host_X")',
        '    failures.append("block_hash was accepted on an EDR that cannot do it")',
        'except RuntimeError as error:',
        '    if "policy object" not in str(error):',
        '        failures.append("refusal did not explain why: %s" % error)',
        '',
        '# 4. Never fall back to an EDR with no agent here. That call would succeed',
        '#    against the vendor API and contain nothing at all.',
        'try:',
        '    resolve_containment(_Stub({}, BOTH), "org_X", "isolate_host", "host_X")',
        '    failures.append("contained a host that has no agent on any configured EDR")',
        'except RuntimeError:',
        '    pass',
        '',
        '# 5. A failing integration is skipped in favour of a healthy one.',
        'degraded = [',
        '    {"name": "cs_prod", "connector_id": "crowdstrike.falcon", "health": "failing"},',
        '    {"name": "s1_prod", "connector_id": "sentinelone.v2", "health": "healthy"},',
        ']',
        'chosen = resolve_containment(',
        '    _Stub({"crowdstrike": "aid-1", "sentinelone": "s1-1"}, degraded),',
        '    "org_X", "isolate_host", "host_X")',
        'if chosen["integration"] != "s1_prod":',
        '    failures.append("used a failing integration when a healthy one was available")',
        '',
        'return failures',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'check_capability_matrix',
      returns: 'List<string>',
      doc: [
        'The capability matrix has to stay honest: every supported action names a real',
        'command, every unsupported one carries a reason, and anything that isolates',
        'declares how to release.',
      ].join('\n'),
      implName: 'exercise_capability_matrix',
      code: [
        'failures = []',
        'matrix = edr_capability_matrix()',
        '',
        'for connector_id, capability in matrix.items():',
        '    if "agent_key" not in capability:',
        '        failures.append("%s has no agent_key" % connector_id)',
        '',
        '    # Every EDR must declare release for anything it can isolate. An isolate',
        '    # with no documented way back is a containment nobody will authorise twice.',
        '    if "isolate_host" in capability["supported"]:',
        '        if "release_host" not in capability["supported"]:',
        '            failures.append("%s isolates but declares no release" % connector_id)',
        '',
        '    for action, detail in capability["supported"].items():',
        '        if "command" not in detail:',
        '            failures.append("%s.%s names no command" % (connector_id, action))',
        '        if "reversible" not in detail:',
        '            failures.append("%s.%s does not say whether it is reversible"',
        '                            % (connector_id, action))',
        '',
        '    # An unsupported action must carry a REASON, not just be absent. "Absent"',
        '    # reads as an oversight; a reason reads as a fact about the vendor.',
        '    for action, reason in capability["unsupported"].items():',
        '        if len(reason) < 20:',
        '            failures.append("%s.%s: unsupported without an explanation"',
        '                            % (connector_id, action))',
        '',
        '# Every command the matrix names must actually exist in the catalogue.',
        'known = {c["key"] for c in all_commands()}',
        'for connector_id, capability in matrix.items():',
        '    for action, detail in capability["supported"].items():',
        '        if detail["command"] not in known:',
        '            failures.append("%s.%s names %s, which is not a real command"',
        '                            % (connector_id, action, detail["command"]))',
        '',
        'return failures',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'check_catalogue_rules',
      returns: 'List<string>',
      doc: [
        'The shipped catalogue must satisfy the rules the registry validator enforces:',
        'undo commands exist, mutating commands have a dry-run example, and HIGH-risk',
        'commands need a response permission.',
      ].join('\n'),
      implName: 'exercise_catalogue_rules',
      code: [
        'failures = []',
        '',
        'commands = {c["key"]: c for c in all_commands()}',
        'for command in commands.values():',
        '    undo = command.get("undo_command")',
        '    if undo and undo not in commands:',
        '        failures.append("%s names undo %s, which does not exist"',
        '                        % (command["key"], undo))',
        '',
        '# A mutating command with no dry-run example makes dry run a lie. The registry',
        '# validator refuses one; this checks the shipped catalogue actually complies.',
        'for command in commands.values():',
        '    if command["effect"] == "mutating" and not command.get("dry_run_example"):',
        '        failures.append("%s is mutating with no dry_run_example" % command["key"])',
        '',
        '# Every HIGH-risk command needs a response.* permission beyond commands.execute,',
        '# or RBAC cannot distinguish "may run automation" from "may isolate a host".',
        'for command in commands.values():',
        '    if command["risk_level"] != "high":',
        '        continue',
        '    if not any(p.startswith("response.") for p in command["required_permissions"]):',
        '        failures.append("%s is high risk but needs no response permission"',
        '                        % command["key"])',
        '',
        'return failures',
      ].join('\n'),
    });

    const cases: [string, string, string][] = [
      ['test_containment_resolves_per_host_edr', 'check_containment_resolution',
       'An abstract containment action resolves against the EDR that has an agent on this host, and refuses loudly where it cannot.'],
      ['test_capability_matrix_is_honest', 'check_capability_matrix',
       'Every supported action names a real command; every unsupported one carries a reason.'],
      ['test_shipped_catalogue_obeys_the_registry_rules', 'check_catalogue_rules',
       'Undo commands exist, mutating commands have a dry-run example, HIGH-risk commands need a response permission.'],
    ];

    for (const [name, target, doc] of cases) {
      const testCase = g.add('test/case', { name, kind: 'unit', doc });
      const call = g.add('control/call', { target, returns: 'List<string>' });
      const count = g.add('list/length');
      g.connect(call, 'result', count, 'a0');
      const zero = g.add('data/literal', { type: 'i64', value: '0' });
      const assertion = g.add('test/assert-equal', {
        message: 'every failure the check collected is printed in the list it returned',
      });
      g.connect(count, 'length', assertion, 'actual');
      g.connect(zero, 'value', assertion, 'expected');
      g.chain([testCase, 'out'], call, assertion);
    }

    exports_(response.file, []);
  }
  // -------------------------------------------------------------------------
  // tests/test_feeds.py -- the parsers, against documents in the shape the real
  // sources emit. Pure functions, so none of this needs a database or a network.
  // -------------------------------------------------------------------------
  const feeds = py(ctx, {
    path: 'tests/test_feeds.py',
    doc: 'feed and ATT&CK parsing',
    style: 'procedural',
    role: 'test',
    kind: 'hybrid',
  });
  {
    const g: GraphBuilder = feeds.g;

    fnWithBody(g, {
      name: 'check_misp_parsing',
      returns: 'List<string>',
      doc: 'A MISP event: to_ids filtering, composite types, tag-carried TLP, and the attribute types that are context rather than indicators.',
      implName: 'exercise_misp_parser',
      code: [
        'import json',
        '',
        'failures = []',
        'digest = "a" * 64',
        'event = {"Event": {',
        '    "uuid": "e-1", "info": "Test event",',
        '    "Tag": [{"name": "tlp:amber"}, {"name": "malware:emotet"}],',
        '    "Attribute": [',
        '        {"type": "ip-dst", "value": "203.0.113.5", "to_ids": True},',
        '        {"type": "domain", "value": "evil.example", "to_ids": True},',
        '        {"type": "filename|sha256", "value": "x.exe|" + digest,',
        '         "to_ids": True},',
        '        {"type": "comment", "value": "seen in a phish", "to_ids": True},',
        '        {"type": "ip-src", "value": "198.51.100.9", "to_ids": False},',
        '    ],',
        '}}',
        '',
        'parsed = parse_misp_feed(json.dumps(event), {"verdict": "malicious"})',
        'found = {record["type"]: record for record in parsed["indicators"]}',
        '',
        'if len(parsed["indicators"]) != 3:',
        '    failures.append("expected 3 indicators, got %d" % len(parsed["indicators"]))',
        'if "sha256" not in found:',
        '    failures.append("filename|sha256 did not yield a hash")',
        'elif found["sha256"]["normalised"] != digest:',
        '    failures.append("composite type stored %r rather than the hash alone"',
        '                    % found["sha256"]["normalised"])',
        '',
        '# to_ids false means MISP itself says this is not fit for detection.',
        'if any(r["normalised"] == "198.51.100.9" for r in parsed["indicators"]):',
        '    failures.append("a to_ids=false attribute was ingested")',
        'if parsed["rejected"] != 2:',
        '    failures.append("expected 2 rejections, got %d" % parsed["rejected"])',
        '',
        'for record in parsed["indicators"]:',
        '    if record["tlp"] != "amber":',
        '        failures.append("%s lost the event TLP" % record["normalised"])',
        '    if record["verdict"] != "malicious":',
        '        failures.append("%s did not take the feed verdict" % record["normalised"])',
        '',
        '# A manifest lists events rather than carrying them. Reporting nothing found',
        '# would be the wrong answer; naming what to fetch next is the right one.',
        'manifest = {"11111111-2222-3333-4444-555555555555": {"info": "an event",',
        '                                                     "date": "2026-01-01"}}',
        'listed = parse_misp_feed(json.dumps(manifest), {})',
        'if listed["follow"] != ["11111111-2222-3333-4444-555555555555.json"]:',
        '    failures.append("a MISP manifest was not recognised: %r" % listed)',
        '',
        'return failures',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'check_stix_parsing',
      returns: 'List<string>',
      doc: 'A STIX 2.1 bundle: pattern extraction, hash algorithm spellings, marking-definition TLP, and the rule patterns that are not observables at all.',
      implName: 'exercise_stix_parser',
      code: [
        'import json',
        '',
        'failures = []',
        'digest = "b" * 64',
        'bundle = {"type": "bundle", "spec_version": "2.1", "objects": [',
        '    {"type": "marking-definition", "id": "marking-definition--green",',
        '     "definition": {"tlp": "green"}},',
        '    {"type": "indicator", "id": "indicator--1", "pattern_type": "stix",',
        '     "pattern": "[file:hashes.\'SHA-256\' = \'" + digest + "\']",',
        '     "object_marking_refs": ["marking-definition--green"],',
        '     "labels": ["malicious-activity"], "confidence": 80,',
        '     "valid_until": "2030-01-01T00:00:00Z"},',
        '    {"type": "indicator", "id": "indicator--2", "pattern_type": "stix",',
        '     "pattern": "[ipv4-addr:value = \'198.51.100.7\' OR "',
        '                "domain-name:value = \'bad.example\']"},',
        '    {"type": "indicator", "id": "indicator--3", "pattern_type": "yara",',
        '     "pattern": "rule Example { condition: true }"},',
        '    {"type": "indicator", "id": "indicator--4", "pattern_type": "stix",',
        '     "pattern": "[windows-registry-key:key = \'HKLM\\\\\\\\Run\']"},',
        ']}',
        '',
        'parsed = parse_stix_feed(json.dumps(bundle), {})',
        'found = {record["normalised"]: record for record in parsed["indicators"]}',
        '',
        'if len(parsed["indicators"]) != 3:',
        '    failures.append("expected 3 observables, got %d: %r"',
        '                    % (len(parsed["indicators"]), sorted(found)))',
        'if digest not in found:',
        '    failures.append("file:hashes.\'SHA-256\' was not read as a sha256")',
        'elif found[digest]["tlp"] != "green":',
        '    failures.append("the marking-definition TLP did not reach the indicator")',
        'elif found[digest]["confidence"] != 80:',
        '    failures.append("STIX confidence was dropped")',
        'elif not found[digest]["expires_at"]:',
        '    failures.append("valid_until did not become an expiry")',
        '',
        '# One pattern, two observables joined by OR.',
        'if "198.51.100.7" not in found or "bad.example" not in found:',
        '    failures.append("a two-observable pattern was read as one")',
        '',
        '# A YARA rule and a registry key are not things an indicator lookup matches.',
        'if parsed["rejected"] != 2:',
        '    failures.append("expected 2 rejections, got %d" % parsed["rejected"])',
        'if not any("yara" in message for message in parsed["errors"]):',
        '    failures.append("the YARA pattern was rejected without saying why")',
        '',
        'return failures',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'check_csv_parsing',
      returns: 'List<string>',
      doc: 'Both CSV shapes: a real table with a header, and the bare one-value-per-line block list that most public feeds actually are.',
      implName: 'exercise_csv_parser',
      code: [
        'failures = []',
        '',
        'table = "\\n".join([',
        '    "# exported 2026-01-01",',
        '    "value,type,confidence,tlp,tags",',
        '    "evil2.example,domain,70,amber,botnet",',
        '    "hxxp://bad[.]example/x,url,,,",',
        '    "not an indicator,,,,",',
        '])',
        'parsed = parse_csv_feed(table, {})',
        'found = {record["normalised"]: record for record in parsed["indicators"]}',
        '',
        'if len(parsed["indicators"]) != 2:',
        '    failures.append("expected 2 rows, got %d: %r"',
        '                    % (len(parsed["indicators"]), sorted(found)))',
        'if "evil2.example" in found and found["evil2.example"]["confidence"] != 70:',
        '    failures.append("the confidence column was not read")',
        '',
        '# Analysts and feeds both ship defanged values. Treating them as unknown',
        '# strings is a bug, not strictness.',
        'if "http://bad.example/x" not in found:',
        '    failures.append("a defanged URL was not refanged: %r" % sorted(found))',
        'if parsed["rejected"] != 1:',
        '    failures.append("the unclassifiable row was not reported as rejected")',
        '',
        'plain = "\\n".join(["# a block list", "198.51.100.10", "evil3.example", ""])',
        'listed = parse_csv_feed(plain, {})',
        'if len(listed["indicators"]) != 2:',
        '    failures.append("a bare block list did not parse: %r" % listed)',
        '',
        '# Three shapes taken from feeds that are actually published. Each one broke',
        '# a parser that passed on tidy fixtures, which is the whole reason they are',
        '# here rather than a neater invented file.',
        '',
        '# URLhaus: the column header is inside a comment. Strip every comment and',
        '# the header goes with it, after which the id column looks like the',
        '# indicator column and all of it is confidently wrong.',
        'urlhaus = "\\n".join([',
        '    "# Terms Of Use: https://urlhaus.abuse.ch/api/",',
        '    "# id,dateadded,url,url_status,threat,tags",',
        '    \'"3917037","2026-09-15 14:35:30","http://198.51.100.14:43147/i",\'',
        '    \'"offline","malware_download","elf,Mozi"\',',
        '])',
        'parsed = parse_csv_feed(urlhaus, {})',
        'if len(parsed["indicators"]) != 1:',
        '    failures.append("a commented header was not recovered: %r" % parsed)',
        'elif parsed["indicators"][0]["type"] != "url":',
        '    failures.append("the id column was read as the indicator")',
        'elif "Mozi" not in parsed["indicators"][0]["tags"]:',
        '    failures.append("the tags column was not read")',
        '',
        '# MalwareBazaar: a space after each comma, so the quote is not at the start',
        '# of the field and csv does not treat it as quoted. The cell keeps its',
        '# quotes, and a hash with a quote on it matches nothing anywhere.',
        'digest = "c" * 64',
        'bazaar = "\\n".join([',
        '    "# first_seen_utc, sha256_hash, file_type",',
        '    \'"2026-09-15 08:00:00", "%s", "exe"\' % digest,',
        '])',
        'parsed = parse_csv_feed(bazaar, {})',
        'if len(parsed["indicators"]) != 1:',
        '    failures.append("a space-after-comma CSV did not parse: %r" % parsed)',
        'elif parsed["indicators"][0]["normalised"] != digest:',
        '    failures.append("a quoted cell kept its quotes: %r"',
        '                    % parsed["indicators"][0]["normalised"])',
        '',
        '# Feodo Tracker: a plain header that names no column "value". The indicator',
        '# column here is dst_ip, and the first column is a timestamp.',
        'feodo = "\\n".join([',
        '    "# abuse.ch Feodo Tracker Botnet C2 IP Blocklist (CSV)",',
        '    \'"first_seen_utc","dst_ip","dst_port","c2_status","malware"\',',
        '    \'"2026-06-04 21:24:53","198.51.100.246","8080","offline","Emotet"\',',
        '])',
        'parsed = parse_csv_feed(feodo, {})',
        'if len(parsed["indicators"]) != 1:',
        '    failures.append("an unfamiliar header stopped the parse: %r" % parsed)',
        'elif parsed["indicators"][0]["normalised"] != "198.51.100.246":',
        '    failures.append("dst_ip was not found as the indicator column: %r"',
        '                    % parsed["indicators"][0]["normalised"])',
        '',
        '# And the honest failure: a document with no indicator column at all says so',
        '# rather than returning nothing and looking like an empty feed.',
        'opaque = "\\n".join(["alpha,beta,gamma", "1,2,3", "4,5,6"])',
        'parsed = parse_csv_feed(opaque, {})',
        'if not parsed["errors"]:',
        '    failures.append("a document with no indicator column reported no reason")',
        '',
        '# The format is worth guessing, because feeds change shape without notice.',
        'if sniff_feed_format(plain) != "csv":',
        '    failures.append("a block list was not sniffed as csv")',
        'if sniff_feed_format(\'{"type": "bundle", "objects": []}\') != "stix":',
        '    failures.append("a STIX bundle was not sniffed as stix")',
        '',
        'return failures',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'check_feed_ingest_safety',
      returns: 'List<string>',
      doc: [
        'The two things feed ingestion must never do.',
        '',
        'It must not store an address inside the organisation\'s own network - public',
        'block lists do occasionally ship one, and the platform would then hold an',
        'indicator that matches its own estate. And it must not record a sighting: a',
        'feed listing an indicator is not an observation of it here.',
      ].join('\n'),
      implName: 'exercise_ingest_safety',
      code: [
        'failures = []',
        '',
        'class StubDatabase:',
        '    def __init__(self):',
        '        self.statement = ""',
        '        self.rows = []',
        '',
        '    def execute_many(self, sql, rows, org_id):',
        '        self.statement = sql',
        '        self.rows = rows',
        '        return len(rows)',
        '',
        'records = [',
        '    {"type": "ipv4", "value": "8.8.8.8", "normalised": "8.8.8.8",',
        '     "verdict": "suspicious", "tags": [], "confidence": None, "tlp": None,',
        '     "expires_at": None},',
        '    {"type": "ipv4", "value": "10.0.0.1", "normalised": "10.0.0.1",',
        '     "verdict": "suspicious", "tags": [], "confidence": None, "tlp": None,',
        '     "expires_at": None},',
        '    {"type": "registry", "value": "HKLM", "normalised": "HKLM",',
        '     "verdict": "suspicious", "tags": [], "confidence": None, "tlp": None,',
        '     "expires_at": None},',
        ']',
        '',
        'db = StubDatabase()',
        'result = ingest_feed_batch(db, "org-1", records, {})',
        '',
        'if result["stored"] != 1:',
        '    failures.append("expected 1 stored, got %d" % result["stored"])',
        'if result["dropped"] != 2:',
        '    failures.append("expected 2 dropped, got %d" % result["dropped"])',
        'if any("10.0.0.1" in row for row in db.rows):',
        '    failures.append("a private address was written to the intel table")',
        '',
        'if "sighting_count" in db.statement:',
        '    failures.append("feed ingestion touched sighting_count; a feed entry is "',
        '                    "not a sighting")',
        'if "last_seen" in db.statement:',
        '    failures.append("feed ingestion touched last_seen; a feed says nothing "',
        '                    "about when an indicator was seen here")',
        'if "is_whitelisted" not in db.statement:',
        '    failures.append("feed ingestion can re-verdict a whitelisted indicator")',
        '',
        'return failures',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'check_attack_bundle',
      returns: 'List<string>',
      doc: 'An ATT&CK bundle: every tactic a technique belongs to, sub-technique parentage, and the objects that cannot be placed on the matrix.',
      implName: 'exercise_attack_parser',
      code: [
        'import json',
        '',
        'failures = []',
        'bundle = {"type": "bundle", "spec_version": "2.1", "objects": [',
        '    {"type": "attack-pattern", "id": "attack-pattern--1",',
        '     "name": "Valid Accounts",',
        '     "external_references": [',
        '         {"source_name": "mitre-attack", "external_id": "T1078",',
        '          "url": "https://attack.mitre.org/techniques/T1078"}],',
        '     "kill_chain_phases": [',
        '         {"kill_chain_name": "mitre-attack", "phase_name": "persistence"},',
        '         {"kill_chain_name": "mitre-attack", "phase_name": "defense-evasion"},',
        '         {"kill_chain_name": "mitre-attack", "phase_name": "initial-access"}],',
        '     "x_mitre_platforms": ["Windows", "Linux"], "x_mitre_version": "2.6"},',
        '    {"type": "attack-pattern", "id": "attack-pattern--2",',
        '     "name": "Domain Accounts",',
        '     "external_references": [',
        '         {"source_name": "mitre-attack", "external_id": "T1078.002"}],',
        '     "kill_chain_phases": [',
        '         {"kill_chain_name": "mitre-attack", "phase_name": "persistence"}],',
        '     "x_mitre_is_subtechnique": True},',
        '    {"type": "attack-pattern", "id": "attack-pattern--3", "name": "Unplaceable",',
        '     "external_references": [',
        '         {"source_name": "mitre-attack", "external_id": "T9999"}]},',
        '    {"type": "attack-pattern", "id": "attack-pattern--4", "name": "Withdrawn",',
        '     "external_references": [',
        '         {"source_name": "mitre-attack", "external_id": "T1000"}],',
        '     "kill_chain_phases": [',
        '         {"kill_chain_name": "mitre-attack", "phase_name": "execution"}],',
        '     "revoked": True},',
        '    {"type": "course-of-action", "id": "course-of-action--1", "name": "Ignore me"},',
        ']}',
        '',
        'parsed = parse_attack_bundle(json.dumps(bundle))',
        'found = {technique["id"]: technique for technique in parsed["techniques"]}',
        '',
        'if len(parsed["techniques"]) != 3:',
        '    failures.append("expected 3 techniques, got %d: %r"',
        '                    % (len(parsed["techniques"]), sorted(found)))',
        '',
        '# T1078 is in four tactics in the real matrix. A loader that keeps one makes',
        '# the others look empty, which is a coverage report that lies.',
        'if "T1078" in found and len(found["T1078"]["tactics"]) != 3:',
        '    failures.append("a multi-tactic technique kept only %r"',
        '                    % found["T1078"]["tactics"])',
        'if "T1078" in found and found["T1078"]["tactic"] != "defense-evasion":',
        '    failures.append("the sort tactic is not the first alphabetically")',
        '',
        'if "T1078.002" in found:',
        '    child = found["T1078.002"]',
        '    if not child["is_subtechnique"]:',
        '        failures.append("T1078.002 was not marked a sub-technique")',
        '    if child["parent_id"] != "T1078":',
        '        failures.append("T1078.002 was not linked to its parent")',
        '',
        'if "T1000" in found and not found["T1000"]["revoked"]:',
        '    failures.append("a revoked technique was loaded as current")',
        '',
        '# A technique with no kill-chain phase has no column to sit in.',
        'if "T9999" in found:',
        '    failures.append("a technique with no tactic was kept")',
        'if not any("T9999" in message for message in parsed["errors"]):',
        '    failures.append("a technique was skipped without saying which")',
        '',
        'return failures',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'check_taxii_protocol',
      returns: 'List<string>',
      doc: 'Discovery, collection listing, envelopes and URL building, against the shapes a real TAXII 2.0 and 2.1 server answers with.',
      implName: 'exercise_taxii_reader',
      code: [
        'import json',
        '',
        'failures = []',
        '',
        '# Version negotiation is done entirely through Accept, and a 2.0 server',
        '# answers 406 to the 2.1 media type rather than falling back.',
        'if "version=2.1" not in taxii_accept("2.1", "objects"):',
        '    failures.append("2.1 did not ask for the 2.1 media type")',
        'if "stix" not in taxii_accept("2.0", "objects"):',
        '    failures.append("2.0 objects must be asked for as STIX, not TAXII")',
        'if "taxii" not in taxii_accept("2.0", "collections"):',
        '    failures.append("2.0 collections must be asked for as TAXII")',
        '',
        'discovery = taxii_discovery(json.dumps({',
        '    "title": "Example TAXII Server",',
        '    "default": "https://example.test/api2/",',
        '    "api_roots": ["https://example.test/api1/", "https://example.test/api2"],',
        '}), "https://example.test/taxii2/")',
        'roots = discovery["api_roots"]',
        'if len(roots) != 2:',
        '    failures.append("expected 2 api roots, got %r" % roots)',
        '# The default is the root an unconfigured client is meant to use, and it is',
        '# not always listed in api_roots. Listed first, and never twice.',
        'elif roots[0] != "https://example.test/api2/":',
        '    failures.append("the default api root was not put first: %r" % roots)',
        '',
        'bare = taxii_discovery(json.dumps({"api_roots": []}),',
        '                       "https://example.test/taxii2/")',
        'if bare["api_roots"]:',
        '    failures.append("an empty discovery invented a root")',
        '',
        '# The spec calls api_roots URLs and real servers return paths - the ATT&CK',
        '# TAXII server answers "/api/v21/". Taken literally that is a request with',
        '# no scheme, and the error surfaces a long way from the cause.',
        'relative = taxii_discovery(json.dumps({"api_roots": ["/api/v21/"]}),',
        '                           "https://attack-taxii.example/taxii2/")',
        'if relative["api_roots"] != ["https://attack-taxii.example/api/v21/"]:',
        '    failures.append("a relative api root was not resolved: %r"',
        '                    % relative["api_roots"])',
        '',
        'collections = taxii_collections(json.dumps({"collections": [',
        '    {"id": "91a7b528-80eb-42ed-a74d-c6fbd5a26116", "title": "High Value",',
        '     "can_read": True, "media_types": ["application/stix+json;version=2.1"]},',
        '    {"id": "52892447-4d7e-4f70-b94d-d7f22742ff63", "title": "Write Only",',
        '     "can_read": False, "can_write": True},',
        '    {"id": "no-can-read-field", "title": "Legacy 2.0"},',
        ']}))["collections"]',
        'if len(collections) != 3:',
        '    failures.append("expected 3 collections, got %d" % len(collections))',
        '# A 2.0 server routinely omits can_read. Refusing to poll a collection the',
        '# server would have served is worse than trying and being told no.',
        'legacy = [c for c in collections if c["id"] == "no-can-read-field"]',
        'if legacy and not legacy[0]["can_read"]:',
        '    failures.append("a missing can_read was read as unreadable")',
        '',
        'url = taxii_objects_url("https://example.test/api1", "a b/c")',
        'if url != "https://example.test/api1/collections/a%20b%2Fc/objects/":',
        '    failures.append("the collection id was not percent-encoded: %s" % url)',
        '',
        '# 2.1 answers with an envelope; 2.0 answers with a plain bundle.',
        'envelope = taxii_envelope(json.dumps({',
        '    "more": True, "next": "cursor-2", "objects": [{"type": "indicator"}]}))',
        'if not envelope["more"] or envelope["next"] != "cursor-2":',
        '    failures.append("the 2.1 envelope cursor was not read")',
        'bundle = taxii_envelope(json.dumps({',
        '    "type": "bundle", "objects": [{"type": "indicator"}]}))',
        'if bundle["more"] or len(bundle["objects"]) != 1:',
        '    failures.append("a 2.0 bundle was not read as one un-paged page")',
        '',
        'query = taxii_page_query("2.1", "2026-01-01T00:00:00Z", 100, "cursor-2")',
        'if query.get("added_after") != "2026-01-01T00:00:00Z":',
        '    failures.append("the watermark was not sent as added_after")',
        'if query.get("limit") != "100" or query.get("next") != "cursor-2":',
        '    failures.append("2.1 paging parameters were not sent: %r" % query)',
        '',
        '# 2.0 pages by Range header, so limit and next are meaningless to it.',
        'old = taxii_page_query("2.0", "2026-01-01T00:00:00Z", 100, "cursor-2")',
        'if "limit" in old or "next" in old:',
        '    failures.append("2.0 was sent 2.1 paging parameters: %r" % old)',
        'if old.get("added_after") != "2026-01-01T00:00:00Z":',
        '    failures.append("2.0 was not sent the watermark")',
        '',
        'if taxii_content_range_total("items 0-99/1000") != 1000:',
        '    failures.append("Content-Range total was not read")',
        'if taxii_content_range_total("items 0-99/*") != -1:',
        '    failures.append("an unknown Content-Range total was not reported as -1")',
        '',
        'return failures',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'check_taxii_watermark',
      returns: 'List<string>',
      doc: [
        'The watermark rules, which are what make polling incremental and safe.',
        '',
        'Every one of these is a way a poller silently loses indicators or silently',
        're-reads a whole collection forever, and none of them raises anything.',
      ].join('\n'),
      implName: 'exercise_taxii_watermark',
      code: [
        'failures = []',
        '',
        'objects = [{"type": "indicator", "modified": "2026-01-01T00:00:00Z"},',
        '           {"type": "indicator", "modified": "2026-01-02T00:00:00Z"}]',
        '',
        '# The server\'s own marker refers to when it ACCEPTED the object, which is',
        '# what added_after filters on. An object\'s modified is a different clock.',
        'advanced = taxii_watermark(objects, "2026-06-01T00:00:00Z", None)',
        'if advanced != "2026-06-01T00:00:00Z":',
        '    failures.append("X-TAXII-Date-Added-Last was not preferred: %r" % advanced)',
        '',
        '# Without the header the newest modified is all there is.',
        'fallback = taxii_watermark(objects, None, None)',
        'if fallback != "2026-01-02T00:00:00Z":',
        '    failures.append("the newest modified was not used as a fallback: %r"',
        '                    % fallback)',
        '',
        '# Never backwards. A server answering an old page would otherwise make the',
        '# next poll re-read everything from that point, forever.',
        'held = taxii_watermark(objects, "2025-01-01T00:00:00Z", "2026-06-01T00:00:00Z")',
        'if held != "2026-06-01T00:00:00Z":',
        '    failures.append("the watermark moved backwards: %r" % held)',
        '',
        '# Compared as moments, not as text. "...00.000Z" sorts BEFORE "...00Z" as a',
        '# string because "." is below "Z", which would move a watermark backwards on',
        '# any server that varies its fractional precision.',
        'precise = taxii_watermark([], "2026-06-01T00:00:00.500Z", "2026-06-01T00:00:00Z")',
        'if precise != "2026-06-01T00:00:00.500Z":',
        '    failures.append("a fractional timestamp was compared as a string: %r"',
        '                    % precise)',
        '',
        '# Nothing to learn from means hold position, not reset.',
        'empty = taxii_watermark([], None, "2026-06-01T00:00:00Z")',
        'if empty != "2026-06-01T00:00:00Z":',
        '    failures.append("an empty page reset the watermark: %r" % empty)',
        'unparseable = taxii_watermark([], "not a date", "2026-06-01T00:00:00Z")',
        'if unparseable != "2026-06-01T00:00:00Z":',
        '    failures.append("an unparseable header reset the watermark: %r"',
        '                    % unparseable)',
        '',
        'return failures',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'check_public_routes',
      returns: 'List<string>',
      doc: [
        'Exactly the routes that must work without a session are public.',
        '',
        'Both directions matter. Too few and sign-in is impossible - the login',
        'endpoint needs the session it is supposed to create. Too many and an',
        'endpoint is reachable by anyone who can open a socket.',
      ].join('\n'),
      implName: 'exercise_public_routes',
      code: [
        'failures = []',
        '',
        'expected = {"/api/auth/login", "/api/auth/mfa",',
        '            "/healthz", "/readyz", "/metrics"}',
        'public = {r["path"] for r in route_table() if r.get("public")}',
        '',
        'for path in sorted(public - expected):',
        '    failures.append("%s is reachable without a session" % path)',
        'for path in sorted(expected - public):',
        '    failures.append("%s needs a session it cannot have yet" % path)',
        '',
        '# A public route must not also demand a permission: there is no principal',
        '# to check one against, so it could only ever fail.',
        'for entry in route_table():',
        '    if entry.get("public") and entry.get("permission"):',
        '        failures.append("%s is public and yet requires %s"',
        '                        % (entry["path"], entry["permission"]))',
        '',
        'return failures',
      ].join('\n'),
    });

    const feedCases: [string, string, string][] = [
      ['test_misp_events_parse_the_way_misp_means_them', 'check_misp_parsing',
       'to_ids is honoured, composite types are split, and the event TLP travels with every attribute.'],
      ['test_stix_patterns_yield_observables_not_rule_text', 'check_stix_parsing',
       'Comparison expressions become observables; YARA and Snort patterns are refused with a reason.'],
      ['test_csv_and_block_lists_both_parse', 'check_csv_parsing',
       'A headed table and a bare one-value-per-line list are both read, and defanged values are refanged.'],
      ['test_feed_ingestion_claims_no_sighting', 'check_feed_ingest_safety',
       'Ingestion never touches sighting_count, never re-verdicts a whitelisted indicator, and never stores a private address.'],
      ['test_attack_bundle_keeps_every_tactic', 'check_attack_bundle',
       'Techniques keep all their tactics, sub-techniques keep their parent, and unplaceable objects are reported.'],
      ['test_taxii_protocol_reads_both_versions', 'check_taxii_protocol',
       'Discovery, collections, envelopes and paging parameters, for TAXII 2.0 and 2.1.'],
      ['test_taxii_watermark_never_skips_or_rewinds', 'check_taxii_watermark',
       'The watermark prefers the server marker, falls back safely, is compared as a moment, and never moves backwards.'],
      ['test_only_sign_in_and_health_are_public', 'check_public_routes',
       'Exactly the five routes that must work without a session are public, and no public route demands a permission.'],
    ];

    for (const [name, target, doc] of feedCases) {
      const testCase = g.add('test/case', { name, kind: 'unit', doc });
      const call = g.add('control/call', { target, returns: 'List<string>' });
      const count = g.add('list/length');
      g.connect(call, 'result', count, 'a0');
      const zero = g.add('data/literal', { type: 'i64', value: '0' });
      const assertion = g.add('test/assert-equal', {
        message: 'every failure the check collected is printed in the list it returned',
      });
      g.connect(count, 'length', assertion, 'actual');
      g.connect(zero, 'value', assertion, 'expected');
      g.chain([testCase, 'out'], call, assertion);
    }

    exports_(feeds.file, []);
  }
}
