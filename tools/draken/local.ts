/**
 * The `local` Gradle module: on-device inference.
 *
 * Plain Kotlin/JVM, compiled against LiteRT-LM's JVM artifact. LiteRT-LM's
 * Android and JVM artifacts publish the same public API - only Kotlin-internal
 * members differ - so the app supplies the Android artifact at run time and
 * this code runs unchanged on a phone, while the tests here run real inference
 * on a desktop JVM.
 *
 * Local means local: nothing in this module can reach a cloud model, and a
 * model that is missing, incompatible or failing is an error the user sees -
 * never a silent fallback.
 */

import type { Ctx } from './kit.ts';
import { KtFile, kt } from './kit.ts';
import { testClass } from './core/tests-providers.ts';

const ROOT = 'local/src/main/kotlin/com/draken/local';
const TEST = 'local/src/test/kotlin/com/draken/local';
const LITERT = 'com.google.ai.edge.litertlm';

export function buildLocal(ctx: Ctx): void {
  catalog(ctx);
  downloads(ctx);
  provider(ctx);
  tests(ctx);
}

function catalog(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/LocalModels.kt`, { doc: 'on-device models and where they are stored' });

  f.record(
    'LocalModelSpec',
    [
      { name: 'id', type: 'string' },
      { name: 'displayName', type: 'string' },
      { name: 'url', type: 'string', doc: 'Pinned to an exact repository revision, so the bytes cannot change under the hash.' },
      { name: 'fileName', type: 'string' },
      { name: 'sizeBytes', type: 'i64' },
      { name: 'sha256', type: 'string' },
      { name: 'license', type: 'string' },
      {
        name: 'minMemoryBytes',
        type: 'i64',
        doc: 'Total RAM, as Android reports it, below which the model is not offered. Android reports less than a phone is sold with - an "8 GB" phone shows a little over 7 GiB - so each threshold sits below its class.',
      },
      { name: 'contextTokens', type: 'i64', doc: 'The window the engine is opened with.' },
      { name: 'maxOutputTokens', type: 'i64' },
    ],
    { doc: 'A model that can be downloaded and run on the device.' },
  );

  f.fn('localModelCatalog', {
    doc: 'Models offered for download. LiteRT-LM builds from huggingface.co/litert-community, Apache-2.0 and ungated, with sizes and SHA-256 as published there on 2026-10-13. The context windows are conservative: the engine allocates its KV cache for the whole window up front, which is what decides whether a model fits in a phone\'s memory.',
    returns: 'List<LocalModelSpec>',
    code: kt`
      fun hf(repo: String, revision: String, file: String) = "https://huggingface.co/" + repo + "/resolve/" + revision + "/" + file
      val gib = 1L shl 30
      return listOf(
          LocalModelSpec(
              "qwen3-0.6b-int4", "Qwen3 0.6B (int4)",
              hf("litert-community/Qwen3-0.6B", "e6687177e00897731e7716267eebd4eba0dde7c2", "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm"),
              "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm", 344_671_744L,
              "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856", "Apache-2.0",
              3 * gib, 4_096L, 1_024L,
          ),
          LocalModelSpec(
              "qwen3-1.7b-int4", "Qwen3 1.7B (int4)",
              hf("litert-community/Qwen3-1.7B", "79bf0667b32ae025b972e5fe555fe72ca6e8816c", "Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm"),
              "Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm", 977_184_032L,
              "2a72330b504a6596d53a2c00923c57173b10f1b83e6a541213ffec08d1fc5de8", "Apache-2.0",
              5 * gib, 4_096L, 1_024L,
          ),
          LocalModelSpec(
              "gemma-4-e2b", "Gemma 4 E2B",
              hf("litert-community/gemma-4-E2B-it-litert-lm", "b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1", "gemma-4-E2B-it.litertlm"),
              "gemma-4-E2B-it.litertlm", 2_588_147_712L,
              "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c", "Apache-2.0",
              7 * gib, 8_192L, 2_048L,
          ),
      )
    `,
  });

  f.iface(
    'DeviceProfile',
    [
      { name: 'totalMemoryBytes', returns: 'i64', doc: 'Physical memory on the device.' },
    ],
    { doc: 'What the device offers a model.' },
  );

  f.fn('incompatibility', {
    doc: 'Why a model cannot run on this device, or null when it can.',
    params: [
      { name: 'spec', type: 'LocalModelSpec' },
      { name: 'device', type: 'DeviceProfile' },
    ],
    returns: 'Option<string>',
    code: kt`
      val total = device.totalMemoryBytes()
      if (total < spec.minMemoryBytes) {
          return spec.displayName + " needs about " + gigabytes(spec.minMemoryBytes) + " of memory; this device has " + gigabytes(total) + "."
      }
      return null
    `,
  });

  f.fn('gigabytes', {
    doc: 'A byte count as gigabytes, for messages.',
    params: [{ name: 'bytes', type: 'i64' }],
    returns: 'string',
    expression: true,
    code: kt`String.format(Locale.ROOT, "%.1f GB", bytes / 1_073_741_824.0)`,
  });

  f.cls('LocalModelStore', {
    doc: 'The directory downloaded models live in. A model counts as installed only when its file is complete; a partial download sits beside it until it finishes or is removed.',
    fields: [
      { name: 'directory', type: 'File' },
      { name: 'catalog', type: 'List<LocalModelSpec>' },
    ],
    ctor: [
      { name: 'directory', type: 'File' },
      { name: 'catalog', type: 'List<LocalModelSpec>', default: 'localModelCatalog()' },
    ],
  });
  f.fn('fileFor', {
    of: 'LocalModelStore',
    doc: 'Where a model\'s file lives.',
    params: [{ name: 'spec', type: 'LocalModelSpec' }],
    returns: 'File',
    expression: true,
    code: kt`File(directory, spec.fileName)`,
  });
  f.fn('partialFileFor', {
    of: 'LocalModelStore',
    doc: 'Where an unfinished download accumulates.',
    params: [{ name: 'spec', type: 'LocalModelSpec' }],
    returns: 'File',
    expression: true,
    code: kt`File(directory, spec.fileName + ".part")`,
  });
  f.fn('isInstalled', {
    of: 'LocalModelStore',
    doc: 'Whether a model\'s complete file is present.',
    params: [{ name: 'spec', type: 'LocalModelSpec' }],
    returns: 'bool',
    expression: true,
    code: kt`fileFor(spec).let { it.isFile && it.length() == spec.sizeBytes }`,
  });
  f.fn('installed', {
    of: 'LocalModelStore',
    doc: 'Every installed model.',
    returns: 'List<LocalModelSpec>',
    expression: true,
    code: kt`catalog.filter { isInstalled(it) }`,
  });
  f.fn('usedBytes', {
    of: 'LocalModelStore',
    doc: 'Storage the models take, partial downloads included.',
    returns: 'i64',
    expression: true,
    code: kt`directory.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L`,
  });
  f.fn('remove', {
    of: 'LocalModelStore',
    doc: 'Delete a model and any partial download of it. True when anything was deleted.',
    params: [{ name: 'spec', type: 'LocalModelSpec' }],
    returns: 'bool',
    code: kt`
      val removedFile = fileFor(spec).let { it.exists() && it.delete() }
      val removedPart = partialFileFor(spec).let { it.exists() && it.delete() }
      return removedFile || removedPart
    `,
  });
}

function downloads(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/ModelDownloader.kt`, { doc: 'downloading models, resumably and verified' });
  f.use('kotlinx.coroutines.job');

  f.record(
    'DownloadProgress',
    [
      { name: 'downloadedBytes', type: 'i64' },
      { name: 'totalBytes', type: 'i64' },
      { name: 'verifying', type: 'bool', default: 'false', doc: 'Downloaded, and checking the hash.' },
    ],
    { doc: 'How far a download has got.' },
  );

  f.decl(
    kt`
      /** A download that could not finish, with a reason the user can act on. Any partial file is kept for a later resume unless it is known bad. */
      class ModelDownloadException(message: String, cause: Throwable? = null) : Exception(message, cause)
    `,
    { doc: 'A failed download.', provides: ['ModelDownloadException'] },
  );

  f.cls('ModelDownloader', {
    doc: 'Downloads a model into a LocalModelStore. A download resumes from where it stopped, checks there is room before it starts, and is installed only after its size and SHA-256 match the catalog - a corrupt or substituted file never reaches the engine.',
    fields: [
      { name: 'store', type: 'LocalModelStore', visibility: 'private' },
      { name: 'client', type: 'OkHttpClient', visibility: 'private' },
    ],
    ctor: [
      { name: 'store', type: 'LocalModelStore' },
      { name: 'client', type: 'OkHttpClient', default: 'defaultHttpClient()' },
    ],
  });
  f.fn('download', {
    of: 'ModelDownloader',
    doc: 'Download, verify and install a model, reporting progress. Cancelling the collector stops the transfer and keeps the partial file.',
    params: [{ name: 'spec', type: 'LocalModelSpec' }],
    returns: 'Flow<DownloadProgress>',
    expression: true,
    code: kt`
      flow {
          if (store.isInstalled(spec)) {
              emit(DownloadProgress(spec.sizeBytes, spec.sizeBytes))
              return@flow
          }
          store.directory.mkdirs()
          val partial = store.partialFileFor(spec)
          if (partial.length() > spec.sizeBytes) partial.delete()
          val remaining = spec.sizeBytes - partial.length()
          if (store.directory.usableSpace < remaining) {
              throw ModelDownloadException("Not enough storage: " + gigabytes(remaining) + " needed, " + gigabytes(store.directory.usableSpace) + " free.")
          }
          if (remaining > 0) transfer(spec, partial)
          emit(DownloadProgress(spec.sizeBytes, spec.sizeBytes, verifying = true))
          verify(spec, partial)
          if (!partial.renameTo(store.fileFor(spec))) throw ModelDownloadException("Could not move the finished download into place.")
          emit(DownloadProgress(spec.sizeBytes, spec.sizeBytes))
      }.flowOn(Dispatchers.IO)
    `,
  });
  f.fn('transfer', {
    of: 'ModelDownloader',
    visibility: 'private',
    suspend: true,
    doc: 'Fetch the rest of the file into the partial download, asking the server to resume where it stopped.',
    params: [
      { name: 'spec', type: 'LocalModelSpec' },
      { name: 'partial', type: 'File' },
    ],
    code: kt`
      val start = partial.length()
      val builder = Request.Builder().url(spec.url)
      if (start > 0) builder.header("Range", "bytes=" + start + "-")
      val call = client.newCall(builder.build())
      val cancellation = currentCoroutineContext().job.invokeOnCompletion { call.cancel() }
      try {
          call.execute().use { response ->
              if (!response.isSuccessful) throw ModelDownloadException("The download server answered HTTP " + response.code + ".")
              // A server that ignores Range sends the whole file: start over.
              val append = response.code == 206
              FileOutputStream(partial, append).use { out ->
                  val input = response.body.byteStream()
                  val buffer = ByteArray(1 shl 16)
                  while (true) {
                      val read = input.read(buffer)
                      if (read < 0) break
                      out.write(buffer, 0, read)
                  }
              }
          }
      } catch (failure: IOException) {
          currentCoroutineContext().ensureActive()
          throw ModelDownloadException("The download was interrupted: " + (failure.message ?: "connection lost") + ". It will resume where it stopped.", failure)
      } finally {
          cancellation.dispose()
      }
    `,
  });
  f.fn('verify', {
    of: 'ModelDownloader',
    visibility: 'private',
    doc: 'Check the finished file against the catalog. A mismatch deletes it: resuming a corrupt file would only reproduce the corruption.',
    params: [
      { name: 'spec', type: 'LocalModelSpec' },
      { name: 'partial', type: 'File' },
    ],
    code: kt`
      if (partial.length() != spec.sizeBytes) {
          val size = partial.length()
          partial.delete()
          throw ModelDownloadException("The download is " + size + " bytes; " + spec.sizeBytes + " were expected. It was discarded.")
      }
      val digest = MessageDigest.getInstance("SHA-256")
      FileInputStream(partial).use { input ->
          val buffer = ByteArray(1 shl 16)
          while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              digest.update(buffer, 0, read)
          }
      }
      val actual = digest.digest().joinToString("") { "%02x".format(it) }
      if (!actual.equals(spec.sha256, ignoreCase = true)) {
          partial.delete()
          throw ModelDownloadException("The downloaded file does not match its published checksum, so it was discarded.")
      }
    `,
  });
}

