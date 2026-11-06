#!/usr/bin/env node
/**
 * `mcode` - the Master Code command line.
 *
 * Everything the IDE can do is reachable here, because the IDE is a client of
 * the same core. That is a deliberate constraint: it keeps the platform
 * scriptable, makes CI possible without a browser, and stops functionality
 * from quietly accumulating inside the UI layer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import process from 'node:process';
import { createWorkspace } from '#core/index.ts';
import type { Workspace } from '#core/index.ts';
import { build, summarizeBuild } from '#core/build/pipeline.ts';
import { generate } from '#core/codegen/generate.ts';
import { loadProject, readProjectFile, saveProject, writeArtifacts } from '#core/project/io.ts';
import { importProject } from '#core/import/scan.ts';
import { runTests, summarizeTests } from '#core/testing/runner.ts';
import { checkCapabilities, describeLimits, runDiagnostics, runInSandbox } from '#core/runtime/sandbox.ts';
import { probeTool } from '#core/runtime/exec.ts';
import { catalogFor, catalogSummary, searchCatalog } from '#core/libraries/catalog.ts';
import { searchRegistry } from '#core/libraries/registry.ts';
import { addToProject, manualInstallCommand, markInstalled, planInstall, removeFromProject, runInstall } from '#core/libraries/install.ts';
import { validateGraph } from '#core/lower/validate.ts';
import { FileGraph, renameFile, validateFileGraph } from '#core/filegraph/graph.ts';
import { flatten, modularise } from '#core/project/architecture.ts';
import { runTraced } from '#core/build/run-traced.ts';
import { includeInlinedInputs, unreachedNodes } from '#core/build/trace.ts';
import type { Project } from '#core/model/project.ts';
import type { Capability } from '#core/ir/ir.ts';
import { DiagnosticBag } from '#core/diagnostics.ts';
import { color, table, heading, bullet } from './format.ts';
import { pluginDirectories } from './plugins.ts';

const USAGE = `mcode - Master Code

  mcode new <name> [--template ID] [--language L] [--dir PATH]
  mcode templates [--language L]
  mcode info [--dir PATH]
  mcode validate [--dir PATH]
  mcode gen [--dir PATH] [--out PATH] [--dry-run]
  mcode build [--dir PATH] [--release] [--out PATH]
  mcode run [--dir PATH] [--release] [--allow CAP,...] [-- <program args>]
  mcode trace [--dir PATH] [-- <program args>]
  mcode test [--dir PATH] [--language L]
  mcode export --out PATH [--dir PATH]
  mcode import <source> [--name N] [--dir PATH]
  mcode libs [<query>] [--language L] [--online] [--category C]
  mcode add <package> [--language L] [--version V] [--dir PATH]
  mcode remove <package> [--language L] [--dir PATH]
  mcode install [--language L] [--yes] [--dir PATH]
  mcode grant <capability>... [--dir PATH]
  mcode mv <from> <to> [--dir PATH]
  mcode arch <modular|monolithic> [--groups N=PATH;…] [--yes] [--dir PATH]
  mcode nodes [<query>] [--language L]
  mcode doctor
  mcode plugins [--dir PATH]

Common options
  --dir PATH     project directory (default: current directory)
  --out PATH     output directory for generated code (default: <dir>/build/generated)
  --json         machine-readable output
  -h, --help     this message

Anything after a bare -- is passed to the program, not to mcode:
  mcode run -- Ada --verbose
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  /** Everything after a bare `--`, passed through to the program being run. */
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const name = arg.replace(/^--?/, '');
    const next = argv[i + 1];
    if (next && !next.startsWith('-')) {
      flags[name] = next;
      i++;
    } else flags[name] = true;
  }
  return { command: positional.shift() ?? '', positional, flags, rest };
}

function flagString(args: Args, name: string, fallback?: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : fallback;
}

function projectDir(args: Args): string {
  return resolve(flagString(args, 'dir') ?? process.cwd());
}

function outputDir(args: Args, root: string): string {
  return resolve(flagString(args, 'out') ?? `${root}/build/generated`);
}

function openProject(args: Args): { project: Project; root: string } {
  const root = projectDir(args);
  const { project, diagnostics } = loadProject(root);
  if (diagnostics.items.length) console.error(diagnostics.format({ color: true }));
  return { project, root };
}

