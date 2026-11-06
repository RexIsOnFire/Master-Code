/**
 * The sandbox gate, the library catalogue, the plugin host, and an end-to-end
 * build-and-run of a generated Python program.
 *
 * The build test is the one that would catch a whole class of regressions: it
 * asserts the generated program actually executes and prints what the graph
 * says it should, rather than merely that some text was produced.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { must } from './helpers.ts';
import type { Project } from '#core/model/project.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { createDefaultTemplates } from '#core/project/templates.ts';
import { generate } from '#core/codegen/generate.ts';
import { writeArtifacts } from '#core/project/io.ts';
import { build } from '#core/build/pipeline.ts';
import { checkCapabilities, requiredCapabilities, runInSandbox } from '#core/runtime/sandbox.ts';
import { probeTool, runCommand } from '#core/runtime/exec.ts';
import { CATALOG, catalogFor, catalogSummary, searchCatalog } from '#core/libraries/catalog.ts';
import { addToProject, planInstall, runInstall } from '#core/libraries/install.ts';
import { searchRegistry } from '#core/libraries/registry.ts';
import { PluginHost, definePlugin } from '#core/plugin/api.ts';
import { runTests } from '#core/testing/runner.ts';
import { buildSourceMap, mapDiagnostic } from '#core/build/sourcemap.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();
const templates = createDefaultTemplates();

function make(id: string) {
  const template = must(templates.get(id), `template ${id}`);
  return template.build({ registry: nodes, options: { name: 'Demo', language: template.language } });
}

/** Generates a project and returns the program for its primary language. */
function programFor(project: Project, language: string) {
  const result = generate(project, { nodes, backends });
  return must(
    result.programs.find((p) => p.language === language),
    `a ${language} program`,
  );
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcode-rt-'));
}

// ---------------------------------------------------------------------------

