/**
 * The rest of the workspace: the thirteen list screens and the login page.
 *
 * They are generated from one descriptor each rather than hand-built, because
 * they genuinely are the same screen - toolbar, filters, table, row action -
 * pointed at different endpoints. Writing thirteen near-identical pages by hand
 * is how a UI ends up with thirteen slightly different sort behaviours.
 *
 * What is NOT generated is anything with real interaction: the dashboard, the
 * incident workspace, the playbook editor and the execution console are all
 * written out in full, because they are not lists.
 */

import { GraphBuilder, addFile } from '#core/project/builder.ts';
import { emptyUiDocument } from '#core/model/ui.ts';
import type { UiDocument, UiNode } from '#core/model/ui.ts';
import type { WebFiles } from './m-web.ts';
import type { Ctx } from './kit.ts';
import { bindMarkupHandlers, exports_, fnWithBody, publishToRegistry } from './kit.ts';

interface PageSpec {
  view: string;
  title: string;
  /** Column header labels; the JS descriptor maps them to fields. */
  columns: string[];
  filters?: { name: string; label: string; options: string[] }[];
  actions?: { label: string; handler: string }[];
  /** Per-row buttons. Declared here only so the table reserves a header cell. */
  acts?: { label: string; handler: string }[];
  note?: string;
  /** What the session must hold to see this in the rail and open the page. */
  permission?: string;
}

const PAGES: PageSpec[] = [
  {
    view: 'clients',
    title: 'Clients',
    columns: ['Name', 'Contacts', 'Status', 'Connected', 'Waiting', 'Open incidents', 'Onboarded'],
    filters: [{ name: 'status', label: 'Status', options: ['active', 'suspended', 'offboarded'] }],
    actions: [{ label: 'Add client', handler: 'onAddClient' }],
    acts: [{ label: 'Work on', handler: '' }],
    note: 'Every other screen shows one client at a time. "Work on" switches which one, and it is re-checked server-side on every switch - that boundary is the whole of a managed service.',
    permission: 'clients.read',
  },
  {
    view: 'incidents',
    permission: 'incidents.read',
    title: 'Incidents',
    columns: ['#', 'Severity', 'Title', 'Status', 'Assignee', 'SLA', 'Age'],
    filters: [
      { name: 'status', label: 'Status', options: ['open', 'new', 'triage', 'investigating', 'containment', 'closed'] },
      { name: 'severity', label: 'Severity', options: ['critical', 'high', 'medium', 'low', 'info'] },
    ],
    actions: [{ label: 'New incident', handler: 'onCreateIncident' }],
  },
  {
    view: 'alerts',
    permission: 'alerts.read',
    title: 'Alerts',
    columns: ['Source', 'Title', 'Severity', 'Category', 'Observed', 'Status', 'Incident'],
    filters: [{ name: 'status', label: 'Status', options: ['new', 'triaged', 'merged', 'closed'] }],
    note: 'Select an alert and press T to triage it into an incident.',
  },
  {
    view: 'cases',
    permission: 'cases.read',
    title: 'Cases',
    columns: ['#', 'Title', 'Status', 'Owner', 'Severity', 'Opened'],
    actions: [{ label: 'New case', handler: 'onCreateCase' }],
  },
  {
    view: 'commands',
    permission: 'commands.read',
    title: 'Commands',
    columns: ['Key', 'Name', 'Category', 'Trust', 'Risk', 'Effect', 'Integration'],
    actions: [{ label: 'New command', handler: 'onCreateCommand' }],
    filters: [
      { name: 'trust_level', label: 'Trust', options: ['trusted', 'verified', 'untrusted'] },
      { name: 'effect', label: 'Effect', options: ['read', 'mutating'] },
    ],
    note: 'RISK is what this command can do to a customer estate, and the engine acts on it. LOW reads or changes something trivially reversible. MEDIUM makes a real change with a known way back. HIGH takes something away from the business - isolating a host, disabling an account, deleting mail - so a playbook that reaches one stops for a human, and that approval cannot be timed out into proceeding.',
  },
  {
    view: 'intel',
    permission: 'intel.read',
    title: 'Threat Intelligence',
    columns: ['Type', 'Value', 'Verdict', 'Score', 'Sightings', 'Last seen', 'Tags'],
    filters: [
      { name: 'type', label: 'Type', options: ['ipv4', 'ipv6', 'domain', 'url', 'sha256', 'md5', 'email', 'cve'] },
      { name: 'verdict', label: 'Verdict', options: ['malicious', 'suspicious', 'benign', 'unknown'] },
    ],
    actions: [{ label: 'Add indicator', handler: 'onAddIndicatorGlobal' }],
  },
  {
    view: 'feeds',
    permission: 'intel.read',
    title: 'Intel Feeds',
    columns: ['Name', 'Format', 'Collection', 'Enabled', 'Last fetch', 'Status', 'Stored', 'Rejected', 'Error'],
    filters: [{ name: 'status', label: 'Status', options: ['ok', 'failed', 'queued'] }],
    actions: [
      { label: 'Add feed', handler: 'onAddFeed' },
      { label: 'Load ATT&CK', handler: 'onLoadAttack' },
    ],
    acts: [{ label: 'Fetch now', handler: '' }, { label: 'Collections', handler: '' }],
    note: 'A feed entry is not a sighting. Ingesting a feed updates what the platform knows about an indicator and never claims it was seen in your estate, so sighting counts stay meaningful.',
  },
  {
    view: 'assets',
    permission: 'incidents.read',
    title: 'Assets',
    columns: ['Hostname', 'OS', 'Criticality', 'EDR agents', 'Isolated', 'Owner', 'Last seen'],
    note: 'EDR agents determines which response actions can reach a host. A host with no agent cannot be contained.',
  },
  {
    view: 'executions',
    permission: 'executions.read',
    title: 'Executions',
    columns: ['Execution', 'Playbook', 'Status', 'Mode', 'Trigger', 'Started', 'Duration'],
    filters: [
      { name: 'status', label: 'Status', options: ['running', 'waiting_approval', 'succeeded', 'failed', 'cancelled'] },
      { name: 'mode', label: 'Mode', options: ['live', 'dry_run', 'simulation'] },
    ],
  },
  {
    view: 'approvals',
    permission: 'approvals.read',
    title: 'Approvals',
    columns: ['Action', 'Summary', 'Risk', 'Requested by', 'Expires', 'Status'],
    filters: [{ name: 'status', label: 'Status', options: ['pending', 'approved', 'rejected', 'expired'] }],
    acts: [{ label: 'Decide', handler: '' }],
    note: 'Deciding a HIGH-risk approval requires re-authentication, and the requester cannot approve their own action.',
  },
  {
    view: 'playbooks',
    permission: 'playbooks.read',
    title: 'Playbooks',
    columns: ['Key', 'Name', 'Category', 'Version', 'State', 'Techniques'],
    actions: [{ label: 'New playbook', handler: 'onCreatePlaybook' }],
  },
  {
    view: 'reports',
    permission: 'reports.read',
    title: 'Reports',
    columns: ['Report', 'What it covers', 'Needs'],
    acts: [{ label: 'Export', handler: '' }],
    note: 'Exports are stored by content hash in the object store and the export itself is audited.',
  },
  {
    view: 'admin',
    permission: 'admin.users',
    title: 'Administration',
    columns: ['Email', 'Name', 'Status', 'MFA', 'Roles', 'Last login'],
    note: 'MFA must be enrolled before an account can be granted any response.* or secrets.* permission.',
  },
];

