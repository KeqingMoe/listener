import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import {
  type ChatMessage,
  type Completion,
  type Model,
} from '../../../src/contracts/model.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime, wakeMeta } from '../../support/listener-fixture.ts';

const self = '900000001';
const cfg: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 5,
  delayMaxMs: 5,
  cooldownMs: 5,
  retentionDays: 7,
  randomReplyProbability: 1,
  randomCooldownMs: 0,
  randomMaxPerMinute: 10,
};

class MockMemory implements Memory {
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
    return this.entries.find((entry) => entry.messageId === id);
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

function event(
  messageId = '1',
  direct = false,
  overrides: Record<string, unknown> = {},
) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: LISTENER_GROUP,
    self_id: self,
    user_id: '12345',
    message_id: messageId,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'member' },
    message: [
      ...(direct ? [{ type: 'at', data: { qq: self } }] : []),
      { type: 'text', data: { text: 'hello' } },
    ],
    ...overrides,
  };
}

function tool(
  name: string,
  args: unknown = name === 'finish' ? { mode: 'hard' } : {},
): Completion {
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

function sendAndFinish(args: unknown): Completion {
  return {
    content: null,
    tool_calls: [
      ...tool('send_message', args).tool_calls,
      ...tool('finish').tool_calls.map((c) => ({ ...c, id: 'finish' })),
    ],
  };
}

function setup(
  options: {
    config?: Partial<ListenerConfig>;
    random?: () => number;
    complete?: Model['complete'];
  } = {},
) {
  const memory = new MockMemory();
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const requests: {
    messages: ChatMessage[];
    tools: string[];
    signal?: AbortSignal;
  }[] = [];
  let draws = 0;
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      if (action === 'send_group_msg') {
        return { message_id: String(10000 + calls.length) };
      }
      if (action === 'get_login_info') {
        return { user_id: self };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: LISTENER_GROUP,
          user_id: params.user_id,
          nickname: 'member',
          role: params.user_id === self ? 'admin' : 'member',
        };
      }
      if (action === 'set_group_ban') {
        return null;
      }
      return {};
    },
  };
  const model: Model = {
    async complete(messages, tools, signal) {
      requests.push({
        messages: structuredClone(messages),
        tools: tools?.map((t) => t.function.name) ?? [],
        signal,
      });
      return options.complete
        ? options.complete(messages, tools, signal)
        : tool('finish');
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    { ...cfg, ...options.config },
    () => {
      draws++;
      return options.random?.() ?? 0.5;
    },
    undefined,
    undefined,
    sessionRuntime({ ...cfg, ...options.config }.groupId).runtime,
  );
  return {
    bot,
    api,
    memory,
    calls,
    requests,
    get draws() {
      return draws;
    },
  };
}

/** 第index次模型请求所属唤醒的触发类型（会话模式只注入wake元数据）。 */
function trigger(s: ReturnType<typeof setup>, index = 0): unknown {
  return (wakeMeta(s.requests[index]!.messages).trigger as { type?: unknown })
    ?.type;
}

/** 请求中最后一条工具结果。 */
function lastToolResult(messages: readonly ChatMessage[]) {
  const result = messages.findLast((m) => m.role === 'tool');
  assert.ok(result && typeof result.content === 'string');
  return JSON.parse(result.content);
}

/** 第一轮读取本群消息，第二轮结束；供断言模型实际能读到的消息。 */
function readThenFinish(): Model['complete'] {
  let rounds = 0;
  return async () =>
    ++rounds === 1
      ? tool('read_events', {
          limit: 100,
          types: ['message.created'],
          direction: 'forward',
        })
      : tool('finish');
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('timed out waiting for listener');
}

async function settled() {
  await delay(25);
}

