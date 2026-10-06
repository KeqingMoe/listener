import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  Chat,
  type Client,
  GroupId,
  MessageId,
  type Send,
  UnixTime,
  UserId,
} from '@listener/chat';
import { describe, expect, it } from 'vitest';
import { Loop } from '@/loop';
import { toolError, tools } from '@/tools';

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

describe('tools', () => {
  it('sendMessage 走 chat.send', async () => {
    const sent: Send[] = [];
    const client: Client = {
      async send(_groupId, message) {
        sent.push(message);
        return must(MessageId(20));
      },
      async message() {
        return undefined;
      },
    };
    const chat = new Chat(
      {
        selfId: must(UserId('1')),
        groupId: must(GroupId('100')),
      },
      client,
    );
    await chat.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      ts: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: [{ type: 'text', text: 'hello kq' }],
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('sendMessage', {
            segments: [{ type: 'text', text: '并非 kq' }],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(''),
    ]);
    const loop = new Loop(chat, 10, {
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      tools: tools(chat),
    });
    await loop.open();
    expect(sent).toEqual([{ segments: [{ type: 'text', text: '并非 kq' }] }]);
  });

  it('非法 at 报参数不合法', async () => {
    const chat = new Chat(
      {
        selfId: must(UserId('1')),
        groupId: must(GroupId('100')),
      },
      {
        async send() {
          return must(MessageId(1));
        },
        async message() {
          return undefined;
        },
      },
    );
    const sendMessage = tools(chat).find(tool => tool.name === 'sendMessage');
    if (sendMessage === undefined) {
      throw new Error('没有 sendMessage');
    }
    await expect(
      sendMessage.execute('', {
        segments: [{ type: 'at', userId: '0' }],
      }),
    ).rejects.toThrow(toolError.invalid);
  });
});
