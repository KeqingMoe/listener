import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import { ModelSession } from '../../../src/agent/session/store.ts';
import { WorldEventStore } from '../../../src/world/events.ts';
import { chatConsumer } from '../../../src/tools/world/tools.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import type {
  ChatMessage,
  Completion,
  Model,
} from '../../../src/contracts/model.ts';
import type { Memory } from '../../../src/contracts/messages.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { wakeMeta } from '../../support/listener-fixture.ts';

const self = '900000001';

function call(name: string, args: unknown = {}, id = name) {
  return {
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function response(...tool_calls: Completion['tool_calls']): Completion {
  return { content: null, tool_calls };
}

const finish = (mode: 'soft' | 'hard' = 'hard') =>
  response(call('finish', { mode }));

function event(id: number, direct = false) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: LISTENER_GROUP,
    self_id: self,
    user_id: '12345',
    message_id: String(id),
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'member' },
    message: [
      ...(direct ? [{ type: 'at', data: { qq: self } }] : []),
      { type: 'text', data: { text: `delivery-body-${id}` } },
    ],
  };
}

function updates(messages: ChatMessage[]) {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => JSON.parse(String(m.content)))
    .filter((v) => v.context_update)
    .map((v) => v.context_update);
}

function toolResult(messages: ChatMessage[], id: string) {
  return JSON.parse(
    String(messages.find((m) => m.tool_call_id === id)!.content),
  );
}

function setup(
  complete: Model['complete'],
  options: Partial<ListenerConfig> = {},
) {
  const session = new ModelSession({
    model: 'main',
    path: ':memory:',
    groupId: LISTENER_GROUP,
  });
  const world = new WorldEventStore({
    path: ':memory:',
    groupId: LISTENER_GROUP,
  });
  const requests: ChatMessage[][] = [];
  const memory: Memory = {
    append: () => true,
    recent: () => [],
    find: () => undefined,
    context: () => '',
    compact: async () => {},
    clear() {},
    close() {},
  };
  const bot = new Listener(
    {
      async call() {
        throw new Error('unexpected API');
      },
    },
    {
      async complete(messages, tools, signal) {
        requests.push(structuredClone(messages));
        return complete(messages, tools, signal);
      },
    },
    memory,
    {
      groupId: LISTENER_GROUP,
      ownerId: OWNER_ID,
      enabled: true,
      debounceMs: 1,
      cooldownMs: 0,
      retentionDays: 7,
      randomReplyProbability: 0,
      toolPermissions: toolPermissions(MEMBER_TOOLS),
      ...options,
    },
    () => 0.5,
    undefined,
    undefined,
    { session, world },
  );
  return { bot, session, world, requests };
}

async function settled(s: ReturnType<typeof setup>, count: number) {
  for (let i = 0; i < 300; i++) {
    if (s.requests.length >= count && !s.session.state().wakeId) {
      return;
    }
    await delay(5);
  }
  assert.fail('listener did not settle');
}

for (const window of [undefined, 3]) {
  test(`opening delivers only latest unread events and clears overflow (window=${window ?? 'default'})`, async () => {
    const s = setup(
      async () => finish(),
      window ? { eventWindowSize: window } : {},
    );
    try {
      for (let id = 1; id <= 25; id++) {
        await s.bot.receive(event(id, id === 25), self);
      }
      await settled(s, 1);
      const u = updates(s.requests[0]!)[0];
      const size = window ?? 20;
      assert.equal(u.unread_count, 25);
      assert.equal(u.omitted_count, 25 - size);
      assert.equal(u.items.length, size);
      assert.ok(
        u.items.every((item: { type: string }) => item.type === 'world_event'),
      );
      assert.match(
        JSON.stringify(u.items[0]),
        new RegExp(`delivery-body-${26 - size}\\b`),
      );
      assert.match(JSON.stringify(u.items.at(-1)), /delivery-body-25/);
      assert.equal(s.world.getState(chatConsumer(self)).unreadEvents, 0);
      assert.equal(s.session.chatReadThrough(self), u.read_through);
      // A different account and the old generic consumer are not acknowledged.
      assert.equal(
        s.world.getState(chatConsumer('900000002')).unreadEvents,
        25,
      );
      assert.equal(s.world.getState('ai').unreadEvents, 25);
      await s.bot.receive(event(26, true), self);
      await settled(s, 2);
      const next = updates(s.requests[1]!).at(-1);
      assert.equal(next.unread_count, 1);
      assert.equal(next.omitted_count, 0);
      assert.equal(next.items.length, 1, 'never backfill already-read history');
      assert.match(JSON.stringify(next), /delivery-body-26/);
    } finally {
      await s.bot.stop();
    }
  });
}

