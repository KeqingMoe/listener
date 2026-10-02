import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
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
import type {
  ListenerConfig,
  ModerationPolicy,
} from '../../../src/config/listener.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const self = '999',
  actor = '123',
  target = '456';
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
const policy = (override: Partial<ModerationPolicy>) => ({
  toolPermissions: toolPermissions({
    ...MEMBER_TOOLS,
    mute_member: { mode: override.mute ?? 'off', maxSeconds: 600 },
    unmute_member: override.unmute ?? 'off',
    recall_message: override.recall ?? 'off',
    set_member_card: override.memberCard ?? 'off',
  }),
  confirmationTtlSeconds: 60,
});

class Mem implements Memory {
  rows: TimelineEntry[] = [];
  append(row: TimelineEntry) {
    if (this.find(row.messageId)) {
      return false;
    }
    this.rows.push(structuredClone(row));
    return true;
  }

  recent() {
    return this.rows;
  }

  find(id: string) {
    return this.rows.find((r) => r.messageId === id);
  }

  context() {
    return JSON.stringify(this.rows);
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
const response = (...calls: ReturnType<typeof call>[]): Completion => ({
  content: null,
  tool_calls: calls,
});
const event = (
  id = '1',
  user = actor,
  body = '看看这段聊天',
  mention = true,
) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: LISTENER_GROUP,
  self_id: self,
  user_id: user,
  message_id: id,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: 'member' },
  message: [
    ...(mention ? [{ type: 'at', data: { qq: self } }] : []),
    { type: 'text', data: { text: body } },
  ],
});

function setup(
  modes: Partial<ModerationPolicy> | undefined,
  respond: (index: number, messages: ChatMessage[]) => Completion,
  overrides: Partial<ListenerConfig> = {},
  hook?: (action: string, params: any) => Promise<unknown>,
) {
  const memory = new Mem(),
    requests: ChatMessage[][] = [],
    toolNames: string[][] = [],
    calls: { action: string; params: any }[] = [];
  const api: Api = {
    async call(action, params) {
      calls.push({ action, params: structuredClone(params) });
      if (hook) {
        const value = await hook(action, params);
        if (value !== undefined) {
          return value;
        }
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
          sender: { user_id: actor },
          message: [{ type: 'text', data: { text: 'known message' } }],
        };
      }
      if (action === 'send_group_msg') {
        return { message_id: String(900 + calls.length) };
      }
      if (['set_group_ban', 'set_group_card', 'delete_msg'].includes(action)) {
        return null;
      }
      assert.fail('unexpected action ' + action);
    },
  };
  const model: Model = {
    async complete(messages, tools) {
      requests.push(structuredClone(messages));
      toolNames.push(tools?.map((t) => t.function.name) ?? []);
      return respond(requests.length - 1, messages);
    },
  };
  const cfg = {
    ...config,
    ...(modes ? policy(modes) : {}),
    ...overrides,
  };
  const runtime = sessionRuntime(cfg.groupId).runtime;
  const bot = new Listener(
    api,
    model,
    memory,
    cfg,
    () => 0,
    undefined,
    undefined,
    runtime,
  );
  return {
    bot,
    memory,
    requests,
    toolNames,
    calls,
    world: runtime.world,
    receive: (value = event()) => bot.receive(value, self),
  };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 600; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('listener did not settle');
}

const settled = (s: ReturnType<typeof setup>, count: number) =>
  until(
    () =>
      s.requests.length >= count &&
      !(s.bot as any).running &&
      !(s.bot as any).pending,
  );
const results = (messages: ChatMessage[]) =>
  messages
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(String(m.content)));

