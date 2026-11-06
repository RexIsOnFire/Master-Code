/**
 * The orchestrator: one user turn, end to end.
 *
 *   store the user's message
 *   -> route (rules over capabilities; LOCAL_ONLY re-checked here as well)
 *   -> ask before anything goes to a cloud model, when policy says to
 *   -> assemble the least context that does the job
 *   -> stream the reply, persisting it as it goes
 *   -> run requested tools through the pipeline, and go round again
 *
 * Every loop is bounded: rounds of tool use, tool calls in a turn, and the
 * turn's wall-clock time. A cancelled turn keeps its partial text, marked
 * cancelled; a failed one says why. Nothing is ever reported as done that
 * was not done.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core/orchestrator';

export function buildOrchestrator(ctx: Ctx): void {
  contracts(ctx);
  orchestrator(ctx);
}

function contracts(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/TurnContracts.kt`, { doc: 'what the orchestrator depends on and reports' });

  f.iface(
    'ConversationStore',
    [
      { name: 'createConversation', suspend: true, params: [{ name: 'title', type: 'string' }], returns: 'Conversation', doc: 'Start a conversation.' },
      { name: 'conversation', suspend: true, params: [{ name: 'id', type: 'string' }], returns: 'Option<Conversation>', doc: 'One conversation.' },
      { name: 'messages', suspend: true, params: [{ name: 'conversationId', type: 'string' }], returns: 'List<ChatMessage>', doc: 'A conversation\'s messages, oldest first.' },
      { name: 'saveMessage', suspend: true, params: [{ name: 'message', type: 'ChatMessage' }], doc: 'Insert or replace a message, and touch the conversation.' },
    ],
    { doc: 'Where conversations are persisted. Room on Android.' },
  );

  f.iface(
    'ProviderDirectory',
    [
      { name: 'candidates', suspend: true, returns: 'List<RouteCandidate>', doc: 'Every model routing may choose, with whether it is usable now.' },
      { name: 'provider', params: [{ name: 'providerId', type: 'string' }], returns: 'Option<ModelProvider>', doc: 'A provider by id.' },
      { name: 'preferences', suspend: true, returns: 'RoutingPreferences', doc: 'The user\'s routing settings, current.' },
      { name: 'cloudTokensToday', suspend: true, returns: 'i64', doc: 'Tokens sent to cloud models today, for the budget.' },
      {
        name: 'recordCloudUsage',
        suspend: true,
        params: [{ name: 'providerId', type: 'string' }, { name: 'tokens', type: 'i64' }],
        doc: 'Count tokens a cloud request used.',
      },
    ],
    { doc: 'The providers and the settings that govern them.' },
  );

  f.enm('CloudApproval', ['DENY', 'ALLOW_ONCE', 'ALLOW_FOR_CONVERSATION'], {
    doc: 'The user\'s answer to sending a request to a cloud model.',
  });

  f.iface(
    'CloudApprovalGate',
    [
      {
        name: 'approve',
        suspend: true,
        params: [{ name: 'disclosure', type: 'ContextDisclosure' }],
        returns: 'CloudApproval',
        doc: 'Show exactly what would be sent and to whom, and suspend until the user answers.',
      },
    ],
    { doc: 'How the orchestrator asks before content leaves the device.' },
  );

  f.record(
    'WorkflowLimits',
    [
      { name: 'maxToolRounds', type: 'i64', default: '5L', doc: 'Times a turn may go back to the model with tool results.' },
      { name: 'maxToolCalls', type: 'i64', default: '12L', doc: 'Tool calls in one turn, across all rounds.' },
      { name: 'turnTimeoutMillis', type: 'i64', default: '180_000L' },
      { name: 'maxOutputTokens', type: 'i64', default: '4096L' },
    ],
    { doc: 'Bounds on one turn, so a model can never loop or spend without limit.' },
  );

  f.enm(
    'TurnEvent',
    [
      { name: 'Routed', payload: [{ name: 'route', type: 'RouteStamp' }, { name: 'reason', type: 'string' }] },
      { name: 'AwaitingApproval', payload: [{ name: 'disclosure', type: 'ContextDisclosure' }] },
      'ApprovalDeclined',
      { name: 'AssistantStarted', payload: [{ name: 'messageId', type: 'string' }] },
      { name: 'TextDelta', payload: [{ name: 'messageId', type: 'string' }, { name: 'text', type: 'string' }] },
      { name: 'ToolRunning', payload: [{ name: 'call', type: 'ToolCall' }] },
      { name: 'ToolFinished', payload: [{ name: 'call', type: 'ToolCall' }, { name: 'outcome', type: 'ToolOutcome' }] },
      { name: 'LimitReached', payload: [{ name: 'detail', type: 'string' }] },
      { name: 'Failed', payload: [{ name: 'message', type: 'string' }] },
      'Completed',
    ],
    { doc: 'What happens during a turn, for the interface.' },
  );
}

function orchestrator(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/Orchestrator.kt`, { doc: 'running one turn' });

  f.cls('Orchestrator', {
    doc: 'Runs conversation turns. Owns no state but which conversations the user has allowed to use the cloud this session.',
    fields: [
      { name: 'store', type: 'ConversationStore', visibility: 'private' },
      { name: 'providers', type: 'ProviderDirectory', visibility: 'private' },
      { name: 'tools', type: 'ToolRegistry', visibility: 'private' },
      { name: 'executor', type: 'ToolExecutor', visibility: 'private' },
      { name: 'approvals', type: 'CloudApprovalGate', visibility: 'private' },
      { name: 'audit', type: 'AuditLog', visibility: 'private' },
      { name: 'limits', type: 'WorkflowLimits', visibility: 'private' },
      { name: 'contextPolicy', type: 'ContextPolicy', visibility: 'private' },
      { name: 'retry', type: 'RetryPolicy', visibility: 'private' },
      { name: 'clock', type: '() -> i64', visibility: 'private' },
      { name: 'ids', type: '() -> string', visibility: 'private' },
      {
        name: 'cloudAllowed',
        type: 'MutableSet<string>',
        default: 'java.util.concurrent.ConcurrentHashMap.newKeySet()',
        visibility: 'private',
        doc: 'Conversations the user allowed to use a cloud model for the rest of this session. Kept in memory only: a restart asks again.',
      },
    ],
    ctor: [
      { name: 'store', type: 'ConversationStore' },
      { name: 'providers', type: 'ProviderDirectory' },
      { name: 'tools', type: 'ToolRegistry' },
      { name: 'executor', type: 'ToolExecutor' },
      { name: 'approvals', type: 'CloudApprovalGate' },
      { name: 'audit', type: 'AuditLog' },
      { name: 'limits', type: 'WorkflowLimits', default: 'WorkflowLimits()' },
      { name: 'contextPolicy', type: 'ContextPolicy', default: 'ContextPolicy()' },
      { name: 'retry', type: 'RetryPolicy', default: 'RetryPolicy()' },
      { name: 'clock', type: '() -> i64', default: '{ System.currentTimeMillis() }' },
      { name: 'ids', type: '() -> string', default: '{ UUID.randomUUID().toString() }' },
    ],
  });

  f.fn('send', {
    of: 'Orchestrator',
    doc: 'Run one turn for a user message. The flow completes when the turn does; cancelling its collector stops the model and keeps what was written.',
    params: [
      { name: 'conversationId', type: 'string' },
      { name: 'text', type: 'string' },
    ],
    returns: 'Flow<TurnEvent>',
    expression: true,
    code: kt`
      channelFlow {
          val conversation = store.conversation(conversationId)
          if (conversation == null) {
              send(TurnEvent.Failed("That conversation no longer exists."))
              return@channelFlow
          }
          store.saveMessage(ChatMessage(ids(), conversationId, MessageRole.USER, text.trim(), clock()))
          try {
              withTimeout(limits.turnTimeoutMillis) { runTurn(conversation, this@channelFlow) }
          } catch (timeout: TimeoutCancellationException) {
              send(TurnEvent.Failed("The reply took longer than the turn limit and was stopped."))
          }
      }
    `,
  });

  f.fn('runTurn', {
    of: 'Orchestrator',
    visibility: 'private',
    suspend: true,
    doc: 'Route, approve, and run the model and its tools until the turn ends or a limit stops it.',
    params: [
      { name: 'conversation', type: 'Conversation' },
      { name: 'events', type: 'SendChannel<TurnEvent>' },
    ],
    code: kt`
      val definitions = tools.definitions()
      val preferences = providers.preferences()
      val history = store.messages(conversation.id)
      val estimate = estimateTokens(assistantSystemPrompt()) + estimateHistoryTokens(history)
      // Tools are an affordance, not a requirement: a model without tool support
      // still answers, it just cannot act. So routing does not demand them.
      val decision = route(
          TaskRequirements(estimate, limits.maxOutputTokens, false),
          preferences,
          conversation.modelOverride,
          providers.candidates(),
          providers.cloudTokensToday(),
      )
      val chosen = when (decision) {
          is RouteDecision.Refused -> {
              events.send(TurnEvent.Failed(decision.reason))
              return
          }
          is RouteDecision.UseModel -> decision
      }
      // The router already refuses this; a second check costs nothing and
      // means a bug there cannot send a word off the device.
      if (preferences.mode == RoutingMode.LOCAL_ONLY && chosen.kind != ProviderKind.LOCAL) {
          events.send(TurnEvent.Failed("Routing is set to on-device only."))
          return
      }
      val provider = providers.provider(chosen.model.providerId)
      if (provider == null) {
          events.send(TurnEvent.Failed("The provider for " + chosen.model.displayName + " is not available."))
          return
      }
      val stamp = RouteStamp(chosen.model.providerId, chosen.model.modelId, chosen.kind == ProviderKind.LOCAL)
      events.send(TurnEvent.Routed(stamp, chosen.reason))

      val providerName = provider.descriptor().displayName
      val offered = if (chosen.model.capabilities.supportsTools) definitions else emptyList()
      var context = assembleContext(history, assistantSystemPrompt(), chosen.model, providerName, chosen.kind, offered, limits.maxOutputTokens, contextPolicy)
      if (chosen.needsApproval && conversation.id !in cloudAllowed) {
          events.send(TurnEvent.AwaitingApproval(context.disclosure))
          when (approvals.approve(context.disclosure)) {
              CloudApproval.DENY -> {
                  audit.record(AuditEvent(clock(), AuditCategory.CLOUD_REQUEST, stamp.providerId, "declined", stamp.modelId))
                  events.send(TurnEvent.ApprovalDeclined)
                  return
              }
              CloudApproval.ALLOW_FOR_CONVERSATION -> cloudAllowed.add(conversation.id)
              CloudApproval.ALLOW_ONCE -> {}
          }
      }

      var rounds = 0L
      var calls = 0L
      while (true) {
          val result = streamReply(provider, chosen, stamp, conversation.id, context, offered, events)
          if (result.stopReason != StopReason.TOOL_USE || result.calls.isEmpty()) break
          if (rounds >= limits.maxToolRounds || calls + result.calls.size > limits.maxToolCalls) {
              events.send(TurnEvent.LimitReached("The model asked for more tool use than one turn allows, so it was stopped."))
              break
          }
          rounds += 1
          calls += result.calls.size
          for (call in result.calls) {
              events.send(TurnEvent.ToolRunning(call))
              val outcome = executor.execute(call)
              store.saveMessage(ChatMessage(ids(), conversation.id, MessageRole.TOOL, outcomeSummary(outcome), clock(), toolResult = toolResultRecord(call, outcome)))
              events.send(TurnEvent.ToolFinished(call, outcome))
          }
          context = assembleContext(store.messages(conversation.id), assistantSystemPrompt(), chosen.model, providerName, chosen.kind, offered, limits.maxOutputTokens, contextPolicy)
      }
      events.send(TurnEvent.Completed)
    `,
  });

  f.record(
    'ReplyResult',
    [
      { name: 'stopReason', type: 'StopReason' },
      { name: 'calls', type: 'List<ToolCall>' },
    ],
    { doc: 'How one model reply ended.' },
  );

  f.fn('streamReply', {
    of: 'Orchestrator',
    visibility: 'private',
    suspend: true,
    doc: 'Stream one reply into a stored assistant message. A cancelled reply keeps its text, marked cancelled; a failed one is marked failed with the reason; tool calls run only when the model stopped to call them.',
    params: [
      { name: 'provider', type: 'ModelProvider' },
      { name: 'chosen', type: 'RouteDecision.UseModel' },
      { name: 'stamp', type: 'RouteStamp' },
      { name: 'conversationId', type: 'string' },
      { name: 'context', type: 'ContextPackage' },
      { name: 'offered', type: 'List<ToolDefinition>' },
      { name: 'events', type: 'SendChannel<TurnEvent>' },
    ],
    returns: 'ReplyResult',
    code: kt`
      val messageId = ids()
      val started = clock()
      val text = StringBuilder()
      val calls = mutableListOf<ToolCall>()
      var stop = StopReason.OTHER
      var replay: ProviderReplay? = null
      var usage = 0L
      fun message(status: MessageStatus, error: String? = null) =
          ChatMessage(messageId, conversationId, MessageRole.ASSISTANT, text.toString(), started, status, calls.toList(), null, stamp, error, replay)

      store.saveMessage(message(MessageStatus.STREAMING))
      events.send(TurnEvent.AssistantStarted(messageId))
      val request = ModelRequest(chosen.model.modelId, context.system, context.messages, offered, replyTokens(chosen.model, limits.maxOutputTokens))
      if (chosen.kind == ProviderKind.CLOUD) {
          audit.record(AuditEvent(clock(), AuditCategory.CLOUD_REQUEST, stamp.providerId, "sent", stamp.modelId + ", " + context.disclosure.messageCount + " messages"))
      }
      try {
          withRetry(retry) { provider.stream(request) }.collect { event ->
              when (event) {
                  is ModelEvent.TextDelta -> {
                      text.append(event.text)
                      events.send(TurnEvent.TextDelta(messageId, event.text))
                  }
                  is ModelEvent.ToolCallRequested -> calls.add(event.call)
                  is ModelEvent.UsageReport -> usage = event.inputTokens + event.outputTokens
                  is ModelEvent.Finished -> {
                      stop = event.stopReason
                      replay = event.replay
                  }
              }
          }
      } catch (cancelled: CancellationException) {
          withContext(NonCancellable) { store.saveMessage(message(MessageStatus.CANCELLED)) }
          throw cancelled
      } catch (failure: ProviderException) {
          val reason = describeProviderError(failure.error)
          store.saveMessage(message(MessageStatus.FAILED, reason))
          events.send(TurnEvent.Failed(reason))
          return ReplyResult(StopReason.OTHER, emptyList())
      }
      if (chosen.kind == ProviderKind.CLOUD && usage > 0) providers.recordCloudUsage(stamp.providerId, usage)
      val note = when (stop) {
          StopReason.MAX_TOKENS -> "The reply hit its length limit and was cut short."
          StopReason.REFUSAL -> "The model declined this request."
          else -> null
      }
      store.saveMessage(message(MessageStatus.COMPLETE, note))
      return ReplyResult(stop, if (stop == StopReason.TOOL_USE) calls.toList() else emptyList())
    `,
  });

  f.fn('outcomeSummary', {
    visibility: 'private',
    doc: 'The one line a tool result shows in the conversation.',
    params: [{ name: 'outcome', type: 'ToolOutcome' }],
    returns: 'string',
    expression: true,
    code: kt`
      when (outcome) {
          is ToolOutcome.Success -> outcome.summary
          is ToolOutcome.Failure -> outcome.message
      }
    `,
  });
}
