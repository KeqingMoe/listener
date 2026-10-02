import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setTimeout as delay,
  setImmediate as flush,
} from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import { GroupRouter } from '../../../src/app/group-router.ts';
import { TurnScheduler } from '../../../src/agent/scheduler.ts';
import { OWNER_ID, LISTENER_GROUP } from '../../../src/contracts/identity.ts';
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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureLogging,
  observeLogs,
} from '../../../src/observability/logger.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

// 会话模式不再注入批次载荷；批次组成从每轮turn.start日志的计数观察。
const logDirectory = mkdtempSync(join(tmpdir(), 'multigroup-log-'));
const logger = configureLogging({
  level: 'info',
  console: false,
  file: false,
  directory: logDirectory,
  retentionDays: 7,
  maxFileMb: 1,
  maxTotalMb: 2,
});
process.once('exit', () =>
  rmSync(logDirectory, { recursive: true, force: true }),
);

test.after(() => logger.close());
type TurnLog = { count: number; direct: number };
let turnLogs = new Map<string, TurnLog[]>();
observeLogs((record) => {
  if (record.event !== 'turn.start') {
    return;
  }
  const group = String(record.fields.group_id);
  const list = turnLogs.get(group) ?? [];
  list.push({
    count: Number(record.fields.count),
    direct: Number(record.fields.direct_count),
  });
  turnLogs.set(group, list);
});

const SELF = '99999';
const A = '22',
  B = '33',
  C = '44';
