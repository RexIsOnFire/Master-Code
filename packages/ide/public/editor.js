/**
 * The visual node editor.
 *
 * Canvas rather than DOM: a graph of a few hundred nodes with live wires
 * repaints far more smoothly when it is one drawing surface, and hit-testing a
 * bezier is easier in canvas coordinates than in layout coordinates.
 *
 * The editor owns no truth. It renders whatever graph it is handed and reports
 * intent through callbacks (`onConnect`, `onMove`, `onSelect`); the server
 * applies the change and hands back the updated graph. That is what keeps the
 * canvas and the project file from drifting apart.
 */

const GRID = 24;
const NODE_WIDTH = 190;
const HEADER_HEIGHT = 26;
const PORT_SPACING = 19;
const PORT_RADIUS = 4.5;
const PORT_HIT = 9;

/** Wire and port colour by the type's colour key. */
const TYPE_COLORS = {
  exec: '#e6e9f0',
  number: '#22d3ee',
  string: '#fbbf24',
  bool: '#f472b6',
  char: '#fbbf24',
  bytes: '#a78bfa',
  collection: '#34d399',
  map: '#34d399',
  future: '#818cf8',
  result: '#f87171',
  function: '#a3e635',
  object: '#e879f9',
  any: '#94a3b8',
  void: '#64748b',
};

/**
 * Render a port's declared type the way the compiler prints it.
 *
 * A materialised port carries a TypeRef object, not the string the node
 * definition was written with, so `String(type)` yields "[object Object]" -
 * which reached both the port colours and the inspector. Mirrors
 * `typeToString` in core/types.
 */
export function typeText(t) {
  if (t === null || t === undefined) return 'Any';
  if (typeof t === 'string') return t;
  switch (t.kind) {
    case 'exec': return 'Exec';
    case 'void': return 'Void';
    case 'any': return 'Any';
    case 'primitive': return t.name;
    case 'list': return `List<${typeText(t.item)}>`;
    case 'set': return `Set<${typeText(t.item)}>`;
    case 'map': return `Map<${typeText(t.key)}, ${typeText(t.value)}>`;
    case 'option': return `Option<${typeText(t.inner)}>`;
    case 'future': return `Future<${typeText(t.inner)}>`;
    case 'result': return `Result<${typeText(t.ok)}, ${typeText(t.err)}>`;
    case 'tuple': return `(${t.items.map(typeText).join(', ')})`;
    case 'named': return t.args?.length ? `${t.name}<${t.args.map(typeText).join(', ')}>` : t.name;
    case 'function': return `(${t.params.map(typeText).join(', ')}) -> ${typeText(t.returns)}`;
    case 'var': return t.name;
    default: return 'Any';
  }
}

function colorKey(type) {
  const t = typeText(type);
  if (t === 'Exec') return 'exec';
  if (t === 'Void') return 'void';
  if (t === 'Any') return 'any';
  if (/^(i32|i64|f32|f64)$/.test(t)) return 'number';
  if (t === 'string') return 'string';
  if (t === 'char') return 'char';
  if (t === 'bool') return 'bool';
  if (t === 'bytes') return 'bytes';
  if (/^(List|Set|Tuple)</.test(t) || t.startsWith('(')) return t.includes('->') ? 'function' : 'collection';
  if (t.startsWith('Map<')) return 'map';
  if (t.startsWith('Option<')) return colorKey(t.slice(7, -1));
  if (t.startsWith('Future<')) return 'future';
  if (t.startsWith('Result<')) return 'result';
  if (t.includes('->')) return 'function';
  return 'object';
}

function portColor(type) {
  return TYPE_COLORS[colorKey(type)] ?? TYPE_COLORS.object;
}

const isExec = (type) => typeText(type) === 'Exec';

export class NodeEditor {
  constructor(canvas, minimap, callbacks = {}) {
    this.canvas = canvas;
    this.minimap = minimap;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks;

    this.graph = null;
    this.definitions = new Map();
    this.view = { x: 0, y: 0, zoom: 1 };
    this.selection = new Set();
    this.highlight = new Set();
    this.running = new Set();
    /** nodeId -> {count, order} from the last traced run. Empty when none. */
    this.trace = new Map();

    this.drag = null;
    this.link = null;
    this.hover = null;
    this.marquee = null;

    this.theme = readTheme();
    this.#bind();
    this.resize();
  }

  // -- public -----------------------------------------------------------------

