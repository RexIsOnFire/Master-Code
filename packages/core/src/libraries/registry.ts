/**
 * Live package-registry search.
 *
 * The curated catalogue covers the common cases offline; this is how the user
 * reaches everything else. Each language's real index is queried directly over
 * HTTPS - no intermediary, no account, no telemetry.
 *
 * Every function here is opt-in and network-touching, so:
 *  - the caller must pass `allowNetwork: true`, which the CLI and IDE only set
 *    in response to an explicit user action;
 *  - failures are returned, never thrown, because "the registry is unreachable"
 *    is a normal state for a tool that is meant to work offline;
 *  - a short timeout applies, so a hung index cannot hang the editor.
 */

import type { LibraryEntry } from './catalog.ts';
import { searchCatalog } from './catalog.ts';

export interface RegistrySearchOptions {
  language: string;
  query: string;
  limit?: number;
  timeoutMs?: number;
  /** Must be explicitly true; there is no implicit network access. */
  allowNetwork: boolean;
}

export interface RegistrySearchResult {
  /** Results from the live index, empty when offline or on failure. */
  remote: LibraryEntry[];
  /** Matches from the offline catalogue, always populated. */
  local: LibraryEntry[];
  /** Why the remote half is empty, when it is. */
  note?: string;
  source: 'offline' | 'registry';
}

const REGISTRY_HOME: Record<string, string> = {
  pip: 'https://pypi.org',
  npm: 'https://www.npmjs.com',
  cargo: 'https://crates.io',
  nuget: 'https://www.nuget.org',
  maven: 'https://central.sonatype.com',
  gomod: 'https://pkg.go.dev',
  vcpkg: 'https://vcpkg.io',
};

/** Which index serves a language. */
export function managerFor(language: string): string {
  switch (language) {
    case 'python':
      return 'pip';
    case 'javascript':
      return 'npm';
    case 'rust':
      return 'cargo';
    case 'csharp':
      return 'nuget';
    case 'java':
      return 'maven';
    case 'go':
      return 'gomod';
    case 'c':
    case 'cpp':
      return 'vcpkg';
    default:
      return 'cdn';
  }
}