test('nonowner direct management executes autonomously, deduplicates, and reports independent modes', async () => {
  const s = setup({ mute: 'direct', unmute: 'direct' }, (i) =>
    i === 0
      ? response(call('mute_member', { user_id: target, seconds: 120 }))
      : i === 1
        ? response(
            call('mute_member', { seconds: 120, user_id: target }),
            call('unmute_member', { user_id: target }),
            call('finish'),
          )
        : response(call('finish')),
  );
  try {
    await s.receive();
    await settled(s, 2);
    // 会话模式下各项群管模式体现为本轮提供的工具集合。
    assert.ok(s.toolNames[0]!.includes('mute_member'));
    assert.ok(s.toolNames[0]!.includes('unmute_member'));
    assert.ok(!s.toolNames[0]!.includes('recall_message'));
    assert.ok(!s.toolNames[0]!.includes('set_member_card'));
    assert.equal(results(s.requests[1]!)[0].status, 'executed');
    assert.deepEqual(
      s.calls.filter((c) => c.action === 'set_group_ban').map((c) => c.params),
      [
        { group_id: LISTENER_GROUP, user_id: target, duration: 120 },
        { group_id: LISTENER_GROUP, user_id: target, duration: 0 },
      ],
    );
    assert.equal(
      s.calls.filter((c) => c.action === 'send_group_msg').length,
      0,
    );
  } finally {
    await s.bot.stop();
  }
});

test('random participation can autonomously unmute without owner request or a mute capability', async () => {
  const s = setup(
    { unmute: 'direct' },
    (i) =>
      i === 0
        ? response(call('unmute_member', { user_id: target }))
        : response(call('finish')),
    { randomReplyProbability: 1, randomCooldownMs: 0 },
  );
  try {
    await s.receive(event('1', actor, '普通群聊', false));
    await settled(s, 2);
    assert.equal(results(s.requests[1]!)[0].status, 'executed');
    assert.deepEqual(
      s.calls.filter((c) => c.action === 'set_group_ban').map((c) => c.params),
      [{ group_id: LISTENER_GROUP, user_id: target, duration: 0 }],
    );
    assert.equal(
      s.calls.filter((c) => c.action === 'send_group_msg').length,
      0,
    );
  } finally {
    await s.bot.stop();
  }
});

