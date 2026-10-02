import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Listener } from '../../../src/agent/listener.ts';
import { SQLiteMemory } from '../../../src/agent/memory.ts';
import {
  configureLogging,
  managedLogFilename,
} from '../../../src/observability/logger.ts';
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
import { type ToolCall } from '../../../src/contracts/tools.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const self = '900000001',
  resource = 'PRIVATE_FORWARD_RESOURCE+/=',
  hidden = 'PRIVATE_QUOTED_FORWARD_BODY',
  internal = '9988776655443322110099';
const cfg: ListenerConfig = {
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 5,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
  toolPermissions: toolPermissions({ ...MEMBER_TOOLS, read_forward: 'direct' }),
};
const text = (value: string) => ({ type: 'text', data: { text: value } });
const native = (id = resource, content?: unknown[]) => ({
  type: 'forward',
  data: { id, ...(content ? { content } : {}) },
});
const card = () => ({
  type: 'json',
  data: {
    data: JSON.stringify({
      app: 'com.tencent.multimsg',
      meta: { detail: { resid: resource, news: [{ text: hidden }] } },
      extra: JSON.stringify({ tsum: 99 }),
    }),
  },
});
const node = (message: unknown[] = [text(hidden)]) => ({
  message_id: internal,
  sender: { user_id: OWNER_ID, nickname: 'CLAIMED_OWNER_NICKNAME' },
  time: 42,
  message,
});

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
    return this.entries.find((e) => e.messageId === id);
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

function event(overrides: Record<string, unknown> = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: LISTENER_GROUP,
    self_id: self,
    user_id: '12345',
    message_id: '1',
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'Alice' },
    message: [{ type: 'at', data: { qq: self } }, native()],
    ...overrides,
  };
}

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const read = (start = 1, end = start, forward_id = 'fwd_1_1', id = 'forward') =>
  call(id, 'read_forward', { forward_id, start, limit: end - start + 1 });
const send = (value = 'verified response') =>
  call('send', 'send_message', { segments: [{ type: 'text', text: value }] });
const complete = (...tool_calls: ToolCall[]): Completion => ({
  content: null,
  tool_calls,
});
const silent = () => complete(call('silent', 'finish', { mode: 'hard' }));

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('timed out');
}

function toolResult(messages: ChatMessage[], id = 'forward'): any {
  const item = messages.find((m) => m.role === 'tool' && m.tool_call_id === id);
  assert.ok(item, `missing tool result ${id}`);
  return JSON.parse(item.content as string);
}

