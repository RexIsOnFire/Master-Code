/**
 * The interface's frame: the activity, theme, navigation, the dialogs a turn
 * can raise from any screen, and the small components every screen shares.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const APP = 'app/src/main/kotlin/com/draken/app';
const UI = `${APP}/ui`;

export function buildShell(ctx: Ctx): void {
  theme(ctx);
  activity(ctx);
  navigation(ctx);
  prompts(ctx);
  common(ctx);
}

function theme(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/theme/Theme.kt`, { doc: 'colours' });
  f.decl(
    kt`
      private val LightColors = lightColorScheme(
          primary = Color(0xFF4A56C8),
          onPrimary = Color(0xFFFFFFFF),
          primaryContainer = Color(0xFFDFE0FF),
          onPrimaryContainer = Color(0xFF00105C),
          secondary = Color(0xFF5B5D72),
          onSecondary = Color(0xFFFFFFFF),
          secondaryContainer = Color(0xFFE0E1F9),
          onSecondaryContainer = Color(0xFF181A2C),
          tertiary = Color(0xFF77536D),
          tertiaryContainer = Color(0xFFFFD7F1),
          onTertiaryContainer = Color(0xFF2D1228),
          background = Color(0xFFF7F7FA),
          surface = Color(0xFFF7F7FA),
      )

      private val DarkColors = darkColorScheme(
          primary = Color(0xFFBCC2FF),
          onPrimary = Color(0xFF15228F),
          primaryContainer = Color(0xFF313DAF),
          onPrimaryContainer = Color(0xFFDFE0FF),
          secondary = Color(0xFFC4C5DD),
          onSecondary = Color(0xFF2D2F42),
          secondaryContainer = Color(0xFF434659),
          onSecondaryContainer = Color(0xFFE0E1F9),
          tertiary = Color(0xFFE6BAD7),
          tertiaryContainer = Color(0xFF5D3C55),
          onTertiaryContainer = Color(0xFFFFD7F1),
          background = Color(0xFF121318),
          surface = Color(0xFF121318),
      )
    `,
    { doc: 'The fallback palettes, for devices without dynamic colour.' },
  );
  f.fn('DrakenTheme', {
    annotations: ['Composable'],
    doc: 'Material 3, with the wallpaper\'s colours on Android 12 and later.',
    params: [{ name: 'content', type: '@Composable () -> Unit' }],
    code: kt`
      val dark = isSystemInDarkTheme()
      val context = LocalContext.current
      val colors = when {
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
          dark -> DarkColors
          else -> LightColors
      }
      MaterialTheme(colorScheme = colors, content = content)
    `,
  });
}

function activity(ctx: Ctx): void {
  const f = new KtFile(ctx, `${APP}/MainActivity.kt`, { doc: 'the activity' });
  f.cls('MainActivity', { doc: 'The single activity; Compose draws everything inside it.', extends: 'ComponentActivity' });
  f.fn('onCreate', {
    of: 'MainActivity',
    override: true,
    doc: 'Draw edge to edge and show the app.',
    params: [{ name: 'savedInstanceState', type: 'Option<Bundle>' }],
    code: kt`
      super.onCreate(savedInstanceState)
      enableEdgeToEdge()
      val container = (application as DrakenApplication).container
      setContent { DrakenTheme { DrakenApp(container) } }
    `,
  });
}

function navigation(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/DrakenApp.kt`, { doc: 'navigation' });
  f.decl(
    kt`
      /** Every destination. Arguments are path segments, so a route is a plain string. */
      object Routes {
          const val HISTORY = "history"
          const val CHAT = "chat/{id}"
          const val SETTINGS = "settings"
          const val ROUTING = "settings/routing"
          const val CONNECTIONS = "settings/connections"
          const val MODELS = "settings/models"
          const val MODULES = "settings/modules"
          const val MODULE = "settings/modules/{id}"
          const val NOTES = "notes"
          const val NOTE = "notes/{id}"
          const val AUDIT = "settings/audit"

          fun chat(id: String) = "chat/" + id

          fun module(id: String) = "settings/modules/" + id

          fun note(id: String) = "notes/" + id
      }
    `,
    { doc: 'Routes.', provides: ['Routes'] },
  );
  f.fn('DrakenApp', {
    annotations: ['Composable'],
    doc: 'The navigation graph. Each destination gets its own ViewModel, scoped to its place on the back stack: leaving a chat ends its turn and frees its state.',
    params: [{ name: 'container', type: 'AppContainer' }],
    code: kt`
      val nav = rememberNavController()
      val idArgument = listOf(navArgument("id") { type = NavType.StringType })
      val back: () -> Unit = { nav.popBackStack() }
      NavHost(nav, startDestination = Routes.HISTORY) {
          composable(Routes.HISTORY) {
              HistoryScreen(
                  viewModel { HistoryViewModel(container.conversations) },
                  onOpen = { nav.navigate(Routes.chat(it)) },
                  onNotes = { nav.navigate(Routes.NOTES) },
                  onSettings = { nav.navigate(Routes.SETTINGS) },
              )
          }
          composable(Routes.CHAT, arguments = idArgument) { entry ->
              val conversationId = entry.arguments?.getString("id").orEmpty()
              ChatScreen(viewModel { ChatViewModel(container, conversationId) }, onBack = back, onSettings = { nav.navigate(Routes.SETTINGS) })
          }
          composable(Routes.SETTINGS) { SettingsScreen(onBack = back, onOpen = { nav.navigate(it) }) }
          composable(Routes.ROUTING) { RoutingScreen(viewModel { SettingsViewModel(container) }, onBack = back) }
          composable(Routes.CONNECTIONS) { ConnectionsScreen(viewModel { SettingsViewModel(container) }, onBack = back) }
          composable(Routes.MODELS) { ModelsScreen(viewModel { ModelsViewModel(container) }, onBack = back) }
          composable(Routes.MODULES) {
              ModulesScreen(viewModel { ModulesViewModel(container) }, onBack = back, onOpen = { nav.navigate(Routes.module(it)) })
          }
          composable(Routes.MODULE, arguments = idArgument) { entry ->
              ModuleDetailScreen(viewModel { ModulesViewModel(container) }, entry.arguments?.getString("id").orEmpty(), onBack = back)
          }
          composable(Routes.NOTES) {
              NotesScreen(viewModel { NotesViewModel(container.notes) }, onBack = back, onOpen = { nav.navigate(Routes.note(it)) })
          }
          composable(Routes.NOTE, arguments = idArgument) { entry ->
              val noteId = entry.arguments?.getString("id").orEmpty()
              NoteEditorScreen(viewModel { NoteEditorViewModel(container.notes, noteId) }, onBack = back)
          }
          composable(Routes.AUDIT) { AuditScreen(container.audit, onBack = back) }
      }
      PromptHost(container.prompts)
    `,
  });
}

function prompts(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/Prompts.kt`, { doc: 'questions a turn asks the user' });
  f.use('androidx.compose.material.icons.filled.Warning', 'androidx.compose.material.icons.filled.Lock', 'androidx.compose.foundation.layout.height');

  f.fn('PromptHost', {
    annotations: ['Composable'],
    doc: 'Shows whatever the prompt broker is asking, over any screen. Dismissing a dialog is a no.',
    params: [{ name: 'broker', type: 'PromptBroker' }],
    code: kt`
      val prompt by broker.pending.collectAsStateWithLifecycle()
      when (val current = prompt) {
          is PendingPrompt.CloudSend -> CloudApprovalDialog(current.disclosure) { current.reply.complete(it) }
          is PendingPrompt.Confirm -> ConfirmActionDialog(current.request) { current.reply.complete(it) }
          null -> Unit
      }
    `,
  });

  f.fn('CloudApprovalDialog', {
    annotations: ['Composable'],
    doc: 'Exactly what would leave the device, and to whom, before anything does.',
    params: [
      { name: 'disclosure', type: 'ContextDisclosure' },
      { name: 'onAnswer', type: '(CloudApproval) -> Void' },
    ],
    code: kt`
      AlertDialog(
          onDismissRequest = { onAnswer(CloudApproval.DENY) },
          icon = { Icon(Icons.Filled.Warning, contentDescription = null) },
          title = { Text("Send to " + disclosure.providerName + "?") },
          text = {
              Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                  Text("This reply needs a cloud model. Nothing has been sent yet.")
                  Fact("Model", disclosure.modelName)
                  Fact("Messages", disclosure.messageCount.toString())
                  Fact("Size", String.format(Locale.getDefault(), "%,d characters, about %,d tokens", disclosure.characterCount, disclosure.estimatedTokens))
                  if (disclosure.excludedOlderMessages > 0) Fact("Left out", disclosure.excludedOlderMessages.toString() + " older messages")
                  if (disclosure.includesToolResults) Fact("Includes", "results from tools")
                  if (disclosure.toolNames.isNotEmpty()) Fact("Tools offered", disclosure.toolNames.joinToString(", "))
              }
          },
          confirmButton = {
              Column(horizontalAlignment = Alignment.End) {
                  TextButton(onClick = { onAnswer(CloudApproval.ALLOW_ONCE) }) { Text("Send this time") }
                  TextButton(onClick = { onAnswer(CloudApproval.ALLOW_FOR_CONVERSATION) }) { Text("Allow for this conversation") }
              }
          },
          dismissButton = { TextButton(onClick = { onAnswer(CloudApproval.DENY) }) { Text("Don't send") } },
      )
    `,
  });

  f.fn('ConfirmActionDialog', {
    annotations: ['Composable'],
    doc: 'A tool the model wants to run that changes something: what, and with which arguments.',
    params: [
      { name: 'request', type: 'ConfirmationRequest' },
      { name: 'onAnswer', type: '(bool) -> Void' },
    ],
    code: kt`
      AlertDialog(
          onDismissRequest = { onAnswer(false) },
          icon = { Icon(Icons.Filled.Lock, contentDescription = null) },
          title = { Text(request.tool.title + "?") },
          text = {
              Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                  Text(request.tool.description)
                  Text(riskLabel(request.tool.risk), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                  Spacer(Modifier.height(4.dp))
                  for ((name, value) in request.arguments) {
                      Fact(name, (value as? JsonPrimitive)?.contentOrNull ?: value.toString())
                  }
              }
          },
          confirmButton = { TextButton(onClick = { onAnswer(true) }) { Text("Allow") } },
          dismissButton = { TextButton(onClick = { onAnswer(false) }) { Text("Deny") } },
      )
    `,
  });

  f.fn('Fact', {
    annotations: ['Composable'],
    visibility: 'private',
    doc: 'A labelled value.',
    params: [
      { name: 'label', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    code: kt`
      Column {
          Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Text(value, style = MaterialTheme.typography.bodyMedium)
      }
    `,
  });
}

function common(ctx: Ctx): void {
  const f = new KtFile(ctx, `${UI}/Common.kt`, { doc: 'shared components and formatting' });
  f.use(
    'androidx.compose.material.icons.automirrored.filled.ArrowBack',
    'androidx.compose.material.icons.filled.Add',
    'androidx.compose.foundation.layout.padding',
    'androidx.compose.foundation.layout.width',
    'androidx.compose.foundation.layout.RowScope',
    'android.text.format.DateUtils',
  );

  f.fn('DrakenTopBar', {
    annotations: ['Composable', 'OptIn(ExperimentalMaterial3Api::class)'],
    doc: 'The top bar every screen uses: a title, an optional way back, and actions.',
    params: [
      { name: 'title', type: 'string' },
      { name: 'onBack', type: 'Option<() -> Void>', default: 'null' },
      { name: 'actions', type: '@Composable RowScope.() -> Unit', default: '{}' },
    ],
    code: kt`
      TopAppBar(
          title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
          navigationIcon = {
              if (onBack != null) {
                  IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
              }
          },
          actions = actions,
      )
    `,
  });

  f.fn('AddButton', {
    annotations: ['Composable'],
    doc: 'The main add action of a screen. Its label is part of the button, so a screen reader announces "New chat, button" - the icon-and-text overload leaves the button unlabelled.',
    params: [
      { name: 'label', type: 'string' },
      { name: 'onClick', type: '() -> Void' },
    ],
    code: kt`
      ExtendedFloatingActionButton(onClick = onClick) {
          Icon(Icons.Filled.Add, contentDescription = null)
          Spacer(Modifier.width(12.dp))
          Text(label)
      }
    `,
  });

  f.fn('EmptyState', {
    annotations: ['Composable'],
    doc: 'What a screen shows when there is nothing to list yet, and what to do about it.',
    params: [
      { name: 'title', type: 'string' },
      { name: 'body', type: 'string' },
      { name: 'modifier', type: 'Modifier', default: 'Modifier' },
    ],
    code: kt`
      Column(modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
          Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
      }
    `,
  });

  f.fn('SectionHeader', {
    annotations: ['Composable'],
    doc: 'A heading between groups of a list.',
    params: [{ name: 'text', type: 'string' }],
    code: kt`
      Text(
          text,
          style = MaterialTheme.typography.titleSmall,
          color = MaterialTheme.colorScheme.primary,
          modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp).semantics { heading() },
      )
    `,
  });

  f.fn('Loading', {
    annotations: ['Composable'],
    doc: 'A screen whose data has not arrived yet.',
    params: [{ name: 'modifier', type: 'Modifier', default: 'Modifier' }],
    code: kt`
      Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
    `,
  });

  f.fn('riskLabel', {
    doc: 'A risk level in words.',
    params: [{ name: 'risk', type: 'RiskLevel' }],
    returns: 'string',
    expression: true,
    code: kt`
      when (risk) {
          RiskLevel.READ -> "Reads your data"
          RiskLevel.WRITE -> "Changes your data"
          RiskLevel.DESTRUCTIVE -> "Deletes your data"
          RiskLevel.EXTERNAL -> "Reaches outside this device"
      }
    `,
  });

  f.fn('formatSize', {
    doc: 'A byte count for people: megabytes below a gigabyte, gigabytes above.',
    params: [{ name: 'bytes', type: 'i64' }],
    returns: 'string',
    expression: true,
    code: kt`
      if (bytes >= 1_000_000_000L) String.format(Locale.getDefault(), "%.1f GB", bytes / 1e9) else String.format(Locale.getDefault(), "%d MB", bytes / 1_000_000L)
    `,
  });

  f.fn('formatWhen', {
    doc: 'A time relative to now, such as "5 minutes ago".',
    params: [{ name: 'millis', type: 'i64' }],
    returns: 'string',
    expression: true,
    code: kt`DateUtils.getRelativeTimeSpanString(millis, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()`,
  });
}