test('default off also blocks owner hallucinated calls without a native lookup', async () => {
  const s = setup(undefined, (i) =>
    i === 0
      ? response(
          call('mute_member', { user_id: target, seconds: 120 }),
          call('unmute_member', { user_id: target }),
        )
      : response(call('finish')),
  );
  try {
    await s.receive(event('1', OWNER_ID));
    await settled(s, 2);
    assert.deepEqual(
      results(s.requests[1]!).map((r) => r.error),
      ['tool_disabled', 'tool_disabled'],
    );
    assert.equal(s.calls.length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('a nonowner-triggered autonomous proposal is described and only the owner can confirm it', async () => {
  const s = setup({ mute: 'confirm' }, () =>
    response(
      call('mute_member', { user_id: target, seconds: 120 }),
      call('finish'),
    ),
  );
  try {
    await s.receive();
    await settled(s, 1);
    const notices = s.calls.filter((c) => c.action === 'send_group_msg');
    assert.equal(notices.length, 1);
    const notice = notices[0]!.params.message
      .map((x: any) => x.data.text ?? '')
      .join('');
    assert.match(notice, /456/);
    assert.match(notice, /120/);
    assert.ok(!notice.includes('undefined'));
    const code = /\/confirm ([a-f0-9]+)/.exec(notice)![1]!;
    assert.equal(s.calls.filter((c) => c.action === 'set_group_ban').length, 0);
    await s.receive(event('2', actor, '/confirm ' + code, false));
    assert.equal(s.calls.filter((c) => c.action === 'set_group_ban').length, 0);
    await s.receive(event('3', OWNER_ID, '/confirm ' + code, false));
    assert.equal(s.calls.filter((c) => c.action === 'set_group_ban').length, 1);
    assert.equal(s.requests.length, 1);
  } finally {
    await s.bot.stop();
  }
});

test('direct recall is limited to frozen visible messages, not arbitrary guessed IDs', async () => {
  const s = setup({ recall: 'direct' }, (i) =>
    i === 0
      ? response(
          call('recall_message', { message_id: '888' }),
          call('recall_message', { message_id: '1' }),
        )
      : response(call('finish')),
  );
  try {
    await s.receive();
    await settled(s, 2);
    const r = results(s.requests[1]!);
    assert.equal(r[0].error, 'message_not_in_context');
    assert.equal(r[1].status, 'executed');
    assert.deepEqual(
      s.calls
        .filter((c) => c.action === 'get_msg')
        .map((c) => c.params.message_id),
      ['1'],
    );
    assert.deepEqual(
      s.calls.filter((c) => c.action === 'delete_msg').map((c) => c.params),
      [{ message_id: '1' }],
    );
  } finally {
    await s.bot.stop();
  }
});

test('ordinary-member bot can recall its own verified historical message through the full listener path', async () => {
  const s = setup(
    { recall: 'direct' },
    (i) =>
      i === 0
        ? response(call('recall_message', { message_id: '900' }))
        : response(call('finish')),
    {},
    async (action, params) => {
      if (action === 'get_group_member_info' && params.user_id === self) {
        return { group_id: LISTENER_GROUP, user_id: self, role: 'member' };
      }
      if (action === 'get_msg') {
        return {
          message_type: 'group',
          group_id: LISTENER_GROUP,
          message_id: params.message_id,
          user_id: self,
          sender: { user_id: self },
          message: [{ type: 'text', data: { text: 'own message' } }],
        };
      }
    },
  );
  const own = {
    messageId: '900',
    userId: self,
    nickname: 'bot',
    bot: true,
    time: Math.floor(Date.now() / 1000),
    text: 'own message',
    segments: [{ type: 'text' as const, text: 'own message' }],
  };
  s.memory.append(own);
  // 会话模式下消息核验读取本群world。
  s.world.appendMessage(own, { source: 'onebot' });
  try {
    await s.receive();
    await settled(s, 2);
    assert.equal(results(s.requests[1]!)[0].status, 'executed');
    assert.deepEqual(
      s.calls.filter((c) => c.action === 'delete_msg').map((c) => c.params),
      [{ message_id: '900' }],
    );
    assert.deepEqual(
      s.calls
        .filter((c) => c.action === 'get_group_member_info')
        .map((c) => c.params.user_id),
      [self],
    );
    assert.equal(
      s.calls.filter((c) => c.action === 'send_group_msg').length,
      0,
    );
  } finally {
    await s.bot.stop();
  }
});

test('owner-authored visible messages have no special recall immunity', async () => {
  const s = setup(
    { recall: 'direct' },
    (i) =>
      i === 0
        ? response(call('recall_message', { message_id: '1' }))
        : response(call('finish')),
    {},
    async (action, params) =>
      action === 'get_msg'
        ? {
            message_type: 'group',
            group_id: LISTENER_GROUP,
            message_id: params.message_id,
            sender: { user_id: OWNER_ID },
            message: [{ type: 'text', data: { text: 'owner message' } }],
          }
        : undefined,
  );
  try {
    await s.receive(event('1', OWNER_ID));
    await settled(s, 2);
    assert.equal(results(s.requests[1]!)[0].status, 'executed');
    assert.equal(s.calls.filter((c) => c.action === 'delete_msg').length, 1);
  } finally {
    await s.bot.stop();
  }
});

test('unknown direct delivery is not claimed successful and cannot be dispatched again that turn', async () => {
  const s = setup(
    { mute: 'direct' },
    (i) =>
      i === 0
        ? response(call('mute_member', { user_id: target, seconds: 120 }))
        : i === 1
          ? response(call('mute_member', { seconds: 120, user_id: target }))
          : response(call('finish')),
    {},
    async (action) => {
      if (action === 'set_group_ban') {
        throw new Error('sensitive transport secret');
      }
    },
  );
  try {
    await s.receive();
    await settled(s, 3);
    const first = results(s.requests[1]!)[0],
      retry = results(s.requests[2]!).at(-1);
    assert.equal(first.status, 'unknown');
    assert.equal(retry.status, 'unknown');
    assert.equal(retry.duplicate, true);
    assert.equal(s.calls.filter((c) => c.action === 'set_group_ban').length, 1);
    assert.ok(
      !JSON.stringify(s.requests).includes('sensitive transport secret'),
    );
  } finally {
    await s.bot.stop();
  }
});

test('failed or unknown direct results defer prewritten replies until the model reviews the result', async () => {
  for (const failure of ['unknown', 'rejected'] as const) {
    const s = setup(
      { mute: 'direct' },
      (i) =>
        i === 0
          ? response(
              call('mute_member', { user_id: target, seconds: 120 }),
              call('send_message', {
                segments: [{ type: 'text', text: 'PREWRITTEN_SUCCESS_CLAIM' }],
              }),
            )
          : response(
              call('send_message', {
                segments: [
                  { type: 'text', text: '已看到结果，暂不声称成功。' },
                ],
              }),
              call('finish'),
            ),
      {},
      async (action) => {
        if (action === 'set_group_ban') {
          if (failure === 'unknown') {
            throw new Error('transport');
          }
          return { result: 1 };
        }
      },
    );
    try {
      await s.receive();
      await settled(s, 2);
      assert.equal(
        results(s.requests[1]!)[1].error,
        'management_result_review_required',
      );
      const sends = s.calls.filter((c) => c.action === 'send_group_msg');
      assert.equal(sends.length, 1);
      assert.ok(!JSON.stringify(sends).includes('PREWRITTEN_SUCCESS_CLAIM'));
      assert.equal(
        s.calls.filter((c) => c.action === 'set_group_ban').length,
        1,
      );
    } finally {
      await s.bot.stop();
    }
  }
});

test('recall refuses a fresh message whose sender differs from the frozen known sender', async () => {
  const s = setup(
    { recall: 'direct' },
    (i) =>
      i === 0
        ? response(call('recall_message', { message_id: '1' }))
        : response(call('finish')),
    {},
    async (action, params) =>
      action === 'get_msg'
        ? {
            message_type: 'group',
            group_id: LISTENER_GROUP,
            message_id: params.message_id,
            sender: { user_id: '789' },
            message: [{ type: 'text', data: { text: 'different message' } }],
          }
        : undefined,
  );
  try {
    await s.receive();
    await settled(s, 2);
    assert.equal(results(s.requests[1]!)[0].status, 'error');
    assert.equal(s.calls.filter((c) => c.action === 'delete_msg').length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('terminal silence prevents later management calls in the same response', async () => {
  const s = setup({ mute: 'direct' }, () =>
    response(
      call('finish'),
      call('mute_member', { user_id: target, seconds: 120 }),
    ),
  );
  try {
    await s.receive();
    await settled(s, 1);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('media-first gating also defers direct management until a later model response', async () => {
  const s = setup({ mute: 'direct' }, (i) =>
    i === 0
      ? response(
          call('view_images', { image_ids: ['img_1_0'] }),
          call('mute_member', { user_id: target, seconds: 120 }),
        )
      : response(call('finish')),
  );
  try {
    await s.receive();
    await settled(s, 2);
    assert.equal(
      results(s.requests[1]!)[1].error,
      '先接收本轮图片内容，再在下一轮决定回复或操作。',
    );
    assert.equal(s.calls.length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('stop during native permission verification prevents a later direct mutation', async () => {
  let release!: (value: unknown) => void;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const s = setup(
    { mute: 'direct' },
    () => response(call('mute_member', { user_id: target, seconds: 120 })),
    {},
    async (action, params) =>
      action === 'get_group_member_info' && params.user_id === self
        ? gate
        : undefined,
  );
  try {
    await s.receive();
    await until(() =>
      s.calls.some((c) => c.action === 'get_group_member_info'),
    );
    const stopped = s.bot.stop();
    release({ group_id: LISTENER_GROUP, user_id: self, role: 'admin' });
    await stopped;
    assert.equal(s.calls.filter((c) => c.action === 'set_group_ban').length, 0);
  } finally {
    release(undefined);
    await s.bot.stop();
  }
});
