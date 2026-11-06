/**
 * The `app` Gradle module: the Android application.
 */

import type { Ctx } from './kit.ts';
import { buildData } from './app/data.ts';
import { buildPlatform } from './app/platform.ts';
import { buildShell } from './app/ui-shell.ts';
import { buildChat } from './app/ui-chat.ts';
import { buildSettings } from './app/ui-settings.ts';
import { buildModuleScreens } from './app/ui-modules.ts';
import { buildAppTests } from './app/tests.ts';

export function buildApp(ctx: Ctx): void {
  buildData(ctx);
  buildPlatform(ctx);
  buildShell(ctx);
  buildChat(ctx);
  buildSettings(ctx);
  buildModuleScreens(ctx);
  buildAppTests(ctx);
}