  setDefinitions(list) {
    this.definitions = new Map(list.map((d) => [d.type, d]));
  }

  setGraph(graph) {
    this.graph = graph;
    this.selection.clear();
    if (graph?.viewport) this.view = { ...graph.viewport };
    this.draw();
  }

  /** Mark nodes reported by diagnostics, so problems show on the canvas. */
  setHighlights(nodeIds) {
    this.highlight = new Set(nodeIds);
    this.draw();
  }

  /** Mark nodes currently executing, for the runtime view. */
  setRunning(nodeIds) {
    this.running = new Set(nodeIds);
    this.draw();
  }

  /**
   * Show the result of a traced run on the graph.
   *
   * Pass an empty map to clear it. Nodes that ran keep their normal appearance
   * with a run count; nodes that did not are dimmed — which is the reading
   * people want, because the surprising thing is usually the branch that never
   * fired.
   */
  setTrace(entries) {
    this.trace = new Map(entries ?? []);
    this.draw();
  }

  refreshTheme() {
    this.theme = readTheme();
    this.draw();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = { width: rect.width, height: rect.height };
    if (this.minimap) {
      const m = this.minimap.getBoundingClientRect();
      this.minimap.width = Math.max(1, Math.floor(m.width * dpr));
      this.minimap.height = Math.max(1, Math.floor(m.height * dpr));
      this.minimap.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      this.minimapSize = { width: m.width, height: m.height };
    }
    this.draw();
  }

  focusNode(nodeId) {
    const node = this.graph?.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    this.view.zoom = Math.max(this.view.zoom, 0.9);
    this.view.x = this.size.width / 2 - (node.x + NODE_WIDTH / 2) * this.view.zoom;
    this.view.y = this.size.height / 2 - (this.nodeHeight(node) / 2 + node.y) * this.view.zoom;
    this.selection = new Set([nodeId]);
    this.callbacks.onSelect?.([nodeId]);
    this.draw();
  }

  fit() {
    if (!this.graph?.nodes.length) return;
    const box = this.bounds();
    const pad = 60;
    const zoom = Math.min(
      3,
      Math.max(0.15, Math.min((this.size.width - pad * 2) / box.width, (this.size.height - pad * 2) / box.height)),
    );
    this.view.zoom = zoom;
    this.view.x = this.size.width / 2 - (box.x + box.width / 2) * zoom;
    this.view.y = this.size.height / 2 - (box.y + box.height / 2) * zoom;
    this.draw();
  }

  // -- geometry ---------------------------------------------------------------

  nodeHeight(node) {
    const rows = Math.max(node.inputs.length, node.outputs.length);
    return HEADER_HEIGHT + Math.max(1, rows) * PORT_SPACING + 10;
  }

