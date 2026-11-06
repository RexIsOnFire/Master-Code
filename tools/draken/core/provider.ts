/**
 * The contract every model provider implements, local or cloud.
 *
 * A provider turns a request into a cold stream of events. Collecting starts
 * the request, cancelling the collector cancels it, and failures arrive as a
 * `ProviderException` carrying a `ProviderError` - never as a raw HTTP or JSON
 * exception, so nothing above this layer handles transport details.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core/provider';

export function buildProviderContract(ctx: Ctx): void {
  provider(ctx);
  request(ctx);
  events(ctx);
  errors(ctx);
  transport(ctx);
  sse(ctx);
  retry(ctx);
}

function provider(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/ModelProvider.kt`, { doc: 'providers, models and capabilities' });

  f.enm('ProviderKind', ['LOCAL', 'CLOUD'], {
    doc: 'Whether a request stays on the device. Routing policy is written in terms of this, not of vendors.',
  });

  f.enm('ProviderFamily', ['ANTHROPIC', 'OPENAI', 'GEMINI', 'DEEPSEEK', 'OPENAI_COMPATIBLE', 'ON_DEVICE'], {
    doc: 'Which wire protocol and vendor a provider speaks.',
  });

  f.record(
    'ProviderDescriptor',
    [
      { name: 'id', type: 'string', doc: 'Stable identifier used in settings and on every message it produced.' },
      { name: 'displayName', type: 'string' },
      { name: 'kind', type: 'ProviderKind' },
      { name: 'family', type: 'ProviderFamily' },
    ],
    { doc: 'What a provider is, independent of whether it is currently usable.' },
  );

  f.record(
    'ModelCapabilities',
    [
      { name: 'contextTokens', type: 'i64', doc: 'Input the model accepts, in tokens.' },
      { name: 'maxOutputTokens', type: 'i64' },
      { name: 'supportsTools', type: 'bool' },
      { name: 'supportsImages', type: 'bool' },
      {
        name: 'documented',
        type: 'bool',
        doc: 'True when these figures come from the vendor\'s documentation; false when they are conservative assumptions about a model this build does not know.',
      },
    ],
    { doc: 'What a model can do. Routing refuses a task a model cannot do rather than letting the request fail.' },
  );

  f.record(
    'ModelDescriptor',
    [
      { name: 'providerId', type: 'string' },
      { name: 'modelId', type: 'string', doc: 'The id the provider\'s API takes.' },
      { name: 'displayName', type: 'string' },
      { name: 'capabilities', type: 'ModelCapabilities' },
    ],
    { doc: 'One model a provider offers.' },
  );

  f.iface(
    'ModelProvider',
    [
      { name: 'descriptor', returns: 'ProviderDescriptor', doc: 'What this provider is.' },
      {
        name: 'models',
        returns: 'List<ModelDescriptor>',
        doc: 'Models this provider can serve right now. Empty means it cannot serve anything, e.g. no local model is installed.',
      },
      {
        name: 'stream',
        params: [{ name: 'request', type: 'ModelRequest' }],
        returns: 'Flow<ModelEvent>',
        doc: 'Run a request as a cold stream. Cancelling collection cancels the request; failures are ProviderException.',
      },
    ],
    { doc: 'A source of model output: an on-device runtime or a cloud API.' },
  );
}

function request(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/ModelRequest.kt`, { doc: 'what is sent to a model' });

  f.enm(
    'PromptMessage',
    [
      { name: 'User', payload: [{ name: 'text', type: 'string' }] },
      {
        name: 'Assistant',
        payload: [
          { name: 'text', type: 'string' },
          { name: 'toolCalls', type: 'List<ToolCall>' },
          { name: 'replay', type: 'Option<ProviderReplay>' },
        ],
      },
      { name: 'ToolResults', payload: [{ name: 'results', type: 'List<ToolResultRecord>' }] },
    ],
    { doc: 'A message in the provider-neutral prompt. Adapters translate these into each vendor\'s wire format.' },
  );

  f.record(
    'ToolDefinition',
    [
      { name: 'name', type: 'string', doc: 'The wire name: letters, digits, underscore and hyphen, as every vendor accepts.' },
      { name: 'description', type: 'string' },
      { name: 'inputSchema', type: 'JsonObject', doc: 'A JSON Schema object describing the arguments.' },
    ],
    { doc: 'A tool offered to the model.' },
  );


  f.record(
    'ModelRequest',
    [
      { name: 'modelId', type: 'string' },
      { name: 'system', type: 'Option<string>' },
      { name: 'messages', type: 'List<PromptMessage>' },
      { name: 'tools', type: 'List<ToolDefinition>', default: 'emptyList()' },
      { name: 'maxOutputTokens', type: 'i64', default: '4096L' },
    ],
    { doc: 'One request to a model: the assembled context, never more than the context policy allowed.' },
  );
}

function events(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/ModelEvent.kt`, { doc: 'what a model streams back' });

  f.enm('StopReason', ['END_TURN', 'TOOL_USE', 'MAX_TOKENS', 'REFUSAL', 'OTHER'], {
    doc: 'Why a model stopped. Tools run only on TOOL_USE: a call cut off by MAX_TOKENS may be incomplete.',
  });

  f.enm(
    'ModelEvent',
    [
      { name: 'TextDelta', payload: [{ name: 'text', type: 'string' }] },
      { name: 'ToolCallRequested', payload: [{ name: 'call', type: 'ToolCall' }] },
      {
        name: 'UsageReport',
        payload: [
          { name: 'inputTokens', type: 'i64' },
          { name: 'outputTokens', type: 'i64' },
        ],
      },
      {
        name: 'Finished',
        payload: [
          { name: 'stopReason', type: 'StopReason' },
          { name: 'replay', type: 'Option<ProviderReplay>' },
        ],
      },
    ],
    {
      doc: 'One step of a streamed response. A stream ends with exactly one Finished, or with a ProviderException.',
    },
  );
}

function errors(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/ProviderError.kt`, { doc: 'how provider failures are described' });

  f.enm(
    'ProviderError',
    [
      'MissingCredentials',
      { name: 'Authentication', payload: [{ name: 'detail', type: 'string' }] },
      { name: 'PermissionDenied', payload: [{ name: 'detail', type: 'string' }] },
      { name: 'ModelNotFound', payload: [{ name: 'modelId', type: 'string' }] },
      { name: 'RateLimited', payload: [{ name: 'retryAfterMillis', type: 'Option<i64>' }] },
      'Overloaded',
      { name: 'ContextTooLong', payload: [{ name: 'detail', type: 'string' }] },
      { name: 'InvalidRequest', payload: [{ name: 'detail', type: 'string' }] },
      { name: 'Network', payload: [{ name: 'detail', type: 'string' }] },
      'Timeout',
      { name: 'ServerError', payload: [{ name: 'status', type: 'i64' }] },
      { name: 'MalformedResponse', payload: [{ name: 'detail', type: 'string' }] },
      { name: 'Unsupported', payload: [{ name: 'feature', type: 'string' }] },
      { name: 'Unavailable', payload: [{ name: 'detail', type: 'string' }] },
    ],
    {
      doc: 'Everything that can go wrong talking to a model, in terms a person can act on. Vendor error bodies are mapped onto these by each adapter.',
    },
  );

  f.fn('describeProviderError', {
    doc: 'A sentence for the user saying what failed and what to do about it.',
    params: [{ name: 'error', type: 'ProviderError' }],
    returns: 'string',
    code: kt`
      return when (error) {
          ProviderError.MissingCredentials -> "No API key is saved for this provider. Add one in Settings."
          is ProviderError.Authentication -> "The provider rejected the API key. Check it in Settings. (" + error.detail + ")"
          is ProviderError.PermissionDenied -> "The API key is not allowed to do this. (" + error.detail + ")"
          is ProviderError.ModelNotFound -> "The provider does not offer the model \"" + error.modelId + "\"."
          is ProviderError.RateLimited -> error.retryAfterMillis
              ?.let { "The provider is rate-limiting requests. Try again in " + ((it + 999) / 1000) + " s." }
              ?: "The provider is rate-limiting requests. Try again shortly."
          ProviderError.Overloaded -> "The provider is overloaded. Try again shortly."
          is ProviderError.ContextTooLong -> "The conversation is too long for this model. (" + error.detail + ")"
          is ProviderError.InvalidRequest -> "The provider refused the request. (" + error.detail + ")"
          is ProviderError.Network -> "Could not reach the provider. (" + error.detail + ")"
          ProviderError.Timeout -> "The provider did not answer in time."
          is ProviderError.ServerError -> "The provider failed with HTTP " + error.status + "."
          is ProviderError.MalformedResponse -> "The provider sent a response this app could not read. (" + error.detail + ")"
          is ProviderError.Unsupported -> "This model cannot " + error.feature + "."
          is ProviderError.Unavailable -> error.detail
      }
    `,
  });

  f.fn('isRetryable', {
    doc: 'True for failures that can pass on their own. Credentials, permissions and bad requests never do.',
    params: [{ name: 'error', type: 'ProviderError' }],
    returns: 'bool',
    expression: true,
    code: kt`
      error is ProviderError.RateLimited || error == ProviderError.Overloaded || error is ProviderError.Network ||
          error == ProviderError.Timeout || error is ProviderError.ServerError
    `,
  });

  f.decl(
    kt`
      /** A provider failure. The message is the user-facing description. */
      class ProviderException(val error: ProviderError, cause: Throwable? = null) :
          Exception(describeProviderError(error), cause)
    `,
    {
      doc: 'Exception carrying a ProviderError; a declaration because its superclass constructor takes arguments.',
      provides: ['ProviderException'],
    },
  );
}

function transport(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/http/HttpTransport.kt`, { doc: 'the HTTP seam adapters stream through' });

  f.record(
    'HttpRequestSpec',
    [
      { name: 'url', type: 'string' },
      { name: 'headers', type: 'Map<string, string>' },
      { name: 'body', type: 'string' },
    ],
    { doc: 'A POST with a JSON body. Headers carry credentials, so a spec is never logged.' },
  );

  f.iface(
    'HttpTransport',
    [
      {
        name: 'stream',
        params: [{ name: 'request', type: 'HttpRequestSpec' }],
        returns: 'Flow<string>',
        doc: 'POST the request and emit the response body line by line. A non-2xx response is an HttpStatusException carrying the body; a connection failure or timeout is a ProviderException. Cancelling collection cancels the call.',
      },
    ],
    { doc: 'How adapters reach the network. Production uses OkHttp; tests substitute scripted responses.' },
  );

  f.decl(
    kt`
      /** A response outside 2xx. The adapter reads the vendor's error body to say what went wrong. */
      class HttpStatusException(val status: Int, val body: String, val retryAfterMillis: Long?) :
          Exception("HTTP " + status)
    `,
    { doc: 'Non-2xx response, before an adapter interprets it.', provides: ['HttpStatusException'] },
  );

  f.fn('parseRetryAfter', {
    doc: 'The Retry-After header as milliseconds. Only the delta-seconds form is read; an HTTP date is rare from these APIs and treated as absent.',
    params: [{ name: 'value', type: 'Option<string>' }],
    returns: 'Option<i64>',
    expression: true,
    code: kt`value?.trim()?.toDoubleOrNull()?.takeIf { it >= 0 }?.let { (it * 1000).toLong() }`,
  });
}

