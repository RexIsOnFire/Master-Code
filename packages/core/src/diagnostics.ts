/**
 * One diagnostic type for the whole platform.
 *
 * Graph validation, IR validation, code generation, compiler output and test
 * failures all produce these, so the UI has a single "Problems" list and a
 * single rule for jumping to the cause: prefer `origin` (a visual node), fall
 * back to `file`/`line`.
 */

import type { Origin } from './ir/ir.ts';

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export type DiagnosticStage =
  | 'graph'
  | 'type'
  | 'ir'
  | 'filegraph'
  | 'codegen'
  | 'dependency'
  | 'build'
  | 'test'
  | 'runtime'
  | 'sandbox'
  | 'plugin'
  | 'import';

export interface Diagnostic {
  severity: Severity;
  stage: DiagnosticStage;
  /** Stable machine-readable id, e.g. `type/incompatible-connection`. */
  code: string;
  message: string;
  /** Visual node this maps back to, when known. */
  origin?: Origin;
  /** Project-relative source path, when the problem is in a file. */
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  /** Suggested fix, shown as a quick action in the UI. */
  hint?: string;
  /** Raw tool output line this was parsed from, kept for the build log. */
  raw?: string;
}

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  add(d: Diagnostic): this {
    this.items.push(d);
    return this;
  }

  error(stage: DiagnosticStage, code: string, message: string, extra: Partial<Diagnostic> = {}): this {
    return this.add({ severity: 'error', stage, code, message, ...extra });
  }

  warn(stage: DiagnosticStage, code: string, message: string, extra: Partial<Diagnostic> = {}): this {
    return this.add({ severity: 'warning', stage, code, message, ...extra });
  }

  info(stage: DiagnosticStage, code: string, message: string, extra: Partial<Diagnostic> = {}): this {
    return this.add({ severity: 'info', stage, code, message, ...extra });
  }

  merge(other: DiagnosticBag | Diagnostic[]): this {
    const list = Array.isArray(other) ? other : other.items;
    this.items.push(...list);
    return this;
  }

  get errors(): Diagnostic[] {
    return this.items.filter((d) => d.severity === 'error');
  }

  get warnings(): Diagnostic[] {
    return this.items.filter((d) => d.severity === 'warning');
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }

  /** Human-readable summary for CLI output. */
  format(opts: { color?: boolean } = {}): string {
    const c = opts.color ?? false;
    const paint = (s: string, code: string) => (c ? `\x1b[${code}m${s}\x1b[0m` : s);
    const tint: Record<Severity, string> = { error: '31', warning: '33', info: '36', hint: '90' };
    return this.items
      .map((d) => {
        const where = d.file
          ? ` ${d.file}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ''}` : ''}`
          : d.origin
            ? ` [node ${d.origin.nodeId}${d.origin.portId ? `.${d.origin.portId}` : ''}]`
            : '';
        const head = `${paint(d.severity, tint[d.severity])} ${paint(d.code, '90')}${where}`;
        return `${head}\n  ${d.message}${d.hint ? `\n  hint: ${d.hint}` : ''}`;
      })
      .join('\n');
  }

  toJSON(): Diagnostic[] {
    return this.items;
  }
}

export function summarize(items: Diagnostic[]): { errors: number; warnings: number; infos: number } {
  return {
    errors: items.filter((d) => d.severity === 'error').length,
    warnings: items.filter((d) => d.severity === 'warning').length,
    infos: items.filter((d) => d.severity === 'info' || d.severity === 'hint').length,
  };
}
