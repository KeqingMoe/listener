import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setTimeout as delay,
  setImmediate as flush,
} from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import { TurnScheduler } from '../../../src/agent/scheduler.ts';
import { OWNER_ID } from '../../../src/contracts/identity.ts';
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
import { type ToolDefinition } from '../../../src/contracts/tools.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime, wakeMeta } from '../../support/listener-fixture.ts';

const GROUP = '22',
  SELF = '99999',
  A = '111',
  B = '222';
const base: ListenerConfig = {
  ownerId: OWNER_ID,
  groupId: GROUP,
  enabled: true,
  debounceMs: 3,
  delayMaxMs: 3,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
  randomCooldownMs: 0,
  randomMaxPerMinute: 10,
  toolPermissions: toolPermissions({
    ...MEMBER_TOOLS,
    manage_attention: { mode: 'direct', maxPlans: 16 },
  }),
};

function gate<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('cancelled', 'AbortError'));
    if (signal?.aborted) {
      return abort();
    }
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(
      (v) => {
        signal?.removeEventListener('abort', abort);
        resolve(v);
      },
      (e) => {
        signal?.removeEventListener('abort', abort);
        reject(e);
      },
    );
  });
}

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
const send = (text = 'fixture reply') =>
  call('send_message', { segments: [{ type: 'text', text }] });
const plan = (any_of: unknown[], purpose?: string) =>
  call('manage_attention', {
    operation: 'create',
    any_of,
    expires_in_seconds: 60,
    ...(purpose ? { purpose } : {}),
  });
const member = (user: string, purpose?: string) =>
  plan([{ type: 'member_message', user_ids: [user] }], purpose);
const next = () => plan([{ type: 'next_message' }]);

function event(
  id: string,
  user = A,
  direct = false,
  text = `body-${id}`,
  group = GROUP,
) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    self_id: SELF,
    user_id: user,
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'fixture' },
    message: [
      ...(direct ? [{ type: 'at', data: { qq: SELF } }] : []),
      { type: 'text', data: { text } },
    ],
  };
}

class Mem implements Memory {
  rows: TimelineEntry[] = [];
  closed = false;
  append(e: TimelineEntry) {
    if (this.closed) {
      throw new Error('write after close');
    }
    if (this.find(e.messageId)) {
      return false;
    }
    this.rows.push(structuredClone(e));
    return true;
  }

  recent() {
    return this.rows;
  }

  find(id: string) {
    return this.rows.find((e) => e.messageId === id);
  }

  context() {
    return JSON.stringify({ messages: this.rows });
  }

  async compact() {}
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
  signal?: AbortSignal;
  index: number;
};

function setup(
  options: {
    settings?: Partial<ListenerConfig>;
    respond?: (r: Request) => Completion | Promise<Completion>;
    api?: Api['call'];
    scheduler?: TurnScheduler;
    random?: () => number;
  } = {},
) {
  const memory = new Mem(),
    requests: Request[] = [],
    calls: { action: string; params: Record<string, unknown> }[] = [];
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      if (options.api) {
        return options.api(action, params);
      }
      if (action === 'send_group_msg') {
        return { message_id: String(90000 + calls.length) };
      }
      throw new Error('unexpected API');
    },
  };
  const runtime = sessionRuntime({ ...base, ...options.settings }.groupId);
  const model: Model = {
    async complete(messages, tools = [], signal) {
      const index = requests.length;
      const r: Request = {
        messages: structuredClone(messages),
        tools: structuredClone(tools),
        signal,
        index,
      };
      requests.push(r);
      return options.respond ? options.respond(r) : complete(silent());
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    { ...base, ...options.settings },
    options.random ?? (() => 0.5),
    undefined,
    options.scheduler,
    runtime.runtime,
  );
  return {
    bot,
    memory,
    requests,
    calls,
    async receive(e: ReturnType<typeof event>) {
      await bot.receive(e, SELF);
    },
    async close() {
      await bot.stop();
    },
  };
}

const triggerKind = (r: Request) =>
  (wakeMeta(r.messages).trigger as { type: string }).type;
/** 本次唤醒元数据中的trigger（plan_hits/omitted_plan_hits）。 */
const state = (r: Request): any => wakeMeta(r.messages).trigger;
const plans = (s: ReturnType<typeof setup>): any[] =>
  (s.bot as any).attention?.snapshot(Date.now()) ?? [];
const idle = (s: ReturnType<typeof setup>) =>
  !(s.bot as any).running && !(s.bot as any).admission;

