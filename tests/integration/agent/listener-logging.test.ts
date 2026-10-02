import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import { ModelError } from '../../../src/model/chat.ts';
import { OneBotError } from '../../../src/onebot/client.ts';
import {
  configureLogging,
  managedLogFilename,
} from '../../../src/observability/logger.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import {
  type TimelineEntry,
  type Memory,
} from '../../../src/contracts/messages.ts';
import { type Model, type Completion } from '../../../src/contracts/model.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const secret = 'NEVER_LOG_CHAT_BODY_OR_ARGUMENTS';
const self = '999';
const cfg: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 5,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
};
const completion = (
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
const sendAndFinish = (): Completion => ({
  content: null,
  tool_calls: [
    ...completion('send_message', {
      segments: [{ type: 'text', text: secret }],
    }).tool_calls,
    ...completion('finish').tool_calls.map((c) => ({ ...c, id: 'finish' })),
  ],
});
const event = (
  messageId: string,
  actor = '123',
  text = secret,
  mention = true,
) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: LISTENER_GROUP,
  self_id: self,
  user_id: actor,
  message_id: messageId,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: secret },
  message: [
    ...(mention ? [{ type: 'at', data: { qq: self } }] : []),
    { type: 'text', data: { text } },
  ],
});

async function until(predicate: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error('Test timed out');
}

