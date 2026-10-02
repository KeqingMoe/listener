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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSession } from '../../../src/agent/session/store.ts';
import { WorldEventStore } from '../../../src/world/events.ts';
import { sessionRuntime, wakeMeta } from '../../support/listener-fixture.ts';

/** 每个工具调用为结果预留1KiB；数千调用的单次回复需要放宽会话记录上限。 */
function largeSessionRuntime(groupId: string) {
  const dir = mkdtempSync(join(tmpdir(), 'wake-budget-session-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  return {
    session: new ModelSession({
      model: 'main',
      path: join(dir, 'session.sqlite'),
      groupId,
      maxTranscriptBytes: 16 * 1024 * 1024,
    }),
    world: new WorldEventStore({ path: join(dir, 'world.sqlite'), groupId }),
  };
}

const self = '900000001';
const cfg: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 1,
  delayMaxMs: 1,
  cooldownMs: 1,
  retentionDays: 7,
  randomReplyProbability: 1,
  randomCooldownMs: 0,
  randomMaxPerMinute: 10,
  maxToolCallsPerWake: 96,
  wakeTimeoutMs: 90000,
};

class Mem implements Memory {
  rows: TimelineEntry[] = [];
  append(e: TimelineEntry) {
    this.rows.push(e);
    return true;
  }

  recent() {
    return this.rows;
  }

