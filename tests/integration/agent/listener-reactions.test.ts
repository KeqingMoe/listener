import test from 'node:test';
import { SideEffectPacer } from '../../../src/agent/pacing.ts';
import assert from 'node:assert/strict';
import {
  setTimeout as delay,
  setImmediate as flush,
} from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
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
  randomCooldownMs: 0,
  randomMaxPerMinute: 10,
  toolPermissions: permissions,
  observeReactions: true,
  confirmationTtlSeconds: 60,
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
const react = (id = '1', emoji = '76', action: 'add' | 'remove' = 'add') =>
  call('react_message', { message_id: id, emoji_id: emoji, action });
const next = () =>
  call('manage_attention', {
    operation: 'create',
    any_of: [{ type: 'next_message' }],
    expires_in_seconds: 60,
  });
const text = (value: string) => ({ type: 'text', data: { text: value } });

function event(
  id: string,
  user = A,
  direct = true,
  body = `body-${id}`,
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
      text(body),
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

type Wire = ReturnType<typeof event>;

function setup(
  options: {
    settings?: Partial<ListenerConfig>;
    respond?: (r: Request) => Completion | Promise<Completion>;
    api?: (
      action: string,
      params: Record<string, unknown>,
    ) => unknown | Promise<unknown>;
  } = {},
) {
  const memory = new Mem(),
    requests: Request[] = [],
    calls: { action: string; params: Record<string, unknown> }[] = [],
    wire = new Map<string, Wire>();
  const cfg = { ...base, ...options.settings };
  const runtime = sessionRuntime(cfg.groupId);
  // 会话模式下工具按world核验消息；预置消息同时写入world和本地记忆。
  const seed = (entry: TimelineEntry) => {
    memory.append(entry);
    runtime.world.appendMessage(entry, { source: 'onebot' });
  };
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      if (options.api) {
        const result = await options.api(action, params);
        if (result !== undefined) {
          return result;
        }
      }
      if (action === 'get_msg') {
        const id = String(params.message_id),
          entry = memory.find(id),
          original = wire.get(id);
        return {
          message_type: 'group',
          group_id: cfg.groupId,
          message_id: id,
          sender: { user_id: entry?.userId ?? A },
          time: Math.floor(Date.now() / 1000),
          message: original?.message ?? [
            text(entry?.text ?? 'verified fixture'),
          ],
        };
      }
      if (action === 'set_msg_emoji_like') {
        return { result: 0 };
      }
      if (action === 'send_group_msg') {
        return { message_id: String(90000 + calls.length) };
      }
      if (action === 'get_forward_msg') {
        return {
          messages: [
            {
              message_id: '12345678901234567890',
              sender: { user_id: A, nickname: 'quoted' },
              time: 42,
              message: [text('forward fixture')],
            },
          ],
        };
      }
      throw new Error(`unexpected API ${action}`);
    },
  };
  const model: Model = {
    async complete(messages, definitions = [], signal) {
      const r = {
        messages: structuredClone(messages),
        tools: structuredClone(definitions),
        signal,
        index: requests.length,
      };
      requests.push(r);
      return options.respond ? options.respond(r) : complete(silent());
    },
  };
  let virtual = 0;
  const bot = new Listener(
    api,
    model,
    memory,
    cfg,
    () => 0.5,
    async () => ({
      dataUrl: 'data:image/png;base64,YQ==',
      width: 1,
      height: 1,
      firstFrameOnly: false,
    }),
    undefined,
    {
      ...runtime.runtime,
      pacer: new SideEffectPacer({
        now: () => virtual,
        sleep: async (ms) => {
          virtual += ms;
        },
      }),
    },
  );
  return {
    bot,
    memory,
    runtime,
    seed,
    requests,
    calls,
    wire,
    async receive(e: Wire) {
      wire.set(e.message_id, e);
      await bot.receive(e, SELF);
    },
    async close() {
      await bot.stop();
    },
  };
}

