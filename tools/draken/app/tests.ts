/**
 * The app's tests. They run on the JVM under Robolectric, against a real Room
 * database, a real DataStore and - for whole turns - the real AppContainer
 * talking to a local MockWebServer.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';
import { testClass } from '../core/tests-providers.ts';

const TEST = 'app/src/test/kotlin/com/draken/app';
const ROBOLECTRIC = 'RunWith(RobolectricTestRunner::class)';

export function buildAppTests(ctx: Ctx): void {
  support(ctx);
  stores(ctx);
  credentials(ctx);
  settings(ctx);
  prompts(ctx);
  pure(ctx);
  turns(ctx);
  screens(ctx);
}

function support(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/testing/AppTesting.kt`, { doc: 'helpers for the app tests', role: 'test' });
  f.use('android.os.Looper', 'org.robolectric.Shadows.shadowOf');
  f.decl(
    kt`
      /**
       * Poll until [probe] returns a value, running the main looper in between so
       * work posted there makes progress. Fails after [timeoutMillis].
       */
      fun <T : Any> waitFor(timeoutMillis: Long = 10_000L, probe: () -> T?): T {
          val deadline = System.currentTimeMillis() + timeoutMillis
          while (true) {
              probe()?.let { return it }
              if (System.currentTimeMillis() > deadline) throw AssertionError("Timed out waiting")
              shadowOf(Looper.getMainLooper()).idle()
              Thread.sleep(20)
          }
      }

      /** A reversible stand-in for the Keystore cipher, which Robolectric does not provide. */
      class XorCipher : SecretCipher {
          override fun encrypt(plaintext: ByteArray): ByteArray = ByteArray(plaintext.size) { (plaintext[it].toInt() xor 0x5A).toByte() }

          override fun decrypt(ciphertext: ByteArray): ByteArray = encrypt(ciphertext)
      }

      /** A cipher whose key is gone, as after the user resets the device's lock screen. */
      class LostKeyCipher : SecretCipher {
          override fun encrypt(plaintext: ByteArray): ByteArray = plaintext.reversedArray()

          override fun decrypt(ciphertext: ByteArray): ByteArray = throw javax.crypto.AEADBadTagException("key invalidated")
      }

      /** A tool spec for prompts. */
      fun deleteNoteSpec() = ToolSpec("notes.delete", NOTES_MODULE_ID, "Delete note", "Delete one note.", buildJsonObject {}, "notes.write", RiskLevel.DESTRUCTIVE, true)

      /** A disclosure for prompts. */
      fun sampleDisclosure() = ContextDisclosure("Acme Cloud", "Acme 1", 3L, 120L, 44L, false, emptyList(), 0L)

      /**
       * Preferences in memory, for testing AppSettings' own logic. The file-backed store
       * is exercised by the whole-turn tests; on a Windows host its replace-by-rename
       * fails whenever another process (a virus scanner) has the new file open.
       */
      class MemoryPreferences : DataStore<Preferences> {
          private val lock = Mutex()
          private val state = MutableStateFlow(emptyPreferences())

          override val data: Flow<Preferences> = state

          override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences =
              lock.withLock { transform(state.value).also { state.value = it } }
      }

      /** A fresh in-memory database. */
      fun memoryDatabase(): DrakenDatabase =
          Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), DrakenDatabase::class.java).allowMainThreadQueries().build()
    `,
    { doc: 'Shared test helpers.', provides: ['waitFor', 'XorCipher', 'LostKeyCipher', 'MemoryPreferences', 'deleteNoteSpec', 'sampleDisclosure', 'memoryDatabase'] },
  );
  f.use(
    'androidx.room.Room',
    'androidx.test.core.app.ApplicationProvider',
    'androidx.datastore.core.DataStore',
    'androidx.datastore.preferences.core.Preferences',
    'androidx.datastore.preferences.core.emptyPreferences',
  );
}

function stores(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/data/RoomStoresTest.kt`, { doc: 'persistence', role: 'test' });
  f.use('org.robolectric.RobolectricTestRunner', 'kotlinx.coroutines.flow.first');
  testClass(
    f,
    'RoomStoresTest',
    'The Room stores keep what the core contracts promise.',
    [
      {
        name: 'aConversationKeepsItsMessagesInOrderWithEveryDetail',
        doc: 'Messages come back in the order written, with tool calls, results, route and replay intact; rewriting one keeps its place.',
        code: kt`
          val store = RoomConversationStore(db) { 100L }
          runBlocking {
              val c = store.createConversation("Groceries")
              val user = ChatMessage("m1", c.id, MessageRole.USER, "Find my list", 1L)
              val assistant = ChatMessage(
                  "m2", c.id, MessageRole.ASSISTANT, "", 1L, MessageStatus.STREAMING,
                  listOf(ToolCall("call_1", "notes_search", """{"query":"list"}""")),
                  null, RouteStamp("anthropic", "claude-opus-5-5", false), null, ProviderReplay("anthropic", "{\"blocks\":[]}"),
              )
              val tool = ChatMessage("m3", c.id, MessageRole.TOOL, "Found 1 note", 1L, toolResult = ToolResultRecord("call_1", "notes_search", false, "[]"))
              store.saveMessage(user)
              store.saveMessage(assistant)
              store.saveMessage(tool)
              assertEquals(listOf(user, assistant, tool), store.messages(c.id))

              val finished = assistant.copy(text = "Here it is.", status = MessageStatus.COMPLETE)
              store.saveMessage(finished)
              assertEquals(listOf(user, finished, tool), store.messages(c.id))
          }
        `,
      },
      {
        name: 'deletingAConversationDeletesItsMessages',
        doc: 'The foreign key cascades.',
        code: kt`
          val store = RoomConversationStore(db)
          runBlocking {
              val c = store.createConversation("Temp")
              store.saveMessage(ChatMessage("m1", c.id, MessageRole.USER, "hi", 1L))
              store.delete(c.id)
              assertNull(store.conversation(c.id))
              assertTrue(db.conversations().messages(c.id).isEmpty())
          }
        `,
      },
      {
        name: 'aPinnedModelIsStoredAndCanBeCleared',
        doc: 'Per-conversation model choice survives a reload.',
        code: kt`
          val store = RoomConversationStore(db)
          runBlocking {
              val c = store.createConversation("Pinned")
              val choice = ModelChoice("openai", "gpt-6.1-sol")
              store.pinModel(c.id, choice)
              assertEquals(choice, store.conversation(c.id)?.modelOverride)
              store.pinModel(c.id, null)
              assertNull(store.conversation(c.id)?.modelOverride)
          }
        `,
      },
      {
        name: 'noteSearchMatchesWildcardsLiterally',
        doc: 'A % or _ the user types is a character, not a pattern.',
        code: kt`
          val notes = RoomNotesRepository(db.notes())
          runBlocking {
              notes.create("Discount", "50% off")
              notes.create("Plan_B", "")
              notes.create("Plan B", "")
              assertEquals(listOf("Discount"), notes.search("%", 10L).map { it.title })
              assertEquals(listOf("Plan_B"), notes.search("_", 10L).map { it.title })
              assertEquals(2, notes.search("plan", 10L).size)
          }
        `,
      },
      {
        name: 'grantsAreStoredAndAudited',
        doc: 'A grant is recorded, audited, and revoked with the rest.',
        code: kt`
          val audit = RoomAuditLog(db.audit())
          val grants = RoomGrantStore(db.grants(), audit)
          runBlocking {
              grants.setGranted(NOTES_MODULE_ID, "notes.read", true)
              assertTrue(grants.isGranted(NOTES_MODULE_ID, "notes.read"))
              assertEquals(setOf("notes.read"), grants.observeGranted(NOTES_MODULE_ID).first())
              grants.revokeAll(NOTES_MODULE_ID)
              assertFalse(grants.isGranted(NOTES_MODULE_ID, "notes.read"))
              val events = audit.observeRecent(10L).first()
              assertEquals(listOf("revoked_all", "granted"), events.map { it.outcome })
              assertTrue(events.all { it.category == AuditCategory.PERMISSION_CHANGE })
          }
        `,
      },
      {
        name: 'theAuditTrailKeepsOnlyTheNewestEvents',
        doc: 'Pruning bounds the table.',
        code: kt`
          val audit = RoomAuditLog(db.audit(), keep = 5L)
          runBlocking {
              for (i in 0 until 100) audit.record(AuditEvent(i.toLong(), AuditCategory.TOOL_CALL, "e" + i, "ok"))
              val kept = audit.observeRecent(1000L).first()
              assertEquals(5, kept.size)
              assertEquals("e99", kept.first().subject)
          }
        `,
      },
      {
        name: 'usageAddsUpPerDayAcrossProviders',
        doc: 'The budget counter sums a day and starts fresh the next.',
        code: kt`
          var day = "2026-10-14"
          val usage = UsageMeter(db.usage()) { day }
          runBlocking {
              usage.record("anthropic", 100L)
              usage.record("anthropic", 50L)
              usage.record("openai", 10L)
              assertEquals(160L, usage.tokensToday())
              assertEquals(mapOf("anthropic" to 150L, "openai" to 10L), usage.observeToday().first())
              day = "2026-10-15"
              assertEquals(0L, usage.tokensToday())
          }
        `,
      },
      {
        name: 'aModuleIsStoredWithItsWholeManifest',
        doc: 'The manifest round-trips through its JSON column.',
        code: kt`
          val modules = RoomModuleStore(db.modules())
          val installed = InstalledModule(notesManifest(), true, ModuleSource.BUILT_IN, 5L)
          runBlocking {
              modules.save(installed)
              assertEquals(installed, modules.find(NOTES_MODULE_ID))
              modules.remove(NOTES_MODULE_ID)
              assertNull(modules.find(NOTES_MODULE_ID))
          }
        `,
      },
    ],
    {
      annotations: [ROBOLECTRIC],
      fields: [{ name: 'db', type: 'DrakenDatabase', default: 'memoryDatabase()', visibility: 'private' }],
    },
  );
  f.fn('close', { of: 'RoomStoresTest', annotations: ['After'], doc: 'Close the database.', code: kt`db.close()` });
}

