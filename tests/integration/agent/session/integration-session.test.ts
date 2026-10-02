import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../../src/agent/listener.ts';
import { ModelSession } from '../../../../src/agent/session/store.ts';
import { WorldEventStore } from '../../../../src/world/events.ts';
import { ResponseStateExpiredError } from '../../../../src/model/responses.ts';
import { chatConsumer } from '../../../../src/tools/world/tools.ts';
import { wakeMeta } from '../../../support/listener-fixture.ts';
import {
  LISTENER_GROUP,
  OWNER_ID,
} from '../../../../src/contracts/identity.ts';
import {
  type ChatMessage,
  type Completion,
  type Model,
} from '../../../../src/contracts/model.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../../src/contracts/messages.ts';
import type { ListenerConfig } from '../../../../src/config/listener.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../../support/tool-permissions.ts';

const self = '900000001';
const config: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 1,
  cooldownMs: 1,
  retentionDays: 7,
  randomReplyProbability: 0,
};
const call = (
  id: string,
  name: string,
  args: unknown = name === 'finish' ? { mode: 'hard' } : {},
) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const completion = (...calls: Completion['tool_calls']): Completion => ({
  content: null,
  tool_calls: calls,
});

function event(messageId: string, text: string, direct = true) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: LISTENER_GROUP,
    self_id: self,
    user_id: '12345',
    message_id: messageId,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'user' },
    message: [
      ...(direct ? [{ type: 'at', data: { qq: self } }] : []),
      { type: 'text', data: { text } },
    ],
  };
}

function memory(): Memory {
  const entries: TimelineEntry[] = [];
  return {
    append(e) {
      entries.push(e);
      return true;
    },
    recent: () => {
      throw new Error('frozen memory forbidden');
    },
    find: (id) => entries.find((e) => e.messageId === id),
    context: () => {
      throw new Error('snapshot forbidden');
    },
    compact: async () => {
      throw new Error('compaction forbidden');
    },
    clear() {
      entries.length = 0;
    },
    close() {},
  };
}

async function settled(session: ModelSession, check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check() && !session.state().wakeId) {
      return;
    }
    await delay(5);
  }
  assert.fail('session branch did not finish');
}

