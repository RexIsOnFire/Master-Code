/**
 * Shared test helpers.
 *
 * `must` exists because most lookups in these tests are `find()` calls whose
 * absence is itself the failure. Asserting there — with the name of the thing
 * being looked for — gives a better message than a downstream property access
 * on `undefined`, and keeps the tests type-checkable.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IrDecl, IrFunction } from '#core/ir/ir.ts';
import type { Project } from '#core/model/project.ts';
import type { NodeRegistry } from '#core/nodes/definition.ts';
import type { BackendRegistry } from '#core/backends/backend.ts';
import { build } from '#core/build/pipeline.ts';
import { runInSandbox } from '#core/runtime/sandbox.ts';

export function must<T>(value: T | undefined | null, what: string): T {
  assert.ok(value !== undefined && value !== null, `expected to find ${what}`);
  return value;
}

/** Finds a function declaration, narrowed off the `IrDecl` union. */
export function findFunction(
  decls: readonly IrDecl[],
  match: (fn: IrFunction) => boolean,
  what: string,
): IrFunction {
  return must(
    decls.find((d): d is IrFunction => d.k === 'function' && match(d)),
    what,
  );
}

/**
 * Generate, build and run a project the way the IDE does: through the
 * backend's own build plan and run plan, in a scratch directory.
 *
 * For compiled languages this is the test that matters - the toolchain, not a
 * text comparison, decides whether the generated source is valid.
 */
export async function buildAndRun(
  project: Project,
  language: string,
  registries: { nodes: NodeRegistry; backends: BackendRegistry },
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `mcode-${language}-`));
  try {
    const outcome = await build({ project, root: dir, ...registries });
    assert.equal(outcome.ok, true, `${language} did not build:\n${outcome.diagnostics.format()}`);
    const plan = must(registries.backends.require(language).runPlan(project, 'debug'), `a ${language} run plan`);
    // A JVM starting cold, plus a first compile, is slower than the default limit.
    const run = await runInSandbox({ project, root: dir, command: plan.command, timeoutMs: 120_000 });
    assert.equal(run.code, 0, `${language} exited ${run.code}:\n${run.stderr || run.stdout}`);
    return run.stdout.replace(/\r\n/g, '\n').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
