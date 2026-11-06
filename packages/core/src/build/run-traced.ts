/**
 * Running a program under the tracer.
 *
 * Kept separate from `runInSandbox` so the ordinary path stays exactly as it
 * was: tracing writes an extra file into the output directory, and a run that
 * has nothing to do with tracing should not carry that.
 *
 * The tracer files are removed afterwards whatever happens. They are not part
 * of the project, they must never be exported, and leaving them behind would
 * put them in front of the user in the Source view.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { CommandSpec } from '../backends/backend.ts';
import type { Project } from '../model/project.ts';
import type { SandboxResult } from '../runtime/sandbox.ts';
import { runInSandbox } from '../runtime/sandbox.ts';
import type { GeneratedSourceMap } from './sourcemap.ts';
import type { TraceResult } from './trace.ts';
import { canTrace, readTrace, tracePlan } from './trace.ts';

export interface TracedRunOptions {
  project: Project;
  /** The generated output directory. */
  root: string;
  language: string;
  command: CommandSpec;
  sourceMap: GeneratedSourceMap;
  stdin?: string;
  onOutput?(chunk: string, stream: 'stdout' | 'stderr'): void;
}

export interface TracedRunResult {
  run: SandboxResult;
  trace: TraceResult;
}

/**
 * Runs the program and returns both its output and which nodes executed.
 *
 * A language with no tracer still runs — normally, and with `trace.unsupported`
 * saying why there is no data. Refusing to run at all would be a worse trade
 * than running without the extra information.
 */
export async function runTraced(options: TracedRunOptions): Promise<TracedRunResult> {
  const { project, root, language, command, sourceMap } = options;

  if (!canTrace(language)) {
    const run = await runInSandbox({
      project,
      root,
      command,
      stdin: options.stdin,
      onOutput: options.onOutput,
    });
    return {
      run,
      trace: {
        nodes: [],
        unattributed: 0,
        hits: [],
        unsupported: `Tracing is not implemented for ${language}. The program ran normally.`,
      },
    };
  }

  const plan = tracePlan(language, command);
  if (!plan) throw new Error(`No trace plan for ${language}.`);

  const outputRoot = resolve(root, command.cwd ?? '.');
  for (const file of plan.files) {
    writeFileSync(join(outputRoot, file.path), file.content, 'utf8');
  }

  try {
    const run = await runInSandbox({
      project,
      root,
      command: plan.command,
      stdin: options.stdin,
      onOutput: options.onOutput,
    });
    const trace = readTrace(outputRoot, plan, sourceMap);
    return { run, trace };
  } finally {
    for (const file of plan.files) {
      rmSync(join(outputRoot, file.path), { force: true });
    }
    rmSync(join(outputRoot, plan.resultPath), { force: true });
  }
}
