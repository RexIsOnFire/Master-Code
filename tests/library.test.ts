/**
 * Library functions as nodes: reading a library, and calling it from a graph.
 *
 * The fixture library is written in the shapes real ones use: a numpydoc
 * function (pandas), a Google-style one, and a client class whose method takes
 * `**kwargs` and documents its real keywords - FalconPy's
 * `query_devices_by_filter`, down to the "Returns:" and "HTTP Method:" lines that
 * follow its parameter list and must not be read as parameters. The introspector
 * runs under the real Python, and the generated program is run against the
 * fixture, so a call that reads right but does not work still fails here.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { generate } from '#core/codegen/generate.ts';
import { build } from '#core/build/pipeline.ts';
import { addDependency, addFile, builderFor, newProject } from '#core/project/builder.ts';
import { runCommand, probeTool } from '#core/runtime/exec.ts';
import { inspectPythonLibrary, surfaceCachePath } from '#core/libraries/surface.ts';
import type { LibraryCallable, LibrarySurface } from '#core/libraries/surface.ts';
import { argPort, portTypeFor } from '#core/nodes/catalog/library.ts';
import { T } from '#core/types/types.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();

const FIXTURE = `"""A library shaped like the ones people use."""
from typing import Optional


def read_table(path, sep=",", *, header: bool = True, limit: Optional[int] = None) -> list:
    """Read a table.

    Parameters
    ----------
    path : str
        Where the table is.
    sep : str, default ","
        Column separator.
    """
    return [path, sep, header, limit]


def join(first, *rest):
    """Join parts.

    Args:
        first (str): The first part.
        rest: The others.
    """
    return "/".join([first, *rest])


class Hosts:
    """Hosts in the fleet."""

    def __init__(self, client_id: str, client_secret: str, base_url: str = "https://api"):
        self.client_id = client_id
        self.base_url = base_url

    def query_devices_by_filter(self, parameters: dict = None, **kwargs):
        """Search for hosts.

        Keyword arguments
        -----------------
        filter : str
            The filter expression. FQL syntax.
        limit : int (1-5000)
            The maximum number of records to return.
        parameters : dict
            Full parameters payload.

        This method only supports keywords for providing arguments.

        Returns: dict object containing API response.

        HTTP Method: GET
        """
        return {"who": self.client_id, "filter": kwargs.get("filter"), "limit": kwargs.get("limit")}

    QueryDevicesByFilter = query_devices_by_filter

    async def fetch(self, url: str) -> str:
        return url

    @staticmethod
    def version() -> str:
        return "1.2.0"

    def _private(self):
        pass
`;

/** Writes the fixture as an installed distribution: the package plus its dist-info. */
function installFixture(dir: string): void {
  mkdirSync(join(dir, 'demofalcon'), { recursive: true });
  writeFileSync(join(dir, 'demofalcon', '__init__.py'), FIXTURE);
  const info = join(dir, 'demo_falcon-1.2.0.dist-info');
  mkdirSync(info, { recursive: true });
  writeFileSync(join(info, 'METADATA'), 'Metadata-Version: 2.1\nName: demo-falcon\nVersion: 1.2.0\n');
  writeFileSync(join(info, 'top_level.txt'), 'demofalcon\n');
}

const pythonAvailable = (await probeTool('python')).available;

async function readFixture(): Promise<{ surface: LibrarySurface; root: string; out: string }> {
  const root = mkdtempSync(join(tmpdir(), 'mc-lib-'));
  const out = join(root, 'build', 'generated');
  // The introspector runs from the output directory, which Python puts on sys.path.
  installFixture(out);
  const result = await inspectPythonLibrary({ name: 'demo-falcon', version: '1.2.0', out, root });
  assert.equal(result.diagnostics.ok, true, result.diagnostics.format());
  return { surface: must(result.surface, 'a surface'), root, out };
}

const fn = (s: LibrarySurface, name: string): LibraryCallable => must(s.modules[0].functions.find((f) => f.name === name), name);
const hosts = (s: LibrarySurface) => must(s.modules[0].classes.find((c) => c.name === 'Hosts'), 'Hosts');