describe('capability gate', () => {
  it('lists what a program needs, with the nodes that need it', () => {
    const project = make('python/cli');
    const program = programFor(project, 'python');
    const required = requiredCapabilities(program);
    const env = required.find((r) => r.capability === 'env');
    assert.ok(env, 'the CLI template reads argv, so it needs env');
    assert.ok(env.origins.length > 0, 'the requirement should name a node');
  });

  it('refuses to run when a capability has not been granted', () => {
    const project = make('python/cli');
    const program = programFor(project, 'python');

    project.grants.env = false;
    const blocked = checkCapabilities(project, program);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.missing.some((m) => m.capability === 'env'));
    assert.match(blocked.diagnostics.format(), /mcode grant env/);

    project.grants.env = true;
    project.grants.stdio = true;
    assert.equal(checkCapabilities(project, program).ok, true);
  });

  it('stops a runaway process at the timeout', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');

    const dir = tempDir();
    try {
      const project = make('python/cli');
      project.sandbox.timeoutMs = 1200;
      const result = await runInSandbox({
        project,
        root: dir,
        command: { label: 'spin', command: 'python', args: ['-c', 'while True: pass'] },
      });
      assert.equal(result.timedOut, true);
      assert.equal(result.applied.timeoutMs, 1200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the limits it cannot enforce instead of implying it did', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');

    const dir = tempDir();
    try {
      const project = make('python/cli');
      const result = await runInSandbox({
        project,
        root: dir,
        command: { label: 'noop', command: 'python', args: ['-c', 'pass'] },
      });
      assert.equal(result.code, 0);
      // Python has no heap flag, so the memory cap must be declared unenforced.
      assert.equal(result.applied.memoryLimitMb, null);
      assert.ok(result.unenforced.some((n) => n.includes('memory limit')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe('library catalogue', () => {
  it('covers every language that has a package manager', () => {
    const summary = catalogSummary();
    for (const language of ['python', 'javascript', 'java', 'csharp', 'rust', 'go', 'cpp', 'c']) {
      const entry = summary.find((s) => s.language === language);
      assert.ok(entry, `no catalogue entries for ${language}`);
      assert.ok(entry.count >= 7, `${language} has only ${entry.count} entries`);
    }
  });

  it('gives every entry a version, licence and homepage', () => {
    for (const entry of CATALOG) {
      assert.ok(entry.version, `${entry.name} has no version`);
      assert.ok(entry.license, `${entry.name} has no licence`);
      assert.match(entry.homepage, /^https?:\/\//, `${entry.name} has no homepage`);
      assert.ok(entry.summary.length > 10, `${entry.name} needs a real summary`);
    }
  });

  it('searches offline without touching the network', async () => {
    const result = await searchRegistry({ language: 'python', query: 'http', allowNetwork: false });
    assert.equal(result.source, 'offline');
    assert.equal(result.remote.length, 0);
    assert.ok(result.local.some((e) => e.name === 'requests'));
    assert.match(result.note ?? '', /--online/);
  });

  it('ranks an exact name above a keyword match', () => {
    const hits = searchCatalog('flask', { language: 'python' });
    assert.equal(hits[0].name, 'flask');
  });

  it('adds a dependency to the manifest without downloading it', () => {
    const project = make('python/cli');
    const before = project.dependencies.length;
    const result = addToProject(project, { language: 'python', name: 'requests' });
    assert.equal(project.dependencies.length, before + 1);
    assert.equal(result.dependency.installed, false);
    assert.equal(result.dependency.manager, 'pip');
    assert.equal(result.dependency.license, 'Apache-2.0');
  });

  it('shows the exact install command before running anything', async () => {
    const project = make('python/cli');
    addToProject(project, { language: 'python', name: 'requests' });
    const plans = planInstall(project, backends);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].command?.command, 'python');
    assert.deepEqual(plans[0].command?.args, ['-m', 'pip', 'install', '-r', 'requirements.txt']);

    // Without confirmation, nothing runs.
    const refused = await runInstall(plans[0], tempDir(), false);
    assert.equal(refused.ok, false);
    assert.equal(refused.result, undefined);
    assert.match(refused.diagnostics.format(), /nothing was downloaded/i);
  });

  it('keeps every catalogue entry out of every project by default', () => {
    const project = make('python/cli');
    assert.equal(project.dependencies.length, 0);
    assert.ok(catalogFor('python').length > 20, 'the catalogue is still browsable');
  });
});

// ---------------------------------------------------------------------------

describe('plugin host', () => {
  it('registers a plugin\'s nodes and templates through the same registries', async () => {
    const host = new PluginHost({ nodes: createDefaultRegistry(), backends: createDefaultBackends(), templates: createDefaultTemplates() });
    const plugin = definePlugin({
      id: 'test.plugin',
      name: 'Test',
      version: '1.0.0',
      apiVersion: 1,
      contributes: {
        nodes: [
          {
            type: 'test/echo',
            category: 'Testing',
            title: 'Echo',
            description: 'A node contributed by a plugin, for the test suite.',
            inputs: [],
            outputs: [{ id: 'value', name: 'value', type: 'string' }],
            lower: () => ({ exprs: {} }),
          },
        ],
      },
    });
    // Exercise the same path `loadDirectory` uses, without touching disk.
    for (const node of must(plugin.contributes?.nodes, 'the contributed nodes')) {
      host['nodes'].register(node, plugin.id);
    }
    assert.ok(host['nodes'].get('test/echo'));
    assert.equal(host['nodes'].sourceOf('test/echo'), 'test.plugin');
  });

  it('rejects a plugin that claims an id already in use', () => {
    const registry = createDefaultRegistry();
    assert.throws(
      () =>
        registry.register(
          {
            type: 'io/print',
            category: 'X',
            title: 'X',
            description: 'clashes with a built-in node.',
            inputs: [],
            outputs: [],
            lower: () => ({}),
          },
          'evil.plugin',
        ),
      /already registered/,
    );
  });
});

// ---------------------------------------------------------------------------

describe('source mapping', () => {
  it('points a compiler diagnostic back at the node that produced the line', () => {
    const project = make('python/cli');
    const result = generate(project, { nodes, backends });
    const map = buildSourceMap(project, result);

    const mapped = mapDiagnostic(
      {
        severity: 'error',
        stage: 'build',
        code: 'python/syntax',
        message: "NameError: name 'build_greeting' is not defined",
        file: 'src/main.py',
        line: 20,
      },
      map,
    );
    assert.ok(mapped.origin, 'expected an origin');
    assert.ok(mapped.origin.nodeId || mapped.origin.graphId, 'expected a node or at least the graph');
  });
});

// ---------------------------------------------------------------------------

describe('end to end', () => {
  it('builds, runs and tests a generated Python project', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');

    const dir = tempDir();
    try {
      const project = make('python/cli');
      project.grants.env = true;
      project.grants.stdio = true;

      const outcome = await build({ project, root: dir, nodes, backends });
      assert.equal(outcome.ok, true, outcome.diagnostics.format());
      assert.ok(outcome.written.length >= 4);

      const run = await runInSandbox({
        project,
        root: dir,
        command: must(backends.require('python').runPlan(project, 'debug'), 'a python run plan')
          .command,
      });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /Hello, world!/);

      const tests = await runTests({ project, root: dir, backends, sourceMap: outcome.sourceMap });
      assert.equal(tests.ok, true, tests.diagnostics.format());
      assert.equal(tests.passed, 1);
      assert.ok(tests.results[0].nodeId, 'the test result should map back to its Test Case node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drives the whole slice from the command line, arguments included', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');

    const cli = fileURLToPath(new URL('../packages/cli/src/main.ts', import.meta.url));
    const dir = tempDir();
    const root = join(dir, 'Cli');
    try {
      const mcode = (cwd: string, ...argv: string[]) =>
        runCommand({ command: process.execPath, args: [cli, ...argv], cwd, timeoutMs: 180_000 });

      const created = await mcode(dir, 'new', 'Cli', '--template', 'python/cli');
      assert.equal(created.code, 0, created.stderr);

      // Ungranted: the gate has to refuse before anything is executed.
      const refused = await mcode(root, 'run');
      assert.equal(refused.code, 1);
      assert.match(refused.stdout + refused.stderr, /mcode grant env/);

      assert.equal((await mcode(root, 'grant', 'env')).code, 0);

      // Everything after `--` belongs to the program, not to mcode.
      const ran = await mcode(root, 'run', '--', 'Ada');
      assert.equal(ran.code, 0, ran.stderr);
      assert.match(ran.stdout, /Hello, Ada!/);

      const bogus = await mcode(root, 'run', '--allow', 'nonsense');
      assert.match(bogus.stdout + bogus.stderr, /unknown capability "nonsense"/i);
      assert.match(bogus.stdout, /Hello, world!/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams program output with the chunk first and the stream second', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');

    // `onOutput` is declared method-style, so TypeScript compares it
    // bivariantly and a swapped (stream, chunk) implementation type-checks
    // cleanly while printing the word "stdout" instead of the program output.
    // Only a runtime assertion catches that.
    const seen: { chunk: string; stream: string }[] = [];
    const dir = tempDir();
    try {
      const project = make('python/cli');
      project.grants.stdio = true;
      await build({ project, root: dir, nodes, backends });

      await runInSandbox({
        project,
        root: dir,
        command: must(backends.require('python').runPlan(project, 'debug'), 'a run plan').command,
        onOutput: (chunk, stream) => seen.push({ chunk, stream }),
      });

      assert.ok(seen.length > 0, 'the run produced no output at all');
      for (const { stream } of seen) {
        assert.ok(
          stream === 'stdout' || stream === 'stderr',
          `second argument should name the stream, got ${JSON.stringify(stream)}`,
        );
      }
      assert.match(
        seen.map((s) => s.chunk).join(''),
        /Hello, world!/,
        'the first argument should carry the program output',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports a project that stands on its own', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');

    const dir = tempDir();
    try {
      const project = make('python/pipeline');
      const result = generate(project, { nodes, backends });
      writeArtifacts(dir, result.files);

      // No project.json is written: the export is a plain Python project.
      const run = await runInSandbox({
        project,
        root: dir,
        command: { label: 'run', command: 'python', args: ['src/main.py'] },
      });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /sum of even squares: 1540/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
