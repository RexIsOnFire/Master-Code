/**
 * The UI builder.
 *
 * A UI document is a tree, not a control-flow graph, so it is edited directly
 * rather than through nodes: pick a widget, change its text, classes, styles,
 * attributes, and wire its events to handlers in the logic graph.
 *
 * The document is the source of truth and the server owns it, exactly as with
 * graphs. Every edit sends the whole document back through `file.setUi`, which
 * means edits are saved, undoable, and the preview is regenerated from the same
 * document the HTML backend will emit — never from a separate render path that
 * could disagree with the generated page.
 */

const $ = (id) => document.getElementById(id);

/** Widgets offered in the Add menu, grouped the way the model groups them. */
const WIDGETS = {
  containers: ['panel', 'container', 'row', 'column', 'grid', 'form', 'card', 'scroll', 'tabs', 'dialog'],
  content: ['heading', 'paragraph', 'label', 'link', 'image', 'icon', 'divider', 'code'],
  input: ['button', 'textbox', 'textarea', 'checkbox', 'radio', 'select', 'slider', 'number', 'date', 'file'],
  collections: ['list', 'table', 'tree', 'menu'],
  other: ['raw'],
};

/** Widgets that hold other widgets; only these accept a child. */
const CONTAINERS = new Set(WIDGETS.containers);

/** A sensible starting point per widget, so a new one is visible immediately. */
function defaultsFor(kind) {
  if (kind === 'heading') return { text: 'Heading' };
  if (kind === 'paragraph') return { text: 'Some text.' };
  if (kind === 'label') return { text: 'Label' };
  if (kind === 'button') return { text: 'Button' };
  if (kind === 'link') return { text: 'Link', attrs: { href: '#' } };
  if (kind === 'image') return { attrs: { src: '', alt: '' } };
  if (kind === 'textbox' || kind === 'textarea') return { attrs: { placeholder: '' } };
  if (kind === 'select' || kind === 'list') return { items: ['One', 'Two'] };
  if (kind === 'raw') return { raw: '<!-- markup -->' };
  return {};
}

export class UiBuilder {
  /**
   * @param {object} api
   * @param {() => object|null} api.document   the open file's UI document, or null
   * @param {(doc: object) => Promise<void>} api.save
   * @param {() => string} api.preview         generated HTML for the open file
   * @param {() => string[]} api.handlers      event handler names from the logic graph
   * @param {(text: string, kind?: string) => void} api.toast
   */
  constructor(api) {
    this.api = api;
    this.selectedId = null;
    /** 'widget' inspects the selection; 'styles' edits the stylesheet. */
    this.tab = 'widget';
    this.#bind();
  }

  render() {
    const doc = this.api.document();
    const tree = $('uiTree');
    const inspector = $('uiInspector');
    if (!doc) {
      tree.innerHTML =
        '<div class="empty">This file has no UI document.<br><br>Create an HTML file to use the designer.</div>';
      inspector.innerHTML = '';
      $('uiPreview').srcdoc = '';
      return;
    }

    this.#renderTree(doc);
    this.#renderTabs();
    if (this.tab === 'styles') this.#renderStyles(doc);
    else this.#renderInspector(doc);
    this.#renderPreview();
  }