const panel = (id: string, classes: string[], children: UiNode[]): UiNode => ({
  id,
  kind: 'panel',
  classes,
  children,
});

const label = (id: string, text: string, classes: string[] = [], name?: string): UiNode => ({
  id,
  kind: 'label',
  text,
  classes,
  name,
});

function navItem(
  view: string,
  text: string,
  key: string,
  active: string,
  permission?: string,
): UiNode {
  return {
    id: 'nav-' + view,
    kind: 'link',
    text,
    classes: view === active ? ['nav-item', 'is-active'] : ['nav-item'],
    attrs: {
      href: view === 'dashboard' ? '/index.html' : `/${view}.html`,
      'data-view': view,
      'data-key': key,
      ...(permission ? { 'data-permission': permission, hidden: 'hidden' } : {}),
    },
  };
}

/** The rail and command bar, identical on every page. */
function shell(active: string, body: UiNode[]): UiNode[] {
  // view, label, shortcut, permission. Empty permission means everyone.
  const items: [string, string, string, string][] = [
    ['clients', 'Clients', 'g l', 'clients.read'],
    ['dashboard', 'Dashboard', 'g d', 'incidents.read'],
    ['incidents', 'Incidents', 'g i', 'incidents.read'],
    ['alerts', 'Alerts', 'g a', 'alerts.read'],
    ['cases', 'Cases', 'g c', 'cases.read'],
    ['playbooks', 'Playbooks', 'g p', 'playbooks.read'],
    ['commands', 'Commands', 'g m', 'commands.read'],
    ['integrations', 'Integrations', 'g n', 'integrations.read'],
    ['intel', 'Threat Intel', 'g t', 'intel.read'],
    ['feeds', 'Intel Feeds', 'g f', 'intel.read'],
    ['hunts', 'Threat Hunting', 'g h', 'hunts.read'],
    ['findings', 'Hunt Findings', 'g u', 'hunts.review'],
    ['assets', 'Assets', 'g s', 'incidents.read'],
    ['executions', 'Executions', 'g e', 'executions.read'],
    ['approvals', 'Approvals', 'g v', 'approvals.read'],
    ['reports', 'Reports', 'g r', 'reports.read'],
    ['admin', 'Administration', 'g y', 'admin.users'],
  ];
  return [
    panel('rail', ['rail'], [
      panel('brand', ['brand'], [
        label('brand-mark', '//', ['brand-mark']),
        label('brand-name', 'MASTER SOAR', ['brand-name']),
      ]),
      {
        id: 'nav',
        kind: 'menu',
        classes: ['nav'],
        // Rendered hidden, then revealed by the permissions the session reports.
        // Server-side the permission is checked again on every request; this only
        // stops the rail being a list of things that answer 403.
        children: items.map(([view, text, key, permission]) =>
          navItem(view, text, key, active, permission)),
      },
      panel('rail-foot', ['rail-foot'], [
        {
          id: 'theme-toggle',
          kind: 'button',
          name: 'themeToggle',
          text: 'Light / Dark',
          classes: ['ghost', 'wide'],
          attrs: { type: 'button', title: 'Toggle theme (t)' },
          events: [{ event: 'click', handler: 'onToggleTheme' }],
        },
        label('build-id', 'v0.1.0 · local', ['muted', 'tiny']),
      ]),
    ]),
    panel('main', ['main'], [
      panel('commandbar', ['commandbar'], [
        {
          id: 'omnibox',
          kind: 'textbox',
          name: 'omnibox',
          classes: ['omnibox'],
          attrs: { placeholder: 'Search…   (/ to focus)', type: 'search', autocomplete: 'off' },
        },
        panel('bar-status', ['bar-status'], [
          label('active-client', '—', ['chip', 'chip-client'], 'activeClient'),
          label('queue-depth', 'queue —', ['chip'], 'queueDepth'),
          label('worker-state', 'workers —', ['chip'], 'workerState'),
          label('pending-approvals', 'approvals —', ['chip', 'chip-attn'], 'pendingApprovals'),
        ]),
      ]),
      panel('view', ['view'], body),
      panel('statusstrip', ['statusstrip'], [
        label('status-message', 'ready', ['status-message'], 'statusMessage'),
        label('status-clock', '', ['status-clock'], 'statusClock'),
      ]),
    ]),
  ];
}

