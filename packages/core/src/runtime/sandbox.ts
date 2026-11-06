/**
 * Running generated code, under limits.
 *
 * The strongest control here is not a runtime one: it is the **capability
 * pre-check**. Every node declares what it needs (`fs.write`, `net`,
 * `process`), the lowering pass records those on the IR, and the sandbox
 * refuses to run a program whose IR requires something the project has not
 * granted. That happens before the code is compiled, let alone executed, and it
 * is precise - the refusal names the node.
 *
 * The runtime controls are real but weaker, and worth being exact about:
 *
 *   enforced here          process isolation, working directory, wall-clock
 *                          timeout, output cap, environment allowlist,
 *                          tree-kill on timeout
 *   enforced by the runtime  heap ceiling, where the language offers a flag
 *                          (`node --max-old-space-size`, `java -Xmx`)
 *   NOT enforced           filesystem confinement, network blocking, syscall
 *                          filtering, CPU quota
 *
 * That last row matters. A program granted `fs.write` can write anywhere the
 * user can. Real confinement needs an OS-level sandbox - a container, a VM, a
 * seccomp or AppContainer profile - which Node cannot set up on its own. The
 * platform therefore treats the capability grant as the decision point and says
 * so, rather than implying a boundary it does not have.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Capability } from '../ir/ir.ts';
import type { CommandSpec } from '../backends/backend.ts';
import { DiagnosticBag } from '../diagnostics.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Project } from '../model/project.ts';
import type { IrProgram, Origin } from '../ir/ir.ts';
import { walkModule } from '../ir/ir.ts';
import { runCommand } from './exec.ts';
import type { RunResult } from './exec.ts';

// ---------------------------------------------------------------------------
// Capability pre-check
// ---------------------------------------------------------------------------

export interface CapabilityRequest {
  capability: Capability;
  /** Nodes that need it, so the refusal can point somewhere. */
  origins: Origin[];
}

/** Every capability the program needs, with the nodes that asked for each. */
export function requiredCapabilities(program: IrProgram): CapabilityRequest[] {
  const byCap = new Map<Capability, Origin[]>();
  const note = (caps: Capability[] | undefined, origin: Origin | undefined): void => {
    for (const cap of caps ?? []) {
      const list = byCap.get(cap);
      if (list) {
        if (origin && !list.some((o) => o.nodeId === origin.nodeId)) list.push(origin);
      } else byCap.set(cap, origin ? [origin] : []);
    }
  };

  for (const module of program.modules) {
    walkModule(module, {
      expr: (e) => {
        if (e.k === 'call' || e.k === 'method' || e.k === 'builtin' || e.k === 'raw') note(e.caps, e.origin);
      },
      stmt: (s) => {
        if (s.k === 'raw') note(s.caps, s.origin);
      },
      decl: (d) => {
        if (d.k === 'rawDecl') note(d.caps, d.origin);
      },
    });
  }
  return [...byCap.entries()]
    .map(([capability, origins]) => ({ capability, origins }))
    .sort((a, b) => a.capability.localeCompare(b.capability));
}

export interface CapabilityCheck {
  granted: Capability[];
  missing: CapabilityRequest[];
  diagnostics: DiagnosticBag;
  ok: boolean;
}

/**
 * Compare what the program needs against what the project has granted.
 *
 * This is deliberately a hard stop rather than a prompt-per-call: the user
 * grants a capability once, with the full list of nodes that will use it in
 * front of them, instead of being asked mid-run when saying no is expensive.
 */
