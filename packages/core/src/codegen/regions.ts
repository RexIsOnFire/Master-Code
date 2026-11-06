/**
 * Preserved regions.
 *
 * A hybrid file is mostly generated, but carries marked areas the user owns.
 * Regeneration reads the previous version off disk, lifts those areas out, and
 * splices them back into the fresh output.
 *
 * The rules are deliberately strict, because the failure mode is losing
 * someone's work:
 *
 *  - A region the new output does not declare is **not** discarded. Its content
 *    is appended to an `orphaned` list and the caller must decide - the
 *    generator surfaces it as a warning and writes it to a `.orphaned` file
 *    rather than dropping it.
 *  - An unterminated marker aborts the merge for that file. Half-parsing a file
 *    and writing the result would be worse than refusing.
 */

import type { LanguageBackend } from '../backends/backend.ts';

export interface Region {
  id: string;
  /** Lines strictly between the markers. */
  content: string;
  startLine: number;
  endLine: number;
}

export interface RegionParse {
  regions: Map<string, Region>;
  errors: string[];
}

const OPEN = /mcode:region\s+id="([^"]+)"/;
const CLOSE = /<\/mcode:region>/;

/**
 * Find every marked region in a source file.
 *
 * Markers are recognised regardless of comment syntax: what matters is the
 * `mcode:region` token, so the same parser serves `#`, `//`, `/* *​/` and
 * `<!-- -->` without knowing the language.
 */
export function parseRegions(source: string): RegionParse {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const regions = new Map<string, Region>();
  const errors: string[] = [];
  let open: { id: string; start: number; body: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (CLOSE.test(line)) {
      if (!open) {
        errors.push(`line ${i + 1}: region close marker with no matching open`);
        continue;
      }
      regions.set(open.id, {
        id: open.id,
        content: open.body.join('\n'),
        startLine: open.start + 1,
        endLine: i + 1,
      });
      open = null;
      continue;
    }
    const match = OPEN.exec(line);
    if (match) {
      if (open) {
        errors.push(`line ${i + 1}: region "${match[1]}" opened inside region "${open.id}"; regions cannot nest`);
        continue;
      }
      if (regions.has(match[1])) {
        errors.push(`line ${i + 1}: region "${match[1]}" is declared twice`);
      }
      open = { id: match[1], start: i, body: [] };
      continue;
    }
    if (open) open.body.push(line);
  }

  if (open) errors.push(`region "${open.id}" is never closed`);
  return { regions, errors };
}

export interface MergeResult {
  content: string;
  /** Regions carried over from the previous version. */
  preserved: string[];
  /** Regions that existed before but have no home in the new output. */
  orphaned: Region[];
  errors: string[];
}

/**
 * Splice the user's regions from `previous` into freshly generated `next`.
 *
 * When `previous` is undefined (first generate) the output is `next` unchanged.
 */
export function mergeRegions(next: string, previous: string | undefined): MergeResult {
  if (previous === undefined) {
    return { content: next, preserved: [], orphaned: [], errors: [] };
  }

  const old = parseRegions(previous);
  if (old.errors.length) {
    // Refuse rather than risk a partial merge; the caller keeps the old file.
    return { content: next, preserved: [], orphaned: [], errors: old.errors };
  }
  if (!old.regions.size) {
    return { content: next, preserved: [], orphaned: [], errors: [] };
  }

  const lines = next.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const preserved: string[] = [];
  const used = new Set<string>();
  let skipping: string | null = null;

  for (const line of lines) {
    if (skipping) {
      // Drop whatever the generator put inside the region; the user's wins.
      if (CLOSE.test(line)) {
        out.push(line);
        skipping = null;
      }
      continue;
    }
    const match = OPEN.exec(line);
    out.push(line);
    if (!match) continue;

    const region = old.regions.get(match[1]);
    if (region) {
      if (region.content.trim()) out.push(region.content);
      preserved.push(match[1]);
      used.add(match[1]);
    }
    skipping = match[1];
  }

  const orphaned = [...old.regions.values()].filter((r) => !used.has(r.id) && r.content.trim());
  return { content: out.join('\n'), preserved, orphaned, errors: [] };
}

/** The comment forms a backend uses to open and close a region. */
export function regionMarkers(backend: LanguageBackend, id: string): { open: string; close: string } {
  if (backend.blockComment && backend.lineComment === '<!--') {
    return { open: `<!-- <mcode:region id="${id}"> -->`, close: '<!-- </mcode:region> -->' };
  }
  if (backend.lineComment === '/*') {
    return { open: `/* <mcode:region id="${id}"> */`, close: '/* </mcode:region> */' };
  }
  return { open: `${backend.lineComment} <mcode:region id="${id}">`, close: `${backend.lineComment} </mcode:region>` };
}

/** Wrap user-supplied text in region markers, for templates that seed content. */
export function withRegion(backend: LanguageBackend, id: string, content = ''): string {
  const { open, close } = regionMarkers(backend, id);
  return content ? `${open}\n${content}\n${close}` : `${open}\n${close}`;
}

/** True when the file declares any region, i.e. it is safe to treat as hybrid. */
export function hasRegions(source: string): boolean {
  return OPEN.test(source);
}
