#!/usr/bin/env node
/**
 * Builds the browser demo into a static directory.
 *
 *   node packages/demo/build.ts [outDir]      default: build/pages/demo
 *
 * The output is plain files for any static host (GitHub Pages serves it):
 *
 *   index.html, app.js, ...   the IDE, from packages/ide/public, with an import
 *                             map for `node:` modules and boot.js in place of app.js
 *   boot.js, host.js, ...     the demo's host, from packages/demo/public
 *   lib/core/**, lib/server/  the core and the command table, compiled
 *
 * Compiling is type stripping and nothing more - Node's own
 * `module.stripTypeScriptTypes`, the same transform `node` applies when it runs
 * the repository from source, so what the browser executes is the code the tests
 * exercise. The repository allows only erasable syntax (`erasableSyntaxOnly`),
 * which is what makes stripping sufficient. Import specifiers are then rewritten:
 * `#core/x.ts` and `./x.ts` become relative `.js` paths.
 *
 * Which specifiers are imports is decided by parsing, not by pattern: each
 * stripped module is parsed as an ES module (`vm.SourceTextModule`), and only
 * the static imports it reports are rewritten or checked. The core holds plenty
 * of generated-code templates with `import ... from 'node:...'` in them, and a
 * pattern cannot tell those from the real thing. Parsing also proves the
 * stripped output is valid JavaScript before a browser ever sees it.
 *
 * Everything that could silently produce a broken demo fails the build instead:
 * an import that resolves to no file, a `node:` module with no browser shim, an
 * index.html that no longer has the lines this rewrites.
 *
 * Needs Node 22.13 or newer, for `stripTypeScriptTypes`. The parser sits behind
 * `--experimental-vm-modules`; the script re-runs itself with it when needed.
 */

import * as nodeModule from 'node:module';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

type ParsedModule = { moduleRequests?: { specifier: string }[]; dependencySpecifiers?: string[] };
const SourceTextModule = (vm as unknown as { SourceTextModule?: new (code: string, options?: { identifier?: string }) => ParsedModule }).SourceTextModule;

