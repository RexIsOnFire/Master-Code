/**
 * Adding and installing dependencies.
 *
 * These are two separate operations on purpose:
 *
 *   `addToProject`  writes the package into the project manifest. Offline,
 *                   instant, reversible, and the default. This is what the
 *                   library browser's "Add" button does.
 *   `installAll`    actually invokes pip / npm / cargo / dotnet to download.
 *                   Never implicit: the caller has to ask, and the exact
 *                   command is returned first so the user can see what will
 *                   run before agreeing to it.
 *
 * The separation is the point of the whole subsystem. A project can be built,
 * reviewed, committed and shared with a complete dependency list without any
 * network access ever happening.
 */

import type { BackendRegistry, CommandSpec } from '../backends/backend.ts';
import { DiagnosticBag } from '../diagnostics.ts';
import type { Dependency, Project } from '../model/project.ts';
import { touch } from '../model/project.ts';
import { runCommand } from '../runtime/exec.ts';
import type { RunResult } from '../runtime/exec.ts';
import { findLibrary } from './catalog.ts';
import type { LibraryEntry } from './catalog.ts';
import { managerFor, registryHomepage } from './registry.ts';

export interface AddOptions {
  language: string;
  name: string;
  version?: string;
  scope?: Dependency['scope'];
  /** Catalogue metadata, when the caller already has it. */
  entry?: LibraryEntry;
}

export interface AddResult {
  dependency: Dependency;
  added: boolean;
  diagnostics: DiagnosticBag;
}

/** Record a dependency in the project. Nothing is downloaded. */
export function addToProject(project: Project, options: AddOptions): AddResult {
  const diagnostics = new DiagnosticBag();
  const entry = options.entry ?? findLibrary(options.language, options.name);
  const manager = entry?.manager ?? managerFor(options.language);
  const version = options.version ?? entry?.version ?? '*';

  const existing = project.dependencies.find(
    (d) => d.language === options.language && d.name === options.name,
  );
  if (existing) {
    if (existing.version !== version && options.version) {
      diagnostics.info(
        'dependency',
        'dependency/version-changed',
        `${options.name}: ${existing.version} -> ${version}.`,
      );
      existing.version = version;
      existing.installed = false;
      touch(project);
      return { dependency: existing, added: true, diagnostics };
    }
    diagnostics.info('dependency', 'dependency/already-present', `${options.name} is already in the project.`);
    return { dependency: existing, added: false, diagnostics };
  }

  const dependency: Dependency = {
    name: options.name,
    version,
    language: options.language,
    manager,
    license: entry?.license,
    source: entry?.homepage ?? registryHomepage(manager, options.name),
    scope: options.scope ?? 'runtime',
    installed: false,
  };
  project.dependencies.push(dependency);
  if (!project.languages.includes(options.language)) project.languages.push(options.language);
  touch(project);

  if (entry?.peers?.length) {
    diagnostics.info(
      'dependency',
      'dependency/peers',
      `${options.name} is usually used with: ${entry.peers.join(', ')}.`,
      { hint: 'Add them too if you need them.' },
    );
  }
  if (entry?.heavy) {
    diagnostics.info(
      'dependency',
      'dependency/heavy',
      `${options.name} is a large download and may need a compiler toolchain.`,
    );
  }

  return { dependency, added: true, diagnostics };
}

