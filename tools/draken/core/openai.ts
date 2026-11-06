/**
 * OpenAI, DeepSeek and self-hosted OpenAI-compatible servers.
 *
 * Two adapters, because the vendors have parted ways:
 *
 *  - OpenAI's current models take function tools only through the Responses
 *    API (their model pages say Chat Completions is "supported without tool
 *    calling"). Requests are sent with `store: false`, so nothing is kept on
 *    OpenAI's side; reasoning comes back encrypted and is replayed as-is with
 *    the output items it belongs to, which is what a later tool round needs.
 *  - DeepSeek, and local servers such as Ollama or LM Studio, speak Chat
 *    Completions. DeepSeek requires the `reasoning_content` of earlier assistant
 *    turns back on every request once tools are involved, so it is replayed.
 *
 * Both reach the network through HttpTransport and share one error mapping,
 * since both use the `{"error": {"message", "type", "code"}}` envelope.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core/provider/openai';

export function buildOpenAi(ctx: Ctx): void {
  errors(ctx);
  responses(ctx);
  chatCompletions(ctx);
}

function errors(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/OpenAiErrors.kt`, { doc: 'the OpenAI-style error envelope' });
  f.fn('openAiStyleFailure', {
    doc: 'A non-2xx response from an OpenAI-style API as a ProviderException. A 429 for exhausted quota is not a rate limit - waiting does not fix it - so it is reported as a permission problem.',
    params: [
      { name: 'failure', type: 'HttpStatusException' },
      { name: 'modelId', type: 'string' },
    ],
    returns: 'ProviderException',
    code: kt`
      val error = objectField(parseJsonObject(failure.body), "error")
      val message = stringField(error, "message") ?: failure.body.take(300).ifBlank { "HTTP " + failure.status }
      val code = stringField(error, "code")
      val mapped = when {
          failure.status == 401 -> ProviderError.Authentication(message)
          failure.status == 403 -> ProviderError.PermissionDenied(message)
          failure.status == 404 && (code == "model_not_found" || message.contains("model", ignoreCase = true)) ->
              ProviderError.ModelNotFound(modelId)
          failure.status == 429 && code == "insufficient_quota" ->
              ProviderError.PermissionDenied("the account has no remaining quota")
          failure.status == 429 -> ProviderError.RateLimited(failure.retryAfterMillis)
          code == "context_length_exceeded" -> ProviderError.ContextTooLong(message)
          failure.status == 503 -> ProviderError.Overloaded
          failure.status >= 500 -> ProviderError.ServerError(failure.status.toLong())
          else -> ProviderError.InvalidRequest(message)
      }
      return ProviderException(mapped, failure)
    `,
  });

  f.fn('streamErrorOf', {
    doc: 'An error reported inside a stream, by its code.',
    params: [
      { name: 'code', type: 'Option<string>' },
      { name: 'message', type: 'Option<string>' },
    ],
    returns: 'ProviderError',
    code: kt`
      val detail = message ?: code ?: "unknown error"
      return when (code) {
          "rate_limit_exceeded" -> ProviderError.RateLimited(null)
          "server_error" -> ProviderError.ServerError(500)
          "server_is_overloaded", "overloaded" -> ProviderError.Overloaded
          "context_length_exceeded" -> ProviderError.ContextTooLong(detail)
          else -> ProviderError.InvalidRequest(detail)
      }
    `,
  });
}

function responses(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/OpenAiResponsesProvider.kt`, { doc: 'the OpenAI Responses API adapter' });
  f.use('kotlinx.serialization.json.add', 'kotlinx.serialization.json.put');

  f.cls('OpenAiResponsesProvider', {
    doc: 'ModelProvider for OpenAI, through the Responses API.',
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
    of: 'OpenAiResponsesProvider',
    override: true,
    doc: 'A cloud provider of the OpenAI family.',
    returns: 'ProviderDescriptor',
    expression: true,
    code: kt`ProviderDescriptor(config.id, config.displayName, ProviderKind.CLOUD, config.family)`,
  });
  f.fn('models', {
    of: 'OpenAiResponsesProvider',
    override: true,
    doc: 'The configured models.',
    returns: 'List<ModelDescriptor>',
    expression: true,
    code: kt`config.models`,
  });
  f.fn('stream', {
    of: 'OpenAiResponsesProvider',
    override: true,
    doc: 'Stream one request as server-sent events.',
    params: [{ name: 'request', type: 'ModelRequest' }],
    returns: 'Flow<ModelEvent>',
    expression: true,
    code: kt`
      flow {
          val key = credentials.apiKey(config.id) ?: throw ProviderException(ProviderError.MissingCredentials)
          val spec = HttpRequestSpec(
              config.baseUrl.trimEnd('/') + "/responses",
              mapOf("Authorization" to "Bearer " + key),
              responsesBody(request, config.id).toString(),
          )
          val reader = ResponsesStreamReader(config.id)
          try {
              sseEvents(transport.stream(spec)).collect { event -> for (out in reader.accept(event)) emit(out) }
          } catch (failure: HttpStatusException) {
              throw openAiStyleFailure(failure, request.modelId)
          }
          for (out in reader.finish()) emit(out)
      }
    `,
  });
  f.fn('responsesBody', {
    doc: 'The request body. `store: false` keeps the conversation off OpenAI\'s servers; the encrypted reasoning it then returns is what lets a later request continue from it.',
    params: [
      { name: 'request', type: 'ModelRequest' },
      { name: 'providerId', type: 'string' },
    ],
    returns: 'JsonObject',
    expression: true,
    code: kt`
      buildJsonObject {
          put("model", request.modelId)
          request.system?.let { put("instructions", it) }
          put("input", JsonArray(responsesInput(request.messages, providerId)))
          if (request.tools.isNotEmpty()) {
              putJsonArray("tools") {
                  for (tool in request.tools) {
                      addJsonObject {
                          put("type", "function")
                          put("name", tool.name)
                          put("description", tool.description)
                          put("parameters", tool.inputSchema)
                      }
                  }
              }
          }
          put("max_output_tokens", request.maxOutputTokens)
          put("stream", true)
          put("store", false)
          putJsonArray("include") { add("reasoning.encrypted_content") }
      }
    `,
  });

  f.fn('responsesInput', {
    doc: 'The conversation as Responses input items. An assistant turn this provider produced is replayed as the exact output items it returned.',
    params: [
      { name: 'messages', type: 'List<PromptMessage>' },
      { name: 'providerId', type: 'string' },
    ],
    returns: 'List<JsonElement>',
    code: kt`
      val items = mutableListOf<JsonElement>()
      for (message in messages) {
          when (message) {
              is PromptMessage.User -> items.add(buildJsonObject {
                  put("role", "user")
                  put("content", message.text)
              })
              is PromptMessage.Assistant -> {
                  val replayed = message.replay?.takeIf { it.providerId == providerId }
                      ?.let { runCatching { DrakenJson.format.parseToJsonElement(it.payload) as? JsonArray }.getOrNull() }
                  if (replayed != null) {
                      items.addAll(replayed)
                  } else {
                      if (message.text.isNotBlank()) items.add(buildJsonObject {
                          put("role", "assistant")
                          put("content", message.text)
                      })
                      for (call in message.toolCalls) items.add(buildJsonObject {
                          put("type", "function_call")
                          put("call_id", call.id)
                          put("name", call.toolName)
                          put("arguments", call.argumentsJson)
                      })
                  }
              }
              is PromptMessage.ToolResults -> for (result in message.results) items.add(buildJsonObject {
                  put("type", "function_call_output")
                  put("call_id", result.callId)
                  put("output", result.content)
              })
          }
      }
      return items
    `,
  });

  f.cls('ResponsesStreamReader', {
    doc: 'Turns Responses stream events into ModelEvents.',
    fields: [
      { name: 'providerId', type: 'string', visibility: 'private' },
      { name: 'completion', type: 'Option<JsonObject>', default: 'null', readonly: false, visibility: 'private' },
      { name: 'incomplete', type: 'bool', default: 'false', readonly: false, visibility: 'private' },
      { name: 'refused', type: 'bool', default: 'false', readonly: false, visibility: 'private' },
    ],
    ctor: [{ name: 'providerId', type: 'string' }],
  });
  f.fn('accept', {
    of: 'ResponsesStreamReader',
    doc: 'The events one server-sent event produces. Function calls are reported as their output item completes, with the arguments whole.',
    params: [{ name: 'event', type: 'SseEvent' }],
    returns: 'List<ModelEvent>',
    code: kt`
      val data = parseJsonObject(event.data) ?: return emptyList()
      return when (stringField(data, "type") ?: event.event) {
          "response.output_text.delta" -> listOfNotNull(stringField(data, "delta")?.let { ModelEvent.TextDelta(it) })
          "response.refusal.delta" -> {
              refused = true
              listOfNotNull(stringField(data, "delta")?.let { ModelEvent.TextDelta(it) })
          }
          "response.output_item.done" -> {
              val item = objectField(data, "item")
              if (stringField(item, "type") != "function_call") return emptyList()
              val call = ToolCall(
                  stringField(item, "call_id") ?: stringField(item, "id").orEmpty(),
                  stringField(item, "name").orEmpty(),
                  stringField(item, "arguments")?.ifBlank { "{}" } ?: "{}",
              )
              listOf(ModelEvent.ToolCallRequested(call))
          }
          "response.completed" -> {
              completion = objectField(data, "response")
              emptyList()
          }
          "response.incomplete" -> {
              completion = objectField(data, "response")
              incomplete = true
              emptyList()
          }
          "response.failed" -> {
              val error = objectField(objectField(data, "response"), "error")
              throw ProviderException(streamErrorOf(stringField(error, "code"), stringField(error, "message")))
          }
          "error" -> throw ProviderException(streamErrorOf(stringField(data, "code"), stringField(data, "message")))
          else -> emptyList()
      }
    `,
  });
  f.fn('finish', {
    of: 'ResponsesStreamReader',
    doc: 'Usage and the final event, replaying the response\'s output items.',
    returns: 'List<ModelEvent>',
    code: kt`
      val response = completion
          ?: throw ProviderException(ProviderError.MalformedResponse("the stream ended before the response completed"))
      val output = arrayField(response, "output")
      val usage = objectField(response, "usage")
      val calledTools = output.any { stringField(it as? JsonObject, "type") == "function_call" }
      val reason = stringField(objectField(response, "incomplete_details"), "reason")
      val stop = when {
          incomplete && reason == "content_filter" -> StopReason.REFUSAL
          incomplete -> StopReason.MAX_TOKENS
          refused -> StopReason.REFUSAL
          calledTools -> StopReason.TOOL_USE
          else -> StopReason.END_TURN
      }
      return listOf(
          ModelEvent.UsageReport(longField(usage, "input_tokens") ?: 0L, longField(usage, "output_tokens") ?: 0L),
          ModelEvent.Finished(stop, ProviderReplay(providerId, output.toString())),
      )
    `,
  });
}

function chatCompletions(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/ChatCompletionsProvider.kt`, { doc: 'the Chat Completions adapter' });
  f.use('kotlinx.serialization.json.put');

  f.cls('ChatCompletionsProvider', {
    doc: 'ModelProvider for Chat Completions servers: DeepSeek, and self-hosted OpenAI-compatible endpoints. A provider whose config needs no key (a server on the local network) sends none.',
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
    of: 'ChatCompletionsProvider',
    override: true,
    doc: 'A cloud provider of the configured family.',
    returns: 'ProviderDescriptor',
    expression: true,
    code: kt`ProviderDescriptor(config.id, config.displayName, ProviderKind.CLOUD, config.family)`,
  });
  f.fn('models', {
    of: 'ChatCompletionsProvider',
    override: true,
    doc: 'The configured models.',
    returns: 'List<ModelDescriptor>',
    expression: true,
    code: kt`config.models`,
  });
  f.fn('stream', {
    of: 'ChatCompletionsProvider',
    override: true,
    doc: 'Stream one request as server-sent events.',
    params: [{ name: 'request', type: 'ModelRequest' }],
    returns: 'Flow<ModelEvent>',
    expression: true,
    code: kt`
      flow {
          val key = credentials.apiKey(config.id)
          if (key == null && config.family == ProviderFamily.DEEPSEEK) throw ProviderException(ProviderError.MissingCredentials)
          val headers = if (key != null) mapOf("Authorization" to "Bearer " + key) else emptyMap()
          val spec = HttpRequestSpec(
              config.baseUrl.trimEnd('/') + "/chat/completions",
              headers,
              chatCompletionsBody(request, config.id, config.family == ProviderFamily.DEEPSEEK).toString(),
          )
          val reader = ChatCompletionsStreamReader(config.id)
          try {
              sseEvents(transport.stream(spec)).collect { event -> for (out in reader.accept(event)) emit(out) }
          } catch (failure: HttpStatusException) {
              throw openAiStyleFailure(failure, request.modelId)
          }
          for (out in reader.finish()) emit(out)
      }
    `,
  });

  f.fn('chatCompletionsBody', {
    doc: 'The request body. With `replayReasoning`, every assistant turn carries `reasoning_content` - its own when it has one, empty otherwise - because DeepSeek rejects a tool conversation without it.',
    params: [
      { name: 'request', type: 'ModelRequest' },
      { name: 'providerId', type: 'string' },
      { name: 'replayReasoning', type: 'bool' },
    ],
    returns: 'JsonObject',
    code: kt`
      val messages = mutableListOf<JsonElement>()
      request.system?.let { system -> messages.add(buildJsonObject {
          put("role", "system")
          put("content", system)
      }) }
      for (message in request.messages) {
          when (message) {
              is PromptMessage.User -> messages.add(buildJsonObject {
                  put("role", "user")
                  put("content", message.text)
              })
              is PromptMessage.Assistant -> messages.add(buildJsonObject {
                  put("role", "assistant")
                  put("content", message.text)
                  if (message.toolCalls.isNotEmpty()) {
                      putJsonArray("tool_calls") {
                          for (call in message.toolCalls) addJsonObject {
                              put("id", call.id)
                              put("type", "function")
                              putJsonObject("function") {
                                  put("name", call.toolName)
                                  put("arguments", call.argumentsJson)
                              }
                          }
                      }
                  }
                  if (replayReasoning && request.tools.isNotEmpty()) {
                      val own = message.replay?.takeIf { it.providerId == providerId }?.let { parseJsonObject(it.payload) }
                      put("reasoning_content", stringField(own, "reasoning_content").orEmpty())
                  }
              })
              is PromptMessage.ToolResults -> for (result in message.results) messages.add(buildJsonObject {
                  put("role", "tool")
                  put("tool_call_id", result.callId)
                  put("content", result.content)
              })
          }
      }
      return buildJsonObject {
          put("model", request.modelId)
          put("messages", JsonArray(messages))
          if (request.tools.isNotEmpty()) {
              putJsonArray("tools") {
                  for (tool in request.tools) addJsonObject {
                      put("type", "function")
                      putJsonObject("function") {
                          put("name", tool.name)
                          put("description", tool.description)
                          put("parameters", tool.inputSchema)
                      }
                  }
              }
          }
          put("max_tokens", request.maxOutputTokens)
          put("stream", true)
          putJsonObject("stream_options") { put("include_usage", true) }
      }
    `,
  });

  f.record(
    'PartialToolCall',
    [
      { name: 'id', type: 'string', readonly: false },
      { name: 'name', type: 'string', readonly: false },
      { name: 'arguments', type: 'StringBuilder' },
    ],
    { doc: 'A tool call assembled from streamed fragments.' },
  );

  f.cls('ChatCompletionsStreamReader', {
    doc: 'Turns Chat Completions chunks into ModelEvents. Tool calls stream in fragments keyed by index, so they are reported once the stream ends and their arguments are whole.',
    fields: [
      { name: 'providerId', type: 'string', visibility: 'private' },
      { name: 'calls', type: 'MutableMap<i64, PartialToolCall>', default: 'sortedMapOf()', visibility: 'private', doc: 'Sorted by index, so calls are reported in the order the model made them.' },
      { name: 'reasoning', type: 'StringBuilder', default: 'StringBuilder()', visibility: 'private' },
      { name: 'finishReason', type: 'Option<string>', default: 'null', readonly: false, visibility: 'private' },
      { name: 'inputTokens', type: 'i64', default: '0L', readonly: false, visibility: 'private' },
      { name: 'outputTokens', type: 'i64', default: '0L', readonly: false, visibility: 'private' },
      { name: 'done', type: 'bool', default: 'false', readonly: false, visibility: 'private' },
    ],
    ctor: [{ name: 'providerId', type: 'string' }],
  });
  f.fn('accept', {
    of: 'ChatCompletionsStreamReader',
    doc: 'The events one chunk produces.',
    params: [{ name: 'event', type: 'SseEvent' }],
    returns: 'List<ModelEvent>',
    code: kt`
      if (event.data.trim() == "[DONE]") {
          done = true
          return emptyList()
      }
      val chunk = parseJsonObject(event.data) ?: return emptyList()
      objectField(chunk, "error")?.let {
          throw ProviderException(streamErrorOf(stringField(it, "code"), stringField(it, "message")))
      }
      objectField(chunk, "usage")?.let {
          inputTokens = longField(it, "prompt_tokens") ?: inputTokens
          outputTokens = longField(it, "completion_tokens") ?: outputTokens
      }
      val choice = arrayField(chunk, "choices").firstOrNull() as? JsonObject ?: return emptyList()
      stringField(choice, "finish_reason")?.let { finishReason = it }
      val delta = objectField(choice, "delta") ?: return emptyList()
      stringField(delta, "reasoning_content")?.let { reasoning.append(it) }
      for (fragment in arrayField(delta, "tool_calls")) {
          val part = fragment as? JsonObject ?: continue
          val index = longField(part, "index") ?: calls.size.toLong()
          val call = calls.getOrPut(index) { PartialToolCall("", "", StringBuilder()) }
          stringField(part, "id")?.let { call.id = it }
          val function = objectField(part, "function")
          stringField(function, "name")?.let { call.name += it }
          stringField(function, "arguments")?.let { call.arguments.append(it) }
      }
      return listOfNotNull(stringField(delta, "content")?.takeIf { it.isNotEmpty() }?.let { ModelEvent.TextDelta(it) })
    `,
  });
  f.fn('finish', {
    of: 'ChatCompletionsStreamReader',
    doc: 'The assembled tool calls, usage and the final event.',
    returns: 'List<ModelEvent>',
    code: kt`
      if (!done && finishReason == null) {
          throw ProviderException(ProviderError.MalformedResponse("the stream ended without a finish reason"))
      }
      val out = mutableListOf<ModelEvent>()
      for ((index, call) in calls) {
          val id = call.id.ifBlank { "call_" + index }
          out.add(ModelEvent.ToolCallRequested(ToolCall(id, call.name, call.arguments.toString().ifBlank { "{}" })))
      }
      out.add(ModelEvent.UsageReport(inputTokens, outputTokens))
      val stop = when {
          finishReason == "length" -> StopReason.MAX_TOKENS
          finishReason == "content_filter" -> StopReason.REFUSAL
          calls.isNotEmpty() -> StopReason.TOOL_USE
          finishReason == "stop" -> StopReason.END_TURN
          else -> StopReason.OTHER
      }
      val replay = if (reasoning.isEmpty()) null else ProviderReplay(
          providerId,
          buildJsonObject { put("reasoning_content", reasoning.toString()) }.toString(),
      )
      out.add(ModelEvent.Finished(stop, replay))
      return out
    `,
  });
}
