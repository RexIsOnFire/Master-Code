/**
 * The UI document model.
 *
 * Markup is a tree, not a control-flow graph, so forcing it through the
 * statement IR would lose exactly the structure the designer cares about.
 * A UI document is therefore a first-class part of the semantic model, sitting
 * beside the logic graph rather than inside it.
 *
 * The same tree drives:
 *   - the HTML backend (renders elements and attributes)
 *   - the CSS backend (collects the style rules declared on nodes)
 *   - the JavaScript backend (wires `events` to handler functions in the logic
 *     graph, so a Button's onClick lands on an `event/handler` node)
 *
 * It is deliberately not HTML-specific: `kind` is an abstract widget name, and
 * each backend maps it to its own vocabulary. That leaves room for desktop
 * toolkits to be added as adapters without changing the designer.
 */

export type UiWidgetKind =
  // containers
  | 'window'
  | 'panel'
  | 'container'
  | 'row'
  | 'column'
  | 'grid'
  | 'form'
  | 'card'
  | 'scroll'
  | 'tabs'
  | 'dialog'
  // content
  | 'label'
  | 'heading'
  | 'paragraph'
  | 'image'
  | 'icon'
  | 'divider'
  | 'link'
  | 'code'
  // input
  | 'button'
  | 'textbox'
  | 'textarea'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'slider'
  | 'number'
  | 'date'
  | 'file'
  // collections
  | 'list'
  | 'table'
  | 'tree'
  | 'menu'
  // escape hatch: verbatim markup
  | 'raw';

export interface UiStyle {
  /** Declarations in CSS property form; backends translate for other toolkits. */
  [property: string]: string | number;
}

export interface UiEventBinding {
  /** Abstract event name: `click`, `change`, `submit`, `input`, `keydown`. */
  event: string;
  /**
   * Handler function name. Must match an `event/handler` node in the logic
   * graph of the behaviour file, or generation reports an unbound handler.
   */
  handler: string;
}

export interface UiNode {
  id: string;
  kind: UiWidgetKind;
  /** Stable name used for the generated element id and for DOM lookups. */
  name?: string;
  /** Text content for content widgets. */
  text?: string;
  /** Widget-specific attributes: `src`, `href`, `placeholder`, `type`, ... */
  attrs?: Record<string, string>;
  /** Inline style declarations. */
  style?: UiStyle;
  /** CSS classes; also the join point with hand-written stylesheets. */
  classes?: string[];
  events?: UiEventBinding[];
  children?: UiNode[];
  /** Rows/columns for `table`, options for `select`, items for `list`. */
  items?: string[];
  /** Verbatim markup, only for `kind: 'raw'`. */
  raw?: string;
  /** Designer-only metadata (locked, collapsed in the tree view). */
  editor?: { locked?: boolean; collapsed?: boolean };
}

export interface UiStyleRule {
  selector: string;
  declarations: UiStyle;
  /** Media query this rule sits inside, e.g. `(max-width: 640px)`. */
  media?: string;
  comment?: string;
}

export interface UiDocument {
  /** Page/window title. */
  title: string;
  /** Root widgets. */
  root: UiNode[];
  /** Stylesheet rules authored in the designer's CSS panel. */
  rules: UiStyleRule[];
  /** Ids of stylesheet files to link, in order. */
  stylesheets?: string[];
  /** Ids of script files to include, in order. */
  scripts?: string[];
  /** `<meta>` entries for HTML targets. */
  meta?: Record<string, string>;
  /** Breakpoints offered by the responsive layout designer. */
  breakpoints?: { name: string; minWidth?: number; maxWidth?: number }[];
  lang?: string;
}

export function emptyUiDocument(title = 'Untitled'): UiDocument {
  return {
    title,
    root: [],
    rules: [],
    meta: { viewport: 'width=device-width, initial-scale=1' },
    breakpoints: [
      { name: 'mobile', maxWidth: 640 },
      { name: 'tablet', minWidth: 641, maxWidth: 1024 },
      { name: 'desktop', minWidth: 1025 },
    ],
    lang: 'en',
  };
}

/** Depth-first walk over a document's widgets. */
export function walkUi(doc: UiDocument, visit: (node: UiNode, parent?: UiNode) => void): void {
  const go = (nodes: UiNode[], parent?: UiNode) => {
    for (const n of nodes) {
      visit(n, parent);
      if (n.children) go(n.children, n);
    }
  };
  go(doc.root);
}

export function findUiNode(doc: UiDocument, id: string): UiNode | undefined {
  let found: UiNode | undefined;
  walkUi(doc, (n) => {
    if (n.id === id) found = n;
  });
  return found;
}

/** Every handler name referenced anywhere in the document. */
export function uiHandlers(doc: UiDocument): { handler: string; event: string; nodeId: string }[] {
  const out: { handler: string; event: string; nodeId: string }[] = [];
  walkUi(doc, (n) => {
    for (const e of n.events ?? []) out.push({ handler: e.handler, event: e.event, nodeId: n.id });
  });
  return out;
}

/** Widgets that need a stable id in the generated markup. */
export function uiNamedNodes(doc: UiDocument): UiNode[] {
  const out: UiNode[] = [];
  walkUi(doc, (n) => {
    if (n.name || n.events?.length) out.push(n);
  });
  return out;
}

/** Container widgets, for the designer's drop-target logic. */
export const UI_CONTAINERS: ReadonlySet<UiWidgetKind> = new Set<UiWidgetKind>([
  'window',
  'panel',
  'container',
  'row',
  'column',
  'grid',
  'form',
  'card',
  'scroll',
  'tabs',
  'dialog',
  'list',
  'menu',
]);

export function isContainer(kind: UiWidgetKind): boolean {
  return UI_CONTAINERS.has(kind);
}

/** Widgets that carry a user-editable value, for form binding. */
export const UI_INPUTS: ReadonlySet<UiWidgetKind> = new Set<UiWidgetKind>([
  'textbox',
  'textarea',
  'checkbox',
  'radio',
  'select',
  'slider',
  'number',
  'date',
  'file',
]);

/** Default attributes and styles applied when a widget is dropped. */
export const UI_DEFAULTS: Partial<Record<UiWidgetKind, Partial<UiNode>>> = {
  button: { text: 'Button', events: [] },
  label: { text: 'Label' },
  heading: { text: 'Heading', attrs: { level: '2' } },
  paragraph: { text: 'Some text.' },
  textbox: { attrs: { type: 'text', placeholder: '' } },
  textarea: { attrs: { rows: '4' } },
  checkbox: { text: 'Enabled' },
  select: { items: ['One', 'Two'] },
  slider: { attrs: { min: '0', max: '100', step: '1' } },
  number: { attrs: { min: '0', step: '1' } },
  image: { attrs: { src: '', alt: '' } },
  link: { text: 'Link', attrs: { href: '#' } },
  table: { items: ['Column A', 'Column B'] },
  list: { items: ['Item one', 'Item two'] },
  row: { style: { display: 'flex', gap: '8px' } },
  column: { style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } },
  grid: { style: { display: 'grid', 'grid-template-columns': 'repeat(2, 1fr)', gap: '8px' } },
  card: { style: { padding: '16px', border: '1px solid #ddd', 'border-radius': '8px' } },
};
