/**
 * Settings: the hub, routing and privacy, connections to model providers,
 * and on-device models.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const UI = 'app/src/main/kotlin/com/draken/app/ui';

export function buildSettings(ctx: Ctx): void {
  settingsViewModel(ctx);
  hub(ctx);
  routing(ctx);
  connections(ctx);
  models(ctx);
}

function settingsViewModel(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/settings/SettingsViewModel.kt`, { doc: 'settings state' });
  f.use('java.security.GeneralSecurityException');

  f.fn('endpointProblem', {
    doc: 'Why a self-hosted server URL cannot be used, or null. Plain http is allowed only to a server on the phone itself: anything else would send conversations across the network unencrypted.',
    params: [{ name: 'url', type: 'string' }],
    returns: 'Option<string>',
    code: kt`
      val uri = runCatching { URI(url) }.getOrNull() ?: return "That is not a URL."
      val host = uri.host ?: return "The URL needs a host, such as https://example.com/v1."
      return when (uri.scheme?.lowercase()) {
          "https" -> null
          "http" -> if (host == "localhost" || host == "127.0.0.1" || host == "[::1]") null else "Use https. Plain http is allowed only to a server running on this phone."
          else -> "The URL must start with https://."
      }
    `,
  });

  f.cls('SettingsViewModel', {
    doc: 'Routing preferences, provider keys and the self-hosted endpoint. Keys go in and never come back out: the screen only ever sees their last four characters.',
    extends: 'ViewModel',
    fields: [
      { name: 'container', type: 'AppContainer', visibility: 'private' },
      { name: 'settings', type: 'AppSettings', default: 'container.settings', visibility: 'private' },
      { name: 'credentials', type: 'EncryptedCredentialStore', default: 'container.credentials', visibility: 'private' },
      { name: 'candidates', type: 'MutableStateFlow<Option<List<RouteCandidate>>>', default: 'MutableStateFlow(null)', visibility: 'private' },
      { name: 'notices', type: 'MutableStateFlow<Option<string>>', default: 'MutableStateFlow(null)', visibility: 'private' },
      { name: 'providers', type: 'List<CloudProviderConfig>', default: 'builtInCloudProviders()', doc: 'The built-in cloud providers.' },
      { name: 'routing', type: 'StateFlow<Option<RoutingPreferences>>', default: 'settings.routing().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)', doc: 'Routing preferences; null until read.' },
      { name: 'endpoint', type: 'StateFlow<Option<CustomEndpoint>>', default: 'settings.customEndpoint().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)', doc: 'The self-hosted endpoint, if set.' },
      { name: 'keys', type: 'StateFlow<Map<string, string>>', default: 'credentials.observeHints().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyMap())', doc: 'Providers with a saved key, and its last four characters.' },
      { name: 'usageToday', type: 'StateFlow<Map<string, i64>>', default: 'container.usage.observeToday().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyMap())', doc: 'Cloud tokens used today, by provider.' },
      { name: 'models', type: 'StateFlow<Option<List<RouteCandidate>>>', default: 'candidates.asStateFlow()', doc: 'Every model, once loaded.' },
      { name: 'notice', type: 'StateFlow<Option<string>>', default: 'notices.asStateFlow()', doc: 'A message for the snackbar.' },
    ],
    ctor: [{ name: 'container', type: 'AppContainer' }],
  });
  const S = 'SettingsViewModel';
  const launch = (body: string) => `viewModelScope.launch { ${body} }`;
  f.fn('loadModels', { of: S, doc: 'Load every model, for the preferred-model choices.', code: kt`
    viewModelScope.launch { candidates.value = withContext(Dispatchers.IO) { container.providers.candidates() } }
  ` });
  f.fn('setMode', { of: S, doc: 'Set the routing mode.', params: [{ name: 'mode', type: 'RoutingMode' }], code: launch('settings.setMode(mode)') });
  f.fn('setPreferLocal', { of: S, doc: 'Prefer on-device models.', params: [{ name: 'prefer', type: 'bool' }], code: launch('settings.setPreferLocal(prefer)') });
  f.fn('setPreferredCloud', { of: S, doc: 'The cloud model to use when one is used.', params: [{ name: 'choice', type: 'Option<ModelChoice>' }], code: launch('settings.setPreferredCloud(choice)') });
  f.fn('setPreferredLocal', { of: S, doc: 'The on-device model to use.', params: [{ name: 'choice', type: 'Option<ModelChoice>' }], code: launch('settings.setPreferredLocal(choice)') });
  f.fn('setBudget', { of: S, doc: 'Set the daily cloud budget from what was typed; blank removes it.', params: [{ name: 'text', type: 'string' }], code: kt`
    val clean = text.filter { it.isDigit() }
    if (text.isNotBlank() && clean.isEmpty()) {
        notices.value = "The budget is a number of tokens."
        return
    }
    val tokens = clean.toLongOrNull()
    viewModelScope.launch {
        settings.setDailyBudget(tokens)
        notices.value = if (tokens == null) "No daily budget" else "Budget saved"
    }
  ` });
  f.fn('saveKey', { of: S, doc: 'Encrypt and store a provider key.', params: [{ name: 'providerId', type: 'string' }, { name: 'key', type: 'string' }], code: kt`
    if (key.isBlank()) return
    viewModelScope.launch {
        notices.value = try {
            withContext(Dispatchers.IO) { credentials.save(providerId, key) }
            "Key saved"
        } catch (failure: GeneralSecurityException) {
            "This phone could not encrypt the key, so it was not saved."
        }
    }
  ` });
  f.fn('removeKey', { of: S, doc: 'Forget a provider key.', params: [{ name: 'providerId', type: 'string' }], code: kt`
    viewModelScope.launch {
        credentials.remove(providerId)
        notices.value = "Key removed"
    }
  ` });
  f.fn('saveEndpoint', { of: S, doc: 'Set the self-hosted endpoint, and its key if one was typed.', params: [{ name: 'url', type: 'string' }, { name: 'model', type: 'string' }, { name: 'key', type: 'string' }], code: kt`
    val cleanUrl = url.trim().trimEnd('/')
    val problem = endpointProblem(cleanUrl)
    if (problem != null || model.isBlank()) {
        notices.value = problem ?: "Name the model the server should run."
        return
    }
    viewModelScope.launch {
        settings.setCustomEndpoint(CustomEndpoint(cleanUrl, model.trim()))
        if (key.isNotBlank()) withContext(Dispatchers.IO) { credentials.save(CUSTOM_PROVIDER_ID, key) }
        notices.value = "Server saved"
    }
  ` });
  f.fn('clearEndpoint', { of: S, doc: 'Forget the self-hosted endpoint and its key.', code: kt`
    viewModelScope.launch {
        settings.setCustomEndpoint(null)
        if (keys.value.containsKey(CUSTOM_PROVIDER_ID)) credentials.remove(CUSTOM_PROVIDER_ID)
        notices.value = "Server removed"
    }
  ` });
  f.fn('noticeShown', { of: S, doc: 'The snackbar has shown the notice.', code: kt`notices.value = null` });
}

function hub(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/settings/SettingsScreen.kt`, { doc: 'the settings hub' });
  f.use('androidx.compose.foundation.layout.padding');
  f.fn('SettingsScreen', {
    annotations: ['Composable'],
    doc: 'Every setting, one tap away.',
    params: [
      { name: 'onBack', type: '() -> Void' },
      { name: 'onOpen', type: '(string) -> Void' },
    ],
    code: kt`
      val entries = listOf(
          Triple(Routes.ROUTING, "Routing and privacy", "Where replies come from, and when the cloud may be used"),
          Triple(Routes.CONNECTIONS, "Connections", "Cloud providers and a self-hosted server"),
          Triple(Routes.MODELS, "On-device models", "Download and manage models that run on this phone"),
          Triple(Routes.MODULES, "Modules", "What Draken can do, and what each module may access"),
          Triple(Routes.AUDIT, "Activity log", "Tool use, permission changes and cloud requests"),
      )
      Scaffold(topBar = { DrakenTopBar("Settings", onBack = onBack) }) { padding ->
          Column(Modifier.fillMaxSize().padding(padding)) {
              for ((route, title, detail) in entries) {
                  ListItem(
                      headlineContent = { Text(title) },
                      supportingContent = { Text(detail) },
                      modifier = Modifier.clickable { onOpen(route) },
                  )
              }
              Text(
                  "Draken keeps conversations, notes and keys on this phone. They are not backed up.",
                  style = MaterialTheme.typography.bodySmall,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                  modifier = Modifier.padding(16.dp),
              )
          }
      }
    `,
  });
}

function routing(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/settings/RoutingScreen.kt`, { doc: 'routing and privacy settings' });
  f.use(
    'androidx.compose.foundation.layout.padding',
    'androidx.compose.foundation.lazy.items',
    'androidx.compose.foundation.selection.selectable',
    'androidx.compose.foundation.selection.toggleable',
    'androidx.compose.ui.semantics.Role',
  );

  f.fn('RoutingScreen', {
    annotations: ['Composable'],
    doc: 'The routing mode, preferred models and the daily cloud budget.',
    params: [
      { name: 'vm', type: 'SettingsViewModel' },
      { name: 'onBack', type: '() -> Void' },
    ],
    code: kt`
      val routing by vm.routing.collectAsStateWithLifecycle()
      val models by vm.models.collectAsStateWithLifecycle()
      val usage by vm.usageToday.collectAsStateWithLifecycle()
      val notice by vm.notice.collectAsStateWithLifecycle()
      val snackbar = remember { SnackbarHostState() }
      var choosing by remember { mutableStateOf<ProviderKind?>(null) }
      LaunchedEffect(Unit) { vm.loadModels() }
      LaunchedEffect(notice) {
          notice?.let {
              snackbar.showSnackbar(it)
              vm.noticeShown()
          }
      }
      Scaffold(topBar = { DrakenTopBar("Routing and privacy", onBack = onBack) }, snackbarHost = { SnackbarHost(snackbar) }) { padding ->
          val prefs = routing
          if (prefs == null) {
              Loading(Modifier.padding(padding))
          } else {
              Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
                  SectionHeader("Where replies come from")
                  ModeOption("On this device only", "Nothing ever leaves the phone. Replies need an installed on-device model.", prefs.mode == RoutingMode.LOCAL_ONLY) { vm.setMode(RoutingMode.LOCAL_ONLY) }
                  ModeOption("Ask before using the cloud", "On-device when it can. Before a cloud model sees anything, you are shown what would be sent and to whom.", prefs.mode == RoutingMode.ASK_BEFORE_CLOUD) { vm.setMode(RoutingMode.ASK_BEFORE_CLOUD) }
                  ModeOption("Automatic", "Draken chooses, and uses the cloud without asking - up to the daily budget below.", prefs.mode == RoutingMode.AUTOMATIC) { vm.setMode(RoutingMode.AUTOMATIC) }
                  Row(
                      Modifier.fillMaxWidth().toggleable(value = prefs.preferLocal, role = Role.Switch, onValueChange = vm::setPreferLocal).padding(horizontal = 16.dp, vertical = 12.dp),
                      verticalAlignment = Alignment.CenterVertically,
                  ) {
                      Column(Modifier.weight(1f)) {
                          Text("Prefer this device", style = MaterialTheme.typography.bodyLarge)
                          Text("Use an on-device model whenever one can do the task.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                      }
                      Switch(checked = prefs.preferLocal, onCheckedChange = null)
                  }

                  SectionHeader("Preferred models")
                  ListItem(
                      headlineContent = { Text("Cloud model") },
                      supportingContent = { Text(nameOf(prefs.preferredCloud, models) ?: "None - Draken chooses") },
                      modifier = Modifier.clickable { choosing = ProviderKind.CLOUD },
                  )
                  ListItem(
                      headlineContent = { Text("On-device model") },
                      supportingContent = { Text(nameOf(prefs.preferredLocal, models) ?: "None - Draken chooses") },
                      modifier = Modifier.clickable { choosing = ProviderKind.LOCAL },
                  )

                  SectionHeader("Daily cloud budget")
                  BudgetEditor(prefs.dailyCloudTokenBudget, vm::setBudget)
                  val used = usage.values.sum()
                  Text(
                      "Used today: " + String.format(Locale.getDefault(), "%,d", used) + " tokens" +
                          (if (usage.isEmpty()) "" else " (" + usage.entries.joinToString(", ") { it.key + " " + String.format(Locale.getDefault(), "%,d", it.value) } + ")"),
                      style = MaterialTheme.typography.bodySmall,
                      color = MaterialTheme.colorScheme.onSurfaceVariant,
                      modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                  )
              }
          }
      }
      choosing?.let { kind ->
          val current = if (kind == ProviderKind.CLOUD) routing?.preferredCloud else routing?.preferredLocal
          ModelChoiceDialog(
              if (kind == ProviderKind.CLOUD) "Preferred cloud model" else "Preferred on-device model",
              models?.filter { it.kind == kind },
              current,
              onPick = {
                  if (kind == ProviderKind.CLOUD) vm.setPreferredCloud(it) else vm.setPreferredLocal(it)
                  choosing = null
              },
              onDismiss = { choosing = null },
          )
      }
    `,
  });

  f.fn('nameOf', {
    visibility: 'private',
    doc: 'A chosen model\'s name, or its id until the list has loaded.',
    params: [
      { name: 'choice', type: 'Option<ModelChoice>' },
      { name: 'models', type: 'Option<List<RouteCandidate>>' },
    ],
    returns: 'Option<string>',
    expression: true,
    code: kt`
      choice?.let { c -> models?.firstOrNull { it.model.providerId == c.providerId && it.model.modelId == c.modelId }?.model?.displayName ?: c.modelId }
    `,
  });

  f.fn('ModeOption', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'One routing mode, selectable as a whole row.',
    params: [
      { name: 'title', type: 'string' },
      { name: 'detail', type: 'string' },
      { name: 'selected', type: 'bool' },
      { name: 'onSelect', type: '() -> Void' },
    ],
    code: kt`
      Row(
          Modifier.fillMaxWidth().selectable(selected = selected, role = Role.RadioButton, onClick = onSelect).padding(horizontal = 16.dp, vertical = 10.dp),
          verticalAlignment = Alignment.CenterVertically,
      ) {
          RadioButton(selected = selected, onClick = null)
          Column(Modifier.padding(start = 16.dp)) {
              Text(title, style = MaterialTheme.typography.bodyLarge)
              Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
      }
    `,
  });

  f.fn('BudgetEditor', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'The daily budget in tokens. Blank means none.',
    params: [
      { name: 'budget', type: 'Option<i64>' },
      { name: 'onSave', type: '(string) -> Void' },
    ],
    code: kt`
      var text by rememberSaveable(budget) { mutableStateOf(budget?.toString().orEmpty()) }
      Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(
              "Applies in Automatic mode: once today's cloud use reaches it, replies stay on this device. Tokens are counted from what providers report.",
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          Row(verticalAlignment = Alignment.CenterVertically) {
              OutlinedTextField(
                  text,
                  { text = it },
                  Modifier.weight(1f),
                  label = { Text("Tokens a day") },
                  placeholder = { Text("No limit") },
                  singleLine = true,
                  keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
              )
              TextButton(onClick = { onSave(text) }) { Text("Save") }
          }
      }
    `,
  });

  f.fn('ModelChoiceDialog', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'Choose one of a kind of model, or none.',
    params: [
      { name: 'title', type: 'string' },
      { name: 'models', type: 'Option<List<RouteCandidate>>' },
      { name: 'current', type: 'Option<ModelChoice>' },
      { name: 'onPick', type: '(Option<ModelChoice>) -> Void' },
      { name: 'onDismiss', type: '() -> Void' },
    ],
    code: kt`
      AlertDialog(
          onDismissRequest = onDismiss,
          title = { Text(title) },
          text = {
              if (models == null) {
                  Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
              } else {
                  LazyColumn(Modifier.heightIn(max = 420.dp)) {
                      item { ChoiceRow("None", "Draken chooses", current == null, true) { onPick(null) } }
                      items(models, key = { it.model.providerId + "/" + it.model.modelId }) { candidate ->
                          val choice = ModelChoice(candidate.model.providerId, candidate.model.modelId)
                          ChoiceRow(candidate.model.displayName, candidate.unavailableReason ?: "Ready", current == choice, candidate.ready) { onPick(choice) }
                      }
                      if (models.isEmpty()) item { Text("None available yet.", style = MaterialTheme.typography.bodySmall) }
                  }
              }
          },
          confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
      )
    `,
  });

  f.fn('ChoiceRow', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'One option in a choice dialog.',
    params: [
      { name: 'title', type: 'string' },
      { name: 'detail', type: 'string' },
      { name: 'selected', type: 'bool' },
      { name: 'enabled', type: 'bool' },
      { name: 'onClick', type: '() -> Void' },
    ],
    code: kt`
      Row(
          Modifier.fillMaxWidth().selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick).padding(vertical = 6.dp),
          verticalAlignment = Alignment.CenterVertically,
      ) {
          RadioButton(selected = selected, onClick = null, enabled = enabled)
          Column(Modifier.padding(start = 12.dp)) {
              Text(title, style = MaterialTheme.typography.bodyLarge)
              Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
      }
    `,
  });
}

function connections(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/settings/ConnectionsScreen.kt`, { doc: 'connections to model providers' });
  f.use('androidx.compose.foundation.layout.padding', 'androidx.compose.foundation.lazy.items');

  f.fn('ConnectionsScreen', {
    annotations: ['Composable'],
    doc: 'The cloud providers and the self-hosted server Draken may connect to, and their keys.',
    params: [
      { name: 'vm', type: 'SettingsViewModel' },
      { name: 'onBack', type: '() -> Void' },
    ],
    code: kt`
      val keys by vm.keys.collectAsStateWithLifecycle()
      val endpoint by vm.endpoint.collectAsStateWithLifecycle()
      val notice by vm.notice.collectAsStateWithLifecycle()
      val snackbar = remember { SnackbarHostState() }
      var editing by remember { mutableStateOf<CloudProviderConfig?>(null) }
      var removing by remember { mutableStateOf<CloudProviderConfig?>(null) }
      LaunchedEffect(notice) {
          notice?.let {
              snackbar.showSnackbar(it)
              vm.noticeShown()
          }
      }
      Scaffold(topBar = { DrakenTopBar("Connections", onBack = onBack) }, snackbarHost = { SnackbarHost(snackbar) }) { padding ->
          LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
              item {
                  Text(
                      "Connect the providers you want Draken to be able to use. Keys are encrypted with a key held in this phone's secure hardware; they are never shown again and never backed up.",
                      style = MaterialTheme.typography.bodyMedium,
                      modifier = Modifier.padding(16.dp),
                  )
              }
              items(vm.providers, key = { it.id }) { provider ->
                  val hint = keys[provider.id]
                  ListItem(
                      headlineContent = { Text(provider.displayName) },
                      supportingContent = {
                          Column {
                              Text(if (hint != null) "Connected · key ends in " + hint else "Not connected")
                              Text(provider.models.joinToString(", ") { it.displayName }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                          }
                      },
                      trailingContent = {
                          Row {
                              if (hint != null) TextButton(onClick = { removing = provider }) { Text("Remove") }
                              TextButton(onClick = { editing = provider }) { Text(if (hint == null) "Add key" else "Replace") }
                          }
                      },
                  )
              }
              item { SectionHeader("Self-hosted server") }
              item { EndpointEditor(endpoint, keys.containsKey(CUSTOM_PROVIDER_ID), vm::saveEndpoint, vm::clearEndpoint) }
          }
      }
      editing?.let { provider ->
          KeyDialog(provider.displayName, onDismiss = { editing = null }, onSave = {
              vm.saveKey(provider.id, it)
              editing = null
          })
      }
      removing?.let { provider ->
          AlertDialog(
              onDismissRequest = { removing = null },
              title = { Text("Remove the " + provider.displayName + " key?") },
              text = { Text("Draken will stop using " + provider.displayName + " until a key is added again.") },
              confirmButton = {
                  TextButton(onClick = {
                      vm.removeKey(provider.id)
                      removing = null
                  }) { Text("Remove") }
              },
              dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
          )
      }
    `,
  });

  f.fn('KeyDialog', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'Enter an API key. The field is masked and is not kept after the dialog closes.',
    params: [
      { name: 'providerName', type: 'string' },
      { name: 'onDismiss', type: '() -> Void' },
      { name: 'onSave', type: '(string) -> Void' },
    ],
    code: kt`
      var key by remember { mutableStateOf("") }
      AlertDialog(
          onDismissRequest = onDismiss,
          title = { Text(providerName + " API key") },
          text = {
              OutlinedTextField(
                  key,
                  { key = it },
                  label = { Text("API key") },
                  singleLine = true,
                  visualTransformation = PasswordVisualTransformation(),
                  keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
              )
          },
          confirmButton = { TextButton(onClick = { onSave(key) }, enabled = key.isNotBlank()) { Text("Save") } },
          dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
      )
    `,
  });

  f.fn('EndpointEditor', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'A self-hosted OpenAI-compatible server: its URL, model and optional key.',
    params: [
      { name: 'endpoint', type: 'Option<CustomEndpoint>' },
      { name: 'hasKey', type: 'bool' },
      { name: 'onSave', type: '(string, string, string) -> Void' },
      { name: 'onClear', type: '() -> Void' },
    ],
    code: kt`
      var url by rememberSaveable(endpoint) { mutableStateOf(endpoint?.baseUrl.orEmpty()) }
      var model by rememberSaveable(endpoint) { mutableStateOf(endpoint?.modelId.orEmpty()) }
      var key by remember { mutableStateOf("") }
      Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(
              "An OpenAI-compatible server such as Ollama, LM Studio or vLLM. Requests to it leave this phone, so routing treats it as a cloud model.",
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("Base URL") }, placeholder = { Text("https://example.com/v1") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
          OutlinedTextField(model, { model = it }, Modifier.fillMaxWidth(), label = { Text("Model") }, singleLine = true)
          OutlinedTextField(
              key,
              { key = it },
              Modifier.fillMaxWidth(),
              label = { Text(if (hasKey) "API key (saved; blank keeps it)" else "API key (optional)") },
              singleLine = true,
              visualTransformation = PasswordVisualTransformation(),
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
          )
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              Button(onClick = {
                  onSave(url, model, key)
                  key = ""
              }, enabled = url.isNotBlank() && model.isNotBlank()) { Text("Save") }
              if (endpoint != null) OutlinedButton(onClick = onClear) { Text("Remove") }
          }
      }
    `,
  });
}

function models(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/models/Models.kt`, { doc: 'on-device models' });
  f.use('androidx.compose.foundation.layout.padding', 'androidx.compose.foundation.lazy.items', 'kotlinx.coroutines.flow.map');

  f.record(
    'ModelRow',
    [
      { name: 'spec', type: 'LocalModelSpec' },
      { name: 'installed', type: 'bool' },
      { name: 'partialBytes', type: 'i64', doc: 'Bytes of an unfinished download kept for resuming.' },
      { name: 'download', type: 'Option<DownloadState>' },
      { name: 'incompatibility', type: 'Option<string>', doc: 'Why this phone cannot run it, if it cannot.' },
    ],
    { doc: 'One catalogued model and where it stands.' },
  );
  f.record(
    'ModelsState',
    [
      { name: 'rows', type: 'List<ModelRow>' },
      { name: 'usedBytes', type: 'i64' },
      { name: 'freeBytes', type: 'i64' },
    ],
    { doc: 'The models screen.' },
  );

  f.cls('ModelsViewModel', {
    doc: 'The model catalogue against what is installed and downloading. Downloads run in the application scope, so leaving this screen does not stop one.',
    extends: 'ViewModel',
    fields: [
      { name: 'container', type: 'AppContainer', visibility: 'private' },
      {
        name: 'state',
        type: 'StateFlow<Option<ModelsState>>',
        default: 'combine(container.downloads.states, container.downloads.installedVersion) { states, _ -> states }.map { snapshot(it) }.flowOn(Dispatchers.IO).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)',
        doc: 'The screen state; null until the files have been checked.',
      },
    ],
    ctor: [{ name: 'container', type: 'AppContainer' }],
  });
  const M = 'ModelsViewModel';
  f.fn('download', { of: M, doc: 'Start or resume a download.', params: [{ name: 'spec', type: 'LocalModelSpec' }], code: kt`container.downloads.start(spec)` });
  f.fn('cancel', { of: M, doc: 'Stop a download, keeping what arrived.', params: [{ name: 'spec', type: 'LocalModelSpec' }], code: kt`container.downloads.cancel(spec)` });
  f.fn('remove', { of: M, doc: 'Delete an installed or partial model.', params: [{ name: 'spec', type: 'LocalModelSpec' }], code: kt`
    viewModelScope.launch(Dispatchers.IO) { container.downloads.remove(spec) }
  ` });
  f.fn('snapshot', {
    of: M,
    visibility: 'private',
    doc: 'Check every catalogued model against the files on disk.',
    params: [{ name: 'downloads', type: 'Map<string, DownloadState>' }],
    returns: 'ModelsState',
    code: kt`
      val store = container.modelStore
      val rows = store.catalog.map { spec ->
          val partial = store.partialFileFor(spec)
          ModelRow(spec, store.isInstalled(spec), if (partial.exists()) partial.length() else 0L, downloads[spec.id], incompatibility(spec, container.device))
      }
      val directory = store.directory.takeIf { it.exists() } ?: store.directory.parentFile
      return ModelsState(rows, store.usedBytes(), directory?.usableSpace ?: 0L)
    `,
  });

  f.fn('ModelsScreen', {
    annotations: ['Composable'],
    doc: 'Download, follow, cancel and delete on-device models.',
    params: [
      { name: 'vm', type: 'ModelsViewModel' },
      { name: 'onBack', type: '() -> Void' },
    ],
    code: kt`
      val state by vm.state.collectAsStateWithLifecycle()
      var deleting by remember { mutableStateOf<LocalModelSpec?>(null) }
      Scaffold(topBar = { DrakenTopBar("On-device models", onBack = onBack) }) { padding ->
          val current = state
          if (current == null) {
              Loading(Modifier.padding(padding))
          } else {
              LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
                  item {
                      Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                          Text("These models run entirely on this phone: nothing you send them leaves it. They are large downloads, so use Wi-Fi.", style = MaterialTheme.typography.bodyMedium)
                          Text(
                              "Models use " + formatSize(current.usedBytes) + " · " + formatSize(current.freeBytes) + " free",
                              style = MaterialTheme.typography.bodySmall,
                              color = MaterialTheme.colorScheme.onSurfaceVariant,
                          )
                      }
                  }
                  items(current.rows, key = { it.spec.id }) { row ->
                      ModelCard(row, onDownload = { vm.download(row.spec) }, onCancel = { vm.cancel(row.spec) }, onDelete = { deleting = row.spec })
                  }
              }
          }
      }
      deleting?.let { spec ->
          AlertDialog(
              onDismissRequest = { deleting = null },
              title = { Text("Delete " + spec.displayName + "?") },
              text = { Text("This frees " + formatSize(spec.sizeBytes) + ". You can download it again later.") },
              confirmButton = {
                  TextButton(onClick = {
                      vm.remove(spec)
                      deleting = null
                  }) { Text("Delete") }
              },
              dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
          )
      }
    `,
  });

  f.fn('ModelCard', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'One model: what it is, and the one action that makes sense for it now.',
    params: [
      { name: 'row', type: 'ModelRow' },
      { name: 'onDownload', type: '() -> Void' },
      { name: 'onCancel', type: '() -> Void' },
      { name: 'onDelete', type: '() -> Void' },
    ],
    code: kt`
      val spec = row.spec
      OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
          Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
              Text(spec.displayName, style = MaterialTheme.typography.titleMedium)
              Text(
                  formatSize(spec.sizeBytes) + " · needs " + gigabytes(spec.minMemoryBytes) + " of memory · " + spec.license,
                  style = MaterialTheme.typography.bodySmall,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
              )
              val download = row.download
              when {
                  row.installed -> Row(verticalAlignment = Alignment.CenterVertically) {
                      Column(Modifier.weight(1f)) {
                          Text("Installed", style = MaterialTheme.typography.labelLarge)
                          row.incompatibility?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                      }
                      TextButton(onClick = onDelete) { Text("Delete") }
                  }
                  download != null && download.running -> {
                      val progress = download.progress
                      if (progress == null || progress.totalBytes <= 0) {
                          LinearProgressIndicator(Modifier.fillMaxWidth())
                      } else {
                          LinearProgressIndicator(progress = { progress.downloadedBytes.toFloat() / progress.totalBytes }, modifier = Modifier.fillMaxWidth())
                      }
                      Row(verticalAlignment = Alignment.CenterVertically) {
                          Text(
                              when {
                                  progress == null -> "Starting…"
                                  progress.verifying -> "Checking the download…"
                                  else -> formatSize(progress.downloadedBytes) + " of " + formatSize(progress.totalBytes)
                              },
                              Modifier.weight(1f),
                              style = MaterialTheme.typography.bodySmall,
                          )
                          TextButton(onClick = onCancel) { Text("Cancel") }
                      }
                  }
                  row.incompatibility != null -> Text(row.incompatibility, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                  else -> {
                      download?.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                          Button(onClick = onDownload) {
                              Text(if (row.partialBytes > 0) "Resume (" + formatSize(row.partialBytes) + " of " + formatSize(spec.sizeBytes) + ")" else "Download")
                          }
                          if (row.partialBytes > 0) TextButton(onClick = onDelete) { Text("Discard") }
                      }
                  }
              }
          }
      }
    `,
  });
}
