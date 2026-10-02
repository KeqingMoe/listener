import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setTimeout as delay,
  setImmediate as flush,
} from 'node:timers/promises';
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
const config: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 12,
  delayMaxMs: 12,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
  randomCooldownMs: 0,
  randomMaxPerMinute: 100,
};

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const silent = (): Completion => tool('finish');

function tool(
  name: string,
  args: unknown = name === 'finish' ? { mode: 'hard' } : {},
): Completion {
  return {
    content: null,
    tool_calls: [
      {
        id: `call_${name}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function event(id: string, direct = true, userId = '12345', quote?: string) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: LISTENER_GROUP,
    self_id: self,
    user_id: userId,
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'member' },
    message: [
      ...(direct ? [{ type: 'at', data: { qq: self } }] : []),
      ...(quote ? [{ type: 'reply', data: { id: quote } }] : []),
      { type: 'text', data: { text: `body-${id}` } },
    ],
  };
}

class TestMemory implements Memory {
  entries: TimelineEntry[] = [];
  ids = new Set<string>();
  cap = 10000;
  compactHook: () => Promise<void> = async () => {};
  append(entry: TimelineEntry) {
    if (this.ids.has(entry.messageId)) {
      return false;
    }
    this.ids.add(entry.messageId);
    this.entries.push(entry);
    this.entries = this.entries.slice(-this.cap);
    return true;
  }

  recent() {
    return this.entries;
  }

  find(id: string) {
    return this.entries.find((e) => e.messageId === id);
  }

  context() {
    return JSON.stringify({ messages: this.entries });
  }

  compact() {
    return this.compactHook();
  }

  clear() {
    this.entries = [];
    this.ids.clear();
  }

  close() {}
}

function setup(
  options: {
    config?: Partial<ListenerConfig>;
    random?: () => number;
    complete?: Model['complete'];
    api?: Api['call'];
  } = {},
) {
  const memory = new TestMemory();
  const requests: {
    messages: ChatMessage[];
    tools: string[];
    signal?: AbortSignal;
  }[] = [];
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  let draws = 0;
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      if (options.api) {
        return options.api(action, params);
      }
      if (action === 'send_group_msg') {
        return { message_id: String(90000 + calls.length) };
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
        : silent();
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    { ...config, ...options.config },
    () => {
      draws++;
      return options.random?.() ?? 0.5;
    },
    undefined,
    undefined,
    sessionRuntime({ ...config, ...options.config }.groupId).runtime,
  );
  return {
    bot,
    memory,
    requests,
    calls,
    get draws() {
      return draws;
    },
  };
}

/** 第index次模型请求所属唤醒的触发类型；会话模式只注入wake元数据。 */
function trigger(s: ReturnType<typeof setup>, index = 0): unknown {
  return (wakeMeta(s.requests[index]!.messages).trigger as { type?: unknown })
    .type;
}

/** 第index次模型请求所属的唤醒ID。 */
function wakeId(s: ReturnType<typeof setup>, index = 0): unknown {
  return wakeMeta(s.requests[index]!.messages).wake_id;
}

/** 所有模型请求分属的唤醒数。 */
function wakes(s: ReturnType<typeof setup>): number {
  return new Set(s.requests.map((_, i) => wakeId(s, i))).size;
}

function result(s: ReturnType<typeof setup>, index: number): any {
  return JSON.parse(
    s.requests[index]!.messages.filter((m) => m.role === 'tool').at(-1)!
      .content as string,
  );
}

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('listener condition timed out');
}

// mock时钟确定精确的截止时间；异步闸门隔离其余调度边界。
test('fixed first-caller window retains every mention and ordinary supplement', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const s = setup({ config: { debounceMs: 100, delayMaxMs: 100 } });
  try {
    await s.bot.receive(event('1'), self);
    t.mock.timers.tick(55);
    await s.bot.receive(event('2'), self);
    await s.bot.receive(event('3', false), self);
    t.mock.timers.tick(44);
    await flush();
    assert.equal(s.requests.length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(
      s.requests.length,
      1,
      'second caller must not restart the first 100ms window',
    );
    assert.equal(trigger(s), 'direct');
    t.mock.timers.tick(120);
    await flush();
    assert.equal(s.requests.length, 1);
  } finally {
    await s.bot.stop();
  }
});

for (const selected of [false, true]) {
  test(`100 busy ordinary arrivals draw once after active completion (${selected ? 'selected' : 'failed'})`, async () => {
    const active = gate<Completion>();
    let rounds = 0;
    const s = setup({
      config: { randomReplyProbability: 0.5 },
      random: () => (selected ? 0.1 : 0.9),
      complete: async () => (++rounds === 1 ? active.promise : silent()),
    });
    try {
      await s.bot.receive(event('1'), self);
      await until(() => s.requests.length === 1);
      const before = s.draws;
      for (let i = 2; i < 102; i++) {
        await s.bot.receive(event(String(i), false), self);
      }
      assert.equal(s.draws, before);
      assert.equal(s.requests[0]!.signal!.aborted, false);
      active.resolve(silent());
      if (selected) {
        await until(() => s.requests.length === 2);
      } else {
        await until(() => s.draws === before + 1);
      }
      await delay(60);
      assert.equal(
        s.draws,
        before + (selected ? 2 : 1),
        'one probability draw plus selected delay draw',
      );
      assert.equal(s.requests.length, selected ? 2 : 1);
      if (selected) {
        assert.equal(trigger(s, 1), 'random');
      }
      for (let i = 2; i < 102; i++) {
        await s.bot.receive(event(String(i), false), self);
      }
      await delay(30);
      assert.equal(
        s.draws,
        before + (selected ? 2 : 1),
        'consumed batch is never reconsidered',
      );
    } finally {
      active.resolve(silent());
      await s.bot.stop();
    }
  });
}

test('random cooldown consumes a busy ordinary batch without probability redraw', async () => {
  const active = gate<Completion>();
  let rounds = 0;
  const s = setup({
    config: { randomReplyProbability: 1, randomCooldownMs: 60000 },
    complete: async () => (++rounds === 1 ? active.promise : silent()),
  });
  try {
    await s.bot.receive(event('1', false), self);
    await until(() => s.requests.length === 1);
    const before = s.draws;
    for (let i = 2; i < 20; i++) {
      await s.bot.receive(event(String(i), false), self);
    }
    active.resolve(silent());
    await delay(60);
    assert.equal(s.draws, before);
    assert.equal(s.requests.length, 1);
    await s.bot.receive(event('30'), self);
    await until(() => s.requests.length === 2);
    assert.equal(trigger(s, 1), 'direct');
    assert.equal(wakes(s), 2);
  } finally {
    active.resolve(silent());
    await s.bot.stop();
  }
});

test('active model is not interrupted and elapsed pending deadline does not restart after completion', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const active = gate<Completion>();
  let rounds = 0;
  const s = setup({
    config: { debounceMs: 160, delayMaxMs: 160 },
    complete: async () => (++rounds === 1 ? active.promise : silent()),
  });
  try {
    await s.bot.receive(event('1'), self);
    t.mock.timers.tick(160);
    await flush();
    assert.equal(s.requests.length, 1);
    await s.bot.receive(event('2'), self);
    await s.bot.receive(event('3'), self);
    t.mock.timers.tick(190);
    await flush();
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0]!.signal!.aborted, false);
    active.resolve(silent());
    await flush();
    t.mock.timers.tick(1);
    await flush();
    assert.equal(
      s.requests.length,
      2,
      'already elapsed deadline should run immediately, not after 160ms',
    );
    // 2和3合为活动唤醒之后的一次唤醒。
    assert.equal(wakes(s), 2);
    assert.equal(trigger(s, 1), 'direct');
    t.mock.timers.tick(180);
    await flush();
    assert.equal(s.requests.length, 2);
  } finally {
    active.resolve(silent());
    await flush();
    await s.bot.stop();
  }
});

test('new caller during first send does not cancel later single-message calls before finish', async () => {
  const sending = gate<unknown>();
  let sends = 0;
  let rounds = 0;
  const s = setup({
    complete: async () =>
      ++rounds === 1
        ? {
            content: null,
            tool_calls: [
              ...tool('send_message', {
                segments: [{ type: 'text', text: 'first' }],
              }).tool_calls,
              ...tool('send_message', {
                segments: [{ type: 'text', text: 'second' }],
              }).tool_calls.map((c) => ({ ...c, id: 'second' })),
              ...silent().tool_calls,
            ],
          }
        : silent(),
    api: async (action) =>
      action === 'send_group_msg' && ++sends === 1
        ? sending.promise
        : { message_id: '90002' },
  });
  try {
    await s.bot.receive(event('1'), self);
    await until(() => sends === 1);
    await s.bot.receive(event('2'), self);
    await s.bot.receive(event('3'), self);
    assert.equal(s.requests[0]!.signal!.aborted, false);
    sending.resolve({ message_id: '90001' });
    await until(() => s.requests.length === 2);
    assert.equal(sends, 2);
    const text = s.calls
      .filter((c) => c.action === 'send_group_msg')
      .map(
        (c) =>
          (c.params.message as any[]).find((m) => m.type === 'text').data.text,
      );
    assert.deepEqual(text, ['first', 'second']);
    assert.equal(wakes(s), 2);
    assert.equal(trigger(s, 1), 'direct');
    await delay(40);
    assert.equal(s.requests.length, 2);
  } finally {
    sending.resolve({ message_id: '90001' });
    await s.bot.stop();
  }
});

for (const phase of ['model', 'tool'] as const) {
  test(`arrivals during ${phase} are delivered before the next step and consume their pending wake`, async () => {
    const held = gate<void>();
    let rounds = 0;
    let toolStarted = false;
    const s = setup({
      complete: async () => {
        rounds++;
        if (rounds === 1 && phase === 'model') {
          await held.promise;
        }
        if (rounds === 1 && phase === 'tool') {
          return tool('get_group_members', { limit: 20 });
        }
        if (rounds === 1 || (rounds === 2 && phase === 'tool')) {
          return tool('read_message', { message_id: '2' });
        }
        return silent();
      },
      api: async (action) => {
        if (action === 'get_group_member_list') {
          toolStarted = true;
          await held.promise;
          return [];
        }
        return {};
      },
    });
    try {
      await s.bot.receive(event('1'), self);
      await until(() =>
        phase === 'tool' ? toolStarted : s.requests.length === 1,
      );
      await s.bot.receive(event('2'), self);
      held.resolve();
      const finalRound = phase === 'tool' ? 2 : 1;
      await until(() => s.requests.length === finalRound + 1);
      assert.equal(result(s, finalRound).status, 'ok');
      assert.equal(result(s, finalRound).message.messageId, '2');
      assert.equal(wakeId(s, finalRound), wakeId(s));
      const updates = s.requests[1]!.messages.filter(
        (m) =>
          m.role === 'user' && String(m.content).includes('context_update'),
      );
      assert.match(String(updates.at(-1)!.content), /body-2/);
      await delay(40);
      assert.equal(s.requests.length, finalRound + 1);
      assert.equal(wakes(s), 1);
      assert.equal(
        s.calls.some((c) => c.action === 'get_msg'),
        false,
      );
    } finally {
      held.resolve();
      await s.bot.stop();
    }
  });
}

for (const overflow of [false, true]) {
  test(`${overflow ? '64 owner calls plus omitted outsider' : 'mixed-owner batch'} cannot offer or execute disabled moderation`, async () => {
    let rounds = 0;
    const s = setup({
      config: { debounceMs: 80, delayMaxMs: 80 },
      complete: async () =>
        ++rounds === 1
          ? tool('mute_member', { user_id: '98765', seconds: 60 })
          : silent(),
    });
    try {
      for (let i = 1; i <= (overflow ? 64 : 1); i++) {
        await s.bot.receive(event(String(i), true, OWNER_ID), self);
      }
      await s.bot.receive(event('100'), self);
      await until(() => s.requests.length === 2);
      assert.equal(wakes(s), 1);
      for (const request of s.requests) {
        for (const name of [
          'mute_member',
          'recall_message',
          'set_member_card',
        ]) {
          assert.equal(request.tools.includes(name), false);
        }
      }
      assert.equal(result(s, 1).status, 'error');
      assert.deepEqual(
        s.calls,
        [],
        'forged tool must not even propose or notify confirmation',
      );
    } finally {
      await s.bot.stop();
    }
  });
}

test('lookup-capacity skipped quote stays unverified after both active lookups resolve as nonbots', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const first = gate<unknown>();
  const second = gate<unknown>();
  let rounds = 0;
  const s = setup({
    config: { debounceMs: 100, delayMaxMs: 100 },
    complete: async () =>
      ++rounds === 1
        ? tool('mute_member', { user_id: '98765', seconds: 60 })
        : silent(),
    api: async (_action, params) =>
      params?.message_id === '701' ? first.promise : second.promise,
  });
  const pending: Promise<void>[] = [];
  try {
    await s.bot.receive(event('1', true, OWNER_ID), self);
    pending.push(s.bot.receive(event('2', false, '12345', '701'), self));
    pending.push(s.bot.receive(event('3', false, '23456', '702'), self));
    assert.equal(s.calls.length, 2);
    await s.bot.receive(event('4', false, '34567', '703'), self);
    assert.equal(
      s.calls.length,
      2,
      'lookup cap must not start a third request',
    );
    first.resolve({
      message_type: 'group',
      group_id: LISTENER_GROUP,
      message_id: '701',
      sender: { user_id: '45678' },
    });
    second.resolve({
      message_type: 'group',
      group_id: LISTENER_GROUP,
      message_id: '702',
      sender: { user_id: '56789' },
    });
    await Promise.all(pending);
    assert.equal(s.requests.length, 0, 'both lookups finish before sealing');
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(wakes(s), 1);
    assert.equal(trigger(s), 'direct');
    for (const request of s.requests) {
      for (const name of ['mute_member', 'recall_message', 'set_member_card']) {
        assert.equal(request.tools.includes(name), false);
      }
    }
    assert.equal(result(s, 1).status, 'error');
    assert.deepEqual(
      s.calls.map((c) => [c.action, c.params.message_id]),
      [
        ['get_msg', '701'],
        ['get_msg', '702'],
      ],
      'forged mute cannot propose, notify or mutate',
    );
  } finally {
    first.resolve({});
    second.resolve({});
    await Promise.all(pending);
    await flush();
    await s.bot.stop();
  }
});

test('failed quote omitted by 64 pinned owner requests preserves metadata and off-capability denial', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let rounds = 0;
  const s = setup({
    config: { debounceMs: 100, delayMaxMs: 100 },
    complete: async () =>
      ++rounds === 1
        ? tool('mute_member', { user_id: '98765', seconds: 60 })
        : silent(),
    api: async () => {
      throw new Error('lookup unavailable');
    },
  });
  try {
    for (let i = 1; i <= 64; i++) {
      await s.bot.receive(event(String(i), true, OWNER_ID), self);
    }
    await s.bot.receive(event('100', false, '12345', '777'), self);
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(wakes(s), 1);
    for (const request of s.requests) {
      for (const name of ['mute_member', 'recall_message', 'set_member_card']) {
        assert.equal(request.tools.includes(name), false);
      }
    }
    assert.equal(result(s, 1).status, 'error');
    assert.deepEqual(
      s.calls.map((c) => c.action),
      ['get_msg'],
    );
  } finally {
    await flush();
    await s.bot.stop();
  }
});

test('queued caller and its quote reference remain resolvable after raw history eviction', async () => {
  const active = gate<Completion>();
  let rounds = 0;
  const s = setup({
    complete: async () => {
      if (++rounds === 1) {
        return active.promise;
      }
      if (rounds === 2) {
        return tool('read_message', { message_id: '2' });
      }
      if (rounds === 3) {
        return tool('read_message', { message_id: '777' });
      }
      return silent();
    },
    api: async (_action, params) => ({
      message_type: 'group',
      group_id: LISTENER_GROUP,
      message_id: params?.message_id,
      sender: { user_id: '999' },
      time: 1,
      message: [{ type: 'text', data: { text: 'old reference' } }],
    }),
  });
  s.memory.cap = 3;
  try {
    await s.bot.receive(event('1'), self);
    await until(() => s.requests.length === 1);
    await s.bot.receive(event('2', true, '12345', '777'), self);
    for (let i = 3; i < 12; i++) {
      await s.bot.receive(event(String(i), false), self);
    }
    assert.equal(s.memory.find('2'), undefined);
    active.resolve(silent());
    await until(() => s.requests.length === 4);
    assert.equal(trigger(s, 1), 'direct');
    assert.equal(result(s, 2).message.messageId, '2');
    assert.equal(result(s, 3).message.messageId, '777');
    assert.deepEqual(
      s.calls
        .filter((c) => c.action === 'get_msg')
        .map((c) => c.params.message_id),
      ['777'],
    );
  } finally {
    active.resolve(silent());
    await s.bot.stop();
  }
});

test('late quote verification does not requeue an event already delivered at opening', async () => {
  const lookup = gate<unknown>();
  const active = gate<Completion>();
  let rounds = 0;
  const s = setup({
    complete: async () => (++rounds === 1 ? active.promise : silent()),
    api: async () => lookup.promise,
  });
  let pending: Promise<void> | undefined;
  try {
    pending = s.bot.receive(event('1', false, '54321', '777'), self);
    await until(() => s.calls.length === 1);
    await s.bot.receive(event('2'), self);
    await until(() => s.requests.length === 1);
    lookup.resolve({
      message_type: 'group',
      group_id: LISTENER_GROUP,
      message_id: '777',
      sender: { user_id: self },
    });
    await pending;
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0]!.signal!.aborted, false);
    active.resolve(silent());
    assert.match(JSON.stringify(s.requests[0]!.messages), /body-1/);
    await delay(40);
    assert.equal(s.requests.length, 1);
    assert.equal(wakes(s), 1);
  } finally {
    lookup.resolve({});
    active.resolve(silent());
    await pending;
    await s.bot.stop();
  }
});

for (const boundary of ['reset', 'disconnect'] as const) {
  test(`${boundary} drops pending batch and invalidates unresolved quotes`, async () => {
    const lookup = gate<unknown>();
    const s = setup({
      config: { debounceMs: 100, delayMaxMs: 100 },
      api: async (action) =>
        action === 'get_msg' ? lookup.promise : { message_id: '99999' },
    });
    let pending: Promise<void> | undefined;
    try {
      await s.bot.receive(event('1'), self);
      pending = s.bot.receive(event('2', false, '12345', '777'), self);
      await until(() => s.calls.some((c) => c.action === 'get_msg'));
      if (boundary === 'disconnect') {
        s.bot.setConnected(false);
        s.bot.setConnected(true);
      } else {
        const command = event('3', false, OWNER_ID);
        command.message = [{ type: 'text', data: { text: '/reset' } }];
        await s.bot.receive(command, self);
      }
      lookup.resolve({
        message_type: 'group',
        group_id: LISTENER_GROUP,
        message_id: '777',
        sender: { user_id: self },
      });
      await pending;
      await delay(150);
      assert.equal(s.requests.length, 0);
      await s.bot.receive(event('4'), self);
      await until(() => s.requests.length === 1);
      await delay(30);
      assert.equal(s.requests.length, 1);
      assert.equal(trigger(s), 'direct');
    } finally {
      lookup.resolve({});
      await pending;
      await s.bot.stop();
    }
  });
}
