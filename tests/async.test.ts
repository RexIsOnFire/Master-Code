/**
 * Waiting for calls that do not return immediately.
 *
 * The regression this guards against produced a program that ran, exited zero,
 * and printed nothing useful: JavaScript's HTTP helper is a promise, nothing
 * awaited it, and `response.status` read a field off the promise and got
 * `undefined`. Asserting on the generated text alone would not have caught it -
 * the text looked fine - so every case here starts a real server, runs the
 * generated program against it, and reads what it printed.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
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
import { probeTool } from '#core/runtime/exec.ts';
import type { GraphNode, Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();

/** A server that answers every request with a fixed JSON body. */
async function withServer<T>(body: string, run: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    return await run(`http://127.0.0.1:${port}/alerts`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function projectFor(language: string): { project: Project; build: ReturnType<typeof builderFor> } {
  const project = newProject({ name: 'AsyncProbe', language });
  const path = language === 'python' ? 'src/main.py' : 'src/main.js';
  const { graph } = addFile(project, { path, language, role: 'source', graph: { name: 'main' } });
  grant(project, 'net');
  grant(project, 'time');
  return { project, build: builderFor(project, nodes, must(graph, 'a graph')) };
}

/** Generates, writes and runs a project, returning its stdout. */
async function run(project: Project, command: string, args: string[]): Promise<string> {
  const result = generate(project, { nodes, backends });
  assert.deepEqual(
    result.diagnostics.errors.map((d) => d.message),
    [],
  );
  const dir = mkdtempSync(join(tmpdir(), 'mcode-async-'));
  try {
    writeArtifacts(dir, result.files);
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

/** Fetches `url` and prints the status and one field of the JSON body. */
function drawFetch(language: string, url: string): Project {
  const { project, build: b } = projectFor(language);
  const entry = b.add('entry/main');
  const req = b.addWith('net/http-request', { url });

  const status = b.add('io/print');
  b.setDefault(status, 'v', 'status:');
  b.connect(req, 'status', status, 'v#1');

  const parsed = b.add('json/parse');
  b.connect(req, 'text', parsed, 'a0');
  const field = b.addWith('json/get', { a1: 'severity' });
  b.connect(parsed, 'value', field, 'a0');
  const asText = b.add('json/as-string');
  b.connect(field, 'value', asText, 'a0');

  const severity = b.add('io/print');
  b.setDefault(severity, 'v', 'severity:');
  b.connect(asText, 'text', severity, 'v#1');

  b.chain(entry, req, status, severity);
  return project;
}

describe('calls that have to be waited for', () => {
  it('reads the real status and body of an HTTP response in JavaScript', async () => {
    const output = await withServer('{"severity":"high"}', (url) =>
      run(drawFetch('javascript', url), 'node', ['src/main.js']),
    );
    assert.equal(output, 'status: 200\nseverity: high');
  });

  it('reads the same values in Python, which needs no annotations', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');
    const output = await withServer('{"severity":"high"}', (url) =>
      run(drawFetch('python', url), 'python', ['src/main.py']),
    );
    assert.equal(output, 'status: 200\nseverity: high');
  });

  it('carries the marking through a function the entry point calls', async () => {
    // The call graph is what makes this hard: `main` has no suspending call of
    // its own, only a call to a helper that does.
    const { project, build: b } = projectFor('javascript');
    const helper = addFile(project, {
      path: 'src/wait.js',
      language: 'javascript',
      role: 'source',
      graph: { name: 'pause' },
    });
    const hb = builderFor(project, nodes, must(helper.graph, 'the helper graph'));
    const fn = hb.add('entry/function', { name: 'pause', visibility: 'public' });
    const sleep = hb.addWith('time/sleep', { a0: 5 });
    const done = hb.add('io/print');
    hb.setDefault(done, 'v', 'slept');
    hb.chain(fn, sleep, done);

    const entry = b.add('entry/main');
    const call = b.add('control/call', { target: 'pause' });
    const after = b.add('io/print');
    b.setDefault(after, 'v', 'after');
    b.chain(entry, call, after);

    const output = await run(project, 'node', ['src/main.js']);
    // Without the marking the two lines arrive in the other order, because the
    // sleep is still pending when `after` prints.
    assert.equal(output, 'slept\nafter');
  });

  it('refuses a suspending step inside a Map, instead of miscompiling it', () => {
    const { project, build: b } = projectFor('javascript');
    const entry = b.add('entry/main');
    const list = b.add('list/new');

    // A Map whose transform performs a request: in JavaScript that produces a
    // list of promises, and awaiting the Map does not repair it.
    const lambda = b.add('fn/lambda', { mode: 'statements' });
    const req = b.addWith('net/http-request', { url: 'https://example.com' });
    b.connect(lambda, 'body', req, 'in');

    const mapped = b.add('fn/map');
    b.connect(list, 'list', mapped, 'a0');
    b.connect(lambda, 'fn', mapped, 'a1');

    const print = b.add('io/print');
    b.setDefault(print, 'v', 'mapped:');
    b.connect(mapped, 'result', print, 'v#1');
    b.chain(entry, print);

    const result = generate(project, { nodes, backends });
    const messages = result.diagnostics.errors.map((d) => d.code);
    assert.ok(
      messages.includes('ir/suspending-callback'),
      `expected a suspending-callback error, got ${JSON.stringify(messages)}`,
    );
  });
});
