/**
 * Lists, maps, sets and tuples.
 */

import type { NodeDefinition } from '../definition.ts';
import { port } from '../definition.ts';
import { builtinNode } from './factory.ts';
import { E, at } from '../../ir/build.ts';
import { T } from '../../types/types.ts';

export const collectionNodes: NodeDefinition[] = [
  // -------------------------------------------------------------------------
  {
    type: 'list/literal',
    category: 'List',
    title: 'List',
    description: 'Builds a list from a fixed number of element inputs.',
    keywords: ['array', 'collection', 'new', 'make'],
    pure: true,
    inputs: [port('e', 'element', 'T', { variadic: true })],
    outputs: [port('list', 'list', 'List<T>')],
    props: [{ name: 'itemType', label: 'Element type', kind: 'type', default: 'Any' }],
    ports(props) {
      const t = String(props.itemType ?? 'Any');
      return {
        inputs: [port('e', 'element', t, { variadic: true })],
        outputs: [port('list', 'list', `List<${t}>`)],
      };
    },
    color: '#34d399',
    lower(ctx) {
      const items = ctx.variadic('e');
      const listType = ctx.portType('list');
      const itemType = listType.kind === 'list' ? listType.item : (items[0]?.type ?? T.any);
      return { exprs: { list: at(E.array(items, itemType), ctx.origin) } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'map/literal',
    category: 'Map',
    title: 'Map',
    description: 'Builds a map from alternating key and value inputs.',
    keywords: ['dict', 'dictionary', 'object', 'hash', 'record'],
    pure: true,
    inputs: [port('k', 'key', 'string', { variadic: true }), port('v', 'value', 'Any', { variadic: true })],
    outputs: [port('map', 'map', 'Map<string, Any>')],
    props: [
      { name: 'keyType', label: 'Key type', kind: 'type', default: 'string' },
      { name: 'valueType', label: 'Value type', kind: 'type', default: 'Any' },
    ],
    ports(props) {
      const k = String(props.keyType ?? 'string');
      const v = String(props.valueType ?? 'Any');
      return {
        inputs: [port('k', 'key', k, { variadic: true }), port('v', 'value', v, { variadic: true })],
        outputs: [port('map', 'map', `Map<${k}, ${v}>`)],
      };
    },
    color: '#34d399',
    lower(ctx) {
      const keys = ctx.variadic('k');
      const values = ctx.variadic('v');
      if (keys.length !== values.length) {
        ctx.warn(
          'map/unbalanced',
          `Map has ${keys.length} keys but ${values.length} values; extra entries are dropped.`,
        );
      }
      const n = Math.min(keys.length, values.length);
      const entries = Array.from({ length: n }, (_, i) => ({ key: keys[i], value: values[i] }));
      const mapType = ctx.portType('map');
      const kt = mapType.kind === 'map' ? mapType.key : T.string;
      const vt = mapType.kind === 'map' ? mapType.value : T.any;
      return { exprs: { map: at(E.mapLit(entries, kt, vt), ctx.origin) } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'tuple/literal',
    category: 'Data',
    title: 'Tuple',
    description: 'Groups several values into one, for returning multiple results.',
    keywords: ['pair', 'group', 'multiple', 'record'],
    pure: true,
    inputs: [port('e', 'item', 'Any', { variadic: true })],
    outputs: [port('tuple', 'tuple', 'Any')],
    color: '#34d399',
    lower(ctx) {
      const items = ctx.variadic('e');
      return { exprs: { tuple: at(E.tuple(items), ctx.origin) } };
    },
  },

  // -- list ------------------------------------------------------------------
  builtinNode({ type: 'list/new', category: 'List', title: 'Empty List', op: 'list_new', args: [], result: 'list', color: '#34d399' }),
  builtinNode({ type: 'list/get', category: 'List', title: 'Get At', op: 'list_get', args: ['list', { name: 'index', default: 0 }], result: 'item', color: '#34d399' }),
  builtinNode({ type: 'list/set', category: 'List', title: 'Set At', op: 'list_set', args: ['list', { name: 'index', default: 0 }, 'value'], color: '#34d399' }),
  builtinNode({ type: 'list/push', category: 'List', title: 'Append', op: 'list_push', args: ['list', 'value'], color: '#34d399', keywords: ['add', 'push', 'append'] }),
  builtinNode({ type: 'list/pop', category: 'List', title: 'Pop', op: 'list_pop', args: ['list'], result: 'item', color: '#34d399' }),
  builtinNode({ type: 'list/insert', category: 'List', title: 'Insert', op: 'list_insert', args: ['list', { name: 'index', default: 0 }, 'value'], color: '#34d399' }),
  builtinNode({ type: 'list/remove-at', category: 'List', title: 'Remove At', op: 'list_remove_at', args: ['list', { name: 'index', default: 0 }], color: '#34d399' }),
  builtinNode({ type: 'list/length', category: 'List', title: 'Length', op: 'len', args: ['list'], result: 'length', color: '#34d399' }),
  builtinNode({ type: 'list/contains', category: 'List', title: 'Contains', op: 'list_contains', args: ['list', 'value'], result: 'found', color: '#34d399' }),
  builtinNode({ type: 'list/index-of', category: 'List', title: 'Index Of', op: 'list_index_of', args: ['list', 'value'], result: 'index', color: '#34d399' }),
  builtinNode({ type: 'list/slice', category: 'List', title: 'Slice', op: 'list_slice', args: ['list', { name: 'start', default: 0 }, { name: 'end', default: 0 }], result: 'slice', color: '#34d399' }),
  builtinNode({ type: 'list/concat', category: 'List', title: 'Concat', op: 'list_concat', args: ['a', 'b'], result: 'list', color: '#34d399' }),
  builtinNode({ type: 'list/reverse', category: 'List', title: 'Reverse', op: 'list_reverse', args: ['list'], result: 'list', color: '#34d399' }),
  builtinNode({ type: 'list/sort', category: 'List', title: 'Sort', op: 'list_sort', args: ['list'], result: 'list', color: '#34d399' }),
  builtinNode({ type: 'list/sort-by', category: 'List', title: 'Sort By Key', op: 'list_sort_by', args: ['list', 'key'], result: 'list', color: '#34d399' }),
  builtinNode({ type: 'list/unique', category: 'List', title: 'Unique', op: 'list_unique', args: ['list'], result: 'list', color: '#34d399' }),
  builtinNode({ type: 'list/sum', category: 'List', title: 'Sum', op: 'list_sum', args: ['list'], result: 'total', color: '#34d399' }),
  builtinNode({ type: 'list/min', category: 'List', title: 'Minimum', op: 'list_min', args: ['list'], result: 'value', color: '#34d399' }),
  builtinNode({ type: 'list/max', category: 'List', title: 'Maximum', op: 'list_max', args: ['list'], result: 'value', color: '#34d399' }),
  builtinNode({ type: 'list/range', category: 'List', title: 'Range', op: 'list_range', args: [{ name: 'start', default: 0 }, { name: 'end', default: 10 }], result: 'list', color: '#34d399' }),
  builtinNode({ type: 'list/is-empty', category: 'List', title: 'Is Empty', op: 'is_empty', args: ['collection'], result: 'empty', color: '#34d399' }),

  // -- map -------------------------------------------------------------------
  builtinNode({ type: 'map/new', category: 'Map', title: 'Empty Map', op: 'map_new', args: [], result: 'map', color: '#34d399' }),
  builtinNode({ type: 'map/get', category: 'Map', title: 'Get', op: 'map_get', args: ['map', 'key'], result: 'value', color: '#34d399' }),
  builtinNode({ type: 'map/get-or', category: 'Map', title: 'Get Or Default', op: 'map_get_or', args: ['map', 'key', 'fallback'], result: 'value', color: '#34d399' }),
  builtinNode({ type: 'map/set', category: 'Map', title: 'Set', op: 'map_set', args: ['map', 'key', 'value'], color: '#34d399' }),
  builtinNode({ type: 'map/has', category: 'Map', title: 'Has Key', op: 'map_has', args: ['map', 'key'], result: 'found', color: '#34d399' }),
  builtinNode({ type: 'map/remove', category: 'Map', title: 'Remove Key', op: 'map_remove', args: ['map', 'key'], color: '#34d399' }),
  builtinNode({ type: 'map/keys', category: 'Map', title: 'Keys', op: 'map_keys', args: ['map'], result: 'keys', color: '#34d399' }),
  builtinNode({ type: 'map/values', category: 'Map', title: 'Values', op: 'map_values', args: ['map'], result: 'values', color: '#34d399' }),

  // -- set -------------------------------------------------------------------
  builtinNode({ type: 'set/new', category: 'Set', title: 'Empty Set', op: 'set_new', args: [], result: 'set', color: '#34d399' }),
  builtinNode({ type: 'set/add', category: 'Set', title: 'Add', op: 'set_add', args: ['set', 'value'], color: '#34d399' }),
  builtinNode({ type: 'set/has', category: 'Set', title: 'Has', op: 'set_has', args: ['set', 'value'], result: 'found', color: '#34d399' }),
  builtinNode({ type: 'set/remove', category: 'Set', title: 'Remove', op: 'set_remove', args: ['set', 'value'], color: '#34d399' }),
  builtinNode({ type: 'set/to-list', category: 'Set', title: 'To List', op: 'set_to_list', args: ['set'], result: 'list', color: '#34d399' }),
];
