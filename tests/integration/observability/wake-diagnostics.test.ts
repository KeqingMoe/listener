import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeWakeDiagnostics } from '../../../src/observability/wake-diagnostics.ts';
import { ModelSession } from '../../../src/agent/session/store.ts';
import { WorldEventStore } from '../../../src/world/events.ts';
import { Listener } from '../../../src/agent/listener.ts';
import { ModelError } from '../../../src/model/chat.ts';
import { LISTENER_GROUP } from '../../../src/contracts/identity.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import { type Completion } from '../../../src/contracts/model.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';

const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const result = (...tool_calls: Completion['tool_calls']): Completion => ({
  content: null,
  tool_calls,
});
const journal = (session: ModelSession) =>
  JSON.parse(
    (session as any).db
      .prepare(
        "SELECT payload FROM model_session_journal WHERE kind='wake_finish' ORDER BY seq DESC LIMIT 1",
      )
      .get().payload,
  );

test('wake diagnostics allow only finite local codes and numeric counters without evaluating hostile values', () => {
  let reads = 0;
  const input = {
    reason_code: 'turn_timeout',
    duration_ms: 90000,
    sent_messages: 2,
    secret: 'PRIVATE',
    model_rounds: -1,
  };
  Object.defineProperty(input, 'tool_calls', {
    get() {
      reads++;
      throw new Error('PRIVATE');
    },
  });
  assert.deepEqual(normalizeWakeDiagnostics(input), {
    reason_code: 'turn_timeout',
    duration_ms: 90000,
    sent_messages: 2,
  });
  assert.equal(reads, 0);
  assert.deepEqual(
    normalizeWakeDiagnostics({
      reason_code: 'PRIVATE',
      sent_messages: Infinity,
      duration_ms: 1.5,
    }),
    {},
  );
  assert.deepEqual(
    normalizeWakeDiagnostics(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('PRIVATE');
          },
        },
      ),
    ),
    {},
  );
  assert.deepEqual(
    normalizeWakeDiagnostics(
      Object.create({ reason_code: 'reset', sent_messages: 1 }),
    ),
    {},
  );
});

test('wake outcome stays compatible while actual cause and facts are independently persisted', () => {
  const session = new ModelSession({
    model: 'main',
    path: ':memory:',
    groupId: LISTENER_GROUP,
  });
  try {
    session.beginWake('synthetic', [], { source: 'synthetic' });
    session.finishWake('partial_reply_cancelled', {
      reason_code: 'turn_timeout',
      duration_ms: 90000,
      model_rounds: 4,
      sent_messages: 2,
      wake_timeout_ms: 90000,
      secret: 'PRIVATE',
    });
    assert.deepEqual(journal(session), {
      reason: 'partial_reply_cancelled',
      reason_code: 'turn_timeout',
      duration_ms: 90000,
      model_rounds: 4,
      sent_messages: 2,
      wake_timeout_ms: 90000,
    });
    session.beginWake('synthetic', [], { source: 'synthetic' });
    session.finishWake();
    assert.deepEqual(journal(session), { reason: 'finished' });
  } finally {
    session.close();
  }
});

test('terminal cancellation cause reaches both started and not-started tool intents without claiming either succeeded', () => {
  const session = new ModelSession({
    model: 'main',
    path: ':memory:',
    groupId: LISTENER_GROUP,
  });
  try {
    session.beginWake('synthetic', [], { source: 'synthetic' });
    session.appendAssistant(
      result(call('one', 'send_message'), call('two', 'get_time')),
    );
    session.startTool('one');
    session.finishWake('cancelled', { reason_code: 'disconnected' });
    const results = session
      .messages()
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.parse(String(m.content)));
    assert.deepEqual(results, [
      {
        status: 'unknown',
        error: 'execution_result_unknown',
        reason: 'disconnected',
      },
      { status: 'skipped', error: 'disconnected' },
    ]);
  } finally {
    session.close();
  }
});

const config: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  enabled: true,
  debounceMs: 1,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
  wakeTimeoutMs: 1000,
  ownerId: '100000001',
};

