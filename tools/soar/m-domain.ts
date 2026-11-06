/**
 * Domain modules: normalize, intel, incidents.
 *
 * The normalisation boundary is the one that keeps playbooks vendor-independent:
 * every ingest path produces the same Common Security Event Model, and no
 * playbook ever reads a vendor's JSON.
 */

import { addModule } from '#core/project/builder.ts';
import type { ProjectModule } from '#core/model/project.ts';
import type { Ctx } from './kit.ts';
import { exports_, fnWithBody, iface, imports_, py } from './kit.ts';
import type { CoreModules } from './m-core.ts';
import { buildFeeds } from './m-feeds.ts';

export interface DomainModules {
  normalize: ProjectModule;
  intel: ProjectModule;
  incidents: ProjectModule;
}

export function buildDomain(ctx: Ctx, core: CoreModules): DomainModules {
  const normalize = addModule(ctx.project, {
    name: 'normalize',
    directory: 'src/soar/normalize',
    description:
      'Vendor JSON in, Common Security Event Model out. Playbooks read the normalised alert and never the raw event.',
    dependencies: [core.platform.id],
  });
  const intel = addModule(ctx.project, {
    name: 'intel',
    directory: 'src/soar/intel',
    description:
      'Indicators, sightings, enrichment caching, scoring and MITRE ATT&CK. Observables are deduplicated globally; sightings are not.',
    dependencies: [core.platform.id, core.storage.id],
  });
  const incidents = addModule(ctx.project, {
    name: 'incidents',
    directory: 'src/soar/incidents',
    description:
      'Incidents, alerts, cases, tasks and the timeline. Every state change is permission-checked, timelined and audited in one place.',
    dependencies: [core.platform.id, core.storage.id, core.identity.id, core.audit.id, intel.id],
  });

  // -------------------------------------------------------------------------
  // normalize/model.py
  // -------------------------------------------------------------------------
  const model = py(ctx, { path: 'src/normalize/model.py', module: normalize, doc: 'common security event model', style: 'procedural' });
  {
    const g = model.g;

    fnWithBody(g, {
      name: 'empty_alert',
      returns: 'Map<string, Any>',
      doc: 'The Common Security Event Model, in full. Every field a playbook may read exists here with a defined default, so a playbook never has to ask whether a key is present.',
      implName: 'csem_skeleton',
      code: [
        'return {',
        '    "schema": "csem/1",',
        '    "source": "",',
        '    "vendor_alert_id": "",',
        '    "title": "",',
        '    "description": "",',
        '    "severity": "medium",',
        '    "raw_severity": "",',
        '    "confidence": 50,',
        '    "category": "unknown",',
        '    "technique_ids": [],',
        '    "observed_at": "",',
        '    "entities": [],',
        '    "indicators": [],',
        '    "evidence": [],',
        '    "vendor": {},',
        '}',
      ].join('\n'),
    });

    // Severity mapping is drawn, because it is the field a SOC most often wants
    // to argue about and change without a deployment.
    const sev = g.add('entry/function', {
      name: 'normalise_severity',
      params: [{ name: 'raw', type: 'string' }],
      returns: 'string',
      doc: 'Map a vendor severity onto the platform scale. Unknown values become "medium" and are recorded in raw_severity rather than being silently dropped.',
    });
    const lower = g.add('string/lower');
    g.connect(sev, 'p:raw', lower, 'a0');
    const table = g.add('map/literal', { keyType: 'string', valueType: 'string' });
    const rows: [string, string][] = [
      ['critical', 'critical'],
      ['high', 'high'],
      ['medium', 'medium'],
      ['moderate', 'medium'],
      ['low', 'low'],
      ['informational', 'info'],
      ['info', 'info'],
      ['severe', 'critical'],
      ['5', 'critical'],
      ['4', 'high'],
      ['3', 'medium'],
      ['2', 'low'],
      ['1', 'info'],
    ];
    rows.forEach(([k, v], i) => {
      const kid = i === 0 ? 'k' : g.addVariadic(table, 'k', 'in');
      const vid = i === 0 ? 'v' : g.addVariadic(table, 'v', 'in');
      g.setDefault(table, kid, k);
      g.setDefault(table, vid, v);
    });
    const lookup = g.add('map/get-or');
    g.connect(table, 'map', lookup, 'a0');
    g.connect(lower, 'text', lookup, 'a1');
    g.setDefault(lookup, 'a2', 'medium');
    const retSev = g.add('control/return');
    g.connect(lookup, 'value', retSev, 'value');
    g.chain([sev, 'out'], retSev);

    fnWithBody(g, {
      name: 'severity_rank',
      params: [{ name: 'severity', type: 'string' }],
      returns: 'i64',
      doc: 'An orderable rank, so "is this worse than that" is one comparison rather than a chain of string tests.',
      implName: 'rank_of_severity',
      code: [
        'return {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}.get(',
        '    str(severity).lower(), 2',
        ')',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'validate_alert',
      params: [{ name: 'alert', type: 'Map<string, Any>' }],
      returns: 'List<string>',
      doc: 'Structural check on a normalised alert. A mapping that produces a malformed alert fails at ingest, where it is a configuration problem, rather than three steps into a playbook at 03:00.',
      implName: 'check_csem_shape',
      code: [
        'problems = []',
        'if alert.get("schema") != "csem/1":',
        '    problems.append("schema must be csem/1")',
        'for field in ("source", "vendor_alert_id", "title", "observed_at"):',
        '    if not alert.get(field):',
        '        problems.append("missing required field: " + field)',
        'if alert.get("severity") not in ("info", "low", "medium", "high", "critical"):',
        '    problems.append("severity outside the platform scale")',
        'if not isinstance(alert.get("entities"), list):',
        '    problems.append("entities must be a list")',
        'if not isinstance(alert.get("indicators"), list):',
        '    problems.append("indicators must be a list")',
        '',
        '# An indicator whose value is an object is a mapping pointing one level',
        '# too high. It used to pass, and what reached the analyst queue was the',
        '# repr of a dict presented as an IP address.',
        'for indicator in alert.get("indicators") or []:',
        '    value = indicator.get("value") if isinstance(indicator, dict) else None',
        '    if isinstance(value, (dict, list)):',
        '        problems.append(',
        '            "indicator %r resolved to a %s, so its mapping names a "',
        '            "container rather than a value"',
        '            % (indicator.get("type"), type(value).__name__))',
        '    elif value in (None, ""):',
        '        problems.append("indicator %r has no value"',
        '                        % indicator.get("type"))',
        '',
        'for entity in alert.get("entities") or []:',
        '    for key, value in (entity or {}).items():',
        '        if isinstance(value, (dict, list)):',
        '            problems.append(',
        '                "entity field %r resolved to a %s"',
        '                % (key, type(value).__name__))',
        'return problems',
      ].join('\n'),
    });

    exports_(model.file, [
      { name: 'empty_alert', sort: 'function' },
      { name: 'normalise_severity', sort: 'function' },
      { name: 'severity_rank', sort: 'function' },
      { name: 'validate_alert', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // normalize/mappings.py
  // -------------------------------------------------------------------------
  const mappings = py(ctx, { path: 'src/normalize/mappings.py', module: normalize, doc: 'vendor field mappings', style: 'data-flow' });
  {
    const g = mappings.g;
    fnWithBody(g, {
      name: 'builtin_mappings',
      returns: 'Map<string, Any>',
      doc: [
        'Vendor mappings as data, not as code.',
        '',
        'A mapping is a set of source paths into the vendor payload. Adding a',
        'vendor is adding a dictionary - which is the whole point of a no-code',
        'platform, and which the UI edits directly. None of these are special-cased',
        'anywhere in the engine.',
      ].join('\n'),
      implName: 'mapping_table',
      code: [
        'return {',
        '    # CrowdStrike Alerts API v2 first - that is what recent_detections',
        '    # and list_alerts query - with the Detections API it replaced as the',
        '    # fallback, because plenty of tenants still send that shape.',
        '    "crowdstrike.falcon": {',
        '        "vendor_alert_id": ["$.composite_id", "$.detection_id",',
        '                             "$.id"],',
        '        "title": ["$.display_name", "$.behaviors[0].display_name",',
        '                  "$.name"],',
        '        "description": ["$.description",',
        '                        "$.behaviors[0].description"],',
        '        "raw_severity": ["$.severity_name",',
        '                         "$.max_severity_displayname"],',
        '        "observed_at": ["$.timestamp", "$.created_timestamp",',
        '                        "$.first_behavior"],',
        '        "category": ["$.tactic", "$.behaviors[0].tactic"],',
        '        "technique_ids": ["$.technique_id",',
        '                          "$.behaviors[0].technique_id"],',
        '        "entities": [',
        '            {"kind": "host",',
        '             "hostname": ["$.device.hostname", "$.hostname"],',
        '             "agent_id": ["$.device.device_id", "$.device_id",',
        '                          "$.aid"],',
        '             "os": ["$.device.os_version", "$.device.platform_name",',
        '                    "$.platform"],',
        '             "domain": ["$.device.machine_domain"],',
        '             "site": ["$.device.site_name"],',
        '             "internal_ip": ["$.device.local_ip"],',
        '             "external_ip": ["$.device.external_ip"],',
        '             "mac": ["$.device.mac_address"],',
        '             "agent_version": ["$.device.agent_version"]},',
        '            {"kind": "identity",',
        '             "upn": ["$.user_name", "$.behaviors[0].user_name"],',
        '             "domain": ["$.logon_domain", "$.user_domain"],',
        '             "sid": ["$.user_id"]},',
        '            {"kind": "process",',
        '             "name": ["$.filename", "$.behaviors[0].filename"],',
        '             "path": ["$.filepath", "$.behaviors[0].filepath"],',
        '             "command_line": ["$.cmdline",',
        '                              "$.behaviors[0].cmdline"],',
        '             "pid": ["$.process_id"],',
        '             "parent": ["$.parent_details.filename"],',
        '             "parent_command_line": ["$.parent_details.cmdline"],',
        '             "parent_sha256": ["$.parent_details.sha256"]},',
        '        ],',
        '        "indicators": [',
        '            {"type": "sha256",',
        '             "value": ["$.sha256", "$.behaviors[0].sha256"]},',
        '            {"type": "md5", "value": ["$.md5",',
        '                                     "$.behaviors[0].md5"]},',
        '            {"type": "file_path",',
        '             "value": ["$.filepath", "$.behaviors[0].filepath"]},',
        '            {"type": "ipv4", "value": ["$.device.external_ip"]},',
        '            {"type": "ipv4", "value": ["$.device.local_ip"]},',
        '            {"type": "sha256", "value": ["$.parent_details.sha256"]},',
        '            {"type": "file_path",',
        '             "value": ["$.parent_details.filepath"]},',
        '        ],',
        '        # Beyond the model, and worth having in front of the analyst.',
        '        "confidence_pct": ["$.confidence"],',
        '        "prevention": ["$.pattern_disposition_details.kill_process"],',
        '        "objective": ["$.objective"],',
        '        "falcon_link": ["$.falcon_host_link"],',
        '        "agent_version": ["$.device.agent_version"],',
        '        "global_prevalence": ["$.global_prevalence"],',
        '    },',
        '',
        '    # Keyed by the connector id, not by a shortened vendor name: this is',
        '    # looked up with integration.connector_id and "microsoft.defender"',
        '    # never matched "microsoft.defender_endpoint", so the mapping was',
        '    # here and unreachable.',
        '    "microsoft.defender_endpoint": {',
        '        "vendor_alert_id": "$.id",',
        '        "title": "$.title",',
        '        "description": "$.description",',
        '        "raw_severity": "$.severity",',
        '        "observed_at": ["$.alertCreationTime", "$.firstEventTime"],',
        '        "category": "$.category",',
        '        "technique_ids": "$.mitreTechniques",',
        '        "entities": [',
        '            {"kind": "host",',
        '             "hostname": ["$.computerDnsName",',
        '                          "$.evidence[*].deviceDnsName"],',
        '             "agent_id": ["$.machineId",',
        '                          "$.evidence[*].machineId"]},',
        '            {"kind": "identity",',
        '             "upn": ["$.evidence[*].userPrincipalName"],',
        '             "account": ["$.relatedUser.userName",',
        '                         "$.evidence[*].accountName"],',
        '             "domain": ["$.relatedUser.domainName"],',
        '             "sid": ["$.evidence[*].userSid"]},',
        '            {"kind": "process",',
        '             "name": ["$.evidence[*].fileName"],',
        '             "path": ["$.evidence[*].filePath"],',
        '             "command_line": ["$.evidence[*].processCommandLine"],',
        '             "parent": ["$.evidence[*].parentProcessFileName"]},',
        '        ],',
        '        "indicators": [',
        '            {"type": "sha256", "value": "$.evidence[*].sha256"},',
        '            {"type": "ipv4", "value": "$.evidence[*].ipAddress"},',
        '            {"type": "url", "value": "$.evidence[*].url"},',
        '            {"type": "sha1", "value": "$.evidence[*].sha1"},',
        '            {"type": "file_path", "value": "$.evidence[*].filePath"},',
        '        ],',
        '        "detection_source": ["$.detectionSource"],',
        '        "defender_incident": ["$.incidentId"],',
        '        "investigation_state": ["$.investigationState"],',
        '        "device_group": ["$.rbacGroupName"],',
        '    },',
        '',
        '    # Sentinel INCIDENTS, because list_incidents and get_incident are',
        '    # what this connector polls. The SecurityAlert shape is kept as the',
        '    # fallback for a tenant that forwards alerts instead.',
        '    "microsoft.sentinel": {',
        '        "vendor_alert_id": ["$.name", "$.properties.incidentNumber",',
        '                             "$.properties.systemAlertId"],',
        '        "title": ["$.properties.title",',
        '                  "$.properties.alertDisplayName"],',
        '        "description": "$.properties.description",',
        '        "raw_severity": "$.properties.severity",',
        '        "observed_at": ["$.properties.createdTimeUtc",',
        '                        "$.properties.firstActivityTimeUtc",',
        '                        "$.properties.timeGenerated"],',
        '        "category": ["$.properties.additionalData.alertProductNames[0]",',
        '                     "$.properties.alertType"],',
        '        "technique_ids": ["$.properties.additionalData.techniques",',
        '                          "$.properties.techniques"],',
        '        "entities": [',
        '            {"kind": "host",',
        '             "hostname": ["$.properties.entities[*].properties.hostName",',
        '                          "$.properties.entities[*].HostName"]},',
        '            # Sentinel splits a UPN across two fields on the Account',
        '            # entity, so mapping upnSuffix to upn put the DOMAIN in front',
        '            # of the analyst where the user should have been. They are',
        '            # carried separately rather than joined, because the mapping',
        '            # model reads paths and does not concatenate - and a wrong',
        '            # join is worse than two honest fields.',
        '            {"kind": "identity",',
        '             "account": ["$.properties.entities[*].properties.accountName",',
        '                         "$.properties.entities[*].Name"],',
        '             "domain": ["$.properties.entities[*].properties.upnSuffix",',
        '                        "$.properties.entities[*].UPNSuffix"],',
        '             "aad_user_id": ["$.properties.entities[*].properties.aadUserId",',
        '                             "$.properties.entities[*].AadUserId"],',
        '             "owner": ["$.properties.owner.userPrincipalName"]},',
        '        ],',
        '        "indicators": [',
        '            {"type": "ipv4",',
        '             "value": ["$.properties.entities[*].properties.address",',
        '                       "$.properties.entities[*].Address"]},',
        '            {"type": "sha256",',
        '             "value": ["$.properties.entities[*].properties.fileHashValue",',
        '                       "$.properties.entities[*].FileHashValue"]},',
        '            {"type": "url",',
        '             "value": ["$.properties.entities[*].properties.url"]},',
        '        ],',
        '        "incident_number": ["$.properties.incidentNumber"],',
        '        "sentinel_link": ["$.properties.incidentUrl"],',
        '        "provider": ["$.properties.providerName"],',
        '        "alerts_in_incident": ["$.properties.additionalData.alertsCount"],',
        '        "first_activity": ["$.properties.firstActivityTimeUtc"],',
        '        "last_activity": ["$.properties.lastActivityTimeUtc"],',
        '        "assigned_to": ["$.properties.owner.assignedTo"],',
        '    },',
        '',
        '    # SentinelOne nests almost everything under threatInfo and the two',
        '    # agent blocks. Without this its alerts fell through to the generic',
        '    # webhook shape and arrived with no title and no timestamp.',
        '    "sentinelone.v2": {',
        '        "vendor_alert_id": ["$.threatInfo.threatId", "$.id"],',
        '        "title": ["$.threatInfo.threatName"],',
        '        "description": ["$.indicators[*].description",',
        '                        "$.threatInfo.classification"],',
        '        "raw_severity": ["$.threatInfo.confidenceLevel"],',
        '        "observed_at": ["$.threatInfo.identifiedAt",',
        '                        "$.threatInfo.createdAt"],',
        '        "category": ["$.threatInfo.classification"],',
        '        "technique_ids": ["$.indicators[*].tactics[*].techniques[*].link"],',
        '        "entities": [',
        '            {"kind": "host",',
        '             "hostname": ["$.agentRealtimeInfo.agentComputerName"],',
        '             "agent_id": ["$.agentRealtimeInfo.agentId"],',
        '             "os": ["$.agentRealtimeInfo.agentOsName"],',
        '             "domain": ["$.agentRealtimeInfo.agentDomain"],',
        '             "site": ["$.agentRealtimeInfo.siteName"],',
        '             "internal_ip": ["$.agentDetectionInfo.agentIpV4"],',
        '             "external_ip": ["$.agentDetectionInfo.externalIp"],',
        '             "agent_version": ["$.agentRealtimeInfo.agentVersion"]},',
        '            {"kind": "identity",',
        '             "account": ["$.agentDetectionInfo.agentLastLoggedInUserName"],',
        '             "process_user": ["$.threatInfo.processUser"]},',
        '            {"kind": "process",',
        '             "name": ["$.threatInfo.threatName"],',
        '             "path": ["$.threatInfo.filePath"],',
        '             "parent": ["$.threatInfo.originatorProcess"]},',
        '        ],',
        '        "indicators": [',
        '            {"type": "sha256", "value": ["$.threatInfo.sha256"]},',
        '            {"type": "sha1", "value": ["$.threatInfo.sha1"]},',
        '            {"type": "md5", "value": ["$.threatInfo.md5"]},',
        '            {"type": "file_path", "value": ["$.threatInfo.filePath"]},',
        '            {"type": "ipv4",',
        '             "value": ["$.agentDetectionInfo.externalIp"]},',
        '        ],',
        '        "mitigation_status": ["$.threatInfo.mitigationStatus"],',
        '        "analyst_verdict": ["$.threatInfo.analystVerdict"],',
        '        "incident_status": ["$.threatInfo.incidentStatus"],',
        '        "signed": ["$.threatInfo.fileVerificationType"],',
        '        "storyline": ["$.threatInfo.storyline"],',
        '        "detection_source": ["$.threatInfo.threatDetectionSource"],',
        '    },',
        '',
        '    # ServiceNow is a place tickets go, not a place alerts come from -',
        '    # except when a client runs Security Incident Response and wants its',
        '    # records worked here.',
        '    "servicenow.itsm": {',
        '        "vendor_alert_id": ["$.number", "$.result.number", "$.sys_id"],',
        '        "title": ["$.short_description",',
        '                  "$.result.short_description"],',
        '        "description": ["$.description", "$.result.description"],',
        '        "raw_severity": ["$.severity", "$.urgency", "$.priority"],',
        '        "observed_at": ["$.opened_at", "$.sys_created_on"],',
        '        "category": ["$.category", "$.subcategory"],',
        '        "technique_ids": [],',
        '        "entities": [',
        '            {"kind": "host", "hostname": ["$.cmdb_ci.name",',
        '                                            "$.cmdb_ci"]},',
        '            {"kind": "identity", "upn": ["$.caller_id.email",',
        '                                          "$.opened_by.email"]},',
        '        ],',
        '        "indicators": [],',
        '    },',
        '',
        '    "generic.webhook": {',
        '        "vendor_alert_id": ["$.id", "$.alert_id", "$.uuid"],',
        '        "title": ["$.title", "$.name", "$.summary"],',
        '        "description": ["$.description", "$.message", "$.detail"],',
        '        "raw_severity": ["$.severity", "$.priority", "$.level"],',
        '        "observed_at": ["$.timestamp", "$.time", "$.created_at"],',
        '        "category": ["$.category", "$.type"],',
        '        "technique_ids": ["$.techniques", "$.mitre"],',
        '        "entities": [',
        '            {"kind": "host", "hostname": ["$.host", "$.hostname",',
        '                                            "$.device.hostname"]},',
        '        ],',
        '        "indicators": [{"type": "auto", "value": "$.indicators[*]"}],',
        '    },',
        '}',
      ].join('\n'),
    });
    fnWithBody(g, {
      name: 'vendor_samples',
      returns: 'Map<string, Any>',
      doc: [
        'One representative alert per tool that sends us alerts.',
        '',
        'Shown in the intake form so the mapping can be written and tried before a',
        'real alert exists. Field names and structure follow each vendor\'s',
        'documented response; the values are invented. A stub with eight fields',
        'taught an engineer that eight fields was all there was, which is how a',
        'mapping ends up ignoring the username and the addresses.',
      ].join('\n'),
      implName: 'representative_vendor_payloads',
      code: [
        'return {',
        '    # --- CrowdStrike Falcon, Alerts API v2 ---------------------------',
        '    "crowdstrike.falcon": {',
        '        "composite_id": "ldt:9f1c2e4a5b6d:1847392019",',
        '        "id": "ldt:9f1c2e4a5b6d:1847392019",',
        '        "aggregate_id": "aggind:9f1c2e4a5b6d:1847392019",',
        '        "cid": "9f1c2e4a5b6d4e8fa1b2c3d4e5f60718",',
        '        "agent_id": "9f1c2e4a5b6d4e8fa1b2c3d4e5f60718",',
        '        "type": "ldt",',
        '        "product": "epp",',
        '        "platform": "Windows",',
        '        "name": "CredentialTheftViaLSASS",',
        '        "display_name": "Credential Theft",',
        '        "description": ("A process opened a handle to lsass.exe with "',
        '                        "read-memory access and wrote a dump file."),',
        '        "severity": 70,',
        '        "severity_name": "High",',
        '        "max_severity": 70,',
        '        "max_severity_displayname": "High",',
        '        "confidence": 80,',
        '        "objective": "Gain Access",',
        '        "tactic": "Credential Access",',
        '        "tactic_id": "TA0006",',
        '        "technique": "OS Credential Dumping",',
        '        "technique_id": "T1003.001",',
        '        "scenario": "credential_theft",',
        '        "pattern_id": 12094,',
        '        "pattern_disposition": 2048,',
        '        "pattern_disposition_details": {',
        '            "detect": True, "blocking_unsupported": False,',
        '            "kill_process": False, "quarantine_file": False,',
        '            "policy_disabled": False, "inddet_mask": False,',
        '        },',
        '        "timestamp": "2026-09-15T22:00:04Z",',
        '        "created_timestamp": "2026-09-15T22:00:11Z",',
        '        "updated_timestamp": "2026-09-15T22:03:48Z",',
        '        "first_behavior": "2026-09-15T21:59:58Z",',
        '        "last_behavior": "2026-09-15T22:00:02Z",',
        '        "status": "new",',
        '        "assigned_to_name": None,',
        '        "show_in_ui": True,',
        '        "seconds_to_triaged": 0,',
        '        "seconds_to_resolved": 0,',
        '        "falcon_host_link": ("https://falcon.crowdstrike.com/activity/'
        + 'detections/detail/9f1c2e4a5b6d/1847392019"),',
        '',
        '        "user_name": "m.torres",',
        '        "user_id": "S-1-5-21-1004336348-1177238915-682003330-1213",',
        '        "logon_domain": "CORP",',
        '',
        '        "filename": "procdump64.exe",',
        '        "filepath": "\\\\Device\\\\HarddiskVolume3\\\\Windows\\\\Temp'
        + '\\\\procdump64.exe",',
        '        "alleged_filetype": "exe",',
        '        "cmdline": ("procdump64.exe -accepteula -ma lsass.exe "',
        '                    "C:\\\\Windows\\\\Temp\\\\lsass.dmp"),',
        '        "sha256": ("9f2b8c1d4e6a03f75b8e2c9d1a4f6b3e"',
        '                   "8c7d5a2f9b1e4c6a8d3f5b7e9c1a2d4f"),',
        '        "md5": "5d41402abc4b2a76b9719d911017c592",',
        '        "process_id": 8812,',
        '        "local_process_id": 8812,',
        '        "process_start_time": "2026-09-15T21:59:57Z",',
        '        "global_prevalence": "low",',
        '        "local_prevalence": "low",',
        '',
        '        "parent_details": {',
        '            "filename": "powershell.exe",',
        '            "filepath": ("\\\\Device\\\\HarddiskVolume3\\\\Windows'
        + '\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe"),',
        '            "cmdline": "powershell.exe -nop -w hidden -enc SQBFAFgA",',
        '            "sha256": ("908b64b1971a979c7e3e8ce4621945cb"',
        '                       "a84854cb98d76367b791a6e22b5f6d53"),',
        '            "md5": "7353f60b1739074eb17c5f4dddefe239",',
        '            "process_id": 6620,',
        '            "local_process_id": 6620,',
        '            "timestamp": "2026-09-15T21:59:41Z",',
        '        },',
        '',
        '        "device": {',
        '            "device_id": "9f1c2e4a5b6d4e8fa1b2c3d4e5f60718",',
        '            "cid": "9f1c2e4a5b6d4e8fa1b2c3d4e5f60718",',
        '            "hostname": "WS-FIN-0417",',
        '            "machine_domain": "corp.example",',
        '            "site_name": "London HQ",',
        '            "ou": ["Workstations", "Finance"],',
        '            "platform_name": "Windows",',
        '            "os_version": "Windows 11",',
        '            "os_build": "22631",',
        '            "product_type_desc": "Workstation",',
        '            "agent_version": "7.16.18604.0",',
        '            "agent_load_flags": "0",',
        '            "external_ip": "203.0.113.41",',
        '            "local_ip": "10.24.6.117",',
        '            "mac_address": "00-1b-44-11-3a-b7",',
        '            "status": "normal",',
        '            "first_seen": "2025-02-11T08:14:22Z",',
        '            "last_seen": "2026-09-15T22:01:02Z",',
        '            "groups": ["finance-workstations"],',
        '            "tags": ["FalconGroupingTags/finance"],',
        '            "reduced_functionality_mode": "no",',
        '        },',
        '',
        '        "ioc_type": "sha256",',
        '        "ioc_value": ("9f2b8c1d4e6a03f75b8e2c9d1a4f6b3e"',
        '                      "8c7d5a2f9b1e4c6a8d3f5b7e9c1a2d4f"),',
        '        "ioc_source": "library_load",',
        '        "ioc_description": "Known credential dumping utility",',
        '        "quarantined_files": [],',
        '        "tags": [],',
        '',
        '        # The Detections API this replaced nested the same facts under',
        '        # behaviors[]. Tenants still send it, and the shipped mapping',
        '        # reads both.',
        '        "detection_id": "ldt:9f1c2e4a5b6d:1847392019",',
        '        "behaviors": [{',
        '            "behavior_id": "1847392019",',
        '            "display_name": "Credential Theft",',
        '            "description": "A process opened a handle to lsass.exe.",',
        '            "tactic": "Credential Access",',
        '            "technique": "OS Credential Dumping",',
        '            "technique_id": "T1003.001",',
        '            "severity": 70,',
        '            "confidence": 80,',
        '            "user_name": "m.torres",',
        '            "filename": "procdump64.exe",',
        '            "filepath": "C:\\\\Windows\\\\Temp\\\\procdump64.exe",',
        '            "cmdline": "procdump64.exe -accepteula -ma lsass.exe",',
        '            "sha256": ("9f2b8c1d4e6a03f75b8e2c9d1a4f6b3e"',
        '                       "8c7d5a2f9b1e4c6a8d3f5b7e9c1a2d4f"),',
        '            "md5": "5d41402abc4b2a76b9719d911017c592",',
        '            "pattern_disposition": 2048,',
        '            "ioc_type": "sha256",',
        '            "ioc_value": "9f2b8c1d4e6a03f75b8e2c9d1a4f6b3e",',
        '        }],',
        '    },',
        '',
        '    # --- Microsoft Sentinel, an incident as ARM returns it -----------',
        '    "microsoft.sentinel": {',
        '        "id": ("/subscriptions/3c9e1f70-42ab-4d18-9a55-6e0b7d3c81f2"',
        '               "/resourceGroups/rg-security/providers"',
        '               "/Microsoft.OperationalInsights/workspaces/law-soc"',
        '               "/providers/Microsoft.SecurityInsights/incidents"',
        '               "/2f8a4c11-7d63-4b90-a5e1-9c8f2d4b6a30"),',
        '        "name": "2f8a4c11-7d63-4b90-a5e1-9c8f2d4b6a30",',
        '        "type": "Microsoft.SecurityInsights/incidents",',
        '        "etag": "\\"0a00d1f2-0000-0100-0000-66e7c4a10000\\"",',
        '        "properties": {',
        '            "title": "Multiple failed sign-ins followed by a success",',
        '            "description": ("41 failed sign-ins across 19 accounts from "',
        '                            "one address, then one success."),',
        '            "severity": "High",',
        '            "status": "New",',
        '            "classification": "",',
        '            "classificationReason": "",',
        '            "classificationComment": "",',
        '            "incidentNumber": 4471,',
        '            "incidentUrl": ("https://portal.azure.com/#asset"',
        '                            "/Microsoft_Azure_Security_Insights/Incident"',
        '                            "/subscriptions/3c9e1f70/resourceGroups"',
        '                            "/rg-security/providers"',
        '                            "/Microsoft.OperationalInsights/workspaces"',
        '                            "/law-soc/providers"',
        '                            "/Microsoft.SecurityInsights/Incidents"',
        '                            "/2f8a4c11"),',
        '            "providerName": "Azure Sentinel",',
        '            "providerIncidentId": "4471",',
        '            "firstActivityTimeUtc": "2026-09-15T21:38:00Z",',
        '            "lastActivityTimeUtc": "2026-09-15T21:47:00Z",',
        '            "createdTimeUtc": "2026-09-15T21:50:12Z",',
        '            "lastModifiedTimeUtc": "2026-09-15T21:50:12Z",',
        '            "owner": {',
        '                "objectId": "7d1a9b4c-2e35-4f60-8a71-b3c5d9e0f142",',
        '                "email": "soc@provider.example",',
        '                "assignedTo": "SOC Duty",',
        '                "userPrincipalName": "soc@provider.example",',
        '            },',
        '            "labels": [{"labelName": "identity",',
        '                        "labelType": "User"}],',
        '            "relatedAnalyticRuleIds": [',
        '                ("/subscriptions/3c9e1f70/resourceGroups/rg-security"',
        '                 "/providers/Microsoft.OperationalInsights/workspaces"',
        '                 "/law-soc/providers/Microsoft.SecurityInsights"',
        '                 "/alertRules/8b21d4e6")],',
        '            "additionalData": {',
        '                "alertsCount": 3,',
        '                "bookmarksCount": 0,',
        '                "commentsCount": 1,',
        '                "alertProductNames": ["Azure Active Directory Identity "',
        '                                      "Protection"],',
        '                "tactics": ["CredentialAccess"],',
        '                "techniques": ["T1110.003"],',
        '            },',
        '            "entities": [',
        '                {"kind": "Account", "properties": {',
        '                    "accountName": "s.oyelaran",',
        '                    "upnSuffix": "corp.example",',
        '                    "friendlyName": "s.oyelaran@corp.example",',
        '                    "aadUserId": "c41b0e93-8d27-4a16-9f30-2b7e5c1d8a44",',
        '                    "isDomainJoined": True}},',
        '                {"kind": "Ip", "properties": {',
        '                    "address": "185.220.101.43",',
        '                    "friendlyName": "185.220.101.43",',
        '                    "location": {"countryName": "Netherlands",',
        '                                 "city": "Amsterdam",',
        '                                 "asn": 60729}}},',
        '                {"kind": "Host", "properties": {',
        '                    "hostName": "DC-01",',
        '                    "dnsDomain": "corp.example",',
        '                    "osFamily": "Windows",',
        '                    "friendlyName": "DC-01"}},',
        '            ],',
        '        },',
        '    },',
        '',
        '    # --- Microsoft Defender for Endpoint, an alert with its evidence --',
        '    "microsoft.defender_endpoint": {',
        '        "id": "da637874186334089969_-1150204175",',
        '        "incidentId": 92417,',
        '        "investigationId": 41022,',
        '        "investigationState": "Queued",',
        '        "assignedTo": None,',
        '        "severity": "High",',
        '        "status": "New",',
        '        "classification": None,',
        '        "determination": None,',
        '        "detectionSource": "WindowsDefenderAtp",',
        '        "detectorId": "6d5d2f1a-3b47-4c8e-9a06-1f2e3d4c5b6a",',
        '        "category": "CredentialAccess",',
        '        "threatFamilyName": None,',
        '        "threatName": None,',
        '        "title": "Suspicious access to LSASS service",',
        '        "description": ("A process accessed the memory of the Local "',
        '                        "Security Authority Subsystem Service."),',
        '        "alertCreationTime": "2026-09-15T20:02:14Z",',
        '        "firstEventTime": "2026-09-15T20:01:47Z",',
        '        "lastEventTime": "2026-09-15T20:01:52Z",',
        '        "lastUpdateTime": "2026-09-15T20:05:03Z",',
        '        "resolvedTime": None,',
        '        "machineId": "m99a1b2c3d4e5f60718293a4b5c6d7e8f90",',
        '        "computerDnsName": "ws-hr-11.corp.example",',
        '        "rbacGroupName": "UK Workstations",',
        '        "aadTenantId": "8f21a3c4-7b19-4d52-9e03-1a7c5b2e9d44",',
        '        "mitreTechniques": ["T1003.001"],',
        '        "relatedUser": {"userName": "k.lee",',
        '                        "domainName": "CORP"},',
        '        "comments": [],',
        '        "evidence": [',
        '            {"entityType": "Process",',
        '             "evidenceCreationTime": "2026-09-15T20:02:15Z",',
        '             "sha1": "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",',
        '             "sha256": ("a3f1b9e2c8d40567f1a3b5c7d9e2f4a6"',
        '                        "b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8"),',
        '             "fileName": "rundll32.exe",',
        '             "filePath": "C:\\\\Windows\\\\System32",',
        '             "processId": 4412,',
        '             "processCommandLine": ("rundll32.exe C:\\\\Windows\\\\"',
        '                                   "System32\\\\comsvcs.dll, MiniDump"),',
        '             "processCreationTime": "2026-09-15T20:01:45Z",',
        '             "parentProcessId": 2288,',
        '             "parentProcessFileName": "cmd.exe",',
        '             "parentProcessFilePath": "C:\\\\Windows\\\\System32",',
        '             "accountName": "k.lee",',
        '             "domainName": "CORP",',
        '             "userSid": "S-1-5-21-1004336348-1177238915-682003330-1417",',
        '             "userPrincipalName": "k.lee@corp.example",',
        '             "detectionStatus": "Detected",',
        '             "deviceId": "m99a1b2c3d4e5f60718293a4b5c6d7e8f90"},',
        '            {"entityType": "Ip",',
        '             "ipAddress": "192.0.2.77",',
        '             "detectionStatus": None},',
        '            {"entityType": "User",',
        '             "accountName": "k.lee",',
        '             "domainName": "CORP",',
        '             "userPrincipalName": "k.lee@corp.example"},',
        '        ],',
        '    },',
        '',
        '    # --- SentinelOne, a threat as the v2.1 API returns it -------------',
        '    "sentinelone.v2": {',
        '        "id": "1847392019284756301",',
        '        "threatInfo": {',
        '            "threatId": "1847392019284756301",',
        '            "threatName": "procdump64.exe",',
        '            "classification": "Malware",',
        '            "classificationSource": "Static",',
        '            "confidenceLevel": "malicious",',
        '            "analystVerdict": "undefined",',
        '            "incidentStatus": "unresolved",',
        '            "mitigationStatus": "not_mitigated",',
        '            "createdAt": "2026-09-15T19:41:08.114Z",',
        '            "identifiedAt": "2026-09-15T19:41:02.000Z",',
        '            "filePath": "\\\\Device\\\\HarddiskVolume2\\\\Temp\\\\pd.exe",',
        '            "fileVerificationType": "NotSigned",',
        '            "sha1": "da39a3ee5e6b4b0d3255bfef95601890afd80709",',
        '            "sha256": ("3a7f1b9e2c8d4056f1a3b5c7d9e2f4a6"',
        '                       "b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8"),',
        '            "md5": "098f6bcd4621d373cade4e832627b4f6",',
        '            "initiatedBy": "agent_policy",',
        '            "originatorProcess": "powershell.exe",',
        '            "processUser": "CORP\\\\r.nakamura",',
        '            "storyline": "B1A2C3D4E5F60718",',
        '            "threatDetectionSource": "Agent Policy",',
        '        },',
        '        "agentRealtimeInfo": {',
        '            "agentId": "1847392019284756300",',
        '            "agentComputerName": "WS-SALES-207",',
        '            "agentDomain": "corp.example",',
        '            "agentOsName": "Windows 11 Pro",',
        '            "agentOsType": "windows",',
        '            "agentVersion": "23.4.2.350",',
        '            "agentMachineType": "laptop",',
        '            "agentInfected": True,',
        '            "agentIsActive": True,',
        '            "agentNetworkStatus": "connected",',
        '            "siteName": "UK",',
        '            "groupName": "Sales",',
        '        },',
        '        "agentDetectionInfo": {',
        '            "agentIpV4": "10.24.9.88",',
        '            "externalIp": "203.0.113.77",',
        '            "agentLastLoggedInUserName": "r.nakamura",',
        '            "agentDomain": "corp.example",',
        '            "accountName": "Provider SOC",',
        '        },',
        '        "indicators": [',
        '            {"category": "Credential Access",',
        '             "description": "Accessed protected process memory",',
        '             "tactics": [{"name": "Credential Access",',
        '                         "techniques": [{"name": "OS Credential Dumping",',
        '                                         "link": "T1003"}]}]},',
        '        ],',
        '    },',
        '}',
      ].join('\n'),
    });

    exports_(mappings.file, [{ name: 'builtin_mappings', sort: 'function' },
                             { name: 'vendor_samples', sort: 'function' }]);
  }

  // -------------------------------------------------------------------------
  // normalize/engine.py
  // -------------------------------------------------------------------------
  const normEngine = py(ctx, { path: 'src/normalize/engine.py', module: normalize, doc: 'normalisation engine', style: 'data-flow' });
  {
    const g = normEngine.g;

    fnWithBody(g, {
      name: 'read_path',
      params: [
        { name: 'payload', type: 'Any' },
        { name: 'path', type: 'string' },
      ],
      returns: 'Any',
      doc: [
        'A deliberately small subset of JSONPath: $.a.b, $.a[0].b, $.a[*].b.',
        '',
        'Small on purpose. A full expression language here would be a second',
        'template-injection surface, and no vendor mapping has ever needed one.',
      ].join('\n'),
      implName: 'resolve_json_path',
      code: [
        'if not path or not path.startswith("$"):',
        '    return path',
        '',
        'parts = [p for p in path[1:].split(".") if p]',
        'current = payload',
        '',
        'for position, part in enumerate(parts):',
        '    name, _, index = part.partition("[")',
        '    if name:',
        '        if not isinstance(current, dict):',
        '            return None',
        '        current = current.get(name)',
        '    if not index:',
        '        continue',
        '',
        '    selector = index.rstrip("]")',
        '    if not isinstance(current, list):',
        '        return None',
        '',
        '    if selector != "*":',
        '        try:',
        '            current = current[int(selector)]',
        '        except (ValueError, IndexError):',
        '            return None',
        '        continue',
        '',
        '    # The rest of the path applies to each element, not to the list.',
        '    # Returning the list here instead - which is what this did - meant',
        '    # $.evidence[*].sha256 resolved to the evidence objects, and a',
        '    # mapping that looked right produced a stringified dict as an',
        '    # indicator value.',
        '    remainder = ".".join(parts[position + 1:])',
        '    if not remainder:',
        '        return current',
        '    collected = []',
        '    for element in current:',
        '        found = resolve_json_path(element, "$." + remainder)',
        '        if isinstance(found, list):',
        '            collected.extend(f for f in found if f not in (None, ""))',
        '        elif found not in (None, ""):',
        '            collected.append(found)',
        '    return collected',
        '',
        'return current',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'normalise_event',
      params: [
        { name: 'source', type: 'string' },
        { name: 'payload', type: 'Map<string, Any>' },
        { name: 'mapping', type: 'Map<string, Any>' },
      ],
      returns: 'Map<string, Any>',
      doc: [
        'Raw vendor payload plus a mapping, producing one Common Security Event',
        'Model alert. The raw payload is kept on the event row, not discarded, so a',
        'mapping bug is recoverable by re-normalising rather than by asking the',
        'vendor to resend.',
      ].join('\n'),
      implName: 'apply_mapping',
      code: [
        'import json',
        '',
        'alert = empty_alert()',
        'alert["source"] = source',
        '',
        'def first_of(spec):',
        '    # A path, or several. CrowdStrike calls an alert id "composite_id" on',
        '    # the Alerts API and "detection_id" on the Detections API it replaced,',
        '    # and a tenant can be sending either. Listing both beats making the',
        '    # operator pick, and beats a second mapping that drifts from this one.',
        '    for path in (spec if isinstance(spec, list) else [spec]):',
        '        found = read_path(payload, path or "")',
        '        if found not in (None, "", [], {}):',
        '            return found',
        '    return None',
        '',
        'for field in ("vendor_alert_id", "title", "description", "raw_severity",',
        '              "observed_at", "category"):',
        '    value = first_of(mapping.get(field, ""))',
        '    if value is not None:',
        '        alert[field] = value if isinstance(value, str) else str(value)',
        '',
        'alert["severity"] = normalise_severity(alert["raw_severity"])',
        '',
        'techniques = first_of(mapping.get("technique_ids", ""))',
        'if isinstance(techniques, str):',
        '    techniques = [techniques]',
        'alert["technique_ids"] = [t for t in (techniques or []) if t]',
        '',
        'for spec in mapping.get("entities", []):',
        '    entity = {"kind": spec.get("kind", "unknown")}',
        '    for key, source_path in spec.items():',
        '        if key == "kind":',
        '            continue',
        '        resolved = first_of(source_path)',
        '        if isinstance(resolved, list):',
        '            resolved = resolved[0] if resolved else None',
        '        if resolved:',
        '            entity[key] = resolved',
        '    if len(entity) > 1:',
        '        alert["entities"].append(entity)',
        '',
        'for spec in mapping.get("indicators", []):',
        '    resolved = first_of(spec.get("value", ""))',
        '    values = resolved if isinstance(resolved, list) else [resolved]',
        '    for value in values:',
        '        if not value:',
        '            continue',
        '        kind = spec.get("type", "auto")',
        '        alert["indicators"].append({"type": kind, "value": str(value)})',
        '',
        '# Anything mapped under a name that is not part of the model. The seven',
        '# above are the shape everything reads; these are what this vendor also',
        '# sends and this SOC decided was worth keeping.',
        'known = {"vendor_alert_id", "title", "description", "raw_severity",',
        '         "observed_at", "category", "technique_ids", "entities",',
        '         "indicators"}',
        'custom = {}',
        'for name, spec in (mapping or {}).items():',
        '    if name in known:',
        '        continue',
        '    found = first_of(spec)',
        '    if found in (None, "", [], {}):',
        '        continue',
        '    # Flattened to something a table cell can show. A mapping that lands',
        '    # on an object is pointing one level too high, and rendering its repr',
        '    # would hide that rather than surface it.',
        '    if isinstance(found, (dict, list)):',
        '        found = json.dumps(found, default=str)[:2000]',
        '    custom[name] = found if isinstance(found, str) else str(found)',
        'alert["custom"] = custom',
        '',
        '# The vendor payload travels alongside, clearly separated, for the rare',
        '# playbook that genuinely needs a field nobody has mapped yet.',
        'alert["vendor"] = payload',
        'return alert',
      ].join('\n'),
    });
    exports_(normEngine.file, [
      { name: 'read_path', sort: 'function' },
      { name: 'normalise_event', sort: 'function' },
    ]);
    imports_(normEngine.file, model.file, ['empty_alert', 'normalise_severity']);
  }

  iface(normalize, [
    { name: 'normalise_event', kind: 'function', doc: 'Vendor payload plus mapping to one CSEM alert.' },
    { name: 'validate_alert', kind: 'function', doc: 'Structural check on a normalised alert.' },
    { name: 'builtin_mappings', kind: 'function', doc: 'Vendor mappings as editable data.' },
  ]);

  // -------------------------------------------------------------------------
  // intel/indicators.py
  // -------------------------------------------------------------------------
  const indicators = py(ctx, { path: 'src/intel/indicators.py', module: intel, doc: 'indicators', style: 'procedural' });
  {
    const g = indicators.g;

    fnWithBody(g, {
      name: 'detect_type',
      params: [{ name: 'value', type: 'string' }],
      returns: 'string',
      doc: 'What kind of observable this is. Ordered most-specific first, because an IPv4 also matches a loose domain pattern.',
      implName: 'classify_observable',
      code: [
        'import re',
        '',
        'text = (value or "").strip()',
        'if not text:',
        '    return "unknown"',
        'if re.fullmatch(r"[0-9a-fA-F]{64}", text):',
        '    return "sha256"',
        'if re.fullmatch(r"[0-9a-fA-F]{40}", text):',
        '    return "sha1"',
        'if re.fullmatch(r"[0-9a-fA-F]{32}", text):',
        '    return "md5"',
        'if re.fullmatch(r"CVE-\\d{4}-\\d{4,7}", text, re.IGNORECASE):',
        '    return "cve"',
        'if re.fullmatch(r"(\\d{1,3}\\.){3}\\d{1,3}", text):',
        '    parts = [int(p) for p in text.split(".")]',
        '    return "ipv4" if all(p <= 255 for p in parts) else "unknown"',
        'if ":" in text and re.fullmatch(r"[0-9a-fA-F:]{2,39}", text):',
        '    return "ipv6"',
        'if text.lower().startswith(("http://", "https://")):',
        '    return "url"',
        'if "@" in text and re.fullmatch(r"[^@\\s]+@[^@\\s]+\\.[a-zA-Z]{2,}", text):',
        '    return "email"',
        'if re.fullmatch(r"(?=.{1,253}$)([a-zA-Z0-9_-]{1,63}\\.)+[a-zA-Z]{2,}", text):',
        '    return "domain"',
        'return "unknown"',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'normalise_value',
      params: [
        { name: 'indicator_type', type: 'string' },
        { name: 'value', type: 'string' },
      ],
      returns: 'string',
      doc: [
        'The deduplication key.',
        '',
        'Without this the same IOC arrives four ways - defanged, uppercased, with a',
        'trailing dot, with a default port - and scores four times. Getting this',
        'right is the difference between a usable intel table and a pile of',
        'near-duplicates.',
      ].join('\n'),
      implName: 'canonicalise_indicator',
      code: [
        'import ipaddress',
        'import urllib.parse',
        '',
        'text = refang(value or "").strip()',
        'if indicator_type in ("sha256", "sha1", "md5"):',
        '    return text.lower()',
        'if indicator_type == "domain":',
        '    host = text.rstrip(".").lower()',
        '    try:',
        '        return host.encode("idna").decode("ascii")',
        '    except UnicodeError:',
        '        return host',
        'if indicator_type in ("ipv4", "ipv6"):',
        '    try:',
        '        return str(ipaddress.ip_address(text))',
        '    except ValueError:',
        '        return text',
        'if indicator_type == "url":',
        '    parsed = urllib.parse.urlsplit(text)',
        '    host = (parsed.hostname or "").lower()',
        '    port = parsed.port',
        '    if port and ((parsed.scheme == "http" and port == 80) or',
        '                 (parsed.scheme == "https" and port == 443)):',
        '        port = None',
        '    netloc = host + (":%d" % port if port else "")',
        '    path = parsed.path or "/"',
        '    return urllib.parse.urlunsplit((parsed.scheme.lower(), netloc, path, parsed.query, ""))',
        'if indicator_type == "email":',
        '    local, _, domain = text.partition("@")',
        '    return local + "@" + domain.lower()',
        'if indicator_type == "cve":',
        '    return text.upper()',
        'return text',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'defang',
      params: [{ name: 'value', type: 'string' }],
      returns: 'string',
      doc: 'Make an indicator safe to paste into a ticket or a chat message.',
      implName: 'defang_text',
      code: [
        'return (value or "")\\',
        '    .replace("http://", "hxxp://")\\',
        '    .replace("https://", "hxxps://")\\',
        '    .replace(".", "[.]")\\',
        '    .replace("@", "[@]")',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'refang',
      params: [{ name: 'value', type: 'string' }],
      returns: 'string',
      doc: 'The inverse. Analysts paste defanged indicators constantly; treating them as unknown strings is a bug, not strictness.',
      implName: 'refang_text',
      code: [
        'import re',
        '',
        'text = value or ""',
        'text = re.sub(r"h[xX]{2}p(s?)://", lambda m: "http" + m.group(1) + "://", text)',
        'text = text.replace("[.]", ".").replace("(.)", ".").replace("{.}", ".")',
        'text = text.replace("[:]", ":").replace("[@]", "@").replace("(@)", "@")',
        'text = re.sub(r"\\[?\\bdot\\b\\]?", ".", text, flags=re.IGNORECASE)',
        'return text.strip()',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'extract_from_text',
      params: [{ name: 'text', type: 'string' }],
      returns: 'List<Map<string, Any>>',
      doc: 'Pull observables out of an email body, a log line or an alert description. Refangs first, deduplicates on the normalised value, and never returns a private address as an actionable indicator.',
      implName: 'scan_text_for_indicators',
      code: [
        'import ipaddress',
        'import re',
        '',
        'body = refang(text or "")',
        'patterns = {',
        '    "url": r"https?://[^\\s<>\\"\']{4,2000}",',
        '    "email": r"[A-Za-z0-9._%%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",',
        '    "ipv4": r"\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b",',
        '    "sha256": r"\\b[0-9a-fA-F]{64}\\b",',
        '    "sha1": r"\\b[0-9a-fA-F]{40}\\b",',
        '    "md5": r"\\b[0-9a-fA-F]{32}\\b",',
        '    "cve": r"\\bCVE-\\d{4}-\\d{4,7}\\b",',
        '    "domain": r"\\b(?:[a-zA-Z0-9-]{1,63}\\.)+[a-zA-Z]{2,63}\\b",',
        '}',
        '',
        'found = {}',
        'for kind, pattern in patterns.items():',
        '    for match in re.findall(pattern, body):',
        '        canonical = normalise_value(kind, match)',
        '        if kind == "ipv4":',
        '            try:',
        '                address = ipaddress.ip_address(canonical)',
        '            except ValueError:',
        '                continue',
        '            if address.is_private or address.is_loopback or address.is_link_local:',
        '                continue',
        '        key = (kind, canonical)',
        '        if key not in found:',
        '            found[key] = {"type": kind, "value": match, "normalised": canonical}',
        '',
        '# A hostname inside a URL is already represented by the URL; keeping both',
        '# doubles the enrichment cost for no extra signal.',
        'url_hosts = set()',
        'for entry in found.values():',
        '    if entry["type"] == "url":',
        '        import urllib.parse',
        '        url_hosts.add((urllib.parse.urlsplit(entry["normalised"]).hostname or "").lower())',
        '',
        'return [',
        '    entry for entry in found.values()',
        '    if not (entry["type"] == "domain" and entry["normalised"] in url_hosts)',
        ']',
      ].join('\n'),
    });

    exports_(indicators.file, [
      { name: 'detect_type', sort: 'function' },
      { name: 'normalise_value', sort: 'function' },
      { name: 'defang', sort: 'function' },
      { name: 'refang', sort: 'function' },
      { name: 'extract_from_text', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // intel/scoring.py -- drawn, because a SOC will want to change it
  // -------------------------------------------------------------------------
  const scoring = py(ctx, { path: 'src/intel/scoring.py', module: intel, doc: 'indicator scoring', style: 'data-flow' });
  {
    const g = scoring.g;

    fnWithBody(g, {
      name: 'provider_weight',
      params: [{ name: 'provider', type: 'string' }],
      returns: 'f64',
      doc: 'How much each source counts. Configuration, not doctrine - a SOC that trusts its own MISP more than a public feed edits this.',
      implName: 'weight_for_provider',
      code: [
        'return {',
        '    "misp": 1.0,',
        '    "crowdstrike": 0.95,',
        '    "microsoft_defender": 0.9,',
        '    "virustotal": 0.8,',
        '    "recorded_future": 0.85,',
        '    "abuseipdb": 0.6,',
        '    "otx": 0.5,',
        '    "greynoise": 0.7,',
        '    "urlscan": 0.6,',
        '    "shodan": 0.4,',
        '}.get(str(provider).lower(), 0.3)',
      ].join('\n'),
    });

    // The aggregation itself is a graph: an analyst can see the loop, the
    // weighting and the clamp, and rewire them without touching Python.
    const score = g.add('entry/function', {
      name: 'aggregate_score',
      params: [{ name: 'verdicts', type: 'List<Map<string, Any>>' }],
      returns: 'i64',
      doc: 'Weighted mean of provider scores, 0-100. Drawn rather than written, because the risk threshold is the number a SOC argues about most.',
    });
    g.variable('weighted_total', 'f64', 0, 'module');
    g.variable('weight_sum', 'f64', 0, 'module');

    const zeroA = g.add('data/literal', { type: 'f64', value: '0' });
    const initTotal = g.add('data/variable-set', { name: 'weighted_total' });
    g.connect(zeroA, 'value', initTotal, 'value');
    const zeroB = g.add('data/literal', { type: 'f64', value: '0' });
    const initWeight = g.add('data/variable-set', { name: 'weight_sum' });
    g.connect(zeroB, 'value', initWeight, 'value');

    const loop = g.add('control/for-each', { varName: 'verdict' });
    g.connect(score, 'p:verdicts', loop, 'items');

    const providerField = g.add('map/get-or');
    g.connect(loop, 'item', providerField, 'a0');
    g.setDefault(providerField, 'a1', 'provider');
    g.setDefault(providerField, 'a2', 'unknown');

    const scoreField = g.add('map/get-or');
    g.connect(loop, 'item', scoreField, 'a0');
    g.setDefault(scoreField, 'a1', 'score');
    g.setDefault(scoreField, 'a2', 0);

    const weight = g.add('control/call', { target: 'provider_weight', returns: 'f64' });
    g.connect(providerField, 'value', weight, 'args');

    const asFloat = g.add('convert/to-float');
    g.connect(scoreField, 'value', asFloat, 'a0');

    const contribution = g.add('op/arithmetic', { op: '*' });
    g.connect(asFloat, 'number', contribution, 'a');
    g.connect(weight, 'result', contribution, 'b');

    const readTotal = g.add('data/variable-get', { name: 'weighted_total' });
    const addTotal = g.add('op/arithmetic', { op: '+' });
    g.connect(readTotal, 'value', addTotal, 'a');
    g.connect(contribution, 'result', addTotal, 'b');
    const setTotal = g.add('data/variable-set', { name: 'weighted_total' });
    g.connect(addTotal, 'result', setTotal, 'value');

    const readWeight = g.add('data/variable-get', { name: 'weight_sum' });
    const addWeight = g.add('op/arithmetic', { op: '+' });
    g.connect(readWeight, 'value', addWeight, 'a');
    g.connect(weight, 'result', addWeight, 'b');
    const setWeight = g.add('data/variable-set', { name: 'weight_sum' });
    g.connect(addWeight, 'result', setWeight, 'value');

    // No verdicts at all is "unknown" (0), not "clean". Saying clean because
    // nobody answered is how a SOAR closes a real incident.
    const finalWeight = g.add('data/variable-get', { name: 'weight_sum' });
    const noData = g.add('data/literal', { type: 'f64', value: '0' });
    const isEmpty = g.add('op/compare', { op: '<=' });
    g.connect(finalWeight, 'value', isEmpty, 'a');
    g.connect(noData, 'value', isEmpty, 'b');
    const branch = g.add('control/if');
    g.connect(isEmpty, 'result', branch, 'cond');
    const zeroScore = g.add('data/literal', { type: 'i64', value: '0' });
    const retZero = g.add('control/return');
    g.connect(zeroScore, 'value', retZero, 'value');

    const finalTotal = g.add('data/variable-get', { name: 'weighted_total' });
    const mean = g.add('op/arithmetic', { op: '/' });
    g.connect(finalTotal, 'value', mean, 'a');
    g.connect(finalWeight, 'value', mean, 'b');
    const clamp = g.add('math/min');
    g.connect(mean, 'result', clamp, 'a0');
    g.setDefault(clamp, 'a1', 100);
    const rounded = g.add('math/round');
    g.connect(clamp, 'result', rounded, 'a0');
    const retScore = g.add('control/return');
    g.connect(rounded, 'result', retScore, 'value');

    g.chain([score, 'out'], initTotal, initWeight, loop);
    g.chain([loop, 'body'], setTotal, setWeight);
    g.chain([loop, 'out'], branch);
    g.chain([branch, 'then'], retZero);
    g.chain([branch, 'else'], retScore);

    fnWithBody(g, {
      name: 'verdict_for_score',
      params: [
        { name: 'score', type: 'i64' },
        { name: 'provider_count', type: 'i64' },
      ],
      returns: 'string',
      doc: 'Score to verdict, with a confidence floor. One provider saying "malicious" is suspicious; three saying it is a verdict.',
      implName: 'score_to_verdict',
      code: [
        'value = int(score)',
        'if int(provider_count) == 0:',
        '    return "unknown"',
        'if value >= 70 and int(provider_count) >= 2:',
        '    return "malicious"',
        'if value >= 70:',
        '    return "suspicious"',
        'if value >= 35:',
        '    return "suspicious"',
        'if value <= 5 and int(provider_count) >= 2:',
        '    return "benign"',
        'return "unknown"',
      ].join('\n'),
    });

    exports_(scoring.file, [
      { name: 'provider_weight', sort: 'function' },
      { name: 'aggregate_score', sort: 'function' },
      { name: 'verdict_for_score', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // intel/mitre.py
  // -------------------------------------------------------------------------
  const mitre = py(ctx, { path: 'src/intel/mitre.py', module: intel, doc: 'MITRE ATT&CK', style: 'procedural' });
  {
    const g = mitre.g;
    fnWithBody(g, {
      name: 'parse_technique',
      params: [{ name: 'raw', type: 'string' }],
      returns: 'Map<string, Any>',
      doc: 'Split T1566.001 into technique and sub-technique. Vendors report either form, and coverage counted twice is coverage reported wrongly.',
      implName: 'split_technique_id',
      code: [
        'import re',
        '',
        'text = (raw or "").strip().upper()',
        'match = re.fullmatch(r"(T\\d{4})(?:\\.(\\d{3}))?", text)',
        'if not match:',
        '    return {"valid": False, "technique": None, "sub_technique": None, "id": text}',
        'return {',
        '    "valid": True,',
        '    "technique": match.group(1),',
        '    "sub_technique": ("%s.%s" % (match.group(1), match.group(2))) if match.group(2) else None,',
        '    "id": text,',
        '}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'coverage',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'org_id', type: 'string' },
        { name: 'days', type: 'i64' },
      ],
      returns: 'List<Map<string, Any>>',
      doc: 'Which techniques the SOC has actually seen, and which playbooks respond to them. This is the query behind the ATT&CK view.',
      implName: 'technique_coverage',
      code: [
        'return db.query(',
        '    "SELECT t.id, t.tactic, t.name, "',
        '    "  count(DISTINCT i.id) AS incident_count, "',
        '    "  count(DISTINCT p.id) AS playbook_count "',
        '    "FROM mitre_technique t "',
        '    "LEFT JOIN incident i ON t.id = ANY(i.technique_ids) "',
        '    "  AND i.org_id = %s AND i.created_at > now() - (%s || \' days\')::interval "',
        '    "LEFT JOIN playbook p ON t.id = ANY(p.technique_ids) AND p.org_id = %s "',
        '    "WHERE NOT t.revoked "',
        '    "GROUP BY t.id, t.tactic, t.name ORDER BY t.tactic, t.id",',
        '    [org_id, str(int(days)), org_id],',
        '    org_id,',
        ')',
      ].join('\n'),
    });
    exports_(mitre.file, [
      { name: 'parse_technique', sort: 'function' },
      { name: 'coverage', sort: 'function' },
    ]);
  }

  // -------------------------------------------------------------------------
  // intel/feeds.py and intel/attack.py -- see m-feeds.ts
  // -------------------------------------------------------------------------
  buildFeeds(ctx, intel);

  iface(intel, [
    { name: 'detect_type', kind: 'function', doc: 'Classify an observable.' },
    { name: 'normalise_value', kind: 'function', doc: 'The global deduplication key.' },
    { name: 'extract_from_text', kind: 'function', doc: 'IOC extraction from free text.' },
    { name: 'aggregate_score', kind: 'function', doc: 'Weighted provider score, 0-100.' },
    { name: 'coverage', kind: 'function', doc: 'MITRE ATT&CK coverage query.' },
    { name: 'parse_feed', kind: 'function', doc: 'MISP, STIX and CSV feed documents into indicator records.' },
    { name: 'ingest_feed_batch', kind: 'function', doc: 'Write parsed feed indicators, without claiming they were sighted.' },
    { name: 'load_attack_bundle', kind: 'function', doc: 'Populate mitre_technique from an ATT&CK STIX bundle.' },
  ]);

  // -------------------------------------------------------------------------
  // incidents/timeline.py
  // -------------------------------------------------------------------------
  const timeline = py(ctx, { path: 'src/incidents/timeline.py', module: incidents, doc: 'incident timeline', style: 'procedural' });
  {
    const g = timeline.g;
    fnWithBody(g, {
      name: 'append',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'org_id', type: 'string' },
        { name: 'incident_id', type: 'string' },
        { name: 'entry', type: 'Map<string, Any>' },
      ],
      returns: 'string',
      doc: [
        'Append one timeline entry with a monotonic sequence number.',
        '',
        'The sequence is allocated inside the insert rather than read-then-written,',
        'so two concurrent writers cannot produce an ambiguous order. The unique',
        'constraint on (incident_id, seq) is what enforces it; the SELECT is only',
        'the fast path.',
      ].join('\n'),
      implName: 'append_timeline_entry',
      code: [
        'import json',
        '',
        'entry_id = new_id("tl")',
        'db.execute(',
        '    "INSERT INTO timeline_entry (id, org_id, incident_id, seq, kind, actor_kind, "',
        '    "actor_id, summary, detail, execution_id, step_id, ai_session_id) "',
        '    "SELECT %s, %s, %s, coalesce(max(seq), 0) + 1, %s, %s, %s, %s, %s, %s, %s, %s "',
        '    "FROM timeline_entry WHERE incident_id = %s",',
        '    [',
        '        entry_id, org_id, incident_id,',
        '        entry["kind"], entry["actor_kind"], entry.get("actor_id"),',
        '        entry["summary"], json.dumps(redacting_encoder(entry.get("detail", {})), default=str),',
        '        entry.get("execution_id"), entry.get("step_id"), entry.get("ai_session_id"),',
        '        incident_id,',
        '    ],',
        '    org_id,',
        ')',
        'return entry_id',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'read',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'org_id', type: 'string' },
        { name: 'incident_id', type: 'string' },
      ],
      returns: 'List<Map<string, Any>>',
      doc: 'The timeline in order. actor_kind is preserved so the UI can distinguish an analyst from the assistant without inferring it.',
      implName: 'read_timeline',
      code: [
        'return db.query(',
        '    "SELECT id, at, seq, kind, actor_kind, actor_id, summary, detail, "',
        '    "execution_id, step_id, ai_session_id "',
        '    "FROM timeline_entry WHERE incident_id = %s ORDER BY seq ASC",',
        '    [incident_id],',
        '    org_id,',
        ')',
      ].join('\n'),
    });
    exports_(timeline.file, [
      { name: 'append', sort: 'function' },
      { name: 'read', sort: 'function' },
    ]);
    imports_(timeline.file, ctx.project.files.find((f) => f.path === 'src/soar/platform/ids.py')!, ['new_id']);
    imports_(timeline.file, ctx.project.files.find((f) => f.path === 'src/soar/platform/redact.py')!, ['redacting_encoder']);
  }

  // -------------------------------------------------------------------------
  // incidents/service.py
  // -------------------------------------------------------------------------
  const service = py(ctx, { path: 'src/incidents/service.py', module: incidents, doc: 'incident service', style: 'service' });
  {
    const g = service.g;

    fnWithBody(g, {
      name: 'create_from_alert',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'principal', type: 'Map<string, Any>' },
        { name: 'alert', type: 'Map<string, Any>' },
      ],
      returns: 'string',
      doc: [
        'Create an incident from a normalised alert, or attach the alert to an open',
        'one that already covers it.',
        '',
        'Correlation is by (source, entity, technique) inside a window, which is',
        'boring on purpose: clever correlation that an analyst cannot explain is',
        'worse than none, because it hides alerts.',
      ].join('\n'),
      implName: 'open_or_attach_incident',
      code: [
        'require_permission(principal, "incidents.write")',
        'org_id = principal["org_id"]',
        '',
        'hostnames = [e.get("hostname") for e in alert.get("entities", []) if e.get("hostname")]',
        'existing = []',
        'if hostnames:',
        '    existing = db.query(',
        '        "SELECT i.id FROM incident i "',
        '        "JOIN incident_entity ie ON ie.incident_id = i.id AND ie.entity_kind = \'host\' "',
        '        "JOIN host h ON h.id = ie.entity_id "',
        '        "WHERE i.org_id = %s AND i.status NOT IN (\'closed\') "',
        '        "AND h.hostname = ANY(%s) "',
        '        "AND i.created_at > now() - interval \'4 hours\' LIMIT 1",',
        '        [org_id, hostnames],',
        '        org_id,',
        '    )',
        '',
        'if existing:',
        '    incident_id = existing[0]["id"]',
        'else:',
        '    incident_id = new_id("inc")',
        '    db.execute(',
        '        "INSERT INTO incident (id, org_id, number, title, description, severity, "',
        '        "status, technique_ids, sla_ack_due, sla_resolve_due) "',
        '        "SELECT %s, %s, coalesce(max(number), 0) + 1, %s, %s, %s, \'new\', %s, "',
        '        "now() + interval \'15 minutes\', now() + interval \'8 hours\' "',
        '        "FROM incident WHERE org_id = %s",',
        '        [',
        '            incident_id, org_id, alert["title"], alert.get("description"),',
        '            alert["severity"], alert.get("technique_ids", []), org_id,',
        '        ],',
        '        org_id,',
        '    )',
        '',
        'db.execute(',
        '    "UPDATE alert SET incident_id = %s, status = \'triaged\' "',
        '    "WHERE id = %s AND org_id = %s",',
        '    [incident_id, alert["id"], org_id],',
        '    org_id,',
        ')',
        '',
        'timeline_append(db, org_id, incident_id, {',
        '    "kind": "alert_received",',
        '    "actor_kind": "integration",',
        '    "actor_id": alert.get("source"),',
        '    "summary": "Alert received: " + alert.get("title", ""),',
        '    "detail": {"alert_id": alert.get("id"), "severity": alert.get("severity")},',
        '})',
        'audit_record(db, {',
        '    "org_id": org_id, "actor_kind": "system", "actor_id": alert.get("source"),',
        '    "action": "incident.alert.attached", "target_kind": "incident",',
        '    "target_id": incident_id, "result": "success",',
        '})',
        'return incident_id',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'change_status',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'principal', type: 'Map<string, Any>' },
        { name: 'incident_id', type: 'string' },
        { name: 'new_status', type: 'string' },
        { name: 'reason', type: 'string' },
      ],
      returns: 'Void',
      doc: [
        'One place where an incident changes state, so permission, timeline, audit',
        'and the MTTA/MTTR columns cannot drift apart. A second write path would',
        'eventually forget one of the four.',
      ].join('\n'),
      implName: 'transition_incident_status',
      code: [
        'ALLOWED = {',
        '    "new": ["triage", "closed"],',
        '    "triage": ["investigating", "closed"],',
        '    "investigating": ["containment", "closed"],',
        '    "containment": ["eradication", "investigating", "closed"],',
        '    "eradication": ["recovery", "closed"],',
        '    "recovery": ["closed"],',
        '    "closed": [],',
        '}',
        '',
        'require_permission(principal, "incidents.close" if new_status == "closed" else "incidents.write")',
        'org_id = principal["org_id"]',
        '',
        'rows = db.query(',
        '    "SELECT status FROM incident WHERE id = %s AND org_id = %s",',
        '    [incident_id, org_id], org_id,',
        ')',
        'if not rows:',
        '    raise KeyError("no such incident")',
        'current = rows[0]["status"]',
        'if new_status not in ALLOWED.get(current, []):',
        '    raise ValueError("cannot move an incident from %s to %s" % (current, new_status))',
        '',
        '# The acknowledged/contained/closed columns exist so MTTA and MTTR are a',
        '# column read rather than a timeline scan at dashboard query time.',
        'stamp = {',
        '    "triage": "acknowledged_at",',
        '    "containment": "contained_at",',
        '    "closed": "closed_at",',
        '}.get(new_status)',
        'sql = "UPDATE incident SET status = %s"',
        'if stamp:',
        '    sql += ", " + stamp + " = coalesce(" + stamp + ", now())"',
        'sql += " WHERE id = %s AND org_id = %s AND status = %s"',
        '',
        'affected = db.execute(sql, [new_status, incident_id, org_id, current], org_id)',
        'if affected != 1:',
        '    raise RuntimeError("incident changed underneath this update; retry")',
        '',
        'timeline_append(db, org_id, incident_id, {',
        '    "kind": "status_change", "actor_kind": "analyst",',
        '    "actor_id": principal.get("id"),',
        '    "summary": "Status %s -> %s" % (current, new_status),',
        '    "detail": {"reason": reason},',
        '})',
        'audit_record(db, {',
        '    "org_id": org_id, "actor_kind": principal.get("kind", "user"),',
        '    "actor_id": principal.get("id"), "action": "incident.status.change",',
        '    "target_kind": "incident", "target_id": incident_id,',
        '    "before": {"status": current}, "after": {"status": new_status},',
        '    "reason": reason, "result": "success",',
        '})',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'attach_indicator',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'principal', type: 'Map<string, Any>' },
        { name: 'incident_id', type: 'string' },
        { name: 'indicator_type', type: 'string' },
        { name: 'value', type: 'string' },
      ],
      returns: 'string',
      doc: 'Upsert the observable globally, record a sighting, and link it to this incident. Three writes, because the indicator is shared and the sighting is not.',
      implName: 'link_indicator_to_incident',
      code: [
        'require_permission(principal, "incidents.write")',
        'org_id = principal["org_id"]',
        '',
        'kind = indicator_type if indicator_type != "auto" else detect_type(value)',
        'canonical = normalise_value(kind, value)',
        '',
        'rows = db.query(',
        '    "INSERT INTO indicator (id, org_id, type, value, value_normalised) "',
        '    "VALUES (%s, %s, %s, %s, %s) "',
        '    "ON CONFLICT (org_id, type, value_normalised) DO UPDATE "',
        '    "SET last_seen = now(), sighting_count = indicator.sighting_count + 1 "',
        '    "RETURNING id",',
        '    [new_id("ind"), org_id, kind, value, canonical],',
        '    org_id,',
        ')',
        'indicator_id = rows[0]["id"]',
        '',
        'db.execute(',
        '    "INSERT INTO sighting (id, org_id, indicator_id, context_kind, context_id) "',
        '    "VALUES (%s, %s, %s, \'incident\', %s)",',
        '    [new_id("sgt"), org_id, indicator_id, incident_id],',
        '    org_id,',
        ')',
        'db.execute(',
        '    "INSERT INTO incident_indicator (incident_id, indicator_id, added_by) "',
        '    "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",',
        '    [incident_id, indicator_id, principal.get("id")],',
        '    org_id,',
        ')',
        'return indicator_id',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'dashboard_metrics',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'principal', type: 'Map<string, Any>' },
      ],
      returns: 'Map<string, Any>',
      doc: 'The numbers behind the dashboard. One query per tile, all filtered by org, all reading committed state - no cached aggregates that can disagree with the incident list.',
      implName: 'collect_dashboard_metrics',
      code: [
        'require_permission(principal, "incidents.read")',
        'org_id = principal["org_id"]',
        '',
        'def one(sql, params=None):',
        '    rows = db.query(sql, params or [], org_id)',
        '    return rows[0] if rows else {}',
        '',
        'return {',
        '    "incidents": one(',
        '        "SELECT count(*) FILTER (WHERE status <> \'closed\') AS active, "',
        '        "count(*) FILTER (WHERE status <> \'closed\' AND severity = \'critical\') AS critical, "',
        '        "count(*) FILTER (WHERE created_at > now() - interval \'24 hours\') AS today "',
        '        "FROM incident WHERE org_id = %s", [org_id]),',
        '    "response": one(',
        '        "SELECT round(avg(extract(epoch FROM acknowledged_at - created_at)))::int AS mtta_s, "',
        '        "round(avg(extract(epoch FROM closed_at - created_at)))::int AS mttr_s "',
        '        "FROM incident WHERE org_id = %s AND closed_at > now() - interval \'30 days\'",',
        '        [org_id]),',
        '    "automation": one(',
        '        "SELECT count(*) AS total, "',
        '        "count(*) FILTER (WHERE status = \'succeeded\') AS succeeded, "',
        '        "count(*) FILTER (WHERE status = \'failed\') AS failed, "',
        '        "count(*) FILTER (WHERE status = \'waiting_approval\') AS waiting "',
        '        "FROM execution WHERE org_id = %s AND started_at > now() - interval \'24 hours\'",',
        '        [org_id]),',
        '    "approvals": one(',
        '        "SELECT count(*) AS pending FROM approval "',
        '        "WHERE org_id = %s AND status = \'pending\'", [org_id]),',
        '    "integrations": db.query(',
        '        "SELECT name, health, last_check_at, last_error FROM integration "',
        '        "WHERE org_id = %s AND enabled ORDER BY health, name", [org_id], org_id),',
        '    "top_techniques": db.query(',
        '        "SELECT unnest(technique_ids) AS technique, count(*) AS hits "',
        '        "FROM incident WHERE org_id = %s AND created_at > now() - interval \'30 days\' "',
        '        "GROUP BY technique ORDER BY hits DESC LIMIT 10", [org_id], org_id),',
        '}',
      ].join('\n'),
    });

    exports_(service.file, [
      { name: 'create_from_alert', sort: 'function' },
      { name: 'change_status', sort: 'function' },
      { name: 'attach_indicator', sort: 'function' },
      { name: 'dashboard_metrics', sort: 'function' },
    ]);
    imports_(service.file, timeline.file, ['append']);
    imports_(service.file, indicators.file, ['detect_type', 'normalise_value']);
  }

  // -------------------------------------------------------------------------
  // incidents/cases.py
  // -------------------------------------------------------------------------
  const cases = py(ctx, { path: 'src/incidents/cases.py', module: incidents, doc: 'cases and tasks', style: 'service' });
  {
    const g = cases.g;
    fnWithBody(g, {
      name: 'open_case',
      params: [
        { name: 'db', type: 'Any' },
        { name: 'principal', type: 'Map<string, Any>' },
        { name: 'title', type: 'string' },
        { name: 'template', type: 'Map<string, Any>' },
      ],
      returns: 'string',
      doc: 'Open a case, expanding a template into real tasks. A SOC runs on the task list as much as on the automation, so templates are data the team edits.',
      implName: 'create_case_from_template',
      code: [
        'require_permission(principal, "cases.write")',
        'org_id = principal["org_id"]',
        'case_id = new_id("case")',
        '',
        'db.execute(',
        '    "INSERT INTO app_case (id, org_id, number, title, status, owner_id, severity) "',
        '    "SELECT %s, %s, coalesce(max(number), 0) + 1, %s, \'open\', %s, %s "',
        '    "FROM app_case WHERE org_id = %s",',
        '    [case_id, org_id, title, principal.get("id"),',
        '     template.get("default_severity", "medium"), org_id],',
        '    org_id,',
        ')',
        'for index, task in enumerate(template.get("tasks", [])):',
        '    db.execute(',
        '        "INSERT INTO task (id, org_id, case_id, title, description, status, order_index) "',
        '        "VALUES (%s, %s, %s, %s, %s, \'open\', %s)",',
        '        [new_id("task"), org_id, case_id, task["title"],',
        '         task.get("description"), index],',
        '        org_id,',
        '    )',
        'return case_id',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'default_templates',
      returns: 'Map<string, Any>',
      doc: 'Case templates shipped with the platform. Editable in the UI; nothing in the engine knows these names.',
      implName: 'shipped_case_templates',
      code: [
        'return {',
        '    "phishing": {',
        '        "default_severity": "medium",',
        '        "tasks": [',
        '            {"title": "Preserve the original message and headers"},',
        '            {"title": "Extract and enrich sender, URLs and attachments"},',
        '            {"title": "Identify every recipient in the tenant"},',
        '            {"title": "Determine whether anyone interacted"},',
        '            {"title": "Purge or quarantine where justified"},',
        '            {"title": "Block sender and infrastructure"},',
        '            {"title": "Notify affected users"},',
        '            {"title": "Record detection gaps"},',
        '        ],',
        '    },',
        '    "malware": {',
        '        "default_severity": "high",',
        '        "tasks": [',
        '            {"title": "Confirm the detection and collect the sample hash"},',
        '            {"title": "Identify the affected host and its owner"},',
        '            {"title": "Check for lateral movement in the last 24 hours"},',
        '            {"title": "Decide on isolation and request approval"},',
        '            {"title": "Collect triage artefacts before remediation"},',
        '            {"title": "Remediate and verify"},',
        '            {"title": "Return the host to service"},',
        '            {"title": "Write the incident report"},',
        '        ],',
        '    },',
        '    "account_compromise": {',
        '        "default_severity": "high",',
        '        "tasks": [',
        '            {"title": "Confirm the sign-in anomaly"},',
        '            {"title": "Review sign-in logs for the last 30 days"},',
        '            {"title": "Revoke sessions and reset credentials"},',
        '            {"title": "Check mailbox rules and forwarding"},',
        '            {"title": "Check OAuth grants and app consents"},',
        '            {"title": "Review privileged group membership changes"},',
        '            {"title": "Restore access with the user"},',
        '        ],',
        '    },',
        '}',
      ].join('\n'),
    });
    exports_(cases.file, [
      { name: 'open_case', sort: 'function' },
      { name: 'default_templates', sort: 'function' },
    ]);
  }

  iface(incidents, [
    { name: 'create_from_alert', kind: 'function', doc: 'Open or attach an incident from a normalised alert.' },
    { name: 'change_status', kind: 'function', doc: 'The one state-change path: permission, timeline, audit, metrics.' },
    { name: 'dashboard_metrics', kind: 'function', doc: 'The numbers behind the dashboard.' },
    { name: 'open_case', kind: 'function', doc: 'Open a case from a template.' },
  ]);

  return { normalize, intel, incidents };
}
