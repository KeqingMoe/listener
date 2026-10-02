import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener, normalizeEvent } from '../../../src/agent/listener.ts';
import { buildToolDefinitions } from '../../../src/agent/tool-definitions.ts';
import { buildSystemPrompt } from '../../../src/agent/prompts/index.ts';
import {
  faceMarker,
  FACE_LAYOUT_GUIDANCE,
} from '../../../src/tools/faces/tools.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import {
  type Model,
  type Completion,
  type ChatMessage,
} from '../../../src/contracts/model.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const self = '900000001';
const config: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 1,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
};

class TestMemory implements Memory {
  entries: TimelineEntry[] = [];
  append(entry: TimelineEntry) {
    if (this.find(entry.messageId)) {
      return false;
    }
    this.entries.push(entry);
    return true;
  }

  recent() {
    return this.entries;
  }

  find(id: string) {
    return this.entries.find((e) => e.messageId === id);
  }

  context() {
    return JSON.stringify(this.entries);
  }

  async compact() {}
  clear() {
    this.entries = [];
  }

  close() {}
}

function event(message: unknown[], id = '1') {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: LISTENER_GROUP,
    self_id: self,
    user_id: '123',
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'member' },
    message,
  };
}

function completion(name: string, args: unknown): Completion {
  return {
    content: null,
    tool_calls: [
      {
        id: 'call1',
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function setup(reply: unknown) {
  const memory = new TestMemory();
  const calls: Array<{ action: string; params: any }> = [];
  const requests: ChatMessage[][] = [];
  const api: Api = {
    async call(action, params) {
      calls.push({ action, params });
      if (action === 'send_group_msg') {
        return { message_id: String(900 + calls.length) };
      }
      return {};
    },
  };
  const model: Model = {
    async complete(messages) {
      requests.push(structuredClone(messages));
      return requests.length === 1
        ? completion('send_message', reply)
        : completion('finish', { mode: 'hard' });
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    config,
    undefined,
    undefined,
    undefined,
    sessionRuntime(config.groupId).runtime,
  );
  return { bot, memory, calls, requests };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('listener did not settle');
}

test('super face layout guidance survives both mention modes without restricting the schema', () => {
  assert.ok(buildSystemPrompt(config).includes(FACE_LAYOUT_GUIDANCE));
  assert.match(FACE_LAYOUT_GUIDANCE, /不设置 reply_to/);
  assert.match(FACE_LAYOUT_GUIDANCE, /单独调用.*send_message/);
  for (const mention of [true, false]) {
    const cfg: ListenerConfig = {
      ...config,
      messageMentions: mention,
    };
    const send = buildToolDefinitions(cfg).find(
      (t) => t.function.name === 'send_message',
    )!;
    assert.ok(send.function.description.includes(FACE_LAYOUT_GUIDANCE));
    const params: any = send.function.parameters;
    assert.equal(params.properties.parts, undefined);
    assert.equal(params.properties.segments.maxItems, undefined);
    assert.ok(params.properties.reply_to);
  }
});

function faceSchema(configOverrides: Partial<ListenerConfig> = {}) {
  const tools = buildToolDefinitions({ ...config, ...configOverrides });
  const send = tools.find((t) => t.function.name === 'send_message')!;
  const params: any = send.function.parameters;
  const variants = params.properties.segments.items.oneOf as any[];
  return {
    params,
    variants,
    face: variants.find((v) => v.properties.type.const === 'face'),
  };
}

test('send tool includes strict ordinary and animated face choices without adding a quota', () => {
  const { params, face } = faceSchema();
  assert.ok(face);
  assert.equal(face.additionalProperties, false);
  assert.deepEqual(face.required, ['type', 'id']);
  assert.deepEqual(Object.keys(face.properties).sort(), ['id', 'name', 'type']);
  assert.equal(face.properties.name.maxLength, 80);
  assert.equal(face.properties.id.type, 'string');
  for (const id of ['0', '6', '14', '20', '21', '22', '32', '375']) {
    assert.ok(face.properties.id.enum.includes(id), id);
  }
  assert.ok(!face.properties.id.enum.includes('999999'));
  assert.equal(params.properties.parts, undefined);
  assert.equal(params.properties.segments.maxItems, undefined);
});

test('mention-disabled tool schema keeps face variant and removes only at', () => {
  const { variants, face } = faceSchema({
    toolPermissions: toolPermissions(),
    messageMentions: false,
  });
  assert.ok(face);
  assert.ok(face.properties.id.enum.includes('375'));
  assert.deepEqual(variants.map((v) => v.properties.type.const).sort(), [
    'face',
    'text',
  ]);
});

test('incoming faces preserve semantic names and order without raw metadata', () => {
  const entry = normalizeEvent(
    event([
      { type: 'text', data: { text: 'before' } },
      {
        type: 'face',
        data: {
          id: '20',
          raw: { token: 'RAW_SECRET' },
          resultId: 'RESULT_SECRET',
          chainCount: 100,
        },
      },
      { type: 'text', data: { text: 'middle' } },
      { type: 'face', data: { id: 375 } },
    ]),
    self,
    LISTENER_GROUP,
  )!;
  assert.equal(entry.text, `before${faceMarker('20')}middle${faceMarker(375)}`);
  assert.match(entry.text, /偷笑.*20/);
  assert.match(entry.text, /超级鼓掌.*375/);
  assert.ok(!JSON.stringify(entry).includes('SECRET'));
  assert.ok(!JSON.stringify(entry).includes('chainCount'));
});

test('unknown and malformed incoming IDs keep safe generic markers rather than raw values', () => {
  const unknown = normalizeEvent(
    event([{ type: 'face', data: { id: '999999', raw: 'SECRET_RAW' } }]),
    self,
    LISTENER_GROUP,
  )!;
  assert.match(unknown.text, /QQ表情/);
  assert.match(unknown.text, /999999/);
  assert.match(unknown.text, /未知/);
  for (const id of [
    'SECRET_BAD',
    '20\nSECRET',
    -1,
    NaN,
    {},
    [],
    null,
    undefined,
  ]) {
    const entry = normalizeEvent(
      event([{ type: 'face', data: { id, raw: 'SECRET_RAW' } }]),
      self,
      LISTENER_GROUP,
    )!;
    assert.match(entry.text, /QQ表情/);
    assert.match(entry.text, /未知/);
    assert.ok(!JSON.stringify(entry).includes('SECRET'));
  }
});

test('face-only model reply sends native OneBot face and persists semantic marker', async () => {
  const s = setup({ segments: [{ type: 'face', id: '375' }] });
  try {
    await s.bot.receive(
      event([
        { type: 'at', data: { qq: self } },
        { type: 'face', data: { id: '20', raw: 'SECRET_RAW' } },
      ]),
      self,
    );
    await until(() => s.memory.entries.some((e) => e.bot));
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0]!.action, 'send_group_msg');
    assert.equal(s.calls[0]!.params.group_id, LISTENER_GROUP);
    assert.deepEqual(s.calls[0]!.params.message, [
      { type: 'face', data: { id: '375' } },
    ]);
    assert.equal(s.memory.entries.find((e) => e.bot)!.text, faceMarker('375'));
    // 唤醒不注入消息正文；原始raw字段也不能进入模型请求。
    assert.ok(!JSON.stringify(s.requests).includes('SECRET_RAW'));
  } finally {
    await s.bot.stop();
  }
});

test('mixed native face reply retains text ordering and verified local reply target', async () => {
  const s = setup({
    reply_to: '1',
    segments: [
      { type: 'text', text: 'before' },
      { type: 'face', id: '0' },
      { type: 'text', text: 'after' },
      { type: 'face', id: '20' },
    ],
  });
  try {
    await s.bot.receive(
      event([
        { type: 'at', data: { qq: self } },
        { type: 'text', data: { text: 'hello' } },
      ]),
      self,
    );
    await until(() => s.memory.entries.some((e) => e.bot));
    assert.deepEqual(s.calls[0]!.params.message, [
      { type: 'reply', data: { id: '1' } },
      { type: 'text', data: { text: 'before' } },
      { type: 'face', data: { id: '0' } },
      { type: 'text', data: { text: 'after' } },
      { type: 'face', data: { id: '20' } },
    ]);
    const sent = s.memory.entries.find((e) => e.bot)!;
    assert.equal(sent.replyTo, '1');
    assert.equal(sent.text, `before${faceMarker('0')}after${faceMarker('20')}`);
  } finally {
    await s.bot.stop();
  }
});

test('invalid face in a single message prevents that message and membership lookup', async () => {
  const s = setup({
    segments: [
      { type: 'text', text: 'must not send' },
      { type: 'at', user_id: '456' },
      { type: 'face', id: '375', chainCount: 3 },
    ],
  });
  try {
    await s.bot.receive(event([{ type: 'at', data: { qq: self } }]), self);
    await until(() => s.requests.length >= 2 && !(s.bot as any).running);
    assert.equal(s.calls.length, 0);
    assert.ok(!s.memory.entries.some((e) => e.bot));
  } finally {
    await s.bot.stop();
  }
});