async function until(check: () => boolean) {
  for (let i = 0; i < 600; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  throw new Error('fixture timeout');
}

function fixture(mode: 'timeout' | 'disconnect' | 'reset') {
  const session = new ModelSession({
      model: 'main',
      path: ':memory:',
      groupId: LISTENER_GROUP,
    }),
    world = new WorldEventStore({ path: ':memory:', groupId: LISTENER_GROUP });
  const entries: TimelineEntry[] = [];
  const memory: Memory = {
    append(e) {
      entries.push(e);
      return true;
    },
    recent: () => entries,
    find: (id) => entries.find((e) => e.messageId === id),
    context: () => '',
    async compact() {},
    clear() {
      entries.length = 0;
    },
    close() {},
  };
  let rounds = 0,
    sends = 0,
    abortReason: unknown;
  const bot: Listener = new Listener(
    {
      async call(action) {
        assert.equal(action, 'send_group_msg');
        sends++;
        return { message_id: String(100 + sends) };
      },
    },
    {
      async complete(_messages, _tools, signal) {
        rounds++;
        if (rounds === 1) {
          return result(
            call('send', 'send_message', {
              segments: [{ type: 'text', text: 'synthetic' }],
            }),
          );
        }
        return new Promise<Completion>((_resolve, reject) => {
          const abort = () => {
            abortReason = signal?.reason;
            if (mode === 'timeout') {
              (bot as any).cancelActive('shutdown');
            }
            reject(new ModelError('cancelled'));
          };
          if (signal?.aborted) {
            abort();
          } else {
            signal?.addEventListener('abort', abort, { once: true });
          }
        });
      },
    },
    memory,
    config,
    () => 0,
    undefined,
    undefined,
    { session, world },
  );
  return {
    bot,
    session,
    get rounds() {
      return rounds;
    },
    get sends() {
      return sends;
    },
    get abortReason() {
      return abortReason;
    },
  };
}

for (const mode of ['timeout', 'disconnect'] as const) {
  test(`listener persists ${mode} cause after a real synthetic send and preserves the first cancellation source`, async () => {
    const f = fixture(mode);
    try {
      await f.bot.receive(
        {
          post_type: 'message',
          message_type: 'group',
          group_id: LISTENER_GROUP,
          self_id: '999',
          user_id: '123',
          message_id: '1',
          time: Math.floor(Date.now() / 1000),
          sender: { nickname: 'fixture' },
          message: [
            { type: 'at', data: { qq: '999' } },
            { type: 'text', data: { text: 'synthetic' } },
          ],
        },
        '999',
      );
      await until(() => f.rounds === 2);
      if (mode === 'disconnect') {
        f.bot.setConnected(false);
      }
      await until(() => !f.session.state().wakeId);
      const detail = journal(f.session),
        expected = mode === 'timeout' ? 'turn_timeout' : 'disconnected';
      assert.equal(f.abortReason, expected);
      assert.equal(detail.reason, 'partial_reply_cancelled');
      assert.equal(detail.reason_code, expected);
      assert.equal(detail.sent_messages, 1);
      assert.equal(detail.model_rounds, 2);
      assert.equal(detail.tool_calls, 1);
      assert.equal(detail.wake_timeout_ms, 1000);
      assert.equal(f.sends, 1);
      assert.equal(
        JSON.parse(
          String(
            f.session.messages().find((m) => m.tool_call_id === 'send')
              ?.content,
          ),
        ).status,
        'ok',
      );
    } finally {
      await f.bot.stop();
    }
  });
}

test('a late old-scope completion cannot finish or settle tools in a new wake', () => {
  const session = new ModelSession({
    model: 'main',
    path: ':memory:',
    groupId: LISTENER_GROUP,
  });
  try {
    session.beginWake('synthetic', []);
    const old = session.state();
    session.reset('owner_reset');
    const reset = journal(session);
    assert.equal(reset.reason, 'session_reset');
    assert.equal(reset.reason_code, 'reset');
    session.beginWake('synthetic', []);
    const current = session.state();
    session.appendAssistant(result(call('new', 'get_time')));
    session.skipPending('operation_failed', old);
    session.finishWake(
      'cancelled',
      { reason_code: 'reset', sent_messages: 99 },
      old,
    );
    assert.equal(session.state().wakeId, current.wakeId);
    assert.equal(
      (session as any).db
        .prepare("SELECT state FROM model_tool_ledger WHERE call_id='new'")
        .get().state,
      'pending',
    );
    assert.equal(
      (session as any).db
        .prepare(
          "SELECT COUNT(*) n FROM model_session_journal WHERE kind='wake_finish' AND wake_id IS NULL",
        )
        .get().n,
      0,
    );
    assert.equal(
      (session as any).db
        .prepare(
          "SELECT COUNT(*) n FROM model_session_journal WHERE kind='wake_finish' AND wake_id=?",
        )
        .get(current.wakeId).n,
      0,
    );
    assert.equal(
      (session as any).db
        .prepare(
          "SELECT COUNT(*) n FROM model_session_journal WHERE kind='wake_finish' AND wake_id=?",
        )
        .get(old.wakeId).n,
      1,
    );
  } finally {
    session.close();
  }
});

test('owner reset during send preserves a late ACK as a world fact without finishing the new session', async () => {
  const session = new ModelSession({
      model: 'main',
      path: ':memory:',
      groupId: LISTENER_GROUP,
    }),
    world = new WorldEventStore({ path: ':memory:', groupId: LISTENER_GROUP });
  const entries: TimelineEntry[] = [];
  const memory: Memory = {
    append(e) {
      entries.push(e);
      return true;
    },
    recent: () => entries,
    find: (id) => entries.find((e) => e.messageId === id),
    context: () => '',
    async compact() {},
    clear() {
      entries.length = 0;
    },
    close() {},
  };
  let sends = 0,
    release!: () => void;
  const bot = new Listener(
    {
      async call(action) {
        assert.equal(action, 'send_group_msg');
        const n = ++sends;
        if (n === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { message_id: String(100 + n) };
      },
    },
    {
      async complete() {
        return result(
          call('send', 'send_message', {
            segments: [{ type: 'text', text: 'synthetic' }],
          }),
          call('finish', 'finish', { mode: 'hard' }),
        );
      },
    },
    memory,
    config,
    () => 0,
    undefined,
    undefined,
    { session, world },
  );
  const event = (id: string, user: string, text: string) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: LISTENER_GROUP,
    self_id: '999',
    user_id: user,
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'fixture' },
    message: [
      { type: 'at', data: { qq: '999' } },
      { type: 'text', data: { text } },
    ],
  });
  try {
    await bot.receive(event('1', '123', 'synthetic'), '999');
    await until(() => sends === 1);
    const old = session.state();
    const reset = bot.receive(event('2', '100000001', '/reset'), '999');
    await until(() => session.state().sessionId !== old.sessionId);
    release();
    await reset;
    await until(() => !(bot as any).running);
    assert.equal(sends, 2);
    assert.ok(
      world.findMessage('101'),
      'late provider ACK remains a world fact',
    );
    const rows = (session as any).db
      .prepare(
        "SELECT session_id,wake_id,payload FROM model_session_journal WHERE kind='wake_finish'",
      )
      .all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].wake_id, old.wakeId);
    assert.equal(JSON.parse(rows[0].payload).reason_code, 'reset');
    assert.equal(session.state().wakeId, undefined);
  } finally {
    release?.();
    await bot.stop();
  }
});

