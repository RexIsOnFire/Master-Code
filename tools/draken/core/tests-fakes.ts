/**
 * In-memory test doubles for the platform contracts. Test-only: none of these
 * is reachable from production code, and none pretends to be a provider a user
 * could pick.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const TEST = 'core/src/test/kotlin/com/draken/core';

export function buildPlatformFakes(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/testing/PlatformFakes.kt`, { doc: 'in-memory doubles for the platform contracts', role: 'test' });

  f.decl(
    kt`
      /** A provider whose replies are scripted per request; it records every request it was sent. */
      class FakeProvider(
          private val id: String,
          private val kind: ProviderKind,
          val model: ModelDescriptor,
          private val script: suspend FlowCollector<ModelEvent>.(request: ModelRequest, attempt: Int) -> Unit,
      ) : ModelProvider {
          val requests = mutableListOf<ModelRequest>()

          override fun descriptor() =
              ProviderDescriptor(id, id, kind, if (kind == ProviderKind.LOCAL) ProviderFamily.ON_DEVICE else ProviderFamily.OPENAI_COMPATIBLE)

          override fun models() = listOf(model)

          override fun stream(request: ModelRequest): Flow<ModelEvent> = flow {
              requests.add(request)
              script(request, requests.size)
          }
      }

      fun testModel(providerId: String, tools: Boolean = true, context: Long = 100_000L, output: Long = 4_096L) =
          ModelDescriptor(providerId, providerId + "-model", providerId + " model", ModelCapabilities(context, output, tools, false, true))

      /** A reply with some text and a normal end. */
      suspend fun FlowCollector<ModelEvent>.reply(text: String) {
          emit(ModelEvent.TextDelta(text))
          emit(ModelEvent.UsageReport(10L, 5L))
          emit(ModelEvent.Finished(StopReason.END_TURN, null))
      }

      /** A reply that stops to call one tool. */
      suspend fun FlowCollector<ModelEvent>.callTool(id: String, name: String, arguments: String) {
          emit(ModelEvent.ToolCallRequested(ToolCall(id, name, arguments)))
          emit(ModelEvent.Finished(StopReason.TOOL_USE, ProviderReplay("test", "{}")))
      }

      class FakeDirectory(
          private val providers: List<FakeProvider>,
          var preferences: RoutingPreferences = RoutingPreferences(),
          var ready: Set<String> = providers.map { it.descriptor().id }.toSet(),
      ) : ProviderDirectory {
          var cloudTokens = 0L

          override suspend fun candidates() = providers.map {
              RouteCandidate(it.model, it.descriptor().kind, it.descriptor().id in ready, if (it.descriptor().id in ready) null else "not set up")
          }

          override fun provider(providerId: String): ModelProvider? = providers.firstOrNull { it.descriptor().id == providerId }

          override suspend fun preferences() = preferences

          override suspend fun cloudTokensToday() = cloudTokens

          override suspend fun recordCloudUsage(providerId: String, tokens: Long) {
              cloudTokens += tokens
          }
      }

      class MemoryConversations : ConversationStore {
          val conversations = mutableMapOf<String, Conversation>()
          val messages = mutableListOf<ChatMessage>()

          override suspend fun createConversation(title: String): Conversation {
              val conversation = Conversation("c" + (conversations.size + 1), title, 0L, 0L)
              conversations[conversation.id] = conversation
              return conversation
          }

          override suspend fun conversation(id: String) = conversations[id]

          override suspend fun messages(conversationId: String) = messages.filter { it.conversationId == conversationId }

          override suspend fun saveMessage(message: ChatMessage) {
              val index = messages.indexOfFirst { it.id == message.id }
              if (index >= 0) messages[index] = message else messages.add(message)
          }
      }

      class MemoryGrants : GrantStore {
          val granted = mutableSetOf<Pair<String, String>>()

          override suspend fun isGranted(moduleId: String, capabilityId: String) = (moduleId to capabilityId) in granted

          override suspend fun setGranted(moduleId: String, capabilityId: String, granted: Boolean) {
              if (granted) this.granted.add(moduleId to capabilityId) else this.granted.remove(moduleId to capabilityId)
          }

          override suspend fun revokeAll(moduleId: String) {
              granted.removeAll { it.first == moduleId }
          }
      }

      class MemoryModules : ModuleStore {
          val modules = mutableMapOf<String, InstalledModule>()

          override suspend fun all() = modules.values.toList()

          override suspend fun find(id: String) = modules[id]

          override suspend fun save(module: InstalledModule) {
              modules[module.manifest.id] = module
          }

          override suspend fun remove(id: String) {
              modules.remove(id)
          }
      }

      class RecordingAudit : AuditLog {
          val events = mutableListOf<AuditEvent>()

          override suspend fun record(event: AuditEvent) {
              events.add(event)
          }
      }

      class FixedPlatform(var granted: Set<String> = emptySet()) : PlatformPermissions {
          override fun isGranted(permission: String) = permission in granted
      }

      /** Answers every confirmation the same way, and counts the questions. */
      class FixedConfirmations(var answer: Boolean) : ConfirmationGate {
          var asked = 0

          override suspend fun confirm(request: ConfirmationRequest): Boolean {
              asked += 1
              return answer
          }
      }

      class FixedApprovals(var answer: CloudApproval) : CloudApprovalGate {
          var asked = 0

          override suspend fun approve(disclosure: ContextDisclosure): CloudApproval {
              asked += 1
              return answer
          }
      }

      class MemoryNotes : NotesRepository {
          val notes = linkedMapOf<String, Note>()
          private var clock = 0L

          override suspend fun create(title: String, body: String): Note {
              clock += 1
              val note = Note("n" + (notes.size + 1), title, body, clock, clock)
              notes[note.id] = note
              return note
          }

          override suspend fun update(id: String, title: String, body: String): Note? {
              val current = notes[id] ?: return null
              clock += 1
              return current.copy(title = title, body = body, updatedAt = clock).also { notes[id] = it }
          }

          override suspend fun find(id: String) = notes[id]

          override suspend fun delete(id: String) = notes.remove(id) != null

          override suspend fun search(query: String, limit: Long) =
              notes.values.filter { it.title.contains(query, true) || it.body.contains(query, true) }
                  .sortedByDescending { it.updatedAt }.take(limit.toInt())

          override suspend fun recent(limit: Long) = notes.values.sortedByDescending { it.updatedAt }.take(limit.toInt())
      }

      /** The platform as the app assembles it, over in-memory stores, with Notes installed and granted. */
      class TestPlatform(confirm: Boolean = true) {
          val notes = MemoryNotes()
          val grants = MemoryGrants()
          val modules = MemoryModules()
          val audit = RecordingAudit()
          val platform = FixedPlatform()
          val confirmations = FixedConfirmations(confirm)
          val registry = ToolRegistry()
          val handlers = HandlerCatalog().also { addNotesHandlers(it, notes) }
          val manager = ModuleManager(modules, handlers, registry, grants, audit) { 1L }
          val broker = PermissionBroker(manager, grants, platform)
          val executor = ToolExecutor(registry, broker, confirmations, audit, { 1L }, 2_000L)

          suspend fun installNotes(grant: Boolean = true) {
              manager.install(notesManifest(), ModuleSource.BUILT_IN)
              if (grant) {
                  grants.setGranted(NOTES_MODULE_ID, "notes.read", true)
                  grants.setGranted(NOTES_MODULE_ID, "notes.write", true)
              }
          }
      }
    `,
    {
      doc: 'Test doubles; declarations because several take suspend lambdas with receivers, which the type vocabulary does not spell.',
      provides: [
        'FakeProvider', 'testModel', 'reply', 'callTool', 'FakeDirectory', 'MemoryConversations', 'MemoryGrants', 'MemoryModules',
        'RecordingAudit', 'FixedPlatform', 'FixedConfirmations', 'FixedApprovals', 'MemoryNotes', 'TestPlatform',
      ],
    },
  );
}
