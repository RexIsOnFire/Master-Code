/**
 * Running the tests a project defines visually.
 *
 * Test graphs generate ordinary test files in the target language - a Python
 * `unittest` module, a `node --test` file - so they run under the language's
 * own runner rather than a bespoke one. That matters: the tests keep working if
 * the project is exported and Master Code is never opened again.
 *
 * What this module adds is the mapping back: parsing the runner's output into
 * per-test results and attaching each failure to the Test Case node that
 * produced it, so a red test highlights a box in the editor.
 */

import { resolve } from 'node:path';
import type { BackendRegistry } from '../backends/backend.ts';
import { DiagnosticBag } from '../diagnostics.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project } from '../model/project.ts';
import type { GeneratedSourceMap } from '../build/sourcemap.ts';
import { mapDiagnostic } from '../build/sourcemap.ts';
import { runCommand } from '../runtime/exec.ts';
import { snake, camel } from '../backends/emitter.ts';

export type TestStatus = 'passed' | 'failed' | 'errored' | 'skipped';

export interface TestResult {
  name: string;
  status: TestStatus;
  durationMs?: number;
  message?: string;
  /** Test Case node that generated this test, when it can be identified. */
  nodeId?: string;
  graphId?: string;
  file?: string;
}

export interface TestRunOutcome {
  results: TestResult[];
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
  diagnostics: DiagnosticBag;
  /** Raw runner output, for the console pane. */
  output: string;
  /** Set when no runner was available or no tests exist. */
  note?: string;
  durationMs: number;
}

export interface TestRunOptions {
  project: Project;
  root: string;
  backends: BackendRegistry;
  sourceMap?: GeneratedSourceMap;
  /** Only run tests for this language. */
  language?: string;
  onOutput?(chunk: string, stream: 'stdout' | 'stderr'): void;
  signal?: AbortSignal;
}

export async function runTests(options: TestRunOptions): Promise<TestRunOutcome> {
  const started = Date.now();
  const diagnostics = new DiagnosticBag();
  const results: TestResult[] = [];
  const chunks: string[] = [];

  const languages = options.language
    ? [options.language]
    : [...new Set(options.project.files.filter((f) => f.role === 'test').map((f) => f.language))];

  if (!languages.length) {
    return {
      results,
      passed: 0,
      failed: 0,
      skipped: 0,
      ok: true,
      diagnostics,
      output: '',
      note: 'This project has no test files. Add one with a Test Case node.',
      durationMs: Date.now() - started,
    };
  }

  for (const language of languages.sort()) {
    const backend = options.backends.get(language);
    if (!backend) continue;
    const plan = backend.testPlan(options.project);
    if (!plan?.steps.length) {
      diagnostics.info('test', 'test/no-runner', `${backend.name} has no test runner configured in this build.`, {
        hint: 'Run the generated tests with your own tooling.',
      });
      continue;
    }

    for (const step of plan.steps) {
      const run = await runCommand({
        command: step.command,
        args: step.args,
        cwd: resolve(options.root, step.cwd ?? '.'),
        env: step.env,
        timeoutMs: 300_000,
        maxOutputBytes: 4_000_000,
        onOutput: options.onOutput,
        signal: options.signal,
      });
      chunks.push(run.stdout, run.stderr);

      if (run.startError) {
        diagnostics.error('test', 'test/runner-missing', run.startError, {
          hint: `Install ${step.command}, or run the generated tests yourself.`,
        });
        continue;
      }

      const parsed = parseResults(language, `${run.stdout}\n${run.stderr}`);
      results.push(...parsed);

      if (!parsed.length && run.code !== 0) {
        diagnostics.error('test', 'test/runner-failed', `${step.label} exited with code ${run.code}.`, {
          raw: run.stderr.trim().split('\n').slice(-10).join('\n'),
        });
      }
    }
  }

  // Attach each result to the node that generated it.
  const index = buildTestIndex(options.project);
  for (const result of results) {
    const hit = index.get(normalizeTestName(result.name));
    if (hit) {
      result.nodeId = hit.nodeId;
      result.graphId = hit.graphId;
      result.file = hit.file;
    }
    if (result.status === 'failed' || result.status === 'errored') {
      const diagnostic: Diagnostic = {
        severity: 'error',
        stage: 'test',
        code: `test/${result.status}`,
        message: `${result.name}: ${result.message ?? 'failed'}`,
        file: result.file,
        origin: hit ? { nodeId: hit.nodeId, graphId: hit.graphId } : undefined,
      };
      diagnostics.add(options.sourceMap ? mapDiagnostic(diagnostic, options.sourceMap) : diagnostic);
    }
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'errored').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  return {
    results,
    passed,
    failed,
    skipped,
    ok: failed === 0 && diagnostics.ok,
    diagnostics,
    output: chunks.join('\n').trim(),
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseResults(language: string, output: string): TestResult[] {
  switch (language) {
    case 'python':
      return parsePythonUnittest(output);
    case 'javascript':
      return parseNodeTap(output);
    case 'csharp':
      return parseDotnetTest(output);
    case 'kotlin':
      return parseGradleTestLog(output);
    default:
      return [];
  }
}

/** `test_name (module.Class.test_name) ... ok` / `FAIL` / `ERROR` / `skipped`. */
function parsePythonUnittest(output: string): TestResult[] {
  const out: TestResult[] = [];
  const line = /^(\w[\w.]*)\s+\(([^)]+)\)(?:\s+\.\.\.)?\s+(ok|FAIL|ERROR|skipped.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = line.exec(output))) {
    const verdict = m[3].toLowerCase();
    out.push({
      name: m[1],
      status: verdict.startsWith('ok') ? 'passed' : verdict.startsWith('skipped') ? 'skipped' : verdict === 'fail' ? 'failed' : 'errored',
    });
  }
  // Attach the assertion text from each FAIL block.
  const block = /^(FAIL|ERROR): (\w[\w.]*)[\s\S]*?\n(AssertionError|\w+Error): ([^\n]+)/gm;
  while ((m = block.exec(output))) {
    const target = out.find((r) => r.name === m![2]);
    if (target) target.message = `${m[3]}: ${m[4]}`;
  }
  return out;
}