const config: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 8,
  delayMaxMs: 8,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
  randomCooldownMs: 0,
  randomMaxPerMinute: 10,
};

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('cancelled', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

const tool = (
  name: string,
  args: unknown = name === 'finish' ? { mode: 'hard' } : {},
): Completion => ({
  content: null,
  tool_calls: [
    {
      id: 'call',
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const silent = () => tool('finish');
const reply = (text: string, replyTo?: string): Completion => ({
  content: null,
  tool_calls: [
    {
      id: 'send',
      type: 'function',
      function: {
        name: 'send_message',
        arguments: JSON.stringify({
          segments: [{ type: 'text', text }],
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      },
    },
    {
      id: 'finish',
      type: 'function',
      function: { name: 'finish', arguments: '{"mode":"hard"}' },
    },
  ],
});

function event(
  groupId: string,
  id: string,
  direct = true,
  text = `body-${groupId}-${id}`,
  userId = '12345',
  replyTo?: string,
) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    self_id: SELF,
    user_id: userId,
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: `member-${groupId}` },
    message: [
      ...(direct ? [{ type: 'at', data: { qq: SELF } }] : []),
      ...(replyTo ? [{ type: 'reply', data: { id: replyTo } }] : []),
      { type: 'text', data: { text } },
    ],
  };
}

class TestMemory implements Memory {
  entries: TimelineEntry[] = [];
  closed = false;
  clears = 0;
  compactHook: (model: Model, signal?: AbortSignal) => Promise<void> =
    async () => {};

  append(entry: TimelineEntry) {
    if (this.closed) {
      throw new Error('write after close');
    }
    if (this.find(entry.messageId)) {
      return false;
    }
    this.entries.push(structuredClone(entry));
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

  compact(model: Model, signal?: AbortSignal) {
    return this.compactHook(model, signal);
  }

  clear() {
    this.clears++;
    this.entries = [];
  }

  close() {
    this.closed = true;
  }
}

type Request = {
  group: string;
  phase: 'summary' | 'conversation';
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  index: number;
};

function setup(
  options: {
    groups?: string[];
    concurrency?: number;
    connected?: boolean;
    settings?: Record<string, Partial<ListenerConfig>>;
    complete?: (request: Request) => Promise<Completion> | Completion;
    api?: Api['call'];
  } = {},
) {
  const ids = options.groups ?? [A, B];
  turnLogs = new Map();
  const scheduler = new TurnScheduler(options.concurrency ?? 2);
  const memories = new Map(ids.map((id) => [id, new TestMemory()]));
  const listeners = new Map<string, Listener>();
  const requests: Request[] = [];
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const indices = new Map<string, number>();
  let activeModels = 0,
    maxActiveModels = 0;
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      if (options.api) {
        return options.api(action, params);
      }
      if (action === 'send_group_msg') {
        return { message_id: String(90000 + calls.length) };
      }
      throw new Error('unexpected API action');
    },
  };
  const model: Model = {
    async complete(messages, tools = [], signal) {
      const system = String(messages[0]?.content ?? '');
      const group =
        /本轮只服务群 (\d+)/.exec(system)?.[1] ??
        /^summary:(\d+)$/.exec(system)?.[1];
      assert.ok(group, 'model request has an unambiguous group scope');
      const phase = system.startsWith('summary:') ? 'summary' : 'conversation';
      const key = group + ':' + phase;
      const index = indices.get(key) ?? 0;
      indices.set(key, index + 1);
      const request: Request = {
        group,
        phase,
        messages: structuredClone(messages),
        tools: structuredClone(tools),
        signal,
        index,
      };
      requests.push(request);
      activeModels++;
      maxActiveModels = Math.max(maxActiveModels, activeModels);
      try {
        return options.complete
          ? await options.complete(request)
          : reply(`reply-${group}`, '1');
      } finally {
        activeModels--;
      }
    },
  };
  for (const id of ids) {
    listeners.set(
      id,
      new Listener(
        api,
        model,
        memories.get(id)!,
        { ...config, ...options.settings?.[id], groupId: id },
        () => 0.5,
        undefined,
        scheduler,
        sessionRuntime(
          { ...config, ...options.settings?.[id], groupId: id }.groupId,
        ).runtime,
      ),
    );
  }
  const router = new GroupRouter(listeners);
  if (options.connected !== false) {
    router.setConnected(true);
  }
  return {
    router,
    scheduler,
    listeners,
    memories,
    requests,
    calls,
    model,
    get maxActiveModels() {
      return maxActiveModels;
    },
    async close() {
      try {
        await router.stop();
      } finally {
        scheduler.close();
      }
    },
  };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('multigroup condition timed out');
}

/** 请求所在那一轮的批次计数；这些用例每轮恰有一次模型请求。 */
const batchOf = (request: Request): TurnLog => {
  const log = turnLogs.get(request.group)?.[request.index];
  assert.ok(log, `missing turn.start for ${request.group}#${request.index}`);
  return log;
};
const roster = (request: Request) => batchOf(request).direct;
const sends = (s: ReturnType<typeof setup>) =>
  s.calls.filter((call) => call.action === 'send_group_msg');
const messageText = (call: { params: Record<string, unknown> }) =>
  (call.params.message as { type: string; data: { text?: string } }[])
    .filter((s) => s.type === 'text')
    .map((s) => s.data.text)
    .join('');

test('same message IDs are independent and routing ignores private, unknown and disconnected traffic', async () => {
  const s = setup({
    connected: false,
    complete: (r) =>
      r.index === 0
        ? tool('read_events', { limit: 10, types: ['message.created'] })
        : reply(`reply-${r.group}`, '1'),
  });
  try {
    await s.router.receive(event(A, '1'), SELF);
    assert.equal(s.memories.get(A)!.entries.length, 0);
    s.router.setConnected(true);
    await s.router.receive(event('55', '1'), SELF);
    await s.router.receive({ ...event(A, '1'), message_type: 'private' }, SELF);
    await s.router.receive(event(A, '1', true, 'only-in-A'), SELF);
    await s.router.receive(event(B, '1', true, 'only-in-B'), SELF);
    await until(() => sends(s).length === 2 && s.scheduler.activeCount === 0);
    assert.equal(s.requests.length, 4);
    assert.deepEqual(
      new Set(sends(s).map((c) => c.params.group_id)),
      new Set([A, B]),
    );
    // 读取结果只含本群消息，同号消息互不串群。
    for (const request of s.requests.filter((r) => r.index === 1)) {
      const encoded = JSON.stringify(request.messages);
      assert.ok(
        encoded.includes(request.group === A ? 'only-in-A' : 'only-in-B'),
      );
      assert.ok(
        !encoded.includes(request.group === A ? 'only-in-B' : 'only-in-A'),
      );
      assert.match(
        String(request.messages[0]!.content),
        new RegExp(`本轮只服务群 ${request.group}。`),
      );
      assert.equal(
        s.memories.get(request.group)!.find('1')?.text,
        `[at:${SELF}]${request.group === A ? 'only-in-A' : 'only-in-B'}`,
      );
    }
    await s.router.receive(event(A, '1'), SELF);
    await s.router.receive(event(B, '1'), SELF);
    await delay(25);
    assert.equal(s.requests.length, 4);
  } finally {
    await s.close();
  }
});

test('each group keeps its own persona, schemas and pending batch', async () => {
  const a = gate<Completion>(),
    b = gate<Completion>();
  const s = setup({
    settings: {
      [A]: {
        persona: 'STYLE_A',
        toolPermissions: toolPermissions({
          read_forward: 'direct',
          mute_member: { mode: 'off', maxSeconds: 10 },
        }),
        messageMentions: false,
        confirmationTtlSeconds: 10,
      },
      [B]: {
        persona: 'STYLE_B',
        toolPermissions: toolPermissions(MEMBER_TOOLS),
      },
    },
    complete: (r) =>
      r.index === 0
        ? abortable(r.group === A ? a.promise : b.promise, r.signal)
        : silent(),
  });
  try {
    await s.router.receive(event(A, '1'), SELF);
    await s.router.receive(event(B, '1'), SELF);
    await until(() => s.requests.length === 2);
    await s.router.receive(event(A, '2'), SELF);
    await s.router.receive(event(A, '3'), SELF);
    await s.router.receive(event(B, '2'), SELF);
    assert.ok(s.requests.every((r) => !r.signal?.aborted));
    const firstA = s.requests.find((r) => r.group === A)!,
      firstB = s.requests.find((r) => r.group === B)!;
    assert.ok(String(firstA.messages[0]!.content).includes('STYLE_A'));
    assert.ok(!String(firstA.messages[0]!.content).includes('STYLE_B'));
    assert.ok(String(firstB.messages[0]!.content).includes('STYLE_B'));
    assert.ok(
      !firstA.tools.some((t) => t.function.name === 'get_group_members'),
    );
    assert.ok(
      firstB.tools.some((t) => t.function.name === 'get_group_members'),
    );
    assert.ok(firstA.tools.some((t) => t.function.name === 'read_forward'));
    assert.ok(!firstB.tools.some((t) => t.function.name === 'read_forward'));
    a.resolve(silent());
    b.resolve(silent());
    await until(() => s.requests.length === 4 && s.scheduler.activeCount === 0);
    assert.deepEqual(
      roster(s.requests.find((r) => r.group === A && r.index === 1)!),
      2,
    );
    assert.deepEqual(
      roster(s.requests.find((r) => r.group === B && r.index === 1)!),
      1,
    );
  } finally {
    a.resolve(silent());
    b.resolve(silent());
    await s.close();
  }
});

test('reset clears and cancels only the issuing group while the other active reply completes', async () => {
  const hold = gate<Completion>();
  const s = setup({ complete: (r) => abortable(hold.promise, r.signal) });
  try {
    await s.router.receive(event(A, '1'), SELF);
    await s.router.receive(event(B, '1'), SELF);
    await until(() => s.requests.length === 2);
    await s.router.receive(event(A, '90', false, '/reset', OWNER_ID), SELF);
    assert.equal(s.memories.get(A)!.clears, 1);
    assert.equal(s.memories.get(B)!.clears, 0);
    assert.ok(s.requests.find((r) => r.group === A)!.signal!.aborted);
    assert.equal(s.requests.find((r) => r.group === B)!.signal!.aborted, false);
    hold.resolve(reply('surviving reply'));
    await until(() => s.scheduler.activeCount === 0);
    assert.deepEqual(
      sends(s)
        .filter((c) => messageText(c) === 'surviving reply')
        .map((c) => c.params.group_id),
      [B],
    );
    assert.ok(
      !s.memories.get(A)!.entries.some((e) => e.text === 'surviving reply'),
    );
    assert.ok(
      s.memories.get(B)!.entries.some((e) => e.text === 'surviving reply'),
    );
  } finally {
    hold.resolve(silent());
    await s.close();
  }
});

test('concurrency one seals a waiting group only after admission, merging every queued caller', async () => {
  const a = gate<Completion>();
  const s = setup({
    concurrency: 1,
    complete: (r) =>
      r.group === A ? abortable(a.promise, r.signal) : silent(),
  });
  try {
    await s.router.receive(event(A, '1'), SELF);
    await until(() => s.requests.length === 1);
    await s.router.receive(event(B, '1'), SELF);
    await until(() => s.scheduler.waitingCount === 1);
    await s.router.receive(event(B, '2'), SELF);
    await s.router.receive(event(B, '3'), SELF);
    assert.equal(s.requests.length, 1);
    assert.equal(s.scheduler.activeCount, 1);
    a.resolve(silent());
    await until(() => s.requests.length === 2 && s.scheduler.activeCount === 0);
    assert.equal(s.requests[1]!.group, B);
    assert.equal(roster(s.requests[1]!), 3);
    assert.equal(s.maxActiveModels, 1);
  } finally {
    a.resolve(silent());
    await s.close();
  }
});

test('a busy group cannot jump ahead of other groups already waiting for the global slot', async () => {
  const first = gate<Completion>();
  const s = setup({
    groups: [A, B, C],
    concurrency: 1,
    complete: (r) =>
      r.group === A && r.index === 0
        ? abortable(first.promise, r.signal)
        : silent(),
  });
  try {
    await s.router.receive(event(A, '1'), SELF);
    await until(() => s.requests.length === 1);
    await s.router.receive(event(B, '1'), SELF);
    await until(() => s.scheduler.waitingCount === 1);
    await s.router.receive(event(C, '1'), SELF);
    await until(() => s.scheduler.waitingCount === 2);
    await s.router.receive(event(A, '2'), SELF);
    first.resolve(silent());
    await until(() => s.requests.length === 4 && s.scheduler.activeCount === 0);
    assert.deepEqual(
      s.requests.map((r) => r.group),
      [A, B, C, A],
    );
    assert.equal(roster(s.requests[3]!), 1);
  } finally {
    first.resolve(silent());
    await s.close();
  }
});

for (const action of ['reset', 'disconnect', 'stop'] as const) {
  test(`queued group ${action} removes only its own admission and never sends a stale reply`, async () => {
    const a = gate<Completion>();
    const s = setup({
      groups: [A, B, C],
      concurrency: 1,
      complete: (r) =>
        r.group === A
          ? abortable(a.promise, r.signal)
          : reply('fresh-' + r.group),
    });
    try {
      await s.router.receive(event(A, '1'), SELF);
      await until(() => s.requests.length === 1);
      await s.router.receive(event(B, '1'), SELF);
      await until(() => s.scheduler.waitingCount === 1);
      await s.router.receive(event(C, '1'), SELF);
      await until(() => s.scheduler.waitingCount === 2);
      if (action === 'reset') {
        await s.router.receive(event(B, '99', false, '/reset', OWNER_ID), SELF);
      } else if (action === 'disconnect') {
        s.listeners.get(B)!.setConnected(false);
      } else {
        await s.listeners.get(B)!.stop();
      }
      await until(() => s.scheduler.waitingCount === 1);
      assert.equal(s.requests[0]!.signal?.aborted, false);
      a.resolve(silent());
      await until(
        () => s.scheduler.activeCount === 0 && s.requests.length === 2,
      );
      assert.deepEqual(
        s.requests.map((r) => r.group),
        [A, C],
      );
      assert.ok(!sends(s).some((c) => messageText(c) === 'fresh-' + B));
      assert.ok(
        !s.memories.get(B)!.entries.some((e) => e.text === 'fresh-' + B),
      );
    } finally {
      a.resolve(silent());
      await s.close();
    }
  });
}

test('global concurrency two covers conversation requests without obsolete summaries', async () => {
  let summaries = 0;
  const a = gate<Completion>(),
    b = gate<Completion>();
  const s = setup({
    groups: [A, B, C],
    concurrency: 2,
    complete: (r) =>
      r.group === A
        ? abortable(a.promise, r.signal)
        : r.group === B
          ? abortable(b.promise, r.signal)
          : silent(),
  });
  for (const memory of s.memories.values()) {
    memory.compactHook = async () => {
      summaries++;
      throw new Error('obsolete_summary');
    };
  }
  try {
    await s.router.receive(event(A, '1'), SELF);
    await s.router.receive(event(B, '1'), SELF);
    await until(() => s.requests.length === 2);
    assert.deepEqual(new Set(s.requests.map((r) => r.group)), new Set([A, B]));
    assert.ok(s.requests.every((r) => r.phase === 'conversation'));
    await s.router.receive(event(C, '1'), SELF);
    await until(() => s.scheduler.waitingCount === 1);
    assert.equal(s.scheduler.activeCount, 2);
    a.resolve(silent());
    await until(() =>
      s.requests.some((r) => r.group === C && r.phase === 'conversation'),
    );
    assert.equal(s.requests.find((r) => r.group === B)!.signal?.aborted, false);
    b.resolve(silent());
    await until(() => s.scheduler.activeCount === 0);
    assert.equal(s.maxActiveModels, 2);
    assert.equal(s.requests.length, 3);
    assert.equal(summaries, 0);
  } finally {
    a.resolve(silent());
    b.resolve(silent());
    await s.close();
  }
});

test('a failed active model releases its permit for another group', async () => {
  const first = gate<Completion>();
  const s = setup({
    concurrency: 1,
    complete: async (r) => {
      if (r.group === A) {
        await abortable(first.promise, r.signal);
        throw new Error('simulated provider failure');
      }
      return reply('B survived');
    },
  });
  try {
    await s.router.receive(event(A, '1'), SELF);
    await until(() => s.requests.length === 1);
    await s.router.receive(event(B, '1'), SELF);
    await until(() => s.scheduler.waitingCount === 1);
    first.resolve(silent());
    await until(() => s.scheduler.activeCount === 0 && sends(s).length === 1);
    assert.equal(sends(s)[0]!.params.group_id, B);
    assert.equal(messageText(sends(s)[0]!), 'B survived');
  } finally {
    first.resolve(silent());
    await s.close();
  }
});

test('foreign quote lookup cannot become a trigger or authorize a read in another group', async () => {
  const s = setup({
    api: async (action) => {
      assert.equal(action, 'get_msg');
      return {
        message_type: 'group',
        group_id: B,
        message_id: '777',
        sender: { user_id: SELF },
        message: [{ type: 'text', data: { text: 'foreign secret' } }],
      };
    },
    complete: (r) =>
      r.index === 0 ? tool('read_message', { message_id: '777' }) : silent(),
  });
  try {
    await s.router.receive(
      event(A, '1', false, 'quote unknown', '12345', '777'),
      SELF,
    );
    await delay(25);
    assert.equal(s.requests.length, 0);
    await s.router.receive(
      event(A, '2', true, 'check quote', '12345', '777'),
      SELF,
    );
    await until(() => s.requests.length === 2 && s.scheduler.activeCount === 0);
    const result = JSON.parse(
      s.requests[1]!.messages.find((m) => m.role === 'tool')!.content as string,
    );
    assert.equal(result.status, 'error');
    assert.ok(!JSON.stringify(s.requests).includes('foreign secret'));
    assert.equal(s.memories.get(B)!.entries.length, 0);
    assert.equal(s.calls.length, 2);
  } finally {
    await s.close();
  }
});

test('router stop cancels active and queued groups and leaves no scheduler permits or late writes', async () => {
  const hold = gate<Completion>();
  const s = setup({
    groups: [A, B, C],
    concurrency: 1,
    complete: (r) => abortable(hold.promise, r.signal),
  });
  try {
    await s.router.receive(event(A, '1'), SELF);
    await until(() => s.requests.length === 1);
    await s.router.receive(event(B, '1'), SELF);
    await s.router.receive(event(C, '1'), SELF);
    await until(() => s.scheduler.waitingCount === 2);
    await s.router.stop();
    assert.equal(s.scheduler.activeCount, 0);
    assert.equal(s.scheduler.waitingCount, 0);
    hold.resolve(reply('must never send'));
    await flush();
    assert.equal(sends(s).length, 0);
    assert.ok([...s.memories.values()].every((m) => m.closed));
    await s.router.receive(event(A, '2'), SELF);
    assert.equal(s.memories.get(A)!.find('2'), undefined);
  } finally {
    hold.resolve(silent());
    await s.close();
  }
});

test('elapsed queued window starts immediately after grant, without another full collection delay', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const first = gate<Completion>();
  const s = setup({
    concurrency: 1,
    settings: {
      [A]: { debounceMs: 100, delayMaxMs: 100 },
      [B]: { debounceMs: 100, delayMaxMs: 100 },
    },
    complete: (r) =>
      r.group === A ? abortable(first.promise, r.signal) : silent(),
  });
  try {
    await s.router.receive(event(A, '1'), SELF);
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.requests.length, 1);
    await s.router.receive(event(B, '1'), SELF);
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.scheduler.waitingCount, 1);
    t.mock.timers.tick(500);
    await s.router.receive(event(B, '2'), SELF);
    first.resolve(silent());
    await flush();
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(roster(s.requests[1]!), 2);
  } finally {
    first.resolve(silent());
    await flush();
    await s.close();
    t.mock.timers.reset();
  }
});

