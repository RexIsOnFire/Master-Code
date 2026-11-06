/**
 * The project symbol index.
 *
 * The property that matters most: a function is referenceable as soon as it is
 * drawn, not after the next generation. `file.exports` cannot answer that, so
 * these tests check the index reads the graphs and reports emission separately.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { createDefaultTemplates } from '#core/project/templates.ts';
import { generate } from '#core/codegen/generate.ts';
import { validateGraph } from '#core/lower/validate.ts';
import {
  closestName,
  duplicateSymbolNames,
  findSymbols,
  projectSymbols,
  symbolsVisibleFrom,
} from '#core/project/symbols.ts';
import { GraphBuilder, addFile, newProject } from '#core/project/builder.ts';
import type { Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();
const templates = createDefaultTemplates();

function build(templateId: string): Project {
  const template = must(templates.get(templateId), `template ${templateId}`);
  return template.build({ registry: nodes, options: { name: 'Demo', language: template.language } });
}

describe('project symbols', () => {
  it('lists a function before the project has ever been generated', () => {
    const project = build('python/api');
    const symbols = projectSymbols(project);

    const listItems = must(
      symbols.find((s) => s.name === 'list_items'),
      'list_items',
    );
    assert.equal(listItems.kind, 'function');
    assert.equal(listItems.filePath, 'src/api/routes.py');
    assert.equal(listItems.emitted, false, 'nothing has been generated yet');
    assert.ok(listItems.nodeId, 'a symbol must say which node declares it');
  });

  it('marks a symbol emitted once generation has produced it', () => {
    const project = build('python/api');
    generate(project, { nodes, backends });

    const listItems = must(
      projectSymbols(project).find((s) => s.name === 'list_items'),
      'list_items',
    );
    assert.equal(listItems.emitted, true);
  });

  it('renders a signature with parameters and a return type', () => {
    const project = build('python/api');
    const listItems = must(
      projectSymbols(project).find((s) => s.name === 'list_items'),
      'list_items',
    );
    assert.match(listItems.signature, /^list_items\(/);
    assert.match(listItems.signature, /store: Repository/);
    assert.match(listItems.signature, /-> List</);
  });

  it('finds classes and their methods, attributing each method to its class', () => {
    const project = build('python/api');
    const symbols = projectSymbols(project);

    const cls = must(
      symbols.find((s) => s.name === 'Repository' && s.kind === 'class'),
      'the Repository class',
    );
    assert.equal(cls.filePath, 'src/storage/repository.py');

    const method = must(
      symbols.find((s) => s.kind === 'method' && s.name === 'add'),
      'the add method',
    );
    assert.equal(method.owner, 'Repository');
    assert.match(method.signature, /^Repository\.add\(/);
  });

  it('carries the owning module, so the UI can group by it', () => {
    const project = build('python/api');
    const listItems = must(
      projectSymbols(project).find((s) => s.name === 'list_items'),
      'list_items',
    );
    assert.equal(listItems.moduleName, 'api');
  });

  it('includes graph variables and their scope', () => {
    const project = newProject({ name: 'Vars', language: 'python' });
    const { graph } = addFile(project, {
      path: 'src/main.py',
      language: 'python',
      role: 'entry',
      graph: { name: 'main', style: 'procedural' },
    });
    const builder = new GraphBuilder(project, nodes, must(graph, 'the graph'));
    builder.variable('counter', 'i64', undefined, 'module');
    builder.variable('scratch', 'string', undefined, 'local');

    const symbols = projectSymbols(project);
    const counter = must(symbols.find((s) => s.name === 'counter'), 'counter');
    assert.equal(counter.kind, 'variable');
    assert.equal(counter.scope, 'module');
    assert.equal(counter.signature, 'counter: i64');
    assert.ok(symbols.some((s) => s.name === 'scratch' && s.scope === 'local'));
  });

  it('hides another graph\'s local variables from what a file may reference', () => {
    const project = build('python/api');
    const routes = must(
      project.files.find((f) => f.path === 'src/api/routes.py'),
      'routes.py',
    );
    const graph = must(
      project.graphs.find((g) => g.id === project.files.find((f) => f.path === 'src/main.py')?.graphId),
      'the main graph',
    );
    const builder = new GraphBuilder(project, nodes, graph);
    builder.variable('main_only', 'i64', undefined, 'local');
    builder.variable('shared', 'i64', undefined, 'module');

    const visible = symbolsVisibleFrom(project, routes.id).map((s) => s.name);
    assert.ok(!visible.includes('main_only'), 'a local in another graph is not referenceable');
    assert.ok(visible.includes('shared'), 'a module-scoped variable is');
  });

  it('searches by name, signature and path', () => {
    const project = build('python/api');
    assert.ok(findSymbols(project, { search: 'list_it' }).some((s) => s.name === 'list_items'));
    assert.ok(findSymbols(project, { search: 'storage/' }).some((s) => s.name === 'Repository'));
    assert.equal(findSymbols(project, { search: 'nothing_like_this' }).length, 0);
    assert.ok(findSymbols(project, { kinds: ['class'] }).every((s) => s.kind === 'class'));
  });

  it('reports a name declared in two files as a duplicate', () => {
    const project = build('python/api');
    assert.equal(duplicateSymbolNames(project).size, 0);

    // Give a second file a function of the same name.
    const routes = must(
      project.graphs.find(
        (g) => g.id === project.files.find((f) => f.path === 'src/api/routes.py')?.graphId,
      ),
      'the routes graph',
    );
    const fn = must(
      routes.nodes.find((n) => n.type === 'entry/function'),
      'the routes function',
    );
    const repo = must(
      project.graphs.find(
        (g) => g.id === project.files.find((f) => f.path === 'src/storage/repository.py')?.graphId,
      ),
      'the repository graph',
    );
    const builder = new GraphBuilder(project, nodes, repo);
    builder.add('entry/function', { name: String(fn.props.name) });

    const duplicates = duplicateSymbolNames(project);
    assert.ok(duplicates.has('list_items'), 'the shared name should be flagged');
    assert.equal(must(duplicates.get('list_items'), 'the duplicate group').length, 2);
  });

  it('suggests a near miss, but not a wild guess', () => {
    assert.equal(closestName('list_item', ['list_items', 'main']), 'list_items');
    assert.equal(closestName('zzzzzz', ['list_items', 'main']), undefined);
  });
});

describe('calling a function in another file', () => {
  it('reports a target that does not exist, and suggests the right one', () => {
    const project = build('python/api');
    const graph = must(
      project.graphs.find(
        (g) => g.id === project.files.find((f) => f.path === 'src/main.py')?.graphId,
      ),
      'the main graph',
    );
    const callNode = must(
      graph.nodes.find((n) => n.type === 'control/call'),
      'the Call Function node',
    );
    callNode.props.target = 'list_item';

    const diag = validateGraph(graph, project, nodes, project.language).diagnostics;
    const error = must(
      diag.items.find((d) => d.code === 'call/unknown-target'),
      'an unknown-target error',
    );
    assert.equal(error.origin?.nodeId, callNode.id);
    assert.match(error.hint ?? '', /list_items/);
  });

  it('accepts a target declared in a different file', () => {
    const project = build('python/api');
    const graph = must(
      project.graphs.find(
        (g) => g.id === project.files.find((f) => f.path === 'src/main.py')?.graphId,
      ),
      'the main graph',
    );
    const diag = validateGraph(graph, project, nodes, project.language).diagnostics;
    assert.equal(
      diag.items.filter((d) => d.code.startsWith('call/')).length,
      0,
      diag.format(),
    );
  });

  it('generates the import for the file the target lives in', () => {
    const project = build('python/api');
    const result = generate(project, { nodes, backends });
    const main = must(
      result.files.find((f) => f.path === 'src/main.py'),
      'src/main.py',
    );
    assert.match(main.content, /from api\.routes import list_items/);
    assert.match(main.content, /from storage\.repository import Repository/);
  });
});