function provider(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/LiteRtLmProvider.kt`, { doc: 'the on-device model provider' });
  f.use(
    `${LITERT}.Backend`,
    `${LITERT}.Contents`,
    `${LITERT}.Content`,
    `${LITERT}.ConversationConfig`,
    `${LITERT}.Engine`,
    `${LITERT}.EngineConfig`,
    `${LITERT}.LiteRtLmJniException`,
    `${LITERT}.Message`,
    'kotlinx.coroutines.job',
  );

  f.decl(
    kt`
      /** The id every on-device model goes by in routing and settings. */
      const val LOCAL_PROVIDER_ID = "on-device"
    `,
    { doc: 'The local provider id.', provides: ['LOCAL_PROVIDER_ID'] },
  );

  f.cls('LiteRtLmProvider', {
    doc: 'ModelProvider for models running on the device through LiteRT-LM. One engine is open at a time - a model holds most of a phone\'s free memory - and one generation runs at a time on it. Opening an engine takes seconds, so it stays open until another model is needed or close() is called.',
    implements: ['ModelProvider'],
    fields: [
      { name: 'store', type: 'LocalModelStore', visibility: 'private' },
      { name: 'device', type: 'DeviceProfile', visibility: 'private' },
      { name: 'cacheDir', type: 'Option<File>', visibility: 'private' },
      { name: 'lock', type: 'Mutex', default: 'Mutex()', visibility: 'private' },
      { name: 'engine', type: 'Option<Engine>', default: 'null', readonly: false, visibility: 'private' },
      { name: 'engineModelId', type: 'Option<string>', default: 'null', readonly: false, visibility: 'private' },
    ],
    ctor: [
      { name: 'store', type: 'LocalModelStore' },
      { name: 'device', type: 'DeviceProfile' },
      { name: 'cacheDir', type: 'Option<File>', default: 'null' },
    ],
  });
  f.fn('descriptor', {
    of: 'LiteRtLmProvider',
    override: true,
    doc: 'The on-device provider.',
    returns: 'ProviderDescriptor',
    expression: true,
    code: kt`ProviderDescriptor(LOCAL_PROVIDER_ID, "On this device", ProviderKind.LOCAL, ProviderFamily.ON_DEVICE)`,
  });
  f.fn('models', {
    of: 'LiteRtLmProvider',
    override: true,
    doc: 'Installed models this device can run. They do not use tools: none of the catalogued models is trained for tool calling, and offering tools to them would produce calls nobody should run.',
    returns: 'List<ModelDescriptor>',
    expression: true,
    code: kt`
      store.installed().filter { incompatibility(it, device) == null }.map {
          ModelDescriptor(LOCAL_PROVIDER_ID, it.id, it.displayName, ModelCapabilities(it.contextTokens, it.maxOutputTokens, false, false, true))
      }
    `,
  });
  f.fn('stream', {
    of: 'LiteRtLmProvider',
    override: true,
    doc: 'Generate a reply on the device. The earlier turns seed a fresh conversation and the last user message is sent to it; cancelling the collector stops generation.',
    params: [{ name: 'request', type: 'ModelRequest' }],
    returns: 'Flow<ModelEvent>',
    expression: true,
    code: kt`
      flow {
          val spec = store.catalog.firstOrNull { it.id == request.modelId }
              ?: throw ProviderException(ProviderError.ModelNotFound(request.modelId))
          if (!store.isInstalled(spec)) throw ProviderException(ProviderError.Unavailable(spec.displayName + " is not downloaded."))
          incompatibility(spec, device)?.let { throw ProviderException(ProviderError.Unavailable(it)) }
          val last = request.messages.lastOrNull() as? PromptMessage.User
              ?: throw ProviderException(ProviderError.InvalidRequest("an on-device request has to end with the user's message"))

          lock.withLock {
              val engine = engineFor(spec)
              val config = ConversationConfig(request.system?.let { Contents.of(it) }, seedMessages(request.messages.dropLast(1)))
              val conversation = try {
                  engine.createConversation(config)
              } catch (failure: LiteRtLmJniException) {
                  throw ProviderException(ProviderError.Unavailable("The on-device model could not start a conversation: " + failure.message), failure)
              }
              val cancellation = currentCoroutineContext().job.invokeOnCompletion { conversation.cancelProcess() }
              try {
                  // Some models open with blank lines - the residue of an empty reasoning
                  // block - so whitespace before the first visible character is dropped.
                  var started = false
                  conversation.sendMessageAsync(Contents.of(last.text)).collect { message ->
                      val text = if (started) textOf(message) else textOf(message).trimStart()
                      if (text.isNotEmpty()) {
                          started = true
                          emit(ModelEvent.TextDelta(text))
                      }
                  }
                  // No usage report: token counts only matter for the cloud budget.
                  emit(ModelEvent.Finished(StopReason.END_TURN, null))
              } catch (failure: LiteRtLmJniException) {
                  currentCoroutineContext().ensureActive()
                  throw ProviderException(ProviderError.Unavailable("The on-device model failed: " + failure.message), failure)
              } finally {
                  cancellation.dispose()
                  conversation.close()
              }
          }
      }
    `,
  });
  f.fn('engineFor', {
    of: 'LiteRtLmProvider',
    visibility: 'private',
    suspend: true,
    doc: 'The open engine for a model, opening it - and closing any other - when needed. Opening loads the model into memory, so it runs on the IO dispatcher.',
    params: [{ name: 'spec', type: 'LocalModelSpec' }],
    returns: 'Engine',
    code: kt`
      val open = engine
      if (open != null && engineModelId == spec.id) return open
      open?.close()
      engine = null
      engineModelId = null
      val created = Engine(
          EngineConfig(
              modelPath = store.fileFor(spec).absolutePath,
              backend = Backend.CPU(),
              maxNumTokens = spec.contextTokens.toInt(),
              cacheDir = cacheDir?.absolutePath,
          ),
      )
      try {
          withContext(Dispatchers.IO) { created.initialize() }
      } catch (failure: LiteRtLmJniException) {
          created.close()
          throw ProviderException(ProviderError.Unavailable("The on-device model could not be loaded: " + failure.message), failure)
      }
      engine = created
      engineModelId = spec.id
      return created
    `,
  });
  f.fn('close', {
    of: 'LiteRtLmProvider',
    suspend: true,
    doc: 'Release the open engine and its memory. The next request opens it again.',
    code: kt`
      lock.withLock {
          engine?.close()
          engine = null
          engineModelId = null
      }
    `,
  });

  f.fn('seedMessages', {
    visibility: 'private',
    doc: 'Earlier turns as LiteRT-LM messages. Tool traffic is left out: these models do not use tools.',
    params: [{ name: 'messages', type: 'List<PromptMessage>' }],
    returns: 'List<Message>',
    expression: true,
    code: kt`
      messages.mapNotNull {
          when (it) {
              is PromptMessage.User -> Message.user(it.text)
              is PromptMessage.Assistant -> if (it.text.isBlank()) null else Message.model(it.text)
              is PromptMessage.ToolResults -> null
          }
      }
    `,
  });
  f.fn('textOf', {
    visibility: 'private',
    doc: 'The text a streamed message carries.',
    params: [{ name: 'message', type: 'Message' }],
    returns: 'string',
    expression: true,
    code: kt`message.contents.contents.filterIsInstance<Content.Text>().joinToString("") { it.text }`,
  });
}

function tests(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/LocalModelsTest.kt`, { doc: 'downloads and the on-device provider', role: 'test' });
  f.use('kotlinx.coroutines.flow.toList');
  f.decl(
    kt`
      private fun tempDir(): File = Files.createTempDirectory("draken-models").toFile()

      private fun spec(bytes: ByteArray, url: String) = LocalModelSpec(
          "test", "Test model", url, "test.litertlm", bytes.size.toLong(),
          MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) },
          "MIT", 0L, 4_096L, 256L,
      )

      private object EnoughMemory : DeviceProfile {
          override fun totalMemoryBytes() = 64L shl 30
      }
    `,
    { doc: 'Helpers.' },
  );
  testClass(
    f,
    'LocalModelsTest',
    'Downloads are resumable and verified; the provider refuses what it cannot run; and, given a real model file, it really generates.',
    [
      {
        name: 'downloadsVerifiesAndInstalls',
        doc: 'A complete, matching download is installed and counted in storage.',
        code: kt`
          val bytes = ByteArray(300_000) { (it % 251).toByte() }
          server.enqueue(MockResponse.Builder().code(200).body(okio.Buffer().write(bytes)).build())
          val store = LocalModelStore(tempDir(), emptyList())
          val model = spec(bytes, server.url("/model").toString())
          val progress = runBlocking { ModelDownloader(store).download(model).toList() }
          assertTrue(progress.any { it.verifying })
          assertTrue(store.isInstalled(model))
          assertEquals(bytes.size.toLong(), store.usedBytes())
        `,
      },
      {
        name: 'resumesAPartialDownload',
        doc: 'An interrupted download asks for the rest with a Range header and appends it.',
        code: kt`
          val bytes = ByteArray(200_000) { (it % 97).toByte() }
          val store = LocalModelStore(tempDir(), emptyList())
          val model = spec(bytes, server.url("/model").toString())
          store.directory.mkdirs()
          store.partialFileFor(model).writeBytes(bytes.copyOfRange(0, 50_000))
          server.enqueue(MockResponse.Builder().code(206).body(okio.Buffer().write(bytes.copyOfRange(50_000, bytes.size))).build())
          runBlocking { ModelDownloader(store).download(model).toList() }
          assertEquals("bytes=50000-", server.takeRequest().headers["Range"])
          assertTrue(store.isInstalled(model))
        `,
      },
      {
        name: 'discardsAFileThatDoesNotMatchItsChecksum',
        doc: 'Bytes of the right length but the wrong content are deleted, never installed.',
        code: kt`
          val bytes = ByteArray(10_000) { 1 }
          server.enqueue(MockResponse.Builder().code(200).body(okio.Buffer().write(ByteArray(10_000) { 2 })).build())
          val store = LocalModelStore(tempDir(), emptyList())
          val model = spec(bytes, server.url("/model").toString())
          val failure = assertThrows(ModelDownloadException::class.java) { runBlocking { ModelDownloader(store).download(model).toList() } }
          assertTrue(failure.message!!.contains("checksum"))
          assertFalse(store.isInstalled(model))
          assertFalse(store.partialFileFor(model).exists())
        `,
      },
      {
        name: 'removesAModelAndItsPartialFile',
        doc: 'Removal frees the storage.',
        code: kt`
          val store = LocalModelStore(tempDir(), emptyList())
          val model = spec(ByteArray(10), "https://example.invalid/m")
          store.directory.mkdirs()
          store.fileFor(model).writeBytes(ByteArray(10))
          assertTrue(store.remove(model))
          assertEquals(0L, store.usedBytes())
        `,
      },
      {
        name: 'refusesAModelTooLargeForTheDevice',
        doc: 'A model needing more memory than the device has is not offered, and a request for it fails with the reason.',
        code: kt`
          val catalog = localModelCatalog()
          val small = object : DeviceProfile {
              override fun totalMemoryBytes() = 4L shl 30
          }
          assertNotNull(incompatibility(catalog.first { it.id == "gemma-4-e2b" }, small))
          assertNull(incompatibility(catalog.first { it.id == "qwen3-0.6b-int4" }, small))
          // A phone sold with 8 GB reports a little over 7 GiB; every model is offered on it.
          val eightGigabytePhone = object : DeviceProfile {
              override fun totalMemoryBytes() = (29L shl 30) / 4
          }
          assertTrue(catalog.all { incompatibility(it, eightGigabytePhone) == null })
        `,
      },
      {
        name: 'refusesARequestForAModelThatIsNotDownloaded',
        doc: 'No file, no inference - and no fallback to anything else.',
        code: kt`
          val provider = LiteRtLmProvider(LocalModelStore(tempDir()), EnoughMemory)
          assertTrue(provider.models().isEmpty())
          val failure = assertThrows(ProviderException::class.java) {
              runBlocking { provider.stream(ModelRequest("qwen3-0.6b-int4", null, listOf(PromptMessage.User("hi")))).toList() }
          }
          assertTrue(failure.error is ProviderError.Unavailable)
        `,
      },
      {
        name: 'generatesTextWithARealModel',
        doc: 'Real inference through LiteRT-LM on this JVM. Runs when DRAKEN_TEST_MODEL_DIR holds the Qwen3 0.6B file; skipped, and says so, otherwise.',
        code: kt`
          val dir = System.getenv("DRAKEN_TEST_MODEL_DIR")
          val catalog = localModelCatalog()
          val qwen = catalog.first { it.id == "qwen3-0.6b-int4" }
          Assume.assumeTrue("set DRAKEN_TEST_MODEL_DIR to a directory holding " + qwen.fileName, dir != null && File(dir, qwen.fileName).isFile)
          val provider = LiteRtLmProvider(LocalModelStore(File(dir!!), catalog), EnoughMemory)
          val request = ModelRequest(
              qwen.id,
              "Answer in one short sentence.",
              listOf(PromptMessage.User("What is the capital of France?")),
          )
          val events = runBlocking { provider.stream(request).toList() }
          runBlocking { provider.close() }
          val text = events.filterIsInstance<ModelEvent.TextDelta>().joinToString("") { it.text }
          println("on-device reply: " + text)
          assertTrue("a real reply mentions Paris: " + text, text.contains("Paris"))
          assertEquals(StopReason.END_TURN, (events.last() as ModelEvent.Finished).stopReason)
        `,
      },
    ],
    { fields: [{ name: 'server', type: 'MockWebServer', default: 'MockWebServer().apply { start() }', visibility: 'private' }] },
  );
  f.fn('stopServer', {
    of: 'LocalModelsTest',
    annotations: ['After'],
    doc: 'Release the port.',
    code: kt`server.close()`,
  });
}
