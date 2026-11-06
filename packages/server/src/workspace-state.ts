/**
 * The little bit of state that belongs to the machine rather than to a project:
 * which projects were opened recently, and where new ones should go.
 *
 * Kept out of the project format on purpose. A project file is meant to be
 * committed and shared, and "the last five things this user opened" is neither
 * shareable nor meaningful on someone else's machine.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

export interface RecentProject {
  name: string;
  path: string;
  language: string;
  /** ISO timestamp of the last open. */
  openedAt: string;
  /** False once the directory has been deleted or moved. */
  exists: boolean;
}

const MAX_RECENT = 12;

/** `%APPDATA%\mastercode` on Windows, `~/.mastercode` elsewhere. */
function stateDir(): string {
  const appData = process.env.APPDATA;
  return appData ? join(appData, 'mastercode') : join(homedir(), '.mastercode');
}

function recentFile(): string {
  return join(stateDir(), 'recent.json');
}

export function readRecent(): RecentProject[] {
  try {
    const raw = JSON.parse(readFileSync(recentFile(), 'utf8')) as RecentProject[];
    if (!Array.isArray(raw)) return [];
    // Report a missing directory rather than hiding it: a project that vanished
    // is something the user should see, not something to quietly forget.
    return raw
      .filter((r) => r && typeof r.path === 'string')
      .map((r) => ({ ...r, exists: existsSync(join(r.path, 'project.json')) }));
  } catch {
    return [];
  }
}

export function rememberProject(entry: { name: string; path: string; language: string }): void {
  const path = resolve(entry.path);
  const rest = readRecent().filter((r) => resolve(r.path) !== path);
  const next: RecentProject[] = [
    { name: entry.name, path, language: entry.language, openedAt: new Date().toISOString(), exists: true },
    ...rest,
  ].slice(0, MAX_RECENT);
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(recentFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // A read-only home directory is not a reason to fail an open.
  }
}

export function forgetProject(path: string): void {
  const target = resolve(path);
  const next = readRecent().filter((r) => resolve(r.path) !== target);
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(recentFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

/**
 * Where the New Project dialog should default to. Prefers an existing projects
 * folder over inventing one, and never returns a path it cannot write to.
 */
export function suggestedRoot(): string {
  const home = homedir();
  for (const candidate of [join(home, 'MasterCode'), join(home, 'Documents', 'MasterCode')]) {
    if (existsSync(candidate)) return candidate;
  }
  const documents = join(home, 'Documents');
  return existsSync(documents) ? join(documents, 'MasterCode') : join(home, 'MasterCode');
}

export interface DirectoryListing {
  path: string;
  parent?: string;
  entries: { name: string; path: string; isProject: boolean }[];
  error?: string;
}

/**
 * Lists subdirectories so the UI can offer a picker. A browser cannot show a
 * native folder dialog for a server-side path, and asking someone to type an
 * absolute path is the kind of thing that makes a tool feel unfinished.
 */
export function listDirectories(path: string): DirectoryListing {
  const target = resolve(path);
  const parentPath = resolve(target, '..');
  const parent = parentPath === target ? undefined : parentPath;
  try {
    const entries = readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => ({
        name: e.name,
        path: join(target, e.name),
        isProject: existsSync(join(target, e.name, 'project.json')),
      }))
      .sort((a, b) => Number(b.isProject) - Number(a.isProject) || a.name.localeCompare(b.name));
    return { path: target, parent, entries };
  } catch (err) {
    return {
      path: target,
      parent,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Common starting points for the picker, so nobody has to type a path at all. */
export function placeRoots(): { label: string; path: string }[] {
  const home = homedir();
  const roots = [
    { label: 'Home', path: home },
    { label: 'Documents', path: join(home, 'Documents') },
    { label: 'Desktop', path: join(home, 'Desktop') },
  ].filter((r) => existsSync(r.path));

  // On Windows, offer the drives too: projects often live outside the profile.
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      try {
        if (statSync(drive).isDirectory()) roots.push({ label: `${letter}:`, path: drive });
      } catch {
        /* not present */
      }
    }
  }
  return roots;
}

/** A filesystem-safe folder name derived from what the user typed. */
export function folderNameFor(projectName: string): string {
  const cleaned = projectName.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
  return cleaned || 'Untitled';
}

export { basename };
