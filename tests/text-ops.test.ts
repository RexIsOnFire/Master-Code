/**
 * Pattern, encoding, digest, identity and time operations.
 *
 * The assertion that matters here is not that each backend emits something -
 * it is that one graph, generated into two different languages and actually
 * executed, prints the *same bytes*. These operations exist to be compared
 * against each other (a hash against a feed, a timestamp against a window), so
 * a backend that is merely plausible on its own is still wrong. Every place
 * where the two standard libraries disagree by default - Python's findall
 * returning groups rather than matches, JavaScript reading an unzoned
 * timestamp as local time, `$1` against `\1` - is a divergence this test
 * would catch.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildAndRun, must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { generate } from '#core/codegen/generate.ts';
import { writeArtifacts } from '#core/project/io.ts';
import { addFile, builderFor, newProject } from '#core/project/builder.ts';
import { runInSandbox } from '#core/runtime/sandbox.ts';
import { probeTool } from '#core/runtime/exec.ts';
import type { GraphNode } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();

const SAMPLE = 'host web-01 talked to 10.0.0.7 and 192.168.1.22 at 2024-03-05T14:30:00Z';
const IPV4 = '(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})';

/**
 * One graph exercising every operation, printing only strings.
 *
 * Strings on purpose: a list or a boolean renders differently in each language
 * (`True` against `true`, `['a']` against `[ 'a' ]`), so printing one directly
 * would fail for a reason that has nothing to do with the operation under test.
 */
function buildProbe(language: string) {
  const project = newProject({ name: 'TextOps', language, namespace: 'example.com/textops' });
  const mainPath =
    language === 'python'
      ? 'src/main.py'
      : language === 'go'
        ? 'main.go'
        : language === 'kotlin'
          ? 'src/main/kotlin/app/Main.kt'
          : 'src/main.js';
  const { graph } = addFile(project, {
    path: mainPath,
    language,
    role: 'source',
    graph: { name: 'main' },
  });
  const b = builderFor(project, nodes, must(graph, 'a graph'));

  const entry = b.add('entry/main');
  const chain: GraphNode[] = [];

  /** Appends `Print "<label>:" <value>` to the execution chain. */
  const show = (label: string, value: GraphNode, port: string) => {
    const print = b.add('io/print');
    b.setDefault(print, 'v', `${label}:`);
    b.connect(value, port, print, 'v#1');
    chain.push(print);
  };

  /** A boolean rendered as text, so the two languages can be compared. */
  const asYesNo = (source: GraphNode, port: string) => {
    const select = b.addWith('op/select', { then: 'yes', else: 'no' });
    b.connect(source, port, select, 'cond');
    return select;
  };

  /** A list rendered as text, for the same reason. */
  const asJoined = (source: GraphNode, port: string) => {
    const join = b.addWith('string/join', { a1: '|' });
    b.connect(source, port, join, 'a0');
    return join;
  };

  // -- pattern matching ------------------------------------------------------
  show('match', asYesNo(b.addWith('regex/match', { a0: SAMPLE, a1: IPV4 }), 'matches'), 'result');
  show('find-all', asJoined(b.addWith('regex/find-all', { a0: SAMPLE, a1: IPV4 }), 'matches'), 'text');
  show('capture', asJoined(b.addWith('regex/capture', { a0: SAMPLE, a1: IPV4 }), 'groups'), 'text');

  // `$2$1` proves group substitution, `$$` a literal dollar, `$x` passthrough.
  show('replace', b.addWith('regex/replace', { a0: 'a1-b2', a1: '([a-z])(\\d)', a2: '$2$1$$x' }), 'text');
  show('split', asJoined(b.addWith('regex/split', { a0: 'one1two22three', a1: '\\d+' }), 'parts'), 'text');

  // -- encoding --------------------------------------------------------------
  // Non-ASCII on purpose: these operations are defined over UTF-8 bytes, and a
  // backend that reached for the platform's default charset would differ here.
  // The round trip is asserted in hex rather than printed directly, because a
  // Windows console re-encodes non-ASCII output and would fail the comparison
  // for a reason that has nothing to do with the backend.
  const b64 = b.addWith('encode/base64', { a0: 'user:pa55 wörd' });
  show('base64', b64, 'encoded');
  const b64back = b.add('encode/base64-decode');
  b.connect(b64, 'encoded', b64back, 'a0');
  const b64hex = b.add('encode/hex');
  b.connect(b64back, 'text', b64hex, 'a0');
  show('base64-roundtrip', b64hex, 'encoded');

  show('hex', b.addWith('encode/hex', { a0: 'abc' }), 'encoded');

  const urlEnc = b.addWith('encode/url', { a0: "a b+c/d~e!f*g'h(i)" });
  show('url', urlEnc, 'encoded');
  const urlBack = b.add('encode/url-decode');
  b.connect(urlEnc, 'encoded', urlBack, 'a0');
  show('url-roundtrip', urlBack, 'text');

  // -- digests ---------------------------------------------------------------
  show('sha256', b.addWith('hash/sha256', { a0: 'abc' }), 'hex');
  show('sha1', b.addWith('hash/sha1', { a0: 'abc' }), 'hex');
  show('md5', b.addWith('hash/md5', { a0: 'abc' }), 'hex');
  show(
    'hmac',
    b.addWith('hash/hmac-sha256', {
      a0: 'key',
      a1: 'The quick brown fox jumps over the lazy dog',
    }),
    'hex',
  );

  // -- time ------------------------------------------------------------------
  // Parse then format: the round trip pins both halves at once, and the
  // unzoned case is exactly where the two languages disagree by default.
  // Parse returns an optional, so Require Value is what makes it usable: an
  // unparseable timestamp here is a mistake in the graph, not a branch.
  const roundTrip = (label: string, text: string) => {
    const parsed = b.addWith('time/parse-iso', { a0: text });
    const required = b.addWith('option/require', { a1: `not a timestamp: ${text}` });
    b.connect(parsed, 'millis', required, 'a0');
    const formatted = b.add('time/format-iso');
    b.connect(required, 'value', formatted, 'a0');
    show(label, formatted, 'timestamp');
  };
  roundTrip('iso-zulu', '2024-03-05T14:30:00.250Z');
  roundTrip('iso-naive', '2024-03-05T14:30:00');
  roundTrip('iso-offset', '2024-03-05T14:30:00+02:00');

  // -- non-deterministic values: assert the shape, not the value -------------
  const uuid = b.add('id/uuid');
  chain.push(uuid);
  const uuidShape = b.addWith('regex/match', {
    a1: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  });
  b.connect(uuid, 'uuid', uuidShape, 'a0');
  show('uuid-shape', asYesNo(uuidShape, 'matches'), 'result');

  const now = b.add('time/now-iso');
  chain.push(now);
  const nowShape = b.addWith('regex/match', {
    a1: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
  });
  b.connect(now, 'timestamp', nowShape, 'a0');
  show('now-shape', asYesNo(nowShape, 'matches'), 'result');

  b.chain(entry, ...chain);
  return project;
}

