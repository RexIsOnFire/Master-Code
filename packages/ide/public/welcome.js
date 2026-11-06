/**
 * The welcome screen and the New Project flow.
 *
 * This is the first thing anyone sees, and it is the reason none of the setup
 * needs a terminal. It answers three questions before asking anything: what is
 * this, what can this machine build, and what was I working on.
 *
 * The language step shows what the machine can actually do rather than a flat
 * list. "Rust generates idiomatic source but cargo is not installed" and "Rust
 * is not supported" are very different, and picking a language you cannot run
 * should be a decision, not a surprise three screens later.
 */

const $ = (id) => document.getElementById(id);

const STEPS = [
  'welcomeStart',
  'welcomeLanguage',
  'welcomeTemplate',
  'welcomeChallenges',
  'welcomeDetails',
  'welcomeBrowse',
];

export class Welcome {
  /**
   * @param {object} api
   * @param {(command: string, args?: object) => Promise<any>} api.call
   * @param {(result: object) => Promise<void>} api.onProjectReady  hands over once a project is open
   * @param {(text: string, kind?: string) => void} api.toast
   */
  constructor(api) {
    this.call = api.call;
    this.onProjectReady = api.onProjectReady;
    this.toast = api.toast ?? (() => {});

    this.data = null;
    this.language = null;
    this.template = null;
    /** Set when the flow is starting a challenge rather than a template. */
    this.challenge = null;
    /** Where the folder picker should return to, and what it should do. */
    this.browseReturn = null;
    this.browsePurpose = 'location';

    this.#bind();
  }

  // -------------------------------------------------------------------------

  /** Opens the welcome screen. `closable` is false when no project is open. */
  async open({ closable = true } = {}) {
    $('welcome').hidden = false;
    $('welcomeClose').hidden = !closable;
    this.#step('welcomeStart');

    if (!this.data) {
      $('welcomeToolchains').innerHTML = '<div class="welcome-note">Checking this machine…</div>';
      this.data = await this.call('workspace.welcome');
    }
    $('welcomeNode').textContent = `Node ${this.data.node}`;
    this.#renderToolchains();
    this.#renderRecent();
  }

  close() {
    $('welcome').hidden = true;
  }

  /** Jumps straight to the language step, for File → New Project. */
  async openNew() {
    await this.open({ closable: true });
    this.#renderLanguages();
    this.#step('welcomeLanguage');
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  #step(id) {
    for (const step of STEPS) $(step).classList.toggle('active', step === id);
  }

