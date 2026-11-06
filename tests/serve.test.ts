/**
 * Receiving HTTP: a graph that is the callee rather than the caller.
 *
 * These tests start the generated program as a real process, send it real
 * requests, and read the real answers. Nothing about a server can be verified
 * from the generated text - whether the body arrived, whether the query string
 * was parsed, whether the reply carried the status the graph asked for - so
 * none of it is asserted that way.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

import { must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { generate } from '#core/codegen/generate.ts';
import { writeArtifacts } from '#core/project/io.ts';
import { addFile, builderFor, grant, newProject } from '#core/project/builder.ts';
import { requiredCapabilities, checkCapabilities } from '#core/runtime/sandbox.ts';
import { probeTool, runCommand } from '#core/runtime/exec.ts';
import process from 'node:process';
import type { Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();

/** A port nothing is listening on, claimed and released just before use. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * A webhook that echoes what it was sent.
 *
 * It replies 202 for `/alerts` and 404 for anything else, so the assertions can
 * tell that the path reached the graph rather than the server answering alone.
 */
function drawWebhook(language: string, port: number): Project {
  const project = newProject({ name: 'Hook', language, namespace: 'example.com/hook' });
  const path =
    language === 'python' ? 'src/main.py' : language === 'go' ? 'main.go' : 'src/main.js';
  const { graph } = addFile(project, { path, language, role: 'source', graph: { name: 'hook' } });
  grant(project, 'net.listen');
  const b = builderFor(project, nodes, must(graph, 'a graph'));

  const listen = b.add('net/on-request', { host: '127.0.0.1', port });

  const isAlerts = b.addWith('string/ends-with', { a1: '/alerts' });
  b.connect(listen, 'path', isAlerts, 'a0');

  const branch = b.add('control/if');
  b.connect(isAlerts, 'found', branch, 'cond');

  // The 202 body is assembled from the request, so a wrong field shows up as a
  // wrong body rather than passing silently.
  const summary = b.addWith('string/format', { a0: '{} {} source={}' });
  b.connect(listen, 'method', summary, 'v#1');
  b.connect(listen, 'body', summary, 'v#2');
  const source = b.addWith('map/get-or', { a1: 'source', a2: 'none' });
  b.connect(listen, 'query', source, 'a0');
  b.connect(source, 'value', summary, 'v#3');

  const accepted = b.addWith('net/reply', { status: 202, contentType: 'text/plain' });
  b.connect(summary, 'text', accepted, 'body');

  const missing = b.addWith('net/reply', { status: 404, body: 'no such hook', contentType: 'text/plain' });

  b.connect(listen, 'out', branch, 'in');
  b.connect(branch, 'then', accepted, 'in');
  b.connect(branch, 'else', missing, 'in');
  return project;
}

/**
 * Writes the project, starts it, and calls `use` once it is listening.
 *
 * Compiled targets are built first and the binary is run directly. `go run`
 * would work too, but it starts the program as a grandchild, so killing it at
 * the end leaves the server holding the port and the pipes - the test would
 * pass and then hang forever waiting for stdio that nothing will close.
 */
async function withGenerated(
  project: Project,
  command: string,
  args: string[],
  port: number,
  use: (base: string) => Promise<void>,
): Promise<void> {
  const result = generate(project, { nodes, backends });
  assert.deepEqual(
    result.diagnostics.errors.map((d) => d.message),
    [],
  );
  const dir = mkdtempSync(join(tmpdir(), 'mcode-serve-'));
  writeArtifacts(dir, result.files);

  let run = { command, args };
  if (command === 'go') {
    const binary = process.platform === 'win32' ? 'server.exe' : 'server';
    const built = await runCommand({ command: 'go', args: ['build', '-o', binary, '.'], cwd: dir });
    assert.equal(built.code, 0, built.stderr);
    run = { command: join(dir, binary), args: [] };
  }

  const child = spawn(run.command, run.args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForListening(base, child, () => stderr);
    await use(base);
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Polls until the port answers, or the child dies, or five seconds pass. */
async function waitForListening(
  base: string,
  child: ReturnType<typeof spawn>,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${stderr()}`);
    try {
      await fetch(`${base}/__ping`, { method: 'GET' });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`server never listened:\n${stderr()}`);
}

async function exercise(base: string): Promise<void> {
  const accepted = await fetch(`${base}/alerts?source=crowdstrike`, {
    method: 'POST',
    body: '{"id":7}',
  });
  assert.equal(accepted.status, 202);
  assert.equal(await accepted.text(), 'POST {"id":7} source=crowdstrike');

  const rejected = await fetch(`${base}/nope`, { method: 'GET' });
  assert.equal(rejected.status, 404);
  assert.equal(await rejected.text(), 'no such hook');
}

describe('receiving HTTP', () => {
  it('answers real requests from a JavaScript graph', async () => {
    const port = await freePort();
    await withGenerated(drawWebhook('javascript', port), 'node', ['src/main.js'], port, exercise);
  });

  it('answers the same requests identically from a Python graph', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');
    const port = await freePort();
    await withGenerated(drawWebhook('python', port), 'python', ['src/main.py'], port, exercise);
  });

  it('answers the same requests identically from a Go graph', async (t) => {
    const go = await probeTool('go', ['version']);
    if (!go.available) return t.skip('go is not installed');
    const port = await freePort();
    await withGenerated(drawWebhook('go', port), 'go', ['run', '.'], port, exercise);
  });

  it('refuses to run a listener the project has not granted', () => {
    const project = drawWebhook('javascript', 8099);
    project.grants['net.listen'] = false;

    const result = generate(project, { nodes, backends });
    const program = result.programs[0];
    const needed = requiredCapabilities(program).map((r) => r.capability);
    assert.ok(needed.includes('net.listen'), 'the listener should require net.listen');

    const verdict = checkCapabilities(project, program);
    assert.equal(verdict.ok, false, 'an ungranted listener should be refused before it is run');
    assert.deepEqual(
      verdict.missing.map((r) => r.capability),
      ['net.listen'],
    );
  });

  it('keeps listening separate from calling out', () => {
    // A graph that only calls out must not silently acquire the right to open
    // a port, which is why these are two capabilities and not one.
    const project = newProject({ name: 'CallsOut', language: 'javascript' });
    const { graph } = addFile(project, {
      path: 'src/main.js',
      language: 'javascript',
      role: 'source',
      graph: { name: 'main' },
    });
    const b = builderFor(project, nodes, must(graph, 'a graph'));
    const entry = b.add('entry/main');
    const req = b.addWith('net/http-request', { url: 'https://example.com' });
    b.chain(entry, req);

    const needed = requiredCapabilities(generate(project, { nodes, backends }).programs[0]).map(
      (r) => r.capability,
    );
    assert.ok(needed.includes('net'), 'calling out needs net');
    assert.ok(!needed.includes('net.listen'), 'calling out must not imply listening');
  });
});
