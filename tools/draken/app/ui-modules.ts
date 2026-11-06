/**
 * Modules and their permissions, the Notes module's own screens, and the
 * activity log.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const UI = 'app/src/main/kotlin/com/draken/app/ui';

export function buildModuleScreens(ctx: Ctx): void {
  modulesViewModel(ctx);
  modulesScreens(ctx);
  notes(ctx);
  audit(ctx);
}

function modulesViewModel(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/modules/ModulesViewModel.kt`, { doc: 'module state' });

  f.cls('ModulesViewModel', {
    doc: 'Installed modules, their switches and their grants. Every change goes through the module manager or the grant store, which audit it.',
    extends: 'ViewModel',
    fields: [
      { name: 'container', type: 'AppContainer', visibility: 'private' },
      { name: 'notices', type: 'MutableStateFlow<Option<string>>', default: 'MutableStateFlow(null)', visibility: 'private' },
      { name: 'modules', type: 'StateFlow<Option<List<InstalledModule>>>', default: 'container.moduleStore.observeAll().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)', doc: 'Installed modules, by name; null until read.' },
      { name: 'notice', type: 'StateFlow<Option<string>>', default: 'notices.asStateFlow()', doc: 'A message for the snackbar.' },
    ],
    ctor: [{ name: 'container', type: 'AppContainer' }],
  });
  const V = 'ModulesViewModel';
  f.fn('granted', { of: V, doc: 'The capabilities a module holds, live.', params: [{ name: 'moduleId', type: 'string' }], returns: 'Flow<Set<string>>', expression: true, code: kt`container.grants.observeGranted(moduleId)` });
  f.fn('platformGranted', { of: V, doc: 'Whether Android currently grants a runtime permission.', params: [{ name: 'permission', type: 'string' }], returns: 'bool', expression: true, code: kt`container.platform.isGranted(permission)` });
  f.fn('setEnabled', { of: V, doc: 'Turn a module on or off.', params: [{ name: 'id', type: 'string' }, { name: 'enabled', type: 'bool' }], code: kt`
    viewModelScope.launch {
        if (!container.modules.setEnabled(id, enabled)) notices.value = "This module no longer passes validation, so it stays off."
    }
  ` });
  f.fn('setGranted', { of: V, doc: 'Grant or revoke one capability.', params: [{ name: 'moduleId', type: 'string' }, { name: 'capabilityId', type: 'string' }, { name: 'granted', type: 'bool' }], code: kt`
    viewModelScope.launch { container.grants.setGranted(moduleId, capabilityId, granted) }
  ` });
  f.fn('uninstall', { of: V, doc: 'Remove a package module; built-in modules refuse, with the reason.', params: [{ name: 'id', type: 'string' }, { name: 'onRemoved', type: '() -> Void' }], code: kt`
    viewModelScope.launch {
        when (val change = container.modules.uninstall(id)) {
            is ModuleChange.Done -> onRemoved()
            is ModuleChange.Rejected -> notices.value = change.problems.joinToString("; ") { it.message }
        }
    }
  ` });
  f.fn('noticeShown', { of: V, doc: 'The snackbar has shown the notice.', code: kt`notices.value = null` });
}

function modulesScreens(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/modules/ModulesScreens.kt`, { doc: 'modules and their permissions' });
  f.use('androidx.compose.foundation.layout.padding', 'androidx.compose.foundation.lazy.items');

  f.fn('ModulesScreen', {
    annotations: ['Composable'],
    doc: 'Installed modules, each with its switch.',
    params: [
      { name: 'vm', type: 'ModulesViewModel' },
      { name: 'onBack', type: '() -> Void' },
      { name: 'onOpen', type: '(string) -> Void' },
    ],
    code: kt`
      val modules by vm.modules.collectAsStateWithLifecycle()
      Scaffold(topBar = { DrakenTopBar("Modules", onBack = onBack) }) { padding ->
          val list = modules
          when {
              list == null -> Loading(Modifier.padding(padding))
              list.isEmpty() -> EmptyState("No modules", "Modules give Draken abilities, such as keeping notes.", Modifier.padding(padding))
              else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
                  item {
                      Text(
                          "A module can only do what you grant it, checked every time it acts. Turning one off removes its tools from every model.",
                          style = MaterialTheme.typography.bodyMedium,
                          modifier = Modifier.padding(16.dp),
                      )
                  }
                  items(list, key = { it.manifest.id }) { module ->
                      ListItem(
                          headlineContent = { Text(module.manifest.name) },
                          supportingContent = {
                              Text(
                                  module.manifest.description,
                                  maxLines = 2,
                                  overflow = TextOverflow.Ellipsis,
                              )
                          },
                          trailingContent = {
                              Switch(checked = module.enabled, onCheckedChange = { vm.setEnabled(module.manifest.id, it) })
                          },
                          modifier = Modifier.clickable { onOpen(module.manifest.id) },
                      )
                  }
              }
          }
      }
    `,
  });

  f.fn('ModuleDetailScreen', {
    annotations: ['Composable'],
    doc: 'One module: what it is, what it may access - each grant a switch - and what its tools do.',
    params: [
      { name: 'vm', type: 'ModulesViewModel' },
      { name: 'moduleId', type: 'string' },
      { name: 'onBack', type: '() -> Void' },
    ],
    code: kt`
      val modules by vm.modules.collectAsStateWithLifecycle()
      val granted by remember(moduleId) { vm.granted(moduleId) }.collectAsStateWithLifecycle(emptySet())
      val notice by vm.notice.collectAsStateWithLifecycle()
      val snackbar = remember { SnackbarHostState() }
      var removing by remember { mutableStateOf(false) }
      LaunchedEffect(notice) {
          notice?.let {
              snackbar.showSnackbar(it)
              vm.noticeShown()
          }
      }
      val module = modules?.firstOrNull { it.manifest.id == moduleId }
      Scaffold(topBar = { DrakenTopBar(module?.manifest?.name.orEmpty(), onBack = onBack) }, snackbarHost = { SnackbarHost(snackbar) }) { padding ->
          when {
              modules == null -> Loading(Modifier.padding(padding))
              module == null -> EmptyState("Not installed", "This module is no longer installed.", Modifier.padding(padding))
              else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
                  val manifest = module.manifest
                  item {
                      Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                          Text(manifest.description, style = MaterialTheme.typography.bodyLarge)
                          Text(
                              "Version " + manifest.version + " · " + manifest.publisher + " · " + (if (module.source == ModuleSource.BUILT_IN) "built in" else "installed package"),
                              style = MaterialTheme.typography.bodySmall,
                              color = MaterialTheme.colorScheme.onSurfaceVariant,
                          )
                      }
                  }
                  item {
                      ListItem(
                          headlineContent = { Text("Enabled") },
                          supportingContent = { Text("Off, its tools are offered to no model and cannot run.") },
                          trailingContent = { Switch(checked = module.enabled, onCheckedChange = { vm.setEnabled(manifest.id, it) }) },
                      )
                  }
                  item { SectionHeader("Permissions") }
                  if (manifest.capabilities.isEmpty()) {
                      item { Text("This module asks for no access.", Modifier.padding(horizontal = 16.dp)) }
                  }
                  items(manifest.capabilities, key = { it.id }) { request ->
                      val definition = capabilityById(request.id)
                      ListItem(
                          headlineContent = { Text(definition?.title ?: request.id) },
                          supportingContent = {
                              Column {
                                  Text(definition?.description.orEmpty())
                                  Text("Why: " + request.reason, style = MaterialTheme.typography.bodySmall)
                                  val needs = definition?.androidPermissions.orEmpty().filterNot { vm.platformGranted(it) }
                                  if (needs.isNotEmpty()) {
                                      Text(
                                          "Android has not granted: " + needs.joinToString(", ") { it.substringAfterLast('.') },
                                          style = MaterialTheme.typography.bodySmall,
                                          color = MaterialTheme.colorScheme.error,
                                      )
                                  }
                              }
                          },
                          trailingContent = {
                              Switch(checked = request.id in granted, onCheckedChange = { vm.setGranted(manifest.id, request.id, it) })
                          },
                      )
                  }
                  item { SectionHeader("Tools") }
                  items(manifest.tools, key = { it.id }) { tool ->
                      ListItem(
                          headlineContent = { Text(tool.title) },
                          supportingContent = {
                              Column {
                                  Text(tool.description)
                                  Text(
                                      riskLabel(tool.risk) + (if (tool.requiresConfirmation) " · asks you first" else ""),
                                      style = MaterialTheme.typography.labelMedium,
                                      color = MaterialTheme.colorScheme.primary,
                                  )
                              }
                          },
                      )
                  }
                  item {
                      if (module.source == ModuleSource.BUILT_IN) {
                          Text(
                              "Built into Draken: it can be turned off, not removed.",
                              style = MaterialTheme.typography.bodySmall,
                              color = MaterialTheme.colorScheme.onSurfaceVariant,
                              modifier = Modifier.padding(16.dp),
                          )
                      } else {
                          OutlinedButton(onClick = { removing = true }, modifier = Modifier.padding(16.dp)) { Text("Remove module") }
                      }
                  }
              }
          }
      }
      if (removing && module != null) {
          AlertDialog(
              onDismissRequest = { removing = false },
              title = { Text("Remove " + module.manifest.name + "?") },
              text = { Text("Its tools and every permission you granted it are removed.") },
              confirmButton = {
                  TextButton(onClick = {
                      removing = false
                      vm.uninstall(module.manifest.id, onBack)
                  }) { Text("Remove") }
              },
              dismissButton = { TextButton(onClick = { removing = false }) { Text("Cancel") } },
          )
      }
    `,
  });
}

function notes(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/notes/Notes.kt`, { doc: 'the Notes module\'s screens' });
  f.use(
    'androidx.compose.foundation.layout.padding',
    'androidx.compose.foundation.lazy.items',
    'androidx.compose.material.icons.filled.Delete',
    'androidx.compose.material.icons.filled.Done',
    'androidx.compose.material.icons.filled.Search',
    'kotlinx.coroutines.flow.map',
  );

  f.decl(
    kt`
      /** The id the editor is opened with for a note not yet saved. */
      const val NEW_NOTE_ID = "new"
    `,
    { doc: 'New-note id.', provides: ['NEW_NOTE_ID'] },
  );

  f.cls('NotesViewModel', {
    doc: 'Notes, newest first, narrowed by a search. The search reruns whenever a note changes, so results never go stale.',
    extends: 'ViewModel',
    fields: [
      { name: 'notes', type: 'RoomNotesRepository', visibility: 'private' },
      { name: 'queries', type: 'MutableStateFlow<string>', default: 'MutableStateFlow("")', visibility: 'private' },
      { name: 'query', type: 'StateFlow<string>', default: 'queries.asStateFlow()', doc: 'The search text.' },
      {
        name: 'results',
        type: 'StateFlow<Option<List<Note>>>',
        default: 'combine(queries, notes.observeRecent(500L)) { q, recent -> if (q.isBlank()) recent else notes.search(q.trim(), 200L) }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)',
        doc: 'Matching notes; null until read.',
      },
    ],
    ctor: [{ name: 'notes', type: 'RoomNotesRepository' }],
  });
  f.fn('search', { of: 'NotesViewModel', doc: 'Change the search text.', params: [{ name: 'text', type: 'string' }], code: kt`queries.value = text` });

  f.enm(
    'EditorLoad',
    [
      'Loading',
      'Missing',
      { name: 'Ready', payload: [{ name: 'note', type: 'Option<Note>' }] },
    ],
    { doc: 'What the editor has to show: nothing yet, a note that is gone, or a note - null for a new one.' },
  );

  f.cls('NoteEditorViewModel', {
    doc: 'One note being written or edited. A new note is created on its first save, and updated after.',
    extends: 'ViewModel',
    fields: [
      { name: 'notes', type: 'RoomNotesRepository', visibility: 'private' },
      { name: 'noteId', type: 'string', visibility: 'private' },
      { name: 'savedId', type: 'Option<string>', default: 'noteId.takeIf { it != NEW_NOTE_ID }', readonly: false, visibility: 'private' },
      { name: 'problems', type: 'MutableStateFlow<Option<string>>', default: 'MutableStateFlow(null)', visibility: 'private' },
      {
        name: 'load',
        type: 'StateFlow<EditorLoad>',
        default: '(if (noteId == NEW_NOTE_ID) flowOf(EditorLoad.Ready(null)) else notes.observeNote(noteId).map { it?.let { note -> EditorLoad.Ready(note) } ?: EditorLoad.Missing }).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), EditorLoad.Loading)',
        doc: 'The note to edit.',
      },
      { name: 'problem', type: 'StateFlow<Option<string>>', default: 'problems.asStateFlow()', doc: 'Why the last save was refused.' },
    ],
    ctor: [
      { name: 'notes', type: 'RoomNotesRepository' },
      { name: 'noteId', type: 'string' },
    ],
  });
  const E = 'NoteEditorViewModel';
  f.fn('save', { of: E, doc: 'Validate and store, then report back; a refused save explains itself.', params: [{ name: 'title', type: 'string' }, { name: 'body', type: 'string' }, { name: 'onSaved', type: '() -> Void' }], code: kt`
    val issues = validateNote(title, body)
    if (issues.isNotEmpty()) {
        problems.value = issues.joinToString("; ")
        return
    }
    viewModelScope.launch {
        val id = savedId
        val saved = if (id == null) notes.create(title.trim(), body) else notes.update(id, title.trim(), body)
        if (saved == null) {
            problems.value = "This note was deleted elsewhere."
        } else {
            savedId = saved.id
            onSaved()
        }
    }
  ` });
  f.fn('delete', { of: E, doc: 'Delete the note.', params: [{ name: 'onDeleted', type: '() -> Void' }], code: kt`
    val id = savedId ?: return onDeleted()
    viewModelScope.launch {
        notes.delete(id)
        onDeleted()
    }
  ` });
  f.fn('problemShown', { of: E, doc: 'The snackbar has shown the problem.', code: kt`problems.value = null` });

  f.fn('NotesScreen', {
    annotations: ['Composable'],
    doc: 'Every note, with search.',
    params: [
      { name: 'vm', type: 'NotesViewModel' },
      { name: 'onBack', type: '() -> Void' },
      { name: 'onOpen', type: '(string) -> Void' },
    ],
    code: kt`
      val query by vm.query.collectAsStateWithLifecycle()
      val results by vm.results.collectAsStateWithLifecycle()
      Scaffold(
          topBar = { DrakenTopBar("Notes", onBack = onBack) },
          floatingActionButton = {
              AddButton("New note") { onOpen(NEW_NOTE_ID) }
          },
      ) { padding ->
          Column(Modifier.fillMaxSize().padding(padding)) {
              OutlinedTextField(
                  query,
                  vm::search,
                  Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                  placeholder = { Text("Search notes") },
                  leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                  singleLine = true,
              )
              val list = results
              when {
                  list == null -> Loading()
                  list.isEmpty() && query.isBlank() -> EmptyState("No notes yet", "Write one here, or ask Draken to take a note in a conversation.")
                  list.isEmpty() -> EmptyState("Nothing found", "No note contains \"" + query.trim() + "\".")
                  else -> LazyColumn(Modifier.fillMaxSize()) {
                      items(list, key = { it.id }) { note ->
                          ListItem(
                              headlineContent = { Text(note.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                              supportingContent = { Text(note.body.lineSequence().firstOrNull().orEmpty(), maxLines = 2, overflow = TextOverflow.Ellipsis) },
                              trailingContent = { Text(formatWhen(note.updatedAt), style = MaterialTheme.typography.labelSmall) },
                              modifier = Modifier.clickable { onOpen(note.id) },
                          )
                      }
                  }
              }
          }
      }
    `,
  });

  f.fn('NoteEditorScreen', {
    annotations: ['Composable'],
    doc: 'Write or edit one note.',
    params: [
      { name: 'vm', type: 'NoteEditorViewModel' },
      { name: 'onBack', type: '() -> Void' },
    ],
    code: kt`
      val load by vm.load.collectAsStateWithLifecycle()
      when (val current = load) {
          EditorLoad.Loading -> Scaffold(topBar = { DrakenTopBar("Note", onBack = onBack) }) { Loading(Modifier.padding(it)) }
          EditorLoad.Missing -> Scaffold(topBar = { DrakenTopBar("Note", onBack = onBack) }) {
              EmptyState("This note no longer exists", "It was deleted.", Modifier.padding(it))
          }
          is EditorLoad.Ready -> NoteEditor(vm, current.note, onBack)
      }
    `,
  });

  f.fn('NoteEditor', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'The editor itself, once there is something to edit.',
    params: [
      { name: 'vm', type: 'NoteEditorViewModel' },
      { name: 'note', type: 'Option<Note>' },
      { name: 'onBack', type: '() -> Void' },
    ],
    code: kt`
      var title by rememberSaveable { mutableStateOf(note?.title.orEmpty()) }
      var body by rememberSaveable { mutableStateOf(note?.body.orEmpty()) }
      var deleting by remember { mutableStateOf(false) }
      val problem by vm.problem.collectAsStateWithLifecycle()
      val snackbar = remember { SnackbarHostState() }
      LaunchedEffect(problem) {
          problem?.let {
              snackbar.showSnackbar(it)
              vm.problemShown()
          }
      }
      Scaffold(
          topBar = {
              DrakenTopBar(if (note == null) "New note" else "Note", onBack = onBack) {
                  if (note != null) IconButton(onClick = { deleting = true }) { Icon(Icons.Filled.Delete, contentDescription = "Delete note") }
                  IconButton(onClick = { vm.save(title, body, onBack) }) { Icon(Icons.Filled.Done, contentDescription = "Save note") }
              }
          },
          snackbarHost = { SnackbarHost(snackbar) },
      ) { padding ->
          Column(Modifier.fillMaxSize().padding(padding).imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
              OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), label = { Text("Title") }, singleLine = true)
              OutlinedTextField(
                  body,
                  { body = it },
                  Modifier.fillMaxWidth().weight(1f),
                  label = { Text("Note") },
                  supportingText = { Text(String.format(Locale.getDefault(), "%,d / %,d", body.length, MAX_NOTE_BODY)) },
                  isError = body.length > MAX_NOTE_BODY,
              )
          }
      }
      if (deleting) {
          AlertDialog(
              onDismissRequest = { deleting = false },
              title = { Text("Delete this note?") },
              text = { Text("It is removed from this device.") },
              confirmButton = {
                  TextButton(onClick = {
                      deleting = false
                      vm.delete(onBack)
                  }) { Text("Delete") }
              },
              dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } },
          )
      }
    `,
  });
}

function audit(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/audit/AuditScreen.kt`, { doc: 'the activity log' });
  f.use('androidx.compose.foundation.layout.padding', 'androidx.compose.foundation.lazy.items');

  f.fn('AuditScreen', {
    annotations: ['Composable'],
    doc: 'Security-relevant events, newest first. They record what happened, never content.',
    params: [
      { name: 'audit', type: 'RoomAuditLog' },
      { name: 'onBack', type: '() -> Void' },
    ],
    code: kt`
      val events by remember(audit) { audit.observeRecent(500L) }.collectAsStateWithLifecycle(null)
      Scaffold(topBar = { DrakenTopBar("Activity log", onBack = onBack) }) { padding ->
          val list = events
          when {
              list == null -> Loading(Modifier.padding(padding))
              list.isEmpty() -> EmptyState("Nothing yet", "Tool use, permission changes, key changes and cloud requests appear here.", Modifier.padding(padding))
              else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
                  items(list) { event ->
                      ListItem(
                          overlineContent = { Text(categoryLabel(event.category) + " · " + formatWhen(event.at)) },
                          headlineContent = { Text(event.subject + ": " + event.outcome) },
                          supportingContent = if (event.detail.isEmpty()) null else ({ Text(event.detail) }),
                      )
                  }
              }
          }
      }
    `,
  });

  f.fn('categoryLabel', {
    visibility: 'private',
    doc: 'An audit category in words.',
    params: [{ name: 'category', type: 'AuditCategory' }],
    returns: 'string',
    expression: true,
    code: kt`
      when (category) {
          AuditCategory.TOOL_CALL -> "Tool"
          AuditCategory.PERMISSION_CHANGE -> "Permission"
          AuditCategory.MODULE_LIFECYCLE -> "Module"
          AuditCategory.CLOUD_REQUEST -> "Cloud request"
          AuditCategory.CREDENTIAL_CHANGE -> "Key"
      }
    `,
  });
}
