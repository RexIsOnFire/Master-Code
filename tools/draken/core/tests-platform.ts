/**
 * Tests for routing, context, the tool pipeline, modules, Notes and the
 * orchestrator - the policy the rest of the app depends on.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';
import { testClass } from './tests-providers.ts';

const TEST = 'core/src/test/kotlin/com/draken/core';

export function buildPlatformTests(ctx: Ctx): void {
  routing(ctx);
  context(ctx);
  validation(ctx);
  executor(ctx);
  modules(ctx);
  notes(ctx);
  orchestrator(ctx);
}

function routing(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/routing/RouterTest.kt`, { doc: 'routing policy', role: 'test' });
  f.decl(
    kt`
      private val local = RouteCandidate(testModel("local", tools = true, context = 8_000L), ProviderKind.LOCAL, true)
      private val localNoTools = RouteCandidate(testModel("local", tools = false, context = 8_000L), ProviderKind.LOCAL, true)
      private val cloud = RouteCandidate(testModel("cloud"), ProviderKind.CLOUD, true)
      private val smallTask = TaskRequirements(500L, 1_000L, false)
      private val toolTask = TaskRequirements(500L, 1_000L, true)

      private fun decide(mode: RoutingMode, vararg candidates: RouteCandidate, task: TaskRequirements = smallTask, pinned: ModelChoice? = null, budget: Long? = null, used: Long = 0L) =
          route(task, RoutingPreferences(mode, dailyCloudTokenBudget = budget), pinned, candidates.toList(), used)
    `,
    { doc: 'Candidates and a shorthand for routing.' },
  );
  testClass(f, 'RouterTest', 'The routing rules, one at a time.', [
    {
      name: 'aSmallModelFitsWhenItsOwnReplyLimitDoes',
      doc: 'A 4K-window model that writes at most 1K is not ruled out by the turn\'s 4K reply cap: only the reply it can write is reserved.',
      code: kt`
        val small = RouteCandidate(testModel("local", tools = false, context = 4_096L, output = 1_024L), ProviderKind.LOCAL, true)
        val decision = decide(RoutingMode.LOCAL_ONLY, small, task = TaskRequirements(600L, 4_096L, false)) as RouteDecision.UseModel
        assertEquals(ProviderKind.LOCAL, decision.kind)
        assertTrue(decide(RoutingMode.LOCAL_ONLY, small, task = TaskRequirements(3_500L, 4_096L, false)) is RouteDecision.Refused)
      `,
    },
    {
      name: 'localOnlyNeverChoosesACloudModel',
      doc: 'With only a cloud model usable, LOCAL_ONLY refuses rather than leave the device.',
      code: kt`
        val decision = decide(RoutingMode.LOCAL_ONLY, cloud)
        assertTrue(decision is RouteDecision.Refused)
        assertTrue((decision as RouteDecision.Refused).reason.contains("No on-device model"))
      `,
    },
    {
      name: 'askBeforeCloudRequiresApprovalForCloud',
      doc: 'The default mode sends to the cloud only with approval.',
      code: kt`
        val decision = decide(RoutingMode.ASK_BEFORE_CLOUD, cloud) as RouteDecision.UseModel
        assertEquals(ProviderKind.CLOUD, decision.kind)
        assertTrue(decision.needsApproval)
      `,
    },
    {
      name: 'prefersACapableOnDeviceModel',
      doc: 'Local first: a capable on-device model is chosen over a cloud one, without asking.',
      code: kt`
        val decision = decide(RoutingMode.ASK_BEFORE_CLOUD, cloud, local) as RouteDecision.UseModel
        assertEquals(ProviderKind.LOCAL, decision.kind)
        assertFalse(decision.needsApproval)
      `,
    },
    {
      name: 'skipsALocalModelThatCannotUseTools',
      doc: 'A task needing tools goes past an on-device model without them - to the cloud with approval, or nowhere in LOCAL_ONLY.',
      code: kt`
        val asked = decide(RoutingMode.ASK_BEFORE_CLOUD, localNoTools, cloud, task = toolTask) as RouteDecision.UseModel
        assertEquals(ProviderKind.CLOUD, asked.kind)
        val refused = decide(RoutingMode.LOCAL_ONLY, localNoTools, cloud, task = toolTask) as RouteDecision.Refused
        assertTrue(refused.reason.contains("tools"))
      `,
    },
    {
      name: 'skipsALocalModelWhoseWindowIsTooSmall',
      doc: 'A conversation longer than the on-device window is not truncated to fit; it goes to a model that can hold it.',
      code: kt`
        val long = TaskRequirements(20_000L, 1_000L, false)
        assertEquals(ProviderKind.CLOUD, (decide(RoutingMode.AUTOMATIC, local, cloud, task = long) as RouteDecision.UseModel).kind)
      `,
    },
    {
      name: 'automaticAsksOnceTheBudgetIsSpent',
      doc: 'AUTOMATIC uses the cloud freely until today\'s budget is spent, then asks.',
      code: kt`
        val within = decide(RoutingMode.AUTOMATIC, cloud, budget = 10_000L, used = 1_000L) as RouteDecision.UseModel
        assertFalse(within.needsApproval)
        val over = decide(RoutingMode.AUTOMATIC, cloud, budget = 10_000L, used = 9_800L) as RouteDecision.UseModel
        assertTrue(over.needsApproval)
      `,
    },
    {
      name: 'aPinnedCloudModelIsRefusedOnDeviceOnly',
      doc: 'Pinning a cloud model to a conversation does not override LOCAL_ONLY.',
      code: kt`
        val pinned = ModelChoice("cloud", "cloud-model")
        assertTrue(decide(RoutingMode.LOCAL_ONLY, cloud, local, pinned = pinned) is RouteDecision.Refused)
        assertEquals(ProviderKind.CLOUD, (decide(RoutingMode.AUTOMATIC, cloud, local, pinned = pinned) as RouteDecision.UseModel).kind)
      `,
    },
    {
      name: 'anUnreadyModelIsNeverChosen',
      doc: 'A cloud provider without its key is not a candidate.',
      code: kt`
        val keyless = cloud.copy(ready = false, unavailableReason = "No API key")
        assertTrue(decide(RoutingMode.AUTOMATIC, keyless) is RouteDecision.Refused)
      `,
    },
  ]);
}

function context(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/context/ContextAssemblerTest.kt`, { doc: 'context assembly', role: 'test' });
  f.decl(
    kt`
      private fun message(role: MessageRole, text: String, status: MessageStatus = MessageStatus.COMPLETE, calls: List<ToolCall> = emptyList(), result: ToolResultRecord? = null) =
          ChatMessage(text.hashCode().toString(), "c1", role, text, 0L, status, calls, result)
    `,
    { doc: 'A stored message, briefly.' },
  );
  testClass(f, 'ContextAssemblerTest', 'What a model is sent, and what is withheld.', [
    {
      name: 'aSmallModelStillReceivesTheConversation',
      doc: 'The history window is the context less the reply the model can write, not less the turn\'s whole cap.',
      code: kt`
        val history = listOf(message(MessageRole.USER, "Hello"), message(MessageRole.ASSISTANT, "Hi."), message(MessageRole.USER, "What is the capital of France?"))
        val model = testModel("local", tools = false, context = 4_096L, output = 1_024L)
        val context = assembleContext(history, "system", model, "On this device", ProviderKind.LOCAL, emptyList(), 4_096L, ContextPolicy())
        assertEquals(3, context.messages.size)
      `,
    },
    {
      name: 'opensTheWindowOnAUserTurnAndDisclosesWhatWasLeftOut',
      doc: 'When history exceeds the budget, the newest messages are kept from a user turn, and the disclosure counts what was excluded.',
      code: kt`
        val history = (1..30).flatMap { listOf(message(MessageRole.USER, "question " + it + " " + "x".repeat(300)), message(MessageRole.ASSISTANT, "answer " + it + " " + "y".repeat(300))) }
        val model = testModel("cloud", context = 2_000L)
        val context = assembleContext(history, "system", model, "Cloud", ProviderKind.CLOUD, emptyList(), 500L, ContextPolicy())
        assertTrue(context.messages.first() is PromptMessage.User)
        assertTrue(context.estimatedTokens <= 1_500L)
        assertEquals(context.messages.size.toLong(), context.disclosure.messageCount)
        assertEquals(60L - context.messages.size, context.disclosure.excludedOlderMessages)
        assertEquals("answer 30 " + "y".repeat(300), (context.messages.last() as PromptMessage.Assistant).text)
      `,
    },
    {
      name: 'keepsToolResultsWithTheirCallAndLeavesOutFailedTurns',
      doc: 'Tool results follow the call that produced them, as one message; failed replies are not sent.',
      code: kt`
        val call = ToolCall("t1", "draken_notes_search", "{}")
        val history = listOf(
            message(MessageRole.USER, "find milk"),
            message(MessageRole.ASSISTANT, "", calls = listOf(call)),
            message(MessageRole.TOOL, "Found 1 note", result = ToolResultRecord("t1", "draken_notes_search", false, "[]")),
            message(MessageRole.ASSISTANT, "broken", status = MessageStatus.FAILED),
            message(MessageRole.ASSISTANT, "You have one note about milk."),
        )
        val prompt = promptMessages(history)
        assertEquals(4, prompt.size)
        assertEquals(listOf(call), (prompt[1] as PromptMessage.Assistant).toolCalls)
        assertEquals("t1", (prompt[2] as PromptMessage.ToolResults).results.single().callId)
        assertTrue(prompt.none { it is PromptMessage.Assistant && it.text == "broken" })
      `,
    },
    {
      name: 'capsCloudRequestsButNotOnDeviceOnes',
      doc: 'Cloud requests carry at most the cloud cap even for a huge window; an on-device request may use its whole window.',
      code: kt`
        val history = (1..400).map { message(if (it % 2 == 1) MessageRole.USER else MessageRole.ASSISTANT, "m" + it + " " + "z".repeat(400)) }
        val huge = testModel("any", context = 1_000_000L)
        val cloud = assembleContext(history, "s", huge, "Cloud", ProviderKind.CLOUD, emptyList(), 1_000L, ContextPolicy(maxMessages = 1_000L))
        val local = assembleContext(history, "s", huge, "Local", ProviderKind.LOCAL, emptyList(), 1_000L, ContextPolicy(maxMessages = 1_000L))
        assertTrue(cloud.estimatedTokens <= ContextPolicy().cloudInputTokenCap)
        assertTrue(local.messages.size > cloud.messages.size)
      `,
    },
  ]);
}

function validation(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/tools/ArgumentValidationTest.kt`, { doc: 'argument validation', role: 'test' });
  f.use('kotlinx.serialization.json.put', 'kotlinx.serialization.json.add');
  f.decl(
    kt`
      private val schema = buildJsonObject {
          put("type", "object")
          putJsonObject("properties") {
              putJsonObject("title") {
                  put("type", "string")
                  put("maxLength", 5)
              }
              putJsonObject("count") {
                  put("type", "integer")
                  put("minimum", 1)
              }
              putJsonObject("mode") {
                  put("type", "string")
                  putJsonArray("enum") {
                      add("fast")
                      add("careful")
                  }
              }
          }
          putJsonArray("required") { add("title") }
          put("additionalProperties", false)
      }

      private fun problems(json: String) = validateArguments(schema, DrakenJson.format.parseToJsonElement(json))
    `,
    { doc: 'A schema using every supported keyword.' },
  );
  testClass(f, 'ArgumentValidationTest', 'Model-proposed arguments are checked, not trusted.', [
    { name: 'acceptsValidArguments', doc: 'A valid call has no problems.', code: kt`assertEquals(emptyList<String>(), problems("""{"title":"abc","count":2,"mode":"fast"}"""))` },
    {
      name: 'reportsEveryProblem',
      doc: 'Missing, extra, wrong type, out of range and not in the enum are all reported together.',
      code: kt`
        val found = problems("""{"count":0,"mode":"slow","extra":1}""")
        assertTrue(found.any { it.contains("title is required") })
        assertTrue(found.any { it.contains("extra is not an accepted argument") })
        assertTrue(found.any { it.contains("count must be at least") })
        assertTrue(found.any { it.contains("mode must be one of") })
      `,
    },
    {
      name: 'rejectsWrongTypesAndLength',
      doc: 'Text where a number belongs, a fraction where an integer belongs, and over-long text all fail.',
      code: kt`
        assertTrue(problems("""{"title":"abcdef"}""").any { it.contains("at most 5") })
        assertTrue(problems("""{"title":"a","count":"2"}""").any { it.contains("must be a number") })
        assertTrue(problems("""{"title":"a","count":1.5}""").any { it.contains("whole number") })
        assertTrue(problems("""{"title":7}""").any { it.contains("must be text") })
      `,
    },
    {
      name: 'refusesASchemaKeywordItDoesNotUnderstand',
      doc: 'An unsupported keyword invalidates the schema instead of being skipped.',
      code: kt`
        val pattern = buildJsonObject {
            put("type", "string")
            put("pattern", "^a")
        }
        assertTrue(validateArguments(pattern, JsonPrimitive("b")).single().contains("unsupported keyword"))
      `,
    },
  ]);
}

function executor(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/tools/ToolExecutorTest.kt`, { doc: 'the tool pipeline', role: 'test' });
  f.decl(
    kt`
      private fun call(name: String, arguments: String) = ToolCall("call-1", name, arguments)
    `,
    { doc: 'A tool call, briefly.' },
  );
  testClass(f, 'ToolExecutorTest', 'Every step of the pipeline, and that a failure at any step stops the ones after it.', [
    {
      name: 'refusesAnUnknownTool',
      doc: 'A name the model invented runs nothing.',
      code: kt`
        val p = TestPlatform()
        val outcome = runBlocking { p.installNotes(); p.executor.execute(call("draken_notes_format_disk", "{}")) }
        assertEquals(ToolFailureCode.UNKNOWN_TOOL, (outcome as ToolOutcome.Failure).code)
      `,
    },
    {
      name: 'refusesInvalidArgumentsBeforeAuthorizing',
      doc: 'Unparseable or schema-violating arguments fail at step two; nothing is created.',
      code: kt`
        val p = TestPlatform()
        runBlocking {
            p.installNotes()
            assertEquals(ToolFailureCode.INVALID_ARGUMENTS, (p.executor.execute(call("draken_notes_create", "not json")) as ToolOutcome.Failure).code)
            assertEquals(ToolFailureCode.INVALID_ARGUMENTS, (p.executor.execute(call("draken_notes_create", """{"body":"no title"}""")) as ToolOutcome.Failure).code)
        }
        assertTrue(p.notes.notes.isEmpty())
      `,
    },
    {
      name: 'deniesACapabilityThatWasNeverGranted',
      doc: 'Declaring a capability is not being granted it.',
      code: kt`
        val p = TestPlatform()
        val outcome = runBlocking { p.installNotes(grant = false); p.executor.execute(call("draken_notes_create", """{"title":"x"}""")) }
        assertEquals(ToolFailureCode.PERMISSION_DENIED, (outcome as ToolOutcome.Failure).code)
        assertTrue(p.notes.notes.isEmpty())
        assertEquals("denied:not_granted", p.audit.events.last().outcome)
      `,
    },
    {
      name: 'checksARevokedPermissionAtExecutionTime',
      doc: 'Revoking a grant takes effect on the next call, not on reinstall.',
      code: kt`
        val p = TestPlatform()
        runBlocking {
            p.installNotes()
            assertTrue(p.executor.execute(call("draken_notes_create", """{"title":"first"}""")) is ToolOutcome.Success)
            p.grants.setGranted(NOTES_MODULE_ID, "notes.write", false)
            assertEquals(ToolFailureCode.PERMISSION_DENIED, (p.executor.execute(call("draken_notes_create", """{"title":"second"}""")) as ToolOutcome.Failure).code)
        }
        assertEquals(listOf("first"), p.notes.notes.values.map { it.title })
      `,
    },
    {
      name: 'asksBeforeAConsequentialActionAndHonoursNo',
      doc: 'Deleting a note asks; a refusal deletes nothing.',
      code: kt`
        val p = TestPlatform(confirm = false)
        val outcome = runBlocking {
            p.installNotes()
            val note = p.notes.create("keep me", "")
            p.executor.execute(call("draken_notes_delete", """{"id":"""" + note.id + """"}"""))
        }
        assertEquals(ToolFailureCode.USER_DECLINED, (outcome as ToolOutcome.Failure).code)
        assertEquals(1, p.confirmations.asked)
        assertEquals(1, p.notes.notes.size)
      `,
    },
    {
      name: 'auditsWithoutRecordingContent',
      doc: 'The audit trail names the tool and the outcome, never what the user or model wrote.',
      code: kt`
        val p = TestPlatform()
        runBlocking { p.installNotes(); p.executor.execute(call("draken_notes_create", """{"title":"secret plan","body":"do not log"}""")) }
        val event = p.audit.events.last()
        assertEquals("draken.notes.create", event.subject)
        assertEquals("ok", event.outcome)
        assertTrue(p.audit.events.none { it.detail.contains("secret") || it.detail.contains("do not log") })
      `,
    },
    {
      name: 'reportsAHandlerFailureAsAFailure',
      doc: 'A handler that throws is a structured EXECUTION_FAILED, not a crash and not a success.',
      code: kt`
        val registry = ToolRegistry()
        val spec = ToolSpec("draken.test.boom", "draken.test", "Boom", "Fails", buildJsonObject { put("type", "object") }, "notes.read", RiskLevel.READ, false)
        registry.register(spec, object : ToolHandler {
            override suspend fun execute(arguments: JsonObject): ToolOutcome = throw IllegalStateException("disk full")
        })
        val manifest = ModuleManifest(1L, "draken.test", "Test", "1.0.0", "", "Draken", 1L, listOf(CapabilityRequest("notes.read", "test")))
        val modules = object : ModuleDirectory {
            override suspend fun installedModule(moduleId: String) = InstalledModule(manifest, true, ModuleSource.BUILT_IN, 0L)
        }
        val grants = MemoryGrants().apply { granted.add("draken.test" to "notes.read") }
        val executor = ToolExecutor(registry, PermissionBroker(modules, grants, FixedPlatform()), FixedConfirmations(true), RecordingAudit())
        val outcome = runBlocking { executor.execute(call("draken_test_boom", "{}")) } as ToolOutcome.Failure
        assertEquals(ToolFailureCode.EXECUTION_FAILED, outcome.code)
        assertTrue(outcome.message.contains("disk full"))
      `,
    },
    {
      name: 'deniesWhenAndroidHasNotGrantedTheRuntimePermission',
      doc: 'A calendar grant without READ_CALENDAR from Android still fails, naming the missing permission.',
      code: kt`
        val manifest = ModuleManifest(1L, "draken.cal", "Calendar", "1.0.0", "", "Draken", 1L, listOf(CapabilityRequest("calendar.read", "test")))
        val modules = object : ModuleDirectory {
            override suspend fun installedModule(moduleId: String) = InstalledModule(manifest, true, ModuleSource.BUILT_IN, 0L)
        }
        val grants = MemoryGrants().apply { granted.add("draken.cal" to "calendar.read") }
        val platform = FixedPlatform()
        val broker = PermissionBroker(modules, grants, platform)
        val denied = runBlocking { broker.authorize("draken.cal", "calendar.read") } as Authorization.Denied
        assertEquals(DenialReason.PLATFORM_PERMISSION_MISSING, denied.reason)
        assertTrue(denied.detail.contains("READ_CALENDAR"))
        platform.granted = setOf("android.permission.READ_CALENDAR")
        assertEquals(Authorization.Allowed, runBlocking { broker.authorize("draken.cal", "calendar.read") })
      `,
    },
  ]);
  f.use('kotlinx.serialization.json.put');
}

function modules(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/modules/ModuleManagerTest.kt`, { doc: 'module lifecycle', role: 'test' });
  f.use('kotlinx.serialization.json.put');
  f.decl(
    kt`
      private fun searchOnly(id: String = "acme.recipes", version: String = "1.0.0", capabilities: List<String> = listOf("notes.read"), handler: String = "notes.search") =
          ModuleManifest(
              MANIFEST_SCHEMA_VERSION, id, "Recipes", version, "Finds recipes in notes.", "Acme", 1L,
              capabilities.map { CapabilityRequest(it, "to read recipe notes") },
              listOf(
                  ToolDeclaration(
                      id + ".find", "Find recipe", "Search recipe notes.",
                      buildJsonObject {
                          put("type", "object")
                          putJsonObject("properties") { putJsonObject("query") { put("type", "string") } }
                      },
                      "notes.read", RiskLevel.READ, false, handler,
                  ),
              ),
          )

      /** A platform whose search handler is open to packages, as a reviewed handler would be. */
      private fun platformWithPublicSearch(): TestPlatform =
          TestPlatform().also { p -> p.handlers.add("notes.search", p.handlers.binding("notes.search")!!.handler, availableToPackages = true) }
    `,
    { doc: 'A small package manifest.' },
  );
  testClass(f, 'ModuleManagerTest', 'Installing, validating, disabling and removing modules keeps the registry and grants in step.', [
    {
      name: 'installsAValidPackageAndRegistersItsTools',
      doc: 'A valid package installs enabled, its tool appears, and nothing is granted by installing.',
      code: kt`
        val p = platformWithPublicSearch()
        val change = runBlocking { p.manager.install(searchOnly(), ModuleSource.PACKAGE) }
        assertTrue(change is ModuleChange.Done)
        assertNotNull(p.registry.lookup("acme_recipes_find"))
        assertTrue(p.grants.granted.isEmpty())
      `,
    },
    {
      name: 'rejectsAPackageUsingAHandlerNotOpenToPackages',
      doc: 'A package cannot reach a handler only built-in modules may use.',
      code: kt`
        val p = TestPlatform()
        val change = runBlocking { p.manager.install(searchOnly(handler = "notes.delete"), ModuleSource.PACKAGE) } as ModuleChange.Rejected
        assertTrue(change.problems.any { it.message.contains("not available to packages") })
        assertNull(p.registry.lookup("acme_recipes_find"))
      `,
    },
    {
      name: 'rejectsUnknownCapabilitiesAndMalformedFields',
      doc: 'Validation reports every problem: capability, id, version, and a tool using a capability the module did not request.',
      code: kt`
        val p = platformWithPublicSearch()
        val bad = searchOnly(id = "Acme Recipes", version = "1.0", capabilities = listOf("contacts.read"))
        val problems = (runBlocking { p.manager.install(bad, ModuleSource.PACKAGE) } as ModuleChange.Rejected).problems
        assertTrue(problems.any { it.field == "id" })
        assertTrue(problems.any { it.field == "version" })
        assertTrue(problems.any { it.message.contains("not a known capability") })
        assertTrue(problems.any { it.message.contains("does not request") })
      `,
    },
    {
      name: 'disablingRemovesToolsAndTheBrokerDeniesTheModule',
      doc: 'A disabled module offers no tools and is denied even with grants.',
      code: kt`
        val p = TestPlatform()
        runBlocking {
            p.installNotes()
            assertTrue(p.manager.setEnabled(NOTES_MODULE_ID, false))
            assertNull(p.registry.lookup("draken_notes_create"))
            val denied = p.broker.authorize(NOTES_MODULE_ID, "notes.write") as Authorization.Denied
            assertEquals(DenialReason.MODULE_DISABLED, denied.reason)
            assertTrue(p.manager.setEnabled(NOTES_MODULE_ID, true))
            assertNotNull(p.registry.lookup("draken_notes_create"))
        }
      `,
    },
    {
      name: 'removingAPackageRevokesItsGrantsAndTools',
      doc: 'Uninstalling forgets grants and unregisters tools; a built-in module can only be turned off.',
      code: kt`
        val p = platformWithPublicSearch()
        runBlocking {
            p.manager.install(searchOnly(), ModuleSource.PACKAGE)
            p.grants.setGranted("acme.recipes", "notes.read", true)
            assertTrue(p.manager.uninstall("acme.recipes") is ModuleChange.Done)
            p.installNotes()
            assertTrue(p.manager.uninstall(NOTES_MODULE_ID) is ModuleChange.Rejected)
        }
        assertNull(p.registry.lookup("acme_recipes_find"))
        assertTrue(p.grants.granted.none { it.first == "acme.recipes" })
      `,
    },
    {
      name: 'anUpdateDropsGrantsForCapabilitiesNoLongerRequested',
      doc: 'A newer version keeps only the grants it still asks for, and an older version is refused.',
      code: kt`
        val p = platformWithPublicSearch()
        runBlocking {
            p.manager.install(searchOnly(capabilities = listOf("notes.read", "notes.write")), ModuleSource.PACKAGE)
            p.grants.setGranted("acme.recipes", "notes.read", true)
            p.grants.setGranted("acme.recipes", "notes.write", true)
            assertTrue(p.manager.install(searchOnly(version = "1.1.0"), ModuleSource.PACKAGE) is ModuleChange.Done)
            assertTrue(p.manager.install(searchOnly(version = "1.0.5"), ModuleSource.PACKAGE) is ModuleChange.Rejected)
        }
        assertEquals(setOf("acme.recipes" to "notes.read"), p.grants.granted.toSet())
      `,
    },
    {
      name: 'refusesAMissingDependencyAndProtectsADependedOnModule',
      doc: 'A module needing another cannot install before it, and the one depended on cannot be removed while it is needed.',
      code: kt`
        val p = platformWithPublicSearch()
        val base = searchOnly(id = "acme.base")
        val extra = searchOnly(id = "acme.extra").copy(dependencies = listOf(ModuleDependency("acme.base", "1.0.0")))
        runBlocking {
            assertTrue(p.manager.install(extra, ModuleSource.PACKAGE) is ModuleChange.Rejected)
            p.manager.install(base, ModuleSource.PACKAGE)
            assertTrue(p.manager.install(extra, ModuleSource.PACKAGE) is ModuleChange.Done)
            assertTrue(p.manager.uninstall("acme.base") is ModuleChange.Rejected)
        }
      `,
    },
    {
      name: 'restoreTurnsOffAModuleThatNoLongerValidates',
      doc: 'A stored module whose handler this build no longer has is turned off at startup, not run.',
      code: kt`
        val p = TestPlatform()
        runBlocking { p.modules.save(InstalledModule(searchOnly(handler = "removed.handler"), true, ModuleSource.BUILT_IN, 0L)) }
        val reports = runBlocking { p.manager.restore() }
        assertEquals(1, reports.size)
        assertFalse(p.modules.modules.getValue("acme.recipes").enabled)
      `,
    },
  ]);
}

function notes(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/notes/NotesModuleTest.kt`, { doc: 'the Notes module end to end', role: 'test' });
  testClass(f, 'NotesModuleTest', 'Notes through the same manifest, broker and pipeline a model\'s calls take.', [
    {
      name: 'createsSearchesReadsUpdatesAndDeletes',
      doc: 'The whole lifecycle, each step verified against the store rather than the tool\'s own claim.',
      code: kt`
        val p = TestPlatform()
        runBlocking {
            p.installNotes()
            val created = p.executor.execute(ToolCall("1", "draken_notes_create", """{"title":"Groceries","body":"milk, eggs"}"""))
            assertTrue(created is ToolOutcome.Success)
            val id = p.notes.notes.values.single().id

            val found = p.executor.execute(ToolCall("2", "draken_notes_search", """{"query":"milk"}""")) as ToolOutcome.Success
            assertEquals(1, (found.content as JsonArray).size)

            val read = p.executor.execute(ToolCall("3", "draken_notes_get", """{"id":"""" + id + """"}""")) as ToolOutcome.Success
            assertEquals("milk, eggs", stringField(read.content as JsonObject, "body"))

            assertTrue(p.executor.execute(ToolCall("4", "draken_notes_update", """{"id":"""" + id + """","body":"milk, eggs, bread"}""")) is ToolOutcome.Success)
            assertEquals("milk, eggs, bread", p.notes.notes.getValue(id).body)
            assertEquals("Groceries", p.notes.notes.getValue(id).title)

            assertTrue(p.executor.execute(ToolCall("5", "draken_notes_delete", """{"id":"""" + id + """"}""")) is ToolOutcome.Success)
            assertTrue(p.notes.notes.isEmpty())
        }
        assertEquals("editing and deleting asked first", 2, p.confirmations.asked)
      `,
    },
    {
      name: 'reportsAMissingNoteAsNotFound',
      doc: 'Reading or deleting an id that does not exist is NOT_FOUND, never a success.',
      code: kt`
        val p = TestPlatform()
        runBlocking {
            p.installNotes()
            assertEquals(ToolFailureCode.NOT_FOUND, (p.executor.execute(ToolCall("1", "draken_notes_get", """{"id":"nope"}""")) as ToolOutcome.Failure).code)
            assertEquals(ToolFailureCode.NOT_FOUND, (p.executor.execute(ToolCall("2", "draken_notes_delete", """{"id":"nope"}""")) as ToolOutcome.Failure).code)
        }
      `,
    },
    {
      name: 'appliesTheSameValidationAsTheEditor',
      doc: 'A multi-line title is refused by the tool exactly as the editor refuses it.',
      code: kt`
        assertTrue(validateNote("one\ntwo", "").isNotEmpty())
        assertTrue(validateNote("", "").isNotEmpty())
        assertTrue(validateNote("ok", "").isEmpty())
        val p = TestPlatform()
        val outcome = runBlocking { p.installNotes(); p.executor.execute(ToolCall("1", "draken_notes_create", """{"title":"one\ntwo"}""")) }
        assertEquals(ToolFailureCode.INVALID_ARGUMENTS, (outcome as ToolOutcome.Failure).code)
      `,
    },
  ]);
}

