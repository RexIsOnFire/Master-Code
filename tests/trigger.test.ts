/**
 * Scheduled polling, and reaching into a nested answer.
 *
 * A poller is only correct if it actually repeats and actually waits, so the
 * schedule test counts how many times a real server was polled inside a known
 * window rather than reading the generated loop. The path test runs the same
 * lookups through both backends and compares the output, because "missing
 * field" is the case where two JSON libraries most easily disagree - one
 * raising, one returning null, one returning the string "undefined".
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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

const ALERT = JSON.stringify({
  alert: {
    id: 'a-1',
    device: { hostname: 'web-01', tags: ['prod', 'dmz'] },
    detections: [{ tactic: 'Execution', score: 92 }, { tactic: 'Persistence', score: 41 }],
  },
});

function base(language: string): { project: Project; b: ReturnType<typeof builderFor> } {
  const project = newProject({ name: 'Trigger', language });
  const path = language === 'python' ? 'src/main.py' : 'src/main.js';
  const { graph } = addFile(project, { path, language, role: 'source', graph: { name: 'main' } });
  grant(project, 'net');
  grant(project, 'time');
  return { project, b: builderFor(project, nodes, must(graph, 'a graph')) };
}

async function runOnce(project: Project, command: string, args: string[]): Promise<string> {
  const result = generate(project, { nodes, backends });
  assert.deepEqual(
    result.diagnostics.errors.map((d) => d.message),
    [],
  );
  const dir = mkdtempSync(join(tmpdir(), 'mcode-trig-'));
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

// ---------------------------------------------------------------------------

/** Reads several paths out of one parsed document and prints each. */
function drawPaths(language: string): Project {
  const { project, b } = base(language);
  const entry = b.add('entry/main');
  const parsed = b.addWith('json/parse', { a0: ALERT });
  const chain: GraphNode[] = [];

  const show = (label: string, path: string, fallback: string) => {
    const at = b.addWith('json/path', { a1: path });
    b.connect(parsed, 'value', at, 'a0');
    const text = b.addWith('option/or-else', { a1: fallback });
    b.connect(at, 'value', text, 'a0');
    const asText = b.add('convert/to-string');
    b.connect(text, 'value', asText, 'a0');
    const print = b.add('io/print');
    b.setDefault(print, 'v', `${label}:`);
    b.connect(asText, 'text', print, 'v#1');
    chain.push(print);
  };

  show('host', 'alert.device.hostname', 'unknown');
  show('first-tag', 'alert.device.tags[0]', 'none');
  show('top-tactic', 'alert.detections[0].tactic', 'none');
  show('second-score', 'alert.detections[1].score', '0');
  show('absent', 'alert.device.owner.email', 'not set');
  show('past-the-end', 'alert.detections[9].tactic', 'none');

  b.chain(entry, ...chain);
  return project;
}

const EXPECTED_PATHS = [
  'host: web-01',
  'first-tag: prod',
  'top-tactic: Execution',
  'second-score: 41',
  'absent: not set',
  'past-the-end: none',
].join('\n');

// ---------------------------------------------------------------------------

/** Polls a URL on a short interval, forever. */
function drawPoller(language: string, url: string, seconds: number): Project {
  const { project, b } = base(language);
  const every = b.addWith('time/every', {}, { seconds });
  const req = b.addWith('net/http-request', { url });
  b.connect(every, 'out', req, 'in');
  return project;
}

describe('scheduled triggers', () => {
  it('keeps polling on the interval it was given', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const project = drawPoller('javascript', `http://127.0.0.1:${port}/feed`, 0.1);
    const result = generate(project, { nodes, backends });
    assert.deepEqual(
      result.diagnostics.errors.map((d) => d.message),
      [],
    );
    const dir = mkdtempSync(join(tmpdir(), 'mcode-poll-'));
    writeArtifacts(dir, result.files);
    const child = spawn('node', ['src/main.js'], { cwd: dir, stdio: 'ignore' });

    try {
      // A tenth of a second apart: in one second that is several polls, but a
      // program that ran the chain once and stopped would show exactly one.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.ok(hits >= 4, `expected repeated polls, saw ${hits}`);
      assert.ok(hits <= 20, `polled far more often than asked, saw ${hits}`);
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reaching into a nested answer', () => {
  it('follows dotted and indexed paths in JavaScript', async () => {
    assert.equal(await runOnce(drawPaths('javascript'), 'node', ['src/main.js']), EXPECTED_PATHS);
  });

  it('follows them the same way in Python', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');
    assert.equal(await runOnce(drawPaths('python'), 'python', ['src/main.py']), EXPECTED_PATHS);
  });
});