export function checkCapabilities(project: Project, program: IrProgram): CapabilityCheck {
  const diagnostics = new DiagnosticBag();
  const required = requiredCapabilities(program);
  const granted: Capability[] = [];
  const missing: CapabilityRequest[] = [];

  for (const request of required) {
    if (project.grants[request.capability]) {
      granted.push(request.capability);
      continue;
    }
    missing.push(request);
    const where = request.origins.length
      ? ` Needed by ${request.origins.length} node${request.origins.length === 1 ? '' : 's'}.`
      : '';
    diagnostics.error(
      'sandbox',
      'sandbox/capability-not-granted',
      `This program needs the "${request.capability}" capability, which the project has not granted.${where}`,
      {
        origin: request.origins[0],
        hint: `Grant it in Project Settings, or with: mcode grant ${request.capability}`,
      },
    );
  }

  return { granted, missing, diagnostics, ok: missing.length === 0 };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface SandboxRunOptions {
  project: Project;
  /** Directory the generated project was written to. */
  root: string;
  command: CommandSpec;
  stdin?: string;
  onOutput?(chunk: string, stream: 'stdout' | 'stderr'): void;
  signal?: AbortSignal;
  /** Override the project's timeout, for a long-running task the user started. */
  timeoutMs?: number;
}

export interface SandboxResult extends RunResult {
  /** Limits that were actually applied, for the run log. */
  applied: {
    timeoutMs: number;
    memoryLimitMb: number | null;
    maxOutputBytes: number;
    cwd: string;
    envAllowlist: string[];
  };
  /** Limits that were requested but cannot be enforced on this platform. */
  unenforced: string[];
}

export async function runInSandbox(options: SandboxRunOptions): Promise<SandboxResult> {
  const { project, root, command } = options;
  const settings = project.sandbox;
  const cwd = resolve(root, command.cwd ?? '.');
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });

  const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
  const { args, env, memoryApplied } = applyMemoryLimit(command, settings.memoryLimitMb);

  const unenforced: string[] = [];
  if (settings.enabled) {
    if (!memoryApplied && settings.memoryLimitMb > 0) {
      unenforced.push(
        `memory limit (${settings.memoryLimitMb} MB): ${command.command} has no flag for it; the process can exceed it`,
      );
    }
    if (!settings.allowNetwork) {
      unenforced.push(
        'network block: not enforced at the process level. The capability check refuses ungranted network nodes before the run, but hand-written code in a Custom Code node is not stopped here',
      );
    }
    if (settings.allowedPaths.length) {
      unenforced.push(
        `filesystem confinement to ${settings.allowedPaths.join(', ')}: the working directory is set, but paths outside it are still reachable`,
      );
    }
  }

  const result = await runCommand({
    command: command.command,
    args,
    cwd,
    env: { ...env, ...command.env },
    envAllowlist: settings.envAllowlist,
    timeoutMs,
    maxOutputBytes: settings.maxOutputBytes,
    stdin: options.stdin,
    onOutput: options.onOutput,
    signal: options.signal,
  });

  return {
    ...result,
    applied: {
      timeoutMs,
      memoryLimitMb: memoryApplied ? settings.memoryLimitMb : null,
      maxOutputBytes: settings.maxOutputBytes,
      cwd,
      envAllowlist: settings.envAllowlist,
    },
    unenforced,
  };
}

/**
 * Add the runtime's own heap flag where one exists.
 *
 * Returns whether a limit was actually applied, so the caller can report the
 * gap rather than letting the user believe a cap is in force when it is not.
 */
function applyMemoryLimit(
  command: CommandSpec,
  limitMb: number,
): { args: string[]; env: Record<string, string>; memoryApplied: boolean } {
  if (limitMb <= 0) return { args: command.args, env: {}, memoryApplied: false };
  const exe = command.command.toLowerCase().replace(/\.exe$/, '');

  if (exe === 'node') {
    return { args: [`--max-old-space-size=${limitMb}`, ...command.args], env: {}, memoryApplied: true };
  }
  if (exe === 'java') {
    return { args: [`-Xmx${limitMb}m`, ...command.args], env: {}, memoryApplied: true };
  }
  if (exe === 'dotnet') {
    // The heap hard limit is bytes, and only honoured in server GC mode.
    return {
      args: command.args,
      env: {
        DOTNET_GCHeapHardLimit: (limitMb * 1024 * 1024).toString(16),
        DOTNET_gcServer: '1',
      },
      memoryApplied: true,
    };
  }
  return { args: command.args, env: {}, memoryApplied: false };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Turn a finished run into diagnostics, using the backend's parser. */
export function runDiagnostics(
  result: SandboxResult,
  parse: (output: string) => Diagnostic[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (result.startError) {
    out.push({
      severity: 'error',
      stage: 'sandbox',
      code: 'sandbox/start-failed',
      message: result.startError,
      hint: 'Run `mcode doctor` to see which toolchains are available.',
    });
    return out;
  }
  if (result.timedOut) {
    out.push({
      severity: 'error',
      stage: 'sandbox',
      code: 'sandbox/timeout',
      message: `The program was still running after ${result.applied.timeoutMs} ms and was stopped.`,
      hint: 'Raise the timeout in Project Settings, or look for a loop that never ends.',
    });
  }
  out.push(...parse(`${result.stdout}\n${result.stderr}`));
  if (!out.length && result.code !== 0 && !result.timedOut) {
    out.push({
      severity: 'error',
      stage: 'runtime',
      code: 'sandbox/nonzero-exit',
      message: `Exited with code ${result.code}.`,
      raw: result.stderr.trim().split('\n').slice(-5).join('\n') || undefined,
    });
  }
  return out;
}

/** One-line summary of what the sandbox actually enforced, for the run log. */
export function describeLimits(result: SandboxResult): string {
  const parts = [
    `timeout ${result.applied.timeoutMs} ms`,
    result.applied.memoryLimitMb ? `heap ${result.applied.memoryLimitMb} MB` : 'heap unlimited',
    `output cap ${Math.round(result.applied.maxOutputBytes / 1000)} kB`,
    `cwd ${result.applied.cwd}`,
  ];
  return parts.join(', ');
}
