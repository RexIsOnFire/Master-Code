/**
 * HTML backend.
 *
 * HTML is markup, so its source of truth is the UI document tree rather than a
 * logic graph. The backend maps abstract widget kinds onto elements, wires
 * event bindings to handler functions in the accompanying script, and links the
 * stylesheets and scripts the file declares.
 *
 * A logic graph attached to an HTML file is not an error - it just means the
 * page has behaviour, which lives in the JavaScript file the document links.
 */

import type {
  BuildPlan,
  EmitContext,
  GeneratedFile,
  LanguageBackend,
  RunPlan,
} from './backend.ts';
import { defaultFeatures } from './backend.ts';
import { CodeWriter, htmlAttr, htmlEscape, kebab } from './emitter.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project, ProjectFile } from '../model/project.ts';
import type { UiDocument, UiNode, UiWidgetKind } from '../model/ui.ts';
import { emptyUiDocument } from '../model/ui.ts';
import type { TypeRef } from '../types/types.ts';

/** Widget kind -> element, plus whether it is void and its default attributes. */
const TAGS: Record<UiWidgetKind, { tag: string; void?: boolean; attrs?: Record<string, string>; textAs?: 'child' | 'value' }> = {
  window: { tag: 'main' },
  panel: { tag: 'section' },
  container: { tag: 'div' },
  row: { tag: 'div' },
  column: { tag: 'div' },
  grid: { tag: 'div' },
  form: { tag: 'form' },
  card: { tag: 'article' },
  scroll: { tag: 'div' },
  tabs: { tag: 'div' },
  dialog: { tag: 'dialog' },

  label: { tag: 'span' },
  heading: { tag: 'h2' },
  paragraph: { tag: 'p' },
  image: { tag: 'img', void: true },
  icon: { tag: 'span' },
  divider: { tag: 'hr', void: true },
  link: { tag: 'a' },
  code: { tag: 'pre' },

  button: { tag: 'button' },
  textbox: { tag: 'input', void: true, attrs: { type: 'text' }, textAs: 'value' },
  textarea: { tag: 'textarea' },
  checkbox: { tag: 'input', void: true, attrs: { type: 'checkbox' } },
  radio: { tag: 'input', void: true, attrs: { type: 'radio' } },
  select: { tag: 'select' },
  slider: { tag: 'input', void: true, attrs: { type: 'range' } },
  number: { tag: 'input', void: true, attrs: { type: 'number' }, textAs: 'value' },
  date: { tag: 'input', void: true, attrs: { type: 'date' }, textAs: 'value' },
  file: { tag: 'input', void: true, attrs: { type: 'file' } },

  list: { tag: 'ul' },
  table: { tag: 'table' },
  tree: { tag: 'ul' },
  menu: { tag: 'nav' },
  raw: { tag: 'div' },
};

/** Widgets rendered with a wrapping label, because a bare input is unusable. */
const LABELLED = new Set<UiWidgetKind>(['checkbox', 'radio']);

export function renderUiDocument(doc: UiDocument, file: ProjectFile, project: Project): string {
  const w = new CodeWriter('  ');
  w.line('<!doctype html>');
  w.line(`<html lang="${htmlAttr(doc.lang ?? 'en')}">`);
  w.line('<head>');
  w.nest(() => {
    w.line('<meta charset="utf-8">');
    for (const [name, content] of Object.entries(doc.meta ?? {})) {
      w.line(`<meta name="${htmlAttr(name)}" content="${htmlAttr(content)}">`);
    }
    w.line(`<title>${htmlEscape(doc.title || project.name)}</title>`);
    for (const id of doc.stylesheets ?? []) {
      const target = project.files.find((f) => f.id === id) ?? project.files.find((f) => f.path === id);
      if (target) w.line(`<link rel="stylesheet" href="${htmlAttr(relativeHref(file.path, target.path))}">`);
    }
    for (const id of doc.scripts ?? []) {
      const target = project.files.find((f) => f.id === id) ?? project.files.find((f) => f.path === id);
      if (target) w.line(`<script type="module" src="${htmlAttr(relativeHref(file.path, target.path))}"></script>`);
    }
  });
  w.line('</head>');
  w.line('<body>');
  w.nest(() => {
    w.line('<!-- <mcode:region id="body-top"> -->');
    w.line('<!-- </mcode:region> -->');
    if (!doc.root.length) w.line('<!-- No widgets yet. Add some in the UI designer. -->');
    for (const node of doc.root) renderNode(w, node);
    w.line('<!-- <mcode:region id="body-bottom"> -->');
    w.line('<!-- </mcode:region> -->');
  });
  w.line('</body>');
  w.line('</html>');
  return w.toString();
}

