/**
 * SQLite, from a graph, in every language that claims to support it.
 *
 * One graph creates a table, inserts two parameterised rows, reads one back by
 * key and prints it. Asserting on generated text would prove nothing here - the
 * question is whether the driver is wired up, whether parameters bind in order,
 * and whether a value read back out compares equal to the value written in,
 * which is exactly where a driver handing back []byte instead of string bites.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { generate } from '#core/codegen/generate.ts';
import { writeArtifacts } from '#core/project/io.ts';
import { addFile, builderFor, grant, newProject } from '#core/project/builder.ts';
import { runInSandbox } from '#core/runtime/sandbox.ts';
import { probeTool, runCommand } from '#core/runtime/exec.ts';
import type { Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();

/**
 * Creates a table, inserts two rows, selects one back by key, prints its title.
 *
 * The select is parameterised and matches only the second row, so a backend
 * that ignored the parameters or bound them in the wrong order prints the
 * wrong title rather than passing.
 */
function drawStore(language: string): Project {
  const project = newProject({ name: 'Store', language, namespace: 'example.com/store' });
  const path =
    language === 'python' ? 'src/main.py' : language === 'go' ? 'main.go' : 'src/main.js';
  const { graph } = addFile(project, { path, language, role: 'source', graph: { name: 'main' } });
  grant(project, 'fs.read');
  grant(project, 'fs.write');
  const b = builderFor(project, nodes, must(graph, 'a graph'));

  const entry = b.add('entry/main');
  const open = b.addWith('db/open', { a0: 'probe.db' });
  const noParams = b.add('list/new');

  const create = b.addWith('db/execute', {
    a1: 'CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, title TEXT, severity INTEGER)',
  });
  b.connect(open, 'db', create, 'a0');
  b.connect(noParams, 'list', create, 'a2');

  const insert = (id: string, title: string, severity: number) => {
    const row = b.add('list/literal', { itemType: 'Any' });
    // setDefault only fills a slot that exists; addVariadic is what creates one.
    b.addVariadic(row, 'e');
    b.addVariadic(row, 'e');
    b.setDefault(row, 'e', id);
    b.setDefault(row, 'e#1', title);
    b.setDefault(row, 'e#2', severity);
    const exec = b.addWith('db/execute', {
      a1: 'INSERT OR REPLACE INTO cases(id,title,severity) VALUES(?,?,?)',
    });
    b.connect(open, 'db', exec, 'a0');
    b.connect(row, 'list', exec, 'a2');
    return exec;
  };
  const first = insert('c-1', 'first case', 10);
  const second = insert('c-2', 'second case', 90);

  const key = b.add('list/literal', { itemType: 'Any' });
  b.setDefault(key, 'e', 'c-2');
  const query = b.addWith('db/query', { a1: 'SELECT title FROM cases WHERE id = ?' });
  b.connect(open, 'db', query, 'a0');
  b.connect(key, 'list', query, 'a2');

  // Through Get At and Get, so an empty result or a missing column fails here
  // rather than printing something that merely looks plausible.
  const row = b.addWith('list/get', { a1: 0 });
  b.connect(query, 'rows', row, 'a0');
  const title = b.addWith('map/get', { a1: 'title' });
  b.connect(row, 'item', title, 'a0');
  const required = b.addWith('option/require', { a1: 'no title column' });
  b.connect(title, 'value', required, 'a0');
  const text = b.add('convert/to-string');
  b.connect(required, 'value', text, 'a0');

  const print = b.add('io/print');
  b.setDefault(print, 'v', 'title:');
  b.connect(text, 'text', print, 'v#1');

  const rowCount = b.add('list/length');
  b.connect(query, 'rows', rowCount, 'a0');
  const countLine = b.add('io/print');
  b.setDefault(countLine, 'v', 'rows:');
  b.connect(rowCount, 'length', countLine, 'v#1');

  const close = b.add('db/close');
  b.connect(open, 'db', close, 'a0');

  b.chain(entry, open, create, first, second, query, print, countLine, close);
  return project;
}

const EXPECTED = 'title: second case\nrows: 1';

/** Generates, writes and runs the probe, returning its trimmed stdout. */
async function run(language: string, command: string, args: string[]): Promise<string> {
  const project = drawStore(language);
  const result = generate(project, { nodes, backends });
  assert.deepEqual(
    result.diagnostics.errors.map((d) => d.message),
    [],
  );

  const dir = mkdtempSync(join(tmpdir(), 'mcode-db-'));
  try {
    writeArtifacts(dir, result.files);
    if (language === 'go') {
      // The driver is a real module, so the first build has to resolve it.
      const tidy = await runCommand({ command: 'go', args: ['mod', 'tidy'], cwd: dir, timeoutMs: 180000 });
      assert.equal(tidy.code, 0, `go mod tidy failed:\n${tidy.stderr}`);
    }
    const outcome = await runInSandbox({
      project,
      root: dir,
      command: { label: 'run', command, args },
    });
    assert.equal(outcome.code, 0, outcome.stderr);
    return outcome.stdout.replace(/\r\n/g, '\n').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('SQLite from a graph', () => {
  it('creates, inserts and selects in Python', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');
    assert.equal(await run('python', 'python', ['src/main.py']), EXPECTED);
  });

  it('creates, inserts and selects in Go', async (t) => {
    const go = await probeTool('go', ['version']);
    if (!go.available) return t.skip('go is not installed');
    assert.equal(await run('go', 'go', ['run', '.']), EXPECTED);
  });

  it('writes the driver into go.mod only when a database is used', () => {
    const withDb = generate(drawStore('go'), { nodes, backends });
    const goMod = must(
      withDb.files.find((f) => f.path === 'go.mod'),
      'a go.mod',
    );
    assert.match(goMod.content, /modernc\.org\/sqlite/);
    assert.ok(
      withDb.files.some((f) => f.path === 'mcruntime/db.go'),
      'the database runtime should be written',
    );

    const plain = newProject({ name: 'Plain', language: 'go', namespace: 'example.com/plain' });
    const { graph } = addFile(plain, {
      path: 'main.go',
      language: 'go',
      role: 'source',
      graph: { name: 'main' },
    });
    const pb = builderFor(plain, nodes, must(graph, 'a graph'));
    const entry = pb.add('entry/main');
    const say = pb.add('io/print');
    pb.setDefault(say, 'v', 'hello');
    pb.chain(entry, say);

    const withoutDb = generate(plain, { nodes, backends });
    const plainMod = must(
      withoutDb.files.find((f) => f.path === 'go.mod'),
      'a go.mod',
    );
    assert.doesNotMatch(plainMod.content, /modernc/);
    assert.ok(
      !withoutDb.files.some((f) => f.path === 'mcruntime/db.go'),
      'a project with no database should not carry the database runtime',
    );
  });
});
