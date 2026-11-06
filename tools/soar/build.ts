/**
 * Author the Master SOAR project.
 *
 * Run:  node tools/soar/build.ts [outputDir]
 * Default output: projects/master-soar
 *
 * This writes the project sources (project.json, architecture.json, files.json,
 * graphs/, ui/). It deliberately does NOT generate source code - open the
 * project in Master Code and press Generate when you have read it.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { addDependency, addFile, autoLayoutProject, grant, newProject } from '#core/project/builder.ts';
import { saveProject } from '#core/project/io.ts';
import { validateGraph } from '#core/lower/validate.ts';
import { validateFileGraph } from '#core/filegraph/graph.ts';
import { createDefaultBackends } from '#core/backends/index.ts';
import { DiagnosticBag } from '#core/diagnostics.ts';
import type { Ctx } from './kit.ts';
import { wireCustomCodeImports } from './kit.ts';
import { buildCore } from './m-core.ts';
import { buildDomain } from './m-domain.ts';
import { buildAutomation } from './m-automation.ts';
import { buildAi } from './m-ai.ts';
import { buildApi } from './m-api.ts';
import { buildRuntime } from './m-runtime.ts';
import { buildHandlers } from './m-handlers.ts';
import { buildReports } from './m-reports.ts';
import { buildWeb } from './m-web.ts';
import { buildEditor } from './m-editor.ts';
import { buildEditorUi } from './m-editor-ui.ts';
import { buildPages } from './m-pages.ts';
import { buildTests } from './m-tests.ts';
import { buildDeploy } from './m-deploy.ts';
import { buildHunts } from './m-hunts.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const outDir = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, 'projects', 'master-soar');

const registry = createDefaultRegistry();

const project = newProject({
  name: 'Master SOAR',
  language: 'python',
  architecture: 'modular',
  description:
    'An AI-native, low-code/no-code SOC orchestration platform. A modular monolith that runs standalone on one workstation and separates onto many machines without a rewrite.',
  namespace: 'mastersoar',
  license: 'MIT',
  version: '0.1.0',
});

// Capabilities the graphs actually ask for. The sandbox compares these against
// what the lowering pass recorded, before anything is compiled.
for (const cap of ['net', 'fs.read', 'fs.write', 'env', 'process', 'time', 'random', 'stdio'] as const) {
  grant(project, cap);
}

const deps: [string, string, string][] = [
  ['psycopg[binary,pool]', '3.2.*', 'PostgreSQL driver and connection pool.'],
  ['redis', '5.*', 'Job queue, sessions, rate limits, pub/sub.'],
  ['cryptography', '43.*', 'AES-GCM envelope encryption for credentials.'],
  ['argon2-cffi', '23.*', 'Password hashing.'],
  ['httpx', '0.27.*', 'Outbound HTTP for connectors, with the SSRF guard in front.'],
  ['jsonschema', '4.*', 'Command input/output schema validation.'],
  ['uvicorn', '0.30.*', 'ASGI server for the API role.'],
  ['starlette', '0.38.*', 'ASGI routing and middleware.'],
  ['segno', '1.6.*', 'QR encoding for MFA enrolment. Pure Python, no dependencies, so the enrolment code is drawn on a machine with no internet.'],
];
for (const [name, version] of deps) {
  addDependency(project, { name, version, language: 'python', manager: 'pip', scope: 'runtime' });
}

const ctx: Ctx = { project, registry };

const core = buildCore(ctx);
const domain = buildDomain(ctx, core);
const automation = buildAutomation(ctx, core, domain);
const ai = buildAi(ctx, core, domain, automation);
const hunts = buildHunts(ctx, core.platform, core.storage, core.identity);
const apiModule = buildApi(ctx, core, domain, automation, ai);
buildRuntime(ctx, core, automation, ai);
buildReports(ctx, core, domain, automation);
buildHandlers(ctx, apiModule);
const webFiles = buildWeb(ctx);
buildEditor(ctx, automation.playbooks, webFiles.web);
buildEditorUi(ctx, webFiles);
buildPages(ctx, webFiles);
buildTests(ctx, core, automation);
buildDeploy(ctx, outDir);

const wiredImports = wireCustomCodeImports(project);
autoLayoutProject(project, registry);

// -----------------------------------------------------------------------------
// Validate before writing. A project that does not validate is not a deliverable.
// -----------------------------------------------------------------------------
const backends = createDefaultBackends();
const diagnostics = new DiagnosticBag();
diagnostics.merge(validateFileGraph(project, backends));
for (const graph of project.graphs) {
  const file = project.files.find((f) => f.id === graph.fileId);
  validateGraph(graph, project, registry, file?.language ?? project.language, diagnostics);
}

const result = saveProject(project, outDir);

const errors = diagnostics.errors;
const warnings = diagnostics.warnings;

console.log(`Master SOAR written to ${outDir}`);
console.log(
  `  ${project.modules.length} modules, ${project.files.length} files, ${project.graphs.length} graphs, ` +
    `${project.graphs.reduce((n, g) => n + g.nodes.length, 0)} nodes, ` +
    `${project.graphs.reduce((n, g) => n + g.edges.length, 0)} edges`,
);
console.log(`  ${wiredImports} cross-file imports wired into code bodies`);
console.log(`  ${result.written.length} files written`);
console.log(`  ${errors.length} errors, ${warnings.length} warnings`);
for (const d of [...errors, ...warnings].slice(0, 40)) {
  console.log(`  ${d.severity} ${d.code} ${d.message}${d.file ? ` (${d.file})` : ''}`);
}
if (errors.length) process.exitCode = 1;

void addFile;
void hunts;