  /**
   * Widget inspector or stylesheet, in the same pane.
   *
   * Inline styles belong to one widget and live in the inspector; a stylesheet
   * rule applies across the page and does not, so they are separate views
   * rather than one long panel.
   */
  #renderTabs() {
    const host = $('uiInspector');
    host.innerHTML = '';
    const tabs = document.createElement('div');
    tabs.className = 'scope-switch';
    for (const [id, label] of [
      ['widget', 'Widget'],
      ['styles', 'Stylesheet'],
    ]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.className = this.tab === id ? 'on' : '';
      button.onclick = () => {
        this.tab = id;
        this.render();
      };
      tabs.append(button);
    }
    host.append(tabs);
  }

  // -------------------------------------------------------------------------

  #renderTree(doc) {
    const tree = $('uiTree');
    tree.innerHTML = '';
    if (!doc.root.length) {
      tree.innerHTML = '<div class="empty">Empty page. Choose a widget and press Add.</div>';
      return;
    }
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        const row = document.createElement('div');
        row.className = `ui-node${node.id === this.selectedId ? ' selected' : ''}`;
        row.style.paddingLeft = `${10 + depth * 12}px`;
        const label = node.name || node.text || node.attrs?.src || node.id;
        row.innerHTML = `<span class="tag">${escape(node.kind)}</span><span>${escape(label)}</span>`;
        row.onclick = () => {
          this.selectedId = node.id;
          this.render();
        };
        tree.append(row);
        if (node.children?.length) walk(node.children, depth + 1);
      }
    };
    walk(doc.root, 0);
  }

  #renderPreview() {
    const html = this.api.preview();
    const width = $('uiWidth').value;
    const frame = $('uiPreview');
    // A width is applied to the frame rather than injected into the page, so
    // the preview exercises the real stylesheet at that viewport instead of a
    // doctored copy of it.
    frame.style.width = width ? `${width}px` : '100%';
    frame.style.margin = width ? '0 auto' : '0';
    frame.srcdoc = html || '<p style="font:14px sans-serif;padding:20px">Generate to preview.</p>';
  }

  #renderInspector(doc) {
    const host = $('uiInspector');
    const found = find(doc.root, this.selectedId);
    if (!found) {
      // Append, never assign: the tab bar is already in this pane.
      host.insertAdjacentHTML('beforeend', '<div class="empty">Select a widget to edit it.</div>');
      this.#pageFields(host, doc);
      return;
    }
    const node = found.node;

    const field = (label, value, commit, { multiline = false } = {}) => {
      const wrap = document.createElement('div');
      wrap.className = 'ui-field';
      wrap.innerHTML = `<label>${escape(label)}</label>`;
      const input = document.createElement(multiline ? 'textarea' : 'input');
      if (!multiline) input.type = 'text';
      input.value = value ?? '';
      // Commit on change, not on every keystroke: each one is a round trip and
      // an undo entry.
      input.onchange = () => void commit(input.value);
      wrap.append(input);
      host.append(wrap);
      return input;
    };

    host.insertAdjacentHTML('beforeend', `<div class="prop-section">${escape(node.kind)}</div>`);

    field('Name (element id)', node.name, (v) => this.#update(node, (n) => (n.name = v || undefined)));
    if (node.kind === 'raw') {
      field('Markup', node.raw, (v) => this.#update(node, (n) => (n.raw = v)), { multiline: true });
    } else {
      field('Text', node.text, (v) => this.#update(node, (n) => (n.text = v || undefined)), {
        multiline: (node.text ?? '').length > 40,
      });
    }
    field('Classes (space separated)', (node.classes ?? []).join(' '), (v) =>
      this.#update(node, (n) => {
        const list = v.split(/\s+/).filter(Boolean);
        n.classes = list.length ? list : undefined;
      }),
    );
    if (node.items || node.kind === 'select' || node.kind === 'list') {
      field('Items (one per line)', (node.items ?? []).join('\n'), (v) =>
        this.#update(node, (n) => {
          const list = v.split('\n').map((s) => s.trim()).filter(Boolean);
          n.items = list.length ? list : undefined;
        }),
        { multiline: true },
      );
    }

    this.#pairs(host, 'Attributes', node.attrs ?? {}, (next) =>
      this.#update(node, (n) => (n.attrs = Object.keys(next).length ? next : undefined)),
    );
    this.#pairs(host, 'Inline style', node.style ?? {}, (next) =>
      this.#update(node, (n) => (n.style = Object.keys(next).length ? next : undefined)),
      { keyPlaceholder: 'color', valuePlaceholder: '#333' },
    );
    this.#events(host, node);
  }

  /** Editable key/value list, used for attributes and inline styles. */
  #pairs(host, title, record, commit, { keyPlaceholder = 'name', valuePlaceholder = 'value' } = {}) {
    host.insertAdjacentHTML('beforeend', `<div class="prop-section">${escape(title)}</div>`);
    const box = document.createElement('div');
    box.className = 'ui-pairs';

    const entries = Object.entries(record);
    const emit = () => {
      const next = {};
      for (const row of box.querySelectorAll('.pair')) {
        const [k, v] = row.querySelectorAll('input');
        if (k.value.trim()) next[k.value.trim()] = v.value;
      }
      void commit(next);
    };

    const addRow = (key = '', value = '') => {
      const row = document.createElement('div');
      row.className = 'pair';
      const k = document.createElement('input');
      k.type = 'text';
      k.placeholder = keyPlaceholder;
      k.value = key;
      const v = document.createElement('input');
      v.type = 'text';
      v.placeholder = valuePlaceholder;
      v.value = String(value);
      const remove = document.createElement('button');
      remove.textContent = '✕';
      remove.onclick = () => {
        row.remove();
        emit();
      };
      k.onchange = emit;
      v.onchange = emit;
      row.append(k, v, remove);
      box.append(row);
    };

    for (const [k, v] of entries) addRow(k, v);
    host.append(box);

    const add = document.createElement('button');
    add.className = 'btn tiny ghost';
    add.textContent = '+ add';
    add.onclick = () => addRow();
    host.append(add);
  }

  /**
   * Event bindings.
   *
   * The handler list comes from the project's symbols, so this is a choice
   * between handlers that exist rather than a free-text field that fails at
   * generation. That is the join between the UI tree and the logic graph.
   */
  #events(host, node) {
    host.insertAdjacentHTML('beforeend', '<div class="prop-section">Events</div>');
    const handlers = this.api.handlers();
    const bindings = node.events ?? [];

    const emit = (next) => this.#update(node, (n) => (n.events = next.length ? next : undefined));

    for (const [i, binding] of bindings.entries()) {
      const row = document.createElement('div');
      row.className = 'pair';
      const event = document.createElement('input');
      event.type = 'text';
      event.value = binding.event;
      event.placeholder = 'click';
      const handler = document.createElement('select');
      handler.innerHTML =
        '<option value="">(choose a handler)</option>' +
        handlers.map((h) => `<option value="${escape(h)}">${escape(h)}</option>`).join('');
      if (binding.handler && !handlers.includes(binding.handler)) {
        handler.insertAdjacentHTML('beforeend', `<option value="${escape(binding.handler)}">${escape(binding.handler)} · not found</option>`);
      }
      handler.value = binding.handler ?? '';
      const remove = document.createElement('button');
      remove.textContent = '✕';

      const commit = () => {
        const next = bindings.map((b, j) =>
          j === i ? { event: event.value.trim() || 'click', handler: handler.value } : b,
        );
        emit(next.filter((b) => b.handler));
      };
      event.onchange = commit;
      handler.onchange = commit;
      remove.onclick = () => emit(bindings.filter((_, j) => j !== i));

      row.append(event, handler, remove);
      host.append(row);
    }

    const add = document.createElement('button');
    add.className = 'btn tiny ghost';
    add.textContent = '+ event';
    add.onclick = () => {
      if (!handlers.length) {
        this.api.toast('Add an Event Handler node to the behaviour graph first.', 'warn');
        return;
      }
      emit([...bindings, { event: 'click', handler: handlers[0] }]);
    };
    host.append(add);
  }

  /** Page-level settings, shown when nothing is selected. */
  /**
   * The stylesheet: the rules the CSS backend emits.
   *
   * These are the document's own rules, not inline styles — the CSS backend
   * collects them into the linked stylesheet, so this is where anything
   * reusable or responsive belongs. Without it a project's stylesheet was
   * frozen at whatever its template created.
   */
  #renderStyles(doc) {
    const host = $('uiInspector');
    const rules = doc.rules ?? [];
    const breakpoints = doc.breakpoints ?? [];

    const save = (next) => {
      const copy = clone(doc);
      copy.rules = next;
      return this.api.save(copy);
    };

    host.insertAdjacentHTML(
      'beforeend',
      `<div class="prop-section">Rules (${rules.length})</div>`,
    );
    if (!rules.length) {
      host.insertAdjacentHTML(
        'beforeend',
        '<div class="empty">No rules yet. Add one, or select a widget and use "rule for selection".</div>',
      );
    }

    for (const [i, rule] of rules.entries()) {
      const box = document.createElement('div');
      box.className = 'ui-rule';

      const head = document.createElement('div');
      head.className = 'pair';
      const selector = document.createElement('input');
      selector.type = 'text';
      selector.value = rule.selector;
      selector.placeholder = '.card h2';
      const remove = document.createElement('button');
      remove.textContent = '✕';
      remove.title = 'Delete this rule';
      remove.onclick = () => void save(rules.filter((_, j) => j !== i));
      head.append(selector, remove);
      box.append(head);

      // Media query, chosen from the document's breakpoints rather than typed.
      // A responsive rule that does not match a declared breakpoint is almost
      // always a typo, and the list is what the CSS backend groups by.
      const media = document.createElement('select');
      media.innerHTML = '<option value="">all widths</option>';
      for (const bp of breakpoints) {
        const query = mediaQueryFor(bp);
        const option = document.createElement('option');
        option.value = query;
        option.textContent = `${bp.name} — ${query}`;
        media.append(option);
      }
      if (rule.media && !breakpoints.some((b) => mediaQueryFor(b) === rule.media)) {
        media.insertAdjacentHTML('beforeend', `<option value="${escape(rule.media)}">${escape(rule.media)}</option>`);
      }
      media.value = rule.media ?? '';
      box.append(media);

      // Declarations as text: CSS authors think in `property: value;` lines,
      // and a key/value grid for a whole rule fights that.
      const declarations = document.createElement('textarea');
      declarations.value = Object.entries(rule.declarations ?? {})
        .map(([property, value]) => `${property}: ${value};`)
        .join('\n');
      declarations.placeholder = 'color: #333;\nfont-weight: 600;';
      box.append(declarations);

      const commit = () => {
        const next = rules.map((r, j) =>
          j === i
            ? {
                ...r,
                selector: selector.value.trim() || r.selector,
                media: media.value || undefined,
                declarations: parseDeclarations(declarations.value),
              }
            : r,
        );
        void save(next);
      };
      selector.onchange = commit;
      media.onchange = commit;
      declarations.onchange = commit;

      host.append(box);
    }

    const actions = document.createElement('div');
    actions.className = 'ui-rule-actions';

    const add = document.createElement('button');
    add.className = 'btn tiny';
    add.textContent = '+ rule';
    add.onclick = () => void save([...rules, { selector: '.new-rule', declarations: {} }]);
    actions.append(add);

    // A rule for the selected widget, with the selector already right — the
    // most common reason to open this panel at all.
    const selected = find(doc.root, this.selectedId);
    if (selected) {
      const forSelection = document.createElement('button');
      forSelection.className = 'btn tiny ghost';
      forSelection.textContent = 'rule for selection';
      forSelection.onclick = () => {
        const node = selected.node;
        const selector = node.classes?.length
          ? `.${node.classes[0]}`
          : node.name
            ? `#${node.name}`
            : node.kind;
        void save([...rules, { selector, declarations: {} }]);
      };
      actions.append(forSelection);
    }
    host.append(actions);
  }

  #pageFields(host, doc) {
    host.insertAdjacentHTML('beforeend', '<div class="prop-section">Page</div>');
    const wrap = document.createElement('div');
    wrap.className = 'ui-field';
    wrap.innerHTML = '<label>Title</label>';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = doc.title ?? '';
    input.onchange = () => {
      const next = clone(doc);
      next.title = input.value;
      void this.api.save(next);
    };
    wrap.append(input);
    host.append(wrap);
  }

  // -------------------------------------------------------------------------

  /** Applies `mutate` to the selected node and saves the whole document. */
  #update(node, mutate) {
    const doc = clone(this.api.document());
    const found = find(doc.root, node.id);
    if (!found) return;
    mutate(found.node);
    return this.api.save(doc);
  }

  #add() {
    const doc = clone(this.api.document());
    if (!doc) return;
    const kind = $('uiAddKind').value;
    const node = { id: newId(), kind, ...defaultsFor(kind) };
    if (CONTAINERS.has(kind)) node.children = [];

    const found = this.selectedId ? find(doc.root, this.selectedId) : null;
    if (found && CONTAINERS.has(found.node.kind)) {
      // Adding into a container puts it inside; anything else puts it after,
      // which is what you want when you have just selected a button.
      found.node.children = [...(found.node.children ?? []), node];
    } else if (found) {
      found.siblings.splice(found.index + 1, 0, node);
    } else {
      doc.root.push(node);
    }
    this.selectedId = node.id;
    return this.api.save(doc);
  }

  #move(delta) {
    const doc = clone(this.api.document());
    const found = this.selectedId ? find(doc.root, this.selectedId) : null;
    if (!found) return;
    const to = found.index + delta;
    if (to < 0 || to >= found.siblings.length) return;
    const [node] = found.siblings.splice(found.index, 1);
    found.siblings.splice(to, 0, node);
    return this.api.save(doc);
  }

  #remove() {
    const doc = clone(this.api.document());
    const found = this.selectedId ? find(doc.root, this.selectedId) : null;
    if (!found) return;
    found.siblings.splice(found.index, 1);
    this.selectedId = null;
    return this.api.save(doc);
  }

  #bind() {
    const select = $('uiAddKind');
    for (const [group, kinds] of Object.entries(WIDGETS)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group;
      for (const kind of kinds) {
        const option = document.createElement('option');
        option.value = kind;
        option.textContent = kind;
        optgroup.append(option);
      }
      select.append(optgroup);
    }
    select.value = 'button';

    $('uiAdd').onclick = () => void this.#add();
    $('uiUp').onclick = () => void this.#move(-1);
    $('uiDown').onclick = () => void this.#move(1);
    $('uiDelete').onclick = () => void this.#remove();
    $('uiWidth').onchange = () => this.#renderPreview();
  }
}

