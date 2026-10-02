import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setTimeout as delay,
  setImmediate as flush,
} from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import { GroupRouter } from '../../../src/app/group-router.ts';
import { OWNER_ID } from '../../../src/contracts/identity.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import {
  type ChatMessage,
  type Completion,
  type Model,
} from '../../../src/contracts/model.ts';
import { type JsonObject } from '../../../src/contracts/json.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import { type ToolDefinition } from '../../../src/contracts/tools.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const GROUP = '22',
  SELF = '99999',
  A = '111';
const permissions = toolPermissions({
  ...MEMBER_TOOLS,
  react_message: 'direct',
  get_reaction_users: 'direct',
  mute_member: { mode: 'confirm', maxSeconds: 600 },
  unmute_member: 'confirm',
  recall_message: 'confirm',
  set_member_card: 'confirm',
  manage_attention: { mode: 'direct', maxPlans: 16 },
});
const base: ListenerConfig = {
  ownerId: OWNER_ID,
  groupId: GROUP,
  enabled: true,
  debounceMs: 3,
  delayMaxMs: 3,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
  toolPermissions: permissions,
  observeReactions: true,
  confirmationTtlSeconds: 60,
};
const text = (value: string) => ({ type: 'text', data: { text: value } });

function event(id: string, direct = true, body = `body-${id}`, user = A) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP,
    self_id: SELF,
    user_id: user,
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'fixture' },
    message: [
      ...(direct ? [{ type: 'at', data: { qq: SELF } }] : []),
      text(body),
    ],
  };
}