function report(diagnostics: DiagnosticBag, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(diagnostics.toJSON(), null, 2));
    return;
  }
  if (diagnostics.items.length) console.error(diagnostics.format({ color: true }));
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const json = args.flags.json === true;

  if (!args.command || args.flags.h || args.flags.help) {
    console.log(USAGE);
    return args.command ? 0 : 1;
  }

  const workspace = await createWorkspace({ pluginDirs: pluginDirectories() });
  if (workspace.plugins.diagnostics.items.length) {
    console.error(workspace.plugins.diagnostics.format({ color: true }));
  }

  switch (args.command) {
    case 'new':
      return commandNew(args, workspace);
    case 'templates':
      return commandTemplates(args, workspace, json);
    case 'info':
      return commandInfo(args, workspace, json);
    case 'validate':
      return commandValidate(args, workspace, json);
    case 'gen':
    case 'generate':
      return commandGenerate(args, workspace, json);
    case 'build':
      return commandBuild(args, workspace, json);
    case 'run':
      return commandRun(args, workspace, json);
    case 'test':
      return commandTest(args, workspace, json);
    case 'export':
      return commandExport(args, workspace, json);
    case 'import':
      return commandImport(args, workspace, json);
    case 'libs':
      return commandLibs(args, json);
    case 'add':
      return commandAdd(args, workspace, json);
    case 'remove':
      return commandRemove(args, json);
    case 'install':
      return commandInstall(args, workspace, json);
    case 'grant':
      return commandGrant(args, json);
    case 'mv':
      return commandMove(args, workspace, json);
    case 'arch':
      return commandArch(args, workspace, json);
    case 'trace':
      return commandTrace(args, workspace, json);
    case 'nodes':
      return commandNodes(args, workspace, json);
    case 'doctor':
      return commandDoctor(workspace, json);
    case 'plugins':
      return commandPlugins(workspace, json);
    default:
      console.error(`Unknown command "${args.command}".\n`);
      console.log(USAGE);
      return 1;
  }
}

// ---------------------------------------------------------------------------

function commandNew(args: Args, workspace: Workspace): number {
  const name = args.positional[0];
  if (!name) {
    console.error('Usage: mcode new <name> [--template ID]');
    return 1;
  }
  const language = flagString(args, 'language');
  const templateId =
    flagString(args, 'template') ??
    workspace.templates.forLanguage(language ?? 'python')[0]?.id ??
    'python/cli';
  const template = workspace.templates.get(templateId);
  if (!template) {
    console.error(`No template "${templateId}". Run: mcode templates`);
    return 1;
  }

  const root = resolve(flagString(args, 'dir') ?? name);
  if (existsSync(`${root}/project.json`)) {
    console.error(`A project already exists in ${root}.`);
    return 1;
  }

  const project = template.build({
    registry: workspace.nodes,
    options: { name, language: template.language, description: `Created from ${template.id}.` },
  });
  const saved = saveProject(project, root);

  console.log(heading(`Created ${name}`));
  console.log(bullet(`template  ${template.id} (${template.title})`));
  console.log(bullet(`language  ${project.language}`));
  console.log(bullet(`files     ${project.files.length}`));
  console.log(bullet(`written   ${saved.written.length} project files in ${root}`));
  console.log(`\nNext:\n  cd ${basename(root)}\n  mcode gen\n  mcode run`);
  return 0;
}

function commandTemplates(args: Args, workspace: Workspace, json: boolean): number {
  const language = flagString(args, 'language');
  const templates = language ? workspace.templates.forLanguage(language) : workspace.templates.all();
  if (json) {
    console.log(JSON.stringify(templates.map((t) => ({ id: t.id, language: t.language, title: t.title, description: t.description, outline: t.outline })), null, 2));
    return 0;
  }
  console.log(heading('Templates'));
  console.log(
    table(
      ['id', 'language', 'title'],
      templates.map((t) => [t.id, t.language, t.title]),
    ),
  );
  console.log('\nEach template is an ordinary graph you can pull apart. Use: mcode new <name> --template <id>');
  return 0;
}

function commandInfo(args: Args, workspace: Workspace, json: boolean): number {
  const { project } = openProject(args);
  const graph = new FileGraph(project);
  if (json) {
    console.log(JSON.stringify({ project, files: graph.summary().map((s) => ({ path: s.file.path, imports: s.imports, importedBy: s.importedBy })) }, null, 2));
    return 0;
  }
  console.log(heading(project.name));
  console.log(bullet(`version       ${project.version}`));
  console.log(bullet(`languages     ${project.languages.join(', ')}`));
  console.log(bullet(`architecture  ${project.architecture}`));
  console.log(bullet(`files         ${project.files.length}`));
  console.log(bullet(`graphs        ${project.graphs.length}`));
  console.log(bullet(`dependencies  ${project.dependencies.length} (${project.dependencies.filter((d) => d.installed).length} installed)`));
  const granted = Object.entries(project.grants).filter(([, v]) => v).map(([k]) => k);
  console.log(bullet(`capabilities  ${granted.join(', ') || 'none'}`));

  console.log(`\n${heading('Files')}`);
  console.log(
    table(
      ['path', 'lang', 'kind', 'role', 'imports', 'used by'],
      graph.summary().map((s) => [s.file.path, s.file.language, s.file.kind, s.file.role, String(s.imports), String(s.importedBy)]),
    ),
  );

  const cycles = graph.cycles();
  if (cycles.length) {
    console.log(color.yellow(`\n${cycles.length} import cycle(s) detected. Run: mcode validate`));
  }
  return 0;
}