async function until(check: () => boolean) {
  for (let n = 0; n < 300; n++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('attention condition timed out');
}

const settled = async (s: ReturnType<typeof setup>, count: number) =>
  until(() => s.requests.length >= count && idle(s));

test('two plans after a send coexist, member A consumes only its plan and member B remains awaited', async () => {
  const s = setup({
    settings: {
      toolPermissions: toolPermissions({
        ...MEMBER_TOOLS,
        manage_attention: { mode: 'direct', maxPlans: 16 },
        mute_member: { mode: 'confirm', maxSeconds: 600 },
        unmute_member: 'confirm',
        recall_message: 'confirm',
        set_member_card: 'confirm',
      }),
      confirmationTtlSeconds: 60,
    },
    respond: (r) =>
      r.index === 0
        ? complete(send(), member(A, 'wait A'), member(B, 'wait B'), silent())
        : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 1);
    assert.equal(plans(s).length, 2);
    assert.equal(s.calls.length, 1);
    await s.receive(event('2', A));
    await settled(s, 2);
    assert.equal(triggerKind(s.requests[1]!), 'attention');
    assert.equal(state(s.requests[1]!).plan_hits.length, 1);
    assert.equal(state(s.requests[1]!).plan_hits[0].purpose, 'wait A');
    assert.deepEqual(
      plans(s).map((p) => p.purpose),
      ['wait B'],
    );
    assert.ok(
      s.requests[1]!.tools.some((t) => t.function.name === 'mute_member'),
    );
    await s.receive(event('3', B));
    await settled(s, 3);
    assert.equal(state(s.requests[2]!).plan_hits[0].purpose, 'wait B');
    assert.deepEqual(plans(s), []);
  } finally {
    await s.close();
  }
});

test('unrelated at preserves old plans and deadlines; explicit update replaces only its ID', async () => {
  let update = '';
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(
            member(A, 'A'),
            plan([{ type: 'after', delay_seconds: [30, 30] }], 'timer'),
            silent(),
          )
        : r.index === 2
          ? complete(
              call('manage_attention', {
                operation: 'update',
                plan_id: update,
                any_of: [{ type: 'member_message', user_ids: [B] }],
                expires_in_seconds: 60,
                purpose: 'B',
              }),
              silent(),
            )
          : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 1);
    const initial = plans(s);
    update = initial.find((p) => p.purpose === 'A').plan_id;
    const due = initial.find((p) => p.purpose === 'timer').any_of[0].due_at;
    await s.receive(event('2', OWNER_ID, true));
    await settled(s, 2);
    assert.equal(
      plans(s).find((p) => p.purpose === 'timer').any_of[0].due_at,
      due,
    );
    assert.equal(plans(s).length, 2);
    await s.receive(event('3', OWNER_ID, true));
    await settled(s, 3);
    assert.equal(plans(s).find((p) => p.purpose === 'B').plan_id, update);
    assert.equal(
      plans(s).find((p) => p.purpose === 'timer').any_of[0].due_at,
      due,
    );
    await s.receive(event('4', A));
    await delay(15);
    assert.equal(s.requests.length, 3);
    await s.receive(event('5', B));
    await settled(s, 4);
    assert.equal(state(s.requests[3]!).plan_hits[0].plan_id, update);
  } finally {
    await s.close();
  }
});

test('one message matching several independent plans causes one attention batch', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(next(), member(A), silent())
        : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 1);
    await s.receive(event('2', A));
    await settled(s, 2);
    assert.equal(state(s.requests[1]!).plan_hits.length, 2);
    assert.deepEqual(plans(s), []);
    await delay(15);
    assert.equal(s.requests.length, 2);
  } finally {
    await s.close();
  }
});

test('activity requires both message and sender thresholds, and retained unread messages form its batch', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(
            plan([
              {
                type: 'activity',
                window_seconds: 10,
                min_messages: 3,
                min_senders: 2,
              },
            ]),
            silent(),
          )
        : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 1);
    for (const id of ['2', '3', '4']) {
      await s.receive(event(id, A));
    }
    await delay(15);
    assert.equal(s.requests.length, 1);
    await s.receive(event('5', B));
    await settled(s, 2);
    assert.equal(state(s.requests[1]!).plan_hits[0].reason, 'activity');
  } finally {
    await s.close();
  }
});

test('timer latches without unread messages, does not spin, and later inspects new messages once', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(plan([{ type: 'after', delay_seconds: [1, 1] }]), silent())
        : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    t.mock.timers.tick(3);
    await flush();
    assert.equal(plans(s).length, 1);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(s.requests.length, 1);
    assert.equal(plans(s).length, 1);
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(s.requests.length, 1);
    await s.receive(event('2', A));
    t.mock.timers.tick(1);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(state(s.requests[1]!).plan_hits[0].reason, 'after');
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(s.requests.length, 2);
  } finally {
    await flush();
    await s.close();
    t.mock.timers.reset();
  }
});