export async function searchRegistry(options: RegistrySearchOptions): Promise<RegistrySearchResult> {
  const limit = options.limit ?? 20;
  const local = searchCatalog(options.query, { language: options.language, limit });

  if (!options.allowNetwork) {
    return {
      remote: [],
      local,
      source: 'offline',
      note: 'Offline: showing the curated catalogue only. Pass --online to search the full index.',
    };
  }

  const manager = managerFor(options.language);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);

  try {
    const remote = await queryIndex(manager, options.language, options.query, limit, controller.signal);
    return { remote, local, source: 'registry' };
  } catch (err) {
    return {
      remote: [],
      local,
      source: 'offline',
      note: `Could not reach ${REGISTRY_HOME[manager] ?? manager}: ${
        err instanceof Error ? err.message : String(err)
      }. Showing the curated catalogue instead.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function queryIndex(
  manager: string,
  language: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<LibraryEntry[]> {
  const q = encodeURIComponent(query.trim());
  switch (manager) {
    case 'npm': {
      const data = await getJson(`https://registry.npmjs.org/-/v1/search?text=${q}&size=${limit}`, signal);
      return (data.objects as RawList).map((o) => {
        const pkg = o.package as Record<string, unknown>;
        return entry({
          name: String(pkg.name),
          version: String(pkg.version ?? '*'),
          summary: String(pkg.description ?? ''),
          license: String((pkg.license as string) ?? 'unknown'),
          homepage: String((pkg.links as Record<string, string>)?.npm ?? `https://www.npmjs.com/package/${pkg.name}`),
          language,
          manager,
          categories: ((pkg.keywords as string[]) ?? []).slice(0, 4),
        });
      });
    }

    case 'pip': {
      // PyPI has no public search API any more, so this resolves the exact name
      // instead. That is honest: an exact lookup is what it can actually do.
      const data = await getJson(`https://pypi.org/pypi/${q}/json`, signal);
      const info = data.info as Record<string, unknown>;
      return [
        entry({
          name: String(info.name),
          version: String(info.version ?? '*'),
          summary: String(info.summary ?? ''),
          license: String(info.license || (info.classifiers as string[])?.find((c) => c.startsWith('License ::')) || 'unknown'),
          homepage: String(info.project_url ?? info.home_page ?? `https://pypi.org/project/${info.name}/`),
          language,
          manager,
          categories: [],
        }),
      ];
    }

    case 'cargo': {
      const data = await getJson(`https://crates.io/api/v1/crates?q=${q}&per_page=${limit}`, signal);
      return (data.crates as RawList).map((c) =>
        entry({
          name: String(c.name),
          version: String(c.max_stable_version ?? c.max_version ?? '*'),
          summary: String(c.description ?? ''),
          license: 'see crate',
          homepage: `https://crates.io/crates/${c.name}`,
          language,
          manager,
          categories: (c.keywords as string[]) ?? [],
        }),
      );
    }

    case 'nuget': {
      const data = await getJson(`https://azuresearch-usnc.nuget.org/query?q=${q}&take=${limit}`, signal);
      return (data.data as RawList).map((p) =>
        entry({
          name: String(p.id),
          version: String(p.version ?? '*'),
          summary: String(p.description ?? ''),
          license: String(p.licenseUrl ? 'see package' : 'unknown'),
          homepage: String(p.projectUrl ?? `https://www.nuget.org/packages/${p.id}`),
          language,
          manager,
          categories: ((p.tags as string[]) ?? []).slice(0, 4),
        }),
      );
    }

    case 'maven': {
      const data = await getJson(
        `https://search.maven.org/solrsearch/select?q=${q}&rows=${limit}&wt=json`,
        signal,
      );
      const docs = ((data.response as Record<string, unknown>)?.docs as RawList) ?? [];
      return docs.map((d) =>
        entry({
          name: `${d.g}:${d.a}`,
          version: String(d.latestVersion ?? d.v ?? '*'),
          summary: `${d.g}:${d.a}`,
          license: 'see artifact',
          homepage: `https://central.sonatype.com/artifact/${d.g}/${d.a}`,
          language,
          manager,
          categories: [],
        }),
      );
    }

    case 'gomod': {
      // The module proxy resolves exact paths rather than searching.
      const version = await getText(`https://proxy.golang.org/${query.toLowerCase()}/@latest`, signal);
      const parsed = JSON.parse(version) as { Version?: string };
      return [
        entry({
          name: query,
          version: String(parsed.Version ?? 'latest'),
          summary: 'Resolved through the Go module proxy.',
          license: 'see module',
          homepage: `https://pkg.go.dev/${query}`,
          language,
          manager,
          categories: [],
        }),
      ];
    }

    default:
      throw new Error(`no registry search is implemented for "${manager}"`);
  }
}

type RawList = Record<string, unknown>[];

function entry(x: Omit<LibraryEntry, 'importHint' | 'peers' | 'heavy'>): LibraryEntry {
  return x;
}

async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const text = await getText(url, signal);
  return JSON.parse(text) as Record<string, unknown>;
}

async function getText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal,
    headers: { accept: 'application/json', 'user-agent': 'mastercode-library-browser' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

/** Where a package's page lives, for the "open homepage" action. */
export function registryHomepage(manager: string, name: string): string {
  switch (manager) {
    case 'npm':
      return `https://www.npmjs.com/package/${name}`;
    case 'pip':
      return `https://pypi.org/project/${name}/`;
    case 'cargo':
      return `https://crates.io/crates/${name}`;
    case 'nuget':
      return `https://www.nuget.org/packages/${name}`;
    case 'maven':
      return `https://central.sonatype.com/artifact/${name.replace(':', '/')}`;
    case 'gomod':
      return `https://pkg.go.dev/${name}`;
    case 'vcpkg':
      return `https://vcpkg.io/en/package/${name}`;
    default:
      return REGISTRY_HOME[manager] ?? '';
  }
}