/** 会话记录中全部react_message的工具结果，按调用顺序。 */
const reactionResults = (s: ReturnType<typeof setup>): any[] => {
  const ids = new Set(
    s.runtime.session
      .messages()
      .flatMap((m) => m.tool_calls ?? [])
      .filter((c) => c.function.name === 'react_message')
      .map((c) => c.id),
  );
  return s.runtime.session
    .messages()
    .filter((m) => m.role === 'tool' && ids.has(m.tool_call_id!))
    .map((m) => JSON.parse(String(m.content)));
};
const trigger = (r: Request) =>
  (wakeMeta(r.messages).trigger as { type?: unknown }).type;
const plans = (s: ReturnType<typeof setup>): any[] =>
  (s.bot as any).attention?.snapshot(Date.now()) ?? [];
const idle = (s: ReturnType<typeof setup>) =>
  !(s.bot as any).running && !(s.bot as any).admission;
const mutations = (s: ReturnType<typeof setup>) =>
  s.calls.filter((c) => c.action === 'set_msg_emoji_like');
const sends = (s: ReturnType<typeof setup>) =>
  s.calls.filter((c) => c.action === 'send_group_msg');

async function until(check: () => boolean) {
  for (let n = 0; n < 400; n++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('reaction condition timed out');
}

const settled = async (s: ReturnType<typeof setup>, count: number) =>
  until(() => s.requests.length >= count && idle(s));

/** 投递一条消息并等待由它触发的唤醒结束。 */
async function wakeWith(s: ReturnType<typeof setup>, e: Wire) {
  const before = s.requests.length;
  await s.receive(e);
  await until(() => s.requests.length > before && idle(s));
}

const results = (r: Request) =>
  r.messages
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(String(m.content)));

test('one batch may react to several people and several emoji without creating fake chat entries', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(
            call('read_events', {
              limit: 10,
              types: ['message.created'],
              direction: 'forward',
            }),
          )
        : r.index === 1
          ? complete(react('1'), react('2', '128077'), silent())
          : complete(silent()),
  });
  try {
    await s.receive(event('1', A));
    await s.receive(event('2', B));
    await settled(s, 2);
    assert.equal(s.requests.length, 2);
    // 一次唤醒处理同一批两条消息：模型通过read_events看到两位群友。
    assert.deepEqual(
      results(s.requests[1]!)
        .at(-1)
        .events.map(
          (e: { payload: { message: { messageId: string } } }) =>
            e.payload.message.messageId,
        ),
      ['1', '2'],
    );
    assert.deepEqual(
      mutations(s).map((c) => c.params),
      [
        { message_id: '1', emoji_id: '76', set: true },
        { message_id: '2', emoji_id: '128077', set: true },
      ],
    );
    assert.equal(s.memory.rows.length, 2);
    assert.ok(s.memory.rows.every((e) => !e.bot));
    assert.ok(!s.memory.context().includes('emoji_id'));
    assert.equal(reactionResults(s).length, 2);
    assert.ok(
      reactionResults(s).every(
        (r: any) =>
          r.status === 'ok' &&
          r.submitted === true &&
          r.effect_confirmed === false,
      ),
    );
  } finally {
    await s.close();
  }
});

for (const order of ['before', 'after'] as const) {
  test(`reaction ${order} send executes before finish and a send after finish is blocked`, async () => {
    const response =
      order === 'before'
        ? complete(
            react(),
            send(),
            react('1', '128077'),
            silent(),
            send('must not send'),
          )
        : complete(
            send(),
            react(),
            react('1', '128077'),
            silent(),
            send('must not send'),
          );
    const s = setup({
      respond: (r) => (r.index === 0 ? response : complete(silent())),
    });
    try {
      await s.receive(event('1'));
      await settled(s, 1);
      assert.equal(mutations(s).length, 2);
      assert.equal(sends(s).length, 1);
      assert.equal(s.requests.length, 1);
      const actions = s.calls.map((c) => c.action);
      assert.ok(
        order === 'before'
          ? actions.indexOf('set_msg_emoji_like') <
              actions.indexOf('send_group_msg')
          : actions.indexOf('send_group_msg') <
              actions.indexOf('set_msg_emoji_like'),
      );
    } finally {
      await s.close();
    }
  });
}