function commandValidate(args: Args, workspace: Workspace, json: boolean): number {
  const { project } = openProject(args);
  const diagnostics = new DiagnosticBag();
  diagnostics.merge(validateFileGraph(project, workspace.backends));
  for (const graph of project.graphs) {
    const file = project.files.find((f) => f.id === graph.fileId);
    if (!file) continue;
    validateGraph(graph, project, workspace.nodes, file.language, diagnostics);
  }
  report(diagnostics, json);
  if (!json) {
    const errors = diagnostics.errors.length;
    console.log(errors ? color.red(`\n${errors} error(s).`) : color.green('\nNo problems found.'));
  }
  return diagnostics.ok ? 0 : 1;
}

function commandGenerate(args: Args, workspace: Workspace, json: boolean): number {
  const { project, root } = openProject(args);
  const out = outputDir(args, root);
  const result = generate(project, {
    nodes: workspace.nodes,
    backends: workspace.backends,
    readExisting: (path) => readProjectFile(out, path),
  });
  report(result.diagnostics, json);
  if (!result.diagnostics.ok) return 1;

  if (args.flags['dry-run']) {
    if (!json) {
      console.log(heading('Would write'));
      for (const f of result.files) console.log(bullet(`${f.path}  (${f.content.split('\n').length} lines)`));
    }
    return 0;
  }

  const written = writeArtifacts(out, result.files, result.orphanedRegions);
  saveProject(project, root);
  if (json) {
    console.log(JSON.stringify({ written: written.written, unchanged: written.unchanged, removed: written.removed, out }, null, 2));
    return 0;
  }
  console.log(heading('Generated'));
  console.log(
    bullet(`${written.written.length} written, ${written.unchanged.length} unchanged, ${written.removed.length} stale removed`),
  );
  for (const d of written.diagnostics.items) console.log(bullet(`${d.severity}: ${d.message}${d.hint ? ` ${d.hint}` : ''}`));
  console.log(bullet(`output: ${out}`));
  if (result.capabilities.size) {
    console.log(bullet(`capabilities needed: ${[...result.capabilities].join(', ')}`));
  }
  return 0;
}

async function commandBuild(args: Args, workspace: Workspace, json: boolean): Promise<number> {
  const { project, root } = openProject(args);
  const out = outputDir(args, root);
  const outcome = await build({
    project,
    root: out,
    nodes: workspace.nodes,
    backends: workspace.backends,
    mode: args.flags.release ? 'release' : 'debug',
    onOutput: json ? undefined : (chunk) => process.stdout.write(color.dim(chunk)),
  });
  saveProject(project, root);

  if (json) {
    console.log(JSON.stringify({ ok: outcome.ok, steps: outcome.steps, diagnostics: outcome.diagnostics.toJSON() }, null, 2));
    return outcome.ok ? 0 : 1;
  }
  console.log(`\n${heading('Build')}`);
  console.log(
    table(
      ['stage', 'step', 'ok', 'ms'],
      outcome.steps.map((s) => [s.stage, s.label, s.ok ? 'yes' : 'no', String(s.durationMs)]),
    ),
  );
  report(outcome.diagnostics, false);
  console.log(outcome.ok ? color.green(`\n${summarizeBuild(outcome)}`) : color.red(`\n${summarizeBuild(outcome)}`));
  return outcome.ok ? 0 : 1;
}