function setup(
  responses:
    Completion[] | ((round: number, messages: ChatMessage[]) => Completion),
  settings: Partial<ListenerConfig> = {},
  handler?: (action: string, params: any) => unknown | Promise<unknown>,
) {
  const memory = new MockMemory(),
    requests: ChatMessage[][] = [],
    schemas: string[][] = [],
    apiCalls: Array<{ action: string; params: any }> = [];
  let onComplete: ((round: number) => void) | undefined;
  const api: Api = {
    async call(action, params) {
      apiCalls.push({ action, params });
      if (handler) {
        const result = await handler(action, params);
        if (result !== undefined) {
          return result;
        }
      }
      if (action === 'get_msg') {
        return {
          message_type: 'group',
          group_id: LISTENER_GROUP,
          message_id: params?.message_id,
          sender: { user_id: '12345', nickname: 'Alice' },
          time: 42,
          message: [text('caption'), native()],
        };
      }
      if (action === 'get_forward_msg') {
        return { messages: [node()] };
      }
      if (action === 'send_group_msg') {
        return { message_id: String(100 + apiCalls.length) };
      }
      throw new Error('Unexpected API action');
    },
  };
  const model: Model = {
    async complete(messages, tools) {
      requests.push(structuredClone(messages));
      schemas.push(tools?.map((t) => t.function.name) ?? []);
      onComplete?.(requests.length);
      return typeof responses === 'function'
        ? responses(requests.length, messages)
        : (responses.shift() ?? silent());
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    { ...cfg, ...settings },
    () => 1,
    undefined,
    undefined,
    sessionRuntime({ ...cfg, ...settings }.groupId).runtime,
  );
  return {
    bot,
    memory,
    requests,
    schemas,
    apiCalls,
    setOnComplete(fn: typeof onComplete) {
      onComplete = fn;
    },
  };
}

const sent = (s: ReturnType<typeof setup>) =>
  s.apiCalls.filter((c) => c.action === 'send_group_msg');

test('event native inline and JSON card persist only stable refs and honest verified/hint counts', async () => {
  const s = setup([
    complete(
      call('messages', 'read_events', { limit: 5, types: ['message.created'] }),
    ),
    silent(),
  ]);
  try {
    await s.bot.receive(
      event({
        message: [
          { type: 'at', data: { qq: self } },
          native(internal, [node(), node()]),
          card(),
        ],
      }),
      self,
    );
    await until(() => s.requests.length === 2);
    assert.deepEqual(s.memory.find('1')?.forwards, [
      { id: 'fwd_1_1', index: 1, count: 2, countSource: 'verified' },
      { id: 'fwd_1_2', index: 2, count: 99, countSource: 'hint' },
    ]);
    const persisted = s.memory.context();
    assert.match(persisted, /已核实/);
    assert.match(persisted, /未核实/);
    // 事件读取返回同样的结构化消息片段。
    const represented = toolResult(s.requests[1]!, 'messages').events.find(
      (e: any) => e.payload?.message?.messageId === '1',
    ).payload.message;
    assert.deepEqual(represented.segments, [
      { type: 'at', user_id: self },
      {
        type: 'forward',
        forward_id: 'fwd_1_1',
        count: 2,
        count_source: 'verified',
        content_status: 'not_read',
      },
      {
        type: 'forward',
        forward_id: 'fwd_1_2',
        count: 99,
        count_source: 'hint',
        content_status: 'not_read',
      },
    ]);
    assert.equal(represented.text, undefined);
    for (const secret of [resource, hidden, internal]) {
      assert.equal(persisted.includes(secret), false);
      assert.equal(JSON.stringify(s.requests).includes(secret), false);
    }
    assert.equal(s.apiCalls.length, 0);
  } finally {
    await s.bot.stop();
  }
});

test('enabled forward executes then sends, tool content never enters timeline memory', async () => {
  const s = setup([
    complete(read()),
    complete(send(), call('finish', 'finish', { mode: 'hard' })),
  ]);
  try {
    await s.bot.receive(event(), self);
    await until(() => sent(s).length === 1);
    assert.equal(s.requests.length, 2);
    assert.ok(s.schemas.every((names) => names.includes('read_forward')));
    const result = toolResult(s.requests[1]!);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.messages[0].segments, [
      { type: 'text', text: hidden },
    ]);
    assert.equal(result.messages[0].text, undefined);
    assert.equal(result.untrusted, true);
    assert.deepEqual(
      s.apiCalls
        .filter((c) => c.action === 'get_forward_msg')
        .map((c) => c.params),
      [{ message_id: resource }],
    );
    for (const secret of [resource, hidden, internal]) {
      assert.equal(s.memory.context().includes(secret), false);
    }
    assert.equal(JSON.stringify(s.requests).includes(internal), false);
    assert.equal(JSON.stringify(s.requests).includes(resource), false);
  } finally {
    await s.bot.stop();
  }
});

