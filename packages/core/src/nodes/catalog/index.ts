/**
 * The built-in node catalogue.
 *
 * Nothing here is special-cased by the compiler - these definitions go through
 * the same `NodeRegistry.register` a plugin uses. Deleting a group would remove
 * the vocabulary without breaking anything else.
 */

import { NodeRegistry } from '../definition.ts';
import type { NodeDefinition } from '../definition.ts';
import { controlNodes } from './control.ts';
import { dataNodes } from './data.ts';
import { collectionNodes } from './collections.ts';
import { ioNodes } from './io.ts';
import { oopNodes } from './oop.ts';
import { functionalNodes } from './functional.ts';
import { pipelineNodes } from './pipeline.ts';
import { concurrentNodes } from './concurrent.ts';
import { serveNodes } from './serve.ts';
import { textNodes } from './text.ts';
import { webNodes } from './web.ts';
import { customNodes } from './custom.ts';
import { libraryNodes } from './library.ts';

export const builtinNodes: NodeDefinition[] = [
  ...controlNodes,
  ...dataNodes,
  ...collectionNodes,
  ...ioNodes,
  ...oopNodes,
  ...functionalNodes,
  ...pipelineNodes,
  ...concurrentNodes,
  ...serveNodes,
  ...textNodes,
  ...webNodes,
  ...customNodes,
  ...libraryNodes,
];

/** A registry preloaded with the built-in catalogue. Plugins add to it. */
export function createDefaultRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.registerAll(builtinNodes, 'builtin');
  return registry;
}

export {
  controlNodes,
  dataNodes,
  collectionNodes,
  ioNodes,
  oopNodes,
  functionalNodes,
  pipelineNodes,
  concurrentNodes,
  serveNodes,
  textNodes,
  webNodes,
  customNodes,
};