test('integrated session delivers unread events, reads history without acknowledging, checkpoints calls and reopens its prefix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'listener-session-')),
    path = join(dir, 'session.db');
  let session = new ModelSession({
    model: 'main',
    path,
    groupId: LISTENER_GROUP,
  });
  const world = new WorldEventStore({
    path: join(dir, 'world.db'),
    groupId: LISTENER_GROUP,
  });
  const requests: ChatMessage[][] = [];
  let listener: Listener;
  let requestId = 0;
  const sent: string[] = [];
  const model: Model = {
    async complete(messages, tools) {
      requestId++;
      requests.push(structuredClone(messages));
      assert.ok(tools?.some((t) => t.function.name === 'read_events'));
      if (requests.length === 1) {
        await listener.receive(event('2', 'LATE_LIVE_BODY', true), self);
        return completion(call('state', 'get_wake_state'));
      }
      if (requests.length === 2) {
        return completion(call('events', 'read_events', { limit: 10 }));
      }
      if (requests.length === 3) {
        const result = JSON.parse(
          String(messages.find((m) => m.tool_call_id === 'events')!.content),
        );
        assert.equal(result.returned, 2);
        assert.match(JSON.stringify(result), /LATE_LIVE_BODY/);
        assert.equal(result.ack_cursor, undefined);
        assert.equal(
          world.getState(chatConsumer(self)).observationWatermark,
          2,
        );
        return completion(call('time', 'get_time'));
      }
      return completion(
        call('send', 'send_message', {
          segments: [{ type: 'text', text: 'verified reply' }],
        }),
        call('done', 'finish'),
        call('trailing', 'send_message', {
          segments: [{ type: 'text', text: 'MUST_NOT_SEND' }],
        }),
      );
    },
  };
  listener = new Listener(
    {
      async call(action) {
        assert.equal(action, 'send_group_msg');
        sent.push(action);
        return { message_id: '100' };
      },
    },
    model,
    memory(),
    config,
    () => 0,
    undefined,
    undefined,
    { world, session, modelRequestId: () => `request-${requestId}` },
  );
  try {
    await listener.receive(event('1', 'INITIAL_SECRET_BODY'), self);
    await settled(session, () => requests.length === 4);
    assert.equal(requests[0]!.length, 3);
    assert.match(JSON.stringify(requests[0]), /INITIAL_SECRET_BODY/);
    assert.doesNotMatch(JSON.stringify(requests[0]), /LATE_LIVE_BODY/);
    assert.match(JSON.stringify(requests[1]), /LATE_LIVE_BODY/);
    const wake = JSON.parse(String(requests[0]![1]!.content)).wake;
    assert.deepEqual(Object.keys(wake).sort(), [
      'group_id',
      'trigger',
      'wake_budget',
      'wake_id',
    ]);
    assert.equal(world.getState(chatConsumer(self)).observationWatermark, 2);
    assert.equal(sent.length, 1);
    await delay(25);
    assert.equal(
      requests.length,
      4,
      'automatic delivery consumes the queued trigger already observed by this wake',
    );
    const prefix = session.messages();
    assert.equal(
      JSON.parse(String(prefix.find((m) => m.tool_call_id === 'send')!.content))
        .status,
      'ok',
    );
    assert.deepEqual(
      JSON.parse(
        String(prefix.find((m) => m.tool_call_id === 'trailing')!.content),
      ),
      { status: 'skipped', error: 'turn_finished' },
    );
    const counts = session.summarizeTools({ since: 0, until: Date.now() });
    assert.equal(counts.pending, 0);
    assert.equal(counts.skipped, 1);
    assert.equal(counts.modelRequests, 4);
    await listener.stop();
    session = new ModelSession({
      model: 'main',
      path,
      groupId: LISTENER_GROUP,
    });
    assert.deepEqual(session.messages(), prefix);
    const nextWorld = new WorldEventStore({
      path: join(dir, 'world.db'),
      groupId: LISTENER_GROUP,
    });
    let next: ChatMessage[] | undefined;
    listener = new Listener(
      {
        async call() {
          throw new Error('unexpected write');
        },
      },
      {
        async complete(messages) {
          next = structuredClone(messages);
          return completion(call('next-finish', 'finish'));
        },
      },
      memory(),
      config,
      () => 0,
      undefined,
      undefined,
      { world: nextWorld, session },
    );
    await listener.receive(event('3', 'SECOND_WAKE_SECRET'), self);
    await settled(session, () => !!next);
    assert.deepEqual(next!.slice(0, prefix.length), prefix);
    assert.match(
      JSON.stringify(next!.slice(prefix.length)),
      /SECOND_WAKE_SECRET/,
    );
  } finally {
    await listener.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attention plans survive session rotation and report their hit only in the attention wake trigger', async () => {
  // 本场景测试元数据持久化，而不是可选的上游目录：76是离线兜底候选。
  const emojiId = '76';
  let reactionWrites = 0;
  const session = new ModelSession({
      model: 'main',
      path: ':memory:',
      groupId: LISTENER_GROUP,
    }),
    world = new WorldEventStore({ path: ':memory:', groupId: LISTENER_GROUP });
  let rounds = 0;
  const requests: ChatMessage[][] = [];
  const listener = new Listener(
    {
      async call(action, params) {
        if (action === 'get_msg') {
          return {
            message_id: params?.message_id,
            message_type: 'group',
            group_id: LISTENER_GROUP,
            user_id: '12345',
            sender: { user_id: '12345' },
            message: [{ type: 'text', data: { text: 'BODY_PRIVATE' } }],
          };
        }
        if (action === 'set_msg_emoji_like') {
          assert.deepEqual(params, {
            message_id: '1',
            emoji_id: emojiId,
            set: true,
          });
          reactionWrites++;
          return { result: 0 };
        }
        throw new Error('unexpected API');
      },
    },
    {
      async complete(messages) {
        rounds++;
        requests.push(structuredClone(messages));
        if (rounds === 1) {
          return completion(
            call('plan', 'manage_attention', {
              operation: 'create',
              purpose: 'wait for different member',
              any_of: [{ type: 'member_message', user_ids: ['99988'] }],
              expires_in_seconds: 600,
            }),
            call('react', 'react_message', {
              message_id: '1',
              emoji_id: emojiId,
              action: 'add',
            }),
            call('finish-1', 'finish'),
          );
        }
        return completion(call(`finish-${rounds}`, 'finish'));
      },
    },
    { ...memory(), recent: () => world.recentMessages(128) },
    {
      ...config,
      toolPermissions: toolPermissions({
        ...MEMBER_TOOLS,
        react_message: 'direct',
        get_reaction_users: 'direct',
        mute_member: { mode: 'off', maxSeconds: 600 },
        manage_attention: { mode: 'direct', maxPlans: 16 },
      }),
      observeReactions: true,
      confirmationTtlSeconds: 60,
    },
    () => 0,
    undefined,
    undefined,
    { session, world },
  );
  try {
    await listener.receive(event('1', 'BODY_PRIVATE'), self);
    await settled(session, () => rounds === 1);
    const planResult = JSON.parse(
      String(
        session.messages().find((m) => m.tool_call_id === 'plan')!.content,
      ),
    );
    assert.equal(planResult.status, 'staged');
    const prior = session.state().sessionId;
    session.reset('transcript_resource_boundary');
    assert.notEqual(session.state().sessionId, prior);
    // 普通唤醒投递消息正文，但不携带计划细节。
    await listener.receive(event('2', 'SECOND_BODY_PRIVATE'), self);
    await settled(session, () => rounds === 2);
    assert.doesNotMatch(
      JSON.stringify(requests[1]),
      /wait for different member|att_[a-f0-9]{16}/,
    );
    assert.equal(reactionWrites, 1);
    // 会话轮换后计划仍在引擎中；目标成员发言触发关注唤醒，命中信息只出现在trigger里。
    await listener.receive(
      { ...event('3', 'THIRD_BODY_PRIVATE', false), user_id: '99988' },
      self,
    );
    await settled(session, () => rounds === 3);
    const wake = wakeMeta(requests[2]!);
    assert.equal(wake.group_id, LISTENER_GROUP);
    assert.deepEqual(wake.trigger, {
      type: 'attention',
      plan_hits: [
        {
          plan_id: planResult.plan_id,
          reason: 'member_message',
          purpose: 'wait for different member',
        },
      ],
    });
    assert.match(JSON.stringify(requests[1]), /SECOND_BODY_PRIVATE/);
    assert.match(JSON.stringify(requests[2]), /THIRD_BODY_PRIVATE/);
  } finally {
    await listener.stop();
  }
});