async function commandRun(args: Args, workspace: Workspace, json: boolean): Promise<number> {
  const { project, root } = openProject(args);
  const out = outputDir(args, root);

  // Any capability granted on the command line applies to this run only.
  const allow = flagString(args, 'allow');
  if (allow) {
    for (const cap of allow.split(',').map((c) => c.trim()).filter(Boolean)) {
      if (cap in project.grants) project.grants[cap as Capability] = true;
      else console.error(`Ignoring unknown capability "${cap}".`);
    }
  }

  const outcome = await build({
    project,
    root: out,
    nodes: workspace.nodes,
    backends: workspace.backends,
    mode: args.flags.release ? 'release' : 'debug',
    onOutput: json ? undefined : (chunk) => process.stdout.write(color.dim(chunk)),
  });
  if (!outcome.ok) {
    report(outcome.diagnostics, json);
    return 1;
  }

  const language = project.language;
  const backend = workspace.backends.require(language);
  const program = outcome.generated.programs.find((p) => p.language === language);
  if (program) {
    const check = checkCapabilities(project, program);
    if (!check.ok) {
      report(check.diagnostics, json);
      console.error(
        color.yellow(
          `\nRefusing to run. Grant what it needs:\n  mcode grant ${check.missing.map((m) => m.capability).join(' ')}`,
        ),
      );
      return 1;
    }
  }

  const plan = backend.runPlan(project, args.flags.release ? 'release' : 'debug');
  if (!plan) {
    console.error(`${backend.name} has no run command.`);
    return 1;
  }
  // Anything after `--` belongs to the program, not to mcode. Reading it needs
  // the `env` capability, and the gate above has already checked for that.
  const command = args.rest.length
    ? { ...plan.command, args: [...plan.command.args, ...args.rest] }
    : plan.command;
  if (plan.openInBrowser) {
    console.log(heading('Open in a browser'));
    console.log(bullet(resolve(out, plan.openInBrowser)));
    return 0;
  }

  console.log(heading('Run'));
  const result = await runInSandbox({
    project,
    root: out,
    command,
    onOutput: (chunk, stream) => process[stream === 'stderr' ? 'stderr' : 'stdout'].write(chunk),
  });

  const diagnostics = runDiagnostics(result, (text) => backend.parseDiagnostics(text, project));
  if (diagnostics.length) {
    console.error(`\n${new DiagnosticBag().merge(diagnostics).format({ color: true })}`);
  }
  console.log(color.dim(`\n[${describeLimits(result)}]`));
  for (const note of result.unenforced) console.log(color.dim(`[not enforced: ${note}]`));
  return result.code === 0 ? 0 : 1;
}

async function commandTest(args: Args, workspace: Workspace, json: boolean): Promise<number> {
  const { project, root } = openProject(args);
  const out = outputDir(args, root);
  const outcome = await build({
    project,
    root: out,
    nodes: workspace.nodes,
    backends: workspace.backends,
    generateOnly: true,
  });
  if (!outcome.ok) {
    report(outcome.diagnostics, json);
    return 1;
  }

  const results = await runTests({
    project,
    root: out,
    backends: workspace.backends,
    sourceMap: outcome.sourceMap,
    language: flagString(args, 'language'),
    onOutput: json ? undefined : (chunk) => process.stdout.write(color.dim(chunk)),
  });

  if (json) {
    console.log(JSON.stringify({ ok: results.ok, results: results.results, diagnostics: results.diagnostics.toJSON() }, null, 2));
    return results.ok ? 0 : 1;
  }
  console.log(`\n${heading('Tests')}`);
  if (results.results.length) {
    console.log(
      table(
        ['status', 'test', 'node'],
        results.results.map((r) => [r.status, r.name, r.nodeId ?? '-']),
      ),
    );
  }
  report(results.diagnostics, false);
  console.log(results.ok ? color.green(`\n${summarizeTests(results)}`) : color.red(`\n${summarizeTests(results)}`));
  return results.ok ? 0 : 1;
}

function commandExport(args: Args, workspace: Workspace, json: boolean): number {
  const { project, root } = openProject(args);
  const out = flagString(args, 'out');
  if (!out) {
    console.error('Usage: mcode export --out PATH');
    return 1;
  }
  const target = resolve(out);
  const result = generate(project, { nodes: workspace.nodes, backends: workspace.backends });
  report(result.diagnostics, json);
  if (!result.diagnostics.ok) return 1;

  const written = writeArtifacts(target, result.files, result.orphanedRegions);
  if (json) {
    console.log(JSON.stringify({ out: target, written: written.written }, null, 2));
    return 0;
  }
  console.log(heading('Exported'));
  console.log(bullet(`${written.written.length} files to ${target}`));
  console.log(
    '\nThis is a plain project. It builds and runs with its own toolchain and does not\nneed Master Code installed.',
  );
  return 0;
}

