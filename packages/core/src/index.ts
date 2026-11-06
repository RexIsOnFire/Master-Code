/**
 * Public surface of `@mastercode/core`.
 *
 * The CLI, the IDE server and any plugin host all build on this module. A
 * `Workspace` bundles the four registries (nodes, backends, templates, plugins)
 * so callers do not have to wire them up correctly by hand - getting that
 * wrong is how a plugin ends up half-loaded.
 */

import { createDefaultRegistry } from './nodes/catalog/index.ts';
import { createDefaultBackends } from './backends/index.ts';
import { createDefaultTemplates } from './project/templates.ts';
import { PluginHost } from './plugin/api.ts';
import type { NodeRegistry } from './nodes/definition.ts';
import type { BackendRegistry } from './backends/backend.ts';
import type { TemplateRegistry } from './project/templates.ts';

export interface Workspace {
  nodes: NodeRegistry;
  backends: BackendRegistry;
  templates: TemplateRegistry;
  plugins: PluginHost;
}

export interface WorkspaceOptions {
  /** Directories to load plugins from, in order. */
  pluginDirs?: string[];
}

/** Build a workspace with the built-in catalogue, then load any plugins. */
export async function createWorkspace(options: WorkspaceOptions = {}): Promise<Workspace> {
  const nodes = createDefaultRegistry();
  const backends = createDefaultBackends();
  const templates = createDefaultTemplates();
  const plugins = new PluginHost({ nodes, backends, templates });
  for (const dir of options.pluginDirs ?? []) await plugins.loadDirectory(dir);
  return { nodes, backends, templates, plugins };
}

// -- model -------------------------------------------------------------------
export * from './model/project.ts';
export * from './model/ui.ts';
export * from './types/types.ts';
export * from './diagnostics.ts';

// -- intermediate representation ---------------------------------------------
export * from './ir/ir.ts';
export * from './ir/build.ts';
export * from './ir/builtins.ts';

// -- visual nodes ------------------------------------------------------------
export * from './nodes/definition.ts';
export { builtinNodes, createDefaultRegistry } from './nodes/catalog/index.ts';

// -- lowering ----------------------------------------------------------------
export * from './lower/ports.ts';
export * from './lower/validate.ts';
export * from './lower/lower.ts';

// -- backends ----------------------------------------------------------------
export * from './backends/backend.ts';
export * from './backends/emitter.ts';
export { builtinBackends, createDefaultBackends } from './backends/index.ts';
export { renderUiDocument, uiDocumentOf } from './backends/html.ts';
export { renderStylesheet, mediaQueryFor, usedClasses } from './backends/css.ts';

// -- file graph and code generation ------------------------------------------
export * from './filegraph/graph.ts';
export * from './codegen/regions.ts';
export * from './codegen/generate.ts';

// -- project -----------------------------------------------------------------
export * from './project/io.ts';
export * from './project/builder.ts';
export * from './project/templates.ts';

// -- libraries ---------------------------------------------------------------
export * from './libraries/catalog.ts';
export * from './libraries/registry.ts';
export * from './libraries/install.ts';

// -- build and runtime -------------------------------------------------------
export * from './runtime/exec.ts';
export * from './runtime/sandbox.ts';
export * from './build/pipeline.ts';
export * from './build/sourcemap.ts';

// -- plugins, import, testing, AI --------------------------------------------
export * from './plugin/api.ts';
export * from './import/scan.ts';
export * from './testing/runner.ts';
export * from './ai/provider.ts';
export { createAnthropicProvider, providerFromEnvironment } from './ai/anthropic.ts';

export const VERSION = '0.1.0';
