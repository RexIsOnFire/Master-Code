/**
 * Process execution, with limits.
 *
 * Everything the platform runs - compilers, package managers, the user's own
 * generated program - goes through `runCommand`. Concentrating it here means
 * the timeout, the output cap, the environment allowlist and the kill-the-whole
 * -tree behaviour are applied uniformly rather than remembered case by case.
 *
 * What is and is not enforced is stated plainly in `docs/security.md`; the
 * short version is that this provides process isolation, resource ceilings and
 * a scrubbed environment, and it is **not** a security boundary against
 * deliberately hostile code. Anything stronger needs an OS-level sandbox
 * (a container, a VM, a seccomp profile), which this cannot provide from Node
 * without native modules.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import process from 'node:process';

export interface RunOptions {
  command: string;
  args: string[];
  /** Absolute working directory. The process is started here. */
  cwd: string;
  /** Extra environment on top of the allowlisted host variables. */
  env?: Record<string, string>;
  /** Host variables to pass through; everything else is dropped. */
  envAllowlist?: string[];
  timeoutMs?: number;
  /** Truncate captured output past this many bytes. */
  maxOutputBytes?: number;
  /** Text written to the process's standard input. */
  stdin?: string;
  /** Called for each chunk, so a UI can stream the build log. */
  onOutput?(chunk: string, stream: 'stdout' | 'stderr'): void;
  /** Abort from outside, for a Stop button. */
  signal?: AbortSignal;
}

export interface RunResult {
  command: string;
  args: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  /** Set when the executable could not be found or started at all. */
  startError?: string;
}

/**
 * Host environment variables passed through to a child process. Everything
 * else is stripped.
 *
 * The list is deliberately short, but it has to carry what a *compiler* needs
 * as well as what a program needs. Go refuses to build at all without a cache
 * directory, which on Windows it derives from LOCALAPPDATA; Cargo and .NET
 * want their own home directories. Leaving those out does not sandbox
 * anything, it just makes the toolchain fail with a message about caches.
 */
const DEFAULT_ALLOWLIST = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',

  // Toolchain caches and homes. Without these, builds fail on Windows.
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'LOCALAPPDATA',
  'LocalAppData',
  'APPDATA',
  'AppData',
  'ProgramData',
  'GOCACHE',
  'GOPATH',
  'GOROOT',
  'GOMODCACHE',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'DOTNET_CLI_HOME',
  'NUGET_PACKAGES',
  'JAVA_HOME',
  'MAVEN_OPTS',
  // Gradle and the Android Gradle Plugin locate the SDK and their caches from
  // these; without them an Android build fails asking for local.properties.
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'GRADLE_USER_HOME',
  'GRADLE_OPTS',
  'KOTLIN_HOME',
];

/**
 * Runs commands somewhere other than this machine's processes.
 *
 * The browser demo has no processes: it sends `python` to Pyodide and `node` to
 * a worker. Because everything already goes through `runCommand` and `which`,
 * one host set here moves the build, the run, the tracer, the test runner and
 * the toolchain probe together - none of them can be left spawning by mistake.
 */
export interface ProcessHost {
  run(options: RunOptions): Promise<RunResult>;
  /** Where the command would be found, or undefined when it is not available. */
  which(command: string): string | undefined;
}

let processHost: ProcessHost | undefined;

/** Replace process spawning for the life of this module; undefined restores it. */
export function setProcessHost(host: ProcessHost | undefined): void {
  processHost = host;
  // A probe answered by the previous host says nothing about this one.
  versionCache.clear();
}

export async function runCommand(options: RunOptions): Promise<RunResult> {
  if (processHost) return processHost.run(options);
  const started = Date.now();
  const maxBytes = options.maxOutputBytes ?? 2_000_000;
  const env = buildEnv(options.envAllowlist ?? DEFAULT_ALLOWLIST, options.env);

  return new Promise<RunResult>((settle) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let finished = false;

    const launch = windowsBatchLaunch(options.command, options.args);
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf8');
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        if (!truncated) {
          truncated = true;
          const note = `\n[output truncated at ${maxBytes} bytes]\n`;
          if (stream === 'stdout') stdout += note;
          else stderr += note;
        }
        return;
      }
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      options.onOutput?.(text, stream);
    };

    child.stdout?.on('data', (c: Buffer) => capture(c, 'stdout'));
    child.stderr?.on('data', (c: Buffer) => capture(c, 'stderr'));

    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    else child.stdin?.end();

    const finish = (result: Omit<RunResult, 'command' | 'args' | 'durationMs'>): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      settle({
        command: options.command,
        args: options.args,
        durationMs: Date.now() - started,
        ...result,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs ?? 60_000);

    const onAbort = (): void => killTree(child.pid);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      finish({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        truncated,
        startError: describeStartError(err, options.command),
      });
    });

    child.on('close', (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut, truncated });
    });
  });
}

