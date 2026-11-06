/**
 * Escape hatches and cross-boundary references.
 *
 * The Custom Code node is what stops the platform from being a closed world:
 * anything the visual vocabulary cannot express can be written directly in the
 * target language, wrapped in a typed signature, and reused like any other
 * node. It generates a real named function in the output - not an inlined
 * fragment - so the generated project stays readable and the snippet is
 * callable from hand-written code too.
 */

import type { NodeDefinition, PropSpec } from '../definition.ts';
import { execIn, execOut, port, toIdentifier } from '../definition.ts';
import { E, S, at } from '../../ir/build.ts';
import type { Capability, IrFunction, IrParam, IrRawDecl } from '../../ir/ir.ts';
import { VISIBILITIES } from '../../ir/ir.ts';
import { T, parseType } from '../../types/types.ts';

interface PortDef {
  name: string;
  type: string;
  default?: string;
}

/** Languages a Custom Code family node may be pinned to. */
const LANGUAGE_OPTIONS = [
  { value: 'any', label: 'Any (must match the file)' },
  { value: 'python', label: 'Python' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'java', label: 'Java' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'csharp', label: 'C#' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
];

/** Annotation text, without its sigil; non-strings and blanks are dropped. */
export function readAnnotations(props: Record<string, unknown>, key = 'annotations'): string[] | undefined {
  const raw = props[key];
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .filter((a): a is string => typeof a === 'string')
    .map((a) => a.trim().replace(/^@/, ''))
    .filter(Boolean);
  return list.length ? list : undefined;
}

/** The annotation property every declaring node offers. */
export const ANNOTATIONS_PROP: PropSpec = {
  name: 'annotations',
  label: 'Annotations',
  kind: 'json',
  default: [],
  doc: 'Annotation text without the @, e.g. ["Composable"] or ["Entity(tableName = \"note\")"]. Only languages with annotations accept them.',
};

function splitNames(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return list.map((x) => String(x).trim()).filter(Boolean);
}

/** Declared capabilities and packages are shared by every Custom node. */
function requireDeclared(ctx: Parameters<NodeDefinition['lower']>[0]): Capability[] {
  const caps = (ctx.prop<string[]>('capabilities', []) ?? []).filter(Boolean) as Capability[];
  caps.forEach((c) => ctx.requireCapability(c));
  for (const pkg of ctx.prop<(string | { name: string; version?: string })[]>('packages', []) ?? []) {
    if (typeof pkg === 'string') ctx.requirePackage(pkg);
    else if (pkg?.name) ctx.requirePackage(pkg.name, pkg.version);
  }
  return caps;
}

function languageMismatch(ctx: Parameters<NodeDefinition['lower']>[0], what: string): boolean {
  const declared = ctx.prop('language', 'any');
  if (declared === 'any' || declared === ctx.language) return false;
  ctx.error(
    'custom/language-mismatch',
    `This ${what} is written in ${declared}, but the file targets ${ctx.language}.`,
    `Either set the node's language to "${ctx.language}", or move it into a ${declared} file.`,
  );
  return true;
}

const CAPABILITY_PROPS = [
  {
    name: 'capabilities',
    label: 'Capabilities used',
    kind: 'json' as const,
    default: [],
    doc: 'Declare fs.read, fs.write, net, process or env so the sandbox pre-check sees them. Undeclared capabilities are still blocked at run time.',
  },
  {
    name: 'packages',
    label: 'Packages required',
    kind: 'json' as const,
    default: [],
    doc: 'Array of package names, or { name, version }. Added to the manifest, never installed automatically.',
  },
];

function readPorts(props: Record<string, unknown>, key: string): PortDef[] {
  const raw = props[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is PortDef => !!p && typeof p === 'object' && typeof (p as PortDef).name === 'string')
    .map((p) => ({ name: toIdentifier(p.name), type: p.type || 'Any', default: p.default }));
}

export const customNodes: NodeDefinition[] = [
  // -------------------------------------------------------------------------
  {
    type: 'custom/code',
    category: 'Custom',
    title: 'Custom Code',
    description:
      'A typed block of target-language source. Generates a named function with the declared signature and calls it, so the snippet is reusable and reviewable in the generated project.',
    keywords: ['snippet', 'raw', 'script', 'inline', 'escape', 'native', 'low-code'],
    inputs: [execIn()],
    outputs: [execOut()],
    props: [
      { name: 'name', label: 'Function name', kind: 'identifier', default: 'custom_step' },
      {
        name: 'language',
        label: 'Language',
        kind: 'select',
        default: 'any',
        options: LANGUAGE_OPTIONS,
      },
      { name: 'params', label: 'Inputs', kind: 'ports', default: [] },
      { name: 'returns', label: 'Output type', kind: 'type', default: 'Void' },
      { name: 'code', label: 'Source', kind: 'code', default: '', language: 'python' },
      {
        name: 'form',
        label: 'Body form',
        kind: 'select',
        default: 'statements',
        options: [
          { value: 'statements', label: 'Statements (use return)' },
          { value: 'expression', label: 'Single expression' },
        ],
      },
      ...CAPABILITY_PROPS,
      { name: 'doc', label: 'Documentation', kind: 'text', default: '' },
    ],
    ports(props) {
      const params = readPorts(props, 'params');
      const returns = String(props.returns ?? 'Void');
      const outs = [execOut()];
      if (returns !== 'Void') outs.push(port('result', 'result', returns));
      return {
        inputs: [execIn(), ...params.map((p) => port(`p:${p.name}`, p.name, p.type, { default: p.default }))],
        outputs: outs,
      };
    },
    color: '#f97316',
    validate(node, _project, diag) {
      const code = String(node.props.code ?? '').trim();
      if (!code) {
        diag.warn('graph', 'custom/empty', 'Custom Code node has no source.', {
          origin: { nodeId: node.id },
          hint: 'Write the body, or delete the node.',
        });
      }
    },
    lower(ctx) {
      if (languageMismatch(ctx, 'Custom Code node')) return { stmts: ctx.execBranch('out') };

      const name = ctx.ident('name', 'custom_step');
      const params = readPorts(ctx.node.props, 'params');
      const returns = ctx.propType('returns', T.void);
      const code = ctx.prop('code', '');
      const caps = requireDeclared(ctx);

      const irParams: IrParam[] = params.map((p) => ({ name: p.name, type: parseType(p.type) }));
      const body =
        ctx.prop('form', 'statements') === 'expression'
          ? [S.return_(E.raw(ctx.language, code, returns, caps))]
          : [S.raw(ctx.language, code, caps)];

      const fn: IrFunction = {
        k: 'function',
        name,
        params: irParams,
        returns,
        body,
        visibility: 'public',
        doc: ctx.prop('doc', '') || `Custom ${ctx.language} step.`,
        origin: ctx.origin,
      };
      ctx.emitDecl(fn);

      const args = params.map((p) => ctx.input(`p:${p.name}`));
      const call = at(E.call(E.ref(name, T.fn(irParams.map((p) => p.type), returns)), args, returns, caps), ctx.origin);

      if (returns.kind === 'void') {
        return { stmts: [at(S.expr(call), ctx.origin), ...ctx.execBranch('out')] };
      }
      const tmp = ctx.temp(name);
      const ref = E.ref(tmp, returns);
      ctx.bindOutput('result', ref);
      const decl = at(S.let_(tmp, returns, call, false), ctx.origin);
      return { stmts: [decl, ...ctx.execBranch('out')], exprs: { result: ref } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'custom/inline',
    category: 'Custom',
    title: 'Inline Expression',
    description:
      'A single target-language expression, dropped in verbatim. Use it for a one-liner; use Custom Code when the snippet deserves a name.',
    keywords: ['raw', 'literal', 'verbatim', 'snippet', 'low-code'],
    pure: true,
    inputs: [],
    outputs: [port('value', 'value', 'Any')],
    props: [
      { name: 'code', label: 'Expression', kind: 'code', default: '', language: 'python' },
      { name: 'type', label: 'Type', kind: 'type', default: 'Any' },
      {
        name: 'language',
        label: 'Language',
        kind: 'select',
        default: 'any',
        options: LANGUAGE_OPTIONS,
      },
    ],
    ports(props) {
      return { inputs: [], outputs: [port('value', 'value', String(props.type ?? 'Any'))] };
    },
    color: '#f97316',
    lower(ctx) {
      if (languageMismatch(ctx, 'Inline Expression')) return { exprs: { value: E.null() } };
      const type = ctx.propType('type', T.any);
      return { exprs: { value: at(E.raw(ctx.language, ctx.prop('code', ''), type), ctx.origin) } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'custom/function',
    category: 'Custom',
    title: 'Custom Function',
    description:
      'Declares one function - or a method, when a class is named - whose signature is drawn on the canvas and whose body is written in the target language. It is the declaration itself rather than a step in a chain, so the generated file holds exactly one function.',
    keywords: ['function', 'method', 'snippet', 'native', 'body', 'low-code', 'declaration'],
    root: true,
    inputs: [],
    outputs: [],
    props: [
      { name: 'name', label: 'Name', kind: 'identifier', default: 'customFunction' },
      {
        name: 'className',
        label: 'Class',
        kind: 'identifier',
        default: '',
        doc: 'Empty for a module-level function. Name a class declared in this graph to make it a method of that class.',
      },
      { name: 'params', label: 'Parameters', kind: 'ports', default: [] },
      { name: 'returns', label: 'Returns', kind: 'type', default: 'Void' },
      { name: 'isAsync', label: 'Async', kind: 'boolean', default: false },
      { name: 'isStatic', label: 'Static', kind: 'boolean', default: false },
      {
        name: 'isOverride',
        label: 'Overrides',
        kind: 'boolean',
        default: false,
        doc: 'Set when the method replaces one inherited from a supertype.',
      },
      {
        name: 'visibility',
        label: 'Visibility',
        kind: 'select',
        default: 'public',
        options: [
          { value: 'public', label: 'Public' },
          { value: 'private', label: 'Private' },
          { value: 'internal', label: 'Internal' },
        ],
      },
      { name: 'generics', label: 'Type parameters', kind: 'string', default: '', doc: 'Comma-separated, e.g. T, U.' },
      ANNOTATIONS_PROP,
      { name: 'language', label: 'Language', kind: 'select', default: 'any', options: LANGUAGE_OPTIONS },
      { name: 'code', label: 'Body', kind: 'code', default: '' },
      {
        name: 'form',
        label: 'Body form',
        kind: 'select',
        default: 'statements',
        options: [
          { value: 'statements', label: 'Statements (use return)' },
          { value: 'expression', label: 'Single expression' },
        ],
      },
      ...CAPABILITY_PROPS,
      { name: 'doc', label: 'Documentation', kind: 'text', default: '' },
    ],
    color: '#f97316',
    validate(node, _project, diag) {
      if (!String(node.props.code ?? '').trim()) {
        diag.warn('graph', 'custom/empty', 'Custom Function has no body.', {
          origin: { nodeId: node.id },
          hint: 'Write the body, or delete the node.',
        });
      }
    },
    lower(ctx) {
      if (languageMismatch(ctx, 'Custom Function')) return {};
      const caps = requireDeclared(ctx);
      const returns = ctx.propType('returns', T.void);
      const code = ctx.prop('code', '');
      const params: IrParam[] = readPorts(ctx.node.props, 'params').map((p) => ({
        name: p.name,
        type: parseType(p.type),
        default: p.default ? E.raw(ctx.language, p.default, parseType(p.type)) : undefined,
      }));
      const className = ctx.prop('className', '').trim();
      const fn: IrFunction = {
        k: 'function',
        name: ctx.ident('name', 'customFunction'),
        params,
        returns,
        body:
          ctx.prop('form', 'statements') === 'expression'
            ? [S.return_(E.raw(ctx.language, code, returns, caps))]
            : [S.raw(ctx.language, code, caps)],
        isAsync: ctx.prop('isAsync', false),
        isStatic: className ? ctx.prop('isStatic', false) : undefined,
        isOverride: className ? ctx.prop('isOverride', false) : undefined,
        visibility: ctx.oneOf('visibility', VISIBILITIES, 'public'),
        generics: splitNames(ctx.prop('generics', '')),
        annotations: readAnnotations(ctx.node.props),
        doc: ctx.prop('doc', ''),
        origin: ctx.origin,
      };
      if (className) return { members: [{ className: toIdentifier(className), method: fn }] };
      return { decls: [fn] };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'custom/declaration',
    category: 'Custom',
    title: 'Custom Declaration',
    description:
      'Top-level declarations written verbatim in the target language, for what the visual vocabulary cannot model: an abstract framework base class, an extension function, a parameter whose type carries an annotation. The names it declares are listed so other files can still import them.',
    keywords: ['raw', 'declaration', 'verbatim', 'class', 'escape', 'native', 'low-code'],
    root: true,
    inputs: [],
    outputs: [],
    props: [
      { name: 'language', label: 'Language', kind: 'select', default: 'any', options: LANGUAGE_OPTIONS },
      { name: 'code', label: 'Source', kind: 'code', default: '' },
      {
        name: 'provides',
        label: 'Declares',
        kind: 'json',
        default: [],
        doc: 'Names this source declares that other files may use. Each becomes an export of this file.',
      },
      ...CAPABILITY_PROPS,
      { name: 'doc', label: 'Documentation', kind: 'text', default: '' },
    ],
    color: '#f97316',
    validate(node, _project, diag) {
      if (!String(node.props.code ?? '').trim()) {
        diag.warn('graph', 'custom/empty', 'Custom Declaration has no source.', {
          origin: { nodeId: node.id },
          hint: 'Write the declaration, or delete the node.',
        });
      }
    },
    lower(ctx) {
      if (languageMismatch(ctx, 'Custom Declaration')) return {};
      const decl: IrRawDecl = {
        k: 'rawDecl',
        lang: ctx.language,
        code: ctx.prop('code', ''),
        provides: splitNames(ctx.node.props.provides),
        caps: requireDeclared(ctx),
        origin: ctx.origin,
      };
      return { decls: [decl] };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'module/imports',
    category: 'Modules',
    title: 'Library Imports',
    description:
      'Names this file imports from libraries and the standard library, spelled as the language spells them (`androidx.room.Entity`, `kotlinx.coroutines.flow.Flow`). Custom source is opaque to import resolution, so its library imports are declared here. Dependencies are managed separately; nothing is added to the manifest.',
    keywords: ['import', 'using', 'use', 'require', 'library', 'package'],
    root: true,
    inputs: [],
    outputs: [],
    props: [{ name: 'imports', label: 'Imports', kind: 'json', default: [] }],
    color: '#94a3b8',
    lower(ctx) {
      for (const target of splitNames(ctx.node.props.imports)) ctx.require({ source: 'package', target });
      return {};
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'module/import',
    category: 'Modules',
    title: 'External Import',
    description:
      'Declares a dependency on a library and exposes one of its symbols. The package is recorded in the manifest; nothing is downloaded until you ask for it.',
    keywords: ['library', 'package', 'dependency', 'require', 'use', 'include'],
    pure: true,
    inputs: [],
    outputs: [port('symbol', 'symbol', 'Any')],
    props: [
      { name: 'package', label: 'Package', kind: 'string', default: '' },
      { name: 'version', label: 'Version', kind: 'string', default: '*' },
      { name: 'symbol', label: 'Symbol', kind: 'string', default: '' },
      { name: 'alias', label: 'Alias', kind: 'identifier', default: '' },
      { name: 'type', label: 'Type', kind: 'type', default: 'Any' },
      {
        name: 'stdlib',
        label: 'Standard library',
        kind: 'boolean',
        default: false,
        doc: 'Set for modules shipped with the language; no manifest entry is added.',
      },
    ],
    ports(props) {
      return { inputs: [], outputs: [port('symbol', 'symbol', String(props.type ?? 'Any'))] };
    },
    color: '#94a3b8',
    lower(ctx) {
      const pkg = ctx.prop('package', '').trim();
      const symbol = ctx.prop('symbol', '').trim();
      const alias = ctx.prop('alias', '').trim();
      const stdlib = ctx.prop('stdlib', false);
      if (!pkg) {
        ctx.error('import/no-package', 'External Import has no package name.');
        return { exprs: { symbol: E.null() } };
      }
      ctx.require({
        source: stdlib ? 'stdlib' : 'package',
        target: pkg,
        symbols: symbol ? [{ name: symbol, alias: alias || undefined }] : undefined,
        alias: symbol ? undefined : alias || undefined,
      });
      if (!stdlib) ctx.requirePackage(pkg, ctx.prop('version', '*'));
      const name = alias || symbol || pkg;
      return { exprs: { symbol: at(E.symbol(name, ctx.propType('type', T.any)), ctx.origin) } };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'module/use',
    category: 'Modules',
    title: 'Use Module Member',
    description:
      'References a member of another module in this project through its public interface. The file graph turns this into the correct import for the target language.',
    keywords: ['reference', 'cross module', 'interface', 'depend'],
    pure: true,
    inputs: [],
    outputs: [port('symbol', 'symbol', 'Any')],
    props: [
      { name: 'module', label: 'Module', kind: 'symbol', default: '' },
      { name: 'member', label: 'Member', kind: 'symbol', default: '' },
      { name: 'type', label: 'Type', kind: 'type', default: 'Any' },
    ],
    ports(props) {
      return { inputs: [], outputs: [port('symbol', 'symbol', String(props.type ?? 'Any'))] };
    },
    color: '#94a3b8',
    validate(node, project, diag) {
      const moduleId = String(node.props.module ?? '');
      const member = String(node.props.member ?? '');
      if (!moduleId || !member) return;
      const mod = project.modules.find((m) => m.id === moduleId || m.name === moduleId);
      if (!mod) {
        diag.error('graph', 'module/unknown', `No module named "${moduleId}".`, { origin: { nodeId: node.id } });
        return;
      }
      if (!mod.interface.some((i) => i.name === member)) {
        diag.error(
          'graph',
          'module/not-public',
          `"${member}" is not part of module ${mod.name}'s public interface.`,
          {
            origin: { nodeId: node.id },
            hint: `Public members: ${mod.interface.map((i) => i.name).join(', ') || '(none)'}`,
          },
        );
      }
    },
    lower(ctx) {
      const moduleId = ctx.prop('module', '');
      const member = ctx.prop('member', '');
      const mod = ctx.project.modules.find((m) => m.id === moduleId || m.name === moduleId);
      if (!mod) {
        ctx.error('module/unknown', `No module named "${moduleId}".`);
        return { exprs: { symbol: E.null() } };
      }
      // The concrete import is resolved later, once the file graph knows which
      // file inside the module actually exports the symbol.
      return {
        exprs: {
          symbol: at(E.symbol(member, ctx.propType('type', T.any), `module:${mod.id}`), ctx.origin),
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'test/case',
    category: 'Testing',
    title: 'Test Case',
    description: 'A single test. The execution chain is the test body; assertions inside it decide pass or fail.',
    keywords: ['unit test', 'spec', 'check', 'verify'],
    root: true,
    inputs: [],
    outputs: [execOut('out', 'body')],
    props: [
      { name: 'name', label: 'Test name', kind: 'identifier', default: 'test_behaviour' },
      {
        name: 'kind',
        label: 'Kind',
        kind: 'select',
        default: 'unit',
        options: [
          { value: 'unit', label: 'Unit' },
          { value: 'integration', label: 'Integration' },
          { value: 'component', label: 'Component' },
          { value: 'regression', label: 'Regression' },
        ],
      },
      { name: 'doc', label: 'Description', kind: 'text', default: '' },
    ],
    color: '#4ade80',
    lower(ctx) {
      const raw = ctx.ident('name', 'test_behaviour');
      const name = raw.startsWith('test') ? raw : `test_${raw}`;
      const fn: IrFunction = {
        k: 'function',
        name,
        params: [],
        returns: T.void,
        body: ctx.execBranch('out'),
        visibility: 'public',
        isTest: true,
        doc: ctx.prop('doc', '') || `${ctx.prop('kind', 'unit')} test.`,
        origin: ctx.origin,
      };
      return { decls: [fn] };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'test/assert-equal',
    category: 'Testing',
    title: 'Assert Equal',
    description: 'Fails the test unless two values are equal.',
    keywords: ['expect', 'check', 'equals', 'should'],
    inputs: [execIn(), port('actual', 'actual', 'Any'), port('expected', 'expected', 'Any')],
    outputs: [execOut()],
    props: [{ name: 'message', label: 'Message', kind: 'string', default: '' }],
    color: '#4ade80',
    lower(ctx) {
      const msg = ctx.prop('message', '') || 'values differ';
      return {
        stmts: [
          at(
            S.expr(
              E.builtin('assert_eq', [ctx.input('actual'), ctx.input('expected'), E.str(msg)], T.void),
            ),
            ctx.origin,
          ),
          ...ctx.execBranch('out'),
        ],
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    type: 'test/assert',
    category: 'Testing',
    title: 'Assert True',
    description: 'Fails the test unless the condition holds.',
    keywords: ['expect', 'check', 'require', 'should'],
    inputs: [execIn(), port('cond', 'condition', 'bool', { default: true })],
    outputs: [execOut()],
    props: [{ name: 'message', label: 'Message', kind: 'string', default: '' }],
    color: '#4ade80',
    lower(ctx) {
      const msg = ctx.prop('message', '') || 'assertion failed';
      return {
        stmts: [
          at(S.expr(E.builtin('assert', [ctx.input('cond'), E.str(msg)], T.void)), ctx.origin),
          ...ctx.execBranch('out'),
        ],
      };
    },
  },
];
