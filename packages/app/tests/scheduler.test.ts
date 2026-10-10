import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai';
import { Loop } from '@listener/agent';
import {
  Chat,
  type Client,
  GroupId,
  MessageId,
  UnixTime,
  UserId,
} from '@listener/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '@/scheduler';

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

function client(): Client {
  return {
    async send() {
      return must(MessageId(1));
    },
    async message() {
      return undefined;
    },
    watch() {
      return () => {};
    },
    dispose() {},
  };
}

function pair(streamFn?: StreamFn) {
  const abort = new AbortController();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('')]);
  const chat = new Chat(
    {
      selfId: must(UserId('1')),
      groupId: must(GroupId('100')),
    },
    client(),
  );
  const loop = new Loop(chat, 10, {
    model: faux.getModel(),
    streamFn: streamFn ?? models.streamSimple.bind(models),
    signal: abort.signal,
  });
  return { chat, loop, models, abort };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Scheduler', () => {
  it('被 at 且未 chatting 才 open', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const { models } = pair();
    const inner = models.streamSimple.bind(models);
    const { chat, loop, abort } = pair(async (model, context, options) => {
      await hold;
      return inner(model, context, options);
    });
    const scheduler = new Scheduler(
      chat,
      loop,
      {
        window: 10,
        poisson: 0,
        mentioned: { at: true, reply: true },
      },
      abort.signal,
    );
    const running = scheduler.open();
    await chat.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      ts: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: [{ type: 'at', userId: must(UserId('1')) }],
    });
    expect(loop.chatting).toBe(true);
    await chat.append({
      type: 'message.created',
      msgId: must(MessageId(11)),
      ts: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: [{ type: 'at', userId: must(UserId('1')) }],
    });
    expect(loop.chatting).toBe(true);
    release();
    await vi.waitFor(() => {
      expect(loop.chatting).toBe(false);
    });
    abort.abort();
    scheduler.dispose();
    await running;
  });

  it('泊松在不 chatting 时开窗', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1 - Math.exp(-1));
    const { chat, loop, abort } = pair();
    const opened = vi.spyOn(loop, 'open').mockResolvedValue();
    const scheduler = new Scheduler(
      chat,
      loop,
      {
        window: 10,
        poisson: 3600,
        mentioned: { at: true, reply: true },
      },
      abort.signal,
    );
    const running = scheduler.open();
    expect(opened).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(opened).toHaveBeenCalledTimes(1);
    abort.abort();
    scheduler.dispose();
    await running;
  });

  it('dispose 退订 mentioned，不拆 Loop', async () => {
    const { chat, loop, abort } = pair();
    const scheduler = new Scheduler(
      chat,
      loop,
      {
        window: 10,
        poisson: 0,
        mentioned: { at: true, reply: true },
      },
      abort.signal,
    );
    const running = scheduler.open();
    abort.abort();
    scheduler.dispose();
    await running;
    await chat.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      ts: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: [{ type: 'at', userId: must(UserId('1')) }],
    });
    expect(loop.chatting).toBe(false);
    loop.dispose();
  });
});
