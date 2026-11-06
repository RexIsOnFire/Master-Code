/**
 * Project templates.
 *
 * A template is a function that builds a starting project, not a bundle of
 * files to copy. That matters: everything a template produces is an ordinary
 * graph the user can pull apart, and a template cannot express anything the
 * user could not have drawn. If templates were the mechanism rather than a
 * convenience, this would be a template tool - which is the thing the design
 * is specifically not.
 */

import type { NodeRegistry } from '../nodes/definition.ts';
import type { GraphStyle, Project } from '../model/project.ts';
import { emptyUiDocument } from '../model/ui.ts';
import type { UiDocument } from '../model/ui.ts';
import { GraphBuilder, addDependency, addFile, addModule, autoLayoutProject, grant, newProject } from './builder.ts';
import type { NewProjectOptions } from './builder.ts';

export interface TemplateContext {
  registry: NodeRegistry;
  options: NewProjectOptions;
}

export interface ProjectTemplate {
  id: string;
  language: string;
  title: string;
  description: string;
  /** Shown in the new-project dialog as a rough shape of the result. */
  outline: string[];
  architecture?: 'monolithic' | 'modular';
  styles?: GraphStyle[];
  build(ctx: TemplateContext): Project;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const pythonCli: ProjectTemplate = {
  id: 'python/cli',
  language: 'python',
  title: 'Command-line application',
  description:
    'Reads arguments and standard input, does some work, prints a result. The starting graph greets a name and reports how long it is.',
  outline: ['src/main.py', 'src/greeting.py', 'tests/test_greeting.py', 'requirements.txt'],
  build({ registry, options }) {
    const project = newProject({ ...options, language: 'python', template: 'python/cli' });

    // A helper module, so the template demonstrates a real cross-file import
    // rather than a single file pretending to be a project.
    const greeting = addFile(project, {
      path: 'src/greeting.py',
      language: 'python',
      role: 'source',
      graph: { name: 'greeting', style: 'functional' },
    });
    const g = new GraphBuilder(project, registry, greeting.graph!);
    const fn = g.add('entry/function', {
      name: 'build_greeting',
      params: [{ name: 'who', type: 'string' }],
      returns: 'string',
      doc: 'Compose a greeting for the given name.',
    });
    const format = g.addWith('string/format', { a0: 'Hello, {}!' });
    const ret = g.add('control/return');
    g.connect(fn, 'p:who', format, 'v');
    g.connect(format, 'text', ret, 'value');
    g.chain([fn, 'out'], ret);

    const main = addFile(project, {
      path: 'src/main.py',
      language: 'python',
      role: 'entry',
      kind: 'hybrid',
      graph: { name: 'main', style: 'procedural' },
    });
    const m = new GraphBuilder(project, registry, main.graph!);
    const entry = m.add('entry/main');
    const args = m.add('env/args');
    const first = m.add('list/get');
    const zero = m.add('data/literal', { type: 'i64', value: 0 });
    const count = m.add('list/length');
    const hasArg = m.add('op/compare', { op: '>' });
    const none = m.add('data/literal', { type: 'i64', value: 0 });
    const branch = m.add('control/if');
    const call = m.add('control/call', { target: 'build_greeting', returns: 'string' });
    const fallback = m.add('data/literal', { type: 'string', value: 'world' });
    const callDefault = m.add('control/call', { target: 'build_greeting', returns: 'string' });
    const printOut = m.add('io/print');
    const printDefault = m.add('io/print');

    m.connect(args, 'args', count, 'a0');
    m.connect(count, 'length', hasArg, 'a');
    m.connect(none, 'value', hasArg, 'b');
    m.connect(hasArg, 'result', branch, 'cond');
    m.connect(args, 'args', first, 'a0');
    m.connect(zero, 'value', first, 'a1');
    m.connect(first, 'item', call, 'args');
    m.connect(call, 'result', printOut, 'v');
    m.connect(fallback, 'value', callDefault, 'args');
    m.connect(callDefault, 'result', printDefault, 'v');
    m.chain(entry, branch);
    m.chain([branch, 'then'], call, printOut);
    m.chain([branch, 'else'], callDefault, printDefault);

    const tests = addFile(project, {
      path: 'tests/test_greeting.py',
      language: 'python',
      role: 'test',
      graph: { name: 'greeting tests', style: 'procedural' },
    });
    const t = new GraphBuilder(project, registry, tests.graph!);
    const test = t.add('test/case', { name: 'test_greeting_includes_name', kind: 'unit' });
    const who = t.add('data/literal', { type: 'string', value: 'Ada' });
    const invoke = t.add('control/call', { target: 'build_greeting', returns: 'string' });
    const expected = t.add('data/literal', { type: 'string', value: 'Hello, Ada!' });
    const assertEq = t.add('test/assert-equal', { message: 'greeting should name the person' });
    t.connect(who, 'value', invoke, 'args');
    t.connect(invoke, 'result', assertEq, 'actual');
    t.connect(expected, 'value', assertEq, 'expected');
    t.chain([test, 'out'], invoke, assertEq);

    return project;
  },
};

const pythonPipeline: ProjectTemplate = {
  id: 'python/pipeline',
  language: 'python',
  title: 'Data-processing pipeline',
  description:
    'Source, transform, filter, aggregate, sink - built as a data-flow graph rather than an execution chain.',
  outline: ['src/main.py', 'requirements.txt'],
  styles: ['dataflow', 'pipeline'],
  build({ registry, options }) {
    const project = newProject({ ...options, language: 'python', template: 'python/pipeline' });
    const main = addFile(project, {
      path: 'src/main.py',
      language: 'python',
      role: 'entry',
      graph: { name: 'pipeline', style: 'pipeline' },
    });
    const g = new GraphBuilder(project, registry, main.graph!);
    const entry = g.add('entry/main');
    const source = g.add('pipeline/source', { kind: 'range', start: 1, end: 21 });
    const square = g.add('fn/lambda', { params: [{ name: 'n', type: 'i64' }], returns: 'i64' });
    const mul = g.add('op/arithmetic', { op: '*' });
    const transform = g.add('pipeline/transform');
    const even = g.add('fn/lambda', { params: [{ name: 'n', type: 'i64' }], returns: 'bool' });
    const mod = g.add('op/arithmetic', { op: '%' });
    const two = g.add('data/literal', { type: 'i64', value: 2 });
    const zero = g.add('data/literal', { type: 'i64', value: 0 });
    const isZero = g.add('op/compare', { op: '==' });
    const filter = g.add('pipeline/filter');
    const total = g.add('pipeline/aggregate', { op: 'sum' });
    const sink = g.add('pipeline/sink', { target: 'console', label: 'sum of even squares:' });

    g.connect(square, 'p:n', mul, 'a');
    g.connect(square, 'p:n', mul, 'b');
    g.connect(mul, 'result', square, 'result');
    g.connect(even, 'p:n', mod, 'a');
    g.connect(two, 'value', mod, 'b');
    g.connect(mod, 'result', isZero, 'a');
    g.connect(zero, 'value', isZero, 'b');
    g.connect(isZero, 'result', even, 'result');

    g.connect(source, 'items', transform, 'items');
    g.connect(square, 'fn', transform, 'fn');
    g.connect(transform, 'items', filter, 'items');
    g.connect(even, 'fn', filter, 'fn');
    g.connect(filter, 'items', total, 'items');
    g.connect(total, 'value', sink, 'value');
    g.chain(entry, sink);
    return project;
  },
};

const pythonApi: ProjectTemplate = {
  id: 'python/api',
  language: 'python',
  title: 'REST API service',
  description:
    'A modular service with routing, a handler module and a storage module. Flask is recorded as a dependency; install it when you are ready.',
  outline: ['src/main.py', 'src/api/routes.py', 'src/storage/repository.py', 'requirements.txt'],
  architecture: 'modular',
  build({ registry, options }) {
    const project = newProject({
      ...options,
      language: 'python',
      architecture: 'modular',
      template: 'python/api',
    });
    addDependency(project, {
      name: 'flask',
      version: '3.0.3',
      language: 'python',
      manager: 'pip',
      license: 'BSD-3-Clause',
      source: 'https://pypi.org/project/Flask/',
    });
    grant(project, 'net');

    const apiModule = addModule(project, {
      name: 'api',
      directory: 'src/api',
      description: 'HTTP surface: routing and request handling.',
    });
    const storageModule = addModule(project, {
      name: 'storage',
      directory: 'src/storage',
      description: 'Persistence. The rest of the app talks to this, never to SQL.',
    });
    apiModule.dependencies.push(storageModule.id);

    const repo = addFile(project, {
      path: 'src/storage/repository.py',
      language: 'python',
      moduleId: storageModule.id,
      graph: { name: 'repository', style: 'object-oriented' },
    });
    const r = new GraphBuilder(project, registry, repo.graph!);
    r.add('oop/class', {
      name: 'Repository',
      shape: 'class',
      doc: 'In-memory store. Swap the body for a database when you need one.',
      fields: [{ name: 'items', type: 'List<Map<string, Any>>', visibility: 'public' }],
    });
    const ctor = r.add('oop/constructor', { className: 'Repository', params: [] });
    const addItem = r.add('oop/method', {
      className: 'Repository',
      name: 'add',
      params: [{ name: 'item', type: 'Map<string, Any>' }],
      returns: 'Void',
      doc: 'Store one item.',
    });
    const push = r.add('list/push');
    const itemsField = r.add('oop/get-field', { field: 'items', type: 'List<Map<string, Any>>' });
    r.connect(addItem, 'self', itemsField, 'target');
    r.connect(itemsField, 'value', push, 'a0');
    r.connect(addItem, 'p:item', push, 'a1');
    r.chain([addItem, 'out'], push);
    void ctor;

    storageModule.interface.push({ name: 'Repository', kind: 'class', doc: 'Item storage.' });

    const routes = addFile(project, {
      path: 'src/api/routes.py',
      language: 'python',
      moduleId: apiModule.id,
      kind: 'hybrid',
      graph: { name: 'routes', style: 'event-driven' },
    });
    const a = new GraphBuilder(project, registry, routes.graph!);
    const handler = a.add('entry/function', {
      name: 'list_items',
      params: [{ name: 'store', type: 'Repository' }],
      returns: 'List<Map<string, Any>>',
      doc: 'GET /items - every stored item.',
    });
    const field = a.add('oop/get-field', { field: 'items', type: 'List<Map<string, Any>>' });
    const ret = a.add('control/return');
    a.connect(handler, 'p:store', field, 'target');
    a.connect(field, 'value', ret, 'value');
    a.chain([handler, 'out'], ret);
    apiModule.interface.push({ name: 'list_items', kind: 'function', doc: 'GET /items handler.' });

    const main = addFile(project, {
      path: 'src/main.py',
      language: 'python',
      role: 'entry',
      kind: 'hybrid',
      graph: { name: 'main', style: 'procedural' },
    });
    const m = new GraphBuilder(project, registry, main.graph!);
    const entry = m.add('entry/main');
    const store = m.add('oop/new', { className: 'Repository' });
    const seed = m.add('map/literal', { keyType: 'string', valueType: 'Any' });
    const key = m.add('data/literal', { type: 'string', value: 'name' });
    const value = m.add('data/literal', { type: 'string', value: 'first item' });
    const addCall = m.add('oop/call-method', { method: 'add', returns: 'Void' });
    const listCall = m.add('control/call', { target: 'list_items', returns: 'List<Map<string, Any>>' });
    const show = m.add('io/print');
    m.connect(key, 'value', seed, 'k');
    m.connect(value, 'value', seed, 'v');
    m.connect(store, 'instance', addCall, 'target');
    m.connect(seed, 'map', addCall, 'a');
    m.connect(store, 'instance', listCall, 'args');
    m.connect(listCall, 'result', show, 'v');
    m.chain(entry, store, addCall, listCall, show);

    return project;
  },
};

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

function dashboardDocument(scriptId: string, styleId: string): UiDocument {
  const doc = emptyUiDocument('Dashboard');
  doc.scripts = [scriptId];
  doc.stylesheets = [styleId];
  doc.root = [
    {
      id: 'header',
      kind: 'panel',
      classes: ['header'],
      children: [{ id: 'title', kind: 'heading', text: 'Dashboard', attrs: { level: '1' } }],
    },
    {
      id: 'main',
      kind: 'grid',
      classes: ['cards'],
      children: [
        {
          id: 'counter-card',
          kind: 'card',
          children: [
            { id: 'counter-label', kind: 'label', name: 'counterLabel', text: '0' },
            { id: 'increment', kind: 'button', name: 'increment', text: 'Add one', events: [{ event: 'click', handler: 'onIncrement' }] },
          ],
        },
        {
          id: 'echo-card',
          kind: 'card',
          children: [
            { id: 'echo-input', kind: 'textbox', name: 'echoInput', attrs: { placeholder: 'Type something' } },
            { id: 'echo-output', kind: 'paragraph', name: 'echoOutput', text: '' },
            { id: 'echo-button', kind: 'button', name: 'echoButton', text: 'Echo', events: [{ event: 'click', handler: 'onEcho' }] },
          ],
        },
      ],
    },
    { id: 'footer', kind: 'panel', classes: ['footer'], children: [{ id: 'note', kind: 'label', text: 'Built with Master Code.' }] },
  ];
  doc.rules = [
    { selector: ':root', declarations: { '--surface': '#ffffff', '--ink': '#1a1a1a', '--accent': '#2563eb', '--line': '#e2e8f0' } },
    {
      selector: 'body',
      declarations: {
        margin: '0',
        'font-family': 'system-ui, sans-serif',
        color: 'var(--ink)',
        background: '#f8fafc',
      },
    },
    { selector: '.header', declarations: { padding: '24px', background: 'var(--surface)', 'border-bottom': '1px solid var(--line)' } },
    { selector: '.cards', declarations: { display: 'grid', 'grid-template-columns': 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', padding: '24px' } },
    { selector: 'article', declarations: { background: 'var(--surface)', border: '1px solid var(--line)', 'border-radius': '10px', padding: '16px' } },
    { selector: 'button', declarations: { background: 'var(--accent)', color: '#fff', border: '0', padding: '8px 14px', 'border-radius': '6px', cursor: 'pointer' } },
    { selector: '.footer', declarations: { padding: '16px 24px', color: '#64748b', 'font-size': '14px' } },
    { selector: '.cards', media: '(max-width: 640px)', declarations: { 'grid-template-columns': '1fr', padding: '12px' } },
  ];
  return doc;
}

const webDashboard: ProjectTemplate = {
  id: 'web/dashboard',
  language: 'html',
  title: 'Interactive dashboard',
  description:
    'A page built in the UI designer, styled by a generated stylesheet, with behaviour from an event-driven JavaScript graph.',
  outline: ['index.html', 'styles.css', 'src/app.js'],
  styles: ['event-driven', 'component'],
  build({ registry, options }) {
    const project = newProject({ ...options, language: 'html', template: 'web/dashboard' });

    const style = addFile(project, { path: 'styles.css', language: 'css', role: 'source' });
    const script = addFile(project, {
      path: 'src/app.js',
      language: 'javascript',
      role: 'source',
      kind: 'hybrid',
      graph: { name: 'page behaviour', style: 'event-driven' },
    });
    const page = addFile(project, {
      path: 'index.html',
      language: 'html',
      role: 'entry',
      options: { ui: dashboardDocument(script.file.id, style.file.id) },
    });
    void page;

    const g = new GraphBuilder(project, registry, script.graph!);
    g.variable('count', 'i64', 0, 'module');

    const ready = g.add('dom/on-ready');
    const note = g.add('data/comment', { text: 'Handlers are attached from the markup by data-mcode-events.' });
    g.chain([ready, 'out'], note);

    const onIncrement = g.add('event/handler', { event: 'onIncrement', payloadType: 'Any' });
    const readCount = g.add('data/variable-get', { name: 'count' });
    const one = g.add('data/literal', { type: 'i64', value: 1 });
    const add = g.add('op/arithmetic', { op: '+' });
    const setCount = g.add('data/variable-set', { name: 'count' });
    const label = g.addWith('dom/query', { a0: '#counter-label' });
    const asText = g.add('convert/to-string');
    const setText = g.add('dom/set-text');
    g.connect(readCount, 'value', add, 'a');
    g.connect(one, 'value', add, 'b');
    g.connect(add, 'result', setCount, 'value');
    g.connect(setCount, 'out_value', asText, 'a0');
    g.connect(label, 'element', setText, 'a0');
    g.connect(asText, 'text', setText, 'a1');
    g.chain([onIncrement, 'out'], setCount, label, setText);

    const onEcho = g.add('event/handler', { event: 'onEcho', payloadType: 'Any' });
    const input = g.addWith('dom/query', { a0: '#echo-input' });
    const readValue = g.add('dom/get-value');
    const output = g.addWith('dom/query', { a0: '#echo-output' });
    const echoText = g.add('dom/set-text');
    g.connect(input, 'element', readValue, 'a0');
    g.connect(output, 'element', echoText, 'a0');
    g.connect(readValue, 'value', echoText, 'a1');
    g.chain([onEcho, 'out'], input, readValue, output, echoText);

    return project;
  },
};

const webStatic: ProjectTemplate = {
  id: 'web/static',
  language: 'html',
  title: 'Static website',
  description: 'A page and a stylesheet, no scripting. The smallest useful web project.',
  outline: ['index.html', 'styles.css'],
  build({ options }) {
    const project = newProject({ ...options, language: 'html', template: 'web/static' });
    const style = addFile(project, { path: 'styles.css', language: 'css', role: 'source' });
    const doc = emptyUiDocument(options.name);
    doc.stylesheets = [style.file.id];
    doc.root = [
      {
        id: 'page',
        kind: 'container',
        classes: ['page'],
        children: [
          { id: 'title', kind: 'heading', text: options.name, attrs: { level: '1' } },
          { id: 'intro', kind: 'paragraph', text: 'Edit this page in the UI designer.' },
        ],
      },
    ];
    doc.rules = [
      { selector: 'body', declarations: { margin: '0', 'font-family': 'system-ui, sans-serif', color: '#1a1a1a' } },
      { selector: '.page', declarations: { 'max-width': '720px', margin: '0 auto', padding: '48px 24px' } },
    ];
    addFile(project, { path: 'index.html', language: 'html', role: 'entry', options: { ui: doc } });
    return project;
  },
};

const nodeCli: ProjectTemplate = {
  id: 'javascript/cli',
  language: 'javascript',
  title: 'Node command-line tool',
  description: 'An ES-module program that reads arguments and prints a result.',
  outline: ['src/main.js', 'package.json'],
  build({ registry, options }) {
    const project = newProject({ ...options, language: 'javascript', template: 'javascript/cli' });
    const main = addFile(project, {
      path: 'src/main.js',
      language: 'javascript',
      role: 'entry',
      kind: 'hybrid',
      graph: { name: 'main', style: 'procedural' },
    });
    const g = new GraphBuilder(project, registry, main.graph!);
    const entry = g.add('entry/main');
    const args = g.add('env/args');
    const count = g.add('list/length');
    const message = g.addWith('string/format', { a0: 'Received {} argument(s).' });
    const print = g.add('io/print');
    g.connect(args, 'args', count, 'a0');
    g.connect(count, 'length', message, 'v');
    g.connect(message, 'text', print, 'v');
    g.chain(entry, print);
    return project;
  },
};

// ---------------------------------------------------------------------------
// A shared "hello" template for the remaining languages
// ---------------------------------------------------------------------------

function helloTemplate(spec: {
  id: string;
  language: string;
  title: string;
  entryPath: string;
  outline: string[];
  namespace?: string;
  description?: string;
}): ProjectTemplate {
  return {
    id: spec.id,
    language: spec.language,
    title: spec.title,
    description:
      spec.description ??
      `A minimal ${spec.title} project: one entry point that composes a message and prints it. Everything after that is yours.`,
    outline: spec.outline,
    build({ registry, options }) {
      const project = newProject({
        ...options,
        language: spec.language,
        template: spec.id,
        namespace: options.namespace ?? spec.namespace,
      });
      const main = addFile(project, {
        path: spec.entryPath,
        language: spec.language,
        role: 'entry',
        kind: 'hybrid',
        graph: { name: 'main', style: 'procedural' },
      });
      const g = new GraphBuilder(project, registry, main.graph!);
      const entry = g.add('entry/main');
      const name = g.add('data/literal', { type: 'string', value: options.name });
      const message = g.addWith('string/format', { a0: 'Hello from {}.' });
      const print = g.add('io/print');
      g.connect(name, 'value', message, 'v');
      g.connect(message, 'text', print, 'v');
      g.chain(entry, print);
      return project;
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const builtinTemplates: ProjectTemplate[] = [
  pythonCli,
  pythonPipeline,
  pythonApi,
  webDashboard,
  webStatic,
  nodeCli,
  helloTemplate({
    id: 'java/cli',
    language: 'java',
    title: 'Java command-line application',
    entryPath: 'src/main/java/app/Main.java',
    outline: ['src/main/java/app/Main.java', 'pom.xml'],
    namespace: 'app',
  }),
  helloTemplate({
    id: 'kotlin/cli',
    language: 'kotlin',
    title: 'Kotlin command-line application',
    entryPath: 'src/main/kotlin/app/Main.kt',
    outline: ['src/main/kotlin/app/Main.kt', 'build.gradle.kts', 'settings.gradle.kts'],
    namespace: 'app',
  }),
  helloTemplate({
    id: 'csharp/console',
    language: 'csharp',
    title: 'C# console application',
    entryPath: 'src/Program.cs',
    outline: ['src/Program.cs', 'Project.csproj'],
  }),
  helloTemplate({
    id: 'go/cli',
    language: 'go',
    title: 'Go command-line application',
    entryPath: 'main.go',
    outline: ['main.go', 'go.mod'],
    namespace: 'example.com/app',
  }),
  helloTemplate({
    id: 'rust/cli',
    language: 'rust',
    title: 'Rust command-line application',
    entryPath: 'src/main.rs',
    outline: ['src/main.rs', 'Cargo.toml'],
  }),
  helloTemplate({
    id: 'cpp/cli',
    language: 'cpp',
    title: 'C++ command-line application',
    entryPath: 'src/main.cpp',
    outline: ['src/main.cpp', 'src/main.hpp', 'CMakeLists.txt'],
  }),
  helloTemplate({
    id: 'c/cli',
    language: 'c',
    title: 'C command-line application',
    entryPath: 'src/main.c',
    outline: ['src/main.c', 'src/main.h', 'CMakeLists.txt'],
  }),

  // Start from nothing. Entry paths match each backend's declared `entry.file`
  // so a blank project lands where that language expects its entry point,
  // rather than somewhere the build plan then cannot find.
  ...[
    ['python', 'src/main.py'],
    ['javascript', 'src/main.js'],
    ['java', 'src/main/java/app/Main.java'],
    ['kotlin', 'src/main/kotlin/app/Main.kt'],
    ['csharp', 'src/Program.cs'],
    ['go', 'main.go'],
    ['rust', 'src/main.rs'],
    ['cpp', 'src/main.cpp'],
    ['c', 'src/main.c'],
  ].map(([language, entryPath]) => emptyTemplate(language!, entryPath!)),
  emptyPage(),
];

/** A blank HTML page: an empty UI document and a stylesheet, nothing drawn. */
function emptyPage(): ProjectTemplate {
  return {
    id: 'html/empty',
    language: 'html',
    title: 'Empty page',
    description: 'A blank page and stylesheet. Build the UI in the designer.',
    outline: ['index.html', 'styles.css'],
    build({ options }) {
      const project = newProject({ ...options, language: 'html', template: 'html/empty' });
      const doc: UiDocument = { ...emptyUiDocument(options.name), stylesheets: ['styles.css'] };
      addFile(project, { path: 'index.html', language: 'html', role: 'entry', options: { ui: doc } });
      addFile(project, { path: 'styles.css', language: 'css', role: 'source' });
      return project;
    },
  };
}

/** An empty project with a single entry file, for every supported language. */
export function emptyTemplate(language: string, entryPath: string): ProjectTemplate {
  return {
    id: `${language}/empty`,
    language,
    title: 'Empty project',
    description: 'One entry file with a Main node and nothing else.',
    outline: [entryPath],
    build({ registry, options }) {
      const project = newProject({ ...options, language, template: `${language}/empty` });
      const main = addFile(project, {
        path: entryPath,
        language,
        role: 'entry',
        kind: 'hybrid',
        graph: { name: 'main', style: 'procedural' },
      });
      new GraphBuilder(project, registry, main.graph!).add('entry/main');
      return project;
    },
  };
}

export class TemplateRegistry {
  private readonly byId = new Map<string, ProjectTemplate>();

  constructor(templates: ProjectTemplate[] = builtinTemplates) {
    for (const t of templates) this.register(t);
  }

  /**
   * Register a template, wrapping it so every graph it produces is laid out by
   * dependency order. Doing it here rather than in each template means a plugin
   * author gets sensible positions for free instead of hand-placing nodes.
   */
  register(template: ProjectTemplate): void {
    this.byId.set(template.id, {
      ...template,
      build: (ctx) => {
        const project = template.build(ctx);
        autoLayoutProject(project, ctx.registry);
        return project;
      },
    });
  }

  get(id: string): ProjectTemplate | undefined {
    return this.byId.get(id);
  }

  all(): ProjectTemplate[] {
    return [...this.byId.values()];
  }

  forLanguage(language: string): ProjectTemplate[] {
    return this.all().filter((t) => t.language === language);
  }

  languages(): string[] {
    return [...new Set(this.all().map((t) => t.language))].sort();
  }
}

export function createDefaultTemplates(): TemplateRegistry {
  return new TemplateRegistry();
}
