/**
 * The build pipeline.
 *
 *     validate -> generate -> write -> resolve deps -> compile -> artifact
 *
 * Each stage produces diagnostics and can stop the run. The important detail is
 * the last step of the compile stage: raw compiler output is parsed by the
 * backend into structured diagnostics, and each one is then mapped back through
 * the generated file to the visual node that produced that line. A `javac`
 * error therefore lands on a box in the editor, which is the whole point of
 * keeping `origin` on every IR node.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BackendRegistry, BuildMode, CommandSpec } from '../backends/backend.ts';
import { DiagnosticBag } from '../diagnostics.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { NodeRegistry } from '../nodes/definition.ts';
import type { Project } from '../model/project.ts';
import { generate } from '../codegen/generate.ts';
import type { GenerateResult } from '../codegen/generate.ts';
import { readProjectFile, writeArtifacts } from '../project/io.ts';
import { probeTool, runCommand } from '../runtime/exec.ts';
import type { RunResult, ToolStatus } from '../runtime/exec.ts';
import { buildSourceMap, mapDiagnostic } from './sourcemap.ts';
import type { GeneratedSourceMap } from './sourcemap.ts';

export type BuildStage = 'validate' | 'generate' | 'write' | 'dependencies' | 'compile' | 'test';

export interface BuildStep {
  stage: BuildStage;
  label: string;
  ok: boolean;
  durationMs: number;
  detail?: string;
  output?: string;
}

export interface BuildOptions {
  project: Project;
  /** Directory the generated project lives in. */
  root: string;
  nodes: NodeRegistry;
  backends: BackendRegistry;
  mode?: BuildMode;
  /** Stop after generating; do not invoke any toolchain. */
  generateOnly?: boolean;
  /** Skip writing to disk; useful for previewing. */
  dryRun?: boolean;
  onOutput?(chunk: string, stream: 'stdout' | 'stderr'): void;
  onStep?(step: BuildStep): void;
  signal?: AbortSignal;
}

export interface BuildOutcome {
  ok: boolean;
  steps: BuildStep[];
  diagnostics: DiagnosticBag;
  generated: GenerateResult;
  sourceMap: GeneratedSourceMap;
  /** Written file paths, relative to the project root. */
  written: string[];
  artifacts: string[];
  /** Toolchains that were checked, and what was found. */
  toolchain: ToolStatus[];
  durationMs: number;
}

