/**
 * The builtin operation surface.
 *
 * The IR has no standard library of its own. Instead it has `builtin` nodes
 * naming an abstract operation, and each backend emits whatever that operation
 * means idiomatically in its language - `len(x)` becomes `len(x)` in Python,
 * `x.length` in JavaScript, `x.len()` in Rust, `strlen(x)` or `x.size()` in C
 * or C++ depending on the argument type.
 *
 * This registry is the contract. A backend that does not implement an op must
 * say so (`BackendGenError`), never guess - a silently wrong translation is
 * far worse than a build-time refusal.
 */

import type { Capability } from './ir.ts';
import type { TypeRef } from '../types/types.ts';
import { T } from '../types/types.ts';

export interface BuiltinSpec {
  op: string;
  category: string;
  /** Parameter types; may contain type variables resolved at the call site. */
  params: TypeRef[];
  returns: TypeRef;
  /** True when trailing parameters repeat (`print(a, b, c)`). */
  variadic?: boolean;
  caps?: Capability[];
  doc: string;
  /** Ops with side effects are never inlined twice by the lowering pass. */
  effectful?: boolean;
  /**
   * True when at least one backend implements this as an asynchronous call, so
   * the caller has to wait for it before the next statement means anything.
   * See `lower/async.ts`; languages where the call already blocks ignore it.
   */
  suspends?: boolean;
}

const A = T.var('T');
const B = T.var('U');
const K = T.var('K');
const V = T.var('V');

function b(
  op: string,
  category: string,
  params: TypeRef[],
  returns: TypeRef,
  doc: string,
  extra: Partial<BuiltinSpec> = {},
): BuiltinSpec {
  return { op, category, params, returns, doc, ...extra };
}

