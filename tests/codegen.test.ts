/**
 * Code generation: every backend, every template, plus the properties the
 * generated tree has to have — determinism, real cross-file imports, preserved
 * user regions, and honest refusals where a language cannot express something.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { must } from './helpers.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { createDefaultTemplates } from '#core/project/templates.ts';
import { generate } from '#core/codegen/generate.ts';
import { mergeRegions, parseRegions } from '#core/codegen/regions.ts';
import { loadProject, saveProject, writeArtifacts } from '#core/project/io.ts';
import { GraphBuilder, addFile, newProject } from '#core/project/builder.ts';
import { FileGraph, renameFile, validateFileGraph } from '#core/filegraph/graph.ts';
import { parseType } from '#core/types/types.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();
const templates = createDefaultTemplates();

function build(templateId: string) {
  const template = templates.get(templateId);
  assert.ok(template, `missing template ${templateId}`);
  return template.build({ registry: nodes, options: { name: 'Demo', language: template.language } });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcode-test-'));
}

// ---------------------------------------------------------------------------

describe('backends', () => {
  it('registers eleven languages with distinct extensions', () => {
    assert.equal(backends.all().length, 11);
    const ids = backends.ids().sort();
    assert.deepEqual(ids, ['c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript', 'kotlin', 'python', 'rust']);
  });

  it('maps the common types in every language', () => {
    const project = newProject({ name: 'Types', language: 'python' });
    const samples = ['bool', 'i64', 'f64', 'string', 'List<string>', 'Map<string, i64>', 'Option<f64>'];
    for (const backend of backends.all()) {
      for (const text of samples) {
        const mapped = backend.mapType(parseType(text), project);
        assert.ok(mapped && mapped.length, `${backend.id} produced nothing for ${text}`);
      }
    }
  });

  it('states its maturity honestly', () => {
    for (const backend of backends.all()) {
      assert.ok(['full', 'generates', 'stub'].includes(backend.maturity), backend.id);
    }
    // The languages this repo actually builds and runs claim `full`.
    for (const id of ['python', 'javascript', 'java', 'kotlin', 'csharp']) {
      assert.equal(backends.require(id).maturity, 'full', `${id} is exercised by the suite`);
    }
  });

  it('declares the features it lacks rather than failing later', () => {
    const c = backends.require('c').features;
    assert.equal(c.closures, false);
    assert.equal(c.exceptions, false);
    assert.equal(c.generics, false);
    assert.equal(backends.require('python').features.classes, true);
  });
});

// ---------------------------------------------------------------------------

describe('templates', () => {
  const ids = templates.all().map((t) => t.id);

  for (const id of ids) {
    it(`generates ${id} without errors`, () => {
      const project = build(id);
      const result = generate(project, { nodes, backends });
      const errors = result.diagnostics.errors;
      assert.equal(errors.length, 0, `${id}:\n${result.diagnostics.format()}`);
      assert.ok(result.files.length > 0, `${id} produced no files`);
    });
  }

  /**
   * A build plan can name a file the generator never writes, and nothing in the
   * type system catches it — the failure only shows up as a compiler error on a
   * machine that has the toolchain. This checks the two directions agree.
   */
  it('generates every file its own build plan refers to', () => {
    for (const id of ids) {
      const project = build(id);
      const result = generate(project, { nodes, backends });
      const written = new Set(result.files.map((f) => f.path));
      // Every language in the project, not just its primary one. A web project
      // is mostly HTML but still has a JavaScript build step, and checking only
      // the primary backend is how that step went unexamined.
      const languages = [...new Set(project.files.map((f) => f.language))];

      // Anything the plan names that looks like a source file it expects to
      // find. Output paths (-o build/app) and flag values are excluded, which
      // is why this only looks at source extensions.
      const sourceExtensions = backends
        .all()
        .flatMap((b) => b.extensions)
        .filter((e) => e !== '.json' && e !== '.txt');

      for (const language of languages) {
      const backend = backends.get(language);
      if (!backend) continue;
      for (const step of backend.buildPlan(project, 'debug').steps) {
        for (const [i, arg] of step.args.entries()) {
          // javac's `@file` argfile.
          if (arg.startsWith('@')) {
            const referenced = arg.slice(1);
            assert.ok(
              written.has(referenced),
              `${id}: the ${backend.name} build plan passes "${arg}" but nothing generates ${referenced}`,
            );
            continue;
          }
          // A bare source path, such as node's `--check src/app.js`. The
          // previous version of this test missed exactly that, and a web
          // project whose entry is HTML had its build fail on a `src/main.js`
          // that was never generated.
          if (!sourceExtensions.some((ext) => arg.endsWith(ext))) continue;
          if (step.args[i - 1] === '-o' || step.args[i - 1] === '--output') continue;
          assert.ok(
            written.has(arg),
            `${id}: the ${backend.name} build plan passes "${arg}" but nothing generates it`,
          );
        }
      }
      }
    }
  });

  /**
   * Paradigm and language are independent axes: a node definition may never
   * branch on the target language, so a graph in any style should generate for
   * any backend that declares the features it uses.
   *
   * This retargets real graphs — procedural, object-oriented and pipeline — at
   * every compiled language and asserts they emit. It is the test that catches
   * "we support functional programming" being true only for Python.
   */
  it('generates every paradigm for every language that claims the features', () => {
    const extensions: Record<string, string> = {
      python: '.py',
      javascript: '.js',
      java: '.java',
      csharp: '.cs',
      go: '.go',
      rust: '.rs',
      cpp: '.cpp',
    };
    const failures: string[] = [];

    for (const id of ['python/cli', 'python/pipeline', 'python/api']) {
      for (const [language, extension] of Object.entries(extensions)) {
        const project = build(id);
        project.language = language;
        project.languages = [language];
        for (const file of project.files) {
          if (file.language !== 'python') continue;
          file.language = language;
          file.path = file.path.replace(/\.py$/, extension);
        }
        const result = generate(project, { nodes, backends });
        if (result.diagnostics.errors.length) {
          failures.push(`${id} -> ${language}: ${result.diagnostics.errors.map((d) => d.message).join('; ')}`);
        }
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  /**
   * C is the deliberate exception, and it must refuse rather than emit
   * something that does not compile.
   */
  it('refuses a paradigm C cannot express, naming what is missing', () => {
    const project = build('python/api');
    project.language = 'c';
    project.languages = ['c'];
    for (const file of project.files) {
      if (file.language !== 'python') continue;
      file.language = 'c';
      file.path = file.path.replace(/\.py$/, '.c');
    }
    const result = generate(project, { nodes, backends });
    assert.ok(result.diagnostics.errors.length > 0, 'C has no classes; this must not silently emit');
    assert.match(result.diagnostics.format(), /classes/i);
  });

  it('covers every language with at least one template', () => {
    const covered = new Set(templates.all().map((t) => t.language));
    for (const id of ['python', 'javascript', 'java', 'csharp', 'go', 'rust', 'cpp', 'c', 'html']) {
      assert.ok(covered.has(id), `no template for ${id}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('generated output', () => {
  it('is byte-for-byte reproducible', () => {
    const project = build('python/cli');
    const first = generate(project, { nodes, backends });
    const second = generate(project, { nodes, backends });
    assert.equal(first.files.length, second.files.length);
    for (let i = 0; i < first.files.length; i++) {
      assert.equal(first.files[i].path, second.files[i].path);
      assert.equal(first.files[i].content, second.files[i].content, `${first.files[i].path} is not deterministic`);
    }
  });

  it('emits a real import when one file calls another', () => {
    const project = build('python/cli');
    const result = generate(project, { nodes, backends });
    const main = result.files.find((f) => f.path === 'src/main.py');
    assert.ok(main);
    assert.match(main.content, /from greeting import build_greeting/);
    // And the file graph records the edge, not just the text.
    const graph = new FileGraph(project);
    const mainFile = must(project.files.find((f) => f.path === 'src/main.py'), 'src/main.py');
    assert.ok(graph.dependencies(mainFile.id).some((f) => f.path === 'src/greeting.py'));
  });

  it('records the packages a graph asked for without installing them', () => {
    const project = build('python/api');
    const result = generate(project, { nodes, backends });
    const requirements = result.files.find((f) => f.path === 'requirements.txt');
    assert.ok(requirements);
    assert.match(requirements.content, /flask/);
    assert.match(requirements.content, /never installs them for you/);
    assert.equal(project.dependencies.every((d) => !d.installed), true);
  });

  it('produces a page, a stylesheet and a script for a web project', () => {
    const project = build('web/dashboard');
    const result = generate(project, { nodes, backends });
    const page = result.files.find((f) => f.path === 'index.html');
    const styles = result.files.find((f) => f.path === 'styles.css');
    const script = result.files.find((f) => f.path === 'src/app.js');
    assert.ok(page && styles && script);
    assert.match(page.content, /<!doctype html>/);
    assert.match(page.content, /styles\.css/);
    assert.match(page.content, /data-mcode-events="click:onIncrement"/);
    assert.match(styles.content, /@media \(max-width: 640px\)/);
    assert.match(script.content, /addEventListener/);
  });

  it('refuses a DOM node in a Python file instead of emitting nonsense', () => {
    const project = newProject({ name: 'Bad', language: 'python' });
    const { file, graph } = addFile(project, {
      path: 'src/main.py',
      language: 'python',
      role: 'entry',
      graph: { name: 'main', style: 'procedural' },
    });
    const builder = new GraphBuilder(project, nodes, graph!);
    const entry = builder.add('entry/main');
    const query = builder.add('dom/query');
    builder.chain(entry, query);
    void file;

    const result = generate(project, { nodes, backends });
    const errors = result.diagnostics.errors;
    assert.ok(errors.length > 0, 'expected the generator to refuse');
    assert.ok(
      errors.some((d) => /only available for javascript/i.test(d.message)),
      result.diagnostics.format(),
    );
  });
});

// ---------------------------------------------------------------------------

describe('preserved regions', () => {
  it('finds the regions in a generated file', () => {
    const source = [
      '# header',
      '# <mcode:region id="user-imports">',
      'import math',
      '# </mcode:region>',
      'def main(): pass',
    ].join('\n');
    const parsed = parseRegions(source);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.regions.get('user-imports')?.content, 'import math');
  });

  it('carries user code across a regeneration', () => {
    const previous = '# old\n# <mcode:region id="user-code">\nMY_CONSTANT = 42\n# </mcode:region>\n';
    const next = '# new\n# <mcode:region id="user-code">\n# </mcode:region>\n';
    const merged = mergeRegions(next, previous);
    assert.match(merged.content, /MY_CONSTANT = 42/);
    assert.match(merged.content, /# new/);
    assert.deepEqual(merged.preserved, ['user-code']);
  });

  it('keeps orphaned content instead of dropping it', () => {
    const previous = '# <mcode:region id="gone">\nimportant()\n# </mcode:region>\n';
    const next = '# nothing here\n';
    const merged = mergeRegions(next, previous);
    assert.equal(merged.orphaned.length, 1);
    assert.match(merged.orphaned[0].content, /important\(\)/);
  });

  it('refuses to merge a file with broken markers', () => {
    const previous = '# <mcode:region id="unterminated">\nstuff\n';
    const merged = mergeRegions('# fresh\n', previous);
    assert.ok(merged.errors.length > 0);
    assert.equal(merged.preserved.length, 0);
  });

  it('survives a real generate cycle on disk', () => {
    const dir = tempDir();
    try {
      const project = build('python/cli');
      const first = generate(project, { nodes, backends });
      writeArtifacts(dir, first.files);

      const mainPath = join(dir, 'src/main.py');
      const edited = readFileSync(mainPath, 'utf8').replace(
        '# <mcode:region id="user-code">',
        '# <mcode:region id="user-code">\nHAND_WRITTEN = "kept"',
      );
      writeFileSync(mainPath, edited);

      const second = generate(project, {
        nodes,
        backends,
        readExisting: (path) => {
          try {
            return readFileSync(join(dir, path), 'utf8');
          } catch {
            return undefined;
          }
        },
      });
      const regenerated = must(second.files.find((f) => f.path === 'src/main.py'), 'src/main.py');
      assert.match(regenerated.content, /HAND_WRITTEN = "kept"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe('stale output', () => {
  it('removes a file an earlier generation wrote and this one does not', () => {
    const dir = tempDir();
    try {
      writeArtifacts(dir, [
        { path: 'src/keep.py', content: 'a = 1\n' },
        { path: 'src/pkg/old.py', content: 'b = 2\n' },
      ]);
      const second = writeArtifacts(dir, [{ path: 'src/keep.py', content: 'a = 1\n' }]);
      assert.deepEqual(second.removed, ['src/pkg/old.py']);
      assert.equal(existsSync(join(dir, 'src/pkg/old.py')), false);
      assert.equal(existsSync(join(dir, 'src/pkg')), false, 'the directory it left empty goes too');
      assert.equal(existsSync(join(dir, 'src/keep.py')), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never deletes a file it did not generate, nor one holding hand-written regions', () => {
    const dir = tempDir();
    try {
      writeArtifacts(dir, [{ path: 'hybrid.py', content: '# <mcode:region id="user-code">\n# </mcode:region>\n' }]);
      writeFileSync(join(dir, 'mine.py'), 'print("hand written")\n');
      writeFileSync(join(dir, 'hybrid.py'), '# <mcode:region id="user-code">\nprint("mine")\n# </mcode:region>\n');
      const second = writeArtifacts(dir, []);
      assert.deepEqual(second.removed, []);
      assert.equal(existsSync(join(dir, 'mine.py')), true);
      assert.equal(existsSync(join(dir, 'hybrid.py')), true);
      assert.ok(second.diagnostics.items.some((d) => d.code === 'codegen/stale-file-kept'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('file graph', () => {
  it('detects an import cycle', () => {
    const project = newProject({ name: 'Cycle', language: 'python' });
    const a = addFile(project, { path: 'src/a.py', language: 'python' });
    const b = addFile(project, { path: 'src/b.py', language: 'python' });
    a.file.imports.push({ to: b.file.id, scope: 'file' });
    b.file.imports.push({ to: a.file.id, scope: 'file' });

    const diagnostics = validateFileGraph(project, backends);
    assert.ok(diagnostics.errors.some((d) => d.code === 'filegraph/import-cycle'), diagnostics.format());
  });

  it('rejects a cross-language import', () => {
    const project = newProject({ name: 'Mixed', language: 'python' });
    const py = addFile(project, { path: 'src/a.py', language: 'python' });
    const js = addFile(project, { path: 'src/b.js', language: 'javascript' });
    py.file.imports.push({ to: js.file.id, scope: 'file' });

    const diagnostics = validateFileGraph(project, backends);
    assert.ok(diagnostics.errors.some((d) => d.code === 'filegraph/cross-language-import'));
  });

  it('lets HTML reference CSS and JavaScript', () => {
    const project = newProject({ name: 'Web', language: 'html' });
    const css = addFile(project, { path: 'styles.css', language: 'css' });
    const page = addFile(project, { path: 'index.html', language: 'html' });
    page.file.imports.push({ to: css.file.id, scope: 'file' });
    assert.equal(validateFileGraph(project, backends).errors.length, 0);
  });

  it('renames a file without touching generated importers', () => {
    const project = build('python/cli');
    const greeting = must(project.files.find((f) => f.path === 'src/greeting.py'), 'src/greeting.py');
    const result = renameFile(project, greeting.id, 'src/messages.py', backends);
    assert.equal(result.diagnostics.errors.length, 0, result.diagnostics.format());
    assert.equal(must(project.files.find((f) => f.id === greeting.id), 'the renamed file').path, 'src/messages.py');

    // Regenerating produces the new import with no text rewriting anywhere.
    const regenerated = generate(project, { nodes, backends });
    const main = must(regenerated.files.find((f) => f.path === 'src/main.py'), 'src/main.py');
    assert.match(main.content, /from messages import build_greeting/);
    assert.doesNotMatch(main.content, /from greeting import/);
  });

  it('refuses to overwrite an existing path', () => {
    const project = build('python/cli');
    const greeting = must(project.files.find((f) => f.path === 'src/greeting.py'), 'src/greeting.py');
    const result = renameFile(project, greeting.id, 'src/main.py', backends);
    assert.ok(result.diagnostics.errors.some((d) => d.code === 'filegraph/path-taken'));
    assert.equal(must(project.files.find((f) => f.id === greeting.id), 'the unrenamed file').path, 'src/greeting.py');
  });
});

// ---------------------------------------------------------------------------

describe('project format', () => {
  it('round-trips through disk unchanged', () => {
    const dir = tempDir();
    try {
      const original = build('python/api');
      saveProject(original, dir);
      const { project: reloaded, diagnostics } = loadProject(dir);
      assert.equal(diagnostics.errors.length, 0, diagnostics.format());

      assert.equal(reloaded.name, original.name);
      assert.equal(reloaded.files.length, original.files.length);
      assert.equal(reloaded.graphs.length, original.graphs.length);
      assert.equal(reloaded.modules.length, original.modules.length);

      // The important property: the same project generates the same code.
      const before = generate(original, { nodes, backends });
      const after = generate(reloaded, { nodes, backends });
      assert.equal(before.files.length, after.files.length);
      for (let i = 0; i < before.files.length; i++) {
        assert.equal(after.files[i].content, before.files[i].content, before.files[i].path);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the port flags validation depends on', () => {
    const dir = tempDir();
    try {
      // A lambda's parameter output is body-scoped. If that flag is lost on
      // save, a reloaded project reports its own loop bodies as data cycles.
      const original = build('python/pipeline');
      const lambdaBefore = must(must(original.graphs[0], 'the first graph').nodes.find((n) => n.type === 'fn/lambda'), 'a lambda node');
      assert.ok(lambdaBefore.outputs.some((p) => p.bound), 'lambda params should be body-scoped');

      saveProject(original, dir);
      const { project: reloaded } = loadProject(dir);
      const lambdaAfter = must(must(reloaded.graphs[0], 'the first graph').nodes.find((n) => n.type === 'fn/lambda'), 'a lambda node');
      assert.ok(lambdaAfter.outputs.some((p) => p.bound), 'the bound flag was dropped by the round trip');

      const result = generate(reloaded, { nodes, backends });
      assert.equal(result.diagnostics.errors.length, 0, result.diagnostics.format());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes stable, diffable json', () => {
    const dir = tempDir();
    try {
      const project = build('python/cli');
      saveProject(project, dir);
      const first = readFileSync(join(dir, 'files.json'), 'utf8');
      saveProject(project, dir);
      assert.equal(readFileSync(join(dir, 'files.json'), 'utf8'), first);
      assert.ok(first.endsWith('\n'), 'files should end with a newline');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write outside the project root', () => {
    const dir = tempDir();
    try {
      const result = writeArtifacts(dir, [{ path: '../escaped.txt', content: 'no' }]);
      assert.ok(result.diagnostics.errors.some((d) => d.code === 'codegen/path-escape'));
      assert.equal(result.written.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe('importing an existing codebase', () => {
  it('indexes files, symbols and imports without claiming to rebuild graphs', async () => {
    const { importProject } = await import('#core/import/scan.ts');
    const dir = tempDir();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/util.py'), 'def helper(x):\n    return x * 2\n\nclass Thing:\n    pass\n');
      writeFileSync(join(dir, 'src/app.py'), 'from util import helper\n\ndef main():\n    print(helper(2))\n');

      const outcome = importProject({ root: dir, name: 'Legacy', backends });
      assert.equal(outcome.stats.filesImported, 2);
      const util = outcome.project.files.find((f) => f.path === 'src/util.py');
      const app = outcome.project.files.find((f) => f.path === 'src/app.py');
      assert.ok(util && app);
      // Existing code is never regenerated.
      assert.equal(util.kind, 'user');
      assert.deepEqual(util.exports.map((e) => e.name).sort(), ['Thing', 'helper']);
      assert.ok(app.imports.some((i) => i.to === util.id), 'the import edge should resolve');
      assert.equal(app.role, 'entry');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