test('successive thinking steps append each live arrival once within the same wake', async () => {
  const s: ReturnType<typeof setup> = setup(async (_messages, tools) => {
    assert.ok(tools?.some((t) => t.function.name === 'read_events'));
    assert.ok(
      !tools?.some((t) =>
        ['read_messages', 'ack_events'].includes(t.function.name),
      ),
    );
    const round = s.requests.length;
    if (round <= 3) {
      await s.bot.receive(event(round + 1, true), self);
      return response(call('get_time', {}, `time-${round}`));
    }
    return finish('soft');
  });
  try {
    await s.bot.receive(event(1, true), self);
    await settled(s, 4);
    const wake = wakeMeta(s.requests[0]!).wake_id;
    for (let i = 0; i < 4; i++) {
      assert.equal(wakeMeta(s.requests[i]!).wake_id, wake);
      const all = updates(s.requests[i]!);
      assert.equal(all.length, i + 1);
      assert.equal(all.at(-1).items.length, 1);
      assert.match(
        JSON.stringify(all.at(-1)),
        new RegExp(`delivery-body-${i + 1}\\b`),
      );
    }
    await delay(20);
    assert.equal(s.requests.length, 4);
  } finally {
    await s.bot.stop();
  }
});

for (const mode of ['soft', 'hard'] as const) {
  test(`${mode} finish with pending QQ input skips trailing tools and ${mode === 'soft' ? 'continues' : 'leaves the pool unread'}`, async () => {
    const s: ReturnType<typeof setup> = setup(async () => {
      if (s.requests.length === 1) {
        await s.bot.receive(event(2), self);
        return response(call('finish', { mode }), call('get_time', {}, 'tail'));
      }
      return finish('soft');
    });
    try {
      await s.bot.receive(event(1, true), self);
      await settled(s, mode === 'soft' ? 2 : 1);
      const result = toolResult(s.session.messages(), 'finish');
      assert.equal(result.closed, mode === 'hard');
      assert.equal(toolResult(s.session.messages(), 'tail').status, 'skipped');
      assert.equal(
        s.world.getState(chatConsumer(self)).unreadEvents,
        mode === 'hard' ? 1 : 0,
      );
      if (mode === 'soft') {
        assert.equal(
          wakeMeta(s.requests[1]!).wake_id,
          wakeMeta(s.requests[0]!).wake_id,
        );
        assert.match(
          JSON.stringify(updates(s.requests[1]!).at(-1)),
          /delivery-body-2/,
        );
      }
      await delay(20);
      assert.equal(s.requests.length, mode === 'soft' ? 2 : 1);
    } finally {
      await s.bot.stop();
    }
  });
}

test('notice-only arrivals join the next context update without a separate chat trigger', async () => {
  const s: ReturnType<typeof setup> = setup(async () => {
    if (s.requests.length === 1) {
      await s.bot.receive(
        {
          post_type: 'notice',
          notice_type: 'group_recall',
          group_id: LISTENER_GROUP,
          self_id: self,
          user_id: '12345',
          operator_id: '12345',
          message_id: '1',
          time: Math.floor(Date.now() / 1000),
        },
        self,
      );
      return finish('soft');
    }
    return finish('soft');
  });
  try {
    await s.bot.receive(event(1, true), self);
    await settled(s, 2);
    const u = updates(s.requests[1]!).at(-1);
    assert.equal(u.unread_count, 1);
    assert.equal(u.items.length, 1);
    assert.equal(u.items[0].type, 'world_event');
    assert.equal(u.items[0].event.type, 'message.recalled');
    assert.equal(
      wakeMeta(s.requests[1]!).wake_id,
      wakeMeta(s.requests[0]!).wake_id,
    );
  } finally {
    await s.bot.stop();
  }
});

