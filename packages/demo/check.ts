#!/usr/bin/env node
/**
 * Drives the built demo in a real browser and checks that it works.
 *
 *   node packages/demo/check.ts          builds first, then runs every scenario
 *
 * Starts a headless Chromium (Edge or Chrome; CHROME_PATH overrides) with a
 * throwaway profile, serves the build under /Master-Code/demo/ - the subpath
 * GitHub Pages uses - and talks to the browser over the DevTools protocol with
 * nothing but Node's own WebSocket. Scenarios call the same `masterCodeHost.call`
 * the IDE does, so they exercise the real path: the command table, the core,
 * the in-memory disk, IndexedDB, Pyodide and the JavaScript worker.
 *
 * It needs the network: Pyodide and its packages come from jsDelivr, and the
 * library scenario installs from PyPI. Exits non-zero if any check fails.
 *
 * Set DEMO_SCREENSHOTS to a directory to also save what the pages look like.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

const repo = resolve(import.meta.dirname, '../..');
const site = join(repo, 'build/pages');
const BASE = '/Master-Code/';

// -- reporting ------------------------------------------------------------------

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

/** Python on this machine, for reading the downloaded zip with an independent implementation. */
const pythonCommand = ['python', 'python3'].find((command) => spawnSync(command, ['--version']).status === 0);

// -- static server ----------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serve(): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(BASE)) return void res.writeHead(404).end();
    let file = resolve(site, `.${decodeURIComponent(url.pathname.slice(BASE.length - 1))}`);
    if (!file.startsWith(site)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready({ port: (server.address() as { port: number }).port, close: () => server.close() })));
}

// -- browser ----------------------------------------------------------------------

function findBrowser(): string {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chromium-based browser found; set CHROME_PATH.');
  return found;
}

type Json = Record<string, unknown>;

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { ok: (v: Json) => void; fail: (e: Error) => void }>();
  #listeners: ((message: Json) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Json;
      const waiter = typeof message.id === 'number' ? this.#pending.get(message.id) : undefined;
      if (waiter) {
        this.#pending.delete(message.id as number);
        if (message.error) waiter.fail(new Error(JSON.stringify(message.error)));
        else waiter.ok((message.result ?? {}) as Json);
      } else {
        for (const listener of this.#listeners) listener(message);
      }
    };
  }

  static connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    return new Promise((ok, fail) => {
      ws.onopen = () => ok(new Cdp(ws));
      ws.onerror = () => fail(new Error(`Could not connect to ${url}`));
    });
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((ok, fail) => this.#pending.set(id, { ok, fail }));
  }

  on(listener: (message: Json) => void): void {
    this.#listeners.push(listener);
  }

  close(): void {
    this.#ws.close();
  }
}