function credentials(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/security/CredentialsTest.kt`, { doc: 'encrypted keys', role: 'test' });
  f.use('org.robolectric.RobolectricTestRunner', 'kotlinx.coroutines.flow.first');
  testClass(
    f,
    'CredentialsTest',
    'Provider keys are encrypted at rest and only their last characters are ever shown.',
    [
      {
        name: 'aKeyIsStoredEncryptedAndReadBackWhole',
        doc: 'What is stored is not the key; what is read is.',
        code: kt`
          val audit = RoomAuditLog(db.audit())
          val keys = EncryptedCredentialStore(db.secrets(), XorCipher(), audit)
          runBlocking {
              keys.save("anthropic", "  sk-ant-12345678 ")
              val stored = db.secrets().find("provider:anthropic")!!
              assertFalse(stored.ciphertext.contentEquals("sk-ant-12345678".toByteArray()))
              assertEquals("5678", stored.hint)
              assertEquals("sk-ant-12345678", keys.apiKey("anthropic"))
              assertEquals(mapOf("anthropic" to "5678"), keys.observeHints().first())
              val event = audit.observeRecent(1L).first().single()
              assertEquals(AuditCategory.CREDENTIAL_CHANGE, event.category)
              assertFalse("the audit never carries the key", event.detail.contains("sk-ant"))
              keys.remove("anthropic")
              assertNull(keys.apiKey("anthropic"))
          }
        `,
      },
      {
        name: 'aKeyThatCannotBeDecryptedReadsAsMissing',
        doc: 'A lost Keystore key means re-entering the key, not a crash.',
        code: kt`
          val keys = EncryptedCredentialStore(db.secrets(), LostKeyCipher(), RoomAuditLog(db.audit()))
          runBlocking { keys.save("openai", "sk-proj-abcd") }
          assertNull(keys.apiKey("openai"))
        `,
      },
      {
        name: 'anEmptyKeyIsRefused',
        doc: 'Saving blank text is an error, not an empty secret.',
        code: kt`
          val keys = EncryptedCredentialStore(db.secrets(), XorCipher(), RoomAuditLog(db.audit()))
          assertThrows(IllegalArgumentException::class.java) { runBlocking { keys.save("openai", "   ") } }
        `,
      },
    ],
    {
      annotations: [ROBOLECTRIC],
      fields: [{ name: 'db', type: 'DrakenDatabase', default: 'memoryDatabase()', visibility: 'private' }],
    },
  );
  f.fn('close', { of: 'CredentialsTest', annotations: ['After'], doc: 'Close the database.', code: kt`db.close()` });
}

function settings(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/settings/AppSettingsTest.kt`, { doc: 'settings', role: 'test' });
  f.use('kotlinx.coroutines.flow.first');
  testClass(
    f,
    'AppSettingsTest',
    'Settings default to the private choice and round-trip through DataStore.',
    [
      {
        name: 'theDefaultAsksBeforeTheCloudAndPrefersTheDevice',
        doc: 'Nothing goes to a cloud model unasked until the user says otherwise.',
        code: kt`
          val prefs = runBlocking { settings.routing().first() }
          assertEquals(RoutingMode.ASK_BEFORE_CLOUD, prefs.mode)
          assertTrue(prefs.preferLocal)
          assertNull(prefs.dailyCloudTokenBudget)
        `,
      },
      {
        name: 'routingChoicesRoundTrip',
        doc: 'Every routing setting is stored and can be cleared.',
        code: kt`
          runBlocking {
              settings.setMode(RoutingMode.AUTOMATIC)
              settings.setPreferLocal(false)
              settings.setPreferredCloud(ModelChoice("anthropic", "claude-opus-5-5"))
              settings.setPreferredLocal(ModelChoice(LOCAL_PROVIDER_ID, "qwen3-0.6b-int4"))
              settings.setDailyBudget(50_000L)
              assertEquals(
                  RoutingPreferences(RoutingMode.AUTOMATIC, false, ModelChoice("anthropic", "claude-opus-5-5"), ModelChoice(LOCAL_PROVIDER_ID, "qwen3-0.6b-int4"), 50_000L),
                  settings.routing().first(),
              )
              settings.setPreferredCloud(null)
              settings.setDailyBudget(null)
              val cleared = settings.routing().first()
              assertNull(cleared.preferredCloud)
              assertNull(cleared.dailyCloudTokenBudget)
          }
        `,
      },
      {
        name: 'aSelfHostedEndpointIsTrimmedAndClearable',
        doc: 'Stray spaces do not end up in a URL.',
        code: kt`
          runBlocking {
              settings.setCustomEndpoint(CustomEndpoint(" https://llm.example.com/v1 ", " llama-4 "))
              assertEquals(CustomEndpoint("https://llm.example.com/v1", "llama-4"), settings.customEndpoint().first())
              settings.setCustomEndpoint(null)
              assertNull(settings.customEndpoint().first())
          }
        `,
      },
      {
        name: 'firstRunSetupIsRemembered',
        doc: 'Seeding default grants happens once, so a revocation is never undone.',
        code: kt`
          runBlocking {
              assertFalse(settings.builtInsSeeded())
              settings.markBuiltInsSeeded()
              assertTrue(settings.builtInsSeeded())
          }
        `,
      },
    ],
    {
      fields: [{ name: 'settings', type: 'AppSettings', default: 'AppSettings(MemoryPreferences())', visibility: 'private' }],
    },
  );
}

