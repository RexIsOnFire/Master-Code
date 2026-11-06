/**
 * Cross-language conformance for the collection operations.
 *
 * `list_map`, `filter`, `reduce`, `sort`, `any`, `all`, `min`, `max`, `unique`
 * and friends are what the functional, dataflow and pipeline paradigms lower
 * to. Each backend spells them differently — iterator adaptors in Rust, generic
 * runtime helpers in Go, `<algorithm>` templates in C++ — so "it generates" is
 * not evidence of anything. The only real check is to run the same graph in
 * several languages and compare what it prints.
 *
 * Python is the reference. A language whose toolchain is not installed skips
 * rather than fails, so this stays useful on a machine with only some of them.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAndRun, must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { generate } from '#core/codegen/generate.ts';
import { writeArtifacts } from '#core/project/io.ts';
import { GraphBuilder, addFile, newProject } from '#core/project/builder.ts';
import { probeTool, runCommand } from '#core/runtime/exec.ts';
import type { GraphNode, Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();

/**
 * One graph exercising every collection operation, printing a labelled line per
 * result so the outputs of two languages can be compared as text.
 */
function buildProject(language: string, extension: string): Project {
  const project = newProject({ name: 'collcheck', language });
  const { graph } = addFile(project, {
    path: `src/main${extension}`,
    language,
    role: 'entry',
    graph: { name: 'main', style: 'pipeline' },
  });
  const b = new GraphBuilder(project, nodes, must(graph, 'the graph'));
  const main = b.add('entry/main');

  const source = b.addWith('list/range', { a0: 1, a1: 8 });

  const double = b.add('fn/lambda', { params: [{ name: 'n', type: 'i64' }], returns: 'i64' });
  const doubled = b.addWith('op/arithmetic', { b: 2 }, { op: '*' });
  b.connect(double, 'p:n', doubled, 'a');
  b.connect(doubled, 'result', double, 'result');

  const isOdd = b.add('fn/lambda', { params: [{ name: 'n', type: 'i64' }], returns: 'bool' });
  const remainder = b.addWith('op/arithmetic', { b: 2 }, { op: '%' });
  const equalsOne = b.addWith('op/compare', { b: 1 }, { op: '==' });
  b.connect(isOdd, 'p:n', remainder, 'a');
  b.connect(remainder, 'result', equalsOne, 'a');
  b.connect(equalsOne, 'result', isOdd, 'result');

  const steps: GraphNode[] = [];
  const say = (label: string, node: GraphNode, port: string) => {
    const print = b.add('io/print');
    const text = b.addWith('string/format', { a0: `${label}: {}` });
    b.connect(node, port, text, 'v');
    b.connect(text, 'text', print, 'v');
    steps.push(print);
  };

  const mapped = b.add('fn/map');
  b.connect(source, 'list', mapped, 'a0');
  b.connect(double, 'fn', mapped, 'a1');
  say('map', mapped, 'result');

  const filtered = b.add('fn/filter');
  b.connect(source, 'list', filtered, 'a0');
  b.connect(isOdd, 'fn', filtered, 'a1');
  say('filter', filtered, 'result');

  for (const [label, type, port] of [
    ['sort', 'list/sort', 'list'],
    ['unique', 'list/unique', 'list'],
    ['reverse', 'list/reverse', 'list'],
    ['sum', 'list/sum', 'total'],
  ] as const) {
    const node = b.add(type);
    b.connect(source, 'list', node, 'a0');
    say(label, node, port);
  }

  for (const [label, type] of [
    ['any', 'fn/any'],
    ['all', 'fn/all'],
  ] as const) {
    const node = b.add(type);
    b.connect(source, 'list', node, 'a0');
    b.connect(isOdd, 'fn', node, 'a1');
    say(label, node, 'matched');
  }

  b.chain(main, ...steps);
  project.grants.stdio = true;
  return project;
}

/**
 * A second graph for the filesystem and random operations.
 *
 * Those are the parts of a `full` backend a user hits as soon as they do
 * anything real, and they are easy to get subtly wrong per language — append
 * versus truncate, a missing file being an error or not, whether a range is
 * inclusive. Random is pinned to a one-value range so the output stays
 * comparable while still going through the generator.
 */