  find(id: string) {
    return this.rows.find((e) => e.messageId === id);
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

const event = (id = '1') => ({
  post_type: 'message',
  message_type: 'group',
  group_id: LISTENER_GROUP,
  self_id: self,
  user_id: '123',
  message_id: id,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: 'x' },
  message: [{ type: 'text', data: { text: 'hello' } }],
});
const call = (
  name: string,
  args: unknown = name === 'finish' ? { mode: 'hard' } : {},
) => ({
  id: `${name}-${Math.random()}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

function setup(
  complete: (
    round: number,
    messages: ChatMessage[],
  ) => Completion | Promise<Completion>,
  overrides: Partial<ListenerConfig> = {},
  runtime = sessionRuntime({ ...cfg, ...overrides }.groupId).runtime,
) {
  const requests: ChatMessage[][] = [];
  const calls: string[] = [];
  const api: Api = {
    async call(action) {
      calls.push(action);
      if (action === 'send_group_msg') {
        return { message_id: String(calls.length) };
      }
      return {};
    },
  };
  const memory = new Mem();
  const model: Model = {
    async complete(messages) {
      requests.push(structuredClone(messages));
      return complete(requests.length - 1, messages);
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    { ...cfg, ...overrides },
    () => 0,
    undefined,
    undefined,
    runtime,
  );
  return { bot, requests, calls };
}

async function settle(s: ReturnType<typeof setup>) {
  for (let i = 0; i < 1500; i++) {
    if (!(s.bot as any).running && s.requests.length) {
      return;
    }
    await delay(2);
  }
  assert.fail('wake did not settle');
}

test('constructor rejects unsafe unified wake budgets', () => {
  for (const key of ['maxToolCallsPerWake', 'wakeTimeoutMs'] as const) {
    for (const value of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      true,
      '96',
      null,
      ...(key === 'wakeTimeoutMs' ? [600001] : []),
    ]) {
      assert.throws(
        () =>
          new Listener(
            { call: async () => null },
            undefined,
            undefined,
            {
              ...cfg,
              [key]: value,
            } as any,
            undefined,
            undefined,
            undefined,
            sessionRuntime(
              (
                {
                  ...cfg,
                  [key]: value,
                } as any
              ).groupId,
            ).runtime,
          ),
      );
    }
  }
  assert.doesNotThrow(
    () =>
      new Listener(
        { call: async () => null },
        undefined,
        undefined,
        {
          ...cfg,
          maxToolCallsPerWake: 1,
          wakeTimeoutMs: 1000,
        },
        undefined,
        undefined,
        undefined,
        sessionRuntime(
          {
            ...cfg,
            maxToolCallsPerWake: 1,
            wakeTimeoutMs: 1000,
          }.groupId,
        ).runtime,
      ),
  );
});

test('wake dispatch passes the former 4096 call ceiling', async () => {
  const s = setup(
    (round) =>
      round === 0
        ? {
            content: null,
            tool_calls: Array.from({ length: 4097 }, () =>
              call('get_group_members', { limit: 1 }),
            ),
          }
        : { content: null, tool_calls: [call('finish')] },
    { maxToolCallsPerWake: 4098 },
    largeSessionRuntime(cfg.groupId!),
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s);
    assert.equal(
      s.calls.filter((x) => x === 'get_group_member_list').length,
      4097,
    );
    assert.equal(s.requests.length, 2);
  } finally {
    await s.bot.stop();
  }
});

test('all tool calls share one budget and the model sees remaining values', async () => {
  const s = setup(
    (round) =>
      round < 7
        ? {
            content: null,
            tool_calls: [
              call('get_group_members', { offset: round, limit: 1 }),
            ],
          }
        : { content: null, tool_calls: [call('finish')] },
    { maxToolCallsPerWake: 8 },
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s);
    assert.equal(s.requests.length, 8);
    for (let i = 1; i < s.requests.length; i++) {
      assert.deepEqual(
        s.requests[i]!.slice(0, s.requests[i - 1]!.length),
        s.requests[i - 1],
      );
    }
    assert.equal(
      s.requests
        .at(-1)!
        .filter(
          (m) =>
            m.role === 'user' && !JSON.parse(String(m.content)).context_update,
        ).length,
      1,
    );
    // 首轮预算来自唤醒元数据，之后来自最近一次工具结果。
    const budgets = s.requests.map((m) => {
      const last = m.filter((x) => x.role === 'tool').at(-1);
      return last
        ? JSON.parse(String(last.content)).wake_budget
        : wakeMeta(m).wake_budget;
    });
    assert.equal(budgets[0].used_tool_calls, 0);
    assert.equal(budgets.at(-1)!.remaining_tool_calls, 1);
  } finally {
    await s.bot.stop();
  }
});

test('a response is truncated at the shared budget prefix', async () => {
  const s = setup(
    () => ({
      content: null,
      tool_calls: [
        call('get_group_members', { limit: 1 }),
        call('get_group_members', { limit: 1 }),
        call('get_group_members', { limit: 1 }),
      ],
    }),
    { maxToolCallsPerWake: 2 },
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s);
    assert.equal(s.requests.length, 1);
    assert.equal(
      s.calls.filter((x) => x === 'get_group_member_list').length,
      2,
    );
  } finally {
    await s.bot.stop();
  }
});

test('invalid and disabled calls consume the same budget as valid calls', async () => {
  const s = setup(
    (round) =>
      round === 0
        ? {
            content: null,
            tool_calls: [
              {
                id: 'bad',
                type: 'function',
                function: { name: 'not_a_tool', arguments: '{' },
              } as any,
              call('get_group_members', { limit: 1 }),
            ],
          }
        : { content: null, tool_calls: [call('finish')] },
    { maxToolCallsPerWake: 2 },
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s);
    assert.equal(s.requests.length, 1);
    assert.equal(
      s.calls.filter((x) => x === 'get_group_member_list').length,
      1,
    );
  } finally {
    await s.bot.stop();
  }
});

test('custom wake timeout is independent of model request timeout', async () => {
  const s = setup(
    async () => {
      await delay(20);
      return {
        content: null,
        tool_calls: [call('get_group_members', { limit: 1 })],
      };
    },
    { maxToolCallsPerWake: 96, wakeTimeoutMs: 1000 },
  );
  try {
    await s.bot.receive(event(), self);
    await settle(s);
    assert.ok(s.requests.length >= 1);
  } finally {
    await s.bot.stop();
  }
});