function prompts(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/prompts/PromptBrokerTest.kt`, { doc: 'the prompt broker', role: 'test' });
  f.use('kotlinx.coroutines.flow.first', 'kotlinx.coroutines.flow.filterNotNull');
  testClass(f, 'PromptBrokerTest', 'A turn asks the user through the broker and waits for exactly one answer.', [
    {
      name: 'aConfirmationIsShownUntilAnswered',
      doc: 'The prompt appears, the answer comes back, and the prompt goes.',
      code: kt`
        val broker = PromptBroker()
        runBlocking {
            val answer = async(Dispatchers.Default) { broker.confirm(ConfirmationRequest(deleteNoteSpec(), buildJsonObject {})) }
            val prompt = broker.pending.filterNotNull().first() as PendingPrompt.Confirm
            assertEquals("notes.delete", prompt.request.tool.id)
            prompt.reply.complete(true)
            assertTrue(answer.await())
            assertNull(broker.pending.value)
        }
      `,
    },
    {
      name: 'cancellingTheTurnWithdrawsThePrompt',
      doc: 'A stopped turn leaves no dialog behind.',
      code: kt`
        val broker = PromptBroker()
        runBlocking {
            val job = launch(Dispatchers.Default) { broker.approve(sampleDisclosure()) }
            broker.pending.filterNotNull().first()
            job.cancelAndJoin()
            assertNull(broker.pending.value)
        }
      `,
    },
    {
      name: 'questionsAreAskedOneAtATime',
      doc: 'A second question waits until the first is answered.',
      code: kt`
        val broker = PromptBroker()
        runBlocking {
            val cloud = async(Dispatchers.Default) { broker.approve(sampleDisclosure()) }
            val first = broker.pending.filterNotNull().first() as PendingPrompt.CloudSend
            val confirm = async(Dispatchers.Default) { broker.confirm(ConfirmationRequest(deleteNoteSpec(), buildJsonObject {})) }
            delay(100)
            assertSame(first, broker.pending.value)
            first.reply.complete(CloudApproval.ALLOW_ONCE)
            assertEquals(CloudApproval.ALLOW_ONCE, cloud.await())
            val second = broker.pending.filterNotNull().first() as PendingPrompt.Confirm
            second.reply.complete(false)
            assertFalse(confirm.await())
        }
      `,
    },
  ]);
}

function pure(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/ui/TextRulesTest.kt`, { doc: 'small rules the screens rely on', role: 'test' });
  testClass(f, 'TextRulesTest', 'Endpoint checks and conversation titles.', [
    {
      name: 'plainHttpIsAllowedOnlyToThisPhone',
      doc: 'Conversations never cross the network unencrypted.',
      code: kt`
        assertNull(endpointProblem("https://llm.example.com/v1"))
        assertNull(endpointProblem("http://localhost:11434/v1"))
        assertNull(endpointProblem("http://127.0.0.1:8080/v1"))
        assertNotNull(endpointProblem("http://192.168.1.20:11434/v1"))
        assertNotNull(endpointProblem("ftp://example.com"))
        assertNotNull(endpointProblem("not a url"))
        assertNotNull(endpointProblem("https://"))
      `,
    },
    {
      name: 'aTitleComesFromTheFirstLineCutAtAWord',
      doc: 'Short messages are kept; long ones are cut at a space; blank ones keep the default.',
      code: kt`
        assertEquals("Plan the trip", titleFrom("  Plan the trip  "))
        assertEquals("What should I pack", titleFrom("\n\nWhat should I pack\nfor Lisbon?"))
        val long = titleFrom("Please compare the three apartment listings I saved yesterday and tell me which is closest to the station")
        assertTrue(long.endsWith("…"))
        assertTrue(long.length <= 61)
        assertFalse(long.dropLast(1).endsWith(" "))
        assertEquals(NEW_CONVERSATION_TITLE, titleFrom("   "))
      `,
    },
  ]);
}

