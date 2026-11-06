/**
 * Tests for the provider layer: SSE parsing, retries, the OkHttp transport,
 * and each vendor adapter against the wire format it speaks.
 *
 * The Claude adapter is tested against a local HTTP server speaking the real
 * Messages API event stream, so the SDK itself parses it; the others against
 * scripted body lines. Neither replaces a live call - there are no API keys in
 * the build environment - and the docs say so.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const TEST = 'core/src/test/kotlin/com/draken/core';

export function buildProviderTests(ctx: Ctx): void {
  fakes(ctx);
  sseAndRetry(ctx);
  transportTests(ctx);
  anthropicTests(ctx);
  openAiTests(ctx);
  geminiTests(ctx);
}

/** A test class: one class node, one Custom Function per test. */
export function testClass(
  f: KtFile,
  name: string,
  doc: string,
  tests: { name: string; code: string; doc: string }[],
  opts: { fields?: Parameters<KtFile['cls']>[1]['fields']; annotations?: string[] } = {},
): void {
  f.cls(name, { doc, fields: opts.fields, annotations: opts.annotations });
  for (const t of tests) f.fn(t.name, { of: name, doc: t.doc, annotations: ['Test'], code: t.code });
}

function fakes(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/testing/Fakes.kt`, { doc: 'test doubles shared by the core tests', role: 'test' });

  f.cls('ScriptedTransport', {
    doc: 'An HttpTransport that answers every request with fixed body lines, or a fixed failure, and records what was sent.',
    implements: ['HttpTransport'],
    fields: [
      { name: 'lines', type: 'List<string>', visibility: 'private' },
      { name: 'failure', type: 'Option<Exception>', visibility: 'private' },
      { name: 'requests', type: 'MutableList<HttpRequestSpec>', default: 'mutableListOf()' },
    ],
    ctor: [
      { name: 'lines', type: 'List<string>' },
      { name: 'failure', type: 'Option<Exception>', default: 'null' },
    ],
  });
  f.fn('stream', {
    of: 'ScriptedTransport',
    override: true,
    doc: 'Record the request, then replay the script.',
    params: [{ name: 'request', type: 'HttpRequestSpec' }],
    returns: 'Flow<string>',
    expression: true,
    code: kt`
      flow {
          requests.add(request)
          failure?.let { throw it }
          for (line in lines) emit(line)
      }
    `,
  });
  f.fn('lastBody', {
    of: 'ScriptedTransport',
    doc: 'The JSON body of the last request.',
    returns: 'JsonObject',
    expression: true,
    code: kt`DrakenJson.format.parseToJsonElement(requests.last().body).jsonObject`,
  });

  f.cls('StaticCredentials', {
    doc: 'CredentialSource with fixed keys.',
    implements: ['CredentialSource'],
    fields: [{ name: 'keys', type: 'Map<string, string>', visibility: 'private' }],
    ctor: [{ name: 'keys', type: 'Map<string, string>' }],
  });
  f.fn('apiKey', {
    of: 'StaticCredentials',
    override: true,
    doc: 'The fixed key, if any.',
    params: [{ name: 'providerId', type: 'string' }],
    returns: 'Option<string>',
    expression: true,
    code: kt`keys[providerId]`,
  });

  f.fn('sseLines', {
    doc: 'Body lines for a stream of server-sent events, each `data:` payload followed by a blank line.',
    params: [{ name: 'payloads', type: 'List<string>' }],
    returns: 'List<string>',
    expression: true,
    code: kt`payloads.flatMap { listOf("data: " + it, "") }`,
  });

  f.fn('testConfig', {
    doc: 'A CloudProviderConfig pointing at a test URL.',
    params: [
      { name: 'id', type: 'string' },
      { name: 'family', type: 'ProviderFamily' },
      { name: 'baseUrl', type: 'string', default: '"https://example.invalid"' },
    ],
    returns: 'CloudProviderConfig',
    expression: true,
    code: kt`CloudProviderConfig(id, id, family, baseUrl, "test-model", emptyList())`,
  });

  f.fn('simpleRequest', {
    doc: 'A one-message request, with one tool when asked.',
    params: [
      { name: 'text', type: 'string', default: '"Hello"' },
      { name: 'withTool', type: 'bool', default: 'false' },
    ],
    returns: 'ModelRequest',
    code: kt`
      val tools = if (!withTool) emptyList() else listOf(
          ToolDefinition(
              "notes_create",
              "Create a note",
              buildJsonObject {
                  put("type", "object")
                  putJsonObject("properties") { putJsonObject("title") { put("type", "string") } }
                  putJsonArray("required") { add("title") }
                  put("additionalProperties", false)
              },
          ),
      )
      return ModelRequest("test-model", "Be brief.", listOf(PromptMessage.User(text)), tools, 1024L)
    `,
  });
  f.use('kotlinx.serialization.json.put', 'kotlinx.serialization.json.add');
}

function sseAndRetry(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/provider/http/ServerSentEventsTest.kt`, { doc: 'SSE parsing', role: 'test' });
  f.use('kotlinx.coroutines.flow.toList');
  testClass(f, 'ServerSentEventsTest', 'Server-sent event assembly, per the HTML standard.', [
    {
      name: 'joinsDataLinesAndNamesEvents',
      doc: 'Multiple data lines join with newlines; `event:` names the event; comments are skipped.',
      code: kt`
        val events = runBlocking {
            sseEvents(flowOf(": keep-alive", "event: delta", "data: one", "data: two", "", "data:three", "")).toList()
        }
        assertEquals(listOf(SseEvent("delta", "one\ntwo"), SseEvent(null, "three")), events)
      `,
    },
    {
      name: 'deliversAnEventLeftOpenAtTheEnd',
      doc: 'A stream that stops without a final blank line still delivers its last event.',
      code: kt`
        val events = runBlocking { sseEvents(flowOf("data: last")).toList() }
        assertEquals(listOf(SseEvent(null, "last")), events)
      `,
    },
    {
      name: 'ignoresBlankLinesWithoutData',
      doc: 'Blank lines with no pending data dispatch nothing.',
      code: kt`
        val events = runBlocking { sseEvents(flowOf("", "", "event: ping", "")).toList() }
        assertTrue(events.isEmpty())
      `,
    },
  ]);

  const r = new KtFile(ctx, `${TEST}/provider/RetryTest.kt`, { doc: 'bounded retries', role: 'test' });
  r.use('kotlinx.coroutines.flow.toList');
  testClass(r, 'RetryTest', 'withRetry retries only what can pass, only before output, and never without bound.', [
    {
      name: 'retriesARetryableFailureBeforeAnyOutput',
      doc: 'An overload before the first event is retried, and the second attempt\'s output is what arrives.',
      code: kt`
        runTest {
            var attempts = 0
            val events = withRetry(RetryPolicy(3L, 10L, 100L)) {
                flow {
                    attempts += 1
                    if (attempts == 1) throw ProviderException(ProviderError.Overloaded)
                    emit(ModelEvent.TextDelta("ok"))
                }
            }.toList()
            assertEquals(2, attempts)
            assertEquals(listOf(ModelEvent.TextDelta("ok")), events)
        }
      `,
    },
    {
      name: 'neverRetriesAfterOutputHasBeenEmitted',
      doc: 'Retrying after output would repeat it, so a later failure surfaces.',
      code: kt`
        runTest {
            var attempts = 0
            val failure = assertThrows(ProviderException::class.java) {
                runBlocking {
                    withRetry(RetryPolicy(3L, 10L, 100L)) {
                        flow {
                            attempts += 1
                            emit(ModelEvent.TextDelta("partial"))
                            throw ProviderException(ProviderError.Network("reset"))
                        }
                    }.toList()
                }
            }
            assertEquals(1, attempts)
            assertTrue(failure.error is ProviderError.Network)
        }
      `,
    },
    {
      name: 'doesNotRetryCredentialFailures',
      doc: 'A rejected key does not fix itself.',
      code: kt`
        var attempts = 0
        assertThrows(ProviderException::class.java) {
            runBlocking {
                withRetry(RetryPolicy(3L, 1L, 10L)) {
                    flow<ModelEvent> {
                        attempts += 1
                        throw ProviderException(ProviderError.Authentication("bad key"))
                    }
                }.toList()
            }
        }
        assertEquals(1, attempts)
      `,
    },
    {
      name: 'stopsAtTheAttemptLimit',
      doc: 'A failure that keeps happening is retried at most maxAttempts times in all.',
      code: kt`
        runTest {
            var attempts = 0
            assertThrows(ProviderException::class.java) {
                runBlocking {
                    withRetry(RetryPolicy(3L, 1L, 10L)) {
                        flow<ModelEvent> {
                            attempts += 1
                            throw ProviderException(ProviderError.ServerError(500))
                        }
                    }.toList()
                }
            }
            assertEquals(3, attempts)
        }
      `,
    },
    {
      name: 'surfacesARateLimitLongerThanTheCap',
      doc: 'A server asking for a longer wait than the policy allows gets an error, not a silent stall.',
      code: kt`
        assertNull(retryDelay(ProviderError.RateLimited(60_000L), 1_000L, RetryPolicy(3L, 1_000L, 8_000L)))
        assertEquals(2_000L, retryDelay(ProviderError.RateLimited(2_000L), 1_000L, RetryPolicy(3L, 1_000L, 8_000L)))
      `,
    },
  ]);
}

