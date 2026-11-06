/**
 * Claude, through the official Anthropic Java SDK.
 *
 * The SDK rather than hand-written HTTP: it tracks the API's request and event
 * shapes as they change, and its typed errors carry status and headers. Its own
 * retries are off - Draken's RetryPolicy is the only one, so a request is never
 * retried twice over.
 *
 * Three behaviours worth knowing:
 *  - Every assistant turn is kept as the SDK's own message parameter (thinking
 *    blocks and signatures included) and sent back unchanged. Current Claude
 *    models bind thinking blocks to the conversation that produced them.
 *  - Thinking-block binding is set to `drop_block`: when the history changes
 *    underneath a block - the context window moved, a module changed the tool
 *    set - the block is dropped and the request proceeds, rather than failing.
 *  - Server-side refusal fallback is on for the models that offer it, so a
 *    classifier refusal is answered by a fallback model instead of nothing.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core/provider/anthropic';
const SDK = 'com.anthropic.models.beta.messages';

export function buildAnthropic(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/AnthropicProvider.kt`, { doc: 'the Claude adapter' });
  f.use(
    'com.anthropic.client.AnthropicClient',
    'com.anthropic.client.okhttp.AnthropicOkHttpClient',
    'com.anthropic.core.JsonValue',
    'com.anthropic.errors.AnthropicIoException',
    'com.anthropic.errors.AnthropicServiceException',
    'com.anthropic.errors.NotFoundException',
    'com.anthropic.errors.PermissionDeniedException',
    'com.anthropic.errors.RateLimitException',
    'com.anthropic.errors.UnauthorizedException',
    'com.anthropic.helpers.BetaMessageAccumulator',
    'com.anthropic.models.ErrorType',
    `${SDK}.BetaContentBlockParam`,
    `${SDK}.BetaMessageParam`,
    `${SDK}.BetaRawMessageStreamEvent`,
    `${SDK}.BetaStopReason`,
    `${SDK}.BetaThinkingBlockBinding`,
    `${SDK}.BetaThinkingConfigAdaptive`,
    `${SDK}.BetaThinkingPrefixMismatchBehavior`,
    `${SDK}.BetaTool`,
    `${SDK}.BetaToolResultBlockParam`,
    `${SDK}.BetaToolUseBlockParam`,
    `${SDK}.MessageCreateParams`,
    'kotlinx.coroutines.job',
  );

  f.decl(
    kt`
      /** Lets a request carry block_binding, and reports dropped blocks. */
      private const val THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01"

      /** Server-side refusal fallback, routed by refusal category. */
      private const val REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01"

      /** Models that accept fallbacks: "default"; others reject the parameter. */
      private val REFUSAL_FALLBACK_MODELS = setOf("claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5")
    `,
    { doc: 'Beta flags and the models server-side fallback applies to.' },
  );

  f.cls('AnthropicProvider', {
    doc: 'ModelProvider for the Claude API.',
    implements: ['ModelProvider'],
    fields: [
      { name: 'config', type: 'CloudProviderConfig', visibility: 'private' },
      { name: 'credentials', type: 'CredentialSource', visibility: 'private' },
      { name: 'clientKey', type: 'Option<string>', default: 'null', readonly: false, visibility: 'private' },
      { name: 'client', type: 'Option<AnthropicClient>', default: 'null', readonly: false, visibility: 'private' },
    ],
    ctor: [
      { name: 'config', type: 'CloudProviderConfig' },
      { name: 'credentials', type: 'CredentialSource' },
    ],
  });

  f.fn('descriptor', {
    of: 'AnthropicProvider',
    override: true,
    doc: 'A cloud provider of the Anthropic family.',
    returns: 'ProviderDescriptor',
    expression: true,
    code: kt`ProviderDescriptor(config.id, config.displayName, ProviderKind.CLOUD, ProviderFamily.ANTHROPIC)`,
  });

  f.fn('models', {
    of: 'AnthropicProvider',
    override: true,
    doc: 'The configured models.',
    returns: 'List<ModelDescriptor>',
    expression: true,
    code: kt`config.models`,
  });

  f.fn('stream', {
    of: 'AnthropicProvider',
    override: true,
    doc: 'Stream one request. The SDK call blocks, so it runs on the IO dispatcher; cancelling the collector closes the response, which ends the read.',
    params: [{ name: 'request', type: 'ModelRequest' }],
    returns: 'Flow<ModelEvent>',
    expression: true,
    code: kt`
      flow {
          val key = credentials.apiKey(config.id) ?: throw ProviderException(ProviderError.MissingCredentials)
          val params = anthropicParams(request, config.id)
          val response = try {
              clientFor(key).beta().messages().createStreaming(params)
          } catch (failure: Exception) {
              throw anthropicFailure(failure, request.modelId)
          }
          val closing = currentCoroutineContext().job.invokeOnCompletion { response.close() }
          try {
              val reader = AnthropicStreamReader()
              val events = response.stream().iterator()
              while (true) {
                  val event = try {
                      if (!events.hasNext()) break
                      events.next()
                  } catch (failure: Exception) {
                      currentCoroutineContext().ensureActive()
                      throw anthropicFailure(failure, request.modelId)
                  }
                  for (out in reader.accept(event)) emit(out)
              }
              for (out in reader.finish(config.id)) emit(out)
          } finally {
              closing.dispose()
              response.close()
          }
      }.flowOn(Dispatchers.IO)
    `,
  });

  f.fn('clientFor', {
    of: 'AnthropicProvider',
    visibility: 'private',
    annotations: ['Synchronized'],
    doc: 'The SDK client for a key, rebuilt when the key changes so a replaced key is never used again.',
    params: [{ name: 'key', type: 'string' }],
    returns: 'AnthropicClient',
    code: kt`
      val current = client
      if (current != null && clientKey == key) return current
      current?.close()
      val created = AnthropicOkHttpClient.builder()
          .apiKey(key)
          .baseUrl(config.baseUrl)
          .maxRetries(0)
          .timeout(Duration.ofMinutes(10))
          .build()
      client = created
      clientKey = key
      return created
    `,
  });

  // -- reading the stream ------------------------------------------------------

  f.cls('AnthropicStreamReader', {
    doc: 'Turns the SDK\'s stream events into ModelEvents, and keeps the whole message for replay.',
    fields: [
      { name: 'accumulator', type: 'BetaMessageAccumulator', default: 'BetaMessageAccumulator.create()', visibility: 'private' },
      { name: 'toolHeads', type: 'MutableMap<i64, ToolCall>', default: 'mutableMapOf()', visibility: 'private' },
      { name: 'toolInputs', type: 'MutableMap<i64, StringBuilder>', default: 'mutableMapOf()', visibility: 'private' },
      { name: 'started', type: 'bool', default: 'false', readonly: false, visibility: 'private' },
      { name: 'stopReason', type: 'StopReason', default: 'StopReason.OTHER', readonly: false, visibility: 'private' },
      { name: 'inputTokens', type: 'i64', default: '0L', readonly: false, visibility: 'private' },
      { name: 'outputTokens', type: 'i64', default: '0L', readonly: false, visibility: 'private' },
    ],
  });

  f.fn('accept', {
    of: 'AnthropicStreamReader',
    doc: 'The events one stream event produces. A tool call is reported when its block closes, with its input complete.',
    params: [{ name: 'event', type: 'BetaRawMessageStreamEvent' }],
    returns: 'List<ModelEvent>',
    code: kt`
      accumulator.accumulate(event)
      val out = mutableListOf<ModelEvent>()
      event.messageStart().orElse(null)?.let {
          started = true
          inputTokens = it.message().usage().inputTokens()
      }
      event.contentBlockStart().orElse(null)?.let { start ->
          start.contentBlock().toolUse().orElse(null)?.let { tool ->
              toolHeads[start.index()] = ToolCall(tool.id(), tool.name(), "")
              toolInputs[start.index()] = StringBuilder()
          }
      }
      event.contentBlockDelta().orElse(null)?.let { delta ->
          delta.delta().text().orElse(null)?.let { if (it.text().isNotEmpty()) out.add(ModelEvent.TextDelta(it.text())) }
          delta.delta().inputJson().orElse(null)?.let { toolInputs[delta.index()]?.append(it.partialJson()) }
      }
      event.contentBlockStop().orElse(null)?.let { stop ->
          toolHeads.remove(stop.index())?.let { head ->
              val input = toolInputs.remove(stop.index())?.toString().orEmpty().ifBlank { "{}" }
              out.add(ModelEvent.ToolCallRequested(head.copy(argumentsJson = input)))
          }
      }
      event.messageDelta().orElse(null)?.let { delta ->
          delta.delta().stopReason().orElse(null)?.let { stopReason = anthropicStopReason(it) }
          outputTokens = delta.usage().outputTokens()
      }
      return out
    `,
  });

  f.fn('finish', {
    of: 'AnthropicStreamReader',
    doc: 'Usage and the final event, with the complete message as replay.',
    params: [{ name: 'providerId', type: 'string' }],
    returns: 'List<ModelEvent>',
    code: kt`
      if (!started) throw ProviderException(ProviderError.MalformedResponse("the stream ended before the message started"))
      // Through the SDK's own JSON mapping, so the replayed turn is exactly what it would send.
      val wire = JsonValue.from(accumulator.message().toParam()).convert(Any::class.java)
      val replay = ProviderReplay(providerId, fromPlainValue(wire).toString())
      return listOf(ModelEvent.UsageReport(inputTokens, outputTokens), ModelEvent.Finished(stopReason, replay))
    `,
  });

  f.fn('anthropicStopReason', {
    visibility: 'private',
    doc: 'The SDK\'s stop reason in Draken\'s terms.',
    params: [{ name: 'reason', type: 'BetaStopReason' }],
    returns: 'StopReason',
    expression: true,
    code: kt`
      when (reason) {
          BetaStopReason.TOOL_USE -> StopReason.TOOL_USE
          BetaStopReason.END_TURN, BetaStopReason.STOP_SEQUENCE -> StopReason.END_TURN
          BetaStopReason.MAX_TOKENS, BetaStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED -> StopReason.MAX_TOKENS
          BetaStopReason.REFUSAL -> StopReason.REFUSAL
          else -> StopReason.OTHER
      }
    `,
  });

  // -- building the request ----------------------------------------------------

  f.fn('anthropicParams', {
    doc: 'The SDK request for a ModelRequest.',
    params: [
      { name: 'request', type: 'ModelRequest' },
      { name: 'providerId', type: 'string' },
    ],
    returns: 'MessageCreateParams',
    code: kt`
      val binding = BetaThinkingBlockBinding.builder()
          .prefixMismatchBehavior(BetaThinkingPrefixMismatchBehavior.DROP_BLOCK)
          .build()
      val builder = MessageCreateParams.builder()
          .model(request.modelId)
          .maxTokens(request.maxOutputTokens)
          .thinking(BetaThinkingConfigAdaptive.builder().blockBinding(binding).build())
          .addBeta(THINKING_BINDING_BETA)
      request.system?.let { builder.system(it) }
      if (request.modelId in REFUSAL_FALLBACK_MODELS) builder.fallbacksDefault().addBeta(REFUSAL_FALLBACK_BETA)
      for (message in request.messages) anthropicMessage(message, providerId)?.let { builder.addMessage(it) }
      for (tool in request.tools) builder.addTool(anthropicTool(tool))
      return builder.build()
    `,
  });

  f.fn('anthropicMessage', {
    doc: 'One prompt message as an SDK message parameter. An assistant turn this adapter produced is restored exactly; anything else is rebuilt from its text and tool calls. An empty assistant turn is dropped - the API rejects one.',
    params: [
      { name: 'message', type: 'PromptMessage' },
      { name: 'providerId', type: 'string' },
    ],
    returns: 'Option<BetaMessageParam>',
    code: kt`
      return when (message) {
          is PromptMessage.User ->
              BetaMessageParam.builder().role(BetaMessageParam.Role.USER).content(message.text).build()
          is PromptMessage.ToolResults ->
              BetaMessageParam.builder()
                  .role(BetaMessageParam.Role.USER)
                  .contentOfBetaContentBlockParams(
                      message.results.map {
                          BetaContentBlockParam.ofToolResult(
                              BetaToolResultBlockParam.builder().toolUseId(it.callId).content(it.content).isError(it.isError).build(),
                          )
                      },
                  )
                  .build()
          is PromptMessage.Assistant -> {
              val replay = message.replay?.takeIf { it.providerId == providerId }
              val restored = replay?.let { stored ->
                  parseJsonObject(stored.payload)?.let { wire ->
                      runCatching { JsonValue.from(toPlainValue(wire)).convert(BetaMessageParam::class.java) }.getOrNull()
                  }
              }
              restored ?: rebuiltAssistant(message)
          }
      }
    `,
  });

  f.fn('rebuiltAssistant', {
    visibility: 'private',
    doc: 'An assistant turn rebuilt from its text and tool calls, for one another provider wrote.',
    params: [{ name: 'message', type: 'PromptMessage.Assistant' }],
    returns: 'Option<BetaMessageParam>',
    code: kt`
      val blocks = mutableListOf<BetaContentBlockParam>()
      if (message.text.isNotBlank()) blocks.add(BetaContentBlockParam.ofText(message.text))
      for (call in message.toolCalls) {
          val input = BetaToolUseBlockParam.Input.builder()
              .putAllAdditionalProperties(jsonValues(parseJsonObject(call.argumentsJson) ?: JsonObject(emptyMap())))
              .build()
          blocks.add(BetaContentBlockParam.ofToolUse(BetaToolUseBlockParam.builder().id(call.id).name(call.toolName).input(input).build()))
      }
      if (blocks.isEmpty()) return null
      return BetaMessageParam.builder().role(BetaMessageParam.Role.ASSISTANT).contentOfBetaContentBlockParams(blocks).build()
    `,
  });

  f.fn('anthropicTool', {
    doc: 'A tool definition as an SDK tool. Input streams eagerly; the tool pipeline validates every argument before anything runs.',
    params: [{ name: 'tool', type: 'ToolDefinition' }],
    returns: 'BetaTool',
    code: kt`
      val schema = tool.inputSchema
      val properties = BetaTool.InputSchema.Properties.builder()
          .putAllAdditionalProperties(jsonValues(objectField(schema, "properties") ?: JsonObject(emptyMap())))
          .build()
      val required = arrayField(schema, "required").mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
      val input = BetaTool.InputSchema.builder().properties(properties).required(required)
      schema["additionalProperties"]?.let { input.putAdditionalProperty("additionalProperties", JsonValue.from(toPlainValue(it))) }
      return BetaTool.builder()
          .name(tool.name)
          .description(tool.description)
          .inputSchema(input.build())
          .eagerInputStreaming(true)
          .build()
    `,
  });

  f.fn('jsonValues', {
    visibility: 'private',
    doc: 'Each member of a JSON object as the SDK\'s JsonValue.',
    params: [{ name: 'obj', type: 'JsonObject' }],
    returns: 'Map<string, JsonValue>',
    expression: true,
    code: kt`obj.mapValues { JsonValue.from(toPlainValue(it.value)) }`,
  });

  // -- failures ------------------------------------------------------------------

  f.fn('anthropicFailure', {
    doc: 'Whatever the SDK threw, as a ProviderException.',
    params: [
      { name: 'failure', type: 'Exception' },
      { name: 'modelId', type: 'string' },
    ],
    returns: 'ProviderException',
    code: kt`
      if (failure is ProviderException) return failure
      val detail = failure.message ?: failure.javaClass.simpleName
      val error = when (failure) {
          is UnauthorizedException -> ProviderError.Authentication(detail)
          is PermissionDeniedException -> ProviderError.PermissionDenied(detail)
          is NotFoundException -> ProviderError.ModelNotFound(modelId)
          is RateLimitException -> ProviderError.RateLimited(parseRetryAfter(failure.headers().values("retry-after").firstOrNull()))
          is AnthropicServiceException -> when {
              failure.statusCode() == 529 || failure.errorType().orElse(null) == ErrorType.OVERLOADED_ERROR -> ProviderError.Overloaded
              failure.statusCode() == 413 || detail.contains("prompt is too long", ignoreCase = true) -> ProviderError.ContextTooLong(detail)
              failure.statusCode() >= 500 -> ProviderError.ServerError(failure.statusCode().toLong())
              else -> ProviderError.InvalidRequest(detail)
          }
          is AnthropicIoException ->
              if (failure.cause is SocketTimeoutException) ProviderError.Timeout else ProviderError.Network(detail)
          else -> ProviderError.MalformedResponse(detail)
      }
      return ProviderException(error, failure)
    `,
  });
}
