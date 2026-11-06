/**
 * Converting between monolithic and modular layouts.
 *
 * The property that makes this safe is that nothing in a logic graph refers to
 * a path — references are file ids — so the real assertions are that the moves
 * are right, that regeneration produces imports matching the new layout, and
 * that the generated program still runs afterwards.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { createDefaultTemplates } from '#core/project/templates.ts';
import { generate } from '#core/codegen/generate.ts';
import { flatten, modularise } from '#core/project/architecture.ts';
import { validateFileGraph } from '#core/filegraph/graph.ts';
import { build } from '#core/build/pipeline.ts';
import { runInSandbox } from '#core/runtime/sandbox.ts';
import { probeTool } from '#core/runtime/exec.ts';
import type { Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();
const templates = createDefaultTemplates();

function make(templateId: string): Project {
  const template = must(templates.get(templateId), `template ${templateId}`);
  const project = template.build({
    registry: nodes,
    options: { name: 'Demo', language: template.language },
  });
  generate(project, { nodes, backends });
  return project;
}

/** Tracked source paths. Manifests are emitted by the backend, not modelled. */
function paths(project: Project): string[] {
  return project.files.map((f) => f.path).sort();
}

function contentOf(project: Project, path: string): string {
  const result = generate(project, { nodes, backends });
  return must(
    result.files.find((f) => f.path === path),
    path,
  ).content;
}

describe('architecture conversion', () => {
  it('flattens a modular project into the source root', () => {
    const project = make('python/api');
    assert.equal(project.architecture, 'modular');
    assert.ok(project.modules.length > 0);

    const result = flatten(project, { backends });
    assert.equal(result.changed, true);
    assert.equal(result.diagnostics.errors.length, 0, result.diagnostics.format());

    assert.equal(project.architecture, 'monolithic');
    assert.equal(project.modules.length, 0);
    for (const file of project.files.filter((f) => f.role !== 'config')) {
      assert.ok(!file.moduleId, `${file.path} should no longer belong to a module`);
    }
    assert.deepEqual(paths(project), ['src/main.py', 'src/repository.py', 'src/routes.py']);
  });

  it('rewrites the generated imports to match the flattened layout', () => {
    const project = make('python/api');
    const before = contentOf(project, 'src/main.py');
    assert.match(before, /from api\.routes import/);

    flatten(project, { backends });
    const after = contentOf(project, 'src/main.py');

    assert.match(after, /from routes import/);
    assert.doesNotMatch(after, /from api\.routes import/);
    assert.doesNotMatch(after, /storage\.repository/);
  });

  it('leaves the file graph valid after flattening', () => {
    const project = make('python/api');
    flatten(project, { backends });
    generate(project, { nodes, backends });
    const diag = validateFileGraph(project, backends);
    assert.equal(diag.errors.length, 0, diag.format());
  });

  it('reports the moves without performing them under dryRun', () => {
    const project = make('python/api');
    const before = paths(project);

    const result = flatten(project, { backends, dryRun: true });
    assert.ok(result.moves.length > 0);
    assert.deepEqual(paths(project), before, 'a dry run must not move anything');
    assert.equal(project.architecture, 'modular');
    assert.equal(project.modules.length > 0, true);
  });

  it('groups a flattened project back into modules by directory', () => {
    const project = make('python/api');
    flatten(project, { backends });

    // Flat now, so there are no subdirectories to infer boundaries from.
    const guessed = modularise(project, { backends });
    assert.equal(guessed.changed, false);
    assert.ok(guessed.diagnostics.items.some((d) => d.code === 'architecture/nothing-to-group'));

    const result = modularise(project, {
      backends,
      groups: { storage: ['src/repository.py'], api: ['src/routes.py'] },
    });
    assert.equal(result.diagnostics.errors.length, 0, result.diagnostics.format());
    assert.equal(project.architecture, 'modular');
    assert.deepEqual(result.modules.sort(), ['api', 'storage']);
    assert.deepEqual(paths(project), ['src/api/routes.py', 'src/main.py', 'src/storage/repository.py']);
  });

  it('keeps the entry point out of every module', () => {
    const project = make('python/api');
    flatten(project, { backends });
    modularise(project, {
      backends,
      // Naming the entry point explicitly must still not put it in a module.
      groups: { core: ['src/main.py', 'src/repository.py'] },
    });
    const entry = must(
      project.files.find((f) => f.role === 'entry'),
      'the entry file',
    );
    assert.equal(entry.moduleId, undefined);
    assert.equal(entry.path, 'src/main.py');
  });

  it('derives module dependencies from the imports that exist', () => {
    const project = make('python/api');
    flatten(project, { backends });
    modularise(project, {
      backends,
      groups: { storage: ['src/repository.py'], api: ['src/routes.py'] },
    });
    generate(project, { nodes, backends });

    const api = must(
      project.modules.find((m) => m.name === 'api'),
      'the api module',
    );
    const storage = must(
      project.modules.find((m) => m.name === 'storage'),
      'the storage module',
    );
    assert.deepEqual(api.dependencies, [storage.id], 'api imports storage, so it must depend on it');
    assert.deepEqual(storage.dependencies, [], 'storage imports nothing of ours');
  });

  it('renames rather than overwrites when flattening collides', () => {
    const project = make('python/api');
    // Force both module files to share a base name.
    const routes = must(
      project.files.find((f) => f.path === 'src/api/routes.py'),
      'routes.py',
    );
    routes.path = 'src/api/repository.py';

    const result = flatten(project, { backends });
    assert.equal(result.diagnostics.errors.length, 0, result.diagnostics.format());
    assert.ok(
      result.diagnostics.items.some((d) => d.code === 'architecture/renamed-on-flatten'),
      'the collision should be reported, not silent',
    );
    const flat = paths(project);
    assert.equal(new Set(flat).size, flat.length, 'no two files may end up at the same path');
    assert.ok(flat.some((p) => p.includes('repository')));
  });

  it('says so instead of working when the project is already in that shape', () => {
    const project = make('python/cli');
    assert.equal(project.architecture, 'monolithic');
    const result = flatten(project, { backends });
    assert.equal(result.changed, false);
    assert.ok(result.diagnostics.items.some((d) => d.code === 'architecture/already-monolithic'));
  });

  it('produces a project that still builds and runs', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');

    const dir = mkdtempSync(join(tmpdir(), 'mcode-arch-'));
    try {
      const project = make('python/api');
      flatten(project, { backends });
      project.grants.stdio = true;

      const outcome = await build({ project, root: dir, nodes, backends });
      assert.equal(outcome.ok, true, outcome.diagnostics.format());

      const run = await runInSandbox({
        project,
        root: dir,
        command: must(backends.require('python').runPlan(project, 'debug'), 'a run plan').command,
      });
      assert.equal(run.code, 0, run.stderr);
      // The api template prints the repository contents through the routes.
      assert.match(run.stdout, /first item/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
