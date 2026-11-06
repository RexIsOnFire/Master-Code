/**
 * The Architecture view's layout.
 *
 * The view itself needs a canvas, but the part that can be wrong in an
 * interesting way — where each file lands, which module band it falls in, and
 * what happens when the graph has a cycle — is a pure function, and this is it.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { createDefaultTemplates } from '#core/project/templates.ts';
import { FileGraph } from '#core/filegraph/graph.ts';
import { generate } from '#core/codegen/generate.ts';
import type { Project } from '#core/model/project.ts';

// The view is browser code, but it is plain ESM and touches the DOM only inside
// methods, so the pure exports import fine under `node --test`.
// @ts-expect-error - untyped browser module, deliberately not part of the TS program
import { dependencyDepths, layoutFileGraph } from '../packages/ide/public/architecture.js';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();
const templates = createDefaultTemplates();

interface Placed {
  file: { id: string; path: string };
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Layout {
  nodes: Placed[];
  groups: { name: string; x: number; y: number; w: number; h: number }[];
  edges: { from: Placed; to: Placed; cyclic: boolean }[];
}

/**
 * Builds a template and generates once. Import edges are discovered during
 * emission, so a project that has never been generated has no file graph to
 * lay out — which is also what the IDE shows before the first Generate.
 */
function build(templateId: string): Project {
  const template = must(templates.get(templateId), `template ${templateId}`);
  const project = template.build({
    registry: nodes,
    options: { name: 'Demo', language: template.language },
  });
  generate(project, { nodes, backends });
  return project;
}

function graphOf(project: Project) {
  const fg = new FileGraph(project);
  return { edges: fg.edges, cycles: fg.cycles(), summary: [] };
}

function at(layout: Layout, path: string): Placed {
  return must(
    layout.nodes.find((n) => n.file.path === path),
    path,
  );
}

describe('architecture layout', () => {
  it('places a file to the right of everything it imports', () => {
    const project = build('python/api');
    const layout = layoutFileGraph(project, graphOf(project), {}) as Layout;

    const repository = at(layout, 'src/storage/repository.py');
    const routes = at(layout, 'src/api/routes.py');
    const main = at(layout, 'src/main.py');

    assert.ok(repository.x < routes.x, 'the repository is a dependency of the routes');
    assert.ok(routes.x < main.x, 'the routes are a dependency of the entry point');
  });

  it('draws a band around each module', () => {
    const project = build('python/api');
    const layout = layoutFileGraph(project, graphOf(project), { groupByModule: true }) as Layout;

    assert.equal(layout.groups.length, project.modules.length);
    for (const module of project.modules) {
      const band = must(
        layout.groups.find((g) => g.name === module.name),
        `a band for ${module.name}`,
      );
      const members = layout.nodes.filter((n) =>
        project.files.find((f) => f.id === n.file.id)?.moduleId === module.id,
      );
      assert.ok(members.length > 0, `${module.name} should have members`);
      for (const m of members) {
        assert.ok(
          m.x >= band.x && m.x + m.w <= band.x + band.w && m.y >= band.y && m.y + m.h <= band.y + band.h,
          `${m.file.path} should sit inside the ${module.name} band`,
        );
      }
    }
  });

  it('drops the bands when grouping is turned off', () => {
    const project = build('python/api');
    const layout = layoutFileGraph(project, graphOf(project), { groupByModule: false }) as Layout;
    assert.equal(layout.groups.length, 0);
  });

  it('is stable: the same project lays out identically twice', () => {
    const project = build('python/api');
    const a = layoutFileGraph(project, graphOf(project), {}) as Layout;
    const b = layoutFileGraph(project, graphOf(project), {}) as Layout;
    const key = (l: Layout) => l.nodes.map((n) => `${n.file.path}@${n.x},${n.y}`).join('|');
    assert.equal(key(a), key(b));
  });

  it('still lays out a graph with a cycle, and marks the edges that close it', () => {
    // Two files importing each other: no depth ordering exists, so the layout
    // has to break the loop rather than recurse forever.
    const project = {
      files: [
        { id: 'a', path: 'src/a.py', kind: 'generated', role: 'source' },
        { id: 'b', path: 'src/b.py', kind: 'generated', role: 'source' },
        { id: 'c', path: 'src/c.py', kind: 'generated', role: 'entry' },
      ],
      modules: [],
    };
    const fileGraph = {
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'c', to: 'a' },
      ],
      cycles: [['a', 'b']],
      summary: [],
    };

    const layout = layoutFileGraph(project, fileGraph, {}) as Layout;
    assert.equal(layout.nodes.length, 3, 'every file is still placed');

    const cyclic = layout.edges.filter((e) => e.cyclic);
    assert.equal(cyclic.length, 2, 'both directions of the loop are marked');
    assert.ok(
      layout.edges.some((e) => !e.cyclic && e.from.file.id === 'c'),
      "the entry point's edge is not part of the cycle",
    );

    // The cycle members share a column; the file importing them sits right.
    assert.equal(at(layout, 'src/a.py').x, at(layout, 'src/b.py').x);
    assert.ok(at(layout, 'src/c.py').x > at(layout, 'src/a.py').x);
  });

  it('hides external files unless asked, and never places an edge to a hidden file', () => {
    const project = {
      files: [
        { id: 'a', path: 'src/a.py', kind: 'generated', role: 'entry' },
        { id: 'v', path: 'vendor/lib.py', kind: 'external', role: 'source' },
      ],
      modules: [],
    };
    const fileGraph = { edges: [{ from: 'a', to: 'v' }], cycles: [], summary: [] };

    const hidden = layoutFileGraph(project, fileGraph, { showExternal: false }) as Layout;
    assert.equal(hidden.nodes.length, 1);
    assert.equal(hidden.edges.length, 0, 'an edge to a hidden file must not be drawn');

    const shown = layoutFileGraph(project, fileGraph, { showExternal: true }) as Layout;
    assert.equal(shown.nodes.length, 2);
    assert.equal(shown.edges.length, 1);
  });

  it('gives an unconnected file depth zero rather than dropping it', () => {
    const files = [{ id: 'lonely', path: 'src/lonely.py' }];
    const depths = dependencyDepths(files, [], new Set()) as Map<string, number>;
    assert.equal(depths.get('lonely'), 0);
  });

  it('returns an empty layout for a project with nothing to show', () => {
    const layout = layoutFileGraph({ files: [], modules: [] }, { edges: [], cycles: [] }, {}) as Layout;
    assert.deepEqual(layout, { nodes: [], groups: [], edges: [] });
  });
});