// ---------------------------------------------------------------------------

/** Finds a node and where it sits, so callers can move or remove it. */
function find(nodes, id, parent = null) {
  if (!id) return null;
  for (const [index, node] of nodes.entries()) {
    if (node.id === id) return { node, siblings: nodes, index, parent };
    if (node.children) {
      const inner = find(node.children, id, node);
      if (inner) return inner;
    }
  }
  return null;
}

function clone(doc) {
  return doc ? JSON.parse(JSON.stringify(doc)) : doc;
}

function newId() {
  return `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function escape(text) {
  return String(text ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}

/** Mirrors `mediaQueryFor` in the CSS backend, so the two agree on grouping. */
function mediaQueryFor(bp) {
  const parts = [];
  if (bp.minWidth) parts.push(`(min-width: ${bp.minWidth}px)`);
  if (bp.maxWidth) parts.push(`(max-width: ${bp.maxWidth}px)`);
  return parts.join(' and ') || 'all';
}

/**
 * Reads `property: value;` lines into a declaration record.
 *
 * Lenient on purpose: a trailing semicolon is optional, blank lines are
 * ignored, and a line without a colon is skipped rather than throwing. Someone
 * mid-edit should not lose the rest of the rule to one malformed line.
 */
function parseDeclarations(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim().replace(/;$/, '');
    if (!trimmed) continue;
    const at = trimmed.indexOf(':');
    if (at <= 0) continue;
    const property = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (property && value) out[property] = value;
  }
  return out;
}