function setup(
  respond: (
    n: number,
    signal?: AbortSignal,
  ) => Promise<Completion> | Completion,
  sendFail = false,
  options: Partial<ListenerConfig> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'listener-trace-'));
  const logger = configureLogging(
    {
      level: 'debug',
      console: false,
      file: true,
      directory,
      retentionDays: 7,
      maxFileMb: 1,
      maxTotalMb: 2,
    },
    ['configured-key'],
  );
  const entries: TimelineEntry[] = [];
  let requests = 0;
  const memory: Memory = {
    append(e) {
      if (entries.some((x) => x.messageId === e.messageId)) {
        return false;
      }
      entries.push(e);
      return true;
    },
    recent: () => entries,
    find: (id) => entries.find((e) => e.messageId === id),
    context: () => JSON.stringify(entries),
    async compact() {},
    clear() {
      entries.length = 0;
    },
    close() {},
  };
  const api: Api = {
    async call(action) {
      if (action === 'send_group_msg') {
        if (sendFail) {
          throw new OneBotError('timeout');
        }
        return { message_id: '1000' };
      }
      throw new Error(secret);
    },
  };
  const model: Model = {
    async complete(_messages, _tools, signal) {
      return respond(++requests, signal);
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    { ...cfg, ...options },
    undefined,
    undefined,
    undefined,
    sessionRuntime({ ...cfg, ...options }.groupId).runtime,
  );
  return {
    bot,
    entries,
    get requests() {
      return requests;
    },
    async records() {
      await logger.flush();
      return readdirSync(directory)
        .filter(managedLogFilename)
        .flatMap((name) =>
          readFileSync(join(directory, name), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
    },
    async close() {
      await bot.stop();
      await logger.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('reply trace correlates trigger/model tool/send/end without text or arguments', async () => {
  const s = setup(() => sendAndFinish());
  try {
    await s.bot.receive(event('1'), self);
    await until(() => s.entries.some((e) => e.bot));
    const rows = await s.records();
    const start = rows.find((x) => x.event === 'turn.start');
    assert.match(start.turn_id, /^t_[a-f0-9]{16}$/);
    for (const name of [
      'trigger.accepted',
      'tool.start',
      'tool.complete',
      'send.start',
      'send.complete',
      'turn.end',
    ]) {
      assert.ok(
        rows.some((x) => x.event === name && x.turn_id === start.turn_id),
        name,
      );
    }
    assert.equal(rows.find((x) => x.event === 'turn.end').outcome, 'replied');
    assert.equal(rows.find((x) => x.event === 'turn.end').sent_messages, 1);
    assert.ok(!JSON.stringify(rows).includes(secret));
  } finally {
    await s.close();
  }
});

test('silent, prose suppressed, model failure and shared tool budget exhaustion are distinct outcomes', async () => {
  for (const [respond, outcome, reason] of [
    [() => completion('finish'), 'silent', undefined],
    [
      () => ({ content: secret, tool_calls: [] }),
      'prose_suppressed',
      undefined,
    ],
    [
      () => {
        throw new ModelError('http_error', 503);
      },
      'model_failed',
      'http_error',
    ],
    [
      () => completion('invented_secret_tool', { body: secret }),
      'tool_budget_exhausted',
      undefined,
    ],
  ] as const) {
    const s = setup(respond, false, { maxToolCallsPerWake: 3 });
    try {
      await s.bot.receive(event('1'), self);
      await until(() => s.requests > 0 && !(s.bot as any).running);
      const rows = await s.records();
      const end = rows.find((x) => x.event === 'turn.end');
      assert.equal(end.outcome, outcome);
      assert.equal(end.reason, reason);
      if (outcome === 'tool_budget_exhausted') {
        assert.equal(s.requests, 3);
        assert.equal(end.tool_calls, 3);
        assert.equal(end.model_rounds, 3);
        assert.equal(end.tool_calls_limit, 3);
      }
      assert.ok(!JSON.stringify(rows).includes(secret));
      assert.ok(!JSON.stringify(rows).includes('invented_secret_tool'));
    } finally {
      await s.close();
    }
  }
});

test('uncertain send records unknown tool result and explicit finish never retries', async () => {
  const s = setup(() => sendAndFinish(), true);
  try {
    await s.bot.receive(event('1'), self);
    await until(() => s.requests > 0 && !(s.bot as any).running);
    const rows = await s.records();
    assert.equal(rows.filter((x) => x.event === 'send.start').length, 1);
    assert.equal(rows.find((x) => x.event === 'send.failed').reason, 'timeout');
    assert.ok(
      rows.some(
        (x) =>
          x.event === 'tool.complete' &&
          x.tool === 'send_message' &&
          x.status === 'unknown',
      ),
    );
    assert.equal(rows.find((x) => x.event === 'turn.end').outcome, 'silent');
    assert.equal(rows.find((x) => x.event === 'turn.end').sent_messages, 0);
  } finally {
    await s.close();
  }
});

test('new direct message waits for active reply and receives a distinct next-batch trace', async () => {
  let resolveFirst!: (value: Completion) => void;
  const s = setup((n) =>
    n === 1
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : completion('finish'),
  );
  try {
    await s.bot.receive(event('1'), self);
    await until(() => s.requests === 1);
    await s.bot.receive(event('2'), self);
    resolveFirst(sendAndFinish());
    await until(() => s.requests === 2 && !(s.bot as any).running);
    const rows = await s.records();
    const ends = rows.filter((x) => x.event === 'turn.end');
    assert.equal(ends.length, 2);
    assert.equal(ends[0].outcome, 'replied');
    assert.equal(ends[0].reason, undefined);
    assert.equal(ends[1].outcome, 'silent');
    assert.notEqual(ends[0].turn_id, ends[1].turn_id);
    assert.equal(rows.filter((x) => x.event === 'send.start').length, 1);
    assert.equal(
      rows.find((x) => x.event === 'send.start').turn_id,
      ends[0].turn_id,
    );
    assert.ok(
      rows.findIndex(
        (x) => x.event === 'turn.end' && x.turn_id === ends[0].turn_id,
      ) <
        rows.findIndex(
          (x) => x.event === 'turn.start' && x.turn_id === ends[1].turn_id,
        ),
    );
    assert.ok(!JSON.stringify(rows).includes(secret));
  } finally {
    await s.close();
  }
});

test('pending merge is visible; debug skip and command identity contain no command body', async () => {
  const s = setup(() => completion('finish'), false, { debounceMs: 30 });
  try {
    await s.bot.receive(event('1'), self);
    await s.bot.receive(event('2'), self);
    await until(() => s.requests === 1 && !(s.bot as any).running);
    await s.bot.receive(event('3', '123', secret, false), self);
    await s.bot.receive(
      event('4', OWNER_ID, '/confirm ' + 'a'.repeat(32)),
      self,
    );
    const rows = await s.records();
    assert.ok(rows.some((x) => x.event === 'trigger.merged'));
    assert.ok(!rows.some((x) => x.event === 'trigger.dropped'));
    assert.equal(rows.filter((x) => x.event === 'trigger.accepted').length, 1);
    assert.equal(
      rows.find((x) => x.event === 'trigger.merged').turn_id,
      rows.find((x) => x.event === 'trigger.accepted').turn_id,
    );
    assert.ok(
      rows.some(
        (x) =>
          x.event === 'trigger.skipped' && x.reason === 'random_not_selected',
      ),
    );
    assert.ok(
      rows.some(
        (x) =>
          x.event === 'command.start' && /^c_[a-f0-9]{16}$/.test(x.command_id),
      ),
    );
    assert.ok(!JSON.stringify(rows).includes('a'.repeat(32)));
  } finally {
    await s.close();
  }
});
