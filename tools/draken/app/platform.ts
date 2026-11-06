/**
 * The app's platform layer: credentials, settings, Android adapters, the
 * provider directory, the prompt broker, model downloads, and the container
 * that wires them together.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'app/src/main/kotlin/com/draken/app';

export function buildPlatform(ctx: Ctx): void {
  credentials(ctx);
  settings(ctx);
  android(ctx);
  directory(ctx);
  prompts(ctx);
  downloads(ctx);
  container(ctx);
}

function credentials(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/security/Credentials.kt`, { doc: 'encrypted provider keys' });
  f.use('java.security.KeyStore', 'javax.crypto.Cipher', 'javax.crypto.KeyGenerator', 'javax.crypto.SecretKey', 'javax.crypto.spec.GCMParameterSpec',
    'android.security.keystore.KeyGenParameterSpec', 'android.security.keystore.KeyProperties', 'kotlinx.coroutines.flow.map');

  f.iface(
    'SecretCipher',
    [
      { name: 'encrypt', params: [{ name: 'plaintext', type: 'bytes' }], returns: 'bytes', doc: 'Encrypt; the result carries whatever it needs to be decrypted.' },
      { name: 'decrypt', params: [{ name: 'ciphertext', type: 'bytes' }], returns: 'bytes', doc: 'Decrypt; throws if the data was tampered with or the key is gone.' },
    ],
    { doc: 'Encryption for secrets at rest.' },
  );

  f.cls('KeystoreSecretCipher', {
    doc: 'AES-256-GCM under a key held in the Android Keystore. The key never leaves the Keystore and cannot be exported, so a copied database file cannot be decrypted elsewhere. Each value gets a fresh IV, stored in front of it.',
    implements: ['SecretCipher'],
    fields: [{ name: 'alias', type: 'string', visibility: 'private' }],
    ctor: [{ name: 'alias', type: 'string', default: '"draken.secrets"' }],
  });
  f.fn('encrypt', { of: 'KeystoreSecretCipher', override: true, doc: 'IV followed by ciphertext and tag.', params: [{ name: 'plaintext', type: 'bytes' }], returns: 'bytes', code: kt`
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    return cipher.iv + cipher.doFinal(plaintext)
  ` });
  f.fn('decrypt', { of: 'KeystoreSecretCipher', override: true, doc: 'Split off the IV and decrypt; GCM rejects anything altered.', params: [{ name: 'ciphertext', type: 'bytes' }], returns: 'bytes', code: kt`
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, ciphertext, 0, IV_BYTES))
    return cipher.doFinal(ciphertext, IV_BYTES, ciphertext.size - IV_BYTES)
  ` });
  f.fn('key', { of: 'KeystoreSecretCipher', visibility: 'private', annotations: ['Synchronized'], doc: 'The Keystore key, created on first use.', returns: 'SecretKey', code: kt`
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build(),
    )
    return generator.generateKey()
  ` });
  f.decl(
    kt`
      private const val TRANSFORMATION = "AES/GCM/NoPadding"
      private const val IV_BYTES = 12
    `,
    { doc: 'Cipher parameters.' },
  );

  f.cls('EncryptedCredentialStore', {
    doc: 'Provider API keys, encrypted at rest. Reads decrypt on demand and keep nothing in memory longer than a request; the interface only ever sees whether a key exists and its last four characters.',
    implements: ['CredentialSource'],
    fields: [
      { name: 'dao', type: 'SecretDao', visibility: 'private' },
      { name: 'cipher', type: 'SecretCipher', visibility: 'private' },
      { name: 'audit', type: 'AuditLog', visibility: 'private' },
      { name: 'clock', type: '() -> i64', visibility: 'private' },
    ],
    ctor: [
      { name: 'dao', type: 'SecretDao' },
      { name: 'cipher', type: 'SecretCipher' },
      { name: 'audit', type: 'AuditLog' },
      { name: 'clock', type: '() -> i64', default: '{ System.currentTimeMillis() }' },
    ],
  });
  const E = 'EncryptedCredentialStore';
  f.fn('apiKey', { of: E, override: true, doc: 'The decrypted key, or null when there is none or it can no longer be decrypted (the Keystore key was reset).', params: [{ name: 'providerId', type: 'string' }], returns: 'Option<string>', code: kt`
    val secret = dao.find(secretName(providerId)) ?: return null
    return runCatching { String(cipher.decrypt(secret.ciphertext), Charsets.UTF_8) }.getOrNull()
  ` });
  f.fn('save', { of: E, suspend: true, doc: 'Encrypt and store a key, replacing any earlier one. Audited without the key.', params: [{ name: 'providerId', type: 'string' }, { name: 'apiKey', type: 'string' }], code: kt`
    val key = apiKey.trim()
    require(key.isNotEmpty()) { "an API key cannot be empty" }
    dao.upsert(SecretEntity(secretName(providerId), cipher.encrypt(key.toByteArray(Charsets.UTF_8)), key.takeLast(4), clock()))
    audit.record(AuditEvent(clock(), AuditCategory.CREDENTIAL_CHANGE, providerId, "saved"))
  ` });
  f.fn('remove', { of: E, suspend: true, doc: 'Forget a key. Audited.', params: [{ name: 'providerId', type: 'string' }], code: kt`
    dao.delete(secretName(providerId))
    audit.record(AuditEvent(clock(), AuditCategory.CREDENTIAL_CHANGE, providerId, "removed"))
  ` });
  f.fn('observeHints', { of: E, doc: 'Which providers have a key, with its last four characters, live.', returns: 'Flow<Map<string, string>>', expression: true, code: kt`
    dao.observeHints().map { list -> list.filter { it.name.startsWith(PROVIDER_PREFIX) }.associate { it.name.removePrefix(PROVIDER_PREFIX) to it.hint } }
  ` });
  f.decl(
    kt`
      private const val PROVIDER_PREFIX = "provider:"

      private fun secretName(providerId: String) = PROVIDER_PREFIX + providerId
    `,
    { doc: 'How provider keys are named.' },
  );
}

function settings(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/settings/AppSettings.kt`, { doc: 'user settings' });
  f.use(
    'androidx.datastore.core.DataStore', 'androidx.datastore.preferences.core.Preferences', 'androidx.datastore.preferences.core.edit',
    'androidx.datastore.preferences.core.booleanPreferencesKey', 'androidx.datastore.preferences.core.longPreferencesKey',
    'androidx.datastore.preferences.core.stringPreferencesKey', 'androidx.datastore.preferences.preferencesDataStore',
    'android.content.Context', 'kotlinx.coroutines.flow.map', 'kotlinx.coroutines.flow.first',
  );

  f.decl(
    kt`
      /** The app's preferences file. */
      val Context.drakenSettings: DataStore<Preferences> by preferencesDataStore(name = "settings")

      private val MODE = stringPreferencesKey("routing_mode")
      private val PREFER_LOCAL = booleanPreferencesKey("prefer_local")
      private val PREFERRED_CLOUD = stringPreferencesKey("preferred_cloud")
      private val PREFERRED_LOCAL = stringPreferencesKey("preferred_local")
      private val DAILY_BUDGET = longPreferencesKey("daily_cloud_budget")
      private val CUSTOM_URL = stringPreferencesKey("custom_endpoint_url")
      private val CUSTOM_MODEL = stringPreferencesKey("custom_endpoint_model")
      private val SEEDED = booleanPreferencesKey("built_in_modules_seeded")

      private fun encode(choice: ModelChoice?) = choice?.let { it.providerId + "\n" + it.modelId }

      private fun decode(value: String?) = value?.split('\n')?.takeIf { it.size == 2 }?.let { ModelChoice(it[0], it[1]) }
    `,
    { doc: 'The preferences file and its keys.', extensions: ['drakenSettings'] },
  );

  f.record(
    'CustomEndpoint',
    [
      { name: 'baseUrl', type: 'string' },
      { name: 'modelId', type: 'string' },
    ],
    { doc: 'A self-hosted OpenAI-compatible server - Ollama, LM Studio, vLLM - on the network.' },
  );

  f.cls('AppSettings', {
    doc: 'Routing preferences and provider configuration, in DataStore. Nothing secret is stored here: keys live encrypted in the database.',
    fields: [{ name: 'store', type: 'DataStore<Preferences>', visibility: 'private' }],
    ctor: [{ name: 'store', type: 'DataStore<Preferences>' }],
  });
  const S = 'AppSettings';
  f.fn('routing', { of: S, doc: 'Routing preferences, live. ASK_BEFORE_CLOUD until the user chooses otherwise.', returns: 'Flow<RoutingPreferences>', expression: true, code: kt`
    store.data.map { prefs ->
        RoutingPreferences(
            prefs[MODE]?.let { runCatching { RoutingMode.valueOf(it) }.getOrNull() } ?: RoutingMode.ASK_BEFORE_CLOUD,
            prefs[PREFER_LOCAL] ?: true,
            decode(prefs[PREFERRED_CLOUD]),
            decode(prefs[PREFERRED_LOCAL]),
            prefs[DAILY_BUDGET],
        )
    }
  ` });
  f.fn('customEndpoint', { of: S, doc: 'The self-hosted endpoint, if one is set, live.', returns: 'Flow<Option<CustomEndpoint>>', expression: true, code: kt`
    store.data.map { prefs ->
        val url = prefs[CUSTOM_URL]
        val model = prefs[CUSTOM_MODEL]
        if (url.isNullOrBlank() || model.isNullOrBlank()) null else CustomEndpoint(url, model)
    }
  ` });
  f.fn('setMode', { of: S, suspend: true, doc: 'Set the routing mode.', params: [{ name: 'mode', type: 'RoutingMode' }], code: kt`store.edit { it[MODE] = mode.name }` });
  f.fn('setPreferLocal', { of: S, suspend: true, doc: 'Prefer on-device models when they can do the task.', params: [{ name: 'prefer', type: 'bool' }], code: kt`store.edit { it[PREFER_LOCAL] = prefer }` });
  f.fn('setPreferredCloud', { of: S, suspend: true, doc: 'The cloud model to use when one is used.', params: [{ name: 'choice', type: 'Option<ModelChoice>' }], code: kt`
    store.edit { prefs -> encode(choice)?.let { prefs[PREFERRED_CLOUD] = it } ?: prefs.remove(PREFERRED_CLOUD) }
  ` });
  f.fn('setPreferredLocal', { of: S, suspend: true, doc: 'The on-device model to use.', params: [{ name: 'choice', type: 'Option<ModelChoice>' }], code: kt`
    store.edit { prefs -> encode(choice)?.let { prefs[PREFERRED_LOCAL] = it } ?: prefs.remove(PREFERRED_LOCAL) }
  ` });
  f.fn('setDailyBudget', { of: S, suspend: true, doc: 'The AUTOMATIC cloud budget in tokens a day; null for none.', params: [{ name: 'tokens', type: 'Option<i64>' }], code: kt`
    store.edit { prefs -> if (tokens == null) prefs.remove(DAILY_BUDGET) else prefs[DAILY_BUDGET] = tokens }
  ` });
  f.fn('setCustomEndpoint', { of: S, suspend: true, doc: 'Set or clear the self-hosted endpoint.', params: [{ name: 'endpoint', type: 'Option<CustomEndpoint>' }], code: kt`
    store.edit { prefs ->
        if (endpoint == null) {
            prefs.remove(CUSTOM_URL)
            prefs.remove(CUSTOM_MODEL)
        } else {
            prefs[CUSTOM_URL] = endpoint.baseUrl.trim()
            prefs[CUSTOM_MODEL] = endpoint.modelId.trim()
        }
    }
  ` });
  f.fn('builtInsSeeded', { of: S, suspend: true, doc: 'Whether first-run setup has granted the built-in modules their defaults.', returns: 'bool', expression: true, code: kt`store.data.first()[SEEDED] == true` });
  f.fn('markBuiltInsSeeded', { of: S, suspend: true, doc: 'Record that first-run setup ran, so a later revocation is never undone.', code: kt`store.edit { it[SEEDED] = true }` });
}

function android(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/platform/AndroidPlatform.kt`, { doc: 'Android implementations of platform contracts' });
  f.use('android.app.ActivityManager', 'android.content.Context', 'android.content.pm.PackageManager', 'androidx.core.content.ContextCompat');

  f.cls('AndroidDeviceProfile', {
    doc: 'Device memory, from ActivityManager.',
    implements: ['DeviceProfile'],
    fields: [{ name: 'context', type: 'Context', visibility: 'private' }],
    ctor: [{ name: 'context', type: 'Context' }],
  });
  f.fn('totalMemoryBytes', { of: 'AndroidDeviceProfile', override: true, doc: 'Total RAM.', returns: 'i64', code: kt`
    val info = ActivityManager.MemoryInfo()
    context.getSystemService(ActivityManager::class.java).getMemoryInfo(info)
    return info.totalMem
  ` });

  f.cls('AndroidPlatformPermissions', {
    doc: 'Runtime permissions as Android currently grants them - asked every time, since the user can revoke one in system settings at any moment.',
    implements: ['PlatformPermissions'],
    fields: [{ name: 'context', type: 'Context', visibility: 'private' }],
    ctor: [{ name: 'context', type: 'Context' }],
  });
  f.fn('isGranted', { of: 'AndroidPlatformPermissions', override: true, doc: 'Whether Android grants the permission now.', params: [{ name: 'permission', type: 'string' }], returns: 'bool', expression: true, code: kt`
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
  ` });
}