function commandImport(args: Args, workspace: Workspace, json: boolean): number {
  const source = args.positional[0];
  if (!source) {
    console.error('Usage: mcode import <source-directory> [--name N] [--dir PATH]');
    return 1;
  }
  const from = resolve(source);
  if (!existsSync(from)) {
    console.error(`No such directory: ${from}`);
    return 1;
  }
  const name = flagString(args, 'name') ?? basename(from);
  const outcome = importProject({ root: from, name, backends: workspace.backends });
  const target = resolve(flagString(args, 'dir') ?? `${name}-mastercode`);
  saveProject(outcome.project, target);

  if (json) {
    console.log(JSON.stringify({ stats: outcome.stats, out: target, diagnostics: outcome.diagnostics.toJSON() }, null, 2));
    return 0;
  }
  console.log(heading(`Imported ${name}`));
  console.log(bullet(`scanned    ${outcome.stats.filesScanned} files`));
  console.log(bullet(`imported   ${outcome.stats.filesImported}`));
  console.log(bullet(`skipped    ${outcome.stats.skipped}`));
  console.log(bullet(`symbols    ${outcome.stats.symbols}`));
  console.log(bullet(`languages  ${Object.entries(outcome.stats.languages).map(([l, c]) => `${l}:${c}`).join(', ')}`));
  console.log(bullet(`project    ${target}`));
  report(outcome.diagnostics, false);
  console.log(
    '\nExisting files are marked user-owned and will never be regenerated. Add visual\nfiles alongside them; their imports will resolve against what was imported.',
  );
  return 0;
}

async function commandLibs(args: Args, json: boolean): Promise<number> {
  const query = args.positional.join(' ');
  const language = flagString(args, 'language');
  const category = flagString(args, 'category');
  const online = args.flags.online === true;

  if (!query && !language) {
    const summary = catalogSummary();
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }
    console.log(heading('Library catalogue'));
    console.log(table(['language', 'manager', 'entries'], summary.map((s) => [s.language, s.manager, String(s.count)])));
    console.log('\nBrowse one:   mcode libs --language python');
    console.log('Search all:   mcode libs http --language python --online');
    console.log(color.dim('\nNothing is downloaded by browsing. Use `mcode add` to record a dependency.'));
    return 0;
  }

  if (!query) {
    const entries = category
      ? catalogFor(language!).filter((l) => l.categories.includes(category))
      : catalogFor(language!);
    if (json) {
      console.log(JSON.stringify(entries, null, 2));
      return 0;
    }
    console.log(heading(`${language} libraries (${entries.length})`));
    console.log(table(['name', 'version', 'summary'], entries.map((e) => [e.name, e.version, e.summary])));
    return 0;
  }

  const result = await searchRegistry({
    language: language ?? 'python',
    query,
    allowNetwork: online,
    limit: 20,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.local.length) {
    console.log(heading('From the catalogue'));
    console.log(table(['name', 'version', 'summary'], result.local.map((e) => [e.name, e.version, e.summary])));
  }
  if (result.remote.length) {
    console.log(`\n${heading('From the registry')}`);
    console.log(table(['name', 'version', 'summary'], result.remote.map((e) => [e.name, e.version, e.summary.slice(0, 70)])));
  }
  if (result.note) console.log(color.dim(`\n${result.note}`));
  return 0;
}

function commandAdd(args: Args, workspace: Workspace, json: boolean): number {
  const name = args.positional[0];
  if (!name) {
    console.error('Usage: mcode add <package> [--language L] [--version V]');
    return 1;
  }
  const { project, root } = openProject(args);
  const language = flagString(args, 'language') ?? project.language;
  const result = addToProject(project, { language, name, version: flagString(args, 'version') });
  saveProject(project, root);

  if (json) {
    console.log(JSON.stringify({ dependency: result.dependency, diagnostics: result.diagnostics.toJSON() }, null, 2));
    return 0;
  }
  console.log(heading(result.added ? 'Added to the manifest' : 'Already present'));
  console.log(bullet(`${result.dependency.name} ${result.dependency.version} (${result.dependency.manager})`));
  report(result.diagnostics, false);
  const manual = manualInstallCommand(workspace.backends, language, result.dependency.name, result.dependency.version);
  console.log(color.dim('\nNothing was downloaded.'));
  if (manual) console.log(color.dim(`Install it with:  ${manual}`));
  console.log(color.dim('Or all at once:   mcode install'));
  return 0;
}

function commandRemove(args: Args, json: boolean): number {
  const name = args.positional[0];
  if (!name) {
    console.error('Usage: mcode remove <package> [--language L]');
    return 1;
  }
  const { project, root } = openProject(args);
  const language = flagString(args, 'language') ?? project.language;
  const removed = removeFromProject(project, language, name);
  saveProject(project, root);
  if (json) {
    console.log(JSON.stringify({ removed }, null, 2));
    return removed ? 0 : 1;
  }
  console.log(removed ? `Removed ${name}.` : `${name} was not in the manifest.`);
  return removed ? 0 : 1;
}

