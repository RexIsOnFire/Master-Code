/**
 * Master Code type system.
 *
 * Types are language-neutral. Each language backend maps them onto concrete
 * syntax (see `LanguageBackend.mapType`). The editor uses the same structures
 * to decide whether two ports may be connected, so a graph that type-checks
 * here is expected to compile in every backend that claims support for the
 * features it uses.
 *
 * `Exec` is deliberately part of the type lattice rather than a separate
 * concept: control-flow edges are just edges whose type is Exec, which keeps
 * the connection rules in one place.
 */

export type PrimitiveName =
  | 'bool'
  | 'i32'
  | 'i64'
  | 'f32'
  | 'f64'
  | 'string'
  | 'char'
  | 'bytes';

export type TypeRef =
  /** Control-flow token. Carries no value. */
  | { kind: 'exec' }
  /** No value produced (statement position, `void`/`None`/`()`). */
  | { kind: 'void' }
  /** Escape hatch: assignable both ways, reported by the validator as a risk. */
  | { kind: 'any' }
  | { kind: 'primitive'; name: PrimitiveName }
  | { kind: 'list'; item: TypeRef }
  | { kind: 'set'; item: TypeRef }
  | { kind: 'map'; key: TypeRef; value: TypeRef }
  | { kind: 'option'; inner: TypeRef }
  | { kind: 'result'; ok: TypeRef; err: TypeRef }
  | { kind: 'tuple'; items: TypeRef[] }
  /** A user-declared class / struct / interface / enum, by semantic-model id. */
  | { kind: 'named'; name: string; args?: TypeRef[] }
  | { kind: 'function'; params: TypeRef[]; returns: TypeRef }
  /** A generic placeholder, resolved by unification during lowering. */
  | { kind: 'var'; name: string }
  /** Deferred/async value. */
  | { kind: 'future'; inner: TypeRef };

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const T = {
  exec: { kind: 'exec' } as TypeRef,
  void: { kind: 'void' } as TypeRef,
  any: { kind: 'any' } as TypeRef,
  bool: { kind: 'primitive', name: 'bool' } as TypeRef,
  i32: { kind: 'primitive', name: 'i32' } as TypeRef,
  i64: { kind: 'primitive', name: 'i64' } as TypeRef,
  f32: { kind: 'primitive', name: 'f32' } as TypeRef,
  f64: { kind: 'primitive', name: 'f64' } as TypeRef,
  string: { kind: 'primitive', name: 'string' } as TypeRef,
  char: { kind: 'primitive', name: 'char' } as TypeRef,
  bytes: { kind: 'primitive', name: 'bytes' } as TypeRef,
  list: (item: TypeRef): TypeRef => ({ kind: 'list', item }),
  set: (item: TypeRef): TypeRef => ({ kind: 'set', item }),
  map: (key: TypeRef, value: TypeRef): TypeRef => ({ kind: 'map', key, value }),
  option: (inner: TypeRef): TypeRef => ({ kind: 'option', inner }),
  result: (ok: TypeRef, err: TypeRef): TypeRef => ({ kind: 'result', ok, err }),
  tuple: (...items: TypeRef[]): TypeRef => ({ kind: 'tuple', items }),
  named: (name: string, ...args: TypeRef[]): TypeRef =>
    args.length ? { kind: 'named', name, args } : { kind: 'named', name },
  fn: (params: TypeRef[], returns: TypeRef): TypeRef => ({ kind: 'function', params, returns }),
  var: (name: string): TypeRef => ({ kind: 'var', name }),
  future: (inner: TypeRef): TypeRef => ({ kind: 'future', inner }),
  /** JSON-ish dynamic value; used by parse/stringify nodes. */
  json: { kind: 'named', name: 'Json' } as TypeRef,
} as const;

// ---------------------------------------------------------------------------
// Numeric lattice
// ---------------------------------------------------------------------------

/** Widening order for implicit numeric conversion. Lower may widen to higher. */
const NUMERIC_RANK: Partial<Record<PrimitiveName, number>> = {
  i32: 1,
  i64: 2,
  f32: 3,
  f64: 4,
};

export function isNumeric(t: TypeRef): boolean {
  return t.kind === 'primitive' && NUMERIC_RANK[t.name] !== undefined;
}

export function isInteger(t: TypeRef): boolean {
  return t.kind === 'primitive' && (t.name === 'i32' || t.name === 'i64');
}

