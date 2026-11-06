/**
 * The app's persistence: Room entities, DAOs, the database, and repositories
 * implementing the core contracts.
 *
 * Messages are stored with an explicit position, not ordered by timestamp:
 * a tool result and the reply after it can land in the same millisecond, and
 * a conversation replayed out of order is a different conversation.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'app/src/main/kotlin/com/draken/app/data';

export function buildData(ctx: Ctx): void {
  entities(ctx);
  daos(ctx);
  database(ctx);
  conversations(ctx);
  stores(ctx);
}

const col = (name: string): string => `ColumnInfo(name = "${name}")`;

function entities(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/Entities.kt`, { doc: 'Room entities' });
  f.use('androidx.room.ColumnInfo', 'androidx.room.Entity', 'androidx.room.ForeignKey', 'androidx.room.Index', 'androidx.room.PrimaryKey');

  f.record(
    'ConversationEntity',
    [
      { name: 'id', type: 'string', annotations: ['PrimaryKey'] },
      { name: 'title', type: 'string' },
      { name: 'createdAt', type: 'i64', annotations: [col('created_at')] },
      { name: 'updatedAt', type: 'i64', annotations: [col('updated_at')] },
      { name: 'pinnedProvider', type: 'Option<string>', annotations: [col('pinned_provider')] },
      { name: 'pinnedModel', type: 'Option<string>', annotations: [col('pinned_model')] },
    ],
    { doc: 'A conversation row.', annotations: ['Entity(tableName = "conversations")'] },
  );

  f.record(
    'MessageEntity',
    [
      { name: 'id', type: 'string', annotations: ['PrimaryKey'] },
      { name: 'conversationId', type: 'string', annotations: [col('conversation_id')] },
      { name: 'position', type: 'i64', doc: 'Order within the conversation.' },
      { name: 'role', type: 'string' },
      { name: 'text', type: 'string' },
      { name: 'createdAt', type: 'i64', annotations: [col('created_at')] },
      { name: 'status', type: 'string' },
      { name: 'toolCallsJson', type: 'string', annotations: [col('tool_calls')] },
      { name: 'toolResultJson', type: 'Option<string>', annotations: [col('tool_result')] },
      { name: 'routeProvider', type: 'Option<string>', annotations: [col('route_provider')] },
      { name: 'routeModel', type: 'Option<string>', annotations: [col('route_model')] },
      { name: 'routeLocal', type: 'Option<bool>', annotations: [col('route_local')] },
      { name: 'error', type: 'Option<string>' },
      { name: 'replayProvider', type: 'Option<string>', annotations: [col('replay_provider')] },
      { name: 'replayPayload', type: 'Option<string>', annotations: [col('replay_payload')] },
    ],
    {
      doc: 'A message row. Deleting its conversation deletes it.',
      annotations: [
        'Entity(tableName = "messages", foreignKeys = [ForeignKey(entity = ConversationEntity::class, parentColumns = ["id"], childColumns = ["conversation_id"], onDelete = ForeignKey.CASCADE)], indices = [Index("conversation_id")])',
      ],
    },
  );

  f.record(
    'NoteEntity',
    [
      { name: 'id', type: 'string', annotations: ['PrimaryKey'] },
      { name: 'title', type: 'string' },
      { name: 'body', type: 'string' },
      { name: 'createdAt', type: 'i64', annotations: [col('created_at')] },
      { name: 'updatedAt', type: 'i64', annotations: [col('updated_at')] },
    ],
    { doc: 'A note row.', annotations: ['Entity(tableName = "notes", indices = [Index("updated_at")])'] },
  );

  f.record(
    'ModuleEntity',
    [
      { name: 'id', type: 'string', annotations: ['PrimaryKey'] },
      { name: 'manifestJson', type: 'string', annotations: [col('manifest')] },
      { name: 'enabled', type: 'bool' },
      { name: 'source', type: 'string' },
      { name: 'installedAt', type: 'i64', annotations: [col('installed_at')] },
    ],
    { doc: 'An installed module, its manifest kept whole.', annotations: ['Entity(tableName = "modules")'] },
  );

  f.record(
    'GrantEntity',
    [
      { name: 'moduleId', type: 'string', annotations: [col('module_id')] },
      { name: 'capability', type: 'string' },
      { name: 'grantedAt', type: 'i64', annotations: [col('granted_at')] },
    ],
    { doc: 'One capability the user granted one module.', annotations: ['Entity(tableName = "grants", primaryKeys = ["module_id", "capability"])'] },
  );

  f.record(
    'AuditEntity',
    [
      { name: 'id', type: 'i64', annotations: ['PrimaryKey(autoGenerate = true)'] },
      { name: 'at', type: 'i64' },
      { name: 'category', type: 'string' },
      { name: 'subject', type: 'string' },
      { name: 'outcome', type: 'string' },
      { name: 'detail', type: 'string' },
    ],
    { doc: 'An audit event row.', annotations: ['Entity(tableName = "audit_events", indices = [Index("at")])'] },
  );

  f.record(
    'UsageEntity',
    [
      { name: 'day', type: 'string', doc: 'ISO date, local time.' },
      { name: 'providerId', type: 'string', annotations: [col('provider_id')] },
      { name: 'tokens', type: 'i64' },
    ],
    { doc: 'Cloud tokens used per provider per day, for the budget.', annotations: ['Entity(tableName = "usage", primaryKeys = ["day", "provider_id"])'] },
  );

  f.record(
    'SecretEntity',
    [
      { name: 'name', type: 'string', annotations: ['PrimaryKey'] },
      { name: 'ciphertext', type: 'bytes', doc: 'Encrypted under a Keystore key; never plaintext.' },
      { name: 'hint', type: 'string', doc: 'The last characters, for recognising which key is saved.' },
      { name: 'updatedAt', type: 'i64', annotations: [col('updated_at')] },
    ],
    { doc: 'An encrypted secret, such as a provider API key.', annotations: ['Entity(tableName = "secrets")'] },
  );
}

function daos(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/Daos.kt`, { doc: 'Room data access objects' });
  f.use('androidx.room.Dao', 'androidx.room.Query', 'androidx.room.Upsert', 'androidx.room.Insert');

  f.iface(
    'ConversationDao',
    [
      { name: 'observeAll', returns: 'Flow<List<ConversationEntity>>', annotations: ['Query("SELECT * FROM conversations ORDER BY updated_at DESC")'], doc: 'Every conversation, most recent first.' },
      { name: 'find', suspend: true, params: [{ name: 'id', type: 'string' }], returns: 'Option<ConversationEntity>', annotations: ['Query("SELECT * FROM conversations WHERE id = :id")'], doc: 'One conversation.' },
      { name: 'upsert', suspend: true, params: [{ name: 'conversation', type: 'ConversationEntity' }], annotations: ['Upsert'], doc: 'Insert or update.' },
      { name: 'touch', suspend: true, params: [{ name: 'id', type: 'string' }, { name: 'at', type: 'i64' }], annotations: ['Query("UPDATE conversations SET updated_at = :at WHERE id = :id")'], doc: 'Mark a conversation as just used.' },
      { name: 'delete', suspend: true, params: [{ name: 'id', type: 'string' }], annotations: ['Query("DELETE FROM conversations WHERE id = :id")'], doc: 'Delete a conversation; its messages go with it.' },
      { name: 'messages', suspend: true, params: [{ name: 'conversationId', type: 'string' }], returns: 'List<MessageEntity>', annotations: ['Query("SELECT * FROM messages WHERE conversation_id = :conversationId ORDER BY position")'], doc: 'A conversation\'s messages, in order.' },
      { name: 'observeMessages', params: [{ name: 'conversationId', type: 'string' }], returns: 'Flow<List<MessageEntity>>', annotations: ['Query("SELECT * FROM messages WHERE conversation_id = :conversationId ORDER BY position")'], doc: 'A conversation\'s messages, live.' },
      { name: 'positionOf', suspend: true, params: [{ name: 'id', type: 'string' }], returns: 'Option<i64>', annotations: ['Query("SELECT position FROM messages WHERE id = :id")'], doc: 'Where a message already sits.' },
      { name: 'lastPosition', suspend: true, params: [{ name: 'conversationId', type: 'string' }], returns: 'Option<i64>', annotations: ['Query("SELECT MAX(position) FROM messages WHERE conversation_id = :conversationId")'], doc: 'The last position used.' },
      { name: 'upsertMessage', suspend: true, params: [{ name: 'message', type: 'MessageEntity' }], annotations: ['Upsert'], doc: 'Insert or update a message.' },
    ],
    { doc: 'Conversations and their messages.', annotations: ['Dao'] },
  );

  f.iface(
    'NoteDao',
    [
      { name: 'observeRecent', params: [{ name: 'limit', type: 'i64' }], returns: 'Flow<List<NoteEntity>>', annotations: ['Query("SELECT * FROM notes ORDER BY updated_at DESC LIMIT :limit")'], doc: 'Recent notes, live.' },
      { name: 'recent', suspend: true, params: [{ name: 'limit', type: 'i64' }], returns: 'List<NoteEntity>', annotations: ['Query("SELECT * FROM notes ORDER BY updated_at DESC LIMIT :limit")'], doc: 'Recent notes.' },
      {
        name: 'search',
        suspend: true,
        params: [{ name: 'pattern', type: 'string' }, { name: 'limit', type: 'i64' }],
        returns: 'List<NoteEntity>',
        annotations: [`Query("SELECT * FROM notes WHERE title LIKE :pattern ESCAPE '\\\\' OR body LIKE :pattern ESCAPE '\\\\' ORDER BY updated_at DESC LIMIT :limit")`],
        doc: 'Notes matching a LIKE pattern, with backslash as the escape character.',
      },
      { name: 'find', suspend: true, params: [{ name: 'id', type: 'string' }], returns: 'Option<NoteEntity>', annotations: ['Query("SELECT * FROM notes WHERE id = :id")'], doc: 'One note.' },
      { name: 'observe', params: [{ name: 'id', type: 'string' }], returns: 'Flow<Option<NoteEntity>>', annotations: ['Query("SELECT * FROM notes WHERE id = :id")'], doc: 'One note, live.' },
      { name: 'upsert', suspend: true, params: [{ name: 'note', type: 'NoteEntity' }], annotations: ['Upsert'], doc: 'Insert or update.' },
      { name: 'delete', suspend: true, params: [{ name: 'id', type: 'string' }], returns: 'i32', annotations: ['Query("DELETE FROM notes WHERE id = :id")'], doc: 'Delete; the number of rows removed.' },
    ],
    { doc: 'Notes.', annotations: ['Dao'] },
  );

  f.iface(
    'ModuleDao',
    [
      { name: 'all', suspend: true, returns: 'List<ModuleEntity>', annotations: ['Query("SELECT * FROM modules")'], doc: 'Every installed module.' },
      { name: 'observeAll', returns: 'Flow<List<ModuleEntity>>', annotations: ['Query("SELECT * FROM modules")'], doc: 'Every installed module, live.' },
      { name: 'find', suspend: true, params: [{ name: 'id', type: 'string' }], returns: 'Option<ModuleEntity>', annotations: ['Query("SELECT * FROM modules WHERE id = :id")'], doc: 'One module.' },
      { name: 'upsert', suspend: true, params: [{ name: 'module', type: 'ModuleEntity' }], annotations: ['Upsert'], doc: 'Insert or update.' },
      { name: 'delete', suspend: true, params: [{ name: 'id', type: 'string' }], annotations: ['Query("DELETE FROM modules WHERE id = :id")'], doc: 'Forget a module.' },
    ],
    { doc: 'Installed modules.', annotations: ['Dao'] },
  );

  f.iface(
    'GrantDao',
    [
      { name: 'exists', suspend: true, params: [{ name: 'moduleId', type: 'string' }, { name: 'capability', type: 'string' }], returns: 'bool', annotations: ['Query("SELECT EXISTS(SELECT 1 FROM grants WHERE module_id = :moduleId AND capability = :capability)")'], doc: 'Whether a grant exists.' },
      { name: 'observeFor', params: [{ name: 'moduleId', type: 'string' }], returns: 'Flow<List<GrantEntity>>', annotations: ['Query("SELECT * FROM grants WHERE module_id = :moduleId")'], doc: 'A module\'s grants, live.' },
      { name: 'upsert', suspend: true, params: [{ name: 'grant', type: 'GrantEntity' }], annotations: ['Upsert'], doc: 'Record a grant.' },
      { name: 'delete', suspend: true, params: [{ name: 'moduleId', type: 'string' }, { name: 'capability', type: 'string' }], annotations: ['Query("DELETE FROM grants WHERE module_id = :moduleId AND capability = :capability")'], doc: 'Revoke one grant.' },
      { name: 'deleteAll', suspend: true, params: [{ name: 'moduleId', type: 'string' }], annotations: ['Query("DELETE FROM grants WHERE module_id = :moduleId")'], doc: 'Revoke every grant a module held.' },
    ],
    { doc: 'Capability grants.', annotations: ['Dao'] },
  );

  f.iface(
    'AuditDao',
    [
      { name: 'insert', suspend: true, params: [{ name: 'event', type: 'AuditEntity' }], annotations: ['Insert'], doc: 'Append an event.' },
      { name: 'observeRecent', params: [{ name: 'limit', type: 'i64' }], returns: 'Flow<List<AuditEntity>>', annotations: ['Query("SELECT * FROM audit_events ORDER BY at DESC, id DESC LIMIT :limit")'], doc: 'The newest events, live.' },
      { name: 'prune', suspend: true, params: [{ name: 'keep', type: 'i64' }], annotations: ['Query("DELETE FROM audit_events WHERE id NOT IN (SELECT id FROM audit_events ORDER BY id DESC LIMIT :keep)")'], doc: 'Keep only the newest events.' },
    ],
    { doc: 'The audit trail.', annotations: ['Dao'] },
  );

  f.iface(
    'UsageDao',
    [
      { name: 'tokensOn', suspend: true, params: [{ name: 'day', type: 'string' }], returns: 'Option<i64>', annotations: ['Query("SELECT SUM(tokens) FROM usage WHERE day = :day")'], doc: 'Cloud tokens used on a day, all providers.' },
      { name: 'find', suspend: true, params: [{ name: 'day', type: 'string' }, { name: 'providerId', type: 'string' }], returns: 'Option<UsageEntity>', annotations: ['Query("SELECT * FROM usage WHERE day = :day AND provider_id = :providerId")'], doc: 'One provider\'s count for a day.' },
      // Not INSERT ... ON CONFLICT DO UPDATE: that needs SQLite 3.24, and
      // Android 10 ships 3.22. Room's @Upsert does not use the syntax.
      { name: 'upsert', suspend: true, params: [{ name: 'usage', type: 'UsageEntity' }], annotations: ['Upsert'], doc: 'Store a day\'s count.' },
      { name: 'observeOn', params: [{ name: 'day', type: 'string' }], returns: 'Flow<List<UsageEntity>>', annotations: ['Query("SELECT * FROM usage WHERE day = :day")'], doc: 'A day\'s usage, live.' },
    ],
    { doc: 'Cloud usage per day.', annotations: ['Dao'] },
  );

  f.iface(
    'SecretDao',
    [
      { name: 'find', params: [{ name: 'name', type: 'string' }], returns: 'Option<SecretEntity>', annotations: ['Query("SELECT * FROM secrets WHERE name = :name")'], doc: 'One secret. Blocking by design: credential reads happen inside a provider request, off the main thread.' },
      { name: 'observeHints', returns: 'Flow<List<SecretHint>>', annotations: ['Query("SELECT name, hint FROM secrets")'], doc: 'Which secrets exist, with their hints - never the ciphertext.' },
      { name: 'upsert', suspend: true, params: [{ name: 'secret', type: 'SecretEntity' }], annotations: ['Upsert'], doc: 'Store or replace.' },
      { name: 'delete', suspend: true, params: [{ name: 'name', type: 'string' }], annotations: ['Query("DELETE FROM secrets WHERE name = :name")'], doc: 'Forget a secret.' },
    ],
    { doc: 'Encrypted secrets.', annotations: ['Dao'] },
  );

  f.record(
    'SecretHint',
    [
      { name: 'name', type: 'string' },
      { name: 'hint', type: 'string' },
    ],
    { doc: 'That a secret exists, and how to recognise it.' },
  );
}

function database(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/DrakenDatabase.kt`, { doc: 'the Room database' });
  f.use('androidx.room.Database', 'androidx.room.Room', 'androidx.room.RoomDatabase', 'android.content.Context');
  f.decl(
    kt`
      /**
       * Everything Draken stores, in one database on the device. Its schema is exported with the
       * build so every future version ships with a migration rather than a wipe.
       */
      @Database(
          entities = [
              ConversationEntity::class, MessageEntity::class, NoteEntity::class, ModuleEntity::class,
              GrantEntity::class, AuditEntity::class, UsageEntity::class, SecretEntity::class,
          ],
          version = 1,
          exportSchema = true,
      )
      abstract class DrakenDatabase : RoomDatabase() {
          abstract fun conversations(): ConversationDao

          abstract fun notes(): NoteDao

          abstract fun modules(): ModuleDao

          abstract fun grants(): GrantDao

          abstract fun audit(): AuditDao

          abstract fun usage(): UsageDao

          abstract fun secrets(): SecretDao
      }

      /** The app's database file. */
      fun openDrakenDatabase(context: Context): DrakenDatabase =
          Room.databaseBuilder(context, DrakenDatabase::class.java, "draken.db").build()
    `,
    {
      doc: 'The database: a declaration because Room needs an abstract class with abstract DAO accessors.',
      provides: ['DrakenDatabase', 'openDrakenDatabase'],
    },
  );
}

function conversations(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/RoomConversationStore.kt`, { doc: 'conversations in Room' });
  f.use('androidx.room.withTransaction', 'kotlinx.coroutines.flow.map', 'kotlinx.serialization.builtins.ListSerializer');

  f.cls('RoomConversationStore', {
    doc: 'ConversationStore over Room, plus the live queries the interface shows.',
    implements: ['ConversationStore'],
    fields: [
      { name: 'db', type: 'DrakenDatabase', visibility: 'private' },
      { name: 'clock', type: '() -> i64', visibility: 'private' },
    ],
    ctor: [
      { name: 'db', type: 'DrakenDatabase' },
      { name: 'clock', type: '() -> i64', default: '{ System.currentTimeMillis() }' },
    ],
  });
  const C = 'RoomConversationStore';
  f.fn('createConversation', {
    of: C, override: true, suspend: true,
    doc: 'Start a conversation.',
    params: [{ name: 'title', type: 'string' }],
    returns: 'Conversation',
    code: kt`
      val now = clock()
      val entity = ConversationEntity(UUID.randomUUID().toString(), title, now, now, null, null)
      db.conversations().upsert(entity)
      return toConversation(entity)
    `,
  });
  f.fn('conversation', {
    of: C, override: true, suspend: true,
    doc: 'One conversation.',
    params: [{ name: 'id', type: 'string' }],
    returns: 'Option<Conversation>',
    expression: true,
    code: kt`db.conversations().find(id)?.let { toConversation(it) }`,
  });
  f.fn('messages', {
    of: C, override: true, suspend: true,
    doc: 'A conversation\'s messages, in order.',
    params: [{ name: 'conversationId', type: 'string' }],
    returns: 'List<ChatMessage>',
    expression: true,
    code: kt`db.conversations().messages(conversationId).map { toChatMessage(it) }`,
  });
  f.fn('saveMessage', {
    of: C, override: true, suspend: true,
    doc: 'Insert or replace a message, keeping its position, and mark the conversation used - in one transaction.',
    params: [{ name: 'message', type: 'ChatMessage' }],
    code: kt`
      db.withTransaction {
          val dao = db.conversations()
          val position = dao.positionOf(message.id) ?: ((dao.lastPosition(message.conversationId) ?: -1L) + 1L)
          dao.upsertMessage(toEntity(message, position))
          dao.touch(message.conversationId, clock())
      }
    `,
  });
  f.fn('observeConversations', {
    of: C,
    doc: 'Every conversation, most recent first, live.',
    returns: 'Flow<List<Conversation>>',
    expression: true,
    code: kt`db.conversations().observeAll().map { list -> list.map { toConversation(it) } }`,
  });
  f.fn('observeMessages', {
    of: C,
    doc: 'A conversation\'s messages, live.',
    params: [{ name: 'conversationId', type: 'string' }],
    returns: 'Flow<List<ChatMessage>>',
    expression: true,
    code: kt`db.conversations().observeMessages(conversationId).map { list -> list.map { toChatMessage(it) } }`,
  });
  f.fn('delete', {
    of: C, suspend: true,
    doc: 'Delete a conversation and all of its messages.',
    params: [{ name: 'id', type: 'string' }],
    code: kt`db.conversations().delete(id)`,
  });
  f.fn('pinModel', {
    of: C, suspend: true,
    doc: 'Pin a model to a conversation, or unpin with null.',
    params: [{ name: 'id', type: 'string' }, { name: 'choice', type: 'Option<ModelChoice>' }],
    code: kt`
      val entity = db.conversations().find(id) ?: return
      db.conversations().upsert(entity.copy(pinnedProvider = choice?.providerId, pinnedModel = choice?.modelId))
    `,
  });
  f.fn('rename', {
    of: C, suspend: true,
    doc: 'Retitle a conversation.',
    params: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }],
    code: kt`
      val entity = db.conversations().find(id) ?: return
      db.conversations().upsert(entity.copy(title = title))
    `,
  });

  f.fn('toConversation', {
    visibility: 'private',
    doc: 'A row as a Conversation.',
    params: [{ name: 'entity', type: 'ConversationEntity' }],
    returns: 'Conversation',
    code: kt`
      val pinned = if (entity.pinnedProvider != null && entity.pinnedModel != null) ModelChoice(entity.pinnedProvider, entity.pinnedModel) else null
      return Conversation(entity.id, entity.title, entity.createdAt, entity.updatedAt, pinned)
    `,
  });
  f.fn('toEntity', {
    doc: 'A message as a row.',
    params: [{ name: 'message', type: 'ChatMessage' }, { name: 'position', type: 'i64' }],
    returns: 'MessageEntity',
    expression: true,
    code: kt`
      MessageEntity(
          message.id,
          message.conversationId,
          position,
          message.role.name,
          message.text,
          message.createdAt,
          message.status.name,
          DrakenJson.format.encodeToString(ListSerializer(ToolCall.serializer()), message.toolCalls),
          message.toolResult?.let { DrakenJson.format.encodeToString(ToolResultRecord.serializer(), it) },
          message.route?.providerId,
          message.route?.modelId,
          message.route?.local,
          message.error,
          message.replay?.providerId,
          message.replay?.payload,
      )
    `,
  });
  f.fn('toChatMessage', {
    doc: 'A row as a message.',
    params: [{ name: 'entity', type: 'MessageEntity' }],
    returns: 'ChatMessage',
    code: kt`
      val route = if (entity.routeProvider != null && entity.routeModel != null) {
          RouteStamp(entity.routeProvider, entity.routeModel, entity.routeLocal == true)
      } else {
          null
      }
      val replay = if (entity.replayProvider != null && entity.replayPayload != null) ProviderReplay(entity.replayProvider, entity.replayPayload) else null
      return ChatMessage(
          entity.id,
          entity.conversationId,
          MessageRole.valueOf(entity.role),
          entity.text,
          entity.createdAt,
          MessageStatus.valueOf(entity.status),
          DrakenJson.format.decodeFromString(ListSerializer(ToolCall.serializer()), entity.toolCallsJson),
          entity.toolResultJson?.let { DrakenJson.format.decodeFromString(ToolResultRecord.serializer(), it) },
          route,
          entity.error,
          replay,
      )
    `,
  });
}