async function commandInstall(args: Args, workspace: Workspace, json: boolean): Promise<number> {
  const { project, root } = openProject(args);
  const out = outputDir(args, root);
  const plans = planInstall(project, workspace.backends, flagString(args, 'language'));

  if (!plans.length) {
    console.log('No dependencies are recorded in this project.');
    return 0;
  }
  if (json && !args.flags.yes) {
    console.log(JSON.stringify(plans, null, 2));
    return 0;
  }

  console.log(heading('Install plan'));
  for (const plan of plans) {
    console.log(`\n${plan.language} (${plan.manager})`);
    for (const pkg of plan.packages) console.log(bullet(`${pkg.name} ${pkg.version}`));
    console.log(plan.command ? color.dim(`  will run: ${plan.command.command} ${plan.command.args.join(' ')}`) : color.yellow(`  ${plan.manualNote}`));
  }

  if (!args.flags.yes) {
    console.log(color.yellow('\nNothing has been downloaded. Re-run with --yes to install.'));
    return 0;
  }

  let ok = true;
  for (const plan of plans) {
    console.log(`\n${heading(`Installing ${plan.language}`)}`);
    const outcome = await runInstall(plan, out, true, {
      onOutput: (chunk, stream) => process[stream === 'stderr' ? 'stderr' : 'stdout'].write(chunk),
    });
    report(outcome.diagnostics, false);
    if (outcome.ok) markInstalled(project, plan.language);
    else ok = false;
  }
  saveProject(project, root);
  return ok ? 0 : 1;
}

function commandGrant(args: Args, json: boolean): number {
  const caps = args.positional;
  const { project, root } = openProject(args);
  if (!caps.length) {
    if (json) {
      console.log(JSON.stringify(project.grants, null, 2));
      return 0;
    }
    console.log(heading('Capabilities'));
    for (const [cap, granted] of Object.entries(project.grants)) {
      console.log(bullet(`${granted ? color.green('granted') : color.dim('denied ')}  ${cap}`));
    }
    console.log('\nGrant one:  mcode grant fs.write net');
    return 0;
  }
  const known = Object.keys(project.grants);
  for (const cap of caps) {
    if (!known.includes(cap)) {
      console.error(`Unknown capability "${cap}". Known: ${known.join(', ')}`);
      return 1;
    }
    project.grants[cap as Capability] = true;
  }
  saveProject(project, root);
  console.log(`Granted: ${caps.join(', ')}`);
  return 0;
}

function commandMove(args: Args, workspace: Workspace, json: boolean): number {
  const [from, to] = args.positional;
  if (!from || !to) {
    console.error('Usage: mcode mv <from> <to>');
    return 1;
  }
  const { project, root } = openProject(args);
  const file = project.files.find((f) => f.path === from);
  if (!file) {
    console.error(`No file "${from}" in this project.`);
    return 1;
  }
  const out = outputDir(args, root);
  const result = renameFile(project, file.id, to, workspace.backends, (dependent) =>
    readProjectFile(out, dependent.path),
  );
  saveProject(project, root);

  if (json) {
    console.log(JSON.stringify({ changes: result.changes, diagnostics: result.diagnostics.toJSON() }, null, 2));
    return result.diagnostics.ok ? 0 : 1;
  }
  console.log(heading(`Moved ${from} -> ${to}`));
  for (const change of result.changes) {
    const target = project.files.find((f) => f.id === change.fileId);
    console.log(bullet(`${change.kind.padEnd(7)} ${target?.path ?? change.fileId}${change.note ? `  (${change.note})` : ''}`));
  }
  report(result.diagnostics, false);
  console.log(color.dim('\nGenerated importers are recomputed on the next `mcode gen`.'));
  return result.diagnostics.ok ? 0 : 1;
}

/**
 * Reads `--groups "storage=src/a.py;storage=src/b.py;api=src/c.py"`.
 *
 * Repeating a name adds to that group. Semicolons separate entries because a
 * comma is legal in a path on every platform this runs on and a semicolon is
 * not one anybody uses.
 */
function parseGroups(spec: string | undefined): Record<string, string[]> | undefined {
  if (!spec) return undefined;
  const groups: Record<string, string[]> = {};
  for (const entry of spec.split(';')) {
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const name = entry.slice(0, at).trim();
    const path = entry.slice(at + 1).trim();
    if (!name || !path) continue;
    (groups[name] ??= []).push(path);
  }
  return groups;
}

/**
 * Converts the project between a flat layout and one grouped into modules.
 *
 * Defaults to a dry run in everything but name: it prints the moves and asks
 * for `--yes` before touching anything, because this rewrites every source path
 * in the project and that is not a keystroke away from an accident.
 */
