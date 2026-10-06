import type { AgentTool } from '@earendil-works/pi-agent-core';
import { type Chat, MessageId, type Send, UserId } from '@listener/chat';
import { type Static, Type } from 'typebox';
import { toolError } from './error';

const sendParameters = Type.Object({
  segments: Type.Array(
    Type.Union([
      Type.Object({
        type: Type.Literal('text'),
        text: Type.String(),
      }),
      Type.Object({
        type: Type.Literal('at'),
        userId: Type.String(),
      }),
      Type.Object({
        type: Type.Literal('at.all'),
      }),
    ]),
  ),
  replyTo: Type.Optional(Type.Integer()),
});

function sendFromTool(params: Static<typeof sendParameters>): Send | undefined {
  const segments: Send['segments'] = [];
  for (const segment of params.segments) {
    switch (segment.type) {
      case 'at': {
        const userId = UserId(segment.userId);
        if (userId === undefined) {
          return;
        }
        segments.push({ type: 'at', userId });
        break;
      }
      default:
        segments.push(segment);
    }
  }

  const replyTo =
    params.replyTo === undefined ? undefined : MessageId(params.replyTo);
  if (params.replyTo !== undefined && replyTo === undefined) {
    return;
  }
  return { segments, replyTo };
}

export function sendMessage(chat: Chat): AgentTool<typeof sendParameters> {
  return {
    name: 'sendMessage',
    label: '发送消息',
    description: '向当前群发送一条消息，返回 msgId',
    parameters: sendParameters,
    executionMode: 'sequential',
    async execute(_, params) {
      const message = sendFromTool(params);
      if (message === undefined) {
        throw new Error(toolError.invalid);
      }
      const msgId = await chat.send(message);
      return {
        content: [{ type: 'text', text: String(msgId) }],
        details: msgId,
      };
    },
  };
}
