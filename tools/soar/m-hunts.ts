/**
 * Threat hunting.
 *
 * A hunt is a query an engineer wrote, held against one client's one tool, and
 * run on a schedule. It is not a detection rule: a rule fires and an analyst
 * works it, a hunt returns rows that a person still has to look at. That
 * distinction is the whole design here.
 *
 * Three decisions worth stating, because they shape everything below.
 *
 * **A hit is not a finding, and a finding is not an alert.** A query that
 * returns rows has found something worth reading, and most of the time it is
 * the estate behaving normally. So a run produces a FINDING that sits in a
 * review queue, and only a human verdict of true positive raises an alert. A
 * hunt wired straight into the analyst queue is a hunt nobody will write again
 * after the first week of noise. High-fidelity queries can opt in to raising
 * directly, and that is a per-query decision an engineer makes deliberately.
 *
 * **Every query carries a tactic and a technique.** Not as metadata for a
 * report - as a required field, refused at save time. A hunt library with no
 * ATT&CK mapping cannot answer the only question anyone asks of it, which is
 * what the SOC is and is not looking for.
 *
 * **A query belongs to one client and one tool.** The query language is the
 * tool's, so a query cannot be portable; KQL does not run on Falcon. Copying a
 * hunt to another client is an explicit act that produces an independent copy,
 * exactly as playbooks work.
 */

import { addModule } from '#core/project/builder.ts';
import type { ProjectModule } from '#core/model/project.ts';
import type { Ctx } from './kit.ts';
import { exports_, fnWithBody, iface, py } from './kit.ts';

export interface HuntModules {
  hunting: ProjectModule;
}

