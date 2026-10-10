import {
  Agent,
  type AgentLoopTurnUpdate,
  type AgentTool,
  type FinishTurn,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { Chat, ChatEvent } from '@listener/chat';
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
  signal: AbortSignal;
};

function systemPrompt(selfId: string, custom?: string): string {
  const identity = `你的 QQ 号是 ${selfId}。`;
  return `${protocol.trim()}\n\n${identity}\n\n${custom?.trim() ?? ''}`;
}

function dwellMs(message: AssistantMessage): number | undefined {
  const last = message.content.at(-1);
  if (last?.type !== 'text') {
    return;
  }
  if (!/^(0|[1-9]\d*)$/.test(last.text)) {
    return;
  }
  return Number(last.text);
}

export class Loop {
  readonly chat: Chat;
  readonly agent: Agent;
  readonly signal: AbortSignal;
  #window: number;
  #chatting = false;
  #dwell: number | undefined;
  #wake: (() => void) | undefined;
  #off: () => void;

  constructor(chat: Chat, window: number, agent: AgentConfig) {
    this.chat = chat;
    this.signal = agent.signal;
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
    this.#off = chat.on(() => {
      const wake = this.#wake;
      this.#wake = undefined;
      wake?.();
    });

    this.signal.addEventListener(
      'abort',
      () => {
        this.agent.abort();
      },
      { once: true },
    );
  }

  get chatting(): boolean {
    return this.#chatting;
  }

  dispose(): void {
    this.#off();
  }

  async open(): Promise<void> {
    if (this.#chatting) {
      throw new Error(loopError.alreadyOpen);
    }
    if (this.signal.aborted) {
      return;
    }
    this.#chatting = true;
    this.#dwell = undefined;
    try {
      await this.agent.prompt(
        JSON.stringify(this.chat.openWindow(this.#window)),
      );
      while (!this.signal.aborted) {
        const ms = this.#dwell;
        this.#dwell = undefined;
        if (ms === undefined) {
          return;
        }
        const batch = await this.#sleep(ms);
        if (batch.length === 0) {
          return;
        }
        await this.agent.prompt(JSON.stringify(batch));
      }
    } finally {
      this.#wake = undefined;
      this.#dwell = undefined;
      this.#chatting = false;
    }
  }

  #finishTurn(message: AssistantMessage): ReturnType<FinishTurn> {
    if (message.content.some(part => part.type === 'toolCall')) {
      return;
    }
    this.#dwell = dwellMs(message);
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

  #sleep(ms: number): Promise<ChatEvent[]> {
    if (this.signal.aborted) {
      return Promise.resolve([]);
    }
    const unread = this.chat.openWindow();
    if (unread.length > 0) {
      return Promise.resolve(unread);
    }
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', finish);
        this.#wake = undefined;
        resolve(this.signal.aborted ? [] : this.chat.openWindow());
      };
      const timer = setTimeout(finish, ms);
      this.#wake = finish;
      this.signal.addEventListener('abort', finish, { once: true });
    });
  }
}