function renderNode(w: CodeWriter, node: UiNode): void {
  if (node.kind === 'raw') {
    if (node.raw) w.verbatim(node.raw);
    return;
  }
  const spec = TAGS[node.kind] ?? TAGS.container;
  const attrs = buildAttrs(node, spec);

  if (LABELLED.has(node.kind)) {
    w.line(`<label${attrPart({ class: node.classes?.join(' ') })}>`);
    w.nest(() => {
      w.line(`<${spec.tag}${attrs}>`);
      if (node.text) w.line(`<span>${htmlEscape(node.text)}</span>`);
    });
    w.line('</label>');
    return;
  }

  if (node.kind === 'select') {
    w.line(`<select${attrs}>`);
    w.nest(() => {
      for (const item of node.items ?? []) {
        w.line(`<option value="${htmlAttr(item)}">${htmlEscape(item)}</option>`);
      }
    });
    w.line('</select>');
    return;
  }

  if (node.kind === 'table') {
    w.line(`<table${attrs}>`);
    w.nest(() => {
      if (node.items?.length) {
        w.line('<thead>');
        w.nest(() => {
          w.line('<tr>');
          w.nest(() => node.items!.forEach((h) => w.line(`<th>${htmlEscape(h)}</th>`)));
          w.line('</tr>');
        });
        w.line('</thead>');
      }
      w.line(`<tbody${node.name ? ` id="${htmlAttr(kebab(node.name))}-body"` : ''}></tbody>`);
    });
    w.line('</table>');
    return;
  }

  if ((node.kind === 'list' || node.kind === 'tree') && node.items?.length) {
    w.line(`<${spec.tag}${attrs}>`);
    w.nest(() => node.items!.forEach((i) => w.line(`<li>${htmlEscape(i)}</li>`)));
    w.line(`</${spec.tag}>`);
    return;
  }

  if (spec.void) {
    w.line(`<${spec.tag}${attrs}>`);
    return;
  }

  const tag = node.kind === 'heading' ? `h${clampLevel(node.attrs?.level)}` : spec.tag;
  const inlineText = node.text && !node.children?.length;
  if (inlineText) {
    w.line(`<${tag}${attrs}>${htmlEscape(node.text!)}</${tag}>`);
    return;
  }
  w.line(`<${tag}${attrs}>`);
  w.nest(() => {
    if (node.text) w.line(htmlEscape(node.text));
    for (const child of node.children ?? []) renderNode(w, child);
  });
  w.line(`</${tag}>`);
}

function buildAttrs(node: UiNode, spec: (typeof TAGS)[UiWidgetKind]): string {
  const attrs: Record<string, string | undefined> = { ...spec.attrs, ...node.attrs };
  delete attrs.level;
  if (node.name) attrs.id = kebab(node.name);
  // An event binding needs a stable hook even when the widget is unnamed.
  if (!attrs.id && node.events?.length) attrs.id = `w-${node.id}`;
  if (node.classes?.length) attrs.class = node.classes.join(' ');
  if (spec.textAs === 'value' && node.text) attrs.value = node.text;
  if (node.style && Object.keys(node.style).length) {
    attrs.style = Object.entries(node.style)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
  }
  // Handlers are attached from the script, not with inline `on*` attributes:
  // inline handlers cannot be used under a content security policy and are not
  // reachable from a module scope.
  if (node.events?.length) {
    attrs['data-mcode-events'] = node.events.map((e) => `${e.event}:${e.handler}`).join(',');
  }
  return attrPart(attrs);
}

