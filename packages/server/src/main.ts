#!/usr/bin/env node
/**
 * The IDE server.
 *
 * A zero-dependency HTTP server that does two things: serve the browser IDE's
 * static files, and expose the core over one JSON command endpoint plus an
 * event stream for long-running output.
 *
 * One endpoint rather than thirty routes is a deliberate simplification. The
 * commands are named operations on the project, they all take and return JSON,
 * and adding one means adding a function to the table in `commands.ts` - not a
 * route, a handler, a schema and a client method. The event stream is separate
 * because build and run output arrives over time and the browser needs it as it
 * comes.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import process from 'node:process';
import { createWorkspace } from '#core/index.ts';
import { pluginDirectories } from '#cli/plugins.ts';
import { loadProject } from '#core/project/io.ts';
import { History } from './history.ts';
import { createCommands, execute } from './commands.ts';
import type { Session } from './commands.ts';

const PUBLIC_DIR = resolve(import.meta.dirname, '../../ide/public');

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

const listeners = new Set<ServerResponse>();

function emit(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(payload);
    } catch {
      listeners.delete(res);
    }
  }
}

const commands = createCommands({
  emit,
  // The open project's output directory is served under /preview/, below.
  previewUrl: (_out, path) => `/preview/${path}`,
  runtime: `Node ${process.version}`,
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res: ServerResponse, root: string, urlPath: string): boolean {
  const rootResolved = resolve(root);
  const target = resolve(root, `.${urlPath}`);
  if (!target.startsWith(rootResolved)) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  let file = target;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(readFileSync(file));
  return true;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function start(): Promise<void> {
  const port = Number(process.env.MASTERCODE_PORT ?? 4488);
  const host = process.env.MASTERCODE_HOST ?? '127.0.0.1';
  const workspace = await createWorkspace({ pluginDirs: pluginDirectories() });
  const session: Session = { workspace, history: new History() };

  // Open the project in the working directory, when there is one.
  const cwd = process.cwd();
  if (existsSync(join(cwd, 'project.json'))) {
    try {
      const { project } = loadProject(cwd);
      session.project = project;
      session.root = cwd;
      session.out = join(cwd, 'build/generated');
    } catch {
      // Left closed; the UI offers to create or open one.
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res, session).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });

  server.listen(port, host, () => {
    console.log(`Master Code IDE  http://${host}:${port}`);
    console.log(session.project ? `  project: ${session.project.name} (${session.root})` : '  no project open - create one in the UI');
    console.log(`  ${workspace.nodes.all().length} node types, ${workspace.backends.all().length} languages`);
    if (workspace.plugins.loaded.length) console.log(`  ${workspace.plugins.loaded.length} plugin(s) loaded`);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    listeners.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      listeners.delete(res);
    });
    return;
  }

  if (path === '/api/command' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.command ?? '');
    const outcome = await execute(commands, session, name, (body.args ?? {}) as Record<string, unknown>);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (!outcome.ok && outcome.unknown) {
      res.writeHead(404).end(JSON.stringify({ error: outcome.error }));
      return;
    }
    res.writeHead(200).end(JSON.stringify(outcome));
    return;
  }

  // Serve generated output so the browser preview can load a generated page.
  if (path.startsWith('/preview/') && session.out) {
    if (serveStatic(res, session.out, path.slice('/preview'.length))) return;
  }

  if (serveStatic(res, PUBLIC_DIR, path === '/' ? '/index.html' : path)) return;

  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}

void start();
