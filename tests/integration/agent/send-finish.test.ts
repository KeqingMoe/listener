import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import { buildToolDefinitions } from '../../../src/agent/tool-definitions.ts';
import { GroupTools } from '../../../src/tools/messaging/tools.ts';
import { Moderation } from '../../../src/tools/management/moderation.ts';
import { MAX_MUTE_SECONDS } from '../../../src/contracts/tool-limits.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import {
  type ChatMessage,
  type Completion,
  type Model,
} from '../../../src/contracts/model.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const self = '999',
  actor = '123';
const cfg: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 1,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
  maxToolCallsPerWake: 12,
  wakeTimeoutMs: 90000,
};

class Mem implements Memory {
  rows: TimelineEntry[] = [];
  append(e: TimelineEntry) {
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
    return JSON.stringify({ summary: null, messages: this.rows });
  }

  async compact() {}
  clear() {
    this.rows = [];
  }

  close() {}
}

const call = (
  name: string,
  args: unknown = name === 'finish' ? { mode: 'hard' } : {},
) => ({
  id: name + Math.random(),
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const done = (...calls: ReturnType<typeof call>[]): Completion => ({
  content: null,
  tool_calls: calls,
});
const send = (text = 'hello') =>
  call('send_message', { segments: [{ type: 'text', text }] });
const event = (id = '1') => ({
  post_type: 'message',
  message_type: 'group',
  group_id: LISTENER_GROUP,
  self_id: self,
  user_id: actor,
  message_id: id,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: 'member' },
  message: [
    { type: 'at', data: { qq: self } },
    { type: 'text', data: { text: 'test' } },
  ],
});

function setup(
  respond: (index: number, messages: ChatMessage[]) => Completion,
  overrides: Partial<ListenerConfig> = {},
  hook?: (action: string, params: any) => Promise<unknown>,
) {
  const memory = new Mem(),
    requests: ChatMessage[][] = [],
    calls: { action: string; params: any }[] = [];
  let n = 900;
  const api: Api = {
    async call(action, params) {
      calls.push({ action, params: structuredClone(params) });
      if (hook) {
        const r = await hook(action, params);
        if (r !== undefined) {
          return r;
        }
      }
      if (action === 'send_group_msg') {
        return { message_id: String(++n) };
      }
      if (action === 'get_login_info') {
        return { user_id: self };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: LISTENER_GROUP,
          user_id: (params as any).user_id,
          role: (params as any).user_id === self ? 'admin' : 'member',
        };
      }
      if (action === 'get_msg') {
        return {
          message_type: 'group',
          group_id: LISTENER_GROUP,
          message_id: (params as any).message_id,
          sender: { user_id: self },
          message: [{ type: 'text', data: { text: 'hello' } }],
        };
      }
      if (action === 'delete_msg' || action === 'set_group_ban') {
        return null;
      }
      throw new Error(action);
    },
  };
  const model: Model = {
    async complete(messages) {
      requests.push(structuredClone(messages));
      return respond(requests.length - 1, messages);
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    { ...cfg, ...overrides },
    undefined,
    undefined,
    undefined,
    sessionRuntime({ ...cfg, ...overrides }.groupId).runtime,
  );
  return { bot, memory, requests, calls };
}

async function settle(s: ReturnType<typeof setup>, count = 1) {
  for (let i = 0; i < 1200; i++) {
    if (
      s.requests.length >= count &&
      !(s.bot as any).running &&
      !(s.bot as any).pending
    ) {
      return;
    }
    await delay(5);
  }
  assert.fail('listener failed to finish');
}

const results = (m: ChatMessage[]) =>
  m.filter((r) => r.role === 'tool').map((r) => JSON.parse(String(r.content)));

test('send is single-message strict, finish replaces old terminal tool', async () => {
  const memory = new Mem(),
    tools = new GroupTools(
      {
        async call() {
          throw new Error('no lookup');
        },
      },
      memory,
      { groupId: LISTENER_GROUP },
    );
  const ctx = {
    groupId: LISTENER_GROUP,
    selfId: self,
    actorId: actor,
    messageId: '1',
  };
  for (const args of [
    { parts: [{ segments: [{ type: 'text', text: 'x' }] }] },
    { text: 'x' },
    { segments: [{ type: 'text', text: 'x' }], parts: [] },
  ]) {
    await assert.rejects(tools.prepareMessage(args, ctx));
  }
  const p = await tools.prepareMessage(
    { segments: [{ type: 'text', text: '[CQ:at,qq=all]' }] },
    ctx,
  );
  assert.deepEqual(p.segments, [
    { type: 'text', data: { text: '[CQ:at,qq=all]' } },
  ]);
  const defs = buildToolDefinitions(cfg);
  assert.ok(defs.some((t) => t.function.name === 'finish'));
  assert.ok(!defs.some((t) => t.function.name === 'stay_silent'));
  const s = setup((i) =>
    i === 0 ? done(call('stay_silent')) : done(call('finish')),
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s, 2);
    assert.equal(results(s.requests[1]!)[0].status, 'error');
  } finally {
    await s.bot.stop();
  }
});

