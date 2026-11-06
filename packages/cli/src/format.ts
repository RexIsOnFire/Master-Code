/**
 * Terminal formatting.
 *
 * Colour is disabled when stdout is not a TTY, or when `NO_COLOR` is set, so
 * piping `mcode` into a file or a CI log produces clean text.
 */

import process from 'node:process';

const enabled =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function paint(code: string): (text: string) => string {
  return (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
}

export const color = {
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  dim: paint('90'),
  bold: paint('1'),
};

export function heading(text: string): string {
  return color.bold(text);
}

export function bullet(text: string): string {
  return `  ${color.dim('·')} ${text}`;
}

/** Width of a string with ANSI escapes removed. */
function width(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function pad(text: string, to: number): string {
  return text + ' '.repeat(Math.max(0, to - width(text)));
}

/** A left-aligned table with a dim header rule. */
export function table(headers: string[], rows: string[][], maxWidth = 78): string {
  if (!rows.length) return color.dim('  (none)');
  const widths = headers.map((h, i) =>
    Math.min(maxWidth, Math.max(width(h), ...rows.map((r) => width(r[i] ?? '')))),
  );

  const line = (cells: string[]): string =>
    `  ${cells.map((c, i) => pad(truncate(c ?? '', widths[i]), widths[i])).join('  ')}`.trimEnd();

  const out = [color.dim(line(headers)), color.dim(line(widths.map((w) => '-'.repeat(w))))];
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

function truncate(text: string, to: number): string {
  return width(text) <= to ? text : `${text.slice(0, Math.max(0, to - 1))}…`;
}

/** Render a tree of paths, for the project explorer view. */
export function tree(paths: string[]): string {
  const sorted = [...paths].sort();
  const out: string[] = [];
  let previous: string[] = [];
  for (const path of sorted) {
    const parts = path.split('/');
    for (let depth = 0; depth < parts.length; depth++) {
      if (previous[depth] === parts[depth] && depth < parts.length - 1) continue;
      const isLeaf = depth === parts.length - 1;
      out.push(`  ${'  '.repeat(depth)}${isLeaf ? '' : color.dim('')}${parts[depth]}${isLeaf ? '' : '/'}`);
    }
    previous = parts;
  }
  return out.join('\n');
}
