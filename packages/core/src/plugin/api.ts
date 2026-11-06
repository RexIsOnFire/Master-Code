/**
 * The plugin API.
 *
 * A plugin is an ES module that default-exports a `Plugin`. It gets the same
 * registries the built-in catalogue uses - there is no separate, lesser
 * extension surface - which is what makes "add a language" a plugin-sized task
 * rather than a fork.
 *
 * Loading is deliberately dull: import the module, call `activate`, record what
 * it registered. A plugin that throws is reported and skipped, never silently
 * ignored, and its partial registrations are left in place only if they
 * succeeded, so a broken plugin cannot half-break the app without saying so.
 *
 * Plugins run with the platform's own privileges. There is no plugin sandbox,
 * and the docs say so; installing one is the same trust decision as installing
 * an editor extension anywhere else.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LanguageBackend } from '../backends/backend.ts';
import type { BackendRegistry } from '../backends/backend.ts';
import type { NodeDefinition, NodeRegistry } from '../nodes/definition.ts';
import type { ProjectTemplate, TemplateRegistry } from '../project/templates.ts';
import { DiagnosticBag } from '../diagnostics.ts';
import type { Project } from '../model/project.ts';
import type { GenerateResult } from '../codegen/generate.ts';

export const PLUGIN_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Contribution points
// ---------------------------------------------------------------------------

/** Turns a project into some other format. */
export interface Exporter {
  id: string;
  title: string;
  description: string;
  /** File extension or folder name the export produces. */
  output: string;
  run(project: Project, generated: GenerateResult): { path: string; content: string }[];
}

/** Reads an existing codebase into a project. */
export interface Importer {
  id: string;
  title: string;
  description: string;
  /** Languages this importer understands. */
  languages: string[];
  /** Quick test: does this directory look like something we can read? */
  detect(root: string): boolean;
  run(root: string, options: { name: string }): { project: Project; diagnostics: DiagnosticBag };
}

export interface Theme {
  id: string;
  name: string;
  appearance: 'light' | 'dark';
  /** CSS custom properties applied to the IDE root. */
  variables: Record<string, string>;
}

export interface PluginContributions {
  languages?: LanguageBackend[];
  nodes?: NodeDefinition[];
  templates?: ProjectTemplate[];
  exporters?: Exporter[];
  importers?: Importer[];
  themes?: Theme[];
}