function stores(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/RoomStores.kt`, { doc: 'notes, modules, grants, audit and usage in Room' });
  f.use('kotlinx.coroutines.flow.map');

  // -- notes -----------------------------------------------------------------
  f.cls('RoomNotesRepository', {
    doc: 'NotesRepository over Room.',
    implements: ['NotesRepository'],
    fields: [
      { name: 'dao', type: 'NoteDao', visibility: 'private' },
      { name: 'clock', type: '() -> i64', visibility: 'private' },
    ],
    ctor: [
      { name: 'dao', type: 'NoteDao' },
      { name: 'clock', type: '() -> i64', default: '{ System.currentTimeMillis() }' },
    ],
  });
  const N = 'RoomNotesRepository';
  f.fn('create', { of: N, override: true, suspend: true, doc: 'Store a new note.', params: [{ name: 'title', type: 'string' }, { name: 'body', type: 'string' }], returns: 'Note', code: kt`
    val now = clock()
    val note = Note(UUID.randomUUID().toString(), title, body, now, now)
    dao.upsert(toEntity(note))
    return note
  ` });
  f.fn('update', { of: N, override: true, suspend: true, doc: 'Replace a note\'s title and body.', params: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }, { name: 'body', type: 'string' }], returns: 'Option<Note>', code: kt`
    val current = dao.find(id) ?: return null
    val note = toNote(current).copy(title = title, body = body, updatedAt = clock())
    dao.upsert(toEntity(note))
    return note
  ` });
  f.fn('find', { of: N, override: true, suspend: true, doc: 'One note.', params: [{ name: 'id', type: 'string' }], returns: 'Option<Note>', expression: true, code: kt`dao.find(id)?.let { toNote(it) }` });
  f.fn('delete', { of: N, override: true, suspend: true, doc: 'Delete a note.', params: [{ name: 'id', type: 'string' }], returns: 'bool', expression: true, code: kt`dao.delete(id) > 0` });
  f.fn('search', {
    of: N, override: true, suspend: true,
    doc: 'Notes containing the text. The query is escaped, so a % or _ the user typed is matched literally.',
    params: [{ name: 'query', type: 'string' }, { name: 'limit', type: 'i64' }],
    returns: 'List<Note>',
    code: kt`
      val escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
      return dao.search("%" + escaped + "%", limit).map { toNote(it) }
    `,
  });
  f.fn('recent', { of: N, override: true, suspend: true, doc: 'The most recently changed notes.', params: [{ name: 'limit', type: 'i64' }], returns: 'List<Note>', expression: true, code: kt`dao.recent(limit).map { toNote(it) }` });
  f.fn('observeRecent', { of: N, doc: 'Recent notes, live.', params: [{ name: 'limit', type: 'i64' }], returns: 'Flow<List<Note>>', expression: true, code: kt`dao.observeRecent(limit).map { list -> list.map { toNote(it) } }` });
  f.fn('observeNote', { of: N, doc: 'One note, live.', params: [{ name: 'id', type: 'string' }], returns: 'Flow<Option<Note>>', expression: true, code: kt`dao.observe(id).map { it?.let { entity -> toNote(entity) } }` });
  f.fn('toNote', { visibility: 'private', doc: 'A row as a note.', params: [{ name: 'entity', type: 'NoteEntity' }], returns: 'Note', expression: true, code: kt`Note(entity.id, entity.title, entity.body, entity.createdAt, entity.updatedAt)` });
  f.fn('toEntity', { of: N, visibility: 'private', doc: 'A note as a row.', params: [{ name: 'note', type: 'Note' }], returns: 'NoteEntity', expression: true, code: kt`NoteEntity(note.id, note.title, note.body, note.createdAt, note.updatedAt)` });

  // -- modules -----------------------------------------------------------------
  f.cls('RoomModuleStore', {
    doc: 'ModuleStore over Room. The manifest is stored as the JSON it was read from.',
    implements: ['ModuleStore'],
    fields: [{ name: 'dao', type: 'ModuleDao', visibility: 'private' }],
    ctor: [{ name: 'dao', type: 'ModuleDao' }],
  });
  const M = 'RoomModuleStore';
  f.fn('all', { of: M, override: true, suspend: true, doc: 'Every installed module.', returns: 'List<InstalledModule>', expression: true, code: kt`dao.all().map { toModule(it) }` });
  f.fn('find', { of: M, override: true, suspend: true, doc: 'One module.', params: [{ name: 'id', type: 'string' }], returns: 'Option<InstalledModule>', expression: true, code: kt`dao.find(id)?.let { toModule(it) }` });
  f.fn('save', { of: M, override: true, suspend: true, doc: 'Insert or replace.', params: [{ name: 'module', type: 'InstalledModule' }], code: kt`
    dao.upsert(
        ModuleEntity(
            module.manifest.id,
            DrakenJson.format.encodeToString(ModuleManifest.serializer(), module.manifest),
            module.enabled,
            module.source.name,
            module.installedAt,
        ),
    )
  ` });
  f.fn('remove', { of: M, override: true, suspend: true, doc: 'Forget a module.', params: [{ name: 'id', type: 'string' }], code: kt`dao.delete(id)` });
  f.fn('observeAll', { of: M, doc: 'Installed modules, live.', returns: 'Flow<List<InstalledModule>>', expression: true, code: kt`dao.observeAll().map { list -> list.map { toModule(it) }.sortedBy { it.manifest.name } }` });
  f.fn('toModule', { of: M, visibility: 'private', doc: 'A row as an installed module.', params: [{ name: 'entity', type: 'ModuleEntity' }], returns: 'InstalledModule', expression: true, code: kt`
    InstalledModule(
        DrakenJson.format.decodeFromString(ModuleManifest.serializer(), entity.manifestJson),
        entity.enabled,
        ModuleSource.valueOf(entity.source),
        entity.installedAt,
    )
  ` });

  // -- grants ------------------------------------------------------------------
  f.cls('RoomGrantStore', {
    doc: 'GrantStore over Room. Every change is audited, as it is the user\'s decision about what a module may do.',
    implements: ['GrantStore'],
    fields: [
      { name: 'dao', type: 'GrantDao', visibility: 'private' },
      { name: 'audit', type: 'AuditLog', visibility: 'private' },
      { name: 'clock', type: '() -> i64', visibility: 'private' },
    ],
    ctor: [
      { name: 'dao', type: 'GrantDao' },
      { name: 'audit', type: 'AuditLog' },
      { name: 'clock', type: '() -> i64', default: '{ System.currentTimeMillis() }' },
    ],
  });
  const G = 'RoomGrantStore';
  f.fn('isGranted', { of: G, override: true, suspend: true, doc: 'Whether the grant exists.', params: [{ name: 'moduleId', type: 'string' }, { name: 'capabilityId', type: 'string' }], returns: 'bool', expression: true, code: kt`dao.exists(moduleId, capabilityId)` });
  f.fn('setGranted', { of: G, override: true, suspend: true, doc: 'Record the user\'s decision, and audit it.', params: [{ name: 'moduleId', type: 'string' }, { name: 'capabilityId', type: 'string' }, { name: 'granted', type: 'bool' }], code: kt`
    if (granted) dao.upsert(GrantEntity(moduleId, capabilityId, clock())) else dao.delete(moduleId, capabilityId)
    audit.record(AuditEvent(clock(), AuditCategory.PERMISSION_CHANGE, moduleId, if (granted) "granted" else "revoked", capabilityId))
  ` });
  f.fn('revokeAll', { of: G, override: true, suspend: true, doc: 'Forget every grant a module held.', params: [{ name: 'moduleId', type: 'string' }], code: kt`
    dao.deleteAll(moduleId)
    audit.record(AuditEvent(clock(), AuditCategory.PERMISSION_CHANGE, moduleId, "revoked_all"))
  ` });
  f.fn('observeGranted', { of: G, doc: 'The capabilities a module holds, live.', params: [{ name: 'moduleId', type: 'string' }], returns: 'Flow<Set<string>>', expression: true, code: kt`dao.observeFor(moduleId).map { list -> list.map { it.capability }.toSet() }` });

  // -- audit -------------------------------------------------------------------
  f.cls('RoomAuditLog', {
    doc: 'AuditLog over Room, keeping the newest events up to a fixed count so the trail cannot grow without bound.',
    implements: ['AuditLog'],
    fields: [
      { name: 'dao', type: 'AuditDao', visibility: 'private' },
      { name: 'keep', type: 'i64', visibility: 'private' },
      { name: 'writes', type: 'java.util.concurrent.atomic.AtomicLong', default: 'java.util.concurrent.atomic.AtomicLong()', visibility: 'private' },
    ],
    ctor: [
      { name: 'dao', type: 'AuditDao' },
      { name: 'keep', type: 'i64', default: '5_000L' },
    ],
  });
  f.fn('record', { of: 'RoomAuditLog', override: true, suspend: true, doc: 'Append an event; every hundred writes, prune to the newest `keep`.', params: [{ name: 'event', type: 'AuditEvent' }], code: kt`
    dao.insert(AuditEntity(0L, event.at, event.category.name, event.subject, event.outcome, event.detail))
    if (writes.incrementAndGet() % 100L == 0L) dao.prune(keep)
  ` });
  f.fn('observeRecent', { of: 'RoomAuditLog', doc: 'The newest events, live.', params: [{ name: 'limit', type: 'i64' }], returns: 'Flow<List<AuditEvent>>', expression: true, code: kt`
    dao.observeRecent(limit).map { list ->
        list.map { AuditEvent(it.at, AuditCategory.valueOf(it.category), it.subject, it.outcome, it.detail) }
    }
  ` });

  // -- usage -------------------------------------------------------------------
  f.cls('UsageMeter', {
    doc: 'Counts cloud tokens per day, for the AUTOMATIC budget. Local inference is never counted.',
    fields: [
      { name: 'dao', type: 'UsageDao', visibility: 'private' },
      { name: 'today', type: '() -> string', visibility: 'private' },
    ],
    ctor: [
      { name: 'dao', type: 'UsageDao' },
      { name: 'today', type: '() -> string', default: '{ LocalDate.now().toString() }' },
    ],
  });
  f.fn('record', { of: 'UsageMeter', suspend: true, doc: 'Add tokens a cloud request used. Turns run one at a time, so read-then-write cannot lose an update.', params: [{ name: 'providerId', type: 'string' }, { name: 'tokens', type: 'i64' }], code: kt`
    val day = today()
    val current = dao.find(day, providerId)?.tokens ?: 0L
    dao.upsert(UsageEntity(day, providerId, current + tokens))
  ` });
  f.fn('tokensToday', { of: 'UsageMeter', suspend: true, doc: 'Cloud tokens used today.', returns: 'i64', expression: true, code: kt`dao.tokensOn(today()) ?: 0L` });
  f.fn('observeToday', { of: 'UsageMeter', doc: 'Today\'s usage per provider, live.', returns: 'Flow<Map<string, i64>>', expression: true, code: kt`dao.observeOn(today()).map { list -> list.associate { it.providerId to it.tokens } }` });
  f.use('java.time.LocalDate');
}