function directory(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/providers/AppProviderDirectory.kt`, { doc: 'the providers the app offers routing' });
  f.use('kotlinx.coroutines.flow.first');

  f.decl(
    kt`
      /** The id of the self-hosted OpenAI-compatible provider. */
      const val CUSTOM_PROVIDER_ID = "custom"
    `,
    { doc: 'Self-hosted provider id.', provides: ['CUSTOM_PROVIDER_ID'] },
  );

  f.cls('AppProviderDirectory', {
    doc: 'Every model routing may use: the built-in cloud providers (usable once they have a key), a self-hosted endpoint if one is set, and installed on-device models this device can run.',
    implements: ['ProviderDirectory'],
    fields: [
      { name: 'credentials', type: 'EncryptedCredentialStore', visibility: 'private' },
      { name: 'settings', type: 'AppSettings', visibility: 'private' },
      { name: 'usage', type: 'UsageMeter', visibility: 'private' },
      { name: 'local', type: 'LiteRtLmProvider', visibility: 'private' },
      { name: 'transport', type: 'HttpTransport', visibility: 'private' },
      { name: 'cloud', type: 'Map<string, ModelProvider>', default: 'builtInCloudProviders().associate { it.id to cloudProvider(it, credentials, transport) }' },
      // Written by a turn's candidates() and read by its provider(); turns run on different threads.
      { name: 'custom', type: 'Option<Pair<CustomEndpoint, ModelProvider>>', default: 'null', readonly: false, visibility: 'private', annotations: ['Volatile'] },
    ],
    ctor: [
      { name: 'credentials', type: 'EncryptedCredentialStore' },
      { name: 'settings', type: 'AppSettings' },
      { name: 'usage', type: 'UsageMeter' },
      { name: 'local', type: 'LiteRtLmProvider' },
      { name: 'transport', type: 'HttpTransport' },
    ],
  });
  const D = 'AppProviderDirectory';
  f.fn('candidates', { of: D, override: true, suspend: true, doc: 'Every model, with whether it can be used now and why not.', returns: 'List<RouteCandidate>', code: kt`
    val out = mutableListOf<RouteCandidate>()
    for (provider in cloud.values) {
        val descriptor = provider.descriptor()
        val ready = credentials.apiKey(descriptor.id) != null
        for (model in provider.models()) {
            out.add(RouteCandidate(model, ProviderKind.CLOUD, ready, if (ready) null else "Add an API key for " + descriptor.displayName + " in Settings."))
        }
    }
    customProvider()?.let { provider -> provider.models().forEach { out.add(RouteCandidate(it, ProviderKind.CLOUD, true)) } }
    local.models().forEach { out.add(RouteCandidate(it, ProviderKind.LOCAL, true)) }
    return out
  ` });
  f.fn('provider', { of: D, override: true, doc: 'A provider by id.', params: [{ name: 'providerId', type: 'string' }], returns: 'Option<ModelProvider>', expression: true, code: kt`
    when (providerId) {
        LOCAL_PROVIDER_ID -> local
        CUSTOM_PROVIDER_ID -> custom?.second
        else -> cloud[providerId]
    }
  ` });
  f.fn('preferences', { of: D, override: true, suspend: true, doc: 'Current routing preferences.', returns: 'RoutingPreferences', expression: true, code: kt`settings.routing().first()` });
  f.fn('cloudTokensToday', { of: D, override: true, suspend: true, doc: 'Cloud tokens used today.', returns: 'i64', expression: true, code: kt`usage.tokensToday()` });
  f.fn('recordCloudUsage', { of: D, override: true, suspend: true, doc: 'Count a cloud request\'s tokens.', params: [{ name: 'providerId', type: 'string' }, { name: 'tokens', type: 'i64' }], code: kt`usage.record(providerId, tokens)` });
  f.fn('customProvider', { of: D, visibility: 'private', suspend: true, doc: 'The self-hosted provider for the current endpoint setting, rebuilt when the setting changes.', returns: 'Option<ModelProvider>', code: kt`
    val endpoint = settings.customEndpoint().first()
    if (endpoint == null) {
        custom = null
        return null
    }
    custom?.takeIf { it.first == endpoint }?.let { return it.second }
    val config = CloudProviderConfig(
        CUSTOM_PROVIDER_ID, "Self-hosted", ProviderFamily.OPENAI_COMPATIBLE, endpoint.baseUrl, endpoint.modelId,
        listOf(ModelDescriptor(CUSTOM_PROVIDER_ID, endpoint.modelId, endpoint.modelId, assumedCapabilities())),
    )
    val provider = ChatCompletionsProvider(config, credentials, transport)
    custom = endpoint to provider
    return provider
  ` });

  f.fn('cloudProvider', {
    doc: 'The adapter for a cloud provider\'s family.',
    params: [
      { name: 'config', type: 'CloudProviderConfig' },
      { name: 'credentials', type: 'CredentialSource' },
      { name: 'transport', type: 'HttpTransport' },
    ],
    returns: 'ModelProvider',
    expression: true,
    code: kt`
      when (config.family) {
          ProviderFamily.ANTHROPIC -> AnthropicProvider(config, credentials)
          ProviderFamily.OPENAI -> OpenAiResponsesProvider(config, credentials, transport)
          ProviderFamily.GEMINI -> GeminiProvider(config, credentials, transport)
          ProviderFamily.DEEPSEEK, ProviderFamily.OPENAI_COMPATIBLE -> ChatCompletionsProvider(config, credentials, transport)
          ProviderFamily.ON_DEVICE -> error("an on-device provider is not a cloud provider")
      }
    `,
  });
}

function prompts(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/prompts/PromptBroker.kt`, { doc: 'asking the user, from deep inside a turn' });

  f.enm(
    'PendingPrompt',
    [
      {
        name: 'Confirm',
        payload: [
          { name: 'request', type: 'ConfirmationRequest' },
          { name: 'reply', type: 'CompletableDeferred<bool>' },
        ],
      },
      {
        name: 'CloudSend',
        payload: [
          { name: 'disclosure', type: 'ContextDisclosure' },
          { name: 'reply', type: 'CompletableDeferred<CloudApproval>' },
        ],
      },
    ],
    { doc: 'A question waiting for the user, with the channel its answer goes back on.' },
  );

  f.cls('PromptBroker', {
    doc: 'The confirmation and cloud-approval gates, as the interface sees them: a turn that needs an answer publishes a prompt and suspends until the user replies. One question at a time; cancelling the turn withdraws it.',
    implements: ['ConfirmationGate', 'CloudApprovalGate'],
    fields: [
      { name: 'lock', type: 'Mutex', default: 'Mutex()', visibility: 'private' },
      { name: 'current', type: 'MutableStateFlow<Option<PendingPrompt>>', default: 'MutableStateFlow(null)', visibility: 'private' },
      { name: 'pending', type: 'StateFlow<Option<PendingPrompt>>', default: 'current.asStateFlow()', doc: 'The question showing now, if any.' },
    ],
  });
  f.fn('confirm', { of: 'PromptBroker', override: true, suspend: true, doc: 'Ask before a consequential action.', params: [{ name: 'request', type: 'ConfirmationRequest' }], returns: 'bool', code: kt`
    val reply = CompletableDeferred<Boolean>()
    return ask(PendingPrompt.Confirm(request, reply), reply)
  ` });
  f.fn('approve', { of: 'PromptBroker', override: true, suspend: true, doc: 'Ask before content goes to a cloud model.', params: [{ name: 'disclosure', type: 'ContextDisclosure' }], returns: 'CloudApproval', code: kt`
    val reply = CompletableDeferred<CloudApproval>()
    return ask(PendingPrompt.CloudSend(disclosure, reply), reply)
  ` });
  f.fn('ask', {
    of: 'PromptBroker', visibility: 'private', suspend: true, generics: 'T',
    doc: 'Show a prompt for as long as its answer takes, and never longer: cancelling the turn clears it too.',
    params: [{ name: 'prompt', type: 'PendingPrompt' }, { name: 'reply', type: 'CompletableDeferred<T>' }],
    returns: 'T',
    code: kt`
      lock.withLock {
          current.value = prompt
          try {
              return reply.await()
          } finally {
              current.value = null
          }
      }
    `,
  });
}