export interface PluginContext {
  readonly apiVersion: number;
  readonly nodes: NodeRegistry;
  readonly backends: BackendRegistry;
  readonly templates: TemplateRegistry;
  readonly exporters: Map<string, Exporter>;
  readonly importers: Map<string, Importer>;
  readonly themes: Map<string, Theme>;
  /** Where the plugin was loaded from, for resolving its own assets. */
  readonly directory: string;
  log(message: string): void;
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** API version this plugin was written against. */
  apiVersion: number;
  /** Declarative contributions, registered before `activate` runs. */
  contributes?: PluginContributions;
  /** Imperative setup, for anything the declarative form cannot express. */
  activate?(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Identity helper that gives plugin authors type checking for free. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface LoadedPlugin {
  plugin: Plugin;
  directory: string;
  entry: string;
  contributed: { languages: string[]; nodes: string[]; templates: string[]; exporters: string[]; importers: string[]; themes: string[] };
}

export interface PluginHostOptions {
  nodes: NodeRegistry;
  backends: BackendRegistry;
  templates: TemplateRegistry;
}

export class PluginHost {
  readonly loaded: LoadedPlugin[] = [];
  readonly exporters = new Map<string, Exporter>();
  readonly importers = new Map<string, Importer>();
  readonly themes = new Map<string, Theme>();
  readonly diagnostics = new DiagnosticBag();

  private readonly nodes: NodeRegistry;
  private readonly backends: BackendRegistry;
  private readonly templates: TemplateRegistry;

  constructor(options: PluginHostOptions) {
    this.nodes = options.nodes;
    this.backends = options.backends;
    this.templates = options.templates;
  }

  /**
   * Load every plugin under a directory.
   *
   * The layout mirrors the contribution points so a reader can find things:
   * `plugins/languages/`, `plugins/nodes/`, `plugins/templates/`,
   * `plugins/exporters/`, `plugins/themes/`. Any nested folder holding a
   * `plugin.ts` or `plugin.js` is a plugin; the grouping is for humans.
   */
  async loadDirectory(root: string): Promise<void> {
    if (!existsSync(root)) return;
    for (const entry of discoverPlugins(root)) {
      await this.load(entry);
    }
  }

  async load(entryFile: string): Promise<LoadedPlugin | undefined> {
    const directory = resolve(entryFile, '..');
    let plugin: Plugin;
    try {
      const module = (await import(pathToFileURL(entryFile).href)) as { default?: Plugin };
      if (!module.default) {
        this.diagnostics.error('plugin', 'plugin/no-default-export', `${entryFile} has no default export.`, {
          file: entryFile,
          hint: 'Export the result of definePlugin({...}) as the default export.',
        });
        return undefined;
      }
      plugin = module.default;
    } catch (err) {
      this.diagnostics.error(
        'plugin',
        'plugin/load-failed',
        `Could not load ${entryFile}: ${err instanceof Error ? err.message : String(err)}`,
        { file: entryFile },
      );
      return undefined;
    }

    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      this.diagnostics.error(
        'plugin',
        'plugin/api-mismatch',
        `Plugin "${plugin.id}" targets API version ${plugin.apiVersion}, but this build provides ${PLUGIN_API_VERSION}.`,
        { file: entryFile, hint: 'Update the plugin, or use a matching build of Master Code.' },
      );
      return undefined;
    }
    if (this.loaded.some((l) => l.plugin.id === plugin.id)) {
      this.diagnostics.warn('plugin', 'plugin/duplicate', `Plugin "${plugin.id}" is already loaded; skipping.`, {
        file: entryFile,
      });
      return undefined;
    }

    const contributed: LoadedPlugin['contributed'] = {
      languages: [],
      nodes: [],
      templates: [],
      exporters: [],
      importers: [],
      themes: [],
    };

    const c = plugin.contributes ?? {};
    for (const backend of c.languages ?? []) {
      try {
        this.backends.register(backend);
        contributed.languages.push(backend.id);
      } catch (err) {
        this.reject(plugin, `language "${backend.id}"`, err);
      }
    }
    for (const node of c.nodes ?? []) {
      try {
        this.nodes.register(node, plugin.id);
        contributed.nodes.push(node.type);
      } catch (err) {
        this.reject(plugin, `node "${node.type}"`, err);
      }
    }
    for (const template of c.templates ?? []) {
      this.templates.register(template);
      contributed.templates.push(template.id);
    }
    for (const exporter of c.exporters ?? []) {
      this.exporters.set(exporter.id, exporter);
      contributed.exporters.push(exporter.id);
    }
    for (const importer of c.importers ?? []) {
      this.importers.set(importer.id, importer);
      contributed.importers.push(importer.id);
    }
    for (const theme of c.themes ?? []) {
      this.themes.set(theme.id, theme);
      contributed.themes.push(theme.id);
    }

    if (plugin.activate) {
      try {
        await plugin.activate(this.contextFor(plugin, directory));
      } catch (err) {
        this.diagnostics.error(
          'plugin',
          'plugin/activate-failed',
          `Plugin "${plugin.id}" failed during activate: ${err instanceof Error ? err.message : String(err)}`,
          { file: entryFile },
        );
      }
    }

    const record: LoadedPlugin = { plugin, directory, entry: entryFile, contributed };
    this.loaded.push(record);
    return record;
  }

  async unloadAll(): Promise<void> {
    for (const record of [...this.loaded].reverse()) {
      try {
        await record.plugin.deactivate?.();
      } catch (err) {
        this.diagnostics.warn(
          'plugin',
          'plugin/deactivate-failed',
          `Plugin "${record.plugin.id}" threw during deactivate: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.loaded.length = 0;
  }

  private contextFor(plugin: Plugin, directory: string): PluginContext {
    return {
      apiVersion: PLUGIN_API_VERSION,
      nodes: this.nodes,
      backends: this.backends,
      templates: this.templates,
      exporters: this.exporters,
      importers: this.importers,
      themes: this.themes,
      directory,
      log: (message) => {
        this.diagnostics.info('plugin', 'plugin/log', `[${plugin.id}] ${message}`);
      },
    };
  }

  private reject(plugin: Plugin, what: string, err: unknown): void {
    this.diagnostics.error(
      'plugin',
      'plugin/conflict',
      `Plugin "${plugin.id}" could not register ${what}: ${err instanceof Error ? err.message : String(err)}`,
      { hint: 'Two plugins are claiming the same id, or it collides with a built-in.' },
    );
  }
}

/** Every `plugin.ts`/`plugin.js` under a directory tree. */
export function discoverPlugins(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      if (name === 'plugin.ts' || name === 'plugin.js' || name === 'plugin.mjs') {
        found.push(full);
        continue;
      }
      if (name === 'node_modules' || name.startsWith('.')) continue;
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
      } catch {
        /* unreadable entry */
      }
    }
  };
  walk(root, 0);
  return found;
}
