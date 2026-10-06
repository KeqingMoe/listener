import type { GroupMessage } from 'node-napcat-ts';
import { describe, expect, it } from 'vitest';
import { MessageId, UserId } from '@/id';
import { read, write } from '@/message';

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

function group(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_format: 'array',
    self_id: 1,
    group_id: 100,
    time: 1_700_000_000,
    message_seq: 1,
    real_id: 10,
    raw_message: '',
    font: 0,
    sender: { user_id: 2, nickname: 'n', card: '' },
    message: [{ type: 'text', data: { text: 'hi' } }],
    message_id: 10,
    user_id: 2,
    quick_action: async () => null,
    ...overrides,
  };
}

describe('message', () => {
  it('把群消息收成 MessageCreated，回复升到顶层', () => {
    const mine = read(
      group({
        user_id: 1,
        message_id: 10,
        sender: { user_id: 1, nickname: 'n', card: '' },
        message: [{ type: 'text', data: { text: 'mine' } }],
      }),
    );
    const re = read(
      group({
        user_id: 2,
        message_id: 11,
        message: [
          { type: 'reply', data: { id: '10' } },
          { type: 'at', data: { qq: '1' } },
          { type: 'text', data: { text: 're' } },
        ],
      }),
    );
    expect(mine).toMatchObject({
      type: 'message.created',
      msgId: 10,
      userId: '1',
      segments: [{ type: 'text', text: 'mine' }],
    });
    expect(re).toMatchObject({
      msgId: 11,
      userId: '2',
      replyTo: 10,
      segments: [
        { type: 'at', userId: '1' },
        { type: 'text', text: 're' },
      ],
    });
  });

  it('不认识的段记为 unsupported；at all 保留', () => {
    const stored = read(
      group({
        message: [
          { type: 'at', data: { qq: 'all' } },
          {
            type: 'image',
            data: {
              summary: '',
              file: 'a',
              sub_type: 0,
              url: '',
              file_size: '1',
            },
          },
        ],
      }),
    );
    expect(stored?.segments).toEqual([
      { type: 'at.all' },
      { type: 'unsupported' },
    ]);
  });

  it('原消息未见过仍保留 replyTo；非法 id 则丢掉', () => {
    const missing = read(
      group({
        message_id: 11,
        message: [
          { type: 'reply', data: { id: '99' } },
          { type: 'text', data: { text: 're' } },
        ],
      }),
    );
    expect(missing?.replyTo).toBe(99);
    expect(read(group({ message_id: 1.5 }))).toBeUndefined();
    expect(read(group({ user_id: 0 }))).toBeUndefined();
  });

  it('write 把回复和段收成 NapCat 段', () => {
    expect(
      write({
        segments: [
          { type: 'at', userId: must(UserId('2')) },
          { type: 'text', text: '回' },
        ],
        replyTo: must(MessageId(10)),
      }),
    ).toEqual([
      { type: 'reply', data: { id: '10' } },
      { type: 'at', data: { qq: '2' } },
      { type: 'text', data: { text: '回' } },
    ]);
  });
});
