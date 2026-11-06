/**
 * `node:child_process` for the page.
 *
 * There are no processes to start. The demo installs a process host
 * (`setProcessHost`) that answers every command the core runs, so reaching this
 * means something bypassed `runCommand` - which should fail loudly, not quietly.
 */

export function spawn(command) {
  throw new Error(`Cannot start "${command}": the browser demo has no processes. This call should have gone through runCommand.`);
}

export const execFile = spawn;
export const exec = spawn;
export const spawnSync = spawn;
export const execSync = spawn;

export default { spawn, execFile, exec, spawnSync, execSync };
