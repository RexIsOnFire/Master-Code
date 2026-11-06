/**
 * Conversation history and the conversation screen.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const UI = 'app/src/main/kotlin/com/draken/app/ui';

export function buildChat(ctx: Ctx): void {
  history(ctx);
  chatViewModel(ctx);
  chatScreen(ctx);
}

function history(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/history/History.kt`, { doc: 'conversation history' });
  f.use(
    'androidx.compose.foundation.lazy.items',
    'androidx.compose.foundation.layout.padding',
    'androidx.compose.material.icons.filled.Edit',
    'androidx.compose.material.icons.filled.MoreVert',
    'androidx.compose.material.icons.filled.Settings',
  );

  f.decl(
    kt`
      /** The title a conversation has until its first message names it. */
      const val NEW_CONVERSATION_TITLE = "New conversation"

      private const val MAX_TITLE = 60
    `,
    { doc: 'Titles.', provides: ['NEW_CONVERSATION_TITLE'] },
  );

  f.fn('titleFrom', {
    doc: 'A conversation title from its first message: the first line, cut at a word.',
    params: [{ name: 'message', type: 'string' }],
    returns: 'string',
    code: kt`
      val line = message.trim().lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
      if (line.length <= MAX_TITLE) return line.ifEmpty { NEW_CONVERSATION_TITLE }
      val cut = line.take(MAX_TITLE)
      val space = cut.lastIndexOf(' ')
      return (if (space > MAX_TITLE / 2) cut.take(space) else cut).trimEnd() + "…"
    `,
  });

  f.cls('HistoryViewModel', {
    doc: 'Every conversation, newest first.',
    extends: 'ViewModel',
    fields: [
      { name: 'store', type: 'RoomConversationStore', visibility: 'private' },
      {
        name: 'conversations',
        type: 'StateFlow<Option<List<Conversation>>>',
        default: 'store.observeConversations().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)',
        doc: 'Null until the database answers.',
      },
    ],
    ctor: [{ name: 'store', type: 'RoomConversationStore' }],
  });
  f.fn('create', { of: 'HistoryViewModel', doc: 'Start a conversation and hand back its id.', params: [{ name: 'onCreated', type: '(string) -> Void' }], code: kt`
    viewModelScope.launch { onCreated(store.createConversation(NEW_CONVERSATION_TITLE).id) }
  ` });
  f.fn('rename', { of: 'HistoryViewModel', doc: 'Retitle a conversation; a blank title is ignored.', params: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }], code: kt`
    val clean = title.trim()
    if (clean.isEmpty()) return
    viewModelScope.launch { store.rename(id, clean.take(MAX_TITLE)) }
  ` });
  f.fn('delete', { of: 'HistoryViewModel', doc: 'Delete a conversation and its messages.', params: [{ name: 'id', type: 'string' }], code: kt`
    viewModelScope.launch { store.delete(id) }
  ` });

  f.fn('HistoryScreen', {
    annotations: ['Composable'],
    doc: 'The home screen: conversations, with a way to start one.',
    params: [
      { name: 'vm', type: 'HistoryViewModel' },
      { name: 'onOpen', type: '(string) -> Void' },
      { name: 'onNotes', type: '() -> Void' },
      { name: 'onSettings', type: '() -> Void' },
    ],
    code: kt`
      val conversations by vm.conversations.collectAsStateWithLifecycle()
      var renaming by remember { mutableStateOf<Conversation?>(null) }
      var deleting by remember { mutableStateOf<Conversation?>(null) }
      Scaffold(
          topBar = {
              DrakenTopBar("Draken") {
                  IconButton(onClick = onNotes) { Icon(Icons.Filled.Edit, contentDescription = "Notes") }
                  IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, contentDescription = "Settings") }
              }
          },
          floatingActionButton = {
              AddButton("New chat") { vm.create(onOpen) }
          },
      ) { padding ->
          val list = conversations
          when {
              list == null -> Loading(Modifier.padding(padding))
              list.isEmpty() -> EmptyState(
                  "No conversations yet",
                  "Start one with New chat. Conversations are stored only on this device.",
                  Modifier.padding(padding),
              )
              else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
                  items(list, key = { it.id }) { conversation ->
                      ConversationRow(
                          conversation,
                          onOpen = { onOpen(conversation.id) },
                          onRename = { renaming = conversation },
                          onDelete = { deleting = conversation },
                      )
                  }
              }
          }
      }
      renaming?.let { conversation ->
          RenameDialog(conversation.title, onDismiss = { renaming = null }, onRename = {
              vm.rename(conversation.id, it)
              renaming = null
          })
      }
      deleting?.let { conversation ->
          AlertDialog(
              onDismissRequest = { deleting = null },
              title = { Text("Delete this conversation?") },
              text = { Text("\"" + conversation.title + "\" and all of its messages will be removed from this device.") },
              confirmButton = {
                  TextButton(onClick = {
                      vm.delete(conversation.id)
                      deleting = null
                  }) { Text("Delete") }
              },
              dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
          )
      }
    `,
  });

  f.fn('ConversationRow', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'One conversation, with rename and delete behind a menu.',
    params: [
      { name: 'conversation', type: 'Conversation' },
      { name: 'onOpen', type: '() -> Void' },
      { name: 'onRename', type: '() -> Void' },
      { name: 'onDelete', type: '() -> Void' },
    ],
    code: kt`
      var menu by remember { mutableStateOf(false) }
      ListItem(
          headlineContent = { Text(conversation.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
          supportingContent = { Text(formatWhen(conversation.updatedAt)) },
          trailingContent = {
              Box {
                  IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More for " + conversation.title) }
                  DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                      DropdownMenuItem(text = { Text("Rename") }, onClick = {
                          menu = false
                          onRename()
                      })
                      DropdownMenuItem(text = { Text("Delete") }, onClick = {
                          menu = false
                          onDelete()
                      })
                  }
              }
          },
          modifier = Modifier.clickable(onClick = onOpen),
      )
    `,
  });

  f.fn('RenameDialog', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'Edit a title.',
    params: [
      { name: 'initial', type: 'string' },
      { name: 'onDismiss', type: '() -> Void' },
      { name: 'onRename', type: '(string) -> Void' },
    ],
    code: kt`
      var text by remember { mutableStateOf(initial) }
      AlertDialog(
          onDismissRequest = onDismiss,
          title = { Text("Rename") },
          text = { OutlinedTextField(text, { text = it }, singleLine = true, label = { Text("Title") }) },
          confirmButton = { TextButton(onClick = { onRename(text) }, enabled = text.isNotBlank()) { Text("Save") } },
          dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
      )
    `,
  });
}

function chatViewModel(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/chat/ChatViewModel.kt`, { doc: 'one conversation\'s state' });
  f.use('kotlinx.coroutines.flow.map', 'kotlinx.coroutines.flow.update', 'kotlinx.coroutines.flow.collect');

  f.record(
    'TurnState',
    [
      { name: 'running', type: 'bool', default: 'false' },
      { name: 'live', type: 'Map<string, string>', default: 'emptyMap()', doc: 'Text streamed so far, by message id. Kept after the turn so the reply never blinks while the stored copy arrives.' },
      { name: 'activity', type: 'Option<string>', default: 'null', doc: 'What the turn is doing now, in words.' },
      { name: 'notice', type: 'Option<string>', default: 'null', doc: 'Why the last turn ended early, until dismissed.' },
    ],
    { doc: 'The turn in progress, as the screen shows it.' },
  );

  f.cls('ChatViewModel', {
    doc: 'One conversation: its messages, the turn in progress, and its model choice. A turn runs in this ViewModel\'s scope, so leaving the conversation stops it - nothing keeps talking to a model unseen.',
    extends: 'ViewModel',
    fields: [
      { name: 'container', type: 'AppContainer', visibility: 'private' },
      { name: 'conversationId', type: 'string', visibility: 'private' },
      { name: 'store', type: 'RoomConversationStore', default: 'container.conversations', visibility: 'private' },
      { name: 'state', type: 'MutableStateFlow<TurnState>', default: 'MutableStateFlow(TurnState())', visibility: 'private' },
      { name: 'candidates', type: 'MutableStateFlow<Option<List<RouteCandidate>>>', default: 'MutableStateFlow(null)', visibility: 'private' },
      { name: 'job', type: 'Option<Job>', default: 'null', readonly: false, visibility: 'private' },
      {
        name: 'names',
        type: 'Map<ModelChoice, string>',
        default: 'builtInCloudProviders().flatMap { it.models }.associate { ModelChoice(it.providerId, it.modelId) to it.displayName } + localModelCatalog().associate { ModelChoice(LOCAL_PROVIDER_ID, it.id) to it.displayName }',
        visibility: 'private',
      },
      {
        name: 'conversation',
        type: 'StateFlow<Option<Conversation>>',
        default: 'store.observeConversations().map { list -> list.firstOrNull { it.id == conversationId } }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)',
        doc: 'The conversation, live.',
      },
      {
        name: 'messages',
        type: 'StateFlow<Option<List<ChatMessage>>>',
        default: 'store.observeMessages(conversationId).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)',
        doc: 'Its messages in order, live; null until the database answers.',
      },
      {
        name: 'routing',
        type: 'StateFlow<Option<RoutingPreferences>>',
        default: 'container.settings.routing().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)',
        doc: 'The routing settings, for explaining where replies come from.',
      },
      { name: 'turn', type: 'StateFlow<TurnState>', default: 'state.asStateFlow()', doc: 'The turn in progress.' },
      { name: 'models', type: 'StateFlow<Option<List<RouteCandidate>>>', default: 'candidates.asStateFlow()', doc: 'Models to pick from, once loaded.' },
    ],
    ctor: [
      { name: 'container', type: 'AppContainer' },
      { name: 'conversationId', type: 'string' },
    ],
  });
  const C = 'ChatViewModel';
  f.fn('send', {
    of: C,
    doc: 'Send a message and run the turn. Ignored while a turn is running. The turn runs on the IO dispatcher: credential reads and model loading block.',
    params: [{ name: 'text', type: 'string' }],
    code: kt`
      val message = text.trim()
      if (message.isEmpty() || job?.isActive == true) return
      state.value = TurnState(running = true)
      job = viewModelScope.launch {
          try {
              val current = store.conversation(conversationId)
              if (current != null && current.title == NEW_CONVERSATION_TITLE) store.rename(conversationId, titleFrom(message))
              container.orchestrator.send(conversationId, message).flowOn(Dispatchers.IO).collect { apply(it) }
          } finally {
              state.update { it.copy(running = false, activity = null) }
          }
      }
    `,
  });
  f.fn('stop', { of: C, doc: 'Stop the turn. What was written so far is kept, marked stopped.', code: kt`job?.cancel()` });
  f.fn('dismissNotice', { of: C, doc: 'Hide the last turn\'s notice.', code: kt`state.update { it.copy(notice = null) }` });
  f.fn('loadModels', { of: C, doc: 'Load the models this conversation could use, for the picker.', code: kt`
    viewModelScope.launch { candidates.value = withContext(Dispatchers.IO) { container.providers.candidates() } }
  ` });
  f.fn('pin', { of: C, doc: 'Use one model for this conversation, or null to follow the routing settings.', params: [{ name: 'choice', type: 'Option<ModelChoice>' }], code: kt`
    viewModelScope.launch { store.pinModel(conversationId, choice) }
  ` });
  f.fn('modelName', { of: C, doc: 'A model\'s display name.', params: [{ name: 'choice', type: 'ModelChoice' }], returns: 'string', expression: true, code: kt`names[choice] ?: choice.modelId` });
  f.fn('toolTitle', { of: C, doc: 'A tool\'s title, from the name a model called it by.', params: [{ name: 'wireName', type: 'string' }], returns: 'string', expression: true, code: kt`
    container.registry.lookup(wireName)?.first?.title ?: wireName
  ` });
  f.fn('apply', {
    of: C,
    visibility: 'private',
    doc: 'Fold one turn event into the screen state.',
    params: [{ name: 'event', type: 'TurnEvent' }],
    code: kt`
      when (event) {
          is TurnEvent.Routed -> state.update {
              val where = if (event.route.local) "on this device" else "with " + modelName(ModelChoice(event.route.providerId, event.route.modelId))
              it.copy(activity = "Answering " + where)
          }
          is TurnEvent.AwaitingApproval -> state.update { it.copy(activity = "Waiting for your approval") }
          TurnEvent.ApprovalDeclined -> state.update { it.copy(notice = "Not sent. Nothing left this device.") }
          is TurnEvent.AssistantStarted -> state.update { it.copy(live = it.live + (event.messageId to "")) }
          is TurnEvent.TextDelta -> state.update { it.copy(live = it.live + (event.messageId to (it.live[event.messageId].orEmpty() + event.text))) }
          is TurnEvent.ToolRunning -> state.update { it.copy(activity = "Using " + toolTitle(event.call.toolName)) }
          is TurnEvent.ToolFinished -> state.update { it.copy(activity = "Answering") }
          is TurnEvent.LimitReached -> state.update { it.copy(notice = event.detail) }
          is TurnEvent.Failed -> state.update { it.copy(notice = event.message) }
          TurnEvent.Completed -> Unit
      }
    `,
  });
}