function turns(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/chat/ChatFlowTest.kt`, { doc: 'whole turns through the real container', role: 'test' });
  f.use(
    'org.robolectric.RobolectricTestRunner',
    'androidx.test.core.app.ApplicationProvider',
    'kotlinx.coroutines.flow.first',
    'kotlinx.coroutines.flow.filterNotNull',
  );
  f.decl(
    kt`
      /** A two-chunk reply in the OpenAI-compatible stream format. */
      private val HELLO_STREAM =
          "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"}}]}\n\n" +
              "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" there.\"},\"finish_reason\":\"stop\"}]}\n\n" +
              "data: [DONE]\n\n"
    `,
    { doc: 'The scripted server reply.' },
  );
  testClass(
    f,
    'ChatFlowTest',
    'A message sent from the chat screen\'s ViewModel is routed, approved or refused, streamed and stored - through the same wiring the app uses.',
    [
      {
        name: 'anApprovedCloudReplyIsStreamedAndStored',
        doc: 'Asked first, sent once approved, stored with its route, counted in the audit.',
        code: kt`
          server.enqueue(MockResponse.Builder().code(200).addHeader("content-type", "text/event-stream").body(HELLO_STREAM).build())
          val conversation = useServer()
          val disclosure = CompletableDeferred<ContextDisclosure>()
          val answerer = CoroutineScope(Dispatchers.Default).launch {
              val prompt = container.prompts.pending.filterNotNull().first() as PendingPrompt.CloudSend
              disclosure.complete(prompt.disclosure)
              prompt.reply.complete(CloudApproval.ALLOW_ONCE)
          }
          val vm = ChatViewModel(container, conversation.id)
          vm.send("Hi")
          val reply = waitFor { stored(conversation.id).firstOrNull { it.role == MessageRole.ASSISTANT && it.status == MessageStatus.COMPLETE } }
          waitFor { if (vm.turn.value.running) null else true }
          answerer.cancel()

          assertEquals("Hello there.", reply.text)
          assertEquals(RouteStamp(CUSTOM_PROVIDER_ID, "test-model", false), reply.route)
          val shown = runBlocking { disclosure.await() }
          assertEquals("Self-hosted", shown.providerName)
          assertEquals(1L, shown.messageCount)
          val request = server.takeRequest()
          assertEquals("/v1/chat/completions", request.url.encodedPath)
          assertNull("no key was saved, so none is sent", request.headers["Authorization"])
          assertTrue(request.body!!.utf8().contains("\"Hi\""))
          assertEquals("Hi", runBlocking { container.conversations.conversation(conversation.id) }?.title)
          val audited = runBlocking { container.audit.observeRecent(50L).first() }
          assertTrue(audited.any { it.category == AuditCategory.CLOUD_REQUEST && it.outcome == "sent" })
          assertNull(vm.turn.value.notice)
        `,
      },
      {
        name: 'declinedCloudSendsNothing',
        doc: 'Saying no keeps every word on the device, and says so.',
        code: kt`
          val conversation = useServer()
          val answerer = CoroutineScope(Dispatchers.Default).launch {
              val prompt = container.prompts.pending.filterNotNull().first() as PendingPrompt.CloudSend
              prompt.reply.complete(CloudApproval.DENY)
          }
          val vm = ChatViewModel(container, conversation.id)
          vm.send("Keep this here")
          val notice = waitFor { vm.turn.value.notice }
          answerer.cancel()
          assertEquals("Not sent. Nothing left this device.", notice)
          assertEquals(0, server.requestCount)
          assertEquals(listOf(MessageRole.USER), stored(conversation.id).map { it.role })
          val audited = runBlocking { container.audit.observeRecent(50L).first() }
          assertTrue(audited.any { it.category == AuditCategory.CLOUD_REQUEST && it.outcome == "declined" })
        `,
      },
      {
        name: 'onDeviceOnlyRefusesWithoutAModelAndSaysWhy',
        doc: 'LOCAL_ONLY with nothing installed never reaches the configured server.',
        code: kt`
          val conversation = useServer()
          runBlocking { container.settings.setMode(RoutingMode.LOCAL_ONLY) }
          val vm = ChatViewModel(container, conversation.id)
          vm.send("Hello")
          val notice = waitFor { vm.turn.value.notice }
          assertTrue(notice, notice.startsWith("No on-device model is installed"))
          assertEquals(0, server.requestCount)
        `,
      },
    ],
    {
      annotations: [ROBOLECTRIC],
      fields: [
        { name: 'server', type: 'MockWebServer', default: 'MockWebServer().apply { start() }', visibility: 'private' },
        { name: 'container', type: 'AppContainer', default: 'ApplicationProvider.getApplicationContext<DrakenApplication>().container', visibility: 'private' },
      ],
    },
  );
  const T = 'ChatFlowTest';
  f.fn('tearDown', { of: T, annotations: ['After'], doc: 'Stop the server.', code: kt`server.close()` });
  f.fn('useServer', {
    of: T,
    visibility: 'private',
    doc: 'Point the self-hosted endpoint at the test server, ask before the cloud, and start a conversation. The mode is set every time: the settings store outlives one test.',
    returns: 'Conversation',
    code: kt`
      return runBlocking {
          container.settings.setMode(RoutingMode.ASK_BEFORE_CLOUD)
          container.settings.setCustomEndpoint(CustomEndpoint(server.url("/v1").toString(), "test-model"))
          container.conversations.createConversation(NEW_CONVERSATION_TITLE)
      }
    `,
  });
  f.fn('stored', { of: T, visibility: 'private', doc: 'A conversation\'s stored messages.', params: [{ name: 'id', type: 'string' }], returns: 'List<ChatMessage>', expression: true, code: kt`runBlocking { container.conversations.messages(id) }` });
}

function screens(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/ui/ScreensTest.kt`, { doc: 'screens, driven as a user would', role: 'test' });
  f.use(
    'org.robolectric.RobolectricTestRunner',
    'androidx.compose.ui.test.junit4.createComposeRule',
    'androidx.compose.ui.test.onNodeWithText',
    'androidx.compose.ui.test.onAllNodesWithText',
    'androidx.compose.ui.test.performClick',
    'androidx.compose.ui.test.assertIsDisplayed',
  );
  testClass(
    f,
    'ScreensTest',
    'Buttons do what they say.',
    [
      {
        name: 'theCloudDialogShowsWhatWouldBeSentAndDecliningWorks',
        doc: 'The disclosure is on screen, and "Don\'t send" answers no.',
        code: kt`
          val broker = PromptBroker()
          compose.setContent { DrakenTheme { PromptHost(broker) } }
          val answer = CoroutineScope(Dispatchers.Default).async { broker.approve(sampleDisclosure()) }
          compose.waitUntil(5_000L) { broker.pending.value != null }
          compose.onNodeWithText("Send to Acme Cloud?").assertIsDisplayed()
          compose.onNodeWithText("Acme 1").assertIsDisplayed()
          compose.onNodeWithText("Don't send").performClick()
          assertEquals(CloudApproval.DENY, runBlocking { answer.await() })
          compose.waitUntil(5_000L) { broker.pending.value == null }
        `,
      },
      {
        name: 'newChatCreatesAConversationAndOpensIt',
        doc: 'The home screen\'s main button makes a real, stored conversation.',
        code: kt`
          val db = memoryDatabase()
          val store = RoomConversationStore(db)
          var opened: String? = null
          val vm = HistoryViewModel(store)
          compose.setContent { DrakenTheme { HistoryScreen(vm, onOpen = { opened = it }, onNotes = {}, onSettings = {}) } }
          compose.waitUntil(5_000L) { compose.onAllNodesWithText("No conversations yet").fetchSemanticsNodes().isNotEmpty() }
          // Found by its label in the merged tree, as a screen reader finds it.
          compose.onNodeWithText("New chat").performClick()
          // The ViewModel resumes on the main looper, which waitFor runs.
          waitFor { opened }
          assertEquals(NEW_CONVERSATION_TITLE, runBlocking { store.conversation(opened!!) }?.title)
          db.close()
        `,
      },
    ],
    {
      annotations: [ROBOLECTRIC],
      fields: [
        {
          name: 'compose',
          type: 'ComposeContentTestRule',
          default: 'createComposeRule()',
          // The v2 rule runs composition effects on a StandardTestDispatcher it does not
          // advance while the ViewModels publish on Main, so a screen's collector never
          // starts. Kept on v1 until ViewModels take their dispatcher as a parameter.
          annotations: ['get:Rule', 'Suppress("DEPRECATION")'],
        },
      ],
    },
  );
  f.use('androidx.compose.ui.test.junit4.ComposeContentTestRule');
}
