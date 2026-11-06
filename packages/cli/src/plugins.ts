import { join, resolve } from 'node:path';
import process from 'node:process';

/**
 * Where plugins are loaded from.
 *
 * Two directories, in order:
 *
 *   <install>/plugins   ships with Master Code, or is dropped in by the user.
 *                       Plugins here import the core through the `#core/*`
 *                       subpath, which resolves because they sit inside the
 *                       Master Code package.
 *   <project>/plugins   travels with one project. A plugin here is outside the
 *                       Master Code package, so `#core/*` does not resolve for
 *                       it; it must import through a relative path to the
 *                       installation (see docs/plugins.md).
 *
 * Keeping both makes "install a plugin globally" and "vendor a plugin with this
 * project" the same mechanism rather than two features.
 */
export function pluginDirectories(cwd: string = process.cwd()): string[] {
  const installRoot = resolve(import.meta.dirname, '../../..');
  const dirs = [join(installRoot, 'plugins')];
  const projectPlugins = resolve(cwd, 'plugins');
  if (!dirs.includes(projectPlugins)) dirs.push(projectPlugins);
  return dirs;
}