function commandArch(args: Args, workspace: Workspace, json: boolean): number {
  const target = args.positional[0];
  if (target !== 'modular' && target !== 'monolithic') {
    console.error('Usage: mcode arch <modular|monolithic> [--dry-run]');
    return 1;
  }
  const { project, root } = openProject(args);
  const out = outputDir(args, root);
  const dryRun = args.flags['dry-run'] === true || args.flags.yes !== true;

  const groups = parseGroups(flagString(args, 'groups'));
  if (target === 'modular' && groups && !Object.keys(groups).length) {
    console.error('Could not read --groups. Expected: name=path;name=path');
    return 1;
  }

  const result =
    target === 'modular'
      ? modularise(project, {
          backends: workspace.backends,
          dryRun,
          groups,
          readUserFile: (file) => readProjectFile(out, file.path),
        })
      : flatten(project, {
          backends: workspace.backends,
          dryRun,
          readUserFile: (file) => readProjectFile(out, file.path),
        });

  if (json) {
    console.log(
      JSON.stringify(
        { target, dryRun, moves: result.moves, modules: result.modules, diagnostics: result.diagnostics.toJSON() },
        null,
        2,
      ),
    );
    return result.diagnostics.ok ? 0 : 1;
  }

  console.log(heading(dryRun ? `Would convert to ${target}` : `Converted to ${target}`));
  if (!result.moves.length) {
    console.log(bullet('nothing to move'));
  }
  console.log(
    table(
      ['from', 'to', 'module'],
      result.moves.map((m) => [m.from, m.to, m.module ?? '-']),
    ),
  );
  if (result.modules.length) {
    console.log(
      bullet(`${target === 'modular' ? 'modules created' : 'modules removed'}: ${result.modules.join(', ')}`),
    );
  }
  report(result.diagnostics, false);

  if (!dryRun && result.changed) {
    saveProject(project, root);
    console.log(color.dim('\nRun `mcode gen` to rewrite the imports.'));
  } else if (dryRun && result.moves.length) {
    console.log(color.yellow('\nNothing was changed. Re-run with --yes to apply.'));
  }
  return result.diagnostics.ok ? 0 : 1;
}

/**
 * Runs the program and reports which nodes executed.
 *
 * Not a debugger — there is no stepping or breakpoints. It answers the
 * questions a visual program actually raises: did that branch run, how many
 * times did the loop go round, and which nodes are dead.
 */
async function commandTrace(args: Args, workspace: Workspace, json: boolean): Promise<number> {
  const { project, root } = openProject(args);
  const out = outputDir(args, root);

  const outcome = await build({
    project,
    root: out,
    nodes: workspace.nodes,
    backends: workspace.backends,
    onOutput: json ? undefined : (chunk) => process.stdout.write(color.dim(chunk)),
  });
  if (!outcome.ok) {
    report(outcome.diagnostics, json);
    return 1;
  }

  const backend = workspace.backends.require(project.language);
  const program = outcome.generated.programs.find((p) => p.language === project.language);
  if (program) {
    const check = checkCapabilities(project, program);
    if (!check.ok) {
      report(check.diagnostics, json);
      console.error(color.yellow(`
Refusing to run. Grant what it needs:
  mcode grant ${check.missing.map((m) => m.capability).join(' ')}`));
      return 1;
    }
  }

  const plan = backend.runPlan(project, 'debug');
  if (!plan) {
    console.error(`${backend.name} has no run command.`);
    return 1;
  }

  const command = args.rest.length
    ? { ...plan.command, args: [...plan.command.args, ...args.rest] }
    : plan.command;

  console.log(heading('Run'));
  const { run, trace: rawTrace } = await runTraced({
    project,
    root: out,
    language: project.language,
    command,
    sourceMap: outcome.sourceMap,
    onOutput: (chunk, stream) => process[stream === 'stderr' ? 'stderr' : 'stdout'].write(chunk),
  });

  // A pure node inlined into a statement that ran, ran.
  const trace = includeInlinedInputs(rawTrace, project.graphs, (type) => !!workspace.nodes.get(type)?.pure);

  const label = (nodeId: string): string => {
    for (const graph of project.graphs) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (node) {
        const def = workspace.nodes.get(node.type);
        return `${graph.name} / ${def?.title ?? node.type}`;
      }
    }
    return nodeId;
  };

  if (json) {
    console.log(JSON.stringify({ exitCode: run.code, trace }, null, 2));
    return run.code === 0 ? 0 : 1;
  }

  console.log(heading('Executed'));
  if (trace.unsupported) {
    console.log(bullet(trace.unsupported));
  } else if (!trace.nodes.length) {
    console.log(bullet('No nodes were attributed. The program may have exited before running any.'));
  } else {
    console.log(
      table(
        ['#', 'runs', 'node'],
        trace.nodes.map((n) => [String(n.order), String(n.count), label(n.nodeId)]),
      ),
    );
  }

  // Dead nodes are the point of the exercise as much as the live ones.
  const all = project.graphs.flatMap((g) => g.nodes.map((n) => n.id));
  const cold = unreachedNodes(trace, all);
  if (!trace.unsupported && cold.length) {
    console.log(heading('Never ran'));
    for (const id of cold.slice(0, 25)) console.log(bullet(label(id)));
    if (cold.length > 25) console.log(bullet(`… and ${cold.length - 25} more`));
  }
  if (trace.unattributed) {
    console.log(color.dim(`
${trace.unattributed} executed line(s) belonged to no single node.`));
  }
  return run.code === 0 ? 0 : 1;
}