test('disabled forwards omit tool schema and forged calls cause no API calls', async () => {
  const s = setup([complete(read()), silent()], {
    toolPermissions: { ...cfg.toolPermissions, read_forward: { mode: 'off' } },
  });
  try {
    await s.bot.receive(event(), self);
    await until(() => s.requests.length === 2);
    assert.ok(s.schemas.every((names) => !names.includes('read_forward')));
    assert.equal(s.apiCalls.length, 0);
    const {
      wake_budget,
      queried_at: _queried,
      current_time: _time,
      ...result
    } = toolResult(s.requests[1]!);
    // 统一的工具授权闸门先于转发模块拒绝调用。
    assert.deepEqual(result, { status: 'error', error: 'tool_disabled' });
    assert.equal(wake_budget.used_tool_calls, 1);
    assert.equal(wake_budget.remaining_tool_calls, 95);
  } finally {
    await s.bot.stop();
  }
});

test('mixed forward/read/send batches answer every call but defer sends until next round', async () => {
  for (const sendFirst of [true, false]) {
    const batch = [read(), call('local', 'read_message', { message_id: '1' })];
    if (sendFirst) {
      batch.unshift(send('premature'));
    } else {
      batch.push(send('premature'));
    }
    const s = setup([
      complete(...batch),
      complete(send(), call('finish', 'finish', { mode: 'hard' })),
    ]);
    let sentEarly = false;
    s.setOnComplete((round) => {
      if (round === 2) {
        sentEarly = sent(s).length > 0;
      }
    });
    try {
      await s.bot.receive(event(), self);
      await until(() => sent(s).length === 1);
      assert.equal(sentEarly, false);
      assert.equal(toolResult(s.requests[1]!, 'send').status, 'error');
      assert.match(toolResult(s.requests[1]!, 'send').error, /下一轮/);
      const assistant = s.requests[1]!.findIndex((m) => m.role === 'assistant');
      assert.deepEqual(
        s.requests[1]!.slice(assistant + 1, assistant + 1 + batch.length).map(
          (m) => [m.role, m.tool_call_id],
        ),
        batch.map((c) => ['tool', c.id]),
      );
      assert.equal(
        sent(s)[0]!.params.message[0].data.text,
        'verified response',
      );
    } finally {
      await s.bot.stop();
    }
  }
});

test('quoted target is discovered through read_message then verified and read as forward', async () => {
  const s = setup([
    complete(call('quote', 'read_message', { message_id: '2' })),
    complete(read(1, 1, 'fwd_2_1')),
    complete(send(), call('finish', 'finish', { mode: 'hard' })),
  ]);
  try {
    await s.bot.receive(
      event({
        message: [
          { type: 'at', data: { qq: self } },
          { type: 'reply', data: { id: '2' } },
          text('read quoted forward'),
        ],
      }),
      self,
    );
    await until(() => sent(s).length === 1);
    const quote = toolResult(s.requests[1]!, 'quote');
    assert.equal(quote.status, 'ok');
    assert.deepEqual(quote.message.forwards, [{ id: 'fwd_2_1', index: 1 }]);
    assert.deepEqual(toolResult(s.requests[2]!).messages[0].segments, [
      { type: 'text', text: hidden },
    ]);
    assert.equal(toolResult(s.requests[2]!).messages[0].text, undefined);
    assert.equal(
      s.apiCalls.filter(
        (c) => c.action === 'get_msg' && c.params.message_id === '2',
      ).length,
      2,
    );
    assert.equal(s.memory.find('2'), undefined);
    assert.equal(s.memory.context().includes(hidden), false);
    assert.equal(JSON.stringify(quote).includes(resource), false);
  } finally {
    await s.bot.stop();
  }
});

