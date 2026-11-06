/**
 * The optional AI assistance layer.
 *
 * Two rules shape this module:
 *
 *  1. **Nothing is applied automatically.** Every capability returns a
 *     `Proposal` - a described, reviewable set of changes. The user accepts or
 *     rejects it. A tool that silently rewrites someone's project because a
 *     model suggested it is not an assistant.
 *  2. **It is genuinely optional.** No core path imports a provider. With no
 *     provider configured the platform is fully functional; the AI panel simply
 *     reports that none is set up.
 *
 * The provider interface is deliberately small - one text call and one
 * structured call - so a local model, a hosted API, or a stub for tests all
 * satisfy it.
 */

import type { Diagnostic } from '../diagnostics.ts';
import type { LogicGraph, Project } from '../model/project.ts';

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface CompletionRequest {
  /** Instruction describing the assistant's role for this call. */
  system: string;
  /** The user-visible request. */
  prompt: string;
  /** Rough ceiling on the reply. */
  maxTokens?: number;
  /**
   * How much reasoning effort to spend. Providers that have no equivalent
   * ignore it.
   */
  effort?: 'low' | 'medium' | 'high';
  /** JSON schema the reply must satisfy, for structured calls. */
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  /** Parsed object, when a schema was supplied. */
  value?: unknown;
  /** True when the provider declined rather than answered. */
  declined?: boolean;
  declineReason?: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AiProvider {
  readonly id: string;
  readonly name: string;
  /** Whether this provider can run right now (credentials present, etc.). */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ProposalChange =
  | { kind: 'note'; title: string; body: string }
  | { kind: 'file'; path: string; before?: string; after: string; summary: string }
  | { kind: 'graph'; graphId: string; summary: string; patch: GraphPatch }
  | { kind: 'dependency'; language: string; name: string; version: string; summary: string };

/** A minimal, reviewable graph edit. Applied only on acceptance. */
export interface GraphPatch {
  addNodes?: { type: string; props: Record<string, unknown>; x: number; y: number }[];
  removeNodeIds?: string[];
  setProps?: { nodeId: string; props: Record<string, unknown> }[];
  addEdges?: { from: { node: string; port: string }; to: { node: string; port: string } }[];
  removeEdgeIds?: string[];
}

export interface Proposal {
  id: string;
  /** Which assistant produced it. */
  capability: string;
  title: string;
  /** Plain-language explanation, shown above the diff. */
  rationale: string;
  changes: ProposalChange[];
  /** Set when the model was unsure; surfaced prominently in the UI. */
  caveats?: string[];
  createdAt: string;
  model?: string;
}

let proposalCounter = 0;

export function makeProposal(
  capability: string,
  title: string,
  rationale: string,
  changes: ProposalChange[],
  extra: Partial<Proposal> = {},
): Proposal {
  proposalCounter += 1;
  return {
    id: `proposal_${Date.now().toString(36)}_${proposalCounter}`,
    capability,
    title,
    rationale,
    changes,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface AssistContext {
  project: Project;
  graph?: LogicGraph;
  /** Generated source, when the question is about output rather than the graph. */
  source?: { path: string; content: string }[];
  diagnostics?: Diagnostic[];
}

const SYSTEM = `You are assisting inside Master Code, a visual programming environment that
compiles node graphs to real source code in ten languages. You are advising a
developer who can read code.

Be concrete and brief. When you are unsure, say so rather than guessing - a
wrong confident answer costs more than an honest "I don't know". Never claim a
change was made; you are proposing, and the user decides.`;

export class AiAssistant {
  private readonly provider: AiProvider;

  constructor(provider: AiProvider) {
    this.provider = provider;
  }

  /** Plain-language explanation of what a node or graph does. */
  async explain(context: AssistContext, subject: string): Promise<Proposal> {
    const result = await this.provider.complete({
      system: SYSTEM,
      prompt: [
        `Explain this to someone reading the project for the first time: ${subject}`,
        '',
        describeContext(context),
      ].join('\n'),
      maxTokens: 1500,
      effort: 'low',
    });
    return this.wrap('explain', `Explanation: ${subject}`, result, [
      { kind: 'note', title: subject, body: result.text },
    ]);
  }

  /** Suggest documentation for the project's modules and public interfaces. */
  async document(context: AssistContext): Promise<Proposal> {
    const result = await this.provider.complete({
      system: SYSTEM,
      prompt: [
        'Write a README for this project. Cover what it does, how it is structured,',
        'and how to build and run it. Use the actual file and module names.',
        '',
        describeContext(context),
      ].join('\n'),
      maxTokens: 4000,
      effort: 'medium',
    });
    return this.wrap('document', 'Proposed README', result, [
      { kind: 'file', path: 'README.md', after: result.text, summary: 'Generated project documentation.' },
    ]);
  }

  /** Explain a build error in terms of the graph, not the generated code. */
  async explainDiagnostic(context: AssistContext, diagnostic: Diagnostic): Promise<Proposal> {
    const result = await this.provider.complete({
      system: SYSTEM,
      prompt: [
        'A build produced this diagnostic. Explain what it means and what to change',
        'in the visual graph to fix it. If the fix is not in the graph, say where it is.',
        '',
        `code: ${diagnostic.code}`,
        `message: ${diagnostic.message}`,
        diagnostic.file ? `file: ${diagnostic.file}:${diagnostic.line ?? '?'}` : '',
        diagnostic.origin?.nodeId ? `node: ${diagnostic.origin.nodeId}` : '',
        '',
        describeContext(context),
      ]
        .filter(Boolean)
        .join('\n'),
      maxTokens: 1500,
      effort: 'medium',
    });
    return this.wrap('explain-error', `Why: ${diagnostic.code}`, result, [
      { kind: 'note', title: diagnostic.message, body: result.text },
    ]);
  }

  /** Suggest tests for the project's public interface. */
  async suggestTests(context: AssistContext): Promise<Proposal> {
    const result = await this.provider.complete({
      system: SYSTEM,
      prompt: [
        'Propose a list of tests for this project. For each: a name, what it sets up,',
        'what it calls, and what it asserts. Prefer tests that would actually catch a',
        'regression over tests that restate the implementation.',
        '',
        describeContext(context),
      ].join('\n'),
      maxTokens: 2500,
      effort: 'medium',
    });
    return this.wrap('suggest-tests', 'Suggested tests', result, [
      { kind: 'note', title: 'Test suggestions', body: result.text },
    ]);
  }

  /** Suggest an architecture for a described application. */
  async suggestArchitecture(description: string, language: string): Promise<Proposal> {
    const result = await this.provider.complete({
      system: SYSTEM,
      prompt: [
        `Propose a file and module layout for a ${language} project that does the following:`,
        description,
        '',
        'Give the directory tree, then one line per file saying what it holds and what it',
        'imports. Keep it as small as the problem allows.',
      ].join('\n'),
      maxTokens: 2000,
      effort: 'medium',
    });
    return this.wrap('architecture', 'Proposed architecture', result, [
      { kind: 'note', title: 'Architecture', body: result.text },
    ]);
  }

  /** Translate a generated file into another supported language. */
  async translate(source: { path: string; content: string }, toLanguage: string): Promise<Proposal> {
    const result = await this.provider.complete({
      system: SYSTEM,
      prompt: [
        `Translate this file to idiomatic ${toLanguage}. Keep the behaviour identical.`,
        'Where the target language has no equivalent for something, say so in a comment',
        'rather than approximating silently.',
        '',
        `--- ${source.path} ---`,
        source.content,
      ].join('\n'),
      maxTokens: 8000,
      effort: 'high',
    });
    return this.wrap('translate', `Translate ${source.path} to ${toLanguage}`, result, [
      {
        kind: 'file',
        path: `${source.path}.${toLanguage}.proposed`,
        before: source.content,
        after: result.text,
        summary: `Translation to ${toLanguage}, for review.`,
      },
    ]);
  }

  private wrap(
    capability: string,
    title: string,
    result: CompletionResult,
    changes: ProposalChange[],
  ): Proposal {
    if (result.declined) {
      return makeProposal(capability, title, 'The assistant declined this request.', [], {
        caveats: [result.declineReason ?? 'No reason was given.'],
        model: result.model,
      });
    }
    return makeProposal(capability, title, result.text.split('\n').slice(0, 3).join(' '), changes, {
      model: result.model,
    });
  }
}

// ---------------------------------------------------------------------------

function describeContext(context: AssistContext): string {
  const lines: string[] = [];
  const p = context.project;
  lines.push(`Project: ${p.name} (${p.language}, ${p.architecture})`);
  if (p.description) lines.push(`Description: ${p.description}`);
  lines.push('Files:');
  for (const f of p.files.slice(0, 60)) {
    lines.push(`  ${f.path} [${f.language}, ${f.kind}] exports: ${f.exports.map((e) => e.name).join(', ') || '-'}`);
  }
  if (p.modules.length) {
    lines.push('Modules:');
    for (const m of p.modules) lines.push(`  ${m.name} (${m.directory}): ${m.interface.map((i) => i.name).join(', ')}`);
  }
  if (context.graph) {
    lines.push(`Open graph: "${context.graph.name}" (${context.graph.style}), ${context.graph.nodes.length} nodes`);
    for (const n of context.graph.nodes.slice(0, 40)) {
      lines.push(`  ${n.id} ${n.type} ${JSON.stringify(n.props).slice(0, 120)}`);
    }
  }
  for (const file of context.source ?? []) {
    lines.push(`--- ${file.path} ---`);
    lines.push(file.content.slice(0, 6000));
  }
  if (context.diagnostics?.length) {
    lines.push('Diagnostics:');
    for (const d of context.diagnostics.slice(0, 20)) lines.push(`  ${d.severity} ${d.code}: ${d.message}`);
  }
  return lines.join('\n');
}

/** A provider that always declines, so the UI has something to bind to. */
export const nullProvider: AiProvider = {
  id: 'none',
  name: 'No provider configured',
  async available() {
    return {
      ok: false,
      reason:
        'No AI provider is configured. Set one up in Settings, or run without it - every other feature works offline.',
    };
  },
  async complete() {
    return { text: '', declined: true, declineReason: 'No AI provider is configured.' };
  },
};