function chatScreen(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/chat/ChatScreen.kt`, { doc: 'the conversation screen' });
  f.use(
    'androidx.compose.foundation.lazy.items',
    'androidx.compose.foundation.layout.padding',
    'androidx.compose.material.icons.automirrored.filled.Send',
    'androidx.compose.material.icons.filled.Close',
  );

  f.fn('ChatScreen', {
    annotations: ['Composable'],
    doc: 'A conversation: messages, the turn in progress, a composer, and the model choice.',
    params: [
      { name: 'vm', type: 'ChatViewModel' },
      { name: 'onBack', type: '() -> Void' },
      { name: 'onSettings', type: '() -> Void' },
    ],
    code: kt`
      val conversation by vm.conversation.collectAsStateWithLifecycle()
      val messages by vm.messages.collectAsStateWithLifecycle()
      val turn by vm.turn.collectAsStateWithLifecycle()
      val models by vm.models.collectAsStateWithLifecycle()
      val routing by vm.routing.collectAsStateWithLifecycle()
      var input by rememberSaveable { mutableStateOf("") }
      var picking by remember { mutableStateOf(false) }
      val listState = rememberLazyListState()
      val count = messages?.size ?: 0
      LaunchedEffect(count) { if (count > 0) listState.animateScrollToItem(0) }

      Scaffold(
          topBar = {
              DrakenTopBar(conversation?.title.orEmpty(), onBack = onBack) {
                  TextButton(onClick = {
                      vm.loadModels()
                      picking = true
                  }) {
                      Text(conversation?.modelOverride?.let { vm.modelName(it) } ?: "Auto", maxLines = 1, overflow = TextOverflow.Ellipsis)
                  }
              }
          },
          bottomBar = {
              Composer(
                  input,
                  onInput = { input = it },
                  running = turn.running,
                  onSend = {
                      vm.send(input)
                      input = ""
                  },
                  onStop = vm::stop,
              )
          },
      ) { padding ->
          Column(Modifier.fillMaxSize().padding(padding)) {
              val list = messages
              when {
                  list == null -> Loading(Modifier.weight(1f))
                  list.isEmpty() -> EmptyState("Ask anything", whereRepliesComeFrom(routing?.mode), Modifier.weight(1f))
                  else -> LazyColumn(
                      Modifier.weight(1f).fillMaxWidth(),
                      state = listState,
                      reverseLayout = true,
                      contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                      verticalArrangement = Arrangement.spacedBy(12.dp),
                  ) {
                      items(list.asReversed(), key = { it.id }) { message ->
                          MessageItem(message, turn.live[message.id], turn.running, vm::modelName, vm::toolTitle)
                      }
                  }
              }
              turn.activity?.let { activity ->
                  Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                      CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                      Spacer(Modifier.width(8.dp))
                      Text(activity, style = MaterialTheme.typography.labelMedium, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                  }
              }
              turn.notice?.let { notice ->
                  Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), shape = RoundedCornerShape(12.dp)) {
                      Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                          Text(notice, Modifier.weight(1f).padding(vertical = 8.dp), color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodyMedium)
                          TextButton(onClick = onSettings) { Text("Settings") }
                          TextButton(onClick = vm::dismissNotice) { Text("Dismiss") }
                      }
                  }
              }
          }
      }
      if (picking) {
          ModelPicker(models, conversation?.modelOverride, onPick = {
              vm.pin(it)
              picking = false
          }, onDismiss = { picking = false })
      }
    `,
  });
  f.use('androidx.compose.foundation.layout.size', 'androidx.compose.foundation.layout.width');

  f.fn('whereRepliesComeFrom', {
    visibility: 'private',
    doc: 'Where replies come from under a routing mode, in words.',
    params: [{ name: 'mode', type: 'Option<RoutingMode>' }],
    returns: 'string',
    expression: true,
    code: kt`
      when (mode) {
          RoutingMode.LOCAL_ONLY -> "Replies come from a model on this device. Nothing leaves it."
          RoutingMode.AUTOMATIC -> "Draken picks a model for each reply, preferring this device, within your daily cloud budget."
          RoutingMode.ASK_BEFORE_CLOUD, null -> "Replies come from this device when it can. Before anything goes to a cloud model, you will be asked."
      }
    `,
  });

  f.fn('Composer', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'The message field, with send - or stop while a turn runs.',
    params: [
      { name: 'text', type: 'string' },
      { name: 'onInput', type: '(string) -> Void' },
      { name: 'running', type: 'bool' },
      { name: 'onSend', type: '() -> Void' },
      { name: 'onStop', type: '() -> Void' },
    ],
    code: kt`
      Surface(tonalElevation = 3.dp) {
          Row(
              Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 12.dp, vertical = 8.dp),
              verticalAlignment = Alignment.Bottom,
          ) {
              OutlinedTextField(
                  text,
                  onInput,
                  Modifier.weight(1f),
                  placeholder = { Text("Message") },
                  maxLines = 6,
                  keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
              )
              Spacer(Modifier.width(8.dp))
              if (running) {
                  FilledTonalButton(onClick = onStop) {
                      Icon(Icons.Filled.Close, contentDescription = null)
                      Spacer(Modifier.width(4.dp))
                      Text("Stop")
                  }
              } else {
                  IconButton(onClick = onSend, enabled = text.isNotBlank()) {
                      Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                  }
              }
          }
      }
    `,
  });

  f.fn('MessageItem', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'One message: the user\'s on the right; replies with where they came from; tool results as a line.',
    params: [
      { name: 'message', type: 'ChatMessage' },
      { name: 'liveText', type: 'Option<string>' },
      { name: 'running', type: 'bool' },
      { name: 'modelName', type: '(ModelChoice) -> string' },
      { name: 'toolTitle', type: '(string) -> string' },
    ],
    code: kt`
      when (message.role) {
          MessageRole.USER -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
              Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(18.dp), modifier = Modifier.widthIn(max = 320.dp)) {
                  SelectionContainer { Text(message.text, Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) }
              }
          }
          MessageRole.ASSISTANT -> Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
              val streaming = message.status == MessageStatus.STREAMING
              val text = if (streaming) liveText ?: message.text else message.text
              if (text.isNotEmpty()) {
                  SelectionContainer { Text(text, style = MaterialTheme.typography.bodyLarge) }
              } else if (streaming && running) {
                  Text("…", style = MaterialTheme.typography.bodyLarge)
              }
              for (call in message.toolCalls) {
                  Text("Asked to use " + toolTitle(call.toolName), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary)
              }
              val footer = listOfNotNull(
                  message.route?.let { (if (it.local) "On this device · " else "Cloud · ") + modelName(ModelChoice(it.providerId, it.modelId)) },
                  when {
                      message.status == MessageStatus.CANCELLED -> "Stopped"
                      message.status == MessageStatus.FAILED -> "Failed"
                      streaming && !running -> "Interrupted"
                      else -> null
                  },
                  message.error,
              )
              if (footer.isNotEmpty()) {
                  Text(footer.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
              }
          }
          MessageRole.TOOL -> {
              val result = message.toolResult
              Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                  Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                      Text(
                          (if (result?.isError == true) "Did not run: " else "Ran: ") + (result?.let { toolTitle(it.toolName) } ?: "a tool"),
                          style = MaterialTheme.typography.labelLarge,
                      )
                      Text(message.text, style = MaterialTheme.typography.bodySmall, maxLines = 4, overflow = TextOverflow.Ellipsis)
                  }
              }
          }
      }
    `,
  });

  f.fn('ModelPicker', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'Pick a model for this conversation. Models that cannot be used now are listed with the reason, not hidden.',
    params: [
      { name: 'models', type: 'Option<List<RouteCandidate>>' },
      { name: 'current', type: 'Option<ModelChoice>' },
      { name: 'onPick', type: '(Option<ModelChoice>) -> Void' },
      { name: 'onDismiss', type: '() -> Void' },
    ],
    code: kt`
      AlertDialog(
          onDismissRequest = onDismiss,
          title = { Text("Model for this conversation") },
          text = {
              if (models == null) {
                  Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
              } else {
                  LazyColumn(Modifier.heightIn(max = 440.dp)) {
                      item {
                          PickerRow("Automatic", "Follow the routing settings", current == null, true) { onPick(null) }
                      }
                      for ((kind, title) in listOf(ProviderKind.LOCAL to "On this device", ProviderKind.CLOUD to "Cloud")) {
                          val group = models.filter { it.kind == kind }
                          if (group.isEmpty()) continue
                          item { Text(title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp)) }
                          items(group, key = { it.model.providerId + "/" + it.model.modelId }) { candidate ->
                              val choice = ModelChoice(candidate.model.providerId, candidate.model.modelId)
                              val detail = candidate.unavailableReason ?: if (candidate.model.capabilities.supportsTools) "Can use modules" else "Text only"
                              PickerRow(candidate.model.displayName, detail, current == choice, candidate.ready) { onPick(choice) }
                          }
                      }
                      if (models.none { it.kind == ProviderKind.LOCAL }) {
                          item { Text("No on-device model is installed. Download one in Settings.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 12.dp)) }
                      }
                  }
              }
          },
          confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
      )
    `,
  });

  f.fn('PickerRow', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'One choice in the model picker.',
    params: [
      { name: 'title', type: 'string' },
      { name: 'detail', type: 'string' },
      { name: 'selected', type: 'bool' },
      { name: 'enabled', type: 'bool' },
      { name: 'onClick', type: '() -> Void' },
    ],
    code: kt`
      Row(
          Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(vertical = 6.dp),
          verticalAlignment = Alignment.CenterVertically,
      ) {
          RadioButton(selected = selected, onClick = onClick, enabled = enabled)
          Column(Modifier.padding(start = 8.dp)) {
              Text(title, style = MaterialTheme.typography.bodyLarge)
              Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
      }
    `,
  });
}