function orchestrator(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/orchestrator/OrchestratorTest.kt`, { doc: 'one turn, end to end', role: 'test' });
  f.use('kotlinx.coroutines.flow.toList', 'kotlinx.coroutines.flow.first');
  f.decl(
    kt`
      private class Harness(vararg providers: FakeProvider, preferences: RoutingPreferences = RoutingPreferences(), approve: CloudApproval = CloudApproval.ALLOW_ONCE) {
          val platform = TestPlatform()
          val store = MemoryConversations()
          val directory = FakeDirectory(providers.toList(), preferences)
          val approvals = FixedApprovals(approve)
          val limits = WorkflowLimits(maxToolRounds = 2L, maxToolCalls = 4L, turnTimeoutMillis = 5_000L)
          val orchestrator = Orchestrator(store, directory, platform.registry, platform.executor, approvals, platform.audit, limits, ContextPolicy(), RetryPolicy(1L, 1L, 1L))

          fun turn(text: String): List<TurnEvent> = runBlocking {
              platform.installNotes()
              val conversation = store.conversations.values.firstOrNull() ?: store.createConversation("test")
              orchestrator.send(conversation.id, text).toList()
          }
      }
    `,
    { doc: 'An orchestrator over in-memory stores and scripted providers.' },
  );
  testClass(f, 'OrchestratorTest', 'One turn, end to end, against scripted models.', [
    {
      name: 'persistsTheTurnAndStreamsTheReply',
      doc: 'The user message and the complete reply are stored, with the model that wrote it.',
      code: kt`
        val local = FakeProvider("local", ProviderKind.LOCAL, testModel("local")) { _, _ -> reply("Hello there.") }
        val h = Harness(local)
        val events = h.turn("Hi")
        assertTrue(events.last() is TurnEvent.Completed)
        val stored = h.store.messages
        assertEquals(listOf(MessageRole.USER, MessageRole.ASSISTANT), stored.map { it.role })
        assertEquals("Hello there.", stored[1].text)
        assertEquals(MessageStatus.COMPLETE, stored[1].status)
        assertEquals(true, stored[1].route?.local)
      `,
    },
    {
      name: 'runsAToolAndSendsTheResultBack',
      doc: 'A tool call is executed through the pipeline, stored, and returned to the model, which then answers.',
      code: kt`
        val local = FakeProvider("local", ProviderKind.LOCAL, testModel("local")) { _, attempt ->
            if (attempt == 1) callTool("t1", "draken_notes_create", """{"title":"Groceries"}""") else reply("Saved.")
        }
        val h = Harness(local)
        val events = h.turn("Remember groceries")
        assertTrue(events.any { it is TurnEvent.ToolFinished && it.outcome is ToolOutcome.Success })
        assertEquals("the note really exists", "Groceries", h.platform.notes.notes.values.single().title)
        val second = local.requests[1].messages
        assertTrue(second[second.size - 1] is PromptMessage.ToolResults)
        assertEquals(listOf(MessageRole.USER, MessageRole.ASSISTANT, MessageRole.TOOL, MessageRole.ASSISTANT), h.store.messages.map { it.role })
      `,
    },
    {
      name: 'offersToolsOnlyToAModelThatCanUseThem',
      doc: 'A model without tool support still answers, and is not sent tool definitions it would misread.',
      code: kt`
        val local = FakeProvider("local", ProviderKind.LOCAL, testModel("local", tools = false)) { _, _ -> reply("Hi.") }
        val h = Harness(local)
        assertTrue(h.turn("hello").last() is TurnEvent.Completed)
        assertTrue(local.requests.single().tools.isEmpty())
      `,
    },
    {
      name: 'localOnlyNeverReachesACloudProvider',
      doc: 'With only a cloud model set up and LOCAL_ONLY chosen, the turn fails and the cloud provider receives nothing.',
      code: kt`
        val cloud = FakeProvider("cloud", ProviderKind.CLOUD, testModel("cloud")) { _, _ -> reply("leaked") }
        val h = Harness(cloud, preferences = RoutingPreferences(RoutingMode.LOCAL_ONLY))
        val events = h.turn("private question")
        assertTrue(events.last() is TurnEvent.Failed)
        assertEquals(0, cloud.requests.size)
      `,
    },
    {
      name: 'aDeclinedApprovalSendsNothing',
      doc: 'In ASK_BEFORE_CLOUD, declining means no request is made, and the decision is audited.',
      code: kt`
        val cloud = FakeProvider("cloud", ProviderKind.CLOUD, testModel("cloud")) { _, _ -> reply("leaked") }
        val h = Harness(cloud, approve = CloudApproval.DENY)
        val events = h.turn("question")
        assertTrue(events.any { it is TurnEvent.AwaitingApproval })
        assertTrue(events.last() is TurnEvent.ApprovalDeclined)
        assertEquals(0, cloud.requests.size)
        assertEquals("declined", h.platform.audit.events.last { it.category == AuditCategory.CLOUD_REQUEST }.outcome)
      `,
    },
    {
      name: 'allowingForTheConversationAsksOnlyOnce',
      doc: 'The approval can cover the rest of the conversation for this session.',
      code: kt`
        val cloud = FakeProvider("cloud", ProviderKind.CLOUD, testModel("cloud")) { _, _ -> reply("ok") }
        val h = Harness(cloud, approve = CloudApproval.ALLOW_FOR_CONVERSATION)
        h.turn("one")
        h.turn("two")
        assertEquals(1, h.approvals.asked)
        assertEquals(2, cloud.requests.size)
      `,
    },
    {
      name: 'stopsAModelThatKeepsCallingTools',
      doc: 'A model that never stops asking for tools is cut off at the round limit.',
      code: kt`
        val local = FakeProvider("local", ProviderKind.LOCAL, testModel("local")) { _, attempt ->
            callTool("t" + attempt, "draken_notes_search", """{"query":"x"}""")
        }
        val h = Harness(local)
        val events = h.turn("loop forever")
        assertTrue(events.any { it is TurnEvent.LimitReached })
        assertEquals(3, local.requests.size)
      `,
    },
    {
      name: 'doesNotRunToolsFromATruncatedReply',
      doc: 'A reply cut off at its token limit may hold a half-written call, so nothing runs.',
      code: kt`
        val local = FakeProvider("local", ProviderKind.LOCAL, testModel("local")) { _, _ ->
            emit(ModelEvent.ToolCallRequested(ToolCall("t1", "draken_notes_create", """{"title":"half""")))
            emit(ModelEvent.Finished(StopReason.MAX_TOKENS, null))
        }
        val h = Harness(local)
        h.turn("save something")
        assertTrue(h.platform.notes.notes.isEmpty())
        assertTrue(h.store.messages.last().error!!.contains("length limit"))
      `,
    },
    {
      name: 'aProviderFailureIsStoredAndReported',
      doc: 'A rejected key fails the turn with a reason the user can act on, and the reply is marked failed.',
      code: kt`
        val local = FakeProvider("local", ProviderKind.LOCAL, testModel("local")) { _, _ ->
            throw ProviderException(ProviderError.Authentication("bad key"))
        }
        val h = Harness(local)
        val events = h.turn("hi")
        assertTrue((events.last { it is TurnEvent.Failed } as TurnEvent.Failed).message.contains("rejected the API key"))
        assertEquals(MessageStatus.FAILED, h.store.messages.last().status)
      `,
    },
    {
      name: 'cancellingKeepsThePartialReply',
      doc: 'Stopping a reply mid-stream keeps what was written, marked cancelled.',
      code: kt`
        val local = FakeProvider("local", ProviderKind.LOCAL, testModel("local")) { _, _ ->
            emit(ModelEvent.TextDelta("Partial"))
            awaitCancellation()
        }
        val h = Harness(local)
        runBlocking {
            h.platform.installNotes()
            val conversation = h.store.createConversation("t")
            val streaming = CompletableDeferred<Unit>()
            val job = launch {
                h.orchestrator.send(conversation.id, "tell me a story").collect { if (it is TurnEvent.TextDelta) streaming.complete(Unit) }
            }
            withTimeout(5_000) { streaming.await() }
            job.cancelAndJoin()
        }
        val reply = h.store.messages.last()
        assertEquals(MessageStatus.CANCELLED, reply.status)
        assertEquals("Partial", reply.text)
      `,
    },
  ]);
}
