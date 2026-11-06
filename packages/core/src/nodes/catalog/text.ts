/**
 * Pattern matching, encoding, digests, identifiers and timestamps.
 *
 * These are the operations that turn an opaque payload into something a graph
 * can branch on: find the addresses in a message body, sign a request, hash a
 * file, stamp a record. None of them touch the outside world, so none declares
 * a capability - the two that are non-deterministic (a random identifier, the
 * wall clock) are exec-threaded instead, so that two reads are two values
 * rather than one the compiler felt free to share.
 */

import type { NodeDefinition } from '../definition.ts';
import { builtinNode } from './factory.ts';

const PATTERN = '#f472b6';
const ENCODING = '#a3e635';
const DIGEST = '#38bdf8';
const IDENTITY = '#94a3b8';

export const textNodes: NodeDefinition[] = [
  // -- pattern matching ------------------------------------------------------
  builtinNode({
    type: 'regex/match',
    category: 'Pattern',
    title: 'Matches Pattern',
    op: 'regex_match',
    args: ['text', { name: 'pattern', default: '' }],
    result: 'matches',
    keywords: ['regex', 'regexp', 'test', 'search', 'find', 'pattern'],
    color: PATTERN,
  }),
  builtinNode({
    type: 'regex/find-all',
    category: 'Pattern',
    title: 'Find All',
    op: 'regex_find_all',
    args: ['text', { name: 'pattern', default: '' }],
    result: 'matches',
    keywords: ['regex', 'extract', 'scan', 'all', 'occurrences'],
    color: PATTERN,
  }),
  builtinNode({
    type: 'regex/capture',
    category: 'Pattern',
    title: 'Capture Groups',
    op: 'regex_capture',
    args: ['text', { name: 'pattern', default: '' }],
    result: 'groups',
    keywords: ['regex', 'group', 'parse', 'extract', 'submatch'],
    color: PATTERN,
  }),
  builtinNode({
    type: 'regex/replace',
    category: 'Pattern',
    title: 'Replace Pattern',
    op: 'regex_replace',
    args: ['text', { name: 'pattern', default: '' }, { name: 'replacement', default: '' }],
    result: 'text',
    keywords: ['regex', 'substitute', 'rewrite', 'redact', 'sub'],
    color: PATTERN,
  }),
  builtinNode({
    type: 'regex/split',
    category: 'Pattern',
    title: 'Split On Pattern',
    op: 'regex_split',
    args: ['text', { name: 'pattern', default: '\s+' }],
    result: 'parts',
    keywords: ['regex', 'tokenize', 'separate', 'split'],
    color: PATTERN,
  }),

  // -- encoding --------------------------------------------------------------
  builtinNode({
    type: 'encode/base64',
    category: 'Encoding',
    title: 'Base64 Encode',
    op: 'base64_encode',
    args: ['text'],
    result: 'encoded',
    keywords: ['base64', 'b64', 'encode', 'basic auth'],
    color: ENCODING,
  }),
  builtinNode({
    type: 'encode/base64-decode',
    category: 'Encoding',
    title: 'Base64 Decode',
    op: 'base64_decode',
    args: ['encoded'],
    result: 'text',
    keywords: ['base64', 'b64', 'decode'],
    color: ENCODING,
  }),
  builtinNode({
    type: 'encode/hex',
    category: 'Encoding',
    title: 'Hex Encode',
    op: 'hex_encode',
    args: ['text'],
    result: 'encoded',
    keywords: ['hex', 'hexadecimal', 'encode', 'bytes'],
    color: ENCODING,
  }),
  builtinNode({
    type: 'encode/url',
    category: 'Encoding',
    title: 'URL Encode',
    op: 'url_encode',
    args: ['text'],
    result: 'encoded',
    keywords: ['url', 'percent', 'escape', 'query', 'querystring'],
    color: ENCODING,
  }),
  builtinNode({
    type: 'encode/url-decode',
    category: 'Encoding',
    title: 'URL Decode',
    op: 'url_decode',
    args: ['encoded'],
    result: 'text',
    keywords: ['url', 'percent', 'unescape', 'query'],
    color: ENCODING,
  }),

  // -- digests ---------------------------------------------------------------
  builtinNode({
    type: 'hash/sha256',
    category: 'Digest',
    title: 'SHA-256',
    op: 'hash_sha256',
    args: ['text'],
    result: 'hex',
    keywords: ['hash', 'sha', 'sha256', 'digest', 'checksum', 'fingerprint'],
    color: DIGEST,
  }),
  builtinNode({
    type: 'hash/sha1',
    category: 'Digest',
    title: 'SHA-1',
    op: 'hash_sha1',
    args: ['text'],
    result: 'hex',
    keywords: ['hash', 'sha', 'sha1', 'digest', 'checksum'],
    color: DIGEST,
  }),
  builtinNode({
    type: 'hash/md5',
    category: 'Digest',
    title: 'MD5',
    op: 'hash_md5',
    args: ['text'],
    result: 'hex',
    keywords: ['hash', 'md5', 'digest', 'checksum'],
    color: DIGEST,
  }),
  builtinNode({
    type: 'hash/hmac-sha256',
    category: 'Digest',
    title: 'HMAC-SHA-256',
    op: 'hmac_sha256',
    args: ['key', 'message'],
    result: 'hex',
    keywords: ['hmac', 'sign', 'signature', 'secret', 'auth', 'mac'],
    color: DIGEST,
  }),

  // -- identity and time -----------------------------------------------------
  builtinNode({
    type: 'id/uuid',
    category: 'Identity',
    title: 'New UUID',
    op: 'uuid_v4',
    args: [],
    result: 'uuid',
    keywords: ['uuid', 'guid', 'id', 'identifier', 'random', 'unique'],
    color: IDENTITY,
  }),
  builtinNode({
    type: 'time/now-iso',
    category: 'System',
    title: 'Now (ISO 8601)',
    op: 'time_now_iso',
    args: [],
    result: 'timestamp',
    keywords: ['time', 'date', 'now', 'timestamp', 'utc', 'iso'],
    color: IDENTITY,
  }),
  builtinNode({
    type: 'time/parse-iso',
    category: 'System',
    title: 'Parse ISO 8601',
    op: 'time_parse_iso',
    args: [{ name: 'timestamp', default: '' }],
    result: 'millis',
    keywords: ['time', 'date', 'parse', 'epoch', 'iso'],
    color: IDENTITY,
  }),
  builtinNode({
    type: 'time/format-iso',
    category: 'System',
    title: 'Format ISO 8601',
    op: 'time_format_iso',
    args: [{ name: 'millis', default: 0 }],
    result: 'timestamp',
    keywords: ['time', 'date', 'format', 'epoch', 'iso', 'render'],
    color: IDENTITY,
  }),
];