function transportTests(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/provider/http/OkHttpTransportTest.kt`, { doc: 'the OkHttp transport', role: 'test' });
  f.use('kotlinx.coroutines.flow.toList', 'kotlinx.coroutines.flow.first');
  testClass(
    f,
    'OkHttpTransportTest',
    'The production transport against a local HTTP server.',
    [
      {
        name: 'streamsTheBodyByLines',
        doc: 'A 200 response arrives line by line, and the request carries its headers and body.',
        code: kt`
          server.enqueue(MockResponse.Builder().code(200).body("one\ntwo\n").build())
          val lines = runBlocking {
              OkHttpTransport().stream(HttpRequestSpec(server.url("/v1").toString(), mapOf("x-test" to "yes"), "{}")).toList()
          }
          assertEquals(listOf("one", "two"), lines)
          val recorded = server.takeRequest()
          assertEquals("yes", recorded.headers["x-test"])
          assertEquals("{}", recorded.body?.utf8())
        `,
      },
      {
        name: 'reportsAnErrorStatusWithItsBodyAndRetryAfter',
        doc: 'A non-2xx response is an HttpStatusException carrying what the adapter needs to explain it.',
        code: kt`
          server.enqueue(MockResponse.Builder().code(429).addHeader("Retry-After", "2").body("{\"error\":{}}").build())
          val failure = assertThrows(HttpStatusException::class.java) {
              runBlocking { OkHttpTransport().stream(HttpRequestSpec(server.url("/").toString(), emptyMap(), "{}")).toList() }
          }
          assertEquals(429, failure.status)
          assertEquals("{\"error\":{}}", failure.body)
          assertEquals(2_000L, failure.retryAfterMillis)
        `,
      },
      {
        name: 'reportsAnUnreachableServerAsANetworkError',
        doc: 'A refused connection is a ProviderException, not a raw IOException.',
        code: kt`
          val url = server.url("/").toString()
          server.close()
          val failure = assertThrows(ProviderException::class.java) {
              runBlocking { OkHttpTransport().stream(HttpRequestSpec(url, emptyMap(), "{}")).toList() }
          }
          assertTrue(failure.error is ProviderError.Network)
        `,
      },
      {
        name: 'stopsReadingWhenTheCollectorStops',
        doc: 'Taking the first line of an unending body returns at once rather than waiting for the rest.',
        code: kt`
          val body = (1..10_000).joinToString("\n") { "line " + it }
          server.enqueue(MockResponse.Builder().code(200).body(body).build())
          val first = runBlocking {
              withTimeout(5_000) {
                  OkHttpTransport().stream(HttpRequestSpec(server.url("/").toString(), emptyMap(), "{}")).first()
              }
          }
          assertEquals("line 1", first)
        `,
      },
    ],
    { fields: [{ name: 'server', type: 'MockWebServer', default: 'MockWebServer().apply { start() }', visibility: 'private' }] },
  );
  f.fn('stopServer', {
    of: 'OkHttpTransportTest',
    annotations: ['After'],
    doc: 'Release the port.',
    code: kt`server.close()`,
  });
}

function anthropicTests(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/provider/anthropic/AnthropicProviderTest.kt`, { doc: 'the Claude adapter', role: 'test' });
  f.use('kotlinx.coroutines.flow.toList');

  f.decl(
    kt`
      /** A Messages API event stream: a thinking block with a signature, some text, then a tool call. */
      private val TOOL_TURN = listOf(
          "message_start" to """{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":21,"output_tokens":1}}}""",
          "content_block_start" to """{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}""",
          "content_block_delta" to """{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Use the notes tool."}}""",
          "content_block_delta" to """{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc123"}}""",
          "content_block_stop" to """{"type":"content_block_stop","index":0}""",
          "content_block_start" to """{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}""",
          "content_block_delta" to """{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Saving it."}}""",
          "content_block_stop" to """{"type":"content_block_stop","index":1}""",
          "content_block_start" to """{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"notes_create","input":{}}}""",
          "content_block_delta" to """{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"title\":"}}""",
          "content_block_delta" to """{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"Groceries\"}"}}""",
          "content_block_stop" to """{"type":"content_block_stop","index":2}""",
          "message_delta" to """{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":40}}""",
          "message_stop" to """{"type":"message_stop"}""",
      )

      private fun eventStream(events: List<Pair<String, String>>): String =
          events.joinToString("") { (name, data) -> "event: " + name + "\ndata: " + data + "\n\n" }
    `,
    { doc: 'A recorded-format Messages API stream.' },
  );

  testClass(
    f,
    'AnthropicProviderTest',
    'The Claude adapter, through the real SDK, against a local server speaking the Messages API stream.',
    [
      {
        name: 'streamsTextAndACompleteToolCall',
        doc: 'Text arrives as deltas, the tool call once its input is whole, and the stop reason and usage are reported.',
        code: kt`
          server.enqueue(MockResponse.Builder().code(200).addHeader("content-type", "text/event-stream").body(eventStream(TOOL_TURN)).build())
          val events = runBlocking { provider().stream(simpleRequest(withTool = true)).toList() }

          assertEquals(ModelEvent.TextDelta("Saving it."), events[0])
          assertEquals(ModelEvent.ToolCallRequested(ToolCall("toolu_1", "notes_create", "{\"title\":\"Groceries\"}")), events[1])
          assertEquals(ModelEvent.UsageReport(21L, 40L), events[2])
          val finished = events[3] as ModelEvent.Finished
          assertEquals(StopReason.TOOL_USE, finished.stopReason)

          val sent = parseJsonObject(server.takeRequest().body!!.utf8())!!
          assertEquals("test-model", stringField(sent, "model"))
          assertEquals(true, (sent["stream"] as JsonPrimitive).booleanOrNull)
          val tool = arrayField(sent, "tools")[0].jsonObject
          assertEquals("notes_create", stringField(tool, "name"))
          assertEquals("drop_block", stringField(objectField(objectField(sent, "thinking"), "block_binding"), "prefix_mismatch_behavior"))
        `,
      },
      {
        name: 'sendsTheThinkingSignatureBackUnchanged',
        doc: 'The replayed turn restores the thinking block with its signature, which current Claude models require back exactly.',
        code: kt`
          server.enqueue(MockResponse.Builder().code(200).addHeader("content-type", "text/event-stream").body(eventStream(TOOL_TURN)).build())
          val first = runBlocking { provider().stream(simpleRequest(withTool = true)).toList() }
          val replay = (first.last() as ModelEvent.Finished).replay!!
          server.takeRequest()

          server.enqueue(MockResponse.Builder().code(200).addHeader("content-type", "text/event-stream").body(eventStream(listOf(
              "message_start" to """{"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":60,"output_tokens":1}}}""",
              "message_delta" to """{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}""",
              "message_stop" to """{"type":"message_stop"}""",
          ))).build())
          val followUp = ModelRequest(
              "test-model",
              "Be brief.",
              listOf(
                  PromptMessage.User("Remember groceries"),
                  PromptMessage.Assistant("Saving it.", listOf(ToolCall("toolu_1", "notes_create", "{\"title\":\"Groceries\"}")), replay),
                  PromptMessage.ToolResults(listOf(ToolResultRecord("toolu_1", "notes_create", false, "{\"id\":\"n1\"}"))),
              ),
          )
          runBlocking { provider().stream(followUp).toList() }

          val sent = parseJsonObject(server.takeRequest().body!!.utf8())!!
          val assistant = arrayField(sent, "messages")[1].jsonObject
          val thinking = arrayField(assistant, "content")[0].jsonObject
          assertEquals("thinking", stringField(thinking, "type"))
          assertEquals("sig-abc123", stringField(thinking, "signature"))
          val result = arrayField(arrayField(sent, "messages")[2].jsonObject, "content")[0].jsonObject
          assertEquals("tool_result", stringField(result, "type"))
          assertEquals("toolu_1", stringField(result, "tool_use_id"))
        `,
      },
      {
        name: 'mapsARejectedKeyToAuthentication',
        doc: 'HTTP 401 becomes an authentication error the user can act on.',
        code: kt`
          server.enqueue(MockResponse.Builder().code(401).addHeader("content-type", "application/json")
              .body("""{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}""").build())
          val failure = assertThrows(ProviderException::class.java) { runBlocking { provider().stream(simpleRequest()).toList() } }
          assertTrue(failure.error is ProviderError.Authentication)
        `,
      },
      {
        name: 'mapsRateLimitingWithItsRetryAfter',
        doc: 'HTTP 429 carries the server\'s requested wait.',
        code: kt`
          server.enqueue(MockResponse.Builder().code(429).addHeader("content-type", "application/json").addHeader("retry-after", "3")
              .body("""{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}""").build())
          val failure = assertThrows(ProviderException::class.java) { runBlocking { provider().stream(simpleRequest()).toList() } }
          assertEquals(ProviderError.RateLimited(3_000L), failure.error)
        `,
      },
      {
        name: 'mapsOverloadToARetryableError',
        doc: 'HTTP 529 is the overloaded signal, and is retryable.',
        code: kt`
          server.enqueue(MockResponse.Builder().code(529).addHeader("content-type", "application/json")
              .body("""{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}""").build())
          val failure = assertThrows(ProviderException::class.java) { runBlocking { provider().stream(simpleRequest()).toList() } }
          assertEquals(ProviderError.Overloaded, failure.error)
          assertTrue(isRetryable(failure.error))
        `,
      },
      {
        name: 'refusesWithoutAKey',
        doc: 'No saved key means no request at all.',
        code: kt`
          val keyless = AnthropicProvider(testConfig("anthropic", ProviderFamily.ANTHROPIC, server.url("/").toString()), StaticCredentials(emptyMap()))
          val failure = assertThrows(ProviderException::class.java) { runBlocking { keyless.stream(simpleRequest()).toList() } }
          assertEquals(ProviderError.MissingCredentials, failure.error)
          assertEquals(0, server.requestCount)
        `,
      },
    ],
    { fields: [{ name: 'server', type: 'MockWebServer', default: 'MockWebServer().apply { start() }', visibility: 'private' }] },
  );
  f.fn('provider', {
    of: 'AnthropicProviderTest',
    visibility: 'private',
    doc: 'The adapter pointed at the local server.',
    returns: 'AnthropicProvider',
    expression: true,
    code: kt`AnthropicProvider(testConfig("anthropic", ProviderFamily.ANTHROPIC, server.url("/").toString()), StaticCredentials(mapOf("anthropic" to "sk-test")))`,
  });
  f.fn('stopServer', {
    of: 'AnthropicProviderTest',
    annotations: ['After'],
    doc: 'Release the port.',
    code: kt`server.close()`,
  });
}

