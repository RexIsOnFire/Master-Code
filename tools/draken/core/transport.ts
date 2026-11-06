/**
 * JSON handling shared by the adapters, and the production HTTP transport.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core';

export function buildTransport(ctx: Ctx): void {
  json(ctx);
  okHttp(ctx);
}

function json(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/json/JsonSupport.kt`, { doc: 'JSON configuration and conversions' });

  // A declaration rather than a class node: the graph's `Json` type means a
  // dynamic JSON value, not kotlinx's Json class, so the field could not be typed.
  f.decl(
    kt`
      /**
       * The one JSON configuration the app uses. Unknown fields are ignored because vendors add
       * fields without notice; absent optional fields stay absent rather than being written as null.
       */
      object DrakenJson {
          val format: Json = Json {
              ignoreUnknownKeys = true
              explicitNulls = false
              encodeDefaults = true
          }
      }
    `,
    { doc: 'The shared JSON configuration.', provides: ['DrakenJson'] },
  );

  f.fn('parseJsonObject', {
    doc: 'The text as a JSON object, or null when it is not valid JSON or not an object. For untrusted text - model output, response bodies - where failure is an ordinary outcome.',
    params: [{ name: 'text', type: 'string' }],
    returns: 'Option<JsonObject>',
    expression: true,
    code: kt`runCatching { DrakenJson.format.parseToJsonElement(text) }.getOrNull() as? JsonObject`,
  });

  f.fn('toPlainValue', {
    doc: 'A JSON element as plain JVM values - maps, lists, strings, numbers, booleans and null - for libraries that take those.',
    params: [{ name: 'element', type: 'JsonElement' }],
    returns: 'Any',
    code: kt`
      return when (element) {
          is JsonObject -> element.mapValues { toPlainValue(it.value) }
          is JsonArray -> element.map { toPlainValue(it) }
          JsonNull -> null
          is JsonPrimitive -> when {
              element.isString -> element.content
              element.booleanOrNull != null -> element.booleanOrNull
              element.longOrNull != null -> element.longOrNull
              else -> element.doubleOrNull
          }
      }
    `,
  });

  f.fn('fromPlainValue', {
    doc: 'Plain JVM values - maps, lists, strings, numbers, booleans and null - as a JSON element. The inverse of toPlainValue.',
    params: [{ name: 'value', type: 'Any' }],
    returns: 'JsonElement',
    code: kt`
      return when (value) {
          null -> JsonNull
          is JsonElement -> value
          is Map<*, *> -> JsonObject(value.entries.associate { it.key.toString() to fromPlainValue(it.value) })
          is Iterable<*> -> JsonArray(value.map { fromPlainValue(it) })
          is Boolean -> JsonPrimitive(value)
          is Number -> JsonPrimitive(value)
          else -> JsonPrimitive(value.toString())
      }
    `,
  });

  f.fn('stringField', {
    doc: 'A string member of a JSON object, or null when it is absent or not a string.',
    params: [
      { name: 'obj', type: 'Option<JsonObject>' },
      { name: 'key', type: 'string' },
    ],
    returns: 'Option<string>',
    expression: true,
    code: kt`(obj?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content`,
  });

  f.fn('objectField', {
    doc: 'An object member of a JSON object, or null.',
    params: [
      { name: 'obj', type: 'Option<JsonObject>' },
      { name: 'key', type: 'string' },
    ],
    returns: 'Option<JsonObject>',
    expression: true,
    code: kt`obj?.get(key) as? JsonObject`,
  });

  f.fn('arrayField', {
    doc: 'An array member of a JSON object, or an empty array.',
    params: [
      { name: 'obj', type: 'Option<JsonObject>' },
      { name: 'key', type: 'string' },
    ],
    returns: 'JsonArray',
    expression: true,
    code: kt`obj?.get(key) as? JsonArray ?: JsonArray(emptyList())`,
  });

  f.fn('longField', {
    doc: 'A numeric member of a JSON object as a Long, or null.',
    params: [
      { name: 'obj', type: 'Option<JsonObject>' },
      { name: 'key', type: 'string' },
    ],
    returns: 'Option<i64>',
    expression: true,
    code: kt`(obj?.get(key) as? JsonPrimitive)?.longOrNull`,
  });
}

function okHttp(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/provider/http/OkHttpTransport.kt`, { doc: 'the production HTTP transport' });

  f.cls('OkHttpTransport', {
    doc: 'HttpTransport over OkHttp. Each body line is emitted as it arrives, so a stream is shown as it is generated; cancelling the collector cancels the HTTP call.',
    implements: ['HttpTransport'],
    fields: [{ name: 'client', type: 'OkHttpClient', visibility: 'private' }],
    ctor: [{ name: 'client', type: 'OkHttpClient', default: 'defaultHttpClient()' }],
  });
  f.fn('stream', {
    of: 'OkHttpTransport',
    override: true,
    doc: 'POST and stream the body by lines.',
    params: [{ name: 'request', type: 'HttpRequestSpec' }],
    returns: 'Flow<string>',
    expression: true,
    code: kt`
      flow {
          val builder = Request.Builder().url(request.url)
          for ((name, value) in request.headers) builder.header(name, value)
          val call = client.newCall(builder.post(request.body.toRequestBody(JSON_MEDIA_TYPE)).build())
          // Cancelling the coroutine cancels the call, which unblocks a read in progress.
          val cancellation = currentCoroutineContext().job.invokeOnCompletion { call.cancel() }
          try {
              val response = try {
                  call.execute()
              } catch (failure: IOException) {
                  throw transportFailure(failure)
              }
              response.use {
                  if (!it.isSuccessful) {
                      throw HttpStatusException(it.code, it.body.string(), parseRetryAfter(it.header("Retry-After")))
                  }
                  val source = it.body.source()
                  while (true) {
                      val line = try {
                          source.readUtf8Line()
                      } catch (failure: IOException) {
                          throw transportFailure(failure)
                      } ?: break
                      emit(line)
                  }
              }
          } finally {
              cancellation.dispose()
          }
      }.flowOn(Dispatchers.IO)
    `,
  });
  f.use('kotlinx.coroutines.job');

  f.decl(
    kt`
      private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    `,
    { doc: 'The content type of every request body.' },
  );

  f.fn('transportFailure', {
    visibility: 'private',
    suspend: true,
    doc: 'An I/O failure as a provider error - unless the request was cancelled, in which case cancellation is what happened.',
    params: [{ name: 'failure', type: 'IOException' }],
    returns: 'Exception',
    code: kt`
      currentCoroutineContext().ensureActive()
      val error = when (failure) {
          is SocketTimeoutException -> ProviderError.Timeout
          is UnknownHostException -> ProviderError.Network("no network connection")
          else -> ProviderError.Network(failure.message ?: failure.javaClass.simpleName)
      }
      return ProviderException(error, failure)
    `,
  });

  f.fn('defaultHttpClient', {
    doc: 'Timeouts for streamed model output: a connection is established quickly or not at all, and a read may wait while a model thinks - providers send keep-alive events during long pauses. There is no overall call timeout; the orchestrator bounds a turn.',
    returns: 'OkHttpClient',
    expression: true,
    code: kt`
      OkHttpClient.Builder()
          .connectTimeout(15, TimeUnit.SECONDS)
          .readTimeout(120, TimeUnit.SECONDS)
          .writeTimeout(30, TimeUnit.SECONDS)
          .build()
    `,
  });
}
