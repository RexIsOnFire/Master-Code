/**
 * Console, filesystem, network, database, environment and JSON nodes.
 *
 * Every node here declares a capability. The sandbox reads those off the IR
 * before the program is built, so a graph that touches the filesystem cannot
 * be run until the project grants `fs.read`/`fs.write`.
 */

import type { NodeDefinition } from '../definition.ts';
import { execIn, execOut, port } from '../definition.ts';
import { builtinNode, variadicBuiltinNode } from './factory.ts';
import { E, S, at } from '../../ir/build.ts';
import { T } from '../../types/types.ts';

export const ioNodes: NodeDefinition[] = [
  // -- console ---------------------------------------------------------------
  variadicBuiltinNode({
    type: 'io/print',
    category: 'Input / Output',
    title: 'Print',
    op: 'print',
    argName: 'value',
    keywords: ['output', 'console', 'log', 'write', 'display', 'show'],
    color: '#818cf8',
  }),
  variadicBuiltinNode({
    type: 'io/print-error',
    category: 'Input / Output',
    title: 'Print Error',
    op: 'print_err',
    argName: 'value',
    keywords: ['stderr', 'log', 'warn'],
    color: '#818cf8',
  }),
  builtinNode({
    type: 'io/read-line',
    category: 'Input / Output',
    title: 'Read Line',
    op: 'read_line',
    args: [],
    result: 'text',
    keywords: ['input', 'stdin', 'prompt', 'ask'],
    color: '#818cf8',
  }),

  // -------------------------------------------------------------------------
  {
    type: 'io/prompt',
    category: 'Input / Output',
    title: 'Prompt',
    description: 'Writes a prompt and reads one line of input.',
    keywords: ['input', 'ask', 'question', 'stdin'],
    inputs: [execIn(), port('message', 'message', 'string', { default: '> ' })],
    outputs: [execOut(), port('text', 'text', 'string')],
    caps: ['stdio'],
    color: '#818cf8',
    lower(ctx) {
      ctx.requireCapability('stdio');
      const tmp = ctx.temp('answer');
      const ref = E.ref(tmp, T.string);
      ctx.bindOutput('text', ref);
      const stmts = [
        at(S.expr(E.builtin('print', [ctx.input('message')], T.void, ['stdio'])), ctx.origin),
        at(S.let_(tmp, T.string, E.builtin('read_line', [], T.string, ['stdio']), false), ctx.origin),
      ];
      return { stmts: [...stmts, ...ctx.execBranch('out')], exprs: { text: ref } };
    },
  },

  // -- filesystem ------------------------------------------------------------
  builtinNode({ type: 'file/read', category: 'File', title: 'Read Text File', op: 'file_read_text', args: [{ name: 'path', default: 'data.txt' }], result: 'text', color: '#fb923c' }),
  builtinNode({ type: 'file/write', category: 'File', title: 'Write Text File', op: 'file_write_text', args: [{ name: 'path', default: 'out.txt' }, 'text'], color: '#fb923c' }),
  builtinNode({ type: 'file/append', category: 'File', title: 'Append Text File', op: 'file_append_text', args: [{ name: 'path', default: 'out.txt' }, 'text'], color: '#fb923c' }),
  builtinNode({ type: 'file/exists', category: 'File', title: 'File Exists', op: 'file_exists', args: [{ name: 'path', default: '' }], result: 'exists', color: '#fb923c' }),
  builtinNode({ type: 'file/delete', category: 'File', title: 'Delete File', op: 'file_delete', args: [{ name: 'path', default: '' }], color: '#fb923c' }),
  builtinNode({ type: 'file/list-dir', category: 'File', title: 'List Directory', op: 'dir_list', args: [{ name: 'path', default: '.' }], result: 'entries', color: '#fb923c' }),
  builtinNode({ type: 'file/make-dir', category: 'File', title: 'Create Directory', op: 'dir_create', args: [{ name: 'path', default: '' }], color: '#fb923c' }),
  builtinNode({ type: 'file/path-join', category: 'File', title: 'Join Path', op: 'path_join', args: ['a', 'b'], result: 'path', color: '#fb923c' }),

  // -- network ---------------------------------------------------------------
  {
    type: 'net/http-request',
    category: 'Network',
    title: 'HTTP Request',
    description: 'Performs an HTTP request and exposes the status, headers and body.',
    keywords: ['http', 'api', 'rest', 'fetch', 'get', 'post', 'url', 'web'],
    inputs: [
      execIn(),
      port('url', 'url', 'string', { default: 'https://example.com' }),
      port('body', 'body', 'string', { default: '' }),
      port('headers', 'headers', 'Map<string, string>', { advanced: true }),
    ],
    outputs: [
      execOut(),
      port('status', 'status', 'i64'),
      port('text', 'body', 'string'),
      port('ok', 'ok', 'bool'),
    ],
    props: [
      {
        name: 'method',
        label: 'Method',
        kind: 'select',
        default: 'GET',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((v) => ({ value: v, label: v })),
      },
    ],
    caps: ['net'],
    color: '#f87171',
    lower(ctx) {
      ctx.requireCapability('net');
      const headers = ctx.connected('headers')
        ? ctx.input('headers')
        : E.mapLit([], T.string, T.string);
      const resp = ctx.temp('response');
      const respType = T.named('HttpResponse');
      const call = at(
        E.builtin(
          'http_request',
          [E.str(ctx.prop('method', 'GET')), ctx.input('url'), headers, ctx.input('body')],
          respType,
          ['net'],
        ),
        ctx.origin,
      );
      const status = E.member(E.ref(resp, respType), 'status', T.i64);
      const exprs = {
        status,
        text: E.member(E.ref(resp, respType), 'body', T.string),
        ok: E.bin('&&', E.bin('>=', status, E.int(200), T.bool), E.bin('<', status, E.int(400), T.bool), T.bool),
      };
      for (const [portId, expr] of Object.entries(exprs)) ctx.bindOutput(portId, expr);
      const decl = at(S.let_(resp, respType, call, false), ctx.origin);
      return { stmts: [decl, ...ctx.execBranch('out')], exprs };
    },
  },

  // -- json ------------------------------------------------------------------
  builtinNode({ type: 'json/parse', category: 'JSON', title: 'Parse JSON', op: 'json_parse', args: ['text'], result: 'value', color: '#c084fc' }),
  builtinNode({ type: 'json/stringify', category: 'JSON', title: 'To JSON', op: 'json_stringify', args: ['value', { name: 'pretty', default: false }], result: 'text', color: '#c084fc' }),
  builtinNode({ type: 'json/get', category: 'JSON', title: 'JSON Field', op: 'json_get', args: ['value', { name: 'field', default: '' }], result: 'value', color: '#c084fc' }),
  builtinNode({ type: 'json/path', category: 'JSON', title: 'JSON Path', op: 'json_path', args: ['value', { name: 'path', default: 'a.b[0].c' }], result: 'value', keywords: ['nested', 'deep', 'field', 'dig', 'jsonpath', 'dotted'], color: '#c084fc' }),
  builtinNode({ type: 'json/as-string', category: 'JSON', title: 'JSON As String', op: 'json_as_string', args: ['value'], result: 'text', color: '#c084fc' }),
  builtinNode({ type: 'json/as-number', category: 'JSON', title: 'JSON As Number', op: 'json_as_number', args: ['value'], result: 'number', color: '#c084fc' }),
  builtinNode({ type: 'json/as-list', category: 'JSON', title: 'JSON As List', op: 'json_as_list', args: ['value'], result: 'items', color: '#c084fc' }),

  // -- database --------------------------------------------------------------
  builtinNode({ type: 'db/open', category: 'Database', title: 'Open Database', op: 'db_open', args: [{ name: 'path', default: 'app.db' }], result: 'db', keywords: ['sqlite', 'connect', 'sql'], color: '#2dd4bf' }),
  builtinNode({ type: 'db/execute', category: 'Database', title: 'Execute SQL', op: 'db_execute', args: ['db', { name: 'sql', default: '' }, 'params'], result: 'affected', keywords: ['insert', 'update', 'delete', 'sql'], color: '#2dd4bf' }),
  builtinNode({ type: 'db/query', category: 'Database', title: 'Query SQL', op: 'db_query', args: ['db', { name: 'sql', default: 'SELECT 1' }, 'params'], result: 'rows', keywords: ['select', 'sql', 'read'], color: '#2dd4bf' }),
  builtinNode({ type: 'db/close', category: 'Database', title: 'Close Database', op: 'db_close', args: ['db'], color: '#2dd4bf' }),

  // -- environment and time --------------------------------------------------
  builtinNode({ type: 'env/get', category: 'System', title: 'Environment Variable', op: 'env_get', args: [{ name: 'name', default: 'PATH' }], result: 'value', color: '#94a3b8' }),
  builtinNode({ type: 'env/args', category: 'System', title: 'Command Line Args', op: 'args_get', args: [], result: 'args', exec: false, color: '#94a3b8' }),
  builtinNode({ type: 'time/now', category: 'System', title: 'Now (ms)', op: 'time_now_ms', args: [], result: 'millis', color: '#94a3b8' }),
  builtinNode({ type: 'time/sleep', category: 'System', title: 'Sleep', op: 'time_sleep_ms', args: [{ name: 'millis', default: 100 }], color: '#94a3b8' }),
];
