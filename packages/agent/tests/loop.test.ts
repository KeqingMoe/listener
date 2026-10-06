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
  UnixTime,
  UserId,
} from '@listener/chat';
import { describe, expect, it } from 'vitest';
import { Loop, loopError } from '@/loop';

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
  };
}

function chat() {
  return new Chat(
    {
      selfId: must(UserId('1')),
      groupId: must(GroupId('100')),
    },
    client(),
  );
}

function loop(c = chat(), text = 'ok') {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(text)]);
  const l = new Loop(c, 10, {
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
  });
  return { chat: c, agent: l.agent, loop: l, faux };
}

function userJson(agent: Loop['agent'], index = 0) {
  const users = agent.state.messages.filter(message => message.role === 'user');
  const user = index < 0 ? users.at(index) : users[index];
  const raw = user && 'content' in user ? user.content : '';
  const content =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw
            .filter(
              (part): part is { type: 'text'; text: string } =>
                typeof part === 'object' &&
                part !== null &&
                'type' in part &&
                part.type === 'text',
            )
            .map(part => part.text)
            .join('')
        : '';
  return JSON.parse(content);
}

describe('Loop', () => {
  it('open 投结构化窗口；结束后离开 chatting', async () => {
    const c = chat();
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      ts: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: [{ type: 'text', text: 'a' }],
    });
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(11)),
      ts: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: [{ type: 'text', text: 'b' }],
    });
    const { agent, loop: l } = loop(c);
    await l.open();
    expect(l.chatting).toBe(false);
    expect(userJson(agent)).toEqual([
      {
        type: 'message.created',
        msgId: 10,
        ts: 1,
        userId: '2',
        segments: [{ type: 'text', text: 'a' }],
      },
      {
        type: 'message.created',
        msgId: 11,
        ts: 1,
        userId: '2',
        segments: [{ type: 'text', text: 'b' }],
      },
    ]);
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(12)),
      ts: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: [{ type: 'text', text: 'after' }],
    });
    expect(
      c.openWindow(10).map(event =>
        event.type === 'message.created'
          ? event.segments
              .filter(
                (segment): segment is { type: 'text'; text: string } =>
                  segment.type === 'text',
              )
              .map(segment => segment.text)
              .join('')
          : '',
      ),
    ).toEqual(['after']);
  });

  it('工具回合把未读整袋再投进去；推理期间没倒的下次开窗还在', async () => {
    const c = chat();
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      ts: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: [{ type: 'text', text: 'a' }],
    });
    const extra = {
      type: 'message.created' as const,
      msgId: must(MessageId(11)),
      ts: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: [{ type: 'text' as const, text: 'during' }],
    };
    const leftover = {
      type: 'message.created' as const,
      msgId: must(MessageId(12)),
      ts: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: [{ type: 'text' as const, text: 'after' }],
    };
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const inner = models.streamSimple.bind(models);
    let calls = 0;
    const l = new Loop(c, 10, {
      model: faux.getModel(),
      streamFn: async (model, context, options) => {
        calls += 1;
        if (calls === 1) {
          await c.append(extra);
        } else {
          await c.append(leftover);
        }
        return inner(model, context, options);
      },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('noop', {})], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(''),
    ]);
    await l.open();
    expect(l.chatting).toBe(false);
    expect(userJson(l.agent, -1)).toEqual([extra]);
    expect(c.openWindow().map(event => event.msgId)).toEqual([leftover.msgId]);
  });

  it('已经在 chatting 时不能再 open', async () => {
    const c = chat();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('')]);
    const inner = models.streamSimple.bind(models);
    const l = new Loop(c, 10, {
      model: faux.getModel(),
      streamFn: async (model, context, options) => {
        await new Promise(resolve => {
          setTimeout(resolve, 50);
        });
        return inner(model, context, options);
      },
    });
    const opened = l.open();
    await expect(l.open()).rejects.toThrow(loopError.alreadyOpen);
    await opened;
    expect(l.chatting).toBe(false);
  });
});