function buildRuntimeProject(language: string, extension: string): Project {
  const project = newProject({ name: 'rtcheck', language });
  const { graph } = addFile(project, {
    path: `src/main${extension}`,
    language,
    role: 'entry',
    graph: { name: 'main', style: 'procedural' },
  });
  const b = new GraphBuilder(project, nodes, must(graph, 'the graph'));
  const main = b.add('entry/main');

  const joined = b.addWith('file/path-join', { a0: '.', a1: 'rt-probe.txt' });

  const write = b.add('file/write');
  b.connect(joined, 'path', write, 'a0');
  b.setDefault(write, 'a1', 'one\n');

  const append = b.add('file/append');
  b.connect(joined, 'path', append, 'a0');
  b.setDefault(append, 'a1', 'two\n');

  const read = b.add('file/read');
  b.connect(joined, 'path', read, 'a0');
  const readOut = b.addWith('string/format', { a0: 'read: {}' });
  b.connect(read, 'text', readOut, 'v');
  const printRead = b.add('io/print');
  b.connect(readOut, 'text', printRead, 'v');

  const exists = b.add('file/exists');
  b.connect(joined, 'path', exists, 'a0');
  const existsOut = b.addWith('string/format', { a0: 'exists: {}' });
  b.connect(exists, 'exists', existsOut, 'v');
  const printExists = b.add('io/print');
  b.connect(existsOut, 'text', printExists, 'v');

  const remove = b.add('file/delete');
  b.connect(joined, 'path', remove, 'a0');

  const gone = b.add('file/exists');
  b.connect(joined, 'path', gone, 'a0');
  const goneOut = b.addWith('string/format', { a0: 'after delete: {}' });
  b.connect(gone, 'exists', goneOut, 'v');
  const printGone = b.add('io/print');
  b.connect(goneOut, 'text', printGone, 'v');

  // A range of exactly one value: still generated and executed, but the result
  // is fixed, so languages can be compared.
  const roll = b.addWith('math/random-int', { a0: 7, a1: 8 });
  const rollOut = b.addWith('string/format', { a0: 'roll: {}' });
  b.connect(roll, 'value', rollOut, 'v');
  const printRoll = b.add('io/print');
  b.connect(rollOut, 'text', printRoll, 'v');

  b.chain(main, write, append, printRead, printExists, remove, printGone, printRoll);
  project.grants.stdio = true;
  project.grants['fs.read'] = true;
  project.grants['fs.write'] = true;
  project.grants.random = true;
  return project;
}

interface Target {
  extension: string;
  tool: string;
  /** Run directly; absent means build and run through the backend's own plans. */
  command?: string;
  args?: string[];
}

const TARGETS: Record<string, Target> = {
  python: { extension: '.py', tool: 'python', command: 'python', args: ['src/main.py'] },
  javascript: { extension: '.js', tool: 'node', command: 'node', args: ['src/main.js'] },
  rust: { extension: '.rs', tool: 'cargo', command: 'cargo', args: ['run', '--quiet'] },
  go: { extension: '.go', tool: 'go', command: 'go', args: ['run', '.'] },
  kotlin: { extension: '.kt', tool: 'kotlinc' },
};

