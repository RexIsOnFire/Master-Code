/**
 * The Kotlin backend: the parts of Kotlin the shared matrices do not reach.
 *
 * Collections, text operations and recursion are checked against Python in
 * their own suites. What is here is what makes Kotlin unlike the others - the
 * class model (data classes, primary constructors, `object`, sealed types,
 * `override`), annotations, file-level imports across packages, and Gradle and
 * Android project generation - plus the refusals other languages owe a graph
 * that uses those features.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

import { buildAndRun, must } from './helpers.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { generate } from '#core/codegen/generate.ts';
import { GraphBuilder, addDependency, addFile, newProject } from '#core/project/builder.ts';
import { probeTool, runCommand } from '#core/runtime/exec.ts';
import type { KotlinSettings } from '#core/backends/kotlin.ts';
import type { Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const backends = createDefaultBackends();

function fileContent(project: Project, path: string): string {
  const result = generate(project, { nodes, backends });
  assert.deepEqual(result.diagnostics.errors.map((d) => `${d.code}: ${d.message}`), []);
  return must(result.files.find((f) => f.path === path), path).content;
}

/** Shapes, a sealed event type and a counter object, used from a Custom Function. */
function classModel(): Project {
  const project = newProject({ name: 'Shapes', language: 'kotlin', namespace: 'app' });
  const model = addFile(project, {
    path: 'src/main/kotlin/app/model/Shapes.kt',
    language: 'kotlin',
    graph: { name: 'shapes', style: 'object-oriented' },
  });
  const m = new GraphBuilder(project, nodes, must(model.graph, 'model graph'));
  m.add('oop/class', {
    name: 'Point',
    shape: 'record',
    fields: [
      { name: 'x', type: 'i64', readonly: true },
      { name: 'y', type: 'i64', readonly: true },
    ],
  });
  m.add('oop/interface', { name: 'Shape', methods: [{ name: 'area', params: [], returns: 'f64' }] });
  m.add('oop/class', {
    name: 'Square',
    implements: 'Shape',
    fields: [{ name: 'side', type: 'f64', readonly: true, visibility: 'private' }],
  });
  m.add('oop/constructor', { className: 'Square', params: [{ name: 'side', type: 'f64' }] });
  m.add('custom/function', {
    className: 'Square',
    name: 'area',
    returns: 'f64',
    language: 'kotlin',
    code: 'return side * side',
  });
  m.add('custom/function', {
    className: 'Square',
    name: 'toString',
    returns: 'string',
    isOverride: true,
    language: 'kotlin',
    form: 'expression',
    code: '"Square(" + side + ")"',
  });
  m.add('oop/enum', {
    name: 'Event',
    variants: [{ name: 'Started', payload: [{ name: 'at', type: 'i64' }] }, 'Stopped'],
  });
  m.add('oop/class', { name: 'Counter', fields: [{ name: 'count', type: 'i64', static: true }] });
  m.add('custom/function', {
    className: 'Counter',
    name: 'next',
    isStatic: true,
    returns: 'i64',
    language: 'kotlin',
    code: 'count += 1\nreturn count',
  });

  const main = addFile(project, {
    path: 'src/main/kotlin/app/Main.kt',
    language: 'kotlin',
    role: 'entry',
    graph: { name: 'main' },
  });
  const g = new GraphBuilder(project, nodes, must(main.graph, 'main graph'));
  g.add('module/imports', {
    imports: ['app.model.Counter', 'app.model.Event', 'app.model.Point', 'app.model.Shape', 'app.model.Square'],
  });
  g.add('custom/function', {
    name: 'describe',
    params: [{ name: 'event', type: 'Event' }],
    returns: 'string',
    language: 'kotlin',
    code: [
      'return when (event) {',
      '    is Event.Started -> "started at " + event.at',
      '    Event.Stopped -> "stopped"',
      '}',
    ].join('\n'),
  });
  const entry = g.add('entry/main');
  const run = g.add('custom/code', {
    name: 'demo',
    language: 'kotlin',
    code: [
      'val p = Point(3, 4)',
      'println(p == Point(3, 4))',
      'println(p.copy(y = 9))',
      'val s: Shape = Square(1.5)',
      'println(s.area())',
      'println(s)',
      'println(describe(Event.Started(7)) + ", " + describe(Event.Stopped))',
      'Counter.next()',
      'println(Counter.next())',
    ].join('\n'),
  });
  g.chain(entry, run);
  return project;
}

