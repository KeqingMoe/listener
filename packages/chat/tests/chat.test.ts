import { describe, expect, it } from 'vitest';
import { Chat, chatError } from '@/chat';
import type { Client } from '@/client';
import type { MessageCreated } from '@/event';
import { GapId, GroupId, MessageId, UnixTime, UserId } from '@/id';

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

function client(messages: MessageCreated[] = []): Client {
  const byId = new Map(messages.map(item => [item.msgId, item]));
  return {
    async send() {
      return must(MessageId(1));
    },
    async message(msgId) {
      return byId.get(msgId);
    },
  };
}

function chat(messages: MessageCreated[] = []) {
  return new Chat(
    {
      selfId: must(UserId('1')),
      groupId: must(GroupId('100')),
    },
    client(messages),
  );
}

let next = 1;

function message(
  userId: string,
  text: string,
  extra: Partial<MessageCreated> = {},
): MessageCreated {
  next += 1;
  return {
    type: 'message.created',
    ts: must(UnixTime(1)),
    userId: must(UserId(userId)),
    segments: [{ type: 'text', text }],
    ...extra,
    msgId: extra.msgId ?? must(MessageId(next)),
  };
}

function texts(
  events: { type: string; segments?: { type: string; text?: string }[] }[],
) {
  return events
    .filter(event => event.type === 'message.created')
    .map(event =>
      (event.segments ?? [])
        .filter(segment => segment.type === 'text')
        .map(segment => segment.text)
        .join(''),
    );
}

describe('Chat', () => {
  it('append 进未读', async () => {
    next = 1;
    const c = chat();
    await c.append(message('1', 'self'));
    await c.append(message('2', 'a'));
    expect(texts(c.openWindow(10))).toEqual(['self', 'a']);
  });

  it('无参 openWindow 整袋拿走，不留缺口', async () => {
    next = 1;
    const c = chat();
    await c.append(message('2', 'a'));
    await c.append(message('2', 'b'));
    await c.append(message('2', 'c'));
    expect(texts(c.openWindow())).toEqual(['a', 'b', 'c']);
    expect(c.openWindow()).toEqual([]);
  });

  it('窗口取未读里最新若干条，多出来的用缺口', async () => {
    next = 1;
    const c = chat();
    await c.append(message('2', 'a'));
    await c.append(message('2', 'b'));
    await c.append(message('2', 'c'));
    expect(c.openWindow(2)).toMatchObject([
      { type: 'gap', gapId: 0, skipped: 1, mentioned: false },
      { segments: [{ type: 'text', text: 'b' }] },
      { segments: [{ type: 'text', text: 'c' }] },
    ]);
    expect(c.openWindow(10)).toEqual([]);
  });

  it('缺口只统计没进窗口的未读里有没有人提到你', async () => {
    next = 1;
    const atMe = chat();
    await atMe.append(
      message('2', 'hi', {
        segments: [{ type: 'at', userId: must(UserId('1')) }],
      }),
    );
    await atMe.append(message('2', 'later'));
    expect(atMe.openWindow(1)).toMatchObject([
      { type: 'gap', skipped: 1, mentioned: true },
      { segments: [{ type: 'text', text: 'later' }] },
    ]);

    const mine = message('1', 'mine', { msgId: must(MessageId(10)) });
    const reply = chat([mine]);
    await reply.append(message('2', 're', { replyTo: mine.msgId }));
    await reply.append(message('2', 'later'));
    expect(reply.openWindow(1)).toMatchObject([
      { type: 'gap', skipped: 1, mentioned: true },
      { segments: [{ type: 'text', text: 'later' }] },
    ]);
  });

  it('找不到缺口则报错', () => {
    const c = chat();
    expect(() =>
      c.readEvents({ gapId: must(GapId(0)), side: 'latest', limit: 1 }),
    ).toThrow(chatError.missing);
  });

  it('n 必须是自然数；0 只标已读，未读整袋变成缺口', async () => {
    next = 1;
    const c = chat();
    await c.append(message('2', 'a'));
    expect(() => c.openWindow(-1)).toThrow(chatError.notNatural);
    expect(c.openWindow(0)).toEqual([
      { type: 'gap', gapId: 0, skipped: 1, mentioned: false },
    ]);
    expect(c.openWindow(10)).toEqual([]);
  });

  it('readEvents 从最晚揭，新缺口在前', async () => {
    next = 1;
    const c = chat();
    await c.append(message('2', 'a'));
    await c.append(message('2', 'b'));
    await c.append(message('2', 'c'));
    await c.append(message('2', 'd'));
    await c.append(message('2', 'e'));
    const opened = c.openWindow(2);
    expect(texts(opened)).toEqual(['d', 'e']);
    const gapId =
      opened[0] && opened[0].type === 'gap' ? opened[0].gapId : undefined;
    expect(
      c.readEvents({ gapId: must(gapId), side: 'latest', limit: 1 }),
    ).toMatchObject([
      { type: 'gap', gapId: 1, skipped: 2, mentioned: false },
      { segments: [{ type: 'text', text: 'c' }] },
    ]);
  });

  it('readEvents 从最早揭，新缺口在后', async () => {
    next = 1;
    const c = chat();
    await c.append(message('2', 'a'));
    await c.append(message('2', 'b'));
    await c.append(message('2', 'c'));
    await c.append(message('2', 'd'));
    const opened = c.openWindow(1);
    const gapId =
      opened[0] && opened[0].type === 'gap' ? opened[0].gapId : undefined;
    expect(
      c.readEvents({ gapId: must(gapId), side: 'earliest', limit: 1 }),
    ).toMatchObject([
      { segments: [{ type: 'text', text: 'a' }] },
      { type: 'gap', gapId: 1, skipped: 2, mentioned: false },
    ]);
  });

  it('揭完没有新缺口；旧 gapId 仍能再读；离开 chatting 也不丢掉', async () => {
    next = 1;
    const c = chat();
    await c.append(message('2', 'a'));
    await c.append(message('2', 'b'));
    const opened = c.openWindow(1);
    const gapId =
      opened[0] && opened[0].type === 'gap' ? opened[0].gapId : undefined;
    expect(
      texts(c.readEvents({ gapId: must(gapId), side: 'latest', limit: 10 })),
    ).toEqual(['a']);
    expect(
      texts(c.readEvents({ gapId: must(gapId), side: 'latest', limit: 10 })),
    ).toEqual(['a']);

    await c.append(message('2', 'c'));
    await c.append(message('2', 'd'));
    await c.append(message('2', 'e'));
    const again = c.openWindow(1);
    const live =
      again[0] && again[0].type === 'gap' ? again[0].gapId : undefined;
    expect(
      texts(c.readEvents({ gapId: must(live), side: 'earliest', limit: 1 })),
    ).toEqual(['c']);
  });

  it('新缺口的 mentioned 只算还没揭的', async () => {
    next = 1;
    const c = chat();
    await c.append(
      message('2', 'hi', {
        segments: [{ type: 'at', userId: must(UserId('1')) }],
      }),
    );
    await c.append(message('2', 'mid'));
    await c.append(message('2', 'later'));
    const opened = c.openWindow(1);
    const gapId =
      opened[0] && opened[0].type === 'gap' ? opened[0].gapId : undefined;
    expect(
      c.readEvents({ gapId: must(gapId), side: 'latest', limit: 1 }),
    ).toMatchObject([
      { type: 'gap', skipped: 1, mentioned: true },
      { segments: [{ type: 'text', text: 'mid' }] },
    ]);
  });
});
