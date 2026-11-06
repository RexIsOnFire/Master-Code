/**
 * The cloud providers Draken ships knowing about, and their models.
 *
 * Figures come from each vendor's documentation as read on 2026-10-13, and
 * say so: `documented = false` marks a figure the vendor did not publish,
 * where a conservative assumption stands in. Model ids are defaults a user
 * can change, not a closed list.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core/provider';

export function buildCatalog(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/ProviderCatalog.kt`, { doc: 'built-in cloud providers and their models' });

  f.record(
    'CloudProviderConfig',
    [
      { name: 'id', type: 'string' },
      { name: 'displayName', type: 'string' },
      { name: 'family', type: 'ProviderFamily' },
      { name: 'baseUrl', type: 'string', doc: 'Overridable so a proxy or a self-hosted compatible server can stand in.' },
      { name: 'defaultModelId', type: 'string' },
      { name: 'models', type: 'List<ModelDescriptor>' },
    ],
    { doc: 'How to reach one cloud provider.' },
  );

  f.iface(
    'CredentialSource',
    [
      {
        name: 'apiKey',
        params: [{ name: 'providerId', type: 'string' }],
        returns: 'Option<string>',
        doc: 'The key saved for a provider, or null. Read per request so a key the user removed stops working at once.',
      },
    ],
    { doc: 'Where adapters get API keys. On Android the keys are encrypted under a Keystore key and decrypted only here.' },
  );

  f.fn('builtInCloudProviders', {
    doc: 'The cloud providers Draken knows how to talk to.',
    returns: 'List<CloudProviderConfig>',
    code: kt`
      fun model(provider: String, id: String, name: String, context: Long, output: Long, images: Boolean, documented: Boolean) =
          ModelDescriptor(provider, id, name, ModelCapabilities(context, output, true, images, documented))

      return listOf(
          // platform.claude.com model table, cached 2026-10-06.
          CloudProviderConfig(
              "anthropic", "Anthropic Claude", ProviderFamily.ANTHROPIC, "https://api.anthropic.com", "claude-opus-5-5",
              listOf(
                  model("anthropic", "claude-opus-5-5", "Claude Opus 5.5", 1_000_000, 128_000, true, true),
                  model("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, 128_000, true, true),
                  model("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5", 1_000_000, 128_000, true, true),
              ),
          ),
          // developers.openai.com/api/docs/models: 922K maximum input, 128K output.
          // Image input is not stated on the page, so it is not assumed.
          CloudProviderConfig(
              "openai", "OpenAI", ProviderFamily.OPENAI, "https://api.openai.com/v1", "gpt-6.1-sol",
              listOf(
                  model("openai", "gpt-6.1-sol", "GPT-6.1 Sol", 922_000, 128_000, false, true),
                  model("openai", "gpt-6-astra", "GPT-6 Astra", 922_000, 128_000, false, true),
                  model("openai", "gpt-6-luna", "GPT-6 Luna", 922_000, 128_000, false, true),
              ),
          ),
          // ai.google.dev/gemini-api/docs/models lists ids but not limits;
          // the limits here are conservative assumptions.
          CloudProviderConfig(
              "gemini", "Google Gemini", ProviderFamily.GEMINI, "https://generativelanguage.googleapis.com", "gemini-3.8-flash",
              listOf(
                  model("gemini", "gemini-3.8-flash", "Gemini 3.8 Flash", 128_000, 8_192, false, false),
                  model("gemini", "gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", 128_000, 8_192, false, false),
              ),
          ),
          // api-docs.deepseek.com pricing page: 1M context, 384K output, tool calls.
          CloudProviderConfig(
              "deepseek", "DeepSeek", ProviderFamily.DEEPSEEK, "https://api.deepseek.com", "deepseek-flash",
              listOf(
                  model("deepseek", "deepseek-flash", "DeepSeek Flash", 1_000_000, 384_000, false, true),
                  model("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, 384_000, false, true),
              ),
          ),
      )
    `,
  });

  f.fn('assumedCapabilities', {
    doc: 'What to assume about a model id this build does not know: small limits, tools allowed, no images, and marked as an assumption so the interface can say so.',
    returns: 'ModelCapabilities',
    expression: true,
    code: kt`ModelCapabilities(32_000, 4_096, true, false, false)`,
  });
}