test('finish after reactions and attention commits the plan on normal completion', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0 ? complete(react(), next(), silent()) : complete(silent()),
  });
  try {
    await s.receive(event('1'));
    await settled(s, 1);
    assert.equal(mutations(s).length, 1);
    assert.equal(sends(s).length, 0);
    assert.equal(plans(s).length, 1);
    await wakeWith(s, event('2', B, false));
    assert.equal(trigger(s.requests[1]!), 'attention');
    assert.deepEqual(plans(s), []);
  } finally {
    await s.close();
  }
});

test('reaction-only intermediate round continues to a normal terminal tool', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0 ? complete(react(), next()) : complete(silent()),
  });
  try {
    await s.receive(event('1'));
    await settled(s, 2);
    assert.equal(mutations(s).length, 1);
    assert.equal(plans(s).length, 1);
    assert.equal(results(s.requests[1]!)[0].status, 'ok');
  } finally {
    await s.close();
  }
});

for (const unknown of [false, true]) {
  test(`identical reaction calls are deduplicated even when native result is ${unknown ? 'unknown' : 'submitted'}`, async () => {
    const s = setup({
      respond: (r) =>
        r.index === 0
          ? complete(
              react(),
              react(),
              ...(unknown ? [react('1', '76', 'remove')] : []),
            )
          : complete(silent()),
      api: (action) => {
        if (unknown && action === 'set_msg_emoji_like') {
          throw new Error('transport uncertain');
        }
      },
    });
    try {
      await s.receive(event('1'));
      await settled(s, 2);
      assert.equal(mutations(s).length, 1);
      // 会话模式不再在唤醒开始时刷新反应观察，只剩修改前的一次核验。
      assert.equal(s.calls.filter((c) => c.action === 'get_msg').length, 1);
      const returned = results(s.requests[1]!);
      assert.equal(returned[0].status, unknown ? 'unknown' : 'ok');
      assert.equal(returned[1].duplicate, true);
      if (unknown) {
        assert.equal(returned[2].duplicate, true);
        assert.equal(returned[2].requested_action, 'remove');
      }
    } finally {
      await s.close();
    }
  });
}

test('add remove add are three intentional operations on one pair', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(react(), react('1', '76', 'remove'), react(), silent())
        : complete(silent()),
  });
  try {
    await s.receive(event('1'));
    await settled(s, 1);
    assert.deepEqual(
      mutations(s).map((c) => c.params.set),
      [true, false, true],
    );
    assert.deepEqual(
      reactionResults(s).map((r) => [r.action, r.status, r.duplicate]),
      [
        ['add', 'ok', undefined],
        ['remove', 'ok', undefined],
        ['add', 'ok', undefined],
      ],
    );
  } finally {
    await s.close();
  }
});

test('messages arriving during the active model call are verified against the live world', async () => {
  const held = gate<Completion>();
  const s = setup({
    respond: (r) => (r.index === 0 ? held.promise : complete(silent())),
  });
  try {
    await s.receive(event('1'));
    await until(() => s.requests.length === 1);
    await s.receive(event('2', B, false));
    // 会话模式的工具按调用时刻的本群world核验，新到达的消息同样可以反应。
    held.resolve(complete(react('2'), react('1'), silent()));
    await settled(s, 1);
    assert.deepEqual(
      mutations(s).map((c) => c.params.message_id),
      ['2', '1'],
    );
  } finally {
    held.resolve(complete(silent()));
    await s.close();
  }
});