async function launch(): Promise<{ cdp: Cdp; stop: () => void; downloads: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'mc-demo-profile-'));
  const downloads = mkdtempSync(join(tmpdir(), 'mc-demo-downloads-'));
  const browser = spawn(findBrowser(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  return {
    cdp,
    downloads,
    stop: () => {
      cdp.close();
      browser.kill();
      setTimeout(() => {
        rmSync(profile, { recursive: true, force: true });
        rmSync(downloads, { recursive: true, force: true });
      }, 1500);
    },
  };
}

type Evaluate = (expression: string, timeoutMs?: number, userGesture?: boolean) => Promise<unknown>;

interface Page {
  evaluate: Evaluate;
  session: string;
  /** Every JavaScript context the page creates, in-process iframes included. */
  contexts: Json[];
  /** Sessions for iframes that run in their own process (sandboxed frames often do). */
  frames: string[];
}

async function openPage(cdp: Cdp, url: string, errors: string[]): Promise<Page> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const session = sessionId as string;
  const contexts: Json[] = [];
  const frames: string[] = [];
  cdp.on((message) => {
    const params = message.params as Json;
    if (message.method === 'Target.attachedToTarget' && message.sessionId === session && (params.targetInfo as Json)?.type === 'iframe') {
      frames.push(params.sessionId as string);
    }
    if (message.sessionId !== session) return;
    if (message.method === 'Runtime.executionContextCreated') contexts.push(params.context as Json);
    if (message.method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as Json;
      errors.push(`exception: ${(details.exception as Json)?.description ?? details.text}`);
    } else if (message.method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      errors.push(`console.error: ${(params.args as Json[]).map((a) => a.value ?? a.description).join(' ')}`);
    }
  });
  await cdp.send('Runtime.enable', {}, session);
  await cdp.send('Page.enable', {}, session);
  await cdp.send('DOM.enable', {}, session);
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session);
  await cdp.send('Page.navigate', { url }, session);

  // userGesture stands in for the click a real user makes; a file chooser opens only after one.
  const evaluate = async (expression: string, timeoutMs = 120_000, userGesture = false): Promise<unknown> => {
    const result = await Promise.race([
      cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, session),
      new Promise<never>((_, fail) => setTimeout(() => fail(new Error(`timed out after ${timeoutMs} ms: ${expression.slice(0, 80)}`)), timeoutMs)),
    ]);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails as Json;
      throw new Error(String((details.exception as Json)?.description ?? details.text));
    }
    return (result.result as Json).value;
  };
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, session);
  return { evaluate, session, contexts, frames };
}

async function screenshot(cdp: Cdp, session: string, name: string): Promise<void> {
  const dir = process.env.DEMO_SCREENSHOTS;
  if (!dir) return;
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
  writeFileSync(join(dir, `${name}.png`), Buffer.from(String(shot.data), 'base64'));
}

/** Evaluates `expression` inside the page's first child frame, wherever its process is. */
async function evaluateInFrame(cdp: Cdp, page: Page, expression: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    if (page.frames.length) {
      const out = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, page.frames[0]);
      return String((out.result as Json)?.value);
    }
    const tree = (await cdp.send('Page.getFrameTree', {}, page.session)).frameTree as Json;
    const child = ((tree.childFrames as Json[] | undefined) ?? [])[0]?.frame as Json | undefined;
    const context = child && page.contexts.find((c) => (c.auxData as Json)?.frameId === child.id && (c.auxData as Json)?.isDefault);
    if (context) {
      const out = await cdp.send('Runtime.evaluate', { expression, contextId: context.id, returnByValue: true }, page.session);
      return String((out.result as Json)?.value);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'no frame found';
}