/** The type an arithmetic op on `a` and `b` produces, or null if not numeric. */
export function numericJoin(a: TypeRef, b: TypeRef): TypeRef | null {
  if (!isNumeric(a) || !isNumeric(b)) return null;
  const ra = NUMERIC_RANK[(a as { name: PrimitiveName }).name]!;
  const rb = NUMERIC_RANK[(b as { name: PrimitiveName }).name]!;
  return ra >= rb ? a : b;
}

// ---------------------------------------------------------------------------
// Equality / assignability
// ---------------------------------------------------------------------------

export function typeEquals(a: TypeRef, b: TypeRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'exec':
    case 'void':
    case 'any':
      return true;
    case 'primitive':
      return a.name === (b as typeof a).name;
    case 'list':
    case 'set':
      return typeEquals(a.item, (b as typeof a).item);
    case 'option':
    case 'future':
      return typeEquals(a.inner, (b as typeof a).inner);
    case 'map': {
      const o = b as typeof a;
      return typeEquals(a.key, o.key) && typeEquals(a.value, o.value);
    }
    case 'result': {
      const o = b as typeof a;
      return typeEquals(a.ok, o.ok) && typeEquals(a.err, o.err);
    }
    case 'tuple': {
      const o = b as typeof a;
      return a.items.length === o.items.length && a.items.every((x, i) => typeEquals(x, o.items[i]));
    }
    case 'named': {
      const o = b as typeof a;
      if (a.name !== o.name) return false;
      const aa = a.args ?? [];
      const ob = o.args ?? [];
      return aa.length === ob.length && aa.every((x, i) => typeEquals(x, ob[i]));
    }
    case 'function': {
      const o = b as typeof a;
      return (
        a.params.length === o.params.length &&
        a.params.every((x, i) => typeEquals(x, o.params[i])) &&
        typeEquals(a.returns, o.returns)
      );
    }
    case 'var':
      return a.name === (b as typeof a).name;
  }
}

export type AssignResult =
  | { ok: true; coercion?: 'widen' | 'wrap-option' | 'to-string' | 'unwrap-future' }
  | { ok: false; reason: string };

/**
 * Can a value of `from` flow into a port of type `to`?
 *
 * Coercions are explicit in the result so the backends can emit a cast rather
 * than relying on the target language's own conversion rules, which differ.
 */
export function isAssignable(from: TypeRef, to: TypeRef): AssignResult {
  if (from.kind === 'exec' || to.kind === 'exec') {
    return from.kind === 'exec' && to.kind === 'exec'
      ? { ok: true }
      : { ok: false, reason: 'execution flow cannot connect to a data port' };
  }
  if (to.kind === 'any' || from.kind === 'any') return { ok: true };
  if (typeEquals(from, to)) return { ok: true };

  if (to.kind === 'void') return { ok: true };

  // Numeric widening: i32 -> i64 -> f32 -> f64.
  const widened = numericJoin(from, to);
  if (widened && typeEquals(widened, to)) return { ok: true, coercion: 'widen' };

  // T -> Option<T>
  if (to.kind === 'option') {
    const inner = isAssignable(from, to.inner);
    if (inner.ok) return { ok: true, coercion: 'wrap-option' };
  }

  // Future<T> -> T is allowed at an await boundary; lowering inserts the await.
  if (from.kind === 'future') {
    const inner = isAssignable(from.inner, to);
    if (inner.ok) return { ok: true, coercion: 'unwrap-future' };
  }

  // Rendering a value as text is a safe, common conversion - but only for
  // things that always have a value. Allowing `Option<T> -> string` here would
  // quietly turn "there might be nothing" into the text "None", which is
  // exactly the bug the option type exists to prevent.
  if (to.kind === 'primitive' && to.name === 'string' && DISPLAYABLE.has(from.kind)) {
    return { ok: true, coercion: 'to-string' };
  }

  // Covariant containers. Sound enough for code generation; the backends emit
  // element-wise conversion where the target language demands it.
  if (from.kind === 'list' && to.kind === 'list') return nest(from.item, to.item, 'list element');
  if (from.kind === 'set' && to.kind === 'set') return nest(from.item, to.item, 'set element');
  if (from.kind === 'option' && to.kind === 'option') return nest(from.inner, to.inner, 'option payload');
  if (from.kind === 'map' && to.kind === 'map') {
    const k = isAssignable(from.key, to.key);
    if (!k.ok) return { ok: false, reason: `map key: ${k.reason}` };
    return nest(from.value, to.value, 'map value');
  }
  if (from.kind === 'tuple' && to.kind === 'tuple') {
    if (from.items.length !== to.items.length) {
      return { ok: false, reason: `tuple arity ${from.items.length} != ${to.items.length}` };
    }
    for (let i = 0; i < from.items.length; i++) {
      const r = isAssignable(from.items[i], to.items[i]);
      if (!r.ok) return { ok: false, reason: `tuple slot ${i}: ${r.reason}` };
    }
    return { ok: true };
  }

  return { ok: false, reason: `${typeToString(from)} is not assignable to ${typeToString(to)}` };
}

