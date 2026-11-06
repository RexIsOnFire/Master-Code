/**
 * Core behaviour: the type system, lowering, and the IR.
 *
 * These assert the properties the rest of the platform depends on, not the
 * incidental shape of the output. A test that pins the exact spelling of
 * generated code would break on every cosmetic change; a test that asserts
 * "the cross-file import is present" survives that and still catches the bug.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { findFunction, must } from './helpers.ts';

import { T, isAssignable, parseType, substitute, typeToString, unify } from '#core/types/types.ts';
import type { Substitution } from '#core/types/types.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { BUILTINS, getBuiltin } from '#core/ir/builtins.ts';
import { GraphBuilder, addFile, newProject } from '#core/project/builder.ts';
import { lowerGraph } from '#core/lower/lower.ts';
import { validateGraph } from '#core/lower/validate.ts';
import { collectCapabilities } from '#core/ir/ir.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();

function scratchProject(language = 'python') {
  const project = newProject({ name: 'Scratch', language });
  const { file, graph } = addFile(project, {
    path: `src/main.${language === 'python' ? 'py' : 'js'}`,
    language,
    role: 'entry',
    graph: { name: 'main', style: 'procedural' },
  });
  return { project, file, graph: graph!, builder: new GraphBuilder(project, nodes, graph!) };
}

// ---------------------------------------------------------------------------

describe('type system', () => {
  it('round-trips every type through text', () => {
    const samples = [
      'bool', 'i32', 'i64', 'f64', 'string', 'char', 'bytes',
      'List<string>', 'Set<i64>', 'Map<string, List<f64>>', 'Option<string>',
      'Result<i64, string>', '(i64, string)', 'Future<bool>',
      '(i64, string) -> bool', 'Exec', 'Void', 'Any', 'HttpResponse',
    ];
    for (const text of samples) {
      assert.equal(typeToString(parseType(text)), text, `round trip failed for ${text}`);
    }
  });

  it('widens numerics but never narrows them', () => {
    assert.equal(isAssignable(T.i32, T.i64).ok, true);
    assert.equal(isAssignable(T.i64, T.f64).ok, true);
    assert.equal(isAssignable(T.f64, T.i64).ok, false);
  });

  it('keeps execution flow separate from data flow', () => {
    assert.equal(isAssignable(T.exec, T.exec).ok, true);
    assert.equal(isAssignable(T.exec, T.string).ok, false);
    assert.equal(isAssignable(T.string, T.exec).ok, false);
  });

  it('treats containers as covariant and reports the failing position', () => {
    assert.equal(isAssignable(T.list(T.i32), T.list(T.f64)).ok, true);
    const bad = isAssignable(T.list(T.string), T.list(T.i64));
    assert.equal(bad.ok, false);
    assert.match((bad as { reason: string }).reason, /list element/);
  });

  it('wraps a bare value into an option but not the reverse', () => {
    const wrapped = isAssignable(T.string, T.option(T.string));
    assert.equal(wrapped.ok && wrapped.coercion, 'wrap-option');
    assert.equal(isAssignable(T.option(T.string), T.string).ok, false);
  });

  it('unifies type variables and widens a numeric variable seen twice', () => {
    const subst: Substitution = new Map();
    assert.equal(unify(T.list(T.var('T')), T.list(T.string), subst), true);
    assert.equal(typeToString(substitute(T.var('T'), subst)), 'string');

    const numeric: Substitution = new Map();
    unify(T.var('N'), T.i64, numeric);
    unify(T.var('N'), T.f64, numeric);
    assert.equal(typeToString(substitute(T.var('N'), numeric)), 'f64');
  });
});

// ---------------------------------------------------------------------------

describe('builtin contract', () => {
  it('has a unique id for every operation', () => {
    const seen = new Set<string>();
    for (const spec of BUILTINS) {
      assert.equal(seen.has(spec.op), false, `duplicate builtin ${spec.op}`);
      seen.add(spec.op);
    }
  });

  it('gives every operation a signature and documentation', () => {
    for (const spec of BUILTINS) {
      assert.ok(spec.doc.length > 10, `${spec.op} needs a real description`);
      assert.ok(spec.returns, `${spec.op} has no return type`);
      assert.ok(spec.category, `${spec.op} has no category`);
    }
  });

  it('declares a capability for every operation that touches the outside world', () => {
    for (const op of ['file_read_text', 'file_write_text', 'http_request', 'env_get']) {
      assert.ok(getBuiltin(op)?.caps?.length, `${op} must declare a capability`);
    }
    // Pure computation must not require anything.
    assert.equal(getBuiltin('str_upper')?.caps, undefined);
  });
});

// ---------------------------------------------------------------------------

describe('node catalogue', () => {
  it('registers every node type exactly once', () => {
    const seen = new Set<string>();
    for (const def of nodes.all()) {
      assert.equal(seen.has(def.type), false, `duplicate node ${def.type}`);
      seen.add(def.type);
    }
    assert.ok(nodes.all().length > 150, 'the catalogue should be substantial');
  });

  it('gives every node a title, category and description', () => {
    for (const def of nodes.all()) {
      assert.ok(def.title, `${def.type} has no title`);
      assert.ok(def.category, `${def.type} has no category`);
      assert.ok(def.description.length > 10, `${def.type} needs a real description`);
    }
  });

  it('declares only port types the parser understands', () => {
    for (const def of nodes.all()) {
      for (const port of [...def.inputs, ...def.outputs]) {
        if (typeof port.type !== 'string') continue;
        assert.doesNotThrow(() => parseType(port.type as string), `${def.type}.${port.id}: ${port.type}`);
      }
    }
  });

  it('restricts DOM nodes to JavaScript', () => {
    const dom = nodes.all().filter((d) => d.category === 'DOM');
    assert.ok(dom.length > 5);
    for (const def of dom) assert.deepEqual(def.languages, ['javascript']);
    assert.equal(nodes.available('python').some((d) => d.category === 'DOM'), false);
  });
});

// ---------------------------------------------------------------------------

describe('lowering', () => {
  it('turns an entry chain into a main function', () => {
    const { project, file, graph, builder } = scratchProject();
    const entry = builder.add('entry/main');
    const literal = builder.add('data/literal', { type: 'string', value: 'hi' });
    const print = builder.add('io/print');
    builder.connect(literal, 'value', print, 'v');
    builder.chain(entry, print);

    const { module, diagnostics } = lowerGraph(graph, file, project, nodes, { language: 'python' });
    assert.equal(diagnostics.errors.length, 0, diagnostics.format());
    const main = findFunction(module.decls, (d) => d.isEntry === true, 'an entry function');
    assert.equal(main.body.length, 1);
  });

  it('lets a function body read the function node\'s own parameters', () => {
    const { project, file, graph, builder } = scratchProject();
    const fn = builder.add('entry/function', {
      name: 'shout',
      params: [{ name: 'text', type: 'string' }],
      returns: 'string',
    });
    const upper = builder.add('string/upper');
    const ret = builder.add('control/return');
    builder.connect(fn, 'p:text', upper, 'a0');
    builder.connect(upper, 'text', ret, 'value');
    builder.chain([fn, 'out'], ret);

    const { diagnostics, module } = lowerGraph(graph, file, project, nodes, { language: 'python' });
    // Reading a parameter from inside the body is nesting, not a cycle.
    assert.equal(diagnostics.errors.length, 0, diagnostics.format());
    const decl = findFunction(module.decls, (d) => d.name === 'shout', 'the shout function');
    assert.equal(must(decl.params[0], 'the first parameter').name, 'text');
  });

  it('reports a genuine execution cycle', () => {
    const { project, graph, builder } = scratchProject();
    const a = builder.add('data/comment', { text: 'a' });
    const b = builder.add('data/comment', { text: 'b' });
    builder.connect(a, 'out', b, 'in');
    builder.connect(b, 'out', a, 'in');

    const { diagnostics } = validateGraph(graph, project, nodes, 'python');
    assert.ok(diagnostics.errors.some((d) => d.code === 'graph/exec-cycle'), diagnostics.format());
  });

  it('rejects two sources on one data input', () => {
    const { project, graph, builder } = scratchProject();
    const print = builder.add('io/print');
    const one = builder.add('data/literal', { type: 'string', value: 'a' });
    const two = builder.add('data/literal', { type: 'string', value: 'b' });
    // Bypass the builder's replace-on-connect so the invalid state can be tested.
    graph.edges.push(
      { id: 'e1', from: { node: one.id, port: 'value' }, to: { node: print.id, port: 'v' } },
      { id: 'e2', from: { node: two.id, port: 'value' }, to: { node: print.id, port: 'v' } },
    );
    const { diagnostics } = validateGraph(graph, project, nodes, 'python');
    assert.ok(diagnostics.errors.some((d) => d.code === 'graph/multiple-data-in'));
  });

  it('rejects an incompatible connection and names both types', () => {
    const { project, graph, builder } = scratchProject();
    const text = builder.add('data/literal', { type: 'string', value: 'x' });
    const loop = builder.add('control/for-range');
    builder.connect(text, 'value', loop, 'start');
    const { diagnostics } = validateGraph(graph, project, nodes, 'python');
    const error = diagnostics.errors.find((d) => d.code === 'type/incompatible-connection');
    assert.ok(error, diagnostics.format());
    assert.match(error.message, /string/);
    assert.match(error.message, /i64/);
  });

  it('scopes duplicate declarations to their class', () => {
    const { project, graph, builder } = scratchProject();
    for (const className of ['Notes', 'Modules']) {
      builder.add('oop/class', { name: className, shape: 'class', fields: [] });
      builder.add('oop/method', { className, name: 'find' });
    }
    assert.ok(!validateGraph(graph, project, nodes, 'python').diagnostics.errors.some((d) => d.code === 'graph/duplicate-declaration'));

    builder.add('oop/method', { className: 'Notes', name: 'find' });
    const { diagnostics } = validateGraph(graph, project, nodes, 'python');
    const error = diagnostics.errors.find((d) => d.code === 'graph/duplicate-declaration');
    assert.ok(error, diagnostics.format());
    assert.match(error.message, /Notes\.find/);
  });

  it('records the capabilities a graph needs', () => {
    const { project, file, graph, builder } = scratchProject();
    const entry = builder.add('entry/main');
    const read = builder.addWith('file/read', { a0: 'data.txt' });
    builder.chain(entry, read);

    const lowered = lowerGraph(graph, file, project, nodes, { language: 'python' });
    assert.ok(lowered.capabilities.has('fs.read'));
    const program = { name: 'x', language: 'python', modules: [lowered.module], dependencies: [] };
    assert.ok(collectCapabilities(program).has('fs.read'));
  });

  it('gives every IR construct an origin pointing back at its node', () => {
    const { project, file, graph, builder } = scratchProject();
    const entry = builder.add('entry/main');
    const print = builder.add('io/print');
    builder.chain(entry, print);

    const { module } = lowerGraph(graph, file, project, nodes, { language: 'python' });
    const main = findFunction(module.decls, (d) => d.isEntry === true, 'an entry function');
    assert.equal(main.origin?.nodeId, entry.id);
    assert.equal(must(main.body[0], 'the first statement').origin?.nodeId, print.id);
  });
});