test('late valid send ACK remains a world fact without resuming cancelled execution', async () => {
  const session = new ModelSession({
      model: 'main',
      path: ':memory:',
      groupId: LISTENER_GROUP,
    }),
    world = new WorldEventStore({ path: ':memory:', groupId: LISTENER_GROUP });
  let rounds = 0,
    writes = 0;
  const listener: Listener = new Listener(
    {
      async call(action) {
        assert.equal(action, 'send_group_msg');
        writes++;
        assert.equal(
          session.summarizeTools({ since: 0, until: Date.now() }).started,
          1,
        );
        listener.setConnected(false);
        return { message_id: '777' };
      },
    },
    {
      async complete() {
        rounds++;
        return completion(
          call('send', 'send_message', {
            segments: [{ type: 'text', text: 'confirmed late delivery' }],
          }),
          call('finish', 'finish'),
        );
      },
    },
    memory(),
    config,
    () => 0,
    undefined,
    undefined,
    { session, world },
  );
  try {
    await listener.receive(event('1', 'trigger'), self);
    await settled(session, () => rounds === 1);
    assert.equal(writes, 1);
    assert.equal(world.findMessage('777')?.text, 'confirmed late delivery');
    assert.equal(
      session.summarizeTools({ since: 0, until: Date.now() }).pending,
      0,
    );
    const result = JSON.parse(
      String(
        session.messages().find((m) => m.tool_call_id === 'send')!.content,
      ),
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.effect_confirmed, true);
    assert.equal(result.cancelled_after_dispatch, true);
  } finally {
    await listener.stop();
  }
});