function attrPart(attrs: Record<string, string | undefined>): string {
  const parts = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .sort(([a], [b]) => (a === 'id' ? -1 : b === 'id' ? 1 : a.localeCompare(b)))
    .map(([k, v]) => `${k}="${htmlAttr(String(v))}"`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function clampLevel(raw: string | undefined): number {
  const n = Number(raw ?? 2);
  return Number.isFinite(n) ? Math.min(6, Math.max(1, Math.trunc(n))) : 2;
}

export function relativeHref(fromPath: string, toPath: string): string {
  const from = fromPath.split('/').slice(0, -1);
  const to = toPath.split('/');
  const file = to.pop()!;
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const parts = [...from.slice(i).map(() => '..'), ...to.slice(i), file];
  return parts.join('/') || file;
}

/** The UI document for a file, or an empty one. */
export function uiDocumentOf(file: ProjectFile): UiDocument {
  const raw = file.options?.ui;
  return raw && typeof raw === 'object' ? (raw as UiDocument) : emptyUiDocument();
}

// ---------------------------------------------------------------------------

export const htmlBackend: LanguageBackend = {
  id: 'html',
  name: 'HTML',
  maturity: 'full',
  extensions: ['.html', '.htm'],
  features: defaultFeatures({
    classes: false,
    interfaces: false,
    inheritance: false,
    generics: false,
    closures: false,
    exceptions: false,
    async: false,
    modules: false,
    browser: true,
    staticTypes: false,
  }),
  lineComment: '<!--',
  blockComment: { open: '<!--', close: '-->' },
  indent: '  ',
  keywords: new Set(),

  packageManager: {
    id: 'cdn',
    name: 'CDN / vendored',
    installAll: null,
    installOne: null,
    manifestFile: 'assets/vendor.json',
  },

  toolchain: [],

  entry: { file: 'index.html', symbol: '', description: 'The page a browser opens first.' },

  sourceRoot: () => '',
  testRoot: () => 'tests',
  pathFor: (file) => file.path,

  mapType(type: TypeRef) {
    // Markup has no type system; the value is only used for tooltips.
    return type.kind === 'named' ? type.name : type.kind;
  },

  importFor(_from, to) {
    return `<link rel="stylesheet" href="${to.path}">`;
  },

  emitModule(ctx: EmitContext) {
    // Reached when a logic graph targets an HTML file directly. The document
    // still renders; the graph's behaviour belongs in a linked script.
    ctx.diag.warn(
      'codegen',
      'html/logic-in-markup',
      'HTML files render the UI document, not a logic graph. Behaviour belongs in a linked JavaScript file.',
      { file: ctx.file.path, hint: 'Attach the graph to the page\'s .js file instead.' },
    );
    return renderUiDocument(uiDocumentOf(ctx.file), ctx.file, ctx.project);
  },

  emitUi(doc, file, project) {
    return renderUiDocument(doc, file, project);
  },

  emitProjectFiles(project) {
    const pages = project.files.filter((f) => f.language === 'html');
    if (!pages.length) return [];
    return [
      {
        path: 'assets/vendor.json',
        role: 'manifest',
        content: `${JSON.stringify(
          {
            note: 'Front-end libraries this page expects. Master Code records them; it does not download them.',
            libraries: project.dependencies
              .filter((d) => d.manager === 'cdn')
              .map((d) => ({ name: d.name, version: d.version, source: d.source, license: d.license })),
          },
          null,
          2,
        )}\n`,
      },
    ];
  },

  buildPlan(): BuildPlan {
    return { steps: [], note: 'HTML needs no build step; the generated pages are ready to open.' };
  },

  runPlan(project): RunPlan | null {
    const entry =
      project.files.find((f) => f.language === 'html' && f.role === 'entry') ??
      project.files.find((f) => f.language === 'html');
    if (!entry) return null;
    return {
      command: { label: 'Open page', command: 'node', args: ['-e', 'process.exit(0)'] },
      openInBrowser: entry.path,
    };
  },

  testPlan: () => null,

  parseDiagnostics(): Diagnostic[] {
    return [];
  },
};

/**
 * The snippet the JavaScript backend needs in order to attach handlers declared
 * in the markup. Exposed here so the coupling lives next to the attribute that
 * creates it.
 */
export const HTML_EVENT_BINDING_SNIPPET = `for (const element of document.querySelectorAll('[data-mcode-events]')) {
  for (const binding of element.dataset.mcodeEvents.split(',')) {
    const [event, handler] = binding.split(':');
    const fn = handlers[handler];
    if (fn) element.addEventListener(event, fn);
  }
}`;

export const generatedFileMarker: GeneratedFile['role'] = 'source';
