/**
 * Google Gemini, through the generateContent REST API.
 *
 * Gemini 3 attaches thought signatures to function calls and validates them
 * on the next request of the same turn; a call sent back without its signature
 * is a 400. The model's turn is therefore replayed exactly as it arrived -
 * every part, in order, signatures wherever Gemini put them - rather than
 * rebuilt from its text and calls.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core/provider/gemini';

export function buildGemini(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/GeminiProvider.kt`, { doc: 'the Gemini adapter' });
  f.use('kotlinx.serialization.json.put');

  f.decl(
    kt`
      /** Calls Gemini did not give an id are numbered locally; this prefix marks them so the id is not sent back. */
      private const val LOCAL_CALL_PREFIX = "gemini-local-"
    `,
    { doc: 'Prefix for locally numbered function calls.' },
  );

  f.cls('GeminiProvider', {
    doc: 'ModelProvider for the Gemini API.',
    implements: ['ModelProvider'],
    fields: [
      { name: 'config', type: 'CloudProviderConfig', visibility: 'private' },
      { name: 'credentials', type: 'CredentialSource', visibility: 'private' },
      { name: 'transport', type: 'HttpTransport', visibility: 'private' },
    ],
    ctor: [
      { name: 'config', type: 'CloudProviderConfig' },
      { name: 'credentials', type: 'CredentialSource' },
      { name: 'transport', type: 'HttpTransport' },
    ],
  });
  f.fn('descriptor', {
    of: 'GeminiProvider',
    override: true,
    doc: 'A cloud provider of the Gemini family.',
    returns: 'ProviderDescriptor',
    expression: true,
    code: kt`ProviderDescriptor(config.id, config.displayName, ProviderKind.CLOUD, ProviderFamily.GEMINI)`,
  });
  f.fn('models', {
    of: 'GeminiProvider',
    override: true,
    doc: 'The configured models.',
    returns: 'List<ModelDescriptor>',
    expression: true,
    code: kt`config.models`,
  });
  f.fn('stream', {
    of: 'GeminiProvider',
    override: true,
    doc: 'Stream one request. The key goes in a header, never in the URL, so it cannot end up in a log line.',
    params: [{ name: 'request', type: 'ModelRequest' }],
    returns: 'Flow<ModelEvent>',
    expression: true,
    code: kt`
      flow {
          val key = credentials.apiKey(config.id) ?: throw ProviderException(ProviderError.MissingCredentials)
          val spec = HttpRequestSpec(
              config.baseUrl.trimEnd('/') + "/v1beta/models/" + request.modelId + ":streamGenerateContent?alt=sse",
              mapOf("x-goog-api-key" to key),
              geminiBody(request, config.id).toString(),
          )
          val reader = GeminiStreamReader(config.id)
          try {
              sseEvents(transport.stream(spec)).collect { event -> for (out in reader.accept(event)) emit(out) }
          } catch (failure: HttpStatusException) {
              throw geminiFailure(failure, request.modelId)
          }
          for (out in reader.finish()) emit(out)
      }
    `,
  });

  f.fn('geminiBody', {
    doc: 'The request body.',
    params: [
      { name: 'request', type: 'ModelRequest' },
      { name: 'providerId', type: 'string' },
    ],
    returns: 'JsonObject',
    expression: true,
    code: kt`
      buildJsonObject {
          request.system?.let { system ->
              putJsonObject("systemInstruction") {
                  putJsonArray("parts") { addJsonObject { put("text", system) } }
              }
          }
          put("contents", JsonArray(geminiContents(request.messages, providerId)))
          if (request.tools.isNotEmpty()) {
              putJsonArray("tools") {
                  addJsonObject {
                      putJsonArray("functionDeclarations") {
                          for (tool in request.tools) addJsonObject {
                              put("name", tool.name)
                              put("description", tool.description)
                              put("parameters", geminiSchema(tool.inputSchema))
                          }
                      }
                  }
              }
          }
          putJsonObject("generationConfig") { put("maxOutputTokens", request.maxOutputTokens) }
      }
    `,
  });

  f.fn('geminiSchema', {
    doc: 'A JSON Schema reduced to what Gemini\'s parameter schema accepts: `additionalProperties` and `$schema` are dropped, everywhere they occur. Dropping them loosens nothing that matters - the tool pipeline validates arguments against the full schema regardless.',
    params: [{ name: 'schema', type: 'JsonElement' }],
    returns: 'JsonElement',
    code: kt`
      return when (schema) {
          is JsonObject -> JsonObject(
              schema.filterKeys { it != "additionalProperties" && it != "\$schema" }.mapValues { geminiSchema(it.value) },
          )
          is JsonArray -> JsonArray(schema.map { geminiSchema(it) })
          else -> schema
      }
    `,
  });

  f.fn('geminiContents', {
    doc: 'The conversation as Gemini contents. A model turn this provider produced is replayed as received; tool results go back as one user turn after all of the calls, which is the order Gemini requires.',
    params: [
      { name: 'messages', type: 'List<PromptMessage>' },
      { name: 'providerId', type: 'string' },
    ],
    returns: 'List<JsonElement>',
    code: kt`
      val contents = mutableListOf<JsonElement>()
      for (message in messages) {
          when (message) {
              is PromptMessage.User -> contents.add(buildJsonObject {
                  put("role", "user")
                  putJsonArray("parts") { addJsonObject { put("text", message.text) } }
              })
              is PromptMessage.Assistant -> {
                  val replayed = message.replay?.takeIf { it.providerId == providerId }?.let { parseJsonObject(it.payload) }
                  if (replayed != null) {
                      contents.add(replayed)
                  } else if (message.text.isNotBlank() || message.toolCalls.isNotEmpty()) {
                      contents.add(buildJsonObject {
                          put("role", "model")
                          putJsonArray("parts") {
                              if (message.text.isNotBlank()) addJsonObject { put("text", message.text) }
                              for (call in message.toolCalls) addJsonObject {
                                  putJsonObject("functionCall") {
                                      put("name", call.toolName)
                                      put("args", parseJsonObject(call.argumentsJson) ?: JsonObject(emptyMap()))
                                      if (!call.id.startsWith(LOCAL_CALL_PREFIX)) put("id", call.id)
                                  }
                              }
                          }
                      })
                  }
              }
              is PromptMessage.ToolResults -> contents.add(buildJsonObject {
                  put("role", "user")
                  putJsonArray("parts") {
                      for (result in message.results) addJsonObject {
                          putJsonObject("functionResponse") {
                              put("name", result.toolName)
                              if (!result.callId.startsWith(LOCAL_CALL_PREFIX)) put("id", result.callId)
                              val body = parseJsonObject(result.content)
                              putJsonObject("response") {
                                  put(if (result.isError) "error" else "result", body ?: JsonPrimitive(result.content))
                              }
                          }
                      }
                  }
              })
          }
      }
      return contents
    `,
  });

  f.cls('GeminiStreamReader', {
    doc: 'Turns streamed generateContent chunks into ModelEvents, keeping every part of the model turn for replay.',
    fields: [
      { name: 'providerId', type: 'string', visibility: 'private' },
      { name: 'parts', type: 'MutableList<JsonElement>', default: 'mutableListOf()', visibility: 'private' },
      { name: 'finishReason', type: 'Option<string>', default: 'null', readonly: false, visibility: 'private' },
      { name: 'blocked', type: 'bool', default: 'false', readonly: false, visibility: 'private' },
      { name: 'calls', type: 'i64', default: '0L', readonly: false, visibility: 'private' },
      { name: 'inputTokens', type: 'i64', default: '0L', readonly: false, visibility: 'private' },
      { name: 'outputTokens', type: 'i64', default: '0L', readonly: false, visibility: 'private' },
      { name: 'received', type: 'bool', default: 'false', readonly: false, visibility: 'private' },
    ],
    ctor: [{ name: 'providerId', type: 'string' }],
  });
  f.fn('accept', {
    of: 'GeminiStreamReader',
    doc: 'The events one chunk produces. Thought parts are kept for replay but never shown.',
    params: [{ name: 'event', type: 'SseEvent' }],
    returns: 'List<ModelEvent>',
    code: kt`
      val chunk = parseJsonObject(event.data) ?: return emptyList()
      received = true
      if (stringField(objectField(chunk, "promptFeedback"), "blockReason") != null) blocked = true
      objectField(chunk, "usageMetadata")?.let {
          inputTokens = longField(it, "promptTokenCount") ?: inputTokens
          outputTokens = (longField(it, "candidatesTokenCount") ?: 0L) + (longField(it, "thoughtsTokenCount") ?: 0L)
      }
      val candidate = arrayField(chunk, "candidates").firstOrNull() as? JsonObject ?: return emptyList()
      stringField(candidate, "finishReason")?.let { finishReason = it }
      val out = mutableListOf<ModelEvent>()
      for (element in arrayField(objectField(candidate, "content"), "parts")) {
          val part = element as? JsonObject ?: continue
          parts.add(part)
          val thought = (part["thought"] as? JsonPrimitive)?.booleanOrNull == true
          val text = stringField(part, "text")
          if (text != null && !thought && text.isNotEmpty()) out.add(ModelEvent.TextDelta(text))
          objectField(part, "functionCall")?.let { call ->
              val id = stringField(call, "id") ?: (LOCAL_CALL_PREFIX + calls)
              calls += 1
              val args = objectField(call, "args") ?: JsonObject(emptyMap())
              out.add(ModelEvent.ToolCallRequested(ToolCall(id, stringField(call, "name").orEmpty(), args.toString())))
          }
      }
      return out
    `,
  });
  f.fn('finish', {
    of: 'GeminiStreamReader',
    doc: 'Usage and the final event, with the whole model turn as replay.',
    returns: 'List<ModelEvent>',
    code: kt`
      if (!received) throw ProviderException(ProviderError.MalformedResponse("the stream ended without a response"))
      val stop = when {
          blocked -> StopReason.REFUSAL
          calls > 0 -> StopReason.TOOL_USE
          finishReason == "STOP" -> StopReason.END_TURN
          finishReason == "MAX_TOKENS" -> StopReason.MAX_TOKENS
          finishReason in setOf("SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY") -> StopReason.REFUSAL
          else -> StopReason.OTHER
      }
      val turn = buildJsonObject {
          put("role", "model")
          put("parts", JsonArray(parts))
      }
      return listOf(
          ModelEvent.UsageReport(inputTokens, outputTokens),
          ModelEvent.Finished(stop, if (parts.isEmpty()) null else ProviderReplay(providerId, turn.toString())),
      )
    `,
  });

  f.fn('geminiFailure', {
    doc: 'A non-2xx Gemini response as a ProviderException. An invalid key is reported as a 400 by this API, so the message is read to tell it apart from other bad requests.',
    params: [
      { name: 'failure', type: 'HttpStatusException' },
      { name: 'modelId', type: 'string' },
    ],
    returns: 'ProviderException',
    code: kt`
      val error = objectField(parseJsonObject(failure.body), "error")
      val message = stringField(error, "message") ?: failure.body.take(300).ifBlank { "HTTP " + failure.status }
      val status = stringField(error, "status")
      val mapped = when {
          failure.status == 401 || status == "UNAUTHENTICATED" || message.contains("API key", ignoreCase = true) ->
              ProviderError.Authentication(message)
          failure.status == 403 || status == "PERMISSION_DENIED" -> ProviderError.PermissionDenied(message)
          failure.status == 404 || status == "NOT_FOUND" -> ProviderError.ModelNotFound(modelId)
          failure.status == 429 || status == "RESOURCE_EXHAUSTED" -> ProviderError.RateLimited(failure.retryAfterMillis)
          message.contains("exceeds the maximum number of tokens", ignoreCase = true) -> ProviderError.ContextTooLong(message)
          failure.status == 503 || status == "UNAVAILABLE" -> ProviderError.Overloaded
          failure.status == 504 || status == "DEADLINE_EXCEEDED" -> ProviderError.Timeout
          failure.status >= 500 -> ProviderError.ServerError(failure.status.toLong())
          else -> ProviderError.InvalidRequest(message)
      }
      return ProviderException(mapped, failure)
    `,
  });
}