test('send executes long text, many segments and more than three mentions without truncation', async () => {
  const text = '字😀'.repeat(801),
    ids = ['123', '124', '125', '126', '123'];
  const segments = [
    ...Array.from({ length: 130 }, (_, i) => ({
      type: 'text',
      text: i === 0 ? text : 'x',
    })),
    ...ids.map((user_id) => ({ type: 'at', user_id })),
  ];
  const s = setup((i) =>
    i === 0 ? done(call('send_message', { segments })) : done(call('finish')),
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s, 2);
    assert.equal(results(s.requests[1]!)[0].status, 'ok');
    const sends = s.calls.filter((c) => c.action === 'send_group_msg');
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0]!.params.message, [
      ...Array.from({ length: 130 }, (_, i) => ({
        type: 'text',
        data: { text: i === 0 ? text : 'x' },
      })),
      ...ids.map((qq) => ({ type: 'at', data: { qq } })),
    ]);
    assert.deepEqual(
      s.calls
        .filter((c) => c.action === 'get_group_member_info')
        .map((c) => c.params.user_id),
      ['123', '124', '125', '126'],
    );
    assert.equal(s.memory.rows.filter((e) => e.bot).length, 1);
  } finally {
    await s.bot.stop();
  }
});

test('send-send-finish sends two identical messages and stops all later calls', async () => {
  const s = setup(() =>
    done(
      send(),
      send(),
      call('finish'),
      send('must not send'),
      call('get_member_info', { user_id: actor }),
    ),
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s);
    assert.equal(s.requests.length, 1);
    assert.equal(
      s.calls.filter((c) => c.action === 'send_group_msg').length,
      2,
    );
    assert.equal(
      s.calls.filter((c) => c.action === 'get_group_member_info').length,
      0,
    );
    assert.deepEqual(
      s.memory.rows.filter((e) => e.bot).map((e) => e.messageId),
      ['901', '902'],
    );
  } finally {
    await s.bot.stop();
  }
});

test('ACK own message is readable, quotable and recallable without opening new incoming scope', async () => {
  const tools = {
    toolPermissions: toolPermissions({
      ...MEMBER_TOOLS,
      mute_member: { mode: 'off', maxSeconds: 600 },
      unmute_member: 'off',
      recall_message: 'direct',
      set_member_card: 'off',
    }),
    confirmationTtlSeconds: 60,
  };
  const s = setup((i, m) => {
    if (i === 0) {
      return done(send());
    }
    if (i === 1) {
      assert.equal(results(m)[0].message_id, '901');
      s.memory.append({
        messageId: '777',
        userId: actor,
        nickname: 'late',
        text: 'late',
        time: 1,
      });
      return done(
        call('read_message', { message_id: '901' }),
        call('read_message', { message_id: '777' }),
      );
    }
    if (i === 2) {
      const r = results(m);
      assert.equal(r[1].message.bot, true);
      assert.equal(r[2].error, 'message_not_in_context');
      return done(
        call('send_message', {
          segments: [{ type: 'text', text: 'quote own' }],
          reply_to: '901',
        }),
        call('recall_message', { message_id: '901' }),
      );
    }
    assert.equal(results(m).at(-1).status, 'executed');
    return done(call('finish'));
  }, tools);
  try {
    await s.bot.receive(event(), self);
    await settle(s, 4);
    assert.equal(s.calls.filter((c) => c.action === 'delete_msg').length, 1);
    const sends = s.calls.filter((c) => c.action === 'send_group_msg');
    assert.deepEqual(sends[1]!.params.message[0], {
      type: 'reply',
      data: { id: '901' },
    });
    assert.ok(
      !s.calls.some(
        (c) => c.action === 'get_msg' && c.params.message_id === '777',
      ),
    );
  } finally {
    await s.bot.stop();
  }
});