function listDoc(spec: PageSpec, styleId: string, scripts: string[]): UiDocument {
  const doc = emptyUiDocument(`Master SOAR — ${spec.title}`);
  doc.stylesheets = [styleId];
  doc.scripts = scripts;

  const toolbar: UiNode[] = [
    { id: 'page-title', kind: 'heading', text: spec.title, classes: ['page-title'], attrs: { level: '1' } },
  ];
  for (const filter of spec.filters ?? []) {
    toolbar.push({
      id: `filter-${filter.name}`,
      kind: 'select',
      name: `filter_${filter.name}`,
      classes: ['page-filter'],
      attrs: { 'data-filter': filter.name, 'aria-label': filter.label },
      items: ['', ...filter.options],
      events: [{ event: 'change', handler: 'onPageFilter' }],
    });
  }
  toolbar.push({ id: 'toolbar-grow', kind: 'panel', classes: ['grow'], children: [] });
  toolbar.push(label('row-count', '', ['muted', 'tiny'], 'rowCount'));
  toolbar.push({
    id: 'page-refresh',
    kind: 'button',
    name: 'pageRefresh',
    text: 'Refresh',
    classes: ['ghost'],
    attrs: { type: 'button' },
    events: [{ event: 'click', handler: 'onPageRefresh' }],
  });
  (spec.actions ?? []).forEach((action, index) => {
    toolbar.push({
      id: index === 0 ? 'page-action' : `page-action-${index}`,
      kind: 'button',
      name: index === 0 ? 'pageAction' : `pageAction${index}`,
      text: action.label,
      // The first action is the page's primary one; any others sit beside it in
      // the quieter treatment, so a screen with two buttons still has one answer
      // to "what am I here to do".
      classes: index === 0 ? ['accent'] : ['ghost'],
      attrs: { type: 'button' },
      events: [{ event: 'click', handler: action.handler }],
    });
  });

  const body: UiNode[] = [panel('page-toolbar', ['page-toolbar'], toolbar)];
  if (spec.note) {
    body.push(label('page-note', spec.note, ['page-note']));
  }
  body.push(
    panel('page-card', ['card'], [
      panel('page-scroll', ['scroll-x'], [
        {
          id: 'page-table',
          kind: 'table',
          name: 'pageTable',
          // One blank header per row action, or the action cells sit under the
          // wrong headings and every column after them reads as shifted.
          items: [...spec.columns, ...(spec.acts ?? []).map(() => '')],
        },
      ]),
      label('page-empty', '', ['muted', 'tiny'], 'emptyState'),
    ]),
  );

  doc.root = shell(spec.view, body);
  doc.rules = [
    {
      selector: '.page-toolbar',
      declarations: { display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap', 'margin-bottom': '10px' },
    },
    { selector: '.page-toolbar .grow', declarations: { flex: '1' } },
    { selector: '.page-title', declarations: { 'font-size': '16px', margin: '0', 'font-weight': '600' } },
    {
      selector: '.page-filter',
      declarations: {
        background: 'var(--sunken)',
        border: '1px solid var(--line)',
        color: 'var(--ink)',
        'font-family': 'var(--mono)',
        'font-size': '11.5px',
        padding: '4px 6px',
      },
    },
    {
      selector: '.page-note',
      declarations: {
        display: 'block',
        'border-left': '2px solid var(--accent)',
        padding: '4px 9px',
        margin: '0 0 10px',
        color: 'var(--muted)',
        'font-size': '11.5px',
      },
    },
    { selector: 'tbody tr.is-selected', declarations: { outline: '1px solid var(--accent)', 'outline-offset': '-1px' } },
    { selector: 'tbody tr', declarations: { cursor: 'pointer' } },
  ];
  return doc;
}

function loginDoc(styleId: string, scripts: string[]): UiDocument {
  const doc = emptyUiDocument('Master SOAR — Sign in');
  doc.stylesheets = [styleId];
  doc.scripts = scripts;
  doc.root = [
    panel('login-wrap', ['login-wrap'], [
      panel('login-card', ['login-card'], [
        panel('login-brand', ['brand'], [
          label('login-mark', '//', ['brand-mark']),
          label('login-name', 'MASTER SOAR', ['brand-name']),
        ]),
        {
          id: 'login-form',
          kind: 'form',
          name: 'loginForm',
          children: [
            panel('field-email', ['pb-field'], [
              { id: 'email-label', kind: 'label', text: 'Email', attrs: { for: 'login-email' } },
              {
                id: 'login-email',
                kind: 'textbox',
                name: 'loginEmail',
                attrs: { type: 'email', autocomplete: 'username', required: 'required' },
              },
            ]),
            panel('field-password', ['pb-field'], [
              { id: 'password-label', kind: 'label', text: 'Password', attrs: { for: 'login-password' } },
              {
                id: 'login-password',
                kind: 'textbox',
                name: 'loginPassword',
                attrs: { type: 'password', autocomplete: 'current-password', required: 'required' },
              },
            ]),
            {
              id: 'login-submit',
              kind: 'button',
              name: 'loginSubmit',
              text: 'Continue',
              classes: ['accent', 'wide'],
              attrs: { type: 'button' },
              events: [{ event: 'click', handler: 'onLoginPassword' }],
            },
          ],
        },
        panel('enrol-step', ['enrol-step'], [
          label('enrol-title', 'SET UP YOUR AUTHENTICATOR', ['field-label']),
          label('enrol-hint',
            'Scan this with Microsoft Authenticator: + > Other account > scan. '
            + 'Then enter the six digits it shows.',
            ['enrol-hint']),
          { id: 'enrol-qr', kind: 'panel', name: 'enrolQr', classes: ['enrol-qr'], children: [] },
          label('enrol-secret', '', ['enrol-secret'], 'enrolSecret'),
        ]),
        panel('mfa-step', ['mfa-step'], [
          label('mfa-title', 'Two-factor code', ['card-title']),
          {
            id: 'login-code',
            kind: 'textbox',
            name: 'loginCode',
            attrs: { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '000000' },
          },
          {
            id: 'mfa-submit',
            kind: 'button',
            name: 'mfaSubmit',
            text: 'Sign in',
            classes: ['accent', 'wide'],
            attrs: { type: 'button' },
            events: [{ event: 'click', handler: 'onLoginMfa' }],
          },
        ]),
        label('login-error', '', ['login-error'], 'loginError'),
        label(
          'login-note',
          'A password alone gets you a session with no permissions. MFA is what grants them.',
          ['muted', 'tiny'],
        ),
      ]),
    ]),
  ];
  doc.rules = [
    {
      selector: '.login-wrap',
      declarations: { display: 'grid', 'place-items': 'center', 'min-height': '100vh', padding: '16px' },
    },
    {
      selector: '.login-card',
      declarations: {
        width: 'min(360px, 100%)',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        padding: '22px',
      },
    },
    { selector: '.login-card .brand', declarations: { padding: '0 0 14px', border: '0' } },
    {
      selector: '.mfa-step',
      comment: 'Hidden until the password step succeeds; the two steps are never on screen together.',
      declarations: { display: 'none', 'margin-top': '14px' },
    },
    { selector: '.mfa-step.is-active', declarations: { display: 'block' } },
    { selector: '.enrol-step', declarations: { display: 'none', 'margin-bottom': '14px' } },
    { selector: '.enrol-step.is-active', declarations: { display: 'block' } },
    {
      selector: '.enrol-qr',
      declarations: {
        background: '#ffffff',
        padding: '10px',
        display: 'inline-block',
        'margin-bottom': '8px',
        border: '1px solid var(--line)',
      },
    },
    {
      selector: '.enrol-hint',
      declarations: {
        display: 'block',
        color: 'var(--muted)',
        'font-size': '11.5px',
        'line-height': '1.5',
        'margin-bottom': '10px',
      },
    },
    {
      selector: '.enrol-secret',
      declarations: {
        display: 'block',
        'font-family': 'var(--mono)',
        'font-size': '11.5px',
        color: 'var(--muted)',
        'word-break': 'break-all',
        'margin-bottom': '10px',
      },
    },
    { selector: '.login-error', declarations: { display: 'block', color: 'var(--crit)', 'font-size': '11.5px', 'margin-top': '10px', 'min-height': '16px' } },
    { selector: '.login-card .pb-field', declarations: { 'margin-bottom': '10px' } },
  ];
  return doc;
}

export function buildPages(ctx: Ctx, web: WebFiles): void {
  // ===========================================================================
  // web/pages.js -- one descriptor per screen, one renderer
  // ===========================================================================
  const pages = addFile(ctx.project, {
    path: 'src/web/pages.js',
    language: 'javascript',
    role: 'source',
    kind: 'hybrid',
    moduleId: web.web.id,
    graph: { name: 'list pages', style: 'data-flow' },
  });
  {
    const g = new GraphBuilder(ctx.project, ctx.registry, pages.graph!);

    fnWithBody(g, {
      name: 'pageDescriptors',
      returns: 'Any',
      doc: [
        'What each list screen fetches and how it renders.',
        '',
        'One table instead of thirteen page scripts. Every entry names a real endpoint',
        'from api/routes.py - if one were wrong the page would 404 rather than quietly',
        'showing nothing, because `request` surfaces failures instead of swallowing',
        'them.',
      ].join('\n'),
      language: 'javascript',
      implName: 'page_descriptor_table',
      code: [
        'const severity = (row) => `sev sev-${row.severity}`;',
        'const mono = "mono";',
        '',
        'return {',
        '  incidents: {',
        '    endpoint: "/api/incidents", rows: (d) => d.items,',
        '    open: (row) => `/incident.html?id=${encodeURIComponent(row.id)}`,',
        '    columns: [',
        '      { field: "number", className: mono },',
        '      { field: "severity", className: severity },',
        '      { field: "title" },',
        '      { field: "status" },',
        '      { field: "assignee_id", className: "muted" },',
        '      { field: "sla_state" },',
        '      { field: "age_s", className: mono, format: "duration" },',
        '    ],',
        '  },',
        '  alerts: {',
        '    endpoint: "/api/alerts", rows: (d) => d.items,',
        '    open: (row) => `/alert.html?id=${encodeURIComponent(row.id)}`,',
        '    columns: [',
        '      { field: "source", className: mono },',
        '      { field: "title" },',
        '      { field: "severity", className: severity },',
        '      { field: "category" },',
        '      { field: "observed_at", className: mono },',
        '      { field: "status" },',
        '      { field: "incident_id", className: mono },',
        '    ],',
        '  },',
        '  cases: {',
        '    endpoint: "/api/cases", rows: (d) => d.items,',
        '    columns: [',
        '      { field: "number", className: mono }, { field: "title" },',
        '      { field: "status" }, { field: "owner_id", className: "muted" },',
        '      { field: "severity", className: severity },',
        '      { field: "opened_at", className: mono },',
        '    ],',
        '  },',
        '  commands: {',
        '    endpoint: "/api/commands", rows: (d) => d.items,',
        '    columns: [',
        '      { field: "key", className: mono }, { field: "name" },',
        '      { field: "category" }, { field: "trust_level" },',
        '      { field: "risk_level", className: (r) => `sev sev-${r.risk_level}` },',
        '      { field: "effect" }, { field: "integration", className: "muted" },',
        '    ],',
        '  },',
        '  intel: {',
        '    endpoint: "/api/indicators", rows: (d) => d.items,',
        '    columns: [',
        '      { field: "type", className: mono }, { field: "value", className: mono },',
        '      { field: "verdict", className: (r) => `sev sev-${',
        '          { malicious: "critical", suspicious: "medium", benign: "low" }[r.verdict]',
        '          || "low"}` },',
        '      { field: "score", className: mono },',
        '      { field: "sighting_count", className: mono },',
        '      { field: "last_seen", className: mono }, { field: "tags" },',
        '    ],',
        '  },',
        '  clients: {',
        '    endpoint: "/api/clients", rows: (d) => d.items,',
        '    open: (row) => `/client.html?id=${encodeURIComponent(row.id)}`,',
        '    acts: [{ label: "Work on", handler: "switchClient" }],',
        '    columns: [',
        '      { field: "name" },',
        '      { field: "contacts", className: mono },',
        '      { field: "status", className: (r) => `sev sev-${',
        '          r.status === "active" ? "low" : "medium"}` },',
        '      { field: "integrations", className: mono },',
        '      { field: "pending_connectors", className: (r) => r.pending_connectors',
        '          ? "sev sev-medium" : "mono" },',
        '      { field: "open_incidents", className: mono },',
        '      { field: "onboarded_at", className: mono },',
        '    ],',
        '  },',
        '  feeds: {',
        '    endpoint: "/api/feeds", rows: (d) => d.items,',
        '    acts: [{ label: "Fetch now", handler: "fetchFeedNow" },',
        '            { label: "Collections", handler: "chooseCollection" }],',
        '    columns: [',
        '      { field: "name" }, { field: "format", className: mono },',
        '      { field: "collection_id", className: mono },',
        '      { field: "enabled" },',
        '      { field: "last_fetch_at", className: mono },',
        '      { field: "last_status", className: (r) => `sev sev-${',
        '          r.last_status === "ok" ? "low" : "critical"}` },',
        '      { field: "indicator_count", className: mono },',
        '      { field: "last_rejected_count", className: mono },',
        '      { field: "last_error", className: "muted" },',
        '    ],',
        '  },',
        '  assets: {',
        '    endpoint: "/api/assets", rows: (d) => d.items,',
        '    columns: [',
        '      { field: "hostname", className: mono }, { field: "os" },',
        '      { field: "criticality" },',
        '      // The column that decides whether this host can be contained at all.',
        '      { field: "agents", className: mono },',
        '      { field: "isolated" }, { field: "owner_user_id", className: "muted" },',
        '      { field: "last_seen_at", className: mono },',
        '    ],',
        '  },',
        '  executions: {',
        '    endpoint: "/api/executions", rows: (d) => d.items,',
        '    open: (row) => `/execution.html?id=${encodeURIComponent(row.id)}`,',
        '    columns: [',
        '      { field: "label", className: mono }, { field: "playbook_name" },',
        '      { field: "status" }, { field: "mode" }, { field: "trigger_kind" },',
        '      { field: "started_at", className: mono },',
        '      { field: "duration_ms", className: mono, format: "ms" },',
        '    ],',
        '  },',
        '  approvals: {',
        '    endpoint: "/api/approvals", rows: (d) => d.items,',
        '    acts: [{ label: "Decide", handler: "decideApproval" }],',
        '    columns: [',
        '      { field: "action_key", className: mono }, { field: "action_summary" },',
        '      { field: "risk_level", className: (r) => `sev sev-${r.risk_level}` },',
        '      { field: "requested_by_id", className: "muted" },',
        '      { field: "expires_at", className: mono }, { field: "status" },',
        '    ],',
        '  },',
        '  playbooks: {',
        '    endpoint: "/api/playbooks", rows: (d) => d.items,',
        '    open: (row) => `/playbook.html?id=${encodeURIComponent(row.id)}`,',
        '    columns: [',
        '      { field: "key", className: mono }, { field: "name" },',
        '      { field: "category" }, { field: "version", className: mono },',
        '      { field: "state" }, { field: "technique_ids", className: mono },',
        '    ],',
        '  },',
        '  ai: {',
        '    endpoint: "/api/ai/tools", rows: (d) => d.items,',
        '    columns: [',
        '      { field: "name", className: mono },',
        '      { field: "risk_level", className: (r) => `sev sev-${r.risk_level}` },',
        '      { field: "required_permission", className: mono },',
        '      { field: "requires_approval" }, { field: "scope" },',
        '      { field: "max_calls_per_turn", className: mono },',
        '    ],',
        '  },',
        '  admin: {',
        '    endpoint: "/api/admin/users", rows: (d) => d.items,',
        '    columns: [',
        '      { field: "email", className: mono }, { field: "display_name" },',
        '      { field: "status" }, { field: "mfa_enrolled" },',
        '      { field: "roles" }, { field: "last_login_at", className: mono },',
        '    ],',
        '  },',
        '  reports: {',
        '    endpoint: "/api/reports", rows: (d) => d.items,',
        '    acts: [{ label: "Export", handler: "exportReport" }],',
        '    columns: [',
        '      { field: "title" }, { field: "covers" },',
        '      { field: "permission", className: mono },',
        '    ],',
        '  },',
        '};',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'loadPage',
      params: [{ name: 'view', type: 'string' }],
      returns: 'Any',
      doc: [
        'Fetch and render one list screen.',
        '',
        'Filters come from the select elements, which carry the field name in a data',
        'attribute, so adding a filter to a page is a change to the descriptor and the',
        'markup - never to this function.',
      ].join('\n'),
      language: 'javascript',
      isAsync: true,
      implName: 'render_list_page',
      code: [
        'const descriptor = pageDescriptors()[view];',
        'if (!descriptor) return null;',
        '',
        'const params = new URLSearchParams();',
        'for (const select of document.querySelectorAll("[data-filter]")) {',
        '  if (select.value) params.set(select.dataset.filter, select.value);',
        '}',
        'const query = params.toString();',
        'const url = descriptor.endpoint + (query ? "?" + query : "");',
        '',
        'let payload;',
        'try {',
        '  payload = await request("GET", url);',
        '} catch (error) {',
        '  setText("statusMessage", `${view} failed to load: ${error.message}`);',
        '  setText("emptyState", error.message);',
        '  return null;',
        '}',
        'if (!payload) return null;',
        '',
        'const rows = descriptor.rows(payload) || [];',
        'renderPageRows(descriptor, rows);',
        'setText("rowCount", `${rows.length} row${rows.length === 1 ? "" : "s"}`);',
        'setText("emptyState", rows.length ? "" : "Nothing matches these filters.");',
        'setText("statusMessage", "ready");',
        'return payload;',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'renderPageRows',
      params: [
        { name: 'descriptor', type: 'Any' },
        { name: 'rows', type: 'Any' },
      ],
      returns: 'Void',
      doc: [
        'Build the table body, cell by cell, with textContent.',
        '',
        'Same rule as everywhere else in the workspace: no innerHTML with interpolated',
        'data. Alert titles and indicator values are attacker-influenceable, and this',
        'is the table they land in.',
      ].join('\n'),
      language: 'javascript',
      implName: 'paint_page_rows',
      code: [
        'const table = byName("pageTable");',
        'if (!table) return;',
        'const body = table.tBodies[0] || table.createTBody();',
        'body.replaceChildren();',
        '',
        'for (const row of rows) {',
        '  const tr = body.insertRow();',
        '  tr.tabIndex = 0;',
        '',
        '  for (const column of descriptor.columns) {',
        '    const cell = tr.insertCell();',
        '    if (column.className) {',
        '      cell.className = typeof column.className === "function"',
        '        ? column.className(row) : column.className;',
        '    }',
        '    cell.textContent = formatCell(row[column.field], column.format);',
        '  }',
        '',
        '  for (const act of descriptor.acts || []) {',
        '    const cell = tr.insertCell();',
        '    const button = document.createElement("button");',
        '    button.type = "button";',
        '    button.className = "ghost";',
        '    button.textContent = act.label;',
        '    button.addEventListener("click", (event) => {',
        '      // Without this the click also opens the row, and the analyst ends up',
        '      // on a detail page wondering whether the action ran.',
        '      event.stopPropagation();',
        '      pageAction(act.handler, row);',
        '    });',
        '    cell.append(button);',
        '  }',
        '',
        '  if (descriptor.open) {',
        '    const href = descriptor.open(row);',
        '    tr.addEventListener("click", () => { window.location.href = href; });',
        '    tr.addEventListener("keydown", (event) => {',
        '      if (event.key === "Enter") window.location.href = href;',
        '    });',
        '  }',
        '}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'formatCell',
      params: [
        { name: 'value', type: 'Any' },
        { name: 'format', type: 'string' },
      ],
      returns: 'string',
      doc: 'Render one value for a table cell. Durations read as durations; an empty value reads as an em dash rather than as nothing.',
      language: 'javascript',
      implName: 'format_table_cell',
      code: [
        'if (value === null || value === undefined || value === "") return "\\u2014";',
        'if (format === "duration") return formatDuration(value);',
        'if (format === "ms") return `${Math.round(Number(value))}ms`;',
        'if (Array.isArray(value)) return value.length ? value.join(", ") : "\\u2014";',
        'if (typeof value === "boolean") return value ? "yes" : "no";',
        'if (typeof value === "object") return JSON.stringify(value);',
        'return String(value);',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'pageAction',
      params: [
        { name: 'handler', type: 'string' },
        { name: 'row', type: 'Any' },
      ],
      returns: 'Any',
      doc: [
        'The row actions the list screens offer.',
        '',
        'Approving from here goes through the same endpoint the incident workspace',
        'uses, so the nonce, the separation-of-duty check and the MFA step-up all',
        'apply. A convenience button that skipped any of them would be the hole.',
      ].join('\n'),
      language: 'javascript',
      isAsync: true,
      implName: 'run_page_action',
      code: [
        'try {',
        '  if (handler === "decideApproval") {',
        '    const decision = window.confirm(',
        '      `${row.action_summary}\\n\\nRisk: ${row.risk_level.toUpperCase()}\\n\\n` +',
        '      "OK to APPROVE, Cancel to reject.") ? "approve" : "reject";',
        '    const reason = window.prompt("Reason (recorded on the audit trail):") || "";',
        '    await request("POST", `/api/approvals/${encodeURIComponent(row.id)}/decide`,',
        '                  { decision, reason, nonce: row.nonce });',
        '    setText("statusMessage", `approval ${decision}d`);',
        '  } else if (handler === "fetchFeedNow") {',
        '    await request("POST", `/api/feeds/${encodeURIComponent(row.id)}/fetch`, {});',
        '    setText("statusMessage",',
        '            `${row.name} queued; the worker fetches and parses it`);',
        '  } else if (handler === "switchClient") {',
        '    const moved = await request("POST", "/api/session/client",',
        '                                { client_id: row.id });',
        '    // A full reload, not a re-render: every screen in the workspace is',
        '    // scoped to one client, and half-swapped state across a customer',
        '    // boundary is the one mistake this product cannot make.',
        '    setText("statusMessage", `now working on ${moved.name}`);',
        '    window.location.reload();',
        '    return;',
        '  } else if (handler === "chooseCollection") {',
        '    const found = await request(',
        '      "GET", `/api/feeds/${encodeURIComponent(row.id)}/collections`);',
        '    if (!found.items.length) {',
        '      // Nothing cached yet, so the first click runs discovery rather than',
        '      // showing an empty list and making the analyst guess what to do.',
        '      await request(',
        '        "POST", `/api/feeds/${encodeURIComponent(row.id)}/discover`, {});',
        '      setText("statusMessage",',
        '              "discovery queued; click Collections again once it lands");',
        '    } else {',
        '      const menu = found.items.map((c, i) =>',
        '        `${i + 1}. ${c.title}${c.can_read ? "" : "  (not readable)"}`).join("\\n");',
        '      const picked = window.prompt(',
        '        `Collections on this server:\\n\\n${menu}\\n\\nNumber to poll ` +',
        '        `(blank to re-run discovery):`, "1");',
        '      if (picked === null) return;',
        '      if (picked === "") {',
        '        await request(',
        '          "POST", `/api/feeds/${encodeURIComponent(row.id)}/discover`, {});',
        '        setText("statusMessage", "discovery queued");',
        '      } else {',
        '        const chosen = found.items[Number(picked) - 1];',
        '        if (!chosen) throw new Error(`no collection ${picked} in that list`);',
        '        await request("PATCH", `/api/feeds/${encodeURIComponent(row.id)}`, {',
        '          api_root: chosen.api_root, collection_id: chosen.collection_id,',
        '        });',
        '        setText("statusMessage", `polling ${chosen.title}`);',
        '      }',
        '    }',
        '  } else if (handler === "exportReport") {',
        '    const format = window.prompt("Format: json, csv or pdf", "csv") || "csv";',
        '    const result = await request(',
        '      "POST", `/api/reports/${encodeURIComponent(row.kind)}/export`, { format });',
        '    setText("statusMessage",',
        '            `exported ${result.bytes} bytes to ${result.object_key}`);',
        '  }',
        '  await loadPage(currentView());',
        '} catch (error) {',
        '  // Surfaced, never swallowed: an analyst has to know the action did not happen.',
        '  setText("statusMessage", `${handler} failed: ${error.message}`);',
        '}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'currentView',
      returns: 'string',
      doc: 'Which screen this is, from the filename. The page owns the body element, so there is nowhere to stamp an attribute.',
      language: 'javascript',
      implName: 'view_from_location',
      code: [
        'const page = location.pathname.split("/").pop() || "index.html";',
        'return page.replace(/\\.html$/, "") || "index";',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'submitLogin',
      params: [{ name: 'step', type: 'string' }],
      returns: 'Any',
      doc: [
        'The two-step sign-in.',
        '',
        'The password step returns a session that carries no permissions at all; the',
        'MFA step replaces it with one that does. Keeping them as two calls is what',
        'makes MFA mandatory rather than advisory - there is no response from step one',
        'that is useful on its own.',
      ].join('\n'),
      language: 'javascript',
      isAsync: true,
      implName: 'perform_login_step',
      code: [
        'const error = byName("loginError");',
        'if (error) error.textContent = "";',
        '',
        'try {',
        '  if (step === "password") {',
        '    const result = await request("POST", "/api/auth/login", {',
        '      email: byName("loginEmail").value,',
        '      password: byName("loginPassword").value,',
        '    });',
        '    sessionStorage.setItem("soar.pending", result.session_id);',
        '    document.querySelector(".mfa-step")?.classList.add("is-active");',
        '',
        '    // First sign-in: the factor exists but nobody has ever produced a code',
        '    // from it. Show the QR once, here, rather than making an administrator',
        '    // read a secret out to someone over the phone.',
        '    if (result.enrolment) {',
        '      const step = document.querySelector(".enrol-step");',
        '      step?.classList.add("is-active");',
        '      const holder = byName("enrolQr");',
        '      if (holder) holder.innerHTML = result.enrolment.svg;',
        '      const grouped = (result.enrolment.secret.match(/.{1,4}/g) || []).join(" ");',
        '      setText("enrolSecret", `Cannot scan? Enter manually: ${grouped}`);',
        '    }',
        '',
        '    byName("loginCode")?.focus();',
        '    return result;',
        '  }',
        '',
        '  const granted = await request("POST", "/api/auth/mfa", {',
        '    session_id: sessionStorage.getItem("soar.pending"),',
        '    code: byName("loginCode").value,',
        '  });',
        '  // The session itself rides in an HttpOnly cookie the browser returns on',
        '  // its own. This is only the CSRF token, which has to be readable by',
        '  // script in order to be echoed back in a header.',
        '  try { sessionStorage.setItem("soar.csrf", granted.csrf || ""); } catch {}',
        '  sessionStorage.removeItem("soar.pending");',
        '  window.location.href = "/index.html";',
        '  return null;',
        '} catch (failure) {',
        '  // Deliberately the same message for an unknown account and a wrong',
        '  // password: the endpoint does not enumerate users and neither does this.',
        '  if (error) error.textContent = failure.message;',
        '  return null;',
        '}',
      ].join('\n'),
    });

    // -- handlers -----------------------------------------------------------
    const ready = g.add('dom/on-ready');
    const note = g.add('data/comment', {
      text: [
        'Thirteen list screens and a login page, from one descriptor table.',
        '',
        'They are the same screen pointed at different endpoints, so generating them',
        'from a table is not laziness - it is how they stay consistent. The screens',
        'that are NOT lists (dashboard, incident workspace, playbook editor,',
        'execution console) are written out in full instead.',
      ].join('\n'),
    });
    const boot = g.add('control/call', { target: 'bootPage', returns: 'Void' });
    g.chain([ready, 'out'], note, boot);

    const handlers: [string, string][] = [
      ['onPageFilter', 'refreshCurrentPage'],
      ['onPageRefresh', 'refreshCurrentPage'],
      ['onLoginPassword', 'loginWithPassword'],
      ['onLoginMfa', 'loginWithCode'],
      ['onCreateIncident', 'createIncident'],
      ['onCreateCase', 'createCase'],
      ['onCreatePlaybook', 'createPlaybook'],
      ['onInstallConnector', 'installConnector'],
      ['onAddIndicatorGlobal', 'addToIntelLibrary'],
      ['onAddClient', 'openNewClientPage'],
      ['onCreateCommand', 'openNewCommandPage'],
      ['onAddFeed', 'createFeed'],
      ['onLoadAttack', 'loadAttackData'],
    ];
    for (const [event, target] of handlers) {
      const handler = g.add('event/handler', { event, payloadType: 'Any', isAsync: true });
      const call = g.add('control/call', { target, returns: 'Void', await: true });
      g.connect(handler, 'payload', call, 'args');
      g.chain([handler, 'out'], call);
    }

    fnWithBody(g, {
      name: 'bootPage',
      returns: 'Any',
      doc: 'Restore the theme, load whichever list this is, and keep the status strip fresh.',
      language: 'javascript',
      isAsync: true,
      implName: 'start_list_page',
      code: [
        'let stored = null;',
        'try { stored = localStorage.getItem("soar.theme"); } catch { stored = null; }',
        'document.documentElement.setAttribute("data-theme",',
        '  stored || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));',
        '',
        'const view = currentView();',
        'if (view === "login") return null;',
        '',
        'await revealPermittedNav();',
        'await loadPage(view);',
        'setInterval(() => loadPage(view), 30000);',
        'return view;',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'refreshCurrentPage',
      params: [{ name: 'event', type: 'Any' }],
      returns: 'Any',
      doc: 'Reload after a filter change or a click on Refresh.',
      language: 'javascript',
      isAsync: true,
      implName: 'reload_current_page',
      code: 'return await loadPage(currentView());',
    });

    fnWithBody(g, {
      name: 'loginWithPassword',
      params: [{ name: 'event', type: 'Any' }],
      returns: 'Any',
      doc: 'Step one of sign-in.',
      language: 'javascript',
      isAsync: true,
      implName: 'login_step_password',
      code: 'return await submitLogin("password");',
    });

    fnWithBody(g, {
      name: 'loginWithCode',
      params: [{ name: 'event', type: 'Any' }],
      returns: 'Any',
      doc: 'Step two of sign-in: the code that actually grants the permissions.',
      language: 'javascript',
      isAsync: true,
      implName: 'login_step_mfa',
      code: 'return await submitLogin("mfa");',
    });

    fnWithBody(g, {
      name: 'feedFromPrompts',
      params: [{ name: 'url', type: 'string' }],
      returns: 'Any',
      doc: [
        'Collect what a feed needs, which depends on what kind of feed it is.',
        '',
        'A TAXII feed needs three more answers than a document feed, and both are',
        'asked for up front rather than discovered by failing: TAXII servers are',
        'nearly always authenticated, and a version mismatch answers 406 rather than',
        'negotiating down - which looks like an auth problem and is not one.',
      ].join('\n'),
      language: 'javascript',
      implName: 'collect_feed_fields',
      code: [
        'const name = window.prompt("Name", url) || url;',
        'const format = window.prompt(',
        '  "Format: auto, taxii, misp, stix, csv", "auto") || "auto";',
        'if (format !== "taxii") return { url, name, format };',
        '',
        'const auth_kind = window.prompt(',
        '  "Auth: none, basic, bearer or header", "basic") || "none";',
        'const credential = auth_kind === "none"',
        '  ? null',
        '  : window.prompt("Credential name (created under Administration)");',
        'const taxii_version = window.prompt(',
        '  "TAXII version: 2.1 or 2.0", "2.1") || "2.1";',
        '',
        '// The collection is chosen after discovery, not here: the server names its',
        '// collections by uuid, and nobody can type one they have not been shown.',
        'return { url, name, format, auth_kind, credential, taxii_version };',
      ].join('\n'),
    });

    for (const [name, prompt, method, path, build] of [
      ['createIncident', 'Incident title', 'POST', '/api/incidents',
       '{ title: value, severity: window.prompt("Severity", "medium") || "medium" }'],
      ['createCase', 'Case title', 'POST', '/api/cases',
       '{ title: value, template: window.prompt("Template: phishing, malware, account_compromise", "phishing") }'],
      ['createPlaybook', 'Playbook name', 'POST', '/api/playbooks',
       '{ name: value, key: value.toLowerCase().replace(/[^a-z0-9]+/g, "_") }'],
      ['installConnector', 'Connector id (e.g. crowdstrike.falcon)', 'POST', '/api/integrations',
       '{ connector_id: value, credential: window.prompt("Credential name") || "", config: {} }'],
      ['addToIntelLibrary', 'Indicator value', 'POST', '/api/indicators',
       '{ value, type: "auto" }'],
      ['createFeed', 'Feed URL (a TAXII discovery endpoint, or a document)',
       'POST', '/api/feeds', 'feedFromPrompts(value)'],
    ] as [string, string, string, string, string][]) {
      fnWithBody(g, {
        name,
        params: [{ name: 'event', type: 'Any' }],
        returns: 'Any',
        doc: `Create from the toolbar. Prompts rather than a modal: these are one-field creations, and a dialog that collects one string is a dialog nobody thanks you for.`,
        language: 'javascript',
        isAsync: true,
        implName: `${name}_from_toolbar`,
        code: [
          `const value = window.prompt(${JSON.stringify(prompt)});`,
          'if (!value) return null;',
          'try {',
          `  const created = await request(${JSON.stringify(method)}, ${JSON.stringify(path)}, ${build});`,
          '  await loadPage(currentView());',
          '  return created;',
          '} catch (error) {',
          '  setText("statusMessage", `create failed: ${error.message}`);',
          '  return null;',
          '}',
        ].join('\n'),
      });
    }

    fnWithBody(g, {
      name: 'loadAttackData',
      params: [{ name: 'event', type: 'Any' }],
      returns: 'Any',
      doc: [
        'Load MITRE ATT&CK reference data.',
        '',
        'Offers the upload as well as the fetch, because a SOC platform with no',
        'internet egress is normal rather than exceptional, and an ATT&CK loader that',
        'only knows how to reach GitHub is one those installations cannot use.',
      ].join('\n'),
      language: 'javascript',
      isAsync: true,
      implName: 'load_attack_from_toolbar',
      code: [
        'const current = await request("GET", "/api/mitre/status");',
        'const summary = current.loaded',
        '  ? `${current.techniques} techniques loaded ${current.loaded_at}`',
        '  : "no ATT&CK data loaded yet";',
        'if (!window.confirm(`${summary}\\n\\nFetch the current ATT&CK bundle now?\\n` +',
        '                    "Cancel to upload a bundle file instead.")) {',
        '  const picker = document.createElement("input");',
        '  picker.type = "file";',
        '  picker.accept = "application/json,.json";',
        '  const chosen = await new Promise((resolve) => {',
        '    picker.onchange = () => resolve(picker.files && picker.files[0]);',
        '    picker.click();',
        '  });',
        '  if (!chosen) return null;',
        '  try {',
        '    const bundle = JSON.parse(await chosen.text());',
        '    const result = await request("POST", "/api/mitre/load", { bundle });',
        '    setText("statusMessage", `loaded ${result.loaded} techniques`);',
        '    return result;',
        '  } catch (error) {',
        '    setText("statusMessage", `bundle rejected: ${error.message}`);',
        '    return null;',
        '  }',
        '}',
        '',
        'try {',
        '  const domain = window.prompt("Domain: enterprise, mobile or ics",',
        '                               "enterprise") || "enterprise";',
        '  await request("POST", "/api/mitre/load", { domain });',
        '  setText("statusMessage",',
        '          `${domain} bundle queued; a worker fetches and loads it`);',
        '  return true;',
        '} catch (error) {',
        '  setText("statusMessage", `ATT&CK load failed: ${error.message}`);',
        '  return null;',
        '}',
      ].join('\n'),
    });

    fnWithBody(g, {
      name: 'openNewClientPage',
      params: [{ name: 'event', type: 'Any' }],
      returns: 'Any',
      doc: 'Onboarding is a form on its own page. A browser prompt asks one question, cannot be corrected, and cannot show what has already been chosen.',
      language: 'javascript',
      implName: 'go_to_new_client',
      code: 'window.location.href = "/client-new.html";',
    });

    fnWithBody(g, {
      name: 'openNewCommandPage',
      params: [{ name: 'event', type: 'Any' }],
      returns: 'Any',
      doc: 'Writing a command is a name, a key, an execution mode, an input and output schema, a risk classification and a list of clients. None of that fits in a browser prompt.',
      language: 'javascript',
      implName: 'go_to_new_command',
      code: 'window.location.href = "/command-new.html";',
    });

    fnWithBody(g, {
      name: 'revealPermittedNav',
      returns: 'Any',
      doc: [
        'Show the rail items this session can actually open.',
        '',
        'Every item is rendered hidden and revealed here, rather than rendered and',
        'then removed: a rail that flashes the full menu before hiding half of it',
        'has still told the analyst what exists. The server checks the permission',
        'again on every request - this only stops the navigation being a list of',
        'things that answer 403.',
      ].join('\n'),
      language: 'javascript',
      isAsync: true,
      implName: 'unhide_permitted_nav',
      code: [
        'let held = [];',
        'try {',
        '  const me = await request("GET", "/api/me");',
        '  held = me.permissions || [];',
        '  if (me.client_name) setText("activeClient", me.client_name);',
        '} catch (error) {',
        '  return null;  // request() has already sent an unauthenticated user to login',
        '}',
        '',
        'for (const item of document.querySelectorAll("[data-permission]")) {',
        '  if (held.includes(item.getAttribute("data-permission"))) item.hidden = false;',
        '}',
        'return held.length;',
      ].join('\n'),
    });

    exports_(pages.file, [
      { name: 'revealPermittedNav', sort: 'function' },
      { name: 'openNewClientPage', sort: 'function' },
      { name: 'openNewCommandPage', sort: 'function' },
      { name: 'feedFromPrompts', sort: 'function' },
      { name: 'pageDescriptors', sort: 'function' },
      { name: 'loadPage', sort: 'function' },
      { name: 'renderPageRows', sort: 'function' },
      { name: 'formatCell', sort: 'function' },
      { name: 'pageAction', sort: 'function' },
      { name: 'currentView', sort: 'function' },
      { name: 'submitLogin', sort: 'function' },
      { name: 'bootPage', sort: 'function' },
    ]);
    bindMarkupHandlers(g);
    publishToRegistry(g, ['pageDescriptors', 'loadPage', 'renderPageRows', 'formatCell',
      'pageAction', 'currentView', 'submitLogin', 'feedFromPrompts',
      'revealPermittedNav']);

    pages.file.imports.push({
      to: web.apiClient.id,
      scope: 'file',
      symbols: ['request', 'setText', 'byName', 'formatDuration'],
      generated: true,
    });
  }

  // ===========================================================================
  // The pages themselves
  // ===========================================================================
  const scripts = [web.apiClient.id, pages.file.id];
  for (const spec of PAGES) {
    addFile(ctx.project, {
      path: `${spec.view}.html`,
      language: 'html',
      role: 'source',
      options: { ui: listDoc(spec, web.style.id, scripts) },
    });
  }
  addFile(ctx.project, {
    path: 'login.html',
    language: 'html',
    role: 'source',
    options: { ui: loginDoc(web.style.id, scripts) },
  });
}