/**
 * Kill a process and everything it spawned.
 *
 * A compiler that shells out leaves children behind when only the parent is
 * signalled, and those children keep holding the output directory open. On
 * Windows that means the next build fails with a permission error, so the tree
 * kill is not optional.
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      // Nothing useful to do; the timeout path already reports failure.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * How to start `command` so a Windows batch file actually runs.
 *
 * Gradle, kotlinc, npm and most package-manager shims are `.cmd` files on
 * Windows. `spawn` without a shell cannot start one - Node refuses batch files
 * outright rather than risk cmd.exe re-reading the arguments - so a toolchain
 * that is installed and on PATH reported itself missing. Turning on `shell`
 * would fix that by handing cmd.exe an unescaped command line, which is the
 * injection Node was preventing.
 *
 * Instead the batch file is run through cmd.exe explicitly with every argument
 * quoted and its metacharacters caret-escaped, the scheme cross-spawn uses.
 * npm-style shims under node_modules/.bin re-parse their arguments once more,
 * so those get escaped twice. Everything that is not a batch file, and every
 * other platform, is spawned exactly as before.
 */
export function windowsBatchLaunch(
  command: string,
  args: string[],
): { command: string; args: string[]; verbatim: boolean } {
  if (process.platform !== 'win32') return { command, args, verbatim: false };
  const resolved = which(command);
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return { command, args, verbatim: false };

  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const line = [
    escapeCmdMeta(resolved.replace(/\//g, '\\')),
    ...args.map((a) => quoteCmdArgument(a, doubleEscape)),
  ].join(' ');
  return {
    command: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdMeta(text: string): string {
  return text.replace(CMD_META, '^$1');
}

function quoteCmdArgument(arg: string, doubleEscape: boolean): string {
  // Backslashes only need doubling where they precede a quote, including the
  // closing quote added below; elsewhere the C runtime reads them literally.
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  quoted = escapeCmdMeta(`"${quoted}"`);
  return doubleEscape ? escapeCmdMeta(quoted) : quoted;
}

function buildEnv(allowlist: string[], extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function describeStartError(err: NodeJS.ErrnoException, command: string): string {
  if (err.code === 'ENOENT') {
    return `"${command}" is not on PATH. Install it, or point the project at a different toolchain.`;
  }
  if (err.code === 'EACCES') return `"${command}" is not executable.`;
  return err.message;
}

// ---------------------------------------------------------------------------
// Toolchain detection
// ---------------------------------------------------------------------------

export interface ToolStatus {
  command: string;
  available: boolean;
  version?: string;
  path?: string;
  hint?: string;
}

const versionCache = new Map<string, ToolStatus>();

/** Probe an executable, caching the answer for the life of the process. */
export async function probeTool(
  command: string,
  versionArgs: string[] = ['--version'],
  hint?: string,
): Promise<ToolStatus> {
  const cached = versionCache.get(command);
  if (cached) return cached;

  const located = which(command);
  if (!located) {
    const status: ToolStatus = { command, available: false, hint };
    versionCache.set(command, status);
    return status;
  }

  const result = await runCommand({
    command,
    args: versionArgs,
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxOutputBytes: 16_000,
  });
  // Several tools print their version to stderr (`java -version` famously).
  const text = `${result.stdout}${result.stderr}`.trim();
  const status: ToolStatus = {
    command,
    available: result.code === 0 || !!text,
    version: versionLine(text),
    path: located,
    hint,
  };
  versionCache.set(command, status);
  return status;
}

/**
 * The line of a `--version` banner that names the version.
 *
 * Usually the first, but Gradle opens with a blank line and a rule of dashes,
 * so the first line that carries a digit is taken instead.
 */
function versionLine(text: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /\d/.test(l)) ?? lines[0];
}

/** Resolve an executable on PATH, honouring PATHEXT on Windows. */
export function which(command: string): string | undefined {
  if (processHost) return processHost.which(command);
  if (isAbsolute(command) && existsSync(command)) return command;
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function clearToolCache(): void {
  versionCache.clear();
}

/** Guard against a command escaping the directory it is supposed to work in. */
export function withinRoot(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const target = resolve(root, candidate);
  return target === rootResolved || target.startsWith(rootResolved + sep);
}