export function removeFromProject(project: Project, language: string, name: string): boolean {
  const before = project.dependencies.length;
  project.dependencies = project.dependencies.filter((d) => !(d.language === language && d.name === name));
  const removed = project.dependencies.length !== before;
  if (removed) touch(project);
  return removed;
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

export interface InstallPlan {
  language: string;
  manager: string;
  /** Exactly what will run. Show this before doing anything. */
  command: CommandSpec | null;
  /** Packages the command will fetch. */
  packages: { name: string; version: string }[];
  /** Set when this language has no automatic install path. */
  manualNote?: string;
}

/**
 * What installing would run, per language. Nothing is executed.
 *
 * The caller shows this, gets a yes, and only then calls `runInstall`.
 */
export function planInstall(project: Project, backends: BackendRegistry, language?: string): InstallPlan[] {
  const languages = language ? [language] : [...new Set(project.dependencies.map((d) => d.language))];
  const plans: InstallPlan[] = [];

  for (const lang of languages.sort()) {
    const backend = backends.get(lang);
    if (!backend) continue;
    const packages = project.dependencies
      .filter((d) => d.language === lang)
      .map((d) => ({ name: d.name, version: d.version }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!packages.length) continue;

    const spec = backend.packageManager.installAll;
    plans.push({
      language: lang,
      manager: backend.packageManager.id,
      command: spec,
      packages,
      manualNote: spec
        ? undefined
        : `${backend.packageManager.name} has no single install command here. Fetch these yourself, or vendor them into the project.`,
    });
  }
  return plans;
}

export interface InstallOutcome {
  plan: InstallPlan;
  result?: RunResult;
  ok: boolean;
  diagnostics: DiagnosticBag;
}

/**
 * Run an install plan.
 *
 * `confirmed` is a required argument rather than an option with a default, so
 * no call site can reach the network by forgetting a flag.
 */
export async function runInstall(
  plan: InstallPlan,
  root: string,
  confirmed: boolean,
  hooks: { onOutput?(chunk: string, stream: 'stdout' | 'stderr'): void; signal?: AbortSignal } = {},
): Promise<InstallOutcome> {
  const diagnostics = new DiagnosticBag();
  if (!confirmed) {
    diagnostics.error('dependency', 'dependency/not-confirmed', 'Install was not confirmed; nothing was downloaded.');
    return { plan, ok: false, diagnostics };
  }
  if (!plan.command) {
    diagnostics.warn('dependency', 'dependency/manual', plan.manualNote ?? 'No install command for this language.');
    return { plan, ok: false, diagnostics };
  }

  const result = await runCommand({
    command: plan.command.command,
    args: plan.command.args,
    cwd: root,
    // Installing needs the real environment: proxies, registry tokens, and the
    // manager's own configuration all live in environment variables.
    envAllowlist: Object.keys(process.env),
    timeoutMs: 600_000,
    maxOutputBytes: 4_000_000,
    onOutput: hooks.onOutput,
    signal: hooks.signal,
  });

  if (result.startError) {
    diagnostics.error('dependency', 'dependency/manager-missing', result.startError, {
      hint: `Install ${plan.manager} first, or add the packages by hand.`,
    });
    return { plan, result, ok: false, diagnostics };
  }
  if (result.code !== 0) {
    diagnostics.error(
      'dependency',
      'dependency/install-failed',
      `${plan.manager} exited with code ${result.code}.`,
      { raw: result.stderr.trim().split('\n').slice(-8).join('\n') },
    );
    return { plan, result, ok: false, diagnostics };
  }

  diagnostics.info(
    'dependency',
    'dependency/installed',
    `Installed ${plan.packages.length} ${plan.language} package(s) with ${plan.manager}.`,
  );
  return { plan, result, ok: true, diagnostics };
}

/** Mark a language's dependencies as installed after a successful run. */
export function markInstalled(project: Project, language: string): void {
  for (const dependency of project.dependencies) {
    if (dependency.language === language) {
      dependency.installed = true;
      dependency.lockVersion = dependency.version;
    }
  }
  touch(project);
}

/** A copy-pasteable command for adding one package by hand. */
export function manualInstallCommand(
  backends: BackendRegistry,
  language: string,
  name: string,
  version: string,
): string | undefined {
  const spec = backends.get(language)?.packageManager.installOne;
  if (!spec) return undefined;
  const args = spec.args.map((a) => a.replace('{name}', name).replace('{version}', version));
  return `${spec.command} ${args.join(' ')}`;
}