test('next-message baseline starts after completed sending and ignores bot, foreign, private and duplicate events', async () => {
  const held = gate<unknown>();
  const s = setup({
    respond: (r) =>
      r.index === 0 ? complete(next(), send(), silent()) : complete(silent()),
    api: async () => held.promise,
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await until(() => s.calls.length === 1);
    await s.receive(event('2', A));
    assert.deepEqual(plans(s), []);
    held.resolve({ message_id: '90000' });
    await settled(s, 1);
    await delay(15);
    assert.equal(s.requests.length, 1);
    assert.equal(plans(s).length, 1);
    await s.receive(event('3', SELF));
    await s.receive(event('4', A, false, 'foreign', '33'));
    await s.bot.receive({ ...event('5'), message_type: 'private' }, SELF);
    await s.receive(event('2', A));
    await delay(15);
    assert.equal(s.requests.length, 1);
    await s.receive(event('6', B));
    await settled(s, 2);
    assert.equal(state(s.requests[1]!).plan_hits[0].reason, 'next_message');
  } finally {
    held.resolve({ message_id: '90000' });
    await s.close();
  }
});

test('plan-only round commits after later silence; prose-only end discards staging', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(next())
        : r.index === 1
          ? complete(silent())
          : r.index === 2
            ? complete(member(B))
            : r.index === 3
              ? { content: 'not a terminal tool', tool_calls: [] }
              : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 2);
    assert.equal(plans(s).length, 1);
    const result = s.requests[1]!.messages.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call_manage_attention_0',
    );
    assert.equal(JSON.parse(String(result?.content)).status, 'staged');
    await s.receive(event('2', A));
    await settled(s, 4);
    assert.deepEqual(plans(s), []);
    await s.receive(event('3', B));
    await delay(15);
    assert.equal(s.requests.length, 4);
  } finally {
    await s.close();
  }
});

for (const failure of ['model', 'send', 'reset', 'timeout'] as const) {
  test(`staged plans are discarded on ${failure} failure or cancellation`, async () => {
    const hold = gate<Completion>();
    const s = setup({
      settings: {
        wakeTimeoutMs: failure === 'timeout' ? 1000 : 90000,
      },
      respond: (r) =>
        r.index === 0
          ? complete(next(), ...(failure === 'send' ? [send()] : []))
          : failure === 'model'
            ? Promise.reject(Error('mock failure'))
            : failure === 'send'
              ? Promise.reject(Error('send failure follow-up'))
              : abortable(hold.promise, r.signal),
      api:
        failure === 'send'
          ? async () => {
              throw new Error('mock send failure');
            }
          : undefined,
    });
    try {
      await s.receive(event('1', OWNER_ID, true));
      await until(() => s.requests.length >= (failure === 'send' ? 1 : 2));
      if (failure === 'reset') {
        await s.receive(event('90', OWNER_ID, false, '/reset'));
      }
      await until(() => idle(s));
      assert.deepEqual(plans(s), []);
      assert.equal((s.bot as any).unread.size, 0);
    } finally {
      hold.resolve(complete(silent()));
      await s.close();
    }
  });
}

test('finish stops trailing attention, extra send, reads and moderation after an earlier send', async () => {
  const s = setup({
    settings: {
      toolPermissions: toolPermissions({
        ...MEMBER_TOOLS,
        manage_attention: { mode: 'direct', maxPlans: 16 },
        mute_member: { mode: 'confirm', maxSeconds: 600 },
        unmute_member: 'off',
        recall_message: 'off',
        set_member_card: 'off',
      }),
      confirmationTtlSeconds: 60,
    },
    respond: () =>
      complete(
        send('first'),
        silent(),
        send('extra'),
        call('get_group_members'),
        call('mute_member', { user_id: A, seconds: 10 }),
        member(B),
      ),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 1);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0]!.action, 'send_group_msg');
    assert.equal(plans(s).length, 0);
    assert.equal(s.requests.length, 1);
  } finally {
    await s.close();
  }
});

