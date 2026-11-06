/**
 * Author the Draken project.
 *
 * Run:  node tools/draken/build.ts [outputDir]
 * Default output: F:/Repos/Draken
 *
 * Writes the Master Code project (project.json, files.json, architecture.json,
 * graphs/). It does not generate Kotlin - run `mcode gen` in the output
 * directory for that, so what is generated is always what the project says.
 *
 * Draken is two Gradle modules:
 *   core  plain Kotlin/JVM: the domain, provider contracts and adapters,
 *         routing, context policy, tools, permissions, modules, orchestration.
 *         Nothing in it knows about Android, which is what keeps it portable.
 *   app   the Android application: persistence, credentials, the HTTP
 *         transport, on-device inference, and the Compose interface.
 */

import { resolve } from 'node:path';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { addDependency, autoLayoutProject, grant, newProject } from '#core/project/builder.ts';
import { saveProject } from '#core/project/io.ts';
import { validateGraph } from '#core/lower/validate.ts';
import { validateFileGraph } from '#core/filegraph/graph.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { DiagnosticBag } from '#core/diagnostics.ts';
import { generate } from '#core/codegen/generate.ts';
import type { KotlinSettings } from '#core/backends/kotlin.ts';
import type { Ctx } from './kit.ts';
import { declaredCount, wireImports } from './kit.ts';
import { androidSettings } from './android.ts';
import { buildCore } from './m-core.ts';
import { buildLocal } from './local.ts';
import { buildApp } from './m-app.ts';

const outDir = resolve(process.argv[2] ?? 'F:/Repos/Draken');
const registry = createDefaultRegistry();

const project = newProject({
  name: 'Draken',
  language: 'kotlin',
  architecture: 'modular',
  namespace: 'com.draken',
  version: '0.1.0',
  license: 'Proprietary',
  description:
    'A modular, local-first personal AI platform for Android: one conversation interface over local and cloud models, installable capability modules, and a permission broker every action goes through.',
});

// The generated program reaches the network (cloud providers, model downloads)
// and the filesystem (models, the database); the sandbox pre-check sees these.
for (const cap of ['net', 'fs.read', 'fs.write', 'time', 'random'] as const) grant(project, cap);

const settings: KotlinSettings = {
  jvmTarget: 17,
  modules: [
    {
      path: 'app',
      kind: 'android-application',
      dependsOn: ['core', 'local'],
      compose: true,
      serialization: true,
      // Robolectric's SDK 36 environment reaches into jdk.internal.access,
      // which a JDK 17+ test JVM only allows when it is exported.
      testJvmArgs: ['--add-exports=java.base/jdk.internal.access=ALL-UNNAMED', '--add-opens=java.base/java.io=ALL-UNNAMED'],
      android: androidSettings(),
      // Room writes each schema version here, so a migration can be checked against it.
      extraDsl: ['ksp {', '    arg("room.schemaLocation", "$projectDir/schemas")', '}'],
    },
    { path: 'core', kind: 'jvm-library', serialization: true },
    { path: 'local', kind: 'jvm-library', dependsOn: ['core'] },
  ],
};
project.extensions = { kotlin: settings };

