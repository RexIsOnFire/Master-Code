/**
 * The semantic model: the durable, language-neutral description of a project.
 *
 * This is what gets saved. Generated source is a build product and can always
 * be thrown away and recreated from here - with the single exception of
 * user-authored regions inside hybrid files, which are read back out of the
 * generated tree before regeneration (see `codegen/regions.ts`).
 *
 * A project carries two graphs, deliberately kept apart:
 *
 *   FILE GRAPH   files, their kinds, and the import edges between them
 *   LOGIC GRAPH  nodes, ports and edges describing behaviour
 *
 * A logic graph belongs to exactly one file. That is what makes the generator
 * produce a real multi-file codebase rather than one giant emitted blob.
 */

import type { TypeRef } from '../types/types.ts';

export const PROJECT_FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * How much of a file the platform owns.
 *
 *  generated - written entirely by the generator; overwritten every build
 *  hybrid    - generated, but user regions inside it are preserved verbatim
 *  user      - authored by hand; the platform reads it for symbols, never writes
 *  external  - outside the project (vendored source, a sibling repo); read-only
 */
export type FileKind = 'generated' | 'hybrid' | 'user' | 'external';

export type FileRole =
  | 'source'
  | 'entry'
  | 'test'
  | 'config'
  | 'asset'
  | 'doc'
  | 'build'
  | 'resource';

export interface ExportedSymbol {
  name: string;
  /** What the symbol is, so importers can generate the right reference form. */
  sort: 'function' | 'class' | 'interface' | 'enum' | 'const' | 'type' | 'variable' | 'unknown';
  type?: TypeRef;
  doc?: string;
}

export interface ProjectFile {
  id: string;
  /**
   * Path relative to the project root, with extension, forward slashes.
   * `src/models/user.py`. This is the single source of truth for location;
   * language-specific roots are part of the path, not implied.
   */
  path: string;
  language: string;
  kind: FileKind;
  role: FileRole;
  /** Owning module, for modular projects. */
  moduleId?: string;
  /** Logic graph rendered into this file, if any. */
  graphId?: string;
  /** Symbols other files may import. Refreshed on generate/scan. */
  exports: ExportedSymbol[];
  /** Explicit import edges. Derived on generate, but user files contribute too. */
  imports: FileImport[];
  /** For `user`/`external` files: content lives on disk, not in the project file. */
  contentRef?: 'disk';
  /** For small generated config files the model owns outright. */
  literalContent?: string;
  /** Free-form per-file settings a backend may read (e.g. HTML page title). */
  options?: Record<string, unknown>;
  /** Set when the user pinned the file so regeneration must not touch it. */
  frozen?: boolean;
}

export interface FileImport {
  /** Target file id (project-internal) or package name (external). */
  to: string;
  scope: 'file' | 'package' | 'stdlib';
  symbols?: string[];
  alias?: string;
  /** True when the generator created it; false when scanned from user code. */
  generated?: boolean;
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export interface ModuleInterfaceMember {
  name: string;
  kind: 'function' | 'class' | 'constant' | 'event' | 'type';
  signature?: TypeRef;
  doc?: string;
}

export interface ProjectModule {
  id: string;
  name: string;
  /** Folder under the source root that holds this module's files. */
  directory: string;
  version: string;
  description?: string;
  /** Public surface. Cross-module references are checked against this. */
  interface: ModuleInterfaceMember[];
  /** Ids of other modules this one may reference. */
  dependencies: string[];
  /** External package names this module needs. */
  packages: string[];
  /** Configuration values surfaced in the properties panel. */
  config: Record<string, unknown>;
  docFileId?: string;
  testFileIds: string[];
  /** Modules can be marked reusable and copied into other projects. */
  reusable?: boolean;
}

// ---------------------------------------------------------------------------
// Logic graph
// ---------------------------------------------------------------------------

export interface Port {
  id: string;
  name: string;
  /** Declared type. May contain type variables, resolved during lowering. */
  type: TypeRef;
  direction: 'in' | 'out';
  /** Literal used when nothing is connected. Encoded as a JSON value. */
  defaultValue?: unknown;
  /** Ports added by the user on a variadic node (e.g. extra format arguments). */
  dynamic?: boolean;
  /** Body-scoped output: visible only inside this node's own branch. */
  bound?: boolean;
  doc?: string;
}

export interface GraphNode {
  id: string;
  /** Node type id from the catalog, e.g. `control/if`, `custom/code`. */
  type: string;
  title?: string;
  x: number;
  y: number;
  width?: number;
  /** Node-type-specific configuration; validated against the node definition. */
  props: Record<string, unknown>;
  /** Instance ports, materialised from the definition plus any dynamic ports. */
  inputs: Port[];
  outputs: Port[];
  collapsed?: boolean;
  comment?: string;
  /** Set false to skip the node during generation without deleting it. */
  enabled?: boolean;
  /** Visual grouping only. */
  groupId?: string;
  breakpoint?: boolean;
}

export interface Edge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
  /** Cached at connect time so the UI can colour the wire without re-inferring. */
  typeHint?: string;
  /** Optional label shown on the wire. */
  label?: string;
}