/** Node's TAP output: `ok 1 - name` / `not ok 1 - name`. */
function parseNodeTap(output: string): TestResult[] {
  const out: TestResult[] = [];
  const line = /^(not ok|ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO).*)?$/gm;
  let m: RegExpExecArray | null;
  while ((m = line.exec(output))) {
    out.push({
      name: m[2].trim(),
      status: m[3] === 'SKIP' ? 'skipped' : m[1] === 'ok' ? 'passed' : 'failed',
    });
  }
  const failure = /error:\s*'?([^\n']+)'?/g;
  const messages: string[] = [];
  while ((m = failure.exec(output))) messages.push(m[1]);
  let i = 0;
  for (const result of out) {
    if (result.status === 'failed' && i < messages.length) result.message = messages[i++];
  }
  return out;
}

/** `Passed! ... Failed  TestName [12 ms]`. */
function parseDotnetTest(output: string): TestResult[] {
  const out: TestResult[] = [];
  const line = /^\s*(Passed|Failed|Skipped)\s+(\S+)(?:\s+\[([\d.]+)\s*ms\])?/gm;
  let m: RegExpExecArray | null;
  while ((m = line.exec(output))) {
    out.push({
      name: m[2],
      status: m[1] === 'Passed' ? 'passed' : m[1] === 'Failed' ? 'failed' : 'skipped',
      durationMs: m[3] ? Number(m[3]) : undefined,
    });
  }
  return out;
}

/**
 * Gradle's per-test lines, `app.NoteTest > savesANote PASSED`, which the
 * generated build scripts turn on. The failure detail follows a FAILED line,
 * indented, starting with the exception.
 */
function parseGradleTestLog(output: string): TestResult[] {
  const out: TestResult[] = [];
  const line = /^([\w.$]+) > (.+?)(?:\(\))? (PASSED|FAILED|SKIPPED)\r?$/gm;
  let m: RegExpExecArray | null;
  while ((m = line.exec(output))) {
    const result: TestResult = {
      name: m[2],
      status: m[3] === 'PASSED' ? 'passed' : m[3] === 'FAILED' ? 'failed' : 'skipped',
    };
    if (result.status === 'failed') {
      const detail = /^\s+(\S.*)$/m.exec(output.slice(line.lastIndex));
      if (detail) result.message = detail[1].trim();
    }
    out.push(result);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapping results to nodes
// ---------------------------------------------------------------------------

interface TestLocation {
  nodeId: string;
  graphId: string;
  file: string;
}

/**
 * Index every Test Case node by the name it will generate.
 *
 * Runners report names in the target language's casing, so the index holds
 * each spelling the backends might produce.
 */
function buildTestIndex(project: Project): Map<string, TestLocation> {
  const index = new Map<string, TestLocation>();
  for (const graph of project.graphs) {
    const file = project.files.find((f) => f.id === graph.fileId);
    if (!file || file.role !== 'test') continue;
    for (const node of graph.nodes) {
      if (node.type !== 'test/case') continue;
      const raw = String(node.props.name ?? '');
      if (!raw) continue;
      const base = raw.startsWith('test') ? raw : `test_${raw}`;
      const location: TestLocation = { nodeId: node.id, graphId: graph.id, file: file.path };
      for (const variant of [base, snake(base), camel(base)]) {
        index.set(normalizeTestName(variant), location);
      }
    }
  }
  return index;
}

/** Strip casing and separators so `test_foo`, `testFoo` and `TestFoo` match. */
function normalizeTestName(name: string): string {
  const bare = name.split('.').pop() ?? name;
  return bare.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Short line for the CLI. */
export function summarizeTests(outcome: TestRunOutcome): string {
  if (outcome.note) return outcome.note;
  return `${outcome.passed} passed, ${outcome.failed} failed, ${outcome.skipped} skipped (${outcome.durationMs} ms)`;
}