/** Kinds that always hold a value, and so can be rendered as text implicitly. */
const DISPLAYABLE = new Set<TypeRef['kind']>(['primitive', 'named', 'list', 'set', 'map', 'tuple']);

function nest(from: TypeRef, to: TypeRef, what: string): AssignResult {
  const r = isAssignable(from, to);
  return r.ok ? { ok: true } : { ok: false, reason: `${what}: ${r.reason}` };
}

// ---------------------------------------------------------------------------
// Unification (for generic nodes such as List<T> -> map -> List<U>)
// ---------------------------------------------------------------------------

export type Substitution = Map<string, TypeRef>;

/** Bind type variables in `pattern` so it matches `concrete`. Mutates `subst`. */
export function unify(pattern: TypeRef, concrete: TypeRef, subst: Substitution): boolean {
  if (pattern.kind === 'var') {
    const bound = subst.get(pattern.name);
    if (bound) {
      // A numeric variable seen at two widths takes the wider one, so
      // `i64 * f64` resolves to f64 rather than to whichever arrived first.
      const joined = numericJoin(bound, concrete);
      if (joined) {
        subst.set(pattern.name, joined);
        return true;
      }
      return isAssignable(concrete, bound).ok || isAssignable(bound, concrete).ok;
    }
    if (concrete.kind === 'exec' || concrete.kind === 'void') return false;
    subst.set(pattern.name, concrete);
    return true;
  }
  if (concrete.kind === 'any') return true;
  if (pattern.kind !== concrete.kind) return false;

  switch (pattern.kind) {
    case 'list':
    case 'set':
      return unify(pattern.item, (concrete as typeof pattern).item, subst);
    case 'option':
    case 'future':
      return unify(pattern.inner, (concrete as typeof pattern).inner, subst);
    case 'map': {
      const c = concrete as typeof pattern;
      return unify(pattern.key, c.key, subst) && unify(pattern.value, c.value, subst);
    }
    case 'result': {
      const c = concrete as typeof pattern;
      return unify(pattern.ok, c.ok, subst) && unify(pattern.err, c.err, subst);
    }
    case 'tuple': {
      const c = concrete as typeof pattern;
      return (
        pattern.items.length === c.items.length &&
        pattern.items.every((p, i) => unify(p, c.items[i], subst))
      );
    }
    case 'function': {
      const c = concrete as typeof pattern;
      return (
        pattern.params.length === c.params.length &&
        pattern.params.every((p, i) => unify(p, c.params[i], subst)) &&
        unify(pattern.returns, c.returns, subst)
      );
    }
    case 'named': {
      const c = concrete as typeof pattern;
      if (pattern.name !== c.name) return false;
      const pa = pattern.args ?? [];
      const ca = c.args ?? [];
      return pa.length === ca.length && pa.every((p, i) => unify(p, ca[i], subst));
    }
    default:
      return typeEquals(pattern, concrete);
  }
}

/** Replace bound type variables with their concrete types. */
export function substitute(t: TypeRef, subst: Substitution): TypeRef {
  switch (t.kind) {
    case 'var':
      return subst.get(t.name) ?? t;
    case 'list':
      return { kind: 'list', item: substitute(t.item, subst) };
    case 'set':
      return { kind: 'set', item: substitute(t.item, subst) };
    case 'option':
      return { kind: 'option', inner: substitute(t.inner, subst) };
    case 'future':
      return { kind: 'future', inner: substitute(t.inner, subst) };
    case 'map':
      return { kind: 'map', key: substitute(t.key, subst), value: substitute(t.value, subst) };
    case 'result':
      return { kind: 'result', ok: substitute(t.ok, subst), err: substitute(t.err, subst) };
    case 'tuple':
      return { kind: 'tuple', items: t.items.map((i) => substitute(i, subst)) };
    case 'function':
      return {
        kind: 'function',
        params: t.params.map((p) => substitute(p, subst)),
        returns: substitute(t.returns, subst),
      };
    case 'named':
      return t.args ? { kind: 'named', name: t.name, args: t.args.map((a) => substitute(a, subst)) } : t;
    default:
      return t;
  }
}