type Dep = [name: string, version: string, configuration: string];
const dependencies: Record<string, Dep[]> = {
  core: [
    ['org.jetbrains.kotlinx:kotlinx-coroutines-core', '1.11.0', 'api'],
    ['org.jetbrains.kotlinx:kotlinx-serialization-json', '1.11.0', 'api'],
    ['com.squareup.okhttp3:okhttp', '5.5.0', 'implementation'],
    ['com.anthropic:anthropic-java', '2.67.0', 'implementation'],
    ['junit:junit', '4.13.2', 'testImplementation'],
    ['org.jetbrains.kotlinx:kotlinx-coroutines-test', '1.11.0', 'testImplementation'],
    ['com.squareup.okhttp3:mockwebserver3', '5.5.0', 'testImplementation'],
  ],
  local: [
    ['com.squareup.okhttp3:okhttp', '5.5.0', 'implementation'],
    // Compiled against the JVM build; the app supplies the Android build, whose
    // public API is identical (only Kotlin-internal members differ).
    ['com.google.ai.edge.litertlm:litertlm-jvm', '0.17.1', 'compileOnly'],
    ['com.google.ai.edge.litertlm:litertlm-jvm', '0.17.1', 'testImplementation'],
    ['junit:junit', '4.13.2', 'testImplementation'],
    ['org.jetbrains.kotlinx:kotlinx-coroutines-test', '1.11.0', 'testImplementation'],
    ['com.squareup.okhttp3:mockwebserver3', '5.5.0', 'testImplementation'],
  ],
  app: [
    ['com.google.ai.edge.litertlm:litertlm-android', '0.17.1', 'implementation'],
    ['androidx.compose:compose-bom', '2026.09.00', 'platform:implementation'],
    ['androidx.compose.material3:material3', '*', 'implementation'],
    ['androidx.compose.ui:ui', '*', 'implementation'],
    ['androidx.compose.ui:ui-tooling-preview', '*', 'implementation'],
    ['androidx.compose.material:material-icons-core', '*', 'implementation'],
    ['androidx.activity:activity-compose', '1.13.0', 'implementation'],
    ['androidx.lifecycle:lifecycle-runtime-compose', '2.11.0', 'implementation'],
    ['androidx.lifecycle:lifecycle-viewmodel-compose', '2.11.0', 'implementation'],
    ['androidx.navigation:navigation-compose', '2.10.2', 'implementation'],
    ['androidx.room:room-runtime', '2.8.5', 'implementation'],
    ['androidx.room:room-ktx', '2.8.5', 'implementation'],
    ['androidx.room:room-compiler', '2.8.5', 'ksp'],
    ['androidx.datastore:datastore-preferences', '1.2.1', 'implementation'],
    ['org.jetbrains.kotlinx:kotlinx-coroutines-android', '1.11.0', 'implementation'],
    ['junit:junit', '4.13.2', 'testImplementation'],
    ['org.robolectric:robolectric', '4.17', 'testImplementation'],
    ['androidx.test:core', '1.7.0', 'testImplementation'],
    ['org.jetbrains.kotlinx:kotlinx-coroutines-test', '1.11.0', 'testImplementation'],
    ['com.squareup.okhttp3:mockwebserver3', '5.5.0', 'testImplementation'],
    ['androidx.compose.ui:ui-test-junit4', '*', 'testImplementation'],
    // The empty activity Compose tests host their content in.
    ['androidx.compose.ui:ui-test-manifest', '*', 'debugImplementation'],
  ],
};
for (const [target, list] of Object.entries(dependencies)) {
  for (const [name, version, configuration] of list) {
    addDependency(project, { name, version, language: 'kotlin', manager: 'gradle', configuration, target });
  }
}

const ctx: Ctx = { project, registry, files: [] };
buildCore(ctx);
buildLocal(ctx);
buildApp(ctx);

const imports = wireImports(ctx);
autoLayoutProject(project, registry);

// A project that does not validate is not a deliverable.
const backends = createDefaultBackends();
const diagnostics = new DiagnosticBag();
diagnostics.merge(validateFileGraph(project, backends));
for (const graph of project.graphs) {
  const file = project.files.find((f) => f.id === graph.fileId);
  validateGraph(graph, project, registry, file?.language ?? project.language, diagnostics);
}

// Generate in memory too: import cycles and emit errors only appear there,
// and finding them here is cheaper than finding them at `mcode gen`.
const generated = generate(project, { nodes: registry, backends, skipValidation: true });
diagnostics.merge(generated.diagnostics);

const result = saveProject(project, outDir);
console.log(`Draken written to ${outDir}`);
console.log(
  `  ${project.files.length} files, ${project.graphs.reduce((n, g) => n + g.nodes.length, 0)} nodes, ` +
    `${declaredCount()} declarations, ${imports} imports wired`,
);
console.log(`  ${result.written.length} project files written, ${result.removed.length} removed`);
console.log(`  ${diagnostics.errors.length} errors, ${diagnostics.warnings.length} warnings`);
for (const d of [...diagnostics.errors, ...diagnostics.warnings].slice(0, 40)) {
  console.log(`  ${d.severity} ${d.code} ${d.message}${d.file ? ` (${d.file})` : ''}`);
}
if (diagnostics.errors.length) process.exitCode = 1;
