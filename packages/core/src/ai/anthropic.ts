/**
 * Anthropic provider for the AI assistance layer.
 *
 * This is the one place in the repository that has an optional dependency. The
 * rest of Master Code runs with nothing installed; this provider needs the
 * official SDK, so it imports it dynamically and reports a clear, actionable
 * message when it is absent rather than failing at load time:
 *
 *     npm install @anthropic-ai/sdk
 *
 * The dynamic import is deliberate. Importing the SDK at module scope would
 * make `packages/core` unloadable without `node_modules`, which would undo the
 * property the whole project is built on.
 */

import type { AiProvider, CompletionRequest, CompletionResult } from './provider.ts';

export interface AnthropicProviderOptions {
  /**
   * Defaults to `claude-opus-5`. The SDK also resolves credentials on its own:
   * `ANTHROPIC_API_KEY`, then an OAuth profile from `ant auth login`.
   */
  model?: string;
  apiKey?: string;
  /** Reasoning depth. Omitted requests use the API default. */
  effort?: 'low' | 'medium' | 'high';
}

const DEFAULT_MODEL = 'claude-opus-5';

/** Beta flag for the server-side fallback that re-runs a declined request. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

interface SdkModule {
  default: new (options: { apiKey?: string }) => AnthropicClientLike;
}

interface AnthropicClientLike {
  beta: {
    messages: {
      create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AnthropicMessage>;
      stream(params: Record<string, unknown>, options?: { signal?: AbortSignal }): {
        finalMessage(): Promise<AnthropicMessage>;
      };
    };
  };
}

interface AnthropicMessage {
  model?: string;
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string } | null;
  content: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): AiProvider {
  const model = options.model ?? DEFAULT_MODEL;
  let client: AnthropicClientLike | undefined;
  let loadError: string | undefined;

  const load = async (): Promise<AnthropicClientLike | undefined> => {
    if (client || loadError) return client;
    try {
      // The SDK is an optional peer dependency, deliberately absent from
      // package.json so the core installs with none. The specifier is built at
      // runtime so a type check on a machine without it does not fail here;
      // a missing module surfaces as the friendly message below.
      const specifier = ['@anthropic-ai', 'sdk'].join('/');
      const sdk = (await import(specifier)) as unknown as SdkModule;
      client = new sdk.default({ apiKey: options.apiKey });
      return client;
    } catch (err) {
      loadError =
        err instanceof Error && /Cannot find (module|package)/.test(err.message)
          ? 'The Anthropic SDK is not installed. Run: npm install @anthropic-ai/sdk'
          : `Could not initialise the Anthropic SDK: ${err instanceof Error ? err.message : String(err)}`;
      return undefined;
    }
  };

  return {
    id: 'anthropic',
    name: `Anthropic (${model})`,

    async available() {
      const loaded = await load();
      if (!loaded) return { ok: false, reason: loadError ?? 'unavailable' };
      // The SDK resolves credentials itself (API key, then OAuth profile), so
      // an unset ANTHROPIC_API_KEY is not on its own a failure.
      return { ok: true };
    },

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const loaded = await load();
      if (!loaded) return { text: '', declined: true, declineReason: loadError };

      const maxTokens = request.maxTokens ?? 4000;
      const params: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        // Adaptive thinking is the current mode; the model decides how much to
        // spend, and `effort` scales it.
        thinking: { type: 'adaptive' },
        // Claude Opus 5's safety classifiers can decline a request. The
        // server-side fallback re-runs it on Anthropic's recommended model in
        // the same call, so a false positive on benign work still gets served.
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      };
      const effort = request.effort ?? options.effort;
      const outputConfig: Record<string, unknown> = {};
      if (effort) outputConfig.effort = effort;
      if (request.schema) outputConfig.format = { type: 'json_schema', schema: request.schema };
      if (Object.keys(outputConfig).length) params.output_config = outputConfig;

      let message: AnthropicMessage;
      try {
        // Stream anything large: a non-streaming request with a high max_tokens
        // can outlive the SDK's HTTP timeout.
        message =
          maxTokens > 8000
            ? await loaded.beta.messages.stream(params, { signal: request.signal }).finalMessage()
            : await loaded.beta.messages.create(params, { signal: request.signal });
      } catch (err) {
        return {
          text: '',
          declined: true,
          declineReason: err instanceof Error ? err.message : String(err),
          model,
        };
      }

      // Check the stop reason before reading content: a refusal can carry an
      // empty content array, and indexing it blindly would throw.
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category ?? 'unspecified';
        return {
          text: '',
          declined: true,
          declineReason: `The request was declined (${category}). Rephrase it, or use a different provider.`,
          model: message.model ?? model,
        };
      }

      const text = message.content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('')
        .trim();

      let value: unknown;
      if (request.schema && text) {
        try {
          value = JSON.parse(text);
        } catch {
          // A structured call whose reply will not parse is reported as text so
          // the caller can show it, rather than being silently swallowed.
        }
      }

      return {
        text,
        value,
        model: message.model ?? model,
        usage: {
          inputTokens: message.usage?.input_tokens,
          outputTokens: message.usage?.output_tokens,
        },
      };
    },
  };
}

/**
 * Build a provider from the environment, or return undefined when none is
 * configured. Callers fall back to `nullProvider`.
 */
export function providerFromEnvironment(env = process.env): AiProvider | undefined {
  const configured = env.MASTERCODE_AI_PROVIDER;
  if (configured && configured !== 'anthropic') return undefined;
  if (!configured && !env.ANTHROPIC_API_KEY) return undefined;
  return createAnthropicProvider({
    model: env.MASTERCODE_AI_MODEL || DEFAULT_MODEL,
    apiKey: env.ANTHROPIC_API_KEY,
  });
}
