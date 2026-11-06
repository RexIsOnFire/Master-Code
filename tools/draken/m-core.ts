/**
 * The `core` Gradle module: everything that does not need Android.
 */

import type { Ctx } from './kit.ts';
import { buildModel } from './core/model.ts';
import { buildProviderContract } from './core/provider.ts';
import { buildTransport } from './core/transport.ts';
import { buildCatalog } from './core/catalog.ts';
import { buildAnthropic } from './core/anthropic.ts';
import { buildOpenAi } from './core/openai.ts';
import { buildGemini } from './core/gemini.ts';
import { buildProviderTests } from './core/tests-providers.ts';
import { buildPlatformFakes } from './core/tests-fakes.ts';
import { buildPlatformTests } from './core/tests-platform.ts';
import { buildRouting } from './core/routing.ts';
import { buildTools } from './core/tools.ts';
import { buildModules } from './core/modules.ts';
import { buildNotes } from './core/notes.ts';
import { buildOrchestrator } from './core/orchestrator.ts';

export function buildCore(ctx: Ctx): void {
  buildModel(ctx);
  buildProviderContract(ctx);
  buildTransport(ctx);
  buildCatalog(ctx);
  buildAnthropic(ctx);
  buildOpenAi(ctx);
  buildGemini(ctx);
  buildRouting(ctx);
  buildTools(ctx);
  buildModules(ctx);
  buildNotes(ctx);
  buildOrchestrator(ctx);
  buildProviderTests(ctx);
  buildPlatformFakes(ctx);
  buildPlatformTests(ctx);
}
