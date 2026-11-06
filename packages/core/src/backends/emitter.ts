/**
 * Shared text-emission helpers.
 *
 * Backends never concatenate strings ad hoc: they write through a `CodeWriter`
 * that owns indentation and blank-line policy. That is what makes generated
 * output byte-for-byte reproducible, which in turn is what makes the generated
 * tree diffable in git.
 */

export class CodeWriter {
  private readonly lines: string[] = [];
  private readonly indentUnit: string;
  private depth = 0;
  private pendingBlank = false;

  /**
   * Line index (0-based) -> the node that produced it.
   *
   * Populated only when a backend calls `mark`. It is what turns an execution
   * trace into "this node ran" rather than "something on this line ran".
   * Generation inlines pure nodes into their use site, so there is often no
   * identifier in the text carrying their identity and nothing to match on
   * after the fact.
   */
  private readonly origins = new Map<number, unknown>();
  /** Set by `mark`, consumed by the next `line`. */
  private pendingOrigin: unknown;

  constructor(indentUnit = '    ') {
    this.indentUnit = indentUnit;
  }

  get indentDepth(): number {
    return this.depth;
  }

  indent(): this {
    this.depth++;
    return this;
  }

  dedent(): this {
    this.depth = Math.max(0, this.depth - 1);
    return this;
  }

  /** Emit one line at the current indentation. */
  line(text = ''): this {
    if (this.pendingBlank && this.lines.length) {
      this.lines.push('');
      this.pendingBlank = false;
    }
    if (this.pendingOrigin !== undefined) {
      this.origins.set(this.lines.length, this.pendingOrigin);
      this.pendingOrigin = undefined;
    }
    this.lines.push(text ? this.indentUnit.repeat(this.depth) + text : '');
    return this;
  }

  /** Attribute the next line written to `origin`. */
  mark(origin: unknown): this {
    if (origin) this.pendingOrigin = origin;
    return this;
  }

  /** Line index -> origin, for everything marked so far. */
  lineOrigins(): ReadonlyMap<number, unknown> {
    return this.origins;
  }

  /** Emit several lines, re-indenting a multi-line string as a block. */
  block(text: string): this {
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) this.line(raw);
    return this;
  }

  /**
   * Append another writer's output, carrying its line attributions across.
   *
   * Backends build a body and then a header, so the body's line numbers are
   * only final once it is placed. Composing via `block(other.toString())`
   * keeps the text and loses the map.
   */
  blockFrom(other: CodeWriter, fallback = ''): this {
    // Match what callers did by hand before this existed — trim the block —
    // but track how many leading lines went, so the attributions still line up
    // with the text that survived.
    const raw = other.toString().replace(/\r\n/g, '\n').split('\n');
    let first = 0;
    let last = raw.length - 1;
    while (first <= last && !raw[first]!.trim()) first += 1;
    while (last >= first && !raw[last]!.trim()) last -= 1;

    if (last < first) {
      if (fallback) this.line(fallback);
      return this;
    }

    const offset = this.lines.length + (this.pendingBlank && this.lines.length ? 1 : 0);
    for (let i = first; i <= last; i++) this.line(raw[i]!);
    for (const [line, origin] of other.lineOrigins()) {
      if (line >= first && line <= last) this.origins.set(offset + (line - first), origin);
    }
    return this;
  }

  /**
   * Emit verbatim user source, normalising its own indentation to the current
   * depth. Custom Code blocks come through here.
   */
  verbatim(text: string): this {
    const lines = text.replace(/\r\n/g, '\n').replace(/\t/g, '    ').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) return this;
    const common = lines
      .filter((l) => l.trim())
      .reduce((min, l) => Math.min(min, l.length - l.trimStart().length), Infinity);
    const strip = Number.isFinite(common) ? common : 0;
    for (const l of lines) this.line(l.slice(strip).trimEnd());
    return this;
  }

  /** Request a blank line before the next emitted line, collapsing repeats. */
  blank(): this {
    if (this.lines.length) this.pendingBlank = true;
    return this;
  }

  /** Run `body` one level deeper. */
  nest(body: () => void): this {
    this.indent();
    body();
    this.dedent();
    return this;
  }

  /** Open/close a braced block. */
  braced(header: string, body: () => void, close = '}'): this {
    this.line(`${header} {`);
    this.nest(body);
    this.line(close);
    return this;
  }

  /**
   * Append to the line already written, rather than starting a new one.
   *
   * For the languages where `} else {` has to be one line: the closing brace is
   * written by the clause that ended, and the clause that follows continues it.
   */
  joinLast(text: string): this {
    if (!this.lines.length) return this.line(text.trimStart());
    this.lines[this.lines.length - 1] += text;
    return this;
  }

  toString(): string {
    // Exactly one trailing newline, no trailing whitespace anywhere.
    const text = this.lines.map((l) => l.replace(/\s+$/, '')).join('\n');
    return `${text.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')}\n`;
  }

  get isEmpty(): boolean {
    return this.lines.length === 0;
  }
}

// ---------------------------------------------------------------------------
// String escaping
// ---------------------------------------------------------------------------

const C_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\0': '\\0',
};

/** Double-quoted literal for C-family languages (C, C++, C#, Java, Rust, Go, JS). */
export function cString(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (C_ESCAPES[ch]) out += C_ESCAPES[ch];
    else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Python literal; prefers single quotes but switches when the text has them. */
export function pyString(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += `\\${q}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out + q;
}

export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function htmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// Naming conventions
// ---------------------------------------------------------------------------

/** `user_name` / `userName` / `UserName` -> `["user", "name"]` */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function snake(name: string): string {
  return splitWords(name).join('_') || 'value';
}

export function screamingSnake(name: string): string {
  return snake(name).toUpperCase();
}

export function camel(name: string): string {
  const w = splitWords(name);
  if (!w.length) return 'value';
  return w[0] + w.slice(1).map(cap).join('');
}

export function pascal(name: string): string {
  const w = splitWords(name);
  return w.length ? w.map(cap).join('') : 'Value';
}

export function kebab(name: string): string {
  return splitWords(name).join('-') || 'value';
}

function cap(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Avoid colliding with a language keyword by appending an underscore. */
export function avoidKeyword(name: string, keywords: ReadonlySet<string>): string {
  return keywords.has(name) ? `${name}_` : name;
}

/**
 * Wrap prose to a column limit, for doc comments. Keeps existing paragraph
 * breaks; does not touch lines that look like code or lists.
 */
export function wrapText(text: string, width = 88): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    if (/^\s|^[-*>|]/.test(para)) {
      out.push(para.trimEnd());
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line && line.length + word.length + 1 > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out;
}
