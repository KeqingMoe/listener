import type { Loop } from '@listener/agent';
import type { Chat } from '@listener/chat';
import type { Open } from './config';

export class Scheduler {
  readonly chat: Chat;
  readonly loop: Loop;
  readonly policy: Open;
  readonly signal: AbortSignal;
  #off: () => void;
  #poisson: ReturnType<typeof setTimeout> | undefined;
  #wake: (() => void) | undefined;

  constructor(chat: Chat, loop: Loop, policy: Open, signal: AbortSignal) {
    this.chat = chat;
    this.loop = loop;
    this.policy = policy;
    this.signal = signal;
    this.#off = chat.on(({ mentioned }) => {
      if (loop.chatting) return;
      if (
        (policy.mentioned.at && mentioned.at) ||
        (policy.mentioned.reply && mentioned.reply)
      ) {
        this.#wake?.();
      }
    });
  }

  async open(): Promise<void> {
    while (!this.signal.aborted) {
      await this.#idle();
      if (this.signal.aborted) return;
      await this.loop.open();
    }
  }

  dispose(): void {
    this.#off();
    this.#clear();
  }

  #clear(): void {
    if (this.#poisson === undefined) return;
    clearTimeout(this.#poisson);
    this.#poisson = undefined;
  }

  #idle(): Promise<void> {
    if (this.signal.aborted) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(this.#poisson);
        this.#poisson = undefined;
        this.signal.removeEventListener('abort', finish);
        this.#wake = undefined;
        resolve();
      };
      this.#wake = finish;
      this.signal.addEventListener('abort', finish, { once: true });

      const poisson = this.policy.poisson;
      if (poisson <= 0) return;
      const wait = Math.min(
        -Math.log(1 - Math.random()) / (poisson / 3_600_000),
        86_400_000,
      );
      this.#poisson = setTimeout(finish, wait);
    });
  }
}