test('owner reset during model wait terminates the old wake without writing its final callback into the new session', async () => {
  const f = fixture('reset');
  try {
    await f.bot.receive(
      {
        post_type: 'message',
        message_type: 'group',
        group_id: LISTENER_GROUP,
        self_id: '999',
        user_id: '123',
        message_id: '1',
        time: Math.floor(Date.now() / 1000),
        sender: { nickname: 'fixture' },
        message: [
          { type: 'at', data: { qq: '999' } },
          { type: 'text', data: { text: 'synthetic' } },
        ],
      },
      '999',
    );
    await until(() => f.rounds === 2);
    const old = f.session.state();
    await f.bot.receive(
      {
        post_type: 'message',
        message_type: 'group',
        group_id: LISTENER_GROUP,
        self_id: '999',
        user_id: '100000001',
        message_id: '2',
        time: Math.floor(Date.now() / 1000),
        sender: { nickname: 'fixture' },
        message: [{ type: 'text', data: { text: '/reset' } }],
      },
      '999',
    );
    await until(() => !(f.bot as any).running);
    assert.equal(f.abortReason, 'reset');
    assert.notEqual(f.session.state().sessionId, old.sessionId);
    assert.equal(
      f.sends,
      2,
      'original reply plus the reset acknowledgment, no replay',
    );
    const rows = (f.session as any).db
      .prepare(
        "SELECT session_id,wake_id,payload FROM model_session_journal WHERE kind='wake_finish'",
      )
      .all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].wake_id, old.wakeId);
    assert.equal(rows[0].session_id, old.sessionId);
    assert.equal(JSON.parse(rows[0].payload).reason_code, 'reset');
    assert.equal(f.session.state().wakeId, undefined);
  } finally {
    await f.bot.stop();
  }
});