  bounds() {
    const nodes = this.graph?.nodes ?? [];
    if (!nodes.length) return { x: 0, y: 0, width: 1, height: 1 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + NODE_WIDTH);
      maxY = Math.max(maxY, node.y + this.nodeHeight(node));
    }
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  portPosition(node, portId, direction) {
    const ports = direction === 'in' ? node.inputs : node.outputs;
    const index = ports.findIndex((p) => p.id === portId);
    if (index < 0) return null;
    return {
      x: node.x + (direction === 'in' ? 0 : NODE_WIDTH),
      y: node.y + HEADER_HEIGHT + index * PORT_SPACING + PORT_SPACING / 2,
    };
  }

  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.x) / this.view.zoom,
      y: (clientY - rect.top - this.view.y) / this.view.zoom,
    };
  }

  nodeAt(point) {
    const nodes = this.graph?.nodes ?? [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (
        point.x >= node.x &&
        point.x <= node.x + NODE_WIDTH &&
        point.y >= node.y &&
        point.y <= node.y + this.nodeHeight(node)
      ) {
        return node;
      }
    }
    return null;
  }

  portAt(point) {
    for (const node of this.graph?.nodes ?? []) {
      for (const direction of ['in', 'out']) {
        const ports = direction === 'in' ? node.inputs : node.outputs;
        for (const port of ports) {
          const pos = this.portPosition(node, port.id, direction);
          if (!pos) continue;
          if (Math.hypot(pos.x - point.x, pos.y - point.y) <= PORT_HIT) {
            return { node, port, direction, pos };
          }
        }
      }
    }
    return null;
  }

  edgeAt(point) {
    for (const edge of this.graph?.edges ?? []) {
      const a = this.#edgeEnd(edge.from, 'out');
      const b = this.#edgeEnd(edge.to, 'in');
      if (!a || !b) continue;
      // Sample the curve; 16 points is plenty at editing zoom levels.
      for (let t = 0; t <= 1; t += 1 / 16) {
        const p = bezierPoint(a, b, t);
        if (Math.hypot(p.x - point.x, p.y - point.y) < 6) return edge;
      }
    }
    return null;
  }

  #edgeEnd(ref, direction) {
    const node = this.graph?.nodes.find((n) => n.id === ref.node);
    return node ? this.portPosition(node, ref.port, direction) : null;
  }

  // -- interaction ------------------------------------------------------------

  #bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.#onDown(e));
    c.addEventListener('pointermove', (e) => this.#onMove(e));
    c.addEventListener('pointerup', (e) => this.#onUp(e));
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.draw();
    });
    c.addEventListener('wheel', (e) => this.#onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => this.#onDoubleClick(e));
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const world = this.toWorld(e.clientX, e.clientY);
      const node = this.nodeAt(world);
      const edge = node ? null : this.edgeAt(world);
      this.callbacks.onContextMenu?.({ world, node, edge, clientX: e.clientX, clientY: e.clientY });
    });

    c.addEventListener('dragover', (e) => e.preventDefault());
    c.addEventListener('drop', (e) => {
      e.preventDefault();
      const type = e.dataTransfer?.getData('text/mcode-node');
      if (!type) return;
      const world = this.toWorld(e.clientX, e.clientY);
      this.callbacks.onDropNode?.(type, snap(world.x), snap(world.y));
    });
  }

  #onDown(event) {
    this.canvas.setPointerCapture(event.pointerId);
    const world = this.toWorld(event.clientX, event.clientY);

    // Middle button, space, or empty right-drag pans.
    if (event.button === 1 || (event.button === 0 && event.altKey)) {
      this.drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, view: { ...this.view } };
      return;
    }

    const port = this.portAt(world);
    if (port && event.button === 0) {
      // Dragging from a connected input detaches the wire instead of stacking.
      if (port.direction === 'in') {
        const existing = this.graph.edges.find((e) => e.to.node === port.node.id && e.to.port === port.port.id);
        if (existing) {
          const source = this.graph.nodes.find((n) => n.id === existing.from.node);
          this.callbacks.onDisconnect?.([existing.id]);
          if (source) {
            const sourcePort = source.outputs.find((p) => p.id === existing.from.port);
            this.link = { from: { node: source, port: sourcePort, direction: 'out' }, to: world };
            return;
          }
        }
      }
      this.link = { from: port, to: world };
      return;
    }

    const node = this.nodeAt(world);
    if (node) {
      if (event.shiftKey) {
        if (this.selection.has(node.id)) this.selection.delete(node.id);
        else this.selection.add(node.id);
      } else if (!this.selection.has(node.id)) {
        this.selection = new Set([node.id]);
      }
      this.callbacks.onSelect?.([...this.selection]);
      this.drag = {
        kind: 'move',
        startX: world.x,
        startY: world.y,
        origins: [...this.selection]
          .map((id) => this.graph.nodes.find((n) => n.id === id))
          .filter(Boolean)
          .map((n) => ({ id: n.id, x: n.x, y: n.y })),
      };
      this.draw();
      return;
    }

    const edge = this.edgeAt(world);
    if (edge && event.button === 0) {
      this.callbacks.onDisconnect?.([edge.id]);
      return;
    }

    if (event.button === 0) {
      if (!event.shiftKey) {
        this.selection.clear();
        this.callbacks.onSelect?.([]);
      }
      this.marquee = { x0: world.x, y0: world.y, x1: world.x, y1: world.y };
    }
    this.draw();
  }

  #onMove(event) {
    const world = this.toWorld(event.clientX, event.clientY);

    if (this.drag?.kind === 'pan') {
      this.view.x = this.drag.view.x + (event.clientX - this.drag.startX);
      this.view.y = this.drag.view.y + (event.clientY - this.drag.startY);
      this.draw();
      return;
    }
    if (this.drag?.kind === 'move') {
      const dx = world.x - this.drag.startX;
      const dy = world.y - this.drag.startY;
      for (const origin of this.drag.origins) {
        const node = this.graph.nodes.find((n) => n.id === origin.id);
        if (!node) continue;
        node.x = snap(origin.x + dx);
        node.y = snap(origin.y + dy);
      }
      this.draw();
      return;
    }
    if (this.link) {
      this.link.to = world;
      this.hover = this.portAt(world);
      this.draw();
      return;
    }
    if (this.marquee) {
      this.marquee.x1 = world.x;
      this.marquee.y1 = world.y;
      this.draw();
      return;
    }

    const port = this.portAt(world);
    const node = port ? null : this.nodeAt(world);
    const next = port ?? node;
    if (next !== this.hover) {
      this.hover = next;
      this.canvas.style.cursor = port ? 'crosshair' : node ? 'grab' : 'default';
      this.draw();
    }
  }

  #onUp(event) {
    const world = this.toWorld(event.clientX, event.clientY);

    if (this.link) {
      const target = this.portAt(world);
      if (target && target.direction !== this.link.from.direction && target.node.id !== this.link.from.node.id) {
        const from = this.link.from.direction === 'out' ? this.link.from : target;
        const to = this.link.from.direction === 'out' ? target : this.link.from;
        if (isExec(from.port.type) === isExec(to.port.type)) {
          this.callbacks.onConnect?.(
            { node: from.node.id, port: from.port.id },
            { node: to.node.id, port: to.port.id },
          );
        } else {
          this.callbacks.onMessage?.('Execution wires and data wires cannot be joined.');
        }
      } else if (!target) {
        // Dropping on empty space offers a node that fits the dangling type.
        this.callbacks.onDropWire?.(this.link.from, snap(world.x), snap(world.y));
      }
      this.link = null;
      this.draw();
      return;
    }

    if (this.drag?.kind === 'move') {
      this.callbacks.onMove?.(this.drag.origins.map((o) => {
        const node = this.graph.nodes.find((n) => n.id === o.id);
        return { id: o.id, x: node?.x ?? o.x, y: node?.y ?? o.y };
      }));
    }

    if (this.marquee) {
      const box = normalizeBox(this.marquee);
      for (const node of this.graph?.nodes ?? []) {
        const height = this.nodeHeight(node);
        const overlaps =
          node.x < box.x + box.width &&
          node.x + NODE_WIDTH > box.x &&
          node.y < box.y + box.height &&
          node.y + height > box.y;
        if (overlaps) this.selection.add(node.id);
      }
      this.callbacks.onSelect?.([...this.selection]);
      this.marquee = null;
    }

    this.drag = null;
    this.callbacks.onViewport?.({ ...this.view });
    this.draw();
  }

  #onWheel(event) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey || !event.shiftKey) {
      const factor = Math.exp(-event.deltaY * 0.0015);
      const next = Math.min(3, Math.max(0.15, this.view.zoom * factor));
      const rect = this.canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      // Keep the point under the cursor fixed while zooming.
      this.view.x = mx - ((mx - this.view.x) * next) / this.view.zoom;
      this.view.y = my - ((my - this.view.y) * next) / this.view.zoom;
      this.view.zoom = next;
    } else {
      this.view.x -= event.deltaX;
      this.view.y -= event.deltaY;
    }
    this.callbacks.onViewport?.({ ...this.view });
    this.draw();
  }

  #onDoubleClick(event) {
    const world = this.toWorld(event.clientX, event.clientY);
    const node = this.nodeAt(world);
    if (node) this.callbacks.onOpenNode?.(node);
    else this.callbacks.onDropWire?.(null, snap(world.x), snap(world.y));
  }

  // -- drawing ----------------------------------------------------------------

  draw() {
    const ctx = this.ctx;
    if (!ctx || !this.size) return;
    const { width, height } = this.size;
    const t = this.theme;

    ctx.save();
    ctx.fillStyle = t.canvas;
    ctx.fillRect(0, 0, width, height);
    this.#drawGrid();

    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.zoom, this.view.zoom);

    for (const edge of this.graph?.edges ?? []) this.#drawEdge(edge);
    if (this.link) this.#drawPendingLink();
    for (const node of this.graph?.nodes ?? []) this.#drawNode(node);

    if (this.marquee) {
      const box = normalizeBox(this.marquee);
      ctx.strokeStyle = t.accent;
      ctx.fillStyle = `${t.accent}18`;
      ctx.lineWidth = 1 / this.view.zoom;
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.strokeRect(box.x, box.y, box.width, box.height);
    }
    ctx.restore();
    this.#drawMinimap();
  }

  #drawGrid() {
    const ctx = this.ctx;
    const { width, height } = this.size;
    const step = GRID * this.view.zoom;
    if (step < 6) return;
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = this.view.x % step; x < width; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
    }
    for (let y = this.view.y % step; y < height; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  #drawEdge(edge) {
    const a = this.#edgeEnd(edge.from, 'out');
    const b = this.#edgeEnd(edge.to, 'in');
    if (!a || !b) return;
    const node = this.graph.nodes.find((n) => n.id === edge.from.node);
    const port = node?.outputs.find((p) => p.id === edge.from.port);
    const exec = isExec(port?.type);
    const ctx = this.ctx;
    ctx.strokeStyle = exec ? this.theme.exec : portColor(port?.type);
    ctx.lineWidth = exec ? 2.4 : 1.7;
    ctx.globalAlpha = 0.9;
    drawBezier(ctx, a, b);
    ctx.globalAlpha = 1;
  }

  #drawPendingLink() {
    const ctx = this.ctx;
    const from = this.link.from;
    const a = this.portPosition(from.node, from.port.id, from.direction);
    if (!a) return;
    const b = this.hover && this.hover.direction !== from.direction ? this.hover.pos : this.link.to;
    ctx.strokeStyle = isExec(from.port.type) ? this.theme.exec : portColor(from.port.type);
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    if (from.direction === 'out') drawBezier(ctx, a, b);
    else drawBezier(ctx, b, a);
    ctx.setLineDash([]);
  }

  #drawNode(node) {
    const ctx = this.ctx;
    const t = this.theme;
    const def = this.definitions.get(node.type);
    const height = this.nodeHeight(node);
    const selected = this.selection.has(node.id);
    const flagged = this.highlight.has(node.id);
    const active = this.running.has(node.id);
    const accent = def?.color ?? t.accent;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = selected ? 16 : 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = t.node;
    roundRect(ctx, node.x, node.y, NODE_WIDTH, height, 8);
    ctx.fill();
    ctx.restore();

    // A traced run dims what never executed, so a dead branch is visible at a
    // glance rather than something you have to go looking for.
    const traced = this.trace.size > 0;
    const hit = traced ? this.trace.get(node.id) : undefined;
    if (traced && !hit) ctx.globalAlpha = 0.35;

    // Header strip carries the node's category colour.
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, node.x, node.y, NODE_WIDTH, height, 8);
    ctx.clip();
    ctx.fillStyle = accent;
    ctx.globalAlpha = node.enabled === false ? 0.25 : 0.85;
    ctx.fillRect(node.x, node.y, NODE_WIDTH, HEADER_HEIGHT);
    ctx.restore();

    ctx.strokeStyle = active ? t.ok : flagged ? t.error : selected ? t.accent : t.line;
    ctx.lineWidth = active || flagged || selected ? 2 : 1;
    roundRect(ctx, node.x, node.y, NODE_WIDTH, height, 8);
    ctx.stroke();

    ctx.fillStyle = '#0b0d12';
    ctx.font = '600 11.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const title = node.title || def?.title || node.type;
    ctx.fillText(clip(ctx, title, NODE_WIDTH - 34), node.x + 9, node.y + HEADER_HEIGHT / 2 + 0.5);

    if (node.breakpoint) {
      ctx.fillStyle = t.error;
      ctx.beginPath();
      ctx.arc(node.x + NODE_WIDTH - 12, node.y + HEADER_HEIGHT / 2, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Run count, on the header, only when it says something a plain highlight
    // would not: how many times.
    if (hit) {
      const badge = hit.count > 1 ? `${hit.count}x` : String(hit.order);
      ctx.font = '600 9.5px ui-sans-serif, system-ui, sans-serif';
      const w = ctx.measureText(badge).width + 8;
      ctx.fillStyle = hit.count > 1 ? t.warn : t.ok;
      roundRect(ctx, node.x + NODE_WIDTH - w - 6, node.y + 4, w, 12, 6);
      ctx.fill();
      ctx.fillStyle = '#0b0d12';
      ctx.textAlign = 'center';
      ctx.fillText(badge, node.x + NODE_WIDTH - w / 2 - 6, node.y + 10.5);
      ctx.textAlign = 'left';
      ctx.font = '600 11.5px ui-sans-serif, system-ui, sans-serif';
    }

    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    node.inputs.forEach((port, i) => this.#drawPort(node, port, i, 'in'));
    node.outputs.forEach((port, i) => this.#drawPort(node, port, i, 'out'));

    if (node.enabled === false) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      roundRect(ctx, node.x, node.y, NODE_WIDTH, height, 8);
      ctx.fill();
    }

    // The dimming above is set outside any save/restore pair, so it has to be
    // cleared here or every later node and wire inherits it.
    ctx.globalAlpha = 1;
  }

  #drawPort(node, port, index, direction) {
    const ctx = this.ctx;
    const t = this.theme;
    const x = node.x + (direction === 'in' ? 0 : NODE_WIDTH);
    const y = node.y + HEADER_HEIGHT + index * PORT_SPACING + PORT_SPACING / 2;
    const exec = isExec(port.type);
    const color = exec ? t.exec : portColor(port.type);

    if (exec) {
      // Execution ports are triangles, so flow reads at a glance.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 5);
      ctx.lineTo(x + 4, y);
      ctx.lineTo(x - 4, y + 5);
      ctx.closePath();
      ctx.fill();
    } else {
      const connected = this.graph.edges.some((e) =>
        direction === 'in'
          ? e.to.node === node.id && e.to.port === port.id
          : e.from.node === node.id && e.from.port === port.id,
      );
      ctx.beginPath();
      ctx.arc(x, y, PORT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = connected ? color : t.node;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (port.name) {
      ctx.fillStyle = t.inkDim;
      ctx.textAlign = direction === 'in' ? 'left' : 'right';
      const label = clip(ctx, port.name, NODE_WIDTH / 2 - 14);
      ctx.fillText(label, direction === 'in' ? x + 10 : x - 10, y);
      ctx.textAlign = 'left';
    }
  }

  #drawMinimap() {
    if (!this.minimap || !this.minimapSize) return;
    const ctx = this.minimap.getContext('2d');
    const { width, height } = this.minimapSize;
    ctx.clearRect(0, 0, width, height);
    if (!this.graph?.nodes.length) return;

    const box = this.bounds();
    const pad = 8;
    const scale = Math.min((width - pad * 2) / box.width, (height - pad * 2) / box.height);
    const ox = pad - box.x * scale;
    const oy = pad - box.y * scale;

    ctx.fillStyle = this.theme.inkFaint;
    for (const node of this.graph.nodes) {
      ctx.fillRect(node.x * scale + ox, node.y * scale + oy, Math.max(2, NODE_WIDTH * scale), Math.max(2, this.nodeHeight(node) * scale));
    }
    // Viewport rectangle.
    ctx.strokeStyle = this.theme.accent;
    ctx.lineWidth = 1;
    const vx = (-this.view.x / this.view.zoom) * scale + ox;
    const vy = (-this.view.y / this.view.zoom) * scale + oy;
    ctx.strokeRect(vx, vy, (this.size.width / this.view.zoom) * scale, (this.size.height / this.view.zoom) * scale);
  }
}

// ---------------------------------------------------------------------------

function readTheme() {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    canvas: read('--canvas', '#0c0e13'),
    grid: read('--grid', '#171b24'),
    node: read('--surface', '#1b1f28'),
    line: read('--line-strong', '#333a49'),
    ink: read('--ink', '#e4e7ee'),
    inkDim: read('--ink-dim', '#98a0b3'),
    inkFaint: read('--ink-faint', '#656d80'),
    accent: read('--accent', '#4f83f1'),
    error: read('--error', '#ef5f5f'),
    ok: read('--ok', '#45c47a'),
    warn: read('--warn', '#e0a642'),
    exec: read('--ink', '#e4e7ee'),
  };
}

function snap(value) {
  return Math.round(value / (GRID / 2)) * (GRID / 2);
}

function normalizeBox(m) {
  return {
    x: Math.min(m.x0, m.x1),
    y: Math.min(m.y0, m.y1),
    width: Math.abs(m.x1 - m.x0),
    height: Math.abs(m.y1 - m.y0),
  };
}

function controlOffset(a, b) {
  return Math.max(36, Math.min(160, Math.abs(b.x - a.x) * 0.55));
}

function drawBezier(ctx, a, b) {
  const k = controlOffset(a, b);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.bezierCurveTo(a.x + k, a.y, b.x - k, b.y, b.x, b.y);
  ctx.stroke();
}

function bezierPoint(a, b, t) {
  const k = controlOffset(a, b);
  const p0 = a;
  const p1 = { x: a.x + k, y: a.y };
  const p2 = { x: b.x - k, y: b.y };
  const p3 = b;
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clip(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

export { portColor, colorKey, isExec, NODE_WIDTH, HEADER_HEIGHT };