export interface NodeGroup {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  collapsed?: boolean;
}

export interface Comment {
  id: string;
  text: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/**
 * A logic graph. `style` tells the lowering pass how to read it: the same
 * nodes mean different things in a data-flow pipeline than in a procedural
 * body, and state machines add reachability rules.
 */
export type GraphStyle =
  | 'procedural'
  | 'object-oriented'
  | 'functional'
  | 'event-driven'
  | 'dataflow'
  | 'state-machine'
  | 'pipeline'
  | 'component'
  | 'service';

/**
 * Runtime form of `GraphStyle`, for validating a value and for listing the
 * paradigms in a picker. Order is the order they are offered in.
 */
export const GRAPH_STYLES = [
  'procedural',
  'object-oriented',
  'functional',
  'event-driven',
  'dataflow',
  'state-machine',
  'pipeline',
  'component',
  'service',
] as const satisfies readonly GraphStyle[];

export interface LogicGraph {
  id: string;
  name: string;
  style: GraphStyle;
  /** File this graph generates into. */
  fileId: string;
  nodes: GraphNode[];
  edges: Edge[];
  groups?: NodeGroup[];
  comments?: Comment[];
  /** Graph-scoped variables; become module-level or local depending on style. */
  variables: GraphVariable[];
  viewport?: { x: number; y: number; zoom: number };
}

export interface GraphVariable {
  id: string;
  name: string;
  type: TypeRef;
  initial?: unknown;
  scope: 'module' | 'local' | 'field';
  constant?: boolean;
  doc?: string;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface Dependency {
  /** Package name as the native manager knows it. */
  name: string;
  version: string;
  language: string;
  /** `pip`, `npm`, `nuget`, `maven`, `cargo`, `gomod`, `vcpkg`, `conan`, `cdn`. */
  manager: string;
  source?: string;
  license?: string;
  /** Resolved version recorded at install time; blank until installed. */
  lockVersion?: string;
  /** Present in the manifest but not fetched. The default for this platform. */
  installed?: boolean;
  scope?: 'runtime' | 'dev' | 'build' | 'test';
  notes?: string;
  /**
   * For build systems that sort dependencies into configurations (Gradle's
   * `implementation`, `testImplementation`, `ksp`, ...). Defaults from `scope`.
   * `platform:<configuration>` imports a bill of materials into it.
   */
  configuration?: string;
  /** For multi-module builds: the module that uses it (a Gradle project path). */
  target?: string;
}

// ---------------------------------------------------------------------------
// Capabilities / permissions
// ---------------------------------------------------------------------------

export interface CapabilityGrants {
  'fs.read': boolean;
  'fs.write': boolean;
  net: boolean;
  'net.listen': boolean;
  process: boolean;
  env: boolean;
  time: boolean;
  random: boolean;
  stdio: boolean;
}

export function defaultGrants(): CapabilityGrants {
  return {
    'fs.read': false,
    'fs.write': false,
    net: false,
    'net.listen': false,
    process: false,
    env: false,
    time: true,
    random: true,
    stdio: true,
  };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export type Architecture = 'monolithic' | 'modular';

export interface BuildSettings {
  mode: 'debug' | 'release';
  outputDir: string;
  sourceDir: string;
  generatedDir: string;
  incremental: boolean;
  /** Extra flags per language id. */
  flags: Record<string, string[]>;
  targets?: { os: string; arch: string }[];
}

export interface SandboxSettings {
  enabled: boolean;
  timeoutMs: number;
  memoryLimitMb: number;
  maxOutputBytes: number;
  /** Directories the process may see, relative to the project root. */
  allowedPaths: string[];
  allowNetwork: boolean;
  /** Environment variables passed through; everything else is stripped. */
  envAllowlist: string[];
}

export function defaultSandbox(): SandboxSettings {
  return {
    enabled: true,
    timeoutMs: 20_000,
    memoryLimitMb: 512,
    maxOutputBytes: 1_000_000,
    allowedPaths: ['build', 'assets'],
    allowNetwork: false,
    // Enough for a program to run and for a compiler to find its caches.
    // Go refuses to build without a cache directory, which it derives from
    // LOCALAPPDATA on Windows; cargo and .NET want their own homes. Omitting
    // them sandboxes nothing — the toolchain simply fails.
    envAllowlist: [
      'PATH',
      'Path',
      'HOME',
      'USERPROFILE',
      'SYSTEMROOT',
      'SystemRoot',
      'TEMP',
      'TMP',
      'LANG',
      'PATHEXT',
      // Windows system locations. NuGet resolves its fallback package folder
      // from ProgramFiles and fails with a null-path error without it, which
      // reads as a compiler problem rather than a missing variable.
      'ProgramData',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'ProgramW6432',
      'LOCALAPPDATA',
      'LocalAppData',
      'APPDATA',
      'AppData',
      'GOCACHE',
      'GOPATH',
      'GOROOT',
      'GOMODCACHE',
      'CARGO_HOME',
      'RUSTUP_HOME',
      'DOTNET_CLI_HOME',
      'NUGET_PACKAGES',
      'JAVA_HOME',
      'ANDROID_HOME',
      'ANDROID_SDK_ROOT',
      'GRADLE_USER_HOME',
      'GRADLE_OPTS',
      'KOTLIN_HOME',
    ],
  };
}

export interface Project {
  formatVersion: number;
  id: string;
  name: string;
  description?: string;
  version: string;
  /** Primary language; others may appear on individual files. */
  language: string;
  /** Every language present in the project. */
  languages: string[];
  architecture: Architecture;
  /** Template this project was created from, for reference only. */
  template?: string;
  created: string;
  modified: string;

  files: ProjectFile[];
  modules: ProjectModule[];
  graphs: LogicGraph[];
  dependencies: Dependency[];

  build: BuildSettings;
  sandbox: SandboxSettings;
  grants: CapabilityGrants;

  /** Root package / namespace, used by Java, C#, Go and Rust path generation. */
  namespace?: string;
  author?: string;
  license?: string;

  /** Plugin-contributed data, keyed by plugin id. */
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function findFile(p: Project, id: string): ProjectFile | undefined {
  return p.files.find((f) => f.id === id);
}

export function findFileByPath(p: Project, path: string): ProjectFile | undefined {
  const norm = path.replace(/\\/g, '/');
  return p.files.find((f) => f.path === norm);
}

export function findGraph(p: Project, id: string): LogicGraph | undefined {
  return p.graphs.find((g) => g.id === id);
}

export function graphForFile(p: Project, fileId: string): LogicGraph | undefined {
  return p.graphs.find((g) => g.fileId === fileId);
}

export function findModule(p: Project, id: string): ProjectModule | undefined {
  return p.modules.find((m) => m.id === id);
}

export function findNode(g: LogicGraph, id: string): GraphNode | undefined {
  return g.nodes.find((n) => n.id === id);
}

export function findPort(n: GraphNode, id: string): Port | undefined {
  return n.inputs.find((p) => p.id === id) ?? n.outputs.find((p) => p.id === id);
}

export function edgesInto(g: LogicGraph, nodeId: string, portId?: string): Edge[] {
  return g.edges.filter((e) => e.to.node === nodeId && (portId === undefined || e.to.port === portId));
}

export function edgesOutOf(g: LogicGraph, nodeId: string, portId?: string): Edge[] {
  return g.edges.filter((e) => e.from.node === nodeId && (portId === undefined || e.from.port === portId));
}

export function touch(p: Project): void {
  p.modified = new Date().toISOString();
}