export async function build(options: BuildOptions): Promise<BuildOutcome> {
  const started = Date.now();
  const { project, root, nodes, backends } = options;
  const mode = options.mode ?? project.build.mode ?? 'debug';
  const diagnostics = new DiagnosticBag();
  const steps: BuildStep[] = [];
  const toolchain: ToolStatus[] = [];
  const written: string[] = [];
  const artifacts: string[] = [];

  const step = async <X>(stage: BuildStage, label: string, fn: () => Promise<X> | X): Promise<X> => {
    const t0 = Date.now();
    const value = await fn();
    const record: BuildStep = { stage, label, ok: diagnostics.ok, durationMs: Date.now() - t0 };
    steps.push(record);
    options.onStep?.(record);
    return value;
  };

  // -- generate (validation happens inside) ----------------------------------
  const generated = await step('generate', 'Generate source', () =>
    generate(project, {
      nodes,
      backends,
      readExisting: (path) => readProjectFile(root, path),
    }),
  );
  diagnostics.merge(generated.diagnostics);
  const sourceMap = buildSourceMap(project, generated);

  if (!diagnostics.ok) {
    return finish(false, 'generation failed');
  }

  // -- write ------------------------------------------------------------------
  if (!options.dryRun) {
    await step('write', 'Write files', () => {
      const result = writeArtifacts(root, generated.files, generated.orphanedRegions);
      diagnostics.merge(result.diagnostics);
      written.push(...result.written);
      const record = steps[steps.length - 1];
      if (record) {
        record.detail = `${result.written.length} written, ${result.unchanged.length} unchanged`;
      }
    });
  }
  if (!diagnostics.ok) return finish(false, 'writing failed');
  if (options.generateOnly) return finish(true, 'generate only');

  // -- record which dependencies are present ---------------------------------
  await step('dependencies', 'Check dependencies', () => {
    for (const language of project.languages) {
      const backend = backends.get(language);
      if (!backend) continue;
      const manifest = backend.packageManager.manifestFile;
      const deps = project.dependencies.filter((d) => d.language === language);
      if (!deps.length) continue;
      const uninstalled = deps.filter((d) => !d.installed);
      if (uninstalled.length) {
        diagnostics.info(
          'dependency',
          'dependency/not-installed',
          `${uninstalled.length} ${backend.name} dependency(s) are recorded in ${manifest} but not installed.`,
          {
            file: manifest,
            hint: backend.packageManager.installAll
              ? `Install them with: ${backend.packageManager.installAll.command} ${backend.packageManager.installAll.args.join(' ')}`
              : 'Install them with your package manager.',
          },
        );
      }
    }
  });

  // -- compile ----------------------------------------------------------------
  for (const language of orderLanguages(project)) {
    const backend = backends.get(language);
    if (!backend) continue;
    const plan = backend.buildPlan(project, mode);
    if (!plan.steps.length) {
      steps.push({
        stage: 'compile',
        label: `${backend.name}: nothing to compile`,
        ok: true,
        durationMs: 0,
        detail: plan.note,
      });
      continue;
    }

    // Only probe a toolchain we are about to use.
    let toolsOk = true;
    for (const probe of backend.toolchain) {
      const status = await probeTool(probe.command, probe.versionArgs, probe.installHint);
      if (!toolchain.some((t) => t.command === status.command)) toolchain.push(status);
      if (!status.available) {
        toolsOk = false;
        diagnostics.error(
          'build',
          'build/toolchain-missing',
          `${backend.name} needs "${probe.command}", which is not on PATH.`,
          { hint: probe.installHint },
        );
      }
    }
    if (!toolsOk) continue;

    for (const spec of plan.steps) {
      const ran = await step('compile', `${backend.name}: ${spec.label}`, () =>
        runStep(spec, root, options),
      );
      const record = steps[steps.length - 1];
      const parsed = backend
        .parseDiagnostics(`${ran.stdout}\n${ran.stderr}`, project)
        .map((d) => mapDiagnostic(d, sourceMap));
      diagnostics.merge(parsed);

      if (record) {
        record.ok = ran.code === 0 && !ran.timedOut;
        record.output = trimOutput(`${ran.stdout}${ran.stderr}`);
        if (ran.startError) record.detail = ran.startError;
      }

      if (ran.startError) {
        diagnostics.error('build', 'build/spawn-failed', ran.startError, { hint: spec.label });
        break;
      }
      if (ran.timedOut) {
        diagnostics.error('build', 'build/timeout', `"${spec.label}" did not finish in time and was stopped.`);
        break;
      }
      if (ran.code !== 0 && !spec.optional) {
        // A non-zero exit with no parsed diagnostic still has to be reported,
        // or the build looks like it failed for no reason.
        if (!parsed.some((d) => d.severity === 'error')) {
          diagnostics.error('build', 'build/failed', `"${spec.label}" exited with code ${ran.code}.`, {
            raw: trimOutput(ran.stderr || ran.stdout, 1200),
          });
        }
        break;
      }
    }

    if (plan.artifact && existsSync(resolve(root, plan.artifact))) artifacts.push(plan.artifact);
  }

  return finish(diagnostics.ok, undefined);

  function finish(ok: boolean, note: string | undefined): BuildOutcome {
    if (note) {
      const last = steps[steps.length - 1];
      if (last && !last.detail) last.detail = note;
    }
    return {
      ok: ok && diagnostics.ok,
      steps,
      diagnostics,
      generated,
      sourceMap,
      written,
      artifacts,
      toolchain,
      durationMs: Date.now() - started,
    };
  }
}

async function runStep(spec: CommandSpec, root: string, options: BuildOptions): Promise<RunResult> {
  return runCommand({
    command: spec.command,
    args: spec.args,
    cwd: resolve(root, spec.cwd ?? '.'),
    env: spec.env,
    timeoutMs: 180_000,
    maxOutputBytes: 4_000_000,
    onOutput: options.onOutput,
    signal: options.signal,
  });
}

/**
 * Compile order across languages.
 *
 * Markup and stylesheets have nothing to compile, so they go last; everything
 * else keeps the project's declared order, which the user controls.
 */
function orderLanguages(project: Project): string[] {
  const weight = (language: string): number => (language === 'html' || language === 'css' ? 1 : 0);
  return [...new Set(project.languages)].sort((a, b) => weight(a) - weight(b) || a.localeCompare(b));
}

function trimOutput(text: string, max = 4000): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n[...]` : trimmed;
}

/** Human summary for the CLI. */
export function summarizeBuild(outcome: BuildOutcome): string {
  const errors = outcome.diagnostics.errors.length;
  const warnings = outcome.diagnostics.warnings.length;
  const bits = [
    outcome.ok ? 'build succeeded' : 'build failed',
    `${outcome.written.length} file(s) written`,
    `${errors} error(s)`,
    `${warnings} warning(s)`,
    `${outcome.durationMs} ms`,
  ];
  return bits.join(', ');
}