test('first at during queued random batch gets its remaining window and releases the early grant', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const first = gate<Completion>();
  const s = setup({
    concurrency: 1,
    settings: {
      [A]: { debounceMs: 100, delayMaxMs: 100 },
      [B]: { debounceMs: 100, delayMaxMs: 100, randomReplyProbability: 1 },
    },
    complete: (r) =>
      r.group === A ? abortable(first.promise, r.signal) : silent(),
  });
  try {
    await s.router.receive(event(A, '1'), SELF);
    t.mock.timers.tick(100);
    await flush();
    await s.router.receive(event(B, '1', false), SELF);
    t.mock.timers.tick(100);
    await flush();
    assert.equal(s.scheduler.waitingCount, 1);
    await s.router.receive(event(B, '2'), SELF);
    first.resolve(silent());
    await flush();
    await flush();
    assert.equal(s.requests.length, 1);
    assert.equal(s.scheduler.activeCount, 0);
    t.mock.timers.tick(99);
    await flush();
    assert.equal(s.requests.length, 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(s.requests.length, 2);
    // 随机消息1与直呼消息2合并为一轮，其中只有2是直呼。
    assert.deepEqual(batchOf(s.requests[1]!), { count: 2, direct: 1 });
  } finally {
    first.resolve(silent());
    await flush();
    await s.close();
    t.mock.timers.reset();
  }
});