export const BUILTINS: BuiltinSpec[] = [
  // -- console -------------------------------------------------------------
  b('print', 'io', [T.any], T.void, 'Write values to standard output followed by a newline.', {
    variadic: true,
    caps: ['stdio'],
    effectful: true,
  }),
  b('print_err', 'io', [T.any], T.void, 'Write values to standard error.', {
    variadic: true,
    caps: ['stdio'],
    effectful: true,
  }),
  b('read_line', 'io', [], T.string, 'Read one line from standard input.', {
    caps: ['stdio'],
    effectful: true,
  }),

  // -- conversion ----------------------------------------------------------
  b('to_string', 'convert', [T.any], T.string, 'Human-readable rendering of any value.'),
  b('to_int', 'convert', [T.any], T.i64, 'Truncating conversion to a 64-bit integer.'),
  b('to_float', 'convert', [T.any], T.f64, 'Conversion to a double.'),
  b('parse_int', 'convert', [T.string], T.option(T.i64), 'Parse an integer, empty on failure.'),
  b('parse_float', 'convert', [T.string], T.option(T.f64), 'Parse a double, empty on failure.'),

  // -- generic collection --------------------------------------------------
  b('len', 'collection', [T.any], T.i64, 'Number of elements in a string, list, set or map.'),
  b('is_empty', 'collection', [T.any], T.bool, 'True when the container has no elements.'),

  // -- string --------------------------------------------------------------
  b('str_concat', 'string', [T.string, T.string], T.string, 'Join two strings.'),
  b('str_upper', 'string', [T.string], T.string, 'Upper-case a string.'),
  b('str_lower', 'string', [T.string], T.string, 'Lower-case a string.'),
  b('str_trim', 'string', [T.string], T.string, 'Strip leading and trailing whitespace.'),
  b('str_split', 'string', [T.string, T.string], T.list(T.string), 'Split on a separator.'),
  b('str_join', 'string', [T.list(T.string), T.string], T.string, 'Join with a separator.'),
  b('str_replace', 'string', [T.string, T.string, T.string], T.string, 'Replace every occurrence.'),
  b('str_contains', 'string', [T.string, T.string], T.bool, 'Substring test.'),
  b('str_starts_with', 'string', [T.string, T.string], T.bool, 'Prefix test.'),
  b('str_ends_with', 'string', [T.string, T.string], T.bool, 'Suffix test.'),
  b('str_index_of', 'string', [T.string, T.string], T.i64, 'First index of a substring, -1 if absent.'),
  b('str_substring', 'string', [T.string, T.i64, T.i64], T.string, 'Slice by [start, end).'),
  b('str_char_at', 'string', [T.string, T.i64], T.string, 'One-character string at an index.'),
  b('str_repeat', 'string', [T.string, T.i64], T.string, 'Repeat a string n times.'),
  b('str_pad_left', 'string', [T.string, T.i64, T.string], T.string, 'Left-pad to a width.'),
  b(
    'format',
    'string',
    [T.string, T.any],
    T.string,
    'Interpolate `{}` placeholders in order with the remaining arguments.',
    { variadic: true },
  ),

  // -- list ----------------------------------------------------------------
  b('list_new', 'list', [], T.list(A), 'A new empty list, ready to have elements appended.'),
  b('list_get', 'list', [T.list(A), T.i64], A, 'Element at an index.'),
  b('list_set', 'list', [T.list(A), T.i64, A], T.void, 'Replace the element at an index.', { effectful: true }),
  b('list_push', 'list', [T.list(A), A], T.void, 'Append an element.', { effectful: true }),
  b('list_pop', 'list', [T.list(A)], T.option(A), 'Remove and return the last element.', { effectful: true }),
  b('list_insert', 'list', [T.list(A), T.i64, A], T.void, 'Insert before an index.', { effectful: true }),
  b('list_remove_at', 'list', [T.list(A), T.i64], T.void, 'Remove the element at an index.', { effectful: true }),
  b('list_contains', 'list', [T.list(A), A], T.bool, 'Membership test.'),
  b('list_index_of', 'list', [T.list(A), A], T.i64, 'First index of a value, -1 if absent.'),
  b('list_slice', 'list', [T.list(A), T.i64, T.i64], T.list(A), 'Copy of the range [start, end).'),
  b('list_concat', 'list', [T.list(A), T.list(A)], T.list(A), 'Concatenation as a new list.'),
  b('list_reverse', 'list', [T.list(A)], T.list(A), 'Reversed copy.'),
  b('list_sort', 'list', [T.list(A)], T.list(A), 'Ascending sorted copy, natural ordering.'),
  b('list_sort_by', 'list', [T.list(A), T.fn([A], T.f64)], T.list(A), 'Sorted copy, ordered by a key function.'),
  b('list_map', 'list', [T.list(A), T.fn([A], B)], T.list(B), 'Apply a function to each element.'),
  b('list_filter', 'list', [T.list(A), T.fn([A], T.bool)], T.list(A), 'Keep elements matching a predicate.'),
  b('list_reduce', 'list', [T.list(A), T.fn([B, A], B), B], B, 'Fold left with an initial accumulator.'),
  b('list_any', 'list', [T.list(A), T.fn([A], T.bool)], T.bool, 'True when any element matches.'),
  b('list_all', 'list', [T.list(A), T.fn([A], T.bool)], T.bool, 'True when every element matches.'),
  b('list_find', 'list', [T.list(A), T.fn([A], T.bool)], T.option(A), 'First matching element.'),
  b('list_sum', 'list', [T.list(T.f64)], T.f64, 'Sum of a numeric list.'),
  b('list_min', 'list', [T.list(T.f64)], T.option(T.f64), 'Smallest element.'),
  b('list_max', 'list', [T.list(T.f64)], T.option(T.f64), 'Largest element.'),
  b('list_unique', 'list', [T.list(A)], T.list(A), 'Copy with duplicates removed, order preserved.'),
  b('list_range', 'list', [T.i64, T.i64], T.list(T.i64), 'Integers from start (inclusive) to end (exclusive).'),

  // -- map -----------------------------------------------------------------
  b('map_new', 'map', [], T.map(K, V), 'A new empty map, ready to have entries added.'),
  b('map_get', 'map', [T.map(K, V), K], T.option(V), 'Value for a key, empty when absent.'),
  b('map_get_or', 'map', [T.map(K, V), K, V], V, 'Value for a key, or a fallback.'),
  b('map_set', 'map', [T.map(K, V), K, V], T.void, 'Insert or replace.', { effectful: true }),
  b('map_has', 'map', [T.map(K, V), K], T.bool, 'Key presence test.'),
  b('map_remove', 'map', [T.map(K, V), K], T.void, 'Delete a key.', { effectful: true }),
  b('map_keys', 'map', [T.map(K, V)], T.list(K), 'Keys as a list.'),
  b('map_values', 'map', [T.map(K, V)], T.list(V), 'Values as a list.'),

  // -- set -----------------------------------------------------------------
  b('set_new', 'set', [], T.set(A), 'A new empty set, ready to have members added.'),
  b('set_add', 'set', [T.set(A), A], T.void, 'Add an element.', { effectful: true }),
  b('set_has', 'set', [T.set(A), A], T.bool, 'Membership test.'),
  b('set_remove', 'set', [T.set(A), A], T.void, 'Remove an element.', { effectful: true }),
  b('set_to_list', 'set', [T.set(A)], T.list(A), 'Elements as a list.'),

  // -- math ----------------------------------------------------------------
  b('math_abs', 'math', [T.f64], T.f64, 'Absolute value.'),
  b('math_floor', 'math', [T.f64], T.i64, 'Round toward negative infinity.'),
  b('math_ceil', 'math', [T.f64], T.i64, 'Round toward positive infinity.'),
  b('math_round', 'math', [T.f64], T.i64, 'Round half away from zero.'),
  b('math_sqrt', 'math', [T.f64], T.f64, 'Square root.'),
  b('math_pow', 'math', [T.f64, T.f64], T.f64, 'Exponentiation.'),
  b('math_min', 'math', [T.f64, T.f64], T.f64, 'Smaller of two numbers.'),
  b('math_max', 'math', [T.f64, T.f64], T.f64, 'Larger of two numbers.'),
  b('math_log', 'math', [T.f64], T.f64, 'Natural logarithm.'),
  b('math_exp', 'math', [T.f64], T.f64, 'e raised to a power.'),
  b('math_sin', 'math', [T.f64], T.f64, 'Sine, radians.'),
  b('math_cos', 'math', [T.f64], T.f64, 'Cosine, radians.'),
  b('math_tan', 'math', [T.f64], T.f64, 'Tangent, radians.'),
  b('math_atan2', 'math', [T.f64, T.f64], T.f64, 'Two-argument arctangent.'),
  b('math_idiv', 'math', [T.i64, T.i64], T.i64, 'Truncating integer division.'),
  b('math_pi', 'math', [], T.f64, 'The constant pi.'),

  // -- json ----------------------------------------------------------------
  b('json_parse', 'json', [T.string], T.json, 'Parse JSON text into a dynamic value.'),
  b('json_stringify', 'json', [T.any, T.bool], T.string, 'Serialise to JSON; second argument pretty-prints.'),
  b('json_get', 'json', [T.json, T.string], T.json, 'Field of a JSON object.'),
  b('json_as_string', 'json', [T.json], T.string, 'Read a JSON value as text.'),
  b('json_as_number', 'json', [T.json], T.f64, 'Read a JSON value as a number.'),
  b('json_as_list', 'json', [T.json], T.list(T.json), 'Read a JSON value as an array.'),

  // -- filesystem ----------------------------------------------------------
  b('file_read_text', 'fs', [T.string], T.string, 'Read a whole UTF-8 file.', { caps: ['fs.read'], effectful: true }),
  b('file_write_text', 'fs', [T.string, T.string], T.void, 'Write a UTF-8 file, replacing it.', {
    caps: ['fs.write'],
    effectful: true,
  }),
  b('file_append_text', 'fs', [T.string, T.string], T.void, 'Append to a UTF-8 file.', {
    caps: ['fs.write'],
    effectful: true,
  }),
  b('file_exists', 'fs', [T.string], T.bool, 'Path existence test.', { caps: ['fs.read'], effectful: true }),
  b('file_delete', 'fs', [T.string], T.void, 'Delete a file.', { caps: ['fs.write'], effectful: true }),
  b('dir_list', 'fs', [T.string], T.list(T.string), 'Entry names in a directory.', {
    caps: ['fs.read'],
    effectful: true,
  }),
  b('dir_create', 'fs', [T.string], T.void, 'Create a directory and any missing parents.', {
    caps: ['fs.write'],
    effectful: true,
  }),
  b('path_join', 'fs', [T.string, T.string], T.string, 'Join two path segments.'),

  // -- network -------------------------------------------------------------
  b(
    'http_request',
    'net',
    [T.string, T.string, T.map(T.string, T.string), T.string],
    T.named('HttpResponse'),
    'Perform an HTTP request: method, url, headers, body.',
    { caps: ['net'], effectful: true, suspends: true },
  ),

  // -- scheduling ----------------------------------------------------------
  b(
    'schedule_every',
    'time',
    [T.i64, T.fn([], T.void)],
    T.void,
    'Run the task, wait the interval, repeat, for as long as the program runs. The interval is the gap between runs, so a task that takes longer than the interval delays the next one rather than overlapping with itself.',
    { caps: ['time'], effectful: true, suspends: true },
  ),

  // -- concurrency ---------------------------------------------------------
  // Enriching one indicator from five sources one after another takes as long
  // as all five put together, and the sources have no idea about each other.
  //
  // Both of these take a concurrency limit rather than starting everything at
  // once, and the limit is a parameter rather than a backend detail, because
  // the far end usually has an opinion: an API that allows ten requests a
  // second does not care that the language could open a thousand sockets.
  // Results keep the order of the input, whatever order they finished in.
  // If one task fails, the group fails with it.
  b(
    'parallel_map',
    'concurrent',
    [T.list(A), T.fn([A], B), T.i64],
    T.list(B),
    'Apply a function to every element, up to N at a time, and collect the results in the original order.',
    { effectful: true, suspends: true },
  ),
  b(
    'parallel_all',
    'concurrent',
    [T.list(T.fn([], A)), T.i64],
    T.list(A),
    'Run every task, up to N at a time, and collect the results in the original order.',
    { effectful: true, suspends: true },
  ),

  // -- serving -------------------------------------------------------------
  // The other half of the network: receiving. A webhook is how most systems
  // hand work to another system, and without this a graph could only poll.
  //
  // The handler is an ordinary function from request to reply, which is what
  // makes this portable: it is a promise-returning callback in JavaScript, a
  // request handler object in Python and a goroutine per connection in Go, but
  // the graph only ever sees "given a request, produce a reply".
  b(
    'http_serve',
    'net',
    [T.string, T.i64, T.fn([T.named('HttpRequest')], T.named('HttpReply'))],
    T.void,
    'Listen on host and port, answering every request with the handler. Does not return while the server is running.',
    { caps: ['net.listen'], effectful: true, suspends: true },
  ),
  b(
    'http_reply',
    'net',
    [T.i64, T.string, T.string],
    T.named('HttpReply'),
    'Build a reply: status, body, content type.',
  ),

  // -- structured access ---------------------------------------------------
  // Every API worth calling answers with something nested, and reaching into
  // it one level at a time turns four fields into twelve nodes.
  b(
    'json_path',
    'json',
    [T.any, T.string],
    T.option(T.any),
    'Follow a dotted path into a parsed value: `alert.device.hostname`, `items[0].id`. Empty when any step is missing, rather than an error - a field that is not there is the normal case, not a failure.',
  ),

  // -- database (SQLite, via each language stdlib or its canonical driver) --
  b('db_open', 'db', [T.string], T.named('DbConnection'), 'Open or create a SQLite database file.', {
    caps: ['fs.read', 'fs.write'],
    effectful: true,
  }),
  b('db_execute', 'db', [T.named('DbConnection'), T.string, T.list(T.any)], T.i64,
    'Run a parameterised statement; returns rows affected.', { caps: ['fs.write'], effectful: true }),
  b('db_query', 'db', [T.named('DbConnection'), T.string, T.list(T.any)], T.list(T.map(T.string, T.any)),
    'Run a parameterised query; returns rows as maps.', { caps: ['fs.read'], effectful: true }),
  b('db_close', 'db', [T.named('DbConnection')], T.void, 'Close a database connection.', { effectful: true }),

  // -- environment / time / random -----------------------------------------
  b('env_get', 'env', [T.string], T.option(T.string), 'Read an environment variable.', {
    caps: ['env'],
    effectful: true,
  }),
  b('args_get', 'env', [], T.list(T.string), 'Command-line arguments, excluding the program name.', {
    caps: ['env'],
  }),
  b('time_now_ms', 'time', [], T.i64, 'Milliseconds since the Unix epoch.', { caps: ['time'], effectful: true }),
  b('time_sleep_ms', 'time', [T.i64], T.void, 'Block for a number of milliseconds.', {
    caps: ['time'],
    effectful: true,
    suspends: true,
  }),
  b('random_float', 'random', [], T.f64, 'Uniform random double in [0, 1).', {
    caps: ['random'],
    effectful: true,
  }),
  b('random_int', 'random', [T.i64, T.i64], T.i64, 'Uniform random integer in [low, high).', {
    caps: ['random'],
    effectful: true,
  }),

  // -- errors and assertions -----------------------------------------------
  b('error_new', 'error', [T.string], T.named('Error'), 'Construct an error value with a message.'),
  b('error_message', 'error', [T.named('Error')], T.string, 'Message text of an error value.'),
  b('assert', 'test', [T.bool, T.string], T.void, 'Fail the test when the condition is false.', {
    effectful: true,
  }),
  b('assert_eq', 'test', [T.any, T.any, T.string], T.void, 'Fail the test when the two values differ.', {
    effectful: true,
  }),

  // -- optional values -----------------------------------------------------
  // Nine operations here return an Option - a parse that may fail, a lookup
  // that may miss, an environment variable that may be unset. Without a way to
  // consume one, every one of those is a dead end in a graph, so these three
  // are the other half of that contract: supply a fallback, ask whether there
  // is a value, or insist on one and fail loudly when it is absent.
  b('option_or', 'option', [T.option(A), A], A,
    'The value when present, the fallback when empty.'),
  b('option_is_some', 'option', [T.option(A)], T.bool,
    'True when the optional holds a value.'),
  b('option_unwrap', 'option', [T.option(A), T.string], A,
    'The value, or an error carrying the message when empty. For the case where an absent value is a bug rather than a branch - failing here beats a null travelling on to break somewhere with no context.'),

  // -- pattern matching ----------------------------------------------------
  // Analyst work is pattern work: pulling indicators out of an alert body,
  // deciding whether a hostname looks like one of ours, rewriting a field.
  //
  // The pattern string is handed to the host language's engine unchanged, so
  // the portable subset is what every target agrees on: literals, character
  // classes (including `\d \w \s` and their negations), anchors, `. ? * +`,
  // bounded repetition, alternation, and capturing or non-capturing groups.
  // Anything beyond that - named groups, lookbehind, possessive quantifiers,
  // recursion - is honoured by some engines and rejected by others, so a graph
  // that uses it stops being portable. Matching is case-sensitive; ask for
  // insensitivity with an inline `(?i)` prefix, which every supported engine
  // accepts.
  b('regex_match', 'regex', [T.string, T.string], T.bool,
    'True when the pattern is found anywhere in the text. Use anchors to demand a whole-string match.'),
  b('regex_find_all', 'regex', [T.string, T.string], T.list(T.string),
    'Every non-overlapping match of the pattern, in order. Empty when nothing matches.'),
  b('regex_capture', 'regex', [T.string, T.string], T.list(T.string),
    'Capture groups of the first match: index 0 is the whole match, 1 onwards the groups. Empty list when the pattern does not match; a group that took part in no match is an empty string.'),
  b('regex_replace', 'regex', [T.string, T.string, T.string], T.string,
    'Replace every match with the replacement text, in which `$1`..`$9` stand for capture groups and `$$` for a literal dollar.'),
  b('regex_split', 'regex', [T.string, T.string], T.list(T.string),
    'Split the text on every match of the pattern.'),

  // -- encoding ------------------------------------------------------------
  // Every integration on the far side of an HTTP call speaks one of these.
  b('base64_encode', 'encode', [T.string], T.string,
    'Standard base64 of the text\'s UTF-8 bytes, padded.'),
  b('base64_decode', 'encode', [T.string], T.string,
    'Decode standard base64 back to text. Input that is not valid base64 is an error, not silently empty.'),
  b('hex_encode', 'encode', [T.string], T.string,
    'Lower-case hexadecimal of the text\'s UTF-8 bytes.'),
  b('url_encode', 'encode', [T.string], T.string,
    'Percent-encode the text for use inside one query-string value: every character outside `A-Z a-z 0-9 - _ . ~` is escaped, space included.'),
  b('url_decode', 'encode', [T.string], T.string,
    'Reverse of url_encode.'),

  // -- digests -------------------------------------------------------------
  // Hashes are how one indicator is compared against another, so the exact
  // rendering matters: every one of these returns lower-case hex, never
  // upper-case and never base64, so that two graphs comparing the same file
  // agree regardless of which language each was generated into.
  b('hash_sha256', 'crypto', [T.string], T.string, 'SHA-256 of the text\'s UTF-8 bytes, as lower-case hex.'),
  b('hash_sha1', 'crypto', [T.string], T.string, 'SHA-1 of the text\'s UTF-8 bytes, as lower-case hex. Broken for signatures; still the identifier many feeds publish.'),
  b('hash_md5', 'crypto', [T.string], T.string, 'MD5 of the text\'s UTF-8 bytes, as lower-case hex. Broken for signatures; still the identifier many feeds publish.'),
  b('hmac_sha256', 'crypto', [T.string, T.string], T.string,
    'HMAC-SHA-256 of the message under the key, as lower-case hex. Arguments are (key, message), the order the signing docs of every major API use.'),

  // -- identity and wall-clock time ----------------------------------------
  b('uuid_v4', 'id', [], T.string,
    'A random version 4 UUID in the canonical lower-case hyphenated form.',
    { effectful: true }),
  b('time_now_iso', 'time', [], T.string,
    'The current UTC instant as ISO 8601 with milliseconds and a trailing Z.',
    { effectful: true }),
  b('time_parse_iso', 'time', [T.string], T.option(T.i64),
    'Milliseconds since the Unix epoch for an ISO 8601 timestamp, empty when the text does not parse. An offset is honoured; a timestamp with no zone is read as UTC.'),
  b('time_format_iso', 'time', [T.i64], T.string,
    'Milliseconds since the Unix epoch rendered as ISO 8601 UTC with milliseconds and a trailing Z. Inverse of time_parse_iso.'),

  // -- DOM (web targets only) ----------------------------------------------
  b(
    'dom_query',
    'dom',
    [T.string],
    T.named('Element'),
    'First element matching a CSS selector. Fails loudly when nothing matches, rather than returning a value that breaks later.',
    { effectful: true },
  ),
  b('dom_query_all', 'dom', [T.string], T.list(T.named('Element')), 'All elements matching a CSS selector.', {
    effectful: true,
  }),
  b('dom_create', 'dom', [T.string], T.named('Element'), 'Create an element by tag name.', { effectful: true }),
  b('dom_set_text', 'dom', [T.named('Element'), T.string], T.void, 'Replace an element\'s text content.', {
    effectful: true,
  }),
  b('dom_get_value', 'dom', [T.named('Element')], T.string, 'Value of an input element.', { effectful: true }),
  b('dom_set_value', 'dom', [T.named('Element'), T.string], T.void, 'Set the value of an input element.', {
    effectful: true,
  }),
  b('dom_set_attr', 'dom', [T.named('Element'), T.string, T.string], T.void, 'Set an attribute.', {
    effectful: true,
  }),
  b('dom_add_class', 'dom', [T.named('Element'), T.string], T.void, 'Add a CSS class.', { effectful: true }),
  b('dom_remove_class', 'dom', [T.named('Element'), T.string], T.void, 'Remove a CSS class.', { effectful: true }),
  b('dom_append', 'dom', [T.named('Element'), T.named('Element')], T.void, 'Append a child element.', {
    effectful: true,
  }),
  b('dom_on', 'dom', [T.named('Element'), T.string, T.fn([T.any], T.void)], T.void, 'Attach an event listener.', {
    effectful: true,
  }),
];

const BY_OP = new Map(BUILTINS.map((s) => [s.op, s]));

export function getBuiltin(op: string): BuiltinSpec | undefined {
  return BY_OP.get(op);
}

export function builtinCategories(): string[] {
  return [...new Set(BUILTINS.map((b) => b.category))];
}

/** Every builtin a program actually uses. Backends check this before emitting. */
export function builtinsUsed(ops: Iterable<string>): BuiltinSpec[] {
  const seen = new Set<string>();
  const out: BuiltinSpec[] = [];
  for (const op of ops) {
    if (seen.has(op)) continue;
    seen.add(op);
    const spec = BY_OP.get(op);
    if (spec) out.push(spec);
  }
  return out;
}
