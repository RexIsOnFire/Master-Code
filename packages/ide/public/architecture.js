/**
 * The Architecture view: the FILE graph, drawn.
 *
 * This is the counterpart to the node editor. That one shows the logic graph —
 * functions, conditions, data flow *inside* a file. This one shows the file
 * graph — which files exist, which module owns them, and which imports which.
 * They are deliberately separate structures, and the platform is only honest
 * about that if both are visible as graphs rather than one being a list.
 *
 * Layout is by dependency depth: a file sits one column right of everything it
 * imports, so arrows read left-to-right and the entry point ends up furthest
 * right. Cycles have no valid depth, so they are broken for layout purposes and
 * then drawn in red — being able to *see* the loop is the point.
 */

/** One colour per file kind, matching the legend in the Explorer. */
function kindColor(kind, theme) {
  if (kind === 'generated') return theme.accent;
  if (kind === 'user') return theme.ok;
  if (kind === 'hybrid') return theme.warn;
  return theme.muted;
}

const BOX_W = 168;
const BOX_H = 46;
const GAP_X = 96;
const GAP_Y = 22;
const MODULE_PAD = 16;
const MODULE_HEAD = 22;

export class ArchitectureView {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onOpenFile = options.onOpenFile ?? (() => {});
    this.onSelectFile = options.onSelectFile ?? (() => {});

    this.project = null;
    this.fileGraph = { edges: [], cycles: [], summary: [] };
    this.groupByModule = true;
    this.showExternal = false;

    this.nodes = [];
    this.groups = [];
    this.edges = [];
    this.selected = null;
    this.hover = null;
    this.view = { x: 40, y: 40, scale: 1 };