async function until(evaluate: (e: string) => Promise<unknown>, expression: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* the page may still be loading */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// -- scenarios ----------------------------------------------------------------------

/** Runs `body` in the page as an async function with `call` and the demo modules at hand. */
const inPage = (body: string): string => `(async () => {
  const call = async (command, args = {}) => {
    const outcome = await window.masterCodeHost.call(command, args);
    if (!outcome.ok) throw new Error(command + ': ' + outcome.error);
    return outcome.result;
  };
  const { disk } = await import('./vfs.js');
  const { runCommand } = await import('./lib/core/runtime/exec.js');
  ${body}
})()`;

async function main(): Promise<void> {
  const built = spawnSync(process.execPath, [join(repo, 'packages/demo/build.ts')], { encoding: 'utf8' });
  check('demo builds', built.status === 0, (built.stdout || built.stderr).trim().split('\n').pop());
  if (built.status !== 0) return;

  const server = await serve();
  const { cdp, stop, downloads } = await launch();
  const errors: string[] = [];
  const url = `http://127.0.0.1:${server.port}${BASE}demo/`;
  try {
    const { evaluate, session } = await openPage(cdp, url, errors);

    check('IDE boots on the demo host', await until(evaluate, "!!window.masterCodeHost && !document.getElementById('welcome').hidden"));
    const welcome = (await evaluate(inPage("return call('workspace.welcome');"))) as Json;
    const languages = (welcome.languages as Json[]).map((l) => `${l.id}:${l.ready ? 'ready' : 'generates'}`);
    check('offers Python, JavaScript, HTML and CSS, all ready', languages.join(',') === 'python:ready,javascript:ready,html:ready,css:ready', languages.join(', '));
    check('names the runtime on the welcome screen', String(await evaluate("document.getElementById('welcomeNode').textContent")).includes('Pyodide'));
    check('shows "Open a .zip" on the welcome screen', (await evaluate("!document.getElementById('welcomeImportZip').hidden")) === true);
    await screenshot(cdp, session, '1-welcome');

    // Python: create, modularise, generate, build, run, test, trace.
    const python = (await evaluate(
      inPage(`
      const created = await call('project.create', { template: 'python/cli', name: 'Greeter' });
      await call('project.settings', { settings: { grants: { env: true } } });
      // A flat project has no directories to infer modules from, so the grouping is explicit.
      const arch = await call('project.architecture', { target: 'modular', groups: { greeting: ['src/greeting.py'] } });
      const generated = await call('code.generate');
      const build = await call('code.build');
      const run = await call('code.run', {});
      const test = await call('code.test');
      const trace = await call('code.trace', { args: ['Ada'] });
      return {
        root: created.root,
        architecture: arch.project.architecture,
        modules: arch.project.modules.map((m) => m.name),
        files: generated.files.map((f) => f.path),
        build: { ok: build.ok, steps: (build.steps ?? []).map((s) => s.label + ':' + s.ok), diagnostics: build.diagnostics },
        run: { ok: run.ok, exit: run.exitCode, diagnostics: run.diagnostics, blocked: run.blocked, missing: run.missing },
        test: { ok: test.ok, results: (test.results ?? []).map((r) => r.name + ':' + r.status), note: test.note, diagnostics: test.diagnostics },
        trace: { ok: trace.ok, nodes: trace.nodes?.length ?? 0, unreached: trace.unreached?.length, unsupported: trace.unsupported, blocked: trace.blocked, diagnostics: trace.diagnostics },
        stored: disk.files(created.root).length,
      };`),
      240_000,
    )) as Json;
    check('python: project created in the browser disk', String(python.root).startsWith('/home/demo/MasterCode/'), String(python.root));
    check('python: converted to a modular layout', python.architecture === 'modular' && (python.modules as string[]).includes('greeting'), `modules: ${(python.modules as string[]).join(', ')}`);
    check('python: generates .py source, with the module in its own package', (python.files as string[]).some((f) => /^src\/greeting\/.+\.py$/.test(f)), (python.files as string[]).join(', '));
    check('python: builds (compileall under Pyodide)', (python.build as Json).ok === true, ((python.build as Json).steps as string[]).join(' | '));
    check('python: runs', (python.run as Json).ok === true, JSON.stringify(python.run));
    check('python: unit tests run and pass', (python.test as Json).ok === true && ((python.test as Json).results as string[]).length > 0, ((python.test as Json).results as string[]).join(', ') || String((python.test as Json).note));
    check('python: trace reports nodes that ran', ((python.trace as Json).nodes as number) > 0, JSON.stringify(python.trace));

    const output = (await evaluate(
      inPage(`
      const out = '${String(python.root)}/build/generated';
      const r = await runCommand({ command: 'python', args: ['src/main.py', 'Grace'], cwd: out, env: { PYTHONPATH: 'src' }, timeoutMs: 60000 });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };`),
    )) as Json;
    check('python: program prints its real output', output.code === 0 && String(output.stdout).includes('Grace'), JSON.stringify(output).slice(0, 200));

    // External library from PyPI (pure Python, not bundled with Pyodide), installed by micropip.
    const library = (await evaluate(
      inPage(`
      const cwd = '/home/demo/MasterCode/lib-check';
      disk.mkdir(cwd, { recursive: true });
      disk.writeFile(cwd + '/requirements.txt', 'tabulate==0.9.0\\n');
      disk.writeFile(cwd + '/main.py', 'from tabulate import tabulate\\nprint(tabulate([[1, 2]], headers=["a", "b"]))\\n');
      const r = await runCommand({ command: 'python', args: ['main.py'], cwd, timeoutMs: 60000 });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr.slice(-400) };`),
      240_000,
    )) as Json;
    check('python: installs a PyPI library from requirements.txt and imports it', library.code === 0 && /a\s+b/.test(String(library.stdout)), JSON.stringify(library).slice(0, 240));

    // The isolation boundary: user code cannot open the site's storage, and a forged report cannot write outside its run.
    const isolation = (await evaluate(
      inPage(`
      const cwd = '/home/demo/MasterCode/isolation';
      disk.mkdir(cwd, { recursive: true });
      disk.writeFile(cwd + '/probe.py', [
        'import js, json',
        'found = {}',
        'try:',
        '    js.indexedDB.open("probe")',
        '    found["indexedDB"] = "opened"',
        'except Exception as e:',
        '    found["indexedDB"] = type(e).__name__',
        'found["origin"] = str(js.self.origin)',
        'print(json.dumps(found), flush=True)',
        'js.postMessage(js.JSON.parse(json.dumps({"type": "exit", "id": None, "code": 0, "changes": [["/home/demo/MasterCode/victim.txt", "x"]], "removed": []})))',
      ].join('\\n'));
      const r = await runCommand({ command: 'python', args: ['probe.py'], cwd, timeoutMs: 60000 });
      // The second layer, on its own: even a report that reached the page cannot write outside the run.
      const { applyRunChanges } = await import('./runner.js');
      const refused = applyRunChanges(cwd, [['/home/demo/MasterCode/victim2.txt', 'x'], [cwd + '/../escape.txt', 'x'], [cwd + '/ok.txt', 'fine']], ['/home/demo/MasterCode/Greeter/project.json']);
      return {
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        victim: disk.exists('/home/demo/MasterCode/victim.txt'),
        refused,
        escaped: disk.exists('/home/demo/MasterCode/victim2.txt') || disk.exists('/home/demo/MasterCode/escape.txt'),
        inside: disk.exists(cwd + '/ok.txt'),
        kept: disk.exists('/home/demo/MasterCode/Greeter/project.json'),
      };`),
      240_000,
    )) as Json;
    const probe = JSON.parse(String(isolation.stdout).trim().split('\n')[0] || '{}') as Json;
    const ran = typeof probe.indexedDB === 'string';
    check('isolation: Python runs with an opaque origin', probe.origin === 'null', String(probe.origin));
    check("isolation: Python cannot open the site's IndexedDB", ran && probe.indexedDB !== 'opened', ran ? String(probe.indexedDB) : `the probe did not run: ${String(isolation.stderr).slice(-200)}`);
    check('isolation: a report forged by the program is ignored, and the real run finishes', ran && isolation.code === 0 && isolation.victim === false, `exit ${String(isolation.code)}, victim ${isolation.victim ? 'written' : 'not written'}`);
    check('isolation: changes outside the run directory are refused', isolation.refused === 3 && isolation.escaped === false && isolation.inside === true && isolation.kept === true, `refused ${String(isolation.refused)}, escaped ${String(isolation.escaped)}, inside ${String(isolation.inside)}, other project kept ${String(isolation.kept)}`);

    // JavaScript (Node-style CLI): run under the worker.
    const javascript = (await evaluate(
      inPage(`
      const created = await call('project.create', { template: 'javascript/cli', name: 'Js Tool' });
      await call('project.settings', { settings: { grants: { env: true } } });
      const run = await call('code.run', {});
      const out = created.root + '/build/generated';
      const entry = created.project.files.find((f) => f.role === 'entry').path;
      const r = await runCommand({ command: 'node', args: [entry, 'Lin'], cwd: out, timeoutMs: 30000 });
      return { ok: run.ok, exit: run.exitCode, diagnostics: run.diagnostics, stdout: r.stdout, stderr: r.stderr.slice(-300), code: r.code };`),
      120_000,
    )) as Json;
    check('javascript: runs a Node-style program in the worker', javascript.ok === true && javascript.code === 0, JSON.stringify(javascript).slice(0, 260));

    // HTML: generate, then the preview shell renders it in a sandbox.
    const html = (await evaluate(
      inPage(`
      await call('project.create', { template: 'html/empty', name: 'Site' });
      const run = await call('code.run', {});
      return run;`),
      60_000,
    )) as Json;
    check('html: Run returns a preview URL under the demo', String(html.openInBrowser ?? '').startsWith('preview.html?'), String(html.openInBrowser));
    if (html.openInBrowser) {
      const preview = await openPage(cdp, new URL(String(html.openInBrowser), url).href, errors);
      const shown = await until(preview.evaluate, "document.getElementById('frame').srcdoc.length > 0", 15_000);
      check('html: preview renders the generated page', shown);
      await new Promise((r) => setTimeout(r, 500));
      await screenshot(cdp, preview.session, '3-preview');
      const sandbox = await preview.evaluate("document.getElementById('frame').getAttribute('sandbox')");
      check('isolation: preview frame is sandboxed without same-origin', sandbox === 'allow-scripts allow-forms allow-modals allow-popups', String(sandbox));

      // A page with real parts: a linked stylesheet, a module importing a module, fetch() of a project file, a link.
      const siteOut = '/home/demo/MasterCode/site-check/build/generated';
      await evaluate(
        inPage(`
        const out = '${siteOut}';
        disk.mkdir(out + '/src', { recursive: true });
        disk.writeFile(out + '/index.html', '<!doctype html><html><head><link rel="stylesheet" href="styles.css"><script type="module" src="src/app.js"></script></head><body><p id="out">waiting</p><a id="next" href="about.html">About</a></body></html>');
        disk.writeFile(out + '/about.html', '<!doctype html><html><body><h1 id="about">About page</h1></body></html>');
        disk.writeFile(out + '/styles.css', 'body { background: rgb(1, 2, 3); }');
        disk.writeFile(out + '/data.json', JSON.stringify({ greeting: 'from data.json' }));
        disk.writeFile(out + '/src/util.js', "export const shout = (s) => s.toUpperCase();");
        disk.writeFile(out + '/src/app.js', "import { shout } from './util.js';\\nconst data = await (await fetch('data.json')).json();\\ndocument.getElementById('out').textContent = shout(data.greeting);");
        await disk.flush();
        return true;`),
      );
      const site = await openPage(cdp, `${url}preview.html?${new URLSearchParams({ out: siteOut, page: 'index.html' })}`, errors);
      let rendered = '';
      for (let i = 0; i < 40 && !rendered.startsWith('FROM'); i++) {
        rendered = await evaluateInFrame(cdp, site, "document.getElementById('out')?.textContent + ' | ' + getComputedStyle(document.body).backgroundColor");
        if (!rendered.startsWith('FROM')) await new Promise((r) => setTimeout(r, 250));
      }
      check('html: preview applies the stylesheet, runs imported modules and answers fetch()', rendered === 'FROM DATA.JSON | rgb(1, 2, 3)', rendered);
      await evaluateInFrame(cdp, site, "document.getElementById('next').click(), 'clicked'");
      const navigated = await until(site.evaluate, "document.getElementById('where').textContent === 'about.html'", 10_000);
      check('html: a relative link opens the next page in the preview', navigated, String(await site.evaluate("document.getElementById('where').textContent")));

      // Ask the page itself, from inside the frame, whether it can reach the site's storage.
      const answer = await evaluateInFrame(cdp, preview, "(() => { try { indexedDB.open('probe'); return 'opened'; } catch (e) { return e.name; } })() + ' / origin ' + self.origin");
      check("isolation: the previewed page cannot open the site's IndexedDB", /^SecurityError \/ origin null$/.test(answer), answer);
    }

    // JavaScript: node --test, built-in crypto, an npm package from the CDN, and a refused import cycle.
    const jsExtras = (await evaluate(
      inPage(`
      const cwd = '/home/demo/MasterCode/js-check';
      disk.mkdir(cwd + '/tests', { recursive: true });
      disk.mkdir(cwd + '/src', { recursive: true });
      disk.writeFile(cwd + '/package.json', JSON.stringify({ type: 'module', dependencies: { 'lodash-es': '4.17.21' } }));
      disk.writeFile(cwd + '/src/math.js', 'export const add = (a, b) => a + b;\\n');
      disk.writeFile(cwd + '/tests/math.test.js', [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { add } from '../src/math.js';",
        "test('adds', () => { assert.equal(add(2, 3), 5); });",
        "test('fails on purpose', () => { assert.equal(add(2, 2), 5); });",
      ].join('\\n'));
      disk.writeFile(cwd + '/src/digest.js', "const crypto = process.getBuiltinModule('node:crypto');\\nconsole.log(crypto.createHash('sha256').update('abc', 'utf8').digest('hex'));\\n");
      disk.writeFile(cwd + '/src/pkg.js', "import { chunk } from 'lodash-es';\\nconsole.log(JSON.stringify(chunk([1, 2, 3, 4], 2)));\\n");
      disk.writeFile(cwd + '/src/a.js', "import './b.js';\\n");
      disk.writeFile(cwd + '/src/b.js', "import './a.js';\\n");
      const test = await runCommand({ command: 'node', args: ['--test', 'tests/'], cwd, timeoutMs: 30000 });
      const hash = await runCommand({ command: 'node', args: ['src/digest.js'], cwd, timeoutMs: 30000 });
      const pkg = await runCommand({ command: 'node', args: ['src/pkg.js'], cwd, timeoutMs: 60000 });
      const cycle = await runCommand({ command: 'node', args: ['src/a.js'], cwd, timeoutMs: 30000 });
      return {
        test: { code: test.code, ok: /^ok \\d+ - adds$/m.test(test.stdout), notOk: /^not ok \\d+ - fails on purpose$/m.test(test.stdout), error: (/error: '([^']+)/.exec(test.stdout) || [])[1] },
        hash: hash.stdout.trim(),
        pkg: { code: pkg.code, stdout: pkg.stdout.trim(), stderr: pkg.stderr.slice(-200) },
        cycle: { code: cycle.code, stderr: cycle.stderr.split('\\n')[0] },
      };`),
      120_000,
    )) as Json;
    const jsTest = jsExtras.test as Json;
    check('javascript: node --test reports passing and failing tests in TAP', jsTest.ok === true && jsTest.notOk === true && jsTest.code === 1, JSON.stringify(jsTest));
    check('javascript: node:crypto sha256 matches Node', jsExtras.hash === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', String(jsExtras.hash));
    check('javascript: a declared npm package loads from the CDN', (jsExtras.pkg as Json).stdout === '[[1,2],[3,4]]', JSON.stringify(jsExtras.pkg));
    check('javascript: an import cycle is refused with the cycle named', (jsExtras.cycle as Json).code === 1 && /cycle: src\/a\.js -> src\/b\.js -> src\/a\.js/.test(String((jsExtras.cycle as Json).stderr)), String((jsExtras.cycle as Json).stderr));

    // Learn by doing: a challenge builds, runs and is checked against the real output.
    const learn = (await evaluate(
      inPage(`
      const list = await call('learn.list', { language: 'python' });
      const first = list.challenges[0];
      await call('learn.start', { id: first.id, language: 'python', name: 'Lesson One' });
      const result = await call('learn.check');
      return { title: first.title, count: list.challenges.length, stage: result.stage, ok: result.ok, reason: result.reason };`),
      180_000,
    )) as Json;
    check('learn: a Python challenge is built, run and checked', learn.stage === 'check', `${String(learn.count)} challenges; "${String(learn.title)}" -> stage ${String(learn.stage)}, ${String(learn.reason)}`);

    // Persistence: reload the tab; the project that was open reopens from IndexedDB.
    const before = String(await evaluate(inPage("return (await call('project.state')).project.name;")));
    await cdp.send('Page.reload', {}, session);
    const reopened = await until(evaluate, `!!window.masterCodeHost && document.getElementById('welcome').hidden && document.getElementById('projectName').textContent.startsWith(${JSON.stringify(before)})`, 30_000);
    check('persistence: a reload reopens the project from IndexedDB', reopened, `${before} -> ${String(await evaluate("document.getElementById('projectName').textContent").catch(() => '?'))}`);
    await new Promise((r) => setTimeout(r, 800));
    await screenshot(cdp, session, '2-ide');

    // Download the Python project as a zip, then read it with an independent tool.
    await evaluate(inPage(`await call('project.open', { path: '${String(python.root)}' }); return true;`));
    await evaluate(inPage('await window.masterCodeHost.downloadProject(); return true;'));
    let zip = '';
    for (let i = 0; i < 50 && !zip; i++) {
      zip = readdirSync(downloads).find((f) => f.endsWith('.zip')) ?? '';
      if (!zip) await new Promise((r) => setTimeout(r, 200));
    }
    check('zip: download produces a .zip', !!zip, zip);
    if (zip && !pythonCommand) console.log('SKIP  zip contents: no python on this machine to read the archive independently');
    if (zip && pythonCommand) {
      const listing = spawnSync(pythonCommand, ['-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint("\\n".join(z.namelist()))', join(downloads, zip)], { encoding: 'utf8' });
      const names = listing.stdout.split(/\r?\n/).filter(Boolean);
      check('zip: valid archive (Python zipfile, CRCs checked)', listing.status === 0, listing.stderr.trim().split('\n').pop());
      check('zip: holds project.json, architecture.json and graphs', ['project.json', 'architecture.json'].every((n) => names.some((x) => x.endsWith(`/${n}`))) && names.some((n) => n.includes('/graphs/')));
      check('zip: holds the generated .py files', names.some((n) => /\/build\/generated\/.*\.py$/.test(n)), `${names.filter((n) => n.endsWith('.py')).length} .py files`);
      check('zip: leaves out bytecode caches', !names.some((n) => n.includes('__pycache__') || n.endsWith('.pyc')));

      // Open it again through the real file chooser.
      await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, session);
      const chosen = new Promise<void>((done) =>
        cdp.on((message) => {
          if (message.sessionId === session && message.method === 'Page.fileChooserOpened') {
            void cdp.send('DOM.setFileInputFiles', { files: [join(downloads, zip)], backendNodeId: (message.params as Json).backendNodeId }, session).then(() => done());
          }
        }),
      );
      const importing = evaluate(inPage("const r = await window.masterCodeHost.importZip(); return { name: r ? r.project.name : null, root: (await call('project.state')).project && r && r.root };"), 60_000, true).then(
        (value) => value as Json,
        (error: unknown) => ({ error: String(error) }) as Json,
      );
      await Promise.race([chosen, importing]);
      const result = await importing;
      check('zip: importing it opens a working project again', result.name === 'Greeter', JSON.stringify(result));
    }

    const unexpected = errors.filter((e) => !/favicon/.test(e));
    check('no uncaught errors in the page', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
  } finally {
    stop();
    server.close();
  }
}

main()
  .catch((error: unknown) => {
    check('checker ran to the end', false, error instanceof Error ? error.message : String(error));
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exitCode = failures ? 1 : 0;
    // The browser's pipes can keep the event loop alive; the verdict is already printed.
    setTimeout(() => process.exit(process.exitCode), 2000).unref();
  });