const notice = (id: string, group = GROUP) => ({
  post_type: 'notice',
  notice_type: 'group_msg_emoji_like',
  group_id: group,
  message_id: id,
  likes: [{ emoji_id: '76', count: 999999 }],
  is_add: true,
});
const call = (
  name: string,
  args: unknown = name === 'finish' ? { mode: 'hard' } : {},
) => ({
  id: `call_${name}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const complete = (...calls: ReturnType<typeof call>[]): Completion => ({
  content: null,
  tool_calls: calls.map((c, i) => ({ ...c, id: `${c.id}_${i}` })),
});
const silent = () => call('finish');
const read = (id: string) => call('read_message', { message_id: id });
const react = (id = '1') =>
  call('react_message', { message_id: id, emoji_id: '76', action: 'add' });
const state = () => call('get_wake_state');
const next = () =>
  call('manage_attention', {
    operation: 'create',
    any_of: [{ type: 'next_message' }],
    expires_in_seconds: 60,
  });

function gate<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class Mem implements Memory {
  rows: TimelineEntry[] = [];
  closed = false;
  rawContexts: string[] = [];
  compactInputs: string[] = [];
  constructor(readonly summarize = false) {}
  append(entry: TimelineEntry) {
    if (this.closed) {
      throw new Error('write after close');
    }
    if (this.find(entry.messageId)) {
      return false;
    }
    this.rows.push(structuredClone(entry));
    return true;
  }

  recent() {
    return this.rows;
  }

  find(id: string) {
    return this.rows.find((e) => e.messageId === id);
  }

  context() {
    const value = JSON.stringify({
      groupId: GROUP,
      untrusted: true,
      summary: { untrusted: true, text: 'original summary body' },
      messages: this.rows,
    });
    this.rawContexts.push(value);
    return value;
  }

  async compact(model: Model, signal?: AbortSignal) {
    const source = this.context();
    this.compactInputs.push(source);
    if (this.summarize) {
      await model.complete(
        [
          { role: 'system', content: 'fixture summary' },
          { role: 'user', content: source },
        ],
        [],
        signal,
      );
    }
  }

  clear() {
    this.rows = [];
  }

  close() {
    this.closed = true;
  }
}

type Request = {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  index: number;
};

function setup(
  options: {
    settings?: Partial<ListenerConfig>;
    summarize?: boolean;
    respond?: (r: Request) => Completion | Promise<Completion>;
    api?: (
      action: string,
      params: JsonObject,
      normal: JsonObject,
    ) => unknown | Promise<unknown>;
  } = {},
) {
  const memory = new Mem(options.summarize),
    requests: Request[] = [],
    summaries: ChatMessage[][] = [],
    calls: Array<{ action: string; params: JsonObject }> = [],
    counts = new Map<string, number>(),
    wire = new Map<string, ReturnType<typeof event>>();
  const cfg = { ...base, ...options.settings };
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      const id = String(params.message_id),
        entry = memory.find(id);
      const normal =
        action === 'get_msg'
          ? {
              message_type: 'group',
              group_id: cfg.groupId,
              message_id: id,
              sender: { user_id: entry?.userId ?? A },
              time: Math.floor(Date.now() / 1000),
              message: wire.get(id)?.message ?? [text(`remote body-${id}`)],
              emoji_likes_list: [
                {
                  emoji_id: '76',
                  emoji_type: '1',
                  likes_cnt: String(counts.get(id) ?? 3),
                },
              ],
            }
          : action === 'send_group_msg'
            ? { message_id: String(90000 + calls.length) }
            : { result: 0 };
      if (options.api) {
        const override = await options.api(action, params, normal);
        if (override !== undefined) {
          return override;
        }
      }
      if (
        !['get_msg', 'set_msg_emoji_like', 'send_group_msg'].includes(action)
      ) {
        throw new Error(`unexpected API ${action}`);
      }
      return normal;
    },
  };
  const model: Model = {
    async complete(messages, definitions = []) {
      if (messages[0]?.content === 'fixture summary') {
        summaries.push(structuredClone(messages));
        return { content: 'fixture summary response', tool_calls: [] };
      }
      const request = {
        messages: structuredClone(messages),
        tools: structuredClone(definitions),
        index: requests.length,
      };
      requests.push(request);
      return options.respond ? options.respond(request) : complete(silent());
    },
  };
  const bot = new Listener(
      api,
      model,
      memory,
      cfg,
      () => 0.5,
      undefined,
      undefined,
      sessionRuntime(cfg.groupId).runtime,
    ),
    router = new GroupRouter([[cfg.groupId!, bot]]);
  router.setConnected(true);
  return {
    bot,
    router,
    memory,
    requests,
    summaries,
    calls,
    counts,
    wire,
    async receive(value: ReturnType<typeof event>) {
      wire.set(value.message_id, value);
      await router.receive(value, SELF);
    },
    async close() {
      await router.stop();
    },
  };
}

const snapshot = (s: ReturnType<typeof setup>, id: string) =>
  (s.bot as any).reactionObservations?.get(id);
const gets = (s: ReturnType<typeof setup>) =>
  s.calls.filter((c) => c.action === 'get_msg');
const results = (r: Request) =>
  r.messages
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(String(m.content)));
const system = (r: Request) =>
  String(r.messages.find((m) => m.role === 'system')?.content);
const idle = (s: ReturnType<typeof setup>) =>
  !(s.bot as any).running && !(s.bot as any).admission;

async function until(predicate: () => boolean) {
  for (let n = 0; n < 400; n++) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  assert.fail('observation condition timed out');
}

const settled = async (s: ReturnType<typeof setup>, count: number) =>
  until(() => s.requests.length >= count && idle(s));

// 会话模式没有唤醒前的自动预取：反应快照只在模型read_message时按需刷新并附在结果上。
test('read_message refreshes reactions on demand without prefetch or memory writes', async () => {
  let callsBeforeModel: number | undefined;
  const s = setup({
    respond: (r) => {
      if (r.index === 0) {
        callsBeforeModel = s.calls.length;
        return complete(state(), read('1'));
      }
      return complete(silent());
    },
  });
  try {
    await s.receive(event('1'));
    await settled(s, 2);
    assert.equal(callsBeforeModel, 0);
    assert.deepEqual(
      gets(s).map((c) => c.params.message_id),
      ['1'],
    );
    const [wake, message] = results(s.requests[1]!);
    assert.equal(Object.hasOwn(wake, 'reaction_state'), false);
    assert.equal(message.message.messageId, '1');
    assert.equal(message.message.reactions.status, 'observed');
    assert.equal(message.message.reactions.items[0].count, 3);
    assert.ok(!Object.hasOwn(message.message.reactions, 'contains_bot'));
    assert.equal(s.memory.rows.length, 1);
    assert.ok(s.memory.rows.every((m) => !Object.hasOwn(m, 'reactions')));
  } finally {
    await s.close();
  }
});

test('quoted reaction targets are read on demand and empty snapshots stay distinct', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0 ? complete(read('50'), read('42')) : complete(silent()),
    api: (action, params, normal) =>
      action === 'get_msg' && String(params.message_id) === '50'
        ? { ...normal, emoji_likes_list: [] }
        : undefined,
  });
  try {
    s.counts.set('42', 4);
    const ask = event('50', true, '能看到我给你点的reaction吗');
    ask.message.push({ type: 'reply', data: { id: '42' } } as any);
    await s.receive(ask);
    await settled(s, 2);
    const [own, quoted] = results(s.requests[1]!);
    assert.equal(own.message.reactions.status, 'empty_snapshot');
    assert.equal(quoted.message.messageId, '42');
    assert.equal(quoted.message.reactions.items[0].count, 4);
    assert.match(system(s.requests[0]!), /bot:true/);
    assert.match(system(s.requests[0]!), /不是用户当前提问那条/);
  } finally {
    await s.close();
  }
});

test('read_message returns cached local and verified remote quote annotations, but not errors or foreign IDs', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(read('1'), read('42'), read('999'))
        : complete(silent()),
  });
  try {
    s.counts.set('42', 9);
    const value = event('1');
    value.message.push({ type: 'reply', data: { id: '42' } } as any);
    await s.receive(value);
    await settled(s, 2);
    const returned = results(s.requests[1]!);
    assert.equal(returned[0].message.messageId, '1');
    assert.equal(returned[0].message.reactions.items[0].count, 3);
    assert.equal(returned[1].message.messageId, '42');
    assert.equal(returned[1].message.reactions.items[0].count, 9);
    assert.equal(returned[1].message.text, undefined);
    assert.deepEqual(returned[1].message.segments, [
      { type: 'text', text: 'remote body-42' },
    ]);
    assert.equal(returned[2].error, 'message_not_in_context');
    assert.ok(!returned[2].reactions);
    assert.deepEqual(
      gets(s).map((c) => c.params.message_id),
      ['1', '42'],
    );
    assert.equal(s.memory.rows.length, 1);
    assert.equal(s.memory.find('42'), undefined);
    assert.ok(!s.memory.context().includes('emoji_id'));
  } finally {
    await s.close();
  }
});

test('specific notices routed to a group only mark known snapshots dirty without RPC, history, attention or wake', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(read('1'), next(), silent())
        : r.index === 1
          ? complete(read('1'))
          : complete(silent()),
  });
  try {
    await s.receive(event('1'));
    await settled(s, 1);
    const apiCount = s.calls.length,
      sequence = (s.bot as any).arrivalSequence,
      plans = (s.bot as any).attention.snapshot(Date.now());
    assert.equal(snapshot(s, '1').status, 'observed');
    await s.router.receive(notice('1', '33'), SELF);
    assert.equal(snapshot(s, '1').status, 'observed');
    await s.router.receive(notice('999'), SELF);
    assert.equal(snapshot(s, '999'), undefined);
    await s.router.receive(notice('1'), SELF);
    await delay(15);
    assert.equal(s.calls.length, apiCount);
    assert.equal(s.requests.length, 1);
    assert.equal(s.memory.rows.length, 1);
    assert.equal((s.bot as any).arrivalSequence, sequence);
    assert.equal((s.bot as any).unread.size, 0);
    assert.deepEqual((s.bot as any).attention.snapshot(Date.now()), plans);
    assert.equal(snapshot(s, '1').status, 'stale');
    assert.equal(snapshot(s, '1').items[0].count, 3);
    s.counts.set('1', 7);
    await s.receive(event('2'));
    await settled(s, 3);
    const reread = results(s.requests[2]!).at(-1);
    assert.equal(reread.message.messageId, '1');
    assert.equal(reread.message.reactions.items[0].count, 7);
    assert.equal(reread.message.reactions.status, 'observed');
    assert.ok(
      !s.requests.some((r) => JSON.stringify(r.messages).includes('999999')),
    );
    assert.equal(s.memory.rows.length, 2);
  } finally {
    await s.close();
  }
});

test('native writes make old counters stale without optimistic increments and a later local read refreshes them', async () => {
  let beforeRead: any;
  const s = setup({
    respond: (r) => {
      if (r.index === 0) {
        return complete(read('1'));
      }
      if (r.index === 1) {
        return complete(react());
      }
      if (r.index === 2) {
        beforeRead = snapshot(s, '1');
        return complete(read('1'));
      }
      return complete(silent());
    },
    api: (action) => {
      if (action === 'set_msg_emoji_like') {
        s.counts.set('1', 7);
      }
    },
  });
  try {
    await s.receive(event('1'));
    await settled(s, 4);
    assert.equal(beforeRead.status, 'stale');
    assert.equal(beforeRead.items[0].count, 3);
    assert.ok(!Object.hasOwn(beforeRead, 'contains_bot'));
    const returned = results(s.requests[3]!).at(-1);
    assert.equal(returned.message.reactions.status, 'observed');
    assert.equal(returned.message.reactions.items[0].count, 7);
    assert.equal(snapshot(s, '1').items[0].count, 7);
    assert.equal(gets(s).length, 3);
    assert.equal(
      s.calls.filter((c) => c.action === 'set_msg_emoji_like').length,
      1,
    );
    assert.ok(s.memory.rows.every((r) => !Object.hasOwn(r, 'reactions')));
  } finally {
    await s.close();
  }
});

test('disabled reactions never fetch and do not decorate reads or wake state', async () => {
  const s = setup({
    settings: {
      toolPermissions: {
        ...permissions,
        react_message: { mode: 'off' },
        get_reaction_users: { mode: 'off' },
      },
      observeReactions: false,
    },
    respond: (r) =>
      r.index === 0 ? complete(state(), read('1')) : complete(silent()),
  });
  try {
    await s.receive(event('1'));
    await settled(s, 2);
    await s.router.receive(notice('1'), SELF);
    await delay(10);
    assert.equal(s.calls.length, 0);
    assert.equal(s.requests.length, 2);
    const [wake, message] = results(s.requests[1]!);
    assert.equal(Object.hasOwn(wake, 'reaction_state'), false);
    assert.equal(message.message.reactions, undefined);
  } finally {
    await s.close();
  }
});

test('observation preserves the original cache without invoking an extra summary model', async () => {
  const s = setup({
    summarize: true,
    respond: (r) => (r.index === 0 ? complete(read('1')) : complete(silent())),
    api: (action) => {
      if (action === 'get_msg') {
        assert.equal(s.summaries.length, 0);
      }
    },
  });
  try {
    await s.receive(event('1'));
    await settled(s, 2);
    assert.equal(s.summaries.length, 0);
    assert.ok(results(s.requests[1]!)[0].message.reactions);
    const summarySource = JSON.parse(s.memory.context());
    assert.deepEqual(summarySource.summary, {
      untrusted: true,
      text: 'original summary body',
    });
    assert.ok(
      summarySource.messages.every((m: any) => !Object.hasOwn(m, 'reactions')),
    );
    assert.deepEqual(s.memory.compactInputs, []);
    assert.ok(s.memory.rawContexts.every((raw) => !raw.includes('emoji_id')));
    assert.equal(s.memory.rows.length, 1);
  } finally {
    await s.close();
  }
});

for (const invalid of ['group', 'sender', 'private'] as const) {
  test(`reaction refresh refuses ${invalid} provenance mismatch`, async () => {
    const s = setup({
      respond: (r) =>
        r.index === 0 ? complete(read('1')) : complete(silent()),
      api: (action, _params, normal) =>
        action === 'get_msg'
          ? {
              ...normal,
              ...(invalid === 'group'
                ? { group_id: '33' }
                : invalid === 'sender'
                  ? { sender: { user_id: '555' } }
                  : { message_type: 'private' }),
            }
          : undefined,
    });
    try {
      await s.receive(event('1'));
      await settled(s, 2);
      assert.equal(snapshot(s, '1'), undefined);
      assert.equal(results(s.requests[1]!)[0].message.reactions, undefined);
      assert.equal(s.calls.length, 1);
    } finally {
      await s.close();
    }
  });
}

test('reset aborts an on-demand refresh and a late response cannot restore cleared observations', async () => {
  const held = gate<unknown>();
  let remote: JsonObject | undefined;
  const s = setup({
    respond: (r) => (r.index === 0 ? complete(read('1')) : complete(silent())),
    api: (action, params, normal) => {
      if (action === 'get_msg' && params.message_id === '1') {
        remote = normal;
        return held.promise;
      }
    },
  });
  try {
    await s.receive(event('1'));
    await until(() => gets(s).length === 1);
    await s.receive(event('9', false, '/reset', OWNER_ID));
    await until(() => idle(s));
    assert.equal(s.requests.length, 1);
    assert.equal(snapshot(s, '1'), undefined);
    held.resolve(remote);
    await flush();
    await flush();
    assert.equal(snapshot(s, '1'), undefined);
    assert.equal(s.requests.length, 1);
    await s.receive(event('2'));
    await settled(s, 2);
    assert.equal(snapshot(s, '1'), undefined);
  } finally {
    held.resolve(remote);
    await s.close();
  }
});

test('refresh time budget releases the model and ignores late RPC results', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
  const held = gate<unknown>();
  let remote: JsonObject | undefined;
  const s = setup({
    respond: (r) => (r.index === 0 ? complete(read('1')) : complete(silent())),
    api: (action, _params, normal) => {
      if (action === 'get_msg') {
        remote = normal;
        return held.promise;
      }
    },
  });
  try {
    await s.receive(event('1'));
    for (let i = 0; i < 20 && !gets(s).length; i++) {
      t.mock.timers.tick(3);
      await flush();
      await flush();
    }
    assert.equal(gets(s).length, 1);
    assert.equal(s.requests.length, 1);
    t.mock.timers.tick(1501);
    for (let i = 0; i < 20 && s.requests.length < 2; i++) {
      await flush();
    }
    assert.equal(s.requests.length, 2);
    assert.equal(results(s.requests[1]!)[0].message.reactions, undefined);
    held.resolve(remote);
    await flush();
    await flush();
    assert.equal(snapshot(s, '1'), undefined);
  } finally {
    held.resolve(remote);
    await flush();
    await s.close();
    t.mock.timers.reset();
  }
});
