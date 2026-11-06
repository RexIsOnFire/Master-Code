/**
 * The built-in language adapters.
 *
 * Registration order is display order in the UI. Nothing else in the core
 * imports these directly - they are reached through the registry, which is the
 * same door a plugin-provided language walks through.
 */

import { BackendRegistry } from './backend.ts';
import type { LanguageBackend } from './backend.ts';
import { pythonBackend } from './python.ts';
import { javascriptBackend } from './javascript.ts';
import { htmlBackend } from './html.ts';
import { cssBackend } from './css.ts';
import { javaBackend } from './java.ts';
import { kotlinBackend } from './kotlin.ts';
import { csharpBackend } from './csharp.ts';
import { goBackend } from './go.ts';
import { rustBackend } from './rust.ts';
import { cppBackend } from './cpp.ts';
import { cBackend } from './c.ts';

export const builtinBackends: LanguageBackend[] = [
  pythonBackend,
  javascriptBackend,
  htmlBackend,
  cssBackend,
  javaBackend,
  kotlinBackend,
  csharpBackend,
  goBackend,
  rustBackend,
  cppBackend,
  cBackend,
];

export function createDefaultBackends(): BackendRegistry {
  const registry = new BackendRegistry();
  for (const b of builtinBackends) registry.register(b);
  return registry;
}

export {
  pythonBackend,
  javascriptBackend,
  htmlBackend,
  cssBackend,
  javaBackend,
  kotlinBackend,
  csharpBackend,
  goBackend,
  rustBackend,
  cppBackend,
  cBackend,
};
export * from './backend.ts';