for (const terminal of ['send', 'silent'] as const) {
  test(`invalid attention after finish ${terminal} is ignored rather than staged`, async () => {
    const invalid = () =>
      call('manage_attention', {
        operation: 'create',
        any_of: [{ type: 'after', delay_seconds: [5, 5] }],
        expires_in_seconds: 5,
      });
    const s = setup({
      respond: (r) =>
        r.index === 0
          ? complete(
              ...(terminal === 'send' ? [send()] : []),
              silent(),
              invalid(),
            )
          : complete(silent()),
    });
    try {
      await s.receive(event('1', OWNER_ID, true));
      await settled(s, 1);
      assert.deepEqual(plans(s), []);
      assert.equal(s.calls.length, terminal === 'send' ? 1 : 0);
      await delay(15);
      assert.equal(s.requests.length, 1);
      await s.receive(event('2', OWNER_ID, true));
      await settled(s, 2);
      assert.deepEqual(plans(s), []);
    } finally {
      await s.close();
    }
  });
}

test('valid trailing attention commits independently of a later invalid operation', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(
            send(),
            member(B, 'valid wait'),
            call('manage_attention', {
              operation: 'create',
              any_of: [{ type: 'after', delay_seconds: [5, 5] }],
              expires_in_seconds: 5,
            }),
            silent(),
          )
        : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 1);
    assert.equal(s.calls.length, 1);
    assert.equal(plans(s).length, 1);
    const id = plans(s)[0]!.plan_id;
    await delay(15);
    assert.equal(s.requests.length, 1);
    await s.receive(event('2', OWNER_ID, true));
    await settled(s, 2);
    // 有效计划独立提交，后续无效操作只在其工具结果中被拒绝。
    const rejected = s.bot['runtime'].session
      .messages()
      .find(
        (m: ChatMessage) =>
          m.role === 'tool' && m.tool_call_id === 'call_manage_attention_2',
      );
    assert.equal(
      JSON.parse(String(rejected?.content)).error,
      'invalid_arguments',
    );
    assert.equal(plans(s)[0]!.plan_id, id);
    await s.receive(event('3', B));
    await settled(s, 3);
    assert.equal(state(s.requests[2]!).plan_hits[0].plan_id, id);
    assert.deepEqual(plans(s), []);
  } finally {
    await s.close();
  }
});

test('matched old plan during an active update cannot be resurrected; attention joins one pending batch', async () => {
  const hold = gate<Completion>();
  let id = '';
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(member(A), silent())
        : r.index === 1
          ? complete(
              call('manage_attention', {
                operation: 'update',
                plan_id: id,
                any_of: [{ type: 'member_message', user_ids: [B] }],
                expires_in_seconds: 60,
              }),
            )
          : r.index === 2
            ? abortable(hold.promise, r.signal)
            : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 1);
    id = plans(s)[0]!.plan_id;
    await s.receive(event('2', OWNER_ID, true));
    await until(() => s.requests.length === 3);
    await s.receive(event('3', A));
    await s.receive(event('4', B));
    assert.equal(s.requests.length, 3);
    assert.deepEqual(plans(s), []);
    hold.resolve(complete(silent()));
    await settled(s, 4);
    assert.equal(state(s.requests[3]!).plan_hits[0].plan_id, id);
    assert.deepEqual(plans(s), []);
    assert.ok(!JSON.stringify(s.requests[1]!.messages).includes('body-3'));
  } finally {
    hold.resolve(complete(silent()));
    await s.close();
  }
});

test('random participation remains independent, while disconnect and reset clear outstanding plans', async () => {
  const s = setup({
    settings: {
      randomReplyProbability: 1,
      toolPermissions: toolPermissions({
        ...MEMBER_TOOLS,
        manage_attention: { mode: 'direct', maxPlans: 16 },
        mute_member: { mode: 'confirm', maxSeconds: 600 },
        unmute_member: 'off',
        recall_message: 'direct',
        set_member_card: 'off',
      }),
      confirmationTtlSeconds: 60,
    },
    respond: (r) =>
      r.index === 0 ? complete(member(B), silent()) : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 1);
    const id = plans(s)[0]!.plan_id;
    await s.receive(event('2', A));
    await settled(s, 2);
    assert.equal(triggerKind(s.requests[1]!), 'random');
    assert.equal(plans(s)[0]!.plan_id, id);
    assert.ok(
      s.requests[1]!.tools.some((t) => t.function.name === 'mute_member'),
    );
    assert.ok(
      s.requests[1]!.tools.some((t) => t.function.name === 'recall_message'),
    );
    assert.ok(
      !s.requests[1]!.tools.some((t) => t.function.name === 'unmute_member'),
    );
    s.bot.setConnected(false);
    assert.deepEqual(plans(s), []);
    assert.equal((s.bot as any).unread.size, 0);
    s.bot.setConnected(true);
    await s.receive(event('3', OWNER_ID, false, '/reset'));
    assert.deepEqual(plans(s), []);
  } finally {
    await s.close();
  }
});