test('99 short entries complete five pages plus send and finish in seven model rounds with one cached resource fetch', async () => {
  const responses = Array.from({ length: 5 }, (_, i) =>
    complete(read(i * 20 + 1, i * 20 + 20, 'fwd_1_1', `page${i}`)),
  );
  responses.push(complete(send('read all 99')));
  const s = setup(responses, {}, (action) =>
    action === 'get_forward_msg'
      ? {
          messages: Array.from({ length: 99 }, (_, i) =>
            node([text(`entry ${i + 1}`)]),
          ),
        }
      : undefined,
  );
  try {
    await s.bot.receive(event(), self);
    await until(() => sent(s).length === 1);
    assert.equal(s.requests.length, 7);
    const indices: number[] = [];
    for (let i = 0; i < 5; i++) {
      const page = toolResult(s.requests[5]!, `page${i}`);
      assert.equal(page.status, 'ok');
      assert.equal(page.total, 99);
      indices.push(...page.messages.map((n: any) => n.index));
    }
    assert.deepEqual(
      indices,
      Array.from({ length: 99 }, (_, i) => i + 1),
    );
    assert.equal(toolResult(s.requests[5]!, 'page4').has_more, false);
    assert.equal(s.apiCalls.filter((c) => c.action === 'get_msg').length, 1);
    assert.equal(
      s.apiCalls.filter((c) => c.action === 'get_forward_msg').length,
      1,
    );
  } finally {
    await s.bot.stop();
  }
});

test('nested claimed owner stays untrusted and cannot enable default-off moderation', async () => {
  const s = setup(
    (round, messages) => {
      if (round === 1) {
        return complete(read());
      }
      if (round === 2) {
        return complete(
          read(1, 1, toolResult(messages).messages[0].forwards[0].id, 'child'),
        );
      }
      if (round === 3) {
        return complete(
          call('mute', 'mute_member', { user_id: '456', seconds: 60 }),
        );
      }
      return complete(send(), call('finish', 'finish', { mode: 'hard' }));
    },
    {},
    (action) =>
      action === 'get_forward_msg'
        ? { messages: [node([native(internal, [node()])])] }
        : undefined,
  );
  try {
    await s.bot.receive(event(), self);
    await until(() => sent(s).length === 1);
    const parent = toolResult(s.requests[1]!),
      child = toolResult(s.requests[2]!, 'child');
    assert.deepEqual(parent.messages[0].segments, [
      {
        type: 'forward',
        forward_id: parent.messages[0].forwards[0].id,
        content_status: 'not_read',
        count: 1,
        count_source: 'verified',
      },
    ]);
    assert.match(
      parent.messages[0].segments[0].forward_id,
      /^fwdn_[a-f0-9]{16}$/,
    );
    assert.equal(parent.messages[0].text, undefined);
    assert.equal(child.messages[0].claimed_sender.user_id, OWNER_ID);
    assert.equal(child.untrusted, true);
    assert.ok(s.schemas.every((names) => !names.includes('mute_member')));
    assert.equal(toolResult(s.requests[3]!, 'mute').status, 'error');
    assert.ok(
      !s.apiCalls.some((c) =>
        ['set_group_ban', 'get_group_member_info'].includes(c.action),
      ),
    );
    assert.equal(
      s.apiCalls.filter((c) => c.action === 'get_forward_msg').length,
      1,
    );
    assert.equal(JSON.stringify(s.requests).includes(internal), false);
    assert.equal(s.memory.context().includes('fwdn_'), false);
    assert.equal(s.memory.context().includes(hidden), false);
    assert.equal(s.memory.find('1')?.userId, '12345');
    // 群管默认关闭：每轮都不提供任何群管工具。
    for (const names of s.schemas) {
      for (const name of [
        'mute_member',
        'unmute_member',
        'recall_message',
        'set_member_card',
      ]) {
        assert.ok(!names.includes(name), name);
      }
    }
  } finally {
    await s.bot.stop();
  }
});