describe('reading a Python library', { skip: !pythonAvailable && 'python is not installed' }, () => {
  it('reads signatures, kinds, types, defaults and numpydoc / Google documentation', async () => {
    const { surface, root } = await readFixture();
    try {
      assert.equal(surface.package, 'demo-falcon');
      assert.equal(surface.version, '1.2.0');
      assert.deepEqual(surface.modules.map((m) => m.name), ['demofalcon']);

      const read = fn(surface, 'read_table');
      assert.deepEqual(read.params?.map((p) => `${p.name}:${p.kind}:${p.required}`), ['path:either:true', 'sep:either:false', 'header:keyword:false', 'limit:keyword:false']);
      assert.equal(read.params?.[0].type, 'str', 'type from the numpydoc entry');
      assert.equal(read.params?.[0].doc, 'Where the table is.');
      assert.equal(read.params?.[1].default, "','");
      assert.equal(read.params?.[2].type, 'bool', 'type from the annotation');
      assert.equal(read.returns, 'list');

      const joined = fn(surface, 'join');
      assert.deepEqual(joined.params?.map((p) => `${p.name}:${p.kind}`), ['first:either', 'rest:varargs']);
      assert.equal(joined.params?.[0].type, 'str', 'type from the Google-style entry');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('offers the keywords a **kwargs method documents, and nothing that only looks like one', async () => {
    const { surface, root } = await readFixture();
    try {
      const cls = hosts(surface);
      assert.deepEqual(cls.init.params?.map((p) => `${p.name}:${p.required}`), ['client_id:true', 'client_secret:true', 'base_url:false']);
      const query = must(cls.methods.find((m) => m.name === 'query_devices_by_filter'), 'the method');
      assert.deepEqual(query.params?.map((p) => `${p.name}:${p.kind}${p.fromDoc ? ':doc' : ''}`), ['parameters:either', 'filter:keyword:doc', 'limit:keyword:doc']);
      assert.equal(query.params?.find((p) => p.name === 'limit')?.type, 'int (1-5000)');
      assert.equal(query.extraKeywords, true);
      assert.equal(query.doc, 'Search for hosts.');

      const names = cls.methods.map((m) => m.name);
      assert.equal(names.includes('QueryDevicesByFilter'), false, 'an alias is listed once, under its real name');
      assert.equal(names.includes('_private'), false);
      assert.equal(cls.methods.find((m) => m.name === 'fetch')?.async, true);
      assert.deepEqual(cls.methods.find((m) => m.name === 'version')?.params, [], 'a static method keeps no self to drop');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caches what it read in the project, and says plainly when a library is missing', async () => {
    const { root, out } = await readFixture();
    try {
      assert.ok(existsSync(surfaceCachePath(root, 'demo-falcon', '1.2.0')));
      const again = await inspectPythonLibrary({ name: 'demo-falcon', version: '1.2.0', out, root });
      assert.equal(again.cached, true);
      const missing = await inspectPythonLibrary({ name: 'no-such-package-mcode', version: '1.0.0', out, root });
      assert.equal(missing.surface, undefined);
      assert.match(missing.diagnostics.format(), /not installed[\s\S]*pip install no-such-package-mcode==1\.0\.0/);
      assert.equal(existsSync(join(out, '_mcode_inspect.py')), false, 'the introspector is removed afterwards');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('library nodes', () => {
  const hostsInit: LibraryCallable = {
    name: 'Hosts',
    params: [
      { name: 'client_id', kind: 'either', required: true, type: 'str' },
      { name: 'client_secret', kind: 'either', required: true, type: 'str' },
      { name: 'base_url', kind: 'either', required: false, type: 'str', default: "'https://api'" },
    ],
  };
  const query: LibraryCallable = {
    name: 'query_devices_by_filter',
    params: [
      { name: 'parameters', kind: 'either', required: false, type: 'dict' },
      { name: 'filter', kind: 'keyword', required: false, type: 'str', fromDoc: true },
      { name: 'limit', kind: 'keyword', required: false, type: 'int (1-5000)', fromDoc: true },
    ],
    extraKeywords: true,
  };
  const joinFn: LibraryCallable = {
    name: 'join',
    params: [
      { name: 'first', kind: 'either', required: true },
      { name: 'rest', kind: 'varargs', required: false },
    ],
  };
  const base = { package: 'demo-falcon', version: '1.2.0', module: 'demofalcon' };

  function project(options: { language?: string; skipSecret?: boolean; use?: string } = {}) {
    const language = options.language ?? 'python';
    const p = newProject({ name: 'Lib', language, namespace: 'example.com/lib' });
    // As the Libraries panel's Add does; a library node is only ever made from a library already added.
    addDependency(p, { name: 'demo-falcon', version: '1.2.0', language: 'python', manager: 'pip' });
    const { graph } = addFile(p, { path: language === 'python' ? 'src/main.py' : 'src/main.js', language, role: 'entry', graph: { name: 'main' } });
    const b = builderFor(p, nodes, must(graph, 'a graph'));
    const entry = b.add('entry/main');
    const client = b.add('library/new', { ...base, className: 'Hosts', callable: hostsInit, use: '' });
    b.setDefault(client, argPort('client_id'), 'id-123');
    if (!options.skipSecret) b.setDefault(client, argPort('client_secret'), 's3cret');
    const search = b.add('library/method', { ...base, className: 'Hosts', callable: query, use: options.use ?? 'filter, limit' });
    b.connect(client, 'instance', search, 'self');
    b.setDefault(search, argPort('filter'), "platform_name:'Windows'");
    b.setDefault(search, argPort('limit'), 10);
    const show = b.add('io/print');
    b.connect(search, 'result', show, 'v');
    const path = b.add('library/function', { ...base, callable: joinFn, use: 'rest' });
    b.setDefault(path, argPort('first'), 'a');
    b.setDefault(path, `${argPort('rest')}`, 'b');
    const showPath = b.add('io/print');
    b.connect(path, 'result', showPath, 'v');
    b.chain(entry, client, search, show, path, showPath);
    return p;
  }

  it('maps simple documented types to ports and leaves the rest open', () => {
    assert.deepEqual(portTypeFor('str'), T.string);
    assert.deepEqual(portTypeFor('int (1-5000)'), T.i64);
    assert.deepEqual(portTypeFor('Optional[int]'), T.i64);
    assert.deepEqual(portTypeFor('bool, optional'), T.bool);
    assert.deepEqual(portTypeFor('str or list'), T.any);
    assert.deepEqual(portTypeFor('Union[str, int]'), T.any);
    assert.deepEqual(portTypeFor('DataFrame'), T.any);
  });

  it('shows required parameters and the chosen optional ones as ports', () => {
    const p = project();
    const graph = p.graphs[0];
    const ports = (type: string) => must(graph.nodes.find((n) => n.type === type), type).inputs.map((i) => i.id);
    assert.deepEqual(ports('library/new'), ['in', 'arg_client_id', 'arg_client_secret']);
    assert.deepEqual(ports('library/method'), ['in', 'self', 'arg_filter', 'arg_limit']);
  });

  it('generates the call the library expects: exact names, positional where natural, keywords otherwise', () => {
    const result = generate(project(), { nodes, backends });
    assert.equal(result.diagnostics.ok, true, result.diagnostics.format());
    const main = must(result.files.find((f) => f.path === 'src/main.py'), 'main.py').content;
    // Names from one module share an import line, as the backend writes every import.
    assert.match(main, /^from demofalcon import Hosts, join$/m);
    assert.match(main, /hosts: Any = Hosts\('id-123', 's3cret'\)/);
    assert.match(main, /= hosts\.query_devices_by_filter\(filter="platform_name:'Windows'", limit=10\)/);
    assert.match(main, /= join\('a', 'b'\)/);
    const requirements = must(result.files.find((f) => f.path === 'requirements.txt'), 'requirements').content;
    assert.match(requirements, /^demo-falcon==1\.2\.0$/m, 'the manifest names the package, not the module');
    assert.ok(result.packages.some((p) => p.name === 'demo-falcon' && p.version === '1.2.0'), 'the nodes report the package they need');
    assert.ok(!result.packages.some((p) => p.name === 'demofalcon'), 'never the module name');
  });

  it('reports a missing required argument and an unknown optional one on the node', () => {
    const missing = generate(project({ skipSecret: true }), { nodes, backends });
    assert.match(missing.diagnostics.format(), /Hosts needs "client_secret"/);
    const unknown = generate(project({ use: 'filter, limit, nonsense' }), { nodes, backends });
    assert.match(unknown.diagnostics.format(), /no parameter "nonsense"[\s\S]*Optional parameters: parameters, filter, limit/);
  });

  it('is refused in a language without keyword arguments', () => {
    const result = generate(project({ language: 'javascript' }), { nodes, backends });
    assert.match(result.diagnostics.format(), /only available for python/);
  });

  it('runs against the library', { skip: !pythonAvailable && 'python is not installed' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-libnodes-'));
    try {
      const p = project();
      const outcome = await build({ project: p, root, nodes, backends, generateOnly: true });
      assert.equal(outcome.ok, true, outcome.diagnostics.format());
      const lib = join(root, 'lib');
      installFixture(lib);
      cpSync(join(lib, 'demofalcon'), join(root, 'src', 'demofalcon'), { recursive: true });
      const run = await runCommand({ command: 'python', args: ['src/main.py'], cwd: root, env: { PYTHONPATH: 'src' } });
      assert.equal(run.code, 0, run.stderr);
      const lines = run.stdout.replace(/\r\n/g, '\n').trim().split('\n');
      assert.deepEqual(lines, ["{'who': 'id-123', 'filter': \"platform_name:'Windows'\", 'limit': 10}", 'a/b']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