describe('Kotlin classes', () => {
  it('declares records as data classes and folds copied parameters into the constructor', () => {
    const source = fileContent(classModel(), 'src/main/kotlin/app/model/Shapes.kt');
    assert.match(source, /^package app\.model$/m);
    assert.match(source, /^data class Point\(val x: Long, val y: Long\)$/m);
    assert.match(source, /^class Square\(private val side: Double\) : Shape \{$/m);
    assert.match(source, /^ {4}override fun area\(\): Double \{$/m, 'implementing an interface member is an override');
    assert.match(source, /^ {4}override fun toString\(\): String \{$/m, 'isOverride covers supertypes outside the program');
    assert.match(source, /^sealed interface Event \{$/m);
    assert.match(source, /^ {4}data class Started\(val at: Long\) : Event$/m);
    assert.match(source, /^ {4}data object Stopped : Event$/m);
    assert.match(source, /^object Counter \{$/m, 'a class of only static members is an object');
  });

  it('compiles and runs what it declares', async (t) => {
    if (!(await probeTool('kotlinc', ['-version'])).available) return t.skip('kotlinc is not installed');
    const output = await buildAndRun(classModel(), 'kotlin', { nodes, backends });
    assert.equal(output, ['true', 'Point(x=3, y=9)', '2.25', 'Square(1.5)', 'started at 7, stopped', '2'].join('\n'));
  });
});

describe('Kotlin imports', () => {
  it('imports declared library names, and drops what Kotlin imports implicitly', () => {
    const project = newProject({ name: 'Imports', language: 'kotlin', namespace: 'app' });
    const file = addFile(project, { path: 'src/main/kotlin/app/ui/Screen.kt', language: 'kotlin', graph: { name: 'ui' } });
    const g = new GraphBuilder(project, nodes, must(file.graph, 'graph'));
    g.add('module/imports', { imports: ['androidx.compose.runtime.Composable', 'kotlin.collections.List', 'app.ui.Local'] });
    g.add('custom/function', { name: 'screen', annotations: ['Composable'], language: 'kotlin', code: '' });
    const source = fileContent(project, 'src/main/kotlin/app/ui/Screen.kt');
    assert.match(source, /^import androidx\.compose\.runtime\.Composable$/m);
    assert.doesNotMatch(source, /import kotlin\.collections/, 'default imports are implicit');
    assert.doesNotMatch(source, /import app\.ui\./, 'nothing is imported from the same package');
    assert.match(source, /^@Composable\nfun screen\(\) \{$/m);
  });

  it('imports a project type from another package where a signature uses it', () => {
    const project = newProject({ name: 'Cross', language: 'kotlin', namespace: 'app' });
    const a = addFile(project, { path: 'src/main/kotlin/app/data/Note.kt', language: 'kotlin', graph: { name: 'a' } });
    new GraphBuilder(project, nodes, must(a.graph, 'a')).add('oop/class', {
      name: 'Note',
      shape: 'record',
      fields: [{ name: 'body', type: 'string', readonly: true }],
    });
    const b = addFile(project, { path: 'src/main/kotlin/app/ui/Show.kt', language: 'kotlin', graph: { name: 'b' } });
    new GraphBuilder(project, nodes, must(b.graph, 'b')).add('custom/function', {
      name: 'show',
      params: [{ name: 'note', type: 'Note' }],
      returns: 'string',
      language: 'kotlin',
      form: 'expression',
      code: 'note.body',
    });
    const source = fileContent(project, 'src/main/kotlin/app/ui/Show.kt');
    assert.match(source, /^import app\.data\.Note$/m);
    assert.match(source, /^fun show\(note: Note\): String \{$/m);
  });
});

describe('Kotlin type names', () => {
  it('re-cases only the types the program declares, never a library type', () => {
    const project = newProject({ name: 'Names', language: 'kotlin', namespace: 'app' });
    const file = addFile(project, { path: 'src/main/kotlin/app/Io.kt', language: 'kotlin', graph: { name: 'io' } });
    const g = new GraphBuilder(project, nodes, must(file.graph, 'graph'));
    g.add('oop/class', { name: 'http_result', shape: 'record', fields: [{ name: 'code', type: 'i64', readonly: true }] });
    g.add('custom/function', {
      name: 'describe',
      params: [
        { name: 'failure', type: 'IOException' },
        { name: 'result', type: 'http_result' },
      ],
      returns: 'string',
      language: 'kotlin',
      form: 'expression',
      code: 'failure.toString()',
    });
    const source = fileContent(project, 'src/main/kotlin/app/Io.kt');
    assert.match(source, /^data class HttpResult\(val code: Long\)$/m, 'a declared type follows Kotlin naming');
    assert.match(source, /fun describe\(failure: IOException, result: HttpResult\): String/, 'IOException is not "IoException"');
  });

  it('names a composable that emits UI like a type, and any other function like a value', () => {
    const project = newProject({ name: 'Names', language: 'kotlin', namespace: 'app' });
    const file = addFile(project, { path: 'src/main/kotlin/app/Ui.kt', language: 'kotlin', graph: { name: 'ui' } });
    const g = new GraphBuilder(project, nodes, must(file.graph, 'graph'));
    const fn = (name: string, returns: string, annotations: string[]) =>
      g.add('custom/function', { name, returns, annotations, language: 'kotlin', code: returns === 'Void' ? '' : 'return 0L' });
    fn('ChatScreen', 'Void', ['Composable']);
    fn('rememberCount', 'i64', ['Composable']);
    fn('PlainHelper', 'Void', []);
    const source = fileContent(project, 'src/main/kotlin/app/Ui.kt');
    assert.match(source, /^fun ChatScreen\(\) \{/m);
    assert.match(source, /^fun rememberCount\(\): Long \{/m, 'a composable that returns a value is named like a value');
    assert.match(source, /^fun plainHelper\(\) \{/m);
  });

  it('makes a function type nullable as a whole, not its result', () => {
    const project = newProject({ name: 'Names', language: 'kotlin', namespace: 'app' });
    const file = addFile(project, { path: 'src/main/kotlin/app/Callbacks.kt', language: 'kotlin', graph: { name: 'callbacks' } });
    const g = new GraphBuilder(project, nodes, must(file.graph, 'graph'));
    g.add('custom/function', {
      name: 'run',
      params: [
        { name: 'onDone', type: 'Option<() -> Void>' },
        { name: 'lookup', type: 'Option<(string) -> Option<string>>' },
        { name: 'label', type: 'Option<string>' },
      ],
      language: 'kotlin',
      code: 'onDone?.invoke()',
    });
    const source = fileContent(project, 'src/main/kotlin/app/Callbacks.kt');
    assert.match(source, /fun run\(onDone: \(\(\) -> Unit\)\?, lookup: \(\(String\) -> String\?\)\?, label: String\?\)/);
  });
});

describe('features other languages refuse', () => {
  it('refuses annotations in a language that has none, naming the annotation', () => {
    const project = newProject({ name: 'Ann', language: 'go' });
    const file = addFile(project, { path: 'main.go', language: 'go', role: 'entry', graph: { name: 'main' } });
    new GraphBuilder(project, nodes, must(file.graph, 'graph')).add('entry/function', {
      name: 'handler',
      annotations: ['Deprecated'],
    });
    const result = generate(project, { nodes, backends });
    const error = must(
      result.diagnostics.errors.find((d) => d.code === 'codegen/unsupported-feature'),
      'an unsupported-feature error',
    );
    assert.match(error.message, /annotations/);
    assert.match(error.hint ?? '', /@Deprecated/);
  });

  it('refuses enum variants that carry data where the language has no sealed types', () => {
    const project = newProject({ name: 'Sealed', language: 'java', namespace: 'app' });
    const file = addFile(project, { path: 'src/main/java/app/Main.java', language: 'java', role: 'entry', graph: { name: 'main' } });
    new GraphBuilder(project, nodes, must(file.graph, 'graph')).add('oop/enum', {
      name: 'Result',
      variants: [{ name: 'Ok', payload: [{ name: 'value', type: 'i64' }] }, 'Empty'],
    });
    const result = generate(project, { nodes, backends });
    assert.ok(
      result.diagnostics.errors.some((d) => d.code === 'codegen/unsupported-feature' && /carry data/.test(d.message)),
      result.diagnostics.format(),
    );
  });
});

describe('Gradle and Android projects', () => {
  function androidProject(): Project {
    const project = newProject({ name: 'Pocket', language: 'kotlin', namespace: 'com.pocket' });
    const settings: KotlinSettings = {
      modules: [
        {
          path: 'app',
          kind: 'android-application',
          dependsOn: ['core'],
          compose: true,
          testJvmArgs: ['--add-exports=java.base/jdk.internal.access=ALL-UNNAMED'],
          android: {
            namespace: 'com.pocket',
            minSdk: 29,
            targetSdk: 36,
            compileSdk: 37,
            permissions: ['android.permission.INTERNET'],
            application: {
              attributes: { label: '@string/app_name', allowBackup: 'false' },
              children: [
                {
                  tag: 'activity',
                  attributes: { name: '.MainActivity', exported: 'true' },
                  children: [
                    {
                      tag: 'intent-filter',
                      children: [
                        { tag: 'action', attributes: { name: 'android.intent.action.MAIN' } },
                        { tag: 'category', attributes: { name: 'android.intent.category.LAUNCHER' } },
                      ],
                    },
                  ],
                },
              ],
            },
            resources: { 'values/strings.xml': '<resources><string name="app_name">Pocket</string></resources>' },
          },
        },
        { path: 'core', kind: 'jvm-library' },
      ],
    };
    project.extensions = { kotlin: settings };
    const dep = (name: string, version: string, configuration: string, target: string) =>
      addDependency(project, { name, version, language: 'kotlin', manager: 'gradle', configuration, target });
    dep('androidx.compose:compose-bom', '2026.09.00', 'platform:implementation', 'app');
    dep('androidx.compose.material3:material3', '*', 'implementation', 'app');
    dep('androidx.room:room-compiler', '2.8.5', 'ksp', 'app');
    dep('junit:junit', '4.13.2', 'testImplementation', 'app');
    dep('junit:junit', '4.13.2', 'testImplementation', 'core');

    addFile(project, { path: 'app/src/main/kotlin/com/pocket/Main.kt', language: 'kotlin', graph: { name: 'app' } });
    addFile(project, { path: 'core/src/main/kotlin/com/pocket/core/Rules.kt', language: 'kotlin', graph: { name: 'core' } });
    return project;
  }

  it('writes a multi-module build with plugin versions in one place', () => {
    const result = generate(androidProject(), { nodes, backends });
    assert.deepEqual(result.diagnostics.errors.map((d) => d.message), []);
    const file = (path: string) => must(result.files.find((f) => f.path === path), path).content;

    assert.match(file('settings.gradle.kts'), /^include\(":app"\)\ninclude\(":core"\)$/m);
    const root = file('build.gradle.kts');
    assert.match(root, /id\("com\.android\.application"\) version "9\.4\.1" apply false/);
    assert.match(root, /id\("com\.google\.devtools\.ksp"\) version "2\.3\.12" apply false/);
    assert.match(root, /id\("org\.jetbrains\.kotlin\.jvm"\) version "2\.4\.20" apply false/);
    assert.match(root, /id\("org\.jetbrains\.kotlin\.plugin\.compose"\) version "2\.4\.20" apply false/);

    const app = file('app/build.gradle.kts');
    assert.doesNotMatch(app, /version "/, 'module scripts take versions from the root');
    assert.match(app, /compileSdk = 37/);
    assert.match(app, /implementation\(platform\("androidx\.compose:compose-bom:2026\.09\.00"\)\)/);
    assert.match(app, /implementation\("androidx\.compose\.material3:material3"\)/, 'a BOM-managed library has no version');
    assert.match(app, /ksp\("androidx\.room:room-compiler:2\.8\.5"\)/);
    assert.match(app, /implementation\(project\(":core"\)\)/);
    assert.match(app, /all \{ it\.jvmArgs\("--add-exports=java\.base\/jdk\.internal\.access=ALL-UNNAMED"\) \}/);
    assert.match(file('core/build.gradle.kts'), /testImplementation\("junit:junit:4\.13\.2"\)/);

    const manifest = file('app/src/main/AndroidManifest.xml');
    assert.match(manifest, /<uses-permission android:name="android\.permission\.INTERNET" \/>/);
    assert.match(manifest, /android:allowBackup="false"/);
    assert.match(manifest, /<action android:name="android\.intent\.action\.MAIN" \/>/);
    assert.match(file('app/src/main/res/values/strings.xml'), /Pocket/);
  });

  it('keeps each module\'s files in its own source tree and package', () => {
    const backend = backends.require('kotlin');
    const project = androidProject();
    const core = must(project.files.find((f) => f.path.startsWith('core/')), 'core file');
    assert.equal(backend.pathFor(core, project), 'core/src/main/kotlin/com/pocket/core/Rules.kt');
    const source = fileContent(project, 'core/src/main/kotlin/com/pocket/core/Rules.kt');
    assert.match(source, /^package com\.pocket\.core$/m);
  });

  it('refuses JDBC in an Android module rather than generating code that cannot link', () => {
    const project = androidProject();
    const file = must(project.files.find((f) => f.path.startsWith('app/')), 'app file');
    const g = new GraphBuilder(project, nodes, must(project.graphs.find((x) => x.fileId === file.id), 'graph'));
    const entry = g.add('entry/function', { name: 'open' });
    const open = g.addWith('db/open', { a0: 'notes.db' });
    g.chain(entry, open);
    project.grants['fs.write'] = true;
    project.grants['fs.read'] = true;
    const result = generate(project, { nodes, backends });
    assert.ok(result.diagnostics.errors.some((d) => d.code === 'codegen/kotlin-jvm-only' || d.code === 'codegen/kotlin-db-on-android'));
  });
});

describe('Kotlin diagnostics', () => {
  it('reads both the Gradle and the kotlinc error formats back to project paths', () => {
    const project = newProject({ name: 'Diag', language: 'kotlin', namespace: 'app' });
    addFile(project, { path: 'src/main/kotlin/app/Main.kt', language: 'kotlin', role: 'entry' });
    const output = [
      "e: file:///F:/work/out/src/main/kotlin/app/Main.kt:12:5 Unresolved reference 'foo'.",
      "src/main/kotlin/app/Main.kt:3:1: warning: parameter 'x' is never used",
    ].join('\n');
    const found = backends.require('kotlin').parseDiagnostics(output, project);
    assert.deepEqual(
      found.map((d) => [d.severity, d.file, d.line, d.column]),
      [
        ['error', 'src/main/kotlin/app/Main.kt', 12, 5],
        ['warning', 'src/main/kotlin/app/Main.kt', 3, 1],
      ],
    );
  });
});

describe('Windows batch launchers', () => {
  it('starts a .cmd tool with its arguments intact', async (t) => {
    if (process.platform !== 'win32') return t.skip('batch files are a Windows concern');
    const dir = mkdtempSync(join(tmpdir(), 'mcode-cmd-'));
    try {
      const script = join(dir, 'echo-args.cmd');
      writeFileSync(script, '@echo off\r\necho [%1]\r\necho [%2]\r\n');
      const run = await runCommand({ command: script, args: ['hello world', 'x&y'], cwd: dir, timeoutMs: 20_000 });
      assert.equal(run.startError, undefined);
      assert.equal(run.code, 0);
      // Each argument arrives as one quoted token, and `&` did not split the command line.
      assert.deepEqual(run.stdout.trim().split(/\r?\n/), ['["hello world"]', '["x&y"]']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