function downloads(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/models/LocalModelDownloads.kt`, { doc: 'model downloads the interface can follow' });
  f.use('kotlinx.coroutines.flow.update', 'kotlinx.coroutines.flow.collect');

  f.record(
    'DownloadState',
    [
      { name: 'running', type: 'bool' },
      { name: 'progress', type: 'Option<DownloadProgress>', default: 'null' },
      { name: 'error', type: 'Option<string>', default: 'null' },
    ],
    { doc: 'Where one model\'s download stands.' },
  );

  f.cls('LocalModelDownloads', {
    doc: 'Downloads that outlive the screen that started them. They run in the application scope; if the process dies, the partial file stays and the next start resumes it.',
    fields: [
      { name: 'scope', type: 'CoroutineScope', visibility: 'private' },
      { name: 'downloader', type: 'ModelDownloader', visibility: 'private' },
      { name: 'store', type: 'LocalModelStore', visibility: 'private' },
      { name: 'provider', type: 'LiteRtLmProvider', visibility: 'private' },
      { name: 'jobs', type: 'MutableMap<string, Job>', default: 'java.util.concurrent.ConcurrentHashMap()', visibility: 'private' },
      { name: 'current', type: 'MutableStateFlow<Map<string, DownloadState>>', default: 'MutableStateFlow(emptyMap())', visibility: 'private' },
      { name: 'installedChanges', type: 'MutableStateFlow<i64>', default: 'MutableStateFlow(0L)', visibility: 'private' },
      { name: 'states', type: 'StateFlow<Map<string, DownloadState>>', default: 'current.asStateFlow()', doc: 'Every download\'s state, live.' },
      { name: 'installedVersion', type: 'StateFlow<i64>', default: 'installedChanges.asStateFlow()', doc: 'Bumped whenever the set of installed models changes.' },
    ],
    ctor: [
      { name: 'scope', type: 'CoroutineScope' },
      { name: 'downloader', type: 'ModelDownloader' },
      { name: 'store', type: 'LocalModelStore' },
      { name: 'provider', type: 'LiteRtLmProvider' },
    ],
  });
  const L = 'LocalModelDownloads';
  f.fn('start', { of: L, doc: 'Start or resume a download. Starting one already running does nothing.', params: [{ name: 'spec', type: 'LocalModelSpec' }], code: kt`
    if (jobs[spec.id]?.isActive == true) return
    jobs[spec.id] = scope.launch {
        set(spec.id, DownloadState(true))
        try {
            downloader.download(spec).collect { set(spec.id, DownloadState(true, it)) }
            set(spec.id, DownloadState(false, DownloadProgress(spec.sizeBytes, spec.sizeBytes)))
            installedChanges.update { it + 1 }
        } catch (failure: ModelDownloadException) {
            set(spec.id, DownloadState(false, error = failure.message))
        } finally {
            jobs.remove(spec.id)
        }
    }
  ` });
  f.fn('cancel', { of: L, doc: 'Stop a download, keeping what arrived for a later resume.', params: [{ name: 'spec', type: 'LocalModelSpec' }], code: kt`
    jobs.remove(spec.id)?.cancel()
    set(spec.id, DownloadState(false, progress = DownloadProgress(store.partialFileFor(spec).length(), spec.sizeBytes)))
  ` });
  f.fn('remove', { of: L, suspend: true, doc: 'Delete a model: stop any download, release the engine if it holds the model, then delete the files.', params: [{ name: 'spec', type: 'LocalModelSpec' }], code: kt`
    jobs.remove(spec.id)?.cancel()
    provider.close()
    store.remove(spec)
    current.update { it - spec.id }
    installedChanges.update { it + 1 }
  ` });
  f.fn('set', { of: L, visibility: 'private', doc: 'Record one download\'s state.', params: [{ name: 'id', type: 'string' }, { name: 'state', type: 'DownloadState' }], code: kt`current.update { it + (id to state) }` });
}

function container(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/AppContainer.kt`, { doc: 'wiring' });
  f.use('android.content.Context', 'android.app.Application');

  f.cls('AppContainer', {
    doc: 'Builds and holds the app\'s object graph. Plain constructor wiring: every dependency is visible here, in one place, and replaceable in a test.',
    fields: [
      { name: 'context', type: 'Context', visibility: 'private' },
      { name: 'scope', type: 'CoroutineScope', default: 'CoroutineScope(SupervisorJob() + Dispatchers.Default)', doc: 'Work that outlives a screen.' },
      { name: 'database', type: 'DrakenDatabase', default: 'openDrakenDatabase(context)' },
      { name: 'audit', type: 'RoomAuditLog', default: 'RoomAuditLog(database.audit())' },
      { name: 'conversations', type: 'RoomConversationStore', default: 'RoomConversationStore(database)' },
      { name: 'notes', type: 'RoomNotesRepository', default: 'RoomNotesRepository(database.notes())' },
      { name: 'grants', type: 'RoomGrantStore', default: 'RoomGrantStore(database.grants(), audit)' },
      { name: 'moduleStore', type: 'RoomModuleStore', default: 'RoomModuleStore(database.modules())' },
      { name: 'usage', type: 'UsageMeter', default: 'UsageMeter(database.usage())' },
      { name: 'settings', type: 'AppSettings', default: 'AppSettings(context.drakenSettings)' },
      { name: 'credentials', type: 'EncryptedCredentialStore', default: 'EncryptedCredentialStore(database.secrets(), KeystoreSecretCipher(), audit)' },
      { name: 'device', type: 'AndroidDeviceProfile', default: 'AndroidDeviceProfile(context)' },
      { name: 'modelStore', type: 'LocalModelStore', default: 'LocalModelStore(File(context.filesDir, "models"))' },
      { name: 'localProvider', type: 'LiteRtLmProvider', default: 'LiteRtLmProvider(modelStore, device, context.cacheDir)' },
      { name: 'downloads', type: 'LocalModelDownloads', default: 'LocalModelDownloads(scope, ModelDownloader(modelStore), modelStore, localProvider)' },
      { name: 'providers', type: 'AppProviderDirectory', default: 'AppProviderDirectory(credentials, settings, usage, localProvider, OkHttpTransport())' },
      { name: 'prompts', type: 'PromptBroker', default: 'PromptBroker()' },
      { name: 'registry', type: 'ToolRegistry', default: 'ToolRegistry()' },
      { name: 'handlers', type: 'HandlerCatalog', default: 'HandlerCatalog().also { addNotesHandlers(it, notes) }' },
      { name: 'modules', type: 'ModuleManager', default: 'ModuleManager(moduleStore, handlers, registry, grants, audit)' },
      { name: 'platform', type: 'AndroidPlatformPermissions', default: 'AndroidPlatformPermissions(context)' },
      { name: 'broker', type: 'PermissionBroker', default: 'PermissionBroker(modules, grants, platform)' },
      { name: 'orchestrator', type: 'Orchestrator', default: 'Orchestrator(conversations, providers, registry, ToolExecutor(registry, broker, prompts, audit), prompts, audit)' },
    ],
    ctor: [{ name: 'context', type: 'Context' }],
  });
  f.fn('start', {
    of: 'AppContainer',
    suspend: true,
    doc: 'Bring the platform up: install or update the built-in modules, register enabled modules\' tools, and on the very first run grant the Notes module its two capabilities - local data only - so it works out of the box. Every later decision is the user\'s; a revoked grant is never re-granted.',
    returns: 'List<string>',
    code: kt`
      modules.install(notesManifest(), ModuleSource.BUILT_IN)
      val reports = modules.restore()
      if (!settings.builtInsSeeded()) {
          grants.setGranted(NOTES_MODULE_ID, "notes.read", true)
          grants.setGranted(NOTES_MODULE_ID, "notes.write", true)
          settings.markBuiltInsSeeded()
      }
      return reports
    `,
  });

  f.cls('DrakenApplication', {
    doc: 'The application: creates the container and starts the platform in the background.',
    extends: 'Application',
    fields: [{ name: 'container', type: 'AppContainer', doc: 'The app\'s object graph.' }],
  });
  f.fn('onCreate', { of: 'DrakenApplication', override: true, doc: 'Build the container and start it.', code: kt`
    super.onCreate()
    container = AppContainer(this)
    container.scope.launch { container.start() }
  ` });
  f.use('java.io.File');
}