test('pure attention wake may react and retains explicitly configured confirmation capabilities', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(next(), silent())
        : r.index === 1
          ? complete(react('2'), silent())
          : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID));
    await settled(s, 1);
    await s.receive(event('2', OWNER_ID, false));
    await settled(s, 2);
    assert.equal(trigger(s.requests[1]!), 'attention');
    assert.ok(
      s.requests[1]!.tools.some((t) => t.function.name === 'react_message'),
    );
    assert.ok(
      s.requests[1]!.tools.some((t) => t.function.name === 'mute_member'),
    );
    assert.equal(mutations(s).length, 1);
    assert.ok(
      !s.calls.some((c) =>
        ['set_group_ban', 'set_group_card', 'delete_msg'].includes(c.action),
      ),
    );
  } finally {
    await s.close();
  }
});

for (const ending of ['model', 'prose', 'timeout'] as const) {
  test(`dispatched reaction stays executed but attention is not committed after ${ending} termination`, async (t) => {
    if (ending === 'timeout') {
      t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
    }
    const held = gate<Completion>();
    const s = setup({
      settings: { wakeTimeoutMs: 1000 },
      respond: (r) => {
        if (r.index === 0) {
          return complete(next(), react());
        }
        if (ending === 'model') {
          throw new Error('model failed');
        }
        if (ending === 'prose') {
          return { content: 'ordinary prose', tool_calls: [] };
        }
        return abortable(held.promise, r.signal);
      },
    });
    try {
      await s.receive(event('1'));
      if (ending === 'timeout') {
        t.mock.timers.tick(3);
        await flush();
        await flush();
        assert.equal(s.requests.length, 2);
        t.mock.timers.tick(1001);
        await flush();
      } else {
        await settled(s, 2);
      }
      assert.equal(mutations(s).length, 1);
      assert.deepEqual(plans(s), []);
    } finally {
      held.resolve(complete(silent()));
      await flush();
      await s.close();
      if (ending === 'timeout') {
        t.mock.timers.reset();
      }
    }
  });
}

test('reset during get_msg verification prevents any reaction dispatch', async () => {
  const held = gate<unknown>();
  let gets = 0;
  const s = setup({
    respond: (r) =>
      r.index === 0 ? complete(react(), next(), silent()) : complete(silent()),
    api: (action) =>
      action === 'get_msg' && ++gets === 1 ? held.promise : undefined,
  });
  try {
    await s.receive(event('1'));
    await until(() => gets === 1);
    await s.receive(event('2', OWNER_ID, false, '/reset'));
    held.resolve({
      message_type: 'group',
      group_id: GROUP,
      message_id: '1',
      sender: { user_id: A },
    });
    await settled(s, 1);
    assert.equal(mutations(s).length, 0);
    assert.deepEqual(plans(s), []);
  } finally {
    held.resolve({});
    await s.close();
  }
});

test('reset after reaction dispatch cannot undo it and clears pending attention', async () => {
  const held = gate<unknown>();
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(next(), react(), react('1', '128077'), send())
        : complete(silent()),
    api: (action) =>
      action === 'set_msg_emoji_like' ? held.promise : undefined,
  });
  try {
    await s.receive(event('1'));
    await until(() => mutations(s).length === 1);
    await s.receive(event('2', OWNER_ID, false, '/reset'));
    held.resolve({ result: 0 });
    await settled(s, 1);
    assert.equal(mutations(s).length, 1);
    assert.deepEqual(plans(s), []);
    assert.equal(sends(s).length, 1);
  } finally {
    held.resolve({ result: 0 });
    await s.close();
  }
});

test('disabled reactions remove the schema and reject fabricated tool calls', async () => {
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
      r.index === 0
        ? complete(react(), call('get_wake_state'))
        : complete(silent()),
  });
  try {
    await s.receive(event('1'));
    await settled(s, 2);
    assert.ok(
      s.requests.every(
        (r) => !r.tools.some((t) => t.function.name === 'react_message'),
      ),
    );
    assert.equal(results(s.requests[1]!)[0].error, 'tool_disabled');
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('remote foreign group and unsafe long message IDs never reach the mutation API', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(react('9007199254740993'), react('1'))
        : complete(silent()),
    api: (action) =>
      action === 'get_msg'
        ? {
            message_type: 'group',
            group_id: '33',
            message_id: '1',
            sender: { user_id: A },
          }
        : undefined,
  });
  try {
    await s.receive(event('1'));
    await settled(s, 2);
    assert.equal(mutations(s).length, 0);
    assert.equal(s.calls.filter((c) => c.action === 'get_msg').length, 1);
    assert.deepEqual(
      results(s.requests[1]!).map((r) => r.error),
      ['invalid_arguments', 'verification_failed'],
    );
  } finally {
    await s.close();
  }
});