/** Generates, writes and runs the probe, returning its trimmed stdout. */
async function runProbe(language: string, command: string, args: string[]): Promise<string> {
  const project = buildProbe(language);
  const result = generate(project, { nodes, backends });
  assert.deepEqual(
    result.diagnostics.errors.map((d) => d.message),
    [],
  );

  const dir = mkdtempSync(join(tmpdir(), 'mcode-text-'));
  try {
    writeArtifacts(dir, result.files);
    const run = await runInSandbox({
      project,
      root: dir,
      command: { label: 'run', command, args },
    });
    assert.equal(run.code, 0, run.stderr);
    return run.stdout.replace(/\r\n/g, '\n').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXPECTED = [
  'match: yes',
  'find-all: 10.0.0.7|192.168.1.22',
  'capture: 10.0.0.7|10|0|0|7',
  'replace: 1a$x-2b$x',
  'split: one|two|three',
  'base64: dXNlcjpwYTU1IHfDtnJk',
  'base64-roundtrip: 757365723a706135352077c3b67264',
  'hex: 616263',
  'url: a%20b%2Bc%2Fd~e%21f%2Ag%27h%28i%29',
  "url-roundtrip: a b+c/d~e!f*g'h(i)",
  'sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'sha1: a9993e364706816aba3e25717850c26c9cd0d89d',
  'md5: 900150983cd24fb0d6963f7d28e17f72',
  'hmac: f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
  'iso-zulu: 2024-03-05T14:30:00.250Z',
  'iso-naive: 2024-03-05T14:30:00.000Z',
  'iso-offset: 2024-03-05T12:30:00.000Z',
  'uuid-shape: yes',
  'now-shape: yes',
].join('\n');

describe('pattern, encoding, digest and time operations', () => {
  it('produces the documented results in JavaScript', async () => {
    assert.equal(await runProbe('javascript', 'node', ['src/main.js']), EXPECTED);
  });

  it('produces the same results, byte for byte, in Python', async (t) => {
    const python = await probeTool('python', ['--version']);
    if (!python.available) return t.skip('python is not installed');
    assert.equal(await runProbe('python', 'python', ['src/main.py']), EXPECTED);
  });

  it('produces the same results, byte for byte, in Kotlin', async (t) => {
    if (!(await probeTool('kotlinc', ['-version'])).available) return t.skip('kotlinc is not installed');
    // Compiled by kotlinc and run on the JVM: the regex replacement syntax,
    // URL encoding set and ISO formatting all differ from Java's defaults.
    const project = buildProbe('kotlin');
    project.grants.stdio = true;
    assert.equal(await buildAndRun(project, 'kotlin', { nodes, backends }), EXPECTED);
  });

  it('produces the same results, byte for byte, in Go', async (t) => {
    const go = await probeTool('go', ['version']);
    if (!go.available) return t.skip('go is not installed');
    // `go run .` compiles first, so this also proves the emitted package and
    // its imports are valid Go, not merely plausible text.
    assert.equal(await runProbe('go', 'go', ['run', '.']), EXPECTED);
  });
});