for (const repeated of [false, true]) {
  test(`expired response state has one fresh recovery, repeated=${repeated}`, async () => {
    const session = new ModelSession({
        model: 'main',
        path: ':memory:',
        groupId: LISTENER_GROUP,
      }),
      world = new WorldEventStore({
        path: ':memory:',
        groupId: LISTENER_GROUP,
      });
    let rounds = 0;
    const listener = new Listener(
      {
        async call() {
          throw new Error('unexpected write');
        },
      },
      {
        async complete(messages) {
          rounds++;
          if (rounds === 1 || repeated) {
            throw new ResponseStateExpiredError(404);
          }
          assert.match(JSON.stringify(messages), /response_state_expired/);
          assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_TRIGGER/);
          return completion(call('recovery-finish', 'finish'));
        },
      },
      memory(),
      config,
      () => 0,
      undefined,
      undefined,
      { session, world },
    );
    try {
      await listener.receive(event('1', 'PRIVATE_TRIGGER'), self);
      await settled(session, () => rounds === 2);
      assert.equal(rounds, 2);
      assert.equal(world.findMessage('1')?.userId, '12345');
      assert.equal(
        session.summarizeTools({ since: 0, until: Date.now() }).pending,
        0,
      );
    } finally {
      await listener.stop();
    }
  });
}

for (const mode of ['budget', 'failure', 'cancel'] as const) {
  test(`session resolves pending calls on ${mode}`, async () => {
    const session = new ModelSession({
        model: 'main',
        path: ':memory:',
        groupId: LISTENER_GROUP,
      }),
      world = new WorldEventStore({
        path: ':memory:',
        groupId: LISTENER_GROUP,
      });
    let rounds = 0;
    let listener: Listener;
    const model: Model = {
      async complete() {
        rounds++;
        if (mode === 'failure') {
          throw new Error('model failed');
        }
        if (mode === 'cancel') {
          listener.setConnected(false);
          return completion(
            call('late', 'send_message', {
              segments: [{ type: 'text', text: 'never' }],
            }),
          );
        }
        return completion(
          call('bad', 'missing_tool'),
          call('budget-tail', 'get_time'),
        );
      },
    };
    listener = new Listener(
      {
        async call() {
          throw new Error('unexpected API');
        },
      },
      model,
      memory(),
      { ...config, maxToolCallsPerWake: 1 },
      () => 0,
      undefined,
      undefined,
      { session, world },
    );
    try {
      await listener.receive(event('1', 'private wake body'), self);
      await settled(session, () => rounds > 0);
      assert.equal(
        session.summarizeTools({ since: 0, until: Date.now() }).pending,
        0,
      );
      if (mode === 'budget') {
        assert.equal(
          JSON.parse(
            String(
              session.messages().find((m) => m.tool_call_id === 'bad')!.content,
            ),
          ).status,
          'error',
        );
        assert.equal(
          JSON.parse(
            String(
              session.messages().find((m) => m.tool_call_id === 'budget-tail')!
                .content,
            ),
          ).status,
          'skipped',
        );
      }
      if (mode === 'cancel') {
        assert.equal(
          session.summarizeTools({ since: 0, until: Date.now() }).pending,
          0,
        );
      }
    } finally {
      await listener.stop();
    }
  });
}
