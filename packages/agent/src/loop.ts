import {
  Agent,
  type AgentLoopTurnUpdate,
  type AgentTool,
  type FinishTurn,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { Chat } from '@listener/chat';
import protocol from './protocol.md?raw';

export const loopError = {
  alreadyOpen: '已经在 chatting',
} as const;

export type AgentConfig = {
  model: Model<string>;
  streamFn: StreamFn;
  tools?: AgentTool[];
  systemPrompt?: string;
  sessionId?: string;
};

function systemPrompt(selfId: string, custom?: string): string {
  const identity = `你的 QQ 号是 ${selfId}。`;
  return `${protocol.trim()}\n\n${identity}\n\n${custom?.trim() ?? ''}`;
}

export class Loop {
  readonly chat: Chat;
  readonly agent: Agent;
  #window: number;
  #chatting = false;

  constructor(chat: Chat, window: number, agent: AgentConfig) {
    this.chat = chat;
    this.#window = window;
    this.agent = new Agent({
      streamFn: agent.streamFn,
      sessionId: agent.sessionId,
      initialState: {
        systemPrompt: systemPrompt(chat.selfId, agent.systemPrompt),
        model: agent.model,
        tools: agent.tools ?? [],
      },
      finishTurn: turn => this.#finishTurn(turn.message),
      prepareNextTurn: () => this.#prepareNextTurn(),
    });
  }

  get chatting(): boolean {
    return this.#chatting;
  }

  async open(): Promise<void> {
    if (this.#chatting) {
      throw new Error(loopError.alreadyOpen);
    }
    this.#chatting = true;
    try {
      await this.agent.prompt(
        JSON.stringify(this.chat.openWindow(this.#window)),
      );
    } finally {
      this.#chatting = false;
    }
  }

  #finishTurn(message: AssistantMessage): ReturnType<FinishTurn> {
    if (message.content.some(part => part.type === 'toolCall')) {
      return;
    }
    return { action: 'end' as const };
  }

  #prepareNextTurn(): AgentLoopTurnUpdate | undefined {
    const batch = this.chat.openWindow();
    if (batch.length === 0) {
      return;
    }
    return {
      messages: [
        {
          role: 'user' as const,
          content: JSON.stringify(batch),
          timestamp: Date.now(),
        },
      ],
    };
  }
}
