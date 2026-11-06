/**
 * Library names Draken's Kotlin uses, by simple name.
 *
 * The import wiring in kit.ts looks names up here. `extension` marks Kotlin
 * extension functions and properties - called after a dot, so the scanner only
 * matches them there; `alsoBare` covers the few also called without a receiver
 * inside a scope (`launch` inside a coroutine scope, `padding` never).
 *
 * The table is deliberately explicit rather than a wildcard import of whole
 * packages: an unused or ambiguous import is then something the audit can name.
 */

export interface LibraryName {
  fqn: string;
  extension?: boolean;
  alsoBare?: boolean;
  /**
   * Never imported automatically. `map`, `add`, `first` and the like are also
   * members of ordinary collections, so seeing the name proves nothing; a file
   * that needs the library version asks for it with `use()`.
   */
  manual?: boolean;
  /** Only files in this Gradle module may import it: the others do not have the library. */
  module?: string;
}

const plain = (pkg: string, ...names: string[]): [string, LibraryName][] =>
  names.map((n) => [n, { fqn: `${pkg}.${n}` }]);
const ext = (pkg: string, ...names: string[]): [string, LibraryName][] =>
  names.map((n) => [n, { fqn: `${pkg}.${n}`, extension: true }]);
const both = (pkg: string, ...names: string[]): [string, LibraryName][] =>
  names.map((n) => [n, { fqn: `${pkg}.${n}`, extension: true, alsoBare: true }]);
const manual = (pkg: string, ...names: string[]): [string, LibraryName][] =>
  names.map((n) => [n, { fqn: `${pkg}.${n}`, extension: true, manual: true }]);
/** Android and Compose names: real only in the app module. */
const app = (entries: [string, LibraryName][]): [string, LibraryName][] =>
  entries.map(([n, l]) => [n, { ...l, module: 'app' }]);