for (const feature of ['images', 'forward'] as const) {
  test(`${feature} first gate blocks reaction until the next model response after content retrieval`, async () => {
    const attachment =
      feature === 'images'
        ? {
            type: 'image',
            data: { url: 'https://example.invalid/image', file: 'fixture.png' },
          }
        : { type: 'forward', data: { id: 'fixture-forward-resource' } };
    const reading =
      feature === 'images'
        ? call('view_images', { image_ids: ['img_1_1'] })
        : call('read_forward', { forward_id: 'fwd_1_1', start: 1, limit: 1 });
    const s = setup({
      settings:
        feature === 'images'
          ? {
              toolPermissions: {
                ...permissions,
                view_images: { mode: 'direct', maxDownloadMb: 1 },
              },
            }
          : {
              toolPermissions: {
                ...permissions,
                read_forward: { mode: 'direct' },
              },
            },
      respond: (r) => {
        if (r.index === 0) {
          return complete(react(), reading);
        }
        assert.equal(mutations(s).length, 0);
        return complete(react(), silent());
      },
    });
    try {
      const e = event('1');
      e.message = [e.message[0]!, attachment as any];
      await s.receive(e);
      await settled(s, 2);
      assert.equal(mutations(s).length, 1);
      const returned = results(s.requests[1]!);
      assert.equal(returned[0].status, 'error');
      assert.equal(returned[1].status, 'ok');
      if (feature === 'images') {
        assert.ok(
          s.requests[1]!.messages.some(
            (m) =>
              Array.isArray(m.content) &&
              m.content.some((p) => p.type === 'image_url'),
          ),
        );
      }
    } finally {
      await s.close();
    }
  });
}

test('reaction notices, bot messages, private messages and foreign groups do not trigger models', async () => {
  const s = setup();
  try {
    await s.bot.receive(
      {
        post_type: 'notice',
        notice_type: 'group_msg_emoji_like',
        group_id: GROUP,
        self_id: SELF,
        user_id: A,
        message_id: '1',
      },
      SELF,
    );
    await s.receive(event('2', SELF));
    await s.receive(event('3', A, true, 'foreign', '33'));
    await s.bot.receive({ ...event('4'), message_type: 'private' }, SELF);
    await delay(15);
    assert.equal(s.requests.length, 0);
    assert.equal(s.calls.length, 0);
    assert.equal(s.memory.rows.length, 0);
  } finally {
    await s.close();
  }
});

test('finish blocks trailing reactions, sends, reads and moderation', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0
        ? complete(
            silent(),
            react('999'),
            send(),
            call('get_member_info', { user_id: A }),
            call('mute_member', { user_id: A, seconds: 60 }),
          )
        : complete(silent()),
  });
  try {
    await s.receive(event('1', OWNER_ID));
    await settled(s, 1);
    // finish之后的调用一律不执行，也没有唤醒开始时的观察刷新。
    assert.deepEqual(s.calls, []);
    assert.equal(mutations(s).length, 0);
    assert.equal(sends(s).length, 0);
  } finally {
    await s.close();
  }
});

test('native business rejection is not counted as a successful reaction', async () => {
  const s = setup({
    respond: (r) =>
      r.index === 0 ? complete(react(), silent()) : complete(silent()),
    api: (action) =>
      action === 'set_msg_emoji_like'
        ? { result: 1, errMsg: 'fixture rejected' }
        : undefined,
  });
  try {
    await s.receive(event('1'));
    await settled(s, 1);
    const [result] = reactionResults(s);
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'reaction_rejected');
  } finally {
    await s.close();
  }
});