if (!SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const repo = resolve(import.meta.dirname, '../..');
const outDir = resolve(process.argv[2] ?? join(repo, 'build/pages/demo'));

/** `node:` modules the browser shims in packages/demo/public/node provide, by import-map entry. */
const SHIMS = ['fs', 'path', 'process', 'os', 'url', 'child_process'];

/** Server modules the command table needs; main.ts is the HTTP host and is not shipped. */
const SERVER_FILES = ['commands.ts', 'history.ts', 'workspace-state.ts'];

const strip = (nodeModule as { stripTypeScriptTypes?: (code: string, options?: { mode?: 'strip' }) => string }).stripTypeScriptTypes;

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const posix = (path: string): string => path.split(sep).join('/');

function relativeSpecifier(fromFile: string, toFile: string): string {
  const rel = posix(relative(dirname(fromFile), toFile));
  return rel.startsWith('.') ? rel : `./${rel}`;
}

interface Compiled {
  source: string;
  target: string;
}

/** Maps a source path to where it lands in the output. */
function outputFor(source: string): string {
  const core = join(repo, 'packages/core/src');
  const server = join(repo, 'packages/server/src');
  if (source.startsWith(core + sep)) return join(outDir, 'lib/core', relative(core, source)).replace(/\.ts$/, '.js');
  if (source.startsWith(server + sep)) return join(outDir, 'lib/server', relative(server, source)).replace(/\.ts$/, '.js');
  throw new Error(`No output location for ${source}`);
}

/** The module's static import specifiers, from a real parse. Throws on invalid JavaScript. */
function staticImports(js: string, file: string): Set<string> {
  const parsed = new SourceTextModule!(js, { identifier: file });
  return new Set(parsed.moduleRequests?.map((r) => r.specifier) ?? parsed.dependencySpecifiers ?? []);
}

function compile(source: string, problems: string[], nodeImports: Set<string>): Compiled {
  if (!strip) throw new Error('This build needs Node 22.13 or newer (module.stripTypeScriptTypes).');
  const target = outputFor(source);
  const where = posix(relative(repo, source));
  const stripped = strip(readFileSync(source, 'utf8'), { mode: 'strip' });

  let imports: Set<string>;
  try {
    imports = staticImports(stripped, where);
  } catch (error) {
    problems.push(`${where}: the stripped module does not parse (${error instanceof Error ? error.message : error})`);
    return { source: stripped, target };
  }

  const rewrites = new Map<string, string>();
  for (const spec of imports) {
    if (spec.startsWith('node:')) {
      nodeImports.add(spec);
      continue;
    }
    let resolved: string;
    if (spec.startsWith('#core/')) resolved = join(repo, 'packages/core/src', spec.slice('#core/'.length));
    else if (spec.startsWith('#server/')) resolved = join(repo, 'packages/server/src', spec.slice('#server/'.length));
    else if (spec.startsWith('./') || spec.startsWith('../')) resolved = resolve(dirname(source), spec);
    else {
      problems.push(`${where}: imports "${spec}", which is not part of the demo build`);
      continue;
    }
    if (!existsSync(resolved)) problems.push(`${where}: "${spec}" resolves to no file`);
    else rewrites.set(spec, relativeSpecifier(target, outputFor(resolved)));
  }

  // Only specifiers the parser reported are touched; a template that happens to
  // contain the same text is left alone because it never contains a .ts path.
  const js = stripped.replace(SPECIFIER, (match, head: string, quote: string, spec: string) => {
    const to = rewrites.get(spec);
    return to ? `${head}${quote}${to}${quote}` : match;
  });
  return { source: js, target };
}

function rewriteIndex(html: string): string {
  const importMap = {
    imports: Object.fromEntries(SHIMS.map((name) => [`node:${name}`, `./node/${name}.js`])),
  };
  const replacements: [string, string][] = [
    ['<title>Master Code</title>', '<title>Master Code — browser demo</title>\n    <meta name="description" content="Master Code, a visual compiler: draw a program as a graph and get real source. This demo runs entirely in the browser." />'],
    ['<link rel="stylesheet" href="/styles.css" />', '<link rel="stylesheet" href="styles.css" />\n    <link rel="stylesheet" href="demo.css" />'],
    [
      '<p class="welcome-sub">Build software visually, in ten languages.</p>',
      '<p class="welcome-sub">Build software visually. This demo runs Python, JavaScript, HTML and CSS in your browser; <a href="https://github.com/RexIsOnFire/Master-Code">the full app</a> has all ten languages.</p>',
    ],
    [
      '<script type="module" src="/app.js"></script>',
      `<script type="importmap">\n${JSON.stringify(importMap, null, 2)}\n    </script>\n    <script type="module" src="boot.js"></script>`,
    ],
  ];
  let out = html;
  for (const [from, to] of replacements) {
    if (!out.includes(from)) throw new Error(`packages/ide/public/index.html no longer contains ${from}; update the demo build to match.`);
    out = out.replace(from, to);
  }
  const absolute = /\s(?:src|href)="\/(?!\/)[^"]*"/.exec(out);
  if (absolute) throw new Error(`index.html still has a root-absolute URL (${absolute[0].trim()}), which breaks under a subpath.`);
  return out;
}

function build(): void {
  const started = Date.now();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const sources = [
    ...walk(join(repo, 'packages/core/src')).filter((f) => f.endsWith('.ts')),
    ...SERVER_FILES.map((f) => join(repo, 'packages/server/src', f)),
  ];
  const problems: string[] = [];
  const nodeImports = new Set<string>();
  for (const file of sources) {
    const { source, target } = compile(file, problems, nodeImports);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }

  const unshimmed = [...nodeImports].filter((spec) => !SHIMS.includes(spec.slice('node:'.length)));
  if (unshimmed.length) problems.push(`no browser shim for ${unshimmed.join(', ')} - add one to packages/demo/public/node and SHIMS`);
  if (problems.length) throw new Error(`The demo build found problems:\n  ${problems.join('\n  ')}`);

  const ide = join(repo, 'packages/ide/public');
  for (const name of readdirSync(ide)) {
    if (name === 'index.html') continue;
    cpSync(join(ide, name), join(outDir, name), { recursive: true });
  }
  writeFileSync(join(outDir, 'index.html'), rewriteIndex(readFileSync(join(ide, 'index.html'), 'utf8')));

  const demo = join(repo, 'packages/demo/public');
  for (const name of readdirSync(demo)) {
    if (existsSync(join(outDir, name))) throw new Error(`packages/demo/public/${name} would overwrite an IDE file of the same name.`);
    cpSync(join(demo, name), join(outDir, name), { recursive: true });
  }

  const files = walk(outDir).length;
  console.log(`Built the demo into ${outDir}: ${sources.length} modules compiled, ${files} files, ${Date.now() - started} ms.`);
}

try {
  build();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