test('ordinary probability zero/one and strict rng < probability boundary', async () => {
  for (const [probability, rng, expected] of [
    [0, 0, 0],
    [1, 0.999999, 1],
    [0.5, 0.5, 0],
    [0.5, 0.499999, 1],
  ]) {
    const s = setup({
      config: { randomReplyProbability: probability },
      random: () => rng!,
    });
    try {
      await s.bot.receive(event(), self);
      await settled();
      assert.equal(
        s.requests.length,
        expected,
        `probability=${probability}, rng=${rng}`,
      );
      if (expected) {
        assert.equal(trigger(s), 'random');
      }
    } finally {
      await s.bot.stop();
    }
  }
});

test('deduplication never repeats the probability draw, even after a failed draw', async () => {
  const s = setup({
    config: { randomReplyProbability: 0.1 },
    random: () => 0.9,
  });
  try {
    await s.bot.receive(event(), self);
    const draws = s.draws;
    await s.bot.receive(event(), self);
    await settled();
    assert.equal(draws, 1);
    assert.equal(s.draws, draws);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('self/private/wrong group/wrong self/stale events and commands never draw randomly', async () => {
  const s = setup();
  try {
    for (const overrides of [
      { user_id: self },
      { message_type: 'private' },
      { group_id: '999' },
      { self_id: '999' },
      { time: 1 },
    ]) {
      await s.bot.receive(event('1', false, overrides), self);
    }
    assert.equal(s.memory.entries.length, 0);
    for (const [i, text] of [
      '/reset',
      '/confirm deadbeef',
      '/unknown',
    ].entries()) {
      await s.bot.receive(
        event(String(i + 2), false, {
          message: [{ type: 'text', data: { text } }],
        }),
        self,
      );
    }
    await settled();
    assert.equal(s.draws, 0);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('direct at bypasses zero probability and random cooldown/cap with real direct provenance', async () => {
  for (const probability of [0, 1]) {
    const s = setup({
      config: {
        randomReplyProbability: probability,
        randomCooldownMs: 60000,
        randomMaxPerMinute: 1,
      },
    });
    try {
      if (probability) {
        await s.bot.receive(event(), self);
        await until(() => s.requests.length === 1);
        await settled();
      }
      const before = s.requests.length;
      await s.bot.receive(event('2', true, { user_id: OWNER_ID }), self);
      await until(() => s.requests.length === before + 1);
      assert.equal(trigger(s, before), 'direct');
      assert.ok(!s.requests[before]!.tools.includes('mute_member'));
    } finally {
      await s.bot.stop();
    }
  }
});

test('owner random turn cannot enable default-off moderation and rejects invented mute before APIs', async () => {
  let rounds = 0;
  const s = setup({
    complete: async () =>
      ++rounds === 1
        ? tool('mute_member', { user_id: '12345', seconds: 60 })
        : tool('finish'),
  });
  try {
    await s.bot.receive(event('1', false, { user_id: OWNER_ID }), self);
    await until(() => s.requests.length === 2);
    await settled();
    assert.equal(trigger(s), 'random');
    for (const turn of s.requests) {
      for (const name of ['mute_member', 'recall_message', 'set_member_card']) {
        assert.ok(!turn.tools.includes(name));
      }
    }
    assert.equal(lastToolResult(s.requests[1]!.messages).status, 'error');
    assert.deepEqual(s.calls, []);
  } finally {
    await s.bot.stop();
  }
});

test('nonowner random turn may autonomously propose configured moderation but only owner confirms', async () => {
  let rounds = 0;
  const s = setup({
    config: {
      toolPermissions: toolPermissions({
        ...MEMBER_TOOLS,
        mute_member: { mode: 'confirm', maxSeconds: 600 },
        unmute_member: 'off',
        recall_message: 'off',
        set_member_card: 'off',
      }),
      confirmationTtlSeconds: 60,
    },
    complete: async () =>
      ++rounds === 1
        ? tool('mute_member', { user_id: '12345', seconds: 60 })
        : tool('finish'),
  });
  try {
    await s.bot.receive(event('1', false, { user_id: '55555' }), self);
    await until(() =>
      s.calls.some(
        (c) =>
          c.action === 'send_group_msg' &&
          JSON.stringify(c.params).includes('/confirm'),
      ),
    );
    await settled();
    assert.equal(s.requests.length, 2);
    assert.equal(trigger(s), 'random');
    assert.ok(s.requests[0]!.tools.includes('mute_member'));
    assert.ok(!s.calls.some((c) => c.action === 'set_group_ban'));
    const notification = s.calls.find((c) => c.action === 'send_group_msg')!,
      code = /\/confirm ([a-f0-9]{32})/.exec(
        JSON.stringify(notification.params),
      )![1]!;
    const command = (id: string, user_id: string) =>
      event(id, false, {
        user_id,
        message: [{ type: 'text', data: { text: `/confirm ${code}` } }],
      });
    await s.bot.receive(command('2', '55555'), self);
    assert.ok(!s.calls.some((c) => c.action === 'set_group_ban'));
    await s.bot.receive(command('3', OWNER_ID), self);
    assert.deepEqual(
      s.calls.filter((c) => c.action === 'set_group_ban').map((c) => c.params),
      [{ group_id: LISTENER_GROUP, user_id: '12345', duration: 60 }],
    );
  } finally {
    await s.bot.stop();
  }
});

test('pending direct cannot be replaced by ordinary random candidate', async () => {
  const s = setup();
  try {
    await s.bot.receive(event('1', true), self);
    const draws = s.draws;
    await s.bot.receive(event('2'), self);
    assert.equal(s.draws, draws);
    await until(() => s.requests.length === 1);
    await settled();
    assert.equal(s.requests.length, 1);
    assert.equal(trigger(s), 'direct');
  } finally {
    await s.bot.stop();
  }
});

test('pending random upgrades to direct and retains every caller in arrival order', async () => {
  const s = setup({ complete: readThenFinish() });
  try {
    await s.bot.receive(event('1'), self);
    await s.bot.receive(event('2', true), self);
    await s.bot.receive(event('3', true), self);
    assert.equal(s.requests.length, 0, 'receive must defer model work');
    await until(() => s.requests.length === 2);
    await settled();
    assert.equal(s.requests.length, 2, 'one wake: read then finish');
    assert.equal(trigger(s), 'direct');
    assert.deepEqual(
      lastToolResult(s.requests[1]!.messages).events.map(
        (e: { payload: { message: { messageId: string } } }) =>
          e.payload.message.messageId,
      ),
      ['1', '2', '3'],
    );
  } finally {
    await s.bot.stop();
  }
});

test('new direct requests preserve running random reply and form one next batch', async () => {
  let release!: (value: Completion) => void;
  let rounds = 0;
  const s = setup({
    complete: async () =>
      ++rounds === 1
        ? new Promise<Completion>((resolve) => {
            release = resolve;
          })
        : tool('finish'),
  });
  try {
    await s.bot.receive(event(), self);
    await until(() => s.requests.length === 1);
    await s.bot.receive(event('2', true), self);
    await s.bot.receive(event('3', true, { user_id: '67890' }), self);
    await settled();
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0]!.signal!.aborted, false);
    assert.equal(trigger(s), 'random');
    release(
      sendAndFinish({
        segments: [{ type: 'text', text: 'finish original random reply' }],
      }),
    );
    await until(() => s.requests.length === 2);
    await settled();
    assert.equal(
      s.calls.filter((c) => c.action === 'send_group_msg').length,
      1,
    );
    assert.equal(s.requests.length, 2);
    assert.equal(trigger(s, 1), 'direct');
  } finally {
    release?.(tool('finish'));
    await s.bot.stop();
  }
});

test('ordinary messages collected while busy receive one random decision at turn end', async () => {
  for (const probability of [0, 1]) {
    let release!: (value: Completion) => void;
    let rounds = 0;
    const s = setup({
      config: { randomReplyProbability: probability },
      complete: async () =>
        ++rounds === 1
          ? new Promise<Completion>((resolve) => {
              release = resolve;
            })
          : tool('finish'),
    });
    try {
      await s.bot.receive(event('1', true), self);
      await until(() => s.requests.length === 1);
      const before = s.draws;
      for (let n = 2; n <= 51; n++) {
        await s.bot.receive(event(String(n)), self);
      }
      assert.equal(s.draws, before, 'collection must not sample each message');
      assert.equal(s.requests.length, 1);
      release(tool('finish'));
      await until(() => !(s.bot as any).running);
      await settled();
      assert.equal(s.requests.length, 1 + probability);
      assert.equal(
        s.draws,
        before + 1 + probability,
        'one participation draw plus one delay draw only when selected',
      );
      if (probability) {
        assert.equal(trigger(s, 1), 'random');
      }
    } finally {
      release?.(tool('finish'));
      await s.bot.stop();
    }
  }
});

test('stale async reply lookup cannot admit random after a newer direct turn finishes', async () => {
  const s = setup();
  let release!: (value: unknown) => void;
  const originalCall = s.api.call;
  s.api.call = async (action, params) =>
    action === 'get_msg'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : originalCall(action, params);
  let pending: Promise<void> | undefined;
  try {
    pending = s.bot.receive(
      event('1', false, {
        message: [
          { type: 'reply', data: { id: '999' } },
          { type: 'text', data: { text: 'ordinary reply' } },
        ],
      }),
      self,
    );
    await until(() => !!release);
    await s.bot.receive(event('2', true), self);
    await until(() => s.requests.length === 1);
    await settled();
    const draws = s.draws;
    release({
      message_type: 'group',
      group_id: LISTENER_GROUP,
      message_id: '999',
      sender: { user_id: '12345' },
    });
    await pending;
    await settled();
    assert.equal(s.requests.length, 1);
    assert.equal(s.draws, draws);
    assert.equal(trigger(s), 'direct');
  } finally {
    release?.({});
    await pending;
    await s.bot.stop();
  }
});

test('random decision cooldown and rolling minute cap count silence, not only sends', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const s = setup({
    config: { randomCooldownMs: 1000, randomMaxPerMinute: 2 },
  });
  try {
    await s.bot.receive(event('1'), self);
    await until(() => s.requests.length === 1);
    await settled();
    const initialDraws = s.draws;
    now += 999;
    await s.bot.receive(event('2'), self);
    await settled();
    assert.equal(s.requests.length, 1);
    assert.equal(s.draws, initialDraws);
    now += 1;
    await s.bot.receive(event('3'), self);
    await until(() => s.requests.length === 2);
    await settled();
    const cappedDraws = s.draws;
    now += 1000;
    await s.bot.receive(event('4'), self);
    await settled();
    assert.equal(s.requests.length, 2);
    assert.equal(s.draws, cappedDraws);
    now += 58000;
    await s.bot.receive(event('5'), self);
    await until(() => s.requests.length === 3);
    assert.deepEqual(s.calls, []);
  } finally {
    await s.bot.stop();
  }
});

test('structured send_message at becomes native OneBot at, never marker text', async () => {
  const s = setup({
    complete: async () =>
      sendAndFinish({
        segments: [
          { type: 'at', user_id: '12345' },
          { type: 'text', text: 'hi' },
        ],
      }),
  });
  try {
    await s.bot.receive(event('1', true), self);
    await until(() => s.calls.some((c) => c.action === 'send_group_msg'));
    const lookup = s.calls.find((c) => c.action === 'get_group_member_info');
    assert.equal(lookup?.params.group_id, LISTENER_GROUP);
    assert.equal(lookup?.params.user_id, '12345');
    const sent = s.calls.find((c) => c.action === 'send_group_msg')!;
    assert.equal(sent.params.group_id, LISTENER_GROUP);
    assert.deepEqual(sent.params.message, [
      { type: 'at', data: { qq: '12345' } },
      { type: 'text', data: { text: 'hi' } },
    ]);
    assert.ok(!JSON.stringify(sent.params.message).includes('[at'));
  } finally {
    await s.bot.stop();
  }
});

// TOML默认值和非法值由config-loader.test.ts覆盖。
