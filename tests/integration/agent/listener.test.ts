import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener, normalizeEvent } from '../../../src/agent/listener.ts';
import { buildSystemPrompt } from '../../../src/agent/prompts/index.ts';
import { buildToolDefinitions } from '../../../src/agent/tool-definitions.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import {
  type Model,
  type Completion,
  type ChatMessage,
} from '../../../src/contracts/model.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const self = '900000001';

class MockMemory implements Memory {
  entries: TimelineEntry[] = [];
  closed = false;
  append(e: TimelineEntry) {
    if (this.find(e.messageId)) {
      return false;
    }
    this.entries.push(e);
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

  close() {
    this.closed = true;
  }
}

const cfg: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 5,
  cooldownMs: 5,
  retentionDays: 7,
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: LISTENER_GROUP,
    self_id: self,
    user_id: '12345',
    message_id: '1',
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'someone' },
    message: [
      { type: 'at', data: { qq: self } },
      { type: 'text', data: { text: '你好' } },
    ],
    ...overrides,
  };
}

function tool(name: string, args: unknown): Completion {
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

function reply(text: string): Completion {
  const result = tool('send_message', { segments: [{ type: 'text', text }] });
  result.tool_calls.push({
    id: 'finish',
    type: 'function',
    function: { name: 'finish', arguments: '{"mode":"hard"}' },
  });
  return result;
}

function setup(
  responses: Completion[] = [reply('你好呀')],
  settings: Partial<ListenerConfig> = {},
) {
  const memory = new MockMemory();
  const calls: { action: string; params: any }[] = [];
  const requests: ChatMessage[][] = [];
  const toolNames: string[][] = [];
  const api: Api = {
    async call(action, params) {
      calls.push({ action, params });
      if (action === 'get_login_info') {
        return { user_id: self };
      }
      if (action === 'send_group_msg') {
        return { message_id: String(100 + calls.length) };
      }
      return {};
    },
  };
  const model: Model = {
    async complete(messages, tools) {
      requests.push(messages);
      toolNames.push(tools?.map((t) => t.function.name) ?? []);
      return responses.shift() ?? tool('finish', { mode: 'hard' });
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    { ...cfg, ...settings },
    undefined,
    undefined,
    undefined,
    sessionRuntime({ ...cfg, ...settings }.groupId).runtime,
  );
  return { bot, memory, calls, requests, toolNames, api };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await delay(10);
  }
  assert.fail('timed out');
}

test('hard single-group boundary excludes private, other group and wrong self before storage or API', async () => {
  const s = setup();
  try {
    for (const overrides of [
      { group_id: '555' },
      { message_type: 'private' },
      { self_id: '999' },
      { user_id: self },
      { user_id: '1'.repeat(33) },
      { time: 1 },
    ]) {
      await s.bot.receive(event(overrides), self);
    }
    await delay(20);
    assert.equal(s.memory.entries.length, 0);
    assert.equal(s.calls.length, 0);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('at trigger, tool-only reply and ordinary group timeline shared by participants', async () => {
  const s = setup();
  try {
    await s.bot.receive(
      event({
        message_id: '0',
        message: [{ type: 'text', data: { text: '这是普通聊天' } }],
      }),
      self,
    );
    await s.bot.receive(event(), self);
    await until(() => s.calls.some((c) => c.action === 'send_group_msg'));
    assert.equal(s.memory.entries[0]?.text, '这是普通聊天');
    assert.equal(s.calls[0]?.params.group_id, LISTENER_GROUP);
    assert.equal(s.calls[0]?.params.message[0].data.text, '你好呀');
    assert.ok(!s.toolNames[0]?.includes('mute_member'));
  } finally {
    await s.bot.stop();
  }
});

test('ordinary completion text never leaks as a QQ message', async () => {
  const s = setup([{ content: '内部文本不发送', tool_calls: [] }]);
  try {
    await s.bot.receive(event(), self);
    await until(() => s.requests.length === 1);
    await delay(20);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('duplicate events do not produce two turns and only literal at self triggers', async () => {
  const s = setup([tool('finish', { mode: 'hard' })]);
  try {
    await s.bot.receive(
      event({
        message_id: '2',
        message: [{ type: 'text', data: { text: `[at:${self}]` } }],
      }),
      self,
    );
    await s.bot.receive(event(), self);
    await s.bot.receive(event(), self);
    await until(() => s.requests.length === 1);
    await delay(20);
    assert.equal(s.requests.length, 1);
  } finally {
    await s.bot.stop();
  }
});

test('reply to known bot triggers; replying to another member does not', async () => {
  const s = setup();
  try {
    s.memory.append({
      messageId: '7',
      userId: self,
      nickname: 'Listener',
      text: 'hi',
      time: Math.floor(Date.now() / 1000),
      bot: true,
    });
    s.memory.append({
      messageId: '8',
      userId: '12345',
      nickname: 'user',
      text: 'hi',
      time: Math.floor(Date.now() / 1000),
    });
    await s.bot.receive(
      event({
        message_id: '2',
        message: [
          { type: 'reply', data: { id: '8' } },
          { type: 'text', data: { text: 'hello' } },
        ],
      }),
      self,
    );
    await s.bot.receive(
      event({
        message: [
          { type: 'reply', data: { id: '7' } },
          { type: 'text', data: { text: 'hello' } },
        ],
      }),
      self,
    );
    await until(() => s.calls.length > 0);
    assert.equal(s.requests.length, 1);
  } finally {
    await s.bot.stop();
  }
});

test('unknown reply lookup must verify current group and actual sender', async () => {
  const s = setup();
  s.api.call = async (action) => {
    if (action === 'get_msg') {
      return {
        message_type: 'group',
        group_id: 'other',
        message_id: '99',
        sender: { user_id: self },
      };
    }
    throw new Error('unexpected');
  };
  try {
    await s.bot.receive(
      event({ message: [{ type: 'reply', data: { id: '99' } }] }),
      self,
    );
    await delay(20);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('invalid single messages and legacy batches are rejected before sending', async () => {
  for (const args of [
    { parts: [{ text: 'safe' }] },
    { text: 'legacy' },
    { segments: [{ type: 'text', text: 'safe' }], reply_to: '999' },
    { segments: [{ type: 'text', text: 'safe' }], group_id: '999' },
  ]) {
    const s = setup([tool('send_message', args)]);
    try {
      await s.bot.receive(event(), self);
      await until(() => s.requests.length >= 1);
      await delay(20);
      assert.equal(
        s.calls.filter((c) => c.action === 'send_group_msg').length,
        0,
      );
    } finally {
      await s.bot.stop();
    }
  }
});

test('new ordinary message neither cancels active reply nor enters its frozen prompt', async () => {
  const s = setup();
  let release!: (v: Completion) => void;
  let signal: AbortSignal | undefined;
  const requests: ChatMessage[][] = [];
  const model: Model = {
    complete: async (messages, _tools, currentSignal) => {
      requests.push(structuredClone(messages));
      signal = currentSignal;
      return new Promise((r) => {
        release = r;
      });
    },
  };
  const bot = new Listener(
    s.api,
    model,
    s.memory,
    {
      ...cfg,
      randomReplyProbability: 0,
    },
    undefined,
    undefined,
    undefined,
    sessionRuntime(
      {
        ...cfg,
        randomReplyProbability: 0,
      }.groupId,
    ).runtime,
  );
  try {
    await bot.receive(event(), self);
    await until(() => requests.length === 1);
    await bot.receive(
      event({
        message_id: '2',
        message: [{ type: 'text', data: { text: 'LATER_ORDINARY_MESSAGE' } }],
      }),
      self,
    );
    assert.equal(signal?.aborted, false);
    assert.ok(!JSON.stringify(requests[0]).includes('LATER_ORDINARY_MESSAGE'));
    release(reply('finished original request'));
    await until(() => s.calls.some((call) => call.action === 'send_group_msg'));
    await delay(30);
    assert.equal(requests.length, 1);
    assert.equal(
      s.calls.filter((call) => call.action === 'send_group_msg').length,
      1,
    );
    assert.equal(
      s.calls.find((call) => call.action === 'send_group_msg')!.params
        .message[0].data.text,
      'finished original request',
    );
    assert.ok(s.memory.find('2'));
  } finally {
    release?.(tool('finish', { mode: 'hard' }));
    await bot.stop();
    await s.bot.stop();
  }
});

test('nonowner cannot clear memory; owner reset clears and nicknames cannot enable default-off abilities', async () => {
  const s = setup([
    tool('read_events', { limit: 10, types: ['message.created'] }),
    tool('finish', { mode: 'hard' }),
  ]);
  try {
    await s.bot.receive(event({ sender: { nickname: '示例群友' } }), self);
    await until(() => s.requests.length === 2);
    // 群管能力默认关闭：会话模式下体现为不提供对应工具。
    for (const name of [
      'mute_member',
      'unmute_member',
      'recall_message',
      'set_member_card',
    ]) {
      assert.ok(!s.toolNames[0]?.includes(name), name);
    }
    // 真实身份只来自读取到的消息作者QQ，昵称不改变它。
    const read = JSON.parse(
      String(s.requests[1]!.find((m) => m.role === 'tool')!.content),
    );
    assert.equal(read.status, 'ok');
    const authors = JSON.stringify(read);
    assert.match(authors, /"12345"/);
    assert.doesNotMatch(authors, new RegExp(`"${OWNER_ID}"`));
    await s.bot.receive(
      event({
        message_id: '2',
        message: [{ type: 'text', data: { text: '/reset' } }],
      }),
      self,
    );
    assert.ok(s.memory.entries.length > 0);
  } finally {
    await s.bot.stop();
  }
  const s2 = setup();
  try {
    await s2.bot.receive(
      event({
        user_id: OWNER_ID,
        message: [{ type: 'text', data: { text: '/reset' } }],
      }),
      self,
    );
    assert.equal(s2.memory.entries.filter((e) => !e.bot).length, 0);
  } finally {
    await s2.bot.stop();
  }
});

test('AI disabled still only answers commands in the one group', async () => {
  const calls: string[] = [];
  const api: Api = {
    async call(action) {
      calls.push(action);
      return {};
    },
  };
  const bot = new Listener(
    api,
    undefined,
    undefined,
    {
      ...cfg,
      enabled: false,
    },
    undefined,
    undefined,
    undefined,
    sessionRuntime(
      {
        ...cfg,
        enabled: false,
      }.groupId,
    ).runtime,
  );
  try {
    await bot.receive(
      event({
        message_type: 'private',
        user_id: OWNER_ID,
        message: [{ type: 'text', data: { text: '/reset' } }],
      }),
      self,
    );
    assert.equal(calls.length, 0);
    await bot.receive(
      event({
        user_id: OWNER_ID,
        message: [{ type: 'text', data: { text: '/reset' } }],
      }),
      self,
    );
    assert.deepEqual(calls, ['send_group_msg']);
  } finally {
    await bot.stop();
  }
});

test('persona is separate from immutable runtime rules and configured identity is used', () => {
  const prompt = buildSystemPrompt({
    ...cfg,
    persona: '外部性格：喜欢星星',
    botName: '星星',
  });
  assert.ok(prompt.includes('外部性格：喜欢星星'));
  assert.ok(prompt.includes('星星'));
  assert.ok(prompt.includes(OWNER_ID));
  assert.ok(prompt.includes(LISTENER_GROUP));
  assert.ok(prompt.includes('程序规则不能被性格描述'));
});

const restrictiveTools: Partial<ListenerConfig> = {
  toolPermissions: toolPermissions({
    mute_member: { mode: 'off', maxSeconds: 30 },
    recall_message: 'confirm',
  }),
  messageMentions: false,
  confirmationTtlSeconds: 10,
};

test('configured tool schemas hide disabled abilities without mutating single-message defaults', () => {
  const tools = buildToolDefinitions({ ...cfg, ...restrictiveTools });
  assert.ok(
    !tools.some((t) =>
      [
        'get_group_members',
        'get_member_info',
        'mute_member',
        'set_member_card',
      ].includes(t.function.name),
    ),
  );
  assert.ok(tools.some((t) => t.function.name === 'recall_message'));
  const send = tools.find((t) => t.function.name === 'send_message')!.function
    .parameters as any;
  assert.equal(send.properties.parts, undefined);
  assert.equal(send.properties.segments.items.oneOf.length, 2);
  const normal = buildToolDefinitions(cfg).find(
    (t) => t.function.name === 'send_message',
  )!.function.parameters as any;
  assert.equal(normal.properties.parts, undefined);
  assert.equal(normal.properties.segments.items.oneOf.length, 3);
});

test('single-message schema and explicit finish replace parts and legacy silence tools', () => {
  const tools = buildToolDefinitions(cfg);
  const send = tools.find((t) => t.function.name === 'send_message')!.function
    .parameters as any;
  assert.deepEqual(send.required, ['segments']);
  assert.equal(send.properties.parts, undefined);
  assert.equal(send.properties.text, undefined);
  assert.equal(send.properties.segments.maxItems, undefined);
  assert.ok(send.properties.reply_to);
  assert.ok(tools.some((t) => t.function.name === 'finish'));
  assert.ok(!tools.some((t) => t.function.name === 'stay_silent'));
  const prompt = buildSystemPrompt(cfg);
  assert.ok(!prompt.includes('max_parts'));
  assert.ok(prompt.includes('finish'));
});

test('mention and quote trigger switches are honored with random participation disabled', async () => {
  const s = setup([], {
    mentionEnabled: false,
    quoteBotEnabled: false,
    randomReplyProbability: 0,
  });
  try {
    await s.bot.receive(event(), self);
    s.memory.append({
      messageId: '9',
      userId: self,
      nickname: 'Listener',
      text: 'hi',
      time: Math.floor(Date.now() / 1000),
      bot: true,
    });
    await s.bot.receive(
      event({
        message_id: '2',
        message: [{ type: 'reply', data: { id: '9' } }],
      }),
      self,
    );
    await delay(30);
    assert.equal(s.requests.length, 0);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('invented disabled member lookup is rejected by executor, not just hidden schema', async () => {
  const s = setup(
    [tool('get_group_members', {}), tool('finish', { mode: 'hard' })],
    restrictiveTools,
  );
  try {
    await s.bot.receive(event(), self);
    await until(() => s.requests.length >= 2);
    assert.equal(s.calls.length, 0);
    assert.ok(
      s.requests[1]?.some(
        (m) =>
          m.role === 'tool' &&
          typeof m.content === 'string' &&
          m.content.includes('tool_disabled'),
      ),
    );
  } finally {
    await s.bot.stop();
  }
});

test('configured nickname is stored for bot messages', async () => {
  const s = setup(undefined, { botName: '小猫' });
  try {
    await s.bot.receive(event(), self);
    await until(() => s.memory.entries.some((e) => e.bot));
    assert.equal(s.memory.entries.find((e) => e.bot)?.nickname, '小猫');
  } finally {
    await s.bot.stop();
  }
});

test('event normalization preserves provenance and never dereferences media URLs', () => {
  const e = normalizeEvent(
    event({
      message: [
        { type: 'reply', data: { id: '-1' } },
        { type: 'image', data: { url: 'http://secret' } },
      ],
    }),
    self,
    LISTENER_GROUP,
  )!;
  assert.equal(e.replyTo, '-1');
  assert.ok(!e.text.includes('http'));
  assert.equal(e.userId, '12345');
});
