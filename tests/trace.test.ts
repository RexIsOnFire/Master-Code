/**
 * Execution tracing.
 *
 * The claim being tested is narrow and worth stating: after a run, the trace
 * says which nodes executed and how often. It is not a debugger — no stepping,
 * no breakpoints — and the interesting failure mode is not a crash but a wrong
 * answer, specifically reporting a node as never having run when it did. These
 * check both directions on a graph with two branches, where the right answer
 * changes with the input.
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
import { buildSourceMap } from '#core/build/sourcemap.ts';
import { writeArtifacts } from '#core/project/io.ts';
import { runTraced } from '#core/build/run-traced.ts';
import { canTrace, includeInlinedInputs, unreachedNodes } from '#core/build/trace.ts';
import { probeTool } from '#core/runtime/exec.ts';
import type { Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();
const templates = createDefaultTemplates();

function build(templateId: string): Project {
  const template = must(templates.get(templateId), `template ${templateId}`);
  const project = template.build({
    registry: nodes,
    options: { name: 'Traced', language: template.language },
  });
  project.grants.stdio = true;
  project.grants.env = true;
  return project;
}

/** Node titles that executed, for readable assertions. */
async function traceTitles(project: Project, args: string[]): Promise<{ ran: Set<string>; cold: Set<string> }> {
  const dir = mkdtempSync(join(tmpdir(), 'mcode-trace-'));
  try {
    const generated = generate(project, { nodes, backends });
    assert.equal(generated.diagnostics.errors.length, 0, generated.diagnostics.format());
    writeArtifacts(dir, generated.files);

    const backend = backends.require(project.language);
    const plan = must(backend.runPlan(project, 'debug'), 'a run plan');
    const { run, trace: raw } = await runTraced({
      project,
      root: dir,
      language: project.language,
      command: { ...plan.command, args: [...plan.command.args, ...args] },
      sourceMap: buildSourceMap(project, generated),
    });
    assert.equal(run.code, 0, run.stderr);

    const trace = includeInlinedInputs(raw, project.graphs, (type) => !!nodes.get(type)?.pure);
    const title = (id: string): string => {
      for (const graph of project.graphs) {
        const node = graph.nodes.find((n) => n.id === id);
        if (node) return `${graph.name}/${nodes.get(node.type)?.title ?? node.type}`;
      }
      return id;
    };
    const all = project.graphs.flatMap((g) => g.nodes.map((n) => n.id));
    return {
      ran: new Set(trace.nodes.map((n) => title(n.nodeId))),
      cold: new Set(unreachedNodes(trace, all).map(title)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('execution tracing', () => {
  it('knows which languages it can trace', () => {
    assert.equal(canTrace('python'), true);
    assert.equal(canTrace('javascript'), true);
    assert.equal(canTrace('rust'), false);
  });

  it('runs the program normally when the language has no tracer', async (t) => {
    if (!(await probeTool('python', ['--version'])).available) return t.skip('python is not installed');

    const project = build('python/cli');
    const dir = mkdtempSync(join(tmpdir(), 'mcode-untraced-'));
    try {
      const generated = generate(project, { nodes, backends });
      writeArtifacts(dir, generated.files);
      const plan = must(backends.require('python').runPlan(project, 'debug'), 'a run plan');

      // Claim an untraceable language; the program must still run and the
      // trace must say why it is empty rather than implying nothing executed.
      const { run, trace } = await runTraced({
        project,
        root: dir,
        language: 'rust',
        command: plan.command,
        sourceMap: buildSourceMap(project, generated),
      });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /Hello, world!/);
      assert.match(trace.unsupported ?? '', /not implemented for rust/);
      assert.equal(trace.nodes.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the branch that ran, and not the one that did not', async (t) => {
    if (!(await probeTool('python', ['--version'])).available) return t.skip('python is not installed');

    const withArg = await traceTitles(build('python/cli'), ['Ada']);
    const withoutArg = await traceTitles(build('python/cli'), []);

    // Both paths go through these.
    for (const shared of ['main/Main', 'main/If', 'main/Print', 'greeting/Function']) {
      assert.ok(withArg.ran.has(shared), `${shared} should run with an argument`);
      assert.ok(withoutArg.ran.has(shared), `${shared} should run without one`);
    }

    // The argument path reads argv; the default path does not.
    assert.ok(withArg.ran.has('main/Get At'), 'the argument branch indexes argv');
    assert.ok(withoutArg.cold.has('main/Get At'), 'the default branch must not');
  });

  it('credits a pure node that was inlined into a statement that ran', async (t) => {
    if (!(await probeTool('python', ['--version'])).available) return t.skip('python is not installed');

    // Format has no statement of its own — it disappears into the return
    // expression — so only the inlining inference can find it. Reporting it as
    // dead would be a wrong answer, not a missing one.
    const { ran } = await traceTitles(build('python/cli'), ['Ada']);
    assert.ok(ran.has('greeting/Format'), 'an inlined Format node still ran');
    assert.ok(ran.has('main/Length'), 'the condition\'s inputs ran');
  });

  it('counts a loop body once per iteration', async (t) => {
    if (!(await probeTool('python', ['--version'])).available) return t.skip('python is not installed');

    const project = build('python/pipeline');
    const dir = mkdtempSync(join(tmpdir(), 'mcode-loop-'));
    try {
      const generated = generate(project, { nodes, backends });
      writeArtifacts(dir, generated.files);
      const plan = must(backends.require('python').runPlan(project, 'debug'), 'a run plan');
      const { run, trace } = await runTraced({
        project,
        root: dir,
        language: 'python',
        command: plan.command,
        sourceMap: buildSourceMap(project, generated),
      });
      assert.equal(run.code, 0, run.stderr);
      assert.ok(trace.nodes.length > 0, 'the pipeline should attribute at least one node');
      assert.ok(
        trace.nodes.every((n) => n.count >= 1),
        'a node that ran must have a count of at least one',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no tracer files behind', async (t) => {
    if (!(await probeTool('python', ['--version'])).available) return t.skip('python is not installed');

    const project = build('python/cli');
    const dir = mkdtempSync(join(tmpdir(), 'mcode-clean-'));
    try {
      const generated = generate(project, { nodes, backends });
      writeArtifacts(dir, generated.files);
      const plan = must(backends.require('python').runPlan(project, 'debug'), 'a run plan');
      await runTraced({
        project,
        root: dir,
        language: 'python',
        command: plan.command,
        sourceMap: buildSourceMap(project, generated),
      });

      // The tracer is scaffolding. Leaving it in the output directory would put
      // it in the Source view and, worse, in an export.
      const { readdirSync } = await import('node:fs');
      const left = readdirSync(dir).filter((name) => name.startsWith('_mcode_trace') || name.startsWith('.mcode-trace'));
      assert.deepEqual(left, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