async function runIn(
  language: string,
  make: (language: string, extension: string) => Project = buildProject,
): Promise<string> {
  const target = must(TARGETS[language], language);
  if (!target.command) return buildAndRun(make(language, target.extension), language, { nodes, backends });
  const dir = mkdtempSync(join(tmpdir(), `coll-${language}-`));
  try {
    const project = make(language, target.extension);
    const generated = generate(project, { nodes, backends });
    assert.equal(
      generated.diagnostics.errors.length,
      0,
      `${language} failed to generate:\n${generated.diagnostics.format()}`,
    );
    writeArtifacts(dir, generated.files);

    const result = await runCommand({
      command: target.command,
      args: target.args ?? [],
      cwd: dir,
      // A cold cargo or go build on a clean cache is slow the first time.
      timeoutMs: 300_000,
    });
    assert.equal(result.code, 0, `${language} exited ${result.code}:\n${result.stderr || result.stdout}`);
    return result.stdout.trim().replace(/\r\n/g, '\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('filesystem and random operations across languages', () => {
  for (const language of ['javascript', 'rust', 'go', 'kotlin']) {
    it(`agrees with Python in ${language}`, async (t) => {
      const target = must(TARGETS[language], language);
      if (!(await probeTool('python', ['--version'])).available) return t.skip('python is not installed');
      if (!(await probeTool(target.tool, ['--version'])).available) {
        return t.skip(`${target.tool} is not installed`);
      }

      const reference = await runIn('python', buildRuntimeProject);
      const actual = await runIn(language, buildRuntimeProject);

      // Line endings and boolean spelling differ; the sequence of facts does
      // not. Append must extend rather than truncate, delete must actually
      // delete, and the pinned random range must land on its one value.
      const normalise = (text: string) =>
        text
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/\r/g, '')
          .trim();

      assert.equal(
        normalise(actual),
        normalise(reference),
        `${language}:\n${actual}\n\npython:\n${reference}`,
      );
      assert.match(normalise(actual), /read: one\ntwo/, 'append must extend the file, not replace it');
      assert.match(normalise(actual), /after delete: false/, 'delete must remove the file');
      assert.match(normalise(actual), /roll: 7/, 'a one-value range must produce that value');
    });
  }
});

describe('collection operations across languages', () => {
  it('produces the expected results in Python', async (t) => {
    if (!(await probeTool('python', ['--version'])).available) return t.skip('python is not installed');
    const output = await runIn('python');

    // Spelled out once, here, so the reference itself is checked rather than
    // just agreed with. Everything else is compared against Python's output.
    assert.match(output, /^map: \[2, 4, 6, 8, 10, 12, 14\]$/m);
    assert.match(output, /^filter: \[1, 3, 5, 7\]$/m);
    assert.match(output, /^sort: \[1, 2, 3, 4, 5, 6, 7\]$/m);
    assert.match(output, /^unique: \[1, 2, 3, 4, 5, 6, 7\]$/m);
    assert.match(output, /^reverse: \[7, 6, 5, 4, 3, 2, 1\]$/m);
    assert.match(output, /^sum: 28(\.0)?$/m);
    assert.match(output, /^any: (true|True)$/m);
    assert.match(output, /^all: (false|False)$/m);
  });

  for (const language of ['javascript', 'rust', 'go', 'kotlin']) {
    it(`agrees with Python in ${language}`, async (t) => {
      const target = must(TARGETS[language], language);
      if (!(await probeTool('python', ['--version'])).available) return t.skip('python is not installed');
      if (!(await probeTool(target.tool, ['--version'])).available) {
        return t.skip(`${target.tool} is not installed`);
      }

      const reference = await runIn('python');
      const actual = await runIn(language);

      // Each language renders the same value its own way, and every one of
      // these is idiomatic where it appears:
      //
      //   Python      [1, 2, 3]    True    28.0
      //   JavaScript  1,2,3        true    28
      //   Rust        [1, 2, 3]    true    28
      //   Go          [1 2 3]      true    28
      //
      // The platform's promise is that the same graph computes the same thing
      // everywhere, not that it prints byte-identical text — the generated code
      // is meant to read as native. So normalise the spelling and compare the
      // values, which is what has to agree.
      const normalise = (text: string) =>
        text
          .split('\n')
          .map((line) =>
            line
              .replace(/\bTrue\b/g, 'true')
              .replace(/\bFalse\b/g, 'false')
              .replace(/(\d)\.0\b/g, '$1')
              .replace(/[[\],]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim(),
          )
          .filter(Boolean);

      assert.deepEqual(
        normalise(actual),
        normalise(reference),
        `${language} disagrees with Python.\n\n${language}:\n${actual}\n\npython:\n${reference}`,
      );
    });
  }
});
