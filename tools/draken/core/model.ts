/**
 * The conversation domain: what is persisted, shown and sent.
 *
 * These types are deliberately provider-neutral. A provider's own wire shapes
 * live in its adapter and never leak into a conversation, which is what lets a
 * conversation move between models without being rewritten.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core';

export function buildModel(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/model/Conversation.kt`, { doc: 'conversations and their messages' });

  f.record(
    'Conversation',
    [
      { name: 'id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'createdAt', type: 'i64', doc: 'Milliseconds since the epoch.' },
      { name: 'updatedAt', type: 'i64' },
      {
        name: 'modelOverride',
        type: 'Option<ModelChoice>',
        default: 'null',
        doc: 'A model the user pinned for this conversation; routing still applies its policy to it.',
      },
    ],
    { doc: 'One conversation. Its messages are stored separately, in order.' },
  );

  f.record(
    'ModelChoice',
    [
      { name: 'providerId', type: 'string' },
      { name: 'modelId', type: 'string' },
    ],
    { doc: 'A specific model on a specific provider.', annotations: ['Serializable'] },
  );

  f.enm('MessageRole', ['USER', 'ASSISTANT', 'TOOL'], {
    doc: 'Who a message is from. Tool results are their own messages so each can be shown, audited and resent.',
  });

  f.enm('MessageStatus', ['STREAMING', 'COMPLETE', 'CANCELLED', 'FAILED'], {
    doc: 'A message being written, finished, stopped by the user, or ended by an error. Partial text is kept in every case.',
  });

  f.record(
    'ToolCall',
    [
      { name: 'id', type: 'string', doc: 'The provider\'s id for this call, used to pair it with its result.' },
      { name: 'toolName', type: 'string', doc: 'The wire name, as the model sent it.' },
      {
        name: 'argumentsJson',
        type: 'string',
        doc: 'Exactly what the model produced. Parsed and validated only by the tool pipeline: model output is untrusted.',
      },
    ],
    { doc: 'A tool call the model asked for.', annotations: ['Serializable'] },
  );

  f.record(
    'ToolResultRecord',
    [
      { name: 'callId', type: 'string' },
      { name: 'toolName', type: 'string' },
      { name: 'isError', type: 'bool' },
      { name: 'content', type: 'string', doc: 'What is returned to the model: the result, or a structured failure.' },
    ],
    { doc: 'The outcome of one tool call, as it is shown and as it is sent back.', annotations: ['Serializable'] },
  );

  f.record(
    'ProviderReplay',
    [
      { name: 'providerId', type: 'string', doc: 'The provider whose adapter wrote it; every other adapter ignores it.' },
      { name: 'payload', type: 'string', doc: 'Adapter-private JSON.' },
    ],
    {
      doc: 'An assistant turn exactly as the vendor produced it. Several vendors require it back verbatim on later requests - Claude its thinking blocks and their signatures, Gemini its thought signatures, DeepSeek its reasoning when tools are in use - so it is stored with the message and handed back to the adapter that wrote it.',
    },
  );

  f.record(
    'RouteStamp',
    [
      { name: 'providerId', type: 'string' },
      { name: 'modelId', type: 'string' },
      { name: 'local', type: 'bool', doc: 'True when the request never left the device.' },
    ],
    { doc: 'Which model produced a message, kept so the user can always see where their words went.' },
  );

  f.record(
    'ChatMessage',
    [
      { name: 'id', type: 'string' },
      { name: 'conversationId', type: 'string' },
      { name: 'role', type: 'MessageRole' },
      { name: 'text', type: 'string' },
      { name: 'createdAt', type: 'i64' },
      { name: 'status', type: 'MessageStatus', default: 'MessageStatus.COMPLETE' },
      { name: 'toolCalls', type: 'List<ToolCall>', default: 'emptyList()' },
      { name: 'toolResult', type: 'Option<ToolResultRecord>', default: 'null' },
      { name: 'route', type: 'Option<RouteStamp>', default: 'null' },
      { name: 'error', type: 'Option<string>', default: 'null', doc: 'Why the message failed, in words the user can act on.' },
      {
        name: 'replay',
        type: 'Option<ProviderReplay>',
        default: 'null',
        doc: 'The vendor\'s own form of an assistant turn, kept so it can be sent back unchanged.',
      },
    ],
    { doc: 'One message in a conversation.' },
  );

  f.fn('conversationTitleFrom', {
    doc: 'A title for a new conversation, from its first message: the first line, trimmed to a readable length.',
    params: [{ name: 'firstMessage', type: 'string' }],
    returns: 'string',
    code: kt`
      val line = firstMessage.trim().lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
      if (line.isEmpty()) return "New conversation"
      return if (line.length <= 60) line else line.take(57).trimEnd() + "..."
    `,
  });
}