export const LIBRARY_NAMES: Record<string, LibraryName> = Object.fromEntries([
  // kotlinx.coroutines
  ...plain('kotlinx.coroutines', 'CancellationException', 'CoroutineDispatcher', 'CoroutineScope', 'Dispatchers', 'Job',
    'SupervisorJob', 'TimeoutCancellationException', 'delay', 'withContext', 'withTimeout',
    'withTimeoutOrNull', 'coroutineScope', 'currentCoroutineContext', 'suspendCancellableCoroutine',
    'CompletableDeferred', 'runBlocking'),
  ...both('kotlinx.coroutines', 'launch', 'async', 'ensureActive'),
  ...ext('kotlinx.coroutines', 'cancelAndJoin'),
  ...manual('kotlinx.coroutines', 'cancel', 'job', 'isActive', 'await'),
  ...plain('kotlinx.coroutines.flow', 'Flow', 'FlowCollector', 'MutableStateFlow', 'StateFlow', 'MutableSharedFlow',
    'SharedFlow', 'SharingStarted', 'flow', 'flowOf', 'emptyFlow', 'channelFlow', 'callbackFlow', 'combine'),
  ...ext('kotlinx.coroutines.flow', 'asStateFlow', 'asSharedFlow', 'onCompletion', 'flowOn', 'stateIn', 'launchIn',
    'distinctUntilChanged', 'flatMapLatest', 'mapLatest', 'onStart', 'cancellable', 'retryWhen'),
  ...manual('kotlinx.coroutines.flow', 'collect', 'catch', 'onEach', 'map', 'filter', 'first', 'firstOrNull', 'toList',
    'update', 'transform', 'takeWhile', 'single'),
  ...plain('kotlinx.coroutines.channels', 'Channel', 'SendChannel', 'awaitClose'),
  ...plain('kotlinx.coroutines', 'NonCancellable', 'awaitCancellation'),
  ...plain('kotlinx.coroutines.sync', 'Mutex'),
  ...ext('kotlinx.coroutines.sync', 'withLock'),
  ...plain('kotlinx.coroutines.test', 'runTest', 'StandardTestDispatcher', 'UnconfinedTestDispatcher', 'TestScope'),
  ...ext('kotlinx.coroutines.test', 'advanceUntilIdle', 'advanceTimeBy', 'runCurrent'),

  // kotlinx.serialization
  ...plain('kotlinx.serialization', 'Serializable', 'SerialName', 'Transient', 'SerializationException'),
  ...ext('kotlinx.serialization', 'encodeToString', 'decodeFromString'),
  ...plain('kotlinx.serialization.json', 'Json', 'JsonElement', 'JsonObject', 'JsonArray', 'JsonPrimitive', 'JsonNull',
    'buildJsonObject', 'buildJsonArray', 'JsonObjectBuilder', 'JsonArrayBuilder'),
  ...ext('kotlinx.serialization.json', 'jsonObject', 'jsonArray', 'jsonPrimitive', 'contentOrNull', 'intOrNull',
    'longOrNull', 'doubleOrNull', 'booleanOrNull'),
  // Builder functions, called on the implicit receiver inside buildJsonObject { }.
  ...both('kotlinx.serialization.json', 'putJsonObject', 'putJsonArray', 'addJsonObject', 'addJsonArray'),
  ...manual('kotlinx.serialization.json', 'put', 'add', 'boolean', 'int', 'long', 'double', 'content'),

  // OkHttp
  ...plain('okhttp3', 'OkHttpClient', 'Request', 'Response', 'Call', 'Headers', 'MediaType', 'RequestBody'),
  ...ext('okhttp3.MediaType.Companion', 'toMediaType'),
  ...ext('okhttp3.RequestBody.Companion', 'toRequestBody'),
  ...plain('mockwebserver3', 'MockWebServer', 'MockResponse', 'RecordedRequest'),

  // JUnit
  ...plain('org.junit', 'Test', 'Before', 'After', 'Rule', 'Ignore', 'Assume'),
  ...plain('org.junit.Assert', 'assertEquals', 'assertNotEquals', 'assertTrue', 'assertFalse', 'assertNull',
    'assertNotNull', 'assertSame', 'assertThrows', 'fail'),
  ...plain('org.junit.runner', 'RunWith'),

  // JDK
  ...plain('java.io', 'IOException', 'InterruptedIOException', 'File', 'FileInputStream', 'FileOutputStream'),
  ...plain('java.nio.file', 'Files'),
  ...plain('java.security', 'MessageDigest', 'SecureRandom'),
  ...plain('java.net', 'SocketTimeoutException', 'UnknownHostException', 'URI'),
  ...plain('java.time', 'Duration', 'Instant'),
  ...plain('java.util', 'UUID', 'Locale'),
  ...plain('java.util.concurrent', 'TimeUnit', 'ConcurrentHashMap'),
  ...plain('java.util.concurrent.atomic', 'AtomicInteger', 'AtomicLong', 'AtomicBoolean', 'AtomicReference'),

  // Android and Jetpack. Common words that are also members of ordinary types
  // (`size`, `padding`, `items`, `background`) are manual: a file asks for them.
  ...app([
    ...plain('android.os', 'Build', 'Bundle'),
    ...plain('android.net', 'Uri'),
    ...plain('androidx.activity', 'ComponentActivity'),
    ...both('androidx.activity', 'enableEdgeToEdge'),
    ...both('androidx.activity.compose', 'setContent'),
    ...plain('androidx.activity.compose', 'rememberLauncherForActivityResult', 'BackHandler'),
    ...plain('androidx.activity.result.contract', 'ActivityResultContracts'),
    ...plain('androidx.lifecycle', 'ViewModel'),
    ...both('androidx.lifecycle', 'viewModelScope'),
    ...ext('androidx.lifecycle.compose', 'collectAsStateWithLifecycle'),
    ...plain('androidx.lifecycle.viewmodel.compose', 'viewModel'),
    ...plain('androidx.navigation', 'NavHostController', 'NavType', 'navArgument'),
    ...plain('androidx.navigation.compose', 'NavHost', 'rememberNavController'),
    ...both('androidx.navigation.compose', 'composable'),
    ...plain('androidx.compose.runtime', 'Composable', 'remember', 'mutableStateOf', 'mutableIntStateOf', 'mutableLongStateOf',
      'LaunchedEffect', 'DisposableEffect', 'rememberCoroutineScope', 'derivedStateOf', 'Immutable', 'Stable',
      'CompositionLocalProvider', 'staticCompositionLocalOf'),
    ...plain('androidx.compose.runtime.saveable', 'rememberSaveable'),
    ...plain('androidx.compose.foundation', 'Image', 'BorderStroke', 'rememberScrollState', 'ExperimentalFoundationApi', 'isSystemInDarkTheme'),
    ...ext('androidx.compose.foundation', 'clickable', 'verticalScroll', 'horizontalScroll', 'combinedClickable'),
    ...manual('androidx.compose.foundation', 'background', 'border'),
    ...plain('androidx.compose.foundation.layout', 'Arrangement', 'Box', 'Column', 'Row', 'Spacer', 'PaddingValues',
      'FlowRow', 'WindowInsets', 'ExperimentalLayoutApi'),
    ...ext('androidx.compose.foundation.layout', 'fillMaxWidth', 'fillMaxSize', 'fillMaxHeight', 'imePadding',
      'navigationBarsPadding', 'statusBarsPadding', 'heightIn', 'widthIn', 'defaultMinSize', 'wrapContentHeight'),
    ...manual('androidx.compose.foundation.layout', 'padding', 'size', 'width', 'height'),
    ...plain('androidx.compose.foundation.lazy', 'LazyColumn', 'LazyRow', 'rememberLazyListState'),
    ...manual('androidx.compose.foundation.lazy', 'items', 'itemsIndexed'),
    ...plain('androidx.compose.foundation.shape', 'RoundedCornerShape', 'CircleShape'),
    ...plain('androidx.compose.foundation.text', 'KeyboardOptions', 'KeyboardActions'),
    ...plain('androidx.compose.foundation.text.selection', 'SelectionContainer'),
    ...plain('androidx.compose.material3', 'MaterialTheme', 'Scaffold', 'Text', 'TopAppBar', 'Icon', 'IconButton', 'Button',
      'TextButton', 'OutlinedButton', 'FilledTonalButton', 'OutlinedTextField', 'TextField', 'AlertDialog', 'Switch',
      'RadioButton', 'Checkbox', 'ListItem', 'HorizontalDivider', 'Card', 'ElevatedCard', 'OutlinedCard', 'Surface',
      'LinearProgressIndicator', 'CircularProgressIndicator', 'FloatingActionButton', 'ExtendedFloatingActionButton',
      'SnackbarHost', 'SnackbarHostState', 'DropdownMenu', 'DropdownMenuItem', 'ExperimentalMaterial3Api',
      'lightColorScheme', 'darkColorScheme', 'dynamicLightColorScheme', 'dynamicDarkColorScheme', 'ColorScheme',
      'Typography', 'CardDefaults', 'TopAppBarDefaults', 'ButtonDefaults', 'ListItemDefaults', 'AssistChip',
      'SuggestionChip', 'FilterChip', 'Badge', 'LocalContentColor', 'ProvideTextStyle'),
    ...plain('androidx.compose.material.icons', 'Icons'),
    ...plain('androidx.compose.ui', 'Modifier', 'Alignment'),
    ...ext('androidx.compose.ui.draw', 'clip'),
    ...plain('androidx.compose.ui.graphics', 'Color'),
    ...plain('androidx.compose.ui.platform', 'LocalContext', 'LocalClipboardManager', 'LocalFocusManager'),
    ...ext('androidx.compose.ui.platform', 'testTag'),
    ...ext('androidx.compose.ui.semantics', 'semantics'),
    ...plain('androidx.compose.ui.semantics', 'heading', 'contentDescription', 'stateDescription', 'liveRegion', 'LiveRegionMode'),
    ...plain('androidx.compose.ui.text', 'TextStyle', 'AnnotatedString'),
    ...plain('androidx.compose.ui.text.font', 'FontWeight', 'FontFamily'),
    ...plain('androidx.compose.ui.text.input', 'PasswordVisualTransformation', 'KeyboardType', 'ImeAction',
      'KeyboardCapitalization', 'VisualTransformation'),
    ...plain('androidx.compose.ui.text.style', 'TextOverflow', 'TextAlign'),
    ...ext('androidx.compose.ui.unit', 'dp', 'sp'),
    ...plain('androidx.compose.ui.tooling.preview', 'Preview'),
  ]),
].map(([k, v]) => [k, v] as [string, LibraryName]));