    this.#bind();
  }

  setData(project, fileGraph) {
    this.project = project;
    this.fileGraph = fileGraph ?? { edges: [], cycles: [], summary: [] };
    this.layout();
    this.draw();
  }

  setOptions({ groupByModule, showExternal }) {
    if (groupByModule !== undefined) this.groupByModule = groupByModule;
    if (showExternal !== undefined) this.showExternal = showExternal;
    this.layout();
    this.draw();
  }

  select(fileId) {
    this.selected = fileId;
    this.draw();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.draw();
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  layout() {
    const result = layoutFileGraph(this.project, this.fileGraph, {
      groupByModule: this.groupByModule,
      showExternal: this.showExternal,
    });
    this.nodes = result.nodes;
    this.groups = result.groups;
    this.edges = result.edges;
  }

  fit() {
    if (!this.nodes.length) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of [...this.nodes, ...this.groups]) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + (n.w ?? BOX_W));
      y1 = Math.max(y1, n.y + (n.h ?? BOX_H));
    }
    const pad = 40;
    const scale = Math.min(
      1.2,
      Math.max(0.25, Math.min((this.width - pad * 2) / (x1 - x0 || 1), (this.height - pad * 2) / (y1 - y0 || 1))),
    );
    this.view.scale = scale;
    this.view.x = pad - x0 * scale + Math.max(0, (this.width - pad * 2 - (x1 - x0) * scale) / 2);
    this.view.y = pad - y0 * scale + Math.max(0, (this.height - pad * 2 - (y1 - y0) * scale) / 2);
    this.draw();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  draw() {
    const c = this.ctx;
    if (!c || !this.width) return;
    const css = getComputedStyle(document.documentElement);
    const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const bg = read('--canvas', '#0c0e13');
    const surface = read('--surface', '#1b1f28');
    const fg = read('--ink', '#e4e7ee');
    const muted = read('--ink-dim', '#98a0b3');
    const line = read('--line-strong', '#333a49');
    const accent = read('--accent', '#4f83f1');
    const error = read('--error', '#ef5f5f');
    const ok = read('--ok', '#45c47a');
    const warn = read('--warn', '#e0a642');

    c.save();
    c.fillStyle = bg;
    c.fillRect(0, 0, this.width, this.height);

    if (!this.nodes.length) {
      c.fillStyle = muted;
      c.font = '13px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('No files to show.', this.width / 2, this.height / 2);
      c.restore();
      return;
    }

    c.translate(this.view.x, this.view.y);
    c.scale(this.view.scale, this.view.scale);

    for (const g of this.groups) {
      c.strokeStyle = line;
      c.setLineDash([4, 4]);
      c.lineWidth = 1;
      c.strokeRect(g.x, g.y, g.w, g.h);
      c.setLineDash([]);
      c.fillStyle = muted;
      c.font = '11px system-ui, sans-serif';
      c.textAlign = 'left';
      c.fillText(`module ${g.name}`, g.x + 6, g.y + 14);
    }

    for (const e of this.edges) {
      const highlighted =
        this.selected && (e.from.file.id === this.selected || e.to.file.id === this.selected);
      c.strokeStyle = e.cyclic ? error : highlighted ? accent : line;
      c.lineWidth = e.cyclic || highlighted ? 1.8 : 1;
      this.#arrow(c, e);
    }

    c.font = '12px system-ui, sans-serif';
    for (const n of this.nodes) {
      const tint = kindColor(n.file.kind, { accent, ok, warn, muted });
      const active = n.file.id === this.selected;
      c.fillStyle = surface;
      c.strokeStyle = active ? accent : n === this.hover ? muted : line;
      c.lineWidth = active ? 2 : 1;
      roundRect(c, n.x, n.y, n.w, n.h, 6);
      c.fill();
      c.stroke();

      c.fillStyle = tint;
      c.fillRect(n.x, n.y, 3, n.h);

      const name = n.file.path.split('/').pop();
      const dir = n.file.path.slice(0, n.file.path.length - name.length).replace(/\/$/, '');
      c.textAlign = 'left';
      c.fillStyle = fg;
      c.fillText(fit(c, name, n.w - 16), n.x + 10, n.y + 19);
      c.fillStyle = muted;
      c.font = '10px system-ui, sans-serif';
      c.fillText(fit(c, dir || '.', n.w - 16), n.x + 10, n.y + 33);
      const tag = n.file.role === 'entry' ? 'entry' : n.file.kind;
      c.textAlign = 'right';
      c.fillStyle = tint;
      c.fillText(tag, n.x + n.w - 8, n.y + 33);
      c.font = '12px system-ui, sans-serif';
    }

    c.restore();
  }

  /**
   * Draws `e.to` (the dependency) feeding `e.from` (the importer).
   *
   * The edge stored on the graph runs importer → imported, but the layout puts
   * dependencies on the left, so drawing it in that direction would point every
   * arrow backwards against the reading order. It is drawn the other way and
   * labelled "provides to" in the legend: repository → routes → main.
   *
   * A cycle is the one case where the two ends can be in any relative position,
   * so the control points are derived from the actual endpoints rather than
   * assuming a direction.
   */
  #arrow(c, e) {
    const rightward = e.from.x >= e.to.x;
    const sx = rightward ? e.to.x + e.to.w : e.to.x;
    const sy = e.to.y + e.to.h / 2;
    const tx = rightward ? e.from.x : e.from.x + e.from.w;
    const ty = e.from.y + e.from.h / 2;
    const reach = Math.max(28, Math.abs(tx - sx) * 0.4) * (rightward ? 1 : -1);

    // An edge skipping a column would otherwise run straight through whatever
    // box sits between its endpoints — and boxes are painted after edges, so it
    // would simply vanish. Bow it out of the way, more for a longer skip.
    const span = Math.round(Math.abs(e.from.x - e.to.x) / (BOX_W + GAP_X));
    const bow = span > 1 ? Math.min(64, 26 * (span - 1)) * (sy <= ty ? -1 : 1) : 0;

    // The curve leaves and arrives horizontally, so the arrowhead follows the
    // final control leg rather than the straight-line angle between the boxes.
    const c1x = sx + reach;
    const c2x = tx - reach;
    c.beginPath();
    c.moveTo(sx, sy);
    c.bezierCurveTo(c1x, sy + bow, c2x, ty + bow, tx, ty);
    c.stroke();

    const angle = Math.atan2(0, tx - c2x);
    c.beginPath();
    c.moveTo(tx, ty);
    c.lineTo(tx - 8 * Math.cos(angle - 0.4), ty - 8 * Math.sin(angle - 0.4));
    c.lineTo(tx - 8 * Math.cos(angle + 0.4), ty - 8 * Math.sin(angle + 0.4));
    c.closePath();
    c.fillStyle = c.strokeStyle;
    c.fill();
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  #bind() {
    const toWorld = (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: (ev.clientX - rect.left - this.view.x) / this.view.scale,
        y: (ev.clientY - rect.top - this.view.y) / this.view.scale,
      };
    };
    const hit = (pt) =>
      this.nodes.find((n) => pt.x >= n.x && pt.x <= n.x + n.w && pt.y >= n.y && pt.y <= n.y + n.h);

    let panning = null;

    this.canvas.addEventListener('mousedown', (ev) => {
      const pt = toWorld(ev);
      const node = hit(pt);
      if (node) {
        this.selected = node.file.id;
        this.onSelectFile(node.file.id);
        this.draw();
        return;
      }
      panning = { x: ev.clientX - this.view.x, y: ev.clientY - this.view.y };
      this.canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (ev) => {
      if (panning) {
        this.view.x = ev.clientX - panning.x;
        this.view.y = ev.clientY - panning.y;
        this.draw();
        return;
      }
      if (!this.canvas.isConnected || !this.canvas.offsetParent) return;
      const node = hit(toWorld(ev));
      if (node !== this.hover) {
        this.hover = node;
        this.canvas.style.cursor = node ? 'pointer' : 'grab';
        this.canvas.title = node ? node.file.path : '';
        this.draw();
      }
    });

    window.addEventListener('mouseup', () => {
      panning = null;
      this.canvas.style.cursor = 'grab';
    });

    this.canvas.addEventListener('dblclick', (ev) => {
      const node = hit(toWorld(ev));
      if (node) this.onOpenFile(node.file.id);
    });

    this.canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
        const next = Math.min(2.5, Math.max(0.2, this.view.scale * factor));
        const k = next / this.view.scale;
        this.view.x = mx - (mx - this.view.x) * k;
        this.view.y = my - (my - this.view.y) * k;
        this.view.scale = next;
        this.draw();
      },
      { passive: false },
    );
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function fit(c, text, max) {
  if (c.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && c.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

// ---------------------------------------------------------------------------
// Layout, as a pure function
// ---------------------------------------------------------------------------

/**
 * Places every visible file, groups them into module bands, and resolves the
 * import edges into positioned pairs.
 *
 * Kept free of the DOM and of `this` so it can be tested directly — the cases
 * that matter (cycles, orphans, a module spanning several columns) are exactly
 * the ones that are painful to set up in a browser.
 *
 * @returns {{nodes: object[], groups: object[], edges: object[]}}
 */
export function layoutFileGraph(project, fileGraph, options = {}) {
  const empty = { nodes: [], groups: [], edges: [] };
  if (!project) return empty;

  const groupByModule = options.groupByModule ?? true;
  const showExternal = options.showExternal ?? false;

  const files = project.files.filter(
    (f) => (showExternal || f.kind !== 'external') && f.role !== 'asset' && f.role !== 'build',
  );
  if (!files.length) return empty;

  const visible = new Set(files.map((f) => f.id));
  const edges = (fileGraph?.edges ?? []).filter((e) => visible.has(e.from) && visible.has(e.to));

  // Flag the edges that close a cycle: layout has to ignore them (there is no
  // consistent depth around a loop) and the renderer colours them red.
  const cyclic = new Set();
  for (const cycle of fileGraph?.cycles ?? []) {
    for (let i = 0; i < cycle.length; i++) {
      cyclic.add(`${cycle[i]}->${cycle[(i + 1) % cycle.length]}`);
    }
  }

  const depth = dependencyDepths(files, edges, cyclic);

  const columns = new Map();
  for (const file of files) {
    const d = depth.get(file.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(file);
  }

  const moduleOf = (f) => (groupByModule && f.moduleId ? f.moduleId : '');
  const moduleBounds = new Map();
  const nodes = [];
  let x = 0;

  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(d);
    // Stable order: module, then path. Layout must not jitter between renders
    // of the same project.
    column.sort((a, b) => (moduleOf(a) + a.path).localeCompare(moduleOf(b) + b.path));

    let y = 0;
    let lastModule = null;
    for (const file of column) {
      const mod = moduleOf(file);
      if (mod !== lastModule) {
        if (mod) y += MODULE_HEAD;
        lastModule = mod;
      }
      nodes.push({ file, x, y, w: BOX_W, h: BOX_H });
      if (mod) {
        const b = moduleBounds.get(mod) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        b.x0 = Math.min(b.x0, x);
        b.y0 = Math.min(b.y0, y - MODULE_HEAD);
        b.x1 = Math.max(b.x1, x + BOX_W);
        b.y1 = Math.max(b.y1, y + BOX_H);
        moduleBounds.set(mod, b);
      }
      y += BOX_H + GAP_Y;
    }
    x += BOX_W + GAP_X;
  }

  const groups = [];
  for (const [id, b] of moduleBounds) {
    const module = project.modules.find((m) => m.id === id);
    if (!module) continue;
    groups.push({
      name: module.name,
      x: b.x0 - MODULE_PAD,
      y: b.y0 - MODULE_PAD,
      w: b.x1 - b.x0 + MODULE_PAD * 2,
      h: b.y1 - b.y0 + MODULE_PAD * 2,
    });
  }

  const byId = new Map(nodes.map((n) => [n.file.id, n]));
  const placed = [];
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (from && to) placed.push({ from, to, cyclic: cyclic.has(`${e.from}->${e.to}`) });
  }

  return { nodes, groups, edges: placed };
}

/**
 * Longest-path depth over the acyclic part of the graph: a file sits one column
 * to the right of everything it imports. Edges closing a cycle are excluded, or
 * there would be no fixed point to reach.
 */
export function dependencyDepths(files, edges, cyclic = new Set()) {
  const imports = new Map(files.map((f) => [f.id, []]));
  for (const e of edges) {
    if (cyclic.has(`${e.from}->${e.to}`)) continue;
    imports.get(e.from)?.push(e.to);
  }
  const depth = new Map();
  const visiting = new Set();
  const walk = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0; // defensive: a cycle the flag set missed
    visiting.add(id);
    let d = 0;
    for (const dep of imports.get(id) ?? []) d = Math.max(d, walk(dep) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const f of files) walk(f.id);
  return depth;
}
