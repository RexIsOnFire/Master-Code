/**
 * Doing several things at once, and not more than asked.
 *
 * Concurrency cannot be checked by reading generated text, and it cannot be
 * checked by asserting that the results are right either - a sequential loop
 * produces exactly the same results, just slower. So these tests measure two
 * things the sequential version could not produce: the wall clock, and the
 * high-water mark of requests the server saw at the same time.
 *
 * The server counts overlapping requests itself, which is what makes the limit
 * assertion honest rather than a guess from timings.
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
import type { Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();

const DELAY_MS = 200;

interface Watched {
  url: string;
  /** Most requests that were ever in flight together. */
  peak: () => number;
}

/** A server that holds every request open, and records the overlap. */
async function withSlowServer<T>(run: (w: Watched) => Promise<T>): Promise<T> {
  let inFlight = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"verdict":"clean"}');
    }, DELAY_MS);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    return await run({ url: `http://127.0.0.1:${port}/lookup`, peak: () => peak });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function run(project: Project, command: string, args: string[]): Promise<string> {
  const result = generate(project, { nodes, backends });
  assert.deepEqual(
    result.diagnostics.errors.map((d) => d.message),
    [],
  );
  const dir = mkdtempSync(join(tmpdir(), 'mcode-par-'));
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

function base(language: string) {
  const project = newProject({ name: 'Fanout', language, namespace: 'example.com/fanout' });
  const path =
    language === 'python' ? 'src/main.py' : language === 'go' ? 'main.go' : 'src/main.js';
  const { graph } = addFile(project, { path, language, role: 'source', graph: { name: 'main' } });
  grant(project, 'net');
  grant(project, 'time');
  return { project, b: builderFor(project, nodes, must(graph, 'a graph')) };
}

/**
 * Looks up eight indicators through Map In Parallel, `atOnce` at a time, and
 * prints how many answers came back.
 */
function drawFanout(language: string, url: string, atOnce: number): Project {
  const { project, b } = base(language);
  const entry = b.add('entry/main');

  const indicators = b.addWith('list/range', { a0: 0, a1: 8 });

  // The transform returns the response body: a statically typed target needs
  // every path of the callback to produce the value its signature promises.
  const lookup = b.add('fn/lambda', {
    mode: 'statements',
    params: [{ name: 'item', type: 'i64' }],
    returns: 'string',
  });
  const req = b.addWith('net/http-request', { url });
  const give = b.add('control/return');
  b.connect(req, 'text', give, 'value');
  b.connect(lookup, 'body', req, 'in');
  b.chain(req, give);

  const mapped = b.addWith('fn/parallel-map', { a2: atOnce });
  b.connect(indicators, 'list', mapped, 'a0');
  b.connect(lookup, 'fn', mapped, 'a1');

  const count = b.add('list/length');
  b.connect(mapped, 'result', count, 'a0');

  const print = b.add('io/print');
  b.setDefault(print, 'v', 'answers:');
  b.connect(count, 'length', print, 'v#1');

  b.chain(entry, print);
  return project;
}

/** Four different calls at once through the Parallel node. */
function drawBranches(language: string, url: string): Project {
  const { project, b } = base(language);
  const entry = b.add('entry/main');
  const fork = b.add('control/parallel', { branches: 4, atOnce: 4 });

  for (let i = 0; i < 4; i += 1) {
    const req = b.addWith('net/http-request', { url });
    b.connect(fork, `b${i}`, req, 'in');
  }

  const done = b.add('io/print');
  b.setDefault(done, 'v', 'joined');
  b.connect(fork, 'out', done, 'in');
  b.chain(entry, fork);
  return project;
}

describe('running several things at once', () => {
  it('overlaps requests, and honours the limit, in JavaScript', async () => {
    await withSlowServer(async (w) => {
      const started = Date.now();
      const output = await run(drawFanout('javascript', w.url, 4), 'node', ['src/main.js']);
      const elapsed = Date.now() - started;

      assert.equal(output, 'answers: 8');
      // Eight requests, four at a time: two waves, not eight.
      assert.ok(w.peak() > 1, `requests never overlapped (peak ${w.peak()})`);
      assert.ok(w.peak() <= 4, `more than four were in flight at once (peak ${w.peak()})`);
      assert.ok(
        elapsed < 8 * DELAY_MS,
        `took ${elapsed}ms, which is no better than doing them one at a time`,
      );
    });
  });

  it('overlaps requests, and honours the limit, in Python', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');
    await withSlowServer(async (w) => {
      const output = await run(drawFanout('python', w.url, 4), 'python', ['src/main.py']);
      assert.equal(output, 'answers: 8');
      assert.ok(w.peak() > 1, `requests never overlapped (peak ${w.peak()})`);
      assert.ok(w.peak() <= 4, `more than four were in flight at once (peak ${w.peak()})`);
    });
  });

  it('overlaps requests, and honours the limit, in Go', async (t) => {
    const go = await probeTool('go', ['version']);
    if (!go.available) return t.skip('go is not installed');
    await withSlowServer(async (w) => {
      const output = await run(drawFanout('go', w.url, 4), 'go', ['run', '.']);
      assert.equal(output, 'answers: 8');
      assert.ok(w.peak() > 1, `requests never overlapped (peak ${w.peak()})`);
      assert.ok(w.peak() <= 4, `more than four were in flight at once (peak ${w.peak()})`);
    });
  });

  it('does one at a time when asked for one at a time', async () => {
    await withSlowServer(async (w) => {
      const output = await run(drawFanout('javascript', w.url, 1), 'node', ['src/main.js']);
      assert.equal(output, 'answers: 8');
      assert.equal(w.peak(), 1, 'a limit of one should mean no overlap at all');
    });
  });

  it('runs separate branches at the same time and waits for all of them', async () => {
    await withSlowServer(async (w) => {
      const output = await run(drawBranches('javascript', w.url), 'node', ['src/main.js']);
      assert.equal(output, 'joined');
      assert.equal(w.peak(), 4, `four branches should have overlapped (peak ${w.peak()})`);
    });
  });
});
