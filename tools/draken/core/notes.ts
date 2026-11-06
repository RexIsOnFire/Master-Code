/**
 * The Notes module: the first module built on the platform, and built only
 * from what a community module would use - a manifest, tools over trusted
 * handlers, and capabilities the broker checks on every call.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core/notes';

export function buildNotes(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/Notes.kt`, { doc: 'notes and their repository contract' });

  f.record(
    'Note',
    [
      { name: 'id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'body', type: 'string' },
      { name: 'createdAt', type: 'i64' },
      { name: 'updatedAt', type: 'i64' },
    ],
    { doc: 'One note.' },
  );

  f.iface(
    'NotesRepository',
    [
      { name: 'create', suspend: true, params: [{ name: 'title', type: 'string' }, { name: 'body', type: 'string' }], returns: 'Note', doc: 'Store a new note.' },
      {
        name: 'update',
        suspend: true,
        params: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }, { name: 'body', type: 'string' }],
        returns: 'Option<Note>',
        doc: 'Replace a note\'s title and body; null when there is no such note.',
      },
      { name: 'find', suspend: true, params: [{ name: 'id', type: 'string' }], returns: 'Option<Note>', doc: 'One note.' },
      { name: 'delete', suspend: true, params: [{ name: 'id', type: 'string' }], returns: 'bool', doc: 'Delete a note; false when there was none.' },
      {
        name: 'search',
        suspend: true,
        params: [{ name: 'query', type: 'string' }, { name: 'limit', type: 'i64' }],
        returns: 'List<Note>',
        doc: 'Notes whose title or body contains the text, most recently changed first.',
      },
      { name: 'recent', suspend: true, params: [{ name: 'limit', type: 'i64' }], returns: 'List<Note>', doc: 'The most recently changed notes.' },
    ],
    { doc: 'Where notes live. Room on Android; an in-memory map in tests.' },
  );

  f.decl(
    kt`
      const val NOTES_MODULE_ID = "draken.notes"
      const val MAX_NOTE_TITLE = 120
      const val MAX_NOTE_BODY = 20_000
    `,
    { doc: 'The module id and note limits.', provides: ['NOTES_MODULE_ID', 'MAX_NOTE_TITLE', 'MAX_NOTE_BODY'] },
  );

  f.fn('validateNote', {
    doc: 'Everything wrong with a note\'s content: limits on both fields, and at least one of them written. The same rules apply to the editor and to a model\'s tool call.',
    params: [
      { name: 'title', type: 'string' },
      { name: 'body', type: 'string' },
    ],
    returns: 'List<string>',
    code: kt`
      val problems = mutableListOf<String>()
      if (title.isBlank() && body.isBlank()) problems.add("a note needs a title or some text")
      if (title.length > MAX_NOTE_TITLE) problems.add("the title is longer than " + MAX_NOTE_TITLE + " characters")
      if (body.length > MAX_NOTE_BODY) problems.add("the text is longer than " + MAX_NOTE_BODY + " characters")
      if (title.contains('\n')) problems.add("the title must be one line")
      return problems
    `,
  });

  const t = new KtFile(ctx, `${ROOT}/NotesModule.kt`, { doc: 'the Notes module manifest and handlers' });
  t.use('kotlinx.serialization.json.put', 'kotlinx.serialization.json.add');

  t.fn('notesManifest', {
    doc: 'The Notes module\'s manifest. Reading is a READ tool; changing or deleting a note the user wrote asks first.',
    returns: 'ModuleManifest',
    code: kt`
      fun schema(build: JsonObjectBuilder.() -> Unit, vararg required: String) = buildJsonObject {
          put("type", "object")
          putJsonObject("properties", build)
          putJsonArray("required") { required.forEach { add(it) } }
          put("additionalProperties", false)
      }
      fun JsonObjectBuilder.text(name: String, description: String, max: Int) = putJsonObject(name) {
          put("type", "string")
          put("description", description)
          put("maxLength", max)
      }
      val id = { builder: JsonObjectBuilder -> builder.text("id", "The note's id, from a search or an earlier result.", 64) }

      return ModuleManifest(
          MANIFEST_SCHEMA_VERSION,
          NOTES_MODULE_ID,
          "Notes",
          "1.0.0",
          "Create, find, edit and delete notes stored on this device.",
          "Draken",
          1L,
          listOf(
              CapabilityRequest("notes.read", "To find and read your notes when you ask about them."),
              CapabilityRequest("notes.write", "To save, edit and delete notes when you ask it to."),
          ),
          listOf(
              ToolDeclaration(
                  "draken.notes.create", "Create note", "Save a new note on the user's device.",
                  schema({
                      text("title", "A short title, one line.", MAX_NOTE_TITLE)
                      text("body", "The note's text.", MAX_NOTE_BODY)
                  }, "title"),
                  "notes.write", RiskLevel.WRITE, false, "notes.create",
              ),
              ToolDeclaration(
                  "draken.notes.search", "Search notes", "Find notes whose title or text contains the query. Returns ids, titles and the start of each note.",
                  schema({
                      text("query", "Text to look for.", 200)
                      putJsonObject("limit") {
                          put("type", "integer")
                          put("minimum", 1)
                          put("maximum", 20)
                      }
                  }, "query"),
                  "notes.read", RiskLevel.READ, false, "notes.search",
              ),
              ToolDeclaration(
                  "draken.notes.get", "Read note", "Read one whole note by id.",
                  schema({ id(this) }, "id"),
                  "notes.read", RiskLevel.READ, false, "notes.get",
              ),
              ToolDeclaration(
                  "draken.notes.update", "Edit note", "Replace a note's title and/or text. The user is asked to confirm.",
                  schema({
                      id(this)
                      text("title", "The new title.", MAX_NOTE_TITLE)
                      text("body", "The new text.", MAX_NOTE_BODY)
                  }, "id"),
                  "notes.write", RiskLevel.WRITE, true, "notes.update",
              ),
              ToolDeclaration(
                  "draken.notes.delete", "Delete note", "Delete a note. The user is asked to confirm.",
                  schema({ id(this) }, "id"),
                  "notes.write", RiskLevel.DESTRUCTIVE, true, "notes.delete",
              ),
          ),
      )
    `,
  });

  t.fn('addNotesHandlers', {
    doc: 'Register the trusted Notes handlers. None is available to packages: another module reaching the user\'s notes would need its own reviewed handler.',
    params: [
      { name: 'catalog', type: 'HandlerCatalog' },
      { name: 'notes', type: 'NotesRepository' },
    ],
    code: kt`
      catalog.add("notes.create", noteHandler { args ->
          val title = args.text("title")
          val body = args.text("body")
          val problems = validateNote(title, body)
          if (problems.isNotEmpty()) return@noteHandler ToolOutcome.Failure(ToolFailureCode.INVALID_ARGUMENTS, problems.joinToString("; "))
          val note = notes.create(title.trim(), body)
          ToolOutcome.Success(noteJson(note, full = false), "Saved note \"" + note.title + "\"")
      })
      catalog.add("notes.search", noteHandler { args ->
          val limit = args.number("limit") ?: 10L
          val found = notes.search(args.text("query").trim(), limit)
          ToolOutcome.Success(JsonArray(found.map { noteJson(it, full = false) }), "Found " + found.size + " note" + (if (found.size == 1) "" else "s"))
      })
      catalog.add("notes.get", noteHandler { args ->
          val note = notes.find(args.text("id")) ?: return@noteHandler missingNote()
          ToolOutcome.Success(noteJson(note, full = true), "Read note \"" + note.title + "\"")
      })
      catalog.add("notes.update", noteHandler { args ->
          val current = notes.find(args.text("id")) ?: return@noteHandler missingNote()
          val title = if ("title" in args) args.text("title") else current.title
          val body = if ("body" in args) args.text("body") else current.body
          val problems = validateNote(title, body)
          if (problems.isNotEmpty()) return@noteHandler ToolOutcome.Failure(ToolFailureCode.INVALID_ARGUMENTS, problems.joinToString("; "))
          val note = notes.update(current.id, title.trim(), body) ?: return@noteHandler missingNote()
          ToolOutcome.Success(noteJson(note, full = false), "Updated note \"" + note.title + "\"")
      })
      catalog.add("notes.delete", noteHandler { args ->
          val note = notes.find(args.text("id")) ?: return@noteHandler missingNote()
          if (!notes.delete(note.id)) return@noteHandler missingNote()
          ToolOutcome.Success(buildJsonObject { put("deleted", note.id) }, "Deleted note \"" + note.title + "\"")
      })
    `,
  });

  t.decl(
    kt`
      /** A ToolHandler from a lambda, labelled so a failed return can name it. */
      private inline fun noteHandler(crossinline run: suspend (JsonObject) -> ToolOutcome): ToolHandler =
          object : ToolHandler {
              override suspend fun execute(arguments: JsonObject): ToolOutcome = run(arguments)
          }

      private fun JsonObject.text(name: String): String = (this[name] as? JsonPrimitive)?.contentOrNull.orEmpty()

      private fun JsonObject.number(name: String): Long? = (this[name] as? JsonPrimitive)?.longOrNull

      private fun missingNote() = ToolOutcome.Failure(ToolFailureCode.NOT_FOUND, "There is no note with that id.")

      /** A note as a tool result. Search results carry the start of the text, not all of it. */
      private fun noteJson(note: Note, full: Boolean) = buildJsonObject {
          put("id", note.id)
          put("title", note.title)
          put(if (full) "body" else "preview", if (full) note.body else note.body.take(200))
          put("updatedAt", Instant.ofEpochMilli(note.updatedAt).toString())
      }
    `,
    { doc: 'Small helpers for the handlers.' },
  );
}