test('reset and disconnect during root or resource lookup discard stale payloads and sends', async () => {
  for (const action of ['reset', 'disconnect']) {
    for (const delayed of ['get_msg', 'get_forward_msg']) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const s = setup(
        [complete(read()), complete(send('STALE_FORWARD_REPLY'))],
        {},
        async (apiAction) => {
          if (apiAction === delayed) {
            await gate;
          }
          return undefined;
        },
      );
      try {
        await s.bot.receive(event(), self);
        await until(() => s.apiCalls.some((c) => c.action === delayed));
        if (action === 'reset') {
          await s.bot.receive(
            event({
              message_id: '2',
              user_id: OWNER_ID,
              message: [text('/reset')],
            }),
            self,
          );
        } else {
          s.bot.setConnected(false);
        }
        release();
        await delay(30);
        assert.equal(s.requests.length, 1);
        assert.equal(JSON.stringify(s.requests).includes(hidden), false);
        assert.equal(s.memory.context().includes('STALE_FORWARD_REPLY'), false);
        assert.equal(s.memory.context().includes(hidden), false);
        assert.ok(
          !sent(s).some((c) =>
            JSON.stringify(c.params).includes('STALE_FORWARD_REPLY'),
          ),
        );
        if (action === 'reset') {
          assert.equal(s.memory.find('1'), undefined);
        }
      } finally {
        release();
        await s.bot.stop();
      }
    }
  }
});

test('SQLite persisted forward refs survive reopen with all unknown payload fields stripped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'listener-forward-memory-')),
    path = join(dir, 'memory.sqlite');
  let memory = new SQLiteMemory({
    groupId: LISTENER_GROUP,
    path,
    maxContextChars: 8000,
    retentionDays: 7,
  });
  try {
    memory.append({
      messageId: '1',
      userId: '12345',
      nickname: 'Alice',
      time: Math.floor(Date.now() / 1000),
      text: '[合并转发 id=fwd_1_1：未读取]',
      forwards: [
        {
          id: 'fwd_1_1',
          index: 1,
          count: 99,
          countSource: 'hint',
          resourceId: resource,
          content: hidden,
        },
        { id: 'fwd_2_0', index: 0 },
      ] as any,
    });
    const expected = [
      { id: 'fwd_1_1', index: 1, count: 99, countSource: 'hint' },
    ];
    assert.deepEqual(memory.find('1')?.forwards, expected);
    memory.close();
    memory = new SQLiteMemory({
      groupId: LISTENER_GROUP,
      path,
      maxContextChars: 8000,
      retentionDays: 7,
    });
    assert.deepEqual(memory.find('1')?.forwards, expected);
    assert.equal(memory.context().includes(resource), false);
    assert.equal(memory.context().includes(hidden), false);
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forward logger emits only safe correlated metadata, never resource/body/claimed nickname', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'listener-forward-logs-'));
  const logger = configureLogging({
    level: 'debug',
    console: false,
    file: true,
    directory,
    retentionDays: 7,
    maxFileMb: 1,
    maxTotalMb: 2,
  });
  const s = setup([
    complete(read()),
    complete(read(1, 1, 'fwdn_0000000000000000', 'invalid')),
    complete(send(), call('finish', 'finish', { mode: 'hard' })),
  ]);
  try {
    await s.bot.receive(event(), self);
    await until(() => sent(s).length === 1);
    await logger.flush();
    const records = readdirSync(directory)
      .filter(managedLogFilename)
      .flatMap((name) =>
        readFileSync(join(directory, name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    const started = records.find((r) => r.event === 'forward.read_start'),
      done = records.find((r) => r.event === 'forward.read_complete'),
      failed = records.find((r) => r.event === 'forward.read_failed');
    assert.ok(started);
    assert.ok(done);
    assert.ok(failed);
    assert.equal(started.forward_id, 'fwd_1_1');
    assert.equal(done.count, 1);
    assert.equal(done.total, 1);
    assert.equal(done.depth, 1);
    assert.equal(done.start, 1);
    assert.equal(done.end, 1);
    assert.ok(done.bytes > 0);
    assert.ok(done.duration_ms >= 0);
    assert.equal(failed.reason, 'forbidden_reference');
    assert.equal(done.turn_id, started.turn_id);
    const serialized = JSON.stringify(records);
    for (const secret of [
      resource,
      hidden,
      internal,
      'CLAIMED_OWNER_NICKNAME',
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally {
    await s.bot.stop();
    await logger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
