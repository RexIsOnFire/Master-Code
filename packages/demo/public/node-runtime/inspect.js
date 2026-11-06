/**
 * `util.inspect` and `util.format` for the JavaScript runner's console.
 *
 * What `console.log` prints is program output - the Learn challenges compare it
 * - so the common shapes follow Node's: `[ 1, 2, 3 ]`, `{ a: 1, b: 'x' }`,
 * `Map(1) { 'k' => 1 }`, `Point { x: 1 }`, `[Function: name]`, nesting cut off
 * at depth 2 as `[Object]`. Node's finer layout rules (grouping long numeric
 * arrays into columns, its exact line-breaking heuristics) are approximated: a
 * value that fits in 72 columns stays on one line, otherwise one entry per line.
 *
 * Self-contained: the worker loads it from source, with no imports.
 */

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function quote(text) {
  const q = text.includes("'") && !text.includes('"') ? '"' : "'";
  const escaped = text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return q + (q === "'" ? escaped.replace(/'/g, "\\'") : escaped) + q;
}

function key(name) {
  return typeof name === 'symbol' ? `[${name.toString()}]` : IDENTIFIER.test(name) ? name : quote(name);
}

function constructorName(value) {
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return null;
  return proto.constructor?.name ?? 'Object';
}

function wrap(prefix, open, items, close, indent) {
  if (!items.length) return `${prefix}${open}${close}`;
  const flat = `${prefix}${open} ${items.join(', ')} ${close}`;
  if (flat.length <= 72 && !items.some((i) => i.includes('\n'))) return flat;
  const pad = '  '.repeat(indent + 1);
  return `${prefix}${open}\n${items.map((i) => pad + i).join(',\n')}\n${'  '.repeat(indent)}${close}`;
}

export function inspect(value, options = {}, depth = 0, seen = new Set()) {
  const maxDepth = options.depth ?? 2;
  switch (typeof value) {
    case 'string':
      return depth === 0 && options.top ? value : quote(value);
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value);
    case 'bigint':
      return `${value}n`;
    case 'boolean':
    case 'undefined':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'function': {
      const source = Function.prototype.toString.call(value);
      if (source.startsWith('class')) return `[class ${value.name || '(anonymous)'}]`;
      const kind = value.constructor?.name === 'AsyncFunction' ? 'AsyncFunction' : value.constructor?.name?.includes('Generator') ? value.constructor.name : 'Function';
      // Node: `[Function: name]`, but `[Function (anonymous)]` without the colon.
      return value.name ? `[${kind}: ${value.name}]` : `[${kind} (anonymous)]`;
    }
  }
  if (value === null) return 'null';
  if (seen.has(value)) return '[Circular *1]';

  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (value instanceof Promise) return 'Promise { <pending> }';

  const name = constructorName(value);
  if (depth > maxDepth) return Array.isArray(value) ? '[Array]' : `[${name ?? 'Object'}]`;

  seen.add(value);
  try {
    const inner = (v) => inspect(v, options, depth + 1, seen);
    if (Array.isArray(value)) {
      const items = [];
      let holes = 0;
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          holes++;
          continue;
        }
        if (holes) items.push(`<${holes} empty item${holes > 1 ? 's' : ''}>`), (holes = 0);
        items.push(inner(value[i]));
      }
      if (holes) items.push(`<${holes} empty item${holes > 1 ? 's' : ''}>`);
      return wrap(name === 'Array' ? '' : `${name}(${value.length}) `, '[', items, ']', depth);
    }
    if (value instanceof Map) {
      const items = [...value].map(([k, v]) => `${inner(k)} => ${inner(v)}`);
      return wrap(`Map(${value.size}) `, '{', items, '}', depth);
    }
    if (value instanceof Set) {
      return wrap(`Set(${value.size}) `, '{', [...value].map(inner), '}', depth);
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      return wrap(`${name}(${value.length}) `, '[', [...value].map((v) => inspect(v)), ']', depth);
    }
    const items = Reflect.ownKeys(value)
      .filter((k) => Object.prototype.propertyIsEnumerable.call(value, k))
      .map((k) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, k);
        const shown = descriptor.get ? (descriptor.set ? '[Getter/Setter]' : '[Getter]') : inner(descriptor.value);
        return `${key(k)}: ${shown}`;
      });
    const prefix = name === null ? '[Object: null prototype] ' : name === 'Object' ? '' : `${name} `;
    return wrap(prefix, '{', items, '}', depth);
  } finally {
    seen.delete(value);
  }
}

/** `util.format`: printf-style directives, then the rest separated by spaces. */
export function format(...args) {
  if (!args.length) return '';
  const [first, ...rest] = args;
  // A lone string is returned untouched, `%%` included - Node only reads directives when arguments follow.
  if (typeof first === 'string' && !rest.length) return first;
  let text;
  if (typeof first === 'string') {
    let i = 0;
    text = first.replace(/%([sdifjoOc%])/g, (match, directive) => {
      if (directive === '%') return '%';
      if (i >= rest.length) return match;
      const arg = rest[i++];
      switch (directive) {
        case 's':
          return typeof arg === 'string' ? arg : typeof arg === 'bigint' ? `${arg}n` : typeof arg === 'object' && arg !== null ? inspect(arg, { depth: 1 }) : String(arg);
        case 'd':
        case 'i': {
          if (typeof arg === 'bigint') return `${arg}n`;
          const n = Number(arg);
          return String(directive === 'i' ? Math.trunc(n) : n);
        }
        case 'f':
          return String(parseFloat(arg));
        case 'j':
          try {
            return JSON.stringify(arg);
          } catch {
            return '[Circular]';
          }
        case 'c':
          return '';
        default:
          return inspect(arg, { depth: directive === 'O' ? 2 : 4 });
      }
    });
    rest.splice(0, i);
  } else {
    text = inspect(first);
  }
  for (const arg of rest) text += ` ${typeof arg === 'string' ? arg : inspect(arg)}`;
  return text;
}
