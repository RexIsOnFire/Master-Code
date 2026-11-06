/**
 * Blank projects and challenges.
 *
 * The thing worth guarding here is that a *starting point* actually starts. A
 * blank project and a challenge both hand the user a file containing nothing
 * but an entry point, which is the least-exercised shape in the whole system
 * and the first one a new user meets. It shipped broken for Python: a function
 * whose body was one comment is an IndentationError, and generation does not
 * syntax-check, so nothing caught it until the code was run.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { createDefaultTemplates } from '#core/project/templates.ts';
import { generate } from '#core/codegen/generate.ts';
import { writeArtifacts } from '#core/project/io.ts';
import { build } from '#core/build/pipeline.ts';
import { runInSandbox } from '#core/runtime/sandbox.ts';
import { probeTool } from '#core/runtime/exec.ts';
import { CHALLENGES, challengeOf, challengesFor, checkOutput, getChallenge } from '#core/learn/challenges.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();
const templates = createDefaultTemplates();

const CODE_LANGUAGES = ['python', 'javascript', 'java', 'csharp', 'go', 'rust', 'cpp', 'c'];

describe('blank projects', () => {
  it('offers one for every language that can run code', () => {
    for (const language of CODE_LANGUAGES) {
      assert.ok(templates.get(`${language}/empty`), `${language} has no blank template`);
    }
    assert.ok(templates.get('html/empty'), 'html has no blank page');
  });

  it('puts the entry file where the backend expects it', () => {
    for (const language of CODE_LANGUAGES) {
      const template = must(templates.get(`${language}/empty`), language);
      const project = template.build({ registry: nodes, options: { name: 'Blank', language } });
      const entry = must(
        project.files.find((f) => f.role === 'entry'),
        `${language} entry file`,
      );
      assert.equal(entry.path, backends.require(language).entry.file);
    }
  });

  it('generates a syntactically valid empty program', () => {
    for (const language of CODE_LANGUAGES) {
      const template = must(templates.get(`${language}/empty`), language);
      const project = template.build({ registry: nodes, options: { name: 'Blank', language } });
      const result = generate(project, { nodes, backends });
      assert.equal(result.diagnostics.errors.length, 0, `${language}: ${result.diagnostics.format()}`);
    }
  });

  /**
   * The regression. `def main():` followed only by a comment is not a function
   * with an empty body, it is a syntax error — and only running the compiler
   * catches it.
   */
  it('gives an empty Python function a body Python accepts', () => {
    const template = must(templates.get('python/empty'), 'python/empty');
    const project = template.build({ registry: nodes, options: { name: 'Blank', language: 'python' } });
    const result = generate(project, { nodes, backends });
    const main = must(
      result.files.find((f) => f.path.endsWith('main.py')),
      'main.py',
    );
    const body = main.content.slice(main.content.indexOf('def main('));
    assert.match(body, /\bpass\b/, 'an empty function needs a pass statement, not just a comment');
  });

  it('actually runs', async (t) => {
    if (!(await probeTool('python', ['--version'])).available) return t.skip('python is not installed');

    const dir = mkdtempSync(join(tmpdir(), 'mcode-blank-'));
    try {
      const template = must(templates.get('python/empty'), 'python/empty');
      const project = template.build({ registry: nodes, options: { name: 'Blank', language: 'python' } });
      project.grants.stdio = true;

      const outcome = await build({ project, root: dir, nodes, backends });
      assert.equal(outcome.ok, true, outcome.diagnostics.format());

      const run = await runInSandbox({
        project,
        root: dir,
        command: must(backends.require('python').runPlan(project, 'debug'), 'a run plan').command,
      });
      assert.equal(run.code, 0, run.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('challenges', () => {
  it('runs from a tutorial through to hard', () => {
    const order = challengesFor(undefined).map((c) => c.difficulty);
    assert.equal(order[0], 'tutorial', 'the first thing offered should teach the basics');
    assert.ok(order.includes('easy') && order.includes('medium') && order.includes('hard'));
    // Sorted, so the list reads as a progression.
    const rank = { tutorial: 0, easy: 1, medium: 2, hard: 3 } as const;
    for (let i = 1; i < order.length; i++) {
      assert.ok(rank[order[i]!] >= rank[order[i - 1]!], 'challenges must be ordered by difficulty');
    }
  });

  it('describes every challenge fully', () => {
    for (const c of CHALLENGES) {
      assert.ok(c.brief.length > 20, `${c.id} needs a real brief`);
      assert.ok(c.steps.length >= 3, `${c.id} needs steps`);
      assert.ok(c.hints.length >= 1, `${c.id} needs at least one hint`);
      assert.ok(c.expect.length >= 1, `${c.id} needs something to check`);
    }
  });

  it('starts cleanly in every language that can run code', () => {
    for (const challenge of CHALLENGES) {
      for (const language of ['python', 'javascript', 'java', 'csharp', 'go', 'rust']) {
        const backend = backends.require(language);
        const project = challenge.start({
          registry: nodes,
          options: { name: 'Ch', language },
          entryPath: backend.entry.file,
        });
        const result = generate(project, { nodes, backends });
        assert.equal(
          result.diagnostics.errors.length,
          0,
          `${challenge.id} in ${language}: ${result.diagnostics.format()}`,
        );
      }
    }
  });

  it('remembers which challenge a project came from', () => {
    const challenge = must(getChallenge('calculator'), 'the calculator');
    const project = challenge.start({
      registry: nodes,
      options: { name: 'Calc', language: 'python' },
      entryPath: 'src/main.py',
    });
    assert.equal(challengeOf(project)?.id, 'calculator');
    // A project from a template is not a challenge.
    const plain = must(templates.get('python/cli'), 'python/cli').build({
      registry: nodes,
      options: { name: 'Plain', language: 'python' },
    });
    assert.equal(challengeOf(plain), undefined);
  });

  it('grants the capabilities the challenge needs up front', () => {
    const challenge = must(getChallenge('calculator'), 'the calculator');
    const project = challenge.start({
      registry: nodes,
      options: { name: 'Calc', language: 'python' },
      entryPath: 'src/main.py',
    });
    // The calculator reads argv; being refused on first Run would read as a
    // broken exercise rather than as the sandbox working.
    assert.equal(project.grants.env, true);
    assert.equal(project.grants.stdio, true);
  });
});

describe('checking an answer', () => {
  const stats = must(getChallenge('number-stats'), 'number-stats');

  it('passes correct output whatever the language spells it like', () => {
    // Python, Go and JavaScript render the same list three ways.
    for (const list of ['[1, 3, 5, 8, 9]', '[1 3 5 8 9]', '1,3,5,8,9']) {
      const result = checkOutput(stats, `min: 1\nmax: 9\nsum: 26\n${list}`);
      assert.equal(result.passed, true, `${list} should pass: ${result.message}`);
    }
  });

  it('requires the expectations in order', () => {
    const result = checkOutput(stats, 'sum: 26\nmin: 1\nmax: 9\n[1, 3, 5, 8, 9]');
    assert.equal(result.passed, false, 'out-of-order output should not pass');
  });

  it('says which expectation was missing rather than just failing', () => {
    const result = checkOutput(stats, 'min: 1\nmax: 9\n[1, 3, 5, 8, 9]');
    assert.equal(result.passed, false);
    assert.match(result.message, /sum: 26/);
    // The list is still found after the missing sum: each expectation is
    // reported on its own, and only the ones that matched advance the cursor.
    // Reporting everything after the first miss as absent would hide progress.
    assert.deepEqual(
      result.checks.map((c) => c.found),
      [true, true, false, true],
    );
  });

  it('is not fooled by an empty run', () => {
    assert.equal(checkOutput(stats, '').passed, false);
    assert.equal(checkOutput(must(getChallenge('add-two'), 'add-two'), '').passed, false);
  });
});