function sse(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/http/ServerSentEvents.kt`, { doc: 'server-sent event parsing' });

  f.record(
    'SseEvent',
    [
      { name: 'event', type: 'Option<string>', doc: 'The `event:` field, when the server names its events.' },
      { name: 'data', type: 'string', doc: 'All `data:` lines of the event, joined with newlines.' },
    ],
    { doc: 'One server-sent event.' },
  );

  f.cls('SseParser', {
    doc: 'Assembles server-sent events from body lines, as the HTML Living Standard defines: fields accumulate until a blank line dispatches them, and comment lines are ignored.',
    fields: [
      { name: 'eventName', type: 'Option<string>', default: 'null', readonly: false, visibility: 'private' },
      { name: 'data', type: 'StringBuilder', default: 'StringBuilder()', visibility: 'private' },
      { name: 'hasData', type: 'bool', default: 'false', readonly: false, visibility: 'private' },
    ],
  });
  f.fn('feed', {
    of: 'SseParser',
    doc: 'Take one line, without its terminator. Returns the event a blank line completes, if any.',
    params: [{ name: 'line', type: 'string' }],
    returns: 'Option<SseEvent>',
    code: kt`
      if (line.isEmpty()) return dispatch()
      if (line.startsWith(":")) return null
      val colon = line.indexOf(':')
      val field = if (colon < 0) line else line.substring(0, colon)
      val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
      when (field) {
          "event" -> eventName = value
          "data" -> {
              if (hasData) data.append('\n')
              data.append(value)
              hasData = true
          }
          // id and retry exist for reconnection, which a single request never does.
      }
      return null
    `,
  });
  f.fn('finish', {
    of: 'SseParser',
    doc: 'The event left pending when the stream ended without a final blank line.',
    returns: 'Option<SseEvent>',
    expression: true,
    code: kt`dispatch()`,
  });
  f.fn('dispatch', {
    of: 'SseParser',
    visibility: 'private',
    doc: 'Complete the pending event, if it has data, and start a new one.',
    returns: 'Option<SseEvent>',
    code: kt`
      val event = if (hasData) SseEvent(eventName, data.toString()) else null
      eventName = null
      data.setLength(0)
      hasData = false
      return event
    `,
  });

  f.fn('sseEvents', {
    doc: 'Server-sent events from a stream of body lines.',
    params: [{ name: 'lines', type: 'Flow<string>' }],
    returns: 'Flow<SseEvent>',
    expression: true,
    code: kt`
      flow {
          val parser = SseParser()
          lines.collect { line -> parser.feed(line)?.let { emit(it) } }
          parser.finish()?.let { emit(it) }
      }
    `,
  });
}

function retry(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/Retry.kt`, { doc: 'bounded retries for provider requests' });

  f.record(
    'RetryPolicy',
    [
      { name: 'maxAttempts', type: 'i64', default: '3L', doc: 'Including the first. Never unbounded.' },
      { name: 'initialDelayMillis', type: 'i64', default: '1000L' },
      {
        name: 'maxDelayMillis',
        type: 'i64',
        default: '8000L',
        doc: 'A server asking for a longer wait than this gets an error the user sees, not a silent stall.',
      },
    ],
    { doc: 'How hard to retry a failed request.' },
  );

  f.fn('retryDelay', {
    doc: 'How long to wait before retrying this error, or null if it should not be retried.',
    params: [
      { name: 'error', type: 'ProviderError' },
      { name: 'backoffMillis', type: 'i64' },
      { name: 'policy', type: 'RetryPolicy' },
    ],
    returns: 'Option<i64>',
    code: kt`
      if (!isRetryable(error)) return null
      val wait = (error as? ProviderError.RateLimited)?.retryAfterMillis ?: backoffMillis
      return if (wait <= policy.maxDelayMillis) wait else null
    `,
  });

  f.fn('withRetry', {
    doc: 'Run a provider stream, retrying retryable failures that happen before the first event. Once anything has been emitted a retry would repeat it, so a later failure is passed on.',
    params: [
      { name: 'policy', type: 'RetryPolicy' },
      { name: 'attempt', type: '() -> Flow<ModelEvent>' },
    ],
    returns: 'Flow<ModelEvent>',
    expression: true,
    code: kt`
      flow {
          var attempts = 1L
          var backoff = policy.initialDelayMillis
          while (true) {
              var emitted = false
              try {
                  attempt().collect {
                      emitted = true
                      emit(it)
                  }
                  return@flow
              } catch (failure: ProviderException) {
                  val wait = retryDelay(failure.error, backoff, policy)
                  if (emitted || attempts >= policy.maxAttempts || wait == null) throw failure
                  delay(wait)
                  attempts += 1
                  backoff = (backoff * 2).coerceAtMost(policy.maxDelayMillis)
              }
          }
      }
    `,
  });
}