for (const action of ['reset', 'disconnect', 'stop'] as const) {
  test(`${action} clears committed plans and retained unread messages`, async () => {
    const s = setup({ respond: () => complete(member(B), silent()) });
    try {
      await s.receive(event('1', OWNER_ID, true));
      await settled(s, 1);
      await s.receive(event('2', A));
      assert.equal(plans(s).length, 1);
      assert.equal((s.bot as any).unread.size, 1);
      if (action === 'reset') {
        await s.receive(event('90', OWNER_ID, false, '/reset'));
      } else if (action === 'disconnect') {
        s.bot.setConnected(false);
      } else {
        await s.bot.stop();
      }
      assert.deepEqual(plans(s), []);
      assert.equal((s.bot as any).unread.size, 0);
      assert.equal((s.bot as any).attentionTimer, undefined);
      if (action === 'disconnect') {
        s.bot.setConnected(true);
      }
      await s.receive(event('3', B));
      await delay(15);
      assert.equal(s.requests.length, 1);
    } finally {
      await s.close();
    }
  });
}

test('unread retention and batch caps report omissions instead of creating unbounded attention work', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(
            plan([{ type: 'activity', window_seconds: 60, min_messages: 200 }]),
            silent(),
          )
        : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 1);
    for (let i = 2; i <= 201; i++) {
      await s.receive(event(String(i), A));
    }
    await settled(s, 2);
    assert.equal((s.bot as any).unread.size, 0);
    assert.equal(s.requests.length, 2);
  } finally {
    await s.close();
  }
});

test('attention wake reports world unread and window omissions, not attention buffer eviction', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(
            plan([{ type: 'activity', window_seconds: 60, min_messages: 200 }]),
            silent(),
          )
        : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID, true));
    await settled(s, 1);
    for (let i = 2; i <= 201; i++) {
      await s.receive(event(String(i), A));
    }
    await settled(s, 2);
    const update = s.requests[1]!.messages.filter(
      (m) => m.role === 'user' && typeof m.content === 'string',
    )
      .map((m) => JSON.parse(m.content as string).context_update)
      .filter(Boolean)
      .at(-1);
    assert.equal(update.unread_count, 200);
    assert.ok(update.items.length > 0 && update.items.length <= 20);
    assert.equal(update.omitted_count, 200 - update.items.length);
    assert.equal(state(s.requests[1]!).unread_omitted, undefined);
  } finally {
    await s.close();
  }
});

test('two groups reject foreign plan IDs and obey the shared admission scheduler', async () => {
  const scheduler = new TurnScheduler(1),
    hold = gate<Completion>();
  let foreign = '';
  const a = setup({
    scheduler,
    respond: (r) =>
      r.index === 0
        ? complete(member(A), silent())
        : abortable(hold.promise, r.signal),
  });
  const b = setup({
    scheduler,
    settings: { groupId: '33' },
    respond: (r) =>
      r.index === 0
        ? complete(member(B), silent())
        : r.index === 1
          ? complete(
              call('manage_attention', {
                operation: 'cancel',
                plan_id: foreign,
              }),
            )
          : complete(silent()),
  });
  try {
    await a.receive(event('1', OWNER_ID, true));
    await settled(a, 1);
    foreign = plans(a)[0]!.plan_id;
    await b.receive(event('1', OWNER_ID, true, 'setup', '33'));
    await settled(b, 1);
    await b.receive(event('2', OWNER_ID, true, 'try foreign', '33'));
    await settled(b, 3);
    assert.equal(plans(a)[0]!.plan_id, foreign);
    assert.equal(plans(b).length, 1);
    const result = b.requests[2]!.messages.filter((m) => m.role === 'tool')
      .map((m) => JSON.parse(String(m.content)))
      .find((r) => r.error);
    assert.equal(result.error, 'plan_not_found');
    await a.receive(event('3', OWNER_ID, true));
    await until(() => a.requests.length === 2);
    await b.receive(event('3', B, false, 'answer', '33'));
    await until(() => scheduler.waitingCount === 1);
    assert.equal(b.requests.length, 3);
    hold.resolve(complete(silent()));
    await settled(b, 4);
    assert.equal(state(b.requests[3]!).plan_hits.length, 1);
    assert.equal(state(b.requests[3]!).plan_hits[0].reason, 'member_message');
    assert.equal(plans(a)[0]!.plan_id, foreign);
  } finally {
    hold.resolve(complete(silent()));
    await a.close();
    await b.close();
    scheduler.close();
  }
});
