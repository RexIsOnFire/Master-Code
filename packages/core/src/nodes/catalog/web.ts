/**
 * Browser nodes: DOM queries, mutation and event wiring.
 *
 * These are restricted to the JavaScript backend. The registry filters the
 * palette by language, so they simply do not appear when a Python or Rust file
 * is open - a graph cannot accidentally contain a node its target cannot emit.
 */

import type { NodeDefinition } from '../definition.ts';
import { execIn, execOut, port } from '../definition.ts';
import { builtinNode } from './factory.ts';
import { E, S, at } from '../../ir/build.ts';
import { T } from '../../types/types.ts';

const JS = ['javascript'];

export const webNodes: NodeDefinition[] = [
  builtinNode({ type: 'dom/query', category: 'DOM', title: 'Query Selector', op: 'dom_query', args: [{ name: 'selector', default: '#app' }], result: 'element', languages: JS, keywords: ['find', 'select', 'element', 'get'], color: '#e879f9' }),
  builtinNode({ type: 'dom/query-all', category: 'DOM', title: 'Query All', op: 'dom_query_all', args: [{ name: 'selector', default: '.item' }], result: 'elements', languages: JS, color: '#e879f9' }),
  builtinNode({ type: 'dom/create', category: 'DOM', title: 'Create Element', op: 'dom_create', args: [{ name: 'tag', default: 'div' }], result: 'element', languages: JS, color: '#e879f9' }),
  builtinNode({ type: 'dom/set-text', category: 'DOM', title: 'Set Text', op: 'dom_set_text', args: ['element', 'text'], languages: JS, color: '#e879f9' }),
  builtinNode({ type: 'dom/get-value', category: 'DOM', title: 'Get Value', op: 'dom_get_value', args: ['element'], result: 'value', languages: JS, color: '#e879f9' }),
  builtinNode({ type: 'dom/set-value', category: 'DOM', title: 'Set Value', op: 'dom_set_value', args: ['element', 'value'], languages: JS, color: '#e879f9' }),
  builtinNode({ type: 'dom/set-attr', category: 'DOM', title: 'Set Attribute', op: 'dom_set_attr', args: ['element', { name: 'name', default: 'class' }, 'value'], languages: JS, color: '#e879f9' }),
  builtinNode({ type: 'dom/add-class', category: 'DOM', title: 'Add Class', op: 'dom_add_class', args: ['element', { name: 'class', default: 'active' }], languages: JS, color: '#e879f9' }),
  builtinNode({ type: 'dom/remove-class', category: 'DOM', title: 'Remove Class', op: 'dom_remove_class', args: ['element', { name: 'class', default: 'active' }], languages: JS, color: '#e879f9' }),
  builtinNode({ type: 'dom/append', category: 'DOM', title: 'Append Child', op: 'dom_append', args: ['parent', 'child'], languages: JS, color: '#e879f9' }),

  // -------------------------------------------------------------------------
  {
    type: 'dom/on-event',
    category: 'DOM',
    title: 'On Event',
    description: 'Attaches an event listener to an element. The handler chain runs on every event.',
    keywords: ['click', 'listen', 'input', 'submit', 'change', 'callback'],
    languages: JS,
    styles: ['event-driven', 'component', 'procedural'],
    inputs: [execIn(), port('element', 'element', 'Element')],
    outputs: [execOut(), execOut('handler', 'on event'), port('event', 'event', 'Any', { bound: true })],
    props: [
      {
        name: 'event',
        label: 'Event',
        kind: 'select',
        default: 'click',
        options: ['click', 'input', 'change', 'submit', 'keydown', 'keyup', 'focus', 'blur', 'mouseenter', 'mouseleave'].map(
          (v) => ({ value: v, label: v }),
        ),
      },
      { name: 'preventDefault', label: 'Prevent default', kind: 'boolean', default: false },
    ],
    color: '#e879f9',
    lower(ctx) {
      ctx.bindOutput('event', E.ref('event', T.any));
      const body = ctx.execBranch('handler');
      if (ctx.prop('preventDefault', false)) {
        body.unshift(S.expr(E.method(E.ref('event', T.any), 'preventDefault', [], T.void)));
      }
      const handler = E.lambda([{ name: 'event', type: T.any }], body, T.void);
      return {
        stmts: [
          at(
            S.expr(
              E.builtin('dom_on', [ctx.input('element'), E.str(ctx.prop('event', 'click')), handler], T.void),
            ),
            ctx.origin,
          ),
          ...ctx.execBranch('out'),
        ],
        exprs: { event: E.ref('event', T.any) },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'dom/on-ready',
    category: 'DOM',
    title: 'On Page Ready',
    description: 'Runs a chain once the document has finished parsing. The usual root of a browser graph.',
    keywords: ['load', 'domcontentloaded', 'start', 'init', 'boot'],
    languages: JS,
    styles: ['event-driven', 'component', 'procedural'],
    root: true,
    inputs: [],
    outputs: [execOut('out', 'body')],
    color: '#e879f9',
    lower(ctx) {
      const body = ctx.execBranch('out');
      return {
        decls: [
          {
            k: 'function',
            name: 'onReady',
            params: [],
            returns: T.void,
            body,
            visibility: 'public',
            doc: 'Runs once the document is ready.',
            origin: ctx.origin,
          },
        ],
        stmts: [],
      };
    },
  },
];

/**
 * The `dom/on-ready` node emits a function; the JavaScript backend is
 * responsible for registering it. Exposing the expected name here keeps that
 * coupling explicit rather than magic.
 */
export const DOM_READY_FUNCTION = 'onReady';