test('history defaults backward, before_event_id fills overflow, and queries never acknowledge live unread', async () => {
  const s: ReturnType<typeof setup> = setup(
    async (messages) => {
      if (s.requests.length === 1) {
        await s.bot.receive(event(4), self);
        const anchor = updates(messages)[0].items[0].event.event_id;
        return response(
          call('get_wake_state', {}, 'before'),
          call('read_events', { limit: 2 }, 'latest'),
          call('read_events', { limit: 2, before_event_id: anchor }, 'older'),
          call('get_wake_state', {}, 'after'),
        );
      }
      return finish('soft');
    },
    { eventWindowSize: 2 },
  );
  try {
    for (let id = 1; id <= 3; id++) {
      await s.bot.receive(event(id, id === 3), self);
    }
    await settled(s, 2);
    const messages = s.requests[1]!;
    for (const id of ['before', 'after']) {
      const state = toolResult(messages, id);
      assert.equal(state.read_through, 3);
      assert.equal(state.unread_count, 1);
      assert.equal(state.self_id, self);
    }
    const latest = toolResult(messages, 'latest');
    assert.deepEqual(
      latest.events.map((e: { sequence: number }) => e.sequence),
      [4, 3],
    );
    const older = toolResult(messages, 'older');
    assert.deepEqual(
      older.events.map((e: { sequence: number }) => e.sequence),
      [1],
    );
    assert.equal(latest.ack_cursor, undefined);
    const delivered = updates(messages).at(-1);
    assert.equal(delivered.unread_count, 1);
    assert.equal(delivered.read_through, 4);
    assert.equal(s.world.getState(chatConsumer(self)).unreadEvents, 0);
  } finally {
    await s.bot.stop();
  }
});

for (const args of [{}, { mode: 'invalid' }, { mode: 'soft', extra: true }]) {
  test(`finish validates mode and exact arguments: ${JSON.stringify(args)}`, async () => {
    const s: ReturnType<typeof setup> = setup(async () =>
      s.requests.length === 1
        ? response(
            call('finish', args, 'invalid'),
            call('get_time', {}, 'after-invalid'),
          )
        : finish('soft'),
    );
    try {
      await s.bot.receive(event(1, true), self);
      await settled(s, 2);
      assert.equal(toolResult(s.requests[1]!, 'invalid').status, 'error');
      assert.notEqual(
        toolResult(s.requests[1]!, 'after-invalid').status,
        'skipped',
      );
      assert.equal(
        updates(s.requests[1]!).length,
        1,
        'empty step does not append duplicate input',
      );
    } finally {
      await s.bot.stop();
    }
  });
}

test('job-only wake delivers an empty QQ window and soft finish stops when pool is empty', async () => {
  const s = setup(async () => finish('soft'));
  try {
    await s.bot.receiveSandboxResult({
      selfId: self,
      groupId: LISTENER_GROUP,
      jobId: 'only-job',
      status: 'completed',
      value: 'job-value',
    });
    await settled(s, 1);
    const u = updates(s.requests[0]!)[0];
    assert.equal(u.unread_count, 0);
    assert.equal(u.omitted_count, 0);
    assert.equal(u.read_through, 0);
    assert.equal(u.items.length, 1);
    assert.equal(u.items[0].type, 'job_result');
    assert.equal(u.items[0].event_id, `${self}:only-job`);
    assert.equal(u.items[0].result.value, 'job-value');
    assert.equal(toolResult(s.session.messages(), 'finish').closed, true);
  } finally {
    await s.bot.stop();
  }
});

test('jobs do not consume the QQ cap and soft finish takes both kinds of pending input', async () => {
  const s: ReturnType<typeof setup> = setup(
    async () => {
      if (s.requests.length === 1) {
        for (let id = 2; id <= 5; id++) {
          await s.bot.receive(event(id), self);
        }
        for (const jobId of ['a', 'b', 'c']) {
          await s.bot.receiveSandboxResult({
            selfId: self,
            groupId: LISTENER_GROUP,
            jobId,
            status: 'completed',
            value: jobId,
          });
        }
        return finish('soft');
      }
      return finish('soft');
    },
    { eventWindowSize: 2 },
  );
  try {
    await s.bot.receive(event(1, true), self);
    await settled(s, 2);
    const u = updates(s.requests[1]!).at(-1);
    assert.equal(u.unread_count, 4);
    assert.equal(u.omitted_count, 2);
    assert.equal(
      u.items.filter((i: { type: string }) => i.type === 'world_event').length,
      2,
    );
    assert.deepEqual(
      u.items
        .filter((i: { type: string }) => i.type === 'job_result')
        .map((i: { event_id: string }) => i.event_id),
      ['a', 'b', 'c'].map((id) => `${self}:${id}`),
    );
    assert.equal(s.world.getState(chatConsumer(self)).unreadEvents, 0);
    assert.equal(s.session.hasExternalEvents(self), false);
    assert.equal(
      wakeMeta(s.requests[1]!).wake_id,
      wakeMeta(s.requests[0]!).wake_id,
    );
  } finally {
    await s.bot.stop();
  }
});