function openAiTests(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/provider/openai/OpenAiProvidersTest.kt`, { doc: 'the OpenAI-style adapters', role: 'test' });
  f.use('kotlinx.coroutines.flow.toList');
  testClass(f, 'OpenAiProvidersTest', 'The Responses and Chat Completions adapters against their documented streams.', [
    {
      name: 'responsesStreamsTextAndAToolCallAndReplaysOutput',
      doc: 'Text deltas, a completed function call item, and the output items kept for replay.',
      code: kt`
        val transport = ScriptedTransport(sseLines(listOf(
            """{"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"delta":"Checking."}""",
            """{"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"notes_search","arguments":"{\"query\":\"milk\"}"}}""",
            """{"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","id":"rs_1","encrypted_content":"enc"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"notes_search","arguments":"{\"query\":\"milk\"}"}],"usage":{"input_tokens":30,"output_tokens":12}}}""",
        )))
        val provider = OpenAiResponsesProvider(testConfig("openai", ProviderFamily.OPENAI), StaticCredentials(mapOf("openai" to "k")), transport)
        val events = runBlocking { provider.stream(simpleRequest(withTool = true)).toList() }

        assertEquals(ModelEvent.TextDelta("Checking."), events[0])
        assertEquals(ModelEvent.ToolCallRequested(ToolCall("call_1", "notes_search", "{\"query\":\"milk\"}")), events[1])
        assertEquals(ModelEvent.UsageReport(30L, 12L), events[2])
        val finished = events[3] as ModelEvent.Finished
        assertEquals(StopReason.TOOL_USE, finished.stopReason)
        assertTrue(finished.replay!!.payload.contains("encrypted_content"))

        val body = transport.lastBody()
        assertEquals(false, (body["store"] as JsonPrimitive).booleanOrNull)
        assertEquals("Be brief.", stringField(body, "instructions"))
        assertEquals("Bearer k", transport.requests.last().headers["Authorization"])
      `,
    },
    {
      name: 'responsesReplaysItsOwnOutputItemsVerbatim',
      doc: 'A turn this provider produced goes back as the exact items, encrypted reasoning included; tool results follow as function_call_output.',
      code: kt`
        val transport = ScriptedTransport(sseLines(listOf(
            """{"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}""",
        )))
        val provider = OpenAiResponsesProvider(testConfig("openai", ProviderFamily.OPENAI), StaticCredentials(mapOf("openai" to "k")), transport)
        val replay = ProviderReplay("openai", """[{"type":"reasoning","id":"rs_1","encrypted_content":"enc"},{"type":"function_call","call_id":"call_1","name":"notes_search","arguments":"{}"}]""")
        val request = ModelRequest("m", null, listOf(
            PromptMessage.User("find milk"),
            PromptMessage.Assistant("", listOf(ToolCall("call_1", "notes_search", "{}")), replay),
            PromptMessage.ToolResults(listOf(ToolResultRecord("call_1", "notes_search", false, "[]"))),
        ))
        runBlocking { provider.stream(request).toList() }
        val input = arrayField(transport.lastBody(), "input")
        assertEquals(4, input.size)
        assertEquals("enc", stringField(input[1].jsonObject, "encrypted_content"))
        assertEquals("function_call_output", stringField(input[3].jsonObject, "type"))
        assertEquals("call_1", stringField(input[3].jsonObject, "call_id"))
      `,
    },
    {
      name: 'responsesReportsMaxTokensForAnIncompleteResponse',
      doc: 'A response cut off at the output limit is MAX_TOKENS, so its tool calls are not run.',
      code: kt`
        val transport = ScriptedTransport(sseLines(listOf(
            """{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[],"usage":{"input_tokens":5,"output_tokens":9}}}""",
        )))
        val provider = OpenAiResponsesProvider(testConfig("openai", ProviderFamily.OPENAI), StaticCredentials(mapOf("openai" to "k")), transport)
        val finished = runBlocking { provider.stream(simpleRequest()).toList() }.last() as ModelEvent.Finished
        assertEquals(StopReason.MAX_TOKENS, finished.stopReason)
      `,
    },
    {
      name: 'quotaExhaustionIsNotARateLimit',
      doc: 'A 429 for exhausted quota is not retried; waiting does not fix it.',
      code: kt`
        val transport = ScriptedTransport(emptyList(), HttpStatusException(429, """{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}""", null))
        val provider = OpenAiResponsesProvider(testConfig("openai", ProviderFamily.OPENAI), StaticCredentials(mapOf("openai" to "k")), transport)
        val failure = assertThrows(ProviderException::class.java) { runBlocking { provider.stream(simpleRequest()).toList() } }
        assertTrue(failure.error is ProviderError.PermissionDenied)
        assertFalse(isRetryable(failure.error))
      `,
    },
    {
      name: 'chatCompletionsAssemblesFragmentedToolCalls',
      doc: 'Tool call fragments keyed by index are joined; usage arrives in the last chunk.',
      code: kt`
        val transport = ScriptedTransport(sseLines(listOf(
            """{"choices":[{"index":0,"delta":{"reasoning_content":"Search first."}}]}""",
            """{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"notes_search","arguments":"{\"qu"}}]}}]}""",
            """{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\":\"milk\"}"}}]}}]}""",
            """{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}""",
            """{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}""",
            "[DONE]",
        )))
        val provider = ChatCompletionsProvider(testConfig("deepseek", ProviderFamily.DEEPSEEK), StaticCredentials(mapOf("deepseek" to "k")), transport)
        val events = runBlocking { provider.stream(simpleRequest(withTool = true)).toList() }

        assertEquals(ModelEvent.ToolCallRequested(ToolCall("call_9", "notes_search", "{\"query\":\"milk\"}")), events[0])
        assertEquals(ModelEvent.UsageReport(11L, 7L), events[1])
        val finished = events[2] as ModelEvent.Finished
        assertEquals(StopReason.TOOL_USE, finished.stopReason)
        assertEquals("Search first.", stringField(parseJsonObject(finished.replay!!.payload), "reasoning_content"))
      `,
    },
    {
      name: 'chatCompletionsSendsReasoningBackToDeepSeekWhenToolsAreInUse',
      doc: 'DeepSeek rejects a tool conversation whose assistant turns lack reasoning_content.',
      code: kt`
        val transport = ScriptedTransport(sseLines(listOf("""{"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}]}""", "[DONE]")))
        val provider = ChatCompletionsProvider(testConfig("deepseek", ProviderFamily.DEEPSEEK), StaticCredentials(mapOf("deepseek" to "k")), transport)
        val tools = simpleRequest(withTool = true).tools
        val request = ModelRequest("m", null, listOf(
            PromptMessage.User("hi"),
            PromptMessage.Assistant("Hello", emptyList(), ProviderReplay("deepseek", """{"reasoning_content":"greet"}""")),
            PromptMessage.User("again"),
        ), tools)
        runBlocking { provider.stream(request).toList() }
        val assistant = arrayField(transport.lastBody(), "messages")[1].jsonObject
        assertEquals("greet", stringField(assistant, "reasoning_content"))
      `,
    },
    {
      name: 'chatCompletionsNeedsNoKeyForASelfHostedServer',
      doc: 'A compatible server on the local network is called without an Authorization header.',
      code: kt`
        val transport = ScriptedTransport(sseLines(listOf("""{"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}""", "[DONE]")))
        val provider = ChatCompletionsProvider(testConfig("local", ProviderFamily.OPENAI_COMPATIBLE), StaticCredentials(emptyMap()), transport)
        val events = runBlocking { provider.stream(simpleRequest()).toList() }
        assertEquals(ModelEvent.TextDelta("hi"), events[0])
        assertNull(transport.requests.last().headers["Authorization"])
      `,
    },
  ]);
}

function geminiTests(ctx: Ctx): void {
  const f = new KtFile(ctx, `${TEST}/provider/gemini/GeminiProviderTest.kt`, { doc: 'the Gemini adapter', role: 'test' });
  f.use('kotlinx.coroutines.flow.toList');
  testClass(f, 'GeminiProviderTest', 'The Gemini adapter against the documented generateContent stream.', [
    {
      name: 'streamsTextAndAFunctionCallKeepingTheSignature',
      doc: 'The function call is reported, and the model turn - signature included - is kept for replay.',
      code: kt`
        val transport = ScriptedTransport(sseLines(listOf(
            """{"candidates":[{"content":{"role":"model","parts":[{"text":"Looking."}]}}]}""",
            """{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"notes_search","args":{"query":"milk"}},"thoughtSignature":"sig-g1"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":6,"thoughtsTokenCount":4}}""",
        )))
        val provider = GeminiProvider(testConfig("gemini", ProviderFamily.GEMINI), StaticCredentials(mapOf("gemini" to "g-key")), transport)
        val events = runBlocking { provider.stream(simpleRequest(withTool = true)).toList() }

        assertEquals(ModelEvent.TextDelta("Looking."), events[0])
        val call = (events[1] as ModelEvent.ToolCallRequested).call
        assertEquals("notes_search", call.toolName)
        assertEquals("{\"query\":\"milk\"}", call.argumentsJson)
        assertEquals(ModelEvent.UsageReport(15L, 10L), events[2])
        val finished = events[3] as ModelEvent.Finished
        assertEquals(StopReason.TOOL_USE, finished.stopReason)
        assertTrue(finished.replay!!.payload.contains("sig-g1"))

        val spec = transport.requests.last()
        assertEquals("g-key", spec.headers["x-goog-api-key"])
        assertFalse("the key must never be in the URL", spec.url.contains("g-key"))
        val declaration = arrayField(arrayField(transport.lastBody(), "tools")[0].jsonObject, "functionDeclarations")[0].jsonObject
        assertNull("Gemini's schema has no additionalProperties", objectField(declaration, "parameters")!!["additionalProperties"])
      `,
    },
    {
      name: 'replaysTheModelTurnAndAnswersWithAFunctionResponse',
      doc: 'The stored model turn goes back verbatim and the result follows in a user turn.',
      code: kt`
        val transport = ScriptedTransport(sseLines(listOf("""{"candidates":[{"content":{"role":"model","parts":[{"text":"Found it."}]},"finishReason":"STOP"}]}""")))
        val provider = GeminiProvider(testConfig("gemini", ProviderFamily.GEMINI), StaticCredentials(mapOf("gemini" to "k")), transport)
        val replay = ProviderReplay("gemini", """{"role":"model","parts":[{"functionCall":{"name":"notes_search","args":{}},"thoughtSignature":"sig-g1"}]}""")
        val request = ModelRequest("m", null, listOf(
            PromptMessage.User("find milk"),
            PromptMessage.Assistant("", listOf(ToolCall("gemini-local-0", "notes_search", "{}")), replay),
            PromptMessage.ToolResults(listOf(ToolResultRecord("gemini-local-0", "notes_search", false, "{\"count\":1}"))),
        ))
        runBlocking { provider.stream(request).toList() }
        val contents = arrayField(transport.lastBody(), "contents")
        assertEquals("sig-g1", stringField(arrayField(contents[1].jsonObject, "parts")[0].jsonObject, "thoughtSignature"))
        val response = objectField(arrayField(contents[2].jsonObject, "parts")[0].jsonObject, "functionResponse")
        assertEquals("notes_search", stringField(response, "name"))
        assertNull("a locally numbered call has no id to send back", response!!["id"])
      `,
    },
    {
      name: 'readsAnInvalidKeyAsAuthentication',
      doc: 'Gemini reports a bad key as HTTP 400; it is still an authentication problem.',
      code: kt`
        val transport = ScriptedTransport(emptyList(), HttpStatusException(400, """{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}""", null))
        val provider = GeminiProvider(testConfig("gemini", ProviderFamily.GEMINI), StaticCredentials(mapOf("gemini" to "k")), transport)
        val failure = assertThrows(ProviderException::class.java) { runBlocking { provider.stream(simpleRequest()).toList() } }
        assertTrue(failure.error is ProviderError.Authentication)
      `,
    },
  ]);
}
