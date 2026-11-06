/**
 * Receiving HTTP: a listening port, and the reply that ends a handler.
 *
 * `net/http-request` is how a graph calls out. This is the other direction,
 * and without it a program can only ever poll - it can never be handed work.
 * A webhook is the usual way one system tells another that something happened,
 * so this is the node that lets a graph be the *callee* rather than only the
 * caller.
 *
 * The shape is deliberately the plainest one that every target can honour: a
 * handler is a function from a request to a reply. Underneath, that is a
 * promise-returning callback in JavaScript and a blocking handler object in
 * Python, but nothing about the graph says which.
 */

import type { NodeDefinition } from '../definition.ts';
import { execIn, execOut, port } from '../definition.ts';
import { E, S, at } from '../../ir/build.ts';
import type { IrFunction, IrStmt } from '../../ir/ir.ts';
import { T } from '../../types/types.ts';

const SERVE = '#f87171';

const REQUEST = T.named('HttpRequest');
const REPLY = T.named('HttpReply');

/** The handler name; the entry function registers this. */
const HANDLER = 'onRequest';

export const serveNodes: NodeDefinition[] = [
  {
    type: 'net/on-request',
    category: 'Network',
    title: 'On HTTP Request',
    description:
      'Listens on a port and runs the chain for every request. The chain should end in a Reply; one that does not is answered with 204.',
    keywords: ['webhook', 'server', 'listen', 'endpoint', 'receive', 'http', 'api', 'callback', 'hook'],
    styles: ['event-driven', 'service', 'procedural'],
    root: true,
    inputs: [],
    outputs: [
      execOut('out', 'on request'),
      port('method', 'method', 'string', { bound: true }),
      port('path', 'path', 'string', { bound: true }),
      port('body', 'body', 'string', { bound: true }),
      port('headers', 'headers', 'Map<string, string>', { bound: true }),
      port('query', 'query', 'Map<string, string>', { bound: true }),
    ],
    props: [
      {
        name: 'host',
        label: 'Host',
        kind: 'string',
        default: '127.0.0.1',
        doc: 'Interface to bind. 127.0.0.1 accepts only local connections; 0.0.0.0 accepts any.',
      },
      { name: 'port', label: 'Port', kind: 'number', default: 8080 },
    ],
    caps: ['net.listen'],
    color: SERVE,
    validate(node, _project, diag) {
      const value = Number(node.props.port ?? 0);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        diag.error('graph', 'serve/bad-port', `Port must be a whole number from 1 to 65535, not "${node.props.port}".`, {
          origin: { nodeId: node.id },
        });
      }
    },
    lower(ctx) {
      ctx.requireCapability('net.listen');

      const request = E.ref('request', REQUEST);
      const fields = {
        method: E.member(request, 'method', T.string),
        path: E.member(request, 'path', T.string),
        body: E.member(request, 'body', T.string),
        headers: E.member(request, 'headers', T.map(T.string, T.string)),
        query: E.member(request, 'query', T.map(T.string, T.string)),
      };
      for (const [id, expr] of Object.entries(fields)) ctx.bindOutput(id, expr);

      // A handler that falls off the end still owes the caller an answer, so
      // the empty reply is appended rather than left to the runtime to invent.
      // A chain that already ends in a Reply needs no such tail, and emitting
      // one anyway would leave unreachable code in every generated handler.
      const chain = ctx.execBranch('out');
      const answered = chain[chain.length - 1]?.k === 'return';
      const body: IrStmt[] = answered
        ? chain
        : [
            ...chain,
            at(
              S.return_(E.builtin('http_reply', [E.int(204), E.str(''), E.str('text/plain')], REPLY)),
              ctx.origin,
            ),
          ];

      const handler: IrFunction = {
        k: 'function',
        name: HANDLER,
        params: [{ name: 'request', type: REQUEST }],
        returns: REPLY,
        body,
        visibility: 'public',
        origin: ctx.origin,
        doc: 'Answers one HTTP request.',
      };

      const serve: IrFunction = {
        k: 'function',
        name: 'serve',
        params: [],
        returns: T.void,
        body: [
          at(
            S.expr(
              E.builtin(
                'http_serve',
                [
                  E.str(String(ctx.prop('host', '127.0.0.1'))),
                  E.int(Number(ctx.prop('port', 8080))),
                  E.symbol(HANDLER, T.fn([REQUEST], REPLY)),
                ],
                T.void,
                ['net.listen'],
              ),
            ),
            ctx.origin,
          ),
        ],
        isEntry: true,
        visibility: 'public',
        origin: ctx.origin,
        doc: 'Starts the listener. Does not return while the server is running.',
      };

      return { decls: [handler, serve], exprs: fields };
    },
  },

  // ---------------------------------------------------------------------------
  {
    type: 'time/every',
    category: 'Network',
    title: 'Every',
    description:
      'Runs the chain, waits, and runs it again, for as long as the program is up. The wait is the gap between runs, so a slow run delays the next one rather than overlapping it.',
    keywords: ['schedule', 'poll', 'timer', 'cron', 'interval', 'repeat', 'recurring', 'tick'],
    styles: ['event-driven', 'service', 'procedural'],
    root: true,
    inputs: [],
    outputs: [execOut('out', 'each time')],
    props: [
      {
        name: 'seconds',
        label: 'Every (seconds)',
        kind: 'number',
        default: 60,
        doc: 'Gap between runs. A poller that reads a feed usually wants this no shorter than the feed updates.',
      },
    ],
    caps: ['time'],
    color: SERVE,
    validate(node, _project, diag) {
      if (Number(node.props.seconds ?? 0) <= 0) {
        diag.error('graph', 'schedule/bad-interval', 'The interval must be greater than zero seconds.', {
          origin: { nodeId: node.id },
        });
      }
    },
    lower(ctx) {
      ctx.requireCapability('time');
      const body = ctx.execBranch('out');

      const tick: IrFunction = {
        k: 'function',
        name: 'tick',
        params: [],
        returns: T.void,
        body: body.length ? body : [S.note('nothing to do yet')],
        visibility: 'public',
        origin: ctx.origin,
        doc: 'One run of the scheduled chain.',
      };

      const millis = Math.max(1, Math.round(Number(ctx.prop('seconds', 60)) * 1000));
      const start: IrFunction = {
        k: 'function',
        name: 'startSchedule',
        params: [],
        returns: T.void,
        body: [
          at(
            S.expr(
              E.builtin(
                'schedule_every',
                [E.int(millis), E.symbol('tick', T.fn([], T.void))],
                T.void,
                ['time'],
              ),
            ),
            ctx.origin,
          ),
        ],
        isEntry: true,
        visibility: 'public',
        origin: ctx.origin,
        doc: 'Starts the schedule. Does not return while the program is running.',
      };

      return { decls: [tick, start] };
    },
  },

  // ---------------------------------------------------------------------------
  {
    type: 'net/reply',
    category: 'Network',
    title: 'Reply',
    description:
      'Answers the current HTTP request and ends the handler. Nothing after this node in the chain runs.',
    keywords: ['respond', 'response', 'answer', 'return', 'status', 'send'],
    styles: ['event-driven', 'service', 'procedural'],
    inputs: [
      execIn(),
      port('status', 'status', 'i64', { default: 200 }),
      port('body', 'body', 'string', { default: '' }),
      port('contentType', 'content type', 'string', { default: 'application/json', advanced: true }),
    ],
    outputs: [],
    color: SERVE,
    lower(ctx) {
      return {
        stmts: [
          at(
            S.return_(
              E.builtin(
                'http_reply',
                [ctx.input('status'), ctx.input('body'), ctx.input('contentType')],
                REPLY,
              ),
            ),
            ctx.origin,
          ),
        ],
      };
    },
  },
];