  #renderToolchains() {
    const host = $('welcomeToolchains');
    host.innerHTML = '';
    for (const lang of this.data.languages) {
      const row = document.createElement('div');
      row.className = 'toolchain';
      const [tag, cls] = tagFor(lang);
      row.innerHTML = `
        <span class="lang">${escape(lang.name)}</span>
        <span class="tag ${cls}">${tag}</span>
        <span class="detail">${escape(detailFor(lang))}</span>`;
      host.append(row);
    }
  }

  #renderRecent() {
    const host = $('welcomeRecent');
    host.innerHTML = '';
    for (const entry of this.data.recent ?? []) {
      const row = document.createElement('div');
      row.className = `recent${entry.exists ? '' : ' missing'}`;
      row.innerHTML = `
        <span class="name">${escape(entry.name)}</span>
        <span class="path">${escape(entry.path)}</span>
        <button class="forget" title="Remove from this list">×</button>`;
      row.onclick = (e) => {
        if (e.target.classList.contains('forget')) return;
        if (!entry.exists) {
          this.toast('That folder is no longer there.', 'warn');
          return;
        }
        void this.#openPath(entry.path);
      };
      row.querySelector('.forget').onclick = async (e) => {
        e.stopPropagation();
        const result = await this.call('workspace.forget', { path: entry.path });
        this.data.recent = result.recent;
        this.#renderRecent();
      };
      host.append(row);
    }
  }

  #renderLanguages() {
    const host = $('languageCards');
    host.innerHTML = '';
    // Ready-to-build languages first: the ordering is the recommendation.
    const languages = [...this.data.languages].sort(
      (a, b) => Number(b.ready) - Number(a.ready) || b.templates.length - a.templates.length,
    );
    for (const lang of languages) {
      const card = document.createElement('button');
      card.className = 'card';
      const [tag, cls] = tagFor(lang);
      const usable = lang.templates.length > 0;
      card.disabled = !usable;
      card.innerHTML = `
        <div class="card-head">
          <span class="card-title">${escape(lang.name)}</span>
          <span class="tag ${cls}">${tag}</span>
        </div>
        <div class="card-body">${escape(detailFor(lang))}</div>
        <div class="card-foot">${
          usable
            ? `${lang.templates.length} starting point${lang.templates.length === 1 ? '' : 's'}`
            : 'no starting point yet — add a file to an existing project instead'
        }</div>`;
      card.onclick = () => {
        this.language = lang;
        if (this.mode === 'learn') {
          void this.#renderChallenges();
          this.#step('welcomeChallenges');
          return;
        }
        this.#renderTemplates();
        this.#step('welcomeTemplate');
      };
      host.append(card);
    }
  }

  #renderTemplates() {
    $('templateForLanguage').textContent = `for ${this.language.name}`;
    const host = $('templateCards');
    host.innerHTML = '';
    for (const template of this.language.templates) {
      const card = document.createElement('button');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-head"><span class="card-title">${escape(template.title)}</span></div>
        <div class="card-body">${escape(template.description ?? '')}</div>
        <div class="card-foot">${escape((template.outline ?? []).join(' · '))}</div>`;
      card.onclick = () => {
        this.template = template;
        this.#prepareDetails();
        this.#step('welcomeDetails');
      };
      host.append(card);
    }
  }

  #prepareDetails() {
    const what = this.challenge ?? this.template;
    $('detailsSummary').textContent = `${this.language.name} · ${what.title}`;
    const name = $('newProjectName');
    name.value = this.challenge ? folderName(this.challenge.title) : name.value || suggestName(this.template);
    const location = $('newProjectLocation');
    if (!location.value) location.value = this.data.suggestedRoot;
    this.#updatePreview();
    setTimeout(() => {
      name.focus();
      name.select();
    }, 0);
  }

  #updatePreview() {
    const name = $('newProjectName').value.trim();
    const location = $('newProjectLocation').value.trim();
    const folder = folderName(name);
    const sep = location.includes('/') && !location.includes('\\') ? '/' : '\\';
    $('createPreview').textContent = folder
      ? `Creates ${location}${sep}${folder}`
      : 'Enter a name to continue.';
    $('createProject').disabled = !folder || !location;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async #create() {
    const name = $('newProjectName').value.trim();
    const path = $('newProjectLocation').value.trim();
    const button = $('createProject');
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const result = this.challenge
        ? await this.call('learn.start', { id: this.challenge.id, language: this.language.id, name, path })
        : await this.call('project.create', { template: this.template.id, name, path });
      this.data = null; // recents changed
      this.close();
      await this.onProjectReady(result);
      this.toast(`Created ${name}.`, 'ok');
    } catch (err) {
      this.toast(String(err.message ?? err), 'error');
    } finally {
      button.textContent = 'Create project';
      this.#updatePreview();
    }
  }

  async #openPath(path) {
    try {
      const result = await this.call('project.open', { path });
      this.data = null;
      this.close();
      await this.onProjectReady(result);
    } catch (err) {
      this.toast(String(err.message ?? err), 'error');
    }
  }

  /**
   * The challenge list.
   *
   * Language first, because a challenge is offered per language and the list
   * depends on what that backend can express — asking afterwards would mean
   * showing challenges that then disappear.
   */
  async #openLearn() {
    // Reuse the language step, but remember that a challenge follows it.
    this.mode = 'learn';
    this.#renderLanguages();
    this.#step('welcomeLanguage');
  }

  async #renderChallenges() {
    $('challengeLanguage').textContent = `in ${this.language.name}`;
    const host = $('challengeCards');
    host.innerHTML = '<div class="welcome-note">Loading…</div>';

    const { challenges } = await this.call('learn.list', { language: this.language.id });
    host.innerHTML = '';
    for (const challenge of challenges) {
      const card = document.createElement('button');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-head">
          <span class="card-title">${escape(challenge.title)}</span>
          <span class="difficulty ${escape(challenge.difficulty)}">${escape(challenge.difficulty)}</span>
        </div>
        <div class="card-body">${escape(challenge.brief)}</div>`;
      card.onclick = () => {
        this.challenge = challenge;
        this.template = null;
        this.#prepareDetails();
        this.#step('welcomeDetails');
      };
      host.append(card);
    }
  }

  // -------------------------------------------------------------------------
  // Folder picker
  // -------------------------------------------------------------------------

  async #browse(purpose, startPath) {
    this.browsePurpose = purpose;
    this.browseReturn = document.querySelector('.welcome-step.active')?.id ?? 'welcomeStart';
    $('browseChoose').textContent = purpose === 'open' ? 'Open this project' : 'Use this folder';

    const places = $('browsePlaces');
    places.innerHTML = '';
    for (const place of this.data.places ?? []) {
      const button = document.createElement('button');
      button.textContent = place.label;
      button.onclick = () => void this.#listDir(place.path);
      places.append(button);
    }

    this.#step('welcomeBrowse');
    await this.#listDir(startPath || this.data.suggestedRoot);
  }

  async #listDir(path) {
    const listing = await this.call('workspace.browse', { path });
    this.browseCurrent = listing.path;
    this.browseParent = listing.parent;
    $('browsePath').value = listing.path;

    const host = $('browseList');
    host.innerHTML = '';
    if (listing.error) {
      host.innerHTML = `<div class="empty">${escape(listing.error)}</div>`;
      return;
    }
    if (!listing.entries.length) {
      host.innerHTML = '<div class="empty">No folders here.</div>';
      return;
    }
    for (const entry of listing.entries) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span>${escape(entry.name)}</span>${
        entry.isProject ? '<span class="is-project">project</span>' : ''
      }`;
      // One click steps in. Choosing is an explicit button, so stepping through
      // a project folder on the way somewhere else never opens it by accident.
      row.onclick = () => void this.#listDir(entry.path);
      host.append(row);
    }
  }

  async #chooseBrowsed() {
    const path = $('browsePath').value.trim() || this.browseCurrent;
    if (this.browsePurpose === 'open') {
      await this.#openPath(path);
      return;
    }
    $('newProjectLocation').value = path;
    this.#updatePreview();
    this.#step(this.browseReturn === 'welcomeBrowse' ? 'welcomeDetails' : this.browseReturn);
  }

  // -------------------------------------------------------------------------

  #bind() {
    $('welcomeNew').onclick = () => {
      this.mode = 'template';
      this.#renderLanguages();
      this.#step('welcomeLanguage');
    };
    $('welcomeLearn').onclick = () => void this.#openLearn();
    $('welcomeOpen').onclick = () => void this.#browse('open', this.data?.suggestedRoot);
    $('welcomeClose').onclick = () => this.close();

    for (const button of document.querySelectorAll('[data-welcome-back]')) {
      button.onclick = () => this.#step(button.dataset.welcomeBack);
    }

    $('newProjectName').oninput = () => this.#updatePreview();
    $('newProjectLocation').oninput = () => this.#updatePreview();
    $('newProjectName').onkeydown = (e) => {
      if (e.key === 'Enter' && !$('createProject').disabled) void this.#create();
    };
    $('createProject').onclick = () => void this.#create();
    $('browseLocation').onclick = () => void this.#browse('location', $('newProjectLocation').value);

    $('browseUp').onclick = () => {
      if (this.browseParent) void this.#listDir(this.browseParent);
    };
    $('browsePath').onkeydown = (e) => {
      if (e.key === 'Enter') void this.#listDir($('browsePath').value.trim());
    };
    $('browseCancel').onclick = () => this.#step(this.browseReturn ?? 'welcomeStart');
    $('browseChoose').onclick = () => void this.#chooseBrowsed();
  }
}

// ---------------------------------------------------------------------------

/** The badge on a language: what this machine can do with it, in one word. */
function tagFor(lang) {
  if (lang.maturity === 'stub') return ['stub', ''];
  if (lang.ready) return ['ready', 'ready'];
  return ['generates', 'partial'];
}

function detailFor(lang) {
  const missing = lang.tools.filter((t) => !t.available);
  if (!lang.tools.length) return 'Nothing to install — output is the source itself.';
  if (!missing.length) {
    const versions = lang.tools.map((t) => firstLine(t.version)).filter(Boolean);
    return versions.length ? `Builds and runs here. ${versions.join(', ')}` : 'Builds and runs here.';
  }
  return `Generates source. Install ${missing.map((t) => t.command).join(' and ')} to build it here.`;
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].trim();
}

/** Matches the server's folder rule, so the preview never lies. */
function folderName(projectName) {
  return projectName.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
}

function suggestName(template) {
  const kind = template.id.split('/')[1] ?? 'app';
  return `My${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

function escape(text) {
  return String(text ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}