export function containsTypeVar(t: TypeRef): boolean {
  switch (t.kind) {
    case 'var':
      return true;
    case 'list':
    case 'set':
      return containsTypeVar(t.item);
    case 'option':
    case 'future':
      return containsTypeVar(t.inner);
    case 'map':
      return containsTypeVar(t.key) || containsTypeVar(t.value);
    case 'result':
      return containsTypeVar(t.ok) || containsTypeVar(t.err);
    case 'tuple':
      return t.items.some(containsTypeVar);
    case 'function':
      return t.params.some(containsTypeVar) || containsTypeVar(t.returns);
    case 'named':
      return (t.args ?? []).some(containsTypeVar);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Display / parsing
// ---------------------------------------------------------------------------

export function typeToString(t: TypeRef): string {
  switch (t.kind) {
    case 'exec':
      return 'Exec';
    case 'void':
      return 'Void';
    case 'any':
      return 'Any';
    case 'primitive':
      return t.name;
    case 'list':
      return `List<${typeToString(t.item)}>`;
    case 'set':
      return `Set<${typeToString(t.item)}>`;
    case 'map':
      return `Map<${typeToString(t.key)}, ${typeToString(t.value)}>`;
    case 'option':
      return `Option<${typeToString(t.inner)}>`;
    case 'future':
      return `Future<${typeToString(t.inner)}>`;
    case 'result':
      return `Result<${typeToString(t.ok)}, ${typeToString(t.err)}>`;
    case 'tuple':
      return `(${t.items.map(typeToString).join(', ')})`;
    case 'named':
      return t.args?.length ? `${t.name}<${t.args.map(typeToString).join(', ')}>` : t.name;
    case 'function':
      return `(${t.params.map(typeToString).join(', ')}) -> ${typeToString(t.returns)}`;
    case 'var':
      return t.name;
  }
}

const PRIMITIVES = new Set<string>(['bool', 'i32', 'i64', 'f32', 'f64', 'string', 'char', 'bytes']);

/** Parse the textual form produced by `typeToString`. Used by the UI and project files. */
export function parseType(src: string): TypeRef {
  const s = src.trim();
  if (s === 'Exec') return T.exec;
  if (s === 'Void') return T.void;
  if (s === 'Any') return T.any;
  if (PRIMITIVES.has(s)) return { kind: 'primitive', name: s as PrimitiveName };

  if (s.startsWith('(')) {
    const close = matchParen(s, 0);
    const inner = s.slice(1, close);
    const rest = s.slice(close + 1).trim();
    const items = splitArgs(inner).map(parseType);
    if (rest.startsWith('->')) return T.fn(items, parseType(rest.slice(2)));
    return items.length === 1 ? items[0] : T.tuple(...items);
  }

  const lt = s.indexOf('<');
  if (lt < 0) {
    // Single upper-case letter (optionally with digits) reads as a type variable.
    if (/^[A-Z][0-9]?$/.test(s)) return T.var(s);
    return T.named(s);
  }
  const head = s.slice(0, lt);
  const args = splitArgs(s.slice(lt + 1, s.lastIndexOf('>'))).map(parseType);
  switch (head) {
    case 'List':
      return T.list(args[0] ?? T.any);
    case 'Set':
      return T.set(args[0] ?? T.any);
    case 'Map':
      return T.map(args[0] ?? T.any, args[1] ?? T.any);
    case 'Option':
      return T.option(args[0] ?? T.any);
    case 'Future':
      return T.future(args[0] ?? T.any);
    case 'Result':
      return T.result(args[0] ?? T.any, args[1] ?? T.string);
    default:
      return T.named(head, ...args);
  }
}

function matchParen(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return s.length - 1;
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Stable colour key for a type, used by the node editor to tint ports. */
export function typeColorKey(t: TypeRef): string {
  switch (t.kind) {
    case 'exec':
      return 'exec';
    case 'void':
      return 'void';
    case 'any':
      return 'any';
    case 'primitive':
      return isNumeric(t) ? 'number' : t.name;
    case 'list':
    case 'set':
    case 'tuple':
      return 'collection';
    case 'map':
      return 'map';
    case 'option':
      return typeColorKey(t.inner);
    case 'future':
      return 'future';
    case 'result':
      return 'result';
    case 'function':
      return 'function';
    default:
      return 'object';
  }
}
