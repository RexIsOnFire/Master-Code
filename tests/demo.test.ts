/**
 * The browser demo's platform layer, checked under Node.
 *
 * `path` is held to Node's own `path.posix` across awkward inputs, because the
 * core trusts it to behave identically. The disk is held to Node's error
 * semantics. Archives are checked against an independent reader (Python's
 * zipfile) as well as our own, since a zip only we can read is not a zip.
 *
 * The modules are browser JavaScript without type declarations, so they are
 * loaded by URL and typed loosely here.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createHmac } from 'node:crypto';
import { format as nodeFormat, inspect as nodeInspect } from 'node:util';

import { probeTool } from '#core/runtime/exec.ts';
import { registryHeaders } from '#core/libraries/registry.ts';

describe('demo registry search', () => {
  it('sends no User-Agent from a browser, so PyPI and npm need no CORS preflight', () => {
    assert.equal(registryHeaders()['user-agent'], 'mastercode-library-browser', 'Node identifies itself');
    const global = globalThis as { document?: unknown };
    global.document = {};
    try {
      assert.deepEqual(registryHeaders(), { accept: 'application/json' });
    } finally {
      delete global.document;
    }
  });
});

type Loose = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const load = (path: string): Promise<Loose> => import(new URL(`../packages/demo/public/${path}`, import.meta.url).href);

const shimPath: Loose = await load('node/path.js');
const vfs: Loose = await load('vfs.js');
const zip: Loose = await load('zip.js');
const digest: Loose = await load('node-runtime/digest.js');
const shimInspect: Loose = await load('node-runtime/inspect.js');
const shimAssert: Loose = (await load('node-runtime/assert.js')).createAssert(shimInspect.inspect);

describe('demo JavaScript runtime', () => {
  const inputs = ['', 'abc', 'héllo wörld', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)];

  it('sha256, sha1 and md5 match node:crypto, across the padding boundaries', () => {
    const crypto = digest.createCrypto();
    for (const algorithm of ['sha256', 'sha1', 'md5']) {
      for (const text of inputs) {
        assert.equal(crypto.createHash(algorithm).update(text, 'utf8').digest('hex'), createHash(algorithm).update(text, 'utf8').digest('hex'), `${algorithm}(${text.length} chars)`);
      }
    }
  });

  it('HMAC-SHA256 matches node:crypto, including keys longer than a block', () => {
    const crypto = digest.createCrypto();
    for (const key of ['k', 'secret key', 'K'.repeat(100)]) {
      assert.equal(crypto.createHmac('sha256', key).update('message').digest('hex'), createHmac('sha256', key).update('message').digest('hex'), `key of ${key.length}`);
    }
    assert.throws(() => crypto.createHash('sha512'), /not supported/);
  });

  it('console output matches util.inspect and util.format for everyday values', () => {
    class Point {
      x = 1;
      y = 2;
    }
    const values: unknown[] = [
      [1, 2, 3], { a: 1, b: 'x' }, 'top-level string', ['it\'s', 'quoted'], new Map([['k', 1]]), new Set([1, 2]), new Point(),
      null, undefined, 42, -0, 10n, true, [], {}, { nested: { deeper: { deepest: { gone: 1 } } } }, [undefined, null],
      { 'needs-quote': 1, ok: 2 }, function named() {}, () => {}, Object.create(null),
    ];
    for (const value of values) {
      assert.equal(shimInspect.format(value), nodeFormat(value), nodeInspect(value));
    }
    assert.equal(shimInspect.format('%s is %d years', 'Ada', 36), nodeFormat('%s is %d years', 'Ada', 36));
    assert.equal(shimInspect.format('a', 1, 'b', [2]), nodeFormat('a', 1, 'b', [2]));
    assert.equal(shimInspect.format('100%%'), nodeFormat('100%%'));
  });

  it('assert follows node:assert on equality and reports in its words', () => {
    shimAssert.strict.deepEqual({ a: [1, { b: 2 }], m: new Map([[1, new Set([2])]]) }, { a: [1, { b: 2 }], m: new Map([[1, new Set([2])]]) });
    assert.throws(() => shimAssert.strict.equal(1, '1'), { code: 'ERR_ASSERTION', message: /strictly equal/ });
    assert.throws(() => shimAssert.strict.deepEqual([1], ['1']), { code: 'ERR_ASSERTION' });
    shimAssert.deepEqual([1], ['1']);
    assert.throws(() => shimAssert.strict.deepEqual(Object.create(null), {}), { code: 'ERR_ASSERTION' });
    shimAssert.throws(() => {
      throw new TypeError('bad');
    }, TypeError);
    assert.throws(() => shimAssert.throws(() => {}), /Missing expected exception/);
    assert.throws(() => shimAssert.ok(0, 'custom'), { message: 'custom' });
  });
});

describe('demo path', () => {
  const inputs = [
    '', '.', '..', '/', '//', '/a/b/c', '/a/b/c/', 'a/b', 'a/b/', './a', '../a', '/a/../b', '/../a', 'a/../..',
    '/a/./b/../c//d', 'a//b', '/a/b/.', '/a/b/..', 'file.txt', '.bashrc', 'a.', 'a.b.c', '/x/y.tar.gz', 'dir/', '/dir//',
  ];

  it('normalize, dirname, basename and extname match node:path/posix', () => {
    for (const input of inputs) {
      assert.equal(shimPath.normalize(input), posix.normalize(input), `normalize(${JSON.stringify(input)})`);
      assert.equal(shimPath.dirname(input), posix.dirname(input), `dirname(${JSON.stringify(input)})`);
      assert.equal(shimPath.basename(input), posix.basename(input), `basename(${JSON.stringify(input)})`);
      assert.equal(shimPath.extname(input), posix.extname(input), `extname(${JSON.stringify(input)})`);
    }
    assert.equal(shimPath.basename('/a/b.py', '.py'), 'b');
    assert.equal(shimPath.basename('/a/.py', '.py'), posix.basename('/a/.py', '.py'));
  });

  it('join, resolve and relative match node:path/posix for absolute inputs', () => {
    const pairs = [['/a/b', 'c'], ['/a/b', '../c'], ['/a', '/b'], ['/', 'x'], ['/a/b/c', '../../..'], ['/a', ''], ['/a/b', './c/./d']];
    for (const [a, b] of pairs) {
      assert.equal(shimPath.join(a, b), posix.join(a, b), `join(${a}, ${b})`);
      assert.equal(shimPath.resolve(a, b), posix.resolve(a, b), `resolve(${a}, ${b})`);
    }
    const rel = [['/a/b/c', '/a/d'], ['/a', '/a/b/c'], ['/a/b', '/a/b'], ['/', '/x/y'], ['/x/y', '/'], ['/ab', '/a']];
    for (const [a, b] of rel) assert.equal(shimPath.relative(a, b), posix.relative(a, b), `relative(${a}, ${b})`);
  });
});

describe('demo disk', () => {
  it('refuses what a real disk refuses, with the same codes', () => {
    const disk = new vfs.MemoryFs();
    assert.throws(() => disk.writeFile('/nope/file.txt', 'x'), { code: 'ENOENT' });
    assert.throws(() => disk.mkdir('/a/b'), { code: 'ENOENT' });
    disk.mkdir('/a/b', { recursive: true });
    assert.throws(() => disk.mkdir('/a/b'), { code: 'EEXIST' });
    disk.mkdir('/a/b', { recursive: true });
    disk.writeFile('/a/b/f.txt', 'hello');
    assert.throws(() => disk.rmdir('/a/b'), { code: 'ENOTEMPTY' });
    assert.throws(() => disk.readFile('/a/b'), { code: 'EISDIR' });
    assert.throws(() => disk.readdir('/a/b/f.txt'), { code: 'ENOTDIR' });
    assert.throws(() => disk.writeFile('/a/b/f.txt/x', 'y'), { code: 'ENOTDIR' });
    assert.throws(() => disk.rm('/a'), { code: 'EISDIR' });
    disk.rm('/missing', { force: true });
  });

  it('lists, enumerates and removes trees', () => {
    const disk = new vfs.MemoryFs();
    disk.mkdir('/p/src/pkg', { recursive: true });
    disk.writeFile('/p/src/main.py', 'print(1)');
    disk.writeFile('/p/src/pkg/__init__.py', '');
    disk.writeFile('/p/README.md', '# p');
    assert.deepEqual(disk.readdir('/p'), ['README.md', 'src']);
    assert.deepEqual(disk.readdir('/p/src'), ['main.py', 'pkg']);
    assert.deepEqual(disk.files('/p').map(([p]: [string]) => p), ['/p/README.md', '/p/src/main.py', '/p/src/pkg/__init__.py']);
    disk.rm('/p/src', { recursive: true });
    assert.equal(disk.exists('/p/src/pkg/__init__.py'), false);
    assert.deepEqual(disk.readdir('/p'), ['README.md']);
  });
});

describe('demo zip', () => {
  const entries = [
    { name: 'Greeter/project.json', data: JSON.stringify({ name: 'Greeter', language: 'python' }, null, 2) },
    { name: 'Greeter/build/generated/src/main.py', data: 'def main():\n    print("héllo, wörld")\n'.repeat(50) },
    { name: 'Greeter/build/generated/src/app/__init__.py', data: '' },
    { name: 'Greeter/assets/blob.bin', data: Uint8Array.from({ length: 300 }, (_, i) => (i * 7919) % 256) },
  ];

  it('round-trips through its own reader, byte for byte', async () => {
    const bytes = await zip.writeZip(entries);
    const back = await zip.readZip(bytes);
    assert.deepEqual(back.map((e: Loose) => e.name), entries.map((e) => e.name));
    for (const [i, entry] of entries.entries()) {
      const expected = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
      assert.deepEqual([...back[i].data], [...expected], entry.name);
    }
  });

  it('is read correctly by an independent implementation (Python zipfile)', async (t) => {
    const python = await probeTool('python');
    if (!python.available) return t.skip('python is not installed');
    const dir = mkdtempSync(join(tmpdir(), 'mc-zip-'));
    try {
      const archive = join(dir, 'out.zip');
      writeFileSync(archive, await zip.writeZip(entries));
      const script = [
        'import zipfile, sys, json',
        'z = zipfile.ZipFile(sys.argv[1])',
        'assert z.testzip() is None, "bad CRC"',
        'print(json.dumps({i.filename: [i.file_size, i.compress_type] for i in z.infolist()}))',
        'print(z.read("Greeter/build/generated/src/main.py").decode("utf-8").splitlines()[1])',
      ].join('\n');
      const run = spawnSync('python', ['-c', script, archive], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const [listing, line] = run.stdout.trim().split(/\r?\n/);
      const info = JSON.parse(listing);
      assert.equal(info['Greeter/project.json'][0], (entries[0].data as string).length);
      assert.equal(info['Greeter/build/generated/src/main.py'][1], 8, 'compressible text is deflated');
      assert.equal(line, '    print("héllo, wörld")');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads an archive written by Python (deflated and stored entries)', async (t) => {
    const python = await probeTool('python');
    if (!python.available) return t.skip('python is not installed');
    const dir = mkdtempSync(join(tmpdir(), 'mc-zip-'));
    try {
      const archive = join(dir, 'py.zip');
      const script = [
        'import zipfile, sys',
        'with zipfile.ZipFile(sys.argv[1], "w") as z:',
        '    z.writestr("p/a.txt", "deflated " * 100, compress_type=zipfile.ZIP_DEFLATED)',
        '    z.writestr("p/b.txt", "stored", compress_type=zipfile.ZIP_STORED)',
        '    z.writestr("p/sub/", "")',
      ].join('\n');
      assert.equal(spawnSync('python', ['-c', script, archive], { encoding: 'utf8' }).status, 0);
      const back = await zip.readZip(new Uint8Array(readFileSync(archive)));
      assert.deepEqual(back.map((e: Loose) => e.name), ['p/a.txt', 'p/b.txt']);
      assert.equal(new TextDecoder().decode(back[0].data), 'deflated '.repeat(100));
      assert.equal(new TextDecoder().decode(back[1].data), 'stored');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses names that would land outside the project', async () => {
    for (const bad of ['../evil.py', 'a/../../evil.py', '/etc/passwd', 'C:/x.py', 'a\\..\\b', 'a/\0b']) {
      assert.equal(zip.safeEntryName(bad), null, bad);
      const archive = await zip.writeZip([{ name: bad, data: 'x' }]);
      await assert.rejects(zip.readZip(archive), /outside the project/, bad);
    }
    assert.equal(zip.safeEntryName('./a//b/./c.py'), 'a/b/c.py');
  });

  it('detects a corrupted entry by its checksum', async () => {
    const archive = await zip.writeZip([{ name: 'x.txt', data: 'abc' }]);
    // The stored body sits right after the 30-byte header and the 5-byte name.
    archive[35] ^= 0xff;
    await assert.rejects(zip.readZip(archive), /checksum/);
  });
});
