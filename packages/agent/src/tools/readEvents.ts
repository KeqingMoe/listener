import type { AgentTool } from '@earendil-works/pi-agent-core';
import { type Chat, GapId } from '@listener/chat';
import { Type } from 'typebox';
import { toolError } from './error';

const readParameters = Type.Object({
  gapId: Type.Integer({ minimum: 0 }),
  side: Type.Union([Type.Literal('earliest'), Type.Literal('latest')]),
  limit: Type.Integer({ minimum: 0 }),
});

export function readEvents(chat: Chat): AgentTool<typeof readParameters> {
  return {
    name: 'readEvents',
    label: '读事件',
    description: '打开 prompt 里的一条 gap',
    parameters: readParameters,
    async execute(_, params) {
      const gapId = GapId(params.gapId);
      if (gapId === undefined) {
        throw new Error(toolError.invalid);
      }
      const events = chat.readEvents({
        gapId,
        side: params.side,
        limit: params.limit,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(events) }],
        details: events,
      };
    },
  };
}
