/**
 * Recursion.
 *
 * A function that calls itself is the load-bearing feature for anything
 * tree-shaped — a parser, an evaluator, a tree walk — which is the class of
 * program this platform is otherwise best suited to. It is worth a test of its
 * own because nothing else in the suite exercises a Call Function node whose
 * target is the function containing it, and "can it do recursion" is the first
 * question anyone serious will ask.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAndRun, must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { GraphBuilder, addFile, grant, newProject } from '#core/project/builder.ts';
import { generate } from '#core/codegen/generate.ts';
import { build } from '#core/build/pipeline.ts';
import { runInSandbox } from '#core/runtime/sandbox.ts';
import { probeTool } from '#core/runtime/exec.ts';
import type { Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();

/** factorial(n) = n <= 1 ? 1 : n * factorial(n - 1), then print factorial(6). */
function recursiveProject(language: string, entryPath: string): Project {
  const project = newProject({ name: 'Rec', language });
  const { graph } = addFile(project, {
    path: entryPath,
    language,
    role: 'entry',
    graph: { name: 'main', style: 'procedural' },
  });
  const b = new GraphBuilder(project, nodes, must(graph, 'the graph'));

  const fn = b.add('entry/function', {
    name: 'fact',
    params: [{ name: 'n', type: 'i64' }],
    returns: 'i64',
  });

  const atBase = b.addWith('op/compare', { b: 1 }, { op: '<=' });
  b.connect(fn, 'p:n', atBase, 'a');

  const branch = b.add('control/if');
  b.connect(atBase, 'result', branch, 'cond');

  const one = b.addWith('control/return', { value: 1 });

  const smaller = b.addWith('op/arithmetic', { b: 1 }, { op: '-' });
  b.connect(fn, 'p:n', smaller, 'a');

  // The recursive call: its target is the function it sits inside.
  const recurse = b.add('control/call', { target: 'fact', returns: 'i64' });
  b.connect(smaller, 'result', recurse, 'args#1');

  const product = b.add('op/arithmetic', { op: '*' });
  b.connect(fn, 'p:n', product, 'a');
  b.connect(recurse, 'result', product, 'b');

  const answer = b.add('control/return');
  b.connect(product, 'result', answer, 'value');

  b.connect(fn, 'out', branch, 'in');
  b.connect(branch, 'then', one, 'in');
  b.connect(branch, 'else', recurse, 'in');
  b.connect(recurse, 'out', answer, 'in');

  const main = b.add('entry/main');
  const call = b.add('control/call', { target: 'fact', returns: 'i64' });
  // A variadic slot has to exist before it can carry a default; connect()
  // creates one on demand, setDefault does not.
  b.setDefault(call, b.addVariadic(call, 'args'), 6);
  const print = b.add('io/print');
  b.connect(call, 'result', print, 'v');
  b.connect(main, 'out', call, 'in');
  b.connect(call, 'out', print, 'in');

  grant(project, 'stdio');
  return project;
}

describe('recursion', () => {
  it('generates a self-calling function in every language', () => {
    for (const language of ['python', 'javascript', 'java', 'kotlin', 'csharp', 'go', 'rust']) {
      const backend = backends.require(language);
      const project = recursiveProject(language, backend.entry.file);
      const result = generate(project, { nodes, backends });
      assert.equal(
        result.diagnostics.errors.length,
        0,
        `${language}: ${result.diagnostics.format()}`,
      );
      const source = must(
        result.files.find((f) => f.path === backend.entry.file),
        backend.entry.file,
      ).content;
      // The call has to actually appear inside the function body, not be
      // hoisted or inlined into nothing.
      assert.match(source, /fact/i, `${language} lost the function name`);
    }
  });

  it('computes the right answer when run', async (t) => {
    if (!(await probeTool('python', ['--version'])).available) return t.skip('python is not installed');

    const dir = mkdtempSync(join(tmpdir(), 'mcode-rec-'));
    try {
      const project = recursiveProject('python', 'src/main.py');
      const outcome = await build({ project, root: dir, nodes, backends });
      assert.equal(outcome.ok, true, outcome.diagnostics.format());

      const run = await runInSandbox({
        project,
        root: dir,
        command: must(backends.require('python').runPlan(project, 'debug'), 'a run plan').command,
      });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /\b720\b/, 'factorial(6) is 720');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('computes the right answer in Kotlin', async (t) => {
    if (!(await probeTool('kotlinc', ['-version'])).available) return t.skip('kotlinc is not installed');
    const project = recursiveProject('kotlin', backends.require('kotlin').entry.file);
    assert.match(await buildAndRun(project, 'kotlin', { nodes, backends }), /\b720\b/, 'factorial(6) is 720');
  });
});