function commandNodes(args: Args, workspace: Workspace, json: boolean): number {
  const query = args.positional.join(' ');
  const language = flagString(args, 'language');
  let nodes = query ? workspace.nodes.search(query) : workspace.nodes.all();
  if (language) nodes = nodes.filter((n) => !n.languages?.length || n.languages.includes(language));

  if (json) {
    console.log(JSON.stringify(nodes.map((n) => ({ type: n.type, category: n.category, title: n.title, description: n.description })), null, 2));
    return 0;
  }
  console.log(heading(`Nodes (${nodes.length})`));
  console.log(table(['type', 'category', 'title'], nodes.slice(0, 200).map((n) => [n.type, n.category, n.title])));
  if (nodes.length > 200) console.log(color.dim(`\n... and ${nodes.length - 200} more. Narrow with a query.`));
  return 0;
}

async function commandDoctor(workspace: Workspace, json: boolean): Promise<number> {
  const rows: { language: string; maturity: string; tool: string; status: string; version: string }[] = [];
  for (const backend of workspace.backends.all()) {
    if (!backend.toolchain.length) {
      rows.push({ language: backend.id, maturity: backend.maturity, tool: '-', status: 'none needed', version: '' });
      continue;
    }
    for (const probe of backend.toolchain) {
      const status = await probeTool(probe.command, probe.versionArgs, probe.installHint);
      rows.push({
        language: backend.id,
        maturity: backend.maturity,
        tool: probe.command,
        status: status.available ? 'found' : 'missing',
        version: status.version ?? probe.installHint,
      });
    }
  }

  if (json) {
    console.log(JSON.stringify({ node: process.version, toolchains: rows }, null, 2));
    return 0;
  }
  console.log(heading('Master Code doctor'));
  console.log(bullet(`node ${process.version}`));
  console.log(bullet(`${workspace.nodes.all().length} node types, ${workspace.backends.all().length} languages, ${workspace.templates.all().length} templates`));
  console.log(`\n${heading('Toolchains')}`);
  console.log(
    table(
      ['language', 'maturity', 'tool', 'status', 'version / how to install'],
      rows.map((r) => [
        r.language,
        r.maturity,
        r.tool,
        r.status === 'found' ? color.green(r.status) : r.status === 'missing' ? color.yellow(r.status) : color.dim(r.status),
        r.version,
      ]),
    ),
  );
  console.log(
    color.dim(
      '\nA missing toolchain only blocks building that language. Generation, validation\nand export work for every language regardless.',
    ),
  );
  return 0;
}

function commandPlugins(workspace: Workspace, json: boolean): number {
  const loaded = workspace.plugins.loaded;
  if (json) {
    console.log(JSON.stringify(loaded.map((l) => ({ id: l.plugin.id, name: l.plugin.name, version: l.plugin.version, entry: l.entry, contributed: l.contributed })), null, 2));
    return 0;
  }
  console.log(heading(`Plugins (${loaded.length})`));
  if (!loaded.length) {
    console.log(color.dim('None loaded. Put a plugin.ts under ./plugins/ and re-run.'));
    return 0;
  }
  for (const record of loaded) {
    console.log(`\n${record.plugin.name} ${record.plugin.version}  ${color.dim(record.entry)}`);
    for (const [what, ids] of Object.entries(record.contributed)) {
      if (ids.length) console.log(bullet(`${what}: ${ids.join(', ')}`));
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(color.red(`\nmcode failed: ${err instanceof Error ? err.message : String(err)}`));
    if (process.env.MASTERCODE_DEBUG && err instanceof Error) console.error(err.stack);
    process.exitCode = 1;
  });