export function buildHunts(ctx: Ctx, platform: ProjectModule, storage: ProjectModule,
                           identity: ProjectModule): HuntModules {
  const hunting = addModule(ctx.project, {
    name: 'hunting',
    directory: 'src/soar/hunting',
    description:
      'Threat hunting: per-client, per-tool queries with a required ATT&CK mapping, a schedule, and a review queue between a hit and an alert.',
    dependencies: [platform.id, storage.id, identity.id],
  });

  // ===========================================================================
  // hunting/model.py -- what a hunt is, and what the platform refuses
  // ===========================================================================
  const model = py(ctx, {
    path: 'src/hunting/model.py',
    module: hunting,
    doc: 'hunt definitions, ATT&CK requirements and schedule arithmetic',
    style: 'procedural',
  });
  {
    const g = model.g;

    fnWithBody(g, {
      name: 'attack_tactics',
      returns: 'List<Map<string, string>>',
      doc: [
        'The fourteen enterprise tactics, in kill-chain order.',
        '',
        'Ordered rather than alphabetical because the order is the point: a hunt',
        'library with nothing in Credential Access and eleven queries in Execution',
        'has a shape, and sorting the list by name hides it.',
      ].join('\n'),
      implName: 'enterprise_tactics',
      code: [
        'return [',
        '    {"id": "TA0043", "name": "Reconnaissance"},',
        '    {"id": "TA0042", "name": "Resource Development"},',
        '    {"id": "TA0001", "name": "Initial Access"},',
        '    {"id": "TA0002", "name": "Execution"},',
        '    {"id": "TA0003", "name": "Persistence"},',
        '    {"id": "TA0004", "name": "Privilege Escalation"},',
        '    {"id": "TA0005", "name": "Defense Evasion"},',
        '    {"id": "TA0006", "name": "Credential Access"},',
        '    {"id": "TA0007", "name": "Discovery"},',
        '    {"id": "TA0008", "name": "Lateral Movement"},',
        '    {"id": "TA0009", "name": "Collection"},',
        '    {"id": "TA0011", "name": "Command and Control"},',
        '    {"id": "TA0010", "name": "Exfiltration"},',
        '    {"id": "TA0040", "name": "Impact"},',
        ']',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'schedule_intervals',
      returns: 'Map<string, i64>',
      doc: [
        'Every cadence a hunt may run on, in days.',
        '',
        'A fixed set, because a cron expression in this field would be a hunt that',
        'runs every minute against a client SIEM, and the first anyone would know',
        'of it is the vendor bill.',
      ].join('\n'),
      implName: 'hunt_interval_days',
      code: [
        'return {',
        '    "daily": 1,',
        '    "weekly": 7,',
        '    "bi_weekly": 14,',
        '    "monthly": 30,',
        '    "quarterly": 91,',
        '    "semi_annual": 182,',
        '    "yearly": 365,',
        '}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'validate_hunt',
      params: [{ name: 'hunt', type: 'Map<string, Any>' }],
      returns: 'List<string>',
      doc: [
        'Everything a hunt is refused for.',
        '',
        'The ATT&CK mapping is checked here rather than trusted from the form,',
        'because this function is also what an import path and an API client go',
        'through, and a required field that only the browser enforces is not a',
        'required field.',
      ].join('\n'),
      implName: 'check_hunt_definition',
      code: [
        'import re',
        '',
        'problems = []',
        '',
        'if not (hunt.get("name") or "").strip():',
        '    problems.append("a hunt needs a name; it becomes the alert title")',
        'if len(hunt.get("name") or "") > 160:',
        '    problems.append("name is longer than 160 characters")',
        '',
        'if not (hunt.get("query") or "").strip():',
        '    problems.append("a hunt needs a query")',
        'if len(hunt.get("query") or "") > 65536:',
        '    problems.append("query is longer than 64KB")',
        '',
        'if not hunt.get("org_id"):',
        '    problems.append("a hunt belongs to exactly one client")',
        'if not hunt.get("connector_id"):',
        '    problems.append("a hunt names the tool it runs on; the query language "',
        '                    "is that tool\'s, so it cannot be left open")',
        '',
        '# --- the ATT&CK mapping, which is not optional -----------------------',
        'tactics = {t["name"] for t in attack_tactics()}',
        'tactic = (hunt.get("mitre_tactic") or "").strip()',
        'if not tactic:',
        '    problems.append("a hunt names the tactic it hunts for")',
        'elif tactic not in tactics:',
        '    problems.append("%r is not an enterprise tactic" % tactic)',
        '',
        'technique = (hunt.get("mitre_technique_id") or "").strip().upper()',
        'if not technique:',
        '    problems.append("a hunt names the technique it hunts for")',
        'elif not re.match(r"^T\\d{4}(\\.\\d{3})?$", technique):',
        '    problems.append("%r is not a technique id; expected T1059 or T1059.001"',
        '                    % technique)',
        '',
        '# --- the schedule ----------------------------------------------------',
        'if hunt.get("automatic"):',
        '    interval = hunt.get("schedule_interval")',
        '    if interval not in schedule_intervals():',
        '        problems.append(',
        '            "%r is not a schedule; expected one of %s"',
        '            % (interval, ", ".join(sorted(schedule_intervals()))))',
        '    at = (hunt.get("schedule_time") or "").strip()',
        '    if not re.match(r"^([01]\\d|2[0-3]):[0-5]\\d$", at):',
        '        problems.append("schedule_time must be HH:MM in 24-hour UTC")',
        '    if interval in ("weekly", "bi_weekly") and not hunt.get("schedule_day"):',
        '        problems.append(',
        '            "a weekly hunt needs a day, or it runs on whichever day it "',
        '            "was first saved")',
        '    if interval in ("monthly", "quarterly", "semi_annual", "yearly"):',
        '        day = hunt.get("schedule_day_of_month")',
        '        if day is not None and not (1 <= int(day) <= 28):',
        '            problems.append(',
        '                "day of month must be 1-28, so the hunt also runs in "',
        '                "February")',
        '',
        'if hunt.get("on_hit") not in ("review", "alert"):',
        '    problems.append("on_hit is review or alert")',
        '',
        'lookback = hunt.get("lookback_hours")',
        'if lookback is not None and not (1 <= int(lookback) <= 8760):',
        '    problems.append("lookback must be between 1 hour and a year")',
        '',
        'return problems',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'hunt_is_due',
      params: [
        { name: 'hunt', type: 'Map<string, Any>' },
        { name: 'now', type: 'Any' },
      ],
      returns: 'bool',
      doc: [
        'Whether this hunt should run in the minute that is happening now.',
        '',
        'Two conditions, both required: enough time has passed since the last run,',
        'AND the clock reads the minute the hunt asked for. The second is what',
        'stops a platform restart from firing every overdue hunt at once - a',
        'stampede across every client SIEM at the same second, which is how a SOC',
        'gets rate-limited out of its own tooling.',
        '',
        'A hunt that has never run is seeded from its creation time rather than',
        'treated as infinitely overdue, for the same reason.',
      ].join('\n'),
      implName: 'hunt_due_now',
      code: [
        'import datetime',
        '',
        'if not hunt.get("enabled") or not hunt.get("automatic"):',
        '    return False',
        '',
        'days = schedule_intervals().get(hunt.get("schedule_interval") or "")',
        'if not days:',
        '    return False',
        '',
        '# The minute has to match. Anything else is a hunt that runs at whatever',
        '# time the scheduler happened to notice it.',
        'wanted = (hunt.get("schedule_time") or "00:00").split(":")',
        'if int(wanted[0]) != now.hour or int(wanted[1]) != now.minute:',
        '    return False',
        '',
        'interval = hunt.get("schedule_interval")',
        'if interval in ("weekly", "bi_weekly"):',
        '    day = (hunt.get("schedule_day") or "").strip().lower()[:3]',
        '    names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]',
        '    if day in names and names.index(day) != now.weekday():',
        '        return False',
        'elif interval in ("monthly", "quarterly", "semi_annual", "yearly"):',
        '    day_of_month = hunt.get("schedule_day_of_month")',
        '    if day_of_month and int(day_of_month) != now.day:',
        '        return False',
        '',
        'last = hunt.get("last_run_at")',
        'if last is None:',
        '    return True',
        '',
        '# A little under the full interval, because the minute check already',
        '# pins the time: a weekly hunt compared against exactly 7 days misses',
        '# its slot whenever the previous run started a second late.',
        'elapsed = now - last',
        'return elapsed >= datetime.timedelta(days=days, hours=-1)',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'finding_title',
      params: [
        { name: 'client_name', type: 'string' },
        { name: 'hunt_name', type: 'string' },
      ],
      returns: 'string',
      doc: [
        'The title every alert raised from a hunt carries.',
        '',
        'One function, because the format is a contract: an analyst opening the',
        'queue has to be able to tell at a glance that this came from a hunt and',
        'not from a detection, and which client it belongs to, without opening it.',
      ].join('\n'),
      implName: 'hunt_alert_title',
      code: [
        'client = (client_name or "Unknown client").strip()',
        'hunt = (hunt_name or "Untitled hunt").strip()',
        'return "%s | Threat Hunt | %s" % (client, hunt)',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'summarise_rows',
      params: [
        { name: 'rows', type: 'List<Any>' },
        { name: 'limit', type: 'i64' },
      ],
      returns: 'Map<string, Any>',
      doc: [
        'What a run keeps out of what a tool returned.',
        '',
        'A sample and a count, never the whole result set. A hunt over ninety days',
        'of sign-in logs can return a million rows, and a platform that stores all',
        'of them per run per client is a platform that fills its disk in a week.',
        'The tool remains the system of record; this is the evidence an engineer',
        'needs to decide whether to go and look.',
      ].join('\n'),
      implName: 'sample_hunt_rows',
      code: [
        'import json',
        '',
        'items = list(rows or [])',
        'sample = []',
        'budget = 65536',
        '',
        'for row in items[:max(limit, 0)]:',
        '    encoded = json.dumps(row, default=str)',
        '    if len(encoded) > budget:',
        '        break',
        '    budget -= len(encoded)',
        '    sample.append(row)',
        '',
        'columns = []',
        'for row in sample:',
        '    if isinstance(row, dict):',
        '        for key in row:',
        '            if key not in columns:',
        '                columns.append(key)',
        '',
        'return {"count": len(items), "sample": sample, "columns": columns,',
        '        "truncated": len(sample) < len(items)}',
      ].join('\n'),
    });

    exports_(model.file, [
      { name: 'attack_tactics', sort: 'function' },
      { name: 'schedule_intervals', sort: 'function' },
      { name: 'validate_hunt', sort: 'function' },
      { name: 'hunt_is_due', sort: 'function' },
      { name: 'finding_title', sort: 'function' },
      { name: 'summarise_rows', sort: 'function' },
    ]);
  }

  iface(hunting, [
    { name: 'validate_hunt', kind: 'function', doc: 'Everything a hunt is refused for, including its required ATT&CK mapping.' },
    { name: 'hunt_is_due', kind: 'function', doc: 'Whether a scheduled hunt should run in this minute.' },
    { name: 'finding_title', kind: 'function', doc: 'The one title format for an alert raised from a hunt.' },
    { name: 'attack_tactics', kind: 'function', doc: 'The fourteen enterprise tactics, in kill-chain order.' },
    { name: 'schedule_intervals', kind: 'function', doc: 'Every cadence a hunt may run on.' },
  ]);

  return { hunting };
}