test('malformed send ACK is unknown, does not enter history, and retry is not dispatched', async () => {
  const s = setup(
    (i) =>
      i === 0 ? done(send()) : i === 1 ? done(send()) : done(call('finish')),
    {},
    async (action) => (action === 'send_group_msg' ? {} : undefined),
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s, 3);
    assert.equal(results(s.requests[1]!)[0].status, 'unknown');
    assert.equal(results(s.requests[2]!).at(-1).duplicate, true);
    assert.equal(
      s.calls.filter((c) => c.action === 'send_group_msg').length,
      1,
    );
    assert.equal(s.memory.rows.filter((e) => e.bot).length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('budget exhaustion after send does not pretend finish or admit another send', async () => {
  const s = setup(() => done(send(), send('second'), call('finish')), {
    maxToolCallsPerWake: 1,
  });
  try {
    await s.bot.receive(event(), self);
    await settle(s);
    assert.equal(
      s.calls.filter((c) => c.action === 'send_group_msg').length,
      1,
    );
    assert.equal(s.requests.length, 1);
  } finally {
    await s.bot.stop();
  }
});

test('finish ignores trailing media even when a send precedes finish', async () => {
  for (const calls of [
    [call('finish'), call('view_images', { image_ids: ['img_1_0'] })],
    [
      send(),
      call('finish'),
      call('read_forward', { forward_id: 'fwd_1_0', start: 1, end: 1 }),
    ],
  ]) {
    const s = setup(() => done(...calls));
    try {
      await s.bot.receive(event(), self);
      await settle(s);
      assert.equal(s.requests.length, 1);
      assert.equal(
        s.calls.length,
        calls[0]!.function.name === 'finish' ? 0 : 1,
      );
      assert.ok(s.calls.every((c) => c.action === 'send_group_msg'));
    } finally {
      await s.bot.stop();
    }
  }
  const s = setup((i) =>
    i === 0 ? done(call('finish', { bogus: true })) : done(call('finish')),
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s, 2);
    assert.equal(results(s.requests[1]!)[0].status, 'error');
  } finally {
    await s.bot.stop();
  }
});

test('management cycles execute changed state while immediate identical duplicates remain deduplicated', async () => {
  const tools = {
    toolPermissions: toolPermissions({
      ...MEMBER_TOOLS,
      mute_member: { mode: 'direct', maxSeconds: 600 },
      unmute_member: 'direct',
      recall_message: 'off',
      set_member_card: 'off',
    }),
    confirmationTtlSeconds: 60,
  };
  const mute = () => call('mute_member', { user_id: actor, seconds: 60 });
  const s = setup(
    () =>
      done(
        mute(),
        mute(),
        call('unmute_member', { user_id: actor }),
        mute(),
        call('finish'),
      ),
    tools,
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s);
    assert.deepEqual(
      s.calls
        .filter((c) => c.action === 'set_group_ban')
        .map((c) => c.params.duration),
      [60, 0, 60],
    );
  } finally {
    await s.bot.stop();
  }
});

test('listener executes adopted thirty-day cap and rejects one second above before native dispatch', async () => {
  const tools = {
    toolPermissions: toolPermissions({
      ...MEMBER_TOOLS,
      mute_member: { mode: 'direct', maxSeconds: MAX_MUTE_SECONDS },
      unmute_member: 'off',
      recall_message: 'off',
      set_member_card: 'off',
    }),
    confirmationTtlSeconds: 60,
  };
  const s = setup(
    (i) =>
      i === 0
        ? done(
            call('mute_member', { user_id: actor, seconds: MAX_MUTE_SECONDS }),
          )
        : i === 1
          ? done(
              call('mute_member', {
                user_id: actor,
                seconds: MAX_MUTE_SECONDS + 1,
              }),
            )
          : done(call('finish')),
    tools,
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s, 3);
    assert.equal(results(s.requests[1]!)[0].status, 'executed');
    assert.equal(results(s.requests[2]!).at(-1).error, 'invalid_arguments');
    assert.deepEqual(
      s.calls
        .filter((c) => c.action === 'set_group_ban')
        .map((c) => c.params.duration),
      [MAX_MUTE_SECONDS],
    );
  } finally {
    await s.bot.stop();
  }
});

test('cancelPending invalidates only the specified confirmation code', async () => {
  const api: Api = {
    async call(action, params) {
      if (action === 'get_login_info') {
        return { user_id: self };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: LISTENER_GROUP,
          user_id: params!.user_id,
          role: params!.user_id === self ? 'admin' : 'member',
        };
      }
      return null;
    },
  };
  const m = new Moderation(
      api,
      Date.now,
      { mute: 'confirm' },
      LISTENER_GROUP,
      OWNER_ID,
    ),
    ctx = {
      groupId: LISTENER_GROUP,
      selfId: self,
      actorId: actor,
      messageId: '1',
    };
  const a = await m.request('mute_member', { user_id: actor, seconds: 1 }, ctx),
    b = await m.request('mute_member', { user_id: '456', seconds: 1 }, ctx);
  assert.equal(m.cancelPending(String(a.code)), true);
  assert.equal(
    (await m.confirm(String(a.code), { ...ctx, actorId: OWNER_ID })).status,
    'error',
  );
  assert.equal(
    (await m.confirm(String(b.code), { ...ctx, actorId: OWNER_ID })).status,
    'executed',
  );
});
