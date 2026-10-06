import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Chat } from '@listener/chat';
import { readEvents } from './tools/readEvents';
import { sendMessage } from './tools/sendMessage';

export { toolError } from './tools/error';

export function tools(chat: Chat): AgentTool[] {
  return [sendMessage(chat), readEvents(chat)];
}
